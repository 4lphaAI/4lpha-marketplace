/** AGENTIC-DCA Revision 3 (R3.13 pure): ladder vectors, the fire arithmetic (need, minOut, s), the two worst-price vectors, Q, the BNB floors, the cap table, keys and the closed sets. */
import assert from "node:assert/strict";
import test from "node:test";
import { dcaLevelPrice, dcaTpTarget, type DcaPrice } from "../src/trade/dca.js";
import { DCA_BNB_RESERVE_WEI, DCA_BUY_BNB_FLOOR_WEI, DCA_SLIPPAGE_BPS, DCA_STOCKS, DCA_TP_BNB_FLOOR_WEI, dcaBaseDecisionId, dcaBuyNeedRaw, dcaFireDecisionId, dcaFireDecisionPrefix,
  dcaHireBnbFloorWei, dcaMinOut, dcaNextAttempt, dcaOrderKey, dcaOrderTerminal, dcaPriceE8, dcaRoundOpen, dcaRoundStartBnbFloorWei, dcaSellNeedWei, dcaSlippageBps, dcaTpQty } from "../src/agentic/dca.js";

const E = 10n ** 18n;
const price = (value: number): DcaPrice => ({ num: BigInt(Math.round(value * 1e8)), den: 100_000_000n });
const e8 = (p: DcaPrice): string => dcaPriceE8(p).toString();
/** wei / raw token as a decimal number with 4 digits, truncated (USDT per token) */
const unitPrice = (wei: bigint, rawToken: bigint): number => Number(wei * 10_000n / rawToken) / 10_000;

test("P1 levels: P0 700, step 1 %, x1.2 deviation give 693, 684.6, 674.52, 662.424", () => {
  const p0 = price(700);
  assert.deepEqual([1, 2, 3, 4].map(k => e8(dcaLevelPrice(p0, k, 100))), ["69300000000", "68460000000", "67452000000", "66242400000"]);
});

test("P2 need = ceil(D x L.den / L.num), minOut = floor(quote x 9 950 / 10 000), s = min(50, maxSlippageBps)", () => {
  const l1 = dcaLevelPrice(price(700), 1, 100); // 693
  assert.equal(dcaBuyNeedRaw(10n * E, l1), 14_430_014_430_014_431n, "ceil, not floor: 10 / 693 = 0.01443001443001443...");
  assert.equal(dcaBuyNeedRaw(693n * E, { num: 693n, den: 1n }), E, "an exact quotient is not rounded up");
  assert.equal(dcaMinOut(1_000_001n, 50), 995_000n, "floor of 995 000.995");
  assert.equal(dcaMinOut(10_000n, 50), 9_950n);
  assert.deepEqual([dcaSlippageBps(500), dcaSlippageBps(50), dcaSlippageBps(30), dcaSlippageBps(undefined), dcaSlippageBps(1_000)], [50, 50, 30, 50, 50]);
  assert.equal(DCA_SLIPPAGE_BPS, 50);
  assert.equal(dcaMinOut(1_000_000n, 30), 997_000n, "with maxSlippageBps = 30: floor(quote x 9 970 / 10 000)");
});

test("P3 worst prices: a buy at L1 fills no worse than L1 / 0.995 = 696.4824; a TP sale no worse than T x 0.995 = 706.9475 (+0.9925 % over the 700 average)", () => {
  const l1 = dcaLevelPrice(price(700), 1, 100);
  const minOut = dcaMinOut(dcaBuyNeedRaw(10n * E, l1), 50);
  assert.equal(unitPrice(10n * E, minOut), 696.4824, "10 USDT / the least token the order accepts");
  const q = 35_714_285_714_285_714n; // 25 / 700 token
  const target = dcaTpTarget({ costUsdtWei: 25n * E, stockWei: q, takeProfitBps: 150 });
  const sellNeed = dcaSellNeedWei(q, target);
  assert.ok(sellNeed >= 25_375n * 10n ** 15n - 1n && sellNeed <= 25_375n * 10n ** 15n + 1n, sellNeed.toString());
  const sellMin = dcaMinOut(sellNeed, 50);
  assert.equal(unitPrice(sellMin, q), 706.9475, "the least USDT the order accepts per token");
  assert.ok(sellMin >= 25_248_125n * 10n ** 12n - 1n && sellMin <= 25_248_125n * 10n ** 12n + 1n, "25.248125 USDT");
});

test("P4 Q = min(H - sold, balance): the owner's extra stock is never sold, a smaller balance sells the balance", () => {
  assert.equal(dcaTpQty(100n, 0n, 100n), 100n);
  assert.equal(dcaTpQty(100n, 0n, 130n), 100n, "stock the owner added is never sold");
  assert.equal(dcaTpQty(100n, 0n, 60n), 60n);
  assert.equal(dcaTpQty(100n, 40n, 500n), 60n);
  assert.equal(dcaTpQty(100n, 100n, 500n), 0n);
});

test("P5 BNB floors: round start (N + 2) x R, hire gate (2N + 4) x R, level 0.0008, take profit 0.0004", () => {
  assert.equal(DCA_BNB_RESERVE_WEI, 400_000_000_000_000n);
  const wei = (units: bigint) => (units * 10n ** 14n).toString();
  assert.deepEqual([1, 3, 4, 8].map(n => dcaRoundStartBnbFloorWei(n).toString()), [wei(12n), wei(20n), wei(24n), wei(40n)]);
  assert.deepEqual([1, 3, 4, 8].map(n => dcaHireBnbFloorWei(n).toString()), [wei(24n), wei(40n), wei(48n), wei(80n)]);
  assert.equal(DCA_BUY_BNB_FLOOR_WEI, 800_000_000_000_000n);
  assert.equal(DCA_TP_BNB_FLOOR_WEI, 400_000_000_000_000n);
});

test("P6 the 24 h cap table at capital 55 (cap 275): floor(275 / (25 + 10 k)) rounds per day", () => {
  const rows = [0, 1, 2, 3].map(k => [k, 25 + 10 * k, Math.floor(275 / (25 + 10 * k))]);
  assert.deepEqual(rows, [[0, 25, 11], [1, 35, 7], [2, 45, 6], [3, 55, 5]]);
  assert.equal(Math.floor(175 / 25), 7, "the gate hire (capital 35, cap 175) runs 7 rounds with no fill");
  assert.equal(Math.floor(175 / 35), 5, "or 5 with one fill");
});

test("P7 order keys, the attempt rule and the fire decision ids", () => {
  assert.equal(dcaOrderKey("a", 2, "level", 3, 4), "dca:a:2:level3:4");
  assert.equal(dcaOrderKey("a", 2, "tp", null, 1), "dca:a:2:tp:1");
  const key = (round: number, role: "level" | "tp", level: number | null, attempt: number) => ({ orderKey: dcaOrderKey("a", round, role, level, attempt) });
  assert.equal(dcaNextAttempt([], "a", 1, "tp", null), 1);
  assert.equal(dcaNextAttempt([key(1, "tp", null, 1), key(1, "tp", null, 3)], "a", 1, "tp", null), 4);
  assert.equal(dcaNextAttempt([key(1, "level", 2, 5)], "a", 1, "level", 1), 1, "another level has its own attempts");
  assert.equal(dcaNextAttempt([{ orderKey: dcaOrderKey("a", 20, "level", 1, 9) }], "a", 2, "level", 1), 1, "round 20 is not round 2");
  assert.equal(dcaBaseDecisionId("a", 1, 3), "dca:a:1:base:3");
  assert.equal(dcaFireDecisionId("a", 2, "level", 1, 2), "dca:a:2:level1:2");
  assert.equal(dcaFireDecisionId("a", 2, "tp", null, 1), "dca:a:2:tp:1");
  assert.equal(dcaFireDecisionPrefix("a", 2, "level", 1), "dca:a:2:level1:");
  assert.ok(dcaFireDecisionId("a", 2, "level", 1, 3).startsWith(dcaFireDecisionPrefix("a", 2, "level", 1)));
  assert.equal(dcaFireDecisionId("a", 2, "level", 1, 3).startsWith(dcaFireDecisionPrefix("a", 2, "level", 11)), false, "level 1 is not level 11");
});

test("P8 the closed sets: terminal order states, open round phases, the pinned stocks", () => {
  for (const state of ["filled", "cancelled", "expired", "failed", "skipped", "below-range"] as const) assert.equal(dcaOrderTerminal({ state }), true, state);
  for (const state of ["planned", "placing", "resting", "triggered", "cancelling", "held"] as const) assert.equal(dcaOrderTerminal({ state }), false, state);
  for (const phase of ["starting", "active", "closing", "stopping", "winding-down"] as const) assert.equal(dcaRoundOpen({ phase }), true, phase);
  for (const phase of ["settled", "stopped", "ended", "interrupted"] as const) assert.equal(dcaRoundOpen({ phase }), false, phase);
  assert.equal(DCA_STOCKS.size, 17);
  assert.ok(DCA_STOCKS.has("0x7138b48df7d98d7e3cc221bfe7192d0a178182d8"));
});
