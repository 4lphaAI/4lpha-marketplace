import { tradfiV2NativeReserveWei } from "@/lib/trade";

export type TradfiV2FundingInput = {
  readonly funding: {
    readonly requiredWei: string;
    readonly balanceWei: string | null;
    readonly quoteRequiredWei?: string;
    readonly quoteBalanceWei?: string | null;
  };
  readonly sizing: {
    readonly maxOpenPositions: number;
    readonly grantedTokenCount: number;
    readonly tradeRelayFeePerSubmitWei: string;
    readonly nativeReserveWei?: string;
  };
  readonly capitalQuoteWei: string;
  readonly cmcTotalBudgetWei?: string;
  /** The SIGNED native day cap; the plane funds against it, and it may exceed the reserve the preview reports. */
  readonly capDayWei?: string;
};

export type TradfiV2FundingSnapshot = {
  readonly nativeReserveWei: bigint;
  readonly nativeTargetWei: bigint;
  readonly nativeBalanceWei: bigint | null;
  readonly nativeShortfallWei: bigint;
  readonly quoteRequiredWei: bigint;
  readonly quoteBalanceWei: bigint | null;
  readonly quoteShortfallWei: bigint;
};

/** The same native and quote funding tuple used by the v2 hire gate. */
export function tradfiV2FundingSnapshot(input: TradfiV2FundingInput): TradfiV2FundingSnapshot {
  const nativeReserveWei = input.sizing.nativeReserveWei === undefined
    ? tradfiV2NativeReserveWei({ maxOpenPositions: input.sizing.maxOpenPositions, grantedTokenCount: input.sizing.grantedTokenCount, relayFeeWei: BigInt(input.sizing.tradeRelayFeePerSubmitWei) })
    : BigInt(input.sizing.nativeReserveWei);
  const signedCapWei = input.capDayWei === undefined ? 0n : BigInt(input.capDayWei);
  const nativeTargetWei = BigInt(input.funding.requiredWei) + (signedCapWei > nativeReserveWei ? signedCapWei : nativeReserveWei);
  const nativeBalanceWei = input.funding.balanceWei === null ? null : BigInt(input.funding.balanceWei);
  const nativeShortfallWei = nativeBalanceWei === null || nativeTargetWei > nativeBalanceWei
    ? nativeBalanceWei === null ? nativeTargetWei : nativeTargetWei - nativeBalanceWei : 0n;
  const quoteRequiredWei = input.funding.quoteRequiredWei === undefined
    ? BigInt(input.capitalQuoteWei) + BigInt(input.cmcTotalBudgetWei ?? "0") : BigInt(input.funding.quoteRequiredWei);
  const quoteBalanceWei = input.funding.quoteBalanceWei === undefined || input.funding.quoteBalanceWei === null
    ? null : BigInt(input.funding.quoteBalanceWei);
  const quoteShortfallWei = quoteBalanceWei === null || quoteRequiredWei > quoteBalanceWei
    ? quoteBalanceWei === null ? quoteRequiredWei : quoteRequiredWei - quoteBalanceWei : 0n;
  return { nativeReserveWei, nativeTargetWei, nativeBalanceWei, nativeShortfallWei, quoteRequiredWei, quoteBalanceWei, quoteShortfallWei };
}
