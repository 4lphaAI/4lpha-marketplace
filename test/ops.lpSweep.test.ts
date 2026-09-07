/**
 * Golden calldata for `buildLpSweepSwap` — the LP saga's `sweep-token` leg
 * (PHASE3 Rev2 items 14/15/23/31).
 *
 * Same discipline as `test/ops.builders.test.ts`: the expected hex is
 * assembled BY HAND from selector literals and 32-byte words, using nothing
 * but string padding — never `encodeFunctionData`. The selector literals were
 * verified against the DEPLOYED dedicated V3 SwapRouter's bytecode on BNB
 * Chain 56 (see `src/ops/abis.ts` provenance).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import { buildLpSweepSwap } from "../src/ops/pancakeV3.js";

const SELECTORS = {
  exactInputSingle: "0x414bf389",
  multicall: "0xac9650d8",
  approve: "0x095ea7b3",
  refundETH: "0x12210e8a",
  unwrapWETH9: "0x49404b7c",
} as const;

const ROUTER = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x00000000000000000000000000000000000000AA");
const WALLET = getAddress("0x00000000000000000000000000000000000000bB");
const DEADLINE = 1_900_000_120n;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: Address): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

/** `exactInputSingle` calldata, by hand. All eight members are static. */
function exactInputSingleData(input: {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
  readonly amountIn: bigint;
  readonly minOut: bigint;
}): string {
  return (
    SELECTORS.exactInputSingle.slice(2) +
    addressWord(input.tokenIn) +
    addressWord(input.tokenOut) +
    word(input.fee) +
    addressWord(input.recipient) +
    word(input.deadline) +
    word(input.amountIn) +
    word(input.minOut) +
    word(0n) // sqrtPriceLimitX96 — ALWAYS zero
  );
}

/** `multicall(bytes[])` with ONE inner call, by hand. */
function multicallOne(inner: string): string {
  return (
    SELECTORS.multicall +
    word(0x20n) + // offset to the array
    word(1n) + // one element
    word(0x20n) + // offset to the element, from the array data area
    word(BigInt(inner.length / 2)) +
    inner.padEnd(Math.ceil(inner.length / 64) * 64, "0")
  );
}

const params = {
  router: ROUTER,
  tokenIn: WBNB,
  tokenOut: TOKEN,
  fee: 2_500,
  amountInWei: 123_456n,
  minOutWei: 990n,
  recipient: WALLET,
  deadline: DEADLINE,
} as const;

describe("buildLpSweepSwap", () => {
  it("is exactly [approve(0), approve(exact), multicall([exactInputSingle])], recipient = wallet, NO value", () => {
    const calls = buildLpSweepSwap(params);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.to),
      [WBNB, WBNB, ROUTER],
    );
    // The 2.3-R4 approve pair: zero reset, then the EXACT amount, on tokenIn.
    assert.equal(
      calls[0]?.data,
      SELECTORS.approve + addressWord(ROUTER) + word(0n),
    );
    assert.equal(
      calls[1]?.data,
      SELECTORS.approve + addressWord(ROUTER) + word(123_456n),
    );
    // ONE swap inside the multicall — no refundETH (nothing native to refund)
    // and no unwrapWETH9 (Rev2 item 14: the freed WBNB stays WBNB).
    const swap = exactInputSingleData({
      tokenIn: WBNB,
      tokenOut: TOKEN,
      fee: 2_500n,
      recipient: WALLET,
      deadline: DEADLINE,
      amountIn: 123_456n,
      minOut: 990n,
    });
    assert.equal(calls[2]?.data, multicallOne(swap));
    for (const call of calls) {
      assert.equal(call.value, undefined, "a sweep never attaches native value");
      assert.ok(!call.data?.includes(SELECTORS.refundETH.slice(2)));
      assert.ok(!call.data?.includes(SELECTORS.unwrapWETH9.slice(2)));
    }
  });

  it("encodes the reverse direction (TOKEN → WBNB) with the approves on TOKEN", () => {
    const calls = buildLpSweepSwap({
      ...params,
      tokenIn: TOKEN,
      tokenOut: WBNB,
    });
    assert.deepEqual(
      calls.map((c) => c.to),
      [TOKEN, TOKEN, ROUTER],
    );
    const swap = exactInputSingleData({
      tokenIn: TOKEN,
      tokenOut: WBNB,
      fee: 2_500n,
      recipient: WALLET,
      deadline: DEADLINE,
      amountIn: 123_456n,
      minOut: 990n,
    });
    assert.equal(calls[2]?.data, multicallOne(swap));
  });

  it("refuses identical legs, non-positive amounts, a ZERO FLOOR, bad fee tiers, bad deadlines, and the zero recipient", () => {
    assert.throws(
      () => buildLpSweepSwap({ ...params, tokenOut: WBNB }),
      /same address/,
    );
    assert.throws(
      () => buildLpSweepSwap({ ...params, amountInWei: 0n }),
      /amountInWei/,
    );
    // Rev2 item 23: zero/absent floors are a build error, not a default.
    assert.throws(
      () => buildLpSweepSwap({ ...params, minOutWei: 0n }),
      /minOutWei/,
    );
    assert.throws(() => buildLpSweepSwap({ ...params, fee: 0 }), /fee/);
    assert.throws(() => buildLpSweepSwap({ ...params, fee: 0x1000000 }), /fee/);
    assert.throws(() => buildLpSweepSwap({ ...params, deadline: 0n }), /deadline/);
    assert.throws(
      () =>
        buildLpSweepSwap({
          ...params,
          recipient: "0x0000000000000000000000000000000000000000",
        }),
      /zero address/,
    );
  });
});
