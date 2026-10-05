/** Offline fixture for the Agentic Schedule tests: a bound (or paired) Agentic hire over memory stores and a fake Binance runner. Copied, not imported, from the contract suite's fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { type Hex } from "viem";
import { MemoryAgentStore } from "../../src/store/agents.js";
import { MemoryExecutionJournal } from "../../src/store/journal.js";
import { MemoryTradeIntentStore } from "../../src/store/tradeIntents.js";
import { MemoryTradePositionStore } from "../../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../../src/store/tradeSettings.js";
import { MemoryTradeCmcStore } from "../../src/store/tradeCmc.js";
import { MemoryKillSwitch } from "../../src/killswitch/killswitch.js";
import { DEFAULT_TRADE_SETTINGS, isTradeScheduleSettings, tradeSettingsDigest, type TradeSettings } from "../../src/trade/settings.js";
import { AgenticStore, encryptAgenticSession } from "../../src/agentic/store.js";
import { agenticAddress, projectAgenticSessionFacts, type AgenticFactsRead, type AgenticWallet } from "../../src/agentic/domain.js";
import { BawRunner, type BawResult, type PreparedBaw } from "../../src/agentic/baw.js";
import { AgenticInstanceManager } from "../../src/agentic/instances.js";
import { AgenticPairings } from "../../src/agentic/routes.js";
import type { AgenticChain } from "../../src/agentic/resolve.js";
import { resumeAgenticEnding, createAgenticWorkerDeps } from "../../src/agentic/worker.js";
import { createAgenticCmc } from "../../src/agentic/cmc.js";
import { tradeConfig } from "./serverHarness.js";
import type { TradeWorkerDeps } from "../../src/trade/worker.js";

export const NOW = 1_900_000_000_000, E = 10n ** 18n, SECRET = "offline-pairing-secret";
export const W = agenticAddress("0x1111111111111111111111111111111111111111"), TOKEN = agenticAddress("0x2222222222222222222222222222222222222222");
export const HASH = `0x${"33".repeat(32)}` as Hex;
export const MASTER = Buffer.alloc(32, 9);
export const PAIRING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const aiParams: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, name: "Agentic fixture", executionModel: "tradfi" as const, settlementAsset: "USDT" as const,
  minEntryWei: (5n * E).toString(), entryWei: (5n * E).toString(), capitalQuoteWei: (10n * E).toString(), maxOpenPositions: 2,
  stopLossBps: null, takeProfitBps: null, maxHoldSec: null, breakEvenAfterTp: false, noReentry: false,
  cmcNewsEnabled: true, cmcTotalBudgetWei: (2n * E).toString() };
const { cmcTotalBudgetWei: _budget, ...aiWithoutBudget } = aiParams;
/** The Altana Schedule tuple (5 USDT per buy, hourly, two runs, market hours off, premium 1.5 %): what the Deploy form sends. */
export const scheduleParams: TradeSettings = { ...aiWithoutBudget, name: "Agentic schedule", maxOpenPositions: 1, cmcNewsEnabled: false, tradeMode: "schedule",
  scheduleToken: TOKEN, scheduleIntervalSec: 3_600, scheduleFirstAtSec: null, scheduleEndKind: "runs", scheduleEndAtSec: null, scheduleEndRuns: 2,
  scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150 };
export const settingsOutput = () => ({ tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1_000, quotaUsed: 0,
  x402DailyLimit: 20, x402QuotaUsed: 0, signInMaxTime: new Date(NOW + 90 * 86_400_000).toISOString(), sessionExpireTime: null, inactiveSignOutTime: null });
export const FACTS: AgenticFactsRead = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject",
  dailyLimit: 1_000, quotaUsed: 0, x402DailyLimit: 0.5, x402QuotaUsed: 0, signInMaxTimeMs: NOW + 90 * 86_400_000,
  usdtWei: (108n * E).toString(), bnbWei: "4800000000000000" };
export const PAIRED: Partial<AgenticWallet> = { state: "paired", hireFacts: null, hireOpId: null, agentId: null, hireParams: null, hireStage: null, acceptedAt: null,
  hireEndMs: null, entryCutoffMs: null, termEndAction: null, factsRead: { ...FACTS, usdtWei: (100n * E).toString(), bnbWei: E.toString() } };
export const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v)).digest("hex");

export class OfflineBaw extends BawRunner {
  calls: string[][] = [];
  replies = new Map<string, BawResult | (() => Promise<BawResult>)>();
  directory = "";
  constructor() { super(join(process.cwd(), "scripts", "tmp", "never-invoked.cjs")); }
  override async run(args: readonly string[]): Promise<BawResult> {
    this.calls.push([...args]);
    const command = args.slice(0, 2).join(" "), reply = this.replies.get(command);
    if (reply !== undefined) return typeof reply === "function" ? reply() : reply;
    const data: unknown = command === "wallet settings" ? settingsOutput() : command === "wallet status" ? { status: "CONNECTED" }
      : command.endsWith(" list") ? { total: 0, page: Number(args[args.indexOf("--page") + 1] ?? 1), pageSize: 100, list: [] }
      : command === "market-order quote" ? { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: "5.1", slippage: "0" }
      : command === "market-order swap" ? { orderId: "json-id" } : command === "auth signout" ? { status: "LOGGED_OUT" } : null;
    return { kind: "ok", data, sessionPresent: true, rwaTokens: { updatedAt: NOW, tokens: [{ chainId: "56", contractAddress: TOKEN, multiplier: "1", kind: "bstock" }] } };
  }
  override async prepare(args: readonly string[]): Promise<PreparedBaw> {
    return this.prepareInDirectory(this.directory, args, "77".repeat(32));
  }
  override async prepareInDirectory(directory: string, args: readonly string[], instanceId: string): Promise<PreparedBaw> {
    return { directory, environment: { BINANCE_INSTANCE_ID: instanceId, FOURLPHA_START_DEADLINE_MS: "0" }, start: () => this.run(args),
      close: async () => undefined, cancel: () => undefined };
  }
}

export async function fixture(t: TestContext, initial: Partial<AgenticWallet> = {}, stored: TradeSettings = aiParams, sharedDeps?: (now: () => number) => Partial<TradeWorkerDeps>) {
  let time = NOW;
  const schedule = isTradeScheduleSettings(stored), capital = BigInt(stored.capitalQuoteWei!);
  const now = () => time, agents = new MemoryAgentStore(null, now), journal = new MemoryExecutionJournal(now), intents = new MemoryTradeIntentStore(now),
    positions = new MemoryTradePositionStore(now), settings = new MemoryTradeSettingsStore(agents, now), cmc = new MemoryTradeCmcStore(now), killswitch = new MemoryKillSwitch();
  const store = new AgenticStore(null, { agents, journal, intents, cmc, killswitch }, now), runner = new OfflineBaw();
  await mkdir(join(process.cwd(), "scripts", "tmp"), { recursive: true }); runner.directory = await mkdtemp(join(process.cwd(), "scripts", "tmp", "agentic-schedule-"));
  await mkdir(join(runner.directory, "baw"));
  const session = { v: 1 as const, instanceId: "77".repeat(32), sessionJson: JSON.stringify({ sessionId: "offline", clientId: "offline" }) };
  await writeFile(join(runner.directory, "baw", "session.json"), session.sessionJson);
  const row: AgenticWallet = { pairingId: PAIRING, state: "bound", walletAddress: W, ownerAddress: W,
    pairingSecretHash: createHash("sha256").update(SECRET).digest("hex"), qr: null, codeHash: "", codeAttempts: 0, codeMatchedAt: NOW,
    verifiedAt: NOW, continuationDeadline: NOW + 1_800_000, sessionCiphertext: null, factsRead: null, hireOpId: HASH, agentId: "agentic-fixture",
    hireParams: { pairingId: PAIRING, term: 7, termEndAction: "keep", executionModel: "tradfi", hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", settings: stored, acceptedDedicatedWallet: true },
    hireStage: "active", acceptedAt: NOW, hireFacts: { acceptedAtMs: NOW, acceptedDedicatedWalletAtMs: NOW, termSec: 604_800, termEndAction: "keep",
      hireEndMs: NOW + 604_800_000, entryCutoffMs: NOW + 597_600_000, signInMaxTimeMs: NOW + 90 * 86_400_000, pinned: [TOKEN],
      quoteDayCapWei: (schedule ? capital : capital * 5n).toString(), budgetWei: schedule ? "0" : (2n * E).toString(),
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: stored.capitalQuoteWei!, entryWei: stored.entryWei, minEntryWei: stored.minEntryWei!,
        quotePerTradeWei: stored.entryWei, cmcNewsEnabled: !schedule, ...(schedule ? {} : { cmcTotalBudgetWei: stored.cmcTotalBudgetWei! }) } },
    hireEndMs: NOW + 604_800_000, entryCutoffMs: NOW + 597_600_000, termEndAction: "keep", drainRequestedAt: null, settingsHold: null, entriesStopped: null,
    probe: null, endReason: null, endBlockers: null, endStage: null, logout: null, cleanupReason: null, failure: null, version: 1, createdAt: NOW, updatedAt: NOW, ...initial };
  if (!["ended", "failed", "expired", "waiting"].includes(row.state)) row.sessionCiphertext = encryptAgenticSession(session, MASTER, row.pairingId, W);
  assert.ok(await store.createWallet(row));
  const agent = await agents.createAgent({ id: "agentic-fixture", ownerAddress: W, walletAddress: W, custodyModel: "binance-agentic", status: "armed" });
  await settings.put({ ownerAddress: W, agentId: agent.id, params: stored, digest: tradeSettingsDigest(stored) });
  if (!schedule) {
    await cmc.putInitial({ agentId: agent.id, ownerAddress: W, wallet: W, totalWei: 2n * E });
    await cmc.setCapability({ agentId: agent.id, ownerAddress: W, generation: 0, available: true });
  }
  const instance = await AgenticInstanceManager.start(store, runner, "trade-worker", { machineId: "offline-machine", osBootMarker: "offline-boot" }, {}, () => undefined);
  const balances = { native: E, usdt: 100n * E };
  const chain: AgenticChain = { balance: async (_wallet, token) => token === null ? balances.native : balances.usdt, code: async () => "0x", multiplier: async () => E,
    metadata: async () => ({ decimals: 18, symbol: "STOCK" }), nonce: async () => 0n, receipt: async () => null };
  const execution = { store, runner, chain, instance, masterKey: MASTER, positions };
  const executorDeps = { chainId: 56, keyStore: TOKEN, agentStore: agents, settingsStore: settings, journal, killswitch,
    providerRegistry: { get() { throw new Error("Altana provider used"); } }, trade: tradeConfig({ feeBps: 0 }), pancake: null, pancakeV3: null, uniswapV3: null, flapPortal: null };
  const cmcRuntime = createAgenticCmc({ ...execution, agents, settings, cmc, journal, killswitch, rpcUrls: ["offline://1", "offline://2", "offline://3"], transport: { request: async () => { throw new Error("No payment expected"); } } });
  const shared = { agents, agentStore: agents, settingsStore: settings, positions, intents, journal, killswitch,
    readiness: { ready: false, allowlistAvailable: true, bstocksAddresses: new Set<string>() }, llmFor: () => { throw new Error("No LLM expected"); },
    dataPlane: { tokensBatch: async () => [] }, rpcUrls: [], platformFeeBps: 0, forbiddenAddresses: () => new Set<string>(), ...sharedDeps?.(now) } as unknown as TradeWorkerDeps;
  const worker = createAgenticWorkerDeps({ shared, agents, settings, execution, executorDeps, cmc: cmcRuntime });
  const lifecycle = { ...execution, agents, settings, worker, cmc: cmcRuntime, execution, journal };
  const pairings = new AgenticPairings({ ...execution, agents, settings, cmc, origins: ["https://4lpha.test"], ready: () => true, publicView: async () => ({}), resumeEnding: r => resumeAgenticEnding(lifecycle, r) });
  pairings.pin = async () => [TOKEN];
  t.after(async () => { await pairings.close(); await cmcRuntime.runtime.close(); await instance.finish(); await rm(runner.directory, { recursive: true, force: true }); });
  return { ...lifecycle, lifecycle, intents, killswitch, row, agent, pairings, cmcStore: cmc, balances, setTime: (value: number) => { time = value; }, now, executorDeps, projected: () => projectAgenticSessionFacts({ ...row, agentId: agent.id }) };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
