/** Closed settlement assets used by trading positions and signed settings. */
import { getAddress, type Address } from "viem";

export type TradeSettlementAsset = "BNB" | "USDT";

export type SettlementDescriptor = {
  readonly asset: TradeSettlementAsset;
  readonly chainId: 56;
  readonly symbol: "BNB" | "USDT";
  readonly decimals: 18;
  readonly token: Address | null;
};

export const USDT_56: Address = getAddress(
  "0x55d398326f99059fF775485246999027B3197955",
);

/** TRADFI-AI-TRADE-V3 §5: on-chain rolling-day USDT cap = capital x this turns count. */
export const TRADFI_V2_QUOTE_CAP_TURNS = 5n;

export const BNB_SETTLEMENT: SettlementDescriptor = Object.freeze({
  asset: "BNB", chainId: 56, symbol: "BNB", decimals: 18, token: null,
});

export const USDT_SETTLEMENT: SettlementDescriptor = Object.freeze({
  asset: "USDT", chainId: 56, symbol: "USDT", decimals: 18, token: USDT_56,
});

export const MAX_UINT256 = (1n << 256n) - 1n;

/** Legacy TradFi rows have no discriminator and therefore remain native. */
export function settlementForAsset(asset: "USDT" | undefined): SettlementDescriptor {
  return asset === "USDT" ? USDT_SETTLEMENT : BNB_SETTLEMENT;
}

export function isTradfiV2Settlement(asset: unknown): asset is "USDT" {
  return asset === "USDT";
}

export function isCanonicalSettlementToken(value: Address, asset: TradeSettlementAsset): boolean {
  return asset === "BNB" ? false : value.toLowerCase() === USDT_56.toLowerCase();
}

export function isCanonicalAtomic(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/u.test(value)) return false;
  return BigInt(value) <= MAX_UINT256;
}

export function parsePositiveAtomic(value: unknown, field: string): bigint {
  if (!isCanonicalAtomic(value) || BigInt(value) <= 0n) {
    throw new Error(`${field} must be a positive uint256 decimal string.`);
  }
  return BigInt(value);
}
