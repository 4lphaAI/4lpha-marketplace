/**
 * The guardable preview's receipt, cache and limiter
 * (MARKETPLACE-LENDING-AGENT R2.10, R2.11, R3.3(5), R3.8).
 *
 * ─── WHY A RECEIPT AT ALL ──────────────────────────────────────────────────
 *
 * `readAccount(A)` is a several-hundred-call fan-out on a CALLER-SUPPLIED
 * address, and `beforeNonceConsume` is the one code path where every existing
 * chain read is a single bounded call. So the heavy read lives at the preview,
 * and S1 verifies a short-lived plane-signed receipt plus exactly THREE bounded
 * reads — the same shape the hire flow already uses for funding ("a preview
 * <= 30 s old, and S1 trusts it").
 *
 * The receipt AUTHORIZES NOTHING. §0.5 lets anyone guard any address, so
 * replay inside the window is harmless: S1 still consumes an owner nonce and
 * still re-reads the facts it acts on. What the receipt buys is FRESHNESS and
 * — the half REVIEW2 H3(b) found missing — a binding of the SIZING INPUTS the
 * floor was computed from, so a receipt taken for budget X cannot be presented
 * at S1 for budget 10X against a floor S1 has no quote of its own to recompute.
 *
 * ─── ITS OWN SECRET, NOT A DERIVATION (R3.8, closing REVIEW2 M4) ───────────
 *
 * `EXECUTION_MASTER_KEY` has exactly ONE use in this tree: AES-256-GCM
 * envelope encryption of agent session keys — "the one secret this substrate
 * holds that can move a user's funds". There is no HKDF and no second consumer
 * anywhere, and the precedent the spec pointed at cuts the other way:
 * `accountReadSession`, a far more sensitive credential than a public preview,
 * uses its own dedicated `OWNER_READ_SESSION_SECRET`. Deriving here would
 * couple a public, unauthenticated read path to the money key and would
 * entangle the master-key rotation CLAUDE.md still lists as open.
 *
 * Absent secret ⇒ the preview returns NO receipt and S1 refuses
 * `preview-receipt-unavailable`. Fail-closed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress, type Address } from "viem";

/** Tag, on the `accountReadSession` idiom. */
const TAG = "4lpha-lending-preview:v1.";
const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{1,700})\.([A-Za-z0-9_-]{43})$/u;
const SECRET_PATTERN = /^[0-9a-f]{64}$/u;

/** How long a receipt is good for. Thirty seconds, exactly as R2.10 says. */
export const LENDING_PREVIEW_TTL_SEC = 30;

/** How long an identical `(account, block)` answer may be served from memory. */
export const LENDING_PREVIEW_CACHE_MS = 30_000;

/** Global token bucket across all callers (R2.11). */
export const LENDING_PREVIEW_GLOBAL_PER_MIN = 60;
/** Per-account bucket (R2.11). */
export const LENDING_PREVIEW_PER_ACCOUNT_PER_MIN = 10;

export type LendingPreviewClaims = {
  readonly v: 1;
  readonly account: Address;
  readonly blockNumber: string;
  readonly guardable: boolean;
  readonly debts: readonly { readonly vToken: Address; readonly borrowWei: string }[];
  /** Every sizing input the floor was computed from (R3.3(b)). */
  readonly budgetWei: string;
  readonly reserveBps: number;
  readonly maxPerActionUsdtWei: string;
  readonly rescueReserveCount: number;
  /**
   * The two QUOTED figures the floor was derived from.
   *
   * They are bound so S1 can run {@link checkLendingSizing} VERBATIM on the
   * SIGNED settings — R2.10 caps S1 at three bounded reads and it has no quote
   * of its own, so without these it could only compare against a precomputed
   * floor and could never re-derive it. Binding the inputs is what makes the
   * S1 check the same check the preview ran.
   */
  readonly mintUsdtWei: string;
  readonly tierBuyBackUsdtWei: string;
  readonly reserveCapFloorWei: string;
  readonly minimumCapDayWei: string;
  readonly expiresAt: number;
};

export function parseLendingPreviewSecret(
  value: string | undefined,
): Uint8Array | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (!SECRET_PATTERN.test(normalized)) {
    throw new Error(
      "LENDING_PREVIEW_SECRET must be exactly 64 lowercase hex characters.",
    );
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function encodeClaims(claims: LendingPreviewClaims): Uint8Array {
  // Field ORDER is part of the bytes the MAC covers, so it is written out
  // literally rather than spread — a reordering would silently invalidate every
  // outstanding receipt, and `verify` re-encodes and compares byte-for-byte.
  return Buffer.from(
    JSON.stringify({
      v: 1,
      account: claims.account.toLowerCase(),
      blockNumber: claims.blockNumber,
      guardable: claims.guardable,
      debts: claims.debts.map((debt) => ({
        vToken: debt.vToken.toLowerCase(),
        borrowWei: debt.borrowWei,
      })),
      budgetWei: claims.budgetWei,
      reserveBps: claims.reserveBps,
      maxPerActionUsdtWei: claims.maxPerActionUsdtWei,
      rescueReserveCount: claims.rescueReserveCount,
      mintUsdtWei: claims.mintUsdtWei,
      tierBuyBackUsdtWei: claims.tierBuyBackUsdtWei,
      reserveCapFloorWei: claims.reserveCapFloorWei,
      minimumCapDayWei: claims.minimumCapDayWei,
      expiresAt: claims.expiresAt,
    }),
    "utf8",
  );
}

function mac(key: Uint8Array, payload: Uint8Array): Buffer {
  return createHmac("sha256", key).update(TAG, "ascii").update(payload).digest();
}

export function issueLendingPreviewReceipt(input: {
  readonly claims: Omit<LendingPreviewClaims, "v" | "expiresAt">;
  readonly nowSec: number;
  readonly key: Uint8Array;
}): { readonly token: string; readonly expiresAt: number } {
  const expiresAt = input.nowSec + LENDING_PREVIEW_TTL_SEC;
  const claims: LendingPreviewClaims = { v: 1, ...input.claims, expiresAt };
  const payload = encodeClaims(claims);
  return {
    token: `v1.${Buffer.from(payload).toString("base64url")}.${mac(input.key, payload).toString("base64url")}`,
    expiresAt,
  };
}

function isExactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verify a receipt, or answer `null`.
 *
 * `null` for EVERY failure — malformed, wrong MAC, expired, structurally
 * unexpected — because S1's refusal must not tell a caller which of those it
 * was. `timingSafeEqual` on both the MAC and the re-encoded payload.
 */
export function verifyLendingPreviewReceipt(
  token: string,
  key: Uint8Array,
  nowSec: number,
): LendingPreviewClaims | null {
  if (token.length > 1024) return null;
  const match = TOKEN_PATTERN.exec(token);
  if (match === null) return null;
  let payload: Buffer;
  let supplied: Buffer;
  try {
    payload = Buffer.from(match[1] as string, "base64url");
    supplied = Buffer.from(match[2] as string, "base64url");
  } catch {
    return null;
  }
  if (payload.length > 700) return null;
  if (match[1] !== payload.toString("base64url")) return null;
  const expected = mac(key, payload);
  if (match[2] !== supplied.toString("base64url")) return null;
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!isExactRecord(raw)) return null;
  if (
    Object.keys(raw).join(",")
    !== "v,account,blockNumber,guardable,debts,budgetWei,reserveBps,maxPerActionUsdtWei,rescueReserveCount,mintUsdtWei,tierBuyBackUsdtWei,reserveCapFloorWei,minimumCapDayWei,expiresAt"
  ) {
    return null;
  }
  const {
    v, account, blockNumber, guardable, debts, budgetWei, reserveBps,
    maxPerActionUsdtWei, rescueReserveCount, mintUsdtWei, tierBuyBackUsdtWei,
    reserveCapFloorWei, minimumCapDayWei, expiresAt,
  } = raw;
  if (v !== 1) return null;
  if (typeof account !== "string" || !/^0x[0-9a-f]{40}$/u.test(account)) return null;
  if (typeof blockNumber !== "string" || !/^\d{1,20}$/u.test(blockNumber)) return null;
  if (typeof guardable !== "boolean") return null;
  if (!Array.isArray(debts) || debts.length > 8) return null;
  const parsedDebts: { readonly vToken: Address; readonly borrowWei: string }[] = [];
  for (const debt of debts) {
    if (!isExactRecord(debt) || Object.keys(debt).join(",") !== "vToken,borrowWei") return null;
    const vToken = debt["vToken"];
    const borrowWei = debt["borrowWei"];
    if (typeof vToken !== "string" || !/^0x[0-9a-f]{40}$/u.test(vToken)) return null;
    if (typeof borrowWei !== "string" || !/^\d{1,78}$/u.test(borrowWei)) return null;
    parsedDebts.push({ vToken: getAddress(vToken), borrowWei });
  }
  for (const field of [
    budgetWei, maxPerActionUsdtWei, mintUsdtWei, tierBuyBackUsdtWei,
    reserveCapFloorWei, minimumCapDayWei,
  ]) {
    if (typeof field !== "string" || !/^\d{1,78}$/u.test(field)) return null;
  }
  if (!Number.isSafeInteger(reserveBps) || !Number.isSafeInteger(rescueReserveCount)) return null;
  if (!Number.isSafeInteger(expiresAt)) return null;
  if ((expiresAt as number) <= nowSec) return null;
  if ((expiresAt as number) - nowSec > LENDING_PREVIEW_TTL_SEC) return null;

  const claims: LendingPreviewClaims = {
    v: 1,
    account: getAddress(account),
    blockNumber,
    guardable,
    debts: parsedDebts,
    budgetWei: budgetWei as string,
    reserveBps: reserveBps as number,
    maxPerActionUsdtWei: maxPerActionUsdtWei as string,
    rescueReserveCount: rescueReserveCount as number,
    mintUsdtWei: mintUsdtWei as string,
    tierBuyBackUsdtWei: tierBuyBackUsdtWei as string,
    reserveCapFloorWei: reserveCapFloorWei as string,
    minimumCapDayWei: minimumCapDayWei as string,
    expiresAt: expiresAt as number,
  };
  if (!timingSafeEqual(payload, Buffer.from(encodeClaims(claims)))) return null;
  return claims;
}

/* -------------------------------------------------------------------------- */
/* The limiter and the cache (R2.11)                                          */
/* -------------------------------------------------------------------------- */

type Bucket = { tokens: number; refilledAtMs: number };

/**
 * A fixed-rate token bucket. Deliberately its own tiny implementation rather
 * than a reuse of the HTTP limiter: this one is keyed on an ACCOUNT ADDRESS
 * supplied by the caller, so it must not share a namespace with the per-source
 * limiter that stands in front of every route.
 */
class RateBucket {
  readonly #buckets = new Map<string, Bucket>();
  readonly #perMinute: number;
  readonly #now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.#perMinute = perMinute;
    this.#now = now;
  }

  tryConsume(key: string): boolean {
    const nowMs = this.#now();
    const bucket = this.#buckets.get(key) ?? {
      tokens: this.#perMinute,
      refilledAtMs: nowMs,
    };
    const elapsed = nowMs - bucket.refilledAtMs;
    if (elapsed >= 60_000) {
      bucket.tokens = this.#perMinute;
      bucket.refilledAtMs = nowMs;
    }
    if (bucket.tokens <= 0) {
      this.#buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    // Bound the map: an unbounded key space keyed on a caller-supplied address
    // is a memory-growth path behind a perimeter token.
    if (this.#buckets.size > 4_096) {
      const oldest = [...this.#buckets.entries()].sort(
        (left, right) => left[1].refilledAtMs - right[1].refilledAtMs,
      )[0];
      if (oldest !== undefined) this.#buckets.delete(oldest[0]);
    }
    return true;
  }
}

export type LendingPreviewLimiter = {
  /**
   * Global first (cheapest refusal), then per-SUBJECT.
   *
   * The subject is the guarded account on `/lending/guardable` and the
   * forwarded client on `/lending/quote` (AUDIT B-M4), where the only other
   * candidate — `tokenIn` — is one of two constants and made the bucket a
   * platform-wide allowance rather than a per-caller one.
   */
  tryConsume(subject: Address | string, clientKey: string | null): boolean;
};

export function createLendingPreviewLimiter(
  now: () => number = Date.now,
): LendingPreviewLimiter {
  const global = new RateBucket(LENDING_PREVIEW_GLOBAL_PER_MIN, now);
  const perAccount = new RateBucket(LENDING_PREVIEW_PER_ACCOUNT_PER_MIN, now);
  const perClient = new RateBucket(LENDING_PREVIEW_GLOBAL_PER_MIN, now);
  return {
    tryConsume(subject, clientKey) {
      if (!global.tryConsume("global")) return false;
      if (clientKey !== null && !perClient.tryConsume(clientKey)) return false;
      return perAccount.tryConsume(String(subject).toLowerCase());
    },
  };
}

export type LendingPreviewCache<T> = {
  get(account: Address, blockNumber: bigint): T | undefined;
  /**
   * The newest entry for this account inside the TTL, whatever block it was
   * read at (AUDIT B-M3).
   *
   * The block-keyed {@link LendingPreviewCache.get} could only be consulted
   * AFTER the read that produces the block — which is the whole fan-out — so
   * the cache saved nothing and two identical calls cost two fan-outs. This
   * lookup runs FIRST. It is still block-coherent: the cached view CARRIES its
   * own `blockNumber`, so a caller is never told a stale height is the current
   * one, and the 30 s TTL is what bounds the staleness.
   */
  getRecent(account: Address): T | undefined;
  set(account: Address, blockNumber: bigint, value: T): void;
};

/**
 * A 30-second `(account, finalizedBlock)` cache.
 *
 * Keyed on the BLOCK as well as the account, so a cached answer can never be
 * served across a block boundary — the position it describes is a fact about
 * one height, and serving it for another is the class of lie the whole
 * finality discipline exists to prevent.
 */
export function createLendingPreviewCache<T>(
  now: () => number = Date.now,
): LendingPreviewCache<T> {
  const entries = new Map<string, { value: T; atMs: number }>();
  const key = (account: Address, blockNumber: bigint): string =>
    `${account.toLowerCase()}|${blockNumber}`;
  return {
    get(account, blockNumber) {
      const entry = entries.get(key(account, blockNumber));
      if (entry === undefined) return undefined;
      if (now() - entry.atMs > LENDING_PREVIEW_CACHE_MS) {
        entries.delete(key(account, blockNumber));
        return undefined;
      }
      return entry.value;
    },
    getRecent(account) {
      const prefix = `${account.toLowerCase()}|`;
      let best: { value: T; atMs: number } | undefined;
      for (const [entryKey, entry] of entries) {
        if (!entryKey.startsWith(prefix)) continue;
        if (now() - entry.atMs > LENDING_PREVIEW_CACHE_MS) {
          entries.delete(entryKey);
          continue;
        }
        if (best === undefined || entry.atMs > best.atMs) best = entry;
      }
      return best?.value;
    },
    set(account, blockNumber, value) {
      entries.set(key(account, blockNumber), { value, atMs: now() });
      if (entries.size > 512) {
        const oldest = [...entries.entries()].sort(
          (left, right) => left[1].atMs - right[1].atMs,
        )[0];
        if (oldest !== undefined) entries.delete(oldest[0]);
      }
    },
  };
}
