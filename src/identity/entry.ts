import { setTimeout as delay } from "node:timers/promises";
import { databaseUrl, enabled, positiveDecimal, resolveConfig, signerKey, type IdentityConfig, type IdentityEnv } from "./config.js";
import { createIdentityFence } from "./fence.js";
import { createRegistryGateway, type RegistryGateway } from "./registry.js";
import { IdentityService, previewIdentity, verifyIdentity } from "./service.js";
import { errorCode, fail, isObject, validCategory, type IdentityCategory, type IdentityFence, type IdentitySources } from "./types.js";
import { createPgSqlClient } from "../store/sql.js";
import { PostgresIdentitySources } from "../store/erc8004Sources.js";
import { checkIdentitySchema, migrateIdentity, PostgresIdentityLedger, type IdentityLedger } from "../store/erc8004.js";

export type IdentityCommand = { readonly mode: "preview" | "verify" | "enroll" | "migrate" | "run" | "worker"; readonly agentId?: string; readonly category?: IdentityCategory; readonly ceiling?: bigint; readonly daemon: boolean };
export function parseIdentityCommand(args: readonly string[], worker = false): IdentityCommand {
  let index = 0; let mode: IdentityCommand["mode"] = worker ? "worker" : "preview";
  if (!worker && args[0] && !args[0].startsWith("--")) {
    const candidate = args[0]; if (!["preview", "verify", "enroll", "migrate", "run"].includes(candidate)) fail("arguments_invalid");
    mode = candidate as IdentityCommand["mode"]; index++;
  }
  const values = new Map<string, string | true>();
  for (; index < args.length; index++) {
    const name = args[index]!;
    if (values.has(name) || !["--agent-id", "--category", "--yes-live", "--max-total-fee-wei", "--once", "--daemon"].includes(name)) fail("arguments_invalid");
    if (["--yes-live", "--once", "--daemon"].includes(name)) values.set(name, true);
    else { const value = args[++index]; if (!value || value.startsWith("--") || value.length > 256) fail("arguments_invalid"); values.set(name, value); }
  }
  const allowed = mode === "worker" ? ["--once", "--daemon"] : mode === "run" ? ["--agent-id", "--yes-live", "--max-total-fee-wei"] : mode === "enroll" ? ["--agent-id", "--category"] : mode === "migrate" ? [] : ["--agent-id"];
  if ([...values.keys()].some((key) => !allowed.includes(key))) fail("arguments_invalid");
  const agentId = values.get("--agent-id");
  if (mode !== "worker" && mode !== "migrate" && (typeof agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId))) fail("arguments_invalid");
  const category = values.get("--category"); if (category !== undefined && !validCategory(category)) fail("arguments_invalid");
  if (mode === "worker" && Number(values.has("--once")) + Number(values.has("--daemon")) !== 1) fail("arguments_invalid");
  if (mode === "run" && (!values.has("--yes-live") || !values.has("--max-total-fee-wei"))) fail("arguments_invalid");
  return { mode, ...(typeof agentId === "string" ? { agentId } : {}), ...(validCategory(category) ? { category } : {}),
    ...(mode === "run" ? { ceiling: positiveDecimal(values.get("--max-total-fee-wei")) } : {}), daemon: values.has("--daemon") };
}
export type ReadDependencies = { readonly sources: IdentitySources; readonly ledger: IdentityLedger; readonly gateway: RegistryGateway };
export type WriteDependencies = ReadDependencies & { readonly fence: IdentityFence };
export interface IdentityEntryDependencies {
  migrate(url: string): Promise<void>;
  enroll(url: string, id: string, category?: IdentityCategory): Promise<unknown>;
  read<T>(config: IdentityConfig, fn: (deps: ReadDependencies) => Promise<T>): Promise<T>;
  write<T>(config: IdentityConfig, env: IdentityEnv, fn: (deps: WriteDependencies) => Promise<T>): Promise<T>;
  wait(ms: number): Promise<void>;
}
export const realIdentityDependencies: IdentityEntryDependencies = {
  async migrate(url) { const sql = await createPgSqlClient(url); try { await migrateIdentity(sql); } finally { await sql.close(); } },
  async enroll(url, id, category) {
    const sql = await createPgSqlClient(url);
    try { await checkIdentitySchema(sql); const source = await new PostgresIdentitySources(sql).enroll(id, category); return { enrolled: true, identity: source.identity }; }
    finally { await sql.close(); }
  },
  async read(config, fn) {
    const sql = await createPgSqlClient(config.databaseUrl);
    try {
      return await sql.transaction(async (tx) => {
        await tx.query("set transaction read only");
        await checkIdentitySchema(tx);
        return fn({ sources: new PostgresIdentitySources(tx), ledger: new PostgresIdentityLedger(tx, config), gateway: createRegistryGateway(config) });
      });
    } finally { await sql.close(); }
  },
  async write(config, env, fn) {
    const fence = await createIdentityFence(config.databaseUrl, config);
    let sql: Awaited<ReturnType<typeof createPgSqlClient>> | undefined;
    try {
      fence.check(); sql = await createPgSqlClient(config.databaseUrl); fence.check();
      await checkIdentitySchema(sql); fence.check();
      const key = signerKey(env); fence.check();
      const gateway = createRegistryGateway(config, key); fence.check();
      return await fn({ sources: new PostgresIdentitySources(sql), ledger: new PostgresIdentityLedger(sql, config), gateway, fence });
    } finally { await sql?.close(); await fence.close(); }
  },
  async wait(ms) { await delay(ms); },
};
export async function executeIdentityCommand(args: readonly string[], env: IdentityEnv, deps: IdentityEntryDependencies = realIdentityDependencies, worker = false): Promise<unknown> {
  const command = parseIdentityCommand(args, worker);
  if (command.mode === "worker" || command.mode === "run") {
    // This precedes URL, DB, RPC and secret parsing/construction, even with poisoned env getters.
    if (!enabled(env)) return { enabled: false, status: "disabled" };
  }
  if (command.mode === "migrate") { await deps.migrate(databaseUrl(env)); return { migrated: true }; }
  if (command.mode === "enroll") return deps.enroll(databaseUrl(env), command.agentId!, command.category);
  const config = resolveConfig(env);
  if (command.mode === "preview" || command.mode === "verify") return deps.read(config, async ({ sources, ledger, gateway }) => {
    const source = await sources.get(command.agentId!); if (!source) fail("not_found");
    return command.mode === "preview" ? previewIdentity(config, source, ledger, gateway) : verifyIdentity(source, ledger, gateway);
  });
  if (!config.exclusive) fail("exclusive_required");
  if (command.daemon && env.ERC8004_IDENTITY_DAEMON_ENABLED !== "true") fail("invalid_config");
  return deps.write(config, env, async ({ sources, ledger, gateway, fence }) => {
    const service = new IdentityService(config, ledger, sources, gateway, fence);
    const count = command.mode === "run" ? 60 : command.daemon ? Number.POSITIVE_INFINITY : 1;
    let result: unknown = { status: "idle" };
    for (let iteration = 0; iteration < count; iteration++) {
      fence.check(); await service.discover(command.agentId); fence.check();
      const step = await service.step(command.agentId, command.ceiling); result = step;
      if (!command.daemon && (command.mode !== "run" || step.status === "registered" || step.status === "blocked" || step.status === "idle")) break;
      if (iteration + 1 < count) { await deps.wait(5_000); fence.check(); }
    }
    return result;
  });
}
/** Entry errors are closed codes only; provider messages/stacks never reach output. */
export async function identityMain(args: readonly string[], worker = false): Promise<void> {
  try {
    const data: unknown = await executeIdentityCommand(args, process.env, realIdentityDependencies, worker);
    process.stdout.write(`${JSON.stringify({ data })}\n`);
    if (isObject(data) && (data.verified === false || data.status === "blocked" || args[0] === "run" && data.status !== "registered" && data.status !== "disabled")) process.exitCode = 1;
  }
  catch (error) { process.stderr.write(`${JSON.stringify({ data: null, error: { code: errorCode(error) } })}\n`); process.exitCode = 1; }
}
