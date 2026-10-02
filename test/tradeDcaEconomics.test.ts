/**
 * Auto DCA economics (AUTO-DCA-SPEC R2.15, R2.9, R3.5, R3.6; REVIEW2 conditions
 * 7 and 14; REVIEW3 C8).
 *
 * Every R3.5 / R3.6 figure reproduced from the stated inputs: 0.05 gwei,
 * $769.40 per BNB, the gas model, and the 2.45× / 3.38× relay multiples. The
 * hold predicate engages above the listed gas prices and not below them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DCA_GAS_EXIT,
  DCA_GAS_GUARD_BUY,
  DCA_GAS_OVERHEAD,
  DCA_POOLS_56,
  dcaAhead,
  dcaBilledNativeWei,
  dcaGrossRateE18,
  dcaPerFillGas,
  dcaR0Gas,
  dcaUneconomic,
  type DcaPool,
} from "../src/trade/dca.js";
import { checkTradfiDcaSizing, dcaNativeReserveWei, R_DCA } from "../src/trade/sizing.js";
import { nativeCostToUsdtAtomic } from "../src/trade/cost.js";

const E18 = 10n ** 18n;
const GAS_PRICE = 50_000_000n; // 0.05 gwei
const FACTS = { nativePriceUsd: 769.40, settlementPriceUsd: 1, observedAt: 0 };

function pool(symbol: string): DcaPool {
  const found = DCA_POOLS_56.find((entry) => entry.symbol === symbol);
  assert.ok(found, symbol);
  return found;
}

/** USD of `gas` physical gas at `gasPriceWei` and the relay multiple `rho`. */
function usd(gas: bigint, rho: number, gasPriceWei = GAS_PRICE): number {
  return (Number(gas) * Number(gasPriceWei) * rho * FACTS.nativePriceUsd) / 1e18;
}

const r = (p: DcaPool, tpBps: number): number => Number(dcaGrossRateE18(p, tpBps)) / 1e18;

/** The TP and level mint gas a measured pool implies, from R0 at a = 1 and a = 2 (R3.5 is linear in `a`). */
function mints(p: DcaPool): { readonly tp: bigint; readonly level: bigint } {
  const level = dcaR0Gas(p, 2) - dcaR0Gas(p, 1) - DCA_GAS_EXIT;
  return { tp: dcaR0Gas(p, 1) - DCA_GAS_GUARD_BUY - DCA_GAS_EXIT - (level + DCA_GAS_EXIT), level };
}

const MEASURED = ["NVDAB", "TSLAB", "QQQB", "SPYB"] as const;

describe("R2.15 — gross per round on cost, worst snap", () => {
  it("r = (1 + TP) · 1.0001^(s/2) · (1 + f) − 1", () => {
    assert.equal((r(pool("NVDAB"), 150) * 100).toFixed(4), "2.0084");
    assert.equal((r(pool("NVDAB"), 100) * 100).toFixed(4), "1.5059");
    assert.equal((r(pool("TSLAB"), 150) * 100).toFixed(4), "2.0084");
    assert.equal((r(pool("QQQB"), 150) * 100).toFixed(4), "1.5152");
    assert.equal((r(pool("SPYB"), 100) * 100).toFixed(4), "1.0152");
  });
});

describe("12. R3.5 — the gas model: R0 with `a` level mints and exits, and the merged fill batch", () => {
  it("the integer vectors: R0 at a = 1 and a = 2, and the per-fill batch", () => {
    assert.deepEqual([...MEASURED, "GOOGLB"].map((symbol) => [dcaR0Gas(pool(symbol), 1), dcaR0Gas(pool(symbol), 2), dcaPerFillGas(pool(symbol))]), [
      [1_827_700n, 2_367_058n, 1_327_700n],
      [1_874_533n, 2_420_353n, 1_374_533n],
      [2_042_613n, 2_715_226n, 1_542_613n],
      [2_000_362n, 2_585_377n, 1_500_362n],
      [2_436_893n, 3_146_459n, 1_786_893n],
    ]);
  });

  it("R2.4's mint gas per measured pool, and per fill = O + 2X + M_T + M_L", () => {
    assert.deepEqual(MEASURED.map((symbol) => mints(pool(symbol))), [
      { tp: 428_342n, level: 379_358n }, { tp: 468_713n, level: 385_820n },
      { tp: 510_000n, level: 512_613n }, { tp: 555_347n, level: 425_015n },
    ]);
    for (const symbol of MEASURED) {
      const { tp, level } = mints(pool(symbol));
      assert.equal(dcaPerFillGas(pool(symbol)), DCA_GAS_OVERHEAD + 2n * DCA_GAS_EXIT + tp + level, symbol);
    }
  });

  it("the TP update per fill on NVDAB at the three multiples", () => {
    const { tp } = mints(pool("NVDAB"));
    assert.deepEqual([1.5, 2.45, 3.38].map((rho) => usd(DCA_GAS_EXIT + tp, rho).toFixed(4)), ["0.0340", "0.0555", "0.0765"]);
  });

  it("REVIEW2 condition 14: a pool without its own row uses its class maximum + 30 % (audit M-1)", () => {
    // Spacing 50: max(NVDAB, TSLAB) × 1.30, rounded up, of each function's output.
    for (const p of DCA_POOLS_56.filter((entry) => !(MEASURED as readonly string[]).includes(entry.symbol))) {
      assert.equal(p.tickSpacing, 50, p.symbol);
      assert.equal(dcaR0Gas(p, 1), 2_436_893n, p.symbol);
      assert.equal(dcaR0Gas(p, 2), 3_146_459n, p.symbol);
      assert.equal(dcaPerFillGas(p), 1_786_893n, p.symbol);
    }
  });
});

// Operator ruling 2026-09-25: Auto DCA charges no platform fee, so the cost basis is C = B.
describe("12. R3.6 — base 15 USDT, DCA order 10, 0.05 gwei, 2.45×", () => {
  const rows: readonly (readonly [string, number, number, string, string, string])[] = [
    ["NVDAB", 4, 100, "0.0028", "0.2063", "0.0506"],
    ["NVDAB", 4, 150, "0.0782", "0.4827", "0.0675"],
    ["NVDAB", 2, 100, "0.0536", "0.1554", "0.0656"],
    ["NVDAB", 2, 150, "0.1290", "0.3313", "0.0874"],
    ["QQQB", 4, 150, "-0.0286", "0.1227", "0.0444"],
    ["QQQB", 2, 150, "0.0348", "0.1104", "0.0590"],
    ["NVDAB", 5, 100, "0.0028", "0.2317", "0.0506"],
  ];

  it("the R3 no-fill net, the all-filled net and the gas at which the hold engages, to 4 decimals", () => {
    for (const [symbol, n, tp, noFill, allFilled, engages] of rows) {
      const p = pool(symbol);
      const { tp: tpGas } = mints(p);
      const r0 = dcaR0Gas(p, dcaAhead(n));
      // all-filled_R3 = GUARD_BUY + M_T + X + N·(O + 2X + M_T + M_L), one fill per batch.
      const all = DCA_GAS_GUARD_BUY + tpGas + DCA_GAS_EXIT + BigInt(n) * dcaPerFillGas(p);
      assert.deepEqual([
        (15 * r(p, tp) - usd(r0, 2.45)).toFixed(4),
        ((15 + 10 * n) * r(p, tp) - usd(all, 2.45)).toFixed(4),
        (0.05 * 15 * r(p, tp) / usd(r0, 2.45)).toFixed(4),
      ], [noFill, allFilled, engages], `${symbol} N=${n} TP ${tp}`);
    }
  });

  const hold = (p: DcaPool, n: number, tp: number, gasPriceWei: bigint): boolean => {
    const cost = nativeCostToUsdtAtomic(dcaBilledNativeWei(dcaR0Gas(p, dcaAhead(n)), gasPriceWei), FACTS);
    assert.notEqual(cost, null);
    return dcaUneconomic({ pool: p, entryWei: 15n * E18, feeWei: 0n, takeProfitBps: tp, r0CostUsdtWei: cost ?? 0n });
  };

  it("the hold engages 1 % above each listed gas price and not 1 % below it", () => {
    // R3.6's table and its per-pool list: N ≤ 3 (a = 1) and N ≥ 4 (a = 2); GOOGLB stands for the 13 class pools.
    const listed: readonly (readonly [string, number, number, number])[] = [
      ["NVDAB", 2, 100, 0.0656], ["NVDAB", 4, 100, 0.0506], ["NVDAB", 2, 150, 0.0874], ["NVDAB", 4, 150, 0.0675],
      ["TSLAB", 2, 100, 0.0639], ["TSLAB", 4, 100, 0.0495], ["TSLAB", 4, 150, 0.0660],
      ["QQQB", 2, 150, 0.0590], ["QQQB", 4, 150, 0.0444], ["SPYB", 2, 150, 0.0603], ["SPYB", 4, 150, 0.0466],
      ["GOOGLB", 2, 100, 0.0492], ["GOOGLB", 4, 100, 0.0381], ["GOOGLB", 2, 150, 0.0656], ["GOOGLB", 4, 150, 0.0508],
    ];
    for (const [symbol, n, tp, gwei] of listed) {
      const wei = (factor: number) => BigInt(Math.round(gwei * factor * 1e9));
      assert.equal(hold(pool(symbol), n, tp, wei(1.01)), true, `${symbol} N=${n} TP ${tp} above`);
      assert.equal(hold(pool(symbol), n, tp, wei(0.99)), false, `${symbol} N=${n} TP ${tp} below`);
    }
  });

  it("at 0.05 gwei the calibrated cost starts NVDAB everywhere; the fee-100 pools still hold at N ≥ 4 (R3.6, D-R3-1; calibration R1)", () => {
    const holding = (n: number, tp: number) => DCA_POOLS_56.filter((p) => hold(p, n, tp, GAS_PRICE)).map((p) => p.symbol);
    const everyFee100 = ["QQQB", "SPYB"];
    const class50 = DCA_POOLS_56.filter((p) => !(MEASURED as readonly string[]).includes(p.symbol)).map((p) => p.symbol);
    // Under R1, NVDAB starts at every N and both TPs; TSLAB starts at TP 1 % only for N ≤ 3, and at TP 1.5 % for every N.
    assert.deepEqual(new Set(holding(2, 100)), new Set([...everyFee100, ...class50]));
    assert.deepEqual(new Set(holding(4, 100)), new Set([...everyFee100, ...class50, "TSLAB"]));
    assert.deepEqual(new Set(holding(2, 150)), new Set([]));
    assert.deepEqual(new Set(holding(4, 150)), new Set(everyFee100));
  });
});

describe("R2.9 / R3.5 / REVIEW2 condition 7 — the native day cap", () => {
  it("13 (review C8). a busy R3 round plus two sweeps at the quoted 3.38× fits capDayWei(N) for every N; two sweeps fit 2 × R_DCA", () => {
    // Busy R3 round: a close + start exiting `a` resting levels (R0 at `a`), then all N
    // fills one per batch, each minting a level: `dcaR0Gas(p, a) + N · dcaPerFillGas(p)`.
    // Sweep: `O + (1 + a) · X`, the I14 bound of live orders. Billed at the quoted 3.38×, 0.05 gwei.
    const quoted = (gas: bigint): bigint => (gas * GAS_PRICE * 338n) / 100n;
    const sweep = (n: number): bigint => DCA_GAS_OVERHEAD + BigInt(1 + dcaAhead(n)) * DCA_GAS_EXIT;
    const busy = (p: DcaPool, n: number): bigint => dcaR0Gas(p, dcaAhead(n)) + BigInt(n) * dcaPerFillGas(p) + 2n * sweep(n);
    for (const symbol of ["NVDAB", "SPYB", "GOOGLB"]) {
      for (let n = 1; n <= 8; n += 1) {
        assert.ok(quoted(busy(pool(symbol), n)) <= dcaNativeReserveWei(n), `${symbol} N=${n}`);
        assert.ok(quoted(2n * sweep(n)) <= 2n * R_DCA, `two sweeps at N=${n}`);
      }
    }
    // The review's recomputation of the R3.5 native table from this expression.
    assert.equal(quoted(busy(pool("NVDAB"), 4)), 1_527_398_002_000_000n);
    assert.equal(quoted(busy(pool("NVDAB"), 8)), 2_424_923_202_000_000n);
    assert.equal(quoted(busy(pool("SPYB"), 8)), 2_695_258_137_000_000n);
    assert.equal(quoted(busy(pool("GOOGLB"), 1)), 889_579_834_000_000n);
    assert.equal(quoted(busy(pool("GOOGLB"), 8)), 3_177_470_907_000_000n);
  });

  it("V8: dcaNativeReserveWei(N) = (2N + 4) × R_DCA", () => {
    assert.equal(dcaNativeReserveWei(4), 3_840_000_000_000_000n);
    assert.equal(dcaNativeReserveWei(8), 6_400_000_000_000_000n);
    assert.equal(dcaNativeReserveWei(1), 1_920_000_000_000_000n);
    assert.throws(() => dcaNativeReserveWei(9));
  });

  it("checkTradfiDcaSizing: USDT covers B + N·D; the signed day cap covers the reserve", () => {
    const input = { capDayWei: 3_840_000_000_000_000n, entryWei: 15n * E18, dcaOrderWei: 10n * E18, dcaMaxOrders: 4, capitalQuoteWei: 55n * E18 };
    assert.deepEqual(checkTradfiDcaSizing(input), {
      ok: true, requiredQuoteWei: 55n * E18, shortfallQuoteWei: 0n, nativeReserveWei: 3_840_000_000_000_000n, nativeShortfallWei: 0n,
    });
    const short = checkTradfiDcaSizing({ ...input, capDayWei: 3_840_000_000_000_000n - 1n });
    assert.equal(short.ok, false);
    assert.equal(short.nativeShortfallWei, 1n);
    const quote = checkTradfiDcaSizing({ ...input, capitalQuoteWei: 54n * E18 });
    assert.equal(quote.ok, false);
    assert.equal(quote.shortfallQuoteWei, E18);
  });
});
