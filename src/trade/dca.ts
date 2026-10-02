/**
 * Auto DCA — the PURE core (AUTO-DCA-SPEC §4, §5, R2.4–R2.6, R2.15; REVIEW2 §7).
 *
 * No I/O, no clock, no chain. The caller injects finalized readings, the
 * signed settings and the ledger, and gets back decisions and persisted plan
 * objects. Everything that decides a tick is an exact integer comparison over
 * `getSqrtRatioAtTick` (§4.1); no floating-point value ever selects a tick.
 *
 * What lives here, in spec order:
 *   - the pinned pool table (§9.3, M1);
 *   - the ladder: level prices, the 90 % depth rule (D1), level and TP ranges in
 *     BOTH pool orientations (§4.2–§4.4), `ahead` resting levels and the one
 *     ladder anchor per round (R3.1, R3.2), the TP placement max(target, first
 *     placeable) (R2.6);
 *   - the fill rule (§5.3, I1): composition AND `gridCrossReading`, plus the
 *     durable two-reading counter the stop loss reuses (§7.2);
 *   - the round ledger: start, exits, settle with carry (§4.4, R2.6);
 *   - the R2.4 batch planners: WHICH batch (R2.8 order) and WHAT it contains,
 *     as a persisted plan (I4), and the calls a plan binds to;
 *   - the economics of R2.15: gross `r`, the per-batch gas model, and the
 *     `dca-uneconomic` hold predicate.
 *
 * The grid's pure layer is reused verbatim: `gridCrossReading` and
 * `gridTargetSide` take the quote-is-token0 bit as a parameter, so DCA passes
 * `usdtIsToken0` where the grid passes `wbnbIsToken0` (F3). The LP sagas, the LP
 * worker and the sequence store are never imported (§3.1).
 *
 * This module builds NO swap. A start or Remove batch carries the swap calls
 * the TradFi v2 pricing produced (R2.3 item 1) as data, so the stop-loss sweep
 * cannot reach a swap builder even by mistake (I8).
 */
import { getAddress, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { buildLpZapOutKeepWbnbBatch, buildSingleSidedMintBatch } from "../ops/nfpm.js";
import { buildTradfiPlatformFee } from "../ops/tradfi.js";
import { gridCrossReading, gridTargetSide } from "../lp/gridTriggers.js";
import { sagaDecreaseFloors, sagaSingleSidedMintFloors } from "../lp/rails.js";
import {
  MAX_TICK,
  MIN_TICK,
  Q96,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
} from "../lp/tickMath.js";
import { USDT_56 } from "./settlement.js";

/* -------------------------------------------------------------------------- */
/* The pinned pools (§9.3, M1, R1)                                            */
/* -------------------------------------------------------------------------- */

export type DcaPool = {
  readonly symbol: string;
  readonly stock: Address;
  readonly pool: Address;
  readonly fee: 100 | 2500;
  readonly tickSpacing: 1 | 50;
  /** Pool order, measured (M1). Equals `USDT < stock` by address. */
  readonly usdtIsToken0: boolean;
};

function pinned(symbol: string, stock: string, pool: string, fee: 100 | 2500, usdtIsToken0: boolean): DcaPool {
  return { symbol, stock: getAddress(stock), pool: getAddress(pool), fee, tickSpacing: fee === 100 ? 1 : 50, usdtIsToken0 };
}

/**
 * The 17 R1 stocks, each on ONE Pancake V3 USDT pool: fee 2500 / spacing 50,
 * except QQQB and SPYB on fee 100 / spacing 1. Pools from
 * `AUTO-DCA-POOLS-2026-09-24.json`, stocks equal to the web's `DCA_BSTOCKS`,
 * orientation from M1. Every stock has 18 decimals (M1), so raw and human
 * prices coincide.
 */
export const DCA_POOLS_56: readonly DcaPool[] = [
  pinned("NVDAB", "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", "0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C", 2500, false),
  pinned("SPCXB", "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1", "0x977DaFFC095b33872E2741c19568925015C35b4d", 2500, true),
  pinned("BABAB", "0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec", "0xfD95CB1391999006Eb91797a7c62acFe88b20292", 2500, false),
  pinned("TSLAB", "0x5b1910eaad6450e50f816082aa078c41f10c292f", "0xB0f5E5400E8F0F7C242F2b7740C004f020579c41", 2500, true),
  pinned("QQQB", "0x205812cdbed920aff76c6580abd681a46d11efc7", "0xe531fcb1F5a195de7608B9F4f9518544C2cdB693", 100, false),
  pinned("GOOGLB", "0x3f53de71c126bdabae20f9cd64848d317f6c3238", "0x89001D846f7CA36EE089F73eEFC25657E1798144", 2500, false),
  pinned("CRCLB", "0x80f3d493ebce97e343c53d29a137942416b4ffc0", "0x29967c54c5Bf12E8158c8894376064b30ebaB297", 2500, true),
  pinned("SKHYB", "0xca750ef65f295bbecd685abf54e82caf297bdb61", "0xD7d30F434b12F7Ed9b0Ae11fF1C754745a10aD52", 2500, true),
  pinned("METAB", "0x7425889fe94f9d693e8daefe88bcced6acfef4c0", "0xC2151a561E928D16576d75Ea88544543ac63D80B", 2500, true),
  pinned("MSFTB", "0x80106cb3ead06659a5ad19df39d9b4733863b9b0", "0x5018b018cEB7645c927c5Cf246786F89ebCbe7Ea", 2500, true),
  pinned("TSMB", "0xab78b89b5bb00236be0b4b20704cbfa04efc711c", "0x03f59988F5c366046321cCcD2BF0E3878e2ed69C", 2500, true),
  pinned("SPYB", "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8", "0x7aA6d92Fc369A8C1EDc631A3aAc44eFB0808ddbF", 100, true),
  pinned("INTCB", "0xe614e2fc6c787035ff51f452e8e826bfd32d5283", "0x4dD8e7C67033Ef4A745bB9f82a7C57c676eB2481", 2500, true),
  pinned("MSTRB", "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14", "0x692081209619735f25700557078aB084d3E5D007", 2500, true),
  pinned("HOODB", "0xa394dcea3fd3847fd793afbfd163e2e3858b7c65", "0xFEeF70FF6F58f0A900e28A77e5A8945aFB343923", 2500, true),
  pinned("SOXLB", "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf", "0x3d7D950377eca7b4Af7233716Ff17dEF00ab2045", 2500, true),
  pinned("SNDKB", "0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb", "0xE4B5403f5103b02d1E8193B0D7D76D49F3F8ad77", 2500, false),
];

/**
 * Minimum take profit on the fee-100 pools (QQQB, SPYB). Operator ruling
 * 2026-09-25 (audit RV-1): at 1 % the pool fee earned is too thin to pay a
 * round's or a fill's relay cost, so those agents would hold at normal gas.
 */
export const DCA_MIN_TP_BPS_FEE100 = 150;

/**
 * The platform fee on an Auto DCA agent's base order. Operator ruling
 * 2026-09-25: Auto DCA charges no platform fee (the base order included); the
 * global `FEE_BPS` is unchanged for every other mode.
 */
export const DCA_PLATFORM_FEE_BPS = 0;

/** The pinned pool for a stock address, case-insensitively; `null` outside R1. */
export function dcaPoolForToken(token: string): DcaPool | null {
  const key = token.toLowerCase();
  return DCA_POOLS_56.find((pool) => pool.stock.toLowerCase() === key) ?? null;
}

/** Pool legs in pool order, as the NFPM structs want them. */
export function dcaPoolLegs(pool: DcaPool): { readonly token0: Address; readonly token1: Address } {
  return pool.usdtIsToken0 ? { token0: USDT_56, token1: pool.stock } : { token0: pool.stock, token1: USDT_56 };
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** R9's ×1.2, signed as a fixed literal (§8.1, D1). */
export const DCA_STEP_MULTIPLIER_BPS = 12_000;
/** D1: the deepest level may sit at most 90 % below the base price. */
export const DCA_MAX_DEPTH_BPS = 9_000;
/** R4: the price drop step is at most 30 % for every stock. */
export const DCA_MAX_STEP_BPS = 3_000;
/** C7/D7: fixed, unsigned. Counts from the TP's first filled reading (R2.4). */
export const DCA_COOLDOWN_SEC = 60;
/** §5.2 / R2.23 item 18: round stock worth at most this much is dust. */
export const DCA_DUST_USDT_WEI = 50_000_000_000_000_000n;
/** R2.4: at most 8 exits (16 calls) per batch; the remainder waits a sweep. */
export const DCA_MAX_EXITS_PER_BATCH = 8;
/** I6: a strategy motion exits a strictly-outside range with a 1 bp floor. */
export const DCA_STRATEGY_EXIT_SLIPPAGE_BPS = 1;
/** §5.3: a fill (and a stop loss, §7.2) needs two qualifying readings. */
export const DCA_CONFIRMED_READINGS = 2;
/** R2.4 / R2.23 item 19: after two consecutive GUARD_QUOTE_EXPIRED the close runs alone. */
export const DCA_GUARD_EXPIRED_UNMERGE = 2;

/* -------------------------------------------------------------------------- */
/* Exact prices (§4.1)                                                        */
/* -------------------------------------------------------------------------- */

/** USDT wei per stock wei, as an exact rational with a positive denominator. */
export type DcaPrice = { readonly num: bigint; readonly den: bigint };

export type DcaRange = { readonly tickLower: number; readonly tickUpper: number };

export type DcaReading = {
  readonly block: bigint;
  readonly tick: number;
  readonly sqrtPriceX96: bigint;
};

export type DcaRole = "level" | "tp";

const Q192 = Q96 * Q96;

function lte(a: DcaPrice, b: DcaPrice): boolean {
  return a.num * b.den <= b.num * a.den;
}

function gte(a: DcaPrice, b: DcaPrice): boolean {
  return a.num * b.den >= b.num * a.den;
}

function priceFromSqrt(pool: DcaPool, sqrtX96: bigint): DcaPrice {
  const squared = sqrtX96 * sqrtX96;
  // token1 per token0 is sqrt²/2^192: USDT per stock when the stock is token0,
  // its inverse when USDT is token0.
  return pool.usdtIsToken0 ? { num: Q192, den: squared } : { num: squared, den: Q192 };
}

/** `P(t)`, exact. */
export function dcaPriceAtTick(pool: DcaPool, tick: number): DcaPrice {
  return priceFromSqrt(pool, getSqrtRatioAtTick(tick));
}

/** The reading's mid, exact, from its `sqrtPriceX96`. */
export function dcaMidPrice(pool: DcaPool, sqrtPriceX96: bigint): DcaPrice {
  return priceFromSqrt(pool, sqrtPriceX96);
}

/** A USDT-per-stock ×1e8 settings value as an exact price. */
export function dcaPriceFromE8(valueE8: bigint): DcaPrice {
  return { num: valueE8, den: 100_000_000n };
}

function alignedBounds(spacing: number): { readonly lo: number; readonly hi: number } {
  return { lo: Math.ceil(MIN_TICK / spacing), hi: Math.floor(MAX_TICK / spacing) };
}

/** Largest aligned tick where `pred` holds, `pred` being true on a prefix. */
function lastAligned(spacing: number, pred: (tick: number) => boolean): number | null {
  let { lo, hi } = alignedBounds(spacing);
  if (!pred(lo * spacing)) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (pred(mid * spacing)) lo = mid;
    else hi = mid - 1;
  }
  return lo * spacing;
}

/** Smallest aligned tick where `pred` holds, `pred` being true on a suffix. */
function firstAligned(spacing: number, pred: (tick: number) => boolean): number | null {
  let { lo, hi } = alignedBounds(spacing);
  if (!pred(hi * spacing)) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (pred(mid * spacing)) hi = mid;
    else lo = mid + 1;
  }
  return lo * spacing;
}

function rangeWithin(range: DcaRange, what: string): DcaRange {
  if (range.tickLower < MIN_TICK || range.tickUpper > MAX_TICK) {
    throw new Error(`${what}: the range falls outside the tick domain; refusing to saturate.`);
  }
  return range;
}

/* -------------------------------------------------------------------------- */
/* The ladder (§4.2, D1)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * D1's rule, exact: `stepBps · 5 · (6^N − 5^N) ≤ 9000 · 5^N`. The deepest level
 * `L_N = P0 · (1 − step · S_N)` with `S_N = 5 · ((6/5)^N − 1)` stays within 90 %.
 */
export function dcaStepWithinDepth(stepBps: number, maxOrders: number): boolean {
  const n = BigInt(maxOrders);
  return BigInt(stepBps) * 5n * (6n ** n - 5n ** n) <= BigInt(DCA_MAX_DEPTH_BPS) * 5n ** n;
}

/** The largest integer step the depth rule and R4 admit for N orders. */
export function dcaMaxStepBps(maxOrders: number): number {
  const n = BigInt(maxOrders);
  const exact = (BigInt(DCA_MAX_DEPTH_BPS) * 5n ** n) / (5n * (6n ** n - 5n ** n));
  return Math.min(DCA_MAX_STEP_BPS, Number(exact));
}

/**
 * `L_k = P0 · (10^4 · 5^k − stepBps · 5 · (6^k − 5^k)) / (10^4 · 5^k)` (§4.2),
 * with `P0` = the start swap's input ÷ output (R2.3).
 */
export function dcaLevelPrice(p0: DcaPrice, levelNo: number, stepBps: number): DcaPrice {
  const k = BigInt(levelNo);
  const scale = 10_000n * 5n ** k;
  const keep = scale - BigInt(stepBps) * 5n * (6n ** k - 5n ** k);
  if (levelNo < 1 || keep <= 0n) throw new Error("dcaLevelPrice: the level sits at or below zero.");
  return { num: p0.num * keep, den: p0.den * scale };
}

/** Which side of the tick a live range must sit on to hold its armed leg (§4.5). */
export function dcaHoldSide(pool: DcaPool, role: DcaRole): "above" | "below" {
  // A range above the tick holds token0. A level holds USDT, a TP holds stock.
  return (role === "level") === pool.usdtIsToken0 ? "above" : "below";
}

/**
 * §4.3, USDT only, one spacing wide, its highest USDT price ≤ the level price
 * (I2). Stock = token0: the largest `tU` with `P(tU) ≤ L`; USDT = token0: the
 * smallest `tL` with `P(tL) ≤ L`.
 */
export function dcaLevelRange(pool: DcaPool, levelPrice: DcaPrice): DcaRange {
  const s = pool.tickSpacing;
  const atOrBelow = (tick: number): boolean => lte(dcaPriceAtTick(pool, tick), levelPrice);
  if (pool.usdtIsToken0) {
    const tickLower = firstAligned(s, atOrBelow);
    if (tickLower === null) throw new Error("dcaLevelRange: no tick prices at or below the level.");
    return rangeWithin({ tickLower, tickUpper: tickLower + s }, "dcaLevelRange");
  }
  const tickUpper = lastAligned(s, atOrBelow);
  if (tickUpper === null) throw new Error("dcaLevelRange: no tick prices at or below the level.");
  return rangeWithin({ tickLower: tickUpper - s, tickUpper }, "dcaLevelRange");
}

/** The highest USDT price of a level range. */
export function dcaLevelTop(pool: DcaPool, range: DcaRange): DcaPrice {
  return dcaPriceAtTick(pool, pool.usdtIsToken0 ? range.tickLower : range.tickUpper);
}

/* -------------------------------------------------------------------------- */
/* The take profit (§4.4, R2.6)                                               */
/* -------------------------------------------------------------------------- */

/** `T = C · (10^4 + tpBps) / (H · 10^4)`: the average cost times (1 + TP). */
export function dcaTpTarget(input: {
  readonly costUsdtWei: bigint;
  readonly stockWei: bigint;
  readonly takeProfitBps: number;
}): DcaPrice {
  if (input.stockWei <= 0n || input.costUsdtWei <= 0n) {
    throw new Error("dcaTpTarget: the round has no cost or no stock to price.");
  }
  return { num: input.costUsdtWei * BigInt(10_000 + input.takeProfitBps), den: input.stockWei * 10_000n };
}

/**
 * §4.4, stock only, one spacing wide, its lowest price ≥ T (I2). Stock =
 * token0: the smallest `tL` with `P(tL) ≥ T`; USDT = token0: the largest `tU`
 * with `P(tU) ≥ T`.
 */
export function dcaTpRange(pool: DcaPool, target: DcaPrice): DcaRange {
  const s = pool.tickSpacing;
  const atOrAbove = (tick: number): boolean => gte(dcaPriceAtTick(pool, tick), target);
  if (pool.usdtIsToken0) {
    const tickUpper = lastAligned(s, atOrAbove);
    if (tickUpper === null) throw new Error("dcaTpRange: no tick prices at or above the target.");
    return rangeWithin({ tickLower: tickUpper - s, tickUpper }, "dcaTpRange");
  }
  const tickLower = firstAligned(s, atOrAbove);
  if (tickLower === null) throw new Error("dcaTpRange: no tick prices at or above the target.");
  return rangeWithin({ tickLower, tickUpper: tickLower + s }, "dcaTpRange");
}

/**
 * R2.6: the TP rests at max(target, first placeable). The §4.4 range when it is
 * strictly on the stock side of the tick; otherwise the one-spacing range just
 * on the stock side of the current tick, every price of which is above the
 * current price, which is at or above the target. So the TP never needs a
 * market sale (§6.3 deleted).
 */
export function dcaTpPlacement(pool: DcaPool, target: DcaPrice, tick: number): DcaRange {
  const range = dcaTpRange(pool, target);
  const side = dcaHoldSide(pool, "tp");
  if (gridTargetSide(tick, range) === side) return range;
  const s = pool.tickSpacing;
  const base = Math.floor(tick / s) * s;
  return rangeWithin(
    side === "above" ? { tickLower: base + s, tickUpper: base + 2 * s } : { tickLower: base - s, tickUpper: base },
    "dcaTpPlacement",
  );
}

/* -------------------------------------------------------------------------- */
/* Resting levels ahead (R3.1, R3.2) and the price range (D5)                 */
/* -------------------------------------------------------------------------- */

/** R3.1: the resting levels kept below the price, from the signed `dcaMaxOrders`. */
export function dcaAhead(maxOrders: number): number {
  return maxOrders <= 3 ? 1 : 2;
}

/**
 * R3.2: a start's ladder anchor is the chosen offer's quote-implied price,
 * `amountIn / quotedOut`, exact. A leg without its quoted output refuses.
 */
export function dcaLadderAnchor(swap: Pick<DcaSwapLeg, "amountInWei" | "quotedOutWei">): DcaPrice {
  if (swap.quotedOutWei === undefined || swap.quotedOutWei <= 0n) throw new Error("DCA plan: the start's offer carries no quoted output.");
  return { num: swap.amountInWei, den: swap.quotedOutWei };
}

/**
 * I13, one ladder anchor per round (R3.2, review C4), mirroring the view's
 * `baseFor`: the newest committed or finished `start` of round `r`, or
 * `close-start` of round `r − 1`, and its plan's `ladderAnchor`; else the
 * round's P0, for a round started before R3.
 */
export function dcaRoundAnchor(
  round: { readonly roundNo: number; readonly p0UsdtWei: bigint | null; readonly p0StockWei: bigint | null },
  actions: readonly { readonly kind: DcaBatchKind; readonly roundNo: number; readonly state: string; readonly createdAtMs: number; readonly plan: Pick<DcaBatchPlan, "ladderAnchor"> }[],
): DcaPrice | null {
  const action = actions.filter((row) => (row.state === "committed" || row.state === "finished")
    && ((row.kind === "start" && row.roundNo === round.roundNo) || (row.kind === "close-start" && row.roundNo === round.roundNo - 1)))
    .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
  if (action?.plan.ladderAnchor !== undefined) return action.plan.ladderAnchor;
  return round.p0UsdtWei === null || round.p0StockWei === null || round.p0StockWei <= 0n ? null : { num: round.p0UsdtWei, den: round.p0StockWei };
}

/**
 * One level's standing at mint time (R3.1). `placeable`: its range is strictly
 * on its USDT side of the tick. `passed`: the tick is inside or beyond it, so
 * it is skipped for the round (R3.4). `below-range`: its price is below the
 * owner's range min (D5).
 */
export type DcaLevelVerdict = "placeable" | "passed" | "below-range";

export function dcaLevelVerdict(input: {
  readonly pool: DcaPool;
  readonly levelPrice: DcaPrice;
  readonly range: DcaRange;
  readonly rangeMinE8: bigint | null;
  readonly reading: Pick<DcaReading, "tick">;
}): DcaLevelVerdict {
  if (input.rangeMinE8 !== null && !gte(input.levelPrice, dcaPriceFromE8(input.rangeMinE8))) return "below-range";
  return gridTargetSide(input.reading.tick, input.range) === dcaHoldSide(input.pool, "level") ? "placeable" : "passed";
}

/** D5/C7: a round starts only while the mid is inside the owner's range. */
export function dcaPriceRangeHold(input: {
  readonly pool: DcaPool;
  readonly sqrtPriceX96: bigint;
  readonly rangeMinE8: bigint | null;
  readonly rangeMaxE8: bigint | null;
}): "dca-below-range" | "dca-above-range" | null {
  const mid = dcaMidPrice(input.pool, input.sqrtPriceX96);
  if (input.rangeMinE8 !== null && !gte(mid, dcaPriceFromE8(input.rangeMinE8))) return "dca-below-range";
  if (input.rangeMaxE8 !== null && !lte(mid, dcaPriceFromE8(input.rangeMaxE8))) return "dca-above-range";
  return null;
}

/** R2.14: round 1 fires only when the chosen offer's `minOut` reaches this. */
export function dcaTriggerMinOutWei(entryWei: bigint, triggerPriceE8: bigint): bigint {
  if (triggerPriceE8 <= 0n) throw new Error("dcaTriggerMinOutWei: the trigger must be positive.");
  return (entryWei * 100_000_000n + triggerPriceE8 - 1n) / triggerPriceE8;
}

/* -------------------------------------------------------------------------- */
/* The fill rule (§5.3, I1)                                                   */
/* -------------------------------------------------------------------------- */

function usdtLeg(pool: DcaPool, amount0: bigint, amount1: bigint): bigint {
  return pool.usdtIsToken0 ? amount0 : amount1;
}

function stockLeg(pool: DcaPool, amount0: bigint, amount1: bigint): bigint {
  return pool.usdtIsToken0 ? amount1 : amount0;
}

/**
 * One reading of one live order. Filled only when its composition shows the
 * armed leg at exactly 0 AND `gridCrossReading` answers filled for the same
 * reading: a touch is never a fill, and the exact-boundary case where the
 * composition alone is already one-sided stays unfilled.
 */
export function dcaOrderReadsFilled(input: {
  readonly pool: DcaPool;
  readonly role: DcaRole;
  readonly range: DcaRange;
  readonly liquidity: bigint;
  readonly reading: Pick<DcaReading, "tick" | "sqrtPriceX96">;
}): boolean {
  const amounts = getAmountsForLiquidity(input.reading.sqrtPriceX96, input.range.tickLower, input.range.tickUpper, input.liquidity);
  const usdt = usdtLeg(input.pool, amounts.amount0, amounts.amount1);
  const stock = stockLeg(input.pool, amounts.amount0, amounts.amount1);
  const composition = input.role === "level" ? usdt === 0n && stock > 0n : stock === 0n && usdt > 0n;
  const cross = gridCrossReading({
    currentTick: input.reading.tick,
    range: input.range,
    role: input.role === "level" ? "buy" : "sell",
    wbnbIsToken0: input.pool.usdtIsToken0,
  });
  return composition && cross.filled;
}

export type DcaCrossCounter = {
  readonly count: number;
  readonly lastBlock: bigint | null;
  readonly lastAtMs: number | null;
};

/**
 * The durable counter (§5.3 step 4). A qualifying reading at a block after the
 * last counted one, at least one worker interval later, increments it; the
 * first qualifying reading after a reset counts as one; a non-qualifying
 * reading resets it. The same block twice counts once.
 */
export function dcaAdvanceCounter(
  counter: DcaCrossCounter,
  reading: { readonly qualifies: boolean; readonly block: bigint; readonly atMs: number; readonly intervalMs: number },
): DcaCrossCounter {
  if (!reading.qualifies) return { count: 0, lastBlock: null, lastAtMs: null };
  if (counter.count === 0 || counter.lastBlock === null || counter.lastAtMs === null) {
    return { count: 1, lastBlock: reading.block, lastAtMs: reading.atMs };
  }
  if (reading.block > counter.lastBlock && reading.atMs - counter.lastAtMs >= reading.intervalMs) {
    return { count: counter.count + 1, lastBlock: reading.block, lastAtMs: reading.atMs };
  }
  return counter;
}

export function dcaCounterConfirmed(counter: DcaCrossCounter): boolean {
  return counter.count >= DCA_CONFIRMED_READINGS;
}

/* -------------------------------------------------------------------------- */
/* The round ledger (§4.4, R2.6) and the stop loss (§7)                       */
/* -------------------------------------------------------------------------- */

/** The four ledger columns of `dca_rounds`, all from receipts (I5). */
export type DcaLedger = {
  /** C: USDT the round has spent, net of USDT its level exits returned. */
  readonly costUsdtWei: bigint;
  /** H: stock the round has acquired (base plus filled levels, plus carry). */
  readonly stockAcquiredWei: bigint;
  /** USDT the round's TP exits collected. */
  readonly usdtCollectedWei: bigint;
  /** USDT a Remove sale returned. */
  readonly saleProceedsWei: bigint;
};

/** A start from its receipt: the carry, the swap input plus fee, the swap output. */
export function dcaStartLedger(input: {
  readonly carriedCostWei: bigint;
  readonly carriedStockWei: bigint;
  readonly swapInWei: bigint;
  readonly feeWei: bigint;
  readonly swapOutWei: bigint;
}): DcaLedger {
  return {
    costUsdtWei: input.carriedCostWei + input.swapInWei + input.feeWei,
    stockAcquiredWei: input.carriedStockWei + input.swapOutWei,
    usdtCollectedWei: 0n,
    saleProceedsWei: 0n,
  };
}

/**
 * One confirmed exit, from its `Collect` receipt. A level exit adds its minted
 * USDT less the USDT it returned to C, and the stock it returned to H; a TP
 * exit's USDT is proceeds (its stock was already round stock).
 */
export function dcaApplyExit(
  ledger: DcaLedger,
  exit: {
    readonly role: DcaRole;
    readonly mintedUsdtWei: bigint;
    readonly collectedUsdtWei: bigint;
    readonly collectedStockWei: bigint;
  },
): DcaLedger {
  return exit.role === "level"
    ? {
        ...ledger,
        costUsdtWei: ledger.costUsdtWei + exit.mintedUsdtWei - exit.collectedUsdtWei,
        stockAcquiredWei: ledger.stockAcquiredWei + exit.collectedStockWei,
      }
    : { ...ledger, usdtCollectedWei: ledger.usdtCollectedWei + exit.collectedUsdtWei };
}

/**
 * R2.6 accounting, average cost throughout: `realized = proceeds − C · sold / H`;
 * the unsold residue `R = H − sold` carries the rest of C into the next round.
 */
export function dcaSettle(input: {
  readonly ledger: DcaLedger;
  readonly stockSoldWei: bigint;
}): { readonly realizedPnlWei: bigint; readonly carriedStockWei: bigint; readonly carriedCostWei: bigint } {
  const { costUsdtWei: cost, stockAcquiredWei: held } = input.ledger;
  if (held <= 0n || input.stockSoldWei < 0n || input.stockSoldWei > held) {
    throw new Error("dcaSettle: the stock sold must lie between 0 and the round's stock.");
  }
  const costSold = (cost * input.stockSoldWei) / held;
  return {
    realizedPnlWei: input.ledger.usdtCollectedWei + input.ledger.saleProceedsWei - costSold,
    carriedStockWei: held - input.stockSoldWei,
    carriedCostWei: cost - costSold,
  };
}

/**
 * AUTO-DCA R4.3 (I17): the marked PnL of a `removed` round, derived and never
 * stored. Structural over the round, so this file imports nothing from the
 * store. `null` when any of the three `unsold_*` fields or `realizedPnlWei`
 * is `null`, or the round is unreliable.
 */
export function dcaMarkedPnlWei(round: {
  readonly realizedPnlWei: bigint | null;
  readonly unsoldStockWei: bigint | null;
  readonly unsoldCostWei: bigint | null;
  readonly unsoldValueWei: bigint | null;
  readonly unreliable: boolean;
}): bigint | null {
  if (round.unreliable || round.realizedPnlWei === null || round.unsoldStockWei === null
    || round.unsoldCostWei === null || round.unsoldValueWei === null) return null;
  return round.realizedPnlWei + round.unsoldValueWei - round.unsoldCostWei;
}

/**
 * §7.1, from the ledger and chain composition, never from wallet balances:
 * `E = capital + Σ realized + U`, where `U` values the live orders' legs, the
 * wallet's round stock and this round's TP proceeds at the reading's mid, less
 * the round's cost basis (C plus the USDT minted into live levels).
 */
export function dcaEquityWei(input: {
  readonly capitalQuoteWei: bigint;
  readonly realizedPnlWei: bigint;
  readonly ledger: DcaLedger;
  readonly liveLevelMintedUsdtWei: bigint;
  readonly orderUsdtWei: bigint;
  readonly orderStockWei: bigint;
  readonly walletRoundStockWei: bigint;
  readonly mid: DcaPrice;
}): bigint {
  const stockValue = ((input.orderStockWei + input.walletRoundStockWei) * input.mid.num) / input.mid.den;
  const value = input.orderUsdtWei + stockValue + input.ledger.usdtCollectedWei + input.ledger.saleProceedsWei;
  return input.capitalQuoteWei + input.realizedPnlWei + value - (input.ledger.costUsdtWei + input.liveLevelMintedUsdtWei);
}

/** The stop line: `baseline · (10^4 − stopLossBps) / 10^4` (§7.1). */
export function dcaStopLineWei(baselineWei: bigint, stopLossBps: number): bigint {
  return (baselineWei * BigInt(10_000 - stopLossBps)) / 10_000n;
}

/** One qualifying stop-loss reading; confirmation uses {@link dcaAdvanceCounter}. */
export function dcaStopLossBreached(equityWei: bigint, baselineWei: bigint, stopLossBps: number): boolean {
  return equityWei <= dcaStopLineWei(baselineWei, stopLossBps);
}

/* -------------------------------------------------------------------------- */
/* Which batch (R2.4, R2.8)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * R2.4's batches, plus `tp-place`: re-placing the TP with every round token when
 * the round has none resting — the resume after a stop loss (D12, §7.5) and the
 * resume after an owner pull (R2.11). R2.4 catalogues no batch for that motion.
 */
export type DcaBatchKind = "start" | "close-start" | "close" | "level-place" | "fill" | "stop-loss" | "remove" | "tp-place";

export type DcaStrategyStep =
  | { readonly kind: "fill"; readonly levelNos: readonly number[]; readonly nextLevelNos: readonly number[] }
  | { readonly kind: "close-start" }
  | { readonly kind: "close" }
  | { readonly kind: "level-place"; readonly levelNos: readonly number[] }
  | { readonly kind: "start" }
  | { readonly kind: "hold"; readonly reason: string }
  | { readonly kind: "none" };

/**
 * The strategy phase's decision, in R2.8's order: fill batch, close (+ start),
 * level placement, start. The gates are the caller's reads (session cutoff,
 * cash, meter, price range, trigger, cooldown, economics, backoff) reduced to a
 * hold reason or `null`. A start gate binds the start and the merged close; a
 * level gate binds a level mint alone, so the fill and the close still run
 * inside the entry cutoff (I10) and a failed start never holds the close hostage.
 */
export function nextDcaStrategyStep(input: {
  /** An active round exists; `false` means the next thing is a start. */
  readonly roundActive: boolean;
  /** Levels whose fill is confirmed at this cycle's reading. */
  readonly filledLevelNos: readonly number[];
  /** The live TP's conversion is confirmed at this cycle's reading. */
  readonly tpConfirmed: boolean;
  /** Some live level reads filled at this reading, confirmed or not. */
  readonly liveLevelReadsFilled: boolean;
  /** R3.1: the placeable candidates collected for the open slots, in ladder order (≤ `ahead`). */
  readonly levelsToMint: readonly number[];
  readonly startHold: string | null;
  readonly levelHold: string | null;
  /** Consecutive GUARD_QUOTE_EXPIRED (or, R3.4, FAILED) rollbacks of a merged close + start. */
  readonly guardExpiredStreak: number;
}): DcaStrategyStep {
  if (!input.roundActive) return input.startHold === null ? { kind: "start" } : { kind: "hold", reason: input.startHold };
  if (input.filledLevelNos.length > 0) {
    return { kind: "fill", levelNos: input.filledLevelNos, nextLevelNos: input.levelHold === null ? input.levelsToMint : [] };
  }
  if (input.tpConfirmed) {
    return input.startHold === null && input.guardExpiredStreak < DCA_GUARD_EXPIRED_UNMERGE
      ? { kind: "close-start" }
      : { kind: "close" };
  }
  if (!input.liveLevelReadsFilled && input.levelsToMint.length > 0) {
    return input.levelHold === null ? { kind: "level-place", levelNos: input.levelsToMint } : { kind: "hold", reason: input.levelHold };
  }
  return { kind: "none" };
}

/* -------------------------------------------------------------------------- */
/* What a batch contains (R2.4) — the persisted plan (I4)                     */
/* -------------------------------------------------------------------------- */

/** A live order a plan may exit. */
export type DcaLiveOrder = DcaRange & {
  readonly orderKey: string;
  readonly role: DcaRole;
  readonly levelNo: number | null;
  readonly tokenId: bigint;
  readonly liquidity: bigint;
};

export type DcaExitPlan = DcaLiveOrder & {
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
};

export type DcaMintPlan = DcaRange & {
  readonly orderKey: string;
  readonly role: DcaRole;
  readonly levelNo: number | null;
  readonly liquidity: bigint;
  readonly amount0Desired: bigint;
  readonly amount1Desired: bigint;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
};

/** The swap leg a start or Remove carries, as the TradFi v2 pricing built it. */
export type DcaSwapLeg = {
  readonly side: "buy" | "sell";
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly calls: readonly WalletCall[];
  /** The priced offer's quoted output: the executor's slippage floor reads it (`tradfiV2SwapRefusal`). */
  readonly quotedOutWei?: bigint;
  /** The guard leg's identity and its CLAMPED deadline (`GUARD_QUOTE_EXPIRED`, the receipt's guard event); absent ⇒ the direct leg. */
  readonly guard?: { readonly address: Address; readonly calldata: Hex; readonly deadlineSec: bigint };
};

/**
 * Everything a submission binds, persisted in `dca_actions.plan_json` before
 * the submit. A resume or replay rebuilds its calls from THIS object and never
 * re-derives it (I4, the PHASE3.22 R8 rule).
 */
export type DcaBatchPlan = {
  readonly kind: DcaBatchKind;
  readonly roundNo: number;
  readonly readingBlock: bigint;
  readonly tick: number;
  readonly sqrtPriceX96: bigint;
  readonly deadlineSec: bigint;
  readonly exits: readonly DcaExitPlan[];
  readonly swap: DcaSwapLeg | null;
  readonly feeWei: bigint;
  readonly mints: readonly DcaMintPlan[];
  /** Swap input + fee + Σ level USDT (R2.3): the journal's `quoteSpendWei`. */
  readonly quoteSpendWei: bigint;
  /** The TP target the plan's TP mint was placed from; `null` without a TP mint. */
  readonly tpTarget: DcaPrice | null;
  /** R3.2: a start's or close + start's ladder anchor; every level of the new round derives from it (I13). */
  readonly ladderAnchor?: DcaPrice;
  /** R2.19: the pre-submit wallet snapshot and the relay quote, set by the caller. */
  readonly preSubmit?: { readonly walletUsdtWei: bigint; readonly walletStockWei: bigint };
  readonly relayQuoteWei?: bigint;
};

type PlanBase = {
  readonly pool: DcaPool;
  readonly roundNo: number;
  readonly reading: DcaReading;
  readonly deadlineSec: bigint;
};

function exitPlan(reading: DcaReading, order: DcaLiveOrder, maxSagaSlippageBps: number, strategy: boolean): DcaExitPlan {
  // I6: a strategy motion exits only a range strictly outside the tick at the
  // build's own reading, so its principal is price-independent and a 1 bp floor
  // only absorbs rounding. Only a sweep may exit a range the price is inside.
  if (strategy && gridTargetSide(reading.tick, order) === undefined) {
    throw new Error(`DCA plan: the tick is inside ${order.orderKey}; a strategy exit needs the range strictly outside (I6).`);
  }
  const floors = sagaDecreaseFloors({
    sqrtPriceX96: reading.sqrtPriceX96,
    tickLower: order.tickLower,
    tickUpper: order.tickUpper,
    liquidity: order.liquidity,
    maxSagaSlippageBps,
  });
  return { ...order, amount0Min: floors.amount0Min, amount1Min: floors.amount1Min };
}

function mintPlan(
  pool: DcaPool,
  reading: DcaReading,
  mint: { readonly orderKey: string; readonly role: DcaRole; readonly levelNo: number | null; readonly range: DcaRange; readonly desiredWei: bigint },
): DcaMintPlan {
  const side = dcaHoldSide(pool, mint.role);
  if (gridTargetSide(reading.tick, mint.range) !== side) {
    throw new Error(`DCA plan: ${mint.orderKey} is not strictly on its own side of the tick; refusing the mint.`);
  }
  if (mint.desiredWei <= 0n) throw new Error(`DCA plan: ${mint.orderKey} deposits nothing.`);
  const onToken0 = side === "above";
  const amount0Desired = onToken0 ? mint.desiredWei : 0n;
  const amount1Desired = onToken0 ? 0n : mint.desiredWei;
  const liquidity = getLiquidityForAmounts(reading.sqrtPriceX96, mint.range.tickLower, mint.range.tickUpper, amount0Desired, amount1Desired);
  const floors = sagaSingleSidedMintFloors({
    sqrtPriceX96: reading.sqrtPriceX96,
    tickLower: mint.range.tickLower,
    tickUpper: mint.range.tickUpper,
    liquidity,
    maxSagaSlippageBps: DCA_STRATEGY_EXIT_SLIPPAGE_BPS,
    side,
  });
  return {
    orderKey: mint.orderKey, role: mint.role, levelNo: mint.levelNo,
    tickLower: mint.range.tickLower, tickUpper: mint.range.tickUpper,
    liquidity, amount0Desired, amount1Desired, amount0Min: floors.amount0Min, amount1Min: floors.amount1Min,
  };
}

function plan(base: PlanBase, kind: DcaBatchKind, parts: {
  readonly exits?: readonly DcaExitPlan[];
  readonly swap?: DcaSwapLeg | null;
  readonly feeWei?: bigint;
  readonly mints?: readonly DcaMintPlan[];
  readonly tpTarget?: DcaPrice | null;
  readonly ladderAnchor?: DcaPrice;
}): DcaBatchPlan {
  const exits = parts.exits ?? [];
  if (exits.length > DCA_MAX_EXITS_PER_BATCH) throw new Error(`DCA plan: at most ${DCA_MAX_EXITS_PER_BATCH} exits per batch.`);
  const swap = parts.swap ?? null;
  const feeWei = parts.feeWei ?? 0n;
  const mints = parts.mints ?? [];
  const levelUsdt = mints
    .filter((mint) => mint.role === "level")
    .reduce((sum, mint) => sum + usdtLeg(base.pool, mint.amount0Desired, mint.amount1Desired), 0n);
  return {
    kind, roundNo: base.roundNo, readingBlock: base.reading.block, tick: base.reading.tick,
    sqrtPriceX96: base.reading.sqrtPriceX96, deadlineSec: base.deadlineSec,
    exits, swap, feeWei, mints,
    quoteSpendWei: (swap !== null && swap.side === "buy" ? swap.amountInWei : 0n) + feeWei + levelUsdt,
    tpTarget: parts.tpTarget ?? null,
    ...(parts.ladderAnchor === undefined ? {} : { ladderAnchor: parts.ladderAnchor }),
  };
}

export type DcaStartInput = PlanBase & {
  /** The chosen buy offer; the TP's stock is its `minOut`, never its quote (R2.6). */
  readonly swap: DcaSwapLeg;
  readonly feeWei: bigint;
  /** The previous round's carried cost and residue in the wallet (R2.6). */
  readonly carriedCostWei: bigint;
  readonly residueStockWei: bigint;
  readonly takeProfitBps: number;
  readonly tpOrderKey: string;
  /** R3.2: the signed ladder the start mints its first `ahead` placeable levels from. */
  readonly ladder: { readonly stepBps: number; readonly maxOrders: number; readonly orderWei: bigint; readonly rangeMinE8: bigint | null };
};

function startParts(input: DcaStartInput, newRoundNo: number): { readonly mints: readonly DcaMintPlan[]; readonly target: DcaPrice; readonly anchor: DcaPrice } {
  if (input.swap.side !== "buy") throw new Error("DCA plan: a start carries a buy.");
  // R2.6: the worst-case average (spend / minOut). The stock received is at
  // least minOut, so the true average is at or below this and I2 holds.
  const target = dcaTpTarget({
    costUsdtWei: input.carriedCostWei + input.swap.amountInWei + input.feeWei,
    stockWei: input.residueStockWei + input.swap.minOutWei,
    takeProfitBps: input.takeProfitBps,
  });
  const mint = mintPlan(input.pool, input.reading, {
    orderKey: input.tpOrderKey, role: "tp", levelNo: null,
    range: dcaTpPlacement(input.pool, target, input.reading.tick),
    desiredWei: input.residueStockWei + input.swap.minOutWei,
  });
  // R3.2 / review C6, operator ruling D-R3-4 (b) 2026-09-25: the quote-implied
  // anchor, capped at mid × (1 + pool fee) so the ladder follows the owner's step
  // on a direct route (whose quote sits about one pool fee above the mid) and
  // never starts above the pool beyond that. A smaller anchor only lowers every
  // level, so I2 holds; with step ≥ 1 % > fee, L1 still sits below the mid.
  const quoted = dcaLadderAnchor(input.swap);
  const mid = dcaMidPrice(input.pool, input.reading.sqrtPriceX96);
  const cap: DcaPrice = { num: mid.num * BigInt(1_000_000 + input.pool.fee), den: mid.den * 1_000_000n };
  const anchor = lte(quoted, cap) ? quoted : cap;
  // R3.1 / R3.4: the new round's ladder in order until `ahead` placeable levels
  // are collected; a passed or below-range level is skipped (the finish writes it).
  const levels: DcaMintPlan[] = [];
  for (let levelNo = 1; levelNo <= input.ladder.maxOrders && levels.length < dcaAhead(input.ladder.maxOrders); levelNo += 1) {
    let levelPrice: DcaPrice;
    let range: DcaRange;
    try {
      levelPrice = dcaLevelPrice(anchor, levelNo, input.ladder.stepBps);
      range = dcaLevelRange(input.pool, levelPrice);
    } catch { continue; }
    if (dcaLevelVerdict({ pool: input.pool, levelPrice, range, rangeMinE8: input.ladder.rangeMinE8, reading: input.reading }) !== "placeable") continue;
    // Review C5: a level's key names the round it belongs to.
    levels.push(mintPlan(input.pool, input.reading, { orderKey: `r${newRoundNo}:l${levelNo}`, role: "level", levelNo, range, desiredWei: input.ladder.orderWei }));
  }
  return { mints: [mint, ...levels], target, anchor };
}

/** Batch 1: guard swap · fee transfer · stock approve pair · TP mint · the first `ahead` level mints (R3.3). */
export function planDcaStart(input: DcaStartInput): DcaBatchPlan {
  const { mints, target, anchor } = startParts(input, input.roundNo);
  return plan(input, "start", { swap: input.swap, feeWei: input.feeWei, mints, tpTarget: target, ladderAnchor: anchor });
}

function strategyExits(base: PlanBase, orders: readonly DcaLiveOrder[]): DcaExitPlan[] {
  return orders.map((order) => exitPlan(base.reading, order, DCA_STRATEGY_EXIT_SLIPPAGE_BPS, true));
}

export type DcaCloseInput = PlanBase & {
  readonly tp: DcaLiveOrder;
  readonly liveLevels: readonly DcaLiveOrder[];
};

/** Batch 3: TP exit · live level exits. */
export function planDcaClose(input: DcaCloseInput): DcaBatchPlan {
  return plan(input, "close", { exits: strategyExits(input, [input.tp, ...input.liveLevels]) });
}

/** Batch 2: TP exit · live level exits · then batch 1 (lever 2b); the mints belong to round `roundNo + 1`. */
export function planDcaCloseStart(input: DcaCloseInput & Omit<DcaStartInput, keyof PlanBase>): DcaBatchPlan {
  const { mints, target, anchor } = startParts(input, input.roundNo + 1);
  return plan(input, "close-start", {
    exits: strategyExits(input, [input.tp, ...input.liveLevels]),
    swap: input.swap, feeWei: input.feeWei, mints, tpTarget: target, ladderAnchor: anchor,
  });
}

export type DcaLevelMintInput = {
  readonly orderKey: string;
  readonly levelNo: number;
  readonly range: DcaRange;
};

/** Batch 4: a USDT approve pair and a level mint of exactly `dcaOrderWei` per level, up to `ahead` (R3.1). */
export function planDcaLevelPlace(input: PlanBase & { readonly levels: readonly DcaLevelMintInput[]; readonly orderWei: bigint }): DcaBatchPlan {
  return plan(input, "level-place", {
    mints: input.levels.map((level) => mintPlan(input.pool, input.reading, { ...level, role: "level", desiredWei: input.orderWei })),
  });
}

/**
 * Batch 5: exit each filled level and the old TP, then ONE new TP with every
 * round token (R2.6): the wallet's round stock at the reading plus the old TP's
 * and the filled levels' principal, each at its 1 bp exit floor. The target is
 * the ledger projected with those floors (`C' = C + minted`, `H' = H + filled
 * floor`), which can only overstate the average, so I2 holds. The next levels
 * ride along, restoring `ahead` resting ones, when the level gate passes (R3.1).
 */
export function planDcaFill(input: PlanBase & {
  readonly filled: readonly (DcaLiveOrder & { readonly mintedUsdtWei: bigint })[];
  readonly oldTp: DcaLiveOrder | null;
  readonly ledger: Pick<DcaLedger, "costUsdtWei" | "stockAcquiredWei">;
  readonly walletRoundStockWei: bigint;
  readonly takeProfitBps: number;
  readonly tpOrderKey: string;
  readonly nextLevels: readonly DcaLevelMintInput[];
  readonly orderWei: bigint;
}): DcaBatchPlan {
  if (input.filled.length === 0 || input.filled.some((order) => order.role !== "level")) {
    throw new Error("DCA plan: a fill batch exits at least one filled level.");
  }
  const filledExits = strategyExits(input, input.filled);
  const tpExits = input.oldTp === null ? [] : strategyExits(input, [input.oldTp]);
  const filledStock = filledExits.reduce((sum, exit) => sum + stockLeg(input.pool, exit.amount0Min, exit.amount1Min), 0n);
  const tpStock = tpExits.reduce((sum, exit) => sum + stockLeg(input.pool, exit.amount0Min, exit.amount1Min), 0n);
  const target = dcaTpTarget({
    costUsdtWei: input.ledger.costUsdtWei + input.filled.reduce((sum, order) => sum + order.mintedUsdtWei, 0n),
    stockWei: input.ledger.stockAcquiredWei + filledStock,
    takeProfitBps: input.takeProfitBps,
  });
  const mints = [mintPlan(input.pool, input.reading, {
    orderKey: input.tpOrderKey, role: "tp", levelNo: null,
    range: dcaTpPlacement(input.pool, target, input.reading.tick),
    desiredWei: input.walletRoundStockWei + tpStock + filledStock,
  })];
  for (const level of input.nextLevels) {
    mints.push(mintPlan(input.pool, input.reading, { ...level, role: "level", desiredWei: input.orderWei }));
  }
  return plan(input, "fill", { exits: [...filledExits, ...tpExits], mints, tpTarget: target });
}

/**
 * `tp-place`: stock approve pair · TP mint, with the wallet's round stock at
 * max(target, first placeable) from the ledger's average (R2.6). No exit, no
 * USDT: it reduces exposure.
 */
export function planDcaTpPlace(input: PlanBase & {
  readonly ledger: Pick<DcaLedger, "costUsdtWei" | "stockAcquiredWei">;
  readonly walletRoundStockWei: bigint;
  readonly takeProfitBps: number;
  readonly tpOrderKey: string;
}): DcaBatchPlan {
  const target = dcaTpTarget({ costUsdtWei: input.ledger.costUsdtWei, stockWei: input.ledger.stockAcquiredWei, takeProfitBps: input.takeProfitBps });
  return plan(input, "tp-place", {
    mints: [mintPlan(input.pool, input.reading, {
      orderKey: input.tpOrderKey, role: "tp", levelNo: null,
      range: dcaTpPlacement(input.pool, target, input.reading.tick), desiredWei: input.walletRoundStockWei,
    })],
    tpTarget: target,
  });
}

/**
 * Batch 6: exit every live order with the owner's floors; the price may be
 * inside a range. Nothing is sold and no swap is reachable from here (I8).
 */
export function planDcaStopLoss(input: PlanBase & { readonly orders: readonly DcaLiveOrder[]; readonly slippageBps: number }): DcaBatchPlan {
  return plan(input, "stop-loss", {
    exits: input.orders.map((order) => exitPlan(input.reading, order, input.slippageBps, false)),
  });
}

/**
 * Batch 7: exit every live order with the owner's floors; the price may be
 * inside a range. Nothing is sold (AUTO-DCA R4.1.1, as ruled 2026-09-25).
 */
export function planDcaRemove(input: PlanBase & { readonly orders: readonly DcaLiveOrder[]; readonly slippageBps: number }): DcaBatchPlan {
  return plan(input, "remove", { exits: input.orders.map((order) => exitPlan(input.reading, order, input.slippageBps, false)) });
}

/**
 * The calls a plan binds to, in R2.4 order: exits, the swap, the fee transfer,
 * the mints (TP first). Pure and deterministic, so a replay of the persisted
 * plan reproduces the submitted calls byte for byte.
 */
export function dcaBatchCalls(planned: DcaBatchPlan, context: {
  readonly pool: DcaPool;
  readonly nfpm: Address;
  readonly wallet: Address;
  readonly treasury: Address | null;
}): readonly WalletCall[] {
  const calls: WalletCall[] = [];
  for (const exit of planned.exits) {
    calls.push(...buildLpZapOutKeepWbnbBatch({
      nfpm: context.nfpm, tokenId: exit.tokenId, liquidity: exit.liquidity,
      amount0MinWei: exit.amount0Min, amount1MinWei: exit.amount1Min,
      deadline: planned.deadlineSec, wallet: context.wallet,
    }));
  }
  if (planned.swap !== null) calls.push(...planned.swap.calls);
  if (planned.feeWei > 0n) {
    if (context.treasury === null) throw new Error("DCA plan: a fee needs the treasury.");
    calls.push(...buildTradfiPlatformFee({ usdt: USDT_56, treasury: context.treasury, amountWei: planned.feeWei }));
  }
  if (planned.mints.length > 0) {
    calls.push(...buildSingleSidedMintBatch({
      nfpm: context.nfpm, ...dcaPoolLegs(context.pool), fee: context.pool.fee,
      mints: planned.mints.map((mint) => ({
        tickLower: mint.tickLower, tickUpper: mint.tickUpper,
        amount0DesiredWei: mint.amount0Desired, amount1DesiredWei: mint.amount1Desired,
        amount0MinWei: mint.amount0Min, amount1MinWei: mint.amount1Min,
      })),
      recipient: context.wallet,
      deadline: planned.deadlineSec,
    }));
  }
  return calls;
}

/* -------------------------------------------------------------------------- */
/* Economics (R2.15) and the `dca-uneconomic` hold                            */
/* -------------------------------------------------------------------------- */

/** R2.4's gas model (E until G2): relay/orchestrator overhead `O`, exit `X`. */
export const DCA_GAS_OVERHEAD = 200_000n;
/**
 * Calibration R1 (`MD here/DCA-HOLD-CALIBRATION-PLAN.md` §2/§3, ruled 2026-09-25)
 * replaces audit M-1's 220 000 fork upper bound with mainnet measurement: the
 * live Remove (3 exits + the sale) used 661 740 gas in total, so with `O` ≈ 200 k
 * and a direct V3 sale `X` ≈ 104–121 k. 160 000 still sits above the M2 census
 * zap-outs (88–120 k ex `O`).
 */
export const DCA_GAS_EXIT = 160_000n;
/**
 * The guard buy including the fee transfer and `O`. Calibration R1 (plan §2/§3):
 * the live NVDAB start (guard buy + TP mint) used 995 184 gas, not the 1 433 317
 * the old 1 004 975 predicted; at 2.45× the new value bills 1.382e14 wei against
 * the start's measured 1.332e14, so the start's own 2.68× multiple stays covered.
 */
export const DCA_GAS_GUARD_BUY = 700_000n;
/** R2.15: the billed relay multiple the hold uses until G2, 2.45×. */
export const DCA_RHO_BILLED_NUM = 245n;
export const DCA_RHO_BILLED_DEN = 100n;
/** REVIEW2 condition 14: a pool without its own row uses its class maximum + 30 % (G0: thin-pool level mints, audit M-1). */
export const DCA_CLASS_MAX_PAD_BPS = 13_000;

/**
 * M3 − 21 000 intrinsic + 30 000 for the approve pair (R2.4), four pools measured; QQQB `tp` from G0 at uninitialised ticks (audit M-1).
 * Calibration R1 leaves this table alone: the live NVDAB level-place (2 level mints) used 822 095 gas, so `M_L` ≈ 311 k in a batch —
 * the row's 379 358 is the conservative standalone estimate and stays (plan §2/§3).
 */
const DCA_MEASURED_MINT_GAS: Readonly<Record<string, { readonly tp: bigint; readonly level: bigint }>> = {
  NVDAB: { tp: 428_342n, level: 379_358n },
  TSLAB: { tp: 468_713n, level: 385_820n },
  QQQB: { tp: 510_000n, level: 512_613n },
  SPYB: { tp: 555_347n, level: 425_015n },
};

/** R3.5: `GUARD_BUY + M_T + X + a·(M_L + X)`, a start with `a` levels plus a close with their exits. */
function r0Of(mint: { readonly tp: bigint; readonly level: bigint }, ahead: number): bigint {
  return DCA_GAS_GUARD_BUY + mint.tp + DCA_GAS_EXIT + BigInt(ahead) * (mint.level + DCA_GAS_EXIT);
}

/** R3.5: `O + 2X + M_T + M_L`, the merged fill batch. */
function perFillOf(mint: { readonly tp: bigint; readonly level: bigint }): bigint {
  return DCA_GAS_OVERHEAD + 2n * DCA_GAS_EXIT + mint.tp + mint.level;
}

function classGas(pool: DcaPool, of: (mint: { readonly tp: bigint; readonly level: bigint }) => bigint): bigint {
  const own = DCA_MEASURED_MINT_GAS[pool.symbol];
  if (own !== undefined) return of(own);
  const peers = DCA_POOLS_56.filter((peer) => peer.tickSpacing === pool.tickSpacing)
    .map((peer) => DCA_MEASURED_MINT_GAS[peer.symbol])
    .filter((row): row is { readonly tp: bigint; readonly level: bigint } => row !== undefined)
    .map(of);
  const max = peers.reduce((best, gas) => (gas > best ? gas : best), 0n);
  return (max * BigInt(DCA_CLASS_MAX_PAD_BPS) + 9_999n) / 10_000n;
}

/** Gas of the no-fill round with `ahead` resting levels (R3.5); the caller passes `dcaAhead(N)`. */
export function dcaR0Gas(pool: DcaPool, ahead: number): bigint {
  return classGas(pool, (mint) => r0Of(mint, ahead));
}

/** Gas one fill adds: its merged fill batch, which also mints the next level (R3.5). */
export function dcaPerFillGas(pool: DcaPool): bigint {
  return classGas(pool, perFillOf);
}

/**
 * Gross per round on cost, worst snap, ×1e18:
 * `r = (1 + TP) · 1.0001^(s/2) · (1 + f) − 1`. `1.0001^(s/2)` is exactly
 * `getSqrtRatioAtTick(s) / 2^96`.
 */
export function dcaGrossRateE18(pool: DcaPool, takeProfitBps: number): bigint {
  const num = BigInt(10_000 + takeProfitBps) * getSqrtRatioAtTick(pool.tickSpacing) * BigInt(1_000_000 + pool.fee) * 10n ** 18n;
  const den = 10_000n * Q96 * 1_000_000n;
  return num / den - 10n ** 18n;
}

/** Billed native cost of `gas` at `gasPriceWei` and the 2.45× multiple, rounded up. */
export function dcaBilledNativeWei(gas: bigint, gasPriceWei: bigint): bigint {
  return (gas * gasPriceWei * DCA_RHO_BILLED_NUM + DCA_RHO_BILLED_DEN - 1n) / DCA_RHO_BILLED_DEN;
}

/**
 * The hold (R2.15), at every round start and never at hire: hold iff
 * `B(1 + fee) · r_worst < cost(R0)`. The caller converts the billed native wei
 * of {@link dcaR0Gas} to USDT with the fresh BNB price.
 */
export function dcaUneconomic(input: {
  readonly pool: DcaPool;
  readonly entryWei: bigint;
  readonly feeWei: bigint;
  readonly takeProfitBps: number;
  readonly r0CostUsdtWei: bigint;
}): boolean {
  const gross = ((input.entryWei + input.feeWei) * dcaGrossRateE18(input.pool, input.takeProfitBps)) / 10n ** 18n;
  return gross < input.r0CostUsdtWei;
}
