/**
 * Durable state for the TermiX Quant grid (QUANT-GRID W6 / R2.2, R3.3, R3.10,
 * R5.1, R7.3).
 *
 * ─── WHAT THIS STORE IS THE AUTHORITY ON ───────────────────────────────────
 *
 *   - the JOB: its wire facts, its sealed envelope, the parameters it was
 *     admitted under, and its ladder;
 *   - the LEVELS: which one holds inventory, which one is blocked;
 *   - the ACTIONS: the durable INTENT that exists before any key is opened,
 *     and the one CAS that moves inventory;
 *   - the EPOCHS: the balance baselines external activity and retirement are
 *     measured against.
 *
 * It is NOT the authority on whether a submission landed. That is the journal
 * (`src/store/journal.ts`) and the receipt. The two are joined in
 * `src/quant/reconcile.ts` and nowhere else.
 *
 * ─── THE FENCE ─────────────────────────────────────────────────────────────
 *
 * `withQuantFence` is the lending pattern verbatim (`lendingGuards.ts:1782`,
 * and BC31 makes it normative): `pg_advisory_xact_lock($1, hashtext($2))` in
 * the TWO-ARGUMENT form — the one-argument form shares one 32-bit space with
 * every other user of advisory locks — and every method a fence may call runs
 * ON THE LOCK'S OWN TRANSACTION, so an aborting fence rolls all of them back
 * together and no fence checks out a second pool connection while holding its
 * own. Merely acquiring the lock and then writing through the pool is NOT this
 * pattern and is what the condition names.
 *
 * ─── WHY EVERY STATEMENT IS STATIC ─────────────────────────────────────────
 *
 * `test/support/fakeSql.ts` dispatches on the statement TAG and never parses
 * SQL, so a predicate built at runtime would have zero executed coverage
 * offline while the cross-backend tests stayed green. That is the lending
 * `$3 - $4` blocker and the ERC-8004 `attname::text` lesson; every statement
 * here is a separate, static, tagged string with explicitly cast parameters,
 * and `test/quant.pg.test.ts` runs all of them against a real server.
 */
import { getAddress, type Address, type Hex } from "viem";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import type {
  QuantActionState,
  QuantHoldCode,
  QuantJobStatus,
  QuantLevelState,
  QuantObservation,
  QuantAccountingState,
  QuantEvidenceKind,
  QuantRecenterSide,
  QuantSeedOutcome,
  QuantSide,
  QuantWireState,
} from "../quant/types.js";

export type Clock = () => number;

/** Advisory-lock class id for the per-job fence. Restated, never imported: */
/* this module is the storage substrate and must not depend on the runtime. */
export const QUANT_LOCK_CLASSID = 0x5155_414e; // "QUAN"

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

export type QuantJobRow = {
  readonly quantJobId: string;
  readonly strategyId: string;
  readonly tradingWallet: Address;
  readonly allocationUWei: bigint;
  readonly dailyCapUWei: bigint;
  readonly termDays: number;
  readonly startedAtMs: number | null;
  readonly endsAtMs: number | null;
  readonly sessionExpiresAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly status: QuantJobStatus;
  /** The sealed envelope. Useless without the worker-only seed (R2.0.4). */
  readonly envelopeJson: string | null;
  readonly envelopeId: string | null;
  /** PUBLIC admission facts. No secret is ever written to this table. */
  readonly sessionPublicKey: Hex | null;
  readonly sessionExpiry: number | null;
  readonly permissionsDigest: Hex | null;
  readonly projectionDigest: Hex | null;
  readonly admittedAtMs: number | null;
  readonly chainCheckedAtMs: number | null;
  readonly wbnbCapMinLimitWei: bigint;
  readonly residualThresholdWei: bigint;
  /** The parameters this job executes under, frozen at admission (R2.8). */
  readonly paramsJson: string | null;
  readonly paramsDigest: Hex | null;
  readonly p0E18: bigint;
  readonly armBlock: bigint | null;
  readonly levels: number;
  readonly clipUWei: bigint;
  readonly idleUWei: bigint;
  readonly lastObservedBlock: bigint | null;
  readonly lastObservedHash: Hex | null;
  readonly staleObservations: number;
  readonly holdCode: QuantHoldCode | null;
  readonly holdCount: number;
  readonly lastJobReadAtMs: number | null;
  readonly reportedAtMs: number | null;
  readonly reportAttempts: number;
  readonly rowVersion: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly anchorE18: bigint;
  readonly ladderGen: number;
  readonly recenters: number;
  readonly recenterBudget: number;
  readonly lastRecenterAtMs: number | null;
  readonly recenterConsecutive: number;
  readonly recenterSide: QuantRecenterSide | null;
  readonly recenterBlockFirst: bigint | null;
  readonly recenterHashFirst: Hex | null;
  readonly recenterAtFirst: number | null;
  readonly lastObservedAtMs: number | null;
  readonly lastAcceptedBlock: bigint | null;
  readonly lastAcceptedHash: Hex | null;
  readonly lastAcceptedAtMs: number | null;
  readonly capRowsJson: string | null;
  readonly wireState: QuantWireState;
  readonly accountingState: QuantAccountingState;
  readonly accountingEpoch: number | null;
  readonly accountingEvidenceJson: string | null;
  readonly accountingRev: bigint;
  readonly reportPayloadHash: Hex | null;
  readonly reportResponseStatus: number | null;
};

export type QuantLevelRow = {
  readonly quantJobId: string;
  readonly levelIndex: number;
  readonly state: QuantLevelState;
  /** Prices change only in the fenced re-centre method. */
  readonly buyPriceE18: bigint;
  readonly sellPriceE18: bigint;
  readonly baseWei: bigint;
  readonly baseAtCycleStartWei: bigint;
  readonly basisUWei: bigint;
  readonly entryCostUWei: bigint;
  readonly actionSeq: number;
  readonly cyclesClosed: number;
  readonly realizedUWei: bigint;
  readonly residualWei: bigint;
  readonly priorState: QuantLevelState | null;
  readonly triggerConsecutive: number;
  readonly triggerSide: QuantSide | null;
  readonly lastActionAtMs: number | null;
  readonly holdCode: QuantHoldCode | null;
  readonly holdCount: number;
  readonly exitPlanJson: string | null;
  readonly retiredJson: string | null;
  readonly rowVersion: number;
  readonly ladderGen: number;
  readonly seedPending: boolean;
  readonly seedRefusals: number;
  readonly seedSubmissions: number;
  readonly seedLastCause: string | null;
  readonly seedOutcome: QuantSeedOutcome | null;
  readonly seedNote: string | null;
  readonly triggerBlockFirst: bigint | null;
  readonly triggerHashFirst: Hex | null;
  readonly triggerAtFirst: number | null;
};

export type QuantActionRow = {
  readonly journalKey: string;
  readonly quantJobId: string;
  readonly levelIndex: number;
  readonly actionSeq: number;
  readonly side: QuantSide;
  readonly state: QuantActionState;
  readonly priorLevelState: QuantLevelState;
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly quoteOutWei: bigint;
  readonly quoteBlock: bigint;
  readonly triggerBlock1: bigint;
  readonly triggerBlock2: bigint;
  readonly deadlineSec: number;
  readonly callsJson: string;
  readonly note: string;
  readonly impactBps: number;
  readonly preUWei: bigint;
  readonly preWbnbWei: bigint;
  readonly preNativeWei: bigint;
  readonly preNativeBlock: bigint | null;
  readonly basisUWei: bigint;
  readonly baseAtCycleStartWei: bigint;
  readonly submitFinalizedNumber: bigint | null;
  readonly submitFinalizedHash: Hex | null;
  readonly txHash: Hex | null;
  readonly fillInWei: bigint | null;
  readonly fillOutWei: bigint | null;
  /** Unverified telemetry ONLY (R5.6). Never read into a decision. */
  readonly feeDeltaWei: bigint | null;
  readonly resolutionJson: string | null;
  readonly failureCode: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly rowVersion: number;
  readonly ladderGen: number;
  readonly evidenceKind: QuantEvidenceKind;
  readonly executedBlock: bigint | null;
  readonly executedAtSec: bigint | null;
  readonly requiredNativeWei: bigint | null;
  /** R14 candidate evidence; historical actions remain nullable. */
  readonly gasPriceWei: bigint | null;
  readonly feeEstWei: bigint | null;
};

export type QuantEpochRow = {
  readonly quantJobId: string;
  readonly epoch: number;
  readonly startedBlock: bigint;
  readonly startedBlockHash: Hex | null;
  readonly baselineUWei: bigint;
  readonly baselineWbnbWei: bigint;
  readonly baselineNativeWei: bigint;
  readonly note: string;
  readonly createdAtMs: number;
  readonly verified: boolean;
};

export type QuantRecenterRow = {
  readonly quantJobId: string;
  readonly seq: number;
  readonly atMs: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly direction: QuantRecenterSide;
  readonly fromGen: number;
  readonly toGen: number;
  readonly oldAnchorE18: bigint;
  readonly newAnchorE18: bigint;
  readonly oldLinesJson: string;
  readonly newLinesJson: string;
  readonly upperPriorJson: string;
  readonly reseedScheduled: boolean;
  readonly cause: string;
  readonly evidenceBlock1: bigint;
  readonly evidenceBlock2: bigint;
  readonly evidenceHash1: Hex | null;
  readonly evidenceHash2: Hex | null;
  readonly evidenceAt1: number | null;
  readonly evidenceAt2: number | null;
};

export type QuantSeedEventRow = {
  readonly quantJobId: string;
  readonly levelIndex: number;
  readonly ladderGen: number;
  readonly acceptedBlock: bigint;
  readonly kind: "refusal" | "claim";
  readonly cause: string;
  readonly journalKey: string | null;
  readonly atMs: number;
};

export type QuantRunRow = {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly jobsSeen: number;
  readonly actions: number;
  readonly holds: number;
  readonly errors: number;
  readonly dryRun: boolean;
};

export type QuantReportRow = {
  readonly quantJobId: string;
  readonly attempt: number;
  readonly payloadDigest: Hex;
  readonly responseStatus: number;
  readonly notesApplied: number | null;
  readonly createdAtMs: number;
};

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

export type DiscoverQuantJobInput = {
  readonly quantJobId: string;
  readonly envelopeId: string;
  readonly envelopeJson: string;
  /**
   * The SOURCE namespace (QUANT-SELFTEST R2): the discovering worker's own
   * strategy id, persisted at discovery so a row is never unowned. The wire
   * refresh must then AGREE with it (R7) or the job is held.
   */
  readonly strategyId?: string;
  readonly nowMs: number;
};

export type UpdateQuantJobWireInput = {
  readonly quantJobId: string;
  readonly strategyId: string;
  readonly tradingWallet: Address;
  readonly allocationUWei: bigint;
  readonly dailyCapUWei: bigint;
  readonly termDays: number;
  readonly startedAtMs: number | null;
  readonly endsAtMs: number | null;
  readonly sessionExpiresAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly nowMs: number;
};

export type AdmitQuantJobInput = {
  readonly quantJobId: string;
  readonly expectedRowVersion: number;
  readonly sessionPublicKey: Hex;
  readonly sessionExpiry: number;
  readonly permissionsDigest: Hex;
  readonly projectionDigest: Hex;
  readonly wbnbCapMinLimitWei: bigint;
  readonly residualThresholdWei: bigint;
  readonly paramsJson: string;
  readonly paramsDigest: Hex;
  readonly p0E18: bigint;
  readonly armBlock: bigint;
  readonly armBlockHash?: Hex;
  readonly levels: readonly {
    readonly levelIndex: number;
    readonly buyPriceE18: bigint;
    readonly sellPriceE18: bigint;
    readonly seedPending?: boolean;
  }[];
  readonly clipUWei: bigint;
  readonly idleUWei: bigint;
  readonly baselineUWei: bigint;
  readonly baselineWbnbWei: bigint;
  readonly baselineNativeWei: bigint;
  readonly capRowsJson?: string | null;
  readonly recenterBudget?: number;
  readonly nowMs: number;
};

export type UpdateQuantJobWireResult = QuantJobRow & {
  readonly wireDiffers: boolean;
};

export type InsertQuantIntentInput = {
  readonly journalKey: string;
  readonly quantJobId: string;
  readonly levelIndex: number;
  readonly actionSeq: number;
  readonly side: QuantSide;
  readonly priorLevelState: QuantLevelState;
  readonly expectedLevelRowVersion: number;
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly quoteOutWei: bigint;
  readonly quoteBlock: bigint;
  readonly triggerBlock1: bigint;
  readonly triggerBlock2: bigint;
  readonly deadlineSec: number;
  readonly callsJson: string;
  readonly note: string;
  readonly impactBps: number;
  readonly preUWei: bigint;
  readonly preWbnbWei: bigint;
  readonly preNativeWei: bigint;
  readonly preNativeBlock?: bigint | null;
  readonly basisUWei: bigint;
  readonly baseAtCycleStartWei: bigint;
  readonly ladderGen?: number;
  readonly evidence?:
    | { readonly kind: "crossing"; readonly first: bigint; readonly second: bigint }
    | { readonly kind: "seed"; readonly accepted: bigint };
  readonly requiredNativeWei?: bigint;
  /** Required by the R14 worker; nullable in the compatibility input shape. */
  readonly gasPriceWei?: bigint | null;
  /** Required by the R14 worker; nullable in the compatibility input shape. */
  readonly feeEstWei?: bigint | null;
  readonly plannedWallet?: Address;
  readonly plannedProcessDigest?: Hex;
  readonly planObservationBlock?: bigint;
  readonly planObservationHash?: Hex;
  readonly planObservationAtMs?: number;
  readonly plannedAccountingRev?: bigint;
  readonly plannedAccountingEpoch?: number | null;
  readonly planTriggerFirst?: bigint | null;
  readonly plannedBuyPriceE18?: bigint;
  readonly plannedSellPriceE18?: bigint;
  readonly seedCounted?: boolean;
  readonly seedWindowCycles?: number;
  readonly maxQuoteLagBlocks?: number;
  readonly nowMs: number;
};

export type SettleQuantActionInput = {
  readonly journalKey: string;
  readonly quantJobId: string;
  readonly levelIndex: number;
  readonly txHash: Hex;
  readonly swapLogIndex: bigint;
  readonly fillInWei: bigint;
  readonly fillOutWei: bigint;
  readonly feeDeltaWei: bigint | null;
  readonly entryCostUWei: bigint;
  /** The level state after settlement, computed by the caller from the side. */
  readonly nextLevelState: QuantLevelState;
  readonly nextBaseWei: bigint;
  readonly nextBaseAtCycleStartWei: bigint;
  readonly nextBasisUWei: bigint;
  readonly cyclesClosedDelta: number;
  readonly realizedDeltaUWei: bigint;
  readonly residualDeltaWei: bigint;
  readonly exitPlanJson: string | null;
  readonly executedBlock?: bigint | null;
  readonly executedAtSec?: bigint | null;
  readonly nowMs: number;
};

export type QuantCasResult<T> =
  | { readonly kind: "ok"; readonly record: T }
  | { readonly kind: "conflict"; readonly record: T | null };

export const QUANT_ACCEPTED_SNAPSHOT: unique symbol = Symbol("quant-accepted-snapshot");

export type QuantObservationAcceptance = {
  readonly accepted: boolean;
  readonly reason?: "not-newer" | "spacing" | "paused" | "wire-changed"
    | "external-activity" | "params-changed" | "revoked" | "ended"
    | "stale-outage" | "observation-unverified";
  readonly observation: QuantObservation;
  readonly job: QuantJobRow;
  readonly levels: readonly QuantLevelRow[];
  readonly [QUANT_ACCEPTED_SNAPSHOT]: true;
};

export type RecenterLadderInput = {
  readonly quantJobId: string;
  readonly expectedGeneration: number;
  readonly observationBlock: bigint;
  readonly observationHash: Hex;
  readonly observationAtMs: number;
  readonly side: QuantRecenterSide;
  readonly newAnchorE18: bigint;
  readonly newBuyPrice: readonly bigint[];
  readonly newSellPrice: readonly bigint[];
  readonly cooldownSec?: number;
  readonly cause: string;
  readonly nowMs: number;
  readonly reseed: boolean;
  readonly expectedWallet?: Address;
  readonly expectedProcessDigest?: Hex;
};

/**
 * The work a fence may do, ALL of it on the lock's own transaction.
 *
 * Every method here runs on the transaction that holds
 * `pg_advisory_xact_lock`, so a fence that throws rolls back its reads AND its
 * writes together. There is deliberately NO escape hatch to the pool: a method
 * missing from this interface is a method a fence cannot call.
 */
export type QuantFence = {
  getJob(quantJobId: string): Promise<QuantJobRow | null>;
  listLevels(quantJobId: string): Promise<readonly QuantLevelRow[]>;
  listNonTerminalActions(quantJobId: string): Promise<readonly QuantActionRow[]>;
  acceptObservation(input: {
    readonly quantJobId: string;
    readonly observation: QuantObservation;
    readonly intervalMs: number;
    readonly processDigest?: Hex;
  }): Promise<QuantObservationAcceptance>;
  resetLatches(quantJobId: string, resetLevels?: boolean): Promise<void>;
  currentEpoch(quantJobId: string): Promise<QuantEpochRow | null>;
  listRecentBuys(quantJobId: string, sinceMs: number): Promise<readonly QuantActionRow[]>;
  insertIntent(input: InsertQuantIntentInput): Promise<QuantCasResult<QuantActionRow>>;
  convertSeed(input: {
    readonly quantJobId: string;
    readonly levelIndex: number;
    readonly seedWindowCycles: number;
    readonly ladderGen?: number;
    readonly expectedProcessDigest?: Hex;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantLevelRow>>;
  recordLevelOutcome(input: {
    readonly quantJobId: string;
    readonly levelIndex: number;
    readonly holdCode: QuantHoldCode | null;
    readonly seedCounted: boolean;
    readonly acceptedBlock?: bigint | null;
    readonly acceptedHash?: Hex | null;
    readonly acceptedAtMs?: number | null;
    readonly ladderGen?: number;
    readonly expectedProcessDigest?: Hex;
    readonly cause?: string;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantLevelRow>>;
  recenterLadder(input: RecenterLadderInput): Promise<QuantCasResult<QuantJobRow>>;
  setAccountingState(input: {
    readonly quantJobId: string;
    readonly state: QuantAccountingState;
    readonly epoch: number | null;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<QuantJobRow | null>;
  publishAccountingVerdict(input: {
    readonly quantJobId: string;
    readonly expectedAccountingRev: bigint;
    readonly expectedEpoch: number;
    readonly expectedEpochHash?: Hex | null;
    readonly observationBlock: bigint;
    readonly observationHash?: Hex | null;
    readonly admissible: boolean;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<{ readonly ok: boolean; readonly reason?: "reconcile-stale" }>;
  publishTruthVerdict(input: {
    readonly quantJobId: string;
    readonly expectedAccountingRev: bigint;
    readonly expectedEpoch: number;
    readonly expectedEpochHash?: Hex | null;
    readonly observationBlock: bigint;
    readonly observationHash?: Hex | null;
    readonly admissible: boolean;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<{ readonly ok: boolean; readonly reason?: "reconcile-stale" }>;
  setLevelTrigger(input: {
    readonly quantJobId: string;
    readonly levelIndex: number;
    readonly consecutive: number;
    readonly side: QuantSide | null;
  }): Promise<void>;
  setLevelHold(input: {
    readonly quantJobId: string;
    readonly levelIndex: number;
    readonly holdCode: QuantHoldCode | null;
  }): Promise<void>;
  setJobHold(input: {
    readonly quantJobId: string;
    readonly holdCode: QuantHoldCode | null;
  }): Promise<void>;
  recordObservation(input: {
    readonly quantJobId: string;
    readonly observation: QuantObservation;
  }): Promise<void>;
  markStaleObservation(quantJobId: string, stale: number): Promise<void>;
};

export interface QuantJobStore {
  discoverJob(input: DiscoverQuantJobInput): Promise<QuantJobRow>;
  updateJobWire(input: UpdateQuantJobWireInput): Promise<UpdateQuantJobWireResult | null>;
  replaceEnvelope(quantJobId: string, envelopeJson: string, nowMs: number): Promise<void>;
  admitJob(input: AdmitQuantJobInput): Promise<QuantCasResult<QuantJobRow>>;
  getJob(quantJobId: string): Promise<QuantJobRow | null>;
  listJobs(): Promise<readonly QuantJobRow[]>;
  /**
   * Every job this process may WORK. QUANT-SELFTEST R2: a worker sees only
   * rows of ITS strategy (plus rows not yet wire-refreshed, whose strategy is
   * still ''), so a self-test process and a production process sharing a
   * database can never touch each other's jobs.
   */
  listWorkableJobs(strategyId: string): Promise<readonly QuantJobRow[]>;
  holdJob(input: { readonly quantJobId: string; readonly holdCode: QuantHoldCode | null; readonly nowMs: number }): Promise<void>;
  pauseJob(input: { readonly quantJobId: string; readonly nowMs: number }): Promise<boolean>;
  resumeJob(input: { readonly quantJobId: string; readonly nowMs: number }): Promise<boolean>;
  markEnded(input: { readonly quantJobId: string; readonly unresolved: boolean; readonly nowMs: number }): Promise<void>;
  markReported(input: { readonly quantJobId: string; readonly nowMs: number }): Promise<void>;
  listLevels(quantJobId: string): Promise<readonly QuantLevelRow[]>;
  listActions(quantJobId: string): Promise<readonly QuantActionRow[]>;
  listNonTerminalActions(quantJobId: string): Promise<readonly QuantActionRow[]>;
  acceptObservation(input: {
    readonly quantJobId: string;
    readonly observation: QuantObservation;
    readonly intervalMs: number;
    readonly processDigest?: Hex;
  }): Promise<QuantObservationAcceptance>;
  resetLatches(quantJobId: string, resetLevels?: boolean): Promise<void>;
  setAccountingState(input: {
    readonly quantJobId: string;
    readonly state: QuantAccountingState;
    readonly epoch: number | null;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<QuantJobRow | null>;
  publishAccountingVerdict(input: {
    readonly quantJobId: string;
    readonly expectedAccountingRev: bigint;
    readonly expectedEpoch: number;
    readonly expectedEpochHash?: Hex | null;
    readonly observationBlock: bigint;
    readonly observationHash?: Hex | null;
    readonly admissible: boolean;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<{ readonly ok: boolean; readonly reason?: "reconcile-stale" }>;
  publishTruthVerdict(input: {
    readonly quantJobId: string;
    readonly expectedAccountingRev: bigint;
    readonly expectedEpoch: number;
    readonly expectedEpochHash?: Hex | null;
    readonly observationBlock: bigint;
    readonly observationHash?: Hex | null;
    readonly admissible: boolean;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<{ readonly ok: boolean; readonly reason?: "reconcile-stale" }>;
  getAction(journalKey: string): Promise<QuantActionRow | null>;
  /** `intended → submitted`, persisting the finalized ancestor in the SAME CAS. */
  markActionSubmitted(input: {
    readonly journalKey: string;
    readonly expectedRowVersion: number;
    readonly submitFinalizedNumber: bigint;
    readonly submitFinalizedHash: Hex;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantActionRow>>;
  /** `intended → aborted` + level restore, in ONE transaction (R5.2). */
  abortIntent(input: {
    readonly journalKey: string;
    readonly expectedRowVersion: number;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantActionRow>>;
  setActionState(input: {
    readonly journalKey: string;
    readonly state: QuantActionState;
    readonly failureCode?: string | null;
    readonly txHash?: Hex | null;
    readonly resolutionJson?: string | null;
    readonly restoreLevel?: boolean;
    readonly nowMs: number;
  }): Promise<QuantActionRow | null>;
  /** Action + level + receipt ownership + accounting, in ONE transaction. */
  settleAction(input: SettleQuantActionInput): Promise<QuantCasResult<QuantActionRow>>;
  retireLevel(input: {
    readonly quantJobId: string;
    readonly levelIndex: number;
    readonly retiredJson: string;
    readonly epoch: {
      readonly startedBlock: bigint;
      readonly startedBlockHash: Hex;
      readonly baselineUWei: bigint;
      readonly baselineWbnbWei: bigint;
      readonly baselineNativeWei: bigint;
      readonly note: string;
    };
    readonly journalKey?: string;
    readonly expectedLevelRowVersion?: number;
    readonly expectedState?: QuantLevelState;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantLevelRow>>;
  openEpoch(input: {
    readonly quantJobId: string;
    readonly startedBlock: bigint;
    readonly startedBlockHash: Hex;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly note: string;
    readonly nowMs: number;
  }): Promise<QuantEpochRow>;
  acknowledgeExternal(input: {
    readonly quantJobId: string;
    readonly startedBlock: bigint;
    readonly startedBlockHash: Hex;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantEpochRow>>;
  listRecenters(quantJobId: string): Promise<readonly QuantRecenterRow[]>;
  listSeedEvents(quantJobId: string): Promise<readonly QuantSeedEventRow[]>;
  verifyCurrentEpoch(input: {
    readonly quantJobId: string;
    readonly verified: boolean;
    readonly nowMs: number;
  }): Promise<boolean>;
  verifyEpochBaseline(input: {
    readonly quantJobId: string;
    readonly epoch: number;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly nowMs: number;
  }): Promise<boolean>;
  setEpochHash(input: {
    readonly quantJobId: string;
    readonly epoch: number;
    readonly blockHash: Hex;
    readonly nowMs: number;
  }): Promise<boolean>;
  listAccountingActions(quantJobId: string): Promise<readonly QuantActionRow[]>;
  currentEpoch(quantJobId: string): Promise<QuantEpochRow | null>;
  listObservations(quantJobId: string, limit: number): Promise<readonly QuantObservation[]>;
  recordIndexerTrades(
    quantJobId: string,
    trades: readonly {
      readonly txHash: Hex;
      readonly direction: string;
      readonly amountIn: string;
      readonly amountOut: string;
      readonly blockTimeMs: number | null;
      readonly note: string | null;
    }[],
    nowMs: number,
  ): Promise<void>;
  listIndexerTrades(quantJobId: string): Promise<readonly {
    readonly txHash: Hex;
    readonly direction: string;
    readonly amountIn: string;
    readonly amountOut: string;
    readonly blockTimeMs: number | null;
  }[]>;
  recordReport(input: {
    readonly quantJobId: string;
    readonly payloadDigest: Hex;
    readonly responseStatus: number;
    readonly notesApplied: number | null;
    readonly nowMs: number;
  }): Promise<QuantReportRow>;
  listReports(quantJobId: string): Promise<readonly QuantReportRow[]>;
  recordRun(row: QuantRunRow): Promise<void>;
  withQuantFence<T>(quantJobId: string, work: (fence: QuantFence) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const WORKABLE: ReadonlySet<QuantJobStatus> = new Set<QuantJobStatus>([
  "discovered", "armed", "held", "paused", "ended", "ended-unresolved", "reported",
]);

const REPORT_HORIZON_MS = 7 * 24 * 60 * 60 * 1_000;

const TERMINAL_ACTIONS: ReadonlySet<QuantActionState> = new Set<QuantActionState>([
  "settled", "failed", "aborted",
]);

function canonicalObservation(input: QuantObservation): QuantObservation {
  return {
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    observedAtMs: input.observedAtMs,
    midE18: input.midE18,
  };
}

function isR14ParamsJson(paramsJson: string | null): boolean {
  if (paramsJson === null) return false;
  try {
    const raw: unknown = JSON.parse(paramsJson);
    return typeof raw === "object" && raw !== null
      && (raw as Record<string, unknown>)["paramsSchema"] === "r14";
  } catch {
    return false;
  }
}

function hasR14FeeEvidence(input: InsertQuantIntentInput): boolean {
  return input.gasPriceWei !== undefined && input.gasPriceWei !== null
    && input.gasPriceWei > 0n
    && input.feeEstWei !== undefined && input.feeEstWei !== null
    && input.feeEstWei > 0n;
}

/* -------------------------------------------------------------------------- */
/* Memory backend (tests only — the worker requires DATABASE_URL)             */
/* -------------------------------------------------------------------------- */

export class MemoryQuantJobStore implements QuantJobStore {
  readonly #now: Clock;
  readonly #jobs = new Map<string, QuantJobRow>();
  readonly #levels = new Map<string, QuantLevelRow>();
  readonly #actions = new Map<string, QuantActionRow>();
  readonly #epochs = new Map<string, QuantEpochRow[]>();
  readonly #recenters = new Map<string, QuantRecenterRow[]>();
  readonly #seedEvents = new Map<string, QuantSeedEventRow[]>();
  readonly #observations = new Map<string, QuantObservation[]>();
  readonly #indexer = new Map<string, Map<string, {
    txHash: Hex; direction: string; amountIn: string; amountOut: string;
    blockTimeMs: number | null;
  }>>();
  readonly #reports = new Map<string, QuantReportRow[]>();
  readonly #runs: QuantRunRow[] = [];
  readonly #ownership = new Set<string>();
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  #levelKey(jobId: string, index: number): string {
    return `${jobId}#${index}`;
  }

  async discoverJob(input: DiscoverQuantJobInput): Promise<QuantJobRow> {
    return this.withQuantFence(input.quantJobId, async () => this.#discoverJobUnsafe(input));
  }

  async #discoverJobUnsafe(input: DiscoverQuantJobInput): Promise<QuantJobRow> {
    const existing = this.#jobs.get(input.quantJobId);
    if (existing !== undefined) return structuredClone(existing);
    const row: QuantJobRow = {
      quantJobId: input.quantJobId,
      strategyId: input.strategyId ?? "",
      tradingWallet: getAddress("0x0000000000000000000000000000000000000000"),
      allocationUWei: 0n, dailyCapUWei: 0n, termDays: 0,
      startedAtMs: null, endsAtMs: null, sessionExpiresAtMs: null, revokedAtMs: null,
      status: "discovered",
      envelopeJson: input.envelopeJson, envelopeId: input.envelopeId,
      sessionPublicKey: null, sessionExpiry: null,
      permissionsDigest: null, projectionDigest: null,
      admittedAtMs: null, chainCheckedAtMs: null,
      wbnbCapMinLimitWei: 0n, residualThresholdWei: 0n,
      paramsJson: null, paramsDigest: null,
      p0E18: 0n, armBlock: null, levels: 0, clipUWei: 0n, idleUWei: 0n,
      lastObservedBlock: null, lastObservedHash: null, staleObservations: 0,
      holdCode: null, holdCount: 0, lastJobReadAtMs: null,
      reportedAtMs: null, reportAttempts: 0,
      rowVersion: 1, createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
      anchorE18: 0n, ladderGen: 0, recenters: 0, recenterBudget: 0,
      lastRecenterAtMs: null, recenterConsecutive: 0, recenterSide: null,
      recenterBlockFirst: null, recenterHashFirst: null, recenterAtFirst: null,
      lastObservedAtMs: null, lastAcceptedBlock: null, lastAcceptedHash: null,
      lastAcceptedAtMs: null, capRowsJson: null, wireState: "compatible",
      accountingState: "ok", accountingEpoch: null, accountingEvidenceJson: null,
      accountingRev: 0n,
      reportPayloadHash: null, reportResponseStatus: null,
    };
    this.#jobs.set(row.quantJobId, row);
    return structuredClone(row);
  }

  async updateJobWire(input: UpdateQuantJobWireInput): Promise<UpdateQuantJobWireResult | null> {
    const result = await this.withQuantFence(input.quantJobId, async () => {
      const previous = this.#jobs.get(input.quantJobId);
      if (previous === undefined) return null;
      const wireDiffers = previous.admittedAtMs !== null && (
        previous.tradingWallet.toLowerCase() !== getAddress(input.tradingWallet).toLowerCase()
        || previous.allocationUWei !== input.allocationUWei
        || previous.termDays !== input.termDays
      );
      return this.#updateJobWireUnsafe(input, wireDiffers);
    });
    return result as UpdateQuantJobWireResult | null;
  }

  #updateJobWireUnsafe(
    input: UpdateQuantJobWireInput,
    wireDiffersOverride?: boolean,
  ): UpdateQuantJobWireResult | null {
    const existing = this.#jobs.get(input.quantJobId);
    if (existing === undefined) return null;
    // QUANT-SELFTEST R7: a wire record naming a DIFFERENT strategy than the one
    // this row was discovered/admitted under is REFUSED — none of its fields
    // are applied — and the caller holds the job. Write-once from '' only.
    if (existing.strategyId !== "" && existing.strategyId !== input.strategyId) return null;
    const wireDiffers = wireDiffersOverride ?? (existing.admittedAtMs !== null && (
      existing.tradingWallet.toLowerCase() !== getAddress(input.tradingWallet).toLowerCase()
      || existing.allocationUWei !== input.allocationUWei
      || existing.termDays !== input.termDays
    ));
    const admitted = existing.admittedAtMs !== null;
    const next: QuantJobRow = {
      ...existing,
      strategyId: existing.strategyId === "" ? input.strategyId : existing.strategyId,
      tradingWallet: admitted ? existing.tradingWallet : getAddress(input.tradingWallet),
      allocationUWei: admitted ? existing.allocationUWei : input.allocationUWei,
      dailyCapUWei: input.dailyCapUWei,
      termDays: admitted ? existing.termDays : input.termDays,
      startedAtMs: input.startedAtMs,
      endsAtMs: input.endsAtMs,
      sessionExpiresAtMs: input.sessionExpiresAtMs,
      revokedAtMs: input.revokedAtMs,
      wireState: admitted && wireDiffers ? "changed" : "compatible",
      lastJobReadAtMs: input.nowMs,
      rowVersion: existing.rowVersion + 1,
      updatedAtMs: input.nowMs,
    };
    this.#jobs.set(next.quantJobId, next);
    return Object.assign(structuredClone(next), { wireDiffers });
  }

  async replaceEnvelope(quantJobId: string, envelopeJson: string, nowMs: number): Promise<void> {
    await this.withQuantFence(quantJobId, async () => {
      const existing = this.#jobs.get(quantJobId);
      if (existing === undefined) return;
      this.#jobs.set(quantJobId, {
        ...existing, envelopeJson, rowVersion: existing.rowVersion + 1, updatedAtMs: nowMs,
      });
    });
  }

  async admitJob(input: AdmitQuantJobInput): Promise<QuantCasResult<QuantJobRow>> {
    return this.withQuantFence(input.quantJobId, async () => this.#admitJobUnsafe(input));
  }

  async #admitJobUnsafe(input: AdmitQuantJobInput): Promise<QuantCasResult<QuantJobRow>> {
    const existing = this.#jobs.get(input.quantJobId);
    if (existing === undefined) return { kind: "conflict", record: null };
    if (existing.rowVersion !== input.expectedRowVersion || existing.status !== "discovered") {
      return { kind: "conflict", record: structuredClone(existing) };
    }
    const next: QuantJobRow = {
      ...existing,
      status: "armed",
      sessionPublicKey: input.sessionPublicKey,
      sessionExpiry: input.sessionExpiry,
      permissionsDigest: input.permissionsDigest,
      projectionDigest: input.projectionDigest,
      admittedAtMs: input.nowMs,
      chainCheckedAtMs: input.nowMs,
      wbnbCapMinLimitWei: input.wbnbCapMinLimitWei,
      residualThresholdWei: input.residualThresholdWei,
      paramsJson: input.paramsJson,
      paramsDigest: input.paramsDigest,
      p0E18: input.p0E18,
      armBlock: input.armBlock,
      levels: input.levels.length,
      clipUWei: input.clipUWei,
      idleUWei: input.idleUWei,
      anchorE18: input.p0E18,
      ladderGen: 0,
      recenters: 0,
      recenterBudget: input.recenterBudget ?? 0,
      lastRecenterAtMs: null,
      recenterConsecutive: 0,
      recenterSide: null,
      recenterBlockFirst: null,
      recenterHashFirst: null,
      recenterAtFirst: null,
      lastObservedAtMs: null,
      lastAcceptedBlock: null,
      lastAcceptedHash: null,
      lastAcceptedAtMs: null,
      capRowsJson: input.capRowsJson ?? null,
      wireState: "compatible",
      accountingState: "ok",
      accountingEpoch: 1,
      accountingEvidenceJson: null,
      accountingRev: 0n,
      reportPayloadHash: null,
      reportResponseStatus: null,
      holdCode: null,
      rowVersion: existing.rowVersion + 1,
      updatedAtMs: input.nowMs,
    };
    this.#jobs.set(next.quantJobId, next);
    for (const level of input.levels) {
      const key = this.#levelKey(input.quantJobId, level.levelIndex);
      if (this.#levels.has(key)) continue; // WRITE-ONCE prices.
      this.#levels.set(key, {
        quantJobId: input.quantJobId,
        levelIndex: level.levelIndex,
        state: "armed-quote",
        buyPriceE18: level.buyPriceE18,
        sellPriceE18: level.sellPriceE18,
        baseWei: 0n, baseAtCycleStartWei: 0n, basisUWei: 0n, entryCostUWei: 0n,
        actionSeq: 0, cyclesClosed: 0, realizedUWei: 0n, residualWei: 0n,
        priorState: null, triggerConsecutive: 0, triggerSide: null,
        lastActionAtMs: null, holdCode: null, holdCount: 0,
        exitPlanJson: null, retiredJson: null, rowVersion: 1,
        ladderGen: 0, seedPending: level.seedPending === true, seedRefusals: 0, seedSubmissions: 0,
        seedLastCause: null, seedOutcome: null, seedNote: null,
        triggerBlockFirst: null, triggerHashFirst: null, triggerAtFirst: null,
      });
    }
      await this.#openEpochUnsafe({
      quantJobId: input.quantJobId,
      startedBlock: input.armBlock,
      startedBlockHash: input.armBlockHash ?? null,
      baselineUWei: input.baselineUWei,
      baselineWbnbWei: input.baselineWbnbWei,
      baselineNativeWei: input.baselineNativeWei,
      note: "arm",
      nowMs: input.nowMs,
    });
    return { kind: "ok", record: structuredClone(this.#jobs.get(input.quantJobId) ?? next) };
  }

  async getJob(quantJobId: string): Promise<QuantJobRow | null> {
    const row = this.#jobs.get(quantJobId);
    return row === undefined ? null : structuredClone(row);
  }

  async listJobs(): Promise<readonly QuantJobRow[]> {
    return [...this.#jobs.values()].map((row) => structuredClone(row))
      .sort((a, b) => (a.quantJobId < b.quantJobId ? -1 : 1));
  }

  async listWorkableJobs(strategyId: string): Promise<readonly QuantJobRow[]> {
    const nowMs = this.#now();
    return (await this.listJobs()).filter((row) => {
      if (!WORKABLE.has(row.status) || row.strategyId !== strategyId) return false;
      if (row.status !== "reported") return true;
      return row.endsAtMs === null
        || nowMs <= row.endsAtMs + REPORT_HORIZON_MS
        || [...this.#actions.values()].some((action) =>
          action.quantJobId === row.quantJobId && !TERMINAL_ACTIONS.has(action.state));
    });
  }

  private async setJobStatus(input: {
    readonly quantJobId: string;
    readonly status: QuantJobStatus;
    readonly holdCode?: QuantHoldCode | null;
    readonly nowMs: number;
  }): Promise<void> {
    await this.withQuantFence(input.quantJobId, async () => {
      this.#setJobStatusUnsafe(input);
      if (input.status === "paused") this.#resetLatchesUnsafe(input.quantJobId);
    });
  }

  #setJobStatusUnsafe(input: {
    readonly quantJobId: string;
    readonly status: QuantJobStatus;
    readonly holdCode?: QuantHoldCode | null;
    readonly nowMs: number;
  }): void {
    const existing = this.#jobs.get(input.quantJobId);
    if (existing === undefined) return;
    const allowed = input.status === "paused"
      ? existing.status === "armed" || existing.status === "held"
      : input.status === "armed"
        ? existing.status === "paused" || existing.status === "discovered" || existing.status === "held"
        : true;
    if (!allowed) return;
    this.#jobs.set(input.quantJobId, {
      ...existing,
      status: input.status,
      ...(input.holdCode === undefined ? {} : { holdCode: input.holdCode }),
      ...(input.status === "reported" ? { reportedAtMs: input.nowMs } : {}),
      rowVersion: existing.rowVersion + 1,
      updatedAtMs: input.nowMs,
    });
  }

  async holdJob(input: { readonly quantJobId: string; readonly holdCode: QuantHoldCode | null; readonly nowMs: number }): Promise<void> {
    await this.withQuantFence(input.quantJobId, async (fence) => {
      await fence.setJobHold({ quantJobId: input.quantJobId, holdCode: input.holdCode });
    });
  }

  async pauseJob(input: { readonly quantJobId: string; readonly nowMs: number }): Promise<boolean> {
    const before = await this.getJob(input.quantJobId);
    if (before === null || (before.status !== "armed" && before.status !== "held")) return false;
    await this.setJobStatus({ quantJobId: input.quantJobId, status: "paused", nowMs: input.nowMs });
    return (await this.getJob(input.quantJobId))?.status === "paused";
  }

  async resumeJob(input: { readonly quantJobId: string; readonly nowMs: number }): Promise<boolean> {
    const before = await this.getJob(input.quantJobId);
    if (before === null || before.status !== "paused") return false;
    await this.setJobStatus({
      quantJobId: input.quantJobId,
      status: before.admittedAtMs === null ? "discovered" : "armed",
      nowMs: input.nowMs,
    });
    return true;
  }

  async markEnded(input: { readonly quantJobId: string; readonly unresolved: boolean; readonly nowMs: number }): Promise<void> {
    await this.setJobStatus({
      quantJobId: input.quantJobId,
      status: input.unresolved ? "ended-unresolved" : "ended",
      nowMs: input.nowMs,
    });
  }

  async markReported(input: { readonly quantJobId: string; readonly nowMs: number }): Promise<void> {
    await this.setJobStatus({ quantJobId: input.quantJobId, status: "reported", nowMs: input.nowMs });
  }

  async listLevels(quantJobId: string): Promise<readonly QuantLevelRow[]> {
    return [...this.#levels.values()]
      .filter((row) => row.quantJobId === quantJobId)
      .sort((a, b) => a.levelIndex - b.levelIndex)
      .map((row) => structuredClone(row));
  }

  async listActions(quantJobId: string): Promise<readonly QuantActionRow[]> {
    return [...this.#actions.values()]
      .filter((row) => row.quantJobId === quantJobId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((row) => structuredClone(row));
  }

  async listNonTerminalActions(quantJobId: string): Promise<readonly QuantActionRow[]> {
    return (await this.listActions(quantJobId)).filter(
      (row) => !TERMINAL_ACTIONS.has(row.state),
    );
  }

  async getAction(journalKey: string): Promise<QuantActionRow | null> {
    const row = this.#actions.get(journalKey);
    return row === undefined ? null : structuredClone(row);
  }

  async markActionSubmitted(input: {
    readonly journalKey: string;
    readonly expectedRowVersion: number;
    readonly submitFinalizedNumber: bigint;
    readonly submitFinalizedHash: Hex;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantActionRow>> {
    return this.withQuantFence(
      this.#actions.get(input.journalKey)?.quantJobId ?? "",
      async () => this.#markActionSubmittedUnsafe(input),
    );
  }

  async #markActionSubmittedUnsafe(input: {
    readonly journalKey: string;
    readonly expectedRowVersion: number;
    readonly submitFinalizedNumber: bigint;
    readonly submitFinalizedHash: Hex;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantActionRow>> {
    const existing = this.#actions.get(input.journalKey);
    if (existing === undefined) return { kind: "conflict", record: null };
    if (existing.state !== "intended" || existing.rowVersion !== input.expectedRowVersion) {
      return { kind: "conflict", record: structuredClone(existing) };
    }
    const next: QuantActionRow = {
      ...existing,
      state: "submitted",
      submitFinalizedNumber: input.submitFinalizedNumber,
      submitFinalizedHash: input.submitFinalizedHash,
      rowVersion: existing.rowVersion + 1,
      updatedAtMs: input.nowMs,
    };
    this.#actions.set(next.journalKey, next);
    const level = this.#levels.get(this.#levelKey(existing.quantJobId, existing.levelIndex));
    if (level?.seedPending === true && existing.evidenceKind === "seed") {
      const event = this.#recordSeedEventUnsafe({
        quantJobId: existing.quantJobId, levelIndex: existing.levelIndex,
        ladderGen: existing.ladderGen, acceptedBlock: existing.triggerBlock1,
        kind: "claim", cause: `submitted:${existing.journalKey}`,
        journalKey: existing.journalKey, atMs: input.nowMs,
      });
      if (event) {
        const current = this.#levels.get(this.#levelKey(existing.quantJobId, existing.levelIndex));
        if (current !== undefined) this.#levels.set(this.#levelKey(existing.quantJobId, existing.levelIndex), {
          ...current,
          seedSubmissions: current.seedSubmissions + 1,
          seedLastCause: `submitted:${existing.journalKey}`,
          rowVersion: current.rowVersion + 1,
        });
      }
    }
    const job = this.#jobs.get(existing.quantJobId);
    if (job !== undefined) this.#jobs.set(existing.quantJobId, {
      ...job, accountingRev: job.accountingRev + 1n,
      rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
    });
    return { kind: "ok", record: structuredClone(next) };
  }

  async abortIntent(input: {
    readonly journalKey: string;
    readonly expectedRowVersion: number;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantActionRow>> {
    const quantJobId = this.#actions.get(input.journalKey)?.quantJobId ?? "";
    return this.withQuantFence(quantJobId, async () => {
      const existing = this.#actions.get(input.journalKey);
      if (existing === undefined) return { kind: "conflict", record: null };
      if (existing.state !== "intended" || existing.rowVersion !== input.expectedRowVersion) {
        return { kind: "conflict", record: structuredClone(existing) };
      }
      const next: QuantActionRow = {
        ...existing, state: "aborted",
        rowVersion: existing.rowVersion + 1, updatedAtMs: input.nowMs,
      };
      this.#actions.set(next.journalKey, next);
      this.#restoreLevel(existing);
      const job = this.#jobs.get(existing.quantJobId);
      if (job !== undefined) this.#jobs.set(existing.quantJobId, {
        ...job, accountingRev: job.accountingRev + 1n,
        rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
      });
      return { kind: "ok", record: structuredClone(next) };
    });
  }

  #restoreLevel(action: QuantActionRow): void {
    const key = this.#levelKey(action.quantJobId, action.levelIndex);
    const level = this.#levels.get(key);
    if (level === undefined || level.state === "retired") return;
    this.#levels.set(key, {
      ...level,
      state: action.priorLevelState,
      triggerConsecutive: 0,
      triggerSide: null,
      rowVersion: level.rowVersion + 1,
    });
  }

  async setActionState(input: {
    readonly journalKey: string;
    readonly state: QuantActionState;
    readonly failureCode?: string | null;
    readonly txHash?: Hex | null;
    readonly resolutionJson?: string | null;
    readonly restoreLevel?: boolean;
    readonly nowMs: number;
  }): Promise<QuantActionRow | null> {
    const action = this.#actions.get(input.journalKey);
    if (action === undefined) return null;
    return this.withQuantFence(action.quantJobId, async () => this.#setActionStateUnsafe(input));
  }

  async #setActionStateUnsafe(input: {
    readonly journalKey: string;
    readonly state: QuantActionState;
    readonly failureCode?: string | null;
    readonly txHash?: Hex | null;
    readonly resolutionJson?: string | null;
    readonly restoreLevel?: boolean;
    readonly nowMs: number;
  }): Promise<QuantActionRow | null> {
    const existing = this.#actions.get(input.journalKey);
    if (existing === undefined) return null;
    if (TERMINAL_ACTIONS.has(existing.state)) return structuredClone(existing);
    const next: QuantActionRow = {
      ...existing,
      state: input.state,
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      ...(input.txHash === undefined ? {} : { txHash: input.txHash }),
      ...(input.resolutionJson === undefined ? {} : { resolutionJson: input.resolutionJson }),
      rowVersion: existing.rowVersion + 1,
      updatedAtMs: input.nowMs,
    };
    this.#actions.set(next.journalKey, next);
    if (input.state === "failed" && existing.evidenceKind === "seed" && input.failureCode !== undefined
      && input.failureCode !== null) {
      const levelKey = this.#levelKey(existing.quantJobId, existing.levelIndex);
      const level = this.#levels.get(levelKey);
      if (level !== undefined && level.ladderGen === existing.ladderGen) this.#levels.set(levelKey, {
        ...level,
        seedLastCause: `failed:${existing.journalKey}:${input.failureCode}`,
        rowVersion: level.rowVersion + 1,
      });
    }
    if (input.restoreLevel === true) this.#restoreLevel(existing);
    const job = this.#jobs.get(existing.quantJobId);
    if (job !== undefined) this.#jobs.set(existing.quantJobId, {
      ...job, accountingRev: job.accountingRev + 1n,
      rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
    });
    return structuredClone(next);
  }

  async settleAction(input: SettleQuantActionInput): Promise<QuantCasResult<QuantActionRow>> {
    return this.withQuantFence(input.quantJobId, async () => this.#settleActionUnsafe(input));
  }

  async #settleActionUnsafe(input: SettleQuantActionInput): Promise<QuantCasResult<QuantActionRow>> {
    const existing = this.#actions.get(input.journalKey);
    if (existing === undefined) return { kind: "conflict", record: null };
    if (existing.quantJobId !== input.quantJobId || existing.levelIndex !== input.levelIndex) {
      return { kind: "conflict", record: structuredClone(existing) };
    }
    // IDEMPOTENT: a second settle of the same action is a no-op, not an error.
    if (existing.state === "settled") return { kind: "ok", record: structuredClone(existing) };
    if (existing.state === "failed" || existing.state === "aborted") {
      return { kind: "conflict", record: structuredClone(existing) };
    }
    const level = this.#levels.get(this.#levelKey(input.quantJobId, input.levelIndex));
    if (level === undefined) return { kind: "conflict", record: structuredClone(existing) };
    const job = this.#jobs.get(existing.quantJobId);
    const ownership = `${input.txHash.toLowerCase()}|${job?.tradingWallet.toLowerCase() ?? ""}|${input.swapLogIndex}`;
    if (this.#ownership.has(ownership)) {
      return { kind: "conflict", record: structuredClone(existing) };
    }
    this.#ownership.add(ownership);
    const next: QuantActionRow = {
      ...existing,
      state: "settled",
      txHash: input.txHash,
      fillInWei: input.fillInWei,
      fillOutWei: input.fillOutWei,
      feeDeltaWei: input.feeDeltaWei,
      executedBlock: input.executedBlock ?? existing.executedBlock,
      executedAtSec: input.executedAtSec ?? existing.executedAtSec,
      rowVersion: existing.rowVersion + 1,
      updatedAtMs: input.nowMs,
    };
    this.#actions.set(next.journalKey, next);
    const key = this.#levelKey(input.quantJobId, input.levelIndex);
    if (level.state !== "retired") {
      this.#levels.set(key, {
        ...level,
        state: input.nextLevelState,
        baseWei: input.nextBaseWei,
        baseAtCycleStartWei: input.nextBaseAtCycleStartWei,
        basisUWei: input.nextBasisUWei,
        entryCostUWei: input.entryCostUWei,
        seedPending: input.nextLevelState === "holding-base" ? false : level.seedPending,
        seedOutcome: input.nextLevelState === "holding-base" && level.seedPending
          ? "seeded" : level.seedOutcome,
        cyclesClosed: level.cyclesClosed + input.cyclesClosedDelta,
        realizedUWei: level.realizedUWei + input.realizedDeltaUWei,
        residualWei: level.residualWei + input.residualDeltaWei,
        exitPlanJson: input.exitPlanJson,
        triggerConsecutive: 0,
        triggerSide: null,
        lastActionAtMs: input.nowMs,
        rowVersion: level.rowVersion + 1,
      });
    }
    if (job !== undefined) this.#jobs.set(job.quantJobId, {
      ...job, accountingRev: job.accountingRev + 1n,
      rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
    });
    return { kind: "ok", record: structuredClone(next) };
  }

  async retireLevel(input: {
    readonly quantJobId: string;
    readonly levelIndex: number;
    readonly retiredJson: string;
    readonly epoch: {
      readonly startedBlock: bigint;
      readonly startedBlockHash: Hex;
      readonly baselineUWei: bigint;
      readonly baselineWbnbWei: bigint;
      readonly baselineNativeWei: bigint;
      readonly note: string;
    };
    readonly journalKey?: string;
    readonly expectedLevelRowVersion?: number;
    readonly expectedState?: QuantLevelState;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantLevelRow>> {
    return this.withQuantFence(input.quantJobId, async () => this.#retireLevelUnsafe(input));
  }

  async #retireLevelUnsafe(input: {
    readonly quantJobId: string;
    readonly levelIndex: number;
    readonly retiredJson: string;
    readonly epoch: {
      readonly startedBlock: bigint;
      readonly startedBlockHash: Hex;
      readonly baselineUWei: bigint;
      readonly baselineWbnbWei: bigint;
      readonly baselineNativeWei: bigint;
      readonly note: string;
    };
    readonly journalKey?: string;
    readonly expectedLevelRowVersion?: number;
    readonly expectedState?: QuantLevelState;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantLevelRow>> {
    const key = this.#levelKey(input.quantJobId, input.levelIndex);
    const level = this.#levels.get(key);
    if (level === undefined) return { kind: "conflict", record: null };
    if (level.state === "retired") return { kind: "ok", record: structuredClone(level) };
    if ((input.expectedLevelRowVersion !== undefined && level.rowVersion !== input.expectedLevelRowVersion)
      || (input.expectedState !== undefined && level.state !== input.expectedState)
      || (input.journalKey !== undefined && ![...this.#actions.values()].some((action) =>
        action.journalKey === input.journalKey && action.quantJobId === input.quantJobId
          && action.levelIndex === input.levelIndex && !TERMINAL_ACTIONS.has(action.state)))) {
      return { kind: "conflict", record: structuredClone(level) };
    }
    const currentEpoch = this.#epochs.get(input.quantJobId)?.at(-1);
    if (currentEpoch !== undefined && input.epoch.startedBlock <= currentEpoch.startedBlock) {
      return { kind: "conflict", record: structuredClone(level) };
    }
    const next: QuantLevelRow = {
      ...level,
      state: "retired",
      retiredJson: input.retiredJson,
      // Nothing is added to any baseline FROM these records (R7.3): they are
      // HISTORY, and the snapshot below is what the accounting reads.
      baseWei: 0n, baseAtCycleStartWei: 0n,
      seedPending: false,
      seedOutcome: level.seedPending ? "retired" : level.seedOutcome,
      triggerConsecutive: 0, triggerSide: null,
      rowVersion: level.rowVersion + 1,
    };
    this.#levels.set(key, next);
    await this.#openEpochUnsafe({ quantJobId: input.quantJobId, ...input.epoch, nowMs: input.nowMs });
    const job = this.#jobs.get(input.quantJobId);
    if (job !== undefined) this.#jobs.set(input.quantJobId, {
      ...job, accountingRev: job.accountingRev + 1n,
      rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
    });
    return { kind: "ok", record: structuredClone(next) };
  }

  async openEpoch(input: {
    readonly quantJobId: string;
    readonly startedBlock: bigint;
    readonly startedBlockHash: Hex | null;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly note: string;
    readonly nowMs: number;
  }): Promise<QuantEpochRow> {
    return this.withQuantFence(input.quantJobId, async () => this.#openEpochUnsafe(input));
  }

  async #openEpochUnsafe(input: {
    readonly quantJobId: string;
    readonly startedBlock: bigint;
    readonly startedBlockHash: Hex | null;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly note: string;
    readonly nowMs: number;
  }): Promise<QuantEpochRow> {
    const list = this.#epochs.get(input.quantJobId) ?? [];
    const previous = list.at(-1);
    if (previous !== undefined && input.startedBlock <= previous.startedBlock) {
      throw new Error("epoch-stale");
    }
    const row: QuantEpochRow = {
      quantJobId: input.quantJobId,
      epoch: list.length + 1,
      startedBlock: input.startedBlock,
      startedBlockHash: input.startedBlockHash,
      baselineUWei: input.baselineUWei,
      baselineWbnbWei: input.baselineWbnbWei,
      baselineNativeWei: input.baselineNativeWei,
      note: input.note,
      createdAtMs: input.nowMs,
      verified: input.startedBlockHash !== null,
    };
    list.push(row);
    this.#epochs.set(input.quantJobId, list);
    const job = this.#jobs.get(input.quantJobId);
    if (job !== undefined) this.#jobs.set(input.quantJobId, {
      ...job, accountingRev: job.accountingRev + 1n,
      rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
    });
    return structuredClone(row);
  }

  async currentEpoch(quantJobId: string): Promise<QuantEpochRow | null> {
    const list = this.#epochs.get(quantJobId) ?? [];
    const row = list[list.length - 1];
    return row === undefined ? null : structuredClone(row);
  }

  async listObservations(
    quantJobId: string, limit: number,
  ): Promise<readonly QuantObservation[]> {
    const list = this.#observations.get(quantJobId) ?? [];
    return list.slice(-limit).map((row) => structuredClone(row));
  }

  async recordIndexerTrades(
    quantJobId: string,
    trades: readonly {
      readonly txHash: Hex; readonly direction: string;
      readonly amountIn: string; readonly amountOut: string;
      readonly blockTimeMs: number | null; readonly note: string | null;
    }[],
  ): Promise<void> {
    const map = this.#indexer.get(quantJobId) ?? new Map();
    for (const trade of trades) {
      map.set(trade.txHash.toLowerCase(), {
        txHash: trade.txHash, direction: trade.direction,
        amountIn: trade.amountIn, amountOut: trade.amountOut,
        blockTimeMs: trade.blockTimeMs,
      });
    }
    this.#indexer.set(quantJobId, map);
  }

  async listIndexerTrades(quantJobId: string): Promise<readonly {
    readonly txHash: Hex; readonly direction: string;
    readonly amountIn: string; readonly amountOut: string;
    readonly blockTimeMs: number | null;
  }[]> {
    return [...(this.#indexer.get(quantJobId) ?? new Map()).values()];
  }

  async recordReport(input: {
    readonly quantJobId: string;
    readonly payloadDigest: Hex;
    readonly responseStatus: number;
    readonly notesApplied: number | null;
    readonly nowMs: number;
  }): Promise<QuantReportRow> {
    return this.withQuantFence(input.quantJobId, async () => this.#recordReportUnsafe(input));
  }

  async #recordReportUnsafe(input: {
    readonly quantJobId: string;
    readonly payloadDigest: Hex;
    readonly responseStatus: number;
    readonly notesApplied: number | null;
    readonly nowMs: number;
  }): Promise<QuantReportRow> {
    const list = this.#reports.get(input.quantJobId) ?? [];
    const row: QuantReportRow = {
      quantJobId: input.quantJobId,
      attempt: list.length + 1,
      payloadDigest: input.payloadDigest,
      responseStatus: input.responseStatus,
      notesApplied: input.notesApplied,
      createdAtMs: input.nowMs,
    };
    list.push(row);
    this.#reports.set(input.quantJobId, list);
    const job = this.#jobs.get(input.quantJobId);
    if (job !== undefined) {
      this.#jobs.set(input.quantJobId, {
        ...job, reportAttempts: list.length,
        reportedAtMs: input.nowMs, reportPayloadHash: input.payloadDigest,
        reportResponseStatus: input.responseStatus,
        rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
      });
    }
    return structuredClone(row);
  }

  async listReports(quantJobId: string): Promise<readonly QuantReportRow[]> {
    return (this.#reports.get(quantJobId) ?? []).map((row) => structuredClone(row));
  }

  async recordRun(row: QuantRunRow): Promise<void> {
    this.#runs.push(structuredClone(row));
  }

  /** The runs recorded so far. Memory backend only; the worker's tests read it. */
  runs(): readonly QuantRunRow[] {
    return this.#runs.map((row) => structuredClone(row));
  }

  async withQuantFence<T>(
    quantJobId: string,
    work: (fence: QuantFence) => Promise<T>,
  ): Promise<T> {
    // A per-job mutex — the memory twin of `pg_advisory_xact_lock`. There is no
    // transaction to abort here, which is exactly why the PostgreSQL suite is
    // the instrument that proves the fence and this one only proves the order.
    const previous = this.#locks.get(quantJobId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#locks.set(quantJobId, previous.then(() => gate));
    await previous;
    try {
      return await work(this.#fence());
    } finally {
      release();
    }
  }

  #resetLatchesUnsafe(quantJobId: string, resetLevels = true): void {
    const job = this.#jobs.get(quantJobId);
    if (job !== undefined) this.#jobs.set(quantJobId, {
      ...job, recenterConsecutive: 0, recenterSide: null,
      recenterBlockFirst: null, recenterHashFirst: null, recenterAtFirst: null,
      rowVersion: job.rowVersion + 1,
    });
    if (!resetLevels) return;
    for (const level of this.#levels.values()) {
      if (level.quantJobId !== quantJobId) continue;
      this.#levels.set(this.#levelKey(quantJobId, level.levelIndex), {
        ...level, triggerConsecutive: 0, triggerSide: null,
        triggerBlockFirst: null, triggerHashFirst: null, triggerAtFirst: null,
        rowVersion: level.rowVersion + 1,
      });
    }
  }

  #recordSeedEventUnsafe(input: QuantSeedEventRow): boolean {
    const list = this.#seedEvents.get(input.quantJobId) ?? [];
    const key = `${input.levelIndex}|${input.ladderGen}|${input.acceptedBlock}|${input.kind}`;
    if (list.some((row) => `${row.levelIndex}|${row.ladderGen}|${row.acceptedBlock}|${row.kind}` === key)) {
      return false;
    }
    list.push(structuredClone(input));
    this.#seedEvents.set(input.quantJobId, list);
    return true;
  }

  async acceptObservation(input: {
    readonly quantJobId: string;
    readonly observation: QuantObservation;
    readonly intervalMs: number;
    readonly processDigest?: Hex;
  }): Promise<QuantObservationAcceptance> {
    return this.withQuantFence(input.quantJobId, async (fence) =>
      fence.acceptObservation(input));
  }

  async resetLatches(quantJobId: string, resetLevels = true): Promise<void> {
    await this.withQuantFence(quantJobId, async (fence) =>
      fence.resetLatches(quantJobId, resetLevels));
  }

  async acknowledgeExternal(input: {
    readonly quantJobId: string;
    readonly startedBlock: bigint;
    readonly startedBlockHash: Hex;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantEpochRow>> {
    return this.withQuantFence(input.quantJobId, async (fence) => {
      const job = await fence.getJob(input.quantJobId);
      const epoch = await fence.currentEpoch(input.quantJobId);
      if (job === null || epoch === null || job.accountingState !== "external-activity"
        || input.startedBlock <= epoch.startedBlock) {
        return { kind: "conflict" as const, record: epoch };
      }
      const next = await this.#openEpochUnsafe({ ...input, note: "acknowledge-external:rebase" });
      const current = this.#jobs.get(input.quantJobId);
      if (current !== undefined) this.#jobs.set(input.quantJobId, {
        ...current, accountingState: "ok", accountingEpoch: next.epoch,
        accountingEvidenceJson: null, accountingRev: current.accountingRev + 1n,
        rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs,
      });
      return { kind: "ok" as const, record: next };
    });
  }

  async listRecenters(quantJobId: string): Promise<readonly QuantRecenterRow[]> {
    return (this.#recenters.get(quantJobId) ?? []).map((row) => structuredClone(row));
  }

  async listSeedEvents(quantJobId: string): Promise<readonly QuantSeedEventRow[]> {
    return (this.#seedEvents.get(quantJobId) ?? []).map((row) => structuredClone(row));
  }

  async verifyCurrentEpoch(input: {
    readonly quantJobId: string;
    readonly verified: boolean;
    readonly nowMs: number;
  }): Promise<boolean> {
    return this.withQuantFence(input.quantJobId, async () => {
      const epochs = this.#epochs.get(input.quantJobId) ?? [];
      const current = epochs.at(-1);
      if (current === undefined) return false;
      const next = { ...current, verified: input.verified };
      epochs[epochs.length - 1] = next;
      this.#epochs.set(input.quantJobId, epochs);
      const job = this.#jobs.get(input.quantJobId);
      if (job !== undefined) this.#jobs.set(input.quantJobId, {
        ...job, accountingRev: job.accountingRev + 1n,
        rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
      });
      return true;
    });
  }

  async verifyEpochBaseline(input: {
    readonly quantJobId: string;
    readonly epoch: number;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly nowMs: number;
  }): Promise<boolean> {
    return this.withQuantFence(input.quantJobId, async () => {
      const list = this.#epochs.get(input.quantJobId) ?? [];
      const index = list.findIndex((row) => row.epoch === input.epoch);
      const row = index < 0 ? undefined : list[index];
      const ok = row !== undefined && row.baselineUWei === input.baselineUWei
        && row.baselineWbnbWei === input.baselineWbnbWei
        && row.baselineNativeWei === input.baselineNativeWei;
      if (row !== undefined) list[index] = { ...row, verified: ok };
      this.#epochs.set(input.quantJobId, list);
      const job = this.#jobs.get(input.quantJobId);
      if (job !== undefined) this.#jobs.set(input.quantJobId, {
        ...job, accountingRev: job.accountingRev + 1n,
        rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
      });
      return ok;
    });
  }

  async setEpochHash(input: {
    readonly quantJobId: string;
    readonly epoch: number;
    readonly blockHash: Hex;
    readonly nowMs: number;
  }): Promise<boolean> {
    return this.withQuantFence(input.quantJobId, async () => {
      const list = this.#epochs.get(input.quantJobId) ?? [];
      const index = list.findIndex((row) => row.epoch === input.epoch && row.startedBlockHash === null);
      if (index < 0) return false;
      list[index] = { ...list[index]!, startedBlockHash: input.blockHash, verified: false };
      this.#epochs.set(input.quantJobId, list);
      const job = this.#jobs.get(input.quantJobId);
      if (job !== undefined) this.#jobs.set(input.quantJobId, {
        ...job, accountingRev: job.accountingRev + 1n,
        rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
      });
      return true;
    });
  }

  async listAccountingActions(quantJobId: string): Promise<readonly QuantActionRow[]> {
    return this.listActions(quantJobId);
  }

  async setAccountingState(input: {
    readonly quantJobId: string;
    readonly state: QuantAccountingState;
    readonly epoch: number | null;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<QuantJobRow | null> {
    return this.withQuantFence(input.quantJobId, async () => {
      const job = this.#jobs.get(input.quantJobId);
      if (job === undefined) return null;
      const next = {
        ...job, accountingState: input.state, accountingEpoch: input.epoch,
        accountingEvidenceJson: input.evidenceJson,
        accountingRev: job.accountingRev + 1n, rowVersion: job.rowVersion + 1,
        updatedAtMs: input.nowMs,
      };
      this.#jobs.set(input.quantJobId, next);
      return structuredClone(next);
    });
  }

  async publishAccountingVerdict(input: {
    readonly quantJobId: string;
    readonly expectedAccountingRev: bigint;
    readonly expectedEpoch: number;
    readonly expectedEpochHash?: Hex | null;
    readonly observationBlock: bigint;
    readonly observationHash?: Hex | null;
    readonly admissible: boolean;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<{ readonly ok: boolean; readonly reason?: "reconcile-stale" }> {
    return this.withQuantFence(input.quantJobId, async () => {
      const job = this.#jobs.get(input.quantJobId);
      const epoch = this.#epochs.get(input.quantJobId)?.at(-1);
      if (job === undefined || epoch === undefined || job.accountingRev !== input.expectedAccountingRev
        || epoch.epoch !== input.expectedEpoch || job.lastAcceptedBlock !== input.observationBlock
        || epoch.startedBlockHash === null || input.expectedEpochHash === undefined
        || input.expectedEpochHash === null || input.observationHash === undefined
        || input.observationHash === null
        || epoch.startedBlockHash.toLowerCase() !== input.expectedEpochHash.toLowerCase()
        || job.lastAcceptedHash?.toLowerCase() !== input.observationHash.toLowerCase()) {
        return { ok: false, reason: "reconcile-stale" as const };
      }
      this.#jobs.set(input.quantJobId, {
        ...job,
        accountingState: input.admissible ? job.accountingState : "external-activity",
        accountingEpoch: epoch.epoch,
        accountingEvidenceJson: input.admissible && job.accountingState === "ok"
          ? input.evidenceJson : job.accountingEvidenceJson,
        holdCode: input.admissible ? job.holdCode : "external-activity",
        accountingRev: job.accountingRev + 1n, rowVersion: job.rowVersion + 1,
        updatedAtMs: input.nowMs,
      });
      return { ok: true };
    });
  }

  async publishTruthVerdict(input: {
    readonly quantJobId: string;
    readonly expectedAccountingRev: bigint;
    readonly expectedEpoch: number;
    readonly expectedEpochHash?: Hex | null;
    readonly observationBlock: bigint;
    readonly observationHash?: Hex | null;
    readonly admissible: boolean;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<{ readonly ok: boolean; readonly reason?: "reconcile-stale" }> {
    return this.withQuantFence(input.quantJobId, async (fence) =>
      fence.publishTruthVerdict(input));
  }

  async #acceptObservationUnsafe(input: {
    readonly quantJobId: string;
    readonly observation: QuantObservation;
    readonly intervalMs: number;
    readonly processDigest?: Hex;
  }): Promise<QuantObservationAcceptance> {
    const job = this.#jobs.get(input.quantJobId);
    if (job === undefined) {
      throw new Error("quant job not found");
    }
    const obs = canonicalObservation(input.observation);
    const newerObserved = job.lastObservedBlock === null || obs.blockNumber > job.lastObservedBlock;
    const newerAccepted = job.lastAcceptedBlock === null || obs.blockNumber > job.lastAcceptedBlock;
    const spaced = job.lastAcceptedAtMs === null
      || obs.observedAtMs - job.lastAcceptedAtMs >= input.intervalMs;
    const stale = newerObserved ? 0 : job.staleObservations + 1;
    const list = this.#observations.get(input.quantJobId) ?? [];
    if (!list.some((row) => row.blockNumber === obs.blockNumber)) list.push(structuredClone(obs));
    while (list.length > 8) list.shift();
    this.#observations.set(input.quantJobId, list);
    let nextJob: QuantJobRow = {
      ...job,
      lastObservedBlock: newerObserved || job.lastObservedBlock === null ? obs.blockNumber : job.lastObservedBlock,
      lastObservedHash: newerObserved || job.lastObservedBlock === null ? obs.blockHash : job.lastObservedHash,
      lastObservedAtMs: newerObserved || job.lastObservedAtMs === null ? obs.observedAtMs : job.lastObservedAtMs,
      staleObservations: stale,
      rowVersion: job.rowVersion + 1,
    };
    const outage = !newerObserved && stale >= 2;
    const paramsChanged = input.processDigest !== undefined
      && job.paramsDigest?.toLowerCase() !== input.processDigest.toLowerCase();
    const live = job.status === "armed" && job.admittedAtMs !== null
      && job.wireState === "compatible" && job.accountingState === "ok"
      && !paramsChanged
      && job.revokedAtMs === null
      && (job.endsAtMs === null || job.endsAtMs > obs.observedAtMs);
    const refusalReason = job.status === "paused" ? "paused"
      : job.wireState === "changed" ? "wire-changed"
        : job.accountingState === "external-activity" ? "external-activity"
          : paramsChanged ? "params-changed"
            : job.revokedAtMs !== null ? "revoked"
              : job.status === "ended" || job.status === "ended-unresolved" || job.status === "reported"
                || (job.endsAtMs !== null && job.endsAtMs <= obs.observedAtMs) ? "ended"
                : undefined;
    const accepted = newerObserved && newerAccepted && spaced && live;
    if (outage || !accepted) {
      if (outage) {
        this.#resetLatchesUnsafe(input.quantJobId);
        nextJob = {
          ...nextJob, recenterConsecutive: 0, recenterSide: null,
          recenterBlockFirst: null, recenterHashFirst: null, recenterAtFirst: null,
        };
      }
      this.#jobs.set(input.quantJobId, nextJob);
      return {
        accepted: false,
        [QUANT_ACCEPTED_SNAPSHOT]: true,
        reason: outage ? "stale-outage" : !live && refusalReason !== undefined
          ? refusalReason : !newerObserved ? "not-newer" : "spacing",
        observation: structuredClone(obs), job: structuredClone(nextJob),
        levels: await this.listLevels(input.quantJobId),
      };
    }
    nextJob = {
      ...nextJob,
      lastAcceptedBlock: obs.blockNumber,
      lastAcceptedHash: obs.blockHash,
      lastAcceptedAtMs: obs.observedAtMs,
      staleObservations: 0,
    };
    const lower = Math.max(1, job.levels - 1);
    const top = (await this.listLevels(input.quantJobId)).find((row) => row.levelIndex === job.levels);
    const bottom = (await this.listLevels(input.quantJobId)).find((row) => row.levelIndex === lower);
    const jobSide: QuantRecenterSide | null = job.ladderGen > 0 || job.levels > 0
      ? top !== undefined && bottom !== undefined
        ? obs.midE18 > top.sellPriceE18 ? "up"
          : obs.midE18 < bottom.buyPriceE18 ? "down" : null
        : null
      : null;
    let nextConsecutive = nextJob.recenterConsecutive;
    let nextSide = nextJob.recenterSide;
    let nextBlockFirst = nextJob.recenterBlockFirst;
    let nextHashFirst = nextJob.recenterHashFirst;
    let nextAtFirst = nextJob.recenterAtFirst;
    if (jobSide === null || jobSide !== nextSide) {
      nextConsecutive = jobSide === null ? 0 : 1;
      nextSide = jobSide;
      nextBlockFirst = jobSide === null ? null : obs.blockNumber;
      nextHashFirst = jobSide === null ? null : obs.blockHash;
      nextAtFirst = jobSide === null ? null : obs.observedAtMs;
    } else {
      nextConsecutive += 1;
    }
    nextJob = {
      ...nextJob, recenterConsecutive: nextConsecutive, recenterSide: nextSide,
      recenterBlockFirst: nextBlockFirst, recenterHashFirst: nextHashFirst,
      recenterAtFirst: nextAtFirst, rowVersion: nextJob.rowVersion + 1,
    };
    this.#jobs.set(input.quantJobId, nextJob);
    for (const level of await this.listLevels(input.quantJobId)) {
      if (level.state === "blocked" || level.state === "retired" || level.seedPending) continue;
      const side = level.state === "holding-base"
        ? obs.midE18 > level.sellPriceE18 ? "sell" : null
        : obs.midE18 < level.buyPriceE18 ? "buy" : null;
      const same = side !== null && level.triggerSide === side;
      const consecutive = side === null ? 0 : same ? level.triggerConsecutive + 1 : 1;
      const first = side === null ? null : same && level.triggerBlockFirst !== null
        ? level.triggerBlockFirst : obs.blockNumber;
      const firstHash = side === null ? null : same && level.triggerHashFirst !== null
        ? level.triggerHashFirst : obs.blockHash;
      const firstAt = side === null ? null : same && level.triggerAtFirst !== null
        ? level.triggerAtFirst : obs.observedAtMs;
      this.#levels.set(this.#levelKey(input.quantJobId, level.levelIndex), {
        ...level, triggerConsecutive: consecutive, triggerSide: side,
        triggerBlockFirst: first, triggerHashFirst: firstHash, triggerAtFirst: firstAt,
        holdCode: null, holdCount: 0, rowVersion: level.rowVersion + 1,
      });
    }
    return {
      accepted: true, [QUANT_ACCEPTED_SNAPSHOT]: true,
      observation: structuredClone(obs), job: structuredClone(nextJob),
      levels: await this.listLevels(input.quantJobId),
    };
  }

  async #recenterLadderUnsafe(input: RecenterLadderInput): Promise<QuantCasResult<QuantJobRow>> {
    const job = this.#jobs.get(input.quantJobId);
    const levels = await this.listLevels(input.quantJobId);
    const actions = await this.listNonTerminalActions(input.quantJobId);
    if (job === undefined) return { kind: "conflict", record: null };
    const nowSec = Math.floor(input.nowMs / 1_000);
    const cooldownFrom = job.lastRecenterAtMs ?? job.admittedAtMs ?? input.nowMs;
    const valid = job.status === "armed"
      && job.ladderGen === input.expectedGeneration
      && job.lastAcceptedBlock === input.observationBlock
      && job.lastAcceptedHash?.toLowerCase() === input.observationHash.toLowerCase()
      && job.lastAcceptedAtMs === input.observationAtMs
      && job.recenterConsecutive >= 2 && job.recenterSide === input.side
      && job.recenters < job.recenterBudget
      && input.nowMs - cooldownFrom >= (input.cooldownSec ?? 86_400) * 1_000
      && (job.endsAtMs === null || job.endsAtMs > input.nowMs)
      && (job.sessionExpiresAtMs === null || job.sessionExpiresAtMs > input.nowMs)
      && job.sessionExpiry !== null && job.sessionExpiry > nowSec
      && job.revokedAtMs === null
      && job.wireState === "compatible" && job.accountingState === "ok"
      && (input.expectedWallet === undefined
        || job.tradingWallet.toLowerCase() === input.expectedWallet.toLowerCase())
      && (input.expectedProcessDigest === undefined
        || job.paramsDigest?.toLowerCase() === input.expectedProcessDigest.toLowerCase())
      && levels.length === job.levels
      && levels.every((level) => level.levelIndex >= 1 && level.levelIndex <= job.levels)
      && new Set(levels.map((level) => level.levelIndex)).size === job.levels
      && levels.every((level) => level.state !== "blocked" && level.state !== "retired" && !level.seedPending)
      && actions.length === 0
      && input.newBuyPrice.length === job.levels + 1
      && input.newSellPrice.length === job.levels + 1
      && input.newAnchorE18 > 0n
      && input.newBuyPrice[0] === input.newAnchorE18
      && input.newBuyPrice.every((price, index) => index <= job.levels && price > 0n)
      && input.newSellPrice[0] === 0n
      && input.newSellPrice.every((price, index) => index === 0 || (index <= job.levels && price > (input.newBuyPrice[index] ?? 0n)))
      && (!input.reseed || input.side === "up");
    if (!valid) return { kind: "conflict", record: structuredClone(job) };
    const oldLines = JSON.stringify(levels.map((level) => ({
      index: level.levelIndex, buy: level.buyPriceE18.toString(10), sell: level.sellPriceE18.toString(10),
    })));
    const upper = levels.find((level) => level.levelIndex === job.levels);
    if (upper === undefined) return { kind: "conflict", record: structuredClone(job) };
    const upperPrior = JSON.stringify({
      v: 1, state: upper.state, seedPending: upper.seedPending,
      seedRefusals: upper.seedRefusals, seedSubmissions: upper.seedSubmissions,
      seedOutcome: upper.seedOutcome, seedNote: upper.seedNote,
      seedLastCause: upper.seedLastCause,
    });
    const newGen = job.ladderGen + 1;
    for (const level of levels) {
      const buy = input.newBuyPrice[level.levelIndex] ?? 0n;
      const sell = input.newSellPrice[level.levelIndex] ?? 0n;
      this.#levels.set(this.#levelKey(input.quantJobId, level.levelIndex), {
        ...level, buyPriceE18: buy, sellPriceE18: sell, ladderGen: newGen,
        triggerConsecutive: 0, triggerSide: null, triggerBlockFirst: null,
        triggerHashFirst: null, triggerAtFirst: null, holdCode: null, holdCount: 0,
        seedPending: input.reseed && input.side === "up" && level.levelIndex === job.levels
          && level.state === "armed-quote",
        seedRefusals: input.reseed && input.side === "up" && level.levelIndex === job.levels
          && level.state === "armed-quote" ? 0 : level.seedRefusals,
        seedSubmissions: input.reseed && input.side === "up" && level.levelIndex === job.levels
          && level.state === "armed-quote" ? 0 : level.seedSubmissions,
        seedLastCause: input.reseed && input.side === "up" && level.levelIndex === job.levels
          && level.state === "armed-quote" ? null : level.seedLastCause,
        seedOutcome: input.reseed && input.side === "up" && level.levelIndex === job.levels
          && level.state === "armed-quote" ? null : level.seedOutcome,
        seedNote: input.reseed && input.side === "up" && level.levelIndex === job.levels
          && level.state === "armed-quote" ? null : level.seedNote,
        rowVersion: level.rowVersion + 1,
      });
    }
    const next: QuantJobRow = {
      ...job, anchorE18: input.newAnchorE18, ladderGen: newGen,
      recenters: job.recenters + 1, lastRecenterAtMs: input.nowMs,
      recenterConsecutive: 0, recenterSide: null,
      recenterBlockFirst: null, recenterHashFirst: null, recenterAtFirst: null,
      holdCode: null, holdCount: 0, accountingRev: job.accountingRev + 1n,
      rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
    };
    this.#jobs.set(input.quantJobId, next);
    const history = this.#recenters.get(input.quantJobId) ?? [];
    history.push({
      quantJobId: input.quantJobId, seq: history.length + 1, atMs: input.nowMs,
      blockNumber: input.observationBlock, blockHash: input.observationHash,
      direction: input.side, fromGen: job.ladderGen, toGen: newGen,
      oldAnchorE18: job.anchorE18, newAnchorE18: input.newAnchorE18,
      oldLinesJson: oldLines,
      newLinesJson: JSON.stringify({ buy: input.newBuyPrice.map((v) => v.toString(10)), sell: input.newSellPrice.map((v) => v.toString(10)) }),
      upperPriorJson: upperPrior,
      reseedScheduled: input.reseed && input.side === "up" && upper.state === "armed-quote",
      cause: input.cause, evidenceBlock1: job.recenterBlockFirst ?? input.observationBlock,
      evidenceBlock2: input.observationBlock, evidenceHash1: job.recenterHashFirst,
      evidenceHash2: input.observationHash, evidenceAt1: job.recenterAtFirst,
      evidenceAt2: input.observationAtMs,
    });
    this.#recenters.set(input.quantJobId, history);
    return { kind: "ok", record: structuredClone(next) };
  }

  #fence(): QuantFence {
    return {
      getJob: (jobId) => this.getJob(jobId),
      listLevels: (jobId) => this.listLevels(jobId),
      listNonTerminalActions: (jobId) => this.listNonTerminalActions(jobId),
      currentEpoch: (jobId) => this.currentEpoch(jobId),
      listRecentBuys: async (jobId, sinceMs) =>
        (await this.listActions(jobId)).filter(
          (row) => row.side === "buy" && row.createdAtMs >= sinceMs,
        ),
      insertIntent: async (input) => this.#insertIntent(input),
      convertSeed: async (input) => {
        const key = this.#levelKey(input.quantJobId, input.levelIndex);
        const level = this.#levels.get(key);
        const job = this.#jobs.get(input.quantJobId);
        if (job === undefined || job.status !== "armed" || job.wireState !== "compatible"
          || job.accountingState !== "ok" || level === undefined || level.state !== "armed-quote" || !level.seedPending
          || (input.ladderGen !== undefined && level.ladderGen !== input.ladderGen)
          || (input.expectedProcessDigest !== undefined
            && job.paramsDigest?.toLowerCase() !== input.expectedProcessDigest.toLowerCase())
          || level.seedRefusals + level.seedSubmissions < input.seedWindowCycles
          || (await this.listNonTerminalActions(input.quantJobId)).some(
            (action) => action.levelIndex === input.levelIndex,
          )) return { kind: "conflict" as const, record: level === undefined ? null : structuredClone(level) };
        const next: QuantLevelRow = {
          ...level, seedPending: false, seedOutcome: "converted",
          seedNote: level.seedLastCause, holdCode: "seed-window-expired",
          triggerConsecutive: 0, triggerSide: null,
          triggerBlockFirst: null, triggerHashFirst: null, triggerAtFirst: null,
          rowVersion: level.rowVersion + 1,
        };
        this.#levels.set(key, next);
        return { kind: "ok" as const, record: structuredClone(next) };
      },
      recordLevelOutcome: async (input) => {
        const key = this.#levelKey(input.quantJobId, input.levelIndex);
        const level = this.#levels.get(key);
        const job = this.#jobs.get(input.quantJobId);
        if (level === undefined || job === undefined || job.status !== "armed"
          || job.admittedAtMs === null || job.wireState !== "compatible" || job.accountingState !== "ok"
          || level.state === "blocked"
          || level.state === "retired" || (input.ladderGen !== undefined && level.ladderGen !== input.ladderGen)
          || (input.acceptedBlock !== undefined && job.lastAcceptedBlock !== input.acceptedBlock)
          || (input.acceptedHash !== undefined && input.acceptedHash !== null
            && job.lastAcceptedHash?.toLowerCase() !== input.acceptedHash.toLowerCase())
          || (input.acceptedAtMs !== undefined && job.lastAcceptedAtMs !== input.acceptedAtMs)
          || (input.expectedProcessDigest !== undefined
            && job.paramsDigest?.toLowerCase() !== input.expectedProcessDigest.toLowerCase())) {
          return { kind: "conflict" as const, record: level === undefined ? null : structuredClone(level) };
        }
        let next = {
          ...level,
          holdCode: input.holdCode,
          holdCount: input.holdCode === null ? 0 : level.holdCount + 1,
          rowVersion: level.rowVersion + 1,
        };
        if (input.seedCounted && level.seedPending && input.acceptedBlock !== null
          && input.acceptedBlock !== undefined) {
          const event = this.#recordSeedEventUnsafe({
            quantJobId: input.quantJobId, levelIndex: input.levelIndex,
            ladderGen: level.ladderGen, acceptedBlock: input.acceptedBlock,
            kind: "refusal", cause: input.cause ?? input.holdCode ?? "refusal",
            journalKey: null, atMs: input.nowMs,
          });
          if (event) next = {
            ...next,
            seedRefusals: level.seedRefusals + 1,
            seedLastCause: input.cause ?? input.holdCode ?? "refusal",
          };
        }
        this.#levels.set(key, next);
        return { kind: "ok" as const, record: structuredClone(next) };
      },
      acceptObservation: async (input) => this.#acceptObservationUnsafe(input),
      resetLatches: async (jobId, resetLevels = true) =>
        this.#resetLatchesUnsafe(jobId, resetLevels),
      recenterLadder: async (input) => this.#recenterLadderUnsafe(input),
      setAccountingState: async (input) => {
        const job = this.#jobs.get(input.quantJobId);
        if (job === undefined) return null;
        const next = {
          ...job, accountingState: input.state, accountingEpoch: input.epoch,
          accountingEvidenceJson: input.evidenceJson, accountingRev: job.accountingRev + 1n,
          rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
        };
        this.#jobs.set(input.quantJobId, next);
        return structuredClone(next);
      },
      publishAccountingVerdict: async (input) => {
        const job = this.#jobs.get(input.quantJobId);
        const epoch = this.#epochs.get(input.quantJobId)?.at(-1);
        if (job === undefined || epoch === undefined || job.accountingRev !== input.expectedAccountingRev
          || epoch.epoch !== input.expectedEpoch || job.lastAcceptedBlock !== input.observationBlock
          || epoch.startedBlockHash === null || input.expectedEpochHash === undefined
          || input.expectedEpochHash === null || input.observationHash === undefined
          || input.observationHash === null
          || epoch.startedBlockHash.toLowerCase() !== input.expectedEpochHash.toLowerCase()
          || job.lastAcceptedHash?.toLowerCase() !== input.observationHash.toLowerCase()) {
          return { ok: false, reason: "reconcile-stale" as const };
        }
        this.#jobs.set(input.quantJobId, {
          ...job,
          accountingState: input.admissible ? job.accountingState : "external-activity",
          accountingEpoch: epoch.epoch,
          accountingEvidenceJson: input.admissible && job.accountingState === "ok"
            ? input.evidenceJson : job.accountingEvidenceJson,
          holdCode: input.admissible ? job.holdCode : "external-activity",
          accountingRev: job.accountingRev + 1n, rowVersion: job.rowVersion + 1,
          updatedAtMs: input.nowMs,
        });
        return { ok: true };
      },
      publishTruthVerdict: async (input) => {
        const job = this.#jobs.get(input.quantJobId);
        const epoch = this.#epochs.get(input.quantJobId)?.at(-1);
        if (job === undefined || epoch === undefined || job.accountingRev !== input.expectedAccountingRev
          || job.accountingEpoch !== input.expectedEpoch || epoch.epoch !== input.expectedEpoch
          || epoch.startedBlockHash === null || input.expectedEpochHash === undefined
          || input.expectedEpochHash === null
          || epoch.startedBlockHash.toLowerCase() !== input.expectedEpochHash.toLowerCase()) {
          return { ok: false, reason: "reconcile-stale" as const };
        }
        this.#jobs.set(input.quantJobId, {
          ...job,
          accountingState: input.admissible ? job.accountingState : "external-activity",
          accountingEpoch: epoch.epoch,
          accountingEvidenceJson: input.admissible && job.accountingState === "ok"
            ? input.evidenceJson : job.accountingEvidenceJson,
          holdCode: input.admissible ? job.holdCode : "external-activity",
          accountingRev: job.accountingRev + 1n, rowVersion: job.rowVersion + 1,
          updatedAtMs: input.nowMs,
        });
        return { ok: true };
      },
      setLevelTrigger: async (input) => {
        const key = this.#levelKey(input.quantJobId, input.levelIndex);
        const level = this.#levels.get(key);
        if (level === undefined) return;
        this.#levels.set(key, {
          ...level,
          triggerConsecutive: input.consecutive,
          triggerSide: input.side,
          triggerBlockFirst: input.side === null ? null : level.triggerBlockFirst,
          rowVersion: level.rowVersion + 1,
        });
      },
      setLevelHold: async (input) => {
        const key = this.#levelKey(input.quantJobId, input.levelIndex);
        const level = this.#levels.get(key);
        if (level === undefined) return;
        this.#levels.set(key, {
          ...level,
          holdCode: input.holdCode,
          holdCount: input.holdCode === null ? 0 : level.holdCount + 1,
          rowVersion: level.rowVersion + 1,
        });
      },
      setJobHold: async (input) => {
        const job = this.#jobs.get(input.quantJobId);
        if (job === undefined) return;
        this.#jobs.set(input.quantJobId, {
          ...job,
          holdCode: input.holdCode,
          holdCount: input.holdCode === null ? 0 : job.holdCount + 1,
          rowVersion: job.rowVersion + 1,
        });
      },
      recordObservation: async (input) => {
        const observation = canonicalObservation(input.observation);
        const list = this.#observations.get(input.quantJobId) ?? [];
        list.push(structuredClone(observation));
        while (list.length > 8) list.shift();
        this.#observations.set(input.quantJobId, list);
        const job = this.#jobs.get(input.quantJobId);
        if (job !== undefined) {
          this.#jobs.set(input.quantJobId, {
            ...job,
            lastObservedBlock: observation.blockNumber,
            lastObservedHash: observation.blockHash,
            lastObservedAtMs: observation.observedAtMs,
            staleObservations: 0,
            rowVersion: job.rowVersion + 1,
          });
        }
      },
      markStaleObservation: async (jobId, stale) => {
        const job = this.#jobs.get(jobId);
        if (job === undefined) return;
        this.#jobs.set(jobId, {
          ...job, staleObservations: stale, rowVersion: job.rowVersion + 1,
        });
      },
    };
  }

  async #insertIntent(
    input: InsertQuantIntentInput,
  ): Promise<QuantCasResult<QuantActionRow>> {
    if (this.#actions.has(input.journalKey)) {
      return { kind: "conflict", record: structuredClone(this.#actions.get(input.journalKey)!) };
    }
    const key = this.#levelKey(input.quantJobId, input.levelIndex);
    const level = this.#levels.get(key);
    const job = this.#jobs.get(input.quantJobId);
    const evidence = input.evidence ?? {
      kind: "crossing" as const, first: input.triggerBlock1, second: input.triggerBlock2,
    };
    const evidenceKind = input.evidence?.kind ?? null;
    const crossingFirst = evidence.kind === "crossing" ? evidence.first : input.triggerBlock1;
    if (job !== undefined && input.side === "buy") {
      let reserved = 0n;
      for (const action of this.#actions.values()) {
        if (action.quantJobId !== input.quantJobId || action.side !== "buy") continue;
        if (!TERMINAL_ACTIONS.has(action.state)) {
          if (input.nowMs <= action.deadlineSec * 1_000 + 86_400_000) reserved += action.amountInWei;
        } else if (action.state === "settled" && action.fillInWei !== null) {
          const at = action.executedAtSec === null ? action.updatedAtMs : Number(action.executedAtSec) * 1_000;
          if (input.nowMs - at < 86_400_000) reserved += action.fillInWei;
        }
      }
      if (reserved + input.amountInWei > job.dailyCapUWei) {
        return { kind: "conflict", record: null };
      }
    }
    if (job !== undefined && input.requiredNativeWei !== undefined
      && input.preNativeWei < input.requiredNativeWei) {
      return { kind: "conflict", record: null };
    }
    if (input.preNativeBlock !== undefined && input.preNativeBlock !== null
      && input.maxQuoteLagBlocks !== undefined
      && input.quoteBlock >= input.preNativeBlock
      && input.quoteBlock - input.preNativeBlock > BigInt(input.maxQuoteLagBlocks)) {
      return { kind: "conflict", record: null };
    }
    if (level === undefined || job === undefined || level.rowVersion !== input.expectedLevelRowVersion
      || level.state === "retired" || level.state === "blocked"
      || level.state !== input.priorLevelState
      || (input.ladderGen !== undefined && level.ladderGen !== input.ladderGen)
      || level.actionSeq + 1 !== input.actionSeq
      || (input.planObservationBlock !== undefined && job.lastAcceptedBlock !== input.planObservationBlock)
      || (input.planObservationHash !== undefined && job.lastAcceptedHash?.toLowerCase() !== input.planObservationHash.toLowerCase())
      || (input.planObservationAtMs !== undefined && job.lastAcceptedAtMs !== input.planObservationAtMs)
      || (input.plannedAccountingRev !== undefined && job.accountingRev !== input.plannedAccountingRev)
      || (input.plannedAccountingEpoch !== undefined && job.accountingEpoch !== input.plannedAccountingEpoch)
      || (input.plannedWallet !== undefined && job.tradingWallet.toLowerCase() !== input.plannedWallet.toLowerCase())
      || (input.plannedProcessDigest !== undefined && job.paramsDigest?.toLowerCase() !== input.plannedProcessDigest.toLowerCase())
      || (input.plannedBuyPriceE18 !== undefined && level.buyPriceE18 !== input.plannedBuyPriceE18)
      || (input.plannedSellPriceE18 !== undefined && level.sellPriceE18 !== input.plannedSellPriceE18)
      || (input.planTriggerFirst !== undefined && level.triggerBlockFirst !== input.planTriggerFirst)
      || (evidenceKind === "seed" && (!level.seedPending
        || level.seedRefusals + level.seedSubmissions >= (input.seedWindowCycles ?? 9)))
      || (evidenceKind === "crossing" && (level.triggerConsecutive < 2
        || level.triggerSide !== input.side || level.triggerBlockFirst !== crossingFirst))
      || (job.status !== "armed" || job.wireState !== "compatible" || job.accountingState !== "ok")) {
      return { kind: "conflict", record: null };
    }
    if (isR14ParamsJson(job.paramsJson) && !hasR14FeeEvidence(input)) {
      return { kind: "conflict", record: null };
    }
    const row: QuantActionRow = {
      journalKey: input.journalKey,
      quantJobId: input.quantJobId,
      levelIndex: input.levelIndex,
      actionSeq: input.actionSeq,
      side: input.side,
      state: "intended",
      priorLevelState: input.priorLevelState,
      amountInWei: input.amountInWei,
      minOutWei: input.minOutWei,
      quoteOutWei: input.quoteOutWei,
      quoteBlock: input.quoteBlock,
      triggerBlock1: evidence.kind === "seed" ? evidence.accepted : evidence.first,
      triggerBlock2: evidence.kind === "seed" ? evidence.accepted : evidence.second,
      deadlineSec: input.deadlineSec,
      callsJson: input.callsJson,
      note: input.note,
      impactBps: input.impactBps,
      preUWei: input.preUWei,
      preWbnbWei: input.preWbnbWei,
      preNativeWei: input.preNativeWei,
      preNativeBlock: input.preNativeBlock ?? null,
      basisUWei: input.basisUWei,
      baseAtCycleStartWei: input.baseAtCycleStartWei,
      ladderGen: input.ladderGen ?? level.ladderGen,
      evidenceKind: evidence.kind,
      executedBlock: null, executedAtSec: null,
      requiredNativeWei: input.requiredNativeWei ?? null,
      gasPriceWei: input.gasPriceWei ?? null,
      feeEstWei: input.feeEstWei ?? null,
      submitFinalizedNumber: null, submitFinalizedHash: null,
      txHash: null, fillInWei: null, fillOutWei: null, feeDeltaWei: null,
      resolutionJson: null, failureCode: null,
      createdAtMs: input.nowMs, updatedAtMs: input.nowMs, rowVersion: 1,
    };
    this.#actions.set(row.journalKey, row);
    this.#levels.set(key, {
      ...level,
      state: "blocked",
      priorState: input.priorLevelState,
      actionSeq: input.actionSeq,
      lastActionAtMs: input.nowMs,
      holdCode: null, holdCount: 0,
      triggerConsecutive: 0,
      triggerSide: null,
      rowVersion: level.rowVersion + 1,
    });
    if (job !== undefined) this.#jobs.set(job.quantJobId, {
      ...job, accountingRev: job.accountingRev + 1n,
      rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs,
    });
    return { kind: "ok", record: structuredClone(row) };
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}

/* -------------------------------------------------------------------------- */
/* PostgreSQL DDL                                                             */
/* -------------------------------------------------------------------------- */

const QUANT_JOBS_DDL = `
  create table if not exists quant_jobs (
    quant_job_id text primary key,
    strategy_id text not null default '',
    trading_wallet text not null default '',
    allocation_u_wei numeric not null default 0,
    daily_cap_u_wei numeric not null default 0,
    term_days int not null default 0,
    started_at_ms bigint null,
    ends_at_ms bigint null,
    session_expires_at_ms bigint null,
    revoked_at_ms bigint null,
    status text not null check (status in
      ('discovered','armed','held','paused','ended','ended-unresolved','reported')),
    envelope_json text null,
    envelope_id text null,
    session_public_key text null,
    session_expiry bigint null,
    permissions_digest text null,
    projection_digest text null,
    admitted_at_ms bigint null,
    chain_checked_at_ms bigint null,
    wbnb_cap_min_limit_wei numeric not null default 0,
    residual_threshold_wei numeric not null default 0,
    params_json text null,
    params_digest text null,
    p0_e18 numeric not null default 0,
    arm_block numeric null,
    levels int not null default 0,
    clip_u_wei numeric not null default 0,
    idle_u_wei numeric not null default 0,
    last_observed_block numeric null,
    last_observed_hash text null,
    stale_observations int not null default 0,
    hold_code text null,
    hold_count int not null default 0,
    last_job_read_at_ms bigint null,
    reported_at_ms bigint null,
    report_attempts int not null default 0,
    row_version int not null default 1,
    created_at_ms bigint not null,
    updated_at_ms bigint not null,
    anchor_e18 numeric not null default 0,
    ladder_gen int not null default 0,
    recenters int not null default 0,
    recenter_budget int not null default 0,
    last_recenter_at_ms bigint null,
    recenter_consecutive int not null default 0,
    recenter_side text null check (recenter_side in ('up','down')),
    recenter_block_first numeric null,
    recenter_hash_first text null,
    recenter_at_first bigint null,
    last_observed_at_ms bigint null,
    last_accepted_block numeric null,
    last_accepted_hash text null,
    last_accepted_at_ms bigint null,
    cap_rows_json text null,
    wire_state text not null default 'compatible' check (wire_state in ('compatible','changed')),
    accounting_state text not null default 'ok' check (accounting_state in ('ok','external-activity')),
    accounting_epoch int null,
    accounting_evidence_json text null,
    accounting_rev bigint not null default 0,
    report_payload_hash text null,
    report_response_status int null
  )
`;

const QUANT_LEVELS_DDL = `
  create table if not exists quant_levels (
    quant_job_id text not null,
    level_index int not null,
    state text not null check (state in ('armed-quote','holding-base','blocked','retired')),
    buy_price_e18 numeric not null,
    sell_price_e18 numeric not null,
    base_wei numeric not null default 0,
    base_at_cycle_start_wei numeric not null default 0,
    basis_u_wei numeric not null default 0,
    entry_cost_u_wei numeric not null default 0,
    action_seq int not null default 0,
    cycles_closed int not null default 0,
    realized_u_wei numeric not null default 0,
    residual_wei numeric not null default 0,
    prior_state text null,
    trigger_consecutive int not null default 0,
    trigger_side text null,
    last_action_at_ms bigint null,
    hold_code text null,
    hold_count int not null default 0,
    exit_plan_json text null,
    retired_json text null,
    row_version int not null default 1,
    ladder_gen int not null default 0,
    seed_pending boolean not null default false,
    seed_refusals int not null default 0,
    seed_submissions int not null default 0,
    seed_last_cause text null,
    seed_outcome text null check (seed_outcome in ('seeded','converted','retired')),
    seed_note text null,
    trigger_block_first numeric null,
    trigger_hash_first text null,
    trigger_at_first bigint null,
    primary key (quant_job_id, level_index)
  )
`;

const QUANT_ACTIONS_DDL = `
  create table if not exists quant_actions (
    journal_key text primary key,
    quant_job_id text not null,
    level_index int not null,
    action_seq int not null,
    side text not null check (side in ('buy','sell')),
    state text not null check (state in
      ('intended','submitted','committed-unverified','unknown','needs-operator',
       'settled','failed','aborted')),
    prior_level_state text not null,
    amount_in_wei numeric not null,
    min_out_wei numeric not null,
    quote_out_wei numeric not null,
    quote_block numeric not null,
    trigger_block_1 numeric not null,
    trigger_block_2 numeric not null,
    deadline_sec bigint not null,
    calls_json text not null,
    note text not null,
    impact_bps int not null default 0,
    pre_u_wei numeric not null default 0,
    pre_wbnb_wei numeric not null default 0,
    pre_native_wei numeric not null default 0,
    pre_native_block numeric null,
    basis_u_wei numeric not null default 0,
    base_at_cycle_start_wei numeric not null default 0,
    submit_finalized_number numeric null,
    submit_finalized_hash text null,
    tx_hash text null,
    fill_in_wei numeric null,
    fill_out_wei numeric null,
    fee_delta_wei numeric null,
    resolution_json text null,
    failure_code text null,
    ladder_gen int not null default 0,
    evidence_kind text not null default 'crossing' check (evidence_kind in ('crossing','seed')),
    executed_block numeric null,
    executed_at_sec bigint null,
    required_native_wei numeric null,
    gas_price_wei numeric null,
    fee_est_wei numeric null,
    created_at_ms bigint not null,
    updated_at_ms bigint not null,
    row_version int not null default 1
  )
`;

const QUANT_ACTIONS_INDEX_DDL = `
  create index if not exists quant_actions_job_idx
    on quant_actions (quant_job_id, created_at_ms)
`;

/**
 * Receipt ownership is per INTENT and per SWAP LOG, not per transaction (R5.3).
 *
 * A batched relay transaction can carry two wallets' intents, and each wallet's
 * action must settle independently; a second action of the SAME wallet must not
 * be able to claim the same swap. `(tx_hash, trading_wallet, swap_log_index)`
 * is the key that expresses both at once.
 */
const QUANT_RECEIPT_OWNERSHIP_DDL = `
  create table if not exists quant_receipt_ownership (
    tx_hash text not null,
    trading_wallet text not null,
    swap_log_index numeric not null,
    journal_key text not null,
    created_at_ms bigint not null,
    primary key (tx_hash, trading_wallet, swap_log_index)
  )
`;

const QUANT_EPOCHS_DDL = `
  create table if not exists quant_epochs (
    quant_job_id text not null,
    epoch int not null,
    started_block numeric not null,
    started_block_hash text null,
    baseline_u_wei numeric not null default 0,
    baseline_wbnb_wei numeric not null default 0,
    baseline_native_wei numeric not null default 0,
    note text not null default '',
    created_at_ms bigint not null,
    verified boolean not null default false,
    primary key (quant_job_id, epoch)
  )
`;

const QUANT_RECENTERS_DDL = `
  create table if not exists quant_recenters (
    quant_job_id text not null,
    seq int not null,
    at_ms bigint not null,
    block_number numeric not null,
    block_hash text not null,
    direction text not null check (direction in ('up','down')),
    from_gen int not null,
    to_gen int not null,
    old_anchor_e18 numeric not null,
    new_anchor_e18 numeric not null,
    old_lines_json text not null,
    new_lines_json text not null,
    upper_prior_json text not null,
    reseed_scheduled boolean not null,
    cause text not null,
    evidence_block_1 numeric not null,
    evidence_block_2 numeric not null,
    evidence_hash_1 text null,
    evidence_hash_2 text null,
    evidence_at_1 bigint null,
    evidence_at_2 bigint null,
    primary key (quant_job_id, seq)
  )
`;

const QUANT_SEED_EVENTS_DDL = `
  create table if not exists quant_seed_events (
    quant_job_id text not null,
    level_index int not null,
    ladder_gen int not null,
    accepted_block numeric not null,
    kind text not null check (kind in ('refusal','claim')),
    cause text not null,
    journal_key text null,
    at_ms bigint not null,
    primary key (quant_job_id, level_index, ladder_gen, accepted_block, kind)
  )
`;

const QUANT_OBSERVATIONS_DDL = `
  create table if not exists quant_observations (
    quant_job_id text not null,
    block_number numeric not null,
    block_hash text not null,
    observed_at_ms bigint not null,
    mid_e18 numeric not null,
    primary key (quant_job_id, block_number)
  )
`;

const QUANT_INDEXER_TRADES_DDL = `
  create table if not exists quant_indexer_trades (
    quant_job_id text not null,
    tx_hash text not null,
    direction text not null,
    amount_in text not null,
    amount_out text not null,
    block_time_ms bigint null,
    note text null,
    created_at_ms bigint not null,
    primary key (quant_job_id, tx_hash)
  )
`;

const QUANT_REPORTS_DDL = `
  create table if not exists quant_reports (
    quant_job_id text not null,
    attempt int not null,
    payload_digest text not null,
    response_status int not null,
    notes_applied int null,
    created_at_ms bigint not null,
    primary key (quant_job_id, attempt)
  )
`;

const QUANT_RUNS_DDL = `
  create table if not exists quant_runs (
    run_id text primary key,
    started_at_ms bigint not null,
    finished_at_ms bigint not null,
    jobs_seen int not null,
    actions int not null,
    holds int not null,
    errors int not null,
    dry_run boolean not null
  )
`;

const QUANT_SCHEMA_MIGRATIONS_DDL = `
  create table if not exists quant_quant_migrations (
    version text primary key,
    applied_at_ms bigint not null
  )
`;

/**
 * Additive migrations for a table that already exists.
 *
 * `create table if not exists` does NOT add a column to a table that is already
 * there, which is how a schema change becomes an unreadable column on a live
 * deployment (lending FIXREVIEW F5/F7). Every entry is nullable or defaulted,
 * so an existing row is valid the moment it lands.
 */
const QUANT_MIGRATIONS: readonly string[] = [
  `alter table quant_jobs add column if not exists stale_observations int not null default 0`,
  `alter table quant_jobs add column if not exists residual_threshold_wei numeric not null default 0`,
  `alter table quant_levels add column if not exists exit_plan_json text`,
  `alter table quant_levels add column if not exists retired_json text`,
  `alter table quant_actions add column if not exists fee_delta_wei numeric`,
  `alter table quant_actions add column if not exists resolution_json text`,
  `alter table quant_jobs add column if not exists anchor_e18 numeric not null default 0`,
  `alter table quant_jobs add column if not exists ladder_gen int not null default 0`,
  `alter table quant_jobs add column if not exists recenters int not null default 0`,
  `alter table quant_jobs add column if not exists recenter_budget int not null default 0`,
  `alter table quant_jobs add column if not exists last_recenter_at_ms bigint`,
  `alter table quant_jobs add column if not exists recenter_consecutive int not null default 0`,
  `alter table quant_jobs add column if not exists recenter_side text`,
  `alter table quant_jobs add column if not exists recenter_block_first numeric`,
  `alter table quant_jobs add column if not exists recenter_hash_first text`,
  `alter table quant_jobs add column if not exists recenter_at_first bigint`,
  `alter table quant_jobs add column if not exists last_observed_at_ms bigint`,
  `alter table quant_jobs add column if not exists last_accepted_block numeric`,
  `alter table quant_jobs add column if not exists last_accepted_hash text`,
  `alter table quant_jobs add column if not exists last_accepted_at_ms bigint`,
  `alter table quant_jobs add column if not exists cap_rows_json text`,
  `alter table quant_jobs add column if not exists wire_state text not null default 'compatible'`,
  `alter table quant_jobs add column if not exists accounting_state text not null default 'ok'`,
  `alter table quant_jobs add column if not exists accounting_epoch int`,
  `alter table quant_jobs add column if not exists accounting_evidence_json text`,
  `alter table quant_jobs add column if not exists accounting_rev bigint not null default 0`,
  `alter table quant_jobs add column if not exists report_payload_hash text`,
  `alter table quant_jobs add column if not exists report_response_status int`,
  `alter table quant_levels add column if not exists ladder_gen int not null default 0`,
  `alter table quant_levels add column if not exists seed_pending boolean not null default false`,
  `alter table quant_levels add column if not exists seed_refusals int not null default 0`,
  `alter table quant_levels add column if not exists seed_submissions int not null default 0`,
  `alter table quant_levels add column if not exists seed_last_cause text`,
  `alter table quant_levels add column if not exists seed_outcome text`,
  `alter table quant_levels add column if not exists seed_note text`,
  `alter table quant_levels add column if not exists trigger_block_first numeric`,
  `alter table quant_levels add column if not exists trigger_hash_first text`,
  `alter table quant_levels add column if not exists trigger_at_first bigint`,
  `alter table quant_actions add column if not exists ladder_gen int not null default 0`,
  `alter table quant_actions add column if not exists evidence_kind text not null default 'crossing'`,
  `alter table quant_actions add column if not exists executed_block numeric`,
  `alter table quant_actions add column if not exists executed_at_sec bigint`,
  `alter table quant_actions add column if not exists required_native_wei numeric`,
  `alter table quant_actions add column if not exists gas_price_wei numeric`,
  `alter table quant_actions add column if not exists fee_est_wei numeric`,
  `alter table quant_actions add column if not exists pre_native_block numeric`,
  `alter table quant_epochs add column if not exists started_block_hash text`,
  `alter table quant_epochs add column if not exists verified boolean not null default false`,
  `alter table quant_recenters add column if not exists evidence_block_1 numeric not null default 0`,
  `alter table quant_recenters add column if not exists evidence_block_2 numeric not null default 0`,
  `alter table quant_recenters add column if not exists evidence_hash_1 text`,
  `alter table quant_recenters add column if not exists evidence_hash_2 text`,
  `alter table quant_recenters add column if not exists evidence_at_1 bigint`,
  `alter table quant_recenters add column if not exists evidence_at_2 bigint`,
  `do $$ begin if not exists (select 1 from pg_constraint where conname = 'quant_levels_seed_outcome_check') then alter table quant_levels add constraint quant_levels_seed_outcome_check check (seed_outcome in ('seeded','converted','retired')); end if; end $$`,
  `do $$ begin if not exists (select 1 from pg_constraint where conname = 'quant_jobs_wire_state_check') then alter table quant_jobs add constraint quant_jobs_wire_state_check check (wire_state in ('compatible','changed')); end if; end $$`,
  `do $$ begin if not exists (select 1 from pg_constraint where conname = 'quant_jobs_accounting_state_check') then alter table quant_jobs add constraint quant_jobs_accounting_state_check check (accounting_state in ('ok','external-activity')); end if; end $$`,
  `do $$ begin if not exists (select 1 from pg_constraint where conname = 'quant_actions_evidence_kind_check') then alter table quant_actions add constraint quant_actions_evidence_kind_check check (evidence_kind in ('crossing','seed')); end if; end $$`,
  `do $$ begin if not exists (select 1 from quant_quant_migrations where version = 'b2-baseline-provenance') then update quant_epochs set verified = false; insert into quant_quant_migrations (version, applied_at_ms) values ('b2-baseline-provenance', 0); end if; end $$`,
  `update quant_jobs set anchor_e18 = p0_e18 where ladder_gen = 0 and anchor_e18 = 0`,
  `update quant_jobs set recenter_budget = term_days where recenter_budget = 0 and term_days > 0`,
  `update quant_jobs set last_accepted_block = last_observed_block, last_accepted_hash = last_observed_hash, last_accepted_at_ms = last_observed_at_ms where last_accepted_block is null and last_observed_block is not null`,
  `update quant_jobs set accounting_epoch = (select max(epoch) from quant_epochs where quant_epochs.quant_job_id = quant_jobs.quant_job_id) where accounting_epoch is null and exists (select 1 from quant_epochs where quant_epochs.quant_job_id = quant_jobs.quant_job_id)`,
  `update quant_epochs set verified = false where verified = true and started_block_hash is null`,
];

const JOB_COLUMNS =
  "quant_job_id, strategy_id, trading_wallet, allocation_u_wei, daily_cap_u_wei, term_days, "
  + "started_at_ms, ends_at_ms, session_expires_at_ms, revoked_at_ms, status, envelope_json, "
  + "envelope_id, session_public_key, session_expiry, permissions_digest, projection_digest, "
  + "admitted_at_ms, chain_checked_at_ms, wbnb_cap_min_limit_wei, residual_threshold_wei, "
  + "params_json, params_digest, p0_e18, arm_block, levels, clip_u_wei, idle_u_wei, "
  + "last_observed_block, last_observed_hash, stale_observations, hold_code, hold_count, "
  + "last_job_read_at_ms, reported_at_ms, report_attempts, row_version, created_at_ms, updated_at_ms, "
  + "anchor_e18, ladder_gen, recenters, recenter_budget, last_recenter_at_ms, recenter_consecutive, "
  + "recenter_side, recenter_block_first, recenter_hash_first, recenter_at_first, last_observed_at_ms, "
  + "last_accepted_block, last_accepted_hash, last_accepted_at_ms, cap_rows_json, wire_state, "
  + "accounting_state, accounting_epoch, accounting_evidence_json, accounting_rev, "
  + "report_payload_hash, report_response_status";

const LEVEL_COLUMNS =
  "quant_job_id, level_index, state, buy_price_e18, sell_price_e18, base_wei, "
  + "base_at_cycle_start_wei, basis_u_wei, entry_cost_u_wei, action_seq, cycles_closed, "
  + "realized_u_wei, residual_wei, prior_state, trigger_consecutive, trigger_side, "
  + "last_action_at_ms, hold_code, hold_count, exit_plan_json, retired_json, row_version, "
  + "ladder_gen, seed_pending, seed_refusals, seed_submissions, seed_last_cause, "
  + "seed_outcome, seed_note, trigger_block_first, trigger_hash_first, trigger_at_first";

const ACTION_COLUMNS =
  "journal_key, quant_job_id, level_index, action_seq, side, state, prior_level_state, "
  + "amount_in_wei, min_out_wei, quote_out_wei, quote_block, trigger_block_1, trigger_block_2, "
  + "deadline_sec, calls_json, note, impact_bps, pre_u_wei, pre_wbnb_wei, pre_native_wei, pre_native_block, "
  + "basis_u_wei, base_at_cycle_start_wei, submit_finalized_number, submit_finalized_hash, "
  + "tx_hash, fill_in_wei, fill_out_wei, fee_delta_wei, resolution_json, failure_code, "
  + "ladder_gen, evidence_kind, executed_block, executed_at_sec, required_native_wei, "
  + "gas_price_wei, fee_est_wei, "
  + "created_at_ms, updated_at_ms, row_version";

const RECENTER_COLUMNS =
  "quant_job_id, seq, at_ms, block_number, block_hash, direction, from_gen, to_gen, "
  + "old_anchor_e18, new_anchor_e18, old_lines_json, new_lines_json, upper_prior_json, "
  + "reseed_scheduled, cause, evidence_block_1, evidence_block_2, evidence_hash_1, "
  + "evidence_hash_2, evidence_at_1, evidence_at_2";

const SEED_EVENT_COLUMNS =
  "quant_job_id, level_index, ladder_gen, accepted_block, kind, cause, journal_key, at_ms";

type JobRowShape = Record<string, unknown>;

function num(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  return BigInt(String(value));
}

function numOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  return BigInt(String(value));
}

function int(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === "t" || value === "true") return true;
  return false;
}

function rowToJob(row: JobRowShape): QuantJobRow {
  const wallet = String(row["trading_wallet"] ?? "");
  return {
    quantJobId: String(row["quant_job_id"]),
    strategyId: String(row["strategy_id"] ?? ""),
    tradingWallet: wallet === ""
      ? getAddress("0x0000000000000000000000000000000000000000")
      : getAddress(wallet),
    allocationUWei: num(row["allocation_u_wei"]),
    dailyCapUWei: num(row["daily_cap_u_wei"]),
    termDays: int(row["term_days"]),
    startedAtMs: intOrNull(row["started_at_ms"]),
    endsAtMs: intOrNull(row["ends_at_ms"]),
    sessionExpiresAtMs: intOrNull(row["session_expires_at_ms"]),
    revokedAtMs: intOrNull(row["revoked_at_ms"]),
    status: String(row["status"]) as QuantJobStatus,
    envelopeJson: text(row["envelope_json"]),
    envelopeId: text(row["envelope_id"]),
    sessionPublicKey: text(row["session_public_key"]) as Hex | null,
    sessionExpiry: intOrNull(row["session_expiry"]),
    permissionsDigest: text(row["permissions_digest"]) as Hex | null,
    projectionDigest: text(row["projection_digest"]) as Hex | null,
    admittedAtMs: intOrNull(row["admitted_at_ms"]),
    chainCheckedAtMs: intOrNull(row["chain_checked_at_ms"]),
    wbnbCapMinLimitWei: num(row["wbnb_cap_min_limit_wei"]),
    residualThresholdWei: num(row["residual_threshold_wei"]),
    paramsJson: text(row["params_json"]),
    paramsDigest: text(row["params_digest"]) as Hex | null,
    p0E18: num(row["p0_e18"]),
    armBlock: numOrNull(row["arm_block"]),
    levels: int(row["levels"]),
    clipUWei: num(row["clip_u_wei"]),
    idleUWei: num(row["idle_u_wei"]),
    lastObservedBlock: numOrNull(row["last_observed_block"]),
    lastObservedHash: text(row["last_observed_hash"]) as Hex | null,
    staleObservations: int(row["stale_observations"]),
    holdCode: text(row["hold_code"]) as QuantHoldCode | null,
    holdCount: int(row["hold_count"]),
    lastJobReadAtMs: intOrNull(row["last_job_read_at_ms"]),
    reportedAtMs: intOrNull(row["reported_at_ms"]),
    reportAttempts: int(row["report_attempts"]),
    rowVersion: int(row["row_version"]),
    createdAtMs: int(row["created_at_ms"]),
    updatedAtMs: int(row["updated_at_ms"]),
    anchorE18: num(row["anchor_e18"]),
    ladderGen: int(row["ladder_gen"]),
    recenters: int(row["recenters"]),
    recenterBudget: int(row["recenter_budget"]),
    lastRecenterAtMs: intOrNull(row["last_recenter_at_ms"]),
    recenterConsecutive: int(row["recenter_consecutive"]),
    recenterSide: text(row["recenter_side"]) as QuantRecenterSide | null,
    recenterBlockFirst: numOrNull(row["recenter_block_first"]),
    recenterHashFirst: text(row["recenter_hash_first"]) as Hex | null,
    recenterAtFirst: intOrNull(row["recenter_at_first"]),
    lastObservedAtMs: intOrNull(row["last_observed_at_ms"]),
    lastAcceptedBlock: numOrNull(row["last_accepted_block"]),
    lastAcceptedHash: text(row["last_accepted_hash"]) as Hex | null,
    lastAcceptedAtMs: intOrNull(row["last_accepted_at_ms"]),
    capRowsJson: text(row["cap_rows_json"]),
    wireState: (text(row["wire_state"]) ?? "compatible") as QuantWireState,
    accountingState: (text(row["accounting_state"]) ?? "ok") as QuantAccountingState,
    accountingEpoch: intOrNull(row["accounting_epoch"]),
    accountingEvidenceJson: text(row["accounting_evidence_json"]),
    accountingRev: num(row["accounting_rev"]),
    reportPayloadHash: text(row["report_payload_hash"]) as Hex | null,
    reportResponseStatus: intOrNull(row["report_response_status"]),
  };
}

function rowToLevel(row: JobRowShape): QuantLevelRow {
  return {
    quantJobId: String(row["quant_job_id"]),
    levelIndex: int(row["level_index"]),
    state: String(row["state"]) as QuantLevelState,
    buyPriceE18: num(row["buy_price_e18"]),
    sellPriceE18: num(row["sell_price_e18"]),
    baseWei: num(row["base_wei"]),
    baseAtCycleStartWei: num(row["base_at_cycle_start_wei"]),
    basisUWei: num(row["basis_u_wei"]),
    entryCostUWei: num(row["entry_cost_u_wei"]),
    actionSeq: int(row["action_seq"]),
    cyclesClosed: int(row["cycles_closed"]),
    realizedUWei: num(row["realized_u_wei"]),
    residualWei: num(row["residual_wei"]),
    priorState: text(row["prior_state"]) as QuantLevelState | null,
    triggerConsecutive: int(row["trigger_consecutive"]),
    triggerSide: text(row["trigger_side"]) as QuantSide | null,
    lastActionAtMs: intOrNull(row["last_action_at_ms"]),
    holdCode: text(row["hold_code"]) as QuantHoldCode | null,
    holdCount: int(row["hold_count"]),
    exitPlanJson: text(row["exit_plan_json"]),
    retiredJson: text(row["retired_json"]),
    rowVersion: int(row["row_version"]),
    ladderGen: int(row["ladder_gen"]),
    seedPending: bool(row["seed_pending"], false),
    seedRefusals: int(row["seed_refusals"]),
    seedSubmissions: int(row["seed_submissions"]),
    seedLastCause: text(row["seed_last_cause"]),
    seedOutcome: text(row["seed_outcome"]) as QuantSeedOutcome | null,
    seedNote: text(row["seed_note"]),
    triggerBlockFirst: numOrNull(row["trigger_block_first"]),
    triggerHashFirst: text(row["trigger_hash_first"]) as Hex | null,
    triggerAtFirst: intOrNull(row["trigger_at_first"]),
  };
}

function rowToAction(row: JobRowShape): QuantActionRow {
  return {
    journalKey: String(row["journal_key"]),
    quantJobId: String(row["quant_job_id"]),
    levelIndex: int(row["level_index"]),
    actionSeq: int(row["action_seq"]),
    side: String(row["side"]) as QuantSide,
    state: String(row["state"]) as QuantActionState,
    priorLevelState: String(row["prior_level_state"]) as QuantLevelState,
    amountInWei: num(row["amount_in_wei"]),
    minOutWei: num(row["min_out_wei"]),
    quoteOutWei: num(row["quote_out_wei"]),
    quoteBlock: num(row["quote_block"]),
    triggerBlock1: num(row["trigger_block_1"]),
    triggerBlock2: num(row["trigger_block_2"]),
    deadlineSec: int(row["deadline_sec"]),
    callsJson: String(row["calls_json"]),
    note: String(row["note"] ?? ""),
    impactBps: int(row["impact_bps"]),
    preUWei: num(row["pre_u_wei"]),
    preWbnbWei: num(row["pre_wbnb_wei"]),
    preNativeWei: num(row["pre_native_wei"]),
    preNativeBlock: numOrNull(row["pre_native_block"]),
    basisUWei: num(row["basis_u_wei"]),
    baseAtCycleStartWei: num(row["base_at_cycle_start_wei"]),
    submitFinalizedNumber: numOrNull(row["submit_finalized_number"]),
    submitFinalizedHash: text(row["submit_finalized_hash"]) as Hex | null,
    txHash: text(row["tx_hash"]) as Hex | null,
    fillInWei: numOrNull(row["fill_in_wei"]),
    fillOutWei: numOrNull(row["fill_out_wei"]),
    feeDeltaWei: numOrNull(row["fee_delta_wei"]),
    resolutionJson: text(row["resolution_json"]),
    failureCode: text(row["failure_code"]),
    ladderGen: int(row["ladder_gen"]),
    evidenceKind: (text(row["evidence_kind"]) ?? "crossing") as QuantEvidenceKind,
    executedBlock: numOrNull(row["executed_block"]),
    executedAtSec: numOrNull(row["executed_at_sec"]),
    requiredNativeWei: numOrNull(row["required_native_wei"]),
    gasPriceWei: numOrNull(row["gas_price_wei"]),
    feeEstWei: numOrNull(row["fee_est_wei"]),
    createdAtMs: int(row["created_at_ms"]),
    updatedAtMs: int(row["updated_at_ms"]),
    rowVersion: int(row["row_version"]),
  };
}

function rowToEpoch(row: JobRowShape): QuantEpochRow {
  return {
    quantJobId: String(row["quant_job_id"]),
    epoch: int(row["epoch"]),
    startedBlock: num(row["started_block"]),
    startedBlockHash: text(row["started_block_hash"]) as Hex | null,
    baselineUWei: num(row["baseline_u_wei"]),
    baselineWbnbWei: num(row["baseline_wbnb_wei"]),
    baselineNativeWei: num(row["baseline_native_wei"]),
    note: String(row["note"] ?? ""),
    createdAtMs: int(row["created_at_ms"]),
    verified: bool(row["verified"], false),
  };
}

function rowToRecenter(row: JobRowShape): QuantRecenterRow {
  return {
    quantJobId: String(row["quant_job_id"]), seq: int(row["seq"]), atMs: int(row["at_ms"]),
    blockNumber: num(row["block_number"]), blockHash: String(row["block_hash"]) as Hex,
    direction: String(row["direction"]) as QuantRecenterSide,
    fromGen: int(row["from_gen"]), toGen: int(row["to_gen"]),
    oldAnchorE18: num(row["old_anchor_e18"]), newAnchorE18: num(row["new_anchor_e18"]),
    oldLinesJson: String(row["old_lines_json"]), newLinesJson: String(row["new_lines_json"]),
    upperPriorJson: String(row["upper_prior_json"]), reseedScheduled: bool(row["reseed_scheduled"], false),
    cause: String(row["cause"]), evidenceBlock1: num(row["evidence_block_1"]),
    evidenceBlock2: num(row["evidence_block_2"]),
    evidenceHash1: text(row["evidence_hash_1"]) as Hex | null,
    evidenceHash2: text(row["evidence_hash_2"]) as Hex | null,
    evidenceAt1: intOrNull(row["evidence_at_1"]), evidenceAt2: intOrNull(row["evidence_at_2"]),
  };
}

function rowToSeedEvent(row: JobRowShape): QuantSeedEventRow {
  return {
    quantJobId: String(row["quant_job_id"]), levelIndex: int(row["level_index"]),
    ladderGen: int(row["ladder_gen"]), acceptedBlock: num(row["accepted_block"]),
    kind: String(row["kind"]) as "refusal" | "claim", cause: String(row["cause"]),
    journalKey: text(row["journal_key"]), atMs: int(row["at_ms"]),
  };
}

export class PostgresQuantJobStore implements QuantJobStore {
  readonly #sql: SqlClient;
  /** Exposed for diagnostics; every WRITE takes its timestamp from the caller. */
  readonly now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.now = now;
  }

  static async create(sql: SqlClient, now: Clock = Date.now): Promise<PostgresQuantJobStore> {
    await sql.query(QUANT_JOBS_DDL);
    await sql.query(QUANT_LEVELS_DDL);
    await sql.query(QUANT_ACTIONS_DDL);
    await sql.query(QUANT_ACTIONS_INDEX_DDL);
    await sql.query(QUANT_RECEIPT_OWNERSHIP_DDL);
    await sql.query(QUANT_EPOCHS_DDL);
    await sql.query(QUANT_RECENTERS_DDL);
    await sql.query(QUANT_SEED_EVENTS_DDL);
    await sql.query(QUANT_OBSERVATIONS_DDL);
    await sql.query(QUANT_INDEXER_TRADES_DDL);
    await sql.query(QUANT_REPORTS_DDL);
    await sql.query(QUANT_RUNS_DDL);
    await sql.query(QUANT_SCHEMA_MIGRATIONS_DDL);
    for (const migration of QUANT_MIGRATIONS) await sql.query(migration);
    return new PostgresQuantJobStore(sql, now);
  }

  async discoverJob(input: DiscoverQuantJobInput): Promise<QuantJobRow> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      await tx.query(
        `/* quantJobs.discover */
         insert into quant_jobs (quant_job_id, status, envelope_json, envelope_id,
           strategy_id, created_at_ms, updated_at_ms)
         values ($1, 'discovered', $2, $3, $5, $4::bigint, $4::bigint)
         on conflict (quant_job_id) do nothing`,
        [input.quantJobId, input.envelopeJson, input.envelopeId, input.nowMs, input.strategyId ?? ""],
      );
      const row = await this.#getJobOn(tx, input.quantJobId);
      if (row === null) throw new Error("quant job insert did not produce a row.");
      return row;
    });
  }

  async updateJobWire(input: UpdateQuantJobWireInput): Promise<UpdateQuantJobWireResult | null> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`,
        [QUANT_LOCK_CLASSID, input.quantJobId],
      );
      const current = await tx.query<JobRowShape>(
        `/* quantJobs.get */ select ${JOB_COLUMNS} from quant_jobs where quant_job_id = $1`,
        [input.quantJobId],
      );
      const existing = current.rows[0];
      if (existing === undefined || (String(existing["strategy_id"] ?? "") !== ""
        && String(existing["strategy_id"]) !== input.strategyId)) return null;
      const currentRow = rowToJob(existing);
      const wireDiffers = currentRow.admittedAtMs !== null && (
        currentRow.tradingWallet.toLowerCase() !== getAddress(input.tradingWallet).toLowerCase()
        || currentRow.allocationUWei !== input.allocationUWei
        || currentRow.termDays !== input.termDays
      );
      const result = await tx.query<JobRowShape>(
        `/* quantJobs.updateWire */
         update quant_jobs
         set strategy_id = case when strategy_id = '' then $2 else strategy_id end,
             trading_wallet = case when admitted_at_ms is null then $3 else trading_wallet end,
             allocation_u_wei = case when admitted_at_ms is null then $4::numeric else allocation_u_wei end,
             daily_cap_u_wei = $5::numeric, term_days = case when admitted_at_ms is null then $6::int else term_days end,
             started_at_ms = $7::bigint, ends_at_ms = $8::bigint,
             session_expires_at_ms = $9::bigint, revoked_at_ms = $10::bigint,
             wire_state = case when admitted_at_ms is not null and
               (lower(trading_wallet) <> lower($3) or allocation_u_wei <> $4::numeric or term_days <> $6::int)
               then 'changed' else 'compatible' end,
             last_job_read_at_ms = $11::bigint, row_version = row_version + 1,
             updated_at_ms = $11::bigint
         where quant_job_id = $1 and (strategy_id = '' or strategy_id = $2)
         returning ${JOB_COLUMNS}`,
        [
          input.quantJobId, input.strategyId, getAddress(input.tradingWallet),
          input.allocationUWei.toString(10), input.dailyCapUWei.toString(10), input.termDays,
          input.startedAtMs, input.endsAtMs, input.sessionExpiresAtMs, input.revokedAtMs,
          input.nowMs,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : Object.assign(rowToJob(row), { wireDiffers });
    });
  }

  async replaceEnvelope(
    quantJobId: string, envelopeJson: string, nowMs: number,
  ): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, quantJobId]);
      await tx.query(
        `/* quantJobs.replaceEnvelope */ update quant_jobs set envelope_json = $2,
          row_version = row_version + 1, updated_at_ms = $3::bigint where quant_job_id = $1`,
        [quantJobId, envelopeJson, nowMs],
      );
    });
  }

  async acknowledgeExternal(input: {
    readonly quantJobId: string;
    readonly startedBlock: bigint;
    readonly startedBlockHash: Hex;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantEpochRow>> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      const jobResult = await tx.query<JobRowShape>(`/* quantJobs.get */ select ${JOB_COLUMNS} from quant_jobs where quant_job_id = $1`, [input.quantJobId]);
      const job = jobResult.rows[0] === undefined ? null : rowToJob(jobResult.rows[0]);
      const epoch = await this.#currentEpochOn(tx, input.quantJobId);
      if (job === null || epoch === null || job.accountingState !== "external-activity" || input.startedBlock <= epoch.startedBlock) {
        return { kind: "conflict" as const, record: epoch };
      }
      const next = await this.#openEpochOn(tx, { ...input, note: "acknowledge-external:rebase" });
      await tx.query(
        `/* quantJobs.clearAccounting */ update quant_jobs set accounting_state = 'ok',
          accounting_epoch = $2::int, accounting_evidence_json = null,
          accounting_rev = accounting_rev + 1, row_version = row_version + 1,
          updated_at_ms = $3::bigint where quant_job_id = $1`,
        [input.quantJobId, next.epoch, input.nowMs],
      );
      return { kind: "ok" as const, record: next };
    });
  }

  async listRecenters(quantJobId: string): Promise<readonly QuantRecenterRow[]> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantRecenters.list */ select ${RECENTER_COLUMNS} from quant_recenters where quant_job_id = $1 order by seq asc`, [quantJobId],
    );
    return result.rows.map(rowToRecenter);
  }

  async listSeedEvents(quantJobId: string): Promise<readonly QuantSeedEventRow[]> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantSeedEvents.list */ select ${SEED_EVENT_COLUMNS} from quant_seed_events where quant_job_id = $1 order by at_ms asc`, [quantJobId],
    );
    return result.rows.map(rowToSeedEvent);
  }

  async verifyCurrentEpoch(input: { readonly quantJobId: string; readonly verified: boolean; readonly nowMs: number }): Promise<boolean> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      const result = await tx.query(
        `/* quantEpochs.verify */ update quant_epochs set verified = $2::boolean where quant_job_id = $1
         and epoch = (select max(epoch) from quant_epochs where quant_job_id = $1) returning epoch`,
        [input.quantJobId, input.verified],
      );
      if (result.rows.length > 0) await tx.query(
        `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
          row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
        [input.quantJobId, input.nowMs],
      );
      return result.rows.length > 0;
    });
  }

  async verifyEpochBaseline(input: {
    readonly quantJobId: string;
    readonly epoch: number;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly nowMs: number;
  }): Promise<boolean> {
    const result = await this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      const result = await tx.query(
        `/* quantEpochs.verifyBaseline */ update quant_epochs set verified = true
         where quant_job_id = $1 and epoch = $2::int and baseline_u_wei = $3::numeric
           and baseline_wbnb_wei = $4::numeric and baseline_native_wei = $5::numeric
           returning epoch`,
        [input.quantJobId, input.epoch, input.baselineUWei.toString(10), input.baselineWbnbWei.toString(10), input.baselineNativeWei.toString(10)],
      );
      if (result.rows.length > 0) await tx.query(
        `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
          row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
        [input.quantJobId, input.nowMs],
      );
      return result;
    });
    return result.rows.length > 0;
  }

  async setEpochHash(input: {
    readonly quantJobId: string;
    readonly epoch: number;
    readonly blockHash: Hex;
    readonly nowMs: number;
  }): Promise<boolean> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      const result = await tx.query(
        `/* quantEpochs.backfillHash */ update quant_epochs set started_block_hash = $3, verified = false
         where quant_job_id = $1 and epoch = $2::int and started_block_hash is null returning epoch`,
        [input.quantJobId, input.epoch, input.blockHash],
      );
      if (result.rows.length > 0) await tx.query(
        `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
          row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
        [input.quantJobId, input.nowMs],
      );
      return result.rows.length > 0;
    });
  }

  async listAccountingActions(quantJobId: string): Promise<readonly QuantActionRow[]> {
    return this.listActions(quantJobId);
  }

  async setAccountingState(input: {
    readonly quantJobId: string;
    readonly state: QuantAccountingState;
    readonly epoch: number | null;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<QuantJobRow | null> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      const result = await tx.query<JobRowShape>(
        `/* quantJobs.accountingState */ update quant_jobs set accounting_state = $2,
          accounting_epoch = $3::int, accounting_evidence_json = $4,
          accounting_rev = accounting_rev + 1, row_version = row_version + 1,
          updated_at_ms = $5::bigint where quant_job_id = $1 returning ${JOB_COLUMNS}`,
        [input.quantJobId, input.state, input.epoch, input.evidenceJson, input.nowMs],
      );
      return result.rows[0] === undefined ? null : rowToJob(result.rows[0]);
    });
  }

  async publishAccountingVerdict(input: {
    readonly quantJobId: string;
    readonly expectedAccountingRev: bigint;
    readonly expectedEpoch: number;
    readonly expectedEpochHash?: Hex | null;
    readonly observationBlock: bigint;
    readonly observationHash?: Hex | null;
    readonly admissible: boolean;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<{ readonly ok: boolean; readonly reason?: "reconcile-stale" }> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      const result = await tx.query(
        `/* quantJobs.publishAccounting */ update quant_jobs set
          accounting_state = case when $5::boolean then accounting_state else 'external-activity' end,
          accounting_epoch = $3::int,
          accounting_evidence_json = case when not $5::boolean then $6
            when accounting_state = 'ok' then $6 else accounting_evidence_json end,
          hold_code = case when $5::boolean then hold_code else 'external-activity' end,
          accounting_rev = accounting_rev + 1,
          row_version = row_version + 1, updated_at_ms = $7::bigint
         where quant_job_id = $1 and accounting_rev = $2::bigint
           and accounting_epoch = $3::int and last_accepted_block = $4::numeric
           and $8::text is not null
           and exists (select 1 from quant_epochs where quant_job_id = $1
             and epoch = $3::int and started_block_hash = $8)
           and $9::text is not null and last_accepted_hash = $9
         returning quant_job_id`,
        [input.quantJobId, input.expectedAccountingRev.toString(10), input.expectedEpoch,
          input.observationBlock.toString(10), input.admissible, input.evidenceJson, input.nowMs,
          input.expectedEpochHash ?? null, input.observationHash ?? null],
      );
      return result.rows.length === 0 ? { ok: false, reason: "reconcile-stale" as const } : { ok: true };
    });
  }

  async publishTruthVerdict(input: {
    readonly quantJobId: string;
    readonly expectedAccountingRev: bigint;
    readonly expectedEpoch: number;
    readonly expectedEpochHash?: Hex | null;
    readonly observationBlock: bigint;
    readonly observationHash?: Hex | null;
    readonly admissible: boolean;
    readonly evidenceJson: string | null;
    readonly nowMs: number;
  }): Promise<{ readonly ok: boolean; readonly reason?: "reconcile-stale" }> {
    return this.withQuantFence(input.quantJobId, async (fence) =>
      fence.publishTruthVerdict(input));
  }

  async admitJob(input: AdmitQuantJobInput): Promise<QuantCasResult<QuantJobRow>> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`,
        [QUANT_LOCK_CLASSID, input.quantJobId],
      );
      const result = await tx.query<JobRowShape>(
        `/* quantJobs.admit */
         update quant_jobs
         set status = 'armed', session_public_key = $3, session_expiry = $4::bigint,
             permissions_digest = $5, projection_digest = $6,
             admitted_at_ms = $7::bigint, chain_checked_at_ms = $7::bigint,
             wbnb_cap_min_limit_wei = $8::numeric, residual_threshold_wei = $9::numeric,
             params_json = $10, params_digest = $11, p0_e18 = $12::numeric,
             arm_block = $13::numeric, levels = $14::int, clip_u_wei = $15::numeric,
             idle_u_wei = $16::numeric, hold_code = null,
             anchor_e18 = $12::numeric, ladder_gen = 0, recenters = 0,
             recenter_budget = $17::int,
             wire_state = 'compatible', accounting_state = 'ok', accounting_epoch = 1,
             accounting_evidence_json = null, accounting_rev = 0,
             row_version = row_version + 1, updated_at_ms = $7::bigint
         where quant_job_id = $1 and row_version = $2::int and status = 'discovered'
         returning ${JOB_COLUMNS}`,
        [
          input.quantJobId, input.expectedRowVersion, input.sessionPublicKey,
          input.sessionExpiry, input.permissionsDigest, input.projectionDigest,
          input.nowMs, input.wbnbCapMinLimitWei.toString(10),
          input.residualThresholdWei.toString(10), input.paramsJson, input.paramsDigest,
          input.p0E18.toString(10), input.armBlock.toString(10), input.levels.length,
          input.clipUWei.toString(10), input.idleUWei.toString(10), input.recenterBudget ?? 0,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        const current = await tx.query<JobRowShape>(
          `/* quantJobs.get */ select ${JOB_COLUMNS} from quant_jobs where quant_job_id = $1`,
          [input.quantJobId],
        );
        const existing = current.rows[0];
        return {
          kind: "conflict" as const,
          record: existing === undefined ? null : rowToJob(existing),
        };
      }
      for (const level of input.levels) {
        // `do nothing` is what makes the prices WRITE-ONCE: there is no
        // statement in this class that can update `buy_price_e18` or
        // `sell_price_e18`, so a moving ladder is not expressible.
        await tx.query(
          `/* quantLevels.insert */
           insert into quant_levels (quant_job_id, level_index, state, buy_price_e18,
             sell_price_e18, ladder_gen, seed_pending)
           values ($1, $2::int, 'armed-quote', $3::numeric, $4::numeric, 0, $5::boolean)
           on conflict (quant_job_id, level_index) do nothing`,
          [
            input.quantJobId, level.levelIndex,
            level.buyPriceE18.toString(10), level.sellPriceE18.toString(10), level.seedPending === true,
          ],
        );
      }
      await this.#openEpochOn(tx, {
        quantJobId: input.quantJobId,
        startedBlock: input.armBlock,
        startedBlockHash: input.armBlockHash ?? null,
        baselineUWei: input.baselineUWei,
        baselineWbnbWei: input.baselineWbnbWei,
        baselineNativeWei: input.baselineNativeWei,
        note: "arm",
        nowMs: input.nowMs,
      });
      const current = await this.#getJobOn(tx, input.quantJobId);
      return { kind: "ok" as const, record: current ?? rowToJob(row) };
    });
  }

  async getJob(quantJobId: string): Promise<QuantJobRow | null> {
    return this.#getJobOn(this.#sql, quantJobId);
  }

  async #getJobOn(sql: SqlClient, quantJobId: string): Promise<QuantJobRow | null> {
    const result = await sql.query<JobRowShape>(
      `/* quantJobs.get */ select ${JOB_COLUMNS} from quant_jobs where quant_job_id = $1`,
      [quantJobId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToJob(row);
  }

  async listJobs(): Promise<readonly QuantJobRow[]> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantJobs.list */ select ${JOB_COLUMNS} from quant_jobs order by quant_job_id asc`,
    );
    return result.rows.map(rowToJob);
  }

  async listWorkableJobs(strategyId: string): Promise<readonly QuantJobRow[]> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantJobs.listWorkable */
       select ${JOB_COLUMNS} from quant_jobs
       where status in ('discovered','armed','held','paused','ended','ended-unresolved','reported')
         and strategy_id = $1
         and (status <> 'reported'
           or exists (select 1 from quant_actions
             where quant_actions.quant_job_id = quant_jobs.quant_job_id
               and state not in ('settled','failed','aborted'))
           or ends_at_ms is null or ends_at_ms + $2::bigint >= $3::bigint)
       order by quant_job_id asc`,
      [strategyId, REPORT_HORIZON_MS, this.now()],
    );
    return result.rows.map(rowToJob);
  }

  private async setJobStatus(input: {
    readonly quantJobId: string;
    readonly status: QuantJobStatus;
    readonly holdCode?: QuantHoldCode | null;
    readonly nowMs: number;
  }): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`,
        [QUANT_LOCK_CLASSID, input.quantJobId],
      );
      await tx.query(
        `/* quantJobs.setStatus */
         update quant_jobs
         set status = $2, hold_code = $3,
             reported_at_ms = case when $2 = 'reported' then $4::bigint else reported_at_ms end,
             row_version = row_version + 1, updated_at_ms = $4::bigint
         where quant_job_id = $1
           and ($2 <> 'paused' or status in ('armed','held'))
           and ($2 <> 'armed' or status in ('paused','held','discovered'))`,
        [input.quantJobId, input.status, input.holdCode ?? null, input.nowMs],
      );
      if (input.status === "paused") {
        await tx.query(
          `/* quantJobs.resetLatches */
           update quant_jobs set recenter_consecutive = 0, recenter_side = null,
             recenter_block_first = null, recenter_hash_first = null, recenter_at_first = null,
             row_version = row_version + 1 where quant_job_id = $1`,
          [input.quantJobId],
        );
        await tx.query(
          `/* quantLevels.resetLatches */
           update quant_levels set trigger_consecutive = 0, trigger_side = null,
             trigger_block_first = null, trigger_hash_first = null, trigger_at_first = null,
             row_version = row_version + 1 where quant_job_id = $1`,
          [input.quantJobId],
        );
      }
    });
  }

  async holdJob(input: { readonly quantJobId: string; readonly holdCode: QuantHoldCode | null; readonly nowMs: number }): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      await tx.query(
        `/* quantJobs.setHold */ update quant_jobs set hold_code = $2,
          hold_count = case when $2::text is null then 0 else hold_count + 1 end,
          row_version = row_version + 1, updated_at_ms = $3::bigint where quant_job_id = $1`,
        [input.quantJobId, input.holdCode, input.nowMs],
      );
    });
  }

  async pauseJob(input: { readonly quantJobId: string; readonly nowMs: number }): Promise<boolean> {
    const before = await this.getJob(input.quantJobId);
    if (before === null || (before.status !== "armed" && before.status !== "held")) return false;
    await this.setJobStatus({ quantJobId: input.quantJobId, status: "paused", nowMs: input.nowMs });
    return (await this.getJob(input.quantJobId))?.status === "paused";
  }

  async resumeJob(input: { readonly quantJobId: string; readonly nowMs: number }): Promise<boolean> {
    const before = await this.getJob(input.quantJobId);
    if (before === null || before.status !== "paused") return false;
    await this.setJobStatus({ quantJobId: input.quantJobId, status: before.admittedAtMs === null ? "discovered" : "armed", nowMs: input.nowMs });
    return true;
  }

  async markEnded(input: { readonly quantJobId: string; readonly unresolved: boolean; readonly nowMs: number }): Promise<void> {
    await this.setJobStatus({ quantJobId: input.quantJobId, status: input.unresolved ? "ended-unresolved" : "ended", nowMs: input.nowMs });
  }

  async markReported(input: { readonly quantJobId: string; readonly nowMs: number }): Promise<void> {
    await this.setJobStatus({ quantJobId: input.quantJobId, status: "reported", nowMs: input.nowMs });
  }

  async listLevels(quantJobId: string): Promise<readonly QuantLevelRow[]> {
    return this.#listLevelsOn(this.#sql, quantJobId);
  }

  async #listLevelsOn(sql: SqlClient, quantJobId: string): Promise<readonly QuantLevelRow[]> {
    const result = await sql.query<JobRowShape>(
      `/* quantLevels.list */
       select ${LEVEL_COLUMNS} from quant_levels where quant_job_id = $1
       order by level_index asc`,
      [quantJobId],
    );
    return result.rows.map(rowToLevel);
  }

  async listActions(quantJobId: string): Promise<readonly QuantActionRow[]> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantActions.list */
       select ${ACTION_COLUMNS} from quant_actions where quant_job_id = $1
       order by created_at_ms asc`,
      [quantJobId],
    );
    return result.rows.map(rowToAction);
  }

  async listNonTerminalActions(quantJobId: string): Promise<readonly QuantActionRow[]> {
    return this.#listNonTerminalOn(this.#sql, quantJobId);
  }

  async acceptObservation(input: {
    readonly quantJobId: string;
    readonly observation: QuantObservation;
    readonly intervalMs: number;
    readonly processDigest?: Hex;
  }): Promise<QuantObservationAcceptance> {
    return this.withQuantFence(input.quantJobId, async (fence) => fence.acceptObservation(input));
  }

  async resetLatches(quantJobId: string, resetLevels = true): Promise<void> {
    await this.withQuantFence(quantJobId, async (fence) =>
      fence.resetLatches(quantJobId, resetLevels));
  }

  async #listNonTerminalOn(
    sql: SqlClient, quantJobId: string,
  ): Promise<readonly QuantActionRow[]> {
    const result = await sql.query<JobRowShape>(
      `/* quantActions.listNonTerminal */
       select ${ACTION_COLUMNS} from quant_actions
       where quant_job_id = $1 and state not in ('settled','failed','aborted')
       order by created_at_ms asc`,
      [quantJobId],
    );
    return result.rows.map(rowToAction);
  }

  async getAction(journalKey: string): Promise<QuantActionRow | null> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantActions.get */
       select ${ACTION_COLUMNS} from quant_actions where journal_key = $1`,
      [journalKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToAction(row);
  }

  async markActionSubmitted(input: {
    readonly journalKey: string;
    readonly expectedRowVersion: number;
    readonly submitFinalizedNumber: bigint;
    readonly submitFinalizedHash: Hex;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantActionRow>> {
    return this.#sql.transaction(async (tx) => {
      const actionRead = await tx.query<JobRowShape>(`/* quantActions.get */ select ${ACTION_COLUMNS} from quant_actions where journal_key = $1`, [input.journalKey]);
      const before = actionRead.rows[0];
      if (before === undefined) return { kind: "conflict" as const, record: null };
      const actionBefore = rowToAction(before);
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, actionBefore.quantJobId]);
      const result = await tx.query<JobRowShape>(
        `/* quantActions.markSubmitted */
         update quant_actions
         set state = 'submitted', submit_finalized_number = $3::numeric,
             submit_finalized_hash = $4, row_version = row_version + 1,
             updated_at_ms = $5::bigint
         where journal_key = $1 and row_version = $2::int and state = 'intended'
         returning ${ACTION_COLUMNS}`,
        [input.journalKey, input.expectedRowVersion,
          input.submitFinalizedNumber.toString(10), input.submitFinalizedHash, input.nowMs],
      );
      const row = result.rows[0];
      if (row === undefined) {
        const current = await tx.query<JobRowShape>(`/* quantActions.get */ select ${ACTION_COLUMNS} from quant_actions where journal_key = $1`, [input.journalKey]);
        return { kind: "conflict" as const, record: current.rows[0] === undefined ? null : rowToAction(current.rows[0]) };
      }
      if (actionBefore.evidenceKind === "seed") {
        const claim = await tx.query<{ journal_key: string }>(
          `/* quantSeedEvents.claim */
           insert into quant_seed_events (quant_job_id, level_index, ladder_gen, accepted_block,
             kind, cause, journal_key, at_ms)
           values ($1, $2::int, $3::int, $4::numeric, 'claim', $5, $6, $7::bigint)
           on conflict do nothing returning journal_key`,
          [actionBefore.quantJobId, actionBefore.levelIndex, actionBefore.ladderGen,
            actionBefore.triggerBlock1.toString(10), `submitted:${actionBefore.journalKey}`,
            actionBefore.journalKey, input.nowMs],
        );
        if (claim.rows.length > 0) {
          await tx.query(
            `/* quantLevels.seedSubmission */ update quant_levels
             set seed_submissions = seed_submissions + 1,
               seed_last_cause = $3, row_version = row_version + 1
             where quant_job_id = $1 and level_index = $2::int and seed_pending`,
            [actionBefore.quantJobId, actionBefore.levelIndex, `submitted:${actionBefore.journalKey}`],
          );
        }
      }
      await tx.query(
        `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
          row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
        [actionBefore.quantJobId, input.nowMs],
      );
      return { kind: "ok" as const, record: rowToAction(row) };
    });
  }

  async abortIntent(input: {
    readonly journalKey: string;
    readonly expectedRowVersion: number;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantActionRow>> {
    return this.#sql.transaction(async (tx) => {
      const actionRead = await tx.query<{ quant_job_id: string }>(
        `/* quantActions.get */ select quant_job_id from quant_actions where journal_key = $1`,
        [input.journalKey],
      );
      const actionJobId = actionRead.rows[0]?.quant_job_id;
      if (actionJobId === undefined) return { kind: "conflict" as const, record: null };
      await tx.query(
        `/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`,
        [QUANT_LOCK_CLASSID, actionJobId],
      );
      const result = await tx.query<JobRowShape>(
        `/* quantActions.abort */
         update quant_actions
         set state = 'aborted', row_version = row_version + 1, updated_at_ms = $3::bigint
         where journal_key = $1 and row_version = $2::int and state = 'intended'
         returning ${ACTION_COLUMNS}`,
        [input.journalKey, input.expectedRowVersion, input.nowMs],
      );
      const row = result.rows[0];
      if (row === undefined) {
        const current = await tx.query<JobRowShape>(
          `/* quantActions.get */
           select ${ACTION_COLUMNS} from quant_actions where journal_key = $1`,
          [input.journalKey],
        );
        const existing = current.rows[0];
        return {
          kind: "conflict" as const,
          record: existing === undefined ? null : rowToAction(existing),
        };
      }
      const action = rowToAction(row);
      await this.#restoreLevelOn(tx, action);
      await tx.query(
        `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
          row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
        [action.quantJobId, input.nowMs],
      );
      return { kind: "ok" as const, record: action };
    });
  }

  async #restoreLevelOn(sql: SqlClient, action: QuantActionRow): Promise<void> {
    await sql.query(
      `/* quantLevels.restore */
       update quant_levels
       set state = $3, trigger_consecutive = 0, trigger_side = null,
           row_version = row_version + 1
       where quant_job_id = $1 and level_index = $2::int and state <> 'retired'`,
      [action.quantJobId, action.levelIndex, action.priorLevelState],
    );
  }

  async setActionState(input: {
    readonly journalKey: string;
    readonly state: QuantActionState;
    readonly failureCode?: string | null;
    readonly txHash?: Hex | null;
    readonly resolutionJson?: string | null;
    readonly restoreLevel?: boolean;
    readonly nowMs: number;
  }): Promise<QuantActionRow | null> {
    return this.#sql.transaction(async (tx) => {
      const actionLookup = await tx.query<JobRowShape>(`/* quantActions.get */ select ${ACTION_COLUMNS} from quant_actions where journal_key = $1`, [input.journalKey]);
      const beforeRow = actionLookup.rows[0];
      if (beforeRow === undefined) return null;
      const before = rowToAction(beforeRow);
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, before.quantJobId]);
      const result = await tx.query<JobRowShape>(
        `/* quantActions.setState */
         update quant_actions
         set state = $2,
             failure_code = coalesce($3, failure_code),
             tx_hash = coalesce($4, tx_hash),
             resolution_json = coalesce($5, resolution_json),
             row_version = row_version + 1, updated_at_ms = $6::bigint
         where journal_key = $1 and state not in ('settled','failed','aborted')
         returning ${ACTION_COLUMNS}`,
        [
          input.journalKey, input.state, input.failureCode ?? null,
          input.txHash ?? null, input.resolutionJson ?? null, input.nowMs,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const action = rowToAction(row);
      if (input.state === "failed" && action.evidenceKind === "seed" && input.failureCode !== undefined && input.failureCode !== null) {
        await tx.query(
          `/* quantLevels.seedFailure */ update quant_levels set seed_last_cause = $3,
             row_version = row_version + 1 where quant_job_id = $1 and level_index = $2::int
               and ladder_gen = $4::int`,
          [action.quantJobId, action.levelIndex, `failed:${action.journalKey}:${input.failureCode}`, action.ladderGen],
        );
      }
      if (input.restoreLevel === true) await this.#restoreLevelOn(tx, action);
      await tx.query(
        `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
          row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
        [action.quantJobId, input.nowMs],
      );
      return action;
    });
  }

  /**
   * Action + level + receipt ownership + accounting in ONE transaction (BC31).
   *
   * The ownership insert is what makes settlement exactly-once across
   * processes: a second action that decodes the same `(tx, wallet, swap log)`
   * loses the primary key and the whole transaction rolls back, so no level is
   * credited twice.
   */
  async settleAction(input: SettleQuantActionInput): Promise<QuantCasResult<QuantActionRow>> {
    return this.#sql.transaction(async (tx) => {
      const existing = await tx.query<JobRowShape>(
        `/* quantActions.get */
         select ${ACTION_COLUMNS} from quant_actions where journal_key = $1`,
        [input.journalKey],
      );
      const current = existing.rows[0];
      if (current === undefined) return { kind: "conflict" as const, record: null };
      const action = rowToAction(current);
      await tx.query(
        `/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`,
        [QUANT_LOCK_CLASSID, action.quantJobId],
      );
      if (action.quantJobId !== input.quantJobId || action.levelIndex !== input.levelIndex) {
        return { kind: "conflict" as const, record: action };
      }
      const levelExists = await tx.query<{ level_index: number }>(
        `/* quantLevels.getOne */ select level_index from quant_levels where quant_job_id = $1 and level_index = $2::int`,
        [input.quantJobId, input.levelIndex],
      );
      if (levelExists.rows.length === 0) return { kind: "conflict" as const, record: action };
      if (action.state === "settled") return { kind: "ok" as const, record: action };
      if (action.state === "failed" || action.state === "aborted") {
        return { kind: "conflict" as const, record: action };
      }
      const wallet = await tx.query<{ trading_wallet: string }>(
        `/* quantJobs.wallet */ select trading_wallet from quant_jobs where quant_job_id = $1`,
        [input.quantJobId],
      );
      const owned = await tx.query<{ journal_key: string }>(
        `/* quantReceipts.claim */
         insert into quant_receipt_ownership (tx_hash, trading_wallet, swap_log_index,
           journal_key, created_at_ms)
         values ($1, $2, $3::numeric, $4, $5::bigint)
         on conflict (tx_hash, trading_wallet, swap_log_index) do nothing
         returning journal_key`,
        [
          input.txHash.toLowerCase(),
          String(wallet.rows[0]?.trading_wallet ?? "").toLowerCase(),
          input.swapLogIndex.toString(10), input.journalKey, input.nowMs,
        ],
      );
      if (owned.rows.length === 0) return { kind: "conflict" as const, record: action };
      const settled = await tx.query<JobRowShape>(
        `/* quantActions.settle */
         update quant_actions
         set state = 'settled', tx_hash = $2, fill_in_wei = $3::numeric,
             fill_out_wei = $4::numeric, fee_delta_wei = $5::numeric,
             executed_block = $6::numeric, executed_at_sec = $7::bigint,
             row_version = row_version + 1, updated_at_ms = $8::bigint
         where journal_key = $1 and state not in ('settled','failed','aborted')
         returning ${ACTION_COLUMNS}`,
        [
          input.journalKey, input.txHash, input.fillInWei.toString(10),
          input.fillOutWei.toString(10),
          input.feeDeltaWei === null ? null : input.feeDeltaWei.toString(10),
          input.executedBlock === undefined || input.executedBlock === null ? null : input.executedBlock.toString(10),
          input.executedAtSec === undefined || input.executedAtSec === null ? null : input.executedAtSec.toString(10),
          input.nowMs,
        ],
      );
      const settledRow = settled.rows[0];
      if (settledRow === undefined) return { kind: "conflict" as const, record: action };
      await tx.query(
        `/* quantLevels.settle */
         update quant_levels
         set state = $3, base_wei = $4::numeric, base_at_cycle_start_wei = $5::numeric,
             basis_u_wei = $6::numeric, entry_cost_u_wei = $7::numeric,
             cycles_closed = cycles_closed + $8::int,
             realized_u_wei = realized_u_wei + $9::numeric,
             residual_wei = residual_wei + $10::numeric,
             exit_plan_json = $11, trigger_consecutive = 0, trigger_side = null,
             trigger_block_first = null, trigger_hash_first = null, trigger_at_first = null,
             seed_pending = case when $3 = 'holding-base' and seed_pending then false else seed_pending end,
             seed_outcome = case when $3 = 'holding-base' and seed_pending then 'seeded' else seed_outcome end,
             last_action_at_ms = $12::bigint, row_version = row_version + 1
         where quant_job_id = $1 and level_index = $2::int and state <> 'retired'`,
        [
          input.quantJobId, input.levelIndex, input.nextLevelState,
          input.nextBaseWei.toString(10), input.nextBaseAtCycleStartWei.toString(10),
          input.nextBasisUWei.toString(10), input.entryCostUWei.toString(10),
          input.cyclesClosedDelta, input.realizedDeltaUWei.toString(10),
          input.residualDeltaWei.toString(10), input.exitPlanJson, input.nowMs,
        ],
      );
      await tx.query(
        `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
          row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
        [input.quantJobId, input.nowMs],
      );
      return { kind: "ok" as const, record: rowToAction(settledRow) };
    });
  }

  async retireLevel(input: {
    readonly quantJobId: string;
    readonly levelIndex: number;
    readonly retiredJson: string;
    readonly epoch: {
      readonly startedBlock: bigint;
      readonly startedBlockHash: Hex;
      readonly baselineUWei: bigint;
      readonly baselineWbnbWei: bigint;
      readonly baselineNativeWei: bigint;
      readonly note: string;
    };
    readonly journalKey?: string;
    readonly expectedLevelRowVersion?: number;
    readonly expectedState?: QuantLevelState;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantLevelRow>> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`,
        [QUANT_LOCK_CLASSID, input.quantJobId],
      );
      const currentEpoch = await this.#currentEpochOn(tx, input.quantJobId);
      if (currentEpoch !== null && input.epoch.startedBlock <= currentEpoch.startedBlock) {
        const currentLevel = await tx.query<JobRowShape>(
          `/* quantLevels.getOne */ select ${LEVEL_COLUMNS} from quant_levels where quant_job_id = $1 and level_index = $2::int`,
          [input.quantJobId, input.levelIndex],
        );
        return { kind: "conflict" as const, record: currentLevel.rows[0] === undefined ? null : rowToLevel(currentLevel.rows[0]) };
      }
      const result = await tx.query<JobRowShape>(
        `/* quantLevels.retire */
         update quant_levels
         set state = 'retired', retired_json = $3, base_wei = 0,
             base_at_cycle_start_wei = 0, trigger_consecutive = 0, trigger_side = null,
             trigger_block_first = null, trigger_hash_first = null, trigger_at_first = null,
             seed_outcome = case when seed_pending then 'retired' else seed_outcome end,
             seed_pending = false, row_version = row_version + 1
         where quant_job_id = $1 and level_index = $2::int and state <> 'retired'
           and ($4::int is null or row_version = $4::int)
           and ($5::text is null or state = $5::text)
           and ($6::text is null or exists (select 1 from quant_actions
             where journal_key = $6 and quant_job_id = $1 and level_index = $2::int
               and state not in ('settled','failed','aborted')))
         returning ${LEVEL_COLUMNS}`,
        [input.quantJobId, input.levelIndex, input.retiredJson,
          input.expectedLevelRowVersion ?? null, input.expectedState ?? null, input.journalKey ?? null],
      );
      const row = result.rows[0];
      if (row === undefined) {
        const current = await tx.query<JobRowShape>(
          `/* quantLevels.getOne */
           select ${LEVEL_COLUMNS} from quant_levels
           where quant_job_id = $1 and level_index = $2::int`,
          [input.quantJobId, input.levelIndex],
        );
        const existing = current.rows[0];
        // Retirement is PERMANENT and IDEMPOTENT (R6.1): a second retire of a
        // level that is already retired is a no-op, not a conflict.
        if (existing !== undefined && String(existing["state"]) === "retired") {
          return { kind: "ok" as const, record: rowToLevel(existing) };
        }
        return {
          kind: "conflict" as const,
          record: existing === undefined ? null : rowToLevel(existing),
        };
      }
      await this.#openEpochOn(tx, {
        quantJobId: input.quantJobId,
        startedBlock: input.epoch.startedBlock,
        startedBlockHash: input.epoch.startedBlockHash,
        baselineUWei: input.epoch.baselineUWei,
        baselineWbnbWei: input.epoch.baselineWbnbWei,
        baselineNativeWei: input.epoch.baselineNativeWei,
        note: input.epoch.note,
        nowMs: input.nowMs,
      });
      await tx.query(
        `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
          row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
        [input.quantJobId, input.nowMs],
      );
      return { kind: "ok" as const, record: rowToLevel(row) };
    });
  }

  async openEpoch(input: {
    readonly quantJobId: string;
    readonly startedBlock: bigint;
    readonly startedBlockHash: Hex;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly note: string;
    readonly nowMs: number;
  }): Promise<QuantEpochRow> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      return this.#openEpochOn(tx, input);
    });
  }

  async #openEpochOn(sql: SqlClient, input: {
    readonly quantJobId: string;
    readonly startedBlock: bigint;
    readonly startedBlockHash: Hex | null;
    readonly baselineUWei: bigint;
    readonly baselineWbnbWei: bigint;
    readonly baselineNativeWei: bigint;
    readonly note: string;
    readonly nowMs: number;
  }): Promise<QuantEpochRow> {
    const prior = await sql.query<{ started_block: string }>(
      `/* quantEpochs.currentBlock */ select started_block from quant_epochs where quant_job_id = $1 order by epoch desc limit 1`,
      [input.quantJobId],
    );
    const priorBlock = prior.rows[0]?.started_block;
    if (priorBlock !== undefined && input.startedBlock <= BigInt(priorBlock)) {
      throw new Error("epoch-stale");
    }
    const result = await sql.query<JobRowShape>(
      `/* quantEpochs.open */
       insert into quant_epochs (quant_job_id, epoch, started_block, started_block_hash,
         baseline_u_wei, baseline_wbnb_wei, baseline_native_wei, note, created_at_ms, verified)
       select $1,
         coalesce((select max(epoch) from quant_epochs where quant_job_id = $1), 0) + 1,
         $2::numeric, $3, $4::numeric, $5::numeric, $6::numeric, $7, $8::bigint, $9::boolean
       returning quant_job_id, epoch, started_block, started_block_hash, baseline_u_wei,
         baseline_wbnb_wei, baseline_native_wei, note, created_at_ms, verified`,
      [
        input.quantJobId, input.startedBlock.toString(10), input.startedBlockHash,
        input.baselineUWei.toString(10), input.baselineWbnbWei.toString(10),
        input.baselineNativeWei.toString(10), input.note, input.nowMs, input.startedBlockHash !== null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("quant epoch insert produced no row.");
    await sql.query(
      `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
        row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
      [input.quantJobId, input.nowMs],
    );
    return rowToEpoch(row);
  }

  async currentEpoch(quantJobId: string): Promise<QuantEpochRow | null> {
    return this.#currentEpochOn(this.#sql, quantJobId);
  }

  async #currentEpochOn(sql: SqlClient, quantJobId: string): Promise<QuantEpochRow | null> {
    const result = await sql.query<JobRowShape>(
      `/* quantEpochs.current */
       select quant_job_id, epoch, started_block, started_block_hash, baseline_u_wei,
         baseline_wbnb_wei, baseline_native_wei, note, created_at_ms, verified
       from quant_epochs where quant_job_id = $1 order by epoch desc limit 1`,
      [quantJobId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToEpoch(row);
  }

  async listObservations(
    quantJobId: string, limit: number,
  ): Promise<readonly QuantObservation[]> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantObservations.list */
       select block_number, block_hash, observed_at_ms, mid_e18
       from quant_observations where quant_job_id = $1
       order by block_number desc limit $2::int`,
      [quantJobId, Math.max(1, limit)],
    );
    return result.rows
      .map((row) => ({
        blockNumber: num(row["block_number"]),
        blockHash: String(row["block_hash"]) as Hex,
        observedAtMs: int(row["observed_at_ms"]),
        midE18: num(row["mid_e18"]),
      }))
      .reverse();
  }

  async recordIndexerTrades(
    quantJobId: string,
    trades: readonly {
      readonly txHash: Hex; readonly direction: string;
      readonly amountIn: string; readonly amountOut: string;
      readonly blockTimeMs: number | null; readonly note: string | null;
    }[],
    nowMs: number,
  ): Promise<void> {
    for (const trade of trades) {
      await this.#sql.query(
        `/* quantIndexer.upsert */
         insert into quant_indexer_trades (quant_job_id, tx_hash, direction, amount_in,
           amount_out, block_time_ms, note, created_at_ms)
         values ($1, $2, $3, $4, $5, $6::bigint, $7, $8::bigint)
         on conflict (quant_job_id, tx_hash) do nothing`,
        [
          quantJobId, trade.txHash.toLowerCase(), trade.direction, trade.amountIn,
          trade.amountOut, trade.blockTimeMs, trade.note, nowMs,
        ],
      );
    }
  }

  async listIndexerTrades(quantJobId: string): Promise<readonly {
    readonly txHash: Hex; readonly direction: string;
    readonly amountIn: string; readonly amountOut: string;
    readonly blockTimeMs: number | null;
  }[]> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantIndexer.list */
       select tx_hash, direction, amount_in, amount_out, block_time_ms
       from quant_indexer_trades where quant_job_id = $1 order by tx_hash asc`,
      [quantJobId],
    );
    return result.rows.map((row) => ({
      txHash: String(row["tx_hash"]) as Hex,
      direction: String(row["direction"]),
      amountIn: String(row["amount_in"]),
      amountOut: String(row["amount_out"]),
      blockTimeMs: intOrNull(row["block_time_ms"]),
    }));
  }

  async recordReport(input: {
    readonly quantJobId: string;
    readonly payloadDigest: Hex;
    readonly responseStatus: number;
    readonly notesApplied: number | null;
    readonly nowMs: number;
  }): Promise<QuantReportRow> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_LOCK_CLASSID, input.quantJobId]);
      const result = await tx.query<JobRowShape>(
      `/* quantReports.insert */
       insert into quant_reports (quant_job_id, attempt, payload_digest, response_status,
         notes_applied, created_at_ms)
       select $1,
         coalesce((select max(attempt) from quant_reports where quant_job_id = $1), 0) + 1,
         $2, $3::int, $4::int, $5::bigint
       returning quant_job_id, attempt, payload_digest, response_status, notes_applied,
         created_at_ms`,
      [
        input.quantJobId, input.payloadDigest, input.responseStatus,
        input.notesApplied, input.nowMs,
      ],
      );
    const row = result.rows[0];
    if (row === undefined) throw new Error("quant report insert produced no row.");
      await tx.query(
      `/* quantJobs.bumpReportAttempts */
       update quant_jobs set report_attempts = report_attempts + 1,
         reported_at_ms = $2::bigint, report_payload_hash = $3, report_response_status = $4::int,
         row_version = row_version + 1, updated_at_ms = $2::bigint
       where quant_job_id = $1`,
      [input.quantJobId, input.nowMs, input.payloadDigest, input.responseStatus],
      );
    return {
      quantJobId: String(row["quant_job_id"]),
      attempt: int(row["attempt"]),
      payloadDigest: String(row["payload_digest"]) as Hex,
      responseStatus: int(row["response_status"]),
      notesApplied: intOrNull(row["notes_applied"]),
      createdAtMs: int(row["created_at_ms"]),
    };
    });
  }

  async listReports(quantJobId: string): Promise<readonly QuantReportRow[]> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantReports.list */
       select quant_job_id, attempt, payload_digest, response_status, notes_applied,
         created_at_ms
       from quant_reports where quant_job_id = $1 order by attempt asc`,
      [quantJobId],
    );
    return result.rows.map((row) => ({
      quantJobId: String(row["quant_job_id"]),
      attempt: int(row["attempt"]),
      payloadDigest: String(row["payload_digest"]) as Hex,
      responseStatus: int(row["response_status"]),
      notesApplied: intOrNull(row["notes_applied"]),
      createdAtMs: int(row["created_at_ms"]),
    }));
  }

  async recordRun(row: QuantRunRow): Promise<void> {
    await this.#sql.query(
      `/* quantRuns.insert */
       insert into quant_runs (run_id, started_at_ms, finished_at_ms, jobs_seen, actions,
         holds, errors, dry_run)
       values ($1, $2::bigint, $3::bigint, $4::int, $5::int, $6::int, $7::int, $8)
       on conflict (run_id) do nothing`,
      [
        row.runId, row.startedAtMs, row.finishedAtMs, row.jobsSeen, row.actions,
        row.holds, row.errors, row.dryRun,
      ],
    );
  }

  async withQuantFence<T>(
    quantJobId: string,
    work: (fence: QuantFence) => Promise<T>,
  ): Promise<T> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`,
        [QUANT_LOCK_CLASSID, quantJobId],
      );
      // BC31: every method below runs on the LOCK'S transaction, so an aborting
      // fence rolls its reads and its writes back together and no fence checks
      // out a second pool connection while holding its own.
      return work({
        getJob: (jobId) => this.#getJobOn(tx, jobId),
        listLevels: (jobId) => this.#listLevelsOn(tx, jobId),
        listNonTerminalActions: (jobId) => this.#listNonTerminalOn(tx, jobId),
        currentEpoch: (jobId) => this.#currentEpochOn(tx, jobId),
        listRecentBuys: async (jobId, sinceMs) => {
          const result = await tx.query<JobRowShape>(
            `/* quantActions.listRecentBuys */
             select ${ACTION_COLUMNS} from quant_actions
             where quant_job_id = $1 and side = 'buy' and created_at_ms >= $2::bigint
             order by created_at_ms asc`,
            [jobId, sinceMs],
          );
          return result.rows.map(rowToAction);
        },
        insertIntent: (input) => this.#insertIntentOn(tx, input),
        convertSeed: async (input) => {
          const result = await tx.query<JobRowShape>(
            `/* quantLevels.convertSeed */ update quant_levels
             set seed_pending = false, seed_outcome = 'converted', seed_note = seed_last_cause,
               hold_code = 'seed-window-expired', trigger_consecutive = 0, trigger_side = null,
               row_version = row_version + 1
             where quant_job_id = $1 and level_index = $2::int and state = 'armed-quote'
               and seed_pending and seed_refusals + seed_submissions >= $3::int
               and exists (select 1 from quant_jobs where quant_job_id = $1
                 and status = 'armed' and wire_state = 'compatible' and accounting_state = 'ok')
               and ($4::int is null or ladder_gen = $4::int)
               and exists (select 1 from quant_jobs where quant_job_id = $1
                 and ($5::text is null or params_digest = $5))
               and not exists (select 1 from quant_actions where quant_job_id = $1
                 and level_index = $2::int and state not in ('settled','failed','aborted'))
             returning ${LEVEL_COLUMNS}`,
            [input.quantJobId, input.levelIndex, input.seedWindowCycles, input.ladderGen ?? null, input.expectedProcessDigest ?? null],
          );
          const row = result.rows[0];
          return row === undefined ? { kind: "conflict" as const, record: null } : { kind: "ok" as const, record: rowToLevel(row) };
        },
        recordLevelOutcome: async (input) => {
          let counted = false;
          const levelBefore = (await this.#listLevelsOn(tx, input.quantJobId))
            .find((row) => row.levelIndex === input.levelIndex);
          const jobBefore = await this.#getJobOn(tx, input.quantJobId);
          if (jobBefore === null || levelBefore === undefined
            || jobBefore.status !== "armed" || jobBefore.admittedAtMs === null
            || jobBefore.wireState !== "compatible" || jobBefore.accountingState !== "ok"
            || levelBefore.state === "blocked" || levelBefore.state === "retired"
            || (input.ladderGen !== undefined && levelBefore.ladderGen !== input.ladderGen)
            || (input.acceptedBlock !== undefined && jobBefore.lastAcceptedBlock !== input.acceptedBlock)
            || (input.acceptedHash !== undefined && input.acceptedHash !== null
              && jobBefore.lastAcceptedHash?.toLowerCase() !== input.acceptedHash.toLowerCase())
            || (input.acceptedAtMs !== undefined && jobBefore.lastAcceptedAtMs !== input.acceptedAtMs)
            || (input.expectedProcessDigest !== undefined
              && jobBefore.paramsDigest?.toLowerCase() !== input.expectedProcessDigest.toLowerCase())) {
            return { kind: "conflict" as const, record: levelBefore === undefined ? null : levelBefore };
          }
          if (input.seedCounted && input.acceptedBlock !== undefined && input.acceptedBlock !== null
            && levelBefore?.seedPending === true) {
            const event = await tx.query<{ journal_key: string }>(
              `/* quantSeedEvents.refusal */ insert into quant_seed_events
               (quant_job_id, level_index, ladder_gen, accepted_block, kind, cause, journal_key, at_ms)
               values ($1, $2::int, $3::int, $4::numeric, 'refusal', $5, null, $6::bigint)
               on conflict do nothing returning journal_key`,
              [input.quantJobId, input.levelIndex, levelBefore.ladderGen,
                input.acceptedBlock.toString(10), input.cause ?? input.holdCode ?? "refusal", input.nowMs],
            );
            counted = event.rows.length > 0;
          }
          const result = await tx.query<JobRowShape>(
            `/* quantLevels.outcome */ update quant_levels
             set hold_code = $3, hold_count = case when $3::text is null then 0 else hold_count + 1 end,
               seed_refusals = case when $4::boolean and seed_pending then seed_refusals + 1 else seed_refusals end,
               seed_last_cause = case when $4::boolean and seed_pending then coalesce($6, $3) else seed_last_cause end,
               row_version = row_version + 1
             where quant_job_id = $1 and level_index = $2::int
               and state not in ('blocked','retired')
               and ($5::int is null or ladder_gen = $5::int)
               and ($4::boolean = false or $7::boolean)
               and ($8::numeric is null or exists (select 1 from quant_jobs
                 where quant_job_id = $1 and status = 'armed' and admitted_at_ms is not null
                   and wire_state = 'compatible' and accounting_state = 'ok'
                   and last_accepted_block = $8::numeric
                   and ($9::text is null or last_accepted_hash = $9)
                   and ($10::bigint is null or last_accepted_at_ms = $10::bigint)
                   and ($11::text is null or params_digest = $11)))
             returning ${LEVEL_COLUMNS}`,
            [input.quantJobId, input.levelIndex, input.holdCode, counted,
              input.ladderGen ?? null, input.cause ?? null, counted,
              input.acceptedBlock?.toString(10) ?? null, input.acceptedHash ?? null, input.acceptedAtMs ?? null,
              input.expectedProcessDigest ?? null],
          );
          const row = result.rows[0];
          return row === undefined
            ? { kind: "conflict" as const, record: levelBefore }
            : { kind: "ok" as const, record: rowToLevel(row) };
        },
        acceptObservation: (input) => this.#acceptObservationOn(tx, input),
        resetLatches: async (jobId, resetLevels = true) => {
          await tx.query(`/* quantJobs.resetLatches */ update quant_jobs set recenter_consecutive = 0,
            recenter_side = null, recenter_block_first = null, recenter_hash_first = null,
            recenter_at_first = null, row_version = row_version + 1 where quant_job_id = $1`, [jobId]);
          if (!resetLevels) return;
          await tx.query(`/* quantLevels.resetLatches */ update quant_levels set trigger_consecutive = 0,
            trigger_side = null, trigger_block_first = null, trigger_hash_first = null,
            trigger_at_first = null, row_version = row_version + 1 where quant_job_id = $1`, [jobId]);
        },
        recenterLadder: async (input) => {
          const job = await this.#getJobOn(tx, input.quantJobId);
          if (job === null || job.ladderGen !== input.expectedGeneration || job.lastAcceptedBlock !== input.observationBlock) {
            return { kind: "conflict" as const, record: job };
          }
          const oldLevels = await this.#listLevelsOn(tx, input.quantJobId);
          const oldUpper = oldLevels.find((level) => level.levelIndex === job.levels);
          const pending = await this.#listNonTerminalOn(tx, input.quantJobId);
          const nowSec = Math.floor(input.nowMs / 1_000);
          const cooldownFrom = job.lastRecenterAtMs ?? job.admittedAtMs ?? input.nowMs;
          const valid = job.status === "armed" && job.ladderGen === input.expectedGeneration
            && job.lastAcceptedBlock === input.observationBlock
            && job.lastAcceptedHash?.toLowerCase() === input.observationHash.toLowerCase()
            && job.lastAcceptedAtMs === input.observationAtMs
            && job.recenterConsecutive >= 2 && job.recenterSide === input.side
            && job.recenters < job.recenterBudget
            && input.nowMs - cooldownFrom >= (input.cooldownSec ?? 86_400) * 1_000
            && (job.endsAtMs === null || job.endsAtMs > input.nowMs)
            && (job.sessionExpiresAtMs === null || job.sessionExpiresAtMs > input.nowMs)
            && job.sessionExpiry !== null && job.sessionExpiry > nowSec
            && job.revokedAtMs === null
            && job.wireState === "compatible" && job.accountingState === "ok"
            && (input.expectedWallet === undefined || job.tradingWallet.toLowerCase() === input.expectedWallet.toLowerCase())
            && (input.expectedProcessDigest === undefined || job.paramsDigest?.toLowerCase() === input.expectedProcessDigest.toLowerCase())
            && oldLevels.length === job.levels
            && oldLevels.every((level) => level.levelIndex >= 1 && level.levelIndex <= job.levels)
            && new Set(oldLevels.map((level) => level.levelIndex)).size === job.levels
            && oldLevels.every((level) => level.state !== "blocked" && level.state !== "retired" && !level.seedPending)
            && pending.length === 0
            && input.newBuyPrice.length === job.levels + 1
            && input.newSellPrice.length === job.levels + 1
            && input.newAnchorE18 > 0n
            && input.newBuyPrice[0] === input.newAnchorE18
            && input.newBuyPrice.every((price, index) => index <= job.levels && price > 0n)
            && input.newSellPrice[0] === 0n
            && input.newSellPrice.every((price, index) => index === 0 || (index <= job.levels && price > (input.newBuyPrice[index] ?? 0n)))
            && (!input.reseed || input.side === "up");
          if (!valid) return { kind: "conflict" as const, record: job };
          const result = await tx.query<JobRowShape>(
            `/* quantJobs.recenter */ update quant_jobs set anchor_e18 = $2::numeric,
             ladder_gen = ladder_gen + 1, recenters = recenters + 1, last_recenter_at_ms = $3::bigint,
             recenter_consecutive = 0, recenter_side = null, recenter_block_first = null,
             recenter_hash_first = null, recenter_at_first = null, hold_code = null,
             accounting_rev = accounting_rev + 1, row_version = row_version + 1, updated_at_ms = $3::bigint
             where quant_job_id = $1 and status = 'armed' and ladder_gen = $4::int
             returning ${JOB_COLUMNS}`,
            [input.quantJobId, input.newAnchorE18.toString(10), input.nowMs, input.expectedGeneration],
          );
          if (result.rows.length === 0) return { kind: "conflict" as const, record: job };
          for (const level of await this.#listLevelsOn(tx, input.quantJobId)) {
            await tx.query(
              `/* quantLevels.recenter */ update quant_levels set buy_price_e18 = $3::numeric,
                sell_price_e18 = $4::numeric, ladder_gen = $5::int, trigger_consecutive = 0,
                trigger_side = null, trigger_block_first = null, trigger_hash_first = null,
                trigger_at_first = null, hold_code = null, hold_count = 0,
                seed_pending = case when $6::boolean and $2::int = $7::int and state = 'armed-quote' then true else seed_pending end,
                seed_refusals = case when $6::boolean and $2::int = $7::int and state = 'armed-quote' then 0 else seed_refusals end,
                seed_submissions = case when $6::boolean and $2::int = $7::int and state = 'armed-quote' then 0 else seed_submissions end,
                seed_last_cause = case when $6::boolean and $2::int = $7::int and state = 'armed-quote' then null else seed_last_cause end,
                seed_outcome = case when $6::boolean and $2::int = $7::int and state = 'armed-quote' then null else seed_outcome end,
                seed_note = case when $6::boolean and $2::int = $7::int and state = 'armed-quote' then null else seed_note end,
                row_version = row_version + 1 where quant_job_id = $1 and level_index = $2::int`,
              [input.quantJobId, level.levelIndex, input.newBuyPrice[level.levelIndex]?.toString(10) ?? "0",
                input.newSellPrice[level.levelIndex]?.toString(10) ?? "0", input.expectedGeneration + 1,
                input.reseed && input.side === "up", job.levels],
            );
          }
          await tx.query(
            `/* quantRecenters.insert */ insert into quant_recenters
             (quant_job_id, seq, at_ms, block_number, block_hash, direction, from_gen, to_gen,
              old_anchor_e18, new_anchor_e18, old_lines_json, new_lines_json, upper_prior_json,
              reseed_scheduled, cause, evidence_block_1, evidence_block_2, evidence_hash_1, evidence_hash_2,
              evidence_at_1, evidence_at_2)
             values ($1, coalesce((select max(seq) from quant_recenters where quant_job_id = $1),0)+1,
              $2::bigint, $3::numeric, $4, $5, $6::int, $7::int, $8::numeric, $9::numeric,
              $10, $11, $12, $13::boolean, $14, $15::numeric, $16::numeric, $17, $18, $19::bigint, $20::bigint)`,
            [input.quantJobId, input.nowMs, input.observationBlock, input.observationHash, input.side,
              job.ladderGen, job.ladderGen + 1, job.anchorE18.toString(10), input.newAnchorE18.toString(10),
              JSON.stringify(oldLevels.map((level) => ({ index: level.levelIndex, buy: level.buyPriceE18.toString(10), sell: level.sellPriceE18.toString(10) }))),
              JSON.stringify({ buy: input.newBuyPrice.map((v) => v.toString(10)), sell: input.newSellPrice.map((v) => v.toString(10)) }),
              JSON.stringify({ v: 1, state: oldUpper?.state ?? "armed-quote", seedPending: oldUpper?.seedPending ?? false,
                seedRefusals: oldUpper?.seedRefusals ?? 0, seedSubmissions: oldUpper?.seedSubmissions ?? 0,
                seedOutcome: oldUpper?.seedOutcome ?? null, seedNote: oldUpper?.seedNote ?? null,
                seedLastCause: oldUpper?.seedLastCause ?? null }),
              input.reseed && input.side === "up" && oldUpper?.state === "armed-quote",
              input.cause, job.recenterBlockFirst ?? input.observationBlock, input.observationBlock,
              job.recenterHashFirst, input.observationHash, job.recenterAtFirst, input.observationAtMs],
          );
          return { kind: "ok" as const, record: rowToJob(result.rows[0]!) };
        },
        setAccountingState: async (input) => {
          const result = await tx.query<JobRowShape>(
            `/* quantJobs.accountingState */ update quant_jobs set accounting_state = $2,
             accounting_epoch = $3::int, accounting_evidence_json = $4,
             accounting_rev = accounting_rev + 1, row_version = row_version + 1,
             updated_at_ms = $5::bigint where quant_job_id = $1 returning ${JOB_COLUMNS}`,
            [input.quantJobId, input.state, input.epoch, input.evidenceJson, input.nowMs],
          );
          return result.rows[0] === undefined ? null : rowToJob(result.rows[0]);
        },
        publishAccountingVerdict: async (input) => {
          const result = await tx.query(
            `/* quantJobs.publishAccounting */ update quant_jobs set
             accounting_state = case when $5::boolean then accounting_state else 'external-activity' end,
             accounting_epoch = $3::int,
             accounting_evidence_json = case when not $5::boolean then $6
               when accounting_state = 'ok' then $6 else accounting_evidence_json end,
             hold_code = case when $5::boolean then hold_code else 'external-activity' end,
             accounting_rev = accounting_rev + 1,
             row_version = row_version + 1, updated_at_ms = $7::bigint
             where quant_job_id = $1 and accounting_rev = $2::bigint
               and accounting_epoch = $3::int and last_accepted_block = $4::numeric
               and $8::text is not null
               and exists (select 1 from quant_epochs where quant_job_id = $1
                 and epoch = $3::int and started_block_hash = $8)
               and $9::text is not null and last_accepted_hash = $9
             returning quant_job_id`,
            [input.quantJobId, input.expectedAccountingRev.toString(10), input.expectedEpoch,
              input.observationBlock.toString(10), input.admissible, input.evidenceJson, input.nowMs,
              input.expectedEpochHash ?? null, input.observationHash ?? null],
          );
          return result.rows.length === 0 ? { ok: false, reason: "reconcile-stale" as const } : { ok: true };
        },
        publishTruthVerdict: async (input) => {
          const result = await tx.query(
            `/* quantJobs.publishTruth */ update quant_jobs set
             accounting_state = case when $4::boolean then accounting_state else 'external-activity' end,
             accounting_epoch = $3::int,
             accounting_evidence_json = case when not $4::boolean then $5
               when accounting_state = 'ok' then $5 else accounting_evidence_json end,
             hold_code = case when $4::boolean then hold_code else 'external-activity' end,
             accounting_rev = accounting_rev + 1,
             row_version = row_version + 1, updated_at_ms = $6::bigint
             where quant_job_id = $1 and accounting_rev = $2::bigint
               and accounting_epoch = $3::int and $7::text is not null
               and exists (select 1 from quant_epochs where quant_job_id = $1
                 and epoch = $3::int and started_block_hash = $7)
             returning quant_job_id`,
            [input.quantJobId, input.expectedAccountingRev.toString(10), input.expectedEpoch,
              input.admissible, input.evidenceJson, input.nowMs, input.expectedEpochHash ?? null],
          );
          return result.rows.length === 0 ? { ok: false, reason: "reconcile-stale" as const } : { ok: true };
        },
        setLevelTrigger: async (input) => {
          await tx.query(
            `/* quantLevels.setTrigger */
             update quant_levels
             set trigger_consecutive = $3::int, trigger_side = $4,
                 row_version = row_version + 1
             where quant_job_id = $1 and level_index = $2::int`,
            [input.quantJobId, input.levelIndex, input.consecutive, input.side],
          );
        },
        setLevelHold: async (input) => {
          await tx.query(
            `/* quantLevels.setHold */
             update quant_levels
             set hold_code = $3,
                 hold_count = case when $3::text is null then 0 else hold_count + 1 end,
                 row_version = row_version + 1
             where quant_job_id = $1 and level_index = $2::int`,
            [input.quantJobId, input.levelIndex, input.holdCode],
          );
        },
        setJobHold: async (input) => {
          await tx.query(
            `/* quantJobs.setHold */
             update quant_jobs
             set hold_code = $2,
                 hold_count = case when $2::text is null then 0 else hold_count + 1 end,
             row_version = row_version + 1
             where quant_job_id = $1`,
            [input.quantJobId, input.holdCode],
          );
        },
        recordObservation: async (input) => {
          await tx.query(
            `/* quantObservations.insert */
             insert into quant_observations (quant_job_id, block_number, block_hash,
               observed_at_ms, mid_e18)
             values ($1, $2::numeric, $3, $4::bigint, $5::numeric)
             on conflict (quant_job_id, block_number) do nothing`,
            [
              input.quantJobId, input.observation.blockNumber.toString(10),
              input.observation.blockHash, input.observation.observedAtMs,
              input.observation.midE18.toString(10),
            ],
          );
          await tx.query(
            `/* quantObservations.trim */
             delete from quant_observations
             where quant_job_id = $1 and block_number not in (
               select block_number from quant_observations where quant_job_id = $1
               order by block_number desc limit 8
             )`,
            [input.quantJobId],
          );
          await tx.query(
            `/* quantJobs.setObserved */
             update quant_jobs
             set last_observed_block = $2::numeric, last_observed_hash = $3,
                 stale_observations = 0, row_version = row_version + 1
             where quant_job_id = $1`,
            [
              input.quantJobId, input.observation.blockNumber.toString(10),
              input.observation.blockHash,
            ],
          );
        },
        markStaleObservation: async (jobId, stale) => {
          await tx.query(
            `/* quantJobs.setStale */
             update quant_jobs set stale_observations = $2::int, row_version = row_version + 1
             where quant_job_id = $1`,
            [jobId, stale],
          );
        },
      });
    });
  }

  async #acceptObservationOn(
    sql: SqlClient,
    input: {
      readonly quantJobId: string;
      readonly observation: QuantObservation;
      readonly intervalMs: number;
      readonly processDigest?: Hex;
    },
  ): Promise<QuantObservationAcceptance> {
    const before = await this.#getJobOn(sql, input.quantJobId);
    if (before === null) throw new Error("quant job not found");
    const obs = input.observation;
    const newerObserved = before.lastObservedBlock === null || obs.blockNumber > before.lastObservedBlock;
    const newerAccepted = before.lastAcceptedBlock === null || obs.blockNumber > before.lastAcceptedBlock;
    const spaced = before.lastAcceptedAtMs === null
      || obs.observedAtMs - before.lastAcceptedAtMs >= input.intervalMs;
    const stale = newerObserved ? 0 : before.staleObservations + 1;
    await sql.query(
      `/* quantObservations.insert */ insert into quant_observations
       (quant_job_id, block_number, block_hash, observed_at_ms, mid_e18)
       values ($1, $2::numeric, $3, $4::bigint, $5::numeric)
       on conflict (quant_job_id, block_number) do nothing`,
      [input.quantJobId, obs.blockNumber.toString(10), obs.blockHash, obs.observedAtMs, obs.midE18.toString(10)],
    );
    await sql.query(
      `/* quantObservations.trim */ delete from quant_observations
       where quant_job_id = $1 and block_number not in (
         select block_number from quant_observations where quant_job_id = $1
         order by block_number desc limit 8)`, [input.quantJobId],
    );
    const paramsChanged = input.processDigest !== undefined
      && before.paramsDigest?.toLowerCase() !== input.processDigest.toLowerCase();
    const live = before.status === "armed" && before.admittedAtMs !== null
      && before.wireState === "compatible" && before.accountingState === "ok"
      && !paramsChanged
      && before.revokedAtMs === null
      && (before.endsAtMs === null || before.endsAtMs > obs.observedAtMs);
    const refusalReason = before.status === "paused" ? "paused"
      : before.wireState === "changed" ? "wire-changed"
        : before.accountingState === "external-activity" ? "external-activity"
          : paramsChanged ? "params-changed"
            : before.revokedAtMs !== null ? "revoked"
              : before.status === "ended" || before.status === "ended-unresolved" || before.status === "reported"
                || (before.endsAtMs !== null && before.endsAtMs <= obs.observedAtMs) ? "ended"
                : undefined;
    const accepted = newerObserved && newerAccepted && spaced && live;
    await sql.query(
      `/* quantJobs.setObserved */ update quant_jobs set
       last_observed_block = case when last_observed_block is null or $2::numeric > last_observed_block then $2::numeric else last_observed_block end,
       last_observed_hash = case when last_observed_block is null or $2::numeric > last_observed_block then $3 else last_observed_hash end,
       last_observed_at_ms = case when last_observed_block is null or $2::numeric > last_observed_block then $4::bigint else last_observed_at_ms end,
       stale_observations = $5::int, row_version = row_version + 1 where quant_job_id = $1`,
      [input.quantJobId, obs.blockNumber.toString(10), obs.blockHash, obs.observedAtMs, stale],
    );
    if (!accepted) {
      if (!newerObserved && stale >= 2) {
        await sql.query(
          `/* quantJobs.resetLatches */ update quant_jobs set recenter_consecutive = 0,
           recenter_side = null, recenter_block_first = null, recenter_hash_first = null,
           recenter_at_first = null, row_version = row_version + 1 where quant_job_id = $1`, [input.quantJobId],
        );
        await sql.query(
          `/* quantLevels.resetLatches */ update quant_levels set trigger_consecutive = 0,
           trigger_side = null, trigger_block_first = null, trigger_hash_first = null,
           trigger_at_first = null, row_version = row_version + 1 where quant_job_id = $1`, [input.quantJobId],
        );
      }
      const job = await this.#getJobOn(sql, input.quantJobId);
      if (job === null) throw new Error("quant job not found");
      return {
        accepted: false,
        [QUANT_ACCEPTED_SNAPSHOT]: true,
        reason: !newerObserved && stale >= 2 ? "stale-outage"
          : !live && refusalReason !== undefined ? refusalReason
            : !newerObserved ? "not-newer" : "spacing",
        observation: obs, job, levels: await this.#listLevelsOn(sql, input.quantJobId),
      };
    }
    const levels = await this.#listLevelsOn(sql, input.quantJobId);
    const top = levels.find((row) => row.levelIndex === before.levels);
    const bottom = levels.find((row) => row.levelIndex === Math.max(1, before.levels - 1));
    const jobSide: QuantRecenterSide | null = top !== undefined && bottom !== undefined
      ? obs.midE18 > top.sellPriceE18 ? "up" : obs.midE18 < bottom.buyPriceE18 ? "down" : null
      : null;
    const sameJobSide = jobSide !== null && jobSide === before.recenterSide;
    const recenterConsecutive = jobSide === null ? 0 : sameJobSide ? before.recenterConsecutive + 1 : 1;
    const recenterBlockFirst = jobSide === null ? null : sameJobSide && before.recenterBlockFirst !== null ? before.recenterBlockFirst : obs.blockNumber;
    const recenterHashFirst = jobSide === null ? null : sameJobSide && before.recenterHashFirst !== null ? before.recenterHashFirst : obs.blockHash;
    const recenterAtFirst = jobSide === null ? null : sameJobSide && before.recenterAtFirst !== null ? before.recenterAtFirst : obs.observedAtMs;
    await sql.query(
      `/* quantJobs.acceptEvidence */ update quant_jobs set
       last_accepted_block = $2::numeric, last_accepted_hash = $3, last_accepted_at_ms = $4::bigint,
       recenter_consecutive = $5::int, recenter_side = $6, recenter_block_first = $7::numeric,
       recenter_hash_first = $8, recenter_at_first = $9::bigint, stale_observations = 0,
       row_version = row_version + 1 where quant_job_id = $1`,
      [input.quantJobId, obs.blockNumber.toString(10), obs.blockHash, obs.observedAtMs,
        recenterConsecutive, jobSide, recenterBlockFirst?.toString(10) ?? null,
        recenterHashFirst, recenterAtFirst],
    );
    for (const level of levels) {
      if (level.state === "blocked" || level.state === "retired" || level.seedPending) continue;
      const side: QuantSide | null = level.state === "holding-base"
        ? obs.midE18 > level.sellPriceE18 ? "sell" : null
        : obs.midE18 < level.buyPriceE18 ? "buy" : null;
      const same = side !== null && level.triggerSide === side;
      const consecutive = side === null ? 0 : same ? level.triggerConsecutive + 1 : 1;
      const first = side === null ? null : same && level.triggerBlockFirst !== null ? level.triggerBlockFirst : obs.blockNumber;
      const firstHash = side === null ? null : same && level.triggerHashFirst !== null ? level.triggerHashFirst : obs.blockHash;
      const firstAt = side === null ? null : same && level.triggerAtFirst !== null ? level.triggerAtFirst : obs.observedAtMs;
      await sql.query(
        `/* quantLevels.acceptEvidence */ update quant_levels set trigger_consecutive = $3::int,
         trigger_side = $4, trigger_block_first = $5::numeric, trigger_hash_first = $6,
         trigger_at_first = $7::bigint, row_version = row_version + 1
         where quant_job_id = $1 and level_index = $2::int and ladder_gen = $8::int
           and state not in ('blocked','retired') and not seed_pending`,
        [input.quantJobId, level.levelIndex, consecutive, side,
          first?.toString(10) ?? null, firstHash, firstAt, level.ladderGen],
      );
    }
    const job = await this.#getJobOn(sql, input.quantJobId);
    if (job === null) throw new Error("quant job not found");
    return { accepted: true, [QUANT_ACCEPTED_SNAPSHOT]: true, observation: obs, job, levels: await this.#listLevelsOn(sql, input.quantJobId) };
  }

  async #insertIntentOn(
    sql: SqlClient, input: InsertQuantIntentInput,
  ): Promise<QuantCasResult<QuantActionRow>> {
    const jobResult = await sql.query<JobRowShape>(
      `/* quantJobs.get */ select ${JOB_COLUMNS} from quant_jobs where quant_job_id = $1`,
      [input.quantJobId],
    );
    const job = jobResult.rows[0] === undefined ? null : rowToJob(jobResult.rows[0]);
    const evidence = input.evidence ?? { kind: "crossing" as const, first: input.triggerBlock1, second: input.triggerBlock2 };
    const evidenceKind = input.evidence?.kind ?? null;
    const ladderGen = input.ladderGen ?? 0;
    if (job === null || job.status !== "armed" || job.wireState !== "compatible"
      || job.accountingState !== "ok"
      || (input.plannedWallet !== undefined && job.tradingWallet.toLowerCase() !== input.plannedWallet.toLowerCase())
      || (input.plannedProcessDigest !== undefined && job.paramsDigest?.toLowerCase() !== input.plannedProcessDigest.toLowerCase())
      || (input.planObservationBlock !== undefined && job.lastAcceptedBlock !== input.planObservationBlock)
      || (input.planObservationHash !== undefined && job.lastAcceptedHash?.toLowerCase() !== input.planObservationHash.toLowerCase())
      || (input.planObservationAtMs !== undefined && job.lastAcceptedAtMs !== input.planObservationAtMs)
      || (input.plannedAccountingRev !== undefined && job.accountingRev !== input.plannedAccountingRev)
      || (input.plannedAccountingEpoch !== undefined && job.accountingEpoch !== input.plannedAccountingEpoch)) {
      return { kind: "conflict", record: null };
    }
    if (input.requiredNativeWei !== undefined && input.preNativeWei < input.requiredNativeWei) {
      return { kind: "conflict", record: null };
    }
    if (input.preNativeBlock !== undefined && input.preNativeBlock !== null
      && input.maxQuoteLagBlocks !== undefined && input.quoteBlock >= input.preNativeBlock
      && input.quoteBlock - input.preNativeBlock > BigInt(input.maxQuoteLagBlocks)) {
      return { kind: "conflict", record: null };
    }
    if (isR14ParamsJson(job?.paramsJson ?? null) && !hasR14FeeEvidence(input)) {
      return { kind: "conflict", record: null };
    }
    if (input.side === "buy") {
      const priorActions = await sql.query<JobRowShape>(
        `/* quantActions.budgetOnFence */ select ${ACTION_COLUMNS} from quant_actions where quant_job_id = $1`,
        [input.quantJobId],
      );
      let reserved = 0n;
      for (const row of priorActions.rows.map(rowToAction)) {
        if (row.side !== "buy") continue;
        if (!TERMINAL_ACTIONS.has(row.state)) {
          if (input.nowMs <= row.deadlineSec * 1_000 + 86_400_000) reserved += row.amountInWei;
        } else if (row.state === "settled" && row.fillInWei !== null) {
          const at = row.executedAtSec === null ? row.updatedAtMs : Number(row.executedAtSec) * 1_000;
          if (input.nowMs - at < 86_400_000) reserved += row.fillInWei;
        }
      }
      if (reserved + input.amountInWei > job.dailyCapUWei) return { kind: "conflict", record: null };
    }
    const action = await sql.query<JobRowShape>(
      `/* quantActions.insertIntent */
       insert into quant_actions (journal_key, quant_job_id, level_index, action_seq, side,
         state, prior_level_state, amount_in_wei, min_out_wei, quote_out_wei, quote_block,
         trigger_block_1, trigger_block_2, deadline_sec, calls_json, note, impact_bps,
         pre_u_wei, pre_wbnb_wei, pre_native_wei, pre_native_block, basis_u_wei, base_at_cycle_start_wei,
         ladder_gen, evidence_kind, required_native_wei, gas_price_wei, fee_est_wei,
         created_at_ms, updated_at_ms, row_version)
       values ($1, $2, $3::int, $4::int, $5, 'intended', $6, $7::numeric, $8::numeric,
         $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::bigint, $14, $15,
         $16::int, $17::numeric, $18::numeric, $19::numeric, $20::numeric, $21::numeric, $22::numeric,
         $23::int, $24, $25::numeric, $26::numeric, $27::numeric, $28::bigint, $28::bigint, 1)
       on conflict (journal_key) do nothing
       returning ${ACTION_COLUMNS}`,
      [
        input.journalKey, input.quantJobId, input.levelIndex, input.actionSeq, input.side,
        input.priorLevelState, input.amountInWei.toString(10), input.minOutWei.toString(10),
        input.quoteOutWei.toString(10), input.quoteBlock.toString(10),
        evidence.kind === "seed" ? evidence.accepted.toString(10) : evidence.first.toString(10),
        evidence.kind === "seed" ? evidence.accepted.toString(10) : evidence.second.toString(10),
        input.deadlineSec, input.callsJson, input.note, input.impactBps,
        input.preUWei.toString(10), input.preWbnbWei.toString(10), input.preNativeWei.toString(10),
        input.preNativeBlock === undefined || input.preNativeBlock === null ? null : input.preNativeBlock.toString(10),
        input.basisUWei.toString(10), input.baseAtCycleStartWei.toString(10), ladderGen,
        evidence.kind, input.requiredNativeWei === undefined ? null : input.requiredNativeWei.toString(10),
        input.gasPriceWei === undefined || input.gasPriceWei === null ? null : input.gasPriceWei.toString(10),
        input.feeEstWei === undefined || input.feeEstWei === null ? null : input.feeEstWei.toString(10),
        input.nowMs,
      ],
    );
    if (action.rows.length === 0) {
      return { kind: "conflict", record: null };
    }
    const level = await sql.query<JobRowShape>(
      `/* quantLevels.block */
       update quant_levels
       set state = 'blocked', prior_state = $3, action_seq = $4::int,
           last_action_at_ms = $5::bigint, trigger_consecutive = 0, trigger_side = null,
           trigger_block_first = null, trigger_hash_first = null, trigger_at_first = null,
           hold_code = null, hold_count = 0, row_version = row_version + 1
         where quant_job_id = $1 and level_index = $2::int and row_version = $6::int
         and ladder_gen = $7::int and state = $3 and state not in ('retired','blocked')
         and action_seq + 1 = $15::int
         and $8::text = 'armed'
         and ($9::numeric is null or buy_price_e18 = $9::numeric)
         and ($10::numeric is null or sell_price_e18 = $10::numeric)
         and ($11::numeric is null or trigger_block_first = $11::numeric)
         and ($12::text is null or
           ($12::text = 'seed' and seed_pending and seed_refusals + seed_submissions < $13::int)
           or ($12::text = 'crossing' and trigger_consecutive >= 2 and trigger_side = $14))
       returning ${LEVEL_COLUMNS}`,
      [
        input.quantJobId, input.levelIndex, input.priorLevelState, input.actionSeq,
        input.nowMs, input.expectedLevelRowVersion, ladderGen, job.status,
        input.plannedBuyPriceE18 ?? null, input.plannedSellPriceE18 ?? null,
        input.planTriggerFirst ?? null, evidenceKind, input.seedWindowCycles ?? 9,
        input.side, input.actionSeq,
      ],
    );
    if (level.rows.length === 0) {
      await sql.query(`/* quantActions.rollbackIntent */ delete from quant_actions where journal_key = $1`, [input.journalKey]);
      return { kind: "conflict", record: null };
    }
    if (job !== null) {
      await sql.query(
        `/* quantJobs.accountingRev */ update quant_jobs set accounting_rev = accounting_rev + 1,
           row_version = row_version + 1, updated_at_ms = $2::bigint where quant_job_id = $1`,
        [input.quantJobId, input.nowMs],
      );
    }
    return { kind: "ok", record: rowToAction(action.rows[0]!) };
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

/**
 * Postgres when `DATABASE_URL` is set, memory otherwise.
 *
 * The WORKER refuses to run on the memory backend (`resolveQuantRuntimeConfig`
 * requires `DATABASE_URL`): the store IS the worker's queue, and a queue that
 * dies with the process cannot own a submitted intent.
 */
export async function createQuantJobStore(): Promise<QuantJobStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresQuantJobStore.create(sql);
    console.log("[quant-job-store] backend=postgres");
    return store;
  }
  console.log("[quant-job-store] backend=memory (DATABASE_URL not set)");
  return new MemoryQuantJobStore();
}
