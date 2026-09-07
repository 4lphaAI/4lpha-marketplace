/**
 * Golden calldata for `buildLpExitSwap` — the LP EXIT's step-1 leg
 * (PHASE3.1 Rev2 items 1–4).
 *
 * Same discipline as `test/ops.builders.test.ts` and `test/ops.lpSweep.test.ts`:
 * the expected hex is assembled BY HAND from selector literals and 32-byte
 * words, using nothing but string padding — never `encodeFunctionData`. The
 * selector literals were verified against the DEPLOYED dedicated V3 SwapRouter's
 * bytecode on BNB Chain 56.
 *
 * THE POINT OF THE FILE, stated once: the PHASE3.1 spec claimed this batch was
 * already buildable from `buildLpSweepSwap`. It is not — that builder writes
 * `recipient = wallet` and wraps the swap ALONE, and composing that with the
 * router's `unwrapWETH9` REVERTS on chain (`Insufficient WETH9`, measured by
 * the review on 2026-08-16), because the output has already left the router.
 * So `buildLpExitSwap` is a thin validating wrapper over the mainnet-proven
 * `buildPancakeV3Sell`, and the equality test below is what stops the two from
 * ever drifting.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import {
  buildLpExitSwap,
  buildLpSweepSwap,
  buildPancakeV3Sell,
} from "../src/ops/pancakeV3.js";

const SELECTORS = {
  exactInputSingle: "0x414bf389",
  exactInput: "0xc04b8d59",
  multicall: "0xac9650d8",
  approve: "0x095ea7b3",
  refundETH: "0x12210e8a",
  unwrapWETH9: "0x49404b7c",
} as const;

const ROUTER = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x00000000000000000000000000000000000000AA");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const WALLET = getAddress("0x00000000000000000000000000000000000000bB");
const DEADLINE = 1_900_000_120n;

/** The exact CAKE leg FINDINGS (ag)'s live protect returned. */
const AMOUNT_IN = 603_777_753_500_127_217n;
/** The QuoterV2 answer for it at fee 500, from the review's on-chain read. */
const MIN_OUT = 1_435_052_632_749_421n;

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

/** `unwrapWETH9(uint256,address)` calldata, by hand. */
function unwrapData(minOut: bigint, recipient: Address): string {
  return SELECTORS.unwrapWETH9.slice(2) + word(minOut) + addressWord(recipient);
}

/** `multicall(bytes[])` with TWO inner calls, by hand. */
function multicallTwo(first: string, second: string): string {
  const firstPadded = first.padEnd(Math.ceil(first.length / 64) * 64, "0");
  const secondPadded = second.padEnd(Math.ceil(second.length / 64) * 64, "0");
  // Element offsets are measured from the START of the array data area (which
  // begins at the element count's successor word): two offset words, then the
  // first element's length + body.
  const secondOffset = BigInt(2 * 32 + 32 + firstPadded.length / 2);
  return (
    SELECTORS.multicall +
    word(0x20n) + // offset to the array
    word(2n) + // two elements
    word(0x40n) + // offset to element 0
    word(secondOffset) + // offset to element 1
    word(BigInt(first.length / 2)) +
    firstPadded +
    word(BigInt(second.length / 2)) +
    secondPadded
  );
}

const params = {
  router: ROUTER,
  wbnb: WBNB,
  quoteToken: WBNB,
  token: TOKEN,
  fee: 500,
  amountInWei: AMOUNT_IN,
  minOutWei: MIN_OUT,
  recipient: WALLET,
  deadline: DEADLINE,
} as const;

describe("buildLpExitSwap: golden calldata", () => {
  it("is [approve(0), approve(exact), multicall([exactInputSingle(recipient = ROUTER), unwrapWETH9])] with NO value", () => {
    const calls = buildLpExitSwap(params);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.to),
      [TOKEN, TOKEN, ROUTER],
    );
    // The 2.3-R4 approve pair on the leg being SOLD: zero reset, then EXACT.
    assert.equal(calls[0]?.data, SELECTORS.approve + addressWord(ROUTER) + word(0n));
    assert.equal(
      calls[1]?.data,
      SELECTORS.approve + addressWord(ROUTER) + word(AMOUNT_IN),
    );

    const swap = exactInputSingleData({
      tokenIn: TOKEN,
      tokenOut: WBNB,
      fee: 500n,
      // THE RECIPIENT SENTINEL: the router's OWN literal address, so the WBNB
      // is still in the router when `unwrapWETH9` runs. `address(0)` also
      // works on this router and is deliberately not used; `recipient = wallet`
      // (what `buildLpSweepSwap` writes) makes the unwrap revert.
      recipient: ROUTER,
      deadline: DEADLINE,
      amountIn: AMOUNT_IN,
      minOut: MIN_OUT,
    });
    const unwrap = unwrapData(MIN_OUT, WALLET);
    assert.equal(calls[2]?.data, multicallTwo(swap, unwrap));

    for (const call of calls) {
      assert.equal(call.value, undefined, "an exit swap never attaches native value");
      assert.ok(!call.data?.includes(SELECTORS.refundETH.slice(2)));
    }
  });

  it("writes the router's own address as the swap recipient — never address(0), never the wallet", () => {
    const calls = buildLpExitSwap(params);
    const data = calls[2]?.data ?? "";
    assert.ok(data.includes(addressWord(ROUTER)), "the router is the swap recipient");
    assert.ok(
      !data.includes(addressWord(WALLET) + word(DEADLINE)),
      "the wallet must never appear where the swap's recipient goes",
    );
    // The wallet appears exactly once — as the UNWRAP's recipient.
    const occurrences = data.split(addressWord(WALLET)).length - 1;
    assert.equal(occurrences, 1);
  });

  it("carries minOutWei on BOTH legs, and the unwrap floor is the WEAKER one (PHASE2.2 R5)", () => {
    // `amountOutMinimum` measures THIS swap; `unwrapWETH9`'s floor measures the
    // ROUTER'S ENTIRE WBNB balance, so with any stray WBNB parked there a swap
    // returning far less than the floor would still pass it. It rides along; it
    // never substitutes.
    const calls = buildLpExitSwap(params);
    const data = calls[2]?.data ?? "";
    const occurrences = data.split(word(MIN_OUT)).length - 1;
    assert.equal(occurrences, 2, "the floor appears on the swap AND on the unwrap");
    assert.ok(data.includes(unwrapData(MIN_OUT, WALLET)));
  });

  it("is BYTE-IDENTICAL to buildPancakeV3Sell for the same inputs — the anti-drift pin (Rev2 item 3)", () => {
    const wrapped = buildLpExitSwap(params);
    const proven = buildPancakeV3Sell({
      router: ROUTER,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: AMOUNT_IN,
      minOutWei: MIN_OUT,
      recipient: WALLET,
      deadline: DEADLINE,
      route: { hops: [], fees: [500] },
    });
    assert.deepEqual(wrapped, proven);
  });

  it("is NOT buildLpSweepSwap's batch — that one writes recipient = wallet and cannot unwrap (Rev2 item 1)", () => {
    const exit = buildLpExitSwap(params);
    const sweep = buildLpSweepSwap({
      router: ROUTER,
      tokenIn: TOKEN,
      tokenOut: WBNB,
      fee: 500,
      amountInWei: AMOUNT_IN,
      minOutWei: MIN_OUT,
      recipient: WALLET,
      deadline: DEADLINE,
    });
    assert.notDeepEqual(exit, sweep);
    // The sweep still has no unwrap at all — PHASE3 Rev2 item 14's guard on the
    // ROTATE path, which this phase must not widen.
    assert.ok(!sweep[2]?.data?.includes(SELECTORS.unwrapWETH9.slice(2)));
    assert.ok(exit[2]?.data?.includes(SELECTORS.unwrapWETH9.slice(2)));
  });

  it("is SINGLE-HOP in the position's own pool, always — no exactInput, no route choice (Rev2 item 4)", () => {
    for (const fee of [100, 500, 2500, 10_000]) {
      const calls = buildLpExitSwap({ ...params, fee });
      const data = calls[2]?.data ?? "";
      assert.ok(
        data.includes(SELECTORS.exactInputSingle.slice(2)),
        "one pool is exactInputSingle, never a one-pool exactInput (PHASE2.2 R12)",
      );
      assert.ok(!data.includes(SELECTORS.exactInput.slice(2) + "0"));
      assert.ok(data.includes(word(BigInt(fee))), "the position's OWN fee tier");
    }
  });
});

describe("buildLpExitSwap: the non-WBNB quote branch", () => {
  it("LOSES the unwrap rather than emitting a wrong one when quoteToken is not WBNB (Rev2 item 5)", () => {
    // v1 never reaches this — `/lp/open` refuses pools without a WBNB leg, and
    // the exit saga skips on it — but the builder's failure direction is stated
    // here so a future USDT-quoted pool degrades to an ERC-20 delivery instead
    // of asking WETH9 to unwrap something it never wrapped.
    const calls = buildLpExitSwap({ ...params, quoteToken: USDT });
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.to),
      [TOKEN, TOKEN, ROUTER],
    );
    assert.ok(!calls[2]?.data?.includes(SELECTORS.unwrapWETH9.slice(2)));
    assert.deepEqual(
      calls,
      buildLpSweepSwap({
        router: ROUTER,
        tokenIn: TOKEN,
        tokenOut: USDT,
        fee: 500,
        amountInWei: AMOUNT_IN,
        minOutWei: MIN_OUT,
        recipient: WALLET,
        deadline: DEADLINE,
      }),
    );
  });
});

describe("buildLpExitSwap: the guard set", () => {
  it("refuses identical legs, non-positive amounts, a ZERO FLOOR, unknown fee tiers, bad deadlines, and the zero recipient", () => {
    assert.throws(
      () => buildLpExitSwap({ ...params, token: WBNB }),
      /must differ/,
    );
    assert.throws(() => buildLpExitSwap({ ...params, amountInWei: 0n }), /amountInWei/);
    assert.throws(() => buildLpExitSwap({ ...params, amountInWei: -1n }), /amountInWei/);
    // PHASE3 Rev2 item 23: a zero floor is a FORGOTTEN DERIVATION, never a
    // default — the whole reason this wrapper exists rather than a raw call.
    assert.throws(() => buildLpExitSwap({ ...params, minOutWei: 0n }), /minOutWei/);
    assert.throws(() => buildLpExitSwap({ ...params, fee: 0 }), /fee/);
    assert.throws(() => buildLpExitSwap({ ...params, fee: 3_000 }), /fee/);
    assert.throws(() => buildLpExitSwap({ ...params, fee: 1.5 }), /fee/);
    assert.throws(() => buildLpExitSwap({ ...params, deadline: 0n }), /deadline/);
    assert.throws(
      () =>
        buildLpExitSwap({
          ...params,
          recipient: "0x0000000000000000000000000000000000000000",
        }),
      /zero address/,
    );
  });
});
