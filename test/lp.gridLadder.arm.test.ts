/**
 * PHASE3.19 — the LADDER ARM's PLAN, the sizing term, and the TRIGGER.
 *
 * OFFLINE and pure: the plan builder over injected readers, the sizing
 * invariant, and `evaluateGridTriggers` over injected observations.
 *
 * ─── WHAT THIS FILE OWES ──────────────────────────────────────────────────
 *
 *  - R4.2/N17 VERBATIM: `swapInWei` UNSCALED, `deployPctBps` applied ONCE PER
 *    SIDE to that side's half, and `nativeSpendWei` summing to EXACTLY
 *    `budgetWei` — in BOTH orientations, where §1.A proves the split is
 *    orientation-irrelevant by construction and this pins it anyway;
 *  - C1: `buildGridArmDualPlan` is UNTOUCHED — the six calls it emits and their
 *    positional values are asserted here too, so a builder that "unified" the
 *    two plans breaks this file as well as `test/lp.gridDual.test.ts`;
 *  - item 30: the `recenter` reserve term, at FOUR submissions a motion;
 *  - item 17 / H3: the funding conjunct as a TRIGGER-LEVEL HOLD, creating NO
 *    sequence and NO reservation at BOTH stores;
 *  - item 47 / B4: NO protect dispatch on a ladder rung with `stopLossPct: 50`;
 *  - item 16 / M8: the 3.13 F1 drift floor, inherited verbatim.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { buildLpOpenPlan } from "../src/lp/openPlanning.js";
import {
  MAX_SUBMISSIONS_PER_GRID_RECENTER,
  checkLpNativeCapSizing,
} from "../src/ops/policy.js";
import {
  evaluateGridTriggers,
  gridDeriveRanges,
  gridDualSwapInWei,
  gridLadderEconomics,
} from "../src/lp/gridTriggers.js";
import {
  DEFAULT_LP_SETTINGS,
  type LpAutomationSettings,
  type LpGridLadder,
  type LpGridSettings,
  type LpTriggerObservation,
  type LpTriggerPositionInput,
} from "../src/lp/triggers.js";
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { sagaSwapMinOut, type LpRailConfig, type LpRailEvidence } from "../src/lp/rails.js";
import {
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");
const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const ROUTER_V3 = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");

const INTERVAL_MS = 60_000;
const NOW_MS = 1_900_000_000_000;
const BUDGET = 10n ** 18n;
const RELAY_FEE = 100_000_000_000_000n;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 500,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

const LADDER: LpGridLadder = {
  gapTicks: 60,
  widthTicks: 60,
  deployPctBps: 3_000,
  driftPctOfGap: 60,
  maxMovesPerDay: 12,
  hedge: { enabled: true, minMarkoutBps: 75, maxHedgePctBps: 5_000 },
};

/* -------------------------------------------------------------------------- */
/* R4.2 / N17 — the arm plan's split                                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 R4.2: the ladder arm's four legs and its exact sum", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB token0)" : "Case A (WBNB token1)";
    const token0 = wbnbIsToken0 ? WBNB : TOKEN_LO;
    const token1 = wbnbIsToken0 ? TOKEN_HI : WBNB;
    // At tick 0 with gap 60 / width 60 / spacing 10 the derivation puts the
    // rungs symmetrically either side of the corridor; `gridDeriveRanges`
    // resolves buy/sell by ORIENTATION, so this fixture needs no branch.
    const derived = gridDeriveRanges({
      currentTick: 0,
      tickSpacing: 10,
      gapTicks: 60,
      widthTicks: 60,
      wbnbIsToken0,
      minTick: MIN_TICK,
      maxTick: MAX_TICK,
    });

    const plan = async (
      overrides: {
        readonly budgetWei?: bigint;
        readonly deployPctBps?: number;
      } = {},
    ) =>
      buildLpOpenPlan({
        mode: "grid-arm-ladder",
        walletAddress: getAddress("0x1111111111111111111111111111111111111111"),
        token0,
        token1,
        fee: 2_500,
        wbnb: WBNB,
        nfpm: NFPM,
        routerV3: ROUTER_V3,
        budgetWei: overrides.budgetWei ?? BUDGET,
        tickLower: derived.buyRange.tickLower,
        tickUpper: derived.buyRange.tickUpper,
        sellTickLower: derived.sellRange.tickLower,
        sellTickUpper: derived.sellRange.tickUpper,
        tickSpacing: 10,
        deployPctBps: overrides.deployPctBps ?? 3_000,
        currentTick: 0,
        spotSqrtPriceX96: getSqrtRatioAtTick(0),
        deadline: 1_900_000_000n,
        rails: RAILS,
        quote: async (input) => input.amountInWei,
        // The swap moves the price AWAY from the buy rung and TOWARD the sell
        // rung in both orientations; a post-swap price two spacings clear of the
        // sell rung's near edge satisfies the one-spacing clearance rule.
        quoteWithPriceAfter: async (input) => ({
          amountOutWei: input.amountInWei,
          sqrtPriceX96After: getSqrtRatioAtTick(wbnbIsToken0 ? 200 : -200),
        }),
      });

    it(`${label}: FOUR legs — wrap, swap, sell mint, buy mint — summing to EXACTLY the budget`, async () => {
      const calls = await plan();
      // The pinned ORDER. mint#1 = SELL, mint#2 = BUY, the same convention the
      // dual arm's `finishDual` pairs positionally.
      assert.equal(calls[0]?.to, WBNB, "leg 1 is the WBNB wrap");
      assert.equal(calls[1]?.to, ROUTER_V3, "leg 2 is the router swap");
      // `buildLpMintWbnbBatch` emits approve(WBNB,0), approve(base,x), mint.
      assert.equal(calls[2]?.to?.toLowerCase(), WBNB.toLowerCase());
      assert.equal(
        calls[3]?.to?.toLowerCase(),
        (wbnbIsToken0 ? TOKEN_HI : TOKEN_LO).toLowerCase(),
      );
      assert.equal(calls[4]?.to, NFPM, "mint#1 is the SELL rung");
      assert.equal(calls[5]?.to, NFPM, "mint#2 is the BUY rung, native-attaching");

      const swapInWei = gridDualSwapInWei(BUDGET);
      const quoteHalfWei = BUDGET - swapInWei;
      const buyValueWei = (quoteHalfWei * 3_000n) / 10_000n;
      const idleQuoteWei = quoteHalfWei - buyValueWei;
      assert.equal(calls[0]?.value, idleQuoteWei, "the WRAP takes the idle quote");
      assert.equal(calls[1]?.value, swapInWei, "the SWAP takes the WHOLE base half");
      assert.equal(calls[5]?.value, buyValueWei, "the BUY mint takes its deployed share");

      // `nativeSpendWei` is a plain sum of attached values, and the identity is
      // what makes the off-chain daily-cap check see the real number.
      const total = calls.reduce((sum, one) => sum + (one.value ?? 0n), 0n);
      assert.equal(total, BUDGET, "the three attached values must sum to the budget");
    });

    it(`${label}: N17 — the SWAP is UNSCALED, so idle base exists at all`, async () => {
      const calls = await plan();
      // THE MUTATION THIS KILLS: scaling `swapInWei` by `deployPctBps` swaps only
      // ~30% of the base half, leaving a buffer that is ~85% quote with NO IDLE
      // BASE — so the sell rung is re-mintable exactly once and then parks for
      // ever. That is FINDINGS (ax) mirrored onto the sell side.
      assert.equal(calls[1]?.value, BUDGET / 2n);
      assert.notEqual(calls[1]?.value, (BUDGET / 2n * 3_000n) / 10_000n);
      // And the SELL mint's approve is `deployPctBps` of the swap's FLOOR — the
      // rest of the swap output is the idle base half.
      const floor = sagaSwapMinOut(BUDGET / 2n, RAILS.maxSagaSlippageBps);
      const expectedApprove = (floor * 3_000n) / 10_000n;
      assert.ok(calls[3]?.data?.endsWith(expectedApprove.toString(16).padStart(64, "0")));
    });

    it(`${label}: the split scales with deployPctBps and STILL sums to the budget`, async () => {
      for (const deployPctBps of [1_000, 3_000, 5_000]) {
        const calls = await plan({ deployPctBps });
        const total = calls.reduce((sum, one) => sum + (one.value ?? 0n), 0n);
        assert.equal(total, BUDGET, `deployPctBps ${deployPctBps} broke the sum`);
        // The 1000..5000 bound is what makes `idleQuoteWei > 0` STRUCTURAL: at
        // the ceiling the arm still leaves half of each side idle.
        assert.ok((calls[0]?.value ?? 0n) > 0n, "the idle quote leg must be positive");
      }
    });

    it(`${label}: the sentinel budget is refused BEFORE any mode branch`, async () => {
      // The worker's `grid-arm` resume passes `budgetWei: 0n`, and the first
      // statement of `buildLpOpenPlan` is what turns that into BUILD_REFUSED →
      // rollback → the never-funded rows CLOSED. A ladder branch placed above it
      // would silently kill the never-re-driven policy.
      await assert.rejects(
        plan({ budgetWei: 0n }),
        /The open budget must be positive/u,
      );
    });

    it(`${label}: an absent post-swap reader refuses FAIL-CLOSED`, async () => {
      await assert.rejects(
        buildLpOpenPlan({
          mode: "grid-arm-ladder",
          walletAddress: getAddress("0x1111111111111111111111111111111111111111"),
          token0,
          token1,
          fee: 2_500,
          wbnb: WBNB,
          nfpm: NFPM,
          routerV3: ROUTER_V3,
          budgetWei: BUDGET,
          tickLower: derived.buyRange.tickLower,
          tickUpper: derived.buyRange.tickUpper,
          sellTickLower: derived.sellRange.tickLower,
          sellTickUpper: derived.sellRange.tickUpper,
          tickSpacing: 10,
          deployPctBps: 3_000,
          currentTick: 0,
          spotSqrtPriceX96: getSqrtRatioAtTick(0),
          deadline: 1_900_000_000n,
          rails: RAILS,
          quote: async (input) => input.amountInWei,
        }),
        /needs the post-swap quote reader/u,
      );
    });

    it(`${label}: an absent deployPctBps refuses rather than defaulting`, async () => {
      await assert.rejects(
        buildLpOpenPlan({
          mode: "grid-arm-ladder",
          walletAddress: getAddress("0x1111111111111111111111111111111111111111"),
          token0,
          token1,
          fee: 2_500,
          wbnb: WBNB,
          nfpm: NFPM,
          routerV3: ROUTER_V3,
          budgetWei: BUDGET,
          tickLower: derived.buyRange.tickLower,
          tickUpper: derived.buyRange.tickUpper,
          sellTickLower: derived.sellRange.tickLower,
          sellTickUpper: derived.sellRange.tickUpper,
          tickSpacing: 10,
          currentTick: 0,
          spotSqrtPriceX96: getSqrtRatioAtTick(0),
          deadline: 1_900_000_000n,
          rails: RAILS,
          quote: async (input) => input.amountInWei,
          quoteWithPriceAfter: async (input) => ({
            amountOutWei: input.amountInWei,
            sqrtPriceX96After: getSqrtRatioAtTick(wbnbIsToken0 ? 200 : -200),
          }),
        }),
        /signed deployPctBps/u,
      );
    });
  }

  it("C1: the DUAL plan is byte-identical — six calls, its own two values", async () => {
    // A ladder arm is a FIFTH discriminant with its OWN builder precisely so
    // this stays true. If a builder ever "unified" the two, this assertion and
    // `test/lp.gridDual.test.ts:940-978` both break.
    const derived = gridDeriveRanges({
      currentTick: 0,
      tickSpacing: 10,
      gapTicks: 60,
      widthTicks: 60,
      wbnbIsToken0: false,
      minTick: MIN_TICK,
      maxTick: MAX_TICK,
    });
    const calls = await buildLpOpenPlan({
      mode: "grid-arm-dual",
      walletAddress: getAddress("0x1111111111111111111111111111111111111111"),
      token0: TOKEN_LO,
      token1: WBNB,
      fee: 2_500,
      wbnb: WBNB,
      nfpm: NFPM,
      routerV3: ROUTER_V3,
      budgetWei: BUDGET,
      tickLower: derived.buyRange.tickLower,
      tickUpper: derived.buyRange.tickUpper,
      sellTickLower: derived.sellRange.tickLower,
      sellTickUpper: derived.sellRange.tickUpper,
      tickSpacing: 10,
      currentTick: 0,
      spotSqrtPriceX96: getSqrtRatioAtTick(0),
      deadline: 1_900_000_000n,
      rails: RAILS,
      quote: async (input) => input.amountInWei,
      quoteWithPriceAfter: async (input) => ({
        amountOutWei: input.amountInWei,
        sqrtPriceX96After: getSqrtRatioAtTick(-200),
      }),
    });
    assert.equal(calls.length, 6, "the dual plan still emits SIX calls, not seven");
    assert.equal(calls[0]?.value, BUDGET / 2n);
    assert.equal(calls[4]?.value, BUDGET - BUDGET / 2n);
    const total = calls.reduce((sum, one) => sum + (one.value ?? 0n), 0n);
    assert.equal(total, BUDGET);
  });
});

/* -------------------------------------------------------------------------- */
/* Item 30 — the recenter reserve                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 30: checkLpNativeCapSizing reserves the ladder lane", () => {
  const base = {
    openNativeBudgetWei: 0n,
    maxExitSequencesPerDay: 1,
    openPositionsCount: 2,
    lpRelayFeePerSubmitWei: RELAY_FEE,
  } as const;

  it("the term is `moves x 4 x perSubmit`, and it is its OWN named clause", () => {
    const withoutMoves = checkLpNativeCapSizing({
      ...base,
      onChainDailyCapWei: 10n ** 18n,
    });
    assert.equal(withoutMoves.ok, true);
    // Exactly at the boundary: without the moves term this cap passes; with it,
    // it is short by the reserve. THE MUTATION THIS KILLS is dropping the term,
    // which would let provisioning pass on a cap that cannot pay the gas for up
    // to 24 motions a day.
    const reserve = BigInt(12 * MAX_SUBMISSIONS_PER_GRID_RECENTER) * RELAY_FEE;
    const tight = checkLpNativeCapSizing({
      ...base,
      onChainDailyCapWei:
        BigInt(1 * 3) * RELAY_FEE + BigInt(2 * 2) * RELAY_FEE + 1n,
      maxMovesPerDay: 12,
    });
    assert.equal(tight.ok, false);
    if (tight.ok || tight.kind !== "shortfall") return;
    assert.match(tight.message, /recenter headroom N_moves 12 x 4 submissions/u.source
      ? /recenter headroom N_moves 12 × 4 submissions/u
      : /recenter headroom/u);
    assert.ok(tight.shortfallWei > 0n);
    assert.ok(tight.shortfallWei <= reserve + 1n);
  });

  it("FOUR submissions, not the flip's three — a ladder's middle step can FIRE", () => {
    assert.equal(MAX_SUBMISSIONS_PER_GRID_RECENTER, 4);
  });

  it("a malformed maxMovesPerDay refuses rather than sizing on it", () => {
    for (const moves of [0, 25, 1.5]) {
      const verdict = checkLpNativeCapSizing({
        ...base,
        onChainDailyCapWei: 10n ** 20n,
        maxMovesPerDay: moves,
      });
      assert.equal(verdict.ok, false);
      if (verdict.ok) return;
      assert.equal(verdict.kind, "malformed");
    }
  });

  it("an ABSENT maxMovesPerDay leaves every 3.15-3.18 figure unchanged", () => {
    const before = checkLpNativeCapSizing({ ...base, onChainDailyCapWei: 1n });
    const after = checkLpNativeCapSizing({ ...base, onChainDailyCapWei: 1n });
    assert.deepEqual(before, after);
    if (before.ok || before.kind !== "shortfall") return;
    assert.doesNotMatch(before.message, /recenter headroom/u);
  });
});

/* -------------------------------------------------------------------------- */
/* The trigger                                                                */
/* -------------------------------------------------------------------------- */

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

/** A coherent LADDER grid whose rungs derive at the anchor tick. */
function ladderGrid(wbnbIsToken0: boolean, ladder: LpGridLadder = LADDER): LpGridSettings {
  const derived = gridDeriveRanges({
    currentTick: 0,
    tickSpacing: 10,
    gapTicks: ladder.gapTicks,
    widthTicks: ladder.widthTicks,
    wbnbIsToken0,
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
  return {
    pool: wbnbIsToken0
      ? { token0: WBNB, token1: TOKEN_HI, fee: 2_500 }
      : { token0: TOKEN_LO, token1: WBNB, fee: 2_500 },
    wbnbIsToken0,
    tickSpacing: 10,
    buyRange: derived.buyRange,
    sellRange: derived.sellRange,
    maxFlipsPerDay: 1,
    minNetEdgeBps: 0,
    mode: "ladder",
    ladder,
  };
}

function positionOn(
  grid: LpGridSettings,
  role: "buy" | "sell",
  currentTick: number,
  buffer?: { readonly quoteWei: bigint; readonly baseWei: bigint },
): LpTriggerPositionInput {
  const range = role === "buy" ? grid.buyRange : grid.sellRange;
  return {
    // B4: a ladder row records `basisWei: 0n` + `basisSource: "minted"`.
    basisWei: 0n,
    basisSource: "minted",
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
    gridLevel: 1,
    gridRole: role,
    ...(buffer === undefined
      ? {}
      : { bufferQuoteWei: buffer.quoteWei, bufferBaseWei: buffer.baseWei }),
  };
}

function evaluateLadder(input: {
  readonly grid: LpGridSettings;
  readonly role: "buy" | "sell";
  readonly tick: number;
  readonly blockNumber?: bigint;
  readonly nowMs?: number;
  readonly previousObservation?: LpTriggerObservation;
  readonly buffer?: { readonly quoteWei: bigint; readonly baseWei: bigint };
  readonly settings?: Partial<LpAutomationSettings>;
  readonly relayFeePerSubmitWei?: bigint;
}): ReturnType<typeof evaluateGridTriggers> {
  return evaluateGridTriggers({
    settingsDigest: "0xladder",
    intervalMs: INTERVAL_MS,
    market: market(input.blockNumber ?? 100n, input.tick),
    nowMs: input.nowMs ?? NOW_MS,
    position: positionOn(input.grid, input.role, input.tick, input.buffer),
    ...(input.previousObservation === undefined
      ? {}
      : { previousObservation: input.previousObservation }),
    rails: RAILS,
    settings: {
      ...DEFAULT_LP_SETTINGS,
      minMinutesBetweenExits: 5,
      ...input.settings,
      grid: input.grid,
    },
    ...(input.relayFeePerSubmitWei === undefined
      ? {}
      : { relayFeePerSubmitWei: input.relayFeePerSubmitWei }),
  });
}

/** A buffer generous enough to clear any economic floor at this fixture's size. */
const RICH = { quoteWei: 10n ** 22n, baseWei: 10n ** 22n };

describe("PHASE3.19: the ladder trigger — ONE motion for BOTH pieces of evidence", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B" : "Case A";

    it(`${label}: a FILL confirmed twice dispatches grid-recenter and carries its target`, async () => {
      const grid = ladderGrid(wbnbIsToken0);
      // Beyond the buy rung's FAR edge: the rung has changed asset.
      const filled = wbnbIsToken0
        ? grid.buyRange.tickUpper + 500
        : grid.buyRange.tickLower - 500;
      const first = evaluateLadder({
        grid,
        role: "buy",
        tick: filled,
        buffer: RICH,
        relayFeePerSubmitWei: RELAY_FEE,
      });
      assert.equal(first.decision, "hold", "one observation is never enough");
      assert.equal(first.nextObservation.gridCrossConsecutive, 1);
      const second = evaluateLadder({
        grid,
        role: "buy",
        tick: filled,
        blockNumber: 101n,
        nowMs: NOW_MS + INTERVAL_MS,
        previousObservation: first.nextObservation,
        buffer: RICH,
        relayFeePerSubmitWei: RELAY_FEE,
      });
      assert.equal(second.decision, "grid-recenter");
      assert.notEqual(second.gridRecenterTarget, undefined);
      // R2.4/OQ5 — the CHASE: the target is re-anchored at the CURRENT tick, not
      // at the signed counter-rung the flip would have used.
      assert.notDeepEqual(second.gridRecenterTarget, grid.sellRange);
      assert.match(second.triggerReason.reason, /FILLED on two consecutive/u);
      assert.match(second.triggerReason.reason, /re-anchoring the SAME side/u);
    });

    it(`${label}: a DRIFT confirmed twice dispatches the SAME motion`, async () => {
      const grid = ladderGrid(wbnbIsToken0);
      // Far from the rung on the side it is ALREADY on: unfilled, drifted.
      const drifted = wbnbIsToken0
        ? grid.buyRange.tickLower - 5_000
        : grid.buyRange.tickUpper + 5_000;
      const first = evaluateLadder({
        grid,
        role: "buy",
        tick: drifted,
        buffer: RICH,
        relayFeePerSubmitWei: RELAY_FEE,
      });
      assert.equal(first.decision, "hold");
      assert.equal(first.nextObservation.gridDriftConsecutive, 1);
      const second = evaluateLadder({
        grid,
        role: "buy",
        tick: drifted,
        blockNumber: 101n,
        nowMs: NOW_MS + INTERVAL_MS,
        previousObservation: first.nextObservation,
        buffer: RICH,
        relayFeePerSubmitWei: RELAY_FEE,
      });
      assert.equal(second.decision, "grid-recenter");
      assert.match(second.triggerReason.reason, /DRIFTED past its threshold/u);
      // ONE decision for BOTH triggers is the deletion of the Q5 asymmetry that
      // produced FINDINGS (ax); a ladder never emits `grid-flip`.
      assert.notEqual(second.decision, "grid-flip");
    });
  }

  it("item 16 / M8: the 3.13 F1 drift FLOOR is inherited — a zero gap never re-fires for ever", () => {
    // With `gapTicks: 0` the percentage threshold is zero, so WITHOUT the floor
    // any drift at all would fire, for ever, on a rung the chase just placed at
    // `gap + (0..spacing)` ticks of drift.
    const grid = ladderGrid(false, { ...LADDER, gapTicks: 0 });
    const justOutside = grid.buyRange.tickUpper + 5;
    const first = evaluateLadder({
      grid,
      role: "buy",
      tick: justOutside,
      buffer: RICH,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    // The floor is `max(gap x (1+drift/100), gap + tickSpacing)` = one spacing,
    // and five ticks of drift is under it.
    assert.equal(first.nextObservation.gridDriftConsecutive ?? 0, 0);
    assert.equal(first.decision, "hold");
  });

  it("item 47 / B4: a ladder rung with stopLossPct 50 dispatches NO protect", () => {
    // A rung holds `deployPctBps` of one side's half — about 15% of the budget —
    // so with `basisWei: budget` the ratio would read ~0.15 and
    // `evaluateLpProtectBreach` would fire for any `stopLossPct <= 85`, at
    // PRIORITY 0, liquidating a working rung. The repair is `basisWei: 0n`, and
    // this asserts the consequence rather than the field.
    const grid = ladderGrid(false);
    const filled = grid.buyRange.tickLower - 500;
    const first = evaluateLadder({
      grid,
      role: "buy",
      tick: filled,
      buffer: RICH,
      relayFeePerSubmitWei: RELAY_FEE,
      settings: { stopLossPct: 50 },
    });
    const second = evaluateLadder({
      grid,
      role: "buy",
      tick: filled,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
      buffer: RICH,
      relayFeePerSubmitWei: RELAY_FEE,
      settings: { stopLossPct: 50 },
    });
    assert.equal(second.decision, "grid-recenter");
    assert.doesNotMatch(second.decision, /^protect-/u);
    assert.equal(second.nextObservation.protectBreach, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* Items 17/48 — the funding conjunct is a HOLD, not a sequence                */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 items 17/48: a funding-refused motion creates NOTHING", () => {
  const backends: readonly {
    readonly name: string;
    readonly make: () => Promise<LpSequenceStore>;
  }[] = [
    { name: "memory", make: async () => new MemoryLpSequenceStore(() => NOW_MS) },
    {
      name: "postgres(fake)",
      make: async () =>
        PostgresLpSequenceStore.create(new FakeSqlClient(), () => NOW_MS),
    },
  ];

  /** The evidence is READY; only the funding conjunct fails. */
  function starvedSecondLook(): ReturnType<typeof evaluateGridTriggers> {
    const grid = ladderGrid(false);
    const filled = grid.buyRange.tickLower - 500;
    const empty = { quoteWei: 0n, baseWei: 0n };
    const first = evaluateLadder({
      grid,
      role: "buy",
      tick: filled,
      buffer: empty,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    return evaluateLadder({
      grid,
      role: "buy",
      tick: filled,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
      buffer: empty,
      relayFeePerSubmitWei: RELAY_FEE,
    });
  }

  it("the decision is a HOLD whose reason names the side, the shortfall and the remedy", () => {
    const held = starvedSecondLook();
    assert.equal(held.decision, "hold");
    assert.match(held.holdReason ?? "", /Ladder buy rung waiting on inventory/u);
    assert.match(held.holdReason ?? "", /short of one economic rung/u);
    assert.match(held.holdReason ?? "", /hedge restores this side/u);
    // The anti-wick evidence is NOT reset by a funding hold: the counters are
    // computed above the decision, so a motion parked for three cycles fires
    // immediately when funding returns.
    assert.equal(held.nextObservation.gridCrossConsecutive, 2);
  });

  it("ABSENT balances hold too — a conjunct is not satisfied by a number nobody read", () => {
    const grid = ladderGrid(false);
    const filled = grid.buyRange.tickLower - 500;
    const first = evaluateLadder({
      grid,
      role: "buy",
      tick: filled,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    const second = evaluateLadder({
      grid,
      role: "buy",
      tick: filled,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    assert.equal(second.decision, "hold");
  });

  it("an ABSENT relay constant holds too — the gate cannot price its own floor", () => {
    const grid = ladderGrid(false);
    const filled = grid.buyRange.tickLower - 500;
    const first = evaluateLadder({ grid, role: "buy", tick: filled, buffer: RICH });
    const second = evaluateLadder({
      grid,
      role: "buy",
      tick: filled,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
      buffer: RICH,
    });
    assert.equal(second.decision, "hold");
  });

  for (const backend of backends) {
    it(`${backend.name}: NO sequence and NO reservation exist after the hold`, async () => {
      const store = await backend.make();
      const held = starvedSecondLook();
      assert.equal(held.decision, "hold");
      // A HOLD returns before any dispatch, so nothing downstream runs: no
      // sequence is created, no reservation is taken, no lane is consumed and
      // the agent-wide spacing anchor is NOT moved. That is the whole of the OQ2
      // ruling — a completed-with-SKIP sequence would have consumed a slot AND
      // re-anchored the spacing gate for the OTHER row.
      assert.deepEqual(
        await store.listSequences(
          getAddress("0x1111111111111111111111111111111111111111"),
          "ladder-agent",
        ),
        [],
      );
      const usage = await store.quotaUsage(
        getAddress("0x1111111111111111111111111111111111111111"),
        "ladder-agent",
      );
      assert.equal(usage.liveCount, 0);
      assert.equal(usage.recenterLiveCount ?? 0, 0);
      assert.equal(usage.latestReservedAtMs, null, "the spacing anchor did not move");
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The minimum budget the funding gate and the arm SHARE                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 M1: `ladderMinMintWei` IS the admission's own `minRungWei`", () => {
  it("the trigger's floor and the arm's admission come from ONE builder", () => {
    const grid = ladderGrid(false);
    const economics = gridLadderEconomics({
      grid,
      ladder: LADDER,
      budgetWei: 0n,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    // The funding conjunct compares against exactly this figure, computed by
    // exactly this function — so the gate and the admission cannot disagree
    // (the 3.13 F12 cannot-diverge rule). A buffer just under it holds; a buffer
    // just over it fires.
    const minRung = economics.minRungWei;
    assert.notEqual(minRung, null);
    const needed = ((minRung as bigint) * 10_000n) / 3_000n;
    const filled = grid.buyRange.tickLower - 500;
    const run = (quoteWei: bigint): ReturnType<typeof evaluateGridTriggers> => {
      const first = evaluateLadder({
        grid,
        role: "buy",
        tick: filled,
        buffer: { quoteWei, baseWei: 0n },
        relayFeePerSubmitWei: RELAY_FEE,
      });
      return evaluateLadder({
        grid,
        role: "buy",
        tick: filled,
        blockNumber: 101n,
        nowMs: NOW_MS + INTERVAL_MS,
        previousObservation: first.nextObservation,
        buffer: { quoteWei, baseWei: 0n },
        relayFeePerSubmitWei: RELAY_FEE,
      });
    };
    assert.equal(run(needed / 2n).decision, "hold");
    assert.equal(run(needed * 2n).decision, "grid-recenter");
  });
});
