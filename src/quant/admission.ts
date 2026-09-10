/**
 * Session admission: parse the plaintext, PROJECT the granted permissions into
 * a policy this plane already knows how to validate, and refuse anything the
 * strategy does not need (QUANT-GRID R2.1, R3.2, R5.4, BC33).
 *
 * ─── TWO OBJECTS, NEVER CONFUSED (REVIEW B1) ───────────────────────────────
 *
 *   1. The DESCRIPTOR — `permissions` verbatim from the plaintext. It is what
 *      the SDK forwards to the relay as the key descriptor, and FINDINGS (x)
 *      leaves relay enforcement of that descriptor open, so a rewritten
 *      descriptor is a silent-decline risk. It is never re-derived.
 *   2. The PROJECTION — a `SessionSpec` derived deterministically from those
 *      permissions, TOTAL OR REFUSED: an entry this projection cannot map is a
 *      refusal, never a dropped rule. `validateSessionSpec` then runs over it
 *      UNCHANGED, so the rules that bound a session we wrote (value movers
 *      capped, no wallet/KeyStore targets, no duplicate caps, expiry bounds)
 *      bound one the client's wizard wrote too.
 *
 * ─── WHY `validateSessionSpec` IS NOT SUFFICIENT (REVIEW7 condition 7) ─────
 *
 * It ACCEPTS a target-only rule (`{ to }` with no selector), which permits
 * EVERY function on that contract — including `transfer` on U. A2/A4 below are
 * therefore enforced INDEPENDENTLY and on the 4-byte selector, and a
 * target-only rule on U or WBNB is refused by A4 rather than waved through.
 *
 * ─── THE HONEST AUTHORITY SENTENCE (R3.2 C4) ───────────────────────────────
 *
 * A leaked admitted key CAN divert up to the U day cap and the WBNB day cap
 * per day to any recipient, through the router's `to` argument — a `CallRule`
 * cannot constrain an argument (FINDINGS (h)). It CANNOT call `transfer`,
 * cannot reach any other contract, and stops at expiry or revoke. Our builder
 * always sets `to = tradingWallet`; that is a property of the BUILDER, not of
 * the key. A8's chain checks are POSITIVE checks only — they cannot enumerate
 * grants the live account holds beyond the descriptor, and nothing here claims
 * anything about those.
 */
import { getAddress, isAddress, keccak256, stringToHex, toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAddress, publicKeyToAddress } from "viem/accounts";
import {
  validateSessionSpec,
  type ProviderPermissions,
} from "../core/session.js";
import type { CallRule, SessionSpec, SpendCap, SpendPeriod } from "../core/types.js";
import {
  APPROVE_SIGNATURE,
  SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE,
} from "../ops/pancakeTokens.js";
import { open, type QuantEnvelope, type QuantKeypair } from "./envelope.js";
import type { QuantStrategyParams } from "./config.js";
import { economicMinSellWei, feeEstInU, ceilDiv, BPS, E18 } from "./grid.js";
import type {
  GrantedCallPermission,
  GrantedPermissions,
  GrantedSpendPermission,
  QuantSessionPlaintext,
} from "./types.js";

/** The ONLY session version this build parses. */
export const ALTANA_SESSION_VERSION = 1;

/**
 * The three signatures this strategy knows (R3.2 C3).
 *
 * `SessionSpec.selector` is the canonical human-readable SIGNATURE, not a
 * 4-byte selector, so a permission entry that carries only four bytes is
 * projected by looking it up HERE — and refused if it is not one of these.
 * A2/A4 compare on the selector computed from the signature, separately.
 */
export const QUANT_KNOWN_SIGNATURES: readonly string[] = [
  APPROVE_SIGNATURE,
  SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE,
  "transfer(address,uint256)",
];

/**
 * The ONE router selector this strategy tolerates.
 *
 * A one-entry set, widened by a spec revision only. Anything else on the
 * router is `session-excess-grant` — which is what makes §1's "the agent
 * cannot transfer" a CHECKED property rather than a hope.
 */
export const TOLERATED_ROUTER_SELECTORS: ReadonlySet<string> = new Set([
  SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE,
]);

const VALID_PERIODS: ReadonlySet<string> = new Set<SpendPeriod>([
  "minute", "hour", "day", "week", "month", "year",
]);

export type QuantAdmissionRefusal = {
  readonly ok: false;
  /** A fixed code, optionally suffixed with a fixed discriminator. */
  readonly code: string;
};

export type ProjectionResult =
  | { readonly ok: true; readonly spec: SessionSpec }
  | QuantAdmissionRefusal;

function refuse(code: string): QuantAdmissionRefusal {
  return { ok: false, code };
}

/* -------------------------------------------------------------------------- */
/* Plaintext parsing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `{"$bigint":"<decimal>"}` — the `serializeSession` bigint replacer, pinned by
 * the checked-in fixture. Any other shape in a bigint position is a refusal.
 */
function reviveBigint(value: unknown): bigint | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const marker = (value as Record<string, unknown>)["$bigint"];
    if (typeof marker === "string" && /^[0-9]+$/u.test(marker)) return BigInt(marker);
    return null;
  }
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

export type PlaintextResult =
  | { readonly ok: true; readonly session: QuantSessionPlaintext }
  | QuantAdmissionRefusal;

/**
 * Parse `serializeSession()` output. NON-THROWING: every failure is a code.
 *
 * A version other than {@link ALTANA_SESSION_VERSION} is REFUSED. There is no
 * "parse what we recognise and hope" branch, because the object being parsed
 * carries a private key that spends a stranger's money.
 */
export function parseSessionPlaintext(plaintext: string): PlaintextResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return refuse("session-plaintext-malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("session-plaintext-malformed");
  }
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== ALTANA_SESSION_VERSION) {
    return refuse("session-version-unsupported");
  }
  const walletAddress = record["walletAddress"];
  if (typeof walletAddress !== "string" || !isAddress(walletAddress, { strict: false })) {
    return refuse("session-plaintext-malformed");
  }
  const publicKey = record["publicKey"];
  if (typeof publicKey !== "string" || !/^0x[0-9a-fA-F]{130}$/u.test(publicKey)) {
    return refuse("session-plaintext-malformed");
  }
  const expiry = record["expiry"];
  if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= 0) {
    return refuse("session-plaintext-malformed");
  }
  const signer = record["signer"];
  if (typeof signer !== "object" || signer === null) {
    return refuse("session-plaintext-malformed");
  }
  const signerRecord = signer as Record<string, unknown>;
  if (signerRecord["type"] !== "privateKey") return refuse("session-signer-unsupported");
  const privateKey = signerRecord["privateKey"];
  if (typeof privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(privateKey)) {
    return refuse("session-plaintext-malformed");
  }
  const permissions = parsePermissions(record["permissions"]);
  if (permissions === null) return refuse("session-permissions-malformed");
  return {
    ok: true,
    session: {
      version: ALTANA_SESSION_VERSION,
      walletAddress: getAddress(walletAddress),
      publicKey: publicKey as Hex,
      expiry,
      permissions,
      signerPrivateKey: privateKey as Hex,
    },
  };
}

function parsePermissions(value: unknown): GrantedPermissions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawCalls = record["calls"];
  const rawSpend = record["spend"];
  // The two safe-default inversions: Altana reads an omitted `calls` as "every
  // target allowed" and an omitted `spend` as "no limit". Neither is admissible.
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return null;
  if (!Array.isArray(rawSpend) || rawSpend.length === 0) return null;
  const calls: GrantedCallPermission[] = [];
  for (const entry of rawCalls) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = entry as Record<string, unknown>;
    const to = item["to"];
    const signature = item["signature"];
    const selector = item["selector"];
    if (to !== undefined && (typeof to !== "string" || !isAddress(to, { strict: false }))) {
      return null;
    }
    if (signature !== undefined && typeof signature !== "string") return null;
    if (selector !== undefined && typeof selector !== "string") return null;
    if (to === undefined && signature === undefined && selector === undefined) return null;
    // A bare 4-byte selector is projected through the known-signature table;
    // carry it as the raw string and let the projection decide.
    calls.push({
      ...(to === undefined ? {} : { to: getAddress(to) }),
      ...(signature === undefined
        ? selector === undefined ? {} : { signature: selector }
        : { signature }),
    });
  }
  const spend: GrantedSpendPermission[] = [];
  for (const entry of rawSpend) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = entry as Record<string, unknown>;
    const limit = reviveBigint(item["limit"]);
    if (limit === null || limit <= 0n) return null;
    const period = item["period"];
    if (typeof period !== "string" || !VALID_PERIODS.has(period)) return null;
    const token = item["token"];
    if (token !== undefined && token !== null
      && (typeof token !== "string" || !isAddress(token, { strict: false }))) {
      return null;
    }
    spend.push({
      limit,
      period: period as SpendPeriod,
      ...(token === undefined || token === null ? {} : { token: getAddress(token) }),
    });
  }
  return { calls, spend };
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

/** Resolve a permission's function constraint to its canonical signature. */
function canonicalSignature(raw: string): string | null {
  if (/^0x[0-9a-fA-F]{8}$/u.test(raw)) {
    const wanted = raw.toLowerCase();
    for (const signature of QUANT_KNOWN_SIGNATURES) {
      if (toFunctionSelector(signature).toLowerCase() === wanted) return signature;
    }
    return null;
  }
  // A human-readable signature is kept VERBATIM (C3): `SessionSpec.selector` is
  // the signature, and `validateSessionSpec` canonicalizes and cross-checks it
  // against its own selector, so a non-canonical spelling fails there rather
  // than being silently rewritten here.
  return raw;
}

/**
 * Project a granted descriptor into a `SessionSpec`. TOTAL OR REFUSED.
 *
 * `expiry`, `nowSeconds` and `termDays` are EXPLICIT parameters (C3): the
 * expiry lives in the plaintext, not in the permissions, and a projection that
 * read a clock would not be pure.
 */
export function projectGrantedPermissions(
  permissions: GrantedPermissions,
  options: {
    readonly expiry: number;
    readonly nowSeconds: number;
    readonly termDays: number;
    readonly walletAddress: Address;
    readonly keyStoreAddress?: Address;
  },
): ProjectionResult {
  const allowedCalls: CallRule[] = [];
  for (const entry of permissions.calls) {
    const signature = entry.signature === undefined
      ? undefined
      : canonicalSignature(entry.signature);
    if (entry.signature !== undefined && signature === null) {
      return refuse("session-projection-invalid:unknown-selector");
    }
    if (entry.to === undefined) {
      // A bare-selector rule permits that function on EVERY contract. The
      // projection does not DROP it (that would understate the grant) and does
      // not silently opt in to `allowUnrestrictedSelector` either — it refuses,
      // because this strategy has no use for one and admitting one would put
      // `approve` on every ERC-20 the wallet holds.
      return refuse("session-projection-invalid:unbound-selector");
    }
    allowedCalls.push({
      to: entry.to,
      ...(signature === undefined || signature === null ? {} : { selector: signature }),
    });
  }
  const spendCaps: SpendCap[] = permissions.spend.map((entry) => ({
    limit: entry.limit,
    period: entry.period,
    ...(entry.token === undefined ? {} : { token: entry.token }),
  }));
  const spec: SessionSpec = { allowedCalls, spendCaps, expiresAt: options.expiry };
  try {
    // UNCHANGED. Duplicate caps, value movers with no cap, a call back into the
    // wallet or the KeyStore, and the expiry bounds are all its rules, applied
    // to a session someone else granted.
    validateSessionSpec(spec, {
      nowSeconds: options.nowSeconds,
      // A session may legitimately be minutes from expiry when we restore it.
      minSessionSeconds: 0,
      maxSessionSeconds: options.termDays * 86_400 + 3_600,
      walletAddress: options.walletAddress,
      ...(options.keyStoreAddress === undefined
        ? {}
        : { keyStoreAddress: options.keyStoreAddress }),
    });
  } catch {
    return refuse("session-projection-invalid");
  }
  return { ok: true, spec };
}

/**
 * The canonical permissions digest recorded at admission (R2.1).
 *
 * Every later open must reproduce it or the action is refused
 * `session-changed`: a client who re-grants mid-term gets a NEW admission, not
 * a silently different key under an old one's bookkeeping.
 */
export function permissionsDigest(permissions: GrantedPermissions): Hex {
  const canonical = JSON.stringify({
    calls: [...permissions.calls]
      .map((entry) => ({
        to: entry.to?.toLowerCase() ?? null,
        signature: entry.signature ?? null,
      }))
      .sort((a, b) =>
        `${a.to}|${a.signature}` < `${b.to}|${b.signature}` ? -1
          : `${a.to}|${a.signature}` > `${b.to}|${b.signature}` ? 1 : 0),
    spend: [...permissions.spend]
      .map((entry) => ({
        token: entry.token?.toLowerCase() ?? null,
        period: entry.period,
        limit: entry.limit.toString(10),
      }))
      .sort((a, b) =>
        `${a.token}|${a.period}|${a.limit}` < `${b.token}|${b.period}|${b.limit}` ? -1
          : `${a.token}|${a.period}|${a.limit}` > `${b.token}|${b.period}|${b.limit}` ? 1 : 0),
  });
  return keccak256(stringToHex(canonical));
}

export function specDigest(spec: SessionSpec): Hex {
  const canonical = JSON.stringify({
    allowedCalls: [...spec.allowedCalls]
      .map((rule) => `${rule.to?.toLowerCase() ?? ""}|${rule.selector ?? ""}`)
      .sort(),
    spendCaps: [...spec.spendCaps]
      .map((cap) => `${cap.token?.toLowerCase() ?? ""}|${cap.period}|${cap.limit.toString(10)}`)
      .sort(),
    expiresAt: spec.expiresAt,
  });
  return keccak256(stringToHex(canonical));
}

/* -------------------------------------------------------------------------- */
/* Admission (A1..A8)                                                         */
/* -------------------------------------------------------------------------- */

export type QuantAdmissionInput = {
  readonly session: QuantSessionPlaintext;
  readonly spec: SessionSpec;
  readonly router: Address;
  readonly u: Address;
  readonly wbnb: Address;
  readonly job: {
    readonly tradingWalletAddress: Address;
    readonly sessionExpiresAtMs: number | null;
  };
  readonly ladder: {
    readonly levels: number;
    readonly clipUWei: bigint;
    readonly buyPrice: readonly bigint[];
    readonly sellPrice: readonly bigint[];
    readonly midE18: bigint;
  };
  readonly params: QuantStrategyParams;
  readonly nowSeconds: number;
};

export type QuantAdmissionOk = {
  readonly ok: true;
  /** The smallest WBNB cap limit across every period row (R6.3's `Lmin`). */
  readonly wbnbCapMinLimitWei: bigint;
  /** Persisted per job; the only chunk a residual may close below (R7.2). */
  readonly residualThresholdWei: bigint;
};

export type QuantAdmissionResult = QuantAdmissionOk | QuantAdmissionRefusal;

function selectorOf(signature: string | undefined): string | null {
  if (signature === undefined) return null;
  try {
    return toFunctionSelector(signature).toLowerCase();
  } catch {
    return null;
  }
}

const APPROVE_SELECTOR = toFunctionSelector(APPROVE_SIGNATURE).toLowerCase();
const SWAP_SELECTOR = toFunctionSelector(
  SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE,
).toLowerCase();

/**
 * A2/A4/A5/A6/A7 plus the R5.4 cap inequality. PURE — the chain half (A8) is
 * {@link buildChainAdmissionChecks} and runs separately.
 *
 * Enforced INDEPENDENTLY of `validateSessionSpec` (REVIEW7 condition 7), which
 * accepts a target-only rule and therefore cannot substitute for A4.
 */
export function assertQuantSessionAdmissible(
  input: QuantAdmissionInput,
): QuantAdmissionResult {
  const { session, router, u, wbnb, params, ladder } = input;
  const routerKey = router.toLowerCase();
  const uKey = u.toLowerCase();
  const wbnbKey = wbnb.toLowerCase();

  /* A5 — the descriptor's wallet IS the job's task wallet. */
  if (session.walletAddress.toLowerCase()
    !== getAddress(input.job.tradingWalletAddress).toLowerCase()) {
    return refuse("session-wallet-mismatch");
  }

  /* A6 — the public key is the one the plaintext's private key derives. */
  let derived: Address;
  try {
    derived = publicKeyToAddress(session.publicKey);
  } catch {
    return refuse("session-key-mismatch");
  }
  try {
    // Derived independently from the signer, so a plaintext whose publicKey and
    // privateKey disagree cannot be admitted: the keyHash every on-chain check
    // uses comes from the PUBLIC key, and executing would sign with the other.
    if (privateKeyToAddress(session.signerPrivateKey).toLowerCase()
      !== derived.toLowerCase()) {
      return refuse("session-key-mismatch");
    }
  } catch {
    return refuse("session-key-mismatch");
  }

  /* A7 — expiry in the future and not beyond the job's own, plus 300 s slack. */
  if (session.expiry <= input.nowSeconds) return refuse("session-expiry-mismatch");
  if (input.job.sessionExpiresAtMs !== null) {
    const jobExpirySec = Math.floor(input.job.sessionExpiresAtMs / 1_000);
    if (session.expiry > jobExpirySec + 300) return refuse("session-expiry-mismatch");
  }

  /* A4 — every rule's target and selector, before A2's presence check. */
  let hasSwap = false;
  let hasApproveU = false;
  let hasApproveWbnb = false;
  for (const rule of session.permissions.calls) {
    if (rule.to === undefined) return refuse("session-excess-grant:unbound");
    const target = rule.to.toLowerCase();
    const selector = selectorOf(rule.signature);
    if (target !== routerKey && target !== uKey && target !== wbnbKey) {
      return refuse(`session-excess-grant:${target}`);
    }
    // A rule with NO function constraint permits EVERY function on that
    // contract — `transfer` on U included. `validateSessionSpec` accepts it;
    // this does not.
    if (selector === null) return refuse(`session-excess-grant:${target}:any`);
    if (target === routerKey) {
      if (rule.signature === undefined
        || !TOLERATED_ROUTER_SELECTORS.has(canonicalSignature(rule.signature) ?? "")) {
        return refuse(`session-excess-grant:${target}:${selector}`);
      }
      if (selector === SWAP_SELECTOR) hasSwap = true;
      continue;
    }
    if (selector !== APPROVE_SELECTOR) {
      return refuse(`session-excess-grant:${target}:${selector}`);
    }
    if (target === uKey) hasApproveU = true;
    else hasApproveWbnb = true;
  }

  /* A2 — the three grants the strategy actually needs. */
  if (!hasSwap) return refuse("session-missing-grant:swap");
  if (!hasApproveU) return refuse("session-missing-grant:approve-u");
  if (!hasApproveWbnb) return refuse("session-missing-grant:approve-wbnb");

  /* A3 / R5.4 — caps, per token AND per period row. */
  const uRows = session.permissions.spend.filter(
    (cap) => cap.token !== undefined && cap.token.toLowerCase() === uKey,
  );
  const wbnbRows = session.permissions.spend.filter(
    (cap) => cap.token !== undefined && cap.token.toLowerCase() === wbnbKey,
  );
  const nativeRows = session.permissions.spend.filter((cap) => cap.token === undefined);
  if (uRows.length === 0) return refuse("session-missing-cap:u");
  if (wbnbRows.length === 0) return refuse("session-missing-cap:wbnb");
  // BC33 / BC27: a sell needs a NATIVE grant to exist at all. FINDINGS (h): a
  // key with no native row does not have "unlimited" native — the relay's
  // simulation reverts and the submit never lands, which reads like a slow
  // relay rather than a refusal.
  if (nativeRows.length === 0) return refuse("session-missing-cap:native");

  for (const row of uRows) {
    if (row.limit < ladder.clipUWei) return refuse(`session-cap-too-small:u:${row.period}`);
  }
  const minSell = economicMinSellWei({
    sellPriceE18: ladder.sellPrice[ladder.levels] ?? 0n,
    midE18: ladder.midE18,
    params,
  });
  if (minSell <= 0n) return refuse("session-cap-uneconomic:min-sell");
  for (const row of wbnbRows) {
    if (row.limit < minSell) return refuse(`session-cap-too-small:wbnb:${row.period}`);
  }
  const lmin = wbnbRows.reduce(
    (smallest, row) => (row.limit < smallest ? row.limit : smallest),
    wbnbRows[0]?.limit ?? 0n,
  );
  if (lmin <= 0n) return refuse("session-missing-cap:wbnb");

  const feeU = feeEstInU(params, ladder.midE18);
  for (let index = 1; index <= ladder.levels; index += 1) {
    const buyPrice = ladder.buyPrice[index];
    const sellPrice = ladder.sellPrice[index];
    if (buyPrice === undefined || sellPrice === undefined || buyPrice <= 0n) {
      return refuse("session-cap-uneconomic:ladder");
    }
    const baseWorst = (ladder.clipUWei * E18) / buyPrice;
    if (baseWorst <= 0n) return refuse("session-cap-uneconomic:ladder");
    const k = ceilDiv(baseWorst, lmin);
    const chunk = ceilDiv(baseWorst, k);
    // R6.3: the near-equal chunk must clear TWICE the residual threshold, so a
    // residual — if one ever exists — is at most one uneconomic chunk and is
    // bounded by `economicMinSellWei`.
    if (chunk < 2n * minSell) {
      return refuse(`session-cap-uneconomic:${index}:chunk`);
    }
    const proceeds = (chunk * sellPrice * (BPS - BigInt(params.exitTolBps))) / BPS / E18;
    const basis = ceilDiv(chunk * buyPrice * (BPS + BigInt(params.entryTolBps)), BPS * E18);
    const entry = ceilDiv(feeU * chunk, baseWorst);
    const required = ceilDiv(basis * (BPS + BigInt(params.minNetEdgeBps)), BPS) + entry + feeU;
    if (proceeds < required) {
      return refuse(`session-cap-uneconomic:${index}:edge`);
    }
  }

  return { ok: true, wbnbCapMinLimitWei: lmin, residualThresholdWei: minSell };
}

/* -------------------------------------------------------------------------- */
/* The chain half (A8)                                                        */
/* -------------------------------------------------------------------------- */

export type QuantChainAdmissionReads = {
  /**
   * `KeyStore.isValidKey(wallet, keyId)` where keyId is `keccak256(publicKey)`
   * — the REGISTRY's id, NOT the account's porto key hash. The proven LP read
   * (`AltanaProvider.#isKeyRegistered`) uses exactly this; the first live
   * self-test cycle on 2026-09-10 held `session-chain-refused:keystore`
   * because the account hash had been passed here instead.
   */
  isValidKey(wallet: Address, keyStoreId: Hex): Promise<boolean>;
  /** The account's `getKeys`, reduced to `(keyHash, isSuperAdmin)` pairs. */
  accountKeys(wallet: Address): Promise<readonly {
    readonly keyHash: Hex;
    readonly isSuperAdmin: boolean;
  }[]>;
  /** `canExecute(keyHash, target, data)`. */
  canExecute(wallet: Address, keyHash: Hex, target: Address, data: Hex): Promise<boolean>;
};

export type QuantChainAdmissionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly unreadable: boolean };

/**
 * A8, POSITIVE checks only.
 *
 * A read failure is `session-chain-unreadable` and a HOLD, never a refusal:
 * an outage must not retire a client's session, and every check here is
 * re-run each cycle (and at least every 6 h) anyway.
 */
export async function runChainAdmissionChecks(input: {
  readonly reads: QuantChainAdmissionReads;
  readonly wallet: Address;
  /** The account's porto key hash — used for `getKeys` and `canExecute`. */
  readonly keyHash: Hex;
  /** The session's SEC1 public key — `keccak256` of it is the KeyStore id. */
  readonly publicKey: Hex;
  readonly probes: readonly { readonly target: Address; readonly data: Hex }[];
}): Promise<QuantChainAdmissionResult> {
  try {
    const registered = await input.reads.isValidKey(input.wallet, keccak256(input.publicKey));
    if (!registered) return { ok: false, code: "session-chain-refused:keystore", unreadable: false };
    const keys = await input.reads.accountKeys(input.wallet);
    const entry = keys.find(
      (candidate) => candidate.keyHash.toLowerCase() === input.keyHash.toLowerCase(),
    );
    if (entry === undefined) {
      return { ok: false, code: "session-chain-refused:account-key", unreadable: false };
    }
    // FINDINGS (o): a super-admin key answers `canExecute` true for everything,
    // so its verdict is VOID rather than reassuring. `grantSession` should never
    // produce one; refusing here does not depend on that.
    if (entry.isSuperAdmin) {
      return { ok: false, code: "session-chain-refused:super-admin", unreadable: false };
    }
    for (const probe of input.probes) {
      const allowed = await input.reads.canExecute(
        input.wallet, input.keyHash, probe.target, probe.data,
      );
      if (!allowed) {
        return {
          ok: false,
          code: `session-chain-refused:${probe.target.toLowerCase()}`,
          unreadable: false,
        };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "session-chain-unreadable", unreadable: true };
  }
}

/* -------------------------------------------------------------------------- */
/* The one call site that opens an envelope                                   */
/* -------------------------------------------------------------------------- */

export type OpenedSession =
  | { readonly ok: true; readonly session: QuantSessionPlaintext }
  | QuantAdmissionRefusal;

/**
 * Open a persisted envelope and parse it. THE ONE PLACE besides
 * `src/quant/execute.ts` that imports `open` (R3.11 / BC11).
 *
 * BC12 records this as the EXPLICIT exception to journal-before-decryption:
 * admission opens once, records PUBLIC facts (public key, expiry, two digests)
 * and writes no journal row — because the public key that every later journal
 * row carries is not knowable before the first open.
 */
export function openSession(
  envelope: QuantEnvelope,
  keypair: QuantKeypair,
): OpenedSession {
  let plaintext: string;
  try {
    plaintext = open(envelope, keypair);
  } catch {
    return refuse("envelope-invalid");
  }
  // The plaintext STRING never leaves this function; only the parsed record
  // does, and it carries the signer key for exactly one caller's closure.
  return parseSessionPlaintext(plaintext);
}

/** The provider-facing descriptor, unchanged, for `restoreGrantedSession`. */
export function descriptorOf(session: QuantSessionPlaintext): ProviderPermissions {
  return session.permissions as unknown as ProviderPermissions;
}
