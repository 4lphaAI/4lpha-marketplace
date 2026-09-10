/**
 * Synthetic Porto/Pancake receipts for the quant fill verifier
 * (QUANT-GRID BC19/BC24/BC28).
 *
 * These are BUILT, not recorded, and the build report says so: every field the
 * verifier reads is produced here from the same encodings the chain uses
 * (`execute(bytes|bytes[])`, the 0.5.5 intent tuple, ERC-7821 `Call[]`,
 * `IntentExecuted`, ERC-20 `Transfer`, V2 `Swap`), so the DECODING is exercised
 * for real. What they cannot prove is that a live relay's transaction has this
 * shape — that is gate 1, and the runbook records it.
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { PORTO_V055_INTENT_PARAMETERS } from "../../src/lp/intentDecoder.js";
import type { WalletCall } from "../../src/core/types.js";
import {
  INTENT_EXECUTED_TOPIC,
  SWAP_TOPIC,
  TRANSFER_TOPIC,
  QUANT_ORCHESTRATOR_56,
  type QuantReceipt,
  type QuantReceiptLog,
  type QuantTransaction,
} from "../../src/quant/receipt.js";

const EXECUTE_ABI = parseAbi([
  "function execute(bytes encodedIntent) payable returns (bytes4 err)",
  "function execute(bytes[] encodedIntents) payable returns (bytes4[] errs)",
]);

const CALLS_PARAMETERS = [{
  type: "tuple[]",
  components: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
}] as const;

const ZERO = getAddress("0x0000000000000000000000000000000000000000");

export function encodeCalls(calls: readonly WalletCall[]): Hex {
  return encodeAbiParameters(CALLS_PARAMETERS, [
    calls.map((call) => ({
      target: getAddress(call.to),
      value: call.value ?? 0n,
      data: (call.data ?? "0x") as Hex,
    })),
  ]);
}

export type IntentSpec = {
  readonly eoa: Address;
  readonly nonce: bigint;
  readonly keyHash: Hex;
  readonly calls: readonly WalletCall[];
  readonly preCalls?: readonly Hex[];
  readonly fundTransfers?: readonly Hex[];
  readonly funder?: Address;
  readonly funderSignature?: Hex;
};

export function encodeIntent(spec: IntentSpec): Hex {
  return encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [{
    eoa: getAddress(spec.eoa),
    executionData: encodeCalls(spec.calls),
    nonce: spec.nonce,
    payer: ZERO,
    paymentToken: ZERO,
    paymentMaxAmount: 0n,
    combinedGas: 1_000_000n,
    encodedPreCalls: [...(spec.preCalls ?? [])],
    encodedFundTransfers: [...(spec.fundTransfers ?? [])],
    settler: ZERO,
    expiry: 0n,
    isMultichain: false,
    funder: getAddress(spec.funder ?? ZERO),
    funderSignature: spec.funderSignature ?? "0x",
    settlerContext: "0x",
    paymentAmount: 0n,
    paymentRecipient: ZERO,
    // ≥ 33 bytes, with the key hash at [-66,-2] and the prehash byte last.
    signature: `0x${spec.keyHash.slice(2)}00` as Hex,
    paymentSignature: "0x",
    supportedAccountImplementation: ZERO,
  }]);
}

export function encodeExecute(intents: readonly Hex[]): Hex {
  return intents.length === 1 && intents[0] !== undefined
    ? encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [intents[0]] })
    : encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [[...intents]] });
}

function pad(address: Address): Hex {
  return `0x${"0".repeat(24)}${getAddress(address).slice(2).toLowerCase()}` as Hex;
}

function uint(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

export function transferLog(input: {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly logIndex: bigint;
}): QuantReceiptLog {
  return {
    address: getAddress(input.token),
    topics: [TRANSFER_TOPIC, pad(input.from), pad(input.to)],
    data: uint(input.value),
    logIndex: input.logIndex,
  };
}

export function swapLog(input: {
  readonly pair: Address;
  readonly to: Address;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** `true` when the INPUT token is the pair's token0. */
  readonly inputIsToken0: boolean;
  readonly logIndex: bigint;
}): QuantReceiptLog {
  const amounts: readonly bigint[] = input.inputIsToken0
    ? [input.amountIn, 0n, 0n, input.amountOut]
    : [0n, input.amountIn, input.amountOut, 0n];
  return {
    address: getAddress(input.pair),
    topics: [SWAP_TOPIC, pad(input.to), pad(input.to)],
    data: `0x${amounts.map((value) => value.toString(16).padStart(64, "0")).join("")}` as Hex,
    logIndex: input.logIndex,
  };
}

export function intentExecutedLog(input: {
  readonly eoa: Address;
  readonly nonce: bigint;
  readonly incremented: boolean;
  readonly err: Hex;
  readonly logIndex: bigint;
  readonly orchestrator?: Address;
  /**
   * RAW event data, replacing the two well-formed words (audit A5). The only
   * way to build the shapes the decoder refuses STRUCTURALLY — a body that is
   * not 64 bytes — since `err` alone is always padded back to a clean
   * `bytes4` by the encoding above.
   */
  readonly data?: Hex;
}): QuantReceiptLog {
  return {
    address: getAddress(input.orchestrator ?? QUANT_ORCHESTRATOR_56),
    topics: [INTENT_EXECUTED_TOPIC, pad(input.eoa), uint(input.nonce)],
    data: input.data ?? `0x${(input.incremented ? "1" : "0").padStart(64, "0")}${
      input.err.slice(2).padEnd(64, "0")}` as Hex,
    logIndex: input.logIndex,
  };
}

export type ReceiptSpec = {
  readonly input: Hex;
  readonly logs: readonly QuantReceiptLog[];
  readonly status?: bigint;
  readonly to?: Address;
  readonly txHash?: Hex;
  readonly blockNumber?: bigint;
};

export function buildPair(spec: ReceiptSpec): {
  readonly transaction: QuantTransaction;
  readonly receipt: QuantReceipt;
} {
  const txHash = spec.txHash ?? (`0x${"aa".repeat(32)}` as Hex);
  const blockNumber = spec.blockNumber ?? 100n;
  const blockHash = `0x${"bb".repeat(32)}` as Hex;
  return {
    transaction: {
      hash: txHash,
      to: getAddress(spec.to ?? QUANT_ORCHESTRATOR_56),
      input: spec.input,
      blockNumber,
      blockHash,
      transactionIndex: 3n,
    },
    receipt: {
      status: spec.status ?? 1n,
      transactionHash: txHash,
      blockNumber,
      blockHash,
      transactionIndex: 3n,
      logs: spec.logs,
    },
  };
}
