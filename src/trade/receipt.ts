/**
 * Finalized TradFi v2 receipt evidence.
 *
 * A token transfer is only an effect. This module first proves that the
 * transaction is the pinned chain-56 orchestrator execution for one wallet,
 * then checks the exact signed call batch and the successful paired intent
 * event, and only then attributes the USDT/stock legs. The reader is the RPC
 * boundary; verification below is pure and never trusts caller-supplied
 * booleans.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { createPublicClient, http, type PublicClient, type Transport } from "viem";
import { bsc } from "viem/chains";
import { publicKeyToAddress } from "viem/accounts";
import type { WalletCall } from "../core/types.js";
import { accountKeyHashForAddress } from "../wallet/altana.js";
import { hashCalls } from "../http/wire.js";
import {
  PORTO_V055_INTENT_PARAMETERS as FULL_INTENT_PARAMETERS,
} from "../lp/intentDecoder.js";
import { PORTO_V055_ORCHESTRATOR as PINNED_ORCHESTRATOR_56 } from "../lp/preparedIntent.js";
import { TRADFI_BINANCE_ROUTER_SELECTOR } from "./guard.js";

export const TRADFI_RECEIPT_CHAIN_ID = 56 as const;
export const TRADFI_RECEIPT_ORCHESTRATOR_56: Address = getAddress(PINNED_ORCHESTRATOR_56);
export const TRADFI_RECEIPT_TRANSFER_TOPIC: Hex =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRADFI_RECEIPT_INTENT_EXECUTED_TOPIC: Hex =
  "0x23a3c1343409f01965611c9c4c8b99e36d7b09ca22516507d5486ce0584379b8";
export const TRADFI_RECEIPT_INTENT_SUCCESS: Hex = "0x00000000";
export const TRADFI_RECEIPT_SWAP_EXECUTED_TOPIC: Hex = keccak256(
  stringToBytes("SwapExecuted(address,address,address,uint256,uint256,bytes32)"),
);
export const TRADFI_RECEIPT_RPC_TIMEOUT_MS = 15_000;
/** Bounded decoder envelope: permits the reviewed 64 KiB opaque guard bytes. */
export const TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES = 128 * 1024;
export const TRADFI_RECEIPT_MAX_EXECUTION_DATA_BYTES = 128 * 1024;
export const TRADFI_RECEIPT_MAX_TRANSACTION_INPUT_BYTES = 512 * 1024;

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

const SEC1 = /^0x04[0-9a-fA-F]{128}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export type TradfiReceiptLog = {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly logIndex: bigint;
  readonly removed?: boolean;
};

export type TradfiReceipt = {
  readonly status: bigint;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
  readonly logs: readonly TradfiReceiptLog[];
};

export type TradfiTransaction = {
  readonly hash: Hex;
  readonly to: Address | null;
  readonly input: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
};

export type TradfiBlock = {
  readonly number: bigint;
  readonly hash: Hex;
};

export type TradfiReceiptObservation = {
  readonly chainId: 56;
  readonly transaction: TradfiTransaction;
  readonly receipt: TradfiReceipt;
  readonly receiptBlock: TradfiBlock;
  readonly finalizedBlock: TradfiBlock;
};

/** The durable facts needed to attribute one submitted v2 trade. */
export type TradfiV2ReceiptExpected = {
  readonly wallet: Address;
  readonly sessionPublicKey: Hex;
  /** Durable session generation, used by the caller's position/journal CAS. */
  readonly sessionGeneration: number;
  /** Optional only when the caller durably pre-bound the encoded intent hash. */
  readonly intentId?: Hex;
  /** Optional durable nonce when the submit path persisted it. */
  readonly nonce?: bigint;
  readonly callsHash: Hex;
  readonly calls: readonly WalletCall[];
  readonly side: "buy" | "sell";
  readonly token: Address;
  /** Requested token input: USDT for buy, stock token for sell. */
  readonly amountInAtomic: bigint;
  readonly minOutAtomic: bigint;
  /** Buy-only fixed USDT fee; omitted is equivalent to zero. */
  readonly platformFeeAtomic?: bigint;
  readonly feeTreasury?: Address;
  /** Present for a guard route; absent means the direct route. */
  readonly guard?: {
    readonly address: Address;
    readonly calldata: Hex;
  };
  /** Finalized factory evidence for a direct V2/V3 route. */
  readonly directRoute?: TradfiDirectRouteEvidence;
};

export type TradfiReceiptOwnership = {
  readonly transactionHash: Hex;
  readonly wallet: Address;
  /** Guard event index, or the attributable output transfer index for direct AMM. */
  readonly swapLogIndex: bigint;
};

export type TradfiV2ReceiptEvidence = {
  readonly chainId: 56;
  readonly receiptStatus: "success";
  readonly blockHash: Hex;
  readonly blockNumber: bigint;
  readonly wallet: Address;
  readonly sessionPublicKey: Hex;
  readonly sessionGeneration: number;
  /** Alias kept for the executor evidence seam; this is the chain hash. */
  readonly intentId: Hex;
  readonly chainIntentHash: Hex;
  readonly nonce: bigint;
  readonly callsHash: Hex;
  readonly receiptOwned: true;
  readonly singleWalletExecution: true;
  readonly unexplainedRelevantTransfers: false;
  readonly matchingIntent: true;
  readonly matchingCalls: true;
  readonly guardEventMatches?: true;
  readonly treasuryFeeMatches: true;
  readonly actualInputAtomic: bigint;
  readonly actualOutputAtomic: bigint;
  readonly verifiedEntryAtomic: bigint | null;
  readonly verifiedProceedsAtomic: bigint | null;
  readonly ownership: TradfiReceiptOwnership;
};

export type TradfiV2ReceiptFailureCode =
  | "receipt-chain-mismatch"
  | "receipt-transaction-mismatch"
  | "receipt-unfinalized"
  | "receipt-wrong-orchestrator"
  | "receipt-reverted"
  | "receipt-undecodable"
  | "receipt-unsupported-shape"
  | "receipt-intent-ambiguous"
  | "receipt-key-mismatch"
  | "receipt-calls-mismatch"
  | "receipt-intent-mismatch"
  | "receipt-event-mismatch"
  | "receipt-transfer-ambiguous"
  | "receipt-legs-missing"
  | "receipt-amount-mismatch"
  | "receipt-fee-mismatch"
  | "receipt-guard-event-mismatch"
  | "receipt-contaminated";

export type TradfiV2ReceiptVerification =
  | { readonly ok: true; readonly evidence: TradfiV2ReceiptEvidence }
  | { readonly ok: false; readonly code: TradfiV2ReceiptFailureCode };

/** Public read seam used by the executor and restart reconciler. */
export interface TradfiV2ReceiptReader {
  chainId(): Promise<number>;
  getReceipt(transactionHash: Hex): Promise<TradfiReceipt | null>;
  getTransaction(transactionHash: Hex): Promise<TradfiTransaction | null>;
  blockAt(blockNumber: bigint): Promise<TradfiBlock | null>;
  finalizedBlock(): Promise<TradfiBlock | null>;
  readV2Pools(factory: Address, tokenPath: readonly Address[], blockNumber: bigint): Promise<readonly Address[] | null>;
  readV3Pools(factory: Address, tokenPath: readonly Address[], feeTiers: readonly number[], blockNumber: bigint): Promise<readonly Address[] | null>;
  readFinalized(transactionHash: Hex): Promise<TradfiReceiptObservation | null>;
}

export type TradfiDirectRouteEvidence = {
  readonly kind: "v2" | "v3";
  readonly router: Address;
  readonly pools: readonly Address[];
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
};

type RpcRow = {
  readonly client: PublicClient;
  readonly chainId: number;
};

/**
 * Build the production reader from configured BSC RPCs. Every configured
 * endpoint must agree on the chain, receipt/transaction identity, receipt
 * block and finalized head before evidence is returned.
 */
export function createTradfiV2ReceiptReader(input: {
  readonly rpcUrls: readonly string[];
  readonly signal?: AbortSignal;
  readonly transport?: (url: string) => Transport;
}): TradfiV2ReceiptReader {
  const urls = [...new Set(input.rpcUrls.map((url) => url.trim()).filter((url) => url !== ""))];
  if (urls.length < 2) throw new Error("TradFi receipt reader requires two distinct BSC RPC URLs.");
  const transport = input.transport ?? ((url: string) => http(url, {
    timeout: TRADFI_RECEIPT_RPC_TIMEOUT_MS,
    retryCount: 0,
    ...(input.signal === undefined ? {} : { fetchOptions: { signal: input.signal } }),
  }));
  const rows: readonly RpcRow[] = urls.map((url) => ({
    client: createPublicClient({
      chain: bsc, transport: transport(url),
    }),
    chainId: TRADFI_RECEIPT_CHAIN_ID,
  }));

  async function chainId(): Promise<number> {
    const ids = await Promise.all(rows.map((row) => row.client.getChainId()));
    if (ids.some((id) => id !== TRADFI_RECEIPT_CHAIN_ID)
      || new Set(ids).size !== 1) {
      throw new Error("TradFi receipt RPC chain identity mismatch.");
    }
    return ids[0] ?? 0;
  }

  async function oneReceipt(client: PublicClient, transactionHash: Hex): Promise<TradfiReceipt | null> {
    try {
      const receipt = await client.getTransactionReceipt({ hash: transactionHash });
      return {
        status: receipt.status === "success" ? 1n : 0n,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionIndex: BigInt(receipt.transactionIndex),
        logs: receipt.logs.map((log) => ({
          address: getAddress(log.address), topics: log.topics, data: log.data,
          logIndex: BigInt(log.logIndex),
          ...(log.removed === undefined ? {} : { removed: log.removed }),
        })),
      };
    } catch {
      return null;
    }
  }

  async function oneTransaction(client: PublicClient, transactionHash: Hex): Promise<TradfiTransaction | null> {
    try {
      const tx = await client.getTransaction({ hash: transactionHash });
      if (tx.blockNumber === null || tx.blockHash === null || tx.to === null) return null;
      return {
        hash: tx.hash, to: getAddress(tx.to), input: tx.input,
        blockNumber: tx.blockNumber, blockHash: tx.blockHash,
        transactionIndex: BigInt(tx.transactionIndex),
      };
    } catch {
      return null;
    }
  }

  async function oneBlock(client: PublicClient, blockNumber: bigint): Promise<TradfiBlock | null> {
    try {
      const block = await client.getBlock({ blockNumber, includeTransactions: false });
      return block.hash === null ? null : { number: block.number, hash: block.hash };
    } catch {
      return null;
    }
  }

  async function oneFinalized(client: PublicClient): Promise<TradfiBlock | null> {
    try {
      const block = await client.getBlock({ blockTag: "finalized", includeTransactions: false });
      return block.number === null || block.hash === null ? null : { number: block.number, hash: block.hash };
    } catch {
      return null;
    }
  }

  function receiptIdentity(row: TradfiReceipt): string {
    return [row.status, row.transactionHash.toLowerCase(), row.blockNumber, row.blockHash.toLowerCase(), row.transactionIndex,
      row.logs.length, ...row.logs.map((log) => `${log.address.toLowerCase()}:${log.logIndex}:${log.topics.join(",")}:${log.data.toLowerCase()}:${log.removed === true}`)].join("|");
  }

  async function getReceipt(transactionHash: Hex): Promise<TradfiReceipt | null> {
    const values = await Promise.all(rows.map((row) => oneReceipt(row.client, transactionHash)));
    const present = values.filter((value): value is TradfiReceipt => value !== null);
    if (present.length !== values.length) return null;
    const first = present[0];
    if (first === undefined || present.some((value) => receiptIdentity(value) !== receiptIdentity(first))) return null;
    return first;
  }

  async function getTransaction(transactionHash: Hex): Promise<TradfiTransaction | null> {
    const values = await Promise.all(rows.map((row) => oneTransaction(row.client, transactionHash)));
    const present = values.filter((value): value is TradfiTransaction => value !== null);
    if (present.length !== values.length) return null;
    const first = present[0];
    if (first === undefined || present.some((value) => value.hash.toLowerCase() !== first.hash.toLowerCase()
      || value.to?.toLowerCase() !== first.to?.toLowerCase()
      || value.input.toLowerCase() !== first.input.toLowerCase()
      || value.blockNumber !== first.blockNumber || value.blockHash.toLowerCase() !== first.blockHash.toLowerCase()
      || value.transactionIndex !== first.transactionIndex)) return null;
    return first;
  }

  async function blockAt(blockNumber: bigint): Promise<TradfiBlock | null> {
    const values = await Promise.all(rows.map((row) => oneBlock(row.client, blockNumber)));
    const present = values.filter((value): value is TradfiBlock => value !== null);
    if (present.length !== values.length) return null;
    const first = present[0];
    if (first === undefined || present.some((value) => value.number !== first.number || value.hash.toLowerCase() !== first.hash.toLowerCase())) return null;
    return first;
  }

  async function finalizedBlock(): Promise<TradfiBlock | null> {
    const values = await Promise.all(rows.map((row) => oneFinalized(row.client)));
    const present = values.filter((value): value is TradfiBlock => value !== null);
    if (present.length !== values.length) return null;
    const minimum = present.reduce((value, row) => row.number < value ? row.number : value, present[0]?.number ?? 0n);
    const common = await Promise.all(rows.map((row) => oneBlock(row.client, minimum)));
    const commonPresent = common.filter((value): value is TradfiBlock => value !== null);
    if (commonPresent.length !== common.length) return null;
    const first = commonPresent[0];
    if (first === undefined || commonPresent.some((value) => value.number !== minimum || value.hash.toLowerCase() !== first.hash.toLowerCase())) return null;
    return first;
  }

  const V2_FACTORY_ABI = [{
    type: "function", name: "getPair", stateMutability: "view",
    inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
    outputs: [{ name: "pair", type: "address" }],
  }] as const;
  const V3_FACTORY_ABI = [{
    type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "fee", type: "uint24" }],
    outputs: [{ name: "pool", type: "address" }],
  }] as const;

  async function readV2Pools(factory: Address, tokenPath: readonly Address[], blockNumber: bigint): Promise<readonly Address[] | null> {
    if (tokenPath.length < 2 || tokenPath.length > 4) return null;
    const pairs = await Promise.all(rows.map(async (row) => {
      const result: Address[] = [];
      for (let index = 0; index + 1 < tokenPath.length; index += 1) {
        const pool = await row.client.readContract({ address: getAddress(factory), abi: V2_FACTORY_ABI, functionName: "getPair",
          args: [getAddress(tokenPath[index]!), getAddress(tokenPath[index + 1]!)], blockNumber });
        const address = getAddress(pool);
        if (address === ZERO_ADDRESS) return null;
        result.push(address);
      }
      return result;
    }));
    const present = pairs.filter((value): value is Address[] => value !== null);
    if (present.length !== pairs.length || present.length === 0) return null;
    const first = present[0];
    if (first === undefined || present.some((value) => value.length !== first.length
      || value.some((address, index) => address.toLowerCase() !== first[index]?.toLowerCase()))) return null;
    return first;
  }

  async function readV3Pools(factory: Address, tokenPath: readonly Address[], feeTiers: readonly number[], blockNumber: bigint): Promise<readonly Address[] | null> {
    if (tokenPath.length < 2 || tokenPath.length > 4 || feeTiers.length !== tokenPath.length - 1
      || feeTiers.some((fee) => !Number.isInteger(fee) || fee <= 0 || fee > 0xffffff)) return null;
    const pools = await Promise.all(rows.map(async (row) => {
      const result: Address[] = [];
      for (let index = 0; index + 1 < tokenPath.length; index += 1) {
        const fee = feeTiers[index];
        if (fee === undefined) return null;
        const pool = await row.client.readContract({ address: getAddress(factory), abi: V3_FACTORY_ABI, functionName: "getPool",
          args: [getAddress(tokenPath[index]!), getAddress(tokenPath[index + 1]!), fee], blockNumber });
        const address = getAddress(pool);
        if (address === ZERO_ADDRESS) return null;
        result.push(address);
      }
      return result;
    }));
    const present = pools.filter((value): value is Address[] => value !== null);
    if (present.length !== pools.length || present.length === 0) return null;
    const first = present[0];
    if (first === undefined || present.some((value) => value.length !== first.length
      || value.some((address, index) => address.toLowerCase() !== first[index]?.toLowerCase()))) return null;
    return first;
  }

  async function readFinalized(transactionHash: Hex): Promise<TradfiReceiptObservation | null> {
    const id = await chainId();
    if (id !== TRADFI_RECEIPT_CHAIN_ID) return null;
    const [transaction, receipt] = await Promise.all([getTransaction(transactionHash), getReceipt(transactionHash)]);
    if (transaction === null || receipt === null) return null;
    const [receiptBlock, final] = await Promise.all([blockAt(receipt.blockNumber), finalizedBlock()]);
    if (receiptBlock === null || final === null || receipt.blockNumber > final.number) return null;
    if (receiptBlock.number !== receipt.blockNumber || receiptBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;
    return { chainId: TRADFI_RECEIPT_CHAIN_ID, transaction, receipt, receiptBlock, finalizedBlock: final };
  }

  return { chainId, getReceipt, getTransaction, blockAt, finalizedBlock, readV2Pools, readV3Pools, readFinalized };
}

type DecodedIntent = {
  readonly index: number;
  readonly encodedHash: Hex;
  readonly eoa: Address;
  readonly nonce: bigint;
  readonly keyHash: Hex;
  readonly executionData: Hex;
  readonly preCallCount: number;
  readonly fundTransferCount: number;
  readonly funder: Address;
  readonly funderSignatureBytes: number;
};

function decodeIntents(input: Hex): readonly DecodedIntent[] | null {
  if ((input.length - 2) / 2 > TRADFI_RECEIPT_MAX_TRANSACTION_INPUT_BYTES) return null;
  let decoded: ReturnType<typeof decodeFunctionData<typeof EXECUTE_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: input });
  } catch {
    return null;
  }
  const argument = decoded.args[0];
  const members = Array.isArray(argument) ? argument : [argument];
  if (members.length === 0 || members.length > 32) return null;
  let reencoded: Hex;
  try {
    reencoded = encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [argument] }) as Hex;
  } catch {
    return null;
  }
  if (reencoded.toLowerCase() !== input.toLowerCase()) return null;
  const result: DecodedIntent[] = [];
  for (const [index, member] of members.entries()) {
    if ((member.length - 2) / 2 > TRADFI_RECEIPT_MAX_INTENT_MEMBER_BYTES) return null;
    let intent: ReturnType<typeof decodeAbiParameters<typeof FULL_INTENT_PARAMETERS>>[0];
    try {
      [intent] = decodeAbiParameters(FULL_INTENT_PARAMETERS, member as Hex);
    } catch {
      return null;
    }
    if ((intent.executionData.length - 2) / 2 > TRADFI_RECEIPT_MAX_EXECUTION_DATA_BYTES) return null;
    const signatureBytes = (intent.signature.length - 2) / 2;
    if (signatureBytes < 33) return null;
    result.push({
      index,
      encodedHash: keccak256(member as Hex),
      eoa: getAddress(intent.eoa), nonce: intent.nonce,
      keyHash: `0x${intent.signature.slice(-66, -2)}`.toLowerCase() as Hex,
      executionData: intent.executionData,
      preCallCount: intent.encodedPreCalls.length,
      fundTransferCount: intent.encodedFundTransfers.length,
      funder: getAddress(intent.funder),
      funderSignatureBytes: (intent.funderSignature.length - 2) / 2,
    });
  }
  return result;
}

function decodeExecutionCalls(executionData: Hex): readonly WalletCall[] | null {
  try {
    const [calls] = decodeAbiParameters(CALLS_PARAMETERS, executionData);
    return calls.map((call) => ({ to: getAddress(call.target), value: call.value, data: call.data }));
  } catch {
    return null;
  }
}

function callsEqual(left: readonly WalletCall[], right: readonly WalletCall[]): boolean {
  if (left.length !== right.length) return false;
  for (const [index, call] of left.entries()) {
    const other = right[index];
    if (other === undefined || getAddress(call.to) !== getAddress(other.to)
      || (call.value ?? 0n) !== (other.value ?? 0n)
      || (call.data ?? "0x").toLowerCase() !== (other.data ?? "0x").toLowerCase()) return false;
  }
  return true;
}

function topicAddress(topic: Hex | undefined): Address | null {
  if (topic === undefined || topic.length !== 66) return null;
  try { return getAddress(`0x${topic.slice(-40)}`); } catch { return null; }
}

function isHash(value: string): value is Hex { return HASH.test(value); }

type Transfer = { readonly token: Address; readonly from: Address; readonly to: Address; readonly amount: bigint; readonly logIndex: bigint };

function decodeRelevantTransfers(
  logs: readonly TradfiReceiptLog[],
  tokens: readonly Address[],
  wallet: Address,
): readonly Transfer[] | null {
  const tokenSet = new Set(tokens.map((token) => getAddress(token).toLowerCase()));
  const result: Transfer[] = [];
  const seenIndexes = new Set<string>();
  for (const log of logs) {
    if (log.logIndex < 0n) return null;
    const index = log.logIndex.toString(10);
    if (seenIndexes.has(index)) return null;
    seenIndexes.add(index);
    if (log.removed === true) return null;
    if (log.topics[0]?.toLowerCase() !== TRADFI_RECEIPT_TRANSFER_TOPIC) continue;
    if (!tokenSet.has(log.address.toLowerCase())) continue;
    if (log.topics.length !== 3 || log.data.length !== 66) return null;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    if (from === null || to === null) return null;
    let amount: bigint;
    try { amount = BigInt(log.data); } catch { return null; }
    if (from.toLowerCase() === wallet.toLowerCase() || to.toLowerCase() === wallet.toLowerCase()) {
      result.push({ token: getAddress(log.address), from, to, amount, logIndex: log.logIndex });
    }
  }
  return result;
}

type GuardEvent = {
  readonly caller: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly calldataHash: Hex;
  readonly logIndex: bigint;
};

function decodeGuardEvents(logs: readonly TradfiReceiptLog[], guard: Address): readonly GuardEvent[] | null {
  const events: GuardEvent[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== guard.toLowerCase()) continue;
    if (log.topics[0]?.toLowerCase() !== TRADFI_RECEIPT_SWAP_EXECUTED_TOPIC) continue;
    if (log.topics.length !== 4 || log.data.length !== 194) return null;
    const caller = topicAddress(log.topics[1]);
    const tokenIn = topicAddress(log.topics[2]);
    const tokenOut = topicAddress(log.topics[3]);
    if (caller === null || tokenIn === null || tokenOut === null) return null;
    try {
      const [amountIn, amountOut, calldataHash] = decodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], log.data,
      );
      events.push({ caller, tokenIn, tokenOut, amountIn, amountOut, calldataHash: calldataHash.toLowerCase() as Hex, logIndex: log.logIndex });
    } catch {
      return null;
    }
  }
  return events;
}

function fail(code: TradfiV2ReceiptFailureCode): { readonly ok: false; readonly code: TradfiV2ReceiptFailureCode } {
  return { ok: false, code };
}

function addressesEqual(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function hashesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** What {@link verifyWalletIntentOwnership} proves: the one wallet intent and its nonce. */
export type WalletIntentOwnership =
  | { readonly ok: true; readonly wallet: Address; readonly intent: { readonly encodedHash: Hex; readonly nonce: bigint } }
  | { readonly ok: false; readonly code: TradfiV2ReceiptFailureCode };

/**
 * The ownership prefix of {@link verifyTradfiV2Receipt} (AUTO-DCA R2.3 item 5,
 * REVIEW2 N13): orchestrator, canonical transaction, success, finality, the
 * single wallet intent, its key hash, the exact calls and calls hash, and the
 * paired successful `IntentExecuted`. It says nothing about swap legs, so the
 * DCA verifier reuses it. `amounts` is the v2 verifier's own sizing check, kept
 * at the same position so every v2 failure code fires exactly where it did.
 */
export function verifyWalletIntentOwnership(input: {
  readonly observation: TradfiReceiptObservation;
  readonly expected: Pick<TradfiV2ReceiptExpected, "wallet" | "sessionPublicKey" | "sessionGeneration" | "intentId" | "nonce" | "callsHash" | "calls">;
  readonly amounts?: { readonly amountInAtomic: bigint; readonly minOutAtomic: bigint };
}): WalletIntentOwnership {
  const { observation, expected } = input;
  if (observation.chainId !== TRADFI_RECEIPT_CHAIN_ID) return fail("receipt-chain-mismatch");
  const { transaction, receipt, receiptBlock, finalizedBlock } = observation;
  if (transaction.to === null || !addressesEqual(transaction.to, TRADFI_RECEIPT_ORCHESTRATOR_56)) return fail("receipt-wrong-orchestrator");
  if (!addressesEqual(receipt.transactionHash, transaction.hash)
    || receipt.blockNumber !== transaction.blockNumber
    || !addressesEqual(receipt.blockHash, transaction.blockHash)
    || receipt.transactionIndex !== transaction.transactionIndex) return fail("receipt-transaction-mismatch");
  if (receipt.status !== 1n) return fail("receipt-reverted");
  if (receiptBlock.number !== receipt.blockNumber || !hashesEqual(receiptBlock.hash, receipt.blockHash)
    || receipt.blockNumber > finalizedBlock.number) return fail("receipt-unfinalized");
  if (!isHash(receipt.blockHash) || !isHash(transaction.hash) || !isHash(transaction.blockHash)) return fail("receipt-transaction-mismatch");
  if (!Number.isSafeInteger(expected.sessionGeneration) || expected.sessionGeneration < 0
    || input.amounts !== undefined && (input.amounts.amountInAtomic <= 0n || input.amounts.minOutAtomic <= 0n)) return fail("receipt-amount-mismatch");
  if (!SEC1.test(expected.sessionPublicKey)) return fail("receipt-key-mismatch");
  if (!isHash(expected.callsHash)) return fail("receipt-calls-mismatch");

  const intents = decodeIntents(transaction.input);
  if (intents === null) return fail("receipt-undecodable");
  const wallet = getAddress(expected.wallet);
  const mine = intents.filter((intent) => addressesEqual(intent.eoa, wallet));
  if (mine.length !== 1) return fail("receipt-intent-ambiguous");
  const intent = mine[0];
  if (intent === undefined) return fail("receipt-intent-ambiguous");
  if (expected.nonce !== undefined && expected.nonce !== intent.nonce) return fail("receipt-intent-mismatch");
  if (intent.preCallCount !== 0 || intent.fundTransferCount !== 0 || intent.funderSignatureBytes !== 0 || !addressesEqual(intent.funder, ZERO_ADDRESS)) {
    return fail("receipt-unsupported-shape");
  }
  let expectedKeyHash: Hex;
  try {
    expectedKeyHash = accountKeyHashForAddress(getAddress(publicKeyToAddress(expected.sessionPublicKey)));
  } catch {
    return fail("receipt-key-mismatch");
  }
  if (intent.keyHash.toLowerCase() !== expectedKeyHash.toLowerCase()) return fail("receipt-key-mismatch");
  if (expected.intentId !== undefined && (!isHash(expected.intentId) || expected.intentId.toLowerCase() !== intent.encodedHash.toLowerCase())) return fail("receipt-intent-mismatch");

  const decodedCalls = decodeExecutionCalls(intent.executionData);
  if (decodedCalls === null || !callsEqual(decodedCalls, expected.calls)) return fail("receipt-calls-mismatch");
  if (hashCalls(expected.calls).toLowerCase() !== expected.callsHash.toLowerCase()
    || hashCalls(decodedCalls).toLowerCase() !== expected.callsHash.toLowerCase()) return fail("receipt-calls-mismatch");

  const pairedEvents: Array<{ readonly eoa: Address; readonly nonce: bigint; readonly incremented: boolean; readonly err: Hex }> = [];
  for (const log of receipt.logs) {
    if (!addressesEqual(log.address, TRADFI_RECEIPT_ORCHESTRATOR_56)) continue;
    if (log.topics[0]?.toLowerCase() !== TRADFI_RECEIPT_INTENT_EXECUTED_TOPIC) continue;
    if (log.topics.length !== 3 || log.data.length !== 130) return fail("receipt-undecodable");
    const eoa = topicAddress(log.topics[1]);
    if (eoa === null || log.topics[2] === undefined) return fail("receipt-undecodable");
    try {
      const [incremented, err] = decodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], log.data);
      pairedEvents.push({ eoa, nonce: BigInt(log.topics[2]), incremented, err: err.toLowerCase() as Hex });
    } catch { return fail("receipt-undecodable"); }
  }
  const walletEvents = pairedEvents.filter((event) => addressesEqual(event.eoa, wallet));
  if (walletEvents.length !== 1) return fail("receipt-event-mismatch");
  const event = walletEvents[0];
  if (event === undefined || event.nonce !== intent.nonce || !event.incremented || event.err !== TRADFI_RECEIPT_INTENT_SUCCESS) return fail("receipt-event-mismatch");
  return { ok: true, wallet, intent: { encodedHash: intent.encodedHash, nonce: intent.nonce } };
}

/**
 * Pure v2 verifier. It returns no positive fill unless every identity,
 * canonicality, intent, event and transfer boundary is satisfied.
 */
export function verifyTradfiV2Receipt(input: {
  readonly observation: TradfiReceiptObservation;
  readonly expected: TradfiV2ReceiptExpected;
}): TradfiV2ReceiptVerification {
  const { observation, expected } = input;
  const owned = verifyWalletIntentOwnership({ observation, expected,
    amounts: { amountInAtomic: expected.amountInAtomic, minOutAtomic: expected.minOutAtomic } });
  if (!owned.ok) return owned;
  const { receipt } = observation;
  const { wallet, intent } = owned;

  const usdt = getAddress("0x55d398326f99059fF775485246999027B3197955");
  const token = getAddress(expected.token);
  if (addressesEqual(token, usdt)) return fail("receipt-amount-mismatch");
  const tokenIn = expected.side === "buy" ? usdt : token;
  const tokenOut = expected.side === "buy" ? token : usdt;
  const transfers = decodeRelevantTransfers(receipt.logs, [usdt, token], wallet);
  if (transfers === null) return fail("receipt-transfer-ambiguous");
  const fee = expected.side === "buy" ? (expected.platformFeeAtomic ?? 0n) : 0n;
  if (expected.side === "sell" && (expected.platformFeeAtomic ?? 0n) !== 0n) return fail("receipt-fee-mismatch");
  if (fee < 0n) return fail("receipt-fee-mismatch");
  if (fee > 0n && expected.feeTreasury === undefined) return fail("receipt-fee-mismatch");
  const treasury = expected.feeTreasury === undefined ? null : getAddress(expected.feeTreasury);
  const feeTransfers = transfers.filter((row) => addressesEqual(row.token, usdt)
    && addressesEqual(row.from, wallet) && treasury !== null && addressesEqual(row.to, treasury) && row.amount === fee);

  let actualInputAtomic = expected.amountInAtomic;
  let actualOutputAtomic: bigint;
  let ownershipLogIndex: bigint;
  let guardEventMatches = false;
  if (expected.guard !== undefined) {
    if (expected.directRoute !== undefined) return fail("receipt-contaminated");
    if (expected.guard.calldata.length < 10 || (expected.guard.calldata.length - 2) / 2 > 64 * 1024
      || expected.guard.calldata.slice(0, 10).toLowerCase() !== TRADFI_BINANCE_ROUTER_SELECTOR) return fail("receipt-guard-event-mismatch");
    const guardAddress = getAddress(expected.guard.address);
    const guardEvents = decodeGuardEvents(receipt.logs, guardAddress);
    if (guardEvents === null) return fail("receipt-guard-event-mismatch");
    const matching = guardEvents.filter((row) => addressesEqual(row.caller, wallet));
    if (matching.length !== 1) return fail("receipt-guard-event-mismatch");
    const guardEvent = matching[0];
    if (guardEvent === undefined || !addressesEqual(guardEvent.tokenIn, tokenIn) || !addressesEqual(guardEvent.tokenOut, tokenOut)
      || guardEvent.amountIn <= 0n || guardEvent.amountOut < expected.minOutAtomic
      || guardEvent.calldataHash.toLowerCase() !== keccak256(expected.guard.calldata).toLowerCase()) return fail("receipt-guard-event-mismatch");
    const inputToGuard = transfers.filter((row) => addressesEqual(row.token, tokenIn) && addressesEqual(row.from, wallet) && addressesEqual(row.to, guardAddress));
    const refundFromGuard = transfers.filter((row) => addressesEqual(row.token, tokenIn) && addressesEqual(row.from, guardAddress) && addressesEqual(row.to, wallet));
    const outputFromGuard = transfers.filter((row) => addressesEqual(row.token, tokenOut) && addressesEqual(row.from, guardAddress) && addressesEqual(row.to, wallet));
    if (inputToGuard.length !== 1 || inputToGuard[0]!.amount !== expected.amountInAtomic
      || refundFromGuard.length > 1 || outputFromGuard.length !== 1 || outputFromGuard[0]!.amount !== guardEvent.amountOut) return fail("receipt-legs-missing");
    const refund = refundFromGuard[0]?.amount ?? 0n;
    if (guardEvent.amountIn + refund !== expected.amountInAtomic || guardEvent.amountIn > expected.amountInAtomic) return fail("receipt-amount-mismatch");
    actualInputAtomic = guardEvent.amountIn;
    actualOutputAtomic = guardEvent.amountOut;
    ownershipLogIndex = guardEvent.logIndex;
    guardEventMatches = true;
    const expectedCount = 2 + (refundFromGuard.length === 0 ? 0 : 1) + (fee > 0n ? 1 : 0);
    if (transfers.length !== expectedCount) return fail("receipt-contaminated");
  } else {
    const route = expected.directRoute;
    if (route === undefined || route.pools.length === 0 || route.pools.length > 3
      || route.blockNumber !== receipt.blockNumber || !hashesEqual(route.blockHash, receipt.blockHash)
      || !expected.calls.some((call) => addressesEqual(call.to, route.router))) return fail("receipt-contaminated");
    const firstPool = getAddress(route.pools[0]!);
    const lastPool = getAddress(route.pools[route.pools.length - 1]!);
    // Exact-input routers pull from the wallet during the pool callback; the
    // first resolved pool is the transfer counterparty for both V2 and V3.
    const inputCounterparty = firstPool;
    const outputCounterparty = lastPool;
    const inputTransfers = transfers.filter((row) => addressesEqual(row.token, tokenIn) && addressesEqual(row.from, wallet)
      && addressesEqual(row.to, inputCounterparty) && row.amount === expected.amountInAtomic);
    const outputTransfers = transfers.filter((row) => addressesEqual(row.token, tokenOut) && addressesEqual(row.to, wallet)
      && addressesEqual(row.from, outputCounterparty) && row.amount >= expected.minOutAtomic);
    if (inputTransfers.length !== 1 || outputTransfers.length !== 1) return fail("receipt-legs-missing");
    actualOutputAtomic = outputTransfers[0]!.amount;
    ownershipLogIndex = outputTransfers[0]!.logIndex;
    const expectedCount = 2 + (fee > 0n ? 1 : 0);
    if (transfers.length !== expectedCount) return fail("receipt-contaminated");
  }
  if (fee > 0n ? feeTransfers.length !== 1 : feeTransfers.length !== 0) return fail("receipt-fee-mismatch");
  if (fee === 0n && transfers.some((row) => addressesEqual(row.token, usdt) && addressesEqual(row.from, wallet) && treasury !== null && addressesEqual(row.to, treasury))) {
    return fail("receipt-fee-mismatch");
  }
  if (expected.side === "buy") {
    const verifiedEntryAtomic = actualInputAtomic + fee;
    return {
      ok: true,
      evidence: {
        chainId: TRADFI_RECEIPT_CHAIN_ID, receiptStatus: "success", blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber, wallet, sessionPublicKey: expected.sessionPublicKey,
        sessionGeneration: expected.sessionGeneration, intentId: intent.encodedHash,
        chainIntentHash: intent.encodedHash, nonce: intent.nonce, callsHash: expected.callsHash,
        receiptOwned: true, singleWalletExecution: true, unexplainedRelevantTransfers: false,
        matchingIntent: true, matchingCalls: true,
        ...(guardEventMatches ? { guardEventMatches: true as const } : {}), treasuryFeeMatches: true,
        actualInputAtomic, actualOutputAtomic, verifiedEntryAtomic, verifiedProceedsAtomic: null,
        ownership: { transactionHash: receipt.transactionHash, wallet, swapLogIndex: ownershipLogIndex },
      },
    };
  }
  return {
    ok: true,
    evidence: {
      chainId: TRADFI_RECEIPT_CHAIN_ID, receiptStatus: "success", blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber, wallet, sessionPublicKey: expected.sessionPublicKey,
      sessionGeneration: expected.sessionGeneration, intentId: intent.encodedHash,
      chainIntentHash: intent.encodedHash, nonce: intent.nonce, callsHash: expected.callsHash,
      receiptOwned: true, singleWalletExecution: true, unexplainedRelevantTransfers: false,
      matchingIntent: true, matchingCalls: true,
      ...(guardEventMatches ? { guardEventMatches: true as const } : {}), treasuryFeeMatches: true,
      actualInputAtomic, actualOutputAtomic, verifiedEntryAtomic: null, verifiedProceedsAtomic: actualOutputAtomic,
      ownership: { transactionHash: receipt.transactionHash, wallet, swapLogIndex: ownershipLogIndex },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Auto DCA (AUTO-DCA R2.3 "Anchor and receipt", REVIEW2 N12/N13)             */
/* -------------------------------------------------------------------------- */

export const DCA_NFPM_INCREASE_TOPIC: Hex = keccak256(stringToBytes("IncreaseLiquidity(uint256,uint128,uint256,uint256)"));
export const DCA_NFPM_DECREASE_TOPIC: Hex = keccak256(stringToBytes("DecreaseLiquidity(uint256,uint128,uint256,uint256)"));
export const DCA_NFPM_COLLECT_TOPIC: Hex = keccak256(stringToBytes("Collect(uint256,address,uint256,uint256)"));

/** One `dcaRange` batch, from its persisted plan and journal row. */
export type DcaReceiptExpected = Pick<TradfiV2ReceiptExpected, "wallet" | "sessionPublicKey" | "sessionGeneration" | "callsHash" | "calls"> & {
  readonly nfpm: Address;
  readonly pool: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly stock: Address;
  /** Planned exits, in plan order. */
  readonly exits: readonly { readonly tokenId: bigint }[];
  /** Planned mints, in plan order: exactly one positive desired leg each. */
  readonly mints: readonly { readonly amount0Desired: bigint; readonly amount1Desired: bigint }[];
  readonly swap: {
    readonly side: "buy" | "sell";
    readonly amountInAtomic: bigint;
    readonly minOutAtomic: bigint;
    readonly guard?: { readonly address: Address; readonly calldata: Hex };
  } | null;
  readonly feeAtomic: bigint;
  readonly feeTreasury?: Address;
};

export type DcaReceiptEvidence = {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly swap: { readonly inputAtomic: bigint; readonly outputAtomic: bigint } | null;
  /** In plan order; ids ascend in log order, the i-th minted id is the i-th planned mint. */
  readonly mints: readonly { readonly tokenId: bigint; readonly liquidity: bigint; readonly amount0: bigint; readonly amount1: bigint }[];
  /** In plan order: what each exit's `Collect` sent to the wallet. */
  readonly exits: readonly { readonly tokenId: bigint; readonly amount0: bigint; readonly amount1: bigint }[];
};

export type DcaReceiptVerification =
  | { readonly ok: true; readonly evidence: DcaReceiptEvidence }
  | { readonly ok: false; readonly code: TradfiV2ReceiptFailureCode };

type NfpmEvent = { readonly topic: Hex; readonly tokenId: bigint; readonly words: readonly bigint[]; readonly recipient: Address | null };

function decodeNfpmEvents(logs: readonly TradfiReceiptLog[], nfpm: Address): readonly NfpmEvent[] | null {
  const events: NfpmEvent[] = [];
  for (const log of logs) {
    if (!addressesEqual(log.address, nfpm)) continue;
    const topic = log.topics[0]?.toLowerCase() as Hex | undefined;
    if (topic !== DCA_NFPM_INCREASE_TOPIC && topic !== DCA_NFPM_DECREASE_TOPIC && topic !== DCA_NFPM_COLLECT_TOPIC) continue;
    if (log.topics.length !== 2 || log.topics[1] === undefined || log.data.length !== 194) return null;
    try {
      const tokenId = BigInt(log.topics[1]);
      if (topic === DCA_NFPM_COLLECT_TOPIC) {
        const [recipient, amount0, amount1] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], log.data);
        events.push({ topic, tokenId, words: [amount0, amount1], recipient: getAddress(recipient) });
      } else {
        const [liquidity, amount0, amount1] = decodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], log.data);
        events.push({ topic, tokenId, words: [liquidity, amount0, amount1], recipient: null });
      }
    } catch {
      return null;
    }
  }
  return events;
}

/**
 * The DCA verifier. Ownership first (the v2 prefix, extracted), then the legs:
 * the swap (guard `SwapExecuted` with its wallet↔guard transfers, or the direct
 * wallet↔pool transfers), the fee to the treasury, one ERC-721 mint +
 * `IncreaseLiquidity` per planned mint, one `DecreaseLiquidity` + `Collect(→
 * wallet)` per planned exit. Every USDT or stock ERC-20 transfer touching the
 * wallet must be explained by exactly one of those legs (the v2 contamination
 * rule widened by the NFPM legs); collects and mints are matched first, by the
 * exact amounts their own events name, so a direct swap on the pinned pool is
 * told apart from them by direction and amount. The direct leg is bound by the
 * intent's calls (the ownership prefix verifies them byte for byte: router,
 * path and minOut are the plan's), not by a pool pin on its transfers (audit L-5).
 */
export function verifyDcaReceipt(input: {
  readonly observation: TradfiReceiptObservation;
  readonly expected: DcaReceiptExpected;
}): DcaReceiptVerification {
  const { observation, expected } = input;
  const owned = verifyWalletIntentOwnership({ observation, expected });
  if (!owned.ok) return owned;
  const { receipt } = observation;
  const wallet = owned.wallet;
  const usdt = getAddress("0x55d398326f99059fF775485246999027B3197955");
  const stock = getAddress(expected.stock);
  if (addressesEqual(stock, usdt)) return fail("receipt-amount-mismatch");
  const pool = getAddress(expected.pool);
  const nfpm = getAddress(expected.nfpm);
  const transfers = decodeRelevantTransfers(receipt.logs, [usdt, stock], wallet);
  if (transfers === null) return fail("receipt-transfer-ambiguous");
  const events = decodeNfpmEvents(receipt.logs, nfpm);
  if (events === null) return fail("receipt-undecodable");
  const remaining = [...transfers];
  const take = (matches: (row: Transfer) => boolean): Transfer | null => {
    const index = remaining.findIndex(matches);
    if (index < 0) return null;
    return remaining.splice(index, 1)[0] ?? null;
  };
  const legOf = (index: 0 | 1): Address => index === 0 ? getAddress(expected.token0) : getAddress(expected.token1);

  // Exits: exactly one DecreaseLiquidity and one Collect(→ wallet) per planned id.
  const exits: { tokenId: bigint; amount0: bigint; amount1: bigint }[] = [];
  for (const exit of expected.exits) {
    const decreases = events.filter((event) => event.topic === DCA_NFPM_DECREASE_TOPIC && event.tokenId === exit.tokenId);
    const collects = events.filter((event) => event.topic === DCA_NFPM_COLLECT_TOPIC && event.tokenId === exit.tokenId);
    if (decreases.length !== 1 || collects.length !== 1) return fail("receipt-legs-missing");
    const collect = collects[0]!;
    if (collect.recipient === null || !addressesEqual(collect.recipient, wallet)) return fail("receipt-legs-missing");
    const [amount0 = 0n, amount1 = 0n] = collect.words;
    for (const [leg, amount] of [[0, amount0], [1, amount1]] as const) {
      if (amount > 0n && take((row) => addressesEqual(row.token, legOf(leg)) && addressesEqual(row.from, pool)
        && addressesEqual(row.to, wallet) && row.amount === amount) === null) return fail("receipt-legs-missing");
    }
    exits.push({ tokenId: exit.tokenId, amount0, amount1 });
  }

  // Mints: one ERC-721 Transfer(0 → wallet) each, ids ascending in log order.
  const mintedIds: bigint[] = [];
  for (const log of receipt.logs) {
    if (!addressesEqual(log.address, nfpm) || log.topics[0]?.toLowerCase() !== TRADFI_RECEIPT_TRANSFER_TOPIC || log.topics.length !== 4) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    if (from === null || to === null) return fail("receipt-undecodable");
    if (!addressesEqual(from, ZERO_ADDRESS)) continue;
    if (!addressesEqual(to, wallet)) return fail("receipt-contaminated");
    try { mintedIds.push(BigInt(log.topics[3]!)); } catch { return fail("receipt-undecodable"); }
  }
  if (mintedIds.length !== expected.mints.length || mintedIds.some((id, index) => index > 0 && id <= mintedIds[index - 1]!)) {
    return fail("receipt-legs-missing");
  }
  const mints: { tokenId: bigint; liquidity: bigint; amount0: bigint; amount1: bigint }[] = [];
  for (const [index, planned] of expected.mints.entries()) {
    const tokenId = mintedIds[index]!;
    const increases = events.filter((event) => event.topic === DCA_NFPM_INCREASE_TOPIC && event.tokenId === tokenId);
    if (increases.length !== 1) return fail("receipt-legs-missing");
    const [liquidity = 0n, amount0 = 0n, amount1 = 0n] = increases[0]!.words;
    const onToken0 = planned.amount0Desired > 0n;
    if (liquidity <= 0n || (onToken0 ? amount0 <= 0n || amount1 !== 0n : amount1 <= 0n || amount0 !== 0n)) return fail("receipt-amount-mismatch");
    const leg = onToken0 ? 0 : 1;
    if (take((row) => addressesEqual(row.token, legOf(leg)) && addressesEqual(row.from, wallet)
      && addressesEqual(row.to, pool) && row.amount === (onToken0 ? amount0 : amount1)) === null) return fail("receipt-legs-missing");
    mints.push({ tokenId, liquidity, amount0, amount1 });
  }
  // No NFPM effect the plan did not name.
  if (events.length !== expected.exits.length * 2 + expected.mints.length) return fail("receipt-contaminated");

  // The platform fee.
  if (expected.feeAtomic < 0n || expected.feeAtomic > 0n && expected.feeTreasury === undefined) return fail("receipt-fee-mismatch");
  if (expected.feeAtomic > 0n) {
    const treasury = getAddress(expected.feeTreasury!);
    if (take((row) => addressesEqual(row.token, usdt) && addressesEqual(row.from, wallet) && addressesEqual(row.to, treasury)
      && row.amount === expected.feeAtomic) === null) return fail("receipt-fee-mismatch");
  }

  // The swap, guard-first as the v2 verifier reads it, or the direct legs.
  let swap: { inputAtomic: bigint; outputAtomic: bigint } | null = null;
  if (expected.swap !== null) {
    const tokenIn = expected.swap.side === "buy" ? usdt : stock;
    const tokenOut = expected.swap.side === "buy" ? stock : usdt;
    if (expected.swap.amountInAtomic <= 0n || expected.swap.minOutAtomic <= 0n) return fail("receipt-amount-mismatch");
    if (expected.swap.guard !== undefined) {
      const guard = expected.swap.guard;
      if (guard.calldata.length < 10 || (guard.calldata.length - 2) / 2 > 64 * 1024
        || guard.calldata.slice(0, 10).toLowerCase() !== TRADFI_BINANCE_ROUTER_SELECTOR) return fail("receipt-guard-event-mismatch");
      const guardAddress = getAddress(guard.address);
      const guardEvents = decodeGuardEvents(receipt.logs, guardAddress);
      if (guardEvents === null) return fail("receipt-guard-event-mismatch");
      const matching = guardEvents.filter((row) => addressesEqual(row.caller, wallet));
      const event = matching[0];
      if (matching.length !== 1 || event === undefined || !addressesEqual(event.tokenIn, tokenIn) || !addressesEqual(event.tokenOut, tokenOut)
        || event.amountIn <= 0n || event.amountOut < expected.swap.minOutAtomic
        || event.calldataHash.toLowerCase() !== keccak256(guard.calldata).toLowerCase()) return fail("receipt-guard-event-mismatch");
      const paid = take((row) => addressesEqual(row.token, tokenIn) && addressesEqual(row.from, wallet) && addressesEqual(row.to, guardAddress)
        && row.amount === expected.swap!.amountInAtomic);
      const refund = take((row) => addressesEqual(row.token, tokenIn) && addressesEqual(row.from, guardAddress) && addressesEqual(row.to, wallet));
      const output = take((row) => addressesEqual(row.token, tokenOut) && addressesEqual(row.from, guardAddress) && addressesEqual(row.to, wallet)
        && row.amount === event.amountOut);
      if (paid === null || output === null) return fail("receipt-legs-missing");
      if (event.amountIn + (refund?.amount ?? 0n) !== expected.swap.amountInAtomic) return fail("receipt-amount-mismatch");
      swap = { inputAtomic: event.amountIn, outputAtomic: event.amountOut };
    } else {
      const paid = take((row) => addressesEqual(row.token, tokenIn) && addressesEqual(row.from, wallet) && row.amount === expected.swap!.amountInAtomic);
      const outputs = remaining.filter((row) => addressesEqual(row.token, tokenOut) && addressesEqual(row.to, wallet) && row.amount >= expected.swap!.minOutAtomic);
      if (paid === null || outputs.length !== 1) return fail("receipt-legs-missing");
      const output = take((row) => row === outputs[0]);
      swap = { inputAtomic: expected.swap.amountInAtomic, outputAtomic: output!.amount };
    }
  }
  if (remaining.length !== 0) return fail("receipt-contaminated");
  return { ok: true, evidence: { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, swap, mints, exits } };
}
