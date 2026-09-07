/** Phase 3.10 Revision 2 R4/R5/R7/R8 — pure ranked-pool adapter/selection. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import {
  LP_RANKING_MAX_FUTURE_SKEW_MS,
  classifyLpRankingTimestamp,
  decimalNumberToScaledBigInt,
  parsePoolsTopEnvelope,
  selectLpPool,
  type LpPoolRowDropReason,
  type LpRankedPool,
} from "../src/lp/selectPool.js";

const NOW = 2_000_000;
const POOL_A = getAddress("0x00000000000000000000000000000000000000a1");
const POOL_B = getAddress("0x00000000000000000000000000000000000000b2");
const POOL_C = getAddress("0x00000000000000000000000000000000000000c3");
const POOL_D = getAddress("0x00000000000000000000000000000000000000d4");
const POOL_E = getAddress("0x00000000000000000000000000000000000000e5");
const T0 = getAddress("0x1000000000000000000000000000000000000001");
const T1 = getAddress("0x2000000000000000000000000000000000000002");

function wireRow(pool: Address = POOL_A): Record<string, unknown> {
  return {
    pool,
    protocol: "v3",
    token0: T0,
    token1: T1,
    fee: 2500,
    tvlUsd: 10_000_000.123456,
    volume24hUsd: 1_000_000.654321,
    lpFeeApr24h: 10.83,
    aprSources: ["lpFee"],
    asOf: NOW,
    source: "pancake",
  };
}

function envelope(rows: readonly unknown[], meta: Record<string, unknown> = {}): unknown {
  return {
    data: rows,
    meta: {
      total: rows.length,
      matched: rows.length,
      returned: rows.length,
      cap: 500,
      ingestOrder: "tvlUSD",
      orderBy: "lpFeeApr24h",
      aprField: "lpFeeApr24h",
      asOf: NOW,
      source: "pancake",
      ...meta,
    },
  };
}

function normalizedPool(
  overrides: Partial<LpRankedPool> & { pool: Address },
): LpRankedPool {
  return {
    token0: T0,
    token1: T1,
    fee: 2500,
    aprBps: 1_000n,
    tvlUsdE6: 10_000_000_000000n,
    volume24hUsdE6: 1_000_000_000000n,
    rowAsOfMs: NOW,
    aprSource: "pancake-apr24h",
    ...overrides,
  };
}

describe("decimalNumberToScaledBigInt", () => {
  it("converts APR percentage and USD through canonical decimal strings", () => {
    assert.equal(decimalNumberToScaledBigInt(10.83, 2), 1_083n);
    assert.equal(decimalNumberToScaledBigInt(0, 2), 0n);
    assert.equal(decimalNumberToScaledBigInt(12.3456789, 6), 12_345_679n);
  });

  it("rounds half up and handles canonical exponent notation", () => {
    assert.equal(decimalNumberToScaledBigInt(1.005, 2), 101n);
    assert.equal(decimalNumberToScaledBigInt(1.004, 2), 100n);
    assert.equal(decimalNumberToScaledBigInt(1e-7, 8), 10n);
    assert.equal(decimalNumberToScaledBigInt(5e-7, 6), 1n);
  });

  it("accepts 78 result digits and refuses larger or hostile shapes without throwing", () => {
    assert.equal(decimalNumberToScaledBigInt(1e77, 0), 10n ** 77n);
    for (const value of [1e78, Number.MAX_VALUE, -1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      assert.doesNotThrow(() => decimalNumberToScaledBigInt(value, 0));
      assert.equal(decimalNumberToScaledBigInt(value, 0), null);
    }
  });
});

describe("parsePoolsTopEnvelope", () => {
  it("normalizes a live-shaped envelope and retains validated coverage/provenance", () => {
    const parsed = parsePoolsTopEnvelope(envelope([wireRow()]), NOW);
    assert.notEqual(parsed, null);
    assert.deepEqual(
      parsed === null
        ? null
        : {
            laneAsOfMs: parsed.laneAsOfMs,
            source: parsed.source,
            total: parsed.total,
            matched: parsed.matched,
            returned: parsed.returned,
            cap: parsed.cap,
            ingestOrder: parsed.ingestOrder,
          },
      {
        laneAsOfMs: NOW,
        source: "pancake",
        total: 1,
        matched: 1,
        returned: 1,
        cap: 500,
        ingestOrder: "tvlUSD",
      },
    );
    assert.deepEqual(parsed?.pools[0], {
      pool: POOL_A,
      token0: T0,
      token1: T1,
      fee: 2500,
      aprBps: 1_083n,
      tvlUsdE6: 10_000_000_123456n,
      volume24hUsdE6: 1_000_000_654321n,
      rowAsOfMs: NOW,
      aprSource: "pancake-apr24h",
    });
  });

  it("refuses malformed envelopes, incomplete coverage, and a future lane", () => {
    const row = wireRow();
    for (const bad of [
      null,
      [],
      { data: [row] },
      { data: [row], meta: null },
      envelope([row], { source: "other" }),
      envelope([row], { asOf: 1.5 }),
      envelope([row], { matched: 2 }),
      envelope([row], { returned: 0 }),
      envelope([row], { returned: 501, matched: 501 }),
      envelope([row], { asOf: NOW + LP_RANKING_MAX_FUTURE_SKEW_MS + 1 }),
    ]) {
      assert.equal(parsePoolsTopEnvelope(bad, NOW), null);
    }
  });

  it("drops each malformed row beside a valid row and counts the exact field reason", () => {
    const cases: ReadonlyArray<{
      reason: LpPoolRowDropReason;
      bad: unknown;
    }> = [
      { reason: "not-object", bad: null },
      { reason: "protocol", bad: { ...wireRow(POOL_B), protocol: "v2" } },
      { reason: "source", bad: { ...wireRow(POOL_B), source: "other" } },
      { reason: "apr-sources", bad: { ...wireRow(POOL_B), aprSources: [] } },
      { reason: "pool-address", bad: { ...wireRow(POOL_B), pool: "bad" } },
      { reason: "token0-address", bad: { ...wireRow(POOL_B), token0: "bad" } },
      { reason: "token1-address", bad: { ...wireRow(POOL_B), token1: "bad" } },
      {
        reason: "token-order",
        bad: { ...wireRow(POOL_B), token0: T1, token1: T0 },
      },
      { reason: "fee", bad: { ...wireRow(POOL_B), fee: 3000 } },
      { reason: "tvl-usd", bad: { ...wireRow(POOL_B), tvlUsd: null } },
      {
        reason: "volume24h-usd",
        bad: { ...wireRow(POOL_B), volume24hUsd: -1 },
      },
      {
        reason: "lp-fee-apr24h",
        bad: { ...wireRow(POOL_B), lpFeeApr24h: null },
      },
      { reason: "row-as-of", bad: { ...wireRow(POOL_B), asOf: 1.5 } },
      {
        reason: "row-future",
        bad: {
          ...wireRow(POOL_B),
          asOf: NOW + LP_RANKING_MAX_FUTURE_SKEW_MS + 1,
        },
      },
    ];

    for (const testCase of cases) {
      const parsed = parsePoolsTopEnvelope(envelope([wireRow(), testCase.bad]), NOW);
      assert.notEqual(parsed, null, testCase.reason);
      assert.deepEqual(parsed?.pools.map((row) => row.pool), [POOL_A], testCase.reason);
      assert.equal(parsed?.rowDropCounts[testCase.reason], 1, testCase.reason);
    }
  });

  it("covers all null/non-finite/nonpositive numeric row defects", () => {
    const cases: ReadonlyArray<[LpPoolRowDropReason, Record<string, unknown>]> = [
      ["tvl-usd", { tvlUsd: 0 }],
      ["tvl-usd", { tvlUsd: Number.POSITIVE_INFINITY }],
      ["volume24h-usd", { volume24hUsd: null }],
      ["volume24h-usd", { volume24hUsd: Number.NaN }],
      ["lp-fee-apr24h", { lpFeeApr24h: -0.01 }],
      ["lp-fee-apr24h", { lpFeeApr24h: Number.POSITIVE_INFINITY }],
    ];
    for (const [reason, override] of cases) {
      const parsed = parsePoolsTopEnvelope(
        envelope([wireRow(), { ...wireRow(POOL_B), ...override }]),
        NOW,
      );
      assert.deepEqual(parsed?.pools.map((row) => row.pool), [POOL_A]);
      assert.equal(parsed?.rowDropCounts[reason], 1);
    }
  });

  it("retains zero volume/APR and keeps the first valid duplicate", () => {
    const first = { ...wireRow(), volume24hUsd: 0, lpFeeApr24h: 0 };
    const duplicate = { ...wireRow(), lpFeeApr24h: 999 };
    const parsed = parsePoolsTopEnvelope(envelope([first, duplicate]), NOW);
    assert.notEqual(parsed, null);
    assert.equal(parsed?.pools.length, 1);
    assert.equal(parsed?.pools[0]?.aprBps, 0n);
    assert.equal(parsed?.pools[0]?.volume24hUsdE6, 0n);
    assert.equal(parsed?.rowDropCounts["duplicate-pool"], 1);
  });

  it("keeps optional lane metadata only when internally valid", () => {
    const parsed = parsePoolsTopEnvelope(
      envelope([wireRow()], { total: 0, cap: 0, ingestOrder: "unknown" }),
      NOW,
    );
    assert.notEqual(parsed, null);
    assert.equal(parsed?.total, null);
    assert.equal(parsed?.cap, null);
    assert.equal(parsed?.ingestOrder, null);
  });
});

describe("classifyLpRankingTimestamp", () => {
  it("distinguishes fresh, stale, and hostile-future observations", () => {
    assert.equal(classifyLpRankingTimestamp(NOW, NOW, 60_000), "fresh");
    assert.equal(classifyLpRankingTimestamp(NOW - 60_001, NOW, 60_000), "stale");
    assert.equal(
      classifyLpRankingTimestamp(NOW + LP_RANKING_MAX_FUTURE_SKEW_MS, NOW, 60_000),
      "fresh",
    );
    assert.equal(
      classifyLpRankingTimestamp(NOW + LP_RANKING_MAX_FUTURE_SKEW_MS + 1, NOW, 60_000),
      "future",
    );
  });
});

describe("selectLpPool", () => {
  const gatesPassed = new Set([
    POOL_A.toLowerCase(),
    POOL_B.toLowerCase(),
    POOL_C.toLowerCase(),
    POOL_D.toLowerCase(),
    POOL_E.toLowerCase(),
  ]);

  it("orders carried APR, TVL, volume, then address as a total deterministic order", () => {
    const a = normalizedPool({ pool: POOL_A, aprBps: 900n });
    const b = normalizedPool({ pool: POOL_B, aprBps: 1_100n, tvlUsdE6: 5n });
    const c = normalizedPool({
      pool: POOL_C,
      aprBps: 1_100n,
      tvlUsdE6: 10n,
      volume24hUsdE6: 1n,
    });
    const d = normalizedPool({
      pool: POOL_D,
      aprBps: 1_100n,
      tvlUsdE6: 10n,
      volume24hUsdE6: 2n,
    });
    const input = { pools: [a, b, c, d], minAprBps: 0, rankBy: "fee-apr" as const, gatesPassed };
    const first = selectLpPool(input);
    const second = selectLpPool(input);
    assert.ok(first.ok);
    assert.ok(second.ok);
    assert.deepEqual(
      first.survivors.map((entry) => entry.pool.pool),
      [POOL_D, POOL_C, POOL_B, POOL_A],
    );
    assert.deepEqual(second, first);
  });

  it("uses address ascending when every numeric rank input ties", () => {
    const result = selectLpPool({
      pools: [normalizedPool({ pool: POOL_C }), normalizedPool({ pool: POOL_B })],
      minAprBps: 0,
      rankBy: "fee-apr",
      gatesPassed,
    });
    assert.ok(result.ok);
    assert.equal(result.head.pool.pool, POOL_B);
  });

  it("honors admission gates and the owner floor against carried APR", () => {
    const oldGrossWouldClear = normalizedPool({
      pool: POOL_A,
      fee: 10_000,
      aprBps: 900n,
      tvlUsdE6: 1_000_000n,
      volume24hUsdE6: 100_000_000_000n,
    });
    const belowFloor = selectLpPool({
      pools: [oldGrossWouldClear],
      minAprBps: 901,
      rankBy: "fee-apr",
      gatesPassed,
    });
    assert.ok(!belowFloor.ok);
    assert.equal(belowFloor.code, "NO_SURVIVORS");

    const gatedOut = selectLpPool({
      pools: [normalizedPool({ pool: POOL_B, aprBps: 1_000_000n })],
      minAprBps: 0,
      rankBy: "fee-apr",
      gatesPassed: new Set<string>(),
    });
    assert.ok(!gatedOut.ok);
    assert.equal(gatedOut.code, "NO_SURVIVORS");
  });

  it("retains zero APR at a zero floor and refuses an empty normalized set", () => {
    const zero = selectLpPool({
      pools: [normalizedPool({ pool: POOL_A, aprBps: 0n })],
      minAprBps: 0,
      rankBy: "fee-apr",
      gatesPassed,
    });
    assert.ok(zero.ok);
    assert.equal(zero.head.aprBps, 0n);

    const empty = selectLpPool({ pools: [], minAprBps: 0, rankBy: "fee-apr", gatesPassed });
    assert.ok(!empty.ok);
    assert.equal(empty.code, "NO_SURVIVORS");
  });

  it("volume mode orders volume, APR, TVL, then address", () => {
    const result = selectLpPool({
      pools: [
        normalizedPool({ pool: POOL_A, volume24hUsdE6: 50n, aprBps: 9_000n }),
        normalizedPool({ pool: POOL_B, volume24hUsdE6: 100n, aprBps: 900n, tvlUsdE6: 1n }),
        normalizedPool({ pool: POOL_C, volume24hUsdE6: 100n, aprBps: 1_000n, tvlUsdE6: 1n }),
        normalizedPool({ pool: POOL_D, volume24hUsdE6: 100n, aprBps: 1_000n, tvlUsdE6: 2n }),
        normalizedPool({ pool: POOL_E, volume24hUsdE6: 100n, aprBps: 1_000n, tvlUsdE6: 1n }),
      ],
      minAprBps: 0,
      rankBy: "volume",
      gatesPassed,
    });
    assert.ok(result.ok);
    assert.deepEqual(
      result.survivors.map((entry) => entry.pool.pool),
      [POOL_D, POOL_C, POOL_E, POOL_B, POOL_A],
    );
  });

  it("volume mode still applies the APR floor before ranking", () => {
    const result = selectLpPool({
      pools: [
        normalizedPool({ pool: POOL_A, volume24hUsdE6: 10_000n, aprBps: 999n }),
        normalizedPool({ pool: POOL_B, volume24hUsdE6: 1n, aprBps: 1_000n }),
      ],
      minAprBps: 1_000,
      rankBy: "volume",
      gatesPassed,
    });
    assert.ok(result.ok);
    assert.deepEqual(result.survivors.map((entry) => entry.pool.pool), [POOL_B]);
  });
});
