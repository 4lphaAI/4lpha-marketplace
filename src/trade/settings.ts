/** Owner-signed trading settings codec (TRADING-AGENT R5 / R3.10). */
import type { Hex } from "viem";
import { paramsHash } from "../auth/canonical.js";
import { DCA_MIN_TP_BPS_FEE100, DCA_STEP_MULTIPLIER_BPS, dcaMaxStepBps, dcaPoolForToken, dcaStepWithinDepth } from "./dca.js";
import { isTradeLlmModelId, type TradeLlmModelId } from "./llm.js";
import { isCanonicalAtomic, isTradfiV2Settlement, MAX_UINT256 } from "./settlement.js";
import { portfolioMinCapitalWei } from "./sizing.js";
import { PORTFOLIO_INTERVALS_SEC, PORTFOLIO_LEGACY_MIN_LEG_WEI, PORTFOLIO_MAX_DRIFT_BPS, PORTFOLIO_MAX_TOKENS, PORTFOLIO_MIN_DRIFT_BPS, PORTFOLIO_MIN_LEG_WEI, PORTFOLIO_MIN_TOKENS, PORTFOLIO_MIN_WEIGHT_BPS, portfolioStockAllowed } from "./portfolio.js";

export type TradeExecutionModel = "tradfi" | "mid-cap" | "degen" | "sigma" | "blue-chip";
export type TradeGasPriority = "low" | "standard" | "high";

/** The exact JSON object signed by the owner; crashProtection is optional for old hires. */
type TradeSettingsFields = {
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
  /** Model that decides entries and blank-threshold exits. Operator catalogue only. */
  readonly primaryModel: TradeLlmModelId;
  /** Used only when the primary throws or answers off-schema; never equal to it. */
  readonly fallbackModel: TradeLlmModelId;
  /** Explicit discriminator for the USDT-denominated TradFi revision. */
  readonly settlementAsset?: "USDT";
  /** Minimum USDT input for a v2 entry, in atomic units. */
  readonly minEntryWei?: string;
  /** Rolling-day USDT principal ceiling including buy fees. */
  readonly capitalQuoteWei?: string;
  /** Owner's opt-in for the trade-scoped paid context. */
  readonly cmcNewsEnabled?: boolean;
  /** Initial total CMC budget; top-ups use the owner action seam. */
  readonly cmcTotalBudgetWei?: string;
  /** Mode discriminator: a fixed-amount buy schedule, or Auto DCA. */
  readonly tradeMode?: "schedule" | "dca" | "portfolio";
  readonly portfolioTokens?: readonly string[];
  readonly portfolioWeightsBps?: readonly number[];
  readonly portfolioDriftBps?: number;
  readonly portfolioIntervalSec?: 14400 | 28800 | 43200 | 86400;
  /** The one bStock selected by a schedule hire. */
  readonly scheduleToken?: string;
  readonly scheduleIntervalSec?: 3600 | 14400 | 28800 | 43200 | 86400;
  readonly scheduleFirstAtSec?: number | null;
  readonly scheduleEndKind?: "budget" | "date" | "runs";
  readonly scheduleEndAtSec?: number | null;
  readonly scheduleEndRuns?: number | null;
  readonly scheduleMarketHoursOnly?: boolean;
  readonly scheduleMaxPremiumBps?: number;
  /** Auto DCA (AUTO-DCA-SPEC §8.1): the one pinned stock, lowercase. */
  readonly dcaToken?: string;
  readonly dcaStepBps?: number;
  /** R9's ×1.2, signed as the fixed literal 12000; never a control (D1). */
  readonly dcaStepMultiplierBps?: number;
  readonly dcaTakeProfitBps?: number;
  /** Every DCA order is exactly this much USDT (R8's ×1.0). */
  readonly dcaOrderWei?: string;
  readonly dcaMaxOrders?: number;
  /** USDT per stock ×1e8; `null` = off (R14). */
  readonly dcaTriggerPriceE8?: string | null;
  readonly dcaRangeMinE8?: string | null;
  readonly dcaRangeMaxE8?: string | null;
  /** % of the total USDT deposited; `null` = off (R11). */
  readonly dcaStopLossBps?: number | null;
};

/** The owner-signed object. The revision-2 field is optional for old hires. */
export type TradeSettings = TradeSettingsFields & {
  readonly crashProtection?: boolean;
};

/** Behavioural settings after the compatibility default has been applied. */
export type EffectiveTradeSettings = TradeSettingsFields & {
  readonly crashProtection: boolean;
};

export type TradeSettingsRaw = TradeSettings;

export const MIN_TRADE_ENTRY_WEI = 2_000_000_000_000_000n;
export const MAX_INSTRUCTIONS_ENCODED_BYTES = 2_048;
export const MAX_SKILL_MARKDOWN_ENCODED_BYTES = 6_144;

export const DEFAULT_TRADE_SETTINGS: TradeSettings = {
  name: "Trading Agent 01",
  executionModel: "sigma",
  entryWei: "2000000000000000",
  maxOpenPositions: 3,
  minMarketCapUsd: null,
  maxMarketCapUsd: null,
  noReentry: true,
  takeProfitBps: 10_000,
  stopLossBps: 5_000,
  maxHoldSec: 7_200,
  breakEvenAfterTp: true,
  slippageBps: 300,
  gasPriority: "standard",
  instructions: null,
  skillMarkdown: null,
  primaryModel: "qwen3.7-flash",
  fallbackModel: "0gm-1.0-35b-a3b",
  crashProtection: true,
};

// TRADING-AGENT R5: a literal, not a self-computed constant, catches default drift.
export const DEFAULT_TRADE_SETTINGS_DIGEST: Hex =
  "0xffc2f80941f258f3964d75961094b5e82759dd33211c61a86f033c62b5fe01ef";

export type TradeSettingsParseResult =
  | { readonly ok: true; readonly value: { readonly raw: TradeSettingsRaw; readonly effective: EffectiveTradeSettings } }
  | { readonly ok: false; readonly message: string };

const SETTINGS_KEYS = [
  "name",
  "executionModel",
  "entryWei",
  "maxOpenPositions",
  "minMarketCapUsd",
  "maxMarketCapUsd",
  "noReentry",
  "takeProfitBps",
  "stopLossBps",
  "maxHoldSec",
  "breakEvenAfterTp",
  "slippageBps",
  "gasPriority",
  "instructions",
  "skillMarkdown",
  "primaryModel",
  "fallbackModel",
  "crashProtection",
  "settlementAsset",
  "minEntryWei",
  "capitalQuoteWei",
  "cmcNewsEnabled",
  "cmcTotalBudgetWei",
  "tradeMode",
  "scheduleToken",
  "scheduleIntervalSec",
  "scheduleFirstAtSec",
  "scheduleEndKind",
  "scheduleEndAtSec",
  "scheduleEndRuns",
  "scheduleMarketHoursOnly",
  "scheduleMaxPremiumBps",
  "dcaToken",
  "dcaStepBps",
  "dcaStepMultiplierBps",
  "dcaTakeProfitBps",
  "dcaOrderWei",
  "dcaMaxOrders",
  "dcaTriggerPriceE8",
  "dcaRangeMinE8",
  "dcaRangeMaxE8",
  "dcaStopLossBps",
  "portfolioTokens",
  "portfolioWeightsBps",
  "portfolioDriftBps",
  "portfolioIntervalSec",
] as const satisfies readonly (keyof TradeSettings)[];

const SETTINGS_KEY_SET: ReadonlySet<string> = new Set(SETTINGS_KEYS);
const SCHEDULE_KEYS = [
  "tradeMode", "scheduleToken", "scheduleIntervalSec", "scheduleFirstAtSec", "scheduleEndKind",
  "scheduleEndAtSec", "scheduleEndRuns", "scheduleMarketHoursOnly", "scheduleMaxPremiumBps",
] as const;
const SCHEDULE_KEY_SET: ReadonlySet<string> = new Set(SCHEDULE_KEYS);
/** The Auto DCA tuple, all-or-nothing with `tradeMode: "dca"` (§8.1). */
const DCA_KEYS = [
  "tradeMode", "dcaToken", "dcaStepBps", "dcaStepMultiplierBps", "dcaTakeProfitBps", "dcaOrderWei",
  "dcaMaxOrders", "dcaTriggerPriceE8", "dcaRangeMinE8", "dcaRangeMaxE8", "dcaStopLossBps",
] as const;
const DCA_KEY_SET: ReadonlySet<string> = new Set(DCA_KEYS);
const PORTFOLIO_KEYS = ["tradeMode", "portfolioTokens", "portfolioWeightsBps", "portfolioDriftBps", "portfolioIntervalSec"] as const;
const PORTFOLIO_KEY_SET: ReadonlySet<string> = new Set(PORTFOLIO_KEYS);
const REQUIRED_SETTINGS_KEYS = SETTINGS_KEYS.filter((key) =>
  key !== "crashProtection"
  && key !== "settlementAsset"
  && key !== "minEntryWei"
  && key !== "capitalQuoteWei"
  && key !== "cmcNewsEnabled"
  && key !== "cmcTotalBudgetWei"
  && !SCHEDULE_KEY_SET.has(key)
  && !DCA_KEY_SET.has(key)
  && !PORTFOLIO_KEY_SET.has(key),
);

export const SCHEDULE_INTERVALS_SEC = [3600, 14400, 28800, 43200, 86400] as const;
export const SCHEDULE_MIN_BUY_WEI = 5_000_000_000_000_000_000n;
/** D10 as ruled (R2.1, R2.16): the base order is at least 15 USDT. */
export const DCA_MIN_BASE_WEI = 15_000_000_000_000_000_000n;
/** R6: every DCA order is at least 10 USDT. */
export const DCA_MIN_ORDER_WEI = 10_000_000_000_000_000_000n;

const DCA_E8_PATTERN = /^[1-9]\d{0,29}$/u;

function fail(message: string): TradeSettingsParseResult {
  return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | string {
  if (!Number.isInteger(value)) return `${field} must be an integer.`;
  const integer = value as number;
  return integer < min || integer > max
    ? `${field} must be between ${min} and ${max}.`
    : integer;
}

function readNullableInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null | string {
  return value === null ? null : readInt(value, field, min, max);
}

function readMarketCap(value: unknown, field: string): number | null | string {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return `${field} must be a non-negative finite number or null.`;
  }
  return value;
}

/** JSON-string encoded bytes, including escapes and the surrounding quotes. */
export function encodedJsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function readBoundedText(
  value: unknown,
  field: string,
  maxBytes: number,
): string | null | { readonly error: string } {
  if (value === null) return null;
  if (typeof value !== "string") return { error: `${field} must be a string or null.` };
  const bytes = encodedJsonStringBytes(value);
  return bytes <= maxBytes
    ? value
    : { error: `${field} must encode to at most ${maxBytes} bytes; received ${bytes}.` };
}

/** Validate the complete signed object without defaulting or dropping a key. */
export function parseTradeSettings(value: unknown): TradeSettingsParseResult {
  if (!isRecord(value)) return fail("Trade settings must be a JSON object.");
  const unknown = Object.keys(value).find((key) => !SETTINGS_KEY_SET.has(key));
  if (unknown !== undefined) return fail(`Trade settings has unknown key "${unknown}".`);
  const missing = REQUIRED_SETTINGS_KEYS.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) return fail(`Trade settings is missing key "${missing}"; unset values must be null.`);

  const name = value["name"];
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    return fail("name must be a non-empty string of at most 64 characters.");
  }
  const executionModel = value["executionModel"];
  if (
    executionModel !== "blue-chip" && executionModel !== "mid-cap"
    && executionModel !== "degen" && executionModel !== "sigma" && executionModel !== "tradfi"
  ) return fail("executionModel is invalid.");
  const entryWei = value["entryWei"];
  if (typeof entryWei !== "string" || !/^(0|[1-9]\d{0,77})$/u.test(entryWei)) {
    return fail("entryWei must be a canonical decimal wei string.");
  }
  const hasV2Key = ["settlementAsset", "minEntryWei", "capitalQuoteWei", "cmcNewsEnabled", "cmcTotalBudgetWei"]
    .some((key) => Object.hasOwn(value, key));
  if (!hasV2Key && BigInt(entryWei) < MIN_TRADE_ENTRY_WEI) {
    return fail(`entryWei must be at least ${MIN_TRADE_ENTRY_WEI} wei.`);
  }
  if (hasV2Key && (BigInt(entryWei) <= 0n || BigInt(entryWei) > MAX_UINT256)) {
    return fail("entryWei must be a positive uint256 decimal string for TradFi v2.");
  }
  const maxOpenPositions = readInt(value["maxOpenPositions"], "maxOpenPositions", 1, 10);
  if (typeof maxOpenPositions === "string") return fail(maxOpenPositions);
  const minMarketCapUsd = readMarketCap(value["minMarketCapUsd"], "minMarketCapUsd");
  if (typeof minMarketCapUsd === "string") return fail(minMarketCapUsd);
  const maxMarketCapUsd = readMarketCap(value["maxMarketCapUsd"], "maxMarketCapUsd");
  if (typeof maxMarketCapUsd === "string") return fail(maxMarketCapUsd);
  if (minMarketCapUsd !== null && maxMarketCapUsd !== null && minMarketCapUsd > maxMarketCapUsd) {
    return fail("minMarketCapUsd must not exceed maxMarketCapUsd.");
  }
  const noReentry = value["noReentry"];
  if (typeof noReentry !== "boolean") return fail("noReentry must be a boolean.");
  const takeProfitBps = readNullableInt(value["takeProfitBps"], "takeProfitBps", 0, 10_000);
  if (typeof takeProfitBps === "string") return fail(takeProfitBps);
  const stopLossBps = readNullableInt(value["stopLossBps"], "stopLossBps", 0, 10_000);
  if (typeof stopLossBps === "string") return fail(stopLossBps);
  const maxHoldSec = readNullableInt(value["maxHoldSec"], "maxHoldSec", 60, 604_800);
  if (typeof maxHoldSec === "string") return fail(maxHoldSec);
  const breakEvenAfterTp = value["breakEvenAfterTp"];
  if (typeof breakEvenAfterTp !== "boolean") return fail("breakEvenAfterTp must be a boolean.");
  const slippageBps = readInt(value["slippageBps"], "slippageBps", 50, 500);
  if (typeof slippageBps === "string") return fail(slippageBps);
  const gasPriority = value["gasPriority"];
  if (gasPriority !== "low" && gasPriority !== "standard" && gasPriority !== "high") {
    return fail("gasPriority must be low, standard, or high.");
  }
  const instructions = readBoundedText(
    value["instructions"], "instructions", MAX_INSTRUCTIONS_ENCODED_BYTES,
  );
  if (typeof instructions === "object" && instructions !== null && "error" in instructions) {
    return fail(instructions.error);
  }
  const skillMarkdown = readBoundedText(
    value["skillMarkdown"], "skillMarkdown", MAX_SKILL_MARKDOWN_ENCODED_BYTES,
  );
  if (typeof skillMarkdown === "object" && skillMarkdown !== null && "error" in skillMarkdown) {
    return fail(skillMarkdown.error);
  }

  // Two distinct catalogue ids: a fallback equal to the primary is not a
  // fallback, and an id outside the catalogue is an unpriced provider call.
  const primaryModel = value["primaryModel"];
  if (!isTradeLlmModelId(primaryModel)) return fail("primaryModel is not an offered model.");
  const fallbackModel = value["fallbackModel"];
  if (!isTradeLlmModelId(fallbackModel)) return fail("fallbackModel is not an offered model.");
  if (primaryModel === fallbackModel) return fail("fallbackModel must differ from primaryModel.");

  const isDca = value["tradeMode"] === "dca"
    || Object.keys(value).some((key) => key !== "tradeMode" && DCA_KEY_SET.has(key));
  const isPortfolio = !isDca && (value["tradeMode"] === "portfolio"
    || Object.keys(value).some((key) => key !== "tradeMode" && PORTFOLIO_KEY_SET.has(key)));
  if (isPortfolio && (!hasV2Key || executionModel !== "tradfi" || value["settlementAsset"] !== "USDT")) {
    return fail("Portfolio settings require the TradFi v2 USDT tuple.");
  }

  if (hasV2Key && executionModel !== "tradfi") {
    return fail("TradFi v2 settlement fields require executionModel=tradfi.");
  }
  if (hasV2Key) {
    if (!isTradfiV2Settlement(value["settlementAsset"])) {
      return fail('TradFi v2 requires settlementAsset="USDT".');
    }
    const minEntryWei = value["minEntryWei"];
    const capitalQuoteWei = value["capitalQuoteWei"];
    if (!isCanonicalAtomic(minEntryWei) || BigInt(minEntryWei) <= 0n) {
      return fail("minEntryWei must be a positive canonical decimal string.");
    }
    if (!isCanonicalAtomic(capitalQuoteWei) || BigInt(capitalQuoteWei) <= 0n) {
      return fail("capitalQuoteWei must be a positive canonical decimal string.");
    }
    if (BigInt(minEntryWei) > BigInt(entryWei)) {
      return fail("minEntryWei must not exceed entryWei.");
    }
    if (typeof value["cmcNewsEnabled"] !== "boolean") {
      return fail("cmcNewsEnabled must be a boolean for TradFi v2.");
    }
    const budget = value["cmcTotalBudgetWei"];
    if (value["cmcNewsEnabled"] === true) {
      if (!isCanonicalAtomic(budget) || BigInt(budget) <= 0n) {
        return fail("cmcTotalBudgetWei must be a positive canonical decimal string when CMC news is enabled.");
      }
    } else if (budget !== undefined) {
      return fail("cmcTotalBudgetWei must be absent when CMC news is disabled.");
    }
  } else if (executionModel === "tradfi" && Object.hasOwn(value, "settlementAsset")) {
    return fail("TradFi settlement fields must be supplied as one complete v2 tuple.");
  }

  // AUTO-DCA §8: the DCA tuple is all-or-nothing and shares only `tradeMode`
  // with the schedule tuple, so it is judged first and the schedule branch
  // below never sees a DCA object.
  if (isDca) {
    if (Object.keys(value).some((key) => key !== "tradeMode" && PORTFOLIO_KEY_SET.has(key))) {
      return fail("Portfolio settings cannot be combined with DCA or schedule settings.");
    }
    if (value["tradeMode"] === "schedule"
      || Object.keys(value).some((key) => key !== "tradeMode" && SCHEDULE_KEY_SET.has(key))) {
      return fail("DCA and schedule settings cannot be combined.");
    }
    const missingDca = DCA_KEYS.find((key) => !Object.hasOwn(value, key));
    if (missingDca !== undefined) return fail(`DCA settings are missing key "${missingDca}".`);
    if (value["tradeMode"] !== "dca") return fail('DCA settings require tradeMode="dca".');
    if (executionModel !== "tradfi") return fail("DCA settings require executionModel=tradfi.");
    if (!hasV2Key) return fail("DCA settings require the TradFi v2 USDT tuple.");
    const token = value["dcaToken"];
    if (typeof token !== "string" || !/^0x[0-9a-f]{40}$/u.test(token) || dcaPoolForToken(token) === null) {
      return fail("dcaToken must be one of the Auto DCA stocks.");
    }
    const step = value["dcaStepBps"];
    if (!Number.isInteger(step) || (step as number) < 100 || (step as number) > 3000) {
      return fail("dcaStepBps must be an integer from 100 through 3000.");
    }
    const orders = value["dcaMaxOrders"];
    if (!Number.isInteger(orders) || (orders as number) < 1 || (orders as number) > 8) {
      return fail("dcaMaxOrders must be an integer from 1 through 8.");
    }
    if (!dcaStepWithinDepth(step as number, orders as number)) {
      return fail(`With ${orders as number} DCA orders the price drop step can be at most ${(dcaMaxStepBps(orders as number) / 100).toFixed(2)} % (the deepest order must stay within 90 % of the base price).`);
    }
    if (value["dcaStepMultiplierBps"] !== DCA_STEP_MULTIPLIER_BPS) return fail("dcaStepMultiplierBps must equal 12000.");
    const tp = value["dcaTakeProfitBps"];
    if (!Number.isInteger(tp) || (tp as number) < 100 || (tp as number) > 10_000) {
      return fail("dcaTakeProfitBps must be an integer from 100 through 10000.");
    }
    const dcaPool = dcaPoolForToken(token);
    if (dcaPool !== null && dcaPool.fee === 100 && (tp as number) < DCA_MIN_TP_BPS_FEE100) {
      return fail(`On ${dcaPool.symbol} the take profit must be at least 1.5 %.`);
    }
    if (BigInt(entryWei) < DCA_MIN_BASE_WEI || BigInt(entryWei) > MAX_UINT256) {
      return fail("DCA entryWei must be at least 15 USDT and fit uint256.");
    }
    const orderWei = value["dcaOrderWei"];
    if (!isCanonicalAtomic(orderWei) || BigInt(orderWei) < DCA_MIN_ORDER_WEI || BigInt(orderWei) > MAX_UINT256) {
      return fail("dcaOrderWei must be at least 10 USDT and fit uint256.");
    }
    if (BigInt(value["capitalQuoteWei"] as string) !== BigInt(entryWei) + BigInt(orders as number) * BigInt(orderWei)) {
      return fail("DCA capitalQuoteWei must equal entryWei + dcaMaxOrders × dcaOrderWei.");
    }
    if (BigInt(value["minEntryWei"] as string) !== BigInt(entryWei)) return fail("DCA minEntryWei must equal entryWei.");
    if (maxOpenPositions !== 1) return fail("DCA maxOpenPositions must equal 1.");
    if (takeProfitBps !== null || stopLossBps !== null || maxHoldSec !== null) {
      return fail("DCA exits must use dcaTakeProfitBps and dcaStopLossBps.");
    }
    if (value["crashProtection"] !== false) return fail("DCA crashProtection must be false.");
    if (value["cmcNewsEnabled"] !== false || Object.hasOwn(value, "cmcTotalBudgetWei")) return fail("DCA CMC news must be disabled.");
    // §8.2: the AI-mode fields that no DCA path reads are pinned to their unset values.
    if (noReentry || breakEvenAfterTp || minMarketCapUsd !== null || maxMarketCapUsd !== null
      || instructions !== null || skillMarkdown !== null) {
      return fail("DCA settings require noReentry and breakEvenAfterTp false and null market caps, instructions and skillMarkdown.");
    }
    const trigger = value["dcaTriggerPriceE8"];
    if (trigger !== null && (typeof trigger !== "string" || !DCA_E8_PATTERN.test(trigger))) {
      return fail("dcaTriggerPriceE8 must be null or a positive canonical decimal.");
    }
    const rangeMin = value["dcaRangeMinE8"];
    const rangeMax = value["dcaRangeMaxE8"];
    const rangeOff = rangeMin === null && rangeMax === null;
    const rangeOn = typeof rangeMin === "string" && typeof rangeMax === "string"
      && DCA_E8_PATTERN.test(rangeMin) && DCA_E8_PATTERN.test(rangeMax) && BigInt(rangeMin) < BigInt(rangeMax);
    if (!rangeOff && !rangeOn) {
      return fail("dcaRangeMinE8 and dcaRangeMaxE8 must both be null or both positive, with min below max.");
    }
    const stop = value["dcaStopLossBps"];
    if (stop !== null && (!Number.isInteger(stop) || (stop as number) < 100 || (stop as number) > 9900)) {
      return fail("dcaStopLossBps must be null or an integer from 100 through 9900.");
    }
  }

  if (isPortfolio) {
    if (Object.keys(value).some((key) => key !== "tradeMode" && (DCA_KEY_SET.has(key) || SCHEDULE_KEY_SET.has(key)))) {
      return fail("Portfolio settings cannot be combined with DCA or schedule settings.");
    }
    const missingPortfolio = PORTFOLIO_KEYS.find((key) => !Object.hasOwn(value, key));
    if (missingPortfolio !== undefined) return fail(`Portfolio settings are missing key "${missingPortfolio}".`);
    if (value["tradeMode"] !== "portfolio") return fail('Portfolio settings require tradeMode="portfolio".');
    const tokens = value["portfolioTokens"];
    if (!Array.isArray(tokens) || tokens.length < PORTFOLIO_MIN_TOKENS || tokens.length > PORTFOLIO_MAX_TOKENS) {
      return fail("portfolioTokens must list 2 to 5 stocks.");
    }
    if (tokens.some((token: unknown) => typeof token !== "string" || !/^0x[0-9a-f]{40}$/u.test(token))
      || new Set(tokens).size !== tokens.length) {
      return fail("portfolioTokens must be distinct lowercase addresses.");
    }
    if (tokens.some((token: string) => !portfolioStockAllowed(token))) return fail("portfolioTokens must be Smart Portfolio stocks.");
    const weights = value["portfolioWeightsBps"];
    if (!Array.isArray(weights) || weights.length !== tokens.length
      || weights.some((weight: unknown) => !Number.isInteger(weight) || (weight as number) % 100 !== 0
        || (weight as number) < PORTFOLIO_MIN_WEIGHT_BPS || (weight as number) > 10_000)
      || (weights as number[]).reduce((sum, weight) => sum + weight, 0) !== 10_000) {
      return fail("portfolioWeightsBps must give each stock a whole percent of at least 10 %, summing to 100 %.");
    }
    const drift = value["portfolioDriftBps"];
    if (!Number.isInteger(drift) || (drift as number) % 50 !== 0
      || (drift as number) < PORTFOLIO_MIN_DRIFT_BPS || (drift as number) > PORTFOLIO_MAX_DRIFT_BPS) {
      return fail("portfolioDriftBps must be 0.5 % to 15 % in 0.5 % steps.");
    }
    const interval = value["portfolioIntervalSec"];
    if (!Number.isInteger(interval) || !(PORTFOLIO_INTERVALS_SEC as readonly number[]).includes(interval as number)) {
      return fail("portfolioIntervalSec must be 4 h, 8 h, 12 h or daily.");
    }
    const capital = BigInt(value["capitalQuoteWei"] as string);
    if (capital > MAX_UINT256 / 5n) return fail("Portfolio capital is too large.");
    const minimum = portfolioMinCapitalWei(tokens.length);
    if (capital < minimum) return fail(`Portfolio capital must be at least ${minimum / 10n ** 18n} USDT for ${tokens.length} stocks.`);
    if (BigInt(entryWei) !== capital) return fail("Portfolio entryWei must equal capitalQuoteWei.");
    if (BigInt(value["minEntryWei"] as string) !== PORTFOLIO_MIN_LEG_WEI
      && BigInt(value["minEntryWei"] as string) !== PORTFOLIO_LEGACY_MIN_LEG_WEI) return fail("Portfolio minEntryWei must equal 0.1 USDT (or 1 USDT for earlier agents).");
    if (maxOpenPositions !== 1) return fail("Portfolio maxOpenPositions must equal 1.");
    if (takeProfitBps !== null || stopLossBps !== null || maxHoldSec !== null) return fail("Portfolio exits must be unset.");
    if (value["crashProtection"] !== false) return fail("Portfolio crashProtection must be false.");
    if (value["cmcNewsEnabled"] !== false || Object.hasOwn(value, "cmcTotalBudgetWei")) return fail("Portfolio CMC news must be disabled.");
    if (noReentry || breakEvenAfterTp || minMarketCapUsd !== null || maxMarketCapUsd !== null
      || instructions !== null || skillMarkdown !== null) {
      return fail("Portfolio settings require noReentry and breakEvenAfterTp false and null market caps, instructions and skillMarkdown.");
    }
  }

  const hasScheduleKey = !isDca && !isPortfolio && Object.keys(value).some((key) => SCHEDULE_KEY_SET.has(key));
  if (hasScheduleKey) {
    const missingSchedule = SCHEDULE_KEYS.find((key) => !Object.hasOwn(value, key));
    if (missingSchedule !== undefined) return fail(`Schedule settings are missing key "${missingSchedule}".`);
    if (value["tradeMode"] !== "schedule") return fail('Schedule settings require tradeMode="schedule".');
    if (!hasV2Key || executionModel !== "tradfi") return fail("Schedule settings require the TradFi v2 USDT tuple.");
    if (BigInt(value["minEntryWei"] as string) !== BigInt(entryWei)) return fail("Schedule minEntryWei must equal entryWei.");
    if (BigInt(entryWei) < SCHEDULE_MIN_BUY_WEI || BigInt(entryWei) > MAX_UINT256) return fail("Schedule entryWei must be at least 5 USDT and fit uint256.");
    if (BigInt(value["capitalQuoteWei"] as string) < BigInt(entryWei)) return fail("Schedule capitalQuoteWei must cover entryWei.");
    if (maxOpenPositions !== 1) return fail("Schedule maxOpenPositions must equal 1.");
    if (takeProfitBps !== null || stopLossBps !== null || maxHoldSec !== null) return fail("Schedule exits must be unset.");
    if (value["cmcNewsEnabled"] !== false || Object.hasOwn(value, "cmcTotalBudgetWei")) return fail("Schedule CMC news must be disabled.");
    const token = value["scheduleToken"];
    if (typeof token !== "string" || !/^0x[0-9a-f]{40}$/u.test(token)) return fail("scheduleToken must be a lowercase 20-byte address.");
    const interval = value["scheduleIntervalSec"];
    if (!Number.isInteger(interval) || !(SCHEDULE_INTERVALS_SEC as readonly number[]).includes(interval as number)) return fail("scheduleIntervalSec is invalid; weekly schedules are not supported.");
    const first = value["scheduleFirstAtSec"];
    if (first !== null && (!Number.isSafeInteger(first) || (first as number) < 0 || (first as number) > 2 ** 40)) return fail("scheduleFirstAtSec must be null or an integer from 0 through 2^40.");
    const endKind = value["scheduleEndKind"];
    if (endKind !== "budget" && endKind !== "date" && endKind !== "runs") return fail("scheduleEndKind is invalid.");
    const endAt = value["scheduleEndAtSec"];
    const endRuns = value["scheduleEndRuns"];
    if (endKind === "date") {
      if (!Number.isSafeInteger(endAt) || (endAt as number) < 0 || endRuns !== null) return fail("Date schedules require scheduleEndAtSec and null scheduleEndRuns.");
    } else if (endAt !== null) return fail("Non-date schedules require null scheduleEndAtSec.");
    if (endKind === "runs") {
      if (!Number.isSafeInteger(endRuns) || (endRuns as number) < 1 || (endRuns as number) > 1000) return fail("scheduleEndRuns must be an integer from 1 through 1000.");
    } else if (endRuns !== null) return fail("Non-run schedules require null scheduleEndRuns.");
    if (typeof value["scheduleMarketHoursOnly"] !== "boolean") return fail("scheduleMarketHoursOnly must be a boolean.");
    const premium = value["scheduleMaxPremiumBps"];
    if (!Number.isInteger(premium) || (premium as number) < 50 || (premium as number) > 150) return fail("scheduleMaxPremiumBps must be an integer from 50 through 150.");
  }

  const hasCrashProtection = Object.hasOwn(value, "crashProtection");
  const crashProtection = value["crashProtection"];
  if (hasCrashProtection && typeof crashProtection !== "boolean") {
    return fail("crashProtection must be a boolean.");
  }
  const raw: TradeSettingsRaw = {
    name,
    executionModel,
    entryWei,
    maxOpenPositions,
    minMarketCapUsd,
    maxMarketCapUsd,
    noReentry,
    takeProfitBps,
    stopLossBps,
    maxHoldSec,
    breakEvenAfterTp,
    slippageBps,
    gasPriority,
    instructions,
    skillMarkdown,
    primaryModel,
    fallbackModel,
    ...(hasCrashProtection ? { crashProtection: crashProtection as boolean } : {}),
    ...(hasV2Key ? {
      settlementAsset: "USDT" as const,
      minEntryWei: value["minEntryWei"] as string,
      capitalQuoteWei: value["capitalQuoteWei"] as string,
      cmcNewsEnabled: value["cmcNewsEnabled"] as boolean,
      ...(value["cmcTotalBudgetWei"] === undefined ? {} : { cmcTotalBudgetWei: value["cmcTotalBudgetWei"] as string }),
    } : {}),
    ...(hasScheduleKey ? {
      tradeMode: "schedule" as const,
      scheduleToken: value["scheduleToken"] as string,
      scheduleIntervalSec: value["scheduleIntervalSec"] as NonNullable<TradeSettings["scheduleIntervalSec"]>,
      scheduleFirstAtSec: value["scheduleFirstAtSec"] as number | null,
      scheduleEndKind: value["scheduleEndKind"] as NonNullable<TradeSettings["scheduleEndKind"]>,
      scheduleEndAtSec: value["scheduleEndAtSec"] as number | null,
      scheduleEndRuns: value["scheduleEndRuns"] as number | null,
      scheduleMarketHoursOnly: value["scheduleMarketHoursOnly"] as boolean,
      scheduleMaxPremiumBps: value["scheduleMaxPremiumBps"] as number,
    } : {}),
    ...(isDca ? {
      tradeMode: "dca" as const,
      dcaToken: value["dcaToken"] as string,
      dcaStepBps: value["dcaStepBps"] as number,
      dcaStepMultiplierBps: value["dcaStepMultiplierBps"] as number,
      dcaTakeProfitBps: value["dcaTakeProfitBps"] as number,
      dcaOrderWei: value["dcaOrderWei"] as string,
      dcaMaxOrders: value["dcaMaxOrders"] as number,
      dcaTriggerPriceE8: value["dcaTriggerPriceE8"] as string | null,
      dcaRangeMinE8: value["dcaRangeMinE8"] as string | null,
      dcaRangeMaxE8: value["dcaRangeMaxE8"] as string | null,
      dcaStopLossBps: value["dcaStopLossBps"] as number | null,
    } : {}),
    ...(isPortfolio ? {
      tradeMode: "portfolio" as const,
      portfolioTokens: [...value["portfolioTokens"] as string[]],
      portfolioWeightsBps: [...value["portfolioWeightsBps"] as number[]],
      portfolioDriftBps: value["portfolioDriftBps"] as number,
      portfolioIntervalSec: value["portfolioIntervalSec"] as NonNullable<TradeSettings["portfolioIntervalSec"]>,
    } : {}),
  };

  return {
    ok: true,
    value: { raw, effective: { ...raw, crashProtection: hasCrashProtection ? crashProtection as boolean : false } },
  };
}

/** Recompute the one owner-action digest over the complete wire object. */
export function tradeSettingsDigest(settings: TradeSettingsRaw): Hex {
  return paramsHash("tradeSettings", settings);
}

const EDITABLE_TRADE_SETTINGS = new Set<keyof EffectiveTradeSettings>([
  "noReentry", "takeProfitBps", "stopLossBps", "maxHoldSec", "slippageBps",
  "primaryModel", "fallbackModel", "crashProtection", "entryWei", "minEntryWei", "cmcNewsEnabled",
]);

/** Server authority for the detail editor; hidden browser controls are not a boundary. */
export function immutableTradeSettingChange(
  current: EffectiveTradeSettings,
  next: EffectiveTradeSettings,
): keyof EffectiveTradeSettings | null {
  // AUTO-DCA §8.4 / D16: the first branch, and it returns BEFORE the
  // `v2Mutable` clause below, which would otherwise let `entryWei`,
  // `minEntryWei` and `cmcNewsEnabled` change for any v2 pair (F16). After a
  // DCA hire only the slippage and the stop loss may change.
  const currentDca = isTradeDcaSettings(current);
  if (currentDca !== isTradeDcaSettings(next)) return "tradeMode";
  if (currentDca) {
    for (const key of SETTINGS_KEYS) {
      if (key !== "slippageBps" && key !== "dcaStopLossBps" && current[key] !== next[key]) return key;
    }
    return null;
  }
  const currentPortfolio = isTradePortfolioSettings(current);
  if (currentPortfolio !== isTradePortfolioSettings(next)) return "tradeMode";
  if (currentPortfolio) {
    for (const key of SETTINGS_KEYS) {
      if (key === "slippageBps") continue;
      if (key === "portfolioTokens" || key === "portfolioWeightsBps") {
        const before = current[key];
        const after = next[key];
        if (before?.length !== after?.length || before?.some((item, index) => item !== after?.[index])) return key;
      } else if (current[key] !== next[key]) return key;
    }
    return null;
  }
  const currentV2 = current.settlementAsset === "USDT";
  const nextV2 = next.settlementAsset === "USDT";
  const currentSchedule = isTradeScheduleSettings(current);
  const nextSchedule = isTradeScheduleSettings(next);
  if (currentSchedule !== nextSchedule) return "tradeMode";
  const scheduleEditable = new Set<keyof EffectiveTradeSettings>([
    "slippageBps", "scheduleMaxPremiumBps", "scheduleMarketHoursOnly", "scheduleEndKind", "scheduleEndAtSec", "scheduleEndRuns",
    // Operator ruling 2026-09-21: the frequency may change mid-flight. Slots keep
    // counting from the same anchor under the new interval; the signed native
    // cap is unchanged and the day meter still bounds a faster cadence.
    "scheduleIntervalSec",
  ]);
  const togglesNews = currentV2 && nextV2 && current.cmcNewsEnabled !== next.cmcNewsEnabled;
  for (const key of SETTINGS_KEYS) {
    if (key === "settlementAsset" && currentV2 !== nextV2) return "settlementAsset";
    const v2Mutable = currentV2 && nextV2
      && (key === "entryWei" || key === "minEntryWei" || key === "cmcNewsEnabled"
        || (key === "cmcTotalBudgetWei" && togglesNews));
    const editable = currentSchedule && nextSchedule
      ? scheduleEditable.has(key)
      : EDITABLE_TRADE_SETTINGS.has(key) && (currentV2 || (key !== "entryWei" && key !== "minEntryWei" && key !== "cmcNewsEnabled"));
    if (!editable && !v2Mutable && current[key] !== next[key]) return key;
  }
  return null;
}

/** The persisted discriminator, never inferred from the model name alone. */
export function isTradfiV2Settings(settings: Pick<TradeSettings, "executionModel" | "settlementAsset">): boolean {
  return settings.executionModel === "tradfi" && settings.settlementAsset === "USDT";
}

/**
 * The TradFi AI trade agent: the USDT model with no schedule / DCA / portfolio
 * mode. The ONE plane predicate behind the expiry/keep-remove rules
 * (TRADFI-EXPIRY-KEEP-REMOVE §scope); every other model stays untouched.
 */
export function isTradfiAiSettings(settings: Pick<TradeSettings, "executionModel" | "settlementAsset" | "tradeMode">): boolean {
  return isTradfiV2Settings(settings) && settings.tradeMode === undefined;
}

export function isTradeScheduleSettings(settings: Pick<TradeSettings, "executionModel" | "settlementAsset" | "tradeMode">): boolean {
  return isTradfiV2Settings(settings) && settings.tradeMode === "schedule";
}

/** The ONE predicate every Auto DCA surface keys on, never a field's presence (§0.2). */
export function isTradeDcaSettings(settings: Pick<TradeSettings, "executionModel" | "settlementAsset" | "tradeMode">): boolean {
  return isTradfiV2Settings(settings) && settings.tradeMode === "dca";
}

export function isTradePortfolioSettings(settings: Pick<TradeSettings, "executionModel" | "settlementAsset" | "tradeMode">): boolean {
  return isTradfiV2Settings(settings) && settings.tradeMode === "portfolio";
}
