/** Fail-closed switches and exact TermiX configuration profile codecs. */
import { getAddress, isAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { rebalanceCanonicalEncode } from "./rebalanceCanonical.js";
import { PRODUCTION_EXPANDED_CONFIG_PROFILE, PRODUCTION_REBALANCE_CAPABILITY_PROFILE } from "./rebalanceProductionProfiles.js";
import type { QuantConfigBlock, QuantVenueAllowlistRow } from "./termix.js";

export type QuantExpandedConfigProjection = {
  readonly chainId: number;
  readonly u: Address;
  readonly uDecimals: number;
  readonly tradableTokens: readonly { readonly address: Address; readonly decimals: number; readonly priceRoute: string }[];
  readonly venueRows: readonly QuantVenueAllowlistRow[];
};

export type QuantExpandedConfigProfile = {
  readonly id: string;
  readonly capturedEvidenceRef: string;
  readonly capturedEvidenceDigest: Hex;
  readonly expected: QuantExpandedConfigProjection;
  readonly expectedVenueRowCount: number;
  readonly expectedUniqueVenueTargetCount: number;
};

export type QuantRebalanceCapabilityProfile = {
  readonly id: string;
  readonly capturedConfigProfileId: string;
  readonly wireVersion: string;
  readonly grantShapes: readonly ("selector-scoped" | "whole-contract")[];
  readonly toleratedGrantTargets: readonly Address[];
  readonly duplicateWholeGrantTargets: readonly Address[];
  readonly executionRoutes: readonly string[];
  readonly referenceRoutes: readonly string[];
  /**
   * The relay-billed gas-equivalent of one exit (`paymentMax / gasPrice`), not on-chain `gasUsed`.
   * This is what the native reserve must cover; the reserve arithmetic pads it once more.
   */
  readonly maximumExitGasUnits: bigint;
  readonly indexingEvidenceDigest: Hex;
  readonly reportEvidenceDigest: Hex;
};

export type QuantRebalanceRuntimeConfig = {
  readonly chainId: 56;
  readonly databaseUrl: string;
  readonly envelopeKey: string;
  readonly apiKey: string;
  readonly agentId: string;
  readonly strategyId: string;
  readonly apiBaseUrl: string;
  readonly rpcUrls: readonly string[];
  readonly intervalMs: number;
};

/** The reviewed production profiles (G1). File and rehearsal profiles never enter these arrays. */
export const QUANT_EXPANDED_CONFIG_PROFILES: readonly QuantExpandedConfigProfile[] = Object.freeze([PRODUCTION_EXPANDED_CONFIG_PROFILE]);
export const QUANT_REBALANCE_CAPABILITY_PROFILES: readonly QuantRebalanceCapabilityProfile[] = Object.freeze([PRODUCTION_REBALANCE_CAPABILITY_PROFILE]);

export type QuantExpandedProjectionResult =
  | { readonly ok: true; readonly projection: QuantExpandedConfigProjection }
  | { readonly ok: false; readonly code: "platform-config-invalid" };

export function normalizeExpandedQuantConfig(value: QuantConfigBlock): QuantExpandedProjectionResult {
  try {
    if (!Number.isSafeInteger(value.chainId) || value.chainId <= 0
      || !isAddress(value.u, { strict: false }) || !Number.isSafeInteger(value.uDecimals)
      || value.uDecimals < 0 || !Array.isArray(value.tradableTokens) || value.tradableTokens.length < 2
      || !Array.isArray(value.venueRows)) return { ok: false, code: "platform-config-invalid" };
    const tokens = value.tradableTokens.map((row) => {
      if (row === null || typeof row !== "object" || !isAddress(row.address, { strict: false })
        || !Number.isSafeInteger(row.decimals) || row.decimals < 0
        || typeof row.priceRoute !== "string" || row.priceRoute.length === 0) throw new Error("invalid");
      return { address: getAddress(row.address).toLowerCase() as Address, decimals: row.decimals, priceRoute: row.priceRoute };
    }).sort((a, b) => a.address.localeCompare(b.address));
    if (new Set(tokens.map((row) => row.address)).size !== tokens.length) throw new Error("duplicate-token");
    const expectedKeys = ["address", "auditUrl", "kind", "label", "officialUrl", "protocol", "verified"];
    const venues = value.venueRows.map((raw) => {
      if (raw === null || typeof raw !== "object" || Object.keys(raw).sort().join("|") !== expectedKeys.join("|")) throw new Error("invalid-venue-row-shape");
      const row = raw as QuantVenueAllowlistRow;
      if (typeof row.label !== "string" || row.label.trim() === "" || typeof row.kind !== "string" || row.kind.trim() === ""
        || !isAddress(row.address, { strict: false }) || !(row.protocol === null || typeof row.protocol === "string")
        || typeof row.verified !== "boolean" || !(row.auditUrl === null || typeof row.auditUrl === "string")
        || !(row.officialUrl === null || typeof row.officialUrl === "string")) throw new Error("invalid-venue-row-field");
      return { ...row, address: getAddress(row.address).toLowerCase() as Address };
    }).sort((a, b) => rebalanceCanonicalEncode(a).localeCompare(rebalanceCanonicalEncode(b)));
    return {
      ok: true,
      projection: {
        chainId: value.chainId, u: getAddress(value.u).toLowerCase() as Address,
        uDecimals: value.uDecimals, tradableTokens: tokens, venueRows: venues,
      },
    };
  } catch {
    return { ok: false, code: "platform-config-invalid" };
  }
}

export function quantExpandedConfigDigest(projection: QuantExpandedConfigProjection): Hex {
  return keccak256(stringToBytes(rebalanceCanonicalEncode(projection)));
}

export function findExpandedConfigProfile(
  projection: QuantExpandedConfigProjection,
  profiles: readonly QuantExpandedConfigProfile[] = QUANT_EXPANDED_CONFIG_PROFILES,
): QuantExpandedConfigProfile | null {
  const canonical = rebalanceCanonicalEncode(projection);
  for (const profile of profiles) {
    const expected = normalizeExpandedQuantConfig({ ...profile.expected, venueAllowlist: [] } as unknown as QuantConfigBlock);
    if (!expected.ok || !Array.isArray(profile.expected.venueRows)) continue;
    const uniqueTargets = new Set(expected.projection.venueRows.map((row) => row.address.toLowerCase()));
    if (profile.expectedVenueRowCount !== expected.projection.venueRows.length
      || profile.expectedUniqueVenueTargetCount !== uniqueTargets.size
      || rebalanceCanonicalEncode(expected.projection) !== canonical) continue;
    if (!/^0x[0-9a-fA-F]{64}$/u.test(profile.capturedEvidenceDigest)
      || profile.id.trim() === "" || profile.capturedEvidenceRef.trim() === "") continue;
    return profile;
  }
  return null;
}

/** Return on-chain targets only after the complete raw-row profile has matched. */
export function expandedConfigVenueTargets(
  projection: QuantExpandedConfigProjection,
  profile: QuantExpandedConfigProfile,
): readonly Address[] | null {
  if (findExpandedConfigProfile(projection, [profile]) === null) return null;
  return [...new Set(projection.venueRows.map((row) => row.address.toLowerCase() as Address))].sort();
}

export function resolveQuantRebalancingEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env["QUANT_REBALANCING_ENABLED"];
  if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error("QUANT_REBALANCING_ENABLED must be exactly true or false.");
}

export function resolveQuantRebalanceRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
  input: { readonly publicRpcUrl: string },
): QuantRebalanceRuntimeConfig {
  if (!resolveQuantRebalancingEnabled(env)) throw new Error("QUANT_REBALANCING_ENABLED is off.");
  if (env["EXECUTION_NETWORK"] !== "mainnet") throw new Error("quant-rebalance requires EXECUTION_NETWORK=mainnet.");
  const envelopeKey = env["QUANT_ENVELOPE_KEY"]?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/u.test(envelopeKey)) throw new Error("QUANT_ENVELOPE_KEY must be a 32-byte hex key.");
  const databaseUrl = env["DATABASE_URL"]?.trim() ?? "";
  const apiKey = env["QUANT_API_KEY"]?.trim() ?? "";
  const agentId = env["QUANT_AGENT_ID"]?.trim() ?? "";
  const strategyId = env["QUANT_REBALANCE_STRATEGY_ID"]?.trim() ?? "";
  if (databaseUrl === "" || apiKey === "" || agentId === "" || strategyId === "") {
    throw new Error("Quant rebalancing requires DATABASE_URL, QUANT_API_KEY, QUANT_AGENT_ID and QUANT_REBALANCE_STRATEGY_ID.");
  }
  if (strategyId === "self-test" || strategyId === (env["QUANT_STRATEGY_ID"] ?? "")) {
    throw new Error("Quant rebalancing requires a distinct strategy id.");
  }
  const rawOrigin = env["QUANT_API_BASE_URL"]?.trim() || "https://platform-backend.prod.termix.live";
  let apiBaseUrl: string;
  try {
    const url = new URL(rawOrigin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== ""
      || url.username !== "" || url.password !== ""
      || url.origin !== "https://platform-backend.prod.termix.live") throw new Error("origin");
    apiBaseUrl = url.origin;
  } catch { throw new Error("QUANT_API_BASE_URL is not an allowed HTTPS origin."); }
  const rpcUrls = [...new Set([env["QUANT_RPC_URL"]?.trim() ?? "", input.publicRpcUrl].filter(Boolean))];
  if (rpcUrls.length === 0 || rpcUrls.some((url) => !url.startsWith("https://"))) throw new Error("Quant rebalancing requires HTTPS BNB RPC URLs.");
  const intervalText = env["QUANT_WORKER_INTERVAL_MS"]?.trim() ?? "60000";
  if (!/^[0-9]+$/u.test(intervalText)) throw new Error("QUANT_WORKER_INTERVAL_MS must be an integer.");
  const intervalMs = Number(intervalText);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 30_000 || intervalMs > 600_000) throw new Error("QUANT_WORKER_INTERVAL_MS is outside the supported range.");
  return { chainId: 56, databaseUrl, envelopeKey, apiKey, agentId, strategyId, apiBaseUrl, rpcUrls, intervalMs };
}

export function findCapabilityProfile(
  profileId: string,
  profiles: readonly QuantRebalanceCapabilityProfile[] = QUANT_REBALANCE_CAPABILITY_PROFILES,
): QuantRebalanceCapabilityProfile | null {
  return profiles.find((profile) => profile.id === profileId) ?? null;
}

/* G1 production guard (G2 R2.7): file evidence, sentinels and reserved ids never enter the
 * production registries, so a rehearsal tier or budget can never be selected by production. */

function productionDigest(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/u.test(value) && !/^0x0{64}$/u.test(value);
}
/** These prefixes cover g2-file-direct-wbnb-v1, quant-rebalance-g2-high75-finite-v2 and g2-file-capture-bf3d32b1-v1. */
function reservedFileProfileId(id: string): boolean {
  return id.trim() === "" || id.startsWith("g2-") || id.startsWith("quant-rebalance-g2-");
}

/** Every entry of both registries, membership excepted. Runs at module load and before any daemon effect. */
export function assertProductionRebalanceRegistries(
  configs: readonly QuantExpandedConfigProfile[],
  capabilities: readonly QuantRebalanceCapabilityProfile[],
): void {
  const configIds = new Set<string>();
  for (const config of configs) {
    if (!productionDigest(config.capturedEvidenceDigest)) throw new Error("production-profile-digest-invalid");
    if (reservedFileProfileId(config.id)) throw new Error("production-profile-id-reserved");
    if (configIds.has(config.id)) throw new Error("production-profile-id-duplicate");
    configIds.add(config.id);
  }
  const capabilityIds = new Set<string>();
  for (const capability of capabilities) {
    if (!productionDigest(capability.indexingEvidenceDigest) || !productionDigest(capability.reportEvidenceDigest)) {
      throw new Error("production-profile-digest-invalid");
    }
    if (reservedFileProfileId(capability.id)) throw new Error("production-profile-id-reserved");
    if (capabilityIds.has(capability.id)) throw new Error("production-profile-id-duplicate");
    capabilityIds.add(capability.id);
    if (capability.wireVersion !== "quant-job-v1") throw new Error("production-profile-wire-invalid");
    if (!configIds.has(capability.capturedConfigProfileId)) throw new Error("production-profile-config-mismatch");
    if (capability.executionRoutes.length === 0 || capability.referenceRoutes.length === 0
      || capability.maximumExitGasUnits <= 0n) throw new Error("production-profile-routes-invalid");
  }
}

/** The pair a production boot or composition may use: valid, matching, and reference-equal to registry entries. */
export function assertProductionRebalanceProfiles(
  config: QuantExpandedConfigProfile,
  capability: QuantRebalanceCapabilityProfile,
): void {
  assertProductionRebalanceRegistries([config], [capability]);
  if (!QUANT_EXPANDED_CONFIG_PROFILES.includes(config) || !QUANT_REBALANCE_CAPABILITY_PROFILES.includes(capability)) {
    throw new Error("production-profile-not-registered");
  }
}

assertProductionRebalanceRegistries(QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES);
