import { getAddress, type Address, type Hex } from "viem";
import { CHAIN_ID, REGISTRY, fail, type IdentityBinding } from "./types.js";

export type IdentityConfig = IdentityBinding & { readonly databaseUrl: string; readonly rpcUrl: string; readonly maxGas: bigint; readonly maxPrice: bigint; readonly maxInstanceFee: bigint; readonly maxDailyFee: bigint; readonly exclusive: boolean };
export type IdentityEnv = Readonly<Record<string, string | undefined>>;
export function enabled(env: IdentityEnv): boolean {
  const value = env.ERC8004_IDENTITY_ENABLED;
  if (value === undefined || value === "false") return false;
  if (value !== "true") fail("invalid_config");
  return true;
}
export function positiveDecimal(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value)) fail("invalid_config");
  const result = BigInt(value);
  if (result >= 2n ** 256n) fail("invalid_config");
  return result;
}
export function databaseUrl(env: IdentityEnv): string {
  const value = env.DATABASE_URL;
  if (!value || value.length > 8192) fail("invalid_config");
  let url: URL;
  try { url = new URL(value); } catch { return fail("invalid_config"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) fail("invalid_config");
  return value;
}
export function resolveConfig(env: IdentityEnv): IdentityConfig {
  if (env.ERC8004_CHAIN_ID !== "56" || env.ERC8004_REGISTRY_ADDRESS?.toLowerCase() !== REGISTRY.toLowerCase()) fail("invalid_config");
  let minter: Address; let rpc: URL;
  try { minter = getAddress(env.ERC8004_MINTER_ADDRESS ?? ""); rpc = new URL(env.ERC8004_RPC_URL ?? ""); } catch { return fail("invalid_config"); }
  if (minter === "0x0000000000000000000000000000000000000000" || rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash || rpc.href.length > 4096) fail("invalid_config");
  if (env.ERC8004_MINTER_EXCLUSIVE !== undefined && env.ERC8004_MINTER_EXCLUSIVE !== "true" && env.ERC8004_MINTER_EXCLUSIVE !== "false") fail("invalid_config");
  return { chainId: CHAIN_ID, registry: REGISTRY, minter, databaseUrl: databaseUrl(env), rpcUrl: rpc.href,
    maxGas: positiveDecimal(env.ERC8004_MAX_GAS_PER_TX), maxPrice: positiveDecimal(env.ERC8004_MAX_GAS_PRICE_WEI),
    maxInstanceFee: positiveDecimal(env.ERC8004_MAX_INSTANCE_FEE_WEI), maxDailyFee: positiveDecimal(env.ERC8004_MAX_DAILY_FEE_WEI), exclusive: env.ERC8004_MINTER_EXCLUSIVE === "true" };
}
/** Call only after the enabled/exclusive entry gates and the minter fence. */
export function signerKey(env: IdentityEnv): Hex {
  const key = env.ERC8004_MINTER_PRIVATE_KEY;
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) fail("invalid_config");
  return key as Hex;
}
