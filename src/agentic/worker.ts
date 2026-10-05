import type { AgentStore } from "../store/agents.js";
import type { TradeSettingsRecord, TradeSettingsStore } from "../store/tradeSettings.js";
import type { TradePositionStore } from "../store/tradePositions.js";
import type { ExecutionJournal } from "../store/journal.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../trade/worker.js";
import type { ExecuteTradeDeps } from "../trade/execute.js";
import { tradeExecutionIdentity } from "../trade/execute.js";
import { freshNativeCostFacts, nativeCostToUsdtAtomic } from "../trade/cost.js";
import { WBNB_56 } from "../ops/venues.js";
import { USDT_56 } from "../trade/settlement.js";
import { isTradeDcaSettings, parseTradeSettings } from "../trade/settings.js";
import { agenticLastActivityMs, agenticUsesPaidIdleKeepAlive, projectAgenticSessionFacts, type AgenticWallet } from "./domain.js";
import { agenticDcaEnabled } from "./config.js";
import { runAgenticDcaStep } from "./dcaLane.js";
import { bawConnectionSignal, type BawRunner } from "./baw.js";
import { decryptAgenticSession, type AgenticStore } from "./store.js";
import type { AgenticInstanceManager } from "./instances.js";
import { acquireAgenticFence } from "./obligations.js";
import { resolveAgenticOrder, verifyAgenticSwap } from "./resolve.js";
import { executeAgenticTrade, readAgenticSettings, type AgenticExecutionDeps } from "./execute.js";
import type { AgenticCmc } from "./cmc.js";
import { createAgenticRfqStocks } from "./rfq.js";

export type AgenticLifecycleDeps = { store: AgenticStore; agents: AgentStore; settings: TradeSettingsStore;
  positions: TradePositionStore; runner: BawRunner; masterKey: Buffer; instance: AgenticInstanceManager };

async function revokeAgenticAgent(deps: AgenticLifecycleDeps, row: AgenticWallet): Promise<void> {
  if (row.agentId === null) return;
  const agent = await deps.agents.getAgentById(row.agentId);
  if (agent?.status === "armed") await deps.agents.transitionAgentStatus({ ownerAddress: agent.ownerAddress, agentId: agent.id,
    expectedStatus: "armed", expectedRowVersion: agent.rowVersion, status: "revoked" });
}

export async function resumeAgenticEnding(deps: AgenticLifecycleDeps, row: AgenticWallet): Promise<void> {
  if (row.state !== "ending" || row.walletAddress === null) return;
  await revokeAgenticAgent(deps, row);
  const now = await deps.store.now(), maximum = row.hireFacts?.signInMaxTimeMs;
  if (maximum === undefined || !Number.isSafeInteger(maximum) || row.acceptedAt === null || maximum <= row.acceptedAt + 3_600_000) {
    console.error("agentic_logout_no_max_time"); return;
  }
  // A stored end reason (stop-loss) is kept; AI, Schedule and portfolio rows reach here with none and write term-ended as before.
  if (now >= maximum) { await deps.store.patchWallet(row, { state: "ended", sessionCiphertext: null, endReason: row.endReason ?? "term-ended", endStage: "logged-out-by-max-time" }); return; }
  const open = (await deps.store.orders(row.walletAddress)).filter(o => o.outcome === "open" && o.holdReason === null);
  if (open.length > 0 && now < row.hireEndMs! + 1_800_000 || row.logout !== null && now - row.logout.lastAtMs < 600_000) return;
  const fence = await acquireAgenticFence(deps.store, row.walletAddress, deps.instance.row.instanceId);
  if (fence === null) return;
  try {
    const current = await deps.store.getWallet(row.pairingId);
    if (current?.state !== "ending" || current.sessionCiphertext === null || current.logout !== null && now - current.logout.lastAtMs < 600_000) return;
    row = current;
    if (await deps.store.renewFence(fence) === null) return;
    await deps.runner.run(["auth", "signout"], decryptAgenticSession(row, deps.masterKey));
    const attempted = await deps.store.patchWallet(row, { endStage: "signout-attempted", logout: { attempts: (row.logout?.attempts ?? 0) + 1, lastAtMs: now, lastResult: "unverified" } });
    if (attempted === null || await deps.store.renewFence(fence) === null) return;
    row = attempted;
    const result = await deps.runner.run(["wallet", "status"], decryptAgenticSession(row, deps.masterKey));
    if (bawConnectionSignal(result) === "U") await deps.store.patchWallet(row, { state: "ended", sessionCiphertext: null, endReason: row.endReason ?? "term-ended", endStage: "logged-out-verified",
      logout: { attempts: row.logout!.attempts, lastAtMs: now, lastResult: "verified" } });
    else {
      await deps.store.patchWallet(row, { endStage: "verify", logout: { attempts: row.logout!.attempts, lastAtMs: now, lastResult: "unverified" } });
      if (now - row.hireEndMs! >= 86_400_000) console.error("agentic_logout_pending");
    }
  } finally { await deps.store.releaseFence(fence); }
}

export function createAgenticWorkerDeps(input: { shared: TradeWorkerDeps; agents: AgentStore; settings: TradeSettingsStore;
  execution: AgenticExecutionDeps; executorDeps: ExecuteTradeDeps; cmc: AgenticCmc;
  /** AGENTIC_RFQ_STOCKS_ENABLED of this worker (AGENTIC-RFQ-STOCKS E7): RFQ-only entries; absent is off. The quote source below is set either way so a held RFQ position keeps its exits and marks. */ rfq?: boolean }): TradeWorkerDeps {
  const { shared, execution, agents, settings, cmc } = input;
  async function settingsPage(request: { limit: number; cursor: string | null }, projection: boolean) {
    const rows: TradeSettingsRecord[] = [];
    const now = await execution.store.now();
    for (const wallet of await execution.store.wallets()) {
      if (wallet.agentId === null || request.cursor !== null && wallet.agentId <= request.cursor) continue;
      const agent = await agents.getAgentById(wallet.agentId);
      if (agent?.custodyModel !== "binance-agentic" || !projection && (wallet.state !== "bound" || wallet.settingsHold !== null || agent.status !== "armed" || now >= wallet.hireEndMs!)) continue;
      const stored = await settings.get(agent.ownerAddress, agent.id);
      if (stored === null) continue;
      // The DCA lane step drives a DCA row; the shared entry listing would only answer dca-disabled for it every cycle (AGENTIC-DCA-SPEC 3.12). The projection listing is unchanged.
      if (!projection) { const parsed = parseTradeSettings(stored.params); if (parsed.ok && isTradeDcaSettings(parsed.value.effective)) continue; }
      rows.push(stored);
    }
    rows.sort((a, b) => a.agentId.localeCompare(b.agentId));
    const hasMore = rows.length > request.limit, page = rows.slice(0, request.limit);
    return { rows: page, hasMore, cursor: hasMore ? page.at(-1)!.agentId : null };
  }
  const executorDeps: ExecuteTradeDeps = { ...input.executorDeps, trade: { ...input.executorDeps.trade, feeBps: 0 }, agentStore: agents, settingsStore: settings };
  return {
    agentStore: { async getAgentById(id) {
      const agent = await agents.getAgentById(id), wallet = await execution.store.byAgent(id);
      return agent?.custodyModel === "binance-agentic" && wallet?.hireFacts != null ? { ...agent, sessionFacts: projectAgenticSessionFacts(wallet) } : null;
    }, transitionAgentStatus: agents.transitionAgentStatus.bind(agents) },
    settingsStore: { get: settings.get.bind(settings), withEntryFence: settings.withEntryFence.bind(settings),
      listTradeAgentsForWorker: r => settingsPage(r, false), listTradeAgentsForProjection: r => settingsPage(r, true) },
    positions: shared.positions, intents: shared.intents, journal: shared.journal,
    ...(shared.killswitch === undefined ? {} : { killswitch: shared.killswitch }),
    dataPlane: shared.dataPlane, readiness: shared.readiness, llmFor: shared.llmFor,
    ...(shared.modelOverride === undefined ? {} : { modelOverride: shared.modelOverride }),
    // TRADFI-ENTRY-TIMING review M1: hosted-custody AI-trade agents run the same entry lane.
    ...(shared.entryTimingMode === undefined ? {} : { entryTimingMode: shared.entryTimingMode }),
    // TRADFI-EXIT-RULES review H1: the same agents run the same AI-trade exit lane (runTradeWorkerOnce -> runTradfiV2Exits).
    ...(shared.tradfiExitRulesMode === undefined ? {} : { tradfiExitRulesMode: shared.tradfiExitRulesMode }),
    rpcUrls: shared.rpcUrls, ...(shared.routeReader === undefined ? {} : { routeReader: shared.routeReader }),
    ...(shared.knownRwaAddresses === undefined ? {} : { knownRwaAddresses: shared.knownRwaAddresses }),
    rfqStocks: createAgenticRfqStocks({ execution, entries: input.rfq === true }),
    ...(shared.verdictCache === undefined ? {} : { verdictCache: shared.verdictCache }),
    // Smart Portfolio runs through the shared worker on the same switch as Altana's; only the portfolio cycle reads it.
    ...(shared.portfolioEnabled === undefined ? {} : { portfolioEnabled: shared.portfolioEnabled }),
    forbiddenAddresses: shared.forbiddenAddresses, intervalMs: 60_000, platformFeeBps: 0,
    provider: { getTokenBalance: request => execution.chain.balance(request.wallet.address, request.token),
      getTokenMetadata: request => execution.chain.metadata(request.token),
      async readSpendInfos(request) {
        const row = (await execution.store.wallets()).find(w => w.walletAddress?.toLowerCase() === request.walletAddress.toLowerCase() && w.state === "bound");
        return row?.hireFacts === null || row?.hireFacts === undefined ? [] : [{ token: USDT_56, period: "day", periodCode: 2, limitWei: BigInt(row.hireFacts.quoteDayCapWei), currentSpentWei: 0n }];
      } },
    executorDeps, executor: { execute: request => executeAgenticTrade({ ...request, deps: executorDeps }, execution) },
    executionIdentity: (agent, request) => tradeExecutionIdentity({ agentId: agent.id, chainId: 56, request, trade: executorDeps.trade,
      pancake: executorDeps.pancake, pancakeV3: executorDeps.pancakeV3, uniswapV3: null, flapPortal: null }),
    entryBasisWei: (_agent, request) => request.side === "buy" ? request.amountWei : 0n,
    tradfiNativeCostUsdtAtomic: async () => { const facts = freshNativeCostFacts(await shared.dataPlane.tokensBatch([WBNB_56, USDT_56]), Date.now());
      return facts === null ? null : nativeCostToUsdtAtomic(400_000_000_000_000n, facts); },
    v2DataBudgetReservedWei: agent => cmc.protectedExposure(agent.id), cmcNews: cmc.runtime.worker!.news,
    refreshCmcNews: r => cmc.enqueue(r.agent.id, r.heldTickers, r.shortlistedTickers, r.llmRequests),
    async recoverFill(intent, hash) {
      const row = await execution.store.getOrder(intent.idempotencyKey);
      const partial = row !== null && typeof row.evidence === "object" && row.evidence !== null && "disposition" in row.evidence && row.evidence.disposition === "commit-partial";
      const fill = row === null ? null : await verifyAgenticSwap(execution.chain, row, hash, partial);
      // The unverified fallback below opens a position with no entry or amount: say so, so a receipt that cannot be verified here is visible.
      if (fill === null) console.error("agentic_recover_fill_unverified", intent.side, hash);
      return fill?.fill ?? (intent.side === "buy" ? { side: "buy", entryWei: intent.entryWei, tokenAmount: null, fillStatus: "unverified", receiptAttributable: false }
        : { side: "sell", exitWei: null, fillStatus: "unverified" });
    },
  };
}

export async function runAgenticCycle(input: AgenticLifecycleDeps & { execution: AgenticExecutionDeps; worker: TradeWorkerDeps; cmc: AgenticCmc; journal: ExecutionJournal;
  /** AGENTIC_DCA_ENABLED of this process; absent reads the environment (the boot already refused an invalid value). */ dcaEnabled?: boolean },
  options: { dryRun?: boolean; reconciliationOnly?: boolean; cmcOnly?: boolean } = {}): Promise<void> {
  const { store, instance } = input;
  if (input.execution.gateRunId !== undefined && !options.reconciliationOnly) {
    const run = await store.getRun(input.execution.gateRunId);
    if (run === null || run.closedAt !== null || await store.now() >= run.deadlineMs) throw new Error("AGENTIC_GATE_CLOSED");
  }
  for (let row of await store.wallets()) {
    if (row.agentId === null || row.walletAddress === null || row.hireFacts === null) continue;
    if (input.execution.gateRunId !== undefined && (await store.getRun(input.execution.gateRunId))?.agentId !== row.agentId) continue;
    try {
      let now = await store.now();
      if (!options.reconciliationOnly && row.state === "bound" && row.termEndAction === "sell-all" && row.drainRequestedAt === null && now >= row.entryCutoffMs!) {
        await input.settings.requestDrain(row.walletAddress, row.agentId);
        for (const p of await input.positions.listOpen(row.walletAddress, row.agentId)) await input.positions.requestExit(row.walletAddress, row.agentId, p.positionId);
        row = await store.patchWallet(row, { drainRequestedAt: now }) ?? row;
      }
      if (!options.reconciliationOnly && row.state === "bound" && now >= row.hireEndMs!) {
        row = await store.leaveBound(row, "term-ended") ?? row;
        await revokeAgenticAgent(input, row);
      }
      if (!options.reconciliationOnly && row.state === "bound" && (row.probe?.firstUAtMs != null && now - row.probe.firstUAtMs >= 60_000 || now - (row.probe?.lastAtMs ?? 0) >= 300_000)) {
        const fence = await acquireAgenticFence(store, row.walletAddress!, instance.row.instanceId);
        if (fence !== null) try {
          row = await store.byAgent(row.agentId!) ?? row;
          if (row.state === "bound" && await store.renewFence(fence) !== null) {
            const confirmation = row.probe?.firstUAtMs != null && now - row.probe.firstUAtMs >= 60_000;
            const signal = bawConnectionSignal(await input.runner.run(["wallet", "status"], decryptAgenticSession(row, input.masterKey)));
            now = await store.now();
            if (signal === "U" && confirmation) { row = await store.leaveBound(row, "owner-signed-out") ?? row; await revokeAgenticAgent(input, row); }
            else {
              row = await store.patchWallet(row, { probe: { lastAtMs: now, firstUAtMs: signal === "U" ? row.probe?.firstUAtMs ?? now : null,
                unreachableAtMs: signal === "unreachable" ? now : null,
                ...(row.probe?.keepAliveAtMs === undefined ? {} : { keepAliveAtMs: row.probe.keepAliveAtMs }) } }) ?? row;
              // A hire with no paid CMC calls would otherwise sit idle through a postponement or a finished schedule and let Binance's 48 h
              // inactivity sign-out end it. Its own orders count as activity; the read-only list below is discarded and never a connection signal.
              // A portfolio also pays a CMC call when idle, but only a quoted swap (measured to reset the timer) postpones this free read; a failing paid attempt never does.
              const paid = row.hireParams !== null && agenticUsesPaidIdleKeepAlive(row.hireParams.settings);
              if (signal === "connected" && (row.hireFacts?.hireSizing.cmcNewsEnabled !== true || paid)
                && now - (paid ? Math.max(row.probe?.keepAliveAtMs ?? row.acceptedAt ?? now, agenticLastActivityMs({ acceptedAt: row.acceptedAt ?? now, agentId: row.agentId!,
                  orders: await store.orders(row.walletAddress!), settledAttemptsCreatedAt: [] }, ["swap-quote"]))
                  : Math.max(row.probe?.keepAliveAtMs ?? row.acceptedAt ?? now, ...(await store.orders(row.walletAddress!)).map(o => o.createdAt))) >= 43_200_000) {
                const current = await store.byAgent(row.agentId!);
                if (current?.state === "bound" && await store.renewFence(fence) !== null) {
                  await input.runner.run(["market-order", "list", "--binanceChainId", "56", "--page", "1", "--pageSize", "1"], decryptAgenticSession(current, input.masterKey));
                  row = await store.patchWallet(current, { probe: { ...(current.probe ?? { lastAtMs: now, firstUAtMs: null, unreachableAtMs: null }), keepAliveAtMs: now } }) ?? current;
                }
              }
            }
          }
        } finally { await store.releaseFence(fence); }
      }
      if (!options.reconciliationOnly && row.state === "bound" && row.settingsHold !== null) {
        const fence = await acquireAgenticFence(store, row.walletAddress!, instance.row.instanceId);
        if (fence !== null) try {
          if (await readAgenticSettings(input.execution, row.agentId!, fence) !== null) {
            const current = await store.byAgent(row.agentId!);
            if (current?.state === "bound" && current.settingsHold !== null) await store.patchWallet(current, { settingsHold: null });
          }
        } finally { await store.releaseFence(fence); }
      }
      for (const order of (await store.orders(row.walletAddress!)).filter(o => o.agentId === row.agentId && (o.outcome === "open" || o.fillCheck === "pending"))) {
        const fence = await acquireAgenticFence(store, row.walletAddress!, instance.row.instanceId);
        if (fence !== null) try { await resolveAgenticOrder({ ...input.execution, journal: input.journal, order, fence }); }
        finally { await store.releaseFence(fence); }
      }
      // The Agentic DCA step (AGENTIC-DCA-SPEC R21.6): after the generic resolver and before the logout stages, for bound, ending and ended DCA rows; it returns the row it last wrote.
      if (row.hireParams !== null && isTradeDcaSettings(row.hireParams.settings) && ["bound", "ending", "ended"].includes(row.state)) {
        row = await runAgenticDcaStep({ store, positions: input.positions, runner: input.runner, masterKey: input.masterKey, instance, chain: input.execution.chain, execution: input.execution,
          worker: input.worker, cmc: input.cmc, journal: input.journal, dcaEnabled: input.dcaEnabled ?? agenticDcaEnabled(process.env) }, row, options);
      }
      if (!options.reconciliationOnly && row.state === "ending") await resumeAgenticEnding(input, row);
      if (row.state === "ended") await revokeAgenticAgent(input, row);
    } catch { console.error("agentic_cycle_wallet_failed"); }
  }
  if (!options.reconciliationOnly && !options.cmcOnly) {
    const run = input.execution.gateRunId === undefined ? null : await store.getRun(input.execution.gateRunId);
    const worker = run !== null && (run.side === "none" || run.dispatches >= run.maxDispatches)
      ? { ...input.worker, settingsStore: { ...input.worker.settingsStore, listTradeAgentsForWorker: async () => ({ rows: [], hasMore: false, cursor: null }) } } : input.worker;
    await runTradeWorkerOnce(worker, { dryRun: options.dryRun ?? false });
  }
  for (const row of await store.wallets()) if (row.agentId !== null) {
    if (input.execution.gateRunId !== undefined && (await store.getRun(input.execution.gateRunId))?.agentId !== row.agentId) continue;
    try { if (!options.reconciliationOnly && !options.dryRun) await input.cmc.refresh(row.agentId); await input.cmc.reconcile(row.agentId); }
    catch { console.error("agentic_cmc_cycle_failed"); }
  }
}

export function startAgenticLane(input: Parameters<typeof runAgenticCycle>[0], options: { dryRun: boolean; once: boolean }) {
  let stopping = false;
  let wake: (() => void) | null = null;
  const done = (async () => {
    do {
      const start = Date.now();
      try { await runAgenticCycle(input, { dryRun: options.dryRun }); } catch { console.error("agentic_lane_failed"); }
      if (stopping || options.once) break;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, Math.max(0, 60_000 - (Date.now() - start))); wake = () => { clearTimeout(timer); resolve(); }; });
    } while (!stopping);
  })();
  return { done, stop() { stopping = true; input.instance.stopClaiming(); wake?.(); }, async close() {
    stopping = true; input.instance.stopClaiming(); wake?.(); await done; await input.instance.finish(); await input.cmc.runtime.close();
  } };
}
