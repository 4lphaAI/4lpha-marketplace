/**
 * Truth-table suite for `evaluateLpTriggers` (PHASE3 port of the 0G decision
 * gate): priority protect > rotate > harvest with one action per evaluation,
 * the 2-consecutive-finalized-observations rules, hysteresis (band + minimum
 * hold), rails vetoes, quota-agnosticism, and Rev2 item 17's required lineage
 * stop-loss test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_HARVEST_MIN_FEES_WEI,
  DEFAULT_LP_SETTINGS,
  evaluateLpTriggers,
  lpHarvestRangeHoldReason,
  validateLpSettings,
  type EvaluateLpTriggersInput,
  type EvaluateLpTriggersResult,
  type LpAutomationSettings,
  type LpTriggerObservation,
  type LpTriggerPositionInput,
} from "../src/lp/triggers.js";
import type { LpRailConfig, LpRailEvidence } from "../src/lp/rails.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";

const POOL = "0x1111111111111111111111111111111111111111" as const;
const OTHER_POOL = "0x2222222222222222222222222222222222222222" as const;
const ONE = 10n ** 18n;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 100,
  maxSpotTwapDeviationBps: 100,
  minObservationCardinality: 8,
  minPoolLiquidity: 10_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 500,
};

type InputOverrides = {
  market?: Partial<LpRailEvidence>;
  position?: Partial<LpTriggerPositionInput>;
  settings?: Partial<LpAutomationSettings>;
  nowMs?: number;
  intervalMs?: number;
  previousObservation?: LpTriggerObservation;
  rails?: Partial<LpRailConfig>;
};

function makeInput(overrides: InputOverrides = {}): EvaluateLpTriggersInput {
  const spot = getSqrtRatioAtTick(0);
  const market: LpRailEvidence = {
    blockNumber: 100n,
    finalizedBlockNumber: 100n,
    observationCardinality: 32,
    poolLiquidity: 1_000_000n,
    priceImpactBps: 10n,
    spotSqrtPriceX96: spot,
    twapSqrtPriceX96: spot,
    ...overrides.market,
  };
  const position: LpTriggerPositionInput = {
    basisWei: 10n * ONE,
    basisSource: "minted",
    collectibleFee0: 0n,
    collectibleFee1: 0n,
    currentTick: 0,
    exitValueWei: 10n * ONE,
    freshFeesValueWei: 0n,
    poolAddress: POOL,
    token0: "0x1111111111111111111111111111111111111111",
    token1: "0x2222222222222222222222222222222222222222",
    fee: 2500,
    tickLower: -100,
    tickUpper: 100,
    tokenId: "7",
  };
  const settings: LpAutomationSettings = {
    ...DEFAULT_LP_SETTINGS,
    rotateMinHoldMinutes: 1,
    stopLossPct: 10,
    takeProfitPct: 20,
    harvestMinFeesWei: ONE / 10n, // 0.1 BNB, mirrors the 0G vectors
    ...overrides.settings,
  };
  return {
    intervalMs: overrides.intervalMs ?? 60_000,
    market,
    nowMs: overrides.nowMs ?? 1_000_000,
    position: { ...position, ...overrides.position },
    ...(overrides.previousObservation === undefined
      ? {}
      : { previousObservation: overrides.previousObservation }),
    rails: { ...RAILS, ...overrides.rails },
    settings,
  };
}

/** Advance one full cycle: next finalized block, one interval later. */
function nextCycle(
  first: EvaluateLpTriggersResult,
  overrides: InputOverrides = {},
): EvaluateLpTriggersInput {
  return makeInput({
    ...overrides,
    market: { blockNumber: 101n, finalizedBlockNumber: 101n, ...overrides.market },
    nowMs: overrides.nowMs ?? 1_060_000,
    previousObservation: first.nextObservation,
  });
}

/** Put the position out of range at `tick` with a clean market at that tick. */
function outOfRangeAt(tick: number): InputOverrides {
  return {
    position: { currentTick: tick },
    market: {
      spotSqrtPriceX96: getSqrtRatioAtTick(tick),
      twapSqrtPriceX96: getSqrtRatioAtTick(tick),
    },
    settings: { autoRotate: true },
  };
}

describe("settings validation (spec table + Rev2 item 39)", () => {
  it("accepts the defaults", () => {
    assert.doesNotThrow(() => validateLpSettings(DEFAULT_LP_SETTINGS));
    assert.equal(DEFAULT_HARVEST_MIN_FEES_WEI, 2_000_000_000_000_000n); // 0.002 BNB
  });

  it("enforces every range in the table", () => {
    const bad: readonly (readonly [Partial<LpAutomationSettings>, RegExp])[] = [
      [{ rotateBandBps: -1 }, /rotateBandBps/u],
      [{ rotateBandBps: 5_001 }, /rotateBandBps/u],
      [{ rotateBandBps: 1.5 }, /rotateBandBps/u],
      [{ rotateMinHoldMinutes: -1 }, /rotateMinHoldMinutes/u],
      [{ harvestMinFeesWei: 0n }, /harvestMinFeesWei/u],
      [{ harvestMinFeesWei: -1n }, /harvestMinFeesWei/u],
      [{ stopLossPct: -1 }, /stopLossPct/u],
      [{ stopLossPct: 91 }, /stopLossPct/u],
      [{ takeProfitPct: 501 }, /takeProfitPct/u],
      [{ takeProfitPct: -1 }, /takeProfitPct/u],
      [{ maxExitSequencesPerDay: 0 }, /maxExitSequencesPerDay/u],
      [{ maxExitSequencesPerDay: 25 }, /maxExitSequencesPerDay/u],
      [{ minMinutesBetweenExits: 4 }, /minMinutesBetweenExits/u],
      [{ minMinutesBetweenExits: 1_441 }, /minMinutesBetweenExits/u],
      [{ minAprBps: -1 }, /minAprBps/u],
      [{ minAprBps: 1_000_001 }, /minAprBps/u],
    ];
    for (const [override, pattern] of bad) {
      assert.throws(
        () => validateLpSettings({ ...DEFAULT_LP_SETTINGS, ...override }),
        pattern,
        JSON.stringify(override, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      );
    }
  });

  it("refuses the v1-fenced upgrade seams by name", () => {
    assert.throws(
      () => validateLpSettings({ ...DEFAULT_LP_SETTINGS, stakingEnabled: true }),
      /reserved for the CAKE phase/u,
    );
    assert.throws(
      () => validateLpSettings({ ...DEFAULT_LP_SETTINGS, accumulateMode: "accumulate" }),
      /"compound"/u,
    );
  });

  it("evaluateLpTriggers refuses invalid settings and inputs outright", () => {
    assert.throws(() => evaluateLpTriggers(makeInput({ settings: { stopLossPct: 91 } })));
    assert.throws(() => evaluateLpTriggers(makeInput({ position: { tokenId: "-1" } })), /tokenId/u);
    assert.throws(
      () => evaluateLpTriggers(makeInput({ position: { tickLower: 100, tickUpper: 100 } })),
      /ticks/u,
    );
    assert.throws(() => evaluateLpTriggers(makeInput({ intervalMs: 0 })), /intervalMs/u);
    assert.throws(() => evaluateLpTriggers(makeInput({ position: { basisWei: -1n } })), /nonnegative/u);
    assert.throws(
      () => evaluateLpTriggers(makeInput({ rails: { maxSagaSlippageBps: 0 } })),
      /maxSagaSlippageBps/u,
    );
  });
});

describe("protect matrix", () => {
  it("holds an in-range position with no breached threshold", () => {
    const result = evaluateLpTriggers(makeInput());
    assert.equal(result.decision, "hold");
    assert.equal(result.railsPassed, true);
    assert.equal(result.holdReason, "No LP management trigger is ready.");
  });

  it("excludes a zero lineage basis from both protect directions", () => {
    const result = evaluateLpTriggers(
      makeInput({ position: { basisWei: 0n, exitValueWei: 0n } }),
    );
    assert.equal(result.decision, "hold");
    assert.equal(result.triggerReason.basisSource, "zero-excluded");
    assert.match(result.holdReason ?? "", /basis is zero/u);
  });

  it("does not let a zero basis suppress an independently valid harvest", () => {
    const result = evaluateLpTriggers(
      makeInput({
        position: {
          basisWei: 0n,
          collectibleFee0: 1n,
          collectibleFee1: 1n,
          freshFeesValueWei: ONE / 10n,
        },
        settings: { autoHarvest: true },
      }),
    );
    assert.equal(result.decision, "harvest");
  });

  it("requires two finalized stop-loss observations, strictly newer by block and >= 1 interval apart", () => {
    const breached = { exitValueWei: (89n * ONE) / 10n }; // -11% vs basis 10
    const first = evaluateLpTriggers(makeInput({ position: breached }));
    assert.equal(first.decision, "hold");
    assert.equal(first.nextObservation.protectConsecutive, 1);
    assert.match(first.holdReason ?? "", /second finalized evaluation/u);

    // Same block: not comparable, still consecutive=1.
    const sameBlock = evaluateLpTriggers(
      makeInput({
        position: breached,
        nowMs: 1_060_000,
        previousObservation: first.nextObservation,
      }),
    );
    assert.equal(sameBlock.decision, "hold");
    assert.equal(sameBlock.nextObservation.protectConsecutive, 1);

    // New block but under one interval: not comparable.
    const tooSoon = evaluateLpTriggers(
      nextCycle(first, { position: breached, nowMs: 1_059_999 }),
    );
    assert.equal(tooSoon.decision, "hold");

    // New finalized block, one interval later: fires.
    const second = evaluateLpTriggers(nextCycle(first, { position: breached }));
    assert.equal(second.decision, "protect-stop-loss");
    assert.equal(second.triggerReason.thresholdBps, "-1000");
    assert.equal(second.triggerReason.pnlBps, "-1100");
  });

  it("requires two observations for take-profit as well", () => {
    const breached = { exitValueWei: (121n * ONE) / 10n }; // +21% vs basis 10
    const first = evaluateLpTriggers(makeInput({ position: breached }));
    assert.equal(first.decision, "hold");
    const second = evaluateLpTriggers(nextCycle(first, { position: breached }));
    assert.equal(second.decision, "protect-take-profit");
    assert.equal(second.triggerReason.thresholdBps, "2000");
  });

  it("a breach that flips direction between observations restarts the count", () => {
    const first = evaluateLpTriggers(makeInput({ position: { exitValueWei: (89n * ONE) / 10n } }));
    const flipped = evaluateLpTriggers(
      nextCycle(first, { position: { exitValueWei: (121n * ONE) / 10n } }),
    );
    assert.equal(flipped.decision, "hold");
    assert.equal(flipped.nextObservation.protectBreach, "take-profit");
    assert.equal(flipped.nextObservation.protectConsecutive, 1);
  });

  it("an observation from another position or pool is never comparable", () => {
    const breached = { exitValueWei: (89n * ONE) / 10n };
    const first = evaluateLpTriggers(makeInput({ position: breached }));
    const otherToken = evaluateLpTriggers(
      nextCycle(first, { position: { ...breached, tokenId: "8" } }),
    );
    assert.equal(otherToken.decision, "hold");
    assert.equal(otherToken.nextObservation.protectConsecutive, 1);
    const otherPool = evaluateLpTriggers(
      nextCycle(first, { position: { ...breached, poolAddress: OTHER_POOL } }),
    );
    assert.equal(otherPool.decision, "hold");
  });

  it("rejects a confirmed protect when the spot/TWAP rail fails", () => {
    for (const exitValueWei of [(89n * ONE) / 10n, (121n * ONE) / 10n]) {
      const first = evaluateLpTriggers(makeInput({ position: { exitValueWei } }));
      const second = evaluateLpTriggers(
        nextCycle(first, {
          position: { exitValueWei },
          market: { twapSqrtPriceX96: getSqrtRatioAtTick(-500) },
        }),
      );
      assert.equal(second.decision, "hold");
      assert.equal(second.railsPassed, false);
      assert.match(second.holdReason ?? "", /TWAP deviation/u);
    }
  });

  it("prioritizes a confirmed protect over a simultaneously confirmed rotate", () => {
    const both: InputOverrides = {
      ...outOfRangeAt(150),
      position: { currentTick: 150, exitValueWei: (89n * ONE) / 10n },
    };
    const first = evaluateLpTriggers(makeInput(both));
    const second = evaluateLpTriggers(nextCycle(first, both));
    assert.equal(second.decision, "protect-stop-loss");
  });
});

describe("Rev2 item 17: the lineage basis survives rotation", () => {
  it("fires a 10% stop-loss on cumulative loss across a 2-rotation 4%-per-rotation bleed", () => {
    // The lineage basis is 10 BNB, recorded at open and CARRIED UNCHANGED —
    // the caller never re-bases on rotate. Each rotation bleeds ~4%.
    const basisWei = 10n * ONE;
    const afterRotation1 = (96n * ONE * 10n) / 100n; // 9.6  (-4%)
    const afterRotation2 = (9216n * ONE) / 1000n; // 9.216 (-7.84% cumulative)
    const afterDrift = (89n * ONE) / 10n; // 8.9  (-11% cumulative)

    // During the bleed, no single step crosses 10%: the evaluator holds.
    for (const exitValueWei of [afterRotation1, afterRotation2]) {
      const result = evaluateLpTriggers(makeInput({ position: { basisWei, exitValueWei } }));
      assert.equal(result.decision, "hold");
      assert.equal(result.nextObservation.protectConsecutive, 0);
    }

    // Post-rotation drift takes the LINEAGE past -10%: protect fires after
    // the standard two finalized observations.
    const first = evaluateLpTriggers(
      makeInput({ position: { basisWei, exitValueWei: afterDrift } }),
    );
    const second = evaluateLpTriggers(
      nextCycle(first, { position: { basisWei, exitValueWei: afterDrift } }),
    );
    assert.equal(second.decision, "protect-stop-loss");
    assert.equal(second.triggerReason.basisWei, basisWei.toString());

    // The counterfactual the rule exists to kill: a basis RE-BASED at the
    // last rotation (9.216) sees only a -3.4% move and never protects. This
    // is exactly the churn-defeats-stop-loss trap.
    const rebasedFirst = evaluateLpTriggers(
      makeInput({ position: { basisWei: afterRotation2, exitValueWei: afterDrift } }),
    );
    const rebasedSecond = evaluateLpTriggers(
      nextCycle(rebasedFirst, {
        position: { basisWei: afterRotation2, exitValueWei: afterDrift },
      }),
    );
    assert.equal(rebasedSecond.decision, "hold");
  });
});

describe("rotation matrix", () => {
  it("does not rotate while the current tick remains in range", () => {
    const result = evaluateLpTriggers(makeInput({ settings: { autoRotate: true } }));
    assert.equal(result.decision, "hold");
    assert.equal(result.nextObservation.rotationBreach, false);
  });

  it("treats the upper bound as EXCLUSIVE: currentTick === tickUpper is out of range", () => {
    const result = evaluateLpTriggers(makeInput(outOfRangeAt(100)));
    assert.equal(result.nextObservation.rotationBreach, true);
  });

  it("never rotates when autoRotate is off, however far out of range", () => {
    const result = evaluateLpTriggers(
      makeInput({ ...outOfRangeAt(5_000), settings: { autoRotate: false } }),
    );
    assert.equal(result.nextObservation.rotationBreach, false);
    assert.equal(result.decision, "hold");
  });

  it("requires the band, two cycles, and the minimum hold from breach start", () => {
    const breach = outOfRangeAt(150);
    const first = evaluateLpTriggers(makeInput(breach));
    assert.equal(first.decision, "hold");
    assert.equal(first.nextObservation.rotationConsecutive, 1);
    assert.equal(first.nextObservation.rotationBreachStartedAtMs, 1_000_000);
    assert.match(first.holdReason ?? "", /two finalized cycles and the configured minimum hold/u);

    // Second cycle one minute later: consecutive AND held >= 1 minute -> rotate.
    const second = evaluateLpTriggers(nextCycle(first, breach));
    assert.equal(second.decision, "rotate");
    assert.equal(second.triggerReason.thresholdBps, "0");
  });

  it("holds a confirmed breach until rotateMinHoldMinutes has elapsed since the breach began", () => {
    const breach: InputOverrides = {
      ...outOfRangeAt(150),
      settings: { autoRotate: true, rotateMinHoldMinutes: 5 },
    };
    const first = evaluateLpTriggers(makeInput(breach));
    // Cycle 2 at +1 minute: two consecutive breaches but only 60s held.
    const second = evaluateLpTriggers(nextCycle(first, breach));
    assert.equal(second.decision, "hold");
    assert.equal(second.nextObservation.rotationConsecutive, 2);
    assert.equal(second.nextObservation.rotationBreachStartedAtMs, 1_000_000);
    assert.match(second.holdReason ?? "", /minimum hold/u);

    // Cycle 3 at +5 minutes from breach start: hold satisfied.
    const third = evaluateLpTriggers(
      makeInput({
        ...breach,
        market: {
          ...breach.market,
          blockNumber: 105n,
          finalizedBlockNumber: 105n,
        },
        nowMs: 1_000_000 + 5 * 60_000,
        previousObservation: second.nextObservation,
      }),
    );
    assert.equal(third.decision, "rotate");
  });

  it("holds an out-of-range observation below the configured deviation band", () => {
    const result = evaluateLpTriggers(
      makeInput({
        ...outOfRangeAt(101),
        settings: { autoRotate: true, rotateBandBps: 5_000 },
      }),
    );
    assert.equal(result.nextObservation.rotationBreach, false);
    assert.equal(result.decision, "hold");
  });

  it("a re-entry into range resets the breach clock and count", () => {
    const first = evaluateLpTriggers(makeInput(outOfRangeAt(150)));
    const backInRange = evaluateLpTriggers(
      nextCycle(first, { settings: { autoRotate: true } }),
    );
    assert.equal(backInRange.nextObservation.rotationConsecutive, 0);
    assert.equal(backInRange.nextObservation.rotationBreachStartedAtMs, undefined);
    // Breaching again starts over at 1.
    const again = evaluateLpTriggers(
      makeInput({
        ...outOfRangeAt(150),
        market: {
          spotSqrtPriceX96: getSqrtRatioAtTick(150),
          twapSqrtPriceX96: getSqrtRatioAtTick(150),
          blockNumber: 102n,
          finalizedBlockNumber: 102n,
        },
        nowMs: 1_120_000,
        previousObservation: backInRange.nextObservation,
      }),
    );
    assert.equal(again.nextObservation.rotationConsecutive, 1);
    assert.equal(again.nextObservation.rotationBreachStartedAtMs, 1_120_000);
  });

  it("rejects a confirmed rotation when the price-impact rail trips", () => {
    const breach = outOfRangeAt(150);
    const first = evaluateLpTriggers(makeInput(breach));
    const second = evaluateLpTriggers(
      nextCycle(first, { ...breach, market: { ...breach.market, priceImpactBps: 101n } }),
    );
    assert.equal(second.decision, "hold");
    assert.match(second.holdReason ?? "", /price impact/u);
  });
});

describe("harvest matrix", () => {
  const feesReady: InputOverrides = {
    position: {
      collectibleFee0: 1n,
      collectibleFee1: 2n,
      freshFeesValueWei: ONE / 10n,
    },
    settings: { autoHarvest: true },
  };

  it("harvests only with both positive fee legs at or above the value floor", () => {
    assert.equal(evaluateLpTriggers(makeInput(feesReady)).decision, "harvest");

    const oneLeg = evaluateLpTriggers(
      makeInput({ ...feesReady, position: { ...feesReady.position, collectibleFee1: 0n } }),
    );
    assert.equal(oneLeg.decision, "hold");
    assert.match(oneLeg.holdReason ?? "", /both freshly collectible fee legs/u);

    const belowFloor = evaluateLpTriggers(
      makeInput({
        ...feesReady,
        position: { ...feesReady.position, freshFeesValueWei: ONE / 10n - 1n },
      }),
    );
    assert.equal(belowFloor.decision, "hold");
    assert.match(belowFloor.holdReason ?? "", /below harvestMinFeesWei/u);
  });

  it("does not harvest when autoHarvest is off", () => {
    const result = evaluateLpTriggers(
      makeInput({ ...feesReady, settings: { autoHarvest: false } }),
    );
    assert.equal(result.decision, "hold");
  });

  /**
   * PHASE3.12 B1. This test used to be titled "permits fee harvest outside the
   * active range when rotation is off" and asserted `harvest`. That assertion
   * was the OLD contract, and the live Phase 3.11 incident is what it costs:
   * the collect and the sweep both confirm, the sweep's split is total out of
   * range, and `zap-in-increase` then refuses the single-sided increase with
   * two submissions already paid for. R-E reverses it deliberately — the
   * reversal IS the phase, so the test is rewritten rather than deleted.
   */
  it("refuses a harvest above the range and names the tick, the range and the remedy", () => {
    const result = evaluateLpTriggers(
      makeInput({
        position: {
          currentTick: 150,
          collectibleFee0: 1n,
          collectibleFee1: 1n,
          freshFeesValueWei: ONE / 10n,
        },
        market: {
          spotSqrtPriceX96: getSqrtRatioAtTick(150),
          twapSqrtPriceX96: getSqrtRatioAtTick(150),
        },
        settings: { autoHarvest: true, autoRotate: false },
      }),
    );
    assert.equal(result.decision, "hold");
    // F9/F11: the exact sentence, from the ONE named builder — not a regex over
    // a string a later edit could quietly generalise.
    assert.equal(
      result.holdReason,
      lpHarvestRangeHoldReason({
        currentTick: 150,
        tickLower: -100,
        tickUpper: 100,
        autoRotate: false,
      }),
    );
    // Q1's four required elements, asserted as content rather than as identity.
    assert.match(result.holdReason ?? "", /tick 150/u);
    assert.match(result.holdReason ?? "", /\[-100, 100\)/u);
    assert.match(result.holdReason ?? "", /NOT lost/u);
    assert.match(result.holdReason ?? "", /single-sided/u);
    assert.match(result.holdReason ?? "", /--auto-rotate/u);
  });

  /**
   * PHASE3.12 M6. The gate must NOT be conditioned on `autoRotate` or on
   * whether a rotate would fire this cycle: with rotation ON but its first
   * confirmation only just banked, the harvest is still the branch that would
   * dispatch, and it would still wedge.
   */
  it("refuses the same harvest with autoRotate ON, and points at the rotate instead", () => {
    const result = evaluateLpTriggers(
      makeInput({
        ...outOfRangeAt(150),
        position: {
          currentTick: 150,
          collectibleFee0: 1n,
          collectibleFee1: 1n,
          freshFeesValueWei: ONE / 10n,
        },
        settings: { autoHarvest: true, autoRotate: true },
      }),
    );
    assert.equal(result.decision, "hold");
    assert.equal(result.nextObservation.rotationConsecutive, 1);
    assert.equal(
      result.holdReason,
      lpHarvestRangeHoldReason({
        currentTick: 150,
        tickLower: -100,
        tickUpper: 100,
        autoRotate: true,
      }),
    );
    assert.match(result.holdReason ?? "", /The rotate is the action here/u);
    assert.doesNotMatch(result.holdReason ?? "", /--auto-rotate/u);
  });

  /**
   * PHASE3.12 B1 (lower side) + B3. `currentTick === tickLower` is IN RANGE by
   * V3's lower-inclusive rule, so `rotationDeviationBps` is `undefined` there
   * and the spec's proposed predicate would have admitted it — but
   * `computeSwapAmount` splits TOTAL at that tick in BOTH leg orderings
   * (pinned in `test/lp.tickMath.test.ts`), so the harvest wedges exactly as
   * in the 3.11 incident. This is the F1 test.
   */
  it("refuses a harvest ON the lower bound, which is in range but not compoundable", () => {
    const onLowerBound = evaluateLpTriggers(
      makeInput({
        position: {
          currentTick: -100,
          collectibleFee0: 1n,
          collectibleFee1: 1n,
          freshFeesValueWei: ONE / 10n,
        },
        market: {
          spotSqrtPriceX96: getSqrtRatioAtTick(-100),
          twapSqrtPriceX96: getSqrtRatioAtTick(-100),
        },
        settings: { autoHarvest: true, autoRotate: false },
      }),
    );
    assert.equal(onLowerBound.decision, "hold");
    assert.equal(
      onLowerBound.holdReason,
      lpHarvestRangeHoldReason({
        currentTick: -100,
        tickLower: -100,
        tickUpper: 100,
        autoRotate: false,
      }),
    );
    // The tick is in range by the rotate's own predicate — which is precisely
    // why the gate could not be written against that predicate.
    assert.equal(onLowerBound.nextObservation.rotationBreach, false);

    // And below the range, where nothing is subtle.
    const belowRange = evaluateLpTriggers(
      makeInput({
        position: {
          currentTick: -150,
          collectibleFee0: 1n,
          collectibleFee1: 1n,
          freshFeesValueWei: ONE / 10n,
        },
        market: {
          spotSqrtPriceX96: getSqrtRatioAtTick(-150),
          twapSqrtPriceX96: getSqrtRatioAtTick(-150),
        },
        settings: { autoHarvest: true, autoRotate: false },
      }),
    );
    assert.equal(belowRange.decision, "hold");
  });

  /**
   * PHASE3.12 B2. The interior is byte-identical: the gate adds no behaviour
   * anywhere the split is partial, including the two ticks that bracket it.
   */
  it("still harvests everywhere inside the range, including both adjacent-to-bound ticks", () => {
    for (const currentTick of [-99, 0, 99]) {
      const result = evaluateLpTriggers(
        makeInput({
          position: {
            currentTick,
            collectibleFee0: 1n,
            collectibleFee1: 1n,
            freshFeesValueWei: ONE / 10n,
          },
          market: {
            spotSqrtPriceX96: getSqrtRatioAtTick(currentTick),
            twapSqrtPriceX96: getSqrtRatioAtTick(currentTick),
          },
          settings: { autoHarvest: true, autoRotate: false },
        }),
      );
      assert.equal(result.decision, "harvest", `tick ${currentTick}`);
    }
  });

  /**
   * PHASE3.12 B6. The gate touches priority 2 only: a confirmed rotate on the
   * SAME out-of-range position still dispatches. R-E removes the harvest that
   * was starving it, not the rotate.
   */
  it("leaves a confirmed rotate on an out-of-range position untouched", () => {
    const breach: InputOverrides = {
      ...outOfRangeAt(150),
      position: {
        currentTick: 150,
        collectibleFee0: 1n,
        collectibleFee1: 1n,
        freshFeesValueWei: ONE / 10n,
      },
      settings: { autoHarvest: true, autoRotate: true },
    };
    const first = evaluateLpTriggers(makeInput(breach));
    assert.equal(first.decision, "hold");
    const second = evaluateLpTriggers(nextCycle(first, breach));
    assert.equal(second.decision, "rotate");
  });

  it("rejects harvest when a manipulation rail is breached", () => {
    const result = evaluateLpTriggers(
      makeInput({ ...feesReady, market: { observationCardinality: 1 } }),
    );
    assert.equal(result.decision, "hold");
    assert.match(result.holdReason ?? "", /cardinality/u);
  });

  it("a confirmed rotate outranks an eligible harvest (one action per cycle)", () => {
    const both: InputOverrides = {
      ...outOfRangeAt(150),
      position: {
        currentTick: 150,
        collectibleFee0: 1n,
        collectibleFee1: 1n,
        freshFeesValueWei: ONE,
      },
      settings: { autoRotate: true, autoHarvest: true },
    };
    const first = evaluateLpTriggers(makeInput(both));
    const second = evaluateLpTriggers(nextCycle(first, both));
    assert.equal(second.decision, "rotate");
  });
});

describe("quota-agnosticism and receipts", () => {
  it("decisions are independent of the exit quotas (the journal owns those)", () => {
    const breach = outOfRangeAt(150);
    for (const quota of [1, 4, 24]) {
      const first = evaluateLpTriggers(
        makeInput({ ...breach, settings: { ...breach.settings, maxExitSequencesPerDay: quota } }),
      );
      const second = evaluateLpTriggers(
        nextCycle(first, {
          ...breach,
          settings: { ...breach.settings, maxExitSequencesPerDay: quota },
        }),
      );
      assert.equal(second.decision, "rotate", `quota ${quota}`);
    }
  });

  it("the trigger reason is a sanitized string record carrying the decision evidence", () => {
    const result = evaluateLpTriggers(makeInput());
    assert.equal(result.triggerReason.decision, "hold");
    assert.equal(result.triggerReason.basisWei, (10n * ONE).toString());
    assert.equal(result.triggerReason.exitValueWei, (10n * ONE).toString());
    assert.equal(result.triggerReason.blockNumber, "100");
    assert.equal(result.triggerReason.poolAddress, POOL);
    assert.equal(result.triggerReason.pnlBps, "0");
    assert.equal(result.triggerReason.spotTwapDeviationBps, "0");
    for (const [key, value] of Object.entries(result.triggerReason)) {
      assert.ok(typeof value !== "bigint", `${key} must not leak a bigint`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.13 F1 — a parked swapless position does not re-rotate               */
/* -------------------------------------------------------------------------- */

/**
 * B15. THE test that decides whether this phase is a strategy or a fee pump.
 *
 * A swapless rotate parks the range STRICTLY BESIDE the price — that is its
 * definition — so `rotationDeviationBps` is DEFINED for the position it just
 * created, and with `rotateBandBps` defaulting to 0 against a `>=` the breach
 * fires on the very next observation. Two cycles later the worker dispatches
 * ANOTHER rotate, which derives the same side and mints in the same place: two
 * relay submissions plus a zap-out and a mint every two intervals, for ever,
 * stranding up to the residue bound each iteration.
 *
 * The floor is the position's OWN WIDTH in bps, so re-rotating demands that
 * the price has travelled a full range-width away from the parked range. These
 * cases MUST fail against the spec's original OQ4 answer ("the trigger needs no
 * change"), and they are what M14 kills.
 */
describe("PHASE3.13 B15 (F1): a parked swapless position does not re-rotate", () => {
  /**
   * The shape a swapless mint leaves behind: a range one spacing above the
   * tick. Width 200 ticks (~200 bps); the tick sits 60 ticks below `tickLower`
   * (~60 bps out) — plainly out of range, and plainly less than one width away.
   */
  const parked: InputOverrides = {
    position: { currentTick: -60, tickLower: 0, tickUpper: 200 },
    market: {
      spotSqrtPriceX96: getSqrtRatioAtTick(-60),
      twapSqrtPriceX96: getSqrtRatioAtTick(-60),
    },
  };
  const swaplessOn = {
    autoRotate: true,
    rotateMode: "swapless" as const,
    rotateBandBps: 0,
    rotateMinHoldMinutes: 0,
  };

  it("two consecutive cycles on the default band do NOT decide rotate", () => {
    const first = evaluateLpTriggers(makeInput({ ...parked, settings: swaplessOn }));
    assert.notEqual(first.decision, "rotate");
    assert.equal(first.nextObservation.rotationBreach, false);
    const second = evaluateLpTriggers(
      nextCycle(first, { ...parked, settings: swaplessOn }),
    );
    assert.notEqual(second.decision, "rotate", "the parked position must not re-rotate");
    assert.equal(second.nextObservation.rotationConsecutive, 0);
  });

  it("says WHY, in the owner's own vocabulary, instead of \"no trigger is ready\"", () => {
    const held = evaluateLpTriggers(makeInput({ ...parked, settings: swaplessOn }));
    assert.equal(held.decision, "hold");
    assert.match(held.holdReason ?? "", /Swapless rotate parked/u);
    assert.match(held.holdReason ?? "", /tick -60/u);
    assert.match(held.holdReason ?? "", /\[0, 200\)/u);
    assert.match(held.holdReason ?? "", /rotateMode "swapped"/u);
  });

  it("the SAME position under the DEFAULT swapped mode rotates on cycle 2 — the floor is mode-scoped", () => {
    const swappedOn = { ...swaplessOn, rotateMode: "swapped" as const };
    const first = evaluateLpTriggers(makeInput({ ...parked, settings: swappedOn }));
    assert.equal(first.nextObservation.rotationBreach, true);
    const second = evaluateLpTriggers(
      nextCycle(first, { ...parked, settings: swappedOn }),
    );
    assert.equal(second.decision, "rotate");
  });

  it("re-rotates once the price has travelled a full range-width away", () => {
    // A full width (200 ticks) below `tickLower` and then some: 260 bps out
    // against a ~200 bps width.
    const far: InputOverrides = {
      position: { currentTick: -260, tickLower: 0, tickUpper: 200 },
      market: {
        spotSqrtPriceX96: getSqrtRatioAtTick(-260),
        twapSqrtPriceX96: getSqrtRatioAtTick(-260),
      },
    };
    const first = evaluateLpTriggers(makeInput({ ...far, settings: swaplessOn }));
    assert.equal(first.nextObservation.rotationBreach, true);
    const second = evaluateLpTriggers(nextCycle(first, { ...far, settings: swaplessOn }));
    assert.equal(second.decision, "rotate");
    // And the receipt reports the threshold it was actually measured against.
    assert.ok(
      BigInt(second.triggerReason.thresholdBps ?? "0") > 0n,
      "the receipt reports the width floor, not the raw rotateBandBps of 0",
    );
  });

  it("takes the LARGER of the owner's band and the width floor", () => {
    // Band 5000 bps beats the ~200 bps width: the owner's own band still binds.
    const wideBand = { ...swaplessOn, rotateBandBps: 5_000 };
    const far: InputOverrides = {
      position: { currentTick: -260, tickLower: 0, tickUpper: 200 },
      market: {
        spotSqrtPriceX96: getSqrtRatioAtTick(-260),
        twapSqrtPriceX96: getSqrtRatioAtTick(-260),
      },
    };
    const first = evaluateLpTriggers(makeInput({ ...far, settings: wideBand }));
    assert.equal(first.nextObservation.rotationBreach, false);
  });

  it("is inert while autoRotate is off", () => {
    const off = { ...swaplessOn, autoRotate: false };
    const held = evaluateLpTriggers(makeInput({ ...parked, settings: off }));
    assert.equal(held.decision, "hold");
    assert.doesNotMatch(held.holdReason ?? "", /Swapless rotate parked/u);
  });
});
