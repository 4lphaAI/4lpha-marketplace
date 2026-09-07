/**
 * LP manipulation rails — evidence shapes, pure checks, the rail-config
 * reader, and the saga floor derivations. Ported from `D:\4lpha-0G`
 * `lib/agent/lp/lp-market-rails.ts` + the `manipulationRailFailure` half of
 * `lib/agent/lp/lp-manage.ts`, re-shaped for this plane.
 *
 * PURE AND OFFLINE. Callers pass OBSERVED evidence (finalized-tag chain reads
 * happen elsewhere); nothing here does RPC, reads a clock, or trusts a
 * default. The rails are re-asserted between every saga step.
 *
 * Config discipline (PHASE3 spec body + Rev2 items 18 and 23): ALL of
 * `maxPriceImpactBps`, `maxSpotTwapDeviationBps`, `minObservationCardinality`,
 * `minPoolLiquidity`, `twapWindowSeconds`, `maxSagaSlippageBps` are REQUIRED.
 * A missing or malformed value produces a TYPED hold — never a default,
 * never default-open. This deliberately differs from `src/ops/config.ts`'s
 * fail-the-boot pattern: the rails are consulted per evaluation cycle by a
 * long-running worker, and the spec's stated posture there is "missing ⇒
 * hold".
 */
import {
  flooredAtOneWei,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getMintAmountsForLiquidity,
  getSqrtRatioAtTick,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  minLpOutFor,
  Q96,
} from "./tickMath.js";

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One observation of the pool, taken by the caller at/below the FINALIZED
 * block. `priceImpactBps` is the quoted-vs-spot impact of the leg the saga is
 * about to swap (from {@link quotePriceImpactBps}); `twapSqrtPriceX96` comes
 * from `pool.observe` over the configured window.
 */
export type LpRailEvidence = {
  readonly blockNumber: bigint;
  readonly finalizedBlockNumber: bigint;
  readonly observationCardinality: number;
  readonly poolLiquidity: bigint;
  readonly priceImpactBps: bigint;
  readonly spotSqrtPriceX96: bigint;
  readonly twapSqrtPriceX96: bigint;
};

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

/** The full required rail set. See the module header for why ALL are required. */
export type LpRailConfig = {
  readonly maxPriceImpactBps: number;
  readonly maxSpotTwapDeviationBps: number;
  readonly minObservationCardinality: number;
  readonly minPoolLiquidity: bigint;
  readonly twapWindowSeconds: number;
  /** Rev2 item 23: every autonomous saga leg derives its floors from this. */
  readonly maxSagaSlippageBps: number;
};

/**
 * Ceiling on `maxSagaSlippageBps`. Same rationale as `MAX_MAX_SLIPPAGE_BPS`
 * in `src/ops/config.ts`: past 20% a floor derived from a quote has stopped
 * meaning anything while still appearing to exist.
 */
export const MAX_SAGA_SLIPPAGE_BPS_CEILING = 2_000;

export const LP_RAIL_ENV_KEYS = [
  "LP_MAX_PRICE_IMPACT_BPS",
  "LP_MAX_SPOT_TWAP_DEVIATION_BPS",
  "LP_MIN_OBSERVATION_CARDINALITY",
  "LP_MIN_POOL_LIQUIDITY_WEI",
  "LP_TWAP_WINDOW_SECONDS",
  "LP_MAX_SAGA_SLIPPAGE_BPS",
] as const;

export type LpRailConfigFailure = {
  readonly code: "LP_RAILS_UNCONFIGURED" | "LP_RAILS_INVALID";
  /** Env names that are missing (UNCONFIGURED) or malformed (INVALID). */
  readonly keys: readonly string[];
  readonly reason: string;
};

export type LpRailConfigResult =
  | { readonly ok: true; readonly config: LpRailConfig }
  | { readonly ok: false; readonly failure: LpRailConfigFailure };

/** The environment as a plain readonly record, injected so this stays pure. */
export type LpRailEnv = Readonly<Record<string, string | undefined>>;

/**
 * Structural validation of an already-materialized rail config, shared
 * between the env reader and `evaluateLpTriggers`' input validation (a test
 * may inject a config object directly; it must meet the same bar).
 */
export function assertValidLpRailConfig(config: LpRailConfig): void {
  if (!Number.isInteger(config.maxPriceImpactBps) || config.maxPriceImpactBps < 0) {
    throw new Error("maxPriceImpactBps must be a nonnegative integer.");
  }
  if (!Number.isInteger(config.maxSpotTwapDeviationBps) || config.maxSpotTwapDeviationBps < 0) {
    throw new Error("maxSpotTwapDeviationBps must be a nonnegative integer.");
  }
  if (!Number.isInteger(config.minObservationCardinality) || config.minObservationCardinality < 1) {
    throw new Error("minObservationCardinality must be an integer >= 1.");
  }
  if (typeof config.minPoolLiquidity !== "bigint" || config.minPoolLiquidity <= 0n) {
    throw new Error("minPoolLiquidity must be a positive bigint.");
  }
  if (!Number.isInteger(config.twapWindowSeconds) || config.twapWindowSeconds <= 0) {
    throw new Error("twapWindowSeconds must be a positive integer.");
  }
  if (
    !Number.isInteger(config.maxSagaSlippageBps)
    || config.maxSagaSlippageBps < 1
    || config.maxSagaSlippageBps > MAX_SAGA_SLIPPAGE_BPS_CEILING
  ) {
    throw new Error(
      `maxSagaSlippageBps must be an integer in 1..${MAX_SAGA_SLIPPAGE_BPS_CEILING}.`,
    );
  }
}

/**
 * Read the rail config from the (injected) environment. EVERY key is
 * required; a missing one is a typed `LP_RAILS_UNCONFIGURED` hold and a
 * malformed one a typed `LP_RAILS_INVALID` hold. There are NO defaults —
 * a rail that defaults is a rail that silently stopped existing.
 */
export function resolveLpRailConfig(env: LpRailEnv): LpRailConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];

  const raw = (name: string): string | undefined => {
    const value = env[name]?.trim();
    if (value === undefined || value === "") {
      missing.push(name);
      return undefined;
    }
    return value;
  };

  const readInt = (name: string, min: number, max: number): number | undefined => {
    const value = raw(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      invalid.push(name);
      return undefined;
    }
    return parsed;
  };

  const readBigInt = (name: string): bigint | undefined => {
    const value = raw(name);
    if (value === undefined) return undefined;
    if (!/^\d+$/u.test(value)) {
      invalid.push(name);
      return undefined;
    }
    const parsed = BigInt(value);
    if (parsed <= 0n) {
      invalid.push(name);
      return undefined;
    }
    return parsed;
  };

  const maxPriceImpactBps = readInt("LP_MAX_PRICE_IMPACT_BPS", 0, 10_000);
  const maxSpotTwapDeviationBps = readInt("LP_MAX_SPOT_TWAP_DEVIATION_BPS", 0, 10_000);
  const minObservationCardinality = readInt("LP_MIN_OBSERVATION_CARDINALITY", 1, 65_535);
  const minPoolLiquidity = readBigInt("LP_MIN_POOL_LIQUIDITY_WEI");
  const twapWindowSeconds = readInt("LP_TWAP_WINDOW_SECONDS", 1, 86_400);
  const maxSagaSlippageBps = readInt("LP_MAX_SAGA_SLIPPAGE_BPS", 1, MAX_SAGA_SLIPPAGE_BPS_CEILING);

  if (missing.length > 0) {
    return {
      ok: false,
      failure: {
        code: "LP_RAILS_UNCONFIGURED",
        keys: missing,
        reason: `LP manipulation rails are not configured; missing: ${missing.join(", ")}. Automation holds.`,
      },
    };
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      failure: {
        code: "LP_RAILS_INVALID",
        keys: invalid,
        reason: `LP manipulation-rail values are malformed: ${invalid.join(", ")}. Automation holds.`,
      },
    };
  }

  if (
    maxPriceImpactBps === undefined
    || maxSpotTwapDeviationBps === undefined
    || minObservationCardinality === undefined
    || minPoolLiquidity === undefined
    || twapWindowSeconds === undefined
    || maxSagaSlippageBps === undefined
  ) {
    // Unreachable: every undefined pushed into `missing` or `invalid` above.
    throw new Error("resolveLpRailConfig: internal consistency failure.");
  }
  const config: LpRailConfig = {
    maxPriceImpactBps,
    maxSpotTwapDeviationBps,
    minObservationCardinality,
    minPoolLiquidity,
    twapWindowSeconds,
    maxSagaSlippageBps,
  };
  assertValidLpRailConfig(config);
  return { ok: true, config };
}

/* -------------------------------------------------------------------------- */
/* The rails themselves                                                       */
/* -------------------------------------------------------------------------- */

export type LpRailFailureCode =
  | "OBSERVATION_NOT_FINALIZED"
  | "OBSERVATION_CARDINALITY_LOW"
  | "POOL_LIQUIDITY_LOW"
  | "SPOT_TWAP_DEVIATION_EXCEEDED"
  | "PRICE_IMPACT_EXCEEDED";

export type LpRailFailure = {
  readonly code: LpRailFailureCode;
  readonly reason: string;
};

/**
 * The pure rail check, ported from 0G `manipulationRailFailure`. Returns the
 * FIRST tripped rail (order matters: an unfinalized observation invalidates
 * everything downstream of it) or `undefined` when all rails pass.
 *
 * Reason strings are kept byte-compatible with the 0G originals so the
 * hold-reason regexes in ported tests carry over.
 */
export function checkManipulationRails(
  evidence: LpRailEvidence,
  config: LpRailConfig,
): LpRailFailure | undefined {
  if (evidence.blockNumber > evidence.finalizedBlockNumber) {
    return {
      code: "OBSERVATION_NOT_FINALIZED",
      reason: "Trigger observation is not finalized.",
    };
  }
  if (evidence.observationCardinality < config.minObservationCardinality) {
    return {
      code: "OBSERVATION_CARDINALITY_LOW",
      reason: "Pool observation cardinality is below the manipulation-rail minimum.",
    };
  }
  if (evidence.poolLiquidity < config.minPoolLiquidity) {
    return {
      code: "POOL_LIQUIDITY_LOW",
      reason: "Pool liquidity is below the manipulation-rail minimum.",
    };
  }
  const deviation = priceDeviationBps(evidence.spotSqrtPriceX96, evidence.twapSqrtPriceX96);
  if (deviation > BigInt(config.maxSpotTwapDeviationBps)) {
    return {
      code: "SPOT_TWAP_DEVIATION_EXCEEDED",
      reason: "Spot/TWAP deviation exceeds the manipulation-rail ceiling.",
    };
  }
  if (evidence.priceImpactBps > BigInt(config.maxPriceImpactBps)) {
    return {
      code: "PRICE_IMPACT_EXCEEDED",
      reason: "Quoted price impact exceeds the manipulation-rail ceiling.",
    };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Price arithmetic (0G lp-market-rails ports)                                */
/* -------------------------------------------------------------------------- */

const Q192 = 1n << 192n;

/**
 * TWAP mean tick from a tickCumulative delta over `seconds`, flooring toward
 * negative infinity exactly as the pool's oracle library does.
 */
export function arithmeticMeanTick(delta: bigint, seconds: bigint): number {
  if (seconds <= 0n) throw new Error("TWAP duration must be positive.");
  let quotient = delta / seconds;
  if (delta < 0n && delta % seconds !== 0n) quotient -= 1n;
  const result = Number(quotient);
  if (!Number.isSafeInteger(result)) throw new Error("TWAP tick is outside the safe integer range.");
  return result;
}

/**
 * Symmetric price deviation in bps between two sqrtPriceX96 values, measured
 * on the SQUARED prices (i.e. actual token1/token0 prices) against the
 * smaller of the two.
 */
export function priceDeviationBps(leftSqrtPriceX96: bigint, rightSqrtPriceX96: bigint): bigint {
  if (leftSqrtPriceX96 <= 0n || rightSqrtPriceX96 <= 0n) {
    throw new Error("Price-deviation inputs must be positive.");
  }
  const left = leftSqrtPriceX96 * leftSqrtPriceX96;
  const right = rightSqrtPriceX96 * rightSqrtPriceX96;
  const denominator = left < right ? left : right;
  const difference = left > right ? left - right : right - left;
  return (difference * 10_000n) / denominator;
}

/**
 * The zero-impact output a swap WOULD produce at the current spot price.
 * Compared against the venue quote by {@link quotePriceImpactBps}.
 */
export function spotSwapOutput(input: {
  amountInAfterFee: bigint;
  sqrtPriceX96: bigint;
  tokenInIsToken0: boolean;
}): bigint {
  if (input.amountInAfterFee <= 0n || input.sqrtPriceX96 <= 0n) return 0n;
  const priceSquared = input.sqrtPriceX96 * input.sqrtPriceX96;
  return input.tokenInIsToken0
    ? (input.amountInAfterFee * priceSquared) / Q192
    : (input.amountInAfterFee * Q192) / priceSquared;
}

/** V3 fee tiers are MILLIONTHS (PHASE3 Rev2 item 38): 10000 = 1%. */
const V3_FEE_DENOMINATOR = 1_000_000n;

/**
 * The input a swap actually trades AFTER the pool takes its own fee —
 * `amountIn × (1e6 − feeTier) / 1e6`.
 *
 * ERRATUM TO AUDIT A2'S FIX (PHASE3.1 Rev2 item 16), and the reason this
 * function exists at all. {@link spotSwapOutput} names its parameter
 * `amountInAfterFee`, but every A2 call site fed it the RAW `amountIn`, so the
 * POOL'S ADVERTISED FEE landed inside {@link quotePriceImpactBps} and was
 * reported as manipulation. Measured on the live CAKE/WBNB tiers for the exact
 * leg FINDINGS (ag) returned (`603 777 753 500 127 217` wei):
 *
 * ```
 *   feeTier      100     500    2500    10000
 *   impactBps      1       5      25      103     <- fee, essentially in full
 * ```
 *
 * The deployment's own `.env` sets `LP_MAX_PRICE_IMPACT_BPS=100`, so a
 * position in a 1% pool could NEVER exit to its quote asset — and under Rev2
 * item 11 that refusal is a SKIP, i.e. silent and permanent. Deducting the fee
 * first is a deliberate LOOSENING of a manipulation rail and a correct one: a
 * pool's advertised fee is not manipulation, execution stays bounded by
 * {@link sagaSwapMinOut} against a fresh quote, and the spot-vs-TWAP deviation
 * and liquidity rails are untouched.
 *
 * Applied at the exit swap and at `makeSweepStep` (`src/lp/sagas.ts`), the two
 * sites Rev2 item 16 enumerates, so they cannot diverge. `/lp/open`'s own
 * impact check is DELIBERATELY left strict — see the note there.
 */
export function amountInAfterPoolFee(amountInWei: bigint, feeTier: number): bigint {
  if (amountInWei < 0n) {
    throw new Error("amountInAfterPoolFee: amountInWei must be nonnegative.");
  }
  if (
    !Number.isInteger(feeTier)
    || feeTier <= 0
    || BigInt(feeTier) >= V3_FEE_DENOMINATOR
  ) {
    throw new Error(
      "amountInAfterPoolFee: feeTier must be a positive V3 fee tier in MILLIONTHS below 1e6.",
    );
  }
  return (amountInWei * (V3_FEE_DENOMINATOR - BigInt(feeTier))) / V3_FEE_DENOMINATOR;
}

/**
 * Impact of a quoted output vs the spot-implied output, in bps of the spot
 * expectation. A quote at or above spot is zero impact.
 *
 * `expectedAtSpot` MUST be computed from {@link amountInAfterPoolFee}, not the
 * raw input — otherwise this reports the pool's own fee as impact (Rev2 item
 * 16's erratum).
 */
export function quotePriceImpactBps(expectedAtSpot: bigint, quotedOutput: bigint): bigint {
  if (expectedAtSpot <= 0n || quotedOutput >= expectedAtSpot) return 0n;
  return ((expectedAtSpot - quotedOutput) * 10_000n) / expectedAtSpot;
}

/* -------------------------------------------------------------------------- */
/* Saga floor derivations (Rev2 item 23)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Minimum acceptable output for a saga swap leg, derived from a FRESH quote
 * and the rail slippage. Zero/absent floors are a build error, not a default
 * (Rev2 item 23), so a non-positive quote THROWS instead of producing a
 * disabled floor.
 */
export function sagaSwapMinOut(quotedOut: bigint, maxSagaSlippageBps: number): bigint {
  assertSlippage(maxSagaSlippageBps);
  if (quotedOut <= 0n) {
    throw new Error("sagaSwapMinOut: a saga swap floor requires a positive fresh quote.");
  }
  return flooredAtOneWei(minLpOutFor(quotedOut, 10_000 - maxSagaSlippageBps));
}

/** Integer square root (floor) for non-negative bigints. */
function bigintSqrtFloor(value: bigint): bigint {
  if (value < 0n) throw new Error("bigintSqrtFloor: negative input.");
  if (value < 2n) return value;
  let x = BigInt(Math.floor(Math.sqrt(Number(value))));
  if (x <= 0n) x = 1n;
  // Newton refinement — the float seed is within a few ulps for the sizes
  // used here (≤ 2^160), two or three steps settle it exactly.
  for (;;) {
    const next = (x + value / x) >> 1n;
    if (next >= x) {
      // Converged from above or below; make sure x*x <= value < (x+1)^2.
      while (x * x > value) x -= 1n;
      while ((x + 1n) * (x + 1n) <= value) x += 1n;
      return x;
    }
    x = next;
  }
}

const SHIFT_SCALE = 10n ** 18n;

/**
 * The pool sqrtPrice after a price move of `bps` basis points in the given
 * direction: `sqrtP × sqrt(1 ± bps/10_000)`, computed in integer arithmetic
 * (the factor is scaled by 1e18 and square-rooted at 1e36), clamped to the
 * usable sqrt-ratio bounds.
 *
 * Rounding is DIRECTION-AWARE (review 3 B1 / review 1 L4): "up" rounds the
 * factor and the product UP, "down" rounds them DOWN, so the returned price
 * is never INSIDE the stated move. A floor derived from the charge at that
 * price therefore admits the exact `bps` boundary (token0's charge falls
 * with price, token1's rises) and the excess it can admit beyond it is one
 * unit of sqrtPriceX96 rounding, not a sampling gap.
 */
export function shiftSqrtPriceX96ByBps(
  sqrtPriceX96: bigint,
  bps: number,
  direction: "up" | "down",
): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error("shiftSqrtPriceX96ByBps: bps must be an integer in 0..10000.");
  }
  return shiftSqrtPriceX96ByCentiBps(sqrtPriceX96, bps * 100, direction);
}

/**
 * {@link shiftSqrtPriceX96ByBps} at 1/100 bps resolution (1e-6 of price).
 * The floor verification samples the rail edge at this resolution: it is
 * ~100× finer than one tick, and still coarse enough that a leg which really
 * falls with price drops by far more than integer rounding across one step
 * at any {@link MIN_MINT_CHARGE_WEI}-sized mint.
 */
export function shiftSqrtPriceX96ByCentiBps(
  sqrtPriceX96: bigint,
  centiBps: number,
  direction: "up" | "down",
): bigint {
  if (!Number.isInteger(centiBps) || centiBps < 0 || centiBps > 1_000_000) {
    throw new Error("shiftSqrtPriceX96ByCentiBps: centiBps must be an integer in 0..1000000.");
  }
  const ratio = direction === "up" ? 1_000_000n + BigInt(centiBps) : 1_000_000n - BigInt(centiBps);
  // sqrt(ratio / 1e6) scaled by 1e18 = sqrt(ratio * 1e36 / 1e6)
  const radicand = (ratio * SHIFT_SCALE * SHIFT_SCALE) / 1_000_000n;
  const floorFactor = bigintSqrtFloor(radicand);
  const factor = direction === "up" && floorFactor * floorFactor < radicand
    ? floorFactor + 1n
    : floorFactor;
  const product = sqrtPriceX96 * factor;
  const shifted = direction === "up"
    ? (product + SHIFT_SCALE - 1n) / SHIFT_SCALE
    : product / SHIFT_SCALE;
  // Usable bounds: MIN_SQRT_RATIO is a valid pool price, MAX_SQRT_RATIO is
  // not (tickMath.ts: "MAX_SQRT_RATIO - 1 is the max usable price").
  if (shifted < MIN_SQRT_RATIO) return MIN_SQRT_RATIO;
  if (shifted >= MAX_SQRT_RATIO) return MAX_SQRT_RATIO - 1n;
  return shifted;
}

/**
 * The most of the DESIRED value a two-sided mint may leave undeployed in the
 * wallet, in bps of that value, before the floors refuse it (operator ruling
 * 2026-09-06: 15%). Same shape as `SWAPLESS_MAX_RESIDUE_BPS`: a constant read
 * at ONE seam, not a knob.
 *
 * Why it exists: the rotate's sweep balances the legs at ITS price and the
 * mint executes a block or more later. On a narrow range the ratio the pool
 * wants moves several percent per tick, so the mint charges only the part of
 * the desired amounts that fits the NEW ratio and the rest stays in the
 * wallet. The valuation reads the NFT only, so undeployed capital reads as a
 * loss to TP/SL (review finding H1). Until residue is accounted for in the
 * lineage (separate phase), this bound caps the phantom loss.
 */
export const MAX_MINT_UNDEPLOYED_BPS = 1_500;

/**
 * The part of {@link MAX_MINT_UNDEPLOYED_BPS} the floor derivation keeps in
 * hand for its own approximations — the 1-bps sampling of the price band and
 * the edge haircut — so that what the RETURNED floors admit still sits under
 * the full bound. The band is scanned against `1500 − 10 = 1490` bps and the
 * admitted set is then verified against 1500.
 */
export const MINT_UNDEPLOYED_RESERVE_BPS = 10;

/**
 * The smallest charge (per leg, at the reference price) a two-sided mint may
 * carry through {@link sagaMintFloors}. Below it, integer liquidity and the
 * pool's round-UP of charges are no longer negligible against the amounts
 * (review 3 B2: a 12-wei / 1-wei mint has DISCONNECTED admission regions),
 * and no floor derived from charges can bound such a mint. 1e9 wei is 1e-9
 * of an 18-decimal token: every real mint clears it by many orders of
 * magnitude; only dust fixtures do not.
 */
export const MIN_MINT_CHARGE_WEI = 10n ** 9n;

/**
 * How far past the slippage rail the floor verification keeps sampling, in
 * price bps. A flat binding leg (imbalanced desired amounts on a wide range)
 * can dip below its floor by rounding at one sample and clear it again at
 * the next, so the verification must look PAST the first refused sample to
 * see that such a mint is still admitted beyond the rail.
 */
export const MINT_VERIFY_MARGIN_BPS = 100;

/**
 * Review 4 B1. `getLiquidityForAmount0` truncates the intermediate
 * `sqrtPrice × sqrtUpper / Q96` BEFORE dividing, so its relative error is
 * `1 / intermediate` — independent of how large the amounts are. At any
 * price a real pool trades at, that intermediate is ~1e28 and the error is
 * nothing; at the reviewer's fixture (tick −640000, price ≈ 1e-28) it was 21,
 * and stepping from 21 to 22 re-admitted a mint 964 bps past the rail. A
 * two-sided mint whose intermediate anywhere in the verified window is below
 * this is refused: the admitted set cannot be bounded there.
 */
export const MIN_LIQUIDITY_INTERMEDIATE = 10n ** 12n;

/**
 * `amount0Min`/`amount1Min` for a two-sided mint or increaseLiquidity,
 * floored at 1 wei (Rev2 item 23).
 *
 * A zap-in always targets a TWO-SIDED in-range mint (the sweep step balanced
 * the legs first), so an expected zero leg AT THE RAIL-CHECKED PRICE means the
 * price left the range between quote and floor derivation — THROW, exactly
 * as the 0G `quoteLpMint` did, rather than emit a meaningless 1-wei floor for
 * a leg the mint will not charge. That placement check is unchanged.
 *
 * WHAT THE FLOORS EXPRESS (LP-ROTATE-MINT-FLOORS, 2026-09-06, live incident
 * on `lp-agent-01`, independent review by GPT-6 Astra):
 *
 * The floors used to be `expected_i × (1 − s)` per leg — a tolerance on the
 * RATIO of the two legs, not on the price. On a 28-tick range a one-tick move
 * (0.01%) shifts the charged split by ~7%, so the 1% haircut was violated by
 * the ordinary drift between the finalized block the price was read at and
 * the block the relay simulated in, and the mint was refused deterministically
 * (three rotate attempts, and the open before it twice).
 *
 * NFPM re-derives liquidity from the DESIRED amounts at the execution price
 * and charges what that liquidity needs; the rest stays in the wallet. So a
 * floor is a statement about which execution prices are acceptable, and two
 * things bound that set:
 *
 *   1. price movement ≤ `maxSagaSlippageBps` (the operator's rail), and
 *   2. undeployed value ≤ `MAX_MINT_UNDEPLOYED_BPS` of the desired value
 *      (review H1: capital left in the wallet reads as a loss to TP/SL, which
 *      values the NFT only, so it is capped until residue is accounted for).
 *
 * The acceptable band is scanned outward from the rail-checked price one
 * basis point of PRICE at a time (≈ one tick) in each direction, stopping at
 * the first step that violates either bound; `amount0Min` is what the mint
 * charges at the top of the band (token0 charged falls as price rises) and
 * `amount1Min` at its bottom, exactly. The legacy
 * per-leg haircut is GONE (review 2 H1: keeping it as a MIN let the returned
 * floors admit prices the scan had rejected), so a wide range is now held to
 * the slippage rail in PRICE rather than to 1% per leg — a tightening for
 * `/lp/open` and the harvest increase that is the rail's own meaning.
 *
 * The floors are then VERIFIED, because they — not the scan — are what NFPM
 * enforces: in each direction the admitted prices form one interval from the
 * reference (token0's charge never rises with price, token1's never falls),
 * and every 1-bps sample of it must sit under the FULL undeployed bound and
 * inside the rail. A mint whose interval is still open past the rail is
 * REFUSED: its binding leg's charge is flat in
 * price (imbalanced desired amounts on a wide range, review 2 H2), and no
 * per-leg minimum can hold it. Between two samples the undeployed share is
 * quasi-convex in price (it falls toward the balanced ratio and rises away
 * from it — review 2 residuals), so its maximum over the admitted interval
 * sits at the interval's ends, which ARE samples; the
 * `MINT_UNDEPLOYED_RESERVE_BPS` the scan keeps back covers integer rounding,
 * not a continuum gap. Mints too small for rounding to be negligible are
 * refused outright (`MIN_MINT_CHARGE_WEI`).
 *
 * Kept deliberately: the band is quantised to 1-bps steps and rounds down, so
 * an execution price fractionally inside the true bound can still be refused
 * (refusal is the safe side; the next cycle retries at a fresh price).
 *
 * `amount0Desired`/`amount1Desired` are REQUIRED and MUST be exactly the
 * amounts the caller passes to the mint (review M3: liquidity must be
 * re-derived from them at each scanned price, as NFPM does, because a moved
 * price changes which leg is scarce). The caller's `liquidity` is used only
 * for the reference-price placement check and the legacy haircut.
 */
export function sagaMintFloors(input: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  maxSagaSlippageBps: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
}): { amount0Min: bigint; amount1Min: bigint } {
  assertSlippage(input.maxSagaSlippageBps);
  if (input.liquidity <= 0n) {
    throw new Error("sagaMintFloors: liquidity must be positive.");
  }
  if (input.amount0Desired < 0n || input.amount1Desired < 0n) {
    throw new Error("sagaMintFloors: desired amounts must be non-negative.");
  }
  const expected = getMintAmountsForLiquidity(
    input.sqrtPriceX96,
    input.tickLower,
    input.tickUpper,
    input.liquidity,
  );
  if (expected.amount0 <= 0n || expected.amount1 <= 0n) {
    throw new Error(
      "sagaMintFloors: the rail-checked price does not produce two executable token amounts.",
    );
  }
  const chargedAt = (sqrt: bigint): { amount0: bigint; amount1: bigint } => {
    const liquidity = getLiquidityForAmounts(
      sqrt,
      input.tickLower,
      input.tickUpper,
      input.amount0Desired,
      input.amount1Desired,
    );
    if (liquidity <= 0n) return { amount0: 0n, amount1: 0n };
    return getMintAmountsForLiquidity(sqrt, input.tickLower, input.tickUpper, liquidity);
  };
  // Undeployed share, in token1 units at the scanned price p = (sqrt/Q96)^2:
  //   charged0·p + charged1  vs  desired0·p + desired1
  // compared as  (charged0·sqrt² + charged1·Q96²) · 10_000
  //           >= (desired0·sqrt² + desired1·Q96²) · (10_000 − bound)
  const q96sq = Q96 * Q96;
  const undeployedWithin = (
    sqrt: bigint,
    charged: { amount0: bigint; amount1: bigint },
    boundBps: number,
  ): boolean => {
    const sq = sqrt * sqrt;
    const chargedValue = charged.amount0 * sq + charged.amount1 * q96sq;
    const desiredValue = input.amount0Desired * sq + input.amount1Desired * q96sq;
    return chargedValue * 10_000n >= desiredValue * BigInt(10_000 - boundBps);
  };
  // The SCAN runs against the bound minus a reserve; the VERIFICATION below
  // runs against the full bound. The reserve is what the edge haircut and the
  // 1-bps sampling are allowed to consume (review 2 H1: the returned floors,
  // not the scan, are what admit an execution price, so the bound must hold
  // on what they admit).
  const scanBound = MAX_MINT_UNDEPLOYED_BPS - MINT_UNDEPLOYED_RESERVE_BPS;
  // Review 4 B1: the token0-liquidity intermediate at the LOWEST price the
  // verification will look at (the down edge of rail + margin) — it grows
  // with price, so this is its minimum over the window.
  const lowestSqrt = shiftSqrtPriceX96ByBps(
    input.sqrtPriceX96,
    Math.min(10_000, input.maxSagaSlippageBps + MINT_VERIFY_MARGIN_BPS),
    "down",
  );
  const intermediate = (lowestSqrt * getSqrtRatioAtTick(input.tickUpper)) / Q96;
  if (intermediate < MIN_LIQUIDITY_INTERMEDIATE) {
    throw new Error(
      `sagaMintFloors: the pool price is too low for the liquidity arithmetic to be bounded (intermediate ${intermediate} < ${MIN_LIQUIDITY_INTERMEDIATE}); refusing the mint.`,
    );
  }
  const atReference = chargedAt(input.sqrtPriceX96);
  if (atReference.amount0 < MIN_MINT_CHARGE_WEI || atReference.amount1 < MIN_MINT_CHARGE_WEI) {
    throw new Error(
      `sagaMintFloors: a leg would be charged less than ${MIN_MINT_CHARGE_WEI} wei at the rail-checked price; integer rounding could not be bounded, refusing the mint.`,
    );
  }
  if (!undeployedWithin(input.sqrtPriceX96, atReference, scanBound)) {
    throw new Error(
      `sagaMintFloors: the desired amounts would leave more than ${scanBound} bps of their value undeployed at the rail-checked price; refusing the mint.`,
    );
  }
  // Walk the band one price-bps at a time; keep the last acceptable charge.
  const bandEdge = (direction: "up" | "down"): { amount0: bigint; amount1: bigint } => {
    let last = atReference;
    for (let bps = 1; bps <= input.maxSagaSlippageBps; bps += 1) {
      const sqrt = shiftSqrtPriceX96ByBps(input.sqrtPriceX96, bps, direction);
      const charged = chargedAt(sqrt);
      if (!undeployedWithin(sqrt, charged, scanBound)) break;
      last = charged;
    }
    return last;
  };
  const top = bandEdge("up");
  const bottom = bandEdge("down");
  // The floors are the EXACT edge charges (review 3 B1 removed the 1-bps
  // edge haircut: any haircut admits an interval PAST the edge whose end is
  // not a sample). `shiftSqrtPriceX96ByBps` rounds outward, so the edge
  // price is at or beyond the k-th step, the charge there is at or below
  // the pool's charge anywhere inside the band, and what a floor admits past
  // the edge is bounded by one unit of sqrtPriceX96 rounding.
  // MIN with the reference charge: the pool rounds each charge UP, so along
  // a flat binding leg the charge can wobble by a few wei in either direction
  // and an edge charge a few wei ABOVE the reference would refuse the very
  // price the floors were derived at. The wobble is bounded by rounding
  // (MIN_MINT_CHARGE_WEI makes it < 1e-9 of the amount), which is the same
  // one-unit allowance the shift already carries.
  const minWei = (a: bigint, b: bigint): bigint => (a < b ? a : b);
  const floors = {
    amount0Min: flooredAtOneWei(minWei(top.amount0, atReference.amount0)),
    amount1Min: flooredAtOneWei(minWei(bottom.amount1, atReference.amount1)),
  };
  // VERIFY the floors, not the scan (review 2 H1/H2). NFPM admits any
  // execution price at which BOTH charged amounts clear their floors. Along
  // a price move, token0's charge never rises and token1's never falls, so
  // in each direction the admitted prices form one interval starting at the
  // reference; walk it 1 bps at a time until a floor breaks and require, at
  // every admitted sample, the FULL undeployed bound and the slippage rail
  // (plus one sample for the haircut). If the interval is still open past
  // the rail, the per-leg minima cannot bound this mint — the binding leg's
  // charge is flat in price (review 2 H2: imbalanced desired amounts on a
  // wide range) — and the mint is REFUSED rather than sent with floors that
  // mean nothing.
  const admits = (charged: { amount0: bigint; amount1: bigint }): boolean =>
    charged.amount0 >= floors.amount0Min && charged.amount1 >= floors.amount1Min;
  if (!admits(atReference)) {
    throw new Error(
      "sagaMintFloors: the derived floors would refuse the rail-checked price itself; refusing the mint.",
    );
  }
  // The walk does NOT stop at the first refused sample (review 3 B2): along
  // a flat binding leg the pool's round-UP makes the charge wobble by a few
  // wei, so a single refused sample proves nothing about the samples beyond
  // it. Every sample out to the rail plus MINT_VERIFY_MARGIN_BPS is checked;
  // any admitted sample past the rail refuses the mint. A leg that really
  // falls with price drops by far more than rounding within one bps of its
  // edge and never re-admits; only a flat leg can, and that is the case the
  // refusal exists for.
  const cannotHold = (direction: "up" | "down"): never => {
    throw new Error(
      `sagaMintFloors: the pool's per-leg minima cannot hold this mint inside the ${input.maxSagaSlippageBps} bps slippage rail (${direction}); the desired amounts are too imbalanced for the range. Refusing the mint.`,
    );
  };
  for (const direction of ["up", "down"] as const) {
    // (a) The rail edge itself, at 1/100-bps resolution (review 3 B1): the
    // leg that bounds this direction falls monotonically with the move, so
    // if it still clears its floor one step PAST the rail, the floors admit a
    // continuum beyond the rail — a flat binding leg — and no sample walk
    // would find its end. Refuse.
    const justPastRail = shiftSqrtPriceX96ByCentiBps(
      input.sqrtPriceX96,
      input.maxSagaSlippageBps * 100 + 1,
      direction,
    );
    if (admits(chargedAt(justPastRail))) cannotHold(direction);
    // (b) Every whole-bps sample inside the rail must respect the FULL bound,
    // and (belt and braces for rounding wobble on a flat leg) no sample out
    // to the margin may be admitted.
    for (let bps = 1; bps <= input.maxSagaSlippageBps + MINT_VERIFY_MARGIN_BPS; bps += 1) {
      const sqrt = shiftSqrtPriceX96ByBps(input.sqrtPriceX96, bps, direction);
      const charged = chargedAt(sqrt);
      if (!admits(charged)) continue;
      if (bps > input.maxSagaSlippageBps) cannotHold(direction);
      if (!undeployedWithin(sqrt, charged, MAX_MINT_UNDEPLOYED_BPS)) {
        throw new Error(
          `sagaMintFloors: an execution price ${bps} bps ${direction} would clear the floors yet leave more than ${MAX_MINT_UNDEPLOYED_BPS} bps of the desired value undeployed. Refusing the mint.`,
        );
      }
    }
  }
  return floors;
}

/**
 * PHASE3.13 (F6): the swapless rotate's mint floors — the SINGLE-SIDED twin of
 * {@link sagaMintFloors}, which is left untouched because it guards three other
 * callers (`/lp/open`, the harvest increase, and the swapped rotate) where a
 * one-sided expectation really is the price leaving the range mid-build.
 *
 * The assertion is on the EXPECTED amounts, not on the caller's balances, and
 * the distinction is the whole of F6. Under swapless the caller's off-side
 * balance is NEVER zero — the zap-out's `collect` returns fees on both legs, so
 * a function asserting "the absent leg is zero" against the balances would
 * throw on every swapless mint. What IS zero is what the POOL will charge:
 * for a range strictly on the declared side, `getMintAmountsForLiquidity`
 * returns zero on the other leg by construction. Asserting that is a genuine
 * placement check — it fires exactly when the range contains the tick, which is
 * the shape that would be sized by the dust leg.
 *
 * The caller separately passes `desired = 0n` AND `min = 0n` on the off-side
 * leg. That is a deliberate DROP of the residue (bounded by
 * `SWAPLESS_MAX_RESIDUE_BPS`), not an assertion about it, and
 * `validateDepositLeg` (`src/ops/nfpm.ts`) refuses both of the other shapes:
 * `desired > 0 && min <= 0`, and `desired === 0 && min > 0`.
 *
 * Same documented-delta pattern as {@link sagaDecreaseFloors}: the 1-wei floor
 * applies only to the leg with a positive expectation; the absent leg carries a
 * zero min, because there is nothing there for slippage to take.
 */
export function sagaSingleSidedMintFloors(input: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  maxSagaSlippageBps: number;
  /** Which leg the range charges: `"above"` = token0 only, `"below"` = token1 only. */
  side: "above" | "below";
}): { amount0Min: bigint; amount1Min: bigint } {
  assertSlippage(input.maxSagaSlippageBps);
  if (input.liquidity <= 0n) {
    throw new Error("sagaSingleSidedMintFloors: liquidity must be positive.");
  }
  const expected = getMintAmountsForLiquidity(
    input.sqrtPriceX96,
    input.tickLower,
    input.tickUpper,
    input.liquidity,
  );
  const present = input.side === "above" ? expected.amount0 : expected.amount1;
  const absent = input.side === "above" ? expected.amount1 : expected.amount0;
  // ORDER MATTERS, and it is about which sentence an operator reads. A zero
  // PRESENT leg means the side was derived on the wrong side of the price —
  // report that first. Both legs positive means the range contains the tick,
  // which is the placement failure.
  if (present <= 0n) {
    throw new Error(
      "sagaSingleSidedMintFloors: the rail-checked price expects nothing on the declared side; refusing a floorless mint.",
    );
  }
  if (absent !== 0n) {
    throw new Error(
      "sagaSingleSidedMintFloors: the rail-checked price expects both legs, so this range is not strictly on the declared side; refusing a single-sided mint into a range that contains the tick.",
    );
  }
  const keepBps = 10_000 - input.maxSagaSlippageBps;
  const floor = flooredAtOneWei(minLpOutFor(present, keepBps));
  return input.side === "above"
    ? { amount0Min: floor, amount1Min: 0n }
    : { amount0Min: 0n, amount1Min: floor };
}

/**
 * `amount0Min`/`amount1Min` for a decreaseLiquidity, from
 * `getAmountsForLiquidity` at the rail-checked price + `minLpOutFor`
 * (Rev2 item 23).
 *
 * DELIBERATE DELTA from the mint side, reported in the phase notes: a rotate
 * zap-out fires exactly when the position is OUT of range, where one leg's
 * expected amount is genuinely zero. Flooring that leg at 1 wei would make
 * every out-of-range decrease revert on the price-slippage check, so the
 * 1-wei floor applies only to legs with a positive expectation; a zero leg
 * carries a zero min (there is nothing there for slippage to take).
 */
export function sagaDecreaseFloors(input: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  maxSagaSlippageBps: number;
}): { amount0Min: bigint; amount1Min: bigint } {
  assertSlippage(input.maxSagaSlippageBps);
  if (input.liquidity <= 0n) {
    throw new Error("sagaDecreaseFloors: liquidity must be positive.");
  }
  const expected = getAmountsForLiquidity(
    input.sqrtPriceX96,
    input.tickLower,
    input.tickUpper,
    input.liquidity,
  );
  if (expected.amount0 <= 0n && expected.amount1 <= 0n) {
    throw new Error(
      "sagaDecreaseFloors: the rail-checked price expects zero on both legs; refusing a floorless decrease.",
    );
  }
  const keepBps = 10_000 - input.maxSagaSlippageBps;
  return {
    amount0Min: expected.amount0 > 0n
      ? flooredAtOneWei(minLpOutFor(expected.amount0, keepBps))
      : 0n,
    amount1Min: expected.amount1 > 0n
      ? flooredAtOneWei(minLpOutFor(expected.amount1, keepBps))
      : 0n,
  };
}

function assertSlippage(maxSagaSlippageBps: number): void {
  if (
    !Number.isInteger(maxSagaSlippageBps)
    || maxSagaSlippageBps < 1
    || maxSagaSlippageBps > MAX_SAGA_SLIPPAGE_BPS_CEILING
  ) {
    throw new Error(
      `maxSagaSlippageBps must be an integer in 1..${MAX_SAGA_SLIPPAGE_BPS_CEILING}.`,
    );
  }
}
