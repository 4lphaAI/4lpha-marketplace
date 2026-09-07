import type { Address } from "viem";
import type { FeatureInterval } from "../../src/trade/features.js";
const addr = (n: number) => `0x${n.toString(16).padStart(40,"0")}` as Address;
export function featureFixture(interval: FeatureInterval, token = addr(2), at = 1_800_000_090_000) {
  const step = interval === "15m" ? 900_000 : 3_600_000;
  const close = Math.floor((at - 15_000)/step)*step;
  const metric = (value: number, unit: string, requiredBars: number) => ({value,unit,requiredBars,usableBars:requiredBars,available:true,reason:null});
  return {version:"pool-features-v2",staleness:"fresh",snapshotId:"a".repeat(64),seriesId:"b".repeat(64),
    identity:{chainId:56,poolAddress:addr(1),baseAddress:token,quoteAddress:addr(3),interval,priceCurrency:"usd",observedAt:at},
    calculatedAt:at,evaluationClose:close,expiresAt:close+step+90_000,coverage:{latestClose:close,contiguousBars:52},
    metrics:{ema12:metric(2,"usd_per_base_token",24),ema26:metric(1,"usd_per_base_token",52),emaSpreadPct:metric(1,"percent",52),
      roc10Pct:metric(1,"percent",11),atr14:metric(1,"usd_per_base_token",29),atrPct:metric(1,"percent",29),rvol20:metric(1,"ratio",21)}};
}
