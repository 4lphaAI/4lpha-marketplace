import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { AgenticStore } from "../src/agentic/store.js";
import { AGENTIC_RECEIPT_TAG, agenticAddress, type AgenticWallet, type AgenticOrder } from "../src/agentic/domain.js";
import { createAgenticPublicView } from "../src/agentic/publicView.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeCmcStore, type CmcBudgetStore } from "../src/store/tradeCmc.js";
import { CMC_SKILL_SECTOR } from "../src/trade/cmcUsEquity.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest } from "../src/trade/settings.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { verifyAgenticSwap, type AgenticChain, type AgenticReceipt } from "../src/agentic/resolve.js";

const NOW = 1_900_000_000_000, W = agenticAddress("0x1111111111111111111111111111111111111111"),
  TOKEN = agenticAddress("0x2222222222222222222222222222222222222222"), HASH = `0x${"33".repeat(32)}` as Hex;
async function fixture() {
  const now = () => NOW, agents = new MemoryAgentStore(null, now), journal = new MemoryExecutionJournal(now),
    intents = new MemoryTradeIntentStore(now), cmc = new MemoryTradeCmcStore(now), killswitch = new MemoryKillSwitch(),
    positions = new MemoryTradePositionStore(now), settings = new MemoryTradeSettingsStore(agents, now);
  const store = new AgenticStore(null, { agents, journal, intents, cmc, killswitch }, now);
  const agentId = "audit-agent";
  await agents.createAgent({ id: agentId, ownerAddress: W, walletAddress: W, custodyModel: "binance-agentic", status: "armed" });
  const params = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi" as const, settlementAsset: "USDT" as const,
    entryWei: "5000000000000000000", minEntryWei: "5000000000000000000", capitalQuoteWei: "20000000000000000000", cmcNewsEnabled: true, cmcTotalBudgetWei: "2000000000000000000" };
  await settings.put({ agentId, ownerAddress: W, params, digest: tradeSettingsDigest(params) });
  const row: AgenticWallet = { pairingId: "audit-pairing", state: "bound", walletAddress: W, ownerAddress: W,
    pairingSecretHash: "private", qr: null, codeHash: "private", codeAttempts: 0, codeMatchedAt: NOW, verifiedAt: NOW,
    continuationDeadline: NOW + 1_800_000, sessionCiphertext: null,
    factsRead: { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 200,
      quotaUsed: 0, x402DailyLimit: 1, x402QuotaUsed: 0, signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: "100", bnbWei: "100" },
    hireOpId: HASH, agentId, hireParams: null, hireStage: "active", acceptedAt: NOW,
    hireFacts: { acceptedAtMs: NOW, acceptedDedicatedWalletAtMs: NOW, termSec: 604_800, termEndAction: "keep", hireEndMs: NOW + 604_800_000,
      entryCutoffMs: NOW + 597_600_000, signInMaxTimeMs: NOW + 90 * 86_400_000, pinned: [TOKEN], quoteDayCapWei: "1", budgetWei: "1",
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" } },
    hireEndMs: NOW + 604_800_000, entryCutoffMs: NOW + 597_600_000, termEndAction: "keep", drainRequestedAt: null,
    settingsHold: null, entriesStopped: null, probe: null, endReason: null, endBlockers: null, endStage: null, logout: null,
    cleanupReason: null, failure: null, version: 1, createdAt: NOW, updatedAt: NOW };
  assert.equal(await store.createWallet(row), true);
  for (const instanceId of ["holder", "other-holder"]) await store.registerInstance({ instanceId, service: "trade-worker", host: "offline", pid: 1,
    machineId: "offline", osBootMarker: "boot", railwayDeploymentId: null, railwayReplicaId: null, bootAt: NOW,
    heartbeatAt: NOW, retiredAt: null, retiredBy: null });
  const order: AgenticOrder = { idempotencyKey: HASH, kind: "swap", walletAddress: W, agentId, decisionId: "decision", side: "buy",
    fromToken: TOKEN, toToken: TOKEN, amountAtomic: "1", intendedRaw: null, fromQty: "1", minOutAtomic: "1", binanceQuoteOutAtomic: "1",
    slippagePct: "1", multiplierPre: "1", multiplierUsed: null, listSnapshot: null, operationId: null, walletNoncePre: null,
    quoteAt: NOW, dispatch: "unclaimed", claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null,
    response: null, cliResult: null, returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null,
    outcome: "open", holdReason: null, evidence: null, fillCheck: "none", createdAt: NOW, updatedAt: NOW };
  await store.beginSwap(order, { idempotencyKey: HASH, agentId, ownerAddress: W, kind: "trade", decisionId: "decision", nativeSpendWei: 0n }, NOW);
  const fence = (await store.acquireFence(W, "holder"))!;
  return { store, agents, journal, intents, cmc, killswitch, positions, settings, row, order, fence, agentId };
}

for (const condition of ["positive", "stale-token-same-holder", "wrong-holder-same-token"] as const) {
  test("memory claim independently enforces " + condition, async () => {
    const f = await fixture();
    const fence = condition === "stale-token-same-holder" ? { ...f.fence, token: (BigInt(f.fence.token) - 1n).toString() }
      : condition === "wrong-holder-same-token" ? { ...f.fence, holder: "other-holder" } : f.fence;
    const result = await f.store.claimOrder(f.order, fence);
    assert.equal(result !== null, condition === "positive");
    assert.equal((await f.store.getOrder(HASH))?.dispatch, condition === "positive" ? "spawned" : "unclaimed");
  });
}

test("production Agentic receipt tag equals the literal Revision 7.1 contract", () => {
  assert.equal(AGENTIC_RECEIPT_TAG, "0x4f21ff96e0d93f9fc1c3efaf0c55d3578e1a223c4c4fc997b53f6f9f91b8c472");
});

test("production verified swap fill uses the literal Revision 7.1 receipt ownership key", async () => {
  const f = await fixture(), blockHash = `0x${"44".repeat(32)}` as Hex, logIndex = 7n;
  const topic = (address: Address) => ("0x" + address.slice(2).padStart(64, "0")) as Hex;
  const transfer = keccak256(stringToBytes("Transfer(address,address,uint256)"));
  const proof: AgenticReceipt = { from: W, to: TOKEN, input: "0x", observation: { chainId: 56,
    transaction: { hash: HASH, to: TOKEN, input: "0x", blockNumber: 1n, blockHash, transactionIndex: 0n },
    receipt: { status: 1n, transactionHash: HASH, blockNumber: 1n, blockHash, transactionIndex: 0n, logs: [
      { address: USDT_56, topics: [transfer, topic(W), topic(TOKEN)], data: ("0x" + "1".padStart(64, "0")) as Hex, logIndex: 1n },
      { address: TOKEN, topics: [transfer, topic(TOKEN), topic(W)], data: ("0x" + "2".padStart(64, "0")) as Hex, logIndex }], },
    receiptBlock: { number: 1n, hash: blockHash }, finalizedBlock: { number: 1n, hash: blockHash } } };
  const chain: AgenticChain = { balance: async () => 0n, metadata: async () => ({ decimals: 18, symbol: "STOCK" }),
    multiplier: async () => 1n, code: async () => "0x", nonce: async () => 0n, receipt: async hash => { assert.equal(hash, HASH); return proof; } };
  const result = await verifyAgenticSwap(chain, { ...f.order, fromToken: agenticAddress(USDT_56) }, HASH);
  assert.ok(result);
  assert.equal(result.fill.receiptOwnershipKey,
    `56|${HASH.toLowerCase()}|${W.toLowerCase()}|${logIndex}|0x4f21ff96e0d93f9fc1c3efaf0c55d3578e1a223c4c4fc997b53f6f9f91b8c472`);
});

// The bStock companion event seen in the first live Agentic buy (tx 0x8193...0129, log 229) must not break receipt verification.
const COMPANION = "0x0226a2f5c1ae0e071aeec3d4ebafcefdc5c549be11f40ed27e76e802acccf374" as Hex;
const INTCB = agenticAddress("0xe614e2fc6c787035ff51f452e8e826bfd32d5283"), ROUTER = agenticAddress("0xb300000b72deaeb607a12d5f54773d1c19c7028d");
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const pad = (address: Address) => ("0x" + address.slice(2).padStart(64, "0")) as Hex;
const TRANSFER_TOPIC = keccak256(stringToBytes("Transfer(address,address,uint256)")), APPROVAL_TOPIC = keccak256(stringToBytes("Approval(address,address,uint256)"));
type Log = AgenticReceipt["observation"]["receipt"]["logs"][number];
function companionReceipt(side: "buy" | "sell", companion: Partial<Log> = {}, extra: readonly Log[] = []): AgenticReceipt {
  const blockHash = `0x${"44".repeat(32)}` as Hex, spent = 5_000_000_000_000_000_000n, got = 42_331_817_194_027_885n;
  const logs: Log[] = side === "buy" ? [
    { address: USDT_56, topics: [TRANSFER_TOPIC, pad(W), pad(ROUTER)], data: ("0x" + word(spent)) as Hex, logIndex: 213n },
    { address: USDT_56, topics: [APPROVAL_TOPIC, pad(W), pad(ROUTER)], data: ("0x" + word(0n)) as Hex, logIndex: 214n },
    { address: TOKEN, topics: [TRANSFER_TOPIC, pad(TOKEN), pad(ROUTER)], data: ("0x" + word(1n)) as Hex, logIndex: 220n },
    { address: INTCB, topics: [TRANSFER_TOPIC, pad(ROUTER), pad(W)], data: ("0x" + word(got)) as Hex, logIndex: 228n },
    { address: INTCB, topics: [COMPANION, pad(ROUTER), pad(W)], data: ("0x" + word(got) + word(got)) as Hex, logIndex: 229n, ...companion }, ...extra]
    : [{ address: INTCB, topics: [TRANSFER_TOPIC, pad(W), pad(ROUTER)], data: ("0x" + word(got)) as Hex, logIndex: 10n },
      { address: INTCB, topics: [COMPANION, pad(W), pad(ROUTER)], data: ("0x" + word(got) + word(got)) as Hex, logIndex: 11n, ...companion },
      { address: USDT_56, topics: [TRANSFER_TOPIC, pad(ROUTER), pad(W)], data: ("0x" + word(spent)) as Hex, logIndex: 12n }, ...extra];
  return { from: W, to: ROUTER, input: "0x", observation: { chainId: 56, transaction: { hash: HASH, to: ROUTER, input: "0x", blockNumber: 1n, blockHash, transactionIndex: 0n },
    receipt: { status: 1n, transactionHash: HASH, blockNumber: 1n, blockHash, transactionIndex: 0n, logs }, receiptBlock: { number: 1n, hash: blockHash }, finalizedBlock: { number: 1n, hash: blockHash } } };
}
const companionChain = (proof: AgenticReceipt): AgenticChain => ({ balance: async () => 0n, metadata: async () => ({ decimals: 18, symbol: "INTCB" }), multiplier: async () => 1n,
  code: async () => "0x", nonce: async () => 0n, receipt: async () => proof });

test("bStock companion event: the live buy receipt verifies with the exact input and output", async () => {
  const f = await fixture(), order = { ...f.order, side: "buy" as const, fromToken: agenticAddress(USDT_56), toToken: INTCB, amountAtomic: "5000000000000000000", intendedRaw: null };
  const result = await verifyAgenticSwap(companionChain(companionReceipt("buy")), order, HASH);
  assert.ok(result); assert.equal(result.input, 5_000_000_000_000_000_000n); assert.equal(result.output, 42_331_817_194_027_885n);
  assert.equal(result.fill.side, "buy");
});

test("bStock companion event: a malformed companion or any unknown topic from a granted token touching the wallet is refused", async () => {
  const f = await fixture(), order = { ...f.order, side: "buy" as const, fromToken: agenticAddress(USDT_56), toToken: INTCB, amountAtomic: "5000000000000000000", intendedRaw: null };
  const got = 42_331_817_194_027_885n, check = async (companion: Partial<Log>, extra: readonly Log[] = []) => verifyAgenticSwap(companionChain(companionReceipt("buy", companion, extra)), order, HASH);
  assert.equal(await check({ data: ("0x" + word(got)) as Hex }), null);
  assert.equal(await check({ topics: [COMPANION, pad(ROUTER), pad(W), pad(ROUTER)] }), null);
  assert.equal(await check({ data: ("0x" + word(got) + word(got) + word(got)) as Hex }), null);
  assert.equal(await check({ topics: ["0x" + "99".repeat(32) as Hex, pad(ROUTER), pad(W)] }), null);
  assert.equal(await check({}, [{ address: INTCB, topics: ["0x" + "98".repeat(32) as Hex, pad(ROUTER), pad(W)], data: ("0x" + word(1n)) as Hex, logIndex: 230n }]), null);
  assert.equal(await check({}, [{ address: agenticAddress("0x3333333333333333333333333333333333333333"), topics: [TRANSFER_TOPIC, pad(ROUTER), pad(W)], data: ("0x" + word(1n)) as Hex, logIndex: 231n }]), null);
  assert.ok(await check({}, [{ address: agenticAddress("0x3333333333333333333333333333333333333333"), topics: [TRANSFER_TOPIC, pad(ROUTER), pad(ROUTER)], data: ("0x" + word(1n)) as Hex, logIndex: 232n }]));
});

test("bStock companion event: a sell receipt with the companion on the sold token verifies", async () => {
  const f = await fixture(), sold = 42_331_817_194_027_885n;
  const order = { ...f.order, side: "sell" as const, fromToken: INTCB, toToken: agenticAddress(USDT_56), intendedRaw: sold.toString(), amountAtomic: null };
  const result = await verifyAgenticSwap(companionChain(companionReceipt("sell")), order, HASH);
  assert.ok(result); assert.equal(result.input, sold); assert.equal(result.output, 5_000_000_000_000_000_000n); assert.equal(result.fill.side, "sell");
});

test("production public DTO has exactly the recursive Revision 7.3 key sets", async () => {
  const f = await fixture();
  await f.store.patchWallet(f.row, { state: "ended", endReason: "term-ended" });
  await f.positions.open({ positionId: "private-position", agentId: f.agentId, ownerAddress: W, token: TOKEN,
    route: { hops: [], fees: [] }, entryWei: 1n, tokenAmount: 2n, fillStatus: "verified", openedAt: NOW });
  await f.positions.insertRun({ agentId: f.agentId, ownerAddress: W, dryRun: false, reason: "private",
    events: [{ stage: "cycle", code: "held", elapsedMs: 0, reason: "private", token: TOKEN }] });
  const view = createAgenticPublicView({ ...f, cmc: cmcWith(f, [newsRow({ paymentOperationId: "op-raw" })], [attemptRow({})]), observer: { observe: async () => [{ positionId: "private-position", symbol: "STOCK", decimals: 18,
    recordedPositionAmount: "2", liveWalletBalance: "2", currentQuoteWei: "3", pnlBps: "1", quoteStatus: "quoted", reason: "private", observedAt: NOW }] } });
  const result = await view(W), a = result.agent;
  const keys = (value: object | null, expected: string) => { assert.ok(value); assert.deepEqual(Object.keys(value).sort(), expected.split(" ").sort()); };
  keys(result, "wallet custody agent"); assert.ok(a);
  keys(a, "name status holdCode endReason termDays termEndAction hireStartedAtMs entryCutoffAtMs hireEndsAtMs connection lastProbeAtMs heldOrders logoutPending settings limits cmc summary positions events runs pinned cmcLog");
  keys(a.settings, "executionModel primaryModel capitalQuoteWei entryWei minEntryWei maxOpenPositions slippageBps stopLossBps takeProfitBps maxHoldSec");
  keys(a.limits, "readAtMs dailyLimit quotaLeft x402DailyLimit x402QuotaLeft tradeAllTokens abnormalTxnHandling signInMaxTimeMs");
  keys(a.cmc, "authorizedTotalWei settledWei remainingWei status");
  keys(a.summary, "openPositions maxOpenPositions closedTrades wins winRateBps grossDeltaWei grossComplete");
  assert.equal(a.positions.length, 1); assert.equal(a.events.length, 1);
  for (const p of a.positions) {
    keys(p, "ref token symbol decimals status openedAt closedAt entryUsdtWei tokenAmount exitUsdtWei pnlBps closeReason entryTxHash exitTxHash unsold live");
    keys(p.unsold, "code atMs"); keys(p.live, "liveWalletBalance currentQuoteWei quoteStatus");
  }
  for (const e of a.events) keys(e, "atMs stage code token");
  assert.equal(a.pinned.length, 1); for (const p of a.pinned) keys(p, "address symbol");
  keys(a.cmcLog, "news attempts"); assert.equal(a.cmcLog.news.length, 1); assert.equal(a.cmcLog.attempts.length, 1);
  for (const n of a.cmcLog.news) keys(n, "ticker skill status asOfMs expiresAtMs sourceUrl paymentOperationId requestedBy requestReason context");
  for (const t of a.cmcLog.attempts) keys(t, "operationId attemptId state contentState amountWei txHash settlementTxHint createdAt updatedAt");
  assert.equal(a.runs.length, 1);
  for (const r of a.runs) {
    keys(r, "id dryRun reason candidates refusals entries exits createdAt events");
    for (const e of r.events) keys(e, "stage code elapsedMs token");
  }
});

/** A CMC store whose lists are fixed rows; the records carry private fields (nonce, authorization) that must never reach the public view. */
function cmcWith(f: { cmc: MemoryTradeCmcStore }, news: readonly object[], attempts: readonly object[]): CmcBudgetStore {
  return { get: (agentId: string, owner: Address) => f.cmc.get(agentId, owner), listNews: async () => news, listAttempts: async () => attempts } as unknown as CmcBudgetStore;
}
const newsRow = (over: object) => ({ agentId: "private-agent", ownerAddress: W, ticker: "NVDAB", skill: CMC_SKILL_SECTOR, generation: 0, status: "available", context: "ctx",
  sourceUrl: null, publishedAtMs: null, payloadHash: HASH, paymentOperationId: null, asOfMs: NOW, expiresAtMs: NOW + 1000, ...over });
const attemptRow = (over: object) => ({ operationId: "op-raw", attemptId: "attempt-raw", agentId: "private-agent", ownerAddress: W, wallet: W, nonce: 7n,
  encryptedAuthorization: "private-authorization", requestDigest: HASH, bodyHash: HASH, state: "settled", contentState: "available", amountWei: 10_000n,
  txHash: HASH, settlementTxHint: null, createdAt: NOW, updatedAt: NOW, ...over });
const opaqueOf = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

test("public CMC log: opaque ids that still pair, current skills only, 50 caps, sanitized reason, no payment fields", async () => {
  const f = await fixture();
  const news = [
    newsRow({ ticker: "NVDAB", paymentOperationId: "op-raw", requestedBy: "llm", requestReason: "r".repeat(400), context: "a\u0000b\u0007c\nd" }),
    newsRow({ ticker: "_PROBE" }), newsRow({ ticker: "OLDB", skill: "us_equity_research_dossier" }),
    ...Array.from({ length: 60 }, (_, i) => newsRow({ ticker: "T" + i })),
  ];
  const attempts = [attemptRow({ settlementTxHint: "private-not-a-hash" }), attemptRow({ operationId: "op-two", attemptId: "attempt-two", settlementTxHint: HASH, txHash: null }),
    ...Array.from({ length: 60 }, (_, i) => attemptRow({ operationId: "op" + i, attemptId: "at" + i }))];
  const view = createAgenticPublicView({ ...f, cmc: cmcWith(f, news, attempts), observer: { observe: async () => [] } });
  const log = (await view(W)).agent!.cmcLog, text = JSON.stringify(log);
  assert.equal(log.news.length, 50); assert.equal(log.attempts.length, 50);
  assert.equal(log.news.some(r => r.ticker === "_PROBE" || r.ticker === "OLDB"), false);
  const first = log.news[0]!, paid = log.attempts[0]!;
  assert.equal(first.paymentOperationId, opaqueOf("op-raw")); assert.equal(paid.operationId, opaqueOf("op-raw")); assert.equal(paid.attemptId, opaqueOf("attempt-raw"));
  assert.equal(first.requestedBy, "llm"); assert.ok(first.requestReason!.length <= 280); assert.equal(first.context, "abc\nd");
  assert.equal(paid.settlementTxHint, null); assert.equal(log.attempts[1]!.settlementTxHint, HASH); assert.equal(paid.amountWei, "10000");
  for (const hidden of ["op-raw", "attempt-raw", "op-two", "private-authorization", "private-not-a-hash", "private-agent", "nonce", "requestDigest", "bodyHash"]) assert.equal(text.includes(hidden), false, hidden);
});

test("public pinned: the lane ticker resolves from the map and falls back to null", async () => {
  const f = await fixture();
  const observer = { observe: async () => [] };
  const named = (await createAgenticPublicView({ ...f, observer, symbols: () => new Map([[TOKEN.toLowerCase(), "STOCK"]]) })(W)).agent!;
  assert.deepEqual(named.pinned, [{ address: TOKEN, symbol: "STOCK" }]);
  for (const symbols of [undefined, () => undefined, () => new Map<string, string>()]) {
    const bare = (await createAgenticPublicView({ ...f, observer, ...(symbols === undefined ? {} : { symbols }) })(W)).agent!;
    assert.deepEqual(bare.pinned, [{ address: TOKEN, symbol: null }]);
  }
});

test("public runs: opaque id, LLM reasons only, 50 cap, sanitized, closed run reason", async () => {
  const f = await fixture();
  await f.store.patchWallet(f.row, { state: "ended", endReason: "term-ended" });
  const long = "x".repeat(400) + " sk-abcdefghijklmnop";
  // A ticking clock so the newest run is deterministic (a fixed clock ties all 55 and the order falls to random ids).
  let tick = NOW;
  const positions = new MemoryTradePositionStore(() => (tick += 1000));
  for (let i = 0; i < 55; i += 1) await positions.insertRun({ agentId: f.agentId, ownerAddress: W, dryRun: false, reason: i === 54 ? "agent-error:private detail;candidates=1" : "at-capacity;candidates=0;refusals=0",
    events: i === 54 ? [
      { stage: "exit-llm", code: "exit", elapsedMs: 1200, model: "m", confidence: 80, token: TOKEN, reason: long },
      { stage: "entry-llm", code: "feature-ready", elapsedMs: 5, token: TOKEN, reason: "momentum:ok; snapshot:private-snapshot-id" },
      { stage: "screen", code: "portfolio-proof-conflict", elapsedMs: 7, token: TOKEN, reason: "private-decision-id" },
    ] : [] });
  const view = createAgenticPublicView({ ...f, positions, observer: { observe: async () => [] } });
  const a = (await view(W)).agent!, text = JSON.stringify(a.runs);
  assert.equal(a.runs.length, 50);
  const raw = await positions.listRuns(W, f.agentId, 50);
  for (const r of a.runs) { assert.match(r.id, /^[0-9a-f]{16}$/u); assert.equal(raw.some(x => x.id === r.id), false); }
  const run = a.runs.find(r => r.events.length === 3)!;
  assert.ok(run);
  assert.equal(run.reason, "agent-error;candidates=1");
  const [llm, feature, screen] = run.events;
  assert.ok(llm!.reason !== undefined && llm!.reason.length <= 280 && !llm!.reason.includes("sk-abcdefghijklmnop"));
  assert.equal(llm!.model, "m"); assert.equal(llm!.confidence, 80);
  assert.equal("reason" in feature!, false); assert.equal("reason" in screen!, false);
  for (const hidden of ["private-snapshot-id", "private-decision-id", "private detail"]) assert.equal(text.includes(hidden), false, hidden);
});
