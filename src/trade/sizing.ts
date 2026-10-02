/** Trading-agent admission arithmetic (TRADING-AGENT R2 / R3.2). */
import type { SessionFacts } from "../store/agents.js";
import { RELAY_FEE_PER_EXIT_WEI } from "../ops/relayFee.js";
import type { TradeExecutionModel } from "./settings.js";
import { MAX_UINT256 } from "./settlement.js";

export const MIN_ENTRY_WEI = 2_000_000_000_000_000n;
export const MIN_CAPITAL_WEI = 10_000_000_000_000_000n;
/** TradFi v2's user-facing defaults, in USDT atomic units. */
export const DEFAULT_TRADFI_V2_MIN_ENTRY_WEI = 5_000_000_000_000_000_000n;
export const DEFAULT_TRADFI_V2_MAX_ENTRY_WEI = 20_000_000_000_000_000_000n;
export const DEFAULT_CMC_TOTAL_BUDGET_WEI = 2_000_000_000_000_000_000n;
/** Mirrors the boot ceiling in ops/fees without importing through http/wire. */
export const MAX_PLATFORM_FEE_BPS = 500;
export const MAX_GRANTED_TOKENS = 25;
/** Measured 2026-09-17 (FINDINGS (bp)): 28 tokens / 36 rules granted in 19.7 s; a 54-token grant hung PENDING. The data plane admits 28–29 stocks at the $10k floor, so this is the universe, not a cap. */
export const MAX_GRANTED_TOKENS_TRADFI = 28;
export function maxGrantedTokens(model: TradeExecutionModel): number {
  return model === "tradfi" ? MAX_GRANTED_TOKENS_TRADFI : MAX_GRANTED_TOKENS;
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
  tradfi: {
    perTrade: 20_000_000_000_000_000n,
    maxPositions: 3,
    capital: MIN_CAPITAL_WEI,
    minConfidence: 80,
  },
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

export type TradfiV2SizingInput = {
  readonly minEntryWei: bigint;
  readonly maxEntryWei: bigint;
  readonly capitalQuoteWei: bigint;
  readonly maxOpenPositions: number;
  readonly grantedTokenCount: number;
  readonly platformFeeBps: number;
  readonly capDayWei: bigint;
};

export type TradfiV2SizingResult = {
  readonly ok: boolean;
  readonly requiredQuoteWei: bigint;
  readonly shortfallQuoteWei: bigint;
  readonly feePerMaxEntryWei: bigint;
  readonly nativeReserveWei: bigint;
  readonly nativeShortfallWei: bigint;
};

export function tradfiV2BuyFeeWei(amountWei: bigint, platformFeeBps: number): bigint {
  if (amountWei < 0n || !Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > MAX_PLATFORM_FEE_BPS) {
    throw new Error("TradFi v2 fee inputs are invalid.");
  }
  return amountWei * BigInt(platformFeeBps) / 10_000n;
}

/** C1: the rolling-day quote cap includes the one buy fee. */
export function tradfiV2EntryReservation(amountWei: bigint, platformFeeBps: number): bigint {
  return amountWei + tradfiV2BuyFeeWei(amountWei, platformFeeBps);
}

export function tradfiV2NativeReserveWei(
  maxOpenPositions: number,
  grantedTokenCount: number,
  relayFeeWei: bigint = RELAY_FEE_PER_EXIT_WEI,
): bigint {
  if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 10) {
    throw new Error("maxOpenPositions must be an integer in 1..10.");
  }
  if (!Number.isInteger(grantedTokenCount) || grantedTokenCount < 0) {
    throw new Error("grantedTokenCount must be a non-negative integer.");
  }
  if (relayFeeWei < 0n) throw new Error("relayFeeWei must be non-negative.");
  return (2n * BigInt(maxOpenPositions) + BigInt(Math.max(1, grantedTokenCount)) + 1n) * relayFeeWei;
}

/** Validate the closed v2 funding tuple without converting USDT into BNB. */
export function checkTradfiV2Sizing(input: TradfiV2SizingInput): TradfiV2SizingResult {
  const positionsValid = Number.isInteger(input.maxOpenPositions)
    && input.maxOpenPositions >= 1 && input.maxOpenPositions <= 10;
  const feeValid = Number.isInteger(input.platformFeeBps)
    && input.platformFeeBps >= 0 && input.platformFeeBps <= MAX_PLATFORM_FEE_BPS;
  const grantedValid = Number.isInteger(input.grantedTokenCount) && input.grantedTokenCount >= 1 && input.grantedTokenCount <= MAX_GRANTED_TOKENS_TRADFI;
  const boundsValid = input.minEntryWei > 0n
    && input.maxEntryWei >= input.minEntryWei
    && input.capitalQuoteWei >= 0n
    && input.minEntryWei <= MAX_UINT256 && input.maxEntryWei <= MAX_UINT256 && input.capitalQuoteWei <= MAX_UINT256;
  const fee = feeValid ? tradfiV2BuyFeeWei(input.maxEntryWei, input.platformFeeBps) : 0n;
  const positions = positionsValid ? BigInt(input.maxOpenPositions) : 1n;
  const requiredQuoteWei = positions * (input.maxEntryWei + fee);
  const nativeReserveWei = tradfiV2NativeReserveWei(
    positionsValid ? input.maxOpenPositions : 1,
    grantedValid ? input.grantedTokenCount : 1,
  );
  const quoteShortfall = input.capitalQuoteWei >= requiredQuoteWei ? 0n : requiredQuoteWei - input.capitalQuoteWei;
  const nativeShortfall = input.capDayWei >= nativeReserveWei ? 0n : nativeReserveWei - input.capDayWei;
  return {
    ok: positionsValid && feeValid && boundsValid && grantedValid && quoteShortfall === 0n && nativeShortfall === 0n,
    requiredQuoteWei,
    shortfallQuoteWei: quoteShortfall,
    feePerMaxEntryWei: fee,
    nativeReserveWei,
    nativeShortfallWei: nativeShortfall,
  };
}

export function tradfiScheduleNativeReserveWei(input: {
  readonly plannedBuys: number;
  readonly buysThisSession: number;
  /**
   * The submit-time `nativeReserveFloor` keeps ONE exit fee for a schedule
   * agent (TRADFI-SCHEDULE-NATIVE-CAP-PLAN A1) — a schedule agent never sells
   * through the plane (drain/exit refuse `schedule_no_sell`), so the reserve
   * no longer scales with the chain-granted token count. `+2` = the floor's
   * own fee (`ownFeeWei`) plus that one-token reserve.
   */
  readonly relayFeeWei?: bigint;
}): bigint {
  if (!Number.isSafeInteger(input.plannedBuys) || input.plannedBuys < 0
    || !Number.isSafeInteger(input.buysThisSession) || input.buysThisSession < 0) {
    throw new Error("Schedule buy counts must be non-negative safe integers.");
  }
  const relayFeeWei = input.relayFeeWei ?? RELAY_FEE_PER_EXIT_WEI;
  if (relayFeeWei < 0n) throw new Error("relayFeeWei must be non-negative.");
  return (BigInt(Math.min(input.plannedBuys, input.buysThisSession)) + 2n) * relayFeeWei;
}

export type ScheduleNativeNeedsInput = {
  readonly intervalSec: 3600 | 14400 | 28800 | 43200 | 86400;
  /** `max(0, plannedBuys - fills)`, read from the refreshed view. */
  readonly remainingBuys: number;
  /** Session expiry minus now, in milliseconds. `<= 0` means no session time left. */
  readonly sessionRemainingMs: number;
  readonly relayFeeWei?: bigint;
};

export type ScheduleNativeNeeds = {
  /** Buys the interval admits in one rolling day, bounded by what is left to run. */
  readonly buysPerDay: number;
  /** The DAY native cap an interval edit needs (TRADFI-SCHEDULE-NATIVE-CAP-PLAN B1). */
  readonly dayCapWei: bigint;
  /** Buys the remaining session time admits, bounded by what is left to run. */
  readonly sessionBuys: number;
  /** The wallet BNB balance an interval edit needs to clear the rest of the session. */
  readonly balanceWei: bigint;
};

/**
 * What an interval edit needs to raise, if anything: the on-chain DAY cap and
 * the wallet's native balance (TRADFI-SCHEDULE-NATIVE-CAP-PLAN B1).
 *
 * `+2` on each count mirrors {@link tradfiScheduleNativeReserveWei}: the
 * floor's own fee plus the one-token exit reserve every buy leaves behind.
 */
export function scheduleNativeNeeds(input: ScheduleNativeNeedsInput): ScheduleNativeNeeds {
  if (!Number.isSafeInteger(input.remainingBuys) || input.remainingBuys < 0) {
    throw new Error("remainingBuys must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.sessionRemainingMs)) {
    throw new Error("sessionRemainingMs must be a safe integer.");
  }
  const relayFeeWei = input.relayFeeWei ?? RELAY_FEE_PER_EXIT_WEI;
  if (relayFeeWei < 0n) throw new Error("relayFeeWei must be non-negative.");
  const buysPerDay = Math.min(input.remainingBuys, Math.ceil(86_400 / input.intervalSec));
  const dayCapWei = (BigInt(buysPerDay) + 2n) * relayFeeWei;
  const sessionBuys = input.sessionRemainingMs <= 0
    ? 0
    : Math.min(input.remainingBuys, Math.floor(input.sessionRemainingMs / (input.intervalSec * 1_000)) + 1);
  const balanceWei = (BigInt(sessionBuys) + 2n) * relayFeeWei;
  return { buysPerDay, dayCapWei, sessionBuys, balanceWei };
}

export type TradfiScheduleSizingInput = {
  readonly capDayWei: bigint;
  readonly entryWei: bigint;
  readonly capitalQuoteWei: bigint;
  readonly platformFeeBps: number;
  readonly grantedTokenCount: number;
  readonly intervalSec: 3600 | 14400 | 28800 | 43200 | 86400;
  readonly ttlSec: number;
  readonly endKind: "budget" | "date" | "runs";
  readonly endRuns: number | null;
  readonly endAtSec: number | null;
  readonly anchorAtSec: number;
};

export type TradfiScheduleSizingResult = {
  readonly ok: boolean;
  readonly requiredQuoteWei: bigint;
  readonly shortfallQuoteWei: bigint;
  readonly plannedBuys: number;
  readonly buysThisSession: number;
  readonly nativeReserveWei: bigint;
  readonly nativeShortfallWei: bigint;
};

export function checkTradfiScheduleSizing(input: TradfiScheduleSizingInput): TradfiScheduleSizingResult {
  // R2.1 (BLOCKER-1): capDayWei: MAX_UINT256 so quote.ok is bounds + USDT side only;
  // the native side is judged solely against the schedule reserve below, never the v2 (N+3)*R floor.
  const quote = checkTradfiV2Sizing({ capDayWei: MAX_UINT256, minEntryWei: input.entryWei, maxEntryWei: input.entryWei,
    capitalQuoteWei: input.capitalQuoteWei, maxOpenPositions: 1, grantedTokenCount: input.grantedTokenCount, platformFeeBps: input.platformFeeBps });
  const reservation = tradfiV2EntryReservation(input.entryWei, input.platformFeeBps);
  const rawPlanned = reservation <= 0n ? 0 : Number(input.capitalQuoteWei / reservation);
  let plannedBuys = Number.isSafeInteger(rawPlanned) ? rawPlanned : Number.MAX_SAFE_INTEGER;
  if (input.endKind === "runs" && input.endRuns !== null) plannedBuys = Math.min(plannedBuys, input.endRuns);
  if (input.endKind === "date" && input.endAtSec !== null) {
    const beforeEnd = input.endAtSec * 1_000 - input.anchorAtSec * 1_000 - 1;
    const dateSlots = beforeEnd < 0 ? 0 : Math.floor(beforeEnd / (input.intervalSec * 1_000)) + 1;
    plannedBuys = Math.min(plannedBuys, dateSlots);
  }
  const sessionWindowMs = input.ttlSec * 1_000 - 7_200_000 - 1;
  const sessionBuys = sessionWindowMs < 0 ? 0 : Math.floor(sessionWindowMs / (input.intervalSec * 1_000)) + 1;
  const nativeReserveWei = tradfiScheduleNativeReserveWei({ plannedBuys, buysThisSession: sessionBuys });
  const nativeShortfallWei = input.capDayWei >= nativeReserveWei ? 0n : nativeReserveWei - input.capDayWei;
  return { ok: quote.ok && nativeShortfallWei === 0n, requiredQuoteWei: quote.requiredQuoteWei,
    shortfallQuoteWei: quote.shortfallQuoteWei, plannedBuys, buysThisSession: sessionBuys,
    nativeReserveWei, nativeShortfallWei };
}

/**
 * Auto DCA's per-submission native unit (AUTO-DCA-SPEC R2.9, REVIEW2 condition
 * 7; the value is unchanged by R3.5). Two of it are the sweep reserve: two
 * sweeps of `O + (1 + a)·X` at the quoted 3.38× (≤ 2.91e14) fit in 2 × R_DCA.
 * Under R3 it no longer bounds one batch: batch 2 at `a` = 2 is 3.49e14 (NVDAB)
 * to 4.63e14 (class) at the billed 2.45×, and the submit-time floor uses the
 * real quote. E until G2.
 */
export const R_DCA = 320_000_000_000_000n;

/**
 * The signed native day cap an Auto DCA hire needs (R2.9, unchanged by R3.5):
 * `(2N + 4) × R_DCA`. It covers a busy R3 round — a close + start exiting `a`
 * resting levels, then N fills one per batch — plus two sweeps, at the quoted
 * 3.38×, for every N (the class pools at N = 4 are the tightest, ≈ 58 %).
 * N = 4: 3.84e15; N = 8: 6.4e15.
 */
export function dcaNativeReserveWei(maxOrders: number): bigint {
  if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > 8) {
    throw new Error("dcaMaxOrders must be an integer in 1..8.");
  }
  return (2n * BigInt(maxOrders) + 4n) * R_DCA;
}

export type TradfiDcaSizingInput = {
  readonly capDayWei: bigint;
  readonly entryWei: bigint;
  readonly dcaOrderWei: bigint;
  readonly dcaMaxOrders: number;
  readonly capitalQuoteWei: bigint;
};

export type TradfiDcaSizingResult = {
  readonly ok: boolean;
  readonly requiredQuoteWei: bigint;
  readonly shortfallQuoteWei: bigint;
  readonly nativeReserveWei: bigint;
  readonly nativeShortfallWei: bigint;
};

/**
 * §13.2: the USDT side is `capitalQuoteWei ≥ B + N·D` (always true for a parsed
 * DCA tuple, which signs it exactly); the native side is the signed day cap
 * against {@link dcaNativeReserveWei}. The provision route's check is the
 * authority; the web mirror is a convenience.
 */
export function checkTradfiDcaSizing(input: TradfiDcaSizingInput): TradfiDcaSizingResult {
  const requiredQuoteWei = input.entryWei + BigInt(input.dcaMaxOrders) * input.dcaOrderWei;
  const nativeReserveWei = dcaNativeReserveWei(input.dcaMaxOrders);
  const shortfallQuoteWei = input.capitalQuoteWei >= requiredQuoteWei ? 0n : requiredQuoteWei - input.capitalQuoteWei;
  const nativeShortfallWei = input.capDayWei >= nativeReserveWei ? 0n : nativeReserveWei - input.capDayWei;
  return {
    ok: input.entryWei > 0n && input.dcaOrderWei > 0n && shortfallQuoteWei === 0n && nativeShortfallWei === 0n,
    requiredQuoteWei, shortfallQuoteWei, nativeReserveWei, nativeShortfallWei,
  };
}

export function portfolioMinCapitalWei(tokenCount: number): bigint {
  return (50n + 25n * BigInt(tokenCount - 2)) * 10n ** 18n;
}

export function tradfiPortfolioNativeReserveWei(input: {
  readonly tokenCount: number;
  readonly intervalSec: 14400 | 28800 | 43200 | 86400;
  readonly relayFeeWei?: bigint;
}): bigint {
  const slots = Math.ceil(86_400 / input.intervalSec) + 1;
  return BigInt(slots * input.tokenCount + input.tokenCount + 2) * (input.relayFeeWei ?? RELAY_FEE_PER_EXIT_WEI);
}

export function checkTradfiPortfolioSizing(input: {
  readonly capDayWei: bigint;
  readonly capitalQuoteWei: bigint;
  readonly tokenCount: number;
  readonly intervalSec: 14400 | 28800 | 43200 | 86400;
}): {
  readonly ok: boolean;
  readonly requiredQuoteWei: bigint;
  readonly shortfallQuoteWei: bigint;
  readonly nativeReserveWei: bigint;
  readonly nativeShortfallWei: bigint;
} {
  const requiredQuoteWei = portfolioMinCapitalWei(input.tokenCount);
  const shortfallQuoteWei = input.capitalQuoteWei >= requiredQuoteWei ? 0n : requiredQuoteWei - input.capitalQuoteWei;
  const nativeReserveWei = tradfiPortfolioNativeReserveWei(input);
  const nativeShortfallWei = input.capDayWei >= nativeReserveWei ? 0n : nativeReserveWei - input.capDayWei;
  return { ok: shortfallQuoteWei === 0n && nativeShortfallWei === 0n,
    requiredQuoteWei, shortfallQuoteWei, nativeReserveWei, nativeShortfallWei };
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
