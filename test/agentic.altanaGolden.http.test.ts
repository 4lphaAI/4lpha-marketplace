import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { getAddress, type Hex } from "viem";
import type { CustodyModel } from "../src/core/types.js";
import { buildAccountPortfolio } from "../src/account/portfolio.js";
import { MemoryAgentStore, type AgentStore } from "../src/store/agents.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { DEFAULT_TRADE_SETTINGS, parseTradeSettings, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { DCA_POOLS_56 } from "../src/trade/dca.js";
import { PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { call, createHarness, NOW_SEC, ownerAccount, signOwnerAction, toReadHeader, tradeConfig } from "./support/serverHarness.js";
import { dcaSettings } from "./support/dcaFixtures.js";
import { altanaAgentStore } from "../src/agentic/domain.js";

test("Agentic golden Altana: AI, schedule, DCA, portfolio views, account and both revoke forms", async context => {
  const now = NOW_SEC * 1_000;
  context.mock.method(Date, "now", () => now);
  const wallet = getAddress("0x2222222222222222222222222222222222222222");
  const tokens = [getAddress("0x3333333333333333333333333333333333333333"), getAddress("0x4444444444444444444444444444444444444444")];
  const venues = { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, pancakeRouterV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56 };
  const ai: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
    minEntryWei: "10000000000000000000", entryWei: "10000000000000000000", capitalQuoteWei: "1000000000000000000000",
    maxOpenPositions: 1, cmcNewsEnabled: false, stopLossBps: null, takeProfitBps: null, maxHoldSec: null,
    breakEvenAfterTp: false, noReentry: false, crashProtection: false };
  const settings: readonly TradeSettings[] = [ai,
    { ...ai, tradeMode: "schedule", scheduleToken: tokens[0]!.toLowerCase(), scheduleIntervalSec: 3_600,
      scheduleFirstAtSec: null, scheduleEndKind: "budget", scheduleEndAtSec: null, scheduleEndRuns: null,
      scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150 },
    dcaSettings(),
    { ...ai, entryWei: ai.capitalQuoteWei!, minEntryWei: "100000000000000000", tradeMode: "portfolio", portfolioTokens: DCA_POOLS_56.slice(0, 2).map(p => p.stock.toLowerCase()), portfolioWeightsBps: [5000, 5000],
      portfolioDriftBps: 500, portfolioIntervalSec: 14_400 },
  ];
  const transcripts: unknown[] = [];
  for (const hidden of [false, "other-owner", "same-owner"]) {
    const rows: unknown[] = [];
    for (const [index, params] of settings.entries()) {
      const parsed = parseTradeSettings(params);
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
      const memory = new MemoryAgentStore(null, () => now);
      const agents = new Proxy(memory, { get(target, property, receiver): unknown {
        if (property === "durable" || property === "keyEncryptionConfigured") return true;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      } }) as AgentStore;
      const settingsStore = new MemoryTradeSettingsStore(agents, () => now);
      const positions = new MemoryTradePositionStore(() => now);
      const intents = new MemoryTradeIntentStore(() => now);
      const spec = tradeSessionSpec({ venues, tokens: tokens.map(token => ({ token })),
        nativeCaps: [{ limit: 10n ** 18n, period: "day" }], quoteToken: USDT_56,
        quoteDailyCapWei: 5_000n * 10n ** 18n, quotePerTradeCapWei: 10n * 10n ** 18n,
        nowSeconds: NOW_SEC, expiresAt: NOW_SEC + 3_600, platformFeeBps: 0 });
      await agents.createAgent({ id: "golden", ownerAddress: ownerAccount.address, walletAddress: wallet,
        custodyModel: "passkey", status: "armed", httpRuntimeProfile: "trade-v1",
        sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: `0x04${"77".repeat(64)}` as Hex,
          expiry: spec.expiresAt, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT" } } });
      await settingsStore.put({ agentId: "golden", ownerAddress: ownerAccount.address, params, digest: tradeSettingsDigest(params) });
      if (hidden) await agents.createAgent({ id: "agentic-fixture", ownerAddress: hidden === "same-owner" ? ownerAccount.address : tokens[0]!, walletAddress: tokens[1]!,
        custodyModel: "binance-agentic" as CustodyModel, status: "revoked" });
      const visible = altanaAgentStore(agents);
      const h = await createHarness({ seedAgent: false, agentStore: visible,
        config: { chainId: 56, network: "mainnet", hireEnabled: true, tradeAgentEnabled: true, trade: tradeConfig({ venues }),
          passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true } },
        hire: { nfpm: tokens[0]!, routerV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56, treasury: tokens[1]!,
          feeBps: 0, relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n,
          evidence: { readFunding: async () => { throw new Error("Unexpected funding read."); },
            readGrant: async () => { throw new Error("Unexpected grant read."); } } },
        tradeAgent: { settingsStore, positions, intents, feeBps: 0,
          readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(tokens.map(t => t.toLowerCase())), stop() {} },
          dataPlane: { universe: async () => [], tokensBatch: async () => [], eligibilityBatch: async () => [], security: async () => ({}) },
          observer: { observe: async () => [] } } });
      const read = await signOwnerAction("read", {}, { agentId: "golden", chainId: 56, network: "mainnet", nonce: `0x${"11".repeat(32)}` });
      const view = await call(h, "/agents/golden/trade/view", { headers: { "x-owner-action": toReadHeader(read) } });
      const owner = await call(h, "/agents/golden/owner-view", { headers: { "x-owner-action": toReadHeader(read) } });
      assert.equal(view.status, 200, view.text);
      assert.equal(owner.status, 200, owner.text);
      const account = await buildAccountPortfolio(ownerAccount.address, { agents: visible, provider: h.provider, dataPlane: h.dataPlane,
        chainId: 56, wbnb: WBNB_56, now: () => now });
      const revokeParams = index === 0 ? { keepPositions: true } : {};
      if (index === 1) await settingsStore.requestDrain(ownerAccount.address, "golden");
      const revoke = await signOwnerAction("revoke", revokeParams, { agentId: "golden", chainId: 56, network: "mainnet", nonce: `0x${"22".repeat(32)}` });
      const removed = index < 2 ? await call(h, "/agents/golden/revoke", { method: "POST", body: revoke }) : null;
      if (removed !== null) assert.equal(removed.status, 200, removed.text);
      rows.push({ view: view.text, owner: owner.text, account, revoke: removed?.text ?? null,
        settings: await settingsStore.get(ownerAccount.address, "golden"), positions: await positions.list(ownerAccount.address, "golden"),
        calls: h.provider.executeCalls, restores: h.provider.restoreCalls });
    }
    transcripts.push(rows);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(transcripts[2], transcripts[0]);
  const bytes = JSON.stringify(transcripts[0], (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "0916ef52f772ecae16e1356c6056aedbadfbee4bde604525425c664b8b69008f");
});
