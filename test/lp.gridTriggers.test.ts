/**
 * PHASE3.15 — the grid evaluator's pure layer: the side rule in BOTH pool
 * orderings, the full-cross reading, the durable cross hysteresis (and the
 * reversal that resets it), G1, and the R2.10 net-edge admission.
 *
 * THE DUAL-ORIENTATION OBLIGATION IS THE POINT OF THIS FILE. `wbnbIsToken0`
 * decides which asset a range holds, so every predicate below is exercised on a
 * Case-A pool (WBNB = token1) AND a Case-B pool (WBNB = token0). The 3.12
 * review's F7 and this phase's own H1 are both "a side rule written in role
 * order inverts for half of BSC's pools".
 *
 * OFFLINE, pure: no store, no chain, no clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  evaluateGridTriggers,
  gridCrossReading,
  gridLiveRole,
  gridNetEdge,
  gridRangeMidpointTick,
  gridSideChargesQuote,
  gridTargetRange,
  gridTargetSide,
  lpGridFlipReason,
  lpGridNetEdgeRefusal,
} from "../src/lp/gridTriggers.js";
import {
  DEFAULT_LP_SETTINGS,
  validateLpSettings,
  type LpAutomationSettings,
  type LpGridSettings,
  type LpTriggerObservation,
  type LpTriggerPositionInput,
} from "../src/lp/triggers.js";
import { Q96, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { priceDeviationBps, type LpRailConfig, type LpRailEvidence } from "../src/lp/rails.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");

const INTERVAL_MS = 60_000;
const NOW_MS = 1_900_000_000_000;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 500,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

function market(blockNumber: bigint, tick: number): LpRailEvidence {
  const sqrt = getSqrtRatioAtTick(tick);
  return {
    blockNumber,
    finalizedBlockNumber: blockNumber,
    observationCardinality: 500,
    poolLiquidity: 10n ** 18n,
    priceImpactBps: 0n,
    spotSqrtPriceX96: sqrt,
    twapSqrtPriceX96: sqrt,
  };
}

/** Case A — WBNB is token1, so the buy level sits BELOW the sell level. */
function caseA(): LpGridSettings {
  return {
    pool: { token0: TOKEN_LO, token1: WBNB, fee: 2_500 },
    wbnbIsToken0: false,
    tickSpacing: 50,
    buyRange: { tickLower: -1_000, tickUpper: -500 },
    sellRange: { tickLower: 500, tickUpper: 1_000 },
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
  };
}

/** Case B — WBNB is token0, so the buy level sits ABOVE the sell level. */
function caseB(): LpGridSettings {
  return {
    pool: { token0: WBNB, token1: TOKEN_HI, fee: 2_500 },
    wbnbIsToken0: true,
    tickSpacing: 50,
    buyRange: { tickLower: 500, tickUpper: 1_000 },
    sellRange: { tickLower: -1_000, tickUpper: -500 },
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
  };
}

function settingsFor(grid: LpGridSettings): LpAutomationSettings {
  return { ...DEFAULT_LP_SETTINGS, grid };
}

function positionAt(
  grid: LpGridSettings,
  role: "buy" | "sell",
  currentTick: number,
): LpTriggerPositionInput {
  const range = role === "buy" ? grid.buyRange : grid.sellRange;
  return {
    basisWei: 0n,
    basisSource: "imported",
    collectibleFee0: 0n,
    collectibleFee1: 0n,
    currentTick,
    exitValueWei: 10n ** 18n,
    freshFeesValueWei: 0n,
    poolAddress: POOL,
    token0: grid.pool.token0,
    token1: grid.pool.token1,
    fee: grid.pool.fee,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    tokenId: "42",
  };
}

function evaluate(input: {
  readonly grid: LpGridSettings;
  readonly role: "buy" | "sell";
  readonly tick: number;
  readonly blockNumber?: bigint;
  readonly nowMs?: number;
  readonly previousObservation?: LpTriggerObservation;
  readonly settings?: Partial<LpAutomationSettings>;
}): ReturnType<typeof evaluateGridTriggers> {
  return evaluateGridTriggers({
    settingsDigest: "0xgrid",
    intervalMs: INTERVAL_MS,
    market: market(input.blockNumber ?? 100n, input.tick),
    nowMs: input.nowMs ?? NOW_MS,
    position: positionAt(input.grid, input.role, input.tick),
    ...(input.previousObservation === undefined
      ? {}
      : { previousObservation: input.previousObservation }),
    rails: RAILS,
    settings: { ...settingsFor(input.grid), ...input.settings },
  });
}

/* -------------------------------------------------------------------------- */
/* The side rule                                                              */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.2: which asset a side charges, in POOL ORDER", () => {
  it('"above" charges token0 and "below" charges token1 — so the quote flips with the orientation', () => {
    // WBNB is token0 ⇒ the quote is charged on the "above" side.
    assert.equal(gridSideChargesQuote("above", true), true);
    assert.equal(gridSideChargesQuote("below", true), false);
    // WBNB is token1 ⇒ the mirror. Writing this in role order ("the buy range
    // is below the price") is the H1 inversion.
    assert.equal(gridSideChargesQuote("above", false), false);
    assert.equal(gridSideChargesQuote("below", false), true);
  });
});

describe("PHASE3.15 R2.3/OQ2: the G-gate helper is swaplessRotationSide, not swapSplitIsTotal", () => {
  it("answers undefined INSIDE the range, and a side strictly outside it", () => {
    const target = { tickLower: -1_000, tickUpper: -500 };
    assert.equal(gridTargetSide(-1_001, target), "above");
    assert.equal(gridTargetSide(-500, target), "below");
    assert.equal(gridTargetSide(-750, target), undefined);
  });

  it("REFUSES at t === tickLower, where the rotate's own bind admits — the intended divergence", () => {
    // `swapSplitIsTotal(-1000, -1000, -500)` is TRUE (the strict interior), so
    // the rotate's mint bind admits there while `getMintAmountsForLiquidity`
    // still charges BOTH legs — the 3.13 F4 shape. The grid gate answers
    // `undefined` and refuses. Strictly stricter, deliberately (C9); it must
    // not be reconciled toward the rotate later.
    assert.equal(gridTargetSide(-1_000, { tickLower: -1_000, tickUpper: -500 }), undefined);
  });
});

describe("PHASE3.15 §3.2: a FULL CROSS, in both pool orderings", () => {
  it("Case A: a buy level fills when the tick drops below its lower bound", () => {
    const grid = caseA();
    // Armed: the tick is at or above the buy range, which charges token1 = WBNB.
    assert.deepEqual(
      gridCrossReading({ currentTick: 0, range: grid.buyRange, role: "buy", wbnbIsToken0: false }),
      { side: "below", filled: false },
    );
    // Filled: the tick is strictly below, so the range now charges token0 = base.
    assert.deepEqual(
      gridCrossReading({ currentTick: -1_001, range: grid.buyRange, role: "buy", wbnbIsToken0: false }),
      { side: "above", filled: true },
    );
    // Inside: only partly converted, never a fill.
    assert.deepEqual(
      gridCrossReading({ currentTick: -750, range: grid.buyRange, role: "buy", wbnbIsToken0: false }),
      { side: undefined, filled: false },
    );
  });

  it("Case B: the SAME buy level fills in the OPPOSITE tick direction", () => {
    const grid = caseB();
    // Armed: the tick is below the buy range, which sits above and charges
    // token0 = WBNB.
    assert.deepEqual(
      gridCrossReading({ currentTick: 0, range: grid.buyRange, role: "buy", wbnbIsToken0: true }),
      { side: "above", filled: false },
    );
    // Filled: the tick has risen through it.
    assert.deepEqual(
      gridCrossReading({ currentTick: 1_000, range: grid.buyRange, role: "buy", wbnbIsToken0: true }),
      { side: "below", filled: true },
    );
  });

  it("a SELL level is the mirror of a buy level in each ordering", () => {
    const a = caseA();
    assert.equal(
      gridCrossReading({ currentTick: 1_000, range: a.sellRange, role: "sell", wbnbIsToken0: false }).filled,
      true,
    );
    assert.equal(
      gridCrossReading({ currentTick: 0, range: a.sellRange, role: "sell", wbnbIsToken0: false }).filled,
      false,
    );
    const b = caseB();
    assert.equal(
      gridCrossReading({ currentTick: -1_001, range: b.sellRange, role: "sell", wbnbIsToken0: true }).filled,
      true,
    );
    assert.equal(
      gridCrossReading({ currentTick: 0, range: b.sellRange, role: "sell", wbnbIsToken0: true }).filled,
      false,
    );
  });
});

describe("PHASE3.15: which signed level the live position IS", () => {
  it("matches VERBATIM, and answers null on a near miss", () => {
    const grid = caseA();
    // PHASE3.17 R2.5 AMENDMENT: `gridLiveRole` now answers `{level, role}`
    // against the up-to-four signed ranges. A single-level grid only ever
    // answers level 1, so this pins that the widening did not change what a
    // 3.15 grid resolves to.
    assert.deepEqual(gridLiveRole(grid, grid.buyRange), { level: 1, role: "buy" });
    assert.deepEqual(gridLiveRole(grid, grid.sellRange), { level: 1, role: "sell" });
    assert.equal(
      gridLiveRole(grid, { tickLower: grid.buyRange.tickLower, tickUpper: grid.buyRange.tickUpper + 50 }),
      null,
    );
  });

  it("a filled buy targets the sell range, and vice versa, in both orderings", () => {
    for (const grid of [caseA(), caseB()]) {
      // PHASE3.17 R2.5 AMENDMENT: the target is the SAME LEVEL's other rung, so
      // the signature gained a level. Level 1 of a two-rung grid is 3.15's own
      // behaviour, unchanged.
      assert.deepEqual(gridTargetRange(grid, 1, "buy"), grid.sellRange);
      assert.deepEqual(gridTargetRange(grid, 1, "sell"), grid.buyRange);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The hysteresis                                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15: the cross hysteresis needs TWO comparable observations", () => {
  for (const [label, grid, filledTick] of [
    ["Case A", caseA(), -1_001],
    ["Case B", caseB(), 1_000],
  ] as const) {
    it(`${label}: one observation HOLDS, the second FLIPS`, () => {
      const first = evaluate({ grid, role: "buy", tick: filledTick });
      assert.equal(first.decision, "hold");
      assert.equal(first.nextObservation.gridCrossConsecutive, 1);
      assert.match(String(first.holdReason), /awaiting a second finalized evaluation/u);

      const second = evaluate({
        grid,
        role: "buy",
        tick: filledTick,
        blockNumber: 101n,
        nowMs: NOW_MS + INTERVAL_MS,
        previousObservation: first.nextObservation,
      });
      assert.equal(second.decision, "grid-flip");
      assert.equal(second.nextObservation.gridCrossConsecutive, 2);
      assert.match(second.triggerReason.reason, /filled/u);
    });

    it(`${label}: a REVERSAL back inside the level resets the count to zero`, () => {
      const first = evaluate({ grid, role: "buy", tick: filledTick });
      assert.equal(first.nextObservation.gridCrossConsecutive, 1);
      // Back inside the range — a V3 fill is reversible until settlement, and
      // this is the whole defence against flipping on a wick.
      const inside = evaluate({
        grid,
        role: "buy",
        tick: (grid.buyRange.tickLower + grid.buyRange.tickUpper) / 2,
        blockNumber: 101n,
        nowMs: NOW_MS + INTERVAL_MS,
        previousObservation: first.nextObservation,
      });
      assert.equal(inside.decision, "hold");
      assert.equal(inside.nextObservation.gridCrossConsecutive, 0);
      assert.equal(inside.nextObservation.gridCrossSide, undefined);
      // And a third observation back OUTSIDE starts again at one, not two.
      const again = evaluate({
        grid,
        role: "buy",
        tick: filledTick,
        blockNumber: 102n,
        nowMs: NOW_MS + 2 * INTERVAL_MS,
        previousObservation: inside.nextObservation,
      });
      assert.equal(again.decision, "hold");
      assert.equal(again.nextObservation.gridCrossConsecutive, 1);
    });
  }

  it("two looks at the SAME finalized block are one look", () => {
    const grid = caseA();
    const first = evaluate({ grid, role: "buy", tick: -1_001 });
    const sameBlock = evaluate({
      grid,
      role: "buy",
      tick: -1_001,
      blockNumber: 100n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
    });
    assert.equal(sameBlock.decision, "hold");
    assert.equal(sameBlock.nextObservation.gridCrossConsecutive, 1);
  });

  it("a re-signed settings digest discards the count — a new pair of ranges inherits nothing", () => {
    const grid = caseA();
    const first = evaluate({ grid, role: "buy", tick: -1_001 });
    const reSigned = evaluateGridTriggers({
      settingsDigest: "0xdifferent",
      intervalMs: INTERVAL_MS,
      market: market(101n, -1_001),
      nowMs: NOW_MS + INTERVAL_MS,
      position: positionAt(grid, "buy", -1_001),
      previousObservation: first.nextObservation,
      rails: RAILS,
      settings: settingsFor(grid),
    });
    assert.equal(reSigned.decision, "hold");
    assert.equal(reSigned.nextObservation.gridCrossConsecutive, 1);
    assert.equal(
      reSigned.triggerReason.previousObservationDiscarded,
      "settings-changed",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* G1, protect priority, and the hold vocabulary                              */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.3: G1 — no flip while the tick is INSIDE the target", () => {
  /**
   * WHERE G1 ACTUALLY BITES, stated because the geometry is not obvious.
   *
   * Under the R2.2 ordering constraint a CONFIRMED FILL already implies the
   * tick is strictly beyond the target: a buy level fills only when the price
   * leaves it on the side AWAY from the sell level, and vice versa. So on the
   * normal path G1 is structurally satisfied, and the seam that does the real
   * work is G2 — the mid-flight re-check inside the mint's build, where the
   * price CAN have moved into the target between the settle and the mint.
   *
   * G1 is kept as an explicit conjunct anyway, and the first case below is why:
   * the settings route deliberately allows a re-sign under a live level (M3/C2),
   * so the pair of signed ranges is not immutable for the lifetime of a
   * position. A degenerate pair reaches this branch, and it must HOLD rather
   * than emit a flip whose mint would be sized by the dust leg.
   */
  it("holds — with a reason that reads as strategy, not as an error", () => {
    const degenerate: LpGridSettings = {
      ...caseA(),
      buyRange: { tickLower: -1_000, tickUpper: -500 },
      // OVERLAPS the buy range, so a fill of the buy level leaves the tick
      // INSIDE the target. `validateLpSettings` refuses this pair (asserted
      // below); the evaluator must still fail closed if one ever arrives.
      sellRange: { tickLower: -2_000, tickUpper: -900 },
    };
    const first = evaluate({ grid: degenerate, role: "buy", tick: -1_001 });
    assert.equal(first.nextObservation.gridCrossConsecutive, 1);
    const second = evaluate({
      grid: degenerate,
      role: "buy",
      tick: -1_001,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
    });
    assert.equal(second.nextObservation.gridCrossConsecutive, 2);
    assert.equal(second.decision, "hold");
    assert.match(String(second.holdReason), /INSIDE the signed sell range/u);
    assert.match(String(second.holdReason), /Nothing is wrong and nothing is owed/u);
  });

  it("and the settings validator refuses that pair, so the branch is unreachable by signing", () => {
    assert.throws(
      () =>
        validateLpSettings({
          ...DEFAULT_LP_SETTINGS,
          grid: {
            ...caseA(),
            buyRange: { tickLower: -1_000, tickUpper: -500 },
            sellRange: { tickLower: -2_000, tickUpper: -900 },
          },
        }),
      /overlap or are ordered wrongly/u,
    );
  });

  it("on the LEGAL geometry a confirmed fill always leaves the tick clear of the target, both orderings", () => {
    for (const grid of [caseA(), caseB()]) {
      for (const role of ["buy", "sell"] as const) {
        const live = role === "buy" ? grid.buyRange : grid.sellRange;
        // Pick a tick that fully crosses the live level.
        const crossed = gridSideChargesQuote("above", grid.wbnbIsToken0)
          ? // the quote is charged ABOVE, so a quote-holding level fills downward
            role === "buy" ? live.tickUpper + 1 : live.tickLower - 1
          : role === "buy" ? live.tickLower - 1 : live.tickUpper + 1;
        const reading = gridCrossReading({
          currentTick: crossed,
          range: live,
          role,
          wbnbIsToken0: grid.wbnbIsToken0,
        });
        assert.equal(reading.filled, true, `${role} should be filled at ${crossed}`);
        assert.notEqual(
          gridTargetSide(crossed, gridTargetRange(grid, 1, role)),
          undefined,
          "G1 is structurally satisfied on the legal geometry",
        );
      }
    }
  });
});

describe("PHASE3.15: protect keeps priority for a position with nothing in flight", () => {
  it("a confirmed price stop-loss outranks a confirmed cross", () => {
    const grid = caseA();
    const settings: Partial<LpAutomationSettings> = {
      priceStopLoss: {
        token0: grid.pool.token0,
        token1: grid.pool.token1,
        fee: grid.pool.fee,
        tick: -900,
        when: "at-or-below",
      },
    };
    const first = evaluate({ grid, role: "buy", tick: -1_001, settings });
    const second = evaluate({
      grid,
      role: "buy",
      tick: -1_001,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
      settings,
    });
    // Both counts reached two; protect wins.
    assert.equal(second.nextObservation.gridCrossConsecutive, 2);
    assert.equal(second.decision, "protect-price-stop-loss");
  });
});

describe("PHASE3.15: a level matching neither signed range HOLDS, fail-closed", () => {
  it("names the remedy rather than guessing at a target", () => {
    const grid = caseA();
    const position = {
      ...positionAt(grid, "buy", -2_000),
      tickLower: -3_000,
      tickUpper: -2_500,
    };
    const result = evaluateGridTriggers({
      settingsDigest: "0xgrid",
      intervalMs: INTERVAL_MS,
      market: market(100n, -2_000),
      nowMs: NOW_MS,
      position,
      rails: RAILS,
      settings: settingsFor(grid),
    });
    assert.equal(result.decision, "hold");
    // PHASE3.17 R3.1 AMENDMENT: the sentence now names EVERY signed range there
    // is rather than pair 1's two, because a dual grid has four and "neither"
    // would be false. The remedy clause is unchanged and is re-pinned here.
    assert.match(
      String(result.holdReason),
      /matches none of this grid's signed ranges/u,
    );
    assert.match(String(result.holdReason), /L1 buy \[/u);
    assert.match(String(result.holdReason), /Re-sign the grid block with one range equal to the live level/u);
  });
});

describe("PHASE3.15: the evaluator refuses to run for a non-grid agent", () => {
  it("throws rather than inventing a strategy", () => {
    assert.throws(
      () =>
        evaluateGridTriggers({
          intervalMs: INTERVAL_MS,
          market: market(100n, 0),
          nowMs: NOW_MS,
          position: positionAt(caseA(), "buy", 0),
          rails: RAILS,
          settings: DEFAULT_LP_SETTINGS,
        }),
      /carry no grid block/u,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R2.10 — the net-edge admission                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.10: the net-edge admission", () => {
  const relay = 100_000_000_000_000n; // the shipped placeholder

  /*
   * PHASE3.17 C2 AMENDMENT. `gridNetEdge` now takes an explicit PAIR rather than
   * the whole grid block, because under four rungs the old signature priced
   * level 2's admission on level 1's spread (review2 N2). For a SINGLE-level
   * grid the pair IS `{buyRange, sellRange}` and no level is named, so every
   * assertion in this describe is about byte-identical behaviour.
   */
  const edgeOf = (
    grid: LpGridSettings,
    sizeWei: bigint,
  ): ReturnType<typeof gridNetEdge> =>
    gridNetEdge({
      pair: { buyRange: grid.buyRange, sellRange: grid.sellRange },
      minNetEdgeBps: grid.minNetEdgeBps,
      sizeWei,
      relayFeePerSubmitWei: relay,
    });

  it("measures the gross edge on priceDeviationBps, the SAME scale as rangeWidthBps", () => {
    const grid = caseA();
    const edge = edgeOf(grid, 10n ** 18n);
    assert.equal(
      edge.grossEdgeBps,
      priceDeviationBps(
        getSqrtRatioAtTick(gridRangeMidpointTick(grid.buyRange)),
        getSqrtRatioAtTick(gridRangeMidpointTick(grid.sellRange)),
      ),
    );
  });

  it("is ORIENTATION-NEUTRAL: Case A and Case B produce the same bps", () => {
    // `priceDeviationBps` divides by the smaller squared price, and inverting
    // both prices maps smaller to larger — so one formula serves both.
    const a = edgeOf(caseA(), 10n ** 18n);
    const b = edgeOf(caseB(), 10n ** 18n);
    assert.equal(a.grossEdgeBps, b.grossEdgeBps);
  });

  it("rounds the cost floor UP, so bigint truncation never understates it (C6)", () => {
    // 2 x 1e14 x 10_000 = 2e18. At a size of 3e18 the exact floor is 0.66 bps;
    // truncation would say 0, which is the wrong direction for a conservatism
    // check.
    const edge = edgeOf(caseA(), 3n * 10n ** 18n);
    assert.equal(edge.costFloorBps, 1n);
  });

  it("uses TWO submissions, not the sizing reserve's three", () => {
    const edge = edgeOf(caseA(), 10n ** 20n);
    // 2 x 1e14 x 10_000 / 1e20 = 0.02 bps -> 1 after the ceil.
    assert.equal(edge.costFloorBps, 1n);
  });

  it("fails CLOSED on a zero-value level rather than dividing by zero", () => {
    const edge = edgeOf(caseA(), 0n);
    assert.equal(edge.ok, false);
    assert.ok(edge.costFloorBps > 0n);
  });

  it("refuses when the owner's own minNetEdgeBps is not covered, and says so honestly", () => {
    const tight = edgeOf({ ...caseA(), minNetEdgeBps: 10_000 }, 10n ** 20n);
    assert.equal(tight.ok, false);
    const text = lpGridNetEdgeRefusal(tight, "Grid import refused");
    assert.match(text, /HONEST SCOPE: this bounds RELAY GAS ONLY/u);
    assert.match(text, /adverse selection/u);
    assert.match(text, /widen the gap between the ranges/u);
  });

  it("admits a wide grid at a normal size", () => {
    const edge = edgeOf(caseA(), 10n ** 18n);
    assert.equal(edge.ok, true);
  });
});

/* -------------------------------------------------------------------------- */
/* The ONE sentence both flip seams speak with                                */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.3: one builder for the skip and the refusal", () => {
  const target = { tickLower: 500, tickUpper: 1_000 };

  it("the SKIP names the residue and says no conversion was made", () => {
    const text = lpGridFlipReason({
      outcome: "skipped",
      currentTick: 0,
      target,
      side: "above",
      amount0: 10n ** 15n,
      amount1: 0n,
      residueWei: 12n,
      residueBps: 3n,
    });
    assert.match(text, /NO conversion made/u);
    assert.match(text, /Residue 12 wei \(3 bps\)/u);
    assert.match(text, /a grid never swaps to rebalance/u);
  });

  it("each REFUSAL names the conjunct that failed and keeps the principal safe", () => {
    const common = {
      outcome: "refused" as const,
      currentTick: 700,
      target,
      amount0: 10n ** 15n,
      amount1: 0n,
      residueWei: 0n,
      residueBps: 0n,
    };
    const noSide = lpGridFlipReason({ ...common, side: undefined, failed: "no-side" });
    assert.match(noSide, /INSIDE the target range/u);
    const residue = lpGridFlipReason({
      ...common,
      side: "above",
      residueWei: 99n,
      residueBps: 900n,
      failed: "residue",
    });
    assert.match(residue, /over the 50 bps bound/u);
    const contradiction = lpGridFlipReason({
      ...common,
      side: "below",
      failed: "leg-contradiction",
    });
    assert.match(contradiction, /gapped THROUGH the target/u);
    for (const text of [noSide, residue, contradiction]) {
      assert.match(text, /Principal SAFE in the wallet, held pending-mint/u);
    }
  });
});

describe("PHASE3.15: the midpoint used by the net edge", () => {
  it("is the geometric midpoint tick, floored", () => {
    assert.equal(gridRangeMidpointTick({ tickLower: -1_000, tickUpper: -500 }), -750);
    assert.equal(gridRangeMidpointTick({ tickLower: 0, tickUpper: 1 }), 0);
    // A sanity anchor on the price scale the edge is measured against.
    assert.ok(getSqrtRatioAtTick(0) === Q96);
  });
});
