/**
 * AGENTIC-MEME-STOCKS-SPEC section 8: the paper meme lane. A paper hire never trades (PA1): the only Binance command this file runs is `market-order quote`,
 * under the wallet fence, and nothing here writes an order, an intent, a position or a journal row.
 */
import type { Address } from "viem";
import { USDT_56 } from "../trade/settlement.js";
import { WBNB_56 } from "../ops/venues.js";
import { freshNativeCostFacts, nativeCostToUsdtAtomic, type NativeCostFacts } from "../trade/cost.js";
import type { TokenBatchRow, UniverseRow } from "../trade/dataPlaneReads.js";
import type { TradeSettings } from "../trade/settings.js";
import type { TradeWorkerDeps } from "../trade/worker.js";
import type { TradePositionStore } from "../store/tradePositions.js";
import type { TradeRunEvent } from "../store/tradeRunTrace.js";
import { agenticAddress, agenticDecimal, agenticUiString, type AgenticMemeLog, type AgenticMemePaper, type AgenticWallet } from "./domain.js";
import { recordAgenticConnection, type AgenticExecutionDeps } from "./execute.js";
import { acquireAgenticFence } from "./obligations.js";
import { decryptAgenticSession, type AgenticStore } from "./store.js";
import type { AgenticChain } from "./resolve.js";
import { MEME_BARS_BATCH_MAX, MEME_MIN_BARS, barLagMs, barsEntryOk, barsEntryReason, barsExitOk, boardFresh, eligibilityFresh, memeRead, parseBars, parseBoardRow, parseEligibility,
  parseShortlist, rowFresh, shortlistFresh, type MemeBars, type MemeBoardRow, type MemeShortlist, type MemeShortlistRow } from "./memeData.js";
import { MEME_GAS_WEI, memeBurst, memeBurstVerdict, memeCostEstBps, memeCostRuleOk, memeDeadChart, memeDeadVeto, memeExit, memeGasBps, memeLiqCapWei, memePick, memePnlBps,
  memeCandidateState, memePressure, memePrompt, memeRange15Bps, memeScreenAgent, memeScreenShared, memeSMark, memeVenue, parseMemeAnswer, memeCurveFundsOk, memeQuoteOmitsTax,
  type MemeBurst, type MemeDeadChart, type MemeLlmDecision, type MemeVenue } from "./memeBrain.js";
import { askMemeJev, type MemeJevConfig, type MemeJevData } from "./memeJev.js";

/** The RFQ / DCA per-process throttle precedent: a SERVICE_UNAVAILABLE answer skips this agent's meme quotes for 300 000 ms. */
export const MEME_THROTTLE_MS = 300_000;
/** The seven non-transport names of the CLI error set (the RFQ helper's set): a quote refused under one of them is Binance refusing, not the network failing. */
const QUOTE_REFUSAL_NAMES: ReadonlySet<string> = new Set(["SERVICE_ERROR", "ORDER_API_ERROR", "APP_CONFIRMATION_REQUIRED", "INSUFFICIENT_BALANCE", "INSUFFICIENT_GAS", "INVALID_TOKEN", "INVALID_PARAMETER"]);
const THROTTLES = new WeakMap<AgenticStore, Map<string, number>>();
const throttleOf = (store: AgenticStore): Map<string, number> => { let map = THROTTLES.get(store); if (map === undefined) { map = new Map(); THROTTLES.set(store, map); } return map; };

export type MemeQuoteDeps = Pick<AgenticExecutionDeps, "store" | "runner" | "instance" | "masterKey">;
export type MemeQuoteResult = { ok: true; outAtomic: bigint; slippageBps: number | null; atMs: number } | { ok: false; code: string };

/** Binance's own slippage suggestion of a quote (a fraction such as 0.04) as bps; logged, never used to decide (8.1). */
function suggestionBps(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/u.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 10_000) : null;
}

/** 8.1: one free `market-order quote` for a meme hire, the RFQ helper's pattern without the multiplier (18-decimal tokens only, checked at entry). */
export async function memeQuote(deps: MemeQuoteDeps, input: { agentId: string; side: "buy" | "sell"; token: Address; amountAtomic: bigint }): Promise<MemeQuoteResult> {
  const { store } = deps, throttles = throttleOf(store);
  if ((throttles.get(input.agentId) ?? 0) > await store.now()) return { ok: false, code: "meme-throttled" };
  const row = await store.byAgent(input.agentId);
  if (row === null || row.state !== "bound" || row.walletAddress === null || row.sessionCiphertext === null) return { ok: false, code: "meme-unreachable" };
  const token = agenticAddress(input.token), usdt = agenticAddress(USDT_56), buy = input.side === "buy";
  let fence = await acquireAgenticFence(store, row.walletAddress, deps.instance.row.instanceId);
  if (fence === null) return { ok: false, code: "meme-wallet-busy" };
  try {
    const renewed = await store.renewFence(fence);
    if (renewed === null) return { ok: false, code: "meme-wallet-busy" };
    fence = renewed;
    const result = await deps.runner.run(["market-order", "quote", "--fromToken", buy ? usdt : token, "--toToken", buy ? token : usdt, "--fromTokenQty", agenticUiString(input.amountAtomic), "--binanceChainId", "56"],
      decryptAgenticSession(row, deps.masterKey));
    await recordAgenticConnection(store, input.agentId, result);
    const atMs = await store.now();
    if (result.kind === "cli-error") {
      if (result.name === "SERVICE_UNAVAILABLE") throttles.set(input.agentId, atMs + MEME_THROTTLE_MS);
      return { ok: false, code: QUOTE_REFUSAL_NAMES.has(result.name) ? `meme-refused:${result.name}` : "meme-unreachable" };
    }
    if (result.kind !== "ok" || typeof result.data !== "object" || result.data === null) return { ok: false, code: "meme-unreachable" };
    const data = result.data as Record<string, unknown>, out = agenticDecimal(data["toCoinAmount"]);
    return out === null || out <= 0n ? { ok: false, code: "meme-unparseable" } : { ok: true, outAtomic: out, slippageBps: suggestionBps(data["slippage"]), atMs };
  } finally { await store.releaseFence(fence); }
}

/* ======================================================================================================================================== */
/* 8.1 - 8.6: the paper step                                                                                                                 */
/* ======================================================================================================================================== */

/** PA5 (review R2-H1): the whole step; no new mark or entry sub-step starts past it, an in-flight one finishes. */
export const MEME_STEP_BUDGET_MS = 20_000;
/** Review R3-1: step 2 (the reads before the exit pass) starts no read past this, so a slow data plane never leaves the exit pass without its marks. */
export const MEME_MARKET_BUDGET_MS = 10_000;
export const MEME_MARKS_PER_CYCLE = 3;
export const MEME_LLM_TIMEOUT_MS = 8_000;
/** 8.1 step 4: no entry pass when the exit pass used this much. */
export const MEME_EXIT_PASS_ENTRY_LIMIT_MS = 10_000;
/** D4 / review M8. */
export const MEME_MAX_TOTAL_OPEN = 6;
export const MEME_MIN_ENTRY_WEI = 10n * 10n ** 18n;
/** 6.1 item 4: re-entry cooldown (4alpha `cooldownAfterLossMinutes 180`) and the quote-refusal cooldown (D13). */
export const MEME_REENTRY_COOLDOWN_MS = 10_800_000;
export const MEME_REFUSAL_COOLDOWN_MS = 1_800_000;
const DAY_MS = 86_400_000;
const E18 = 10n ** 18n;
/** 8.3: a curve past 80 % is about to graduate. Applied on the curve only: a graduated token reads progress 1e18 (measured, spec R1 archive line 57), so the rule as written would refuse every graduated meme (build note B-1). */
const MEME_MAX_PROGRESS = 800_000_000_000_000_000n;

export type MemeStepDeps = MemeQuoteDeps & {
  positions: Pick<TradePositionStore, "insertRun">; chain: Pick<AgenticChain, "metadata">; worker: Pick<TradeWorkerDeps, "dataPlane" | "llmFor" | "killswitch">;
  /** AGENTIC_MEME_STOCKS_ENABLED of this process: off stops entries only; exits and the close-out always run (9.5). */
  memeEnabled: boolean;
  /** 17 (R3.2): when the lane cycle started; its phase in the minute is logged on the cycle row. Absent: the step's own start. */
  cycleStartMs?: number;
  /** JEV-MEME-BENCHMARK-PLAN 3.2 / 3.3: set only when AGENTIC_MEME_JEV_SHADOW is exactly true and a key exists (memeJevConfig); absent, no Jev request is ever made. Measurement only. */
  jev?: MemeJevConfig;
};
export type MemeStepOptions = { dryRun?: boolean; reconciliationOnly?: boolean; cmcOnly?: boolean };
type Stage = TradeRunEvent["stage"];
type Event = { stage: Stage; code: string; elapsedMs: number; token?: string; model?: string; confidence?: number; reason?: string };
/** What a step decided; in a dry run it is everything the step would have written (8.6), and nothing was written. */
export type MemeReport = { code: string; events: Event[]; cycle: Record<string, unknown> | null; logs: AgenticMemeLog[]; paper: AgenticMemePaper[] };

/** The agent-independent work of one shortlist (8.1 step 2), shared by every meme agent of this process until the plane's `asOf` moves. */
type Evaluated = { row: MemeShortlistRow; verdict: string; bars: MemeBars | null; dead: MemeDeadChart | null; burst: MemeBurst | null; range15: number | null; cEst10: number | null };
type MarketCache = { asOf: number; shortlist: MemeShortlist; facts: NativeCostFacts | null; evaluated: Evaluated[]; bars: Map<string, MemeBars>; survivors61: number; barsRequested: number };
const CACHES = new WeakMap<AgenticStore, MarketCache>();
/** JEV-MEME-BENCHMARK-PLAN 3.3: per process and store, whether a scan is running and when each dropped token was last judged (and under which verdict). */
const JEV_SCANS = new WeakMap<AgenticStore, { inFlight: boolean; judged: Map<string, { atMs: number; verdict: string }> }>();
const JEV_SCAN_DUE_MS = 1_800_000;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
/** 7.2: exit gas at the BNB price stored on the position (USDT atomic per BNB), rounded up as `nativeCostToUsdtAtomic` does. */
const gasAt = (wei: bigint, bnbUsdtE18: bigint): bigint => (wei * bnbUsdtE18 + E18 - 1n) / E18;
const basisOf = (p: AgenticMemePaper): bigint => BigInt(p.entryUsdt) + BigInt(p.gasBuyUsdt);
/** 6.6 / M8: a position whose last mark is below 1 % of its basis neither counts toward maxOpenPositions nor is quoted more than once every 10 cycles. */
const rugged = (p: AgenticMemePaper): boolean => p.lastMarkUsdt !== null && BigInt(p.lastMarkUsdt) * 100n < basisOf(p);
const throttledMark = (p: AgenticMemePaper): boolean => rugged(p) && p.markSkips + 1 < 10;

function marketTuple(row: MemeShortlistRow, bstocks: ReadonlySet<string>): unknown[] {
  return [row.address, row.launchpad, row.stage, row.status, row.category, row.venue, row.tax?.buyBps ?? null, row.tax?.sellBps ?? null, row.liquidityUsd, row.priceUsd,
    row.volume5mUsd, row.txs5m, row.flow5m?.buys ?? null, row.flow5m?.sells ?? null, row.flow1h?.buys ?? null, row.flow1h?.sells ?? null,
    row.smartInflow5m?.netUsd ?? null, row.smartInflow5m?.rankedAt ?? null, row.smartInflow1h?.netUsd ?? null, row.smartInflow1h?.rankedAt ?? null,
    row.quote.address, row.quote.symbol, row.quote.openState, row.quote.address !== null && bstocks.has(row.quote.address), row.flags,
    // Operator hotfix 2026-10-06, measure only (no rule reads them): net USD inflow 5m and 1h and the 1h volume, for the USD pressure replay.
    row.flow5m?.inflowUsd ?? null, row.flow1h?.inflowUsd ?? null, row.volume1hUsd];
}
/** 8.6 brain tuple (review R2-H3); a row whose bars were not read carries its verdict only. Index 14 (operator 2026-10-07, log only): the failed bars entry rule, or null. */
function brainTuple(e: Evaluated, nowMs: number): unknown[] {
  if (e.bars === null) return [e.verdict];
  return [e.verdict, barLagMs(e.bars, nowMs), e.bars.lastClosedStartMs, e.bars.bars.length, e.bars.bars.at(-1)!.close, e.dead?.deadScore ?? null, e.dead?.hardVeto ?? null,
    e.burst?.offset ?? null, e.burst?.burstRatio ?? null, e.burst?.reason ?? null, e.burst?.followRatio ?? null, e.burst?.extensionPct ?? null, e.range15, e.cEst10,
    barsEntryReason(e.bars, nowMs)];
}
/** 6.2 - 6.4 on one row that passed the shared screen: the first failing agent-independent layer, or `pass`. */
function evaluate(row: MemeShortlistRow, bars: MemeBars | null, nowMs: number, facts: NativeCostFacts | null): Evaluated {
  if (bars === null) return { row, verdict: "bars-unavailable", bars: null, dead: null, burst: null, range15: null, cEst10: null };
  const long = bars.bars.length >= MEME_MIN_BARS, venue = memeVenue(row.venue);
  const dead = memeDeadChart(bars.bars), burst = long ? memeBurst(bars.bars) : null, range15 = long ? memeRange15Bps(bars.bars) : null;
  const gas = facts === null ? null : nativeCostToUsdtAtomic(MEME_GAS_WEI[venue].buy + MEME_GAS_WEI[venue].sell, facts);
  const cEst10 = gas === null ? null : memeCostEstBps({ venue: row.venue, tax: row.tax, liquidityUsd: row.liquidityUsd, amountWei: MEME_MIN_ENTRY_WEI, gasRoundTripUsdtAtomic: gas });
  const verdict = !barsEntryOk(bars, nowMs) ? "bars-unavailable" : memeDeadVeto(dead) ? "dead-chart" : memeBurstVerdict(burst!.reason) ?? memePressure(row) ?? "pass";
  return { row, verdict, bars, dead, burst, range15, cEst10 };
}

type Ctx = { deps: MemeStepDeps; options: MemeStepOptions; row: AgenticWallet; agentId: string; W: Address; s: TradeSettings; nowMs: number; startedAt: number;
  events: Event[]; logs: AgenticMemeLog[]; paperWrites: AgenticMemePaper[]; code: string | null; counts: Record<string, number>; budgetCut: boolean };
const elapsed = (ctx: Ctx): number => Date.now() - ctx.startedAt;
const note = (ctx: Ctx, stage: Stage, code: string, extra: Partial<Event> = {}): void => { ctx.events.push({ stage, code, elapsedMs: elapsed(ctx), ...extra }); };
const bump = (ctx: Ctx, key: string): void => { ctx.counts[key] = (ctx.counts[key] ?? 0) + 1; };
const setCode = (ctx: Ctx, code: string): void => { ctx.code ??= code; };
/** One `meme-budget` event per step, wherever the budget cut first. */
function cut(ctx: Ctx, reason: string): void {
  if (!ctx.budgetCut) note(ctx, "screen", "meme-budget", { reason });
  ctx.budgetCut = true;
}
/** PA5: true (and the cut recorded) once the whole-step budget is spent; no new sub-step starts. */
function overBudget(ctx: Ctx, reason: string): boolean {
  if (elapsed(ctx) < MEME_STEP_BUDGET_MS) return false;
  cut(ctx, reason); setCode(ctx, "meme-budget");
  return true;
}
async function log(ctx: Ctx, row: AgenticMemeLog): Promise<void> {
  ctx.logs.push(row);
  if (ctx.options.dryRun !== true) await ctx.deps.store.insertMemeLog(row);
}
async function patch(ctx: Ctx, p: AgenticMemePaper, change: Partial<AgenticMemePaper>): Promise<AgenticMemePaper> {
  const next = ctx.options.dryRun === true ? { ...p, ...change } : await ctx.deps.store.patchPaper(p, change);
  if (next === null) throw new Error("meme-paper-conflict");
  ctx.paperWrites.push(next);
  return next;
}
/** Review R3-1: a step-2 read starts only inside MEME_MARKET_BUDGET_MS; past it the remaining reads are skipped (logged once) and the exit pass begins. */
async function marketRead<T>(ctx: Ctx, name: string, read: (() => Promise<unknown>) | undefined, parse: (value: unknown) => T | null): Promise<T | null> {
  if (elapsed(ctx) >= MEME_MARKET_BUDGET_MS) { cut(ctx, `market:${name}`); return null; }
  return memeRead(read, parse);
}

/**
 * JEV-MEME-BENCHMARK-PLAN 3.3: Jev alone judges the shortlist tokens the shared layers dropped, once per shortlist refresh. Detached: the step never awaits it, it writes its own `jev`
 * row straight to the store (never into ctx.logs, never a `market` row), at most one runs at a time, and a failure is forgotten. Nothing reads the answers at runtime.
 */
function startJevScan(ctx: Ctx, cache: MarketCache): void {
  const jev = ctx.deps.jev;
  // Review M3: the scan spends only while this lane would take entries (the 8.1 step 4 gates: meme flag, entry cutoff, drain); a bound row only reaches here.
  if (jev === undefined || ctx.options.dryRun === true || !ctx.deps.memeEnabled || ctx.row.entryCutoffMs === null || ctx.nowMs + 5_000 >= ctx.row.entryCutoffMs || ctx.row.drainRequestedAt !== null) return;
  const { store } = ctx.deps, nowMs = ctx.nowMs;
  let scan = JEV_SCANS.get(store);
  if (scan === undefined) { scan = { inFlight: false, judged: new Map() }; JEV_SCANS.set(store, scan); }
  if (scan.inFlight) return;
  const state = scan;
  state.inFlight = true;
  void (async () => {
    try {
      // An entry older than the due window is due again anyway, so it is dropped here (the map never grows past one window).
      for (const [token, seen] of state.judged) if (seen.atMs <= nowMs - JEV_SCAN_DUE_MS) state.judged.delete(token);
      const due = cache.evaluated.filter(e => { const seen = state.judged.get(e.row.address); return e.verdict !== "pass" && (seen === undefined || seen.verdict !== e.verdict); });
      if (due.length === 0) return;
      const content = JSON.stringify({ candidates: due.map((e, index) => ({ ...memeCandidateState({ row: e.row, burst: e.burst, dead: e.dead, costBps: e.cEst10,
        barLagMs: e.bars === null ? null : barLagMs(e.bars, nowMs), buyTaxBps: e.row.tax?.buyBps ?? null, sellTaxBps: e.row.tax?.sellBps ?? null }, index), verdict: e.verdict })) });
      const result = await askMemeJev(jev, content, due.length, undefined, true);
      if (result.outcome === "ok") for (const e of due) state.judged.set(e.row.address, { atMs: nowMs, verdict: e.verdict });
      await store.insertMemeLog({ id: `jev:${cache.asOf}:${nowMs}`, agentId: null, kind: "jev", token: null, atMs: nowMs, data: { asOf: cache.asOf, model: result.model, latencyMs: result.latencyMs,
        outcome: result.outcome, inputTokens: result.inputTokens, asked: due.length, answers: result.answers.map(a => ({ ...a, token: due[a.index]!.row.address, verdict: due[a.index]!.verdict })) } });
    } catch { console.error("agentic_meme_jev_scan_failed"); } finally { state.inFlight = false; }
  })();
}

/** 8.1 step 2: the shortlist, and on a new `asOf` the shared work of that shortlist (written once as the global `market` row). */
async function market(ctx: Ctx): Promise<{ cache: MarketCache | null; code: string | null }> {
  const plane = ctx.deps.worker.dataPlane;
  const shortlist = await marketRead(ctx, "shortlist", plane.memeShortlist === undefined ? undefined : () => plane.memeShortlist!(), parseShortlist);
  if (shortlist === null || !shortlistFresh(shortlist, ctx.nowMs)) return { cache: null, code: "meme-data:shortlist" };
  const cached = CACHES.get(ctx.deps.store);
  if (cached !== undefined && cached.asOf === shortlist.asOf) return { cache: cached, code: null };
  const universe = await marketRead(ctx, "universe", () => plane.universe("bstocks"), value => Array.isArray(value) ? value as UniverseRow[] : null);
  if (universe === null) return { cache: null, code: "meme-data:universe" };
  const bstocks = new Set(universe.map(row => row.address.toLowerCase()));
  const facts = await marketRead(ctx, "gas-price", () => plane.tokensBatch([WBNB_56, USDT_56]), value => Array.isArray(value) ? freshNativeCostFacts(value as TokenBatchRow[], Date.now()) : null);
  const screened = shortlist.rows.map(row => ({ row, code: memeScreenShared(row, { bstocks, minEntryWei: MEME_MIN_ENTRY_WEI, nowMs: ctx.nowMs }) }));
  // Review R3-2: the shortlist's own order (the plane's `picked` ranking) decides which 30 survivors get bars.
  const survivors = screened.filter(r => r.code === null).map(r => r.row), requested = survivors.slice(0, MEME_BARS_BATCH_MAX).map(r => r.address);
  const bars = requested.length === 0 ? new Map<string, MemeBars>()
    : await marketRead(ctx, "bars", plane.memeBars === undefined ? undefined : () => plane.memeBars!(requested), value => parseBars(value, requested));
  if (bars === null) return { cache: null, code: "meme-data:bars" };
  const evaluated = screened.map(({ row, code }): Evaluated => code !== null ? { row, verdict: `screen:${code}`, bars: null, dead: null, burst: null, range15: null, cEst10: null }
    : evaluate(row, bars.get(row.address) ?? null, ctx.nowMs, facts));
  const cache: MarketCache = { asOf: shortlist.asOf, shortlist, facts, evaluated, bars, survivors61: survivors.length, barsRequested: requested.length };
  if (ctx.options.dryRun !== true) CACHES.set(ctx.deps.store, cache);
  await log(ctx, { id: `market:${shortlist.asOf}`, agentId: null, kind: "market", token: null, atMs: ctx.nowMs, data: { asOf: shortlist.asOf, boardTotal: shortlist.boardTotal,
    candidates: shortlist.candidates, picked: shortlist.picked, writtenAt: ctx.nowMs, survivors61: cache.survivors61, barsRequested: cache.barsRequested, invalidRows: shortlist.invalid,
    rows: evaluated.map(e => [marketTuple(e.row, bstocks), brainTuple(e, ctx.nowMs)]) } });
  startJevScan(ctx, cache);
  return { cache, code: null };
}

/* ------------------------------------------------------------- 8.4 exit pass ------------------------------------------------------------- */

type Held = { bars: Map<string, MemeBars>; board: Map<string, MemeBoardRow> };
async function closePaper(ctx: Ctx, p: AgenticMemePaper, code: NonNullable<AgenticMemePaper["closeCode"]>, exit: bigint, extra: Record<string, unknown>): Promise<void> {
  // 7.2: X = S_mark - gasSell at the stored entry-time BNB price; an `ended` close at 0 (no recent mark) books no sell gas.
  const gasSell = exit === 0n ? 0n : gasAt(MEME_GAS_WEI[p.venueEntry].sell, BigInt(p.bnbUsdtE18));
  const pnl = exit - gasSell - basisOf(p);
  await patch(ctx, p, { status: "closed", closeCode: code, exitUsdt: exit.toString(), gasSellUsdt: gasSell.toString(), pnlUsdt: pnl.toString(), closedAt: ctx.nowMs });
  await log(ctx, { id: `exit:${p.positionId}`, agentId: ctx.agentId, kind: "exit", token: p.token, atMs: ctx.nowMs, data: { ...extra, positionId: p.positionId, closeCode: code,
    entryUsdt: p.entryUsdt, gasBuyUsdt: p.gasBuyUsdt, exitUsdt: exit.toString(), gasSellUsdt: gasSell.toString(), pnlUsdt: pnl.toString(), openedAt: p.openedAt, closedAt: ctx.nowMs } });
  note(ctx, "sell", `meme-exit:${code}`, { token: p.token });
  bump(ctx, "exits");
}

async function exitPass(ctx: Ctx, ordered: readonly AgenticMemePaper[], cache: MarketCache | null, reads: Held): Promise<{ marks: number; marksSkipped: number; quoteFailures: number }> {
  let marks = 0, marksSkipped = 0, quoteFailures = 0;
  for (const p of ordered) {
    // 6.6 / M8: a rugged position is quoted only every 10th cycle; skipping it is not a mark.
    if (throttledMark(p)) { await patch(ctx, p, { markSkips: p.markSkips + 1 }); continue; }
    if (marks >= MEME_MARKS_PER_CYCLE) { marksSkipped += 1; continue; }
    if (elapsed(ctx) >= MEME_STEP_BUDGET_MS) { marksSkipped += 1; cut(ctx, "exit"); continue; }
    marks += 1;
    const quote = await memeQuote(ctx.deps, { agentId: ctx.agentId, side: "sell", token: p.token, amountAtomic: BigInt(p.tokens) });
    const board = reads.board.get(p.token) ?? null, fresh = board !== null && boardFresh(board, ctx.nowMs) ? board : null;
    // 6.6: the freshest known venue and taxes decide the unnetting of the mark; the entry's when the board row is not fresh.
    // FOURMEME-CURVE-PAPER-SPEC F13: a Four.meme curve position accepts its curve or Pancake V2 (graduation while held), never a Flap venue (that would un-net the tax).
    const accepted: readonly string[] = p.venueEntry === "fourmeme-bonding" ? ["fourmeme-bonding", "pancake-v2"] : ["pancake-v2", "flap-bonding"];
    const venue: MemeVenue = fresh?.venue != null && accepted.includes(fresh.venue) ? fresh.venue as MemeVenue : p.venueEntry;
    const inForce = { venue, buyTaxBps: fresh?.tax?.buyBps ?? p.buyTaxBps, sellTaxBps: fresh?.tax?.sellBps ?? p.sellTaxBps };
    if (!quote.ok) {
      quoteFailures += 1;
      note(ctx, "route", quote.code, { token: p.token });
      await patch(ctx, p, { markSkips: p.markSkips + 1 });
      await log(ctx, { id: `mark:${p.positionId}:${ctx.nowMs}`, agentId: ctx.agentId, kind: "mark", token: p.token, atMs: ctx.nowMs, data: { positionId: p.positionId, code: quote.code, ...inForce } });
      continue;
    }
    const sMark = memeSMark(quote.outAtomic, venue, inForce.sellTaxBps), pnl = memePnlBps(sMark, basisOf(p));
    const raised = p.peakPnlBps === null || pnl > p.peakPnlBps, peak = Math.max(p.peakPnlBps ?? pnl, pnl), count = p.markCount + 1;
    const marked = await patch(ctx, p, { lastMarkUsdt: sMark.toString(), lastMarkAt: ctx.nowMs, peakPnlBps: peak, markCount: count, markSkips: 0 });
    const data = { positionId: p.positionId, grossUsdt: quote.outAtomic.toString(), markUsdt: sMark.toString(), pnlBps: pnl, peakBps: peak, slippageBps: quote.slippageBps, quotedAt: quote.atMs, ...inForce };
    // 8.4 (review R2-M6): a mark log row only on a peak change or on every 10th mark (and on a quote failure, above); the live mark always lives on the paper row.
    if (raised || count % 10 === 0) await log(ctx, { id: `mark:${p.positionId}:${ctx.nowMs}`, agentId: ctx.agentId, kind: "mark", token: p.token, atMs: ctx.nowMs, data });
    const bars = cache?.bars.get(p.token) ?? reads.bars.get(p.token) ?? null;
    const code = memeExit({ drain: ctx.row.drainRequestedAt !== null || marked.closeRequestedAt !== null, pnlBps: pnl, peakBps: peak, costBps: p.costBps, ageMs: ctx.nowMs - p.openedAt,
      hardVeto: bars !== null && barsExitOk(bars, ctx.nowMs) ? memeDeadChart(bars.bars).hardVeto : null,
      board: fresh === null ? null : { status: fresh.status, flags: fresh.flags, inflow5mNetUsd: fresh.smartInflow5mNetUsd, flow5m: fresh.flow5m } });
    if (code !== null) await closePaper(ctx, marked, code, sMark, data);
  }
  return { marks, marksSkipped, quoteFailures };
}

/** 8.5: on term end or owner sign-out, every open paper position closes with `ended` at its last mark when that is at most 600 000 ms old, else at 0; no quote. */
async function closeOut(ctx: Ctx, open: readonly AgenticMemePaper[]): Promise<void> {
  for (const p of open) {
    const recent = p.lastMarkUsdt !== null && p.lastMarkAt !== null && p.lastMarkAt >= ctx.nowMs - 600_000;
    await closePaper(ctx, p, "ended", recent ? BigInt(p.lastMarkUsdt!) : 0n, { lastMarkAt: p.lastMarkAt });
  }
}

/* ------------------------------------------------------------- 8.3 entry pass ------------------------------------------------------------- */

type Signal = { token: Address; amountWei: string; costEst: number | null; costRule: boolean; llm: string | null; verdict: string; [key: string]: unknown };

/** 6.7 (review R2-M3): this agent's last `llm` row decides: a failed primary ask means the fallback next, anything else the primary. */
async function modelFor(ctx: Ctx): Promise<string> {
  const last = (await ctx.deps.store.memeLog(ctx.agentId, ctx.nowMs - DAY_MS, ctx.nowMs)).filter(r => r.kind === "llm").at(-1);
  const data = (last?.data ?? {}) as { model?: unknown; outcome?: unknown };
  return (data.outcome === "timeout" || data.outcome === "invalid") && data.model === ctx.s.primaryModel ? ctx.s.fallbackModel : ctx.s.primaryModel;
}
function veto(ctx: Ctx, signal: Signal, verdict: string, code: string, stage: Stage = "screen"): void {
  signal.verdict = verdict; bump(ctx, verdict); setCode(ctx, code); note(ctx, stage, code, { token: signal.token });
}

async function entryPass(ctx: Ctx, cache: MarketCache | null, dataCode: string | null, open: readonly AgenticMemePaper[], all: readonly AgenticMemePaper[]): Promise<void> {
  const hold = (code: string): void => { setCode(ctx, code); note(ctx, "screen", code); };
  if (cache === null) { hold(dataCode ?? "meme-data:shortlist"); return; }
  if (cache.shortlist.rows.length === 0) { hold("meme-data:no-candidates"); return; }
  if (cache.facts === null) { hold("meme-data:gas-price"); return; }
  const facts = cache.facts, s = ctx.s, minEntry = BigInt(s.minEntryWei!);
  const held = new Set(open.map(p => p.token));
  const cooled = new Set(all.filter(p => p.closedAt !== null && p.closedAt >= ctx.nowMs - MEME_REENTRY_COOLDOWN_MS).map(p => p.token));
  const refused = new Set((await ctx.deps.store.memeLog(ctx.agentId, ctx.nowMs - MEME_REFUSAL_COOLDOWN_MS, ctx.nowMs)).filter(r => r.kind === "signal" && r.token !== null)
    .filter(r => { const v = (r.data as { verdict?: unknown }).verdict; return typeof v === "string" && (v.startsWith("meme-refused:") || v === "no-exit-quote"); }).map(r => r.token!));
  const signals: Signal[] = [], survivors: { e: Evaluated; amount: bigint; costEst: number; signal: Signal }[] = [];
  for (const e of cache.evaluated) {
    if (e.verdict !== "pass") { bump(ctx, e.verdict); continue; }
    // Audit F-A: a reused cache (same shortlist asOf) holds verdicts taken at fill time; the 5.3 bar lag and the 5.1 row freshness are rechecked at this step's clock.
    if (!barsEntryOk(e.bars!, ctx.nowMs) || !rowFresh(e.row, ctx.nowMs)) { bump(ctx, "stale-at-decision"); note(ctx, "screen", "meme-veto:stale", { token: e.row.address }); continue; }
    const agentCode = memeScreenAgent(e.row.address, { held, cooledDown: cooled, refused });
    if (agentCode !== null) { bump(ctx, `screen:${agentCode}`); note(ctx, "screen", `meme-veto:${agentCode}`, { token: e.row.address }); continue; }
    // COST_EST at this agent's A = min(entryWei, liqCapWei) (6.1, 6.5, 8.3).
    const cap = memeLiqCapWei(e.row.liquidityUsd) ?? 0n, amount = BigInt(s.entryWei) < cap ? BigInt(s.entryWei) : cap;
    const venue = memeVenue(e.row.venue), gas = nativeCostToUsdtAtomic(MEME_GAS_WEI[venue].buy + MEME_GAS_WEI[venue].sell, facts);
    const costEst = amount < minEntry || gas === null ? null : memeCostEstBps({ venue: e.row.venue, tax: e.row.tax, liquidityUsd: e.row.liquidityUsd, amountWei: amount, gasRoundTripUsdtAtomic: gas });
    const rule = amount >= minEntry && memeCostRuleOk(e.range15, costEst);
    const signal: Signal = { token: e.row.address, amountWei: amount.toString(), costEst, costRule: rule, llm: null, verdict: "llm-skipped", barLagMs: barLagMs(e.bars!, ctx.nowMs), asOf: cache.asOf };
    signals.push(signal);
    if (amount < minEntry) { signal.verdict = "liquidity"; bump(ctx, "liquidity"); note(ctx, "screen", "meme-veto:liquidity", { token: e.row.address }); continue; }
    if (!rule) { signal.verdict = "cost"; bump(ctx, "cost"); note(ctx, "screen", "meme-veto:cost", { token: e.row.address }); continue; }
    survivors.push({ e, amount, costEst: costEst!, signal });
  }
  try {
    if (survivors.length === 0) { setCode(ctx, "meme-no-candidate"); return; }
    if (overBudget(ctx, "llm")) return;
    // 6.7: at most three, highest burstRatio first, re-indexed 0..k-1; the ask holds no wallet fence and is bounded by an 8 s signal.
    const asked = [...survivors].sort((a, b) => (b.e.burst!.burstRatio ?? Infinity) - (a.e.burst!.burstRatio ?? Infinity)).slice(0, 3);
    const model = await modelFor(ctx), started = Date.now();
    let outcome: "buy_now" | "wait" | "reject" | "invalid" | "timeout", decisions: MemeLlmDecision[] | null = null;
    // JEV-MEME-BENCHMARK-PLAN 3.2: Jev sees the LLM's own user content, starts with the ask and is never awaited; whatever has not settled when the LLM has is `late` and aborted.
    const jevOn = ctx.deps.jev !== undefined && ctx.options.dryRun !== true, jevAbort = new AbortController(), jev: { result: MemeJevData | null; startedAt: number } = { result: null, startedAt: 0 };
    try {
      const prompt = memePrompt(asked.map(c => ({ row: c.e.row, burst: c.e.burst!, dead: c.e.dead!, costBps: c.costEst,
        barLagMs: barLagMs(c.e.bars!, ctx.nowMs), buyTaxBps: c.e.row.tax!.buyBps, sellTaxBps: c.e.row.tax!.sellBps })));
      // Review L2: the LLM call goes first and Jev launches in the same tick, so Jev's synchronous set-up is not inside the LLM's own wait.
      const asking = ctx.deps.worker.llmFor(model).complete(prompt, AbortSignal.timeout(MEME_LLM_TIMEOUT_MS));
      if (jevOn) { jev.startedAt = Date.now(); void askMemeJev(ctx.deps.jev!, prompt[1]!.content, asked.length, jevAbort.signal, false).then(result => { jev.result = result; }, () => undefined); }
      const answer = await asking;
      decisions = parseMemeAnswer(answer.content, asked.length);
      outcome = decisions === null ? "invalid" : memePick(decisions) !== null ? "buy_now" : decisions.some(d => d.action !== "reject") ? "wait" : "reject";
    } catch (error) { outcome = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "invalid"; }
    const jevData: MemeJevData | null = !jevOn ? null : jev.result ?? { model: null, latencyMs: Date.now() - jev.startedAt, outcome: "late", answers: [], inputTokens: null };
    if (jevOn && jev.result === null) jevAbort.abort();
    const pickIndex = decisions === null ? null : memePick(decisions);
    for (const [index, c] of asked.entries()) { const d = decisions?.find(x => x.index === index); c.signal.llm = d === undefined ? outcome : `${d.action}:${d.confidence}`; c.signal.verdict = "llm-not-picked"; }
    bump(ctx, "llmAsked");
    await log(ctx, { id: `llm:${ctx.agentId}:${ctx.nowMs}`, agentId: ctx.agentId, kind: "llm", token: null, atMs: ctx.nowMs,
      data: { model, latencyMs: Date.now() - started, outcome, tokens: asked.map(c => c.e.row.address), decisions, ...(jevData === null ? {} : { jev: jevData }) } });
    const top = pickIndex === null ? undefined : decisions!.find(d => d.index === pickIndex);
    note(ctx, "entry-llm", `meme-llm:${outcome}`, { model, ...(top === undefined ? {} : { confidence: top.confidence, token: asked[pickIndex!]!.e.row.address }) });
    // Operator 2026-10-07, display only: the Jev shadow's answer as its own run event beside the model's (highest buy probability, its choice); nothing reads it back.
    if (jevData !== null) {
      const best = [...jevData.answers].sort((a, b) => b.pBuy - a.pBuy || a.index - b.index)[0];
      note(ctx, "entry-llm", `meme-jev:${best === undefined ? jevData.outcome : best.choice}`, { ...(jevData.model === null ? {} : { model: jevData.model }),
        ...(best === undefined ? {} : { confidence: Math.round(best.pBuy * 100), token: asked[best.index]!.e.row.address }) });
    }
    if (pickIndex === null) { setCode(ctx, `meme-llm:${outcome}`); return; }
    bump(ctx, "llmBuy");
    const pick = asked[pickIndex]!, row = pick.e.row, signal = pick.signal;
    // ELIGIBILITY (5.4), then TOKEN_VERSION (F5, review R2-L2), each with its own refusal.
    if (overBudget(ctx, "eligibility")) { signal.verdict = "budget"; return; }
    const plane = ctx.deps.worker.dataPlane;
    const eligibility = (await memeRead(plane.memeEligibility === undefined ? undefined : () => plane.memeEligibility!([row.address]), parseEligibility))?.get(row.address) ?? null;
    if (eligibility === null || !eligibilityFresh(eligibility, Date.now())) { veto(ctx, signal, "eligibility-unavailable", "meme-data:eligibility"); return; }
    const f = eligibility.flap, fm = eligibility.fourmeme;
    // Operator hotfix 2026-10-06: a Four.meme token (graduated or on its curve) takes the shortlist row's taxes (the screen refused a null tax); a Flap token keeps the eligibility taxes.
    const t = f !== null ? { tokenVersion: f.tokenVersion, buyTaxBps: f.buyTaxBps, sellTaxBps: f.sellTaxBps }
      : fm !== null && row.tax !== null ? { tokenVersion: fm.version, buyTaxBps: row.tax.buyBps, sellTaxBps: row.tax.sellBps } : null;
    Object.assign(signal, { eligible: eligibility.eligible, source: eligibility.source, venue: eligibility.venue, checkedAt: eligibility.checkedAt, tokenVersion: t?.tokenVersion ?? null,
      flapStatus: f?.status ?? null, progress: f?.progress.toString() ?? null, buyTaxBps: t?.buyTaxBps ?? null, sellTaxBps: t?.sellTaxBps ?? null,
      ...(eligibility.venue === "fourmeme-bonding" && fm !== null ? { funds: fm.funds?.toString() ?? null, maxFunds: fm.maxFunds?.toString() ?? null } : {}) });
    const flapOk = eligibility.source === "flap" && f !== null && (eligibility.venue === "flap-bonding" || eligibility.venue === "pancake-v2") && f.quote === row.quote.address
      && !(eligibility.venue === "flap-bonding" && f.progress >= MEME_MAX_PROGRESS);
    const fourmemeOk = eligibility.source === "fourmeme" && fm !== null && row.launchpad === "fourmeme" && fm.quote === row.quote.address
      && (eligibility.venue === "pancake-v2" ? fm.liquidityAdded : eligibility.venue === "fourmeme-bonding" && !fm.liquidityAdded);
    if (!eligibility.eligible || t === null || !(flapOk || fourmemeOk) || row.venue !== null && row.venue !== eligibility.venue) { veto(ctx, signal, "eligibility", "meme-veto:eligibility"); return; }
    // FOURMEME-CURVE-PAPER-SPEC F2 / FC2: the curve guard, on the fresh eligibility read and on the curve only (a graduated token's funds sit near maxFunds, so the venue condition is load-bearing, review M8).
    if (fourmemeOk && eligibility.venue === "fourmeme-bonding" && !memeCurveFundsOk(fm!)) { veto(ctx, signal, "curve-funds", "meme-veto:curve-funds"); return; }
    if (flapOk ? t.tokenVersion !== 6 : t.tokenVersion !== 2) { veto(ctx, signal, "token-version", "meme-veto:token-version"); return; }
    // Sound only because `flapOk || fourmemeOk` (above) narrowed `eligibility.venue` to `flap-bonding`, `pancake-v2` or `fourmeme-bonding`; widen either predicate and this cast must be revisited.
    const venue = eligibility.venue as MemeVenue;
    // 8.1: the quote helper takes 18-decimal tokens only, read once here; an open paper row therefore always holds an 18-decimal token.
    let decimals: number | null = null;
    // Audit F-F: bounded at 5 s like a data read, so the in-flight part of PA5 stays within its 15 s.
    try { decimals = (await Promise.race([ctx.deps.chain.metadata(row.address), new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error("timeout")), 5_000).unref(); })])).decimals; } catch { decimals = null; }
    if (decimals !== 18) { veto(ctx, signal, "decimals", "meme-veto:decimals"); return; }
    // COST_MEAS (7.4): two live quotes; a failed sell quote or S <= 0 is the only honeypot check.
    if (overBudget(ctx, "buy-quote")) { signal.verdict = "budget"; return; }
    const A = pick.amount, buy = await memeQuote(ctx.deps, { agentId: ctx.agentId, side: "buy", token: row.address, amountAtomic: A });
    if (!buy.ok) { bump(ctx, "quoteFailures"); veto(ctx, signal, buy.code, buy.code, "route"); return; }
    const N = buy.outAtomic * BigInt(10_000 - (memeQuoteOmitsTax(venue) ? t.buyTaxBps : 0)) / 10_000n;
    Object.assign(signal, { qb: buy.outAtomic.toString(), n: N.toString(), buySlippageBps: buy.slippageBps, buyQuotedAt: buy.atMs });
    if (overBudget(ctx, "sell-quote")) { signal.verdict = "budget"; return; }
    const sell = N <= 0n ? { ok: false as const, code: "meme-unparseable" } : await memeQuote(ctx.deps, { agentId: ctx.agentId, side: "sell", token: row.address, amountAtomic: N });
    const S = sell.ok ? sell.outAtomic * BigInt(10_000 - (memeQuoteOmitsTax(venue) ? t.sellTaxBps : 0)) / 10_000n : 0n;
    if (!sell.ok) bump(ctx, "quoteFailures");
    if (!sell.ok || S <= 0n) { signal["sellCode"] = sell.ok ? null : sell.code; veto(ctx, signal, "no-exit-quote", "meme-veto:no-exit-quote", "route"); return; }
    const gas = nativeCostToUsdtAtomic(MEME_GAS_WEI[venue].buy + MEME_GAS_WEI[venue].sell, facts), gasBuy = nativeCostToUsdtAtomic(MEME_GAS_WEI[venue].buy, facts), bnb = nativeCostToUsdtAtomic(E18, facts);
    if (gas === null || gasBuy === null || bnb === null) { veto(ctx, signal, "gas-price", "meme-data:gas-price"); return; }
    const loss = (A - S) * 10_000n, cMeas = Number(loss >= 0n ? loss / A : -((-loss + A - 1n) / A)) + memeGasBps(gas, A);
    Object.assign(signal, { qs: sell.outAtomic.toString(), s: S.toString(), cMeas, sellSlippageBps: sell.slippageBps, sellQuotedAt: sell.atMs });
    note(ctx, "route", "meme-cost-measured", { token: row.address });
    if (!memeCostRuleOk(pick.e.range15, cMeas)) { veto(ctx, signal, "cost-measured", "meme-veto:cost"); return; }
    // PAPER_ENTRY (8.3): one entry per cycle.
    const paper: AgenticMemePaper = { positionId: `meme-${ctx.agentId}-${row.address}-${ctx.nowMs}`, agentId: ctx.agentId, walletAddress: ctx.W, token: row.address, symbol: row.symbol,
      quoteToken: row.quote.address!, quoteSymbol: row.quote.symbol, venueEntry: venue, buyTaxBps: t.buyTaxBps, sellTaxBps: t.sellTaxBps, tokenVersion: t.tokenVersion,
      entryUsdt: A.toString(), gasBuyUsdt: gasBuy.toString(), bnbUsdtE18: bnb.toString(), tokens: N.toString(), costBps: cMeas, status: "open",
      lastMarkUsdt: null, lastMarkAt: null, peakPnlBps: null, markSkips: 0, markCount: 0, closeRequestedAt: null, closeCode: null,
      exitUsdt: null, gasSellUsdt: null, pnlUsdt: null, closedAt: null, openedAt: ctx.nowMs, version: 1 };
    if (ctx.options.dryRun !== true && !await ctx.deps.store.insertPaper(paper)) { signal.verdict = "conflict"; return; }
    ctx.paperWrites.push(paper);
    signal.verdict = "entered"; bump(ctx, "entered"); setCode(ctx, "meme-entered");
    await log(ctx, { id: `entry:${paper.positionId}`, agentId: ctx.agentId, kind: "entry", token: row.address, atMs: ctx.nowMs, data: { positionId: paper.positionId, amountWei: A.toString(),
      qb: buy.outAtomic.toString(), tokens: N.toString(), gasBuyUsdt: gasBuy.toString(), bnbUsdtE18: bnb.toString(), costBps: cMeas, venue, buyTaxBps: t.buyTaxBps, sellTaxBps: t.sellTaxBps,
      slippageBps: buy.slippageBps, quotedAt: buy.atMs, asOf: cache.asOf,
      // Operator 2026-10-07, display only: the shortlist's market cap at the decision, shown as "@ 32.6K MCap" on the position.
      mcapUsd: row.marketCapUsd } });
    note(ctx, "buy", "meme-paper-entry", { token: row.address });
  } finally {
    for (const signal of signals) await log(ctx, { id: `signal:${ctx.agentId}:${ctx.nowMs}:${signal.token}`, agentId: ctx.agentId, kind: "signal", token: signal.token, atMs: ctx.nowMs, data: signal });
  }
}

/** 8.1: the paper step of one meme hire, called from runAgenticCycle beside the DCA step; returns the freshest wallet row and what the step decided. */
export async function runAgenticMemeStep(deps: MemeStepDeps, row: AgenticWallet, options: MemeStepOptions = {}): Promise<{ row: AgenticWallet; report: MemeReport }> {
  const idle: MemeReport = { code: "meme-idle", events: [], cycle: null, logs: [], paper: [] };
  if (options.reconciliationOnly === true || options.cmcOnly === true || row.hireFacts?.meme?.mode !== "paper" || row.agentId === null || row.walletAddress === null || row.hireParams === null) return { row, report: idle };
  const ctx: Ctx = { deps, options, row, agentId: row.agentId, W: row.walletAddress, s: row.hireParams.settings, nowMs: await deps.store.now(), startedAt: Date.now(),
    events: [], logs: [], paperWrites: [], code: null, counts: {}, budgetCut: false };
  const report = (cycle: Record<string, unknown> | null): MemeReport => ({ code: ctx.code ?? "meme-idle", events: ctx.events.slice(0, 100), cycle, logs: ctx.logs, paper: ctx.paperWrites });
  try {
    const open = await deps.store.paperOpen(ctx.agentId);
    if (row.state !== "bound") {
      // 8.5: ending or ended is a close-out only; nothing is quoted (the session may be gone).
      if (!["ending", "ended"].includes(row.state) || open.length === 0) return { row, report: idle };
      await closeOut(ctx, open);
      setCode(ctx, "meme-ended");
      return { row, report: report(null) };
    }
    // Step 1: a pause, a halt or a settings hold stops the step.
    const ks = deps.worker.killswitch as unknown as { isBlocked?: (agentId: string, owner: Address) => Promise<boolean> } | undefined;
    if (typeof ks?.isBlocked === "function" && await ks.isBlocked(ctx.agentId, ctx.W)) { setCode(ctx, "paused"); note(ctx, "cycle", "paused"); return { row, report: report(null) }; }
    if (row.settingsHold !== null) { setCode(ctx, "settings-hold"); note(ctx, "cycle", "settings-hold"); return { row, report: report(null) }; }
    // Step 2 (review R3-1: its own sub-budget): the shared market read, then this agent's held-token bars and the board rows of the positions marked this cycle.
    const { cache, code: dataCode } = await market(ctx);
    const ordered = [...open].sort((a, b) => (a.lastMarkAt ?? -Infinity) - (b.lastMarkAt ?? -Infinity) || a.openedAt - b.openedAt);
    const plane = deps.worker.dataPlane, reads: Held = { bars: new Map(), board: new Map() };
    const outside = [...new Set(open.map(p => p.token))].filter(token => cache?.bars.get(token) === undefined).slice(0, MEME_BARS_BATCH_MAX);
    if (outside.length > 0) reads.bars = await marketRead(ctx, "held-bars", plane.memeBars === undefined ? undefined : () => plane.memeBars!(outside), value => parseBars(value, outside)) ?? new Map();
    for (const p of ordered.filter(p => !throttledMark(p)).slice(0, MEME_MARKS_PER_CYCLE)) {
      const board = await marketRead(ctx, "board", plane.memeToken === undefined ? undefined : () => plane.memeToken!(p.token), parseBoardRow);
      if (board !== null) reads.board.set(p.token, board);
    }
    // Step 3: the exit pass, oldest mark first, at most three marks, under the whole-step budget.
    const exitStarted = Date.now();
    const exits = await exitPass(ctx, ordered, cache, reads);
    const exitElapsedMs = Date.now() - exitStarted;
    // Step 4: the entry pass, behind its gates (8.1 step 4, 8.2 loss brake and day cap).
    const papers = (await deps.store.paperList(ctx.agentId)).map(p => ctx.paperWrites.filter(w => w.positionId === p.positionId).at(-1) ?? p);
    const stillOpen = papers.filter(p => p.status === "open"), counted = stillOpen.filter(p => !rugged(p)).length;
    const lost = -papers.filter(p => p.closedAt !== null && p.closedAt >= ctx.nowMs - DAY_MS).reduce((sum, p) => sum + BigInt(p.pnlUsdt ?? "0"), 0n);
    const bought = papers.filter(p => p.openedAt >= ctx.nowMs - DAY_MS).reduce((sum, p) => sum + BigInt(p.entryUsdt), 0n);
    const gate = !deps.memeEnabled ? "meme-off" : row.entryCutoffMs === null || ctx.nowMs + 5_000 >= row.entryCutoffMs ? "meme-entry-cutoff" : row.drainRequestedAt !== null ? "meme-draining"
      : counted >= ctx.s.maxOpenPositions || stillOpen.length >= MEME_MAX_TOTAL_OPEN ? "meme-full" : lost * 100n > BigInt(ctx.s.capitalQuoteWei!) * 25n ? "meme-loss-brake"
      : bought + BigInt(ctx.s.entryWei) > BigInt(row.hireFacts!.quoteDayCapWei) ? "meme-day-cap" : exitElapsedMs >= MEME_EXIT_PASS_ENTRY_LIMIT_MS ? "meme-exit-slow" : null;
    if (gate !== null) { setCode(ctx, gate); note(ctx, "cycle", gate); }
    else if (!overBudget(ctx, "entry")) await entryPass(ctx, cache, dataCode, stillOpen, papers);
    const lags = (cache?.evaluated ?? []).filter(e => e.bars !== null).map(e => barLagMs(e.bars!, ctx.nowMs));
    const cycle = { barLagMedianMs: median(lags), barLagMaxMs: lags.length === 0 ? null : Math.max(...lags), asOf: cache?.asOf ?? null, boardTotal: cache?.shortlist.boardTotal ?? null,
      candidates: cache?.shortlist.candidates ?? null, picked: cache?.shortlist.picked ?? null, survivors61: cache?.survivors61 ?? null, barsRequested: cache?.barsRequested ?? null,
      dataCode, counts: ctx.counts, marks: exits.marks, marksSkipped: exits.marksSkipped, quoteFailures: exits.quoteFailures + (ctx.counts["quoteFailures"] ?? 0),
      exitElapsedMs, elapsedMs: Date.now() - ctx.startedAt, budgetCut: ctx.budgetCut, code: ctx.code ?? "meme-idle", startPhaseMs: (deps.cycleStartMs ?? ctx.startedAt) % 60_000 };
    note(ctx, "cycle", ctx.code ?? "meme-idle");
    await log(ctx, { id: `cycle:${ctx.agentId}:${ctx.nowMs}`, agentId: ctx.agentId, kind: "cycle", token: null, atMs: ctx.nowMs, data: cycle });
    return { row: await deps.store.byAgent(ctx.agentId) ?? row, report: report(cycle) };
  } catch (error) {
    console.error("agentic_meme_step_failed", error instanceof Error ? error.message : "unknown");
    setCode(ctx, "meme-step-failed"); note(ctx, "cycle", "meme-step-failed");
    return { row: await deps.store.byAgent(ctx.agentId) ?? row, report: report(null) };
  } finally {
    if (options.dryRun !== true && ctx.events.length > 0) {
      try {
        await deps.positions.insertRun({ agentId: ctx.agentId, ownerAddress: ctx.W, dryRun: false, candidates: ctx.counts["llmAsked"] ?? 0, refusals: 0,
          entries: ctx.counts["entered"] ?? 0, exits: ctx.counts["exits"] ?? 0, reason: ctx.code ?? "meme-idle", events: ctx.events.slice(0, 100) });
      } catch { console.error("agentic_meme_run_failed"); }
    }
  }
}
