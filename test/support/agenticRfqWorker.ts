/** AGENTIC-RFQ-STOCKS: one offline worker world over the 2026-10-04 universe, for the Altana control cycles and the Agentic RFQ cycles alike. */
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { MemoryAgentStore } from "../../src/store/agents.js";
import { MemoryTradeSettingsStore } from "../../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../../src/store/journal.js";
import { validateSessionSpec } from "../../src/core/session.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../../src/trade/settings.js";
import type { TradeWorkerDeps } from "../../src/trade/worker.js";
import { tradeSessionSpec } from "../../src/ops/policy.js";
import { USDT_56 } from "../../src/trade/settlement.js";
import { PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, WBNB_56 } from "../../src/ops/venues.js";
import { projectAgenticSessionFacts, type AgenticHireFacts, type AgenticWallet } from "../../src/agentic/domain.js";
import type { TradeDataPlaneReads, UniverseRow } from "../../src/trade/dataPlaneReads.js";
import type { RouteQuoteReader } from "../../src/trade/route.js";
import type { TradeRequest } from "../../src/http/wire.js";
import type { SessionFacts } from "../../src/store/agents.js";
import { createTradeVerdictCache } from "../../src/trade/universe.js";
import type { RfqQuoteInput, RfqQuoteResult, RfqStocksDeps } from "../../src/trade/rfq.js";
import { rfqDataPlane } from "./agenticRfq.js";

export const E = 10n ** 18n;
export const OWNER = getAddress("0x1111111111111111111111111111111111111111");
export const WALLET = getAddress("0x2222222222222222222222222222222222222222");
export const GUARD = getAddress("0x4444444444444444444444444444444444444444");
export const HASH = `0x${"66".repeat(32)}` as Hex;
const KEY = `0x04${"77".repeat(64)}` as Hex;
/** A Friday in RTH (America/New_York): 2026-10-02, 15:45 UTC = 11:45 ET. */
export const RTH_MS = Date.UTC(2026, 9, 2, 15, 45, 0);

export const aiSettings = (patch: Partial<TradeSettings> = {}): TradeSettings => ({ ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
  minEntryWei: (5n * E).toString(), entryWei: (5n * E).toString(), capitalQuoteWei: (10n * E).toString(), cmcNewsEnabled: false, maxOpenPositions: 2, slippageBps: 100,
  takeProfitBps: null, stopLossBps: null, maxHoldSec: null, crashProtection: false, ...patch });

export type World = Awaited<ReturnType<typeof worldHarness>>;

/** An RFQ quote source double: every call is recorded in order; `quote` decides each answer. */
export function fakeRfqStocks(input: { entries?: boolean; rfqOnlyAtHire?: readonly string[]; quote: (call: RfqQuoteInput, index: number) => RfqQuoteResult | Promise<RfqQuoteResult>; sleeps?: number[] }) {
  const calls: RfqQuoteInput[] = [];
  const log = { active: 0 };
  const dep: RfqStocksDeps = {
    async active() { log.active += 1; return { entries: input.entries ?? true, rfqOnlyAtHire: new Set((input.rfqOnlyAtHire ?? []).map((token) => token.toLowerCase())) }; },
    async quote(call) { calls.push(call); return input.quote(call, calls.length - 1); },
  };
  return { dep, calls, log };
}

/**
 * `custody: "passkey"` is the Altana control (a granted session over the pooled tokens); `"binance-agentic"` is an Agentic AI hire whose projected session pins every token in `pinned`.
 * Direct route quotes are linear (1 USDT in = 1 token out; a sale returns `sellFactor / 1000` of the amount), so a pooled stock prices without any Flash call.
 */
export async function worldHarness(input: {
  now: () => number; rows: readonly UniverseRow[]; custody: "passkey" | "binance-agentic"; pinned: readonly Address[]; settings?: Partial<TradeSettings>;
  balances?: Map<string, bigint>; dataPlane?: Partial<TradeDataPlaneReads>; extraDeps?: Partial<TradeWorkerDeps>; entryDecision?: unknown; exitDecision?: unknown;
  usdt?: bigint; quotePerTrade?: bigint; agentId?: string;
}) {
  const now = input.now;
  const agents = new MemoryAgentStore(null, now), positions = new MemoryTradePositionStore(now), intents = new MemoryTradeIntentStore(now);
  const settingsStore = new MemoryTradeSettingsStore(agents, now), journal = new MemoryExecutionJournal(now);
  const settings = aiSettings(input.settings);
  const agentId = input.agentId ?? (input.custody === "passkey" ? "altana-control" : "agentic-rfq");
  const nowSec = Math.floor(now() / 1000);
  let sessionFacts: SessionFacts;
  if (input.custody === "passkey") {
    const spec = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, pancakeRouterV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56 },
      tokens: input.pinned.map((token) => ({ token })), nativeCaps: [{ limit: E, period: "day" }], quoteToken: USDT_56, quoteDailyCapWei: 300n * E, quotePerTradeCapWei: 20n * E,
      platformFeeBps: 0, aggregatorGuard: GUARD, nowSeconds: nowSec, expiresAt: nowSec + 86_400 });
    sessionFacts = { spec, permissions: validateSessionSpec(spec, { nowSeconds: nowSec, minSessionSeconds: 0 }), publicKey: KEY, expiry: spec.expiresAt, grantedAtSec: nowSec - 3_600,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", minEntryWei: settings.minEntryWei!, capitalQuoteWei: settings.capitalQuoteWei!,
        entryWei: settings.entryWei, quotePerTradeWei: (input.quotePerTrade ?? 20n * E).toString() } };
  } else {
    const hireFacts: AgenticHireFacts = { acceptedAtMs: now() - 3_600_000, acceptedDedicatedWalletAtMs: now() - 3_600_000, termSec: 604_800, termEndAction: "keep",
      hireEndMs: now() + 604_800_000, entryCutoffMs: now() + 597_600_000, signInMaxTimeMs: now() + 90 * 86_400_000, pinned: [...input.pinned],
      quoteDayCapWei: (BigInt(settings.capitalQuoteWei!) * 5n).toString(), budgetWei: (2n * E).toString(),
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: settings.capitalQuoteWei!, entryWei: settings.entryWei,
        minEntryWei: settings.minEntryWei!, quotePerTradeWei: settings.entryWei, cmcNewsEnabled: false } };
    sessionFacts = projectAgenticSessionFacts({ agentId, walletAddress: WALLET, hireFacts } as unknown as AgenticWallet);
  }
  const agent = await agents.createAgent({ id: agentId, ownerAddress: input.custody === "passkey" ? OWNER : WALLET, walletAddress: WALLET, custodyModel: input.custody, status: "armed", sessionFacts });
  const owner = agent.ownerAddress;
  await settingsStore.put({ agentId, ownerAddress: owner, params: settings, digest: tradeSettingsDigest(settings) });
  const log = { dataPlane: [] as string[], direct: [] as string[], flash: [] as string[], llm: [] as { exit: boolean; content: string }[],
    /** the stock of every direct route quote and of every cost quote (not part of the Altana transcript digests) */ directTokens: [] as string[], cost: [] as string[] };
  const base = rfqDataPlane(input.rows, input.dataPlane);
  const dataPlane = new Proxy(base, { get(target, property, receiver): unknown {
    const value: unknown = Reflect.get(target, property, receiver);
    if (typeof value !== "function" || typeof property !== "string") return value;
    return (...args: unknown[]) => { log.dataPlane.push(property); return (value as (...a: unknown[]) => unknown).apply(target, args); };
  } }) as TradeDataPlaneReads;
  const balances = input.balances ?? new Map<string, bigint>();
  const factor = { sell: 1000n };
  const reader: RouteQuoteReader = {
    quoteV2: async (path, amount) => { log.direct.push("v2"); log.directTokens.push((path[0]!.toLowerCase() === USDT_56.toLowerCase() ? path.at(-1)! : path[0]!).toLowerCase()); return path[0]!.toLowerCase() === USDT_56.toLowerCase() ? amount : amount * factor.sell / 1000n; },
    quoteV3Single: async (tokenIn, tokenOut, fee, amount) => { log.direct.push(`v3:${fee}`); log.directTokens.push((tokenIn.toLowerCase() === USDT_56.toLowerCase() ? tokenOut : tokenIn).toLowerCase()); return tokenIn.toLowerCase() === USDT_56.toLowerCase() ? amount : amount * factor.sell / 1000n; },
    quoteV3Path: async () => { throw new Error("no path"); }, quoteUniV3Single: async () => { throw new Error("no uni"); }, quoteUniV3Path: async () => { throw new Error("no uni"); },
  };
  const submitted: TradeRequest[] = [];
  const llm = { entryCalls: 0, exitCalls: 0, throwExit: false };
  const deps: TradeWorkerDeps = { agentStore: agents, positions, intents, settingsStore, journal, dataPlane, aggregatorGuard: GUARD,
    provider: { getTokenBalance: async ({ token }) => token.toLowerCase() === USDT_56.toLowerCase() ? input.usdt ?? 300n * E : balances.get(token.toLowerCase()) ?? 0n,
      getTokenMetadata: async () => ({ decimals: 18, symbol: "STOCK" }),
      readSpendInfos: async () => [{ token: USDT_56, period: "day", periodCode: 2, limitWei: input.custody === "passkey" ? 300n * E : BigInt(settings.capitalQuoteWei!) * 5n, currentSpentWei: 0n }] },
    llmFor: () => ({ complete: async (messages) => {
      const isExit = messages[0]?.content.startsWith("Decide only") === true || messages[0]?.content.includes("decide only whether each indexed") === true;
      log.llm.push({ exit: isExit, content: messages.map((m) => m.content).join("\n") });
      if (isExit) { llm.exitCalls += 1; if (llm.throwExit) throw new Error("llm outage"); } else llm.entryCalls += 1;
      return { model: "offline", content: JSON.stringify(isExit ? (input.exitDecision ?? { decisions: [{ index: 0, exit: true, reason: "exit" }] })
        : (input.entryDecision ?? { decisions: [{ index: 0, enter: true, confidence: 100, amountAtomic: (5n * E).toString(), reason: "enter" }] })) };
    } }),
    executor: { execute: async (request) => { submitted.push(request.request);
      await journal.begin({ idempotencyKey: request.idempotencyKey, agentId, ownerAddress: owner, kind: "trade", decisionId: request.request.decisionId, externalRef: { paramsHash: HASH } });
      if (request.request.side === "sell") balances.set(request.request.token.toLowerCase(), 0n);
      return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
        fill: request.request.side === "sell" ? { side: "sell", exitWei: null, fillStatus: "unverified" }
          : { side: "buy", entryWei: request.request.amountWei, tokenAmount: request.request.quotedOutWei, fillStatus: "verified", receiptAttributable: true,
            verifiedEntryAtomic: request.request.amountWei, receiptOwnershipKey: `56|${HASH}|${WALLET.toLowerCase()}|0|${HASH}` }, meta: {} }; } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(input.rows.map((row) => row.address.toLowerCase())) },
    rpcUrls: [], routeReader: reader, platformFeeBps: 0, tradfiNativeCostUsdtAtomic: async (cost) => { log.cost.push((cost.tokenIn.toLowerCase() === USDT_56.toLowerCase() ? cost.tokenOut : cost.tokenIn).toLowerCase()); return 1n; }, forbiddenAddresses: () => new Set(),
    executionIdentity: (_a, request) => ({ idempotencyKey: keccak256(stringToBytes(request.decisionId)), paramsHash: HASH }),
    recoverFill: async (intent) => intent.side === "buy" ? { side: "buy", entryWei: intent.entryWei, tokenAmount: null, fillStatus: "unverified" } : { side: "sell", exitWei: null, fillStatus: "unverified" },
    now, verdictCache: createTradeVerdictCache(), ...input.extraDeps };
  return { deps, agent, agents, positions, intents, settingsStore, journal, submitted, log, llm, balances, factor, owner, settings, reader };
}
