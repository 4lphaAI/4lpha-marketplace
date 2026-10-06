/** AGENTIC-EARN-SPEC ET3: the runner gains exactly six defi commands with their timeouts; every other defi subcommand stays refused; the DeFi names are a cli-error only for a defi command; the other commands classify as today. */
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BawRunner, bawOutputValid, type BawSpawn } from "../src/agentic/baw.js";

const SESSION = { v: 1, instanceId: "11".repeat(32), sessionJson: '{"clientId":"offline-fixture","sessionId":"offline-fixture"}' } as const;
const ROOT = join(process.cwd(), "scripts", "tmp");
const SIX: readonly (readonly [readonly string[], number])[] = [[["defi", "investment-list", "--investType", "Earn"], 15_000], [["defi", "investment-info", "--investmentId", "x"], 15_000],
  [["defi", "position", "--binanceChainId", "56"], 15_000], [["defi", "preview", "--action", "deposit"], 30_000], [["defi", "deposit", "--investmentId", "x"], 60_000], [["defi", "redeem", "--investmentId", "x"], 60_000]];

async function runner(context: { mock: { restoreAll(): void; method: (...a: never[]) => unknown }; after(fn: () => void): void }, stdout: string, seen: { spawned: number; limits: string[] } = { spawned: 0, limits: [] }) {
  await mkdir(ROOT, { recursive: true });
  (context.mock.method as unknown as (o: unknown, n: string, f: () => string) => unknown)(os, "tmpdir", () => ROOT);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  const spawn: BawSpawn = (_file, _args, options, callback) => {
    seen.spawned += 1; seen.limits.push(String(options.timeout));
    const child = new ChildProcess();
    queueMicrotask(() => { child.emit("spawn"); callback(null, stdout, ""); child.emit("close", 0); });
    return child;
  };
  return new BawRunner(join(ROOT, "fixture.cjs"), spawn);
}
const failing = (name: string, code = 351763) => JSON.stringify({ success: false, error: { code, name, message: "m" } });
async function failure(context: Parameters<typeof runner>[0], stdout: string, args: readonly string[]) {
  const spawn: BawSpawn = (_file, _args, _options, callback) => {
    const child = new ChildProcess();
    queueMicrotask(() => { child.emit("spawn"); callback(Object.assign(new Error("exit 1"), { code: 1 }) as never, stdout, ""); child.emit("close", 1); });
    return child;
  };
  await mkdir(ROOT, { recursive: true });
  (context.mock.method as unknown as (o: unknown, n: string, f: () => string) => unknown)(os, "tmpdir", () => ROOT);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  return new BawRunner(join(ROOT, "fixture.cjs"), spawn).run(args, SESSION);
}

describe("Agentic Earn runner (AGENTIC-EARN-SPEC 3.13)", () => {
  it("runs the six defi commands with their timeouts (the runner's kill is 5 s later) and accepts any object answer", async context => {
    for (const [args, timeout] of SIX) {
      const seen = { spawned: 0, limits: [] as string[] };
      const r = await runner(context, JSON.stringify({ success: true, data: { anything: ["goes"] } }), seen);
      const answer = await r.run(args, SESSION);
      assert.equal(answer.kind, "ok", args.join(" "));
      assert.equal(seen.spawned, 1);
      assert.equal(seen.limits[0], String(timeout), args.join(" "));
    }
  });

  it("refuses every other defi subcommand before spawning", async context => {
    const seen = { spawned: 0, limits: [] as string[] };
    const r = await runner(context, "{}", seen);
    for (const sub of ["claim", "lp-add", "lp-remove", "protocol-list", "protocol-info", "stake", "borrow", "repay", "supply"]) {
      await assert.rejects(r.prepare(["defi", sub], SESSION), /AGENTIC_COMMAND_REFUSED/u, sub);
    }
    await assert.rejects(r.prepare(["defi"], SESSION), /AGENTIC_COMMAND_REFUSED/u);
    assert.equal(seen.spawned, 0);
  });

  it("the DeFi names are a cli-error only for a defi command; INSUFFICIENT_BALANCE from a swap classifies as today and a DeFi name from a swap does not", async context => {
    const defi = await failure(context, failing("DEFI_TX_SIMULATION_FAILED"), ["defi", "deposit", "--investmentId", "x"]);
    assert.deepEqual(defi.kind === "cli-error" ? [defi.code, defi.name] : null, [351763, "DEFI_TX_SIMULATION_FAILED"]);
    for (const name of ["INVESTMENT_NOT_FOUND", "INVESTMENT_NOT_INVESTABLE", "DEFI_SECURITY_RISK_BLOCKED", "COMPLIANCE_FAILED", "INVESTMENT_NO_POSITION", "POSITION_QUERY_FAILED", "INVALID_PARAMS", "INVALID_AMOUNT", "INVALID_ADDRESS"]) {
      assert.equal((await failure(context, failing(name), ["defi", "redeem", "--investmentId", "x"])).kind, "cli-error", name);
    }
    const swap = await failure(context, failing("DEFI_TX_SIMULATION_FAILED"), ["market-order", "swap", "--fromToken", "a"]);
    assert.deepEqual(swap.kind === "no-response" ? swap.code : swap.kind, "unparseable", "not a swap error name");
    const balance = await failure(context, failing("INSUFFICIENT_BALANCE", 351766), ["market-order", "swap", "--fromToken", "a"]);
    assert.equal(balance.kind, "cli-error", "INSUFFICIENT_BALANCE stays in the shared set");
    const unknown = await failure(context, failing("BRAND_NEW"), ["defi", "deposit", "--investmentId", "x"]);
    assert.equal(unknown.kind, "no-response");
  });

  it("bawOutputValid accepts an object for the six defi commands only; every other command keeps its own contract", () => {
    for (const [args] of SIX) { const command = args.slice(0, 2).join(" "); assert.equal(bawOutputValid(command, { a: 1 }), true, command); assert.equal(bawOutputValid(command, []), false, command); assert.equal(bawOutputValid(command, "x"), false, command); }
    assert.equal(bawOutputValid("wallet status", { status: "CONNECTED" }), true);
    assert.equal(bawOutputValid("market-order swap", { anything: 1 }), false);
    assert.equal(bawOutputValid("limit-order buy", { a: 1 }), false);
  });
});
