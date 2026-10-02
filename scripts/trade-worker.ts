/**
 * Autonomous trading daemon (TRADING-AGENT R3.8/R3.9).
 * Unlike lp-worker, --dry-run still reads the data plane and calls OpenRouter.
 * It writes one trade_runs row, but never executes or mutates a position.
 */
import { BNB } from "@altananetwork/sdk";
import { getAddress, type Address, type Hex } from "viem";
import { executeTradeForAgent, tradeExecutionIdentity, tradeReceiptFill, type ExecuteTradeDeps } from "../src/trade/execute.js";
import { hashCalls } from "../src/http/wire.js";
import { HttpTradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import { createTradeSimulationStore } from "../src/store/tradeSimulations.js";
import { createTradfiEvidenceWriter, recordSimulationActual, type TradfiEvidenceWriter, type TradfiPreflightDeps } from "../src/trade/simulate.js";
import { createTradeLlm } from "../src/trade/llm.js";
import { isTradfiV2Settings, parseTradeSettings } from "../src/trade/settings.js";
import {
  createHttpTradeReadinessDataPlane,
  createTradeReadiness,
} from "../src/trade/readiness.js";
import {
  createTradeGasBackoff,
  createWorkerVerdictCache,
  readTradfiV2QuoteRemaining,
  runTradeWorkerOnce,
  type TradeExecutor,
  type TradeWorkerDcaDeps,
  type TradeWorkerDeps,
} from "../src/trade/worker.js";
import { executeDcaRangeBatch } from "../src/trade/dcaExecute.js";
import { createDcaChainReads } from "../src/trade/dcaResolve.js";
import { createTradeUnknownReads } from "../src/trade/unknownResolve.js";
import { createDcaRoundStore } from "../src/store/dcaRounds.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import { AltanaProvider, agentAuthorityFromPrivateKey } from "../src/wallet/altana.js";
import { createAgentStore } from "../src/store/agents.js";
import type { AgentRecord } from "../src/store/agents.js";
import { createTradeSettingsStore } from "../src/store/tradeSettings.js";
import { createTradePositionStore } from "../src/store/tradePositions.js";
import { createTradeIntentStore } from "../src/store/tradeIntents.js";
import { createTradeCmcStore } from "../src/store/tradeCmc.js";
import { assertReconcileGuardCoversSubmitWindow, createJournal, reconcile, type JournalEntry } from "../src/store/journal.js";
import { createKillSwitch } from "../src/killswitch/killswitch.js";
import { resolveDcaEnabled, resolvePortfolioEnabled, resolveHireEnabled, resolveTradeConfig, type TradeRuntimeConfig } from "../src/ops/config.js";
import { forbiddenTokenAddresses } from "../src/ops/forbiddenTokens.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { createRouteQuoteReader } from "../src/trade/route.js";
import { feeValueOf } from "../src/ops/fees.js";
import { uniswapV3Venue, UNISWAP_V3_ROUTER02_56 } from "../src/ops/venues.js";
import { createTradfiNativeCostOracle, createTradfiNativeCostWeiOracle } from "../src/trade/cost.js";
import { createKeyStoreReader, readFinalizedSessionRevocation } from "../src/account/keyStoreReader.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { createTradfiV2ReceiptReader, verifyTradfiV2Receipt, type TradfiV2ReceiptExpected, type TradfiReceiptObservation } from "../src/trade/receipt.js";
import { loadMasterKey } from "../src/store/crypto.js";
import { createCmcRuntime, createCmcSessionAdapter, type CmcRuntimeTarget } from "../src/trade/cmcRuntime.js";
import type { CmcNewsRefreshResult } from "../src/trade/cmcNews.js";
import { shouldLogCmcObservation } from "../src/trade/cmcUsEquity.js";
import { PANCAKE_V2_FACTORY_56 } from "../src/quant/config.js";
import { PANCAKE_V3_FACTORY_56 } from "../src/lp/readers.js";
import type { WalletCall } from "../src/core/types.js";
import type { TradeIntentRecord } from "../src/store/tradeIntents.js";

const UNISWAP_V3_FACTORY_56: Address = getAddress("0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7");

const BOOLEAN_FLAGS = new Set(["once", "dry-run"]);
const VALUE_FLAGS = new Set(["interval-sec"]);

function parseArgs(argv: readonly string[]): { readonly once: boolean; readonly dryRun: boolean; readonly intervalMs: number } {
  let once = false;
  let dryRun = false;
  let intervalSec = 120;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === undefined || !raw.startsWith("--")) throw new Error(`Unknown argument: ${raw ?? ""}.`);
    const equals = raw.indexOf("=");
    const name = raw.slice(2, equals < 0 ? undefined : equals);
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals >= 0) throw new Error(`Flag --${name} does not take a value.`);
      if (name === "once") once = true;
      if (name === "dry-run") dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag: --${name}.`);
    const value = equals >= 0 ? raw.slice(equals + 1) : argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error("--interval-sec requires a number.");
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error("--interval-sec requires a finite number.");
    intervalSec = parsed;
  }
  return { once, dryRun, intervalMs: Math.min(600, Math.max(60, intervalSec)) * 1_000 };
}

function enabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env["TRADE_AGENT_ENABLED"]?.trim() ?? "";
  if (raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error('TRADE_AGENT_ENABLED must be exactly "true" or "false".');
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (value === "") throw new Error(`${name} is required.`);
  return value;
}

function storedWalletCalls(value: readonly { readonly to: Address; readonly value: string; readonly data: Hex }[] | undefined): readonly WalletCall[] | null {
  if (value === undefined || value.length === 0) return null;
  try {
    return value.map((call) => {
      if (!/^\d{1,78}$/u.test(call.value)) throw new Error("invalid submitted call value");
      const amount = BigInt(call.value);
      if (amount < 0n || amount >= (1n << 256n)) throw new Error("submitted call value is outside uint256");
      if (!/^0x(?:[0-9a-fA-F]{2})*$/u.test(call.data)) throw new Error("invalid submitted call data");
      return { to: getAddress(call.to), value: amount, data: call.data };
    });
  } catch {
    return null;
  }
}

async function buildTradfiReceiptExpected(input: {
  readonly intent: TradeIntentRecord;
  readonly agent: AgentRecord;
  readonly journalEntry: JournalEntry;
  readonly txHash: Hex;
  readonly reader: ReturnType<typeof createTradfiV2ReceiptReader>;
  readonly trade: TradeRuntimeConfig;
}): Promise<{ readonly observation: TradfiReceiptObservation; readonly expected: TradfiV2ReceiptExpected } | null> {
  // This function is intentionally called only for the v2 recovery path. Its
  // inputs come from the durable journal/intent rows rather than the current
  // session, so a renewal cannot make an old receipt appear to belong to a new
  // key.
  const { intent, journalEntry, txHash, reader, trade } = input;
  if (intent.settlementAsset !== "USDT") return null;
  const calls = storedWalletCalls(journalEntry.externalRef.submittedCalls);
  const callsHash = journalEntry.externalRef.callsHash;
  const sessionPublicKey = journalEntry.externalRef.publicKey;
  const sessionGeneration = journalEntry.externalRef.sessionGeneration;
  const minOutAtomic = intent.minOutAtomic;
  if (calls === null || callsHash === undefined || sessionPublicKey === undefined
    || sessionGeneration === undefined || minOutAtomic === undefined || minOutAtomic === null) return null;
  if (hashCalls(calls).toLowerCase() !== callsHash.toLowerCase()) return null;
  const observation = await reader.readFinalized(txHash);
  if (observation === null) return null;
  const base = {
    wallet: getAddress(input.agent.walletAddress), sessionPublicKey, sessionGeneration,
    callsHash, calls, side: intent.side, token: getAddress(intent.token), amountInAtomic: intent.amountWei,
    minOutAtomic, ...(intent.platformFeeAtomic === undefined || intent.platformFeeAtomic === null ? {} : { platformFeeAtomic: intent.platformFeeAtomic }),
    ...(trade.feeTreasury === undefined ? {} : { feeTreasury: trade.feeTreasury }),
  } satisfies Omit<TradfiV2ReceiptExpected, "guard" | "directRoute">;
  if (journalEntry.externalRef.guardQuote !== undefined) {
    return { observation, expected: { ...base, guard: journalEntry.externalRef.guardQuote } };
  }
  const venue = intent.venue;
  if (venue !== "pancake_v2" && venue !== "pancake_v3" && venue !== "uniswap_v3") return null;
  const router = venue === "pancake_v2" ? trade.venues.pancakeRouterV2
    : venue === "pancake_v3" ? trade.venues.pancakeRouterV3 : trade.venues.uniswapRouterV3;
  if (router === undefined) return null;
  if (venue === "uniswap_v3" && router.toLowerCase() !== UNISWAP_V3_ROUTER02_56.toLowerCase()) return null;
  const path = intent.side === "buy"
    ? [USDT_56, ...intent.route.hops, intent.token]
    : [intent.token, ...intent.route.hops, USDT_56];
  // MEASURED 2026-09-20: reading the factories AT THE RECEIPT BLOCK fails with
  // "missing trie node" on the public BSC nodes once that state is pruned
  // (~minutes), which left every v2 fill `unverified` for good. A factory's
  // pool address is immutable once created (CREATE2), so the finalized tip is
  // an equivalent — and always readable — block for this lookup. The
  // `directRoute.blockNumber` label below still binds the receipt block.
  const poolReadBlock = observation.finalizedBlock.number;
  const pools = venue === "pancake_v2"
    ? await reader.readV2Pools(PANCAKE_V2_FACTORY_56, path, poolReadBlock)
    : await reader.readV3Pools(venue === "pancake_v3" ? PANCAKE_V3_FACTORY_56 : UNISWAP_V3_FACTORY_56,
      path, intent.route.fees, poolReadBlock);
  if (pools === null) return null;
  return { observation, expected: { ...base, directRoute: {
    kind: venue === "pancake_v2" ? "v2" : "v3", router, pools,
    blockNumber: observation.receipt.blockNumber, blockHash: observation.receipt.blockHash,
  } } };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!enabled(process.env)) {
    console.log("[trade-worker] TRADE_AGENT_ENABLED is off; exiting");
    return;
  }
  if ((process.env["EXECUTION_NETWORK"] ?? "").trim() !== "mainnet" || BNB.chainId !== 56) {
    throw new Error("trade-worker requires BNB mainnet chain 56.");
  }
  required(process.env, "DATABASE_URL");
  required(process.env, "EXECUTION_MASTER_KEY");
  if (!resolveHireEnabled(process.env)) throw new Error("HIRE_ENABLED must be true for trade-worker.");
  // The model transport is OpenAI-shaped, so one provider is a base URL plus a
  // key. 0G Compute's router (`https://router-api.0g.ai/v1`) speaks the same
  // wire as OpenRouter and is the LLM layer this product settles on; the two
  // OpenRouter variables stay as the fallback so nothing that works today breaks.
  const llmKey = (process.env["TRADE_LLM_API_KEY"]?.trim() ?? "") !== ""
    ? required(process.env, "TRADE_LLM_API_KEY")
    : required(process.env, "OPENROUTER_API_KEY");
  const llmBaseUrl = process.env["TRADE_LLM_BASE_URL"]?.trim() ?? "";
  const llmModel = process.env["TRADE_LLM_MODEL"]?.trim() ?? "";
  const llmFallbackModel = process.env["TRADE_LLM_FALLBACK_MODEL"]?.trim() ?? "";
  const dataPlaneUrl = required(process.env, "DATA_PLANE_URL");
  const dataPlaneToken = process.env["DATA_PLANE_TOKEN"]?.trim() ?? "";
  const keyStore = getAddress(BNB.keyStore);
  const trade = resolveTradeConfig(process.env, { chainId: 56, keyStore });
  const readerNetwork = { chain: BNB.chain, chainId: BNB.chainId, publicRpcUrl: BNB.publicRpcUrl };
  // C30: the composition root shares exactly the LP daemon's RPC resolver.
  const rpcUrls = resolveLpRpcUrls(process.env, readerNetwork);
  // AUDIT L5: one client owns every quote/receipt read and proves chain 56 before the daemon can sweep.
  const routeReader = createRouteQuoteReader({ rpcUrls,
    ...(trade.venues.uniswapQuoterV3 === undefined ? {} : { uniswapQuoter: trade.venues.uniswapQuoterV3 }) });
  if (await routeReader.getChainId() !== 56) throw new Error("trade-worker RPC must report chain 56.");
  // MEASURED 2026-09-20: the receipt reader needs EVERY url it is given to
  // return the same receipt, and the third default url (the SDK's public
  // endpoint) now answers `eth_getTransactionReceipt` for a confirmed tx with
  // "Archive requests require a personal token" — so with all three urls no v2
  // fill ever verified. The contract is two independently configured BSC RPCs
  // (R2.5); hand it exactly the same pair the CMC readers use (line ~244).
  const tradfiReceiptReader = createTradfiV2ReceiptReader({ rpcUrls: rpcUrls.slice(0, 2) });
  const dataPlaneOptions = {
    baseUrl: dataPlaneUrl,
    ...(dataPlaneToken === "" ? {} : { token: dataPlaneToken }),
  };
  const dataPlane = new HttpTradeDataPlaneReads(dataPlaneOptions);
  let simulations: TradfiEvidenceWriter | undefined;
  let preflight: TradfiPreflightDeps | undefined;
  if (trade.preflightSimulate === true) {
    try {
      const store = await createTradeSimulationStore();
      simulations = createTradfiEvidenceWriter(store, line => console.warn(line));
      preflight = { simulate: input => dataPlane.binanceSimulate(input), evidence: simulations, log: line => console.warn(line) };
    } catch {
      console.warn("[trade-worker] preflight simulate: OFF (evidence store unavailable)");
    }
    if (dataPlaneToken === "") console.warn("[trade-worker] TRADFI_PREFLIGHT_SIMULATE is on but DATA_PLANE_TOKEN is empty; every simulation will record not-simulated(auth).");
  }
  console.log(`[trade-worker] preflight simulate: ${preflight === undefined ? "off" : "on"}`);
  const readiness = await createTradeReadiness({
    dataPlane: createHttpTradeReadinessDataPlane(dataPlaneOptions),
    intervalMs: 60_000,
  });
  const agentStore = await createAgentStore();
  const settingsStore = await createTradeSettingsStore(agentStore);
  const positions = await createTradePositionStore();
  const intents = await createTradeIntentStore();
  const cmcStore = await createTradeCmcStore();
  const journal = await createJournal();
  const killswitch = await createKillSwitch();
  const provider = new AltanaProvider({ network: BNB, rpcUrls });
  assertReconcileGuardCoversSubmitWindow(provider);
  const cmcMasterKey = loadMasterKey();
  const listCmcTargets = async (includeDisabled: boolean): Promise<readonly CmcRuntimeTarget[]> => {
    const targets: CmcRuntimeTarget[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await settingsStore.listTradeAgentsForProjection({ limit: 32, cursor });
      for (const row of page.rows) {
        const agent = await agentStore.getAgentById(row.agentId);
        const parsed = parseTradeSettings(row.params);
        if (agent === null || agent.sessionFacts === null || !parsed.ok || !isTradfiV2Settings(parsed.value.effective)) continue;
        const pending = cmcStore.listPendingAttempts === undefined ? [] : await cmcStore.listPendingAttempts(agent.id, agent.ownerAddress);
        const enabledForNews = parsed.value.effective.cmcNewsEnabled === true;
        if (!includeDisabled && agent.status !== "armed") continue;
        if (includeDisabled && agent.status !== "armed" && pending.length === 0) continue;
        if (!includeDisabled && !enabledForNews) continue;
        if (includeDisabled && !enabledForNews && pending.length === 0) continue;
        const budget = await cmcStore.get(agent.id, agent.ownerAddress);
        targets.push({ agentId: agent.id, ownerAddress: agent.ownerAddress, wallet: agent.walletAddress,
          sessionPublicKey: agent.sessionFacts.publicKey, sessionExpiry: agent.sessionFacts.expiry,
          sessionGeneration: agent.sessionFacts.generation ?? 0, budgetGeneration: budget?.generation ?? 0,
          isTradfiV2: true, cmcNewsEnabled: enabledForNews, heldTickers: [], shortlistedTickers: [] });
      }
      if (!page.hasMore || page.cursor === null) break;
      cursor = page.cursor;
    }
    return targets;
  };
  const cmcRuntime = cmcMasterKey === null ? undefined : createCmcRuntime({
    store: cmcStore,
    worker: {
      masterKey: cmcMasterKey,
      ...(rpcUrls.length < 2 ? {} : { rpcUrls: [rpcUrls[0]!, rpcUrls[1]!] as const }),
      // MEASURED 2026-09-20 (G2): the paid CMC response carried no
      // PAYMENT-RESPONSE hint, and the dataseed pair refuses `eth_getLogs`, so
      // settlement discovery reads logs from the third (SDK public) endpoint;
      // the exact two-RPC proof above still decides settlement.
      ...(rpcUrls[2] === undefined ? {} : { discoveryRpcUrl: rpcUrls[2] }),
      sessionForAgent: createCmcSessionAdapter({
        read: async (agentId) => {
          const agent = await agentStore.getAgentById(agentId);
          if (agent === null || agent.sessionFacts === null) return null;
          const executing = await agentStore.readExecutingSession(agent.ownerAddress, agent.id);
          if (executing === null) return null;
          return { walletAddress: agent.walletAddress, agent: agentAuthorityFromPrivateKey(executing.key),
            sessionFacts: { spec: executing.facts.spec, publicKey: executing.facts.publicKey, expiry: executing.facts.expiry } };
        },
        restoreSession: (params) => provider.restoreSession(params),
      }),
      // Live grant shape for the capability reader: the persisted descriptor
      // only, never the session ciphertext, and only for the requested wallet.
      sessionSpec: async (request) => {
        const agent = await agentStore.getAgentById(request.agentId);
        if (agent === null || agent.walletAddress.toLowerCase() !== request.wallet.toLowerCase()) return null;
        return agent.sessionFacts?.spec ?? null;
      },
      authorize: async (request) => {
        const agent = await agentStore.getAgentById(request.agentId);
        const budget = await cmcStore.get(request.agentId, request.ownerAddress);
        const settings = agent === null ? null : await settingsStore.get(agent.ownerAddress, agent.id);
        const parsedSettings = settings === null ? null : parseTradeSettings(settings.params);
        const walletUsdt = agent === null ? 0n : await provider.getTokenBalance({ wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 }, token: USDT_56 });
        const blocked = agent === null ? true : await killswitch.isBlocked(agent.id, agent.ownerAddress);
        const pendingBuyHolds = agent === null ? 0n : await journal.sumPendingQuoteSpendSince(agent.id, 0);
        const spendableWalletUsdt = walletUsdt > pendingBuyHolds ? walletUsdt - pendingBuyHolds : 0n;
        if (agent === null || agent.ownerAddress.toLowerCase() !== request.ownerAddress.toLowerCase()
          || agent.walletAddress.toLowerCase() !== request.wallet.toLowerCase() || agent.sessionFacts === null
          || agent.status !== "armed" || blocked || agent.pendingRenewal !== null && agent.pendingRenewal !== undefined
          || parsedSettings?.ok !== true || !isTradfiV2Settings(parsedSettings.value.effective) || parsedSettings.value.effective.cmcNewsEnabled !== true
          || agent.sessionFacts.publicKey.toLowerCase() !== request.sessionPublicKey.toLowerCase()
          || (agent.sessionFacts.generation ?? 0) !== request.generation
          || agent.sessionFacts.expiry !== request.sessionExpiry
          || budget === null || spendableWalletUsdt < request.amountWei
          || budget === null || !budget.optedIn
          ) return { ok: false as const, reason: "cmc_session_or_budget_mismatch" };
        return { ok: true as const };
      },
      listTargets: () => listCmcTargets(false),
      listReconciliationTargets: () => listCmcTargets(true),
      listPendingAttempts: async (input) => cmcStore.listPendingAttempts === undefined
        ? [] : (await cmcStore.listPendingAttempts(input.agentId, input.ownerAddress)).map((attempt) => attempt.operationId),
    },
  });
  const cmcWorker = cmcRuntime?.worker ?? undefined;
  // One client per model id, memoised: the settings choose the model, and
  // TRADE_LLM_MODEL (+ TRADE_LLM_FALLBACK_MODEL) overrides which ids the whole
  // daemon may use at all — resolved per role inside the worker, not here.
  const llmCache = new Map<string, ReturnType<typeof createTradeLlm>>();
  const llmFor = (modelId: string) => {
    const id = modelId;
    const cached = llmCache.get(id);
    if (cached !== undefined) return cached;
    const client = createTradeLlm({
      readKey: () => llmKey,
      model: id,
      ...(llmBaseUrl === "" ? {} : { baseUrl: llmBaseUrl }),
    });
    llmCache.set(id, client);
    return client;
  };

  // The former "trade executor not wired (item 4)" placeholder is replaced by the shared core.
  const uniswapV3 = uniswapV3Venue(trade.venues);
  const executorDeps: ExecuteTradeDeps = {
    ...(preflight === undefined ? {} : { preflight }),
    chainId: 56, keyStore, agentStore, settingsStore, journal, killswitch,
    providerRegistry: { get(chainId) {
      if (chainId !== 56) throw new Error("Unsupported trade-worker chain.");
      return provider;
    } },
    trade,
    pancake: trade.venues.pancakeRouterV2 === undefined || trade.venues.wbnb === undefined
      ? null : { router: trade.venues.pancakeRouterV2, wbnb: trade.venues.wbnb },
    pancakeV3: trade.venues.pancakeRouterV3 === undefined || trade.venues.wbnb === undefined
      ? null : { router: trade.venues.pancakeRouterV3, wbnb: trade.venues.wbnb },
    uniswapV3,
    flapPortal: trade.venues.flapPortal ?? null,
    receiptReader: routeReader,
    v2ReceiptReader: tradfiReceiptReader,
    v2EvidenceForReceipt: async (input) => {
      if (input.receipt.transactionHash === undefined) return null;
      const observation = await tradfiReceiptReader.readFinalized(input.receipt.transactionHash);
      if (observation === null) return null;
      const verification = verifyTradfiV2Receipt({ observation, expected: {
        wallet: input.walletAddress, sessionPublicKey: input.sessionPublicKey, sessionGeneration: input.sessionGeneration,
        callsHash: input.callsHash, calls: input.calls, side: input.request.side, token: input.request.token,
        amountInAtomic: input.request.amountWei, minOutAtomic: input.request.minOutWei,
        ...(input.request.platformFeeAtomic === undefined ? {} : { platformFeeAtomic: input.request.platformFeeAtomic }),
        ...(trade.feeTreasury === undefined ? {} : { feeTreasury: trade.feeTreasury }),
        ...(input.request.guardQuote === undefined ? {} : { guard: { address: input.request.guardQuote.guard, calldata: input.request.guardQuote.calldata } }),
      } });
      if (!verification.ok) return null;
      const evidence = verification.evidence;
      await journal.markCommitted(input.idempotencyKey, { receiptEvidence: {
        transactionHash: evidence.ownership.transactionHash, wallet: evidence.ownership.wallet,
        chainIntentHash: evidence.chainIntentHash, nonce: evidence.nonce.toString(10), callsHash: evidence.callsHash,
        blockHash: evidence.blockHash, blockNumber: evidence.blockNumber.toString(10),
        swapLogIndex: evidence.ownership.swapLogIndex.toString(10),
      } });
      recordSimulationActual(simulations, { idempotencyKey: input.idempotencyKey, txHash: evidence.ownership.transactionHash,
        token: input.request.side === "buy" ? input.request.token : USDT_56, wallet: input.walletAddress,
        logs: observation.receipt.logs, atMs: Date.now(), log: line => console.warn(line) });
      return { evidence: {
        chainId: 56, receiptStatus: "success", blockHash: evidence.blockHash, blockNumber: evidence.blockNumber,
        wallet: evidence.wallet, sessionPublicKey: evidence.sessionPublicKey, sessionGeneration: evidence.sessionGeneration,
        intentId: evidence.intentId, chainIntentHash: evidence.chainIntentHash, nonce: evidence.nonce,
        callsHash: evidence.callsHash, receiptOwned: true, singleWalletExecution: true,
        unexplainedRelevantTransfers: false, matchingIntent: true, matchingCalls: true,
        ...(evidence.guardEventMatches === undefined ? {} : { guardEventMatches: evidence.guardEventMatches }), treasuryFeeMatches: true,
        ownership: evidence.ownership,
        actualInputAtomic: evidence.actualInputAtomic, actualOutputAtomic: evidence.actualOutputAtomic,
        verifiedEntryAtomic: evidence.verifiedEntryAtomic, verifiedProceedsAtomic: evidence.verifiedProceedsAtomic,
      }, expected: { sessionPublicKey: input.sessionPublicKey, sessionGeneration: input.sessionGeneration, intentId: evidence.intentId, callsHash: input.callsHash } };
    },
  };
  // AUDIT H2: confirmed fills come from the transaction receipt inside the shared core, never balance brackets.
  const executor: TradeExecutor = {
    async execute(input) {
      const result = await executeTradeForAgent({ ...input, deps: executorDeps });
      if (result.kind !== "committed") return result;
      if (result.receipt.status !== "CONFIRMED") {
        return { kind: "rolled-back", code: result.receipt.failureCode ?? "not-confirmed", meta: result.meta };
      }
      return result;
    },
  };
  const tradfiCostOracle = createTradfiNativeCostOracle({ dataPlane, network: BNB });
  // AUTO-DCA (§12, R2.8). Composed whatever the flag says: with DCA_ENABLED off
  // the worker still runs the exit subset — convergence, stop loss, Remove — for
  // an agent hired while it was on (D17), so no owner's funds are trapped.
  const dcaEnabled = resolveDcaEnabled(process.env);
  const portfolioEnabled = resolvePortfolioEnabled(process.env);
  const dcaStore = await createDcaRoundStore();
  const dcaCostWei = createTradfiNativeCostWeiOracle({ network: BNB });
  const dca: TradeWorkerDcaDeps = {
    ...(simulations === undefined ? {} : { simulations }),
    store: dcaStore, enabled: dcaEnabled, nfpm: NFPM_56,
    // `eth_call`s on the trade RPC pair; logs (corroboration only) on the third
    // endpoint, the one that serves them — the CMC discovery precedent above.
    chain: createDcaChainReads({ rpcUrls: rpcUrls.slice(0, 2), nfpm: NFPM_56, ...(rpcUrls[2] === undefined ? {} : { logsRpcUrl: rpcUrls[2] }) }),
    batchCostWei: dcaCostWei ?? (async () => null),
    executeRange: (input) => executeDcaRangeBatch({
      ...(preflight === undefined ? {} : { preflight }),
      store: dcaStore, settingsStore, agentStore, journal, killswitch, providerRegistry: executorDeps.providerRegistry,
      chainId: 56, trade, nfpm: NFPM_56,
      quoteRemaining: (agent) => agent.sessionFacts === null ? Promise.resolve(null) : readTradfiV2QuoteRemaining({ provider }, agent, agent.sessionFacts),
      walletUsdt: (agent) => provider.getTokenBalance({ wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 }, token: USDT_56 }),
    }, input),
    receipts: tradfiReceiptReader, journal,
  };
  const inertKeyStoreReader = createKeyStoreReader({ network: readerNetwork, rpcUrls, keyStore });
  const deps: TradeWorkerDeps = {
    dca, killswitch,
    platformFeeBps: trade.feeBps ?? 0,
    ...(trade.feeTreasury === undefined ? {} : { platformFeeTreasury: trade.feeTreasury }),
    ...(tradfiCostOracle === undefined ? {} : { tradfiNativeCostUsdtAtomic: tradfiCostOracle }),
    v2DataBudgetReservedWei: async (agent) => {
      if (cmcRuntime === undefined) return 0n;
      return cmcRuntime.owner.protectedExposure({ agentId: agent.id, ownerAddress: agent.ownerAddress });
    },
    ...(cmcWorker === undefined ? {} : { cmcNews: cmcWorker.news, refreshCmcNews: async (input: Parameters<NonNullable<TradeWorkerDeps["refreshCmcNews"]>>[0]) => {
      const facts = input.agent.sessionFacts;
      if (facts === null) return;
      const budget = await cmcStore.get(input.agent.id, input.agent.ownerAddress);
      const target: CmcRuntimeTarget = { agentId: input.agent.id, ownerAddress: input.agent.ownerAddress, wallet: input.agent.walletAddress,
        sessionPublicKey: facts.publicKey, sessionExpiry: facts.expiry, sessionGeneration: facts.generation ?? 0, budgetGeneration: budget?.generation ?? 0,
        isTradfiV2: true, cmcNewsEnabled: true,
        heldTickers: input.heldTickers, shortlistedTickers: input.shortlistedTickers,
        ...(input.llmRequests === undefined || input.llmRequests.length === 0 ? {} : { llmRequests: input.llmRequests }) };
      cmcWorker.enqueue(target);
    } }),
    agentStore, settingsStore, positions, intents, journal, dataPlane, provider, llmFor, executor,
    portfolioEnabled,
    ...(llmModel === "" ? {} : { modelOverride: { primary: llmModel, ...(llmFallbackModel === "" ? {} : { fallback: llmFallbackModel }) } }),
    executorDeps, readiness, rpcUrls, routeReader,
    ...(rpcUrls[2] === undefined ? {} : { unknownReads: createTradeUnknownReads({
      rpcUrls: [rpcUrls[0]!, rpcUrls[1]!], logsRpcUrl: rpcUrls[2] }) }),
    ...(uniswapV3 === null || trade.venues.uniswapQuoterV3 === undefined ? {} : { uniswapRouter: uniswapV3.router }),
    ...(trade.aggregatorGuard === undefined ? {} : { aggregatorGuard: trade.aggregatorGuard }),
    knownRwaAddresses: new Set<string>(readiness.bstocksAddresses),
    verdictCache: createWorkerVerdictCache(),
    // AGENT-GAS-ATTENTION §2.2 — through the PROVIDER's chain-id-verified
    // client, the same seam `src/account/portfolio.ts` reads native balances
    // on. The daemon owns the backoff ladder, exactly as it owns the verdict
    // cache, so it lives for the daemon's lifetime and not one cycle's.
    walletNativeBalance: (wallet) => provider.getBalance({ address: wallet }),
    // TRADFI-EXPIRY-KEEP-REMOVE §2: the finalized KeyStore read behind the
    // inert-ambiguous-sell disposal. Read-only: no signer, no submission.
    inertSubmission: {
      chainId: 56, keyStore,
      read: (input) => readFinalizedSessionRevocation({
        chainId: 56, keyStoreAddress: keyStore, wallet: input.wallet, keyId: input.keyId, expectedPublicKey: input.publicKey,
        observedAtMs: Date.now(), reader: inertKeyStoreReader, ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    },
    gasBackoff: createTradeGasBackoff(),
    intervalMs: args.intervalMs,
    forbiddenAddresses: (agent) => forbiddenTokenAddresses({
      wallet: agent.walletAddress, keyStore, venues: trade.venues,
      ...(trade.feeTreasury === undefined ? {} : { treasury: trade.feeTreasury }),
    }),
    executionIdentity: (agent, request) => tradeExecutionIdentity({
      agentId: agent.id, chainId: 56, request, trade,
      pancake: executorDeps.pancake, pancakeV3: executorDeps.pancakeV3, uniswapV3,
      flapPortal: executorDeps.flapPortal,
    }),
    entryBasisWei: (agent, request) => request.side === "buy"
      ? request.amountWei + feeValueOf(trade.feePolicy({ agentId: agent.id, venue: request.venue,
        side: request.side, token: request.token, nativeInWei: request.amountWei }))
      : 0n,
    reconcile: () => reconcile({
      provider,
      journal,
      resolveWallet: async (ownerAddress, agentId) => {
        const agent = await agentStore.getAgentById(agentId);
        if (agent === null || agent.ownerAddress !== (ownerAddress as Address).toLowerCase()) return null;
        return { address: agent.walletAddress, chainId: 56, ownerAddress: agent.ownerAddress,
          custodyModel: agent.custodyModel };
      },
    }),
    recoverFill: async (intent, txHash) => {
      const agent = await agentStore.getAgentById(intent.agentId);
      if (agent === null) throw new Error("Trade intent agent is unavailable.");
      if (intent.settlementAsset === "USDT") {
        const journalEntry = await journal.get(intent.idempotencyKey);
        if (journalEntry !== null) {
          try {
            const bound = await buildTradfiReceiptExpected({ intent, agent, journalEntry, txHash,
              reader: tradfiReceiptReader, trade });
            if (bound !== null) {
              const verification = verifyTradfiV2Receipt({ observation: bound.observation, expected: bound.expected });
              if (verification.ok) {
                const ownershipKey = [verification.evidence.chainId, verification.evidence.ownership.transactionHash.toLowerCase(),
                  verification.evidence.wallet.toLowerCase(), verification.evidence.ownership.swapLogIndex.toString(10),
                  verification.evidence.chainIntentHash.toLowerCase()].join("|");
                await journal.markCommitted(intent.idempotencyKey, { receiptEvidence: {
                  transactionHash: verification.evidence.ownership.transactionHash, wallet: verification.evidence.ownership.wallet,
                  chainIntentHash: verification.evidence.chainIntentHash, nonce: verification.evidence.nonce.toString(10),
                  callsHash: verification.evidence.callsHash, blockHash: verification.evidence.blockHash,
                  blockNumber: verification.evidence.blockNumber.toString(10), swapLogIndex: verification.evidence.ownership.swapLogIndex.toString(10),
                } });
                recordSimulationActual(simulations, { idempotencyKey: intent.idempotencyKey, txHash: verification.evidence.ownership.transactionHash,
                  token: intent.side === "buy" ? intent.token : USDT_56, wallet: agent.walletAddress,
                  logs: bound.observation.receipt.logs, atMs: Date.now(), log: line => console.warn(line) });
                return intent.side === "buy"
                  ? { side: "buy" as const, entryWei: verification.evidence.verifiedEntryAtomic ?? intent.entryWei,
                    tokenAmount: verification.evidence.actualOutputAtomic, fillStatus: "verified" as const,
                    receiptAttributable: true, receiptOwnershipKey: ownershipKey,
                    ...(verification.evidence.verifiedEntryAtomic === null ? {} : { verifiedEntryAtomic: verification.evidence.verifiedEntryAtomic }) }
                  : { side: "sell" as const, exitWei: verification.evidence.verifiedProceedsAtomic,
                    fillStatus: "verified" as const, receiptOwnershipKey: ownershipKey };
              }
            }
          } catch {
            // Receipt unavailability or an identity mismatch leaves the intent
            // pending proof; the next worker cycle retries reads only.
          }
        }
        return intent.side === "buy"
          ? { side: "buy" as const, entryWei: intent.entryWei, tokenAmount: null, fillStatus: "unverified" as const, receiptAttributable: false }
          : { side: "sell" as const, exitWei: null, fillStatus: "unverified" as const };
      }
      return tradeReceiptFill({ request: {
        decisionId: intent.decisionId,
        // Legacy intents (venue null) derive as the worker does: no fees ⇒ V2.
        venue: intent.venue === "uniswap_v3" ? "uniswap_v3"
          : (intent.venue ?? (intent.route.fees.length === 0 ? "pancake_v2" : "pancake_v3")) === "pancake_v2" ? "pancake" : "pancake_v3",
        side: intent.side,
        token: intent.token,
        amountWei: intent.amountWei,
        quotedOutWei: 0n,
        minOutWei: 0n,
        route: intent.route,
      },
      walletAddress: agent.walletAddress,
      nativeInWei: intent.entryWei,
      receipt: { status: "CONFIRMED", transactionHash: txHash },
      reader: routeReader,
      ...(trade.venues.wbnb === undefined ? {} : { wbnb: trade.venues.wbnb }),
      });
    },
    log: console.log,
  };

  // TRADFI-CMC-EQUITY N6/N9: `scheduler.start()` alone discards each tick's
  // CmcNewsRefreshResult[], including the bounded `cmc:unmapped:<ticker>` /
  // `cmc:macro-unmatched:<event>` observations. Drive the tick ourselves so we
  // can fold every observation into the worker's own `[trade-worker]` log,
  // deduped per (UTC day, observation) with an in-memory Set — no new
  // persistent state, and the Set resets on the day boundary.
  let cmcObservationDate = "";
  const cmcObservationsSeen = new Set<string>();
  function logCmcObservations(results: readonly CmcNewsRefreshResult[]): void {
    const utcDate = new Date().toISOString().slice(0, 10);
    if (utcDate !== cmcObservationDate) { cmcObservationDate = utcDate; cmcObservationsSeen.clear(); }
    for (const result of results) {
      if (result.state === "invalid" || result.state === "service-error") {
        console.log(`[trade-worker] cmc-fail skill=${result.skill ?? "?"} ticker=${result.ticker ?? "-"} state=${result.state} reason=${sanitizeMessage(result.reason ?? "unknown")} op=${result.operationId ?? "-"}`);
        if (result.responseExcerpt !== undefined) console.log(`[trade-worker] cmc-fail response=${JSON.stringify(sanitizeMessage(result.responseExcerpt))}`);
      }
      for (const observation of result.observations ?? []) {
        if (!shouldLogCmcObservation(cmcObservationsSeen, utcDate, observation)) continue;
        console.log(`[trade-worker] cmc-observe ${sanitizeMessage(observation)}`);
      }
    }
  }
  const cmcTickHandle = cmcWorker === undefined ? null : setInterval(() => {
    void cmcWorker.scheduler.tick().then(logCmcObservations).catch(() => undefined);
  }, cmcWorker.scheduler.intervalMs);

  console.log(`[trade-worker] chain=56 interval=${args.intervalMs}ms dry-run=${args.dryRun} once=${args.once}`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => { stopping = true; });
  }
  for (;;) {
    const startedAt = Date.now();
    try {
      const report = await runTradeWorkerOnce(deps, { dryRun: args.dryRun });
      console.log(`[trade-worker] cycle done agents=${report.outcomes.length} ready=${!report.skippedNotReady}`);
    } catch (error) {
      console.error(`[trade-worker] cycle failed: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`);
    }
    if (args.once || stopping) break;
    const waitMs = Math.max(0, args.intervalMs - (Date.now() - startedAt));
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
  readiness.stop();
  if (cmcTickHandle !== null) clearInterval(cmcTickHandle);
  await simulations?.shutdown();
  for (const store of [intents, positions, settingsStore, journal, killswitch, agentStore, cmcStore]) {
    try { await store.close(); } catch { /* independent close */ }
  }
}

main().catch((error: unknown) => {
  console.error(`trade-worker failed: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`);
  process.exitCode = 1;
});
