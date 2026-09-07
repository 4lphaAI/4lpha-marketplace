import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { executeIdentityCommand, parseIdentityCommand, type IdentityEntryDependencies } from "../src/identity/entry.js";
import { createRegistryGateway } from "../src/identity/registry.js";
import { resolveConfig, type IdentityEnv } from "../src/identity/config.js";
import { acquireIdentityFence, type LockConnection } from "../src/identity/fence.js";
import { IdentityError } from "../src/identity/types.js";
import { CONFIG, fixture } from "./support/erc8004.js";

const ENV: IdentityEnv = { ERC8004_IDENTITY_ENABLED: "true", ERC8004_CHAIN_ID: "56", ERC8004_REGISTRY_ADDRESS: CONFIG.registry,
  ERC8004_MINTER_ADDRESS: CONFIG.minter, ERC8004_RPC_URL: CONFIG.rpcUrl, DATABASE_URL: CONFIG.databaseUrl,
  ERC8004_MAX_GAS_PER_TX: "1000", ERC8004_MAX_GAS_PRICE_WEI: "10", ERC8004_MAX_INSTANCE_FEE_WEI: "20000", ERC8004_MAX_DAILY_FEE_WEI: "50000", ERC8004_MINTER_EXCLUSIVE: "true" };
function poisonEnv(base: IdentityEnv): IdentityEnv { return new Proxy(base, { get(target, key) { if (key === "ERC8004_MINTER_PRIVATE_KEY") throw new Error("Secret access forbidden"); return Reflect.get(target, key) as string | undefined; } }); }
function dependencies(): { deps: IdentityEntryDependencies; calls: string[]; f: ReturnType<typeof fixture> } {
  const f = fixture(); const calls: string[] = [];
  const deps: IdentityEntryDependencies = {
    async migrate() { calls.push("migrate"); },
    async enroll(_url, id, category) { calls.push(`enroll:${id}:${category}`); return { enrolled: true }; },
    async read(_config, fn) { calls.push("read"); return fn({ ...f, gateway: { ...f.gateway,
      probe: () => f.gateway.probe(), nonces: () => f.gateway.nonces(), fees: () => f.gateway.fees(), simulate: () => f.gateway.simulate(),
      receipt: (hash) => f.gateway.receipt(hash), finalized: () => f.gateway.finalized(), blockHash: () => f.gateway.blockHash(), identity: () => f.gateway.identity(),
      async sign() { throw new Error("Read-only signing forbidden"); }, async broadcast() { throw new Error("Read-only broadcast forbidden"); } },
      ledger: { read: () => f.ledger.read(), async atomic() { throw new Error("Read-only DML forbidden"); } },
      sources: { get: (id) => f.sources.get(id), enrolled: (id) => f.sources.enrolled(id), async enroll() { throw new Error("Read-only enrollment forbidden"); }, async project() { throw new Error("Read-only projection forbidden"); } } }); },
    async write(_config, _env, fn) { calls.push("write"); return fn(f); },
    async wait() { calls.push("wait"); },
  };
  return { deps, calls, f };
}
test("OFF actual command dependency seam does zero DB/RPC/key work for worker and explicit run", async () => {
  for (const [args, worker] of [[ ["--once"], true ], [["run", "--agent-id", "agent", "--yes-live", "--max-total-fee-wei", "11000"], false ]] as const) {
    const d = dependencies(); const env = new Proxy({ ERC8004_IDENTITY_ENABLED: "false" }, { get(target, key) { if (key !== "ERC8004_IDENTITY_ENABLED") throw new Error("OFF environment access"); return Reflect.get(target, key) as string | undefined; } });
    assert.deepEqual(await executeIdentityCommand(args, env, d.deps, worker), { enabled: false, status: "disabled" }); assert.deepEqual(d.calls, []);
  }
});
test("default preview and verify stay SELECT-only, with no secret or source mutation", async () => {
  const d = dependencies();
  const before = await d.f.ledger.read();
  const result = await executeIdentityCommand(["--agent-id", "agent"], poisonEnv(ENV), d.deps);
  assert.equal((result as { exact: boolean }).exact, false); assert.deepEqual(await d.f.ledger.read(), before);
  await executeIdentityCommand(["verify", "--agent-id", "agent"], poisonEnv(ENV), d.deps);
  assert.deepEqual(d.calls, ["read", "read"]); assert.equal(d.f.gateway.signed.length, 0);
});
test("missing agent, unknown/duplicate flags and spending flags on read modes refuse before construction", async () => {
  for (const args of [[], ["garbage"], ["preview", "--agent-id", "agent", "--yes-live"], ["run", "--agent-id", "agent"], ["run", "--agent-id", "agent", "--yes-live", "--max-total-fee-wei", "11000", "--daemon"], ["--agent-id", "agent", "--agent-id", "other"], ["migrate", "--agent-id", "agent"], ["enroll", "--agent-id", "agent", "--category", "venus"]]) {
    const d = dependencies(); await assert.rejects(executeIdentityCommand(args, poisonEnv(ENV), d.deps)); assert.deepEqual(d.calls, []);
  }
  assert.throws(() => parseIdentityCommand([], true)); assert.throws(() => parseIdentityCommand(["--once", "--daemon"], true));
});
test("bad chain, registry, RPC credentials, decimal bounds and address refuse before entry dependencies", async () => {
  for (const patch of [{ ERC8004_CHAIN_ID: "1" }, { ERC8004_REGISTRY_ADDRESS: CONFIG.minter }, { ERC8004_RPC_URL: "http://rpc.invalid" }, { ERC8004_RPC_URL: "https://user:password@rpc.invalid" }, { ERC8004_MAX_GAS_PER_TX: "0" }, { ERC8004_MAX_GAS_PRICE_WEI: "9".repeat(10000) }, { ERC8004_MAX_INSTANCE_FEE_WEI: "1e10" }, { ERC8004_MINTER_ADDRESS: "bad" }]) {
    const d = dependencies(); await assert.rejects(executeIdentityCommand(["--agent-id", "agent"], poisonEnv({ ...ENV, ...patch }), d.deps)); assert.deepEqual(d.calls, []);
  }
});
test("enroll and migration use only explicit DB capability and never construct RPC/signer", async () => {
  const d = dependencies(); const env = poisonEnv({ DATABASE_URL: CONFIG.databaseUrl });
  await executeIdentityCommand(["migrate"], env, d.deps);
  await executeIdentityCommand(["enroll", "--agent-id", "agent", "--category", "grid"], env, d.deps);
  assert.deepEqual(d.calls, ["migrate", "enroll:agent:grid"]);
});
test("daemon requires separate enablement; exclusivity gates write construction", async () => {
  const d = dependencies(); await assert.rejects(executeIdentityCommand(["--daemon"], ENV, d.deps, true)); assert.deepEqual(d.calls, []);
  await assert.rejects(executeIdentityCommand(["--once"], { ...ENV, ERC8004_MINTER_EXCLUSIVE: "false" }, d.deps, true)); assert.deepEqual(d.calls, []);
});
test("worker once prepares one bounded phase and run does not silently enroll", async () => {
  const d = dependencies(); await executeIdentityCommand(["--once"], ENV, d.deps, true);
  assert.deepEqual(d.calls, ["write"]); assert.equal((await d.f.ledger.read()).transactions.length, 1);
  const other = dependencies(); other.f.sources.rows.set("agent", { ...other.f.sources.rows.get("agent")!, identity: null });
  await assert.rejects(executeIdentityCommand(["run", "--agent-id", "agent", "--yes-live", "--max-total-fee-wei", "11000"], ENV, other.deps), /not_enrolled/);
  assert.equal((await other.f.ledger.read()).jobs.length, 0); assert.equal(other.f.gateway.signed.length, 0);
});
test("signing client refuses mismatched/invalid dummy key without RPC", () => {
  assert.throws(() => createRegistryGateway(resolveConfig(ENV), `0x${"22".repeat(32)}`), /invalid_config/);
  assert.throws(() => createRegistryGateway(resolveConfig(ENV), `0x${"00".repeat(32)}`), /invalid_config/);
});
class Connection extends EventEmitter implements LockConnection {
  locked = true; ended = false; statements: string[] = [];
  async query(text: string) { this.statements.push(text); return { rows: [{ locked: this.locked }] }; }
  async end() { this.ended = true; this.emit("end"); }
}
test("dedicated minter session fence refuses busy lock and latches error/end permanently", async () => {
  const busy = new Connection(); busy.locked = false; await assert.rejects(acquireIdentityFence(busy, CONFIG), /lock_busy/); assert.equal(busy.ended, true);
  for (const event of ["error", "end"] as const) {
    const connection = new Connection(); const fence = await acquireIdentityFence(connection, CONFIG); fence.check();
    connection.emit(event); assert.throws(() => fence.check(), (error: unknown) => error instanceof IdentityError && error.code === "lock_lost");
    await fence.close(); assert.equal(connection.ended, true);
  }
});
