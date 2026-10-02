/** Smart Portfolio's signed basket and pinned-pool valuation. */
import { dcaPoolForToken } from "./dca.js";
import { portfolioMinCapitalWei, tradfiPortfolioNativeReserveWei, checkTradfiPortfolioSizing } from "./sizing.js";
import { USDT_56 } from "./settlement.js";
import type { RouteQuoteReader } from "./route.js";

export { portfolioMinCapitalWei, tradfiPortfolioNativeReserveWei, checkTradfiPortfolioSizing };

export const PORTFOLIO_INTERVALS_SEC = [14400, 28800, 43200, 86400] as const;
export const PORTFOLIO_MIN_TOKENS = 2;
export const PORTFOLIO_MAX_TOKENS = 5;
export const PORTFOLIO_MIN_WEIGHT_BPS = 1000;
export const PORTFOLIO_MIN_DRIFT_BPS = 50;
export const PORTFOLIO_MAX_DRIFT_BPS = 1500;
export const PORTFOLIO_MIN_LEG_WEI = 10n ** 17n;
export const PORTFOLIO_LEGACY_MIN_LEG_WEI = 10n ** 18n;
export const PORTFOLIO_DUST_TOKEN_WEI = 10n ** 12n;
export const PORTFOLIO_PLATFORM_FEE_BPS = 0;

export function portfolioStockAllowed(token: string): boolean {
  return dcaPoolForToken(token) !== null;
}

/** A failed pinned quote makes the whole portfolio valuation unavailable. */
export async function portfolioStockValue(reader: Pick<RouteQuoteReader, "quoteV3Single">, token: string, balance: bigint): Promise<bigint | null> {
  if (balance < PORTFOLIO_DUST_TOKEN_WEI) return 0n;
  const pool = dcaPoolForToken(token);
  if (pool === null) return null;
  try {
    const quote = await reader.quoteV3Single(pool.stock, USDT_56, pool.fee, balance);
    return quote > 0n ? quote : null;
  } catch {
    return null;
  }
}
