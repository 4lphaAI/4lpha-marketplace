/**
 * AGENTIC-MEME-STOCKS-SPEC section 6: the meme brain, pure functions shared by both phases. Bars use JS numbers (ratios and USD floors); money uses bigint
 * atomic USDT (18 decimals) and integer bps.
 */
import type { Address } from "viem";
import { USDT_56 } from "../trade/settlement.js";
import type { MemeBar, MemeShortlistRow } from "./memeData.js";
import { rowFresh } from "./memeData.js";

export const MEME_STOP_BPS = 3_000;
/** Operator 2026-10-09 (second ruling, option B): armed at net +20 % with a fixed 1 500 bps giveback, so a +20 % peak sells at +5 %; was +10 % with max(500, 30 % of peak). */
export const MEME_TRAIL_ARM_BPS = 2_000;
export const MEME_TRAIL_GIVEBACK_BPS = 1_500;
export const MEME_MAX_HOLD_MS = 14_400_000;
export const MEME_MIN_CONFIDENCE = 75;
/** F7 gas per side in BNB wei: graduated (pancake-v2), the Flap curve (flap-bonding) and the Four.meme curve (fourmeme-bonding, FOURMEME-CURVE-PAPER-SPEC F6: step-0 p90, sell incl. the 5.6e12 approve); a sell includes its exact approve. */
export const MEME_GAS_WEI = { "pancake-v2": { buy: 56_500_000_000_000n, sell: 70_500_000_000_000n }, "flap-bonding": { buy: 84_400_000_000_000n, sell: 113_500_000_000_000n },
  "fourmeme-bonding": { buy: 130_600_000_000_000n, sell: 125_900_000_000_000n } } as const;
export type MemeVenue = keyof typeof MEME_GAS_WEI;
/** A venue the brain prices: graduated or the Four.meme curve as the row says, else the Flap curve (an unknown venue takes the dearer Flap curve costs). */
export const memeVenue = (venue: string | null): MemeVenue => venue === "pancake-v2" || venue === "fourmeme-bonding" ? venue : "flap-bonding";
/** FC3: the Binance quote omits the token tax everywhere except on the Flap curve (meme spec F2; FOURMEME-CURVE-STEP0 S6). */
export const memeQuoteOmitsTax = (venue: MemeVenue): boolean => venue !== "flap-bonding";

/* ---------------------------------------------------------------- 6.1 screen ---------------------------------------------------------------- */

/** 6.1 item 5 (review M9): integers only. `liqCapWei = round(liquidityUsd x 100) x 10^16 x 50 / 10 000` (0.50 %, operator hotfix 2026-10-06; was 0.20 %). */
export function memeLiqCapWei(liquidityUsd: number | null): bigint | null {
  if (liquidityUsd === null || !Number.isFinite(liquidityUsd) || liquidityUsd <= 0) return null;
  return BigInt(Math.round(liquidityUsd * 100)) * 10n ** 16n * 50n / 10_000n;
}

/** 6.1 items 1, 2, 3 and 5 (agent-independent: every meme hire has the same 10 USDT minimum) plus the 5.1 row freshness; the first failing code, or null. */
export function memeScreenShared(row: MemeShortlistRow, input: { bstocks: ReadonlySet<string>; minEntryWei: bigint; nowMs: number }): string | null {
  if (row.launchpad !== "flap" && row.launchpad !== "fourmeme") return "launchpad";
  // FOURMEME-CURVE-PAPER-SPEC F8: Four.meme in paper, graduated (Pancake V2) or on its curve; an unread or other venue is never assumed.
  if (row.launchpad === "fourmeme" && row.venue !== "pancake-v2" && row.venue !== "fourmeme-bonding") return "fourmeme-venue";
  if (row.quote.kind !== "bstock" || row.quote.address === null) return "quote-kind";
  if (row.quote.openState !== true) return "quote-halted";
  // F7 (operator O6): the board's offers-based label does not apply to a Four.meme curve row; the eligibility funds rule is its only graduation guard.
  if (row.stage === "graduating" && !(row.launchpad === "fourmeme" && row.venue === "fourmeme-bonding")) return "graduating";
  if (row.flags.some(flag => flag === "churn" || flag === "wash_trading" || flag === "smart_exit")) return "flag";
  if (row.flow5m === null) return "flow-unknown";
  if (row.tax === null) return "tax-unknown";
  if (row.address === USDT_56.toLowerCase()) return "usdt";
  if (row.address === row.quote.address) return "quote-token";
  if (input.bstocks.has(row.address)) return "bstock";
  const cap = memeLiqCapWei(row.liquidityUsd);
  if (cap === null || cap < input.minEntryWei) return "liquidity";
  if (!rowFresh(row, input.nowMs)) return "stale";
  return null;
}

/** 6.1 item 4 (per agent): not held, no closed position within 180 min, no quote refusal within 30 min. */
export function memeScreenAgent(token: Address, input: { held: ReadonlySet<string>; cooledDown: ReadonlySet<string>; refused: ReadonlySet<string> }): string | null {
  const key = token.toLowerCase();
  return input.held.has(key) ? "held" : input.cooledDown.has(key) ? "cooldown" : input.refused.has(key) ? "refused-recently" : null;
}

/* ---------------------------------------------------------------- 6.2 dead chart ---------------------------------------------------------------- */

export type MemeDeadChart = { drawdown60: number; decay: number; lowerHighs10: number; lowerLows10: number; flatline: number; minutesSinceHigh: number;
  impulseFailure: boolean; failedBounces: number; belowVwap: boolean; greenRatio: number; deadScore: number; hardVeto: boolean };
const roundPercent = (value: number): number => Math.round(value * 10) / 10;
const roundRatio = (numerator: number, denominator: number): number => denominator <= 0 ? numerator > 0 ? 1 : 0 : Math.round(numerator / denominator * 100) / 100;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const sumVolume = (bars: readonly MemeBar[]): number => bars.reduce((sum, bar) => sum + bar.volume, 0);
function lowerMoves(bars: readonly MemeBar[], field: "high" | "low"): number {
  let count = 0;
  for (let i = 1; i < bars.length; i += 1) if (bars[i]![field] < bars[i - 1]![field]) count += 1;
  return count;
}
function failedBounces(bars: readonly MemeBar[]): number {
  let count = 0;
  for (let i = 2; i < bars.length - 2; i += 1) {
    const previous = bars[i - 1]!, current = bars[i]!, next = bars[i + 1]!, after = bars[i + 2]!;
    if (previous.close < previous.open && current.close > current.open && current.close > previous.close && next.close < current.close && after.close <= current.open) count += 1;
  }
  return count;
}
function vwap(bars: readonly MemeBar[]): number {
  let weighted = 0, volume = 0;
  for (const bar of bars) { weighted += bar.close * bar.volume; volume += bar.volume; }
  return volume <= 0 ? bars.at(-1)?.close ?? 0 : weighted / volume;
}

/** 6.2: port of 4alpha's `deriveChartState` (`D:\4alpha\lib\agents\marketState.ts:289-393`), thresholds and weights unchanged; a `filled` bar counts as flat. */
export function memeDeadChart(all: readonly MemeBar[]): MemeDeadChart {
  const recent60 = all.slice(-60), recent20 = all.slice(-20), recent10 = all.slice(-10), previous30 = all.slice(-40, -10);
  const last = all.at(-1)!, lastClose = last.close;
  let high = 0, highAt = last.startMs;
  for (const bar of recent60) if (bar.high >= high) { high = bar.high; highAt = bar.startMs; }
  const drawdown60 = high > 0 && lastClose > 0 ? roundPercent((high - lastClose) / high * 100) : 0;
  const minutesSinceHigh = Math.max(0, Math.floor((last.startMs - highAt) / 60_000));
  const decay = roundRatio(sumVolume(recent10), sumVolume(previous30));
  const lowerHighs10 = lowerMoves(recent10, "high"), lowerLows10 = lowerMoves(recent10, "low");
  const greenRatio = roundRatio(recent10.filter(bar => bar.close > bar.open).length, Math.max(recent10.length, 1));
  const baseline = previous30.length > 0 ? sumVolume(previous30) / previous30.length : 0;
  let flatline = 0;
  for (let i = recent10.length - 1; i >= 0; i -= 1) {
    const bar = recent10[i]!;
    if (bar.filled || (bar.high - bar.low) / Math.max(bar.close, bar.open, 1e-9) <= 0.012 && bar.volume <= 0.25 * baseline) flatline += 1; else break;
  }
  const bounces = failedBounces(recent20), belowVwap = lastClose > 0 && recent20.length > 0 && lastClose < vwap(recent20);
  const impulseFailure = drawdown60 >= 50 && minutesSinceHigh <= 45 && decay <= 0.35;
  const score = clamp(drawdown60 * 0.42, 0, 30) + clamp((1 - Math.min(decay, 1)) * 22, 0, 22) + clamp(lowerHighs10 * 4.5, 0, 18) + clamp(lowerLows10 * 3.5, 0, 14)
    + clamp(flatline * 2.5, 0, 20) + clamp(bounces * 4, 0, 12) + (belowVwap ? 8 : 0) + (impulseFailure ? 10 : 0) + (greenRatio <= 0.3 ? 6 : 0);
  const hardVeto = drawdown60 >= 65 && decay <= 0.2 && lowerHighs10 >= 3 || impulseFailure && drawdown60 >= 55 && lowerLows10 >= 3 || flatline >= 10;
  return { drawdown60, decay, lowerHighs10, lowerLows10, flatline, minutesSinceHigh, impulseFailure, failedBounces: bounces, belowVwap, greenRatio,
    deadScore: roundPercent(clamp(score, 0, 100)), hardVeto };
}
/** The entry veto (6.2): `hardVeto || deadScore >= 70`. Exit X3 uses `hardVeto` alone. */
export const memeDeadVeto = (dead: Pick<MemeDeadChart, "hardVeto" | "deadScore">): boolean => dead.hardVeto || dead.deadScore >= 70;

/* ---------------------------------------------------------------- 6.3 burst and follow-through ---------------------------------------------------------------- */

export type MemeBurst = { offset: 1 | 2 | null; burstRatio: number | null; followRatio: number | null; extensionPct: number | null;
  /** null when a burst passed; else why the furthest offset stopped. */ reason: "silent-base" | "volume" | "red" | "follow-volume" | "follow-price" | "extended" | null };
const STAGE: Readonly<Record<string, number>> = { "silent-base": 1, volume: 1, red: 1, "follow-volume": 2, "follow-price": 2, extended: 3 };
/** 6.3 on at least MEME_MIN_BARS (8) bars: for t in [L-1, L-2] (first passing wins). The metrics are those of the passing offset, or of the furthest-reaching failed one (ties: L-1). */
export function memeBurst(bars: readonly MemeBar[]): MemeBurst {
  const L = bars.length - 1;
  let best: MemeBurst | null = null;
  for (const offset of [1, 2] as const) {
    const t = L - offset, window = bars.slice(t - 5, t), base = sumVolume(window) / 5, bar = bars[t]!;
    const burstRatio = base > 0 ? bar.volume / base : null;
    const follow = bars.slice(t + 1, L + 1), followRatio = base > 0 ? Math.min(...follow.map(b => b.volume)) / base : null;
    const previousClose = bars[t - 1]!.close, extensionPct = previousClose > 0 ? (bars[L]!.close / previousClose - 1) * 100 : null;
    const reason: MemeBurst["reason"] = window.every(b => b.filled) ? "silent-base" : bar.volume < Math.max(3 * base, 500) ? "volume" : bar.close <= bar.open ? "red"
      : follow.some(b => b.volume < Math.max(1.5 * base, 250)) ? "follow-volume" : bars[L]!.close < bar.close ? "follow-price"
      : bars[L]!.close > 1.6 * previousClose ? "extended" : null;
    const result: MemeBurst = { offset: reason === null ? offset : null, burstRatio, followRatio, extensionPct, reason };
    if (reason === null) return result;
    if (best === null || STAGE[reason]! > STAGE[best.reason!]!) best = result;
  }
  return best!;
}
export const memeBurstVerdict = (reason: MemeBurst["reason"]): "no-burst" | "no-follow-through" | "extended" | null =>
  reason === null ? null : STAGE[reason] === 1 ? "no-burst" : STAGE[reason] === 2 ? "no-follow-through" : "extended";

/* ---------------------------------------------------------------- 6.4 pressure and smart money ---------------------------------------------------------------- */

/** 6.4: buys >= 2 x sells over 5 minutes; a ranked 5m net outflow or a ranked 1h net <= -250 USD vetoes; unranked is neutral. */
export function memePressure(row: Pick<MemeShortlistRow, "flow5m" | "smartInflow5m" | "smartInflow1h">): "pressure" | "smart-veto" | null {
  if (row.flow5m === null || row.flow5m.buys < 2 * row.flow5m.sells) return "pressure";
  if (row.smartInflow5m !== null && row.smartInflow5m.netUsd < 0 || row.smartInflow1h !== null && row.smartInflow1h.netUsd <= -250) return "smart-veto";
  return null;
}

/* ---------------------------------------------------------------- 6.5 / 7.1 cost ---------------------------------------------------------------- */

/** 6.5: the range of the last 15 bars (all of them on a token younger than 15 minutes) in bps of its low; null when the low is zero. */
export function memeRange15Bps(bars: readonly MemeBar[]): number | null {
  const window = bars.slice(-15), low = Math.min(...window.map(b => b.low)), high = Math.max(...window.map(b => b.high));
  return low > 0 ? Math.floor((high - low) / low * 10_000) : null;
}
/** Gas in bps of A, rounded half up. */
export const memeGasBps = (gasUsdtAtomic: bigint, amountWei: bigint): number => Number((gasUsdtAtomic * 20_000n + amountWei) / (2n * amountWei));
/** 7.1: `C_est = 100 + venueFee + buyTax + sellTax + impact + gasBps`; null when the taxes or the liquidity are unknown (the cost rule then refuses). */
export function memeCostEstBps(input: { venue: string | null; tax: { buyBps: number; sellBps: number } | null; liquidityUsd: number | null; amountWei: bigint; gasRoundTripUsdtAtomic: bigint }): number | null {
  if (input.tax === null || input.liquidityUsd === null || !(input.liquidityUsd > 0)) return null;
  const venueFee = memeVenue(input.venue) === "pancake-v2" ? 50 : 200;
  const impact = Math.ceil(4 * (Number(input.amountWei) / 1e18) / input.liquidityUsd * 10_000);
  return 100 + venueFee + input.tax.buyBps + input.tax.sellBps + impact + memeGasBps(input.gasRoundTripUsdtAtomic, input.amountWei);
}
/** 6.5: `range15 >= 2 x C`. */
export const memeCostRuleOk = (range15: number | null, costBps: number | null): boolean => range15 !== null && costBps !== null && range15 >= 2 * costBps;

/* ---------------------------------------------------------------- 6.6 exits ---------------------------------------------------------------- */

/** 6.6: `PnL = floor((S_mark - E) x 10 000 / E)` bps. */
export const memePnlBps = (sMark: bigint, basis: bigint): number => { const d = (sMark - basis) * 10_000n; return Number(d >= 0n ? d / basis : -((-d + basis - 1n) / basis)); };
/** 6.6: `S_mark = M x (10 000 - markUnnet) / 10 000`, markUnnet = 0 on the Flap curve (its quote carries the tax), else the sell tax. */
export const memeSMark = (gross: bigint, venue: MemeVenue, sellTaxBps: number): bigint => gross * BigInt(10_000 - (memeQuoteOmitsTax(venue) ? sellTaxBps : 0)) / 10_000n;
/** FOURMEME-CURVE-PAPER-SPEC 6.3 / FC2: funds raised below 80 % of the curve's `maxFunds`; a missing, malformed or zero value refuses (FC4). */
export const MEME_FOURMEME_MAX_FUNDS_PCT = 80n;
export const memeCurveFundsOk = (fm: { funds: bigint | null; maxFunds: bigint | null }): boolean => fm.funds !== null && fm.maxFunds !== null && fm.maxFunds > 0n
  && fm.funds * 100n < fm.maxFunds * MEME_FOURMEME_MAX_FUNDS_PCT;
export type MemeExitInput = { drain: boolean; pnlBps: number; peakBps: number; costBps: number; ageMs: number;
  /** X3: dead-chart hardVeto on exit-fresh bars; null when the bars are missing or stale (skipped). */ hardVeto: boolean | null;
  /** X4 / X6: the fresh board row of the held token; null when missing or stale (skipped). */ board: { status: string; flags: readonly string[]; inflow5mNetUsd: number | null; flow5m: { buys: number; sells: number } | null } | null };
export type MemeExitCode = "drain" | "stop" | "dead-chart" | "smart-out" | "trailing" | "flow-flip" | "time";
/** 6.6, first match: X1, X2, X3, X4, X5, X6, X8 (X7 dropped by ruling D5). */
export function memeExit(x: MemeExitInput): MemeExitCode | null {
  if (x.drain) return "drain";
  if (x.pnlBps + x.costBps <= -MEME_STOP_BPS) return "stop";
  if (x.hardVeto === true) return "dead-chart";
  if (x.board !== null && x.board.status === "dead") return "dead-chart";
  if (x.board !== null && (x.board.flags.includes("smart_exit") || x.board.inflow5mNetUsd !== null && x.board.inflow5mNetUsd <= -100)) return "smart-out";
  if (x.peakBps >= MEME_TRAIL_ARM_BPS && x.pnlBps <= x.peakBps - MEME_TRAIL_GIVEBACK_BPS) return "trailing";
  if (x.board !== null && x.board.flow5m !== null && x.board.flow5m.sells > x.board.flow5m.buys && x.pnlBps < 0) return "flow-flip";
  if (x.ageMs >= MEME_MAX_HOLD_MS) return "time";
  return null;
}

/* ---------------------------------------------------------------- 6.7 LLM arbitration ---------------------------------------------------------------- */

const CATEGORIES: ReadonlySet<string> = new Set(["daily_runner", "long_runner", "bluechip", "other"]);
const PROMPT_FLAGS = ["dev_sold_all", "clone", "sniper_heavy", "bundler_heavy", "top10_heavy", "smart_money", "kol", "whale"] as const;
export type MemeLlmCandidate = { row: MemeShortlistRow; burst: MemeBurst; dead: MemeDeadChart; costBps: number; barLagMs: number; buyTaxBps: number; sellTaxBps: number };
/** The entry doctrine, shared by the LLM system prompt and the Jev questions (memeJev.ts). */
export const MEME_DOCTRINE = "buy a volume burst with follow-through and buys over sells; never a dead chart; smart-money net inflow counts, outflow vetoes; exits are fast and deterministic.";
const SYSTEM = `You arbitrate entries for a meme-stock paper trading agent. Doctrine: ${MEME_DOCTRINE} Every candidate already passed the deterministic checks; answer buy_now, wait or reject per index. `
  + 'Answer only JSON: {"decisions":[{"index":0,"action":"buy_now","confidence":80}]} with action one of buy_now, wait, reject and confidence an integer 0..100.';
const round2 = (value: number | null): number | null => value === null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
/** What the state of one candidate needs; the bar-derived parts are null for a token the deterministic layers dropped before bars could judge it (the Jev scan, memeJev.ts). */
export type MemeStateCandidate = { row: MemeShortlistRow; burst: MemeBurst | null; dead: MemeDeadChart | null; costBps: number | null; barLagMs: number | null; buyTaxBps: number | null; sellTaxBps: number | null };
/** PA4: numbers and closed codes only; never a name, symbol, address, social, CMC or owner text. The one builder of a candidate's state, shared by the LLM prompt and the Jev requests. */
export function memeCandidateState(c: MemeStateCandidate, index: number) {
  const smart = (s: MemeShortlistRow["smartInflow5m"]) => s === null ? "unranked" : { netUsd: round2(s.netUsd), traders: s.traders };
  return { index,
    venue: memeVenue(c.row.venue) === "pancake-v2" ? "graduated" : "curve", category: c.row.category !== null && CATEGORIES.has(c.row.category) ? c.row.category : "none",
    ageMinutes: c.row.ageMinutes, liquidityUsd: round2(c.row.liquidityUsd), marketCapUsd: round2(c.row.marketCapUsd), holders: c.row.holders,
    volume5mUsd: round2(c.row.volume5mUsd), volume1hUsd: round2(c.row.volume1hUsd), txs5m: c.row.txs5m, priceChange5mPct: round2(c.row.priceChange5mPct), priceChange1hPct: round2(c.row.priceChange1hPct),
    flow5m: c.row.flow5m === null ? null : { buys: c.row.flow5m.buys, sells: c.row.flow5m.sells }, flow1h: c.row.flow1h === null ? null : { buys: c.row.flow1h.buys, sells: c.row.flow1h.sells },
    smartInflow5m: smart(c.row.smartInflow5m), smartInflow1h: smart(c.row.smartInflow1h),
    burstRatio: round2(c.burst?.burstRatio ?? null), followRatio: round2(c.burst?.followRatio ?? null), extensionPct: round2(c.burst?.extensionPct ?? null), drawdown60: c.dead?.drawdown60 ?? null, deadScore: c.dead?.deadScore ?? null,
    costBps: c.costBps, buyTaxBps: c.buyTaxBps, sellTaxBps: c.sellTaxBps, barLagMs: c.barLagMs, flags: PROMPT_FLAGS.filter(flag => c.row.flags.includes(flag)) };
}
/** PA4: numbers and closed codes only, re-indexed 0..k-1. */
export function memePrompt(candidates: readonly MemeLlmCandidate[]): { role: "system" | "user"; content: string }[] {
  return [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify({ candidates: candidates.map((c, index) => memeCandidateState(c, index)) }) }];
}
export type MemeLlmDecision = { index: number; action: "buy_now" | "wait" | "reject"; confidence: number };
/** PA4: exactly `{"decisions":[{"index","action","confidence"}]}`; anything else is null (no entry). Audit F-E: the only fence admitted is the trade lane's (`unwrapOptionalFence`, src/trade/llm.ts): ```json, a newline, the body, a newline, ```. */
export function parseMemeAnswer(raw: string, k: number): MemeLlmDecision[] | null {
  const trimmed = raw.trim(), body = !trimmed.startsWith("```") ? trimmed : /^```json\s*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)?.[1]?.trim() ?? null;
  let parsed: unknown;
  try { if (body === null) return null; parsed = JSON.parse(body); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray((parsed as Record<string, unknown>)["decisions"])) return null;
  const rows = (parsed as { decisions: unknown[] }).decisions, seen = new Set<number>(), out: MemeLlmDecision[] = [];
  if (rows.length < 1 || rows.length > k) return null;
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
    const r = row as Record<string, unknown>, keys = Object.keys(r).sort();
    if (keys.join(",") !== "action,confidence,index" || !Number.isInteger(r["index"]) || (r["index"] as number) < 0 || (r["index"] as number) >= k || seen.has(r["index"] as number)
      || !["buy_now", "wait", "reject"].includes(r["action"] as string) || !Number.isInteger(r["confidence"]) || (r["confidence"] as number) < 0 || (r["confidence"] as number) > 100) return null;
    seen.add(r["index"] as number);
    out.push({ index: r["index"] as number, action: r["action"] as MemeLlmDecision["action"], confidence: r["confidence"] as number });
  }
  return out;
}
/** 6.7: the highest-confidence buy_now at confidence >= 75, ties by index; null for none. */
export function memePick(decisions: readonly MemeLlmDecision[]): number | null {
  const buys = decisions.filter(d => d.action === "buy_now" && d.confidence >= MEME_MIN_CONFIDENCE).sort((a, b) => b.confidence - a.confidence || a.index - b.index);
  return buys[0]?.index ?? null;
}
