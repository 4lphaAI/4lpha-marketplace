import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, keccak256, stringToBytes, toFunctionSelector, type Hex } from "viem";
import type { CustodyModel } from "../src/core/types.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { MemoryAgentStore, type AgentStore, type PendingGrant } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { DEFAULT_TRADE_SETTINGS, type TradeSettings } from "../src/trade/settings.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { GrantEvidenceReader, GrantEvidenceSnapshot } from "../src/wallet/grantEvidence.js";
import type { TradeAgentServerDeps } from "../src/server.js";
import { call, createHarness, NOW_SEC, ownerAccount, signOwnerAction, tradeConfig } from "./support/serverHarness.js";
import { altanaAgentStore } from "../src/agentic/domain.js";

const WALLET = getAddress("0x2000000000000000000000000000000000000002");
const ROUTER = getAddress("0x5000000000000000000000000000000000000005");
const ROUTER_V3 = getAddress("0x5100000000000000000000000000000000000005");
const WBNB = getAddress("0x6000000000000000000000000000000000000006");
const KEYSTORE = getAddress("0x8000000000000000000000000000000000000008");
const NFPM = getAddress("0x9000000000000000000000000000000000000009");
const TOKENS = Array.from({ length: 6 }, (_, i) => getAddress(`0x${(101 + i).toString(16).padStart(40, "0")}`));
const E = 10n ** 18n;
const CAP = 30_000_000_000_000_000n;
const SETUP_COST = 7n;
const CAPITAL = 60n * E;
const DATA = 2n * E;
const KEY = `0x04${"77".repeat(64)}` as Hex;
const OWNER = ownerAccount.address;
const SETTINGS: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
  minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: CAPITAL.toString(),
  cmcNewsEnabled: true, cmcTotalBudgetWei: DATA.toString() };
const READ_CONFIG = { key: parseAccountReadSessionSecret("cd".repeat(32))!, chainId: 56,
  environment: resolveDomainSalt({ chainId: 56, network: "mainnet" }) };

function exactEvidence(pending: PendingGrant): GrantEvidenceSnapshot {
  return { relayKeys: [{ hash: pending.accountKeyHash, expiry: pending.expiresAt, role: "session",
    permissions: { calls: [...pending.permissions.calls.map(rule => ({ ...("to" in rule ? { to: rule.to } : {}),
      ...("signature" in rule ? { signature: toFunctionSelector(rule.signature) } : {}) })),
      { to: "0xaf140d0416a994aebb3fa6212b16ce6700f09751", signature: "0x32323232" }], spend: pending.permissions.spend } }],
    accountKey: { expiry: pending.expiresAt, isSuperAdmin: false }, accountSpend: pending.permissions.spend,
    canExecute: [...pending.permissions.calls.map(() => true), true],
    keyStore: { kind: "registered", publicKey: pending.sessionPublicKey }, ownerVerdict: "verified" };
}

async function fixture(resume?: TradeAgentServerDeps["cmcOwnerResumePending"]) {
  const memory = new MemoryAgentStore(null, () => NOW_SEC * 1000, { chainId: 56, keyStoreAddress: KEYSTORE });
  const store = new Proxy(memory, { get(target, property, receiver): unknown {
    if (property === "durable" || property === "keyEncryptionConfigured") return true;
    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } }) as AgentStore;
  const settingsStore = new MemoryTradeSettingsStore(store, () => NOW_SEC * 1000);
  const positions = new MemoryTradePositionStore(() => NOW_SEC * 1000);
  const intents = new MemoryTradeIntentStore(() => NOW_SEC * 1000);
  const cmc = new MemoryTradeCmcStore(() => NOW_SEC * 1000);
  const balances = { native: CAP + SETUP_COST, grantExact: false, fundingReads: 0 };
  const evidence: GrantEvidenceReader = {
    readFunding: async (_wallet, headroom, observedAtSec) => { balances.fundingReads += 1; return {
      version: 1, observedAtSec, registrationFeeWei: "2", registrations: 2, relayGasHeadroomWei: headroom.toString(),
      requiredWei: SETUP_COST.toString(), balanceWei: balances.native.toString() }; },
    readGrant: async pending => balances.grantExact ? exactEvidence(pending) : { relayKeys: [], accountKey: null,
      accountSpend: [], canExecute: [], keyStore: { kind: "missing" }, ownerVerdict: "verified" },
  };
  const venues = { chainId: 56, pancakeRouterV2: ROUTER, pancakeRouterV3: ROUTER_V3, wbnb: WBNB };
  const harness = await createHarness({ seedAgent: false, agentStore: altanaAgentStore(store),
    journal: new MemoryExecutionJournal(() => NOW_SEC * 1000),
    keyStoreReader: { listKeys: async () => [], publicKeyFor: async () => KEY, isValidKey: async () => false },
    tradeAgent: { settingsStore, positions, intents, cmc, ...(resume === undefined ? {} : { cmcOwnerResumePending: resume }), feeBps: 0,
      readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(TOKENS.map(token => token.toLowerCase())), stop() {} },
      tradfiV2CapabilityProbe: async () => "capable" as const,
      dataPlane: { universe: async lane => lane === "bstocks" ? TOKENS.map((address, i) => ({ address, symbol: `STK${i}`, lane,
        source: "fixture", rwa: { platform: "bstocks", underlyingTicker: `STK${i}`, tokenPriceUsd: 1, referencePriceUsd: 1,
          premiumBps: 0, openState: true, marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1,
          // R3.1 (D3 seam): an AI-mode pin only admits a direct-venue candidate - this
          // file is about funding checks, not pinning, so give every token one
          // admitted venue rather than relying on the (now AI-irrelevant) capability probe.
          onchainPriceUsd: 1, venues: [{ dex: "pancakeswap" as const, version: "v2" as const, pool: address,
            feeTier: null, quote: USDT_56, quoteSymbol: "USDT", priceUsd: 1, liquidityUsd: 50_000, volume24hUsd: 1, asOf: NOW_SEC * 1_000 }] } })) : [],
        tokensBatch: async addresses => addresses.map(address => ({ address, symbol: "STOCK", priceUsd: 1, marketCapUsd: 1_000_000_000,
          volume24hUsd: 10_000, holders: 100, priceChange24hPct: 0 })), eligibilityBatch: async () => [], security: async () => ({}) },
      observer: { observe: async () => [] } },
    config: { chainId: 56, network: "mainnet", keyStore: KEYSTORE, hireEnabled: true, tradeAgentEnabled: true,
      accountReadSession: READ_CONFIG, trade: tradeConfig({ venues }),
      passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true } },
    hire: { evidence, nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB, treasury: OWNER, feeBps: 0,
      relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n } });
  harness.provider.tokenBalances.set(USDT_56.toLowerCase(), CAPITAL + DATA);
  return { harness, store, settingsStore, positions, intents, cmc, balances, venues };
}

async function provision(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const envelope = await signOwnerAction("provisionAgent", { walletAddress: WALLET, capDayWei: CAP.toString(), ttlSec: 3600,
    sizingPreset: "trade-v1", executionModel: "tradfi", hireRunId: "11111111-1111-4111-8111-111111111111", autoGrant: true, settings: SETTINGS },
  { agentId: id, chainId: 56, network: "mainnet", nonce: keccak256(stringToBytes("harness-nonce-1")) });
  const response = await call(f.harness, `/agents/${id}/session`, { method: "POST", body: envelope });
  assert.equal(response.status, 200, response.text);
  return envelope;
}

import crypto from "node:crypto";

test("Agentic golden Altana: S1 TradFi hire", async context => {
  context.mock.method(Date, "now", () => NOW_SEC * 1000);
  context.mock.method(globalThis.crypto, "getRandomValues", (array: Uint8Array) => { array.fill(7); return array; });
  for (const withAgenticRows of [false, true]) {
  const f = await fixture();
  if (withAgenticRows) await f.store.createAgent({ id: "agentic-golden", ownerAddress: OWNER, walletAddress: TOKENS[1]!,
    custodyModel: "binance-agentic" as CustodyModel, status: "armed" });
  const envelope = await provision(f, "golden-hire");
  const row = await f.store.getAgent(OWNER, "golden-hire");
  assert.equal(row?.status, "provisioning");
  const replay = await call(f.harness, "/agents/golden-hire/session", { method: "POST", body: envelope });
  assert.equal(replay.status, 200, replay.text);
  const bytes = JSON.stringify({ response: replay.text, agent: row,
    settings: await f.settingsStore.get(OWNER, "golden-hire"),
    budget: await f.cmc.get("golden-hire", OWNER),
    journal: await f.harness.journal.listNonTerminal(),
    calls: f.harness.provider.executeCalls,
  }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "846476677940565af0bf76b6a940ef2600ca47140115c29e20f90485ba62f750");
  }
});
