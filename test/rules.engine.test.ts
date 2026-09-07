/**
 * The off-chain rule engine. Pure arithmetic, so the tests are about EDGES:
 * exactly at a cap, one wei past it, and the fee's effect on both.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateTradeRules, exceedsDailyCap } from "../src/rules/engine.js";
import type { AgentCaps } from "../src/store/agents.js";

const BASE = {
  amountWei: 100n,
  nativeInWei: 100n,
  minOutWei: 950n,
  quotedOutWei: 1_000n,
  caps: null,
  spentTodayWei: 0n,
  maxSlippageBps: 500,
} as const;

describe("evaluateTradeRules: amounts", () => {
  it("refuses a zero amount", () => {
    assert.deepEqual(evaluateTradeRules({ ...BASE, amountWei: 0n }), {
      allowed: false,
      code: "AMOUNT_INVALID",
    });
  });

  it("refuses a zero quote", () => {
    assert.deepEqual(evaluateTradeRules({ ...BASE, quotedOutWei: 0n }), {
      allowed: false,
      code: "AMOUNT_INVALID",
    });
  });

  it("refuses a trade with no slippage floor at all", () => {
    assert.deepEqual(evaluateTradeRules({ ...BASE, minOutWei: 0n }), {
      allowed: false,
      code: "MIN_OUT_REQUIRED",
    });
  });

  it("allows a sell, whose native input is zero by construction", () => {
    // AMOUNT_INVALID must read the REQUEST amount, not the native spend, or
    // every sell would be refused as a trade of nothing.
    assert.deepEqual(
      evaluateTradeRules({ ...BASE, amountWei: 5_000n, nativeInWei: 0n }),
      { allowed: true },
    );
  });
});

describe("evaluateTradeRules: slippage discipline", () => {
  it("denies minOutWei = 1 against a realistic quote", () => {
    // The OQ3 case: a floor that exists only to satisfy the wire check.
    assert.deepEqual(
      evaluateTradeRules({ ...BASE, minOutWei: 1n, quotedOutWei: 10n ** 18n }),
      { allowed: false, code: "MIN_OUT_TOO_LOW" },
    );
  });

  it("passes exactly at the tolerance and fails one wei below it", () => {
    // 5% of 1_000 leaves 950 as the lowest acceptable floor.
    assert.deepEqual(
      evaluateTradeRules({ ...BASE, minOutWei: 950n, quotedOutWei: 1_000n }),
      { allowed: true },
    );
    assert.deepEqual(
      evaluateTradeRules({ ...BASE, minOutWei: 949n, quotedOutWei: 1_000n }),
      { allowed: false, code: "MIN_OUT_TOO_LOW" },
    );
  });

  it("accepts a floor ABOVE the quote — that is the caller's business", () => {
    assert.deepEqual(
      evaluateTradeRules({ ...BASE, minOutWei: 5_000n, quotedOutWei: 1_000n }),
      { allowed: true },
    );
  });

  it("honours a tighter configured tolerance", () => {
    assert.deepEqual(
      evaluateTradeRules({
        ...BASE,
        minOutWei: 950n,
        quotedOutWei: 1_000n,
        maxSlippageBps: 100,
      }),
      { allowed: false, code: "MIN_OUT_TOO_LOW" },
    );
  });
});

describe("evaluateTradeRules: caps", () => {
  const perTrade: AgentCaps = { perTradeNativeWei: 1_000n };
  const daily: AgentCaps = { dailyNativeWei: 1_000n };

  it("passes exactly at the per-trade cap and fails one wei past it", () => {
    assert.deepEqual(
      evaluateTradeRules({ ...BASE, caps: perTrade, nativeInWei: 1_000n }),
      { allowed: true },
    );
    assert.deepEqual(
      evaluateTradeRules({ ...BASE, caps: perTrade, nativeInWei: 1_001n }),
      { allowed: false, code: "PER_TRADE_CAP" },
    );
  });

  it("passes exactly at the daily cap and fails one wei past it", () => {
    assert.deepEqual(
      evaluateTradeRules({
        ...BASE,
        caps: daily,
        nativeInWei: 400n,
        spentTodayWei: 600n,
      }),
      { allowed: true },
    );
    assert.deepEqual(
      evaluateTradeRules({
        ...BASE,
        caps: daily,
        nativeInWei: 401n,
        spentTodayWei: 600n,
      }),
      { allowed: false, code: "DAILY_CAP" },
    );
  });

  it("counts the fee toward the per-trade cap", () => {
    // A 100-bps fee on 1_000 is 10; the cap sees 1_010, not 1_000.
    const amountWei = 1_000n;
    const feeWei = (amountWei * 100n) / 10_000n;
    assert.deepEqual(
      evaluateTradeRules({
        ...BASE,
        caps: { perTradeNativeWei: amountWei + feeWei },
        amountWei,
        nativeInWei: amountWei + feeWei,
      }),
      { allowed: true },
    );
    assert.deepEqual(
      evaluateTradeRules({
        ...BASE,
        caps: { perTradeNativeWei: amountWei },
        amountWei,
        nativeInWei: amountWei + feeWei,
      }),
      { allowed: false, code: "PER_TRADE_CAP" },
      "a trade sized exactly to the cap must REFUSE when a fee is configured",
    );
  });

  it("skips the cap checks entirely when none are configured", () => {
    assert.deepEqual(
      evaluateTradeRules({ ...BASE, caps: null, nativeInWei: 10n ** 30n }),
      { allowed: true },
    );
  });

  it("checks caps independently of each other", () => {
    assert.deepEqual(
      evaluateTradeRules({
        ...BASE,
        caps: { perTradeNativeWei: 10n ** 30n },
        nativeInWei: 10n ** 20n,
        spentTodayWei: 10n ** 30n,
      }),
      { allowed: true },
      "a per-trade cap with no daily cap must not imply one",
    );
  });
});

describe("exceedsDailyCap", () => {
  it("is false with no daily cap, whatever the numbers", () => {
    assert.equal(exceedsDailyCap(null, 10n ** 30n, 10n ** 30n), false);
    assert.equal(exceedsDailyCap({ perTradeNativeWei: 1n }, 10n ** 30n, 1n), false);
  });

  it("matches the engine's boundary exactly", () => {
    const caps: AgentCaps = { dailyNativeWei: 1_000n };
    assert.equal(exceedsDailyCap(caps, 600n, 400n), false);
    assert.equal(exceedsDailyCap(caps, 600n, 401n), true);
  });
});
