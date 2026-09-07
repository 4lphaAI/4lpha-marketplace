/**
 * Atomic, no-submit disposition for the one LP row proved not to have reached
 * its binder.  This module has no provider, wallet, session-key, prepare,
 * signing or submit capability: its only authority is a fenced local state
 * transition after `verifyPreBindRetirement` admitted the row.
 */
import type { Address } from "viem";
import type { ExecutionJournal, JournalExternalRef } from "../store/journal.js";
import type { LpSequenceStore } from "../store/lpSequences.js";
import { createPgSqlClient, type SqlClient } from "../store/sql.js";

export type PreBindRetirementResult = {
  readonly scheme: "retire-lp-pre-bind-result-v1";
  readonly decisionId: string;
  readonly targetJournalKey: string;
  readonly sequenceId: string;
  readonly positionId: string;
  readonly targetJournalState: "ROLLED_BACK";
  readonly sequenceState: "rolled-back";
  readonly positionState: "closed";
  readonly evidenceCode: "retired-pre-bind-v1";
};

export type PreBindRetirementFinalizerInput = {
  readonly owner: Address;
  readonly agentId: string;
  readonly decisionId: string;
  readonly targetJournalKey: string;
  readonly actionIdempotencyKey: string;
  readonly sequenceId: string;
  readonly positionId: string;
  readonly fence: bigint;
  readonly expectedRetirementRowVersion: number;
  readonly expectedPositionVersion: number;
  readonly now: number;
};

/** The sole capability that may perform the proved `UNKNOWN → ROLLED_BACK` edge. */
export interface PreBindRetirementFinalizer {
  finalize(input: PreBindRetirementFinalizerInput): Promise<PreBindRetirementResult>;
  close?(): Promise<void>;
}

export type PreBindRetirementFinalizerWrite =
  "begin" | "position" | "target" | "reservation" | "action" | "sequence";

/**
 * The canonical terminal truth is shared with the route's PENDING-action
 * re-entry only after it has re-read an already retired target.  It performs
 * no target/position/sequence mutation; the finalizers remain the only
 * owners of the proved `UNKNOWN → ROLLED_BACK` transition.
 */
export function preBindRetirementResult(
  input: Pick<PreBindRetirementFinalizerInput,
    "decisionId" | "targetJournalKey" | "sequenceId" | "positionId">,
): PreBindRetirementResult {
  return {
    scheme: "retire-lp-pre-bind-result-v1",
    decisionId: input.decisionId,
    targetJournalKey: input.targetJournalKey,
    sequenceId: input.sequenceId,
    positionId: input.positionId,
    targetJournalState: "ROLLED_BACK",
    sequenceState: "rolled-back",
    positionState: "closed",
    evidenceCode: "retired-pre-bind-v1",
  };
}

export function preBindRetirementActionCompletionRef(
  input: Pick<PreBindRetirementFinalizerInput,
    "decisionId" | "targetJournalKey" | "sequenceId" | "positionId">,
  result: PreBindRetirementResult,
): JournalExternalRef {
  return {
    retirementAction: {
      scheme: "retire-lp-pre-bind-action-v1",
      targetJournalKey: input.targetJournalKey,
      decisionId: input.decisionId,
      state: "TERMINAL",
    },
    retirementResult: result,
  };
}

/**
 * The test/dev transaction participant.  The snapshots are intentionally
 * taken before the disposition latch: a fault after *any* durable write must
 * restore every affected row, just as PostgreSQL rolls back its transaction.
 */
export class MemoryPreBindRetirementFinalizer implements PreBindRetirementFinalizer {
  readonly #journal: ExecutionJournal;
  readonly #store: LpSequenceStore;
  readonly #afterWrite: ((write: PreBindRetirementFinalizerWrite) => void | Promise<void>) | undefined;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(input: {
    readonly journal: ExecutionJournal;
    readonly store: LpSequenceStore;
    readonly afterWrite?: (write: PreBindRetirementFinalizerWrite) => void | Promise<void>;
  }) {
    this.#journal = input.journal;
    this.#store = input.store;
    this.#afterWrite = input.afterWrite;
  }

  async finalize(input: PreBindRetirementFinalizerInput): Promise<PreBindRetirementResult> {
    return this.#withLock(input.sequenceId, async () => {
      const snapshotJournal = this.#journal.snapshotLandingResolutionTransaction?.([
        input.targetJournalKey, input.actionIdempotencyKey,
      ]);
      const snapshotStore = this.#store.snapshotLandingResolutionTransaction?.({
        positionId: input.positionId, sequenceId: input.sequenceId,
      });
      if (snapshotJournal === undefined || snapshotStore === undefined ||
          this.#journal.restoreLandingResolutionTransaction === undefined ||
          this.#store.restoreLandingResolutionTransaction === undefined) {
        throw new Error("PRE_BIND_RETIREMENT_FINALIZER_UNAVAILABLE");
      }
      try {
        const begun = await this.#store.beginSequencePreBindRetirement(
          input.owner, input.agentId, input.sequenceId, input.targetJournalKey,
          input.fence, input.expectedRetirementRowVersion,
        );
        if (begun === null) throw new Error("PRE_BIND_RETIREMENT_CONFLICT");
        await this.#wrote("begin");
        const closed = await this.#store.setPositionStateForPreBindRetirement(
          input.owner, input.agentId, input.positionId, {
            sequenceId: input.sequenceId, targetJournalKey: input.targetJournalKey,
            fence: input.fence, expectedRetirementRowVersion: begun.retirementRowVersion,
            expectedPositionVersion: input.expectedPositionVersion, state: "closed",
          },
        );
        if (closed === null) throw new Error("PRE_BIND_RETIREMENT_CONFLICT");
        await this.#wrote("position");
        await this.#journal.retireProvenPreBind(input.targetJournalKey);
        await this.#wrote("target");
        await this.#store.releaseReservation(input.owner, input.agentId, input.sequenceId);
        await this.#wrote("reservation");
        const result = preBindRetirementResult(input);
        await this.#journal.completePreBindRetirementAction(
          input.actionIdempotencyKey, preBindRetirementActionCompletionRef(input, result),
        );
        await this.#wrote("action");
        const terminal = await this.#store.finishSequencePreBindRetirement(
          input.owner, input.agentId, input.sequenceId, {
            targetJournalKey: input.targetJournalKey, fence: input.fence,
            expectedRetirementRowVersion: closed.sequence.retirementRowVersion,
          },
        );
        if (terminal === null) throw new Error("PRE_BIND_RETIREMENT_CONFLICT");
        await this.#wrote("sequence");
        return result;
      } catch (error) {
        this.#journal.restoreLandingResolutionTransaction(snapshotJournal);
        this.#store.restoreLandingResolutionTransaction(snapshotStore);
        throw error;
      }
    });
  }

  async #wrote(write: PreBindRetirementFinalizerWrite): Promise<void> {
    await this.#afterWrite?.(write);
  }

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.#locks.set(key, run.catch(() => undefined));
    return run;
  }
}

/**
 * PostgreSQL's one transaction / lock domain.  The sequence remains the last
 * released row, so the worker cannot observe a partially terminal position.
 */
export class PostgresPreBindRetirementFinalizer implements PreBindRetirementFinalizer {
  readonly #sql: SqlClient;
  readonly #afterWrite: ((write: PreBindRetirementFinalizerWrite) => void | Promise<void>) | undefined;

  constructor(sql: SqlClient, input: {
    readonly afterWrite?: (write: PreBindRetirementFinalizerWrite) => void | Promise<void>;
  } = {}) {
    this.#sql = sql;
    this.#afterWrite = input.afterWrite;
  }

  finalize(input: PreBindRetirementFinalizerInput): Promise<PreBindRetirementResult> {
    return this.#sql.transaction(async (tx) => {
      const at = new Date(input.now);
      // Fixed lock order: position, sequence, target journal, owner action.
      const position = await tx.query<{ position_id: string }>(
        `/* preBindFinalize.positionLock */ select position_id from lp_positions where
          position_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
          state='open' and token_id is null and row_version=$4 for update`,
        [input.positionId, input.agentId, input.owner, input.expectedPositionVersion],
      );
      const sequence = await tx.query<{ sequence_id: string }>(
        `/* preBindFinalize.sequenceLock */ select sequence_id from lp_sequences where
          sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
          position_id=$4 and state='retiring-pre-bind' and retirement_target_journal_key=$5 and
          retirement_action_idempotency_key=$6 and retirement_fence=$7::numeric and
          retirement_row_version=$8 and retirement_disposition_started=false for update`,
        [input.sequenceId, input.agentId, input.owner, input.positionId,
          input.targetJournalKey, input.actionIdempotencyKey, input.fence.toString(10),
          input.expectedRetirementRowVersion],
      );
      const target = await tx.query<{ idempotency_key: string }>(
        `/* preBindFinalize.targetLock */ select idempotency_key from execution_journal where
          idempotency_key=$1 and agent_id=$2 and lower(owner_address)=lower($3) and kind='lp' and
          decision_id=$4 and state='UNKNOWN' and prepared_intent_identity is null and
          prepared_intent_identity_hash is null and prepared_binding_version=0 and
          landing_resolution_id is null and landing_resolution_key_hash is null and
          landing_resolution_outcome is null and landing_resolution_evidence_hash is null and
          landing_resolution_terminal_at is null and not (coalesce(external_ref,'{}'::jsonb) ?| array['callsId','txHash','retirementEvidence'])
          for update`,
        [input.targetJournalKey, input.agentId, input.owner, input.decisionId],
      );
      const action = await tx.query<{ idempotency_key: string }>(
        `/* preBindFinalize.actionLock */ select idempotency_key from execution_journal where
          idempotency_key=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
          kind='retireLpPreBindV1' and state='PENDING' and
          external_ref @> jsonb_build_object('retirementAction',jsonb_build_object(
            'scheme','retire-lp-pre-bind-action-v1','targetJournalKey',$4::text,
            'decisionId',$5::text,'state','PENDING')) and
          not (coalesce(external_ref,'{}'::jsonb) ? 'retirementResult') for update`,
        [input.actionIdempotencyKey, input.agentId, input.owner,
          input.targetJournalKey, input.decisionId],
      );
      if (position.rows[0] === undefined || sequence.rows[0] === undefined ||
          target.rows[0] === undefined || action.rows[0] === undefined) {
        throw new Error("PRE_BIND_RETIREMENT_CONFLICT");
      }

      const begun = await tx.query<{ sequence_id: string }>(
        `/* preBindFinalize.begin */ update lp_sequences set retirement_disposition_started=true,
          retirement_row_version=retirement_row_version+1,updated_at=$9 where sequence_id=$1 and
          agent_id=$2 and lower(owner_address)=lower($3) and position_id=$4 and
          state='retiring-pre-bind' and retirement_target_journal_key=$5 and
          retirement_action_idempotency_key=$6 and retirement_fence=$7::numeric and
          retirement_row_version=$8 and retirement_disposition_started=false returning sequence_id`,
        [input.sequenceId, input.agentId, input.owner, input.positionId, input.targetJournalKey,
          input.actionIdempotencyKey, input.fence.toString(10), input.expectedRetirementRowVersion, at],
      );
      if (begun.rows[0] === undefined) throw new Error("PRE_BIND_RETIREMENT_CONFLICT");
      await this.#wrote("begin");

      const closed = await tx.query<{ position_id: string }>(
        `/* preBindFinalize.position */ update lp_positions set state='closed',basis_wei=0,
          row_version=row_version+1,updated_at=$5 where position_id=$1 and agent_id=$2 and
          lower(owner_address)=lower($3) and row_version=$4 and state='open' and token_id is null
          returning position_id`,
        [input.positionId, input.agentId, input.owner, input.expectedPositionVersion, at],
      );
      if (closed.rows[0] === undefined) throw new Error("PRE_BIND_RETIREMENT_CONFLICT");
      await this.#wrote("position");

      const retired = await tx.query<{ idempotency_key: string }>(
        `/* preBindFinalize.target */ update execution_journal set state='ROLLED_BACK',
          external_ref=coalesce(external_ref,'{}'::jsonb) || jsonb_build_object(
            'retirementEvidence',jsonb_build_object('scheme','retired-pre-bind-v1')),
          updated_at=$5 where idempotency_key=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
          kind='lp' and decision_id=$4 and state='UNKNOWN' and prepared_intent_identity is null and
          prepared_intent_identity_hash is null and prepared_binding_version=0 and
          landing_resolution_id is null and landing_resolution_key_hash is null and
          landing_resolution_outcome is null and landing_resolution_evidence_hash is null and
          landing_resolution_terminal_at is null and not (coalesce(external_ref,'{}'::jsonb) ?| array['callsId','txHash','retirementEvidence'])
          returning idempotency_key`,
        [input.targetJournalKey, input.agentId, input.owner, input.decisionId, at],
      );
      if (retired.rows[0] === undefined) throw new Error("PRE_BIND_RETIREMENT_CONFLICT");
      await this.#wrote("target");

      await tx.query(
        `/* preBindFinalize.reservation */ update lp_exit_reservations set released_at=$4 where
          sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and released_at is null`,
        [input.sequenceId, input.agentId, input.owner, at],
      );
      await this.#wrote("reservation");

      const result = preBindRetirementResult(input);
      const completed = await tx.query<{ idempotency_key: string }>(
        `/* preBindFinalize.action */ update execution_journal set state='COMMITTED',
          external_ref=coalesce(external_ref,'{}'::jsonb) || jsonb_build_object(
            'retirementAction',jsonb_build_object('scheme','retire-lp-pre-bind-action-v1',
              'targetJournalKey',$4::text,'decisionId',$5::text,'state','TERMINAL'),
            'retirementResult',jsonb_build_object('scheme','retire-lp-pre-bind-result-v1',
              'decisionId',$5::text,'targetJournalKey',$4::text,'sequenceId',$6::text,
              'positionId',$7::text,'targetJournalState','ROLLED_BACK','sequenceState','rolled-back',
              'positionState','closed','evidenceCode','retired-pre-bind-v1')),
          updated_at=$8 where idempotency_key=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
          kind='retireLpPreBindV1' and state='PENDING' and external_ref @> jsonb_build_object(
            'retirementAction',jsonb_build_object('scheme','retire-lp-pre-bind-action-v1',
              'targetJournalKey',$4::text,'decisionId',$5::text,'state','PENDING')) and
          not (coalesce(external_ref,'{}'::jsonb) ? 'retirementResult') returning idempotency_key`,
        [input.actionIdempotencyKey, input.agentId, input.owner, input.targetJournalKey,
          input.decisionId, input.sequenceId, input.positionId, at],
      );
      if (completed.rows[0] === undefined) throw new Error("PRE_BIND_RETIREMENT_CONFLICT");
      await this.#wrote("action");

      const terminal = await tx.query<{ sequence_id: string }>(
        `/* preBindFinalize.sequence */ update lp_sequences set state='rolled-back',
          retirement_prior_state=null,retirement_prior_recovery_state=null,
          retirement_target_journal_key=null,retirement_action_idempotency_key=null,
          retirement_lease_until=null,retirement_snapshot_hash=null,
          retirement_disposition_started=false,retirement_row_version=retirement_row_version+1,
          updated_at=$9 where sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
          position_id=$4 and state='retiring-pre-bind' and retirement_target_journal_key=$5 and
          retirement_action_idempotency_key=$6 and retirement_fence=$7::numeric and
          retirement_row_version=$8 and retirement_disposition_started=true returning sequence_id`,
        [input.sequenceId, input.agentId, input.owner, input.positionId, input.targetJournalKey,
          input.actionIdempotencyKey, input.fence.toString(10), input.expectedRetirementRowVersion + 1, at],
      );
      if (terminal.rows[0] === undefined) throw new Error("PRE_BIND_RETIREMENT_CONFLICT");
      await this.#wrote("sequence");
      return result;
    });
  }

  async #wrote(write: PreBindRetirementFinalizerWrite): Promise<void> {
    await this.#afterWrite?.(write);
  }

  close(): Promise<void> { return this.#sql.close(); }
}

/**
 * Production owns a dedicated Postgres client, like the landing finalizer, so
 * all affected tables share the finalizer's one transaction.  Memory is only
 * admitted when both stores expose their explicit snapshot participants.
 */
export async function createPreBindRetirementFinalizer(input: {
  readonly journal: ExecutionJournal;
  readonly store: LpSequenceStore;
  readonly databaseUrl?: string;
}): Promise<PreBindRetirementFinalizer | undefined> {
  const url = input.databaseUrl?.trim() ?? "";
  if (url !== "") return new PostgresPreBindRetirementFinalizer(await createPgSqlClient(url));
  if (input.journal.snapshotLandingResolutionTransaction !== undefined &&
      input.journal.restoreLandingResolutionTransaction !== undefined &&
      input.store.snapshotLandingResolutionTransaction !== undefined &&
      input.store.restoreLandingResolutionTransaction !== undefined) {
    return new MemoryPreBindRetirementFinalizer({ journal: input.journal, store: input.store });
  }
  return undefined;
}
