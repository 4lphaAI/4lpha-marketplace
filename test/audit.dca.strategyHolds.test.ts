/**
 * AUTO-DCA audit (Fable 5.1, 2026-09-25) — adversarial pins for four holds the
 * mutation pass found unpinned by the builders' suites. Each was a SURVIVING
 * mutant of the worker (`src/trade/worker.ts`); the product code is correct,
 * the suites simply never exercised the branch alone:
 *
 *   1. `dca-submission-unknown` (R2.8): with an `unknown` action and NO protective
 *      step pending, the strategy phase must hold and claim nothing — the
 *      in-flight index deliberately excludes `unknown`, so without this hold a
 *      landed-but-unknown start could be followed by a second start (a double buy).
 *   2. R2.14: round 1's trigger compares the offer's on-chain `minOut`, never its
 *      quoted output, against `ceil(entryWei · 1e8 / trigger)`.
 *   3. Condition 1 (Remove half): a round is written `settled/removed` only once
 *      the chain shows no DCA position with liquidity — a resting USDT level with
 *      no stock to sell must still be swept, never settled past.
 *   4. R2.12 / §5.3 step 1: a live order whose chain liquidity differs from the
 *      persisted liquidity holds `dca-order-mismatch` in the strategy phase.
 *
 * The world below is the A2 worker suite's harness, reduced to what these four
 * pins need (a real memory store, journal, kill switch and range executor; a
 * fake chain; the guard-first pricing on a fake Flash quote).
 */
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { type Hex } from "viem";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { MemoryDcaRoundStore } from "../src/store/dcaRounds.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import { WBNB_56 } from "../src/ops/venues.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import type { TradeDataPlaneReads, UniverseRow } from "../src/trade/dataPlaneReads.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { dcaBatchCalls, dcaPoolLegs, dcaPriceAtTick, dcaTriggerMinOutWei, type DcaBatchPlan } from "../src/trade/dca.js";
import { executeDcaRangeBatch } from "../src/trade/dcaExecute.js";
import type { DcaChainReads, DcaPositionRead } from "../src/trade/dcaResolve.js";
import type { TradfiReceiptObservation } from "../src/trade/receipt.js";
import { FakeWalletProvider, tradeConfig } from "./support/serverHarness.js";
import { AGENT_ID, E18, GUARD, NV, NV_TICK, OWNER, TREASURY, WALLET, dcaAgent, dcaObservation, dcaSettings, planLogs } from "./support/dcaFixtures.js";

const START = Date.UTC(2026, 8, 25, 14);
const PRICE = 223.37;
const QUOTE = 10n ** 13n;

type Chain = {
  tick: number;
  block: bigint;
  positions: Map<bigint, Exclude<DcaPositionRead, "burned">>;
  walletIds: bigint[];
  balances: Map<string, bigint>;
};

function chainReads(chain: Chain): DcaChainReads {
  return {
    async reading() { return { block: chain.block, tick: chain.tick, sqrtPriceX96: getSqrtRatioAtTick(chain.tick) }; },
    async position(tokenId) { return chain.positions.get(tokenId) ?? "burned"; },
    async walletTokenIds() { return [...chain.walletIds]; },
    async tokenBalance(token) { return chain.balances.get(token.toLowerCase()) ?? 0n; },
    async gasPriceWei() { return 50_000_000n; },
    async nfpmLogs() { return []; },
  };
}

async function world(t: TestContext, input: { readonly settings?: Partial<TradeSettings> } = {}) {
  let now = START;
  t.mock.method(Date, "now", () => now);
  const { agents, agent } = await dcaAgent({ nowMs: now });
  const settingsStore = new MemoryTradeSettingsStore(agents, () => now);
  const settings = dcaSettings(input.settings);
  await settingsStore.put({ agentId: agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  const store = new MemoryDcaRoundStore();
  const journal = new MemoryExecutionJournal(() => now);
  const killswitch = new MemoryKillSwitch(() => now);
  const provider = new FakeWalletProvider();
  const positions = new MemoryTradePositionStore(() => now);
  const chain: Chain = { tick: NV_TICK, block: 1_000n, positions: new Map(), walletIds: [], balances: new Map([[USDT_56.toLowerCase(), 100n * E18]]) };
  const observations = new Map<Hex, TradfiReceiptObservation>();
  let hashSeq = 0;
  const stockPerUsdt = (amount: bigint): bigint => amount * 100_000n / BigInt(Math.round(PRICE * 100_000));
  const rwaVenue = { dex: "pancakeswap", version: "v3", pool: NV.pool, quote: USDT_56, quoteSymbol: "USDT", feeTier: 2500,
    liquidityUsd: 100_000, volume24hUsd: 1_000, priceUsd: PRICE, asOf: now } as const;
  const row: UniverseRow = { address: NV.stock, symbol: "NVDAB", lane: "bstocks", source: "fixture", venues: [rwaVenue],
    rwa: { platform: "bstocks", underlyingTicker: "NVDA", tokenPriceUsd: PRICE, referencePriceUsd: PRICE, premiumBps: 0, openState: true,
      marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: PRICE, venues: [rwaVenue] } };
  const dataPlane: TradeDataPlaneReads = {
    universe: async (lane) => lane === "bstocks" ? [row] : [],
    tokensBatch: async (addresses) => addresses.map((address) => ({ address, priceUsd: address.toLowerCase() === WBNB_56.toLowerCase() ? 769.4 : 1,
      marketCapUsd: null, volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: now, staleness: "fresh" as const })),
    eligibilityBatch: async (addresses) => addresses.map((address) => ({ address, eligible: true, reason: "ok", source: "binance-rwa" as const, venue: null })),
    security: async () => ({ riskLevel: "ok", flags: [] }),
    binanceQuoteAndSwap: async (request) => {
      const amount = BigInt(request.amountAtomic);
      const quoted = request.tokenIn.toLowerCase() === USDT_56.toLowerCase() ? stockPerUsdt(amount) : amount * BigInt(Math.round(PRICE * 100)) / 100n;
      return { version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: request.tokenIn, tokenOut: request.tokenOut,
        amountInAtomic: request.amountAtomic, quotedOutAtomic: quoted.toString(), minOutAtomic: (quoted * 99n / 100n).toString(),
        router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", value: "0",
        observedAt: now, expiresAt: now + 15_000, estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56 };
    },
  };
  const noAmm = async (): Promise<bigint> => { throw new Error("no public AMM"); };
  const routeReader: RouteQuoteReader = { quoteV2: noAmm, quoteV3Single: noAmm, quoteV3Path: noAmm, quoteUniV3Single: noAmm, quoteUniV3Path: noAmm };
  const trade = tradeConfig({ feeBps: 100, feeTreasury: TREASURY });
  const meter = 275n * E18;
  const deps: TradeWorkerDeps = {
    agentStore: agents, settingsStore, positions, intents: new MemoryTradeIntentStore(() => now), journal, dataPlane, killswitch,
    provider: {
      getTokenBalance: async ({ token }) => chain.balances.get(token.toLowerCase()) ?? 0n,
      getTokenMetadata: async () => ({ decimals: 18, symbol: "NVDAB" }),
      readSpendInfos: async () => [{ token: USDT_56, period: "day", periodCode: 2, limitWei: 275n * E18, currentSpentWei: 275n * E18 - meter }],
    },
    llmFor: () => ({ complete: async () => { throw new Error("a DCA agent must never reach the model"); } }),
    executor: { execute: async () => { throw new Error("a DCA agent never uses the trade executor"); } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([NV.stock.toLowerCase()]) },
    rpcUrls: [], routeReader, platformFeeBps: 100, platformFeeTreasury: TREASURY, aggregatorGuard: GUARD,
    tradfiNativeCostUsdtAtomic: async () => 1n, forbiddenAddresses: () => new Set(),
    executionIdentity: () => ({ idempotencyKey: `0x${"01".repeat(32)}`, paramsHash: `0x${"02".repeat(32)}` }),
    recoverFill: async () => ({ side: "buy", entryWei: 0n, tokenAmount: null, fillStatus: "unverified" }),
    now: () => now, intervalMs: 60_000,
    dca: {
      store, enabled: true, nfpm: NFPM_56, chain: chainReads(chain), batchCostWei: async () => QUOTE,
      executeRange: (range) => executeDcaRangeBatch({ store, settingsStore, agentStore: agents, journal, killswitch,
        providerRegistry: { get: () => provider }, chainId: 56, trade, nfpm: NFPM_56,
        quoteRemaining: async () => meter, walletUsdt: async () => chain.balances.get(USDT_56.toLowerCase()) ?? 0n, nowMs: () => now }, range),
      receipts: { readFinalized: async (hash) => observations.get(hash) ?? null, getReceipt: async () => null },
      journal,
    },
  };

  async function cycle() {
    now += 61_000;
    chain.block += 200n;
    hashSeq += 1;
    provider.nextReceipt = { status: "CONFIRMED", callsId: `0x${"c1".repeat(32)}`, transactionHash: `0x${hashSeq.toString(16).padStart(64, "0")}` as Hex };
    return runTradeWorkerOnce(deps);
  }

  async function lastAction() {
    const actions = await store.listActions(OWNER, AGENT_ID);
    assert.ok(actions.length > 0, "no DCA action was claimed");
    return actions.at(-1)!;
  }

  /** The chain lands the last submitted batch: positions move and a verifying receipt appears. */
  async function land(input: { readonly firstTokenId: bigint; readonly swapOutWei?: bigint }): Promise<DcaBatchPlan> {
    const action = await lastAction();
    const plan = action.plan;
    const txHash = provider.nextReceipt.transactionHash!;
    const calls = dcaBatchCalls(plan, { pool: NV, nfpm: NFPM_56, wallet: WALLET, treasury: TREASURY });
    observations.set(txHash, dcaObservation(calls, planLogs(plan, NV, input), txHash));
    const legs = dcaPoolLegs(NV);
    for (const exit of plan.exits) {
      const current = chain.positions.get(exit.tokenId);
      if (current !== undefined) chain.positions.set(exit.tokenId, { ...current, liquidity: 0n });
    }
    for (const [index, mint] of plan.mints.entries()) {
      const tokenId = input.firstTokenId + BigInt(index);
      chain.positions.set(tokenId, { liquidity: mint.liquidity, tickLower: mint.tickLower, tickUpper: mint.tickUpper, token0: legs.token0, token1: legs.token1, fee: NV.fee });
      chain.walletIds.push(tokenId);
    }
    return plan;
  }

  async function lastRunReason(): Promise<string> {
    return (await positions.listRuns(OWNER, AGENT_ID, 1))[0]?.reason ?? "";
  }

  return { get now() { return now; }, agents, agent, settingsStore, store, journal, provider, positions, chain, deps, cycle, lastAction, land, lastRunReason };
}

/** Round 1's start landed: the round is active with P0 at the pool price, a live TP and four pending levels. */
async function activeRound(t: TestContext) {
  const w = await world(t);
  await w.cycle();
  const start = await w.lastAction();
  assert.equal(start.kind, "start");
  const p0 = dcaPriceAtTick(NV, NV_TICK);
  const swapOutWei = 15n * E18 * p0.den / p0.num;
  await w.land({ firstTokenId: 700n, swapOutWei });
  w.chain.balances.set(NV.stock.toLowerCase(), swapOutWei - start.plan.mints[0]!.amount0Desired);
  await w.cycle();
  assert.equal((await w.store.getAction(OWNER, start.actionKey))?.state, "finished");
  return w;
}

describe("AUDIT — Auto DCA strategy holds the builders' suites left unpinned", () => {
  it("1. an `unknown` action alone holds the strategy (`dca-submission-unknown`) and claims nothing, even with a level due", async (t) => {
    const w = await activeRound(t);
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    // A plan of any shape, claimed and then marked `unknown` — the slot the in-flight index does NOT hold.
    const claimed = await w.store.claimAction({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: round.roundNo,
      expectedRowVersion: round.rowVersion, plan: { ...(await w.lastAction()).plan, kind: "level-place" }, nowMs: w.now });
    assert.equal(claimed.kind, "claimed");
    await w.store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["intended"], to: "unknown", nowMs: w.now });
    const before = (await w.store.listActions(OWNER, AGENT_ID)).length;
    // L1 [53900, 53950) is due at mid ≤ 221.34 (R2.5): tick 53955 sits inside the due zone.
    w.chain.tick = 53_955;
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-submission-unknown/u);
    assert.equal((await w.store.listActions(OWNER, AGENT_ID)).length, before, "no batch may be claimed past an unknown action");
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-submission-unknown/u);
    assert.equal((await w.store.listActions(OWNER, AGENT_ID)).length, before);
  });

  it("2. R2.14: the trigger is judged on the offer's on-chain minOut, not its quoted output", async (t) => {
    // The fake offer quotes 15 USDT → 15/223.37 stock with minOut = 99 % of that. A trigger at
    // 224.50 sits between the two: the QUOTE clears its floor, the on-chain minOut does not.
    const trigger = 224_50_000_000n; // 224.50 × 1e8
    const w = await world(t, { settings: { dcaTriggerPriceE8: trigger.toString(10) } });
    const quoted = 15n * E18 * 100_000n / BigInt(Math.round(PRICE * 100_000));
    const floor = dcaTriggerMinOutWei(15n * E18, trigger);
    assert.ok(quoted * 99n / 100n < floor && floor <= quoted, "the vector must separate minOut from the quote");
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-trigger-not-reached/u);
    assert.equal((await w.store.listActions(OWNER, AGENT_ID)).length, 0, "no start may be claimed on the quote alone");
  });

  it("3. condition 1 (Remove): a resting USDT level with no stock to sell is swept, never settled past", async (t) => {
    const w = await activeRound(t);
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    // The TP is pulled to nothing and the wallet holds no stock, so the sale leg is empty; the
    // levels rest on chain — the plane must still exit every one before it may write `removed`.
    // Under R3 the round starts with L1/L2 already minted (701/702); re-keying L1 to 900 below
    // leaves 701 as a chain position the store no longer names, which the sweep must still exit.
    for (const order of await w.store.listOrders(AGENT_ID, round.roundNo)) {
      if (order.role === "tp") {
        await w.store.putOrder({ ...order, state: "exited", collectedUsdtWei: 0n, collectedStockWei: order.mintedStockWei, closedBy: "owner", updatedAtMs: w.now });
        w.chain.positions.set(order.tokenId!, { ...w.chain.positions.get(order.tokenId!)!, liquidity: 0n });
      }
    }
    w.chain.balances.set(NV.stock.toLowerCase(), 0n);
    const legs = dcaPoolLegs(NV);
    const level = (await w.store.listOrders(AGENT_ID, round.roundNo)).find((order) => order.levelNo === 1)!;
    await w.store.putOrder({ ...level, state: "live", tokenId: 900n, liquidity: 5_000_000_000_000_000n, mintedUsdtWei: 10n * E18, updatedAtMs: w.now });
    w.chain.positions.set(900n, { liquidity: 5_000_000_000_000_000n, tickLower: level.tickLower, tickUpper: level.tickUpper, token0: legs.token0, token1: legs.token1, fee: NV.fee });
    w.chain.walletIds.push(900n);
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    await w.cycle();
    const action = await w.lastAction();
    assert.equal(action.kind, "remove");
    // Re-baselined by the R3 auditor (AUTO-DCA R3.14 D-R3-2, review L5): the invariant, not an id
    // list. Every chain position with liquidity in the pinned pool is in the Remove's exit set,
    // derived from the fixture's chain — the resting level 900 among them.
    const byId = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
    const onChain = w.chain.walletIds.filter((id) => (w.chain.positions.get(id)?.liquidity ?? 0n) > 0n).sort(byId);
    assert.ok(onChain.includes(900n) && onChain.length >= 2, "the fixture must leave the resting level, and more, on chain");
    assert.deepEqual(action.plan.exits.map((exit) => exit.tokenId).sort(byId), onChain, "every position with liquidity is swept before `removed`");
    assert.equal(action.plan.swap, null, "nothing to sell, so the batch is the sweep alone");
    const after = (await w.store.listRounds(OWNER, AGENT_ID)).find((row) => row.roundNo === round.roundNo)!;
    assert.notEqual(after.phase, "settled", "removed may only be written once the chain shows no DCA position");
  });

  it("4. R2.12: a live order whose chain liquidity differs from the persisted one holds dca-order-mismatch", async (t) => {
    const w = await activeRound(t);
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    const tp = (await w.store.listOrders(AGENT_ID, round.roundNo)).find((order) => order.role === "tp")!;
    w.chain.positions.set(tp.tokenId!, { ...w.chain.positions.get(tp.tokenId!)!, liquidity: tp.liquidity / 2n });
    w.chain.tick = 53_955;
    const before = (await w.store.listActions(OWNER, AGENT_ID)).length;
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-order-mismatch/u);
    assert.equal((await w.store.listActions(OWNER, AGENT_ID)).length, before, "a mismatched order never dispatches a batch");
  });
});

describe("AUDIT — R2.4 lever 2b: the merged close + start must never hold the close hostage", () => {
  it("5. with the wallet's USDT below B + fee, the executor denies close + start every cycle and the close never runs (the TP's USDT stays in the NFT)", async (t) => {
    const w = await activeRound(t);
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    const tp = (await w.store.listOrders(AGENT_ID, round.roundNo)).find((order) => order.role === "tp")!;
    // The wallet holds 5 USDT: less than the 15.15 a start spends, while the converted TP holds ~15.2 USDT
    // on chain — R2.4 counts that collect as cash for the merged batch; the executor does not.
    w.chain.balances.set(USDT_56.toLowerCase(), 5n * E18);
    w.chain.balances.set(NV.stock.toLowerCase(), 0n);
    w.chain.tick = tp.tickUpper + 25; // strictly above the TP range: it reads converted (stock = token0 ⇒ tick ≥ tickUpper)
    const before = (await w.store.listActions(OWNER, AGENT_ID)).length;
    await w.cycle(); // first confirming reading
    await w.cycle(); // second: confirmed at the dispatching cycle's own reading ⇒ close (+ start)
    await w.cycle();
    await w.cycle();
    const actions = (await w.store.listActions(OWNER, AGENT_ID)).slice(before);
    const closes = actions.filter((action) => action.kind === "close" || action.kind === "close-start");
    assert.ok(closes.length > 0, `R2.4: the close must run (alone when a start gate fails); got reasons ${await w.lastRunReason()} and no close batch at all`);
  });
});

describe("AUDIT — re-verification pins on the fix pass (H-2, M-3)", () => {
  it("6. H-2: only the NFPM's own `Invalid token ID` revert reads as burned; any other revert throws", async (t) => {
    const { createDcaChainReads } = await import("../src/trade/dcaResolve.js");
    const { dcaRpcEndpoint } = await import("./support/dcaFixtures.js");
    const other = createDcaChainReads({ rpcUrls: [await dcaRpcEndpoint(t, "Not approved")], nfpm: NFPM_56 });
    await assert.rejects(other.position(700n, 1n), "a revert that is not the burned-id reason must not read as burned");
    const burned = createDcaChainReads({ rpcUrls: [await dcaRpcEndpoint(t, "Invalid token ID")], nfpm: NFPM_56 });
    assert.equal(await burned.position(700n, 1n), "burned");
  });

  it("7. M-3: the wei oracle is taken only for a start priced with `extraCallsFor`; AI Trade and Schedule keep `tradfiNativeCostUsdtAtomic` even with the DCA deps composed", async () => {
    const { readFileSync } = await import("node:fs");
    const worker = readFileSync(new URL("../src/trade/worker.ts", import.meta.url), "utf8");
    assert.match(worker, /const weiOracle = extraCallsFor === undefined \? undefined : deps\.dca\?\.batchCostWei;/u);
    // `submitTradfiV2Buy` (AI Trade and Schedule) never passes the hook.
    const submit = worker.slice(worker.indexOf("async function submitTradfiV2Buy("), worker.indexOf("async function processAgent("));
    assert.match(submit, /await priceTradfiV2Buy\(deps, agent, settings, input, facts, counts, signal\);/u);
    assert.doesNotMatch(submit, /extraCallsFor/u);
  });
});

describe("AUDIT — post-audit change 2288825 (Auto DCA charges no platform fee; every other mode keeps FEE_BPS)", () => {
  it("8. a DCA start prices and submits NO transfer to the treasury even though the worker configures 100 bps and a treasury", async (t) => {
    const w = await world(t);
    const priced: (readonly { readonly to: `0x${string}`; readonly data?: `0x${string}` }[])[] = [];
    Object.assign(w.deps, { tradfiNativeCostUsdtAtomic: async (request: { readonly calls: readonly { readonly to: `0x${string}`; readonly data?: `0x${string}` }[] }) => { priced.push(request.calls); return 1n; } });
    Object.assign(w.deps.dca!, { batchCostWei: async (input: { readonly calls: readonly { readonly to: `0x${string}`; readonly data?: `0x${string}` }[] }) => { priced.push(input.calls); return QUOTE; } });
    await w.cycle();
    const start = (await w.store.listActions(OWNER, AGENT_ID)).at(-1)!;
    assert.equal(start.kind, "start");
    assert.equal(start.plan.feeWei, 0n);
    const treasury = TREASURY.slice(2).toLowerCase();
    const toTreasury = (call: { readonly to: `0x${string}`; readonly data?: `0x${string}` }) =>
      call.to.toLowerCase() === USDT_56.toLowerCase() && (call.data ?? "").toLowerCase().startsWith("0xa9059cbb") && (call.data ?? "").toLowerCase().includes(treasury);
    assert.ok(priced.length > 0, "the start was priced");
    assert.ok(priced.every((calls) => !calls.some(toTreasury)), "a priced DCA batch must carry no fee transfer (the grant has no transfer rule)");
    assert.ok(!w.provider.executeCalls[0]!.calls.some(toTreasury), "the submitted start carries no fee transfer");
  });

  it("9. the fee is selected per mode at both branch points: DCA ⇒ 0, everything else ⇒ the configured fee (source level)", async () => {
    const { readFileSync } = await import("node:fs");
    const worker = readFileSync(new URL("../src/trade/worker.ts", import.meta.url), "utf8");
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    assert.match(worker, /const feeBps = extraCallsFor === undefined \? deps\.platformFeeBps : DCA_PLATFORM_FEE_BPS;/u);
    assert.match(server, /const v2FeeBps = dcaHire \? DCA_PLATFORM_FEE_BPS : hire\.feeBps;/u);
    // The non-DCA request keeps the configured fee (`submitTradfiV2Buy` builds the TradeRequest's platformFeeAtomic from deps).
    assert.match(worker, /platformFeeAtomic: tradfiV2BuyFeeWei\(amount, deps\.platformFeeBps\)/u);
  });
});
