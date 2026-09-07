/**
 * The token-safety gate.
 *
 * ═══ WHAT THIS GATE IS FOR, AND WHAT IT REFUSES TO BE ══════════════════════
 *
 * Choosing WHICH token to trade is the marketplace's job, not this service's.
 * That is the same division that keeps `src/core` free of market judgement, and
 * it is why this gate does NOT look at tax rates, holder concentration, open
 * source, renounced ownership, liquidity depth, or any other quality signal.
 * Every one of those is a reason a caller might *prefer* a different token, and
 * a caller that wants them has a whole data plane to ask.
 *
 * What is left is one question this layer is uniquely responsible for, because
 * no layer below it can answer and no layer above it can undo:
 *
 *     Can the wallet SELL what this trade is about to buy?
 *
 * A token that accepts buys and reverts every sell is not a bad price — it is a
 * total, unrecoverable loss with the trade reporting success. `minOutWei` does
 * not catch it (the buy fills correctly). Spend caps do not catch it (the trade
 * was inside budget). Owner revoke does not undo it (the money is already a
 * token nobody can move). It is the one failure where refusing to submit is the
 * only defence that exists, so it is the one thing this gate refuses.
 *
 * Everything else is allowed through, including a verdict we could not obtain —
 * see {@link ScanGateOptions.requireVerdict}. "The scanner had no opinion" is
 * not evidence of a defect, and treating it as one would make the money path
 * depend on the uptime of a service that, by design, only advises.
 *
 * ═══ THE PAYLOAD ══════════════════════════════════════════════════════════
 *
 * The data plane returns its own normalized `TokenSecuritySummary`, NOT a raw
 * upstream body: `{ riskLevel, flags, scannedAt, source }`, where two scanners
 * have already been merged conservatively (worse verdict wins, flag sets are
 * unioned). `flags` is a stable snake_case vocabulary owned by that service.
 * This gate reads the flags and nothing else — `riskLevel` mixes mechanical
 * defects with quality judgements, so gating on it would smuggle selection
 * policy back in through the side door.
 *
 * Reasons are a CLOSED enum. No string from the payload is ever echoed into a
 * response or a log line: it is third-party content, and forwarding it would be
 * a response- and log-injection hole one upstream compromise wide.
 *
 * The cache key is `(chainId, token)`. A token address is only meaningful
 * per-chain, and a verdict computed for one chain's contract must never answer
 * for another's.
 */
import type { Address } from "viem";
import type { DataPlaneClient } from "../clients/dataPlane.js";

/** Every reason this gate can give. Closed set, by design. */
export type ScanReason =
  | "honeypot"
  | "cannot_sell"
  | "blacklist"
  | "scan_unavailable";

export type ScanVerdict = {
  readonly verdict: "allow" | "deny";
  /**
   * What was found. Populated even when `verdict` is `allow` — under `report`
   * the finding is the whole point, and swallowing it would leave the caller
   * with no idea a flag was raised.
   */
  readonly reasons: readonly ScanReason[];
};

/**
 * The flags that mean "this token may not be sellable", and the entire deny
 * list. Each names a mechanical defect, not a quality judgement:
 *
 *   - `honeypot`    — sells revert. The canonical total loss.
 *   - `cannot_sell` — the scanner could not complete a simulated sell.
 *   - `blacklist`   — the contract can freeze an address's ability to transfer,
 *                     which is a honeypot the owner can switch on later.
 *
 * Deliberately ABSENT, with reasons, because each is the marketplace's call:
 *   `high_tax` / `tax`      a price, and `minOutWei` already bounds it;
 *   `low_liquidity`         also a price — a thin pool returns little, and the
 *                           caller's own slippage floor rejects that on-chain,
 *                           which is a better instrument than a boolean;
 *   `not_open_source`, `mintable`, `not_renounced`, `top10_concentration`,
 *   `rug_history`, `wash_trading`, …   quality signals, all of them reasons to
 *                           pick a different token rather than reasons a trade
 *                           cannot be executed.
 */
export const FATAL_FLAGS: readonly ScanReason[] = [
  "honeypot",
  "cannot_sell",
  "blacklist",
];

const FATAL_FLAG_SET: ReadonlySet<string> = new Set(FATAL_FLAGS);

/** Default verdict lifetime, in seconds. */
export const DEFAULT_SCAN_TTL_SEC = 300;

/** Hard ceiling on the configured TTL, in seconds. */
export const MAX_SCAN_TTL_SEC = 900;

/** Most cached verdicts held before the oldest is evicted. */
const MAX_CACHE_KEYS = 5_000;

/** Most candidate sub-objects inspected inside one payload. */
const MAX_PAYLOAD_CANDIDATES = 8;

/**
 * What a scan verdict is allowed to DO.
 *
 *   - `off`     no read at all. The fastest path and the one with no data-plane
 *               dependency on a buy.
 *   - `report`  read and attach the flags to the receipt, but never refuse.
 *               THE DEFAULT.
 *   - `block`   refuse a buy carrying a fatal flag.
 *
 * The default moved from `block` to `report` after a live case decided it: a
 * Binance-listed token with 58 BNB of real liquidity was refused because ONE of
 * the data plane's two scanners reported `honeypot` while the other reported a
 * clean `ok`, and the conservative merge takes the worse verdict. Blocking on a
 * signal that noisy costs more legitimate trades than it prevents bad ones —
 * especially since the marketplace already chooses tokens from a curated
 * universe, and the loss an attacker could cause by steering a leaked service
 * credential at a honeypot is already bounded by the on-chain spend caps.
 *
 * `report` keeps the information flowing to whoever should act on it — the
 * flags travel on the receipt, so the marketplace can surface or filter — while
 * leaving the decision where selection decisions belong.
 */
export type ScanMode = "off" | "report" | "block";

export type ScanGateOptions = {
  readonly dataPlane: DataPlaneClient;
  /** Clock, epoch MILLISECONDS. Injected so TTL behaviour is testable. */
  readonly now: () => number;
  /** Defaults to `report`. */
  readonly mode?: ScanMode;
  readonly ttlSec?: number;
  /**
   * Refuse a buy when no verdict could be obtained — the data plane is
   * unreachable, answers `unavailable`, or returns a shape this gate does not
   * recognize. Default `false`.
   *
   * The default is a deliberate choice and worth stating plainly: with it off,
   * a data-plane outage does not stop trading, and a token no scanner has an
   * opinion about is still tradeable. That is right for a service whose job is
   * executing decisions made elsewhere. Turn it ON for a deployment that would
   * rather halt than trade blind — it is one env var, and it changes the gate
   * from "refuse known-unsellable" to "require proof of sellability".
   */
  readonly requireVerdict?: boolean;
};

export type ScanRequest = {
  readonly chainId: number;
  readonly token: Address;
  readonly side: "buy" | "sell";
  readonly signal?: AbortSignal;
};

export interface ScanGate {
  evaluate(request: ScanRequest): Promise<ScanVerdict>;
}

const ALLOW: ScanVerdict = { verdict: "allow", reasons: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sub-objects of the payload that could carry the summary.
 *
 * The client already unwraps the `{ data }` envelope, so the summary is
 * normally the payload itself; the nested names are tolerated so a wrapper
 * change upstream degrades to "no verdict" rather than to a wrong one. The walk
 * is bounded and never recursive: a payload must not be able to make this
 * search arbitrarily deep, and a field found ten levels down is not evidence of
 * anything anyway.
 */
function candidateRecords(payload: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  const out: Record<string, unknown>[] = [payload];
  for (const key of ["security", "summary", "data"]) {
    const nested = payload[key];
    if (isRecord(nested)) out.push(nested);
  }
  return out.slice(0, MAX_PAYLOAD_CANDIDATES);
}

/**
 * The flags a payload reports, or `null` when it carries no readable summary.
 *
 * `null` is NOT the same as an empty flag list: empty means "scanned, nothing
 * fatal found", while `null` means "we do not have a scan", and only the second
 * is affected by `requireVerdict`.
 */
export function readScanFlags(payload: unknown): readonly string[] | null {
  for (const candidate of candidateRecords(payload)) {
    const flags = candidate["flags"];
    if (!Array.isArray(flags)) continue;
    const riskLevel = candidate["riskLevel"];
    if (typeof riskLevel !== "string") continue;
    // `unavailable` means neither scanner had an opinion. Its flag list is
    // empty by construction, so reading it as "nothing fatal found" would turn
    // a non-answer into a pass.
    if (riskLevel === "unavailable") return null;
    return flags.filter((flag): flag is string => typeof flag === "string");
  }
  return null;
}

/**
 * Turn a payload into a verdict. Exported for direct testing: this is where
 * every refusal is actually decided, and it is worth pointing a hostile payload
 * at without a client in the way.
 */
export function evaluateSecurityPayload(
  payload: unknown,
  requireVerdict: boolean,
): ScanVerdict {
  const flags = readScanFlags(payload);
  if (flags === null) {
    return requireVerdict
      ? { verdict: "deny", reasons: ["scan_unavailable"] }
      : ALLOW;
  }
  const fatal = flags.filter((flag): flag is ScanReason =>
    FATAL_FLAG_SET.has(flag),
  );
  return fatal.length === 0 ? ALLOW : { verdict: "deny", reasons: fatal };
}

type CacheEntry = { readonly expiresAtMs: number; readonly verdict: ScanVerdict };

/**
 * Build a scan gate over a data-plane client.
 *
 * The gate makes at most one outbound read per uncached buy, and only through
 * the data-plane client — the execution plane's single permitted third-party
 * origin. It contacts no security provider directly and never will.
 */
export function createScanGate(options: ScanGateOptions): ScanGate {
  const ttlSec = Math.min(options.ttlSec ?? DEFAULT_SCAN_TTL_SEC, MAX_SCAN_TTL_SEC);
  const requireVerdict = options.requireVerdict ?? false;
  const mode: ScanMode = options.mode ?? "report";
  const cache = new Map<string, CacheEntry>();

  function cacheKey(chainId: number, token: Address): string {
    return `${chainId}:${token.toLowerCase()}`;
  }

  function remember(key: string, verdict: ScanVerdict, scanned: boolean): void {
    // A refusal we made for lack of an answer describes OUR visibility, not the
    // token, so caching it would let one five-second blip poison a token for the
    // whole TTL.
    if (!scanned) return;
    while (cache.size >= MAX_CACHE_KEYS) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
    cache.set(key, { expiresAtMs: options.now() + ttlSec * 1000, verdict });
  }

  return {
    async evaluate(request: ScanRequest): Promise<ScanVerdict> {
      // `off` skips the read entirely — no latency, no data-plane dependency.
      if (mode === "off") return ALLOW;
      // A sell is never gated. If a held token turns hostile after entry,
      // blocking the exit does the honeypot's work for it.
      if (request.side === "sell") return ALLOW;

      const key = cacheKey(request.chainId, request.token);
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAtMs > options.now()) {
        return cached.verdict;
      }
      if (cached !== undefined) cache.delete(key);

      let payload: unknown;
      try {
        payload = await options.dataPlane.security(request.token, request.signal);
      } catch {
        // The error text is deliberately not inspected, logged or classified:
        // it is upstream prose, and the answer is the same for every failure.
        return requireVerdict
          ? { verdict: "deny", reasons: ["scan_unavailable"] }
          : ALLOW;
      }

      const found = evaluateSecurityPayload(payload, requireVerdict);
      remember(key, found, readScanFlags(payload) !== null);
      // Under `report` the findings still travel — only the refusal is dropped.
      return mode === "block" ? found : { verdict: "allow", reasons: found.reasons };
    },
  };
}
