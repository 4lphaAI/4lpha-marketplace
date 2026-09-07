/**
 * Golden calldata for the NFPM builders (PHASE3 R2).
 *
 * Same discipline as `test/ops.builders.test.ts`: the expected hex is
 * assembled BY HAND from a 4-byte selector literal and 32-byte words, using
 * nothing but string padding — never `encodeFunctionData`, which would only
 * prove the encoder is deterministic. Every NFPM struct here is STATIC (no
 * dynamic members), so the tuple encodes as inline head words and hand
 * assembly is exact.
 *
 * The selector literals were verified against DEPLOYED BYTECODE on BNB Chain
 * 56 (PHASE3-REVIEW.md, on-chain facts): each was recomputed locally and
 * located in the dispatcher of the live NFPM
 * 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAddress,
  toFunctionSelector,
  toFunctionSignature,
  type Address,
} from "viem";
import { NONFUNGIBLE_POSITION_MANAGER_ABI } from "../src/ops/abis.js";
import {
  MAX_UINT128,
  NFPM_56,
  buildBurn,
  buildCollectToWallet,
  buildLpIncreaseBatch,
  buildLpMintWbnbBatch,
  buildLpOpenBatch,
  buildLpZapOutBatch,
  buildLpZapOutKeepWbnbBatch,
} from "../src/ops/nfpm.js";

/* -------------------------------------------------------------------------- */
/* Independently computed selectors (located in deployed bytecode)             */
/* -------------------------------------------------------------------------- */

const SELECTORS = {
  mint: "0x88316456",
  increaseLiquidity: "0x219f5d17",
  decreaseLiquidity: "0x0c49ccbe",
  collect: "0xfc6f7865",
  burn: "0x42966c68",
  refundETH: "0x12210e8a",
  unwrapWETH9: "0x49404b7c",
  sweepToken: "0xdf2ab5bb",
  approve: "0x095ea7b3",
} as const;

/**
 * PRESENT in the deployed NFPM dispatcher and deliberately unreachable from
 * here: the Multicall entry and the NFT-authority surface (PHASE3 Rev2 item
 * 3). Named so the tests can assert their ABSENCE from the fragment and from
 * every builder's output.
 */
const FORBIDDEN_ON_NFPM = {
  multicall: "0xac9650d8",
  setApprovalForAll: "0xa22cb465",
  approve721: "0x095ea7b3",
  safeTransferFrom: "0x42842e0e",
  transferFrom: "0x23b872dd",
} as const;

const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
/** Sorts BELOW WBNB: the WBNB-is-token1 orientation. */
const TOKEN = getAddress("0x00000000000000000000000000000000000000AA");
/** Sorts ABOVE WBNB: the WBNB-is-token0 orientation. */
const TOKEN_HI = getAddress("0xCcCCcCcCcCCcCCCcCcCcCCcCcCCCcCcCcCcCCcCC");
const WALLET = getAddress("0x00000000000000000000000000000000000000bB");

const DEADLINE = 1_900_000_120n;

/** A 32-byte ABI word from a bigint. Pure string work; no encoder involved. */
function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/** A 32-byte word from a SIGNED value (int24 ticks): two's complement. */
function signedWord(value: bigint): string {
  return word(value < 0n ? (1n << 256n) + value : value);
}

/** A 32-byte ABI word from an address: left-padded, lowercase. */
function addressWord(value: Address): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

/* -------------------------------------------------------------------------- */
/* Baseline params, spread-overridden per test                                 */
/* -------------------------------------------------------------------------- */

const openParams = {
  nfpm: NFPM,
  token0: TOKEN,
  token1: WBNB,
  wbnb: WBNB,
  fee: 2_500,
  tickLower: -1_000,
  tickUpper: 1_000,
  amount0DesiredWei: 5_000n, // TOKEN leg
  amount1DesiredWei: 10n ** 18n, // WBNB leg
  amount0MinWei: 4_900n,
  amount1MinWei: 990_000_000_000_000_000n,
  recipient: WALLET,
  deadline: DEADLINE,
} as const;

const zapOutParams = {
  nfpm: NFPM,
  tokenId: 42n,
  token0: TOKEN,
  token1: WBNB,
  wbnb: WBNB,
  liquidity: 777_000n,
  amount0MinWei: 100n, // TOKEN leg
  amount1MinWei: 200n, // WBNB leg
  deadline: DEADLINE,
  wallet: WALLET,
} as const;

const increaseParams = {
  nfpm: NFPM,
  tokenId: 42n,
  token0: TOKEN,
  token1: WBNB,
  wbnb: WBNB,
  amount0DesiredWei: 5_000n, // TOKEN leg
  amount1DesiredWei: 10n ** 18n, // WBNB leg
  amount0MinWei: 4_900n,
  amount1MinWei: 990_000_000_000_000_000n,
  deadline: DEADLINE,
} as const;

/** The hand-assembled mint calldata shared by the open and WBNB-mint goldens. */
const MINT_DATA =
  SELECTORS.mint +
  addressWord(TOKEN) +
  addressWord(WBNB) +
  word(2_500n) +
  signedWord(-1_000n) +
  signedWord(1_000n) +
  word(5_000n) +
  word(10n ** 18n) +
  word(4_900n) +
  word(990_000_000_000_000_000n) +
  addressWord(WALLET) +
  word(DEADLINE);

const DECREASE_DATA =
  SELECTORS.decreaseLiquidity +
  word(42n) +
  word(777_000n) +
  word(100n) +
  word(200n) +
  word(DEADLINE);

describe("NONFUNGIBLE_POSITION_MANAGER_ABI", () => {
  it("pins every entry to its bytecode-verified selector, one entry per name", () => {
    const golden: Record<string, string> = {
      mint: SELECTORS.mint,
      increaseLiquidity: SELECTORS.increaseLiquidity,
      decreaseLiquidity: SELECTORS.decreaseLiquidity,
      collect: SELECTORS.collect,
      burn: SELECTORS.burn,
      refundETH: SELECTORS.refundETH,
      unwrapWETH9: SELECTORS.unwrapWETH9,
      sweepToken: SELECTORS.sweepToken,
    };
    assert.equal(NONFUNGIBLE_POSITION_MANAGER_ABI.length, 8);
    const names = NONFUNGIBLE_POSITION_MANAGER_ABI.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length, "duplicate function name");
    for (const entry of NONFUNGIBLE_POSITION_MANAGER_ABI) {
      const expected = golden[entry.name];
      assert.ok(expected !== undefined, `${entry.name} is not a granted entry point`);
      assert.equal(
        toFunctionSelector(toFunctionSignature(entry)),
        expected,
        `${entry.name} selects the wrong function`,
      );
    }
  });

  it("cannot encode the Multicall or NFT-authority surface at all", () => {
    // PHASE3 Rev2 item 3: the omission is structural — viem throws on a
    // functionName the fragment does not carry, so no builder (present or
    // future) can emit these against this ABI.
    const names = new Set<string>(
      NONFUNGIBLE_POSITION_MANAGER_ABI.map((entry) => entry.name),
    );
    for (const forbidden of [
      "multicall",
      "approve",
      "setApprovalForAll",
      "safeTransferFrom",
      "transferFrom",
    ]) {
      assert.ok(!names.has(forbidden), `${forbidden} must not be encodable`);
    }
  });

  it("pins the NFPM_56 constant to the verified deployment", () => {
    assert.equal(NFPM_56, NFPM);
  });
});

describe("buildLpOpenBatch", () => {
  it("is exactly [mint{value}, refundETH], value = the WBNB leg's desired", () => {
    const calls = buildLpOpenBatch(openParams);
    assert.equal(calls.length, 2);
    const [mint, refund] = calls;
    assert.ok(mint !== undefined && refund !== undefined);

    assert.equal(mint.to, NFPM);
    assert.equal(mint.value, 10n ** 18n, "value is EXACTLY the WBNB leg's amountDesired");
    assert.equal(mint.data, MINT_DATA);

    assert.equal(refund.to, NFPM);
    assert.equal(refund.value, undefined, "refundETH attaches no value");
    assert.equal(refund.data, SELECTORS.refundETH);
  });

  it("takes the value from leg 0 when WBNB sorts as token0", () => {
    const calls = buildLpOpenBatch({
      ...openParams,
      token0: WBNB,
      token1: TOKEN_HI,
      amount0DesiredWei: 10n ** 18n, // WBNB leg is now leg 0
      amount1DesiredWei: 5_000n,
      amount0MinWei: 990_000_000_000_000_000n,
      amount1MinWei: 4_900n,
    });
    assert.equal(calls[0]?.value, 10n ** 18n);
    assert.equal(
      calls[0]?.data,
      SELECTORS.mint +
        addressWord(WBNB) +
        addressWord(TOKEN_HI) +
        word(2_500n) +
        signedWord(-1_000n) +
        signedWord(1_000n) +
        word(10n ** 18n) +
        word(5_000n) +
        word(990_000_000_000_000_000n) +
        word(4_900n) +
        addressWord(WALLET) +
        word(DEADLINE),
    );
  });

  it("refuses a zero-WBNB-leg open, unsorted or identical legs, and a non-WBNB pool", () => {
    assert.throws(
      () =>
        buildLpOpenBatch({
          ...openParams,
          amount1DesiredWei: 0n,
          amount1MinWei: 0n,
        }),
      /WBNB leg deposits nothing/,
    );
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, token0: WBNB, token1: TOKEN }),
      /not in pool order/,
    );
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, token0: WBNB, token1: WBNB }),
      /same address/,
    );
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, wbnb: TOKEN_HI }),
      /neither leg is WBNB/,
    );
  });

  it("refuses negative amounts, missing floors, floors on empty legs, and bad ticks", () => {
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, amount0DesiredWei: -1n }),
      /negative/,
    );
    // R10 restated at the builder boundary: a depositing leg with a zero floor
    // is a forgotten derivation, not a default.
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, amount0MinWei: 0n }),
      /no minimum/,
    );
    assert.throws(
      () =>
        buildLpOpenBatch({
          ...openParams,
          amount0DesiredWei: 0n,
          amount0MinWei: 1n,
        }),
      /can only revert/,
    );
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, tickLower: 1_000, tickUpper: -1_000 }),
      /strictly below/,
    );
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, tickLower: -900_000 }),
      /within/,
    );
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, tickLower: 0.5 }),
      /integers/,
    );
    assert.throws(() => buildLpOpenBatch({ ...openParams, fee: 0 }), /uint24/);
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, fee: 0x1_000_000 }),
      /uint24/,
    );
    assert.throws(
      () => buildLpOpenBatch({ ...openParams, deadline: 0n }),
      /deadline/,
    );
    assert.throws(
      () =>
        buildLpOpenBatch({
          ...openParams,
          recipient: "0x0000000000000000000000000000000000000000",
        }),
      /zero address/,
    );
  });
});

describe("buildLpZapOutBatch (protect: unwrap to native)", () => {
  it("is [decrease, collect(recipient = THE NFPM), unwrap(wallet), sweep(wallet)]", () => {
    const calls = buildLpZapOutBatch(zapOutParams);
    assert.equal(calls.length, 4);
    assert.deepEqual(
      calls.map((c) => c.to),
      [NFPM, NFPM, NFPM, NFPM],
    );

    assert.equal(calls[0]?.data, DECREASE_DATA);

    // Rev2 item 6: the collect recipient is the NFPM's OWN LITERAL ADDRESS —
    // never address(0), which the periphery maps to address(this). Collect
    // amounts are uint128-max: principal PLUS accrued fees, "everything owed".
    assert.equal(
      calls[1]?.data,
      SELECTORS.collect +
        word(42n) +
        addressWord(NFPM) +
        word(MAX_UINT128) +
        word(MAX_UINT128),
    );
    const recipientWord = calls[1]?.data?.slice(10 + 64, 10 + 128) ?? "";
    assert.equal(recipientWord, addressWord(NFPM));
    assert.notEqual(recipientWord, word(0n), "address(0) is the keep-here sentinel");

    // The WBNB-leg floor rides the unwrap, the TOKEN leg and its floor the
    // sweep, both to the row's wallet.
    assert.equal(
      calls[2]?.data,
      SELECTORS.unwrapWETH9 + word(200n) + addressWord(WALLET),
    );
    assert.equal(
      calls[3]?.data,
      SELECTORS.sweepToken + addressWord(TOKEN) + word(100n) + addressWord(WALLET),
    );
  });

  it("routes the per-leg floors correctly when WBNB sorts as token0", () => {
    const calls = buildLpZapOutBatch({
      ...zapOutParams,
      token0: WBNB,
      token1: TOKEN_HI,
      amount0MinWei: 200n, // WBNB leg
      amount1MinWei: 100n, // TOKEN leg
    });
    assert.equal(
      calls[2]?.data,
      SELECTORS.unwrapWETH9 + word(200n) + addressWord(WALLET),
    );
    assert.equal(
      calls[3]?.data,
      SELECTORS.sweepToken + addressWord(TOKEN_HI) + word(100n) + addressWord(WALLET),
    );
  });

  it("allows ONE zero floor (out-of-range positions hold one leg), never both", () => {
    // An out-of-range exit legitimately returns a single leg; its empty side
    // floors at zero. BOTH zero is a forgotten R10 derivation.
    const oneSided = buildLpZapOutBatch({ ...zapOutParams, amount0MinWei: 0n });
    assert.equal(oneSided.length, 4);
    assert.throws(
      () =>
        buildLpZapOutBatch({
          ...zapOutParams,
          amount0MinWei: 0n,
          amount1MinWei: 0n,
        }),
      /both minimums are zero/i,
    );
  });

  it("refuses zero/negative/oversized liquidity, tokenId 0, and a zero wallet", () => {
    assert.throws(
      () => buildLpZapOutBatch({ ...zapOutParams, liquidity: 0n }),
      /liquidity/,
    );
    assert.throws(
      () => buildLpZapOutBatch({ ...zapOutParams, liquidity: -5n }),
      /liquidity/,
    );
    assert.throws(
      () => buildLpZapOutBatch({ ...zapOutParams, liquidity: 2n ** 128n }),
      /uint128/,
    );
    assert.throws(
      () => buildLpZapOutBatch({ ...zapOutParams, tokenId: 0n }),
      /tokenId/,
    );
    assert.throws(
      () =>
        buildLpZapOutBatch({
          ...zapOutParams,
          wallet: "0x0000000000000000000000000000000000000000",
        }),
      /zero address/,
    );
  });
});

describe("buildLpZapOutKeepWbnbBatch (rotate: WBNB stays WBNB)", () => {
  it("is exactly [decrease, collect(recipient = wallet)] — no unwrap, no sweep", () => {
    // Rev2 item 14: the rotate zap-out does NOT unwrap. And with no unwrap
    // there is nothing to park in the NFPM, so both ERC-20 legs collect
    // STRAIGHT to the wallet and no sweepToken exists to forget — the
    // collect-to-NFPM + sweep shape is only ever needed to feed unwrapWETH9.
    const calls = buildLpZapOutKeepWbnbBatch({
      nfpm: NFPM,
      tokenId: 42n,
      liquidity: 777_000n,
      amount0MinWei: 100n,
      amount1MinWei: 200n,
      deadline: DEADLINE,
      wallet: WALLET,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.data, DECREASE_DATA);
    assert.equal(
      calls[1]?.data,
      SELECTORS.collect +
        word(42n) +
        addressWord(WALLET) +
        word(MAX_UINT128) +
        word(MAX_UINT128),
    );
    for (const call of calls) {
      assert.ok(!call.data?.includes(SELECTORS.unwrapWETH9.slice(2)));
      assert.ok(!call.data?.includes(SELECTORS.sweepToken.slice(2)));
    }
  });
});

describe("buildLpIncreaseBatch", () => {
  it("is [approve(WBNB, nfpm, exact), approve(TOKEN, nfpm, exact), increaseLiquidity]", () => {
    const calls = buildLpIncreaseBatch(increaseParams);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.to),
      [WBNB, TOKEN, NFPM],
    );
    // EXACT amounts (Rev2 item 15): the WBNB approve is the WBNB leg's
    // desired, the TOKEN approve the token leg's — by ROLE, not leg index.
    assert.equal(
      calls[0]?.data,
      SELECTORS.approve + addressWord(NFPM) + word(10n ** 18n),
    );
    assert.equal(
      calls[1]?.data,
      SELECTORS.approve + addressWord(NFPM) + word(5_000n),
    );
    assert.equal(
      calls[2]?.data,
      SELECTORS.increaseLiquidity +
        word(42n) +
        word(5_000n) +
        word(10n ** 18n) +
        word(4_900n) +
        word(990_000_000_000_000_000n) +
        word(DEADLINE),
    );
  });

  it("never encodes an infinite allowance", () => {
    const maxUint = "f".repeat(64);
    for (const call of buildLpIncreaseBatch(increaseParams)) {
      assert.ok(call.data === undefined || !call.data.toLowerCase().includes(maxUint));
    }
  });

  it("refuses both-legs-zero, missing floors, and tokenId 0", () => {
    assert.throws(
      () =>
        buildLpIncreaseBatch({
          ...increaseParams,
          amount0DesiredWei: 0n,
          amount0MinWei: 0n,
          amount1DesiredWei: 0n,
          amount1MinWei: 0n,
        }),
      /nothing to compound/,
    );
    assert.throws(
      () => buildLpIncreaseBatch({ ...increaseParams, amount1MinWei: 0n }),
      /no minimum/,
    );
    assert.throws(
      () => buildLpIncreaseBatch({ ...increaseParams, tokenId: 0n }),
      /tokenId/,
    );
    assert.throws(
      () => buildLpIncreaseBatch({ ...increaseParams, token0: WBNB, token1: WBNB }),
      /same address/,
    );
  });
});

describe("buildLpMintWbnbBatch (rotate's re-mint)", () => {
  it("is [approve(WBNB), approve(TOKEN), mint] with NO value and NO refundETH", () => {
    const calls = buildLpMintWbnbBatch(openParams);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.to),
      [WBNB, TOKEN, NFPM],
    );
    assert.equal(
      calls[0]?.data,
      SELECTORS.approve + addressWord(NFPM) + word(10n ** 18n),
    );
    assert.equal(
      calls[1]?.data,
      SELECTORS.approve + addressWord(NFPM) + word(5_000n),
    );
    assert.equal(calls[2]?.data, MINT_DATA);
    for (const call of calls) {
      assert.equal(call.value, undefined, "a WBNB-paid mint attaches no native");
      assert.ok(!call.data?.includes(SELECTORS.refundETH.slice(2)));
    }
  });

  it("keeps the batch shape on a single-sided re-mint (zero approve, no skip)", () => {
    const calls = buildLpMintWbnbBatch({
      ...openParams,
      amount0DesiredWei: 0n, // TOKEN leg empty: WBNB-only range
      amount0MinWei: 0n,
    });
    assert.equal(calls.length, 3);
    assert.equal(
      calls[1]?.data,
      SELECTORS.approve + addressWord(NFPM) + word(0n),
    );
  });

  it("refuses a mint where both legs deposit nothing", () => {
    assert.throws(
      () =>
        buildLpMintWbnbBatch({
          ...openParams,
          amount0DesiredWei: 0n,
          amount0MinWei: 0n,
          amount1DesiredWei: 0n,
          amount1MinWei: 0n,
        }),
      /no position to mint/,
    );
  });
});

describe("buildCollectToWallet (harvest's collect-fees step)", () => {
  it("is exactly ONE collect(tokenId, recipient = wallet, max, max) with no value", () => {
    // The harvest never unwraps (Rev2 item 14: it pays its compounding tail
    // in WBNB), so nothing parks in the NFPM and both fee legs collect
    // STRAIGHT to the wallet — golden bytes, hand-assembled.
    const calls = buildCollectToWallet({ nfpm: NFPM, tokenId: 42n, wallet: WALLET });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.to, NFPM);
    assert.equal(calls[0]?.value, undefined);
    assert.equal(
      calls[0]?.data,
      SELECTORS.collect +
        word(42n) +
        addressWord(WALLET) +
        word(MAX_UINT128) +
        word(MAX_UINT128),
    );
  });

  it("refuses tokenId 0 and the zero-address wallet (the keep-here sentinel)", () => {
    assert.throws(
      () => buildCollectToWallet({ nfpm: NFPM, tokenId: 0n, wallet: WALLET }),
      /tokenId/,
    );
    assert.throws(
      () =>
        buildCollectToWallet({
          nfpm: NFPM,
          tokenId: 42n,
          wallet: "0x0000000000000000000000000000000000000000",
        }),
      /zero address/,
    );
  });
});

describe("buildBurn", () => {
  it("encodes burn(tokenId) standalone with no value", () => {
    const call = buildBurn(NFPM, 42n);
    assert.equal(call.to, NFPM);
    assert.equal(call.value, undefined);
    assert.equal(call.data, SELECTORS.burn + word(42n));
  });

  it("refuses tokenId 0 and negatives", () => {
    assert.throws(() => buildBurn(NFPM, 0n), /tokenId/);
    assert.throws(() => buildBurn(NFPM, -1n), /tokenId/);
  });
});

describe("cross-builder invariants (PHASE3 Rev2 items 3 and 14)", () => {
  const allBatches = () => [
    ["buildLpOpenBatch", buildLpOpenBatch(openParams)] as const,
    ["buildLpZapOutBatch", buildLpZapOutBatch(zapOutParams)] as const,
    [
      "buildLpZapOutKeepWbnbBatch",
      buildLpZapOutKeepWbnbBatch({
        nfpm: NFPM,
        tokenId: 42n,
        liquidity: 777_000n,
        amount0MinWei: 100n,
        amount1MinWei: 200n,
        deadline: DEADLINE,
        wallet: WALLET,
      }),
    ] as const,
    ["buildLpIncreaseBatch", buildLpIncreaseBatch(increaseParams)] as const,
    ["buildLpMintWbnbBatch", buildLpMintWbnbBatch(openParams)] as const,
    [
      "buildCollectToWallet",
      buildCollectToWallet({ nfpm: NFPM, tokenId: 42n, wallet: WALLET }),
    ] as const,
    ["buildBurn", [buildBurn(NFPM, 42n)]] as const,
  ];

  it("no builder attaches value except buildLpOpenBatch's mint", () => {
    for (const [name, calls] of allBatches()) {
      for (const [index, call] of calls.entries()) {
        if (name === "buildLpOpenBatch" && index === 0) {
          assert.notEqual(call.value, undefined);
          continue;
        }
        assert.equal(
          call.value,
          undefined,
          `${name}[${index}] must not attach native value`,
        );
      }
    }
  });

  it("no builder ever emits NFPM multicall or the NFT-authority selectors", () => {
    for (const [name, calls] of allBatches()) {
      for (const call of calls) {
        if (call.to !== NFPM) continue; // ERC-20 approves carry 0x095ea7b3 by design
        for (const [label, selector] of Object.entries(FORBIDDEN_ON_NFPM)) {
          assert.ok(
            !call.data?.startsWith(selector),
            `${name} emits ${label} on the NFPM`,
          );
        }
      }
    }
  });

  it("every NFPM call a builder emits is one of the eight granted selectors", () => {
    const granted = new Set<string>([
      SELECTORS.mint,
      SELECTORS.increaseLiquidity,
      SELECTORS.decreaseLiquidity,
      SELECTORS.collect,
      SELECTORS.burn,
      SELECTORS.refundETH,
      SELECTORS.unwrapWETH9,
      SELECTORS.sweepToken,
    ]);
    for (const [name, calls] of allBatches()) {
      for (const call of calls) {
        if (call.to !== NFPM) continue;
        assert.ok(
          granted.has(call.data?.slice(0, 10) ?? ""),
          `${name} emits an ungranted selector on the NFPM`,
        );
      }
    }
  });
});
