import { createPublicClient, getAddress, http } from "viem";
import { bsc } from "viem/chains";
import { databaseUrl, type IdentityEnv } from "./config.js";
import { migrateEvidenceFreeMinter, parseMinterMigrationCommand, type MigrationNonceReader, type MinterMigrationConfig, type MinterMigrationRequest, type MinterMigrationResult } from "./minterMigration.js";
import { errorCode, fail, REGISTRY } from "./types.js";
import { createPgSqlClient } from "../store/sql.js";

export type MigrationEntryConfig = MinterMigrationConfig & { readonly databaseUrl: string; readonly rpcUrl: string };
export function resolveMinterMigrationConfig(env: IdentityEnv): MigrationEntryConfig {
  // Do not enumerate env, load env files, or resolve the worker's secret config.
  if (env.ERC8004_CHAIN_ID !== "56" || env.ERC8004_REGISTRY_ADDRESS?.toLowerCase() !== REGISTRY.toLowerCase()) fail("invalid_config");
  try {
    const minter = getAddress(env.ERC8004_MINTER_ADDRESS ?? "");
    const rpc = new URL(env.ERC8004_RPC_URL ?? "");
    if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash || rpc.href.length > 4096) fail("invalid_config");
    return { chainId: 56, minter, databaseUrl: databaseUrl(env), rpcUrl: rpc.href };
  } catch { return fail("invalid_config"); }
}
export function createMigrationNonceReader(config: MigrationEntryConfig): MigrationNonceReader {
  const client = createPublicClient({ chain: bsc, transport: http(config.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  return {
    async read(minter) {
      const chainId = await client.getChainId();
      if (chainId !== 56) fail("invalid_config");
      const latest = await client.getTransactionCount({ address: minter, blockTag: "latest" });
      const pending = await client.getTransactionCount({ address: minter, blockTag: "pending" });
      return { chainId, latest, pending };
    },
  };
}
export interface MinterMigrationEntryDependencies {
  run(config: MigrationEntryConfig, request: MinterMigrationRequest): Promise<MinterMigrationResult>;
}
export const realMinterMigrationDependencies: MinterMigrationEntryDependencies = {
  async run(config, request) {
    const sql = await createPgSqlClient(config.databaseUrl);
    try { return await migrateEvidenceFreeMinter(sql, config, request, createMigrationNonceReader(config)); }
    finally { await sql.close(); }
  },
};
export async function executeMinterMigrationCommand(
  args: readonly string[], env: IdentityEnv, deps: MinterMigrationEntryDependencies = realMinterMigrationDependencies,
): Promise<MinterMigrationResult> {
  const request = parseMinterMigrationCommand(args);
  const config = resolveMinterMigrationConfig(env);
  if (config.minter !== request.newMinter) fail("invalid_config");
  return deps.run(config, request);
}
export interface MigrationOutput { stdout(text: string): void; stderr(text: string): void }
/** No raw DB/RPC errors, row documents, URLs, arguments or environment in output. */
export async function minterMigrationMain(
  args: readonly string[], env: IdentityEnv = process.env, deps: MinterMigrationEntryDependencies = realMinterMigrationDependencies,
  output: MigrationOutput = { stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); } },
): Promise<number> {
  try {
    const data = await executeMinterMigrationCommand(args, env, deps);
    output.stdout(`${JSON.stringify({ data })}\n`); return 0;
  } catch (error) {
    output.stderr(`${JSON.stringify({ data: null, error: { code: errorCode(error) } })}\n`); return 1;
  }
}
