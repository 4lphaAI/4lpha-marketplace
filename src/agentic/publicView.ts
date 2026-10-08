import { createHash } from "node:crypto";
import type { Address } from "viem";
import { sanitizeMessage } from "../core/errors.js";
import type { AgentStore } from "../store/agents.js";
import type { TradeSettingsStore } from "../store/tradeSettings.js";
import type { TradePositionStore, TradePositionRecord } from "../store/tradePositions.js";
import { MEME_RUN_RETAIN_MS } from "../store/tradePositions.js";
import type { TradeIntentStore } from "../store/tradeIntents.js";
import type { ExecutionJournal } from "../store/journal.js";
import type { CmcBudgetStore } from "../store/tradeCmc.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import type { TradeDetailObserver, TradePositionObservation } from "../trade/detail.js";
import { pnlBps } from "../trade/exits.js";
import { tradeSummary } from "../trade/view.js";
import { isTradeDcaSettings, isTradePortfolioSettings, isTradeScheduleSettings, parseTradeSettings, type TradeSettings } from "../trade/settings.js";
import { currentSlot, scheduleAnchorMs, scheduleLedger, type ScheduleIntervalSec } from "../trade/schedule.js";
import { dcaMidPrice, dcaPoolForToken, dcaStopLineWei, dcaTpTarget, dcaEquityWei, type DcaPrice } from "../trade/dca.js";
import { USDT_56 } from "../trade/settlement.js";
import { AGENTIC_PAID_KEEPALIVE_IDLE_MS, agenticAddress, agenticDecimal, agenticLastActivityMs, agenticUiString, projectAgenticSessionFacts, type AgenticDcaOrder, type AgenticDcaRound,
  type AgenticWallet, type AgenticOrder } from "./domain.js";
import { dcaLevelAt, dcaP0, dcaPriceE8 } from "./dca.js";
import type { AgenticStore } from "./store.js";
import { agenticExecutedQuantity, type AgenticChain } from "./resolve.js";
import { isCurrentCmcSkill } from "../trade/cmcUsEquity.js";
import { identityOwnerView } from "../identity/types.js";
import { EARN_PRODUCTS, earnSelfRescueCommand, type EarnProduct } from "./earnAdapter.js";
import { EARN_DUST_WEI, EARN_REDEEM_ALL_MS, earnEvidence } from "./earn.js";
import { agenticMemeDecisionLogPublic } from "./config.js";
import { memeDecisionLog, memeLastCycle } from "./memePublic.js";

/** An opaque public id: the first 16 hex of sha256 of the raw id, never the raw id. */
const opaque = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 16);

const LLM_STAGES = new Set(["entry-llm", "exit-llm"]);
const LLM_DECISION_CODES = new Set(["enter", "llm-veto", "final-below-threshold", "exit", "hold", "hold-guard", "selected", "below-confidence"]);
/** A run reason is a closed code plus counts; free text (an `agent-error:` message) never leaves the plane. */
function publicRunReason(reason: string, portfolio = false): string {
  return reason.split(";").map((part, index) => /^agent-error(:|$)/u.test(part) ? "agent-error"
    : (index === 0 ? /^[a-z][a-z0-9-]*(:[a-z0-9-]+)*$/u : /^[a-z-]+=[a-z0-9-]+$/u).test(part) || index === 0 && portfolio && PORTFOLIO_REASON.test(part)
      // Operator hotfix 2026-10-07: a meme quote refusal carries Binance's closed UPPER_SNAKE code (meme-refused:SERVICE_ERROR), not "other".
      || index === 0 && /^meme-refused:[A-Z][A-Z0-9_]{0,63}$/u.test(part) ? part : index === 0 ? "other" : "").filter(part => part !== "").join(";");
}
/** A closed code of a portfolio hire's run log: executor codes such as AGENTIC_LOW_BNB or fence codes such as portfolio_leg_taken. */
const PORTFOLIO_REASON = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const REASONS = new Set(["owner-request", "stop-loss", "take-profit", "max-hold", "llm", "balance-gone", "crash-stop", "session-expiring", "trailing-stop", "stale-exit"]);
const STAGES = new Set(["screen", "score", "entry-llm", "exit-llm", "route", "buy", "sell", "cycle", "cmc", "earn"]);
const CODES = new Set(["committed", "rolled-back", "denied", "unknown", "empty", "ready", "skipped", "no-buy", "no-sell", "buy", "sell", "held", "cost-unavailable", "quoted", "available", "invalid", "service-error", "settings-hold", "fill-below-minimum",
  "earn-sent", "earn-deposited", "earn-redeemed", "earn-refused", "earn-held", "earn-redeem-blocked", "earn-unavailable", "earn-read-failed"]);
/** AGENTIC-EARN-SPEC 3.15: the only free text an earn event may carry is one of these closed formats (protocols, APYs and USDT amounts, or a closed blocked reason). */
const EARN_REASON = /^(?:(?:venus|aave-v3) [0-9]+\.[0-9]{2}% vs (?:venus|aave-v3) (?:[0-9]+\.[0-9]{2}%|n\/a), [0-9]+\.[0-9]{2} USDT|(?:venus|aave-v3), (?:[0-9]+\.[0-9]{2}|all) USDT|read-failed|low-bnb|unconfigured|paused|preview-refused|held)$/u;
const EARN_HOLDS = new Set(["no-response", "receipt-missing", "chain-verification", "redeem-delayed"]);
const REFUSALS: Readonly<Record<string, string>> = {
  AGENTIC_QUOTE_BELOW_MIN: "quote-below-minimum", AGENTIC_QUOTE_NO_HEADROOM: "quote-no-headroom", AGENTIC_AMOUNT_UNREPRESENTABLE: "amount-unrepresentable",
  AGENTIC_LOW_BNB: "insufficient-bnb", AGENTIC_UNREACHABLE: "binance-unreachable", AGENTIC_WALLET_OBLIGATION: "wallet-blocked", agentic_wallet_busy: "wallet-blocked",
  AGENTIC_SETTINGS_UNREADABLE: "binance-read-failed", AGENTIC_LIST_SNAPSHOT_INCOMPLETE: "binance-read-failed", "cost-unavailable": "price-check",
};
/**
 * AGENTIC-RFQ-STOCKS E12 / R3.6 / R4.9: the public mark of an RFQ-only position is the worker's own last Binance sell quote, never a new Binance, Flash or session call (RI9). Quoted only when the
 * telemetry is at most 600 000 ms old and was taken for exactly the balance the position records; otherwise a dash with its reason. No DTO key is added: this is the observer's own row shape.
 */
function rfqObservation(position: TradePositionRecord, symbol: string | null, nowMs: number): TradePositionObservation {
  const fresh = position.lastQuoteWei !== null && position.lastQuoteAtMs !== null && position.lastQuoteAtMs >= nowMs - 600_000;
  const sameBalance = position.lastQuoteBalance !== null && position.lastQuoteBalance === position.tokenAmount;
  const quoted = fresh && sameBalance && position.status !== "closed";
  const pnl = quoted ? pnlBps(position.lastQuoteWei!, position.verifiedEntryAtomic ?? 0n) : null;
  return { positionId: position.positionId, symbol, decimals: 18, recordedPositionAmount: position.tokenAmount?.toString() ?? null,
    liveWalletBalance: quoted ? position.lastQuoteBalance!.toString() : null, currentQuoteWei: quoted ? position.lastQuoteWei!.toString() : null, pnlBps: pnl === null ? null : pnl.toString(),
    quoteStatus: position.status === "closed" ? "closed" : quoted ? "quoted" : "unavailable",
    reason: position.status === "closed" || quoted ? null : fresh ? "The last agent quote is for a different balance." : "No Binance quote from the agent in the last 10 minutes.",
    observedAt: position.lastQuoteAtMs ?? nowMs };
}

export function agenticUnsold(row: AgenticWallet, position: TradePositionRecord, sell: AgenticOrder | undefined): { code: string; atMs: number | null } | null {
  if (position.status === "closed" || !["ending", "ended"].includes(row.state)) return null;
  if (sell?.outcome === "open" && sell.dispatch === "spawned") return { code: "sale-unresolved", atMs: sell.claimedAt };
  if (row.endReason === "owner-signed-out") return { code: "ended-by-owner", atMs: row.endBlockers?.atMs ?? null };
  if (row.termEndAction === "keep") return { code: "kept-by-choice", atMs: row.hireEndMs };
  const blockers = row.endBlockers;
  const code = blockers?.halted ? "halted" : blockers?.paused ? "paused" : blockers?.settingsHold ? "settings-hold" : (blockers?.heldObligations ?? 0) > 0 ? "wallet-blocked" : null;
  if (code !== null) return { code, atMs: blockers?.atMs ?? null };
  if (row.drainRequestedAt !== null && position.lastSellRefusalAt !== null && position.lastSellRefusalAt >= row.drainRequestedAt) return {
    code: REFUSALS[position.lastSellRefusal ?? ""] ?? "unknown", atMs: position.lastSellRefusalAt };
  return { code: "unknown", atMs: blockers?.atMs ?? null };
}

/** Level and take-profit state words of the public DCA view (AGENTIC-DCA-SPEC 3.16). `triggered`, `cancelling`, `expired` and `failed` are written only by the retired limit build (legacy rows). */
function dcaStateWord(state: AgenticDcaOrder["state"]): string {
  switch (state) {
    case "planned": case "placing": return "pending";
    case "resting": case "triggered": case "cancelling": return "resting";
    case "cancelled": case "expired": case "failed": return "cancelled";
    default: return state;
  }
}

/** The public DCA block, field by field (no spread): every read that fails leaves its field null with a closed reason and never throws (DCA-DETAIL 3.2). Prices are raw-unit USDT x 1e8. */
async function agenticDcaPublicView(input: { store: AgenticStore; chain?: Pick<AgenticChain, "balance" | "metadata" | "poolState"> | undefined; cmc: CmcBudgetStore;
  row: AgenticWallet; s: TradeSettings; W: Address; agentId: string; orders: readonly AgenticOrder[] }): Promise<Record<string, unknown>> {
  const { store, row, s, W, agentId } = input;
  const token = agenticAddress(s.dcaToken!), pool = dcaPoolForToken(token)!;
  const rounds = await store.dcaRounds(agentId), dcaOrders = await store.dcaOrders(agentId);
  const round: AgenticDcaRound | undefined = rounds.at(-1);
  let mark: { e8: string; block: string } | null = null, mid: DcaPrice | null = null;
  try {
    const reading = input.chain?.poolState === undefined ? null : await input.chain.poolState(pool.pool);
    if (reading !== null) { mid = dcaMidPrice(pool, reading.sqrtPriceX96); mark = { e8: dcaPriceE8(mid).toString(), block: reading.block.toString() }; }
  } catch { mark = null; mid = null; }
  let wallet: { usdtWei: string; stockWei: string } | null = null;
  // M5-2 refinement: a failed wallet read carries its own closed reason, so the holding note shows a dash WITH a reason, never a bare dash.
  let walletReason: "wallet-unreadable" | null = null;
  try { if (input.chain !== undefined) wallet = { usdtWei: (await input.chain.balance(W, agenticAddress(USDT_56))).toString(), stockWei: (await input.chain.balance(W, token)).toString() }; } catch { wallet = null; }
  if (wallet === null) walletReason = "wallet-unreadable";
  const capital = BigInt(s.capitalQuoteWei!), realized = rounds.filter(r => r.phase === "settled").reduce((sum, r) => sum + BigInt(r.realizedPnlWei ?? "0"), 0n);
  const orderOf = (r: AgenticDcaRound, role: "level" | "tp", level: number | null): AgenticDcaOrder | undefined =>
    dcaOrders.filter(o => o.roundNo === r.roundNo && o.role === role && o.levelNo === level).sort((a, b) => a.createdAt - b.createdAt || a.orderKey.localeCompare(b.orderKey)).at(-1);
  const baseOf = (r: AgenticDcaRound): AgenticOrder | undefined => input.orders.filter(o => o.kind === "swap" && o.decisionId?.startsWith(`dca:${agentId}:${r.roundNo}:base:`) === true && o.outcome === "committed" && o.txHash !== null).at(-1);
  const priceE8 = (o: AgenticDcaOrder): string => dcaPriceE8({ num: BigInt(o.priceNum), den: BigInt(o.priceDen) }).toString();
  const roundView = round === undefined ? null : (() => {
    const cost = BigInt(round.costUsdtWei), held = BigInt(round.stockRaw), sold = BigInt(round.soldStockRaw), p0 = dcaP0(round);
    const base = baseOf(round);
    const levels = Array.from({ length: s.dcaMaxOrders! }, (_unused, index) => {
      const k = index + 1, o = orderOf(round, "level", k), price = dcaLevelAt(round, k, s.dcaStepBps!);
      return { levelNo: k, levelPriceE8: price === null ? null : dcaPriceE8(price).toString(), state: o === undefined ? "pending" : dcaStateWord(o.state),
        priceE8: o === undefined ? (price === null ? null : dcaPriceE8(price).toString()) : priceE8(o), usdtWei: o === undefined ? s.dcaOrderWei! : o.state === "filled" ? o.fillUsdtWei! : o.qtyAtomic,
        stockWei: o !== undefined && o.state === "filled" ? o.fillStockRaw! : "0", txHash: o?.txHash ?? null, closedBy: o?.closedBy ?? null };
    });
    const tp = orderOf(round, "tp", null);
    return { roundNo: round.roundNo, phase: round.phase, closeCause: round.closeCause, openedAt: round.openedAt, p0E8: p0 === null ? null : dcaPriceE8(p0).toString(),
      avgCostE8: held > 0n && cost > 0n ? dcaPriceE8({ num: cost, den: held }).toString() : null,
      tpTargetE8: held > 0n && cost > 0n ? dcaPriceE8(dcaTpTarget({ costUsdtWei: cost, stockWei: held, takeProfitBps: s.dcaTakeProfitBps! })).toString() : null,
      costUsdtWei: cost.toString(), stockHeldWei: (held - sold).toString(), realizedPnlWei: round.realizedPnlWei, levels,
      tp: tp === undefined ? null : { state: dcaStateWord(tp.state), priceE8: priceE8(tp), usdtWei: tp.state === "filled" ? tp.fillUsdtWei! : "0", stockWei: tp.qtyAtomic, txHash: tp.txHash, closedBy: tp.closedBy },
      base: p0 === null ? null : { usdtWei: round.p0UsdtWei!, stockWei: round.p0StockRaw!, txHash: base?.txHash ?? null, atMs: base?.createdAt ?? null } };
  })();
  const closed = rounds.filter(r => r.phase === "settled");
  const marked = rounds.filter(r => r.phase === "settled" || r.phase === "stopped" || r.phase === "ended" || r.phase === "interrupted").reduce((sum, r) => sum + BigInt(r.realizedPnlWei ?? r.markedPnlWei ?? "0"), 0n);
  const history = [...closed].reverse().slice(0, 12).map(r => ({ roundNo: r.roundNo, closeCause: r.closeCause, openedAt: r.openedAt, settledAt: r.settledAt,
    filledLevels: dcaOrders.filter(o => o.roundNo === r.roundNo && o.role === "level" && o.state === "filled").length, realizedPnlWei: r.realizedPnlWei, markedPnlWei: r.realizedPnlWei }));
  let equity: Record<string, string | null> | null = null;
  if (round !== undefined && ["starting", "active", "closing"].includes(round.phase) && mid !== null && mark !== null) {
    const held = BigInt(round.stockRaw), sold = BigInt(round.soldStockRaw);
    const value = dcaEquityWei({ capitalQuoteWei: capital, realizedPnlWei: realized, ledger: { costUsdtWei: BigInt(round.costUsdtWei), stockAcquiredWei: held, usdtCollectedWei: 0n, saleProceedsWei: BigInt(round.proceedsUsdtWei) },
      liveLevelMintedUsdtWei: 0n, orderUsdtWei: 0n, orderStockWei: 0n, walletRoundStockWei: held - sold, mid });
    equity = { equityWei: value.toString(), baselineWei: capital.toString(), stopAtWei: s.dcaStopLossBps == null ? null : dcaStopLineWei(capital, s.dcaStopLossBps).toString(), markE8: mark.e8, readingBlock: mark.block };
  }
  const fills: Record<string, unknown>[] = [];
  for (const r of rounds) {
    const base = baseOf(r);
    if (base !== undefined && r.p0UsdtWei !== null && r.p0StockRaw !== null) fills.push({ atMs: base.createdAt, roundNo: r.roundNo, kind: "base", levelNo: null, side: "buy", usdtWei: r.p0UsdtWei, stockWei: r.p0StockRaw, txHash: base.txHash });
  }
  for (const o of dcaOrders.filter(order => order.state === "filled")) {
    fills.push({ atMs: o.updatedAt, roundNo: o.roundNo, kind: o.role === "tp" ? "take-profit" : "level", levelNo: o.levelNo, side: o.side, usdtWei: o.fillUsdtWei!, stockWei: o.fillStockRaw!, txHash: o.txHash });
  }
  fills.sort((a, b) => Number(b["atMs"]) - Number(a["atMs"]));
  const actions: Record<string, unknown>[] = fills.filter(f => typeof f["txHash"] === "string").map(f => ({ kind: f["kind"] === "base" ? "start" : f["kind"] === "level" ? "fill" : "close", roundNo: f["roundNo"], state: "finished",
    txHash: f["txHash"], createdAt: f["atMs"], updatedAt: f["atMs"] })).slice(0, 50);
  const settled = await input.cmc.listAttempts(agentId, W).then(rows => rows.filter(a => a.state === "settled").map(a => a.createdAt), () => [] as number[]);
  const last = row.acceptedAt === null ? null : agenticLastActivityMs({ acceptedAt: row.acceptedAt, agentId, orders: input.orders, settledAttemptsCreatedAt: settled }, ["swap-quote", "x402-settled"]);
  return { token, symbol: pool.symbol, fee: pool.fee, usdtIsToken0: pool.usdtIsToken0, mark,
    settings: { stepBps: s.dcaStepBps, takeProfitBps: s.dcaTakeProfitBps, baseWei: s.entryWei, orderWei: s.dcaOrderWei, maxOrders: s.dcaMaxOrders,
      triggerE8: s.dcaTriggerPriceE8 ?? null, rangeMinE8: s.dcaRangeMinE8 ?? null, rangeMaxE8: s.dcaRangeMaxE8 ?? null, stopLossBps: s.dcaStopLossBps ?? null },
    round: roundView, rounds: { settled: closed.length, realizedPnlWei: realized.toString(), markedPnlWei: marked.toString(), lastSettledAt: closed.at(-1)?.settledAt ?? null, history },
    equity, wallet, walletReason, reason: round === undefined ? "no-active-round" : mark === null ? "mark-unavailable" : null,
    heldOrders: dcaOrders.filter(o => o.state === "held").length,
    history: { fills: fills.slice(0, 60) }, actions,
    keepAlive: { lastActivityAtMs: last, dueAtMs: last === null ? null : last + AGENTIC_PAID_KEEPALIVE_IDLE_MS, lastPaidAtMs: settled.length === 0 ? null : Math.max(...settled) } };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** AGENTIC-EARN-SPEC 3.15: the public Earn block, field by field. Chain reads and store rows only (never a Binance call); a failed read leaves its field null with a closed reason and never throws. */
async function agenticEarnPublicView(input: { chain?: Pick<AgenticChain, "earnBalances"> | undefined; row: AgenticWallet; orders: readonly AgenticOrder[]; products: readonly EarnProduct[]; nowMs: number }): Promise<Record<string, unknown>> {
  const { row, orders } = input, earnRows = orders.filter(o => (o.kind === "earn-deposit" || o.kind === "earn-redeem") && o.agentId === row.agentId).sort((a, b) => a.createdAt - b.createdAt);
  let balances: Awaited<ReturnType<NonNullable<AgenticChain["earnBalances"]>>> | null = null;
  try { if (row.walletAddress !== null && input.chain?.earnBalances !== undefined) balances = await input.chain.earnBalances(row.walletAddress); } catch { balances = null; }
  const value = (protocol: string): string | null => balances === null ? null : (protocol === "venus" ? balances.venusWei : balances.aaveWei).toString();
  const total = balances === null ? null : balances.venusWei + balances.aaveWei;
  const deposit = earnRows.filter(o => o.kind === "earn-deposit" && o.outcome === "committed").at(-1);
  const evidence = deposit === undefined ? null : earnEvidence(deposit.evidence);
  const open = earnRows.find(o => o.outcome === "open");
  // The Earn tab (store rows only): this agent's own committed rows, newest first, and per protocol the newest APY its deposits carried.
  // Operator gate-tool rows (evidence reason "gate") are tests, not the agent's decisions: the public history and rates leave them out.
  const committed = earnRows.filter(o => o.outcome === "committed" && earnEvidence(o.evidence)?.reason !== "gate").reverse();
  const rates: { venus: number | null; "aave-v3": number | null; atMs: number | null } = { venus: null, "aave-v3": null, atMs: null };
  for (const o of committed) {
    const apy = o.kind === "earn-deposit" ? earnEvidence(o.evidence)?.apyBps : undefined;
    for (const protocol of ["venus", "aave-v3"] as const) {
      const bps = apy?.[protocol];
      if (rates[protocol] === null && typeof bps === "number") { rates[protocol] = bps; rates.atMs ??= o.createdAt; }
    }
  }
  // Interest earned so far by this agent: what it holds now (chain) + the USDT its withdrawals returned - the USDT it supplied. Null with no supply,
  // a failed chain read, or a withdrawal whose returned USDT is unknown (a ratio row with no measured figure).
  let earnedWei: string | null = null;
  // Every committed row of the agent counts here, operator gate rows too: the chain total reflects them.
  const allCommitted = earnRows.filter(o => o.outcome === "committed");
  if (total !== null && allCommitted.some(o => o.kind === "earn-deposit")) {
    let flows: bigint | null = 0n;
    for (const o of allCommitted) {
      if (flows === null) break;
      const amount = o.amountAtomic !== null && /^[0-9]+$/u.test(o.amountAtomic) ? BigInt(o.amountAtomic) : null;
      if (o.kind === "earn-deposit") { flows = amount === null ? null : flows - amount; continue; }
      const moved = isRecord(o.evidence) && isRecord(o.evidence["post"]) ? o.evidence["post"]["usdtMoved"] : undefined;
      flows = typeof moved === "string" && /^[0-9]+$/u.test(moved) ? flows + BigInt(moved) : o.fromQty === "ratio:1" || amount === null ? null : flows + amount;
    }
    earnedWei = flows === null ? null : (total + flows).toString();
  }
  const activity = committed.slice(0, 20).flatMap(o => {
    const ev = earnEvidence(o.evidence);
    if (ev === null) return [];
    const deposit = o.kind === "earn-deposit", post = isRecord(o.evidence) && isRecord(o.evidence["post"]) ? o.evidence["post"]["usdtMoved"] : undefined;
    const other = ev.protocol === "venus" ? "aave-v3" : "venus";
    return [{ action: deposit ? "supply" : "withdraw", protocol: ev.protocol, atMs: o.createdAt,
      amountWei: deposit ? o.amountAtomic : typeof post === "string" && /^[0-9]+$/u.test(post) ? post : o.fromQty === "ratio:1" ? null : o.amountAtomic,
      apyBps: deposit ? ev.apyBps?.[ev.protocol] ?? null : null, otherApyBps: deposit ? ev.apyBps?.[other] ?? null : null, reason: ev.reason, txHash: o.txHash }];
  });
  return { products: input.products.map(p => ({ protocol: p.protocol, valueWei: value(p.protocol), reason: balances === null ? "chain-unreadable" : null, selfRescue: earnSelfRescueCommand(p) })),
    totalWei: total === null ? null : total.toString(), liquidWei: balances === null ? null : balances.usdt.toString(), rates, activity, earnedWei,
    lastDeposit: deposit === undefined || evidence === null ? null : { protocol: evidence.protocol, amountWei: deposit.amountAtomic, atMs: deposit.createdAt, txHash: deposit.txHash,
      apyBps: { venus: evidence.apyBps?.["venus"] ?? null, "aave-v3": evidence.apyBps?.["aave-v3"] ?? null } },
    open: open === undefined ? null : { kind: open.kind === "earn-deposit" ? "deposit" : "redeem", held: open.holdReason !== null,
      holdReason: open.holdReason === null ? null : EARN_HOLDS.has(open.holdReason) ? open.holdReason : "other" },
    withdrawingBeforeSignOut: (row.state === "ending" || row.state === "bound" && row.hireEndMs !== null && input.nowMs >= row.hireEndMs - EARN_REDEEM_ALL_MS) && (total === null || total >= EARN_DUST_WEI) };
}

export function createAgenticPublicView(input: { store: AgenticStore; agents: AgentStore; settings: TradeSettingsStore;
  positions: TradePositionStore; intents: TradeIntentStore; cmc: CmcBudgetStore; observer: TradeDetailObserver; killswitch: KillSwitch;
  /** Display only: the lane tickers the plane already knows. */ symbols?: () => ReadonlyMap<string, string> | undefined;
  /** Schedule agents only: the wallet reads, the holding's sell mark and the reference premium; each is resolved at call time and any failure leaves its field null. */
  chain?: Pick<AgenticChain, "balance" | "metadata" | "poolState" | "earnBalances">;
  /** Test seam: the Earn product table (production reads the constants of earnAdapter.ts). */ earnProducts?: readonly EarnProduct[];
  scheduleSellQuote?: () => ((input: { token: Address; amountInAtomic: bigint; slippageBps: number; signal?: AbortSignal }) => Promise<{ quotedOutAtomic: bigint }>) | undefined;
  schedulePremiumBps?: () => ((token: Address) => Promise<number | null>) | undefined;
  /** Portfolio agents only: the journal evidence of the legs, the lane display names and the pinned-pool valuation; each is resolved at call time and any failure degrades only its own field. */
  journal?: Pick<ExecutionJournal, "get" | "sumPendingQuoteSpendSince">;
  portfolioNames?: () => (() => Promise<ReadonlyMap<string, string>>) | undefined;
  portfolioValue?: () => ((input: { token: Address; amountInAtomic: bigint }) => Promise<bigint | null>) | undefined }) {
  return async (wallet: Address) => {
    const W = agenticAddress(wallet);
    const rows = (await input.store.wallets()).filter(r => r.walletAddress === W && r.agentId !== null && r.hireFacts !== null && ["bound", "ending", "ended"].includes(r.state));
    rows.sort((a, b) => Number(["bound", "ending"].includes(b.state)) - Number(["bound", "ending"].includes(a.state)) || (b.acceptedAt ?? 0) - (a.acceptedAt ?? 0));
    const row = rows[0], empty = { wallet: W, custody: "binance-agentic" as const, agent: null };
    if (row === undefined) return empty;
    const agent = await input.agents.getAgentById(row.agentId!);
    const stored = await input.settings.get(W, row.agentId!), settings = stored === null ? null : parseTradeSettings(stored.params);
    if (agent === null || agent.custodyModel !== "binance-agentic" || settings?.ok !== true) return empty;
    const s = settings.value.effective;
    const positions = await input.positions.list(W, agent.id);
    const schedule = isTradeScheduleSettings(s), portfolio = isTradePortfolioSettings(s), dca = isTradeDcaSettings(s);
    // A Schedule, portfolio or DCA agent has no held-position observer (Altana's view skips both too; a DCA agent has no positions).
    // E12: the RFQ-only positions of an RFQ-variant hire are not passed to the observer (it would price them from a dust pool or show nothing); one merged list feeds the summary and the rows (R3.6).
    const rfqOnly = new Set((row.hireFacts?.rfq?.v === 1 ? row.hireFacts.rfq.rfqOnly : []).map(token => token.toLowerCase()));
    const observations = schedule || portfolio || dca ? [] : [...await input.observer.observe(agent, positions.filter(p => !rfqOnly.has(p.token.toLowerCase()))),
      ...positions.filter(p => rfqOnly.has(p.token.toLowerCase())).map(p => rfqObservation(p, input.symbols?.()?.get(p.token.toLowerCase()) ?? null, Date.now()))];
    const orders = (await input.store.orders(W)).filter(o => o.agentId === agent.id);
    const sells = new Map<string, AgenticOrder>();
    for (const order of orders) if (order.side === "sell" && order.outcome === "open" && order.dispatch === "spawned" && order.decisionId !== null) {
      const intent = await input.intents.get(W, agent.id, order.decisionId);
      if (intent !== null) sells.set(intent.positionId, order);
    }
    const budget = await input.cmc.get(agent.id, W);
    const summary = tradeSummary(positions, observations, s.maxOpenPositions);
    const blocked = await input.killswitch.isBlocked(agent.id, W);
    const f = row.factsRead;
    const daily = f === null ? null : agenticDecimal(f.dailyLimit), used = f === null ? null : agenticDecimal(f.quotaUsed);
    const x402 = f === null ? null : agenticDecimal(f.x402DailyLimit), x402Used = f === null ? null : agenticDecimal(f.x402QuotaUsed);
    const quota = daily === null || used === null ? null : daily - used;
    const x402Quota = x402 === null || x402Used === null ? null : x402 - x402Used;
    const latestRuns = await input.positions.listRuns(W, agent.id, 50);
    const events = latestRuns.flatMap(run => (run.events ?? []).map(e => ({ atMs: run.createdAt,
      stage: STAGES.has(e.stage) ? e.stage : "other", code: CODES.has(e.code) ? e.code : "other",
      token: typeof e.token === "string" && /^0x[0-9a-f]{40}$/i.test(e.token) ? e.token : null }))).slice(0, 50);
    // Operator hotfix 2026-10-07: a paper meme hire also lists every notable cycle of the last 24 h (model asks, paper entries and exits, waits and failures),
    // so the run-log filters can be checked over a night; the routine quiet cycles stay the latest 50 only.
    const notable = row.hireFacts?.meme?.mode === "paper" && input.positions.listNotableMemeRuns !== undefined
      ? await input.positions.listNotableMemeRuns(W, agent.id, (await input.store.now()) - MEME_RUN_RETAIN_MS) : [];
    const seen = new Set(latestRuns.slice(0, 50).map(run => run.id));
    const listed = [...latestRuns.slice(0, 50), ...notable.filter(run => !seen.has(run.id))].sort((a, b) => b.createdAt - a.createdAt);
    // The agent's LLM decision text is public (operator ruling); every other free-text event reason can carry internal ids and is dropped.
    const runs = listed.map(run => ({ id: opaque(run.id),
      dryRun: run.dryRun, reason: publicRunReason(run.reason, portfolio), candidates: run.candidates, refusals: run.refusals, entries: run.entries, exits: run.exits, createdAt: run.createdAt,
      events: (run.events ?? []).map(e => ({ stage: e.stage, code: e.code, elapsedMs: e.elapsedMs,
        ...(e.token === undefined ? {} : { token: e.token }), ...(e.model === undefined ? {} : { model: e.model }),
        ...(e.confidence === undefined ? {} : { confidence: e.confidence }),
        ...(e.reason !== undefined && LLM_STAGES.has(e.stage) && LLM_DECISION_CODES.has(e.code) ? { reason: sanitizeMessage(e.reason) } : {}),
        // A portfolio refusal reason is a closed code the detail page decodes; any other portfolio event reason (a proof conflict names a decision id) stays private.
        ...(portfolio && e.reason !== undefined && e.stage === "screen" && e.code === "portfolio-refused" && PORTFOLIO_REASON.test(e.reason) ? { reason: e.reason } : {}),
        ...(e.reason !== undefined && e.stage === "earn" && EARN_REASON.test(e.reason) ? { reason: e.reason } : {}) })) }));
    // Same read as the Altana owner view (`_PROBE` and retired skills filtered, 50 caps); operation ids are opaque and the model's request reason is capped.
    // A DCA hire exposes no CMC log (AGENTIC-DCA-SPEC R7, DI12).
    const cmcLog = dca ? null : {
      news: (await input.cmc.listNews(agent.id, W)).filter(r => r.ticker !== "_PROBE" && isCurrentCmcSkill(r.skill)).slice(0, 50).map(r => ({
        ticker: r.ticker, skill: r.skill, status: r.status, asOfMs: r.asOfMs, expiresAtMs: r.expiresAtMs, sourceUrl: r.sourceUrl,
        paymentOperationId: r.paymentOperationId === null ? null : opaque(r.paymentOperationId), requestedBy: r.requestedBy ?? null,
        requestReason: r.requestReason == null ? null : sanitizeMessage(r.requestReason),
        context: r.context === null ? null : r.context.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").slice(0, 3_000) })),
      attempts: (await input.cmc.listAttempts(agent.id, W)).slice(0, 50).map(r => ({ operationId: opaque(r.operationId), attemptId: opaque(r.attemptId),
        state: r.state, contentState: r.contentState, amountWei: r.amountWei.toString(10), txHash: r.txHash,
        settlementTxHint: r.settlementTxHint !== null && /^0x[0-9a-f]{64}$/i.test(r.settlementTxHint) ? r.settlementTxHint : null,
        createdAt: r.createdAt, updatedAt: r.updatedAt })),
    };
    let scheduleView: Record<string, unknown> | undefined;
    if (schedule) {
      const token = s.scheduleToken! as Address, facts = projectAgenticSessionFacts(row), scheduleIntents = await input.intents.listSchedule(W, agent.id);
      const ledger = scheduleLedger({ anchorMs: scheduleAnchorMs(s.scheduleFirstAtSec, agent.createdAt), intervalSec: s.scheduleIntervalSec as ScheduleIntervalSec, nowMs: Date.now(),
        capitalQuoteWei: BigInt(s.capitalQuoteWei!), entryWei: BigInt(s.entryWei), platformFeeBps: 0, ttlSec: Math.max(0, facts.expiry - (facts.grantedAtSec ?? 0)),
        endKind: s.scheduleEndKind!, endAtSec: s.scheduleEndAtSec!, endRuns: s.scheduleEndRuns!, intents: scheduleIntents });
      const fills = positions.filter(p => p.status !== "closed"), verified = fills.filter(p => p.fillStatus === "verified");
      let walletBalance: bigint | null = null, nativeBalanceWei: string | null = null, decimals: number | null = null, symbol = input.symbols?.()?.get(token.toLowerCase()) ?? token.slice(0, 8);
      try { walletBalance = await input.chain!.balance(W, token); } catch { /* the field stays null */ }
      try { nativeBalanceWei = (await input.chain!.balance(W, null)).toString(10); } catch { /* the field stays null */ }
      try {
        const metadata = await input.chain!.metadata(token);
        if (Number.isInteger(metadata.decimals)) decimals = metadata.decimals;
        if (typeof metadata.symbol === "string" && metadata.symbol.length > 0) symbol = metadata.symbol;
      } catch { /* symbol falls back to the lane ticker, decimals stay null */ }
      let quoteWei: string | null = null, quoteReason: string | null = walletBalance === 0n ? "balance-zero" : "quote-unavailable";
      const sell = input.scheduleSellQuote?.();
      if (walletBalance !== null && walletBalance > 0n && sell !== undefined) {
        try { quoteWei = (await sell({ token, amountInAtomic: walletBalance, slippageBps: s.slippageBps })).quotedOutAtomic.toString(10); quoteReason = null; } catch { /* the view keeps the dash and its reason */ }
      }
      let premiumBps: number | null = null;
      try { premiumBps = await input.schedulePremiumBps?.()?.(token) ?? null; } catch { /* premiumBps stays null */ }
      scheduleView = { token, symbol, decimals, amountWei: s.entryWei, intervalSec: s.scheduleIntervalSec, anchorMs: scheduleAnchorMs(s.scheduleFirstAtSec, agent.createdAt),
        nextDueAtMs: ledger.nextDueAtMs, currentSlot: ledger.currentSlot, currentSlotTaken: ledger.currentSlotTaken, fills: ledger.fills, postponed: ledger.postponed,
        plannedBuys: ledger.plannedBuys, buysThisSession: ledger.buysThisSession, spentWei: ledger.spentWei.toString(10), remainingWei: ledger.remainingWei.toString(10),
        finished: ledger.finished, endKind: s.scheduleEndKind, endAtSec: s.scheduleEndAtSec, endRuns: s.scheduleEndRuns, marketHoursOnly: s.scheduleMarketHoursOnly,
        maxPremiumBps: s.scheduleMaxPremiumBps, firstAtSec: s.scheduleFirstAtSec, premiumBps, premiumLimitBps: s.scheduleMaxPremiumBps,
        nativeCapWei: null, nativeSpentWei: null, nativeBalanceWei, nativeBuysRefused: null, sessionExpiresAtSec: Math.floor(row.hireFacts!.hireEndMs / 1_000),
        holding: { walletBalance: walletBalance === null ? null : walletBalance.toString(10),
          boughtAtomic: verified.reduce((sum, p) => sum + (p.tokenAmount ?? 0n), 0n).toString(10),
          verifiedSpentWei: verified.reduce((sum, p) => sum + (p.verifiedEntryAtomic ?? 0n), 0n).toString(10), verifiedFills: verified.length, quoteWei, quoteReason } };
    }
    // Smart Portfolio: the Altana owner view's portfolio block, field by field. The executed quantity of a leg comes from the chain receipt stored with
    // its committed Agentic order (null with its reason otherwise). A failed required read gives null; a value, name or journal read that fails degrades
    // only its own field. Leg ids are opaque.
    let portfolioView: Record<string, unknown> | null | undefined;
    if (portfolio) {
      try {
        const swaps = new Map(orders.filter(o => o.kind === "swap").map(o => [o.idempotencyKey, o]));
        const executed = (intent: { idempotencyKey: string; decisionId: string }): bigint | null => {
          const order = swaps.get(intent.idempotencyKey);
          return order?.decisionId === intent.decisionId ? agenticExecutedQuantity(order) : null;
        };
        const ledger = await input.intents.listPortfolio(W, agent.id);
        const displayedLegs = [...ledger].reverse().slice(0, 50);
        const firstBuys = s.portfolioTokens!.map(token => ledger.find(intent => intent.side === "buy" && intent.token.toLowerCase() === token.toLowerCase()));
        const evidenceIntents = [...new Map([...displayedLegs, ...firstBuys.filter(intent => intent !== undefined)].map(intent => [intent.idempotencyKey, intent])).values()];
        const journalEvidence = new Map(await Promise.all(evidenceIntents.map(async intent => {
          try {
            const entry = await input.journal!.get(intent.idempotencyKey);
            return [intent.idempotencyKey, entry !== null && entry.ownerAddress.toLowerCase() === intent.ownerAddress.toLowerCase()
              && entry.agentId === intent.agentId && entry.decisionId === intent.decisionId ? entry : null] as const;
          } catch { return [intent.idempotencyKey, undefined] as const; }
        })));
        let names: ReadonlyMap<string, string> = new Map<string, string>();
        try { names = await input.portfolioNames?.()?.() ?? names; } catch { /* supplementary names do not gate the view */ }
        const verifiedBuy = (intent: typeof ledger[number]) => {
          const entry = journalEvidence.get(intent.idempotencyKey);
          const debit = entry?.state === "COMMITTED" ? entry.externalRef.actualQuoteSpendWei : undefined;
          return typeof debit === "string" && /^[1-9]\d*$/u.test(debit) ? debit : null;
        };
        const netInvested = ledger.reduce((sum, intent) => sum + (intent.side === "buy" ? intent.entryWei : -(intent.portfolioProceedsAtomic ?? 0n)), 0n);
        const capital = BigInt(s.capitalQuoteWei!);
        const cashCap = capital > netInvested ? capital - netInvested : 0n;
        const walletUsdt = await input.chain!.balance(W, USDT_56);
        const pending = await input.journal!.sumPendingQuoteSpendSince(agent.id, 0);
        const spendable = walletUsdt > pending ? walletUsdt - pending : 0n;
        const portfolioCash = spendable < cashCap ? spendable : cashCap;
        const idleUsdt = walletUsdt > cashCap ? walletUsdt - cashCap : 0n;
        const balances = await Promise.all(s.portfolioTokens!.map(token => input.chain!.balance(W, token as Address)));
        const readValue = input.portfolioValue?.();
        const values = await Promise.all(s.portfolioTokens!.map(async (token, index) => {
          try { return readValue === undefined ? null : await readValue({ token: token as Address, amountInAtomic: balances[index]! }); } catch { return null; }
        }));
        const complete = values.every(value => value !== null);
        const stockValue = complete ? values.reduce<bigint>((sum, value) => sum + value!, 0n) : null;
        const totalValue = stockValue === null ? null : stockValue + portfolioCash;
        const targets = totalValue === null ? null : s.portfolioWeightsBps!.map(weight => totalValue * BigInt(weight) / 10_000n);
        const tokenView = s.portfolioTokens!.map((token, index) => {
          const value = values[index] ?? null;
          const target = targets?.[index];
          const drift = complete && value !== null && target !== undefined && target > 0n
            ? Number((value > target ? value - target : target - value) * 10_000n / target) : null;
          const first = firstBuys[index];
          const firstJournal = first === undefined ? undefined : journalEvidence.get(first.idempotencyKey);
          const firstCost = first === undefined ? null : verifiedBuy(first);
          const firstQuantity = first === undefined ? null : executed(first);
          return { token, symbol: dcaPoolForToken(token)!.symbol, displayName: names.get(token.toLowerCase()) ?? null,
            initial: { quantityAtomic: firstQuantity?.toString(10) ?? null,
              quantityReason: first === undefined ? "no-buy" : firstQuantity !== null ? null : firstJournal === undefined ? "unavailable" : "not-verified",
              quoteWei: firstCost, quoteReason: first === undefined ? "no-buy" : firstJournal === undefined ? "unavailable" : firstCost === null ? "not-verified" : null },
            targetBps: s.portfolioWeightsBps![index],
            balanceAtomic: balances[index]!.toString(10), valueWei: value?.toString(10) ?? null,
            valueReason: value === null ? "quote-unavailable" : null,
            weightBps: complete && value !== null && totalValue !== null && totalValue > 0n ? Number(value * 10_000n / totalValue) : null,
            driftBps: drift };
        });
        const slot = currentSlot(agent.createdAt, s.portfolioIntervalSec as ScheduleIntervalSec, Date.now());
        const check = slot === null ? null : await input.intents.getPortfolioCheck(W, agent.id, slot);
        portfolioView = { tokens: tokenView, capitalQuoteWei: capital.toString(10), netInvestedWei: netInvested.toString(10),
          cashCapWei: cashCap.toString(10), walletUsdtWei: walletUsdt.toString(10), portfolioCashWei: portfolioCash.toString(10), idleUsdtWei: idleUsdt.toString(10),
          stockValueWei: stockValue?.toString(10) ?? null, totalValueWei: totalValue?.toString(10) ?? null,
          pnlWei: stockValue === null ? null : (stockValue - netInvested).toString(10),
          driftBps: complete ? Math.max(...tokenView.map(token => token.driftBps ?? 0)) : null,
          intervalSec: s.portfolioIntervalSec, anchorMs: agent.createdAt, currentSlot: slot,
          nextCheckAtMs: agent.createdAt + ((slot ?? 0) + 1) * s.portfolioIntervalSec! * 1_000,
          check: check === null ? null : { slot: check.slot, state: check.state, maxDriftBps: check.maxDriftBps,
            valueWei: check.valueWei.toString(10), checkedAt: check.checkedAt },
          legs: displayedLegs.map(intent => {
            const entry = journalEvidence.get(intent.idempotencyKey);
            const quoteWei = intent.side === "buy" ? verifiedBuy(intent)
              : intent.portfolioReceiptKey && intent.portfolioProceedsAtomic !== null && intent.portfolioProceedsAtomic !== undefined
                && intent.portfolioProceedsAtomic > 0n ? intent.portfolioProceedsAtomic.toString(10) : null;
            const hash = intent.txHash ?? entry?.externalRef.txHash ?? null;
            const quantity = executed(intent);
            return { slot: intent.portfolioSlot, side: intent.side,
              token: intent.token, symbol: dcaPoolForToken(intent.token)?.symbol ?? intent.token.slice(0, 8),
              amountWei: intent.amountWei.toString(10), quotedOutAtomic: intent.quotedOutAtomic?.toString(10) ?? null,
              minOutAtomic: intent.minOutAtomic?.toString(10) ?? null, proceedsAtomic: intent.portfolioProceedsAtomic?.toString(10) ?? null,
              state: intent.state, txHash: typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/u.test(hash) ? hash : null, createdAt: intent.createdAt,
              detail: { id: opaque(intent.decisionId), executionState: entry?.state ?? null,
                executionReason: entry === undefined ? "unavailable" : entry === null ? "not-recorded" : null,
                quantityAtomic: quantity?.toString(10) ?? null,
                quantityReason: quantity !== null ? null : entry === undefined ? "unavailable" : entry === null ? "not-recorded" : "not-verified", quoteWei,
                quoteReason: quoteWei === null ? intent.side === "buy" && entry === undefined ? "unavailable" : "not-verified" : null } };
          }) };
      } catch { portfolioView = null; }
    }
    // AGENTIC-MEME-STOCKS-SPEC 9.3: the paper ledger of a meme hire, field by field from agentic_meme_paper (`ref` only, no internal id); no Binance or data-plane call.
    let memeView: Record<string, unknown> | undefined;
    if (row.hireFacts?.meme?.mode === "paper") {
      const papers = await input.store.paperList(agent.id), closedPapers = papers.filter(p => p.status === "closed");
      // Operator 2026-10-07, display only: the market cap at entry from the position's own `entry` log row (written at openedAt), read in a zero-width window.
      const entryMcap = new Map<string, number>();
      for (const p of papers) {
        try {
          const entry = (await input.store.memeLog(agent.id, p.openedAt, p.openedAt)).find(r => r.kind === "entry" && typeof r.data === "object" && r.data !== null
            && (r.data as Record<string, unknown>)["positionId"] === p.positionId);
          const mcap = (entry?.data as Record<string, unknown> | undefined)?.["mcapUsd"];
          if (typeof mcap === "number" && Number.isFinite(mcap) && mcap > 0) entryMcap.set(p.positionId, mcap);
        } catch { /* a missing market cap shows the entry price instead */ }
      }
      const basis = (p: (typeof papers)[number]): bigint => BigInt(p.entryUsdt) + BigInt(p.gasBuyUsdt);
      const bpsOf = (value: bigint, base: bigint): number => Number((value - base) * 10_000n / base);
      const wins = closedPapers.filter(p => BigInt(p.pnlUsdt ?? "0") > 0n).length;
      memeView = { mode: "paper",
        tokens: [...new Map(papers.map(p => [p.token, { address: p.token, symbol: p.symbol, quoteSymbol: p.quoteSymbol }])).values()],
        paper: { summary: { open: papers.length - closedPapers.length, closed: closedPapers.length, wins,
          pnlUsdtWei: closedPapers.length === 0 ? null : closedPapers.reduce((sum, p) => sum + BigInt(p.pnlUsdt ?? "0"), 0n).toString(),
          winRateBps: closedPapers.length === 0 ? null : Math.floor(wins * 10_000 / closedPapers.length) },
          positions: papers.map((p, index) => ({ ref: "m" + index, token: p.token, symbol: p.symbol, quoteSymbol: p.quoteSymbol, venue: p.venueEntry, status: p.status,
            openedAt: p.openedAt, closedAt: p.closedAt, entryUsdtWei: p.entryUsdt, exitUsdtWei: p.exitUsdt, markUsdtWei: p.lastMarkUsdt, markAtMs: p.lastMarkAt,
            pnlBps: p.status === "closed" ? bpsOf(BigInt(p.pnlUsdt ?? "0") + basis(p), basis(p)) : p.lastMarkUsdt === null ? null : bpsOf(BigInt(p.lastMarkUsdt), basis(p)),
            closeCode: p.closeCode,
            // Operator hotfix 2026-10-06 (detail page parity): the paper token amount, the PnL in USDT on the same basis as pnlBps, the peak and the entry cost estimate.
            tokens: p.tokens, pnlUsdtWei: p.status === "closed" ? p.pnlUsdt : p.lastMarkUsdt === null ? null : (BigInt(p.lastMarkUsdt) - basis(p)).toString(),
            peakPnlBps: p.peakPnlBps, costBps: p.costBps, entryMcapUsd: entryMcap.get(p.positionId) ?? null })) } };
      // Operator hotfix 2026-10-06: the newest cycle as counts (always); the decision log only with AGENTIC_MEME_DECISION_LOG_PUBLIC=true (local debug). Reads stay in short windows.
      try {
        const nowMs = await input.store.now();
        const agentRows = await input.store.memeLog(agent.id, nowMs - 1_800_000, nowMs);
        memeView["lastCycle"] = memeLastCycle(agentRows);
        if (agenticMemeDecisionLogPublic(process.env)) memeView["decisionLog"] = memeDecisionLog(agentRows, await input.store.memeLog(null, nowMs - 300_000, nowMs),
          (await input.store.memeLog(null, nowMs - 1_800_000, nowMs)).filter(r => r.kind === "jev"));
      } catch { memeView["lastCycle"] = null; }
    }
    let dcaView: Record<string, unknown> | null | undefined;
    if (dca) {
      try { dcaView = await agenticDcaPublicView({ store: input.store, chain: input.chain, cmc: input.cmc, row, s, W, agentId: agent.id, orders }); }
      catch { dcaView = null; } // a failed read is a null block, not a missing key: the page still knows this is a DCA hire
    }
    // AGENTIC-EARN-SPEC 3.15: present only for an earn hire; a failed read is a null block, not a missing key.
    let earnView: Record<string, unknown> | null | undefined;
    if (row.hireFacts?.earn !== undefined) {
      try { earnView = await agenticEarnPublicView({ chain: input.chain, row, orders, products: input.earnProducts ?? EARN_PRODUCTS, nowMs: Date.now() }); } catch { earnView = null; }
    }
    const hold = row.settingsHold?.code;
    const holdCode = hold === undefined ? null : new Set(["trade-all-tokens", "abnormal-handling", "sign-in-time", "daily-limit", "x402-limit"]).has(hold) ? hold : "other";
    return { wallet: W, custody: "binance-agentic" as const, agent: {
      name: s.name, status: row.state === "ended" ? "ended" : row.state === "ending" ? "ending" : blocked || row.settingsHold !== null ? "held"
        : row.drainRequestedAt !== null ? "draining" : row.entriesStopped !== null ? "entries-stopped" : "running",
      holdCode, endReason: row.endReason, termDays: row.hireFacts!.termSec / 86_400, termEndAction: row.termEndAction,
      hireStartedAtMs: row.acceptedAt, entryCutoffAtMs: row.entryCutoffMs, hireEndsAtMs: row.hireEndMs,
      connection: row.state === "ended" ? "ended" : row.probe?.unreachableAtMs != null ? "unreachable" : "connected",
      lastProbeAtMs: row.probe?.lastAtMs ?? null, heldOrders: orders.filter(o => o.outcome === "open" && o.holdReason !== null).length, logoutPending: row.state === "ending",
      settings: { executionModel: s.executionModel, primaryModel: s.primaryModel, capitalQuoteWei: s.capitalQuoteWei, entryWei: s.entryWei,
        minEntryWei: s.minEntryWei, maxOpenPositions: s.maxOpenPositions, slippageBps: s.slippageBps, stopLossBps: s.stopLossBps,
        takeProfitBps: s.takeProfitBps, maxHoldSec: s.maxHoldSec, ...(portfolio ? { portfolioDriftBps: s.portfolioDriftBps } : {}) },
      limits: f === null || quota === null || x402Quota === null ? null : { readAtMs: f.readAtMs, dailyLimit: f.dailyLimit,
        quotaLeft: (quota < 0n ? "-" : "") + agenticUiString(quota < 0n ? -quota : quota),
        x402DailyLimit: f.x402DailyLimit, x402QuotaLeft: (x402Quota < 0n ? "-" : "") + agenticUiString(x402Quota < 0n ? -x402Quota : x402Quota),
        tradeAllTokens: f.tradeAllTokens, abnormalTxnHandling: f.abnormalTxnHandling === "AutoReject" ? "AutoReject" : "other", signInMaxTimeMs: f.signInMaxTimeMs },
      cmc: { authorizedTotalWei: budget?.authorizedTotalWei.toString() ?? "0", settledWei: budget?.settledWei.toString() ?? "0",
        remainingWei: budget === null ? "0" : (budget.authorizedTotalWei - budget.settledWei - budget.reservedWei).toString(),
        status: row.hireFacts!.hireSizing.cmcNewsEnabled === true ? budget?.status ?? "unavailable" : "disabled" },
      summary: { openPositions: summary["openPositions"], maxOpenPositions: summary["maxOpenPositions"], closedTrades: summary["closedTrades"],
        wins: summary["wins"], winRateBps: summary["winRateBps"], grossDeltaWei: summary["grossDeltaWei"], grossComplete: summary["grossComplete"] },
      positions: positions.map((p, index) => { const live = observations.find(o => o.positionId === p.positionId);
        return { ref: "p" + index, token: p.token, symbol: live?.symbol ?? null, decimals: live?.decimals ?? null, status: p.status === "closed" ? "closed" : p.status === "orphaned" || row.state !== "bound" ? "kept" : "open",
          openedAt: p.openedAt, closedAt: p.closedAt, entryUsdtWei: p.verifiedEntryAtomic?.toString() ?? null, tokenAmount: p.tokenAmount?.toString() ?? null,
          exitUsdtWei: p.exitWei?.toString() ?? null, pnlBps: live?.pnlBps ?? null, closeReason: p.closeReason === null ? null : REASONS.has(p.closeReason) ? p.closeReason : "other",
          entryTxHash: p.entryTxHash, exitTxHash: p.exitTxHash, unsold: agenticUnsold(row, p, sells.get(p.positionId)),
          live: live === undefined ? null : { liveWalletBalance: live.liveWalletBalance, currentQuoteWei: live.currentQuoteWei, quoteStatus: live.quoteStatus } };
      }), events, runs, ...(cmcLog === null ? {} as { cmcLog: NonNullable<typeof cmcLog> } : { cmcLog }),
      pinned: (row.hireFacts!.pinned ?? []).map(address => ({ address, symbol: input.symbols?.()?.get(address.toLowerCase()) ?? null })),
      // The ERC-8004 summary the owner routes already show; every field is also public on chain (registry event and token URI).
      ...(identityOwnerView(agent.erc8004Identity) === undefined ? {} : { erc8004Identity: identityOwnerView(agent.erc8004Identity) }),
      ...(scheduleView === undefined ? {} : { schedule: scheduleView }),
      ...(portfolioView === undefined ? {} : { portfolio: portfolioView }),
      ...(dcaView === undefined ? {} : { dca: dcaView }),
      ...(memeView === undefined ? {} : { meme: memeView }),
      ...(earnView === undefined ? {} : { earn: earnView }),
    } };
  };
}
export type AgenticPublicView = Awaited<ReturnType<ReturnType<typeof createAgenticPublicView>>>;
