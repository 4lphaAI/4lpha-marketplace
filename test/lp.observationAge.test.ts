/**
 * The staleness bound, the comparability conjunct it adds, and the ONE
 * definition of "is protection armed" (PHASE3.2 Rev2 items 18–27).
 *
 * Kept in its own file so `test/lp.triggers.test.ts` — the truth table this
 * phase must not disturb — passes byte-for-byte unmodified. The pin that the
 * new conjunct is INERT for that suite lives here (`INERT_PIN`), so a future
 * change to the constant fails loudly in the file that owns the constant.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LP_SETTINGS,
  evaluateLpTriggers,
  lpMaxObservationAgeMs,
  lpProtectionStatus,
  LP_ARMED_REASON,
  LP_BASIS_ZERO_HOLD_REASON,
  LP_DIGEST_UNVERIFIED_REASON,
  LP_MAX_OBSERVATION_AGE_CEILING_MS,
  LP_MIN_OBSERVATION_AGE_MS,
  LP_NO_PROTECT_CONFIGURED_REASON,
  LP_NO_TOKEN_ID_REASON,
  LP_STALE_OBSERVATION_HOLD_REASON,
  type EvaluateLpTriggersInput,
  type EvaluateLpTriggersResult,
  type LpAutomationSettings,
  type LpTriggerObservation,
  type LpTriggerPositionInput,
} from "../src/lp/triggers.js";
import { resolveLpMaxObservationAgeMs } from "../src/lp/worker.js";
import type { LpRailConfig, LpRailEvidence } from "../src/lp/rails.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";

const POOL = "0x1111111111111111111111111111111111111111" as const;
const OTHER_POOL = "0x2222222222222222222222222222222222222222" as const;
const ONE = 10n ** 18n;
const INTERVAL = 60_000;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 100,
  maxSpotTwapDeviationBps: 100,
  minObservationCardinality: 8,
  minPoolLiquidity: 10_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 500,
};

type Overrides = {
  market?: Partial<LpRailEvidence>;
  position?: Partial<LpTriggerPositionInput>;
  settings?: Partial<LpAutomationSettings>;
  nowMs?: number;
  previousObservation?: LpTriggerObservation;
  maxObservationAgeMs?: number;
};

function makeInput(overrides: Overrides = {}): EvaluateLpTriggersInput {
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
    basisSource: "owner-budget",
    collectibleFee0: 0n,
    collectibleFee1: 0n,
    currentTick: 0,
    // 20% below basis: a stop-loss breach at stopLossPct 10.
    exitValueWei: 8n * ONE,
    freshFeesValueWei: 0n,
    poolAddress: POOL,
    token0: "0x1111111111111111111111111111111111111111",
    token1: "0x2222222222222222222222222222222222222222",
    fee: 2500,
    tickLower: -100,
    tickUpper: 100,
    tokenId: "7",
    ...overrides.position,
  };
  const settings: LpAutomationSettings = {
    ...DEFAULT_LP_SETTINGS,
    stopLossPct: 10,
    ...overrides.settings,
  };
  return {
    intervalMs: INTERVAL,
    market,
    nowMs: overrides.nowMs ?? 1_000_000,
    position,
    ...(overrides.previousObservation === undefined
      ? {}
      : { previousObservation: overrides.previousObservation }),
    ...(overrides.maxObservationAgeMs === undefined
      ? {}
      : { maxObservationAgeMs: overrides.maxObservationAgeMs }),
    rails: RAILS,
    settings,
  };
}

/** A second look, `gapMs` later, at a strictly newer finalized block. */
function nextLook(
  first: EvaluateLpTriggersResult,
  gapMs: number,
  overrides: Overrides = {},
): EvaluateLpTriggersInput {
  return makeInput({
    ...overrides,
    market: {
      blockNumber: 101n,
      finalizedBlockNumber: 101n,
      ...overrides.market,
    },
    nowMs: first.nextObservation.evaluatedAtMs + gapMs,
    previousObservation: first.nextObservation,
  });
}

/* -------------------------------------------------------------------------- */
/* The bound itself                                                           */
/* -------------------------------------------------------------------------- */

describe("lpMaxObservationAgeMs (Rev2 item 21)", () => {
  it("golden vectors at 30 s / 60 s / 600 s", () => {
    // 3 x interval, floored at 5 minutes and capped at 30 minutes.
    assert.equal(lpMaxObservationAgeMs(30_000), 300_000);
    assert.equal(lpMaxObservationAgeMs(60_000), 300_000);
    assert.equal(lpMaxObservationAgeMs(120_000), 360_000);
    assert.equal(lpMaxObservationAgeMs(600_000), 1_800_000);
    assert.equal(LP_MIN_OBSERVATION_AGE_MS, 300_000);
    assert.equal(LP_MAX_OBSERVATION_AGE_CEILING_MS, 1_800_000);
  });

  it("the ceiling holds even if the interval band is ever widened", () => {
    assert.equal(lpMaxObservationAgeMs(3_600_000), LP_MAX_OBSERVATION_AGE_CEILING_MS);
  });

  it("the override is LOWER-ONLY: it can shrink the bound, never widen it", () => {
    assert.equal(lpMaxObservationAgeMs(60_000, 120_000), 120_000);
    assert.equal(lpMaxObservationAgeMs(60_000, 900_000), 300_000, "raise refused");
    assert.equal(lpMaxObservationAgeMs(60_000, 0), 300_000);
    assert.equal(lpMaxObservationAgeMs(60_000, Number.NaN), 300_000);
  });

  /**
   * The 5-minute FLOOR is load-bearing, and this is the measurement that says
   * so: the widest `previousObservation` gap in `test/lp.triggers.test.ts` is
   * 240 000 ms (`:391-403`, a 5-minute rotate min-hold at a 60 s interval). A
   * pure `3 x intervalMs` bound would be 180 000 ms and would turn that
   * suite's `rotate` into a `hold`.
   */
  it("INERT_PIN: the widest gap in the untouched trigger suite is under the bound", () => {
    const WIDEST_EXISTING_GAP_MS = 240_000;
    assert.ok(
      WIDEST_EXISTING_GAP_MS <= lpMaxObservationAgeMs(60_000),
      "the staleness conjunct is no longer inert for test/lp.triggers.test.ts",
    );
    assert.ok(
      WIDEST_EXISTING_GAP_MS > 3 * 60_000,
      "the floor stopped being load-bearing; re-read Rev2 item 21 before removing it",
    );
  });
});

describe("resolveLpMaxObservationAgeMs: boot validation (Rev2 item 22)", () => {
  it("absent ⇒ undefined; a lower value passes through", () => {
    assert.equal(resolveLpMaxObservationAgeMs({}, 60_000), undefined);
    assert.equal(
      resolveLpMaxObservationAgeMs({ LP_MAX_OBSERVATION_AGE_MS: "120000" }, 60_000),
      120_000,
    );
    assert.equal(
      resolveLpMaxObservationAgeMs({ LP_MAX_OBSERVATION_AGE_MS: "300000" }, 60_000),
      300_000,
    );
  });

  it("a value ABOVE the derived bound refuses the BOOT, never a request", () => {
    assert.throws(
      () =>
        resolveLpMaxObservationAgeMs(
          { LP_MAX_OBSERVATION_AGE_MS: "300001" },
          60_000,
        ),
      /LOWER-ONLY/u,
    );
  });

  it("a malformed value refuses the boot", () => {
    for (const raw of ["abc", "-1", "0", "1.5"]) {
      assert.throws(
        () => resolveLpMaxObservationAgeMs({ LP_MAX_OBSERVATION_AGE_MS: raw }, 60_000),
        /LP_MAX_OBSERVATION_AGE_MS/u,
        raw,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The conjunct inside the evaluator                                          */
/* -------------------------------------------------------------------------- */

describe("a stale previous observation is DISCARDED, not trusted (Rev2 item 18)", () => {
  it("two looks one interval apart confirm a protect", () => {
    const first = evaluateLpTriggers(makeInput());
    assert.equal(first.decision, "hold");
    assert.equal(first.nextObservation.protectConsecutive, 1);
    const second = evaluateLpTriggers(nextLook(first, INTERVAL));
    assert.equal(second.decision, "protect-stop-loss");
  });

  it("a look BEYOND the bound restarts the count, says why, and is not silent", () => {
    const first = evaluateLpTriggers(makeInput());
    const stale = evaluateLpTriggers(nextLook(first, 300_001));
    assert.equal(stale.decision, "hold");
    assert.equal(stale.nextObservation.protectConsecutive, 1, "the count RESTARTED");
    assert.equal(stale.holdReason, LP_STALE_OBSERVATION_HOLD_REASON);
    assert.equal(stale.triggerReason.previousObservationDiscarded, "stale");
    assert.equal(stale.triggerReason.reason, LP_STALE_OBSERVATION_HOLD_REASON);

    // ...and one more pair under the bound confirms, so a single outage costs
    // exactly one extra cycle — never a decision that cannot be reached.
    const confirmed = evaluateLpTriggers(
      makeInput({
        market: { blockNumber: 102n, finalizedBlockNumber: 102n },
        nowMs: stale.nextObservation.evaluatedAtMs + INTERVAL,
        previousObservation: stale.nextObservation,
      }),
    );
    assert.equal(confirmed.decision, "protect-stop-loss");
    assert.equal(confirmed.triggerReason.previousObservationDiscarded, undefined);
  });

  it("EXACTLY at the bound is still comparable; one millisecond past is not", () => {
    const first = evaluateLpTriggers(makeInput());
    assert.equal(evaluateLpTriggers(nextLook(first, 300_000)).decision, "protect-stop-loss");
    assert.equal(evaluateLpTriggers(nextLook(first, 300_001)).decision, "hold");
  });

  it("the lower-only override tightens the discard", () => {
    const first = evaluateLpTriggers(makeInput({ maxObservationAgeMs: 120_000 }));
    const inside = evaluateLpTriggers(
      nextLook(first, 120_000, { maxObservationAgeMs: 120_000 }),
    );
    assert.equal(inside.decision, "protect-stop-loss");
    const outside = evaluateLpTriggers(
      nextLook(first, 120_001, { maxObservationAgeMs: 120_000 }),
    );
    assert.equal(outside.decision, "hold");
    assert.equal(outside.triggerReason.previousObservationDiscarded, "stale");
  });

  it("a tokenId change (a rotation) and a poolAddress change each discard", () => {
    const first = evaluateLpTriggers(makeInput());
    const rotated = evaluateLpTriggers(
      nextLook(first, INTERVAL, { position: { tokenId: "8" } }),
    );
    assert.equal(rotated.decision, "hold");
    assert.equal(rotated.nextObservation.protectConsecutive, 1);
    // Not "stale": a different position is a different subject, not an old one.
    assert.equal(rotated.triggerReason.previousObservationDiscarded, undefined);

    const movedPool = evaluateLpTriggers(
      nextLook(first, INTERVAL, { position: { poolAddress: OTHER_POOL } }),
    );
    assert.equal(movedPool.decision, "hold");
    assert.equal(movedPool.nextObservation.protectConsecutive, 1);
  });

  it("the same finalized block twice is still ONE look", () => {
    const first = evaluateLpTriggers(makeInput());
    const sameBlock = evaluateLpTriggers(
      makeInput({
        nowMs: first.nextObservation.evaluatedAtMs + INTERVAL,
        previousObservation: first.nextObservation,
      }),
    );
    assert.equal(sameBlock.decision, "hold");
  });
});

/* -------------------------------------------------------------------------- */
/* The rotate min-hold widening, pinned in BOTH directions (Rev2 item 25)     */
/* -------------------------------------------------------------------------- */

describe("rotate's min-hold clock across a process gap", () => {
  const rotateSettings: Partial<LpAutomationSettings> = {
    autoRotate: true,
    rotateMinHoldMinutes: 3,
    stopLossPct: 0,
  };
  const outOfRange: Overrides = {
    position: { currentTick: 150, exitValueWei: 10n * ONE },
    market: {
      spotSqrtPriceX96: getSqrtRatioAtTick(150),
      twapSqrtPriceX96: getSqrtRatioAtTick(150),
    },
    settings: rotateSettings,
  };

  it("CARRIES `rotationBreachStartedAtMs` across a gap UNDER the bound — deliberately widened", () => {
    const first = evaluateLpTriggers(makeInput(outOfRange));
    assert.equal(first.nextObservation.rotationBreachStartedAtMs, 1_000_000);
    // A 4-minute gap: under the 5-minute bound, so the breach start survives
    // and the 3-minute min-hold is satisfied from a breach that began BEFORE
    // the gap — over a window in which nothing was observed. Today a restart
    // resets it. This LOOSENS a churn control on purpose; the staleness bound
    // is the only thing limiting it, which is why it is a safety constant.
    const second = evaluateLpTriggers(nextLook(first, 240_000, outOfRange));
    assert.equal(second.nextObservation.rotationBreachStartedAtMs, 1_000_000);
    assert.equal(second.decision, "rotate");
  });

  it("RESTARTS it across a gap OVER the bound", () => {
    const first = evaluateLpTriggers(makeInput(outOfRange));
    const second = evaluateLpTriggers(nextLook(first, 300_001, outOfRange));
    assert.equal(second.decision, "hold");
    assert.equal(second.holdReason, LP_STALE_OBSERVATION_HOLD_REASON);
    assert.equal(second.nextObservation.rotationConsecutive, 1);
    assert.equal(
      second.nextObservation.rotationBreachStartedAtMs,
      first.nextObservation.evaluatedAtMs + 300_001,
      "the min-hold clock restarted at the fresh look",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* lpProtectionStatus — ONE definition of "armed" (Rev2 items 26/27)          */
/* -------------------------------------------------------------------------- */

describe("lpProtectionStatus", () => {
  const armedSettings: LpAutomationSettings = {
    ...DEFAULT_LP_SETTINGS,
    stopLossPct: 5,
  };
  const observation: LpTriggerObservation = {
    blockNumber: 100n,
    evaluatedAtMs: 1_000_000,
    poolAddress: POOL,
    protectBreach: "stop-loss",
    protectConsecutive: 1,
    rotationBreach: false,
    rotationConsecutive: 0,
    tokenId: "7",
  };
  const base = {
    settings: armedSettings,
    settingsReadable: true,
    digestVerified: true,
    basisWei: 10n * ONE,
    hasTokenId: true,
    observation,
    nowMs: 1_060_000,
    intervalMs: INTERVAL,
  };

  it("reports armed with the age, the count and the eligibility instant", () => {
    const status = lpProtectionStatus(base);
    assert.equal(status.armed, true);
    assert.equal(status.reason, LP_ARMED_REASON);
    assert.equal(status.stopLossPct, 5);
    assert.equal(status.takeProfitPct, 0);
    assert.equal(status.observationHeldAtMs, 1_000_000);
    assert.equal(status.observationAgeMs, 60_000);
    assert.equal(status.observationStale, false);
    assert.equal(status.protectConsecutive, 1);
    assert.equal(status.confirmationEligibleAtMs, 1_060_000);
    assert.equal(status.maxObservationAgeMs, 300_000);
  });

  it("reports a held observation that has gone STALE — the crash-loop residual", () => {
    // A worker restarting on a gap longer than the bound discards on every
    // restart and the protect never fires: (ae) surviving its own fix. It
    // reads armed, so the STALENESS is what must be visible.
    const status = lpProtectionStatus({ ...base, nowMs: 1_000_000 + 300_001 });
    assert.equal(status.armed, true);
    assert.equal(status.observationStale, true);
    assert.equal(status.observationAgeMs, 300_001);
  });

  it("no observation held ⇒ nothing to confirm against, and it says so", () => {
    const status = lpProtectionStatus({ ...base, observation: null });
    assert.equal(status.armed, true);
    assert.equal(status.observationHeldAtMs, null);
    assert.equal(status.observationAgeMs, null);
    assert.equal(status.observationStale, false);
    assert.equal(status.protectConsecutive, 0);
    assert.equal(status.confirmationEligibleAtMs, null);
  });

  it("is FALSE for each of the four today-silent disarm conditions", () => {
    const noProtect = lpProtectionStatus({
      ...base,
      settings: { ...DEFAULT_LP_SETTINGS, stopLossPct: 0, takeProfitPct: 0 },
    });
    assert.equal(noProtect.armed, false);
    assert.equal(noProtect.reason, LP_NO_PROTECT_CONFIGURED_REASON);

    const zeroBasis = lpProtectionStatus({ ...base, basisWei: 0n });
    assert.equal(zeroBasis.armed, false);
    assert.equal(zeroBasis.reason, LP_BASIS_ZERO_HOLD_REASON);

    // The digest path: the worker skips this position EVERY cycle, silently,
    // and until PHASE3.2 nothing an owner could query reported it.
    const badDigest = lpProtectionStatus({
      ...base,
      settings: null,
      digestVerified: false,
    });
    assert.equal(badDigest.armed, false);
    assert.equal(badDigest.reason, LP_DIGEST_UNVERIFIED_REASON);
    assert.equal(badDigest.stopLossPct, null);

    const unreadable = lpProtectionStatus({
      ...base,
      settings: null,
      settingsReadable: false,
    });
    assert.equal(unreadable.armed, false);
    assert.match(unreadable.reason, /unreadable/u);

    const noTokenId = lpProtectionStatus({ ...base, hasTokenId: false });
    assert.equal(noTokenId.armed, false);
    assert.equal(noTokenId.reason, LP_NO_TOKEN_ID_REASON);
  });

  it("the digest failure outranks every other reason", () => {
    const status = lpProtectionStatus({
      ...base,
      settings: null,
      settingsReadable: false,
      digestVerified: false,
      basisWei: 0n,
      hasTokenId: false,
    });
    assert.equal(status.reason, LP_DIGEST_UNVERIFIED_REASON);
  });
});
