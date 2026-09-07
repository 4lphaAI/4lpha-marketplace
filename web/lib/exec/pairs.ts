import { encodeAbiParameters, getCreate2Address, keccak256 } from "viem";

export const BSC_CHAIN_ID = 56 as const;
export const WBNB_56 = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
export const USDT_56 = "0x55d398326f99059ff775485246999027b3197955";
export const NFPM_56 = "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364";

/**
 * The reviewed BSC majors, all 18-decimal (the data plane's MAJORS-PRICE-SPEC
 * table, verified against each contract's `decimals()` there). A grid pair is
 * reviewed when BOTH legs are in this table and one of them is WBNB — the grid
 * always has a WBNB leg. Any other token dashes prices and amounts (unknown
 * decimals), exactly as before; this widens the set from one pair to the
 * majors the operator actually trades (the first live hire was BTCB/WBNB).
 */
export const REVIEWED_MAJORS_56: Readonly<Record<string, { readonly symbol: MajorSymbol; readonly decimals: 18 }>> = {
  // See `resolvePair`: this table is now the OFFLINE fast path, not the whole
  // universe. Any other token resolves from data-plane metadata instead.
  [WBNB_56]: { symbol: "WBNB", decimals: 18 },
  [USDT_56]: { symbol: "USDT", decimals: 18 },
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { symbol: "USDC", decimals: 18 },
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": { symbol: "BTCB", decimals: 18 },
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8": { symbol: "ETH", decimals: 18 },
  "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": { symbol: "CAKE", decimals: 18 },
};
export type MajorSymbol = "WBNB" | "USDT" | "USDC" | "BTCB" | "ETH" | "CAKE";

/**
 * PancakeSwap V3 pools are CREATE2-deployed by the POOL DEPLOYER (not the
 * factory), so `(token0, token1, fee)` alone fixes the address with no chain
 * read and no third source of truth. Verified against two live pools:
 * BTCB/WBNB 0.05% -> 0x6bbc40579ad1bbd243895ca0acb086bb6300d636 and
 * WBNB/USDT 0.01% -> 0x172fcd41e0913e95784454622d1c3724f546f849.
 *
 * The owner view only learns a pool address once the worker has written an
 * observation, so without this the price column, the tick strip and the chart
 * were all dead for the first cycle after an arm.
 */
export const PANCAKE_V3_POOL_DEPLOYER_56 = "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9";
export const PANCAKE_V3_POOL_INIT_CODE_HASH = "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2";

export function poolAddressFor(token0: string, token1: string, fee: number): string | null {
  const zero = address(token0);
  const one = address(token1);
  if (zero === null || one === null || zero === one) return null;
  if (!Number.isInteger(fee) || fee <= 0 || fee > 1_000_000) return null;
  const [a, b] = zero < one ? [zero, one] : [one, zero];
  const salt = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    [a as `0x${string}`, b as `0x${string}`, fee],
  ));
  return getCreate2Address({
    from: PANCAKE_V3_POOL_DEPLOYER_56 as `0x${string}`,
    salt,
    bytecodeHash: PANCAKE_V3_POOL_INIT_CODE_HASH as `0x${string}`,
  }).toLowerCase();
}

/**
 * Which leg a human quotes the pair in. A price is always QUOTE per BASE, and
 * the numeraire wins: a stable quotes WBNB (598.40 USDT per WBNB), and WBNB
 * quotes anything else (109.702 WBNB per BTCB — the number PancakeSwap shows
 * for a BTCB/WBNB rung). Quoting by pool order instead would have printed
 * 0.00889 BTCB per WBNB, and quoting always in WBNB inverts the stable pairs.
 */
const USDC_56 = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";

/**
 * The rank is read off the ADDRESS, never the symbol.
 *
 * A token contract names itself, and the pairs this now resolves include
 * arbitrary launches — a token calling itself "USDT" would otherwise seize the
 * numeraire and invert every price on the page. Addresses cannot lie.
 */
function numeraireRank(tokenAddress: string): number {
  const lower = tokenAddress.toLowerCase();
  if (lower === USDT_56 || lower === USDC_56) return 2;
  if (lower === WBNB_56) return 1;
  return 0;
}

export type PairQuoting = {
  readonly base: string;
  readonly quote: string;
  /** True when the quote is token0, so the raw token1/token0 ratio must invert. */
  readonly invert: boolean;
};

export function pairQuoting(pair: ReviewedPair): PairQuoting {
  const quoteIsToken0 = numeraireRank(pair.token0) > numeraireRank(pair.token1);
  return {
    base: quoteIsToken0 ? pair.symbol1 : pair.symbol0,
    quote: quoteIsToken0 ? pair.symbol0 : pair.symbol1,
    invert: quoteIsToken0,
  };
}

/** Quote-per-base price at one tick, bigint-exact, oriented by {@link pairQuoting}. */
export function priceAtTick(tick: number, pair: ReviewedPair): string {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("tick out of range");
  const sqrt = getSqrtRatioAtTick(tick);
  const scale = decimalScale(pair.decimals0, pair.decimals1);
  let numerator = sqrt * sqrt * scale.numerator;
  let denominator = (1n << 192n) * scale.denominator;
  if (pairQuoting(pair).invert) [numerator, denominator] = [denominator, numerator];
  return formatRational(numerator, denominator, 8);
}

/** The two edges of a rung, already ordered low-to-high after any inversion. */
export function rangePrices(
  lower: number,
  upper: number,
  pair: ReviewedPair,
): { readonly low: string; readonly high: string } {
  if (!Number.isInteger(lower) || !Number.isInteger(upper) || upper <= lower) throw new Error("invalid range");
  const a = priceAtTick(lower, pair);
  const b = priceAtTick(upper, pair);
  return pairQuoting(pair).invert ? { low: b, high: a } : { low: a, high: b };
}

const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const Q32 = 1n << 32n;
const MAX_UINT_256 = (1n << 256n) - 1n;

export type ReviewedPair = {
  readonly chainId: 56;
  readonly token0: string;
  readonly token1: string;
  readonly symbol0: string;
  readonly symbol1: string;
  readonly decimals0: number;
  readonly decimals1: number;
  readonly wbnbIsToken0: boolean;
};

/** What the data plane knows about a token that is not a reviewed major. */
export type TokenMeta = { readonly symbol: string; readonly decimals: number };
export type TokenMetaMap = Readonly<Record<string, TokenMeta | undefined>>;

/**
 * A symbol from an arbitrary ERC-20 is attacker-controlled TEXT: it can be
 * empty, 200 characters of padding, or carry control characters that break the
 * line it is rendered into. Keep it short and printable, or refuse it.
 */
function sanitizeSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = [...raw].filter((ch) => { const code = ch.codePointAt(0) ?? 0; return code > 31 && code !== 127; }).join("").trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, 12);
}

function usableDecimals(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 36 ? raw : null;
}

/**
 * The pair a price can be computed from: both legs named and SCALED, one of
 * them WBNB (every grid has a WBNB leg).
 *
 * A reviewed major resolves offline from {@link REVIEWED_MAJORS_56}. Any other
 * token resolves from `meta` — the data plane's `/tokens/:address`, the one
 * source of chain truth this app is allowed to read. Decimals are never
 * assumed: without them a tick cannot be turned into a price, and printing a
 * number scaled by a guessed 18 would be wrong by orders of magnitude on the
 * tokens that are not. `null` here is what makes the page dash rather than lie.
 */
export function resolvePair(
  chainId: number,
  token0: string,
  token1: string,
  claimedWbnbIsToken0: boolean,
  meta?: TokenMetaMap,
): ReviewedPair | null {
  if (chainId !== BSC_CHAIN_ID) return null;
  const zero = address(token0);
  const one = address(token1);
  if (zero === null || one === null || zero === one) return null;
  if ((zero === WBNB_56) !== claimedWbnbIsToken0) return null;
  if (zero !== WBNB_56 && one !== WBNB_56) return null;
  const leg = (token: string): TokenMeta | null => {
    const major = REVIEWED_MAJORS_56[token];
    if (major !== undefined) return major;
    const supplied = meta?.[token];
    const symbol = sanitizeSymbol(supplied?.symbol);
    const decimals = usableDecimals(supplied?.decimals);
    return symbol === null || decimals === null ? null : { symbol, decimals };
  };
  const legZero = leg(zero);
  const legOne = leg(one);
  if (legZero === null || legOne === null) return null;
  return {
    chainId: BSC_CHAIN_ID,
    token0: zero,
    token1: one,
    symbol0: legZero.symbol,
    symbol1: legOne.symbol,
    decimals0: legZero.decimals,
    decimals1: legOne.decimals,
    wbnbIsToken0: claimedWbnbIsToken0,
  };
}

function address(value: string): string | null {
  return /^0x[0-9a-f]{40}$/iu.test(value) ? value.toLowerCase() : null;
}

/** Exact-address authorization: both legs reviewed majors, one of them WBNB. */
/**
 * Exact-address authorization: BOTH legs reviewed majors, one of them WBNB.
 * {@link resolvePair} with no metadata — kept as its own name because "is this
 * pair one we ship a decimals table for" is a question several call sites ask
 * offline, before any market data has loaded.
 */
export function reviewedPair(
  chainId: number,
  token0: string,
  token1: string,
  claimedWbnbIsToken0: boolean,
): ReviewedPair | null {
  return resolvePair(chainId, token0, token1, claimedWbnbIsToken0);
}

function mulShift(n: bigint, x: bigint): bigint {
  return (n * x) >> 128n;
}

/** Canonical V3 TickMath integer algorithm, ported without its float helper. */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error("tick out of range");
  }
  const absTick = tick < 0 ? -tick : tick;
  let ratio = (absTick & 0x1) !== 0
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = mulShift(ratio, 0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4) !== 0) ratio = mulShift(ratio, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8) !== 0) ratio = mulShift(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10) !== 0) ratio = mulShift(ratio, 0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20) !== 0) ratio = mulShift(ratio, 0xff973b41fa98a081472e6896dfb254c0n);
  if ((absTick & 0x40) !== 0) ratio = mulShift(ratio, 0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80) !== 0) ratio = mulShift(ratio, 0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100) !== 0) ratio = mulShift(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200) !== 0) ratio = mulShift(ratio, 0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400) !== 0) ratio = mulShift(ratio, 0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800) !== 0) ratio = mulShift(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000) !== 0) ratio = mulShift(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000) !== 0) ratio = mulShift(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000) !== 0) ratio = mulShift(ratio, 0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000) !== 0) ratio = mulShift(ratio, 0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000) !== 0) ratio = mulShift(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000) !== 0) ratio = mulShift(ratio, 0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000) !== 0) ratio = mulShift(ratio, 0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000) !== 0) ratio = mulShift(ratio, 0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = MAX_UINT_256 / ratio;
  return ratio % Q32 > 0n ? ratio / Q32 + 1n : ratio / Q32;
}

function decimalScale(decimals0: number, decimals1: number): { numerator: bigint; denominator: bigint } {
  const delta = decimals0 - decimals1;
  return delta >= 0
    ? { numerator: 10n ** BigInt(delta), denominator: 1n }
    : { numerator: 1n, denominator: 10n ** BigInt(-delta) };
}

export function formatRational(
  numerator: bigint,
  denominator: bigint,
  fractionalDigits = 8,
): string {
  if (numerator < 0n || denominator <= 0n || fractionalDigits < 0) {
    throw new Error("invalid price rational");
  }
  const scale = 10n ** BigInt(fractionalDigits);
  const rounded = (numerator * scale * 2n + denominator) / (2n * denominator);
  const whole = rounded / scale;
  const fraction = (rounded % scale).toString(10).padStart(fractionalDigits, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString(10) : `${whole}.${fraction}`;
}

/** WBNB price in USDT at the exact geometric half-tick. */
export function midpointWbnbUsdtPrice(
  lower: number,
  upper: number,
  pair: ReviewedPair,
): { readonly twiceMidTick: number; readonly value: string } {
  if (!Number.isInteger(lower) || !Number.isInteger(upper) || upper <= lower) {
    throw new Error("invalid range");
  }
  const twiceMidTick = lower + upper;
  if (!Number.isSafeInteger(twiceMidTick)) throw new Error("midpoint out of range");
  const scale = decimalScale(pair.decimals0, pair.decimals1);
  let numerator = getSqrtRatioAtTick(lower) * getSqrtRatioAtTick(upper) * scale.numerator;
  let denominator = (1n << 192n) * scale.denominator;
  if (!pair.wbnbIsToken0) [numerator, denominator] = [denominator, numerator];
  return { twiceMidTick, value: formatRational(numerator, denominator, 8) };
}

export function formatAtomic(amount: string, decimals: number, maxFraction = 6): string | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(amount) || !Number.isInteger(decimals) || decimals < 0) return null;
  const atomic = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const rawFraction = (atomic % scale).toString(10).padStart(decimals, "0");
  const fraction = rawFraction.slice(0, maxFraction).replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString(10) : `${whole}.${fraction}`;
}

export function nftPositionUrl(tokenId: string): string | null {
  if (!/^[1-9][0-9]*$/u.test(tokenId)) return null;
  return `https://bscscan.com/nft/${NFPM_56}/${tokenId}`;
}

