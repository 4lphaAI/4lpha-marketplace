import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, type Hex } from "viem";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest } from "../src/trade/settings.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { AgenticStore } from "../src/agentic/store.js";
import { AGENTIC_RECEIPT_TAG, type AgenticWallet } from "../src/agentic/domain.js";

test("Agentic partial disposition leaves a pending intent and therefore cannot release the wallet barrier", async () => {
  const now = () => 1_900_000_000_000;
  const W = getAddress("0x1111111111111111111111111111111111111111");
  const token = getAddress("0x2222222222222222222222222222222222222222");
  const hash = `0x${"33".repeat(32)}` as Hex;
  const agents = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const intents = new MemoryTradeIntentStore(now);
  const positions = new MemoryTradePositionStore(now);
  const settingsStore = new MemoryTradeSettingsStore(agents, now);
  const cmc = new MemoryTradeCmcStore(now);
  const killswitch = new MemoryKillSwitch();
  const agentId = "agentic-partial";
  await agents.createAgent({ id: agentId, ownerAddress: W, walletAddress: W, custodyModel: "binance-agentic", status: "revoked" });
  const params = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi" as const, settlementAsset: "USDT" as const,
    entryWei: "5000000000000000000", minEntryWei: "5000000000000000000", capitalQuoteWei: "20000000000000000000", cmcNewsEnabled: false };
  await settingsStore.put({ agentId, ownerAddress: W, params, digest: tradeSettingsDigest(params) });
  await positions.open({ positionId: "position", agentId, ownerAddress: W, token, route: { hops: [], fees: [] },
    entryWei: 5n, tokenAmount: 5n, fillStatus: "verified", openedAt: now(), settlementAsset: "USDT",
    requestedEntryAtomic: 5n, verifiedEntryAtomic: 5n, receiptOwnershipKey: `56|${hash}|${W}|0|${AGENTIC_RECEIPT_TAG}` });
  await intents.create({ decisionId: "partial", idempotencyKey: hash, agentId, ownerAddress: W, side: "sell", token,
    route: { hops: [], fees: [] }, amountWei: 5n, entryWei: 5n, positionId: "position", closeReason: "owner-request", settlementAsset: "USDT" });
  await journal.begin({ idempotencyKey: hash, agentId, ownerAddress: W, kind: "trade", decisionId: "partial" });
  await journal.markCommitted(hash, { txHash: hash });
  const deps = { agentStore: agents, settingsStore, positions, intents, journal,
    provider: { getTokenBalance: async () => 3n },
    recoverFill: async () => ({ side: "sell", exitWei: 2n, fillStatus: "verified", receiptOwnershipKey: `56|${hash}|${W}|1|${AGENTIC_RECEIPT_TAG}` }),
    readiness: { ready: false, allowlistAvailable: true, bstocksAddresses: new Set<string>() }, now,
  } as unknown as TradeWorkerDeps;
  await runTradeWorkerOnce(deps);
  assert.equal((await intents.get(W, agentId, "partial"))?.state, "pending");
  assert.equal((await positions.get(W, agentId, "position"))?.status, "open");
  const store = new AgenticStore(null, { agents, journal, intents, cmc, killswitch }, now);
  const history: AgenticWallet = { pairingId: "11111111-1111-4111-8111-111111111111", state: "ended", walletAddress: W, ownerAddress: W,
    pairingSecretHash: "fixture", qr: null, codeHash: "fixture", codeAttempts: 0, codeMatchedAt: null, verifiedAt: null,
    continuationDeadline: null, sessionCiphertext: null, factsRead: null, hireOpId: null, agentId, hireParams: null,
    hireStage: null, acceptedAt: null, hireFacts: null, hireEndMs: null, entryCutoffMs: null, termEndAction: "keep", drainRequestedAt: null,
    settingsHold: null, entriesStopped: null, probe: null, endReason: "owner-signed-out", endBlockers: null, endStage: null,
    logout: null, cleanupReason: null, failure: null, version: 1, createdAt: now(), updatedAt: now() };
  assert.equal(await store.createWallet(history), true);
  assert.equal((await store.orders(W)).length, 0);
  assert.equal(await store.walletObligations(W), true);
});
