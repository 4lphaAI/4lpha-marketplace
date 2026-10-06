/** AGENTIC-EARN-SPEC 3.4 to 3.11 and R11: the per-wallet Earn step of an opted-in Agentic hire. Idle USDT is supplied to one of two pinned products (Venus, Aave v3) through the Binance `defi` commands and
 *  redeemed when the strategy needs cash or the term ends. One step per wallet per cycle under the wallet fence: resolve this agent's earn rows, then (when no row or other obligation is open) read the chain,
 *  decide at most ONE operation and dispatch it as one durable `agentic_orders` row. Value is always chain truth (two RPCs, one finalized block); Binance replies never set an amount. */
import type { Address } from "viem";
import { dcaAhead } from "../trade/dca.js";
import { scheduleAnchorMs, scheduleLedger, type ScheduleIntervalSec } from "../trade/schedule.js";
import { isTradeDcaSettings, isTradeScheduleSettings } from "../trade/settings.js";
import type { TradePositionStore } from "../store/tradePositions.js";
import type { TradeWorkerDeps } from "../trade/worker.js";
import { agenticDecimal, projectAgenticSessionFacts, type AgenticFence, type AgenticOrder, type AgenticWallet } from "./domain.js";
import type { BawResult, BawRunner } from "./baw.js";
import { decryptAgenticSession, type AgenticStore } from "./store.js";
import type { AgenticInstanceManager } from "./instances.js";
import { acquireAgenticFence } from "./obligations.js";
import { readAgenticSettings, recordAgenticConnection } from "./execute.js";
import type { AgenticChain, AgenticEarnBalances, AgenticEarnPins } from "./resolve.js";
import type { AgenticCmc } from "./cmc.js";
import { dcaRoundOpen } from "./dca.js";
import { EARN_PRODUCTS, EARN_SERVER_REFUSALS, EARN_USDT, earnCliName, earnConfigured, earnDepositArgs, earnListArgs, earnPreviewArgs, earnProductOf, earnQty, earnRedeemArgs, earnResponse,
  parseEarnList, parseEarnPreview, type EarnAmount, type EarnProduct, type EarnProtocol } from "./earnAdapter.js";
import { EARN_BACKOFF_MS, EARN_DELTA_MIN_AGE_MS, EARN_DEPOSIT_BNB_FLOOR_WEI, EARN_DEPOSIT_SPACING_MS, EARN_DUST_WEI, EARN_RECEIPT_WAIT_MS, EARN_REDEEM_ALL_MS, EARN_REDEEM_BNB_FLOOR_WEI,
  earnBalanceDelta, earnDecide, earnEvidence, earnIsRatio, earnNeeds, verifyEarnReceipt, type EarnApy, type EarnEvidence, type EarnNeeds } from "./earn.js";

const E16 = 10n ** 16n, E18 = 10n ** 18n;
export type AgenticEarnDeps = {
  store: AgenticStore; positions: Pick<TradePositionStore, "insertRun" | "listRuns" | "listOpen">; runner: BawRunner; masterKey: Buffer; instance: AgenticInstanceManager; chain: AgenticChain;
  /** AGENTIC_EARN_ENABLED of this process: off, no deposit is ever claimed; resolution, redeems and the sign-out guard still run. */
  earnEnabled: boolean;
  /** Test seam: the product table. Production never passes it, so the null-pinned constants of earnAdapter.ts apply. */
  products?: readonly EarnProduct[];
  gateRunId?: string;
  /** The shared worker's kill switch, read as `isBlocked` (a halt or a pause). Absent means not blocked: the claim refuses anyway. */
  killswitch?: unknown;
};
export type AgenticEarnStepDeps = AgenticEarnDeps & { worker: TradeWorkerDeps; cmc: Pick<AgenticCmc, "protectedExposure"> };
export type AgenticEarnOptions = { dryRun?: boolean; reconciliationOnly?: boolean; cmcOnly?: boolean };
type Event = { code: string; reason?: string };
type Ctx = { deps: AgenticEarnDeps; row: AgenticWallet; fence: AgenticFence; W: Address; agentId: string; products: readonly EarnProduct[];
  events: Event[]; refusals: number; balances: AgenticEarnBalances | null | undefined };

const isEarnRow = (o: AgenticOrder): boolean => o.kind === "earn-deposit" || o.kind === "earn-redeem";
const PINS = new WeakMap<object, AgenticEarnPins>();
const note = (ctx: Ctx, code: string, reason?: string): void => { ctx.events.push(reason === undefined ? { code } : { code, reason }); if (code === "earn-refused") ctx.refusals += 1; };
const session = (ctx: Ctx) => decryptAgenticSession(ctx.row, ctx.deps.masterKey);
const earnRows = async (ctx: Ctx): Promise<AgenticOrder[]> => (await ctx.deps.store.orders(ctx.W)).filter(o => isEarnRow(o) && o.agentId === ctx.agentId);
async function renew(ctx: Ctx): Promise<void> {
  const fence = await ctx.deps.store.renewFence(ctx.fence);
  if (fence === null) throw new Error("agentic_wallet_busy");
  ctx.fence = fence;
}
async function readBalances(ctx: Ctx, fresh = false): Promise<AgenticEarnBalances | null> {
  if (!fresh && ctx.balances !== undefined) return ctx.balances;
  try { ctx.balances = ctx.deps.chain.earnBalances === undefined ? null : await ctx.deps.chain.earnBalances(ctx.W); } catch { ctx.balances = null; }
  return ctx.balances;
}
const valueOf = (b: AgenticEarnBalances, protocol: EarnProtocol): bigint => protocol === "venus" ? b.venusWei : b.aaveWei;
async function bnbOf(ctx: Ctx): Promise<bigint | null> { try { return await ctx.deps.chain.balance(ctx.W, null); } catch { return null; } }
async function blocked(ctx: Ctx): Promise<boolean> {
  const ks = ctx.deps.killswitch as { isBlocked?: (agentId: string, owner: Address) => Promise<boolean> } | undefined;
  return typeof ks?.isBlocked === "function" ? await ks.isBlocked(ctx.agentId, ctx.W) : false;
}
const cents = (wei: bigint): string => `${wei / E18}.${((wei % E18) / E16).toString().padStart(2, "0")}`;
const apyText = (bps: number): string => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
/** The closed event reason of rule 12; undefined when the evidence cannot make it. */
function reasonOf(row: AgenticOrder, ev: EarnEvidence | null): string | undefined {
  if (ev === null || row.amountAtomic === null) return undefined;
  if (row.kind === "earn-redeem") return `${ev.protocol}, ${earnIsRatio(row) ? "all" : cents(BigInt(row.amountAtomic))} USDT`;
  const own = ev.apyBps?.[ev.protocol], other = ev.protocol === "venus" ? "aave-v3" : "venus", theirs = ev.apyBps?.[other];
  return own == null ? undefined : `${ev.protocol} ${apyText(own)}% vs ${other} ${theirs == null ? "n/a" : apyText(theirs) + "%"}, ${cents(BigInt(row.amountAtomic))} USDT`;
}

/* ------------------------------------------ resolution (rules 24 to 26, R11.1, R11.9) ------------------------------------------ */

async function resolveOne(ctx: Ctx, start: AgenticOrder): Promise<AgenticOrder> {
  const { store, chain } = ctx.deps;
  let row = start;
  if (row.outcome !== "open" || row.dispatch !== "spawned") return row;
  const now = await store.now(), ev = earnEvidence(row.evidence);
  // R11.9: the hold the generic resolver no longer writes for an earn row.
  if (row.holdReason === null && row.response === null) return await store.patchOrder(row, { holdReason: "no-response" }) ?? row;
  // AGENTIC-RECEIPT-WAIT-2 B: a receipt-missing row is re-examined by this branch every pass (unreadable: no write); the hold is written once, from an unheld row.
  if (row.response === "accepted" && (row.holdReason === null || row.holdReason === "receipt-missing") && row.txHash !== null) {
    const proof = await chain.receipt(row.txHash);
    let value: bigint | null = null;
    if (proof !== null && ev !== null) { const b = await readBalances(ctx, true); value = b === null ? null : valueOf(b, ev.protocol); }
    const verdict = verifyEarnReceipt(proof, row, { value, nowMs: now });
    if (verdict.kind === "commit") {
      const next = await store.patchOrder(row, { outcome: "committed", holdReason: null, evidence: { ...ev, post: { usdtMoved: verdict.usdtMoved.toString(), receiptMoved: verdict.receiptMoved.toString(), block: verdict.block.toString() }, disposition: "receipt" } });
      if (next !== null) { note(ctx, row.kind === "earn-deposit" ? "earn-deposited" : "earn-redeemed", reasonOf(row, ev)); return next; }
    } else if (verdict.kind === "reverted") {
      const next = await store.patchOrder(row, { outcome: "rolled-back", holdReason: null, evidence: { ...ev, disposition: "landed-reverted" } });
      if (next !== null) { note(ctx, "earn-refused"); return next; }
    } else if (verdict.kind === "hold") return await store.patchOrder(row, { holdReason: "chain-verification" }) ?? row;
    else if (row.holdReason === null && proof === null && row.claimedAt !== null && now - row.claimedAt >= EARN_RECEIPT_WAIT_MS) return await store.patchOrder(row, { holdReason: "receipt-missing" }) ?? row;
    return row;
  }
  if (row.holdReason !== "no-response" || ev === null || row.claimedAt === null || row.walletNoncePre === null || now - row.claimedAt < EARN_DELTA_MIN_AGE_MS) return row;
  let nonce: bigint;
  try { nonce = await chain.nonce(ctx.W); } catch { return row; }
  const b = await readBalances(ctx, true);
  // R11.1 rule 26a: a structured server refusal, after the finalization window, with the nonce unmoved, is a rollback; nothing else ever is.
  const name = earnCliName(row.cliResult);
  if (name !== null && EARN_SERVER_REFUSALS.has(name) && nonce === BigInt(row.walletNoncePre)) {
    const next = await store.patchOrder(row, { response: "rejected", outcome: "rolled-back", holdReason: null,
      evidence: { ...ev, disposition: "server-refused", name, nonce: nonce.toString(), block: b?.block.toString() ?? null } });
    if (next !== null) { note(ctx, "earn-refused"); return next; }
    return row;
  }
  // Rule 26: positive balance evidence only.
  if (b !== null && earnBalanceDelta(row, { nonce, usdt: b.usdt, value: valueOf(b, ev.protocol), nowMs: now })) {
    const next = await store.patchOrder(row, { outcome: "committed", holdReason: null,
      evidence: { ...ev, disposition: "balance-delta", post: { usdt: b.usdt.toString(), valueWei: valueOf(b, ev.protocol).toString(), block: b.block.toString(), nonce: nonce.toString() } } });
    if (next !== null) { note(ctx, row.kind === "earn-deposit" ? "earn-deposited" : "earn-redeemed", reasonOf(row, ev)); return next; }
  }
  return row;
}
async function resolveRows(ctx: Ctx): Promise<void> {
  for (const row of (await earnRows(ctx)).filter(o => o.outcome === "open")) {
    if (ctx.row.state !== "ended") await renew(ctx);
    await resolveOne(ctx, row);
  }
}

/* ------------------------------------------ dispatch (rules 17 to 23) ------------------------------------------ */

export type EarnPlan = EarnAmount & { action: "deposit" | "redeem"; protocol?: EarnProtocol; reason: "lane" | "redeem-all" | "gate"; live: boolean };
export type EarnDispatch = { kind: "dry"; plan: Record<string, unknown> } | { kind: "none"; code: string } | { kind: "sent"; order: AgenticOrder };

async function pinsOk(ctx: Ctx): Promise<AgenticEarnPins | null> {
  const cached = PINS.get(ctx.deps.chain);
  if (cached !== undefined) return cached;
  try { if (ctx.deps.chain.earnPins === undefined) return null; const pins = await ctx.deps.chain.earnPins(); PINS.set(ctx.deps.chain, pins); return pins; } catch { return null; }
}
/** The one dispatch of an earn operation, shared by the lane and the gate tool. Every refusal before the row is a code and a log event, never a row. */
async function dispatchEarn(ctx: Ctx, plan: EarnPlan): Promise<EarnDispatch> {
  const { deps } = ctx, { store, runner } = deps, deposit = plan.action === "deposit";
  const refuse = (code: string, reason?: string): EarnDispatch => { note(ctx, code, reason); return { kind: "none", code }; };
  const amount: EarnAmount = { amountWei: plan.amountWei, ratio: plan.ratio };
  let product: EarnProduct | undefined, apyBps: EarnEvidence["apyBps"] = null;
  if (deposit) {
    // Rule 17: the configured, listed, pin-checked product with the higher base APY (tie: Venus). No migration, no second product.
    await renew(ctx);
    const listed = await runner.run(earnListArgs(plan.protocol), session(ctx));
    await recordAgenticConnection(store, ctx.agentId, listed);
    const listings = listed.kind === "ok" ? parseEarnList(listed.data, ctx.products) : null, pins = await pinsOk(ctx);
    if (listings === null || pins === null) return refuse("earn-unavailable");
    apyBps = { venus: listings.find(l => l.protocol === "venus")?.apyBps ?? null, "aave-v3": listings.find(l => l.protocol === "aave-v3")?.apyBps ?? null };
    const candidates = listings.filter(l => pins[l.protocol] && (plan.protocol === undefined || l.protocol === plan.protocol));
    candidates.sort((a, b) => b.apyBps - a.apyBps || (a.protocol === "venus" ? -1 : 1));
    product = candidates[0] === undefined ? undefined : earnProductOf(ctx.products, candidates[0].protocol);
    if (product === undefined) return refuse("earn-unavailable");
    // Rule 18: the settings read (a hold is written on conflict) and the DeFi quota, when the field parses.
    await renew(ctx);
    const settings = await readAgenticSettings(deps, ctx.agentId, ctx.fence);
    if (settings === null) return refuse("earn-unavailable");
    const quota = agenticDecimal(settings["defiQuotaLeft"]);
    if (quota !== null && quota < plan.amountWei) return refuse("earn-unavailable");
  } else {
    product = plan.protocol === undefined ? undefined : earnProductOf(ctx.products, plan.protocol);
    if (product === undefined || !earnConfigured(product)) return refuse("earn-redeem-blocked", "unconfigured");
  }
  // Rule 18: the preview with the exact argv of the dispatch. A deposit must also name a pinned interact-with address.
  await renew(ctx);
  const preview = await runner.run(earnPreviewArgs(plan.action, product, amount), session(ctx));
  await recordAgenticConnection(store, ctx.agentId, preview);
  const parsed = preview.kind === "ok" ? parseEarnPreview(preview.data) : null;
  if (parsed === null) return refuse(deposit ? "earn-refused" : "earn-redeem-blocked", "preview-refused");
  if (deposit && (parsed.interactWith === null || !product.previewTargets!.includes(parsed.interactWith))) return refuse("earn-unavailable");
  if (!plan.live) return { kind: "dry", plan: { action: plan.action, protocol: product.protocol, investmentId: product.investmentId, qty: earnQty(amount), apyBps, interactWith: parsed.interactWith } };
  if (deps.gateRunId !== undefined) {
    const run = await store.getRun(deps.gateRunId);
    if (run === null || run.side !== "earn" || run.agentId !== ctx.agentId || run.wallet !== ctx.W || run.closedAt !== null || run.dispatches >= run.maxDispatches || await store.now() >= run.deadlineMs) return refuse("earn-refused");
  }
  // Rule 19: the row before anything is sent, with the pre-dispatch chain reading as evidence.
  const pre = await readBalances(ctx, true), bnb = await bnbOf(ctx);
  if (pre === null || bnb === null) return refuse("earn-read-failed");
  const existing = await earnRows(ctx), now = await store.now();
  const evidence: EarnEvidence = { v: 1, protocol: product.protocol, investmentId: product.investmentId!, receiptToken: product.receiptToken, reason: plan.reason, apyBps,
    pre: { block: pre.block.toString(), usdt: pre.usdt.toString(), valueWei: valueOf(pre, product.protocol).toString(), bnb: bnb.toString() } };
  const key = `earn:${ctx.agentId}:${existing.length + 1}`;
  let order: AgenticOrder = { idempotencyKey: key, kind: deposit ? "earn-deposit" : "earn-redeem", walletAddress: ctx.W, agentId: ctx.agentId, decisionId: null, side: null,
    fromToken: null, toToken: null, amountAtomic: plan.amountWei.toString(), intendedRaw: null, fromQty: earnQty(amount), minOutAtomic: null, binanceQuoteOutAtomic: null,
    slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null, operationId: null, walletNoncePre: (await deps.chain.nonce(ctx.W)).toString(), quoteAt: null,
    dispatch: "unclaimed", claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null, response: null, cliResult: null, returnedOrderId: null, listedOrderId: null,
    txHash: null, approveTxHash: null, outcome: "open", holdReason: null, evidence, fillCheck: "none", createdAt: now, updatedAt: now };
  // `from_token` and `to_token` in flow order (USDT out and the receipt token in for a deposit, the reverse for a redeem).
  order = { ...order, fromToken: deposit ? EARN_USDT : product.receiptToken, toToken: deposit ? product.receiptToken : EARN_USDT };
  if (!await store.createOrder(order)) return refuse("earn-held");
  const args = deposit ? earnDepositArgs(product, plan.amountWei) : earnRedeemArgs(product, amount);
  const seal = async (cliResult: string): Promise<EarnDispatch> => {
    const sealed = await store.patchOrder(order, { dispatch: "sealed", cliResult });
    if (sealed !== null) await store.patchOrder(sealed, { outcome: "rolled-back" });
    return refuse("earn-refused");
  };
  let command: Awaited<ReturnType<BawRunner["prepare"]>> | null = null;
  try {
    await renew(ctx);
    command = await runner.prepare(args, session(ctx));
    if (deps.gateRunId !== undefined && !await store.consumeRun(deps.gateRunId, "dispatch")) return await seal("AGENTIC_GATE_LIMIT");
    if (await store.walletObligations(ctx.W, { orderKey: key })) return await seal("AGENTIC_WALLET_OBLIGATION");
    deps.instance.beginDispatch();
    try {
      const tq = process.hrtime.bigint();
      command.environment["FOURLPHA_START_DEADLINE_MS"] = String(Date.now() + 7_000);
      const claimed = await store.claimEarnOrder(order, ctx.fence);
      if (claimed === null) return await seal("AGENTIC_CLAIM_REFUSED");
      order = claimed;
      if (Number(process.hrtime.bigint() - tq) >= 5_000_000_000) return await seal("spawn-late");
      const result: BawResult = await command.start();
      if (result.kind === "not-started") {
        const stopped = await store.patchOrder(order, { dispatch: "not-started", cliResult: "not-started" });
        if (stopped !== null) await store.patchOrder(stopped, { outcome: "rolled-back" });
        return refuse("earn-refused");
      }
      const answer = earnResponse(plan.action, result);
      const recorded = await store.patchOrder(order, { response: answer.response, cliResult: answer.note, txHash: answer.txHash, holdReason: answer.holdReason,
        ...(answer.rollBack ? { outcome: "rolled-back" as const } : {}) });
      if (recorded === null) { console.error("agentic_late_response", key, answer.response); return { kind: "none", code: "earn-held" }; }
      order = recorded;
      await recordAgenticConnection(store, ctx.agentId, result);
      if (answer.rollBack) return refuse("earn-refused");
      note(ctx, "earn-sent", reasonOf(order, evidence));
      // Rule 23: poll at most 20 s for the finalized receipt.
      if (answer.response === "accepted" && answer.holdReason === null) {
        const until = process.hrtime.bigint() + 20_000_000_000n;
        do {
          order = await resolveOne(ctx, order);
          if (order.outcome !== "open" || order.holdReason !== null) break;
          await new Promise<void>(resolve => setTimeout(resolve, 2_000));
          await renew(ctx);
        } while (process.hrtime.bigint() < until);
      }
      return { kind: "sent", order };
    } finally { deps.instance.endDispatch(); }
  } catch (error) {
    // R11.9: a throw while the row is still unclaimed seals it and rolls it back in the same step; after the claim the row is left to the resolver.
    const current = await store.getOrder(key);
    if (current?.dispatch === "unclaimed") await seal("AGENTIC_UNREACHABLE");
    throw error;
  } finally { await command?.close(); }
}

/* ------------------------------------------ the step (rules 10 to 16) ------------------------------------------ */

type LaneState = { needs: EarnNeeds; xWei: bigint; xUnreadable: boolean; capitalWei: bigint };
/** Rule 3.5 and R11.8: the per-lane liquid band and the CMC exposure. Null is a failed read (no action this cycle). */
async function laneState(deps: AgenticEarnStepDeps, ctx: Ctx, now: number): Promise<LaneState | null> {
  const row = ctx.row, s = row.hireParams!.settings, capitalWei = BigInt(s.capitalQuoteWei!), entryWei = BigInt(s.entryWei);
  const entriesOpen = row.entriesStopped === null && row.drainRequestedAt === null && row.entryCutoffMs !== null && now + 5_000 < row.entryCutoffMs;
  let needs: EarnNeeds, xWei = 0n, xUnreadable = false;
  if (isTradeScheduleSettings(s)) {
    const agent = await deps.worker.agentStore.getAgentById(ctx.agentId);
    if (agent === null) return null;
    const facts = projectAgenticSessionFacts(row);
    // The owner of an Agentic hire is its wallet (agentic_wallets forces owner = wallet), so this is the same read as the worker's own listScheduleIntents.
    const intents = await deps.worker.intents.listSchedule(agent.ownerAddress, ctx.agentId);
    const ledger = scheduleLedger({ anchorMs: scheduleAnchorMs(s.scheduleFirstAtSec, agent.createdAt), intervalSec: s.scheduleIntervalSec as ScheduleIntervalSec, nowMs: now,
      capitalQuoteWei: capitalWei, entryWei, platformFeeBps: 0, ttlSec: Math.max(0, facts.expiry - (facts.grantedAtSec ?? Math.floor(agent.createdAt / 1_000))),
      endKind: s.scheduleEndKind!, endAtSec: s.scheduleEndAtSec!, endRuns: s.scheduleEndRuns!, intents });
    const left = ledger.finished !== null || entryWei <= 0n ? 0 : Math.max(0, Math.min(Number(ledger.remainingWei / entryWei), ledger.plannedBuys - ledger.fills, ledger.buysThisSession - ledger.fills));
    needs = earnNeeds({ lane: "schedule", entryWei, left, intervalSec: s.scheduleIntervalSec! });
  } else {
    if (isTradeDcaSettings(s)) {
      const rounds = await deps.store.dcaRounds(ctx.agentId), open = rounds.find(dcaRoundOpen), n = s.dcaMaxOrders!;
      let done = 0;
      if (open !== undefined) {
        const latest = new Map<number, { state: string; at: number }>();
        for (const o of await deps.store.dcaOrders(ctx.agentId, open.roundNo)) if (o.role === "level" && o.levelNo !== null && (latest.get(o.levelNo)?.at ?? -1) <= o.createdAt) latest.set(o.levelNo, { state: o.state, at: o.createdAt });
        done = [...latest.values()].filter(v => ["filled", "skipped", "below-range"].includes(v.state)).length;
      }
      needs = earnNeeds({ lane: "dca", baseWei: entryWei, orderWei: BigInt(s.dcaOrderWei!), ahead: dcaAhead(n), baseNeeded: open === undefined || open.phase === "starting",
        undone: open === undefined ? n : Math.max(0, n - done), entriesOpen });
    } else {
      const open = (await deps.positions.listOpen(ctx.W, ctx.agentId)).length, unsettled = (await deps.worker.intents.listUnsettled(ctx.W, ctx.agentId)).filter(i => i.side === "buy").length;
      needs = earnNeeds({ lane: "ai", entryWei, slots: entriesOpen ? Math.max(0, s.maxOpenPositions - open - unsettled) : 0 });
    }
    // X: the CMC exposure the lanes keep liquid. A failed read, or one above the hire budget (the unavailable sentinel), reads as the whole budget and no deposit that cycle.
    const budget = BigInt(row.hireFacts!.budgetWei);
    try { xWei = await deps.cmc.protectedExposure(ctx.agentId); } catch { xWei = budget; xUnreadable = true; }
    if (xWei > budget) { xWei = budget; xUnreadable = true; }
  }
  return { needs, xWei, xUnreadable, capitalWei };
}

export async function runAgenticEarnStep(deps: AgenticEarnStepDeps, input: AgenticWallet, options: AgenticEarnOptions = {}): Promise<AgenticWallet> {
  if (input.hireFacts?.earn?.v !== 1 || input.agentId === null || input.walletAddress === null || input.hireParams === null) return input;
  if (options.dryRun === true || options.cmcOnly === true || !["bound", "ending", "ended"].includes(input.state)) return input;
  const { store } = deps, W = input.walletAddress, agentId = input.agentId;
  // An ended row with no open earn row never takes the wallet fence again (it must not contend with a later hire on W).
  if (input.state === "ended" && !(await store.orders(W)).some(o => isEarnRow(o) && o.outcome === "open")) return input;
  const fence = await acquireAgenticFence(store, W, deps.instance.row.instanceId);
  if (fence === null) return input;
  const ctx: Ctx = { deps, row: input, fence, W, agentId, products: deps.products ?? EARN_PRODUCTS, events: [], refusals: 0, balances: undefined };
  try {
    await resolveRows(ctx);
    ctx.row = await store.byAgent(agentId) ?? ctx.row;
    if (options.reconciliationOnly !== true && ctx.row.state !== "ended") await plan(deps, ctx);
  } catch (error) { console.error("agentic_earn_step_failed", error instanceof Error ? error.message : "unknown"); }
  finally {
    await store.releaseFence(ctx.fence);
    if (options.reconciliationOnly !== true && ctx.events.length > 0) {
      try { await deps.positions.insertRun({ agentId, ownerAddress: W, dryRun: false, reason: "agentic-earn", refusals: ctx.refusals,
        events: ctx.events.map(e => ({ stage: "earn" as const, code: e.code, elapsedMs: 0, ...(e.reason === undefined ? {} : { reason: e.reason }) })) }); }
      catch { console.error("agentic_earn_run_failed"); }
    }
  }
  return await store.byAgent(agentId) ?? ctx.row;
}

async function plan(deps: AgenticEarnStepDeps, ctx: Ctx): Promise<void> {
  const { store } = deps, row = ctx.row, now = await store.now(), hireEnd = row.hireEndMs!;
  const redeemWindow = row.state === "ending" || now >= hireEnd - EARN_REDEEM_ALL_MS;
  const rows = await earnRows(ctx);
  // (b) one wallet operation at a time: an open earn row (resolved above), or any other obligation of the wallet, ends the step.
  if (rows.some(o => o.outcome === "open")) { if (rows.some(o => o.outcome === "open" && o.holdReason !== null)) note(ctx, "earn-held"); return; }
  if (await store.walletObligations(ctx.W)) { if (redeemWindow) note(ctx, "earn-redeem-blocked", "held"); return; }
  // Under a gate run the step dispatches only for a run of side earn; any other run resolves only.
  let dispatchable = true;
  if (deps.gateRunId !== undefined) { const run = await store.getRun(deps.gateRunId); dispatchable = run !== null && run.side === "earn" && run.closedAt === null && now < run.deadlineMs; }
  const balances = await readBalances(ctx), bnb = await bnbOf(ctx), agent = await deps.worker.agentStore.getAgentById(ctx.agentId);
  const lane = balances === null || bnb === null || agent === null ? null : await laneState(deps, ctx, now).catch(() => null);
  if (balances === null || bnb === null || lane === null) { note(ctx, redeemWindow ? "earn-redeem-blocked" : "earn-read-failed", redeemWindow ? "read-failed" : undefined); return; }
  const apy = lastApy(rows), paused = await blocked(ctx);
  const armed = agent!.status === "armed", runnable = armed || agent!.status === "revoked";
  const recent = await recentRefusals(ctx, now);
  const lastDeposit = rows.some(o => o.kind === "earn-deposit" && o.dispatch === "spawned" && earnEvidence(o.evidence)?.reason === "lane" && o.createdAt > now - EARN_DEPOSIT_SPACING_MS);
  const rolled = (kind: AgenticOrder["kind"] | null): boolean => rows.some(o => (kind === null || o.kind === kind) && o.outcome === "rolled-back" && o.updatedAt > now - EARN_BACKOFF_MS);
  const canDeposit = dispatchable && deps.earnEnabled && row.state === "bound" && row.settingsHold === null && row.entriesStopped === null && row.drainRequestedAt === null && armed && !paused
    && bnb >= EARN_DEPOSIT_BNB_FLOOR_WEI && !lastDeposit && !rolled(null) && !recent.deposit && !lane.xUnreadable;
  const decision = earnDecide({ now, hireEndMs: hireEnd, state: row.state as "bound" | "ending", capitalWei: lane.capitalWei, idleWei: balances.usdt, parkedWei: balances.venusWei + balances.aaveWei,
    xWei: lane.xWei, needs: lane.needs, products: ctx.products.map(p => ({ protocol: p.protocol, valueWei: valueOf(balances, p.protocol), configured: earnConfigured(p) })), apy, canDeposit });
  if (decision.action === "none") return;
  if (decision.action === "blocked") { note(ctx, "earn-redeem-blocked", decision.reason); return; }
  if (decision.action === "deposit") { await dispatchEarn(ctx, { action: "deposit", amountWei: decision.amountWei, ratio: false, reason: "lane", live: true }); return; }
  // Redeems: not under a halt or a pause, and with the gas for one; a refused or rolled-back one retries after 600 s. The back-off cycles say `held`: a second `preview-refused` event would restart the very window it reads.
  const why = !runnable || paused ? "paused" : bnb < EARN_REDEEM_BNB_FLOOR_WEI ? "low-bnb" : recent.redeem ? "held" : rolled("earn-redeem") ? "held" : null;
  if (why !== null) { note(ctx, "earn-redeem-blocked", why); return; }
  if (!dispatchable) return;
  const redeemAll = decision.action === "redeem-all";
  await dispatchEarn(ctx, { action: "redeem", protocol: decision.protocol, amountWei: redeemAll ? valueOf(balances, decision.protocol) : decision.amountWei, ratio: redeemAll || decision.ratio,
    reason: redeemAll ? "redeem-all" : "lane", live: true });
}
/** The APYs of the last committed lane deposit's evidence (redeem order input). */
function lastApy(rows: readonly AgenticOrder[]): EarnApy | null {
  const last = rows.filter(o => o.kind === "earn-deposit" && o.outcome === "committed").sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const ev = last === undefined ? null : earnEvidence(last.evidence);
  return ev?.apyBps ?? null;
}
/** A refused preview, and a deposit refused before its row (`earn-unavailable`), write no row (rule 18); their 600 s back-off is read from the agent's own latest run rows (build report D6, audit M-3). */
async function recentRefusals(ctx: Ctx, now: number): Promise<{ deposit: boolean; redeem: boolean }> {
  const runs = await ctx.deps.positions.listRuns(ctx.W, ctx.agentId, 40);
  const hit = (code: string, reason: string | null): boolean => runs.some(r => r.createdAt > now - EARN_BACKOFF_MS
    && (r.events ?? []).some(e => e.stage === "earn" && e.code === code && (reason === null || e.reason === reason)));
  return { deposit: hit("earn-refused", "preview-refused") || hit("earn-unavailable", null), redeem: hit("earn-redeem-blocked", "preview-refused") };
}

/* ------------------------------------------ the sign-out guard (rule 29) ------------------------------------------ */

/** True while 4lpha must not sign an earn hire out: an earn row is open or fill-pending (held ones too), a product holds dust or more, or the chain read fails or is absent. */
export async function earnBlocksSignOut(deps: { store: AgenticStore; chain?: AgenticChain | undefined }, row: AgenticWallet): Promise<boolean> {
  if (row.walletAddress === null) return true;
  if ((await deps.store.orders(row.walletAddress)).some(o => isEarnRow(o) && (o.outcome === "open" || o.fillCheck === "pending"))) return true;
  try {
    const b = deps.chain?.earnBalances === undefined ? null : await deps.chain.earnBalances(row.walletAddress);
    return b === null || b.venusWei >= EARN_DUST_WEI || b.aaveWei >= EARN_DUST_WEI;
  } catch { return true; }
}

/* ------------------------------------------ the gate tool's one operation (AGENTIC-EARN-SPEC 9.3) ------------------------------------------ */

export type EarnOnceInput = { protocol: EarnProtocol; action: "deposit" | "redeem" | "redeem-all"; amountWei?: bigint; /** the run's notional: no amount above it is dispatched */ maxWei: bigint; live: boolean };
/** `earn-once`: under the lane's own fence, resolver, previews, row, claim and `dispatchEarn`; it bypasses only the sizing of 3.5 (amount, 20 USDT minimum, 24 h spacing). Without `live` it reads the list and the preview and writes nothing. */
export async function runEarnOnce(deps: AgenticEarnDeps, input: AgenticWallet, once: EarnOnceInput): Promise<{ result: EarnDispatch; events: readonly Event[] }> {
  if (input.hireFacts?.earn?.v !== 1 || input.agentId === null || input.walletAddress === null || input.state !== "bound") throw new Error("AGENTIC_GATE_EARN_NOT_ACTIVE");
  const fence = await acquireAgenticFence(deps.store, input.walletAddress, deps.instance.row.instanceId);
  if (fence === null) throw new Error("agentic_wallet_busy");
  const ctx: Ctx = { deps, row: input, fence, W: input.walletAddress, agentId: input.agentId, products: deps.products ?? EARN_PRODUCTS, events: [], refusals: 0, balances: undefined };
  try {
    await resolveRows(ctx);
    if ((await earnRows(ctx)).some(o => o.outcome === "open") || await deps.store.walletObligations(ctx.W)) throw new Error("AGENTIC_GATE_EARN_BLOCKED");
    const product = earnProductOf(ctx.products, once.protocol);
    if (product === undefined || !earnConfigured(product)) throw new Error("AGENTIC_GATE_EARN_PRODUCT");
    // Rule 15's BNB floor stays under the gate tool: a deposit never leaves less than the gas of its own redeem.
    if (once.action === "deposit") { const bnb = await bnbOf(ctx); if (bnb === null || bnb < EARN_DEPOSIT_BNB_FLOOR_WEI) throw new Error("AGENTIC_GATE_LOW_BNB"); }
    let amountWei = once.amountWei ?? 0n;
    if (once.action === "redeem-all") { const b = await readBalances(ctx, true); if (b === null) throw new Error("earn-read-failed"); amountWei = valueOf(b, once.protocol); }
    if (amountWei > once.maxWei) throw new Error("AGENTIC_GATE_LIMITS");
    const result = await dispatchEarn(ctx, { action: once.action === "deposit" ? "deposit" : "redeem", protocol: once.protocol, amountWei, ratio: once.action === "redeem-all", reason: "gate", live: once.live });
    return { result, events: ctx.events };
  } finally {
    await deps.store.releaseFence(ctx.fence);
    if (once.live && ctx.events.length > 0) {
      try { await deps.positions.insertRun({ agentId: ctx.agentId, ownerAddress: ctx.W, dryRun: false, reason: "agentic-earn", refusals: ctx.refusals,
        events: ctx.events.map(e => ({ stage: "earn" as const, code: e.code, elapsedMs: 0, ...(e.reason === undefined ? {} : { reason: e.reason }) })) }); }
      catch { console.error("agentic_earn_run_failed"); }
    }
  }
}
