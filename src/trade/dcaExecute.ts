/**
 * The Auto DCA range executor (AUTO-DCA §5.6 as amended by R2.7–R2.10; REVIEW2
 * conditions 4, 5, 12).
 *
 * WORKER-ONLY. The trade worker is its one caller; no HTTP route imports it and
 * no request field reaches it (I12), which `test/tradeDcaExecute.test.ts` pins at
 * the source level. It submits NFPM calldata, so it must never sit behind the
 * `TradeRequest` wire shape (R2.3).
 *
 * ─── ORDER (R2.7, closes review B1) ────────────────────────────────────────
 *
 * Everything runs inside `withDcaFence`, and in this order:
 *   1. every DENIAL — status, authorisation, the stored settings, draining, the
 *      session window, the R2.10 bounds, the on-chain USDT meter and cash —
 *      with NO write;
 *   2. the ONE conditional write, `claimAction`, which answers
 *      `dca_round_changed` rather than aborting, plus this action's own order
 *      marks on the same transaction;
 *   3. journal `beginWithSpend` (kind `dcaRange`), preflight, the native
 *      reserve, the guard re-check, the submit;
 *   4. the action's state from the outcome.
 * A refusal in step 3 rolls the action back, which frees the in-flight slot and
 * undoes exactly its order marks; no fee is spent before the submit.
 *
 * The submit stays inside the fence, as `withEntryFence` does (REVIEW2 N17 is
 * not a condition; R2.8 allows one submission per agent per cycle).
 */
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import type { ExecutionReceipt, NativeDayMeterReading, ProviderRegistry, SessionRef, WalletProvider } from "../core/types.js";
import { ExecutionPlaneError, ProviderError } from "../core/types.js";
import { sanitizeMessage } from "../core/errors.js";
import { canonicalEncode } from "../auth/canonical.js";
import { authorizeExecute } from "../auth/executeDecision.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import { hashCalls } from "../http/wire.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { TradeSettingsStore } from "../store/tradeSettings.js";
import type { ExecutionJournal } from "../store/journal.js";
import type { DcaActionRow, DcaOrderRow, DcaRoundRow, DcaRoundStore } from "../store/dcaRounds.js";
import type { SqlClient } from "../store/sql.js";
import type { TradeRuntimeConfig } from "../ops/config.js";
import { nativeReserveFloor } from "../ops/policy.js";
import { agentAuthorityFromPrivateKey, MAX_CALLS_PER_EXECUTE } from "../wallet/altana.js";
import { SESSION_ENTRY_CUTOFF_MS } from "./exits.js";
import { TRADFI_GUARD_MIN_REMAINING_MS } from "./guard.js";
import { tradfiV2SwapRefusal } from "./execute.js";
import { R_DCA } from "./sizing.js";
import { USDT_56 } from "./settlement.js";
import { preflightSimulate, type TradfiPreflightDeps } from "./simulate.js";
import { isTradeDcaSettings, parseTradeSettings, type EffectiveTradeSettings } from "./settings.js";
import { DCA_MAX_EXITS_PER_BATCH, DCA_PLATFORM_FEE_BPS, dcaAhead, dcaBatchCalls, type DcaBatchPlan, type DcaPool } from "./dca.js";

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type DcaExecuteDeps = {
  readonly preflight?: TradfiPreflightDeps;
  readonly store: DcaRoundStore;
  readonly settingsStore: Pick<TradeSettingsStore, "get">;
  readonly agentStore: Pick<AgentStore, "getAgentById" | "readExecutingSession">;
  readonly journal: Pick<ExecutionJournal, "beginWithSpend" | "markRolledBack" | "markUnknown" | "markInProgress" | "markCommitted" | "sumPendingQuoteSpendSince">;
  readonly killswitch: KillSwitch;
  readonly providerRegistry: ProviderRegistry;
  readonly chainId: number;
  /** The fee and slippage policy `tradfiV2SwapRefusal` reads, and the fee treasury. */
  readonly trade: TradeRuntimeConfig;
  readonly nfpm: Address;
  /** The on-chain USDT day meter (`readTradfiV2QuoteRemaining`); `null` is unreadable. */
  readonly quoteRemaining: (agent: AgentRecord) => Promise<bigint | null>;
  readonly walletUsdt: (agent: AgentRecord) => Promise<bigint>;
  readonly nowMs?: () => number;
};

export type DcaExecuteInput = {
  readonly agent: AgentRecord;
  readonly pool: DcaPool;
  /** The round as this cycle read it: the claim's expected `rowVersion`. */
  readonly round: DcaRoundRow;
  /** The plan with R2.19's `preSubmit` snapshot and `relayQuoteWei` already set. */
  readonly plan: DcaBatchPlan;
  /** Stop-loss and Remove batches: they may spend the native reserve (R2.9). */
  readonly sweep: boolean;
  /** The settings this plan was built from; the fence re-reads and compares them. */
  readonly settings: EffectiveTradeSettings;
};

export type DcaExecuteResult =
  | { readonly kind: "denied"; readonly code: string }
  | { readonly kind: "rolled-back"; readonly code: string; readonly actionKey: string }
  | { readonly kind: "submitted"; readonly actionKey: string; readonly receipt: ExecutionReceipt }
  | { readonly kind: "unknown"; readonly actionKey: string };

/** The journal key of a DCA action: the action key is the `decisionId`. */
export function dcaIdempotencyKey(actionKey: string): Hex {
  return keccak256(stringToBytes(`dcaRange:${actionKey}`));
}

/** `reducesExposure` iff the batch mints no USDT and buys nothing (§5.6 step 2). */
export function dcaReducesExposure(plan: DcaBatchPlan): boolean {
  return !plan.mints.some((mint) => mint.role === "level") && plan.swap?.side !== "buy";
}

function asPlaneError(error: unknown, fallback: string): ExecutionPlaneError {
  if (error instanceof ExecutionPlaneError) return error;
  return new ProviderError(sanitizeMessage(error instanceof Error ? error.message : fallback));
}

function usdtOf(pool: DcaPool, amount0: bigint, amount1: bigint): bigint {
  return pool.usdtIsToken0 ? amount0 : amount1;
}

function stockOf(pool: DcaPool, amount0: bigint, amount1: bigint): bigint {
  return pool.usdtIsToken0 ? amount1 : amount0;
}

/**
 * R2.10's bounds from signed authority, pure over the plan, the current signed
 * settings, the round and its orders. `null` passes.
 */
export function dcaBatchBoundsRefusal(input: {
  readonly plan: DcaBatchPlan;
  readonly pool: DcaPool;
  readonly settings: EffectiveTradeSettings;
  readonly round: Pick<DcaRoundRow, "stockAcquiredWei">;
  readonly roundOrders: readonly Pick<DcaOrderRow, "role" | "mintedUsdtWei">[];
  readonly callCount: number;
}): string | null {
  const { plan, pool, settings } = input;
  const orderWei = BigInt(settings.dcaOrderWei ?? "0");
  const levelMints = plan.mints.filter((mint) => mint.role === "level");
  const tpMints = plan.mints.filter((mint) => mint.role === "tp");
  if (plan.exits.length > DCA_MAX_EXITS_PER_BATCH || input.callCount > MAX_CALLS_PER_EXECUTE || tpMints.length > 1
    || (plan.kind === "stop-loss" && (plan.swap !== null || plan.mints.length > 0))
    || (plan.kind === "remove" && (plan.swap !== null || plan.mints.length > 0))) return "DCA_BATCH_SHAPE";
  // AUTO-DCA I15: the executor refuses a sell leg in every DCA batch, draining or not.
  if (plan.swap !== null && plan.swap.side === "sell") return "DCA_SELL_NOT_ALLOWED";
  if (plan.swap !== null && plan.swap.side === "buy" && plan.kind !== "start" && plan.kind !== "close-start") return "DCA_BATCH_SHAPE";
  for (const mint of levelMints) {
    if (usdtOf(pool, mint.amount0Desired, mint.amount1Desired) !== orderWei || stockOf(pool, mint.amount0Desired, mint.amount1Desired) !== 0n) return "DCA_ORDER_BOUNDS";
  }
  // R3.3: at most `ahead` level mints per batch, and the round the mints belong to holds at most N·D.
  const mintedSoFar = input.roundOrders.filter((order) => order.role === "level").reduce((sum, order) => sum + order.mintedUsdtWei, 0n);
  if (levelMints.length > dcaAhead(settings.dcaMaxOrders ?? 0)
    || mintedSoFar + orderWei * BigInt(levelMints.length) > BigInt(settings.dcaMaxOrders ?? 0) * orderWei) return "DCA_BATCH_CAP";
  for (const mint of tpMints) {
    const exitFloors = plan.exits.reduce((sum, exit) => sum + stockOf(pool, exit.amount0Min, exit.amount1Min), 0n);
    const swapOut = plan.swap !== null && plan.swap.side === "buy" ? plan.swap.minOutWei : 0n;
    if (usdtOf(pool, mint.amount0Desired, mint.amount1Desired) !== 0n
      || stockOf(pool, mint.amount0Desired, mint.amount1Desired) > input.round.stockAcquiredWei + swapOut + exitFloors) return "DCA_TP_BOUNDS";
  }
  return null;
}

/**
 * Submit one `dcaRange` batch. The only caller is the trade worker's DCA branch.
 */
export async function executeDcaRangeBatch(deps: DcaExecuteDeps, input: DcaExecuteInput): Promise<DcaExecuteResult> {
  const { agent, pool, plan } = input;
  const nowMs = deps.nowMs ?? Date.now;
  const nowSec = (): number => Math.floor(nowMs() / 1_000);
  const reducesExposure = dcaReducesExposure(plan);
  const calls = dcaBatchCalls(plan, { pool, nfpm: deps.nfpm, wallet: agent.walletAddress, treasury: deps.trade.feeTreasury ?? null });
  return deps.store.withDcaFence(agent.ownerAddress, agent.id, async (sql: SqlClient | undefined): Promise<DcaExecuteResult> => {
    const denied = (code: string): DcaExecuteResult => ({ kind: "denied", code });

    /* ---- (1) every denial, before any write ---------------------------------- */
    if (agent.status === "revoked" || agent.status === "retired") return denied("revoked");
    const facts = agent.sessionFacts;
    if (facts === null) return denied("not_executable");
    if (facts.hireSizing?.settlementAsset !== "USDT") return denied("settlement_mismatch");
    const decision = await authorizeExecute({ agent, killswitch: deps.killswitch, now: nowSec(), reducesExposure });
    if (!decision.allowed) return denied(decision.code === "GLOBAL_HALT" ? "halted" : decision.code === "AGENT_PAUSED" ? "paused" : "not_executable");
    const settingsRow = await deps.settingsStore.get(agent.ownerAddress, agent.id, sql);
    const parsed = settingsRow === null ? null : parseTradeSettings(settingsRow.params);
    if (settingsRow === null || parsed === null || !parsed.ok || !isTradeDcaSettings(parsed.value.effective)) return denied("settings_changed");
    const current = parsed.value.effective;
    if (current.dcaToken?.toLowerCase() !== pool.stock.toLowerCase() || current.slippageBps !== input.settings.slippageBps
      || current.dcaStopLossBps !== input.settings.dcaStopLossBps) return denied("settings_changed");
    const draining = settingsRow.drainingAt !== null;
    if (draining && !input.sweep) return denied("draining");
    if (plan.relayQuoteWei === undefined || plan.preSubmit === undefined) return denied("cost-unavailable");
    if (!reducesExposure) {
      const live = await deps.agentStore.getAgentById(agent.id);
      if (live === null || live.sessionFacts === null) return denied("session_changed");
      const liveRemaining = live.sessionFacts.expiry * 1_000 - nowMs();
      const liveClamp = live.sessionFacts.grantedAtSec === undefined ? live.createdAt : live.sessionFacts.grantedAtSec * 1_000;
      const liveWindow = live.sessionFacts.expiry * 1_000 - liveClamp;
      if (liveRemaining <= Math.min(SESSION_ENTRY_CUTOFF_MS, Math.max(0, liveWindow / 2))) return denied("session_changed");
    }
    // Review C1: round k's orders carry the exit marks; `DCA_BATCH_CAP` counts the
    // round the mints belong to, which for a close + start is k + 1.
    const exitOrders = await deps.store.listOrders(agent.id, plan.roundNo, sql);
    const mintRoundNo = plan.kind === "close-start" ? plan.roundNo + 1 : plan.roundNo;
    const capOrders = mintRoundNo === plan.roundNo ? exitOrders : await deps.store.listOrders(agent.id, mintRoundNo, sql);
    const bounds = dcaBatchBoundsRefusal({ plan, pool, settings: current, round: input.round, roundOrders: capOrders, callCount: calls.length });
    if (bounds !== null) return denied(bounds);
    let v2QuoteCap: bigint;
    if (plan.swap !== null) {
      // FEE_MISMATCH compares against the DCA fee (none), not the configured one.
      const swapBounds = await tradfiV2SwapRefusal({ settingsStore: deps.settingsStore, trade: { ...deps.trade, feeBps: DCA_PLATFORM_FEE_BPS } }, agent, facts, {
        side: plan.swap.side, amountWei: plan.swap.amountInWei, platformFeeAtomic: plan.feeWei,
        quotedOutWei: plan.swap.quotedOutWei ?? 0n, minOutWei: plan.swap.minOutWei,
      });
      if (!swapBounds.ok) return denied(swapBounds.code);
      v2QuoteCap = swapBounds.v2QuoteCap;
    } else {
      const cap = facts.spec.spendCaps.find((row) => row.token?.toLowerCase() === USDT_56.toLowerCase() && row.period === "day");
      if (cap === undefined) return denied("USDT_CAP_UNAVAILABLE");
      v2QuoteCap = cap.limit;
    }
    const quoteSpendWei = plan.quoteSpendWei;
    if (quoteSpendWei > 0n) {
      // REVIEW2 condition 12 / M8: the ACCOUNT's own meter is the authority; an
      // unreadable one holds rather than falling back to the journal alone.
      const meter = await deps.quoteRemaining(agent);
      if (meter === null) return denied("quote-meter-unavailable");
      const pending = deps.journal.sumPendingQuoteSpendSince === undefined ? 0n : await deps.journal.sumPendingQuoteSpendSince(agent.id, 0);
      const margin = BigInt(current.dcaOrderWei ?? "0");
      if (meter <= pending || meter - pending < quoteSpendWei + margin) return denied("QUOTE_DAILY_CAP");
      // R2.4 (audit H-1): the batch is atomic, so its exits' USDT floors are cash
      // for its own spend, as the worker's gate counts the merged close's TP collect.
      const exitUsdt = plan.exits.reduce((sum, exit) => sum + usdtOf(pool, exit.amount0Min, exit.amount1Min), 0n);
      const cash = await deps.walletUsdt(agent) + exitUsdt;
      if (cash <= pending || cash - pending < quoteSpendWei) return denied("entry_budget_changed");
    }

    /* ---- (2) the one conditional write, and this action's order marks -------- */
    const claim = await deps.store.claimAction({ agentId: agent.id, ownerAddress: agent.ownerAddress, roundNo: plan.roundNo,
      expectedRowVersion: input.round.rowVersion, plan, nowMs: nowMs() }, sql);
    if (claim.kind === "dca_round_changed") return denied("dca_round_changed");
    const action: DcaActionRow = claim.action;
    const actionKey = action.actionKey;
    const at = nowMs();
    for (const exit of plan.exits) {
      const order = exitOrders.find((row) => row.tokenId === exit.tokenId);
      if (order !== undefined) await deps.store.putOrder({ ...order, state: "exiting", exitedByAction: actionKey, updatedAtMs: at }, sql);
    }
    for (const mint of plan.mints) {
      await deps.store.putOrder({
        agentId: agent.id, roundNo: mintRoundNo,
        orderKey: mint.orderKey, role: mint.role, levelNo: mint.levelNo, tickLower: mint.tickLower, tickUpper: mint.tickUpper,
        tokenId: null, state: "minting", liquidity: 0n, mintedUsdtWei: 0n, mintedStockWei: 0n, collectedUsdtWei: 0n, collectedStockWei: 0n,
        crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: actionKey, exitedByAction: null,
        lastSeenLiveBlock: null, closedBy: null, updatedAtMs: at,
      }, sql);
    }
    const rollBack = async (code: string): Promise<DcaExecuteResult> => {
      await deps.store.setActionState({ ownerAddress: agent.ownerAddress, actionKey, from: ["intended"], to: "rolled-back", note: code, nowMs: nowMs() }, sql);
      return { kind: "rolled-back", code, actionKey };
    };

    /* ---- (3) journal, preflight, reserve, guard window, submit --------------- */
    const idempotencyKey = dcaIdempotencyKey(actionKey);
    const callsHash = hashCalls(calls);
    const { otherQuoteSpendWei, created } = await deps.journal.beginWithSpend({
      idempotencyKey, agentId: agent.id, ownerAddress: agent.ownerAddress, kind: "dcaRange", decisionId: actionKey,
      externalRef: {
        paramsHash: keccak256(stringToBytes(canonicalEncode(plan))), callsHash, publicKey: facts.publicKey,
        sessionGeneration: facts.generation ?? 0,
        submittedCalls: calls.map((call) => ({ to: call.to, value: (call.value ?? 0n).toString(10), data: call.data ?? "0x" as Hex })),
        ...(quoteSpendWei === 0n ? {} : { quoteSpendWei: quoteSpendWei.toString(10) }),
        ...(plan.swap?.guard === undefined ? {} : { guardQuote: { address: plan.swap.guard.address, calldata: plan.swap.guard.calldata } }),
      },
      nativeSpendWei: 0n,
      ...(quoteSpendWei === 0n ? {} : { quoteSpendWei }),
    }, nowMs() - DAILY_WINDOW_MS);
    // A row under a FRESH key means an earlier attempt's claim was lost after it
    // was journaled; never submit under it. Rolling back advances the key.
    if (!created) return rollBack("dca_key_conflict");
    const journalRollBack = async (code: string): Promise<DcaExecuteResult> => {
      await deps.journal.markRolledBack(idempotencyKey, sanitizeMessage(`DCA batch refused before submit: ${code}.`));
      return rollBack(code);
    };
    // The journal's 24 h half of the cap can only be read atomically with the
    // reservation, so it runs AFTER the claim (not in step 1): a refusal here is
    // a rollback of the claimed action that spends no fee (audit L-2).
    if (quoteSpendWei > 0n && (otherQuoteSpendWei ?? 0n) + quoteSpendWei > v2QuoteCap) return journalRollBack("QUOTE_DAILY_CAP");
    const late = await authorizeExecute({ agent, killswitch: deps.killswitch, now: nowSec(), reducesExposure });
    if (!late.allowed) return journalRollBack(late.code === "GLOBAL_HALT" ? "halted" : late.code === "AGENT_PAUSED" ? "paused" : "not_executable");

    const provider: WalletProvider = deps.providerRegistry.get(deps.chainId);
    let session: SessionRef;
    try {
      const executing = await deps.agentStore.readExecutingSession(agent.ownerAddress, agent.id);
      if (executing === null) throw new ProviderError("Agent has no stored executing session.");
      session = provider.restoreSession({
        spec: executing.facts.spec, agent: agentAuthorityFromPrivateKey(executing.key), walletAddress: agent.walletAddress,
        publicKey: executing.facts.publicKey, expiresAt: executing.facts.expiry,
      });
      await provider.preflightExecute({ session, calls });
    } catch (error) {
      return journalRollBack(asPlaneError(error, "dca batch refused").code);
    }

    // R2.9: every DCA submission is paid from the native day cap (FINDINGS (w)).
    // A non-sweep leaves two sweeps' worth, 2 × R_DCA; a sweep may spend that
    // reserve and needs only its own quoted fee (condition 5: the quote is wei).
    if (provider.nativeDayMeter !== undefined) {
      let meter: NativeDayMeterReading;
      try {
        meter = await provider.nativeDayMeter({ walletAddress: session.walletAddress, publicKey: session.publicKey });
      } catch (error) {
        return journalRollBack(asPlaneError(error, "the native day meter could not be read").code);
      }
      if (meter.kind === "day") {
        if (input.sweep) {
          if (meter.limitWei - meter.currentSpentWei < plan.relayQuoteWei) return journalRollBack("dca-native-cap-exhausted");
        } else if (!nativeReserveFloor({ ...meter, exitReserveWei: 2n * R_DCA, submissionNativeWei: plan.relayQuoteWei }).sufficient) {
          return journalRollBack("NATIVE_RESERVE");
        }
      }
    }
    // C3/R2.5: the guard's deadline was clamped when the leg was built; re-check
    // it immediately before submission, when a rollback still spends no fee.
    if (deps.preflight !== undefined) {
      const verdict = await preflightSimulate(deps.preflight, {
        agent, idempotencyKey, journalKind: "dcaRange", exposure: reducesExposure ? "reduce" : "increase",
        route: plan.swap === null ? "none" : plan.swap.guard === undefined ? "direct" : "guard", calls,
        outputToken: pool.stock, minOutAtomic: plan.swap?.minOutWei ?? null,
        guardDeadlineSec: plan.swap?.guard?.deadlineSec, nowMs: nowMs(),
      });
      if (verdict.block) return journalRollBack("SIMULATION_FAILED");
    }
    const guardDeadline = plan.swap?.guard?.deadlineSec;
    if (guardDeadline !== undefined && Number(guardDeadline) * 1_000 - nowMs() < TRADFI_GUARD_MIN_REMAINING_MS) {
      return journalRollBack("GUARD_QUOTE_EXPIRED");
    }

    let receipt: ExecutionReceipt;
    try {
      receipt = await provider.executeViaSession({ session, calls, bypassLocalPolicyCheck: false });
    } catch (error) {
      await deps.journal.markUnknown(idempotencyKey, sanitizeMessage(asPlaneError(error, "dca batch failed").message));
      await deps.store.setActionState({ ownerAddress: agent.ownerAddress, actionKey, from: ["intended"], to: "unknown", callsHash, nowMs: nowMs() }, sql);
      return { kind: "unknown", actionKey };
    }

    /* ---- (4) the action's state from the outcome ------------------------------ */
    if (receipt.callsId !== undefined) await deps.journal.markInProgress(idempotencyKey, { callsId: receipt.callsId });
    if (receipt.status === "FAILED") {
      await deps.journal.markRolledBack(idempotencyKey, sanitizeMessage(receipt.failureCode ?? "DCA batch reported FAILED."));
      await deps.store.setActionState({ ownerAddress: agent.ownerAddress, actionKey, from: ["intended"], to: "rolled-back", note: "FAILED", callsHash, nowMs: nowMs() }, sql);
      return { kind: "rolled-back", code: "FAILED", actionKey };
    }
    if (receipt.status === "CONFIRMED") {
      await deps.journal.markCommitted(idempotencyKey, receipt.transactionHash === undefined ? {} : { txHash: receipt.transactionHash });
      await deps.store.setActionState({ ownerAddress: agent.ownerAddress, actionKey, from: ["intended"], to: "committed",
        txHash: receipt.transactionHash ?? null, callsHash, nowMs: nowMs() }, sql);
    } else {
      await deps.store.setActionState({ ownerAddress: agent.ownerAddress, actionKey, from: ["intended"], to: "submitted", callsHash, nowMs: nowMs() }, sql);
    }
    return { kind: "submitted", actionKey, receipt };
  });
}

/** For the worker: whether a native-cap refusal is a hold rather than a revert (R2.13 counts reverts only). */
export const DCA_HOLD_CODES: ReadonlySet<string> = new Set([
  "NATIVE_RESERVE", "dca-native-cap-exhausted", "QUOTE_DAILY_CAP", "GUARD_QUOTE_EXPIRED", "dca_key_conflict", "halted", "paused", "not_executable",
]);
