/**
 * Golden calldata for `buildSingleSidedMintBatch` (AUTO-DCA-SPEC §5.5).
 *
 * The `test/ops.nfpm.test.ts` discipline: expected hex is assembled BY HAND from
 * the selector literals (located in the deployed NFPM and ERC-20 dispatchers)
 * and 32-byte words — never `encodeFunctionData`. Both pool orientations: a
 * USDT level on NVDAB (stock = token0) and a stock TP on TSLAB (USDT = token0).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";

import { NFPM_56, buildSingleSidedMintBatch } from "../src/ops/nfpm.js";

const SELECTORS = { mint: "0x88316456", approve: "0x095ea7b3" } as const;
const FORBIDDEN = ["0xac9650d8", "0xa22cb465", "0x42842e0e", "0x23b872dd"] as const; // multicall, setApprovalForAll, safeTransferFrom, transferFrom

const USDT: Address = getAddress("0x55d398326f99059fF775485246999027B3197955");
const NVDAB: Address = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const TSLAB: Address = getAddress("0x5b1910eaad6450e50f816082aa078c41f10c292f");
const WALLET: Address = getAddress("0x00000000000000000000000000000000000000bB");
const DEADLINE = 1_900_000_120n;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function signedWord(value: bigint): string {
  return word(value < 0n ? (1n << 256n) + value : value);
}

function addressWord(value: Address): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function approveData(spender: Address, amount: bigint): string {
  return SELECTORS.approve + addressWord(spender) + word(amount);
}

function mintData(fields: {
  readonly token0: Address; readonly token1: Address; readonly fee: bigint;
  readonly tickLower: bigint; readonly tickUpper: bigint;
  readonly a0: bigint; readonly a1: bigint; readonly m0: bigint; readonly m1: bigint;
}): string {
  return SELECTORS.mint + addressWord(fields.token0) + addressWord(fields.token1) + word(fields.fee)
    + signedWord(fields.tickLower) + signedWord(fields.tickUpper)
    + word(fields.a0) + word(fields.a1) + word(fields.m0) + word(fields.m1)
    + addressWord(WALLET) + word(DEADLINE);
}

const level = { tickLower: 53_900, tickUpper: 53_950, amount0DesiredWei: 0n, amount1DesiredWei: 10n ** 19n, amount0MinWei: 0n, amount1MinWei: 9_999_000_000_000_000_000n };
const nvdab = { nfpm: NFPM_56, token0: NVDAB, token1: USDT, fee: 2_500, recipient: WALLET, deadline: DEADLINE } as const;
const tp = { tickLower: -59_550, tickUpper: -59_500, amount0DesiredWei: 0n, amount1DesiredWei: 40_000_000_000_000_000n, amount0MinWei: 0n, amount1MinWei: 39_996_000_000_000_000n };
const tslab = { nfpm: NFPM_56, token0: USDT, token1: TSLAB, fee: 2_500, recipient: WALLET, deadline: DEADLINE } as const;

describe("buildSingleSidedMintBatch — golden calldata", () => {
  it("a USDT level on a stock = token0 pool: [approve 0, approve exact, mint]", () => {
    const calls = buildSingleSidedMintBatch({ ...nvdab, mints: [level] });
    assert.deepEqual(calls, [
      { to: USDT, data: approveData(NFPM_56, 0n) },
      { to: USDT, data: approveData(NFPM_56, 10n ** 19n) },
      { to: NFPM_56, data: mintData({ token0: NVDAB, token1: USDT, fee: 2_500n, tickLower: 53_900n, tickUpper: 53_950n, a0: 0n, a1: 10n ** 19n, m0: 0n, m1: 9_999_000_000_000_000_000n }) },
    ]);
  });

  it("a stock TP on a USDT = token0 pool, negative ticks", () => {
    const calls = buildSingleSidedMintBatch({ ...tslab, mints: [tp] });
    assert.deepEqual(calls, [
      { to: TSLAB, data: approveData(NFPM_56, 0n) },
      { to: TSLAB, data: approveData(NFPM_56, 40_000_000_000_000_000n) },
      { to: NFPM_56, data: mintData({ token0: USDT, token1: TSLAB, fee: 2_500n, tickLower: -59_550n, tickUpper: -59_500n, a0: 0n, a1: 40_000_000_000_000_000n, m0: 0n, m1: 39_996_000_000_000_000n }) },
    ]);
  });

  it("two mints keep the caller's order, each with its own exact approve pair", () => {
    const stockTp = { tickLower: 54_400, tickUpper: 54_450, amount0DesiredWei: 67n * 10n ** 15n, amount1DesiredWei: 0n, amount0MinWei: 66n * 10n ** 15n, amount1MinWei: 0n };
    const calls = buildSingleSidedMintBatch({ ...nvdab, mints: [stockTp, level] });
    assert.deepEqual(calls.map((call) => [call.to, call.data?.slice(0, 10)]), [
      [NVDAB, SELECTORS.approve], [NVDAB, SELECTORS.approve], [NFPM_56, SELECTORS.mint],
      [USDT, SELECTORS.approve], [USDT, SELECTORS.approve], [NFPM_56, SELECTORS.mint],
    ]);
    assert.equal(calls[1]?.data, approveData(NFPM_56, 67n * 10n ** 15n));
  });

  it("emits no value, no multicall and no NFT-authority call", () => {
    const calls = buildSingleSidedMintBatch({ ...nvdab, mints: [level] });
    for (const call of calls) {
      assert.equal(call.value, undefined);
      for (const selector of FORBIDDEN) assert.ok(!(call.data ?? "").startsWith(selector));
    }
  });
});

describe("buildSingleSidedMintBatch — refusals", () => {
  it("two positive legs, a zero floor on the positive leg, a positive floor on the zero leg", () => {
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, mints: [{ ...level, amount0DesiredWei: 1n, amount0MinWei: 1n }] }), /exactly one leg/);
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, mints: [{ ...level, amount1MinWei: 0n }] }), /carries no minimum/);
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, mints: [{ ...level, amount0MinWei: 1n }] }), /demands a minimum/);
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, mints: [{ ...level, amount1DesiredWei: 0n, amount1MinWei: 0n }] }), /exactly one leg/);
  });

  it("a zero recipient, an unsorted or identical pair, bad ticks, no mint", () => {
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, recipient: "0x0000000000000000000000000000000000000000", mints: [level] }), /zero address/);
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, token0: USDT, token1: NVDAB, mints: [level] }), /pool order/);
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, token1: NVDAB, mints: [level] }), /same address/);
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, mints: [{ ...level, tickUpper: 53_900 }] }), /strictly below/);
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, mints: [] }), /no mint/);
    assert.throws(() => buildSingleSidedMintBatch({ ...nvdab, deadline: 0n, mints: [level] }), /deadline/);
  });
});
