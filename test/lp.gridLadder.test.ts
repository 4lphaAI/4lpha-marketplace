/**
 * PHASE3.19 — the LADDER's PURE layer and its signed surface.
 *
 * OFFLINE and pure: parse, validate, view, hash, geometry, economics. No store,
 * no chain, no clock.
 *
 * ─── WHAT THIS FILE OWES (R2.5, items 41-44) ──────────────────────────────
 *
 *  - DUAL-ORIENTATION VECTORS at every new seam. The 3.13 F7 / 3.15 H1 / 3.17 H1
 *    inversion class has been shipped three times in this lineage, so every
 *    side-dependent behaviour here is written twice.
 *  - The named MUTATIONS' covering assertions:
 *      * `gridPolicyGapFor`-from-ladder (item 42) — the target must be derived
 *        at `ladder.gapTicks`, and a `2g + w` outer-rung gap must be visibly
 *        different;
 *      * `gridCycleSubmissions`-returns-2 (item 44);
 *      * the INVERTED MARKOUT, in BOTH directions (item 43);
 *      * the hedge firing with `enabled: false` (item 43);
 *      * a re-mint funded from the WRONG ASSET (item 42) — the C7 side rule as
 *        a PRIMARY control;
 *      * the C14 third clamp term dropped (R3.5).
 *  - C18's digest neutrality, pinned against the literal.
 *  - C9's 280-character ordering audit for every new owner-facing builder.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { paramsHash } from "../src/auth/canonical.js";
import {
  defaultLpSettingsParams,
  lpSettingsParamsView,
  parseLpSettingsParams,
} from "../src/http/lpWire.js";
import {
  DEFAULT_LP_SETTINGS,
  ladderMinMarkoutBps,
  validateLpSettings,
  type LpAutomationSettings,
  type LpGridLadder,
  type LpGridSettings,
} from "../src/lp/triggers.js";
import { DEFAULT_SETTINGS_DIGEST } from "../src/lp/worker.js";
import {
  gridCycleSubmissions,
  gridDeriveRanges,
  gridIdentitySourceFor,
  gridLadderEconomics,
  gridLadderFunding,
  gridLadderHedgePlan,
  gridLadderMarkout,
  gridLadderRemintSide,
  gridLadderRungSizeWei,
  gridLadderTarget,
  gridLadderValueBaseInQuote,
  gridPolicyGapFor,
  gridSideChargesQuote,
  gridTargetSide,
  lpGridLadderFundingHoldReason,
  lpGridLadderHedgeSkipNote,
  lpGridLadderRefusal,
  lpGridModeChangeRefusal,
  lpGridNetEdgeRefusal,
} from "../src/lp/gridTriggers.js";
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { readFileSync } from "node:fs";
import { LIQUIDITY_REMOVING_STEPS } from "../src/lp/abandonSequence.js";
import {
  GRID_SEQUENCE_KINDS,
  LP_SAGA_PLANS,
  lpDispatchKindFor,
} from "../src/lp/worker.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
/** Sorts BELOW WBNB ⇒ WBNB is token1 ⇒ Case A (`wbnbIsToken0 === false`). */
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
/** Sorts ABOVE WBNB ⇒ WBNB is token0 ⇒ Case B (`wbnbIsToken0 === true`). */
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");

const RELAY_FEE = 100_000_000_000_000n;

const LADDER: LpGridLadder = {
  gapTicks: 60,
  widthTicks: 60,
  deployPctBps: 3_000,
  driftPctOfGap: 60,
  maxMovesPerDay: 12,
  hedge: { enabled: true, minMarkoutBps: 75, maxHedgePctBps: 5_000 },
};

/**
 * PHASE3.20 — the same ladder in the NEW two-lane form. Built by DROPPING the
 * legacy key rather than setting it to `undefined`, because
 * `exactOptionalPropertyTypes` distinguishes the two and "exactly one form
 * accepted" is a rule about which keys are PRESENT.
 */
function newFormLadder(counts: {
  readonly settlementsPerDay: number;
  readonly driftMovesPerDay: number;
  readonly maxStrandedMinutes?: number;
}): LpGridLadder {
  const { maxMovesPerDay: _legacy, ...rest } = LADDER;
  return { ...rest, ...counts };
}

/**
 * A COHERENT ladder grid at a chosen anchor tick, in either orientation.
 *
 * The rungs come from the ONE derivation the validator's coherence rule re-runs,
 * so a fixture built this way is coherent BY CONSTRUCTION and a test that wants
 * incoherence has to break it deliberately.
 */
function ladderGrid(input: {
  readonly wbnbIsToken0: boolean;
  readonly anchorTick?: number;
  readonly ladder?: LpGridLadder;
}): LpGridSettings {
  const ladder = input.ladder ?? LADDER;
  const anchorTick = input.anchorTick ?? 0;
  const derived = gridDeriveRanges({
    currentTick: anchorTick,
    tickSpacing: 10,
    gapTicks: ladder.gapTicks,
    widthTicks: ladder.widthTicks,
    wbnbIsToken0: input.wbnbIsToken0,
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
  return {
    pool: input.wbnbIsToken0
      ? { token0: WBNB, token1: TOKEN_HI, fee: 2_500 }
      : { token0: TOKEN_LO, token1: WBNB, fee: 2_500 },
    wbnbIsToken0: input.wbnbIsToken0,
    tickSpacing: 10,
    buyRange: derived.buyRange,
    sellRange: derived.sellRange,
    maxFlipsPerDay: 1,
    minNetEdgeBps: 0,
    mode: "ladder",
    ladder,
  };
}

/**
 * The SAME rungs, as a FIXED grid — `mode` and `ladder` genuinely ABSENT.
 *
 * Spelled as an omission rather than `{...grid, mode: undefined}` because
 * `exactOptionalPropertyTypes` is on, and because an explicit `undefined` is
 * precisely what the present-only-when-set discipline forbids on the wire.
 */
function fixedTwin(grid: LpGridSettings, maxFlipsPerDay = 12): LpGridSettings {
  return {
    pool: grid.pool,
    wbnbIsToken0: grid.wbnbIsToken0,
    tickSpacing: grid.tickSpacing,
    buyRange: grid.buyRange,
    sellRange: grid.sellRange,
    maxFlipsPerDay,
    minNetEdgeBps: grid.minNetEdgeBps,
  };
}

function settingsWith(grid: LpGridSettings): LpAutomationSettings {
  return {
    ...DEFAULT_LP_SETTINGS,
    autoRotate: false,
    autoHarvest: false,
    minMinutesBetweenExits: 5,
    grid,
  };
}

/* -------------------------------------------------------------------------- */
/* The signed surface: parse, validate, view, digest                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19: the ladder block's signed surface", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB token0)" : "Case A (WBNB token1)";

    it(`${label}: a coherent ladder validates and round-trips through the wire`, () => {
      const settings = settingsWith(ladderGrid({ wbnbIsToken0 }));
      validateLpSettings(settings);
      const params = lpSettingsParamsView(settings);
      const parsed = parseLpSettingsParams(params);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.deepEqual(parsed.value.grid?.ladder, LADDER);
      assert.equal(parsed.value.grid?.mode, "ladder");
      validateLpSettings(parsed.value);
    });
  }

  it("C18: `grid.ladder` emits ONLY when set, so DEFAULT_SETTINGS_DIGEST does not move", () => {
    // The tripwire: if a `ladder` key were ever emitted at an absent value, the
    // default digest would move and every in-flight sequence of every agent with
    // no stored settings row would be refused at upgrade.
    assert.equal(
      paramsHash("lpSettings", defaultLpSettingsParams()),
      DEFAULT_SETTINGS_DIGEST,
    );
    assert.equal("ladder" in defaultLpSettingsParams(), false);
    const fixed = lpSettingsParamsView({
      ...DEFAULT_LP_SETTINGS,
      grid: fixedTwin(ladderGrid({ wbnbIsToken0: false })),
    });
    assert.equal("ladder" in ((fixed["grid"] ?? {}) as Record<string, unknown>), false);
  });

  it("item 10 (review B4): a non-zero stopLossPct or takeProfitPct is REFUSED", () => {
    for (const field of ["stopLossPct", "takeProfitPct"] as const) {
      assert.throws(
        () =>
          validateLpSettings({
            ...settingsWith(ladderGrid({ wbnbIsToken0: false })),
            [field]: 50,
          }),
        /refuses a non-zero stopLossPct\/takeProfitPct/u,
        `${field} must be refused under ladder mode`,
      );
    }
    // The PRICE triggers stay legal: they compare TICKS, not a basis.
    validateLpSettings({
      ...settingsWith(ladderGrid({ wbnbIsToken0: false })),
      priceStopLoss: {
        token0: TOKEN_LO,
        token1: WBNB,
        fee: 2_500,
        tick: -50_000,
        when: "at-or-below",
      },
    });
  });

  it("item 14: buyRange2/sellRange2 are REFUSED under ladder mode", () => {
    const grid = ladderGrid({ wbnbIsToken0: false });
    assert.throws(
      () =>
        validateLpSettings(
          settingsWith({
            ...grid,
            // A pair-2 that SATISFIES the shipped crossed-pair chain, so the
            // refusal that fires is item 14's own and not the chain's — the test
            // must pin the rule it is about.
            buyRange2: { tickLower: -300, tickUpper: -200 },
            sellRange2: { tickLower: 0, tickUpper: 50 },
          }),
        ),
      /refuses buyRange2\/sellRange2/u,
    );
  });

  it("item 22: maxFlipsPerDay must be 1 under ladder mode", () => {
    assert.throws(
      () =>
        validateLpSettings(
          settingsWith({ ...ladderGrid({ wbnbIsToken0: false }), maxFlipsPerDay: 12 }),
        ),
      /requires grid\.maxFlipsPerDay 1/u,
    );
  });

  it("grid.policy and grid.requote are REFUSED under ladder mode, and vice versa", () => {
    const grid = ladderGrid({ wbnbIsToken0: false });
    assert.throws(
      () =>
        validateLpSettings(
          settingsWith({ ...grid, policy: { gapTicks: 60, widthTicks: 60 } }),
        ),
      /grid\.policy is only meaningful under grid\.mode "policy"/u,
    );
    assert.throws(
      () =>
        validateLpSettings(
          settingsWith({
            ...grid,
            requote: { driftPctOfGap: 60, maxRequotesPerDay: 21 },
          }),
        ),
      /grid\.requote is only meaningful under grid\.mode "policy"/u,
    );
    // And the mirror: a ladder block under a FIXED grid is the (ae) shape.
    assert.throws(
      () =>
        validateLpSettings(
          settingsWith({ ...fixedTwin(grid), ladder: LADDER }),
        ),
      /grid\.ladder is only meaningful under grid\.mode "ladder"/u,
    );
  });

  it("R4.2's bounds: deployPctBps 1000..5000, maxMovesPerDay 1..24, drift 25..200", () => {
    const grid = ladderGrid({ wbnbIsToken0: false });
    for (const [field, bad] of [
      ["deployPctBps", 900],
      ["deployPctBps", 5_001],
      ["maxMovesPerDay", 0],
      ["maxMovesPerDay", 25],
      ["driftPctOfGap", 24],
      ["driftPctOfGap", 201],
    ] as const) {
      assert.throws(
        () =>
          validateLpSettings(
            settingsWith({
              ...grid,
              ladder: { ...LADDER, [field]: bad },
            }),
          ),
        new RegExp(`grid\\.ladder\\.${field}`, "u"),
        `${field}=${bad} must be refused`,
      );
    }
  });

  it("item 20: the three-way reachability rule counts the ladder lane", () => {
    // 1 flip + 24 moves = 25 against `floor(1440/60) = 24` reachable.
    assert.throws(
      () =>
        validateLpSettings({
          ...settingsWith({
            ...ladderGrid({ wbnbIsToken0: false }),
            ladder: { ...LADDER, maxMovesPerDay: 24 },
          }),
          minMinutesBetweenExits: 60,
        }),
      /is unreachable/u,
    );
    // At the ladder's own default spacing it fits.
    validateLpSettings({
      ...settingsWith({
        ...ladderGrid({ wbnbIsToken0: false }),
        ladder: { ...LADDER, maxMovesPerDay: 24 },
      }),
      minMinutesBetweenExits: 5,
    });
  });

  it("item 15: the coherence rule runs against grid.ladder's own geometry", () => {
    const grid = ladderGrid({ wbnbIsToken0: false });
    assert.throws(
      () =>
        validateLpSettings(
          settingsWith({
            ...grid,
            // A rung that no derivation of THIS ladder produces at any tick.
            sellRange: { tickLower: grid.sellRange.tickLower + 10, tickUpper: grid.sellRange.tickUpper + 10 },
          }),
        ),
      /is not what grid\.policy .* derives/u,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Item 34 — the identity source, exhaustive                                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 34: gridIdentitySourceFor is a DECISION, not a fall-through", () => {
  it("fixed reads TICKS; policy and ladder read the durable COLUMNS", () => {
    assert.equal(gridIdentitySourceFor("fixed"), "ticks");
    assert.equal(gridIdentitySourceFor("policy"), "columns");
    // A LADDER rung floats from its first motion, so an exact-tick match would
    // answer `null` for ever — the C1 defect 3.18 found for the requote, in a
    // mode that moves far more often.
    assert.equal(gridIdentitySourceFor("ladder"), "columns");
  });
});

/* -------------------------------------------------------------------------- */
/* Items 32/33/36 — registration, and the three things that need NO edit       */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 items 32/33/36: where `grid-recenter` is registered", () => {
  it("item 32: it dispatches, it has a plan, and the GRID flag governs it", () => {
    assert.equal(lpDispatchKindFor("grid-recenter"), "grid-recenter");
    // Flip-SHAPED: the same three step kinds, which is what lets the 3.11 crash
    // matrix, the `pending-mint` hold semantics and the abandon disposition
    // carry over with no new machinery.
    assert.deepEqual(LP_SAGA_PLANS["grid-recenter"], [
      "zap-out",
      "sweep-token",
      "zap-in-mint",
    ]);
    // Without this, a held `grid-recenter` on a deployment that turned
    // `GRID_ENABLED` off would be RESUMED rather than skipped — the exact defect
    // the set's own docstring records being fixed for `grid-arm`.
    assert.equal(GRID_SEQUENCE_KINDS.has("grid-recenter"), true);
  });

  it("item 32: `LIQUIDITY_REMOVING_STEPS` needs NO change — it keys on the STEP kind", () => {
    // The ladder's plan shares `"zap-out"`, so the abandon verifier reads it
    // correctly with no map entry. Stated as a test so a builder does not "fix"
    // a set that is already right.
    assert.equal(LIQUIDITY_REMOVING_STEPS.has("zap-out"), true);
    assert.equal(LIQUIDITY_REMOVING_STEPS.has("zap-in-mint"), false);
    assert.equal(LIQUIDITY_REMOVING_STEPS.has("sweep-token"), false);
  });

  it("item 33: it is NOT resolvable — an UNKNOWN mid-motion has no in-plane resolver", () => {
    const source = readFileSync(
      new URL("../src/lp/resolveUnknown.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /RESOLVABLE_SEQUENCE_KINDS[\s\S]{0,120}?new Set<LpSequenceKind>\(\["harvest", "protect", "manual-exit"\]\)/u,
      "grid-recenter must NOT join this set: retrying risks a second mint",
    );
  });

  it("item 36: the landing-evidence boot gate is FLAG-LEVEL and needs no per-kind edit", () => {
    const source = readFileSync(
      new URL("../src/lp/wiring.ts", import.meta.url),
      "utf8",
    );
    // 3.18 L1 already made the sentence GENERIC ("every grid sequence kind"),
    // precisely so a fourth — and now a fifth — kind needs no edit here.
    assert.match(source, /if \(gridEnabled && evidenceConfig\.enabled\) \{/u);
    assert.match(source, /every grid sequence kind is deliberately unmapped/u);
    assert.doesNotMatch(source, /'grid-recenter'/u);
  });
});

/* -------------------------------------------------------------------------- */
/* Items 11-12 — the target, in POOL ORDER, at the LADDER's own gap           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 items 11-12: the re-anchored target", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB token0)" : "Case A (WBNB token1)";

    for (const role of ["buy", "sell"] as const) {
      it(`${label}, ${role}: the target's SIDE charges the asset the role holds`, () => {
        const grid = ladderGrid({ wbnbIsToken0 });
        const freshTick = 12_345;
        const target = gridLadderTarget({ grid, ladder: LADDER, role, currentTick: freshTick });
        const side = gridTargetSide(freshTick, target);
        assert.notEqual(side, undefined, "the target must be strictly outside the tick");
        // THE RULE, in pool order and with no orientation branch: the side the
        // target presents charges the quote exactly when the role is `buy`.
        assert.equal(
          gridSideChargesQuote(side!, wbnbIsToken0),
          role === "buy",
          "the derived target charges the wrong leg for this role",
        );
      });
    }

    it(`${label}: the CHASE anchors at the FRESH tick, not at the signed rung`, () => {
      const grid = ladderGrid({ wbnbIsToken0, anchorTick: 0 });
      const moved = gridLadderTarget({
        grid,
        ladder: LADDER,
        role: "buy",
        currentTick: 5_000,
      });
      assert.notDeepEqual(
        moved,
        grid.buyRange,
        "a chase must re-anchor; a target equal to the signed rung is the (ax) failure",
      );
    });
  }

  it("item 42's mutation: the gap is `ladder.gapTicks`, NEVER gridPolicyGapFor's", () => {
    // `gridPolicyGapFor` answers `2g + w` for an OUTER rung of a crossed pair.
    // A ladder has ONE rung per side and no outer rung, and — decisively (C17) —
    // `grid.policy` does not exist under ladder mode at all. The two answers are
    // visibly different for a DUAL grid, which is what makes the mutation die.
    const dual: LpGridSettings = {
      ...ladderGrid({ wbnbIsToken0: false }),
      buyRange2: { tickLower: -9_000, tickUpper: -8_900 },
      sellRange2: { tickLower: 8_900, tickUpper: 9_000 },
    };
    assert.equal(
      gridPolicyGapFor(dual, { gapTicks: LADDER.gapTicks, widthTicks: LADDER.widthTicks }, 1, "sell"),
      2 * LADDER.gapTicks + LADDER.widthTicks,
    );
    // The ladder's own derivation uses the plain gap, so a target derived at the
    // outer gap lands somewhere else entirely.
    const atLadderGap = gridLadderTarget({
      grid: ladderGrid({ wbnbIsToken0: false }),
      ladder: LADDER,
      role: "sell",
      currentTick: 0,
    });
    const atOuterGap = gridDeriveRanges({
      currentTick: 0,
      tickSpacing: 10,
      gapTicks: 2 * LADDER.gapTicks + LADDER.widthTicks,
      widthTicks: LADDER.widthTicks,
      wbnbIsToken0: false,
      minTick: MIN_TICK,
      maxTick: MAX_TICK,
    }).sellRange;
    assert.notDeepEqual(atLadderGap, atOuterGap);
  });
});

/* -------------------------------------------------------------------------- */
/* C7 — the re-mint side rule, as a PRIMARY control                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 C7: the re-mint side rule, three outcomes, both orientations", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B (WBNB token0)" : "Case A (WBNB token1)";

    it(`${label}: the persisted target at the SAME tick proceeds`, () => {
      const grid = ladderGrid({ wbnbIsToken0 });
      const target = gridLadderTarget({ grid, ladder: LADDER, role: "buy", currentTick: 0 });
      const verdict = gridLadderRemintSide({
        currentTick: 0,
        target,
        role: "buy",
        wbnbIsToken0,
      });
      assert.equal(verdict.ok, true);
    });

    it(`${label}: the price INSIDE the persisted target is a recoverable hold`, () => {
      const grid = ladderGrid({ wbnbIsToken0 });
      const target = gridLadderTarget({ grid, ladder: LADDER, role: "buy", currentTick: 0 });
      const inside = Math.floor((target.tickLower + target.tickUpper) / 2);
      const verdict = gridLadderRemintSide({
        currentTick: inside,
        target,
        role: "buy",
        wbnbIsToken0,
      });
      assert.equal(verdict.ok, false);
      if (verdict.ok) return;
      assert.equal(verdict.failed, "no-side");
    });

    it(`${label}: item 42 — the price THROUGH the target is a WRONG-ASSET refusal`, () => {
      // THE MUTATION THIS KILLS: a build that mints on whichever side exists
      // would fund a BUY rung with BASE, and — unlike the flip — a buffer-funded
      // wallet HOLDS both legs, so the mint would SUCCEED. The side rule is the
      // primary control, not a belt.
      const grid = ladderGrid({ wbnbIsToken0 });
      const target = gridLadderTarget({ grid, ladder: LADDER, role: "buy", currentTick: 0 });
      const through = wbnbIsToken0 ? target.tickUpper + 1_000 : target.tickLower - 1_000;
      const verdict = gridLadderRemintSide({
        currentTick: through,
        target,
        role: "buy",
        wbnbIsToken0,
      });
      assert.equal(verdict.ok, false);
      if (verdict.ok) return;
      assert.equal(verdict.failed, "side-role-mismatch");
      // The side EXISTS — that is exactly why a side check alone is not enough.
      assert.notEqual(verdict.side, undefined);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Item 44 — gridCycleSubmissions, exhaustive                                 */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 44: gridCycleSubmissions never answers the flip floor for a ladder", () => {
  it("fixed answers 2 and policy answers 2 + 2R — byte-identical to 3.18", () => {
    const fixed: LpGridSettings = fixedTwin(ladderGrid({ wbnbIsToken0: false }));
    assert.equal(gridCycleSubmissions(fixed), 2);
    assert.equal(
      gridCycleSubmissions({
        ...fixed,
        mode: "policy",
        policy: { gapTicks: 60, widthTicks: 60 },
        requote: { driftPctOfGap: 60, maxRequotesPerDay: 21 },
      }),
      2 + 2 * 21,
    );
  });

  // ─── PHASE3.20 C8 — THE FIRST OF TWO DECLARED INVERSIONS ─────────────────
  //
  // This assertion said 42 and `2 * 14`, on 3.19's `motions = 2 + moves`. Under
  // PHASE3.20 item 21 the ladder's ONE lane is TWO lanes and the bound becomes
  // EXACT: `motions = max(2, settlementsPerDay) + driftMovesPerDay`. The fixture
  // is LEGACY-signed (`maxMovesPerDay: 12`), which
  // `ladderMotionCounts` reads as `{settlements: 12, drift: 0}`, so
  // `motions = 12` and the answers become 36 and `2 * 12`.
  //
  // The 14.3% drop is the DECLARED consequence C8 names, in the direction that
  // LOOSENS the B1 funding gate for every legacy-signed ladder at upgrade.
  it("ladder answers 2*motions + hedge?(motions), motions = max(2,settlements)+drift", () => {
    const grid = ladderGrid({ wbnbIsToken0: false });
    // Legacy fixture: motions = max(2, 12) + 0 = 12 ⇒ 2*12 + 12 = 36.
    assert.equal(gridCycleSubmissions(grid), 36);
    assert.notEqual(gridCycleSubmissions(grid), 2);
    // Hedge OFF drops one motion's worth of submissions per motion.
    assert.equal(
      gridCycleSubmissions({
        ...grid,
        ladder: { ...LADDER, hedge: { ...LADDER.hedge, enabled: false } },
      }),
      2 * 12,
    );
    // The NEW form, both lanes live: motions = max(2, 8) + 4 = 12, the same 36
    // at the D1 defaults — which is why the gas reserve does not move for an
    // owner who accepts them.
    assert.equal(
      gridCycleSubmissions(
        ladderGrid({
          wbnbIsToken0: false,
          ladder: newFormLadder({ settlementsPerDay: 8, driftMovesPerDay: 4 }),
        }),
      ),
      36,
    );
    // The `max(2, …)` floor is load-bearing: a ladder signed at ONE settlement
    // a day must still be priced for a round trip's TWO fill motions.
    assert.equal(
      gridCycleSubmissions(
        ladderGrid({
          wbnbIsToken0: false,
          ladder: newFormLadder({ settlementsPerDay: 1, driftMovesPerDay: 0 }),
        }),
      ),
      2 * 2 + 2,
    );
  });

  // ─── PHASE3.20 C8 — THE SECOND DECLARED INVERSION ────────────────────────
  //
  // This test asserted the C10 PAD (`> exact`, and `- exact === 6`). The pad was
  // an artefact of D7's SHARED lane, in which the two fill motions were already
  // members of `moves` so `2 +` over-counted by four submissions. Under two
  // lanes the fill motions are bounded by their OWN lane and the formula is
  // exact, so the pad is RETIRED and this assertion is inverted rather than
  // quietly re-baselined (the 3.14 A9 precedent).
  it("C8: the C10 pad is RETIRED — the two-lane bound is EXACT, not padded", () => {
    const grid = ladderGrid({ wbnbIsToken0: false });
    const moves = LADDER.maxMovesPerDay ?? 0;
    const exact = 2 * moves + moves;
    assert.equal(gridCycleSubmissions(grid), exact);
    assert.equal(gridCycleSubmissions(grid) - exact, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Item 25/28 — the ONE economics builder                                     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 items 25/28: gridLadderEconomics", () => {
  it("prices the DEPLOYED rung, not the budget, and inverts to a minimum BUDGET", () => {
    const grid = ladderGrid({ wbnbIsToken0: false, ladder: { ...LADDER, hedge: { ...LADDER.hedge, enabled: false } } });
    const budgetWei = 10n ** 19n;
    const economics = gridLadderEconomics({
      grid,
      ladder: grid.ladder as LpGridLadder,
      budgetWei,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    // The rung is `budget/2 * deployPct/10000` — 15% of the budget at 3000 bps.
    assert.equal(economics.rungSizeWei, gridLadderRungSizeWei(budgetWei, 3_000));
    assert.equal(economics.rungSizeWei, (budgetWei * 15n) / 100n);
    assert.equal(economics.edge.sizeWei, economics.rungSizeWei);
    assert.equal(economics.submissionsPerCycle, gridCycleSubmissions(grid));
    // L2: the minimum BUDGET is the minimum RUNG inverted through deployPctBps,
    // and is therefore ~6.7x larger at the default 30%.
    assert.notEqual(economics.minRungWei, null);
    assert.notEqual(economics.minBudgetWei, null);
    assert.ok((economics.minBudgetWei as bigint) > (economics.minRungWei as bigint) * 6n);
  });

  it("item 27: the refusal names RE-ANCHORING as a third uncovered term", () => {
    const grid = ladderGrid({ wbnbIsToken0: false });
    const economics = gridLadderEconomics({
      grid: { ...grid, minNetEdgeBps: 9_000 },
      ladder: LADDER,
      budgetWei: 10n ** 15n,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    assert.equal(economics.edge.ok, false);
    const text = lpGridNetEdgeRefusal(economics.edge, "Grid arm refused");
    assert.match(text, /re-anchoring is a third uncovered term/u);
    assert.match(text, /QUOTED spread/u);
  });

  it("a fixed grid's refusal is UNCHANGED — no ladder clause leaks into it", () => {
    const fixed: LpGridSettings = { ...fixedTwin(ladderGrid({ wbnbIsToken0: false })), minNetEdgeBps: 9_000 };
    const economics = gridLadderEconomics({
      grid: fixed,
      ladder: LADDER,
      budgetWei: 10n ** 15n,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    // The builder always marks its own verdict; a NON-ladder verdict (built by
    // `gridNetEdge` directly, as every 3.15-3.18 call site does) must not.
    assert.equal(economics.edge.ladder, true);
    const { ladder: _ladderFlag, ...withoutLadderFlag } = economics.edge;
    assert.doesNotMatch(lpGridNetEdgeRefusal(withoutLadderFlag, "x"), /re-anchoring/u);
  });
});

/* -------------------------------------------------------------------------- */
/* C8 — the ONE valuation expression                                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 C8: one valuation expression, both orientations", () => {
  for (const wbnbIsToken0 of [false, true]) {
    it(`${wbnbIsToken0 ? "Case B" : "Case A"}: base valued in WBNB is monotone in the price`, () => {
      const baseWei = 10n ** 18n;
      const low = gridLadderValueBaseInQuote({
        baseWei,
        sqrtPriceX96: getSqrtRatioAtTick(wbnbIsToken0 ? 1_000 : -1_000),
        wbnbIsToken0,
      });
      const high = gridLadderValueBaseInQuote({
        baseWei,
        sqrtPriceX96: getSqrtRatioAtTick(wbnbIsToken0 ? -1_000 : 1_000),
        wbnbIsToken0,
      });
      // Base gets DEARER in WBNB terms as the tick moves the way that raises
      // WBNB-per-base, and the direction is orientation-dependent — which is
      // exactly why there is ONE expression rather than four call sites.
      assert.ok(high > low);
      assert.equal(gridLadderValueBaseInQuote({ baseWei: 0n, sqrtPriceX96: getSqrtRatioAtTick(0), wbnbIsToken0 }), 0n);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Item 43 — the markout gate                                                 */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 43 / D1: the markout gate", () => {
  const baseWei = 10n ** 18n;
  const atTick = (tick: number): bigint => getSqrtRatioAtTick(tick);

  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B" : "Case A";
    // The tick at which base is DEARER than it was at 0, per orientation.
    const dearer = wbnbIsToken0 ? -2_000 : 2_000;
    const cheaper = wbnbIsToken0 ? 2_000 : -2_000;
    const bookCost = gridLadderValueBaseInQuote({
      baseWei,
      sqrtPriceX96: atTick(0),
      wbnbIsToken0,
    });

    it(`${label}: SELLING BASE clears only when the market is ABOVE the book average`, () => {
      const good = gridLadderMarkout({
        direction: "token-to-wbnb",
        bookBaseWei: baseWei,
        bookCostWbnbWei: bookCost,
        spotSqrtPriceX96: atTick(dearer),
        wbnbIsToken0,
        minMarkoutBps: 75,
      });
      assert.equal(good.ok, true);
      assert.ok(good.markoutBps > 75n);
      // THE INVERSION MUTATION, direction 1: swapping the two operands turns a
      // profitable unwind into a refusal and a loss-making one into a fire.
      const bad = gridLadderMarkout({
        direction: "token-to-wbnb",
        bookBaseWei: baseWei,
        bookCostWbnbWei: bookCost,
        spotSqrtPriceX96: atTick(cheaper),
        wbnbIsToken0,
        minMarkoutBps: 75,
      });
      assert.equal(bad.ok, false);
      assert.ok(bad.markoutBps < 0n);
    });

    it(`${label}: BUYING BASE BACK clears only when the market is BELOW the book average`, () => {
      const good = gridLadderMarkout({
        direction: "wbnb-to-token",
        bookBaseWei: baseWei,
        bookCostWbnbWei: bookCost,
        spotSqrtPriceX96: atTick(cheaper),
        wbnbIsToken0,
        minMarkoutBps: 75,
      });
      assert.equal(good.ok, true);
      // THE INVERSION MUTATION, direction 2.
      const bad = gridLadderMarkout({
        direction: "wbnb-to-token",
        bookBaseWei: baseWei,
        bookCostWbnbWei: bookCost,
        spotSqrtPriceX96: atTick(dearer),
        wbnbIsToken0,
        minMarkoutBps: 75,
      });
      assert.equal(bad.ok, false);
    });
  }

  it("D1: a ZERO book REFUSES rather than dividing", () => {
    for (const book of [
      { bookBaseWei: 0n, bookCostWbnbWei: 10n ** 18n },
      { bookBaseWei: 10n ** 18n, bookCostWbnbWei: 0n },
      { bookBaseWei: 0n, bookCostWbnbWei: 0n },
    ]) {
      const verdict = gridLadderMarkout({
        direction: "token-to-wbnb",
        ...book,
        spotSqrtPriceX96: atTick(0),
        wbnbIsToken0: false,
        minMarkoutBps: 0,
      });
      assert.equal(verdict.defined, false);
      assert.equal(verdict.ok, false, "an undefined average must never clear the gate");
    }
  });

  it("item 26: the effective floor is poolFeeBps + maxSagaSlippageBps, and the signed value may only RAISE it", () => {
    assert.equal(
      ladderMinMarkoutBps({ poolFee: 2_500, maxSagaSlippageBps: 50, signedMinMarkoutBps: 5 }),
      75,
    );
    assert.equal(
      ladderMinMarkoutBps({ poolFee: 2_500, maxSagaSlippageBps: 50, signedMinMarkoutBps: 300 }),
      300,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* H2 rule 2 / C14 — the hedge plan                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 H2/C14: the hedge's direction and its three-term clamp", () => {
  const rungSizeWei = 10n ** 17n;

  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "Case B" : "Case A";

    it(`${label}: over-held BASE sells BASE; over-held QUOTE buys BASE`, () => {
      const spot = getSqrtRatioAtTick(0);
      const baseHeavy = gridLadderHedgePlan({
        bufferQuoteWei: 10n ** 17n,
        bufferBaseWei: 10n ** 19n,
        spotSqrtPriceX96: spot,
        wbnbIsToken0,
        maxHedgePctBps: 10_000,
        rungSizeWei,
        chargedIsQuote: true,
        plannedMintWei: 0n,
      });
      assert.equal(baseHeavy?.direction, "token-to-wbnb");
      const quoteHeavy = gridLadderHedgePlan({
        bufferQuoteWei: 10n ** 19n,
        bufferBaseWei: 10n ** 15n,
        spotSqrtPriceX96: spot,
        wbnbIsToken0,
        maxHedgePctBps: 10_000,
        rungSizeWei,
        chargedIsQuote: false,
        plannedMintWei: 0n,
      });
      assert.equal(quoteHeavy?.direction, "wbnb-to-token");
    });
  }

  it("a BALANCED buffer plans no hedge at all", () => {
    const spot = getSqrtRatioAtTick(0);
    const baseWei = 10n ** 18n;
    const quoteWei = gridLadderValueBaseInQuote({
      baseWei,
      sqrtPriceX96: spot,
      wbnbIsToken0: false,
    });
    assert.equal(
      gridLadderHedgePlan({
        bufferQuoteWei: quoteWei,
        bufferBaseWei: baseWei,
        spotSqrtPriceX96: spot,
        wbnbIsToken0: false,
        maxHedgePctBps: 10_000,
        rungSizeWei,
        chargedIsQuote: true,
        plannedMintWei: 0n,
      }),
      null,
    );
  });

  it("term 2: maxHedgePctBps caps ONE hedge below the imbalance", () => {
    const plan = gridLadderHedgePlan({
      bufferQuoteWei: 10n ** 15n,
      bufferBaseWei: 10n ** 19n,
      spotSqrtPriceX96: getSqrtRatioAtTick(0),
      wbnbIsToken0: false,
      maxHedgePctBps: 1_000,
      rungSizeWei,
      chargedIsQuote: true,
      plannedMintWei: 0n,
    });
    assert.notEqual(plan, null);
    assert.ok((plan as { amountInWei: bigint }).amountInWei < (plan as { imbalanceWei: bigint }).imbalanceWei);
  });

  it("C14 term 3 (R3.5's mutation): the hedge NEVER takes the asset the following mint needs", () => {
    // Over-held QUOTE and the motion's mint ALSO charges quote: the third clamp
    // term is the only thing standing between the hedge and an unfundable mint,
    // which is the ladder's single HELD state.
    const available = 10n ** 19n;
    const plannedMintWei = available - 10n ** 16n;
    const plan = gridLadderHedgePlan({
      bufferQuoteWei: available,
      bufferBaseWei: 1n,
      spotSqrtPriceX96: getSqrtRatioAtTick(0),
      wbnbIsToken0: false,
      maxHedgePctBps: 10_000,
      rungSizeWei: available,
      chargedIsQuote: true,
      plannedMintWei,
    });
    assert.notEqual(plan, null);
    assert.ok(
      (plan as { amountInWei: bigint }).amountInWei <= available - plannedMintWei,
      "the hedge took more than the buffer holds over the mint it still owes",
    );
    // Drop the term entirely (the mutation) and the unclamped imbalance would be
    // far larger — so the assertion above is not vacuous.
    const unclamped = gridLadderHedgePlan({
      bufferQuoteWei: available,
      bufferBaseWei: 1n,
      spotSqrtPriceX96: getSqrtRatioAtTick(0),
      wbnbIsToken0: false,
      maxHedgePctBps: 10_000,
      rungSizeWei: available,
      chargedIsQuote: true,
      plannedMintWei: 0n,
    });
    assert.ok(
      (unclamped as { amountInWei: bigint }).amountInWei
        > (plan as { amountInWei: bigint }).amountInWei,
    );
  });

  it("the clamp reaching zero plans NO hedge rather than a dust swap", () => {
    const available = 10n ** 18n;
    assert.equal(
      gridLadderHedgePlan({
        bufferQuoteWei: available,
        bufferBaseWei: 1n,
        spotSqrtPriceX96: getSqrtRatioAtTick(0),
        wbnbIsToken0: false,
        maxHedgePctBps: 10_000,
        rungSizeWei: available,
        chargedIsQuote: true,
        plannedMintWei: available,
      }),
      null,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Item 17 — the funding conjunct                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 item 17: the funding conjunct", () => {
  const minRungWei = 10n ** 17n;

  it("an UNFILLED rung counts its own principal; a FILLED one does not", () => {
    const shared = {
      role: "buy" as const,
      wbnbIsToken0: false,
      bufferQuoteWei: 0n,
      bufferBaseWei: 0n,
      spotSqrtPriceX96: getSqrtRatioAtTick(0),
      rungExitValueWei: 10n ** 19n,
      deployPctBps: 3_000,
      minRungWei,
    };
    // A DRIFT: the rung still holds the asset its role charges, so its whole
    // principal is about to be freed into the buffer on that side.
    assert.equal(gridLadderFunding({ ...shared, rungIsUnfilled: true }).ok, true);
    // A FILL: the rung holds the OTHER asset and contributes nothing — which is
    // exactly the state the hedge, not this motion, must resolve.
    assert.equal(gridLadderFunding({ ...shared, rungIsUnfilled: false }).ok, false);
  });

  it("ABSENT balances FAIL CLOSED — a conjunct is not satisfied by a number nobody read", () => {
    const verdict = gridLadderFunding({
      role: "buy",
      wbnbIsToken0: false,
      bufferQuoteWei: undefined,
      bufferBaseWei: undefined,
      spotSqrtPriceX96: getSqrtRatioAtTick(0),
      rungExitValueWei: 10n ** 19n,
      rungIsUnfilled: true,
      deployPctBps: 3_000,
      minRungWei,
    });
    assert.equal(verdict.ok, false);
  });

  it("an ABSENT minRungWei (no relay constant supplied) also fails closed", () => {
    assert.equal(
      gridLadderFunding({
        role: "buy",
        wbnbIsToken0: false,
        bufferQuoteWei: 10n ** 20n,
        bufferBaseWei: 10n ** 20n,
        spotSqrtPriceX96: getSqrtRatioAtTick(0),
        rungExitValueWei: 0n,
        rungIsUnfilled: false,
        deployPctBps: 3_000,
        minRungWei: null,
      }).ok,
      false,
    );
  });

  it("a SELL rung's funding is measured on the BASE buffer, valued in WBNB (C8)", () => {
    const spot = getSqrtRatioAtTick(0);
    const baseWei = 10n ** 19n;
    const verdict = gridLadderFunding({
      role: "sell",
      wbnbIsToken0: false,
      bufferQuoteWei: 0n,
      bufferBaseWei: baseWei,
      spotSqrtPriceX96: spot,
      rungExitValueWei: 0n,
      rungIsUnfilled: false,
      deployPctBps: 3_000,
      minRungWei,
    });
    assert.equal(
      verdict.availableQuoteValueWei,
      gridLadderValueBaseInQuote({ baseWei, sqrtPriceX96: spot, wbnbIsToken0: false }),
    );
    assert.equal(verdict.chargedIsQuote, false);
  });
});

/* -------------------------------------------------------------------------- */
/* C9 — the 280-character ordering audit                                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 C9: every new owner-facing sentence survives sanitizeMessage", () => {
  /** The fact an owner cannot reconstruct must survive the 280-char truncation. */
  const survives = (text: string, lead: RegExp): void => {
    const clipped = sanitizeMessage(text);
    assert.match(clipped, lead);
  };

  it("the funding hold leads with side + shortfall and keeps its one-clause remedy", () => {
    for (const hedgeEnabled of [true, false]) {
      const text = lpGridLadderFundingHoldReason({
        role: "sell",
        shortfallWei: 123_456_789_012_345_678n,
        hedgeEnabled,
      });
      survives(text, /Ladder sell rung waiting on inventory/u);
      survives(text, /123456789012345678 wei short/u);
      // C12's residual is NAMED in the text when the hedge is off.
      survives(
        text,
        hedgeEnabled ? /hedge restores this side/u : /hedge\.enabled is false/u,
      );
    }
  });

  it("the saga refusal names the disposition, terminal vs recoverable", () => {
    const zapOut = lpGridLadderRefusal({
      where: "zap-out",
      failed: "burned",
      role: "buy",
      currentTick: 12_345,
      target: { tickLower: 100, tickUpper: 200 },
    });
    survives(zapOut, /NOTHING was spent/u);
    const mint = lpGridLadderRefusal({
      where: "mint",
      failed: "side-role-mismatch",
      role: "buy",
      currentTick: 12_345,
      target: { tickLower: 100, tickUpper: 200 },
    });
    survives(mint, /Principal SAFE in the wallet/u);
  });

  it("the hedge skip note names WHY, in each branch", () => {
    for (const [why, pattern] of [
      ["disabled", /hedge\.enabled is false/u],
      ["balanced", /already two-sided/u],
      ["markout", /under the 75 bps minimum/u],
      ["no-book", /no acquired base/u],
      ["dust", /clamped hedge size is zero/u],
    ] as const) {
      survives(
        lpGridLadderHedgeSkipNote({ why, markoutBps: 12n, minMarkoutBps: 75 }),
        pattern,
      );
    }
  });

  it("the mode-change refusal leads with the live count and both modes", () => {
    const text = lpGridModeChangeRefusal({
      liveLevels: 2,
      storedMode: "ladder",
      newMode: "policy",
    });
    survives(text, /holds 2 live grid level\(s\) signed under mode "ladder"/u);
    survives(text, /Changing the mode to "policy"/u);
  });
});
