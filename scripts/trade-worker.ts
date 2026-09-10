/**
 * Autonomous trading daemon (TRADING-AGENT R3.8/R3.9).
 * Unlike lp-worker, --dry-run still reads the data plane and calls OpenRouter.
 * It writes one trade_runs row, but never executes or mutates a position.
 */
import { BNB } from "@altananetwork/sdk";
import { getAddress, type Address } from "viem";
import { executeTradeForAgent, tradeExecutionIdentity, tradeReceiptFill, type ExecuteTradeDeps } from "../src/trade/execute.js";
import { HttpTradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import { createTradeLlm } from "../src/trade/llm.js";
import {
  createHttpTradeReadinessDataPlane,
  createTradeReadiness,
} from "../src/trade/readiness.js";
import {
  createTradeGasBackoff,
  createWorkerVerdictCache,
  runTradeWorkerOnce,
  type TradeExecutor,
  type TradeWorkerDeps,
} from "../src/trade/worker.js";
import { AltanaProvider } from "../src/wallet/altana.js";
import { createAgentStore } from "../src/store/agents.js";
import { createTradeSettingsStore } from "../src/store/tradeSettings.js";
import { createTradePositionStore } from "../src/store/tradePositions.js";
import { createTradeIntentStore } from "../src/store/tradeIntents.js";
import { assertReconcileGuardCoversSubmitWindow, createJournal, reconcile } from "../src/store/journal.js";
import { createKillSwitch } from "../src/killswitch/killswitch.js";
import { resolveHireEnabled, resolveTradeConfig } from "../src/ops/config.js";
import { forbiddenTokenAddresses } from "../src/ops/forbiddenTokens.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { createRouteQuoteReader } from "../src/trade/route.js";
import { feeValueOf } from "../src/ops/fees.js";

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
  const dataPlaneUrl = required(process.env, "DATA_PLANE_URL");
  const dataPlaneToken = process.env["DATA_PLANE_TOKEN"]?.trim() ?? "";
  const keyStore = getAddress(BNB.keyStore);
  const trade = resolveTradeConfig(process.env, { chainId: 56, keyStore });
  const readerNetwork = { chain: BNB.chain, chainId: BNB.chainId, publicRpcUrl: BNB.publicRpcUrl };
  // C30: the composition root shares exactly the LP daemon's RPC resolver.
  const rpcUrls = resolveLpRpcUrls(process.env, readerNetwork);
  // AUDIT L5: one client owns every quote/receipt read and proves chain 56 before the daemon can sweep.
  const routeReader = createRouteQuoteReader({ rpcUrls });
  if (await routeReader.getChainId() !== 56) throw new Error("trade-worker RPC must report chain 56.");
  const dataPlaneOptions = {
    baseUrl: dataPlaneUrl,
    ...(dataPlaneToken === "" ? {} : { token: dataPlaneToken }),
  };
  const dataPlane = new HttpTradeDataPlaneReads(dataPlaneOptions);
  const readiness = await createTradeReadiness({
    dataPlane: createHttpTradeReadinessDataPlane(dataPlaneOptions),
    intervalMs: 60_000,
  });
  const agentStore = await createAgentStore();
  const settingsStore = await createTradeSettingsStore(agentStore);
  const positions = await createTradePositionStore();
  const intents = await createTradeIntentStore();
  const journal = await createJournal();
  const killswitch = await createKillSwitch();
  const provider = new AltanaProvider({ network: BNB, rpcUrls });
  assertReconcileGuardCoversSubmitWindow(provider);
  // One client per model id, memoised: the settings choose the model, and
  // TRADE_LLM_MODEL only overrides which id the whole daemon may use at all.
  const llmCache = new Map<string, ReturnType<typeof createTradeLlm>>();
  const llmFor = (modelId: string) => {
    const id = llmModel === "" ? modelId : llmModel;
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
  const executorDeps: ExecuteTradeDeps = {
    chainId: 56, keyStore, agentStore, journal, killswitch,
    providerRegistry: { get(chainId) {
      if (chainId !== 56) throw new Error("Unsupported trade-worker chain.");
      return provider;
    } },
    trade,
    pancake: trade.venues.pancakeRouterV2 === undefined || trade.venues.wbnb === undefined
      ? null : { router: trade.venues.pancakeRouterV2, wbnb: trade.venues.wbnb },
    pancakeV3: trade.venues.pancakeRouterV3 === undefined || trade.venues.wbnb === undefined
      ? null : { router: trade.venues.pancakeRouterV3, wbnb: trade.venues.wbnb },
    flapPortal: trade.venues.flapPortal ?? null,
    receiptReader: routeReader,
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
  const deps: TradeWorkerDeps = {
    platformFeeBps: trade.feeBps ?? 0,
    agentStore, settingsStore, positions, intents, journal, dataPlane, provider, llmFor, executor,
    executorDeps, readiness, rpcUrls, routeReader,
    verdictCache: createWorkerVerdictCache(),
    // AGENT-GAS-ATTENTION §2.2 — through the PROVIDER's chain-id-verified
    // client, the same seam `src/account/portfolio.ts` reads native balances
    // on. The daemon owns the backoff ladder, exactly as it owns the verdict
    // cache, so it lives for the daemon's lifetime and not one cycle's.
    walletNativeBalance: (wallet) => provider.getBalance({ address: wallet }),
    gasBackoff: createTradeGasBackoff(),
    intervalMs: args.intervalMs,
    forbiddenAddresses: (agent) => forbiddenTokenAddresses({
      wallet: agent.walletAddress, keyStore, venues: trade.venues,
      ...(trade.feeTreasury === undefined ? {} : { treasury: trade.feeTreasury }),
    }),
    executionIdentity: (agent, request) => tradeExecutionIdentity({
      agentId: agent.id, chainId: 56, request, trade,
      pancake: executorDeps.pancake, pancakeV3: executorDeps.pancakeV3, flapPortal: executorDeps.flapPortal,
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
      return tradeReceiptFill({ request: {
        decisionId: intent.decisionId,
        venue: intent.route.fees.length === 0 ? "pancake" : "pancake_v3",
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
  for (const store of [intents, positions, settingsStore, journal, killswitch, agentStore]) {
    try { await store.close(); } catch { /* independent close */ }
  }
}

main().catch((error: unknown) => {
  console.error(`trade-worker failed: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`);
  process.exitCode = 1;
});
