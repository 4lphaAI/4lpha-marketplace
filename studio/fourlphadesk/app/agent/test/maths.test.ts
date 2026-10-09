import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allocate,
  checkPortfolio,
  dcaMaxStepBps,
  ladderUnits,
  minCapital,
  planDca,
  planSchedule,
  portfolioSlots,
  suggestDrift,
  type DcaLimits,
  type PortfolioLimits,
  type ScheduleLimits,
} from "../src/desk/maths.js";

const DCA: DcaLimits = { baseMin: 25, orderMin: 10, maxOrders: 8, stepMin: 1, stepMax: 30, tpMin: 1.5 };
const SCHED: ScheduleLimits = { buyMin: 5, reservePct: 5, runsMax: 1000, intervalsHours: [1, 4, 8, 12, 24] };
const PORT: PortfolioLimits = { stocksMin: 2, stocksMax: 5, weightMin: 10, capBase: 50, capBaseStocks: 2, capPerExtra: 25, driftMin: 0.5, driftMax: 15, driftStep: 0.5 };

const dca = (budget: number, atr: number | null, p0: number | null = 100, limits: DcaLimits = DCA) => {
  const p = planDca({ budget, atrPct1h: atr, startPriceUsd: p0, limits });
  assert.ok(p.ok, `plan for ${budget}`);
  return p.ok ? p : (undefined as never);
};

describe("dcaMaxStepBps (step ceiling for N orders)", () => {
  it("matches the hosted ladder rule", () => {
    const want: Record<number, number> = { 1: 3000, 2: 3000, 3: 2472, 4: 1676, 5: 1209, 6: 906, 7: 696, 8: 545 };
    for (const [n, bps] of Object.entries(want)) assert.equal(dcaMaxStepBps(Number(n)), bps, `N=${n}`);
  });
});

describe("ladderUnits (steps grow by 1.2 per level)", () => {
  it("is 1, 2.2, 3.64 for the first three levels", () => {
    assert.ok(Math.abs(ladderUnits(1) - 1) < 1e-12);
    assert.ok(Math.abs(ladderUnits(2) - 2.2) < 1e-12);
    assert.ok(Math.abs(ladderUnits(3) - 3.64) < 1e-12);
  });
});

describe("planDca: sizing", () => {
  it("200 USDT -> base 80, 3 orders of 40, nothing left over", () => {
    const p = dca(200, 1.4);
    assert.equal(p.base, 80);
    assert.equal(p.orders, 3);
    assert.equal(p.orderSize, 40);
    assert.equal(p.total, 200);
    assert.equal(p.leftover, 0);
  });
  it("1000 USDT -> base 400, 3 orders of 200", () => {
    const p = dca(1000, 1.4);
    assert.deepEqual([p.base, p.orders, p.orderSize, p.total], [400, 3, 200, 1000]);
  });
  it("the smallest budget (35) is base 25 plus one order of 10; 34 is refused with the minimum", () => {
    const p = dca(35, 1.4);
    assert.deepEqual([p.base, p.orders, p.orderSize, p.total], [25, 1, 10, 35]);
    const r = planDca({ budget: 34.99, atrPct1h: 1.4, startPriceUsd: 100, limits: DCA });
    assert.deepEqual(r, { ok: false, minBudget: 35 });
  });
  it("137 USDT: orders in steps of 10, the rest goes to the base in steps of 5, under 5 stays outside", () => {
    const p = dca(137, 1.4);
    assert.deepEqual([p.base, p.orders, p.orderSize, p.total, p.leftover], [75, 3, 20, 135, 2]);
  });
  it("60 USDT keeps the 3 orders at the 10 granularity and pushes the rest into the base", () => {
    const p = dca(60, 1.4);
    assert.deepEqual([p.base, p.orders, p.orderSize, p.total, p.leftover], [30, 3, 10, 60, 0]);
  });
  it("never allocates more than the budget and leaves less than one base step outside", () => {
    for (let b = 35; b <= 3000; b += 7.5) {
      const p = dca(b, 1.4);
      assert.ok(p.total <= b + 1e-9, `${b}`);
      assert.ok(p.leftover < 5 + 1e-9, `${b} leftover ${p.leftover}`);
      assert.ok(p.base >= 25 && p.orderSize >= 10 && p.orders >= 1 && p.orders <= 3);
      assert.equal(Math.round((p.base + p.orders * p.orderSize) * 100) / 100, p.total);
    }
  });
  it("follows a changed minimum from the hire link", () => {
    assert.deepEqual(planDca({ budget: 39, atrPct1h: 1, startPriceUsd: 100, limits: { ...DCA, baseMin: 30 } }), { ok: false, minBudget: 40 });
    const p = dca(40, 1, 100, { ...DCA, baseMin: 30 });
    assert.equal(p.base, 30);
  });
  it("respects a lower max-orders limit", () => {
    const p = dca(1000, 1, 100, { ...DCA, maxOrders: 2 });
    assert.equal(p.orders, 2);
  });
});

describe("planDca: step from ATR, clamped", () => {
  it("rounds the 1h ATR to the nearest 0.5", () => {
    assert.equal(dca(200, 1.4).stepPct, 1.5);
    assert.equal(dca(200, 2.74).stepPct, 2.5);
    assert.equal(dca(200, 2.76).stepPct, 3);
    assert.equal(dca(200, 4.0).stepPct, 4);
  });
  it("clamps up to the form minimum and says so", () => {
    const p = dca(200, 0.3);
    assert.equal(p.stepPct, 1);
    assert.equal(p.stepClamped, true);
    assert.equal(p.stepSource, "atr");
  });
  it("clamps down to the ceiling for the order count (24.5 % for 3 orders)", () => {
    const p = dca(200, 50);
    assert.equal(p.orders, 3);
    assert.equal(p.stepCeilingPct, 24.5);
    assert.equal(p.stepPct, 24.5);
    assert.equal(p.stepClamped, true);
  });
  it("the ceiling falls as orders rise (8 orders -> 5 %)", () => {
    const p = dca(1000, 20, 100, { ...DCA, maxOrders: 8 });
    assert.equal(p.orders, 3);
    const many = planDca({ budget: 1000, atrPct1h: 20, startPriceUsd: 100, limits: { ...DCA, orderMin: 10, maxOrders: 8 } });
    assert.ok(many.ok);
  });
  it("uses the minimum when the ATR is missing, zero or negative", () => {
    for (const atr of [null, 0, -1]) {
      const p = dca(200, atr);
      assert.equal(p.stepPct, 1);
      assert.equal(p.stepSource, "minimum");
      assert.equal(p.atrPct, null);
    }
  });
  it("take profit is one step but never below the minimum", () => {
    assert.equal(dca(200, 1.4).tpPct, 1.5);
    assert.equal(dca(200, 4).tpPct, 4);
    assert.equal(dca(200, 0.2).tpPct, 1.5);
    assert.equal(dca(200, 4, 100, { ...DCA, tpMin: 6 }).tpPct, 6);
  });
});

describe("planDca: ladder and stop loss", () => {
  it("levels run base, DCA 1..N with the 1.2 growth and cumulative spend", () => {
    const p = dca(200, 1.4);
    assert.equal(p.levels.length, 4);
    assert.deepEqual(p.levels.map((l) => l.dropPct), [0, 1.5, 3.3, 5.46]);
    assert.deepEqual(p.levels.map((l) => l.cumulativeSpend), [80, 120, 160, 200]);
    assert.deepEqual(p.levels.map((l) => l.priceUsd), [100, 98.5, 96.7, 94.54]);
    assert.equal(p.levels[3]?.cumulativeSpend, p.total);
  });
  it("the average cost falls below the start price and the take profit follows it", () => {
    const p = dca(200, 1.4);
    const l0 = p.levels[0];
    const l3 = p.levels[3];
    assert.equal(l0?.avgCostDropPct, 0);
    assert.equal(l0?.takeProfitAbovePct, 1.5);
    assert.ok((l3?.avgCostDropPct ?? 0) > 0 && (l3?.avgCostDropPct ?? 0) < (l3?.dropPct ?? 0));
    assert.ok((l3?.takeProfitAbovePct ?? 0) < 1.5);
    assert.equal(l3?.grossProfitAtTp, 3);
  });
  it("prices are null without a start price, never zero", () => {
    const p = dca(200, 1.4, null);
    assert.ok(p.levels.every((l) => l.priceUsd === null));
  });
  it("suggests a stop loss between 1 and 99 percent of the total, from the next level's price", () => {
    const p = dca(200, 1.4);
    assert.equal(p.stopLossPct, 7);
    for (const b of [35, 100, 1000, 100000]) {
      const q = dca(b, 30);
      assert.ok(q.stopLossPct >= 1 && q.stopLossPct <= 99);
    }
  });
  it("counts gas slots as 2 x orders + 4", () => {
    assert.equal(dca(200, 1.4).slots, 10);
    assert.equal(dca(35, 1.4).slots, 6);
  });
});

describe("planSchedule", () => {
  it("200 USDT over 7 days: daily is recommended (28.57 per buy)", () => {
    const s = planSchedule({ budget: 200, days: 7, limits: SCHED });
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.deepEqual(s.rows.map((r) => [r.intervalHours, r.runs, r.amountPerBuy, r.feasible]), [
      [1, 168, 1.19, false],
      [4, 42, 4.76, false],
      [8, 21, 9.52, true],
      [12, 14, 14.28, true],
      [24, 7, 28.57, true],
    ]);
    assert.equal(s.recommended.intervalHours, 24);
    assert.equal(s.recommendedRule, "most_frequent_with_min_multiple");
    assert.equal(s.recommended.slots, 10);
  });
  it("the rows come out in frequency order whatever order the limits list them in", () => {
    const s = planSchedule({ budget: 200, days: 7, limits: { ...SCHED, intervalsHours: [24, 1, 12, 4, 8] } });
    assert.ok(s.ok);
    if (s.ok) {
      assert.deepEqual(s.rows.map((r) => r.intervalHours), [1, 4, 8, 12, 24]);
      assert.equal(s.recommended.intervalHours, 24);
    }
  });
  it("amounts are floored to cents so the spend never exceeds the budget", () => {
    const s = planSchedule({ budget: 200, days: 7, limits: SCHED });
    assert.ok(s.ok);
    if (s.ok) for (const r of s.rows) assert.ok(r.spent <= 200 + 1e-9);
  });
  it("a bigger budget over 30 days picks the most frequent frequency with buys of at least 25", () => {
    const s = planSchedule({ budget: 5000, days: 30, limits: SCHED });
    assert.ok(s.ok);
    if (s.ok) {
      assert.equal(s.recommended.intervalHours, 4);
      assert.equal(s.recommended.runs, 180);
      assert.equal(s.recommended.amountPerBuy, 27.77);
    }
  });
  it("falls back to the least frequent feasible one when no buy reaches 25", () => {
    const s = planSchedule({ budget: 100, days: 7, limits: SCHED });
    assert.ok(s.ok);
    if (s.ok) {
      assert.equal(s.recommendedRule, "least_frequent_feasible");
      assert.equal(s.recommended.intervalHours, 24);
      assert.equal(s.recommended.amountPerBuy, 14.28);
    }
  });
  it("refuses only a budget under one buy plus the reserve", () => {
    assert.deepEqual(planSchedule({ budget: 5.2, days: 7, limits: SCHED }), { ok: false, minBudget: 5.25 });
    assert.equal(planSchedule({ budget: 5.25, days: 7, limits: SCHED }).ok, true);
  });
  it("a budget too small for the whole term uses the runs end rule, as the hosted form allows (review M3)", () => {
    const s = planSchedule({ budget: 20, days: 7, limits: SCHED });
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.equal(s.recommendedRule, "runs_end_rule");
    assert.deepEqual([s.recommended.intervalHours, s.recommended.runs, s.recommended.amountPerBuy, s.recommended.endRule], [24, 4, 5, "runs"]);
    assert.equal(s.spentWithinDays, 4);
    assert.ok(s.rows.every((r) => !r.feasible || r.endRule === "budget"));
    assert.ok(s.rows.every((r) => !r.feasible));
  });
  it("runs end rule: one run keeps the 5 % reserve rule (amount <= budget / 1.05); two runs split evenly", () => {
    const one = planSchedule({ budget: 5.25, days: 7, limits: SCHED });
    assert.ok(one.ok && one.recommended.runs === 1 && one.recommended.amountPerBuy === 5);
    const nine = planSchedule({ budget: 9, days: 7, limits: SCHED });
    assert.ok(nine.ok && nine.recommended.runs === 1 && nine.recommended.amountPerBuy === 8.57);
    const two = planSchedule({ budget: 11, days: 7, limits: SCHED });
    assert.ok(two.ok && two.recommended.runs === 2 && two.recommended.amountPerBuy === 5.5);
    for (const b of [5.25, 7, 9, 11, 14.9, 20, 29.99]) {
      const p = planSchedule({ budget: b, days: 7, limits: SCHED });
      assert.ok(p.ok, String(b));
      if (p.ok) {
        assert.ok(p.recommended.amountPerBuy >= 5, String(b));
        assert.ok(p.recommended.amountPerBuy * p.recommended.runs <= b + 1e-9, String(b));
        assert.ok(p.recommended.amountPerBuy * 1.05 <= b + 1e-9, String(b));
      }
    }
  });
  it("a full-term frequency whose single buy would break the 5 % reserve is not feasible", () => {
    const p = planSchedule({ budget: 5.25, days: 1, limits: SCHED });
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.ok(p.rows.find((r) => r.intervalHours === 24 && r.runs === 1)?.feasible === false);
    assert.equal(p.recommended.endRule, "runs");
    assert.equal(p.recommended.amountPerBuy, 5);
  });
  it("the runs end rule respects the runs limit", () => {
    const p = planSchedule({ budget: 20, days: 7, limits: { ...SCHED, runsMax: 2 } });
    assert.ok(p.ok);
    if (p.ok) assert.equal(p.recommended.runs, 2);
  });
  it("a full-term plan keeps the budget end rule", () => {
    const p = planSchedule({ budget: 200, days: 7, limits: SCHED });
    assert.ok(p.ok && p.recommended.endRule === "budget" && p.spentWithinDays === 7);
  });
  it("drops frequencies that exceed the runs limit", () => {
    const s = planSchedule({ budget: 5000, days: 30, limits: { ...SCHED, runsMax: 100 } });
    assert.ok(s.ok);
    if (s.ok) assert.deepEqual(s.rows.filter((r) => r.feasible).map((r) => r.intervalHours), [8, 12, 24]);
  });
});

describe("checkPortfolio", () => {
  const w3 = [{ ticker: "NVDA", weightPct: 40 }, { ticker: "MSFT", weightPct: 30 }, { ticker: "SPY", weightPct: 30 }];
  const accepted = new Map<string, boolean | null>([["NVDA", true], ["MSFT", true], ["SPY", true]]);
  const run = (capital: number, weights = w3, acc = accepted) => checkPortfolio({ capital, weights, accepted: acc, limits: PORT });
  const failed = (cs: ReturnType<typeof run>) => cs.filter((c) => !c.pass).map((c) => c.rule);

  it("passes the documented example", () => {
    assert.deepEqual(failed(run(150)), []);
  });
  it("a weight of exactly the minimum passes", () => {
    assert.deepEqual(failed(run(150, [{ ticker: "NVDA", weightPct: 90 }, { ticker: "MSFT", weightPct: 10 }])), []);
  });
  it("minimum capital is 50 for two stocks plus 25 per extra", () => {
    assert.equal(minCapital(2, PORT), 50);
    assert.equal(minCapital(3, PORT), 75);
    assert.equal(minCapital(5, PORT), 125);
    assert.deepEqual(failed(run(74.99)).length, 1);
    assert.deepEqual(failed(run(75)), []);
  });
  it("flags each rule on its own", () => {
    assert.equal(failed(run(150, [{ ticker: "A", weightPct: 100 }])).some((r) => r.includes("stocks")), true);
    const six = "ABCDEF".split("").map((t, i) => ({ ticker: t, weightPct: i === 0 ? 20 : 16 }));
    assert.equal(failed(run(1000, six, new Map(six.map((s) => [s.ticker, true])))).some((r) => r.includes("2 to 5")), true);
    assert.ok(failed(run(150, [{ ticker: "NVDA", weightPct: 91 }, { ticker: "MSFT", weightPct: 9 }])).some((r) => r.includes("at least 10")));
    assert.ok(failed(run(150, [{ ticker: "NVDA", weightPct: 50 }, { ticker: "MSFT", weightPct: 40 }])).some((r) => r.includes("100")));
    assert.ok(failed(run(150, [{ ticker: "NVDA", weightPct: 50.5 }, { ticker: "MSFT", weightPct: 49.5 }])).some((r) => r.includes("whole")));
  });
  it("flags a stock the hosted agent does not accept and one that could not be checked", () => {
    const acc = new Map<string, boolean | null>([["NVDA", true], ["MSFT", false], ["SPY", null]]);
    const c = run(150, w3, acc).find((x) => x.rule.includes("accepts"));
    assert.equal(c?.pass, false);
    const none = run(150, w3, new Map([["NVDA", true], ["MSFT", true], ["SPY", null]])).find((x) => x.rule.includes("accepts"));
    assert.equal(none?.pass, false);
    assert.match(none?.detail ?? "", /could not be checked: SPY/);
    const no = run(150, w3, new Map([["NVDA", true], ["MSFT", false], ["SPY", true]])).find((x) => x.rule.includes("accepts"));
    assert.match(no?.detail ?? "", /not accepted: MSFT/);
  });
  it("follows changed limits", () => {
    const strict = { ...PORT, weightMin: 35 };
    assert.ok(checkPortfolio({ capital: 150, weights: w3, accepted, limits: strict }).some((c) => !c.pass && c.rule.includes("35")));
  });
});

describe("allocate and suggestDrift", () => {
  it("allocates capital by weight, rounded to cents", () => {
    const a = allocate(150, [{ ticker: "NVDA", weightPct: 40 }, { ticker: "MSFT", weightPct: 30 }, { ticker: "SPY", weightPct: 30 }]);
    assert.deepEqual(a.map((x) => x.usdt), [60, 45, 45]);
    const b = allocate(100, [{ ticker: "A", weightPct: 33 }, { ticker: "B", weightPct: 33 }, { ticker: "C", weightPct: 34 }]);
    assert.deepEqual(b.map((x) => x.usdt), [33, 33, 34]);
    assert.deepEqual(allocate(99.99, [{ ticker: "A", weightPct: 33 }, { ticker: "B", weightPct: 67 }]).map((x) => x.usdt), [33, 66.99]);
  });
  it("drift is five times the worst exit cost, on the 0.5 grid, between 1 % and 15 %", () => {
    assert.equal(suggestDrift(null, PORT), null);
    assert.equal(suggestDrift(-1, PORT), null);
    assert.equal(suggestDrift(0, PORT), 1);
    assert.equal(suggestDrift(10, PORT), 1);
    assert.equal(suggestDrift(30, PORT), 1.5);
    assert.equal(suggestDrift(31, PORT), 2);
    assert.equal(suggestDrift(164, PORT), 8.5);
    assert.equal(suggestDrift(400, PORT), 15);
    assert.equal(suggestDrift(5000, PORT), 15);
  });
  it("portfolio gas slots are 2 per stock plus 2", () => {
    assert.equal(portfolioSlots(3), 8);
    assert.equal(portfolioSlots(5), 12);
  });
});
