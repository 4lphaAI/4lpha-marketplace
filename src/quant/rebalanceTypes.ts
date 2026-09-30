/** Durable public-domain types for the separate Quant rebalancing strategy. */
import type { Address, Hex } from "viem";
import type { QuantJobRecord, QuantInboxItem } from "./types.js";
import type { RebalanceAsset, RebalanceRiskAsset, RebalanceTierId } from "./rebalancePolicy.js";

export type QuantRebalanceJobStatus =
  | "discovered" | "admitted" | "held" | "paused" | "ended" | "ended-unresolved" | "reported";
export type QuantRebalanceActionState =
  | "intended" | "submitted" | "committed-unverified" | "unknown" | "needs-operator"
  | "settled" | "failed" | "aborted" | "retired";
export type QuantRebalanceCheckKind = "bootstrap" | "scheduled";
export type QuantRebalanceCheckState = "held" | "rebalancing" | "done";
export type QuantRebalanceSide = "buy" | "sell";

export type RebalanceBalanceVector = Readonly<Record<RebalanceAsset | "USDT", bigint>>;

export type QuantRebalanceJobWire = QuantJobRecord & {
  readonly envelope: QuantInboxItem | null;
  readonly wireDigest: Hex;
};

export type QuantRebalanceJobRow = {
  readonly jobId: string;
  readonly strategyId: string;
  readonly tradingWallet: Address;
  readonly allocationWei: bigint;
  readonly dailyCapWei: bigint;
  readonly termDays: number;
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  readonly sessionExpiresAtMs: number;
  readonly revokedAtMs: number | null;
  readonly platformStatus: string;
  readonly status: QuantRebalanceJobStatus;
  readonly wireJson: string;
  readonly wireDigest: Hex;
  /** Encrypted inbox only; plaintext session material is never a row field. */
  readonly envelopeJson: string | null;
  readonly envelopeId: string | null;
  readonly admittedAtMs: number | null;
  readonly policyJson: string | null;
  readonly policyDigest: Hex | null;
  readonly tier: RebalanceTierId | null;
  readonly sessionPublicKey: Hex | null;
  readonly sessionExpirySec: number | null;
  readonly permissionsDigest: Hex | null;
  readonly projectionDigest: Hex | null;
  readonly descriptorJson: string | null;
  readonly projectionJson: string | null;
  readonly capRowsJson: string | null;
  readonly claimGeneration: bigint | null;
  readonly baselineBlock: bigint | null;
  readonly baselineHash: Hex | null;
  readonly baselineAtMs: number | null;
  readonly actualBaselineJson: string | null;
  readonly protectedBaselineJson: string | null;
  readonly managed: Readonly<Record<RebalanceAsset, bigint>> | null;
  readonly costBasis: Readonly<Record<RebalanceRiskAsset, bigint>> | null;
  readonly accountingRev: bigint;
  readonly checkRev: bigint;
  readonly nextEligibleSlot: number;
  readonly actionSequence: bigint;
  readonly lastDeadlineSec: number;
  readonly bootstrapComplete: boolean;
  readonly externalActivity: boolean;
  readonly holdCode: string | null;
  readonly holdEvidenceJson: string | null;
  readonly reportAttempts: number;
  readonly reportPayloadDigest: Hex | null;
  readonly reportResponseStatus: number | null;
  readonly reportNotesApplied: number | null;
  readonly reportedAtMs: number | null;
  readonly retiredAtMs: number | null;
  readonly retirementEvidenceJson: string | null;
  readonly rowVersion: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type QuantRebalanceCheckRow = {
  readonly checkId: string;
  readonly jobId: string;
  readonly kind: QuantRebalanceCheckKind;
  readonly slot: number;
  readonly state: QuantRebalanceCheckState;
  readonly evidenceJson: string | null;
  readonly takenAssets: readonly RebalanceRiskAsset[];
  readonly rowVersion: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type QuantRebalanceActionRow = {
  readonly actionId: string;
  readonly journalKey: string;
  readonly jobId: string;
  readonly checkId: string;
  readonly sequence: bigint;
  readonly plannedAccountingRev: bigint;
  readonly plannedCheckVersion: number;
  readonly state: QuantRebalanceActionState;
  readonly side: QuantRebalanceSide;
  readonly asset: RebalanceRiskAsset;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly path: readonly Address[];
  readonly pairAddresses: readonly Address[];
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly quoteOutWei: bigint;
  readonly deadlineSec: number;
  readonly callsJson: string;
  readonly callsDigest: Hex;
  readonly policyDigest: Hex;
  readonly permissionsDigest: Hex;
  readonly projectionDigest: Hex;
  readonly claimGeneration: bigint;
  readonly quoteBlockNumber: bigint;
  readonly quoteBlockHash: Hex;
  readonly quoteObservedAtMs: number;
  readonly referenceBlockNumber: bigint;
  readonly referenceBlockHash: Hex;
  readonly referenceObservedAtMs: number;
  readonly referenceEvidenceJson: string;
  readonly gasEvidenceJson: string;
  readonly preSubmitBlockNumber: bigint | null;
  readonly preSubmitBlockHash: Hex | null;
  readonly txHash: Hex | null;
  readonly fillInWei: bigint | null;
  readonly fillOutWei: bigint | null;
  readonly realizedDeltaUsdcWei?: bigint | null;
  readonly receiptBlockNumber: bigint | null;
  readonly receiptBlockHash: Hex | null;
  readonly swapLogIndices: readonly bigint[];
  readonly proofDigest: Hex | null;
  readonly reservationWei: bigint;
  readonly failureCode: string | null;
  readonly ambiguousCause: string | null;
  readonly resolutionJson: string | null;
  readonly rowVersion: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type QuantRebalanceReceiptOwnership = {
  readonly txHash: Hex;
  readonly wallet: Address;
  readonly swapLogIndex: bigint;
  readonly journalKey: string;
};

export type QuantRebalanceCensusGroup = {
  readonly wallet: Address;
  readonly jobs: readonly {
    readonly strategyKind: "grid" | "rebalance";
    readonly jobId: string;
    readonly status: string;
    readonly rowVersion: number;
    readonly admitted: boolean;
    readonly actionStates: readonly string[];
    readonly actionSetDigest: Hex;
    readonly receiptOwnershipCount: number;
    readonly sessionExpirySec: number | null;
    readonly revokedAtMs: number | null;
    readonly claimGeneration: bigint | null;
    readonly accountingDigest: Hex;
  }[];
  readonly disposition: "clear" | "operator-disposition-required";
  readonly receiptOwnershipCount: number;
};

export type QuantRebalanceCensus = {
  readonly generatedAtMs: number;
  readonly migrationInstalled: boolean;
  readonly groups: readonly QuantRebalanceCensusGroup[];
  readonly digest: Hex;
};
