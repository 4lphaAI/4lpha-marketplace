/**
 * Golden calldata for every venue builder.
 *
 * The expected hex here is assembled BY HAND from a 4-byte selector literal and
 * 32-byte words, using nothing but string padding. It is deliberately NOT
 * produced by `encodeFunctionData` — a test that encodes with the same function
 * the builder encodes with proves only that the function is deterministic, and
 * would pass just as happily if the ABI fragment named the wrong overload.
 *
 * The selector literals were verified against DEPLOYED BYTECODE on BNB Chain 56
 * (see `src/ops/abis.ts` for the provenance note): each was located in the
 * dispatcher of the live PancakeSwap V2 router and the live Four.Meme
 * TokenManager2 implementation. That is what makes them independent evidence
 * rather than a second copy of our own assumption.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, toFunctionSelector, type Address } from "viem";
import {
  ERC20_APPROVE_ABI,
  FLAP_PORTAL_ABI,
  FOUR_MEME_TOKEN_MANAGER_ABI,
  PANCAKE_V2_ROUTER_ABI,
  PANCAKE_V3_ROUTER_ABI,
} from "../src/ops/abis.js";
import { buildFlapBuy, buildFlapSell } from "../src/ops/flap.js";
import { buildApprove, buildPancakeBuy, buildPancakeSell } from "../src/ops/pancake.js";
import {
  buildPancakeV3Buy,
  buildPancakeV3Sell,
  encodeV3Path,
  isEncodableV3Route,
} from "../src/ops/pancakeV3.js";
import { MAX_ROUTE_HOPS, MAX_ROUTE_POOLS } from "../src/ops/route.js";
import { buildFourMemeBuy, buildFourMemeSell } from "../src/ops/fourmeme.js";
import { FOUR_MEME_HELPER_ABI } from "../src/wallet/abis.js";

/* -------------------------------------------------------------------------- */
/* Independently computed selectors (verified on-chain)                       */
/* -------------------------------------------------------------------------- */

const SELECTORS = {
  swapExactETHForTokensSupportingFeeOnTransferTokens: "0xb6f9de95",
  swapExactTokensForETHSupportingFeeOnTransferTokens: "0x791ac947",
  approve: "0x095ea7b3",
  buyTokenAMAP: "0x87f27655",
  sellToken: "0x06e7b98f",
  // PHASE2.2 R1, located in the dispatcher of the live V3 SwapRouter
  // 0x1b81D678ffb9C0263b24A97847620C99d213eB14 on BNB Chain 56.
  exactInputSingle: "0x414bf389",
  exactInput: "0xc04b8d59",
  multicall: "0xac9650d8",
  refundETH: "0x12210e8a",
  unwrapWETH9: "0x49404b7c",
  // PHASE2.4, located in the dispatcher of the flap Portal's EIP-1967
  // implementation 0x4e360279232b4f9cC36f23c5726dE3f3dE477b0f on BNB Chain 56.
  swapExactInput: "0xef7ec2e7",
  quoteExactInput: "0xfc847c2b",
  getTokenV5: "0x5c4bc504",
} as const;

/**
 * `multicall(uint256,bytes[])` — the SmartRouter's overload, which this router
 * does NOT dispatch (verified: absent from its bytecode). Named so the golden
 * test can assert its ABSENCE rather than merely the other one's presence.
 */
const SMART_ROUTER_MULTICALL = "0x5ae401dc";

const ROUTER = getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E");
const ROUTER_V3 = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const MANAGER = getAddress("0x5c952063c7fc8610FFDB798152D69F0B9550762b");
const PORTAL = getAddress("0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0");
const TOKEN = getAddress("0x00000000000000000000000000000000000000AA");
const WALLET = getAddress("0x00000000000000000000000000000000000000bB");
/** Intermediate hops. SPCXB-shaped: the live graduated case routes through one. */
const HOP_A = getAddress("0x00000000000000000000000000000000000000C1");
const HOP_B = getAddress("0x00000000000000000000000000000000000000C2");

/** A 32-byte ABI word from a bigint. Pure string work; no encoder involved. */
function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/** A 32-byte ABI word from an address: left-padded, lowercase. */
function addressWord(value: Address): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

describe("ABI fragments", () => {
  it("carry at most one entry per function name", () => {
    // PHASE2 R6. Both venues overload their entry points, and viem resolves
    // `functionName` against whichever entry it finds first. A duplicate name
    // here would mean a builder could silently encode the 2-arg `sellToken`,
    // which has NO slippage floor.
    for (const [label, abi] of [
      ["PANCAKE_V2_ROUTER_ABI", PANCAKE_V2_ROUTER_ABI],
      // The one that matters most for this rule: `multicall` is overloaded three
      // ways across Pancake's routers, and viem resolves
      // `functionName: "multicall"` against whichever entry it finds. The wrong
      // overload reverts with EMPTY returndata, which `classifyFailureCode`
      // reports as an opaque provider failure rather than as our coding error.
      ["PANCAKE_V3_ROUTER_ABI", PANCAKE_V3_ROUTER_ABI],
      ["ERC20_APPROVE_ABI", ERC20_APPROVE_ABI],
      ["FOUR_MEME_TOKEN_MANAGER_ABI", FOUR_MEME_TOKEN_MANAGER_ABI],
      // flap overloads too: `swapExactInputV3` takes an extension-bearing
      // struct, and resolving `functionName: "swapExactInput"` against it would
      // encode a shape this phase deliberately does not route.
      ["FLAP_PORTAL_ABI", FLAP_PORTAL_ABI],
    ] as const) {
      const names = abi.map((entry) => entry.name);
      assert.equal(
        new Set(names).size,
        names.length,
        `${label} contains a duplicate function name`,
      );
    }
  });

  it("does not carry the forbidden 2-arg sellToken or the recipient overloads", () => {
    const signatures = FOUR_MEME_TOKEN_MANAGER_ABI.map(
      (entry) => `${entry.name}(${entry.inputs.map((i) => i.type).join(",")})`,
    );
    assert.deepEqual(signatures.toSorted(), [
      "buyTokenAMAP(address,uint256,uint256)",
      "sellToken(uint256,address,uint256,uint256,uint256,address)",
    ]);
  });

  it("pins the TokenManagerHelper3 read signatures to their on-chain selectors", () => {
    // PHASE2.1. The three literals below were computed independently and then
    // LOCATED IN DEPLOYED BYTECODE — the helper proxy
    // 0xF251F83e40a78868FcfA3FA4599Dad6494E46034 forwards to implementation
    // 0x0cc78251cfc0356b2b513a9ed97be1e33ecb43c8, whose dispatcher carries all
    // three. The proxy's own code carries none of them, which is why the check
    // runs against the implementation (and why the PROXY is what we pin).
    const golden: Record<string, string> = {
      "getTokenInfo(address)": "0x1f69565f",
      "tryBuy(address,uint256,uint256)": "0xe21b103a",
      "trySell(address,uint256)": "0xc6f43e8c",
    };
    const signatures = FOUR_MEME_HELPER_ABI.map(
      (entry) => `${entry.name}(${entry.inputs.map((i) => i.type).join(",")})`,
    );
    assert.deepEqual(signatures.toSorted(), Object.keys(golden).toSorted());
    for (const signature of signatures) {
      assert.equal(toFunctionSelector(signature), golden[signature], signature);
    }
    // One entry per name here too: `tryBuy` has no overload we want silently
    // resolved for us either.
    const names = FOUR_MEME_HELPER_ABI.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("pins the flap Portal signatures to their on-chain selectors", () => {
    // PHASE2.4. Computed independently, then LOCATED IN DEPLOYED BYTECODE: the
    // Portal proxy 0xe2cE6ab8…9De0 forwards to implementation
    // 0x4e360279232b4f9cC36f23c5726dE3f3dE477b0f, whose dispatcher carries all
    // three. The struct ARGUMENT is what a selector cannot check, which is why
    // the golden calldata tests below assemble the tuple by hand.
    const golden: Record<string, string> = {
      "swapExactInput((address,address,uint256,uint256,bytes))": "0xef7ec2e7",
      "quoteExactInput((address,address,uint256))": "0xfc847c2b",
      "getTokenV5(address)": "0x5c4bc504",
    };
    const signatures = FLAP_PORTAL_ABI.map(
      (entry) =>
        `${entry.name}(${entry.inputs
          .map((input) =>
            "components" in input
              ? `(${input.components.map((c) => c.type).join(",")})`
              : input.type,
          )
          .join(",")})`,
    );
    assert.deepEqual(signatures.toSorted(), Object.keys(golden).toSorted());
    for (const signature of signatures) {
      assert.equal(toFunctionSelector(signature), golden[signature], signature);
    }
  });

  it("decodes getTokenV5 in the field order the chain returns", () => {
    // TokenStateV5, from the published `IPortalTypes`. A reorder here would put
    // `dexSupplyThresh` where `quoteTokenAddress` belongs and every refusal
    // would be answering about the wrong field while the types still check.
    const state = FLAP_PORTAL_ABI.find((entry) => entry.name === "getTokenV5")
      ?.outputs[0];
    assert.ok(state !== undefined && "components" in state);
    assert.deepEqual(state.components.map((component) => component.name), [
      "status",
      "reserve",
      "circulatingSupply",
      "price",
      "tokenVersion",
      "r",
      "h",
      "k",
      "dexSupplyThresh",
      "quoteTokenAddress",
      "nativeToQuoteSwapEnabled",
      "extensionID",
    ]);
    // Enum-typed fields are declared uint8, not as enums: `Staged` was added to
    // `TokenStatus` after V5 shipped, and a future variant must not turn a
    // decode into a revert.
    assert.equal(state.components[0]?.type, "uint8");
    assert.equal(state.components[4]?.type, "uint8");
  });

  it("declares every helper read as a view, so none can ever be submitted", () => {
    for (const entry of FOUR_MEME_HELPER_ABI) {
      assert.equal(entry.stateMutability, "view", entry.name);
    }
  });

  it("decodes the helper output tuples in the order the chain returns them", () => {
    // A silent field reorder here would be the worst possible bug: `tryBuy`
    // returns eight words and six of them are amounts, so mixing
    // `amountMsgValue` with `amountApproval` would send the wrong value while
    // every type still checks. This asserts the NAMES against their positions.
    const info = FOUR_MEME_HELPER_ABI.find((e) => e.name === "getTokenInfo");
    assert.deepEqual(info?.outputs.map((o) => o.name), [
      "version",
      "tokenManager",
      "quote",
      "lastPrice",
      "tradingFeeRate",
      "minTradingFee",
      "launchTime",
      "offers",
      "maxOffers",
      "funds",
      "maxFunds",
      "liquidityAdded",
    ]);
    const tryBuy = FOUR_MEME_HELPER_ABI.find((e) => e.name === "tryBuy");
    assert.deepEqual(tryBuy?.outputs.map((o) => o.name), [
      "tokenManager",
      "quote",
      "estimatedAmount",
      "estimatedCost",
      "estimatedFee",
      "amountMsgValue",
      "amountApproval",
      "amountFunds",
    ]);
    const trySell = FOUR_MEME_HELPER_ABI.find((e) => e.name === "trySell");
    assert.deepEqual(trySell?.outputs.map((o) => o.name), [
      "tokenManager",
      "quote",
      "funds",
      "fee",
    ]);
  });
});

describe("buildApprove", () => {
  it("encodes approve(spender, amount) exactly", () => {
    const call = buildApprove(TOKEN, ROUTER, 12345n);
    assert.equal(call.to, TOKEN);
    assert.equal(call.value, undefined, "an approve must never carry value");
    assert.equal(
      call.data,
      `${SELECTORS.approve}${addressWord(ROUTER)}${word(12345n)}`,
    );
  });
});

describe("buildPancakeBuy", () => {
  it("encodes one payable swap with the caller's floor and our recipient", () => {
    const calls = buildPancakeBuy({
      router: ROUTER,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 10n ** 18n,
      minOutWei: 777n,
      recipient: WALLET,
      deadline: 1_900_000_120n,
    });

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.to, ROUTER);
    assert.equal(call.value, 10n ** 18n, "the BNB in is the call's value");

    // head: amountOutMin, offset(0x80), to, deadline; tail: len(2), wbnb, token
    const expected =
      SELECTORS.swapExactETHForTokensSupportingFeeOnTransferTokens +
      word(777n) +
      word(0x80n) +
      addressWord(WALLET) +
      word(1_900_000_120n) +
      word(2n) +
      addressWord(WBNB) +
      addressWord(TOKEN);
    assert.equal(call.data, expected);
  });
});

describe("buildPancakeSell", () => {
  it("is exactly [approve(0), approve(amount), swap]", () => {
    const calls = buildPancakeSell({
      router: ROUTER,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 5_000n,
      minOutWei: 42n,
      recipient: WALLET,
      deadline: 1_900_000_120n,
    });

    assert.equal(calls.length, 3);
    const [reset, grant, swap] = calls;
    assert.ok(reset !== undefined && grant !== undefined && swap !== undefined);

    // The zero-reset first: USDT-style tokens revert on a non-zero-to-non-zero
    // approve, which would brick every repeat sell without it.
    assert.equal(reset.to, TOKEN);
    assert.equal(
      reset.data,
      `${SELECTORS.approve}${addressWord(ROUTER)}${word(0n)}`,
    );
    assert.equal(grant.to, TOKEN);
    assert.equal(
      grant.data,
      `${SELECTORS.approve}${addressWord(ROUTER)}${word(5_000n)}`,
      "the allowance is the EXACT amount, never infinite",
    );

    assert.equal(swap.to, ROUTER);
    assert.equal(swap.value, undefined);
    const expected =
      SELECTORS.swapExactTokensForETHSupportingFeeOnTransferTokens +
      word(5_000n) +
      word(42n) +
      word(0xa0n) +
      addressWord(WALLET) +
      word(1_900_000_120n) +
      word(2n) +
      addressWord(TOKEN) +
      addressWord(WBNB);
    assert.equal(swap.data, expected);
  });

  it("never encodes an infinite allowance", () => {
    const calls = buildPancakeSell({
      router: ROUTER,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 1n,
      minOutWei: 1n,
      recipient: WALLET,
      deadline: 1n,
    });
    const maxUint = "f".repeat(64);
    for (const call of calls) {
      assert.ok(
        call.data === undefined || !call.data.toLowerCase().includes(maxUint),
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* V2 multi-hop (PHASE2.2 scope item 2)                                       */
/* -------------------------------------------------------------------------- */

describe("pancake V2 with caller-supplied hops", () => {
  it("buys along [WBNB, ...hops, token]", () => {
    const calls = buildPancakeBuy({
      router: ROUTER,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 10n ** 18n,
      minOutWei: 777n,
      recipient: WALLET,
      deadline: 1_900_000_120n,
      hops: [HOP_A],
    });
    const expected =
      SELECTORS.swapExactETHForTokensSupportingFeeOnTransferTokens +
      word(777n) +
      word(0x80n) +
      addressWord(WALLET) +
      word(1_900_000_120n) +
      word(3n) +
      addressWord(WBNB) +
      addressWord(HOP_A) +
      addressWord(TOKEN);
    assert.equal(calls[0]?.data, expected);
  });

  it("sells along the EXACT REVERSE of the buy path", () => {
    // The live motivating case: a graduated Four.Meme token whose only
    // liquidity is a V2 pair against a bStock quote token. A caller supplies the
    // same hops for both sides; a builder that forgot to reverse would route
    // through a pool that may not exist. TWO hops, so the reversal is
    // observable — one hop reverses to itself and proves nothing.
    const hops = [HOP_A, HOP_B] as const;
    const sell = buildPancakeSell({
      router: ROUTER,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 5_000n,
      minOutWei: 42n,
      recipient: WALLET,
      deadline: 1_900_000_120n,
      hops,
    });
    const expected =
      SELECTORS.swapExactTokensForETHSupportingFeeOnTransferTokens +
      word(5_000n) +
      word(42n) +
      word(0xa0n) +
      addressWord(WALLET) +
      word(1_900_000_120n) +
      word(4n) +
      addressWord(TOKEN) +
      addressWord(HOP_B) +
      addressWord(HOP_A) +
      addressWord(WBNB);
    assert.equal(sell[2]?.data, expected);
    // And the caller's array was not mutated on the way through.
    assert.deepEqual([...hops], [HOP_A, HOP_B]);
  });

  it("keeps the direct pair when no hops are supplied", () => {
    const withoutField = buildPancakeBuy({
      router: ROUTER,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 1n,
      minOutWei: 1n,
      recipient: WALLET,
      deadline: 1n,
    });
    const withEmpty = buildPancakeBuy({
      router: ROUTER,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 1n,
      minOutWei: 1n,
      recipient: WALLET,
      deadline: 1n,
      hops: [],
    });
    assert.equal(withoutField[0]?.data, withEmpty[0]?.data);
    assert.match(withoutField[0]?.data ?? "", new RegExp(`${word(2n)}${addressWord(WBNB)}${addressWord(TOKEN)}$`));
  });
});

/* -------------------------------------------------------------------------- */
/* V3 (PHASE2.2 R1, R2, R4, R5, R12)                                          */
/* -------------------------------------------------------------------------- */

/**
 * ABI-encode `multicall(bytes[])`'s payload for two inner calls, BY HAND.
 *
 * Heads first — the offset to the array, its length, then one offset per
 * element measured from the start of the array's data area — then the elements,
 * each a length word plus right-padded bytes. Assembled with string arithmetic
 * only, so it is independent evidence rather than a second run of the encoder
 * under test.
 */
function multicallData(first: string, second: string): string {
  const element = (hex: string): string =>
    word(BigInt(hex.length / 2)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  const firstElement = element(first);
  const secondOffset = 0x40 + firstElement.length / 2;
  return (
    SELECTORS.multicall +
    word(0x20n) +
    word(2n) +
    word(0x40n) +
    word(BigInt(secondOffset)) +
    firstElement +
    element(second)
  );
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

/** `exactInput` calldata, by hand. The tuple is dynamic because `path` is. */
function exactInputData(input: {
  readonly path: string;
  readonly recipient: Address;
  readonly deadline: bigint;
  readonly amountIn: bigint;
  readonly minOut: bigint;
}): string {
  const pathBytes = BigInt(input.path.length / 2);
  return (
    SELECTORS.exactInput.slice(2) +
    word(0x20n) + // offset to the tuple
    word(0xa0n) + // offset to `path`, from the start of the tuple
    addressWord(input.recipient) +
    word(input.deadline) +
    word(input.amountIn) +
    word(input.minOut) +
    word(pathBytes) +
    input.path.padEnd(Math.ceil(input.path.length / 64) * 64, "0")
  );
}

describe("encodeV3Path", () => {
  it("packs token | uint24 fee | token, big-endian, 43 bytes for one pool", () => {
    const packed = encodeV3Path([WBNB, TOKEN], [2_500]);
    assert.equal(
      packed,
      `0x${WBNB.slice(2).toLowerCase()}0009c4${TOKEN.slice(2).toLowerCase()}`,
    );
    assert.equal((packed.length - 2) / 2, 43);
  });

  it("packs two pools as 66 bytes, keeping each tier next to its own pool", () => {
    const packed = encodeV3Path([WBNB, HOP_A, TOKEN], [500, 10_000]);
    assert.equal(
      packed,
      `0x${WBNB.slice(2).toLowerCase()}0001f4${HOP_A.slice(2).toLowerCase()}002710${TOKEN.slice(2).toLowerCase()}`,
    );
    assert.equal((packed.length - 2) / 2, 66);
  });

  it("refuses a path with the wrong number of tiers", () => {
    assert.throws(() => encodeV3Path([WBNB, TOKEN], [500, 2_500]), /one fee tier/);
    assert.throws(() => encodeV3Path([WBNB, HOP_A, TOKEN], [500]), /one fee tier/);
  });

  it("bounds a route at MAX_ROUTE_HOPS hops and one tier per pool", () => {
    assert.equal(MAX_ROUTE_POOLS, MAX_ROUTE_HOPS + 1);
    assert.ok(isEncodableV3Route({ hops: [HOP_A], fees: [500, 2_500] }));
    assert.ok(!isEncodableV3Route({ hops: [HOP_A], fees: [500] }));
    assert.ok(
      !isEncodableV3Route({
        hops: [HOP_A, HOP_B, WALLET],
        fees: [100, 500, 2_500, 10_000],
      }),
    );
  });
});

describe("buildPancakeV3Buy", () => {
  it("wraps exactInputSingle + refundETH in multicall(bytes[]), value = amountIn", () => {
    const calls = buildPancakeV3Buy({
      router: ROUTER_V3,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 10n ** 18n,
      minOutWei: 777n,
      recipient: WALLET,
      deadline: 1_900_000_120n,
      route: { hops: [], fees: [2_500] },
    });

    assert.equal(calls.length, 1, "the whole V3 interaction is ONE call");
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.to, ROUTER_V3);
    assert.equal(call.value, 10n ** 18n, "value is EXACTLY amountIn");

    const inner = exactInputSingleData({
      tokenIn: WBNB,
      tokenOut: TOKEN,
      fee: 2_500n,
      recipient: WALLET,
      deadline: 1_900_000_120n,
      amountIn: 10n ** 18n,
      minOut: 777n,
    });
    assert.equal(call.data, multicallData(inner, SELECTORS.refundETH.slice(2)));
    // The overload actually encoded is the one this router dispatches.
    assert.ok(call.data?.startsWith(SELECTORS.multicall));
    assert.ok(!call.data?.startsWith(SMART_ROUTER_MULTICALL));
  });

  it("uses exactInput — never a 1-pool exactInput — once there is a hop", () => {
    // PHASE2.2 R12: one request must have exactly ONE possible calldata, or the
    // paramsHash-to-callsHash relation stops being deterministic.
    const single = buildPancakeV3Buy({
      router: ROUTER_V3,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 5n,
      minOutWei: 1n,
      recipient: WALLET,
      deadline: 9n,
      route: { hops: [], fees: [500] },
    });
    assert.ok(single[0]?.data?.includes(SELECTORS.exactInputSingle.slice(2)));
    assert.ok(!single[0]?.data?.includes(SELECTORS.exactInput.slice(2)));

    const multi = buildPancakeV3Buy({
      router: ROUTER_V3,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 10n ** 18n,
      minOutWei: 777n,
      recipient: WALLET,
      deadline: 1_900_000_120n,
      route: { hops: [HOP_A], fees: [500, 10_000] },
    });
    const inner = exactInputData({
      path: `${WBNB.slice(2).toLowerCase()}0001f4${HOP_A.slice(2).toLowerCase()}002710${TOKEN.slice(2).toLowerCase()}`,
      recipient: WALLET,
      deadline: 1_900_000_120n,
      amountIn: 10n ** 18n,
      minOut: 777n,
    });
    assert.equal(multi[0]?.data, multicallData(inner, SELECTORS.refundETH.slice(2)));
  });
});

describe("buildPancakeV3Sell", () => {
  const sellCalls = (hops: readonly Address[], fees: readonly (100 | 500 | 2500 | 10000)[]) =>
    buildPancakeV3Sell({
      router: ROUTER_V3,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 5_000n,
      minOutWei: 42n,
      recipient: WALLET,
      deadline: 1_900_000_120n,
      route: { hops, fees },
    });

  it("is exactly [approve(0), approve(amount), multicall] and carries no value", () => {
    const calls = sellCalls([], [2_500]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.to), [TOKEN, TOKEN, ROUTER_V3]);
    assert.equal(
      calls[0]?.data,
      `${SELECTORS.approve}${addressWord(ROUTER_V3)}${word(0n)}`,
    );
    assert.equal(
      calls[1]?.data,
      `${SELECTORS.approve}${addressWord(ROUTER_V3)}${word(5_000n)}`,
    );
    for (const c of calls) {
      assert.equal(c.value, undefined, "a sell sends no native value on any call");
    }
  });

  it("keeps the swap output in the ROUTER and unwraps to the wallet", () => {
    // PHASE2.2 R4, VERIFIED: address(1) and address(2) are LITERAL recipients on
    // this router, not sentinels — calldata using one passes every offline test
    // and permanently strands the sell on mainnet. The recipient of the retained
    // leg is the router's own address, written out.
    const calls = sellCalls([], [2_500]);
    const swap = exactInputSingleData({
      tokenIn: TOKEN,
      tokenOut: WBNB,
      fee: 2_500n,
      recipient: ROUTER_V3,
      deadline: 1_900_000_120n,
      amountIn: 5_000n,
      minOut: 42n,
    });
    const unwrap =
      SELECTORS.unwrapWETH9.slice(2) + word(42n) + addressWord(WALLET);
    assert.equal(calls[2]?.data, multicallData(swap, unwrap));

    // And read the recipient slot back out of the inner call directly, rather
    // than trusting the whole-blob comparison to have covered it.
    const data = calls[2]?.data ?? "";
    const start = data.indexOf(SELECTORS.exactInputSingle.slice(2));
    const recipientWord = data.slice(start + 8 + 64 * 3, start + 8 + 64 * 4);
    assert.equal(recipientWord, addressWord(ROUTER_V3));
    for (const sentinel of [0n, 1n, 2n]) {
      assert.notEqual(
        recipientWord,
        word(sentinel),
        `address(${sentinel}) must never be the retained leg's recipient`,
      );
    }
  });

  it("reverses the hops AND the fee tiers", () => {
    // PHASE2.2 R2, the whole point of using two DIFFERENT tiers: buy is
    // WBNB -500- A -10000- token, so the sell must be token -10000- A -500- WBNB.
    // Reversing only the addresses yields a path that either reverts unhelpfully
    // or executes through a real but thin pool at the wrong tier.
    const calls = sellCalls([HOP_A], [500, 10_000]);
    const swap = exactInputData({
      path: `${TOKEN.slice(2).toLowerCase()}002710${HOP_A.slice(2).toLowerCase()}0001f4${WBNB.slice(2).toLowerCase()}`,
      recipient: ROUTER_V3,
      deadline: 1_900_000_120n,
      amountIn: 5_000n,
      minOut: 42n,
    });
    const unwrap =
      SELECTORS.unwrapWETH9.slice(2) + word(42n) + addressWord(WALLET);
    assert.equal(calls[2]?.data, multicallData(swap, unwrap));
  });

  it("does not mutate the caller's route arrays", () => {
    const hops: readonly Address[] = [HOP_A, HOP_B];
    const fees = [100, 500, 2_500] as const;
    buildPancakeV3Sell({
      router: ROUTER_V3,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 1n,
      minOutWei: 1n,
      recipient: WALLET,
      deadline: 1n,
      route: { hops, fees },
    });
    assert.deepEqual([...hops], [HOP_A, HOP_B]);
    assert.deepEqual([...fees], [100, 500, 2_500]);
  });
});

describe("V3 slippage discipline", () => {
  it("puts minOutWei in amountOutMinimum on EVERY leg, and in the unwrap floor", () => {
    // PHASE2.2 R5. `unwrapWETH9` checks its floor against the router's ENTIRE
    // WBNB balance, so it can pass on stray balance alone; `amountOutMinimum` is
    // the only floor that measures THIS swap. Both carry the caller's number.
    const floor = 0xfeedn;
    const buy = buildPancakeV3Buy({
      router: ROUTER_V3,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 10n,
      minOutWei: floor,
      recipient: WALLET,
      deadline: 1n,
      route: { hops: [HOP_A], fees: [500, 2_500] },
    });
    const sell = buildPancakeV3Sell({
      router: ROUTER_V3,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 10n,
      minOutWei: floor,
      recipient: WALLET,
      deadline: 1n,
      route: { hops: [HOP_A], fees: [500, 2_500] },
    });
    // Twice in the sell: once as amountOutMinimum, once as the unwrap minimum.
    const occurrences = (data: string): number =>
      data.split(word(floor)).length - 1;
    assert.equal(occurrences(buy[0]?.data ?? ""), 1);
    assert.equal(occurrences(sell[2]?.data ?? ""), 2);
  });

  it("never encodes a non-zero sqrtPriceLimitX96 on exactInputSingle", () => {
    // Worded for `exactInputSingle` only: `ExactInputParams` has no such field.
    for (const fee of [100, 500, 2_500, 10_000] as const) {
      const calls = buildPancakeV3Buy({
        router: ROUTER_V3,
        wbnb: WBNB,
        token: TOKEN,
        amountInWei: 3n,
        minOutWei: 2n,
        recipient: WALLET,
        deadline: 1n,
        route: { hops: [], fees: [fee] },
      });
      const data = calls[0]?.data ?? "";
      const start = data.indexOf(SELECTORS.exactInputSingle.slice(2));
      assert.ok(start > 0);
      // The eighth argument word of the inner call.
      const limit = data.slice(start + 8 + 64 * 7, start + 8 + 64 * 8);
      assert.equal(limit, word(0n));
    }
  });

  it("never encodes an infinite allowance", () => {
    const calls = buildPancakeV3Sell({
      router: ROUTER_V3,
      wbnb: WBNB,
      token: TOKEN,
      amountInWei: 1n,
      minOutWei: 1n,
      recipient: WALLET,
      deadline: 1n,
      route: { hops: [], fees: [100] },
    });
    const maxUint = "f".repeat(64);
    for (const call of calls) {
      assert.ok(call.data === undefined || !call.data.toLowerCase().includes(maxUint));
    }
  });
});

describe("the Four.Meme fee arithmetic is gone", () => {
  it("no longer exists in src/ops/fourmeme.ts", async () => {
    // PHASE2.1: `msg.value` comes from `TokenManagerHelper3.tryBuy`, which
    // computes it against the venue's own fee edge cases. A second local
    // implementation of a formula we do not own is a second thing to be wrong,
    // so it was deleted rather than kept "as a cross-check".
    const mod: Record<string, unknown> = await import("../src/ops/fourmeme.js");
    assert.equal(mod["fourMemeBuyValue"], undefined);
    assert.deepEqual(Object.keys(mod).toSorted(), [
      "buildFourMemeBuy",
      "buildFourMemeSell",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* flap.sh (PHASE2.4)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `swapExactInput((address,address,uint256,uint256,bytes))` takes a struct with
 * a DYNAMIC tail, so its encoding is head-then-tail rather than five flat
 * words: one offset word to the tuple, then the four static fields, then the
 * offset to `permitData`, then its length. Hand-assembling it is the point —
 * this is the shape that would silently encode a WRONG FIELD ORDER, and a field
 * order is the one thing a selector cannot prove (it is what rejected PHASE2.2).
 */
function flapSwapCalldata(input: {
  readonly inputToken: Address | "native";
  readonly outputToken: Address | "native";
  readonly inputAmount: bigint;
  readonly minOutputAmount: bigint;
}): string {
  const native = "0".repeat(64);
  const inputToken =
    input.inputToken === "native" ? native : addressWord(input.inputToken);
  const outputToken =
    input.outputToken === "native" ? native : addressWord(input.outputToken);
  return (
    SELECTORS.swapExactInput +
    word(32n) + // offset to the tuple
    inputToken +
    outputToken +
    word(input.inputAmount) +
    word(input.minOutputAmount) +
    word(160n) + // offset to `permitData`, relative to the tuple's start
    word(0n) // `permitData.length` — ALWAYS zero. See `src/ops/flap.ts`.
  );
}

describe("buildFlapBuy", () => {
  it("is ONE call whose value equals inputAmount, native in", () => {
    const calls = buildFlapBuy({
      portal: PORTAL,
      token: TOKEN,
      amountInWei: 19_000_000_000_000n,
      minOutWei: 4_242n,
    });

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.to, PORTAL);
    // Confirmed on chain twice: a live buy sends exactly this, and a simulated
    // buy at `value == 0` reverts 0x3ebbc337.
    assert.equal(call.value, 19_000_000_000_000n);
    assert.equal(
      call.data,
      flapSwapCalldata({
        inputToken: "native",
        outputToken: TOKEN,
        inputAmount: 19_000_000_000_000n,
        minOutputAmount: 4_242n,
      }),
    );
  });
});

describe("buildFlapSell", () => {
  it("is approve(0), approve(amount), swap — with value 0 and empty permitData", () => {
    const calls = buildFlapSell({
      portal: PORTAL,
      token: TOKEN,
      amountInWei: 7_000n,
      minOutWei: 88n,
    });

    assert.equal(calls.length, 3);
    const [reset, grant, sell] = calls;
    assert.ok(reset !== undefined && grant !== undefined && sell !== undefined);
    // The USDT-style zero reset, same as every other sell builder here.
    assert.equal(
      reset.data,
      `${SELECTORS.approve}${addressWord(PORTAL)}${word(0n)}`,
    );
    // EXACT, never max: an infinite allowance is metered at type(uint256).max
    // against the token's spend cap and exhausts any finite one in one call.
    assert.equal(
      grant.data,
      `${SELECTORS.approve}${addressWord(PORTAL)}${word(7_000n)}`,
    );

    assert.equal(sell.to, PORTAL);
    assert.equal(sell.value, undefined, "a sell sends no native");
    assert.equal(
      sell.data,
      flapSwapCalldata({
        inputToken: TOKEN,
        outputToken: "native",
        inputAmount: 7_000n,
        minOutputAmount: 88n,
      }),
    );
  });

  it("never emits permitData, on either side", () => {
    // ERC-2612 `permit` recovers against the HOLDER's key; the only signer at
    // execute time is the SESSION key, which is a different key, so a permit
    // signed there recovers to the wrong address and the call fails.
    const emptyBytesTail = word(160n) + word(0n);
    for (const call of [
      ...buildFlapBuy({ portal: PORTAL, token: TOKEN, amountInWei: 1n, minOutWei: 1n }),
      ...buildFlapSell({ portal: PORTAL, token: TOKEN, amountInWei: 1n, minOutWei: 1n }),
    ]) {
      if (!call.data?.startsWith(SELECTORS.swapExactInput)) continue;
      assert.ok(
        call.data.endsWith(emptyBytesTail),
        "permitData must be a zero-length bytes",
      );
    }
  });
});

describe("buildFourMemeBuy", () => {
  it("encodes buyTokenAMAP(token, funds, minAmount) with the gross as value", () => {
    const calls = buildFourMemeBuy({
      manager: MANAGER,
      token: TOKEN,
      fundsWei: 10n ** 18n,
      minTokensOut: 123n,
      msgValueWei: 10n ** 18n + 10n ** 16n,
    });

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.to, MANAGER);
    assert.equal(
      call.value,
      10n ** 18n + 10n ** 16n,
      "msg.value is funds + the venue trading fee, not funds",
    );
    assert.equal(
      call.data,
      SELECTORS.buyTokenAMAP +
        addressWord(TOKEN) +
        word(10n ** 18n) +
        word(123n),
    );
  });
});

describe("buildFourMemeSell", () => {
  it("encodes the six-arg sellToken with the slippage floor", () => {
    const calls = buildFourMemeSell({
      manager: MANAGER,
      token: TOKEN,
      amountWei: 7_000n,
      minFundsOut: 88n,
    });

    assert.equal(calls.length, 3);
    const [reset, grant, sell] = calls;
    assert.ok(reset !== undefined && grant !== undefined && sell !== undefined);
    assert.equal(
      reset.data,
      `${SELECTORS.approve}${addressWord(MANAGER)}${word(0n)}`,
    );
    assert.equal(
      grant.data,
      `${SELECTORS.approve}${addressWord(MANAGER)}${word(7_000n)}`,
    );

    assert.equal(sell.to, MANAGER);
    assert.equal(sell.value, undefined);
    // origin=0, token, amount, minFunds, feeRate=0, feeRecipient=0x0.
    assert.equal(
      sell.data,
      SELECTORS.sellToken +
        word(0n) +
        addressWord(TOKEN) +
        word(7_000n) +
        word(88n) +
        word(0n) +
        word(0n),
    );
  });

  it("puts minOutWei in the minFunds slot, not somewhere the chain ignores", () => {
    // The whole reason the 2-arg overload is forbidden: it satisfies
    // MIN_OUT_REQUIRED at the wire and discards the floor before the chain.
    const calls = buildFourMemeSell({
      manager: MANAGER,
      token: TOKEN,
      amountWei: 1n,
      minFundsOut: 0xdeadn,
    });
    const sell = calls[2];
    assert.ok(sell?.data !== undefined);
    // Fourth argument word (offset 4 bytes selector + 3 words).
    const argWord = sell.data.slice(2 + 8 + 64 * 3, 2 + 8 + 64 * 4);
    assert.equal(argWord, word(0xdeadn));
  });
});
