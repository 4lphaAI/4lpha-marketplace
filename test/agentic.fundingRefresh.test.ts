import assert from "node:assert/strict";
import { test } from "node:test";
import { E, NOW, fixture } from "./support/agenticSchedule.js";

test("Agentic finalize re-reads only the two chain balances every 10 s inside the one-minute Binance cache", async t => {
  const f = await fixture(t, { state: "verified", hireOpId: null, agentId: null, hireFacts: null });
  const paired = await f.pairings.finalize(f.row), calls = f.runner.calls.length;
  f.balances.usdt = 7n * E;
  f.setTime(NOW + 9_999);
  const cached = await f.pairings.finalize(paired);
  assert.equal(cached.factsRead?.usdtWei, (100n * E).toString()); assert.equal(f.runner.calls.length, calls);
  f.setTime(NOW + 10_000);
  const refreshed = await f.pairings.finalize(cached);
  assert.equal(refreshed.factsRead?.usdtWei, (7n * E).toString()); assert.equal(refreshed.factsRead?.balancesAtMs, NOW + 10_000);
  assert.equal(refreshed.factsRead?.readAtMs, NOW); assert.equal(f.runner.calls.length, calls);
  assert.equal(refreshed.continuationDeadline, paired.continuationDeadline); assert.equal(refreshed.state, "paired");
  f.balances.usdt = 9n * E;
  f.setTime(NOW + 19_999);
  assert.equal((await f.pairings.finalize(refreshed)).factsRead?.usdtWei, (7n * E).toString());
  f.setTime(NOW + 20_000);
  assert.equal((await f.pairings.finalize(refreshed)).factsRead?.usdtWei, (9n * E).toString());
  assert.equal(f.runner.calls.length, calls);
});
