import {
  parseQuantBandTiers,
  type QuantStrategyParams,
} from "./config.js";

function percent(bps: number): string {
  const value = bps / 100;
  return Number.isInteger(value) ? `${value}` : value.toFixed(2).replace(/0+$/u, "");
}

function wholeU(wei: bigint): string {
  return (wei / 10n ** 18n).toString(10);
}

function bnb(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString(10).padStart(18, "0").replace(/0+$/u, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
}

/**
 * The B2 listing is configuration-derived text. It intentionally remains
 * plain text: the marketplace owns presentation, while this module owns the
 * promises that the runtime's admitted parameters actually keep.
 */
export function quantB2ListingText(params: QuantStrategyParams): string {
  const tiers = parseQuantBandTiers(params.bandTiers);
  const first = tiers[0];
  const second = tiers[1];
  const minimum = first === undefined ? "0" : wholeU(first.minAllocationUWei);
  const relayFloorBnb = bnb(params.relayFeePerSubmitWei);
  const bandText = first === undefined
    ? ""
    : second === undefined
      ? `Each cell's nominal sell price is ${percent(first.bandBps)} % above its buy price.`
      : `Each cell's nominal sell price is ${percent(first.bandBps)} % above its buy price for allocations below ${wholeU(second.minAllocationUWei)} U, and ${percent(second.bandBps)} % above it from ${wholeU(second.minAllocationUWei)} U.`;
  const cooldownHours = Math.floor(params.recenterCooldownSec / 3_600);
  return `Minimum ${minimum} U. ${bandText} Admission also depends on current pool liquidity, gas and session caps. Relay fees are estimated from live BNB gas prices with a floor of ${relayFloorBnb} BNB per submission; the relay's actual charge is not bounded by that estimate. Buys require gas reserves for their expected exits; sells wait until their minimum output covers recorded principal, estimated fees and the configured edge. Higher gas may delay trading or require more BNB. Returns are not guaranteed. At job start, each upper cell in a symmetric grid is swapped to WBNB at market within the configured seed window; cells above the start price sell on the way up and buy back on the way down, while cells below buy on the way down and sell on the way up. A seed that fills above its nominal line waits for a price that covers its actual cost before selling. Re-centering needs two consecutive accepted out-of-grid readings, no order in flight, and the configured ${cooldownHours}-hour cooldown; moving down never abandons a cell below its cost, and moving up may schedule one ordinary re-seed when the wallet and session permit it. A submitted order with no positive resolution evidence remains blocked until it is resolved or permanently retired; there is no silence-based absence proof. Inventory held at term end is returned as WBNB without a forced sale. An illustrative calm-gas figure is about 0.0001 BNB per order; the rehearsal displays the actual required amount. Terms: 7, 30 or 90 days; a shorter term is refused.`;
}

/** R14.5's listed B2 process configuration, used only for the fixture. */
export const QUANT_B2_SELF_TEST_LISTING_TEXT = quantB2ListingText({
  strategyVersion: "grid-v2-quant:1",
  seedMode: "symmetric",
  seedWindowCycles: 9,
  bandTiers: "10:250,30:200",
  maxLevels: 3,
  minClipUWei: 5n * 10n ** 18n,
  minNetEdgeBps: 25,
  entryTolBps: 40,
  exitTolBps: 10,
  maxImpactBps: 50,
  cooldownSec: 180,
  maxQuoteLagBlocks: 40,
  relayFeePerSubmitWei: 30_000_000_000_000n,
  relayGasUnits: 300_000n,
  relayFeePadBps: 15_000n,
  recenterMode: "both",
  recenterCooldownSec: 86_400,
  recenterBudgetDays: 1,
  minTermDays: 7,
});
