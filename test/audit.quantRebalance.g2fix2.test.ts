/** Independent G2 fix 2 payment-bound and accounting regressions. Offline only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256,
  parseAbi, stringToBytes, type Address, type Hex,
} from "viem";
import { PORTO_V055_INTENT_PARAMETERS } from "../src/lp/intentDecoder.js";
import { PORTO_V055_ORCHESTRATOR } from "../src/lp/preparedIntent.js";
import { INTENT_EXECUTED_TOPIC, SWAP_TOPIC, TRANSFER_TOPIC } from "../src/quant/receipt.js";
import {
  verifyQuantRebalanceReceipt, verifyQuantRebalanceSubmittedFailure, type RebalancePairIdentity,
} from "../src/quant/rebalanceReceipt.js";
import { buildRebalanceCalls } from "../src/quant/rebalanceRoutes.js";
import {
  REBALANCE_FACTORY, REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB,
} from "../src/quant/rebalancePolicy.js";
import type { QuantRebalanceActionRow } from "../src/quant/rebalanceTypes.js";
import type { WalletCall } from "../src/core/types.js";
import type { QuantReceipt, QuantTransaction } from "../src/quant/receipt.js";

const WALLET = getAddress("0x1000000000000000000000000000000000000001");
const OTHER = getAddress("0x1000000000000000000000000000000000000002");
const KEY_HASH = `0x${"11".repeat(32)}` as Hex;
const TX_HASH = `0x${"22".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"33".repeat(32)}` as Hex;
const PAIR0 = getAddress("0x2000000000000000000000000000000000000001");
const EXECUTE_ABI = parseAbi(["function execute(bytes encodedIntent) payable returns (bytes4 err)"]);
const EXECUTE_BATCH_ABI = parseAbi(["function execute(bytes[] encodedIntents) payable returns (bytes4[] errs)"]);
const CALLS_PARAMETERS = [{ type: "tuple[]", components: [
  { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
] }] as const;
const E18 = 10n ** 18n;

function topicAddress(value: Address): Hex { return `0x${value.slice(2).toLowerCase().padStart(64, "0")}` as Hex; }
function topicUint(value: bigint): Hex { return `0x${value.toString(16).padStart(64, "0")}` as Hex; }
function dataUint(value: bigint): Hex { return `0x${value.toString(16).padStart(64, "0")}` as Hex; }
function transfer(address: Address, from: Address, to: Address, value: bigint, logIndex: bigint) {
  return { address, topics: [TRANSFER_TOPIC, topicAddress(from), topicAddress(to)] as const, data: dataUint(value), logIndex };
}
function swap(input: { readonly pair: Address; readonly recipient: Address; readonly amount0In: bigint; readonly amount1In: bigint; readonly amount0Out: bigint; readonly amount1Out: bigint; readonly logIndex: bigint }) {
  const data = `0x${[input.amount0In, input.amount1In, input.amount0Out, input.amount1Out].map((x) => x.toString(16).padStart(64, "0")).join("")}` as Hex;
  return { address: input.pair, topics: [SWAP_TOPIC, topicAddress(REBALANCE_ROUTER), topicAddress(input.recipient)] as const, data, logIndex: input.logIndex };
}
function intent(wallet: Address, nonce: bigint, calls: readonly WalletCall[]) {
  const executionData = encodeAbiParameters(CALLS_PARAMETERS, [calls.map((call) => ({
    target: call.to, value: call.value ?? 0n, data: call.data ?? "0x",
  }))]);
  const tuple = {
    eoa: wallet, executionData, nonce,
    payer: "0x0000000000000000000000000000000000000000" as Address,
    paymentToken: "0x0000000000000000000000000000000000000000" as Address,
    paymentMaxAmount: 0n, combinedGas: 0n, encodedPreCalls: [] as const,
    encodedFundTransfers: [] as const, settler: "0x0000000000000000000000000000000000000000" as Address,
    expiry: 0n, isMultichain: false,
    funder: "0x0000000000000000000000000000000000000000" as Address,
    funderSignature: "0x" as Hex, settlerContext: "0x" as Hex,
    paymentAmount: 0n, paymentRecipient: "0x0000000000000000000000000000000000000000" as Address,
    signature: `0x00${KEY_HASH.slice(2)}00` as Hex, paymentSignature: "0x" as Hex,
    supportedAccountImplementation: "0x0000000000000000000000000000000000000000" as Address,
  };
  return encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [tuple]);
}
function intentEvent(wallet: Address, nonce: bigint, index: bigint) {
  return { address: PORTO_V055_ORCHESTRATOR,
    topics: [INTENT_EXECUTED_TOPIC, topicAddress(wallet), topicUint(nonce)] as const,
    data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [true, "0x00000000"]), logIndex: index };
}

function createAction(path: readonly Address[], pairs: readonly Address[], tokenIn: Address, tokenOut: Address): { action: QuantRebalanceActionRow; calls: readonly WalletCall[]; pairFacts: readonly RebalancePairIdentity[] } {
  const amountInWei = 10n * E18; const quoteOutWei = 9n * E18; const sequence = 1n;
  const built = buildRebalanceCalls({ router: REBALANCE_ROUTER, path, amountInWei, quoteOutWei,
    recipient: WALLET, deadlineSec: 1_800_000_100, actionSequence: sequence });
  const callsJson = JSON.stringify(built.calls);
  const action = {
    actionId: "action-proof", journalKey: "journal-proof", jobId: "job-proof", checkId: "check-proof", sequence,
    plannedAccountingRev: 0n, plannedCheckVersion: 1, state: "submitted" as const, side: "buy" as const,
    asset: tokenOut === REBALANCE_WBNB ? "WBNB" as const : "WBNB" as const,
    tokenIn, tokenOut, path, pairAddresses: pairs, amountInWei, minOutWei: built.minOutWei, quoteOutWei,
    deadlineSec: 1_800_000_100, callsJson, callsDigest: keccak256(stringToBytes(callsJson)),
    policyDigest: KEY_HASH, permissionsDigest: KEY_HASH, projectionDigest: KEY_HASH, claimGeneration: 1n,
    quoteBlockNumber: 100n, quoteBlockHash: BLOCK_HASH, quoteObservedAtMs: 1_800_000_000_000,
    referenceBlockNumber: 100n, referenceBlockHash: BLOCK_HASH, referenceObservedAtMs: 1_800_000_000_000,
    referenceEvidenceJson: "{}", gasEvidenceJson: "{}", preSubmitBlockNumber: 99n, preSubmitBlockHash: BLOCK_HASH,
    txHash: null, fillInWei: null, fillOutWei: null, receiptBlockNumber: null, receiptBlockHash: null,
    swapLogIndices: [], proofDigest: null, reservationWei: amountInWei, failureCode: null, ambiguousCause: null,
    resolutionJson: null, rowVersion: 2, createdAtMs: 1_800_000_000_000, updatedAtMs: 1_800_000_000_000,
  } satisfies QuantRebalanceActionRow;
  const pairsFacts = path.slice(0, -1).map((from, index) => {
    const to = path[index + 1]!;
    const address = pairs[index]!;
    return { address, derivedAddress: address, factory: REBALANCE_FACTORY, token0: from, token1: to };
  });
  return { action, calls: built.calls, pairFacts: pairsFacts };
}

function verifierInput(input: {
  readonly path: readonly Address[]; readonly pairs: readonly Address[];
  readonly logs: QuantReceipt["logs"]; readonly wallet?: Address; readonly extraIntents?: readonly Hex[];
}) {
  const wallet = input.wallet ?? WALLET;
  const { action, calls, pairFacts } = createAction(input.path, input.pairs, input.path[0]!, input.path.at(-1)!);
  const intentData = intent(wallet, 8n, calls);
  const transactionInput = input.extraIntents === undefined || input.extraIntents.length === 0
    ? encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [intentData] })
    : encodeFunctionData({ abi: EXECUTE_BATCH_ABI, functionName: "execute", args: [[intentData, ...input.extraIntents]] });
  const transaction: QuantTransaction = { hash: TX_HASH, to: PORTO_V055_ORCHESTRATOR, input: transactionInput,
    blockNumber: 100n, blockHash: BLOCK_HASH, transactionIndex: 0n };
  const receipt: QuantReceipt = { status: 1n, transactionHash: TX_HASH, blockNumber: 100n,
    blockHash: BLOCK_HASH, transactionIndex: 0n, logs: input.logs };
  return { action, calls, pairFacts, input: {
    chainId: 56, transaction, receipt,
    finalized: { finalizedNumber: 101n, finalizedHash: `0x${"44".repeat(32)}` as Hex,
      canonicalReceiptHash: BLOCK_HASH, canonicalReceiptNumber: 100n },
    action, tradingWallet: wallet, sessionKeyHash: KEY_HASH, persistedCalls: calls,
    pairs: pairFacts, currentTimeMs: 1_800_000_000_000,
  } };
}

function paidFixture() {
  const logs = [
    transfer(REBALANCE_USDC, WALLET, PAIR0, 10n * E18, 0n),
    transfer(REBALANCE_WBNB, PAIR0, WALLET, 9n * E18, 1n),
    swap({ pair: PAIR0, recipient: WALLET, amount0In: 10n * E18, amount1In: 0n,
      amount0Out: 0n, amount1Out: 9n * E18, logIndex: 2n }),
    intentEvent(WALLET, 8n, 3n),
  ];
  const { input } = verifierInput({ path: [REBALANCE_USDC, REBALANCE_WBNB], pairs: [PAIR0], logs });
  const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: input.transaction.input });
  const [tuple] = decodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, decoded.args[0]);
  const paid = { ...tuple, paymentAmount: 21_347_750_000_000n,
    paymentMaxAmount: 27_752_075_000_000n, paymentRecipient: OTHER };
  const encode = (changes: Partial<typeof paid> = {}) => encodeFunctionData({ abi: EXECUTE_ABI,
    functionName: "execute", args: [encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [{ ...paid, ...changes }])] });
  return { encode, paid, input: { ...input,
    action: { ...input.action, gasEvidenceJson: JSON.stringify({ paymentMaxWei: paid.paymentMaxAmount.toString() }) },
    transaction: { ...input.transaction, input: encode() } } };
}

test("G2 fix2: bounded native fee never contributes to USDC/WBNB fills", () => {
  const f = paidFixture();
  for (const paymentAmount of [1n, f.paid.paymentAmount, f.paid.paymentMaxAmount]) {
    const result = verifyQuantRebalanceReceipt({ ...f.input,
      transaction: { ...f.input.transaction, input: f.encode({ paymentAmount }) } });
    assert(result.ok);
    assert.equal(result.proof.fillInWei, 10n * E18);
    assert.equal(result.proof.fillOutWei, 9n * E18);
    assert.deepEqual(result.proof.swapLogIndices, [2n]);
  }
});

test("G2 fix2: absent stored quote MUST refuse an unbounded paid success", () => {
  const f = paidFixture();
  const result = verifyQuantRebalanceReceipt({ ...f.input,
    action: { ...f.input.action, gasEvidenceJson: "{}" },
    transaction: { ...f.input.transaction, input: f.encode({ paymentAmount: E18, paymentMaxAmount: E18 }) } });
  assert.deepEqual(result, { ok: false, code: "rebalance-proof-unsupported-shape" });
});

test("G2 fix2: absent stored quote MUST refuse an unbounded paid failure", () => {
  const f = paidFixture();
  const result = verifyQuantRebalanceSubmittedFailure({ ...f.input,
    wallet: WALLET, keyHash: KEY_HASH, calls: f.input.persistedCalls,
    action: { ...f.input.action, gasEvidenceJson: "{}" },
    transaction: { ...f.input.transaction, input: f.encode({ paymentAmount: E18, paymentMaxAmount: E18 }) },
    receipt: { ...f.input.receipt, logs: [{ ...intentEvent(WALLET, 8n, 3n),
      data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [true, "0xdeadbeef"]) }] } });
  assert.equal(result, null);
});

test("G2 fix2: malformed quote maxima and the one-wei-over boundary refuse", () => {
  const f = paidFixture();
  for (const gasEvidenceJson of ["null", "[]", "broken", ...[null, 27_752_075_000_000, "", "-1", "01", "1e30",
    "0", (f.paid.paymentMaxAmount - 1n).toString()].map((paymentMaxWei) => JSON.stringify({ paymentMaxWei }))]) {
    assert.deepEqual(verifyQuantRebalanceReceipt({ ...f.input,
      action: { ...f.input.action, gasEvidenceJson } }), { ok: false, code: "rebalance-proof-unsupported-shape" });
  }
});

test("G2 fix2: unsupported payment/funding shapes still refuse", () => {
  const f = paidFixture();
  for (const changes of [
    { paymentAmount: f.paid.paymentMaxAmount + 1n }, { paymentToken: REBALANCE_USDC },
    { paymentToken: REBALANCE_WBNB }, { paymentSignature: "0x01" as Hex },
    { funder: OTHER }, { funderSignature: "0x01" as Hex },
    { encodedPreCalls: ["0x1234" as Hex] }, { encodedFundTransfers: ["0x1234" as Hex] },
    { paymentAmount: 0n },
  ]) {
    assert.deepEqual(verifyQuantRebalanceReceipt({ ...f.input,
      transaction: { ...f.input.transaction, input: f.encode(changes) } }),
    { ok: false, code: "rebalance-proof-unsupported-shape" });
  }
});

test("G2 fix2: paid receipt still binds wallet, key, calls, pairs and amounts", () => {
  const f = paidFixture();
  for (const changes of [{ eoa: OTHER }, { signature: `0x00${TX_HASH.slice(2)}00` as Hex },
    { executionData: encodeAbiParameters(CALLS_PARAMETERS, [[]]) }]) {
    assert.equal(verifyQuantRebalanceReceipt({ ...f.input,
      transaction: { ...f.input.transaction, input: f.encode(changes) } }).ok, false);
  }
  assert.equal(verifyQuantRebalanceReceipt({ ...f.input,
    pairs: [{ ...f.input.pairs[0]!, address: OTHER }] }).ok, false);
  assert.equal(verifyQuantRebalanceReceipt({ ...f.input,
    action: { ...f.input.action, amountInWei: 10n * E18 + 1n } }).ok, false);
  for (const logIndex of [0n, 1n]) {
    assert.equal(verifyQuantRebalanceReceipt({ ...f.input, receipt: { ...f.input.receipt,
      logs: f.input.receipt.logs.map((log) => log.logIndex === logIndex ? { ...log, data: dataUint(1n) } : log) } }).ok, false);
  }
});

test("G2 fix2: a paid success still requires the correct successful intent result", () => {
  const f = paidFixture();
  for (const event of [intentEvent(OTHER, 8n, 3n), intentEvent(WALLET, 9n, 3n),
    { ...intentEvent(WALLET, 8n, 3n), data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [false, "0x00000000"]) },
    { ...intentEvent(WALLET, 8n, 3n), data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [true, "0xdeadbeef"]) }]) {
    assert.equal(verifyQuantRebalanceReceipt({ ...f.input, receipt: { ...f.input.receipt,
      logs: [...f.input.receipt.logs.slice(0, 3), event] } }).ok, false);
  }
});

test("G2 fix2: extra managed-token fee legs cannot enter settlement", () => {
  const f = paidFixture();
  for (const token of [REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_USDT]) {
    assert.deepEqual(verifyQuantRebalanceReceipt({ ...f.input, receipt: { ...f.input.receipt,
      logs: [...f.input.receipt.logs, transfer(token, WALLET, OTHER, f.paid.paymentAmount, 4n)] } }),
    { ok: false, code: "rebalance-proof-extra-wallet-transfer" });
  }
});

