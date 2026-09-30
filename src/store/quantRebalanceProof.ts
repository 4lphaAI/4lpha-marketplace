/** Opaque in-process brands for receipt proofs produced by the Quant verifier. */
import type { Address, Hex } from "viem";

const RECEIPT_PROOF_BRAND: unique symbol = Symbol("verified-quant-rebalance-receipt");
const FAILURE_PROOF_BRAND: unique symbol = Symbol("verified-quant-rebalance-failure");
const NOT_EXECUTED_PROOF_BRAND: unique symbol = Symbol("verified-quant-rebalance-not-executed");
const RETIREMENT_PROOF_BRAND: unique symbol = Symbol("verified-quant-rebalance-retirement");

export type VerifiedQuantRebalanceReceiptProof = {
  readonly [RECEIPT_PROOF_BRAND]: true;
  readonly chainId: 56;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
  readonly wallet: Address;
  readonly nonce: bigint;
  readonly keyHash: Hex;
  readonly fillInWei: bigint;
  readonly fillOutWei: bigint;
  readonly swapLogIndices: readonly bigint[];
  readonly proofDigest: Hex;
};
export type VerifiedQuantRebalanceFailureProof = {
  readonly [FAILURE_PROOF_BRAND]: true;
  readonly chainId: 56;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly wallet: Address;
  readonly nonce: bigint;
  readonly keyHash: Hex;
  readonly actionId: string;
  readonly failureDigest: Hex;
};
export type VerifiedQuantRebalanceNotExecutedProof = {
  readonly [NOT_EXECUTED_PROOF_BRAND]: true;
  readonly chainId: 56;
  readonly actionId: string;
  readonly jobId: string;
  readonly generation: bigint;
  readonly evidenceDigest: Hex;
  readonly evidenceJson: string;
};
export type VerifiedQuantRebalanceRetirementProof = {
  readonly [RETIREMENT_PROOF_BRAND]: true;
  readonly chainId: 56;
  readonly jobId: string;
  readonly generation: bigint;
  readonly evidenceDigest: Hex;
  readonly evidenceJson: string;
};
export type QuantRebalanceFailureEvidence =
  | { readonly kind: "pre-submit-refusal"; readonly code: string; readonly journalRolledBack: true }
  | { readonly kind: "submitted-failure"; readonly proof: VerifiedQuantRebalanceFailureProof };

export function brandVerifiedReceiptProof(input: Omit<VerifiedQuantRebalanceReceiptProof, typeof RECEIPT_PROOF_BRAND>): VerifiedQuantRebalanceReceiptProof {
  return { ...input, [RECEIPT_PROOF_BRAND]: true };
}
export function brandVerifiedFailureProof(input: Omit<VerifiedQuantRebalanceFailureProof, typeof FAILURE_PROOF_BRAND>): VerifiedQuantRebalanceFailureProof {
  return { ...input, [FAILURE_PROOF_BRAND]: true };
}
export function brandVerifiedNotExecutedProof(input: Omit<VerifiedQuantRebalanceNotExecutedProof, typeof NOT_EXECUTED_PROOF_BRAND>): VerifiedQuantRebalanceNotExecutedProof {
  return { ...input, [NOT_EXECUTED_PROOF_BRAND]: true };
}
export function brandVerifiedRetirementProof(input: Omit<VerifiedQuantRebalanceRetirementProof, typeof RETIREMENT_PROOF_BRAND>): VerifiedQuantRebalanceRetirementProof {
  return { ...input, [RETIREMENT_PROOF_BRAND]: true };
}
export function isVerifiedQuantRebalanceReceiptProof(value: unknown): value is VerifiedQuantRebalanceReceiptProof {
  return typeof value === "object" && value !== null
    && (value as { readonly [RECEIPT_PROOF_BRAND]?: unknown })[RECEIPT_PROOF_BRAND] === true;
}
export function isVerifiedQuantRebalanceFailureProof(value: unknown): value is VerifiedQuantRebalanceFailureProof {
  return typeof value === "object" && value !== null
    && (value as { readonly [FAILURE_PROOF_BRAND]?: unknown })[FAILURE_PROOF_BRAND] === true;
}
export function isVerifiedQuantRebalanceNotExecutedProof(value: unknown): value is VerifiedQuantRebalanceNotExecutedProof {
  return typeof value === "object" && value !== null
    && (value as { readonly [NOT_EXECUTED_PROOF_BRAND]?: unknown })[NOT_EXECUTED_PROOF_BRAND] === true;
}
export function isVerifiedQuantRebalanceRetirementProof(value: unknown): value is VerifiedQuantRebalanceRetirementProof {
  return typeof value === "object" && value !== null
    && (value as { readonly [RETIREMENT_PROOF_BRAND]?: unknown })[RETIREMENT_PROOF_BRAND] === true;
}
