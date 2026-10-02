import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import type { KeyStoreReader } from "../src/account/keyStoreReader.js";
import type { GrantEvidenceReader } from "../src/wallet/grantEvidence.js";
import { TRADFI_GUARD_SWAP_SELECTOR, tradeSessionSpec } from "../src/ops/policy.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import { FLAP_PORTAL_56, FOUR_MEME_TOKEN_MANAGER_56, PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, UNISWAP_V3_ROUTER02_56, WBNB_56 } from "../src/ops/venues.js";
import { MemoryAgentStore, type AgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { DCA_POOLS_56 } from "../src/trade/dca.js";
import { tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { tradfiPortfolioNativeReserveWei } from "../src/trade/sizing.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { TradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import type { TradeReadiness } from "../src/trade/readiness.js";
import { call, createHarness, EXEC_TOKEN, NOW_SEC, ownerAccount, signOwnerAction, toReadHeader, tradeConfig, type Harness, type SignedEnvelope } from "./support/serverHarness.js";

const UNIT = 10n ** 18n;
const WALLET = getAddress("0x2000000000000000000000000000000000000002");
const KEYSTORE = getAddress("0x8000000000000000000000000000000000000008");
const TREASURY = getAddress("0x7000000000000000000000000000000000000007");
const GUARD = getAddress("0x9000000000000000000000000000000000009000");
const PUBLIC_KEY = `0x04${"ab".repeat(64)}` as Hex;
const STOCKS = DCA_POOLS_56.slice(0, 2).map((pool) => pool.stock);
const CAP = tradfiPortfolioNativeReserveWei({ tokenCount: 2, intervalSec: 86400 });
const VENUES = { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, pancakeRouterV3: PANCAKE_V3_ROUTER_56,
  uniswapRouterV3: UNISWAP_V3_ROUTER02_56, fourMemeTokenManager: FOUR_MEME_TOKEN_MANAGER_56, flapPortal: FLAP_PORTAL_56, wbnb: WBNB_56 };

function settings(patch: Partial<TradeSettings> = {}): TradeSettings {
  return { name: "Portfolio", executionModel: "tradfi", settlementAsset: "USDT", entryWei: (50n * UNIT).toString(),
    minEntryWei: UNIT.toString(), capitalQuoteWei: (50n * UNIT).toString(), maxOpenPositions: 1,
    minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null,
    breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null,
    primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false, cmcNewsEnabled: false,
    tradeMode: "portfolio", portfolioTokens: STOCKS.map((stock) => stock.toLowerCase()), portfolioWeightsBps: [5000, 5000],
    portfolioDriftBps: 500, portfolioIntervalSec: 86400, ...patch };
}

async function fixture(enabled = true, withQuotes = true) {
  const memory = new MemoryAgentStore(null, () => NOW_SEC * 1_000, { chainId: 56, keyStoreAddress: KEYSTORE });
  const store = new Proxy(memory, { get(target, property, receiver): unknown {
    if (property === "durable" || property === "keyEncryptionConfigured") return true;
    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } }) as AgentStore;
  const journal = new MemoryExecutionJournal(() => NOW_SEC * 1_000);
  const settingsStore = new MemoryTradeSettingsStore(store, () => NOW_SEC * 1_000);
  const positions = new MemoryTradePositionStore(() => NOW_SEC * 1_000);
  const intents = new MemoryTradeIntentStore(() => NOW_SEC * 1_000);
  let pinReads = 0;
  let quoteThrows = false;
  let valueUnavailable = false;
  let metadataFails = false;
  let displayName: string | undefined;
  const dataPlane: TradeDataPlaneReads = { async universe(lane) { pinReads += 1; if (metadataFails) throw new Error("offline metadata failure"); return lane === "bstocks" ? STOCKS.map((address, index) =>
    ({ address: index === 0 ? address.toLowerCase() as Address : address, symbol: DCA_POOLS_56[index]!.symbol,
      ...(displayName === undefined || index !== 0 ? {} : { name: displayName }), lane: "bstocks" as const, source: "fixture" })) : []; },
    async tokensBatch(addresses) { return addresses.map((address) => ({ address, symbol: "USDT", priceUsd: 1, marketCapUsd: 1,
      volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: NOW_SEC * 1_000 })); },
    async eligibilityBatch() { return []; }, async security() { return { data: {}, meta: {} }; } };
  const readiness: TradeReadiness = { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(STOCKS.map((stock) => stock.toLowerCase())), stop() {} };
  const evidence: GrantEvidenceReader = { async readFunding(_wallet, relayGasHeadroomWei, observedAtSec) {
    return { version: 1, observedAtSec, registrationFeeWei: "2", registrations: 2,
      relayGasHeadroomWei: relayGasHeadroomWei.toString(), requiredWei: "7", balanceWei: "1000000000000000000" };
  }, async readGrant() { return { relayKeys: [], accountKey: null, accountSpend: [], canExecute: [], keyStore: { kind: "missing" }, ownerVerdict: "verified" }; } };
  const keyStoreReader: KeyStoreReader = { async listKeys() { return []; }, async publicKeyFor() { return `0x${"22".repeat(64)}` as Hex; },
    async isValidKey() { return false; }, async finalizedBlock() { throw new Error("unavailable"); },
    async blockAt(blockNumber) { return { number: blockNumber, hash: `0x${"91".repeat(32)}` as Hex }; },
    async listKeysAt() { return []; }, async publicKeyForAt() { return PUBLIC_KEY; }, async isValidKeyAt() { return false; } };
  const harness = await createHarness({ seedAgent: false, agentStore: store, journal, keyStoreReader,
    tradeAgent: { settingsStore, positions, intents, dataPlane, readiness, feeBps: 100, portfolio: { enabled },
      guardVerified: async () => true, observer: { async observe() { throw new Error("portfolio view reached position observer"); } },
      ...(withQuotes ? { scheduleQuotes: { async buy(input: { readonly token: Address; readonly amountInAtomic: bigint }) { if (quoteThrows) throw new Error("no quote"); return { venue: "pancake_v3", router: PANCAKE_V3_ROUTER_56,
        route: { hops: [], fees: [2500] }, settlementToken: USDT_56, token: input.token, amountInAtomic: input.amountInAtomic,
        quotedOutAtomic: input.amountInAtomic, minOutAtomic: input.amountInAtomic, observedAt: NOW_SEC * 1_000, expiresAt: NOW_SEC * 1_000 + 30_000 }; },
        async sell(input: { readonly amountInAtomic: bigint }) { return { quotedOutAtomic: input.amountInAtomic }; } } } : {}),
      portfolioValue: async ({ amountInAtomic }) => valueUnavailable ? null : amountInAtomic },
    config: { chainId: 56, network: "mainnet", keyStore: KEYSTORE, hireEnabled: true,
      accountReadSession: { key: parseAccountReadSessionSecret("cd".repeat(32))!, chainId: 56,
        environment: resolveDomainSalt({ chainId: 56, network: "mainnet" }) },
      tradeAgentEnabled: true, executeRawEnabled: false, trade: tradeConfig({ venues: VENUES, feeTreasury: TREASURY, aggregatorGuard: GUARD }),
      passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true } },
    hire: { evidence, nfpm: NFPM_56, routerV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56, treasury: TREASURY, feeBps: 100,
      relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n } });
  harness.provider.tokenBalances.set(USDT_56.toLowerCase(), 100n * UNIT);
  return { harness, store, journal, settingsStore, positions, intents, pinReads: () => pinReads,
    setDisplayName: (value: string | undefined) => { displayName = value; },
    setMetadataFails: (value: boolean) => { metadataFails = value; },
    setQuoteThrows: (value: boolean) => { quoteThrows = value; }, setValueUnavailable: (value: boolean) => { valueUnavailable = value; } };
}

function query(patch: Record<string, string> = {}): string {
  return new URLSearchParams({ walletAddress: WALLET, capDayWei: CAP.toString(), sizingPreset: "trade-v1", executionModel: "tradfi",
    entryWei: (50n * UNIT).toString(), maxOpenPositions: "1", settlementAsset: "USDT", minEntryWei: UNIT.toString(),
    capitalQuoteWei: (50n * UNIT).toString(), cmcNewsEnabled: "false", tradeMode: "portfolio",
    portfolioTokens: STOCKS.map((stock) => stock.toLowerCase()).join(","), portfolioIntervalSec: "86400", ...patch }).toString();
}

function hireParams(value = settings(), capDayWei = CAP) {
  return { walletAddress: WALLET, capDayWei: capDayWei.toString(), ttlSec: 604800, sizingPreset: "trade-v1", executionModel: "tradfi",
    hireRunId: "33333333-3333-4333-8333-333333333333", autoGrant: true, settings: value };
}

async function signed(action: "provisionAgent" | "tradeSettings" | "tradeExit" | "tradeDrain" | "revoke" | "read" | "renewSession", id: string, params: unknown) {
  return signOwnerAction(action, params, { agentId: id, chainId: 56, network: "mainnet" });
}
const post = (harness: Harness, path: string, envelope: SignedEnvelope) => call(harness, path, { method: "POST", body: envelope });
const code = (body: unknown): string | undefined => (body as { error?: { code?: string } }).error?.code;

async function seed(f: Awaited<ReturnType<typeof fixture>>, id: string, expired = false) {
  const spec = tradeSessionSpec({ venues: VENUES, treasury: TREASURY, tokens: STOCKS.map((token) => ({ token })),
    nativeCaps: [{ limit: CAP, period: "day" }], quoteToken: USDT_56, quoteDailyCapWei: 250n * UNIT,
    quotePerTradeCapWei: 50n * UNIT, platformFeeBps: 0, expiresAt: NOW_SEC + (expired ? -1 : 604800), nowSeconds: NOW_SEC - (expired ? 3600 : 0) });
  await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET, custodyModel: "passkey", status: "armed", httpRuntimeProfile: "trade-v1",
    sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: PUBLIC_KEY, expiry: spec.expiresAt,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", entryWei: (50n * UNIT).toString(),
        minEntryWei: UNIT.toString(), quotePerTradeWei: (50n * UNIT).toString(), capitalQuoteWei: (50n * UNIT).toString(), cmcNewsEnabled: false } } });
  await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address, params: settings(), digest: tradeSettingsDigest(settings()) });
  return spec;
}

describe("Smart Portfolio plane preview and provision", () => {
  it("portfolio signed hire survives signer, BFF raw-body pass-through and parseTradeHireParams with both arrays", async () => {
    const bff = readFileSync(new URL("../web/app/api/agents/[id]/session/route.ts", import.meta.url), "utf8");
    assert.match(bff, /execOwnerMutation\(`\/agents\/\$\{encodeURIComponent\(id\)\}\/session`, rawBody\)/u);
    const f = await fixture();
    const id = "portfolio-wire";
    const envelope = await signed("provisionAgent", id, hireParams());
    const forwarded = JSON.parse(JSON.stringify(envelope)) as SignedEnvelope;
    const response = await post(f.harness, `/agents/${id}/session`, forwarded);
    assert.equal(response.status, 200, response.text);
    const saved = (await f.store.getAgentById(id))?.pendingGrant?.initialTradeSettings?.params as TradeSettings | undefined;
    assert.deepEqual(saved?.portfolioTokens, STOCKS.map((stock) => stock.toLowerCase()));
    assert.deepEqual(saved?.portfolioWeightsBps, [5000, 5000]);
  });

  it("refuses flag-off and unsupported tokens, then previews the two-stock zero-fee grant without a pin", async () => {
    const off = await fixture(false);
    const disabled = await off.harness.app.request(`/agents/hire/preview?${query()}`, { headers: { "x-exec-token": EXEC_TOKEN } });
    assert.equal(disabled.status, 400);
    assert.equal(code(await disabled.json()), "portfolio_disabled");
    const f = await fixture();
    const unsupported = await f.harness.app.request(`/agents/hire/preview?${query({ portfolioTokens: [STOCKS[0], "0x9999999999999999999999999999999999999999"].join(",").toLowerCase() })}`, { headers: { "x-exec-token": EXEC_TOKEN } });
    assert.equal(code(await unsupported.json()), "portfolio_token_unsupported");
    const incomplete = new URLSearchParams(query());
    incomplete.delete("portfolioIntervalSec");
    const invalid = await f.harness.app.request(`/agents/hire/preview?${incomplete}`, { headers: { "x-exec-token": EXEC_TOKEN } });
    assert.equal(code(await invalid.json()), "invalid_request");
    const response = await f.harness.app.request(`/agents/hire/preview?${query()}`, { headers: { "x-exec-token": EXEC_TOKEN } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: { sizing: Record<string, unknown>; pin: readonly { address: string }[] } };
    assert.equal(f.pinReads(), 0);
    assert.deepEqual(body.data.pin.map((row) => row.address.toLowerCase()), STOCKS.map((stock) => stock.toLowerCase()));
    assert.equal(body.data.sizing["tradeMode"], "portfolio");
    assert.equal(body.data.sizing["nativeReserveWei"], CAP.toString());
    assert.equal(body.data.sizing["platformFeeBps"], 0);
    assert.equal(body.data.sizing["quotePerTradeWei"], undefined);
  });

  it("portfolio hire query accepts new and legacy leg minimums only", async () => {
    const f = await fixture();
    for (const minEntryWei of [UNIT / 10n, UNIT, UNIT / 2n]) {
      const response = await f.harness.app.request(`/agents/hire/preview?${query({ minEntryWei: minEntryWei.toString() })}`,
        { headers: { "x-exec-token": EXEC_TOKEN } });
      assert.equal(response.status, minEntryWei === UNIT / 2n ? 400 : 200);
      const body = await response.json() as { data?: { sizing: { minEntryWei: string } } };
      if (minEntryWei === UNIT / 2n) assert.equal(code(body), "invalid_request");
      else assert.equal(body.data?.sizing.minEntryWei, minEntryWei.toString());
    }
  });

  it("refuses provision before any write, then grants exactly two stocks plus USDT without treasury", async () => {
    const off = await fixture(false);
    const denied = await post(off.harness, "/agents/portfolio-off/session", await signed("provisionAgent", "portfolio-off", hireParams()));
    assert.equal(code(denied.body), "portfolio_disabled");
    assert.equal(await off.store.getAgentById("portfolio-off"), null);
    const f = await fixture();
    const noQuotes = await fixture(true, false);
    const noSeam = await post(noQuotes.harness, "/agents/portfolio-seam/session", await signed("provisionAgent", "portfolio-seam", hireParams()));
    assert.equal(code(noSeam.body), "trade_not_ready");
    assert.equal(await noQuotes.store.getAgentById("portfolio-seam"), null);
    const tooLittleBnb = await post(f.harness, "/agents/portfolio-cap/session", await signed("provisionAgent", "portfolio-cap", hireParams(settings(), CAP - 1n)));
    assert.equal(code(tooLittleBnb.body), "capital_too_small");
    assert.match((tooLittleBnb.body as { error: { message: string } }).error.message, /BNB day cap of at least/u);
    assert.equal(await f.store.getAgentById("portfolio-cap"), null);
    f.setQuoteThrows(true);
    const noQuote = await post(f.harness, "/agents/portfolio-quote/session", await signed("provisionAgent", "portfolio-quote", hireParams()));
    assert.equal(code(noQuote.body), "portfolio_token_unquotable");
    f.setQuoteThrows(false);
    const response = await post(f.harness, "/agents/portfolio-ok/session", await signed("provisionAgent", "portfolio-ok", hireParams()));
    assert.equal(response.status, 200, response.text);
    const pending = (await f.store.getAgentById("portfolio-ok"))?.pendingGrant;
    assert.ok(pending);
    assert.deepEqual(pending.sessionSpec.spendCaps.filter((cap) => cap.token !== undefined).map((cap) => cap.token?.toLowerCase()).sort(),
      [...STOCKS.map((stock) => stock.toLowerCase()), USDT_56.toLowerCase()].sort());
    assert.equal(pending.sessionSpec.allowedCalls.some((rule) => rule.to?.toLowerCase() === USDT_56.toLowerCase() && rule.selector === "transfer(address,uint256)"), false);
    assert.equal(pending.sizing.quotePerTradeWei, (50n * UNIT).toString());
  });
});

describe("Smart Portfolio owner routes", () => {
  it("accepts a slippage-only edit with global 100 bps, but rejects basket edits and both sell doors", async () => {
    const f = await fixture();
    const id = "portfolio-edit";
    await seed(f, id);
    const edit = await post(f.harness, `/agents/${id}/trade/settings`, await signed("tradeSettings", id, { ...settings(), slippageBps: 150 }));
    assert.equal(edit.status, 200, edit.text);
    const locked = await post(f.harness, `/agents/${id}/trade/settings`, await signed("tradeSettings", id, { ...settings(), portfolioWeightsBps: [6000, 4000] }));
    assert.equal(locked.status, 400);
    assert.match((locked.body as { error: { message: string } }).error.message, /portfolioWeightsBps cannot be changed/u);
    const ai = structuredClone(settings()) as Record<string, unknown>;
    for (const key of ["tradeMode", "portfolioTokens", "portfolioWeightsBps", "portfolioDriftBps", "portfolioIntervalSec"]) delete ai[key];
    const mode = await post(f.harness, `/agents/${id}/trade/settings`, await signed("tradeSettings", id, ai));
    assert.equal(mode.status, 400);
    assert.match((mode.body as { error: { message: string } }).error.message, /tradeMode cannot be changed/u);
    const exit = await post(f.harness, `/agents/${id}/trade/positions/p-1/exit`, await signed("tradeExit", id, { positionId: "p-1" }));
    assert.equal(code(exit.body), "portfolio_no_sell");
    const drain = await post(f.harness, `/agents/${id}/trade/drain`, await signed("tradeDrain", id, {}));
    assert.equal(code(drain.body), "portfolio_no_sell");
  });

  it("renews the grant verbatim with zero wallet USDT and no pin", async () => {
    const f = await fixture();
    const id = "portfolio-renew";
    const spec = await seed(f, id, true);
    f.harness.provider.tokenBalances.set(USDT_56.toLowerCase(), 0n);
    const renewal = await post(f.harness, `/agents/${id}/session/renew`, await signed("renewSession", id, { ttlSec: 3600 }));
    assert.equal(renewal.status, 200, renewal.text);
    const prepared = (await f.store.getAgentById(id))?.pendingRenewal?.sessionSpec;
    assert.ok(prepared);
    assert.deepEqual(prepared.spendCaps, spec.spendCaps);
    assert.deepEqual(prepared.allowedCalls, [...spec.allowedCalls, { to: GUARD, selector: TRADFI_GUARD_SWAP_SELECTOR }]);
    assert.equal(f.pinReads(), 0);
    const retry = await post(f.harness, `/agents/${id}/session/renew`, await signed("renewSession", id, { ttlSec: 3600 }));
    assert.equal(retry.status, 200, retry.text);
    assert.notEqual(code(retry.body), "renewal_underfunded");
  });

  it("revoke refuses a PENDING leg, then permits an UNKNOWN leg and writes status and kill switch", async () => {
    const f = await fixture();
    const id = "portfolio-revoke";
    await seed(f, id);
    const key = `0x${"33".repeat(32)}` as Hex;
    await f.intents.create({ decisionId: "pending-sale", idempotencyKey: key, agentId: id, ownerAddress: ownerAccount.address,
      side: "sell", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: 0n,
      positionId: "pending-sale", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
    await f.journal.begin({ idempotencyKey: key, agentId: id, ownerAddress: ownerAccount.address, kind: "trade", decisionId: "pending-sale" });
    const pending = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(pending.status, 409, pending.text);
    await f.journal.markUnknown(key, "relay timeout");
    const unknown = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(unknown.status, 200, unknown.text);
    assert.equal((await f.store.getAgentById(id))?.status, "revoked");
    assert.equal(await f.harness.killswitch.isAgentPaused(id, ownerAccount.address), true);
    assert.equal((await f.intents.listUnsettled(ownerAccount.address, id)).length, 1);
  });

  it("portfolio pause waits for the entire entry fence and stops later submissions", async () => {
    const f = await fixture();
    const id = "portfolio-pause";
    await seed(f, id);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const prior = f.settingsStore.withEntryFence(ownerAccount.address, id, async () => { entered?.(); await hold; order.push("submitter-exit"); });
    await inside;
    let attempted: (() => void) | undefined;
    const atFence = new Promise<void>((resolve) => { attempted = resolve; });
    const originalFence = f.settingsStore.withEntryFence.bind(f.settingsStore);
    f.settingsStore.withEntryFence = async (owner, agentId, work) => { attempted?.(); return originalFence(owner, agentId, work); };
    const pause = post(f.harness, `/agents/${id}/pause`, await signOwnerAction("pause", {}, { agentId: id, chainId: 56, network: "mainnet" }));
    const settled = pause.then(() => { order.push("action-resolved"); return "action" as const; });
    try {
      assert.equal(await Promise.race([atFence.then(() => "fence" as const), settled]), "fence");
      assert.equal(await Promise.race([settled, new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")))]), "pending");
      assert.equal((await f.store.getAgentById(id))?.status, "armed");
    } finally { release?.(); await prior; }
    const response = await pause;
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(order, ["submitter-exit", "action-resolved"]);
    assert.equal((await f.store.getAgentById(id))?.status, "paused");
    assert.equal(await f.harness.killswitch.isAgentPaused(id, ownerAccount.address), true);
    let laterSubmissions = 0;
    await originalFence(ownerAccount.address, id, async () => { if ((await f.store.getAgentById(id))?.status === "armed") laterSubmissions += 1; });
    assert.equal(laterSubmissions, 0);
  });

  it("portfolio revoke waits for the entry fence before completing Remove", async () => {
    const f = await fixture();
    const id = "portfolio-revoke-barrier";
    await seed(f, id);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const prior = f.settingsStore.withEntryFence(ownerAccount.address, id, async () => { entered?.(); await hold; order.push("submitter-exit"); });
    await inside;
    let attempted: (() => void) | undefined;
    const atFence = new Promise<void>((resolve) => { attempted = resolve; });
    const originalFence = f.settingsStore.withEntryFence.bind(f.settingsStore);
    f.settingsStore.withEntryFence = async (owner, agentId, work) => { attempted?.(); return originalFence(owner, agentId, work); };
    const revoke = post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    const settled = revoke.then(() => { order.push("action-resolved"); return "action" as const; });
    try {
      assert.equal(await Promise.race([atFence.then(() => "fence" as const), settled]), "fence");
      assert.equal(await Promise.race([settled, new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")))]), "pending");
      assert.equal((await f.store.getAgentById(id))?.status, "armed");
    } finally { release?.(); await prior; }
    const response = await revoke;
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(order, ["submitter-exit", "action-resolved"]);
    assert.equal((await f.store.getAgentById(id))?.status, "revoked");
    assert.equal(await f.harness.killswitch.isAgentPaused(id, ownerAccount.address), true);
    let laterSubmissions = 0;
    await originalFence(ownerAccount.address, id, async () => { if ((await f.store.getAgentById(id))?.status === "armed") laterSubmissions += 1; });
    assert.equal(laterSubmissions, 0);
  });

  it("a draining entry fence still lets portfolio pause and revoke finish", async () => {
    const paused = await fixture();
    const id = "portfolio-draining-pause";
    await seed(paused, id);
    await paused.settingsStore.requestDrain(ownerAccount.address, id);
    let called = false;
    const gate = await paused.settingsStore.withEntryFence(ownerAccount.address, id, async () => { called = true; });
    assert.equal(gate.kind, "draining");
    assert.equal(called, false);
    const pause = await post(paused.harness, `/agents/${id}/pause`, await signOwnerAction("pause", {}, { agentId: id, chainId: 56, network: "mainnet" }));
    assert.equal(pause.status, 200, pause.text);
    assert.equal((await paused.store.getAgentById(id))?.status, "paused");
    const revoked = await fixture();
    const revokeId = "portfolio-draining-revoke";
    await seed(revoked, revokeId);
    await revoked.settingsStore.requestDrain(ownerAccount.address, revokeId);
    const response = await post(revoked.harness, `/agents/${revokeId}/revoke`, await signed("revoke", revokeId, {}));
    assert.equal(response.status, 200, response.text);
    assert.equal((await revoked.store.getAgentById(revokeId))?.status, "revoked");
  });

  it("view shows the portfolio ledger and nulls all aggregate values when a pinned quote fails", async () => {
    const f = await fixture();
    const id = "portfolio-view";
    await seed(f, id);
    f.harness.provider.tokenBalances.set(STOCKS[0]!.toLowerCase(), 25n * UNIT);
    f.harness.provider.tokenBalances.set(STOCKS[1]!.toLowerCase(), 25n * UNIT);
    const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    assert.equal(response.status, 200, response.text);
    const portfolio = (response.body as { data: { portfolio: Record<string, unknown> } }).data.portfolio;
    assert.equal(portfolio["stockValueWei"], (50n * UNIT).toString());
    assert.equal((portfolio["tokens"] as unknown[]).length, 2);
    assert.equal((portfolio["check"] as unknown), null);
    f.setValueUnavailable(true);
    const unavailable = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    assert.equal(unavailable.status, 200, unavailable.text);
    const dashed = (unavailable.body as { data: { portfolio: Record<string, unknown> } }).data.portfolio;
    assert.equal(dashed["stockValueWei"], null);
    assert.equal(dashed["totalValueWei"], null);
    assert.equal(dashed["pnlWei"], null);
    assert.equal(dashed["driftBps"], null);
    assert.ok((dashed["tokens"] as { weightBps: number | null }[]).every((row) => row.weightBps === null));
  });

  it("projects only verified journal debit and matching execution state while preserving reservation accounting", async () => {
    const f = await fixture();
    const id = "portfolio-evidence";
    await seed(f, id);
    f.setDisplayName("  NVIDIA  ");
    const firstKey = `0x${"51".repeat(32)}` as Hex;
    const laterKey = `0x${"52".repeat(32)}` as Hex;
    for (const [key, decisionId, entry] of [[firstKey, "first", 20n], [laterKey, "later", 10n]] as const) {
      await f.intents.create({ decisionId, idempotencyKey: key, agentId: id, ownerAddress: ownerAccount.address,
        side: "buy", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: entry * UNIT, entryWei: entry * UNIT,
        positionId: decisionId, closeReason: null, portfolioSlot: decisionId === "first" ? 0 : 1,
        settlementAsset: "USDT", quotedOutAtomic: UNIT, minOutAtomic: UNIT });
      await f.journal.begin({ idempotencyKey: key, agentId: id, ownerAddress: ownerAccount.address, kind: "trade", decisionId });
      await f.journal.markInProgress(key, {});
      await f.journal.markCommitted(key, { actualQuoteSpendWei: ((entry - 1n) * UNIT).toString(),
        txHash: `0x${"ab".repeat(32)}` as Hex });
      await f.intents.markProjected(ownerAccount.address, id, decisionId);
    }
    const read = async () => call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    const response = await read();
    assert.equal(response.status, 200, response.text);
    const p = (response.body as { data: { portfolio: { tokens: { displayName: string | null; initial: { quoteWei: string | null; quantityAtomic: string | null } }[];
      legs: { detail: { executionState: string | null; quoteWei: string | null; quantityAtomic: string | null }; txHash: string | null }[];
      netInvestedWei: string } } }).data.portfolio;
    assert.equal(p.netInvestedWei, (30n * UNIT).toString());
    assert.equal(p.tokens[0]?.displayName, "NVIDIA");
    assert.equal(p.tokens[0]?.initial.quoteWei, (19n * UNIT).toString());
    assert.equal(p.tokens[0]?.initial.quantityAtomic, null);
    assert.equal(p.legs[0]?.detail.quoteWei, (9n * UNIT).toString());
    assert.equal(p.legs[0]?.detail.quantityAtomic, null);
    assert.equal(p.legs[0]?.detail.executionState, "COMMITTED");
    assert.equal(p.legs[0]?.txHash, `0x${"ab".repeat(32)}`);
    assert.equal(f.pinReads(), 1);
    f.setMetadataFails(true);
    const failedName = await read();
    assert.equal(failedName.status, 200, failedName.text);
    assert.equal((failedName.body as { data: { portfolio: { tokens: { displayName: string | null }[] } } }).data.portfolio.tokens[0]?.displayName, null);
  });

  it("does not substitute a later verified buy for an unverified first buy", async () => {
    const f = await fixture();
    const id = "portfolio-first-unverified";
    await seed(f, id);
    for (let i = 0; i < 52; i += 1) {
      const key = `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex;
      const decisionId = `buy-${i.toString().padStart(2, "0")}`;
      await f.intents.create({ decisionId, idempotencyKey: key, agentId: id, ownerAddress: ownerAccount.address,
        side: "buy", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: UNIT,
        positionId: decisionId, closeReason: null, portfolioSlot: i, settlementAsset: "USDT" });
      if (i === 1) {
        await f.journal.begin({ idempotencyKey: key, agentId: id, ownerAddress: ownerAccount.address, kind: "trade", decisionId });
        await f.journal.markInProgress(key, {});
        await f.journal.markCommitted(key, { actualQuoteSpendWei: UNIT.toString() });
      }
    }
    const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    assert.equal(response.status, 200, response.text);
    const p = (response.body as { data: { portfolio: { tokens: { initial: { quoteWei: string | null; quoteReason: string } }[];
      legs: unknown[]; netInvestedWei: string } } }).data.portfolio;
    assert.equal(p.tokens[0]?.initial.quoteWei, null);
    assert.equal(p.tokens[0]?.initial.quoteReason, "not-verified");
    assert.equal(p.legs.length, 50);
    assert.equal(p.netInvestedWei, (52n * UNIT).toString());
  });

  it("distinguishes verified sale proceeds, zero seals, mismatched journals and read failures", async () => {
    const f = await fixture();
    const id = "portfolio-evidence-limits";
    await seed(f, id);
    const rows = [
      { decisionId: "sale-positive", side: "sell" as const, key: `0x${"61".repeat(32)}` as Hex },
      { decisionId: "sale-zero", side: "sell" as const, key: `0x${"62".repeat(32)}` as Hex },
      { decisionId: "buy-mismatch", side: "buy" as const, key: `0x${"63".repeat(32)}` as Hex },
    ];
    for (const row of rows) await f.intents.create({ decisionId: row.decisionId, idempotencyKey: row.key, agentId: id,
      ownerAddress: ownerAccount.address, side: row.side, token: row.side === "buy" ? STOCKS[1]! : STOCKS[0]!,
      route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: row.side === "buy" ? UNIT : 0n,
      positionId: row.decisionId, closeReason: null, portfolioSlot: row.decisionId === "sale-zero" ? 1 : 0, settlementAsset: "USDT" });
    await f.intents.setPortfolioProceeds(ownerAccount.address, id, "sale-positive", 3n * UNIT, "receipt-owned");
    await f.intents.setPortfolioProceeds(ownerAccount.address, id, "sale-zero", 0n, null);
    await f.journal.begin({ idempotencyKey: rows[2]!.key, agentId: id, ownerAddress: ownerAccount.address,
      kind: "trade", decisionId: "not-buy-mismatch" });
    await f.journal.markInProgress(rows[2]!.key, {});
    await f.journal.markCommitted(rows[2]!.key, { actualQuoteSpendWei: UNIT.toString() });
    const read = async () => call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    const response = await read();
    assert.equal(response.status, 200, response.text);
    type Leg = { symbol: string; detail: { quoteWei: string | null; executionState: string | null; executionReason: string | null } };
    const p = (response.body as { data: { portfolio: { legs: Leg[]; netInvestedWei: string } } }).data.portfolio;
    assert.equal(p.legs.find((leg) => leg.symbol === DCA_POOLS_56[1]!.symbol)?.detail.quoteWei, null);
    assert.equal(p.legs.find((leg) => leg.symbol === DCA_POOLS_56[1]!.symbol)?.detail.executionState, null);
    assert.equal(p.legs.filter((leg) => leg.detail.quoteWei === (3n * UNIT).toString()).length, 1);
    assert.equal(p.legs.filter((leg) => leg.detail.quoteWei === null).length, 2);
    assert.equal(p.netInvestedWei, (-2n * UNIT).toString());
    const original = f.journal.get.bind(f.journal);
    f.journal.get = async () => { throw new Error("offline journal failure"); };
    const unavailable = await read();
    assert.equal(unavailable.status, 200, unavailable.text);
    const missed = (unavailable.body as { data: { portfolio: { legs: Leg[]; netInvestedWei: string } } }).data.portfolio;
    assert.equal(missed.legs.find((leg) => leg.symbol === DCA_POOLS_56[1]!.symbol)?.detail.executionReason, "unavailable");
    assert.equal(missed.netInvestedWei, p.netInvestedWei);
    f.journal.get = original;
  });

  it("rejects owner-only and agent-only journal mismatches with committed debit and hash", async () => {
    const f = await fixture();
    const id = "portfolio-journal-identity";
    await seed(f, id);
    const rows = ["matching", "wrong-owner", "wrong-agent"] as const;
    const hash = `0x${"ad".repeat(32)}` as Hex;
    for (const [index, decisionId] of rows.entries()) {
      const key = `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex;
      await f.intents.create({ decisionId, idempotencyKey: key, agentId: id, ownerAddress: ownerAccount.address,
        side: "buy", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: 5n * UNIT, entryWei: 5n * UNIT,
        positionId: decisionId, closeReason: null, portfolioSlot: index, settlementAsset: "USDT" });
      await f.journal.begin({ idempotencyKey: key, agentId: id, ownerAddress: ownerAccount.address, kind: "trade", decisionId });
      await f.journal.markInProgress(key, {});
      await f.journal.markCommitted(key, { actualQuoteSpendWei: (4n * UNIT).toString(), txHash: hash });
    }
    const original = f.journal.get.bind(f.journal);
    f.journal.get = async (key) => {
      const row = await original(key);
      if (row?.decisionId === "wrong-owner") return { ...row, ownerAddress: WALLET };
      if (row?.decisionId === "wrong-agent") return { ...row, agentId: "another-agent" };
      return row;
    };
    const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    assert.equal(response.status, 200, response.text);
    type Leg = { detail: { id: string; executionState: string | null; quoteWei: string | null }; txHash: string | null };
    const legs = (response.body as { data: { portfolio: { legs: Leg[] } } }).data.portfolio.legs;
    const matching = legs.find((leg) => leg.detail.id === "matching");
    assert.equal(matching?.detail.executionState, "COMMITTED");
    assert.equal(matching?.detail.quoteWei, (4n * UNIT).toString());
    assert.equal(matching?.txHash, hash);
    for (const decisionId of ["wrong-owner", "wrong-agent"]) {
      const leg = legs.find((item) => item.detail.id === decisionId);
      assert.ok(leg, decisionId);
      assert.equal(leg.detail.executionState, null, decisionId);
      assert.equal(leg.detail.quoteWei, null, decisionId);
      assert.equal(leg.txHash, null, decisionId);
    }
  });

  it("requires a receipt key for positive sale Value even when the read seam returns proceeds", async () => {
    const f = await fixture();
    const id = "portfolio-sale-key";
    await seed(f, id);
    await f.intents.create({ decisionId: "sale-key", idempotencyKey: `0x${"ab".repeat(32)}` as Hex,
      agentId: id, ownerAddress: ownerAccount.address, side: "sell", token: STOCKS[0]!, route: { hops: [], fees: [] },
      amountWei: UNIT, entryWei: 0n, positionId: "sale-key", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
    assert.equal((await f.intents.setPortfolioProceeds(ownerAccount.address, id, "sale-key", 3n * UNIT, "receipt-owned")).outcome, "credited");
    const read = async () => {
      const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
      assert.equal(response.status, 200, response.text);
      return (response.body as { data: { portfolio: { legs: { detail: { quoteWei: string | null } }[] } } }).data.portfolio.legs[0]?.detail.quoteWei;
    };
    assert.equal(await read(), (3n * UNIT).toString());
    const original = f.intents.listPortfolio.bind(f.intents);
    for (const receiptKey of [null, ""]) {
      f.intents.listPortfolio = async (owner, agent) => (await original(owner, agent)).map((row) => ({ ...row, portfolioReceiptKey: receiptKey }));
      assert.equal(await read(), null);
    }
  });
});
