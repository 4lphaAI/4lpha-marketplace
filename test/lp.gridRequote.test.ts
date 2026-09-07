/**
 * PHASE3.18 — the grid REQUOTE's pure layer: the mode split, the signed policy
 * and its coherence rule, the durable identity resolver, the drift arithmetic,
 * G0, the shared economics pair and the evaluator's own hysteresis.
 *
 * TWO POOL ORDERINGS THROUGHOUT, for the reason `lp.gridSettings.test.ts`
 * states and this lineage has paid for twice (3.13 F7 / 3.15 H1): every side
 * rule is orientation-conditioned, and one written in role order inverts for
 * roughly half of BSC's WBNB pools.
 *
 * OFFLINE and pure: parse, validate, derive, evaluate. No store, no chain, no
 * clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { parseLpSettingsParams, lpSettingsParamsView } from "../src/http/lpWire.js";
import { parseLpTriggerObservation } from "../src/store/lpObservations.js";
import {
  gridCycleSubmissions,
  gridDriftReading,
  gridEconomicsPair,
  gridNetEdge,
  gridPolicyGapFor,
  gridRequoteDefaultClamp,
  gridRequoteG0,
  gridRequoteTarget,
  gridRoleAtFor,
  gridTickSeparationBps,
  evaluateGridTriggers,
  LP_GRID_IDENTITY_MISSING_REASON,
} from "../src/lp/gridTriggers.js";
import {
  gridPolicyCoherence,
  gridDeriveDualRanges,
  gridDeriveRanges,
} from "../src/lp/gridGeometry.js";
import {
  DEFAULT_GRID_MAX_REQUOTES_PER_DAY,
  DEFAULT_GRID_REQUOTE_DRIFT_PCT,
  DEFAULT_LP_SETTINGS,
  gridModeOf,
  validateLpSettings,
  type LpAutomationSettings,
  type LpGridSettings,
  type LpTriggerObservation,
} from "../src/lp/triggers.js";
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "../src/lp/tickMath.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
/** Sorts BELOW WBNB ⇒ WBNB is token1 ⇒ `wbnbIsToken0 === false` (Case A here). */
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
/** Sorts ABOVE WBNB ⇒ WBNB is token0 ⇒ `wbnbIsToken0 === true` (Case B here). */
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");

const SPACING = 50;
const GAP = 100;
const WIDTH = 200;
/** The anchor every fixture derives from: a spacing multiple, as the rule needs. */
const ANCHOR = 0;

/**
 * A COHERENT single-level policy grid, built through the SAME derivation
 * `gridPolicyCoherence` checks against — so a fixture can never be coherent by
 * accident or incoherent by transcription.
 */
function policyGrid(
  wbnbIsToken0: boolean,
  overrides: Partial<LpGridSettings> = {},
): LpGridSettings {
  // A SINGLE-level grid derives BOTH rungs from ONE call at the inner gap —
  // using the dual derivation here would place `sellRange` at the OUTER gap and
  // the coherence rule would (correctly) refuse the fixture.
  const derived = gridDeriveRanges({
    currentTick: ANCHOR,
    tickSpacing: SPACING,
    gapTicks: GAP,
    widthTicks: WIDTH,
    wbnbIsToken0,
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
  return {
    pool: wbnbIsToken0
      ? { token0: WBNB, token1: TOKEN_HI, fee: 2_500 }
      : { token0: TOKEN_LO, token1: WBNB, fee: 2_500 },
    wbnbIsToken0,
    tickSpacing: SPACING,
    buyRange: derived.buyRange,
    sellRange: derived.sellRange,
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
    mode: "policy",
    policy: { gapTicks: GAP, widthTicks: WIDTH },
    requote: { driftPctOfGap: 60, maxRequotesPerDay: 21 },
    ...overrides,
  };
}

/** The DUAL form of the same fixture: four rungs, two crossed pairs. */
function dualPolicyGrid(wbnbIsToken0: boolean): LpGridSettings {
  const derived = gridDeriveDualRanges({
    currentTick: ANCHOR,
    tickSpacing: SPACING,
    gapTicks: GAP,
    widthTicks: WIDTH,
    wbnbIsToken0,
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
  return {
    ...policyGrid(wbnbIsToken0),
    buyRange: derived.buyRange,
    sellRange: derived.sellRange,
    buyRange2: derived.buyRange2,
    sellRange2: derived.sellRange2,
  };
}

/** The same geometry with the whole 3.18 block dropped — a FIXED ladder. */
function fixedGrid(wbnbIsToken0: boolean): LpGridSettings {
  const grid = policyGrid(wbnbIsToken0);
  const { mode: _m, policy: _p, requote: _r, ...rest } = grid;
  return rest;
}

function withGrid(grid: LpGridSettings | null): LpAutomationSettings {
  return { ...DEFAULT_LP_SETTINGS, grid };
}

/* -------------------------------------------------------------------------- */
/* R2.2 / C5 — the mode is EXPLICIT, and the three blocks are coupled          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.2: grid.mode is an explicit signed field, absent ⇒ fixed", () => {
  for (const wbnbIsToken0 of [true, false]) {
    it(`absent mode parses and validates as "fixed" (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const grid = fixedGrid(wbnbIsToken0);
      assert.equal(gridModeOf(grid), "fixed");
      validateLpSettings(withGrid(grid));
    });

    it(`a coherent policy grid validates (wbnbIsToken0=${wbnbIsToken0})`, () => {
      validateLpSettings(withGrid(policyGrid(wbnbIsToken0)));
      validateLpSettings(withGrid(dualPolicyGrid(wbnbIsToken0)));
    });
  }

  it("a requote block under mode fixed is REFUSED at signing", () => {
    const grid = { ...fixedGrid(true), requote: { driftPctOfGap: 60, maxRequotesPerDay: 4 } };
    assert.throws(
      () => validateLpSettings(withGrid(grid)),
      /grid\.requote is only meaningful under grid\.mode "policy"/u,
    );
  });

  it("a policy block under mode fixed is REFUSED at signing", () => {
    const grid = { ...fixedGrid(true), policy: { gapTicks: GAP, widthTicks: WIDTH } };
    assert.throws(
      () => validateLpSettings(withGrid(grid)),
      /grid\.policy is only meaningful under grid\.mode "policy"/u,
    );
  });

  it("mode policy WITHOUT grid.policy is refused", () => {
    const { policy: _drop, ...grid } = policyGrid(true);
    assert.throws(
      () => validateLpSettings(withGrid(grid as LpGridSettings)),
      /requires grid\.policy \{gapTicks, widthTicks\}/u,
    );
  });

  it("C5: mode policy WITHOUT a requote block is refused — all cost, no motion", () => {
    const { requote: _drop, ...grid } = policyGrid(true);
    assert.throws(
      () => validateLpSettings(withGrid(grid as LpGridSettings)),
      /requires grid\.requote \{driftPctOfGap, maxRequotesPerDay\}/u,
    );
  });

  it("an unknown mode string is refused", () => {
    const grid = { ...policyGrid(true), mode: "floating" } as unknown as LpGridSettings;
    assert.throws(() => validateLpSettings(withGrid(grid)), /grid\.mode must be/u);
  });
});

/* -------------------------------------------------------------------------- */
/* The wire: present-only-when-set, and the round trip                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18: the three new keys are present-only-when-set", () => {
  it("a FIXED grid's view carries no mode, policy or requote key", () => {
    const view = lpSettingsParamsView(withGrid(fixedGrid(true)));
    const grid = view["grid"] as Record<string, unknown>;
    assert.equal("mode" in grid, false);
    assert.equal("policy" in grid, false);
    assert.equal("requote" in grid, false);
  });

  it("an explicit mode:'fixed' is also dropped — it is the default value", () => {
    const view = lpSettingsParamsView(withGrid({ ...fixedGrid(true), mode: "fixed" }));
    assert.equal("mode" in (view["grid"] as Record<string, unknown>), false);
  });

  it("a POLICY grid round-trips view → parse with every field intact", () => {
    for (const wbnbIsToken0 of [true, false]) {
      const grid = dualPolicyGrid(wbnbIsToken0);
      const parsed = parseLpSettingsParams(lpSettingsParamsView(withGrid(grid)));
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.deepEqual(parsed.value.grid?.mode, "policy");
      assert.deepEqual(parsed.value.grid?.policy, { gapTicks: GAP, widthTicks: WIDTH });
      assert.deepEqual(parsed.value.grid?.requote, {
        driftPctOfGap: 60,
        maxRequotesPerDay: 21,
      });
    }
  });

  it("an unknown key inside policy or requote is refused structurally", () => {
    for (const bad of [
      { policy: { gapTicks: GAP, widthTicks: WIDTH, anchor: 1 } },
      { requote: { driftPctOfGap: 60, maxRequotesPerDay: 4, timerMinutes: 30 } },
    ]) {
      const params = lpSettingsParamsView(withGrid(policyGrid(true)));
      const grid = params["grid"] as Record<string, unknown>;
      const parsed = parseLpSettingsParams({ ...params, grid: { ...grid, ...bad } });
      assert.equal(parsed.ok, false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* R2.1 / C6 — the coherence rule, both orientations, both level counts        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.1/C6: the signed rungs must BE the policy's derivation", () => {
  for (const wbnbIsToken0 of [true, false]) {
    it(`a coherent single pair passes (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const grid = policyGrid(wbnbIsToken0);
      assert.equal(
        gridPolicyCoherence(grid, grid.policy!, { minTick: MIN_TICK, maxTick: MAX_TICK }),
        null,
      );
    });

    it(`a coherent CROSSED PAIR passes — the s+3g+w asymmetry is admitted (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const grid = dualPolicyGrid(wbnbIsToken0);
      assert.equal(
        gridPolicyCoherence(grid, grid.policy!, { minTick: MIN_TICK, maxTick: MAX_TICK }),
        null,
      );
      // The very arithmetic B1 used to prove the policy unrecoverable from the
      // rungs: a level's OWN pair separates by s + 3g + w while the two INNER
      // rungs separate by s + 2g. Pinned so a "simplification" of the coherence
      // check into separation arithmetic fails here.
      const inner = wbnbIsToken0 ? grid.buyRange : grid.sellRange2!;
      const innerOther = wbnbIsToken0 ? grid.sellRange2! : grid.buyRange;
      assert.equal(inner.tickLower - innerOther.tickUpper, SPACING + 2 * GAP);
      const own = wbnbIsToken0 ? grid.buyRange : grid.buyRange;
      const counter = grid.sellRange;
      const ownSeparation = Math.abs(
        wbnbIsToken0 ? own.tickLower - counter.tickUpper : counter.tickLower - own.tickUpper,
      );
      assert.equal(ownSeparation, SPACING + 3 * GAP + WIDTH);
    });

    it(`a rung moved by ONE SPACING is refused (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const grid = policyGrid(wbnbIsToken0);
      const broken: LpGridSettings = {
        ...grid,
        sellRange: {
          tickLower: grid.sellRange.tickLower + SPACING,
          tickUpper: grid.sellRange.tickUpper + SPACING,
        },
      };
      const message = gridPolicyCoherence(broken, grid.policy!, {
        minTick: MIN_TICK,
        maxTick: MAX_TICK,
      });
      assert.match(message ?? "", /is not what grid\.policy/u);
      assert.throws(() => validateLpSettings(withGrid(broken)));
    });

    it(`a WIDTH that disagrees with the rungs is refused (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const grid = policyGrid(wbnbIsToken0);
      const broken = { ...grid, policy: { gapTicks: GAP, widthTicks: WIDTH + SPACING } };
      assert.notEqual(
        gridPolicyCoherence(broken, broken.policy!, {
          minTick: MIN_TICK,
          maxTick: MAX_TICK,
        }),
        null,
      );
    });
  }

  it("a gap/width off the spacing grid is refused before coherence is even asked", () => {
    const grid = { ...policyGrid(true), policy: { gapTicks: 7, widthTicks: WIDTH } };
    assert.throws(
      () => validateLpSettings(withGrid(grid)),
      /not a multiple of the pool's tick spacing/u,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R2.10 — the bounds and the JOINT reachability rule                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.10: bounds and the joint reachability rule", () => {
  it("driftPctOfGap is bounded 25..200", () => {
    for (const value of [24, 201, 0, -1]) {
      const grid = { ...policyGrid(true), requote: { driftPctOfGap: value, maxRequotesPerDay: 4 } };
      assert.throws(
        () => validateLpSettings(withGrid(grid)),
        /driftPctOfGap must be an integer in 25\.\.200/u,
      );
    }
    for (const value of [25, 60, 200]) {
      validateLpSettings(
        withGrid({ ...policyGrid(true), requote: { driftPctOfGap: value, maxRequotesPerDay: 4 } }),
      );
    }
  });

  it("maxRequotesPerDay is bounded 1..24 — the same ceiling every daily count carries", () => {
    for (const value of [0, 25]) {
      const grid = { ...policyGrid(true), requote: { driftPctOfGap: 60, maxRequotesPerDay: value } };
      assert.throws(
        () => validateLpSettings(withGrid(grid)),
        /maxRequotesPerDay must be an integer in 1\.\.24/u,
      );
    }
  });

  it("the JOINT rule refuses a pair the agent-wide spacing gate cannot deliver", () => {
    // minMinutesBetweenExits 60 ⇒ reachable 24; 12 flips + 21 requotes = 33.
    const settings: LpAutomationSettings = {
      ...withGrid(policyGrid(true)),
      minMinutesBetweenExits: 60,
    };
    assert.throws(
      () => validateLpSettings(settings),
      /is unreachable: minMinutesBetweenExits 60 allows at most 24 sequences a day in total/u,
    );
    // The ceiling case is exactly satisfiable, so the bound itself is sound.
    validateLpSettings({
      ...settings,
      grid: {
        ...policyGrid(true),
        maxFlipsPerDay: 12,
        requote: { driftPctOfGap: 60, maxRequotesPerDay: 12 },
      },
    });
  });

  it("the defaults FIT at the LP default spacing of 30 minutes (C9's own arithmetic)", () => {
    validateLpSettings(
      withGrid({
        ...policyGrid(true),
        maxFlipsPerDay: 12,
        requote: {
          driftPctOfGap: DEFAULT_GRID_REQUOTE_DRIFT_PCT,
          maxRequotesPerDay: DEFAULT_GRID_MAX_REQUOTES_PER_DAY,
        },
      }),
    );
    assert.equal(12 + DEFAULT_GRID_MAX_REQUOTES_PER_DAY <= Math.floor(1_440 / 30), true);
  });
});

describe("PHASE3.18 C9/C12(g): the client's default clamp and its disclosure", () => {
  it("at the LP default spacing the defaults are NOT clamped", () => {
    const clamp = gridRequoteDefaultClamp({
      wanted: DEFAULT_GRID_MAX_REQUOTES_PER_DAY,
      maxFlipsPerDay: 12,
      minMinutesBetweenExits: 30,
    });
    assert.equal(clamp.value, DEFAULT_GRID_MAX_REQUOTES_PER_DAY);
    assert.equal(clamp.clamped, false);
    assert.equal(clamp.note, null, "an unclamped default says nothing");
  });

  it("above 43 minutes the default IS clamped, and the note SAYS SO", () => {
    const clamp = gridRequoteDefaultClamp({
      wanted: DEFAULT_GRID_MAX_REQUOTES_PER_DAY,
      maxFlipsPerDay: 12,
      minMinutesBetweenExits: 60,
    });
    assert.equal(clamp.reachable, 24);
    assert.equal(clamp.value, 12, "24 reachable minus 12 flips");
    assert.equal(clamp.clamped, true);
    assert.match(clamp.note ?? "", /CLAMPED from the default 21 to 12/u);
    assert.match(clamp.note ?? "", /never lowers a number you typed/u);
  });

  it("the clamped pair is one the SERVER accepts — the clamp and the rule agree", () => {
    for (const minutes of [30, 45, 60, 90, 120, 240, 720, 1_440]) {
      const clamp = gridRequoteDefaultClamp({
        wanted: DEFAULT_GRID_MAX_REQUOTES_PER_DAY,
        maxFlipsPerDay: 12,
        minMinutesBetweenExits: minutes,
      });
      const reachable = Math.floor(1_440 / minutes);
      // The clamp floors at 1, so a spacing that cannot even fit the flips is
      // still refused BY THE SERVER — the clamp never manufactures a legal pair
      // out of an impossible one, it only avoids proposing an illegal default.
      if (12 + clamp.value <= reachable) {
        validateLpSettings({
          ...withGrid({
            ...policyGrid(true),
            maxFlipsPerDay: 12,
            requote: { driftPctOfGap: 60, maxRequotesPerDay: clamp.value },
          }),
          minMinutesBetweenExits: minutes,
        });
      }
    }
  });

  it("it never RAISES a default", () => {
    const clamp = gridRequoteDefaultClamp({
      wanted: 4,
      maxFlipsPerDay: 1,
      minMinutesBetweenExits: 5,
    });
    assert.equal(clamp.value, 4);
    assert.equal(clamp.clamped, false);
  });
});

/* -------------------------------------------------------------------------- */
/* R2.6 / C1 — the durable identity resolver                                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 C1: identity comes from the columns in policy mode only", () => {
  it("FIXED mode ignores the columns entirely — exact-tick match is the authority", () => {
    const grid = fixedGrid(true);
    // Columns claiming SELL, ticks equal to the BUY rung: fixed mode answers buy.
    const resolved = gridRoleAtFor(grid, grid.buyRange, { gridLevel: 2, gridRole: "sell" });
    assert.deepEqual(resolved, { level: 1, role: "buy" });
    // And a rung matching nothing is null, exactly as before.
    assert.equal(
      gridRoleAtFor(grid, { tickLower: 12_345, tickUpper: 12_845 }, {
        gridLevel: 1,
        gridRole: "buy",
      }),
      null,
    );
  });

  it("POLICY mode answers from the columns even for a rung matching NO signed range", () => {
    const grid = dualPolicyGrid(true);
    // This is the whole of C1: after one requote the live rung equals nothing.
    const drifted = { tickLower: 33_000, tickUpper: 33_200 };
    assert.deepEqual(gridRoleAtFor(grid, drifted, { gridLevel: 2, gridRole: "sell" }), {
      level: 2,
      role: "sell",
    });
  });

  it("C12(b): a NULL column in policy mode answers null — the plane never guesses", () => {
    const grid = policyGrid(true);
    for (const identity of [
      { gridLevel: null, gridRole: "buy" as const },
      { gridLevel: 1 as const, gridRole: null },
      {},
    ]) {
      assert.equal(gridRoleAtFor(grid, grid.buyRange, identity), null);
    }
  });

  it("a level the NEW settings carry no pair for is refused, not invented", () => {
    const single = policyGrid(true);
    assert.equal(gridRoleAtFor(single, single.buyRange, { gridLevel: 2, gridRole: "buy" }), null);
  });

  it("the null-identity remedy names abandon+re-arm, never a re-sign to match ticks", () => {
    assert.match(LP_GRID_IDENTITY_MISSING_REASON, /grid_level\/grid_role/u);
    assert.match(LP_GRID_IDENTITY_MISSING_REASON, /gridArm again/u);
    assert.doesNotMatch(LP_GRID_IDENTITY_MISSING_REASON, /one range equal to the live level/u);
  });
});

/* -------------------------------------------------------------------------- */
/* R2.8 / C8 — the drift arithmetic                                            */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 C8: the gap's bps equivalent is position-independent", () => {
  it("priceDeviationBps over a tick separation depends only on the separation", () => {
    const at = (x: number): bigint =>
      // The exact runtime form C8 pins, evaluated at three unrelated positions.
      gridTickSeparationBps(GAP) === 0n
        ? 0n
        : BigInt(
            // recompute by hand at `x` and compare
            (() => {
              const a = getSqrtRatioAtTick(x);
              const b = getSqrtRatioAtTick(x + GAP);
              const lo = a < b ? a : b;
              const hi = a < b ? b : a;
              return ((hi * hi - lo * lo) * 10_000n) / (lo * lo);
            })(),
          );
    assert.equal(at(0), at(5_000));
    assert.equal(at(0), at(-5_000));
    assert.equal(at(0), gridTickSeparationBps(GAP));
  });
});

describe("PHASE3.18 R2.8: near-edge drift, both orientations", () => {
  for (const wbnbIsToken0 of [true, false]) {
    const grid = policyGrid(wbnbIsToken0);
    // The BUY rung charges the quote. Case A (wbnbIsToken0) puts it ABOVE the
    // corridor, so its near edge is `tickLower`; Case B mirrors it.
    const buy = grid.buyRange;
    const sell = grid.sellRange;

    it(`the near edge is chosen by SIDE, never by role name (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const readBuy = gridDriftReading({
        currentTick: ANCHOR,
        range: buy,
        role: "buy",
        wbnbIsToken0,
        gapTicks: GAP,
        tickSpacing: SPACING,
        driftPctOfGap: 60,
      });
      assert.equal(readBuy.nearEdgeTick, wbnbIsToken0 ? buy.tickLower : buy.tickUpper);
      const readSell = gridDriftReading({
        currentTick: ANCHOR,
        range: sell,
        role: "sell",
        wbnbIsToken0,
        gapTicks: GAP,
        tickSpacing: SPACING,
        driftPctOfGap: 60,
      });
      assert.equal(readSell.nearEdgeTick, wbnbIsToken0 ? sell.tickUpper : sell.tickLower);
    });

    it(`a rung at the policy distance is NOT drifted (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const reading = gridDriftReading({
        currentTick: ANCHOR,
        range: buy,
        role: "buy",
        wbnbIsToken0,
        gapTicks: GAP,
        tickSpacing: SPACING,
        driftPctOfGap: 60,
      });
      assert.equal(reading.unfilled, true);
      assert.equal(reading.drifted, false);
    });

    it(`the price moving AWAY drifts it; moving toward it does not (wbnbIsToken0=${wbnbIsToken0})`, () => {
      // The buy rung is above the tick in Case A: the price falling AWAY from
      // it increases the distance. In Case B it is below and the price must
      // RISE. The test writes both, and neither branch is a role-named rule.
      const away = wbnbIsToken0 ? ANCHOR - 3 * GAP : ANCHOR + 3 * GAP;
      const toward = wbnbIsToken0 ? ANCHOR + GAP / 2 : ANCHOR - GAP / 2;
      const driftedReading = gridDriftReading({
        currentTick: away,
        range: buy,
        role: "buy",
        wbnbIsToken0,
        gapTicks: GAP,
        tickSpacing: SPACING,
        driftPctOfGap: 60,
      });
      assert.equal(driftedReading.drifted, true);
      const nearReading = gridDriftReading({
        currentTick: toward,
        range: buy,
        role: "buy",
        wbnbIsToken0,
        gapTicks: GAP,
        tickSpacing: SPACING,
        driftPctOfGap: 60,
      });
      assert.equal(nearReading.drifted, false);
    });

    it(`a FILLED level never drifts — its motion is the flip (wbnbIsToken0=${wbnbIsToken0})`, () => {
      // Far beyond the rung's FAR edge: the level has changed asset.
      const beyond = wbnbIsToken0 ? buy.tickUpper + 10 * GAP : buy.tickLower - 10 * GAP;
      const reading = gridDriftReading({
        currentTick: beyond,
        range: buy,
        role: "buy",
        wbnbIsToken0,
        gapTicks: GAP,
        tickSpacing: SPACING,
        driftPctOfGap: 60,
      });
      assert.equal(reading.unfilled, false);
      assert.equal(reading.drifted, false);
    });

    it(`a tick INSIDE the rung is neither unfilled-drifted nor sided (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const inside = Math.floor((buy.tickLower + buy.tickUpper) / 2);
      const reading = gridDriftReading({
        currentTick: inside,
        range: buy,
        role: "buy",
        wbnbIsToken0,
        gapTicks: GAP,
        tickSpacing: SPACING,
        driftPctOfGap: 60,
      });
      assert.equal(reading.side, undefined);
      assert.equal(reading.drifted, false);
    });
  }

  it("THE FLOOR: a freshly requoted rung can never immediately re-fire (the 3.13 F1 shape)", () => {
    // With `gapTicks: 0` the spec's own formula gives a threshold of zero, and
    // every re-centre would land at a strictly positive distance — an infinite
    // re-fire, burning the whole lane every day and moving nothing. The floor
    // is `gap + tickSpacing`, which is exactly the largest post-requote drift.
    for (const wbnbIsToken0 of [true, false]) {
      for (const gapTicks of [0, SPACING, GAP]) {
        const tick = 137; // deliberately NOT on the spacing grid
        const target = gridRequoteTarget({
          grid: { ...policyGrid(wbnbIsToken0), policy: { gapTicks, widthTicks: WIDTH } },
          policy: { gapTicks, widthTicks: WIDTH },
          level: 1,
          role: "buy",
          currentTick: tick,
        });
        const reading = gridDriftReading({
          currentTick: tick,
          range: target,
          role: "buy",
          wbnbIsToken0,
          gapTicks,
          tickSpacing: SPACING,
          driftPctOfGap: 25,
        });
        assert.equal(
          reading.drifted,
          false,
          `gap ${gapTicks}, wbnbIsToken0 ${wbnbIsToken0}: a rung the requote just placed must not be drifted`,
        );
        assert.equal(reading.thresholdTicks >= gapTicks + SPACING, true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The target: SAME side, SAME asset, the rung's OWN gap                       */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18: the requote target re-derives on the SAME side", () => {
  for (const wbnbIsToken0 of [true, false]) {
    for (const [level, role] of [
      [1, "buy"],
      [1, "sell"],
      [2, "buy"],
      [2, "sell"],
    ] as const) {
      it(`level ${level} ${role} keeps its side and its OWN gap (wbnbIsToken0=${wbnbIsToken0})`, () => {
        const grid = dualPolicyGrid(wbnbIsToken0);
        const drifted = ANCHOR + 4 * (GAP + WIDTH);
        const target = gridRequoteTarget({
          grid,
          policy: grid.policy!,
          level,
          role,
          currentTick: drifted,
        });
        // SIDE: the target must charge the asset a rung of this role holds.
        const gate = gridRequoteG0({
          currentTick: drifted,
          range: target,
          role,
          wbnbIsToken0,
        });
        assert.equal(gate.ok, true, "the re-centred rung must still be on the armed side");
        // GAP: an OUTER rung re-centres at `2g + w`, an INNER one at `g`.
        // Collapsing that distinction re-creates the B3 pair collapse.
        const expectedGap = gridPolicyGapFor(grid, grid.policy!, level, role);
        const outer = (level === 1 && role === "sell") || (level === 2 && role === "buy");
        assert.equal(expectedGap, outer ? 2 * GAP + WIDTH : GAP);
        assert.equal(target.tickUpper - target.tickLower, WIDTH);
        const nearEdge = gate.side === "above" ? target.tickLower : target.tickUpper;
        assert.equal(Math.abs(nearEdge - drifted) <= expectedGap + SPACING, true);
        assert.equal(Math.abs(nearEdge - drifted) >= expectedGap, true);
      });
    }
  }

  it("a single-level grid derives BOTH rungs at the inner gap", () => {
    const grid = policyGrid(true);
    assert.equal(gridPolicyGapFor(grid, grid.policy!, 1, "buy"), GAP);
    assert.equal(gridPolicyGapFor(grid, grid.policy!, 1, "sell"), GAP);
  });
});

/* -------------------------------------------------------------------------- */
/* R2.9 — G0                                                                   */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.9: G0 requires strictly-outside AND the stored role's side", () => {
  for (const wbnbIsToken0 of [true, false]) {
    const grid = policyGrid(wbnbIsToken0);
    it(`inside the rung ⇒ refused (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const inside = Math.floor((grid.buyRange.tickLower + grid.buyRange.tickUpper) / 2);
      const gate = gridRequoteG0({
        currentTick: inside,
        range: grid.buyRange,
        role: "buy",
        wbnbIsToken0,
      });
      assert.deepEqual(gate, { ok: false, side: undefined });
    });

    it(`a FILLED level ⇒ refused, with a side (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const beyond = wbnbIsToken0
        ? grid.buyRange.tickUpper + GAP
        : grid.buyRange.tickLower - GAP;
      const gate = gridRequoteG0({
        currentTick: beyond,
        range: grid.buyRange,
        role: "buy",
        wbnbIsToken0,
      });
      assert.equal(gate.ok, false);
      assert.notEqual(gate.side, undefined);
    });

    it(`the STORED role decides, so a role/side contradiction is caught (wbnbIsToken0=${wbnbIsToken0})`, () => {
      // The buy rung at the anchor is unfilled FOR A BUY, and its side charges
      // the quote — so calling it a SELL must fail.
      assert.equal(
        gridRequoteG0({
          currentTick: ANCHOR,
          range: grid.buyRange,
          role: "buy",
          wbnbIsToken0,
        }).ok,
        true,
      );
      assert.equal(
        gridRequoteG0({
          currentTick: ANCHOR,
          range: grid.buyRange,
          role: "sell",
          wbnbIsToken0,
        }).ok,
        false,
      );
    });
  }
});

/* -------------------------------------------------------------------------- */
/* C2 — the shared pair builder and the inflated floor                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 C2: ONE pair definition — floating rung + SIGNED counter-rung", () => {
  it("the proposed rung lands in its role's slot; the counter is SIGNED data", () => {
    const grid = dualPolicyGrid(true);
    const proposed = { tickLower: 40_000, tickUpper: 40_200 };
    const asBuy = gridEconomicsPair(grid, 2, "buy", proposed);
    assert.deepEqual(asBuy?.buyRange, proposed);
    assert.deepEqual(asBuy?.sellRange, grid.sellRange2);
    const asSell = gridEconomicsPair(grid, 2, "sell", proposed);
    assert.deepEqual(asSell?.sellRange, proposed);
    assert.deepEqual(asSell?.buyRange, grid.buyRange2);
  });

  it("in FIXED geometry the builder reduces to the signed pair exactly", () => {
    const grid = dualPolicyGrid(false);
    const pair = gridEconomicsPair(grid, 1, "buy", grid.buyRange);
    assert.deepEqual(pair, {
      buyRange: grid.buyRange,
      sellRange: grid.sellRange,
      level: 1,
    });
  });

  it("a level with no signed pair answers null rather than inventing one", () => {
    assert.equal(gridEconomicsPair(policyGrid(true), 2, "buy", { tickLower: 0, tickUpper: 1 }), null);
  });

  it("gridCycleSubmissions is 2 for a fixed grid and 2+2R for a policy one", () => {
    assert.equal(gridCycleSubmissions(fixedGrid(true)), 2);
    assert.equal(gridCycleSubmissions(policyGrid(true)), 2 + 2 * 21);
  });

  it("the INFLATED floor is strictly harder, and the refusal text says how many", () => {
    const grid = policyGrid(true);
    const pair = gridEconomicsPair(grid, 1, "buy", grid.buyRange)!;
    const common = {
      pair,
      minNetEdgeBps: 0,
      sizeWei: 10n ** 17n,
      relayFeePerSubmitWei: 10n ** 14n,
    };
    const flipOnly = gridNetEdge(common);
    const withRequotes = gridNetEdge({
      ...common,
      submissionsPerCycle: gridCycleSubmissions(grid),
    });
    assert.equal(flipOnly.submissionsPerCycle, 2);
    assert.equal(withRequotes.submissionsPerCycle, 44);
    assert.equal(withRequotes.costFloorBps > flipOnly.costFloorBps, true);
  });

  it("the DEFAULT submissions count keeps the 3.15-3.17 floor byte-identical", () => {
    const grid = fixedGrid(true);
    const pair = gridEconomicsPair(grid, 1, "buy", grid.buyRange)!;
    const edge = gridNetEdge({
      pair,
      minNetEdgeBps: 0,
      sizeWei: 10n ** 17n,
      relayFeePerSubmitWei: 10n ** 14n,
    });
    assert.equal(edge.costFloorBps, (2n * 10n ** 14n * 10_000n + edge.sizeWei - 1n) / edge.sizeWei);
  });
});

/* -------------------------------------------------------------------------- */
/* The observation fields — the (ae) trap, a THIRD trigger on                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.8: the drift counter survives the round trip", () => {
  const base: LpTriggerObservation = {
    blockNumber: 100n,
    currentTick: 0,
    evaluatedAtMs: 1_000,
    poolAddress: WBNB,
    protectConsecutive: 0,
    rotationBreach: false,
    rotationConsecutive: 0,
    tokenId: "1",
  };

  it("gridDriftConsecutive and gridDriftSide are rebuilt, not dropped", () => {
    const parsed = parseLpTriggerObservation({
      ...base,
      gridDriftConsecutive: 2,
      gridDriftSide: "above",
    });
    assert.equal(parsed?.gridDriftConsecutive, 2);
    assert.equal(parsed?.gridDriftSide, "above");
  });

  it("absent fields come back ABSENT, never as undefined-valued keys", () => {
    const parsed = parseLpTriggerObservation({ ...base });
    assert.equal(parsed !== null && "gridDriftConsecutive" in parsed, false);
    assert.equal(parsed !== null && "gridDriftSide" in parsed, false);
  });

  it("an unrecognised drift side rejects the WHOLE observation (fail-safe)", () => {
    assert.equal(parseLpTriggerObservation({ ...base, gridDriftSide: "sideways" }), null);
    assert.equal(parseLpTriggerObservation({ ...base, gridDriftConsecutive: -1 }), null);
  });
});

/* -------------------------------------------------------------------------- */
/* The evaluator                                                              */
/* -------------------------------------------------------------------------- */

const RAILS = {
  maxSpotTwapDeviationBps: 10_000,
  minPoolLiquidity: 0n,
  maxPriceImpactBps: 10_000,
  minObservationCardinality: 1,
  twapWindowSeconds: 60,
  maxSagaSlippageBps: 100,
} as const;

function marketAt(blockNumber: bigint) {
  return {
    blockNumber,
    finalizedBlockNumber: blockNumber,
    spotSqrtPriceX96: getSqrtRatioAtTick(0),
    twapSqrtPriceX96: getSqrtRatioAtTick(0),
    poolLiquidity: 10n ** 20n,
    priceImpactBps: 0n,
    observationCardinality: 100,
  };
}

function evaluate(input: {
  grid: LpGridSettings;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  gridLevel?: 1 | 2 | null;
  gridRole?: "buy" | "sell" | null;
  previousObservation?: LpTriggerObservation;
  nowMs?: number;
  blockNumber?: bigint;
}) {
  return evaluateGridTriggers({
    intervalMs: 60_000,
    market: marketAt(input.blockNumber ?? 200n),
    nowMs: input.nowMs ?? 10_000_000,
    settingsDigest: `0x${"11".repeat(32)}`,
    position: {
      basisWei: 0n,
      basisSource: "minted",
      collectibleFee0: 0n,
      collectibleFee1: 0n,
      currentTick: input.currentTick,
      exitValueWei: 10n ** 17n,
      freshFeesValueWei: 0n,
      poolAddress: WBNB,
      token0: input.grid.pool.token0,
      token1: input.grid.pool.token1,
      fee: input.grid.pool.fee,
      tickLower: input.tickLower,
      tickUpper: input.tickUpper,
      tokenId: "7261133",
      gridLevel: input.gridLevel ?? null,
      gridRole: input.gridRole ?? null,
    },
    ...(input.previousObservation === undefined
      ? {}
      : { previousObservation: input.previousObservation }),
    rails: RAILS,
    settings: withGrid(input.grid),
  });
}

describe("PHASE3.18: the evaluator's drift hysteresis", () => {
  for (const wbnbIsToken0 of [true, false]) {
    const grid = policyGrid(wbnbIsToken0);
    const away = wbnbIsToken0 ? ANCHOR - 4 * GAP : ANCHOR + 4 * GAP;

    it(`ONE observation never requotes (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const first = evaluate({
        grid,
        currentTick: away,
        tickLower: grid.buyRange.tickLower,
        tickUpper: grid.buyRange.tickUpper,
        gridLevel: 1,
        gridRole: "buy",
      });
      assert.equal(first.decision, "hold");
      assert.equal(first.nextObservation.gridDriftConsecutive, 1);
      assert.match(first.holdReason ?? "", /awaiting a second finalized evaluation/u);
    });

    it(`TWO consecutive comparable observations DO (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const first = evaluate({
        grid,
        currentTick: away,
        tickLower: grid.buyRange.tickLower,
        tickUpper: grid.buyRange.tickUpper,
        gridLevel: 1,
        gridRole: "buy",
      });
      const second = evaluate({
        grid,
        currentTick: away,
        tickLower: grid.buyRange.tickLower,
        tickUpper: grid.buyRange.tickUpper,
        gridLevel: 1,
        gridRole: "buy",
        previousObservation: first.nextObservation,
        nowMs: 10_120_000,
        blockNumber: 201n,
      });
      assert.equal(second.decision, "grid-requote");
      assert.equal(second.nextObservation.gridDriftConsecutive, 2);
      // R2.3: the target rides the RESULT so the dispatch can persist it.
      assert.notEqual(second.gridRequoteTarget, undefined);
      assert.equal(second.gridRequoteTarget!.tickUpper - second.gridRequoteTarget!.tickLower, WIDTH);
      assert.match(second.triggerReason.reason, /Re-centring on the SAME side/u);
    });

    it(`a REVERSAL resets the count (wbnbIsToken0=${wbnbIsToken0})`, () => {
      const first = evaluate({
        grid,
        currentTick: away,
        tickLower: grid.buyRange.tickLower,
        tickUpper: grid.buyRange.tickUpper,
        gridLevel: 1,
        gridRole: "buy",
      });
      assert.equal(first.nextObservation.gridDriftConsecutive, 1);
      const back = evaluate({
        grid,
        currentTick: ANCHOR,
        tickLower: grid.buyRange.tickLower,
        tickUpper: grid.buyRange.tickUpper,
        gridLevel: 1,
        gridRole: "buy",
        previousObservation: first.nextObservation,
        nowMs: 10_120_000,
        blockNumber: 201n,
      });
      assert.equal(back.decision, "hold");
      assert.equal(back.nextObservation.gridDriftConsecutive ?? 0, 0);
    });
  }
});

describe("PHASE3.18: fixed-mode byte-identity", () => {
  it("a grid WITHOUT the block never emits grid-requote, at any drift", () => {
    for (const wbnbIsToken0 of [true, false]) {
      const grid = fixedGrid(wbnbIsToken0);
      const away = wbnbIsToken0 ? ANCHOR - 20 * GAP : ANCHOR + 20 * GAP;
      let previous: LpTriggerObservation | undefined;
      for (let cycle = 0; cycle < 5; cycle += 1) {
        const result = evaluate({
          grid,
          currentTick: away,
          tickLower: grid.buyRange.tickLower,
          tickUpper: grid.buyRange.tickUpper,
          // Columns present and correct — fixed mode must still never read them.
          gridLevel: 1,
          gridRole: "buy",
          ...(previous === undefined ? {} : { previousObservation: previous }),
          nowMs: 10_000_000 + cycle * 120_000,
          blockNumber: 200n + BigInt(cycle),
        });
        assert.notEqual(result.decision, "grid-requote");
        assert.equal(result.nextObservation.gridDriftConsecutive ?? 0, 0);
        assert.equal("gridDriftSide" in result.nextObservation, false);
        previous = result.nextObservation;
      }
    }
  });
});

describe("PHASE3.18 C12(b): a null column in policy mode HOLDS at the evaluator", () => {
  it("the hold names the identity remedy and emits no decision", () => {
    const grid = policyGrid(true);
    const result = evaluate({
      grid,
      currentTick: ANCHOR - 4 * GAP,
      tickLower: grid.buyRange.tickLower,
      tickUpper: grid.buyRange.tickUpper,
      gridLevel: null,
      gridRole: null,
    });
    assert.equal(result.decision, "hold");
    assert.equal(result.holdReason, LP_GRID_IDENTITY_MISSING_REASON);
  });
});

describe("PHASE3.18 C12(a): the C1 kill test — a REQUOTED level still flips", () => {
  it("a rung matching NO signed range flips into its SIGNED counter-rung", () => {
    for (const wbnbIsToken0 of [true, false]) {
      const grid = dualPolicyGrid(wbnbIsToken0);
      // A requoted level 2 SELL rung: equal to nothing the owner signed.
      const requoted = { tickLower: 30_000, tickUpper: 30_000 + WIDTH };
      // FILLED: the tick is beyond its far edge, so it no longer charges base.
      const filled = wbnbIsToken0 ? requoted.tickLower - 5 * GAP : requoted.tickUpper + 5 * GAP;
      const first = evaluate({
        grid,
        currentTick: filled,
        tickLower: requoted.tickLower,
        tickUpper: requoted.tickUpper,
        gridLevel: 2,
        gridRole: "sell",
      });
      const second = evaluate({
        grid,
        currentTick: filled,
        tickLower: requoted.tickLower,
        tickUpper: requoted.tickUpper,
        gridLevel: 2,
        gridRole: "sell",
        previousObservation: first.nextObservation,
        nowMs: 10_120_000,
        blockNumber: 201n,
      });
      // THE KILL: mutate `gridRoleAtFor`'s policy branch back to
      // `gridLiveRole` and this assertion fails — the evaluator emits no cross
      // reading at all, and the level is dead to automation for ever.
      assert.equal(
        second.decision,
        "grid-flip",
        `wbnbIsToken0 ${wbnbIsToken0}: a requoted level must still flip`,
      );
      // Q5: the target is level 2's SIGNED buy rung, never a policy derivation.
      assert.match(
        second.triggerReason.reason,
        new RegExp(
          `\\[${grid.buyRange2!.tickLower}, ${grid.buyRange2!.tickUpper}\\)`,
          "u",
        ),
      );
    }
  });
});
