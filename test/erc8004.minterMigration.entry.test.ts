import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMinterMigrationCommand, type MinterMigrationResult } from "../src/identity/minterMigration.js";
import { createMigrationNonceReader, executeMinterMigrationCommand, minterMigrationMain, resolveMinterMigrationConfig } from "../src/identity/minterMigrationEntry.js";
import { IdentityError, REGISTRY } from "../src/identity/types.js";
import type { IdentityEnv } from "../src/identity/config.js";
import { ARGS, MIGRATION_CONFIG, REQUEST } from "./support/minterMigration.js";

const ENV = { ERC8004_CHAIN_ID: "56", ERC8004_REGISTRY_ADDRESS: REGISTRY, ERC8004_MINTER_ADDRESS: REQUEST.newMinter,
  ERC8004_RPC_URL: "https://rpc.invalid", DATABASE_URL: "postgres://test@127.0.0.1/offline" };
function publicEnv(base: IdentityEnv = ENV): IdentityEnv {
  return new Proxy(base, { ownKeys() { throw new Error("Environment enumeration forbidden"); }, get(target, key) {
    assert.ok(Object.hasOwn(ENV, key), `Unexpected environment access: ${String(key)}`);
    return Reflect.get(target, key) as string | undefined;
  } });
}
test("migration parser defaults to dry-run and normalizes explicit minters", () => {
  assert.deepEqual(parseMinterMigrationCommand(ARGS.map((value) => value.startsWith("0x") ? value.toLowerCase() : value)), { ...REQUEST, apply: false });
  assert.deepEqual(parseMinterMigrationCommand([...ARGS, "--apply"]), REQUEST);
});
test("migration parser rejects missing, duplicate, unknown and out-of-scope arguments before environment access", async () => {
  const invalid = [[], [...ARGS, "--yes-live"], [...ARGS, "--apply", "--apply"], [...ARGS, "--apply", "true"], [...ARGS, "--source-id", REQUEST.sourceId]];
  for (let i = 0; i < ARGS.length; i += 2) {
    invalid.push(ARGS.filter((_v, index) => index !== i && index !== i + 1));
    invalid.push(ARGS.map((v, index) => index === i + 1 ? "wrong" : v));
    invalid.push(ARGS.map((v, index) => index === i + 1 ? "x".repeat(129) : v));
  }
  invalid.push([...ARGS.slice(0, -1), "--apply"]);
  for (const args of invalid) {
    await assert.rejects(executeMinterMigrationCommand(args, new Proxy({}, { get() { assert.fail("environment read"); } }),
      { async run() { assert.fail("dependency called"); } }), /arguments_invalid/);
  }
});
test("migration config refuses unsafe or mismatched public configuration before dependency construction", async () => {
  for (const patch of [{ ERC8004_CHAIN_ID: "1" }, { ERC8004_REGISTRY_ADDRESS: REQUEST.oldMinter }, { ERC8004_MINTER_ADDRESS: REQUEST.oldMinter },
    { ERC8004_MINTER_ADDRESS: "invalid" }, { ERC8004_RPC_URL: "http://rpc.invalid" }, { ERC8004_RPC_URL: "https://user:pass@rpc.invalid" },
    { ERC8004_RPC_URL: "https://rpc.invalid/#fragment" }, { ERC8004_RPC_URL: "https://rpc.invalid/" + "x".repeat(4096) },
    { DATABASE_URL: "https://db.invalid" }, { DATABASE_URL: "" }]) {
    await assert.rejects(executeMinterMigrationCommand(ARGS, publicEnv({ ...ENV, ...patch }), { async run() { assert.fail("dependency called"); } }), /invalid_config/);
  }
});
test("entry passes only public config and explicit apply intent; emits safe success and error envelopes", async () => {
  for (const apply of [false, true]) {
    const stdout: string[] = []; const stderr: string[] = [];
    const result: MinterMigrationResult = { ...REQUEST, mode: apply ? "apply" : "dry-run", applied: apply,
      nextNonce: 3, previousRevision: 4, nextRevision: 5, initialUriSha256: "a".repeat(64) };
    const code = await minterMigrationMain([...ARGS, ...(apply ? ["--apply"] : [])], publicEnv(), { async run(config, request) {
      assert.deepEqual(config, { ...MIGRATION_CONFIG, databaseUrl: ENV.DATABASE_URL, rpcUrl: "https://rpc.invalid/" });
      assert.deepEqual(request, { ...REQUEST, apply }); return result;
    } }, { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) });
    assert.equal(code, 0); assert.deepEqual(stdout, [JSON.stringify({ data: result }) + "\n"]); assert.deepEqual(stderr, []);
  }
  for (const error of [new Error("synthetic DB password / RPC credential / row document"), new IdentityError("lock_busy")]) {
    const stdout: string[] = []; const stderr: string[] = [];
    assert.equal(await minterMigrationMain(ARGS, publicEnv(), { async run() { throw error; } },
      { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) }), 1);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, [JSON.stringify({ data: null, error: { code: error instanceof IdentityError ? "lock_busy" : "rpc_unavailable" } }) + "\n"]);
  }
});
test("nonce adapter makes only chain/latest/pending reads, and stops on the wrong chain", async (t) => {
  const calls: unknown[] = []; let chain = "0x38";
  t.mock.method(globalThis, "fetch", async (input: string | Request | URL, init?: RequestInit) => {
    const body = input instanceof Request ? await input.text() : String(init?.body);
    const request = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    calls.push({ method: request.method, params: request.params });
    assert.ok(["eth_chainId", "eth_getTransactionCount"].includes(request.method));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_chainId" ? chain : "0x3" }), { headers: { "content-type": "application/json" } });
  });
  const reader = createMigrationNonceReader(resolveMinterMigrationConfig(publicEnv()));
  assert.deepEqual(await reader.read(REQUEST.newMinter), { chainId: 56, latest: 3, pending: 3 });
  assert.deepEqual(calls, [{ method: "eth_chainId", params: undefined },
    { method: "eth_getTransactionCount", params: [REQUEST.newMinter, "latest"] }, { method: "eth_getTransactionCount", params: [REQUEST.newMinter, "pending"] }]);
  calls.length = 0; chain = "0x1";
  await assert.rejects(reader.read(REQUEST.newMinter), /invalid_config/); assert.equal(calls.length, 1);
});
test("operator script import has no entry execution", async () => {
  await import("../scripts/erc8004-minter-migration.js");
});
