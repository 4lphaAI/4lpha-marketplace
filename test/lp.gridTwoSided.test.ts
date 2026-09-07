/**
 * PHASE3.20 — THE TWO-SIDED LADDER: two quota lanes, a stranding bound, a
 * trigger-level pre-check, and the exhaustion arithmetic the lineage had never
 * done.
 *
 * OFFLINE and pure wherever it can be: the evaluator over injected
 * observations, the observation codec, both store backends, the canonical-params
 * seam, and the sizing check.
 *
 * ─── WHAT THIS FILE OWES, ITEM BY ITEM ─────────────────────────────────────
 *
 *  - §5(1)/(2): cross evidence charges the SETTLEMENT lane and drift charges
 *    DRIFT — a mutation that routes cross into drift, or lets a drift reserve
 *    the last settlement slot, must die;
 *  - §5(3): (az) REPLAYED — a rung that filled, a drift lane already spent, the
 *    clock advanced past `maxStrandedMinutes`, and the settlement runs;
 *  - §5(4)/items 17-19: the pre-check HOLDS instead of churning — no sequence,
 *    no reservation, nothing rolled back;
 *  - §5(5)/item 11: the mismatch predicate is `gridCrossReading(...).filled`
 *    reused VERBATIM, pinned in BOTH pool orderings as a REGRESSION pin on the
 *    reuse rather than as coverage for new arithmetic;
 *  - §5(6)/item 26: a two-row ladder's `twoSided` returns to true after a fill;
 *  - 28(7) as replaced by C4: a stored-settings ROUND TRIP at
 *    `gridSettingsParamsView`, because `DEFAULT_SETTINGS_DIGEST` cannot move
 *    under any grid-block change and the mutation the first review commissioned
 *    against it could not fail;
 *  - 28(8): an absent lane count treated as ZERO in the pre-check must die;
 *  - 28(9) + B2: reversing the last-slot comparator must die, AND a comparator
 *    that holds BOTH rows on EQUAL stamps must die;
 *  - 28(10) + C7: resetting the stranding stamp on `!settingsUnchanged` must
 *    die, and so must CLEARING it on an in-range reading;
 *  - 28(11): a LEGACY `maxMovesPerDay` signature keeps running with drift
 *    disabled, in both backends;
 *  - 28(12) + B1: the lane subtraction with ALL FIVE reported lanes live at
 *    once AND a MIXED NULL/settlement/drift window, in both backends;
 *  - B4: the stranding stamp's validator is as LOOSE as
 *    `rotationBreachStartedAtMs`'s — a stricter one silently restarts the clock;
 *  - N2.1: `quotaBound` stays TRUE for `grid-recenter`, so the lane split can
 *    never make a ladder motion quota-EXEMPT.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  evaluateGridTriggers,
  gridCrossReading,
  gridLadderBlockedBy,
  gridLadderResilience,
  gridSideChargesQuote,
  lpGridLadderFundingHoldReason,
  lpGridLadderQuotaHoldReason,
  lpGridLadderStrandedReason,
} from "../src/lp/gridTriggers.js";
import { gridDeriveRanges } from "../src/lp/gridGeometry.js";
import {
  DEFAULT_GRID_LADDER_DRIFT_MOVES_PER_DAY,
  DEFAULT_GRID_LADDER_SETTLEMENTS_PER_DAY,
  DEFAULT_LP_SETTINGS,
  ladderMotionCounts,
  ladderStrandedMinutes,
  validateLpSettings,
  type LpAutomationSettings,
  type LpGridLadder,
  type LpGridSettings,
  type LpTriggerObservation,
  type LpTriggerPositionInput,
} from "../src/lp/triggers.js";
import { parseLpTriggerObservation } from "../src/store/lpObservations.js";
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import type { LpRailConfig, LpRailEvidence } from "../src/lp/rails.js";
import {
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  type LpExitQuota,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import { checkLpNativeCapSizing } from "../src/ops/policy.js";
import { sanitizeMessage } from "../src/core/errors.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const OWNER = getAddress("0x2222222222222222222222222222222222222222");
const AGENT_ID = "grid-two-sided";

const INTERVAL_MS = 60_000;
const NOW_MS = 1_900_000_000_000;
const MINUTE = 60_000;
const RELAY_FEE = 100_000_000_000_000n;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 500,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

/** The NEW two-lane form, at the D1 defaults. */
const LADDER: LpGridLadder = {
  gapTicks: 60,
  widthTicks: 60,
  deployPctBps: 3_000,
  driftPctOfGap: 60,
  settlementsPerDay: DEFAULT_GRID_LADDER_SETTLEMENTS_PER_DAY,
  driftMovesPerDay: DEFAULT_GRID_LADDER_DRIFT_MOVES_PER_DAY,
  hedge: { enabled: true, minMarkoutBps: 75, maxHedgePctBps: 5_000 },
};

/** The 3.19 form, retained as legal-deprecated. */
const LEGACY_LADDER: LpGridLadder = {
  gapTicks: 60,
  widthTicks: 60,
  deployPctBps: 3_000,
  driftPctOfGap: 60,
  maxMovesPerDay: 12,
  hedge: { enabled: true, minMarkoutBps: 75, maxHedgePctBps: 5_000 },
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

/** A buffer generous enough to clear any economic floor at this fixture's size. */
const RICH = { quoteWei: 10n ** 22n, baseWei: 10n ** 22n };

function positionOn(
  grid: LpGridSettings,
  role: "buy" | "sell",
  currentTick: number,
  buffer?: { readonly quoteWei: bigint; readonly baseWei: bigint },
): LpTriggerPositionInput {
  const range = role === "buy" ? grid.buyRange : grid.sellRange;
  return {
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

type LadderInput = {
  readonly grid: LpGridSettings;
  readonly role: "buy" | "sell";
  readonly tick: number;
  readonly blockNumber?: bigint;
  readonly nowMs?: number;
  readonly previousObservation?: LpTriggerObservation;
  readonly buffer?: { readonly quoteWei: bigint; readonly baseWei: bigint };
  readonly settings?: Partial<LpAutomationSettings>;
  readonly settingsDigest?: string;
  readonly quota?: {
    readonly settlementLiveCount?: number;
    readonly driftLiveCount?: number;
    readonly latestReservedAtMs: number | null;
  };
  readonly arbitration?: {
    readonly positionId: string;
    readonly siblings: readonly {
      readonly positionId: string;
      readonly mismatchSinceMs: number | null;
    }[];
  };
};

function evaluateLadder(input: LadderInput): ReturnType<typeof evaluateGridTriggers> {
  return evaluateGridTriggers({
    settingsDigest: input.settingsDigest ?? "0xladder",
    intervalMs: INTERVAL_MS,
    market: market(input.blockNumber ?? 100n, input.tick),
    nowMs: input.nowMs ?? NOW_MS,
    position: positionOn(input.grid, input.role, input.tick, input.buffer ?? RICH),
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
    relayFeePerSubmitWei: RELAY_FEE,
    ...(input.quota === undefined ? {} : { ladderQuotaUsage: input.quota }),
    ...(input.arbitration === undefined ? {} : { ladderArbitration: input.arbitration }),
  });
}

/** The tick at which a rung has FILLED — strictly beyond its far edge. */
function filledTick(grid: LpGridSettings, role: "buy" | "sell"): number {
  const range = role === "buy" ? grid.buyRange : grid.sellRange;
  // A BUY rung holds quote; it has filled when the tick leaves it on the side
  // that charges the OTHER asset. Both orientations are covered by asking the
  // predicate itself rather than by hand-written direction arithmetic.
  const below = range.tickLower - 500;
  const above = range.tickUpper + 500;
  const belowFilled = gridCrossReading({
    currentTick: below,
    range,
    role,
    wbnbIsToken0: grid.wbnbIsToken0,
  }).filled;
  return belowFilled ? below : above;
}

/** Two confirmed observations of the same fill, one interval apart. */
function confirmFill(
  grid: LpGridSettings,
  role: "buy" | "sell",
  extra: Partial<LadderInput> = {},
): { first: LpTriggerObservation; second: ReturnType<typeof evaluateGridTriggers> } {
  const tick = filledTick(grid, role);
  const first = evaluateLadder({ grid, role, tick, ...extra });
  const second = evaluateLadder({
    grid,
    role,
    tick,
    blockNumber: 101n,
    nowMs: NOW_MS + INTERVAL_MS,
    previousObservation: first.nextObservation,
    ...extra,
  });
  return { first: first.nextObservation, second };
}

/* -------------------------------------------------------------------------- */
/* §5(1)/(2) + item 16 — WHICH LANE, FROM WHICH EVIDENCE                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 D1: the evidence decides the lane", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB token0)" : "Case A (WBNB token1)";

    it(`${label}: a confirmed FILL charges the SETTLEMENT lane`, () => {
      const grid = ladderGrid(wbnbIsToken0);
      const { second } = confirmFill(grid, "buy");
      assert.equal(second.decision, "grid-recenter");
      // THE MUTATION THIS KILLS: routing cross evidence into the drift lane.
      // It is the (az) defect with the labels swapped — a fill's settlement
      // spending the discretionary budget, which is the one thing two lanes
      // exist to make impossible.
      assert.equal(second.gridRecenterEvidence, "settlement");
    });

    it(`${label}: a confirmed DRIFT charges the DRIFT lane`, () => {
      const grid = ladderGrid(wbnbIsToken0);
      // A rung that is strictly outside its range on the side it was ARMED
      // holding has drifted, not filled. `gridDriftReading`'s own floor decides
      // how far; well past `gap x (1 + drift/100)` is unambiguous.
      const range = grid.buyRange;
      const filled = filledTick(grid, "buy");
      const drifted =
        filled < range.tickLower ? range.tickUpper + 5_000 : range.tickLower - 5_000;
      const first = evaluateLadder({ grid, role: "buy", tick: drifted });
      const second = evaluateLadder({
        grid,
        role: "buy",
        tick: drifted,
        blockNumber: 101n,
        nowMs: NOW_MS + INTERVAL_MS,
        previousObservation: first.nextObservation,
      });
      assert.equal(second.decision, "grid-recenter");
      assert.equal(second.gridRecenterEvidence, "drift");
    });
  }

  it("§5(2): a DRIFT cannot take the last SETTLEMENT slot", () => {
    const grid = ladderGrid(false);
    const range = grid.buyRange;
    const filled = filledTick(grid, "buy");
    const drifted =
      filled < range.tickLower ? range.tickUpper + 5_000 : range.tickLower - 5_000;
    const first = evaluateLadder({ grid, role: "buy", tick: drifted });
    // The DRIFT lane is spent; the SETTLEMENT lane is wide open. A one-lane
    // world would dispatch here on the settlement lane's leftover capacity —
    // which is exactly how (az)'s drift move consumed the fill's slot, seen from
    // the other side.
    const second = evaluateLadder({
      grid,
      role: "buy",
      tick: drifted,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
      quota: {
        settlementLiveCount: 0,
        driftLiveCount: LADDER.driftMovesPerDay ?? 0,
        latestReservedAtMs: null,
      },
    });
    assert.equal(second.decision, "hold");
    assert.match(second.holdReason ?? "", /drift lane is spent/u);
    assert.doesNotMatch(second.holdReason ?? "", /settlement lane is spent/u);
  });
});

/* -------------------------------------------------------------------------- */
/* §5(5) / item 11 — the mismatch predicate is REUSED, in both orderings      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 item 11: the mismatch predicate is gridCrossReading(...).filled", () => {
  it("a range holds the QUOTE exactly when its side charges the quote, both orderings", () => {
    // The regression pin, derived rather than asserted from a table: `"above"`
    // charges token0 and `"below"` charges token1, so the quote-charging side
    // INVERTS with the orientation. A hand-written second derivation of "is this
    // rung mismatched" is the 3.13 F7 class, and item 11 forbids one.
    assert.equal(gridSideChargesQuote("above", true), true);
    assert.equal(gridSideChargesQuote("below", true), false);
    assert.equal(gridSideChargesQuote("above", false), false);
    assert.equal(gridSideChargesQuote("below", false), true);
  });

  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B" : "Case A";
    it(`${label}: mismatch == filled for BOTH roles, and an in-range tick is neither`, () => {
      const grid = ladderGrid(wbnbIsToken0);
      for (const role of ["buy", "sell"] as const) {
        const range = role === "buy" ? grid.buyRange : grid.sellRange;
        const inside = Math.floor((range.tickLower + range.tickUpper) / 2);
        const reading = gridCrossReading({
          currentTick: inside,
          range,
          role,
          wbnbIsToken0,
        });
        assert.equal(reading.side, undefined, "an in-range tick presents NO side");
        assert.equal(reading.filled, false);
        const out = gridCrossReading({
          currentTick: filledTick(grid, role),
          range,
          role,
          wbnbIsToken0,
        });
        assert.notEqual(out.side, undefined);
        assert.equal(out.filled, true);
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/* items 12/13 + C7 + 28(10) — THE STRANDING CLOCK'S THREE-WAY RULE           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 C7: the stranding clock sets, carries and clears on three rules", () => {
  it("SET on the first mismatched observation, and KEPT thereafter", () => {
    const grid = ladderGrid(false);
    const tick = filledTick(grid, "buy");
    const first = evaluateLadder({ grid, role: "buy", tick });
    assert.equal(first.nextObservation.gridMismatchSinceMs, NOW_MS);
    const second = evaluateLadder({
      grid,
      role: "buy",
      tick,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
    });
    assert.equal(
      second.nextObservation.gridMismatchSinceMs,
      NOW_MS,
      "the stamp is a SET TIME, not a counter — it never advances while mismatched",
    );
  });

  it("28(10): a settings re-sign does NOT reset it, while the anti-wick counters DO", () => {
    const grid = ladderGrid(false);
    const tick = filledTick(grid, "buy");
    const first = evaluateLadder({ grid, role: "buy", tick, settingsDigest: "0xone" });
    const second = evaluateLadder({
      grid,
      role: "buy",
      tick,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
      // A DIFFERENT digest: `settingsUnchanged` is false this cycle.
      settingsDigest: "0xtwo",
    });
    // The counter resets — that is the anti-wick discipline, unchanged.
    assert.equal(second.nextObservation.gridCrossConsecutive, 1);
    // THE MUTATION THIS KILLS: gating the carry-forward on `settingsUnchanged`.
    // An owner re-signing every 40 minutes would postpone the bound for ever,
    // which is H2 — a liveness clock has the OPPOSITE requirement to evidence.
    assert.equal(second.nextObservation.gridMismatchSinceMs, NOW_MS);
  });

  it("C7: an IN-RANGE reading CARRIES the stamp forward — clearing it would defeat the bound in a chop", () => {
    const grid = ladderGrid(false);
    const tick = filledTick(grid, "buy");
    const first = evaluateLadder({ grid, role: "buy", tick });
    const inside = Math.floor((grid.buyRange.tickLower + grid.buyRange.tickUpper) / 2);
    const wandered = evaluateLadder({
      grid,
      role: "buy",
      tick: inside,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
    });
    // THE MUTATION THIS KILLS: clearing on `side === undefined`. An in-range
    // tick reads `{side: undefined, filled: false}`, so "clear when not
    // mismatched" resets the clock on every chop — and a chop is the market the
    // bound exists for. This is H2's defeat through the PRICE door.
    assert.equal(wandered.nextObservation.gridMismatchSinceMs, NOW_MS);
  });

  it("C7: a rung affirmatively back on its OWN side CLEARS the stamp", () => {
    const grid = ladderGrid(false);
    const tick = filledTick(grid, "buy");
    const first = evaluateLadder({ grid, role: "buy", tick });
    // The OTHER side of the range: a side EXISTS and it is not the filled one.
    const range = grid.buyRange;
    const back = tick < range.tickLower ? range.tickUpper + 500 : range.tickLower - 500;
    const cleared = evaluateLadder({
      grid,
      role: "buy",
      tick: back,
      blockNumber: 101n,
      nowMs: NOW_MS + INTERVAL_MS,
      previousObservation: first.nextObservation,
    });
    assert.equal(cleared.nextObservation.gridMismatchSinceMs, undefined);
  });

  it("a FIXED-mode grid never carries the key, so its observation bytes do not move", () => {
    const { ladder: _drop, ...rest } = ladderGrid(false);
    const grid: LpGridSettings = { ...rest, mode: "fixed" };
    const first = evaluateLadder({ grid, role: "buy", tick: filledTick(grid, "buy") });
    assert.equal(first.nextObservation.gridMismatchSinceMs, undefined);
    assert.ok(!("gridMismatchSinceMs" in first.nextObservation));
  });
});

/* -------------------------------------------------------------------------- */
/* B4 / N14 — the stamp's validator is the LOOSEST sound one                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 B4: gridMismatchSinceMs validates as loosely as rotationBreachStartedAtMs", () => {
  const row = (extra: Record<string, unknown>): unknown => ({
    blockNumber: 10n,
    evaluatedAtMs: NOW_MS,
    poolAddress: POOL,
    protectConsecutive: 0,
    rotationBreach: false,
    rotationConsecutive: 0,
    tokenId: "42",
    ...extra,
  });

  it("a NON-INTEGER millisecond survives — the field must never reject a whole observation", () => {
    // THE MUTATION THIS KILLS: `Number.isInteger` here instead of
    // `Number.isFinite`. The codec is fail-closed OBSERVATION-WIDE, so a
    // stricter validator returns `null` for the WHOLE row, `null` reads as "no
    // previous observation", and the stranding clock SILENTLY RESTARTS — in
    // exactly the long-running case the bound exists for.
    const parsed = parseLpTriggerObservation(row({ gridMismatchSinceMs: NOW_MS + 0.5 }));
    assert.notEqual(parsed, null);
    assert.equal(parsed?.gridMismatchSinceMs, NOW_MS + 0.5);
    // The neighbour it must match, asserted side by side so a future tightening
    // of one is visibly a divergence from the other.
    const neighbour = parseLpTriggerObservation(
      row({ rotationBreachStartedAtMs: NOW_MS + 0.5 }),
    );
    assert.notEqual(neighbour, null);
  });

  it("absent stays ABSENT, and a negative or non-finite value is still refused", () => {
    const absent = parseLpTriggerObservation(row({}));
    assert.notEqual(absent, null);
    assert.ok(!("gridMismatchSinceMs" in (absent as object)));
    assert.equal(parseLpTriggerObservation(row({ gridMismatchSinceMs: -1 })), null);
    assert.equal(
      parseLpTriggerObservation(row({ gridMismatchSinceMs: Number.NaN })),
      null,
    );
    assert.equal(parseLpTriggerObservation(row({ gridMismatchSinceMs: "5" })), null);
  });

  it("the field ROUND-TRIPS, so a stamp written into the jsonb is not dropped on read", () => {
    // The (ae) trap, one field further on: a value written into the blob but not
    // rebuilt here is silently dropped, the clock restarts every cycle, and the
    // bound can NEVER mature — with nothing to see but a patient hold.
    const parsed = parseLpTriggerObservation(row({ gridMismatchSinceMs: NOW_MS }));
    assert.equal(parsed?.gridMismatchSinceMs, NOW_MS);
  });
});

/* -------------------------------------------------------------------------- */
/* §5(3) / D2 / item 15 — THE STRANDING BOUND, (az) REPLAYED                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 D2: the stranding bound fires on the clock, not on the counters", () => {
  it("§5(3): a rung stranded past the bound is settled even with the DRIFT lane spent", () => {
    const grid = ladderGrid(false);
    const tick = filledTick(grid, "buy");
    const bound = ladderStrandedMinutes(LADDER, 5);
    // The (az) state: the rung filled long ago and its cross counter has since
    // been reset (a comparability gap is enough), so `crossReady` is FALSE — and
    // in 3.19 nothing would ever move it.
    const stale: LpTriggerObservation = {
      blockNumber: 99n,
      evaluatedAtMs: NOW_MS - (bound.value + 5) * MINUTE,
      poolAddress: POOL,
      protectConsecutive: 0,
      rotationBreach: false,
      rotationConsecutive: 0,
      gridCrossConsecutive: 0,
      gridMismatchSinceMs: NOW_MS - (bound.value + 5) * MINUTE,
      tokenId: "42",
    };
    const decided = evaluateLadder({
      grid,
      role: "buy",
      tick,
      blockNumber: 101n,
      previousObservation: stale,
      quota: {
        settlementLiveCount: 0,
        // The discretionary lane is fully spent — the (az) shape.
        driftLiveCount: LADDER.driftMovesPerDay ?? 0,
        latestReservedAtMs: null,
      },
    });
    assert.equal(decided.decision, "grid-recenter");
    assert.equal(decided.gridRecenterEvidence, "settlement");
    assert.match(decided.triggerReason.reason, /stranding bound/u);
    assert.match(decided.triggerReason.reason, /held\s+the wrong asset/u);
  });

  it("BEFORE the bound, the same state HOLDS — the clock is the whole trigger", () => {
    const grid = ladderGrid(false);
    const bound = ladderStrandedMinutes(LADDER, 5);
    const young: LpTriggerObservation = {
      blockNumber: 99n,
      evaluatedAtMs: NOW_MS - (bound.value - 1) * MINUTE,
      poolAddress: POOL,
      protectConsecutive: 0,
      rotationBreach: false,
      rotationConsecutive: 0,
      gridCrossConsecutive: 0,
      gridMismatchSinceMs: NOW_MS - (bound.value - 1) * MINUTE,
      tokenId: "42",
    };
    const held = evaluateLadder({
      grid,
      role: "buy",
      tick: filledTick(grid, "buy"),
      blockNumber: 101n,
      previousObservation: young,
    });
    assert.equal(held.decision, "hold");
  });

  it("item 15: a stranded rung that cannot FUND its re-place holds on FUNDING, not on the clock", () => {
    const grid = ladderGrid(false);
    const bound = ladderStrandedMinutes(LADDER, 5);
    const stale: LpTriggerObservation = {
      blockNumber: 99n,
      evaluatedAtMs: NOW_MS - (bound.value + 5) * MINUTE,
      poolAddress: POOL,
      protectConsecutive: 0,
      rotationBreach: false,
      rotationConsecutive: 0,
      gridMismatchSinceMs: NOW_MS - (bound.value + 5) * MINUTE,
      tokenId: "42",
    };
    const held = evaluateLadder({
      grid,
      role: "buy",
      tick: filledTick(grid, "buy"),
      blockNumber: 101n,
      previousObservation: stale,
      buffer: { quoteWei: 0n, baseWei: 0n },
    });
    assert.equal(held.decision, "hold");
    // The bound REPLACES the `(crossReady || driftReady)` conjunct and NOTHING
    // else: funding is still the true blocker, so it is the sentence the owner
    // reads — naming the clock here would send them to the wrong knob.
    assert.match(held.holdReason ?? "", /waiting on inventory/u);
    assert.match(held.holdReason ?? "", /Remedy: add the charged asset/u);
  });
});

/* -------------------------------------------------------------------------- */
/* §5(4) + items 17-19 + 28(8) — THE PRE-CHECK, AND ITS FAIL-CLOSED RULES     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 D3: the pre-check HOLDS instead of churning", () => {
  it("a spent SETTLEMENT lane holds, and the sentence names the lane and its remedy", () => {
    const grid = ladderGrid(false);
    const { second } = confirmFill(grid, "buy", {
      quota: {
        settlementLiveCount: LADDER.settlementsPerDay ?? 0,
        driftLiveCount: 0,
        latestReservedAtMs: null,
      },
    });
    assert.equal(second.decision, "hold");
    assert.match(second.holdReason ?? "", /settlement lane is spent/u);
    assert.match(second.holdReason ?? "", /NO sequence, NO reservation/u);
    assert.match(second.holdReason ?? "", /settlementsPerDay/u);
  });

  it("H4: the SPACING gate is checked from the SAME value, and names itself", () => {
    const grid = ladderGrid(false);
    const { second } = confirmFill(grid, "buy", {
      quota: {
        settlementLiveCount: 0,
        driftLiveCount: 0,
        // Inside `minMinutesBetweenExits: 5` of the last reservation.
        latestReservedAtMs: NOW_MS + INTERVAL_MS - MINUTE,
      },
    });
    assert.equal(second.decision, "hold");
    assert.match(second.holdReason ?? "", /minMinutesBetweenExits/u);
    assert.match(second.holdReason ?? "", /AGENT-WIDE/u);
  });

  it("28(8): an ABSENT lane count is usage = LIMIT, never zero", () => {
    const grid = ladderGrid(false);
    // THE MUTATION THIS KILLS: `?? 0` on the lane count. `LpQuotaUsage`'s lane
    // fields are optional with a documented `?? 0` convention that is right for
    // a DASHBOARD and fails OPEN in a GATE — and this phase makes one a gate.
    const { second } = confirmFill(grid, "buy", {
      quota: { latestReservedAtMs: null },
    });
    assert.equal(second.decision, "hold");
    assert.match(second.holdReason ?? "", /settlement lane is spent/u);
  });

  it("C9: `latestReservedAtMs: null` is NO ANCHOR — permissive, and distinct from unread", () => {
    const grid = ladderGrid(false);
    const { second } = confirmFill(grid, "buy", {
      quota: { settlementLiveCount: 0, driftLiveCount: 0, latestReservedAtMs: null },
    });
    assert.equal(second.decision, "grid-recenter");
  });

  it("an ABSENT usage object leaves the 3.19 path byte-identical", () => {
    const grid = ladderGrid(false);
    const { second } = confirmFill(grid, "buy");
    assert.equal(second.decision, "grid-recenter");
  });
});

/* -------------------------------------------------------------------------- */
/* item 16 + 28(9) + B2 — THE LAST-SLOT COMPARATOR                            */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 item 16 / B2: the last settlement slot goes to the OLDER stranding", () => {
  const grid = ladderGrid(false);
  const lastSlot = {
    settlementLiveCount: (LADDER.settlementsPerDay ?? 0) - 1,
    driftLiveCount: 0,
    latestReservedAtMs: null,
  };

  it("this row WINS when its stamp is older", () => {
    const { second } = confirmFill(grid, "buy", {
      quota: lastSlot,
      arbitration: {
        positionId: "pos-a",
        siblings: [{ positionId: "pos-b", mismatchSinceMs: NOW_MS + 10 * MINUTE }],
      },
    });
    assert.equal(second.decision, "grid-recenter");
  });

  it("28(9): this row LOSES to an older sibling and HOLDS — reversing the comparator must die", () => {
    const { second } = confirmFill(grid, "buy", {
      quota: lastSlot,
      arbitration: {
        positionId: "pos-a",
        siblings: [{ positionId: "pos-b", mismatchSinceMs: NOW_MS - 10 * MINUTE }],
      },
    });
    assert.equal(second.decision, "hold");
  });

  it("B2: EQUAL stamps break on the positionId — a strict comparator LIVELOCKS both rows", () => {
    // The cycle clock is FROZEN, so two rungs a price gap fills in the SAME
    // cycle carry the IDENTICAL millisecond. Under a strict "older wins"
    // NEITHER wins the last slot, both hold, and — because the stamp never
    // advances — they hold every cycle FOR EVER: a second permanent one-sided
    // state, created by the rule written to prevent the first.
    const mine = confirmFill(grid, "buy", {
      quota: lastSlot,
      arbitration: {
        positionId: "pos-a",
        siblings: [{ positionId: "pos-b", mismatchSinceMs: NOW_MS }],
      },
    });
    const theirs = confirmFill(grid, "buy", {
      quota: lastSlot,
      arbitration: {
        positionId: "pos-b",
        siblings: [{ positionId: "pos-a", mismatchSinceMs: NOW_MS }],
      },
    });
    // EXACTLY ONE of the two takes the slot, and it is the lexicographically
    // smaller id. A comparator that held both would fail this.
    assert.equal(mine.second.decision, "grid-recenter");
    assert.equal(theirs.second.decision, "hold");
  });

  it("a sibling with NO stamp never blocks — a closed row reads that way", () => {
    const { second } = confirmFill(grid, "buy", {
      quota: lastSlot,
      arbitration: {
        positionId: "pos-a",
        siblings: [{ positionId: "pos-b", mismatchSinceMs: null }],
      },
    });
    assert.equal(second.decision, "grid-recenter");
  });

  it("the arbitration runs on the LAST SLOT ONLY — with room to spare BOTH dispatch", () => {
    const { second } = confirmFill(grid, "buy", {
      quota: { settlementLiveCount: 0, driftLiveCount: 0, latestReservedAtMs: null },
      arbitration: {
        positionId: "pos-a",
        siblings: [{ positionId: "pos-b", mismatchSinceMs: NOW_MS - 10 * MINUTE }],
      },
    });
    assert.equal(second.decision, "grid-recenter");
  });
});

/* -------------------------------------------------------------------------- */
/* item 26 / M3 — the one-sided classifier                                    */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 item 26: gridLadderBlockedBy is ONE classifier for hold and view", () => {
  it("a two-sided ladder is blocked by nothing", () => {
    assert.equal(
      gridLadderBlockedBy({ twoSided: true, laneOpen: false, spacingOpen: false }),
      "none",
    );
  });

  it("FUNDING outranks the two gates — a defunded rung must not take the last slot", () => {
    assert.equal(
      gridLadderBlockedBy({
        twoSided: false,
        fundingOk: false,
        laneOpen: false,
        spacingOpen: false,
      }),
      "funding",
    );
  });

  it("then the LANE, then the SPACING gate", () => {
    assert.equal(
      gridLadderBlockedBy({
        twoSided: false,
        fundingOk: true,
        laneOpen: false,
        spacingOpen: true,
      }),
      "quota",
    );
    assert.equal(
      gridLadderBlockedBy({
        twoSided: false,
        fundingOk: true,
        laneOpen: true,
        spacingOpen: false,
      }),
      "spacing",
    );
  });

  it("an in-flight motion is NOT a blocker", () => {
    assert.equal(
      gridLadderBlockedBy({
        twoSided: false,
        inFlight: true,
        laneOpen: false,
        spacingOpen: false,
      }),
      "none",
    );
  });

  it("UNMEASURED funding with both gates open falls to the terminal state B1 names", () => {
    // The owner view takes no pool-state read, so it cannot price `minRungWei`
    // against the buffer. A one-sided ladder that is neither gated nor moving
    // has exactly one remaining explanation, and it is the permanent one.
    assert.equal(
      gridLadderBlockedBy({ twoSided: false, laneOpen: true, spacingOpen: true }),
      "funding",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R3.1 / C3 — THE EXHAUSTION ARITHMETIC                                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 R3.1: gridLadderResilience implements A.2's closed form", () => {
  const minBudget = 10n ** 18n;

  it("at the printed MINIMUM budget the ladder settles ZERO fills", () => {
    const r = gridLadderResilience({
      budgetWei: minBudget,
      minBudgetWei: minBudget,
      deployPctBps: 3_000,
    });
    assert.equal(r.fundableFills, 0);
    // `1/(1-0.3) = 1.4286`, rounded UP the way every floor in this lineage is.
    assert.equal(r.requiredMultipleBps, 14_286);
    assert.equal(r.minFundableBudgetWei, (minBudget * 14_286n + 9_999n) / 10_000n);
  });

  it("the A.2 table, at the default deployPctBps", () => {
    // THE MUTATION THIS KILLS: restoring the first review's M2 form, which
    // compared the BUFFER against `minRungWei` where the gate compares
    // `d x buffer` — overstating by 2-3 fills at the default and sending the
    // owner the wrong headline decision number.
    for (const [multiple, fills] of [
      [1, 0],
      [2, 1],
      [3, 3],
      [5, 4],
      [10, 6],
      [20, 8],
    ] as const) {
      assert.equal(
        gridLadderResilience({
          budgetWei: minBudget * BigInt(multiple),
          minBudgetWei: minBudget,
          deployPctBps: 3_000,
        }).fundableFills,
        fills,
        `m = ${multiple}`,
      );
    }
  });

  it("raising deployPctBps LOWERS the resilience — the cheaper geometry is the fragile one", () => {
    // At `d = 0.5` the table is `N = floor(ln m / ln 2)`: M1's "nudge",
    // quantified. The minimum budget shrinks by a third and N shrinks with it.
    assert.equal(
      gridLadderResilience({
        budgetWei: minBudget * 10n,
        minBudgetWei: minBudget,
        deployPctBps: 5_000,
      }).fundableFills,
      3,
    );
  });

  it("a geometry with NO economic rung answers null rather than a number", () => {
    const r = gridLadderResilience({
      budgetWei: minBudget,
      minBudgetWei: null,
      deployPctBps: 3_000,
    });
    assert.equal(r.fundableFills, null);
    assert.equal(r.minFundableBudgetWei, null);
  });
});

/* -------------------------------------------------------------------------- */
/* C10 / C11 — the two derived quantities, each in ONE place                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 C10: ladderMotionCounts is the ONE legacy interpretation", () => {
  it("a LEGACY block reads as settlements = maxMovesPerDay, drift = 0", () => {
    assert.deepEqual(ladderMotionCounts(LEGACY_LADDER), {
      settlementsPerDay: 12,
      driftMovesPerDay: 0,
    });
  });

  it("a NEW-form block reads its own two numbers", () => {
    assert.deepEqual(ladderMotionCounts(LADDER), {
      settlementsPerDay: 8,
      driftMovesPerDay: 4,
    });
  });

  it("the new form WINS even when only one of its two keys is present", () => {
    const partial = { ...LEGACY_LADDER, settlementsPerDay: 3 } as LpGridLadder;
    assert.deepEqual(ladderMotionCounts(partial), {
      settlementsPerDay: 3,
      driftMovesPerDay: 0,
    });
  });
});

describe("PHASE3.20 C11: maxStrandedMinutes' floor, default and ceiling are COMPUTED", () => {
  it("at the plane's DEFAULT spacing of 30 the literal 45 would be below its own floor", () => {
    const bound = ladderStrandedMinutes(LADDER, 30);
    assert.equal(bound.floor, 60);
    assert.equal(bound.defaultValue, 60, "the default is lifted to its own floor");
    assert.equal(bound.value, 60);
  });

  it("above 120 the nominal 5..240 range would be EMPTY; the ceiling is lifted too", () => {
    const bound = ladderStrandedMinutes(LADDER, 200);
    assert.equal(bound.floor, 400);
    assert.equal(bound.ceiling, 400);
    assert.ok(bound.floor <= bound.ceiling, "the interval is never empty");
  });

  it("at the ladder client's own spacing of 5 the default is the nominal 45", () => {
    assert.equal(ladderStrandedMinutes(LADDER, 5).value, 45);
  });

  it("ABSENT means the computed default — the bound is NEVER silently disabled", () => {
    const { maxStrandedMinutes: _drop, ...rest } = { ...LADDER, maxStrandedMinutes: 90 };
    assert.equal(ladderStrandedMinutes(rest as LpGridLadder, 5).value, 45);
  });
});

/* -------------------------------------------------------------------------- */
/* The migration ruling — exactly one form, at the VALIDATOR                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 D1: exactly one motion form is accepted", () => {
  const settingsWith = (ladder: Partial<LpGridLadder>): LpAutomationSettings => ({
    ...DEFAULT_LP_SETTINGS,
    minMinutesBetweenExits: 5,
    grid: ladderGrid(false, { ...LADDER, ...ladder } as LpGridLadder),
  });

  it("BOTH forms present is refused, naming the remedy", () => {
    assert.throws(
      () => validateLpSettings(settingsWith({ maxMovesPerDay: 12 })),
      /Exactly one form is accepted/u,
    );
  });

  it("NEITHER form present is refused — no default is invented on the wire", () => {
    const { settlementsPerDay: _a, driftMovesPerDay: _b, ...rest } = LADDER;
    assert.throws(
      () =>
        validateLpSettings({
          ...DEFAULT_LP_SETTINGS,
          minMinutesBetweenExits: 5,
          grid: ladderGrid(false, rest as LpGridLadder),
        }),
      /neither is present/u,
    );
  });

  it("28(11): the LEGACY form alone still validates", () => {
    const { settlementsPerDay: _a, driftMovesPerDay: _b, ...rest } = LADDER;
    validateLpSettings({
      ...DEFAULT_LP_SETTINGS,
      minMinutesBetweenExits: 5,
      grid: ladderGrid(false, { ...rest, maxMovesPerDay: 12 } as LpGridLadder),
    });
  });

  it("`driftMovesPerDay: 0` is LEGAL — settle fills, never chase", () => {
    validateLpSettings(settingsWith({ driftMovesPerDay: 0 }));
    assert.throws(
      () => validateLpSettings(settingsWith({ driftMovesPerDay: -1 })),
      /driftMovesPerDay must be an integer in 0\.\.24/u,
    );
    assert.throws(
      () => validateLpSettings(settingsWith({ settlementsPerDay: 0 })),
      /settlementsPerDay must be an integer in 1\.\.24/u,
    );
  });

  it("item 9: the reachability rule is FOUR-WAY and names all four limits", () => {
    assert.throws(
      () =>
        validateLpSettings({
          ...DEFAULT_LP_SETTINGS,
          // 1 + 0 + 24 + 24 = 49 against floor(1440/30) = 48.
          minMinutesBetweenExits: 30,
          grid: ladderGrid(false, {
            ...LADDER,
            settlementsPerDay: 24,
            driftMovesPerDay: 24,
            maxStrandedMinutes: 60,
          } as LpGridLadder),
        }),
      /settlementsPerDay 24 \+ grid\.ladder\.driftMovesPerDay 24 is unreachable/u,
    );
  });

  it("C11: a maxStrandedMinutes under its computed floor is refused, naming both numbers", () => {
    assert.throws(
      () => validateLpSettings(settingsWith({ maxStrandedMinutes: 9 })),
      /must be an integer in 10\.\.240 at minMinutesBetweenExits 5/u,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* C4 / 28(7) — THE CANONICAL-PARAMS ROUND TRIP                               */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 C4: the digest pin is a STORED-SETTINGS round trip, not the default digest", () => {
  const PINNED_POOL = { token0: WBNB, token1: TOKEN_HI, fee: 2_500 };
  const base = {
    pool: PINNED_POOL,
    wbnbIsToken0: true,
    tickSpacing: 50,
    buyRange: { tickLower: -1_750, tickUpper: -1_550 },
    sellRange: { tickLower: 1_550, tickUpper: 1_750 },
    maxFlipsPerDay: 1,
    minNetEdgeBps: 0,
    mode: "ladder" as const,
  };
  const legacy: LpGridSettings = {
    ...base,
    ladder: {
      gapTicks: 1_500,
      widthTicks: 200,
      deployPctBps: 3_000,
      driftPctOfGap: 60,
      maxMovesPerDay: 12,
      hedge: { enabled: true, minMarkoutBps: 75, maxHedgePctBps: 5_000 },
    },
  };
  const modern: LpGridSettings = {
    ...base,
    ladder: {
      gapTicks: 1_500,
      widthTicks: 200,
      deployPctBps: 3_000,
      driftPctOfGap: 60,
      settlementsPerDay: 8,
      driftMovesPerDay: 4,
      maxStrandedMinutes: 45,
      hedge: { enabled: true, minMarkoutBps: 75, maxHedgePctBps: 5_000 },
    },
  };
  const digestOf = (grid: LpGridSettings): string =>
    paramsHash("lpSettings", lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, grid }));

  it("a LEGACY-signed ladder's recomputed digest is BYTE-IDENTICAL to the pre-change build's", () => {
    // THE PIN, and it is the one the first review's own mutation could not be:
    // `DEFAULT_LP_SETTINGS.grid` is `null`, so NOTHING emitted inside the grid
    // block can move `DEFAULT_SETTINGS_DIGEST` — a mutation that emitted
    // `settlementsPerDay` unconditionally would survive that assertion while
    // breaking every live agent. What actually breaks is the recomputed digest
    // of every LADDER-SIGNED row, which `currentSettingsDigest()` compares
    // against every in-flight sequence, so THAT is what is pinned here.
    assert.equal(
      digestOf(legacy),
      "0xafb1e5454edc31134cbfcb8c8be306a59e7fff854a113d3fa379638a09e6ed33",
    );
    // And the emitted key set, so the reason the digest holds is visible rather
    // than merely asserted: three keys this phase adds, NONE of them present.
    const emitted = (
      lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, grid: legacy })["grid"] as Record<
        string,
        unknown
      >
    )["ladder"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(emitted), [
      "gapTicks",
      "widthTicks",
      "deployPctBps",
      "driftPctOfGap",
      "maxMovesPerDay",
      "hedge",
    ]);
  });

  it("a NEW-form ladder emits its own three keys and NOT maxMovesPerDay (N9)", () => {
    const emitted = (
      lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, grid: modern })["grid"] as Record<
        string,
        unknown
      >
    )["ladder"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(emitted), [
      "gapTicks",
      "widthTicks",
      "deployPctBps",
      "driftPctOfGap",
      "settlementsPerDay",
      "driftMovesPerDay",
      "maxStrandedMinutes",
      "hedge",
    ]);
    assert.equal(
      digestOf(modern),
      "0x8925b95fb134925b3cef3585024c4c55a5f34e2447e4204a713f21ac47e4859c",
    );
    assert.notEqual(digestOf(modern), digestOf(legacy));
  });

  it("DEFAULT_SETTINGS_DIGEST is a FLOOR here, not the pin — it cannot move at all", () => {
    // Kept because it is cheap and because a build that DID move it would be
    // catastrophic; declared as a floor because `DEFAULT_LP_SETTINGS.grid` is
    // `null` and therefore no grid-block change can reach it.
    assert.equal(
      paramsHash("lpSettings", lpSettingsParamsView(DEFAULT_LP_SETTINGS)),
      "0x7c9676678e0b193abf18c12a8346a2de18c5936e1a5771f63a0e3c280ce08134",
    );
    assert.equal(DEFAULT_LP_SETTINGS.grid, null);
  });
});

/* -------------------------------------------------------------------------- */
/* item 22 — the sizing check takes TWO NAMED COUNTS                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.20 item 22: checkLpNativeCapSizing takes the two counts", () => {
  const base = {
    onChainDailyCapWei: 10n ** 18n,
    openNativeBudgetWei: 10n ** 15n,
    maxExitSequencesPerDay: 4,
    lpRelayFeePerSubmitWei: RELAY_FEE,
  } as const;

  it("`driftMovesPerDay: 0` is accepted — the single legacy argument would refuse it", () => {
    const result = checkLpNativeCapSizing({
      ...base,
      settlementsPerDay: 12,
      driftMovesPerDay: 0,
    });
    assert.equal(result.ok, true);
  });

  it("each field carries its OWN malformed message", () => {
    assert.match(
      (checkLpNativeCapSizing({ ...base, settlementsPerDay: 0 }) as { message: string })
        .message,
      /settlementsPerDay must be an integer in 1\.\.24/u,
    );
    assert.match(
      (checkLpNativeCapSizing({ ...base, driftMovesPerDay: 25 }) as { message: string })
        .message,
      /driftMovesPerDay must be an integer in 0\.\.24/u,
    );
  });

  it("the pair SUMS into the one recenter reserve — 8 + 4 is the shipped 12", () => {
    const pair = checkLpNativeCapSizing({
      ...base,
      onChainDailyCapWei: 10n ** 15n,
      settlementsPerDay: 8,
      driftMovesPerDay: 4,
    });
    const legacy = checkLpNativeCapSizing({
      ...base,
      onChainDailyCapWei: 10n ** 15n,
      maxMovesPerDay: 12,
    });
    assert.equal(
      (pair as { shortfallWei: bigint }).shortfallWei,
      (legacy as { shortfallWei: bigint }).shortfallWei,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* items 6-8 + 28(11)/(12) + B1 + N2.1 — THE STORE, IN BOTH BACKENDS          */
/* -------------------------------------------------------------------------- */

const START = 1_760_000_000_000;

const backends: readonly {
  readonly name: string;
  readonly make: (now: () => number) => Promise<LpSequenceStore>;
}[] = [
  { name: "memory", make: async (now) => new MemoryLpSequenceStore(now) },
  {
    name: "postgres(fake)",
    make: async (now) => PostgresLpSequenceStore.create(new FakeSqlClient(), now),
  },
];

async function seed(store: LpSequenceStore, positionId: string): Promise<void> {
  await store.createPosition({
    positionId,
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    token0: WBNB,
    token1: TOKEN_HI,
    fee: 2_500,
    basisWei: 0n,
    basisSource: "minted",
  });
}

const QUOTA: LpExitQuota = {
  maxExitSequencesPerDay: 4,
  minMinutesBetweenExits: 5,
  maxGridFlipsPerDay: 12,
  maxRequotesPerDay: 12,
  maxSettlementsPerDay: 2,
  maxDriftMovesPerDay: 1,
};

describe("PHASE3.20 items 6-8: the ladder's lane is a property of the ROW", () => {
  for (const backend of backends) {
    it(`${backend.name}: the evidence written at CREATE decides the lane at RESERVE`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      await seed(store, "pos-drift");
      const created = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "pos-drift",
        kind: "grid-recenter",
        recenterEvidence: "drift",
      });
      assert.equal(created.recenterEvidence, "drift");
      const reservation = await store.reserveSequence(
        OWNER,
        AGENT_ID,
        created.sequenceId,
        QUOTA,
      );
      assert.equal(reservation.quotaLane, "drift");
      // N2.1 — THE FAIL-OPEN THAT RETIRING THE LANE WOULD HAVE CREATED. A
      // `grid-recenter` whose kind mapped to no lane becomes quota-EXEMPT at
      // both backends (`quotaBound = lane !== undefined`): unbounded motions,
      // AND excluded from the exit lane's leftover subtraction.
      assert.equal(reservation.quotaBound, true);
      now += 6 * MINUTE;
      const usage = await store.quotaUsage(OWNER, AGENT_ID);
      assert.equal(usage.driftLiveCount, 1);
      assert.equal(usage.settlementLiveCount, 0);
      assert.equal(usage.recenterLiveCount, 1, "the SUM still reports the whole lane");
      assert.equal(usage.liveCount, 0, "and NONE of it lands on the exit lane");
    });

    it(`${backend.name}: a DRIFT cannot spend the SETTLEMENT budget, and vice versa`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      // One drift motion exhausts `maxDriftMovesPerDay: 1`.
      await seed(store, "pos-d0");
      const d0 = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "pos-d0",
        kind: "grid-recenter",
        recenterEvidence: "drift",
      });
      await store.reserveSequence(OWNER, AGENT_ID, d0.sequenceId, QUOTA);
      now += 6 * MINUTE;
      // A SECOND drift is refused...
      await seed(store, "pos-d1");
      const d1 = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "pos-d1",
        kind: "grid-recenter",
        recenterEvidence: "drift",
      });
      await assert.rejects(store.reserveSequence(OWNER, AGENT_ID, d1.sequenceId, QUOTA), {
        code: "LP_EXIT_QUOTA",
      });
      now += 6 * MINUTE;
      // ...while a SETTLEMENT still runs. This is the (az) defect, closed: the
      // discretionary motion cannot consume the mandatory one's capacity.
      await seed(store, "pos-s0");
      const s0 = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "pos-s0",
        kind: "grid-recenter",
        recenterEvidence: "settlement",
      });
      const reserved = await store.reserveSequence(OWNER, AGENT_ID, s0.sequenceId, QUOTA);
      assert.equal(reserved.quotaLane, "settlement");
    });

    it(`${backend.name}: C6 — a NULL evidence reserves in the SETTLEMENT lane`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      await seed(store, "pos-null");
      const created = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "pos-null",
        kind: "grid-recenter",
      });
      assert.equal(created.recenterEvidence, null);
      const reservation = await store.reserveSequence(
        OWNER,
        AGENT_ID,
        created.sequenceId,
        QUOTA,
      );
      assert.equal(reservation.quotaLane, null);
      now += 6 * MINUTE;
      const usage = await store.quotaUsage(OWNER, AGENT_ID);
      // B1 — THE NULL ARM. A pre-migration row must count in the SETTLEMENT
      // lane, not fall out of both: the natural `quota_lane = 'settlement'` in
      // SQL is UNKNOWN for a NULL, which would give the owner a free extra day
      // of motions and break the reported SUM by exactly the NULL count.
      assert.equal(usage.settlementLiveCount, 1);
      assert.equal(usage.driftLiveCount, 0);
      assert.equal(usage.recenterLiveCount, 1);
    });

    it(`${backend.name}: 28(12)/B1 — a MIXED window keeps settlement + drift === recenter`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      const quota: LpExitQuota = {
        ...QUOTA,
        maxSettlementsPerDay: 24,
        maxDriftMovesPerDay: 24,
      };
      // FIVE reported lanes live at once, and the recenter lane itself carries a
      // NULL row alongside both named ones — the fixture B1(c) requires.
      const rows: readonly (readonly [string, "rotate" | "grid-flip" | "grid-requote" | "grid-recenter", "settlement" | "drift" | undefined])[] = [
        ["pos-0", "rotate", undefined],
        ["pos-1", "grid-flip", undefined],
        ["pos-2", "grid-requote", undefined],
        ["pos-3", "grid-recenter", "settlement"],
        ["pos-4", "grid-recenter", "drift"],
        ["pos-5", "grid-recenter", undefined],
      ];
      for (const [positionId, kind, evidence] of rows) {
        await seed(store, positionId);
        const created = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId,
          kind,
          ...(evidence === undefined ? {} : { recenterEvidence: evidence }),
        });
        await store.reserveSequence(OWNER, AGENT_ID, created.sequenceId, quota);
        now += 6 * MINUTE;
      }
      const usage = await store.quotaUsage(OWNER, AGENT_ID);
      assert.equal(usage.liveCount, 1, "only the rotate belongs to the exit lane");
      assert.equal(usage.gridFlipLiveCount, 1);
      assert.equal(usage.requoteLiveCount, 1);
      assert.equal(usage.recenterLiveCount, 3);
      // THE MUTATION THIS KILLS: narrowing the settlement predicate to
      // `quota_lane = 'settlement'`. The NULL row falls out of BOTH counts, the
      // identity breaks by exactly one, and the N2.3 free-capacity defect
      // returns for a rolling 24 h.
      assert.equal(usage.settlementLiveCount, 2);
      assert.equal(usage.driftLiveCount, 1);
      assert.equal(
        (usage.settlementLiveCount ?? 0) + (usage.driftLiveCount ?? 0),
        usage.recenterLiveCount,
      );
    });

    it(`${backend.name}: B1 — a NULL row is REFUSED against the settlement limit`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      const quota: LpExitQuota = { ...QUOTA, maxSettlementsPerDay: 1 };
      await seed(store, "legacy-0");
      const legacy = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "legacy-0",
        kind: "grid-recenter",
      });
      await store.reserveSequence(OWNER, AGENT_ID, legacy.sequenceId, quota);
      now += 6 * MINUTE;
      await seed(store, "settle-0");
      const settle = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "settle-0",
        kind: "grid-recenter",
        recenterEvidence: "settlement",
      });
      // The legacy row OCCUPIES the settlement slot. A build that dropped NULLs
      // from the count would admit this and hand the owner free capacity.
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT_ID, settle.sequenceId, quota),
        (error: unknown) => {
          assert.equal((error as { reason: string }).reason, "quota-exhausted");
          assert.equal((error as { lane: string }).lane, "settlement");
          return true;
        },
      );
    });

    it(`${backend.name}: 28(11) — a LEGACY quota keeps settling and never drifts`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      // A 3.19-shaped quota object: `maxMovesPerDay` only.
      const legacyQuota: LpExitQuota = {
        maxExitSequencesPerDay: 4,
        minMinutesBetweenExits: 5,
        maxMovesPerDay: 2,
      };
      await seed(store, "legacy-settle");
      const settle = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "legacy-settle",
        kind: "grid-recenter",
        recenterEvidence: "settlement",
      });
      await store.reserveSequence(OWNER, AGENT_ID, settle.sequenceId, legacyQuota);
      now += 6 * MINUTE;
      await seed(store, "legacy-drift");
      const drift = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "legacy-drift",
        kind: "grid-recenter",
        recenterEvidence: "drift",
      });
      // A legacy signature authorized NO discretionary motion, so the drift lane
      // is zero and stays zero until the owner re-signs. That is the migration
      // ruling's "strictly safer reading", enforced.
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT_ID, drift.sequenceId, legacyQuota),
        (error: unknown) => {
          assert.equal((error as { lane: string }).lane, "drift");
          return true;
        },
      );
    });
  }
});

/* -------------------------------------------------------------------------- */
/* item 27 / M5 — THE 280-CHARACTER ORDERING AUDIT, for the new builders      */
/* -------------------------------------------------------------------------- */

/**
 * Every sentence this phase adds passes `sanitizeMessage`, which TRUNCATES at
 * 280 characters. 3.13 F12-b is on record that the cap made a remedy-last
 * ordering UNREACHABLE at the saga seam, and 3.19 R1/R2 record it clipping
 * evidence tails. So the ORDER is pinned, not the prose: what an owner cannot
 * reconstruct from anywhere else leads, the remedy is inside the cap, and the
 * evidence tail is the part allowed to clip.
 */
describe("PHASE3.20 item 27: the new owner-facing sentences survive sanitizeMessage", () => {
  const survives = (text: string, pattern: RegExp): void => {
    assert.match(sanitizeMessage(text), pattern);
  };

  it("the FUNDING hold keeps side, shortfall, the hedge clause AND the three remedies", () => {
    for (const hedgeEnabled of [true, false]) {
      const text = lpGridLadderFundingHoldReason({
        role: "sell",
        shortfallWei: 123_456_789_012_345_678n,
        hedgeEnabled,
      });
      survives(text, /Ladder sell rung waiting on inventory/u);
      survives(text, /123456789012345678 wei short of one economic rung/u);
      survives(
        text,
        hedgeEnabled ? /hedge restores this side/u : /hedge\.enabled is false/u,
      );
      // C2 — the THREE actual remedies and the number that makes them urgent,
      // both inside the cap. This is the terminal state B1 names, so "wait" is
      // deliberately not on the list.
      survives(text, /Remedy: add the charged asset, lower deployPctBps, or exit/u);
      survives(text, /at the printed minimum ZERO fills settle/u);
    }
  });

  it("the QUOTA hold names the bound, its figures and its remedy — in that order", () => {
    const quota = lpGridLadderQuotaHoldReason({
      role: "buy",
      bound: "quota",
      lane: "settlement",
      used: 8,
      limit: 8,
      minMinutesBetweenExits: 5,
    });
    survives(quota, /the settlement lane is spent \(8\/8 in the rolling 24 h\)/u);
    survives(quota, /NO sequence, NO reservation, nothing rolled back/u);
    survives(quota, /Remedy: raise grid\.ladder\.settlementsPerDay/u);
    const drift = lpGridLadderQuotaHoldReason({
      role: "sell",
      bound: "quota",
      lane: "drift",
      used: 4,
      limit: 4,
      minMinutesBetweenExits: 5,
    });
    // Naming WHICH lane is the point: "the ladder is out of quota" while the
    // other lane is still open sends an owner to the wrong knob.
    survives(drift, /the drift lane is spent/u);
    survives(drift, /Remedy: raise grid\.ladder\.driftMovesPerDay/u);
  });

  it("the SPACING hold names the gate's agent-wide scope and its remedy", () => {
    const text = lpGridLadderQuotaHoldReason({
      role: "buy",
      bound: "spacing",
      lane: "settlement",
      used: 0,
      limit: 8,
      minMinutesBetweenExits: 5,
    });
    survives(text, /minMinutesBetweenExits 5 has not elapsed/u);
    survives(text, /AGENT-WIDE/u);
    survives(text, /Remedy: lower minMinutesBetweenExits, or wait one interval/u);
  });

  it("the STRANDING dispatch reason names the elapsed time and the bound", () => {
    const text = lpGridLadderStrandedReason({
      role: "sell",
      strandedMinutes: 61,
      boundMinutes: 45,
      range: { tickLower: 100, tickUpper: 200 },
      target: { tickLower: 300, tickUpper: 400 },
    });
    survives(text, /held the wrong asset for 61 minutes/u);
    survives(text, /past its 45-minute stranding bound/u);
    survives(text, /as a SETTLEMENT/u);
  });
});
