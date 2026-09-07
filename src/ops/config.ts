/**
 * Boot-time resolution of the trade configuration.
 *
 * Pure: environment values in, a validated config object out, an exception on
 * anything wrong. It lives here rather than inline in `src/index-server.ts` for
 * one reason — every rule below is a rule about MONEY, and a rule about money
 * that is only exercised by starting the process is a rule that is never tested.
 *
 * The discipline is the same one the credentials already follow: a malformed
 * value fails the BOOT, never a trade. A fee rate typo, a venue address with a
 * flipped nibble, a slippage ceiling of 100% — each of those is discovered here,
 * with nothing at stake, instead of at the first submit.
 */
import {
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
} from "viem";
import { PASSKEY_DISABLED, type PasskeyConfig } from "../auth/passkeyVerifier.js";
import type { SessionSpec, SpendCap } from "../core/types.js";
import { createBpsFeePolicy, createNoFeePolicy, MAX_FEE_BPS, type FeePolicy } from "./fees.js";
import { grantsTreasury, tradeSessionSpec, type TokenGrant } from "./policy.js";
import { resolveVenues, type VenueConfig } from "./venues.js";
import {
  DEFAULT_SCAN_TTL_SEC,
  MAX_SCAN_TTL_SEC,
  type ScanMode,
} from "../rules/scanGate.js";

/** Default ceiling on declared slippage, in basis points. */
export const DEFAULT_MAX_SLIPPAGE_BPS = 500;

/**
 * Hard ceiling on the configured slippage tolerance, in basis points.
 *
 * 2000 = 20%. Past that the `minOutWei` rule stops meaning anything: a floor
 * 20% below a quote is already a bad fill, and a configuration that permits 90%
 * has disabled the check while appearing to have one.
 */
export const MAX_MAX_SLIPPAGE_BPS = 2_000;

/**
 * Default swap deadline, in seconds.
 *
 * 120, down from the 300 in the first draft. A deadline is how long a signed
 * batch stays valid if the relay holds it, and every one of those seconds is a
 * window in which a searcher can pick the trade up at a worse price. Two minutes
 * is enough slack for a congested block and not much more.
 */
export const DEFAULT_TRADE_DEADLINE_SEC = 120;

/** Upper bound on a configured deadline. Longer is an MEV donation. */
export const MAX_TRADE_DEADLINE_SEC = 900;

/**
 * Default ceiling on how far a VENUE's own fee may push a buy's `msg.value`
 * above the amount the caller asked to spend, in basis points.
 *
 * 300 = 3%, against a live Four.Meme fee of 100 bps (read back from
 * `getTokenInfo(0x0).tradingFeeRate` on 2026-08-11). The headroom is for a fee
 * change or a small-trade fee floor, not for a different order of magnitude.
 *
 * This is the number that makes "a tighter server-side boundary" true for
 * Four.Meme (PHASE2.1 R1). `msg.value` there comes from an RPC read, and
 * chain-id pinning authenticates the ENDPOINT at connect time — never an
 * individual `eth_call` result. So the read is bounded by what the caller
 * itself declared, and a quote asking for meaningfully more than that is
 * refused before submit rather than delegated to an optional per-agent cap.
 */
export const DEFAULT_MAX_VENUE_FEE_BPS = 300;

/**
 * Hard ceiling on the configured venue-fee tolerance, in basis points.
 *
 * 1000 = 10%. A configuration that tolerates more has stopped bounding the
 * read: at that point the guard would wave through a quote asking for a tenth
 * more native than the caller declared, which is the exact failure it exists
 * to catch.
 */
export const MAX_MAX_VENUE_FEE_BPS = 1_000;

/** The resolved, validated trade configuration the HTTP layer runs on. */
export type TradeRuntimeConfig = {
  readonly venues: VenueConfig;
  readonly feePolicy: FeePolicy;
  /** Present only when a fee is configured. Folded into every paramsHash. */
  readonly feeTreasury?: Address;
  readonly feeBps?: number;
  readonly scanTtlSec: number;
  /** Refuse a buy when no scan verdict could be obtained. Default false. */
  readonly scanRequireVerdict: boolean;
  /** What a scan verdict may do: off | report | block. Defaults to report. */
  readonly scanMode: ScanMode;
  readonly maxSlippageBps: number;
  readonly deadlineSec: number;
  /**
   * Ceiling on the venue fee a read-derived `msg.value` may add on top of the
   * caller's `amountWei`, in basis points. See {@link DEFAULT_MAX_VENUE_FEE_BPS}.
   */
  readonly maxVenueFeeBps: number;
};

/** The environment, as a plain readonly record. Injected so this stays pure. */
export type TradeEnv = Readonly<Record<string, string | undefined>>;

export type LpEvidenceSourceRole = "required" | "accelerator";
export type LpEvidenceSourceConfig = {
  readonly id: string;
  readonly url: string;
  readonly role: LpEvidenceSourceRole;
  readonly operatorFamily: string;
  readonly endpointFingerprint: string;
};

export type LpEvidenceConfig = {
  readonly enabled: boolean;
  readonly sources: readonly LpEvidenceSourceConfig[];
  readonly expirySafetySeconds: number;
  readonly requestTimeoutMs: number;
  readonly perSourceConcurrency: number;
  readonly globalConcurrency: number;
  readonly requestsPerSecond: number;
  readonly chunkBlocks: number;
  readonly maxColdBackfillBlocks: number;
  readonly maxBackfillBlocksPerHour: number;
  readonly reorgRewindBlocks: number;
  readonly ownerSnapshotTimeoutMs: number;
  readonly maxGlobalLogicalBytes: number;
  readonly maxVersionLogicalBytes: number;
  readonly maxVersionBlockRows: number;
  readonly maxVersionCandidateRows: number;
  readonly maxRequirements: number;
  readonly maxZeroExpiryRequirements: number;
  readonly auditRetentionDays: number;
};

const LP_EVIDENCE_SOURCE_REGISTRY = new Map<string, {
  readonly url: string;
  readonly role: LpEvidenceSourceRole;
  readonly operatorFamily: string;
}>([
  ["bnbchain-public", {
    url: "https://bsc-dataseed-public.bnbchain.org",
    role: "required",
    operatorFamily: "bnb-chain",
  }],
  ["nariox", {
    url: "https://bsc-dataseed.nariox.org",
    role: "required",
    operatorFamily: "nariox",
  }],
  ["publicnode", {
    url: "https://bsc-rpc.publicnode.com",
    role: "required",
    operatorFamily: "allnodes-publicnode",
  }],
]);

/**
 * Disabled-by-default Phase 3.9c evidence egress. Source ids, roles and origins
 * are source-controlled; the environment can select a compiled subset but can
 * never introduce an endpoint or alias two operator families.
 */
export function resolveLpEvidenceConfig(env: TradeEnv): LpEvidenceConfig {
  const rawEnabled = read(env, "LP_LANDING_EVIDENCE_ENABLED");
  if (rawEnabled !== "" && rawEnabled !== "true" && rawEnabled !== "false") {
    throw new Error('LP_LANDING_EVIDENCE_ENABLED must be exactly "true" or "false".');
  }
  const enabled = rawEnabled === "true";
  const rawSources = read(env, "LP_LANDING_EVIDENCE_SOURCES_JSON");
  let sources: LpEvidenceSourceConfig[] = [];
  if (rawSources !== "" && rawSources !== "[]") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawSources);
    } catch {
      throw new Error("LP_LANDING_EVIDENCE_SOURCES_JSON must be valid JSON.");
    }
    if (!Array.isArray(decoded)) {
      throw new Error("LP_LANDING_EVIDENCE_SOURCES_JSON must be an array.");
    }
    const seenIds = new Set<string>();
    const seenFamilies = new Set<string>();
    for (const item of decoded) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error("Each LP evidence source must be an object.");
      }
      const value = item as Record<string, unknown>;
      if (Object.keys(value).sort().join("|") !== "id|role|url" ||
          typeof value["id"] !== "string" || typeof value["url"] !== "string" ||
          (value["role"] !== "required" && value["role"] !== "accelerator")) {
        throw new Error("Each LP evidence source must be exactly {id,url,role}.");
      }
      const registered = LP_EVIDENCE_SOURCE_REGISTRY.get(value["id"]);
      if (registered === undefined || registered.url !== value["url"] ||
          registered.role !== value["role"]) {
        throw new Error(`LP evidence source ${value["id"]} is not a compiled id/role/origin tuple.`);
      }
      const parsed = new URL(value["url"]);
      if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
          parsed.search !== "" || parsed.hash !== "" || parsed.pathname !== "/") {
        throw new Error("LP evidence sources must be credential-free HTTPS origins.");
      }
      if (seenIds.has(value["id"]) || seenFamilies.has(registered.operatorFamily)) {
        throw new Error("LP evidence source ids and operator families must be unique.");
      }
      seenIds.add(value["id"]);
      seenFamilies.add(registered.operatorFamily);
      sources.push({
        id: value["id"],
        url: parsed.origin,
        role: value["role"],
        operatorFamily: registered.operatorFamily,
        endpointFingerprint: keccak256String(parsed.origin),
      });
    }
    sources = sources.sort((left, right) => left.id.localeCompare(right.id));
  }
  if (enabled) {
    const required = sources.filter((source) => source.role === "required");
    if (required.length < 2 || new Set(required.map((source) => source.operatorFamily)).size < 2) {
      throw new Error("LP landing evidence requires at least two independent required sources.");
    }
  } else if (sources.length > 0) {
    throw new Error("LP evidence sources must stay empty while the observer is disabled.");
  }
  return {
    enabled,
    sources,
    expirySafetySeconds: readInt(env, "LP_EVIDENCE_EXPIRY_SAFETY_SECONDS", 300, 0, 86_400),
    requestTimeoutMs: readInt(env, "LP_EVIDENCE_REQUEST_TIMEOUT_MS", 6_000, 100, 60_000),
    perSourceConcurrency: readInt(env, "LP_EVIDENCE_PER_SOURCE_CONCURRENCY", 1, 1, 8),
    globalConcurrency: readInt(env, "LP_EVIDENCE_GLOBAL_CONCURRENCY", 2, 1, 32),
    requestsPerSecond: readInt(env, "LP_EVIDENCE_REQUESTS_PER_SECOND", 2, 1, 100),
    chunkBlocks: readInt(env, "LP_EVIDENCE_CHUNK_BLOCKS", 50, 1, 50),
    maxColdBackfillBlocks: readInt(env, "LP_EVIDENCE_MAX_COLD_BACKFILL_BLOCKS", 100_000, 1, 10_000_000),
    maxBackfillBlocksPerHour: readInt(env, "LP_EVIDENCE_MAX_BACKFILL_BLOCKS_PER_HOUR", 20_000, 1, 1_000_000),
    reorgRewindBlocks: readInt(env, "LP_EVIDENCE_REORG_REWIND_BLOCKS", 256, 1, 256),
    ownerSnapshotTimeoutMs: readInt(env, "LP_EVIDENCE_OWNER_SNAPSHOT_TIMEOUT_MS", 250, 10, 10_000),
    maxGlobalLogicalBytes: readInt(env, "LP_EVIDENCE_MAX_GLOBAL_LOGICAL_BYTES", 4_294_967_296, 1, Number.MAX_SAFE_INTEGER),
    maxVersionLogicalBytes: readInt(env, "LP_EVIDENCE_MAX_VERSION_LOGICAL_BYTES", 2_147_483_648, 1, Number.MAX_SAFE_INTEGER),
    maxVersionBlockRows: readInt(env, "LP_EVIDENCE_MAX_VERSION_BLOCK_ROWS", 2_000_000, 1, 100_000_000),
    maxVersionCandidateRows: readInt(env, "LP_EVIDENCE_MAX_VERSION_CANDIDATE_ROWS", 500_000, 1, 100_000_000),
    maxRequirements: readInt(env, "LP_EVIDENCE_MAX_REQUIREMENTS", 10_000, 1, 1_000_000),
    maxZeroExpiryRequirements: readInt(env, "LP_EVIDENCE_MAX_ZERO_EXPIRY_REQUIREMENTS", 1_000, 0, 100_000),
    auditRetentionDays: readInt(env, "LP_EVIDENCE_AUDIT_RETENTION_DAYS", 180, 30, 3_650),
  };
}

function keccak256String(value: string): string {
  return keccak256(stringToHex(value));
}

export type ResolveTradeConfigOptions = {
  readonly chainId: number;
  /** The network's KeyStore, so a venue override cannot be pointed at it. */
  readonly keyStore?: Address;
  /** Clock, unix SECONDS. Injected for the session-template self-check. */
  readonly nowSeconds?: number;
  /**
   * Session-template builder. Defaults to {@link tradeSessionSpec}; injectable
   * so the boot-time treasury invariant can be tested against a template that
   * does NOT grant it.
   */
  readonly buildTemplate?: (input: {
    readonly venues: VenueConfig;
    readonly treasury?: Address;
    /** PHASE2.3: the token universe. The probe below passes none. */
    readonly tokens: readonly TokenGrant[];
    readonly nativeCaps: readonly SpendCap[];
    readonly expiresAt: number;
    readonly nowSeconds: number;
  }) => SessionSpec;
};

function read(env: TradeEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

/**
 * Parse a bounded integer setting. Every numeric knob goes through this, so a
 * blank means "default" and a garbage value means "do not start" — never a
 * silent `NaN` that later compares false against everything.
 */
function readInt(
  env: TradeEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = read(env, name);
  if (raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function readAddressEnv(
  env: TradeEnv,
  name: string,
  keyStore: Address | undefined,
): Address | undefined {
  const raw = read(env, name);
  if (raw === "") return undefined;
  if (!isAddress(raw)) {
    throw new Error(`${name} is not a valid checksummed address.`);
  }
  const address = getAddress(raw);
  if (address === getAddress(zeroAddress)) {
    throw new Error(`${name} must not be the zero address.`);
  }
  if (keyStore !== undefined && address === getAddress(keyStore)) {
    throw new Error(`${name} must not be the key registry.`);
  }
  return address;
}

/**
 * `EXECUTE_RAW_ENABLED`, default FALSE.
 *
 * Only the exact string `"true"` enables it. Anything else — `"1"`, `"yes"`,
 * `"TRUE"`, a typo — leaves the raw route disabled.
 *
 * WHY IT STAYS OFF, corrected for PHASE2.3 (R7). The original reason was that
 * the trade template's bare-selector `approve` made raw calldata a path to
 * approve and drain EVERY ERC-20 in the owner's EOA. That grant is gone, so
 * the drain path is NARROWED — not closed. A leaked `x-exec-token` on this
 * route can still `approve(attacker, amount)` on any GRANTED token (the spender
 * is an argument and no `CallRule` can constrain it) and drain up to that
 * token's cap with a separate `transferFrom`; with the deliberately generous
 * default token caps (R4) that bound is effectively the full balance of each
 * granted token.
 *
 * The corrected wording strengthens the recommendation rather than weakening
 * it. The raw route also bypasses the scan gate and the rule engine entirely,
 * which is sufficient reason on its own; the narrowed-but-open drain path is a
 * second. Being too strict here costs a 404 an operator notices immediately.
 */
export function resolveExecuteRawEnabled(env: TradeEnv): boolean {
  return read(env, "EXECUTE_RAW_ENABLED") === "true";
}

/* -------------------------------------------------------------------------- */
/* LP route runtime config (PHASE3 R8/R13/R15)                                */
/* -------------------------------------------------------------------------- */

/** Default staleness bound on a ranked-pools payload, in seconds. */
export const DEFAULT_LP_RANKING_MAX_AGE_SEC = 300;

/**
 * Default fence ceiling on `tickUpper - tickLower` for server-fenced ranges.
 *
 * 200 000 ticks ≈ a ×4.85·10⁸ price span — wide enough that no sane proposal
 * trips it, narrow enough that a hallucinated full-range proposal does. It is a
 * FENCE bound, not a strategy: the deterministic fallback and the brain both
 * live inside it.
 */
export const DEFAULT_LP_MAX_TICK_WIDTH = 200_000;

/**
 * Default width of a server-fenced OPEN range, in ticks (~±5% at spacing 50).
 * The open has no prior position to take a width from, so this plays the role
 * `priorWidthTicks` plays for a rotate; the fence's fallback re-centering and
 * the 2×tickSpacing floor still apply on top of it.
 */
export const DEFAULT_LP_OPEN_WIDTH_TICKS = 1_000;

/** Default cap on how many ranked pools the open route gates per request. */
export const DEFAULT_LP_MAX_RANKED_CANDIDATES = 10;

/**
 * How old an `UNKNOWN` LP step row must be before an owner may resolve it,
 * in SECONDS (PHASE3.3 Rev2 items 14–15).
 *
 * THE AGE GUARD IS A HEURISTIC AND THIS COMMENT IS WHERE THAT IS SAID. It is
 * NOT derived from our own 45 s client timeout, which is a property of our
 * client and not of the relay: FINDINGS (aa) measured the relay answering
 * `PENDING` with a `callsId` after several MINUTES, unbounded above, so no age
 * makes absence permanent — a queued bundle can land at any future block. 30
 * minutes is ~40× the observed worst case and costs an operator one coffee.
 * The LOAD-BEARING guard is the inputs-still-present / discriminating-leg pair
 * below, not this.
 */
export const DEFAULT_RESOLVE_MIN_AGE_SEC = 1_800;
/** Hard floor / ceiling on {@link DEFAULT_RESOLVE_MIN_AGE_SEC}. */
const MIN_RESOLVE_MIN_AGE_SEC = 900;
const MAX_RESOLVE_MIN_AGE_SEC = 86_400;

/**
 * How close a wallet balance must sit to the amount a stuck step needed before
 * that leg counts as DISCRIMINATING, in basis points of the needed amount
 * (10 000 = exactly 1.00×). Default 12 000 = 1.2×.
 *
 * WHY A LEG CAN PROVE NOTHING. Every LP step pulls from the wallet's FUNGIBLE
 * ERC-20 balance, so "the leg is still there" only means "the step did not
 * land" when nothing else could have put that token there. Measured on the row
 * this phase exists for: the WBNB leg reads 1.00× — genuinely discriminating,
 * and would read 0 had the increase landed — while the CAKE leg reads
 * ~424 000× the amount needed, the FINDINGS (ak) pile three stop-losses built,
 * and proves exactly nothing. A step every one of whose legs sits in a surplus
 * is UNRESOLVABLE and is refused; that is the honest fail-closed answer.
 */
export const DEFAULT_RESOLVE_DISCRIMINATING_MULTIPLE_BPS = 12_000;
/** A leg can never be "within less than 1.00×" of what it needs. */
const MIN_RESOLVE_DISCRIMINATING_MULTIPLE_BPS = 10_000;
/** 100× — past here the flag would mean nothing at all. */
const MAX_RESOLVE_DISCRIMINATING_MULTIPLE_BPS = 1_000_000;

/** Global tick span (±887272) — the hard ceiling on any configured width. */
const MAX_POSSIBLE_TICK_WIDTH = 2 * 887_272;

/** What the LP routes need resolved at boot (PHASE3 Rev2 items 27/34/38). */
export type LpRuntimeConfig = {
  /** Refuse a ranked-pools payload older than this, in seconds (item 38). */
  readonly rankingMaxAgeSec: number;
  /** Fence ceiling on a proposed/derived range width, in ticks. */
  readonly maxTickWidth: number;
  /** Width a server-fenced open derives its range from, in ticks. */
  readonly defaultOpenWidthTicks: number;
  /** How many ranked pools the open route will run the gates over. */
  readonly maxRankedCandidates: number;
  /**
   * `RESOLVE_MIN_AGE_SEC` — minimum age of an `UNKNOWN` LP step row before
   * `POST /agents/:id/journal/:decisionId/resolve` will consider it. Anchored
   * on `updatedAt` (the moment we gave up), which is later than `createdAt` and
   * therefore the conservative end.
   */
  readonly resolveMinAgeSec: number;
  /** `RESOLVE_DISCRIMINATING_MULTIPLE_BPS` — see the constant's contract. */
  readonly resolveDiscriminatingMultipleBps: number;
  /**
   * `LP_KNOWN_STAKERS` (PHASE3.4 Rev2 M10) — contracts that legitimately hold
   * NFPM positions on a user's behalf, lowercased.
   *
   * Used by `POST /lp/import` for ONE purpose: to tell an owner whose `ownerOf`
   * read returns a farm that their position is STAKED and needs unstaking,
   * rather than the true-but-useless "not this wallet's position". The list
   * grants nothing and gates nothing — a recognised staker is still refused.
   */
  readonly knownStakers: readonly Address[];
  /**
   * PHASE3.24 R3.6 — boot-canonicalized allowlist for atomic exit conversion.
   * Empty by default, so no token enters the new money path implicitly.
   */
  readonly conversionCompatibleTokens: ReadonlySet<Address>;
};

/**
 * `LP_CONVERSION_COMPATIBLE_TOKENS_JSON` — an exact JSON array of addresses.
 * Every malformed shape fails boot; blank and `[]` are the fail-closed empty
 * set. Canonical addresses make membership case-insensitive without guessing.
 */
export function resolveLpConversionCompatibleTokens(env: TradeEnv): ReadonlySet<Address> {
  const raw = read(env, "LP_CONVERSION_COMPATIBLE_TOKENS_JSON");
  if (raw === "") return new Set<Address>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LP_CONVERSION_COMPATIBLE_TOKENS_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("LP_CONVERSION_COMPATIBLE_TOKENS_JSON must be an array.");
  }
  const out = new Set<Address>();
  const seen = new Set<string>();
  for (const candidate of parsed) {
    if (typeof candidate !== "string" || !isAddress(candidate, { strict: false })) {
      throw new Error(
        "LP_CONVERSION_COMPATIBLE_TOKENS_JSON must contain only 20-byte hex address strings.",
      );
    }
    const address = getAddress(candidate);
    if (address === zeroAddress) {
      throw new Error("LP_CONVERSION_COMPATIBLE_TOKENS_JSON must not contain the zero address.");
    }
    const key = address.toLowerCase();
    if (seen.has(key)) {
      throw new Error("LP_CONVERSION_COMPATIBLE_TOKENS_JSON contains a duplicate address.");
    }
    seen.add(key);
    out.add(address);
  }
  return out;
}

/**
 * PancakeSwap MasterChefV3 on BNB Chain 56 — the default `LP_KNOWN_STAKERS`.
 *
 * PINNED FROM CHAIN rather than copied from a list (PHASE3.4-REVIEW, "On-chain
 * facts"): the contract's own `nonfungiblePositionManager()` returns
 * `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364`, which is the NFPM this
 * deployment manages positions on, so the pin verifies itself. It holds ~81 686
 * NFPM positions, which is why shipping this list EMPTY was the wrong default:
 * "staked in the farm" is plausibly the single most common reason an owner's
 * `ownerOf` read does not return their wallet.
 */
export const DEFAULT_LP_KNOWN_STAKERS_BY_CHAIN: ReadonlyMap<number, readonly Address[]> =
  new Map([[56, ["0x556B9306565093C855AEA9AE92A594704c2Cd59e" as Address]]]);

/**
 * Resolve the LP route configuration. Same posture as everything else in this
 * file: a malformed value fails the BOOT, never a request. (The manipulation
 * RAILS deliberately do not live here — `resolveLpRailConfig` in
 * `src/lp/rails.ts` answers per-cycle with hold semantics, per the spec.)
 */
export function resolveLpRuntimeConfig(env: TradeEnv): LpRuntimeConfig {
  const rankingMaxAgeSec = readInt(
    env,
    "LP_RANKING_MAX_AGE_SEC",
    DEFAULT_LP_RANKING_MAX_AGE_SEC,
    1,
    86_400,
  );
  const maxTickWidth = readInt(
    env,
    "LP_MAX_TICK_WIDTH",
    DEFAULT_LP_MAX_TICK_WIDTH,
    2,
    MAX_POSSIBLE_TICK_WIDTH,
  );
  const defaultOpenWidthTicks = readInt(
    env,
    "LP_OPEN_WIDTH_TICKS",
    DEFAULT_LP_OPEN_WIDTH_TICKS,
    2,
    MAX_POSSIBLE_TICK_WIDTH,
  );
  if (defaultOpenWidthTicks > maxTickWidth) {
    throw new Error(
      "LP_OPEN_WIDTH_TICKS must not exceed LP_MAX_TICK_WIDTH; the fence would refuse every server-fenced open.",
    );
  }
  const maxRankedCandidates = readInt(
    env,
    "LP_MAX_RANKED_CANDIDATES",
    DEFAULT_LP_MAX_RANKED_CANDIDATES,
    1,
    50,
  );
  // PHASE3.3 Rev2 item 14: the SAME `readInt` convention, not a new resolver,
  // so a malformed value fails the BOOT and never a request.
  const resolveMinAgeSec = readInt(
    env,
    "RESOLVE_MIN_AGE_SEC",
    DEFAULT_RESOLVE_MIN_AGE_SEC,
    MIN_RESOLVE_MIN_AGE_SEC,
    MAX_RESOLVE_MIN_AGE_SEC,
  );
  const resolveDiscriminatingMultipleBps = readInt(
    env,
    "RESOLVE_DISCRIMINATING_MULTIPLE_BPS",
    DEFAULT_RESOLVE_DISCRIMINATING_MULTIPLE_BPS,
    MIN_RESOLVE_DISCRIMINATING_MULTIPLE_BPS,
    MAX_RESOLVE_DISCRIMINATING_MULTIPLE_BPS,
  );
  return {
    rankingMaxAgeSec,
    maxTickWidth,
    defaultOpenWidthTicks,
    maxRankedCandidates,
    resolveMinAgeSec,
    resolveDiscriminatingMultipleBps,
    knownStakers: resolveLpKnownStakers(env),
    conversionCompatibleTokens: resolveLpConversionCompatibleTokens(env),
  };
}

/**
 * `LP_KNOWN_STAKERS` — comma-separated addresses, or unset for the chain's
 * pinned default (M10).
 *
 * Boot-validated in this file's posture: a malformed address fails the BOOT and
 * never a request.
 *
 * THE THREE CASES, stated as the code implements them (audit A7 — this comment
 * used to claim the empty string was the explicit no-stakers override, which
 * `read()` cannot express because it trims and returns `""` for unset too):
 *
 *   - **unset, or set to empty/whitespace** ⇒ the chain's pinned default (none
 *     for a chain this build has no default for, so a wrong chain's farm
 *     address is never silently assumed);
 *   - **the literal `"none"`** ⇒ an empty list, which is the explicit override;
 *   - **a comma-separated list** ⇒ that list.
 */
export function resolveLpKnownStakers(env: TradeEnv): readonly Address[] {
  const raw = read(env, "LP_KNOWN_STAKERS");
  if (raw === "") {
    const chainId = readInt(env, "CHAIN_ID", 56, 1, Number.MAX_SAFE_INTEGER);
    return DEFAULT_LP_KNOWN_STAKERS_BY_CHAIN.get(chainId) ?? [];
  }
  if (raw.trim() === "none") return [];
  const out: Address[] = [];
  for (const part of raw.split(",")) {
    const candidate = part.trim();
    if (candidate === "") continue;
    if (!isAddress(candidate, { strict: false })) {
      throw new Error(
        `LP_KNOWN_STAKERS contains "${candidate}", which is not a 20-byte hex address.`,
      );
    }
    out.push(getAddress(candidate));
  }
  return out;
}

/**
 * `LP_ENABLED`, the LP surface's master switch (PHASE3 build item 3), in
 * `resolvePasskeyConfig`'s tri-state style rather than
 * {@link resolveExecuteRawEnabled}'s "anything else is false": OFF by default
 * (deps absent ⇒ the LP routes answer the same 404 an unknown path gets), ON
 * only for the exact string `"true"`, and a TYPO FAILS THE BOOT — an operator
 * who wrote `LP_ENABLED=1` believed they enabled LP, and a server that
 * silently 404s every LP route while looking healthy is the F8 failure shape
 * with money attached. Resolution of the rest of the LP config (addresses,
 * runtime knobs, relay fee) only runs when this answers true, so a malformed
 * LP variable on a deployment that never enabled LP costs nothing.
 */
export function resolveLpEnabled(env: TradeEnv): boolean {
  const raw = read(env, "LP_ENABLED");
  if (raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`LP_ENABLED must be exactly "true" or "false"; got "${raw}".`);
}

/**
 * `GRID_ENABLED`, the grid ping-pong's master switch (PHASE3.15 R2.9 item 9) —
 * the SAME tri-state shape as {@link resolveLpEnabled}, byte for byte, and for
 * the same reason: OFF by default, ON only for the exact string `"true"`, and a
 * TYPO FAILS THE BOOT. An operator who wrote `GRID_ENABLED=1` believed they
 * enabled the grid, and a server that silently skips every grid agent while
 * looking healthy is the PHASE4-AUDIT A1/F8 shape with a position attached.
 *
 * ONE ADDITION over `resolveLpEnabled`, and it is L3: grid deps BUILD ON LP
 * deps, so `GRID_ENABLED="true"` with `LP_ENABLED` off is an operator error
 * rather than a configuration. It throws HERE, in the resolver, rather than at
 * one composition site — which means every caller (the server boot, the LP
 * wiring, the worker's boot config, the dev stack) gets the same refusal
 * without four copies of the same conditional.
 */
export function resolveGridEnabled(env: TradeEnv): boolean {
  const raw = read(env, "GRID_ENABLED");
  const enabled =
    raw === ""
      ? false
      : raw === "true"
        ? true
        : raw === "false"
          ? false
          : null;
  if (enabled === null) {
    throw new Error(`GRID_ENABLED must be exactly "true" or "false"; got "${raw}".`);
  }
  if (enabled && !resolveLpEnabled(env)) {
    throw new Error(
      'GRID_ENABLED is "true" while LP_ENABLED is not: the grid rides the LP plane, so its routes, its worker branch and its stores are all built inside the LP composition. Enabling it alone would produce a healthy-looking server that skips every grid agent.',
    );
  }
  return enabled;
}

/* -------------------------------------------------------------------------- */
/* Passkey owner auth (PHASE1.5)                                              */
/* -------------------------------------------------------------------------- */

/** Most origins any deployment should need: apex, www, staging, localhost. */
export const MAX_PASSKEY_ORIGINS = 4;

/**
 * A bare registrable domain: labels of `[a-z0-9-]` joined by dots, no scheme, no
 * port, no path, no leading or trailing dot.
 */
const RP_ID_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Parse a strict boolean setting. Unlike {@link resolveExecuteRawEnabled}'s
 * "anything that is not `true` is false", a typo here THROWS.
 *
 * That difference is deliberate and is the whole of F8: a silently-disabled
 * passkey backend produces a server that looks healthy, passes `/health`, serves
 * every secp256k1 owner correctly, and answers every passkey owner with the same
 * generic failure a forgery gets. A misconfiguration must not be
 * indistinguishable from an attack.
 */
function readStrictBool(
  env: TradeEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = read(env, name);
  if (raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be exactly "true" or "false"; got "${raw}".`);
}

/** Marketplace hire is an independently gated custody surface. */
export function resolveHireEnabled(env: TradeEnv): boolean {
  const enabled = readStrictBool(env, "HIRE_ENABLED", false);
  if (!enabled) return false;
  if (!readStrictBool(env, "PASSKEY_ENABLED", false)) {
    throw new Error('HIRE_ENABLED is "true" while PASSKEY_ENABLED is not true.');
  }
  return true;
}

export function resolveHireGrantGasHeadroomWei(env: TradeEnv, relayFeePerSubmitWei: bigint): bigint {
  const raw = read(env, "HIRE_GRANT_GAS_HEADROOM_WEI");
  if (raw === "") return relayFeePerSubmitWei * 3n;
  if (!/^\d{1,78}$/u.test(raw)) {
    throw new Error("HIRE_GRANT_GAS_HEADROOM_WEI must be a decimal uint256 string.");
  }
  return BigInt(raw);
}

/**
 * Resolve the passkey (WebAuthn/P-256) owner-auth configuration.
 *
 * TRI-STATE, not an inference from absent variables. `PASSKEY_ENABLED` defaults
 * to `false` and the WebAuthn branch then refuses before any parsing — the
 * Phase 1b behaviour verbatim. When it is `true`, a missing or malformed
 * `PASSKEY_RP_ID` / `PASSKEY_ORIGINS` is a STARTUP FAILURE, never a silent
 * per-request refusal: an RP ID that matches no configured origin can never
 * authenticate anyone, and finding that out at request time costs a debugging
 * session.
 *
 * Pure, like every other resolver here, because these are rules about who may
 * move money and a rule only exercised by starting the process is a rule that is
 * never tested.
 */
export function resolvePasskeyConfig(env: TradeEnv): PasskeyConfig {
  if (!readStrictBool(env, "PASSKEY_ENABLED", false)) return PASSKEY_DISABLED;

  const rpId = read(env, "PASSKEY_RP_ID").toLowerCase();
  if (rpId === "") {
    throw new Error("PASSKEY_RP_ID is required when PASSKEY_ENABLED=true.");
  }
  if (!RP_ID_PATTERN.test(rpId)) {
    throw new Error(
      `PASSKEY_RP_ID must be a bare registrable domain (no scheme, port, path or leading dot); got "${rpId}".`,
    );
  }

  const allowInsecure = readStrictBool(env, "PASSKEY_ALLOW_INSECURE_ORIGINS", false);
  const origins = read(env, "PASSKEY_ORIGINS")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (origins.length === 0) {
    throw new Error("PASSKEY_ORIGINS is required when PASSKEY_ENABLED=true.");
  }
  if (origins.length > MAX_PASSKEY_ORIGINS) {
    throw new Error(
      `PASSKEY_ORIGINS accepts at most ${MAX_PASSKEY_ORIGINS} entries; got ${origins.length}.`,
    );
  }

  for (const entry of origins) {
    // A wildcard is fail-closed on its own — nothing would ever match it — but
    // it fails for a reason no log states, so it fails the boot instead.
    if (entry.includes("*")) {
      throw new Error(`PASSKEY_ORIGINS must not contain a wildcard; got "${entry}".`);
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`PASSKEY_ORIGINS entry "${entry}" is not a valid URL.`);
    }
    // The verifier compares `clientDataJSON.origin` EXACTLY, so the operator has
    // to write the browser's own serialized origin. This one identity forbids
    // paths, trailing slashes, query strings, credentials and default ports all
    // at once — `https://4lpha.app/` would otherwise refuse every request with
    // no explanation anywhere.
    if (url.origin !== entry) {
      throw new Error(
        `PASSKEY_ORIGINS entry "${entry}" is not a serialized origin (expected "${url.origin}").`,
      );
    }
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:") {
      if (url.protocol !== "http:" || !isLoopback || url.port === "" || !allowInsecure) {
        throw new Error(
          `PASSKEY_ORIGINS entry "${entry}" must be https, or an explicit-port http://localhost or http://127.0.0.1 origin with PASSKEY_ALLOW_INSECURE_ORIGINS=true.`,
        );
      }
    }
    // The RP ID must be suffix-or-equal of every origin's host, or the
    // authenticator's rpIdHash can never match what this server hashes.
    const host = url.hostname.toLowerCase();
    if (host !== rpId && !host.endsWith(`.${rpId}`)) {
      throw new Error(
        `PASSKEY_ORIGINS entry "${entry}" has host "${host}", which PASSKEY_RP_ID "${rpId}" is not a suffix of.`,
      );
    }
  }

  return {
    enabled: true,
    rpId,
    origins,
    uvRequired: readStrictBool(env, "PASSKEY_UV_REQUIRED", true),
  };
}

/**
 * Resolve and validate everything the trade route needs.
 *
 * THROWS on any invalid value. The last check is the subtle one: when a fee is
 * configured, the treasury MUST appear in the canonical session template's
 * allowlist. A fee whose recipient is outside the on-chain policy does not fail
 * quietly — it makes every single trade revert at the account contract, after the
 * batch has been built and submitted. Discovering that at boot costs nothing.
 */
export function resolveTradeConfig(
  env: TradeEnv,
  options: ResolveTradeConfigOptions,
): TradeRuntimeConfig {
  const keyStore = options.keyStore;

  const venues = resolveVenues({
    chainId: options.chainId,
    overrides: {
      pancakeRouterV2: read(env, "VENUE_PANCAKE_ROUTER"),
      pancakeRouterV3: read(env, "VENUE_PANCAKE_ROUTER_V3"),
      wbnb: read(env, "VENUE_WBNB"),
      fourMemeHelper: read(env, "VENUE_FOURMEME_HELPER"),
      flapPortal: read(env, "VENUE_FLAP_PORTAL"),
    },
    ...(keyStore === undefined ? {} : { keyStore }),
  });

  const scanRequireVerdict = read(env, "SCAN_REQUIRE_VERDICT") === "true";
  const scanModeRaw = read(env, "SCAN_MODE");
  if (scanModeRaw !== "" && scanModeRaw !== "off" && scanModeRaw !== "report" && scanModeRaw !== "block") {
    throw new Error(`SCAN_MODE must be off, report or block; got "${scanModeRaw}".`);
  }
  const scanMode: ScanMode = scanModeRaw === "" ? "report" : scanModeRaw;
  const scanTtlSec = readInt(env, "SCAN_TTL_SEC", DEFAULT_SCAN_TTL_SEC, 0, MAX_SCAN_TTL_SEC);
  const maxSlippageBps = readInt(
    env,
    "MAX_SLIPPAGE_BPS",
    DEFAULT_MAX_SLIPPAGE_BPS,
    1,
    MAX_MAX_SLIPPAGE_BPS,
  );
  const deadlineSec = readInt(
    env,
    "TRADE_DEADLINE_SEC",
    DEFAULT_TRADE_DEADLINE_SEC,
    1,
    MAX_TRADE_DEADLINE_SEC,
  );
  // Validated `0 < bps <= 1000`: a zero would refuse every Four.Meme buy on a
  // venue that charges anything at all, and anything above 10% has stopped
  // bounding the read it exists to bound.
  const maxVenueFeeBps = readInt(
    env,
    "MAX_VENUE_FEE_BPS",
    DEFAULT_MAX_VENUE_FEE_BPS,
    1,
    MAX_MAX_VENUE_FEE_BPS,
  );

  const feeTreasury = readAddressEnv(env, "FEE_TREASURY_ADDRESS", keyStore);
  const rawFeeBps = read(env, "FEE_BPS");

  if ((feeTreasury === undefined) !== (rawFeeBps === "")) {
    // Half a fee configuration is always a mistake, and both halves of the
    // mistake are dangerous: a treasury with no rate charges nothing while
    // looking configured, and a rate with no treasury has nowhere to send it.
    throw new Error(
      "FEE_TREASURY_ADDRESS and FEE_BPS must be set together, or neither.",
    );
  }

  if (feeTreasury === undefined) {
    return {
      venues,
      feePolicy: createNoFeePolicy(),
      scanTtlSec,
      scanRequireVerdict,
      scanMode,
      maxSlippageBps,
      deadlineSec,
      maxVenueFeeBps,
    };
  }

  const feeBps = readInt(env, "FEE_BPS", 0, 1, MAX_FEE_BPS);
  // Constructing the policy re-validates the rate; the duplication is deliberate
  // so the policy cannot be built unvalidated from anywhere else either.
  const feePolicy = createBpsFeePolicy({ treasury: feeTreasury, bps: feeBps });

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const buildTemplate = options.buildTemplate ?? tradeSessionSpec;
  const probeCaps: readonly SpendCap[] = [{ limit: 1n, period: "day" }];
  // NO TOKENS, deliberately (PHASE2.3 R6). This probe asks one question — is
  // the treasury in the allowlist — and the answer does not depend on which
  // ERC-20s a future agent may trade. Boot has no token universe to hand it
  // anyway: that is caller-supplied at hire (R8).
  const template = buildTemplate({
    venues,
    treasury: feeTreasury,
    tokens: [],
    nativeCaps: probeCaps,
    expiresAt: nowSeconds + 3_600,
    nowSeconds,
  });
  if (!grantsTreasury(template, feeTreasury)) {
    throw new Error(
      "FEE_TREASURY_ADDRESS is not granted by the trade session template; " +
        "every trade would be rejected on-chain. Refusing to start.",
    );
  }

  return {
    venues,
    feePolicy,
    feeTreasury,
    feeBps,
    scanTtlSec,
    scanRequireVerdict,
    scanMode,
    maxSlippageBps,
    deadlineSec,
    maxVenueFeeBps,
  };
}

/* -------------------------------------------------------------------------- */
/* Venus guard (PHASE4 D11)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `VENUS_ENABLED`, the Venus surface's master switch — the SAME tri-state
 * shape as {@link resolveLpEnabled}, for the same reason (D11).
 *
 * OFF by default (deps absent ⇒ the Venus routes answer the same 404 an unknown
 * path gets, the worker refuses to start, the provisioning script refuses), ON
 * only for the exact string `"true"`, and a TYPO FAILS THE BOOT — an operator
 * who wrote `VENUS_ENABLED=1` believed they enabled the guard, and a server that
 * silently 404s every Venus route while looking healthy is the F8 failure shape
 * with a lending position attached.
 */
export function resolveVenusEnabled(env: TradeEnv): boolean {
  const raw = read(env, "VENUS_ENABLED");
  if (raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`VENUS_ENABLED must be exactly "true" or "false"; got "${raw}".`);
}

/** Venus Core Comptroller on BNB Chain 56 — pinned, never configurable. */
export const VENUS_CORE_COMPTROLLER_56 = getAddress(
  "0xfd36e2c2a6789db23113685031d7f16329158384",
);

/**
 * The Venus addresses the guard pins at boot.
 *
 * vBNB is here rather than derived from a `symbol()` string because the choice
 * between `repayBorrow()` payable and `approve` + `repayBorrow(uint256)` is a
 * MONEY DECISION ABOUT CALLDATA, and the trust boundary this phase inherits
 * says a cached snapshot is never authorization to move funds (R2.15/R15). Boot
 * validates the pinned address against the chain; every other market's
 * underlying comes from the plane's own `underlying()` read.
 */
export type VenusVenueConfig = {
  readonly comptroller: Address;
  readonly vBnb: Address;
  readonly prime: Address;
  readonly treasury: Address;
};

/** Worker cadence floor. Below this the read budget cannot be met (R3.10). */
export const VENUS_WORKER_MIN_INTERVAL_MS = 15_000;
export const VENUS_WORKER_DEFAULT_INTERVAL_MS = 30_000;

/**
 * `VENUS_WORKER_INTERVAL_MS`, with a BOOT-REFUSED floor of 15 000 (R3.10).
 *
 * REFUSED rather than clamped, unlike `LP_WORKER_INTERVAL_SEC`: an operator who
 * asked for a 5-second Venus cycle asked for something the per-agent read
 * budget cannot serve (~25-45 RPC reads per agent per cycle), and silently
 * running four times slower than requested is how a latency budget becomes
 * fiction. The default is 30 000, which R2.14's worked budget is built on:
 * breach -> first observation <= interval + finalized lag (~2.25 s); second
 * observation >= one interval later; submit and inclusion seconds more, so the
 * FLOOR from breach to landed rescue is about 2 x interval + ~10 s ~= 70 s.
 */
export function resolveVenusWorkerIntervalMs(env: TradeEnv): number {
  const raw = read(env, "VENUS_WORKER_INTERVAL_MS");
  if (raw === "") return VENUS_WORKER_DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "VENUS_WORKER_INTERVAL_MS must be a positive integer number of milliseconds.",
    );
  }
  if (parsed < VENUS_WORKER_MIN_INTERVAL_MS) {
    throw new Error(
      `VENUS_WORKER_INTERVAL_MS (${parsed}) is below the floor of ` +
        `${VENUS_WORKER_MIN_INTERVAL_MS} ms. A Venus cycle costs roughly 25-45 RPC reads ` +
        "per agent; a shorter interval cannot be served, and running slower than " +
        "requested would make the guard's stated latency budget fiction.",
    );
  }
  return parsed;
}

/**
 * `VENUS_MAX_OBSERVATION_AGE_MS`, validated at BOOT and REFUSED below
 * `2 x interval` (R2.6).
 *
 * The floor is structural rather than stylistic: a bound below two intervals
 * makes it impossible for a previous observation to satisfy BOTH "at least one
 * interval old" and "within the bound" on any cycle that ran even slightly
 * late, so the second confirmation could never be reached and the guard would
 * look armed while being unable to fire — (ae)'s shape with a config key
 * instead of a `Map`.
 */
export function resolveVenusMaxObservationAgeMs(
  env: TradeEnv,
  intervalMs: number,
): number {
  const raw = read(env, "VENUS_MAX_OBSERVATION_AGE_MS");
  if (raw === "") return 3 * intervalMs;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "VENUS_MAX_OBSERVATION_AGE_MS must be a positive integer number of milliseconds.",
    );
  }
  if (parsed < 2 * intervalMs) {
    throw new Error(
      `VENUS_MAX_OBSERVATION_AGE_MS (${parsed}) is below 2 x the worker interval ` +
        `(${2 * intervalMs}); below that bound a second confirmation is structurally ` +
        "unreachable and the guard would look armed while being unable to fire.",
    );
  }
  return parsed;
}

/** Per-cycle agent concurrency and the global RPC semaphore width (R3.10). */
export const VENUS_AGENT_CONCURRENCY = 4;
export const VENUS_RPC_CONCURRENCY = 12;

function requireVenusAddress(env: TradeEnv, name: string): Address {
  const raw = read(env, name);
  if (raw === "") {
    throw new Error(`${name} is required when VENUS_ENABLED is "true".`);
  }
  if (!isAddress(raw, { strict: false })) {
    throw new Error(`${name} must be a 20-byte hex address; got "${raw}".`);
  }
  return getAddress(raw);
}

/**
 * Resolve the Venus venue. Only ever called when {@link resolveVenusEnabled}
 * answered true, so a malformed Venus variable on a deployment that never
 * enabled the guard costs nothing.
 *
 * `VENUS_TREASURY_ADDRESS` falls back to `FEE_TREASURY_ADDRESS`: Venus v1 is
 * FEE-FREE and the treasury is granted only so a later fee can be a config
 * change rather than a re-grant (R2.15/R17), so requiring a second address for
 * a role nothing uses would be ceremony.
 */
export function resolveVenusVenue(env: TradeEnv): VenusVenueConfig {
  const treasuryRaw = read(env, "VENUS_TREASURY_ADDRESS");
  const treasury =
    treasuryRaw === ""
      ? requireVenusAddress(env, "FEE_TREASURY_ADDRESS")
      : requireVenusAddress(env, "VENUS_TREASURY_ADDRESS");
  return {
    comptroller: VENUS_CORE_COMPTROLLER_56,
    vBnb: requireVenusAddress(env, "VENUS_VBNB_ADDRESS"),
    prime: requireVenusAddress(env, "VENUS_PRIME_ADDRESS"),
    treasury,
  };
}

export type VenusRuntimeConfig = {
  readonly venue: VenusVenueConfig;
  readonly intervalMs: number;
  readonly maxObservationAgeMs: number;
  readonly agentConcurrency: number;
  readonly rpcConcurrency: number;
};

export function resolveVenusRuntimeConfig(env: TradeEnv): VenusRuntimeConfig {
  const intervalMs = resolveVenusWorkerIntervalMs(env);
  return {
    venue: resolveVenusVenue(env),
    intervalMs,
    maxObservationAgeMs: resolveVenusMaxObservationAgeMs(env, intervalMs),
    agentConcurrency: VENUS_AGENT_CONCURRENCY,
    rpcConcurrency: VENUS_RPC_CONCURRENCY,
  };
}

/* -------------------------------------------------------------------------- */
/* The lending guard (MARKETPLACE-LENDING-AGENT §8.5, R2.19, R3.8)            */
/* -------------------------------------------------------------------------- */

/**
 * `LENDING_ENABLED`, the lending surface's master switch — the SAME tri-state
 * shape as {@link resolveLpEnabled}, byte for byte, and for the same reason:
 * OFF by default (deps absent ⇒ every `/lending/*` path answers the 404 an
 * unknown path gets, the worker refuses to start), ON only for the exact string
 * `"true"`, and a TYPO FAILS THE BOOT.
 *
 * TWO dependencies, both thrown HERE rather than at four composition sites, so
 * the server boot, the wiring, the worker and the dev stack all get the same
 * refusal without four copies of the conditional:
 *
 *   - **`LP_ENABLED`** (R2.19): the router, WBNB and the QuoterV2 the arm,
 *     the rescues and the retire all swap through come from the LP venue. The
 *     coupling is not new — `HIRE_ENABLED` already implies it transitively —
 *     but stating it means a deployment cannot end up with a guard whose swap
 *     legs have no venue to build against.
 *   - **`HIRE_ENABLED`**: the guard has no other way to exist. Its only entry
 *     is the `lending-v1` hire preset, which is part of the browser hire flow.
 */
export function resolveLendingEnabled(env: TradeEnv): boolean {
  const raw = read(env, "LENDING_ENABLED");
  const enabled =
    raw === "" ? false : raw === "true" ? true : raw === "false" ? false : null;
  if (enabled === null) {
    throw new Error(`LENDING_ENABLED must be exactly "true" or "false"; got "${raw}".`);
  }
  if (!enabled) return false;
  if (!resolveLpEnabled(env)) {
    throw new Error(
      'LENDING_ENABLED is "true" while LP_ENABLED is not: every lending swap leg — the arm, the pool-cash fallback, the BNB rescue and the retire — is built against the LP venue\'s router, WBNB and QuoterV2. Enabling it alone would produce a healthy-looking server whose money routes cannot build calldata.',
    );
  }
  if (!resolveHireEnabled(env)) {
    throw new Error(
      'LENDING_ENABLED is "true" while HIRE_ENABLED is not: the guard\'s only entry is the lending-v1 hire preset, so nothing could ever be armed.',
    );
  }
  return true;
}

/** Worker cadence floor. Below this the per-agent read budget cannot be met. */
export const LENDING_WORKER_MIN_INTERVAL_MS = 15_000;
export const LENDING_WORKER_DEFAULT_INTERVAL_MS = 30_000;

/**
 * `LENDING_WORKER_INTERVAL_MS`, with a BOOT-REFUSED floor of 15 000.
 *
 * REFUSED rather than clamped, exactly as {@link resolveVenusWorkerIntervalMs}
 * is: an operator who asked for a 5-second cycle asked for something the
 * per-agent read budget cannot serve (A's bounded market set plus B's reserve
 * plus a quote), and silently running four times slower than requested is how a
 * latency budget becomes fiction.
 */
export function resolveLendingWorkerIntervalMs(env: TradeEnv): number {
  const raw = read(env, "LENDING_WORKER_INTERVAL_MS");
  if (raw === "") return LENDING_WORKER_DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "LENDING_WORKER_INTERVAL_MS must be a positive integer number of milliseconds.",
    );
  }
  if (parsed < LENDING_WORKER_MIN_INTERVAL_MS) {
    throw new Error(
      `LENDING_WORKER_INTERVAL_MS (${parsed}) is below the floor of ${LENDING_WORKER_MIN_INTERVAL_MS} ms. ` +
        "A lending cycle reads A's bounded market set, B's reserve and at least one quote; a shorter " +
        "interval cannot be served, and running slower than requested would make the guard's stated " +
        "latency budget fiction.",
    );
  }
  return parsed;
}

/**
 * `LENDING_MAX_OBSERVATION_AGE_MS`, REFUSED below `2 x interval`.
 *
 * The floor is structural, not stylistic, and it is Phase 4's: below two
 * intervals a previous observation can never satisfy BOTH "at least one
 * interval old" and "within the bound" on a cycle that ran even slightly late,
 * so the second confirmation would be unreachable and the guard would look
 * armed while being unable to fire.
 */
export function resolveLendingMaxObservationAgeMs(
  env: TradeEnv,
  intervalMs: number,
): number {
  const raw = read(env, "LENDING_MAX_OBSERVATION_AGE_MS");
  if (raw === "") return 3 * intervalMs;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "LENDING_MAX_OBSERVATION_AGE_MS must be a positive integer number of milliseconds.",
    );
  }
  if (parsed < 2 * intervalMs) {
    throw new Error(
      `LENDING_MAX_OBSERVATION_AGE_MS (${parsed}) is below 2 x the worker interval (${2 * intervalMs}); ` +
        "below that bound a second confirmation is structurally unreachable.",
    );
  }
  return parsed;
}

/** The V3 fee tiers a WBNB/USDT pool can exist at. */
const LENDING_SWAP_FEE_TIERS: readonly number[] = [100, 500, 2_500, 10_000];

/**
 * `LENDING_SWAP_FEE_TIER` — the PINNED WBNB/USDT pool (R2.19, closing M13).
 *
 * Boot config rather than a signed field, and L12 states the consequence
 * plainly: the owner signs an arm whose pool the operator can change between
 * the preview quote and the arm. The arm therefore RE-DERIVES `mintUsdtWei`
 * from the boot tier at arm time and DISCLOSES a tier change on its response,
 * so the number the owner was shown and the number that was used are never
 * silently different.
 *
 * Default 100. Verified 2026-09-06 at block 120338032: fee 100 ->
 * `0x172fcd41e0913e95784454622d1c3724f546f849` (liquidity 3.234e24), fee 500 ->
 * `0x36696169c63e42cd08ce11f5deebbcebae652050` (2.986e24), both `token0 = USDT`.
 * Boot additionally proves the pool exists WITH NON-ZERO LIQUIDITY, because a
 * pinned tier whose pool is empty makes every swap leg unfillable.
 */
export function resolveLendingSwapFeeTier(env: TradeEnv): 100 | 500 | 2500 | 10000 {
  const raw = read(env, "LENDING_SWAP_FEE_TIER");
  if (raw === "") return 100;
  const parsed = Number(raw);
  if (!LENDING_SWAP_FEE_TIERS.includes(parsed)) {
    throw new Error(
      `LENDING_SWAP_FEE_TIER must be one of ${LENDING_SWAP_FEE_TIERS.join(", ")}; got "${raw}".`,
    );
  }
  return parsed as 100 | 500 | 2500 | 10000;
}

export type LendingVenueConfig = {
  readonly vUsdt: Address;
  readonly vBnb: Address;
  readonly treasury: Address;
  readonly swapFeeTier: 100 | 500 | 2500 | 10000;
};

function requireLendingAddress(env: TradeEnv, name: string): Address {
  const raw = read(env, name);
  if (raw === "") {
    // Not "when LENDING_ENABLED is true": the read-only probes
    // (`live-lending census|preview|guardable`) resolve this config with the
    // guard OFF, on purpose, so an operator can check a deployment before
    // enabling it. Naming the flag here sent them looking at the wrong line.
    throw new Error(
      `${name} is unset. The lending venue is pinned by address, not discovered: `
      + "the boot validates it against the chain, and the read-only probes need it too.",
    );
  }
  if (!isAddress(raw, { strict: false })) {
    throw new Error(`${name} must be a 20-byte hex address; got "${raw}".`);
  }
  return getAddress(raw);
}

/**
 * Resolve the lending venue. Only ever called when
 * {@link resolveLendingEnabled} answered true.
 *
 * `LENDING_TREASURY_ADDRESS` falls back to `FEE_TREASURY_ADDRESS`, and vBNB is
 * shared with the Venus guard's `VENUS_VBNB_ADDRESS` — one pinned address for
 * the one native market, so the two surfaces cannot disagree about which
 * contract vBNB is. USDT is NOT configured: it is derived at boot from
 * `vUSDT.underlying()`, and `parseLendingHireParams`'s `token` is compared
 * against the derived value.
 */
export function resolveLendingVenue(env: TradeEnv): LendingVenueConfig {
  const treasuryRaw = read(env, "LENDING_TREASURY_ADDRESS");
  return {
    vUsdt: requireLendingAddress(env, "LENDING_VUSDT_ADDRESS"),
    vBnb: requireLendingAddress(env, "VENUS_VBNB_ADDRESS"),
    treasury:
      treasuryRaw === ""
        ? requireLendingAddress(env, "FEE_TREASURY_ADDRESS")
        : requireLendingAddress(env, "LENDING_TREASURY_ADDRESS"),
    swapFeeTier: resolveLendingSwapFeeTier(env),
  };
}

/**
 * The RPC fallback chain, most specific first.
 *
 * A lending deployment normally shares the Venus or LP endpoint; naming its own
 * is for the case where the guard's read volume justifies a separate provider.
 */
export function resolveLendingRpcUrls(
  env: TradeEnv,
  publicRpcUrl: string,
): readonly string[] {
  const override = (
    read(env, "LENDING_RPC_URL")
    || read(env, "VENUS_RPC_URL")
    || read(env, "LP_RPC_URL")
  ).trim();
  return [
    ...new Set([...(override === "" ? [] : [override]), publicRpcUrl].filter((url) => url.length > 0)),
  ];
}

/** Per-cycle agent concurrency for the lending worker. */
export const LENDING_AGENT_CONCURRENCY = 4;

export type LendingRuntimeConfig = {
  readonly venue: LendingVenueConfig;
  readonly intervalMs: number;
  readonly maxObservationAgeMs: number;
  readonly agentConcurrency: number;
};

export function resolveLendingRuntimeConfig(env: TradeEnv): LendingRuntimeConfig {
  const intervalMs = resolveLendingWorkerIntervalMs(env);
  return {
    venue: resolveLendingVenue(env),
    intervalMs,
    maxObservationAgeMs: resolveLendingMaxObservationAgeMs(env, intervalMs),
    agentConcurrency: LENDING_AGENT_CONCURRENCY,
  };
}
