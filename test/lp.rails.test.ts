/**
 * Manipulation rails: the config reader is ALL-REQUIRED with typed holds
 * (never a default), each rail trips individually, and the saga floors derive
 * from the rail slippage (PHASE3 body + Rev2 items 18/23).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  amountInAfterPoolFee,
  arithmeticMeanTick,
  assertValidLpRailConfig,
  checkManipulationRails,
  LP_RAIL_ENV_KEYS,
  MAX_MINT_UNDEPLOYED_BPS,
  MIN_LIQUIDITY_INTERMEDIATE,
  MIN_MINT_CHARGE_WEI,
  MINT_UNDEPLOYED_RESERVE_BPS,
  MINT_VERIFY_MARGIN_BPS,
  priceDeviationBps,
  quotePriceImpactBps,
  resolveLpRailConfig,
  sagaDecreaseFloors,
  sagaMintFloors,
  sagaSingleSidedMintFloors,
  sagaSwapMinOut,
  shiftSqrtPriceX96ByBps,
  shiftSqrtPriceX96ByCentiBps,
  spotSwapOutput,
  type LpRailConfig,
  type LpRailEvidence,
} from "../src/lp/rails.js";
import {
  getLiquidityForAmounts,
  getMintAmountsForLiquidity,
  getSqrtRatioAtTick,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  minLpOutFor,
  Q96,
} from "../src/lp/tickMath.js";

const FULL_ENV: Record<string, string> = {
  LP_MAX_PRICE_IMPACT_BPS: "100",
  LP_MAX_SPOT_TWAP_DEVIATION_BPS: "100",
  LP_MIN_OBSERVATION_CARDINALITY: "8",
  LP_MIN_POOL_LIQUIDITY_WEI: "10000",
  LP_TWAP_WINDOW_SECONDS: "300",
  LP_MAX_SAGA_SLIPPAGE_BPS: "500",
};

const CONFIG: LpRailConfig = {
  maxPriceImpactBps: 100,
  maxSpotTwapDeviationBps: 100,
  minObservationCardinality: 8,
  minPoolLiquidity: 10_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 500,
};

function evidence(overrides: Partial<LpRailEvidence> = {}): LpRailEvidence {
  const spot = getSqrtRatioAtTick(0);
  return {
    blockNumber: 100n,
    finalizedBlockNumber: 100n,
    observationCardinality: 32,
    poolLiquidity: 1_000_000n,
    priceImpactBps: 10n,
    spotSqrtPriceX96: spot,
    twapSqrtPriceX96: spot,
    ...overrides,
  };
}

describe("resolveLpRailConfig: all keys required, typed holds, no defaults", () => {
  it("resolves a fully-populated environment", () => {
    const result = resolveLpRailConfig(FULL_ENV);
    assert.ok(result.ok);
    assert.deepEqual(result.config, CONFIG);
  });

  it("holds with LP_RAILS_UNCONFIGURED for EVERY individually missing key", () => {
    for (const key of LP_RAIL_ENV_KEYS) {
      const env = { ...FULL_ENV };
      delete env[key];
      const result = resolveLpRailConfig(env);
      assert.ok(!result.ok, `${key} missing must not resolve`);
      assert.equal(result.failure.code, "LP_RAILS_UNCONFIGURED");
      assert.deepEqual(result.failure.keys, [key]);
      assert.match(result.failure.reason, /holds/u);

      // Blank counts as missing too — a rail cannot be configured to "".
      const blank = { ...FULL_ENV, [key]: "  " };
      const blankResult = resolveLpRailConfig(blank);
      assert.ok(!blankResult.ok && blankResult.failure.code === "LP_RAILS_UNCONFIGURED");
    }
  });

  it("reports every missing key of an empty environment at once", () => {
    const result = resolveLpRailConfig({});
    assert.ok(!result.ok);
    assert.deepEqual([...result.failure.keys].sort(), [...LP_RAIL_ENV_KEYS].sort());
  });

  it("holds with LP_RAILS_INVALID for malformed values", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["LP_MAX_PRICE_IMPACT_BPS", "-1"],
      ["LP_MAX_PRICE_IMPACT_BPS", "10001"],
      ["LP_MAX_PRICE_IMPACT_BPS", "1.5"],
      ["LP_MAX_SPOT_TWAP_DEVIATION_BPS", "abc"],
      ["LP_MIN_OBSERVATION_CARDINALITY", "0"],
      ["LP_MIN_POOL_LIQUIDITY_WEI", "0"],
      ["LP_MIN_POOL_LIQUIDITY_WEI", "-5"],
      ["LP_MIN_POOL_LIQUIDITY_WEI", "1e18"],
      ["LP_TWAP_WINDOW_SECONDS", "0"],
      ["LP_MAX_SAGA_SLIPPAGE_BPS", "0"],
      ["LP_MAX_SAGA_SLIPPAGE_BPS", "2001"],
    ];
    for (const [key, value] of cases) {
      const result = resolveLpRailConfig({ ...FULL_ENV, [key]: value });
      assert.ok(!result.ok, `${key}=${value} must not resolve`);
      assert.equal(result.failure.code, "LP_RAILS_INVALID", `${key}=${value}`);
      assert.ok(result.failure.keys.includes(key));
    }
  });

  it("assertValidLpRailConfig enforces the same bar on injected configs", () => {
    assert.doesNotThrow(() => assertValidLpRailConfig(CONFIG));
    assert.throws(() => assertValidLpRailConfig({ ...CONFIG, minObservationCardinality: 0 }));
    assert.throws(() => assertValidLpRailConfig({ ...CONFIG, minPoolLiquidity: 0n }));
    assert.throws(() => assertValidLpRailConfig({ ...CONFIG, twapWindowSeconds: 0 }));
    assert.throws(() => assertValidLpRailConfig({ ...CONFIG, maxSagaSlippageBps: 0 }));
    assert.throws(() => assertValidLpRailConfig({ ...CONFIG, maxSagaSlippageBps: 2_001 }));
  });
});

describe("checkManipulationRails: each rail trips individually", () => {
  it("passes clean evidence, including at exact boundaries", () => {
    assert.equal(checkManipulationRails(evidence(), CONFIG), undefined);
    // Boundary equalities are PASSES: the rails are ceilings/floors, not bands.
    assert.equal(
      checkManipulationRails(
        evidence({
          observationCardinality: 8,
          poolLiquidity: 10_000n,
          priceImpactBps: 100n,
        }),
        CONFIG,
      ),
      undefined,
    );
  });

  it("trips on an unfinalized observation", () => {
    const failure = checkManipulationRails(
      evidence({ blockNumber: 101n, finalizedBlockNumber: 100n }),
      CONFIG,
    );
    assert.equal(failure?.code, "OBSERVATION_NOT_FINALIZED");
    assert.match(failure?.reason ?? "", /not finalized/u);
  });

  it("trips on low observation cardinality", () => {
    const failure = checkManipulationRails(evidence({ observationCardinality: 7 }), CONFIG);
    assert.equal(failure?.code, "OBSERVATION_CARDINALITY_LOW");
    assert.match(failure?.reason ?? "", /cardinality/u);
  });

  it("trips on low pool liquidity", () => {
    const failure = checkManipulationRails(evidence({ poolLiquidity: 9_999n }), CONFIG);
    assert.equal(failure?.code, "POOL_LIQUIDITY_LOW");
    assert.match(failure?.reason ?? "", /liquidity/u);
  });

  it("trips on spot/TWAP deviation past the ceiling", () => {
    const failure = checkManipulationRails(
      evidence({ twapSqrtPriceX96: getSqrtRatioAtTick(-500) }),
      CONFIG,
    );
    assert.equal(failure?.code, "SPOT_TWAP_DEVIATION_EXCEEDED");
    assert.match(failure?.reason ?? "", /TWAP deviation/u);
  });

  it("trips on quoted price impact past the ceiling", () => {
    const failure = checkManipulationRails(evidence({ priceImpactBps: 101n }), CONFIG);
    assert.equal(failure?.code, "PRICE_IMPACT_EXCEEDED");
    assert.match(failure?.reason ?? "", /price impact/u);
  });

  it("reports the FIRST failure when several rails trip at once", () => {
    const failure = checkManipulationRails(
      evidence({
        blockNumber: 101n,
        finalizedBlockNumber: 100n,
        observationCardinality: 1,
        priceImpactBps: 9_999n,
      }),
      CONFIG,
    );
    assert.equal(failure?.code, "OBSERVATION_NOT_FINALIZED");
  });
});

describe("price arithmetic", () => {
  it("priceDeviationBps is 0 for equal prices and symmetric in its arguments", () => {
    const spot = getSqrtRatioAtTick(1_234);
    assert.equal(priceDeviationBps(spot, spot), 0n);
    const a = getSqrtRatioAtTick(0);
    const b = getSqrtRatioAtTick(100);
    assert.equal(priceDeviationBps(a, b), priceDeviationBps(b, a));
  });

  it("pins a 100-tick gap to ~100 bps (1.0001^100 - 1)", () => {
    const deviation = priceDeviationBps(getSqrtRatioAtTick(100), getSqrtRatioAtTick(0));
    assert.equal(deviation, 100n);
  });

  it("rejects non-positive prices", () => {
    assert.throws(() => priceDeviationBps(0n, 1n), /positive/u);
    assert.throws(() => priceDeviationBps(1n, -1n), /positive/u);
  });

  it("spotSwapOutput inverts by direction at a known price", () => {
    // sqrtPriceX96 = 2 * Q96 means price token1/token0 = 4.
    const sqrtPrice = 2n * Q96;
    assert.equal(spotSwapOutput({ amountInAfterFee: 100n, sqrtPriceX96: sqrtPrice, tokenInIsToken0: true }), 400n);
    assert.equal(spotSwapOutput({ amountInAfterFee: 100n, sqrtPriceX96: sqrtPrice, tokenInIsToken0: false }), 25n);
    // Price 1: identity both ways.
    assert.equal(spotSwapOutput({ amountInAfterFee: 777n, sqrtPriceX96: Q96, tokenInIsToken0: true }), 777n);
    assert.equal(spotSwapOutput({ amountInAfterFee: 777n, sqrtPriceX96: Q96, tokenInIsToken0: false }), 777n);
    assert.equal(spotSwapOutput({ amountInAfterFee: 0n, sqrtPriceX96: Q96, tokenInIsToken0: true }), 0n);
  });

  it("quotePriceImpactBps measures shortfall vs spot and clamps at zero", () => {
    assert.equal(quotePriceImpactBps(10_000n, 9_900n), 100n);
    assert.equal(quotePriceImpactBps(10_000n, 10_000n), 0n);
    assert.equal(quotePriceImpactBps(10_000n, 10_500n), 0n);
    assert.equal(quotePriceImpactBps(0n, 1n), 0n);
  });

  /* ----- PHASE3.1 Rev2 item 16: the pool fee is NOT impact -------------- */

  it("amountInAfterPoolFee deducts the tier in MILLIONTHS (PHASE3 Rev2 item 38)", () => {
    // The exact CAKE leg FINDINGS (ag)'s live protect returned.
    const amountIn = 603_777_753_500_127_217n;
    assert.equal(amountInAfterPoolFee(amountIn, 100), 603_717_375_724_777_204n);
    assert.equal(amountInAfterPoolFee(amountIn, 500), 603_475_864_623_377_153n);
    assert.equal(amountInAfterPoolFee(amountIn, 2_500), 602_268_309_116_376_898n);
    assert.equal(amountInAfterPoolFee(amountIn, 10_000), 597_739_975_965_125_944n);
    // 10000 = 1%, not 100%: the classic units mistake, pinned.
    assert.equal(amountInAfterPoolFee(1_000_000n, 10_000), 990_000n);
    assert.equal(amountInAfterPoolFee(0n, 500), 0n);
  });

  it("refuses a fee tier that is not a positive millionths value", () => {
    assert.throws(() => amountInAfterPoolFee(1n, 0), /feeTier/u);
    assert.throws(() => amountInAfterPoolFee(1n, -500), /feeTier/u);
    assert.throws(() => amountInAfterPoolFee(1n, 1.5), /feeTier/u);
    assert.throws(() => amountInAfterPoolFee(1n, 1_000_000), /feeTier/u);
    assert.throws(() => amountInAfterPoolFee(-1n, 500), /nonnegative/u);
  });

  /**
   * GOLDEN VECTORS, from the review's read-only on-chain measurement of the
   * live CAKE/WBNB tiers on 2026-08-16 for that same 0.6037 CAKE leg:
   * `[feeTier, quotedOut, spotImpliedFromTheRawAmountIn]`.
   *
   * Fed the RAW amount — as every audit-A2 call site was — the "impact" is the
   * POOL'S OWN FEE, essentially in full. The deployment's `.env` sets
   * `LP_MAX_PRICE_IMPACT_BPS=100`, so the 1% tier's 103 bps made a position
   * there permanently unable to exit to quote, silently.
   */
  const CAKE_WBNB_TIERS = [
    { fee: 100, quoted: 1_450_494_911_359_679n, spotRaw: 1_450_642_604_529_734n, raw: 1n, corrected: 0n },
    { fee: 500, quoted: 1_449_830_683_468_614n, spotRaw: 1_450_556_098_829_982n, raw: 5n, corrected: 0n },
    { fee: 2_500, quoted: 1_445_041_262_535_047n, spotRaw: 1_448_663_066_705_239n, raw: 25n, corrected: 0n },
    { fee: 10_000, quoted: 1_429_079_592_482_020n, spotRaw: 1_444_052_117_961_982n, raw: 103n, corrected: 3n },
  ] as const;

  it("pins the DEFECT: raw amountIn reports the fee as impact — 1 / 5 / 25 / 103 bps", () => {
    for (const tier of CAKE_WBNB_TIERS) {
      assert.equal(
        quotePriceImpactBps(tier.spotRaw, tier.quoted),
        tier.raw,
        `fee ${tier.fee} must reproduce the measured fee-inclusive number`,
      );
    }
  });

  it("pins the FIX: deducting the tier first reads 0 / 0 / 0 / 3 bps of GENUINE impact", () => {
    // `spotSwapOutput` is linear in its input, so deducting the fee from the
    // input scales its output by the same factor — computed here on the
    // measured spot-implied output so the vector stays anchored to the chain
    // read rather than to a sqrtPrice this test would have to invent.
    for (const tier of CAKE_WBNB_TIERS) {
      const expectedAtSpot = amountInAfterPoolFee(tier.spotRaw, tier.fee);
      assert.equal(
        quotePriceImpactBps(expectedAtSpot, tier.quoted),
        tier.corrected,
        `fee ${tier.fee} must read genuine impact, not its own fee`,
      );
    }
  });

  it("the 1% pool crosses the deployment's own LP_MAX_PRICE_IMPACT_BPS=100 only when the fee is counted", () => {
    const deployed = 100n;
    const tier = CAKE_WBNB_TIERS[3];
    assert.ok(tier !== undefined);
    assert.ok(
      quotePriceImpactBps(tier.spotRaw, tier.quoted) > deployed,
      "the defect refuses — silently and permanently, under Rev2 item 11",
    );
    assert.ok(
      quotePriceImpactBps(amountInAfterPoolFee(tier.spotRaw, tier.fee), tier.quoted) <= deployed,
      "the fix admits it",
    );
  });

  it("keeps the STRICT > boundary the A2 fix-review established", () => {
    // Exactly AT the ceiling proceeds; one bps over refuses. The comparison
    // lives at the call sites, so this pins the number the comparison sees.
    const spot = 1_000_000n;
    const atRail = quotePriceImpactBps(spot, 950_000n); // exactly 500 bps
    assert.equal(atRail, 500n);
    assert.equal(atRail > 500n, false, "at the rail is allowed (strict >)");
    assert.equal(quotePriceImpactBps(spot, 949_000n) > 500n, true);
  });

  it("arithmeticMeanTick floors toward negative infinity like the oracle", () => {
    assert.equal(arithmeticMeanTick(100n, 10n), 10);
    assert.equal(arithmeticMeanTick(-5n, 2n), -3); // -2.5 floors to -3
    assert.equal(arithmeticMeanTick(-4n, 2n), -2);
    assert.throws(() => arithmeticMeanTick(1n, 0n), /positive/u);
  });
});

describe("saga floors (Rev2 item 23): derived, never zero, never defaulted", () => {
  it("sagaSwapMinOut keeps 10000 - slippage bps of a fresh quote, ceiled", () => {
    assert.equal(sagaSwapMinOut(10_000n, 500), 9_500n);
    assert.equal(sagaSwapMinOut(9_999n, 500), 9_500n); // ceil of 9499.05
    assert.equal(sagaSwapMinOut(1n, 500), 1n); // the 1-wei floor
  });

  it("sagaSwapMinOut refuses a zero/absent quote — a floor of zero is no floor", () => {
    assert.throws(() => sagaSwapMinOut(0n, 500), /positive fresh quote/u);
    assert.throws(() => sagaSwapMinOut(-1n, 500), /positive fresh quote/u);
    assert.throws(() => sagaSwapMinOut(1n, 0), /maxSagaSlippageBps/u);
    assert.throws(() => sagaSwapMinOut(1n, 2_001), /maxSagaSlippageBps/u);
  });

  it("sagaMintFloors returns two positive floors below the expected charge", () => {
    const sqrtPrice = getSqrtRatioAtTick(0);
    const desired = getMintAmountsForLiquidity(sqrtPrice, -600, 600, 10n ** 15n);
    const floors = sagaMintFloors({
      sqrtPriceX96: sqrtPrice,
      tickLower: -600,
      tickUpper: 600,
      liquidity: 10n ** 15n,
      maxSagaSlippageBps: 500,
      amount0Desired: desired.amount0,
      amount1Desired: desired.amount1,
    });
    assert.ok(floors.amount0Min >= 1n);
    assert.ok(floors.amount1Min >= 1n);
  });

  /**
   * PHASE3.13 B19 / F6. The NEW function, separate from `sagaMintFloors`,
   * because that one guards three callers where a one-legged expectation
   * really is the price leaving the range mid-build (M12 relaxes it in place;
   * the test above is what dies).
   *
   * The assertion is on the EXPECTED amounts — a function of liquidity and
   * range — and NOT on the caller's balances, which under swapless are never
   * one-sided (the zap-out's `collect` returns fees on both legs).
   */
  describe("PHASE3.13 B19: sagaSingleSidedMintFloors", () => {
    it("zeroes the absent leg and floors the present one, both sides", () => {
      const above = sagaSingleSidedMintFloors({
        // Spot below the range: the pool charges token0 only.
        sqrtPriceX96: getSqrtRatioAtTick(-1_000),
        tickLower: -600,
        tickUpper: 600,
        liquidity: 10n ** 15n,
        maxSagaSlippageBps: 500,
        side: "above",
      });
      assert.ok(above.amount0Min >= 1n);
      assert.equal(above.amount1Min, 0n, "a zero-charge leg carries a ZERO floor");

      const below = sagaSingleSidedMintFloors({
        // Spot above the range: token1 only.
        sqrtPriceX96: getSqrtRatioAtTick(1_000),
        tickLower: -600,
        tickUpper: 600,
        liquidity: 10n ** 15n,
        maxSagaSlippageBps: 500,
        side: "below",
      });
      assert.equal(below.amount0Min, 0n);
      assert.ok(below.amount1Min >= 1n);
    });

    it("REFUSES a range that contains the tick — the placement check F5 asked for", () => {
      for (const side of ["above", "below"] as const) {
        assert.throws(
          () =>
            sagaSingleSidedMintFloors({
              sqrtPriceX96: getSqrtRatioAtTick(0),
              tickLower: -600,
              tickUpper: 600,
              liquidity: 10n ** 15n,
              maxSagaSlippageBps: 500,
              side,
            }),
          /not strictly on the declared side/u,
        );
      }
    });

    it("REFUSES when the EXPECTED present leg is zero, or the side is inverted", () => {
      // Spot below the range charges token0 — declaring "below" makes the
      // PRESENT leg (token1) the zero one.
      assert.throws(
        () =>
          sagaSingleSidedMintFloors({
            sqrtPriceX96: getSqrtRatioAtTick(-1_000),
            tickLower: -600,
            tickUpper: 600,
            liquidity: 10n ** 15n,
            maxSagaSlippageBps: 500,
            side: "below",
          }),
        /expects nothing on the declared side/u,
      );
      assert.throws(
        () =>
          sagaSingleSidedMintFloors({
            sqrtPriceX96: getSqrtRatioAtTick(-1_000),
            tickLower: -600,
            tickUpper: 600,
            liquidity: 0n,
            maxSagaSlippageBps: 500,
            side: "above",
          }),
        /liquidity must be positive/u,
      );
    });

    it("leaves sagaMintFloors untouched — the two-sided guard still refuses a one-legged mint", () => {
      assert.throws(
        () =>
          sagaMintFloors({
            sqrtPriceX96: getSqrtRatioAtTick(-1_000),
            tickLower: -600,
            tickUpper: 600,
            liquidity: 10n ** 15n,
            maxSagaSlippageBps: 500,
            amount0Desired: 10n ** 18n,
            amount1Desired: 10n ** 18n,
          }),
        /two executable token amounts/u,
      );
    });
  });

  it("sagaMintFloors refuses a price outside the range (a one-legged mint)", () => {
    assert.throws(
      () =>
        sagaMintFloors({
          sqrtPriceX96: getSqrtRatioAtTick(1_000),
          tickLower: -600,
          tickUpper: 600,
          liquidity: 10n ** 15n,
          maxSagaSlippageBps: 500,
          amount0Desired: 10n ** 18n,
          amount1Desired: 10n ** 18n,
        }),
      /two executable token amounts/u,
    );
    assert.throws(
      () =>
        sagaMintFloors({
          sqrtPriceX96: getSqrtRatioAtTick(0),
          tickLower: -600,
          tickUpper: 600,
          liquidity: 0n,
          maxSagaSlippageBps: 500,
          amount0Desired: 10n ** 18n,
          amount1Desired: 10n ** 18n,
        }),
      /liquidity/u,
    );
  });

  /**
   * LP-ROTATE-MINT-FLOORS (2026-09-06). The live incident on `lp-agent-01`:
   * a 28-tick range on the USDT/WBNB 0.01% pool, floors derived at the
   * finalized block, the relay simulating a few blocks later with the tick
   * moved by one. The old per-leg haircut (`expected × (1 − 1%)`) refused
   * every such mint. The banded floors accept price drift while (review H1)
   * refusing a mint that would leave more than `MAX_MINT_UNDEPLOYED_BPS` of
   * the desired value in the wallet, where TP/SL would read it as a loss.
   *
   * Every expected figure below is a PINNED literal computed once from
   * `getLiquidityForAmounts` + `getMintAmountsForLiquidity` at the named tick
   * (`scripts/tmp/floor-probe2.ts`), so a floor derivation that stops
   * re-deriving liquidity from the desired amounts (review M3's surviving
   * mutation) changes a number here and dies.
   */
  describe("LP-ROTATE-MINT-FLOORS: sagaMintFloors bounds price drift AND undeployed value", () => {
    const observedTick = -66_402;
    const bps = 100;
    // The incident's post-sweep wallet: ~8.26 USDT (token0), ~0.0092 WBNB (token1).
    const amount0Desired = 8_262_624_151_416_735_379n;
    const amount1Desired = 9_183_940_679_332_802n;
    const spot = getSqrtRatioAtTick(observedTick);

    /** What NFPM charges for the desired amounts when the pool sits at `tick`. */
    const chargedAt = (lo: number, hi: number, tick: number): { amount0: bigint; amount1: bigint } => {
      const sqrt = getSqrtRatioAtTick(tick);
      const l = getLiquidityForAmounts(sqrt, lo, hi, amount0Desired, amount1Desired);
      return getMintAmountsForLiquidity(sqrt, lo, hi, l);
    };
    const floorsFor = (lo: number, hi: number): { amount0Min: bigint; amount1Min: bigint } => {
      const liquidity = getLiquidityForAmounts(spot, lo, hi, amount0Desired, amount1Desired);
      return sagaMintFloors({
        sqrtPriceX96: spot, tickLower: lo, tickUpper: hi, liquidity, maxSagaSlippageBps: bps,
        amount0Desired, amount1Desired,
      });
    };
    const accepts = (f: { amount0Min: bigint; amount1Min: bigint }, c: { amount0: bigint; amount1: bigint }): boolean =>
      c.amount0 >= f.amount0Min && c.amount1 >= f.amount1Min;

    it("the incident: the old haircut refused a one-tick move on the 28-tick range", () => {
      const lo = -66_416;
      const hi = -66_388;
      const liquidity = getLiquidityForAmounts(spot, lo, hi, amount0Desired, amount1Desired);
      const expected = getMintAmountsForLiquidity(spot, lo, hi, liquidity);
      const oldFloor0 = minLpOutFor(expected.amount0, 10_000 - bps);
      const oldFloor1 = minLpOutFor(expected.amount1, 10_000 - bps);
      assert.ok(chargedAt(lo, hi, observedTick + 1).amount0 < oldFloor0, "one tick up: token0 under the old floor");
      // At the observed tick token1 is already the scarce leg, so one tick
      // down still charges the full token1; two ticks down is the mirror.
      assert.ok(chargedAt(lo, hi, observedTick - 2).amount1 < oldFloor1, "two ticks down: token1 under the old floor");
    });

    it("28-tick range: pinned floors accept −3..+1 ticks and refuse +2 (undeployed 19.6% > 15%)", () => {
      const lo = -66_416;
      const hi = -66_388;
      const f = floorsFor(lo, hi);
      assert.equal(f.amount0Min, 6_088_600_586_724_102_016n);
      assert.equal(f.amount1Min, 6_987_141_488_593_225n);
      for (const delta of [-3, -2, -1, 1]) {
        assert.ok(accepts(f, chargedAt(lo, hi, observedTick + delta)), `delta ${delta} must be accepted`);
      }
      for (const delta of [2, 3]) {
        assert.ok(!accepts(f, chargedAt(lo, hi, observedTick + delta)), `delta ${delta} must be refused`);
      }
      // The refused mint really is the undeployed bound, not the haircut: +2
      // ticks leaves ~19.6% of the desired value in the wallet.
      const c = chargedAt(lo, hi, observedTick + 2);
      const sq = getSqrtRatioAtTick(observedTick + 2) ** 2n;
      const charged = c.amount0 * sq + c.amount1 * Q96 * Q96;
      const desired = amount0Desired * sq + amount1Desired * Q96 * Q96;
      assert.ok(charged * 10_000n < desired * BigInt(10_000 - MAX_MINT_UNDEPLOYED_BPS));
    });

    it("±5% range: pinned floors are the re-derived-liquidity figures, not fixed-liquidity ones", () => {
      const lo = -66_900;
      const hi = -65_900;
      const f = floorsFor(lo, hi);
      // Review-1 M3's surviving mutation (keep the reference liquidity at the
      // shifted price) produces a different token0 figure at the band edge;
      // the pinned literal is the re-derived-liquidity charge.
      assert.equal(f.amount0Min, 5_998_004_157_383_092_827n);
      assert.equal(f.amount1Min, 7_090_495_564_400_360n);
      for (const delta of [-3, -2, -1, 1, 2, 3]) {
        assert.ok(accepts(f, chargedAt(lo, hi, observedTick + delta)), `delta ${delta}`);
      }
      // UP: the undeployed bound ends the band first. These desired amounts
      // already sit 8% undeployed at the reference (token1 scarce), so +40
      // ticks reaches 14.7% (accepted) and +41 crosses 15% (refused).
      assert.ok(accepts(f, chargedAt(lo, hi, observedTick + 20)), "+20 ticks (11.3% undeployed)");
      assert.ok(accepts(f, chargedAt(lo, hi, observedTick + 40)), "+40 ticks (14.7% undeployed)");
      assert.ok(!accepts(f, chargedAt(lo, hi, observedTick + 60)), "+60 ticks exceeds the undeployed bound");
      assert.ok(!accepts(f, chargedAt(lo, hi, observedTick + 300)), "a 3% move is far outside");
      // DOWN: the slippage rail (100 bps) ends the band, undeployed is only ~10%.
      assert.ok(accepts(f, chargedAt(lo, hi, observedTick - 99)), "−99 ticks inside the rail");
      assert.ok(!accepts(f, chargedAt(lo, hi, observedTick - 102)), "−102 ticks outside the rail");
    });

    it("±50% range with the incident's imbalanced legs: REFUSED — token0's charge is flat, no floor can hold the rail (review 2 H2)", () => {
      const liquidity = getLiquidityForAmounts(spot, -70_000, -60_000, amount0Desired, amount1Desired);
      assert.throws(() => sagaMintFloors({
        sqrtPriceX96: spot, tickLower: -70_000, tickUpper: -60_000, liquidity, maxSagaSlippageBps: bps,
        amount0Desired, amount1Desired,
      }), /cannot hold this mint inside the 100 bps slippage rail \(up\)/u);
    });

    it("±50% range with BALANCED legs: floors hold the slippage rail in price", () => {
      const lo = -70_000;
      const hi = -60_000;
      // Balance the legs for this range at the reference: desired = what the
      // reference liquidity charges.
      const l0 = getLiquidityForAmounts(spot, lo, hi, amount0Desired, amount1Desired);
      const balanced = getMintAmountsForLiquidity(spot, lo, hi, l0);
      const f = sagaMintFloors({
        sqrtPriceX96: spot, tickLower: lo, tickUpper: hi, liquidity: l0, maxSagaSlippageBps: bps,
        amount0Desired: balanced.amount0, amount1Desired: balanced.amount1,
      });
      const charged = (tick: number): { amount0: bigint; amount1: bigint } => {
        const sq = getSqrtRatioAtTick(tick);
        const l = getLiquidityForAmounts(sq, lo, hi, balanced.amount0, balanced.amount1);
        return getMintAmountsForLiquidity(sq, lo, hi, l);
      };
      for (const delta of [-90, -3, -1, 1, 3, 90]) assert.ok(accepts(f, charged(observedTick + delta)), `delta ${delta}`);
      for (const delta of [-110, 110]) assert.ok(!accepts(f, charged(observedTick + delta)), `delta ${delta} is outside the 100 bps rail`);
    });

    /**
     * Review 2 H1/H2, made a PROPERTY: for every fixture the floors either
     * refuse, or the whole set of execution prices NFPM would admit (brute
     * forced at 0.1 price-bps over ±(s + 50) bps) keeps undeployed value under
     * MAX_MINT_UNDEPLOYED_BPS and stays inside the rail plus the one-bps
     * haircut allowance. The fixtures include the reviewer's two
     * counterexamples against the previous build.
     */
    it("PROPERTY: whatever the returned floors admit is under 15% undeployed and inside the rail (to 0.01 bps)", () => {
      const fixtures: ReadonlyArray<{ name: string; tick: number; lo: number; hi: number; a0: bigint; a1: bigint }> = [
        { name: "incident 28 ticks", tick: observedTick, lo: -66_416, hi: -66_388, a0: amount0Desired, a1: amount1Desired },
        { name: "wide ±5%", tick: observedTick, lo: -66_900, hi: -65_900, a0: amount0Desired, a1: amount1Desired },
        { name: "wider ±50%", tick: observedTick, lo: -70_000, hi: -60_000, a0: amount0Desired, a1: amount1Desired },
        { name: "review2 H1 [-500,500]", tick: 0, lo: -500, hi: 500, a0: 10n ** 18n, a1: 1_352_900_000_000_000_000n },
        { name: "review2 H1b [-14,14]", tick: 0, lo: -14, hi: 14, a0: 1_058_712_874_510_042_460n, a1: 10n ** 18n },
        { name: "review2 H2 [-100000,100000] imbalanced", tick: 0, lo: -100_000, hi: 100_000, a0: 10n ** 18n, a1: 1_352_900_000_000_000_000n },
        { name: "balanced [-100000,100000]", tick: 0, lo: -100_000, hi: 100_000, a0: 10n ** 18n, a1: 10n ** 18n },
        { name: "review1 1/4 [-14000,14000]", tick: 0, lo: -14_000, hi: 14_000, a0: 10n ** 18n, a1: 4n * 10n ** 18n },
        { name: "review3 B1 [-100000,100000] 0.5% imbalanced", tick: 0, lo: -100_000, hi: 100_000, a0: 989_934_000_000_000_000n, a1: 10n ** 18n },
        { name: "open-shaped: token leg at 99% of balance, ±5%", tick: observedTick, lo: -66_900, hi: -65_900, a0: 0n, a1: 0n },
      ];
      let accepted = 0;
      for (const raw of fixtures) {
        const ref = getSqrtRatioAtTick(raw.tick);
        let fx = raw;
        if (raw.a0 === 0n) {
          // The open's shape: WBNB leg balanced at the reference, token leg
          // = the swap's minOut (1% under balance).
          const balanced = getMintAmountsForLiquidity(ref, raw.lo, raw.hi, getLiquidityForAmounts(ref, raw.lo, raw.hi, amount0Desired, amount1Desired));
          fx = { ...raw, a0: minLpOutFor(balanced.amount0, 9_900), a1: balanced.amount1 };
        }
        const liquidity = getLiquidityForAmounts(ref, fx.lo, fx.hi, fx.a0, fx.a1);
        let f: { amount0Min: bigint; amount1Min: bigint };
        try {
          f = sagaMintFloors({ sqrtPriceX96: ref, tickLower: fx.lo, tickUpper: fx.hi, liquidity, maxSagaSlippageBps: bps, amount0Desired: fx.a0, amount1Desired: fx.a1 });
        } catch (error) {
          assert.match((error as Error).message, /undeployed|cannot hold this mint/u, fx.name);
          continue;
        }
        accepted += 1;
        // 0.1-bps grid over ±(rail + 50) bps, plus a 0.01-bps grid across the
        // rail edge itself (review 3 B1: the previous build admitted a
        // continuum ending at +101.9 bps that a 0.1-bps grid missed).
        const samples: number[] = [];
        for (let x = -(bps + 50) * 10; x <= (bps + 50) * 10; x += 1) samples.push(x * 10);
        for (let x = (bps - 2) * 100; x <= (bps + 3) * 100; x += 1) samples.push(x, -x);
        for (const centi of samples) {
          const x = centi / 10; // in tenths of a bps, as before
          const sqrt = BigInt(Math.floor(Number(ref) * Math.sqrt(1 + centi / 1_000_000)));
          const l = getLiquidityForAmounts(sqrt, fx.lo, fx.hi, fx.a0, fx.a1);
          if (l <= 0n) continue;
          const c = getMintAmountsForLiquidity(sqrt, fx.lo, fx.hi, l);
          if (c.amount0 < f.amount0Min || c.amount1 < f.amount1Min) continue;
          const sq = sqrt * sqrt;
          const chargedValue = c.amount0 * sq + c.amount1 * Q96 * Q96;
          const desiredValue = fx.a0 * sq + fx.a1 * Q96 * Q96;
          assert.ok(chargedValue * 10_000n >= desiredValue * BigInt(10_000 - MAX_MINT_UNDEPLOYED_BPS), `${fx.name}: ${x / 10} bps admitted with > 15% undeployed`);
          assert.ok(Math.abs(x / 10) <= bps + 0.01, `${fx.name}: ${x / 10} bps admitted outside the rail`);
        }
      }
      assert.ok(accepted >= 4, "the property must be exercised on accepted fixtures, not only refusals");
    });

    it("refuses at the reference price when the desired amounts already leave > 15% undeployed", () => {
      const lo = -66_416;
      const hi = -66_388;
      const liquidity = getLiquidityForAmounts(spot, lo, hi, amount0Desired, amount1Desired);
      assert.throws(() => sagaMintFloors({
        sqrtPriceX96: spot, tickLower: lo, tickUpper: hi, liquidity, maxSagaSlippageBps: bps,
        amount0Desired: amount0Desired * 4n, amount1Desired,
      }), /more than 1490 bps of their value undeployed/u);
      assert.throws(() => sagaMintFloors({
        sqrtPriceX96: spot, tickLower: lo, tickUpper: hi, liquidity, maxSagaSlippageBps: bps,
        amount0Desired: -1n, amount1Desired,
      }), /non-negative/u);
    });

    it("keeps the placement guard: an out-of-range observed price still throws", () => {
      const lo = -66_416;
      const hi = -66_388;
      const liquidity = getLiquidityForAmounts(spot, lo, hi, amount0Desired, amount1Desired);
      assert.throws(() => sagaMintFloors({
        sqrtPriceX96: getSqrtRatioAtTick(hi + 10), tickLower: lo, tickUpper: hi, liquidity,
        maxSagaSlippageBps: bps, amount0Desired, amount1Desired,
      }), /two executable token amounts/u);
    });

    it("MAX_MINT_UNDEPLOYED_BPS is the operator's 15%; reserve, dust floor and verify margin are pinned", () => {
      assert.equal(MAX_MINT_UNDEPLOYED_BPS, 1_500);
      assert.equal(MINT_UNDEPLOYED_RESERVE_BPS, 10);
      assert.equal(MIN_MINT_CHARGE_WEI, 10n ** 9n);
      assert.equal(MINT_VERIFY_MARGIN_BPS, 100);
    });

    it("review 3 B1: a flat binding leg that would stay admitted past the rail is REFUSED", () => {
      // Balanced to within 0.5% on a ±100% range: token0 binds and its charge
      // is flat for more than 1% of price, so no per-leg floor can hold the
      // rail. The previous build admitted execution up to +101.9 bps here.
      const ref = Q96;
      const a0 = 989_934_000_000_000_000n;
      const a1 = 10n ** 18n;
      const liquidity = getLiquidityForAmounts(ref, -100_000, 100_000, a0, a1);
      assert.throws(() => sagaMintFloors({
        sqrtPriceX96: ref, tickLower: -100_000, tickUpper: 100_000, liquidity, maxSagaSlippageBps: bps,
        amount0Desired: a0, amount1Desired: a1,
      }), /cannot hold this mint inside the 100 bps slippage rail \(up\)/u);
    });

    it("review 4 B1: a price regime where the token0-liquidity intermediate truncates is refused outright", () => {
      // tick −640000 (price ≈ 1e-28): `sqrtPrice × sqrtUpper / Q96` is 21, and
      // its stepping to 22 re-admitted a mint 964 bps past the rail.
      const ref = getSqrtRatioAtTick(-640_000);
      const a0 = 48n * 10n ** 36n;
      const a1 = 10_000_000_000n;
      const liquidity = getLiquidityForAmounts(ref, -650_000, -630_000, a0, a1);
      assert.throws(() => sagaMintFloors({
        sqrtPriceX96: ref, tickLower: -650_000, tickUpper: -630_000, liquidity, maxSagaSlippageBps: bps,
        amount0Desired: a0, amount1Desired: a1,
      }), /price is too low for the liquidity arithmetic to be bounded/u);
      assert.equal(MIN_LIQUIDITY_INTERMEDIATE, 10n ** 12n);
    });

    it("review 3 B2: a dust mint (12 wei / 1 wei) is refused outright — integer rounding cannot be bounded", () => {
      const ref = getSqrtRatioAtTick(-100_000);
      const liquidity = getLiquidityForAmounts(ref, -100_500, -99_500, 12n, 1n);
      assert.throws(() => sagaMintFloors({
        sqrtPriceX96: ref, tickLower: -100_500, tickUpper: -99_500, liquidity, maxSagaSlippageBps: bps,
        amount0Desired: 12n, amount1Desired: 1n,
      }), /charged less than 1000000000 wei/u);
    });

    it("shiftSqrtPriceX96ByBps moves the PRICE by the given bps and clamps to usable bounds", () => {
      const up = shiftSqrtPriceX96ByBps(Q96, 100, "up");
      const down = shiftSqrtPriceX96ByBps(Q96, 100, "down");
      // price = (sqrt/Q96)^2 ; check to 1e-9 relative.
      const priceUp = (up * up * 10n ** 9n) / (Q96 * Q96);
      const priceDown = (down * down * 10n ** 9n) / (Q96 * Q96);
      // Rounds OUTWARD: up is at or above +1%, down at or below −1% (to 1e-9).
      assert.ok(priceUp >= 1_010_000_000n && priceUp <= 1_010_000_010n, String(priceUp));
      assert.ok(priceDown >= 989_999_990n && priceDown <= 990_000_000n, String(priceDown));
      assert.ok(shiftSqrtPriceX96ByCentiBps(Q96, 10_001, "up") > shiftSqrtPriceX96ByBps(Q96, 100, "up"));
      assert.equal(shiftSqrtPriceX96ByCentiBps(Q96, 10_000, "up"), shiftSqrtPriceX96ByBps(Q96, 100, "up"));
      assert.throws(() => shiftSqrtPriceX96ByCentiBps(Q96, 1_000_001, "up"), /centiBps/u);
      assert.equal(shiftSqrtPriceX96ByBps(Q96, 0, "up"), Q96);
      assert.equal(shiftSqrtPriceX96ByBps(MIN_SQRT_RATIO, 100, "down"), MIN_SQRT_RATIO);
      assert.equal(shiftSqrtPriceX96ByBps(MAX_SQRT_RATIO - 1n, 100, "up"), MAX_SQRT_RATIO - 1n);
      assert.throws(() => shiftSqrtPriceX96ByBps(Q96, 10_001, "up"), /bps/u);
      assert.throws(() => shiftSqrtPriceX96ByBps(Q96, -1, "down"), /bps/u);
    });
  });

  it("sagaDecreaseFloors floors positive legs at 1 wei and leaves a zero leg at zero", () => {
    // In range: both legs positive.
    const inRange = sagaDecreaseFloors({
      sqrtPriceX96: getSqrtRatioAtTick(0),
      tickLower: -600,
      tickUpper: 600,
      liquidity: 10n ** 15n,
      maxSagaSlippageBps: 500,
    });
    assert.ok(inRange.amount0Min >= 1n && inRange.amount1Min >= 1n);

    // Out of range below: all token0 — the token1 min MUST be 0, or every
    // rotate zap-out (which fires exactly when out of range) would revert.
    const below = sagaDecreaseFloors({
      sqrtPriceX96: getSqrtRatioAtTick(-1_000),
      tickLower: -600,
      tickUpper: 600,
      liquidity: 10n ** 15n,
      maxSagaSlippageBps: 500,
    });
    assert.ok(below.amount0Min >= 1n);
    assert.equal(below.amount1Min, 0n);

    // Out of range above: all token1.
    const above = sagaDecreaseFloors({
      sqrtPriceX96: getSqrtRatioAtTick(1_000),
      tickLower: -600,
      tickUpper: 600,
      liquidity: 10n ** 15n,
      maxSagaSlippageBps: 500,
    });
    assert.equal(above.amount0Min, 0n);
    assert.ok(above.amount1Min >= 1n);
  });

  it("sagaDecreaseFloors refuses when BOTH expected legs are zero", () => {
    assert.throws(
      () =>
        sagaDecreaseFloors({
          sqrtPriceX96: getSqrtRatioAtTick(0),
          tickLower: -10,
          tickUpper: 10,
          liquidity: 1n,
          maxSagaSlippageBps: 500,
        }),
      /zero on both legs/u,
    );
  });
});
