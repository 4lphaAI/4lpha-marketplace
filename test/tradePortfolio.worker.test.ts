import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { validateSessionSpec } from "../src/core/session.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { DCA_POOLS_56 } from "../src/trade/dca.js";
import { tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { runTradeWorkerOnce, type TradeExecutor, type TradeWorkerDeps } from "../src/trade/worker.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { TradeDataPlaneReads, TokenBatchRow, UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import type { RwaFact } from "../src/trade/rwa.js";
import type { TradfiFlashQuote } from "../src/trade/dataPlaneReads.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { TRADFI_GUARD_SWAP_SELECTOR } from "../src/ops/policy.js";
import { executeTradeForAgent } from "../src/trade/execute.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const STOCKS = DCA_POOLS_56.slice(0, 2).map((pool) => pool.stock);
const HASH = `0x${"11".repeat(32)}` as Hex;
const UNIT = 10n ** 18n;
const GUARD = getAddress("0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d");

function portfolioSettings(patch: Partial<TradeSettings> = {}): TradeSettings {
  return { name: "Portfolio", executionModel: "tradfi", settlementAsset: "USDT", entryWei: (50n * UNIT).toString(),
    minEntryWei: UNIT.toString(), capitalQuoteWei: (50n * UNIT).toString(), maxOpenPositions: 1, minMarketCapUsd: null,
    maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
    slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash",
    fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false, cmcNewsEnabled: false, tradeMode: "portfolio",
    portfolioTokens: STOCKS.map((stock) => stock.toLowerCase()), portfolioWeightsBps: [5000, 5000],
    portfolioDriftBps: 500, portfolioIntervalSec: 86400, ...patch };
}

function flashQuote(tokenIn: Address, tokenOut: Address, amount: string): TradfiFlashQuote {
  const now = Date.now();
  return { version: "tradfi-binance-flash-v1", tokenIn, tokenOut, value: "0", feeAmountAtomic: "0", feeToken: null,
    taker: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
    calldata: "0xad43f73d", chainId: 56, quotedOutAtomic: amount, minOutAtomic: (BigInt(amount) * 99n / 100n).toString(),
    amountInAtomic: amount, observedAt: now, expiresAt: now + 30_000, estimatedGasUnits: "100000", gasPriceWei: "1000000000" };
}

async function world(input: { readonly usdt?: bigint; readonly balances?: readonly bigint[]; readonly enabled?: boolean;
  readonly dryRun?: boolean; readonly now?: number; readonly reader?: RouteQuoteReader; readonly executor?: TradeExecutor;
  readonly quoteRemaining?: bigint; readonly unavailable?: boolean; readonly recoverFill?: TradeWorkerDeps["recoverFill"];
  readonly tokenCount?: number; readonly grantStockCount?: number; readonly rwaPatch?: Partial<RwaFact>;
  readonly flash?: TradeDataPlaneReads["binanceQuoteAndSwap"] } = {}) {
  const now = input.now ?? Date.now();
  let liveNow = now;
  const stocks = DCA_POOLS_56.slice(0, input.tokenCount ?? 2).map((pool) => pool.stock);
  const agents = new MemoryAgentStore(null, () => now);
  const positions = new MemoryTradePositionStore(() => now);
  const settingsStore = new MemoryTradeSettingsStore(agents, () => now);
  const intents = new MemoryTradeIntentStore(() => now);
  const journal = new MemoryExecutionJournal(() => now);
  const spec = { allowedCalls: [...[USDT_56, ...stocks.slice(0, input.grantStockCount ?? stocks.length)].map((token) => ({ to: token, selector: "approve(address,uint256)" })),
      ...(input.flash === undefined ? [] : [{ to: GUARD, selector: TRADFI_GUARD_SWAP_SELECTOR }])],
    spendCaps: [USDT_56, ...stocks].map((token) => ({ token, limit: 250n * UNIT, period: "day" as const })),
    expiresAt: Math.floor(now / 1000) + 604800 };
  const agent = await agents.createAgent({ id: "portfolio", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", status: "armed",
    sessionFacts: { spec, permissions: validateSessionSpec(spec, { minSessionSeconds: 0 }),
      publicKey: `0x02${"33".repeat(32)}` as Hex, expiry: spec.expiresAt } });
  const capital = stocks.length === 5 ? 125n * UNIT : 50n * UNIT;
  const settings = portfolioSettings({ portfolioTokens: stocks.map((stock) => stock.toLowerCase()),
    portfolioWeightsBps: stocks.map(() => 10_000 / stocks.length), capitalQuoteWei: capital.toString(), entryWei: capital.toString() });
  await settingsStore.put({ agentId: agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  const balances = new Map<string, bigint>([[USDT_56.toLowerCase(), input.usdt ?? capital],
    ...stocks.map((stock, index): [string, bigint] => [stock.toLowerCase(), input.balances?.[index] ?? 0n])]);
  const venue: VenueRow = { dex: "pancakeswap", version: "v2", pool: getAddress("0x4444444444444444444444444444444444444444"),
    feeTier: null, quote: USDT_56, quoteSymbol: "USDT", priceUsd: 1, liquidityUsd: 50_000, volume24hUsd: 100, asOf: now };
  const rows: UniverseRow[] = stocks.map((stock, index) => ({ address: stock, symbol: DCA_POOLS_56[index]!.symbol, lane: "bstocks", source: "fixture", venues: [venue],
    rwa: { platform: "bstock", underlyingTicker: DCA_POOLS_56[index]!.symbol, tokenPriceUsd: 1, referencePriceUsd: 1,
      premiumBps: 0, openState: true, marketStatus: null, reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1,
      onchainPriceUsd: 1, venues: [venue], ...input.rwaPatch } }));
  const dataPlane: TradeDataPlaneReads = { async universe(lane) { if (input.unavailable && lane === "bstocks") throw new Error("unavailable"); return lane === "bstocks" ? rows : []; },
    async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => ({ address, symbol: "USDT", priceUsd: 1, marketCapUsd: null,
      volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: Date.now(), staleness: "fresh" })); },
    async eligibilityBatch(addresses) { return addresses.map((address) => ({ address, eligible: true, reason: "binance_rwa", source: "binance-rwa" as const, venue: null })); },
    async security() { return { riskLevel: "ok", flags: [] }; },
    ...(input.flash === undefined ? {} : { binanceQuoteAndSwap: input.flash }) };
  const reader: RouteQuoteReader = input.reader ?? { async quoteV2(_path, amount) { return amount; },
    async quoteV3Single(_in, _out, _fee, amount) { return amount; }, async quoteV3Path(_path, amount) { return amount; },
    async quoteUniV3Single(_in, _out, _fee, amount) { return amount; }, async quoteUniV3Path(_path, amount) { return amount; } };
  const calls: { readonly side: string; readonly token: Address; readonly amount: bigint; readonly fee: bigint | undefined }[] = [];
  let counter = 0;
  const executor: TradeExecutor = input.executor ?? { async execute({ request }) {
    calls.push({ side: request.side, token: request.token, amount: request.amountWei, fee: request.platformFeeAtomic });
    counter += 1;
    if (request.side === "buy") {
      balances.set(USDT_56.toLowerCase(), (balances.get(USDT_56.toLowerCase()) ?? 0n) - request.amountWei);
      balances.set(request.token.toLowerCase(), (balances.get(request.token.toLowerCase()) ?? 0n) + request.quotedOutWei);
      return { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
        fill: { side: "buy" as const, entryWei: request.amountWei, tokenAmount: request.quotedOutWei,
          fillStatus: "verified" as const, verifiedEntryAtomic: request.amountWei,
          receiptOwnershipKey: `56|${HASH}|${WALLET.toLowerCase()}|${counter}|${HASH}` }, meta: {} };
    }
    balances.set(request.token.toLowerCase(), (balances.get(request.token.toLowerCase()) ?? 0n) - request.amountWei);
    balances.set(USDT_56.toLowerCase(), (balances.get(USDT_56.toLowerCase()) ?? 0n) + request.quotedOutWei);
    return { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
      fill: { side: "sell" as const, exitWei: request.quotedOutWei, fillStatus: "verified" as const,
        receiptOwnershipKey: `56|${HASH}|${WALLET.toLowerCase()}|${counter}|${HASH}` }, meta: {} };
  } };
  let remaining = input.quoteRemaining ?? 250n * UNIT;
  const deps: TradeWorkerDeps = { portfolioEnabled: input.enabled ?? true, platformFeeBps: 100,
    ...(input.flash === undefined ? {} : { aggregatorGuard: GUARD }),
    agentStore: agents, settingsStore, positions, intents, journal: { get: journal.get.bind(journal), async sumPendingQuoteSpendSince() { return 0n; } },
    dataPlane, provider: { async getTokenBalance({ token }) { return balances.get(token.toLowerCase()) ?? 0n; },
      async readSpendInfos() { return [{ token: USDT_56, period: "day", periodCode: 1, limitWei: 250n * UNIT,
        currentSpentWei: 250n * UNIT - remaining }]; },
      async getTokenMetadata() { return { decimals: 18, symbol: "NVDAB" }; } },
    llmFor: () => ({ async complete() { throw new Error("portfolio called the LLM"); } }), executor, executorDeps: {},
    readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(stocks.map((stock) => stock.toLowerCase())) },
    rpcUrls: [], routeReader: reader, forbiddenAddresses: () => new Set(),
    executionIdentity: () => ({ idempotencyKey: HASH, paramsHash: HASH }), async tradfiNativeCostUsdtAtomic() { return 1n; },
    recoverFill: input.recoverFill ?? (async (intent) => intent.side === "buy" ? { side: "buy", entryWei: intent.entryWei, tokenAmount: UNIT, fillStatus: "unverified" }
      : { side: "sell", exitWei: null, fillStatus: "unverified" }), now: () => liveNow };
  return { deps, intents, positions, settingsStore, journal, agents, agent, balances, calls, stocks,
    setQuoteRemaining: (value: bigint) => { remaining = value; },
    setNow: (value: number) => { liveNow = value; },
    run: () => runTradeWorkerOnce(deps, input.dryRun === undefined ? {} : { dryRun: input.dryRun }) };
}

describe("Smart Portfolio worker", () => {
  it("V1 and V6 initial allocation submits one zero-fee buy per tick without positions or LLM", async () => {
    const h = await world();
    const first = await h.run();
    assert.equal(first.outcomes[0]?.reason, "portfolio-bought");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.fee, 0n);
    assert.equal(h.calls[0]?.amount, 25n * UNIT);
    assert.equal(h.calls[0]?.token.toLowerCase(), STOCKS[0]!.toLowerCase(), "equal legs tie in signed token order");
    assert.equal((await h.positions.listOpen(OWNER, h.agent.id)).length, 0);
    const second = await h.run();
    assert.equal(second.outcomes[0]?.reason, "portfolio-bought");
    assert.equal(h.calls.length, 2);
    assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id)).length, 2);
    const done = await h.run();
    assert.equal(done.outcomes[0]?.reason, "portfolio-rebalanced");
    assert.equal((await h.intents.getPortfolioCheck(OWNER, h.agent.id, 0))?.state, "done");
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-done");
  });

  it("the full portfolio buy path prices and submits with no treasury fee at a global 100 bps", async () => {
    const h = await world();
    const treasury = getAddress("0x7777777777777777777777777777777777777777");
    const priced: (readonly { readonly to: Address; readonly data?: Hex }[])[] = [];
    Object.assign(h.deps, { platformFeeTreasury: treasury, tradfiNativeCostUsdtAtomic: async (input: {
      readonly calls: readonly { readonly to: Address; readonly data?: Hex }[] }) => { priced.push(input.calls); return 1n; } });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    const [intent] = await h.intents.listPortfolio(OWNER, h.agent.id);
    assert.equal(intent?.platformFeeAtomic, 0n);
    assert.equal(intent?.entryWei, intent?.amountWei);
    assert.equal(h.calls[0]?.fee, 0n);
    const treasuryWord = treasury.slice(2).toLowerCase();
    assert.ok(priced.length > 0);
    assert.ok(priced.every((calls) => !calls.some((call) => call.to.toLowerCase() === USDT_56.toLowerCase()
      && call.data?.toLowerCase().startsWith("0xa9059cbb") === true && call.data.toLowerCase().includes(treasuryWord))));
  });

  it("portfolio never reaches LLM, runExits, decideExit, sellPosition or crash stop", async () => {
    const h = await world();
    const forbidden = async (): Promise<never> => { throw new Error("portfolio reached the position exit path"); };
    Object.assign(h.positions, { listOpen: forbidden, open: forbidden, closePosition: forbidden,
      recordCrashEvidence: forbidden, recordQuote: forbidden });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id)).length, 1);
  });

  it("V2 held check remains held across repeated cycles", async () => {
    const h = await world({ usdt: 0n, balances: [25n * UNIT + 6n * UNIT / 10n, 24n * UNIT + 4n * UNIT / 10n] });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-hold");
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-held");
    assert.equal(h.calls.length, 0);
  });

  it("portfolio guard-won buy carries the accepted guard quote", async () => {
    let requestGuard: unknown;
    const h = await world({ flash: async (request) => flashQuote(request.tokenIn, request.tokenOut, request.amountAtomic),
      executor: { async execute({ request }) { requestGuard = request.guardQuote;
        return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH }, fill: null, meta: {} }; } } });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    assert.ok(requestGuard !== undefined);
    assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id))[0]?.venue, "pancake_v3");
  });

  it("portfolio sell arms a one-shot direct escape after guard refusal and consumes it on the next attempt", async () => {
    let flashCalls = 0;
    const requests: unknown[] = [];
    const h = await world({ usdt: 0n, balances: [30n * UNIT, 20n * UNIT],
      flash: async (request) => { flashCalls += 1; return flashQuote(request.tokenIn, request.tokenOut, request.amountAtomic); },
      executor: { async execute({ request }) { requests.push(request.guardQuote);
        return requests.length === 1 ? { kind: "rolled-back", code: "guard-refused", meta: { deniedBy: "preflight" } }
          : { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
            fill: { side: "sell", fillStatus: "verified", exitWei: request.quotedOutWei,
              receiptOwnershipKey: `56|${HASH}|${WALLET.toLowerCase()}|3|${HASH}` }, meta: {} }; } } });
    assert.equal((await h.run()).outcomes[0]?.reason, "guard-refused");
    assert.ok(requests[0] !== undefined);
    assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id)).length, 0);
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-sold");
    assert.equal(requests[1], undefined);
    assert.equal(flashCalls, 1);
  });

  it("portfolio drift at exactly the threshold rebalances, while 499 bps holds", async () => {
    const equality = await world({ usdt: 0n, balances: [26n * UNIT + UNIT / 4n, 23n * UNIT + 3n * UNIT / 4n] });
    assert.equal((await equality.run()).outcomes[0]?.reason, "portfolio-sold");
    assert.equal(equality.calls[0]?.amount, UNIT + UNIT / 4n);
    const below = await world({ usdt: 0n, balances: [26n * UNIT + 24n * UNIT / 100n, 23n * UNIT + 76n * UNIT / 100n] });
    assert.equal((await below.run()).outcomes[0]?.reason, "portfolio-hold");
  });

  it("V3 sells an overweight stock before buying the underweight stock", async () => {
    const h = await world({ usdt: 0n, balances: [30n * UNIT, 20n * UNIT] });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-sold");
    assert.equal(h.calls[0]?.side, "sell");
    assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id))[0]?.portfolioProceedsAtomic, 5n * UNIT);
    assert.equal((await h.positions.listOpen(OWNER, h.agent.id)).length, 0, "a partial portfolio sale creates no trade position");
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    assert.equal(h.calls[1]?.side, "buy");
    assert.equal(h.calls[1]?.amount, 5n * UNIT);
  });

  it("G2's 30 percent withdrawal crosses 5 percent relative drift and executes both legs", async () => {
    const h = await world({ usdt: 0n, balances: [17n * UNIT + UNIT / 2n, 25n * UNIT] });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-sold");
    assert.equal(h.calls[0]?.token.toLowerCase(), STOCKS[1]!.toLowerCase());
    assert.equal(h.calls[0]?.amount, 3n * UNIT + 75n * UNIT / 100n);
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    assert.equal(h.calls[1]?.token.toLowerCase(), STOCKS[0]!.toLowerCase());
    assert.equal(h.calls[1]?.amount, 3n * UNIT + 75n * UNIT / 100n);
  });

  it("V4 idle USDT deposit stays outside Total capital", async () => {
    const h = await world();
    await h.run(); await h.run();
    h.balances.set(USDT_56.toLowerCase(), 100n * UNIT);
    Object.assign(h.deps, { now: () => Date.now() + 86_400_000 });
    const result = await h.run();
    assert.equal(result.outcomes[0]?.reason, "portfolio-hold");
    assert.equal(h.calls.length, 2);
  });

  it("V5b caps a growth rebalance buy at signed entryWei and later holds the residual cash", async () => {
    const now = Date.now();
    const h = await world({ now, usdt: 0n, balances: [360n * UNIT, 240n * UNIT] });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-sold");
    assert.equal(h.calls[0]?.amount, 60n * UNIT);
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    assert.equal(h.calls[1]?.amount, 50n * UNIT);
    Object.assign(h.deps, { now: () => now + 86_400_000 });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-hold");
    assert.equal(h.balances.get(USDT_56.toLowerCase()), 10n * UNIT);
  });

  it("V6 buys five stocks over five ticks, never more than one submission in a tick", async () => {
    const h = await world({ tokenCount: 5, usdt: 125n * UNIT });
    for (let index = 0; index < 5; index++) {
      assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
      assert.equal(h.calls.length, index + 1);
      assert.equal(h.calls[index]?.amount, 25n * UNIT);
    }
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-rebalanced");
  });

  it("V7 reports portfolio-cap-exhausted when the on-chain USDT day meter is exhausted", async () => {
    const h = await world({ quoteRemaining: 0n });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-cap-exhausted");
    assert.equal(h.calls.length, 0);
  });

  it("portfolio token-not-granted, pending and UNKNOWN reasons stop before a decision", async () => {
    const ungranted = await world({ grantStockCount: 1 });
    assert.equal((await ungranted.run()).outcomes[0]?.reason, "portfolio-token-not-granted");
    for (const state of ["PENDING", "UNKNOWN"] as const) {
      const h = await world();
      const key = `0x${"44".repeat(32)}` as Hex;
      await h.intents.create({ decisionId: "unresolved", idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER,
        side: "buy", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: UNIT,
        positionId: "unresolved", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
      await h.journal.begin({ idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER, kind: "trade", decisionId: "unresolved" });
      if (state === "UNKNOWN") await h.journal.markUnknown(key, "lost relay response");
      assert.equal((await h.run()).outcomes[0]?.reason, state === "UNKNOWN" ? "portfolio-submission-unknown" : "portfolio-pending-intent");
      assert.equal(h.calls.length, 0);
    }
  });

  it("portfolio quote, meter, cost and buy-route refusals each report their own reason", async () => {
    const noQuote = await world({ balances: [UNIT, 0n], reader: { async quoteV2(_path, amount) { return amount; },
      async quoteV3Single() { throw new Error("pool unavailable"); }, async quoteV3Path(_path, amount) { return amount; },
      async quoteUniV3Single(_in, _out, _fee, amount) { return amount; }, async quoteUniV3Path(_path, amount) { return amount; } } });
    assert.equal((await noQuote.run()).outcomes[0]?.reason, "portfolio-quote-unavailable");
    const noMeter = await world();
    Object.assign(noMeter.deps.provider, { readSpendInfos: async () => [] });
    assert.equal((await noMeter.run()).outcomes[0]?.reason, "quote-meter-unavailable");
    const noCost = await world();
    Object.assign(noCost.deps, { tradfiNativeCostUsdtAtomic: undefined });
    assert.equal((await noCost.run()).outcomes[0]?.reason, "cost-unavailable");
    const noRoute = await world({ reader: { async quoteV2() { throw new Error("no route"); },
      async quoteV3Single() { throw new Error("no route"); }, async quoteV3Path() { throw new Error("no route"); },
      async quoteUniV3Single() { throw new Error("no route"); }, async quoteUniV3Path() { throw new Error("no route"); } } });
    const refused = await noRoute.run();
    assert.equal(refused.outcomes[0]?.reason, "portfolio-no-route");
    assert.deepEqual((await noRoute.positions.listRuns(OWNER, noRoute.agent.id, 1))[0]?.events?.filter((event) => event.code === "portfolio-refused").map((event) => event.token?.toLowerCase()),
      STOCKS.map((stock) => stock.toLowerCase()));
  });

  it("portfolio RWA refusal is the cycle reason when every buy candidate fails", async () => {
    const h = await world({ rwaPatch: { staleness: "stale" } });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-rwa-stale");
    assert.equal(h.calls.length, 0);
    for (const [patch, reason] of [
      [{ openState: false }, "portfolio-issuer-not-trading"],
      [{ referencePriceUsd: null }, "portfolio-premium-unknown"],
      [{ referencePriceUsd: 0.9 }, "portfolio-premium-too-high"],
    ] as const) {
      const other = await world({ rwaPatch: patch });
      assert.equal((await other.run()).outcomes[0]?.reason, reason);
    }
    const missing = await world();
    Object.assign(missing.deps.dataPlane, { universe: async () => [] });
    assert.equal((await missing.run()).outcomes[0]?.reason, "portfolio-rwa-unavailable");
  });

  it("portfolio scales the remaining buy with floor rounding below the verified 4.95 USDT cash budget", async () => {
    const h = await world({ usdt: 0n, balances: [30n * UNIT, 20n * UNIT] });
    const amounts: bigint[] = [];
    Object.assign(h.deps, { executor: { async execute({ request }: Parameters<TradeExecutor["execute"]>[0]) {
      amounts.push(request.amountWei);
      if (request.side === "sell") {
        h.balances.set(request.token.toLowerCase(), h.balances.get(request.token.toLowerCase())! - request.amountWei);
        h.balances.set(USDT_56.toLowerCase(), 4_950_000_000_000_000_000n);
        return { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
          fill: { side: "sell" as const, fillStatus: "verified" as const, exitWei: 4_950_000_000_000_000_000n,
            receiptOwnershipKey: "sale-4.95" }, meta: {} };
      }
      assert.ok(request.amountWei <= h.balances.get(USDT_56.toLowerCase())!);
      h.balances.set(USDT_56.toLowerCase(), h.balances.get(USDT_56.toLowerCase())! - request.amountWei);
      return { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
        fill: { side: "buy" as const, entryWei: request.amountWei, tokenAmount: request.quotedOutWei, fillStatus: "unverified" as const }, meta: {} };
    } } });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-sold");
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    assert.equal(amounts[0], 5n * UNIT);
    assert.equal(amounts[1], 4_950_000_000_000_000_000n);
  });

  it("portfolio uses the signed minimum for a 0.5 USDT leg", async () => {
    for (const minEntryWei of [UNIT / 10n, UNIT]) {
      const h = await world({ usdt: 0n, balances: [25n * UNIT + UNIT / 2n, 25n * UNIT - UNIT / 2n] });
      const settings = portfolioSettings({ minEntryWei: minEntryWei.toString(), portfolioDriftBps: 50 });
      await h.settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
      const result = await h.run();
      assert.equal(result.outcomes[0]?.reason, minEntryWei === UNIT ? "portfolio-legs-too-small" : "portfolio-sold");
      assert.equal(h.calls.length, minEntryWei === UNIT ? 0 : 1);
      assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id)).length, minEntryWei === UNIT ? 0 : 1);
      if (minEntryWei !== UNIT) assert.equal(h.calls[0]?.amount, UNIT / 2n);
    }
  });

  it("portfolio small legs finish the slot and a taken sale with no wallet USDT reports cash-low", async () => {
    const small = await world({ usdt: 0n, balances: [5n * UNIT + 3n * UNIT / 10n, 4n * UNIT + 7n * UNIT / 10n] });
    assert.equal((await small.run()).outcomes[0]?.reason, "portfolio-legs-too-small");
    assert.equal((await small.intents.getPortfolioCheck(OWNER, small.agent.id, 0))?.state, "done");
    const cash = await world({ usdt: 0n, balances: [25n * UNIT, 20n * UNIT] });
    await cash.intents.create({ decisionId: "taken-sale", idempotencyKey: HASH, agentId: cash.agent.id, ownerAddress: OWNER,
      side: "sell", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: 0n,
      positionId: "taken-sale", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
    await cash.intents.setPortfolioProceeds(OWNER, cash.agent.id, "taken-sale", 0n, null);
    await cash.intents.markProjected(OWNER, cash.agent.id, "taken-sale");
    assert.equal((await cash.run()).outcomes[0]?.reason, "portfolio-cash-low");
    assert.deepEqual((await cash.positions.listRuns(OWNER, cash.agent.id, 1))[0]?.events?.filter((event) => event.code === "portfolio-refused")
      .map((event) => [event.token?.toLowerCase(), event.reason]), [[STOCKS[1]!.toLowerCase(), "portfolio-cash-low"]]);
  });

  it("portfolio tries the next planned buy when the largest has no route", async () => {
    const first = STOCKS[0]!.toLowerCase();
    const reader: RouteQuoteReader = {
      async quoteV2(path, amount) { if (path.at(-1)?.toLowerCase() === first) throw new Error("no first route"); return amount; },
      async quoteV3Single(_in, out, _fee, amount) { if (out.toLowerCase() === first) throw new Error("no first route"); return amount; },
      async quoteV3Path() { throw new Error("no path"); },
      async quoteUniV3Single(_in, out, _fee, amount) { if (out.toLowerCase() === first) throw new Error("no first route"); return amount; },
      async quoteUniV3Path() { throw new Error("no path"); },
    };
    const h = await world({ reader });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.token.toLowerCase(), STOCKS[1]!.toLowerCase());
  });

  it("portfolio tries the next sell, and submits no buy while an untaken sell remains", async () => {
    const first = DCA_POOLS_56[0]!.stock.toLowerCase();
    const reader: RouteQuoteReader = {
      async quoteV2(path, amount) { if (path[0]?.toLowerCase() === first) throw new Error("no first sell route"); return amount; },
      async quoteV3Single(tokenIn, _out, _fee, amount) { if (tokenIn.toLowerCase() === first && amount === 21n * UNIT) throw new Error("no first sell route"); return amount; },
      async quoteV3Path() { throw new Error("no path"); },
      async quoteUniV3Single(tokenIn, _out, _fee, amount) { if (tokenIn.toLowerCase() === first && amount === 21n * UNIT) throw new Error("no first sell route"); return amount; },
      async quoteUniV3Path() { throw new Error("no path"); },
    };
    const h = await world({ tokenCount: 5, usdt: 0n, balances: [35n * UNIT, 35n * UNIT, 0n, 0n, 0n], reader });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-sold");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.side, "sell");
    assert.equal(h.calls[0]?.token.toLowerCase(), DCA_POOLS_56[1]!.stock.toLowerCase());
  });

  it("projected portfolio legs never reach ordinary position lookup or adoption", async () => {
    const h = await world();
    for (const [id, side, token] of [["prior-buy", "buy", STOCKS[0]], ["prior-sell", "sell", STOCKS[1]]] as const) {
      await h.intents.create({ agentId: h.agent.id, ownerAddress: OWNER, decisionId: id, idempotencyKey: HASH,
        side, token: token!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: side === "buy" ? UNIT : 0n,
        positionId: id, closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
      await h.intents.markProjected(OWNER, h.agent.id, id);
    }
    let lookups = 0;
    Object.assign(h.positions, { async get() { lookups += 1; throw new Error("portfolio reached ordinary position lookup"); },
      async adoptVerifiedEntry() { throw new Error("portfolio reached ordinary position adoption"); },
      async adoptVerifiedExit() { throw new Error("portfolio reached ordinary position adoption"); } });
    await h.run();
    assert.equal(lookups, 0);
  });

  it("refuses a priced buy when every planned sell route is unavailable", async () => {
    const now = Date.now();
    const sell = STOCKS[0]!.toLowerCase();
    let buyPriced = false;
    const reader: RouteQuoteReader = {
      async quoteV2(path, amount) { if (path[0]?.toLowerCase() === sell) throw new Error("sell unavailable");
        if (path.at(-1)?.toLowerCase() === STOCKS[1]!.toLowerCase()) buyPriced = true; return amount; },
      async quoteV3Single(tokenIn, tokenOut, _fee, amount) {
        if (tokenIn.toLowerCase() === sell && amount === 10n * UNIT) throw new Error("sell unavailable");
        if (tokenOut.toLowerCase() === STOCKS[1]!.toLowerCase()) buyPriced = true;
        return amount;
      },
      async quoteV3Path() { throw new Error("no path"); },
      async quoteUniV3Single(tokenIn, tokenOut, _fee, amount) {
        if (tokenIn.toLowerCase() === sell && amount === 10n * UNIT) throw new Error("sell unavailable");
        if (tokenOut.toLowerCase() === STOCKS[1]!.toLowerCase()) buyPriced = true;
        return amount;
      },
      async quoteUniV3Path() { throw new Error("no path"); },
    };
    const h = await world({ now, usdt: 10n * UNIT, balances: [40n * UNIT, 10n * UNIT], reader });
    assert.equal(await reader.quoteV2([USDT_56, STOCKS[1]!], 10n * UNIT), 10n * UNIT);
    assert.equal(buyPriced, true);
    buyPriced = false;
    await h.intents.create({ agentId: h.agent.id, ownerAddress: OWNER, decisionId: "prior-buy", idempotencyKey: HASH,
      side: "buy", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: 40n * UNIT, entryWei: 40n * UNIT,
      positionId: "prior-buy", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
    await h.intents.markProjected(OWNER, h.agent.id, "prior-buy");
    h.setNow(now + 86_400_000);
    const result = await h.run();
    assert.equal(result.outcomes[0]?.reason, "portfolio-no-route");
    assert.deepEqual((await h.positions.listRuns(OWNER, h.agent.id, 1))[0]?.events?.filter((event) => event.code === "portfolio-refused").map((event) => event.token?.toLowerCase()), [sell]);
    assert.equal(buyPriced, false, "the buy route is available but must not be tried before a sell");
    assert.equal(h.calls.length, 0);
    assert.deepEqual((await h.intents.listPortfolio(OWNER, h.agent.id)).map((row) => row.decisionId), ["prior-buy"]);
    assert.equal((await h.intents.getPortfolioCheck(OWNER, h.agent.id, 1))?.state, "rebalancing");
  });

  it("disabled, unavailable, empty, and dry-run decisions submit nothing", async () => {
    const off = await world({ enabled: false });
    assert.equal((await off.run()).outcomes[0]?.reason, "portfolio-disabled");
    const unavailable = await world({ unavailable: true });
    assert.equal((await unavailable.run()).outcomes[0]?.reason, "data-plane-unavailable");
    const empty = await world({ usdt: 1n });
    assert.equal((await empty.run()).outcomes[0]?.reason, "portfolio-empty");
    assert.equal(await empty.intents.getPortfolioCheck(OWNER, empty.agent.id, 0), null);
    const dry = await world({ dryRun: true });
    assert.equal((await dry.run()).outcomes[0]?.reason, "dry-run");
    assert.equal(await dry.intents.getPortfolioCheck(OWNER, dry.agent.id, 0), null);
    assert.equal((await dry.intents.listPortfolio(OWNER, dry.agent.id)).length, 0);
    assert.equal((await runTradeWorkerOnce(dry.deps)).outcomes[0]?.reason, "portfolio-bought", "a later live run still decides slot zero");
  });

  it("a fresh denied paused or rolled-back deniedBy releases the leg; conflict, replay and adapter FAILED keep it taken", async () => {
    let simulationAttempts = 0;
    const results: readonly [string, TradeExecutor, boolean][] = [
      ["paused", { async execute() { return { kind: "denied", status: 409, code: "paused" }; } }, false],
      ["fresh rollback", { async execute() { return { kind: "rolled-back", code: "REFUSED", meta: { deniedBy: "preflight" } }; } }, false],
      ["simulation rollback", { async execute() { simulationAttempts += 1; return { kind: "rolled-back", code: "SIMULATION_FAILED", meta: { deniedBy: "venue" } }; } }, false],
      ["conflict", { async execute() { return { kind: "denied", status: 409, code: "conflict" }; } }, true],
      ["replay FAILED", { async execute() { return { kind: "rolled-back", code: "FAILED", meta: { replayed: true, deniedBy: "preflight" } }; } }, true],
      ["adapter FAILED", { async execute() { return { kind: "rolled-back", code: "not-confirmed", meta: {} }; } }, true],
    ];
    for (const [label, executor, taken] of results) {
      const h = await world({ executor });
      await h.run();
      const rows = await h.intents.listPortfolio(OWNER, h.agent.id);
      assert.equal(rows.length, taken ? 1 : 0, label);
      if (label === "simulation rollback") {
        await h.run(); assert.equal(simulationAttempts, 2); assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id)).length, 0);
      }
      if (taken) assert.equal(rows[0]?.state, "projected", label);
    }
  });

  it("the real executor's replay of a submitted FAILED, with and without a hash, never releases the portfolio leg", async () => {
    for (const withHash of [false, true]) {
      let h: Awaited<ReturnType<typeof world>>;
      h = await world({ executor: { async execute(input) {
        await h.journal.begin({ idempotencyKey: input.idempotencyKey, agentId: input.agent.id, ownerAddress: OWNER,
          kind: "trade", decisionId: input.request.decisionId, externalRef: { paramsHash: input.paramsHash } });
        await h.journal.markRolledBack(input.idempotencyKey, "failed receipt", withHash ? { txHash: HASH } : undefined);
        const replay = await executeTradeForAgent({ agent: input.agent, request: input.request,
          idempotencyKey: input.idempotencyKey, paramsHash: input.paramsHash, scanGate: input.scanGate,
          deps: { journal: h.journal } as unknown as Parameters<typeof executeTradeForAgent>[0]["deps"] });
        assert.equal(replay.kind, "rolled-back");
        if (replay.kind !== "rolled-back") throw new Error("Expected a real executor replay.");
        assert.equal(replay.meta.replayed, true);
        return { kind: "rolled-back", code: replay.code, meta: replay.meta };
      } } });
      await h.run();
      const [intent] = await h.intents.listPortfolio(OWNER, h.agent.id);
      assert.equal(intent?.state, "projected", `withHash=${withHash}`);
      assert.equal(intent?.entryWei, 25n * UNIT);
    }
  });

  it("a live hashless CONFIRMED buy is projected and its reservation remains", async () => {
    const h = await world({ executor: { async execute() { return { kind: "committed", receipt: { status: "CONFIRMED" }, fill: null, meta: {} }; } } });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    const row = (await h.intents.listPortfolio(OWNER, h.agent.id))[0];
    assert.equal(row?.state, "projected");
    assert.equal(row?.txHash, null);
    assert.equal(row?.entryWei, 25n * UNIT);
  });

  it("a live FAILED sell is sealed at zero and a CONFIRMED sell without a hash keeps null proceeds", async () => {
    const failed = await world({ usdt: 0n, balances: [30n * UNIT, 20n * UNIT], executor: {
      async execute() { return { kind: "rolled-back", code: "not-confirmed", meta: {} }; },
    } });
    await failed.run();
    assert.equal((await failed.intents.listPortfolio(OWNER, failed.agent.id))[0]?.portfolioProceedsAtomic, 0n);
    const hashless = await world({ usdt: 0n, balances: [30n * UNIT, 20n * UNIT], executor: {
      async execute() { return { kind: "committed", receipt: { status: "CONFIRMED" }, fill: null, meta: {} }; },
    } });
    await hashless.run();
    const row = (await hashless.intents.listPortfolio(OWNER, hashless.agent.id))[0];
    assert.equal(row?.state, "projected");
    assert.equal(row?.portfolioProceedsAtomic, null);
  });

  it("portfolio reconciliation projects hashless COMMITTED and FAILED journals but releases only journal absence", async () => {
    for (const side of ["buy", "sell"] as const) for (const state of ["COMMITTED", "ROLLED_BACK", "ABSENT"] as const) {
      const h = await world({ enabled: false });
      const id = `${side}-${state}`;
      const key = `0x${(side === "buy" ? "66" : "77").repeat(32)}` as Hex;
      await h.intents.create({ decisionId: id, idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER,
        side, token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: side === "buy" ? UNIT : 0n,
        positionId: id, closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
      if (state !== "ABSENT") {
        await h.journal.begin({ idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER, kind: "trade", decisionId: id });
        if (state === "COMMITTED") await h.journal.markCommitted(key);
        else await h.journal.markRolledBack(key, "failed receipt");
      }
      await h.run();
      const row = await h.intents.get(OWNER, h.agent.id, id);
      assert.equal(row?.state, state === "ABSENT" ? "rolled-back" : "projected", `${side}:${state}`);
      assert.equal(row?.entryWei, side === "buy" ? UNIT : 0n);
      if (side === "sell" && state === "ROLLED_BACK") assert.equal(row.portfolioProceedsAtomic, 0n);
      if (side === "sell" && state === "COMMITTED") assert.equal(row.portfolioProceedsAtomic, null);
    }
  });

  it("portfolio projection cannot roll back an intent whose submitter owns the entry fence", async () => {
    const h = await world({ enabled: false });
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const created = new Promise<void>((resolve) => { entered = resolve; });
    const key = `0x${"aa".repeat(32)}` as Hex;
    const submitter = h.settingsStore.withEntryFence(OWNER, h.agent.id, async () => {
      await h.intents.create({ decisionId: "fenced-submission", idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER,
        side: "buy", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: UNIT,
        positionId: "fenced-submission", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
      entered?.();
      await held;
      await h.journal.begin({ idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER, kind: "trade", decisionId: "fenced-submission" });
    });
    await created;
    const sweep = h.run();
    await Promise.resolve();
    assert.equal((await h.intents.get(OWNER, h.agent.id, "fenced-submission"))?.state, "pending");
    release?.();
    await submitter;
    await sweep;
    assert.equal((await h.intents.get(OWNER, h.agent.id, "fenced-submission"))?.state, "pending");
  });

  it("portfolio PENDING journal can become hashless COMMITTED without stranding a leg", async () => {
    const h = await world({ enabled: false });
    const key = `0x${"88".repeat(32)}` as Hex;
    await h.intents.create({ decisionId: "late-commit", idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER,
      side: "buy", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: UNIT,
      positionId: "late-commit", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
    await h.journal.begin({ idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER, kind: "trade", decisionId: "late-commit" });
    await h.run();
    assert.equal((await h.intents.get(OWNER, h.agent.id, "late-commit"))?.state, "pending");
    await h.journal.markCommitted(key);
    await h.run();
    assert.equal((await h.intents.get(OWNER, h.agent.id, "late-commit"))?.state, "projected");
  });

  it("a later journal hash lets a hashless sale adopt verified proceeds", async () => {
    const h = await world({ usdt: 0n, balances: [30n * UNIT, 20n * UNIT], executor: {
      async execute() { return { kind: "committed", receipt: { status: "CONFIRMED" }, fill: null, meta: {} }; },
    }, recoverFill: async () => ({ side: "sell", exitWei: 5n * UNIT, fillStatus: "verified", receiptOwnershipKey: "late-hash-proof" }) });
    await h.run();
    const sale = (await h.intents.listPortfolio(OWNER, h.agent.id))[0]!;
    assert.equal(sale.portfolioProceedsAtomic, null);
    await h.journal.begin({ idempotencyKey: sale.idempotencyKey, agentId: h.agent.id, ownerAddress: OWNER,
      kind: "trade", decisionId: sale.decisionId });
    await h.journal.markCommitted(sale.idempotencyKey, { txHash: HASH });
    await runTradeWorkerOnce({ ...h.deps, portfolioEnabled: false });
    assert.equal((await h.intents.get(OWNER, h.agent.id, sale.decisionId))?.portfolioProceedsAtomic, 5n * UNIT);
  });

  it("the fence catches a stock claimed during pricing", async () => {
    let onPrice: (() => Promise<void>) | null = null;
    let once = false;
    const reader: RouteQuoteReader = { async quoteV2(_path, amount) { if (!once && onPrice !== null) { once = true; await onPrice(); } return amount; },
      async quoteV3Single(_in, _out, _fee, amount) { return amount; }, async quoteV3Path(_path, amount) { return amount; },
      async quoteUniV3Single(_in, _out, _fee, amount) { return amount; }, async quoteUniV3Path(_path, amount) { return amount; } };
    const h = await world({ reader });
    onPrice = async () => {
      await h.intents.create({ decisionId: "other-worker", idempotencyKey: HASH, agentId: h.agent.id, ownerAddress: OWNER,
        side: "buy", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: UNIT,
        positionId: "other-worker", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
      await h.intents.markProjected(OWNER, h.agent.id, "other-worker");
    };
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio_leg_taken");
    assert.equal(h.calls.length, 0);
  });

  it("portfolio pause or revoke wins while a sell is pricing", async () => {
    for (const status of ["paused", "revoked"] as const) {
      let hook: (() => Promise<void>) | null = null;
      let once = false;
      const reader: RouteQuoteReader = { async quoteV2(_path, amount) { if (!once && hook !== null) { once = true; await hook(); } return amount; },
        async quoteV3Single(_in, _out, _fee, amount) { return amount; }, async quoteV3Path(_path, amount) { return amount; },
        async quoteUniV3Single(_in, _out, _fee, amount) { return amount; }, async quoteUniV3Path(_path, amount) { return amount; } };
      const h = await world({ usdt: 0n, balances: [30n * UNIT, 20n * UNIT], reader });
      hook = async () => { await h.agents.transitionAgentStatus({ ownerAddress: OWNER, agentId: h.agent.id,
        expectedStatus: "armed", expectedRowVersion: h.agent.rowVersion, status }); };
      assert.equal((await h.run()).outcomes[0]?.reason, "paused");
      assert.equal(h.calls.length, 0);
      assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id)).length, 0);
    }
  });

  it("a proven pre-submit refusal releases a token for the next tick in the same slot", async () => {
    let attempts = 0;
    const h = await world({ executor: { async execute({ request }) {
      attempts += 1;
      return attempts === 1 ? { kind: "denied", status: 409, code: "paused" }
        : { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
          fill: { side: "buy", entryWei: request.amountWei, tokenAmount: request.quotedOutWei, fillStatus: "unverified" }, meta: {} };
    } } });
    assert.equal((await h.run()).outcomes[0]?.reason, "paused");
    assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id)).length, 0);
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-bought");
    assert.equal(attempts, 2);
  });

  it("the fence refuses cash and day-meter shrink after pricing", async () => {
    for (const kind of ["cash", "meter"] as const) {
      let onPrice: (() => void) | null = null;
      let once = false;
      const reader: RouteQuoteReader = { async quoteV2(_path, amount) { if (!once && onPrice !== null) { once = true; onPrice(); } return amount; },
        async quoteV3Single(_in, _out, _fee, amount) { return amount; }, async quoteV3Path(_path, amount) { return amount; },
        async quoteUniV3Single(_in, _out, _fee, amount) { return amount; }, async quoteUniV3Path(_path, amount) { return amount; } };
      const h = await world({ reader });
      onPrice = () => kind === "cash" ? h.balances.set(USDT_56.toLowerCase(), 0n) : h.setQuoteRemaining(0n);
      assert.equal((await h.run()).outcomes[0]?.reason, "entry_budget_changed", kind);
      assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id)).length, 0);
    }
  });

  it("portfolio full fence dispatch refuses changed status, generation, slot, settings, check and R7 allowance", async () => {
    const cases: readonly [string, (h: Awaited<ReturnType<typeof world>>) => Promise<void>, string][] = [
      ["paused", async (h) => { const get = h.deps.agentStore.getAgentById.bind(h.deps.agentStore);
        Object.assign(h.deps.agentStore, { getAgentById: async (id: string) => { const agent = await get(id); return agent === null ? null : { ...agent, status: "paused" }; } }); }, "paused"],
      ["generation", async (h) => { const get = h.deps.agentStore.getAgentById.bind(h.deps.agentStore);
        Object.assign(h.deps.agentStore, { getAgentById: async (id: string) => { const agent = await get(id);
          return agent === null || agent.sessionFacts === null ? agent : { ...agent, sessionFacts: { ...agent.sessionFacts, generation: 2 } }; } }); }, "session_changed"],
      ["slot", async (h) => { h.setNow(h.agent.createdAt + 86_400_000); }, "portfolio_slot_changed"],
      ["settings", async (h) => { const next = portfolioSettings({ slippageBps: 150 });
        await h.settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: next, digest: tradeSettingsDigest(next) }); }, "settings_changed"],
      ["done", async (h) => { await h.intents.markPortfolioCheckDone(OWNER, h.agent.id, 0); }, "portfolio_slot_done"],
      ["allowance", async (h) => { await h.intents.create({ decisionId: "other-token", idempotencyKey: HASH, agentId: h.agent.id,
        ownerAddress: OWNER, side: "buy", token: STOCKS[1]!, route: { hops: [], fees: [] }, amountWei: 30n * UNIT,
        entryWei: 30n * UNIT, positionId: "other-token", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
        await h.intents.markProjected(OWNER, h.agent.id, "other-token"); }, "portfolio_capital_exhausted"],
    ];
    for (const [label, effect, expected] of cases) {
      let hook: (() => Promise<void>) | null = null;
      let once = false;
      const reader: RouteQuoteReader = { async quoteV2(_path, amount) { if (!once && hook !== null) { once = true; await hook(); } return amount; },
        async quoteV3Single(_in, _out, _fee, amount) { return amount; }, async quoteV3Path(_path, amount) { return amount; },
        async quoteUniV3Single(_in, _out, _fee, amount) { return amount; }, async quoteUniV3Path(_path, amount) { return amount; } };
      const h = await world({ reader });
      hook = () => effect(h);
      assert.equal((await h.run()).outcomes[0]?.reason, expected, label);
      assert.equal(h.calls.length, 0, label);
    }
  });

  it("portfolio fence quarantines UNKNOWN and PENDING arrivals during pricing", async () => {
    for (const state of ["UNKNOWN", "PENDING"] as const) {
      let hook: (() => Promise<void>) | null = null;
      let once = false;
      const reader: RouteQuoteReader = { async quoteV2(_path, amount) { if (!once && hook !== null) { once = true; await hook(); } return amount; },
        async quoteV3Single(_in, _out, _fee, amount) { return amount; }, async quoteV3Path(_path, amount) { return amount; },
        async quoteUniV3Single(_in, _out, _fee, amount) { return amount; }, async quoteUniV3Path(_path, amount) { return amount; } };
      const h = await world({ reader });
      hook = async () => {
        const key = `0x${"55".repeat(32)}` as Hex;
        await h.intents.create({ decisionId: "other-worker", idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER,
          side: "buy", token: STOCKS[1]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: UNIT,
          positionId: "other-worker", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
        await h.journal.begin({ idempotencyKey: key, agentId: h.agent.id, ownerAddress: OWNER, kind: "trade", decisionId: "other-worker" });
        if (state === "UNKNOWN") await h.journal.markUnknown(key, "relay timeout");
      };
      assert.equal((await h.run()).outcomes[0]?.reason, state === "UNKNOWN" ? "portfolio_submission_unknown" : "portfolio_pending_intent");
      assert.equal(h.calls.length, 0);
    }
  });

  it("portfolio completion replans when an older sale gains verified proceeds", async () => {
    const h = await world({ usdt: 0n, balances: [25n * UNIT, 25n * UNIT] });
    h.setNow(h.agent.createdAt + 86_400_000);
    await h.intents.create({ decisionId: "older-sale", idempotencyKey: HASH, agentId: h.agent.id, ownerAddress: OWNER,
      side: "sell", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: 5n * UNIT, entryWei: 0n,
      positionId: "older-sale", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
    await h.intents.markProjected(OWNER, h.agent.id, "older-sale");
    await h.intents.insertPortfolioCheck({ agentId: h.agent.id, ownerAddress: OWNER, slot: 1, state: "rebalancing", maxDriftBps: 500, valueWei: 50n * UNIT });
    const list = h.intents.listPortfolio.bind(h.intents);
    let reads = 0;
    Object.assign(h.intents, { listPortfolio: async (...args: Parameters<typeof list>) => {
      reads += 1;
      if (reads === 3) await h.intents.setPortfolioProceeds(OWNER, h.agent.id, "older-sale", 5n * UNIT, "older-proof");
      return list(...args);
    } });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-replan");
    assert.equal((await h.intents.getPortfolioCheck(OWNER, h.agent.id, 1))?.state, "rebalancing");
  });

  it("portfolio completion compares intent state as well as ids and proceeds", async () => {
    const h = await world({ usdt: 0n, balances: [25n * UNIT, 25n * UNIT] });
    await h.intents.insertPortfolioCheck({ agentId: h.agent.id, ownerAddress: OWNER, slot: 0, state: "rebalancing", maxDriftBps: 500, valueWei: 50n * UNIT });
    await h.intents.create({ decisionId: "prior", idempotencyKey: HASH, agentId: h.agent.id, ownerAddress: OWNER,
      side: "buy", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: UNIT, entryWei: UNIT,
      positionId: "prior", closeReason: null, portfolioSlot: 9, settlementAsset: "USDT" });
    await h.intents.markProjected(OWNER, h.agent.id, "prior");
    const list = h.intents.listPortfolio.bind(h.intents);
    let reads = 0;
    Object.assign(h.intents, { listPortfolio: async (...args: Parameters<typeof list>) => {
      reads += 1;
      const rows = await list(...args);
      return reads === 3 ? rows.map((row) => row.decisionId === "prior" ? { ...row, state: "pending" as const } : row) : rows;
    } });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-replan");
    assert.equal((await h.intents.getPortfolioCheck(OWNER, h.agent.id, 0))?.state, "rebalancing");
  });

  it("a credit adopted after valid completion leaves done in place and funds only the next slot", async () => {
    const h = await world({ usdt: 5n * UNIT, balances: [25n * UNIT, 25n * UNIT] });
    for (const [index, token] of STOCKS.entries()) {
      const id = `filled-${index}`;
      await h.intents.create({ decisionId: id, idempotencyKey: HASH, agentId: h.agent.id, ownerAddress: OWNER,
        side: "buy", token, route: { hops: [], fees: [] }, amountWei: 25n * UNIT, entryWei: 25n * UNIT,
        positionId: id, closeReason: null, portfolioSlot: 9, settlementAsset: "USDT" });
      await h.intents.markProjected(OWNER, h.agent.id, id);
    }
    await h.intents.create({ decisionId: "unproven-sale", idempotencyKey: HASH, agentId: h.agent.id, ownerAddress: OWNER,
      side: "sell", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: 5n * UNIT, entryWei: 0n,
      positionId: "unproven-sale", closeReason: null, portfolioSlot: 8, settlementAsset: "USDT" });
    await h.intents.markProjected(OWNER, h.agent.id, "unproven-sale");
    await h.intents.insertPortfolioCheck({ agentId: h.agent.id, ownerAddress: OWNER, slot: 0, state: "rebalancing", maxDriftBps: 500, valueWei: 50n * UNIT });
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-legs-too-small");
    assert.equal((await h.intents.getPortfolioCheck(OWNER, h.agent.id, 0))?.state, "done");
    await h.intents.setPortfolioProceeds(OWNER, h.agent.id, "unproven-sale", 5n * UNIT, "late-proof");
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-done");
    h.setNow(h.agent.createdAt + 86_400_000);
    await h.run();
    assert.equal((await h.intents.getPortfolioCheck(OWNER, h.agent.id, 1))?.state, "rebalancing");
  });

  it("portfolio credits 4.95 received rather than 5 quoted and later proof is adopted exactly once", async () => {
    let reads = 0;
    const key = `56|${HASH}|${WALLET.toLowerCase()}|0|${HASH}`;
    const h = await world({ usdt: 0n, balances: [30n * UNIT, 20n * UNIT], executor: {
      async execute() { return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
        fill: { side: "sell", exitWei: null, fillStatus: "unverified" }, meta: {} }; },
    }, recoverFill: async () => { reads += 1; return { side: "sell", exitWei: 4_950_000_000_000_000_000n,
      fillStatus: "verified", receiptOwnershipKey: key }; } });
    await h.run();
    const sale = (await h.intents.listPortfolio(OWNER, h.agent.id))[0]!;
    assert.equal(sale.portfolioProceedsAtomic, null);
    await runTradeWorkerOnce({ ...h.deps, portfolioEnabled: false });
    assert.equal((await h.intents.get(OWNER, h.agent.id, sale.decisionId))?.portfolioProceedsAtomic, 4_950_000_000_000_000_000n);
    await runTradeWorkerOnce({ ...h.deps, portfolioEnabled: false });
    assert.equal(reads, 1);
  });

  it("portfolio failed sell grants zero buying power", async () => {
    const h = await world({ usdt: 100n * UNIT, balances: [30n * UNIT, 20n * UNIT], executor: {
      async execute() { return { kind: "rolled-back", code: "not-confirmed", meta: {} }; },
    } });
    for (const [index, token] of STOCKS.entries()) {
      const id = `prior-buy-${index}`;
      await h.intents.create({ decisionId: id, idempotencyKey: HASH, agentId: h.agent.id, ownerAddress: OWNER,
        side: "buy", token, route: { hops: [], fees: [] }, amountWei: 25n * UNIT, entryWei: 25n * UNIT,
        positionId: id, closeReason: null, portfolioSlot: 99, settlementAsset: "USDT" });
      await h.intents.markProjected(OWNER, h.agent.id, id);
    }
    await h.run();
    const sale = (await h.intents.listPortfolio(OWNER, h.agent.id)).find((row) => row.side === "sell");
    assert.equal(sale?.portfolioProceedsAtomic, 0n);
    assert.equal(sale?.state, "projected");
    assert.equal((await h.run()).outcomes[0]?.reason, "portfolio-capital-used");
  });

  it("portfolio proof recovery skips wrong-side, unverified, null-exit and keyless fills", async () => {
    const invalid = [
      { side: "buy" as const, entryWei: UNIT, tokenAmount: UNIT, fillStatus: "verified" as const },
      { side: "sell" as const, exitWei: UNIT, fillStatus: "unverified" as const, receiptOwnershipKey: "key" },
      { side: "sell" as const, exitWei: null, fillStatus: "verified" as const, receiptOwnershipKey: "key" },
      { side: "sell" as const, exitWei: UNIT, fillStatus: "verified" as const },
    ];
    for (const fill of invalid) {
      const h = await world({ usdt: 0n, balances: [30n * UNIT, 20n * UNIT], executor: {
        async execute() { return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH }, fill: null, meta: {} }; },
      }, recoverFill: async () => fill });
      await h.run();
      await runTradeWorkerOnce({ ...h.deps, portfolioEnabled: false });
      assert.equal((await h.intents.listPortfolio(OWNER, h.agent.id))[0]?.portfolioProceedsAtomic, null);
    }
  });

  it("portfolio proof recovery stops at exactly seven days and a terminal zero is never revisited", async () => {
    const now = Date.now();
    let reads = 0;
    const h = await world({ now, usdt: 0n, balances: [30n * UNIT, 20n * UNIT], executor: {
      async execute() { return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH }, fill: null, meta: {} }; },
    }, recoverFill: async () => { reads += 1; return { side: "sell", exitWei: null, fillStatus: "unverified" }; } });
    await h.run();
    Object.assign(h.deps, { now: () => now + 7 * 86_400_000 - 1 });
    await runTradeWorkerOnce({ ...h.deps, portfolioEnabled: false });
    assert.equal(reads, 1);
    Object.assign(h.deps, { now: () => now + 7 * 86_400_000 });
    await runTradeWorkerOnce({ ...h.deps, portfolioEnabled: false });
    assert.equal(reads, 1);
    const sale = (await h.intents.listPortfolio(OWNER, h.agent.id))[0]!;
    await h.intents.setPortfolioProceeds(OWNER, h.agent.id, sale.decisionId, 0n, null);
    Object.assign(h.deps, { now: () => now + 1 });
    await runTradeWorkerOnce({ ...h.deps, portfolioEnabled: false });
    assert.equal(reads, 1);
  });
});
