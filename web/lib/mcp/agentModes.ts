/**
 * Per-mode blocks of the public MCP `agent_status` (hotfix 2026-10-07).
 *
 * Every block is an explicit field allowlist over the execution plane's public Agentic view (`src/agentic/publicView.ts`):
 * a plane object is never passed through whole, so a field the plane adds later stays out until it is mapped here. Strings the
 * hirer or the chain chose go through `sanitizeSymbol`; words (states, causes) must match a closed shape; numbers are finite
 * numbers. No events, runs, model reasons, CMC log, transaction hashes or internal ids (decision ids, idempotency keys, refs).
 *
 * Money is shown twice: the raw plane value (`...Wei`, `...Atomic`) and a human decimal string next to it. 18-decimal USDT values
 * get a `...Usdt` string with two decimals; token quantities are plain decimals with six significant digits (integers are kept
 * whole); E8 prices (raw-unit USDT x 1e8, USDT per share) get four decimals.
 */
import { sanitizeSymbol } from "./sanitize";

type Json = Record<string, unknown>;

const rec = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const INT = /^-?\d{1,60}$/u;
const WORD = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const word = (v: unknown): string | null => (typeof v === "string" && WORD.test(v) ? v : null);
const address = (v: unknown): string | null => (typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : null);
const symbol = (v: unknown): string | null => (typeof v === "string" ? sanitizeSymbol(v) : null);
const intString = (v: unknown): string | null => (typeof v === "string" && INT.test(v) ? v : null);
const big = (v: unknown): bigint | null => { const s = intString(v); return s === null ? null : BigInt(s); };

/** `value` (an integer in 10^-decimals units) as a decimal with exactly `places` places, rounded half away from zero. */
function fixed(value: bigint, decimals: number, places: number): string {
  const negative = value < 0n, abs = negative ? -value : value;
  let scaled: bigint;
  if (decimals > places) { const divisor = 10n ** BigInt(decimals - places); scaled = (abs + divisor / 2n) / divisor; }
  else scaled = abs * 10n ** BigInt(places - decimals);
  const digits = scaled.toString().padStart(places + 1, "0");
  const text = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return negative && scaled !== 0n ? `-${text}` : text;
}

const decimalsOf = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 36 ? v : 18);

/** An 18-decimal USDT amount (a raw integer string) as a two-decimal string; null when it is not an integer string. */
export function usdtText(v: unknown): string | null {
  const b = big(v);
  return b === null ? null : fixed(b, 18, 2);
}

/** A token quantity (a raw integer string) as a plain decimal with six significant digits, trailing zeros trimmed. */
export function quantityText(v: unknown, decimals: number = 18): string | null {
  const b = big(v);
  if (b === null) return null;
  const abs = b < 0n ? -b : b;
  if (abs === 0n) return "0";
  const exponent = abs.toString().length - decimals - 1;
  const places = Math.min(decimals, Math.max(0, 5 - exponent));
  const text = fixed(b, decimals, places);
  return text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;
}

/** An E8 price (raw-unit USDT x 1e8, which is USDT per share for an 18-decimal stock) as a four-decimal string. */
export function priceText(v: unknown): string | null {
  const b = big(v);
  return b === null ? null : fixed(b, 8, 4);
}

/** The raw string and its two-decimal USDT companion, as two fields. */
function money(name: string, v: unknown): Json {
  const wei = intString(v);
  return { [`${name}Wei`]: wei, [`${name}Usdt`]: usdtText(wei) };
}
function amount(name: string, v: unknown, decimals: number = 18): Json {
  const atomic = intString(v);
  return { [`${name}Atomic`]: atomic, [name]: quantityText(atomic, decimals) };
}
const price = (name: string, v: unknown): Json => ({ [name]: priceText(v) });

/** USDT per share of a holding: value (18-decimal USDT) over quantity (token decimals), four decimals; null on a zero quantity. */
function perShare(valueWei: bigint, quantityAtomic: bigint, decimals: number): string | null {
  return quantityAtomic <= 0n ? null : fixed(valueWei * 10n ** BigInt(decimals) / quantityAtomic, 18, 4);
}

// ------------------------------------------------------------------ schedule

export function scheduleBlock(block: unknown): Json | null {
  const s = rec(block);
  if (s === null) return null;
  const decimals = decimalsOf(s["decimals"]);
  const holding = rec(s["holding"]);
  const bought = big(holding?.["boughtAtomic"]), spent = big(holding?.["verifiedSpentWei"]), valueWei = big(holding?.["quoteWei"]), balance = big(holding?.["walletBalance"]);
  const verifiedFills = num(holding?.["verifiedFills"]);
  const basisKnown = bought !== null && spent !== null && verifiedFills !== null && verifiedFills > 0;
  return {
    symbol: symbol(s["symbol"]),
    token: address(s["token"]),
    ...money("amount", s["amountWei"]),
    intervalSec: num(s["intervalSec"]),
    firstAtSec: num(s["firstAtSec"]),
    nextDueAtMs: num(s["nextDueAtMs"]),
    currentSlot: num(s["currentSlot"]),
    currentSlotTaken: bool(s["currentSlotTaken"]),
    plannedBuys: num(s["plannedBuys"]),
    doneBuys: num(s["fills"]),
    postponedBuys: num(s["postponed"]),
    buysThisSession: num(s["buysThisSession"]),
    ...money("spent", s["spentWei"]),
    ...money("remaining", s["remainingWei"]),
    finished: word(s["finished"]),
    endKind: word(s["endKind"]),
    endAtSec: num(s["endAtSec"]),
    endRuns: num(s["endRuns"]),
    marketHoursOnly: bool(s["marketHoursOnly"]),
    premiumBps: num(s["premiumBps"]),
    maxPremiumBps: num(s["maxPremiumBps"]),
    ...amount("gasBnb", s["nativeBalanceWei"]),
    sessionExpiresAtSec: num(s["sessionExpiresAtSec"]),
    holding: holding === null ? null : {
      ...amount("quantity", holding["walletBalance"], decimals),
      ...money("value", holding["quoteWei"]),
      ...money("verifiedSpent", holding["verifiedSpentWei"]),
      ...amount("boughtQuantity", holding["boughtAtomic"], decimals),
      verifiedFills,
      averageCostUsdt: basisKnown && bought > 0n ? perShare(spent, bought, decimals) : null,
      marketPriceUsdt: valueWei !== null && balance !== null ? perShare(valueWei, balance, decimals) : null,
      ...(valueWei !== null && spent !== null && basisKnown ? money("pnl", (valueWei - spent).toString()) : { pnlWei: null, pnlUsdt: null }),
      valueReason: word(holding["quoteReason"]),
    },
  };
}

// ----------------------------------------------------------------- portfolio

const MAX_STOCKS = 5;
const MAX_LEGS = 5;

export function portfolioBlock(block: unknown): Json | null {
  const p = rec(block);
  if (p === null) return null;
  const check = rec(p["check"]);
  return {
    stocks: arr(p["tokens"]).map(rec).filter((t): t is Json => t !== null).slice(0, MAX_STOCKS).map((t) => {
      const initial = rec(t["initial"]);
      return {
        symbol: symbol(t["symbol"]),
        token: address(t["token"]),
        targetBps: num(t["targetBps"]),
        weightBps: num(t["weightBps"]),
        driftBps: num(t["driftBps"]),
        ...amount("quantity", t["balanceAtomic"]),
        ...money("value", t["valueWei"]),
        valueReason: word(t["valueReason"]),
        ...money("entryCost", initial?.["quoteWei"]),
      };
    }),
    ...money("capitalQuote", p["capitalQuoteWei"]),
    ...money("netInvested", p["netInvestedWei"]),
    ...money("stockValue", p["stockValueWei"]),
    ...money("totalValue", p["totalValueWei"]),
    ...money("pnl", p["pnlWei"]),
    ...money("cash", p["portfolioCashWei"]),
    ...money("idle", p["idleUsdtWei"]),
    driftBps: num(p["driftBps"]),
    intervalSec: num(p["intervalSec"]),
    currentSlot: num(p["currentSlot"]),
    nextCheckAtMs: num(p["nextCheckAtMs"]),
    check: check === null ? null : { slot: num(check["slot"]), state: word(check["state"]), maxDriftBps: num(check["maxDriftBps"]), ...money("value", check["valueWei"]), checkedAtMs: num(check["checkedAt"]) },
    recentLegs: arr(p["legs"]).map(rec).filter((l): l is Json => l !== null).slice(0, MAX_LEGS).map((l) => {
      const detail = rec(l["detail"]);
      const buy = l["side"] === "buy";
      return {
        slot: num(l["slot"]),
        side: l["side"] === "buy" || l["side"] === "sell" ? l["side"] : null,
        symbol: symbol(l["symbol"]),
        state: word(l["state"]),
        executionState: word(detail?.["executionState"]),
        createdAtMs: num(l["createdAt"]),
        ...(buy ? money("planned", l["amountWei"]) : amount("plannedQuantity", l["amountWei"])),
        ...amount("quantity", detail?.["quantityAtomic"]),
        ...money("value", detail?.["quoteWei"]),
      };
    }),
  };
}

// ----------------------------------------------------------------------- dca

const MAX_LEVELS = 8;
const LEVEL_STATES = ["pending", "resting", "filled", "held", "cancelled", "skipped", "below-range"] as const;
const levelState = (v: unknown): string | null => (typeof v === "string" && (LEVEL_STATES as readonly string[]).includes(v) ? v : null);

export function dcaBlock(block: unknown, capitalQuoteWei: unknown): Json | null {
  const d = rec(block);
  if (d === null) return null;
  const mark = rec(d["mark"]), settings = rec(d["settings"]), round = rec(d["round"]), rounds = rec(d["rounds"]), equity = rec(d["equity"]), wallet = rec(d["wallet"]);
  const markE8 = big(mark?.["e8"]);
  const held = big(round?.["stockHeldWei"]) ?? (round === null ? big(wallet?.["stockWei"]) : null);
  const heldValue = held !== null && markE8 !== null ? (held * markE8 / 100_000_000n).toString() : null;
  const capital = big(capitalQuoteWei);
  const phase = word(round?.["phase"]);
  const realized = intString(rounds?.["realizedPnlWei"]), marked = intString(rounds?.["markedPnlWei"]);
  // The public page's rule: live equity less the deposit; with no open round the marked (else realised) total; otherwise no number.
  let pnl: string | null = null;
  const equityWei = big(equity?.["equityWei"]);
  if (equityWei !== null && capital !== null) pnl = (equityWei - capital).toString();
  else if (equity === null && (round === null || phase === "settled")) pnl = marked ?? realized;
  const tp = rec(round?.["tp"]);
  return {
    symbol: symbol(d["symbol"]),
    token: address(d["token"]),
    reason: word(d["reason"]),
    heldOrders: num(d["heldOrders"]),
    ...price("markPriceUsdt", mark?.["e8"]),
    settings: settings === null ? null : {
      stepBps: num(settings["stepBps"]),
      takeProfitBps: num(settings["takeProfitBps"]),
      ...money("base", settings["baseWei"]),
      ...money("order", settings["orderWei"]),
      maxOrders: num(settings["maxOrders"]),
      stopLossBps: num(settings["stopLossBps"]),
      ...price("triggerPriceUsdt", settings["triggerE8"]),
      ...price("rangeMinPriceUsdt", settings["rangeMinE8"]),
      ...price("rangeMaxPriceUsdt", settings["rangeMaxE8"]),
    },
    round: round === null ? null : {
      roundNo: num(round["roundNo"]),
      phase,
      closeCause: word(round["closeCause"]),
      openedAtMs: num(round["openedAt"]),
      ...price("startPriceUsdt", round["p0E8"]),
      ...price("averagePriceUsdt", round["avgCostE8"]),
      ...price("takeProfitPriceUsdt", round["tpTargetE8"]),
      ...money("cost", round["costUsdtWei"]),
      ...money("realizedPnl", round["realizedPnlWei"]),
      levels: arr(round["levels"]).map(rec).filter((l): l is Json => l !== null).slice(0, MAX_LEVELS).map((l) => ({
        levelNo: num(l["levelNo"]),
        state: levelState(l["state"]),
        ...price("priceUsdt", l["priceE8"] ?? l["levelPriceE8"]),
        ...money("size", l["usdtWei"]),
        ...amount("filledQuantity", l["stockWei"]),
      })),
      takeProfit: tp === null ? null : { state: levelState(tp["state"]), ...price("priceUsdt", tp["priceE8"]) },
    },
    rounds: rounds === null ? null : { settled: num(rounds["settled"]), ...money("realizedPnl", rounds["realizedPnlWei"]), ...money("markedPnl", rounds["markedPnlWei"]) },
    holding: { ...amount("quantity", held === null ? null : held.toString()), ...money("value", heldValue), ...money("wallet", wallet?.["usdtWei"]) },
    ...money("pnlSinceHire", pnl),
    ...money("equity", equity?.["equityWei"]),
    ...money("stopLine", equity?.["stopAtWei"]),
  };
}

// ---------------------------------------------------------------------- earn

export function earnBlock(block: unknown): Json | null {
  const e = rec(block);
  if (e === null) return null;
  return {
    ...money("total", e["totalWei"]),
    ...money("liquid", e["liquidWei"]),
    ...money("earned", e["earnedWei"]),
    withdrawingBeforeSignOut: bool(e["withdrawingBeforeSignOut"]),
  };
}

export { money };
