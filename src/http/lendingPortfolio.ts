import type { Address } from "viem";
import type { DataPlaneClient, VenusReadResult } from "../clients/dataPlane.js";
import type { LendingPortfolioBalances } from "../lending/portfolioBalances.js";

export type LendingPortfolioView = {
  readonly status: "available" | "unavailable";
  readonly totalSupplyUsdMantissa: string | null;
  readonly totalBorrowedUsdMantissa: string | null;
  readonly dailyEarningUsdMantissa: string | null;
  readonly netApyBps: string | null;
  readonly blockNumber: string | null;
  readonly asOfMs: number | null;
  readonly reason: string | null;
};
const E18 = 10n ** 18n;
const APY_SCALE = 100_000_000n;
const row = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uint = (value: unknown): bigint | null =>
  typeof value === "string" && /^\d{1,78}$/u.test(value) ? BigInt(value) : null;
export const unavailableLendingPortfolio = (reason: string): LendingPortfolioView => ({
  status: "unavailable", totalSupplyUsdMantissa: null, totalBorrowedUsdMantissa: null,
  dailyEarningUsdMantissa: null, netApyBps: null, blockNumber: null, asOfMs: null, reason,
});

export function aggregateLendingPortfolio(balances: LendingPortfolioBalances, marketResult: VenusReadResult, nowMs = Date.now()): LendingPortfolioView {
  const missing = () => unavailableLendingPortfolio("Current Venus portfolio data is unavailable.");
  if (marketResult.kind !== "ok") return missing();
  const data = row(marketResult.envelope.data), meta = marketResult.envelope.meta;
  const asOf = meta?.["asOf"];
  if (data?.["schemaVersion"] !== 1 || data["chainId"] !== 56 || data["pool"] !== "core"
    || meta?.["staleness"] !== "fresh" || typeof asOf !== "number" || !Number.isSafeInteger(asOf)
    || nowMs < asOf || nowMs - asOf > 120_000 || !Array.isArray(data["markets"])) return missing();
  const markets = new Map<string, Record<string, unknown>>();
  for (const value of data["markets"]) {
    const market = row(value), token = market?.["vToken"];
    if (market === null || typeof token !== "string" || !/^0x[0-9a-f]{40}$/iu.test(token) || markets.has(token.toLowerCase())) return missing();
    markets.set(token.toLowerCase(), market);
  }
  let supply = 0n, borrow = 0n, yearly = 0n;
  for (const position of balances.positions) {
    const market = markets.get(position.vToken.toLowerCase());
    const prices = row(market?.["prices"]), underlying = row(market?.["underlying"]);
    const price = uint(prices?.["spot"]), decimals = underlying?.["decimals"];
    const supplyApy = market?.["supplyApyPct"], borrowApy = market?.["borrowApyPct"];
    if (price === null || price <= 0n || prices?.["scaleKind"] !== "venus_underlying_price"
      || typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36 || prices["decimals"] !== 36 - decimals
      || typeof supplyApy !== "number" || !Number.isFinite(supplyApy) || supplyApy < 0
      || typeof borrowApy !== "number" || !Number.isFinite(borrowApy) || borrowApy < 0
      || !Number.isSafeInteger(Math.round(supplyApy * Number(APY_SCALE))) || !Number.isSafeInteger(Math.round(borrowApy * Number(APY_SCALE)))
      || position.suppliedWei < 0n || position.borrowedWei < 0n) return missing();
    const supplied = position.suppliedWei * price / E18;
    const borrowed = position.borrowedWei * price / E18;
    supply += supplied; borrow += borrowed;
    yearly += (supplied * BigInt(Math.round(supplyApy * Number(APY_SCALE))) - borrowed * BigInt(Math.round(borrowApy * Number(APY_SCALE)))) / (100n * APY_SCALE);
  }
  const apyNumerator = yearly * 10_000n;
  const roundedApy = supply === 0n ? null : apyNumerator >= 0n
    ? (apyNumerator + supply / 2n) / supply : -((-apyNumerator + supply / 2n) / supply);
  return { status: "available", totalSupplyUsdMantissa: supply.toString(), totalBorrowedUsdMantissa: borrow.toString(),
    dailyEarningUsdMantissa: (yearly / 365n).toString(), netApyBps: roundedApy?.toString() ?? null,
    blockNumber: balances.blockNumber.toString(), asOfMs: Math.min(asOf, balances.observedAtMs), reason: null };
}

/** Bounded owner-display cache; never consulted by arm, rescue or retire. */
export function createLendingPortfolioProjection(input: {
  readonly dataPlane: Pick<DataPlaneClient, "venusMarkets">;
  readonly readBalances: (accounts: readonly Address[], signal?: AbortSignal) => Promise<LendingPortfolioBalances>;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; value: Promise<LendingPortfolioView> }>();
  let active = 0;
  return async (accounts: readonly Address[], requestSignal?: AbortSignal): Promise<LendingPortfolioView> => {
    requestSignal?.throwIfAborted();
    const key = [...new Set(accounts.map(account => account.toLowerCase()))].sort().join(":");
    const cached = cache.get(key);
    if (cached !== undefined && now() < cached.expiresAt) {
      const value = await cached.value;
      requestSignal?.throwIfAborted();
      if (value.status !== "available" || (value.asOfMs !== null && now() >= value.asOfMs && now() - value.asOfMs <= 120_000)) return value;
      if (cache.get(key) === cached) cache.delete(key);
      const refreshing = cache.get(key);
      if (refreshing !== undefined && refreshing !== cached && now() < refreshing.expiresAt) return refreshing.value;
    }
    if (active >= 4) return unavailableLendingPortfolio("Portfolio read is busy; refresh shortly.");
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    const timeout = AbortSignal.timeout(6_000);
    active += 1;
    const work = Promise.all([input.readBalances(accounts, timeout), input.dataPlane.venusMarkets(timeout)])
      .then(([balances, markets]) => aggregateLendingPortfolio(balances, markets, now()))
      .catch(() => unavailableLendingPortfolio("Current Venus portfolio data is unavailable."))
      .finally(() => { active -= 1; });
    const value = Promise.race([work, new Promise<LendingPortfolioView>(resolve => {
      timeout.addEventListener("abort", () => resolve(unavailableLendingPortfolio("Portfolio read timed out.")), { once: true });
    })]);
    cache.set(key, { expiresAt: now() + 15_000, value });
    return value;
  };
}
