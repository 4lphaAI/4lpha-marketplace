/** Pure proof predicates for operator recovery; all chain reads are supplied by the caller. */
import { keccak256, stringToBytes, type Hex } from "viem";
import { rebalanceCanonicalEncode } from "./rebalanceCanonical.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow, RebalanceBalanceVector } from "./rebalanceTypes.js";
import { REBALANCE_TOKEN_ADDRESSES } from "./rebalancePolicy.js";
import { decodeJsonb } from "../store/codec.js";
import { brandVerifiedNotExecutedProof, brandVerifiedRetirementProof,
  type VerifiedQuantRebalanceNotExecutedProof, type VerifiedQuantRebalanceRetirementProof } from "../store/quantRebalanceProof.js";

const UINT256_LIMIT = 1n << 256n;
const ASSETS = ["USDC", "WBNB", "ETH", "CAKE", "USDT"] as const;
type PublicVector = Readonly<Record<(typeof ASSETS)[number], string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n && value < UINT256_LIMIT ? value : null;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = BigInt(value); return parsed < UINT256_LIMIT ? parsed : null;
  }
  if (isRecord(value) && typeof value["$bigint"] === "string") return parseAmount(value["$bigint"]);
  return null;
}
function parseStoredVector(raw: string | null): RebalanceBalanceVector | null {
  if (raw === null) return null;
  try {
    const value: unknown = decodeJsonb(JSON.parse(raw) as unknown);
    if (!isRecord(value)) return null;
    const entries = ASSETS.map((asset) => [asset, parseAmount(value[asset])] as const);
    if (entries.some(([, amount]) => amount === null)) return null;
    return Object.fromEntries(entries) as unknown as RebalanceBalanceVector;
  } catch { return null; }
}
function validVector(value: RebalanceBalanceVector): boolean {
  return ASSETS.every((asset) => typeof value[asset] === "bigint" && value[asset] >= 0n && value[asset] < UINT256_LIMIT);
}
function publicVector(value: RebalanceBalanceVector): PublicVector {
  return { USDC: value.USDC.toString(10), WBNB: value.WBNB.toString(10), ETH: value.ETH.toString(10),
    CAKE: value.CAKE.toString(10), USDT: value.USDT.toString(10) };
}
function proofDigest(value: unknown): Hex {
  return keccak256(stringToBytes(rebalanceCanonicalEncode(value)));
}

export type QuantRebalanceFinalizedFacts = Readonly<{ number: bigint; hash: Hex; timestampSec: bigint }>;

export type NotExecutedProofResult =
  | { readonly ok: true; readonly proof: VerifiedQuantRebalanceNotExecutedProof }
  | { readonly ok: false; readonly code: string; readonly evidence?: Readonly<Record<string, unknown>> };

/** Exact no-execution hypothesis over the five monitored token balances. */
export function proveQuantRebalanceNotExecuted(input: {
  readonly job: QuantRebalanceJobRow;
  readonly action: QuantRebalanceActionRow;
  readonly allActions: readonly QuantRebalanceActionRow[];
  readonly journalState: string | null;
  readonly journalHasCallsId: boolean;
  readonly sharedWalletJobs: number;
  readonly finalized: QuantRebalanceFinalizedFacts;
  readonly baselineBlockHash: Hex | null;
  readonly submitBlockHash: Hex | null;
  readonly canonicalReceiptActionIds: ReadonlySet<string>;
  readonly actual: RebalanceBalanceVector;
}): NotExecutedProofResult {
  const { job, action, finalized } = input;
  if (job.claimGeneration === null || job.claimGeneration <= 0n) return { ok: false, code: "claim-generation-unavailable" };
  if (action.state !== "unknown" || action.txHash !== null || input.journalState !== "UNKNOWN") return { ok: false, code: "not-ambiguous" };
  if (input.journalHasCallsId) return { ok: false, code: "has-callsid" };
  if (input.sharedWalletJobs !== 1) return { ok: false, code: "wallet-shared" };
  const unresolved = input.allActions.filter((row) => !["settled", "failed", "aborted"].includes(row.state));
  if (unresolved.length !== 1 || unresolved[0]?.actionId !== action.actionId) return { ok: false, code: "other-action-pending" };
  if (input.allActions.some((row) => row.actionId !== action.actionId && row.state === "settled"
    && (row.fillInWei === null || row.fillOutWei === null || row.receiptBlockNumber === null
      || row.receiptBlockHash === null || row.txHash === null || row.proofDigest === null))) {
    return { ok: false, code: "other-action-unverified" };
  }
  if (job.baselineBlock === null || job.baselineHash === null || job.baselineBlock >= (action.preSubmitBlockNumber ?? -1n)
    || action.preSubmitBlockNumber === null || action.preSubmitBlockHash === null
    || action.quoteBlockNumber < job.baselineBlock || action.quoteBlockNumber > action.preSubmitBlockNumber
    || input.baselineBlockHash?.toLowerCase() !== job.baselineHash.toLowerCase()
    || input.submitBlockHash?.toLowerCase() !== action.preSubmitBlockHash.toLowerCase()) return { ok: false, code: "baseline-unverified" };
  if (finalized.number < action.preSubmitBlockNumber || finalized.timestampSec <= BigInt(action.deadlineSec)) return { ok: false, code: "deadline-not-passed" };
  if (action.amountInWei <= 0n || action.minOutWei <= 0n) return { ok: false, code: "amount-invalid" };
  if (!validVector(input.actual)) return { ok: false, code: "balance-invalid" };
  const baseline = parseStoredVector(job.actualBaselineJson);
  const protectedBaseline = parseStoredVector(job.protectedBaselineJson);
  if (baseline === null || protectedBaseline === null || job.managed === null) return { ok: false, code: "baseline-unverified" };
  if (baseline.USDC !== protectedBaseline.USDC + job.allocationWei
    || baseline.WBNB !== protectedBaseline.WBNB || baseline.ETH !== protectedBaseline.ETH
    || baseline.CAKE !== protectedBaseline.CAKE || baseline.USDT !== protectedBaseline.USDT) {
    return { ok: false, code: "baseline-unverified" };
  }
  const expected = { ...baseline };
  const settled = input.allActions.filter((row) => row.actionId !== action.actionId && row.state === "settled");
  for (const fill of settled) {
    if (fill.receiptBlockNumber === null || fill.receiptBlockHash === null || fill.fillInWei === null
      || fill.fillOutWei === null || fill.txHash === null || fill.proofDigest === null
      || fill.receiptBlockNumber <= job.baselineBlock || fill.receiptBlockNumber > finalized.number
      || !input.canonicalReceiptActionIds.has(fill.actionId)) return { ok: false, code: "other-action-unverified" };
    const inputAsset = ASSETS.find((asset) => REBALANCE_TOKEN_ADDRESSES[asset].toLowerCase() === fill.tokenIn.toLowerCase());
    const outputAsset = ASSETS.find((asset) => REBALANCE_TOKEN_ADDRESSES[asset].toLowerCase() === fill.tokenOut.toLowerCase());
    if (inputAsset === undefined || outputAsset === undefined || fill.fillInWei <= 0n || fill.fillOutWei <= 0n) {
      return { ok: false, code: "other-action-unverified" };
    }
    if (expected[inputAsset] < fill.fillInWei) return { ok: false, code: "ledger-mismatch" };
    expected[inputAsset] -= fill.fillInWei;
    if (expected[outputAsset] + fill.fillOutWei >= UINT256_LIMIT) return { ok: false, code: "balance-overflow" };
    expected[outputAsset] += fill.fillOutWei;
  }
  const ledger: Record<(typeof ASSETS)[number], bigint> = {
    USDC: protectedBaseline.USDC + job.managed.USDC,
    WBNB: protectedBaseline.WBNB + job.managed.WBNB,
    ETH: protectedBaseline.ETH + job.managed.ETH,
    CAKE: protectedBaseline.CAKE + job.managed.CAKE,
    USDT: protectedBaseline.USDT,
  };
  if (ASSETS.some((asset) => expected[asset] >= UINT256_LIMIT || expected[asset] !== ledger[asset])) {
    return { ok: false, code: "ledger-mismatch" };
  }
  const noExecution = ASSETS.every((asset) => input.actual[asset] === expected[asset]);
  if (!noExecution) return { ok: false, code: "balance-mismatch", evidence: { expected: publicVector(expected as RebalanceBalanceVector), actual: publicVector(input.actual) } };
  const expectedInputToken = action.side === "buy" ? "USDC" : action.asset;
  const expectedOutputToken = action.side === "buy" ? action.asset : "USDC";
  if (action.tokenIn.toLowerCase() !== REBALANCE_TOKEN_ADDRESSES[expectedInputToken].toLowerCase()
    || action.tokenOut.toLowerCase() !== REBALANCE_TOKEN_ADDRESSES[expectedOutputToken].toLowerCase()
    || action.amountInWei <= 0n || action.minOutWei <= 0n) return { ok: false, code: "amount-invalid" };
  const endpointInput = action.side === "buy" ? "USDC" : action.asset;
  const endpointOutput = action.side === "buy" ? action.asset : "USDC";
  if (expected[endpointInput] < action.amountInWei) return { ok: false, code: "endpoint-hypothesis-invalid" };
  if (expected[endpointOutput] + action.minOutWei >= UINT256_LIMIT) return { ok: false, code: "endpoint-hypothesis-invalid" };
  const executedInputBalance = expected[endpointInput] - action.amountInWei;
  const executedOutputBalance = expected[endpointOutput] + action.minOutWei;
  if (input.actual[endpointInput] === executedInputBalance || input.actual[endpointOutput] === executedOutputBalance) {
    return { ok: false, code: "balance-ambiguous" };
  }
  const evidence = {
    v: 1, kind: "not-executed", actionId: action.actionId, jobId: job.jobId,
    claimGeneration: job.claimGeneration?.toString(10) ?? null,
    baselineBlock: job.baselineBlock.toString(10), baselineHash: job.baselineHash,
    submitBlock: action.preSubmitBlockNumber.toString(10), submitHash: action.preSubmitBlockHash,
    finalizedBlock: finalized.number.toString(10), finalizedHash: finalized.hash,
    finalizedTimestampSec: finalized.timestampSec.toString(10), deadlineSec: action.deadlineSec,
    expected: publicVector(expected as RebalanceBalanceVector), actual: publicVector(input.actual),
    appliedSettledActionIds: settled.map((row) => row.actionId).sort(), accountingToleranceWei: "0",
  };
  const digest = proofDigest(evidence);
  return { ok: true, proof: brandVerifiedNotExecutedProof({ chainId: 56, actionId: action.actionId,
    jobId: job.jobId, generation: job.claimGeneration, evidenceDigest: digest,
    evidenceJson: JSON.stringify({ ...evidence, evidenceDigest: digest }) }) };
}

export type RetirementProofResult =
  | { readonly ok: true; readonly proof: VerifiedQuantRebalanceRetirementProof }
  | { readonly ok: false; readonly code: string; readonly evidence?: Readonly<Record<string, unknown>> };

/** Key-dead, strict-past-deadline, single-finalized-vector retirement proof. */
export function proveQuantRebalanceRetirement(input: {
  readonly job: QuantRebalanceJobRow;
  readonly actions: readonly QuantRebalanceActionRow[];
  readonly keyValid: boolean;
  readonly finalized: QuantRebalanceFinalizedFacts;
  readonly actual: RebalanceBalanceVector;
}): RetirementProofResult {
  const { job, finalized } = input;
  if (job.claimGeneration === null || job.sessionPublicKey === null) return { ok: false, code: "claim-or-key-unavailable" };
  if (job.sessionExpirySec === null || !Number.isSafeInteger(job.sessionExpirySec) || job.sessionExpirySec <= 0) {
    return { ok: false, code: "session-expiry-unavailable" };
  }
  if (input.keyValid && finalized.timestampSec <= BigInt(job.sessionExpirySec)) return { ok: false, code: "key-still-valid" };
  const unresolved = input.actions.filter((action) => !["settled", "failed", "aborted"].includes(action.state));
  if (unresolved.some((action) => finalized.timestampSec <= BigInt(action.deadlineSec))) return { ok: false, code: "deadline-not-passed" };
  if (!validVector(input.actual) || !/^0x[0-9a-fA-F]{64}$/u.test(finalized.hash) || finalized.number < 0n) return { ok: false, code: "snapshot-unavailable" };
  const evidence = { v: 1, kind: "permanent-retirement", jobId: job.jobId,
    claimGeneration: job.claimGeneration.toString(10), finalizedBlock: finalized.number.toString(10),
    finalizedHash: finalized.hash, finalizedTimestampSec: finalized.timestampSec.toString(10), keyValid: input.keyValid,
    sessionExpirySec: job.sessionExpirySec, unresolvedActionIds: unresolved.map((action) => action.actionId).sort(),
    managed: job.managed === null ? null : Object.fromEntries(Object.entries(job.managed).map(([key, value]) => [key, value.toString(10)])),
    actual: publicVector(input.actual), vectorDigest: proofDigest(publicVector(input.actual)) };
  const digest = proofDigest(evidence);
  return { ok: true, proof: brandVerifiedRetirementProof({ chainId: 56, jobId: job.jobId,
    generation: job.claimGeneration, evidenceDigest: digest,
    evidenceJson: JSON.stringify({ ...evidence, evidenceDigest: digest }) }) };
}
