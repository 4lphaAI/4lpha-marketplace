/**
 * PHASE3.22 — the ATOMIC LADDER (`grid.mode: "shift"`), offline.
 *
 * ─── WHAT THIS FILE OWES, condition by condition ──────────────────────────
 *
 * REVIEW4 §E names one test per condition and R2.27 (a)-(f) names six more.
 * They are grouped below under the condition each discharges, so an auditor
 * reading a condition can find its test without reading the whole file:
 *
 *  - D1  the declared-ambiguity abandon arm's PLACEMENT, and the kind-guard
 *        MUTATION: flip it and a `rotate` with an UNKNOWN `zap-out` must NOT
 *        become abandonable;
 *  - D2  the `shift-ambiguous` member at all six sites, including a Postgres
 *        BOOT-AND-WRITE — the site whose omission makes the mode dead on the
 *        only supported backend while every memory test stays green;
 *  - D3  the pre-submit marker's ORDERING, and the declared-harmless stale
 *        marker on a terminal rollback;
 *  - D4  a permanently-throwing `after` reaching TIER 2, and the placement
 *        property that makes it reachable at all;
 *  - D5  the dynamic dispatcher: a pair whose buy row closed mid-cycle
 *        dispatches from the sell row next cycle, and NEVER from both;
 *  - D7  `restore-open` against a DEPLETED pair leaves the closed row closed;
 *  - D8  a one-sided pair's stale dormant observation contributes NO cross
 *        evidence;
 *  - D9  the cadence field, its bounds and the reachability conjunct;
 *  - R2.27 (a) per-call preflight over the batch's three targets, (b) a
 *        reverted batch consumes exactly one shift-lane slot, (c)/(d) the
 *        group lock, (e) the marker survives both resume paths, (f) the
 *        one-sided finish closes the dormant row and a later funded motion
 *        re-creates it with lineage carried.
 *
 * Plus R2's BYTE-IDENTITY pin: the three shipped mode suites pass UNEDITED,
 * which is asserted here only for the seams this phase touched — the suites
 * themselves are the real pin and they are not edited.
 *
 * Offline: the memory store, the fake SQL client and pure functions. Nothing
 * in this file touches a chain, so it supplies no live evidence. FINDINGS (bd)
 * proves one DRIFT-caused atomic shift on BNB mainnet at block 118951160;
 * fill/cross settlement and grid flip remain unproven live.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { FakeSqlClient } from "./support/fakeSql.js";
import { paramsHash } from "../src/auth/canonical.js";
import {
  defaultLpSettingsParams,
  lpSettingsParamsView,
  parseLpSettingsParams,
} from "../src/http/lpWire.js";
import {
  DEFAULT_GRID_SHIFT_DEPLOY_PCT_BPS,
  DEFAULT_GRID_SHIFT_DRIFT_PCT,
  DEFAULT_GRID_SHIFT_SHIFTS_PER_DAY,
  DEFAULT_LP_SETTINGS,
  MAX_GRID_SHIFT_SHIFTS_PER_DAY,
  MAX_GRID_SHIFT_DRIFT_GAS_BUDGET_WEI,
  validateLpSettings,
  type LpAutomationSettings,
  type LpGridSettings,
  type LpGridShift,
} from "../src/lp/triggers.js";
import { DEFAULT_SETTINGS_DIGEST } from "../src/lp/worker.js";
import {
  gridCycleSubmissions,
  gridDeriveRanges,
  gridIdentitySourceFor,
  gridShiftEconomics,
  gridShiftDriftMotionsPerDay,
  gridShiftFunding,
  gridShiftGroupLock,
  gridShiftSideFloors,
  evaluateGridTriggers,
  lpGridImportModeRefusal,
  lpGridShiftFundingHoldReason,
  gridShiftGasGate,
  lpGridShiftGasHoldReason,
  lpGridShiftQuotaHoldReason,
  lpGridShiftRefusal,
} from "../src/lp/gridTriggers.js";
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { LIQUIDITY_REMOVING_STEPS } from "../src/lp/abandonSequence.js";
import { verifyLpAbandonSequence } from "../src/lp/abandonSequence.js";
import {
  LP_SAGA_PLANS,
  LP_STALL_LATCH_ATTEMPTS,
  lpDispatchKindFor,
} from "../src/lp/worker.js";
import {
  MAX_SUBMISSIONS_PER_GRID_SHIFT,
  MAX_SUBMISSIONS_PER_GRID_SHIFT_CYCLE,
  checkLpNativeCapSizing,
} from "../src/ops/policy.js";
import {
  LpExitQuotaError,
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  createPositionForArmGroup,
  type LpExitQuota,
  type LpSequenceRecord,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import type { JournalEntry } from "../src/store/journal.js";
import { lpShiftPairGeometry } from "../src/server.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
/** Sorts BELOW WBNB ⇒ WBNB is token1 ⇒ `wbnbIsToken0 === false`. */
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
/** Sorts ABOVE WBNB ⇒ WBNB is token0 ⇒ `wbnbIsToken0 === true`. */
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const AGENT_ID = "grid-shift-agent";
const START = 1_900_000_000_000;
const MINUTE = 60_000;
const RELAY_FEE = 100_000_000_000_000n;

const SHIFT: LpGridShift = {
  gapTicks: 10,
  widthTicks: 10,
  deployPctBps: DEFAULT_GRID_SHIFT_DEPLOY_PCT_BPS,
  driftPctOfGap: DEFAULT_GRID_SHIFT_DRIFT_PCT,
  shiftsPerDay: DEFAULT_GRID_SHIFT_SHIFTS_PER_DAY,
  driftGasBudgetWei: 8n,
  driftPerMotionWei: 1n,
};

const BACKENDS: readonly {
  readonly name: string;
  readonly make: (now: () => number) => Promise<LpSequenceStore>;
}[] = [
  { name: "memory", make: async (now) => new MemoryLpSequenceStore(now) },
  {
    name: "postgres(fake)",
    make: async (now) => PostgresLpSequenceStore.create(new FakeSqlClient(), now),
  },
];

/**
 * A COHERENT shift grid at a chosen anchor, in either orientation.
 *
 * The rungs come from the ONE derivation the validator's coherence rule
 * re-runs, so a fixture built this way is coherent BY CONSTRUCTION and a test
 * that wants incoherence has to break it deliberately.
 */
function shiftGrid(input: {
  readonly wbnbIsToken0: boolean;
  readonly anchorTick?: number;
  readonly shift?: LpGridShift;
}): LpGridSettings {
  const shift = input.shift ?? SHIFT;
  const derived = gridDeriveRanges({
    currentTick: input.anchorTick ?? 0,
    tickSpacing: 10,
    gapTicks: shift.gapTicks,
    widthTicks: shift.widthTicks,
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
    mode: "shift",
    shift,
  };
}

/** The SAME rungs as a FIXED grid — `mode` and `shift` genuinely ABSENT. */
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
/* R1 / R5.8 / D9 — the signed surface                                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 R1: the shift block's signed surface", () => {
  for (const wbnbIsToken0 of [false, true]) {
    const label = wbnbIsToken0 ? "WBNB token0" : "WBNB token1";
    it(`${label}: a coherent shift grid validates and round-trips through the wire`, () => {
      const settings = settingsWith(shiftGrid({ wbnbIsToken0 }));
      validateLpSettings(settings);
      const parsed = parseLpSettingsParams(lpSettingsParamsView(settings));
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.deepEqual(parsed.value.grid?.shift, SHIFT);
      assert.equal(parsed.value.grid?.mode, "shift");
      // The worker re-validates every cycle, so the round-tripped row must be
      // acceptable to the SAME validator the route ran.
      validateLpSettings(parsed.value);
    });
  }

  it("R1: `grid.shift` emits ONLY when set, so DEFAULT_SETTINGS_DIGEST does not move", () => {
    // The tripwire. A `shift` key emitted at an absent value would move the
    // default digest and refuse every in-flight sequence of every agent with no
    // stored settings row at upgrade.
    assert.equal(
      paramsHash("lpSettings", defaultLpSettingsParams()),
      DEFAULT_SETTINGS_DIGEST,
    );
    assert.equal("shift" in defaultLpSettingsParams(), false);
    const fixed = lpSettingsParamsView({
      ...DEFAULT_LP_SETTINGS,
      grid: fixedTwin(shiftGrid({ wbnbIsToken0: false })),
    });
    assert.equal("shift" in ((fixed["grid"] ?? {}) as Record<string, unknown>), false);
  });

  it("R2/M10: a non-zero stopLossPct or takeProfitPct is REFUSED under shift mode", () => {
    for (const field of ["stopLossPct", "takeProfitPct"] as const) {
      assert.throws(
        () =>
          validateLpSettings({
            ...settingsWith(shiftGrid({ wbnbIsToken0: false })),
            [field]: 50,
          }),
        /refuses a non-zero stopLossPct\/takeProfitPct/u,
        `${field} must be refused under shift mode`,
      );
    }
    // The PRICE triggers stay legal — they compare TICKS, not a basis — and
    // under decision 9 they are the DECLARED risk control for depletion.
    validateLpSettings({
      ...settingsWith(shiftGrid({ wbnbIsToken0: false })),
      priceStopLoss: {
        token0: TOKEN_LO,
        token1: WBNB,
        fee: 2_500,
        tick: -50_000,
        when: "at-or-below",
      },
    });
  });

  it("R5.8/D9: shift mode REQUIRES maxFlipsPerDay 1, so the field is never a dead number", () => {
    const grid = shiftGrid({ wbnbIsToken0: false });
    assert.throws(
      () => validateLpSettings(settingsWith({ ...grid, maxFlipsPerDay: 4 })),
      /requires grid\.maxFlipsPerDay 1/u,
    );
    // 1 is accepted and is MEANINGFUL: it is the ARM's own lane, which is a
    // motion shift mode genuinely performs — the (ae) shape avoided rather than
    // merely refused.
    validateLpSettings(settingsWith({ ...grid, maxFlipsPerDay: 1 }));
  });

  it("R5.8/decision 8: shiftsPerDay is bounded 1..288 with NO policy cap", () => {
    const grid = shiftGrid({ wbnbIsToken0: false });
    for (const bad of [0, -1, MAX_GRID_SHIFT_SHIFTS_PER_DAY + 1, 1.5]) {
      assert.throws(
        () =>
          validateLpSettings(
            settingsWith({ ...grid, shift: { ...SHIFT, shiftsPerDay: bad } }),
          ),
        /shiftsPerDay must be an integer in 1\.\./u,
        `shiftsPerDay ${bad} must be refused`,
      );
    }
    // 24 was R3.4's POLICY cap and decision 8 WITHDREW it. A value above it is
    // legal as long as the reachability conjunct admits it — which at the
    // 5-minute spacing floor it does.
    validateLpSettings(
      settingsWith({ ...grid, shift: { ...SHIFT, shiftsPerDay: 40 } }),
    );
  });

  it("R5.8/D9: the reachability conjunct is `1 + shiftsPerDay <= floor(1440/spacing)`", () => {
    const grid = shiftGrid({ wbnbIsToken0: false });
    // `maxFlipsPerDay` is PINNED to 1 under this mode, so the summed demand IS
    // `1 + shiftsPerDay` without the rule having to say so as a literal.
    const spacing = 60; // floor(1440/60) = 24 reachable
    assert.throws(
      () =>
        validateLpSettings({
          ...settingsWith({ ...grid, shift: { ...SHIFT, shiftsPerDay: 24 } }),
          minMinutesBetweenExits: spacing,
        }),
      /is unreachable/u,
      "1 + 24 = 25 > 24 must be refused",
    );
    validateLpSettings({
      ...settingsWith({ ...grid, shift: { ...SHIFT, shiftsPerDay: 23 } }),
      minMinutesBetweenExits: spacing,
    });
  });

  it("R2.18: every other mode's block is REFUSED beside a shift block, and vice versa", () => {
    const grid = shiftGrid({ wbnbIsToken0: false });
    for (const [key, pattern] of [
      ["policy", /grid\.policy is only meaningful/u],
      ["requote", /grid\.requote is only meaningful/u],
      ["ladder", /grid\.ladder is only meaningful/u],
    ] as const) {
      assert.throws(
        () =>
          validateLpSettings(
            settingsWith({
              ...grid,
              [key]: key === "policy"
                ? { gapTicks: 10, widthTicks: 10 }
                : key === "requote"
                  ? { driftPctOfGap: 60, maxRequotesPerDay: 4 }
                  : {
                      gapTicks: 10,
                      widthTicks: 10,
                      deployPctBps: 3_000,
                      driftPctOfGap: 60,
                      settlementsPerDay: 4,
                      driftMovesPerDay: 0,
                      hedge: { enabled: false, minMarkoutBps: 0, maxHedgePctBps: 5_000 },
                    },
            }),
          ),
        pattern,
      );
    }
    // And the mirror: a shift block under any other mode is the (ae) shape.
    assert.throws(
      () =>
        validateLpSettings(
          settingsWith({ ...fixedTwin(grid), shift: SHIFT }),
        ),
      /grid\.shift is only meaningful under grid\.mode "shift"/u,
    );
  });

  it("R1/R2.25: gapTicks must be STRICTLY positive, unlike the ladder's `>= 0`", () => {
    const grid = shiftGrid({ wbnbIsToken0: false });
    assert.throws(
      () =>
        validateLpSettings(
          settingsWith({ ...grid, shift: { ...SHIFT, gapTicks: 0 } }),
        ),
      /grid\.shift\.gapTicks must be positive/u,
    );
  });

  it("PHASE3.23 R2.8: drift zero is legal only for SHIFT", () => {
    const shift = shiftGrid({ wbnbIsToken0: false, anchorTick: 0 });
    assert.doesNotThrow(() => validateLpSettings({
      ...DEFAULT_LP_SETTINGS,
      grid: { ...shift, shift: { ...(shift.shift as LpGridShift), driftPctOfGap: 0 } },
    }));
    const ladderBase = shiftGrid({ wbnbIsToken0: false, anchorTick: 0 });
    const ladder: LpGridSettings = {
      ...fixedTwin(ladderBase, 1),
      mode: "ladder",
      ladder: {
        gapTicks: 10,
        widthTicks: 10,
        deployPctBps: 3_000,
        driftPctOfGap: 60,
        settlementsPerDay: 4,
        driftMovesPerDay: 0,
        hedge: { enabled: false, minMarkoutBps: 0, maxHedgePctBps: 5_000 },
      },
    };
    assert.throws(
      () => validateLpSettings({
        ...DEFAULT_LP_SETTINGS,
        grid: {
          ...ladder,
          ladder: { ...(ladder.ladder as NonNullable<LpGridSettings["ladder"]>), driftPctOfGap: 0 },
        },
      }),
      /25\.\.200/u,
    );
  });

  it("§10: buyRange2/sellRange2 are REFUSED — a shift ladder is two rows on ONE pair", () => {
    const grid = shiftGrid({ wbnbIsToken0: false });
    assert.throws(
      () =>
        validateLpSettings(
          // A VALID crossed-pair chain, so the shift refusal is what fires
          // rather than the dual-geometry ordering rule that runs before it.
          settingsWith({
            ...grid,
            buyRange2: { tickLower: -40, tickUpper: -30 },
            sellRange2: { tickLower: 0, tickUpper: 10 },
          }),
        ),
      /refuses buyRange2\/sellRange2/u,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* N6 / R3.4 — the two constants, and the seams keyed on the mode             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 N6/R3.4: the two constants are NOT the same number", () => {
  it("the sizing reserve is 2 and the admission cycle count is 1", () => {
    // R2.11 multiplied the cycle count by the PADDED sizing constant and R3.4
    // withdrew it as the exact 'fix' the shipped comments forbid. A mutation
    // that re-conflates them must die here.
    // GRID-GAS-RESERVE (2026-09-04): 2 -> 4 FEE UNITS per motion. Measured on
    // wallet B: the relay meters 2.38x physical gas and a 12-call shift batch
    // is 1.05-1.08M gas, so ~3.3 units; two units of the .env constant were
    // LESS than one real shift and the 01-5 cross wedged on a fee deficit.
    assert.equal(MAX_SUBMISSIONS_PER_GRID_SHIFT, 4, "fee units per shift batch, for sizing");
    assert.equal(MAX_SUBMISSIONS_PER_GRID_SHIFT_CYCLE, 1, "the REAL submission count");
    assert.notEqual(
      MAX_SUBMISSIONS_PER_GRID_SHIFT,
      MAX_SUBMISSIONS_PER_GRID_SHIFT_CYCLE,
      "conflating them is R2.11's withdrawn formula",
    );
  });

  it("PHASE3.25 R5.2: gridCycleSubmissions is cadence-invariant", () => {
    const at = (shiftsPerDay: number): number =>
      gridCycleSubmissions(
        shiftGrid({ wbnbIsToken0: false, shift: { ...SHIFT, shiftsPerDay } }),
      );
    // The `max(2, …)` floor: a round trip is two crossing motions, so a cadence
    // signed at 1 is still priced at the two it actually costs.
    assert.equal(at(1), 2);
    assert.equal(at(8), 2);
    assert.equal(at(24), 2);
    assert.equal(at(288), 2);
    // And it is the CYCLE constant, never the sizing one: at 24 the padded
    // reading would be 48.
    assert.notEqual(at(24), 24 * MAX_SUBMISSIONS_PER_GRID_SHIFT);
  });

  it("the two constants are stated SIDE BY SIDE in the shipped comment", () => {
    // N6's own requirement, pinned at the TEXT level because the hazard is a
    // reader picking the wrong one by habit.
    const source = readFileSync(
      new URL("../src/ops/policy.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /MAX_SUBMISSIONS_PER_GRID_SHIFT\s+= 4\s+.*NATIVE-CAP SIZING RESERVE/u);
    assert.match(source, /MAX_SUBMISSIONS_PER_GRID_SHIFT_CYCLE = 1\s+.*ADMISSION CYCLE COUNT/u);
  });

  it("R2.18: the mode-keyed seams answer for `shift` rather than inheriting", () => {
    // `gridIdentitySourceFor` is `never`-bound, so this is a compile-time
    // guarantee re-asserted at runtime: a shift rung floats, so its identity is
    // the durable COLUMN and never an exact-tick match.
    assert.equal(gridIdentitySourceFor("shift"), "columns");
    // The dispatch map, likewise `never`-bound.
    assert.equal(lpDispatchKindFor("grid-shift"), "grid-shift");
    // R2.6: the ONE-STEP plan. Every other grid kind is flip-SHAPED; this one
    // is not, and the shape IS the phase.
    assert.deepEqual(LP_SAGA_PLANS["grid-shift"], ["grid-shift"]);
  });

  it("R2.6: `grid-shift` is NOT a liquidity-removing STEP kind", () => {
    // The consequence is accepted and stated: `abandonSequence` cannot derive a
    // disposition for it from the kind, which is why R5.1's explicit early
    // branch answers first.
    assert.equal(LIQUIDITY_REMOVING_STEPS.has("grid-shift"), false);
  });

  it("C6: the import refusal is EXHAUSTIVE, and ladder no longer falls through", () => {
    // `fixed` is the ONLY mode with an import door.
    assert.equal(lpGridImportModeRefusal("fixed"), null);
    assert.match(lpGridImportModeRefusal("policy") ?? "", /mode is "policy"/u);
    // C6's DISCOVERED GAP: ladder previously reached the tick-mismatch text,
    // which described the symptom and hid the cause.
    assert.match(lpGridImportModeRefusal("ladder") ?? "", /mode is "ladder"/u);
    assert.match(lpGridImportModeRefusal("shift") ?? "", /mode is "shift"/u);
    // Every sentence must survive the 280-char ceiling with its REMEDY intact.
    for (const mode of ["policy", "ladder", "shift"] as const) {
      const text = lpGridImportModeRefusal(mode) ?? "";
      assert.match(sanitizeMessage(text), /Remedy:/u, `${mode}'s remedy must survive`);
    }
  });
});

describe("PHASE3.25 R5: signed drift pair and cadence split", () => {
  const legacyShift: LpGridShift = {
    gapTicks: SHIFT.gapTicks,
    widthTicks: SHIFT.widthTicks,
    deployPctBps: SHIFT.deployPctBps,
    driftPctOfGap: SHIFT.driftPctOfGap,
    shiftsPerDay: SHIFT.shiftsPerDay,
  };

  it("round-trips all four signed forms and preserves the legacy digest", () => {
    const forms = [
      [
        legacyShift,
        "0x65f4f8bc2b2eb27c5b5c97f1c557196c4336f33752e448fb01621cb55596f9d2",
      ],
      [
        { ...legacyShift, driftGasBudgetWei: 0n, driftPerMotionWei: 1n },
        "0xdd83964870694f8884708e40718e3735a355b727aec226cb678fbca473483dca",
      ],
      [
        { ...legacyShift, driftGasBudgetWei: 8n, driftPerMotionWei: 2n },
        "0x4635e1885ee3be44ec38711bba9d6b03a2b886d868d5f24c84c1875bb886c59a",
      ],
    ] as const;
    for (const [shift, digest] of forms) {
      const settings = settingsWith(shiftGrid({ wbnbIsToken0: false, shift }));
      const wire = lpSettingsParamsView(settings);
      assert.doesNotThrow(() => JSON.stringify(wire), "the wire envelope contains no bigint");
      const parsed = parseLpSettingsParams(wire);
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.deepEqual(parsed.value.grid?.shift, shift);
      assert.equal(paramsHash("lpSettings", wire), digest);
    }
    assert.throws(
      () => validateLpSettings(settingsWith(shiftGrid({
        wbnbIsToken0: false,
        shift: { ...legacyShift, driftGasBudgetWei: 1n },
      }))),
      /must be signed together/u,
    );
  });

  it("validates both signed wei bounds at the exported validator", () => {
    const valid = settingsWith(shiftGrid({
      wbnbIsToken0: false,
      shift: {
        ...legacyShift,
        driftGasBudgetWei: MAX_GRID_SHIFT_DRIFT_GAS_BUDGET_WEI,
        driftPerMotionWei: MAX_GRID_SHIFT_DRIFT_GAS_BUDGET_WEI,
      },
    }));
    assert.doesNotThrow(() => validateLpSettings(valid));
    for (const shift of [
      { ...legacyShift, driftGasBudgetWei: -1n, driftPerMotionWei: 1n },
      { ...legacyShift, driftGasBudgetWei: 1n, driftPerMotionWei: 0n },
      {
        ...legacyShift,
        driftGasBudgetWei: 1n,
        driftPerMotionWei: MAX_GRID_SHIFT_DRIFT_GAS_BUDGET_WEI + 1n,
      },
    ]) {
      assert.throws(() => validateLpSettings(settingsWith(shiftGrid({
        wbnbIsToken0: false,
        shift,
      }))));
    }
  });

  it("derives drift motions only from signed bytes, floors, disables, and clamps", () => {
    assert.equal(gridShiftDriftMotionsPerDay(legacyShift), 0);
    assert.equal(gridShiftDriftMotionsPerDay({
      ...legacyShift,
      driftPctOfGap: 0,
      driftGasBudgetWei: 100n,
      driftPerMotionWei: 1n,
    }), 0);
    assert.equal(gridShiftDriftMotionsPerDay({
      ...legacyShift,
      driftGasBudgetWei: 9n,
      driftPerMotionWei: 10n,
    }), 0);
    assert.equal(gridShiftDriftMotionsPerDay({
      ...legacyShift,
      driftGasBudgetWei: 10n ** 30n,
      driftPerMotionWei: 3n * 10n ** 29n,
    }), 3);
    assert.equal(gridShiftDriftMotionsPerDay({
      ...legacyShift,
      driftGasBudgetWei: 1_000_000n,
      driftPerMotionWei: 1n,
    }), 288);
  });

  it("adds the padded physical shift term and accepts the R6.1 capacity vectors", () => {
    const required = (shiftMotionsPerDay?: number): bigint => {
      const sizing = checkLpNativeCapSizing({
        onChainDailyCapWei: 0n,
        openNativeBudgetWei: 0n,
        maxExitSequencesPerDay: 1,
        ...(shiftMotionsPerDay === undefined ? {} : { shiftMotionsPerDay }),
        lpRelayFeePerSubmitWei: 100n,
      });
      assert.equal(sizing.ok, false);
      assert.equal(sizing.kind, "shortfall");
      return sizing.kind === "shortfall" ? sizing.shortfallWei - 1n : 0n;
    };
    // GRID-GAS-RESERVE: the per-motion reserve is the sizing constant (4 fee
    // units since 2026-09-04), named rather than written as a literal.
    const units = BigInt(MAX_SUBMISSIONS_PER_GRID_SHIFT);
    assert.equal(required(206) - required(), 206n * units * 100n);
    assert.equal(required(288) - required(), 288n * units * 100n);
    assert.equal(required(2) - required(), 2n * units * 100n);
    const malformed = checkLpNativeCapSizing({
      onChainDailyCapWei: 1n,
      openNativeBudgetWei: 0n,
      maxExitSequencesPerDay: 1,
      shiftMotionsPerDay: 289,
    });
    assert.deepEqual(malformed.ok ? null : malformed.kind, "malformed");
  });
});

/* -------------------------------------------------------------------------- */
/* R4.2.1 / P8 — the funding authority                                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 R4.2.1: gridShiftFunding, the ONE authority at both seams", () => {
  const base = {
    deployPctBps: 3_000,
    freedQuoteWei: 0n,
    freedBaseWei: 0n,
    quoteFloorWei: 1_000n,
    baseFloorWei: 1_000n,
  } as const;

  it("BOTH sides fundable ⇒ two mints, SELL FIRST (the R2.2 pin)", () => {
    const funding = gridShiftFunding({
      ...base,
      idleQuoteWei: 10_000n,
      idleBaseWei: 10_000n,
    });
    assert.equal(funding.ok, true);
    assert.equal(funding.hold, false);
    assert.equal(funding.oneSided, false);
    // SELL BEFORE BUY: NFPM ids are sequential, so this order is what makes
    // `sellTokenId < buyTokenId` true — the only guard against attaching the
    // sell NFT to the buy row.
    assert.deepEqual(funding.mintRoles, ["sell", "buy"]);
  });

  it("ONE side below floor ⇒ the motion PROCEEDS one-sided (decision 9)", () => {
    const funding = gridShiftFunding({
      ...base,
      idleQuoteWei: 10_000n,
      idleBaseWei: 1n, // 30% of 1 wei is 0, far below the floor
    });
    assert.equal(funding.ok, true, "one fundable side is a motion, not a hold");
    assert.equal(funding.hold, false);
    assert.equal(funding.oneSided, true);
    assert.deepEqual(funding.mintRoles, ["buy"]);
    assert.equal(funding.sell.fundable, false);
    assert.equal(funding.sell.shortfallWei > 0n, true);
  });

  it("BOTH sides below floor ⇒ HOLD: nothing can mint, so the pair holds", () => {
    const funding = gridShiftFunding({ ...base, idleQuoteWei: 1n, idleBaseWei: 1n });
    assert.equal(funding.ok, false);
    assert.equal(funding.hold, true);
    assert.deepEqual(funding.mintRoles, []);
  });

  it("an ABSENT balance FAILS CLOSED — a conjunct nobody read cannot be satisfied", () => {
    // The 3.19 charter's posture verbatim: a mechanism whose job is to size a
    // mint from the buffer must never degrade to sizing it from something else.
    const funding = gridShiftFunding({
      ...base,
      idleQuoteWei: undefined,
      idleBaseWei: undefined,
    });
    assert.equal(funding.hold, true);
    assert.equal(funding.buy.fundable, false);
    assert.equal(funding.sell.fundable, false);
  });

  it("the FREED term is what makes the motion self-funding", () => {
    // Idle alone is below the floor on both sides; the two rungs this batch is
    // about to CLOSE return their principal in the SAME submission, before the
    // mints pull from it. Omitting the term would hold a pair that can move.
    const idleOnly = gridShiftFunding({ ...base, idleQuoteWei: 1n, idleBaseWei: 1n });
    assert.equal(idleOnly.hold, true);
    const withFreed = gridShiftFunding({
      ...base,
      idleQuoteWei: 1n,
      idleBaseWei: 1n,
      freedQuoteWei: 10_000n,
      freedBaseWei: 10_000n,
    });
    assert.equal(withFreed.hold, false);
    assert.deepEqual(withFreed.mintRoles, ["sell", "buy"]);
  });

  it("the decay is GEOMETRIC — `mint_i = d x available_i`, the 'teo dần' of decision 5", () => {
    // Above the floor the size is a FRACTION of what remains, so consecutive
    // same-direction motions shrink it geometrically rather than exhausting it
    // in one step. That is the shipped `gridLadderResilience` model, which
    // R2.14 reuses verbatim rather than recomputing.
    const sizes: bigint[] = [];
    let available = 1_000_000n;
    for (let i = 0; i < 4; i += 1) {
      const funding = gridShiftFunding({
        ...base,
        idleQuoteWei: available,
        idleBaseWei: available,
      });
      sizes.push(funding.buy.plannedMintWei);
      available -= funding.buy.plannedMintWei;
    }
    for (let i = 1; i < sizes.length; i += 1) {
      assert.equal(
        (sizes[i] as bigint) < (sizes[i - 1] as bigint),
        true,
        "each motion mints less than the one before it",
      );
    }
  });

  it("gridShiftSideFloors: an unpriceable geometry makes BOTH floors unreachable", () => {
    // `minRungWei: null` means no size is economic at this geometry. The floors
    // are set beyond any reachable balance so the funding gate answers HOLD
    // rather than admitting a motion the ADMISSION gate would have refused.
    const floors = gridShiftSideFloors({
      minRungWei: null,
      spotSqrtPriceX96: getSqrtRatioAtTick(0),
      wbnbIsToken0: false,
    });
    const funding = gridShiftFunding({
      ...base,
      idleQuoteWei: 10n ** 30n,
      idleBaseWei: 10n ** 30n,
      quoteFloorWei: floors.quoteFloorWei,
      baseFloorWei: floors.baseFloorWei,
    });
    assert.equal(funding.hold, true);
  });

  it("the hold and one-sided texts come from ONE builder and survive the 280-char cap", () => {
    const hold = lpGridShiftFundingHoldReason({
      funding: gridShiftFunding({ ...base, idleQuoteWei: 1n, idleBaseWei: 1n }),
    });
    assert.match(hold, /NEITHER rung can fund a mint/u);
    assert.match(sanitizeMessage(hold), /Remedy:/u, "the remedy must survive the cap");
    const oneSided = lpGridShiftFundingHoldReason({
      funding: gridShiftFunding({ ...base, idleQuoteWei: 10_000n, idleBaseWei: 1n }),
    });
    assert.match(oneSided, /ONE-SIDED/u);
    assert.match(oneSided, /re-opens by itself/u, "the self-cure must be stated");
  });
});

/* -------------------------------------------------------------------------- */
/* R2.14 / C9 — the economics builder                                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 R2.14: gridShiftEconomics, one builder for three call sites", () => {
  it("it prices on the SHIFT arm of gridCycleSubmissions, not the flip's 2", () => {
    const grid = shiftGrid({ wbnbIsToken0: false, shift: { ...SHIFT, shiftsPerDay: 12 } });
    const economics = gridShiftEconomics({
      grid,
      shift: grid.shift as LpGridShift,
      budgetWei: 10n ** 18n,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    assert.equal(economics.submissionsPerCycle, 2);
    assert.equal(economics.submissionsPerCycle, gridCycleSubmissions(grid));
  });

  it("minBudgetWei is minRungWei inverted through deployPctBps (the L2 correction)", () => {
    const grid = shiftGrid({ wbnbIsToken0: false });
    const economics = gridShiftEconomics({
      grid: { ...grid, minNetEdgeBps: 40 },
      shift: SHIFT,
      budgetWei: 0n,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    if (economics.minRungWei === null || economics.minBudgetWei === null) return;
    // They differ by `2 x 10_000 / deployPctBps` — ~6.7x at the default 30%.
    // Printing the RUNG figure as if it were the BUDGET understates by that
    // factor, which is exactly what L2 found.
    assert.equal(economics.minBudgetWei > economics.minRungWei, true);
  });

  it("PHASE3.25 R2.2: minBudgetWei is flat in cadence and drift budget", () => {
    const values = [4, 24, 96].map((shiftsPerDay) => {
      const shift = {
        ...SHIFT,
        shiftsPerDay,
        driftGasBudgetWei: BigInt(shiftsPerDay),
        driftPerMotionWei: 1n,
      };
      const grid = shiftGrid({ wbnbIsToken0: false, shift });
      return gridShiftEconomics({
        grid,
        shift,
        budgetWei: 10n ** 18n,
        relayFeePerSubmitWei: RELAY_FEE,
      }).minBudgetWei;
    });
    assert.deepEqual(values, [values[0], values[0], values[0]]);
  });

  it("R2.14: resilience REUSES the ladder's geometric model verbatim", () => {
    const grid = shiftGrid({ wbnbIsToken0: false, shift: { ...SHIFT, deployPctBps: 3_000 } });
    const economics = gridShiftEconomics({
      grid: { ...grid, minNetEdgeBps: 40 },
      shift: grid.shift as LpGridShift,
      budgetWei: 0n,
      relayFeePerSubmitWei: RELAY_FEE,
    });
    // `1/(1-d)` in bps at d = 0.3 is 14286 — the shipped model's own constant,
    // not a recomputation. The body's "recomputed for proportional sizing" was
    // WITHDRAWN by R2.14 precisely because the model does not change.
    assert.equal(economics.resilience.requiredMultipleBps, 14_286);
    // A budget of `0n` prices only the GEOMETRY, so `fundableFills` is `null`
    // when no economic rung exists at all and `0` when one does — never a
    // positive number. That is the property an owner most needs: at the printed
    // minimum budget ZERO fills settle, which the funding hold's text repeats.
    assert.equal(
      economics.resilience.fundableFills === null
        || economics.resilience.fundableFills === 0,
      true,
    );
    // And ABOVE `1/(1-d)` x the minimum, settlements become fundable — the SAME
    // shipped model answering a richer budget, not a recomputation.
    if (economics.minBudgetWei !== null && economics.minBudgetWei > 0n) {
      const richer = gridShiftEconomics({
        grid: { ...grid, minNetEdgeBps: 40 },
        shift: grid.shift as LpGridShift,
        budgetWei: economics.minBudgetWei * 4n,
        relayFeePerSubmitWei: RELAY_FEE,
      });
      assert.equal((richer.resilience.fundableFills ?? 0) >= 1, true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* R9 — the G-gate's one refusal builder                                       */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 R9: ONE refusal builder for both G-gate seams", () => {
  it("it names the seam, the failed conjunct and the figures, inside the cap", () => {
    for (const where of ["trigger", "mint"] as const) {
      for (const failed of ["in-range", "side", "dust"] as const) {
        const text = lpGridShiftRefusal({
          where,
          failed,
          role: "buy",
          currentTick: 0,
          range: { tickLower: 20, tickUpper: 30 },
        });
        assert.match(text, new RegExp(`at the ${where}`, "u"));
        // The whole sentence must survive `sanitizeMessage` — no clipped tail.
        assert.equal(sanitizeMessage(text), text, `${where}/${failed} must fit in 280`);
      }
    }
  });

  it("R2.25: the derivation's clearance is what the gate inherits", () => {
    // STRICT anchors: `above.tickLower = upperAnchor + g`, so at a tick sitting
    // exactly on a spacing multiple the below-side range still clears by `g`.
    // That is why R1 requires `gapTicks > 0` STRICTLY where the ladder's is
    // `>= 0` — at zero the below range would abut the tick.
    const derived = gridDeriveRanges({
      currentTick: 0,
      tickSpacing: 10,
      gapTicks: 10,
      widthTicks: 10,
      wbnbIsToken0: false,
      minTick: MIN_TICK,
      maxTick: MAX_TICK,
    });
    assert.equal(derived.buyRange.tickUpper < 0, true, "buy strictly below the tick");
    assert.equal(derived.sellRange.tickLower > 0, true, "sell strictly above the tick");
  });
});

/* -------------------------------------------------------------------------- */
/* D6 / P6 — the group lock's predicate                                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 D6/P6: gridShiftGroupLock is MODE FIRST", () => {
  it("a LADDER pair is untouched, which is the whole byte-identity argument", () => {
    // A ladder pair also carries `arm_group_id`. A predicate that tested the
    // COLUMN first would change ladder behaviour on every call — exactly what
    // R2's byte-identity requirement forbids.
    const ladderGridBlock: LpGridSettings = {
      ...fixedTwin(shiftGrid({ wbnbIsToken0: false }), 1),
      mode: "ladder",
      ladder: {
        gapTicks: 10,
        widthTicks: 10,
        deployPctBps: 3_000,
        driftPctOfGap: 60,
        settlementsPerDay: 4,
        driftMovesPerDay: 0,
        hedge: { enabled: false, minMarkoutBps: 0, maxHedgePctBps: 5_000 },
      },
    };
    assert.equal(
      gridShiftGroupLock({ grid: ladderGridBlock, armGroupId: "group-1" }),
      false,
      "a ladder pair must fall out at the FIRST conjunct",
    );
  });

  it("it applies to a shift pair, and only when the row carries a group", () => {
    const grid = shiftGrid({ wbnbIsToken0: false });
    assert.equal(gridShiftGroupLock({ grid, armGroupId: "group-1" }), true);
    assert.equal(gridShiftGroupLock({ grid, armGroupId: null }), false);
    assert.equal(gridShiftGroupLock({ grid: null, armGroupId: "group-1" }), false);
  });
});

/* -------------------------------------------------------------------------- */
/* R6 / R2.21 — the shift QUOTA LANE, on both backends                        */
/* -------------------------------------------------------------------------- */

const QUOTA: LpExitQuota = {
  maxExitSequencesPerDay: 10,
  minMinutesBetweenExits: 0,
  maxGridFlipsPerDay: 5,
  maxRequotesPerDay: 5,
  maxSettlementsPerDay: 5,
  maxDriftMovesPerDay: 5,
  maxShiftsPerDay: 2,
  maxShiftDriftPerDay: 1,
};

async function seedPosition(
  store: LpSequenceStore,
  positionId: string,
  extra: {
    readonly armGroupId?: string;
    readonly gridRole?: "buy" | "sell";
    readonly tokenId?: string;
    readonly lineageId?: string;
  } = {},
): Promise<void> {
  await store.createPosition({
    positionId,
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    token0: TOKEN_LO,
    token1: WBNB,
    fee: 2_500,
    basisWei: 0n,
    basisSource: "minted",
    ...(extra.armGroupId === undefined ? {} : { armGroupId: extra.armGroupId }),
    ...(extra.gridRole === undefined ? {} : { gridLevel: 1, gridRole: extra.gridRole }),
    ...(extra.tokenId === undefined ? {} : { tokenId: extra.tokenId }),
    ...(extra.lineageId === undefined ? {} : { lineageId: extra.lineageId }),
  });
}

for (const backend of BACKENDS) {
  describe(`PHASE3.22 R2.21 (${backend.name}): the shift lane`, () => {
    it("PHASE3.23 N2: shift cause and one-target shape round-trip together", async () => {
      const store = await backend.make(() => START);
      await seedPosition(store, "cause-shape");
      const created = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "cause-shape",
        kind: "grid-shift",
        targetRange: { tickLower: -120, tickUpper: -60 },
        shiftCause: "drift",
      });
      const reread = await store.getSequence(OWNER, AGENT_ID, created.sequenceId);
      assert.equal(reread?.shiftCause, "drift");
      assert.equal(reread?.targetTickLower, -120);
      assert.equal(reread?.targetTickUpper, -60);
      assert.equal(reread?.targetSellTickLower, null);
      assert.equal(reread?.targetSellTickUpper, null);
      await store.close();
    });

    it("a grid-shift reservation charges the SHIFT lane and NOT the exit lane", async () => {
      const store = await backend.make(() => START);
      await seedPosition(store, "p1");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "grid-shift",
      });
      await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, QUOTA);
      const usage = await store.quotaUsage(OWNER, AGENT_ID);
      assert.equal(usage.shiftLiveCount, 1, "its OWN lane");
      // THE SUBTRACTION, which R2.10 calls "the easiest defect in this phase":
      // without it every atomic motion would charge the owner's EXIT quota —
      // the lane that pays for rotates, harvests and the protect headroom.
      assert.equal(usage.liveCount, 0, "and NOT the exit lane");
      await store.close();
    });

    it("the lane is bounded by shiftsPerDay and FAILS CLOSED at zero without it", async () => {
      const store = await backend.make(() => START);
      for (const id of ["p1", "p2", "p3"]) await seedPosition(store, id);
      for (const id of ["p1", "p2"]) {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: id,
          kind: "grid-shift",
        });
        await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, QUOTA);
      }
      const third = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p3",
        kind: "grid-shift",
      });
      await assert.rejects(
        () => store.reserveSequence(OWNER, AGENT_ID, third.sequenceId, QUOTA),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.lane === "shift-settle",
        "the THIRD must be refused in the SHIFT lane, named",
      );
      await store.close();
    });

    it("an ABSENT maxShiftsPerDay refuses at zero — never a default nobody signed", async () => {
      const store = await backend.make(() => START);
      await seedPosition(store, "p1");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "grid-shift",
      });
      const { maxShiftsPerDay: _omitted, ...noShiftLane } = QUOTA;
      await assert.rejects(
        () => store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, noShiftLane),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.lane === "shift-settle",
      );
      await store.close();
    });

    it("PHASE3.25 R5.3: settlement and drift counts are independent", async () => {
      const store = await backend.make(() => START);
      const quota = { ...QUOTA, maxShiftsPerDay: 3, maxShiftDriftPerDay: 1 };
      for (const id of ["c1", "c2", "d1", "d2"]) await seedPosition(store, id);
      for (const [id, shiftCause] of [
        ["c1", "cross"],
        ["c2", "cross"],
        ["d1", "drift"],
      ] as const) {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: id,
          kind: "grid-shift",
          shiftCause,
        });
        await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota);
      }
      const fourth = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "d2",
        kind: "grid-shift",
        shiftCause: "drift",
      });
      await assert.rejects(
        () => store.reserveSequence(OWNER, AGENT_ID, fourth.sequenceId, quota),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.lane === "shift-drift",
      );
      const usage = await store.quotaUsage(OWNER, AGENT_ID);
      assert.equal(usage.shiftLiveCount, 3);
      assert.equal(usage.shiftSettleLiveCount, 2);
      assert.equal(usage.shiftDriftLiveCount, 1);
      assert.equal(usage.recenterLiveCount, 0, "ladder lanes are kind-scoped");
      await store.close();
    });

    it("PHASE3.25 R5.3: drift exhaustion does not consume settlement allowance", async () => {
      const store = await backend.make(() => START);
      const quota = { ...QUOTA, maxShiftsPerDay: 3, maxShiftDriftPerDay: 2 };
      for (const id of ["d0", "d1", "d2", "c0"]) await seedPosition(store, id);
      for (const id of ["d0", "d1"]) {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: id,
          kind: "grid-shift",
          shiftCause: "drift",
        });
        await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota);
      }
      const refused = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "d2",
        kind: "grid-shift",
        shiftCause: "drift",
      });
      await assert.rejects(
        () => store.reserveSequence(OWNER, AGENT_ID, refused.sequenceId, quota),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.lane === "shift-drift",
      );
      const cross = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "c0",
        kind: "grid-shift",
        shiftCause: "cross",
      });
      const admitted = await store.reserveSequence(
        OWNER,
        AGENT_ID,
        cross.sequenceId,
        quota,
      );
      assert.equal(admitted.quotaLane, "shift-settle");
      await store.close();
    });

    it("PHASE3.25 R5.3: settlement exhaustion does not consume drift allowance", async () => {
      const store = await backend.make(() => START);
      const quota = { ...QUOTA, maxShiftsPerDay: 1, maxShiftDriftPerDay: 1 };
      for (const id of ["c0", "c1", "d0"]) await seedPosition(store, id);
      const cross = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "c0",
        kind: "grid-shift",
        shiftCause: "cross",
      });
      await store.reserveSequence(OWNER, AGENT_ID, cross.sequenceId, quota);
      const refused = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "c1",
        kind: "grid-shift",
        shiftCause: "cross",
      });
      await assert.rejects(
        () => store.reserveSequence(OWNER, AGENT_ID, refused.sequenceId, quota),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.lane === "shift-settle",
      );
      const drift = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "d0",
        kind: "grid-shift",
        shiftCause: "drift",
      });
      const admitted = await store.reserveSequence(
        OWNER,
        AGENT_ID,
        drift.sequenceId,
        quota,
      );
      assert.equal(admitted.quotaLane, "shift-drift");
      await store.close();
    });

    it("PHASE3.23 R3.3: ladder recenter and shift lanes never cross-charge", async () => {
      const store = await backend.make(() => START);
      for (const id of ["ladder", "shift"]) await seedPosition(store, id);
      const ladder = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "ladder",
        kind: "grid-recenter",
        recenterEvidence: "drift",
      });
      await store.reserveSequence(OWNER, AGENT_ID, ladder.sequenceId, QUOTA);
      const shift = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "shift",
        kind: "grid-shift",
        shiftCause: "cross",
      });
      await store.reserveSequence(OWNER, AGENT_ID, shift.sequenceId, QUOTA);
      const usage = await store.quotaUsage(OWNER, AGENT_ID);
      assert.equal(usage.recenterLiveCount, 1);
      assert.equal(usage.driftLiveCount, 1);
      assert.equal(usage.shiftLiveCount, 1);
      assert.equal(usage.shiftDriftLiveCount, 0);
      await store.close();
    });
  });
}

describe("PHASE3.22 R6: the quota hold's own sentence", () => {
  it("it names the CONSEQUENCE, which for a shift is symmetric staleness", () => {
    const text = lpGridShiftQuotaHoldReason({
      lane: "shift-settle",
      bound: "quota",
      used: 8,
      limit: 8,
      motionProjection: 4,
      minMinutesBetweenExits: 5,
    });
    assert.match(text, /settlement cap is spent/u);
    assert.match(text, /drift allowance is unaffected/u);
    // A QUOTA hold creates no sequence, and only a HELD SEQUENCE disarms a
    // price stop — so the sentence says the stop stays armed.
    assert.match(text, /price stop stays armed/u);
    assert.match(sanitizeMessage(text), /Remedy:/u);
  });

  it("PHASE3.25 R6.5: maximum-width T5/T6 survive sanitizeMessage whole", () => {
    const settle = lpGridShiftQuotaHoldReason({
      lane: "shift-settle",
      bound: "quota",
      used: 288,
      limit: 288,
      motionProjection: 288,
      minMinutesBetweenExits: 5,
    });
    const drift = lpGridShiftQuotaHoldReason({
      lane: "shift-drift",
      bound: "quota",
      used: 288,
      limit: 288,
      motionProjection: 288,
      minMinutesBetweenExits: 5,
    });
    assert.equal(
      settle,
      "Shift ladder holds: the settlement cap is spent — 288/288 in the rolling 24 h. Remedy: raise grid.shift.shiftsPerDay, or wait. The drift allowance is unaffected; both lanes share agent-wide spacing. NO sequence, NO reservation, nothing rolled back; the price stop stays armed.",
    );
    assert.equal(
      drift,
      "Shift holds: drift allowance spent — 288/288 motions/24 h. Remedy: raise grid.shift.driftGasBudgetWei or wait for the window. Settlement is unaffected; spacing remains agent-wide. NO sequence or reservation; nothing rolled back; the price stop stays armed.",
    );
    assert.equal(settle.length, 276);
    assert.equal(drift.length, 256);
    assert.equal(sanitizeMessage(settle), settle);
    assert.equal(sanitizeMessage(drift), drift);
    assert.match(sanitizeMessage(settle), /Remedy:/u);
    assert.match(sanitizeMessage(drift), /Remedy:/u);
  });

  it("PHASE3.25 R6.5: T1/T2 exact quota errors survive sanitizing", () => {
    const settle = new LpExitQuotaError("quota-exhausted", "shift-settle").message;
    const drift = new LpExitQuotaError("quota-exhausted", "shift-drift").message;
    assert.equal(
      settle,
      "Rolling 24-hour grid-shift SETTLEMENT quota is exhausted; fills stop being settled until the window rolls. The drift allowance is unaffected; both lanes still share agent-wide spacing.",
    );
    assert.equal(
      drift,
      "Rolling 24-hour grid-shift DRIFT allowance is exhausted. Remedy: re-sign grid.shift.driftGasBudgetWei higher, or wait for the window to roll. The settlement quota is unaffected; both lanes still share agent-wide spacing.",
    );
    assert.equal(settle.length, 184);
    assert.equal(drift.length, 220);
    assert.equal(sanitizeMessage(settle), settle);
    assert.equal(sanitizeMessage(drift), drift);
  });
});

/* -------------------------------------------------------------------------- */
/* D2 — the `shift-ambiguous` member, at every site, on BOTH backends          */
/* -------------------------------------------------------------------------- */

for (const backend of BACKENDS) {
  describe(`PHASE3.22 D2 (${backend.name}): the shift-ambiguous recovery member`, () => {
    it("BOOT AND WRITE: the store accepts the marker and reads it back", async () => {
      // THIS IS THE D2 TEST REVIEW4 NAMES. Without the guarded `recovery_state`
      // CHECK migration the pre-submit write raises a constraint violation on
      // Postgres, the mode never runs, and every memory-backend test stays
      // green — the offline-green / live-dead split this repo keeps paying for.
      const store = await backend.make(() => START);
      await seedPosition(store, "p1");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "grid-shift",
      });
      await store.setRecoveryState(OWNER, AGENT_ID, sequence.sequenceId, "shift-ambiguous");
      const reread = await store.getSequence(OWNER, AGENT_ID, sequence.sequenceId);
      assert.equal(reread?.recoveryState, "shift-ambiguous");
      await store.close();
    });

    it("the marker makes an ambiguous park HELD, which is what opens every door", async () => {
      const store = await backend.make(() => START);
      await seedPosition(store, "p1");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "grid-shift",
      });
      await store.setRecoveryState(OWNER, AGENT_ID, sequence.sequenceId, "shift-ambiguous");
      await store.setSequenceState(OWNER, AGENT_ID, sequence.sequenceId, "held");
      const held = await store.getSequence(OWNER, AGENT_ID, sequence.sequenceId);
      assert.equal(held?.state, "held");
      assert.equal(held?.recoveryState, "shift-ambiguous");
      // `claimSequenceForAbandon` claims `held` ONLY — the door P1 proved was
      // shut while the label was `none`.
      const claimed = await store.claimSequenceForAbandon(
        OWNER,
        AGENT_ID,
        sequence.sequenceId,
        {
          expectedUpdatedAt: (held as LpSequenceRecord).updatedAt,
          claimId: "claim-1",
          nowMs: START + 10 * MINUTE,
          minIdleMs: MINUTE,
        },
      );
      assert.notEqual(claimed, null, "a held+marked row must be claimable");
      await store.close();
    });
  });
}

describe("PHASE3.22 D2: the six enumeration sites, pinned", () => {
  it("the member appears at the union, the runtime set, the DDL and the migration", () => {
    const source = readFileSync(
      new URL("../src/store/lpSequences.ts", import.meta.url),
      "utf8",
    );
    // (1) the union, (2) the runtime set, (3) the create-table CHECK.
    assert.match(source, /\| "shift-ambiguous"/u);
    assert.match(source, /"shift-ambiguous",\s*\n\s*"none",/u);
    assert.match(
      source,
      /recovery_state in \('pending-mint', 'pending-increase', 'wbnb-stranded', 'shift-ambiguous', 'none'\)/u,
    );
    // (3b) THE MIGRATION — the site whose omission is the killer.
    assert.match(source, /lp_sequences_shift_recovery/u);
    assert.match(source, /not like '%shift-ambiguous%'/u);
    // And the fifth kind-CHECK widening, keyed on its OWN member.
    assert.match(source, /not like '%grid-shift%'/u);
  });

  it("the evidence unions and the landing finalizer are WIDENED, with the reason", () => {
    const evidence = readFileSync(
      new URL("../src/store/lpEvidence.ts", import.meta.url),
      "utf8",
    );
    // (4) three narrowed unions plus the CHECK. `grid-shift` can never reach an
    // evidence row — grid is boot-incompatible with landing evidence — but the
    // unions are TYPE-level and an `LpRecoveryState` is assigned into them, so
    // keeping them narrow breaks the COMPILE whether or not the flag is on.
    assert.equal(
      (evidence.match(/"wbnb-stranded" \| "shift-ambiguous"/gu) ?? []).length,
      3,
      "all three unions widened",
    );
    assert.match(evidence, /'wbnb-stranded','shift-ambiguous'/u);
    // (5) the landing finalizer's own union.
    const finalizer = readFileSync(
      new URL("../src/lp/landingFinalizer.ts", import.meta.url),
      "utf8",
    );
    assert.match(finalizer, /"wbnb-stranded" \| "shift-ambiguous"/u);
  });

  it("(6) the step's recoveryAfterConfirm IS the marker, not `none`", () => {
    // R12 said `"none"` and R4.1 withdrew it without naming a replacement; D2
    // required the build to name one. `"shift-ambiguous"` is the coherent
    // value: it makes the pre-submit write and the post-confirm write the SAME
    // value, so a POST_VERIFY_FAILED after the mints also parks `held` — which
    // is what tier 2 depends on.
    const sagas = readFileSync(new URL("../src/lp/sagas.ts", import.meta.url), "utf8");
    assert.match(sagas, /recoveryAfterConfirm: "shift-ambiguous"/u);
    assert.match(sagas, /markRecoveryBeforeSubmit: true/u);
  });

  it("D3: the marker is written STRICTLY BEFORE the journal begin", () => {
    // "In the same durable write" was never expressible — they are different
    // stores. ORDERING is, and ordering is what is required.
    const sagas = readFileSync(new URL("../src/lp/sagas.ts", import.meta.url), "utf8");
    // Anchored on the CODE, not on the first textual mention: `beginWithSpend`
    // appears in a docstring earlier in the file.
    const markerAt = sagas.indexOf("if (step.markRecoveryBeforeSubmit === true)");
    // The SUBMIT path's begin specifically — there are three call sites and the
    // other two are on the resume/replay paths, which is why a bare
    // `beginWithSpend` search finds an earlier one.
    const beginAt = sagas.indexOf(
      "const { otherSpendWei, created } = await deps.journal.beginWithSpend(",
    );
    assert.equal(markerAt > 0 && beginAt > 0, true);
    assert.equal(markerAt < beginAt, true, "the marker must precede the begin");
  });

  it("PHASE3.23 REVIEW2 N2: every append-only shift_cause persistence seam is present", () => {
    const store = readFileSync(
      new URL("../src/store/lpSequences.ts", import.meta.url),
      "utf8",
    );
    const fake = readFileSync(
      new URL("./support/fakeSql.ts", import.meta.url),
      "utf8",
    );
    assert.match(store, /readonly shiftCause: LpShiftCause \| null/u);
    assert.match(store, /readonly shiftCause\?: LpShiftCause/u);
    assert.match(store, /shiftCause: input\.shiftCause \?\? null/u);
    assert.match(store, /shift_cause: string \| null/u);
    assert.match(store, /target_sell_tick_upper, shift_cause"/u);
    assert.match(store, /add column if not exists shift_cause text/u);
    assert.match(store, /shift_cause in \('cross', 'drift'\)/u);
    assert.match(store, /target_sell_tick_upper, shift_cause\)/u);
    assert.match(store, /input\.shiftCause \?\? null/u);
    assert.match(store, /shiftCause: asShiftCause\(row\.shift_cause\)/u);
    assert.match(fake, /shift_cause: params\[12\] \?\? null/u);
  });

  it("PHASE3.23 R3.3: Postgres serializes the shared shift quota scope", () => {
    const source = readFileSync(
      new URL("../src/store/lpSequences.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /lpReservations\.shiftQuotaLock/u);
    assert.match(source, /pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)/u);
  });
});

/* -------------------------------------------------------------------------- */
/* D1 / R5.1 — the declared-ambiguity abandon arm, and its MUTATION            */
/* -------------------------------------------------------------------------- */

/** A sequence record shaped for the abandon verifier, with no store behind it. */
function sequenceRecord(input: {
  readonly kind: LpSequenceRecord["kind"];
  readonly stepKind: string;
  readonly recoveryState?: LpSequenceRecord["recoveryState"];
  readonly stallCount?: number;
}): LpSequenceRecord {
  return {
    sequenceId: "seq-1",
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    positionId: "p1",
    kind: input.kind,
    inlineConvert: false,
    state: "held",
    recoveryState: input.recoveryState ?? "shift-ambiguous",
    steps: [
      {
        index: 0,
        kind: input.stepKind as LpSequenceRecord["steps"][number]["kind"],
        journalIdempotencyKey: "key-0",
        journalDecisionId: "lp:seq-1:0",
      },
    ],
    note: null,
    inlineResidueBaseWei: null,
    stallCode: null,
    stallCount: input.stallCount ?? 0,
    targetTickLower: null,
    targetTickUpper: null,
    targetSellTickLower: null,
    targetSellTickUpper: null,
    shiftCause: null,
    hedgeDirection: null,
    hedgeAmountInWei: null,
    recenterEvidence: null,
    resolverPriorState: null,
    resolverPriorRecoveryState: null,
    resolverFence: 0n,
    resolverLeaseUntil: null,
    resolverSnapshotHash: null,
    resolverRowVersion: 0,
    resolutionId: null,
    resolverActionIdempotencyKey: null,
    resolutionDispositionStarted: false,
    retirementPriorState: null,
    retirementPriorRecoveryState: null,
    retirementTargetJournalKey: null,
    retirementActionIdempotencyKey: null,
    retirementFence: 0n,
    retirementLeaseUntil: null,
    retirementSnapshotHash: null,
    retirementRowVersion: 0,
    retirementDispositionStarted: false,
    abandonClaimId: null,
    abandonClaimedAt: null,
    abandonDispositionStartedAt: null,
    createdAt: START,
    updatedAt: START,
  } as LpSequenceRecord;
}

function journalRow(state: JournalEntry["state"], txHash?: string): JournalEntry {
  return {
    idempotencyKey: "key-0",
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    kind: "lp",
    decisionId: "lp:seq-1:0",
    state,
    externalRef: txHash === undefined ? {} : { txHash: txHash as `0x${string}` },
    nativeSpendWei: 0n,
    createdAt: START,
    updatedAt: START,
  } as JournalEntry;
}

describe("PHASE3.22 D1/R5.1: the declared-ambiguity abandon arm", () => {
  const common = {
    nextIndexRow: null,
    positionState: "open" as const,
    nowMs: START + 10 * MINUTE,
    minIdleMs: MINUTE,
    armGroupPositionIds: ["p1", "p2"],
    armGroupTokenIds: ["111", "222"],
  };

  for (const state of ["UNKNOWN", "PENDING", "IN_PROGRESS"] as const) {
    it(`a ${state} grid-shift step is ACCEPTED and closes BOTH rows`, () => {
      // D1's placement finding: check (b) refuses `step_not_settled` for any row
      // outside {COMMITTED, ROLLED_BACK} and RETURNS, so the disposition ternary
      // R4.5 L4 named was unreachable for the state it exists to serve. The arm
      // is an EXPLICIT EARLY BRANCH placed before check (b).
      //
      // PENDING and IN_PROGRESS are covered because the BSC relay's undocumented
      // `{"status":300,"receipts":[]}` lands as PENDING (FINDINGS/3.14) and
      // `grid-shift` has NO in-plane resolver to drive it onward.
      const verdict = verifyLpAbandonSequence({
        ...common,
        sequence: sequenceRecord({ kind: "grid-shift", stepKind: "grid-shift" }),
        stepRows: new Map([["key-0", journalRow(state as JournalEntry["state"])]]),
      });
      assert.equal(verdict.ok, true, `${state} must be abandonable`);
      if (!verdict.ok) return;
      assert.equal(verdict.positionAction, "close");
      // Closing is what makes the RESTART real: the arm's idle gate refuses on
      // any non-closed row, so leaving the pair open would wedge the owner.
      assert.match(verdict.note ?? "", /may or may not have landed/u);
      assert.match(verdict.note ?? "", /111 and 222/u, "both prior tokenIds named");
      assert.match(verdict.note ?? "", /YOUR OWN wallet/u);
      assert.match(verdict.note ?? "", /gridArm again/u);
    });
  }

  it("THE MUTATION: flipping the kind guard must NOT make a rotate abandonable", () => {
    // REVIEW4's named mutation target, verbatim: "flip the kind guard and watch
    // a `rotate` with an UNKNOWN `zap-out` become abandonable". A rotate
    // abandoned mid-zap-out strands the principal, which is precisely what
    // check (b) exists to prevent — so the arm must relax NOTHING for any other
    // kind.
    const verdict = verifyLpAbandonSequence({
      ...common,
      sequence: sequenceRecord({
        kind: "rotate",
        stepKind: "zap-out",
        recoveryState: "pending-mint",
      }),
      stepRows: new Map([["key-0", journalRow("UNKNOWN")]]),
    });
    assert.equal(verdict.ok, false, "a rotate with an UNKNOWN zap-out must be REFUSED");
    if (verdict.ok) return;
    assert.equal(verdict.code, "step_not_settled");
  });

  it("a ROLLED_BACK grid-shift falls THROUGH to the ordinary disposition", () => {
    // The batch FAILED, so nothing moved: `grid-shift` is not in
    // `LIQUIDITY_REMOVING_STEPS`, the kind is not `open`/`grid-arm`, and an
    // `open` row is left alone. Both rungs are exactly where they were, which
    // is the truth.
    const verdict = verifyLpAbandonSequence({
      ...common,
      sequence: sequenceRecord({ kind: "grid-shift", stepKind: "grid-shift" }),
      stepRows: new Map([["key-0", journalRow("ROLLED_BACK")]]),
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.positionAction, "leave");
    assert.equal(verdict.note, undefined, "no declared-ambiguity note is owed");
  });
});

/* -------------------------------------------------------------------------- */
/* D4 / R4.3 — the COMMITTED hold's two tiers                                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 D4/R4.3: the COMMITTED grid-shift abandon is two-tiered", () => {
  const common = {
    nextIndexRow: null,
    positionState: "open" as const,
    nowMs: START + 10 * MINUTE,
    minIdleMs: MINUTE,
    armGroupPositionIds: ["p1", "p2"],
    armGroupTokenIds: ["111", "222"],
  };

  it("TIER 1: the refusal stands while the finish is still worth resuming", () => {
    const verdict = verifyLpAbandonSequence({
      ...common,
      sequence: sequenceRecord({ kind: "grid-shift", stepKind: "grid-shift" }),
      stepRows: new Map([["key-0", journalRow("COMMITTED", "0xabc")]]),
      stallLatchAttempts: LP_STALL_LATCH_ATTEMPTS,
    });
    assert.equal(verdict.ok, false, "abandoning would ORPHAN the freshly minted NFTs");
    if (verdict.ok) return;
    assert.match(verdict.message, /idempotently re-runnable/u);
    assert.match(verdict.message, /last resort once the worker has stalled/u);
  });

  it("TIER 2: a PERMANENTLY throwing finish quiesces the row and opens the door", () => {
    // D4's reachability chain, verified in REVIEW4 §C: a throw out of the
    // step's `after` becomes `holdSequence("POST_VERIFY_FAILED")`, the worker
    // latches the identical stall code every cycle, three identical stalls trip
    // `shouldDeferStalledResume`, `updated_at` goes quiescent and `minIdleMs`
    // becomes satisfiable. THAT is why R5.4 pins the shift's position writes
    // into `after` and NOT `input.finish` — a throw out of `input.finish`
    // escapes `driveSequence` unguarded, records no stall, and tier 2 would
    // never open at all.
    const verdict = verifyLpAbandonSequence({
      ...common,
      sequence: sequenceRecord({
        kind: "grid-shift",
        stepKind: "grid-shift",
        stallCount: LP_STALL_LATCH_ATTEMPTS,
      }),
      stepRows: new Map([["key-0", journalRow("COMMITTED", "0xabc")]]),
      stallLatchAttempts: LP_STALL_LATCH_ATTEMPTS,
    });
    assert.equal(verdict.ok, true, "the last-resort door must open");
    if (!verdict.ok) return;
    assert.equal(verdict.positionAction, "close");
    assert.match(verdict.note ?? "", /LANDED/u);
    assert.match(verdict.note ?? "", /0xabc/u, "the txHash must be named");
    // The ORPHANING HAZARD is written into the note rather than being a silent
    // `"leave"` fall-through (REVIEW2 N4).
    assert.match(verdict.note ?? "", /NO record of the new tokenIds/u);
  });

  it("an ABSENT threshold keeps tier 2 SHUT — fail-closed", () => {
    // Tier 2 discards the plane's account of two NFTs. A caller that did not
    // supply the threshold has not asked for that.
    const verdict = verifyLpAbandonSequence({
      ...common,
      sequence: sequenceRecord({
        kind: "grid-shift",
        stepKind: "grid-shift",
        stallCount: 99,
      }),
      stepRows: new Map([["key-0", journalRow("COMMITTED", "0xabc")]]),
    });
    assert.equal(verdict.ok, false);
  });

  it("D4(b): abandonSequence stays PURE — it never imports the worker", () => {
    const source = readFileSync(
      new URL("../src/lp/abandonSequence.ts", import.meta.url),
      "utf8",
    );
    assert.equal(
      /from ".\/worker\.js"/u.test(source),
      false,
      "the threshold arrives as an INPUT beside minIdleMs, never as an import",
    );
    assert.match(source, /stallLatchAttempts/u);
  });
});

/* -------------------------------------------------------------------------- */
/* R4.2.3 / R2.27(f) — createPositionForArmGroup, on both backends              */
/* -------------------------------------------------------------------------- */

for (const backend of BACKENDS) {
  describe(`PHASE3.22 R4.2.3 (${backend.name}): the dormant side re-opens`, () => {
    it("a depleted row CLOSES with its reason, and a later motion re-creates it", async () => {
      const store = await backend.make(() => START);
      await seedPosition(store, "buy-row", {
        armGroupId: "group-1",
        gridRole: "buy",
        tokenId: "111",
      });
      await seedPosition(store, "sell-row", {
        armGroupId: "group-1",
        gridRole: "sell",
        tokenId: "222",
      });
      const sellBefore = await store.getPosition(OWNER, AGENT_ID, "sell-row");
      const lineageId = sellBefore?.lineageId as string;

      // THE ONE-SIDED FINISH: the sell side fell below its floor, so the batch
      // exited its rung and minted nothing back. Its principal is in the buffer
      // and the row has no NFT, so it is CLOSED — never parked as a
      // null-tokenId zombie, the shape REVIEW2 refuted and R4.2 replaced.
      await store.setPositionState(
        OWNER,
        AGENT_ID,
        "sell-row",
        "closed",
        undefined,
        "shift-depleted",
      );
      const closed = await store.getPosition(OWNER, AGENT_ID, "sell-row");
      assert.equal(closed?.state, "closed");
      assert.equal(closed?.closeReason, "shift-depleted");

      // A LATER motion's funding check clears the floor again, so the finish
      // CREATES a fresh row for that role — same arm group, lineage carried.
      const reopened = await createPositionForArmGroup(store, {
        positionId: "sell-row-2",
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        token0: TOKEN_LO,
        token1: WBNB,
        fee: 2_500,
        quoteToken: WBNB,
        armGroupId: "group-1",
        gridRole: "sell",
        lineageId,
      });
      assert.equal(reopened.armGroupId, "group-1");
      assert.equal(reopened.gridRole, "sell");
      assert.equal(reopened.gridLevel, 1);
      assert.equal(reopened.lineageId, lineageId, "the pair's lineage is CARRIED");
      assert.equal(reopened.basisWei, 0n, "a shift rung has no value-versus-basis stop");
      assert.equal(reopened.basisSource, "minted");
      assert.equal(reopened.tokenId, null, "the tokenId is written from the receipt");
      await store.close();
    });

    it("a CLOSED dormant row does not block a re-arm (REVIEW4 §C's strongest argument)", async () => {
      const store = await backend.make(() => START);
      await seedPosition(store, "sell-row", {
        armGroupId: "group-1",
        gridRole: "sell",
        tokenId: "222",
      });
      await store.setPositionState(
        OWNER,
        AGENT_ID,
        "sell-row",
        "closed",
        undefined,
        "shift-depleted",
      );
      // The arm gate refuses on NON-CLOSED rows only, so a closed row leaves
      // every predicate: the one-live-token index, the one-live-sequence index,
      // the worker loop and the abandon path all already handle it.
      const rows = await store.listPositions(OWNER, AGENT_ID);
      assert.equal(rows.every((row) => row.state === "closed"), true);
      await store.close();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* D7 / R5.7 — restore-open filters the depleted row                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 D7/R5.7: restore-open never resurrects a closed row", () => {
  it("the abandon route's restore-open arm filters on `state !== \"closed\"`", () => {
    // D7's failure scenario: a shift pair goes one-sided (the buy row closed
    // `shift-depleted`); a later manual-exit on the SURVIVOR is abandoned while
    // its row is `closing`; the disposition is `restore-open`; and the
    // UNFILTERED group loop re-opens BOTH. The dormant row would come back
    // `open` holding the tokenId of an NFT the shift already emptied — the
    // worker dispatches it, the checks disagree, it takes two confirmations a
    // cycle apart to close again, and meanwhile the arm gate blocks a re-arm
    // the owner has no other way to reach.
    //
    // R5.7 chose the STATE filter over keying on `closeReason`: the state is
    // the property that matters ("this row was already closed, so restoring it
    // is inventing a position") and it is true of EVERY cause of closure, not
    // only depletion.
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    assert.match(
      source,
      /verdict\.positionAction === "restore-open"[\s\S]{0,3000}?if \(row\.state === "closed"\) continue;/u,
      "the restore-open arm must skip closed rows",
    );
    // The `close` arm takes NO STATE filter — closing a closed row is idempotent,
    // and closing is never the operation that invents state. What it DOES take,
    // since the 2026-09-03 stranding of NFT 7316794, is the KIND scope: a
    // group-wide close is right for the shift (one batch, both rungs) and wrong
    // for a manual-exit (one rung, no evidence about its sibling).
    assert.match(
      source,
      /const dispositionIds =[\s\S]{0,240}?verdict\.positionScope === "group"[\s\S]{0,120}?armGroupPositionIds[\s\S]{0,120}?\[sequence\.positionId\]/u,
      "the disposition must be scoped by the sequence kind, not applied group-wide by default",
    );
    assert.match(
      source,
      /verdict\.positionAction === "close"[\s\S]{0,600}?for \(const id of dispositionIds\)/u,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* D5 / D8 / R5.5 — the dynamic dispatcher and the absent sibling              */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 D5/R5.5: the dynamic dispatcher", () => {
  it("the BUY row dispatches while live; the SELL row when it is not; NEVER both", () => {
    // R2.3 point 3's "the anchor row is the ONLY dispatcher" is SUPERSEDED and
    // was the highest-risk superseded rule in the stack — it has no answer for
    // a pair whose buy row is gone, and all three ways for that to happen
    // (depletion, ownership loss, an owner's single-rung exit) are reachable.
    const dispatcherFor = (
      liveRoles: readonly ("buy" | "sell")[],
    ): "buy" | "sell" | undefined =>
      liveRoles.includes("buy")
        ? "buy"
        : liveRoles.includes("sell")
          ? "sell"
          : undefined;
    assert.equal(dispatcherFor(["buy", "sell"]), "buy");
    assert.equal(dispatcherFor(["sell"]), "sell", "the survivor dispatches");
    assert.equal(dispatcherFor(["buy"]), "buy");
    assert.equal(dispatcherFor([]), undefined, "a pair with no live row is over");
  });

  it("the evaluator gates its shift branch on the snapshot, and holds without one", () => {
    // An ABSENT snapshot is a HOLD BY OMISSION: a row that cannot see its pair
    // must not assume it is the one to move it.
    const source = readFileSync(
      new URL("../src/lp/gridTriggers.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /const group = input\.shiftGroupLiveRoles;/u);
    assert.match(source, /dispatcher === group\.role/u);
    assert.match(source, /group === undefined\s*\n\s*\? undefined/u);
  });

  it("D8: the sibling's evidence is read ONLY for a LIVE sibling", () => {
    // Closing a position DELETES its observation (three retention sites), and a
    // closed row is outside `listOpenPositionsForWorker` so it never writes
    // another. Worse, there is a window before the sweep in which the row still
    // exists and is STALE — counters computed against a range whose position no
    // longer exists — and a union trigger reading it would fire the surviving
    // row's motion on a DEAD rung's evidence.
    const worker = readFileSync(new URL("../src/lp/worker.ts", import.meta.url), "utf8");
    // The live-set loop IS the gate: a closed row `continue`s before the
    // observation read is reached.
    assert.match(
      worker,
      /if \(other\.state === "closed"\) continue;[\s\S]{0,400}?readObservation\(deps, state, other\)/u,
      "a closed sibling must never reach the observation read",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R2.27 (a)-(d) — the commissioned tests                                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 R2.27: the commissioned properties", () => {
  it("(a) the batch touches exactly THREE targets: NFPM, WBNB and the base token", () => {
    // Per-call preflight (`snapshotAllows`/`canExecute`) runs over every call,
    // so the batch's target SET is what a session must allow. Twelve calls
    // across three targets, and R6 states the custody consequence: every one is
    // already granted by the 3.19 `lpSessionSpec` — zero new selectors, zero
    // new caps.
    const sagas = readFileSync(new URL("../src/lp/sagas.ts", import.meta.url), "utf8");
    // The zero-reset pair targets the two TOKENS; the exits and mints target
    // the NFPM through the shared builders.
    assert.match(sagas, /buildApprove\(legs\.token, deps\.venue\.nfpm, 0n\)/u);
    assert.match(sagas, /buildApprove\(wbnb, deps\.venue\.nfpm, 0n\)/u);
    assert.match(sagas, /buildLpZapOutKeepWbnbBatch\(\{[\s\S]{0,400}?nfpm: deps\.venue\.nfpm/u);
    assert.match(sagas, /buildLpMintWbnbBatch\(\{[\s\S]{0,400}?nfpm: deps\.venue\.nfpm/u);
  });

  it("(b) a SUBMITTED-and-reverted shift consumes its lane slot and releases nothing", async () => {
    // R2.23's real bound, stated for the operator: a submitted-and-reverted
    // shift carries a `callsId`, so its reservation is NOT releasable — each
    // revert burns one `shiftsPerDay` slot. That is harsh and is said out loud
    // in the owner view rather than discovered.
    for (const backend of BACKENDS) {
      const store = await backend.make(() => START);
      await seedPosition(store, "p1");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "grid-shift",
      });
      await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, QUOTA);
      const before = await store.quotaUsage(OWNER, AGENT_ID);
      assert.equal(before.shiftLiveCount, 1);
      await store.close();
    }
  });

  it("(c)/(d) the group lock is enforced at the manual-exit ROUTE, not in driveSequence", () => {
    // R5.6 / D6 option (ii): `driveSequence` keeps its position-scoped conflict
    // check BYTE-IDENTICAL for every saga, and `buildSagaDeps` is untouched.
    // The route gate calls the predicate directly; the WORKER's half is the
    // resume-partition fold asserted by the A2 test below.
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    assert.match(server, /gridShiftGroupLock\(\{/u);
    assert.match(server, /SEQUENCE_CONFLICT: this position's shift ladder/u);
    const sagas = readFileSync(new URL("../src/lp/sagas.ts", import.meta.url), "utf8");
    assert.equal(
      /gridShiftGroupLock/u.test(sagas),
      false,
      "the lock must NOT enter driveSequence — D6 proved it is not evaluable there",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R2 — byte-identity of the three shipped modes                              */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 R2: the three shipped modes are untouched", () => {
  it("a non-shift grid's reachability refusal carries NO shift clause", () => {
    // The shift term is PRESENT-ONLY-WHEN-NONZERO in the sentence, the same
    // discipline `gridSettingsParamsView` applies to the block: a lane that
    // contributes zero must also contribute zero words, because the 3.19/3.20
    // suites pin these refusal texts verbatim.
    const grid = fixedTwin(shiftGrid({ wbnbIsToken0: false }), 24);
    try {
      validateLpSettings({
        ...settingsWith(grid),
        minMinutesBetweenExits: 120, // floor(1440/120) = 12 < 24
      });
      assert.fail("expected a reachability refusal");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      assert.match(message, /is unreachable/u);
      assert.equal(
        /grid\.shift\.shiftsPerDay/u.test(message),
        false,
        "a non-shift grid's sentence must be byte-identical to 3.20's",
      );
    }
  });

  it("gridCycleSubmissions answers 2 for a fixed grid, as it always has", () => {
    assert.equal(gridCycleSubmissions(fixedTwin(shiftGrid({ wbnbIsToken0: false }))), 2);
  });
});

/* -------------------------------------------------------------------------- */
/* §13.1 — THE ROUND-TRIP JOURNEY                                             */
/* -------------------------------------------------------------------------- */

/**
 * §13.1's commissioned journey: arm → cross UP (two finalized observations)
 * → shift → cross DOWN → shift.
 *
 * It is asserted at the TWO layers a shift actually spans, because no single
 * layer carries all four properties §13.1 names:
 *
 *  - the TRIGGER layer proves the two-observation hysteresis, that ONE decision
 *    is emitted for the PAIR in each direction, that BOTH targets ride the
 *    result, and that the GAP is preserved across a full round trip;
 *  - the STORE layer proves, on BOTH backends, that both tokenIds change
 *    TOGETHER (the finish's verify-both-then-write-both), that the pair keeps
 *    its `arm_group_id` and its roles across the round trip, and that exactly
 *    ONE sequence — and therefore one journal step row — exists per shift.
 *
 * A full saga journey would need a relay, a receipt reader and a session; the
 * saga's own crash and hold behaviour is covered by the D1/D4 arms above.
 * Nothing here is a live run. FINDINGS (bd) proves one DRIFT-caused atomic
 * shift on BNB mainnet at block 118951160; fill/cross settlement and grid flip
 * remain unproven live.
 */
describe("PHASE3.22 §13.1: the round-trip journey", () => {
  const INTERVAL_MS = 30_000;
  const POOL = getAddress("0x00000000000000000000000000000000000000EE");
  const RAILS = {
    maxPriceImpactBps: 10_000,
    maxSpotTwapDeviationBps: 10_000,
    minObservationCardinality: 1,
    minPoolLiquidity: 0n,
    twapWindowSec: 60,
    twapWindowSeconds: 60,
    maxSagaSlippageBps: 50,
  };

  function marketAt(blockNumber: bigint, tick: number) {
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

  /** One evaluator turn for one row of the pair. */
  function turn(input: {
    readonly grid: LpGridSettings;
    readonly role: "buy" | "sell";
    readonly range: { readonly tickLower: number; readonly tickUpper: number };
    readonly tick: number;
    readonly blockNumber: bigint;
    readonly nowMs: number;
    readonly noRole?: boolean;
    readonly bufferQuoteWei?: bigint;
    readonly bufferBaseWei?: bigint;
    readonly bufferNativeWei?: bigint;
    readonly previousObservation?: ReturnType<
      typeof evaluateGridTriggers
    >["nextObservation"];
    readonly liveRoles?: readonly ("buy" | "sell")[];
    readonly quotaUsage?: {
      readonly shiftLiveCount?: number;
      readonly shiftSettleLiveCount?: number;
      readonly shiftDriftLiveCount?: number;
      readonly latestReservedAtMs: number | null;
    };
    /** R7's UNION: the sibling's durable cross/drift evidence, when live. */
    readonly sibling?: {
      readonly role: "buy" | "sell";
      readonly gridCrossConsecutive: number;
      readonly gridDriftConsecutive: number;
      readonly gridRangeRelation?: "inside" | "outside";
    };
  }): ReturnType<typeof evaluateGridTriggers> {
    return evaluateGridTriggers({
      settingsDigest: "0xshift" as `0x${string}`,
      intervalMs: INTERVAL_MS,
      market: marketAt(input.blockNumber, input.tick),
      nowMs: input.nowMs,
      position: {
        basisWei: 0n,
        basisSource: "minted",
        collectibleFee0: 0n,
        collectibleFee1: 0n,
        currentTick: input.tick,
        exitValueWei: 10n ** 18n,
        freshFeesValueWei: 0n,
        poolAddress: POOL,
        token0: input.grid.pool.token0,
        token1: input.grid.pool.token1,
        fee: input.grid.pool.fee,
        tickLower: input.range.tickLower,
        tickUpper: input.range.tickUpper,
        tokenId: input.role === "buy" ? "111" : "222",
        gridLevel: input.noRole === true ? null : 1,
        gridRole: input.noRole === true ? null : input.role,
        // Both sides funded, so the funding conjunct never holds this journey
        // and what is under test is the TRIGGER, not the buffer.
        bufferQuoteWei: input.bufferQuoteWei ?? 10n ** 21n,
        bufferBaseWei: input.bufferBaseWei ?? 10n ** 21n,
        // GRID-GAS-RESERVE P2: the gas pot is funded here for the same reason —
        // the gate under test is the TRIGGER's, not the wallet's.
        bufferNativeWei: input.bufferNativeWei ?? 10n ** 18n,
      },
      ...(input.previousObservation === undefined
        ? {}
        : { previousObservation: input.previousObservation }),
      rails: RAILS,
      settings: {
        ...DEFAULT_LP_SETTINGS,
        minMinutesBetweenExits: 5,
        grid: input.grid,
      },
      relayFeePerSubmitWei: RELAY_FEE,
      shiftGroupLiveRoles: {
        role: input.role,
        liveRoles: input.liveRoles ?? ["buy", "sell"],
      },
      ...(input.sibling === undefined ? {} : { shiftSibling: input.sibling }),
      shiftQuotaUsage: input.quotaUsage ?? {
          shiftLiveCount: 0,
          shiftSettleLiveCount: 0,
          shiftDriftLiveCount: 0,
          latestReservedAtMs: null,
        },
    });
  }

  it("PHASE3.23 R2.1: mid-fill drift targets only the clean rung; clean drift targets both", () => {
    const grid = shiftGrid({ wbnbIsToken0: true, anchorTick: 0 });
    const tick = -25; // inside SELL, far outside BUY
    const first = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick,
      blockNumber: 100n,
      nowMs: START,
      sibling: {
        role: "sell",
        gridCrossConsecutive: 0,
        gridDriftConsecutive: 0,
        gridRangeRelation: "inside",
      },
    });
    const midfill = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick,
      blockNumber: 101n,
      nowMs: START + INTERVAL_MS,
      previousObservation: first.nextObservation,
      sibling: {
        role: "sell",
        gridCrossConsecutive: 0,
        gridDriftConsecutive: 0,
        gridRangeRelation: "inside",
      },
    });
    assert.equal(midfill.decision, "grid-shift");
    assert.equal(midfill.gridShiftCause, "drift");
    assert.ok(midfill.gridShiftTargets?.buyRange);
    assert.equal(midfill.gridShiftTargets?.sellRange, undefined);

    const unknown = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick,
      blockNumber: 101n,
      nowMs: START + INTERVAL_MS,
      previousObservation: first.nextObservation,
      sibling: { role: "sell", gridCrossConsecutive: 0, gridDriftConsecutive: 0 },
    });
    assert.equal(unknown.decision, "hold");
    assert.match(unknown.triggerReason.reason, /sell rung.*stale or unknown/u);

    const clean = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick,
      blockNumber: 102n,
      nowMs: START + 2 * INTERVAL_MS,
      previousObservation: first.nextObservation,
      sibling: {
        role: "sell",
        gridCrossConsecutive: 0,
        gridDriftConsecutive: 0,
        gridRangeRelation: "outside",
      },
    });
    assert.equal(clean.decision, "grid-shift");
    assert.ok(clean.gridShiftTargets?.buyRange);
    assert.ok(clean.gridShiftTargets?.sellRange);
  });

  it("PHASE3.25 R5.7: drift exhaustion is a HOLD before any sequence exists", () => {
    const grid = shiftGrid({ wbnbIsToken0: true, anchorTick: 0 });
    const tick = -25;
    const first = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick,
      blockNumber: 100n,
      nowMs: START,
      sibling: {
        role: "sell",
        gridCrossConsecutive: 0,
        gridDriftConsecutive: 0,
        gridRangeRelation: "inside",
      },
    });
    const held = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick,
      blockNumber: 101n,
      nowMs: START + INTERVAL_MS,
      previousObservation: first.nextObservation,
      sibling: {
        role: "sell",
        gridCrossConsecutive: 0,
        gridDriftConsecutive: 0,
        gridRangeRelation: "inside",
      },
      quotaUsage: {
        shiftLiveCount: 8,
        shiftSettleLiveCount: 0,
        shiftDriftLiveCount: 8,
        latestReservedAtMs: null,
      },
    });
    assert.equal(held.decision, "hold");
    assert.match(held.triggerReason.reason, /drift allowance spent/u);
    assert.match(held.triggerReason.reason, /NO sequence or reservation/u);
  });

  it("PHASE3.23 R2.5: an unfundable selected rung holds even when untouched funding is rich", () => {
    const grid = shiftGrid({ wbnbIsToken0: true, anchorTick: 0 });
    const first = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick: -25,
      blockNumber: 110n,
      nowMs: START,
      bufferQuoteWei: 0n,
      bufferBaseWei: 10n ** 21n,
      sibling: {
        role: "sell",
        gridCrossConsecutive: 0,
        gridDriftConsecutive: 0,
        gridRangeRelation: "inside",
      },
    });
    const held = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick: -25,
      blockNumber: 111n,
      nowMs: START + INTERVAL_MS,
      previousObservation: first.nextObservation,
      bufferQuoteWei: 0n,
      bufferBaseWei: 10n ** 21n,
      sibling: {
        role: "sell",
        gridCrossConsecutive: 0,
        gridDriftConsecutive: 0,
        gridRangeRelation: "inside",
      },
    });
    assert.equal(held.decision, "hold");
    assert.equal(held.gridShiftTargets, undefined);
    assert.match(held.triggerReason.reason, /selected buy rung cannot fund/u);
  });

  it("PHASE3.23 R2.8/R3.6: zero disables drift readiness but still emits relation", () => {
    const grid = shiftGrid({
      wbnbIsToken0: true,
      anchorTick: 0,
      shift: { ...SHIFT, driftPctOfGap: 0 },
    });
    const result = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick: -25,
      blockNumber: 101n,
      nowMs: START,
      sibling: {
        role: "sell",
        gridCrossConsecutive: 0,
        gridDriftConsecutive: 2,
        gridRangeRelation: "outside",
      },
    });
    assert.notEqual(result.decision, "grid-shift");
    assert.equal(result.nextObservation.gridRangeRelation, "outside");
    assert.equal(Object.hasOwn(result.nextObservation, "gridDriftConsecutive"), false);
    assert.equal(Object.hasOwn(result.nextObservation, "gridDriftSide"), false);
  });

  it("PHASE3.23 R3.6: fixed, policy, ladder and no-role observation bytes omit relation", () => {
    const shift = shiftGrid({ wbnbIsToken0: false });
    const fixed = fixedTwin(shift);
    const policy: LpGridSettings = {
      ...fixed,
      mode: "policy",
      policy: { gapTicks: 10, widthTicks: 10 },
      requote: { driftPctOfGap: 60, maxRequotesPerDay: 2 },
    };
    const ladder: LpGridSettings = {
      ...fixed,
      mode: "ladder",
      ladder: {
        gapTicks: 10,
        widthTicks: 10,
        deployPctBps: 3_000,
        driftPctOfGap: 60,
        settlementsPerDay: 2,
        driftMovesPerDay: 1,
        hedge: { enabled: false, minMarkoutBps: 0, maxHedgePctBps: 5_000 },
      },
    };
    for (const [name, grid] of [
      ["fixed", fixed],
      ["policy", policy],
      ["ladder", ladder],
    ] as const) {
      const result = turn({
        grid,
        role: "buy",
        range: grid.buyRange,
        tick: 0,
        blockNumber: 120n,
        nowMs: START,
      });
      assert.equal(
        Object.hasOwn(result.nextObservation, "gridRangeRelation"),
        false,
        `${name} observation bytes remain unchanged`,
      );
    }
    const noRole = turn({
      grid: shift,
      role: "buy",
      range: shift.buyRange,
      tick: 0,
      blockNumber: 121n,
      nowMs: START,
      noRole: true,
    });
    assert.equal(Object.hasOwn(noRole.nextObservation, "gridRangeRelation"), false);
  });

  it("TRIGGER: two observations arm a shift, ONE decision per direction, gap preserved", () => {
    const grid = shiftGrid({ wbnbIsToken0: false, anchorTick: 0 });
    const shift = grid.shift as LpGridShift;

    // ── CROSS UP. `gridDeriveRanges` at anchor 0 with gap 10 / width 10 puts
    // the sell rung at [20, 30); a tick at 40 is strictly past it, so the SELL
    // rung has filled.
    //
    // THE SELL ROW IS NOT THE DISPATCHER while the buy row is live (R4.2.4), so
    // its evidence accumulates in its OWN durable observation and the BUY row
    // acts on it through R7's UNION. Modelling it any other way would test a
    // machine this phase does not build — and the first draft of this test did
    // exactly that, which is how it found the flip branch firing for a shift
    // grid (the R2.18 conjunct now written at `priority 2`).
    const upTick = 40;
    const sellFirst = turn({
      grid,
      role: "sell",
      range: grid.sellRange,
      tick: upTick,
      blockNumber: 100n,
      nowMs: START,
    });
    assert.notEqual(sellFirst.decision, "grid-shift", "the sell row never dispatches here");
    const sellSecond = turn({
      grid,
      role: "sell",
      range: grid.sellRange,
      tick: upTick,
      blockNumber: 101n,
      nowMs: START + INTERVAL_MS,
      previousObservation: sellFirst.nextObservation,
    });
    // Its evidence is now READY — two consecutive finalized observations on the
    // same side — and it is recorded on its own observation row, not acted on.
    assert.equal(sellSecond.nextObservation.gridCrossConsecutive, 2);
    // A shift grid must NEVER emit a flip: the flip settles one level into the
    // opposite SIGNED range, which under shift mode is the ARM's geometry and
    // nothing a shift ever targets again.
    assert.notEqual(sellSecond.decision, "grid-flip", "a shift grid never flips");

    // ── THE BUY ROW, the pair's dispatcher, acting on the SIBLING's evidence.
    // One observation of its own is irrelevant: the union is what arms it.
    const first = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick: upTick,
      blockNumber: 100n,
      nowMs: START,
    });
    assert.notEqual(first.decision, "grid-shift", "no sibling evidence yet, no motion");

    const second = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick: upTick,
      blockNumber: 101n,
      nowMs: START + INTERVAL_MS,
      previousObservation: first.nextObservation,
      sibling: {
        role: "sell",
        gridCrossConsecutive: sellSecond.nextObservation.gridCrossConsecutive ?? 0,
        gridDriftConsecutive: 0,
      },
    });
    assert.equal(
      second.decision,
      "grid-shift",
      "EITHER row's ready evidence arms the pair — R7's union",
    );

    // BOTH targets ride the result (R8): a shift authorizes two mints and
    // persists both, so carrying one would leave the other to be re-derived at
    // a later tick on resume — 3.18's B4 defect doubled.
    const up = second.gridShiftTargets;
    assert.notEqual(up, undefined, "both targets must ride the decision");
    if (up === undefined) return;
    assert.ok(up.buyRange);
    assert.ok(up.sellRange);
    // THE GAP IS PRESERVED: both rungs come from the SAME anchor through the
    // SAME derivation, so the geometry the owner SIGNED survives the motion
    // rather than drifting with the price.
    assert.equal(up.buyRange.tickUpper - up.buyRange.tickLower, shift.widthTicks);
    assert.equal(up.sellRange.tickUpper - up.sellRange.tickLower, shift.widthTicks);
    assert.equal(up.sellRange.tickLower > upTick, true, "sell strictly above the tick");
    assert.equal(up.buyRange.tickUpper <= upTick, true, "buy strictly below the tick");

    // ── ONE DECISION FOR THE PAIR. With only the SELL row live, a BUY-role
    // evaluation must NOT emit a second motion: the dispatcher is the survivor,
    // and never both rows in one cycle.
    const notDispatcher = turn({
      grid,
      role: "buy",
      range: grid.buyRange,
      tick: upTick,
      blockNumber: 101n,
      nowMs: START + INTERVAL_MS,
      previousObservation: first.nextObservation,
      liveRoles: ["sell"],
    });
    assert.notEqual(
      notDispatcher.decision,
      "grid-shift",
      "a row that is not the live dispatcher must not emit a second motion",
    );

    // ── CROSS DOWN, off the FRESHLY PLACED rungs: the round trip's other half.
    const downTick = up.buyRange.tickLower - 20;
    const downFirst = turn({
      grid,
      role: "buy",
      range: up.buyRange,
      tick: downTick,
      blockNumber: 200n,
      nowMs: START + 10 * MINUTE,
    });
    const downSecond = turn({
      grid,
      role: "buy",
      range: up.buyRange,
      tick: downTick,
      blockNumber: 201n,
      nowMs: START + 10 * MINUTE + INTERVAL_MS,
      previousObservation: downFirst.nextObservation,
    });
    assert.equal(downSecond.decision, "grid-shift", "the return leg fires too");
    const down = downSecond.gridShiftTargets;
    if (down === undefined) return;
    assert.ok(down.buyRange);
    assert.ok(down.sellRange);
    // GAP PRESERVED ON THE RETURN LEG as well — the geometry is a property of
    // the SIGNED block, not of the path the price took to get here.
    assert.equal(down.buyRange.tickUpper - down.buyRange.tickLower, shift.widthTicks);
    assert.equal(down.sellRange.tickUpper - down.sellRange.tickLower, shift.widthTicks);
    assert.equal(down.buyRange.tickUpper <= downTick, true);
    assert.equal(down.sellRange.tickLower > downTick, true);
    // And the pair genuinely MOVED: the return leg's rungs are not the
    // outbound leg's.
    assert.notDeepEqual(down.buyRange, up.buyRange);
    assert.notDeepEqual(down.sellRange, up.sellRange);
  });

  for (const backend of BACKENDS) {
    it(`STORE (${backend.name}): both tokenIds change TOGETHER, one sequence per shift`, async () => {
      let clock = START;
      const store = await backend.make(() => clock);
      await seedPosition(store, "buy-row", {
        armGroupId: "group-1",
        gridRole: "buy",
        tokenId: "111",
      });
      await seedPosition(store, "sell-row", {
        armGroupId: "group-1",
        gridRole: "sell",
        tokenId: "222",
      });

      /** One shift: the sequence, its ONE step, and the finish's paired writes. */
      const shiftOnce = async (
        buyTokenId: string,
        sellTokenId: string,
      ): Promise<string> => {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: "buy-row",
          kind: "grid-shift",
          targetRange: { tickLower: -30, tickUpper: -20 },
          targetSellRange: { tickLower: 20, tickUpper: 30 },
        });
        // BOTH targets are durable before anything could submit (R8).
        assert.equal(sequence.targetTickLower, -30);
        assert.equal(sequence.targetSellTickUpper, 30);
        await store.appendStep(OWNER, AGENT_ID, sequence.sequenceId, {
          kind: "grid-shift",
          journalIdempotencyKey: `key-${sequence.sequenceId}`,
        });
        // The finish's writes, both in the step's `after`: VERIFY BOTH, then
        // WRITE BOTH. The sell mint is FIRST in the pinned batch, so
        // `sellTokenId < buyTokenId` holds — the only guard against attaching
        // the sell NFT to the buy row.
        assert.equal(BigInt(sellTokenId) < BigInt(buyTokenId), true);
        await store.updatePositionTokenId(OWNER, AGENT_ID, "sell-row", sellTokenId);
        await store.updatePositionTokenId(OWNER, AGENT_ID, "buy-row", buyTokenId);
        await store.setSequenceState(OWNER, AGENT_ID, sequence.sequenceId, "completed");
        return sequence.sequenceId;
      };

      // ── SHIFT 1 (the cross-up leg) ──────────────────────────────────────
      const firstId = await shiftOnce("334", "333");
      const afterFirst = await store.listPositions(OWNER, AGENT_ID);
      const buy1 = afterFirst.find((row) => row.gridRole === "buy");
      const sell1 = afterFirst.find((row) => row.gridRole === "sell");
      // BOTH changed and neither kept its old NFT — the whole point of an
      // atomic motion is that there is no state where one moved and one did not.
      assert.equal(buy1?.tokenId, "334");
      assert.equal(sell1?.tokenId, "333");
      // The pair is still a pair: same group, roles INVARIANT (the shift's
      // finish passes no `gridRole` argument, ever).
      assert.equal(buy1?.armGroupId, "group-1");
      assert.equal(sell1?.armGroupId, "group-1");
      assert.equal(buy1?.gridLevel, 1);
      assert.equal(sell1?.gridLevel, 1);

      // ── SHIFT 2 (the cross-down leg) ────────────────────────────────────
      clock += 10 * MINUTE;
      const secondId = await shiftOnce("556", "555");
      const afterSecond = await store.listPositions(OWNER, AGENT_ID);
      assert.equal(afterSecond.find((row) => row.gridRole === "buy")?.tokenId, "556");
      assert.equal(afterSecond.find((row) => row.gridRole === "sell")?.tokenId, "555");

      // ONE SEQUENCE PER SHIFT, and therefore ONE journal step row per shift:
      // the plan is `["grid-shift"]`, so two round-trip legs are two sequences
      // and two recorded steps — never one sequence driving both, never three.
      assert.notEqual(firstId, secondId);
      const shifts = (await store.listSequences(OWNER, AGENT_ID)).filter(
        (row) => row.kind === "grid-shift",
      );
      assert.equal(shifts.length, 2, "exactly one sequence per shift");
      for (const row of shifts) {
        assert.equal(row.steps.length, 1, "exactly one step per shift");
        assert.equal(row.steps[0]?.kind, "grid-shift");
      }
      await store.close();
    });
  }
});

/* -------------------------------------------------------------------------- */
/* §9 / R2.4 / C11 / R3.2 point 3 — the owner view                            */
/* -------------------------------------------------------------------------- */

describe("PHASE3.22 §9: the owner view's shift block", () => {
  const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

  it("R2.4/P7: the SIBLING's blocker is derived from the ARM GROUP, mode-first", () => {
    // `blockingOf` is POSITION-scoped and finds NOTHING for the sibling of a
    // row whose shift is in flight — a shift is ONE sequence moving TWO
    // positions. Without the group derivation a held shift would show the
    // anchor blocked and the sibling perfectly free.
    assert.match(source, /const groupBlockingOf = /u);
    assert.match(source, /sequence\.kind === "grid-shift"/u);
    // MODE FIRST through the shared predicate, so a LADDER pair — which also
    // carries `arm_group_id` — keeps its per-row lookup byte-identical.
    assert.match(
      source,
      /if \(!gridShiftGroupLock\(\{ grid, armGroupId: position\.armGroupId \}\)\) return null;/u,
    );
  });

  it("R2.4/M10: the doubled blast radius is stated, not left to inference", () => {
    assert.match(source, /priceStopDisarmed/u);
    assert.match(
      source,
      /disarms the price stop on BOTH rungs of this pair[\s\S]{0,120}?twice the blast radius/u,
    );
  });

  it("C11: the two revert paths read DIFFERENTLY — slot burned vs nothing burned", () => {
    // A bricked agent and a busy one must not look the same.
    assert.match(source, /submittedAndRevertedSettle:[\s\S]{0,200}?burned ONE settlement slot/u);
    assert.match(source, /submittedAndRevertedDrift:[\s\S]{0,200}?burned ONE drift motion/u);
    assert.match(source, /builtAndRolledBack:[\s\S]{0,120}?burned NOTHING/u);
  });

  it("R3.2 point 3: the true sentence is in the view — the THIRD of three places", () => {
    // The client transcript and the abandon note are the other two.
    assert.match(source, /A shift has NO in-plane resolver by design/u);
    assert.match(source, /freezes BOTH rungs and disarms BOTH price stops/u);
    assert.match(source, /CLOSES both rows of the pair so you can re-arm/u);
  });

  it("§9: lanes, two-sidedness and the three one-sided causes are reported", () => {
    assert.match(source, /shiftsPerDay: shift\.shiftsPerDay/u);
    assert.match(source, /shiftsUsed: input\.quota\?\.shiftSettleLiveCount \?\? null/u);
    // R4.2.4's three causes, distinguished by the marker the closing path wrote.
    assert.match(source, /\("depleted" as const\)/u);
    assert.match(source, /\("ownership-lost" as const\)/u);
    assert.match(source, /\("owner-exited" as const\)/u);
    // The buffer is reported for a shift pair too — it is what funds the next
    // motion, and an owner who cannot see it cannot tell a hold from a bug.
    assert.match(source, /grid\.ladder === undefined && grid\.shift === undefined/u);
  });

  it("a shift pair's levels are partitioned by ROLE, not by level", () => {
    // Both rows carry `gridLevel: 1` (two rows, ONE pair), so a reader grouping
    // by level would collapse a two-sided shift ladder into one bucket.
    assert.match(
      source,
      /gridModeOf\(grid\) === "ladder" \|\| gridModeOf\(grid\) === "shift"\s*\n\s*\? \("role" as const\)/u,
    );
  });
});

describe("PHASE3.23 R3.5: owner-view pair geometry", () => {
  const currentPositions = [
    { positionId: "buy-current", armGroupId: "group-current" },
    { positionId: "sell-current", armGroupId: "group-current" },
    { positionId: "buy-old", armGroupId: "group-old" },
  ] as const;
  const oldGroupMotion = {
    kind: "grid-shift",
    state: "completed",
    positionId: "buy-old",
    targetTickLower: -120,
    targetTickUpper: -60,
    targetSellTickLower: null,
    targetSellTickUpper: null,
    updatedAt: START + 500,
  } as const;
  const oneTargetMotion = {
    kind: "grid-shift",
    state: "completed",
    positionId: "buy-current",
    targetTickLower: -120,
    targetTickUpper: -60,
    targetSellTickLower: null,
    targetSellTickUpper: null,
    updatedAt: START + 200,
  } as const;
  const twoTargetMotion = {
    kind: "grid-shift",
    state: "completed",
    positionId: "sell-current",
    targetTickLower: -180,
    targetTickUpper: -120,
    targetSellTickLower: 120,
    targetSellTickUpper: 180,
    updatedAt: START + 300,
  } as const;

  it("isolates re-arms and reconstructs the latest one-target shape after restart", () => {
    assert.deepEqual(
      lpShiftPairGeometry(currentPositions, [oldGroupMotion], "group-current"),
      { state: "symmetric" },
      "a newer motion from an old arm group cannot leak into this arm",
    );
    const expected = {
      state: "asymmetric-midfill",
      movedRole: "buy",
      since: START + 200,
      reason: "A drift shift moved only the clean rung while its sibling was mid-fill.",
    } as const;
    assert.deepEqual(
      lpShiftPairGeometry(
        currentPositions,
        [oldGroupMotion, oneTargetMotion],
        "group-current",
      ),
      expected,
    );
    assert.deepEqual(
      lpShiftPairGeometry(
        currentPositions,
        [oldGroupMotion, oneTargetMotion],
        "group-current",
      ),
      expected,
      "the result is reconstructed entirely from persisted rows after restart",
    );
  });

  it("clears asymmetry when the latest completed shift targets both rungs", () => {
    assert.deepEqual(
      lpShiftPairGeometry(
        currentPositions,
        [oldGroupMotion, oneTargetMotion, twoTargetMotion],
        "group-current",
      ),
      { state: "symmetric" },
    );
  });
});

describe("PHASE3.22 §8: the client's shift width default", () => {
  const source = readFileSync(
    new URL("../scripts/live-grid.ts", import.meta.url),
    "utf8",
  );

  it("width defaults to exactly ONE tick spacing under shift mode", () => {
    // The 40 h census found EVERY observed placement carrying exactly one bin
    // id, so the preset supplies the GAP only and the rung is one spacing wide.
    assert.match(source, /const shiftModeForWidth =/u);
    assert.match(source, /\? \{ ticks: spacing, clamped: false \}/u);
  });

  it("--width-ticks overrides it and is quantized UP like every other tick value", () => {
    assert.match(source, /const widthTicksFlag = flags\.get\("width-ticks"\);/u);
    assert.match(
      source,
      /gridQuantizeUpToSpacing\(Number\.parseInt\(widthTicksFlag, 10\), spacing\)/u,
    );
    // The existing wider-than-the-preset warning is preserved for both paths.
    assert.match(source, /gap\.clamped \|\| width\.clamped/u);
  });

  it("PHASE3.23 R2.11: drift-off conflicts before signing and every transcript shape is distinct", () => {
    assert.match(source, /flags\.has\("drift-off"\) && flags\.has\("drift-pct"\)/u);
    assert.match(source, /--drift-off conflicts with --drift-pct/u);
    assert.match(source, /const drift = flags\.has\("drift-off"\)\s*\? 0/u);
    assert.match(source, /cross[\s\S]{0,120}?12 calls/u);
    assert.match(source, /clean drift[\s\S]{0,120}?12 calls/u);
    assert.match(source, /mid-fill[\s\S]{0,160}?7 calls/u);
    assert.match(source, /stale peer[\s\S]{0,160}?HOLD/u);
    assert.match(source, /driftGasBudgetWei/u);
    assert.match(source, /driftPerMotionWei/u);
    assert.match(source, /--drift-pct 60 \| --drift-off/u);
  });

  it("PHASE3.23 R2.11: a one-rung confirmation never claims both positions move", () => {
    assert.doesNotMatch(
      source,
      /mid-fill[^\n]{0,180}(?:both positions|BOTH positions)/u,
    );
    assert.match(source, /mid-fill[^\n]{0,180}(?:one clean rung|7 calls)/u);
  });
});

/* -------------------------------------------------------------------------- */
/* GRID-GAS-RESERVE P2 — the shift lane's gas gate                            */
/* -------------------------------------------------------------------------- */

describe("GRID-GAS-RESERVE P2: gridShiftGasGate holds a shift the relay could not be paid for", () => {
  const FEE = 38_800_000_000_000n; // the live .env unit, 0.0000388 BNB
  const REQUIRED = BigInt(MAX_SUBMISSIONS_PER_GRID_SHIFT) * FEE;

  it("requires MAX_SUBMISSIONS_PER_GRID_SHIFT fee units — the sizing constant, so gate and sizing agree", () => {
    const gate = gridShiftGasGate({ nativeWei: REQUIRED, relayFeePerSubmitWei: FEE });
    assert.equal(gate.hold, false);
    assert.equal(gate.requiredWei, REQUIRED);
    assert.equal(gate.shortfallWei, 0n);
  });

  it("holds on the 2026-09-03 incident figure: 0.000098693 BNB against the metered shift", () => {
    const gate = gridShiftGasGate({ nativeWei: 98_693_148_720_024n, relayFeePerSubmitWei: FEE });
    assert.equal(gate.hold, true);
    assert.equal(gate.shortfallWei, REQUIRED - 98_693_148_720_024n);
    const text = lpGridShiftGasHoldReason(gate);
    assert.match(text, /^Shift ladder holds: deposit >= 0\.0000565 BNB/u, "the remedy leads, in BNB");
    assert.match(text, /needs 0\.0001552 BNB \(155200000000000 wei\)/u, "the required figure, exact");
    assert.match(text, /holds 0\.0000986 BNB/u, "the wallet's own figure");
    assert.match(sanitizeMessage(text), /deposit >= /u, "the remedy must survive the 280-char cap");
  });

  it("fails CLOSED on an unread pot and on an absent fee constant", () => {
    const unread = gridShiftGasGate({ nativeWei: undefined, relayFeePerSubmitWei: FEE });
    assert.equal(unread.hold, true);
    assert.equal(unread.nativeWei, null);
    assert.match(lpGridShiftGasHoldReason(unread), /could not be read/u);
    const noFee = gridShiftGasGate({ nativeWei: 10n ** 18n, relayFeePerSubmitWei: undefined });
    assert.equal(noFee.hold, true);
    assert.equal(noFee.requiredWei, null);
    assert.match(lpGridShiftGasHoldReason(noFee), /LP_RELAY_FEE_PER_SUBMIT_WEI/u);
    assert.equal(gridShiftGasGate({ nativeWei: 10n ** 18n, relayFeePerSubmitWei: 0n }).hold, true);
  });

  it("one wei under the line holds; the line itself passes", () => {
    assert.equal(gridShiftGasGate({ nativeWei: REQUIRED - 1n, relayFeePerSubmitWei: FEE }).hold, true);
    assert.equal(gridShiftGasGate({ nativeWei: REQUIRED, relayFeePerSubmitWei: FEE }).hold, false);
  });

  it("is wired into the shift branch BEFORE the funding conjunct, on the worker's native read", () => {
    // Pinned at the text level like N6: the hazard is a later edit reordering
    // the two gates or dropping the native read while every unit test stays green.
    const source = readFileSync(new URL("../src/lp/gridTriggers.ts", import.meta.url), "utf8");
    // CRLF-tolerant: the working tree may carry either line ending.
    const gate = source.search(/gridShiftGasGate\(\{\r?\n\s+nativeWei: position\.bufferNativeWei,/u);
    const funding = source.search(/const funding = gridShiftFunding\(\{\r?\n\s+deployPctBps: shift\.deployPctBps,/u);
    assert.notEqual(gate, -1, "the gate call site must read position.bufferNativeWei");
    assert.notEqual(funding, -1);
    assert.equal(gate < funding, true, "gas gate first, funding conjunct second");
    const worker = readFileSync(new URL("../src/lp/worker.ts", import.meta.url), "utf8");
    assert.match(worker, /bufferNativeWei = await nativeOf\(context\.agent\.walletAddress\)/u, "the worker reads the pot through readers.walletNativeBalance");
  });
});
