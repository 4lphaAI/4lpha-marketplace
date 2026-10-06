import type { Address } from "viem";
import type { ExecuteTradeInput, ExecuteTradeResult } from "../trade/execute.js";
import { tradfiV2SwapRefusal } from "../trade/execute.js";
import { USDT_56 } from "../trade/settlement.js";
import { isTradeDcaSettings, isTradePortfolioSettings, parseTradeSettings } from "../trade/settings.js";
import type { TradePositionStore } from "../store/tradePositions.js";
import { agenticAddress, agenticDecimal, agenticQuoteRaw, agenticSellAmount, agenticSlippage, agenticUiString,
  type AgenticFence, type AgenticOrder } from "./domain.js";
import { bawConnectionSignal, bawOrderId, bawSwapResponse, type BawRunner, type BawResult } from "./baw.js";
import { decryptAgenticSession, type AgenticStore } from "./store.js";
import type { AgenticInstanceManager } from "./instances.js";
import { acquireAgenticFence } from "./obligations.js";
import { agenticList, resolveAgenticOrder, terminalizeAgenticOrder, type AgenticChain } from "./resolve.js";

/** The seven non-transport names of the CLI error set (baw.ts ERROR_NAMES): a quote refused under one of them is Binance refusing the order, not the network failing. */
const QUOTE_REFUSAL_NAMES: ReadonlySet<string> = new Set(["SERVICE_ERROR", "ORDER_API_ERROR", "APP_CONFIRMATION_REQUIRED", "INSUFFICIENT_BALANCE", "INSUFFICIENT_GAS", "INVALID_TOKEN", "INVALID_PARAMETER"]);

export type AgenticExecutionDeps = {
  store: AgenticStore; runner: BawRunner; chain: AgenticChain; instance: AgenticInstanceManager;
  masterKey: Buffer; positions: TradePositionStore; gateRunId?: string; simulateNoResponse?: boolean;
};

export async function readAgenticSettings(deps: Pick<AgenticExecutionDeps, "store" | "runner" | "masterKey">,
  agentId: string, fence: AgenticFence): Promise<Record<string, unknown> | null> {
  const row = await deps.store.byAgent(agentId);
  if (row === null || row.hireFacts === null || !["bound", "hiring"].includes(row.state)
    || await deps.store.renewFence(fence) === null) return null;
  const result = await deps.runner.run(["wallet", "settings"], decryptAgenticSession(row, deps.masterKey));
  await recordAgenticConnection(deps.store, agentId, result);
  if (result.kind !== "ok" || typeof result.data !== "object" || result.data === null) return null;
  const s = result.data as Record<string, unknown>;
  const daily = agenticDecimal(s["dailyLimit"]), x402 = agenticDecimal(s["x402DailyLimit"]);
  const max = typeof s["signInMaxTime"] === "string" ? Date.parse(s["signInMaxTime"]) : NaN;
  const code = s["tradeAllTokens"] !== true ? "trade-all-tokens" : s["abnormalTxnHandling"] !== "AutoReject" ? "abnormal-handling"
    : !Number.isSafeInteger(max) || max < row.hireFacts.hireEndMs + 3_600_000 ? "sign-in-time"
    : daily === null || daily < BigInt(row.hireFacts.quoteDayCapWei) * 2n ? "daily-limit"
    : row.hireFacts.hireSizing.cmcNewsEnabled === true && (x402 === null || x402 < 500_000_000_000_000_000n) ? "x402-limit" : null;
  if (code !== null) { await deps.store.patchWallet(row, { settingsHold: { code, atMs: await deps.store.now() } }); return null; }
  return s;
}

export async function recordAgenticConnection(store: AgenticStore, agentId: string, result: BawResult): Promise<void> {
  const row = await store.byAgent(agentId);
  if (row?.state !== "bound") return;
  const signal = bawConnectionSignal(result);
  if (result.kind === "ok" && !(typeof result.data === "object" && result.data !== null && "status" in result.data)) return;
  if (signal === "connected") return;
  const now = await store.now();
  await store.patchWallet(row, { probe: { lastAtMs: row.probe?.lastAtMs ?? 0,
    firstUAtMs: signal === "U" ? row.probe?.firstUAtMs ?? now : row.probe?.firstUAtMs ?? null,
    unreachableAtMs: signal === "unreachable" ? now : row.probe?.unreachableAtMs ?? null,
    ...(row.probe?.keepAliveAtMs === undefined ? {} : { keepAliveAtMs: row.probe.keepAliveAtMs }) } });
}

export async function executeAgenticTrade(input: ExecuteTradeInput, deps: AgenticExecutionDeps): Promise<ExecuteTradeResult> {
  const { agent, request, idempotencyKey } = input;
  const meta = { idempotencyKey, decisionId: request.decisionId };
  const denied = (code: string): ExecuteTradeResult => ({ kind: "denied", status: 409, code });
  let wallet = await deps.store.byAgent(agent.id);
  if (wallet === null || wallet.walletAddress === null || wallet.hireFacts === null || agent.custodyModel !== "binance-agentic") return denied("not_executable");
  // AGENTIC-MEME-STOCKS-SPEC PA1: a paper meme hire never trades, whatever reaches this executor.
  if (wallet.hireFacts.meme?.mode === "paper") return denied("AGENTIC_MEME_PAPER");
  // 0 = not a portfolio hire: every portfolio branch below keys on this and leaves AI and Schedule hires as they were.
  const portfolioTokens = wallet.hireParams !== null && isTradePortfolioSettings(wallet.hireParams.settings) ? wallet.hireParams.settings.portfolioTokens!.length : 0;
  // R3.5: a gate run opened with side "dca" admits both sides of a DCA hire (its base, level and take-profit swaps); every other run side keeps its exact-match rule.
  const dcaSettings = wallet.hireParams !== null && isTradeDcaSettings(wallet.hireParams.settings) ? wallet.hireParams.settings : null;
  const dcaHire = dcaSettings !== null;
  const sideAllowed = (runSide: string): boolean => runSide === request.side || runSide === "dca" && dcaHire;
  // R3.6: a DCA hire admits a partial sell (its take profit sells Q <= the balance), as a portfolio does; every other sell is the whole balance.
  const partialSell = portfolioTokens > 0 || dcaHire;
  if (wallet.settingsHold !== null) return denied("AGENTIC_SETTINGS_HOLD");
  if (request.side === "buy" && (wallet.entriesStopped !== null || wallet.drainRequestedAt !== null)) return denied("AGENTIC_ENTRIES_STOPPED");
  if (deps.gateRunId !== undefined) {
    const run = await deps.store.getRun(deps.gateRunId);
    if (run === null || run.agentId !== agent.id || run.wallet !== wallet.walletAddress || !sideAllowed(run.side)
      || run.closedAt !== null || run.dispatches >= run.maxDispatches || await deps.store.now() >= run.deadlineMs) return denied("AGENTIC_GATE_LIMIT");
  }
  const prior = await input.deps.journal.getByDecision(agent.id, request.decisionId);
  if (prior !== null) {
    if (prior.kind !== "trade" || prior.externalRef.paramsHash !== input.paramsHash) return denied("conflict");
    if (prior.state === "ROLLED_BACK") return { kind: "rolled-back", code: "NOT_ALLOWED", failureCode: "NOT_ALLOWED", meta };
    if (prior.state === "COMMITTED") return { kind: "committed", receipt: { status: "CONFIRMED",
      ...(prior.externalRef.txHash === undefined ? {} : { transactionHash: prior.externalRef.txHash }) }, fill: null, meta };
    return { kind: "unknown", meta };
  }
  if (wallet.state !== "bound" || agent.status !== "armed" || !deps.instance.canClaim) return denied("not_executable");
  let fence = await acquireAgenticFence(deps.store, wallet.walletAddress, deps.instance.row.instanceId);
  if (fence === null) return denied("agentic_wallet_busy");
  let order: AgenticOrder | null = null;
  const seal = async (code: string, note: string = code): Promise<ExecuteTradeResult> => {
    if (order !== null) {
      const sealed = await deps.store.patchOrder(order, { dispatch: "sealed", cliResult: note });
      if (sealed === null) return { kind: "unknown", meta };
      const terminal = await terminalizeAgenticOrder(deps.store, input.deps.journal, sealed);
      if (terminal?.outcome !== "rolled-back") return { kind: "unknown", meta };
    }
    // A sealed portfolio leg proves no dispatch: it is released for re-planning, as Altana releases a pre-submit refusal (deniedBy). Only a sell the quote refuses as a LEG error stays terminal.
    const legRefusal = request.side === "sell" && code === "AGENTIC_QUOTE_REFUSED" && /:(INVALID_TOKEN|INVALID_PARAMETER)$/u.test(note);
    return { kind: "rolled-back", code, failureCode: "NOT_ALLOWED", meta: portfolioTokens > 0 && !legRefusal ? { ...meta, deniedBy: "session" } : meta };
  };
  try {
    if (await deps.store.walletObligations(wallet.walletAddress, { decisionId: request.decisionId })) return denied("AGENTIC_WALLET_OBLIGATION");
    if (agent.sessionFacts === null) return denied("not_executable");
    // R3.5: the Altana DCA parser sets minEntryWei = entryWei = base, so a level buy (amount = the order size) is checked as if its amount were the base. Nothing else about the request changes.
    const boundsRequest = dcaSettings !== null && request.side === "buy" && request.amountWei === BigInt(dcaSettings.dcaOrderWei!) ? { ...request, amountWei: BigInt(dcaSettings.entryWei) } : request;
    const bounds = await tradfiV2SwapRefusal({ ...input.deps, trade: { ...input.deps.trade, feeBps: 0 } }, agent, agent.sessionFacts, boundsRequest);
    if (!bounds.ok) return denied(bounds.code);
    const scan = await input.scanGate.evaluate({ chainId: 56, token: request.token, side: request.side,
      ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (scan.verdict === "deny") return denied("SCAN_DENIED");
    if (request.settlementAsset !== "USDT" || request.amountWei <= 0n || request.minOutWei <= 0n || request.quotedOutWei < request.minOutWei) return denied("AGENTIC_AMOUNT_UNREPRESENTABLE");
    const W = wallet.walletAddress, token = agenticAddress(request.token), usdt = agenticAddress(USDT_56);
    const from: Address = request.side === "buy" ? usdt : token, to = request.side === "buy" ? token : usdt;
    // A Schedule agent never sells, so its buy floor counts one token however many fills it holds.
    // A portfolio never opens a position: its buy floor counts the granted stocks, (N + 2) x 0.0004 BNB.
    const open = bounds.scheduleAgent ? 1 : portfolioTokens > 0 ? portfolioTokens : (await deps.positions.listOpen(agent.ownerAddress, agent.id)).length;
    // AGENTIC-EARN-SPEC 3.10: an earn hire's buy never spends the last 0.0004 BNB redeem reserve; sells keep their floor.
    if (await deps.chain.balance(W, null) < (request.side === "buy" ? BigInt(open + 2 + (wallet.hireFacts.earn !== undefined ? 1 : 0)) * 400_000_000_000_000n : 100_000_000_000_000n)) return denied("AGENTIC_LOW_BNB");
    const metadata = await deps.chain.metadata(token), multiplier = await deps.chain.multiplier(token);
    if (metadata.decimals !== 18 || multiplier < 10n ** 18n) return denied("AGENTIC_AMOUNT_UNREPRESENTABLE");
    let fromQty = agenticUiString(request.amountWei), multiplierPre = agenticUiString(multiplier);
    if (request.side === "buy") {
      if (await deps.chain.balance(W, usdt) < request.amountWei) return denied("AGENTIC_LOW_USDT");
    } else {
      // A portfolio sell is partial (R < B): the wallet may hold more than the planned amount. Every other sell is the whole balance.
      const held = await deps.chain.balance(W, token);
      if (partialSell ? held < request.amountWei : held !== request.amountWei) return denied("AGENTIC_AMOUNT_UNREPRESENTABLE");
      if (await deps.store.renewFence(fence) === null) return denied("agentic_wallet_busy");
      const balance = await deps.runner.run(["wallet", "balance", "--tokenAddress", token], decryptAgenticSession(wallet, deps.masterKey));
      await recordAgenticConnection(deps.store, agent.id, balance);
      if (balance.kind !== "ok" || !Array.isArray(balance.data)) return denied("AGENTIC_UNREACHABLE");
      const cache = typeof balance.rwaTokens === "object" && balance.rwaTokens !== null && "tokens" in balance.rwaTokens && Array.isArray(balance.rwaTokens.tokens) ? balance.rwaTokens.tokens : null;
      const cached = cache?.find((v: unknown) => v !== null && typeof v === "object"
        && (v as Record<string, unknown>)["contractAddress"]?.toString().toLowerCase() === token
        && (v as Record<string, unknown>)["chainId"]?.toString() === "56" && (v as Record<string, unknown>)["kind"] === "bstock") as Record<string, unknown> | undefined;
      const reported = balance.data.find((v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>)["binanceChainId"] === "56"
        && (v as Record<string, unknown>)["address"]?.toString().toLowerCase() === token) as Record<string, unknown> | undefined;
      if (typeof cached?.["multiplier"] !== "string" || typeof reported?.["balance"] !== "string") return denied("AGENTIC_AMOUNT_UNREPRESENTABLE");
      multiplierPre = cached["multiplier"];
      const quantity = agenticSellAmount(request.amountWei, multiplierPre, reported["balance"], partialSell ? held : request.amountWei);
      if (quantity === null) return denied("AGENTIC_AMOUNT_UNREPRESENTABLE");
      fromQty = quantity;
    }
    const settings = await readAgenticSettings(deps, agent.id, fence);
    if (settings === null) return denied("AGENTIC_SETTINGS_UNREADABLE");
    if (request.side === "buy" && agenticDecimal(settings["dailyLimit"])! - agenticDecimal(settings["quotaUsed"])! < request.amountWei) return denied("AGENTIC_DAILY_QUOTA");
    const now = await deps.store.now();
    const snapshot = await agenticList(deps.runner, deps.store, deps.masterKey, agent.id, fence,
      ["--fromToken", from, "--toToken", to, "--startTime", String(now - 86_400_000)]);
    if (snapshot === null) return denied("AGENTIC_LIST_SNAPSHOT_INCOMPLETE");
    order = { idempotencyKey, kind: "swap", walletAddress: W, agentId: agent.id, decisionId: request.decisionId,
      side: request.side, fromToken: from, toToken: to, amountAtomic: request.amountWei.toString(),
      intendedRaw: request.side === "sell" ? request.amountWei.toString() : null, fromQty, minOutAtomic: request.minOutWei.toString(),
      binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre, multiplierUsed: null,
      listSnapshot: { takenAtMs: now, startTimeMs: now - 86_400_000, ids: snapshot.rows.map(r => bawOrderId(r["orderId"])!) },
      operationId: null, walletNoncePre: null, quoteAt: null, dispatch: "unclaimed", claimedAt: null, claimant: null,
      fenceToken: null, claimDeadline: null, response: null, cliResult: null, returnedOrderId: null, listedOrderId: null,
      txHash: null, approveTxHash: null, outcome: "open", holdReason: null, evidence: null, fillCheck: "none", createdAt: now, updatedAt: now };
    const quoteSpendWei = request.side === "buy" ? request.amountWei : 0n;
    const begun = await deps.store.beginSwap(order, { idempotencyKey, agentId: agent.id, ownerAddress: W, kind: "trade", decisionId: request.decisionId,
      externalRef: { paramsHash: input.paramsHash, sessionGeneration: 1, ...(request.side === "buy" ? { quoteSpendWei: quoteSpendWei.toString() } : {}) },
      nativeSpendWei: 0n, ...(request.side === "buy" ? { quoteSpendWei } : {}) }, now - 86_400_000);
    if (!begun.created) return { kind: "unknown", meta };
    if ((begun.otherQuoteSpendWei ?? 0n) + quoteSpendWei > BigInt(wallet.hireFacts!.quoteDayCapWei)) return await seal("QUOTE_DAILY_CAP");
    if (await deps.store.renewFence(fence) === null) return await seal("agentic_wallet_busy");
    const quote = await deps.runner.run(["market-order", "quote", "--fromToken", from, "--toToken", to,
      "--fromTokenQty", fromQty, "--binanceChainId", "56"], decryptAgenticSession(wallet, deps.masterKey));
    await recordAgenticConnection(deps.store, agent.id, quote);
    if (quote.kind !== "ok" || typeof quote.data !== "object" || quote.data === null) {
      // A portfolio hire shows Binance's own refusal at quote time as itself; transport and session failures stay unreachable.
      if (portfolioTokens > 0 && quote.kind === "cli-error" && QUOTE_REFUSAL_NAMES.has(quote.name)) return await seal("AGENTIC_QUOTE_REFUSED", `quote-refused:${quote.code}:${quote.name}`);
      return await seal("AGENTIC_UNREACHABLE");
    }
    const q = (quote.data as Record<string, unknown>)["toCoinAmount"];
    const raw = typeof q !== "string" ? null : request.side === "sell" ? agenticDecimal(q) : agenticQuoteRaw(q, multiplierPre);
    if (raw === null || raw < request.minOutWei) return await seal("AGENTIC_QUOTE_BELOW_MIN");
    const storedSettings = await input.deps.settingsStore?.get(agent.ownerAddress, agent.id);
    const parsedSettings = storedSettings == null ? null : parseTradeSettings(storedSettings.params);
    if (parsedSettings?.ok !== true) return await seal("AGENTIC_SETTINGS_UNREADABLE");
    const slippage = agenticSlippage(raw, request.minOutWei, Math.min(input.deps.trade.maxSlippageBps, parsedSettings.value.effective.slippageBps));
    if (slippage === null) return await seal("AGENTIC_QUOTE_NO_HEADROOM");
    order = await deps.store.patchOrder(order, { quoteAt: await deps.store.now(), binanceQuoteOutAtomic: raw.toString(), slippagePct: slippage });
    if (order === null) return { kind: "unknown", meta };
    const renewed = await deps.store.renewFence(fence);
    if (renewed === null) return await seal("agentic_wallet_busy");
    fence = renewed;
    const command = await deps.runner.prepare(["market-order", "swap", "--fromToken", from, "--toToken", to,
      "--fromTokenQty", fromQty, "--slippage", slippage, "--binanceChainId", "56"], decryptAgenticSession(wallet, deps.masterKey));
    try {
      if (deps.gateRunId !== undefined) {
        const run = await deps.store.getRun(deps.gateRunId);
        const notional = request.side === "buy" ? request.amountWei : raw;
        if (run === null || run.agentId !== agent.id || run.wallet !== W || !sideAllowed(run.side)
          || notional > agenticDecimal(run.maxNotionalUsdt)! || !await deps.store.consumeRun(run.runId, "dispatch")) return await seal("AGENTIC_GATE_LIMIT");
      }
      if (await deps.store.walletObligations(W, { orderKey: idempotencyKey, decisionId: request.decisionId })) return await seal("AGENTIC_WALLET_OBLIGATION");
      deps.instance.beginDispatch();
      const tq = process.hrtime.bigint(), wall = Date.now();
      command.environment["FOURLPHA_START_DEADLINE_MS"] = String(wall + 7_000);
      try {
        const claimed = await deps.store.claimOrder(order, fence);
        if (claimed === null) return await seal("AGENTIC_CLAIM_REFUSED");
        order = claimed;
        if (Number(process.hrtime.bigint() - tq) >= 5_000_000_000) return await seal("spawn-late");
        const pending = command.start();
        let result = await pending;
        if (deps.simulateNoResponse) result = { kind: "no-response", code: "no-response", sessionPresent: true };
        if (result.kind === "not-started") {
          const stopped = await deps.store.patchOrder(order, { dispatch: "not-started", cliResult: "not-started" });
          if (stopped === null) { console.error("agentic_late_response", idempotencyKey, "not-started"); return { kind: "unknown", meta }; }
          const terminal = await terminalizeAgenticOrder(deps.store, input.deps.journal, stopped);
          if (terminal?.outcome !== "rolled-back") return { kind: "unknown", meta };
          return { kind: "rolled-back", code: "not-started", failureCode: "NOT_ALLOWED", meta: portfolioTokens > 0 ? { ...meta, deniedBy: "session" } : meta };
        }
        const response = bawSwapResponse(result);
        const cache = result.kind === "ok" && typeof result.rwaTokens === "object" && result.rwaTokens !== null && "tokens" in result.rwaTokens && Array.isArray(result.rwaTokens.tokens) ? result.rwaTokens.tokens : [];
        const used = cache.find((v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>)["contractAddress"]?.toString().toLowerCase() === token) as Record<string, unknown> | undefined;
        const recorded = await deps.store.patchOrder(order, { response: response.response, cliResult: response.note, returnedOrderId: response.orderId,
          multiplierUsed: request.side === "sell" && typeof used?.["multiplier"] === "string" && /^\d+(\.\d+)?$/.test(used["multiplier"]) ? used["multiplier"] : null,
          holdReason: response.response === "no-response" ? "no-response" : null });
        if (recorded === null) { console.error("agentic_late_response", idempotencyKey, response.response); return { kind: "unknown", meta }; }
        order = recorded;
        await recordAgenticConnection(deps.store, agent.id, result);
        const journal = await input.deps.journal.get(idempotencyKey);
        if (journal?.state === "PENDING") {
          if (response.response === "accepted") await input.deps.journal.markInProgress(idempotencyKey, {});
          else await input.deps.journal.markUnknown(idempotencyKey, response.note);
        }
        if (response.response !== "no-response") {
          const until = process.hrtime.bigint() + 20_000_000_000n;
          do {
            const fill = await resolveAgenticOrder({ ...deps, journal: input.deps.journal, order, fence });
            const current = await deps.store.getOrder(idempotencyKey);
            if (current?.outcome === "committed" && current.txHash !== null) return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: current.txHash }, fill, meta };
            if (current?.outcome === "rolled-back") return { kind: "rolled-back", code: "binance-rejected", failureCode: "NOT_ALLOWED", meta };
            if (current?.holdReason !== null) break;
            await new Promise<void>(resolve => setTimeout(resolve, 2_000));
          } while (process.hrtime.bigint() < until);
        }
        return { kind: "unknown", meta };
      } finally { deps.instance.endDispatch(); }
    } finally { await command.close(); }
  } catch {
    if (order?.dispatch === "unclaimed") return await seal("AGENTIC_UNREACHABLE");
    return order === null ? denied("AGENTIC_UNREACHABLE") : { kind: "unknown", meta };
  } finally { await deps.store.releaseFence(fence); }
}
