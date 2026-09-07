/**
 * DEMO MODE — the trading engine.
 *
 * The claims worth pinning are the ones a flattering simulation would get
 * wrong: exits run before entries, at most ONE buy lands per cycle, an
 * unreadable quote HOLDS rather than exiting or marking stale, and the exit
 * precedence is the live `decideExit` rather than a friendlier copy of it.
 *
 * OFFLINE, pure: no store, no chain, no clock, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";

import {
  demoTradeEquity,
  demoTradeStep,
  type DemoTradeSettings,
  type DemoTradeState,
} from "../src/demo/tradeEngine.js";

const TOKEN_A = getAddress("0x000000000000000000000000000000000000000a");
const TOKEN_B = getAddress("0x000000000000000000000000000000000000000b");
const ONE = 10n ** 18n;

function settings(patch: Partial<DemoTradeSettings> = {}): DemoTradeSettings {
  return {
    buySizeQuoteWei: ONE / 10n,
    maxOpenPositions: 2,
    stopLossBps: 1_000,
    takeProfitBps: 2_000,
    maxHoldSec: null,
    ...patch,
  };
}

function empty(cash = ONE): DemoTradeState {
  return { cashQuoteWei: cash, positions: [], realisedQuoteWei: 0n, costQuoteWei: 0n, trades: 0 };
}

function holding(token: Address, entryQuoteWei: bigint, openedAtMs = 0): DemoTradeState {
  return {
    cashQuoteWei: 0n,
    positions: [{ token, symbol: "AAA", baseWei: 1_000n, entryQuoteWei, openedAtMs }],
    realisedQuoteWei: 0n,
    costQuoteWei: 0n,
    trades: 0,
  };
}

const NO_BRAIN = [] as const;

describe("demo trade engine — entries", () => {
  it("opens at most ONE position per cycle, even with many candidates", () => {
    const out = demoTradeStep({
      state: empty(),
      settings: settings(),
      nowMs: 1_000,
      marks: [],
      candidates: [
        { token: TOKEN_A, symbol: "AAA", baseOutWei: 500n },
        { token: TOKEN_B, symbol: "BBB", baseOutWei: 700n },
      ],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 0n,
      exitRequested: [],
    });
    assert.equal(out.fills.length, 1);
    assert.equal(out.fills[0]?.side, "buy");
    assert.equal(out.fills[0]?.reason, "entry");
    assert.equal(out.state.positions.length, 1);
    assert.equal(out.state.cashQuoteWei, ONE - ONE / 10n);
  });

  it("refuses to open past maxOpenPositions, and with too little cash", () => {
    const full: DemoTradeState = {
      ...empty(ONE),
      positions: [
        { token: TOKEN_A, symbol: "AAA", baseWei: 1n, entryQuoteWei: ONE, openedAtMs: 0 },
      ],
    };
    const capped = demoTradeStep({
      state: full,
      settings: settings({ maxOpenPositions: 1 }),
      nowMs: 1_000,
      marks: [],
      candidates: [{ token: TOKEN_B, symbol: "BBB", baseOutWei: 5n }],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 0n,
      exitRequested: [],
    });
    assert.deepEqual(capped.fills, []);

    const broke = demoTradeStep({
      state: empty(1n),
      settings: settings(),
      nowMs: 1_000,
      marks: [],
      candidates: [{ token: TOKEN_B, symbol: "BBB", baseOutWei: 5n }],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 0n,
      exitRequested: [],
    });
    assert.deepEqual(broke.fills, []);
  });

  it("never opens a second position in a token it already holds", () => {
    const out = demoTradeStep({
      state: { ...empty(ONE), positions: holding(TOKEN_A, ONE / 10n).positions },
      settings: settings(),
      nowMs: 1_000,
      marks: [],
      candidates: [{ token: TOKEN_A, symbol: "AAA", baseOutWei: 5n }],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 0n,
      exitRequested: [],
    });
    assert.deepEqual(out.fills, []);
  });
});

describe("demo trade engine — exits use the LIVE precedence", () => {
  it("fires the stop loss and records a negative realised result", () => {
    const out = demoTradeStep({
      state: holding(TOKEN_A, ONE),
      settings: settings({ stopLossBps: 1_000 }),
      nowMs: 5_000,
      marks: [{ token: TOKEN_A, quoteOutWei: (ONE * 85n) / 100n }],
      candidates: [],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 0n,
      exitRequested: [],
    });
    assert.equal(out.fills.length, 1);
    assert.equal(out.fills[0]?.side, "sell");
    assert.equal(out.fills[0]?.reason, "stop-loss");
    assert.equal(out.fills[0]?.pnlBps, -1_500n);
    assert.equal(out.state.positions.length, 0);
    assert.equal(out.state.realisedQuoteWei, (ONE * 85n) / 100n - ONE);
  });

  it("fires the take profit", () => {
    const out = demoTradeStep({
      state: holding(TOKEN_A, ONE),
      settings: settings({ takeProfitBps: 2_000 }),
      nowMs: 5_000,
      marks: [{ token: TOKEN_A, quoteOutWei: (ONE * 130n) / 100n }],
      candidates: [],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 0n,
      exitRequested: [],
    });
    assert.equal(out.fills[0]?.reason, "take-profit");
    assert.equal(out.state.realisedQuoteWei, (ONE * 30n) / 100n);
  });

  it("an owner request outranks every automatic rule", () => {
    const out = demoTradeStep({
      state: holding(TOKEN_A, ONE),
      settings: settings(),
      nowMs: 5_000,
      // A price that would trip NEITHER stop nor target on its own.
      marks: [{ token: TOKEN_A, quoteOutWei: ONE }],
      candidates: [],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 0n,
      exitRequested: [TOKEN_A],
    });
    assert.equal(out.fills[0]?.reason, "owner-request");
  });

  it("HOLDS a position whose quote is unreadable — never exits, never marks stale", () => {
    const out = demoTradeStep({
      state: holding(TOKEN_A, ONE),
      settings: settings(),
      nowMs: 5_000,
      marks: [],
      candidates: [],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 0n,
      exitRequested: [TOKEN_A],
    });
    assert.deepEqual(out.fills, []);
    assert.equal(out.state.positions.length, 1);
  });

  it("the brain can only act where the owner left a threshold blank", () => {
    const withThresholds = demoTradeStep({
      state: holding(TOKEN_A, ONE),
      settings: settings({ stopLossBps: 1_000, takeProfitBps: 2_000 }),
      nowMs: 5_000,
      marks: [{ token: TOKEN_A, quoteOutWei: ONE }],
      candidates: [],
      brain: [{ token: TOKEN_A, exit: true, reason: "vibes" }],
      relayFeePerSubmitWei: 0n,
      exitRequested: [],
    });
    // Both thresholds set: the live precedence ignores the brain entirely.
    assert.deepEqual(withThresholds.fills, []);

    const blank = demoTradeStep({
      state: holding(TOKEN_A, ONE),
      settings: settings({ takeProfitBps: null }),
      nowMs: 5_000,
      marks: [{ token: TOKEN_A, quoteOutWei: ONE }],
      candidates: [],
      brain: [{ token: TOKEN_A, exit: true, reason: "vibes" }],
      relayFeePerSubmitWei: 0n,
      exitRequested: [],
    });
    assert.equal(blank.fills[0]?.reason, "llm");
  });
});

describe("demo trade engine — ordering and costs", () => {
  it("runs exits BEFORE entries, so a sale funds the same cycle's buy", () => {
    const out = demoTradeStep({
      // No cash at all: the buy is only affordable out of the sale's proceeds.
      state: holding(TOKEN_A, ONE),
      settings: settings({ buySizeQuoteWei: ONE / 2n, maxOpenPositions: 1 }),
      nowMs: 5_000,
      marks: [{ token: TOKEN_A, quoteOutWei: (ONE * 130n) / 100n }],
      candidates: [{ token: TOKEN_B, symbol: "BBB", baseOutWei: 42n }],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 0n,
      exitRequested: [],
    });
    assert.equal(out.fills.length, 2);
    assert.equal(out.fills[0]?.side, "sell");
    assert.equal(out.fills[1]?.side, "buy");
    assert.equal(out.state.positions[0]?.token, TOKEN_B);
  });

  it("charges gas per leg as a line item, leaving realised PnL gross", () => {
    const out = demoTradeStep({
      state: holding(TOKEN_A, ONE),
      settings: settings({ takeProfitBps: 2_000, buySizeQuoteWei: 0n }),
      nowMs: 5_000,
      marks: [{ token: TOKEN_A, quoteOutWei: (ONE * 130n) / 100n }],
      candidates: [],
      brain: NO_BRAIN,
      relayFeePerSubmitWei: 7n,
      exitRequested: [],
    });
    assert.equal(out.state.costQuoteWei, 7n);
    assert.equal(out.state.realisedQuoteWei, (ONE * 30n) / 100n);
  });
});

describe("demo trade engine — equity", () => {
  it("is absent, not stale, when any position is unmarked", () => {
    const state = holding(TOKEN_A, ONE);
    assert.deepEqual(demoTradeEquity(state, []), {
      equityQuoteWei: null,
      unmarked: [TOKEN_A],
    });
    assert.deepEqual(demoTradeEquity(state, [{ token: TOKEN_A, quoteOutWei: 5n }]), {
      equityQuoteWei: 5n,
      unmarked: [],
    });
  });
});
