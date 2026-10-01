import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { executeNonceResyncCommand, nonceResyncMain } from "../scripts/erc8004-nonce-resync.js";
import { parseNonceResyncCommand, type NonceResyncResult } from "../src/identity/nonceResync.js";
import { createMigrationNonceReader, resolveMinterMigrationConfig } from "../src/identity/minterMigrationEntry.js";
import { ERROR_CODES, IdentityError, REGISTRY } from "../src/identity/types.js";
import type { IdentityEnv } from "../src/identity/config.js";
import { MIGRATION_CONFIG } from "./support/minterMigration.js";

const ARGS = ["--minter", MIGRATION_CONFIG.minter, "--from", "35", "--to", "36"];
const ENV = { ERC8004_CHAIN_ID: "56", ERC8004_REGISTRY_ADDRESS: REGISTRY, ERC8004_MINTER_ADDRESS: MIGRATION_CONFIG.minter,
  ERC8004_RPC_URL: "https://rpc.invalid", DATABASE_URL: "postgres://test@127.0.0.1/offline" };
function publicEnv(base: IdentityEnv = ENV): IdentityEnv {
  return new Proxy(base, { get(target, key) {
    assert.notEqual(key, "ERC8004_MINTER_PRIVATE_KEY");
    assert.ok(Object.hasOwn(ENV, key), String(key));
    return Reflect.get(target, key) as string | undefined;
  } });
}
test("resync argument boundaries, dry-run default and address normalization", async (t) => {
  assert.deepEqual(parseNonceResyncCommand(ARGS), { minter: MIGRATION_CONFIG.minter, fromNonce: 35, toNonce: 36, apply: false });
  assert.equal(parseNonceResyncCommand([...ARGS, "--apply"]).apply, true);
  assert.equal(parseNonceResyncCommand(ARGS.map((s) => s.startsWith("0x") ? s.toLowerCase() : s)).minter, MIGRATION_CONFIG.minter);
  assert.equal(parseNonceResyncCommand(["--minter", MIGRATION_CONFIG.minter, "--from", "0", "--to", String(Number.MAX_SAFE_INTEGER)]).fromNonce, 0);
  const invalid = [[], [...ARGS, "--yes-live"], [...ARGS, "--unknown"], [...ARGS, "--apply", "--apply"], [...ARGS, "--apply", "true"], [...ARGS, "--from", "35"]];
  for (let i = 0; i < ARGS.length; i += 2) {
    invalid.push(ARGS.filter((_v, index) => index !== i && index !== i + 1));
    invalid.push([...ARGS, ARGS[i]!, ARGS[i + 1]!]);
    invalid.push(ARGS.map((v, index) => index === i + 1 ? "x".repeat(129) : v));
  }
  for (const value of ["", "00", "01", "-1", "+1", " 1", "1 ", "1e2", "1.0", "1.5", "NaN", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)]) {
    for (const index of [3, 5]) invalid.push(ARGS.map((v, i) => i === index ? value : v));
  }
  for (const value of ["0", "34", "35"]) invalid.push(ARGS.map((v, i) => i === 5 ? value : v));
  for (const value of ["invalid", "0x1234", " " + MIGRATION_CONFIG.minter]) invalid.push(ARGS.map((v, i) => i === 1 ? value : v));
  invalid.push([...ARGS.slice(0, -1), "--apply"]);
  for (const [index, args] of invalid.entries()) await t.test(`invalid arguments ${index} refuse before env/dependencies`, async () => {
    await assert.rejects(executeNonceResyncCommand(args, new Proxy({}, { get() { assert.fail("env read"); } }),
      { async run() { assert.fail("dependency creation"); } }), /arguments_invalid/);
  });
});
test("resync invalid config and configured-minter mismatch refuse before DB/RPC construction", async () => {
  for (const patch of [{ ERC8004_CHAIN_ID: "1" }, { ERC8004_REGISTRY_ADDRESS: "invalid" }, { ERC8004_MINTER_ADDRESS: "invalid" },
    { ERC8004_RPC_URL: "http://rpc.invalid" }, { DATABASE_URL: "" }]) {
    await assert.rejects(executeNonceResyncCommand(ARGS, publicEnv({ ...ENV, ...patch }), { async run() { assert.fail("dependencies"); } }), /invalid_config/);
  }
  await assert.rejects(executeNonceResyncCommand(ARGS, publicEnv({ ...ENV, ERC8004_MINTER_ADDRESS: "0x2222222222222222222222222222222222222222" }),
    { async run() { assert.fail("dependencies"); } }), /arguments_invalid/);
});
test("resync entry never reads a key, passes public config only and emits both closed envelopes and exit codes", async () => {
  for (const path of ["../scripts/erc8004-nonce-resync.ts", "../src/identity/nonceResync.ts", "../src/identity/minterMigrationEntry.ts"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.equal(/privateKeyToAccount|createWalletClient|signTransaction|sendRawTransaction|ERC8004_MINTER_PRIVATE_KEY|dotenv|env-file/.test(source), false);
  }
  for (const apply of [false, true]) {
    const result: NonceResyncResult = { mode: apply ? "apply" : "dry-run", applied: apply, minter: MIGRATION_CONFIG.minter,
      fromNonce: 35, toNonce: 36, unblocked: [], skipped: [] };
    const stdout: string[] = []; const stderr: string[] = [];
    assert.equal(await nonceResyncMain([...ARGS, ...(apply ? ["--apply"] : [])], publicEnv(), { async run(config, request) {
      assert.deepEqual(config, { ...MIGRATION_CONFIG, databaseUrl: ENV.DATABASE_URL, rpcUrl: "https://rpc.invalid/" });
      assert.deepEqual(request, { minter: MIGRATION_CONFIG.minter, fromNonce: 35, toNonce: 36, apply }); return result;
    } }, { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) }), 0);
    assert.deepEqual(stdout, [JSON.stringify({ data: result }) + "\n"]); assert.deepEqual(stderr, []);
  }
  for (const error of [new Error("DB secret"), new Error("RPC secret"), ...ERROR_CODES.map((code) => new IdentityError(code))]) {
    const stdout: string[] = []; const stderr: string[] = [];
    assert.equal(await nonceResyncMain(ARGS, publicEnv(), { async run() { throw error; } },
      { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) }), 1);
    assert.deepEqual(stdout, []); assert.deepEqual(stderr, [JSON.stringify({ data: null, error: { code: error instanceof IdentityError ? error.code : "rpc_unavailable" } }) + "\n"]);
  }
});
test("resync uses the unchanged three-call public reader with no signing/send capability", async (t) => {
  const calls: string[] = []; let chain = "0x38";
  t.mock.method(globalThis, "fetch", async (input: string | Request | URL, init?: RequestInit) => {
    const body = input instanceof Request ? await input.text() : String(init?.body);
    const request = JSON.parse(body) as { id: number; method: string; params?: string[] };
    calls.push(request.method); assert.ok(["eth_chainId", "eth_getTransactionCount"].includes(request.method));
    if (request.method === "eth_getTransactionCount") assert.equal(request.params?.[1], calls.length === 2 ? "latest" : "pending");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_chainId" ? chain : "0x24" }), { headers: { "content-type": "application/json" } });
  });
  const reader = createMigrationNonceReader(resolveMinterMigrationConfig(publicEnv()));
  assert.deepEqual(await reader.read(MIGRATION_CONFIG.minter), { chainId: 56, latest: 36, pending: 36 });
  assert.deepEqual(calls, ["eth_chainId", "eth_getTransactionCount", "eth_getTransactionCount"]);
  calls.length = 0; chain = "0x1"; await assert.rejects(reader.read(MIGRATION_CONFIG.minter), /invalid_config/); assert.equal(calls.length, 1);
});
