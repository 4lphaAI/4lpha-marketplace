/**
 * Boot-time resolution of the quant runtime (QUANT-GRID §7.1, R2.8, R2.11, R3.6).
 *
 * Pure: environment in, a validated config out, an exception on anything
 * wrong. A malformed value fails the BOOT, never a trade — the same discipline
 * `src/ops/config.ts` follows, for the same reason: a rule about money that is
 * only exercised by starting the process is a rule nobody tests.
 *
 * NOTHING here reads a secret's VALUE into a returned object except the two the
 * worker must actually use, and neither is ever logged or persisted.
 */
import { getAddress, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../ops/venues.js";
import { feeEst as gridFeeEst } from "./grid.js";

export type QuantEnv = Readonly<Record<string, string | undefined>>;

/* -------------------------------------------------------------------------- */
/* Pinned venue facts (spec §2.1, §4.3)                                       */
/* -------------------------------------------------------------------------- */

/**
 * The quant settlement token: Binance-Peg USDC, 18 decimals. Re-pinned
 * 2026-09-16 from United Stables (`0xcE24…6666`) after the production
 * worker's boot check caught TermiX's `quant.token` change (FINDINGS bn-6);
 * the self-test transport serves a stored block, so only production sees it.
 * The `u`/`U` names stay as the code's word for "the settlement token".
 */
export const QUANT_U_56: Address = getAddress(
  "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
);

/** The ONE V2 pair the whole strategy trades (USDC/WBNB), cross-checked at boot. */
export const QUANT_U_WBNB_PAIR_56: Address = getAddress(
  "0xd99c7f6c65857ac913a8f880a4cb84032ab2fc5b",
);

/** PancakeSwap V2 factory, for the `getPair` cross-check. */
export const PANCAKE_V2_FACTORY_56: Address = getAddress(
  "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
);

export const QUANT_ROUTER_56 = PANCAKE_V2_ROUTER_56;
export const QUANT_WBNB_56 = WBNB_56;

/**
 * The ONE origin `src/quant/termix.ts` may reach (R2.11).
 *
 * A one-entry allowlist, widened by SPEC REVISION only. Every request's FINAL
 * URL is checked against it and `fetch` runs with `redirect: "error"`, because
 * an allowlist that a 302 can leave is not one.
 */
export const QUANT_API_ORIGINS_ALLOWED: ReadonlySet<string> = new Set([
  "https://platform-backend.prod.termix.live",
]);

export const QUANT_API_BASE_URL_DEFAULT = "https://platform-backend.prod.termix.live";

/** Grace before a still-IN_PROGRESS action is cross-checked against the indexer. */
export const QUANT_UNKNOWN_GRACE_SEC = 900;

/** Below this the residual WBNB of a cycle is closed rather than sold (R6.3). */
export const QUANT_DUST_WEI = 1_000_000_000_000n;

/** Advisory-lock class id for the per-job fence. Two-argument form (R6.1 fence). */
export const QUANT_LOCK_CLASSID = 0x5155_414e; // "QUAN"

/** The worker-singleton role key namespace member. */
export const QUANT_SINGLETON_ROLE = "quant-worker" as const;

/* -------------------------------------------------------------------------- */
/* Strategy parameters (R2.8, R3.5)                                           */
/* -------------------------------------------------------------------------- */

export const QUANT_STRATEGY_VERSION = "grid-v2-quant:1" as const;

/** V2's per-leg fee, in bps. Two legs per cycle. */
export const V2_FEE_BPS = 25n;

export type QuantGridParams = {
  readonly strategyVersion: typeof QUANT_STRATEGY_VERSION;
  readonly seedMode: "none" | "symmetric";
  readonly seedWindowCycles: number;
  readonly bandBps: number;
  readonly maxLevels: number;
  readonly minClipUWei: bigint;
  readonly minNetEdgeBps: number;
  readonly entryTolBps: number;
  readonly exitTolBps: number;
  readonly maxImpactBps: number;
  readonly cooldownSec: number;
  readonly maxQuoteLagBlocks: number;
  readonly relayFeePerSubmitWei: bigint;
  /** Present only on R14 process/admitted params; absent in history. */
  readonly relayGasUnits?: bigint;
  /** Present only on R14 process/admitted params; absent in history. */
  readonly relayFeePadBps?: bigint;
  readonly recenterMode: "none" | "both";
  readonly recenterCooldownSec: number;
  readonly recenterBudgetDays: number;
  readonly minTermDays: number;
};

/** Process parameters. `bandBps` is deliberately absent: it is job-derived. */
export type QuantStrategyParams = Omit<QuantGridParams, "bandBps"> & {
  readonly bandTiers: string;
  readonly relayGasUnits: bigint;
  readonly relayFeePadBps: bigint;
};

/** A validated job projection, with the tier resolved from frozen allocation. */
export type QuantAdmittedParams = QuantStrategyParams & {
  readonly bandBps: number;
  readonly paramsSchema?: "r14";
};

/** Pre-R14 and built-B2 projections. These keep the historical fee model. */
export type QuantHistoricalParams = QuantGridParams;

export type QuantBandTier = {
  readonly minAllocationUWei: bigint;
  readonly bandBps: number;
};

/**
 * The defaults, as R8.3 records them for the operator to confirm or reverse.
 *
 * R14 keeps the process tier table separate from the admitted band. The
 * default remains a conservative buy-first table; the listed B2 process sets
 * `QUANT_BAND_TIERS_BPS=10:250,30:200` explicitly.
 */
export const QUANT_STRATEGY_DEFAULTS: QuantStrategyParams = Object.freeze({
  strategyVersion: QUANT_STRATEGY_VERSION,
  seedMode: "none",
  seedWindowCycles: 9,
  bandTiers: "10:700",
  maxLevels: 3,
  minClipUWei: 5n * 10n ** 18n,
  minNetEdgeBps: 25,
  entryTolBps: 40,
  exitTolBps: 10,
  maxImpactBps: 50,
  cooldownSec: 180,
  maxQuoteLagBlocks: 40,
  relayFeePerSubmitWei: 30_000_000_000_000n,
  relayGasUnits: 300_000n,
  relayFeePadBps: 15_000n,
  recenterMode: "none",
  recenterCooldownSec: 86_400,
  recenterBudgetDays: 1,
  minTermDays: 7,
});

function read(env: QuantEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

function readInt(
  env: QuantEnv,
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

function readWei(
  env: QuantEnv, name: string, fallback: bigint, min: bigint, max?: bigint,
): bigint {
  const raw = read(env, name);
  if (raw === "") return fallback;
  if (!/^[0-9]+$/u.test(raw)) {
    throw new Error(`${name} must be an integer number of wei.`);
  }
  const parsed = BigInt(raw);
  if (parsed < min) throw new Error(`${name} must be at least ${min} wei.`);
  if (max !== undefined && parsed > max) throw new Error(`${name} must be at most ${max} wei.`);
  return parsed;
}

function readBoundedBigInt(
  env: QuantEnv, name: string, fallback: bigint, min: bigint, max: bigint,
): bigint {
  const raw = read(env, name);
  if (raw === "") return fallback;
  if (!/^[0-9]+$/u.test(raw)) {
    throw new Error(`${name} must be a non-negative decimal integer.`);
  }
  const parsed = BigInt(raw);
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function canonicalDigits(raw: string): string {
  const stripped = raw.replace(/^0+(?=[0-9])/u, "");
  return stripped === "" ? "0" : stripped;
}

/** Parse and canonicalize the process tier table without reordering it. */
export function parseQuantBandTiers(rawValue: string): readonly QuantBandTier[] {
  const raw = rawValue.trim();
  const pieces = raw === "" ? [] : raw.split(",");
  if (pieces.length < 1 || pieces.length > 4) {
    throw new Error("QUANT_BAND_TIERS_BPS must contain between 1 and 4 entries.");
  }
  const tiers: QuantBandTier[] = [];
  let previousThreshold = 0n;
  let previousBand: number | null = null;
  for (const piece of pieces) {
    const match = /^\s*([0-9]+)\s*:\s*([0-9]+)\s*$/u.exec(piece);
    if (match === null) {
      throw new Error(
        "QUANT_BAND_TIERS_BPS entries must be whole-U threshold:integer-band pairs.",
      );
    }
    const threshold = BigInt(canonicalDigits(match[1]!));
    const bandBig = BigInt(canonicalDigits(match[2]!));
    if (threshold < 1n || threshold > 1_000_000n) {
      throw new Error(
        "QUANT_BAND_TIERS_BPS thresholds must be whole U integers between 1 and 1000000.",
      );
    }
    if (bandBig < 150n || bandBig > 2_000n) {
      throw new Error("QUANT_BAND_TIERS_BPS bands must be integers between 150 and 2000 bps.");
    }
    if (threshold <= previousThreshold) {
      throw new Error(
        "QUANT_BAND_TIERS_BPS thresholds must be strictly ascending; duplicates and reordered input are refused.",
      );
    }
    const band = Number(bandBig);
    if (previousBand !== null && band > previousBand) {
      throw new Error("QUANT_BAND_TIERS_BPS bands must be non-increasing with allocation.");
    }
    tiers.push({ minAllocationUWei: threshold * 10n ** 18n, bandBps: band });
    previousThreshold = threshold;
    previousBand = band;
  }
  return tiers;
}

export function canonicalQuantBandTiers(tiers: readonly QuantBandTier[]): string {
  return tiers.map((tier) =>
    `${(tier.minAllocationUWei / 10n ** 18n).toString(10)}:${tier.bandBps}`,
  ).join(",");
}

function fixedCostFloor(params: Pick<QuantStrategyParams, "entryTolBps" | "exitTolBps" | "minNetEdgeBps">): number {
  return Number(2n * V2_FEE_BPS) + params.entryTolBps + params.exitTolBps + params.minNetEdgeBps;
}

function validateBandTiers(
  tiers: readonly QuantBandTier[],
  params: Pick<QuantStrategyParams, "seedMode" | "minClipUWei" | "entryTolBps" | "exitTolBps" | "minNetEdgeBps">,
): void {
  const floor = fixedCostFloor(params);
  for (const tier of tiers) {
    if (tier.bandBps <= floor) {
      throw new Error(
        `QUANT_BAND_TIERS_BPS band ${tier.bandBps} must exceed the fixed cost floor of ${floor} bps.`,
      );
    }
  }
  const minimum = params.seedMode === "symmetric"
    ? 2n * params.minClipUWei : params.minClipUWei;
  const first = tiers[0]?.minAllocationUWei ?? 0n;
  if (first < minimum) {
    throw new Error(
      `QUANT_BAND_TIERS_BPS first threshold must be at least ${minimum / 10n ** 18n} U for ${params.seedMode}.`,
    );
  }
}

export function bandBpsForAllocation(
  params: Pick<QuantStrategyParams, "bandTiers">,
  allocationUWei: bigint,
): { readonly ok: true; readonly bandBps: number } | { readonly ok: false; readonly code: "below-minimum" } {
  const tiers = parseQuantBandTiers(params.bandTiers);
  if (allocationUWei < (tiers[0]?.minAllocationUWei ?? 0n)) {
    return { ok: false, code: "below-minimum" };
  }
  let selected = tiers[0]!.bandBps;
  for (const tier of tiers) {
    if (tier.minAllocationUWei > allocationUWei) break;
    selected = tier.bandBps;
  }
  return { ok: true, bandBps: selected };
}

export function admittedQuantParams(
  params: QuantStrategyParams,
  allocationUWei: bigint,
): QuantAdmittedParams | { readonly ok: false; readonly code: "below-minimum" } {
  const resolved = bandBpsForAllocation(params, allocationUWei);
  return resolved.ok ? { ...params, bandBps: resolved.bandBps } : resolved;
}

/** The live estimator; all callers must provide the gas value they observed. */
export function feeEstWei(
  params: Pick<QuantStrategyParams, "relayFeePerSubmitWei" | "relayGasUnits" | "relayFeePadBps">,
  gasPriceWei: bigint,
): bigint {
  return gridFeeEst(params, gasPriceWei);
}

function readChoice<T extends string>(
  env: QuantEnv,
  name: string,
  fallback: T,
  choices: readonly T[],
): T {
  const raw = read(env, name);
  if (raw === "") return fallback;
  if (!choices.includes(raw as T)) {
    throw new Error(`${name} must be one of ${choices.join(", ")}.`);
  }
  return raw as T;
}

export function resolveQuantStrategyParams(env: QuantEnv): QuantStrategyParams {
  const seedMode = readChoice(env, "QUANT_SEED_MODE", "none", ["none", "symmetric"] as const);
  const recenterMode = readChoice(
    env, "QUANT_RECENTER_MODE", "none", ["none", "both"] as const,
  );
  const maxLevels = readInt(
    env, "QUANT_MAX_LEVELS", QUANT_STRATEGY_DEFAULTS.maxLevels,
    seedMode === "symmetric" ? 2 : 1, seedMode === "symmetric" ? 3 : 5,
  );
  const minClipUWei = readWei(
    env, "QUANT_MIN_CLIP_U_WEI", QUANT_STRATEGY_DEFAULTS.minClipUWei,
    5n * 10n ** 18n,
  );
  const tiers = parseQuantBandTiers(
    read(env, "QUANT_BAND_TIERS_BPS") || QUANT_STRATEGY_DEFAULTS.bandTiers,
  );
  const params: QuantStrategyParams = {
    strategyVersion: QUANT_STRATEGY_VERSION,
    seedMode,
    seedWindowCycles: readInt(
      env, "QUANT_SEED_WINDOW_CYCLES", QUANT_STRATEGY_DEFAULTS.seedWindowCycles, 3, 30,
    ),
    bandTiers: canonicalQuantBandTiers(tiers),
    maxLevels,
    minClipUWei,
    minNetEdgeBps: readInt(
      env, "QUANT_MIN_NET_EDGE_BPS", QUANT_STRATEGY_DEFAULTS.minNetEdgeBps, 25, 500,
    ),
    entryTolBps: readInt(env, "QUANT_ENTRY_TOL_BPS", QUANT_STRATEGY_DEFAULTS.entryTolBps, 10, 300),
    exitTolBps: readInt(env, "QUANT_EXIT_TOL_BPS", QUANT_STRATEGY_DEFAULTS.exitTolBps, 10, 300),
    maxImpactBps: readInt(env, "QUANT_MAX_IMPACT_BPS", QUANT_STRATEGY_DEFAULTS.maxImpactBps, 5, 300),
    cooldownSec: readInt(env, "QUANT_COOLDOWN_SEC", QUANT_STRATEGY_DEFAULTS.cooldownSec, 60, 86_400),
    maxQuoteLagBlocks: readInt(
      env, "QUANT_MAX_QUOTE_LAG_BLOCKS", QUANT_STRATEGY_DEFAULTS.maxQuoteLagBlocks, 1, 200,
    ),
    relayFeePerSubmitWei: readWei(
      env, "QUANT_RELAY_FEE_PER_SUBMIT_WEI", QUANT_STRATEGY_DEFAULTS.relayFeePerSubmitWei,
      10_000_000_000_000n, 10_000_000_000_000_000n,
    ),
    relayGasUnits: readBoundedBigInt(
      env, "QUANT_RELAY_GAS_UNITS", QUANT_STRATEGY_DEFAULTS.relayGasUnits,
      200_000n, 1_000_000n,
    ),
    relayFeePadBps: readBoundedBigInt(
      env, "QUANT_RELAY_FEE_PAD_BPS", QUANT_STRATEGY_DEFAULTS.relayFeePadBps,
      10_000n, 30_000n,
    ),
    recenterMode,
    recenterCooldownSec: readInt(
      env, "QUANT_RECENTER_COOLDOWN_SEC", QUANT_STRATEGY_DEFAULTS.recenterCooldownSec,
      86_400, 604_800,
    ),
    recenterBudgetDays: readInt(
      env, "QUANT_RECENTER_BUDGET_DAYS", QUANT_STRATEGY_DEFAULTS.recenterBudgetDays, 1, 90,
    ),
    minTermDays: readInt(
      env, "QUANT_MIN_TERM_DAYS", QUANT_STRATEGY_DEFAULTS.minTermDays, 7, 90,
    ),
  };
  if (recenterMode === "both" && seedMode !== "symmetric") {
    throw new Error('QUANT_RECENTER_MODE="both" requires QUANT_SEED_MODE="symmetric".');
  }
  // A band that cannot cover its own two legs plus both tolerances plus the
  // required edge is uneconomic BY CONSTRUCTION, before any pool is read. The
  // per-job arm floor (R3.5) adds the gas and impact terms on top of this.
  validateBandTiers(tiers, params);
  return params;
}

/**
 * The canonical digest of the resolved parameters (R3.6).
 *
 * `QUANT_PARAMS_DIGEST` must equal it at boot. Changing any economic parameter
 * therefore requires a NEW digest AND a new listing/strategy version on
 * TermiX — the listing text states the numbers, and a process that quietly
 * disagrees with the listing is a process that mis-sells.
 */
export function quantParamsDigest(params: QuantStrategyParams): Hex {
  const canonical = JSON.stringify({
    strategyVersion: params.strategyVersion,
    seedMode: params.seedMode,
    seedWindowCycles: params.seedWindowCycles,
    bandTiers: params.bandTiers,
    maxLevels: params.maxLevels,
    minClipUWei: params.minClipUWei.toString(10),
    minNetEdgeBps: params.minNetEdgeBps,
    entryTolBps: params.entryTolBps,
    exitTolBps: params.exitTolBps,
    maxImpactBps: params.maxImpactBps,
    cooldownSec: params.cooldownSec,
    maxQuoteLagBlocks: params.maxQuoteLagBlocks,
    relayFeePerSubmitWei: params.relayFeePerSubmitWei.toString(10),
    relayGasUnits: params.relayGasUnits.toString(10),
    relayFeePadBps: params.relayFeePadBps.toString(10),
    recenterMode: params.recenterMode,
    recenterCooldownSec: params.recenterCooldownSec,
    recenterBudgetDays: params.recenterBudgetDays,
    minTermDays: params.minTermDays,
  });
  return keccak256(stringToHex(canonical));
}

/** Exact digest projection used by the built B2 scalar schema. */
export function b2ScalarParamsDigest(params: QuantGridParams): Hex {
  const canonical = JSON.stringify({
    strategyVersion: params.strategyVersion,
    seedMode: params.seedMode,
    seedWindowCycles: params.seedWindowCycles,
    bandBps: params.bandBps,
    maxLevels: params.maxLevels,
    minClipUWei: params.minClipUWei.toString(10),
    minNetEdgeBps: params.minNetEdgeBps,
    entryTolBps: params.entryTolBps,
    exitTolBps: params.exitTolBps,
    maxImpactBps: params.maxImpactBps,
    cooldownSec: params.cooldownSec,
    maxQuoteLagBlocks: params.maxQuoteLagBlocks,
    relayFeePerSubmitWei: params.relayFeePerSubmitWei.toString(10),
    recenterMode: params.recenterMode,
    recenterCooldownSec: params.recenterCooldownSec,
    recenterBudgetDays: params.recenterBudgetDays,
    minTermDays: params.minTermDays,
  });
  return keccak256(stringToHex(canonical));
}

/* -------------------------------------------------------------------------- */
/* The master switch                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `QUANT_ENABLED`, the tri-state, BYTE FOR BYTE the `resolveLpEnabled` shape:
 * absent ⇒ OFF, exactly `"true"` / `"false"`, anything else FAILS THE BOOT.
 *
 * NO dependency on `LP_ENABLED` or `HIRE_ENABLED` (unlike `GRID_ENABLED` and
 * `LENDING_ENABLED`): this worker shares no store, no route and no composition
 * site with either, so coupling them would be ceremony rather than a rule.
 */
export function resolveQuantEnabled(env: QuantEnv): boolean {
  const raw = read(env, "QUANT_ENABLED");
  if (raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`QUANT_ENABLED must be exactly "true" or "false"; got "${raw}".`);
}

export type QuantRuntimeConfig = {
  readonly chainId: 56;
  readonly databaseUrl: string;
  /** The HKDF seed. Presence-validated only; never echoed, never persisted. */
  readonly envelopeKey: string;
  /** The TermiX REST bearer. Never echoed. */
  readonly apiKey: string;
  /**
   * Gate-1 self-test fixture path (R2.10 / R3.7), or `null` in production.
   * Set ⇒ the transport is `FileQuantTransport`, `QUANT_API_KEY` must be
   * ABSENT and `QUANT_STRATEGY_ID` must be `self-test`; unset ⇒ the reverse.
   * The two modes never share a process.
   */
  readonly selfTestFile: string | null;
  readonly agentId: string;
  readonly strategyId: string;
  readonly apiBaseUrl: string;
  readonly intervalMs: number;
  readonly params: QuantStrategyParams;
  readonly paramsDigest: Hex;
  readonly router: Address;
  readonly u: Address;
  readonly wbnb: Address;
  readonly pair: Address;
  readonly factory: Address;
  readonly rpcUrls: readonly string[];
  /** `"wallet"` only — R3.14: Nash confirmed the client funds gas. */
  readonly gasModel: "wallet";
  readonly unknownGraceSec: number;
};

function requireEnv(env: QuantEnv, name: string): string {
  const value = read(env, name);
  if (value === "") throw new Error(`${name} is required when QUANT_ENABLED is true.`);
  return value;
}

function assertHttpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("QUANT_API_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("QUANT_API_BASE_URL must be https.");
  if (!QUANT_API_ORIGINS_ALLOWED.has(url.origin)) {
    throw new Error(
      `QUANT_API_BASE_URL origin ${url.origin} is not in the one-entry allowlist; `
      + "widening it is a spec revision, not a configuration change.",
    );
  }
  // The base is an ORIGIN. A path here would silently prefix every endpoint.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("QUANT_API_BASE_URL must be a bare origin with no path or query.");
  }
  return url.origin;
}

/**
 * Everything the worker needs, validated. Called ONLY when the flag is on —
 * the demo-mode lesson (`resolveDemoConfig` parsed every knob even when
 * disabled, so one stray value stopped an unrelated service booting).
 */
export function resolveQuantRuntimeConfig(
  env: QuantEnv,
  options: { readonly publicRpcUrl: string },
): QuantRuntimeConfig {
  if (read(env, "EXECUTION_NETWORK") !== "mainnet") {
    throw new Error("quant-worker requires EXECUTION_NETWORK=mainnet (chain 56 only).");
  }
  const seed = requireEnv(env, "QUANT_ENVELOPE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/u.test(seed)) {
    // The VALUE is never in the message. A boot error that echoes a seed is a
    // seed in a log aggregator.
    throw new Error("QUANT_ENVELOPE_KEY must be 0x followed by 64 hex characters.");
  }
  const params = resolveQuantStrategyParams(env);
  const digest = quantParamsDigest(params);
  const declared = read(env, "QUANT_PARAMS_DIGEST");
  if (declared === "") {
    throw new Error(
      `QUANT_PARAMS_DIGEST is required and must equal ${digest} for the resolved parameters.`,
    );
  }
  if (declared.toLowerCase() !== digest.toLowerCase()) {
    throw new Error(
      `params-digest-mismatch: QUANT_PARAMS_DIGEST is ${declared} but the resolved `
      + `parameters hash to ${digest}. Changing an economic parameter requires a new `
      + "digest AND a new strategy version on TermiX.",
    );
  }
  const gasModel = read(env, "QUANT_GAS_MODEL");
  if (gasModel !== "" && gasModel !== "wallet") {
    throw new Error(
      'QUANT_GAS_MODEL must be "wallet". TermiX confirmed on 2026-09-10 that clients '
      + 'fund task-wallet gas; "sponsored" was withdrawn (R3.14).',
    );
  }
  const rpcOverride = read(env, "QUANT_RPC_URL");
  const rpcUrls = [
    ...new Set([...(rpcOverride === "" ? [] : [rpcOverride]), options.publicRpcUrl]),
  ].filter((url) => url.length > 0);
  for (const url of rpcUrls) {
    if (!/^https:\/\//u.test(url)) {
      throw new Error("Every quant RPC URL must be https.");
    }
  }
  if (rpcUrls.length === 0) throw new Error("quant-worker requires at least one RPC URL.");
  const pairOverride = read(env, "QUANT_PAIR_ADDRESS");
  if (pairOverride !== "" && !isAddress(pairOverride)) {
    throw new Error("QUANT_PAIR_ADDRESS is not a valid checksummed address.");
  }
  // Self-test mode is EXCLUSIVE with production credentials (R2.10): a process
  // holding a TermiX bearer must never read a local fixture as if it were the
  // inbox, and a self-test job must never reach the production worker.
  const selfTestFile = read(env, "QUANT_SELF_TEST_FILE");
  const apiKey = read(env, "QUANT_API_KEY");
  const strategyId = requireEnv(env, "QUANT_STRATEGY_ID");
  if (selfTestFile !== "") {
    if (apiKey !== "") {
      throw new Error("QUANT_SELF_TEST_FILE and QUANT_API_KEY are mutually exclusive.");
    }
    if (strategyId !== "self-test") {
      throw new Error('QUANT_STRATEGY_ID must be "self-test" when QUANT_SELF_TEST_FILE is set.');
    }
  } else {
    if (apiKey === "") throw new Error("QUANT_API_KEY is required when QUANT_ENABLED is true.");
    if (strategyId === "self-test") {
      throw new Error('QUANT_STRATEGY_ID "self-test" is refused without QUANT_SELF_TEST_FILE.');
    }
  }
  return {
    chainId: 56,
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    envelopeKey: seed,
    apiKey,
    selfTestFile: selfTestFile === "" ? null : selfTestFile,
    agentId: requireEnv(env, "QUANT_AGENT_ID"),
    strategyId,
    apiBaseUrl: assertHttpsOrigin(
      read(env, "QUANT_API_BASE_URL") === ""
        ? QUANT_API_BASE_URL_DEFAULT
        : read(env, "QUANT_API_BASE_URL"),
    ),
    intervalMs: readInt(env, "QUANT_WORKER_INTERVAL_MS", 60_000, 30_000, 600_000),
    params,
    paramsDigest: digest,
    router: QUANT_ROUTER_56,
    u: QUANT_U_56,
    wbnb: QUANT_WBNB_56,
    pair: pairOverride === "" ? QUANT_U_WBNB_PAIR_56 : getAddress(pairOverride),
    factory: PANCAKE_V2_FACTORY_56,
    rpcUrls,
    gasModel: "wallet",
    unknownGraceSec: readInt(
      env, "QUANT_UNKNOWN_GRACE_SEC", QUANT_UNKNOWN_GRACE_SEC, 60, 86_400,
    ),
  };
}

/**
 * Every origin this worker may reach, enumerated from the RESOLVED config
 * (R2.11 / BC35, and pinned by a test that reads the configured values rather
 * than the constants).
 *
 * Three, and only three: the RPC endpoints, the Altana relay, and the TermiX
 * API. The relay URL is supplied by the caller from the SDK's network config
 * so this module stays SDK-free while the assertion still covers the transport
 * the SDK creates internally.
 */
export function quantEgressOrigins(
  config: QuantRuntimeConfig,
  relayUrl: string,
): readonly string[] {
  const origins = new Set<string>();
  for (const url of config.rpcUrls) origins.add(new URL(url).origin);
  origins.add(new URL(relayUrl).origin);
  origins.add(new URL(config.apiBaseUrl).origin);
  return [...origins].sort();
}
