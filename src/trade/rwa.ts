/** Pure RWA admission facts and the worker's reference-price guard. */
import type { VenueRow } from "./dataPlaneReads.js";
import { UNISWAP_V3_FEE_TIERS, V3_FEE_TIERS } from "../ops/route.js";

export type RwaFact = {
  readonly platform: string;
  readonly underlyingTicker: string | null;
  readonly tokenPriceUsd: number | null;
  readonly referencePriceUsd: number | null;
  readonly premiumBps: number | null;
  readonly openState: boolean | null;
  readonly marketStatus: string | null;
  readonly reasonCode: string | null;
  readonly staleness: "fresh" | "stale" | "dead" | null;
  readonly tokenToShareRatio: number | null;
  readonly onchainPriceUsd: number | null;
  readonly venues?: readonly VenueRow[];
};

/** Operator rulings 2026-09-17: no buy above +1.5 %; a discount of 2 % or more is an LLM note. Constants, not config (R2.2). */
export const RWA_MAX_PREMIUM_BPS = 150;
export const RWA_DISCOUNT_NOTE_BPS = 200;
export const RWA_VENUE_MAX_SKEW_MS = 2 * 60 * 1_000;
export const RWA_VENUE_MAX_AGE_MS = 30 * 60 * 1_000;

/** Operator ruling 2026-09-17: only pools the data plane measured at ≥ $10k are venues (29-token allowlist tier A/B); anything thinner is a pool that exists, not one that trades (FINDINGS (k)). */
export const RWA_MIN_VENUE_LIQUIDITY_USD = 10_000;
const USDT_56 = "0x55d398326f99059ff775485246999027b3197955";
const USDC_56 = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const SUPPORTED_QUOTES: ReadonlySet<string> = new Set([
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", USDT_56, USDC_56,
]);

function feeIn(fee: number, tiers: readonly number[]): boolean {
  return tiers.some((tier) => tier === fee);
}

function supportedVenue(venue: VenueRow): boolean {
  if (!Number.isFinite(venue.liquidityUsd) || (venue.liquidityUsd ?? 0) < RWA_MIN_VENUE_LIQUIDITY_USD) return false;
  if (!SUPPORTED_QUOTES.has(venue.quote.toLowerCase())) return false;
  if (venue.version === "v2") return venue.dex === "pancakeswap";
  if (venue.dex === "pancakeswap") return venue.feeTier !== null && feeIn(venue.feeTier, V3_FEE_TIERS);
  return venue.feeTier !== null && feeIn(venue.feeTier, UNISWAP_V3_FEE_TIERS);
}

/** Supported measured venues in the total order used by pinning and routing. */
export function admittedVenueRows(venues: readonly VenueRow[] | undefined): readonly VenueRow[] {
  if (venues === undefined) return [];
  return venues.filter(supportedVenue).toSorted((left, right) => {
    const leftLiquidity = left.liquidityUsd ?? 0;
    const rightLiquidity = right.liquidityUsd ?? 0;
    if (leftLiquidity !== rightLiquidity) return rightLiquidity > leftLiquidity ? 1 : -1;
    const dexOrder = (value: VenueRow["dex"]): number => value === "pancakeswap" ? 0 : 1;
    if (dexOrder(left.dex) !== dexOrder(right.dex)) return dexOrder(left.dex) - dexOrder(right.dex);
    const versionOrder = (value: VenueRow["version"]): number => value === "v2" ? 0 : 1;
    if (versionOrder(left.version) !== versionOrder(right.version)) return versionOrder(left.version) - versionOrder(right.version);
    const leftFee = left.feeTier;
    const rightFee = right.feeTier;
    if (leftFee === null && rightFee !== null) return -1;
    if (leftFee !== null && rightFee === null) return 1;
    if (leftFee !== rightFee) return (leftFee ?? 0) - (rightFee ?? 0);
    return left.pool.toLowerCase().localeCompare(right.pool.toLowerCase());
  });
}

function freshVenue(venue: VenueRow, nowMs: number): boolean {
  return Number.isSafeInteger(venue.asOf)
    && (venue.asOf ?? 0) > 0
    && Number.isFinite(nowMs)
    && nowMs - (venue.asOf ?? 0) >= -RWA_VENUE_MAX_SKEW_MS
    && nowMs - (venue.asOf ?? 0) <= RWA_VENUE_MAX_AGE_MS;
}

/** Compute the signed premium from the deepest supported fresh venue. */
export function rwaPremiumBps(fact: RwaFact, nowMs: number): number | null {
  const venue = admittedVenueRows(fact.venues).find((row) => freshVenue(row, nowMs));
  const onchainPriceUsd = venue?.priceUsd ?? null;
  const referencePriceUsd = fact.referencePriceUsd;
  const tokenToShareRatio = fact.tokenToShareRatio;
  if (onchainPriceUsd === null || referencePriceUsd === null || tokenToShareRatio === null
    || !Number.isFinite(onchainPriceUsd) || !Number.isFinite(referencePriceUsd)
    || !Number.isFinite(tokenToShareRatio) || onchainPriceUsd <= 0 || referencePriceUsd <= 0
    || tokenToShareRatio <= 0) return null;
  const fairUsd = referencePriceUsd * tokenToShareRatio;
  if (!Number.isFinite(fairUsd) || fairUsd <= 0) return null;
  const premiumBps = Math.round((onchainPriceUsd / fairUsd - 1) * 10_000);
  return Number.isFinite(premiumBps) ? premiumBps : null;
}

export type RwaEntryVerdict =
  | { readonly kind: "allow"; readonly note: string | null }
  | { readonly kind: "refuse"; readonly reason: "rwa-unavailable" | "rwa-stale" | "issuer-not-trading" | "venue-stale" | "premium-unknown" | "premium-too-high" };

function percent(bps: number): string {
  return `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
}

export function rwaEntryVerdict(fact: RwaFact | undefined, nowMs: number, options: { readonly allowVenueMissing?: boolean; readonly deferUnknownPremium?: boolean; readonly maxPremiumBps?: number } = {}): RwaEntryVerdict {
  if (fact === undefined) return { kind: "refuse", reason: "rwa-unavailable" };
  if (fact.staleness !== "fresh") return { kind: "refuse", reason: "rwa-stale" };
  if (fact.openState !== true || fact.reasonCode !== "TRADING") {
    return { kind: "refuse", reason: "issuer-not-trading" };
  }
  const hasFreshVenue = fact.venues !== undefined && admittedVenueRows(fact.venues).some((venue) => freshVenue(venue, nowMs));
  if (!hasFreshVenue && options.allowVenueMissing !== true) {
    return { kind: "refuse", reason: "venue-stale" };
  }
  const premiumBps = hasFreshVenue ? rwaPremiumBps(fact, nowMs)
    : typeof fact.premiumBps === "number" && Number.isFinite(fact.premiumBps) ? fact.premiumBps : null;
  if (premiumBps === null) {
    // R3.2 (Schedule only, gated by BOTH options): a pool-less token has no
    // data-plane premium either. The binding gate is the executed-quote
    // premium check (`tradfiActualPremiumAllowed`), which needs exactly these
    // two reference facts — nothing here buys on unpriced evidence.
    if (!hasFreshVenue && options.allowVenueMissing === true && options.deferUnknownPremium === true
      && typeof fact.referencePriceUsd === "number" && Number.isFinite(fact.referencePriceUsd) && fact.referencePriceUsd > 0
      && typeof fact.tokenToShareRatio === "number" && Number.isFinite(fact.tokenToShareRatio) && fact.tokenToShareRatio > 0) {
      return { kind: "allow", note: "premium:deferred" };
    }
    return { kind: "refuse", reason: "premium-unknown" };
  }
  const maxPremiumBps = options.maxPremiumBps ?? RWA_MAX_PREMIUM_BPS;
  if (premiumBps > maxPremiumBps) return { kind: "refuse", reason: "premium-too-high" };
  if (premiumBps <= -RWA_DISCOUNT_NOTE_BPS) {
    return { kind: "allow", note: `discount:${Math.abs(premiumBps / 100).toFixed(1)}%` };
  }
  return { kind: "allow", note: `premium:${percent(premiumBps)}` };
}
