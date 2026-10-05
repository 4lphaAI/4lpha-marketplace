/** `blue-chip` is READ-ONLY legacy (stored hires); new hires send `tradfi` (2026-09-17). */
export type TradeExecutionModel = "tradfi" | "mid-cap" | "degen" | "sigma" | "blue-chip";
export type TradeGasPriority = "low" | "standard" | "high";

export type TradeSettings = {
  readonly name: string;
  readonly executionModel: TradeExecutionModel;
  readonly entryWei: string;
  readonly maxOpenPositions: number;
  readonly minMarketCapUsd: number | null;
  readonly maxMarketCapUsd: number | null;
  readonly noReentry: boolean;
  readonly takeProfitBps: number | null;
  readonly stopLossBps: number | null;
  readonly maxHoldSec: number | null;
  readonly breakEvenAfterTp: boolean;
  readonly slippageBps: number;
  readonly gasPriority: TradeGasPriority;
  readonly instructions: string | null;
  readonly skillMarkdown: string | null;
  readonly primaryModel: TradeLlmModelId;
  readonly fallbackModel: TradeLlmModelId;
  /** Optional on the wire so pre-revision agents remain readable. */
  readonly crashProtection?: boolean;
  readonly settlementAsset?: "USDT";
  readonly minEntryWei?: string;
  readonly capitalQuoteWei?: string;
  readonly cmcNewsEnabled?: boolean;
  readonly cmcTotalBudgetWei?: string;
  readonly tradeMode?: "schedule" | "dca" | "portfolio";
  readonly portfolioTokens?: readonly string[];
  readonly portfolioWeightsBps?: readonly number[];
  readonly portfolioDriftBps?: number;
  readonly portfolioIntervalSec?: 14400 | 28800 | 43200 | 86400;
  readonly scheduleToken?: string;
  readonly scheduleIntervalSec?: 3600 | 14400 | 28800 | 43200 | 86400;
  readonly scheduleFirstAtSec?: number | null;
  readonly scheduleEndKind?: "budget" | "date" | "runs";
  readonly scheduleEndAtSec?: number | null;
  readonly scheduleEndRuns?: number | null;
  readonly scheduleMarketHoursOnly?: boolean;
  readonly scheduleMaxPremiumBps?: number;
  /** Auto DCA (AUTO-DCA-SPEC §8.1), all-or-nothing with `tradeMode: "dca"`. */
  readonly dcaToken?: string;
  readonly dcaStepBps?: number;
  readonly dcaStepMultiplierBps?: number;
  readonly dcaTakeProfitBps?: number;
  readonly dcaOrderWei?: string;
  readonly dcaMaxOrders?: number;
  readonly dcaTriggerPriceE8?: string | null;
  readonly dcaRangeMinE8?: string | null;
  readonly dcaRangeMaxE8?: string | null;
  readonly dcaStopLossBps?: number | null;
};

/**
 * The only models the product offers, primary or fallback. Mirrors
 * `src/trade/llm.ts`; `web/lib/fixtures/trade-llm-models.json` pins them equal
 * on both sides. The old 0G product's other three names are HTTP 404 today.
 */
export const TRADE_LLM_MODELS = [
  { id: "qwen3.7-flash", label: "Auto: Qwen3.7 Flash" },
  { id: "0gm-1.0-35b-a3b", label: "OGM-1.0-35B-A3B" },
  { id: "qwen-flash", label: "Qwen Flash" },
  { id: "qwen3.5-flash", label: "Qwen3.5 Flash" },
  { id: "qwen3-vl-30b", label: "Qwen3 VL 30B" },
  { id: "glm-5.3-flash", label: "GLM-5.3 Flash" },
  { id: "qwen3.8-flash", label: "Qwen3.8 Flash" },
] as const;

export type TradeLlmModelId = (typeof TRADE_LLM_MODELS)[number]["id"];

export function tradeModelLabel(id: TradeLlmModelId): string {
  return TRADE_LLM_MODELS.find((model) => model.id === id)?.label ?? id;
}

export function tradeModelId(label: string): TradeLlmModelId {
  return TRADE_LLM_MODELS.find((model) => model.label === label)?.id ?? "qwen3.7-flash";
}

export const MAX_GRANTED_TOKENS = 25;
export const MAX_GRANTED_TOKENS_TRADFI = 28;
export function maxGrantedTokens(model: TradeExecutionModel): number {
  return model === "tradfi" ? MAX_GRANTED_TOKENS_TRADFI : MAX_GRANTED_TOKENS;
}

/** Stop loss is negative in the UI but remains a positive threshold magnitude on the wire. */
export function stopLossPercentFromBps(value: number): number {
  return -(value / 100);
}

export function stopLossBpsFromPercent(value: number): number {
  return Math.round(Math.abs(value) * 100);
}

export function stopLossBpsWhenEnabled(enabled: boolean, value: number): number | null {
  return enabled ? stopLossBpsFromPercent(value) : null;
}
export const MAX_INSTRUCTIONS_ENCODED_BYTES = 2_048;
export const MAX_SKILL_MARKDOWN_ENCODED_BYTES = 6_144;
export const MIN_TRADE_ENTRY_WEI = 2_000_000_000_000_000n;
export const MIN_TRADE_CAPITAL_WEI = 10_000_000_000_000_000n;
export const DEFAULT_TRADFI_V2_MIN_ENTRY_WEI = 5_000_000_000_000_000_000n;
export const DEFAULT_TRADFI_V2_MAX_ENTRY_WEI = 20_000_000_000_000_000_000n;
export const DEFAULT_CMC_TOTAL_BUDGET_WEI = 2_000_000_000_000_000_000n;
export const MAX_PLATFORM_FEE_BPS = 500;
export const RELAY_FEE_PER_EXIT_WEI = 100_000_000_000_000n;

/** C1 native reserve mirror: `(2*P + max(1,N) + 1) * relayFee`. */
export function tradfiV2NativeReserveWei(input: {
  readonly maxOpenPositions: number;
  readonly grantedTokenCount: number;
  readonly relayFeeWei?: bigint;
}): bigint {
  if (!Number.isInteger(input.maxOpenPositions) || input.maxOpenPositions < 1 || input.maxOpenPositions > 10) {
    throw new Error("maxOpenPositions must be an integer from 1 through 10.");
  }
  if (!Number.isInteger(input.grantedTokenCount) || input.grantedTokenCount < 0) {
    throw new Error("grantedTokenCount must be a non-negative integer.");
  }
  const relayFee = input.relayFeeWei ?? RELAY_FEE_PER_EXIT_WEI;
  if (relayFee < 0n) throw new Error("relayFeeWei must be non-negative.");
  return (2n * BigInt(input.maxOpenPositions) + BigInt(Math.max(1, input.grantedTokenCount)) + 1n) * relayFee;
}

export function tradfiScheduleNativeReserveWei(input: { readonly plannedBuys: number; readonly buysThisSession: number; readonly relayFeeWei?: bigint }): bigint {
  if (!Number.isSafeInteger(input.plannedBuys) || input.plannedBuys < 0 || !Number.isSafeInteger(input.buysThisSession) || input.buysThisSession < 0) {
    throw new Error("Schedule buy counts must be non-negative safe integers.");
  }
  const relayFeeWei = input.relayFeeWei ?? RELAY_FEE_PER_EXIT_WEI;
  if (relayFeeWei < 0n) throw new Error("relayFeeWei must be non-negative.");
  // Mirrors the plane: one submission per in-session buy, plus the submit-time
  // exit reserve (a schedule agent's reserve is ONE token — TRADFI-SCHEDULE-
  // NATIVE-CAP-PLAN A1 — since it never sells through the plane), plus the
  // floor's own fee.
  return (BigInt(Math.min(input.plannedBuys, input.buysThisSession)) + 2n) * relayFeeWei;
}

/** Mirror of `src/trade/sizing.ts` R_DCA: the per-submission native pad (AUTO-DCA R2.9, REVIEW2 condition 7). */
export const R_DCA = 320_000_000_000_000n;

/**
 * Mirror of `src/trade/sizing.ts::dcaNativeReserveWei`: the signed native day cap
 * an Auto DCA hire needs, `(2N + 4) × R_DCA`. A convenience — the provision
 * route's check is the authority (R2.9).
 */
export function dcaNativeReserveWei(maxOrders: number): bigint {
  if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > 8) throw new Error("dcaMaxOrders must be an integer in 1..8.");
  return (2n * BigInt(maxOrders) + 4n) * R_DCA;
}

export function tradfiPortfolioNativeReserveWei(input: { readonly tokenCount: number; readonly intervalSec: 14400 | 28800 | 43200 | 86400; readonly relayFeeWei?: bigint }): bigint {
  return BigInt((Math.ceil(86_400 / input.intervalSec) + 1) * input.tokenCount + input.tokenCount + 2) * (input.relayFeeWei ?? RELAY_FEE_PER_EXIT_WEI);
}

export const PORTFOLIO_ERROR_COPY: Readonly<Record<string, string>> = {
  portfolio_disabled: "Smart Portfolio is not enabled on this execution plane.",
  portfolio_token_unsupported: "This stock is not in the Smart Portfolio list.",
  portfolio_token_unquotable: "One stock has no direct buy quote. Try again later.",
  portfolio_no_sell: "Smart Portfolio stocks stay in your wallet. Pause or Remove, then withdraw them with your passkey.",
};

/** Mirror of `src/trade/dca.ts::dcaMaxStepBps` (D1): the deepest order stays within 90 % of the base price, and R4 caps the step at 30 %. */
export function dcaMaxStepBps(maxOrders: number): number {
  const n = BigInt(maxOrders);
  return Math.min(3_000, Number((9_000n * 5n ** n) / (5n * (6n ** n - 5n ** n))));
}

/** Owner copy for every Auto DCA error code (AUTO-DCA-SPEC §13.4). */
export const DCA_ERROR_COPY: Readonly<Record<string, string>> = {
  dca_disabled: "Auto DCA is not enabled on this execution plane.",
  dca_token_unsupported: "This stock is not one of the Auto DCA stocks.",
  dca_pool_mismatch: "The stock's pool no longer matches the pinned pool. Nothing was granted; try again later.",
  dca_uneconomic: "At today's gas this agent would wait before starting a round.",
  dca_no_manual_sell: "Auto DCA orders are not sold one by one. Use Remove to pull every order back to the wallet.",
  dca_round_changed: "The round changed while a batch was being prepared. It will be retried on the next cycle.",
};

/**
 * R2.11 + REVIEW2 condition 9: the "Pull resting orders" door shows only while
 * the agent is paused or the plane is unreachable (never racing an armed
 * agent's batches), and never while Remove runs — the plane's own sweep holds
 * the same positions.
 */
export function dcaPullDoor(input: { readonly status: string | null; readonly draining: boolean; readonly planeUnreachable: boolean }): "show" | "removing" | "pause-first" {
  if (input.draining) return "removing";
  if (input.status === "paused" || input.planeUnreachable) return "show";
  return "pause-first";
}

/**
 * DCA-DETAIL §5's display rule: a `level` in `pending`/`skipped`/`below-range`
 * with no `edgePriceE8` (never minted) shows its planned `levelPriceE8`; every
 * other order (including every `tp`) shows `edgePriceE8`. `null` when neither
 * is known yet.
 */
export function dcaOrderPriceE8(order: { readonly edgePriceE8?: string | null; readonly levelPriceE8?: string | null; readonly state: string }, role: "level" | "tp"): string | null {
  const edge = order.edgePriceE8 ?? null;
  if (edge === null && role === "level" && (order.state === "pending" || order.state === "skipped" || order.state === "below-range")) {
    return order.levelPriceE8 ?? null;
  }
  return edge;
}

export function txUrl(hash: string | null): string | null {
  return hash === null ? null : `https://bscscan.com/tx/${hash}`;
}

export function scheduleBuysThisSession(ttlSec: number, intervalSec: 3600 | 14400 | 28800 | 43200 | 86400): number {
  const availableMs = ttlSec * 1_000 - 7_200_000 - 1;
  return availableMs < 0 ? 0 : Math.floor(availableMs / (intervalSec * 1_000)) + 1;
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
  /** The DAY native cap an interval edit needs. */
  readonly dayCapWei: bigint;
  /** Buys the remaining session time admits, bounded by what is left to run. */
  readonly sessionBuys: number;
  /** The wallet BNB balance an interval edit needs to clear the rest of the session. */
  readonly balanceWei: bigint;
};

/**
 * What an interval edit needs to raise, if anything: the on-chain DAY cap and
 * the wallet's native balance (TRADFI-SCHEDULE-NATIVE-CAP-PLAN B1 — mirrors
 * `src/trade/sizing.ts`). `+2` on each count mirrors
 * {@link tradfiScheduleNativeReserveWei}: the floor's own fee plus the
 * one-token exit reserve every buy leaves behind.
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

export type TradeModelPreset = {
  readonly perTradeWei: string;
  readonly maxPositions: number;
  readonly capitalWei: string;
  readonly minConfidence: number;
};

/** R2/R4 literal copy. A fixture test pins these values to the plane table. */
export const TRADE_MODEL_PRESETS: Readonly<Record<TradeExecutionModel, TradeModelPreset>> = {
  tradfi: { perTradeWei: "20000000000000000", maxPositions: 3, capitalWei: "10000000000000000", minConfidence: 80 },
  "blue-chip": { perTradeWei: "2000000000000000", maxPositions: 3, capitalWei: "10000000000000000", minConfidence: 80 },
  "mid-cap": { perTradeWei: "2000000000000000", maxPositions: 3, capitalWei: "10000000000000000", minConfidence: 80 },
  degen: { perTradeWei: "2000000000000000", maxPositions: 3, capitalWei: "10000000000000000", minConfidence: 75 },
  sigma: { perTradeWei: "2000000000000000", maxPositions: 3, capitalWei: "10000000000000000", minConfidence: 72 },
};

export function encodedJsonStringBytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export type BoundedTextResult =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly bytes: number; readonly message: string };

export function checkBoundedText(value: string, maxBytes: number, label: string): BoundedTextResult {
  const bytes = encodedJsonStringBytes(value);
  return bytes <= maxBytes
    ? { ok: true, text: value, bytes }
    : { ok: false, bytes, message: `${label} must encode to at most ${maxBytes} bytes; received ${bytes}.` };
}

export function validateSkillMarkdown(name: string, text: string): BoundedTextResult {
  if (!name.toLowerCase().endsWith(".md")) {
    return { ok: false, bytes: encodedJsonStringBytes(text), message: "Skill upload accepts .md files only." };
  }
  return checkBoundedText(text, MAX_SKILL_MARKDOWN_ENCODED_BYTES, "Skill markdown");
}

export type TradeSizingResult = {
  readonly ok: boolean;
  readonly requiredWei: bigint;
  readonly shortfallWei: bigint;
  readonly minimumCapWei: bigint;
  readonly platformFeePerEntryWei: bigint;
  readonly platformFeeTotalWei: bigint;
};

/** Exact client-side copy of src/trade/sizing.ts::checkTradeSizing. */
export function checkTradeSizing(input: {
  readonly capDayWei: bigint;
  readonly entryWei: bigint;
  readonly maxOpenPositions: number;
  readonly grantedTokenCount: number;
  readonly platformFeeBps: number;
}): TradeSizingResult {
  const countIsValid = Number.isInteger(input.maxOpenPositions)
    && input.maxOpenPositions >= 1 && input.maxOpenPositions <= 10;
  const positions = Number.isInteger(input.maxOpenPositions) ? BigInt(input.maxOpenPositions) : 0n;
  const feeIsValid = Number.isInteger(input.platformFeeBps)
    && input.platformFeeBps >= 0 && input.platformFeeBps <= MAX_PLATFORM_FEE_BPS;
  const reserveWei = BigInt(Math.max(1, input.grantedTokenCount)) * RELAY_FEE_PER_EXIT_WEI;
  const platformFeePerEntryWei = feeIsValid
    ? (input.entryWei * BigInt(input.platformFeeBps)) / 10_000n : 0n;
  const platformFeeTotalWei = positions * platformFeePerEntryWei;
  const requiredWei = positions * input.entryWei
    + platformFeeTotalWei
    + positions * RELAY_FEE_PER_EXIT_WEI
    + RELAY_FEE_PER_EXIT_WEI
    + reserveWei;
  const minimumCapWei = requiredWei > MIN_TRADE_CAPITAL_WEI ? requiredWei : MIN_TRADE_CAPITAL_WEI;
  const ok = countIsValid && feeIsValid && input.capDayWei >= minimumCapWei
    && input.entryWei >= MIN_TRADE_ENTRY_WEI;
  return {
    ok,
    requiredWei,
    shortfallWei: input.capDayWei >= minimumCapWei ? 0n : minimumCapWei - input.capDayWei,
    minimumCapWei,
    platformFeePerEntryWei,
    platformFeeTotalWei,
  };
}

export function checkTradfiV2Sizing(input: {
  readonly capDayWei: bigint;
  readonly minEntryWei: bigint;
  readonly maxEntryWei: bigint;
  readonly capitalQuoteWei: bigint;
  readonly maxOpenPositions: number;
  readonly grantedTokenCount: number;
  readonly platformFeeBps: number;
}): { readonly ok: boolean; readonly requiredQuoteWei: bigint; readonly shortfallQuoteWei: bigint } {
  const positions = Number.isInteger(input.maxOpenPositions) && input.maxOpenPositions >= 1 && input.maxOpenPositions <= 10
    ? BigInt(input.maxOpenPositions) : 1n;
  const valid = Number.isInteger(input.maxOpenPositions) && input.maxOpenPositions >= 1 && input.maxOpenPositions <= 10
    && input.minEntryWei > 0n && input.maxEntryWei >= input.minEntryWei && input.capitalQuoteWei >= 0n
    && Number.isInteger(input.platformFeeBps) && input.platformFeeBps >= 0 && input.platformFeeBps <= MAX_PLATFORM_FEE_BPS;
  const fee = valid ? input.maxEntryWei * BigInt(input.platformFeeBps) / 10_000n : 0n;
  const requiredQuoteWei = positions * (input.maxEntryWei + fee);
  const shortfallQuoteWei = input.capitalQuoteWei >= requiredQuoteWei ? 0n : requiredQuoteWei - input.capitalQuoteWei;
  return { ok: valid && shortfallQuoteWei === 0n, requiredQuoteWei, shortfallQuoteWei };
}

export function parseBnbToWei(value: string): bigint {
  const normalized = value.replace(/,/gu, "").trim();
  if (!/^\d+(?:\.\d{0,18})?$/u.test(normalized)) return 0n;
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}

export function formatMinimumBnb(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString(10).padStart(18, "0").replace(/0+$/u, "");
  return fraction === "" ? whole.toString(10) : `${whole}.${fraction}`;
}

export type TradePositionView = {
  readonly positionId: string;
  readonly token: string;
  readonly route: { readonly hops: readonly string[]; readonly fees: readonly number[] };
  readonly entryWei: string;
  readonly tokenAmount: string | null;
  readonly fillStatus: "verified" | "unverified";
  readonly openedAt: number;
  readonly entryTxHash: string | null;
  readonly status: string;
  readonly pnlBps: string | null;
  readonly exitRequestedAt: number | null;
  readonly orphanedAt: number | null;
  readonly closedAt: number | null;
  readonly exitWei: string | null;
  readonly exitTxHash: string | null;
  readonly soldTokenAmount: string | null;
  readonly exitFillStatus: "verified" | "unverified" | null;
  readonly closeReason: "owner-request" | "stop-loss" | "take-profit" | "max-hold" | "llm" | "balance-gone" | "crash-stop" | "session-expiring" | "trailing-stop" | "stale-exit" | null;
  readonly closeNote?: string | null;
  readonly autoExitReason?: "crash-stop" | "session-expiring" | null;
  readonly peakPnlBps?: string | null;
  readonly refusalText: string | null;
  readonly orphanedText?: string;
  readonly orphanedResidual?: string;
  readonly observation: {
    readonly positionId: string;
    readonly symbol: string | null;
    readonly decimals: number | null;
    readonly recordedPositionAmount: string | null;
    readonly liveWalletBalance: string | null;
    readonly currentQuoteWei: string | null;
    readonly pnlBps: string | null;
    readonly quoteStatus: "quoted" | "unattributed" | "balance-gone" | "unavailable" | "closed";
    readonly reason: string | null;
    readonly observedAt: number;
  } | null;
  readonly settlementAsset?: "USDT" | null;
  readonly requestedEntryAtomic?: string | null;
  readonly verifiedEntryAtomic?: string | null;
  /** Schedule agents only; absent until the plane running this view has restarted with the R14.x read. */
  readonly scheduleSlot?: number | null;
};

export type TradeView = {
  readonly settings: TradeSettings | null;
  readonly portfolio?: {
    readonly tokens: readonly { readonly token: string; readonly symbol: string; readonly targetBps: number; readonly balanceAtomic: string;
      readonly valueWei: string | null; readonly valueReason: "quote-unavailable" | null; readonly weightBps: number | null; readonly driftBps: number | null;
      readonly displayName?: string | null; readonly initial?: { readonly quantityAtomic: string | null; readonly quantityReason: "no-buy" | "not-recorded" | "not-verified" | "unavailable" | null;
        readonly quoteWei: string | null; readonly quoteReason: "no-buy" | "not-recorded" | "not-verified" | "unavailable" | null } }[];
    readonly capitalQuoteWei: string; readonly netInvestedWei: string; readonly cashCapWei: string; readonly walletUsdtWei: string;
    readonly portfolioCashWei: string; readonly idleUsdtWei: string; readonly stockValueWei: string | null; readonly totalValueWei: string | null;
    readonly pnlWei: string | null; readonly driftBps: number | null; readonly intervalSec: number; readonly anchorMs: number;
    readonly currentSlot: number | null; readonly nextCheckAtMs: number;
    readonly check: { readonly slot: number; readonly state: "held" | "rebalancing" | "done"; readonly maxDriftBps: number; readonly valueWei: string; readonly checkedAt: number } | null;
    readonly legs: readonly { readonly slot: number; readonly side: "buy" | "sell"; readonly token: string; readonly symbol: string;
      readonly amountWei: string; readonly quotedOutAtomic: string | null; readonly minOutAtomic: string | null; readonly proceedsAtomic: string | null;
      readonly state: "pending" | "projected" | "rolled-back"; readonly txHash: string | null; readonly createdAt: number;
      readonly detail?: { readonly id: string; readonly executionState: "PENDING" | "IN_PROGRESS" | "COMMITTED" | "ROLLED_BACK" | "UNKNOWN" | null;
        readonly executionReason: "not-recorded" | "unavailable" | null; readonly quantityAtomic: string | null;
        readonly quantityReason: "no-buy" | "not-recorded" | "not-verified" | "unavailable" | null;
        readonly quoteWei: string | null; readonly quoteReason: "no-buy" | "not-recorded" | "not-verified" | "unavailable" | null } }[];
  };
  readonly schedule?: {
    readonly token: string; readonly symbol: string; readonly decimals: number | null; readonly amountWei: string; readonly intervalSec: number;
    readonly anchorMs: number; readonly nextDueAtMs: number; readonly currentSlot: number | null; readonly currentSlotTaken: boolean;
    readonly fills: number; readonly postponed: number; readonly plannedBuys: number; readonly buysThisSession: number; readonly spentWei: string; readonly remainingWei: string;
    readonly finished: "budget" | "runs" | "date" | null; readonly endKind: "budget" | "date" | "runs"; readonly endAtSec: number | null; readonly endRuns: number | null;
    readonly marketHoursOnly: boolean; readonly maxPremiumBps: number; readonly firstAtSec: number | null;
    /** Optional on the wire: absent until the plane running this view has restarted with the R14.x premium read. */
    readonly premiumBps?: number | null;
    readonly premiumLimitBps?: number;
    /**
     * TRADFI-SCHEDULE-NATIVE-CAP-PLAN B2 — read-only, the plane never throws
     * building them. Optional on the wire (absent until the plane running this
     * view has restarted with the B2 read); `null` means the meter/balance/session
     * fact could not be read, never a healthy zero.
     */
    readonly nativeCapWei?: string | null;
    readonly nativeSpentWei?: string | null;
    readonly nativeBalanceWei?: string | null;
    readonly nativeBuysRefused?: boolean | null;
    readonly sessionExpiresAtSec?: number | null;
    readonly holding: { readonly walletBalance: string; readonly boughtAtomic: string; readonly verifiedSpentWei: string; readonly verifiedFills: number; readonly quoteWei: string | null; readonly quoteReason: string | null };
  };
  /** AUTO-DCA §13.3 + R2.16. A figure the plane could not read is `null`, and `reason` names why. */
  readonly dca?: TradeDcaView;
  readonly open: readonly TradePositionView[];
  readonly closed: readonly TradePositionView[];
  readonly runs: readonly {
    readonly events?: readonly { readonly stage: string; readonly code: string; readonly elapsedMs: number; readonly token?: string; readonly model?: string; readonly reason?: string; readonly confidence?: number }[];
    readonly id: string;
    readonly dryRun: boolean;
    readonly reason: string;
    readonly candidates: number;
    readonly refusals: number;
    readonly entries: number;
    readonly exits: number;
    readonly createdAt: number;
  }[];
  /** `symbol` is the lane ticker when the plane knows it (2026-09-22); display only. */
  readonly pinned: readonly { readonly address: string; readonly marketHours: "us-equities" | null; readonly symbol?: string | null }[];
  readonly marketHours: { readonly usEquitiesOpen: boolean; readonly holidaysModeled: false };
  readonly summary: {
    readonly grossDeltaWei: string | null;
    readonly grossComplete: boolean;
    readonly grossReason: string | null;
    readonly wins: number | null;
    readonly winRateBps: number | null;
    readonly closedTrades: number;
    readonly openPositions: number;
    readonly maxOpenPositions: number | null;
    readonly observedAt: number | null;
  };
  readonly lifecycle: { readonly draining: boolean; readonly drainingAt: number | null };
  /**
   * TRADFI-EXPIRY-KEEP-REMOVE: the plane's own TradFi AI discriminator (the web
   * never imports the plane). Read only as the literal `true`; absent keeps the
   * existing behaviour, as does an older plane that omits it.
   */
  readonly tradfiAi?: boolean;
  /** Recorded rows kept in the wallet after a removal (not a live balance); 0 otherwise. */
  readonly keptPositions?: number;
  readonly pendingIntents: readonly {
    readonly decisionId: string;
    readonly side: "buy" | "sell";
    readonly token: string;
    readonly state: "pending";
    readonly txHash: string | null;
    readonly createdAt: number;
  }[];
  readonly cmcBudget?: TradeCmcBudget;
  /** Owner-readable CMC log (2026-09-20): cached contexts and paid attempts, newest first. */
  readonly cmcLog?: {
    readonly news: readonly {
      readonly ticker: string; readonly skill: string; readonly status: string; readonly asOfMs: number; readonly expiresAtMs: number;
      readonly sourceUrl: string | null; readonly paymentOperationId: string | null; readonly context: string | null;
      /** TRADFI-LLM-CMC-REQUEST §7: present when this row was produced by an LLM-requested paid call. */
      readonly requestedBy?: "llm" | null; readonly requestReason?: string | null;
    }[];
    readonly attempts: readonly {
      readonly operationId: string; readonly attemptId: string; readonly state: string; readonly contentState: string;
      readonly amountWei: string; readonly txHash: string | null; readonly settlementTxHint: string | null;
      readonly createdAt: number; readonly updatedAt: number;
    }[];
  };
};

export type TradeDcaOrderView = {
  readonly tokenId: string | null;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly closedBy: "plane" | "owner" | "elsewhere" | "binance" | "external" | null;
  readonly usdtWei: string;
  readonly stockWei: string;
  readonly txHash: string | null;
  /** DCA-DETAIL §3/§5: the tick-edge price by role, orientation-proof; `null` for an order never minted. Optional: absent on an older plane. */
  readonly edgePriceE8?: string | null;
  /** DCA-DETAIL §3: the exit action's tx hash, `null` before an exit. Optional: absent on an older plane. */
  readonly exitTxHash?: string | null;
};

/** DCA-DETAIL §3.1: one action row with a tx, for the DCA Run log's Trades cards. */
export type TradeDcaActionView = {
  readonly kind: "start" | "close-start" | "close" | "level-place" | "fill" | "stop-loss" | "remove" | "tp-place";
  readonly roundNo: number;
  readonly state: "intended" | "submitted" | "committed" | "rolled-back" | "unknown" | "finished";
  readonly txHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** DCA-DETAIL §3.1: one settled fill (base / level / take-profit / remove-sale), for Order history and the chart's markers. */
export type TradeDcaFillView = {
  /** `null` for a base fill whose committed action was rolled back after `p0` was written (LOW 7). */
  readonly atMs: number | null;
  readonly roundNo: number;
  readonly kind: "base" | "level" | "take-profit" | "remove-sale";
  readonly levelNo: number | null;
  readonly side: "buy" | "sell";
  readonly usdtWei: string;
  readonly stockWei: string;
  readonly txHash: string | null;
};

export type TradeDcaView = {
  readonly token: string;
  readonly symbol: string;
  readonly fee: number;
  readonly usdtIsToken0: boolean;
  /** DCA-DETAIL §3: the plane's own finalized pool reading, set whenever it succeeds (not only for an active round). Optional: absent on an older plane. */
  readonly mark?: null | { readonly e8: string; readonly block: string };
  readonly settings: {
    readonly stepBps: number; readonly takeProfitBps: number; readonly baseWei: string; readonly orderWei: string; readonly maxOrders: number;
    readonly triggerE8: string | null; readonly rangeMinE8: string | null; readonly rangeMaxE8: string | null; readonly stopLossBps: number | null;
  };
  readonly round: null | {
    readonly roundNo: number;
    readonly phase: "starting" | "active" | "closing" | "settled" | "stopped" | "stopping" | "winding-down" | "ended" | "interrupted";
    readonly closeCause: string | null;
    readonly openedAt: number;
    readonly unreliable: boolean;
    readonly p0E8: string | null;
    readonly avgCostE8: string | null;
    readonly tpTargetE8: string | null;
    readonly costUsdtWei: string;
    readonly stockHeldWei: string;
    readonly realizedPnlWei: string | null;
    readonly levels: readonly (TradeDcaOrderView & {
      readonly levelNo: number;
      readonly levelPriceE8: string | null;
      readonly state: "pending" | "resting" | "filled" | "collected" | "skipped" | "below-range" | "cancelled" | "held";
    })[];
    readonly tp: null | (TradeDcaOrderView & { readonly state: string; readonly rangeLowE8: string; readonly rangeHighE8: string });
    /** DCA-DETAIL §3: the round's base fill (price = round's p0). `null` before p0 is known, or on an older plane. */
    readonly base?: null | { readonly usdtWei: string; readonly stockWei: string; readonly txHash: string | null; readonly atMs: number | null };
  };
  readonly rounds: {
    readonly settled: number; readonly realizedPnlWei: string; readonly lastSettledAt: number | null;
    /** AUTO-DCA R4.6: marked-or-realized sum over settled rounds. Optional: absent on an older plane. */
    readonly markedPnlWei?: string;
    /** DCA-DETAIL §3: settled rounds, newest first, at most 12. Optional: absent on an older plane. */
    readonly history?: readonly {
      readonly roundNo: number; readonly closeCause: string | null; readonly openedAt: number; readonly settledAt: number | null;
      readonly filledLevels: number; readonly realizedPnlWei: string | null; readonly unreliable: boolean;
      /** AUTO-DCA R4.6: the removed round's unsold stock and marked PnL. Optional: absent on an older plane. */
      readonly unsoldStockWei?: string | null; readonly markedPnlWei?: string | null;
    }[];
  };
  readonly equity: null | { readonly equityWei: string; readonly baselineWei: string; readonly stopAtWei: string | null; readonly markE8: string; readonly readingBlock: string };
  readonly wallet: null | { readonly usdtWei: string; readonly stockWei: string };
  readonly reason: string | null;
  readonly inFlight: null | { readonly kind: string; readonly state: string; readonly txHash: string | null };
  readonly unknownAction: null | { readonly kind: string; readonly actionKey: string; readonly note: string | null };
  /** DCA-DETAIL §3.1: settled fills across the open round and its history, newest first, at most 60. Optional: absent on an older plane. */
  readonly history?: { readonly fills: readonly TradeDcaFillView[] };
  /** DCA-DETAIL §3.1: actions with a tx, newest first, at most 50. Optional: absent on an older plane. */
  readonly actions?: readonly TradeDcaActionView[];
  /** AGENTIC-DCA (public page only): orders held for review and the shared keep-alive clock. Absent on the Altana view. */
  readonly heldOrders?: number;
  readonly keepAlive?: { readonly lastActivityAtMs: number | null; readonly dueAtMs: number | null; readonly lastPaidAtMs: number | null };
};

export type TradeCmcBudget = {
    readonly asset: "USDT";
    readonly decimals: 18;
    readonly generation: number;
    readonly authorizedTotalWei: string;
    readonly settledWei: string;
    readonly reservedWei: string;
    readonly remainingWei: string;
    readonly status: "disabled" | "setup-required" | "pending" | "ready" | "exhausted" | "unavailable";
    readonly reason: string | null;
    readonly pendingOperationId: string | null;
    /** CMC-HIRE-SETUP R6.1: the leftover allowance adopted at initial setup, absent on an older plane. */
    readonly adoptedWei?: string;
};

const CMC_BUDGET_STATUSES = new Set<TradeCmcBudget["status"]>(["disabled", "setup-required", "pending", "ready", "exhausted", "unavailable"]);

function isCmcBudget(value: unknown): value is TradeCmcBudget {
  if (!isRecord(value) || value.asset !== "USDT" || value.decimals !== 18 || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !isDecimalWei(value.authorizedTotalWei) || !isDecimalWei(value.settledWei) || !isDecimalWei(value.reservedWei) || !isDecimalWei(value.remainingWei)
    || typeof value.status !== "string" || !CMC_BUDGET_STATUSES.has(value.status as TradeCmcBudget["status"])
    || (value.reason !== null && typeof value.reason !== "string")
    || (value.pendingOperationId !== null && typeof value.pendingOperationId !== "string")
    || (value.adoptedWei !== undefined && !isDecimalWei(value.adoptedWei))) return false;
  try {
    const authorized = BigInt(value.authorizedTotalWei);
    const settled = BigInt(value.settledWei);
    const reserved = BigInt(value.reservedWei);
    const remaining = BigInt(value.remainingWei);
    return settled + reserved <= authorized && remaining === authorized - settled - reserved;
  } catch { return false; }
}

/** The Smart Portfolio block's shape check: the owner view parser and the public Agentic page share it (AGENTIC-PORTFOLIO-SPEC 4.6). */
export function isTradePortfolioBlock(p: unknown): boolean {
  const integer = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
  const nullableDecimal = (value: unknown): boolean => value === null || isDecimalWei(value);
  const signedDecimal = (value: unknown): boolean => typeof value === "string" && /^-?\d+$/u.test(value);
  const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value);
  const hash = (value: unknown): boolean => value === null || typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
  const reasons = ["no-buy", "not-recorded", "not-verified", "unavailable"];
  const evidence = (amount: unknown, reason: unknown): boolean => nullableDecimal(amount)
    && (reason === null || typeof reason === "string" && reasons.includes(reason))
    && (amount === null ? reason !== null : reason === null);
  return isRecord(p) && Array.isArray(p.tokens) && p.tokens.length >= 2 && p.tokens.length <= 5
    && Array.isArray(p.legs) && p.legs.length <= 50
    && [p.capitalQuoteWei, p.cashCapWei, p.walletUsdtWei, p.portfolioCashWei, p.idleUsdtWei].every(isDecimalWei)
    && [p.stockValueWei, p.totalValueWei, p.pnlWei].every((value, index) => index === 2 ? value === null || signedDecimal(value) : nullableDecimal(value))
    && signedDecimal(p.netInvestedWei) && (p.driftBps === null || integer(p.driftBps))
    && [14400, 28800, 43200, 86400].includes(p.intervalSec as number)
    && integer(p.anchorMs) && (p.currentSlot === null || integer(p.currentSlot)) && integer(p.nextCheckAtMs)
    && (p.check === null || isRecord(p.check) && integer(p.check.slot) && ["held", "rebalancing", "done"].includes(p.check.state as string)
      && integer(p.check.maxDriftBps) && isDecimalWei(p.check.valueWei) && integer(p.check.checkedAt))
    && p.tokens.every((token: unknown) => isRecord(token) && address(token.token) && typeof token.symbol === "string" && token.symbol.length > 0
      && integer(token.targetBps, 1000) && isDecimalWei(token.balanceAtomic) && nullableDecimal(token.valueWei)
      && (token.valueWei === null ? token.valueReason === "quote-unavailable" : token.valueReason === null)
      && (token.weightBps === null || integer(token.weightBps)) && (token.driftBps === null || integer(token.driftBps))
      && (token.displayName === undefined || token.displayName === null || typeof token.displayName === "string")
      && (token.initial === undefined || isRecord(token.initial) && evidence(token.initial.quantityAtomic, token.initial.quantityReason)
        && evidence(token.initial.quoteWei, token.initial.quoteReason)))
    && new Set((p.tokens as readonly { readonly token: string }[]).map((token) => token.token.toLowerCase())).size === p.tokens.length
    && (p.tokens as readonly { readonly targetBps: number }[]).reduce((sum, token) => sum + token.targetBps, 0) === 10000
    && p.legs.every((leg: unknown) => isRecord(leg) && integer(leg.slot) && ["buy", "sell"].includes(leg.side as string)
      && address(leg.token) && typeof leg.symbol === "string" && leg.symbol.length > 0 && isDecimalWei(leg.amountWei)
      && nullableDecimal(leg.quotedOutAtomic) && nullableDecimal(leg.minOutAtomic) && nullableDecimal(leg.proceedsAtomic)
      && ["pending", "projected", "rolled-back"].includes(leg.state as string) && hash(leg.txHash) && integer(leg.createdAt)
      && (leg.detail === undefined || isRecord(leg.detail) && typeof leg.detail.id === "string" && leg.detail.id.length > 0
        && (leg.detail.executionState === null || ["PENDING", "IN_PROGRESS", "COMMITTED", "ROLLED_BACK", "UNKNOWN"].includes(leg.detail.executionState as string))
        && (leg.detail.executionReason === null || ["not-recorded", "unavailable"].includes(leg.detail.executionReason as string))
        && (leg.detail.executionState === null ? leg.detail.executionReason !== null : leg.detail.executionReason === null)
        && evidence(leg.detail.quantityAtomic, leg.detail.quantityReason) && evidence(leg.detail.quoteWei, leg.detail.quoteReason)));
}

export function parseTradeViewEnvelope(payload: unknown): TradeView {
  if (typeof payload !== "object" || payload === null) throw new Error("Trade view returned an unexpected response.");
  const data = (payload as { readonly data?: unknown }).data;
  if (typeof data !== "object" || data === null) throw new Error("Trade view returned an unexpected response.");
  const view = data as Partial<TradeView>;
  if (!Array.isArray(view.open) || !Array.isArray(view.closed) || !Array.isArray(view.runs)
    || !Array.isArray(view.pinned) || typeof view.marketHours !== "object" || view.marketHours === null
    || typeof view.summary !== "object" || view.summary === null
    || typeof view.lifecycle !== "object" || view.lifecycle === null || !Array.isArray(view.pendingIntents)) {
    throw new Error("Trade view returned an unexpected response.");
  }
  if (view.tradfiAi !== undefined && typeof view.tradfiAi !== "boolean") throw new Error("Trade view returned an invalid TradFi AI flag.");
  if (view.keptPositions !== undefined && !(typeof view.keptPositions === "number" && Number.isSafeInteger(view.keptPositions) && view.keptPositions >= 0)) {
    throw new Error("Trade view returned an invalid kept-positions count.");
  }
  if (view.cmcBudget !== undefined && !isCmcBudget(view.cmcBudget)) throw new Error("Trade view returned an invalid CMC budget.");
  if (view.portfolio !== undefined && !isTradePortfolioBlock(view.portfolio)) throw new Error("Trade view returned an invalid portfolio block.");
  if (view.schedule !== undefined) {
    const scheduleRow = view.schedule as unknown as Record<string, unknown>;
    const premiumBps = scheduleRow.premiumBps;
    if (premiumBps !== undefined && premiumBps !== null && !(typeof premiumBps === "number" && Number.isFinite(premiumBps))) {
      throw new Error("Trade view returned an invalid schedule premium.");
    }
    const premiumLimitBps = scheduleRow.premiumLimitBps;
    if (premiumLimitBps !== undefined && !(typeof premiumLimitBps === "number" && Number.isFinite(premiumLimitBps))) {
      throw new Error("Trade view returned an invalid schedule premium limit.");
    }
    // B2: each field is optional and independently nullable; a failed read on
    // the plane is `null`, never dropped or coerced into a healthy-looking zero.
    for (const field of ["nativeCapWei", "nativeSpentWei", "nativeBalanceWei"] as const) {
      const value = scheduleRow[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw new Error(`Trade view returned an invalid schedule ${field}.`);
      }
    }
    const nativeBuysRefused = scheduleRow.nativeBuysRefused;
    if (nativeBuysRefused !== undefined && nativeBuysRefused !== null && typeof nativeBuysRefused !== "boolean") {
      throw new Error("Trade view returned an invalid schedule nativeBuysRefused.");
    }
    const sessionExpiresAtSec = scheduleRow.sessionExpiresAtSec;
    if (sessionExpiresAtSec !== undefined && sessionExpiresAtSec !== null
      && !(typeof sessionExpiresAtSec === "number" && Number.isFinite(sessionExpiresAtSec))) {
      throw new Error("Trade view returned an invalid schedule sessionExpiresAtSec.");
    }
  }
  if (view.dca !== undefined && (!isRecord(view.dca) || typeof view.dca.symbol !== "string" || !isRecord(view.dca.rounds)
    || (view.dca.round !== null && (!isRecord(view.dca.round) || !Array.isArray(view.dca.round.levels)))
    // DCA-DETAIL §3.4: the NEW fields, optional (an older plane omits them entirely).
    || (view.dca.mark !== undefined && view.dca.mark !== null && !isRecord(view.dca.mark))
    || (view.dca.history !== undefined && (!isRecord(view.dca.history) || !Array.isArray(view.dca.history.fills)))
    || (view.dca.rounds.history !== undefined && !Array.isArray(view.dca.rounds.history))
    || (view.dca.actions !== undefined && !Array.isArray(view.dca.actions)))) {
    throw new Error("Trade view returned an invalid Auto DCA block.");
  }
  return view as TradeView;
}

export type TradeHirePreview = {
  readonly capDayWei: string;
  readonly sizing: {
    readonly name: "trade-v1";
    readonly version: 1;
    readonly openNativeBudgetWei: "0";
    readonly executionModel: TradeExecutionModel;
    readonly entryWei: string;
    readonly settlementAsset?: "USDT";
    readonly minEntryWei?: string;
    readonly capitalQuoteWei?: string;
    readonly cmcNewsEnabled?: boolean;
    readonly cmcTotalBudgetWei?: string;
    readonly nativeReserveWei?: string;
    readonly nativeShortfallWei?: string;
    readonly tradeMode?: "schedule" | "dca" | "portfolio";
    readonly tokenCount?: number;
    readonly intervalSec?: number;
    readonly plannedBuys?: number;
    readonly buysThisSession?: number;
    /** Auto DCA (§13.1, R2.16): the USDT deposit target (principal + the base order's fee) and the non-blocking economics. */
    readonly depositQuoteWei?: string;
    readonly usdtDayCapWei?: string;
    readonly roundsPerDayAtCap?: { readonly noFill: number; readonly full: number };
    readonly economics?: null | {
      readonly r0CostUsdtWei: string; readonly r0GrossUsdtWei: string; readonly holdEngagesAtGwei: number | null;
      readonly perFillNetUsdtWei: string; readonly gasPriceGwei: number;
    };
    readonly maxOpenPositions: number;
    readonly grantedTokenCount: number;
    readonly platformFeeBps: number;
    readonly platformFeePerEntryWei: string;
    readonly platformFeeTotalWei: string;
    readonly tradeRelayFeePerSubmitWei: string;
    readonly capitalRequiredWei: string;
    readonly capitalShortfallWei: string;
    readonly ok: boolean;
  };
  readonly funding: import("./altana/hire-state").HireFunding;
  readonly pin: readonly { readonly symbol: string; readonly address: string }[];
  readonly indicative: true;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDecimalWei(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/u.test(value);
}

function isTradeExecutionModel(value: unknown): value is TradeExecutionModel {
  return value === "tradfi" || value === "blue-chip" || value === "mid-cap" || value === "degen" || value === "sigma";
}

/** Runtime boundary for the Revision 5 hire-preview wire contract. */
export function parseTradeHirePreviewEnvelope(payload: unknown): TradeHirePreview {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new Error("Trade hire preview returned an incompatible response.");
  }
  const data = payload.data;
  const sizing = data.sizing;
  const funding = data.funding;
  const pin = data.pin;
  const v2 = isRecord(sizing) && (sizing.minEntryWei !== undefined || sizing.capitalQuoteWei !== undefined || sizing.cmcNewsEnabled !== undefined || sizing.cmcTotalBudgetWei !== undefined || sizing.settlementAsset !== undefined);
  if (!isDecimalWei(data.capDayWei) || data.indicative !== true
    || !isRecord(sizing) || sizing.name !== "trade-v1" || sizing.version !== 1
    || sizing.openNativeBudgetWei !== "0" || !isTradeExecutionModel(sizing.executionModel)
    || !isDecimalWei(sizing.entryWei) || !Number.isInteger(sizing.maxOpenPositions)
    || !Number.isInteger(sizing.grantedTokenCount) || !Number.isInteger(sizing.platformFeeBps)
    || !isDecimalWei(sizing.platformFeePerEntryWei) || !isDecimalWei(sizing.platformFeeTotalWei)
    || !isDecimalWei(sizing.tradeRelayFeePerSubmitWei) || !isDecimalWei(sizing.capitalRequiredWei)
    || !isDecimalWei(sizing.capitalShortfallWei) || typeof sizing.ok !== "boolean"
    || sizing.nativeReserveWei !== undefined && !isDecimalWei(sizing.nativeReserveWei)
    || sizing.nativeShortfallWei !== undefined && !isDecimalWei(sizing.nativeShortfallWei)
    || !isRecord(funding) || funding.version !== 1 || !Number.isInteger(funding.observedAtSec)
    || !isDecimalWei(funding.registrationFeeWei)
    || (funding.registrations !== 1 && funding.registrations !== 2)
    || !isDecimalWei(funding.relayGasHeadroomWei) || !isDecimalWei(funding.requiredWei)
    || !(funding.balanceWei === null || isDecimalWei(funding.balanceWei))
    || (funding.quoteAsset !== undefined || funding.quoteRequiredWei !== undefined || funding.quoteBalanceWei !== undefined || funding.quoteShortfallWei !== undefined)
      && (funding.quoteAsset !== "USDT" || !isDecimalWei(funding.quoteRequiredWei)
        || !(funding.quoteBalanceWei === null || isDecimalWei(funding.quoteBalanceWei)) || !isDecimalWei(funding.quoteShortfallWei))
    || !Array.isArray(pin)
    || !pin.every((token) => isRecord(token) && typeof token.symbol === "string" && typeof token.address === "string")
    || (v2 && (!isDecimalWei(sizing.minEntryWei) || !isDecimalWei(sizing.capitalQuoteWei) || typeof sizing.cmcNewsEnabled !== "boolean"
      || (sizing.cmcNewsEnabled === true ? !isDecimalWei(sizing.cmcTotalBudgetWei) : sizing.cmcTotalBudgetWei !== undefined)))) {
    throw new Error("Trade hire preview returned an incompatible response.");
  }
  if (sizing.tradeMode === "schedule" && (!Number.isInteger(sizing.plannedBuys) || !Number.isInteger(sizing.buysThisSession) || !isDecimalWei(sizing.nativeReserveWei))) {
    throw new Error("Trade hire preview returned an invalid schedule sizing.");
  }
  if (sizing.tradeMode === "dca" && (!isDecimalWei(sizing.nativeReserveWei) || !isDecimalWei(sizing.depositQuoteWei))) {
    throw new Error("Trade hire preview returned an invalid Auto DCA sizing.");
  }
  if (sizing.tradeMode === "portfolio" && (!isDecimalWei(sizing.nativeReserveWei) || !isDecimalWei(sizing.depositQuoteWei)
    || !Number.isInteger(sizing.tokenCount) || !Number.isInteger(sizing.intervalSec))) {
    throw new Error("Trade hire preview returned an invalid portfolio sizing.");
  }
  return data as unknown as TradeHirePreview;
}
