import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  encodeAbiParameters, encodeFunctionData, getAddress, keccak256,
  parseAbi, stringToBytes, type Address, type Hex,
} from "viem";
import { PORTO_V055_INTENT_PARAMETERS } from "../src/lp/intentDecoder.js";
import { PORTO_V055_ORCHESTRATOR } from "../src/lp/preparedIntent.js";
import { INTENT_EXECUTED_TOPIC, SWAP_TOPIC, TRANSFER_TOPIC } from "../src/quant/receipt.js";
import {
  verifyQuantRebalanceReceipt, type RebalancePairIdentity,
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
const PAIR1 = getAddress("0x2000000000000000000000000000000000000002");
const ERC721 = getAddress("0x3000000000000000000000000000000000000001");
const OTHER_POOL = getAddress("0x3000000000000000000000000000000000000002");
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

describe("Quant rebalancing multi-hop receipt proof", () => {
  it("verifies the finalized G2 native-fee bootstrap receipt and refuses unsupported payment shapes", () => {
    // Public tx 0x2f45d94d...a7075a, block 124485633. These decoded intent fields
    // re-encode to the exact on-chain input (SHA-256 pinned below).
    const wallet = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
    const pair = getAddress("0xd99c7F6C65857AC913a8f880A4cb84032AB2FC5b");
    const blockHash = `0xbf220831941db160eef3d54df9d41c5516d8ac9394f034bf6d5a3ab352109c16` as Hex;
    const txHash = `0x2f45d94db35208445e6bd8e69d7a5327092174c4b06f759e30ff96ddb8a7075a` as Hex;
    const keyHash = `0x33adbdeb2d0608da248f76c216b7f858e1702bb031cbac8806b47ce8882b68ef` as Hex;
    const zero = getAddress("0x0000000000000000000000000000000000000000");
    const feeRecipient = getAddress("0xaf089b4eca94a4b2f51d8f5668cff244f2c6c4bc");
    const amountIn = 5n * E18; const amountOut = 6_548_435_509_374_628n;
    const quoteOut = 6_548_439_523_618_091n; const deadlineSec = 1_790_581_480;
    const built = buildRebalanceCalls({ router: REBALANCE_ROUTER,
      path: [REBALANCE_USDC, REBALANCE_WBNB], amountInWei: amountIn, quoteOutWei: quoteOut,
      recipient: wallet, deadlineSec, actionSequence: 1n });
    const executionData = encodeAbiParameters(CALLS_PARAMETERS, [built.calls.map((call) => ({
      target: call.to, value: call.value ?? 0n, data: call.data ?? "0x",
    }))]);
    const liveIntent = {
      eoa: wallet, executionData, nonce: 207n, payer: zero, paymentToken: zero,
      paymentMaxAmount: 27_752_075_000_000n, combinedGas: 0x3f8ddn,
      encodedPreCalls: [] as Hex[], encodedFundTransfers: [] as Hex[], settler: zero,
      expiry: 0n, isMultichain: false, funder: zero, funderSignature: "0x" as Hex,
      settlerContext: "0x" as Hex, paymentAmount: 21_347_750_000_000n,
      paymentRecipient: feeRecipient,
      signature: "0xdba5b185e0b381bd8dca35ab19f4c4811b426406d1961806d22067e9978683b62195b184a7314e43b822e07a65cacbd8dc472a268e88f2eb50393f25c08dd78a1c33adbdeb2d0608da248f76c216b7f858e1702bb031cbac8806b47ce8882b68ef00" as Hex,
      paymentSignature: "0x" as Hex,
      supportedAccountImplementation: getAddress("0x4b5d20cd8a3927b500540d9bccddc27385c9fa79"),
    };
    const encodeInput = (changes: Partial<typeof liveIntent> = {}) => encodeFunctionData({ abi: EXECUTE_ABI,
      functionName: "execute", args: [encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [{ ...liveIntent, ...changes }])] });
    const transactionInput = encodeInput();
    assert.equal(createHash("sha256").update(Buffer.from(transactionInput.slice(2), "hex")).digest("hex"),
      "72619553b5eef28b931eb1091452fb54a544f1732edae2bfbcb24154dc8510c2");
    const callsJson = JSON.stringify(built.calls);
    const action: QuantRebalanceActionRow = { ...createAction([REBALANCE_USDC, REBALANCE_WBNB], [pair],
      REBALANCE_USDC, REBALANCE_WBNB).action,
      amountInWei: amountIn, quoteOutWei: quoteOut, minOutWei: built.minOutWei, deadlineSec,
      callsJson, callsDigest: keccak256(stringToBytes(callsJson)),
      gasEvidenceJson: JSON.stringify({ paymentMaxWei: "27752075000000" }),
      preSubmitBlockNumber: 124485632n, preSubmitBlockHash: blockHash, txHash };
    const approvalTopic = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925" as Hex;
    const approval = (value: bigint, logIndex: bigint) => ({ address: REBALANCE_USDC,
      topics: [approvalTopic, topicAddress(wallet), topicAddress(REBALANCE_ROUTER)] as const,
      data: dataUint(value), logIndex });
    const receipt: QuantReceipt = { status: 1n, transactionHash: txHash,
      blockNumber: 124485633n, blockHash, transactionIndex: 98n, logs: [
        approval(amountIn, 589n), transfer(REBALANCE_USDC, wallet, pair, amountIn, 590n),
        approval(0n, 591n), transfer(REBALANCE_WBNB, pair, wallet, amountOut, 592n),
        { address: pair, topics: ["0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1" as Hex],
          data: encodeAbiParameters([{ type: "uint112" }, { type: "uint112" }],
            [153970888370270596791149n, 202152519425822576232n]), logIndex: 593n },
        swap({ pair, recipient: wallet, amount0In: amountIn, amount1In: 0n,
          amount0Out: 0n, amount1Out: amountOut, logIndex: 594n }),
        approval(0n, 595n), intentEvent(wallet, 207n, 596n),
      ] };
    const transaction: QuantTransaction = { hash: txHash, to: PORTO_V055_ORCHESTRATOR,
      input: transactionInput, blockNumber: receipt.blockNumber, blockHash, transactionIndex: 98n };
    const input = { chainId: 56, transaction, receipt,
      finalized: { finalizedNumber: receipt.blockNumber, finalizedHash: blockHash,
        canonicalReceiptHash: blockHash, canonicalReceiptNumber: receipt.blockNumber },
      action, tradingWallet: wallet, sessionKeyHash: keyHash, persistedCalls: built.calls,
      pairs: [{ address: pair, derivedAddress: pair, factory: REBALANCE_FACTORY,
        token0: REBALANCE_USDC, token1: REBALANCE_WBNB }] };
    const verified = verifyQuantRebalanceReceipt(input);
    assert.equal(verified.ok, true, verified.ok ? "" : verified.code);
    if (verified.ok) {
      assert.equal(verified.proof.fillInWei, amountIn);
      assert.equal(verified.proof.fillOutWei, amountOut);
      assert.deepEqual(verified.proof.swapLogIndices, [594n]);
    }
    for (const changes of [
      { paymentToken: REBALANCE_USDC }, { encodedPreCalls: ["0x1234" as Hex] },
      { encodedFundTransfers: ["0x1234" as Hex] }, { funder: wallet },
    ]) {
      assert.deepEqual(verifyQuantRebalanceReceipt({ ...input,
        transaction: { ...transaction, input: encodeInput(changes) } }),
      { ok: false, code: "rebalance-proof-unsupported-shape" });
    }
    assert.deepEqual(verifyQuantRebalanceReceipt({ ...input,
      action: { ...action, gasEvidenceJson: JSON.stringify({ paymentMaxWei: "21347749999999" }) } }),
    { ok: false, code: "rebalance-proof-unsupported-shape" });
  });

  it("proves a direct swap and allows unrelated other-wallet/ERC-721/other-venue events", () => {
    const amountIn = 10n * E18; const amountOut = 9n * E18;
    const calls = createAction([REBALANCE_USDC, REBALANCE_WBNB], [PAIR0], REBALANCE_USDC, REBALANCE_WBNB).calls;
    const extraIntent = intent(OTHER, 9n, calls);
    const base = [
      transfer(REBALANCE_USDC, WALLET, PAIR0, amountIn, 0n),
      transfer(REBALANCE_WBNB, PAIR0, WALLET, amountOut, 1n),
      swap({ pair: PAIR0, recipient: WALLET, amount0In: amountIn, amount1In: 0n, amount0Out: 0n, amount1Out: amountOut, logIndex: 2n }),
      intentEvent(WALLET, 8n, 3n),
      // A second wallet can share this relay tx without changing our proof.
      transfer(REBALANCE_USDC, OTHER, PAIR0, amountIn, 4n),
      transfer(REBALANCE_WBNB, PAIR0, OTHER, amountOut, 5n),
      swap({ pair: PAIR0, recipient: OTHER, amount0In: amountIn, amount1In: 0n, amount0Out: 0n, amount1Out: amountOut, logIndex: 6n }),
      intentEvent(OTHER, 9n, 7n),
      { address: ERC721, topics: [TRANSFER_TOPIC, topicAddress(OTHER), topicAddress(WALLET), topicUint(1n)] as const, data: "0x" as Hex, logIndex: 8n },
      { address: OTHER_POOL, topics: [SWAP_TOPIC, topicAddress(OTHER), topicAddress(WALLET)] as const, data: "0x" as Hex, logIndex: 9n },
    ];
    const scenario = verifierInput({ path: [REBALANCE_USDC, REBALANCE_WBNB], pairs: [PAIR0], logs: base, extraIntents: [extraIntent] });
    const result = verifyQuantRebalanceReceipt(scenario.input);
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (result.ok) {
      assert.deepEqual(result.proof.swapLogIndices, [2n]);
      assert.equal(result.ownership.length, 1);
    }
    const wrongToken1 = scenario.input.pairs.map((pair) => ({ ...pair, token1: OTHER }));
    const wrongPair = verifyQuantRebalanceReceipt({ ...scenario.input, pairs: wrongToken1 });
    assert.equal(wrongPair.ok, false);
    if (!wrongPair.ok) assert.equal(wrongPair.code, "rebalance-proof-pair-mismatch");
  });

  it("walks every USDT intermediate Transfer/Swap hop and rejects same-wallet double intents", () => {
    const amountIn = 10n * E18; const intermediate = 9n * E18; const amountOut = 9n * E18;
    const path = [REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB] as const;
    const logs = [
      transfer(REBALANCE_USDC, WALLET, PAIR0, amountIn, 0n),
      transfer(REBALANCE_USDT, PAIR0, PAIR1, intermediate, 1n),
      swap({ pair: PAIR0, recipient: PAIR1, amount0In: amountIn, amount1In: 0n, amount0Out: 0n, amount1Out: intermediate, logIndex: 2n }),
      transfer(REBALANCE_WBNB, PAIR1, WALLET, amountOut, 3n),
      swap({ pair: PAIR1, recipient: WALLET, amount0In: intermediate, amount1In: 0n, amount0Out: 0n, amount1Out: amountOut, logIndex: 4n }),
      intentEvent(WALLET, 8n, 5n),
    ];
    const scenario = verifierInput({ path, pairs: [PAIR0, PAIR1], logs });
    const result = verifyQuantRebalanceReceipt(scenario.input);
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (result.ok) {
      assert.deepEqual(result.proof.swapLogIndices, [2n, 4n]);
      assert.equal(result.ownership.length, 2);
    }
    const double = verifierInput({ path: [REBALANCE_USDC, REBALANCE_WBNB], pairs: [PAIR0],
      logs: [...logs, intentEvent(WALLET, 10n, 6n)], extraIntents: [intent(WALLET, 10n, scenario.calls)] });
    assert.deepEqual(verifyQuantRebalanceReceipt(double.input), { ok: false, code: "rebalance-proof-ambiguous" });
  });

  it("refuses extra monitored wallet transfers and non-finalized receipts", () => {
    const amountIn = 10n * E18; const amountOut = 9n * E18;
    const logs = [
      transfer(REBALANCE_USDC, WALLET, PAIR0, amountIn, 0n),
      transfer(REBALANCE_WBNB, PAIR0, WALLET, amountOut, 1n),
      transfer(REBALANCE_USDT, WALLET, OTHER, 1n, 2n),
      swap({ pair: PAIR0, recipient: WALLET, amount0In: amountIn, amount1In: 0n, amount0Out: 0n, amount1Out: amountOut, logIndex: 3n }),
      intentEvent(WALLET, 8n, 4n),
    ];
    const scenario = verifierInput({ path: [REBALANCE_USDC, REBALANCE_WBNB], pairs: [PAIR0], logs });
    assert.deepEqual(verifyQuantRebalanceReceipt(scenario.input), { ok: false, code: "rebalance-proof-extra-wallet-transfer" });
    assert.deepEqual(verifyQuantRebalanceReceipt({ ...scenario.input,
      finalized: { ...scenario.input.finalized, finalizedNumber: 99n } }), { ok: false, code: "rebalance-proof-unfinalized" });
  });
});
