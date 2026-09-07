import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import type { BillingMode, BillingProviderMode } from "./types.js";

export const BILLING_THRESHOLD_USD_MICROS = 100_000n;
export const BILLING_RELAY_RESERVE_WEI = 100_000_000_000_000n;
export const MAX_BILLING_DAY_CAP_WEI = 100_000_000_000_000_000n;
export const MAX_BILLING_DAILY_USD_MICROS = 100_000_000n;
export const BILLING_QUOTE_LIFETIME_SEC = 60;
export const MIN_COLLECTION_PREPARE_LIFETIME_SEC = 30;
export const MIN_COLLECTION_SEND_LIFETIME_SEC = 10;
export const MAX_SEEN_OG_HISTORY_IDS = 10_000;

export type BillingEnv = Readonly<Record<string, string | undefined>>;

export type DisabledBillingConfig = Readonly<{
  mode: "off" | "report";
  x402: BillingProviderMode;
  og: BillingProviderMode;
  internalHost: string;
}>;

export type EnabledBillingConfig = Readonly<{
  mode: "on";
  x402: BillingProviderMode;
  og: BillingProviderMode;
  internalHost: "127.0.0.1" | "::1";
  internalPort: number;
  databaseUrl: string;
  executionMasterKeyPresent: true;
  collector: Address;
  collectorRuntimeBytecodeHash: Hex;
  treasury: Address;
  executionTicketKeyId: string;
  executionTicketPublicKey: string;
  bscRpcOrigins: readonly [string, string];
  baseRpcOrigins: readonly [string, string];
  arbitrumRpcOrigins: readonly [string, string];
  platformBaseUsdcCapAtomic: bigint;
  platformOgCapNeuron: bigint;
  x402PayerKeyId?: string;
  x402Authorizer?: Address;
  ogRouterPayerAccountId?: string;
  ogInferenceKeyId?: string;
  ogManagementKeyId?: string;
}>;

export type BillingRuntimeConfig = DisabledBillingConfig | EnabledBillingConfig;

function value(env: BillingEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

function mode(env: BillingEnv): BillingMode {
  const candidate = value(env, "BILLING_ENABLED") || "off";
  if (candidate !== "off" && candidate !== "report" && candidate !== "on") {
    throw new Error("BILLING_ENABLED must be exactly off, report, or on.");
  }
  return candidate;
}

function providerMode(env: BillingEnv, name: string): BillingProviderMode {
  const candidate = value(env, name) || "off";
  if (candidate !== "off" && candidate !== "on") {
    throw new Error(`${name} must be exactly off or on.`);
  }
  return candidate;
}

function required(env: BillingEnv, name: string): string {
  const candidate = value(env, name);
  if (candidate === "") throw new Error(`${name} is required when BILLING_ENABLED=on.`);
  return candidate;
}

function positiveAtomic(env: BillingEnv, name: string): bigint {
  const candidate = required(env, name);
  if (!/^[1-9][0-9]{0,77}$/.test(candidate)) {
    throw new Error(`${name} must be a positive canonical decimal integer.`);
  }
  return BigInt(candidate);
}

function internalPort(env: BillingEnv): number {
  const raw = required(env, "BILLING_INTERNAL_PORT");
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new Error("BILLING_INTERNAL_PORT must be an integer TCP port.");
  const parsed = Number(raw);
  if (parsed > 65_535) throw new Error("BILLING_INTERNAL_PORT must be an integer TCP port.");
  return parsed;
}

function address(env: BillingEnv, name: string): Address {
  const candidate = required(env, name);
  if (!isAddress(candidate, { strict: false })) {
    throw new Error(`${name} must be a valid EVM address.`);
  }
  const normalized = getAddress(candidate);
  if (normalized === zeroAddress) throw new Error(`${name} must not be the zero address.`);
  return normalized;
}

function bytes32(env: BillingEnv, name: string): Hex {
  const candidate = required(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/u.test(candidate)) throw new Error(`${name} must be a bytes32 hex value.`);
  return candidate.toLowerCase() as Hex;
}

function httpsOrigin(env: BillingEnv, name: string): string {
  const candidate = required(env, name);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS origin.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${name} must be an absolute HTTPS origin on the default port without credentials, path, query, or fragment.`);
  }
  return parsed.origin;
}

function distinctPair(env: BillingEnv, first: string, second: string): readonly [string, string] {
  const a = httpsOrigin(env, first);
  const b = httpsOrigin(env, second);
  if (a === b) throw new Error(`${first} and ${second} must be independent origins.`);
  return [a, b];
}

function distinctOgKeyIds(env: BillingEnv): Readonly<{
  inference: string;
  management: string;
}> {
  const inference = required(env, "BILLING_0G_INFERENCE_KEY_ID");
  const management = required(env, "BILLING_0G_MANAGEMENT_KEY_ID");
  if (inference === management) {
    throw new Error("0G inference and management credential key IDs must be distinct.");
  }
  return { inference, management };
}

/**
 * Resolve the Phase 5 boot gate without loading any signing material.
 *
 * OFF/report intentionally stop before secret/address/RPC resolution. That is
 * what keeps a default process from resolving a paid host or opening a key.
 */
export function resolveBillingConfig(env: BillingEnv): BillingRuntimeConfig {
  const resolvedMode = mode(env);
  const x402 = providerMode(env, "BILLING_X402_ENABLED");
  const og = providerMode(env, "BILLING_0G_ENABLED");
  const internalHost = value(env, "BILLING_INTERNAL_HOST") || "127.0.0.1";

  if (resolvedMode !== "on") return { mode: resolvedMode, x402, og, internalHost };
  if (internalHost !== "127.0.0.1" && internalHost !== "::1") {
    throw new Error("BILLING_INTERNAL_HOST must be loopback in Phase 5 v1.");
  }
  const enabledInternalHost: "127.0.0.1" | "::1" = internalHost;
  if (x402 === "off" && og === "off") {
    throw new Error("BILLING_ENABLED=on requires at least one paid provider gate.");
  }

  const collector = address(env, "BILLING_COLLECTOR_ADDRESS");
  const treasury = address(env, "BILLING_TREASURY_ADDRESS");
  if (collector === treasury) throw new Error("BillingCollector and treasury roles must be distinct.");

  const ogKeyIds = og === "on" ? distinctOgKeyIds(env) : undefined;

  const common = {
    mode: "on" as const,
    x402,
    og,
    internalHost: enabledInternalHost,
    internalPort: internalPort(env),
    databaseUrl: required(env, "DATABASE_URL"),
    executionMasterKeyPresent: required(env, "EXECUTION_MASTER_KEY").length > 0 as true,
    collector,
    collectorRuntimeBytecodeHash: bytes32(env, "BILLING_COLLECTOR_RUNTIME_CODEHASH"),
    treasury,
    executionTicketKeyId: required(env, "BILLING_TICKET_KEY_ID"),
    executionTicketPublicKey: required(env, "BILLING_TICKET_PUBLIC_KEY"),
    bscRpcOrigins: distinctPair(env, "BILLING_BSC_RPC_A", "BILLING_BSC_RPC_B"),
    baseRpcOrigins: distinctPair(env, "BILLING_BASE_RPC_A", "BILLING_BASE_RPC_B"),
    arbitrumRpcOrigins: distinctPair(env, "BILLING_ARBITRUM_RPC_A", "BILLING_ARBITRUM_RPC_B"),
    platformBaseUsdcCapAtomic: positiveAtomic(env, "BILLING_PLATFORM_BASE_USDC_CAP_ATOMIC"),
    platformOgCapNeuron: positiveAtomic(env, "BILLING_PLATFORM_0G_CAP_NEURON"),
  };

  return {
    ...common,
    ...(x402 === "on" ? {
      x402PayerKeyId: required(env, "BILLING_X402_PAYER_KEY_ID"),
      x402Authorizer: address(env, "BILLING_X402_AUTHORIZER"),
    } : {}),
    ...(ogKeyIds !== undefined
      ? {
          ogRouterPayerAccountId: required(env, "BILLING_0G_PAYER_ACCOUNT_ID"),
          ogInferenceKeyId: ogKeyIds.inference,
          ogManagementKeyId: ogKeyIds.management,
        }
      : {}),
  };
}
