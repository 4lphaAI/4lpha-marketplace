/**
 * The V2 token-to-token builder, and the PIN that keeps Phase 2's builders
 * where they are (QUANT-GRID W1, §5.1).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, getAddress, toFunctionSelector } from "viem";

import { PANCAKE_V2_ROUTER_ABI, ERC20_APPROVE_ABI } from "../src/ops/abis.js";
import {
  APPROVE_SIGNATURE,
  buildPancakeTokenSwap,
  directPath,
  PANCAKE_V2_ROUTER_TOKENS_ABI,
  SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE,
} from "../src/ops/pancakeTokens.js";
import { QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56 } from "../src/quant/config.js";

const WALLET = getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111");

describe("buildPancakeTokenSwap", () => {
  const calls = buildPancakeTokenSwap({
    router: QUANT_ROUTER_56,
    tokenIn: QUANT_U_56,
    tokenOut: QUANT_WBNB_56,
    amountInWei: 10n ** 19n,
    minOutWei: 13_500_000_000_000_000n,
    recipient: WALLET,
    deadline: 1_800_000_601n,
  });

  it("is EXACTLY two calls: approve then swap, in one batch", () => {
    // The Altana account zeroes allowances at the end of the tx that granted
    // them, so approve and swap MUST share one intent — two intents always fail
    // `TRANSFER_FROM_FAILED`. A third call would also change the execution
    // identity the resolver matches on.
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.to, QUANT_U_56);
    assert.equal(calls[1]?.to, QUANT_ROUTER_56);
  });

  it("carries NO value on either leg — neither side touches native", () => {
    for (const call of calls) assert.equal(call.value, undefined);
  });

  it("uses selector 0x38ed1739 for the swap", () => {
    assert.equal(calls[1]?.data?.slice(0, 10), "0x38ed1739");
    assert.equal(
      toFunctionSelector(SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE),
      "0x38ed1739",
    );
  });

  it("encodes the recipient and the deadline the caller supplied", () => {
    const decoded = decodeFunctionData({
      abi: PANCAKE_V2_ROUTER_TOKENS_ABI, data: calls[1]!.data!,
    });
    assert.equal(decoded.functionName, "swapExactTokensForTokens");
    const [amountIn, minOut, path, to, deadline] = decoded.args;
    assert.equal(amountIn, 10n ** 19n);
    assert.equal(minOut, 13_500_000_000_000_000n);
    assert.deepEqual(path, [QUANT_U_56, QUANT_WBNB_56]);
    assert.equal(to, WALLET);
    assert.equal(deadline, 1_800_000_601n);
  });

  it("approves EXACTLY the amount in, never an infinite allowance", () => {
    const decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: calls[0]!.data! });
    assert.equal(decoded.functionName, "approve");
    assert.deepEqual(decoded.args, [QUANT_ROUTER_56, 10n ** 19n]);
  });

  it("is DETERMINISTIC — same inputs, byte-identical calldata", () => {
    const again = buildPancakeTokenSwap({
      router: QUANT_ROUTER_56, tokenIn: QUANT_U_56, tokenOut: QUANT_WBNB_56,
      amountInWei: 10n ** 19n, minOutWei: 13_500_000_000_000_000n,
      recipient: WALLET, deadline: 1_800_000_601n,
    });
    assert.deepEqual(again, calls);
  });

  it("refuses a degenerate swap rather than encoding one", () => {
    const base = {
      router: QUANT_ROUTER_56, tokenIn: QUANT_U_56, tokenOut: QUANT_WBNB_56,
      amountInWei: 1n, minOutWei: 1n, recipient: WALLET, deadline: 1n,
    };
    assert.throws(() => buildPancakeTokenSwap({ ...base, tokenOut: QUANT_U_56 }));
    assert.throws(() => buildPancakeTokenSwap({ ...base, amountInWei: 0n }));
    assert.throws(() => buildPancakeTokenSwap({ ...base, minOutWei: 0n }));
  });

  it("orders a direct path from the POOL's two tokens, never from a guess", () => {
    assert.deepEqual(directPath(QUANT_U_56, QUANT_WBNB_56), [QUANT_U_56, QUANT_WBNB_56]);
    assert.deepEqual(directPath(QUANT_WBNB_56, QUANT_U_56), [QUANT_WBNB_56, QUANT_U_56]);
  });
});

describe("PANCAKE_V2_ROUTER_ABI is untouched", () => {
  it("still has exactly its two native-quoted entries and nothing else", () => {
    // Phase 2's golden-calldata tests pin this constant. The token-to-token
    // signature deliberately lives in its OWN constant so this snapshot cannot
    // move for a caller that does not use it.
    assert.deepEqual(
      PANCAKE_V2_ROUTER_ABI.map((entry) => entry.name),
      [
        "swapExactETHForTokensSupportingFeeOnTransferTokens",
        "swapExactTokensForETHSupportingFeeOnTransferTokens",
      ],
    );
    for (const entry of PANCAKE_V2_ROUTER_ABI) {
      assert.equal(entry.outputs.length, 0);
    }
  });

  it("the new constant has ONE entry, so viem cannot resolve the wrong overload", () => {
    assert.equal(PANCAKE_V2_ROUTER_TOKENS_ABI.length, 1);
    assert.equal(PANCAKE_V2_ROUTER_TOKENS_ABI[0]?.name, "swapExactTokensForTokens");
  });

  it("pins the two canonical signatures the session allowlist must name", () => {
    assert.equal(APPROVE_SIGNATURE, "approve(address,uint256)");
    assert.equal(
      SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE,
      "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    );
  });
});
