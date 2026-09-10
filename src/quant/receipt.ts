/**
 * Fill verification: does THIS receipt prove THIS action executed?
 * (QUANT-GRID R6.2, R7.1, R8.1, BC28.)
 *
 * ─── THE ORDER IS THE ARGUMENT ─────────────────────────────────────────────
 *
 * A swap for our wallet in a receipt is NOT proof our intent ran. REVIEW6's C1
 * counterexample: a relay batch whose PRE-CALL succeeds and whose MAIN intent
 * fails still carries a swap. So the proof is built from the ORCHESTRATOR's own
 * event, not from the pool's:
 *
 *   1. `tx.to` IS the pinned chain-56 orchestrator. The pin is the decoder
 *      registry's fixed address (R8.1) — SDK 0.7.0's `NetworkConfig` has no
 *      orchestrator field, so BC23's "read it from SDK config" is not
 *      implementable and was corrected to this. It is NEVER derived from a
 *      candidate transaction.
 *   2. Exactly ONE top-level intent decodes for `eoa = tradingWallet`; its
 *      calls are BYTE-EQUAL to the action's `calls_json`; its key hash is the
 *      session's.
 *   3. That intent carries NO `encodedPreCalls` and NO `encodedFundTransfers`.
 *      The repo's two existing decoders DISCARD both fields, which is exactly
 *      what REVIEW7 condition 2 says must not be treated as "absent"; this
 *      module decodes the whole tuple and INSPECTS them. Anything else is
 *      `fill-unsupported-shape` and never settles.
 *   4. Exactly one `IntentExecuted` pairs with `(eoa, nonce)`, `incremented`
 *      true and `err` EXACTLY `0x00000000` — not `"0x"`, not a falsy string.
 *   5. The pair `Swap` and its two `Transfer` legs agree with the action's
 *      direction and amounts.
 *   6. Ownership is `(tx_hash, trading_wallet, swap_log_index)`, unique in the
 *      store, so one receipt settles one action and a batched multi-wallet
 *      transaction settles each wallet's action independently.
 *
 * PURE given the receipt and the transaction. Every failure is a fixed code.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { PORTO_V055_INTENT_PARAMETERS } from "../lp/intentDecoder.js";
import { PORTO_V055_ORCHESTRATOR } from "../lp/preparedIntent.js";
import type { WalletCall } from "../core/types.js";

/**
 * THE trusted orchestrator pin (R8.1).
 *
 * One source: the decoder registry constant `src/lp/preparedIntent.ts` already
 * compares prepare quotes against. `assertOrchestratorPin` asserts it equals
 * the LP constant at boot — a tautology today and a TRIPWIRE tomorrow, which is
 * the point.
 */
export const QUANT_ORCHESTRATOR_56: Address = getAddress(PORTO_V055_ORCHESTRATOR);

/** Boot assertion. Cheap, and it fires the day someone forks the constant. */
export function assertOrchestratorPin(lpConstant: string): void {
  if (getAddress(lpConstant) !== QUANT_ORCHESTRATOR_56) {
    throw new Error(
      "Boot refused: the quant orchestrator pin no longer equals the LP landing "
      + "constant. One address, one source (QUANT-GRID R8.1).",
    );
  }
}

const EXECUTE_ABI = parseAbi([
  "function execute(bytes encodedIntent) payable returns (bytes4 err)",
  "function execute(bytes[] encodedIntents) payable returns (bytes4[] errs)",
]);

/** ERC-7821 `Call[]`, the shape an intent's `executionData` abi-encodes. */
const CALLS_PARAMETERS = [{
  type: "tuple[]",
  components: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
}] as const;

export const INTENT_EXECUTED_TOPIC =
  "0x23a3c1343409f01965611c9c4c8b99e36d7b09ca22516507d5486ce0584379b8" as Hex;

/** `Transfer(address,address,uint256)`. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

/** V2 `Swap(address,uint256,uint256,uint256,uint256,address)`. */
export const SWAP_TOPIC =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822" as Hex;

/** Success is EXACTLY four zero bytes (REVIEW7 condition 2). */
export const INTENT_SUCCESS_ERR = "0x00000000" as Hex;

export type QuantReceiptLog = {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly logIndex: bigint;
};

export type QuantReceipt = {
  readonly status: bigint;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
  readonly logs: readonly QuantReceiptLog[];
};

export type QuantTransaction = {
  readonly hash: Hex;
  readonly to: Address | null;
  readonly input: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
};

export type VerifiedFill = {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly swapLogIndex: bigint;
  /** Exactly the action's `amount_in_wei`. */
  readonly fillInWei: bigint;
  /** At least the action's tagged `min_out_wei`. */
  readonly fillOutWei: bigint;
  readonly intentIndex: number;
};

export type FillVerificationCode =
  | "fill-wrong-orchestrator"
  | "fill-receipt-mismatch"
  | "fill-reverted"
  | "fill-undecodable"
  | "fill-unsupported-shape"
  | "fill-calls-mismatch"
  | "fill-key-mismatch"
  | "fill-ambiguous"
  | "fill-failed-intent"
  | "fill-legs-missing"
  | "fill-amount-mismatch";

export type FillVerification =
  | { readonly ok: true; readonly fill: VerifiedFill }
  | { readonly ok: false; readonly code: FillVerificationCode };

function fail(code: FillVerificationCode): FillVerification {
  return { ok: false, code };
}

type DecodedIntent = {
  readonly index: number;
  readonly eoa: Address;
  readonly nonce: bigint;
  readonly keyHash: Hex;
  readonly executionData: Hex;
  readonly preCallCount: number;
  readonly fundTransferCount: number;
  readonly funder: Address;
  readonly funderSignatureBytes: number;
};

/** The whole tuple, INCLUDING the fields the repo's other decoders discard. */
function decodeIntents(input: Hex): readonly DecodedIntent[] | null {
  let decoded: ReturnType<typeof decodeFunctionData<typeof EXECUTE_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: input });
  } catch {
    return null;
  }
  const argument = decoded.args[0];
  const members = Array.isArray(argument) ? argument : [argument];
  if (members.length === 0 || members.length > 32) return null;
  // Canonicality: trailing data or a non-minimal encoding is refused rather
  // than parsed, exactly as `decodePortoV055Transaction` does.
  const reencoded = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [argument],
  } as never);
  if (reencoded.toLowerCase() !== input.toLowerCase()) return null;
  const result: DecodedIntent[] = [];
  for (const [index, member] of members.entries()) {
    let intent: ReturnType<typeof decodeAbiParameters<typeof PORTO_V055_INTENT_PARAMETERS>>[0];
    try {
      [intent] = decodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, member as Hex);
    } catch {
      return null;
    }
    const signature = intent.signature;
    if ((signature.length - 2) / 2 < 33) return null;
    result.push({
      index,
      eoa: getAddress(intent.eoa),
      nonce: intent.nonce,
      keyHash: `0x${signature.slice(-66, -2)}`.toLowerCase() as Hex,
      executionData: intent.executionData,
      // BC28: INSPECTED, not defaulted to empty.
      preCallCount: intent.encodedPreCalls.length,
      fundTransferCount: intent.encodedFundTransfers.length,
      funder: getAddress(intent.funder),
      funderSignatureBytes: (intent.funderSignature.length - 2) / 2,
    });
  }
  return result;
}

/** The exact `Call[]` an intent will run, or `null` when it does not decode. */
export function decodeExecutionCalls(executionData: Hex): readonly WalletCall[] | null {
  try {
    const [calls] = decodeAbiParameters(CALLS_PARAMETERS, executionData);
    return calls.map((call) => ({
      to: getAddress(call.target),
      value: call.value,
      data: call.data,
    }));
  } catch {
    return null;
  }
}

/** Byte-equality of two call batches, order included. */
export function callsEqual(
  left: readonly WalletCall[],
  right: readonly WalletCall[],
): boolean {
  if (left.length !== right.length) return false;
  for (const [index, call] of left.entries()) {
    const other = right[index];
    if (other === undefined) return false;
    if (getAddress(call.to) !== getAddress(other.to)) return false;
    if ((call.value ?? 0n) !== (other.value ?? 0n)) return false;
    if ((call.data ?? "0x").toLowerCase() !== (other.data ?? "0x").toLowerCase()) return false;
  }
  return true;
}

type IntentExecutedEvent = {
  readonly eoa: Address;
  readonly nonce: bigint;
  readonly incremented: boolean;
  readonly err: Hex;
};

function decodeIntentExecuted(
  log: QuantReceiptLog, orchestrator: Address,
): IntentExecutedEvent | null | "malformed" {
  if (log.address.toLowerCase() !== orchestrator.toLowerCase()) return null;
  if (log.topics[0]?.toLowerCase() !== INTENT_EXECUTED_TOPIC) return null;
  if (log.topics.length !== 3 || (log.data.length - 2) / 2 !== 64) return "malformed";
  const eoaTopic = log.topics[1];
  const nonceTopic = log.topics[2];
  if (eoaTopic === undefined || nonceTopic === undefined) return "malformed";
  try {
    const [incremented, err] = decodeAbiParameters(
      [{ type: "bool" }, { type: "bytes4" }], log.data,
    );
    return {
      eoa: getAddress(`0x${eoaTopic.slice(-40)}`),
      nonce: BigInt(nonceTopic),
      incremented,
      err: err.toLowerCase() as Hex,
    };
  } catch {
    return "malformed";
  }
}

function topicAddress(topic: Hex | undefined): Address | null {
  if (topic === undefined || topic.length !== 66) return null;
  try {
    return getAddress(`0x${topic.slice(-40)}`);
  } catch {
    return null;
  }
}

export type VerifyQuantFillInput = {
  readonly transaction: QuantTransaction;
  readonly receipt: QuantReceipt;
  readonly tradingWallet: Address;
  readonly sessionKeyHash: Hex;
  readonly calls: readonly WalletCall[];
  readonly pair: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly orchestrator?: Address;
};

export function verifyQuantFill(input: VerifyQuantFillInput): FillVerification {
  const orchestrator = input.orchestrator ?? QUANT_ORCHESTRATOR_56;
  const { transaction, receipt } = input;

  /* 1 — the pinned orchestrator, and the receipt IS this transaction's. */
  if (transaction.to === null
    || getAddress(transaction.to) !== getAddress(orchestrator)) {
    return fail("fill-wrong-orchestrator");
  }
  if (receipt.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()
    || receipt.blockNumber !== transaction.blockNumber
    || receipt.blockHash.toLowerCase() !== transaction.blockHash.toLowerCase()
    || receipt.transactionIndex !== transaction.transactionIndex) {
    return fail("fill-receipt-mismatch");
  }
  if (receipt.status !== 1n) return fail("fill-reverted");

  /* 2 — exactly one intent for this wallet, byte-equal calls, our key. */
  const intents = decodeIntents(transaction.input);
  if (intents === null) return fail("fill-undecodable");
  const mine = intents.filter(
    (intent) => intent.eoa.toLowerCase() === getAddress(input.tradingWallet).toLowerCase(),
  );
  if (mine.length !== 1) return fail("fill-ambiguous");
  const intent = mine[0];
  if (intent === undefined) return fail("fill-ambiguous");
  if (intent.keyHash.toLowerCase() !== input.sessionKeyHash.toLowerCase()) {
    return fail("fill-key-mismatch");
  }
  const decodedCalls = decodeExecutionCalls(intent.executionData);
  if (decodedCalls === null) return fail("fill-undecodable");
  if (!callsEqual(decodedCalls, input.calls)) return fail("fill-calls-mismatch");

  /* 3 — no pre-calls, no funding sub-intent (BC28). */
  if (intent.preCallCount !== 0
    || intent.fundTransferCount !== 0
    || intent.funderSignatureBytes !== 0
    || intent.funder !== getAddress("0x0000000000000000000000000000000000000000")) {
    return fail("fill-unsupported-shape");
  }

  /* 4 — exactly one paired IntentExecuted, incremented, err == 0x00000000. */
  const events: IntentExecutedEvent[] = [];
  for (const log of receipt.logs) {
    const decoded = decodeIntentExecuted(log, orchestrator);
    if (decoded === "malformed") return fail("fill-undecodable");
    if (decoded !== null) events.push(decoded);
  }
  const paired = events.filter(
    (event) => event.eoa.toLowerCase() === intent.eoa.toLowerCase()
      && event.nonce === intent.nonce,
  );
  if (paired.length !== 1) return fail("fill-ambiguous");
  const event = paired[0];
  if (event === undefined) return fail("fill-ambiguous");
  if (!event.incremented || event.err !== INTENT_SUCCESS_ERR) {
    return fail("fill-failed-intent");
  }

  /* 5 — the pool legs, and their amounts. */
  const wallet = getAddress(input.tradingWallet);
  const pair = getAddress(input.pair);
  const tokenIn = getAddress(input.tokenIn);
  const tokenOut = getAddress(input.tokenOut);

  const swaps = receipt.logs.filter(
    (log) => log.address.toLowerCase() === pair.toLowerCase()
      && log.topics[0]?.toLowerCase() === SWAP_TOPIC
      && topicAddress(log.topics[2])?.toLowerCase() === wallet.toLowerCase(),
  );
  if (swaps.length !== 1) return fail("fill-ambiguous");
  const swap = swaps[0];
  if (swap === undefined) return fail("fill-ambiguous");

  // Any OTHER transfer of U or WBNB touching this wallet in the receipt makes
  // the attribution ambiguous, so it is refused rather than guessed (R6.2).
  const transfers = receipt.logs.filter(
    (log) => log.topics[0]?.toLowerCase() === TRANSFER_TOPIC
      && (log.address.toLowerCase() === tokenIn.toLowerCase()
        || log.address.toLowerCase() === tokenOut.toLowerCase())
      && (topicAddress(log.topics[1])?.toLowerCase() === wallet.toLowerCase()
        || topicAddress(log.topics[2])?.toLowerCase() === wallet.toLowerCase()),
  );
  const inLegs = transfers.filter(
    (log) => log.address.toLowerCase() === tokenIn.toLowerCase()
      && topicAddress(log.topics[1])?.toLowerCase() === wallet.toLowerCase()
      && topicAddress(log.topics[2])?.toLowerCase() === pair.toLowerCase()
      && log.logIndex < swap.logIndex,
  );
  const outLegs = transfers.filter(
    (log) => log.address.toLowerCase() === tokenOut.toLowerCase()
      && topicAddress(log.topics[1])?.toLowerCase() === pair.toLowerCase()
      && topicAddress(log.topics[2])?.toLowerCase() === wallet.toLowerCase()
      && log.logIndex < swap.logIndex,
  );
  if (transfers.length !== inLegs.length + outLegs.length) return fail("fill-ambiguous");
  if (inLegs.length !== 1 || outLegs.length !== 1) return fail("fill-legs-missing");
  const inLeg = inLegs[0];
  const outLeg = outLegs[0];
  if (inLeg === undefined || outLeg === undefined) return fail("fill-legs-missing");

  let fillInWei: bigint;
  let fillOutWei: bigint;
  try {
    [fillInWei] = decodeAbiParameters([{ type: "uint256" }], inLeg.data);
    [fillOutWei] = decodeAbiParameters([{ type: "uint256" }], outLeg.data);
  } catch {
    return fail("fill-undecodable");
  }
  if (fillInWei !== input.amountInWei) return fail("fill-amount-mismatch");
  if (fillOutWei < input.minOutWei) return fail("fill-amount-mismatch");

  // R7.1 rule 5: the Swap's own amount fields must agree with the legs, in
  // whichever slot ordering the pair uses. `amount0In, amount1In, amount0Out,
  // amount1Out` — exactly one In slot and one Out slot are non-zero for a
  // single-hop swap, and they must be OUR two amounts.
  let amounts: readonly [bigint, bigint, bigint, bigint];
  try {
    amounts = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      swap.data,
    ) as readonly [bigint, bigint, bigint, bigint];
  } catch {
    return fail("fill-undecodable");
  }
  const amountIn = amounts[0] === 0n ? amounts[1] : amounts[0];
  const amountOut = amounts[2] === 0n ? amounts[3] : amounts[2];
  if (amounts[0] !== 0n && amounts[1] !== 0n) return fail("fill-ambiguous");
  if (amounts[2] !== 0n && amounts[3] !== 0n) return fail("fill-ambiguous");
  if (amountIn !== fillInWei || amountOut !== fillOutWei) {
    return fail("fill-amount-mismatch");
  }

  return {
    ok: true,
    fill: {
      txHash: receipt.transactionHash.toLowerCase() as Hex,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase() as Hex,
      swapLogIndex: swap.logIndex,
      fillInWei,
      fillOutWei,
      intentIndex: intent.index,
    },
  };
}

/** Canonical digest of a call batch. Persisted with the action for evidence. */
export function callsDigest(calls: readonly WalletCall[]): Hex {
  return keccak256(
    `0x${calls
      .map((call) =>
        `${getAddress(call.to).slice(2)}${(call.value ?? 0n).toString(16).padStart(64, "0")}${(call.data ?? "0x").slice(2)}`)
      .join("")}` as Hex,
  );
}
