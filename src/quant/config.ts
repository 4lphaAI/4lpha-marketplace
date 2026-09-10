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
import { RELAY_FEE_PER_EXIT_WEI } from "../ops/relayFee.js";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../ops/venues.js";

export type QuantEnv = Readonly<Record<string, string | undefined>>;

/* -------------------------------------------------------------------------- */
/* Pinned venue facts (spec §2.1, §4.3)                                       */
/* -------------------------------------------------------------------------- */

/** United Stables — Altana's $1 stable, 18 decimals. The quant settlement token. */
export const QUANT_U_56: Address = getAddress(
  "0xcE24439F2D9C6a2289F741120FE202248B666666",
);

/** The ONE V2 pair the whole strategy trades, cross-checked at boot. */
export const QUANT_U_WBNB_PAIR_56: Address = getAddress(
  "0x108752b2a22c731ede3edac2205c63ae553e221a",
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

export type QuantStrategyParams = {
  readonly strategyVersion: typeof QUANT_STRATEGY_VERSION;
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
};

/**
 * The defaults, as R8.3 records them for the operator to confirm or reverse.
 *
 * `bandBps` is 700 and not 300 because R3.5's arm floor uses the SAME 3× fee
 * pad the native reservation uses: at a 10 U clip the gas term alone is ~447
 * bps, and 50 + 50 + 50 + ~4 + 447 + 50 = 651. A 300 bps band was arithmetic
 * that did not survive its own review.
 */
export const QUANT_STRATEGY_DEFAULTS: QuantStrategyParams = Object.freeze({
  strategyVersion: QUANT_STRATEGY_VERSION,
  bandBps: 700,
  maxLevels: 3,
  minClipUWei: 10n * 10n ** 18n,
  minNetEdgeBps: 50,
  entryTolBps: 50,
  exitTolBps: 50,
  maxImpactBps: 50,
  cooldownSec: 180,
  maxQuoteLagBlocks: 40,
  relayFeePerSubmitWei: RELAY_FEE_PER_EXIT_WEI,
});

/**
 * The ONE fee constant every economic decision uses (R5.6).
 *
 * There is no "measured" fee anywhere in the decision path: native balance
 * deltas around a receipt are recorded as UNVERIFIED TELEMETRY and never read
 * back into a floor, a reservation or a budget. R4.4's measured-or-bound rule
 * is withdrawn, because a 3× pad in one place and a 1× estimate in another is
 * how an edge becomes a loss.
 */
export function feeEstWei(params: QuantStrategyParams): bigint {
  return 3n * params.relayFeePerSubmitWei;
}

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

function readWei(env: QuantEnv, name: string, fallback: bigint, min: bigint): bigint {
  const raw = read(env, name);
  if (raw === "") return fallback;
  if (!/^[0-9]+$/u.test(raw)) {
    throw new Error(`${name} must be an integer number of wei.`);
  }
  const parsed = BigInt(raw);
  if (parsed < min) throw new Error(`${name} must be at least ${min} wei.`);
  return parsed;
}

export function resolveQuantStrategyParams(env: QuantEnv): QuantStrategyParams {
  const params: QuantStrategyParams = {
    strategyVersion: QUANT_STRATEGY_VERSION,
    bandBps: readInt(env, "QUANT_BAND_BPS", QUANT_STRATEGY_DEFAULTS.bandBps, 150, 2_000),
    maxLevels: readInt(env, "QUANT_MAX_LEVELS", QUANT_STRATEGY_DEFAULTS.maxLevels, 1, 5),
    minClipUWei: readWei(
      env,
      "QUANT_MIN_CLIP_U_WEI",
      QUANT_STRATEGY_DEFAULTS.minClipUWei,
      10n * 10n ** 18n,
    ),
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
      env, "QUANT_RELAY_FEE_PER_SUBMIT_WEI", QUANT_STRATEGY_DEFAULTS.relayFeePerSubmitWei, 1n,
    ),
  };
  // A band that cannot cover its own two legs plus both tolerances plus the
  // required edge is uneconomic BY CONSTRUCTION, before any pool is read. The
  // per-job arm floor (R3.5) adds the gas and impact terms on top of this.
  const floor =
    2 * Number(V2_FEE_BPS) + params.entryTolBps + params.exitTolBps + params.minNetEdgeBps;
  if (params.bandBps <= floor) {
    throw new Error(
      `QUANT_BAND_BPS (${params.bandBps}) must exceed the fixed cost floor of ${floor} bps `
      + "(two V2 legs + entry tolerance + exit tolerance + the required net edge).",
    );
  }
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
