import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import {
  UNISWAP_V3_ROUTER02_ABI,
} from "../src/ops/abis.js";
import type { TradeRoute } from "../src/ops/route.js";
import {
  buildUniswapV3Buy,
  buildUniswapV3Sell,
  isEncodableUniswapV3Route,
} from "../src/ops/uniswapV3.js";
import { buildPancakeV3Buy } from "../src/ops/pancakeV3.js";

const ROUTER = getAddress("0x1111111111111111111111111111111111111111");
const WBNB = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const HOP = getAddress("0x4444444444444444444444444444444444444444");
const DEADLINE = 1_900_000_123n;

function params(route: TradeRoute) {
  return { router: ROUTER, wbnb: WBNB, token: TOKEN, amountInWei: 100n, minOutWei: 90n,
    recipient: getAddress("0x5555555555555555555555555555555555555555"), deadline: DEADLINE, route };
}

describe("Uniswap V3 SwapRouter02 builders", () => {
  it("uses the four-function ABI and a two-call buy with refundETH", () => {
    assert.deepEqual(UNISWAP_V3_ROUTER02_ABI.map((entry) => entry.name), [
      "exactInputSingle", "exactInput", "refundETH", "unwrapWETH9",
    ]);
    const calls = buildUniswapV3Buy(params({ hops: [], fees: [3000] }));
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.to, ROUTER);
    assert.equal(calls[0]?.value, 100n);
    assert.ok(calls[0]?.data?.startsWith("0x04e45aaf"));
    assert.equal(calls[1]?.data, "0x12210e8a");
    assert.equal(calls[0]?.data?.includes("5ae401dc"), false);
    const decoded = decodeFunctionData({ abi: UNISWAP_V3_ROUTER02_ABI, data: calls[0]?.data as Hex });
    assert.equal(decoded.functionName, "exactInputSingle");
    assert.equal("deadline" in (decoded.args[0] as Record<string, unknown>), false);
  });

  it("uses exactInput for a two-hop buy without putting a deadline in the struct", () => {
    const calls = buildUniswapV3Buy(params({ hops: [HOP], fees: [500, 3000] }));
    assert.ok(calls[0]?.data?.startsWith("0xb858183f"));
    const decoded = decodeFunctionData({ abi: UNISWAP_V3_ROUTER02_ABI, data: calls[0]?.data as Hex });
    assert.equal(decoded.functionName, "exactInput");
    assert.equal("deadline" in (decoded.args[0] as Record<string, unknown>), false);
  });

  it("sells with exact approvals, router recipient, and a native unwrap tail", () => {
    const calls = buildUniswapV3Sell(params({ hops: [HOP], fees: [500, 3000] }));
    assert.equal(calls.length, 4);
    assert.equal(calls[0]?.data?.startsWith("0x095ea7b3"), true);
    assert.equal(calls[1]?.data?.startsWith("0x095ea7b3"), true);
    assert.equal(calls[0]?.value, undefined);
    assert.ok(calls[2]?.data?.startsWith("0xb858183f"));
    assert.ok(calls[2]?.data?.includes(ROUTER.slice(2).toLowerCase()));
    assert.ok(calls[3]?.data?.startsWith("0x49404b7c"));
    assert.ok(calls[3]?.data?.includes(params({ hops: [], fees: [3000] }).recipient.slice(2).toLowerCase()));
  });

  it("refuses Pancake tier 2500 and accepts Uniswap tier 3000 at the builder", () => {
    assert.equal(isEncodableUniswapV3Route({ hops: [], fees: [2500] }), false);
    assert.throws(() => buildUniswapV3Buy(params({ hops: [], fees: [2500] })), /not encodable/u);
    assert.equal(isEncodableUniswapV3Route({ hops: [], fees: [3000] }), true);
    assert.throws(() => buildPancakeV3Buy(params({ hops: [], fees: [3000] })), /not encodable/u);
  });
});
