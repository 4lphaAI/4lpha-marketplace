import assert from "node:assert/strict";
import { it } from "node:test";
import { decodeAbiParameters, decodeFunctionData, parseAbi, type Hex } from "viem";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { MemoryDcaRoundStore, type DcaOrderRow } from "../src/store/dcaRounds.js";
import { MemoryTradeSimulationStore } from "../src/store/tradeSimulations.js";
import { buildTradfiPancakeV3Swap } from "../src/ops/tradfi.js";
import { PANCAKE_V3_ROUTER_56 } from "../src/ops/venues.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { planDcaClose, planDcaCloseStart, planDcaFill, planDcaLevelPlace, planDcaRemove, planDcaStart, planDcaStopLoss, planDcaTpPlace, type DcaBatchPlan, type DcaLiveOrder, type DcaSwapLeg } from "../src/trade/dca.js";
import { executeDcaRangeBatch, type DcaExecuteDeps, type DcaExecuteInput } from "../src/trade/dcaExecute.js";
import { createTradfiEvidenceWriter, GUARD_DEADLINE_REASONS } from "../src/trade/simulate.js";
import { buildTradfiApprove } from "../src/ops/tradfi.js";
import { buildTradfiGuardSwapCall, TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { FakeWalletProvider, tradeConfig } from "./support/serverHarness.js";
import { E18, GUARD, NV, NV_TICK, OWNER, TREASURY, WALLET, dcaAgent, dcaEffective, dcaSettings } from "./support/dcaFixtures.js";
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

it("D1/D1b/S8/R5 guard starts proceed and direct reverts block", async () => {
  for (const guard of [false, true]) for (const raw of ["execution reverted", "execution reverted: Too little received", "insufficient funds for gas", null, ...GUARD_DEADLINE_REASONS]) {
    const h = await harness(), store = new MemoryTradeSimulationStore(), evidence = createTradfiEvidenceWriter(store, () => {});
    const deadline = NOW_SEC + 14n;
    const swap = guard ? directLeg({ calls: [...buildTradfiApprove(USDT_56, GUARD, 15n * E18), buildTradfiGuardSwapCall({ guard: GUARD,
      router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, canonicalUSDT: USDT_56,
      tokenIn: USDT_56, tokenOut: NV.stock, amountInWei: 15n * E18, minOutWei: MIN_OUT, deadline, calldata: "0xad43f73d" })],
      guard: { address: GUARD, deadlineSec: deadline, calldata: "0xad43f73d" } }) : directLeg();
    const answer = await executeDcaRangeBatch({ ...h.deps, preflight: { evidence, simulate: async () => ({ status: "FAILED", failReason: raw, balanceChanges: [], otherChangeCount: 0, upstreamMs: 1 }) } }, inputFor(h, startPlan(swap)));
    const blocked = !guard && raw !== null && raw.startsWith("execution reverted");
    assert.equal(answer.kind, blocked ? "rolled-back" : "submitted");
    if (answer.kind === "rolled-back") assert.equal(answer.code, "SIMULATION_FAILED");
    await evidence.shutdown();
    const row = [...store.simulations.values()][0]!;
    assert.equal(row.route, guard ? "guard" : "direct"); assert.equal(row.blocked, blocked);
    assert.equal(row.bareRevert, raw === "execution reverted"); assert.equal(h.provider.executeCalls.length, blocked ? 0 : 1);
  }
});
it("D2/R2.10/R3.7 whole-list identity for production reducing, start, close-start and fill batches", async () => {
  const base = { pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE };
  const tp: DcaLiveOrder = { ...LEVEL, role: "tp", orderKey: "r1:tp", levelNo: null, tokenId: 7n, tickLower: 55_000, tickUpper: 55_050 };
  const fillReading = { ...READING, tick: 53_880, sqrtPriceX96: getSqrtRatioAtTick(53_880) };
  const deadline = NOW_SEC + 14n;
  const guardLeg = directLeg({ calls: [...buildTradfiApprove(USDT_56, GUARD, 15n * E18), buildTradfiGuardSwapCall({ guard: GUARD,
    router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, canonicalUSDT: USDT_56, tokenIn: USDT_56,
    tokenOut: NV.stock, amountInWei: 15n * E18, minOutWei: MIN_OUT, deadline, calldata: "0xad43f73d" })], guard: { address: GUARD, deadlineSec: deadline, calldata: "0xad43f73d" } });
  const plans = [stopPlan(), ready(planDcaRemove({ ...base, orders: [LEVEL], slippageBps: 100 })),
    ready(planDcaClose({ ...base, tp, liveLevels: [LEVEL] })),
    ready(planDcaTpPlace({ ...base, ledger: { costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n }, walletRoundStockWei: 67n * 10n ** 15n, takeProfitBps: 150, tpOrderKey: "new-tp" })),
    startPlan(), ready(planDcaCloseStart({ ...base, tp, liveLevels: [LEVEL], swap: guardLeg, feeWei: 0n, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "r2:tp", ladder: LADDER })),
    ...[false, true].map(levels => ready(planDcaFill({ ...base, reading: fillReading, filled: [{ ...LEVEL, mintedUsdtWei: 10n * E18 }], oldTp: null,
      ledger: { costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n }, walletRoundStockWei: 10n ** 15n,
      takeProfitBps: 150, tpOrderKey: "fill-tp", orderWei: 10n * E18,
      nextLevels: levels ? [{ orderKey: "next", levelNo: 2, range: { tickLower: 53_700, tickUpper: 53_750 } }] : [] })))];
  for (const plan of plans) {
    const h = await harness(); let simulated: Hex = "0x";
    const verdict = await executeDcaRangeBatch({ ...h.deps, preflight: { evidence: { insert: () => {} }, simulate: async tx => {
      simulated = tx.data; return { status: "SUCCESS", failReason: null, balanceChanges: [], otherChangeCount: 0, upstreamMs: 0 };
    } } }, inputFor(h, plan));
    assert.equal(verdict.kind, "submitted", plan.kind);
    const decoded = decodeFunctionData({ abi: parseAbi(["function execute(bytes32,bytes)"]), data: simulated });
    const [calls] = decodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], decoded.args[1]);
    assert.deepEqual(calls.map(call => ({ to: call.target.toLowerCase(), value: call.value, data: call.data })), h.provider.executeCalls[0]!.calls.map(call => ({ to: call.to.toLowerCase(), value: call.value ?? 0n, data: call.data ?? "0x" })), plan.kind);
  }
  for (const plan of plans.slice(0, 4)) {
    const h = await harness();
    const verdict = await executeDcaRangeBatch({ ...h.deps, preflight: { evidence: { insert: () => {} }, simulate: async () => ({ status: "FAILED", failReason: "execution reverted: x", balanceChanges: [], otherChangeCount: 0, upstreamMs: 0 }) } }, inputFor(h, plan));
    assert.equal(verdict.kind, "submitted", plan.kind);
  }
  assert.ok(levelPlan().mints.length > 0);
  const h = await harness(), store = new MemoryTradeSimulationStore(), evidence = createTradfiEvidenceWriter(store, () => {});
  const blocked = await executeDcaRangeBatch({ ...h.deps, preflight: { evidence, simulate: async () => ({ status: "FAILED", failReason: "execution reverted", balanceChanges: [], otherChangeCount: 0, upstreamMs: 0 }) } }, inputFor(h, levelPlan()));
  assert.equal(blocked.kind, "rolled-back"); if (blocked.kind === "rolled-back") assert.equal(blocked.code, "SIMULATION_FAILED");
  await evidence.shutdown(); assert.equal([...store.simulations.values()][0]?.route, "none");
  assert.equal([...store.simulations.values()][0]?.blocked, true); assert.equal(h.provider.executeCalls.length, 0);
});

