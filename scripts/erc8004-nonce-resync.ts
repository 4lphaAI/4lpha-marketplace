import { pathToFileURL } from "node:url";
import type { IdentityEnv } from "../src/identity/config.js";
import { createMigrationNonceReader, resolveMinterMigrationConfig, type MigrationEntryConfig, type MigrationOutput } from "../src/identity/minterMigrationEntry.js";
import { parseNonceResyncCommand, resyncIdentityNonce, type NonceResyncRequest, type NonceResyncResult } from "../src/identity/nonceResync.js";
import { errorCode, fail } from "../src/identity/types.js";
import { createPgSqlClient } from "../src/store/sql.js";

export interface NonceResyncEntryDependencies {
  run(config: MigrationEntryConfig, request: NonceResyncRequest): Promise<NonceResyncResult>;
}
export const realNonceResyncDependencies: NonceResyncEntryDependencies = {
  async run(config, request) {
    const sql = await createPgSqlClient(config.databaseUrl);
    try { return await resyncIdentityNonce(sql, config, request, createMigrationNonceReader(config)); }
    finally { await sql.close(); }
  },
};
export async function executeNonceResyncCommand(
  args: readonly string[], env: IdentityEnv, deps: NonceResyncEntryDependencies = realNonceResyncDependencies,
): Promise<NonceResyncResult> {
  const request = parseNonceResyncCommand(args);
  const config = resolveMinterMigrationConfig(env);
  if (config.minter !== request.minter) fail("arguments_invalid");
  return deps.run(config, request);
}
/** Only closed codes and the public recovery result reach output. */
export async function nonceResyncMain(
  args: readonly string[], env: IdentityEnv = process.env, deps: NonceResyncEntryDependencies = realNonceResyncDependencies,
  output: MigrationOutput = { stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); } },
): Promise<number> {
  try {
    const data = await executeNonceResyncCommand(args, env, deps);
    output.stdout(`${JSON.stringify({ data })}\n`); return 0;
  } catch (error) {
    output.stderr(`${JSON.stringify({ data: null, error: { code: errorCode(error) } })}\n`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await nonceResyncMain(process.argv.slice(2));
}
