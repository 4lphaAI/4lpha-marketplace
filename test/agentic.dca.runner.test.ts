/** AGENTIC-DCA Revision 3 (R3.9, I9 restored): the runner refuses every limit-order write before spawn; the read stays allowlisted for pairing admission; the shared output contract refuses a non-empty list. */
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BawRunner, type BawSpawn } from "../src/agentic/baw.js";
import { agenticAddress } from "../src/agentic/domain.js";
import { USDT_56 } from "../src/trade/settlement.js";

const SESSION = { v: 1, instanceId: "11".repeat(32), sessionJson: '{"clientId":"offline-fixture","sessionId":"offline-fixture"}' } as const;
const ROOT = join(process.cwd(), "scripts", "tmp");
const SPYB = agenticAddress("0x7138b48df7d98d7e3cc221bfe7192d0a178182d8");
const USDT = agenticAddress(USDT_56);
const BUY = ["limit-order", "buy", "--binanceChainId", "56", "--triggerPrice", "691.80332411", "--fromTokenQty", "10", "--fromToken", USDT, "--toToken", SPYB, "--slippage", "0.5"];
const SELL = ["limit-order", "sell", "--binanceChainId", "56", "--triggerPrice", "710.5", "--fromTokenQty", "0.035714285714285714", "--fromToken", SPYB, "--toToken", USDT, "--slippage", "0.5"];
const CANCEL = ["limit-order", "cancel", "--strategyId", "123"];
const LIST = ["limit-order", "list", "--status", "PENDING", "--binanceChainId", "56", "--page", "1", "--pageSize", "1"];

async function runner(context: { mock: { method: (...a: never[]) => unknown; restoreAll(): void }; after(fn: () => void): void }, stdout: string, seen: { spawned: number } = { spawned: 0 }) {
  await mkdir(ROOT, { recursive: true });
  (context.mock.method as unknown as (o: unknown, n: string, f: () => string) => unknown)(os, "tmpdir", () => ROOT);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  const spawn: BawSpawn = (_file, _args, _options, callback) => {
    seen.spawned += 1;
    const child = new ChildProcess();
    queueMicrotask(() => { child.emit("spawn"); callback(null, stdout, ""); child.emit("close", 0); });
    return child;
  };
  return new BawRunner(join(ROOT, "fixture.cjs"), spawn);
}

describe("Agentic runner after Revision 3", () => {
  it("refuses limit-order buy, sell and cancel before spawning, with any argv (I9 restored)", async context => {
    const seen = { spawned: 0 };
    const r = await runner(context, '{"success":true,"data":{"strategyId":"9"}}', seen);
    for (const args of [BUY, SELL, CANCEL, [...BUY, "--gasLevel", "fast"], ["limit-order", "amend", "--strategyId", "1"], ["limit-order"]]) {
      await assert.rejects(r.prepare(args, SESSION), /AGENTIC_COMMAND_REFUSED/, args.join(" "));
      await assert.rejects(r.run(args, SESSION), /AGENTIC_COMMAND_REFUSED/, args.join(" "));
    }
    assert.equal(seen.spawned, 0, "nothing was spawned");
  });

  it("keeps limit-order list allowlisted for pairing admission; an empty list is ok and a non-empty one is unparseable (it refuses admission the same way)", async context => {
    const empty = await runner(context, '{"success":true,"data":{"total":0,"page":1,"pageSize":1,"list":[]}}');
    const answer = await empty.run(LIST, SESSION);
    assert.equal(answer.kind, "ok");
    const full = await runner(context, JSON.stringify({ success: true, data: { total: 1, page: 1, pageSize: 1, list: [{ strategyId: "77", orderId: "", status: "WORKING", txHash: null, bookTime: null }] } }));
    const refusedList = await full.run(LIST, SESSION);
    assert.notEqual(refusedList.kind, "ok", "a listed strategy cannot be read: pairing admission refuses wallet_has_limit_orders");
  });
});
