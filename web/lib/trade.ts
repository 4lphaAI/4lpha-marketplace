/** Hand-written browser copy of the trading wire and admission arithmetic. */
export type TradeExecutionModel = "blue-chip" | "mid-cap" | "degen" | "sigma";
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
};

/**
 * The only models the product offers, primary or fallback. Mirrors
 * `src/trade/llm.ts`; `web/lib/fixtures/trade-llm-models.json` pins them equal
 * on both sides. The old 0G product's other three names are HTTP 404 today.
 */
export const TRADE_LLM_MODELS = [
  { id: "0gm-1.0-35b-a3b", label: "Auto: OGM-1.0-35B-A3B" },
  { id: "qwen3-vl-30b", label: "Qwen3 VL 30B" },
  { id: "glm-5.3-flash", label: "GLM-5.3 Flash" },
  { id: "qwen3.8-flash", label: "Qwen3.8 Flash" },
] as const;

export type TradeLlmModelId = (typeof TRADE_LLM_MODELS)[number]["id"];

export function tradeModelLabel(id: TradeLlmModelId): string {
  return TRADE_LLM_MODELS.find((model) => model.id === id)?.label ?? id;
}

export function tradeModelId(label: string): TradeLlmModelId {
  return TRADE_LLM_MODELS.find((model) => model.label === label)?.id ?? "0gm-1.0-35b-a3b";
}

export const MAX_GRANTED_TOKENS = 25;
export function maxGrantedTokens(_model: TradeExecutionModel): number {
  return MAX_GRANTED_TOKENS;
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
export const MAX_PLATFORM_FEE_BPS = 500;
export const RELAY_FEE_PER_EXIT_WEI = 100_000_000_000_000n;

export type TradeModelPreset = {
  readonly perTradeWei: string;
  readonly maxPositions: number;
  readonly capitalWei: string;
  readonly minConfidence: number;
};

/** R2/R4 literal copy. A fixture test pins these values to the plane table. */
export const TRADE_MODEL_PRESETS: Readonly<Record<TradeExecutionModel, TradeModelPreset>> = {
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
  readonly closeReason: "owner-request" | "stop-loss" | "take-profit" | "max-hold" | "llm" | "balance-gone" | null;
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
};

export type TradeView = {
  readonly settings: TradeSettings | null;
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
  readonly pinned: readonly { readonly address: string; readonly marketHours: "us-equities" | null }[];
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
  readonly pendingIntents: readonly {
    readonly decisionId: string;
    readonly side: "buy" | "sell";
    readonly token: string;
    readonly state: "pending";
    readonly txHash: string | null;
    readonly createdAt: number;
  }[];
};

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
  return value === "blue-chip" || value === "mid-cap" || value === "degen" || value === "sigma";
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
  if (!isDecimalWei(data.capDayWei) || data.indicative !== true
    || !isRecord(sizing) || sizing.name !== "trade-v1" || sizing.version !== 1
    || sizing.openNativeBudgetWei !== "0" || !isTradeExecutionModel(sizing.executionModel)
    || !isDecimalWei(sizing.entryWei) || !Number.isInteger(sizing.maxOpenPositions)
    || !Number.isInteger(sizing.grantedTokenCount) || !Number.isInteger(sizing.platformFeeBps)
    || !isDecimalWei(sizing.platformFeePerEntryWei) || !isDecimalWei(sizing.platformFeeTotalWei)
    || !isDecimalWei(sizing.tradeRelayFeePerSubmitWei) || !isDecimalWei(sizing.capitalRequiredWei)
    || !isDecimalWei(sizing.capitalShortfallWei) || typeof sizing.ok !== "boolean"
    || !isRecord(funding) || funding.version !== 1 || !Number.isInteger(funding.observedAtSec)
    || !isDecimalWei(funding.registrationFeeWei)
    || (funding.registrations !== 1 && funding.registrations !== 2)
    || !isDecimalWei(funding.relayGasHeadroomWei) || !isDecimalWei(funding.requiredWei)
    || !(funding.balanceWei === null || isDecimalWei(funding.balanceWei))
    || !Array.isArray(pin)
    || !pin.every((token) => isRecord(token) && typeof token.symbol === "string" && typeof token.address === "string")) {
    throw new Error("Trade hire preview returned an incompatible response.");
  }
  return data as unknown as TradeHirePreview;
}
