/** Canonical finalized V2 direct/two-hop receipt proof for Quant rebalancing. */
import {
  decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, stringToBytes,
  type Address, type Hex,
} from "viem";
import type { WalletCall } from "../core/types.js";
import { PORTO_V055_INTENT_PARAMETERS } from "../lp/intentDecoder.js";
import { PORTO_V055_ORCHESTRATOR } from "../lp/preparedIntent.js";
import type { QuantRebalanceActionRow, QuantRebalanceReceiptOwnership } from "./rebalanceTypes.js";
import {
  brandVerifiedFailureProof, brandVerifiedReceiptProof,
  type VerifiedQuantRebalanceFailureProof, type VerifiedQuantRebalanceReceiptProof,
} from "../store/quantRebalanceProof.js";
export { isVerifiedQuantRebalanceFailureProof, isVerifiedQuantRebalanceReceiptProof } from "../store/quantRebalanceProof.js";
import { QUANT_ORCHESTRATOR_56, INTENT_EXECUTED_TOPIC, SWAP_TOPIC, TRANSFER_TOPIC,
  INTENT_SUCCESS_ERR, decodeExecutionCalls, callsEqual } from "./receipt.js";
import {
  REBALANCE_FACTORY, REBALANCE_ROUTER, REBALANCE_TOKEN_ADDRESSES,
} from "./rebalancePolicy.js";
import { buildRebalanceCalls, validateRebalancePath } from "./rebalanceRoutes.js";
import type { QuantReceipt, QuantTransaction } from "./receipt.js";

const EXECUTE_ABI = parseAbi([
  "function execute(bytes encodedIntent) payable returns (bytes4 err)",
  "function execute(bytes[] encodedIntents) payable returns (bytes4[] errs)",
]);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const MAX_LOGS = 4_096;
export type RebalancePairIdentity = {
  readonly address: Address;
  readonly factory: Address;
  readonly derivedAddress: Address;
  readonly token0: Address;
  readonly token1: Address;
};

export type RebalanceFinalityEvidence = {
  readonly finalizedNumber: bigint;
  readonly finalizedHash: Hex;
  readonly canonicalReceiptHash: Hex;
  readonly canonicalReceiptNumber: bigint;
};

type DecodedIntent = {
  readonly index: number;
  readonly wallet: Address;
  readonly nonce: bigint;
  readonly keyHash: Hex;
  readonly calls: readonly WalletCall[];
  readonly preCallCount: number;
  readonly fundTransferCount: number;
  readonly funder: Address;
  readonly funderSignatureBytes: number;
  readonly paymentAmount: bigint;
  readonly paymentMaxAmount: bigint;
  readonly paymentToken: Address;
  readonly paymentRecipient: Address;
  readonly paymentSignatureBytes: number;
};

type IntentEvent = { readonly wallet: Address; readonly nonce: bigint; readonly incremented: boolean; readonly err: Hex };
type TransferEvent = { readonly token: Address; readonly from: Address; readonly to: Address; readonly amount: bigint; readonly logIndex: bigint };
type SwapEvent = { readonly pair: Address; readonly sender: Address; readonly recipient: Address; readonly amount0In: bigint; readonly amount1In: bigint; readonly amount0Out: bigint; readonly amount1Out: bigint; readonly logIndex: bigint };

export type RebalanceReceiptFailureCode =
  | "rebalance-proof-chain" | "rebalance-proof-orchestrator" | "rebalance-proof-receipt-mismatch"
  | "rebalance-proof-unfinalized" | "rebalance-proof-reverted" | "rebalance-proof-unsupported-shape"
  | "rebalance-proof-undecodable" | "rebalance-proof-calls-mismatch" | "rebalance-proof-key-mismatch"
  | "rebalance-proof-intent-failed" | "rebalance-proof-ambiguous" | "rebalance-proof-pair-mismatch"
  | "rebalance-proof-legs-missing" | "rebalance-proof-amount-mismatch" | "rebalance-proof-extra-wallet-transfer";

export type RebalanceReceiptVerification =
  | { readonly ok: true; readonly proof: VerifiedQuantRebalanceReceiptProof; readonly ownership: readonly QuantRebalanceReceiptOwnership[] }
  | { readonly ok: false; readonly code: RebalanceReceiptFailureCode };

function fail(code: RebalanceReceiptFailureCode): RebalanceReceiptVerification { return { ok: false, code }; }
function addressEqual(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function validHex(value: string, bytes: number): boolean { return new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`, "u").test(value); }

function decodeIntents(data: Hex): readonly DecodedIntent[] | null {
  let decoded: ReturnType<typeof decodeFunctionData<typeof EXECUTE_ABI>>;
  try { decoded = decodeFunctionData({ abi: EXECUTE_ABI, data }); } catch { return null; }
  const arg = decoded.args[0]; const members = Array.isArray(arg) ? arg : [arg];
  if (members.length === 0 || members.length > 32) return null;
  try {
    const canonical = encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [arg] } as never);
    if (canonical.toLowerCase() !== data.toLowerCase()) return null;
  } catch { return null; }
  const result: DecodedIntent[] = [];
  for (const [index, member] of members.entries()) {
    try {
      const [intent] = decodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, member as Hex);
      if ((intent.signature.length - 2) / 2 < 33) return null;
      const calls = decodeExecutionCalls(intent.executionData);
      if (calls === null) return null;
      result.push({
        index, wallet: getAddress(intent.eoa), nonce: intent.nonce,
        keyHash: `0x${intent.signature.slice(-66, -2)}`.toLowerCase() as Hex,
        calls, preCallCount: intent.encodedPreCalls.length, fundTransferCount: intent.encodedFundTransfers.length,
        funder: getAddress(intent.funder), funderSignatureBytes: (intent.funderSignature.length - 2) / 2,
        paymentAmount: intent.paymentAmount, paymentMaxAmount: intent.paymentMaxAmount,
        paymentToken: getAddress(intent.paymentToken),
        paymentRecipient: getAddress(intent.paymentRecipient), paymentSignatureBytes: (intent.paymentSignature.length - 2) / 2,
      });
    } catch { return null; }
  }
  return result;
}

function nativePaymentSupported(intent: DecodedIntent, action: QuantRebalanceActionRow): boolean {
  if (!addressEqual(intent.paymentToken, ZERO) || intent.paymentSignatureBytes !== 0) return false;
  if (intent.paymentAmount === 0n) return addressEqual(intent.paymentRecipient, ZERO);
  if (intent.paymentAmount < 0n || intent.paymentMaxAmount < intent.paymentAmount) return false;
  try {
    const evidence: unknown = JSON.parse(action.gasEvidenceJson);
    if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return false;
    const storedMax = (evidence as Record<string, unknown>)["paymentMaxWei"];
    if (storedMax === undefined) return false;
    return typeof storedMax === "string" && /^(0|[1-9][0-9]*)$/u.test(storedMax)
      && intent.paymentMaxAmount <= BigInt(storedMax);
  } catch { return false; }
}

function topicAddress(topic: Hex | undefined): Address | null {
  if (topic === undefined || !validHex(topic, 32)) return null;
  try { return getAddress(`0x${topic.slice(-40)}`); } catch { return null; }
}
function uintData(data: Hex): bigint | null {
  if (!validHex(data, 32)) return null;
  try { const [amount] = decodeAbiParameters([{ type: "uint256" }], data); return amount; } catch { return null; }
}
function decodeTransfer(log: QuantReceipt["logs"][number]): TransferEvent | null {
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase() || log.topics.length !== 3) return null;
  const from = topicAddress(log.topics[1]); const to = topicAddress(log.topics[2]); const amount = uintData(log.data);
  if (from === null || to === null || amount === null || amount <= 0n) return null;
  return { token: getAddress(log.address), from, to, amount, logIndex: log.logIndex };
}
function decodeSwap(log: QuantReceipt["logs"][number]): SwapEvent | null {
  if (log.topics[0]?.toLowerCase() !== SWAP_TOPIC.toLowerCase() || log.topics.length !== 3 || !validHex(log.data, 128)) return null;
  const sender = topicAddress(log.topics[1]); const recipient = topicAddress(log.topics[2]);
  if (sender === null || recipient === null) return null;
  try {
    const [amount0In, amount1In, amount0Out, amount1Out] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], log.data,
    );
    return { pair: getAddress(log.address), sender, recipient, amount0In, amount1In, amount0Out, amount1Out, logIndex: log.logIndex };
  } catch { return null; }
}
function decodeIntentEvent(log: QuantReceipt["logs"][number]): IntentEvent | null | "malformed" {
  if (!addressEqual(log.address, QUANT_ORCHESTRATOR_56) || log.topics[0]?.toLowerCase() !== INTENT_EXECUTED_TOPIC.toLowerCase()) return null;
  if (log.topics.length !== 3 || !validHex(log.data, 64)) return "malformed";
  const wallet = topicAddress(log.topics[1]); const nonceTopic = log.topics[2];
  if (wallet === null || nonceTopic === undefined) return "malformed";
  try {
    const [incremented, err] = decodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], log.data);
    return { wallet, nonce: BigInt(nonceTopic), incremented, err: err.toLowerCase() as Hex };
  } catch { return "malformed"; }
}

function pairAmounts(swap: SwapEvent, identity: RebalancePairIdentity, tokenIn: Address, tokenOut: Address): { readonly input: bigint; readonly output: bigint } | null {
  const t0 = identity.token0.toLowerCase(); const i = tokenIn.toLowerCase(); const o = tokenOut.toLowerCase();
  if (identity.token1.toLowerCase() === i && t0 === o) {
    if (swap.amount1In <= 0n || swap.amount0In !== 0n || swap.amount1Out !== 0n || swap.amount0Out <= 0n) return null;
    return { input: swap.amount1In, output: swap.amount0Out };
  }
  if (t0 === i && identity.token1.toLowerCase() === o) {
    if (swap.amount0In <= 0n || swap.amount1In !== 0n || swap.amount0Out !== 0n || swap.amount1Out <= 0n) return null;
    return { input: swap.amount0In, output: swap.amount1Out };
  }
  return null;
}

function validatePairVector(input: {
  readonly path: readonly Address[];
  readonly pairAddresses: readonly Address[];
  readonly pairs: readonly RebalancePairIdentity[];
}): boolean {
  if (input.path.length < 2 || input.path.length > 3 || input.pairAddresses.length !== input.path.length - 1 || input.pairs.length !== input.pairAddresses.length) return false;
  for (let index = 0; index < input.pairAddresses.length; index += 1) {
    const pair = input.pairs[index]; const from = input.path[index]; const to = input.path[index + 1];
    if (pair === undefined || from === undefined || to === undefined
      || !addressEqual(pair.factory, REBALANCE_FACTORY) || !addressEqual(pair.address, input.pairAddresses[index] ?? ZERO)
      || !addressEqual(pair.derivedAddress, pair.address)
      || !new Set([from.toLowerCase(), to.toLowerCase()]).has(pair.token0.toLowerCase())
      || !new Set([from.toLowerCase(), to.toLowerCase()]).has(pair.token1.toLowerCase())
      || addressEqual(pair.token0, pair.token1)) return false;
  }
  return new Set(input.pairAddresses.map((pair) => pair.toLowerCase())).size === input.pairAddresses.length;
}

export function verifyQuantRebalanceReceipt(input: {
  readonly chainId: number;
  readonly transaction: QuantTransaction;
  readonly receipt: QuantReceipt;
  readonly finalized: RebalanceFinalityEvidence;
  readonly action: QuantRebalanceActionRow;
  readonly tradingWallet: Address;
  readonly sessionKeyHash: Hex;
  readonly persistedCalls: readonly WalletCall[];
  readonly pairs: readonly RebalancePairIdentity[];
}): RebalanceReceiptVerification {
  if (input.chainId !== 56) return fail("rebalance-proof-chain");
  const tx = input.transaction; const receipt = input.receipt; const wallet = getAddress(input.tradingWallet);
  if (tx.to === null || !addressEqual(tx.to, PORTO_V055_ORCHESTRATOR)
    || !addressEqual(tx.to, QUANT_ORCHESTRATOR_56)) return fail("rebalance-proof-orchestrator");
  if (!addressEqual(receipt.transactionHash, tx.hash) || receipt.blockNumber !== tx.blockNumber
    || !addressEqual(receipt.blockHash, tx.blockHash) || receipt.transactionIndex !== tx.transactionIndex) return fail("rebalance-proof-receipt-mismatch");
  if (receipt.status !== 1n) return fail("rebalance-proof-reverted");
  if (input.finalized.finalizedNumber < receipt.blockNumber || input.finalized.canonicalReceiptNumber !== receipt.blockNumber
    || !addressEqual(input.finalized.canonicalReceiptHash, receipt.blockHash)
    || input.finalized.finalizedNumber < 0n || !validHex(input.finalized.finalizedHash, 32)) return fail("rebalance-proof-unfinalized");
  if (receipt.logs.length > MAX_LOGS || receipt.logs.some((log) => log.logIndex < 0n)
    || new Set(receipt.logs.map((log) => log.logIndex.toString(10))).size !== receipt.logs.length) return fail("rebalance-proof-undecodable");
  const intents = decodeIntents(tx.input);
  if (intents === null) return fail("rebalance-proof-undecodable");
  const mine = intents.filter((intent) => addressEqual(intent.wallet, wallet));
  if (mine.length !== 1) return fail("rebalance-proof-ambiguous");
  const intent = mine[0]; if (intent === undefined) return fail("rebalance-proof-ambiguous");
  if (!addressEqual(intent.keyHash, input.sessionKeyHash)) return fail("rebalance-proof-key-mismatch");
  if (!callsEqual(intent.calls, input.persistedCalls) || !callsEqual(intent.calls, actionCalls(input.action))) return fail("rebalance-proof-calls-mismatch");
  if (intent.preCallCount !== 0 || intent.fundTransferCount !== 0 || intent.funderSignatureBytes !== 0
    || !addressEqual(intent.funder, ZERO) || !nativePaymentSupported(intent, input.action)) return fail("rebalance-proof-unsupported-shape");
  const decodedEvents = receipt.logs.map(decodeIntentEvent);
  if (decodedEvents.some((event) => event === "malformed")) return fail("rebalance-proof-undecodable");
  const paired = decodedEvents.filter((event): event is IntentEvent => event !== null && event !== "malformed"
    && addressEqual(event.wallet, wallet) && event.nonce === intent.nonce);
  if (paired.length !== 1) return fail("rebalance-proof-ambiguous");
  if (paired[0]?.incremented !== true || paired[0]?.err !== INTENT_SUCCESS_ERR) return fail("rebalance-proof-intent-failed");
  const path = input.action.path.map((token) => getAddress(token));
  if (path.length < 2 || input.action.pairAddresses.length !== path.length - 1
    || validateRebalancePath(path, { from: input.action.tokenIn, to: input.action.tokenOut }) === null
    || !validatePairVector({ path, pairAddresses: input.action.pairAddresses, pairs: input.pairs })) return fail("rebalance-proof-pair-mismatch");
  if (!addressEqual(path[0] ?? ZERO, input.action.tokenIn) || !addressEqual(path.at(-1) ?? ZERO, input.action.tokenOut)
    || input.action.amountInWei <= 0n || input.action.minOutWei <= 0n) return fail("rebalance-proof-calls-mismatch");
  const rebuilt = buildRebalanceCalls({ router: REBALANCE_ROUTER, path, amountInWei: input.action.amountInWei,
    quoteOutWei: input.action.quoteOutWei, recipient: wallet, deadlineSec: input.action.deadlineSec,
    actionSequence: input.action.sequence });
  if (rebuilt.minOutWei !== input.action.minOutWei || !callsEqual(rebuilt.calls, input.persistedCalls)) return fail("rebalance-proof-calls-mismatch");
  const sortedLogs = [...receipt.logs].sort((a, b) => a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : 0);
  const watched = new Set(Object.values(REBALANCE_TOKEN_ADDRESSES).map((token) => token.toLowerCase()));
  const expectedPairs = new Set(input.action.pairAddresses.map((pair) => pair.toLowerCase()));
  const transfers: TransferEvent[] = [];
  const swaps: SwapEvent[] = [];
  for (const log of sortedLogs) {
    if (log.topics[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase() && watched.has(log.address.toLowerCase())) {
      const transfer = decodeTransfer(log); if (transfer === null) return fail("rebalance-proof-undecodable");
      transfers.push(transfer);
    }
    if (log.topics[0]?.toLowerCase() === SWAP_TOPIC.toLowerCase() && expectedPairs.has(log.address.toLowerCase())) {
      const swap = decodeSwap(log); if (swap === null) return fail("rebalance-proof-undecodable");
      swaps.push(swap);
    }
  }
  const walletTransfers = transfers.filter((row) => watched.has(row.token.toLowerCase())
    && (addressEqual(row.from, wallet) || addressEqual(row.to, wallet)));
  const firstPair = input.action.pairAddresses[0]; const lastPair = input.action.pairAddresses.at(-1);
  if (firstPair === undefined || lastPair === undefined) return fail("rebalance-proof-pair-mismatch");
  const walletInputs = walletTransfers.filter((row) => addressEqual(row.token, input.action.tokenIn)
    && addressEqual(row.from, wallet) && addressEqual(row.to, firstPair) && row.amount === input.action.amountInWei);
  if (walletInputs.length !== 1) return fail("rebalance-proof-legs-missing");
  const chain: { readonly swaps: SwapEvent[]; readonly outputs: TransferEvent[]; readonly amounts: { readonly input: bigint; readonly output: bigint }[] }[] = [];
  const search = (hop: number, previousOut: bigint, selectedSwaps: SwapEvent[], selectedOutputs: TransferEvent[], amounts: { readonly input: bigint; readonly output: bigint }[]): void => {
    if (hop >= input.action.pairAddresses.length) { chain.push({ swaps: selectedSwaps, outputs: selectedOutputs, amounts }); return; }
    const pairAddress = input.action.pairAddresses[hop]; const identity = input.pairs[hop];
    const tokenIn = path[hop]; const tokenOut = path[hop + 1]; const recipient = hop + 1 < path.length - 1 ? input.action.pairAddresses[hop + 1] : wallet;
    if (pairAddress === undefined || identity === undefined || tokenIn === undefined || tokenOut === undefined || recipient === undefined) return;
    const expectedIn = hop === 0 ? input.action.amountInWei : previousOut;
    const candidates = swaps.filter((swap) => addressEqual(swap.pair, pairAddress) && addressEqual(swap.sender, REBALANCE_ROUTER)
      && addressEqual(swap.recipient, recipient)).map((swap) => ({ swap, amount: pairAmounts(swap, identity, tokenIn, tokenOut) }))
      .filter((item) => item.amount !== null && item.amount.input === expectedIn && item.amount.output > 0n);
    for (const item of candidates) {
      const swap = item.swap; const amount = item.amount;
      if (amount === null) continue;
      const incoming = hop === 0
        ? walletInputs.filter((row) => row.logIndex < swap.logIndex)
        : selectedOutputs.filter((row) => addressEqual(row.token, tokenIn) && addressEqual(row.from, input.action.pairAddresses[hop - 1] ?? ZERO)
          && addressEqual(row.to, pairAddress) && row.amount === expectedIn && row.logIndex < swap.logIndex);
      if (incoming.length !== 1) continue;
      const outgoing = transfers.filter((row) => addressEqual(row.token, tokenOut) && addressEqual(row.from, pairAddress)
        && addressEqual(row.to, recipient) && row.amount === amount.output && row.logIndex < swap.logIndex);
      if (outgoing.length !== 1) continue;
      if (hop === 0) {
        const result = [...selectedOutputs, ...outgoing];
        search(hop + 1, amount.output, [...selectedSwaps, swap], result, [...amounts, amount]);
      } else {
        // The pair-to-pair transfer is already the selected previous hop's output.
        if (incoming[0]?.logIndex !== selectedOutputs.at(-1)?.logIndex) continue;
        search(hop + 1, amount.output, [...selectedSwaps, swap], [...selectedOutputs, ...outgoing], [...amounts, amount]);
      }
    }
  };
  search(0, 0n, [], [], []);
  const wholeChains = chain.filter((candidate) => candidate.swaps.length === input.action.pairAddresses.length
    && candidate.outputs.length === input.action.pairAddresses.length
    && candidate.outputs.at(-1) !== undefined && addressEqual(candidate.outputs.at(-1)?.to ?? ZERO, wallet));
  if (wholeChains.length !== 1) return fail(wholeChains.length === 0 ? "rebalance-proof-legs-missing" : "rebalance-proof-ambiguous");
  const chosen = wholeChains[0]; if (chosen === undefined) return fail("rebalance-proof-ambiguous");
  if (walletTransfers.length !== 2) return fail("rebalance-proof-extra-wallet-transfer");
  const lastAmount = chosen.amounts.at(-1);
  if (lastAmount === undefined || lastAmount.input !== (chosen.amounts.at(-2)?.output ?? input.action.amountInWei)
    || lastAmount.output < input.action.minOutWei) return fail("rebalance-proof-amount-mismatch");
  const swapIndices = chosen.swaps.map((swap) => swap.logIndex);
  const proofBody = {
    chainId: 56, txHash: receipt.transactionHash.toLowerCase(), blockNumber: receipt.blockNumber.toString(10),
    blockHash: receipt.blockHash.toLowerCase(), transactionIndex: receipt.transactionIndex.toString(10),
    wallet: wallet.toLowerCase(), nonce: intent.nonce.toString(10), keyHash: intent.keyHash.toLowerCase(),
    fillInWei: input.action.amountInWei.toString(10), fillOutWei: lastAmount.output.toString(10),
    swapLogIndices: swapIndices.map(String), actionId: input.action.actionId,
  };
  const proofDigest = keccak256(stringToBytes(JSON.stringify(proofBody)));
  const proof: VerifiedQuantRebalanceReceiptProof = brandVerifiedReceiptProof({
    chainId: 56, txHash: receipt.transactionHash.toLowerCase() as Hex,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash.toLowerCase() as Hex,
    transactionIndex: receipt.transactionIndex, wallet, nonce: intent.nonce, keyHash: intent.keyHash,
    fillInWei: input.action.amountInWei, fillOutWei: lastAmount.output, swapLogIndices: swapIndices, proofDigest,
  });
  const ownership: QuantRebalanceReceiptOwnership[] = swapIndices.map((swapLogIndex) => ({
    txHash: receipt.transactionHash.toLowerCase() as Hex, wallet, swapLogIndex, journalKey: input.action.journalKey,
  }));
  return { ok: true, proof, ownership };
}

function actionCalls(action: QuantRebalanceActionRow): readonly WalletCall[] {
  try {
    const parsed: unknown = JSON.parse(action.callsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => {
      if (typeof value !== "object" || value === null) throw new Error("calls-invalid");
      const row = value as Record<string, unknown>;
      if (typeof row["to"] !== "string" || typeof row["data"] !== "string") throw new Error("calls-invalid");
      return { to: getAddress(row["to"]), data: row["data"] as Hex, value: typeof row["value"] === "bigint" ? row["value"] : BigInt(String(row["value"] ?? "0")) };
    });
  } catch { return []; }
}

export function verifyQuantRebalanceSubmittedFailure(input: {
  readonly chainId: number;
  readonly transaction: QuantTransaction;
  readonly receipt: QuantReceipt;
  readonly finalized: RebalanceFinalityEvidence;
  readonly action: QuantRebalanceActionRow;
  readonly wallet: Address;
  readonly keyHash: Hex;
  readonly calls: readonly WalletCall[];
}): VerifiedQuantRebalanceFailureProof | null {
  if (input.chainId !== 56 || input.transaction.to === null || !addressEqual(input.transaction.to, QUANT_ORCHESTRATOR_56)
    || !addressEqual(input.transaction.hash, input.receipt.transactionHash)
    || input.transaction.blockNumber !== input.receipt.blockNumber || !addressEqual(input.transaction.blockHash, input.receipt.blockHash)
    || input.finalized.finalizedNumber < input.receipt.blockNumber || !addressEqual(input.finalized.canonicalReceiptHash, input.receipt.blockHash)
    || input.finalized.canonicalReceiptNumber !== input.receipt.blockNumber) return null;
  const intents = decodeIntents(input.transaction.input); if (intents === null) return null;
  const mine = intents.filter((intent) => addressEqual(intent.wallet, input.wallet)); if (mine.length !== 1) return null;
  const intent = mine[0]; if (intent === undefined || !addressEqual(intent.keyHash, input.keyHash) || !callsEqual(intent.calls, input.calls)) return null;
  if (intent.preCallCount !== 0 || intent.fundTransferCount !== 0 || intent.funderSignatureBytes !== 0
    || !addressEqual(intent.funder, ZERO) || !nativePaymentSupported(intent, input.action)) return null;
  let failureReason: string;
  if (input.receipt.status === 0n) {
    failureReason = "outer-revert";
  } else if (input.receipt.status === 1n) {
    const decoded = input.receipt.logs.map(decodeIntentEvent);
    if (decoded.some((event) => event === "malformed")) return null;
    const events = decoded.filter((event): event is IntentEvent => event !== null && event !== "malformed"
      && addressEqual(event.wallet, input.wallet) && event.nonce === intent.nonce);
    if (events.length !== 1 || (events[0]?.incremented === true && events[0]?.err === INTENT_SUCCESS_ERR)) return null;
    failureReason = `inner-${events[0]?.err ?? "unknown"}`;
  } else return null;
  const walletTransfers = input.receipt.logs.filter((log) => log.topics[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase())
    .map(decodeTransfer).filter((row): row is TransferEvent => row !== null)
    .filter((row) => addressEqual(row.from, input.wallet) || addressEqual(row.to, input.wallet));
  if (walletTransfers.length !== 0) return null;
  const body = JSON.stringify({ chainId: 56, txHash: input.receipt.transactionHash.toLowerCase(), blockNumber: input.receipt.blockNumber.toString(10), blockHash: input.receipt.blockHash.toLowerCase(), actionId: input.action.actionId, nonce: intent.nonce.toString(10), reason: failureReason });
  const proofDigest = keccak256(stringToBytes(body));
  return brandVerifiedFailureProof({ chainId: 56, txHash: input.receipt.transactionHash.toLowerCase() as Hex,
    blockNumber: input.receipt.blockNumber, blockHash: input.receipt.blockHash.toLowerCase() as Hex,
    wallet: getAddress(input.wallet), nonce: intent.nonce, keyHash: intent.keyHash,
    actionId: input.action.actionId, failureDigest: proofDigest });
}

