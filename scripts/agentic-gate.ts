import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BNB } from "@altananetwork/sdk";
import { type Address, type Hex, getAddress } from "viem";
import { createAgentStore, type AgentStore } from "../src/store/agents.js";
import { createJournal, type ExecutionJournal } from "../src/store/journal.js";
import { createTradeIntentStore } from "../src/store/tradeIntents.js";
import { createTradePositionStore, type TradePositionStore } from "../src/store/tradePositions.js";
import { createTradeSettingsStore } from "../src/store/tradeSettings.js";
import { createTradeCmcStore } from "../src/store/tradeCmc.js";
import { createKillSwitch, type KillSwitch } from "../src/killswitch/killswitch.js";
import { createPgSqlClient } from "../src/store/sql.js";
import { loadMasterKey } from "../src/store/crypto.js";
import { resolveHireEnabled, resolvePortfolioEnabled, resolveTradeConfig } from "../src/ops/config.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { HttpTradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import { createHttpTradeReadinessDataPlane } from "../src/trade/readiness.js";
import { createRouteQuoteReader } from "../src/trade/route.js";
import { createTradeLlm } from "../src/trade/llm.js";
import { runTradeWorkerOnce, submitTradfiV2GateBuy, type TradeWorkerDeps } from "../src/trade/worker.js";
import { resolveAgenticConfig } from "../src/agentic/config.js";
import { isTradfiAiSettings, parseTradeSettings } from "../src/trade/settings.js";
import { AgenticStore, decryptAgenticSession } from "../src/agentic/store.js";
import { BawRunner, bawConnectionSignal } from "../src/agentic/baw.js";
import { AgenticInstanceManager, agenticQuiescence, readAgenticHostIdentity } from "../src/agentic/instances.js";
import { agenticAddress, agenticDecimal, type AgenticGateRun } from "../src/agentic/domain.js";
import { dcaOrderTerminal } from "../src/agentic/dca.js";
import { isTradeDcaSettings } from "../src/trade/settings.js";
import { acquireAgenticFence } from "../src/agentic/obligations.js";
import { createAgenticChain, verifyAgenticSwap, verifyAgenticApproval, agenticList, agenticResolutionEvidence,
  resolveAgenticOrder, type AgenticChain } from "../src/agentic/resolve.js";
import { createAgenticCmc } from "../src/agentic/cmc.js";
import { createAgenticWorkerDeps, runAgenticCycle } from "../src/agentic/worker.js";

export type AgenticGateArgs = { command: string; values: Readonly<Record<string, string>>; live: boolean; simulateNoResponse: boolean };
const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  status: ["agent"], "dry-run": ["agent"], "reconcile-once": ["agent"],
  "run-start": ["gate", "agent", "side", "max-dispatches", "max-notional-usdt", "max-cmc-payments", "deadline-min"],
  "cycle-once": ["run", "yes-live", "simulate-no-response"], "cmc-once": ["run", "yes-live", "retry-failed"], "run-close": ["run"], "repair-fill": ["order", "yes-live"],
  "request-exit": ["agent", "position-index", "yes-live"], hold: ["agent"], unhold: ["agent"], "rfq-buy": ["run", "token", "yes-live"],
  dispose: ["order", "commit-tx", "commit-partial-tx", "rollback", "approve-tx", "no-approve", "attest", "deployment-stopped", "yes-live"],
};
export function parseAgenticGateArgs(argv: readonly string[]): AgenticGateArgs {
  const command = argv[0] ?? "", allowed = OPTIONS[command];
  if (allowed === undefined) throw new Error("AGENTIC_GATE_COMMAND");
  const values: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i]!.replace(/^--/, "");
    if (!argv[i]!.startsWith("--") || !allowed.includes(key) || Object.hasOwn(values, key)) throw new Error("AGENTIC_GATE_ARGUMENT");
    if (["yes-live", "simulate-no-response", "rollback", "no-approve", "retry-failed"].includes(key)) values[key] = "true";
    else { const value = argv[++i]; if (value === undefined || value.startsWith("--")) throw new Error("AGENTIC_GATE_ARGUMENT"); values[key] = value; }
  }
  return { command, values, live: values["yes-live"] === "true", simulateNoResponse: values["simulate-no-response"] === "true" };
}
export function agenticGateWallets(value: string | undefined): ReadonlySet<Address> {
  if (value === undefined || value.trim() === "") throw new Error("AGENTIC_GATE_ALLOWLIST");
  const wallets = value.split(",").map(v => agenticAddress(v.trim()));
  if (wallets.length === 0) throw new Error("AGENTIC_GATE_ALLOWLIST");
  return new Set(wallets);
}
export type AgenticGateContext = {
  store: AgenticStore; agents: AgentStore; journal: ExecutionJournal; positions: TradePositionStore; killswitch: KillSwitch;
  runner: BawRunner; chain: AgenticChain; masterKey: Buffer; instance: AgenticInstanceManager; wallets: ReadonlySet<Address>;
  cycle(args: AgenticGateArgs, agentId: string, run: AgenticGateRun | null): Promise<void>;
  /** AGENTIC-RFQ-STOCKS E13: this process's AGENTIC_RFQ_STOCKS_ENABLED, and the one RFQ buy (priced only unless `live`). Absent: the flag reads off. */
  rfqEnabled?: boolean;
  rfqBuy?(input: { agentId: string; run: AgenticGateRun; token: Address; live: boolean }): Promise<unknown>;
  print(value: unknown): void;
};
export async function runAgenticGate(args: AgenticGateArgs, context: AgenticGateContext): Promise<void> {
  const { values, command } = args;
  const order = command === "dispose" || command === "repair-fill" ? await context.store.getOrder(values["order"] ?? "") : null;
  const run = values["run"] === undefined ? null : await context.store.getRun(values["run"]);
  if (values["run"] !== undefined && run === null || (command === "dispose" || command === "repair-fill") && order === null) throw new Error("AGENTIC_GATE_TARGET");
  const agentId = order?.agentId ?? run?.agentId ?? values["agent"] ?? "";
  const agent = await context.agents.getAgentById(agentId), row = await context.store.byAgent(agentId);
  if (agent?.custodyModel !== "binance-agentic" || row?.walletAddress === null || row?.walletAddress === undefined
    || agent.walletAddress.toLowerCase() !== row.walletAddress || !context.wallets.has(row.walletAddress)
    || order !== null && order.walletAddress !== row.walletAddress || run !== null && run.wallet !== row.walletAddress) throw new Error("AGENTIC_GATE_CONFINEMENT");
  if (["cycle-once", "cmc-once"].includes(command) && (run === null || run.closedAt !== null || await context.store.now() >= run.deadlineMs)) throw new Error("AGENTIC_GATE_CLOSED");
  if (["cycle-once", "cmc-once", "request-exit", "repair-fill"].includes(command) && !args.live) throw new Error("AGENTIC_GATE_LIVE_REQUIRED");
  if (command === "rfq-buy") {
    // AGENTIC-RFQ-STOCKS E13: every condition below refuses before any quote or command; without --yes-live the buy is priced and nothing is written.
    const token = values["token"] !== undefined && /^0x[0-9a-fA-F]{40}$/u.test(values["token"]) ? agenticAddress(values["token"]) : null;
    if (token === null || run === null) throw new Error("AGENTIC_GATE_TARGET");
    if (context.rfqEnabled !== true || context.rfqBuy === undefined) throw new Error("AGENTIC_GATE_RFQ_DISABLED");
    const settings = row.hireParams === null ? null : parseTradeSettings(row.hireParams.settings);
    if (row.state !== "bound" || row.hireFacts?.rfq?.v !== 1 || settings === null || !settings.ok || !isTradfiAiSettings(settings.value.effective)) throw new Error("AGENTIC_GATE_RFQ_NOT_ACTIVE");
    if (run.side !== "buy" || run.closedAt !== null || run.dispatches >= run.maxDispatches || await context.store.now() >= run.deadlineMs) throw new Error("AGENTIC_GATE_CLOSED");
    if (!row.hireFacts.pinned.some(pinned => pinned.toLowerCase() === token) || !row.hireFacts.rfq.rfqOnly.some(only => only.toLowerCase() === token)) throw new Error("AGENTIC_GATE_TOKEN");
    const amount = BigInt(settings.value.effective.minEntryWei!), cap = agenticDecimal(run.maxNotionalUsdt);
    if (cap === null || amount > cap) throw new Error("AGENTIC_GATE_LIMITS");
    context.print(await context.rfqBuy({ agentId, run, token, live: args.live })); return;
  }
  if (command === "status") {
    let connection = row.state === "ended" ? "ended" : row.probe?.unreachableAtMs == null ? "connected" : "unreachable";
    let limits: unknown = row.factsRead;
    if (["bound", "ending"].includes(row.state) && row.sessionCiphertext !== null) {
      const fence = await acquireAgenticFence(context.store, row.walletAddress, context.instance.row.instanceId);
      if (fence === null) throw new Error("agentic_wallet_busy");
      try {
        if (await context.store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
        connection = bawConnectionSignal(await context.runner.run(["wallet", "status"], decryptAgenticSession(row, context.masterKey)));
        if (await context.store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
        const settings = await context.runner.run(["wallet", "settings"], decryptAgenticSession(row, context.masterKey));
        if (settings.kind === "ok" && typeof settings.data === "object" && settings.data !== null) {
          const s = settings.data as Record<string, unknown>;
          limits = { dailyLimit: s["dailyLimit"], quotaUsed: s["quotaUsed"], x402DailyLimit: s["x402DailyLimit"], x402QuotaUsed: s["x402QuotaUsed"],
            inactiveSignOutTime: s["inactiveSignOutTime"], signInMaxTime: s["signInMaxTime"], tradeAllTokens: s["tradeAllTokens"], abnormalTxnHandling: s["abnormalTxnHandling"] };
        } else limits = null;
      } finally { await context.store.releaseFence(fence); }
    }
    context.print({ agentId, wallet: row.walletAddress, state: row.state, hireEndMs: row.hireEndMs, settingsHold: row.settingsHold?.code ?? null,
      connection, limits, obligations: await context.store.walletObligations(row.walletAddress),
      // The 25 newest orders (a wedged leg writes hundreds of rolled-back rows); the store keeps them all.
      totalOrders: (await context.store.orders(row.walletAddress)).length,
      // A DCA hire also prints its rounds and trigger rows (AGENTIC-DCA-SPEC R3.12): no Binance read.
      ...(row.hireParams === null || !isTradeDcaSettings(row.hireParams.settings) ? {} : { dca: { rounds: await context.store.dcaRounds(agentId), orders: await context.store.dcaOrders(agentId) } }),
      orders: [...await context.store.orders(row.walletAddress)].sort((a, b) => b.createdAt - a.createdAt).slice(0, 25).map(o => ({ key: o.idempotencyKey, kind: o.kind, dispatch: o.dispatch, response: o.response, outcome: o.outcome,
        holdReason: o.holdReason, fillCheck: o.fillCheck, txHash: o.txHash, approveTxHash: o.approveTxHash, claimedAt: o.claimedAt,
        cliResult: o.cliResult, listedOrderId: o.listedOrderId, quoteAt: o.quoteAt })) }); return;
  }
  if (command === "run-start") {
    const gate = values["gate"], side = values["side"];
    const dispatches = Number(values["max-dispatches"]), cmc = Number(values["max-cmc-payments"]), minutes = Number(values["deadline-min"]);
    const notional = values["max-notional-usdt"];
    if (!["G0", "G1", "G2", "G3", "G4", "DG1", "DG2", "DG3", "DG4", "DG5", "DG6", "RG1", "RG2", "RG3", "RG4"].includes(gate ?? "") || !["buy", "sell", "none", "dca"].includes(side ?? "")
      || !Number.isSafeInteger(dispatches) || dispatches < 0 || !Number.isSafeInteger(cmc) || cmc < 0 || !Number.isSafeInteger(minutes) || minutes <= 0
      || notional === undefined || agenticDecimal(notional) === null) throw new Error("AGENTIC_GATE_LIMITS");
    const now = await context.store.now();
    if (!Number.isSafeInteger(now + minutes * 60_000)) throw new Error("AGENTIC_GATE_LIMITS");
    const created: AgenticGateRun = { runId: randomUUID(), gate: gate as AgenticGateRun["gate"], side: side as AgenticGateRun["side"], agentId,
      wallet: row.walletAddress, maxDispatches: dispatches, dispatches: 0, maxNotionalUsdt: notional, maxCmcPayments: cmc, cmcPayments: 0,
      cmcOperationIds: [], deadlineMs: now + minutes * 60_000, createdAt: now, closedAt: null };
    if (!await context.store.createRun(created)) throw new Error("AGENTIC_GATE_CONFLICT"); context.print(created); return;
  }
  // The counters are the run row read above (closeRun only sets closedAt), so the keep-alive negative check can show that no CMC slot was consumed.
  if (command === "run-close") { await context.store.closeRun(run!.runId); context.print({ runId: run!.runId, closed: true, dispatches: run!.dispatches, cmcPayments: run!.cmcPayments }); return; }
  if (command === "hold" || command === "unhold") {
    if (command === "hold") await context.killswitch.pauseAgent(agent.id, agent.ownerAddress); else await context.killswitch.unpauseAgent(agent.id, agent.ownerAddress);
    context.print({ agentId, paused: command === "hold" }); return;
  }
  if (command === "request-exit") {
    const index = Number(values["position-index"]), positions = await context.positions.listOpen(agent.ownerAddress, agent.id);
    if (!Number.isSafeInteger(index) || index < 0 || positions[index] === undefined || positions[index]!.agentId !== agent.id || positions[index]!.ownerAddress.toLowerCase() !== row.walletAddress) throw new Error("AGENTIC_GATE_POSITION");
    if (await context.positions.requestExit(agent.ownerAddress, agent.id, positions[index]!.positionId) === null) throw new Error("AGENTIC_GATE_POSITION");
    context.print({ requested: true, positionIndex: index }); return;
  }
  if (command === "repair-fill") {
    // A committed order's chain-verified fill, applied to the position still unverified for the same transaction (the shared worker reconcile does the same each cycle).
    const done = order!, hash = done.txHash;
    if (done.kind !== "swap" || done.outcome !== "committed" || hash === null) throw new Error("AGENTIC_GATE_TARGET");
    const verified = await verifyAgenticSwap(context.chain, done, hash, typeof done.evidence === "object" && done.evidence !== null && "disposition" in done.evidence && done.evidence.disposition === "commit-partial");
    if (verified === null) throw new Error("AGENTIC_GATE_UNVERIFIED");
    const position = (await context.positions.list(agent.ownerAddress, agent.id)).find(p => (done.side === "buy" ? p.entryTxHash : p.exitTxHash)?.toLowerCase() === hash.toLowerCase());
    if (position === undefined || verified.fill.receiptOwnershipKey === undefined) throw new Error("AGENTIC_GATE_TARGET");
    let outcome = "already-verified";
    if (done.side === "buy" && verified.fill.side === "buy" && position.verifiedEntryAtomic == null) {
      const adopted = await context.positions.adoptVerifiedEntry({ ownerAddress: agent.ownerAddress, agentId: agent.id, positionId: position.positionId,
        verifiedEntryAtomic: verified.input, receiptOwnershipKey: verified.fill.receiptOwnershipKey, tokenAmount: verified.output });
      outcome = adopted?.verifiedEntryAtomic === verified.input ? "repaired" : "refused";
    } else if (done.side === "sell" && verified.fill.side === "sell" && position.status === "closed" && position.exitReceiptOwnershipKey == null) {
      const adopted = await context.positions.adoptVerifiedExit({ ownerAddress: agent.ownerAddress, agentId: agent.id, positionId: position.positionId,
        exitWei: verified.output, receiptOwnershipKey: verified.fill.receiptOwnershipKey });
      outcome = adopted?.exitFillStatus === "verified" ? "repaired" : "refused";
    } else if (done.side === "sell" && position.status !== "closed") outcome = "position-open";
    context.print({ order: done.idempotencyKey, positionId: position.positionId, outcome, input: verified.input, output: verified.output }); return;
  }
  if (command !== "dispose") {
    if (command === "cmc-once" && run!.cmcPayments >= run!.maxCmcPayments) {
      await context.cycle({ ...args, command: "reconcile-once" }, agentId, run); throw new Error("AGENTIC_GATE_LIMIT");
    }
    await context.cycle(args, agentId, run); context.print({ command, agentId, complete: true }); return;
  }
  const fence = await acquireAgenticFence(context.store, row.walletAddress, context.instance.row.instanceId);
  if (fence === null) throw new Error("agentic_wallet_busy");
  try {
    let current = order!;
    let claimant = current.claimant === null ? null : await context.store.getInstance(current.claimant);
    if (!args.live) {
      const listed = ["bound", "ending"].includes(row.state) && current.kind === "swap" && current.listSnapshot !== null
        ? await agenticList(context.runner, context.store, context.masterKey, agentId, fence, ["--fromToken", current.fromToken!, "--toToken", current.toToken!, "--startTime", String(current.listSnapshot.startTimeMs)]) : null;
      context.print({ key: current.idempotencyKey, kind: current.kind, dispatch: current.dispatch, claimant: current.claimant, response: current.response,
        wallet: current.walletAddress, agentId: current.agentId, decisionId: current.decisionId, side: current.side, fromToken: current.fromToken, toToken: current.toToken,
        operationId: current.operationId, walletNoncePre: current.walletNoncePre, quoteAt: current.quoteAt, claimedAt: current.claimedAt, fenceToken: current.fenceToken,
        claimDeadline: current.claimDeadline, cliResult: current.cliResult, returnedOrderId: current.returnedOrderId, fromQty: current.fromQty, slippagePct: current.slippagePct,
        fillCheck: current.fillCheck, createdAt: current.createdAt, updatedAt: current.updatedAt,
        outcome: current.outcome, holdReason: current.holdReason, listSnapshot: current.listSnapshot, listedOrderId: current.listedOrderId, txHash: current.txHash,
        approveTxHash: current.approveTxHash, amountAtomic: current.amountAtomic, intendedRaw: current.intendedRaw, minOutAtomic: current.minOutAtomic,
        binanceQuoteOutAtomic: current.binanceQuoteOutAtomic, multiplierPre: current.multiplierPre, multiplierUsed: current.multiplierUsed,
        evidence: current.evidence, instance: claimant, list: listed, live: false }); return;
    }
    let quiescence: unknown = null;
    if (current.dispatch === "spawned" && current.response === null) {
      if (claimant === null) throw new Error("AGENTIC_QUIESCENCE_REQUIRED");
      await context.store.retire(claimant.instanceId, "dispose"); claimant = await context.store.getInstance(claimant.instanceId);
      const identity = claimant?.retiredBy === "exit" || claimant?.railwayDeploymentId !== null ? null : await readAgenticHostIdentity();
      const proof = claimant === null ? null : agenticQuiescence(claimant, current.claimedAt!, identity ?? { machineId: null, osBootMarker: null }, {
        ...(values["deployment-stopped"] === undefined ? {} : { deploymentStopped: values["deployment-stopped"] }), ...(values["attest"] === undefined ? {} : { attest: values["attest"] }) });
      if (proof === null) throw new Error("AGENTIC_QUIESCENCE_REQUIRED"); quiescence = proof;
    }
    const branches = ["commit-tx", "commit-partial-tx", "rollback", "approve-tx", "no-approve"].filter(k => values[k] !== undefined);
    if (branches.length !== 1 || current.outcome !== "open") throw new Error("AGENTIC_DISPOSITION_BRANCH");
    const branch = branches[0]!, attest = values["attest"]?.trim();
    if (["rollback", "commit-partial-tx", "no-approve"].includes(branch) && !attest) throw new Error("AGENTIC_ATTESTATION_REQUIRED");
    if (current.dispatch === "unclaimed") {
      const sealed = await context.store.patchOrder(current, { dispatch: "sealed" });
      if (sealed === null) throw new Error("AGENTIC_DISPOSITION_CONFLICT"); current = sealed;
    }
    const hashValue = values[branch], hash = hashValue !== undefined && /^0x[0-9a-f]{64}$/i.test(hashValue) ? hashValue.toLowerCase() as Hex : null;
    if (current.kind === "x402-sign") {
      if (!["approve-tx", "no-approve"].includes(branch)) throw new Error("AGENTIC_DISPOSITION_BRANCH");
      const proof = branch === "approve-tx" && hash !== null ? await verifyAgenticApproval(context.chain, current.walletAddress, hash) : null;
      if (branch === "approve-tx" && proof === null) throw new Error("AGENTIC_APPROVAL_UNVERIFIED");
      if (await context.store.patchOrder(current, { outcome: "committed", approveTxHash: hash, holdReason: null, evidence: { disposition: branch, proof, quiescence, attest } }) === null) throw new Error("AGENTIC_DISPOSITION_CONFLICT");
    } else if (current.kind !== "swap") {
      // R3.8: a row left by the retired limit build (neither a swap nor a sign) can only be rolled back: no journal step exists for it. Its DCA order, if not terminal, is cancelled by the plane.
      if (branch !== "rollback") throw new Error("AGENTIC_DISPOSITION_BRANCH");
      if (await context.store.patchOrder(current, { outcome: "rolled-back", holdReason: null, evidence: { disposition: branch, quiescence, attest } }) === null) throw new Error("AGENTIC_DISPOSITION_CONFLICT");
      const dca = await context.store.getDcaOrder(current.idempotencyKey.slice(current.idempotencyKey.indexOf(":") + 1));
      if (dca !== null && !dcaOrderTerminal(dca)) await context.store.patchDcaOrder(dca, { state: "cancelled", closedBy: "plane", holdReason: null });
    } else {
      if (!["rollback", "commit-tx", "commit-partial-tx"].includes(branch) || branch === "commit-partial-tx" && current.side !== "sell") throw new Error("AGENTIC_DISPOSITION_BRANCH");
      const fill = branch === "rollback" || hash === null ? null : await verifyAgenticSwap(context.chain, current, hash, branch === "commit-partial-tx");
      if (branch !== "rollback" && fill === null) throw new Error("AGENTIC_SWAP_UNVERIFIED");
      const entry = await context.journal.get(current.idempotencyKey);
      if (entry === null) throw new Error("AGENTIC_JOURNAL_MISSING");
      if (branch === "rollback") {
        if (entry.state === "COMMITTED") throw new Error("AGENTIC_DISPOSITION_CONFLICT");
        if (entry.state === "UNKNOWN") await context.journal.resolveUnknown(current.idempotencyKey, agenticResolutionEvidence(current, await context.store.now(), "operator-rollback"));
        else if (entry.state !== "ROLLED_BACK") await context.journal.markRolledBack(current.idempotencyKey, "operator-rollback");
        if (await context.store.patchOrder(current, { outcome: "rolled-back", holdReason: null, evidence: { disposition: branch, quiescence, attest } }) === null) throw new Error("AGENTIC_DISPOSITION_CONFLICT");
      } else {
        if (entry.state === "ROLLED_BACK") throw new Error("AGENTIC_DISPOSITION_CONFLICT");
        if (entry.state === "COMMITTED" && entry.externalRef.txHash !== hash
          || (await context.store.orders()).some(o => o.idempotencyKey !== current.idempotencyKey && o.txHash === hash)) throw new Error("AGENTIC_DISPOSITION_CONFLICT");
        if (entry.state === "UNKNOWN") await context.journal.advanceUnknown(current.idempotencyKey, agenticResolutionEvidence(current, await context.store.now(), branch, fill!.evidence), { txHash: hash! });
        else if (entry.state !== "COMMITTED") await context.journal.markCommitted(current.idempotencyKey, { txHash: hash! });
        if (await context.store.completeFill(current, { disposition: branch === "commit-partial-tx" ? "commit-partial" : branch,
          actualInput: fill!.input, actualOutput: fill!.output, proof: fill!.evidence, quiescence, attest }, fill!.output, hash) === null) throw new Error("AGENTIC_DISPOSITION_CONFLICT");
        if (current.minOutAtomic !== null && fill!.output < BigInt(current.minOutAtomic)) await context.positions.insertRun({ agentId: current.agentId,
          ownerAddress: current.walletAddress, dryRun: false, reason: "agentic-fill-check", events: [{ stage: current.side === "buy" ? "buy" : "sell", code: "fill-below-minimum",
            elapsedMs: 0, token: current.side === "buy" ? current.toToken! : current.fromToken!, reason: `out=${fill!.output} min=${current.minOutAtomic}` }] });
      }
    }
    context.print({ order: current.idempotencyKey, disposition: branch, obligations: await context.store.walletObligations(current.walletAddress) });
  } finally { await context.store.releaseFence(fence); }
}

async function main(): Promise<void> {
  const args = parseAgenticGateArgs(process.argv.slice(2)), wallets = agenticGateWallets(process.env["AGENTIC_GATE_WALLETS"]);
  const rpcUrls = resolveLpRpcUrls(process.env, { chain: BNB.chain, chainId: 56, publicRpcUrl: BNB.publicRpcUrl });
  const config = resolveAgenticConfig(process.env, { hireEnabled: resolveHireEnabled(process.env), tradeAgentEnabled: process.env["TRADE_AGENT_ENABLED"] === "true", rpcUrls });
  const masterKey = loadMasterKey(); if (!config.enabled || masterKey === null) throw new Error("AGENTIC_BOOT_REQUIREMENTS");
  const runner = new BawRunner(config.cli); await runner.checkBoot();
  const agents = await createAgentStore(), settings = await createTradeSettingsStore(agents), positions = await createTradePositionStore(), intents = await createTradeIntentStore();
  const journal = await createJournal(), cmc = await createTradeCmcStore(), killswitch = await createKillSwitch();
  const store = new AgenticStore(await createPgSqlClient(process.env["DATABASE_URL"]!), { agents, journal, intents, cmc, killswitch }); await store.initialize();
  const instance = await AgenticInstanceManager.start(store, runner, "agentic-gate");
  const chain = createAgenticChain(rpcUrls);
  if (["dry-run", "reconcile-once"].includes(args.command)) instance.stopClaiming();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { instance.stopClaiming(); runner.killChildren(); });
  let rfqOutput: unknown = null;
  try {
    await runAgenticGate(args, { store, agents, positions, journal, killswitch, instance, chain, runner, masterKey, wallets, rfqEnabled: config.rfq,
      async rfqBuy(input) {
        rfqOutput = null;
        await this.cycle({ command: "rfq-buy", values: { token: input.token }, live: input.live, simulateNoResponse: false }, input.agentId, input.run);
        return rfqOutput;
      },
      print: value => console.log(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)),
      async cycle(command, agentId, run) {
        const execution = { store, runner, chain, instance, masterKey, positions,
          ...(run === null ? {} : { gateRunId: run.runId }), simulateNoResponse: command.simulateNoResponse };
        const agenticCmc = createAgenticCmc({ ...execution, agents, settings, cmc, journal, killswitch, rpcUrls });
        try {
          if (command.command === "reconcile-once") {
            const row = await store.byAgent(agentId);
            if (row?.walletAddress === null || row?.walletAddress === undefined) throw new Error("AGENTIC_GATE_TARGET");
            for (const order of (await store.orders(row.walletAddress)).filter(o => o.agentId === agentId && (o.outcome === "open" || o.fillCheck === "pending"))) {
              const fence = await acquireAgenticFence(store, row.walletAddress, instance.row.instanceId);
              if (fence === null) throw new Error("agentic_wallet_busy");
              try { await resolveAgenticOrder({ ...execution, journal, order, fence }); } finally { await store.releaseFence(fence); }
            }
            await agenticCmc.reconcile(agentId); return;
          }
          if (command.command === "cmc-once") { await agenticCmc.refresh(agentId, command.values["retry-failed"] === "true" ? { retryFailed: true } : undefined); await agenticCmc.reconcile(agentId); return; }
          const trade = resolveTradeConfig(process.env, { chainId: 56, keyStore: getAddress(BNB.keyStore) });
          const dataPlaneOptions = { baseUrl: process.env["DATA_PLANE_URL"] ?? "", token: process.env["DATA_PLANE_TOKEN"] ?? "" };
          const dataPlane = new HttpTradeDataPlaneReads(dataPlaneOptions), probe = await createHttpTradeReadinessDataPlane(dataPlaneOptions).probeUniverse("bstocks");
          const rows = probe.status === 200 && probe.envelope !== null && probe.envelope.error === undefined && Array.isArray(probe.envelope.data) ? probe.envelope.data as Record<string, unknown>[] : [];
          const ready = rows.length >= 25 && rows.every(r => r["lane"] === "bstocks" && typeof r["address"] === "string" && /^0x[0-9a-f]{40}$/i.test(r["address"]));
          const readiness = { ready, allowlistAvailable: false, bstocksAddresses: new Set(rows.map(r => String(r["address"]).toLowerCase())) };
          const routeReader = createRouteQuoteReader({ rpcUrls }); if (await routeReader.getChainId() !== 56) throw new Error("AGENTIC_RPC_REQUIREMENTS");
          const executorDeps = { chainId: 56, keyStore: getAddress(BNB.keyStore), agentStore: agents, settingsStore: settings, journal, killswitch,
            providerRegistry: { get() { throw new Error("AGENTIC_NO_ALTANA_PROVIDER"); } }, trade,
            pancake: trade.venues.pancakeRouterV2 === undefined || trade.venues.wbnb === undefined ? null : { router: trade.venues.pancakeRouterV2, wbnb: trade.venues.wbnb },
            pancakeV3: trade.venues.pancakeRouterV3 === undefined || trade.venues.wbnb === undefined ? null : { router: trade.venues.pancakeRouterV3, wbnb: trade.venues.wbnb }, uniswapV3: null, flapPortal: null };
          const shared = { agentStore: agents, settingsStore: settings, positions, intents, journal, killswitch, dataPlane, readiness, rpcUrls, routeReader,
            portfolioEnabled: resolvePortfolioEnabled(process.env), provider: {}, platformFeeBps: 0, llmFor: (modelId: string) => createTradeLlm({ readKey: () => process.env["TRADE_LLM_API_KEY"] ?? process.env["OPENROUTER_API_KEY"] ?? "", model: modelId,
              ...(process.env["TRADE_LLM_BASE_URL"] ? { baseUrl: process.env["TRADE_LLM_BASE_URL"] } : {}) }),
            forbiddenAddresses: () => new Set<string>(), executor: { execute: async () => ({ kind: "denied", status: 409, code: "AGENTIC_GATE_NO_DISPATCH" }) },
            executorDeps, executionIdentity: () => { throw new Error("AGENTIC_GATE_NO_DISPATCH"); }, recoverFill: async () => { throw new Error("AGENTIC_GATE_NO_FILL"); } } as unknown as TradeWorkerDeps;
          let worker = createAgenticWorkerDeps({ shared, agents, settings, execution, executorDeps, cmc: agenticCmc, rfq: config.rfq });
          const allWorker = worker;
          worker = { ...worker, settingsStore: { ...worker.settingsStore, async listTradeAgentsForWorker(r) {
            const p = await allWorker.settingsStore.listTradeAgentsForWorker(r); return { rows: p.rows.filter(v => v.agentId === agentId), hasMore: p.hasMore, cursor: p.cursor }; },
            async listTradeAgentsForProjection(r) { const p = await allWorker.settingsStore.listTradeAgentsForProjection(r); return { rows: p.rows.filter(v => v.agentId === agentId), hasMore: p.hasMore, cursor: p.cursor }; } } };
          if (command.command === "rfq-buy") {
            // AGENTIC-RFQ-STOCKS E13: one RFQ buy at the minimum entry under this run; priced only without --yes-live. The worker below is confined to this agent like every other gate cycle.
            const agent = await worker.agentStore.getAgentById(agentId), settingsRow = agent === null ? null : await worker.settingsStore.get(agent.ownerAddress, agentId);
            if (agent === null || settingsRow === null) throw new Error("AGENTIC_GATE_TARGET");
            rfqOutput = await submitTradfiV2GateBuy(worker, agent, settingsRow, agenticAddress(command.values["token"]!), { live: command.live });
            return;
          }
          if (command.command === "dry-run") {
            const { refreshCmcNews: _refresh, cmcNews: _news, ...readonlyWorker } = worker;
            await runTradeWorkerOnce({ ...readonlyWorker, executor: { execute: async () => ({ kind: "denied", status: 409, code: "AGENTIC_GATE_NO_DISPATCH" }) } }, { dryRun: true });
          } else await runAgenticCycle({ ...execution, execution, agents, settings, worker, cmc: agenticCmc, journal },
            { reconciliationOnly: command.command === "reconcile-once", cmcOnly: command.command === "cmc-once" });
        } finally { await agenticCmc.runtime.close(); }
      },
    });
  } finally {
    await instance.finish(); await store.close();
    for (const resource of [settings, positions, intents, journal, cmc, killswitch, agents]) {
      try { await resource.close(); } catch { console.error("agentic_gate_close_failed"); }
    }
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const code = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(message) ? message : error instanceof Error ? error.name : "unknown";
  console.error(`agentic-gate refused or failed (${code}); inspect status before another money step`); process.exitCode = 1;
});
