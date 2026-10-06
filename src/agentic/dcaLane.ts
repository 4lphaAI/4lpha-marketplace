/** AGENTIC-DCA Revision 3 (R15, AGENTIC-DCA-SPEC R3.1 to R3.8): the per-agent cycle of the Agentic Auto DCA lane.
 *  Triggers are `agentic_dca_orders` rows watched by this step; nothing rests at Binance. A fire is one ordinary Agentic market swap through the executor
 *  (journal row, `swap` row, claim, spawn rule, resolver). One call per wallet per cycle, under the wallet fence: resolve fires, then arm, detect and fire, then the protective phases. */
import type { Address } from "viem";
import { dcaAhead, dcaEquityWei, dcaMidPrice, dcaPoolForToken, dcaPriceFromE8, dcaPriceRangeHold, dcaSettle, dcaStopLossBreached, dcaTpTarget, dcaTriggerMinOutWei,
  type DcaPool, type DcaPrice } from "../trade/dca.js";
import { isTradeDcaSettings, type TradeSettings } from "../trade/settings.js";
import { tradfiActualPremiumAllowed, type TradeWorkerDeps } from "../trade/worker.js";
import { freshTokenUsdFact } from "../trade/dataPlaneReads.js";
import { USDT_56 } from "../trade/settlement.js";
import type { TradeRequest } from "../http/wire.js";
import type { TradePositionStore } from "../store/tradePositions.js";
import type { ExecutionJournal } from "../store/journal.js";
import { agenticAddress, agenticDecimal, agenticQuoteRaw, agenticUiString, type AgenticDcaOrder, type AgenticDcaRound, type AgenticFence,
  type AgenticOrder, type AgenticWallet } from "./domain.js";
import type { BawResult, BawRunner } from "./baw.js";
import { decryptAgenticSession, type AgenticStore } from "./store.js";
import type { AgenticInstanceManager } from "./instances.js";
import { acquireAgenticFence } from "./obligations.js";
import { verifyAgenticSwap, type AgenticChain } from "./resolve.js";
import { readAgenticSettings, type AgenticExecutionDeps } from "./execute.js";
import type { AgenticCmc } from "./cmc.js";
import { DCA_BNB_RESERVE_WEI, DCA_BUY_BNB_FLOOR_WEI, DCA_COOLDOWN_MS, DCA_FAIL_BACKOFF_MS, DCA_THROTTLE_MS, DCA_TP_BNB_FLOOR_WEI, dcaAdvanceCounter, dcaBaseDecisionId, dcaBuyQuoteReaches, dcaCounterConfirmed,
  dcaCounterIn, dcaCounterOut, dcaFireDecisionId, dcaFireDecisionPrefix, dcaGte, dcaLevelAt, dcaLevelReached, dcaLte, dcaMinOut, dcaNextAttempt, dcaOrderKey, dcaP0, dcaPriceOf,
  dcaRoundOpen, dcaRoundStartBnbFloorWei, dcaSellQuoteReaches, dcaSlippageBps, dcaTargetReached, dcaTpQty } from "./dca.js";

export type AgenticDcaDeps = {
  store: AgenticStore; positions: Pick<TradePositionStore, "insertRun">; runner: BawRunner; masterKey: Buffer; instance: AgenticInstanceManager;
  chain: AgenticChain; execution: AgenticExecutionDeps; worker: TradeWorkerDeps; cmc: Pick<AgenticCmc, "protectedExposure">; journal: ExecutionJournal;
  /** AGENTIC_DCA_ENABLED of this process (agenticDcaEnabled). Off: no new round and no level arming or firing; the take profit still fires (R3.7, DI11). */
  dcaEnabled: boolean;
};
export type AgenticDcaOptions = { dryRun?: boolean; reconciliationOnly?: boolean; cmcOnly?: boolean };
type Stage = "cycle" | "buy" | "sell";

const WIND_DOWN_MS = 1_800_000;
const E18 = 10n ** 18n;
/** The per-process throttle (U7): a 429 or 503 answer to a lane quote skips this agent's Binance calls for 300 000 ms. */
const THROTTLES = new WeakMap<AgenticStore, Map<string, number>>();
const throttleOf = (store: AgenticStore): Map<string, number> => { let map = THROTTLES.get(store); if (map === undefined) { map = new Map(); THROTTLES.set(store, map); } return map; };
const ALLOW = { async evaluate() { return { verdict: "allow" as const, reasons: [] }; } };
/** The run codes the executor's refusal codes map to (the base buy and every fire). */
const DENIAL_CODES: Readonly<Record<string, string>> = { AGENTIC_LOW_BNB: "dca-low-bnb", AGENTIC_LOW_USDT: "dca-cash-low", AGENTIC_DAILY_QUOTA: "dca-quota-low", AGENTIC_SETTINGS_HOLD: "dca-settings-hold" };

type Ctx = {
  deps: AgenticDcaDeps; options: AgenticDcaOptions; row: AgenticWallet; fence: AgenticFence; s: TradeSettings; W: Address; agentId: string; stock: Address; pool: DcaPool;
  N: number; a: number; D: bigint; base: bigint; capital: bigint; now: number;
  mid: DcaPrice | null; sqrt: bigint | null; midBlock: bigint | null; multiplier: bigint | null;
  rounds: AgenticDcaRound[]; orders: AgenticDcaOrder[];
  events: { stage: Stage; code: string }[]; refusals: number; entries: number; exits: number; code: string | null;
  settingsRead: Record<string, unknown> | null | undefined;
};

const roundOf = (ctx: Ctx, roundNo: number): AgenticDcaRound | undefined => ctx.rounds.find(r => r.roundNo === roundNo);
const openRound = (ctx: Ctx): AgenticDcaRound | undefined => ctx.rounds.find(dcaRoundOpen);
const note = (ctx: Ctx, code: string, stage: Stage = "cycle"): void => { if (!ctx.events.some(e => e.stage === stage && e.code === code) || code.startsWith("dca-level")) ctx.events.push({ stage, code }); };
/** The cycle's code is the first one set; every code is also an event of the run, so a hold that came after a fire is still visible. */
const setCode = (ctx: Ctx, code: string): void => { ctx.code ??= code; note(ctx, code); };

async function setOrder(ctx: Ctx, order: AgenticDcaOrder, patch: Partial<AgenticDcaOrder>): Promise<AgenticDcaOrder> {
  const next = await ctx.deps.store.patchDcaOrder(order, patch);
  if (next === null) throw new Error("dca-conflict");
  ctx.orders = ctx.orders.map(o => o.orderKey === next.orderKey ? next : o);
  return next;
}
async function setRound(ctx: Ctx, round: AgenticDcaRound, patch: Partial<AgenticDcaRound>): Promise<AgenticDcaRound> {
  const next = await ctx.deps.store.patchDcaRound(round, patch);
  if (next === null) throw new Error("dca-conflict");
  ctx.rounds = ctx.rounds.map(r => r.roundNo === next.roundNo ? next : r);
  return next;
}
async function reload(ctx: Ctx): Promise<void> {
  ctx.orders = await ctx.deps.store.dcaOrders(ctx.agentId);
  ctx.rounds = await ctx.deps.store.dcaRounds(ctx.agentId);
}
function session(ctx: Ctx) {
  return decryptAgenticSession(ctx.row, ctx.deps.masterKey);
}

const throttled = (ctx: Ctx): boolean => (throttleOf(ctx.deps.store).get(ctx.agentId) ?? 0) > ctx.now;
/** A SERVICE_UNAVAILABLE answer to a lane quote starts the throttle. */
function recordAnswer(ctx: Ctx, result: BawResult, atMs: number): void {
  if (result.kind === "cli-error" && result.name === "SERVICE_UNAVAILABLE") throttleOf(ctx.deps.store).set(ctx.agentId, atMs + DCA_THROTTLE_MS);
}

/* ------------------------------------ holds and gates (R3.7) ------------------------------------ */

type Holds = { paused: boolean; off: boolean; held: boolean; throttled: boolean; settings: boolean };
async function heldOrder(ctx: Ctx): Promise<boolean> {
  if (ctx.orders.some(o => o.state === "held")) return true;
  const swaps = (await ctx.deps.store.orders(ctx.W)).filter(o => o.agentId === ctx.agentId && o.kind === "swap" && o.decisionId?.startsWith(`dca:${ctx.agentId}:`) === true);
  return swaps.some(o => o.outcome === "open" && o.holdReason !== null);
}
async function computeHolds(ctx: Ctx): Promise<Holds> {
  // The shared worker holds the full kill switch; its type only names the pause write, so the read is narrowed here (a missing method means not blocked: the claim refuses anyway).
  const ks = ctx.deps.worker.killswitch as unknown as { isBlocked?: (agentId: string, owner: Address) => Promise<boolean> } | undefined;
  const paused = typeof ks?.isBlocked === "function" ? await ks.isBlocked(ctx.agentId, ctx.W) : false;
  return { paused, off: !ctx.deps.dcaEnabled, held: await heldOrder(ctx), throttled: throttled(ctx), settings: ctx.row.settingsHold !== null };
}
/** The closed hold code that stops a fire, in the order of R3.7. */
function blockCode(h: Holds): string | null {
  return h.paused ? "paused" : h.off ? "dca-agentic-off" : h.held ? "dca-order-held" : h.throttled ? "dca-binance-throttled" : h.settings ? "dca-settings-hold" : null;
}
/** AGENTIC-EARN-SPEC 3.10: an earn hire's buys leave one more operation reserve (0.0004 BNB) for a redeem; sells and other hires are unchanged. */
const earnReserve = (ctx: Ctx): bigint => ctx.row.hireFacts?.earn !== undefined ? DCA_BNB_RESERVE_WEI : 0n;
async function bnb(ctx: Ctx): Promise<bigint | null> { try { return await ctx.deps.chain.balance(ctx.W, null); } catch { return null; } }
async function usdtBalance(ctx: Ctx): Promise<bigint | null> { try { return await ctx.deps.chain.balance(ctx.W, agenticAddress(USDT_56)); } catch { return null; } }
async function stockBalance(ctx: Ctx): Promise<bigint | null> { try { return await ctx.deps.chain.balance(ctx.W, ctx.stock); } catch { return null; } }
/** The 24 h USDT cap (5 x capital): filled and firing buys only; a rolled-back buy does not count. */
function dayCap(ctx: Ctx, orders: readonly AgenticOrder[], extra: bigint): boolean {
  const used = orders.filter(o => o.side === "buy" && o.kind === "swap" && o.dispatch === "spawned" && o.outcome !== "rolled-back"
    && o.claimedAt !== null && o.claimedAt >= ctx.now - 86_400_000).reduce((sum, o) => sum + BigInt(o.amountAtomic ?? "0"), 0n);
  return used + extra <= 5n * ctx.capital;
}
/** Once per cycle, before the first base buy or level fire. A hold written by the read is visible on the returned row. */
async function readSettingsOnce(ctx: Ctx): Promise<Record<string, unknown> | null> {
  if (ctx.settingsRead !== undefined) return ctx.settingsRead;
  ctx.settingsRead = await readAgenticSettings(ctx.deps.execution, ctx.agentId, ctx.fence);
  if (ctx.settingsRead === null) { const w = await ctx.deps.store.byAgent(ctx.agentId); if (w !== null) ctx.row = w; }
  return ctx.settingsRead;
}
const quotaLeft = (read: Record<string, unknown>): bigint => (agenticDecimal(read["dailyLimit"]) ?? 0n) - (agenticDecimal(read["quotaUsed"]) ?? 0n);

const levelsOf = (ctx: Ctx, round: AgenticDcaRound): AgenticDcaOrder[] => ctx.orders.filter(o => o.roundNo === round.roundNo && o.role === "level");
const tpsOf = (ctx: Ctx, round: AgenticDcaRound): AgenticDcaOrder[] => ctx.orders.filter(o => o.roundNo === round.roundNo && o.role === "tp");
const entryOpen = (ctx: Ctx): boolean => ctx.row.entriesStopped === null && ctx.row.drainRequestedAt === null && ctx.row.entryCutoffMs !== null && ctx.now + 5_000 < ctx.row.entryCutoffMs;
const realizedOf = (ctx: Ctx): bigint => ctx.rounds.filter(r => r.phase === "settled").reduce((sum, r) => sum + BigInt(r.realizedPnlWei ?? "0"), 0n);
/** The round's own marked value: proceeds + (H - sold) x mid - C. Null when no finalized mid was read. */
const markedPnl = (ctx: Ctx, round: AgenticDcaRound): string | null => ctx.mid === null ? null
  : (BigInt(round.proceedsUsdtWei) + (BigInt(round.stockRaw) - BigInt(round.soldStockRaw)) * ctx.mid.num / ctx.mid.den - BigInt(round.costUsdtWei)).toString();

/* ------------------------------------ arming rows (R3.3) ------------------------------------ */

type RowState = "resting" | "skipped" | "below-range";
async function insertRow(ctx: Ctx, round: AgenticDcaRound, role: "level" | "tp", levelNo: number | null, side: "buy" | "sell", price: DcaPrice, qty: bigint, state: RowState): Promise<AgenticDcaOrder> {
  const attempt = dcaNextAttempt(ctx.orders, ctx.agentId, round.roundNo, role, levelNo), at = await ctx.deps.store.now();
  const row: AgenticDcaOrder = { orderKey: dcaOrderKey(ctx.agentId, round.roundNo, role, levelNo, attempt), agentId: ctx.agentId, walletAddress: ctx.W, roundNo: round.roundNo, role, levelNo, side,
    priceNum: price.num.toString(), priceDen: price.den.toString(), triggerSent: "", qtySent: "", qtyAtomic: qty.toString(), slippagePct: "0.5",
    placeOrderKey: null, cancelOrderKey: null, strategyId: null, listStatus: null, unitQty: null, unitTrigger: null, state, closedBy: null, holdReason: null,
    txHash: null, fillUsdtWei: null, fillStockRaw: null, executor: "wallet", rowVersion: 1, createdAt: at, updatedAt: at };
  if (!await ctx.deps.store.insertDcaOrder(row)) throw new Error("dca-conflict");
  await reload(ctx);
  return row;
}
/** Disarm: `resting` -> `cancelled`. A `placing` row is never disarmed; it waits for its swap. No Binance call. */
async function disarm(ctx: Ctx, round: AgenticDcaRound, only?: (o: AgenticDcaOrder) => boolean): Promise<void> {
  for (const order of ctx.orders.filter(o => o.roundNo === round.roundNo && o.state === "resting" && (only === undefined || only(o)))) {
    await setOrder(ctx, order, { state: "cancelled", closedBy: "plane" });
  }
}
/** The swap row of a fire: its `place_order_key`. A legacy limit row (kind not `swap`) is not a swap. */
async function swapOf(ctx: Ctx, order: AgenticDcaOrder): Promise<AgenticOrder | null> {
  return order.placeOrderKey === null ? null : await ctx.deps.store.getOrder(order.placeOrderKey);
}
/** R3.2 / R31.1: a fire is in flight while its row is `placing` with an open, unheld swap row, a committed swap not yet booked (LOW-3), or no swap row at all. */
async function inFlight(ctx: Ctx, round: AgenticDcaRound): Promise<boolean> {
  for (const order of ctx.orders.filter(o => o.roundNo === round.roundNo && o.state === "placing")) {
    const swap = await swapOf(ctx, order);
    // LOW-3: a committed swap whose receipt could not be booked this cycle still has its fill to book, so the round does not end without it.
    if (swap === null || swap.kind === "swap" && (swap.outcome === "committed" || swap.outcome === "open" && swap.holdReason === null)) return true;
  }
  return false;
}

/* ------------------------------ resolveFires and booking (R3.5, R31.1) ------------------------------ */

/** R2.11: rejected fires count; at 3 the planner backs off 600 000 ms. */
async function countFailure(ctx: Ctx, round: AgenticDcaRound): Promise<void> {
  const fresh = roundOf(ctx, round.roundNo) ?? round, streak = fresh.failStreak + 1;
  await setRound(ctx, fresh, streak >= 3 ? { failStreak: 0, backoffUntilMs: ctx.now + DCA_FAIL_BACKOFF_MS } : { failStreak: streak });
}
/** `placing` / `held` -> `resting` while the round is `active` (re-armed), else `cancelled`. */
async function backToArmed(ctx: Ctx, order: AgenticDcaOrder, rejected: boolean): Promise<void> {
  const round = roundOf(ctx, order.roundNo);
  if (round?.phase === "active") await setOrder(ctx, order, { state: "resting", holdReason: null });
  else await setOrder(ctx, order, { state: "cancelled", closedBy: "plane", holdReason: null });
  if (rejected && round !== undefined && dcaRoundOpen(round)) await countFailure(ctx, round);
}
/** Booking: `verifyAgenticSwap` on the finalized two-RPC receipt, then ONE `bookDcaFill` transaction (order, round ledger, and for a breached sell `entries_stopped`). */
async function bookSwapFill(ctx: Ctx, order: AgenticDcaOrder, swap: AgenticOrder): Promise<boolean> {
  const round = roundOf(ctx, order.roundNo);
  if (round === undefined || swap.txHash === null) return false;
  const partial = typeof swap.evidence === "object" && swap.evidence !== null && "disposition" in swap.evidence && swap.evidence.disposition === "commit-partial";
  const verified = await verifyAgenticSwap(ctx.deps.chain, swap, swap.txHash, partial);
  if (verified === null) { setCode(ctx, "dca-waiting"); return false; }
  const buy = order.side === "buy";
  const orderPatch: Partial<AgenticDcaOrder> = { state: "filled", closedBy: "binance", txHash: swap.txHash, fillUsdtWei: (buy ? verified.input : verified.output).toString(),
    fillStockRaw: (buy ? verified.output : verified.input).toString(), executor: "wallet", holdReason: null };
  const roundPatch: Partial<AgenticDcaRound> = buy
    ? { costUsdtWei: (BigInt(round.costUsdtWei) + verified.input).toString(), stockRaw: (BigInt(round.stockRaw) + verified.output).toString() }
    : { soldStockRaw: (BigInt(round.soldStockRaw) + verified.input).toString(), proceedsUsdtWei: (BigInt(round.proceedsUsdtWei) + verified.output).toString(), tpFilledAt: ctx.now,
        ...(round.phase === "active" ? { phase: "closing" as const } : {}) };
  // D4 (R3.5): a take-profit sale that landed below its own minOut stops new exposure. (completeFill marks only buys `breached`, so the sale is measured here.)
  const breached = !buy && swap.minOutAtomic !== null && verified.output < BigInt(swap.minOutAtomic);
  const entriesStopped = breached ? { reason: "dca-fill-above-level" as const, out: verified.output.toString(), min: swap.minOutAtomic!, atMs: ctx.now } : null;
  const booked = await ctx.deps.store.bookDcaFill({ order, orderPatch, round, roundPatch, entriesStopped });
  if (booked === null) throw new Error("dca-conflict");
  await reload(ctx);
  if (buy) ctx.entries += 1; else ctx.exits += 1;
  note(ctx, buy ? "dca-level-filled" : "dca-round-closed", buy ? "buy" : "sell");
  setCode(ctx, buy ? "dca-level-filled" : "dca-round-closed");
  if (breached) { note(ctx, "dca-fill-above-level", "sell"); setCode(ctx, "dca-fill-above-level"); }
  const wallet = await ctx.deps.store.byAgent(ctx.agentId); if (wallet !== null) ctx.row = wallet;
  return true;
}
/** Every cycle before arming: each `placing` or `held` row follows its swap row. The generic resolver loop has already run this cycle. */
async function resolveFires(ctx: Ctx): Promise<void> {
  for (const order of [...ctx.orders]) {
    if (order.state !== "placing" && order.state !== "held" || order.placeOrderKey === null) continue;
    const current = ctx.orders.find(o => o.orderKey === order.orderKey)!;
    const swap = await swapOf(ctx, current);
    // R31.1: no swap row after the fire CAS proves nothing was sent (beginSwap writes the journal and the swap row in one transaction): a rollback, not counted.
    if (swap === null) { if (current.state === "placing") await backToArmed(ctx, current, false); continue; }
    if (swap.kind !== "swap") continue; // a legacy limit row: only the gate tool's rollback moves it (R3.8)
    if (swap.outcome === "committed" && swap.txHash !== null) { await bookSwapFill(ctx, current, swap); continue; }
    if (swap.outcome === "rolled-back") {
      const rejected = typeof swap.evidence === "object" && swap.evidence !== null && "code" in swap.evidence && swap.evidence.code === "binance-rejected";
      await backToArmed(ctx, current, rejected); continue;
    }
    if (swap.outcome === "open" && swap.holdReason !== null && current.state === "placing") await setOrder(ctx, current, { state: "held", holdReason: swap.holdReason });
  }
}

/* ------------------------------------ stop loss and the end of a round ------------------------------------ */

/** R2.5 valuation: what the wallet holds, one finalized pool reading, two readings at distinct blocks at least 60 s apart confirm. */
async function stopLossCheck(ctx: Ctx, round: AgenticDcaRound): Promise<AgenticDcaRound> {
  const bps = ctx.s.dcaStopLossBps;
  if (bps === null || bps === undefined || ctx.mid === null || ctx.midBlock === null) return round;
  const cost = BigInt(round.costUsdtWei), held = BigInt(round.stockRaw), sold = BigInt(round.soldStockRaw);
  const equity = dcaEquityWei({ capitalQuoteWei: ctx.capital, realizedPnlWei: realizedOf(ctx), ledger: { costUsdtWei: cost, stockAcquiredWei: held, usdtCollectedWei: 0n, saleProceedsWei: BigInt(round.proceedsUsdtWei) },
    liveLevelMintedUsdtWei: 0n, orderUsdtWei: 0n, orderStockWei: 0n, walletRoundStockWei: held - sold, mid: ctx.mid });
  const previous = dcaCounterIn(round.stopCounter);
  const next = dcaAdvanceCounter(previous, { qualifies: dcaStopLossBreached(equity, ctx.capital, bps), block: ctx.midBlock, atMs: ctx.now, intervalMs: 60_000 });
  const confirmed = dcaCounterConfirmed(next);
  const changed = next.count !== previous.count || next.lastBlock !== previous.lastBlock || next.lastAtMs !== previous.lastAtMs;
  if (!changed && !confirmed) return round;
  return setRound(ctx, round, { stopCounter: next.count === 0 ? null : dcaCounterOut(next), ...(confirmed ? { phase: "stopping" as const } : {}) });
}
async function settleRound(ctx: Ctx, round: AgenticDcaRound): Promise<void> {
  const held = BigInt(round.stockRaw), sold = BigInt(round.soldStockRaw);
  if (held <= 0n || sold > held) { setCode(ctx, "dca-order-held"); return; }
  const settled = dcaSettle({ ledger: { costUsdtWei: BigInt(round.costUsdtWei), stockAcquiredWei: held, usdtCollectedWei: 0n, saleProceedsWei: BigInt(round.proceedsUsdtWei) }, stockSoldWei: sold });
  await setRound(ctx, round, { phase: "settled", closeCause: "take-profit", realizedPnlWei: settled.realizedPnlWei.toString(), settledAt: ctx.now });
  setCode(ctx, "dca-cooldown");
}
const carryOf = (round: AgenticDcaRound): { stock: bigint; cost: bigint } => {
  const held = BigInt(round.stockRaw), sold = BigInt(round.soldStockRaw);
  if (held <= 0n) return { stock: 0n, cost: 0n };
  const settled = dcaSettle({ ledger: { costUsdtWei: BigInt(round.costUsdtWei), stockAcquiredWei: held, usdtCollectedWei: 0n, saleProceedsWei: BigInt(round.proceedsUsdtWei) }, stockSoldWei: sold });
  return { stock: settled.carriedStockWei, cost: settled.carriedCostWei };
};

/** `stopping` and `winding-down` (R3.6): disarm every trigger, then end in the same cycle once no fire is in flight. Nothing is sold; no Binance call. */
async function phaseProtective(ctx: Ctx, round: AgenticDcaRound): Promise<void> {
  const stop = round.phase === "stopping";
  await disarm(ctx, round);
  round = roundOf(ctx, round.roundNo)!;
  if (!await inFlight(ctx, round)) {
    await setRound(ctx, round, { phase: stop ? "stopped" : "ended", closeCause: stop ? "stop-loss" : "term-end", markedPnlWei: markedPnl(ctx, round), settledAt: ctx.now });
    if (stop) {
      setCode(ctx, "dca-stopped");
      if (ctx.row.state === "bound") ctx.row = await ctx.deps.store.leaveBound(ctx.row, "stop-loss") ?? ctx.row;
    } else setCode(ctx, "dca-orders-cancelled");
    note(ctx, stop ? "dca-stopped" : "dca-orders-cancelled");
    return;
  }
  ctx.code = stop ? "dca-stopping" : "dca-winding-down";
  note(ctx, ctx.code);
}
/** `closing`: levels are disarmed; the round settles when no order is `placing` or `held` (the ledger is complete, R21.1). */
async function phaseClosing(ctx: Ctx, round: AgenticDcaRound): Promise<void> {
  await disarm(ctx, round);
  round = roundOf(ctx, round.roundNo)!;
  const orders = ctx.orders.filter(o => o.roundNo === round.roundNo);
  if (orders.every(o => o.state !== "placing" && o.state !== "held")) await settleRound(ctx, round);
  else setCode(ctx, "dca-waiting");
}

/* ------------------------------------ the executor hand-off ------------------------------------ */

/** The executor takes the wallet fence itself (it is not reentrant), so the step hands it over for a swap and takes it back for the booking. */
async function runExecutor(ctx: Ctx, agent: NonNullable<Awaited<ReturnType<TradeWorkerDeps["agentStore"]["getAgentById"]>>>, request: TradeRequest,
  identity: ReturnType<TradeWorkerDeps["executionIdentity"]>): Promise<Awaited<ReturnType<TradeWorkerDeps["executor"]["execute"]>>> {
  await ctx.deps.store.releaseFence(ctx.fence);
  try { return await ctx.deps.worker.executor.execute({ agent, request, scanGate: ALLOW, ...identity, deps: ctx.deps.worker.executorDeps }); }
  finally { ctx.fence = await acquireAgenticFence(ctx.deps.store, ctx.W, ctx.deps.instance.row.instanceId) ?? ctx.fence; }
}
/** The lane quote (R3.4 step 4): a read, not activity. Null when it did not answer a usable amount. */
async function laneQuote(ctx: Ctx, side: "buy" | "sell", amount: bigint): Promise<bigint | null> {
  const { deps } = ctx;
  if (ctx.multiplier === null || await deps.store.renewFence(ctx.fence) === null) return null;
  const usdt = agenticAddress(USDT_56);
  const fromQty = side === "buy" ? agenticUiString(amount) : agenticUiString(amount * ctx.multiplier / E18);
  const quote = await deps.runner.run(["market-order", "quote", "--fromToken", side === "buy" ? usdt : ctx.stock, "--toToken", side === "buy" ? ctx.stock : usdt, "--fromTokenQty", fromQty, "--binanceChainId", "56"], session(ctx));
  recordAnswer(ctx, quote, await deps.store.now());
  const out = quote.kind === "ok" && typeof quote.data === "object" && quote.data !== null ? (quote.data as Record<string, unknown>)["toCoinAmount"] : null;
  const quoted = typeof out !== "string" ? null : side === "buy" ? agenticQuoteRaw(out, agenticUiString(ctx.multiplier)) : agenticDecimal(out);
  return quoted === null || quoted <= 0n ? null : quoted;
}
const slippageOf = (ctx: Ctx): number => dcaSlippageBps((ctx.deps.worker.executorDeps as { trade?: { maxSlippageBps?: number } }).trade?.maxSlippageBps);

/* ------------------------------------ the base buy (3.6 step 5, R17.1) ------------------------------------ */

/** A new round: after the cooldown, before the entry cutoff. The row is inserted `starting` with the carry of the last settled round and the base buy follows in the same pass. */
async function newRound(ctx: Ctx, h: Holds): Promise<void> {
  const last = ctx.rounds.at(-1);
  if (last !== undefined && last.phase !== "settled") return;
  if (last !== undefined && ctx.now - (last.tpFilledAt ?? last.settledAt ?? 0) < DCA_COOLDOWN_MS) { setCode(ctx, "dca-cooldown"); return; }
  if (!entryOpen(ctx)) return;
  const block = blockCode(h);
  if (block !== null) { setCode(ctx, block); return; }
  const carry = last === undefined ? { stock: 0n, cost: 0n } : carryOf(last);
  const row: AgenticDcaRound = { agentId: ctx.agentId, roundNo: (last?.roundNo ?? 0) + 1, walletAddress: ctx.W, phase: "starting", baseOrderKey: null, p0UsdtWei: null, p0StockRaw: null,
    costUsdtWei: carry.cost.toString(), stockRaw: carry.stock.toString(), carriedCostWei: carry.cost.toString(), carriedStockRaw: carry.stock.toString(), soldStockRaw: "0", proceedsUsdtWei: "0",
    realizedPnlWei: null, markedPnlWei: null, stopCounter: null, tpFilledAt: null, closeCause: null, failStreak: 0, backoffUntilMs: null, tpDueAt: null, openedAt: ctx.now, settledAt: null,
    rowVersion: 1, createdAt: ctx.now, updatedAt: ctx.now };
  if (!await ctx.deps.store.insertDcaRound(row)) throw new Error("dca-conflict");
  await reload(ctx);
  await phaseStarting(ctx, roundOf(ctx, row.roundNo)!, h);
}
/** The base market buy of a round and its booking. Priced from Binance's own quote, premium-checked against the reference, bound by the executor's journal and fill check. */
async function phaseStarting(ctx: Ctx, round: AgenticDcaRound, h: Holds): Promise<void> {
  const { deps } = ctx;
  const decisionPrefix = `dca:${ctx.agentId}:${round.roundNo}:base:`;
  const bases = (await deps.store.orders(ctx.W)).filter(o => o.kind === "swap" && o.decisionId?.startsWith(decisionPrefix) === true).sort((a, b) => a.createdAt - b.createdAt);
  const latest = bases.at(-1);
  if (latest !== undefined && latest.outcome === "committed" && latest.txHash !== null) { await bookBase(ctx, round, latest); return; }
  if (latest !== undefined && latest.outcome === "open") { setCode(ctx, latest.holdReason === null ? "dca-waiting" : "dca-order-held"); return; }
  const block = blockCode(h);
  if (block !== null) { setCode(ctx, block); return; }
  if (!entryOpen(ctx)) { setCode(ctx, "dca-waiting"); return; }
  if (ctx.mid === null || ctx.sqrt === null || ctx.multiplier === null) { ctx.refusals += 1; setCode(ctx, "cost-unavailable"); return; }
  const rangeMin = ctx.s.dcaRangeMinE8 == null ? null : BigInt(ctx.s.dcaRangeMinE8), rangeMax = ctx.s.dcaRangeMaxE8 == null ? null : BigInt(ctx.s.dcaRangeMaxE8);
  const range = dcaPriceRangeHold({ pool: ctx.pool, sqrtPriceX96: ctx.sqrt, rangeMinE8: rangeMin, rangeMaxE8: rangeMax });
  if (range !== null) { setCode(ctx, range); return; }
  const trigger = ctx.s.dcaTriggerPriceE8 == null ? null : BigInt(ctx.s.dcaTriggerPriceE8);
  const triggerOn = round.roundNo === 1 && trigger !== null;
  if (triggerOn && !dcaLte(ctx.mid, dcaPriceFromE8(trigger))) { setCode(ctx, "dca-trigger-not-reached"); return; }
  const gas = await bnb(ctx);
  if (gas === null || gas < dcaRoundStartBnbFloorWei(ctx.N) + earnReserve(ctx)) { setCode(ctx, "dca-low-bnb"); return; }
  const cash = await usdtBalance(ctx);
  if (cash === null || cash < ctx.base + BigInt(ctx.a) * ctx.D + await deps.cmc.protectedExposure(ctx.agentId)) { setCode(ctx, "dca-cash-low"); return; }
  if (!dayCap(ctx, await deps.store.orders(ctx.W), ctx.base)) { setCode(ctx, "dca-cap-exhausted"); return; }
  const read = await readSettingsOnce(ctx);
  if (read === null) { setCode(ctx, ctx.row.settingsHold !== null ? "dca-settings-hold" : "cost-unavailable"); return; }
  if (quotaLeft(read) < ctx.base) { setCode(ctx, "dca-quota-low"); return; }
  const quotedOut = await laneQuote(ctx, "buy", ctx.base);
  if (quotedOut === null) { ctx.refusals += 1; setCode(ctx, throttled(ctx) ? "dca-binance-throttled" : "cost-unavailable"); return; }
  if (!await premiumOk(ctx, ctx.base, quotedOut)) return;
  // R17.1: the base is held to the same s = min(50, trade.maxSlippageBps) bps as every fire.
  const minOut = dcaMinOut(quotedOut, slippageOf(ctx));
  if (triggerOn && minOut < dcaTriggerMinOutWei(ctx.base, trigger)) { ctx.refusals += 1; setCode(ctx, "dca-trigger-not-reached"); return; }
  const agent = await deps.worker.agentStore.getAgentById(ctx.agentId);
  if (agent === null || agent.sessionFacts === null) { setCode(ctx, "dca-waiting"); return; }
  const attempt = bases.length + 1;
  const request: TradeRequest = { decisionId: dcaBaseDecisionId(ctx.agentId, round.roundNo, attempt), venue: "pancake_v3", side: "buy", token: ctx.stock, amountWei: ctx.base,
    minOutWei: minOut, quotedOutWei: quotedOut, route: { hops: [], fees: [ctx.pool.fee] }, settlementAsset: "USDT", platformFeeAtomic: 0n };
  const identity = deps.worker.executionIdentity(agent, request);
  round = await setRound(ctx, round, { baseOrderKey: identity.idempotencyKey });
  const result = await runExecutor(ctx, agent, request, identity);
  if (result.kind === "committed") {
    const committed = await deps.store.getOrder(identity.idempotencyKey);
    if (committed !== null && committed.outcome === "committed" && committed.txHash !== null) { await bookBase(ctx, round, committed); return; }
    setCode(ctx, "dca-waiting"); return;
  }
  ctx.refusals += 1;
  const code = result.kind === "denied" || result.kind === "rolled-back" ? result.code : "unknown";
  setCode(ctx, DENIAL_CODES[code] ?? "dca-waiting");
}
/** D14 (a): every Agentic market buy of a bStock passes the data plane's premium guard. A missing or stale fact is `cost-unavailable` (the trigger stays armed); a premium above the cap is `dca-waiting`. */
async function premiumOk(ctx: Ctx, amountIn: bigint, quotedOut: bigint): Promise<boolean> {
  const { deps } = ctx;
  const rows = await deps.worker.dataPlane.universe("bstocks"), tokens = await deps.worker.dataPlane.tokensBatch([USDT_56]);
  const fact = rows?.find(r => r.address.toLowerCase() === ctx.stock.toLowerCase())?.rwa;
  const settlementUsd = freshTokenUsdFact(tokens.find(t => t.address.toLowerCase() === USDT_56.toLowerCase()), Date.now());
  if (fact === undefined || settlementUsd === null) { ctx.refusals += 1; setCode(ctx, "cost-unavailable"); return false; }
  if (!await tradfiActualPremiumAllowed({ deps: deps.worker, fact, token: ctx.stock, amountInAtomic: amountIn, amountOutAtomic: quotedOut, settlementUsd })) { ctx.refusals += 1; setCode(ctx, "dca-waiting"); return false; }
  return true;
}
/** Booking of the base: the ladder anchor P0 is the receipt (input / output), not the quote; the round goes active. */
async function bookBase(ctx: Ctx, round: AgenticDcaRound, order: AgenticOrder): Promise<void> {
  if (order.txHash === null) return;
  const verified = await verifyAgenticSwap(ctx.deps.chain, order, order.txHash);
  if (verified === null) { setCode(ctx, "dca-waiting"); return; }
  await setRound(ctx, round, { phase: "active", p0UsdtWei: verified.input.toString(), p0StockRaw: verified.output.toString(),
    costUsdtWei: (BigInt(round.carriedCostWei) + verified.input).toString(), stockRaw: (BigInt(round.carriedStockRaw) + verified.output).toString() });
  ctx.entries += 1; note(ctx, "dca-base-bought", "buy"); setCode(ctx, "dca-base-bought");
  const wallet = await ctx.deps.store.byAgent(ctx.agentId); if (wallet !== null) ctx.row = wallet;
}

/* ------------------------------------ the active round: arm, detect, fire (R3.3, R3.4) ------------------------------------ */

const samePrice = (order: AgenticDcaOrder, price: DcaPrice): boolean => BigInt(order.priceNum) * price.den === price.num * BigInt(order.priceDen);

/** The take profit: exactly one row of the round is `resting` or `placing` while H - sold > 0; an armed one is re-priced (T, Q) by one CAS. */
async function armTp(ctx: Ctx, round: AgenticDcaRound): Promise<void> {
  const held = BigInt(round.stockRaw) - BigInt(round.soldStockRaw), cost = BigInt(round.costUsdtWei);
  if (held <= 0n || cost <= 0n) return;
  const tps = tpsOf(ctx, round);
  if (tps.some(o => o.state === "placing" || o.state === "held")) return;
  const balance = await stockBalance(ctx);
  if (balance === null) return;
  const qty = dcaTpQty(BigInt(round.stockRaw), BigInt(round.soldStockRaw), balance);
  if (qty <= 0n) return;
  const target = dcaTpTarget({ costUsdtWei: cost, stockWei: BigInt(round.stockRaw), takeProfitBps: ctx.s.dcaTakeProfitBps! });
  const armed = tps.find(o => o.state === "resting");
  if (armed === undefined) { await insertRow(ctx, round, "tp", null, "sell", target, qty, "resting"); return; }
  if (!samePrice(armed, target) || BigInt(armed.qtyAtomic) !== qty) await setOrder(ctx, armed, { priceNum: target.num.toString(), priceDen: target.den.toString(), qtyAtomic: qty.toString() });
}
/** Levels: `a` rows armed or firing, in ladder order. A level the mid has already passed is skipped, never bought at market (N6 (a)). */
async function armLevels(ctx: Ctx, round: AgenticDcaRound): Promise<void> {
  if (ctx.mid === null || dcaP0(round) === null) return;
  let need = ctx.a - levelsOf(ctx, round).filter(o => o.state === "resting" || o.state === "placing").length;
  const rangeMin = ctx.s.dcaRangeMinE8 == null ? null : dcaPriceFromE8(BigInt(ctx.s.dcaRangeMinE8));
  for (let k = 1; k <= ctx.N && need > 0; k += 1) {
    const latest = levelsOf(ctx, round).filter(o => o.levelNo === k).sort((x, y) => x.createdAt - y.createdAt || x.orderKey.localeCompare(y.orderKey)).at(-1);
    if (latest !== undefined && ["filled", "skipped", "below-range", "held", "resting", "placing"].includes(latest.state)) continue;
    const price = dcaLevelAt(round, k, ctx.s.dcaStepBps!);
    if (price === null) return;
    if (rangeMin !== null && !dcaGte(price, rangeMin)) { await insertRow(ctx, round, "level", k, "buy", price, ctx.D, "below-range"); continue; }
    if (dcaLevelReached(ctx.mid, price)) { await insertRow(ctx, round, "level", k, "buy", price, ctx.D, "skipped"); continue; }
    await insertRow(ctx, round, "level", k, "buy", price, ctx.D, "resting");
    need -= 1;
  }
}

type FireOutcome = "committed" | "not-fired";
/** One fire (R3.4 steps 3 to 9) of an armed row whose condition holds. A row is written only at step 7. */
async function fire(ctx: Ctx, round: AgenticDcaRound, order: AgenticDcaOrder, h: Holds): Promise<FireOutcome> {
  const { deps } = ctx;
  const tp = order.role === "tp", buy = order.side === "buy", price = dcaPriceOf(order);
  // Step 3: holds (the flag-off exception is the take profit), the back-off, an open wallet obligation, then the money gates.
  const block = blockCode(tp ? { ...h, off: false } : h);
  if (block !== null) { setCode(ctx, block); return "not-fired"; }
  if (round.backoffUntilMs !== null && round.backoffUntilMs > ctx.now) { setCode(ctx, "dca-retry-backoff"); return "not-fired"; }
  if (await deps.store.walletObligations(ctx.W)) { setCode(ctx, "dca-waiting"); return "not-fired"; }
  const gas = await bnb(ctx);
  if (gas === null || gas < (tp ? DCA_TP_BNB_FLOOR_WEI : DCA_BUY_BNB_FLOOR_WEI + earnReserve(ctx))) { setCode(ctx, "dca-low-bnb"); return "not-fired"; }
  let amount = ctx.D;
  if (buy) {
    const cash = await usdtBalance(ctx);
    if (cash === null || cash < ctx.D + await deps.cmc.protectedExposure(ctx.agentId)) { setCode(ctx, "dca-cash-low"); return "not-fired"; }
    if (!dayCap(ctx, await deps.store.orders(ctx.W), ctx.D)) { setCode(ctx, "dca-cap-exhausted"); return "not-fired"; }
    const read = await readSettingsOnce(ctx);
    if (read === null) { setCode(ctx, ctx.row.settingsHold !== null ? "dca-settings-hold" : "cost-unavailable"); return "not-fired"; }
    if (quotaLeft(read) < ctx.D) { setCode(ctx, "dca-quota-low"); return "not-fired"; }
  } else {
    const balance = await stockBalance(ctx);
    if (balance === null) { setCode(ctx, "cost-unavailable"); return "not-fired"; }
    amount = dcaTpQty(BigInt(round.stockRaw), BigInt(round.soldStockRaw), balance);
    if (amount <= 0n) { setCode(ctx, "dca-waiting"); return "not-fired"; }
  }
  // Step 4 and 5: the lane quote must still reach the level or the target itself.
  const quotedOut = await laneQuote(ctx, buy ? "buy" : "sell", amount);
  if (quotedOut === null) { ctx.refusals += 1; setCode(ctx, throttled(ctx) ? "dca-binance-throttled" : "cost-unavailable"); return "not-fired"; }
  if (buy && !await premiumOk(ctx, amount, quotedOut)) return "not-fired";
  if (!(buy ? dcaBuyQuoteReaches(quotedOut, amount, price) : dcaSellQuoteReaches(quotedOut, amount, price))) { setCode(ctx, "dca-quote-short"); return "not-fired"; }
  // Step 6: minOut keeps the fill within s bps of the quote.
  const minOut = dcaMinOut(quotedOut, slippageOf(ctx));
  const agent = await deps.worker.agentStore.getAgentById(ctx.agentId);
  if (agent === null || agent.sessionFacts === null) { setCode(ctx, "dca-waiting"); return "not-fired"; }
  // Step 7: the request and the fire CAS (`resting` -> `placing`, with the swap row's key) before the executor is called.
  const prefix = dcaFireDecisionPrefix(ctx.agentId, round.roundNo, order.role, order.levelNo);
  const n = (await deps.store.orders(ctx.W)).filter(o => o.kind === "swap" && o.decisionId?.startsWith(prefix) === true).length + 1;
  const request: TradeRequest = { decisionId: dcaFireDecisionId(ctx.agentId, round.roundNo, order.role, order.levelNo, n), venue: "pancake_v3", side: order.side, token: ctx.stock, amountWei: amount,
    minOutWei: minOut, quotedOutWei: quotedOut, route: { hops: [], fees: [ctx.pool.fee] }, settlementAsset: "USDT", platformFeeAtomic: 0n };
  const identity = deps.worker.executionIdentity(agent, request);
  const placing = await setOrder(ctx, order, { state: "placing", placeOrderKey: identity.idempotencyKey, qtyAtomic: amount.toString() });
  // Step 8 and 9: execute, then the outcome.
  const result = await runExecutor(ctx, agent, request, identity);
  if (result.kind === "committed") {
    const swap = await deps.store.getOrder(identity.idempotencyKey);
    if (swap !== null && swap.outcome === "committed" && swap.txHash !== null && await bookSwapFill(ctx, placing, swap)) return "committed";
    setCode(ctx, "dca-waiting"); return "not-fired";
  }
  if (result.kind === "unknown") { setCode(ctx, "dca-waiting"); return "not-fired"; }
  ctx.refusals += 1;
  // A refusal or a rollback re-arms the row. Only a Binance rejection counts toward the back-off; a seal (quote below minOut, claim refused) or a denial does not.
  await setOrder(ctx, ctx.orders.find(o => o.orderKey === placing.orderKey)!, { state: "resting", holdReason: null });
  if (result.kind === "rolled-back" && result.code === "binance-rejected") await countFailure(ctx, roundOf(ctx, round.roundNo)!);
  setCode(ctx, DENIAL_CODES[result.code] ?? "dca-waiting");
  return "not-fired";
}

async function phaseActive(ctx: Ctx, round: AgenticDcaRound, h: Holds): Promise<void> {
  // R3.4 step 1: no finalized reading means no arming and no fire this cycle.
  if (ctx.mid === null) { ctx.refusals += 1; setCode(ctx, "cost-unavailable"); return; }
  await armTp(ctx, round);
  round = roundOf(ctx, round.roundNo)!;
  // Levels are armed only with the flag on, before the cutoff and with entries open; at the cutoff or when entries stop, armed levels are disarmed and the take profit stays.
  if (!entryOpen(ctx)) await disarm(ctx, round, o => o.role === "level");
  else if (!h.off) await armLevels(ctx, round);
  round = roundOf(ctx, round.roundNo)!;
  // Detection: the take profit first (a committed TP fire leaves `active`, so no level fires), then the armed levels in ladder order, at most `a`, stopping at the first fire that does not commit (D13 (a)).
  const tp = tpsOf(ctx, round).find(o => o.state === "resting");
  if (tp !== undefined && dcaTargetReached(ctx.mid, dcaPriceOf(tp)) && await fire(ctx, round, tp, h) === "committed") {
    // The booked sale moved the round to `closing`: its levels are disarmed and it settles in this same cycle when nothing is in flight (R3.6).
    await phaseClosing(ctx, roundOf(ctx, round.roundNo)!);
    return;
  }
  round = roundOf(ctx, round.roundNo)!;
  if (round.phase !== "active") return;
  let fired = 0;
  for (const level of levelsOf(ctx, round).filter(o => o.state === "resting").sort((x, y) => (x.levelNo ?? 0) - (y.levelNo ?? 0))) {
    if (fired >= ctx.a || !dcaLevelReached(ctx.mid, dcaPriceOf(level))) continue;
    fired += 1;
    if (await fire(ctx, roundOf(ctx, round.roundNo)!, ctx.orders.find(o => o.orderKey === level.orderKey)!, h) !== "committed") break;
  }
  if (ctx.code === null) setCode(ctx, "dca-watching");
}

/* ------------------------------------------- plan and the step ------------------------------------------- */

async function plan(ctx: Ctx): Promise<void> {
  const h = await computeHolds(ctx);
  // The holds of R3.7 are checked first and name the cycle (paused, flag off, held order, throttle, settings hold).
  const hold = blockCode(h);
  if (hold !== null) setCode(ctx, hold);
  let round = openRound(ctx);
  const windDown = ctx.row.hireEndMs !== null && ctx.now >= ctx.row.hireEndMs - WIND_DOWN_MS;
  if (round !== undefined && ["starting", "active", "closing"].includes(round.phase)) {
    round = windDown ? await setRound(ctx, round, { phase: "winding-down" }) : await stopLossCheck(ctx, round);
  }
  if (round === undefined) { if (ctx.row.state === "bound" && !windDown) await newRound(ctx, h); return; }
  switch (round.phase) {
    case "stopping": case "winding-down": await phaseProtective(ctx, round); return;
    case "closing": await phaseClosing(ctx, round); return;
    case "starting": await phaseStarting(ctx, round, h); return;
    case "active": await phaseActive(ctx, round, h); return;
    default: return;
  }
}
/** The writer of `interrupted` (R22.1 (f), R3.6): an `ended` row with an open round. It also writes the marked PnL when a finalized mid was read. */
async function interruptOpenRound(ctx: Ctx, row: AgenticWallet): Promise<void> {
  const round = openRound(ctx);
  if (round === undefined) return;
  const cause = round.phase === "stopping" ? "stop-loss" as const : row.endReason === "owner-signed-out" ? "owner-end" as const : "term-end" as const;
  await setRound(ctx, round, { phase: "interrupted", closeCause: cause, markedPnlWei: markedPnl(ctx, round), settledAt: ctx.now });
}

async function newCtx(deps: AgenticDcaDeps, options: AgenticDcaOptions, row: AgenticWallet, fence: AgenticFence): Promise<Ctx> {
  const s = row.hireParams!.settings, stock = agenticAddress(s.dcaToken!);
  const ctx: Ctx = { deps, options, row, fence, s, W: row.walletAddress!, agentId: row.agentId!, stock, pool: dcaPoolForToken(stock)!, N: s.dcaMaxOrders!, a: dcaAhead(s.dcaMaxOrders!),
    D: BigInt(s.dcaOrderWei!), base: BigInt(s.entryWei), capital: BigInt(s.capitalQuoteWei!), now: await deps.store.now(), mid: null, sqrt: null, midBlock: null, multiplier: null,
    rounds: [], orders: [], events: [], refusals: 0, entries: 0, exits: 0, code: null, settingsRead: undefined };
  await reload(ctx);
  return ctx;
}
/** The stock multiplier and the pool reading of this cycle (chain reads, no Binance call); a failed read leaves its value null and nothing that needs it runs. */
async function readFacts(ctx: Ctx): Promise<void> {
  try { ctx.multiplier = await ctx.deps.chain.multiplier(ctx.stock); } catch { ctx.multiplier = null; }
  try {
    const reading = ctx.deps.chain.poolState === undefined ? null : await ctx.deps.chain.poolState(ctx.pool.pool);
    if (reading !== null) { ctx.sqrt = reading.sqrtPriceX96; ctx.mid = dcaMidPrice(ctx.pool, reading.sqrtPriceX96); ctx.midBlock = reading.block; }
  } catch { /* a failed pool read leaves the mid null: no valuation, no arming, no fire */ }
}

export async function runAgenticDcaStep(deps: AgenticDcaDeps, input: AgenticWallet, options: AgenticDcaOptions = {}): Promise<AgenticWallet> {
  if (input.hireParams === null || !isTradeDcaSettings(input.hireParams.settings) || input.agentId === null || input.walletAddress === null || input.hireFacts === null) return input;
  if (options.dryRun === true || options.cmcOnly === true) return input;
  if (dcaPoolForToken(agenticAddress(input.hireParams.settings.dcaToken!)) === null) return input;
  const W = input.walletAddress, agentId = input.agentId, { store } = deps;
  // An ended row with no open round has nothing left to do: it never takes the wallet fence again (audit LOW-5).
  if (input.state === "ended" && !(await store.dcaRounds(agentId)).some(dcaRoundOpen)) return input;
  const fence = await acquireAgenticFence(store, W, deps.instance.row.instanceId);
  if (fence === null) return input;
  let ctx: Ctx | undefined;
  try {
    ctx = await newCtx(deps, options, input, fence);
    await readFacts(ctx);
    // LOW-3: an owner end books a fill whose swap committed before the sign-out (chain reads only) before the round is recorded as interrupted.
    if (input.state === "ended") { await resolveFires(ctx); await interruptOpenRound(ctx, input); return ctx.row; }
    if (!["bound", "ending"].includes(input.state)) return input;
    await resolveFires(ctx);
    if (options.reconciliationOnly === true) return ctx.row;
    await plan(ctx);
    // R21.6: after the step the lane's row is the freshest one written.
    return await store.byAgent(agentId) ?? ctx.row;
  } catch (error) {
    console.error("agentic_dca_step_failed", error instanceof Error ? error.message : "unknown");
    if (ctx !== undefined) setCode(ctx, "dca-waiting");
    return await store.byAgent(agentId) ?? ctx?.row ?? input;
  } finally {
    await store.releaseFence(ctx?.fence ?? fence);
    if (ctx !== undefined && options.reconciliationOnly !== true && input.state !== "ended") {
      const code = ctx.code ?? "dca-waiting";
      try {
        await deps.positions.insertRun({ agentId, ownerAddress: W, dryRun: false, candidates: 1, refusals: ctx.refusals, entries: ctx.entries, exits: ctx.exits,
          reason: `${code};candidates=1;refusals=${ctx.refusals};entries=${ctx.entries};exits=${ctx.exits};held-no-price=0`,
          events: [...ctx.events.map(e => ({ stage: e.stage, code: e.code, elapsedMs: 0 })), { stage: "cycle", code, elapsedMs: 0 }] });
      } catch { console.error("agentic_dca_run_failed"); }
    }
  }
}
