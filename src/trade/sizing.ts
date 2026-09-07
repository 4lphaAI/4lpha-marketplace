/** Trading-agent admission arithmetic (TRADING-AGENT R2 / R3.2). */
import type { SessionFacts } from "../store/agents.js";
import { RELAY_FEE_PER_EXIT_WEI } from "../ops/relayFee.js";
import type { TradeExecutionModel } from "./settings.js";

export const MIN_ENTRY_WEI = 2_000_000_000_000_000n;
export const MIN_CAPITAL_WEI = 10_000_000_000_000_000n;
/** Mirrors the boot ceiling in ops/fees without importing through http/wire. */
export const MAX_PLATFORM_FEE_BPS = 500;
export const MAX_GRANTED_TOKENS = 25;
export function maxGrantedTokens(_model: TradeExecutionModel): number {
  return MAX_GRANTED_TOKENS;
}

/** Leave a conservative buy + sell relay allowance inside every entry budget. */
export const TRADE_ENTRY_RELAY_HEADROOM_WEI = 2n * RELAY_FEE_PER_EXIT_WEI;

export function sizeTradeBuy(input: {
  readonly entryWei: bigint;
  readonly perTradeCapWei: bigint | undefined;
  readonly platformFeeBps: number;
}): { readonly amountWei: bigint; readonly feeWei: bigint; readonly budgetWei: bigint } | null {
  if (!Number.isInteger(input.platformFeeBps) || input.platformFeeBps < 0
    || input.platformFeeBps > MAX_PLATFORM_FEE_BPS) return null;
  const budgetWei = input.perTradeCapWei !== undefined && input.perTradeCapWei < input.entryWei
    ? input.perTradeCapWei : input.entryWei;
  if (budgetWei <= TRADE_ENTRY_RELAY_HEADROOM_WEI) return null;
  // Settings remain the owner's maximum entry; only the worker's pre-fee swap
  // input shrinks. Quote, intent and executor must all receive this same input.
  const bps = BigInt(input.platformFeeBps);
  const amountWei = (budgetWei - TRADE_ENTRY_RELAY_HEADROOM_WEI) * 10_000n / (10_000n + bps);
  if (amountWei <= 0n) return null;
  return { amountWei, feeWei: amountWei * bps / 10_000n, budgetWei };
}

export type TradeModelPreset = {
  readonly perTrade: bigint;
  readonly maxPositions: number;
  readonly capital: bigint;
  readonly minConfidence: number;
};

export const TRADE_MODEL_PRESETS: Readonly<
  Record<TradeExecutionModel, TradeModelPreset>
> = {
  "blue-chip": {
    perTrade: 2_000_000_000_000_000n,
    maxPositions: 3,
    capital: MIN_CAPITAL_WEI,
    minConfidence: 80,
  },
  "mid-cap": {
    perTrade: 2_000_000_000_000_000n,
    maxPositions: 3,
    capital: MIN_CAPITAL_WEI,
    minConfidence: 80,
  },
  degen: {
    perTrade: 2_000_000_000_000_000n,
    maxPositions: 3,
    capital: MIN_CAPITAL_WEI,
    minConfidence: 75,
  },
  sigma: {
    perTrade: 2_000_000_000_000_000n,
    maxPositions: 3,
    capital: MIN_CAPITAL_WEI,
    minConfidence: 72,
  },
};

export type TradeSizingInput = {
  readonly capDayWei: bigint;
  readonly entryWei: bigint;
  readonly maxOpenPositions: number;
  readonly grantedTokenCount: number;
  readonly platformFeeBps: number;
};

export type TradeSizingResult = {
  readonly ok: boolean;
  readonly requiredWei: bigint;
  readonly shortfallWei: bigint;
  readonly minimumCapWei: bigint;
  readonly platformFeePerEntryWei: bigint;
  readonly platformFeeTotalWei: bigint;
};

/** The exact R2 formula; malformed counts fail without changing the arithmetic. */
export function checkTradeSizing(input: TradeSizingInput): TradeSizingResult {
  const countIsValid = Number.isInteger(input.maxOpenPositions)
    && input.maxOpenPositions >= 1
    && input.maxOpenPositions <= 10;
  const feeIsValid = Number.isInteger(input.platformFeeBps)
    && input.platformFeeBps >= 0
    && input.platformFeeBps <= MAX_PLATFORM_FEE_BPS;
  const positions = Number.isInteger(input.maxOpenPositions)
    ? BigInt(input.maxOpenPositions)
    : 0n;
  // AUDIT L4: use the shared fee constant directly so sizing and policy do not form an import cycle.
  const reserveWei = BigInt(Math.max(1, input.grantedTokenCount)) * RELAY_FEE_PER_EXIT_WEI;
  const standing = RELAY_FEE_PER_EXIT_WEI + reserveWei;
  const platformFeePerEntryWei = feeIsValid
    ? (input.entryWei * BigInt(input.platformFeeBps)) / 10_000n
    : 0n;
  const platformFeeTotalWei = positions * platformFeePerEntryWei;
  const requiredWei = positions * input.entryWei
    + platformFeeTotalWei
    + positions * RELAY_FEE_PER_EXIT_WEI
    + standing;
  const minimumCapWei = requiredWei > MIN_CAPITAL_WEI ? requiredWei : MIN_CAPITAL_WEI;
  const ok = countIsValid
    && feeIsValid
    && input.capDayWei >= minimumCapWei
    && input.entryWei >= MIN_ENTRY_WEI;
  return {
    ok,
    requiredWei,
    shortfallWei: input.capDayWei >= minimumCapWei ? 0n : minimumCapWei - input.capDayWei,
    minimumCapWei,
    platformFeePerEntryWei,
    platformFeeTotalWei,
  };
}

/**
 * The untokened native cap with `period === "day"` (TRADING-AGENT R4 C28).
 * TOTAL: `null` on zero or more than one match and the caller refuses — the
 * single-entry property belongs to the trade S1 hook, not to the template.
 */
export function nativeDayCapWei(facts: Pick<SessionFacts, "spec">): bigint | null {
  const native = facts.spec.spendCaps.filter((cap) => cap.token === undefined && cap.period === "day");
  const cap = native[0];
  if (native.length !== 1 || cap === undefined) return null;
  return cap.limit;
}
