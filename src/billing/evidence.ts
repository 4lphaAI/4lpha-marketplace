import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import type { Invoice, X402UsageFacts } from "./types.js";

const USDC_EVIDENCE_ABI = [
  {
    type: "event", name: "AuthorizationUsed",
    inputs: [
      { indexed: true, name: "authorizer", type: "address" },
      { indexed: true, name: "nonce", type: "bytes32" },
    ],
  },
  {
    type: "event", name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;

export const BILLING_COLLECTOR_ABI = [
  {
    type: "function", name: "payInvoice", stateMutability: "payable",
    inputs: [{ name: "invoiceId", type: "bytes32" }, { name: "quoteExpiresAt", type: "uint64" }],
    outputs: [],
  },
  {
    type: "event", name: "InvoicePaid",
    inputs: [
      { indexed: true, name: "invoiceId", type: "bytes32" },
      { indexed: true, name: "payer", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
  },
] as const;

export type CanonicalLog = Readonly<{ address: Address; topics: readonly Hex[]; data: Hex }>;
export type CanonicalReceipt = Readonly<{
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  status: 0 | 1;
  logs: readonly CanonicalLog[];
}>;
export type CanonicalTransaction = Readonly<{
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
}>;

export type RpcReceiptObservation = Readonly<{
  chainId: bigint;
  finalizedBlock: bigint;
  finalizedBlockHash: Hex;
  /** Timestamp of the receipt's own canonical block, not the finalized head. */
  receiptBlockTimestamp: number;
  receipt: CanonicalReceipt;
  transaction?: CanonicalTransaction;
  runtimeCode?: Hex;
}>;

function sameReceipt(a: CanonicalReceipt, b: CanonicalReceipt): boolean {
  return JSON.stringify(a, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value) ===
    JSON.stringify(b, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}

function sameTransaction(a: CanonicalTransaction | undefined, b: CanonicalTransaction | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.hash === b.hash && a.from.toLowerCase() === b.from.toLowerCase() &&
    a.to?.toLowerCase() === b.to?.toLowerCase() && a.input === b.input && a.value === b.value;
}

function assertCanonicalPair(a: RpcReceiptObservation, b: RpcReceiptObservation, chainId: bigint): void {
  if (a.chainId !== chainId || b.chainId !== chainId || !sameReceipt(a.receipt, b.receipt) || !sameTransaction(a.transaction, b.transaction)) {
    throw new Error("Independent RPC evidence disagrees.");
  }
  if (
    a.finalizedBlock !== b.finalizedBlock || a.finalizedBlockHash !== b.finalizedBlockHash ||
    a.receipt.blockHash !== b.receipt.blockHash ||
    a.receiptBlockTimestamp !== b.receiptBlockTimestamp ||
    a.receipt.blockNumber > a.finalizedBlock || b.receipt.blockNumber > b.finalizedBlock ||
    !Number.isSafeInteger(a.receiptBlockTimestamp) || a.receiptBlockTimestamp < 0
  ) throw new Error("Receipt is not canonically finalized.");
}

export type BaseDebitProof = Readonly<{ transactionHash: Hex; blockNumber: bigint; blockHash: Hex }>;

export function proveBaseX402Debit(
  facts: X402UsageFacts,
  a: RpcReceiptObservation,
  b: RpcReceiptObservation,
): BaseDebitProof {
  assertCanonicalPair(a, b, 8_453n);
  const receipt = a.receipt;
  if (receipt.status !== 1) throw new Error("Base settlement transaction did not succeed.");
  let authorization = false;
  let transfer = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== facts.usdcAddress.toLowerCase()) continue;
    if (log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({ abi: USDC_EVIDENCE_ABI, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data, strict: true });
      if (decoded.eventName === "AuthorizationUsed") {
        authorization ||= decoded.args.authorizer.toLowerCase() === facts.authorizer.toLowerCase() && decoded.args.nonce.toLowerCase() === facts.authorizationNonce.toLowerCase();
      } else if (decoded.eventName === "Transfer") {
        transfer ||= decoded.args.from.toLowerCase() === facts.authorizer.toLowerCase() && decoded.args.to.toLowerCase() === facts.payee.toLowerCase() && decoded.args.value === facts.amountAtomic;
      }
    } catch {
      continue;
    }
  }
  if (!authorization || !transfer) throw new Error("Canonical USDC debit logs are incomplete.");
  return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
}

export type BaseAbsenceObservation = Readonly<{
  chainId: 8453;
  finalizedBlock: bigint;
  finalizedBlockHash: Hex;
  finalizedTimestamp: bigint;
  authorizationUsed: boolean;
}>;

export function proveBaseX402NotDebited(facts: X402UsageFacts, a: BaseAbsenceObservation, b: BaseAbsenceObservation): void {
  if (
    a.chainId !== 8453 || b.chainId !== 8453 ||
    a.finalizedBlock !== b.finalizedBlock || a.finalizedBlockHash !== b.finalizedBlockHash ||
    a.finalizedTimestamp !== b.finalizedTimestamp || a.authorizationUsed !== b.authorizationUsed ||
    a.finalizedTimestamp <= facts.validBefore || a.authorizationUsed
  ) throw new Error("Positive finalized x402 absence is not proven.");
}

export function billingCollectorCalldata(invoiceId: Hex, quoteExpiresAt: number): Hex {
  if (!Number.isSafeInteger(quoteExpiresAt) || quoteExpiresAt <= 0 || BigInt(quoteExpiresAt) > 18_446_744_073_709_551_615n) {
    throw new Error("Collection deadline is outside uint64.");
  }
  return encodeFunctionData({ abi: BILLING_COLLECTOR_ABI, functionName: "payInvoice", args: [invoiceId, BigInt(quoteExpiresAt)] });
}

export type CollectionProof = Readonly<{
  outcome: "paid" | "rolled_back";
  transactionHash: Hex;
  paidAt: number;
}>;

export function proveBillingCollection(
  invoice: Invoice,
  wallet: Address,
  collector: Address,
  reviewedRuntimeBytecodeHash: Hex,
  a: RpcReceiptObservation,
  b: RpcReceiptObservation,
): CollectionProof {
  assertCanonicalPair(a, b, 56n);
  const transaction = a.transaction;
  if (transaction === undefined || b.transaction === undefined || a.runtimeCode === undefined || b.runtimeCode === undefined) {
    throw new Error("Collection proof is incomplete.");
  }
  const expectedInput = billingCollectorCalldata(invoice.invoiceId as Hex, invoice.quoteExpiresAt);
  if (
    transaction.hash !== a.receipt.transactionHash || transaction.from.toLowerCase() !== wallet.toLowerCase() ||
    transaction.to?.toLowerCase() !== collector.toLowerCase() || transaction.input !== expectedInput || transaction.value !== invoice.bnbWei ||
    keccak256(a.runtimeCode) !== reviewedRuntimeBytecodeHash || keccak256(b.runtimeCode) !== reviewedRuntimeBytecodeHash
  ) throw new Error("Collection transaction or collector bytecode drifted.");
  const decodedCall = decodeFunctionData({ abi: BILLING_COLLECTOR_ABI, data: transaction.input });
  if (decodedCall.functionName !== "payInvoice" || decodedCall.args[0] !== invoice.invoiceId || decodedCall.args[1] !== BigInt(invoice.quoteExpiresAt)) {
    throw new Error("Collection calldata drifted.");
  }
  if (a.receipt.status === 0) return { outcome: "rolled_back", transactionHash: a.receipt.transactionHash, paidAt: a.receiptBlockTimestamp };
  let paidEvent = false;
  for (const log of a.receipt.logs) {
    if (log.address.toLowerCase() !== collector.toLowerCase()) continue;
    if (log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({ abi: BILLING_COLLECTOR_ABI, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data, strict: true });
      if (decoded.eventName === "InvoicePaid") {
        paidEvent ||= decoded.args.invoiceId === invoice.invoiceId && decoded.args.payer.toLowerCase() === wallet.toLowerCase() && decoded.args.amount === invoice.bnbWei;
      }
    } catch {
      continue;
    }
  }
  if (!paidEvent) throw new Error("Canonical InvoicePaid event is missing.");
  return { outcome: "paid", transactionHash: a.receipt.transactionHash, paidAt: a.receiptBlockTimestamp };
}

export function normalizeEvidenceAddress(value: string): Address {
  return getAddress(value);
}
