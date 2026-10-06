import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Hono } from "hono";
import { getAddress, keccak256, stringToBytes, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal, PostgresExecutionJournal, reconcile } from "../src/store/journal.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeCmcStore, PostgresTradeCmcStore, type CmcMemorySnapshot, type CmcNewsRecord } from "../src/store/tradeCmc.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest } from "../src/trade/settings.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { AgenticStore, encryptAgenticSession, decryptAgenticSession, AGENTIC_CLAIM_SQL, AGENTIC_PAY_CHECK_SQL } from "../src/agentic/store.js";
import { AGENTIC_RECEIPT_TAG, agenticAddress, agenticHireIdentity, projectAgenticSessionFacts, altanaAgentStore, type AgenticWallet, type AgenticOrder } from "../src/agentic/domain.js";
import { BawRunner, type BawResult, type PreparedBaw } from "../src/agentic/baw.js";
import { AgenticInstanceManager, agenticQuiescence } from "../src/agentic/instances.js";
import { AgenticPairings, registerAgenticRoutes } from "../src/agentic/routes.js";
import { executeAgenticTrade, readAgenticSettings } from "../src/agentic/execute.js";
import { resolveAgenticOrder, terminalizeAgenticOrder, verifyAgenticSwap, type AgenticChain, type AgenticReceipt } from "../src/agentic/resolve.js";
import { resumeAgenticEnding, createAgenticWorkerDeps, runAgenticCycle } from "../src/agentic/worker.js";
import { createAgenticCmc } from "../src/agentic/cmc.js";
import { createAgenticPublicView, agenticUnsold } from "../src/agentic/publicView.js";
import { parseAgenticGateArgs, agenticGateWallets, runAgenticGate } from "../scripts/agentic-gate.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { createHarness, tradeConfig, EXEC_TOKEN, signOwnerAction, toReadHeader, ownerAccount, signRuntimeRequest } from "./support/serverHarness.js";
import { CMC_PRICE_ATOMIC, CMC_PAYEE, CMC_SPENDER, CMC_SIGNER, CMC_CONFIG_ID } from "../src/trade/cmc.js";
import { CMC_PERMIT2 } from "../src/trade/cmcCapability.js";
import type { TradeWorkerDeps } from "../src/trade/worker.js";
import { createHash } from "node:crypto";
import { CMC_SKILL_MACRO, CMC_SKILL_SECTOR } from "../src/trade/cmcUsEquity.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import type { CmcTransport } from "../src/trade/cmcPayment.js";
import { agenticPayCheck } from "../src/agentic/obligations.js";
import { runTradeWorkerOnce } from "../src/trade/worker.js";

const NOW = 1_900_000_000_000, E = 10n ** 18n;
const W = agenticAddress("0x1111111111111111111111111111111111111111"), TOKEN = agenticAddress("0x2222222222222222222222222222222222222222");
const HASH = `0x${"33".repeat(32)}` as Hex, BLOCK = `0x${"44".repeat(32)}` as Hex;
const SECRET = "offline-pairing-secret", MASTER = Buffer.alloc(32, 9);
const params = { ...DEFAULT_TRADE_SETTINGS, name: "Agentic fixture", executionModel: "tradfi" as const, settlementAsset: "USDT" as const,
  minEntryWei: (5n * E).toString(), entryWei: (5n * E).toString(), capitalQuoteWei: (10n * E).toString(), maxOpenPositions: 2,
  stopLossBps: null, takeProfitBps: null, maxHoldSec: null, breakEvenAfterTp: false, noReentry: false,
  cmcNewsEnabled: true, cmcTotalBudgetWei: (2n * E).toString() };
const settingsOutput = () => ({ tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1_000, quotaUsed: 0,
  x402DailyLimit: 20, x402QuotaUsed: 0, signInMaxTime: new Date(NOW + 90 * 86_400_000).toISOString(), sessionExpireTime: null, inactiveSignOutTime: null });
class OfflineBaw extends BawRunner {
  calls: string[][] = [];
  replies = new Map<string, BawResult | (() => Promise<BawResult>)>();
  directory = "";
  onStart: (() => void) | null = null;
  constructor() { super(join(process.cwd(), "scripts", "tmp", "never-invoked.cjs")); }
  override async run(args: readonly string[]): Promise<BawResult> {
    this.calls.push([...args]); this.onStart?.();
    const command = args.slice(0, 2).join(" "), reply = this.replies.get(command);
    if (reply !== undefined) return typeof reply === "function" ? reply() : reply;
    const data: unknown = command === "wallet settings" ? settingsOutput() : command === "wallet status" ? { status: "CONNECTED" }
      : command === "wallet address" ? { addresses: [{ binanceChainId: "56", chainName: "BSC", address: W }] }
      : command.endsWith(" list") ? { total: 0, page: Number(args[args.indexOf("--page") + 1] ?? 1), pageSize: 100, list: [] }
      : command === "market-order quote" ? { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: "5.1", slippage: "0" }
      : command === "market-order swap" ? { orderId: "json-id" } : command === "auth signout" ? { status: "LOGGED_OUT" }
      : command === "auth verify" ? { status: "SUCCESS" } : command === "auth signin" ? { qrCodeId: "offline-qr", expireAt: String(NOW + 300_000), urlForWeb: "https://app.binance.com/uni-qr/offline", pairingCode: "abcdef" }
      : command === "wallet balance" ? [{ symbol: "STOCK", address: TOKEN, binanceChainId: "56", balance: "5", price: "1", value: "5" }] : null;
    return { kind: "ok", data, sessionPresent: command !== "auth signin", rwaTokens: { updatedAt: NOW, tokens: [{ chainId: "56", contractAddress: TOKEN, multiplier: "1", kind: "bstock" }] } };
  }
  override async prepare(args: readonly string[]): Promise<PreparedBaw> {
    return this.prepareInDirectory(this.directory, args, "77".repeat(32));
  }
  override async prepareInDirectory(directory: string, args: readonly string[], instanceId: string): Promise<PreparedBaw> {
    return { directory, environment: { BINANCE_INSTANCE_ID: instanceId, FOURLPHA_START_DEADLINE_MS: "0" }, start: () => this.run(args),
      close: async () => undefined, cancel: () => undefined };
  }
}
function receipt(side: "buy" | "sell" = "buy", amount = 5n * E, out = 5n * E): AgenticReceipt {
  const topic = (address: Address) => ("0x" + address.slice(2).padStart(64, "0")) as Hex;
  const transfer = keccak256(stringToBytes("Transfer(address,address,uint256)"));
  return { from: W, to: TOKEN, input: "0x", observation: { chainId: 56,
    transaction: { hash: HASH, to: TOKEN, input: "0x", blockNumber: 1n, blockHash: BLOCK, transactionIndex: 0n },
    receipt: { status: 1n, transactionHash: HASH, blockNumber: 1n, blockHash: BLOCK, transactionIndex: 0n, logs: [
      { address: side === "buy" ? USDT_56 : TOKEN, topics: [transfer, topic(W), topic(TOKEN)], data: ("0x" + amount.toString(16).padStart(64, "0")) as Hex, logIndex: 0n },
      { address: side === "buy" ? TOKEN : USDT_56, topics: [transfer, topic(TOKEN), topic(W)], data: ("0x" + out.toString(16).padStart(64, "0")) as Hex, logIndex: 1n }], },
    receiptBlock: { number: 1n, hash: BLOCK }, finalizedBlock: { number: 2n, hash: BLOCK } } };
}
async function fixture(t: TestContext, initial: Partial<AgenticWallet> = {}) {
  let time = NOW;
  const now = () => time, agents = new MemoryAgentStore(null, now), journal = new MemoryExecutionJournal(now), intents = new MemoryTradeIntentStore(now),
    positions = new MemoryTradePositionStore(now), settings = new MemoryTradeSettingsStore(agents, now), cmc = new MemoryTradeCmcStore(now), killswitch = new MemoryKillSwitch();
  const store = new AgenticStore(null, { agents, journal, intents, cmc, killswitch }, now), runner = new OfflineBaw();
  await mkdir(join(process.cwd(), "scripts", "tmp"), { recursive: true }); runner.directory = await mkdtemp(join(process.cwd(), "scripts", "tmp", "agentic-contract-"));
  await mkdir(join(runner.directory, "baw"));
  const session = { v: 1 as const, instanceId: "77".repeat(32), sessionJson: JSON.stringify({ sessionId: "offline", clientId: "offline" }) };
  await writeFile(join(runner.directory, "baw", "session.json"), session.sessionJson);
  const row: AgenticWallet = { pairingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "bound", walletAddress: W, ownerAddress: W,
    pairingSecretHash: keccak256(stringToBytes(SECRET)).slice(2), qr: null, codeHash: "", codeAttempts: 0, codeMatchedAt: NOW,
    verifiedAt: NOW, continuationDeadline: NOW + 1_800_000, sessionCiphertext: null, factsRead: null, hireOpId: HASH, agentId: "agentic-fixture",
    hireParams: { pairingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", term: 7, termEndAction: "keep", executionModel: "tradfi", hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", settings: params, acceptedDedicatedWallet: true },
    hireStage: "active", acceptedAt: NOW, hireFacts: { acceptedAtMs: NOW, acceptedDedicatedWalletAtMs: NOW, termSec: 604_800, termEndAction: "keep",
      hireEndMs: NOW + 604_800_000, entryCutoffMs: NOW + 597_600_000, signInMaxTimeMs: NOW + 90 * 86_400_000, pinned: [TOKEN], quoteDayCapWei: (50n * E).toString(), budgetWei: (2n * E).toString(),
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: params.capitalQuoteWei, entryWei: params.entryWei, minEntryWei: params.minEntryWei,
        quotePerTradeWei: params.entryWei, cmcNewsEnabled: true, cmcTotalBudgetWei: params.cmcTotalBudgetWei } },
    hireEndMs: NOW + 604_800_000, entryCutoffMs: NOW + 597_600_000, termEndAction: "keep", drainRequestedAt: null, settingsHold: null, entriesStopped: null,
    probe: null, endReason: null, endBlockers: null, endStage: null, logout: null, cleanupReason: null, failure: null, version: 1, createdAt: NOW, updatedAt: NOW, ...initial };
  if (!["ended", "failed", "expired", "waiting"].includes(row.state)) row.sessionCiphertext = encryptAgenticSession(session, MASTER, row.pairingId, W);
  assert.ok(await store.createWallet(row));
  const agent = await agents.createAgent({ id: "agentic-fixture", ownerAddress: W, walletAddress: W, custodyModel: "binance-agentic", status: "armed" });
  await settings.put({ ownerAddress: W, agentId: agent.id, params, digest: tradeSettingsDigest(params) });
  await cmc.putInitial({ agentId: agent.id, ownerAddress: W, wallet: W, totalWei: 2n * E });
  await cmc.setSetup({ agentId: agent.id, ownerAddress: W, wallet: W, generation: 0, sessionPublicKey: projectAgenticSessionFacts({ ...row, agentId: agent.id, hireFacts: row.hireFacts ?? { acceptedAtMs: NOW, termSec: 604_800, termEndAction: "keep", hireEndMs: NOW + 604_800_000,
    entryCutoffMs: NOW + 597_600_000, signInMaxTimeMs: NOW + 90 * 86_400_000, pinned: [TOKEN], quoteDayCapWei: "1", budgetWei: "1", hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" }, acceptedDedicatedWalletAtMs: NOW } }).publicKey,
    sessionExpiry: Math.floor((row.hireEndMs ?? NOW + 604_800_000) / 1_000), allowanceWei: 2n * E });
  await cmc.setCapability({ agentId: agent.id, ownerAddress: W, generation: 0, available: true });
  const instance = await AgenticInstanceManager.start(store, runner, "trade-worker", { machineId: "offline-machine", osBootMarker: "offline-boot" }, {}, () => undefined);
  const chain: AgenticChain = { balance: async (_wallet, token) => token === null ? E : 100n * E, code: async () => "0x", multiplier: async () => E,
    metadata: async () => ({ decimals: 18, symbol: "STOCK" }), nonce: async () => 0n, receipt: async () => receipt() };
  const execution = { store, runner, chain, instance, masterKey: MASTER, positions };
  const executorDeps = { chainId: 56, keyStore: TOKEN, agentStore: agents, settingsStore: settings, journal, killswitch,
    providerRegistry: { get() { throw new Error("Altana provider used"); } }, trade: tradeConfig({ feeBps: 0 }), pancake: null, pancakeV3: null, uniswapV3: null, flapPortal: null };
  const cmcRuntime = createAgenticCmc({ ...execution, agents, settings, cmc, journal, killswitch, rpcUrls: ["offline://1", "offline://2", "offline://3"], transport: { request: async () => { throw new Error("No payment expected"); } } });
  const shared = { agents, agentStore: agents, settingsStore: settings, positions, intents, journal, killswitch,
    readiness: { ready: false, allowlistAvailable: true, bstocksAddresses: new Set<string>() }, llmFor: () => { throw new Error("No LLM expected"); },
    dataPlane: { tokensBatch: async () => [] }, rpcUrls: [], platformFeeBps: 0, forbiddenAddresses: () => new Set<string>() } as unknown as TradeWorkerDeps;
  const worker = createAgenticWorkerDeps({ shared, agents, settings, execution, executorDeps, cmc: cmcRuntime });
  const lifecycle = { ...execution, agents, settings, worker, cmc: cmcRuntime, execution, journal };
  const pairings = new AgenticPairings({ ...execution, agents, settings, cmc, origins: ["https://4lpha.test"], ready: () => true, publicView: async () => ({}), resumeEnding: r => resumeAgenticEnding(lifecycle, r) });
  pairings.pin = async () => [TOKEN];
  t.after(async () => { await pairings.close(); await cmcRuntime.runtime.close(); await instance.finish(); await rm(runner.directory, { recursive: true, force: true }); });
  const order = (patch: Partial<AgenticOrder> = {}): AgenticOrder => ({ idempotencyKey: HASH, kind: "swap", walletAddress: W, agentId: agent.id, decisionId: "decision", side: "buy",
    fromToken: agenticAddress(USDT_56), toToken: TOKEN, amountAtomic: (5n * E).toString(), intendedRaw: null, fromQty: "5", minOutAtomic: (4n * E).toString(),
    binanceQuoteOutAtomic: (5n * E).toString(), slippagePct: "1", multiplierPre: "1", multiplierUsed: null, listSnapshot: { takenAtMs: time, startTimeMs: time - 86_400_000, ids: ["old"] },
    operationId: null, walletNoncePre: null, quoteAt: time, dispatch: "unclaimed", claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null,
    response: null, cliResult: null, returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null, outcome: "open", holdReason: null,
    evidence: null, fillCheck: "none", createdAt: time, updatedAt: time, ...patch });
  return { ...lifecycle, lifecycle, intents, killswitch, row, agent, pairings, cmcStore: cmc, setTime: (value: number) => { time = value; }, now, order, executorDeps, shared,
    input: { agent: { ...agent, sessionFacts: row.hireFacts === null ? null : projectAgenticSessionFacts({ ...row, agentId: agent.id }) }, idempotencyKey: HASH, paramsHash: HASH,
      request: { decisionId: "decision", venue: "pancake" as const, side: "buy" as const, token: TOKEN, amountWei: 5n * E, minOutWei: 4_900_000_000_000_000_000n, quotedOutWei: 5n * E,
        settlementAsset: "USDT" as const, platformFeeAtomic: 0n, route: { hops: [], fees: [] } }, scanGate: { evaluate: async () => ({ verdict: "allow" as const, reasons: [] }) }, deps: executorDeps } };
}

test("TRADFI-EXIT-RULES review H1: hosted-custody worker deps carry the exit-rules and entry-timing modes, and absent stays absent", async t => {
  const f = await fixture(t);
  const build = (patch: Partial<TradeWorkerDeps>) => createAgenticWorkerDeps({ shared: { ...f.shared, ...patch }, agents: f.agents, settings: f.settings,
    execution: f.execution, executorDeps: f.executorDeps, cmc: f.cmc });
  assert.equal(build({}).tradfiExitRulesMode, undefined);
  assert.equal(build({ tradfiExitRulesMode: "enforce" }).tradfiExitRulesMode, "enforce");
  assert.equal(build({ tradfiExitRulesMode: "log" }).tradfiExitRulesMode, "log");
  assert.equal(build({ entryTimingMode: "log" }).entryTimingMode, "log");
});

test("Agentic session encryption binds pairing and wallet and never installs projected facts", async t => {
  const f = await fixture(t); assert.equal(decryptAgenticSession(f.row, MASTER).sessionJson.includes("offline"), true);
  assert.throws(() => decryptAgenticSession({ ...f.row, pairingId: "foreign" }, MASTER), /AGENTIC_SESSION_DECRYPT/);
  assert.throws(() => decryptAgenticSession({ ...f.row, walletAddress: TOKEN }, MASTER), /AGENTIC_SESSION_DECRYPT/);
  assert.equal((await f.agents.getAgentById(f.agent.id))?.sessionFacts, null);
  assert.equal(projectAgenticSessionFacts(f.row).expiry, Math.floor(f.row.hireEndMs! / 1000));
});

const claimMutations = ["retired", "heartbeat", "pause", "halt", "end", "hold", "drain", "entries", "cutoff", "deadline", "journal-unknown", "foreign-order", "pending-fill", "historical-intent", "stale-fence", "other-holder", "swap-34", "quote", "custody", "agent-status"];
for (const mutation of claimMutations) test("Agentic claim mutation refuses " + mutation, async t => {
  const f = await fixture(t, mutation === "cutoff" || mutation === "deadline" ? { entryCutoffMs: NOW + 5_000 } : {});
  let order = f.order(); await f.store.beginSwap(order, { idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade", decisionId: "decision", nativeSpendWei: 0n }, NOW);
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  if (mutation === "retired") await f.store.retire(f.instance.row.instanceId, "dispose");
  if (mutation === "heartbeat") { f.setTime(NOW + 30_001); order = (await f.store.patchOrder(order, { quoteAt: f.now() }))!; }
  if (mutation === "pause") await f.killswitch.pauseAgent(f.agent.id, W);
  if (mutation === "halt") await f.killswitch.halt();
  if (mutation === "end") await f.store.leaveBound(f.row, "owner-signed-out");
  if (mutation === "hold") await f.store.patchWallet(f.row, { settingsHold: { code: "daily-limit", atMs: NOW } });
  if (mutation === "drain") await f.store.patchWallet(f.row, { drainRequestedAt: NOW });
  if (mutation === "entries") await f.store.patchWallet(f.row, { entriesStopped: { reason: "fill-below-minimum", out: "1", min: "2", atMs: NOW } });
  if (mutation === "journal-unknown") await f.journal.markUnknown(HASH, "offline");
  if (mutation === "foreign-order" || mutation === "pending-fill") await f.store.createOrder(f.order({ idempotencyKey: "other", agentId: "historical", outcome: mutation === "pending-fill" ? "committed" : "open", fillCheck: mutation === "pending-fill" ? "pending" : "none" }));
  if (mutation === "historical-intent") {
    await f.store.createWallet({ ...f.row, pairingId: "history", state: "ended", agentId: "historical", hireOpId: null, sessionCiphertext: null });
    await f.intents.create({ decisionId: "foreign", idempotencyKey: HASH, agentId: "historical", ownerAddress: W, side: "buy", token: TOKEN, route: { hops: [], fees: [] }, amountWei: E, entryWei: E, positionId: "p", closeReason: null });
  }
  if (mutation === "stale-fence" || mutation === "other-holder") { await f.store.releaseFence(fence); if (mutation === "other-holder") await f.store.acquireFence(W, "other-holder"); }
  if (mutation === "swap-34") { f.setTime(NOW + 86_001); await f.store.heartbeat(f.instance.row.instanceId); order = (await f.store.patchOrder(order, { quoteAt: f.now() }))!; }
  if (mutation === "quote") { f.setTime(NOW + 30_001); await f.store.heartbeat(f.instance.row.instanceId); }
  if (mutation === "custody") { const get = f.agents.getAgentById.bind(f.agents); t.mock.method(f.agents, "getAgentById", async (id: string) => { const a = await get(id); return a === null ? null : { ...a, custodyModel: "passkey" as const }; }); }
  if (mutation === "agent-status") await f.agents.transitionAgentStatus({ ownerAddress: W, agentId: f.agent.id, expectedStatus: "armed", expectedRowVersion: f.agent.rowVersion, status: "revoked" });
  assert.equal(await f.store.claimOrder(order, fence), null);
  const sealed = (await f.store.patchOrder(order, { dispatch: "sealed" }))!; await terminalizeAgenticOrder(f.store, f.journal, sealed);
  assert.equal((await f.journal.get(HASH))?.state, "ROLLED_BACK"); assert.equal((await f.store.getOrder(HASH))?.outcome, "rolled-back");
  assert.equal(f.runner.calls.some(a => a[1] === "swap"), false);
});

test("Agentic claim SQL and payment SQL pin every authorization clause and real kill-switch names", async () => {
  for (const text of [AGENTIC_CLAIM_SQL, AGENTIC_PAY_CHECK_SQL]) for (const clause of ["agentic_instances", "retired_at is null", "heartbeat_at>=n.ms-30000", "agentic_wallet_fences", "f.holder=$2", "f.token=$3", "w.state='bound'", "w.settings_hold is null", "n.ms+5000<", "a.status='armed'", "a.custody_model='binance-agentic'", "global_halt", "agent_pause", "trade_intents", "fill_check='pending'"]) assert.ok(text.includes(clause), clause);
  for (const clause of ["o.dispatch='unclaimed'", "o.outcome='open'", "o.quote_at>=n.ms-30000", "35000", "75000", "w.entries_stopped is null", "w.drain_requested_at is null", "j.state='PENDING'", "i.decision_id is distinct from o.decision_id", "x.idempotency_key<>o.idempotency_key"]) assert.ok(AGENTIC_CLAIM_SQL.includes(clause), clause);
  const source = await readFile(new URL("../src/killswitch/killswitch.ts", import.meta.url), "utf8"); assert.match(source, /create table if not exists agent_pause/); assert.match(source, /create table if not exists global_halt/);
});

test("Agentic fence tokens serialize processes and conditional release cannot release a successor", async t => {
  const f = await fixture(t), first = (await f.store.acquireFence(W, "worker-one"))!;
  assert.equal(await f.store.acquireFence(W, "worker-two"), null); assert.equal(await f.store.acquireFence(W, "gate"), null);
  f.setTime(NOW + 120_001); const next = (await f.store.acquireFence(W, "gate"))!;
  assert.equal(BigInt(next.token), BigInt(first.token) + 1n); await f.store.releaseFence(first);
  assert.equal(await f.store.acquireFence(W, "worker-two"), null); assert.equal(await f.store.renewFence(first), null);
});

for (const state of ["PENDING", "IN_PROGRESS", "UNKNOWN", "ROLLED_BACK", "COMMITTED"] as const) for (const dispatch of ["sealed", "not-started"] as const)
  test(`Agentic recovery ${dispatch} from ${state}`, async t => {
    const f = await fixture(t), order = f.order({ dispatch }); await f.store.createOrder(order); await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade" });
    if (state === "IN_PROGRESS") await f.journal.markInProgress(HASH, {});
    if (state === "UNKNOWN") await f.journal.markUnknown(HASH, "offline");
    if (state === "ROLLED_BACK") await f.journal.markRolledBack(HASH, "offline");
    if (state === "COMMITTED") await f.journal.markCommitted(HASH, { txHash: HASH });
    const result = await terminalizeAgenticOrder(f.store, f.journal, order);
    assert.equal(result?.outcome, state === "COMMITTED" ? "open" : "rolled-back");
    if (state === "COMMITTED") assert.equal(result?.holdReason, "sealed-but-committed");
    else assert.equal((await f.journal.get(HASH))?.state, "ROLLED_BACK");
    await terminalizeAgenticOrder(f.store, f.journal, (await f.store.getOrder(HASH))!);
  });

for (const response of ["accepted", "rejected", "no-response"] as const) for (const listed of ["finished", "failed-null", "multiple", "empty"] as const)
  test(`Agentic resolution ${response} ${listed}`, async t => {
    const f = await fixture(t), order = f.order({ dispatch: "spawned", claimant: f.instance.row.instanceId, response, claimedAt: NOW });
    await f.store.createOrder(order); await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade" }); await f.journal.markUnknown(HASH, "offline");
    const rows = listed === "empty" ? [] : listed === "multiple" ? [{ orderId: "new-a", status: "FINISHED", txHash: HASH }, { orderId: "new-b", status: "FINISHED", txHash: HASH }]
      : [{ orderId: "new", status: listed === "finished" ? "FINISHED" : "FAILED", txHash: listed === "finished" ? HASH : null }];
    f.runner.replies.set("market-order list", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: rows.length, page: 1, pageSize: 100, list: rows } });
    const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
    await resolveAgenticOrder({ ...f.execution, journal: f.journal, order, fence });
    const current = (await f.store.getOrder(HASH))!;
    const expected = response === "no-response" || ["empty", "multiple"].includes(listed) || response === "accepted" && listed === "failed-null" ? "open" : listed === "finished" ? "committed" : "rolled-back";
    assert.equal(current.outcome, expected);
    if (response === "no-response") { assert.equal(current.holdReason, "no-response"); assert.equal(f.runner.calls.length, 0); }
    if (listed === "empty") { f.setTime(NOW + 10 * 86_400_000); await resolveAgenticOrder({ ...f.execution, journal: f.journal, order: current, fence }); assert.equal((await f.store.getOrder(HASH))?.outcome, "open"); }
  });

for (const mutation of ["sender", "revert", "third-token", "inexact", "partial-sell", "rpc-unavailable"])
  test("Agentic finalized swap verification refuses " + mutation, async t => {
    const f = await fixture(t), order = mutation === "partial-sell" ? f.order({ side: "sell", fromToken: TOKEN, toToken: agenticAddress(USDT_56), intendedRaw: (5n * E).toString() }) : f.order();
    let proof = receipt(mutation === "partial-sell" ? "sell" : "buy", mutation === "inexact" || mutation === "partial-sell" ? 4n * E : 5n * E);
    if (mutation === "sender") proof = { ...proof, from: TOKEN };
    if (mutation === "revert") proof = { ...proof, observation: { ...proof.observation, receipt: { ...proof.observation.receipt, status: 0n } } };
    if (mutation === "third-token") proof = { ...proof, observation: { ...proof.observation, receipt: { ...proof.observation.receipt, logs: [...proof.observation.receipt.logs, { ...proof.observation.receipt.logs[0]!, address: W }] } } };
    f.chain.receipt = async () => mutation === "rpc-unavailable" ? null : proof;
    assert.equal(await verifyAgenticSwap(f.chain, order, HASH), null);
    if (mutation === "partial-sell") assert.equal((await verifyAgenticSwap(f.chain, order, HASH, true))?.input, 4n * E);
  });

for (const signal of ["U", "CONNECTED", "UNAUTHORIZED"] as const) test("Agentic owner confirmation " + signal, async t => {
  const f = await fixture(t, { probe: { lastAtMs: NOW, firstUAtMs: NOW - 60_000, unreachableAtMs: null } });
  f.runner.replies.set("wallet status", signal === "UNAUTHORIZED" ? { kind: "cli-error", code: 10003001, name: "UNAUTHORIZED", orderId: null, sessionPresent: true }
    : { kind: "ok", data: { status: signal === "U" ? "UNCONNECTED" : "CONNECTED" }, sessionPresent: true, rwaTokens: null });
  await runAgenticCycle(f.lifecycle);
  const current = (await f.store.byAgent(f.agent.id))!;
  assert.equal(current.state, signal === "U" ? "ended" : "bound");
  if (signal === "U") { assert.equal(current.sessionCiphertext, null); assert.equal((await f.agents.getAgentById(f.agent.id))?.status, "revoked"); }
  else assert.equal(current.probe?.firstUAtMs, null);
});

for (const verification of ["U", "CONNECTED", "unreachable", "max-time", "missing-max"])
  test("Agentic logout " + verification + " preserves the retry credential until positive proof", async t => {
    const f = await fixture(t, { state: "ending", hireEndMs: NOW - 86_400_000, endStage: "signout-attempted" });
    const current = (await f.store.byAgent(f.agent.id))!;
    if (verification === "missing-max") { const corrupt = { ...current, hireFacts: { ...current.hireFacts!, signInMaxTimeMs: NaN } }; t.mock.method(f.store, "getWallet", async () => corrupt); await resumeAgenticEnding(f.lifecycle, corrupt); assert.equal((await f.store.wallets())[0]!.state, "ending"); return; }
    if (verification === "max-time") f.setTime(current.hireFacts!.signInMaxTimeMs);
    f.runner.replies.set("wallet status", verification === "unreachable" ? { kind: "no-response", code: "timeout", sessionPresent: true }
      : { kind: "ok", data: { status: verification === "U" ? "UNCONNECTED" : "CONNECTED" }, sessionPresent: true, rwaTokens: null });
    await resumeAgenticEnding(f.lifecycle, current);
    const result = (await f.store.byAgent(f.agent.id))!;
    assert.equal(result.state, verification === "U" || verification === "max-time" ? "ended" : "ending");
    assert.equal(result.sessionCiphertext === null, verification === "U" || verification === "max-time");
    if (verification === "CONNECTED" || verification === "unreachable") { const calls = f.runner.calls.length; await resumeAgenticEnding(f.lifecycle, result); assert.equal(f.runner.calls.length, calls); f.setTime(NOW + 600_000); await resumeAgenticEnding(f.lifecycle, result); assert.ok(f.runner.calls.length > calls); }
  });

test("Agentic system settings hold blocks every side and auto-clears without clearing entries-stopped", async t => {
  const f = await fixture(t), fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  f.runner.replies.set("wallet settings", { kind: "ok", data: { ...settingsOutput(), tradeAllTokens: false }, sessionPresent: true, rwaTokens: null });
  assert.equal(await readAgenticSettings(f.execution, f.agent.id, fence), null); assert.equal((await f.store.byAgent(f.agent.id))?.settingsHold?.code, "trade-all-tokens");
  assert.equal((await executeAgenticTrade(f.input, f.execution)).kind, "denied");
  const row = (await f.store.byAgent(f.agent.id))!; await f.store.patchWallet(row, { entriesStopped: { reason: "fill-below-minimum", out: "1", min: "2", atMs: NOW } });
  f.runner.replies.delete("wallet settings"); assert.ok(await readAgenticSettings(f.execution, f.agent.id, fence));
  assert.ok((await f.store.byAgent(f.agent.id))?.settingsHold);
  await f.store.releaseFence(fence); await runAgenticCycle(f.lifecycle);
  assert.equal((await f.store.byAgent(f.agent.id))?.settingsHold, null); assert.ok((await f.store.byAgent(f.agent.id))?.entriesStopped);
});

test("Agentic fill commit repairs the journal-first crash and stops entries on a breached buy", async t => {
  const f = await fixture(t), order = f.order({ dispatch: "spawned", response: "accepted", claimant: f.instance.row.instanceId, minOutAtomic: (6n * E).toString() });
  await f.store.createOrder(order); await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade" }); await f.journal.markCommitted(HASH, { txHash: HASH });
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  assert.ok(await resolveAgenticOrder({ ...f.execution, journal: f.journal, order, fence }));
  assert.equal((await f.store.getOrder(HASH))?.fillCheck, "breached"); assert.ok((await f.store.byAgent(f.agent.id))?.entriesStopped);
  assert.equal((await f.positions.listRuns(W, f.agent.id))[0]?.events?.[0]?.reason, `out=${5n * E} min=${6n * E}`);
  assert.equal(f.runner.calls.length, 0);
});

test("Agentic hire binds the original body, resumes every stored stage and initializes CMC generation zero", async t => {
  const f = await fixture(t, { state: "paired", hireFacts: null, hireOpId: null, agentId: null, hireStage: null, acceptedAt: null, hireEndMs: null, entryCutoffMs: null, termEndAction: null });
  const body = { ...f.row.hireParams!, pairingId: f.row.pairingId };
  const identity = agenticHireIdentity(body);
  const hired = await f.pairings.hire(f.row, body);
  assert.equal(hired.state, "bound"); assert.equal(hired.agentId, identity.agentId); assert.equal(hired.acceptedAt, NOW);
  assert.equal((await f.agents.getAgentById(hired.agentId!))?.sessionFacts, null);
  assert.equal((await f.cmcStore.get(hired.agentId!, W))?.generation, 0);
  assert.equal((await f.pairings.hire(hired, body)).state, "bound");
  await assert.rejects(() => f.pairings.hire(hired, { ...body, termEndAction: "sell-all" }), /conflict/);
  assert.equal(hired.hireFacts!.termEndAction, "keep");
});

test("Agentic finalize returns raw facts, replays after lost response and never extends admission", async t => {
  const f = await fixture(t, { state: "verified", hireOpId: null, agentId: null, hireFacts: null });
  const paired = await f.pairings.finalize(f.row), calls = f.runner.calls.length;
  assert.equal(paired.state, "paired"); assert.equal(paired.factsRead?.dailyLimit, 1000);
  assert.equal((await f.pairings.finalize(paired)).continuationDeadline, f.row.continuationDeadline); assert.equal(f.runner.calls.length, calls);
  f.setTime(f.row.continuationDeadline!); await assert.rejects(() => f.pairings.finalize(paired));
  await f.pairings.sweep(); assert.equal((await f.store.getWallet(f.row.pairingId))?.sessionCiphertext, null);
});

test("Agentic finalized facts refresh only after one minute without extending admission", async t => {
  const f = await fixture(t, { state: "verified" });
  const paired = await f.pairings.finalize(f.row), calls = f.runner.calls.length;
  f.setTime(NOW + 59_999); await f.pairings.finalize(paired); assert.equal(f.runner.calls.length, calls);
  f.chain.balance = async () => 12n * E;
  f.setTime(NOW + 60_000); const refreshed = await f.pairings.finalize(paired);
  assert.equal(refreshed.factsRead?.readAtMs, NOW + 60_000); assert.equal(refreshed.factsRead?.usdtWei, (12n * E).toString());
  assert.equal(refreshed.continuationDeadline, paired.continuationDeadline); assert.equal(f.runner.calls.length, calls + 2);
});

for (const reason of ["gate-rows", "sizing", "pin-unavailable", "pinned-empty", "pin-error", "settings-unreadable", "wallet-busy", "pending-orders", "limit-orders"]) {
  test("Agentic hire returns and retains closed diagnostic " + reason, async t => {
    const f = await fixture(t, { state: "paired", hireOpId: null, agentId: null, hireParams: null, hireFacts: null, hireStage: null, acceptedAt: null });
    let row = (await f.store.patchWallet(f.row, { pairingSecretHash: createHash("sha256").update(SECRET).digest("hex"), factsRead: await f.pairings.facts(f.row) }))!;
    const body = { pairingId: row.pairingId, term: 7, termEndAction: "keep", executionModel: "tradfi", hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings: { ...params } };
    if (reason === "sizing") { body.settings.capitalQuoteWei = (10n * E).toString(); body.settings.entryWei = (8n * E).toString(); }
    if (reason === "gate-rows") f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { tradeAllTokens: false, abnormalTxnHandling: "AutoReject", dailyLimit: 1000, quotaUsed: 0, x402DailyLimit: 1, x402QuotaUsed: 0, signInMaxTime: new Date(NOW + 90 * 86_400_000).toISOString() } });
    if (reason === "settings-unreadable") t.mock.method(f.pairings, "facts", async () => { throw new Error("AGENTIC_SETTINGS_UNREADABLE"); });
    if (reason === "wallet-busy") t.mock.method(f.store, "acquireFence", async () => null);
    if (reason === "pending-orders" || reason === "limit-orders") f.runner.replies.set(reason === "pending-orders" ? "market-order list" : "limit-order list", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: 1, page: 1, pageSize: 100, list: [] } });
    const logs: unknown[][] = []; t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    const app = new Hono(); registerAgenticRoutes(app, f.pairings, async () => {
      if (reason === "pin-error") throw new Error("private-upstream-text");
      return reason === "pinned-empty" ? [] : [TOKEN];
    });
    if (reason === "pin-unavailable") f.pairings.pin = null;
    const response = await app.request("/agentic/hire", { method: "POST", headers: { "content-type": "application/json", origin: "https://4lpha.test", "x-agentic-pairing": row.pairingId + "." + SECRET }, body: JSON.stringify(body) });
    assert.equal(response.status, 409);
    const result = await response.json() as { meta: { reason: string; gate: { code: string; state: string }[] } };
    assert.equal(result.meta.reason, reason, JSON.stringify(result)); assert.equal(result.meta.gate.length, 10);
    // wallet-busy means another request owns the pairing: the error path reports it but never writes the row.
    row = (await f.store.getWallet(row.pairingId))!; assert.equal(row.failure, reason === "wallet-busy" ? null : reason);
    assert.deepEqual(logs, [["agentic_hire_refused", reason]]);
    assert.equal(JSON.stringify(result).includes("private-upstream-text"), false);
    if (reason === "sizing") assert.equal(result.meta.gate.find(r => r.code === "sizing")?.state, "FAIL");
  });
}

test("TRADFI-EXIT-RULES review H1: the public view keeps the two rule close reasons instead of coercing them to other", async t => {
  const f = await fixture(t);
  for (const reason of ["trailing-stop", "stale-exit"] as const) {
    await f.positions.open({ positionId: reason, agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: E, tokenAmount: E, fillStatus: "verified", openedAt: NOW });
    await f.positions.closePosition({ ownerAddress: W, agentId: f.agent.id, positionId: reason, exitWei: E, reason });
  }
  const view = createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore, killswitch: f.killswitch, observer: { observe: async () => [] } });
  const reasons = (await view(W)).agent?.positions.map(p => p.closeReason).sort();
  assert.deepEqual(reasons, ["stale-exit", "trailing-stop"]);
});

test("Agentic public view is closed and per-position durable reasons survive later events and orphaning", async t => {
  const f = await fixture(t, { state: "ended", termEndAction: "sell-all", drainRequestedAt: NOW - 1000, endReason: "term-ended",
    endBlockers: { atMs: NOW, settingsHold: false, paused: false, halted: false, heldObligations: 0 } });
  for (const [id, refusal] of [["one", "AGENTIC_QUOTE_BELOW_MIN"], ["two", "AGENTIC_LOW_BNB"]]) {
    await f.positions.open({ positionId: id!, agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: E, tokenAmount: E, fillStatus: "verified", openedAt: NOW });
    await f.positions.recordSellRefusal({ ownerAddress: W, agentId: f.agent.id, positionId: id!, refusal: refusal! });
  }
  for (const p of await f.positions.listOpen(W, f.agent.id)) await f.positions.markOrphaned(W, f.agent.id, p.positionId);
  for (let i = 0; i < 55; i += 1) await f.positions.insertRun({ agentId: f.agent.id, ownerAddress: W, dryRun: false, reason: "private reason", events: [{ stage: "cycle", code: "private-code", elapsedMs: 0, reason: "private-text" }] });
  await f.cmcStore.claimNewsSlot({ agentId: f.agent.id, ownerAddress: W, operationId: "private-op", nowMs: NOW });
  await f.cmcStore.reserve({ agentId: f.agent.id, ownerAddress: W, wallet: W, operationId: "private-op", attemptId: "private-attempt", amountWei: CMC_PRICE_ATOMIC });
  await f.cmcStore.putNews({ agentId: f.agent.id, ownerAddress: W, ticker: "NVDAB", skill: CMC_SKILL_SECTOR, generation: 0, status: "available", context: "ctx", sourceUrl: null, publishedAtMs: null,
    payloadHash: null, paymentOperationId: "private-op", asOfMs: NOW, expiresAtMs: NOW + 1000 });
  const view = createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore, killswitch: f.killswitch, observer: { observe: async () => [] } });
  const publicRow = await view(W), serialized = JSON.stringify(publicRow);
  assert.equal(publicRow.agent?.events.length, 50); assert.equal(publicRow.agent?.positions.every(p => p.status === "kept"), true);
  assert.deepEqual(new Set(publicRow.agent?.positions.map(p => p.unsold?.code)), new Set(["quote-below-minimum", "insufficient-bnb"]));
  for (const text of [f.agent.id, f.row.pairingId, "private-text", "private reason", "positionId", "nonce", "sessionCiphertext", "private-op", "private-attempt", "decisionId", "hireOpId"]) assert.equal(serialized.includes(text), false, text);
  const hashed = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16), log = publicRow.agent!.cmcLog;
  assert.equal(log.attempts[0]?.operationId, hashed("private-op")); assert.equal(log.attempts[0]?.attemptId, hashed("private-attempt")); assert.equal(log.news[0]?.paymentOperationId, hashed("private-op"));
  assert.deepEqual(f.runner.calls, []);
  const p = (await f.positions.list(W, f.agent.id))[0]!;
  for (const dispatch of ["unclaimed", "sealed", "not-started"] as const) assert.notEqual(agenticUnsold(f.row, p, f.order({ side: "sell", dispatch }))?.code, "sale-unresolved");
  assert.equal(agenticUnsold({ ...f.row, endReason: "owner-signed-out", termEndAction: "keep" }, p, f.order({ side: "sell", dispatch: "spawned", claimedAt: NOW }))?.code, "sale-unresolved");
});

test("Agentic gate allowlist, custody, exit ownership, deadlines and concurrent counters are confined", async t => {
  const f = await fixture(t); assert.throws(() => agenticGateWallets(undefined)); assert.throws(() => agenticGateWallets(""));
  let cycles = 0; const printed: unknown[] = [];
  const context = { ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets: new Set([W]),
    print: (value: unknown) => printed.push(value), cycle: async () => { cycles += 1; } };
  await runAgenticGate(parseAgenticGateArgs(["run-start", "--gate", "G4", "--agent", f.agent.id, "--side", "none", "--max-dispatches", "0", "--max-notional-usdt", "0", "--max-cmc-payments", "0", "--deadline-min", "15"]), context);
  const run = printed[0] as { runId: string };
  for (let i = 0; i < 3; i += 1) await runAgenticGate(parseAgenticGateArgs(["cycle-once", "--run", run.runId, "--yes-live"]), context);
  assert.equal(cycles, 3); assert.equal(await f.store.consumeRun(run.runId, "dispatch"), false); assert.equal(await f.store.consumeRun(run.runId, "cmc"), false);
  const one = { ...(await f.store.getRun(run.runId))!, runId: "one", maxDispatches: 1, maxCmcPayments: 1 }; await f.store.createRun(one);
  assert.deepEqual((await Promise.all(Array.from({ length: 3 }, () => f.store.consumeRun("one", "dispatch")))).sort(), [false, false, true]);
  assert.equal(await f.store.consumeRun("one", "dispatch"), false); assert.equal(await f.store.consumeRun("one", "cmc"), true); assert.equal(await f.store.consumeRun("one", "cmc"), false);
  await f.store.closeRun(run.runId); await assert.rejects(() => runAgenticGate(parseAgenticGateArgs(["cycle-once", "--run", run.runId, "--yes-live"]), context));
  await assert.rejects(() => runAgenticGate(parseAgenticGateArgs(["status", "--agent", f.agent.id]), { ...context, wallets: new Set([TOKEN]) }));
  await assert.rejects(() => runAgenticGate(parseAgenticGateArgs(["request-exit", "--agent", f.agent.id, "--position-index", "0", "--yes-live"]), context));
});

test("Agentic instance quiescence requires the whole capability, never a heartbeat or parent-only claim", async t => {
  const f = await fixture(t), instance = { ...f.instance.row, railwayDeploymentId: "deployment-one" };
  for (const proof of [{}, { deploymentStopped: "other", attest: "removed" }, { attest: "parent ended" }]) assert.equal(agenticQuiescence(instance, NOW, { machineId: "offline-machine", osBootMarker: "offline-boot" }, proof), null);
  assert.ok(agenticQuiescence(instance, NOW, { machineId: null, osBootMarker: null }, { deploymentStopped: "deployment-one", attest: "recorded deployment REMOVED" }));
  assert.ok(agenticQuiescence({ ...instance, retiredBy: "exit" }, NOW, { machineId: null, osBootMarker: null }, {}));
  let killed = false, exit: number | null = null; t.mock.method(f.runner, "killChildren", () => { killed = true; });
  const manager = await AgenticInstanceManager.start(f.store, f.runner, "agentic-gate", null, { RAILWAY_DEPLOYMENT_ID: "deployment" }, code => { exit = code; });
  await f.store.retire(manager.row.instanceId, "dispose"); await manager.heartbeat(); assert.equal(killed, true); assert.equal(exit, 70); assert.equal(manager.canClaim, false); await manager.finish();
  await assert.rejects(() => AgenticInstanceManager.start(f.store, f.runner, "trade-worker", null, {}), /HOST_IDENTITY/);
  f.instance.beginDispatch(); const ending = f.instance.finish(); await Promise.resolve(); assert.notEqual((await f.store.getInstance(f.instance.row.instanceId))?.retiredBy, "exit");
  f.instance.endDispatch(); await ending; assert.equal((await f.store.getInstance(f.instance.row.instanceId))?.retiredBy, "exit");
});

test("Agentic paired routes require the matching secret and exact body while start needs only the perimeter", async t => {
  const f = await fixture(t, { state: "verified", hireOpId: null, agentId: null, hireFacts: null });
  let row = (await f.store.getWallet(f.row.pairingId))!;
  row = (await f.store.patchWallet(row, { pairingSecretHash: createHash("sha256").update(SECRET).digest("hex"), codeHash: createHash("sha256").update("abcdef").digest("hex"), codeMatchedAt: null }))!;
  const app = new Hono();
  app.use("*", async (c, next) => c.req.header("x-exec-token") === EXEC_TOKEN ? next() : c.json({ error: "unauthorized" }, 401));
  registerAgenticRoutes(app, f.pairings, async () => [TOKEN]);
  const headers = { "x-exec-token": EXEC_TOKEN, "content-type": "application/json", origin: "https://4lpha.test" };
  for (const [method, path, body] of [["GET", `pairings/${row.pairingId}`, null], ["POST", `pairings/${row.pairingId}/code`, { code: "ABC DEF" }], ["POST", `pairings/${row.pairingId}/finalize`, {}], ["POST", "hire", row.hireParams]] as const) {
    const send = (credential?: string) => app.request("/agentic/" + path, { method, headers: { ...headers, ...(credential === undefined ? {} : { "x-agentic-pairing": credential }) }, ...(body === null ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await send()).status, 401); assert.equal((await send("foreign." + SECRET)).status, 404);
  }
  const response = await app.request(`/agentic/pairings/${row.pairingId}/code`, { method: "POST", headers: { ...headers, "x-agentic-pairing": row.pairingId + "." + SECRET }, body: JSON.stringify({ code: "ABC DEF" }) });
  assert.equal(response.status, 200); assert.ok((await f.store.getWallet(row.pairingId))?.codeMatchedAt);
  const final = await app.request(`/agentic/pairings/${row.pairingId}/finalize`, { method: "POST", headers: { ...headers, "x-agentic-pairing": row.pairingId + "." + SECRET }, body: "{}" });
  assert.equal(final.status, 200); assert.equal((await final.text()).includes("gate"), false);
  assert.equal((await app.request("/agentic/pairings", { method: "POST", headers: { ...headers, origin: "https://evil.test" }, body: "{}" })).status, 403);
  assert.equal((await app.request("/agentic/pairings", { method: "POST", headers, body: "{}" })).status, 201);
});

for (const state of ["waiting", "verified"] as const) test("Agentic code proof before/after verification and fifth mismatch cleanup " + state, async t => {
  const f = await fixture(t, { state, hireOpId: null, agentId: null, hireFacts: null, codeMatchedAt: null });
  let row = (await f.store.patchWallet(f.row, { codeHash: createHash("sha256").update("abcdef").digest("hex") }))!;
  for (let i = 0; i < 5; i += 1) { await assert.rejects(() => f.pairings.code(row, "123456"), { message: i === 4 ? "pairing_code_attempts" : "pairing_code_mismatch" }); row = (await f.store.getWallet(row.pairingId))!; }
  assert.equal(row.codeAttempts, 5); assert.equal(row.state, "failed"); assert.equal(row.sessionCiphertext, null);
  if (state === "verified") assert.equal(f.runner.calls.at(-1)?.join(" "), "auth signout");
});

test("Agentic matched code checks are idempotent after the fifth attempt and expiry", async t => {
  const f = await fixture(t, { state: "verified", codeMatchedAt: null, codeAttempts: 4 });
  const row = (await f.store.patchWallet(f.row, { codeHash: createHash("sha256").update("abcdef").digest("hex") }))!;
  await f.pairings.code(row, "ABC DEF");
  const matched = (await f.store.getWallet(row.pairingId))!;
  assert.equal(matched.codeAttempts, 5); assert.equal(matched.codeMatchedAt, NOW);
  f.setTime(NOW + 120_000);
  for (const state of ["waiting", "verified", "paired"] as const) await f.pairings.code({ ...matched, state }, "invalid");
  assert.deepEqual(await f.store.getWallet(row.pairingId), matched);
});

for (const condition of ["attempts", "expired", "not-ready"] as const) test("Agentic code route exposes distinct " + condition + " refusal", async t => {
  const expected = condition === "attempts" ? "pairing_code_attempts" : condition === "expired" ? "pairing_code_expired" : "pairing_not_ready";
  const f = await fixture(t, { state: condition === "not-ready" ? "paired" : "verified", codeMatchedAt: null,
    codeAttempts: condition === "attempts" ? 5 : 0 });
  const row = (await f.store.patchWallet(f.row, { pairingSecretHash: createHash("sha256").update(SECRET).digest("hex"),
    codeHash: createHash("sha256").update("abcdef").digest("hex") }))!;
  if (condition === "expired") f.setTime(NOW + 120_000);
  const app = new Hono(); registerAgenticRoutes(app, f.pairings, async () => [TOKEN]);
  const response = await app.request(`/agentic/pairings/${row.pairingId}/code`, { method: "POST",
    headers: { "content-type": "application/json", origin: "https://4lpha.test", "x-agentic-pairing": row.pairingId + "." + SECRET }, body: JSON.stringify({ code: "abcdef" }) });
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { data: null, error: { code: expected } });
  assert.deepEqual(await f.store.getWallet(row.pairingId), row);
});

test("Agentic sweeper expires waiting at boot and releases all eight abandoned slots", async t => {
  const f = await fixture(t, { state: "waiting", hireOpId: null, agentId: null, hireFacts: null });
  for (let i = 1; i < 8; i += 1) assert.equal(await f.store.createWallet({ ...f.row, pairingId: "slot" + i }), true);
  assert.equal(await f.store.createWallet({ ...f.row, pairingId: "overflow" }), false);
  await f.pairings.start(); assert.equal((await f.store.wallets()).every(w => w.state === "expired"), true);
  assert.equal(await f.store.createWallet({ ...f.row, pairingId: "recovered" }), true);
});

for (const reason of ["wallet_has_code", "wallet_in_use", "historical-intent", "transmitting", "pending-fill"])
  test("Agentic admission rejects " + reason, async t => {
    const f = await fixture(t, reason === "wallet_in_use" ? {} : { state: "ended", sessionCiphertext: null });
    if (reason === "wallet_has_code") f.chain.code = async () => "0x1234";
    if (reason === "historical-intent") await f.intents.create({ decisionId: "old", idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, side: "buy", token: TOKEN, amountWei: E, entryWei: E, route: { hops: [], fees: [] }, positionId: "p", closeReason: null });
    if (reason === "pending-fill") await f.store.createOrder(f.order({ outcome: "committed", fillCheck: "pending" }));
    if (reason === "transmitting") {
      await f.cmcStore.claimNewsSlot({ agentId: f.agent.id, ownerAddress: W, operationId: "op", nowMs: NOW });
      await f.cmcStore.reserve({ agentId: f.agent.id, ownerAddress: W, wallet: W, operationId: "op", attemptId: "a", amountWei: CMC_PRICE_ATOMIC });
      await f.cmcStore.prepare({ agentId: f.agent.id, ownerAddress: W, wallet: W, operationId: "op", generation: 0, sessionPublicKey: projectAgenticSessionFacts(f.row).publicKey,
        sessionExpiry: Math.floor(f.row.hireEndMs! / 1000), asset: USDT_56, amountWei: CMC_PRICE_ATOMIC, spender: CMC_SPENDER, payee: CMC_PAYEE,
        nonce: 1n, witnessTo: CMC_PAYEE, validAfter: 0n, deadline: BigInt(NOW / 1000 + 500), requestDigest: HASH, bodyHash: HASH });
      await f.cmcStore.transition({ agentId: f.agent.id, ownerAddress: W, operationId: "op", generation: 0, from: "prepared", to: "transmitting" });
    }
    assert.equal(await f.pairings.admission(W), reason.startsWith("wallet_") ? reason : "wallet_obligations");
  });

test("Agentic rehire can admit a revoked historical hire after every obligation clears", async t => {
  const f = await fixture(t, { state: "ended", sessionCiphertext: null });
  await f.agents.transitionAgentStatus({ ownerAddress: W, agentId: f.agent.id, expectedStatus: "armed", expectedRowVersion: f.agent.rowVersion, status: "revoked" });
  assert.equal(await f.pairings.admission(W), "");
});

for (const stage of ["accepted", "gated", "agent-created", "settings-stored", "cmc-initialized"])
  test("Agentic hire crash resumption at " + stage, async t => {
    const f = await fixture(t, { state: "hiring", hireStage: stage, ...(stage === "accepted" ? { hireFacts: null } : {}) });
    const row = await f.pairings.resumeHire(f.row);
    assert.equal(row.state, "bound"); assert.equal(row.hireStage, "active");
    assert.equal((await f.cmcStore.get(row.agentId!, W))?.generation, 0);
  });

test("Agentic gate failure first enters cleaning and cleanup never reruns admission", async t => {
  const f = await fixture(t, { state: "hiring", hireStage: "accepted", hireFacts: null });
  f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { ...settingsOutput(), tradeAllTokens: false } });
  await assert.rejects(() => f.pairings.resumeHire(f.row));
  let row = (await f.store.getWallet(f.row.pairingId))!; assert.equal(row.state, "cleaning");
  f.runner.replies.set("auth signout", { kind: "no-response", code: "timeout", sessionPresent: true });
  const reads = f.runner.calls.filter(a => a[1] === "settings").length;
  await f.pairings.cleanup(row, "gate-failed"); row = (await f.store.getWallet(row.pairingId))!;
  assert.equal(row.sessionCiphertext, null); assert.equal(row.state, "failed"); assert.equal(f.runner.calls.filter(a => a[1] === "settings").length, reads);
});

for (const mode of ["accepted", "not-started", "no-response", "late-claim", "late-disposed"])
  test("Agentic executor dispatch lifecycle " + mode, async t => {
    const f = await fixture(t); let dispatched = false;
    f.runner.replies.set("market-order list", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: dispatched ? 1 : 0, page: 1, pageSize: 100,
      list: dispatched ? [{ orderId: "listed-offset-id", status: "FINISHED", txHash: HASH }] : [] } }));
    f.runner.replies.set("market-order swap", async () => {
      assert.equal(f.instance.inFlight, 1); assert.equal((await f.store.getOrder(HASH))?.dispatch, "spawned"); dispatched = true;
      return mode === "not-started" ? { kind: "not-started", sessionPresent: true } : mode === "no-response" ? { kind: "no-response", code: "timeout", sessionPresent: true }
        : { kind: "ok", data: { orderId: "json-offset-id" }, sessionPresent: true, rwaTokens: null };
    });
    if (mode.startsWith("late")) {
      let clock = process.hrtime.bigint(); t.mock.method(process.hrtime, "bigint", () => clock);
      const claim = f.store.claimOrder.bind(f.store);
      t.mock.method(f.store, "claimOrder", async (...args: Parameters<AgenticStore["claimOrder"]>) => {
        assert.equal(f.instance.inFlight, 1); const row = await claim(...args); clock += 6_000_000_000n;
        if (mode === "late-disposed" && row !== null) await f.store.patchOrder(row, { outcome: "rolled-back" });
        return row;
      });
    }
    const result = await executeAgenticTrade(f.input, f.execution), order = await f.store.getOrder(HASH);
    assert.equal(f.instance.inFlight, 0);
    if (mode === "accepted") { assert.equal(result.kind, "committed"); assert.equal(order?.listedOrderId, "listed-offset-id"); assert.equal(order?.returnedOrderId, "json-offset-id"); assert.equal(order?.fillCheck, "ok");
      const ref = (await f.journal.get(HASH))!.externalRef; assert.equal(ref.publicKey, undefined); assert.equal(ref.callsId, undefined); assert.equal(ref.quoteSpendWei, (5n * E).toString()); }
    if (mode === "no-response") { assert.equal(result.kind, "unknown"); assert.equal(order?.outcome, "open"); assert.equal(order?.holdReason, "no-response"); }
    if (mode === "not-started") { assert.equal(result.kind, "rolled-back"); assert.equal(order?.dispatch, "not-started"); }
    if (mode.startsWith("late")) { assert.equal(dispatched, false); assert.equal(order?.outcome, "rolled-back");
      assert.equal(result.kind, mode === "late-disposed" ? "unknown" : "rolled-back"); }
  });

for (const refusal of ["low-bnb", "low-usdt", "amount", "settings", "snapshot", "quote-below", "quote-headroom", "settings-hold", "drained", "entries-stopped", "daily-quota", "scan"])
  test("Agentic executor has no swap argv on " + refusal, async t => {
    const f = await fixture(t, refusal === "settings-hold" ? { settingsHold: { code: "daily-limit", atMs: NOW } } : refusal === "drained" ? { drainRequestedAt: NOW }
      : refusal === "entries-stopped" ? { entriesStopped: { reason: "fill-below-minimum", out: "1", min: "2", atMs: NOW } } : {});
    if (refusal === "low-bnb") f.chain.balance = async (_w, token) => token === null ? 0n : 100n * E;
    if (refusal === "low-usdt") f.chain.balance = async (_w, token) => token === null ? E : 0n;
    if (refusal === "amount") f.chain.metadata = async () => ({ decimals: 6, symbol: "BAD" });
    if (refusal === "settings") f.runner.replies.set("wallet settings", { kind: "no-response", code: "unparseable", sessionPresent: true });
    if (refusal === "daily-quota") f.runner.replies.set("wallet settings", { kind: "ok", data: { ...settingsOutput(), quotaUsed: 999 }, sessionPresent: true, rwaTokens: null });
    if (refusal === "snapshot") f.runner.replies.set("market-order list", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: 501, page: 1, pageSize: 100, list: [] } });
    if (refusal === "quote-below" || refusal === "quote-headroom") f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null,
      data: { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: refusal === "quote-below" ? "4" : "4.9", slippage: "0" } });
    const result = await executeAgenticTrade({ ...f.input, scanGate: refusal === "scan" ? { evaluate: async () => ({ verdict: "deny", reasons: [] }) } : f.input.scanGate }, f.execution);
    assert.notEqual(result.kind, "committed"); assert.equal(f.runner.calls.some(a => a[1] === "swap"), false);
  });

for (const backend of ["memory", "postgres"] as const) test("Agentic quote cap counts 25 buys, refuses 26, and rollback releases it: " + backend, async () => {
  class QuoteSql extends FakeSqlClient {
    keys = new Set<string>();
    override async query<Row>(text: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      if (text.includes("journal.beginInsert")) this.keys.add(String(values[0]));
      if (text.includes("journal.sumQuoteSpend")) {
        assert.match(text, /state in \('PENDING','IN_PROGRESS','COMMITTED'\)/); assert.match(text, /created_at >= \$2 and idempotency_key <> \$3/);
        let total = 0n;
        for (const key of this.keys) {
          const row = (await super.query<Record<string, unknown>>("/* journal.get */", [key])).rows[0];
          if (row === undefined || row["agent_id"] !== values[0] || key === values[2] || !["PENDING", "IN_PROGRESS", "COMMITTED"].includes(String(row["state"])) || (row["created_at"] as Date).getTime() < (values[1] as Date).getTime()) continue;
          const ref = row["external_ref"] as Record<string, string>; total += BigInt(ref["actualQuoteSpendWei"] ?? ref["quoteSpendWei"] ?? "0");
        }
        return { rows: [{ total: total.toString() }] as unknown as Row[] };
      }
      return super.query<Row>(text, values);
    }
  }
  const journal = backend === "memory" ? new MemoryExecutionJournal(() => NOW) : await PostgresExecutionJournal.create(new QuoteSql(), () => NOW);
  for (let n = 1; n <= 26; n += 1) {
    const key = "buy-" + n, amount = 20n * E;
    const result = await journal.beginWithSpend({ idempotencyKey: key, agentId: "cap-agent", ownerAddress: W, kind: "trade", decisionId: key,
      externalRef: { quoteSpendWei: amount.toString() }, nativeSpendWei: 0n, quoteSpendWei: amount }, NOW - 86_400_000);
    assert.equal((result.otherQuoteSpendWei ?? 0n) + amount > 500n * E, n === 26);
    if (n === 26) await journal.markRolledBack(key, "QUOTE_DAILY_CAP"); else await journal.markCommitted(key, {});
  }
  await journal.markRolledBack("buy-26", "QUOTE_DAILY_CAP");
  const result = await journal.beginWithSpend({ idempotencyKey: "replacement", agentId: "cap-agent", ownerAddress: W, kind: "trade", externalRef: { quoteSpendWei: (20n * E).toString() }, nativeSpendWei: 0n, quoteSpendWei: 20n * E }, NOW - 86_400_000);
  assert.equal(result.otherQuoteSpendWei, 500n * E);
});

test("Agentic journal/order insertion rolls back both halves on a Postgres insert failure", async t => {
  const f = await fixture(t);
  class BrokenInsert extends FakeSqlClient {
    override async query<Row>(text: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      if (text.startsWith("insert into agentic_orders")) throw new Error("offline insert failure"); return super.query<Row>(text, values);
    }
  }
  const sql = new BrokenInsert(), journal = await PostgresExecutionJournal.create(sql, () => NOW), store = new AgenticStore(sql, { agents: f.agents, journal, intents: f.intents, cmc: f.cmcStore, killswitch: f.killswitch }, () => NOW);
  await assert.rejects(() => store.beginSwap(f.order(), { idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade", decisionId: "decision", nativeSpendWei: 0n }, NOW));
  assert.equal(await journal.get(HASH), null);
});

test("Agentic sign lease needs 75 seconds and payment checks reject a 29-second lease", async t => {
  const f = await fixture(t), order = f.order({ kind: "x402-sign", side: null, operationId: "op" }); await f.store.createOrder(order);
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  f.setTime(NOW + 45_001); await f.store.heartbeat(f.instance.row.instanceId); assert.equal(await f.store.claimOrder(order, fence), null);
  f.setTime(NOW + 90_001); await f.store.heartbeat(f.instance.row.instanceId); assert.equal(await f.store.payCheck(f.agent.id, fence, undefined, order.idempotencyKey), false);
});

test("Agentic Altana routes hide the same-owner Agentic id under every existing auth kind with the flag off", async t => {
  const agents = new MemoryAgentStore(null, () => NOW);
  await agents.createAgent({ id: "agentic-route", ownerAddress: ownerAccount.address, walletAddress: ownerAccount.address, custodyModel: "binance-agentic", status: "armed" });
  const durable = new Proxy(agents, { get(target, key): unknown { if (key === "durable" || key === "keyEncryptionConfigured") return true;
    const value: unknown = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  const h = await createHarness({ seedAgent: false, agentStore: altanaAgentStore(durable), config: { chainId: 56, network: "mainnet", tradeAgentEnabled: true, hireEnabled: true,
    passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true }, rateLimit: { capacity: 10_000, refillPerSecond: 10_000 } },
    hire: { nfpm: TOKEN, routerV3: TOKEN, wbnb: TOKEN, treasury: TOKEN, feeBps: 0, relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 1n,
      evidence: { readFunding: async () => { throw new Error("Unexpected funding"); }, readGrant: async () => { throw new Error("Unexpected grant"); } } } });
  const read = await signOwnerAction("read", {}, { agentId: "agentic-route", chainId: 56, network: "mainnet" });
  const runtime = await signRuntimeRequest(h, "agentic-route", "agentRead", {}, { owner: ownerAccount.address, profile: "unbound-v1" });
  const kinds = [{ "x-exec-token": EXEC_TOKEN }, { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(read) },
    { "x-exec-token": EXEC_TOKEN, "x-runtime-assertion": runtime }, { "x-exec-token": EXEC_TOKEN, "x-owner-read-session": "offline-cookie" }];
  const seen = new Set<string>();
  for (const route of h.app.routes) if (route.path.includes(":id")) {
    const path = route.path.replaceAll(":id", "agentic-route").replace(/:[A-Za-z]+/g, "0");
    const method = route.method === "ALL" ? "GET" : route.method;
    if (seen.has(method + path)) continue; seen.add(method + path);
    for (const headers of kinds) {
      const response = await h.app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
      assert.ok(response.status >= 300, `${method} ${path} ${response.status}`);
    }
  }
  assert.ok(seen.size > 20); assert.equal(h.provider.executeCalls.length, 0); assert.equal(h.provider.restoreCalls.length, 0);
  assert.equal((await h.app.request("/agentic/wallets/" + W, { headers: { "x-exec-token": EXEC_TOKEN } })).status, 404);
  t.after(() => agents.close());
});

for (const result of ["signed", "approve-success", "approve-revert", "approve-timeout", "timeout", "error", "unparseable", "pause-before-disclosure", "quota", "no-cmc-slot", "wrong-method", "approve-null", "short-hash", "valid-after-now", "short-challenge", "short-challenge-late", "long-challenge-late"])
  test("Agentic CMC complete runtime " + result, async t => {
    t.mock.method(Date, "now", () => NOW);
    const f = await fixture(t); let paid = 0, preview = 0, signs = 0;
    const transport: CmcTransport = { async request(request) {
      if (request.headers === undefined) {
        const body = JSON.parse(request.body) as { params: { name: string } };
        const challenge = { x402Version: 2, resource: { url: "X402_" + body.params.name }, accepts: [{ scheme: "exact", network: "eip155:56", asset: USDT_56,
          amount: CMC_PRICE_ATOMIC.toString(), payTo: CMC_PAYEE, maxTimeoutSeconds: result.startsWith("short-challenge") ? 30 : 500,
          extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", spenderAddress: CMC_SPENDER, signerAddress: CMC_SIGNER, x402PaymentConfigId: CMC_CONFIG_ID } }] };
        return { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") }, body: "" };
      }
      paid += 1; return { status: 200, headers: {}, body: JSON.stringify({ result: { content: [] } }) };
    } };
    await f.store.createRun({ runId: "cmc-run", gate: "G0", agentId: f.agent.id, wallet: W, side: "none", maxDispatches: 1, dispatches: 0,
      maxNotionalUsdt: "0", maxCmcPayments: result === "no-cmc-slot" ? 0 : 1, cmcPayments: 0, cmcOperationIds: [], deadlineMs: NOW + 900_000, createdAt: NOW, closedAt: null });
    f.runner.replies.set("x402-payment preview", async () => { preview += 1; return { kind: "ok", sessionPresent: true, rwaTokens: null, data: { paymentId: "offline-payment",
      // The option shape measured live at G0 (2026-10-03): method "permit2", 18-decimal amount string, approve flag.
      options: [{ index: 1, status: "READY_TO_SIGN", reasons: [], scheme: "exact", binanceChainId: "56", tokenAddress: USDT_56, tokenSymbol: "USDT", userWalletAddress: W,
        amount: "0.010000000000000000", payTo: CMC_PAYEE, needApproveFirst: true, assetTransferMethod: result === "wrong-method" ? "eip3009" : "permit2" }] } }; });
    f.runner.replies.set("x402-payment sign", async () => {
      signs += 1; const order = (await f.store.orders(W)).find(o => o.kind === "x402-sign")!;
      assert.equal(order.dispatch, "spawned"); assert.equal(f.instance.inFlight, 1); assert.equal((await f.store.getRun("cmc-run"))?.dispatches, 1);
      if (["timeout", "error", "unparseable"].includes(result)) return result === "error" ? { kind: "cli-error", code: 30003001, name: "ORDER_API_ERROR", orderId: null, sessionPresent: true }
        : { kind: "no-response", code: result === "timeout" ? "timeout" : "unparseable", sessionPresent: true };
      const payload = { x402Version: 2, payload: { signature: "0x" + "55".repeat(65), permit2Authorization: { from: W, spender: CMC_SPENDER,
        permitted: { token: USDT_56, amount: CMC_PRICE_ATOMIC.toString() }, nonce: "7", deadline: String(NOW / 1000 + (result === "valid-after-now" ? 120 : result === "short-challenge" ? 119 : result === "short-challenge-late" ? 181 : result === "long-challenge-late" ? 561 : 400)), witness: { to: CMC_PAYEE, validAfter: result === "valid-after-now" ? String(NOW / 1000) : "0" } } } };
      return { kind: "ok", sessionPresent: true, rwaTokens: null, data: { paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: Buffer.from(JSON.stringify(payload)).toString("base64"), signatureExpiresAt: NOW / 1000 + 400,
        ...(result === "approve-null" ? { approveTxHash: null } : result === "short-hash" ? { approveTxHash: "0x12" } : result.startsWith("approve") ? { approveTxHash: HASH } : {}) } };
    });
    if (result.startsWith("approve")) f.chain.receipt = async () => ({ ...receipt(), to: getAddress(USDT_56), input: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256) returns (bool)"]), functionName: "approve", args: [CMC_PERMIT2, E] }),
      observation: { ...receipt().observation, receipt: { ...receipt().observation.receipt, status: result === "approve-revert" ? 0n : 1n } } });
    if (result === "approve-timeout") f.chain.receipt = async () => { const clock = process.hrtime.bigint() + 61_000_000_000n; t.mock.method(process.hrtime, "bigint", () => clock); return null; };
    if (result === "quota") f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { ...settingsOutput(), x402QuotaUsed: 20 } });
    if (result === "pause-before-disclosure") {
      const rebind = f.cmcStore.rebindAgenticPaymentNonce.bind(f.cmcStore);
      t.mock.method(f.cmcStore, "rebindAgenticPaymentNonce", async (...args: Parameters<typeof rebind>) => { const rebound = await rebind(...args); await f.killswitch.pauseAgent(f.agent.id, W); return rebound; });
    }
    const cmc = createAgenticCmc({ ...f.execution, agents: f.agents, settings: f.settings, cmc: f.cmcStore, journal: f.journal, killswitch: f.killswitch,
      rpcUrls: ["offline://1", "offline://2", "offline://3"], transport, gateRunId: "cmc-run" });
    await cmc.enqueue(f.agent.id, ["NVDA"], ["MSFT"]); await cmc.refresh(f.agent.id);
    const orders = await f.store.orders(W), run = (await f.store.getRun("cmc-run"))!;
    if (["signed", "approve-success", "approve-revert", "approve-null", "valid-after-now", "short-challenge"].includes(result)) { assert.equal(paid, 1); assert.equal(signs, 1); assert.equal(orders[0]?.outcome, "committed"); assert.equal(run.cmcOperationIds.length, 1); assert.equal(run.cmcPayments, 1); }
    else assert.equal(paid, 0);
    if (["timeout", "error", "unparseable"].includes(result)) { assert.equal(orders[0]?.outcome, "open"); assert.equal(orders[0]?.holdReason, "sign-failed"); assert.equal(await f.store.walletObligations(W), true); }
    if (result === "valid-after-now") {
      // Binance signs validAfter as the signing time: the attempt carries it, and only a settlement proof with the same value settles it.
      const attempt = (await f.cmcStore.listAttempts(f.agent.id, W))[0]!, signedAfter = BigInt(NOW / 1000);
      assert.equal(attempt.validAfter, signedAfter); assert.equal(attempt.deadline, BigInt(NOW / 1000 + 120));
      const proof = { kind: "charge" as const, chainId: 56 as const, txHash: HASH, payer: attempt.wallet, asset: attempt.asset, amountWei: attempt.amountWei, nonce: attempt.nonce!,
        deadline: attempt.deadline!, witnessTo: attempt.witnessTo!, validAfter: signedAfter, attemptId: attempt.attemptId };
      const settle = (validAfter: bigint) => f.cmcStore.settle({ agentId: f.agent.id, ownerAddress: W, operationId: attempt.operationId, generation: attempt.generation, txHash: HASH, proof: { ...proof, validAfter } });
      assert.equal(await settle(0n), null); assert.equal((await f.cmcStore.getAttempt(f.agent.id, W, attempt.operationId))?.state === "settled", false);
      assert.equal((await settle(signedAfter))?.attempt.state, "settled");
    }
    if (result === "approve-null") { assert.equal(orders[0]?.approveTxHash, null); assert.deepEqual(orders[0]?.evidence, { code: "no-approve" }); assert.equal(orders[0]?.holdReason, null); }
    if (result === "short-hash") { assert.equal(orders[0]?.outcome, "open"); assert.equal(orders[0]?.approveTxHash, null); assert.equal(await f.store.walletObligations(W), true); }
    if (result === "approve-timeout") { assert.equal(orders[0]?.outcome, "open"); assert.equal(orders[0]?.holdReason, "approve-unverified"); assert.equal(await f.store.walletObligations(W), true); }
    if (result === "no-cmc-slot") { assert.equal(preview, 0); assert.equal(f.runner.calls.length, 0); }
    if (result === "wrong-method") { assert.equal(preview, 1); assert.equal(signs, 0); assert.equal(orders.length, 0); }
    await cmc.refresh(f.agent.id); assert.equal(signs <= 1, true); assert.equal(run.dispatches <= 1, true); await cmc.runtime.close();
  });

class CmcSnapshotSql implements SqlClient {
  state = new Map<string, unknown>(); auth = new Map<string, { agent: string; cipher: string }>(); now = NOW;
  async query<Row>(text: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    let rows: unknown[] = [];
    if (text === "select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms") rows = [{ ms: String(this.now) }];
    else if (text.startsWith("select agent_id,state_json")) rows = this.state.has(String(values[0])) ? [{ agent_id: values[0], state_json: this.state.get(String(values[0])) }] : [];
    else if (text.startsWith("insert into trade_cmc_snapshots")) this.state.set(String(values[0]), JSON.parse(String(values[2])) as unknown);
    else if (text.startsWith("select operation_id,encrypted_authorization")) rows = [...this.auth].filter(([, v]) => v.agent === values[0]).map(([key, v]) => ({ operation_id: key, encrypted_authorization: v.cipher }));
    else if (text.startsWith("delete from trade_cmc_authorizations")) { for (const [key, v] of this.auth) if (v.agent === values[0]) this.auth.delete(key); }
    else if (text.startsWith("insert into trade_cmc_authorizations")) this.auth.set(String(values[0]), { agent: String(values[1]), cipher: String(values[2]) });
    return { rows: rows as Row[] };
  }
  async transaction<T>(work: (sql: SqlClient) => Promise<T>): Promise<T> { const state = structuredClone(this.state), auth = structuredClone(this.auth);
    try { return await work(this); } catch (error) { this.state = state; this.auth = auth; throw error; } }
  async close(): Promise<void> { /* Offline snapshot fixture has no resource. */ }
}
for (const mutation of ["valid", "missing-lease", "expired-lease", "other-operation", "budget-generation", "attempt-state", "encrypted", "nonce", "early-deadline", "late-deadline", "session-expiry", "foreign-owner"])
  test("Agentic Postgres nonce rebind mutation " + mutation, async t => {
    const f = await fixture(t), source = f.cmcStore;
    await source.claimNewsSlot({ agentId: f.agent.id, ownerAddress: W, operationId: "op", nowMs: NOW });
    await source.reserve({ agentId: f.agent.id, ownerAddress: W, wallet: W, operationId: "op", attemptId: "a", amountWei: CMC_PRICE_ATOMIC });
    await source.prepare({ agentId: f.agent.id, ownerAddress: W, wallet: W, operationId: "op", generation: 0, sessionPublicKey: projectAgenticSessionFacts(f.row).publicKey,
      sessionExpiry: Math.floor(f.row.hireEndMs! / 1000), asset: USDT_56, amountWei: CMC_PRICE_ATOMIC, spender: CMC_SPENDER, payee: CMC_PAYEE,
      nonce: 1n, witnessTo: CMC_PAYEE, validAfter: 0n, deadline: BigInt(NOW / 1000 + 500), requestDigest: HASH, bodyHash: HASH });
    const snapshot = source.snapshot(f.agent.id);
    const changed = { ...snapshot, lease: mutation === "missing-lease" ? null : mutation === "other-operation" ? { ...snapshot.lease!, inFlightOperationId: "other" } : snapshot.lease,
      attempts: snapshot.attempts.map(a => mutation === "attempt-state" ? { ...a, state: "transmitting" as const } : a) };
    const sql = new CmcSnapshotSql(); sql.state.set(f.agent.id, JSON.parse(JSON.stringify(changed, (_key, v: unknown) => typeof v === "bigint" ? { __cmcBigint: v.toString() } : v)) as unknown);
    if (mutation === "expired-lease") sql.now = NOW + 86_400_000;
    if (mutation === "encrypted") sql.auth.set("op", { agent: f.agent.id, cipher: "opaque-offline" });
    const store = await PostgresTradeCmcStore.create(sql, () => NOW), before = structuredClone(sql.state);
    const result = await store.rebindAgenticPaymentNonce({ agentId: f.agent.id, ownerAddress: mutation === "foreign-owner" ? TOKEN : W,
      operationId: "op", budgetGeneration: mutation === "budget-generation" ? 1 : 0, preparedNonce: mutation === "nonce" ? 2n : 1n, signedNonce: 3n, signedValidAfter: 0n,
      signedDeadline: BigInt(NOW / 1000 + (mutation === "early-deadline" ? 5 : mutation === "late-deadline" ? 561 : 510)),
      sessionExpiry: Math.floor(NOW / 1000) + (mutation === "session-expiry" ? 509 : 604800), nowMs: 0 });
    assert.equal(result !== null, mutation === "valid"); if (mutation === "valid") { assert.equal(result?.nonce, 3n); assert.equal(result?.deadline, BigInt(NOW / 1000 + 510)); }
    else assert.deepEqual(sql.state, before);
  });

for (const mutation of ["retired", "heartbeat", "pause", "halt", "end", "hold", "fence", "historical-intent", "foreign-order"])
  test("Agentic payment predicate mutation " + mutation, async t => {
    const f = await fixture(t), fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
    if (mutation === "retired") await f.store.retire(f.instance.row.instanceId, "dispose");
    if (mutation === "heartbeat") f.setTime(NOW + 30_001);
    if (mutation === "pause") await f.killswitch.pauseAgent(f.agent.id, W);
    if (mutation === "halt") await f.killswitch.halt();
    if (mutation === "end") await f.store.leaveBound(f.row, "owner-signed-out");
    if (mutation === "hold") await f.store.patchWallet(f.row, { settingsHold: { code: "x402-limit", atMs: NOW } });
    if (mutation === "fence") await f.store.releaseFence(fence);
    if (mutation === "historical-intent") await f.intents.create({ decisionId: "old", idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, side: "buy", token: TOKEN, amountWei: E, entryWei: E, route: { hops: [], fees: [] }, positionId: "p", closeReason: null });
    if (mutation === "foreign-order") await f.store.createOrder(f.order({ idempotencyKey: "foreign" }));
    assert.equal(await agenticPayCheck(f.store, f.instance, fence, f.agent.id), false);
  });

for (const branch of ["commit-tx", "commit-partial-tx", "rollback", "approve-tx", "no-approve"])
  test("Agentic explicit disposition branch " + branch + " is dry by default and uses chain evidence", async t => {
    const f = await fixture(t), sign = ["approve-tx", "no-approve"].includes(branch), partial = branch === "commit-partial-tx";
    const order = f.order({ kind: sign ? "x402-sign" : "swap", dispatch: "spawned", response: "no-response", claimant: f.instance.row.instanceId, claimedAt: NOW,
      ...(partial ? { side: "sell", fromToken: TOKEN, toToken: agenticAddress(USDT_56), intendedRaw: (5n * E).toString() } : {}) }); await f.store.createOrder(order);
    if (!sign) { await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade" }); await f.journal.markUnknown(HASH, "offline"); }
    if (partial) f.chain.receipt = async () => receipt("sell", 2n * E, 2n * E);
    if (sign) f.chain.receipt = async () => ({ ...receipt(), to: getAddress(USDT_56), input: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256) returns (bool)"]), functionName: "approve", args: [CMC_PERMIT2, E] }) });
    const context = { ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch,
      wallets: new Set([W]), print: () => undefined, cycle: async () => undefined };
    await runAgenticGate(parseAgenticGateArgs(["dispose", "--order", HASH]), context); assert.equal((await f.store.getOrder(HASH))?.outcome, "open");
    const args = ["dispose", "--order", HASH, "--" + branch, ...(branch === "rollback" || branch === "no-approve" ? [] : [HASH]), "--attest", "offline reviewed evidence", "--yes-live"];
    await runAgenticGate(parseAgenticGateArgs(args), context);
    assert.equal((await f.store.getOrder(HASH))?.outcome, branch === "rollback" ? "rolled-back" : "committed");
    if (partial) assert.equal(((await f.store.getOrder(HASH))?.evidence as { disposition: string }).disposition, "commit-partial");
  });

test("Agentic first U schedules a dedicated confirmation at sixty seconds and never ends from one signal", async t => {
  const f = await fixture(t, { probe: { lastAtMs: NOW, firstUAtMs: null, unreachableAtMs: null } });
  t.mock.method(f.cmc, "refresh", async () => undefined);
  f.runner.replies.set("wallet status", { kind: "ok", data: { status: "UNCONNECTED" }, sessionPresent: true, rwaTokens: null });
  f.setTime(NOW + 300_000); await runAgenticCycle(f.lifecycle);
  assert.equal((await f.store.byAgent(f.agent.id))?.state, "bound"); const reads = f.runner.calls.length;
  f.setTime(NOW + 359_999); await runAgenticCycle(f.lifecycle); assert.equal(f.runner.calls.length, reads);
  f.setTime(NOW + 360_000); await runAgenticCycle(f.lifecycle); assert.equal((await f.store.byAgent(f.agent.id))?.state, "ended");
});

for (const action of ["keep", "sell-all"] as const) test("Agentic term-end choice " + action + " drains once and survives another cycle", async t => {
  const f = await fixture(t, { termEndAction: action, entryCutoffMs: NOW, hireFacts: {
    acceptedAtMs: NOW - 1000, acceptedDedicatedWalletAtMs: NOW - 1000, termSec: 604800, termEndAction: action,
    hireEndMs: NOW + 7_200_000, entryCutoffMs: NOW, signInMaxTimeMs: NOW + 90 * 86_400_000, pinned: [TOKEN], quoteDayCapWei: (50n * E).toString(), budgetWei: (2n * E).toString(),
    hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", minEntryWei: params.minEntryWei, entryWei: params.entryWei, quotePerTradeWei: params.entryWei } } });
  t.mock.method(f.cmc, "refresh", async () => undefined);
  for (const id of ["p-one", "p-two"]) await f.positions.open({ positionId: id, agentId: f.agent.id, ownerAddress: W, token: TOKEN,
    route: { hops: [], fees: [] }, entryWei: E, tokenAmount: E, fillStatus: "verified", openedAt: NOW });
  let requests = 0; const requestDrain = f.settings.requestDrain.bind(f.settings);
  t.mock.method(f.settings, "requestDrain", async (...args: Parameters<typeof requestDrain>) => { requests += 1; return requestDrain(...args); });
  await runAgenticCycle(f.lifecycle); await runAgenticCycle(f.lifecycle);
  assert.equal(requests, action === "sell-all" ? 1 : 0); assert.equal((await f.positions.listOpen(W, f.agent.id)).every(p => p.exitRequestedAt !== null), action === "sell-all");
  assert.equal((await f.store.byAgent(f.agent.id))?.drainRequestedAt !== null, action === "sell-all");
});

for (const blocker of ["halt", "pause", "settings", "held"] as const) test("Agentic end blockers record the transition snapshot " + blocker, async t => {
  const f = await fixture(t);
  if (blocker === "halt") await f.killswitch.halt();
  if (blocker === "pause") await f.killswitch.pauseAgent(f.agent.id, W);
  if (blocker === "settings") await f.store.patchWallet(f.row, { settingsHold: { code: "daily-limit", atMs: NOW } });
  if (blocker === "held") await f.store.createOrder(f.order({ holdReason: "no-response" }));
  const ended = (await f.store.leaveBound((await f.store.byAgent(f.agent.id))!, "term-ended"))!;
  assert.equal(ended.state, "ending"); assert.equal(ended.endBlockers?.halted, blocker === "halt"); assert.equal(ended.endBlockers?.paused, blocker === "pause");
  assert.equal(ended.endBlockers?.settingsHold, blocker === "settings"); assert.equal(ended.endBlockers?.heldObligations, blocker === "held" ? 1 : 0);
  await f.killswitch.resume(); await f.killswitch.unpauseAgent(f.agent.id, W); assert.deepEqual((await f.store.byAgent(f.agent.id))?.endBlockers, ended.endBlockers);
});

test("Agentic partial sell from a changed multiplier is held, with the swap's multiplier diagnosis", async t => {
  const f = await fixture(t); let dispatched = false;
  f.chain.balance = async (_w, token) => token === null ? E : token.toLowerCase() === TOKEN ? 5n * E : 100n * E;
  f.chain.receipt = async () => receipt("sell", 4n * E, 5n * E);
  f.runner.replies.set("market-order list", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: dispatched ? 1 : 0, page: 1, pageSize: 100,
    list: dispatched ? [{ orderId: "new", status: "FINISHED", txHash: HASH }] : [] } }));
  f.runner.replies.set("market-order swap", async () => { dispatched = true; return { kind: "ok", data: { orderId: "response-id" }, sessionPresent: true,
    rwaTokens: { tokens: [{ chainId: "56", contractAddress: TOKEN, multiplier: "1.25", kind: "bstock" }] } }; });
  const result = await executeAgenticTrade({ ...f.input, request: { ...f.input.request, side: "sell" } }, f.execution);
  assert.equal(result.kind, "unknown"); assert.equal((await f.store.getOrder(HASH))?.holdReason, "partial-sell"); assert.equal((await f.store.getOrder(HASH))?.multiplierUsed, "1.25");
  assert.equal(await f.store.walletObligations(W), true);
});

test("Agentic sell refuses a balance omitted by Binance's small-value filter before creating a journal", async t => {
  const f = await fixture(t); f.chain.balance = async (_w, token) => token === null ? E : 5n * E;
  f.runner.replies.set("wallet balance", { kind: "ok", data: [], sessionPresent: true, rwaTokens: { tokens: [{ chainId: "56", contractAddress: TOKEN, multiplier: "1", kind: "bstock" }] } });
  const result = await executeAgenticTrade({ ...f.input, request: { ...f.input.request, side: "sell" } }, f.execution);
  assert.equal(result.kind, "denied"); assert.equal(await f.journal.get(HASH), null); assert.equal(f.runner.calls.some(a => a[1] === "swap"), false);
});

for (const name of ["NETWORK_ERROR", "REQUEST_TIMEOUT", "SERVICE_UNAVAILABLE", "UNKNOWN_ERROR", "SERVICE_ERROR", "ORDER_API_ERROR"])
  test("Agentic missing authoritative response stays held despite a later FINISHED row: " + name, async t => {
    const f = await fixture(t); let dispatched = false;
    f.runner.replies.set("market-order list", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: dispatched ? 1 : 0, page: 1, pageSize: 100,
      list: dispatched ? [{ orderId: "later", status: "FINISHED", txHash: HASH }] : [] } }));
    f.runner.replies.set("market-order swap", async () => { dispatched = true; return { kind: "cli-error", code: name === "SERVICE_ERROR" || name === "ORDER_API_ERROR" ? 30003001 : 50000000, name, orderId: null, sessionPresent: true }; });
    assert.equal((await executeAgenticTrade(f.input, f.execution)).kind, "unknown");
    const row = (await f.store.getOrder(HASH))!, fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
    await resolveAgenticOrder({ ...f.execution, journal: f.journal, order: row, fence });
    assert.equal((await f.store.getOrder(HASH))?.response, "no-response"); assert.equal((await f.store.getOrder(HASH))?.outcome, "open");
  });

test("Agentic late child response after disposition raises the alert and cannot change the journal", async t => {
  const f = await fixture(t), alerts: unknown[][] = []; t.mock.method(console, "error", (...values: unknown[]) => { alerts.push(values); });
  f.runner.replies.set("market-order swap", async () => { const current = (await f.store.getOrder(HASH))!; await f.store.patchOrder(current, { outcome: "rolled-back" });
    return { kind: "ok", sessionPresent: true, rwaTokens: null, data: { orderId: "late" } }; });
  assert.equal((await executeAgenticTrade(f.input, f.execution)).kind, "unknown");
  assert.equal((await f.journal.get(HASH))?.state, "PENDING"); assert.equal((await f.store.getOrder(HASH))?.response, null);
  assert.equal(alerts[0]?.[0], "agentic_late_response");
});

for (const quote of [null, NOW - 30_001]) test("Agentic crash recovery seals an unclaimed order with quote " + quote, async t => {
  const f = await fixture(t), order = f.order({ quoteAt: quote });
  await f.store.createOrder(order); await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade" });
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  await resolveAgenticOrder({ ...f.execution, journal: f.journal, order, fence }); assert.equal((await f.store.getOrder(HASH))?.outcome, "rolled-back"); assert.equal(f.runner.calls.length, 0);
});

test("Agentic SQL claim is one query and starts no application reads inside that query window", async t => {
  const f = await fixture(t), calls: { sql: string; values: readonly unknown[] }[] = [];
  const sql: SqlClient = { query: async (text, values = []) => { calls.push({ sql: text, values }); return { rows: [] }; }, transaction: work => work(sql), close: async () => undefined };
  const store = new AgenticStore(sql, { agents: f.agents, journal: f.journal, intents: f.intents, cmc: f.cmcStore, killswitch: f.killswitch });
  const fence = { walletAddress: W, holder: "instance", token: "9", leaseUntil: NOW + 120000 };
  assert.equal(await store.claimOrder(f.order(), fence), null); assert.deepEqual(calls, [{ sql: AGENTIC_CLAIM_SQL, values: [HASH, "instance", "9", "swap"] }]);
});

for (const reason of ["halted", "paused", "settings-hold", "wallet-blocked", "ended-by-owner", "kept-by-choice", "unknown"])
  test("Agentic public unsold precedence " + reason, async t => {
    const f = await fixture(t, { state: "ended", termEndAction: reason === "kept-by-choice" ? "keep" : "sell-all", endReason: reason === "ended-by-owner" ? "owner-signed-out" : "term-ended",
      endBlockers: { atMs: NOW, halted: reason === "halted", paused: reason === "paused", settingsHold: reason === "settings-hold", heldObligations: reason === "wallet-blocked" ? 1 : 0 } });
    const position = await f.positions.open({ positionId: "p", agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: E, tokenAmount: E, fillStatus: "verified", openedAt: NOW });
    assert.equal(agenticUnsold(f.row, position, undefined)?.code, reason);
  });

test("Agentic instance heartbeat starts after registration and runs every ten seconds", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = await fixture(t); let heartbeats = 0;
  const heartbeat = f.store.heartbeat.bind(f.store); t.mock.method(f.store, "heartbeat", async (id: string) => { heartbeats += 1; return heartbeat(id); });
  assert.ok(await f.store.getInstance(f.instance.row.instanceId)); t.mock.timers.tick(10_000); await Promise.resolve(); await Promise.resolve(); assert.equal(heartbeats, 1);
});

for (const mode of ["drain", "held-then-released", "refused-then-retried"] as const)
  test("Agentic shared worker sells and projects the full drain: " + mode, async t => {
    t.mock.method(Date, "now", () => NOW);
    const template = await fixture(t), other = agenticAddress("0x7777777777777777777777777777777777777777");
    const f = await fixture(t, { termEndAction: "sell-all", entryCutoffMs: NOW,
      hireFacts: { ...template.row.hireFacts!, termEndAction: "sell-all", entryCutoffMs: NOW, pinned: [TOKEN, other] } });
    const balances = new Map<string, bigint>([[TOKEN, 5n * E], [other, 5n * E]]);
    const landed: { orderId: string; status: string; txHash: Hex; token: Address }[] = [];
    let held = mode === "held-then-released", refused = mode === "refused-then-retried";
    f.chain.balance = async (_w, token) => token === null ? E : token.toLowerCase() === USDT_56.toLowerCase() ? 100n * E : balances.get(token.toLowerCase()) ?? 0n;
    f.chain.receipt = async hash => {
      const matched = landed.find(r => r.txHash === hash); if (matched === undefined) return null;
      const proof = receipt("sell", 5n * E, 5n * E);
      return { ...proof, observation: { ...proof.observation, transaction: { ...proof.observation.transaction, hash }, receipt: { ...proof.observation.receipt, transactionHash: hash,
        logs: [{ ...proof.observation.receipt.logs[0]!, address: matched.token }, proof.observation.receipt.logs[1]!] } } };
    };
    f.runner.replies.set("wallet balance", async () => {
      const args = f.runner.calls.at(-1)!, token = agenticAddress(args[args.indexOf("--tokenAddress") + 1]!);
      return { kind: "ok", sessionPresent: true, data: [{ symbol: "STOCK", address: token, binanceChainId: "56", balance: "5", price: "1", value: "5" }],
        rwaTokens: { tokens: [{ chainId: "56", contractAddress: token, multiplier: "1", kind: "bstock" }] } };
    });
    f.runner.replies.set("market-order list", async () => {
      const args = f.runner.calls.at(-1)!, from = args[args.indexOf("--fromToken") + 1], rows = landed.filter(r => r.token === from);
      return { kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: rows.length, page: 1, pageSize: 100, list: rows } };
    });
    f.runner.replies.set("market-order quote", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null,
      data: { fromCoinSymbol: "STOCK", fromCoinAmount: "5", toCoinSymbol: "USDT", toCoinAmount: refused ? "4.85" : "5.1", slippage: "0" } }));
    f.runner.replies.set("market-order swap", async () => {
      const args = f.runner.calls.at(-1)!, token = agenticAddress(args[args.indexOf("--fromToken") + 1]!);
      const hash = ("0x" + String(landed.length + 1).padStart(64, "0")) as Hex;
      assert.equal(f.instance.inFlight, 1); landed.push({ orderId: "listed-" + (landed.length + 1), status: "FINISHED", txHash: hash, token }); balances.set(token, 0n);
      return held ? { kind: "no-response", code: "timeout", sessionPresent: true } : { kind: "ok", data: { orderId: "returned-" + landed.length }, sessionPresent: true, rwaTokens: null };
    });
    for (const [index, token] of [TOKEN, other].entries()) await f.positions.open({ positionId: "position-" + index, agentId: f.agent.id, ownerAddress: W, token,
      route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: 5n * E, fillStatus: "verified", openedAt: NOW + index, settlementAsset: "USDT",
      requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E });
    const dataPlane: TradeWorkerDeps["dataPlane"] = { universe: async lane => lane === "bstocks" ? [TOKEN, other].map(address => ({ address, symbol: "STOCK", lane: "bstocks" as const, source: "offline", venues: [],
      rwa: { platform: "bstocks", underlyingTicker: "STOCK", tokenPriceUsd: 1, referencePriceUsd: 1, premiumBps: 0, openState: true,
        marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 1, venues: [] } })) : [],
      tokensBatch: async addresses => addresses.map(address => ({ address, symbol: "STOCK", priceUsd: 1, marketCapUsd: 1e9, volume24hUsd: 1000, holders: 100,
        priceChange24hPct: 0, asOf: NOW, source: "pancake-v3-slot0", staleness: "fresh", updatedFields: ["priceUsd"] })),
      eligibilityBatch: async addresses => addresses.map(address => ({ address, eligible: true, reason: "ok", source: "allowlist" as const, venue: null })), security: async () => ({ riskLevel: "ok", flags: [] }) };
    const worker: TradeWorkerDeps = { ...f.worker, dataPlane, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN, other]) },
      routeReader: { quoteV2: async () => 5n * E, quoteV3Single: async () => 5n * E, quoteV3Path: async () => 5n * E,
        quoteUniV3Single: async () => { throw new Error("Uniswap reached"); }, quoteUniV3Path: async () => { throw new Error("Uniswap reached"); } },
      llmFor: () => { throw new Error("Drain called the entry brain"); } };
    t.mock.method(f.cmc, "refresh", async () => undefined);
    const input = { ...f.lifecycle, worker };
    await runAgenticCycle(input);
    if (mode === "drain") { assert.equal(landed.length, 2); assert.equal((await f.positions.listOpen(W, f.agent.id)).length, 0); }
    if (mode === "held-then-released") {
      assert.equal(landed.length, 1); await runAgenticCycle(input); assert.equal(landed.length, 1);
      const order = (await f.store.orders(W)).find(o => o.response === "no-response")!;
      await runAgenticGate(parseAgenticGateArgs(["dispose", "--order", order.idempotencyKey, "--commit-tx", landed[0]!.txHash, "--yes-live"]), {
        ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets: new Set([W]), print: () => undefined, cycle: async () => undefined });
      held = false; await runAgenticCycle(input); assert.equal(landed.length, 2); assert.equal((await f.positions.listOpen(W, f.agent.id)).length, 0);
    }
    if (mode === "refused-then-retried") { assert.equal(landed.length, 0); refused = false; await runAgenticCycle(input); assert.equal(landed.length, 2); }
    await runTradeWorkerOnce(worker); assert.equal((await f.positions.list(W, f.agent.id)).filter(p => p.status === "closed").length, 2);
    assert.equal(f.runner.calls.some(a => a[0] === "x402-payment"), false);
  });

test("Agentic foreign-wallet fences and forged command kinds cannot authorize memory claims or payments", async t => {
  const f = await fixture(t), order = f.order();
  await f.store.beginSwap(order, { idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade", decisionId: "decision", nativeSpendWei: 0n }, NOW);
  const foreign = (await f.store.acquireFence(TOKEN, f.instance.row.instanceId))!;
  assert.equal(await f.store.claimOrder(order, foreign), null); assert.equal(await f.store.payCheck(f.agent.id, foreign), false);
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  assert.equal(await f.store.claimOrder({ ...order, kind: "x402-sign" }, fence), null);
});

test("Agentic memory insertion failure rolls back its new journal and order together", async t => {
  const f = await fixture(t); await f.store.createOrder(f.order({ idempotencyKey: "existing", listedOrderId: "duplicate" }));
  await assert.rejects(() => f.store.beginSwap(f.order({ listedOrderId: "duplicate" }), { idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade", decisionId: "decision", nativeSpendWei: 0n }, NOW));
  assert.equal(await f.journal.get(HASH), null); assert.equal(await f.store.getOrder(HASH), null); assert.ok(await f.store.getOrder("existing"));
});

test("Agentic missing disposition evidence after a journal-first crash keeps the obligation held", async t => {
  const f = await fixture(t), order = f.order({ dispatch: "spawned", response: "no-response", claimant: f.instance.row.instanceId });
  await f.store.createOrder(order); await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade" }); await f.journal.markCommitted(HASH, { txHash: HASH });
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  assert.equal(await resolveAgenticOrder({ ...f.execution, journal: f.journal, order, fence }), null);
  assert.equal((await f.store.getOrder(HASH))?.holdReason, "disposition-repair"); assert.equal(await f.store.walletObligations(W), true);
});

test("Agentic crashed sign stays held and never changes its CMC attempt", async t => {
  const f = await fixture(t), order = f.order({ kind: "x402-sign", dispatch: "spawned", response: null, claimant: f.instance.row.instanceId });
  await f.store.createOrder(order); const before = f.cmcStore.snapshot(f.agent.id), fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  await resolveAgenticOrder({ ...f.execution, journal: f.journal, order, fence }); assert.equal((await f.store.getOrder(HASH))?.holdReason, "no-response");
  assert.deepEqual(f.cmcStore.snapshot(f.agent.id), before);
});

for (const status of ["PENDING", "WORKING", "TRIGGERED"]) test("Agentic gated admission rejects active limit orders " + status, async t => {
  const f = await fixture(t, { state: "hiring", hireFacts: null, hireStage: "accepted" });
  f.runner.replies.set("limit-order list", async () => { const args = f.runner.calls.at(-1)!, selected = args[args.indexOf("--status") + 1];
    return { kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: selected === status ? 1 : 0, page: 1, pageSize: 100, list: [] } }; });
  await assert.rejects(() => f.pairings.resumeHire(f.row), /wallet_has_limit_orders/); assert.equal((await f.store.getWallet(f.row.pairingId))?.state, "cleaning");
});

test("Agentic delayed indexing remains automatic during ending and an old FAILED row cannot be adopted", async t => {
  const f = await fixture(t, { state: "ending" }), order = f.order({ dispatch: "spawned", response: "accepted", claimant: f.instance.row.instanceId, createdAt: NOW - 1_800_001 });
  await f.store.createOrder(order); await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade" }); await f.journal.markUnknown(HASH, "offline");
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  f.runner.replies.set("market-order list", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: 1, page: 1, pageSize: 100, list: [{ orderId: "old", status: "FAILED", txHash: null }] } });
  await resolveAgenticOrder({ ...f.execution, journal: f.journal, order, fence }); assert.equal((await f.store.getOrder(HASH))?.holdReason, "no-list-row");
  f.runner.replies.set("market-order list", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: 2, page: 1, pageSize: 100, list: [{ orderId: "old", status: "FAILED", txHash: null }, { orderId: "indexed-later", status: "FINISHED", txHash: HASH }] } });
  await resolveAgenticOrder({ ...f.execution, journal: f.journal, order: (await f.store.getOrder(HASH))!, fence }); assert.equal((await f.store.getOrder(HASH))?.outcome, "committed");
});

test("Agentic disposition cannot replace an already committed journal's receipt hash", async t => {
  const f = await fixture(t), order = f.order({ dispatch: "spawned", response: "no-response", claimant: f.instance.row.instanceId });
  await f.store.createOrder(order); await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade" }); await f.journal.markCommitted(HASH, { txHash: HASH });
  const other = ("0x" + "55".repeat(32)) as Hex;
  await assert.rejects(() => runAgenticGate(parseAgenticGateArgs(["dispose", "--order", HASH, "--commit-tx", other, "--yes-live"]), {
    ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets: new Set([W]), print: () => undefined, cycle: async () => undefined }));
  assert.equal((await f.store.getOrder(HASH))?.outcome, "open"); assert.equal((await f.journal.get(HASH))?.externalRef.txHash, HASH);
});

test("Agentic trade journals park in generic reconciliation without reaching an Altana provider", async t => {
  const f = await fixture(t), h = await createHarness(); let calls = 0;
  t.mock.method(h.provider, "awaitExecution", async () => { calls += 1; throw new Error("Altana relay reached"); });
  await f.store.beginSwap(f.order(), { idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade", decisionId: "decision", nativeSpendWei: 0n,
    externalRef: { paramsHash: HASH, quoteSpendWei: (5n * E).toString(), sessionGeneration: 1 }, quoteSpendWei: 5n * E }, NOW);
  await reconcile({ provider: h.provider, journal: f.journal, minRowAgeMs: 0, resolveWallet: async () => { throw new Error("Agentic wallet reached Altana resolution"); } });
  assert.equal((await f.journal.get(HASH))?.state, "UNKNOWN"); assert.equal(calls, 0);
});

test("Agentic public quotas preserve exact subtraction when the used quota exceeds a lowered limit", async t => {
  const f = await fixture(t, { factsRead: { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject",
    dailyLimit: 0.5, quotaUsed: 0.51, x402DailyLimit: 0.5, x402QuotaUsed: 0.51, signInMaxTimeMs: NOW + 90 * 86400000, usdtWei: E.toString(), bnbWei: E.toString() } });
  const view = createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore, killswitch: f.killswitch,
    observer: { observe: async agent => { assert.equal(agent.sessionFacts, null); return []; } } });
  const publicRow = await view(W); assert.equal(publicRow.agent?.limits?.quotaLeft, "-0.01"); assert.equal(publicRow.agent?.limits?.x402QuotaLeft, "-0.01");
});

test("Agentic concurrent hire resumption rereads under the fence and returns the same bound hire", async t => {
  const f = await fixture(t, { state: "hiring", hireStage: "accepted", hireFacts: null });
  const rows = await Promise.all([f.pairings.resumeHire(f.row), f.pairings.resumeHire(f.row)]);
  assert.equal(rows[0]!.state, "bound"); assert.equal(rows[1]!.state, "bound"); assert.equal(rows[0]!.version, rows[1]!.version);
  assert.equal(f.runner.calls.filter(a => a[1] === "settings").length, 1);
});

test("Agentic sweeper cleans a persisted failed hire stage instead of restarting its gate", async t => {
  const f = await fixture(t, { state: "hiring", hireStage: "failed", updatedAt: NOW - 60_001 });
  await f.pairings.sweep(); assert.equal((await f.store.getWallet(f.row.pairingId))?.state, "failed");
  assert.equal((await f.store.getWallet(f.row.pairingId))?.sessionCiphertext, null);
  assert.equal(f.runner.calls.filter(a => a[1] === "settings").length, 0);
});

for (const [mutation, code] of [["settings", "USDT_SETTINGS_UNAVAILABLE"], ["entry", "USDT_ENTRY_BOUNDS"], ["entry-cap", "USDT_ENTRY_CAP"],
  ["cap", "USDT_CAP_UNAVAILABLE"], ["fee", "FEE_MISMATCH"], ["minimum", "MIN_OUT_TOO_LOW"]] as const)
  test("Agentic delegated bound refuses without swap: " + code, async t => {
    const f = await fixture(t), facts = f.input.agent.sessionFacts!;
    if (mutation === "settings") t.mock.method(f.settings, "get", async () => null);
    const agent = { ...f.input.agent, sessionFacts: { ...facts,
      ...(mutation === "cap" ? { spec: { ...facts.spec, spendCaps: [] } } : {}),
      ...(mutation === "entry-cap" || mutation === "fee" ? { hireSizing: { ...facts.hireSizing!, quotePerTradeWei: (BigInt(mutation === "fee" ? 6 : 4) * E).toString() } } : {}) } };
    const request = { ...f.input.request, ...(mutation === "entry" ? { amountWei: 4n * E } : {}),
      ...(mutation === "fee" ? { platformFeeAtomic: 1n } : {}), ...(mutation === "minimum" ? { minOutWei: E } : {}) };
    const result = await executeAgenticTrade({ ...f.input, agent, request }, f.execution);
    assert.equal(result.kind, "denied"); if (result.kind === "denied") assert.equal(result.code, code);
    assert.equal(f.runner.calls.some(a => a[1] === "swap"), false); assert.equal(await f.journal.get(HASH), null);
  });

test("Agentic conflicting decision replay refuses without touching its existing reservation", async t => {
  const f = await fixture(t), other = ("0x" + "66".repeat(32)) as Hex;
  await f.store.beginSwap(f.order(), { idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade", decisionId: "decision", nativeSpendWei: 0n, externalRef: { paramsHash: other } }, NOW);
  const before = await f.journal.get(HASH), result = await executeAgenticTrade(f.input, f.execution);
  assert.equal(result.kind, "denied"); if (result.kind === "denied") assert.equal(result.code, "conflict");
  assert.deepEqual(await f.journal.get(HASH), before); assert.deepEqual(f.runner.calls, []);
});

// ---- G0 aids: gate-only failed-news rewind, retry-failed flag, sanitized refusal log ----
type RewindFixture = Awaited<ReturnType<typeof fixture>>;
const bigintJson = (_key: string, v: unknown) => typeof v === "bigint" ? { __cmcBigint: v.toString() } : v;
/** One released attempt (real store calls), then a hand-built snapshot: a settled attempt, an unlinked row and another agent's rows. */
async function rewindSnapshot(f: RewindFixture, mutate: (s: CmcMemorySnapshot) => CmcMemorySnapshot = s => s): Promise<CmcMemorySnapshot> {
  const c = f.cmcStore, id = f.agent.id;
  await c.claimNewsSlot({ agentId: id, ownerAddress: W, operationId: "op-released", nowMs: NOW });
  await c.reserve({ agentId: id, ownerAddress: W, wallet: W, operationId: "op-released", attemptId: "a-released", amountWei: CMC_PRICE_ATOMIC });
  await c.release({ agentId: id, ownerAddress: W, operationId: "op-released", generation: 0, proof: { kind: "no-disclosure" } });
  await c.finishNewsSlot({ agentId: id, ownerAddress: W, operationId: "op-released", nowMs: NOW });
  const snap = c.snapshot(id), released = snap.attempts[0]!;
  const row = (agentId: string, ticker: string, status: CmcNewsRecord["status"], paymentOperationId: string | null): CmcNewsRecord => ({ agentId, ownerAddress: W, ticker, skill: CMC_SKILL_SECTOR,
    generation: 0, status, context: null, sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId, asOfMs: NOW, expiresAtMs: NOW + 1000 });
  return mutate({ ...snap, lease: { ...snap.lease!, llmRequests: { windowStartMs: 1, count: 3 } },
    attempts: [released, { ...released, operationId: "op-settled", attemptId: "a-settled", state: "settled" },
      { ...released, agentId: "other-agent", operationId: "op-other", attemptId: "a-other", state: "prepared" }],
    news: [row(id, "AVAILABLE", "available", null), row(id, "FAIL-NULL", "service-error", null), row(id, "FAIL-RELEASED", "service-error", "op-released"),
      row(id, "FAIL-SETTLED", "invalid", "op-settled"), row(id, "FAIL-UNLINKED", "service-error", "op-nowhere"), row("other-agent", "OTHER", "service-error", null)] });
}
const restored = (snap: CmcMemorySnapshot) => { const store = new MemoryTradeCmcStore(() => NOW); store.restore(snap, new Map()); return store; };

test("Agentic gate rewind removes only unpaid failed news and the hourly stamp", async t => {
  const f = await fixture(t), snap = await rewindSnapshot(f), store = restored(snap), id = f.agent.id;
  assert.deepEqual(await store.rewindFailedNewsForAgenticGate({ agentId: id, ownerAddress: W, nowMs: NOW }), { removedNews: 3 });
  const after = store.snapshot("other-agent"), mine = store.snapshot(id);
  // FAIL-UNLINKED names an operation with no attempt record (the payment check failed before reserve): unpaid, removed.
  assert.deepEqual(mine.news.map(n => n.ticker).sort(), ["AVAILABLE", "FAIL-SETTLED"]);
  assert.deepEqual(after.news.map(n => n.ticker), ["OTHER"]);
  assert.equal(mine.lease?.lastAttemptAtMs, null); assert.deepEqual(mine.lease?.llmRequests, { windowStartMs: 1, count: 3 });
  assert.deepEqual({ ...mine.lease, lastAttemptAtMs: 0 }, { ...snap.lease, lastAttemptAtMs: 0 });
  assert.deepEqual(mine.attempts, snap.attempts.filter(a => a.agentId === id)); assert.deepEqual(mine.budget, snap.budget);
  const second = await store.rewindFailedNewsForAgenticGate({ agentId: id, ownerAddress: W, nowMs: NOW }); assert.deepEqual(second, { removedNews: 0 });
});

for (const refusal of ["pending-operation", "in-flight-lease", "prepared", "transmitting", "unknown", "foreign-owner", "no-budget"])
  test("Agentic gate rewind refuses and changes nothing: " + refusal, async t => {
    const f = await fixture(t), id = f.agent.id;
    const snap = await rewindSnapshot(f, s => refusal === "pending-operation" ? { ...s, budget: { ...s.budget!, pendingOperationId: "op-x" } }
      : refusal === "in-flight-lease" ? { ...s, lease: { ...s.lease!, inFlightOperationId: "op-x" } }
      : ["prepared", "transmitting", "unknown"].includes(refusal) ? { ...s, attempts: s.attempts.map(a => a.operationId === "op-settled" ? { ...a, state: refusal as "prepared" } : a) }
      : refusal === "no-budget" ? { ...s, budget: null } : s);
    const store = restored(snap), before = store.snapshot(id);
    assert.equal(await store.rewindFailedNewsForAgenticGate({ agentId: id, ownerAddress: refusal === "foreign-owner" ? TOKEN : W, nowMs: NOW }), null);
    assert.deepEqual(store.snapshot(id), before);
  });

test("Agentic gate rewind ignores another agent's open attempt and works through the Postgres snapshot adapter", async t => {
  const f = await fixture(t), id = f.agent.id, snap = await rewindSnapshot(f);
  const sql = new CmcSnapshotSql(); sql.state.set(id, JSON.parse(JSON.stringify(snap, bigintJson)) as unknown);
  const store = await PostgresTradeCmcStore.create(sql, () => NOW);
  assert.deepEqual(await store.rewindFailedNewsForAgenticGate({ agentId: id, ownerAddress: W, nowMs: NOW }), { removedNews: 3 });
  assert.deepEqual((await store.listNews(id, W)).map(n => n.ticker).sort(), ["AVAILABLE", "FAIL-SETTLED"]);
  assert.equal((await store.getNewsLease(id, W))?.lastAttemptAtMs, null);
  assert.equal(await store.rewindFailedNewsForAgenticGate({ agentId: id, ownerAddress: TOKEN, nowMs: NOW }), null);
});

test("Agentic gate args: --retry-failed is valid only on cmc-once", () => {
  assert.equal(parseAgenticGateArgs(["cmc-once", "--run", "r", "--yes-live", "--retry-failed"]).values["retry-failed"], "true");
  assert.equal(parseAgenticGateArgs(["cmc-once", "--run", "r", "--yes-live"]).values["retry-failed"], undefined);
  for (const argv of [["cycle-once", "--run", "r", "--yes-live", "--retry-failed"], ["status", "--agent", "a", "--retry-failed"], ["reconcile-once", "--agent", "a", "--retry-failed"],
    ["cmc-once", "--run", "r", "--yes-live", "--retry-failed", "--retry-failed"]]) assert.throws(() => parseAgenticGateArgs(argv), { message: "AGENTIC_GATE_ARGUMENT" });
});

for (const mode of ["retry", "pending", "no-flag"] as const)
  test("Agentic CMC gate retry-failed: " + mode, async t => {
    t.mock.method(Date, "now", () => NOW);
    const lines: unknown[][] = [], errors: unknown[][] = [];
    t.mock.method(console, "log", (...args: unknown[]) => { lines.push(args); }); t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
    const f = await fixture(t), id = f.agent.id, c = f.cmcStore; let preview = 0;
    // A failed, released attempt that took the hourly slot, with the macro row left in service-error.
    await c.claimNewsSlot({ agentId: id, ownerAddress: W, operationId: "op-old", nowMs: mode === "pending" ? NOW - 7_300_000 : NOW - 60_000 });
    await c.reserve({ agentId: id, ownerAddress: W, wallet: W, operationId: "op-old", attemptId: "a-old", amountWei: CMC_PRICE_ATOMIC });
    await c.putNews({ agentId: id, ownerAddress: W, ticker: "_GLOBAL", skill: CMC_SKILL_MACRO, generation: 0, status: "service-error", context: null, sourceUrl: null, publishedAtMs: null,
      payloadHash: null, paymentOperationId: "op-old", asOfMs: NOW - 60_000, expiresAtMs: NOW + 86_400_000, lastAttemptAtMs: NOW - 60_000 });
    await c.release({ agentId: id, ownerAddress: W, operationId: "op-old", generation: 0, proof: { kind: "no-disclosure" } });
    await c.finishNewsSlot({ agentId: id, ownerAddress: W, operationId: "op-old", nowMs: NOW - 60_000 });
    if (mode === "pending") {
      await c.claimNewsSlot({ agentId: id, ownerAddress: W, operationId: "op-pending", nowMs: NOW - 60_000 });
      await c.reserve({ agentId: id, ownerAddress: W, wallet: W, operationId: "op-pending", attemptId: "a-pending", amountWei: CMC_PRICE_ATOMIC });
    }
    const transport: CmcTransport = { async request(request) {
      const body = JSON.parse(request.body) as { params: { name: string } };
      const challenge = { x402Version: 2, resource: { url: "X402_" + body.params.name }, accepts: [{ scheme: "exact", network: "eip155:56", asset: USDT_56, amount: CMC_PRICE_ATOMIC.toString(), payTo: CMC_PAYEE,
        maxTimeoutSeconds: 500, extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", spenderAddress: CMC_SPENDER, signerAddress: CMC_SIGNER, x402PaymentConfigId: CMC_CONFIG_ID } }] };
      return { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") }, body: "" };
    } };
    await f.store.createRun({ runId: "retry-run", gate: "G0", agentId: id, wallet: W, side: "none", maxDispatches: 1, dispatches: 0, maxNotionalUsdt: "0", maxCmcPayments: 1, cmcPayments: 0,
      cmcOperationIds: [], deadlineMs: NOW + 900_000, createdAt: NOW, closedAt: null });
    // The wrong method stops after the preview: a new attempt is prepared and released without any signature or payment.
    f.runner.replies.set("x402-payment preview", async () => { preview += 1; return { kind: "ok", sessionPresent: true, rwaTokens: null, data: { paymentId: "offline-payment", options: [{ index: 1, status: "READY_TO_SIGN",
      reasons: [], scheme: "exact", binanceChainId: "56", tokenAddress: USDT_56, tokenSymbol: "USDT", userWalletAddress: W, amount: "0.010000000000000000", payTo: CMC_PAYEE, needApproveFirst: true, assetTransferMethod: "eip3009" }] } }; });
    const cmc = createAgenticCmc({ ...f.execution, agents: f.agents, settings: f.settings, cmc: f.cmcStore, journal: f.journal, killswitch: f.killswitch,
      rpcUrls: ["offline://1", "offline://2", "offline://3"], transport, gateRunId: "retry-run" });
    await cmc.enqueue(id, ["NVDA"], ["MSFT"]); await cmc.refresh(id, mode === "no-flag" ? undefined : { retryFailed: true });
    const run = (await f.store.getRun("retry-run"))!, refreshLine = lines.find(l => l[0] === "agentic_cmc_refresh");
    if (mode === "retry") { assert.equal(preview, 1); assert.equal(run.cmcPayments, 1); assert.equal(run.cmcOperationIds.length, 1); assert.equal(errors.some(e => e[0] === "agentic_cmc_retry_refused"), false); }
    if (mode === "pending") { assert.equal(preview, 0); assert.equal(run.cmcPayments, 0); assert.equal(errors.some(e => e[0] === "agentic_cmc_retry_refused"), true); assert.equal(refreshLine, undefined); }
    if (mode === "no-flag") { assert.equal(preview, 0); assert.equal(run.cmcPayments, 1); assert.equal(errors.some(e => e[0] === "agentic_cmc_retry_refused"), false);
      assert.equal(JSON.parse(String(refreshLine?.[1])).reason, "hourly_slot_unavailable"); assert.equal(JSON.parse(String(refreshLine?.[1])).state, "skipped"); }
    await cmc.runtime.close();
  });

test("Agentic signer refusal log: a bad validAfter prints sanitized facts and changes nothing", async t => {
  t.mock.method(Date, "now", () => NOW);
  const errors: unknown[][] = []; t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); }); t.mock.method(console, "log", () => undefined);
  const f = await fixture(t); let paid = 0;
  const signature = "0x" + "55".repeat(65), nonce = "123456789";
  const transport: CmcTransport = { async request(request) {
    if (request.headers === undefined) {
      const body = JSON.parse(request.body) as { params: { name: string } };
      const challenge = { x402Version: 2, resource: { url: "X402_" + body.params.name }, accepts: [{ scheme: "exact", network: "eip155:56", asset: USDT_56, amount: CMC_PRICE_ATOMIC.toString(), payTo: CMC_PAYEE,
        maxTimeoutSeconds: 500, extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", spenderAddress: CMC_SPENDER, signerAddress: CMC_SIGNER, x402PaymentConfigId: CMC_CONFIG_ID } }] };
      return { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") }, body: "" };
    }
    paid += 1; return { status: 200, headers: {}, body: JSON.stringify({ result: { content: [] } }) };
  } };
  await f.store.createRun({ runId: "diag-run", gate: "G0", agentId: f.agent.id, wallet: W, side: "none", maxDispatches: 1, dispatches: 0, maxNotionalUsdt: "0", maxCmcPayments: 1, cmcPayments: 0,
    cmcOperationIds: [], deadlineMs: NOW + 900_000, createdAt: NOW, closedAt: null });
  f.runner.replies.set("x402-payment preview", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { paymentId: "offline-payment-id", options: [{ index: 1, status: "READY_TO_SIGN", reasons: [],
    scheme: "exact", binanceChainId: "56", tokenAddress: USDT_56, tokenSymbol: "USDT", userWalletAddress: W, amount: "0.010000000000000000", payTo: CMC_PAYEE, needApproveFirst: true, assetTransferMethod: "permit2" }] } }));
  const payload = { x402Version: 2, payload: { signature, permit2Authorization: { from: W, spender: CMC_SPENDER, permitted: { token: USDT_56, amount: CMC_PRICE_ATOMIC.toString() },
    nonce, deadline: String(NOW / 1000 + 400), witness: { to: CMC_PAYEE, validAfter: String(NOW / 1000 + 61) } } } };
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  f.runner.replies.set("x402-payment sign", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: header, signatureExpiresAt: NOW / 1000 + 400 } });
  const cmc = createAgenticCmc({ ...f.execution, agents: f.agents, settings: f.settings, cmc: f.cmcStore, journal: f.journal, killswitch: f.killswitch,
    rpcUrls: ["offline://1", "offline://2", "offline://3"], transport, gateRunId: "diag-run" });
  await cmc.enqueue(f.agent.id, ["NVDA"], ["MSFT"]); await cmc.refresh(f.agent.id);
  const line = errors.find(e => e[0] === "agentic_signed_authorization_refused");
  assert.ok(line); const text = String(line[1]), facts = JSON.parse(text) as Record<string, unknown>;
  assert.equal(facts["step"], "authorization-mismatch"); assert.equal(facts["validAfter"], String(NOW / 1000 + 61));
  assert.equal(facts["fromMatches"], true); assert.equal(facts["spenderMatches"], true); assert.equal(facts["toMatches"], true); assert.equal(facts["amountMatches"], true);
  assert.equal(facts["deadlineInSec"], 400); assert.equal(facts["maxTimeoutSeconds"], 500); assert.equal(facts["signatureExpiresInSec"], 400);
  assert.deepEqual((facts["payloadShape"] as { payload: { permit2Authorization: { nonce: string } } }).payload.permit2Authorization.nonce, "string");
  for (const secret of [signature, nonce, header, "offline-payment-id", "signature\":"]) assert.equal(text.includes(secret), false, secret);
  assert.equal(JSON.stringify(errors).includes(header), false);
  // Unchanged outcome: nothing was paid and every attempt of the agent ended released.
  assert.equal(paid, 0); const attempts = await f.cmcStore.listAttempts(f.agent.id, W);
  assert.ok(attempts.length >= 1); assert.equal(attempts.every(a => a.state === "released" && !a.disclosurePossible), true);
  assert.equal((await f.cmcStore.get(f.agent.id, W))?.pendingOperationId, null);
  await cmc.runtime.close();
});

for (const used of [0.00999796218874478, 19.995])
  test("Agentic CMC quota check reads Binance float quotas: x402QuotaUsed " + used, async t => {
    t.mock.method(Date, "now", () => NOW); t.mock.method(console, "log", () => undefined); t.mock.method(console, "error", () => undefined);
    const f = await fixture(t); let preview = 0;
    const transport: CmcTransport = { async request(request) {
      const body = JSON.parse(request.body) as { params: { name: string } };
      const challenge = { x402Version: 2, resource: { url: "X402_" + body.params.name }, accepts: [{ scheme: "exact", network: "eip155:56", asset: USDT_56, amount: CMC_PRICE_ATOMIC.toString(), payTo: CMC_PAYEE,
        maxTimeoutSeconds: 500, extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", spenderAddress: CMC_SPENDER, signerAddress: CMC_SIGNER, x402PaymentConfigId: CMC_CONFIG_ID } }] };
      return { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") }, body: "" };
    } };
    f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { ...settingsOutput(), x402DailyLimit: 20, x402QuotaUsed: used } });
    // The wrong method stops after the preview, so reaching the preview proves authorize and the fresh settings read passed.
    f.runner.replies.set("x402-payment preview", async () => { preview += 1; return { kind: "ok", sessionPresent: true, rwaTokens: null, data: { paymentId: "offline-payment", options: [{ index: 1, status: "READY_TO_SIGN",
      reasons: [], scheme: "exact", binanceChainId: "56", tokenAddress: USDT_56, tokenSymbol: "USDT", userWalletAddress: W, amount: "0.010000000000000000", payTo: CMC_PAYEE, needApproveFirst: true, assetTransferMethod: "eip3009" }] } }; });
    const cmc = createAgenticCmc({ ...f.execution, agents: f.agents, settings: f.settings, cmc: f.cmcStore, journal: f.journal, killswitch: f.killswitch,
      rpcUrls: ["offline://1", "offline://2", "offline://3"], transport });
    await cmc.enqueue(f.agent.id, ["NVDA"], ["MSFT"]); await cmc.refresh(f.agent.id);
    assert.equal(preview, used < 19 ? 1 : 0); await cmc.runtime.close();
  });

// A held buy or sell whose order later commits with a chain-verified fill must reach the position (shared worker reconcile path).
const FILLED = 42_331_817_194_027_885n;
async function heldIntent(f: Awaited<ReturnType<typeof fixture>>, side: "buy" | "sell", decisionId = "d-held") {
  await f.intents.create({ decisionId, idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, side, token: TOKEN, route: { hops: [], fees: [] }, amountWei: 5n * E,
    entryWei: 5n * E, positionId: side === "buy" ? decisionId : "p-sell", closeReason: side === "sell" ? "owner-request" : null, settlementAsset: "USDT" });
  await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade", decisionId });
  await f.journal.markCommitted(HASH, { txHash: HASH });
  await f.store.createOrder(f.order({ decisionId, side, outcome: "committed", dispatch: "spawned", txHash: HASH, evidence: { disposition: "commit" },
    ...(side === "sell" ? { fromToken: TOKEN, toToken: agenticAddress(USDT_56), amountAtomic: null, intendedRaw: FILLED.toString() } : {}) }));
  f.chain.receipt = async () => side === "buy" ? receipt("buy", 5n * E, FILLED) : receipt("sell", FILLED, 5n * E);
}
const unverifiedBuy = (f: Awaited<ReturnType<typeof fixture>>, positionId = "d-held") => f.positions.open({ positionId, agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] },
  entryWei: 5n * E, tokenAmount: null, fillStatus: "unverified", openedAt: NOW, entryTxHash: HASH, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: null });

test("Agentic held buy: a later commit gives the position its verified entry and amount (pending intent)", async t => {
  const f = await fixture(t); await heldIntent(f, "buy");
  await runTradeWorkerOnce(f.worker);
  const p = (await f.positions.get(W, f.agent.id, "d-held"))!;
  assert.equal(p.verifiedEntryAtomic, 5n * E); assert.equal(p.tokenAmount, FILLED); assert.equal(p.fillStatus, "verified"); assert.match(p.receiptOwnershipKey ?? "", /^56\|/u);
});

test("Agentic held buy: a position projected unverified while held is repaired by the next cycle", async t => {
  const f = await fixture(t); await heldIntent(f, "buy"); await unverifiedBuy(f); await f.intents.markProjected(W, f.agent.id, "d-held");
  assert.equal((await f.positions.get(W, f.agent.id, "d-held"))?.verifiedEntryAtomic, null);
  await runTradeWorkerOnce(f.worker);
  const p = (await f.positions.get(W, f.agent.id, "d-held"))!;
  assert.equal(p.verifiedEntryAtomic, 5n * E); assert.equal(p.tokenAmount, FILLED); assert.equal(p.fillStatus, "verified"); assert.ok(p.receiptOwnershipKey);
  const view = await createAgenticPublicView({ ...f, cmc: f.cmcStore, observer: { observe: async () => [] } })(W);
  assert.equal(view.agent?.positions[0]?.entryUsdtWei, (5n * E).toString()); assert.equal(view.agent?.positions[0]?.tokenAmount, FILLED.toString());
});

test("Agentic held buy: a verified position and an Altana position are never touched", async t => {
  const f = await fixture(t); await heldIntent(f, "buy");
  await f.positions.open({ positionId: "d-held", agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: 7n, fillStatus: "verified",
    openedAt: NOW, entryTxHash: HASH, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 4n * E, receiptOwnershipKey: `56|${HASH}|${W}|9|${AGENTIC_RECEIPT_TAG}` });
  await f.intents.markProjected(W, f.agent.id, "d-held");
  await f.agents.createAgent({ id: "altana-agent", ownerAddress: W, walletAddress: TOKEN, custodyModel: "passkey", status: "armed" });
  await f.positions.open({ positionId: "altana-p", agentId: "altana-agent", ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: null, fillStatus: "unverified",
    openedAt: NOW, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: null });
  const before = structuredClone(await f.positions.get(W, f.agent.id, "d-held")), altana = structuredClone(await f.positions.get(W, "altana-agent", "altana-p"));
  await runTradeWorkerOnce(f.worker);
  assert.deepEqual(await f.positions.get(W, f.agent.id, "d-held"), before); assert.deepEqual(await f.positions.get(W, "altana-agent", "altana-p"), altana);
});

test("Agentic held sell: a later commit closes the position with the verified exit", async t => {
  const f = await fixture(t);
  await f.positions.open({ positionId: "p-sell", agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: FILLED, fillStatus: "verified",
    openedAt: NOW, entryTxHash: HASH, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${HASH}|${W}|9|${AGENTIC_RECEIPT_TAG}` });
  await heldIntent(f, "sell", "d-sell"); f.chain.balance = async () => 0n; // the whole position was sold
  await runTradeWorkerOnce(f.worker);
  const p = (await f.positions.get(W, f.agent.id, "p-sell"))!;
  assert.equal(p.status, "closed"); assert.equal(p.exitWei, 5n * E); assert.equal(p.exitFillStatus, "verified");
});

test("Agentic gate repair-fill applies the chain-verified fill to the unverified position and nothing else", async t => {
  const f = await fixture(t); await heldIntent(f, "buy"); await unverifiedBuy(f);
  const printed: unknown[] = [], context = { ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets: new Set([W]),
    print: (value: unknown) => printed.push(value), cycle: async () => undefined };
  const args = ["repair-fill", "--order", HASH, "--yes-live"];
  await assert.rejects(() => runAgenticGate(parseAgenticGateArgs(["repair-fill", "--order", HASH]), context), { message: "AGENTIC_GATE_LIVE_REQUIRED" });
  const failing = f.chain.receipt; f.chain.receipt = async () => null;
  await assert.rejects(() => runAgenticGate(parseAgenticGateArgs(args), context), { message: "AGENTIC_GATE_UNVERIFIED" });
  assert.equal((await f.positions.get(W, f.agent.id, "d-held"))?.verifiedEntryAtomic, null);
  f.chain.receipt = failing;
  await runAgenticGate(parseAgenticGateArgs(args), context);
  const p = (await f.positions.get(W, f.agent.id, "d-held"))!;
  assert.equal((printed[0] as { outcome: string }).outcome, "repaired"); assert.equal(p.verifiedEntryAtomic, 5n * E); assert.equal(p.tokenAmount, FILLED); assert.equal(p.fillStatus, "verified");
  const view = await createAgenticPublicView({ ...f, cmc: f.cmcStore, observer: { observe: async () => [] } })(W);
  assert.equal(view.agent?.positions[0]?.entryUsdtWei, (5n * E).toString()); assert.equal(view.agent?.positions[0]?.tokenAmount, FILLED.toString());
  // Running it again, or on a position that is already verified, changes nothing.
  const before = structuredClone(await f.positions.get(W, f.agent.id, "d-held"));
  await runAgenticGate(parseAgenticGateArgs(args), context);
  assert.equal((printed[1] as { outcome: string }).outcome, "already-verified"); assert.deepEqual(await f.positions.get(W, f.agent.id, "d-held"), before);
  // A wallet outside the allowlist is refused.
  await assert.rejects(() => runAgenticGate(parseAgenticGateArgs(args), { ...context, wallets: new Set([TOKEN]) }), { message: "AGENTIC_GATE_CONFINEMENT" });
});

test("Agentic gate repair-fill: the sell analogue applies the verified exit to a closed position", async t => {
  const f = await fixture(t);
  await f.positions.open({ positionId: "p-sell", agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: FILLED, fillStatus: "verified",
    openedAt: NOW, entryTxHash: `0x${"77".repeat(32)}` as Hex, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${HASH}|${W}|9|${AGENTIC_RECEIPT_TAG}` });
  await heldIntent(f, "sell", "d-sell");
  await f.positions.closePosition({ ownerAddress: W, agentId: f.agent.id, positionId: "p-sell", exitWei: null, exitTxHash: HASH, soldTokenAmount: FILLED, exitFillStatus: "unverified", reason: "owner-request", note: null });
  const printed: unknown[] = [], context = { ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets: new Set([W]),
    print: (value: unknown) => printed.push(value), cycle: async () => undefined };
  await runAgenticGate(parseAgenticGateArgs(["repair-fill", "--order", HASH, "--yes-live"]), context);
  const p = (await f.positions.get(W, f.agent.id, "p-sell"))!;
  assert.equal((printed[0] as { outcome: string }).outcome, "repaired"); assert.equal(p.exitWei, 5n * E); assert.equal(p.exitFillStatus, "verified");
});

/** AGENTIC-RECEIPT-WAIT F1: an open swap row bound to a listed row (default FINISHED + HASH), its journal UNKNOWN, a fence, and one resolver pass. */
async function receiptWait(t: TestContext, patch: Partial<AgenticOrder> = {}, list: Record<string, unknown> = { orderId: "new", status: "FINISHED", txHash: HASH }, wallet: Partial<AgenticWallet> = {}) {
  const f = await fixture(t, wallet), order = f.order({ dispatch: "spawned", response: "accepted", claimant: f.instance.row.instanceId, claimedAt: NOW, ...patch });
  await f.store.createOrder(order); await f.journal.begin({ idempotencyKey: HASH, agentId: f.agent.id, ownerAddress: W, kind: "trade" }); await f.journal.markUnknown(HASH, "offline");
  f.runner.replies.set("market-order list", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: 1, page: 1, pageSize: 100, list: [list] } });
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  const pass = async () => resolveAgenticOrder({ ...f.execution, journal: f.journal, order: (await f.store.getOrder(HASH))!, fence });
  return { f, pass, fence };
}
const sellOrder = () => ({ side: "sell" as const, fromToken: TOKEN, toToken: agenticAddress(USDT_56), intendedRaw: (5n * E).toString() });

test("AGENTIC-RECEIPT-WAIT F1: an unreadable receipt leaves a FINISHED row open, unheld and an obligation; the next pass commits it", async t => {
  const { f, pass } = await receiptWait(t);
  const spies = (["markCommitted", "markRolledBack", "advanceUnknown", "resolveUnknown"] as const).map(name => t.mock.method(f.journal, name));
  f.chain.receipt = async () => null;
  await pass();
  const waiting = (await f.store.getOrder(HASH))!;
  assert.equal(waiting.outcome, "open"); assert.equal(waiting.holdReason, null); assert.equal(await f.store.walletObligations(W), true);
  assert.equal((await f.journal.get(HASH))?.state, "UNKNOWN");
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  f.chain.receipt = async () => receipt();
  await pass();
  assert.equal((await f.store.getOrder(HASH))?.outcome, "committed");
});

test("AGENTIC-RECEIPT-WAIT F1: the executor keeps polling through an unreadable receipt and returns committed", async t => {
  const f = await fixture(t); let dispatched = false, reads = 0;
  f.runner.replies.set("market-order list", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: dispatched ? 1 : 0, page: 1, pageSize: 100,
    list: dispatched ? [{ orderId: "listed-offset-id", status: "FINISHED", txHash: HASH }] : [] } }));
  f.runner.replies.set("market-order swap", async () => { dispatched = true; return { kind: "ok", data: { orderId: "json-offset-id" }, sessionPresent: true, rwaTokens: null }; });
  f.chain.receipt = async () => { reads += 1; return reads === 1 ? null : receipt(); };
  const held: unknown[] = [], patchOrder = f.store.patchOrder.bind(f.store);
  t.mock.method(f.store, "patchOrder", async (...args: Parameters<AgenticStore["patchOrder"]>) => { if (args[1].holdReason !== undefined && args[1].holdReason !== null) held.push(args[1].holdReason); return patchOrder(...args); });
  const result = await executeAgenticTrade(f.input, f.execution), order = await f.store.getOrder(HASH);
  assert.equal(result.kind, "committed"); assert.equal(order?.outcome, "committed"); assert.equal(order?.txHash, HASH);
  assert.equal(reads, 2); assert.deepEqual(held, []);
});

test("AGENTIC-RECEIPT-WAIT F1: receipt-missing only at 30 min from createdAt", async t => {
  for (const [age, expected] of [[1_799_999, null], [1_800_000, "receipt-missing"]] as const) {
    const { f, pass } = await receiptWait(t, { createdAt: NOW - age });
    f.chain.receipt = async () => null;
    await pass();
    const row = (await f.store.getOrder(HASH))!;
    assert.equal(row.holdReason, expected, `age ${age}`); assert.equal(row.outcome, "open");
  }
});

test("AGENTIC-RECEIPT-WAIT F1: a receipt-missing row is re-examined and commits once the receipt reads", async t => {
  const { f, pass } = await receiptWait(t, { holdReason: "receipt-missing" });
  f.chain.receipt = async () => receipt();
  await pass();
  const row = (await f.store.getOrder(HASH))!;
  assert.equal(row.outcome, "committed"); assert.equal(row.holdReason, null);
  // a second unbound new row relabels the held row (fail closed, terminal)
  const crowded = await receiptWait(t, { holdReason: "receipt-missing" });
  crowded.f.runner.replies.set("market-order list", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: 2, page: 1, pageSize: 100,
    list: [{ orderId: "new", status: "FINISHED", txHash: HASH }, { orderId: "second", status: "FINISHED", txHash: HASH }] } });
  crowded.f.chain.receipt = async () => receipt();
  await crowded.pass();
  const relabelled = (await crowded.f.store.getOrder(HASH))!;
  assert.equal(relabelled.holdReason, "multiple-new-rows"); assert.equal(relabelled.outcome, "open");
});

for (const mutation of ["sender", "revert", "third-token", "inexact"] as const)
  test(`AGENTIC-RECEIPT-WAIT F1: a read receipt that does not match holds chain-verification at once (${mutation})`, async t => {
    const { f, pass } = await receiptWait(t);
    let proof = receipt("buy", mutation === "inexact" ? 4n * E : 5n * E);
    if (mutation === "sender") proof = { ...proof, from: TOKEN };
    if (mutation === "revert") proof = { ...proof, observation: { ...proof.observation, receipt: { ...proof.observation.receipt, status: 0n } } };
    if (mutation === "third-token") proof = { ...proof, observation: { ...proof.observation, receipt: { ...proof.observation.receipt, logs: [...proof.observation.receipt.logs, { ...proof.observation.receipt.logs[0]!, address: W }] } } };
    f.chain.receipt = async () => proof;
    await pass();
    const row = (await f.store.getOrder(HASH))!;
    assert.equal(row.holdReason, "chain-verification"); assert.equal(row.outcome, "open");
  });

test("AGENTIC-RECEIPT-WAIT F1: a landed partial sell still holds partial-sell", async t => {
  const { f, pass } = await receiptWait(t, sellOrder());
  f.chain.receipt = async () => receipt("sell", 4n * E, 4n * E);
  await pass();
  assert.equal((await f.store.getOrder(HASH))?.holdReason, "partial-sell");
});

test("AGENTIC-RECEIPT-WAIT F1: one receipt read per pass", async t => {
  for (const [patch, proof] of [[{}, receipt("buy", 4n * E)], [sellOrder(), receipt("sell", 4n * E, 4n * E)]] as const) {
    const { f, pass } = await receiptWait(t, patch); let reads = 0;
    f.chain.receipt = async () => { reads += 1; return proof; };
    await pass();
    assert.equal(reads, 1); assert.notEqual((await f.store.getOrder(HASH))?.holdReason, null);
  }
  const { f, pass } = await receiptWait(t); let reads = 0;
  f.chain.receipt = async () => { reads += 1; return reads === 1 ? receipt() : null; };
  await pass();
  const row = (await f.store.getOrder(HASH))!;
  assert.equal(row.outcome, "committed"); assert.equal(row.holdReason, null); assert.equal(reads, 1);
});

test("AGENTIC-RECEIPT-WAIT F1: FAILED with a hash waits on an unreadable receipt, then decides on the read one", async t => {
  const failed = { orderId: "new", status: "FAILED", txHash: HASH };
  const state = async (f: Awaited<ReturnType<typeof receiptWait>>["f"]) => { const row = (await f.store.getOrder(HASH))!; return [row.outcome, row.holdReason]; };
  const waiting = await receiptWait(t, {}, failed);
  waiting.f.chain.receipt = async () => null;
  await waiting.pass();
  assert.deepEqual(await state(waiting.f), ["open", null]);
  const reverted = await receiptWait(t, {}, failed);
  reverted.f.chain.receipt = async () => { const proof = receipt(); return { ...proof, observation: { ...proof.observation, receipt: { ...proof.observation.receipt, status: 0n } } }; };
  await reverted.pass();
  assert.deepEqual(await state(reverted.f), ["rolled-back", null]);
  const landed = await receiptWait(t, {}, failed);
  landed.f.chain.receipt = async () => receipt();
  await landed.pass();
  assert.deepEqual(await state(landed.f), ["open", "accepted-then-failed"]);
  const missing = await receiptWait(t, { createdAt: NOW - 1_800_000 }, failed);
  missing.f.chain.receipt = async () => null;
  await missing.pass();
  assert.deepEqual(await state(missing.f), ["open", "receipt-missing"]);
});

for (const reason of ["chain-verification", "partial-sell", "accepted-then-failed", "multiple-new-rows", "tx-already-bound"])
  test(`AGENTIC-RECEIPT-WAIT F1: an existing hold is never re-examined (${reason})`, async t => {
    const { f, pass } = await receiptWait(t, { holdReason: reason });
    f.chain.receipt = async () => receipt();
    await pass();
    const row = (await f.store.getOrder(HASH))!;
    assert.equal(row.holdReason, reason); assert.equal(row.outcome, "open");
    assert.equal(f.runner.calls.some(a => a[1] === "list"), false);
  });

test("AGENTIC-RECEIPT-WAIT F1: dispose --commit-tx still refuses an unreadable or mismatching hash", async t => {
  for (const proof of [null, { ...receipt(), from: TOKEN }]) {
    const { f, fence } = await receiptWait(t); await f.store.releaseFence(fence);
    f.chain.receipt = async () => proof;
    const context = { ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets: new Set([W]), print: () => undefined, cycle: async () => undefined };
    await assert.rejects(() => runAgenticGate(parseAgenticGateArgs(["dispose", "--order", HASH, "--commit-tx", HASH, "--attest", "offline reviewed evidence", "--yes-live"]), context), /AGENTIC_SWAP_UNVERIFIED/);
    const row = (await f.store.getOrder(HASH))!;
    assert.deepEqual([row.outcome, row.holdReason, (await f.journal.get(HASH))?.state], ["open", null, "UNKNOWN"]);
  }
});

test("AGENTIC-RECEIPT-WAIT F1: the per-cycle reconcile retries an unheld unresolved row", async t => {
  const { f, fence } = await receiptWait(t); await f.store.releaseFence(fence);
  t.mock.method(f.cmc, "refresh", async () => undefined);
  f.chain.receipt = async () => null;
  await runAgenticCycle(f.lifecycle, { reconciliationOnly: true });
  assert.deepEqual([(await f.store.getOrder(HASH))?.outcome, (await f.store.getOrder(HASH))?.holdReason], ["open", null]);
  f.chain.receipt = async () => receipt();
  await runAgenticCycle(f.lifecycle, { reconciliationOnly: true });
  assert.equal((await f.store.getOrder(HASH))?.outcome, "committed");
});

test("AGENTIC-RECEIPT-WAIT F1: after the owner signed out nothing is released and nothing is re-examined", async t => {
  const { f, pass, fence } = await receiptWait(t, { createdAt: NOW - 1_800_000 }, undefined, { state: "ended" });
  await f.store.createOrder(f.order({ idempotencyKey: "held-missing", dispatch: "spawned", response: "accepted", claimant: f.instance.row.instanceId, holdReason: "receipt-missing" }));
  f.chain.receipt = async () => receipt();
  await pass();
  await resolveAgenticOrder({ ...f.execution, journal: f.journal, order: (await f.store.getOrder("held-missing"))!, fence });
  assert.deepEqual([(await f.store.getOrder(HASH))?.outcome, (await f.store.getOrder(HASH))?.holdReason], ["open", null]);
  assert.deepEqual([(await f.store.getOrder("held-missing"))?.outcome, (await f.store.getOrder("held-missing"))?.holdReason], ["open", "receipt-missing"]);
  assert.equal(f.runner.calls.some(a => a[1] === "list"), false);
});

test("AGENTIC-RECEIPT-WAIT F1: an unheld waiting order delays the logout only to hireEndMs + 30 min", async t => {
  const hireEnd = NOW + 1_000, f = await fixture(t, { state: "ending", hireEndMs: hireEnd });
  await f.store.createOrder(f.order({ dispatch: "spawned", response: "accepted", claimant: f.instance.row.instanceId }));
  const signouts = () => f.runner.calls.filter(a => a[0] === "auth" && a[1] === "signout").length;
  f.setTime(hireEnd + 1_799_999); await resumeAgenticEnding(f.lifecycle, (await f.store.byAgent(f.agent.id))!);
  assert.equal(signouts(), 0);
  f.setTime(hireEnd + 1_800_000); await resumeAgenticEnding(f.lifecycle, (await f.store.byAgent(f.agent.id))!);
  assert.equal(signouts(), 1);
});

/** AGENTIC-RECEIPT-WAIT-2 A: an open sign row held approve-unverified (default HASH), a fence, and one resolver pass. */
const approveAbi = parseAbi(["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"]);
const approveReceipt = (patch: Partial<AgenticReceipt> = {}, status = 1n): AgenticReceipt => { const base = receipt();
  return { ...base, to: getAddress(USDT_56), input: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [CMC_PERMIT2, E] }),
    observation: { ...base.observation, receipt: { ...base.observation.receipt, status } }, ...patch }; };
async function approveWait(t: TestContext, patch: Partial<AgenticOrder> = {}, wallet: Partial<AgenticWallet> = {}) {
  const f = await fixture(t, wallet);
  await f.store.createOrder(f.order({ kind: "x402-sign", side: null, fromToken: null, toToken: null, operationId: "op", dispatch: "spawned", response: "accepted", cliResult: "signed",
    claimant: f.instance.row.instanceId, claimedAt: NOW, holdReason: "approve-unverified", approveTxHash: HASH, ...patch }));
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  const pass = async () => resolveAgenticOrder({ ...f.execution, journal: f.journal, order: (await f.store.getOrder(HASH))!, fence });
  return { f, pass, fence };
}

test("AGENTIC-RECEIPT-WAIT-2 A: an approve receipt unreadable past the 60 s loop commits the sign row on a later pass with dispose-equivalent evidence and makes no payment", async t => {
  t.mock.method(Date, "now", () => NOW);
  const f = await fixture(t); let paid = 0, signs = 0;
  const transport: CmcTransport = { async request(request) {
    if (request.headers === undefined) {
      const body = JSON.parse(request.body) as { params: { name: string } };
      const challenge = { x402Version: 2, resource: { url: "X402_" + body.params.name }, accepts: [{ scheme: "exact", network: "eip155:56", asset: USDT_56,
        amount: CMC_PRICE_ATOMIC.toString(), payTo: CMC_PAYEE, maxTimeoutSeconds: 500,
        extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact", spenderAddress: CMC_SPENDER, signerAddress: CMC_SIGNER, x402PaymentConfigId: CMC_CONFIG_ID } }] };
      return { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") }, body: "" };
    }
    paid += 1; return { status: 200, headers: {}, body: JSON.stringify({ result: { content: [] } }) };
  } };
  await f.store.createRun({ runId: "cmc-run", gate: "G0", agentId: f.agent.id, wallet: W, side: "none", maxDispatches: 1, dispatches: 0,
    maxNotionalUsdt: "0", maxCmcPayments: 1, cmcPayments: 0, cmcOperationIds: [], deadlineMs: NOW + 900_000, createdAt: NOW, closedAt: null });
  f.runner.replies.set("x402-payment preview", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { paymentId: "offline-payment",
    options: [{ index: 1, status: "READY_TO_SIGN", reasons: [], scheme: "exact", binanceChainId: "56", tokenAddress: USDT_56, tokenSymbol: "USDT", userWalletAddress: W,
      amount: "0.010000000000000000", payTo: CMC_PAYEE, needApproveFirst: true, assetTransferMethod: "permit2" }] } }));
  f.runner.replies.set("x402-payment sign", async () => {
    signs += 1;
    const payload = { x402Version: 2, payload: { signature: "0x" + "55".repeat(65), permit2Authorization: { from: W, spender: CMC_SPENDER,
      permitted: { token: USDT_56, amount: CMC_PRICE_ATOMIC.toString() }, nonce: "7", deadline: String(NOW / 1000 + 400), witness: { to: CMC_PAYEE, validAfter: "0" } } } };
    return { kind: "ok", sessionPresent: true, rwaTokens: null, data: { paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: Buffer.from(JSON.stringify(payload)).toString("base64"),
      signatureExpiresAt: NOW / 1000 + 400, approveTxHash: HASH } };
  });
  // The pinned clock would freeze the fence retry loop, so the mock handle is kept and restored right after the refresh.
  const clocks: { mock: { restore(): void } }[] = [];
  f.chain.receipt = async () => { const at = process.hrtime.bigint() + 61_000_000_000n; clocks.push(t.mock.method(process.hrtime, "bigint", () => at)); return null; };
  const cmc = createAgenticCmc({ ...f.execution, agents: f.agents, settings: f.settings, cmc: f.cmcStore, journal: f.journal, killswitch: f.killswitch,
    rpcUrls: ["offline://1", "offline://2", "offline://3"], transport, gateRunId: "cmc-run" });
  await cmc.enqueue(f.agent.id, ["NVDA"], ["MSFT"]); await cmc.refresh(f.agent.id);
  for (const clock of clocks.reverse()) clock.mock.restore();
  const stuck = (await f.store.orders(W)).find(o => o.kind === "x402-sign")!;
  assert.equal(stuck.outcome, "open"); assert.equal(stuck.holdReason, "approve-unverified"); assert.equal(paid, 0); assert.equal(signs, 1);
  const attempt = (await f.cmcStore.listAttempts(f.agent.id, W)).find(a => a.operationId === stuck.operationId)!;
  assert.equal(attempt.state, "released");
  const S0 = structuredClone(f.cmcStore.snapshot(f.agent.id)), C0 = f.runner.calls.length;
  const proof = approveReceipt();
  f.chain.receipt = async () => proof;
  const fence = (await f.store.acquireFence(W, f.instance.row.instanceId))!;
  await resolveAgenticOrder({ ...f.execution, journal: f.journal, order: (await f.store.getOrder(stuck.idempotencyKey))!, fence });
  const row = (await f.store.getOrder(stuck.idempotencyKey))!;
  assert.equal(row.outcome, "committed"); assert.equal(row.holdReason, null); assert.equal(row.approveTxHash, HASH);
  assert.deepEqual(row.evidence, { disposition: "approve-receipt", proof, quiescence: null });
  assert.deepEqual(f.cmcStore.snapshot(f.agent.id), S0); assert.equal(f.runner.calls.length, C0); assert.equal(paid, 0);
  assert.equal(await f.store.walletObligations(W), false);
  await cmc.runtime.close();
});

test("AGENTIC-RECEIPT-WAIT-2 A: the per-cycle reconcile commits an approve-unverified sign row once its receipt reads", async t => {
  const { f, fence } = await approveWait(t); await f.store.releaseFence(fence);
  f.chain.receipt = async () => null;
  await runAgenticCycle(f.lifecycle, { reconciliationOnly: true });
  assert.deepEqual([(await f.store.getOrder(HASH))?.outcome, (await f.store.getOrder(HASH))?.holdReason], ["open", "approve-unverified"]);
  f.chain.receipt = async () => approveReceipt();
  await runAgenticCycle(f.lifecycle, { reconciliationOnly: true });
  assert.deepEqual([(await f.store.getOrder(HASH))?.outcome, (await f.store.getOrder(HASH))?.holdReason], ["committed", null]);
});

test("AGENTIC-RECEIPT-WAIT-2 A: an unreadable approve receipt writes nothing on any pass", async t => {
  const { f, pass } = await approveWait(t);
  f.chain.receipt = async () => null;
  const before = structuredClone((await f.store.getOrder(HASH))!), patch = t.mock.method(f.store, "patchOrder");
  await pass(); await pass(); await pass();
  assert.equal(patch.mock.callCount(), 0); assert.deepEqual(await f.store.getOrder(HASH), before); assert.equal(await f.store.walletObligations(W), true);
});

for (const mutation of ["sender", "target", "spender", "transfer", "empty-input"] as const)
  test(`AGENTIC-RECEIPT-WAIT-2 A: a read receipt that is not the Permit2 approve holds chain-verification at once and is never re-examined (${mutation})`, async t => {
    const { f, pass } = await approveWait(t);
    const proof = mutation === "sender" ? approveReceipt({ from: TOKEN }) : mutation === "target" ? approveReceipt({ to: TOKEN })
      : mutation === "spender" ? approveReceipt({ input: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [TOKEN, E] }) })
      : mutation === "transfer" ? approveReceipt({ input: encodeFunctionData({ abi: approveAbi, functionName: "transfer", args: [CMC_PERMIT2, E] }) }) : approveReceipt({ input: "0x" });
    f.chain.receipt = async () => proof;
    await pass();
    const row = (await f.store.getOrder(HASH))!;
    assert.equal(row.holdReason, "chain-verification"); assert.equal(row.outcome, "open");
    let reads = 0; f.chain.receipt = async () => { reads += 1; return approveReceipt(); };
    const patch = t.mock.method(f.store, "patchOrder");
    await pass(); await pass();
    assert.equal((await f.store.getOrder(HASH))?.holdReason, "chain-verification"); assert.equal(patch.mock.callCount(), 0); assert.equal(reads, 0);
  });

test("AGENTIC-RECEIPT-WAIT-2 A: one receipt read per pass", async t => {
  for (const proof of [approveReceipt(), approveReceipt({ from: TOKEN }), null]) {
    const { f, pass } = await approveWait(t); let reads = 0;
    f.chain.receipt = async () => { reads += 1; return proof; };
    await pass();
    assert.equal(reads, 1);
  }
  const { f, pass } = await approveWait(t); let reads = 0;
  f.chain.receipt = async () => { reads += 1; return reads === 1 ? approveReceipt() : null; };
  await pass();
  const row = (await f.store.getOrder(HASH))!;
  assert.equal(row.outcome, "committed"); assert.equal(row.holdReason, null); assert.equal(reads, 1);
});

test("AGENTIC-RECEIPT-WAIT-2 A: a reverted Permit2 approve commits like the in-dispatch path", async t => {
  const { f, pass } = await approveWait(t);
  f.chain.receipt = async () => approveReceipt({}, 0n);
  await pass();
  const row = (await f.store.getOrder(HASH))!;
  assert.equal(row.outcome, "committed"); assert.equal((row.evidence as { disposition: string }).disposition, "approve-receipt");
});

test("AGENTIC-RECEIPT-WAIT-2 A: other sign rows are untouched while a valid approve receipt is readable", async t => {
  const cases: [string, Partial<AgenticOrder>][] = [
    ["a", { holdReason: "sign-failed", response: "no-response" }],
    ["b", { holdReason: "sign-recovery" }],
    ["d", { approveTxHash: null }],
    ["e", { outcome: "committed" }],
    ["g", { response: "no-response" }]];
  for (const [name, patch] of cases) {
    const { f, pass } = await approveWait(t, patch); let reads = 0;
    f.chain.receipt = async () => { reads += 1; return approveReceipt(); };
    const before = structuredClone((await f.store.getOrder(HASH))!);
    await pass();
    assert.deepEqual(await f.store.getOrder(HASH), before, name); assert.equal(reads, 0, name);
  }
  // (c) a recorded answer with no hash becomes sign-recovery exactly as today.
  const recovered = await approveWait(t, { holdReason: null, approveTxHash: null });
  recovered.f.chain.receipt = async () => approveReceipt();
  await recovered.pass();
  assert.equal((await recovered.f.store.getOrder(HASH))?.holdReason, "sign-recovery"); assert.equal((await recovered.f.store.getOrder(HASH))?.outcome, "open");
  // (f) a sealed row is terminalized as today.
  const sealed = await approveWait(t, { dispatch: "sealed" });
  sealed.f.chain.receipt = async () => approveReceipt();
  await sealed.pass();
  assert.equal((await sealed.f.store.getOrder(HASH))?.outcome, "rolled-back");
});

test("AGENTIC-RECEIPT-WAIT-2 A: after the owner signed out the per-cycle loop still resolves an approve-unverified sign row from chain reads only", async t => {
  const { f, fence } = await approveWait(t); await f.store.releaseFence(fence);
  await f.store.leaveBound(f.row, "owner-signed-out");
  assert.equal((await f.store.byAgent(f.agent.id))?.state, "ended");
  f.chain.receipt = async () => approveReceipt();
  const calls = f.runner.calls.length;
  await runAgenticCycle(f.lifecycle, { reconciliationOnly: true });
  assert.equal((await f.store.getOrder(HASH))?.outcome, "committed"); assert.equal(f.runner.calls.length, calls);
});

test("AGENTIC-RECEIPT-WAIT-2 A: dispose still resolves approve-unverified and chain-verification sign rows", async t => {
  const dispose = async (f: Awaited<ReturnType<typeof approveWait>>["f"], extra: string[]) => {
    const context = { ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets: new Set([W]), print: () => undefined, cycle: async () => undefined };
    await runAgenticGate(parseAgenticGateArgs(["dispose", "--order", HASH, ...extra, "--yes-live"]), context);
  };
  const ok = await approveWait(t); await ok.f.store.releaseFence(ok.fence);
  ok.f.chain.receipt = async () => approveReceipt();
  await dispose(ok.f, ["--approve-tx", HASH]);
  const done = (await ok.f.store.getOrder(HASH))!;
  assert.equal(done.outcome, "committed"); assert.equal((done.evidence as { disposition: string }).disposition, "approve-tx");
  const bad = await approveWait(t); await bad.f.store.releaseFence(bad.fence);
  bad.f.chain.receipt = async () => approveReceipt({ from: TOKEN });
  const before = structuredClone((await bad.f.store.getOrder(HASH))!);
  await assert.rejects(() => dispose(bad.f, ["--approve-tx", HASH]), /AGENTIC_APPROVAL_UNVERIFIED/);
  assert.deepEqual(await bad.f.store.getOrder(HASH), before);
  const held = await approveWait(t, { holdReason: "chain-verification" }); await held.f.store.releaseFence(held.fence);
  await dispose(held.f, ["--no-approve", "--attest", "offline reviewed evidence"]);
  const cleared = (await held.f.store.getOrder(HASH))!;
  assert.equal(cleared.outcome, "committed"); assert.equal((cleared.evidence as { disposition: string }).disposition, "no-approve");
});
