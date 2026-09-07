/** Atomic PostgreSQL step 8 for Phase 3.9c. */
import type { Address, Hex } from "viem";
import type { LpEvidenceConfig } from "../ops/config.js";
import type { ResolutionActionIdentity } from "../store/lpEvidence.js";
import type { LandingEvidenceV1 } from "../store/lpEvidence.js";
import {
  canonicalEvidenceJson,
  canonicalLandingEvidence,
  requirementChargedLogicalBytes,
  resolutionEvidenceChargedLogicalBytes,
} from "../store/lpEvidence.js";
import { createPgSqlClient, type SqlClient } from "../store/sql.js";

export type LandingFinalizerInput = {
  readonly decisionId: string;
  readonly owner: Address;
  readonly agentId: string;
  readonly positionId: string;
  readonly sequenceId: string;
  readonly resolutionId: string;
  readonly resolverFence: bigint;
  readonly expectedResolverRowVersion: number;
  readonly expectedResolutionRowVersion: number;
  readonly targetSequenceState: "active" | "rolled-back";
  readonly journalIdempotencyKey: string;
  readonly resolutionKeyHash: Hex;
  readonly outcome: "landed" | "absent";
  readonly evidenceHash: Hex;
  readonly terminalizingAction: ResolutionActionIdentity;
  readonly now: number;
};

export interface LandingResolutionFinalizer {
  bindEvidence(input: {
    readonly owner: Address; readonly agentId: string; readonly positionId: string;
    readonly sequenceId: string; readonly resolutionId: string; readonly resolverFence: bigint;
    readonly expectedResolverRowVersion: number; readonly expectedResolutionRowVersion: number;
    readonly evidence: LandingEvidenceV1; readonly now: number;
  }): Promise<void>;
  refuseProvisional(input: {
    readonly owner: Address; readonly agentId: string; readonly positionId: string;
    readonly sequenceId: string; readonly resolutionId: string; readonly resolverFence: bigint;
    readonly expectedResolverRowVersion: number; readonly expectedResolutionRowVersion: number;
    readonly resolutionKeyHash: Hex; readonly actionIdempotencyKey: string;
    readonly decisionId: string; readonly outcome: "ambiguous" | "unavailable";
    readonly evidence?: LandingEvidenceV1; readonly now: number;
  }): Promise<void>;
  beginDisposition(input: {
    readonly owner: Address; readonly agentId: string; readonly positionId: string;
    readonly sequenceId: string; readonly resolutionId: string; readonly resolverFence: bigint;
    readonly expectedResolverRowVersion: number; readonly expectedResolutionRowVersion: number;
    readonly evidence: LandingEvidenceV1; readonly now: number;
  }): Promise<void>;
  writeJournalDisposition(input: {
    readonly owner: Address; readonly agentId: string; readonly positionId: string;
    readonly sequenceId: string; readonly resolutionId: string; readonly resolverFence: bigint;
    readonly expectedResolverRowVersion: number; readonly expectedResolutionRowVersion: number;
    readonly journalIdempotencyKey: string; readonly resolutionKeyHash: Hex;
    readonly outcome: "landed" | "absent"; readonly txHash?: Hex; readonly now: number;
  }): Promise<void>;
  writeRecovery(input: {
    readonly owner: Address; readonly agentId: string; readonly positionId: string;
    readonly sequenceId: string; readonly resolutionId: string; readonly resolverFence: bigint;
    readonly expectedResolverRowVersion: number; readonly expectedResolutionRowVersion: number;
    readonly journalIdempotencyKey: string; readonly resolutionKeyHash: Hex;
    readonly outcome: "landed" | "absent";
    // PHASE3.22 R5.2 site 5 — widened with the three `lpEvidence` unions and
    // for the identical reason: a `grid-shift` sequence never reaches a
    // landing-evidence row (grid is boot-incompatible with landing evidence,
    // and `grid-shift` is deliberately unmapped in `landingDispositionFor`),
    // but this union is TYPE-level and an `LpRecoveryState` is assigned into
    // it, so keeping it narrow breaks the compile whether or not the flag is
    // on. One recovery vocabulary, not two kept in sync by hand.
    readonly recoveryState: "none" | "pending-mint" | "pending-increase" | "wbnb-stranded" | "shift-ambiguous";
    readonly note: string; readonly now: number;
  }): Promise<void>;
  postprocess(input: {
    readonly owner: Address; readonly agentId: string; readonly positionId: string;
    readonly sequenceId: string; readonly resolutionId: string; readonly resolverFence: bigint;
    readonly expectedResolverRowVersion: number; readonly expectedResolutionRowVersion: number;
    readonly expectedPositionVersion: number; readonly journalIdempotencyKey: string;
    readonly resolutionKeyHash: Hex; readonly outcome: "landed" | "absent";
    readonly positionMutation: "none" | "open" | "close" | "attach-token";
    readonly tokenId?: string; readonly releaseReservation: boolean; readonly now: number;
  }): Promise<void>;
  finalize(input: LandingFinalizerInput): Promise<void>;
  close(): Promise<void>;
}

export class PostgresLandingResolutionFinalizer implements LandingResolutionFinalizer {
  readonly #sql: SqlClient;
  readonly #retentionDays: number;
  readonly #config: LpEvidenceConfig;
  constructor(sql: SqlClient, config: LpEvidenceConfig) {
    this.#sql = sql;
    this.#retentionDays = config.auditRetentionDays;
    this.#config = config;
  }

  bindEvidence(input: Parameters<LandingResolutionFinalizer["bindEvidence"]>[0]): Promise<void> {
    const { evidenceDigest, ...body } = input.evidence;
    if (canonicalLandingEvidence(body).evidenceDigest !== evidenceDigest) {
      throw new Error("RESOLUTION_STATE_CONFLICT: landing evidence digest is invalid.");
    }
    const evidenceBytes = canonicalEvidenceJson(input.evidence);
    const charge = resolutionEvidenceChargedLogicalBytes(input.resolutionId);
    if (64n + BigInt(Buffer.byteLength(evidenceBytes, "utf8")) > charge) {
      throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
    }
    return this.#sql.transaction(async (tx) => {
      const at = new Date(input.now);
      await tx.query(`/* landingFinalize.bindQuotaEnsure */ insert into lp_evidence_quota_counters
       (scope,coverage_version,logical_bytes,block_rows,candidate_rows,requirement_rows,
        zero_expiry_rows,row_version,updated_at)
       values('global','',0,0,0,0,0,0,$2),('coverage-version',$1,0,0,0,0,0,0,$2)
       on conflict(scope,coverage_version) do nothing`, [input.evidence.coverageVersion, at]);
      const globalRows = await tx.query<{ logical_bytes: string }>(
        `/* landingFinalize.bindQuotaGlobal */ select logical_bytes from lp_evidence_quota_counters
         where scope='global' and coverage_version='' for update`,
      );
      const versionRows = await tx.query<{ logical_bytes: string }>(
        `/* landingFinalize.bindQuotaVersion */ select logical_bytes from lp_evidence_quota_counters
         where scope='coverage-version' and coverage_version=$1 for update`,
        [input.evidence.coverageVersion],
      );
      const global = globalRows.rows[0]; const version = versionRows.rows[0];
      if (global === undefined || version === undefined ||
          BigInt(global.logical_bytes) + charge > BigInt(this.#config.maxGlobalLogicalBytes) ||
          BigInt(version.logical_bytes) + charge > BigInt(this.#config.maxVersionLogicalBytes)) {
        throw new Error("LP_EVIDENCE_STORAGE_QUOTA");
      }
      // Rewind takes quota/cursor/requirement locks in that order. Hold the
      // same cursor + durable-requirement citation through the evidence bind
      // transaction so an unavailable transition cannot race the first write.
      await lockEvidenceAuthority(tx, input.resolutionId, input.evidence);
      const locks = await lockPositionSequence(tx, input);
      const resolution = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.bindResolutionLock */ select resolution_id from lp_landing_resolutions
         where resolution_id=$1 and phase='claimed' and row_version=$2 and
         prepared_identity_hash=$3 for update`, [input.resolutionId,
          input.expectedResolutionRowVersion, input.evidence.preparedIdentityHash],
      );
      if (!locks || resolution.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: evidence bind fence lost.");
      }
      const inserted = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.bindEvidenceInsert */ insert into lp_landing_resolution_evidence(
         resolution_id,evidence_version,evidence_bytes,evidence_hash,coverage_version,quorum_id,
         lane_id,generation,cursor_row_version,retained_until,created_at,charged_logical_bytes)
         values($1,'lp-landing-evidence-v1',$2,$3,$4,$5,$6,$7::bigint,$8::bigint,null,$9,$10::bigint)
         on conflict(resolution_id) do nothing returning resolution_id`, [input.resolutionId,
          evidenceBytes, input.evidence.evidenceDigest, input.evidence.coverageVersion,
          input.evidence.quorumId, input.evidence.laneId, input.evidence.generation,
          input.evidence.cursorRowVersion, at, charge.toString(10)],
      );
      const advanced = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.bindResolution */ update lp_landing_resolutions set
         phase='evidence-bound',outcome=$3,response_inference=$3,evidence_hash=$4,
         row_version=row_version+1,updated_at=$5 where resolution_id=$1 and row_version=$2 and
         phase='claimed' returning resolution_id`, [input.resolutionId,
          input.expectedResolutionRowVersion, input.evidence.outcome,
          input.evidence.evidenceDigest, at],
      );
      if (inserted.rows[0] === undefined || advanced.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: evidence bind CAS failed.");
      }
      for (const [scope, versionKey] of [["global", ""],
        ["coverage-version", input.evidence.coverageVersion]] as const) {
        const updated = await tx.query<{ row_version: string }>(
          `/* landingFinalize.bindQuotaUpdate */ update lp_evidence_quota_counters set
           logical_bytes=logical_bytes+$3::bigint,row_version=row_version+1,updated_at=$4
           where scope=$1 and coverage_version=$2 returning row_version`,
          [scope, versionKey, charge.toString(10), at],
        );
        if (updated.rows[0] === undefined) throw new Error("LP_EVIDENCE_STORAGE_QUOTA");
      }
    });
  }

  refuseProvisional(
    input: Parameters<LandingResolutionFinalizer["refuseProvisional"]>[0],
  ): Promise<void> {
    return this.#sql.transaction(async (tx) => {
      const at = new Date(input.now);
      // A provisional evidence body is charged. Take the quota prefix before
      // ordinary row locks even when the row later proves absent; that keeps
      // join/refusal/cleanup lock ordering deterministic across processes.
      if (input.evidence !== undefined) {
        await tx.query(`/* landingFinalize.refuseQuotaEnsure */ insert into
          lp_evidence_quota_counters(scope,coverage_version,logical_bytes,block_rows,
           candidate_rows,requirement_rows,zero_expiry_rows,row_version,updated_at)
          values('global','',0,0,0,0,0,0,$2),
                ('coverage-version',$1,0,0,0,0,0,0,$2)
          on conflict(scope,coverage_version) do nothing`,
        [input.evidence.coverageVersion, at]);
      }
      const quotaGlobal = input.evidence === undefined ? null : await tx.query<{ row_version: string }>(
        `/* landingFinalize.refuseQuotaGlobal */ select row_version from
         lp_evidence_quota_counters where scope='global' and coverage_version='' for update`,
      );
      const quotaVersion = input.evidence === undefined ? null : await tx.query<{ row_version: string }>(
        `/* landingFinalize.refuseQuotaVersion */ select row_version from
         lp_evidence_quota_counters where scope='coverage-version' and coverage_version=$1 for update`,
        [input.evidence.coverageVersion],
      );
      const position = await tx.query<{ position_id: string }>(
        `/* landingFinalize.refusePositionLock */ select position_id from lp_positions where
         position_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) for update`,
        [input.positionId, input.agentId, input.owner],
      );
      const sequence = await tx.query<{ sequence_id: string; resolver_prior_state: "active" | "held";
        resolver_prior_recovery_state: string }>(
        `/* landingFinalize.refuseSequenceLock */ select sequence_id,resolver_prior_state,
         resolver_prior_recovery_state from lp_sequences where sequence_id=$1 and agent_id=$2 and
         lower(owner_address)=lower($3) and state='resolving' and resolution_id=$4 and
         resolver_fence=$5::numeric and resolver_row_version=$6 and
         resolver_action_idempotency_key=$7 and resolution_disposition_started=false for update`,
        [input.sequenceId, input.agentId, input.owner, input.resolutionId,
          input.resolverFence.toString(10), input.expectedResolverRowVersion,
          input.actionIdempotencyKey],
      );
      const resolution = await tx.query<{ resolution_id: string; phase: "claimed" | "evidence-bound" }>(
        `/* landingFinalize.refuseResolutionLock */ select resolution_id,phase from
         lp_landing_resolutions where resolution_id=$1 and row_version=$2 and
         phase in ('claimed','evidence-bound') for update`,
        [input.resolutionId, input.expectedResolutionRowVersion],
      );
      const actions = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.refuseActionsLock */ select idempotency_key from execution_journal
         where kind='resolveUnknownLandingV1' and lower(owner_address)=lower($1) and agent_id=$2 and
         landing_resolution_id=$3 and landing_resolution_key_hash=$4 and
         state in ('PENDING','IN_PROGRESS') order by idempotency_key for update`,
        [input.owner, input.agentId, input.resolutionId, input.resolutionKeyHash],
      );
      if (position.rows[0] === undefined ||
          sequence.rows[0] === undefined || resolution.rows[0] === undefined ||
          !actions.rows.some((row) => row.idempotency_key === input.actionIdempotencyKey) ||
          (input.evidence !== undefined && (quotaGlobal?.rows[0] === undefined ||
            quotaVersion?.rows[0] === undefined))) {
        throw new Error("RESOLUTION_STATE_CONFLICT: provisional refusal lock set failed.");
      }
      let evidenceCharge = 0n;
      if (input.evidence !== undefined) {
        const deleted = await tx.query<{ charged_logical_bytes: string }>(
          `/* landingFinalize.refuseEvidenceDelete */ delete from lp_landing_resolution_evidence
           where resolution_id=$1 and evidence_hash=$2 and coverage_version=$3 and
           retained_until is null and charged_logical_bytes=$4::bigint
           returning charged_logical_bytes`,
          [input.resolutionId, input.evidence.evidenceDigest, input.evidence.coverageVersion,
            resolutionEvidenceChargedLogicalBytes(input.resolutionId).toString(10)],
        );
        const row = deleted.rows[0];
        if (row === undefined) {
          throw new Error("RESOLUTION_STATE_CONFLICT: provisional evidence cleanup failed.");
        }
        evidenceCharge = BigInt(row.charged_logical_bytes);
        for (const [scope, version] of [["global", ""],
          ["coverage-version", input.evidence.coverageVersion]] as const) {
          const updated = await tx.query<{ row_version: string }>(
            `/* landingFinalize.refuseQuotaDebit */ update lp_evidence_quota_counters set
             logical_bytes=logical_bytes-$3::bigint,row_version=row_version+1,updated_at=$4
             where scope=$1 and coverage_version=$2 and logical_bytes>=$3::bigint
             returning row_version`, [scope, version, evidenceCharge.toString(10), at],
          );
          if (updated.rows[0] === undefined) throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
        }
      }
      const restored = await tx.query<{ sequence_id: string }>(
        `/* landingFinalize.refuseSequenceRestore */ update lp_sequences set
         state=resolver_prior_state,recovery_state=resolver_prior_recovery_state,
         resolver_prior_state=null,resolver_prior_recovery_state=null,resolver_lease_until=null,
         resolver_snapshot_hash=null,resolution_id=null,resolver_action_idempotency_key=null,
         resolution_disposition_started=false,resolver_row_version=resolver_row_version+1,
         updated_at=$7 where sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
         state='resolving' and resolution_id=$4 and resolver_fence=$5::numeric and
         resolver_row_version=$6 returning sequence_id`, [input.sequenceId, input.agentId,
          input.owner, input.resolutionId, input.resolverFence.toString(10),
          input.expectedResolverRowVersion, at],
      );
      const completed = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.refuseActionsComplete */ update execution_journal set
         state='COMMITTED',external_ref=coalesce(external_ref,'{}'::jsonb) ||
          jsonb_build_object('landingAction',jsonb_build_object(
           'scheme','resolve-landing-action-v1','resolutionId',$3::text,'state','TERMINAL',
           'completionRole',case when idempotency_key=$5 then 'refusal-winner' else 'joiner' end),
          'landingResult',jsonb_build_object('decisionId',$6::text,'outcome',$7::text,
           'action','none','journalState','UNKNOWN','inference',$7::text,
           'resolutionId',$3::text,'evidenceDigest',null,'evidenceRetainedUntil',null,
           'replayed',idempotency_key<>$5)),landing_resolution_id=null,
         landing_resolution_key_hash=null,updated_at=$8 where kind='resolveUnknownLandingV1' and
         lower(owner_address)=lower($1) and agent_id=$2 and landing_resolution_id=$3 and
         landing_resolution_key_hash=$4 and state in ('PENDING','IN_PROGRESS')
         returning idempotency_key`, [input.owner, input.agentId, input.resolutionId,
          input.resolutionKeyHash, input.actionIdempotencyKey, input.decisionId,
          input.outcome, at],
      );
      const resolutionDeleted = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.refuseResolutionDelete */ delete from lp_landing_resolutions where
         resolution_id=$1 and row_version=$2 and phase in ('claimed','evidence-bound')
         returning resolution_id`, [input.resolutionId, input.expectedResolutionRowVersion],
      );
      if (restored.rows[0] === undefined ||
          completed.rows.length !== actions.rows.length ||
          resolutionDeleted.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: provisional refusal CAS failed.");
      }
    });
  }

  beginDisposition(input: Parameters<LandingResolutionFinalizer["beginDisposition"]>[0]): Promise<void> {
    return this.#sql.transaction(async (tx) => {
      const at = new Date(input.now);
      const currentEvidence = await lockCurrentEvidenceCitation(tx, input.resolutionId);
      if (currentEvidence.evidenceDigest !== input.evidence.evidenceDigest) {
        throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence changed.");
      }
      const locks = await lockPositionSequence(tx, input);
      const resolution = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.beginResolutionLock */ select resolution_id from lp_landing_resolutions
         where resolution_id=$1 and phase='evidence-bound' and row_version=$2 and
          evidence_hash=$3 and outcome=$4 for update`, [input.resolutionId,
          input.expectedResolutionRowVersion, input.evidence.evidenceDigest, input.evidence.outcome],
      );
      if (!locks || resolution.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: evidence disposition CAS failed.");
      }
      const resolutionUpdate = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.beginResolution */ update lp_landing_resolutions set
          phase='disposition-started',row_version=row_version+1,updated_at=$3
          where resolution_id=$1 and row_version=$2 and phase='evidence-bound'
          returning resolution_id`, [input.resolutionId, input.expectedResolutionRowVersion, at],
      );
      const sequenceUpdate = await tx.query<{ sequence_id: string }>(
        `/* landingFinalize.beginSequence */ update lp_sequences set
          resolution_disposition_started=true,resolver_row_version=resolver_row_version+1,
          updated_at=$7 where sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
          state='resolving' and resolution_id=$4 and resolver_fence=$5::numeric and
          resolver_row_version=$6 and resolution_disposition_started=false returning sequence_id`,
        [input.sequenceId, input.agentId, input.owner, input.resolutionId,
          input.resolverFence.toString(10), input.expectedResolverRowVersion, at],
      );
      if (resolutionUpdate.rows[0] === undefined || sequenceUpdate.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: evidence disposition CAS failed.");
      }
    });
  }

  writeJournalDisposition(
    input: Parameters<LandingResolutionFinalizer["writeJournalDisposition"]>[0],
  ): Promise<void> {
    return this.#sql.transaction(async (tx) => {
      const at = new Date(input.now);
      await lockCurrentEvidenceCitation(tx, input.resolutionId);
      const locks = await lockPositionSequence(tx, input, true);
      const journal = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.writeJournalLock */ select idempotency_key from execution_journal
         where idempotency_key=$1 and state='UNKNOWN' and landing_resolution_id is null and
          landing_resolution_key_hash is null and landing_resolution_outcome is null and
          landing_resolution_evidence_hash is null and landing_resolution_terminal_at is null
         for update`, [input.journalIdempotencyKey],
      );
      const resolution = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.writeResolutionLock */ select resolution_id from lp_landing_resolutions
         where resolution_id=$1 and phase='disposition-started' and row_version=$2 and outcome=$3
         for update`, [input.resolutionId, input.expectedResolutionRowVersion, input.outcome],
      );
      if (!locks || journal.rows[0] === undefined || resolution.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: journal disposition lock set failed.");
      }
      const state = input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK";
      const journalUpdate = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.writeJournal */ update execution_journal set state=$2,
          external_ref=case when $3::text is null then external_ref else
            jsonb_set(external_ref,'{txHash}',to_jsonb($3::text),true) end,
          landing_resolution_id=$4,landing_resolution_key_hash=$5,updated_at=$6
         where idempotency_key=$1 and state='UNKNOWN' and landing_resolution_id is null
         returning idempotency_key`, [input.journalIdempotencyKey, state,
          input.txHash ?? null, input.resolutionId, input.resolutionKeyHash, at],
      );
      const resolutionUpdate = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.writeResolution */ update lp_landing_resolutions set
          phase='journal-written',target_journal_terminal_state=$3,response_action=$4,
          row_version=row_version+1,updated_at=$5 where resolution_id=$1 and row_version=$2 and
          phase='disposition-started' returning resolution_id`, [input.resolutionId,
          input.expectedResolutionRowVersion, state,
          input.outcome === "landed" ? "resume-committed" : "retire-not-landed", at],
      );
      if (journalUpdate.rows[0] === undefined || resolutionUpdate.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: journal disposition CAS failed.");
      }
    });
  }

  writeRecovery(input: Parameters<LandingResolutionFinalizer["writeRecovery"]>[0]): Promise<void> {
    return this.#sql.transaction(async (tx) => {
      const at = new Date(input.now);
      await lockCurrentEvidenceCitation(tx, input.resolutionId);
      const locks = await lockPositionSequence(tx, input, true);
      const journal = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.recoveryJournalLock */ select idempotency_key from execution_journal
         where idempotency_key=$1 and state=$2 and landing_resolution_id=$3 and
          landing_resolution_key_hash=$4 and landing_resolution_outcome is null and
          landing_resolution_evidence_hash is null and landing_resolution_terminal_at is null
         for update`, [input.journalIdempotencyKey,
          input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK",
          input.resolutionId, input.resolutionKeyHash],
      );
      const resolution = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.recoveryResolutionLock */ select resolution_id from
         lp_landing_resolutions where resolution_id=$1 and phase='journal-written' and
         row_version=$2 and outcome=$3 for update`,
        [input.resolutionId, input.expectedResolutionRowVersion, input.outcome],
      );
      if (!locks || journal.rows[0] === undefined || resolution.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: recovery lock set failed.");
      }
      const sequence = await tx.query<{ sequence_id: string }>(
        `/* landingFinalize.recoverySequence */ update lp_sequences set recovery_state=$7,
         note=$8,resolver_row_version=resolver_row_version+1,updated_at=$9 where sequence_id=$1 and
         agent_id=$2 and lower(owner_address)=lower($3) and state='resolving' and resolution_id=$4 and
         resolver_fence=$5::numeric and resolver_row_version=$6 and
         resolution_disposition_started=true returning sequence_id`, [input.sequenceId,
          input.agentId, input.owner, input.resolutionId, input.resolverFence.toString(10),
          input.expectedResolverRowVersion, input.recoveryState, input.note, at],
      );
      const advanced = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.recoveryResolution */ update lp_landing_resolutions set
         phase='recovery-written',recovery_after_confirm=$3,row_version=row_version+1,
         updated_at=$4 where resolution_id=$1 and row_version=$2 and phase='journal-written'
         returning resolution_id`, [input.resolutionId, input.expectedResolutionRowVersion,
          input.recoveryState, at],
      );
      if (sequence.rows[0] === undefined || advanced.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: recovery CAS failed.");
      }
    });
  }

  postprocess(input: Parameters<LandingResolutionFinalizer["postprocess"]>[0]): Promise<void> {
    return this.#sql.transaction(async (tx) => {
      const at = new Date(input.now);
      await lockCurrentEvidenceCitation(tx, input.resolutionId);
      const position = await tx.query<{ position_id: string; state: string; row_version: string }>(
        `/* landingFinalize.postPositionLock */ select position_id,state,row_version from lp_positions
         where position_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and row_version=$4 for update`,
        [input.positionId, input.agentId, input.owner, input.expectedPositionVersion],
      );
      const sequence = await tx.query<{ sequence_id: string }>(
        `/* landingFinalize.postSequenceLock */ select sequence_id from lp_sequences where
         sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and position_id=$4 and
         state='resolving' and resolution_id=$5 and resolver_fence=$6::numeric and
         resolver_row_version=$7 and resolution_disposition_started=true for update`,
        [input.sequenceId, input.agentId, input.owner, input.positionId, input.resolutionId,
          input.resolverFence.toString(10), input.expectedResolverRowVersion],
      );
      const journal = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.postJournalLock */ select idempotency_key from execution_journal where
         idempotency_key=$1 and state=$2 and landing_resolution_id=$3 and
         landing_resolution_key_hash=$4 and landing_resolution_outcome is null and
         landing_resolution_evidence_hash is null and landing_resolution_terminal_at is null
         for update`, [input.journalIdempotencyKey,
          input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK",
          input.resolutionId, input.resolutionKeyHash],
      );
      const resolution = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.postResolutionLock */ select resolution_id from lp_landing_resolutions
         where resolution_id=$1 and phase='recovery-written' and row_version=$2 and outcome=$3
         for update`, [input.resolutionId, input.expectedResolutionRowVersion, input.outcome],
      );
      if (position.rows[0] === undefined || sequence.rows[0] === undefined ||
          journal.rows[0] === undefined || resolution.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: post-process lock set failed.");
      }
      let touchedSequence = false;
      if (input.positionMutation !== "none") {
        const update = input.positionMutation === "attach-token"
          ? await tx.query<{ position_id: string }>(
            `/* landingFinalize.postAttachToken */ update lp_positions set token_id=$5,
             row_version=row_version+1,updated_at=$6 where position_id=$1 and agent_id=$2 and
             lower(owner_address)=lower($3) and row_version=$4 and state<>'closed' returning position_id`,
            [input.positionId, input.agentId, input.owner, input.expectedPositionVersion,
              input.tokenId ?? null, at])
          : input.positionMutation === "close"
            ? await tx.query<{ position_id: string }>(
              `/* landingFinalize.postClose */ update lp_positions set state='closed',basis_wei=0,
               row_version=row_version+1,updated_at=$5 where position_id=$1 and agent_id=$2 and
               lower(owner_address)=lower($3) and row_version=$4 and state<>'closed' returning position_id`,
              [input.positionId, input.agentId, input.owner, input.expectedPositionVersion, at])
            : await tx.query<{ position_id: string }>(
              `/* landingFinalize.postOpen */ update lp_positions set state='open',
               row_version=row_version+1,updated_at=$5 where position_id=$1 and agent_id=$2 and
               lower(owner_address)=lower($3) and row_version=$4 and state='closing' returning position_id`,
              [input.positionId, input.agentId, input.owner, input.expectedPositionVersion, at]);
        if (update.rows[0] === undefined) {
          throw new Error("RESOLUTION_STATE_CONFLICT: position post-process CAS failed.");
        }
        touchedSequence = true;
      }
      if (input.releaseReservation) {
        await tx.query(`/* landingFinalize.postReservationRelease */ update lp_exit_reservations
         set released_at=$4 where sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
         released_at is null`, [input.sequenceId, input.agentId, input.owner, at]);
      }
      if (touchedSequence) {
        const touched = await tx.query<{ sequence_id: string }>(
          `/* landingFinalize.postSequenceTouch */ update lp_sequences set
           resolver_row_version=resolver_row_version+1,updated_at=$7 where sequence_id=$1 and
           agent_id=$2 and lower(owner_address)=lower($3) and state='resolving' and resolution_id=$4 and
           resolver_fence=$5::numeric and resolver_row_version=$6 returning sequence_id`,
          [input.sequenceId, input.agentId, input.owner, input.resolutionId,
            input.resolverFence.toString(10), input.expectedResolverRowVersion, at],
        );
        if (touched.rows[0] === undefined) {
          throw new Error("RESOLUTION_STATE_CONFLICT: post-process sequence fence lost.");
        }
      }
      const advanced = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.postResolution */ update lp_landing_resolutions set
         phase='postprocessed',row_version=row_version+1,updated_at=$3 where resolution_id=$1 and
         row_version=$2 and phase='recovery-written' returning resolution_id`,
        [input.resolutionId, input.expectedResolutionRowVersion, at],
      );
      if (advanced.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: post-process resolution CAS failed.");
      }
    });
  }

  finalize(input: LandingFinalizerInput): Promise<void> {
    return this.#sql.transaction(async (tx) => {
      const terminalAt = new Date(input.now);
      const retainedUntil = new Date(input.now + this.#retentionDays * 86_400_000);
      const currentEvidence = await lockCurrentEvidenceCitation(tx, input.resolutionId);
      if (currentEvidence.evidenceDigest !== input.evidenceHash ||
          currentEvidence.outcome !== input.outcome) {
        throw new Error("RESOLUTION_STATE_CONFLICT: terminal evidence changed.");
      }
      // Mandatory lock order: position, sequence, target journal, resolution.
      const position = await tx.query<{ position_id: string }>(
        `/* landingFinalize.positionLock */ select position_id from lp_positions
         where position_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) for update`,
        [input.positionId, input.agentId, input.owner],
      );
      const sequence = await tx.query<{ sequence_id: string }>(
        `/* landingFinalize.sequenceLock */ select sequence_id from lp_sequences
         where sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and state='resolving' and
          resolution_id=$4 and resolver_fence=$5::numeric and resolver_row_version=$6 for update`,
        [input.sequenceId, input.agentId, input.owner, input.resolutionId,
          input.resolverFence.toString(10), input.expectedResolverRowVersion],
      );
      const journal = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.journalLock */ select idempotency_key from execution_journal
         where idempotency_key=$1 and landing_resolution_id=$2 and
          landing_resolution_key_hash=$3 and state=$4 and landing_resolution_outcome is null and
          landing_resolution_evidence_hash is null and landing_resolution_terminal_at is null
         for update`, [input.journalIdempotencyKey, input.resolutionId, input.resolutionKeyHash,
          input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK"],
      );
      const resolution = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.resolutionLock */ select resolution_id from lp_landing_resolutions
         where resolution_id=$1 and phase='postprocessed' and row_version=$2 and outcome=$3 and
          evidence_hash=$4 and target_journal_terminal_state=$5 and response_inference=$3 and
          response_action=$6 and recovery_after_confirm is not null for update`,
        [input.resolutionId, input.expectedResolutionRowVersion, input.outcome,
          input.evidenceHash, input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK",
          input.outcome === "landed" ? "resume-committed" : "retire-not-landed"],
      );
      if (position.rows[0] === undefined || sequence.rows[0] === undefined ||
          journal.rows[0] === undefined || resolution.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: terminal lock set is inconsistent.");
      }
      const action = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.actionLock */ select idempotency_key from execution_journal where
         idempotency_key=$1 and kind='resolveUnknownLandingV1' and agent_id=$2 and
         lower(owner_address)=lower($3) and landing_resolution_id=$4 and
         state in ('PENDING','IN_PROGRESS') for update`,
        [input.terminalizingAction.idempotencyKey, input.agentId, input.owner,
          input.resolutionId],
      );
      if (action.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: terminal action lock is inconsistent.");
      }
      const evidence = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.evidenceRetain */ update lp_landing_resolution_evidence
         set retained_until=$3 where resolution_id=$1 and evidence_hash=$2 and retained_until is null
          and charged_logical_bytes=$4::bigint returning resolution_id`, [input.resolutionId,
          input.evidenceHash, retainedUntil,
          resolutionEvidenceChargedLogicalBytes(input.resolutionId).toString(10)],
      );
      const requirement = await tx.query<{ journal_idempotency_key: string }>(
        `/* landingFinalize.requirementTerminal */ update lp_evidence_requirements set
          state='terminal',terminal_at=$5,evidence_retained_until=$6,updated_at=$5,
          row_version=row_version+1 where lower(journal_owner)=lower($1) and journal_agent=$2 and
          journal_action='lp' and journal_idempotency_key=$3 and state='eligible' and
          unavailable_code is null and lane_id=$4 and charged_logical_bytes=$7::bigint and
          coverage_generation=$8::bigint and row_version=$9::bigint
         returning journal_idempotency_key`, [input.owner, input.agentId,
          input.journalIdempotencyKey,
          currentEvidence.laneId, terminalAt, retainedUntil,
          requirementChargedLogicalBytes({ journalOwner: input.owner,
            journalAgent: input.agentId, journalAction: "lp",
            journalIdempotencyKey: input.journalIdempotencyKey }).toString(10),
          currentEvidence.requirementGeneration, currentEvidence.requirementRowVersion],
      );
      const journalUpdated = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.journalTerminal */ update execution_journal set
          landing_resolution_outcome=$4,landing_resolution_evidence_hash=$5,
          landing_resolution_terminal_at=$6,updated_at=$6 where idempotency_key=$1 and
          landing_resolution_id=$2 and landing_resolution_key_hash=$3 and
          landing_resolution_outcome is null and landing_resolution_evidence_hash is null and
          landing_resolution_terminal_at is null returning idempotency_key`,
        [input.journalIdempotencyKey, input.resolutionId, input.resolutionKeyHash,
          input.outcome, input.evidenceHash, terminalAt],
      );
      const resolutionUpdated = await tx.query<{ resolution_id: string }>(
        `/* landingFinalize.resolutionTerminal */ update lp_landing_resolutions set
          phase='terminal',sequence_state_at_resolution=$3,evidence_retained_until=$4,
          terminal_at=$5,terminalizing_action_owner=$6,terminalizing_action_agent=$7,
          terminalizing_action_kind=$8,terminalizing_action_idempotency_key=$9,
          row_version=row_version+1,updated_at=$5 where resolution_id=$1 and row_version=$2 and
          phase='postprocessed' returning resolution_id`,
        [input.resolutionId, input.expectedResolutionRowVersion, input.targetSequenceState,
          retainedUntil, terminalAt, input.terminalizingAction.owner,
          input.terminalizingAction.agent, input.terminalizingAction.kind,
          input.terminalizingAction.idempotencyKey],
      );
      const actionUpdated = await tx.query<{ idempotency_key: string }>(
        `/* landingFinalize.actionComplete */ update execution_journal set state='COMMITTED',
         external_ref=coalesce(external_ref,'{}'::jsonb) || jsonb_build_object(
          'landingAction',jsonb_build_object('scheme','resolve-landing-action-v1',
           'resolutionId',$2::text,'state','TERMINAL','completionRole','terminalizer'),
          'landingResult',jsonb_build_object('decisionId',$3::text,'outcome',$4::text,
           'action',$5::text,'journalState',$6::text,'inference',$4::text,
           'resolutionId',$2::text,'evidenceDigest',$7::text,
           'evidenceRetainedUntil',$8::text,'replayed',false)),updated_at=$9
         where idempotency_key=$1 and kind='resolveUnknownLandingV1' and
          landing_resolution_id=$2 and state in ('PENDING','IN_PROGRESS')
         returning idempotency_key`, [input.terminalizingAction.idempotencyKey,
          input.resolutionId, input.decisionId, input.outcome,
          input.outcome === "landed" ? "resume-committed" : "retire-not-landed",
          input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK",
          input.evidenceHash, retainedUntil.toISOString(), terminalAt],
      );
      // The sequence is the last row released: until this CAS succeeds the
      // ordinary worker cannot observe any partially terminal disposition.
      const sequenceUpdated = await tx.query<{ sequence_id: string }>(
        `/* landingFinalize.sequenceRelease */ update lp_sequences set state=$7,
          resolver_prior_state=null,resolver_prior_recovery_state=null,resolver_lease_until=null,
          resolver_snapshot_hash=null,resolution_id=null,resolver_action_idempotency_key=null,
          resolution_disposition_started=false,resolver_row_version=resolver_row_version+1,
          updated_at=$8 where sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and
          state='resolving' and resolution_id=$4 and resolver_fence=$5::numeric and
          resolver_row_version=$6 returning sequence_id`, [input.sequenceId, input.agentId,
          input.owner, input.resolutionId, input.resolverFence.toString(10),
          input.expectedResolverRowVersion, input.targetSequenceState, terminalAt],
      );
      if (evidence.rows[0] === undefined || requirement.rows[0] === undefined ||
          journalUpdated.rows[0] === undefined || resolutionUpdated.rows[0] === undefined ||
          sequenceUpdated.rows[0] === undefined || actionUpdated.rows[0] === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: terminal CAS set is inconsistent.");
      }
    });
  }

  close(): Promise<void> { return this.#sql.close(); }
}

/**
 * Holds the cursor share lock through the caller's phase transaction. Rewind
 * takes the conflicting cursor update lock, so the generation cannot change
 * between this exact citation check and the disposition write.
 */
async function lockCurrentEvidenceCitation(
  sql: SqlClient,
  resolutionId: string,
): Promise<LandingEvidenceV1> {
  const stored = await sql.query<{ evidence_bytes: string; evidence_hash: Hex;
    coverage_version: Hex; quorum_id: Hex; lane_id: Hex; generation: string;
    cursor_row_version: string }>(
      `/* landingFinalize.phaseEvidenceLock */ select evidence_bytes,evidence_hash,
       coverage_version,quorum_id,lane_id,generation,cursor_row_version
       from lp_landing_resolution_evidence where resolution_id=$1 for share`, [resolutionId],
    );
  const row = stored.rows[0];
  if (row === undefined) {
    throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence is missing.");
  }
  let evidence: LandingEvidenceV1;
  try {
    evidence = JSON.parse(row.evidence_bytes) as LandingEvidenceV1;
    const { evidenceDigest, ...body } = evidence;
    if (canonicalLandingEvidence(body).evidenceDigest !== evidenceDigest ||
        evidenceDigest !== row.evidence_hash || evidence.coverageVersion !== row.coverage_version ||
        evidence.quorumId !== row.quorum_id || evidence.laneId !== row.lane_id ||
        evidence.generation !== String(row.generation) ||
        evidence.cursorRowVersion !== String(row.cursor_row_version)) {
      throw new Error("citation mismatch");
    }
  } catch {
    throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence is malformed.");
  }
  await lockEvidenceAuthority(sql, resolutionId, evidence);
  return evidence;
}

/**
 * Locks the cursor first and then the canonical requirement, matching rewind's
 * ordering. The requirement row is part of the citation rather than mutable
 * observer input; every disposition phase therefore aborts before its first
 * write if reorg handling changed state, reason, generation or row version.
 */
async function lockEvidenceAuthority(
  sql: SqlClient,
  resolutionId: string,
  evidence: LandingEvidenceV1,
): Promise<void> {
  const cursor = await sql.query<{ lane_id: string }>(
    `/* landingFinalize.phaseCursorValidate */ select lane_id from lp_evidence_cursors where
      coverage_version=$1 and quorum_id=$2 and lane_id=$3 and generation=$4::bigint and
      row_version>=$5 and state='active' and covered_through>=$6::numeric and
      (select count(distinct source_id) from lp_evidence_blocks where lane_id=$3 and
        generation=$4::bigint and block_number=$6::numeric and block_hash=$7 and
        source_id=any($8::varchar[]))=$9 and ($10='absent' or
      (select count(distinct source_id) from lp_evidence_candidates where lane_id=$3 and
        generation=$4::bigint and transaction_hash=$11 and input_hash=$12 and
        block_number=$13::numeric and block_hash=$14 and transaction_index=$15::numeric and
        intent_index=$16 and log_index=$17::numeric and event_topics_hash=$18 and
        event_data_hash=$19 and receipt_status=1 and incremented=true and
        event_error='0x00000000' and source_id=any($8::varchar[]))=$9) for share`,
    [evidence.coverageVersion, evidence.quorumId, evidence.laneId, evidence.generation,
      evidence.cursorRowVersion, evidence.toBlock, evidence.toBlockHash,
      evidence.requiredSourceIds, evidence.requiredSourceIds.length, evidence.outcome,
      evidence.landed?.txHash ?? null, evidence.landed?.inputHash ?? null,
      evidence.landed?.blockNumber ?? null, evidence.landed?.blockHash ?? null,
      evidence.landed?.transactionIndex ?? null, evidence.landed?.intentIndex ?? null,
      evidence.landed?.logIndex ?? null, evidence.landed?.eventTopicsHash ?? null,
      evidence.landed?.eventDataHash ?? null],
  );
  if (cursor.rows[0] === undefined) {
    throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence was invalidated.");
  }
  const requirement = await sql.query<{ journal_owner: string }>(
    `/* landingFinalize.phaseRequirementValidate */ select r.journal_owner from
     lp_landing_resolutions lr join lp_evidence_requirements r on
      lower(r.journal_owner)=lower(lr.target_owner) and r.journal_agent=lr.target_agent and
      r.journal_action=lr.target_journal_action and
      r.journal_idempotency_key=lr.target_journal_idempotency_key
     where lr.resolution_id=$1 and r.state='eligible' and r.unavailable_code is null and
      r.prepared_identity_hash=$2 and r.coverage_version=$3 and r.quorum_id=$4 and
      r.lane_id=$5 and r.coverage_generation=$6::bigint and r.row_version=$7::bigint and
      r.begun_at_block=$8::numeric for share of r`, [resolutionId,
      evidence.preparedIdentityHash, evidence.coverageVersion, evidence.quorumId,
      evidence.laneId, evidence.requirementGeneration, evidence.requirementRowVersion,
      evidence.fromBlock],
  );
  if (requirement.rows.length !== 1) {
    throw new Error("RESOLUTION_STATE_CONFLICT: evidence requirement is no longer eligible.");
  }
}

async function lockPositionSequence(
  sql: SqlClient,
  input: { readonly owner: Address; readonly agentId: string; readonly positionId: string;
    readonly sequenceId: string; readonly resolutionId: string; readonly resolverFence: bigint;
    readonly expectedResolverRowVersion: number },
  requireStarted = false,
): Promise<boolean> {
  const position = await sql.query<{ position_id: string }>(
    `/* landingFinalize.phasePositionLock */ select position_id from lp_positions
     where position_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) for update`,
    [input.positionId, input.agentId, input.owner],
  );
  const sequence = await sql.query<{ sequence_id: string }>(
    `/* landingFinalize.phaseSequenceLock */ select sequence_id from lp_sequences
     where sequence_id=$1 and agent_id=$2 and lower(owner_address)=lower($3) and state='resolving' and
      resolution_id=$4 and resolver_fence=$5::numeric and resolver_row_version=$6 and
      resolution_disposition_started=$7 for update`, [input.sequenceId, input.agentId,
      input.owner, input.resolutionId, input.resolverFence.toString(10),
      input.expectedResolverRowVersion, requireStarted],
  );
  return position.rows[0] !== undefined && sequence.rows[0] !== undefined;
}

export async function createLandingResolutionFinalizer(
  config: LpEvidenceConfig,
  databaseUrl: string | undefined = process.env["DATABASE_URL"],
): Promise<LandingResolutionFinalizer | undefined> {
  const url = databaseUrl?.trim() ?? "";
  return url === "" ? undefined :
    new PostgresLandingResolutionFinalizer(await createPgSqlClient(url), config);
}
