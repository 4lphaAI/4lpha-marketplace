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
  QuantSide,
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
};

export type QuantLevelRow = {
  readonly quantJobId: string;
  readonly levelIndex: number;
  readonly state: QuantLevelState;
  /** WRITE-ONCE. A re-anchor is a new job on TermiX, never a mutation. */
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
  readonly levels: readonly {
    readonly levelIndex: number;
    readonly buyPriceE18: bigint;
    readonly sellPriceE18: bigint;
  }[];
  readonly clipUWei: bigint;
  readonly idleUWei: bigint;
  readonly baselineUWei: bigint;
  readonly baselineWbnbWei: bigint;
  readonly baselineNativeWei: bigint;
  readonly nowMs: number;
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
  readonly basisUWei: bigint;
  readonly baseAtCycleStartWei: bigint;
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
  readonly nowMs: number;
};

export type QuantCasResult<T> =
  | { readonly kind: "ok"; readonly record: T }
  | { readonly kind: "conflict"; readonly record: T | null };

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
  currentEpoch(quantJobId: string): Promise<QuantEpochRow | null>;
  listRecentBuys(quantJobId: string, sinceMs: number): Promise<readonly QuantActionRow[]>;
  insertIntent(input: InsertQuantIntentInput): Promise<QuantCasResult<QuantActionRow>>;
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
    readonly status?: QuantJobStatus;
  }): Promise<void>;
  recordObservation(input: {
    readonly quantJobId: string;
    readonly observation: QuantObservation;
  }): Promise<void>;
  markStaleObservation(quantJobId: string, stale: number): Promise<void>;
};

export interface QuantJobStore {
  discoverJob(input: DiscoverQuantJobInput): Promise<QuantJobRow>;
  updateJobWire(input: UpdateQuantJobWireInput): Promise<QuantJobRow | null>;
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
  setJobStatus(input: {
    readonly quantJobId: string;
    readonly status: QuantJobStatus;
    readonly holdCode?: QuantHoldCode | null;
    readonly nowMs: number;
  }): Promise<void>;
  listLevels(quantJobId: string): Promise<readonly QuantLevelRow[]>;
  listActions(quantJobId: string): Promise<readonly QuantActionRow[]>;
  listNonTerminalActions(quantJobId: string): Promise<readonly QuantActionRow[]>;
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
  "discovered", "armed", "held", "ended", "ended-unresolved",
]);

const TERMINAL_ACTIONS: ReadonlySet<QuantActionState> = new Set<QuantActionState>([
  "settled", "failed", "aborted",
]);

/* -------------------------------------------------------------------------- */
/* Memory backend (tests only — the worker requires DATABASE_URL)             */
/* -------------------------------------------------------------------------- */

export class MemoryQuantJobStore implements QuantJobStore {
  readonly #jobs = new Map<string, QuantJobRow>();
  readonly #levels = new Map<string, QuantLevelRow>();
  readonly #actions = new Map<string, QuantActionRow>();
  readonly #epochs = new Map<string, QuantEpochRow[]>();
  readonly #observations = new Map<string, QuantObservation[]>();
  readonly #indexer = new Map<string, Map<string, {
    txHash: Hex; direction: string; amountIn: string; amountOut: string;
    blockTimeMs: number | null;
  }>>();
  readonly #reports = new Map<string, QuantReportRow[]>();
  readonly #runs: QuantRunRow[] = [];
  readonly #ownership = new Set<string>();
  readonly #locks = new Map<string, Promise<unknown>>();

  #levelKey(jobId: string, index: number): string {
    return `${jobId}#${index}`;
  }

  async discoverJob(input: DiscoverQuantJobInput): Promise<QuantJobRow> {
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
    };
    this.#jobs.set(row.quantJobId, row);
    return structuredClone(row);
  }

  async updateJobWire(input: UpdateQuantJobWireInput): Promise<QuantJobRow | null> {
    const existing = this.#jobs.get(input.quantJobId);
    if (existing === undefined) return null;
    // QUANT-SELFTEST R7: a wire record naming a DIFFERENT strategy than the one
    // this row was discovered/admitted under is REFUSED — none of its fields
    // are applied — and the caller holds the job. Write-once from '' only.
    if (existing.strategyId !== "" && existing.strategyId !== input.strategyId) return null;
    const next: QuantJobRow = {
      ...existing,
      strategyId: existing.strategyId === "" ? input.strategyId : existing.strategyId,
      tradingWallet: getAddress(input.tradingWallet),
      allocationUWei: input.allocationUWei,
      dailyCapUWei: input.dailyCapUWei,
      termDays: input.termDays,
      startedAtMs: input.startedAtMs,
      endsAtMs: input.endsAtMs,
      sessionExpiresAtMs: input.sessionExpiresAtMs,
      revokedAtMs: input.revokedAtMs,
      lastJobReadAtMs: input.nowMs,
      rowVersion: existing.rowVersion + 1,
      updatedAtMs: input.nowMs,
    };
    this.#jobs.set(next.quantJobId, next);
    return structuredClone(next);
  }

  async replaceEnvelope(quantJobId: string, envelopeJson: string, nowMs: number): Promise<void> {
    const existing = this.#jobs.get(quantJobId);
    if (existing === undefined) return;
    this.#jobs.set(quantJobId, {
      ...existing, envelopeJson, rowVersion: existing.rowVersion + 1, updatedAtMs: nowMs,
    });
  }

  async admitJob(input: AdmitQuantJobInput): Promise<QuantCasResult<QuantJobRow>> {
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
      });
    }
    await this.openEpoch({
      quantJobId: input.quantJobId,
      startedBlock: input.armBlock,
      startedBlockHash: `0x${"0".repeat(64)}` as Hex,
      baselineUWei: input.baselineUWei,
      baselineWbnbWei: input.baselineWbnbWei,
      baselineNativeWei: input.baselineNativeWei,
      note: "arm",
      nowMs: input.nowMs,
    });
    return { kind: "ok", record: structuredClone(next) };
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
    return (await this.listJobs()).filter((row) =>
      WORKABLE.has(row.status) && row.strategyId === strategyId);
  }

  async setJobStatus(input: {
    readonly quantJobId: string;
    readonly status: QuantJobStatus;
    readonly holdCode?: QuantHoldCode | null;
    readonly nowMs: number;
  }): Promise<void> {
    const existing = this.#jobs.get(input.quantJobId);
    if (existing === undefined) return;
    this.#jobs.set(input.quantJobId, {
      ...existing,
      status: input.status,
      ...(input.holdCode === undefined ? {} : { holdCode: input.holdCode }),
      ...(input.status === "reported" ? { reportedAtMs: input.nowMs } : {}),
      rowVersion: existing.rowVersion + 1,
      updatedAtMs: input.nowMs,
    });
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
    return { kind: "ok", record: structuredClone(next) };
  }

  async abortIntent(input: {
    readonly journalKey: string;
    readonly expectedRowVersion: number;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantActionRow>> {
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
    return { kind: "ok", record: structuredClone(next) };
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
    if (input.restoreLevel === true) this.#restoreLevel(existing);
    return structuredClone(next);
  }

  async settleAction(input: SettleQuantActionInput): Promise<QuantCasResult<QuantActionRow>> {
    const existing = this.#actions.get(input.journalKey);
    if (existing === undefined) return { kind: "conflict", record: null };
    // IDEMPOTENT: a second settle of the same action is a no-op, not an error.
    if (existing.state === "settled") return { kind: "ok", record: structuredClone(existing) };
    if (existing.state === "failed" || existing.state === "aborted") {
      return { kind: "conflict", record: structuredClone(existing) };
    }
    const ownership = `${input.txHash.toLowerCase()}|${existing.quantJobId}|${input.swapLogIndex}`;
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
      rowVersion: existing.rowVersion + 1,
      updatedAtMs: input.nowMs,
    };
    this.#actions.set(next.journalKey, next);
    const key = this.#levelKey(input.quantJobId, input.levelIndex);
    const level = this.#levels.get(key);
    if (level !== undefined && level.state !== "retired") {
      this.#levels.set(key, {
        ...level,
        state: input.nextLevelState,
        baseWei: input.nextBaseWei,
        baseAtCycleStartWei: input.nextBaseAtCycleStartWei,
        basisUWei: input.nextBasisUWei,
        entryCostUWei: input.entryCostUWei,
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
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantLevelRow>> {
    const key = this.#levelKey(input.quantJobId, input.levelIndex);
    const level = this.#levels.get(key);
    if (level === undefined) return { kind: "conflict", record: null };
    if (level.state === "retired") return { kind: "ok", record: structuredClone(level) };
    const next: QuantLevelRow = {
      ...level,
      state: "retired",
      retiredJson: input.retiredJson,
      // Nothing is added to any baseline FROM these records (R7.3): they are
      // HISTORY, and the snapshot below is what the accounting reads.
      baseWei: 0n, baseAtCycleStartWei: 0n,
      triggerConsecutive: 0, triggerSide: null,
      rowVersion: level.rowVersion + 1,
    };
    this.#levels.set(key, next);
    await this.openEpoch({ quantJobId: input.quantJobId, ...input.epoch, nowMs: input.nowMs });
    return { kind: "ok", record: structuredClone(next) };
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
    const list = this.#epochs.get(input.quantJobId) ?? [];
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
    };
    list.push(row);
    this.#epochs.set(input.quantJobId, list);
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
      setLevelTrigger: async (input) => {
        const key = this.#levelKey(input.quantJobId, input.levelIndex);
        const level = this.#levels.get(key);
        if (level === undefined) return;
        this.#levels.set(key, {
          ...level,
          triggerConsecutive: input.consecutive,
          triggerSide: input.side,
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
          ...(input.status === undefined ? {} : { status: input.status }),
          rowVersion: job.rowVersion + 1,
        });
      },
      recordObservation: async (input) => {
        const list = this.#observations.get(input.quantJobId) ?? [];
        list.push(structuredClone(input.observation));
        while (list.length > 8) list.shift();
        this.#observations.set(input.quantJobId, list);
        const job = this.#jobs.get(input.quantJobId);
        if (job !== undefined) {
          this.#jobs.set(input.quantJobId, {
            ...job,
            lastObservedBlock: input.observation.blockNumber,
            lastObservedHash: input.observation.blockHash,
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
    if (level === undefined || level.rowVersion !== input.expectedLevelRowVersion
      || level.state === "retired" || level.state === "blocked") {
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
      triggerBlock1: input.triggerBlock1,
      triggerBlock2: input.triggerBlock2,
      deadlineSec: input.deadlineSec,
      callsJson: input.callsJson,
      note: input.note,
      impactBps: input.impactBps,
      preUWei: input.preUWei,
      preWbnbWei: input.preWbnbWei,
      preNativeWei: input.preNativeWei,
      basisUWei: input.basisUWei,
      baseAtCycleStartWei: input.baseAtCycleStartWei,
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
      triggerConsecutive: 0,
      triggerSide: null,
      rowVersion: level.rowVersion + 1,
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
    updated_at_ms bigint not null
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
    primary key (quant_job_id, epoch)
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
];

const JOB_COLUMNS =
  "quant_job_id, strategy_id, trading_wallet, allocation_u_wei, daily_cap_u_wei, term_days, "
  + "started_at_ms, ends_at_ms, session_expires_at_ms, revoked_at_ms, status, envelope_json, "
  + "envelope_id, session_public_key, session_expiry, permissions_digest, projection_digest, "
  + "admitted_at_ms, chain_checked_at_ms, wbnb_cap_min_limit_wei, residual_threshold_wei, "
  + "params_json, params_digest, p0_e18, arm_block, levels, clip_u_wei, idle_u_wei, "
  + "last_observed_block, last_observed_hash, stale_observations, hold_code, hold_count, "
  + "last_job_read_at_ms, reported_at_ms, report_attempts, row_version, created_at_ms, updated_at_ms";

const LEVEL_COLUMNS =
  "quant_job_id, level_index, state, buy_price_e18, sell_price_e18, base_wei, "
  + "base_at_cycle_start_wei, basis_u_wei, entry_cost_u_wei, action_seq, cycles_closed, "
  + "realized_u_wei, residual_wei, prior_state, trigger_consecutive, trigger_side, "
  + "last_action_at_ms, hold_code, hold_count, exit_plan_json, retired_json, row_version";

const ACTION_COLUMNS =
  "journal_key, quant_job_id, level_index, action_seq, side, state, prior_level_state, "
  + "amount_in_wei, min_out_wei, quote_out_wei, quote_block, trigger_block_1, trigger_block_2, "
  + "deadline_sec, calls_json, note, impact_bps, pre_u_wei, pre_wbnb_wei, pre_native_wei, "
  + "basis_u_wei, base_at_cycle_start_wei, submit_finalized_number, submit_finalized_hash, "
  + "tx_hash, fill_in_wei, fill_out_wei, fee_delta_wei, resolution_json, failure_code, "
  + "created_at_ms, updated_at_ms, row_version";

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
    await sql.query(QUANT_OBSERVATIONS_DDL);
    await sql.query(QUANT_INDEXER_TRADES_DDL);
    await sql.query(QUANT_REPORTS_DDL);
    await sql.query(QUANT_RUNS_DDL);
    for (const migration of QUANT_MIGRATIONS) await sql.query(migration);
    return new PostgresQuantJobStore(sql, now);
  }

  async discoverJob(input: DiscoverQuantJobInput): Promise<QuantJobRow> {
    await this.#sql.query(
      `/* quantJobs.discover */
       insert into quant_jobs (quant_job_id, status, envelope_json, envelope_id,
         strategy_id, created_at_ms, updated_at_ms)
       values ($1, 'discovered', $2, $3, $5, $4::bigint, $4::bigint)
       on conflict (quant_job_id) do nothing`,
      [input.quantJobId, input.envelopeJson, input.envelopeId, input.nowMs, input.strategyId ?? ""],
    );
    const row = await this.getJob(input.quantJobId);
    if (row === null) throw new Error("quant job insert did not produce a row.");
    return row;
  }

  async updateJobWire(input: UpdateQuantJobWireInput): Promise<QuantJobRow | null> {
    const result = await this.#sql.query<JobRowShape>(
      `/* quantJobs.updateWire */
       update quant_jobs
       set strategy_id = case when strategy_id = '' then $2 else strategy_id end,
           trading_wallet = $3, allocation_u_wei = $4::numeric,
           daily_cap_u_wei = $5::numeric, term_days = $6::int,
           started_at_ms = $7::bigint, ends_at_ms = $8::bigint,
           session_expires_at_ms = $9::bigint, revoked_at_ms = $10::bigint,
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
    return row === undefined ? null : rowToJob(row);
  }

  async replaceEnvelope(
    quantJobId: string, envelopeJson: string, nowMs: number,
  ): Promise<void> {
    await this.#sql.query(
      `/* quantJobs.replaceEnvelope */
       update quant_jobs set envelope_json = $2, row_version = row_version + 1,
         updated_at_ms = $3::bigint
       where quant_job_id = $1`,
      [quantJobId, envelopeJson, nowMs],
    );
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
             row_version = row_version + 1, updated_at_ms = $7::bigint
         where quant_job_id = $1 and row_version = $2::int and status = 'discovered'
         returning ${JOB_COLUMNS}`,
        [
          input.quantJobId, input.expectedRowVersion, input.sessionPublicKey,
          input.sessionExpiry, input.permissionsDigest, input.projectionDigest,
          input.nowMs, input.wbnbCapMinLimitWei.toString(10),
          input.residualThresholdWei.toString(10), input.paramsJson, input.paramsDigest,
          input.p0E18.toString(10), input.armBlock.toString(10), input.levels.length,
          input.clipUWei.toString(10), input.idleUWei.toString(10),
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
             sell_price_e18)
           values ($1, $2::int, 'armed-quote', $3::numeric, $4::numeric)
           on conflict (quant_job_id, level_index) do nothing`,
          [
            input.quantJobId, level.levelIndex,
            level.buyPriceE18.toString(10), level.sellPriceE18.toString(10),
          ],
        );
      }
      await this.#openEpochOn(tx, {
        quantJobId: input.quantJobId,
        startedBlock: input.armBlock,
        startedBlockHash: null,
        baselineUWei: input.baselineUWei,
        baselineWbnbWei: input.baselineWbnbWei,
        baselineNativeWei: input.baselineNativeWei,
        note: "arm",
        nowMs: input.nowMs,
      });
      return { kind: "ok" as const, record: rowToJob(row) };
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
       where status in ('discovered','armed','held','ended','ended-unresolved')
         and strategy_id = $1
       order by quant_job_id asc`,
      [strategyId],
    );
    return result.rows.map(rowToJob);
  }

  async setJobStatus(input: {
    readonly quantJobId: string;
    readonly status: QuantJobStatus;
    readonly holdCode?: QuantHoldCode | null;
    readonly nowMs: number;
  }): Promise<void> {
    await this.#sql.query(
      `/* quantJobs.setStatus */
       update quant_jobs
       set status = $2, hold_code = $3,
           reported_at_ms = case when $2 = 'reported' then $4::bigint else reported_at_ms end,
           row_version = row_version + 1, updated_at_ms = $4::bigint
       where quant_job_id = $1`,
      [input.quantJobId, input.status, input.holdCode ?? null, input.nowMs],
    );
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
    const result = await this.#sql.query<JobRowShape>(
      `/* quantActions.markSubmitted */
       update quant_actions
       set state = 'submitted', submit_finalized_number = $3::numeric,
           submit_finalized_hash = $4, row_version = row_version + 1,
           updated_at_ms = $5::bigint
       where journal_key = $1 and row_version = $2::int and state = 'intended'
       returning ${ACTION_COLUMNS}`,
      [
        input.journalKey, input.expectedRowVersion,
        input.submitFinalizedNumber.toString(10), input.submitFinalizedHash, input.nowMs,
      ],
    );
    const row = result.rows[0];
    if (row !== undefined) return { kind: "ok", record: rowToAction(row) };
    return { kind: "conflict", record: await this.getAction(input.journalKey) };
  }

  async abortIntent(input: {
    readonly journalKey: string;
    readonly expectedRowVersion: number;
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantActionRow>> {
    return this.#sql.transaction(async (tx) => {
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
      if (input.restoreLevel === true) await this.#restoreLevelOn(tx, action);
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
             row_version = row_version + 1, updated_at_ms = $6::bigint
         where journal_key = $1 and state not in ('settled','failed','aborted')
         returning ${ACTION_COLUMNS}`,
        [
          input.journalKey, input.txHash, input.fillInWei.toString(10),
          input.fillOutWei.toString(10),
          input.feeDeltaWei === null ? null : input.feeDeltaWei.toString(10),
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
    readonly nowMs: number;
  }): Promise<QuantCasResult<QuantLevelRow>> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* quantJobs.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`,
        [QUANT_LOCK_CLASSID, input.quantJobId],
      );
      const result = await tx.query<JobRowShape>(
        `/* quantLevels.retire */
         update quant_levels
         set state = 'retired', retired_json = $3, base_wei = 0,
             base_at_cycle_start_wei = 0, trigger_consecutive = 0, trigger_side = null,
             row_version = row_version + 1
         where quant_job_id = $1 and level_index = $2::int and state <> 'retired'
         returning ${LEVEL_COLUMNS}`,
        [input.quantJobId, input.levelIndex, input.retiredJson],
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
    return this.#openEpochOn(this.#sql, input);
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
    const result = await sql.query<JobRowShape>(
      `/* quantEpochs.open */
       insert into quant_epochs (quant_job_id, epoch, started_block, started_block_hash,
         baseline_u_wei, baseline_wbnb_wei, baseline_native_wei, note, created_at_ms)
       select $1,
         coalesce((select max(epoch) from quant_epochs where quant_job_id = $1), 0) + 1,
         $2::numeric, $3, $4::numeric, $5::numeric, $6::numeric, $7, $8::bigint
       returning quant_job_id, epoch, started_block, started_block_hash, baseline_u_wei,
         baseline_wbnb_wei, baseline_native_wei, note, created_at_ms`,
      [
        input.quantJobId, input.startedBlock.toString(10), input.startedBlockHash,
        input.baselineUWei.toString(10), input.baselineWbnbWei.toString(10),
        input.baselineNativeWei.toString(10), input.note, input.nowMs,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("quant epoch insert produced no row.");
    return rowToEpoch(row);
  }

  async currentEpoch(quantJobId: string): Promise<QuantEpochRow | null> {
    return this.#currentEpochOn(this.#sql, quantJobId);
  }

  async #currentEpochOn(sql: SqlClient, quantJobId: string): Promise<QuantEpochRow | null> {
    const result = await sql.query<JobRowShape>(
      `/* quantEpochs.current */
       select quant_job_id, epoch, started_block, started_block_hash, baseline_u_wei,
         baseline_wbnb_wei, baseline_native_wei, note, created_at_ms
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
    const result = await this.#sql.query<JobRowShape>(
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
    await this.#sql.query(
      `/* quantJobs.bumpReportAttempts */
       update quant_jobs set report_attempts = report_attempts + 1,
         row_version = row_version + 1, updated_at_ms = $2::bigint
       where quant_job_id = $1`,
      [input.quantJobId, input.nowMs],
    );
    return {
      quantJobId: String(row["quant_job_id"]),
      attempt: int(row["attempt"]),
      payloadDigest: String(row["payload_digest"]) as Hex,
      responseStatus: int(row["response_status"]),
      notesApplied: intOrNull(row["notes_applied"]),
      createdAtMs: int(row["created_at_ms"]),
    };
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
                 status = coalesce($3, status), row_version = row_version + 1
             where quant_job_id = $1`,
            [input.quantJobId, input.holdCode, input.status ?? null],
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

  async #insertIntentOn(
    sql: SqlClient, input: InsertQuantIntentInput,
  ): Promise<QuantCasResult<QuantActionRow>> {
    const level = await sql.query<JobRowShape>(
      `/* quantLevels.block */
       update quant_levels
       set state = 'blocked', prior_state = $3, action_seq = $4::int,
           last_action_at_ms = $5::bigint, trigger_consecutive = 0, trigger_side = null,
           row_version = row_version + 1
       where quant_job_id = $1 and level_index = $2::int and row_version = $6::int
         and state not in ('retired','blocked')
       returning ${LEVEL_COLUMNS}`,
      [
        input.quantJobId, input.levelIndex, input.priorLevelState, input.actionSeq,
        input.nowMs, input.expectedLevelRowVersion,
      ],
    );
    if (level.rows.length === 0) return { kind: "conflict", record: null };
    const result = await sql.query<JobRowShape>(
      `/* quantActions.insertIntent */
       insert into quant_actions (journal_key, quant_job_id, level_index, action_seq, side,
         state, prior_level_state, amount_in_wei, min_out_wei, quote_out_wei, quote_block,
         trigger_block_1, trigger_block_2, deadline_sec, calls_json, note, impact_bps,
         pre_u_wei, pre_wbnb_wei, pre_native_wei, basis_u_wei, base_at_cycle_start_wei,
         created_at_ms, updated_at_ms, row_version)
       values ($1, $2, $3::int, $4::int, $5, 'intended', $6, $7::numeric, $8::numeric,
         $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::bigint, $14, $15,
         $16::int, $17::numeric, $18::numeric, $19::numeric, $20::numeric, $21::numeric,
         $22::bigint, $22::bigint, 1)
       on conflict (journal_key) do nothing
       returning ${ACTION_COLUMNS}`,
      [
        input.journalKey, input.quantJobId, input.levelIndex, input.actionSeq, input.side,
        input.priorLevelState, input.amountInWei.toString(10), input.minOutWei.toString(10),
        input.quoteOutWei.toString(10), input.quoteBlock.toString(10),
        input.triggerBlock1.toString(10), input.triggerBlock2.toString(10),
        input.deadlineSec, input.callsJson, input.note, input.impactBps,
        input.preUWei.toString(10), input.preWbnbWei.toString(10),
        input.preNativeWei.toString(10), input.basisUWei.toString(10),
        input.baseAtCycleStartWei.toString(10), input.nowMs,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) return { kind: "conflict", record: null };
    return { kind: "ok", record: rowToAction(row) };
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
