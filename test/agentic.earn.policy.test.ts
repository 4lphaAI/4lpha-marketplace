/** AGENTIC-EARN-SPEC ET5 (+ R11.8): the sizing vectors V1 to V6 of 3.6, the park cap, the 20 USDT floor, the 24 h and 2 h edges, the redeem order, the ratio-1 conversion, dust, CMC drift and the exposure sentinel. */
import assert from "node:assert/strict";
import test from "node:test";
import { EARN_DUST_WEI, earnDecide, earnNeeds, earnOrder, earnRoundDown, earnRoundUp, type EarnDecision, type EarnDecideInput } from "../src/agentic/earn.js";
import { E, DAY, HOUR, MINUTE, earnWorld } from "./support/agenticEarn.js";

const END = 7 * DAY, cent = E / 100n;
const U = (usdt: number): bigint => BigInt(Math.round(usdt * 100)) * cent;
function decide(p: Partial<EarnDecideInput> & Pick<EarnDecideInput, "capitalWei" | "idleWei" | "needs">): EarnDecision {
  const venus = p.products?.find(x => x.protocol === "venus")?.valueWei ?? p.parkedWei ?? 0n;
  return earnDecide({ now: 0, hireEndMs: END, state: "bound", parkedWei: venus, xWei: 0n, products: [{ protocol: "venus", valueWei: venus, configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }],
    apy: null, canDeposit: true, ...p });
}
const plain = (d: EarnDecision): string => d.action === "redeem" ? `redeem ${d.ratio ? "all" : d.amountWei / cent}` : d.action === "deposit" ? `deposit ${d.amountWei / cent}` : d.action;

test("V1 daily Schedule, C 100, E 10, 7 d: deposit 60, then redeem 20, 10, then the term-end redeem-all (4 operations)", () => {
  const needs = (left: number) => earnNeeds({ lane: "schedule", entryWei: U(10), left, intervalSec: 86_400 });
  assert.deepEqual([needs(7).low, needs(7).high], [U(20), U(30)]);
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(100), needs: needs(7) })), "deposit 6000");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(10), parkedWei: U(60), needs: needs(4), products: [{ protocol: "venus", valueWei: U(60), configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }] })), "redeem 2000");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(10), needs: needs(2), products: [{ protocol: "venus", valueWei: U(40), configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }] })), "redeem 1000");
  assert.deepEqual(decide({ now: END - 2 * HOUR, capitalWei: U(100), idleWei: U(70), needs: needs(0), products: [{ protocol: "venus", valueWei: U(30), configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }] }),
    { action: "redeem-all", protocol: "venus" });
});

test("V2 hourly Schedule, C 100, E 1: deposit 60, redeem 25, 25, then 10 with ratio 1", () => {
  const needs = (left: number) => earnNeeds({ lane: "schedule", entryWei: U(1), left, intervalSec: 3_600 });
  assert.deepEqual([needs(100).low, needs(100).high], [U(2), U(26)]);
  const prod = (v: number) => [{ protocol: "venus" as const, valueWei: U(v), configured: true }, { protocol: "aave-v3" as const, valueWei: 0n, configured: true }];
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(100), needs: needs(100) })), "deposit 6000");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(1), needs: needs(61), products: prod(60) })), "redeem 2500");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(1), needs: needs(36), products: prod(35) })), "redeem 2500");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(1), needs: needs(11), products: prod(10) })), "redeem all");
});

test("V3 AI C 100, E 20, K 5, X 2: deposit 60, redeem 40, redeem 20 with ratio 1 (3 operations)", () => {
  const needs = (slots: number) => earnNeeds({ lane: "ai", entryWei: U(20), slots });
  assert.deepEqual([needs(5).low + U(2), needs(5).high + U(2)], [U(22), U(42)]);
  const prod = (v: number) => [{ protocol: "venus" as const, valueWei: U(v), configured: true }, { protocol: "aave-v3" as const, valueWei: 0n, configured: true }];
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(102), xWei: U(2), needs: needs(5) })), "deposit 6000");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(2), xWei: U(2), needs: needs(3), products: prod(60) })), "redeem 4000");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(2), xWei: U(2), needs: needs(1), products: prod(20) })), "redeem all");
});

test("V4 DCA N 5, B 25, D 10 (C 75), X 0.20: deposit exactly 20.00 (boundary), base then redeem 20 with ratio 1 (2 operations); 19.99 or less funding gives none", () => {
  const needs = (baseNeeded: boolean, undone: number) => earnNeeds({ lane: "dca", baseWei: U(25), orderWei: U(10), ahead: 2, baseNeeded, undone, entriesOpen: true });
  assert.deepEqual([needs(true, 5).low + U(0.2), needs(true, 5).high + U(0.2)], [U(45.2), U(55.2)]);
  assert.equal(plain(decide({ capitalWei: U(75), idleWei: U(75.2), xWei: U(0.2), needs: needs(true, 5) })), "deposit 2000");
  assert.equal(plain(decide({ capitalWei: U(75), idleWei: U(75.19), xWei: U(0.2), needs: needs(true, 5) })), "none", "one cent less funding: D = 19.99");
  assert.equal(plain(decide({ capitalWei: U(75), idleWei: U(30.2), xWei: U(0.2), needs: needs(false, 5), products: [{ protocol: "venus", valueWei: U(20), configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }] })), "none");
  assert.equal(plain(decide({ capitalWei: U(75), idleWei: U(10.2), xWei: U(0.2), needs: needs(false, 3), products: [{ protocol: "venus", valueWei: U(20), configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }] })), "redeem all");
});

test("V5 DCA N 5, B 25, D 20 (C 125): deposit 40, then redeem 40 with ratio 1", () => {
  const needs = (baseNeeded: boolean, undone: number) => earnNeeds({ lane: "dca", baseWei: U(25), orderWei: U(20), ahead: 2, baseNeeded, undone, entriesOpen: true });
  assert.deepEqual([needs(true, 5).low + U(0.2), needs(true, 5).high + U(0.2)], [U(65.2), U(85.2)]);
  assert.equal(plain(decide({ capitalWei: U(125), idleWei: U(125.2), xWei: U(0.2), needs: needs(true, 5) })), "deposit 4000");
  assert.equal(plain(decide({ capitalWei: U(125), idleWei: U(20.2), xWei: U(0.2), needs: needs(false, 3), products: [{ protocol: "venus", valueWei: U(40), configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }] })), "redeem all");
});

test("V6 DCA N 8, B 25, D 10 (C 105): deposit 50, redeem 20, 20, then 10 with ratio 1 (4 operations)", () => {
  const needs = (baseNeeded: boolean, undone: number) => earnNeeds({ lane: "dca", baseWei: U(25), orderWei: U(10), ahead: 2, baseNeeded, undone, entriesOpen: true });
  const prod = (v: number) => [{ protocol: "venus" as const, valueWei: U(v), configured: true }, { protocol: "aave-v3" as const, valueWei: 0n, configured: true }];
  assert.equal(plain(decide({ capitalWei: U(105), idleWei: U(105.2), xWei: U(0.2), needs: needs(true, 8) })), "deposit 5000");
  assert.equal(plain(decide({ capitalWei: U(105), idleWei: U(10.2), xWei: U(0.2), needs: needs(false, 6), products: prod(50) })), "redeem 2000");
  assert.equal(plain(decide({ capitalWei: U(105), idleWei: U(10.2), xWei: U(0.2), needs: needs(false, 4), products: prod(30) })), "redeem 2000");
  assert.equal(plain(decide({ capitalWei: U(105), idleWei: U(10.2), xWei: U(0.2), needs: needs(false, 2), products: prod(10) })), "redeem all");
});

test("P1 the park cap is 60 % of the capital net of what is parked; the deposit is rounded down to a cent; 19.99 gives none and 20.00 a deposit", () => {
  const needs = { low: 0n, high: 0n };
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(500), needs, parkedWei: U(10), products: [{ protocol: "venus", valueWei: U(10), configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }] })), "deposit 5000");
  assert.equal(plain(decide({ capitalWei: U(33.333), idleWei: U(500), needs })), "none", "19.9998 rounds down to 19.99");
  assert.equal(plain(decide({ capitalWei: U(33.34), idleWei: U(500), needs })), "deposit 2000", "20.004 rounds down to 20.00");
  assert.equal(earnRoundDown(19_999n * E / 1000n), U(19.99));
  assert.equal(earnRoundUp(19_991n * E / 1000n), U(20));
});

test("P2 the 24 h and 2 h edges are exact to the millisecond", () => {
  const needs = { low: 0n, high: 0n }, base = { capitalWei: U(100), idleWei: U(100), needs };
  assert.equal(plain(decide({ ...base, now: END - DAY - 1 })), "deposit 6000");
  assert.equal(plain(decide({ ...base, now: END - DAY })), "none");
  const held = { products: [{ protocol: "venus" as const, valueWei: U(30), configured: true }, { protocol: "aave-v3" as const, valueWei: 0n, configured: true }] };
  assert.equal(plain(decide({ ...base, ...held, now: END - 2 * HOUR - 1 })), "none");
  assert.equal(plain(decide({ ...base, ...held, now: END - 2 * HOUR })), "redeem-all");
  assert.equal(plain(decide({ ...base, ...held, state: "ending" })), "redeem-all");
  assert.equal(plain(decide({ ...base, state: "ending" })), "none", "nothing parked: no action");
});

test("P3 the lower APY of the last committed deposit is redeemed first; unknown APYs take the larger balance", () => {
  const two = [{ protocol: "venus" as const, valueWei: U(30), configured: true }, { protocol: "aave-v3" as const, valueWei: U(20), configured: true }];
  assert.deepEqual(earnOrder(two, { venus: 302, "aave-v3": 250 }).map(p => p.protocol), ["aave-v3", "venus"]);
  assert.deepEqual(earnOrder(two, { venus: 250, "aave-v3": 302 }).map(p => p.protocol), ["venus", "aave-v3"]);
  assert.deepEqual(earnOrder(two, null).map(p => p.protocol), ["venus", "aave-v3"], "larger balance first");
  assert.deepEqual(earnOrder(two, { venus: 250, "aave-v3": 250 }).map(p => p.protocol), ["venus", "aave-v3"], "equal: larger balance");
  assert.equal((decide({ capitalWei: U(100), idleWei: U(2), needs: { low: U(20), high: U(40) }, products: two, apy: { venus: 302, "aave-v3": 250 } }) as { protocol: string }).protocol, "aave-v3");
});

test("P4 the ratio-1 conversion: a remainder under 1 USDT or a request past the value takes the whole product", () => {
  const prod = (v: number) => [{ protocol: "venus" as const, valueWei: U(v), configured: true }, { protocol: "aave-v3" as const, valueWei: 0n, configured: true }];
  const needs = { low: U(20), high: U(40) };
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(2), needs, products: prod(41) })), "redeem 3800", "r = 38 against value - 1 = 40: by amount");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(2), needs, products: prod(39) })), "redeem all", "r = 38 >= 39 - 1");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(2), needs, products: prod(39.01) })), "redeem 3800");
  assert.equal(plain(decide({ capitalWei: U(100), idleWei: U(2), needs, products: prod(10) })), "redeem all", "more than the value");
});

test("P5 dust: a product of 0.01 USDT counts, 0.0099 does not", () => {
  const needs = { low: U(20), high: U(40) };
  const one = (valueWei: bigint) => decide({ capitalWei: U(100), idleWei: 0n, needs, parkedWei: valueWei, products: [{ protocol: "venus", valueWei, configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }] });
  assert.equal(one(EARN_DUST_WEI).action, "redeem");
  assert.equal(one(EARN_DUST_WEI - 1n).action, "none");
  assert.equal(decide({ capitalWei: U(100), idleWei: U(2), needs, parkedWei: U(30), products: [{ protocol: "venus", valueWei: U(30), configured: false }, { protocol: "aave-v3", valueWei: 0n, configured: true }] }).action, "blocked", "parked in an unconfigured product cannot be redeemed");
});

test("P6 CMC drift: 24 hourly 0.01 USDT payments (I and X both fall) never trigger a redeem", () => {
  const needs = earnNeeds({ lane: "ai", entryWei: U(20), slots: 4 });
  let idle = U(22), x = U(2);
  for (let i = 0; i < 24; i += 1) {
    assert.equal(decide({ capitalWei: U(150), idleWei: idle, xWei: x, needs, canDeposit: false, parkedWei: U(50), products: [{ protocol: "venus", valueWei: U(50), configured: true }, { protocol: "aave-v3", valueWei: 0n, configured: true }] }).action, "none", String(i));
    idle -= cent; x -= cent;
  }
});

test("P7 exposure sentinel: an unreadable exposure reads as the whole budget and no deposit is made that cycle (lane)", async t => {
  const w = await earnWorld(t, { lane: "ai", usdt: 102n * E });
  w.setX(-1n);
  await w.step();
  assert.equal((await w.rows()).length, 0, "no deposit");
  w.setX((1n << 256n) - 1n);
  await w.step();
  assert.equal((await w.rows()).length, 0, "the sentinel (above the budget) also means no deposit");
  w.setX(2n * E);
  await w.step();
  assert.equal((await w.rows())[0]!.amountAtomic, (60n * E).toString());
});

test("P8 R11.8 Schedule left: an end date and a first-buy time move the anchor and the planned buys (read through the worker's own agent store)", async t => {
  const sec = (ms: number): number => Math.floor(ms / 1000), start = 1_900_000_000_000;
  const hourly = { scheduleIntervalSec: 3_600 };
  const dated = await earnWorld(t, { lane: "schedule", settings: { ...hourly, scheduleEndKind: "date", scheduleEndAtSec: sec(start + 3 * HOUR) } });
  await dated.step();
  assert.equal((await dated.rows())[0]!.amountAtomic, (60n * E).toString(), "3 slots before the end date: high 30, D = min(60, 100 - 30)");
  const first = await earnWorld(t, { lane: "schedule", settings: { ...hourly, scheduleEndKind: "date", scheduleEndAtSec: sec(start + 10 * HOUR), scheduleFirstAtSec: sec(start + 4 * HOUR) } });
  await first.step();
  assert.equal((await first.rows())[0]!.amountAtomic, (40n * E).toString(), "a first buy at +4 h leaves 6 slots before the end date: high 60, D = min(60, 100 - 60)");
  const open = await earnWorld(t, { lane: "schedule", settings: { ...hourly, scheduleEndKind: "budget" } });
  await open.step();
  assert.equal((await open.rows()).length, 0, "left = 10 (the budget): high 100, nothing is free to park");
});

test("P9 audit L-3: parked funds with an exposure above the budget (the sentinel) redeem as if X were the budget, by amount, never everything", async t => {
  const w = await earnWorld(t, { lane: "ai", usdt: 102n * E });
  await w.step();
  w.state.usdt = 2n * E;
  w.setX((1n << 256n) - 1n);
  await w.advance(MINUTE); await w.step();
  const redeem = (await w.rows()).find(r => r.kind === "earn-redeem")!;
  assert.deepEqual([redeem.fromQty, redeem.amountAtomic], ["40", (40n * E).toString()], "high 40 + X 2 - idle 2 = 40, not the whole 60");
});
