/**
 * The Auto DCA range executor (AUTO-DCA §5.6, R2.7–R2.10, R2.21 B1/H1/H4/I2;
 * REVIEW2 conditions 4, 5, 12) and the fence on the `tradfiV2SwapRefusal`
 * extraction.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { keccak256, stringToBytes, type Hex } from "viem";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { MemoryDcaRoundStore, type DcaOrderRow } from "../src/store/dcaRounds.js";
import { buildTradfiApprove, buildTradfiPancakeV3Swap } from "../src/ops/tradfi.js";
import { PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import { getLiquidityForAmounts, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { buildTradfiGuardSwapCall, TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { R_DCA } from "../src/trade/sizing.js";
import { executeTradeForAgent, tradfiV2SwapRefusal } from "../src/trade/execute.js";
import { planDcaCloseStart, planDcaLevelPlace, planDcaRemove, planDcaStart, planDcaStopLoss, type DcaBatchPlan, type DcaLiveOrder, type DcaSwapLeg } from "../src/trade/dca.js";
import { dcaBatchBoundsRefusal, dcaIdempotencyKey, executeDcaRangeBatch, type DcaExecuteDeps, type DcaExecuteInput } from "../src/trade/dcaExecute.js";
import { MAX_CALLS_PER_EXECUTE } from "../src/wallet/altana.js";
import { FakeWalletProvider, tradeConfig } from "./support/serverHarness.js";
import { AGENT_ID, E18, GUARD, NV, NV_TICK, OWNER, TREASURY, WALLET, dcaAgent, dcaEffective, dcaSettings } from "./support/dcaFixtures.js";

const NOW = Date.UTC(2026, 8, 25, 12);
const NOW_SEC = BigInt(Math.floor(NOW / 1_000));
const READING = { block: 100n, tick: NV_TICK, sqrtPriceX96: getSqrtRatioAtTick(NV_TICK) };
const DEADLINE = NOW_SEC + 300n;
const QUOTE = 10n ** 13n;
const MIN_OUT = 66_000_000_000_000_000n;
const LEVEL: DcaLiveOrder = { orderKey: "r1:l1", role: "level", levelNo: 1, tokenId: 6n, tickLower: 53_900, tickUpper: 53_950, liquidity: 2_000_000_000_000_000n };

type HarnessInput = {
  readonly status?: "armed" | "paused";
  readonly paused?: boolean;
  readonly remainingSec?: number;
  readonly meter?: bigint | null;
  readonly cash?: bigint;
  readonly settings?: Partial<TradeSettings>;
  readonly draining?: boolean;
  readonly quoteDailyCapWei?: bigint | null;
  readonly levelMinted?: readonly bigint[];
};

async function harness(input: HarnessInput = {}) {
  const { agents, agent } = await dcaAgent({ nowMs: NOW, ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.remainingSec === undefined ? {} : { remainingSec: input.remainingSec }),
    ...(input.quoteDailyCapWei === undefined ? {} : { quoteDailyCapWei: input.quoteDailyCapWei }) });
  const settingsStore = new MemoryTradeSettingsStore(agents, () => NOW);
  const settings = dcaSettings(input.settings);
  await settingsStore.put({ agentId: agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  if (input.draining === true) await settingsStore.requestDrain(OWNER, agent.id);
  const store = new MemoryDcaRoundStore();
  const round = (await store.insertRound({ agentId: agent.id, ownerAddress: OWNER, roundNo: 1, phase: "active", p0UsdtWei: 15n * E18,
    p0StockWei: 67n * 10n ** 15n, costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n, carriedStockWei: 0n,
    carriedCostWei: 0n, slBaselineWei: 55n * E18, nowMs: NOW }))!;
  const levelRow: DcaOrderRow = { agentId: agent.id, roundNo: 1, orderKey: "r1:l1", role: "level", levelNo: 1, tickLower: 53_900, tickUpper: 53_950,
    tokenId: null, state: "pending", liquidity: 0n, mintedUsdtWei: 0n, mintedStockWei: 0n, collectedUsdtWei: 0n, collectedStockWei: 0n,
    crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: null, exitedByAction: null, lastSeenLiveBlock: null, closedBy: null, updatedAtMs: NOW };
  await store.putOrder(levelRow);
  await store.putOrder({ ...levelRow, orderKey: "r1:l0", levelNo: 5, tickLower: 53_000, tickUpper: 53_050, tokenId: 6n, state: "live", liquidity: LEVEL.liquidity });
  for (const [index, minted] of (input.levelMinted ?? []).entries()) {
    await store.putOrder({ ...levelRow, orderKey: `r1:x${index}`, levelNo: 10 + index, state: "exited", mintedUsdtWei: minted });
  }
  const journal = new MemoryExecutionJournal(() => NOW);
  const killswitch = new MemoryKillSwitch(() => NOW);
  if (input.paused === true) await killswitch.pauseAgent(agent.id, OWNER);
  const provider = new FakeWalletProvider();
  const deps: DcaExecuteDeps = {
    store, settingsStore, agentStore: agents, journal, killswitch, providerRegistry: { get: () => provider }, chainId: 56,
    trade: tradeConfig({ feeBps: 100, feeTreasury: TREASURY }), nfpm: NFPM_56,
    quoteRemaining: async () => input.meter === undefined ? 275n * E18 : input.meter,
    walletUsdt: async () => input.cash ?? 100n * E18, nowMs: () => NOW,
  };
  return { agents, agent, settingsStore, store, round, journal, killswitch, provider, deps };
}

function ready(plan: DcaBatchPlan): DcaBatchPlan {
  return { ...plan, preSubmit: { walletUsdtWei: 100n * E18, walletStockWei: 0n }, relayQuoteWei: QUOTE };
}

function levelPlan(orderWei = 10n * E18): DcaBatchPlan {
  return ready(planDcaLevelPlace({ pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE,
    levels: [{ orderKey: "r1:l1", levelNo: 1, range: { tickLower: 53_900, tickUpper: 53_950 } }], orderWei }));
}

function stopPlan(): DcaBatchPlan {
  return ready(planDcaStopLoss({ pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE, orders: [LEVEL], slippageBps: 100 }));
}

function directLeg(patch: Partial<DcaSwapLeg> = {}): DcaSwapLeg {
  const amountInWei = patch.amountInWei ?? 15n * E18;
  const calls = buildTradfiPancakeV3Swap({ router: PANCAKE_V3_ROUTER_56, tokenIn: USDT_56, tokenOut: NV.stock, amountInWei,
    minOutWei: MIN_OUT, recipient: WALLET, deadline: DEADLINE, route: { hops: [], fees: [2500] } });
  return { side: "buy", amountInWei, minOutWei: MIN_OUT, quotedOutWei: 66_600_000_000_000_000n, calls, ...patch };
}

const LADDER = { stepBps: 100, maxOrders: 4, orderWei: 10n * E18, rangeMinE8: null };

function startPlan(swap: DcaSwapLeg = directLeg(), feeWei = 0n, residueStockWei = 0n): DcaBatchPlan {
  return ready(planDcaStart({ pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE, swap, feeWei,
    carriedCostWei: 0n, residueStockWei, takeProfitBps: 150, tpOrderKey: "r1:tp:100", ladder: LADDER }));
}

function inputFor(h: Awaited<ReturnType<typeof harness>>, plan: DcaBatchPlan, patch: Partial<DcaExecuteInput> = {}): DcaExecuteInput {
  return { agent: h.agent, pool: NV, round: h.round, plan, sweep: plan.kind === "stop-loss" || plan.kind === "remove",
    settings: dcaEffective(), ...patch };
}

describe("executeDcaRangeBatch", () => {
  it("journals kind dcaRange under the fresh action key, marks its orders, and submits with the literal bypassLocalPolicyCheck: false", async () => {
    const h = await harness();
    const result = await executeDcaRangeBatch(h.deps, inputFor(h, levelPlan()));
    assert.equal(result.kind, "submitted");
    assert.ok(result.kind === "submitted");
    assert.equal(result.actionKey, `dca:${AGENT_ID}:1:1`);
    const entry = await h.journal.getByDecision(AGENT_ID, result.actionKey);
    assert.equal(entry?.kind, "dcaRange");
    assert.equal(entry?.idempotencyKey, dcaIdempotencyKey(result.actionKey));
    assert.equal(entry?.externalRef.quoteSpendWei, (10n * E18).toString());
    assert.equal(h.provider.executeCalls.length, 1);
    assert.equal(h.provider.executeCalls[0]!.bypassLocalPolicyCheck, false);
    const action = await h.store.getAction(OWNER, result.actionKey);
    assert.equal(action?.state, "committed");
    const level = (await h.store.listOrders(AGENT_ID, 1)).find((row) => row.orderKey === "r1:l1");
    assert.equal(level?.state, "minting");
    assert.equal(level?.createdByAction, result.actionKey);
  });

  describe("R2.21 B1: every R2.7 denial happens before any write", () => {
    const cases: readonly { readonly name: string; readonly code: string; readonly harness?: HarnessInput;
      readonly plan: () => DcaBatchPlan; readonly patch?: (h: Awaited<ReturnType<typeof harness>>) => Partial<DcaExecuteInput> }[] = [
      { name: "a paused agent's USDT mint", code: "paused", harness: { paused: true }, plan: () => levelPlan() },
      { name: "settings changed under the cycle", code: "settings_changed", plan: () => levelPlan(), patch: () => ({ settings: dcaEffective({ slippageBps: 200 }) }) },
      { name: "the stop loss changed under the cycle", code: "settings_changed", plan: () => stopPlan(), patch: () => ({ settings: dcaEffective({ dcaStopLossBps: 1500 }) }) },
      { name: "a strategy batch while draining", code: "draining", harness: { draining: true }, plan: () => levelPlan() },
      { name: "a USDT mint inside the entry cutoff", code: "session_changed", harness: { remainingSec: 3_600 }, plan: () => levelPlan() },
      { name: "a level mint that is not dcaOrderWei", code: "DCA_ORDER_BOUNDS", plan: () => levelPlan(11n * E18) },
      { name: "a level mint past the round's cap", code: "DCA_BATCH_CAP", harness: { levelMinted: [10n * E18, 10n * E18, 10n * E18, 10n * E18] }, plan: () => levelPlan() },
      { name: "a TP larger than the round's stock", code: "DCA_TP_BOUNDS", plan: () => startPlan(directLeg(), 0n, E18) },
      { name: "a sell leg on a strategy batch", code: "DCA_SELL_NOT_ALLOWED",
        plan: () => ({ ...levelPlan(), kind: "close", swap: { side: "sell", amountInWei: E18, minOutWei: 1n, quotedOutWei: 1n, calls: [] } }) },
      { name: "a Remove carrying a swap", code: "DCA_BATCH_SHAPE", harness: { draining: true },
        plan: () => ({ ...ready(planDcaRemove({ pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE, orders: [LEVEL], slippageBps: 100 })),
          swap: { side: "sell", amountInWei: E18, minOutWei: 1n, quotedOutWei: 1n, calls: [] } }) },
      { name: "a sell leg on a strategy batch while draining (denied before the bounds check)", code: "draining", harness: { draining: true },
        plan: () => ({ ...levelPlan(), kind: "close", swap: { side: "sell", amountInWei: E18, minOutWei: 1n, quotedOutWei: 1n, calls: [] } }) },
      { name: "a sweep carrying a mint", code: "DCA_BATCH_SHAPE", plan: () => ({ ...levelPlan(), kind: "stop-loss" }) },
      { name: "the on-chain USDT meter short of spend plus one order", code: "QUOTE_DAILY_CAP", harness: { meter: 15n * E18 }, plan: () => levelPlan() },
      { name: "an unreadable on-chain meter (condition 12)", code: "quote-meter-unavailable", harness: { meter: null }, plan: () => levelPlan() },
      { name: "cash short of the batch", code: "entry_budget_changed", harness: { cash: 5n * E18 }, plan: () => levelPlan() },
      { name: "a buy that is not entryWei", code: "USDT_ENTRY_BOUNDS", plan: () => startPlan(directLeg({ amountInWei: 16n * E18 }), 160_000_000_000_000_000n) },
      // Operator ruling 2026-09-25: Auto DCA charges no fee, although this harness configures 100 bps.
      { name: "a buy carrying the configured 1 % fee", code: "FEE_MISMATCH", plan: () => startPlan(directLeg(), 150_000_000_000_000_000n) },
      { name: "a buy minOut under the slippage floor", code: "MIN_OUT_TOO_LOW", plan: () => startPlan(directLeg({ quotedOutWei: 100n * 10n ** 15n })) },
      { name: "a grant without a USDT day cap", code: "USDT_CAP_UNAVAILABLE", harness: { quoteDailyCapWei: null }, plan: () => levelPlan() },
      { name: "a plan without its relay quote", code: "cost-unavailable", plan: () => ({ ...levelPlan(), relayQuoteWei: undefined } as unknown as DcaBatchPlan) },
      { name: "a round that moved (dca_round_changed, never an abort)", code: "dca_round_changed", plan: () => levelPlan(),
        patch: (h) => ({ round: { ...h.round, rowVersion: h.round.rowVersion + 7 } }) },
    ];
    for (const entry of cases) {
      it(`${entry.name} ⇒ ${entry.code}, no action row, no round change, no journal row, no submit`, async () => {
        const h = await harness(entry.harness);
        const result = await executeDcaRangeBatch(h.deps, inputFor(h, entry.plan(), entry.patch?.(h) ?? {}));
        assert.deepEqual(result, { kind: "denied", code: entry.code });
        assert.deepEqual(await h.store.listActions(OWNER, AGENT_ID), []);
        assert.equal((await h.store.getOpenRound(OWNER, AGENT_ID))?.rowVersion, h.round.rowVersion);
        assert.deepEqual(await h.journal.listNonTerminal(), []);
        assert.equal(h.provider.executeCalls.length, 0);
        assert.equal((await h.store.listOrders(AGENT_ID, 1)).find((row) => row.orderKey === "r1:l1")?.state, "pending");
      });
    }

    it("H-1 (R2.4): a merged close + start counts its exits' USDT floors as cash, so a wallet below B + a·D still closes and starts", async () => {
      const h = await harness({ cash: 20n * E18 });
      const tp: DcaLiveOrder = { orderKey: "r1:tp", role: "tp", levelNo: null, tokenId: 11n, tickLower: 54_400, tickUpper: 54_450,
        liquidity: getLiquidityForAmounts(getSqrtRatioAtTick(NV_TICK), 54_400, 54_450, 67n * 10n ** 15n, 0n) };
      const plan = ready(planDcaCloseStart({ pool: NV, roundNo: 1, reading: { block: 100n, tick: 54_460, sqrtPriceX96: getSqrtRatioAtTick(54_460) },
        deadlineSec: DEADLINE, tp, liveLevels: [], swap: directLeg(), feeWei: 0n, carriedCostWei: 0n, residueStockWei: 0n,
        takeProfitBps: 150, tpOrderKey: "r2:tp:100", ladder: LADDER }));
      assert.ok(plan.quoteSpendWei > 20n * E18 && plan.exits[0]!.amount1Min + 20n * E18 >= plan.quoteSpendWei, "the wallet alone cannot fund the start; with the TP's USDT it can");
      assert.equal((await executeDcaRangeBatch(h.deps, inputFor(h, plan))).kind, "submitted");
    });

    it("E6 / E8: DCA_TP_BOUNDS at its exact value, and DCA_BATCH_SHAPE's exit and call caps", () => {
      const bounds = (plan: DcaBatchPlan, stockAcquiredWei: bigint, callCount: number) => dcaBatchBoundsRefusal({ plan, pool: NV, settings: dcaEffective(),
        round: { stockAcquiredWei }, roundOrders: [], callCount });
      // The TP holds minOut + the residue: admitted at exactly the round's stock + minOut, refused one wei over.
      assert.equal(bounds(startPlan(directLeg(), 0n, 67n * 10n ** 15n), 67n * 10n ** 15n, 12), null);
      assert.equal(bounds(startPlan(directLeg(), 0n, 67n * 10n ** 15n + 1n), 67n * 10n ** 15n, 12), "DCA_TP_BOUNDS");
      const stop = stopPlan();
      assert.equal(bounds({ ...stop, exits: Array(8).fill(stop.exits[0]!) }, 0n, 16), null);
      assert.equal(bounds({ ...stop, exits: Array(9).fill(stop.exits[0]!) }, 0n, 18), "DCA_BATCH_SHAPE");
      assert.equal(bounds(stop, 0n, MAX_CALLS_PER_EXECUTE), null);
      assert.equal(bounds(stop, 0n, MAX_CALLS_PER_EXECUTE + 1), "DCA_BATCH_SHAPE");
    });

    it("I15: dcaBatchBoundsRefusal refuses every sell, and a Remove refuses any swap — draining or not", () => {
      const boundsFor = (plan: DcaBatchPlan) => dcaBatchBoundsRefusal({ plan, pool: NV, settings: dcaEffective(), round: { stockAcquiredWei: 0n }, roundOrders: [], callCount: 4 });
      const removeBuy = { ...ready(planDcaRemove({ pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE, orders: [LEVEL], slippageBps: 100 })),
        swap: { side: "buy", amountInWei: E18, minOutWei: 1n, quotedOutWei: 1n, calls: [] } } as DcaBatchPlan;
      assert.equal(boundsFor(removeBuy), "DCA_BATCH_SHAPE", "a Remove with a buy");
      const removeSell = { ...removeBuy, swap: { ...removeBuy.swap!, side: "sell" as const } };
      assert.equal(boundsFor(removeSell), "DCA_BATCH_SHAPE", "a Remove with a sell");
      const closeSell = { ...levelPlan(), kind: "close" as const, swap: { side: "sell" as const, amountInWei: E18, minOutWei: 1n, quotedOutWei: 1n, calls: [] } };
      assert.equal(boundsFor(closeSell), "DCA_SELL_NOT_ALLOWED", "any other kind with a sell, unconditionally");
    });

    it("9. DCA_BATCH_CAP: at most `ahead` level mints per batch, and N·D per round", () => {
      const at = (range: readonly [number, number], levelNo: number) => ({ orderKey: `r1:l${levelNo}`, levelNo, range: { tickLower: range[0], tickUpper: range[1] } });
      const levels = [at([53_900, 53_950], 1), at([53_800, 53_850], 2), at([53_650, 53_700], 3)];
      const place = (count: number) => ready(planDcaLevelPlace({ pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE, levels: levels.slice(0, count), orderWei: 10n * E18 }));
      const bounds = (plan: DcaBatchPlan, maxOrders: number, minted: readonly bigint[] = []) => dcaBatchBoundsRefusal({ plan, pool: NV,
        settings: dcaEffective({ dcaMaxOrders: maxOrders, capitalQuoteWei: (15n * E18 + BigInt(maxOrders) * 10n * E18).toString() }), round: { stockAcquiredWei: 0n },
        roundOrders: minted.map((mintedUsdtWei) => ({ role: "level" as const, mintedUsdtWei })), callCount: 9 });
      assert.equal(bounds(place(2), 4), null, "N = 4: two level mints");
      assert.equal(bounds(place(3), 4), "DCA_BATCH_CAP", "N = 4: three refused");
      assert.equal(bounds(place(2), 3), "DCA_BATCH_CAP", "N = 3 (a = 1): two refused");
      assert.equal(bounds(place(1), 3), null);
      // A start whose round already holds N·D − D refuses its two level mints.
      assert.equal(bounds(startPlan(), 4, [10n * E18, 10n * E18, 10n * E18]), "DCA_BATCH_CAP");
      assert.equal(bounds(startPlan(), 4, [10n * E18, 10n * E18]), null);
    });

    it("C1 / C10 / C11: a close + start caps round k + 1, marks round k's TP and resting levels `exiting`, and writes k + 1's rows `minting` under r2 keys", async () => {
      for (const heldByRoundK of [4n, 2n]) { // N·D (C1), and (N − a)·D (C11)
        const h = await harness({ levelMinted: heldByRoundK === 4n ? [10n * E18, 10n * E18] : [] });
        const nvAt = (tickLower: number, usdt: bigint) => getLiquidityForAmounts(getSqrtRatioAtTick(NV_TICK), tickLower, tickLower + 50, 0n, usdt);
        const tp: DcaLiveOrder = { orderKey: "r1:tp", role: "tp", levelNo: null, tokenId: 11n, tickLower: 54_400, tickUpper: 54_450,
          liquidity: getLiquidityForAmounts(getSqrtRatioAtTick(NV_TICK), 54_400, 54_450, 67n * 10n ** 15n, 0n) };
        const l1: DcaLiveOrder = { orderKey: "r1:l1", role: "level", levelNo: 1, tokenId: 12n, tickLower: 53_900, tickUpper: 53_950, liquidity: nvAt(53_900, 10n * E18) };
        const l2: DcaLiveOrder = { orderKey: "r1:l2", role: "level", levelNo: 2, tokenId: 13n, tickLower: 53_800, tickUpper: 53_850, liquidity: nvAt(53_800, 10n * E18) };
        const row = (await h.store.listOrders(AGENT_ID, 1)).find((order) => order.orderKey === "r1:l1")!;
        for (const order of [tp, l1, l2]) {
          await h.store.putOrder({ ...row, orderKey: order.orderKey, role: order.role, levelNo: order.levelNo, tokenId: order.tokenId, tickLower: order.tickLower,
            tickUpper: order.tickUpper, state: "live", liquidity: order.liquidity, mintedUsdtWei: order.role === "level" ? 10n * E18 : 0n,
            mintedStockWei: order.role === "tp" ? 67n * 10n ** 15n : 0n });
        }
        const held = (await h.store.listOrders(AGENT_ID, 1)).filter((order) => order.role === "level").reduce((sum, order) => sum + order.mintedUsdtWei, 0n);
        assert.equal(held, heldByRoundK * 10n * E18);
        const plan = ready(planDcaCloseStart({ pool: NV, roundNo: 1, reading: { block: 100n, tick: 54_460, sqrtPriceX96: getSqrtRatioAtTick(54_460) },
          deadlineSec: DEADLINE, tp, liveLevels: [l1, l2], swap: directLeg(), feeWei: 0n, carriedCostWei: 0n, residueStockWei: 0n,
          takeProfitBps: 150, tpOrderKey: "r2:tp:100", ladder: LADDER }));
        const result = await executeDcaRangeBatch(h.deps, inputFor(h, plan));
        assert.equal(result.kind, "submitted", `round k holds ${heldByRoundK}·D: admitted, since the cap counts round k + 1`);
        const roundK = await h.store.listOrders(AGENT_ID, 1);
        assert.deepEqual(["r1:tp", "r1:l1", "r1:l2"].map((key) => roundK.find((order) => order.orderKey === key)?.state), ["exiting", "exiting", "exiting"]);
        const roundNext = await h.store.listOrders(AGENT_ID, 2);
        assert.deepEqual(roundNext.map((order) => [order.orderKey, order.state]).sort(), [["r2:l1", "minting"], ["r2:l2", "minting"], ["r2:tp:100", "minting"]]);
      }
    });

    it("after dca_round_changed the same fence claims normally at the current version", async () => {
      const h = await harness();
      assert.equal((await executeDcaRangeBatch(h.deps, inputFor(h, levelPlan(), { round: { ...h.round, rowVersion: 99 } }))).kind, "denied");
      assert.equal((await executeDcaRangeBatch(h.deps, inputFor(h, levelPlan()))).kind, "submitted");
    });
  });

  describe("R2.9 / H1: the two-sweep reserve", () => {
    const required = QUOTE + 10n ** 14n + 2n * R_DCA;
    it("a non-sweep batch must leave 2 × R_DCA after its own quote and fee; one wei short rolls back with no submit", async () => {
      const short = await harness();
      short.provider.nativeDayMeterResult = { kind: "day", limitWei: required - 1n, currentSpentWei: 0n, grantedTokenCount: 1 };
      const refused = await executeDcaRangeBatch(short.deps, inputFor(short, levelPlan()));
      assert.equal(refused.kind, "rolled-back");
      assert.ok(refused.kind === "rolled-back");
      assert.equal(refused.code, "NATIVE_RESERVE");
      assert.equal(short.provider.executeCalls.length, 0);
      assert.equal((await short.store.getAction(OWNER, refused.actionKey))?.state, "rolled-back");
      assert.equal((await short.journal.getByDecision(AGENT_ID, refused.actionKey))?.state, "ROLLED_BACK");
      assert.equal((await short.store.listOrders(AGENT_ID, 1)).find((row) => row.orderKey === "r1:l1")?.state, "pending", "the rollback undoes its marks");
      const exact = await harness();
      exact.provider.nativeDayMeterResult = { kind: "day", limitWei: required, currentSpentWei: 0n, grantedTokenCount: 1 };
      assert.equal((await executeDcaRangeBatch(exact.deps, inputFor(exact, levelPlan()))).kind, "submitted");
    });

    it("a sweep may spend the reserve down to its own quote, and no further", async () => {
      const at = await harness();
      at.provider.nativeDayMeterResult = { kind: "day", limitWei: QUOTE, currentSpentWei: 0n, grantedTokenCount: 1 };
      assert.equal((await executeDcaRangeBatch(at.deps, inputFor(at, stopPlan()))).kind, "submitted");
      const below = await harness();
      below.provider.nativeDayMeterResult = { kind: "day", limitWei: QUOTE - 1n, currentSpentWei: 0n, grantedTokenCount: 1 };
      const refused = await executeDcaRangeBatch(below.deps, inputFor(below, stopPlan()));
      assert.ok(refused.kind === "rolled-back");
      assert.equal(refused.code, "dca-native-cap-exhausted");
      assert.equal(below.provider.executeCalls.length, 0);
    });
  });

  it("a paused agent's sweep still runs (it reduces exposure)", async () => {
    const h = await harness({ paused: true });
    assert.equal((await executeDcaRangeBatch(h.deps, inputFor(h, stopPlan()))).kind, "submitted");
  });

  it("a preflight refusal rolls back: journal ROLLED_BACK, action rolled-back, marks undone, nothing submitted", async () => {
    const h = await harness();
    h.provider.preflightError = new Error("refused by the local snapshot");
    const result = await executeDcaRangeBatch(h.deps, inputFor(h, levelPlan()));
    assert.ok(result.kind === "rolled-back");
    assert.equal((await h.journal.getByDecision(AGENT_ID, result.actionKey))?.state, "ROLLED_BACK");
    assert.equal((await h.store.getAction(OWNER, result.actionKey))?.state, "rolled-back");
    assert.equal(h.provider.executeCalls.length, 0);
  });

  it("a submit throw is UNKNOWN, outside the in-flight slot: a sweep still claims past it (R2.7, B2)", async () => {
    const h = await harness();
    h.provider.nextError = new Error("relay went silent");
    const result = await executeDcaRangeBatch(h.deps, inputFor(h, levelPlan()));
    assert.ok(result.kind === "unknown");
    assert.equal((await h.journal.getByDecision(AGENT_ID, result.actionKey))?.state, "UNKNOWN");
    assert.equal((await h.store.getAction(OWNER, result.actionKey))?.state, "unknown");
    h.provider.nextError = null;
    const round = (await h.store.getOpenRound(OWNER, AGENT_ID))!;
    assert.equal((await executeDcaRangeBatch(h.deps, inputFor(h, stopPlan(), { round }))).kind, "submitted");
  });

  it("a relay PENDING (the 300 answer) leaves the action submitted, in flight", async () => {
    const h = await harness();
    h.provider.nextReceipt = { status: "PENDING", callsId: `0x${"c1".repeat(32)}` };
    const result = await executeDcaRangeBatch(h.deps, inputFor(h, levelPlan()));
    assert.ok(result.kind === "submitted");
    assert.equal((await h.store.getAction(OWNER, result.actionKey))?.state, "submitted");
    assert.equal((await h.journal.getByDecision(AGENT_ID, result.actionKey))?.state, "IN_PROGRESS");
  });

  it("re-checks the clamped guard deadline before submit: GUARD_QUOTE_EXPIRED spends no fee", async () => {
    const h = await harness();
    const deadline = NOW_SEC + 5n;
    const calldata = "0xad43f73d00" as Hex;
    const leg: DcaSwapLeg = { side: "buy", amountInWei: 15n * E18, minOutWei: MIN_OUT, quotedOutWei: 66_600_000_000_000_000n,
      calls: [...buildTradfiApprove(USDT_56, GUARD, 15n * E18), buildTradfiGuardSwapCall({ guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56,
        spender: TRADFI_BINANCE_FLASH_SPENDER_56, canonicalUSDT: USDT_56, tokenIn: USDT_56, tokenOut: NV.stock, amountInWei: 15n * E18,
        minOutWei: MIN_OUT, deadline, calldata })], guard: { address: GUARD, calldata, deadlineSec: deadline } };
    const result = await executeDcaRangeBatch(h.deps, inputFor(h, startPlan(leg)));
    assert.ok(result.kind === "rolled-back");
    assert.equal(result.code, "GUARD_QUOTE_EXPIRED");
    assert.equal(h.provider.executeCalls.length, 0);
  });

  it("a journal row already under the fresh key (a claim lost after an earlier attempt journaled) never submits; the key advances", async () => {
    const h = await harness();
    await h.journal.beginWithSpend({ idempotencyKey: dcaIdempotencyKey(`dca:${AGENT_ID}:1:1`), agentId: AGENT_ID, ownerAddress: OWNER, kind: "dcaRange",
      decisionId: `dca:${AGENT_ID}:1:1`, externalRef: {}, nativeSpendWei: 0n }, 0);
    const conflicted = await executeDcaRangeBatch(h.deps, inputFor(h, levelPlan()));
    assert.ok(conflicted.kind === "rolled-back");
    assert.equal(conflicted.code, "dca_key_conflict");
    assert.equal(h.provider.executeCalls.length, 0);
    const round = (await h.store.getOpenRound(OWNER, AGENT_ID))!;
    const next = await executeDcaRangeBatch(h.deps, inputFor(h, levelPlan(), { round }));
    assert.ok(next.kind === "submitted");
    assert.equal(next.actionKey, `dca:${AGENT_ID}:1:2`);
  });

  it("the journal-window half of QUOTE_DAILY_CAP is taken atomically with the reservation and rolls back with no fee", async () => {
    const h = await harness({ meter: 1_000n * E18, cash: 1_000n * E18 });
    await h.journal.beginWithSpend({ idempotencyKey: keccak256(stringToBytes("earlier")), agentId: AGENT_ID, ownerAddress: OWNER, kind: "trade",
      nativeSpendWei: 0n, quoteSpendWei: 270n * E18, externalRef: { quoteSpendWei: (270n * E18).toString() } }, 0);
    await h.journal.markCommitted(keccak256(stringToBytes("earlier")), {});
    const result = await executeDcaRangeBatch(h.deps, inputFor(h, levelPlan()));
    assert.ok(result.kind === "rolled-back");
    assert.equal(result.code, "QUOTE_DAILY_CAP");
    assert.equal(h.provider.executeCalls.length, 0);
  });
});

describe("tradfiV2SwapRefusal (the extraction, REVIEW2 condition 4)", () => {
  const E = E18;
  function scheduleSettings(): TradeSettings {
    return { ...DEFAULT_TRADE_SETTINGS, name: "Schedule Agent", executionModel: "tradfi", entryWei: (15n * E).toString(), maxOpenPositions: 1,
      takeProfitBps: null, stopLossBps: null, maxHoldSec: null, slippageBps: 300, crashProtection: false,
      settlementAsset: "USDT", minEntryWei: (15n * E).toString(), capitalQuoteWei: (1_000n * E).toString(), cmcNewsEnabled: false,
      tradeMode: "schedule", scheduleToken: NV.stock.toLowerCase(), scheduleIntervalSec: 3_600, scheduleFirstAtSec: null,
      scheduleEndKind: "budget", scheduleEndAtSec: null, scheduleEndRuns: null, scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150 } as TradeSettings;
  }
  function aiSettings(): TradeSettings {
    return { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT", minEntryWei: (15n * E).toString(),
      entryWei: (15n * E).toString(), capitalQuoteWei: (60n * E).toString(), cmcNewsEnabled: false } as TradeSettings;
  }
  async function executor(settings: TradeSettings) {
    const { agents, agent } = await dcaAgent({ nowMs: NOW });
    const settingsStore = new MemoryTradeSettingsStore(agents, () => NOW);
    await settingsStore.put({ agentId: agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
    const provider = new FakeWalletProvider();
    // Room for the own fee plus ONE exit, while the chain says five tokens are grantable.
    provider.nativeDayMeterResult = { kind: "day", limitWei: 2n * 10n ** 14n, currentSpentWei: 0n, grantedTokenCount: 5 };
    const trade = tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, feeBps: 100, feeTreasury: TREASURY });
    const request = { decisionId: "d-1", venue: "pancake" as const, side: "buy" as const, token: NV.stock, amountWei: 15n * E,
      quotedOutWei: 15n * E, minOutWei: 15n * E * 99n / 100n, settlementAsset: "USDT" as const, platformFeeAtomic: 15n * E / 100n };
    const result = await executeTradeForAgent({ agent, request, idempotencyKey: `0x${"12".repeat(32)}`, paramsHash: `0x${"34".repeat(32)}`,
      scanGate: { evaluate: async () => ({ verdict: "allow", reasons: [] }) },
      deps: { chainId: 56, keyStore: GUARD, agentStore: agents, settingsStore, journal: new MemoryExecutionJournal(() => NOW),
        killswitch: new MemoryKillSwitch(() => NOW), providerRegistry: { get: () => provider }, trade,
        pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, pancakeV3: null, uniswapV3: null, flapPortal: null, nowMs: () => NOW } });
    const bounds = await tradfiV2SwapRefusal({ settingsStore, trade }, agent, agent.sessionFacts!, request);
    return { result, bounds, provider };
  }

  it("Schedule still reserves grantedTokenCount: 1 — the same meter an AI agent is refused on", async () => {
    const schedule = await executor(scheduleSettings());
    assert.deepEqual(schedule.bounds, { ok: true, scheduleAgent: true, v2QuoteCap: 275n * E });
    assert.equal(schedule.provider.executeCalls.length, 1, schedule.result.kind);
    const ai = await executor(aiSettings());
    assert.deepEqual(ai.bounds, { ok: true, scheduleAgent: false, v2QuoteCap: 275n * E });
    assert.equal(ai.provider.executeCalls.length, 0);
    assert.ok(ai.result.kind === "rolled-back" && ai.result.code === "NATIVE_RESERVE", ai.result.kind);
  });
});

describe("I12: the range executor is worker-only", () => {
  const source = readFileSync(new URL("../src/trade/dcaExecute.ts", import.meta.url), "utf8");
  it("submits with the literal bypassLocalPolicyCheck: false, and nothing else names the flag", () => {
    assert.equal(source.match(/bypassLocalPolicyCheck/gu)?.length, 1);
    assert.match(source, /executeViaSession\(\{ session, calls, bypassLocalPolicyCheck: false \}\)/u);
  });

  it("no module under src/ imports it except the trade worker (no route can reach it)", () => {
    const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts") && /from "\.{1,2}\/(?:trade\/)?dcaExecute\.js"/u.test(readFileSync(full, "utf8"))) importers.push(full.replace(/\\/gu, "/"));
      }
    };
    walk(root);
    assert.deepEqual(importers.map((file) => file.slice(file.indexOf("/src/") + 1)), ["src/trade/worker.ts"]);
  });
});
