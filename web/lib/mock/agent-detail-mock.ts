"use client";
/**
 * DEMO-RECORDING FIXTURE - not product code, not a data source.
 *
 * A grid agent detail view with a full trading history, so the marketplace page
 * can be filmed without waiting for a live grid to fill. It is reachable ONLY
 * from `?mock=1` on `/account/<id>` (see `use-mock-agent-detail.ts`), it feeds
 * the SAME `AgentDetailView` the real mapper produces - every price string is
 * computed with the app's own `priceAtTick`, never typed by hand - and it
 * touches no wallet, no session, no owner action and no execution-plane route.
 * Nothing here can submit anything: it is a value, not a code path.
 */
import { priceAtTick, type ReviewedPair } from "@/lib/exec/pairs";
import type { AgentDetailView, ChartCandle, DetailMetric, DetailMotion, DetailPosition, DetailSequence, OhlcvResult } from "@/lib/exec/agent-detail";

const MUBARAK = "0x5c85d6c6825ab4032337f11ee92a72df936b46f6";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const POOL = "0x9f4c2a1de52c9dfb0f9d0e6f2e5d1b7a3c8e4d20";
const WALLET = "0x27146E20c2fb2521c7DD73e97bE030C3147c9da6";
const NFPM = "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364";

const PAIR: ReviewedPair = {
  chainId: 56,
  token0: MUBARAK,
  token1: WBNB,
  symbol0: "mubarak",
  symbol1: "WBNB",
  decimals0: 18,
  decimals1: 18,
  wbnbIsToken0: false,
};

/** WBNB in USD. The pool feed prices the BASE in USD, so the chart uses this. */
const QUOTE_USD = 730;
const TICK_SPACING = 50;
/** The signed "Wide Band" geometry: rungs one gap out, one width wide. */
const GAP_TICKS = 100;
const WIDTH_TICKS = 50;
const START_TICK = -100_825;
const MINUTES = 240;
/** Five minutes of relay + confirmation before a re-quoted rung is armed again. */
const REQUOTE_COOLDOWN_MIN = 5;

/** Frozen once per page load so re-renders do not slide the chart under itself. */
const NOW = Date.now();
const MINUTE = 60_000;

function metric(value: string | null, extra: Partial<DetailMetric> = {}): DetailMetric {
  return { value, reason: value === null ? "no source" : null, ...extra };
}

function priceOf(tick: number): string {
  return priceAtTick(tick, PAIR);
}

/** Tick math is integer-only; the walk is continuous, so it rounds here. */
function usdAt(tick: number): number {
  return Number(priceOf(Math.round(tick))) * QUOTE_USD;
}

const TX_HASHES: readonly string[] = [
  "0x2cfd18b41c0a7e63d9b2ff5a4e7c1d80a5b3e9f27c6d40e1a8b93f5c2d716202",
  "0x6886c4d21f7b93e05a8d47c6b1e02f9a3d5c8b7e46f10a29c3d85be7f42a8d05",
  "0x4c71e93b0d5a26f8c14b7e09a3d62f85b0c9e7d41a835f26c0b91d7e4a02a014",
  "0xe4390b7d21c85fa6039e14b7d2c5a80f63b9e1d47a02c85f13d6b09e7c2f80b1",
  "0x5b27e94c06a1d83f52b7e40c9d16a85f3b207e4c19d6a08b3f5c7e2d9014255c",
  "0x48f21c0d97b3e56a8f10c4d29b7e35a06c8d1f94b27e50a3c6d8b19f7e0255c3",
  "0x93b7e05c28a41d6f09b3e7c15a82d40f6b9c3e71d05a28f4c6b0d93e17a5c8f2",
  "0x0c58e3b91d47a026f8c5b3e10d92a74f6c8b0e5d31a97f24c6b8d0e5a39f712c",
  "0x7f2a4c8e13b95d60a2f8c4b7e0d13a96f5c2b8e40d7a19c3f6b5d8e02a4c917b",
  "0xb1d4f70a92c3e58b06d1a47f2c9b3e850d7a16c4f92b0e35a8d1c76b4e023f9a",
  "0x38c5a1e07b94d26f0a3c8b51d7e94a26f0b83c5d19e746a2c0f8b3d5e17a94c6",
  "0xa07e3b19c5d84f26b0a3e75c1d92f480a6c3b8e51d074f9a2c68b0d3e5714f8b",
];

type Fill = {
  readonly side: "buy" | "sell";
  readonly minutesAgo: number;
  /** The rung edge the price traded THROUGH, so its price is the fill price. */
  readonly tick: number;
  readonly tx: string;
};

type Rung = { readonly tickLower: number; readonly tickUpper: number };

/**
 * The recorded history, simulated rather than posed.
 *
 * A seeded tick-space walk with momentum runs the same machinery the live grid
 * does: when the price trades through the ask, that rung fills and BOTH rungs
 * are re-quoted around the new price (shift mode), and the same on the bid.
 * Nothing is placed by hand, so the fills land at uneven intervals and at
 * different prices - the giveaway of the earlier version was that they did not.
 * Seed 3277 was chosen for what it produced: ten fills over four hours, five
 * each way, and a price that ends where it started - the case the grid
 * exists for; a run of buys with nothing sold back would earn nothing.
 */
function simulate(seed: number) {
  let state = seed >>> 0;
  const uniform = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 0x1_0000_0000; };
  const normal = () => {
    const u = Math.max(1e-9, uniform());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
  const quantize = (tick: number) => Math.round(tick / TICK_SPACING) * TICK_SPACING;
  const rungsAround = (tick: number): { readonly buy: Rung; readonly sell: Rung } => {
    const centre = quantize(tick);
    return {
      buy: { tickLower: centre - GAP_TICKS - WIDTH_TICKS, tickUpper: centre - GAP_TICKS },
      sell: { tickLower: centre + GAP_TICKS, tickUpper: centre + GAP_TICKS + WIDTH_TICKS },
    };
  };

  let tick = START_TICK;
  let momentum = 0;
  let rungs = rungsAround(tick);
  let cooldown = 0;
  const path: number[] = [];
  const fills: Fill[] = [];

  for (let minute = 0; minute < MINUTES; minute += 1) {
    momentum = momentum * 0.9 + normal() * 1.4;
    tick += normal() * 30 + momentum;
    path.push(tick);
    if (cooldown > 0) { cooldown -= 1; continue; }
    const filled = tick >= rungs.sell.tickUpper ? "sell" as const : tick <= rungs.buy.tickLower ? "buy" as const : null;
    if (filled === null) continue;
    fills.push({
      side: filled,
      minutesAgo: MINUTES - 1 - minute,
      tick: filled === "sell" ? rungs.sell.tickUpper : rungs.buy.tickLower,
      tx: TX_HASHES[fills.length % TX_HASHES.length] ?? TX_HASHES[0]!,
    });
    rungs = rungsAround(tick);
    cooldown = REQUOTE_COOLDOWN_MIN;
  }
  // Newest first, the order the fill feed reads in.
  return { path, fills: [...fills].reverse(), rungs, tick: Math.round(tick) };
}

const SIM = simulate(3_277);
const OBSERVED_TICK = SIM.tick;
const BUY_RANGE = SIM.rungs.buy;
const SELL_RANGE = SIM.rungs.sell;
const FILLS = SIM.fills;

/**
 * The walk, drawn as one-minute candles in the feed's own unit (USD).
 *
 * Wick and volume jitter comes from its OWN generator: drawing it from the
 * walk's would move every fill the moment a cosmetic detail changed.
 */
function candles(): readonly ChartCandle[] {
  const fillMinutes = new Set(FILLS.map((fill) => fill.minutesAgo));
  let state = 0x9e37_79b9;
  const jitterAt = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 0x1_0000_0000; };
  return SIM.path.map((closeTick, i) => {
    const minutesAgo = MINUTES - 1 - i;
    const close = usdAt(closeTick);
    const open = i === 0 ? close : usdAt(SIM.path[i - 1] ?? closeTick);
    const jitter = jitterAt();
    // A wick on the side the candle is already moving, plus a small one back.
    const body = Math.abs(close - open);
    const wick = body * (0.25 + jitter * 1.4) + close * 0.0006 * jitter;
    return {
      timestamp: NOW - minutesAgo * MINUTE,
      open,
      close,
      high: Math.max(open, close) + wick * (close >= open ? 1 : 0.55),
      low: Math.min(open, close) - wick * (close >= open ? 0.55 : 1),
      // Volume clusters where the price moved, and spikes on a fill minute.
      volume: 900 + body / (close * 0.0001) * 260 + jitter * 2_200 + (fillMinutes.has(minutesAgo) ? 5_800 : 0),
    };
  });
}

function motions(): readonly DetailMotion[] {
  return FILLS.map((fill, index): DetailMotion => {
    const atMs = NOW - fill.minutesAgo * MINUTE;
    return {
      sequenceId: `grid-flip-${index}`,
      classification: "settlement",
      label: fill.side === "buy" ? "Buy rung filled" : "Sell rung filled",
      collected: fill.side === "buy" ? "0.010897 WBNB" : "0.00761 WBNB",
      price: metric(`${priceOf(fill.tick)} WBNB`),
      time: fill.minutesAgo < 60 ? `${fill.minutesAgo}m ago` : `${Math.round(fill.minutesAgo / 60)}h ago`,
      timeTitle: new Date(atMs).toISOString(),
      txHash: fill.tx,
    };
  });
}

function sequences(): readonly DetailSequence[] {
  return FILLS.slice(0, 6).map((fill, index): DetailSequence => ({
    sequenceId: `grid-flip-${index}`,
    positionId: fill.side === "buy" ? "pos-bid" : "pos-ask",
    kind: "grid-flip",
    state: "completed",
    recoveryState: "none",
    note: null,
    outcomeUnavailable: false,
    txHashes: [fill.tx],
    steps: [
      { index: 0, kind: "zap-out", decisionId: `dec-${index}-0`, state: "COMMITTED", txHash: fill.tx },
      { index: 1, kind: "zap-in-mint", decisionId: `dec-${index}-1`, state: "COMMITTED", txHash: fill.tx },
    ],
    stallCode: null,
    stallCount: 0,
    updatedAt: NOW - fill.minutesAgo * MINUTE,
    createdAt: NOW - (fill.minutesAgo + 2) * MINUTE,
    shiftCause: null,
    targetBuyRange: null,
    targetSellRange: null,
  }));
}

function rung(range: { readonly tickLower: number; readonly tickUpper: number }, side: "bid" | "ask") {
  return {
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    priceLow: priceOf(range.tickLower),
    priceHigh: priceOf(range.tickUpper),
    fillPrice: side === "ask" ? priceOf(range.tickUpper) : priceOf(range.tickLower),
  };
}

function positions(): readonly DetailPosition[] {
  const shared = {
    pair: "mubarak / WBNB",
    state: "live",
    age: "2h ago",
    ageTitle: new Date(NOW - 128 * MINUTE).toISOString(),
    fees: metric(null),
    token0: MUBARAK,
    token1: WBNB,
    fee: 2_500,
    updatedAt: NOW - 3 * MINUTE,
  };
  return [
    {
      ...shared,
      positionId: "pos-ask",
      tokenId: "7325419",
      role: "sell",
      value: metric("0.00761 WBNB"),
      unrealised: metric("+0.00042 WBNB"),
      nftUrl: `https://bscscan.com/nft/${NFPM}/7325419`,
      rung: rung(SELL_RANGE, "ask"),
      sideLabel: "ASK mubarak",
    },
    {
      ...shared,
      positionId: "pos-bid",
      tokenId: "7325420",
      role: "buy",
      value: metric("0.010897 WBNB"),
      unrealised: metric("+0.00028 WBNB"),
      nftUrl: `https://bscscan.com/nft/${NFPM}/7325420`,
      rung: rung(BUY_RANGE, "bid"),
      sideLabel: "BID WBNB",
    },
  ];
}

export function mockAgentDetailView(agentId: string): AgentDetailView {
  return {
    id: agentId,
    status: "armed",
    httpRuntimeProfile: "lp-v1",
    hireSizingName: "grid-v1",
    walletAddress: WALLET,
    sessionPublicKey: "0x04224619950bb006d2ae7e0daa3ce3d1b94ed01a1a05797aaa04b68981bedf80d859e5420c03242d261582c0d5e1d67d7ee5381d31987b290f4e637f6951f31857",
    provisioning: false,
    actionDisabledReason: null,
    armMs: NOW - 4 * 60 * MINUTE,
    dailyNativeLimit: metric("0.0654 BNB", { usd: "$47.72", bnb: "0.0654 BNB", rawWei: "65400000000000000" }),
    recordedCycleDelta: metric("+0.00256 WBNB"),
    grossPnl: metric("+$1.87", { usd: "+$1.87", bnb: "+0.00256 BNB" }),
    grossPnlPercent: metric("+3.92%"),
    recordedCycles: metric("5"),
    levels: [
      { positionId: "pos-ask", role: "sell", recordedCycles: 3, roundTrips: 3, deltaWei: "1490000000000000", delta: metric("+0.00149 WBNB") },
      { positionId: "pos-bid", role: "buy", recordedCycles: 2, roundTrips: 2, deltaWei: "1070000000000000", delta: metric("+0.00107 WBNB") },
    ],
    cycleHistoryAvailable: true,
    cycleNote: "Derived telemetry: counts are a lower bound.",
    gas: {
      nativeWei: "9400000000000000",
      nextMotionWei: "155200000000000",
      warnWei: "465600000000000",
      blockWei: "77600000000000",
      state: "ok",
      enforcement: "block",
      low: false,
    },
    motions: motions(),
    sequences: sequences(),
    positions: positions(),
    lp: null,
    grid: {
      pool: POOL,
      pair: "mubarak / WBNB",
      base: "mubarak",
      quote: "WBNB",
      symbol0: "mubarak",
      symbol1: "WBNB",
      decimals0: 18,
      decimals1: 18,
      token0: MUBARAK,
      token1: WBNB,
      fee: 2_500,
      wbnbIsToken0: false,
      observedPrice: priceOf(OBSERVED_TICK),
      quoteUsd: QUOTE_USD,
      baseAddress: MUBARAK,
      quoteAddress: WBNB,
      buyPrices: { low: priceOf(BUY_RANGE.tickLower), high: priceOf(BUY_RANGE.tickUpper) },
      sellPrices: { low: priceOf(SELL_RANGE.tickLower), high: priceOf(SELL_RANGE.tickUpper) },
      tickSpacing: TICK_SPACING,
      mode: "shift",
      // "Wide Band" as the preset table reproduces it at this spacing.
      gapTicks: 100,
      widthTicks: 50,
      driftPctOfGap: 0,
      buyRange: BUY_RANGE,
      sellRange: SELL_RANGE,
      observedTick: OBSERVED_TICK,
      observationAgeMs: 12_000,
      observationStale: false,
      tickSource: "live",
      rangeUnavailableBecause: null,
      liveRows: 2,
    },
  };
}

export function mockMarket(): OhlcvResult {
  const rows = candles();
  return {
    candles: rows,
    stale: false,
    banner: null,
    priceNow: rows.at(-1)?.close ?? null,
    hodl: metric("-0.32%"),
  };
}

export const MOCK_AS_OF_MS = NOW;
