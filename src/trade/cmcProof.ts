/** Exact settlement and expiry-unused proofs for CMC payment attempts. */
import { decodeFunctionData, hexToBigInt, keccak256, stringToBytes, type Address, type Hex } from "viem";
import {
  CMC_PAYEE,
  CMC_SIGNER,
  CMC_SPENDER,
  CMC_PRICE_ATOMIC,
} from "./cmc.js";
import { USDT_56 } from "./settlement.js";
import type { CmcReleaseProof } from "../store/tradeCmc.js";

export const CMC_SETTLE_SELECTOR = "0x13cd3b53" as Hex;
export const ERC20_TRANSFER_TOPIC = keccak256(stringToBytes("Transfer(address,address,uint256)"));
export const CMC_SETTLED_TOPIC = "0x97088ec3606cfe8cc112180570d03fcde05f9b8e1bfef8e27784eaf5dd5691b6" as Hex;

const SETTLE_ABI = [{
  type: "function",
  name: "settle",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "permit",
      type: "tuple",
      components: [
        { name: "permitted", type: "tuple", components: [
          { name: "token", type: "address" }, { name: "amount", type: "uint256" },
        ] },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    { name: "owner", type: "address" },
    { name: "witness", type: "tuple", components: [
      { name: "to", type: "address" }, { name: "validAfter", type: "uint256" },
    ] },
    { name: "signature", type: "bytes" },
  ],
  outputs: [],
}] as const;

export type CmcPaymentFacts = {
  readonly wallet: Address;
  readonly asset: Address;
  readonly amountWei: bigint;
  readonly spender: Address;
  readonly payee: Address;
  readonly validAfter: bigint;
  readonly deadline: bigint;
  readonly nonce: bigint;
};

export type CmcReceiptLog = {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
};

export type CmcReceiptObservation = {
  readonly chainId: number;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly from: Address;
  readonly to: Address | null;
  readonly input: Hex;
  readonly logs: readonly CmcReceiptLog[];
  readonly finalized: boolean;
};

export type CmcChargeProofResult =
  | { readonly ok: true; readonly proof: CmcReceiptObservation }
  | { readonly ok: false; readonly reason: string };

function same(a: string | null, b: string | null): boolean { return a !== null && b !== null && a.toLowerCase() === b.toLowerCase(); }
function topicAddress(value: Hex | undefined): Address | null {
  if (value === undefined || value.length !== 66) return null;
  return `0x${value.slice(-40)}` as Address;
}
function isTransfer(log: CmcReceiptLog): boolean {
  return log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase();
}

/** Verify one direct finalized settle call and its exact USDT transfer. */
export function verifyCmcChargeProof(input: {
  readonly receipt: CmcReceiptObservation;
  readonly facts: CmcPaymentFacts;
}): CmcChargeProofResult {
  const { receipt, facts } = input;
  if (receipt.chainId !== 56 || receipt.status !== "success" || !receipt.finalized
    || !same(receipt.to ?? "", CMC_SPENDER) || !same(receipt.from, CMC_SIGNER)
    || receipt.input.slice(0, 10).toLowerCase() !== CMC_SETTLE_SELECTOR.toLowerCase()
    || receipt.blockHash.length !== 66 || receipt.blockNumber < 0n) {
    return { ok: false, reason: "settlement_receipt_identity" };
  }
  let decoded: readonly unknown[];
  try {
    decoded = decodeFunctionData({ abi: SETTLE_ABI, data: receipt.input }).args;
  } catch {
    return { ok: false, reason: "settlement_calldata_decode" };
  }
  if (decoded.length !== 4) return { ok: false, reason: "settlement_calldata_shape" };
  const permit = decoded[0];
  const owner = decoded[1];
  const witness = decoded[2];
  if (!record(permit) || !record(permit["permitted"]) || !record(witness) || typeof owner !== "string") {
    return { ok: false, reason: "settlement_calldata_shape" };
  }
  const permitted = permit["permitted"];
  if (typeof permitted["token"] !== "string" || typeof permitted["amount"] !== "bigint"
    || typeof permit["nonce"] !== "bigint" || typeof permit["deadline"] !== "bigint"
    || typeof witness["to"] !== "string" || typeof witness["validAfter"] !== "bigint") {
    return { ok: false, reason: "settlement_calldata_types" };
  }
  if (!same(owner, facts.wallet) || !same(permitted["token"], facts.asset)
    || !same(facts.asset, USDT_56) || permitted["amount"] !== facts.amountWei
    || permit["nonce"] !== facts.nonce || permit["deadline"] !== facts.deadline
    || !same(witness["to"], facts.payee) || !same(witness["to"], CMC_PAYEE)
    || witness["validAfter"] !== facts.validAfter || facts.amountWei !== CMC_PRICE_ATOMIC
    || !same(facts.spender, CMC_SPENDER)) return { ok: false, reason: "settlement_authorization_mismatch" };

  const exact = receipt.logs.filter((log) => isTransfer(log) && same(log.address, USDT_56)
    && same(topicAddress(log.topics[1]), facts.wallet) && same(topicAddress(log.topics[2]), facts.payee)
    && log.data.length === 66 && hexToBigInt(log.data) === facts.amountWei);
  if (exact.length !== 1) return { ok: false, reason: "settlement_transfer_ambiguous" };
  const settledEvents = receipt.logs.filter((log) => same(log.address, CMC_SPENDER)
    && log.topics[0]?.toLowerCase() === CMC_SETTLED_TOPIC.toLowerCase());
  if (settledEvents.length !== 1) return { ok: false, reason: "settlement_event_ambiguous" };
  const relevantOther = receipt.logs.filter((log) => isTransfer(log) && same(log.address, USDT_56)
    && (same(topicAddress(log.topics[1]), facts.wallet) || same(topicAddress(log.topics[2]), facts.payee)));
  if (relevantOther.length !== 1) return { ok: false, reason: "settlement_transfer_batch" };
  return { ok: true, proof: receipt };
}

export type CmcExpiryReader = {
  readonly readChainId: () => Promise<number>;
  readonly readFinalizedBlock: () => Promise<{
    readonly number: bigint;
    readonly hash: Hex;
    readonly timestamp: bigint;
  }>;
  readonly readNonceBitmap: (input: {
    readonly payer: Address;
    readonly word: bigint;
    readonly blockNumber: bigint;
  }) => Promise<bigint>;
};

export type CmcExpiryUnusedResult =
  | { readonly ok: true; readonly proof: CmcReleaseProof }
  | { readonly ok: false; readonly reason: string };

/** A positive non-charge proof requires two independent finalized RPC reads. */
export async function verifyCmcExpiryUnused(input: {
  readonly attemptId: string;
  readonly payer: Address;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly readers: readonly [CmcExpiryReader, CmcExpiryReader];
  readonly nowMs?: number;
}): Promise<CmcExpiryUnusedResult> {
  if (input.nonce < 0n || input.deadline < 0n) return { ok: false, reason: "expiry-proof-input" };
  const chainIds = await Promise.allSettled(input.readers.map((reader) => reader.readChainId()));
  if (chainIds[0]?.status !== "fulfilled" || chainIds[1]?.status !== "fulfilled" || chainIds[0].value !== 56 || chainIds[1].value !== 56) return { ok: false, reason: "expiry-proof-chain" };
  const finalized = await Promise.allSettled(input.readers.map((reader) => reader.readFinalizedBlock()));
  const left = finalized[0]!;
  const right = finalized[1]!;
  if (left.status !== "fulfilled" || right.status !== "fulfilled") return { ok: false, reason: "expiry-proof-rpc" };
  const first = left.value;
  const second = right.value;
  if (first.number !== second.number || !same(first.hash, second.hash)
    || first.timestamp !== second.timestamp || first.timestamp <= input.deadline) {
    return { ok: false, reason: "expiry-proof-finality" };
  }
  const word = input.nonce >> 8n;
  const bit = 1n << (input.nonce & 255n);
  const nonceReads = await Promise.allSettled(input.readers.map((reader) => reader.readNonceBitmap({ payer: input.payer, word, blockNumber: first.number })));
  const firstNonce = nonceReads[0]!;
  const secondNonce = nonceReads[1]!;
  if (firstNonce.status !== "fulfilled" || secondNonce.status !== "fulfilled"
    || (firstNonce.value & bit) !== 0n || (secondNonce.value & bit) !== 0n
    || firstNonce.value !== secondNonce.value) return { ok: false, reason: "expiry-proof-nonce-used" };
  return { ok: true, proof: { kind: "expiry-unused", chainId: 56, payer: input.payer, nonce: input.nonce, deadline: input.deadline, attemptId: input.attemptId, blockNumber: first.number, blockHash: first.hash, finalizedAtMs: input.nowMs ?? Date.now(), nonceUnused: true } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
