/**
 * Fill verification — the proof that THIS receipt executed THIS action
 * (QUANT-GRID R6.2, R7.1, R8.1, BC19, BC24, BC28).
 *
 * The counterexample that shaped the whole rule is the SECOND test here: a
 * relay batch whose pre-call succeeds and whose main intent FAILS still carries
 * a swap for our wallet. A verifier built on the pool's event alone would
 * settle it. This one refuses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";

import { PORTO_V055_ORCHESTRATOR } from "../src/lp/preparedIntent.js";
import { buildPancakeTokenSwap } from "../src/ops/pancakeTokens.js";
import { QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56, QUANT_U_WBNB_PAIR_56 } from "../src/quant/config.js";
import {
  assertOrchestratorPin,
  callsEqual,
  decodeExecutionCalls,
  INTENT_SUCCESS_ERR,
  QUANT_ORCHESTRATOR_56,
  verifyQuantFill,
} from "../src/quant/receipt.js";
import {
  buildPair,
  encodeCalls,
  encodeExecute,
  encodeIntent,
  intentExecutedLog,
  swapLog,
  transferLog,
} from "./support/quantReceipts.js";

const WALLET = getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111");
const OTHER_WALLET = getAddress("0x2222222222222222222222222222222222222222");
const KEY_HASH = `0x${"cd".repeat(32)}` as Hex;
const NONCE = 42n;
const AMOUNT_IN = 10n ** 19n;
const MIN_OUT = 13_500_000_000_000_000n;
const FILL_OUT = 13_551_363_807_546_408n;

const CALLS = buildPancakeTokenSwap({
  router: QUANT_ROUTER_56,
  tokenIn: QUANT_U_56,
  tokenOut: QUANT_WBNB_56,
  amountInWei: AMOUNT_IN,
  minOutWei: MIN_OUT,
  recipient: WALLET,
  deadline: 1_800_000_601n,
});

/** A normal, successful BUY: Approval ahead, Transfer, Transfer, Sync, Swap. */
function normalBuy(overrides: {
  readonly err?: Hex;
  readonly incremented?: boolean;
  readonly preCalls?: readonly Hex[];
  readonly fundTransfers?: readonly Hex[];
  readonly extraLogs?: readonly ReturnType<typeof transferLog>[];
  readonly amountIn?: bigint;
  readonly amountOut?: bigint;
  /** Raw `IntentExecuted` data, for the shapes the decoder refuses (A5). */
  readonly intentExecutedData?: Hex;
} = {}) {
  const intent = encodeIntent({
    eoa: WALLET, nonce: NONCE, keyHash: KEY_HASH, calls: CALLS,
    ...(overrides.preCalls === undefined ? {} : { preCalls: overrides.preCalls }),
    ...(overrides.fundTransfers === undefined ? {} : { fundTransfers: overrides.fundTransfers }),
  });
  const amountIn = overrides.amountIn ?? AMOUNT_IN;
  const amountOut = overrides.amountOut ?? FILL_OUT;
  return buildPair({
    input: encodeExecute([intent]),
    logs: [
      // An `Approval` from the batch's first call sits ahead of the legs; the
      // verifier must walk past it rather than trip on it.
      {
        address: QUANT_U_56,
        topics: [`0x${"11".repeat(32)}` as Hex],
        data: "0x",
        logIndex: 0n,
      },
      transferLog({ token: QUANT_U_56, from: WALLET, to: QUANT_U_WBNB_PAIR_56, value: amountIn, logIndex: 1n }),
      transferLog({ token: QUANT_WBNB_56, from: QUANT_U_WBNB_PAIR_56, to: WALLET, value: amountOut, logIndex: 2n }),
      // A `Sync` between the legs and the swap is normal V2 ordering.
      { address: QUANT_U_WBNB_PAIR_56, topics: [`0x${"22".repeat(32)}` as Hex], data: "0x", logIndex: 3n },
      swapLog({
        pair: QUANT_U_WBNB_PAIR_56, to: WALLET, amountIn, amountOut,
        inputIsToken0: true, logIndex: 4n,
      }),
      ...(overrides.extraLogs ?? []),
      intentExecutedLog({
        eoa: WALLET, nonce: NONCE,
        incremented: overrides.incremented ?? true,
        err: overrides.err ?? INTENT_SUCCESS_ERR,
        logIndex: 5n,
        ...(overrides.intentExecutedData === undefined
          ? {}
          : { data: overrides.intentExecutedData }),
      }),
    ],
  });
}

function verify(pair: ReturnType<typeof normalBuy>, overrides: Record<string, unknown> = {}) {
  return verifyQuantFill({
    transaction: pair.transaction,
    receipt: pair.receipt,
    tradingWallet: WALLET,
    sessionKeyHash: KEY_HASH,
    calls: CALLS,
    pair: QUANT_U_WBNB_PAIR_56,
    tokenIn: QUANT_U_56,
    tokenOut: QUANT_WBNB_56,
    amountInWei: AMOUNT_IN,
    minOutWei: MIN_OUT,
    ...overrides,
  });
}

describe("the orchestrator pin (R8.1)", () => {
  it("is ONE source, equal to the LP landing constant", () => {
    assert.equal(QUANT_ORCHESTRATOR_56, getAddress(PORTO_V055_ORCHESTRATOR));
    assert.doesNotThrow(() => assertOrchestratorPin(PORTO_V055_ORCHESTRATOR));
  });

  it("REFUSES the boot when the two diverge — the tripwire", () => {
    assert.throws(
      () => assertOrchestratorPin("0x1111111111111111111111111111111111111111"),
      /orchestrator pin/u,
    );
  });

  it("refuses a candidate transaction sent anywhere else", () => {
    const pair = normalBuy();
    const verdict = verifyQuantFill({
      transaction: { ...pair.transaction, to: getAddress("0x3333333333333333333333333333333333333333") },
      receipt: pair.receipt,
      tradingWallet: WALLET, sessionKeyHash: KEY_HASH, calls: CALLS,
      pair: QUANT_U_WBNB_PAIR_56, tokenIn: QUANT_U_56, tokenOut: QUANT_WBNB_56,
      amountInWei: AMOUNT_IN, minOutWei: MIN_OUT,
    });
    assert.deepEqual(verdict, { ok: false, code: "fill-wrong-orchestrator" });
  });
});

describe("verifyQuantFill", () => {
  it("VERIFIES a normal buy and reports the exact fills", () => {
    const verdict = verify(normalBuy());
    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.code);
    if (!verdict.ok) return;
    assert.equal(verdict.fill.fillInWei, AMOUNT_IN);
    assert.equal(verdict.fill.fillOutWei, FILL_OUT);
    assert.equal(verdict.fill.swapLogIndex, 4n);
    assert.equal(verdict.fill.intentIndex, 0);
  });

  it("REFUSES a failed main intent even though a swap for our wallet exists", () => {
    // REVIEW6 C1's counterexample. This is the case that made the
    // orchestrator's own event — not the pool's — the proof.
    const verdict = verify(normalBuy({ err: `0x${"de".repeat(4)}` as Hex }));
    assert.deepEqual(verdict, { ok: false, code: "fill-failed-intent" });
  });

  it("requires err to be EXACTLY 0x00000000, not a falsy string", () => {
    assert.equal(INTENT_SUCCESS_ERR, "0x00000000");
    const verdict = verify(normalBuy({ err: "0x00000001" as Hex }));
    assert.deepEqual(verdict, { ok: false, code: "fill-failed-intent" });
  });

  // A5: the two shapes `decodeIntentExecuted` refuses STRUCTURALLY, pinned so
  // the `err === "0x"` mutation the audit found surviving has nowhere to hide:
  // a body that is not 64 bytes never reaches the `bytes4` compare at all.
  it("refuses an IntentExecuted whose data is not 64 bytes", () => {
    for (const data of [
      "0x" as Hex,
      // One word only — a `bool` with no `err` beside it.
      `0x${"0".repeat(63)}1` as Hex,
      // Three words — a body the ABI would decode but the shape forbids.
      `0x${"0".repeat(63)}1${"0".repeat(128)}` as Hex,
    ]) {
      const verdict = verify(normalBuy({ intentExecutedData: data }));
      assert.deepEqual(verdict, { ok: false, code: "fill-undecodable" }, data);
    }
  });

  it("refuses a well-formed body whose err decodes to a NON-ZERO bytes4", () => {
    // The same 64 bytes a success carries, with `deadbeef` in the `err` word's
    // leading four bytes: decodable, paired, incremented — and still refused.
    const data = `0x${"0".repeat(63)}1deadbeef${"0".repeat(56)}` as Hex;
    const verdict = verify(normalBuy({ intentExecutedData: data }));
    assert.deepEqual(verdict, { ok: false, code: "fill-failed-intent" });
  });

  it("requires `incremented`", () => {
    const verdict = verify(normalBuy({ incremented: false }));
    assert.deepEqual(verdict, { ok: false, code: "fill-failed-intent" });
  });

  it("REFUSES an intent carrying pre-calls (BC28: inspected, not defaulted)", () => {
    const verdict = verify(normalBuy({ preCalls: ["0xdeadbeef"] }));
    assert.deepEqual(verdict, { ok: false, code: "fill-unsupported-shape" });
  });

  it("REFUSES an intent carrying a funding sub-intent", () => {
    const verdict = verify(normalBuy({ fundTransfers: ["0xdeadbeef"] }));
    assert.deepEqual(verdict, { ok: false, code: "fill-unsupported-shape" });
  });

  it("refuses a reverted receipt", () => {
    const pair = normalBuy();
    const verdict = verify({ ...pair, receipt: { ...pair.receipt, status: 0n } });
    assert.deepEqual(verdict, { ok: false, code: "fill-reverted" });
  });

  it("refuses a receipt that is not THIS transaction's", () => {
    const pair = normalBuy();
    const verdict = verify({
      ...pair,
      receipt: { ...pair.receipt, blockHash: `0x${"ee".repeat(32)}` as Hex },
    });
    assert.deepEqual(verdict, { ok: false, code: "fill-receipt-mismatch" });
  });

  it("refuses calls that are not BYTE-EQUAL to the action's", () => {
    const different = buildPancakeTokenSwap({
      router: QUANT_ROUTER_56, tokenIn: QUANT_U_56, tokenOut: QUANT_WBNB_56,
      amountInWei: AMOUNT_IN, minOutWei: MIN_OUT + 1n,
      recipient: WALLET, deadline: 1_800_000_601n,
    });
    const verdict = verify(normalBuy(), { calls: different });
    assert.deepEqual(verdict, { ok: false, code: "fill-calls-mismatch" });
  });

  it("refuses an intent signed by a DIFFERENT key", () => {
    const verdict = verify(normalBuy(), { sessionKeyHash: `0x${"ef".repeat(32)}` as Hex });
    assert.deepEqual(verdict, { ok: false, code: "fill-key-mismatch" });
  });

  it("settles each wallet independently in a TWO-WALLET batch", () => {
    const ours = encodeIntent({ eoa: WALLET, nonce: NONCE, keyHash: KEY_HASH, calls: CALLS });
    const theirs = encodeIntent({
      eoa: OTHER_WALLET, nonce: 7n, keyHash: `0x${"99".repeat(32)}` as Hex, calls: CALLS,
    });
    const pair = buildPair({
      input: encodeExecute([theirs, ours]),
      logs: [
        // The other wallet's legs and swap sit interleaved with ours.
        transferLog({ token: QUANT_U_56, from: OTHER_WALLET, to: QUANT_U_WBNB_PAIR_56, value: 1n, logIndex: 0n }),
        transferLog({ token: QUANT_WBNB_56, from: QUANT_U_WBNB_PAIR_56, to: OTHER_WALLET, value: 2n, logIndex: 1n }),
        swapLog({ pair: QUANT_U_WBNB_PAIR_56, to: OTHER_WALLET, amountIn: 1n, amountOut: 2n, inputIsToken0: true, logIndex: 2n }),
        transferLog({ token: QUANT_U_56, from: WALLET, to: QUANT_U_WBNB_PAIR_56, value: AMOUNT_IN, logIndex: 3n }),
        transferLog({ token: QUANT_WBNB_56, from: QUANT_U_WBNB_PAIR_56, to: WALLET, value: FILL_OUT, logIndex: 4n }),
        swapLog({ pair: QUANT_U_WBNB_PAIR_56, to: WALLET, amountIn: AMOUNT_IN, amountOut: FILL_OUT, inputIsToken0: true, logIndex: 5n }),
        intentExecutedLog({ eoa: OTHER_WALLET, nonce: 7n, incremented: true, err: INTENT_SUCCESS_ERR, logIndex: 6n }),
        intentExecutedLog({ eoa: WALLET, nonce: NONCE, incremented: true, err: INTENT_SUCCESS_ERR, logIndex: 7n }),
      ],
    });
    const verdict = verify(pair);
    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.code);
    if (!verdict.ok) return;
    // Ownership is `(tx, wallet, swapLogIndex)` — the other wallet's swap at
    // log 2 is a DIFFERENT key, so the two settle independently.
    assert.equal(verdict.fill.swapLogIndex, 5n);
  });

  it("refuses TWO intents for the SAME wallet in one transaction", () => {
    const a = encodeIntent({ eoa: WALLET, nonce: NONCE, keyHash: KEY_HASH, calls: CALLS });
    const b = encodeIntent({ eoa: WALLET, nonce: NONCE + 1n, keyHash: KEY_HASH, calls: CALLS });
    const pair = buildPair({ input: encodeExecute([a, b]), logs: [] });
    const verdict = verify(pair);
    assert.deepEqual(verdict, { ok: false, code: "fill-ambiguous" });
  });

  it("refuses a same-wallet DOUBLE SWAP", () => {
    const pair = normalBuy({
      extraLogs: [
        swapLog({
          pair: QUANT_U_WBNB_PAIR_56, to: WALLET, amountIn: AMOUNT_IN, amountOut: FILL_OUT,
          inputIsToken0: true, logIndex: 6n,
        }) as ReturnType<typeof transferLog>,
      ],
    });
    const verdict = verify(pair);
    assert.deepEqual(verdict, { ok: false, code: "fill-ambiguous" });
  });

  it("refuses duplicate IntentExecuted events for one (eoa, nonce)", () => {
    const intent = encodeIntent({ eoa: WALLET, nonce: NONCE, keyHash: KEY_HASH, calls: CALLS });
    const pair = buildPair({
      input: encodeExecute([intent]),
      logs: [
        transferLog({ token: QUANT_U_56, from: WALLET, to: QUANT_U_WBNB_PAIR_56, value: AMOUNT_IN, logIndex: 0n }),
        transferLog({ token: QUANT_WBNB_56, from: QUANT_U_WBNB_PAIR_56, to: WALLET, value: FILL_OUT, logIndex: 1n }),
        swapLog({ pair: QUANT_U_WBNB_PAIR_56, to: WALLET, amountIn: AMOUNT_IN, amountOut: FILL_OUT, inputIsToken0: true, logIndex: 2n }),
        intentExecutedLog({ eoa: WALLET, nonce: NONCE, incremented: true, err: INTENT_SUCCESS_ERR, logIndex: 3n }),
        intentExecutedLog({ eoa: WALLET, nonce: NONCE, incremented: true, err: INTENT_SUCCESS_ERR, logIndex: 4n }),
      ],
    });
    assert.deepEqual(verify(pair), { ok: false, code: "fill-ambiguous" });
  });

  it("refuses an ANOTHER transfer of U or WBNB touching our wallet", () => {
    const pair = normalBuy({
      extraLogs: [
        transferLog({ token: QUANT_WBNB_56, from: WALLET, to: OTHER_WALLET, value: 1n, logIndex: 6n }),
      ],
    });
    assert.deepEqual(verify(pair), { ok: false, code: "fill-ambiguous" });
  });

  it("refuses an input leg whose value is not EXACTLY amountIn", () => {
    const pair = normalBuy({ amountIn: AMOUNT_IN - 1n });
    assert.deepEqual(verify(pair), { ok: false, code: "fill-amount-mismatch" });
  });

  it("refuses an output below the TAGGED minOut", () => {
    const pair = normalBuy({ amountOut: MIN_OUT - 1n });
    assert.deepEqual(verify(pair), { ok: false, code: "fill-amount-mismatch" });
  });

  it("refuses a Swap whose amounts disagree with the Transfer legs (R7.1 rule 5)", () => {
    const intent = encodeIntent({ eoa: WALLET, nonce: NONCE, keyHash: KEY_HASH, calls: CALLS });
    const pair = buildPair({
      input: encodeExecute([intent]),
      logs: [
        transferLog({ token: QUANT_U_56, from: WALLET, to: QUANT_U_WBNB_PAIR_56, value: AMOUNT_IN, logIndex: 0n }),
        transferLog({ token: QUANT_WBNB_56, from: QUANT_U_WBNB_PAIR_56, to: WALLET, value: FILL_OUT, logIndex: 1n }),
        swapLog({
          pair: QUANT_U_WBNB_PAIR_56, to: WALLET,
          amountIn: AMOUNT_IN, amountOut: FILL_OUT + 1n, inputIsToken0: true, logIndex: 2n,
        }),
        intentExecutedLog({ eoa: WALLET, nonce: NONCE, incremented: true, err: INTENT_SUCCESS_ERR, logIndex: 3n }),
      ],
    });
    assert.deepEqual(verify(pair), { ok: false, code: "fill-amount-mismatch" });
  });

  it("accepts EITHER pool ordering — the slot is read, never assumed", () => {
    const intent = encodeIntent({ eoa: WALLET, nonce: NONCE, keyHash: KEY_HASH, calls: CALLS });
    const pair = buildPair({
      input: encodeExecute([intent]),
      logs: [
        transferLog({ token: QUANT_U_56, from: WALLET, to: QUANT_U_WBNB_PAIR_56, value: AMOUNT_IN, logIndex: 0n }),
        transferLog({ token: QUANT_WBNB_56, from: QUANT_U_WBNB_PAIR_56, to: WALLET, value: FILL_OUT, logIndex: 1n }),
        swapLog({
          pair: QUANT_U_WBNB_PAIR_56, to: WALLET, amountIn: AMOUNT_IN, amountOut: FILL_OUT,
          inputIsToken0: false, logIndex: 2n,
        }),
        intentExecutedLog({ eoa: WALLET, nonce: NONCE, incremented: true, err: INTENT_SUCCESS_ERR, logIndex: 3n }),
      ],
    });
    assert.equal(verify(pair).ok, true);
  });

  it("refuses undecodable calldata rather than guessing", () => {
    const pair = buildPair({ input: "0xdeadbeef", logs: [] });
    assert.deepEqual(verify(pair), { ok: false, code: "fill-undecodable" });
  });
});

describe("call decoding helpers", () => {
  it("round-trips ERC-7821 Call[]", () => {
    const decoded = decodeExecutionCalls(encodeCalls(CALLS));
    assert.notEqual(decoded, null);
    assert.equal(callsEqual(decoded ?? [], CALLS), true);
  });

  it("callsEqual is order-sensitive and value-sensitive", () => {
    assert.equal(callsEqual(CALLS, [...CALLS].reverse()), false);
    assert.equal(callsEqual(CALLS, CALLS.slice(0, 1)), false);
    assert.equal(
      callsEqual(CALLS, CALLS.map((call, index) =>
        index === 0 ? { ...call, value: 1n } : call)),
      false,
    );
  });
});
