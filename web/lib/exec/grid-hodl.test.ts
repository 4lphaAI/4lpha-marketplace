import { describe, expect, it } from "vitest";
import { onChainGridHodl } from "./agent-detail";
import { getSqrtRatioAtTick, WBNB_56 } from "./pairs";

const BASE = "0x5c85d6c6825ab4032337f11ee92a72df936b46f6";
const POOL = "0x90a54475d512b8f3852351611c38fad30a513491";
const NOW = 1788828900000;
const arm = { status: "ready", method: "arm-transaction-post-swap-v1",
  txHash: `0x${"11".repeat(32)}`, blockHash: `0x${"22".repeat(32)}`, blockNumber: "120346004",
  armedAtMs: 1788717275000, pool: POOL, token0: BASE, token1: WBNB_56,
  sqrtPriceX96: "513880076837086159948503475", capitalWei: "62700000000000000" };
const input: Parameters<typeof onChainGridHodl>[0] = { benchmark: arm, capitalWei: arm.capitalWei,
  pool: POOL, token0: BASE, token1: WBNB_56, nowMs: NOW,
  liveTick: { poolAddress: POOL, tick: -101257, blockNumber: "120700000", readAtMs: NOW } };

describe("on-chain base token HODL", () => {
  it("uses the original arm receipt beyond 500 one-minute bars and selected capital only", () => {
    const result = onChainGridHodl(input);
    expect(result.metric.value).toBe("-4.78%");
    expect(result.metric.note).toBeUndefined();
    expect(result.armedAtMs).toBe(arm.armedAtMs);
    expect(result.txHash).toBe(arm.txHash);
    // Neither chart data, gas reserve, cap nor deposit total is a dependency.
    expect(onChainGridHodl({ ...input, nowMs: NOW + 30000 }).metric).toEqual(result.metric);
  });
  it("reports only a percentage, without dollar or BNB amounts or explanatory copy", () => {
    expect(onChainGridHodl(input).metric).toEqual({ value: "-4.78%", reason: null });
  });
  it("prices the opposite orientation with integer atomic ratios, independent of decimals", () => {
    const reversed = { ...arm, token0: WBNB_56, token1: BASE, sqrtPriceX96: getSqrtRatioAtTick(100000).toString() };
    const result = onChainGridHodl({ ...input, benchmark: reversed, token0: WBNB_56, token1: BASE,
      liveTick: { ...input.liveTick!, tick: 99000 } });
    expect(result.metric.value).toBe("+10.51%");
  });
  for (const [name, override] of [
    ["no current price", { liveTick: null }],
    ["stale current price", { nowMs: NOW + 60001 }],
    ["future current price", { nowMs: NOW - 1 }],
    ["wrong current pool", { liveTick: { ...input.liveTick!, poolAddress: BASE } }],
    ["current block predates arm", { liveTick: { ...input.liveTick!, blockNumber: "1" } }],
    ["capital mismatch", { capitalWei: "1" }],
    ["missing evidence", { benchmark: undefined }],
    ["wrong receipt pool", { benchmark: { ...arm, pool: BASE } }],
    ["malformed receipt pool", { benchmark: { ...arm, pool: { toString: 1 } } }],
    ["zero price", { benchmark: { ...arm, sqrtPriceX96: "0" } }],
    ["wrong method", { benchmark: { ...arm, method: "candle" } }],
    ["negative arm time", { benchmark: { ...arm, armedAtMs: -1 } }],
  ] as const) it(`does not invent HODL for ${name}`, () => expect(onChainGridHodl({ ...input, ...override }).metric.value).toBeNull());
});
