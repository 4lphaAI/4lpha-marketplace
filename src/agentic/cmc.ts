import type { X402PaymentPayload } from "@altananetwork/sdk";
import type { Hex } from "viem";
import { sanitizeMessage } from "../core/errors.js";
import type { CmcChallenge } from "../trade/cmc.js";
import { createCmcRuntime, cmcProtectedExposureWei, type CmcRuntimeTarget } from "../trade/cmcRuntime.js";
import { createCmcFetchTransport, readSignedAuthorization, type CmcTransport, type CmcRuntimeAuthorization } from "../trade/cmcPayment.js";
import type { CmcBudgetStore } from "../store/tradeCmc.js";
import type { AgentStore } from "../store/agents.js";
import type { TradeSettingsStore } from "../store/tradeSettings.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import type { ExecutionJournal } from "../store/journal.js";
import { isTradfiAiSettings, parseTradeSettings } from "../trade/settings.js";
import { USDT_56 } from "../trade/settlement.js";
import { AGENTIC_PAID_KEEPALIVE_IDLE_MS, agenticAddress, agenticDecimal, agenticLastActivityMs, agenticUsesPaidIdleKeepAlive, projectAgenticSessionFacts, type AgenticFence, type AgenticOrder } from "./domain.js";
import { decryptAgenticSession, type AgenticStore } from "./store.js";
import type { BawRunner } from "./baw.js";
import type { AgenticInstanceManager } from "./instances.js";
import { acquireAgenticFence, agenticPayCheck } from "./obligations.js";
import { verifyAgenticApproval, terminalizeAgenticOrder, type AgenticChain } from "./resolve.js";
import { readAgenticSettings, recordAgenticConnection } from "./execute.js";

type RefusalStep = "header-missing" | "header-unparseable" | "authorization-shape" | "authorization-mismatch" | "nonce-range" | "rebind-refused";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Keys mapped to typeof, recursive, signature omitted: no value of the payload ever appears. */
function shapeOf(value: unknown, depth = 0): unknown {
  if (!isRecord(value)) return Array.isArray(value) ? "array" : typeof value;
  return depth >= 6 ? "object" : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "signature").map(([key, item]) => [key, shapeOf(item, depth + 1)]));
}
/** Non-secret facts for one refused signed authorization (G0 diagnostics): no signature, nonce value, header, payment id or session material. */
function refusalFacts(step: RefusalStep, signed: Record<string, unknown>, payload: unknown, challenge: CmcChallenge, wallet: string, preparedDeadline: bigint | null, nowSec: number): Record<string, unknown> {
  const inner = isRecord(payload) && isRecord(payload["payload"]) ? payload["payload"] : null;
  const permit = inner !== null && isRecord(inner["permit2Authorization"]) ? inner["permit2Authorization"] : null;
  const permitted = permit !== null && isRecord(permit["permitted"]) ? permit["permitted"] : null;
  const witness = permit !== null && isRecord(permit["witness"]) ? permit["witness"] : null;
  const same = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  let deadlineInSec: number | null = null;
  try { if (typeof permit?.["deadline"] === "string") deadlineInSec = Number(BigInt(permit["deadline"]) - BigInt(nowSec)); } catch { deadlineInSec = null; }
  let amountMatches = false;
  try { amountMatches = typeof permitted?.["amount"] === "string" && BigInt(permitted["amount"]) === challenge.amountWei; } catch { amountMatches = false; }
  const expires = signed["signatureExpiresAt"];
  const expiresMs = typeof expires === "number" ? (expires > 1e12 ? expires : expires * 1000) : typeof expires === "string" ? (/^\d+$/u.test(expires) ? Number(expires) * (expires.length > 11 ? 1 : 1000) : Date.parse(expires)) : Number.NaN;
  return { step, payloadShape: payload === null || payload === undefined ? shapeOf(signed) : shapeOf(payload),
    validAfter: typeof witness?.["validAfter"] === "string" ? witness["validAfter"] : null, deadlineInSec,
    preparedDeadlineInSec: preparedDeadline === null ? null : Number(preparedDeadline) - nowSec,
    rebindLimitInSec: preparedDeadline === null ? null : Math.max(Number(preparedDeadline) + 60, nowSec + 180) - nowSec, maxTimeoutSeconds: challenge.maxTimeoutSeconds,
    fromMatches: same(permit?.["from"], wallet), tokenMatches: same(permitted?.["token"], challenge.asset), amountMatches,
    spenderMatches: same(permit?.["spender"], challenge.spender), toMatches: same(witness?.["to"], challenge.payTo),
    approveTxHashPresent: typeof signed["approveTxHash"] === "string" && signed["approveTxHash"] !== "",
    signatureExpiresInSec: Number.isFinite(expiresMs) ? Math.round(expiresMs / 1000) - nowSec : null };
}

export function createAgenticCmc(input: { store: AgenticStore; cmc: CmcBudgetStore; agents: AgentStore; settings: TradeSettingsStore;
  killswitch: KillSwitch; journal: ExecutionJournal; runner: BawRunner; chain: AgenticChain; masterKey: Buffer;
  instance: AgenticInstanceManager; rpcUrls: readonly string[]; gateRunId?: string; transport?: CmcTransport }) {
  const fences = new Map<string, AgenticFence>();
  const admitted = new Map<string, string>();
  const cmc = new Proxy(input.cmc, { get(target, key): unknown {
    if (key === "claimNewsSlot") return async (request: Parameters<CmcBudgetStore["claimNewsSlot"]>[0]) => {
      if (input.gateRunId !== undefined) {
        if (admitted.get(request.agentId) !== "") return false;
      }
      const claimed = await target.claimNewsSlot(request);
      if (claimed && input.gateRunId !== undefined) { admitted.set(request.agentId, request.operationId); await input.store.bindRunOperation(input.gateRunId, request.operationId); }
      return claimed;
    };
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const authorize: CmcRuntimeAuthorization = async request => {
    const fence = fences.get(request.agentId);
    if (fence === undefined) return { ok: false, reason: "agentic_wallet_busy" };
    const wallet = await input.store.byAgent(request.agentId), agent = await input.agents.getAgentById(request.agentId);
    const budget = await input.cmc.get(request.agentId, request.ownerAddress);
    const settings = agent === null ? null : await input.settings.get(agent.ownerAddress, agent.id);
    const parsed = settings === null ? null : parseTradeSettings(settings.params);
    const facts = wallet?.hireFacts === null || wallet?.hireFacts === undefined ? null : projectAgenticSessionFacts(wallet);
    const held = await input.journal.sumPendingQuoteSpendSince(request.agentId, 0);
    const balance = await input.chain.balance(request.wallet, USDT_56);
    const sign = (await input.store.orders(request.wallet)).find(o => o.kind === "x402-sign" && o.operationId === request.operationId);
    if (wallet?.state !== "bound" || wallet.settingsHold !== null || agent?.status !== "armed" || agent.custodyModel !== "binance-agentic"
      || agent.ownerAddress.toLowerCase() !== request.ownerAddress.toLowerCase() || agent.walletAddress.toLowerCase() !== request.wallet.toLowerCase()
      || agent.pendingRenewal !== null && agent.pendingRenewal !== undefined || parsed?.ok !== true
      // AI hires opt in through their signed settings; a portfolio hire (keep-alive) through the hire's own facts, its signed settings forbid CMC.
      || !(isTradfiAiSettings(parsed.value.effective) && parsed.value.effective.cmcNewsEnabled === true
        || agenticUsesPaidIdleKeepAlive(parsed.value.effective) && wallet.hireFacts?.hireSizing.cmcNewsEnabled === true) || facts === null || facts.publicKey !== request.sessionPublicKey
      || facts.expiry !== request.sessionExpiry || request.generation !== 1 || budget === null || !budget.optedIn
      || balance - held < request.amountWei || await input.killswitch.isBlocked(agent.id, agent.ownerAddress)) return { ok: false, reason: "cmc_session_or_budget_mismatch" };
    const fresh = await readAgenticSettings(input, agent.id, fence);
    if (fresh === null || agenticDecimal(fresh["x402DailyLimit"])! - agenticDecimal(fresh["x402QuotaUsed"])! < 10_000_000_000_000_000n) return { ok: false, reason: "AGENTIC_SETTINGS_UNREADABLE" };
    if (input.gateRunId !== undefined && request.operationId !== undefined && admitted.get(agent.id) !== request.operationId) return { ok: false, reason: "AGENTIC_GATE_LIMIT" };
    return await agenticPayCheck(input.store, input.instance, fence, agent.id, request.operationId, sign?.idempotencyKey)
      ? { ok: true } : { ok: false, reason: "agentic_payment_refused" };
  };
  const runtime = createCmcRuntime({ store: cmc, worker: {
    masterKey: input.masterKey, rpcUrls: [input.rpcUrls[0]!, input.rpcUrls[1]!],
    ...(input.rpcUrls[2] === undefined ? {} : { discoveryRpcUrl: input.rpcUrls[2] }),
    transport: input.transport ?? createCmcFetchTransport(), authorize,
    refreshCapability: async ({ target }) => {
      const wallet = await input.store.byAgent(target.agentId), budget = await input.cmc.get(target.agentId, target.ownerAddress);
      const available = wallet?.state === "bound" && budget?.generation === target.budgetGeneration;
      await input.cmc.setCapability({ agentId: target.agentId, ownerAddress: target.ownerAddress, generation: target.budgetGeneration,
        available, ...(available ? {} : { reason: "agentic-ended" }) });
      return available ? { ok: true } : { ok: false, reason: "agentic-ended" };
    },
    signer: { async sign(request) {
      let fence = fences.get(request.agentId);
      const wallet = await input.store.byAgent(request.agentId), budget = await input.cmc.get(request.agentId, request.wallet);
      const operationId = budget?.pendingOperationId;
      const attempt = operationId === null || operationId === undefined ? null : await input.cmc.getAttempt(request.agentId, request.wallet, operationId);
      if (fence === undefined || wallet?.state !== "bound" || attempt?.state !== "prepared" || operationId === null || operationId === undefined) throw new Error("agentic_payment_refused");
      const fresh = await readAgenticSettings(input, request.agentId, fence);
      if (fresh === null || agenticDecimal(fresh["x402DailyLimit"])! - agenticDecimal(fresh["x402QuotaUsed"])! < 10_000_000_000_000_000n
        || await input.store.renewFence(fence) === null || !await agenticPayCheck(input.store, input.instance, fence, request.agentId, operationId)) throw new Error("agentic_payment_refused");
      const challenge = request.challenge;
      const requirements = { x402Version: 2, resource: { url: challenge.resource }, accepts: [{ scheme: "exact", network: challenge.network,
        asset: challenge.asset, amount: challenge.amountWei.toString(), payTo: challenge.payTo, maxTimeoutSeconds: challenge.maxTimeoutSeconds,
        extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", spenderAddress: challenge.spender,
          signerAddress: challenge.signerAddress, x402PaymentConfigId: challenge.configId } }] };
      const preview = await input.runner.run(["x402-payment", "preview", "--paymentRequirements", Buffer.from(JSON.stringify(requirements)).toString("base64")], decryptAgenticSession(wallet, input.masterKey));
      await recordAgenticConnection(input.store, request.agentId, preview);
      if (preview.kind !== "ok" || typeof preview.data !== "object" || preview.data === null) throw new Error("agentic_preview_failed");
      const data = preview.data as { paymentId: string; options: Record<string, unknown>[] };
      const options = data.options.filter(o => o["status"] === "READY_TO_SIGN" && o["binanceChainId"] === "56"
        && typeof o["tokenAddress"] === "string" && o["tokenAddress"].toLowerCase() === challenge.asset.toLowerCase()
        && typeof o["userWalletAddress"] === "string" && o["userWalletAddress"].toLowerCase() === request.wallet.toLowerCase()
        && typeof o["payTo"] === "string" && o["payTo"].toLowerCase() === challenge.payTo.toLowerCase()
        // G0 measured 2026-10-03: the preview option names the method "permit2" while the CMC challenge says "permit2-exact".
        && (o["assetTransferMethod"] === "permit2" || o["assetTransferMethod"] === "permit2-exact")
        && agenticDecimal(o["amount"]) === challenge.amountWei && Number.isSafeInteger(o["index"]));
      if (options.length !== 1) throw new Error("agentic_preview_failed");
      const now = await input.store.now();
      let order: AgenticOrder = { idempotencyKey: "x402-sign:" + operationId, kind: "x402-sign", walletAddress: agenticAddress(request.wallet),
        agentId: request.agentId, decisionId: null, side: null, fromToken: null, toToken: null, amountAtomic: null, intendedRaw: null,
        fromQty: null, minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null,
        listSnapshot: null, operationId, walletNoncePre: (await input.chain.nonce(request.wallet)).toString(), quoteAt: null, dispatch: "unclaimed",
        claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null, response: null, cliResult: null, returnedOrderId: null,
        listedOrderId: null, txHash: null, approveTxHash: null, outcome: "open", holdReason: null, evidence: null, fillCheck: "none", createdAt: now, updatedAt: now };
      if (!await input.store.createOrder(order)) throw new Error("agentic_sign_exists");
      const renewed = await input.store.renewFence(fence);
      if (renewed === null) throw new Error("agentic_wallet_busy");
      fence = renewed; fences.set(request.agentId, renewed);
      const command = await input.runner.prepare(["x402-payment", "sign", "--paymentId", data.paymentId, "--selectedIndex", String(options[0]!["index"])], decryptAgenticSession(wallet, input.masterKey));
      try {
        if (input.gateRunId !== undefined && !await input.store.consumeRun(input.gateRunId, "dispatch")) throw new Error("AGENTIC_GATE_LIMIT");
        if (await input.store.walletObligations(request.wallet, { orderKey: order.idempotencyKey, operationId })) throw new Error("agentic_payment_refused");
        input.instance.beginDispatch();
        const tq = process.hrtime.bigint(), wall = Date.now();
        command.environment["FOURLPHA_START_DEADLINE_MS"] = String(wall + 7_000);
        try {
          const claimed = await input.store.claimOrder(order, fence);
          if (claimed === null) throw new Error("agentic_payment_refused");
          order = claimed;
          if (Number(process.hrtime.bigint() - tq) >= 5_000_000_000) {
            const sealed = await input.store.patchOrder(order, { dispatch: "sealed", cliResult: "spawn-late" });
            if (sealed !== null) await terminalizeAgenticOrder(input.store, input.journal, sealed);
            throw new Error("agentic_spawn_late");
          }
          const pending = command.start();
          const result = await pending;
          if (result.kind === "not-started") {
            const stopped = await input.store.patchOrder(order, { dispatch: "not-started", cliResult: "not-started" });
            if (stopped !== null) await terminalizeAgenticOrder(input.store, input.journal, stopped);
            else console.error("agentic_late_response", order.idempotencyKey, "not-started");
            throw new Error("agentic_not_started");
          }
          const signed = result.kind === "ok" && typeof result.data === "object" && result.data !== null ? result.data as Record<string, unknown> : null;
          const hash = typeof signed?.["approveTxHash"] === "string" && /^0x[0-9a-f]{64}$/i.test(signed["approveTxHash"]) ? signed["approveTxHash"].toLowerCase() as Hex : null;
          const recorded = await input.store.patchOrder(order, { response: signed === null ? "no-response" : "accepted", cliResult: signed === null ? "sign-failed" : "signed",
            approveTxHash: hash, holdReason: signed === null ? "sign-failed" : hash === null ? null : "approve-unverified" });
          if (recorded === null) { console.error("agentic_late_response", order.idempotencyKey, signed === null ? "no-response" : "accepted"); throw new Error("agentic_late_response"); }
          order = recorded;
          if (signed === null) throw new Error("agentic_sign_failed");
          // A null approveTxHash means no approve was needed, exactly like an absent key; any other non-hash value is held.
          if (signed["approveTxHash"] !== undefined && signed["approveTxHash"] !== null && hash === null) throw new Error("agentic_approve_unverified");
          const until = process.hrtime.bigint() + 60_000_000_000n;
          let proof: Awaited<ReturnType<typeof verifyAgenticApproval>> = null;
          while (hash !== null && proof === null && process.hrtime.bigint() < until) {
            const remaining = Math.max(1, Math.ceil(Number(until - process.hrtime.bigint()) / 1_000_000));
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { proof = await Promise.race([verifyAgenticApproval(input.chain, request.wallet, hash), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); })]); }
            finally { if (timer !== undefined) clearTimeout(timer); }
            if (process.hrtime.bigint() >= until) { proof = null; break; }
            if (proof === null) await new Promise<void>(resolve => setTimeout(resolve, Math.min(2_000, Math.max(1, Number(until - process.hrtime.bigint()) / 1_000_000))));
          }
          if (hash !== null && proof === null) throw new Error("agentic_approve_unverified");
          const terminal = await input.store.patchOrder(order, { outcome: "committed", holdReason: null, evidence: hash === null ? { code: "no-approve" } : proof });
          if (terminal === null) { console.error("agentic_late_response", order.idempotencyKey, "accepted"); throw new Error("agentic_late_response"); }
          const header = signed["paymentHeaderValue"];
          let step: RefusalStep = "header-missing", payload: X402PaymentPayload | null = null, factsNowSec = Math.floor(await input.store.now() / 1_000);
          const logRefusal = (): void => console.error("agentic_signed_authorization_refused", JSON.stringify(refusalFacts(step, signed, payload, challenge, request.wallet, attempt.deadline, factsNowSec)));
          let authorization: ReturnType<typeof readSignedAuthorization>;
          try {
            if (typeof header !== "string") throw new Error("agentic_signature_invalid");
            step = "header-unparseable";
            payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as X402PaymentPayload;
            step = "authorization-shape";
            authorization = readSignedAuthorization(header, payload, challenge, request.wallet, factsNowSec, { validAfterMaxSec: factsNowSec + 60 });
            step = "nonce-range";
            if (authorization.nonce < 0n || authorization.nonce >= (1n << 256n)) throw new Error("agentic_signature_invalid");
          } catch (error) {
            if (step === "authorization-shape" && !(error instanceof Error && /malformed/iu.test(error.message))) step = "authorization-mismatch";
            logRefusal(); throw error;
          }
          const rebindNow = await input.store.now();
          if (!await agenticPayCheck(input.store, input.instance, fence, request.agentId, operationId, order.idempotencyKey)) throw new Error("agentic_payment_refused");
          factsNowSec = Math.floor(rebindNow / 1_000); step = "rebind-refused";
          let rebound: Awaited<ReturnType<NonNullable<CmcBudgetStore["rebindAgenticPaymentNonce"]>>> = null;
          try {
            rebound = input.cmc.rebindAgenticPaymentNonce === undefined ? null : await input.cmc.rebindAgenticPaymentNonce({ agentId: request.agentId, ownerAddress: request.wallet,
              operationId, budgetGeneration: attempt.generation, preparedNonce: request.nonce, signedNonce: authorization.nonce,
              signedDeadline: authorization.deadline, signedValidAfter: authorization.validAfter, sessionExpiry: request.sessionExpiry, nowMs: rebindNow });
          } catch (error) { logRefusal(); throw error; }
          if (rebound === null) { logRefusal(); throw new Error("agentic_nonce_rebind_refused"); }
          await request.onSigned(authorization);
          return authorization;
        } finally { input.instance.endDispatch(); }
      } catch (error) {
        if (order.dispatch === "unclaimed") {
          const sealed = await input.store.patchOrder(order, { dispatch: "sealed", cliResult: "sign-refused" });
          if (sealed !== null) await terminalizeAgenticOrder(input.store, input.journal, sealed);
        }
        throw error;
      } finally { await command.close(); }
    } },
  } });
  async function target(agentId: string): Promise<CmcRuntimeTarget | null> {
    const row = await input.store.byAgent(agentId);
    if (row?.walletAddress === null || row?.walletAddress === undefined || row.hireFacts === null) return null;
    const facts = projectAgenticSessionFacts(row), budget = await input.cmc.get(agentId, row.walletAddress);
    return { agentId, ownerAddress: row.walletAddress, wallet: row.walletAddress, sessionPublicKey: facts.publicKey,
      sessionExpiry: facts.expiry, sessionGeneration: 1, budgetGeneration: budget?.generation ?? 0, isTradfiV2: true, cmcNewsEnabled: row.hireFacts.hireSizing.cmcNewsEnabled === true, heldTickers: [], shortlistedTickers: [] };
  }
  return { runtime, target,
    async enqueue(agentId: string, heldTickers: readonly string[], shortlistedTickers: readonly string[], llmRequests?: CmcRuntimeTarget["llmRequests"]): Promise<void> {
      const current = await target(agentId); if (current !== null) runtime.worker!.enqueue({ ...current, heldTickers, shortlistedTickers, ...(llmRequests === undefined ? {} : { llmRequests }) });
    },
    async refresh(agentId: string, options?: { retryFailed?: boolean }): Promise<void> {
      const row = await input.store.byAgent(agentId), agent = await input.agents.getAgentById(agentId);
      // A hire without CMC (Schedule) has no budget row, so it never takes the wallet fence for a refresh.
      if (row?.state !== "bound" || row.settingsHold !== null || row.walletAddress === null || agent?.status !== "armed" || await input.store.now() >= row.hireEndMs!
        || row.hireFacts?.hireSizing.cmcNewsEnabled !== true) return;
      // A portfolio pays only to keep the Binance session alive: nothing is due while a quoted swap or a settled payment is younger than the idle window.
      if (row.hireParams !== null && agenticUsesPaidIdleKeepAlive(row.hireParams.settings)) {
        if (row.acceptedAt === null) return;
        const settled = (await input.cmc.listAttempts(agentId, row.walletAddress)).filter(a => a.state === "settled").map(a => a.createdAt);
        const last = agenticLastActivityMs({ acceptedAt: row.acceptedAt, agentId, orders: await input.store.orders(row.walletAddress), settledAttemptsCreatedAt: settled }, ["swap-quote", "x402-settled"]);
        if (await input.store.now() - last < AGENTIC_PAID_KEEPALIVE_IDLE_MS) return;
      }
      const fence = await acquireAgenticFence(input.store, row.walletAddress, input.instance.row.instanceId);
      if (fence === null) return;
      fences.set(agentId, fence); admitted.delete(agentId);
      try {
        const current = await target(agentId); if (current === null) return;
        if (input.gateRunId !== undefined) {
          const run = await input.store.getRun(input.gateRunId);
          if (run === null || run.agentId !== agentId || run.wallet !== row.walletAddress) return;
          // Gate-only test aid: forget the unpaid failed attempts so the daily calls are due again; refused while anything is pending.
          if (options?.retryFailed === true && (input.cmc.rewindFailedNewsForAgenticGate === undefined
            || await input.cmc.rewindFailedNewsForAgenticGate({ agentId, ownerAddress: current.ownerAddress, nowMs: await input.store.now() }) === null)) {
            console.error("agentic_cmc_retry_refused"); return;
          }
          if (!await input.store.consumeRun(run.runId, "cmc")) return;
          admitted.set(agentId, "");
        }
        const queued = runtime.worker!.takeQueued(agentId);
        const result = await runtime.worker!.refresh({ ...current, heldTickers: queued?.heldTickers ?? [], shortlistedTickers: queued?.shortlistedTickers ?? [] });
        console.log("agentic_cmc_refresh", JSON.stringify({ state: result.state, reason: result.reason === null ? null : sanitizeMessage(result.reason), ticker: result.ticker, skill: result.skill ?? null }));
      } finally { fences.delete(agentId); admitted.delete(agentId); await input.store.releaseFence(fence); }
    },
    async reconcile(agentId: string): Promise<void> {
      const current = await target(agentId);
      if (current === null || input.cmc.listPendingAttempts === undefined) return;
      await runtime.worker!.reconcilePending({ target: current, operationIds: (await input.cmc.listPendingAttempts(agentId, current.ownerAddress)).map(a => a.operationId) });
    },
    async protectedExposure(agentId: string): Promise<bigint> {
      const row = await input.store.byAgent(agentId); return row?.walletAddress === null || row?.walletAddress === undefined ? 0n : cmcProtectedExposureWei(await input.cmc.get(agentId, row.walletAddress));
    },
  };
}
export type AgenticCmc = ReturnType<typeof createAgenticCmc>;
