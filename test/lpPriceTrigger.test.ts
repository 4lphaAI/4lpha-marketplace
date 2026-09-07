/**
 * PHASE3.6 — a stop that means what the owner thinks it means.
 *
 * The properties that decide whether this phase is safe, each traceable to a
 * BLOCKER in `PHASE3.6-REVIEW.md`:
 *
 *   - **M3**: the observation parser's closed set. If it is not widened in the
 *     same change, a price breach writes a row the next cycle cannot read, the
 *     count restarts every cycle, and the price stop can NEVER confirm — that
 *     is FINDINGS (ae) in a brand-new trigger;
 *   - **M7**: the confirmation compares the breach CLASS. Strict kind equality
 *     means a co-occurring value stop RESETS a building price stop, so MORE
 *     evidence of danger produces a LATER exit;
 *   - **M2**: `lpProtectionStatus` must not report "there is nothing to arm"
 *     about a position a price stop is two cycles from liquidating;
 *   - **M5**: the default settings digest must not move, or every in-flight
 *     sequence of every agent with no stored row is refused at upgrade;
 *   - inertness: with no trigger set, the evaluator's answer is unchanged.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import {
  DEFAULT_LP_SETTINGS,
  breachClassOf,
  expectedPriceTriggerDirection,
  evaluateLpTriggers,
  lpProtectionStatus,
  alreadySatisfiedPriceTrigger,
  priceTriggerFires,
  priceTriggerMatchesPool,
  validateLpSettings,
  LP_NO_PROTECT_CONFIGURED_REASON,
  type LpAutomationSettings,
  type LpPriceTrigger,
  type LpTriggerObservation,
} from "../src/lp/triggers.js";
import { parseLpTriggerObservation } from "../src/store/lpObservations.js";
import {
  defaultLpSettingsParams,
  lpProtectionView,
  parseLpSettingsParams,
} from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import {
  humanPriceAtTick,
  tickAtHumanPrice,
  MAX_TICK,
  MIN_TICK,
} from "../src/lp/tickMath.js";
import type { LpRailConfig, LpRailEvidence } from "../src/lp/rails.js";

const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const POOL = getAddress("0x172fcD41E0913e95784454622d1c3724f546f849");
const OTHER = getAddress("0x1111111111111111111111111111111111111111");
const NOW = 1_900_000_000_000;
const INTERVAL = 60_000;

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 300,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

function market(blockNumber: bigint): LpRailEvidence {
  return {
    blockNumber,
    finalizedBlockNumber: blockNumber,
    observationCardinality: 500,
    poolLiquidity: 10n ** 24n,
    priceImpactBps: 0n,
    spotSqrtPriceX96: 2n ** 96n,
    twapSqrtPriceX96: 2n ** 96n,
  };
}

const STOP_AT_MINUS_100: LpPriceTrigger = {
  token0: USDT,
  token1: WBNB,
  fee: 100,
  tick: -100,
  when: "at-or-below",
};

function settings(over: Partial<LpAutomationSettings> = {}): LpAutomationSettings {
  return { ...DEFAULT_LP_SETTINGS, ...over };
}

function position(currentTick: number, over: Record<string, unknown> = {}) {
  return {
    basisWei: 0n,
    basisSource: "imported" as const,
    collectibleFee0: 0n,
    collectibleFee1: 0n,
    currentTick,
    exitValueWei: 10n ** 15n,
    freshFeesValueWei: 0n,
    poolAddress: POOL,
    token0: USDT,
    token1: WBNB,
    fee: 100,
    tickLower: -1_000,
    tickUpper: 1_000,
    tokenId: "7166387",
    ...over,
  };
}

function evaluate(input: {
  readonly tick: number;
  readonly settings: LpAutomationSettings;
  readonly previous?: LpTriggerObservation;
  readonly blockNumber?: bigint;
  readonly nowMs?: number;
}) {
  return evaluateLpTriggers({
    intervalMs: INTERVAL,
    market: market(input.blockNumber ?? 100n),
    nowMs: input.nowMs ?? NOW,
    position: position(input.tick),
    ...(input.previous === undefined ? {} : { previousObservation: input.previous }),
    rails: RAILS,
    settings: input.settings,
  });
}

/* -------------------------------------------------------------------------- */
/* The comparison, and the matching                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6: the price comparison", () => {
  it("is INCLUSIVE at the exact tick, both directions", () => {
    const below: LpPriceTrigger = { ...STOP_AT_MINUS_100, when: "at-or-below" };
    const above: LpPriceTrigger = { ...STOP_AT_MINUS_100, when: "at-or-above" };
    assert.equal(priceTriggerFires(below, -100), true, "at the tick fires");
    assert.equal(priceTriggerFires(below, -101), true);
    assert.equal(priceTriggerFires(below, -99), false);
    assert.equal(priceTriggerFires(above, -100), true, "at the tick fires");
    assert.equal(priceTriggerFires(above, -99), true);
    assert.equal(priceTriggerFires(above, -101), false);
  });

  it("matches a pool by its TRIPLE, case-insensitively on the legs", () => {
    const pool = { token0: USDT.toLowerCase() as `0x${string}`, token1: WBNB, fee: 100 };
    assert.equal(priceTriggerMatchesPool(STOP_AT_MINUS_100, pool), true);
    assert.equal(
      priceTriggerMatchesPool(STOP_AT_MINUS_100, { ...pool, fee: 2_500 }),
      false,
      "a different fee tier is a different pool",
    );
    assert.equal(
      priceTriggerMatchesPool(STOP_AT_MINUS_100, { ...pool, token0: OTHER }),
      false,
    );
  });

  it("a trigger for another pool is IGNORED entirely, not merely un-fired", () => {
    // The (ae)-shaped hazard OQ1 names: a configured protection that silently
    // does nothing. It must not fire here — and M9's agent-level report is what
    // makes the zero-match case visible.
    const foreign: LpPriceTrigger = { ...STOP_AT_MINUS_100, token0: OTHER, tick: 10_000 };
    const first = evaluate({ tick: 0, settings: settings({ priceStopLoss: foreign }) });
    assert.equal(first.nextObservation.protectBreach, undefined);
    assert.equal(first.decision, "hold");
  });
});

/* -------------------------------------------------------------------------- */
/* M3 — the closed set that resets the counter                                */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6 M3: the observation parser must know the new kinds", () => {
  it("round-trips a price breach, so the second cycle can confirm it", () => {
    const first = evaluate({ tick: -200, settings: settings({ priceStopLoss: STOP_AT_MINUS_100 }) });
    assert.equal(first.nextObservation.protectBreach, "price-stop-loss");
    assert.equal(first.nextObservation.protectConsecutive, 1);
    assert.equal(first.decision, "hold");

    // THE HAZARD: if the parser rejected this row it would answer `null`, the
    // count would restart, and the stop could never reach two.
    const parsed = parseLpTriggerObservation(
      JSON.parse(
        JSON.stringify(first.nextObservation, (_k, v) =>
          typeof v === "bigint" ? { $bigint: v.toString() } : v,
        ),
        (_k, v) =>
          v !== null && typeof v === "object" && "$bigint" in v
            ? BigInt((v as { $bigint: string }).$bigint)
            : v,
      ),
    );
    assert.notEqual(parsed, null, "the parser must accept the new kind");
    assert.equal(parsed?.protectBreach, "price-stop-loss");
    assert.equal(parsed?.protectBreachClass, "stop");
    assert.equal(parsed?.currentTick, -200);

    const second = evaluate({
      tick: -200,
      settings: settings({ priceStopLoss: STOP_AT_MINUS_100 }),
      previous: parsed!,
      blockNumber: 101n,
      nowMs: NOW + INTERVAL,
    });
    assert.equal(second.decision, "protect-price-stop-loss");
  });

  it("an UNKNOWN breach kind parses as null — one extra cycle, never a throw", () => {
    const row = {
      blockNumber: 100n,
      evaluatedAtMs: NOW,
      poolAddress: POOL,
      protectBreach: "some-future-kind",
      protectConsecutive: 1,
      rotationBreach: false,
      rotationConsecutive: 0,
      tokenId: "1",
    };
    assert.equal(parseLpTriggerObservation(row), null);
  });

  it("rejects an out-of-range currentTick rather than reporting it", () => {
    const base = {
      blockNumber: 100n,
      evaluatedAtMs: NOW,
      poolAddress: POOL,
      protectConsecutive: 0,
      rotationBreach: false,
      rotationConsecutive: 0,
      tokenId: "1",
    };
    assert.notEqual(parseLpTriggerObservation({ ...base, currentTick: 0 }), null);
    assert.equal(parseLpTriggerObservation({ ...base, currentTick: MAX_TICK + 1 }), null);
    assert.equal(parseLpTriggerObservation({ ...base, currentTick: 1.5 }), null);
    // Absent is legal: a row from before this phase.
    assert.equal(parseLpTriggerObservation(base)?.currentTick, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* M7 — the class, not the kind                                               */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6 M7: the confirmation compares the breach CLASS", () => {
  it("classifies all four kinds", () => {
    assert.equal(breachClassOf("stop-loss"), "stop");
    assert.equal(breachClassOf("price-stop-loss"), "stop");
    assert.equal(breachClassOf("take-profit"), "take-profit");
    assert.equal(breachClassOf("price-take-profit"), "take-profit");
    assert.equal(breachClassOf(undefined), undefined);
  });

  it("price-stop then VALUE-stop DISPATCHES, and names the cycle-2 kind", () => {
    // Strict kind equality would reset the count here — more evidence of
    // danger producing a later exit, which is the opposite of the point.
    const withPrice = settings({ priceStopLoss: STOP_AT_MINUS_100 });
    const first = evaluate({ tick: -200, settings: withPrice });
    assert.equal(first.nextObservation.protectBreach, "price-stop-loss");

    const bothArmed = settings({
      priceStopLoss: STOP_AT_MINUS_100,
      stopLossPct: 10,
    });
    const second = evaluateLpTriggers({
      intervalMs: INTERVAL,
      market: market(101n),
      nowMs: NOW + INTERVAL,
      // basis well above value ⇒ the VALUE stop also breaches
      position: position(-200, { basisWei: 10n ** 18n, exitValueWei: 10n ** 15n }),
      previousObservation: first.nextObservation,
      rails: RAILS,
      settings: bothArmed,
    });
    assert.equal(second.decision, "protect-stop-loss", "value wins the naming");
    assert.equal(second.nextObservation.protectConsecutive, 2, "the count SURVIVED");
  });

  it("stop then take-profit does NOT confirm — different classes", () => {
    const first = evaluate({ tick: -200, settings: settings({ priceStopLoss: STOP_AT_MINUS_100 }) });
    const takeAt100: LpPriceTrigger = { ...STOP_AT_MINUS_100, tick: 100, when: "at-or-above" };
    const second = evaluate({
      tick: 200,
      settings: settings({ priceTakeProfit: takeAt100 }),
      previous: first.nextObservation,
      blockNumber: 101n,
      nowMs: NOW + INTERVAL,
    });
    assert.equal(second.nextObservation.protectBreach, "price-take-profit");
    assert.equal(second.nextObservation.protectConsecutive, 1, "restarted");
    assert.equal(second.decision, "hold");
  });
});

/* -------------------------------------------------------------------------- */
/* M2 — the surface must not say "nothing to arm"                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6 M2: lpProtectionStatus knows about price triggers", () => {
  const base = {
    settingsReadable: true,
    digestVerified: true,
    hasTokenId: true,
    observation: null,
    nowMs: NOW,
    intervalMs: INTERVAL,
  };

  it("a ZERO-BASIS position with a matched price stop is ARMED", () => {
    // PHASE3.4 promised `basisWei: 0` means "no TP/SL". A price trigger
    // supersedes that, and the surface must say so rather than reporting a
    // position that is two cycles from liquidation as unprotected.
    const status = lpProtectionStatus({
      ...base,
      settings: settings({ priceStopLoss: STOP_AT_MINUS_100 }),
      basisWei: 0n,
      pool: { token0: USDT, token1: WBNB, fee: 100 },
    });
    assert.equal(status.armed, true);
    assert.match(status.reason, /price trigger/iu);
    assert.equal(status.priceTriggers?.length, 1);
  });

  it("…and is NOT armed when the trigger belongs to another pool", () => {
    const status = lpProtectionStatus({
      ...base,
      settings: settings({ priceStopLoss: { ...STOP_AT_MINUS_100, fee: 2_500 } }),
      basisWei: 0n,
      pool: { token0: USDT, token1: WBNB, fee: 100 },
    });
    assert.equal(status.armed, false);
    assert.equal(status.reason, LP_NO_PROTECT_CONFIGURED_REASON);
    assert.deepEqual(status.priceTriggers, []);
  });

  it("reports the observed tick and the signed distance", () => {
    const status = lpProtectionStatus({
      ...base,
      settings: settings({ priceStopLoss: STOP_AT_MINUS_100 }),
      basisWei: 0n,
      pool: { token0: USDT, token1: WBNB, fee: 100 },
      observation: {
        blockNumber: 100n,
        currentTick: -40,
        evaluatedAtMs: NOW,
        poolAddress: POOL,
        protectConsecutive: 0,
        rotationBreach: false,
        rotationConsecutive: 0,
        tokenId: "7166387",
      },
    });
    assert.equal(status.priceTriggers?.[0]?.observedTick, -40);
  });
});

/* -------------------------------------------------------------------------- */
/* M8 — the admission predicate                                               */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6 M8: an armed trigger must not liquidate the NEXT position", () => {
  const pool = { token0: USDT, token1: WBNB, fee: 100 };

  it("names the already-satisfied trigger", () => {
    const hit = alreadySatisfiedPriceTrigger(
      settings({ priceStopLoss: STOP_AT_MINUS_100 }),
      pool,
      -200,
    );
    assert.equal(hit?.label, "stopLoss");
  });

  it("answers null when unsatisfied, and when the pool does not match", () => {
    assert.equal(
      alreadySatisfiedPriceTrigger(settings({ priceStopLoss: STOP_AT_MINUS_100 }), pool, 0),
      null,
    );
    assert.equal(
      alreadySatisfiedPriceTrigger(
        settings({ priceStopLoss: { ...STOP_AT_MINUS_100, fee: 2_500 } }),
        pool,
        -200,
      ),
      null,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* M5 + inertness                                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6: inert when unset", () => {
  it("the DEFAULT settings digest does not move (M5)", () => {
    // `canonicalEncode` drops ABSENT keys but encodes present ones, so emitting
    // `priceStopLoss: null` here would refuse every in-flight sequence of every
    // agent with no stored settings row, at upgrade.
    const params = defaultLpSettingsParams();
    assert.equal("priceStopLoss" in params, false);
    assert.equal("priceTakeProfit" in params, false);
    assert.equal(
      paramsHash("lpSettings", params),
      "0x7c9676678e0b193abf18c12a8346a2de18c5936e1a5771f63a0e3c280ce08134",
      "MEASURED against commit d354449 (the tree immediately before this phase) " +
        "by computing the same expression there: identical. If this literal ever " +
        "has to change, every in-flight sequence of every agent with no stored " +
        "settings row is refused at the upgrade that changes it.",
    );
  });

  it("the evaluator's answer is identical with the keys unset", () => {
    const withoutKeys = evaluate({ tick: -200, settings: DEFAULT_LP_SETTINGS });
    assert.equal(withoutKeys.decision, "hold");
    assert.equal(withoutKeys.nextObservation.protectBreach, undefined);
    assert.equal(withoutKeys.nextObservation.protectBreachClass, undefined);
  });

  it("a stored row without the keys still parses", () => {
    const parsed = parseLpSettingsParams(defaultLpSettingsParams());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.priceStopLoss, null);
    assert.equal(parsed.value.priceTakeProfit, null);
  });

  it("null clears a trigger through the wire", () => {
    const parsed = parseLpSettingsParams({
      ...defaultLpSettingsParams(),
      priceStopLoss: null,
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.priceStopLoss, null);
  });
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6: validation", () => {
  const good: LpPriceTrigger = STOP_AT_MINUS_100;

  it("refuses an out-of-range tick, a bad direction, and mis-ordered legs", () => {
    for (const bad of [
      { ...good, tick: MAX_TICK + 1 },
      { ...good, tick: MIN_TICK - 1 },
      { ...good, tick: 1.5 },
      { ...good, when: "sideways" as unknown as LpPriceTrigger["when"] },
      { ...good, token0: WBNB, token1: USDT },
      { ...good, fee: 1_234 },
    ]) {
      assert.throws(
        () => validateLpSettings(settings({ priceStopLoss: bad })),
        `should have refused ${JSON.stringify(bad)}`,
      );
    }
  });

  it("accepts a well-formed trigger on both slots", () => {
    validateLpSettings(settings({ priceStopLoss: good, priceTakeProfit: good }));
  });

  it("refuses unknown keys inside the trigger at the wire", () => {
    const parsed = parseLpSettingsParams({
      ...defaultLpSettingsParams(),
      priceStopLoss: { ...good, extra: 1 },
    });
    assert.equal(parsed.ok, false);
  });
});

/* -------------------------------------------------------------------------- */
/* The conversion (M11/M12/M13), pinned against the (ao) measurement          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6: price <-> tick", () => {
  it("reproduces the FINDINGS (ao) pair to five significant figures", () => {
    // The pool prices token1 per token0 = WBNB per USDT; the human reads the
    // inverse. Both points were measured on mainnet.
    assert.equal((1 / humanPriceAtTick(-64027, 18, 18)).toFixed(3), "603.279");
    assert.equal((1 / humanPriceAtTick(-64160, 18, 18)).toFixed(3), "611.356");
  });

  it("the decimals term is LIVE — the 18/18 vector alone proves nothing", () => {
    assert.equal(humanPriceAtTick(0, 18, 18), 1);
    assert.equal(humanPriceAtTick(0, 6, 18), 1e-12);
    assert.equal(humanPriceAtTick(0, 18, 6), 1e12);
  });

  it("rounds so the signed tick is never MORE aggressive than the request", () => {
    for (const target of [1.5, 0.001657, 1234.5]) {
      const down = tickAtHumanPrice({ humanPrice: target, decimals0: 18, decimals1: 18, round: "down" });
      const up = tickAtHumanPrice({ humanPrice: target, decimals0: 18, decimals1: 18, round: "up" });
      assert.ok(humanPriceAtTick(down, 18, 18) <= target, `down: ${target}`);
      assert.ok(humanPriceAtTick(up, 18, 18) >= target, `up: ${target}`);
      assert.ok(up - down <= 1, "the two must bracket, not diverge");
    }
  });

  it("round trips: price -> tick -> price brackets the input", () => {
    for (const tick of [MIN_TICK + 1, -100_000, -1024, 0, 1024, 100_000, MAX_TICK - 1]) {
      const price = humanPriceAtTick(tick, 18, 18);
      const back = tickAtHumanPrice({ humanPrice: price, decimals0: 18, decimals1: 18, round: "down" });
      assert.ok(Math.abs(back - tick) <= 1, `tick ${tick} -> ${back}`);
    }
  });

  it("refuses a non-positive or non-finite price", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() =>
        tickAtHumanPrice({ humanPrice: bad, decimals0: 18, decimals1: 18, round: "down" }),
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The audit's own mutations, pinned                                          */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6 audit A5: the decimals SIGN is load-bearing", () => {
  it("an inverted exponent changes the answer, so a regression cannot hide", () => {
    // The audit measured that flipping `10^(d0-d1)` to `10^(d1-d0)` passed all
    // 1 689 tests: every vector was 18/18, where the term is 10^0 either way.
    // These are the vectors that discriminate.
    assert.equal(humanPriceAtTick(0, 6, 18), 1e-12);
    assert.notEqual(humanPriceAtTick(0, 6, 18), humanPriceAtTick(0, 18, 6));
    // And the inverse must agree with the forward direction on the same pair.
    const tick = tickAtHumanPrice({
      humanPrice: 1e-12,
      decimals0: 6,
      decimals1: 18,
      round: "down",
    });
    assert.equal(tick, 0, "6/18 at price 1e-12 is tick 0; a flipped sign gives ~276k");
  });

  it("a USDC-style 6/18 pool round-trips", () => {
    for (const t of [-10_000, 0, 10_000]) {
      const price = humanPriceAtTick(t, 6, 18);
      const back = tickAtHumanPrice({
        humanPrice: price,
        decimals0: 6,
        decimals1: 18,
        round: "down",
      });
      assert.ok(Math.abs(back - t) <= 1, `6/18 tick ${t} -> ${back}`);
    }
  });
});

describe("PHASE3.6 audit A6: the bounds refuse rather than saturate", () => {
  it("a price beyond the representable range throws instead of returning a bound", () => {
    assert.throws(
      () => tickAtHumanPrice({ humanPrice: 1e60, decimals0: 18, decimals1: 18, round: "up" }),
      /outside the representable tick range/u,
    );
    assert.throws(
      () => tickAtHumanPrice({ humanPrice: 1e-60, decimals0: 18, decimals1: 18, round: "down" }),
      /outside the representable tick range/u,
    );
  });
});

describe("PHASE3.6 audit A7: a count is only carried under the SAME settings", () => {
  it("a newly-signed trigger does NOT inherit a count earned by another instrument", () => {
    // Measured by the audit: cycle 1 builds a `stop-loss` count under
    // stopLossPct 10; the owner then signs a price trigger; cycle 2 dispatched
    // on an instrument observed exactly ONCE. The two-confirmation contract is
    // the transient-wick filter this subsystem rests on.
    const first = evaluateLpTriggers({
      settingsDigest: `0x${"11".repeat(32)}`,
      intervalMs: INTERVAL,
      market: market(100n),
      nowMs: NOW,
      position: position(-200, { basisWei: 10n ** 18n, exitValueWei: 10n ** 15n }),
      rails: RAILS,
      settings: settings({ stopLossPct: 10 }),
    });
    assert.equal(first.nextObservation.protectBreach, "stop-loss");
    assert.equal(first.nextObservation.protectConsecutive, 1);

    const second = evaluateLpTriggers({
      settingsDigest: `0x${"22".repeat(32)}`, // the owner re-signed
      intervalMs: INTERVAL,
      market: market(101n),
      nowMs: NOW + INTERVAL,
      position: position(-200),
      previousObservation: first.nextObservation,
      rails: RAILS,
      settings: settings({ stopLossPct: 0, priceStopLoss: STOP_AT_MINUS_100 }),
    });
    assert.equal(second.nextObservation.protectConsecutive, 1, "the count RESTARTED");
    assert.equal(second.decision, "hold", "and nothing dispatched");
  });

  it("an unchanged digest still carries the count", () => {
    const digest = `0x${"33".repeat(32)}`;
    const first = evaluateLpTriggers({
      settingsDigest: digest,
      intervalMs: INTERVAL,
      market: market(100n),
      nowMs: NOW,
      position: position(-200),
      rails: RAILS,
      settings: settings({ priceStopLoss: STOP_AT_MINUS_100 }),
    });
    const second = evaluateLpTriggers({
      settingsDigest: digest,
      intervalMs: INTERVAL,
      market: market(101n),
      nowMs: NOW + INTERVAL,
      position: position(-200),
      previousObservation: first.nextObservation,
      rails: RAILS,
      settings: settings({ priceStopLoss: STOP_AT_MINUS_100 }),
    });
    assert.equal(second.decision, "protect-price-stop-loss");
  });
});

describe("PHASE3.6 audit A4: the receipt names the threshold that fired", () => {
  it("carries triggerTick and triggerWhen on a price breach", () => {
    const digest = `0x${"44".repeat(32)}`;
    const first = evaluateLpTriggers({
      settingsDigest: digest,
      intervalMs: INTERVAL,
      market: market(100n),
      nowMs: NOW,
      position: position(-200),
      rails: RAILS,
      settings: settings({ priceStopLoss: STOP_AT_MINUS_100 }),
    });
    const second = evaluateLpTriggers({
      settingsDigest: digest,
      intervalMs: INTERVAL,
      market: market(101n),
      nowMs: NOW + INTERVAL,
      position: position(-200),
      previousObservation: first.nextObservation,
      rails: RAILS,
      settings: settings({ priceStopLoss: STOP_AT_MINUS_100 }),
    });
    assert.equal(second.decision, "protect-price-stop-loss");
    assert.equal(second.triggerReason.triggerTick, -100);
    assert.equal(second.triggerReason.triggerWhen, "at-or-below");
    assert.equal(
      second.triggerReason.thresholdBps,
      undefined,
      "bps-of-basis is meaningless for a tick comparison and must be absent",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The fix review's own mutations, pinned                                     */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6 fixreview: the audit fixes are load-bearing", () => {
  const pool = { token0: USDT, token1: WBNB, fee: 100 } as const;
  const armed = settings({ priceStopLoss: STOP_AT_MINUS_100 });

  it("A2: a status computed WITHOUT the pool reports the opposite answer", () => {
    // The worker's `--once` print used to omit `pool`, so it said
    // "there is nothing to arm" on the very cycle it recorded a price breach
    // while the HTTP route said the position was armed. Deleting the `pool`
    // block again must fail here, not merely change a log line.
    const base = {
      settings: armed,
      settingsReadable: true,
      digestVerified: true,
      basisWei: 0n,
      hasTokenId: true,
      observation: null,
      nowMs: NOW,
      intervalMs: INTERVAL,
    };
    assert.equal(lpProtectionStatus({ ...base, pool }).armed, true);
    assert.equal(
      lpProtectionStatus(base).armed,
      false,
      "without the pool the SAME position reads as unprotected — that is the bug",
    );
  });

  it("A3: the protection VIEW carries the distance, not the raw record", () => {
    const status = lpProtectionStatus({
      settings: armed,
      settingsReadable: true,
      digestVerified: true,
      basisWei: 0n,
      hasTokenId: true,
      nowMs: NOW,
      intervalMs: INTERVAL,
      pool,
      observation: {
        blockNumber: 100n,
        currentTick: -40,
        evaluatedAtMs: NOW,
        poolAddress: POOL,
        protectConsecutive: 0,
        rotationBreach: false,
        rotationConsecutive: 0,
        tokenId: "7166387",
      },
    });
    const view = lpProtectionView(status);
    const triggers = view["priceTriggers"] as Record<string, unknown>[];
    assert.equal(triggers.length, 1);
    // These three fields exist ONLY on the view. Emitting the raw record —
    // which is what shipped and passed — loses all of them.
    assert.equal(triggers[0]?.["breachedAtObservation"], false);
    assert.equal(triggers[0]?.["ticksAway"], -60);
    assert.match(String(triggers[0]?.["note"]), /not as of now/iu);
  });

  it("N3: a settings re-sign resets the PROTECT count and NOT the rotate clock", () => {
    // The first A7 fix put the digest conjunct in the shared comparability
    // predicate, so re-signing anything silently restarted rotateMinHoldMinutes.
    const rotating = settings({
      autoRotate: true,
      rotateBandBps: 0,
      rotateMinHoldMinutes: 10,
      priceStopLoss: STOP_AT_MINUS_100,
    });
    const outOfRange = { tickLower: -1_000, tickUpper: -500 };
    const first = evaluateLpTriggers({
      settingsDigest: `0x${"aa".repeat(32)}`,
      intervalMs: INTERVAL,
      market: market(100n),
      nowMs: NOW,
      position: position(-200, outOfRange),
      rails: RAILS,
      settings: rotating,
    });
    assert.equal(first.nextObservation.rotationBreach, true);

    const second = evaluateLpTriggers({
      settingsDigest: `0x${"bb".repeat(32)}`, // re-signed
      intervalMs: INTERVAL,
      market: market(101n),
      nowMs: NOW + INTERVAL,
      position: position(-200, outOfRange),
      previousObservation: first.nextObservation,
      rails: RAILS,
      settings: rotating,
    });
    assert.equal(
      second.nextObservation.rotationConsecutive,
      2,
      "the rotate count must SURVIVE a settings re-sign",
    );
    assert.equal(
      second.nextObservation.rotationBreachStartedAtMs,
      first.nextObservation.rotationBreachStartedAtMs,
      "and so must the minimum-hold clock",
    );
    assert.equal(
      second.nextObservation.protectConsecutive,
      1,
      "while the PROTECT count restarts, which is what A7 asked for",
    );
    assert.equal(
      second.triggerReason.previousObservationDiscarded,
      "settings-changed",
      "and the discard is REPORTED, in the field whose purpose is that it never is silent",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* FIXREVIEW2 P1 — the derivation that had no coverage                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.6 fixreview2 P1: the intent -> direction derivation", () => {
  it("all four combinations, derived from the pool's own mechanics", () => {
    // A V3 tick tracks token1-per-token0 — the price OF token0. Everything
    // else follows, and inverting this function must fail HERE: the second
    // fix review measured that inverting it left the whole suite green, and
    // the mutation fails CLOSED on the correct input, so it would have refused
    // the FINDINGS (ao) owner's own stop at the terminal.
    assert.equal(expectedPriceTriggerDirection("stop-loss", false), "at-or-below");
    assert.equal(expectedPriceTriggerDirection("take-profit", false), "at-or-above");
    assert.equal(expectedPriceTriggerDirection("stop-loss", true), "at-or-above");
    assert.equal(expectedPriceTriggerDirection("take-profit", true), "at-or-below");
  });

  it("the FINDINGS (ao) case is at-or-above, and it must be signable", () => {
    // USDT/WBNB with USDT as token0; the owner quotes USDT-per-BNB (a price OF
    // token1, so `inverted`) and wants out if BNB weakens. BNB weakening means
    // USDT-per-BNB falls, which means WBNB-per-USDT rises, which means the tick
    // rises. That is `at-or-above`, and the owner's original request was
    // refused by the plane for months because nothing derived it.
    assert.equal(
      expectedPriceTriggerDirection("stop-loss", true),
      "at-or-above",
      "the case this entire phase exists for",
    );
  });

  it("is independent of `when`, of the market and of the rounding", () => {
    // The property that makes it a CHECK rather than a restatement: the first
    // build derived it from the rounding side, which IS `when`, so the
    // comparison was `when` against itself. This function takes neither.
    assert.equal(expectedPriceTriggerDirection.length, 2);
    for (const which of ["stop-loss", "take-profit"] as const) {
      for (const inverted of [true, false]) {
        // Same answer however many times it is asked, with no other input.
        assert.equal(
          expectedPriceTriggerDirection(which, inverted),
          expectedPriceTriggerDirection(which, inverted),
        );
      }
    }
  });
});
