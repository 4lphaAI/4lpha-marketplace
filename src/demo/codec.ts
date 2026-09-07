/**
 * DEMO MODE — parsers between the store's opaque jsonb and the engines.
 *
 * ─── WHY EVERY PARSER RETURNS `null` RATHER THAN THROWING ──────────────────
 *
 * A demo row is written by this plane and read back by it, so a malformed one
 * means a code change landed on top of old rows — never a caller's input. The
 * useful answer there is "this agent holds and says why", not a 500 that takes
 * the cycle down with it. Every parser is therefore total: it validates, and it
 * returns `null` for anything it cannot fully account for.
 *
 * The store's codec already survives `bigint` across jsonb (`$bigint` tags), so
 * these functions validate SHAPE, not encoding.
 */
import { getAddress, type Address } from "viem";

import type { DemoGridFill, DemoGridState } from "./gridEngine.js";
import type { DemoTradeFill, DemoTradeSettings, DemoTradeState } from "./tradeEngine.js";
import type { LpGridRange, LpGridSettings } from "../lp/triggers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function big(value: unknown): bigint | null {
  return typeof value === "bigint" ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function address(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function range(value: unknown): LpGridRange | null {
  if (!isRecord(value)) return null;
  const tickLower = int(value["tickLower"]);
  const tickUpper = int(value["tickUpper"]);
  if (tickLower === null || tickUpper === null || tickLower >= tickUpper) return null;
  return { tickLower, tickUpper };
}

/* -------------------------------------------------------------------------- */
/* Grid                                                                       */
/* -------------------------------------------------------------------------- */

export type DemoGridConfig = {
  /** The pool the demo samples. Resolved at creation, frozen for the run. */
  readonly pool: Address;
  readonly grid: LpGridSettings;
  readonly budgetQuoteWei: bigint;
  readonly quoteSymbol: string;
  readonly baseSymbol: string;
};

export function parseDemoGridConfig(value: unknown): DemoGridConfig | null {
  if (!isRecord(value)) return null;
  const pool = address(value["pool"]);
  const budgetQuoteWei = big(value["budgetQuoteWei"]);
  const grid = parseGridSettings(value["grid"]);
  const quoteSymbol = value["quoteSymbol"];
  const baseSymbol = value["baseSymbol"];
  if (
    pool === null
    || budgetQuoteWei === null
    || budgetQuoteWei <= 0n
    || grid === null
    || typeof quoteSymbol !== "string"
    || typeof baseSymbol !== "string"
  ) return null;
  return { pool, grid, budgetQuoteWei, quoteSymbol, baseSymbol };
}

export function parseGridSettings(value: unknown): LpGridSettings | null {
  if (!isRecord(value)) return null;
  const pool = value["pool"];
  if (!isRecord(pool)) return null;
  const token0 = address(pool["token0"]);
  const token1 = address(pool["token1"]);
  const fee = int(pool["fee"]);
  const wbnbIsToken0 = value["wbnbIsToken0"];
  const tickSpacing = int(value["tickSpacing"]);
  const buyRange = range(value["buyRange"]);
  const sellRange = range(value["sellRange"]);
  const maxFlipsPerDay = int(value["maxFlipsPerDay"]);
  const minNetEdgeBps = int(value["minNetEdgeBps"]);
  if (
    token0 === null
    || token1 === null
    || fee === null
    || typeof wbnbIsToken0 !== "boolean"
    || tickSpacing === null
    || tickSpacing <= 0
    || buyRange === null
    || sellRange === null
    || maxFlipsPerDay === null
    || minNetEdgeBps === null
  ) return null;
  // BOTH-OR-NEITHER, the live `validateLpSettings` rule (PHASE3.17 review2 N14):
  // a grid carrying half of level 2's pair is a geometry with no second ladder
  // and no way to say so, so it is refused rather than silently single-levelled.
  const rawBuy2 = value["buyRange2"];
  const rawSell2 = value["sellRange2"];
  if ((rawBuy2 === undefined) !== (rawSell2 === undefined)) return null;
  let dual: { buyRange2: LpGridRange; sellRange2: LpGridRange } | undefined;
  if (rawBuy2 !== undefined && rawSell2 !== undefined) {
    const buyRange2 = range(rawBuy2);
    const sellRange2 = range(rawSell2);
    if (buyRange2 === null || sellRange2 === null) return null;
    dual = { buyRange2, sellRange2 };
  }
  return {
    pool: { token0, token1, fee },
    wbnbIsToken0,
    tickSpacing,
    buyRange,
    sellRange,
    maxFlipsPerDay,
    minNetEdgeBps,
    ...(dual ?? {}),
  };
}

/**
 * The last tick a cycle acted on, with the moment it was read.
 *
 * OPTIONAL and OUTSIDE `DemoGridState`: the engine is pure over the tick it is
 * handed and must not grow a memory of one. This is presentation evidence, so a
 * viewer can be shown where the price sits relative to the rungs and how old
 * that reading is — never a number the engine decides on.
 */
export function parseDemoGridObservation(
  value: unknown,
): { readonly tick: number; readonly atMs: number } | null {
  if (!isRecord(value)) return null;
  const tick = int(value["lastTick"]);
  const atMs = int(value["lastTickAtMs"]);
  return tick === null || atMs === null ? null : { tick, atMs };
}

export function parseDemoGridState(value: unknown): DemoGridState | null {
  if (!isRecord(value) || value["kind"] !== "grid") return null;
  const rawLevels = value["levels"];
  const costQuoteWei = big(value["costQuoteWei"]);
  const flips = int(value["flips"]);
  if (!Array.isArray(rawLevels) || costQuoteWei === null || flips === null) return null;
  const levels: DemoGridState["levels"][number][] = [];
  for (const raw of rawLevels) {
    if (!isRecord(raw)) return null;
    const level = int(raw["level"]);
    const role = raw["role"];
    const liquidity = big(raw["liquidity"]);
    const cycles = int(raw["cycles"]);
    const realisedQuoteWei = big(raw["realisedQuoteWei"]);
    const openRaw = raw["openCycleQuoteWei"];
    const openCycleQuoteWei = openRaw === null ? null : big(openRaw);
    if (
      (level !== 1 && level !== 2)
      || (role !== "buy" && role !== "sell")
      || liquidity === null
      || cycles === null
      || realisedQuoteWei === null
      || (openRaw !== null && openCycleQuoteWei === null)
    ) return null;
    levels.push({ level, role, liquidity, openCycleQuoteWei, cycles, realisedQuoteWei });
  }
  return { levels, costQuoteWei, flips };
}

export function serialiseGridFill(fill: DemoGridFill): Readonly<Record<string, unknown>> {
  return {
    level: fill.level,
    from: fill.from,
    to: fill.to,
    atTick: fill.atTick,
    fromRange: fill.fromRange,
    toRange: fill.toRange,
    amount0Wei: fill.amount0Wei,
    amount1Wei: fill.amount1Wei,
    quoteWei: fill.quoteWei,
    baseWei: fill.baseWei,
    cycleQuoteDeltaWei: fill.cycleQuoteDeltaWei,
  };
}

/* -------------------------------------------------------------------------- */
/* Trade                                                                      */
/* -------------------------------------------------------------------------- */

export type DemoTradeUniverseRow = { readonly address: Address; readonly symbol: string };

export type DemoTradeConfig = {
  /** WBNB — the token every mark is expressed against. */
  readonly quoteToken: Address;
  readonly model: string;
  readonly universe: readonly DemoTradeUniverseRow[];
  readonly settings: DemoTradeSettings;
  readonly capitalQuoteWei: bigint;
  readonly brainEnabled: boolean;
};

export function parseDemoTradeConfig(value: unknown): DemoTradeConfig | null {
  if (!isRecord(value)) return null;
  const quoteToken = address(value["quoteToken"]);
  const model = value["model"];
  const capitalQuoteWei = big(value["capitalQuoteWei"]);
  const brainEnabled = value["brainEnabled"];
  const rawUniverse = value["universe"];
  const settings = parseTradeSettings(value["settings"]);
  if (
    quoteToken === null
    || typeof model !== "string"
    || capitalQuoteWei === null
    || capitalQuoteWei <= 0n
    || typeof brainEnabled !== "boolean"
    || !Array.isArray(rawUniverse)
    || settings === null
  ) return null;
  const universe: DemoTradeUniverseRow[] = [];
  for (const raw of rawUniverse) {
    if (!isRecord(raw)) return null;
    const rowAddress = address(raw["address"]);
    const symbol = raw["symbol"];
    if (rowAddress === null || typeof symbol !== "string") return null;
    universe.push({ address: rowAddress, symbol });
  }
  return { quoteToken, model, universe, settings, capitalQuoteWei, brainEnabled };
}

function parseTradeSettings(value: unknown): DemoTradeSettings | null {
  if (!isRecord(value)) return null;
  const buySizeQuoteWei = big(value["buySizeQuoteWei"]);
  const maxOpenPositions = int(value["maxOpenPositions"]);
  if (buySizeQuoteWei === null || buySizeQuoteWei <= 0n) return null;
  if (maxOpenPositions === null || maxOpenPositions <= 0) return null;
  const stopLossBps = nullableInt(value["stopLossBps"]);
  const takeProfitBps = nullableInt(value["takeProfitBps"]);
  const maxHoldSec = nullableInt(value["maxHoldSec"]);
  if (stopLossBps === undefined || takeProfitBps === undefined || maxHoldSec === undefined) {
    return null;
  }
  return { buySizeQuoteWei, maxOpenPositions, stopLossBps, takeProfitBps, maxHoldSec };
}

/** `undefined` means invalid; `null` is a legitimate "the owner left it blank". */
function nullableInt(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = int(value);
  return parsed === null ? undefined : parsed;
}

export function parseDemoTradeState(value: unknown): DemoTradeState | null {
  if (!isRecord(value) || value["kind"] !== "trade") return null;
  const cashQuoteWei = big(value["cashQuoteWei"]);
  const realisedQuoteWei = big(value["realisedQuoteWei"]);
  const costQuoteWei = big(value["costQuoteWei"]);
  const trades = int(value["trades"]);
  const rawPositions = value["positions"];
  if (
    cashQuoteWei === null
    || realisedQuoteWei === null
    || costQuoteWei === null
    || trades === null
    || !Array.isArray(rawPositions)
  ) return null;
  const positions: DemoTradeState["positions"][number][] = [];
  for (const raw of rawPositions) {
    if (!isRecord(raw)) return null;
    const token = address(raw["token"]);
    const symbol = raw["symbol"];
    const baseWei = big(raw["baseWei"]);
    const entryQuoteWei = big(raw["entryQuoteWei"]);
    const openedAtMs = int(raw["openedAtMs"]);
    if (
      token === null
      || typeof symbol !== "string"
      || baseWei === null
      || entryQuoteWei === null
      || openedAtMs === null
    ) return null;
    positions.push({ token, symbol, baseWei, entryQuoteWei, openedAtMs });
  }
  return { cashQuoteWei, positions, realisedQuoteWei, costQuoteWei, trades };
}

export function serialiseTradeFill(fill: DemoTradeFill): Readonly<Record<string, unknown>> {
  return {
    side: fill.side,
    token: fill.token,
    symbol: fill.symbol,
    quoteWei: fill.quoteWei,
    baseWei: fill.baseWei,
    pnlBps: fill.pnlBps,
    pnlQuoteWei: fill.pnlQuoteWei,
    reason: fill.reason,
  };
}
