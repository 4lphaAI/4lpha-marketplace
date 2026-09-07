/** Owner-signed trading settings codec (TRADING-AGENT R5 / R3.10). */
import type { Hex } from "viem";
import { paramsHash } from "../auth/canonical.js";
import { isTradeLlmModelId, type TradeLlmModelId } from "./llm.js";

export type TradeExecutionModel = "blue-chip" | "mid-cap" | "degen" | "sigma";
export type TradeGasPriority = "low" | "standard" | "high";

/** The exact JSON object signed by the owner; every key is mandatory. */
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
  /** Model that decides entries and blank-threshold exits. Operator catalogue only. */
  readonly primaryModel: TradeLlmModelId;
  /** Used only when the primary throws or answers off-schema; never equal to it. */
  readonly fallbackModel: TradeLlmModelId;
};

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
  primaryModel: "0gm-1.0-35b-a3b",
  fallbackModel: "qwen3-vl-30b",
};

// TRADING-AGENT R5: a literal, not a self-computed constant, catches default drift.
export const DEFAULT_TRADE_SETTINGS_DIGEST: Hex =
  "0xb34733da23bd5e68c2254b4a2657c502d620d8cdbf3dfe52e62548841e57b007";

export type TradeSettingsParseResult =
  | { readonly ok: true; readonly value: TradeSettings }
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
] as const satisfies readonly (keyof TradeSettings)[];

const SETTINGS_KEY_SET: ReadonlySet<string> = new Set(SETTINGS_KEYS);

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
  const missing = SETTINGS_KEYS.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) return fail(`Trade settings is missing key "${missing}"; unset values must be null.`);

  const name = value["name"];
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    return fail("name must be a non-empty string of at most 64 characters.");
  }
  const executionModel = value["executionModel"];
  if (
    executionModel !== "blue-chip" && executionModel !== "mid-cap"
    && executionModel !== "degen" && executionModel !== "sigma"
  ) return fail("executionModel is invalid.");
  const entryWei = value["entryWei"];
  if (typeof entryWei !== "string" || !/^(0|[1-9]\d{0,77})$/u.test(entryWei)) {
    return fail("entryWei must be a canonical decimal wei string.");
  }
  if (BigInt(entryWei) < MIN_TRADE_ENTRY_WEI) {
    return fail(`entryWei must be at least ${MIN_TRADE_ENTRY_WEI} wei.`);
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

  return {
    ok: true,
    value: {
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
    },
  };
}

/** Recompute the one owner-action digest over the complete wire object. */
export function tradeSettingsDigest(settings: TradeSettings): Hex {
  return paramsHash("tradeSettings", settings);
}

const EDITABLE_TRADE_SETTINGS = new Set<keyof TradeSettings>([
  "noReentry", "takeProfitBps", "stopLossBps", "maxHoldSec", "slippageBps",
  "primaryModel", "fallbackModel",
]);

/** Server authority for the detail editor; hidden browser controls are not a boundary. */
export function immutableTradeSettingChange(
  current: TradeSettings,
  next: TradeSettings,
): keyof TradeSettings | null {
  for (const key of SETTINGS_KEYS) {
    if (!EDITABLE_TRADE_SETTINGS.has(key) && current[key] !== next[key]) return key;
  }
  return null;
}
