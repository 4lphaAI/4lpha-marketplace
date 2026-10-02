// Existing offline fixture, extracted for independent final-audit assertions.
import { MemoryTradeSettingsStore } from "../../src/store/tradeSettings.js";
import { MemoryExecutionJournal } from "../../src/store/journal.js";
import { MemoryKillSwitch } from "../../src/killswitch/killswitch.js";
import { MemoryDcaRoundStore, type DcaOrderRow } from "../../src/store/dcaRounds.js";
import { buildTradfiPancakeV3Swap } from "../../src/ops/tradfi.js";
import { PANCAKE_V3_ROUTER_56 } from "../../src/ops/venues.js";
import { NFPM_56 } from "../../src/ops/nfpm.js";
import { getSqrtRatioAtTick } from "../../src/lp/tickMath.js";
import { USDT_56 } from "../../src/trade/settlement.js";
import { tradeSettingsDigest, type TradeSettings } from "../../src/trade/settings.js";
import { planDcaStart, type DcaBatchPlan, type DcaLiveOrder, type DcaSwapLeg } from "../../src/trade/dca.js";
import type { DcaExecuteDeps, DcaExecuteInput } from "../../src/trade/dcaExecute.js";
import { FakeWalletProvider, tradeConfig } from "./serverHarness.js";
import { E18, NV, NV_TICK, OWNER, TREASURY, WALLET, dcaAgent, dcaEffective, dcaSettings } from "./dcaFixtures.js";
export const NOW = Date.UTC(2026, 8, 25, 12);
const NOW_SEC = BigInt(Math.floor(NOW / 1_000));
export const READING = { block: 100n, tick: NV_TICK, sqrtPriceX96: getSqrtRatioAtTick(NV_TICK) };
export const DEADLINE = NOW_SEC + 300n;
const QUOTE = 10n ** 13n;
const MIN_OUT = 66_000_000_000_000_000n;
export const LEVEL: DcaLiveOrder = { orderKey: "r1:l1", role: "level", levelNo: 1, tokenId: 6n, tickLower: 53_900, tickUpper: 53_950, liquidity: 2_000_000_000_000_000n };

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

export async function harness(input: HarnessInput = {}) {
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

export function ready(plan: DcaBatchPlan): DcaBatchPlan {
  return { ...plan, preSubmit: { walletUsdtWei: 100n * E18, walletStockWei: 0n }, relayQuoteWei: QUOTE };
}

export function directLeg(patch: Partial<DcaSwapLeg> = {}): DcaSwapLeg {
  const amountInWei = patch.amountInWei ?? 15n * E18;
  const calls = buildTradfiPancakeV3Swap({ router: PANCAKE_V3_ROUTER_56, tokenIn: USDT_56, tokenOut: NV.stock, amountInWei,
    minOutWei: MIN_OUT, recipient: WALLET, deadline: DEADLINE, route: { hops: [], fees: [2500] } });
  return { side: "buy", amountInWei, minOutWei: MIN_OUT, quotedOutWei: 66_600_000_000_000_000n, calls, ...patch };
}

export const LADDER = { stepBps: 100, maxOrders: 4, orderWei: 10n * E18, rangeMinE8: null };

export function startPlan(swap: DcaSwapLeg = directLeg(), feeWei = 0n, residueStockWei = 0n): DcaBatchPlan {
  return ready(planDcaStart({ pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE, swap, feeWei,
    carriedCostWei: 0n, residueStockWei, takeProfitBps: 150, tpOrderKey: "r1:tp:100", ladder: LADDER }));
}

export function inputFor(h: Awaited<ReturnType<typeof harness>>, plan: DcaBatchPlan, patch: Partial<DcaExecuteInput> = {}): DcaExecuteInput {
  return { agent: h.agent, pool: NV, round: h.round, plan, sweep: plan.kind === "stop-loss" || plan.kind === "remove",
    settings: dcaEffective(), ...patch };
}
