/**
 * An in-memory `SqlClient` for offline tests.
 *
 * It is NOT a SQL parser. Every statement the Postgres stores issue carries a
 * leading `/* tag *\/` comment; this fake dispatches on that tag and manipulates
 * plain Maps with the same semantics the real database would — owner scoping,
 * ON CONFLICT dedupe, RETURNING, jsonb round-trips through parse/serialize, and
 * a global transaction lock standing in for `select ... for update`.
 *
 * Running the Postgres store through this proves its parameter ordering, jsonb
 * encoding, owner normalization and row mapping without a live database. It is
 * a test double, not a second production store.
 */
/*
 * A WARNING THE AUDIT MADE NECESSARY (PHASE3.7-AUDIT A6).
 *
 * This client dispatches on the leading tag comment of each statement and
 * NEVER PARSES THE SQL. Every predicate below is a hand-written re-statement
 * of a real query, so editing a real `where` / `filter` clause and forgetting
 * the fake leaves that edit with ZERO executed coverage while the suite stays
 * green — measured: dropping `and quota_bound` from the real
 * `lpReservations.quotaUsage` statement killed no test.
 *
 * Cross-implementation tests therefore prove the two AGREE, not that either
 * matches the database. Where a raw predicate is load-bearing, pin it at the
 * TEXT level as well; `test/lpQuotaRelease.test.ts` does this for the F2
 * conjuncts.
 */
import type { SqlClient, SqlResult } from "../../src/store/sql.js";
// FIXREVIEW F4: the lending status predicates are DERIVED from the same
// transition table the real statements interpolate, so the "restated by hand"
// hazard this file warns about cannot apply to them: there is one list.
import { LENDING_GUARD_CAS_SOURCES } from "../../src/store/lendingGuards.js";

type Row = Record<string, unknown>;

function tagOf(text: string): string | undefined {
  return /\/\*\s*([\w.]+)\s*\*\//.exec(text)?.[1];
}

function jsonbParam(value: unknown): unknown {
  // The store passes jsonb as a JSON string (or null); pg stores and returns it
  // as a parsed object. PostgreSQL JSONB does not preserve insertion order, so
  // normalize every object recursively instead of accidentally retaining the
  // caller's descriptor spelling.  This catches code that mistakes a JSON
  // serialization detail for a permissions-identity comparison.
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return reorderJsonb(parsed);
}

function reorderJsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderJsonb);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, reorderJsonb(child)]));
}

function sameOwner(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase();
}

export class FakeSqlClient implements SqlClient {
  readonly #agents = new Map<string, Row>();
  readonly #health = new Map<string, Row>();
  readonly #journal = new Map<string, Row>();
  readonly #nonces = new Map<string, Row>();
  readonly #runtimeReplays = new Map<string, Row>();
  readonly #pauses = new Map<string, Row>();
  readonly #halt = new Map<string, Row>();
  /** PHASE3.19 R4.1 — the append-only VWAP-book credit set, keyed on the step's journal idempotency key. */
  readonly #lpInventoryCredits = new Map<string, Row>();
  readonly #lpPositions = new Map<string, Row>();
  readonly #lpSequences = new Map<string, Row>();
  readonly #lpReservations = new Map<string, Row>();
  readonly #lpSettings = new Map<string, Row>();
  readonly #lpObservations = new Map<string, Row>();
  readonly #gridCycles = new Map<string, Row>();
  readonly #lpEvidenceRequirements = new Map<string, Row>();
  readonly #lpLandingResolutions = new Map<string, Row>();
  readonly #lpLandingEvidence = new Map<string, Row>();
  readonly #lpEvidenceQuotas = new Map<string, Row>();
  readonly #lpCoverageCursors = new Map<string, Row>();
  readonly #lpCoverageChunks = new Map<string, Row>();
  readonly #lpCoverageLeases = new Map<string, Row>();
  readonly #lpCoverageBackfillBudgets = new Map<string, Row>();
  readonly #lpCoveragePrefixes = new Map<string, Row>();
  readonly #lpCoverageBlocks = new Map<string, Row>();
  readonly #lpCoverageCandidates = new Map<string, Row>();
  readonly #venusSettings = new Map<string, Row>();
  readonly #venusObservations = new Map<string, Row>();
  readonly #venusActions = new Map<string, Row>();
  /** MARKETPLACE-LENDING-AGENT: the guard row and its four satellite tables. */
  readonly #lendingGuards = new Map<string, Row>();
  readonly #lendingRescues = new Map<string, Row>();
  readonly #lendingActions = new Map<string, Row>();
  readonly #lendingSnapshots = new Map<string, Row>();
  readonly #lendingSettings = new Map<string, Row>();
  readonly #lendingObservations = new Map<string, Row>();
  readonly #billingState = new Map<string, Row>();
  readonly #billingAccounts = new Map<string, Row>();
  readonly #billingUsageIdentities = new Map<string, Row>();
  readonly #billingAttemptLeases = new Map<string, Row>();
  readonly #billingInvoiceMembers = new Map<string, Row>();
  readonly #billingCloseClaims = new Map<string, Row>();
  readonly #billingSpendLedger = new Map<string, Row>();
  #lock: Promise<unknown> = Promise.resolve();
  readonly #advisoryLockTails = new Map<string, Promise<void>>();
  readonly #observedStatements: string[] = [];
  #failNextTag: { readonly tag: string; remaining: number } | null = null;
  readonly #strictLpRequirementAuthorization: boolean;
  readonly #interleaveTransactions: boolean;

  constructor(options: {
    readonly strictLpRequirementAuthorization?: boolean;
    /**
     * H6.1: let transaction callbacks overlap so an advisory-lock mutation is
     * observable. The default remains the coarse serialized fake used by the
     * older cross-store suites.
     */
    readonly interleaveTransactions?: boolean;
  } = {}) {
    // Old shared fixtures constructed coverage snapshots directly, before the
    // evidence store owned durable requirement admission. Production SQL never
    // has this fallback. New authorization-boundary tests opt into strict mode
    // so a missing durable row is exercised as a hard veto.
    this.#strictLpRequirementAuthorization =
      options.strictLpRequirementAuthorization ?? false;
    this.#interleaveTransactions = options.interleaveTransactions ?? false;
  }

  observedStatementsForTest(): readonly string[] {
    return [...this.#observedStatements];
  }

  clearObservedStatementsForTest(): void {
    this.#observedStatements.length = 0;
  }

  /** AUDIT A7: simulate a pre-3.24 SQL row without changing production SQL. */
  setLpSequenceInlineConvertForTest(sequenceId: string, value: boolean | null): void {
    const row = this.#lpSequences.get(sequenceId);
    if (row === undefined) throw new Error(`No fake LP sequence row ${sequenceId}.`);
    row["inline_convert"] = value;
  }

  /** R5: inject raw JSONB corruption, distinguishing JSON null from SQL NULL. */
  setAgentSessionStateForTest(id: string, column: "session_facts" | "session_revocation", json: string | null): void {
    const row = this.#agents.get(id);
    if (row === undefined) throw new Error(`No fake agent row ${id}.`);
    row[column] = jsonbParam(json);
    row[`${column}_sql_null`] = json === null;
  }

  setAgentIdentityForTest(id: string, json: string | null): void {
    const row = this.#agents.get(id);
    if (row === undefined) throw new Error("Missing fake identity source.");
    row["erc8004_identity"] = jsonbParam(json);
    row["identity_absent"] = json === null;
  }

  failNextQuery(tag: string, occurrence = 1): void {
    if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
      throw new Error("FakeSql failure occurrence must be a positive integer.");
    }
    this.#failNextTag = { tag, remaining: occurrence };
  }

  async query<R = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<R>> {
    this.#observedStatements.push(text);
    const tag = tagOf(text);
    if (tag !== undefined && tag === this.#failNextTag?.tag) {
      this.#failNextTag.remaining -= 1;
      if (this.#failNextTag.remaining === 0) {
        this.#failNextTag = null;
        throw new Error(`FakeSql injected failure at ${tag}`);
      }
    }
    const rows = this.#dispatch(tag, params);
    if (text.includes("as identity_absent")) {
      for (const row of rows) row["identity_absent"] ??= row["erc8004_identity"] == null;
    }
    if (text.includes("as session_state_empty")) {
      for (const row of rows) row["session_state_empty"] =
        (row["session_facts_sql_null"] ?? row["session_facts"] === null)
        && (row["session_revocation_sql_null"] ?? row["session_revocation"] === null);
    }
    return { rows: structuredClone(rows) as R[] };
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    if (this.#interleaveTransactions) {
      const releases: (() => void)[] = [];
      const heldKeys = new Set<string>();
      const tx: SqlClient = {
        query: async <R = Record<string, unknown>>(
          text: string,
          params: readonly unknown[] = [],
        ): Promise<SqlResult<R>> => {
          const statement = text
            .replace(/\/\*[\s\S]*?\*\//gu, "")
            .replace(/\s+/gu, " ")
            .trim()
            .toLowerCase();
          if (
            statement === "select pg_advisory_xact_lock(hashtext($1))"
            && typeof params[0] === "string"
            && !heldKeys.has(params[0])
          ) {
            heldKeys.add(params[0]);
            releases.push(await this.#acquireAdvisoryLock(params[0]));
          }
          return (this as SqlClient).query<R>(text, params);
        },
        transaction: (nested) => nested(tx),
        close: async () => undefined,
      };
      try {
        return await fn(tx);
      } finally {
        for (const release of releases.reverse()) release();
      }
    }
    // Serialize whole transactions: a coarse but sufficient stand-in for row
    // locking. Snapshot/restore also mirrors PostgreSQL rollback so an injected
    // fault after a chunk split cannot leak a half-carried generation.
    const run = this.#lock.catch(() => undefined).then(async () => {
      const stores: Map<string, Row>[] = [this.#agents, this.#health, this.#journal,
        this.#nonces, this.#runtimeReplays, this.#pauses, this.#halt, this.#lpPositions, this.#lpSequences,
        this.#lpReservations, this.#lpSettings, this.#lpObservations, this.#gridCycles,
        this.#lpEvidenceRequirements, this.#lpLandingResolutions, this.#lpLandingEvidence,
        this.#lpEvidenceQuotas, this.#lpCoverageCursors, this.#lpCoverageChunks,
        this.#lpCoverageLeases, this.#lpCoverageBackfillBudgets, this.#lpCoveragePrefixes,
        this.#lpCoverageBlocks, this.#lpCoverageCandidates,
        this.#venusSettings, this.#venusObservations, this.#venusActions,
        this.#billingState, this.#billingAccounts, this.#billingUsageIdentities,
        this.#billingAttemptLeases, this.#billingInvoiceMembers, this.#billingCloseClaims,
        this.#billingSpendLedger];
      const snapshots = stores.map((store) => structuredClone([...store.entries()]));
      try {
        return await fn(this);
      } catch (error) {
        stores.forEach((store, index) => {
          store.clear();
          for (const [key, row] of snapshots[index] ?? []) store.set(key, row);
        });
        throw error;
      }
    });
    this.#lock = run.catch(() => undefined);
    return run;
  }

  async #acquireAdvisoryLock(key: string): Promise<() => void> {
    const previous = this.#advisoryLockTails.get(key) ?? Promise.resolve();
    let releaseCurrent = (): void => undefined;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    this.#advisoryLockTails.set(key, current);
    await previous.catch(() => undefined);
    return () => {
      releaseCurrent();
      if (this.#advisoryLockTails.get(key) === current) {
        this.#advisoryLockTails.delete(key);
      }
    };
  }

  async close(): Promise<void> {
    this.#agents.clear();
    this.#health.clear();
    this.#journal.clear();
    this.#nonces.clear();
    this.#runtimeReplays.clear();
    this.#pauses.clear();
    this.#halt.clear();
    this.#lpPositions.clear();
    this.#lpInventoryCredits.clear();
    this.#lpSequences.clear();
    this.#lpReservations.clear();
    this.#lpSettings.clear();
    this.#lpObservations.clear();
    this.#gridCycles.clear();
    this.#lpEvidenceRequirements.clear();
    this.#lpLandingResolutions.clear();
    this.#lpLandingEvidence.clear();
    this.#lpEvidenceQuotas.clear();
    this.#lpCoverageCursors.clear();
    this.#lpCoverageChunks.clear();
    this.#lpCoverageLeases.clear();
    this.#lpCoverageBackfillBudgets.clear();
    this.#lpCoveragePrefixes.clear();
    this.#lpCoverageBlocks.clear();
    this.#lpCoverageCandidates.clear();
    this.#venusSettings.clear();
    this.#venusObservations.clear();
    this.#venusActions.clear();
    this.#lendingGuards.clear();
    this.#lendingRescues.clear();
    this.#lendingActions.clear();
    this.#lendingSnapshots.clear();
    this.#lendingSettings.clear();
    this.#lendingObservations.clear();
    this.#billingState.clear();
    this.#billingAccounts.clear();
    this.#billingUsageIdentities.clear();
    this.#billingAttemptLeases.clear();
    this.#billingInvoiceMembers.clear();
    this.#billingCloseClaims.clear();
    this.#billingSpendLedger.clear();
  }

  #dispatch(tag: string | undefined, params: readonly unknown[]): Row[] {
    switch (tag) {
      case "billing.state.init": {
        if (!this.#billingState.has("singleton")) this.#billingState.set("singleton", { payload: jsonbParam(params[0]) });
        return [];
      }
      case "billing.state.read": {
        const row = this.#billingState.get("singleton");
        return row === undefined ? [] : [structuredClone(row)];
      }
      case "billing.state.write": {
        this.#billingState.set("singleton", { payload: jsonbParam(params[0]) });
        return [];
      }
      case "billing.projection.ledgerClear":
        this.#billingSpendLedger.clear();
        return [];
      case "billing.projection.closeClaimsClear":
        this.#billingCloseClaims.clear();
        return [];
      case "billing.projection.invoiceMembersClear":
        this.#billingInvoiceMembers.clear();
        return [];
      case "billing.projection.leasesClear":
        this.#billingAttemptLeases.clear();
        return [];
      case "billing.projection.identitiesClear":
        this.#billingUsageIdentities.clear();
        return [];
      case "billing.projection.identityInsert": {
        const usageId = String(params[0]);
        const candidate: Row = {
          usage_id: usageId,
          grant_id: String(params[1]),
          generation: String(params[2]),
          operation: String(params[3]),
          logical_request_id: String(params[4]),
          assertion_nonce: String(params[5]),
          source: String(params[6]),
          debit_identity: params[7],
          x402_chain_id: params[8],
          usdc_address: params[9],
          authorizer: params[10],
          authorization_nonce: params[11],
          router_payer_account_id: params[12],
          router_request_id: params[13],
        };
        const existing = this.#billingUsageIdentities.get(usageId);
        if (existing !== undefined) {
          const immutableMatch = existing["grant_id"] === candidate.grant_id &&
            existing["generation"] === candidate.generation && existing["operation"] === candidate.operation &&
            existing["logical_request_id"] === candidate.logical_request_id &&
            existing["assertion_nonce"] === candidate.assertion_nonce &&
            (existing["source"] === null || existing["source"] === candidate.source);
          const debitMatch = existing["debit_identity"] === null || existing["debit_identity"] === candidate.debit_identity;
          if (!immutableMatch || !debitMatch) return [];
          for (const field of ["source", "debit_identity", "x402_chain_id", "usdc_address", "authorizer", "authorization_nonce", "router_payer_account_id", "router_request_id"]) {
            if (existing[field] === null) existing[field] = candidate[field];
          }
          return [{ usage_id: usageId }];
        }
        const collision = [...this.#billingUsageIdentities.values()].find((row) =>
          row["grant_id"] === candidate.grant_id && row["generation"] === candidate.generation &&
            (row["assertion_nonce"] === candidate.assertion_nonce ||
              row["operation"] === candidate.operation && row["logical_request_id"] === candidate.logical_request_id) ||
          candidate.debit_identity !== null && row["debit_identity"] === candidate.debit_identity ||
          candidate.router_request_id !== null && row["router_payer_account_id"] === candidate.router_payer_account_id &&
            row["router_request_id"] === candidate.router_request_id ||
          candidate.authorization_nonce !== null && row["x402_chain_id"] === candidate.x402_chain_id &&
            row["usdc_address"] === candidate.usdc_address && row["authorizer"] === candidate.authorizer &&
            row["authorization_nonce"] === candidate.authorization_nonce);
        if (collision !== undefined) throw new Error("duplicate key value violates phase5 billing usage identity constraint");
        this.#billingUsageIdentities.set(usageId, candidate);
        return [{ usage_id: usageId }];
      }
      case "billing.projection.leaseInsert": {
        const accountId = String(params[0]);
        const usageId = String(params[1]);
        if (this.#billingAttemptLeases.has(accountId) || [...this.#billingAttemptLeases.values()].some((row) => row["usage_id"] === usageId)) {
          throw new Error("duplicate key value violates phase5 billing active lease constraint");
        }
        this.#billingAttemptLeases.set(accountId, { account_id: accountId, usage_id: usageId, expires_at: params[2], contacted: params[3], active: true });
        return [];
      }
      case "billing.projection.invoiceMemberInsert": {
        const usageId = String(params[0]);
        if (this.#billingInvoiceMembers.has(usageId)) throw new Error("duplicate key value violates phase5 billing invoice member constraint");
        this.#billingInvoiceMembers.set(usageId, { usage_id: usageId, invoice_id: params[1], account_id: params[2] });
        return [];
      }
      case "billing.projection.closeClaimInsert": {
        const accountId = String(params[0]);
        if (this.#billingCloseClaims.has(accountId) || [...this.#billingCloseClaims.values()].some((row) => row["invoice_id"] === params[2])) {
          throw new Error("duplicate key value violates phase5 billing close claim constraint");
        }
        this.#billingCloseClaims.set(accountId, { account_id: accountId, close_request_id: params[1], invoice_id: params[2] });
        return [];
      }
      case "billing.projection.ledgerInsert": {
        const usageId = String(params[0]);
        const existing = this.#billingSpendLedger.get(usageId);
        if (existing !== undefined) {
          const fields = ["invoice_id", "account_id", "agent_id", "session_ticket_hash", "usd_micros", "paid_at"];
          const values = [params[1], params[2], params[3], params[4], params[5], params[6]];
          return fields.every((field, index) => existing[field] === values[index]) ? [{ usage_id: usageId }] : [];
        }
        this.#billingSpendLedger.set(usageId, {
          usage_id: usageId, invoice_id: params[1], account_id: params[2], agent_id: params[3],
          session_ticket_hash: params[4], usd_micros: params[5], paid_at: params[6],
        });
        return [{ usage_id: usageId }];
      }
      case "billing.account.identityInsert": {
        const accountId = String(params[0]);
        const wallet = String(params[1]);
        const collision = [...this.#billingAccounts.values()].find((row) => row["account_id"] === accountId || row["wallet_address"] === wallet);
        if (collision !== undefined) return [];
        const row = { account_id: accountId, wallet_address: wallet, owner_address: params[2], encrypted_session_key: params[3], record: jsonbParam(params[4]), created_at: params[5] };
        this.#billingAccounts.set(accountId, row);
        return [{ account_id: accountId, wallet_address: wallet, owner_address: params[2] }];
      }
      case "billing.account.identityGet":
        return [...this.#billingAccounts.values()].filter((row) => row["account_id"] === params[0] || row["wallet_address"] === params[1]).map((row) => ({ account_id: row["account_id"], wallet_address: row["wallet_address"], owner_address: row["owner_address"] }));
      case "billing.usage.identityInsert": {
        const usageId = String(params[0]);
        const candidate = {
          usage_id: usageId,
          grant_id: String(params[1]),
          generation: String(params[2]),
          operation: String(params[3]),
          logical_request_id: String(params[4]),
          assertion_nonce: String(params[5]),
          debit_identity: null,
        };
        const byUsage = this.#billingUsageIdentities.get(usageId);
        if (byUsage !== undefined) return [];
        const collision = [...this.#billingUsageIdentities.values()].find((row) =>
          row["grant_id"] === candidate.grant_id && row["generation"] === candidate.generation &&
          (row["assertion_nonce"] === candidate.assertion_nonce ||
            row["operation"] === candidate.operation && row["logical_request_id"] === candidate.logical_request_id));
        if (collision !== undefined) throw new Error("duplicate key value violates phase5 billing usage identity constraint");
        this.#billingUsageIdentities.set(usageId, candidate);
        return [];
      }
      case "billing.usage.debitBind": {
        const row = this.#billingUsageIdentities.get(String(params[0]));
        if (row === undefined || row["debit_identity"] !== null && row["debit_identity"] !== params[1]) return [];
        const collision = [...this.#billingUsageIdentities.values()].find((candidate) =>
          candidate["usage_id"] !== params[0] && candidate["debit_identity"] === params[1]);
        if (collision !== undefined) throw new Error("duplicate key value violates phase5 billing debit identity constraint");
        row["debit_identity"] = params[1];
        return [{ usage_id: params[0] }];
      }
      case "agents.walletFence":
      case "lpPositions.armFence":
        return [];
      case "agents.walletOccupants":
        return [...this.#agents.values()]
          .filter((row) => row["owner_address"] === params[0]
            && String(row["wallet_address"]).toLowerCase() === String(params[1]).toLowerCase())
          .map((row) => ({
            ...structuredClone(row),
            session_key_present: row["session_key_ciphertext"] !== null
              && row["session_key_ciphertext"] !== undefined,
          }));
      case "agents.armRead":
      case "agents.armCurrent":
      case "agents.cancelRead":
      case "agents.grantAttemptRead":
      case "agents.grantAttemptResetRead":
      case "agents.confirmRevocationRead":
      case "agents.putKeyRead":
        return this.#agentsGet(params);
      case "agents.create":
        return this.#agentsCreate(params);
      case "agents.createProvisioning": {
        const id = String(params[0]);
        if (this.#agents.has(id)) return [];
        const row: Row = {
          id,
          owner_address: params[1], wallet_address: params[2], custody_model: params[3],
          session_facts: null, session_revocation: null, session_key_ciphertext: params[4], caps: jsonbParam(params[5]),
          status: "provisioning", http_runtime_profile: params[6], erc8004_agent_id: params[7],
          pending_grant: jsonbParam(params[8]), row_version: 1,
          created_at: params[9], updated_at: params[9],
        };
        this.#agents.set(id, row);
        return [structuredClone(row)];
      }
      case "agents.get":
        return this.#agentsGet(params);
      case "agents.getById":
        return this.#agentsGetById(params);
      case "agents.list":
        return this.#agentsList(params);
      case "agents.listBounded":
        return this.#agentsList(params).sort((a, b) => String(a["id"]).localeCompare(String(b["id"]))).slice(0, Number(params[1]));
      case "agents.listProvisioningWorker":
        return [...this.#agents.values()]
          .filter((row) => row["status"] === "provisioning" && (params[0] === null || String(row["id"]) > String(params[0])))
          .sort((a, b) => String(a["id"]).localeCompare(String(b["id"]))).slice(0, Number(params[1])).map((row) => structuredClone(row));
      case "agents.armProvisioning": {
        const row = this.#agents.get(String(params[0]));
        const pending = row?.["pending_grant"] as Record<string, unknown> | null | undefined;
        if (row === undefined || pending === null || pending === undefined || row["owner_address"] !== params[1] || row["status"] !== "provisioning"
          || Number(row["row_version"]) !== Number(params[2]) || pending?.["grantDigest"] !== params[3]
          || "cancelRequestedAtSec" in pending || "cancelActionId" in pending) return [];
        row["session_facts"] = jsonbParam(params[4]); row["status"] = "armed"; row["pending_grant"] = null;
        row["row_version"] = Number(row["row_version"]) + 1; row["updated_at"] = params[5];
        if (row["erc8004_identity"] == null && row["identity_absent"] !== false && row["erc8004_agent_id"] === null) {
          row["erc8004_identity"] = jsonbParam(params[6]); row["identity_absent"] = params[6] == null;
        }
        return [{ id: row["id"] }];
      }
      case "erc8004.source":
      case "erc8004.enrollRead":
        return this.#agentsGetById(params);
      case "erc8004.outbox":
        return [...this.#agents.values()].filter((row) => row["identity_absent"] === false || row["erc8004_identity"] != null)
          .filter((row) => String(row["id"]) > String(params[0])).sort((a, b) => String(a["id"]) < String(b["id"]) ? -1 : 1).slice(0, 100).map((row) => structuredClone(row));
      case "erc8004.enroll": {
        const row = this.#agents.get(String(params[0]));
        if (!row || row["owner_address"] !== params[1] || row["erc8004_identity"] != null || row["identity_absent"] === false || row["erc8004_agent_id"] !== null || !["armed", "paused"].includes(String(row["status"]))) return [];
        row["erc8004_identity"] = jsonbParam(params[2]); row["identity_absent"] = false; return [{ id: row["id"] }];
      }
      case "erc8004.project": {
        const row = this.#agents.get(String(params[0]));
        const identity = row?.["erc8004_identity"] as Row | null | undefined;
        if (!row || row["owner_address"] !== params[1] || identity?.["publicRef"] !== params[2]
          || JSON.stringify(reorderJsonb(identity)) !== JSON.stringify(jsonbParam(params[3]))
          || row["erc8004_agent_id"] !== null && row["erc8004_agent_id"] !== params[6]) return [];
        row["erc8004_identity"] = jsonbParam(params[4]); row["identity_absent"] = false;
        if (params[5] !== null) row["erc8004_agent_id"] = params[5];
        return [{ id: row["id"] }];
      }
      case "agents.grantAttemptStart": {
        const row = this.#agents.get(String(params[0]));
        if (row === undefined || row["owner_address"] !== params[1]
          || Number(row["row_version"]) !== Number(params[2])) return [];
        row["pending_grant"] = jsonbParam(params[3]);
        row["row_version"] = Number(row["row_version"]) + 1;
        row["updated_at"] = params[4];
        return [structuredClone(row)];
      }
      case "agents.grantAttemptReset": {
        const row = this.#agents.get(String(params[0]));
        if (row === undefined || row["owner_address"] !== params[1]
          || Number(row["row_version"]) !== Number(params[2])) return [];
        row["pending_grant"] = jsonbParam(params[3]);
        row["row_version"] = Number(row["row_version"]) + 1;
        row["updated_at"] = params[4];
        return [structuredClone(row)];
      }
      case "agents.confirmRevocation": {
        const row = this.#agents.get(String(params[0]));
        if (row === undefined || row["owner_address"] !== params[1]
          || Number(row["row_version"]) !== Number(params[2]) || row["status"] !== "revoked"
          || row["session_revocation"] !== null) return [];
        row["session_revocation"] = jsonbParam(params[3]);
        row["session_key_ciphertext"] = null;
        row["row_version"] = Number(row["row_version"]) + 1;
        row["updated_at"] = params[4];
        return [structuredClone(row)];
      }
      case "agents.cancelProvisioning": {
        const row = this.#agents.get(String(params[0]));
        const pending = row?.["pending_grant"] as Record<string, unknown> | null | undefined;
        if (row === undefined || pending === null || pending === undefined || row["owner_address"] !== params[1] || row["status"] !== "provisioning"
          || Number(row["row_version"]) !== Number(params[2]) || pending?.["grantDigest"] !== params[3]) return [];
        const retired = Number(pending["expiresAt"]) <= Number(params[4]);
        if (retired) {
          row["status"] = "retired"; row["pending_grant"] = null; row["session_key_ciphertext"] = null;
        } else {
          pending["cancelRequestedAtSec"] = params[5]; pending["cancelActionId"] = params[6];
        }
        row["row_version"] = Number(row["row_version"]) + 1; row["updated_at"] = params[7];
        return [{ id: row["id"], retired }];
      }
      case "agents.transitionStatus": {
        const marker = this.#agents.get(String(params[0]))?.["pending_grant"];
        if (typeof marker === "object" && marker !== null && ("cancelRequestedAtSec" in marker || "cancelActionId" in marker)) return [];
        const row = this.#agents.get(String(params[0]));
        if (row === undefined || row["owner_address"] !== params[1] || row["status"] !== params[2]
          || Number(row["row_version"]) !== Number(params[3])) return [];
        row["status"] = params[4]; row["row_version"] = Number(row["row_version"]) + 1; row["updated_at"] = params[5];
        return [structuredClone(row)];
      }
      case "agents.updateCapsCas": {
        const row = this.#agents.get(String(params[0]));
        if (row === undefined || row["owner_address"] !== params[1] || (row["status"] !== "armed" && row["status"] !== "paused")
          || Number(row["row_version"]) !== Number(params[2])) return [];
        row["caps"] = jsonbParam(params[3]); row["row_version"] = Number(row["row_version"]) + 1; row["updated_at"] = params[4];
        return [structuredClone(row)];
      }
      case "agents.bindHttpRuntimeProfileCas": {
        const row = this.#agents.get(String(params[0]));
        if (row === undefined || row["owner_address"] !== params[1] || (row["status"] !== "armed" && row["status"] !== "paused")
          || Number(row["row_version"]) !== Number(params[2]) || row["http_runtime_profile"] !== "unbound-v1") return [];
        row["http_runtime_profile"] = params[3]; row["row_version"] = Number(row["row_version"]) + 1; row["updated_at"] = params[4];
        return [structuredClone(row)];
      }
      case "agents.updateStatus": {
        const marker = this.#agents.get(String(params[0]))?.["pending_grant"];
        if (typeof marker === "object" && marker !== null && ("cancelRequestedAtSec" in marker || "cancelActionId" in marker)) return [];
        return this.#agentsUpdate(params[0], params[1], (row) => {
          row["status"] = params[2];
          row["row_version"] = Number(row["row_version"]) + 1;
          row["updated_at"] = params[3];
        });
      }
      case "agents.updateFacts": {
        const marker = this.#agents.get(String(params[0]))?.["pending_grant"];
        if (typeof marker === "object" && marker !== null && ("cancelRequestedAtSec" in marker || "cancelActionId" in marker)) return [];
        if (this.#agents.get(String(params[0]))?.["session_revocation"] !== null) return [];
        return this.#agentsUpdate(params[0], params[1], (row) => {
          row["session_facts"] = jsonbParam(params[2]);
          row["row_version"] = Number(row["row_version"]) + 1;
          row["updated_at"] = params[3];
        });
      }
      case "agents.updateCaps":
        return this.#agentsUpdate(params[0], params[1], (row) => {
          row["caps"] = jsonbParam(params[2]);
          row["row_version"] = Number(row["row_version"]) + 1;
          row["updated_at"] = params[3];
        });
      case "agents.updateErc8004Id":
        return this.#agentsUpdate(params[0], params[1], (row) => {
          row["erc8004_agent_id"] = params[2];
          row["row_version"] = Number(row["row_version"]) + 1;
          row["updated_at"] = params[3];
        });
      case "agents.bindHttpRuntimeProfile": {
        const row = this.#agents.get(params[0] as string);
        if (
          row === undefined ||
          row["owner_address"] !== params[1] ||
          row["http_runtime_profile"] !== "unbound-v1"
        ) return [];
        row["http_runtime_profile"] = params[2];
        row["row_version"] = Number(row["row_version"]) + 1;
        row["updated_at"] = params[3];
        return [structuredClone(row)];
      }
      case "agents.putKey": {
        const row = this.#agents.get(String(params[0]));
        if (row === undefined || row["owner_address"] !== params[1]
          || Number(row["row_version"]) !== Number(params[2])
          || row["status"] === "revoked" || row["session_revocation"] !== null) return [];
        row["session_key_ciphertext"] = params[3];
        row["row_version"] = Number(row["row_version"]) + 1;
        row["updated_at"] = params[4];
        return [{ id: row["id"] }];
      }
      case "agents.getKey":
        return this.#agentsGet(params, ["session_key_ciphertext"]);
      case "agents.hasKey": {
        const rows = this.#agentsGet(params);
        return rows.length === 0 ? [] : [{ present: rows[0]?.["session_key_ciphertext"] !== null }];
      }
      case "health.put":
        return this.#healthPut(params);
      case "health.list":
        return this.#healthList();
      case "runtimeReplays.prune": {
        const nowSec = Number(params[0]);
        for (const [key, row] of this.#runtimeReplays) {
          if (Number(row["expires_at"]) < nowSec) this.#runtimeReplays.delete(key);
        }
        return [];
      }
      case "runtimeReplays.consume": {
        const key = `${String(params[0])}\u001f${String(params[1])}\u001f${String(params[2])}`;
        if (this.#runtimeReplays.has(key)) return [];
        this.#runtimeReplays.set(key, {
          issuer: params[0], key_id: params[1], nonce: params[2], expires_at: params[3],
        });
        return [{ nonce: params[2] }];
      }
      case "journal.beginInsert":
        return this.#journalBeginInsert(params);
      case "journal.beginSelect":
      case "journal.transitionSelect":
      case "journal.bindPreparedSelect":
      case "journal.billingCallsIdSelect":
      case "journal.landingLock":
      case "journal.landingActionLock":
      case "journal.landingActionJoinLock":
      case "journal.preBindRetirementLock":
      case "journal.preBindRetirementActionLock":
      case "journal.billingCollectionResolveSelect":
      case "journal.get":
        return this.#journalGet(params[0]);
      case "journal.landingActionJoinResolutionLock": {
        const row = this.#lpLandingResolutions.get(String(params[0]));
        return row === undefined ? [] : [{ resolution_id: row["resolution_id"] }];
      }
      case "journal.getByDecision":
        return this.#journalGetByDecision(params);
      case "journal.sumNativeSpend":
        return this.#journalSumNativeSpend(params);
      case "journal.listNonTerminal":
        return this.#journalListNonTerminal();
      case "journal.listUnknownForAgent":
        return this.#journalListUnknownForAgent(params);
      case "journal.transitionUpdate":
        return this.#journalTransitionUpdate(params);
      case "journal.bindPreparedUpdate":
        return this.#journalBindPreparedUpdate(params);
      case "journal.billingCallsIdUpdate":
        return this.#journalBillingCallsIdUpdate(params);
      case "journal.billingCollectionResolveUpdate":
        return this.#journalBillingCollectionResolveUpdate(params);
      case "journal.landingReserve":
        return this.#journalLandingReserve(params);
      case "journal.landingFinalize":
        return this.#journalLandingFinalize(params);
      case "journal.landingActionJoin":
        return this.#journalLandingActionJoin(params);
      case "journal.landingActionComplete":
        return this.#journalLandingActionComplete(params);
      case "journal.preBindRetirement":
        return this.#journalPreBindRetirement(params);
      case "journal.preBindRetirementActionComplete":
        return this.#journalPreBindRetirementActionComplete(params);
      case "preBindFinalize.positionLock":
        return this.#preBindFinalizePositionLock(params);
      case "preBindFinalize.sequenceLock":
        return this.#preBindFinalizeSequenceLock(params);
      case "preBindFinalize.targetLock":
        return this.#preBindFinalizeTargetLock(params);
      case "preBindFinalize.actionLock":
        return this.#preBindFinalizeActionLock(params);
      case "preBindFinalize.begin":
        return this.#preBindFinalizeBegin(params);
      case "preBindFinalize.position":
        return this.#preBindFinalizePosition(params);
      case "preBindFinalize.target":
        return this.#preBindFinalizeTarget(params);
      case "preBindFinalize.reservation":
        return this.#preBindFinalizeReservation(params);
      case "preBindFinalize.action":
        return this.#preBindFinalizeAction(params);
      case "preBindFinalize.sequence":
        return this.#preBindFinalizeSequence(params);
      case "nonces.consume":
        return this.#noncesConsume(params);
      case "nonces.lock":
        return [];
      case "nonces.provisionRead":
        return this.#noncesProvisionRead(params);
      case "nonces.provisionInsert":
        return this.#noncesProvisionInsert(params);
      case "nonces.provisionTransition":
        return this.#noncesProvisionTransition(params);
      case "nonces.prune":
        return this.#noncesPrune(params);
      case "kill.pause":
        return this.#killPause(params);
      case "kill.unpause":
        return this.#killUnpause(params);
      case "kill.isPaused":
        return this.#killIsPaused(params);
      case "kill.halt":
        return this.#killHalt(params);
      case "kill.resume":
        return this.#killResume();
      case "kill.isHalted":
        return this.#killIsHalted();
      case "lpPositions.create":
        return this.#lpPositionsCreate(params);
      case "lpPositions.get":
      case "lpPositions.lock":
        return this.#lpPositionsGet(params);
      case "lpPositions.list":
        return this.#lpPositionsList(params);
      case "lpPositions.listOpenWorker":
        return this.#lpPositionsListOpenWorker();
      case "lpPositions.byTokenId":
        return this.#lpPositionsByTokenId(params);
      case "lpPositions.setOwnershipMismatch":
        return this.#lpPositionsUpdate(params, (row) => {
          row["ownership_mismatch_count"] = params[4];
          row["ownership_lost_reason"] = params[5];
          row["ownership_first_seen_at"] = params[6];
          row["updated_at"] = params[7];
        });
      case "lpPositions.updateTokenId":
        return this.#lpPositionsUpdate(params, (row) => {
          this.#assertLiveTokenFree(params[4], params[0] as string);
          row["token_id"] = params[4];
          row["updated_at"] = params[5];
          // PHASE3.18 R2.6: the real statement is
          // `grid_role = coalesce($7, grid_role)`, so an omitted role leaves
          // the column alone. Mirrored explicitly under the A6 warning.
          if (params[6] !== null && params[6] !== undefined) {
            row["grid_role"] = params[6];
          }
        });
      // PHASE3.18 R2.6 (M7): the fixed→policy identity backfill. Mirrored by
      // hand under the A6 warning, exactly like every predicate in this file.
      case "lpPositions.setGridIdentity":
        return this.#lpPositionsSetGridIdentity(params);
      // PHASE3.19 R4.1/D4 — the anchor increment. The real statement is an
      // IN-SQL `set x = x + $d` guarded on `inventory_base_wei is not null`
      // (only the ANCHOR row has a book), which is mirrored by hand here under
      // the A6 warning: `params[3]`/`params[4]` are the CLAMPED deltas, NOT a
      // row version, so the shared update helper must not be reused.
      case "lpPositions.applyInventoryCredit":
        return this.#lpPositionsApplyInventoryCredit(params);
      case "lpInventoryCredits.get":
        return this.#lpInventoryCreditsGet(params);
      case "lpInventoryCredits.insert":
        return this.#lpInventoryCreditsInsert(params);
      case "lpInventoryCredits.list":
        return this.#lpInventoryCreditsList(params);
      case "lpPositions.setState":
        return this.#lpPositionsUpdate(params, (row) => {
          row["state"] = params[4];
          row["updated_at"] = params[5];
        });
      case "lpPositions.close":
        // `set state = 'closed', basis_wei = 0`: closing the lineage resets
        // the basis in the same write — the R7 semantics the store pins.
        return this.#lpPositionsUpdate(params, (row) => {
          row["state"] = "closed";
          row["basis_wei"] = "0";
          // PHASE3.22 R4.2.2: `close_reason = coalesce($6, close_reason)`,
          // mirrored EXACTLY — an omitted reason must leave the column alone
          // rather than erasing a recorded one, which is what keeps every
          // pre-3.22 caller byte-identical.
          if ((params[5] ?? null) !== null) row["close_reason"] = params[5];
          row["updated_at"] = params[4];
        });
      case "lpPositions.landingClose":
        return this.#lpPositionsUpdate(params, (row) => {
          row["state"] = "closed"; row["basis_wei"] = "0"; row["updated_at"] = params[4];
        });
      case "lpPositions.landingSetState":
        return this.#lpPositionsUpdate(params, (row) => {
          row["state"] = params[4]; row["updated_at"] = params[5];
        });
      case "lpPositions.landingToken":
        return this.#lpPositionsUpdate(params, (row) => {
          this.#assertLiveTokenFree(params[4], params[0] as string);
          row["token_id"] = params[4]; row["updated_at"] = params[5];
        });
      case "lpPositions.preBindRetirementClose":
        return this.#lpPositionsUpdate(params, (row) => {
          row["state"] = params[4];
          if (params[4] === "closed") row["basis_wei"] = "0";
          row["updated_at"] = params[5];
        });
      case "lpSequences.create":
        return this.#lpSequencesCreate(params);
      case "lpSequences.get":
      case "lpSequences.lock":
        return this.#lpSequencesGet(params);
      case "lpSequences.resolvingByPosition":
        return this.#lpSequencesResolvingByPosition(params);
      case "lpSequences.nonTerminalByPosition":
        return this.#lpSequencesNonTerminalByPosition(params);
      case "lpSequences.anyNonTerminalByAgent":
        return this.#lpSequencesAnyNonTerminalByAgent(params);
      case "lpSequences.list":
        return this.#lpSequencesList(params);
      case "lpSequences.listNonTerminalWorker":
        return this.#lpSequencesListNonTerminalWorker();
      case "lpSequences.updateSteps":
        return this.#lpSequencesUpdate(params, (row) => {
          row["steps"] = jsonbParam(params[3]);
            row["prior_token_id"] = params[5] ?? null;
          row["updated_at"] = params[4];
        });
      case "lpSequences.updateState":
        return this.#lpSequencesUpdate(params, (row) => {
          row["state"] = params[3];
          row["updated_at"] = params[4];
        });
      case "lpSequences.claimAbandon":
        return this.#lpSequencesClaimAbandon(params);
      case "lpSequences.claimLandingResolution":
        return this.#lpSequencesClaimLandingResolution(params);
      case "lpSequences.claimPreBindRetirement":
        return this.#lpSequencesClaimPreBindRetirement(params);
      case "lpSequences.reclaimPreBindRetirement":
        return this.#lpSequencesReclaimPreBindRetirement(params);
      case "lpSequences.beginPreBindRetirement":
        return this.#lpSequencesBeginPreBindRetirement(params);
      case "lpSequences.preBindRetirementTouch":
        return this.#lpSequencesPreBindRetirementTouch(params);
      case "lpSequences.finishPreBindRetirement":
        return this.#lpSequencesFinishPreBindRetirement(params);
      case "lpSequences.reclaimLandingResolution":
        return this.#lpSequencesReclaimLandingResolution(params);
      case "lpSequences.beginLandingDisposition":
        return this.#lpSequencesBeginLandingDisposition(params);
      case "lpSequences.setLandingRecovery":
        return this.#lpSequencesSetLandingRecovery(params);
      case "lpSequences.landingTouch":
        return this.#lpSequencesLandingTouch(params);
      case "lpSequences.releaseLandingResolution":
        return this.#lpSequencesReleaseLandingResolution(params);
      case "lpSequences.finishLandingResolutionActive":
        return this.#lpSequencesFinishLandingResolution(params, "active");
      case "lpSequences.finishLandingResolutionRolledBack":
        return this.#lpSequencesFinishLandingResolution(params, "rolled-back");
      case "lpSequences.beginAbandonDisposition":
        return this.#lpSequencesBeginAbandonDisposition(params);
      case "lpSequences.releaseAbandon":
        return this.#lpSequencesReleaseAbandon(params);
      case "lpSequences.completeAbandon":
        return this.#lpSequencesCompleteAbandon(params);
      case "lpSequences.updateRecovery":
        return this.#lpSequencesUpdate(params, (row) => {
          row["recovery_state"] = params[3];
          row["updated_at"] = params[4];
        });
      /**
       * PHASE3.19 item 8 — WRITE-ONCE BY PREDICATE. The real statement carries
       * `and hedge_direction is null and hedge_amount_in_wei is null`, so a
       * second write matches NOTHING; mirrored by hand here rather than through
       * the shared helper, because dropping that conjunct is exactly item 46's
       * mutation (an overwrite on resume where a throw is owed).
       */
      case "lpSequences.setHedgeIntent":
        return this.#lpSequencesSetHedgeIntent(params);
      case "lpSequences.recordStall":
        return this.#lpSequencesUpdate(params, (row) => {
          const same = row["stall_code"] === params[3];
          row["stall_code"] = params[3];
          row["stall_count"] = same ? Number(row["stall_count"] ?? 0) + 1 : 1;
          row["updated_at"] = params[4];
        });
      case "lpSequences.updateNote":
        return this.#lpSequencesUpdate(params, (row) => {
          row["note"] = params[3];
          row["updated_at"] = params[4];
        });
      case "lpSequences.recordInlineResidue":
        return this.#lpSequencesUpdate(params, (row) => {
          row["inline_residue_base_wei"] ??= params[3];
          row["note"] = params[4];
          row["updated_at"] = params[5];
        });
      case "lpReservations.shiftQuotaLock":
        // Real Postgres serializes the owner+agent shift scope. Transactions
        // are already uninterrupted in this in-memory fake.
        return [];
      case "lpReservations.insert":
        return this.#lpReservationsInsert(params);
      case "lpReservations.get":
        return this.#lpReservationsGet(params);
      case "lpReservations.window":
        return this.#lpReservationsWindow(params);
      case "lpReservations.release":
        return this.#lpReservationsRelease(params);
      case "lpReservations.quotaUsage":
        return this.#lpReservationsQuotaUsage(params);
      case "lpReservations.delete":
        this.#lpReservations.delete(params[0] as string);
        return [];
      case "lpSettings.get":
        return this.#lpSettingsGet(params);
      case "lpSettings.put":
        return this.#lpSettingsPut(params);
      case "lpObservations.get":
        return this.#lpObservationsGet(params);
      case "lpObservations.put":
        return this.#lpObservationsPut(params);
      case "lpObservations.delete":
        return this.#lpObservationsDelete(params);
      // PHASE3.15: the grid cycle ledger. Derived telemetry, so the fake's job
      // is only to prove the store's parameter ordering, owner normalization
      // and row mapping — the A6 warning at the top of this file applies here
      // as everywhere: this dispatches on the tag and never parses the SQL.
      case "gridCycles.insert":
        return this.#gridCyclesInsert(params);
      case "gridCycles.list":
        return this.#gridCyclesList(params);
      case "venusSettings.get":
        return this.#venusSettingsGet(params);
      case "venusSettings.put":
        return this.#venusSettingsPut(params);
      case "venusSettings.listForWorker":
        return [...this.#venusSettings.values()]
          .sort((left, right) =>
            String(left["agent_id"]) < String(right["agent_id"]) ? -1 : 1,
          )
          .map((row) => structuredClone(row));
      case "venusObservations.get":
        return this.#venusObservationsGet(params);
      case "venusObservations.put":
        return this.#venusObservationsPut(params);
      case "venusObservations.delete":
        return this.#venusObservationsDelete(params);
      case "venusActions.charge.existing":
      case "venusActions.charge.reread":
        return this.#venusActionsById(params);
      case "venusActions.charge":
        return this.#venusActionsInsert(params);
      case "venusActions.usageSince":
        return this.#venusActionsUsageSince(params);

      /* ---- MARKETPLACE-LENDING-AGENT ---- */
      //
      // Each transition below is a SEPARATE static statement in the store, with
      // its own tag and its own `status in (...)` literal, and each predicate is
      // re-stated by hand here. As everywhere in this file: it dispatches on the
      // tag and NEVER PARSES THE SQL, so editing a real `where` clause without
      // editing its twin leaves that edit with ZERO executed coverage.
      case "lendingGuards.putInitial":
        return this.#lendingGuardsInsert(params);
      case "lendingGuards.get":
        return this.#lendingGuardsGet(params);
      case "lendingGuards.listForWorker":
        return [...this.#lendingGuards.values()]
          .filter((row) =>
            ["arming", "armed", "held", "retiring"].includes(String(row["status"])))
          .sort((left, right) => (String(left["agent_id"]) < String(right["agent_id"]) ? -1 : 1))
          .map((row) => structuredClone(row));
      case "lendingGuards.arm":
        // FIXREVIEW F4: the accepted-source list is the DERIVED one.
        return this.#lendingGuardsTransition(params, LENDING_GUARD_CAS_SOURCES.armCas, (row) => ({
          ...row,
          status: "arming", hold: null, close_reason: null,
          budget_wei: params[4], reserve_bps: params[5],
          supply_native_wei: params[6], reserve_native_wei: params[7],
          mint_usdt_wei: params[8], pre_arm_vusdt_wei: params[9],
          pre_arm_exchange_rate: params[10], arm_journal_key: params[11],
          arm_block: null, arm_block_source: null, arm_tx_hash: null,
          hold_clear_consecutive: 0,
        }));
      case "lendingGuards.finishArm":
        return this.#lendingGuardsTransition(params, LENDING_GUARD_CAS_SOURCES.finishArm, (row) => ({
          ...row,
          status: params[4], hold: params[5], close_reason: params[6],
          // FIXREVIEW F7: `arm_block_source = $10`, written with the figure.
          arm_block: params[7], arm_block_source: params[9] ?? null,
          arm_tx_hash: params[8], hold_clear_consecutive: 0,
        }));
      case "lendingGuards.setHold":
        // `status in ('armed','held')`, and
        // `arm_block = coalesce(arm_block, $7::numeric)` — FIXREVIEW F1's
        // one-way write, restated by hand exactly as this file restates every
        // predicate, because it never parses the SQL.
        return this.#lendingGuardsTransition(params, LENDING_GUARD_CAS_SOURCES.setHold, (row) => ({
          ...row,
          status: params[4],
          hold: params[5],
          // FIXREVIEW F5: setting OR clearing a hold restarts the count.
          hold_clear_consecutive: 0,
          arm_block: row["arm_block"] ?? params[6] ?? null,
          // FIXREVIEW F7: `case when arm_block is null then $8 else & end` 
          // the label is written only by the statement that first sets the block.
          arm_block_source:
            (row["arm_block"] ?? null) === null
              ? (params[7] ?? null)
              : (row["arm_block_source"] ?? null),
        }));
      case "lendingGuards.beginRetire":
        // `status in ('armed','held','retiring')` — AUDIT B-H1: a partial
        // retire parks at `retiring` and its own refusal says "retire again
        // when the pool refills", so the gate must accept it.
        return this.#lendingGuardsTransition(
          params,
          LENDING_GUARD_CAS_SOURCES.beginRetire,
          (row) => ({ ...row, status: "retiring" }),
        );
      case "lendingGuards.finishRetire":
        return this.#lendingGuardsTransition(params, LENDING_GUARD_CAS_SOURCES.finishRetire, (row) => ({
          ...row, status: params[4], hold: params[5], close_reason: params[6],
          hold_clear_consecutive: 0,
        }));
      case "lendingGuards.noteHoldClear":
        // FIXREVIEW F5. `status in ('held')`  a literal in the real
        // statement too, because this writer moves NO status and so has no
        // row in the transition table to derive from.
        return this.#lendingGuardsTransition(params, ["held"], (row) => ({
          ...row, hold_clear_consecutive: Number(params[4]),
        }));
      case "lendingGuards.close":
        // FIXREVIEW F4: narrowed to the DERIVED sources  the three it used
        // to accept were driven by nothing.
        return this.#lendingGuardsTransition(
          params,
          LENDING_GUARD_CAS_SOURCES.close,
          (row) => ({ ...row, status: "closed", hold: null, close_reason: params[4] }),
        );
      case "lendingGuards.claim":
        return this.#lendingGuardsClaim(params);
      case "lendingGuards.restoreClaim":
        return this.#lendingGuardsRestoreClaim(params);
      case "lendingGuards.fence":
        // `pg_advisory_xact_lock(classid, hashtext(key))` — the global
        // transaction lock this client already holds stands in for it.
        return [];
      case "lendingRescues.insert":
        return this.#lendingRescuesInsert(params);
      case "lendingRescues.list":
        return this.#lendingRescuesList(params);
      case "lendingActions.charge":
        return this.#lendingActionsCharge(params);
      case "lendingActions.usageSince":
        return this.#lendingActionsUsage(params);
      case "lendingActions.lastOfKind":
        return this.#lendingActionsLastOfKind(params);
      case "lendingSnapshots.put":
        return this.#lendingSnapshotsPut(params);
      case "lendingSnapshots.get":
        return this.#lendingSnapshotsGet(params);
      case "lendingSettings.get":
        return this.#namespacedSettingsGet(this.#lendingSettings, params);
      case "lendingSettings.put":
        return this.#namespacedSettingsPut(this.#lendingSettings, params);
      case "lendingSettings.listForWorker":
        return [...this.#lendingSettings.values()]
          .sort((left, right) => (String(left["agent_id"]) < String(right["agent_id"]) ? -1 : 1))
          .map((row) => structuredClone(row));
      case "lendingObservations.get":
        return this.#namespacedObservationsGet(this.#lendingObservations, params);
      case "lendingObservations.put":
        return this.#namespacedObservationsPut(this.#lendingObservations, params);
      case "lendingObservations.delete":
        return this.#namespacedObservationsDelete(this.#lendingObservations, params);
      case "lpEvidence.schemaVerify":
        return [{ tables_ok: true, charge_columns_ok: true,
          legacy_columns_absent: true, cleanup_pair_ok: true, cleanup_check_ok: true,
          state_checks_ok: true, chunk_error_bound_ok: true,
          requirement_generation_ok: true }];
      case "lpEvidence.requirementGet":
      case "lpEvidence.requirementGetForUpdate":
      case "lpEvidence.requirementAuthorize":
        return this.#lpEvidenceRequirementGet(params);
      case "lpCoverage.requirementRegister":
      case "lpCoverage.snapshotRequirement":
        return this.#lpCoverageSnapshotRequirement(params);
      case "lpEvidence.requirementInsert":
        return this.#lpEvidenceRequirementInsert(params);
      case "lpEvidence.requirementTerminal":
        return this.#lpEvidenceRequirementTerminal(params);
      case "lpEvidence.requirementDelete":
        return this.#lpEvidenceRequirementDelete(params);
      case "lpEvidence.resolutionInsert":
        return this.#lpEvidenceResolutionInsert(params);
      case "lpEvidence.resolutionGet":
      case "lpEvidence.resolutionLock":
        return this.#lpEvidenceResolutionGet(params);
      case "lpEvidence.resolutionBindEvidence":
        return this.#lpEvidenceResolutionBind(params);
      case "lpEvidence.resolutionAdvance":
        return this.#lpEvidenceResolutionAdvance(params);
      case "lpEvidence.resolutionTerminal":
        return this.#lpEvidenceResolutionTerminal(params);
      case "lpEvidence.resolutionDelete":
        return this.#lpEvidenceResolutionDelete(params);
      case "lpEvidence.evidenceInsert":
        return this.#lpEvidenceBodyInsert(params);
      case "lpEvidence.evidenceGet":
        return this.#lpEvidenceBodyGet(params);
      case "lpEvidence.evidencePreview":
        return this.#lpEvidenceBodyGet(params);
      case "lpEvidence.evidenceRetain":
        return this.#lpEvidenceBodyRetain(params);
      case "lpEvidence.evidenceDelete":
        return this.#lpEvidenceBodyDelete(params);
      case "lpEvidence.quotaEnsure":
        return this.#lpEvidenceQuotaEnsure(params);
      case "lpEvidence.releaseQuotaEnsure":
        return this.#lpEvidenceReleaseQuotaEnsure(params);
      case "lpEvidence.releaseQuotaGlobal":
        return this.#lpEvidenceQuotaGet("global", "");
      case "lpEvidence.releaseQuotaVersionEnsure":
        return this.#lpEvidenceQuotaEnsure(params);
      case "lpEvidence.releaseQuotaVersion":
        return this.#lpEvidenceQuotaGet("coverage-version", params[0]);
      case "lpEvidence.quotaLockGlobal":
      case "lpEvidence.quotaGet":
        return this.#lpEvidenceQuotaGet("global", "");
      case "lpEvidence.quotaLockVersion":
        return this.#lpEvidenceQuotaGet("coverage-version", params[0]);
      case "lpEvidence.quotaUpdate":
        return this.#lpEvidenceQuotaUpdate(params);
      case "lpEvidence.cleanupSelect":
        return this.#lpEvidenceCleanupSelect(params);
      case "lpEvidence.cleanupQuotaEnsure":
        return this.#lpEvidenceReleaseQuotaEnsure(params);
      case "lpEvidence.cleanupQuotaGlobal":
        return this.#lpEvidenceQuotaGet("global", "");
      case "lpEvidence.cleanupQuotaVersionEnsure":
        return this.#lpEvidenceQuotaEnsure(params);
      case "lpEvidence.cleanupQuotaVersion":
        return this.#lpEvidenceQuotaGet("coverage-version", params[0]);
      case "lpEvidence.cleanupCursorLock":
        return this.#lpCoverageCursorGet([params[2]]);
      case "lpEvidence.cleanupLeaseLock":
        return this.#lpCoverageLeaseLock(params);
      case "lpEvidence.cleanupLaneCitations":
        return this.#lpEvidenceCleanupLaneCitations(params);
      case "lpEvidence.cleanupPrefixGet":
        return this.#lpCoverageCompactPrefixLock(params);
      case "lpEvidence.cleanupPrefixDelete":
        return this.#lpEvidenceCleanupPrefixDelete(params);
      case "lpEvidence.cleanupChunksLock":
        return this.#lpEvidenceCleanupChunksLock(params);
      case "lpEvidence.cleanupRawCharge":
        return this.#lpEvidenceCleanupRawCharge(params);
      case "lpEvidence.cleanupChunkExact":
        return this.#lpEvidenceCleanupChunkExact(params);
      case "lpEvidence.cleanupCandidates":
        return this.#lpEvidenceCleanupCandidates(params);
      case "lpEvidence.cleanupBlocks":
        return this.#lpEvidenceCleanupBlocks(params);
      case "lpEvidence.cleanupLease":
        return this.#lpEvidenceCleanupLease(params);
      case "lpEvidence.cleanupCursor":
        return this.#lpEvidenceCleanupCursor(params);
      case "lpEvidence.cleanupTombstone":
        return this.#lpEvidenceCleanupTombstone(params);
      case "lpCoverage.sourceEnsure":
      case "lpCoverage.quorumEnsure":
        return [];
      case "lpCoverage.chunkInsert":
        return this.#lpCoverageChunkInsert(params);
      case "lpCoverage.invalidateChunks":
        return this.#lpCoverageInvalidateChunks(params);
      case "lpCoverage.rewindChunksLock":
        return this.#lpCoverageRewindChunksLock(params);
      case "lpCoverage.rewindChunkBlocks":
        return this.#lpCoverageRewindChunkBlocks(params);
      case "lpCoverage.rewindChunkCandidateCount":
        return this.#lpCoverageRewindChunkCandidateCount(params);
      case "lpCoverage.rewindRawCharge":
        return this.#lpCoverageRewindRawCharge(params);
      case "lpCoverage.invalidateChunkExact":
        return this.#lpCoverageInvalidateChunkExact(params);
      case "lpCoverage.rewindChunkInsert":
        return this.#lpCoverageRewindChunkInsert(params);
      case "lpCoverage.cursorEnsure":
        return this.#lpCoverageCursorEnsure(params);
      case "lpCoverage.admissionLane":
        return this.#lpCoverageAdmissionLane(params);
      case "lpCoverage.baseLane":
        return this.#lpCoverageBaseLane(params);
      case "lpCoverage.leaseEnsure":
        return this.#lpCoverageLeaseEnsure(params);
      case "lpCoverage.leaseClaim":
        return this.#lpCoverageLeaseClaim(params);
      case "lpCoverage.leaseLock":
        return this.#lpCoverageLeaseLock(params);
      case "lpCoverage.backfillPrune":
        return this.#lpCoverageBackfillPrune(params);
      case "lpCoverage.backfillEnsure":
        return this.#lpCoverageBackfillEnsure(params);
      case "lpCoverage.backfillReserve":
        return this.#lpCoverageBackfillReserve(params);
      case "lpCoverage.compactQuotaEnsure":
        return this.#lpEvidenceQuotaEnsure(params);
      case "lpCoverage.compactQuotaGlobal":
        return this.#lpEvidenceQuotaGet("global", "");
      case "lpCoverage.compactQuotaVersion":
        return this.#lpEvidenceQuotaGet("coverage-version", params[0]);
      case "lpCoverage.compactRequirements":
        return this.#lpCoverageCompactRequirements(params);
      case "lpCoverage.compactPrefixLock":
        return this.#lpCoverageCompactPrefixLock(params);
      case "lpCoverage.compactChunksLock":
        return this.#lpCoverageCompactChunksLock(params);
      case "lpCoverage.compactCandidateCount":
        return this.#lpCoverageCompactCandidateCount(params);
      case "lpCoverage.compactTerminalBlock":
        return this.#lpCoverageCompactTerminalBlock(params);
      case "lpCoverage.compactRawCharge":
        return this.#lpCoverageCompactRawCharge(params);
      case "lpCoverage.compactPrefixInsert":
        return this.#lpCoverageCompactPrefixInsert(params);
      case "lpCoverage.compactPrefixExtend":
        return this.#lpCoverageCompactPrefixExtend(params);
      case "lpCoverage.compactChunksDelete":
        return this.#lpCoverageCompactChunksDelete(params);
      case "lpCoverage.compactBlocksDelete":
        return this.#lpCoverageCompactBlocksDelete(params);
      case "lpCoverage.compactCursor":
        return this.#lpCoverageCompactCursor(params);
      case "lpCoverage.compactQuotaUpdate":
        return this.#lpCoverageCompactQuotaUpdate(params);
      case "lpCoverage.cursorGet":
      case "lpCoverage.cursorLock":
        return this.#lpCoverageCursorGet(params);
      case "lpCoverage.cursorList":
        return this.#lpCoverageCursorList(params);
      case "lpCoverage.blockInsert":
        return this.#lpCoverageBlockInsert(params);
      case "lpCoverage.candidateInsert":
        return this.#lpCoverageCandidateInsert(params);
      case "lpCoverage.cursorAdvance":
        return this.#lpCoverageCursorAdvance(params);
      case "lpCoverage.cursorGap":
        return this.#lpCoverageCursorGap(params);
      case "lpCoverage.recentBlocks":
        return this.#lpCoverageRecentBlocks(params);
      case "lpCoverage.prefixBoundaries":
        return this.#lpCoveragePrefixBoundaries(params);
      case "lpCoverage.rewindPrefixesLock":
        return this.#lpCoverageRewindPrefixes(params);
      case "lpCoverage.rewindPrefixUnavailable":
        return this.#lpCoverageRewindPrefixUnavailable(params);
      case "lpCoverage.rewindPrefixCarry":
        return this.#lpCoverageRewindPrefixCarry(params);
      case "lpCoverage.rewindRequirementsUnavailable":
        return this.#lpCoverageRewindRequirementsUnavailable(params);
      case "lpCoverage.rewindRequirementsCarry":
        return this.#lpCoverageRewindRequirementsCarry(params);
      case "lpCoverage.rewindBlocksCarry":
        return this.#lpCoverageRewindBlocksCarry(params);
      case "lpCoverage.rewindCandidatesCarry":
        return this.#lpCoverageRewindCandidatesCarry(params);
      case "lpCoverage.rewindQuotaEnsure":
        return this.#lpEvidenceQuotaEnsure(params);
      case "lpCoverage.rewindQuotaGlobal":
        return this.#lpEvidenceQuotaGet("global", "");
      case "lpCoverage.rewindQuotaVersion":
        return this.#lpEvidenceQuotaGet("coverage-version", params[0]);
      case "lpCoverage.rewindQuotaUpdate":
        return this.#lpCoverageQuotaUpdate(params);
      case "lpCoverage.cursorRewind":
        return this.#lpCoverageCursorRewind(params);
      case "lpCoverage.candidateMatch":
        return this.#lpCoverageCandidateMatch(params);
      case "lpCoverage.validateBlock":
        return this.#lpCoverageValidateBlock(params);
      case "lpCoverage.validateCandidate":
        return this.#lpCoverageValidateCandidate(params);
      case "lpCoverage.validateRequirement":
        return this.#lpCoverageValidateRequirement(params);
      case "lpCoverage.quotaEnsure":
        return this.#lpEvidenceQuotaEnsure(params);
      case "lpCoverage.quotaLockGlobal":
        return this.#lpEvidenceQuotaGet("global", "");
      case "lpCoverage.quotaLockVersion":
        return this.#lpEvidenceQuotaGet("coverage-version", params[0]);
      case "lpCoverage.quotaUpdate":
        return this.#lpCoverageQuotaUpdate(params);
      default:
        // DDL and anything unrecognized: no-op.
        return [];
    }
  }

  /* ----- venus settings / observations / actions (PHASE4) ----- */

  #venusSettingsGet(params: readonly unknown[]): Row[] {
    const row = this.#venusSettings.get(params[0] as string);
    if (row === undefined || row["owner_address"] !== params[1]) return [];
    return [structuredClone(row)];
  }

  #venusSettingsPut(params: readonly unknown[]): Row[] {
    const agentId = params[0] as string;
    const existing = this.#venusSettings.get(agentId);
    if (existing !== undefined && existing["owner_address"] !== params[1]) {
      // The owner predicate rides the upsert's UPDATE arm, so a cross-owner put
      // updates nothing and RETURNING is empty — which is what makes the store
      // throw rather than overwrite.
      return [];
    }
    const row: Row = {
      agent_id: agentId,
      owner_address: params[1],
      params: jsonbParam(params[2]),
      digest: params[3],
      updated_at: params[4],
    };
    this.#venusSettings.set(agentId, row);
    return [structuredClone(row)];
  }

  /** Keyed `(agent_id, kind)`, scoped by owner on read and on the update arm. */
  #venusObservationKey(agentId: string, kind: string): string {
    return `${agentId} ${kind}`;
  }

  #venusObservationsGet(params: readonly unknown[]): Row[] {
    const row = this.#venusObservations.get(
      this.#venusObservationKey(params[0] as string, params[1] as string),
    );
    if (row === undefined || row["owner_address"] !== params[2]) return [];
    return [structuredClone(row)];
  }

  #venusObservationsPut(params: readonly unknown[]): Row[] {
    const key = this.#venusObservationKey(params[0] as string, params[1] as string);
    const existing = this.#venusObservations.get(key);
    if (existing !== undefined && existing["owner_address"] !== params[2]) return [];
    this.#venusObservations.set(key, {
      agent_id: params[0],
      kind: params[1],
      owner_address: params[2],
      // pg hands int8 back as a string; the store reads the jsonb rather than
      // this column, but the driver's shape is reproduced anyway.
      evaluated_at_ms: String(params[3]),
      observation: jsonbParam(params[4]),
      updated_at: params[5],
    });
    return [{ agent_id: params[0] }];
  }

  #venusObservationsDelete(params: readonly unknown[]): Row[] {
    const key = this.#venusObservationKey(params[0] as string, params[1] as string);
    const row = this.#venusObservations.get(key);
    if (row === undefined || row["owner_address"] !== params[2]) return [];
    this.#venusObservations.delete(key);
    return [];
  }

  #venusActionsById(params: readonly unknown[]): Row[] {
    const row = this.#venusActions.get(params[0] as string);
    return row === undefined ? [] : [structuredClone(row)];
  }

  /**
   * `on conflict (action_id) do nothing returning …` — an existing id returns
   * NOTHING, which is what drives the store's read-back-what-won branch.
   */
  #venusActionsInsert(params: readonly unknown[]): Row[] {
    const actionId = params[0] as string;
    if (this.#venusActions.has(actionId)) return [];
    const row: Row = {
      action_id: actionId,
      agent_id: params[1],
      owner_address: params[2],
      kind: params[3],
      charged_at_ms: String(params[4]),
    };
    this.#venusActions.set(actionId, row);
    return [structuredClone(row)];
  }

  #venusActionsUsageSince(params: readonly unknown[]): Row[] {
    const owner = params[0];
    const agentId = params[1];
    const since = BigInt(params[2] as number | string);
    return [...this.#venusActions.values()]
      .filter(
        (row) =>
          row["owner_address"] === owner
          && row["agent_id"] === agentId
          && BigInt(row["charged_at_ms"] as string) >= since,
      )
      .sort((left, right) =>
        BigInt(left["charged_at_ms"] as string) < BigInt(right["charged_at_ms"] as string)
          ? -1
          : 1,
      )
      .map((row) => structuredClone(row));
  }

  /* ----- lending ----- */

  /** `on conflict (agent_id) do nothing returning …` — an existing id returns []. */
  #lendingGuardsInsert(params: readonly unknown[]): Row[] {
    const agentId = params[0] as string;
    if (this.#lendingGuards.has(agentId)) return [];
    const nowMs = String(params[7]);
    const row: Row = {
      agent_id: agentId,
      owner_address: params[1],
      guarded_account: params[2],
      reserve_token: params[3],
      debt_markets: jsonbParam(params[4]),
      status: "provisioning-guard",
      hold: null,
      reserve_cap_wei: String(params[5]),
      reserve_bps: Number(params[6]),
      budget_wei: "0",
      supply_native_wei: "0",
      reserve_native_wei: "0",
      mint_usdt_wei: "0",
      pre_arm_vusdt_wei: "0",
      pre_arm_exchange_rate: "0",
      arm_journal_key: null,
      arm_block: null,
      arm_block_source: null,
      arm_tx_hash: null,
      hold_clear_consecutive: 0,
      last_action_at_ms: null,
      action_seq: 0,
      close_reason: null,
      row_version: 1,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    };
    this.#lendingGuards.set(agentId, row);
    return [structuredClone(row)];
  }

  #lendingGuardsGet(params: readonly unknown[]): Row[] {
    const row = this.#lendingGuards.get(params[0] as string);
    if (row === undefined || !sameOwner(row["owner_address"], params[1])) return [];
    return [structuredClone(row)];
  }

  /**
   * `update … where agent_id = $1 and owner_address = $2 and row_version = $4
   * and status in (…)`. The status list is passed in by the dispatch arm above,
   * mirroring that statement's own literal.
   */
  #lendingGuardsTransition(
    params: readonly unknown[],
    allowedFrom: readonly string[],
    mutate: (row: Row) => Row,
  ): Row[] {
    const agentId = params[0] as string;
    const row = this.#lendingGuards.get(agentId);
    if (row === undefined) return [];
    if (!sameOwner(row["owner_address"], params[1])) return [];
    if (Number(row["row_version"]) !== Number(params[3])) return [];
    if (!allowedFrom.includes(String(row["status"]))) return [];
    const next: Row = {
      ...mutate(row),
      row_version: Number(row["row_version"]) + 1,
      updated_at_ms: String(params[2]),
    };
    this.#lendingGuards.set(agentId, next);
    return [structuredClone(next)];
  }

  /**
   * The R3.7 claim: `where … and (last_action_at_ms is null or
   * last_action_at_ms <= $3 - $4) returning action_seq`.
   */
  #lendingGuardsClaim(params: readonly unknown[]): Row[] {
    const agentId = params[0] as string;
    const row = this.#lendingGuards.get(agentId);
    if (row === undefined || !sameOwner(row["owner_address"], params[1])) return [];
    const nowMs = BigInt(params[2] as number | string);
    const floorMs = BigInt(params[3] as number | string);
    const last = row["last_action_at_ms"];
    if (last !== null && last !== undefined && BigInt(last as string | number) > nowMs - floorMs) {
      return [];
    }
    const next: Row = {
      ...row,
      last_action_at_ms: String(nowMs),
      action_seq: Number(row["action_seq"]) + 1,
      row_version: Number(row["row_version"]) + 1,
      updated_at_ms: String(nowMs),
    };
    this.#lendingGuards.set(agentId, next);
    return [{ action_seq: next["action_seq"] }];
  }

  /**
   * The AUDIT C-H1 restore: `set last_action_at_ms = $4 … where agent_id = $1
   * and owner_address = $2 and action_seq = $3 returning action_seq`.
   *
   * The `action_seq` predicate is the whole point and is re-stated here by
   * hand: a restore from a cycle that has since been overtaken by a real claim
   * must change NOTHING.
   */
  #lendingGuardsRestoreClaim(params: readonly unknown[]): Row[] {
    const agentId = params[0] as string;
    const row = this.#lendingGuards.get(agentId);
    if (row === undefined || !sameOwner(row["owner_address"], params[1])) return [];
    if (Number(row["action_seq"]) !== Number(params[2])) return [];
    const previous = params[3];
    const next: Row = {
      ...row,
      last_action_at_ms: previous === null || previous === undefined
        ? null
        : String(previous),
      row_version: Number(row["row_version"]) + 1,
      updated_at_ms: String(params[4]),
    };
    this.#lendingGuards.set(agentId, next);
    return [{ action_seq: next["action_seq"] }];
  }

  #lendingRescuesInsert(params: readonly unknown[]): Row[] {
    const id = params[0] as string;
    if (this.#lendingRescues.has(id)) return [];
    this.#lendingRescues.set(id, {
      rescue_id: id, agent_id: params[1], owner_address: params[2], journal_key: params[3],
      market: params[4], amount_wei: String(params[5]),
      hf_before: params[6] === null ? null : String(params[6]),
      hf_after: params[7] === null ? null : String(params[7]),
      achieved_hf: params[8] === null ? null : String(params[8]),
      tx_hash: params[9], effect: params[10], partial: params[11],
      conditions: jsonbParam(params[12]), created_at_ms: String(params[13]),
    });
    return [];
  }

  #lendingRescuesList(params: readonly unknown[]): Row[] {
    return [...this.#lendingRescues.values()]
      .filter(
        (row) =>
          sameOwner(row["owner_address"], params[0]) && row["agent_id"] === params[1],
      )
      .sort((left, right) =>
        BigInt(right["created_at_ms"] as string) > BigInt(left["created_at_ms"] as string) ? 1 : -1,
      )
      .slice(0, Number(params[2]))
      .map((row) => structuredClone(row));
  }

  #lendingActionsCharge(params: readonly unknown[]): Row[] {
    const id = params[0] as string;
    if (this.#lendingActions.has(id)) return [];
    this.#lendingActions.set(id, {
      action_id: id, agent_id: params[1], owner_address: params[2],
      kind: params[3], charged_at_ms: String(params[4]),
    });
    return [];
  }

  /** `where owner_address = $1 and agent_id = $2 and kind = 'rescue' and charged_at_ms >= $3` */
  #lendingActionsUsage(params: readonly unknown[]): Row[] {
    const since = BigInt(params[2] as number | string);
    return [...this.#lendingActions.values()]
      .filter(
        (row) =>
          sameOwner(row["owner_address"], params[0])
          && row["agent_id"] === params[1]
          && row["kind"] === "rescue"
          && BigInt(row["charged_at_ms"] as string) >= since,
      )
      .sort((left, right) =>
        BigInt(left["charged_at_ms"] as string) < BigInt(right["charged_at_ms"] as string) ? -1 : 1,
      )
      .map((row) => ({ charged_at_ms: row["charged_at_ms"] }));
  }

  /**
   * `where owner_address = $1 and agent_id = $2 and kind = $3
   *  order by charged_at_ms desc limit 1` (FIXREVIEW F3).
   */
  #lendingActionsLastOfKind(params: readonly unknown[]): Row[] {
    const rows = [...this.#lendingActions.values()]
      .filter(
        (row) =>
          sameOwner(row["owner_address"], params[0])
          && row["agent_id"] === params[1]
          && row["kind"] === params[2],
      )
      .sort((left, right) =>
        BigInt(left["charged_at_ms"] as string) > BigInt(right["charged_at_ms"] as string) ? -1 : 1,
      );
    const row = rows[0];
    return row === undefined ? [] : [{ action_id: row["action_id"] }];
  }

  #lendingSnapshotsPut(params: readonly unknown[]): Row[] {
    const agentId = params[0] as string;
    const existing = this.#lendingSnapshots.get(agentId);
    if (existing !== undefined && !sameOwner(existing["owner_address"], params[1])) return [];
    this.#lendingSnapshots.set(agentId, {
      agent_id: agentId, owner_address: params[1], block_number: String(params[2]),
      observed_at_ms: String(params[3]), snapshot: jsonbParam(params[4]),
    });
    return [];
  }

  #lendingSnapshotsGet(params: readonly unknown[]): Row[] {
    const row = this.#lendingSnapshots.get(params[0] as string);
    if (row === undefined || !sameOwner(row["owner_address"], params[1])) return [];
    return [structuredClone(row)];
  }

  /**
   * The namespaced settings/observation stores are the VENUS classes with a
   * table parameter, so their statements are byte-identical apart from the
   * table name and the tag — and these handlers are the Venus ones with the
   * map passed in.
   */
  #namespacedSettingsGet(map: Map<string, Row>, params: readonly unknown[]): Row[] {
    const row = map.get(params[0] as string);
    if (row === undefined || row["owner_address"] !== params[1]) return [];
    return [structuredClone(row)];
  }

  #namespacedSettingsPut(map: Map<string, Row>, params: readonly unknown[]): Row[] {
    const agentId = params[0] as string;
    const existing = map.get(agentId);
    if (existing !== undefined && existing["owner_address"] !== params[1]) return [];
    const row: Row = {
      agent_id: agentId, owner_address: params[1], params: jsonbParam(params[2]),
      digest: params[3], updated_at: params[4],
    };
    map.set(agentId, row);
    return [structuredClone(row)];
  }

  #namespacedObservationsGet(map: Map<string, Row>, params: readonly unknown[]): Row[] {
    const row = map.get(`${params[0] as string} ${params[1] as string}`);
    if (row === undefined || row["owner_address"] !== params[2]) return [];
    return [structuredClone(row)];
  }

  #namespacedObservationsPut(map: Map<string, Row>, params: readonly unknown[]): Row[] {
    const key = `${params[0] as string} ${params[1] as string}`;
    const existing = map.get(key);
    if (existing !== undefined && existing["owner_address"] !== params[2]) return [];
    map.set(key, {
      agent_id: params[0], kind: params[1], owner_address: params[2],
      evaluated_at_ms: String(params[3]), observation: jsonbParam(params[4]),
      updated_at: params[5],
    });
    return [{ agent_id: params[0] }];
  }

  #namespacedObservationsDelete(map: Map<string, Row>, params: readonly unknown[]): Row[] {
    const key = `${params[0] as string} ${params[1] as string}`;
    const row = map.get(key);
    if (row === undefined || row["owner_address"] !== params[2]) return [];
    map.delete(key);
    return [];
  }

  /* ----- lp settings ----- */

  #lpSettingsGet(params: readonly unknown[]): Row[] {
    const row = this.#lpSettings.get(params[0] as string);
    if (row === undefined || row["owner_address"] !== params[1]) return [];
    return [structuredClone(row)];
  }

  #lpSettingsPut(params: readonly unknown[]): Row[] {
    const agentId = params[0] as string;
    const existing = this.#lpSettings.get(agentId);
    if (existing !== undefined && existing["owner_address"] !== params[1]) {
      // The upsert's UPDATE arm carries the owner predicate: a cross-owner put
      // updates nothing and RETURNING is empty, exactly as real Postgres.
      return [];
    }
    const row: Row = {
      agent_id: agentId,
      owner_address: params[1],
      params: jsonbParam(params[2]),
      digest: params[3],
      updated_at: params[4],
    };
    this.#lpSettings.set(agentId, row);
    return [structuredClone(row)];
  }

  /* ----- lp observations ----- */

  /** Scoped by (position_id, agent_id, owner_address) — all three must match. */
  #lpObservationsGet(params: readonly unknown[]): Row[] {
    const row = this.#lpObservations.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2]
    ) {
      return [];
    }
    return [structuredClone(row)];
  }

  #lpObservationsPut(params: readonly unknown[]): Row[] {
    const positionId = params[0] as string;
    const existing = this.#lpObservations.get(positionId);
    if (existing !== undefined && existing["owner_address"] !== params[2]) {
      // The upsert's UPDATE arm carries the owner predicate: a cross-owner put
      // updates nothing and RETURNING is empty, exactly as real Postgres.
      return [];
    }
    this.#lpObservations.set(positionId, {
      position_id: positionId,
      agent_id: params[1],
      owner_address: params[2],
      // pg hands int8 back as a string; the store reads the jsonb, not this
      // column, but the shape must still match what the driver would return.
      evaluated_at_ms: String(params[3]),
      observation: jsonbParam(params[4]),
      updated_at: params[5],
    });
    return [{ position_id: positionId }];
  }

  #lpObservationsDelete(params: readonly unknown[]): Row[] {
    const row = this.#lpObservations.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2]
    ) {
      return [];
    }
    this.#lpObservations.delete(params[0] as string);
    return [];
  }

  /* ----- LP landing evidence ----- */

  #lpEvidenceRequirementKey(params: readonly unknown[]): string {
    return [params[0], params[1], params[2], params[3]].join("\u0000");
  }

  #lpEvidenceRequirementGet(params: readonly unknown[]): Row[] {
    const row = this.#lpEvidenceRequirements.get(this.#lpEvidenceRequirementKey(params));
    return row === undefined ? [] : [structuredClone(row)];
  }

  #lpCoverageSnapshotRequirement(params: readonly unknown[]): Row[] {
    const existing = this.#lpEvidenceRequirementGet(params);
    if (existing.length !== 0 || this.#strictLpRequirementAuthorization) return existing;
    const lane = this.#lpCoverageCursors.get(String(params[9]));
    const generation = lane?.["generation"] ?? params[10];
    const row = { journal_owner: params[0], journal_agent: params[1], journal_action: params[2],
      journal_idempotency_key: params[3], begun_at_block: String(params[4]),
      expiry: String(params[5]), prepared_identity_hash: params[6], coverage_version: params[7],
      quorum_id: params[8], lane_id: params[9], coverage_generation: String(generation),
      state: params[11], unavailable_code: params[12], created_at: new Date(0), terminal_at: null,
      evidence_retained_until: null, updated_at: new Date(0), row_version: String(params[13]),
      charged_logical_bytes: String(params[14]) };
    this.#lpEvidenceRequirements.set(this.#lpEvidenceRequirementKey(params), row);
    return [structuredClone(row)];
  }

  #lpEvidenceRequirementInsert(params: readonly unknown[]): Row[] {
    const key = this.#lpEvidenceRequirementKey(params);
    if (this.#lpEvidenceRequirements.has(key)) return [];
    const row: Row = {
      journal_owner: params[0], journal_agent: params[1], journal_action: params[2],
      journal_idempotency_key: params[3], begun_at_block: String(params[4]),
      expiry: String(params[5]), prepared_identity_hash: params[6],
      coverage_version: params[7], quorum_id: params[8], lane_id: params[9],
      coverage_generation: String(params[10]),
      state: "eligible", unavailable_code: null, created_at: params[11],
      terminal_at: null, evidence_retained_until: null, updated_at: params[11],
      row_version: "0", charged_logical_bytes: String(params[12]),
    };
    this.#lpEvidenceRequirements.set(key, row);
    return [structuredClone(row)];
  }

  #lpEvidenceRequirementTerminal(params: readonly unknown[]): Row[] {
    const row = this.#lpEvidenceRequirements.get(this.#lpEvidenceRequirementKey(params));
    if (row === undefined || row["state"] !== "eligible" ||
        row["unavailable_code"] !== null ||
        String(row["coverage_generation"]) !== String(params[6]) ||
        String(row["row_version"]) !== String(params[7])) return [];
    row["state"] = "terminal"; row["terminal_at"] = params[4];
    row["evidence_retained_until"] = params[5]; row["updated_at"] = params[4];
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    return [structuredClone(row)];
  }

  #lpEvidenceRequirementDelete(params: readonly unknown[]): Row[] {
    const key = this.#lpEvidenceRequirementKey(params);
    const row = this.#lpEvidenceRequirements.get(key);
    if (row === undefined || BigInt(String(row["row_version"])) !== BigInt(String(params[4])) ||
        BigInt(String(row["charged_logical_bytes"])) !== BigInt(String(params[5]))) return [];
    this.#lpEvidenceRequirements.delete(key);
    return [{ journal_owner: row["journal_owner"] }];
  }

  #lpEvidenceResolutionInsert(params: readonly unknown[]): Row[] {
    const id = String(params[0]);
    if (this.#lpLandingResolutions.has(id)) return [];
    const row: Row = {
      resolution_id: id, target_owner: params[1], target_agent: params[2],
      target_journal_action: params[3], target_journal_idempotency_key: params[4],
      prepared_identity_hash: params[5], evidence_version: params[6],
      claim_initiator_action_owner: params[7], claim_initiator_action_agent: params[8],
      claim_initiator_action_kind: params[9],
      claim_initiator_action_idempotency_key: params[10], origin_sequence_id: params[11],
      origin_snapshot_hash: params[12], phase: "claimed", outcome: null,
      target_journal_terminal_state: null, sequence_state_at_resolution: null,
      recovery_after_confirm: null, response_action: null, response_inference: null,
      evidence_hash: null, evidence_retained_until: null, terminal_at: null,
      terminalizing_action_owner: null, terminalizing_action_agent: null,
      terminalizing_action_kind: null, terminalizing_action_idempotency_key: null,
      row_version: "0", created_at: params[13], updated_at: params[13],
      evidence_cleanup_completed_at: null, evidence_cleanup_charged_bytes: null,
    };
    this.#lpLandingResolutions.set(id, row);
    return [structuredClone(row)];
  }

  #lpEvidenceResolutionGet(params: readonly unknown[]): Row[] {
    const row = this.#lpLandingResolutions.get(String(params[0]));
    return row === undefined ? [] : [structuredClone(row)];
  }

  #lpEvidenceResolutionBind(params: readonly unknown[]): Row[] {
    const row = this.#lpLandingResolutions.get(String(params[0]));
    if (row === undefined || BigInt(String(row["row_version"])) !== BigInt(String(params[1])) ||
        row["phase"] !== params[2]) return [];
    row["phase"] = "evidence-bound"; row["outcome"] = params[3];
    row["response_inference"] = params[3]; row["evidence_hash"] = params[4];
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    row["updated_at"] = params[5];
    return [structuredClone(row)];
  }

  #lpEvidenceResolutionAdvance(params: readonly unknown[]): Row[] {
    const row = this.#lpLandingResolutions.get(String(params[0]));
    if (row === undefined || BigInt(String(row["row_version"])) !== BigInt(String(params[1])) ||
        row["phase"] !== params[2]) return [];
    row["phase"] = params[3];
    const names = ["outcome", "target_journal_terminal_state", "sequence_state_at_resolution",
      "recovery_after_confirm", "response_action"];
    for (let i = 0; i < names.length; i += 1) {
      const value = params[4 + i];
      if (value !== null && value !== undefined) row[names[i] ?? ""] = value;
    }
    if (params[4] !== null && params[4] !== undefined) row["response_inference"] = params[4];
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    row["updated_at"] = params[9];
    return [structuredClone(row)];
  }

  #lpEvidenceResolutionTerminal(params: readonly unknown[]): Row[] {
    const row = this.#lpLandingResolutions.get(String(params[0]));
    if (row === undefined || BigInt(String(row["row_version"])) !== BigInt(String(params[1])) ||
        row["phase"] !== params[2]) return [];
    row["phase"] = "terminal"; row["sequence_state_at_resolution"] = params[3];
    row["terminalizing_action_owner"] = params[4]; row["terminalizing_action_agent"] = params[5];
    row["terminalizing_action_kind"] = params[6];
    row["terminalizing_action_idempotency_key"] = params[7];
    row["terminal_at"] = params[8]; row["evidence_retained_until"] = params[9];
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    row["updated_at"] = params[8];
    return [structuredClone(row)];
  }

  #lpEvidenceResolutionDelete(params: readonly unknown[]): Row[] {
    const id = String(params[0]);
    const row = this.#lpLandingResolutions.get(id);
    if (row === undefined || BigInt(String(row["row_version"])) !== BigInt(String(params[1])) ||
        (row["phase"] !== "claimed" && row["phase"] !== "evidence-bound")) return [];
    this.#lpLandingResolutions.delete(id);
    return [{ resolution_id: id }];
  }

  #lpEvidenceBodyInsert(params: readonly unknown[]): Row[] {
    const id = String(params[0]);
    if (this.#lpLandingEvidence.has(id)) return [];
    const row: Row = { resolution_id: id, evidence_version: params[1], evidence_bytes: params[2],
      evidence_hash: params[3], coverage_version: params[4], quorum_id: params[5], lane_id: params[6],
      generation: String(params[7]), cursor_row_version: String(params[8]), retained_until: null,
      created_at: params[9], charged_logical_bytes: String(params[10]) };
    this.#lpLandingEvidence.set(id, row);
    return [structuredClone(row)];
  }

  #lpEvidenceBodyGet(params: readonly unknown[]): Row[] {
    const row = this.#lpLandingEvidence.get(String(params[0]));
    return row === undefined ? [] : [structuredClone(row)];
  }

  #lpEvidenceBodyRetain(params: readonly unknown[]): Row[] {
    const row = this.#lpLandingEvidence.get(String(params[0]));
    if (row === undefined || row["evidence_hash"] !== params[1] || row["retained_until"] !== null) return [];
    row["retained_until"] = params[2];
    return [structuredClone(row)];
  }

  #lpEvidenceBodyDelete(params: readonly unknown[]): Row[] {
    const id = String(params[0]);
    const row = this.#lpLandingEvidence.get(id);
    if (row === undefined || row["evidence_hash"] !== params[1] ||
        (params.length > 3 && asTime(row["retained_until"]) !== asTime(params[2])) ||
        BigInt(String(row["charged_logical_bytes"])) !== BigInt(String(params.at(-1)))) return [];
    this.#lpLandingEvidence.delete(id);
    return [{ resolution_id: id }];
  }

  #lpEvidenceQuotaKey(scope: unknown, version: unknown): string {
    return `${String(scope)}\u0000${String(version)}`;
  }

  #lpEvidenceQuotaEnsure(params: readonly unknown[]): Row[] {
    for (const [scope, version] of [["global", ""], ["coverage-version", params[0]]] as const) {
      const key = this.#lpEvidenceQuotaKey(scope, version);
      if (!this.#lpEvidenceQuotas.has(key)) this.#lpEvidenceQuotas.set(key, {
        scope, coverage_version: version, logical_bytes: "0", block_rows: "0",
        candidate_rows: "0", requirement_rows: "0", zero_expiry_rows: "0",
        row_version: "0", updated_at: params[1],
      });
    }
    return [];
  }

  #lpEvidenceReleaseQuotaEnsure(params: readonly unknown[]): Row[] {
    const key = this.#lpEvidenceQuotaKey("global", "");
    if (!this.#lpEvidenceQuotas.has(key)) this.#lpEvidenceQuotas.set(key, {
      scope: "global", coverage_version: "", logical_bytes: "0", block_rows: "0",
      candidate_rows: "0", requirement_rows: "0", zero_expiry_rows: "0",
      row_version: "0", updated_at: params[0],
    });
    return [];
  }

  #lpEvidenceQuotaGet(scope: unknown, version: unknown): Row[] {
    const row = this.#lpEvidenceQuotas.get(this.#lpEvidenceQuotaKey(scope, version));
    return row === undefined ? [] : [structuredClone(row)];
  }

  #lpEvidenceQuotaUpdate(params: readonly unknown[]): Row[] {
    const row = this.#lpEvidenceQuotas.get(this.#lpEvidenceQuotaKey(params[0], params[1]));
    if (row === undefined) return [];
    const fields = ["logical_bytes", "block_rows", "candidate_rows", "requirement_rows", "zero_expiry_rows"];
    const next = fields.map((field, index) => BigInt(String(row[field])) + BigInt(String(params[2 + index])));
    if (next.some((value) => value < 0n)) return [];
    fields.forEach((field, index) => { row[field] = next[index]?.toString(10) ?? "0"; });
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    row["updated_at"] = params[7];
    return [{ row_version: row["row_version"] }];
  }

  #lpEvidenceCleanupSelect(params: readonly unknown[]): Row[] {
    return [...this.#lpLandingResolutions.values()]
      .filter((row) => row["phase"] === "terminal" && row["evidence_retained_until"] !== null &&
        asTime(row["evidence_retained_until"]) <= asTime(params[0]) &&
        row["evidence_cleanup_completed_at"] === null)
      .sort((a, b) => asTime(a["evidence_retained_until"]) - asTime(b["evidence_retained_until"]) ||
        String(a["resolution_id"]).localeCompare(String(b["resolution_id"])))
      .slice(0, Number(params[1])).map((row) => structuredClone(row));
  }

  #lpEvidenceCleanupLaneCitations(params: readonly unknown[]): Row[] {
    let count = 0;
    for (const row of this.#lpEvidenceRequirements.values()) {
      const current = row["journal_owner"] === params[1] && row["journal_agent"] === params[2] &&
        row["journal_action"] === params[3] && row["journal_idempotency_key"] === params[4];
      if (row["lane_id"] === params[0] && !current) count += 1;
    }
    for (const row of this.#lpLandingEvidence.values()) {
      if (row["lane_id"] === params[0] && row["resolution_id"] !== params[5]) count += 1;
    }
    return [{ citation_count: count }];
  }

  #lpEvidenceCleanupPrefixDelete(params: readonly unknown[]): Row[] {
    const key = this.#lpCoveragePrefixKey(params);
    const row = this.#lpCoveragePrefixes.get(key);
    if (row === undefined || row["generation"] !== String(params[4]) ||
        row["prefix_digest"] !== params[5] || asTime(row["updated_at"]) !== asTime(params[6]) ||
        String(row["charged_logical_bytes"]) !== String(params[7])) return [];
    this.#lpCoveragePrefixes.delete(key);
    return [{ journal_owner: row["journal_owner"] }];
  }

  #lpEvidenceCleanupChunksLock(params: readonly unknown[]): Row[] {
    return [...this.#lpCoverageChunks.values()]
      .filter((row) => row["lane_id"] === params[0])
      .sort((left, right) => {
        const generation = BigInt(String(left["generation"])) - BigInt(String(right["generation"]));
        if (generation !== 0n) return generation < 0n ? -1 : 1;
        const source = String(left["source_id"]).localeCompare(String(right["source_id"]));
        if (source !== 0) return source;
        const from = BigInt(String(left["from_block"])) - BigInt(String(right["from_block"]));
        return from < 0n ? -1 : from > 0n ? 1 : 0;
      })
      .map((row) => structuredClone(row));
  }

  #lpEvidenceCleanupRawCharge(params: readonly unknown[]): Row[] {
    let blockBytes = 0n; let candidateBytes = 0n; let blockRows = 0; let candidateRows = 0;
    for (const row of this.#lpCoverageBlocks.values()) if (row["lane_id"] === params[0]) {
      blockBytes += BigInt(String(row["logical_bytes"])); blockRows += 1;
    }
    for (const row of this.#lpCoverageCandidates.values()) if (row["lane_id"] === params[0]) {
      candidateBytes += BigInt(String(row["logical_bytes"])); candidateRows += 1;
    }
    return [{ block_bytes: blockBytes.toString(10), candidate_bytes: candidateBytes.toString(10),
      block_rows: blockRows, candidate_rows: candidateRows }];
  }

  #lpEvidenceCleanupChunkExact(params: readonly unknown[]): Row[] {
    const key = [params[2], params[3], params[4], params[5], params[6]].join("\u0000");
    const row = this.#lpCoverageChunks.get(key);
    const sameNullable = (left: unknown, right: unknown): boolean =>
      left === null || left === undefined ? right === null || right === undefined : left === right;
    if (row === undefined || row["coverage_version"] !== params[0] ||
        row["quorum_id"] !== params[1] || row["state"] !== params[7] ||
        String(row["lease_fence"]) !== String(params[8]) ||
        !sameNullable(row["first_hash"], params[9]) ||
        !sameNullable(row["last_hash"], params[10]) ||
        !sameNullable(row["ordered_block_digest"], params[11]) ||
        String(row["candidate_count"]) !== String(params[12]) ||
        (row["completed_at"] === null || row["completed_at"] === undefined
          ? params[13] !== null && params[13] !== undefined
          : params[13] === null || params[13] === undefined ||
            asTime(row["completed_at"]) !== asTime(params[13])) ||
        !sameNullable(row["error_code"], params[14]) ||
        String(row["charged_logical_bytes"]) !== String(params[15])) return [];
    this.#lpCoverageChunks.delete(key);
    return [{ source_id: row["source_id"] }];
  }

  #lpEvidenceCleanupCandidates(params: readonly unknown[]): Row[] {
    for (const [key, row] of this.#lpCoverageCandidates) {
      if (row["lane_id"] === params[0]) this.#lpCoverageCandidates.delete(key);
    }
    return [];
  }

  #lpEvidenceCleanupBlocks(params: readonly unknown[]): Row[] {
    for (const [key, row] of this.#lpCoverageBlocks) {
      if (row["lane_id"] === params[0]) this.#lpCoverageBlocks.delete(key);
    }
    return [];
  }

  #lpEvidenceCleanupLease(params: readonly unknown[]): Row[] {
    this.#lpCoverageLeases.delete(String(params[0])); return [];
  }

  #lpEvidenceCleanupCursor(params: readonly unknown[]): Row[] {
    this.#lpCoverageCursors.delete(String(params[0])); return [];
  }

  #lpEvidenceCleanupTombstone(params: readonly unknown[]): Row[] {
    const row = this.#lpLandingResolutions.get(String(params[0]));
    if (row === undefined || row["evidence_cleanup_completed_at"] !== null ||
        row["evidence_cleanup_charged_bytes"] !== null) return [];
    row["evidence_cleanup_completed_at"] = params[1];
    row["evidence_cleanup_charged_bytes"] = String(params[2]);
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    row["updated_at"] = params[1];
    return [{ resolution_id: row["resolution_id"] }];
  }

  /* ----- LP finalized coverage ----- */

  #lpCoverageCursorEnsure(params: readonly unknown[]): Row[] {
    const id = String(params[2]);
    if (!this.#lpCoverageCursors.has(id)) this.#lpCoverageCursors.set(id, {
      coverage_version: params[0], quorum_id: params[1], lane_id: id,
      purpose: params[3], admission_key_hash: params[4], origin_block: String(params[5]),
      covered_through: null, covered_through_hash: null,
      covered_through_timestamp: null, raw_retained_from: String(params[5]),
      generation: "0", state: "active", row_version: "0",
    });
    return [];
  }

  #lpCoverageCursorGet(params: readonly unknown[]): Row[] {
    const row = this.#lpCoverageCursors.get(String(params[0]));
    return row === undefined ? [] : [structuredClone(row)];
  }

  #lpCoverageAdmissionLane(params: readonly unknown[]): Row[] {
    const begun = BigInt(String(params[2]));
    const rows = [...this.#lpCoverageCursors.values()].filter((row) =>
      row["coverage_version"] === params[0] && row["quorum_id"] === params[1] &&
      row["state"] === "active" && BigInt(String(row["origin_block"])) <= begun &&
      BigInt(String(row["raw_retained_from"])) <= begun &&
      (row["purpose"] === "base" || row["admission_key_hash"] === params[3]));
    return rows.sort((a, b) => BigInt(String(a["origin_block"])) >
      BigInt(String(b["origin_block"])) ? -1 : 1).slice(0, 1).map((row) => structuredClone(row));
  }

  #lpCoverageBaseLane(params: readonly unknown[]): Row[] {
    const begun = BigInt(String(params[2]));
    return [...this.#lpCoverageCursors.values()].filter((row) =>
      row["coverage_version"] === params[0] && row["quorum_id"] === params[1] &&
      row["purpose"] === "base" && BigInt(String(row["origin_block"])) <= begun)
      .sort((a, b) => BigInt(String(a["origin_block"])) >
        BigInt(String(b["origin_block"])) ? -1 : 1).slice(0, 1)
      .map((row) => structuredClone(row));
  }

  #lpCoverageLeaseEnsure(params: readonly unknown[]): Row[] {
    const lane = String(params[2]);
    if (!this.#lpCoverageLeases.has(lane)) this.#lpCoverageLeases.set(lane, {
      coverage_version: params[0], quorum_id: params[1], lane_id: lane,
      holder_id: params[3], fence: "0", lease_until: params[4], updated_at: params[5],
    });
    return [];
  }

  #lpCoverageLeaseClaim(params: readonly unknown[]): Row[] {
    const row = this.#lpCoverageLeases.get(String(params[0]));
    if (row === undefined) return [];
    const now = new Date(params[3] as Date | string).getTime();
    if (new Date(row["lease_until"] as Date | string).getTime() > now &&
        row["holder_id"] !== params[1]) return [];
    row["holder_id"] = params[1];
    row["fence"] = (BigInt(String(row["fence"])) + 1n).toString(10);
    row["lease_until"] = params[2]; row["updated_at"] = params[3];
    return [structuredClone(row)];
  }

  #lpCoverageLeaseLock(params: readonly unknown[]): Row[] {
    const row = this.#lpCoverageLeases.get(String(params[2]));
    if (row === undefined || row["coverage_version"] !== params[0] ||
        row["quorum_id"] !== params[1]) return [];
    return [structuredClone(row)];
  }

  #lpCoverageBackfillPrune(params: readonly unknown[]): Row[] {
    const before = new Date(params[0] as Date | string).getTime();
    for (const [key, row] of this.#lpCoverageBackfillBudgets) {
      if (new Date(row["window_start"] as Date | string).getTime() < before) {
        this.#lpCoverageBackfillBudgets.delete(key);
      }
    }
    return [];
  }

  #lpCoverageBackfillEnsure(params: readonly unknown[]): Row[] {
    const key = `${String(params[0])}:${new Date(params[1] as Date | string).getTime()}`;
    if (!this.#lpCoverageBackfillBudgets.has(key)) this.#lpCoverageBackfillBudgets.set(key, {
      coverage_version: params[0], window_start: params[1], blocks: "0",
      row_version: "0", updated_at: params[2],
    });
    return [];
  }

  #lpCoverageBackfillReserve(params: readonly unknown[]): Row[] {
    const key = `${String(params[0])}:${new Date(params[1] as Date | string).getTime()}`;
    const row = this.#lpCoverageBackfillBudgets.get(key);
    if (row === undefined || Number(row["blocks"]) + Number(params[2]) > Number(params[4])) return [];
    row["blocks"] = Number(row["blocks"]) + Number(params[2]);
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    row["updated_at"] = params[3];
    return [{ blocks: row["blocks"] }];
  }

  #lpCoverageCompactRequirements(params: readonly unknown[]): Row[] {
    return [...this.#lpEvidenceRequirements.values()].filter((row) =>
      row["lane_id"] === params[0] && row["state"] === "eligible" &&
      row["unavailable_code"] === null &&
      String(row["coverage_generation"]) === String(params[1]))
      .map((row) => structuredClone(row));
  }

  #lpCoveragePrefixKey(params: readonly unknown[]): string {
    return [params[0], params[1], params[2], params[3]].join("\u0000");
  }

  #lpCoverageCompactPrefixLock(params: readonly unknown[]): Row[] {
    const row = this.#lpCoveragePrefixes.get(this.#lpCoveragePrefixKey(params));
    return row === undefined ? [] : [structuredClone(row)];
  }

  #lpCoverageCompactChunksLock(params: readonly unknown[]): Row[] {
    const from = BigInt(String(params[2])); const to = BigInt(String(params[3]));
    return [...this.#lpCoverageChunks.values()].filter((row) => row["lane_id"] === params[0] &&
      row["generation"] === String(params[1]) && row["state"] === "complete" &&
      BigInt(String(row["from_block"])) >= from && BigInt(String(row["to_block"])) <= to)
      .sort((a, b) => BigInt(String(a["from_block"])) < BigInt(String(b["from_block"])) ? -1 :
        String(a["source_id"]).localeCompare(String(b["source_id"])))
      .map((row) => structuredClone(row));
  }

  #lpCoverageCompactCandidateCount(params: readonly unknown[]): Row[] {
    const from = BigInt(String(params[2])); const to = BigInt(String(params[3])); let count = 0;
    for (const row of this.#lpCoverageCandidates.values()) if (row["lane_id"] === params[0] &&
      row["generation"] === String(params[1]) && BigInt(String(row["block_number"])) >= from &&
      BigInt(String(row["block_number"])) <= to) count += 1;
    return [{ candidate_count: count }];
  }

  #lpCoverageCompactTerminalBlock(params: readonly unknown[]): Row[] {
    const hashes = new Map<string, Set<string>>();
    for (const row of this.#lpCoverageBlocks.values()) if (row["lane_id"] === params[0] &&
      row["generation"] === String(params[1]) && row["block_number"] === String(params[2])) {
      const hash = String(row["block_hash"]); const sources = hashes.get(hash) ?? new Set<string>();
      sources.add(String(row["source_id"])); hashes.set(hash, sources);
    }
    return [...hashes.entries()].map(([block_hash, sources]) =>
      ({ block_hash, source_count: sources.size }));
  }

  #lpCoverageCompactRawCharge(params: readonly unknown[]): Row[] {
    const from = BigInt(String(params[2])); const to = BigInt(String(params[3]));
    let bytes = 0n; let rows = 0;
    for (const row of this.#lpCoverageBlocks.values()) if (row["lane_id"] === params[0] &&
      row["generation"] === String(params[1]) && BigInt(String(row["block_number"])) >= from &&
      BigInt(String(row["block_number"])) <= to) {
      bytes += BigInt(String(row["logical_bytes"])); rows += 1;
    }
    return [{ block_bytes: bytes.toString(10), block_rows: rows }];
  }

  #lpCoverageCompactPrefixInsert(params: readonly unknown[]): Row[] {
    const key = this.#lpCoveragePrefixKey(params);
    if (this.#lpCoveragePrefixes.has(key)) return [];
    const row: Row = { journal_owner: params[0], journal_agent: params[1],
      journal_action: params[2], journal_idempotency_key: params[3], coverage_version: params[4],
      quorum_id: params[5], lane_id: params[6], generation: String(params[7]),
      from_block: String(params[8]), to_block: String(params[9]), to_block_hash: params[10],
      required_source_digest_accumulator: params[11], prefix_digest: params[12], match_count: "0",
      generation_carry_digest: null, carry_parent_digest: null, carry_source_accumulator: null,
      carried_from_generation: null, carry_from_block: null, carry_to_block: null,
      carry_to_block_hash: null, charged_logical_bytes: String(params[13]), updated_at: params[14] };
    this.#lpCoveragePrefixes.set(key, row); return [{ journal_owner: params[0] }];
  }

  #lpCoverageCompactPrefixExtend(params: readonly unknown[]): Row[] {
    const row = this.#lpCoveragePrefixes.get(this.#lpCoveragePrefixKey(params));
    if (row === undefined || row["generation"] !== String(params[9]) ||
        row["prefix_digest"] !== params[10] || String(row["charged_logical_bytes"]) !== String(params[11])) return [];
    row["to_block"] = String(params[4]); row["to_block_hash"] = params[5];
    row["required_source_digest_accumulator"] = params[6]; row["prefix_digest"] = params[7];
    row["updated_at"] = params[8]; return [{ journal_owner: row["journal_owner"] }];
  }

  #lpCoverageCompactChunksDelete(params: readonly unknown[]): Row[] {
    const from = BigInt(String(params[2])); const to = BigInt(String(params[3]));
    for (const [key, row] of this.#lpCoverageChunks) if (row["lane_id"] === params[0] &&
      row["generation"] === String(params[1]) && BigInt(String(row["from_block"])) >= from &&
      BigInt(String(row["to_block"])) <= to) this.#lpCoverageChunks.delete(key);
    return [];
  }

  #lpCoverageCompactBlocksDelete(params: readonly unknown[]): Row[] {
    const from = BigInt(String(params[2])); const to = BigInt(String(params[3]));
    for (const [key, row] of this.#lpCoverageBlocks) if (row["lane_id"] === params[0] &&
      row["generation"] === String(params[1]) && BigInt(String(row["block_number"])) >= from &&
      BigInt(String(row["block_number"])) <= to) this.#lpCoverageBlocks.delete(key);
    return [];
  }

  #lpCoverageCompactCursor(params: readonly unknown[]): Row[] {
    const row = this.#lpCoverageCursors.get(String(params[0]));
    if (row === undefined || row["generation"] !== String(params[3]) ||
        row["row_version"] !== String(params[4]) || row["raw_retained_from"] !== String(params[5])) return [];
    row["raw_retained_from"] = String(params[1]);
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    return [{ lane_id: row["lane_id"] }];
  }

  #lpCoverageCompactQuotaUpdate(params: readonly unknown[]): Row[] {
    const row = this.#lpEvidenceQuotas.get(this.#lpEvidenceQuotaKey(params[0], params[1]));
    if (row === undefined) return [];
    const bytes = BigInt(String(row["logical_bytes"])) + BigInt(String(params[2]));
    const blocks = BigInt(String(row["block_rows"])) - BigInt(String(params[3]));
    if (bytes < 0n || blocks < 0n) return [];
    row["logical_bytes"] = bytes.toString(10); row["block_rows"] = blocks.toString(10);
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    return [{ row_version: row["row_version"] }];
  }

  #lpCoverageCursorList(params: readonly unknown[]): Row[] {
    return [...this.#lpCoverageCursors.values()]
      .filter((row) => (row["state"] === "active" || row["state"] === "gap") &&
        [...this.#lpEvidenceRequirements.values()].some((requirement) =>
          requirement["lane_id"] === row["lane_id"] && requirement["state"] === "eligible" &&
          requirement["unavailable_code"] === null &&
          String(requirement["coverage_generation"]) === String(row["generation"])))
      .slice(0, Number(params[0])).map((row) => structuredClone(row));
  }

  #lpCoverageChunkInsert(params: readonly unknown[]): Row[] {
    const key = [params[2], params[3], params[4], params[5], params[6]].join("\u0000");
    if (!this.#lpCoverageChunks.has(key)) this.#lpCoverageChunks.set(key, {
      coverage_version: params[0], quorum_id: params[1], lane_id: params[2],
      generation: String(params[3]), source_id: params[4], from_block: String(params[5]),
      to_block: String(params[6]), state: "complete", lease_fence: String(params[13]),
      first_hash: params[7], last_hash: params[8], ordered_block_digest: params[9],
      candidate_count: params[10], charged_logical_bytes: String(params[11]),
      completed_at: params[12], error_code: null,
    });
    return [];
  }

  #lpCoverageInvalidateChunks(params: readonly unknown[]): Row[] {
    for (const row of this.#lpCoverageChunks.values()) {
      if (row["lane_id"] === params[0] && row["generation"] === String(params[1]) &&
          (params[2] === null || BigInt(String(row["to_block"])) > BigInt(String(params[2])))) {
        row["state"] = "invalidated";
        row["lease_fence"] = (BigInt(String(row["lease_fence"])) + 1n).toString(10);
      }
    }
    return [];
  }

  #lpCoverageRewindChunksLock(params: readonly unknown[]): Row[] {
    return [...this.#lpCoverageChunks.values()]
      .filter((row) => row["lane_id"] === params[0] &&
        row["generation"] === String(params[1]) && row["state"] !== "invalidated")
      .sort((a, b) => String(a["source_id"]).localeCompare(String(b["source_id"])) ||
        (BigInt(String(a["from_block"])) < BigInt(String(b["from_block"])) ? -1 :
          BigInt(String(a["from_block"])) > BigInt(String(b["from_block"])) ? 1 :
            BigInt(String(a["to_block"])) < BigInt(String(b["to_block"])) ? -1 : 1))
      .map((row) => structuredClone(row));
  }

  #lpCoverageRewindChunkBlocks(params: readonly unknown[]): Row[] {
    const from = BigInt(String(params[5])); const to = BigInt(String(params[6]));
    return [...this.#lpCoverageBlocks.values()].filter((row) =>
      row["coverage_version"] === params[0] && row["quorum_id"] === params[1] &&
      row["lane_id"] === params[2] && row["generation"] === String(params[3]) &&
      row["source_id"] === params[4] && BigInt(String(row["block_number"])) >= from &&
      BigInt(String(row["block_number"])) <= to)
      .sort((left, right) => BigInt(String(left["block_number"])) <
        BigInt(String(right["block_number"])) ? -1 : 1)
      .map((row) => structuredClone(row));
  }

  #lpCoverageRewindChunkCandidateCount(params: readonly unknown[]): Row[] {
    const from = BigInt(String(params[5])); const to = BigInt(String(params[6]));
    const candidateCount = [...this.#lpCoverageCandidates.values()].filter((row) =>
      row["coverage_version"] === params[0] && row["quorum_id"] === params[1] &&
      row["lane_id"] === params[2] && row["generation"] === String(params[3]) &&
      row["source_id"] === params[4] && BigInt(String(row["block_number"])) >= from &&
      BigInt(String(row["block_number"])) <= to).length;
    return [{ candidate_count: candidateCount }];
  }

  #lpCoverageRewindRawCharge(params: readonly unknown[]): Row[] {
    const lane = String(params[0]); const generation = String(params[1]);
    const ancestor = BigInt(String(params[2]));
    const blocks = [...this.#lpCoverageBlocks.values()].filter((row) =>
      row["lane_id"] === lane && row["generation"] === generation &&
      BigInt(String(row["block_number"])) <= ancestor);
    const candidates = [...this.#lpCoverageCandidates.values()].filter((row) =>
      row["lane_id"] === lane && row["generation"] === generation &&
      BigInt(String(row["block_number"])) <= ancestor);
    return [{ block_bytes: blocks.reduce((sum, row) =>
      sum + BigInt(String(row["logical_bytes"])), 0n).toString(10),
    candidate_bytes: candidates.reduce((sum, row) =>
      sum + BigInt(String(row["logical_bytes"])), 0n).toString(10),
    block_rows: blocks.length, candidate_rows: candidates.length }];
  }

  #lpCoverageInvalidateChunkExact(params: readonly unknown[]): Row[] {
    const key = [params[2], params[3], params[4], params[5], params[6]].join("\u0000");
    const row = this.#lpCoverageChunks.get(key);
    const sameNullable = (left: unknown, right: unknown): boolean =>
      left === null || left === undefined ? right === null || right === undefined : left === right;
    if (row === undefined || row["coverage_version"] !== params[0] ||
        row["quorum_id"] !== params[1] || row["state"] !== params[7] ||
        String(row["lease_fence"]) !== String(params[8]) ||
        !sameNullable(row["first_hash"], params[9]) ||
        !sameNullable(row["last_hash"], params[10]) ||
        !sameNullable(row["ordered_block_digest"], params[11]) ||
        String(row["candidate_count"]) !== String(params[12]) ||
        (row["completed_at"] === null || row["completed_at"] === undefined
          ? params[13] !== null && params[13] !== undefined
          : params[13] === null || params[13] === undefined ||
            asTime(row["completed_at"]) !== asTime(params[13])) ||
        !sameNullable(row["error_code"], params[14]) ||
        String(row["charged_logical_bytes"]) !== String(params[15])) return [];
    row["state"] = "invalidated";
    row["lease_fence"] = (BigInt(String(row["lease_fence"])) + 1n).toString(10);
    return [{ source_id: row["source_id"] }];
  }

  #lpCoverageRewindChunkInsert(params: readonly unknown[]): Row[] {
    const key = [params[2], params[3], params[4], params[5], params[6]].join("\u0000");
    if (this.#lpCoverageChunks.has(key)) return [];
    const row: Row = { coverage_version: params[0], quorum_id: params[1], lane_id: params[2],
      generation: String(params[3]), source_id: params[4], from_block: String(params[5]),
      to_block: String(params[6]), state: "complete", lease_fence: String(params[7]),
      first_hash: params[8], last_hash: params[9], ordered_block_digest: params[10],
      candidate_count: params[11], charged_logical_bytes: String(params[12]),
      completed_at: params[13], error_code: null };
    this.#lpCoverageChunks.set(key, row);
    return [{ source_id: row["source_id"] }];
  }

  #lpCoverageBlockInsert(params: readonly unknown[]): Row[] {
    const key = [params[2], params[3], params[4], params[5]].join("\u0000");
    if (!this.#lpCoverageBlocks.has(key)) this.#lpCoverageBlocks.set(key, {
      coverage_version: params[0], quorum_id: params[1], lane_id: params[2],
      generation: String(params[3]), source_id: params[4], block_number: String(params[5]),
      block_hash: params[6], parent_hash: params[7], block_timestamp: String(params[8]),
      ordered_transaction_digest: params[9], logical_bytes: String(params[11]),
    });
    return [];
  }

  #lpCoverageCandidateInsert(params: readonly unknown[]): Row[] {
    const key = [params[2], params[3], params[4], params[7], params[12], params[10]].join("\u0000");
    if (!this.#lpCoverageCandidates.has(key)) this.#lpCoverageCandidates.set(key, {
      coverage_version: params[0], quorum_id: params[1], lane_id: params[2],
      generation: String(params[3]), source_id: params[4], block_number: String(params[5]),
      block_hash: params[6], transaction_hash: params[7], transaction_index: String(params[8]),
      input_hash: params[9], log_index: String(params[10]), orchestrator: params[11],
      orchestrator_version: "0.5.5", decoder: "porto-orchestrator-intent-v055",
      intent_index: params[12], member_count: params[13], eoa: params[14], nonce: String(params[15]),
      execution_data_hash: params[16], key_hash: params[17], receipt_status: String(params[18]),
      incremented: params[19], event_error: params[20], event_topics_hash: params[21],
      event_data_hash: params[22], candidate_digest: params[23], logical_bytes: String(params[24]),
    });
    return [];
  }

  #lpCoverageCursorAdvance(params: readonly unknown[]): Row[] {
    const row = this.#lpCoverageCursors.get(String(params[0]));
    if (row === undefined || BigInt(String(row["row_version"])) !== BigInt(String(params[4])) ||
        BigInt(String(row["generation"])) !== BigInt(String(params[5]))) return [];
    row["covered_through"] = String(params[1]); row["covered_through_hash"] = params[2];
    row["covered_through_timestamp"] = String(params[6]); row["state"] = "active";
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    return [structuredClone(row)];
  }

  #lpCoverageCursorGap(params: readonly unknown[]): Row[] {
    const row = this.#lpCoverageCursors.get(String(params[0]));
    if (row !== undefined && BigInt(String(row["generation"])) === BigInt(String(params[1])) &&
        BigInt(String(row["row_version"])) === BigInt(String(params[2]))) {
      row["state"] = "gap";
      row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    }
    return [];
  }

  #lpCoverageRecentBlocks(params: readonly unknown[]): Row[] {
    const lane = String(params[0]); const generation = String(params[1]);
    const unique = new Map<string, Row>();
    for (const row of this.#lpCoverageBlocks.values()) {
      if (row["lane_id"] === lane && row["generation"] === generation) {
        unique.set(String(row["block_number"]), row);
      }
    }
    return [...unique.values()].sort((a, b) =>
      BigInt(String(a["block_number"])) > BigInt(String(b["block_number"])) ? -1 : 1)
      .slice(0, Number(params[2])).map((row) => structuredClone(row));
  }

  #lpCoveragePrefixBoundaries(params: readonly unknown[]): Row[] {
    return [...this.#lpCoveragePrefixes.values()].filter((row) =>
      row["lane_id"] === params[0] && row["generation"] === String(params[1]))
      .map((row) => ({ to_block: row["to_block"], to_block_hash: row["to_block_hash"] }));
  }

  #lpCoverageRewindPrefixes(params: readonly unknown[]): Row[] {
    return [...this.#lpCoveragePrefixes.values()].filter((row) =>
      row["lane_id"] === params[0] && row["generation"] === String(params[1]))
      .map((row) => structuredClone(row));
  }

  #lpCoverageRewindPrefixUnavailable(params: readonly unknown[]): Row[] {
    const key = [params[0], params[1], params[2], params[3]].join("\u0000");
    const row = this.#lpEvidenceRequirements.get(key);
    if (row === undefined || row["state"] !== "eligible" ||
        row["unavailable_code"] !== null ||
        String(row["coverage_generation"]) !== String(params[5])) return [];
    row["state"] = "unavailable"; row["unavailable_code"] = "compacted-prefix-reorg";
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    return [{ journal_owner: row["journal_owner"] }];
  }

  #lpCoverageRewindPrefixCarry(params: readonly unknown[]): Row[] {
    const row = this.#lpCoveragePrefixes.get(this.#lpCoveragePrefixKey(params));
    if (row === undefined || row["generation"] !== String(params[8]) ||
        row["prefix_digest"] !== params[6] || String(row["charged_logical_bytes"]) !== String(params[13])) return [];
    row["generation"] = String(params[4]); row["generation_carry_digest"] = params[5];
    row["carry_parent_digest"] = params[6]; row["carry_source_accumulator"] = params[7];
    row["carried_from_generation"] = String(params[8]); row["carry_from_block"] = params[9];
    row["carry_to_block"] = params[10]; row["carry_to_block_hash"] = params[11];
    row["prefix_digest"] = params[5]; row["updated_at"] = params[12];
    return [{ journal_owner: row["journal_owner"] }];
  }

  #lpCoverageRewindRequirementsUnavailable(params: readonly unknown[]): Row[] {
    const ancestor = params[2] === null ? null : BigInt(String(params[2]));
    const changed: Row[] = [];
    for (const row of this.#lpEvidenceRequirements.values()) {
      if (row["lane_id"] !== params[0] || row["state"] !== "eligible" ||
          row["unavailable_code"] !== null ||
          String(row["coverage_generation"]) !== String(params[1]) ||
          (ancestor !== null && BigInt(String(row["begun_at_block"])) <= ancestor)) continue;
      row["state"] = "unavailable";
      row["unavailable_code"] = "coverage-generation-reorg";
      row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
      row["updated_at"] = params[3];
      changed.push({ journal_owner: row["journal_owner"] });
    }
    return changed;
  }

  #lpCoverageRewindRequirementsCarry(params: readonly unknown[]): Row[] {
    const changed: Row[] = [];
    for (const row of this.#lpEvidenceRequirements.values()) {
      if (row["lane_id"] !== params[0] || row["state"] !== "eligible" ||
          row["unavailable_code"] !== null ||
          String(row["coverage_generation"]) !== String(params[1])) continue;
      row["coverage_generation"] = String(params[2]);
      row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
      row["updated_at"] = params[3];
      changed.push({ journal_owner: row["journal_owner"] });
    }
    return changed;
  }

  #lpCoverageRewindBlocksCarry(params: readonly unknown[]): Row[] {
    const lane = String(params[0]); const oldGeneration = String(params[1]);
    const newGeneration = String(params[2]); const ancestor = BigInt(String(params[3]));
    const inserted: Row[] = [];
    for (const row of [...this.#lpCoverageBlocks.values()]) {
      if (row["lane_id"] !== lane || row["generation"] !== oldGeneration ||
          BigInt(String(row["block_number"])) > ancestor) continue;
      const key = [row["lane_id"], newGeneration, row["source_id"],
        row["block_number"]].join("\u0000");
      if (this.#lpCoverageBlocks.has(key)) continue;
      const copy = structuredClone(row); copy["generation"] = newGeneration;
      this.#lpCoverageBlocks.set(key, copy); inserted.push({ logical_bytes: copy["logical_bytes"] });
    }
    return inserted;
  }

  #lpCoverageRewindCandidatesCarry(params: readonly unknown[]): Row[] {
    const lane = String(params[0]); const oldGeneration = String(params[1]);
    const newGeneration = String(params[2]); const ancestor = BigInt(String(params[3]));
    const inserted: Row[] = [];
    for (const row of [...this.#lpCoverageCandidates.values()]) {
      if (row["lane_id"] !== lane || row["generation"] !== oldGeneration ||
          BigInt(String(row["block_number"])) > ancestor) continue;
      const key = [row["lane_id"], newGeneration, row["source_id"],
        row["transaction_hash"], row["intent_index"], row["log_index"]].join("\u0000");
      if (this.#lpCoverageCandidates.has(key)) continue;
      const copy = structuredClone(row); copy["generation"] = newGeneration;
      this.#lpCoverageCandidates.set(key, copy);
      inserted.push({ logical_bytes: copy["logical_bytes"] });
    }
    return inserted;
  }

  #lpCoverageCursorRewind(params: readonly unknown[]): Row[] {
    const row = this.#lpCoverageCursors.get(String(params[0]));
    if (row === undefined || BigInt(String(row["generation"])) !== BigInt(String(params[4])) ||
        BigInt(String(row["row_version"])) !== BigInt(String(params[5]))) return [];
    row["generation"] = (BigInt(String(row["generation"])) + 1n).toString(10);
    row["state"] = params[1]; row["covered_through"] = params[2];
    row["covered_through_hash"] = params[3]; row["covered_through_timestamp"] = params[6];
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    return [structuredClone(row)];
  }

  #lpCoverageCandidateMatch(params: readonly unknown[]): Row[] {
    const found = new Map<string, Row>();
    for (const row of this.#lpCoverageCandidates.values()) {
      const number = BigInt(String(row["block_number"]));
      if (row["lane_id"] === params[0] && row["generation"] === String(params[1]) &&
          number >= BigInt(String(params[2])) && number <= BigInt(String(params[3])) &&
          row["eoa"] === params[4] && String(row["nonce"]) === String(params[5]) &&
          row["execution_data_hash"] === params[6] && row["key_hash"] === params[7]) {
        found.set(String(row["candidate_digest"]), row);
      }
    }
    return [...found.values()].map((row) => structuredClone(row));
  }

  #lpCoverageValidateBlock(params: readonly unknown[]): Row[] {
    const sources = new Set<string>();
    for (const row of this.#lpCoverageBlocks.values()) {
      if (row["lane_id"] === params[0] && row["generation"] === String(params[1]) &&
          row["block_number"] === String(params[2]) && row["block_hash"] === params[3]) {
        sources.add(String(row["source_id"]));
      }
    }
    return [{ source_count: sources.size }];
  }

  #lpCoverageValidateCandidate(params: readonly unknown[]): Row[] {
    const sources = new Set<string>();
    for (const row of this.#lpCoverageCandidates.values()) {
      if (row["lane_id"] === params[0] && row["generation"] === String(params[1]) &&
          row["transaction_hash"] === params[2] && row["input_hash"] === params[3] &&
          row["block_number"] === String(params[4]) && row["block_hash"] === params[5] &&
          row["transaction_index"] === String(params[6]) &&
          Number(row["intent_index"]) === Number(params[7]) &&
          row["log_index"] === String(params[8]) && row["event_topics_hash"] === params[9] &&
          row["event_data_hash"] === params[10]) sources.add(String(row["source_id"]));
    }
    return [{ source_count: sources.size }];
  }

  #lpCoverageValidateRequirement(params: readonly unknown[]): Row[] {
    return [...this.#lpEvidenceRequirements.values()].filter((row) =>
      row["lane_id"] === params[0] && row["prepared_identity_hash"] === params[1] &&
      String(row["begun_at_block"]) === String(params[2]) &&
      row["coverage_version"] === params[3] && row["quorum_id"] === params[4] &&
      row["state"] === "eligible" && row["unavailable_code"] === null &&
      String(row["coverage_generation"]) === String(params[5]) &&
      String(row["row_version"]) === String(params[6]))
      .map((row) => ({ journal_owner: row["journal_owner"] }));
  }

  #lpCoverageQuotaUpdate(params: readonly unknown[]): Row[] {
    const row = this.#lpEvidenceQuotas.get(this.#lpEvidenceQuotaKey(params[0], params[1]));
    if (row === undefined) return [];
    row["logical_bytes"] = (BigInt(String(row["logical_bytes"])) + BigInt(String(params[2]))).toString(10);
    row["block_rows"] = Number(row["block_rows"]) + Number(params[3]);
    row["candidate_rows"] = Number(row["candidate_rows"]) + Number(params[4]);
    row["row_version"] = (BigInt(String(row["row_version"])) + 1n).toString(10);
    return [{ row_version: row["row_version"] }];
  }

  /* ----- agents ----- */

  #agentsCreate(params: readonly unknown[]): Row[] {
    const id = params[0] as string;
    if (this.#agents.has(id)) return []; // ON CONFLICT DO NOTHING
    const row: Row = {
      id,
      owner_address: params[1],
      wallet_address: params[2],
      custody_model: params[3],
      session_facts: jsonbParam(params[4]),
      session_revocation: null,
      caps: jsonbParam(params[5]),
      status: params[6],
      http_runtime_profile: params[7],
      erc8004_agent_id: params[8],
      pending_grant: null,
      row_version: 1,
      session_key_ciphertext: null,
      created_at: params[9],
      updated_at: params[9],
    };
    this.#agents.set(id, row);
    return [structuredClone(row)];
  }

  #agentsGet(params: readonly unknown[], columns?: readonly string[]): Row[] {
    const row = this.#agents.get(params[0] as string);
    if (row === undefined || row["owner_address"] !== params[1]) return [];
    return [project(row, columns)];
  }

  #agentsGetById(params: readonly unknown[]): Row[] {
    const row = this.#agents.get(params[0] as string);
    return row === undefined ? [] : [structuredClone(row)];
  }

  #agentsList(params: readonly unknown[]): Row[] {
    const owner = params[0];
    return [...this.#agents.values()]
      .filter((row) => row["owner_address"] === owner)
      .sort(byCreatedThenId)
      .map((row) => structuredClone(row));
  }

  #agentsUpdate(
    id: unknown,
    owner: unknown,
    mutate: (row: Row) => void,
    columns?: readonly string[],
  ): Row[] {
    const row = this.#agents.get(id as string);
    if (row === undefined || row["owner_address"] !== owner) return [];
    mutate(row);
    return [project(row, columns)];
  }

  /* ----- health ----- */

  #healthPut(params: readonly unknown[]): Row[] {
    this.#health.set(params[0] as string, {
      executor: params[0],
      last_ok_at: params[1],
      last_error_at: params[2],
      last_error: params[3],
      last_latency_ms: params[4],
      consecutive_failures: params[5],
    });
    return [];
  }

  #healthList(): Row[] {
    return [...this.#health.values()]
      .sort((a, b) => String(a["executor"]).localeCompare(String(b["executor"])))
      .map((row) => structuredClone(row));
  }

  /* ----- journal ----- */

  #journalBeginInsert(params: readonly unknown[]): Row[] {
    const key = params[0] as string;
    if (this.#journal.has(key)) return [];
    this.#journal.set(key, {
      idempotency_key: key,
      agent_id: params[1],
      owner_address: params[2],
      kind: params[3],
      decision_id: params[4],
      state: "PENDING",
      external_ref: jsonbParam(params[5]),
      // pg returns numeric as a string; the store parses it back to a bigint.
      native_spend_wei: params[6] === null ? null : String(params[6]),
      // pg returns int8 as a string as well. Null mirrors pre-migration/non-LP rows.
      begun_at_block: params[7] === null ? null : String(params[7]),
      final_calls_fingerprint: params[9],
      final_calls_fingerprint_hash: params[10],
      prepared_intent_identity: null,
      prepared_intent_identity_hash: null,
      prepared_binding_version: "0",
      billing_calls_id_version: "0",
      landing_resolution_id: null,
      landing_resolution_key_hash: null,
      landing_resolution_outcome: null,
      landing_resolution_evidence_hash: null,
      landing_resolution_terminal_at: null,
      last_error: null,
      created_at: params[8],
      updated_at: params[8],
    });
    // `returning idempotency_key`: only the caller whose insert took gets a row.
    return [{ idempotency_key: key }];
  }

  #journalGet(key: unknown): Row[] {
    const row = this.#journal.get(key as string);
    return row === undefined ? [] : [structuredClone(row)];
  }

  #journalGetByDecision(params: readonly unknown[]): Row[] {
    const matches = [...this.#journal.values()]
      .filter(
        (row) =>
          row["agent_id"] === params[0] &&
          row["decision_id"] === params[1] &&
          // `kind in ('execute','trade','lp','venusRepay','venusSupply',
          // 'venusClaim','venusClaimRepayLeg','billingCollect','lending',
          // 'quantTrade')`: one
          // decisionId namespace across every money route. Mirrors journal.ts's
          // SQL literal by hand — the journal.lp, journal.venus and
          // lending.journal tests pin the two against each other.
          (row["kind"] === "execute" ||
            row["kind"] === "trade" ||
            row["kind"] === "lp" ||
            row["kind"] === "venusRepay" ||
            row["kind"] === "venusSupply" ||
            row["kind"] === "venusClaim" ||
            row["kind"] === "venusClaimRepayLeg" ||
            row["kind"] === "billingCollect" ||
            row["kind"] === "lending" ||
            row["kind"] === "quantTrade"),
      )
      .sort((a, b) => asTime(a["created_at"]) - asTime(b["created_at"]));
    const row = matches[0];
    return row === undefined ? [] : [structuredClone(row)];
  }

  /** `sum(native_spend_wei)` over the spend-counting states. Returns text. */
  #journalSumNativeSpend(params: readonly unknown[]): Row[] {
    const counting = new Set(["PENDING", "IN_PROGRESS", "COMMITTED", "UNKNOWN"]);
    const since = asTime(params[1]);
    const exclude = params[2];
    let total = 0n;
    for (const row of this.#journal.values()) {
      if (row["agent_id"] !== params[0]) continue;
      if (asTime(row["created_at"]) < since) continue;
      if (exclude !== null && row["idempotency_key"] === exclude) continue;
      if (!counting.has(String(row["state"]))) continue;
      const raw = row["native_spend_wei"];
      total += raw === null || raw === undefined ? 0n : BigInt(String(raw));
    }
    return [{ total: total.toString(10) }];
  }

  /** `state = 'UNKNOWN'` for one agent, oldest first (PHASE4 R3.7). */
  #journalListUnknownForAgent(params: readonly unknown[]): Row[] {
    return [...this.#journal.values()]
      .filter(
        (row) => row["agent_id"] === params[0] && row["state"] === "UNKNOWN",
      )
      .sort((a, b) => asTime(a["created_at"]) - asTime(b["created_at"]))
      .map((row) => structuredClone(row));
  }

  #journalListNonTerminal(): Row[] {
    return [...this.#journal.values()]
      .filter((row) => row["state"] === "PENDING" || row["state"] === "IN_PROGRESS")
      .sort((a, b) => Number(a["created_at"]) - Number(b["created_at"]))
      .map((row) => structuredClone(row));
  }

  #journalTransitionUpdate(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(params[0] as string);
    if (row === undefined) return [];
    row["state"] = params[1];
    row["external_ref"] = jsonbParam(params[2]);
    row["last_error"] = params[3];
    row["updated_at"] = params[4];
    return [structuredClone(row)];
  }

  #journalBillingCollectionResolveUpdate(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    if (
      row === undefined ||
      row["kind"] !== "billingCollect" ||
      (row["state"] !== "IN_PROGRESS" && row["state"] !== "UNKNOWN")
    ) return [];
    row["state"] = params[1];
    row["external_ref"] = jsonbParam(params[2]);
    row["updated_at"] = params[3];
    return [structuredClone(row)];
  }

  /* ----- nonces ----- */

  #noncesConsume(params: readonly unknown[]): Row[] {
    // `|` cannot occur in either component (both are lowercase 0x-hex), so the
    // flattened key is injective — matching MemoryNonceStore's separator.
    const key = `${String(params[0])}|${String(params[1])}`;
    if (this.#nonces.has(key)) return []; // ON CONFLICT DO NOTHING
    this.#nonces.set(key, {
      owner_address: params[0],
      nonce: params[1],
      expires_at: params[2],
    });
    return [{ nonce: params[1] }];
  }

  #noncesProvisionRead(params: readonly unknown[]): Row[] {
    const row = this.#nonces.get(`${String(params[0])}|${String(params[1])}`);
    return row === undefined ? [] : [structuredClone(row)];
  }

  #noncesProvisionInsert(params: readonly unknown[]): Row[] {
    const key = `${String(params[0])}|${String(params[1])}`;
    if (this.#nonces.has(key)) return [];
    this.#nonces.set(key, {
      owner_address: params[0], nonce: params[1], expires_at: params[2],
      action_id: params[3], provision_state: params[4], accepted_at: params[5],
      authority_expires_at: params[2],
    });
    return [{ nonce: params[1] }];
  }

  #noncesProvisionTransition(params: readonly unknown[]): Row[] {
    const key = `${String(params[0])}|${String(params[1])}`;
    const row = this.#nonces.get(key);
    if (row === undefined || String(row["action_id"]).toLowerCase() !== String(params[3]).toLowerCase()
      || row["provision_state"] !== params[4]) return [];
    row["provision_state"] = params[2];
    return [{ nonce: params[1] }];
  }

  #noncesPrune(params: readonly unknown[]): Row[] {
    const before = asTime(params[0]);
    const removed: Row[] = [];
    for (const [key, row] of this.#nonces) {
      if (asTime(row["expires_at"]) < before) {
        this.#nonces.delete(key);
        removed.push({ nonce: row["nonce"] });
      }
    }
    return removed;
  }

  /* ----- kill switch ----- */

  #killPause(params: readonly unknown[]): Row[] {
    this.#pauses.set(params[0] as string, {
      agent_id: params[0],
      owner_address: params[1],
      paused_at: params[2],
    });
    return [];
  }

  #killUnpause(params: readonly unknown[]): Row[] {
    const row = this.#pauses.get(params[0] as string);
    if (row !== undefined && row["owner_address"] === params[1]) {
      this.#pauses.delete(params[0] as string);
    }
    return [];
  }

  #killIsPaused(params: readonly unknown[]): Row[] {
    const row = this.#pauses.get(params[0] as string);
    if (row === undefined || row["owner_address"] !== params[1]) return [];
    return [{ owner_address: row["owner_address"] }];
  }

  #killHalt(params: readonly unknown[]): Row[] {
    this.#halt.set("global", {
      id: "global",
      halted_at: params[0],
      reason: params[1],
    });
    return [];
  }

  #killResume(): Row[] {
    this.#halt.delete("global");
    return [];
  }

  #killIsHalted(): Row[] {
    const row = this.#halt.get("global");
    return row === undefined ? [] : [{ id: "global" }];
  }

  /* ----- LP positions ----- */

  /**
   * The partial unique index `lp_positions_one_live_token_idx` (PHASE3.4 M5):
   * at most one row with a given non-null `token_id` and `state <> 'closed'`.
   *
   * UNLIKE the sequences index, this one is NOT in the statement's `ON CONFLICT`
   * target — `on conflict (position_id) do nothing` is the one clause that
   * insert may carry — so a violation must arrive as a THROWN driver error
   * carrying the constraint name, exactly as node-postgres would deliver it.
   * The store maps that to `LpTokenIdInUseError`; mirroring it as an empty
   * RETURNING here would test a path production does not have.
   */
  #assertLiveTokenFree(tokenId: unknown, positionId: string): void {
    if (tokenId === null || tokenId === undefined) return;
    for (const row of this.#lpPositions.values()) {
      if (
        row["token_id"] === tokenId &&
        row["state"] !== "closed" &&
        row["position_id"] !== positionId
      ) {
        const error = new Error(
          'duplicate key value violates unique constraint "lp_positions_one_live_token_idx"',
        ) as Error & { code?: string; constraint?: string };
        error.code = "23505";
        error.constraint = "lp_positions_one_live_token_idx";
        throw error;
      }
    }
  }

  #lpPositionsCreate(params: readonly unknown[]): Row[] {
    const positionId = params[0] as string;
    if (this.#lpPositions.has(positionId)) return []; // ON CONFLICT DO NOTHING
    this.#assertLiveTokenFree(params[6], positionId);
    const row: Row = {
      position_id: positionId,
      agent_id: params[1],
      owner_address: params[2],
      token0: params[3],
      token1: params[4],
      fee: params[5],
      token_id: params[6],
      lineage_id: params[7],
      // pg returns numeric as a string; the store parses it back to a bigint.
      basis_wei: String(params[8]),
      basis_source: params[9],
      quote_token: params[10],
      state: "open",
      // PHASE3.4 M6: written explicitly, matching the insert's own literals.
      ownership_mismatch_count: 0,
      ownership_lost_reason: null,
      ownership_first_seen_at: null,
      // PHASE3.17 R2.3: mirrored from the real insert's $12. The A6 warning at
      // the top of this file is why this is written out rather than assumed —
      // the real statement moved its timestamp from $12 to $13 to make room,
      // and a fake that kept reading $12 for `created_at` would have silently
      // stamped every row with a uuid.
      arm_group_id: params[11] ?? null,
      arm_meta: jsonbParam(params[12] ?? null),
      // PHASE3.18 R2.6: mirrored from the real insert's $13/$14, and the
      // timestamp moved on again to $17 — the same A6 hazard the comment above
      // records, one phase later.
      grid_level: params[13] ?? null,
      grid_role: params[14] ?? null,
      // PHASE3.19 C4/C11: mirrored from the real insert's $15, which carries
      // BOTH book columns (an anchor starts at "0", a non-anchor at null), and
      // the timestamp moved on again to $17 — the SAME A6 hazard the two
      // comments above record, one phase later. NULL and "0" are different
      // states here: null means "not the ladder's book anchor".
      inventory_base_wei: params[15] ?? null,
      inventory_cost_wbnb_wei: params[15] ?? null,
      row_version: "0",
      created_at: params[16],
      updated_at: params[16],
    };
    this.#lpPositions.set(positionId, row);
    return [structuredClone(row)];
  }

  /** Scoped by (position_id, agent_id, owner_address) — all three must match. */
  #lpPositionsGet(params: readonly unknown[]): Row[] {
    const row = this.#lpPositions.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2]
    ) {
      return [];
    }
    return [structuredClone(row)];
  }

  #lpPositionsList(params: readonly unknown[]): Row[] {
    return [...this.#lpPositions.values()]
      .filter(
        (row) =>
          row["owner_address"] === params[0] && row["agent_id"] === params[1],
      )
      .sort(
        (a, b) =>
          asTime(a["created_at"]) - asTime(b["created_at"]) ||
          String(a["position_id"]).localeCompare(String(b["position_id"])),
      )
      .map((row) => structuredClone(row));
  }

  /** Owner-AND-agent scoped, non-closed, by tokenId (PHASE3.4 M5). */
  #lpPositionsByTokenId(params: readonly unknown[]): Row[] {
    for (const row of this.#lpPositions.values()) {
      if (
        row["owner_address"] === params[0] &&
        row["agent_id"] === params[1] &&
        row["token_id"] === params[2] &&
        row["state"] !== "closed"
      ) {
        return [structuredClone(row)];
      }
    }
    return [];
  }

  /** Global (worker-only) scan: `state = 'open'`, no owner scope. */
  #lpPositionsListOpenWorker(): Row[] {
    return [...this.#lpPositions.values()]
      .filter((row) => row["state"] === "open" &&
        ![...this.#lpSequences.values()].some((sequence) =>
          sequence["position_id"] === row["position_id"] &&
          sequence["agent_id"] === row["agent_id"] &&
          sequence["owner_address"] === row["owner_address"] &&
          (sequence["state"] === "resolving" || sequence["state"] === "retiring-pre-bind"),
        ))
      .sort(
        (a, b) =>
          asTime(a["created_at"]) - asTime(b["created_at"]) ||
          String(a["position_id"]).localeCompare(String(b["position_id"])),
      )
      .map((row) => structuredClone(row));
  }

  #lpPositionsUpdate(
    params: readonly unknown[],
    mutate: (row: Row) => void,
  ): Row[] {
    const row = this.#lpPositions.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] ||
      BigInt(String(row["row_version"] ?? 0)) !== BigInt(String(params[3]))
    ) {
      return [];
    }
    row["row_version"] = (BigInt(String(row["row_version"] ?? 0)) + 1n).toString(10);
    mutate(row);
    return [structuredClone(row)];
  }

  /**
   * PHASE3.18 R2.6 (M7). Its OWN handler rather than `#lpPositionsUpdate`,
   * because the real statement carries NO `row_version` predicate — the
   * backfill is idempotent and must not lose a race with an ordinary mutation
   * — so `params[3]` is the level, not a version. Reusing the shared helper
   * would have compared a level against a row version and silently returned no
   * rows: exactly the A6 divergence the warning at the top of this file is
   * about.
   */
  /**
   * PHASE3.19 R4.1/D4 — the anchor's IN-SQL increment, mirrored by hand.
   *
   * The predicate is `position_id AND agent_id AND owner_address AND
   * inventory_base_wei is not null`, and the last conjunct is the one a reader
   * would drop: a non-anchor row must match NOTHING, so the store's own
   * `LpInventoryAnchorMissingError` fires off the empty result rather than a
   * second book being opened for one pooled buffer.
   */
  #lpPositionsApplyInventoryCredit(params: readonly unknown[]): Row[] {
    const row = this.#lpPositions.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] ||
      row["inventory_base_wei"] === null ||
      row["inventory_base_wei"] === undefined
    ) {
      return [];
    }
    row["inventory_base_wei"] = (
      BigInt(String(row["inventory_base_wei"])) + BigInt(String(params[3]))
    ).toString(10);
    row["inventory_cost_wbnb_wei"] = (
      BigInt(String(row["inventory_cost_wbnb_wei"] ?? "0")) + BigInt(String(params[4]))
    ).toString(10);
    row["row_version"] = (BigInt(String(row["row_version"] ?? 0)) + 1n).toString(10);
    row["updated_at"] = params[5];
    return [structuredClone(row)];
  }

  /** PHASE3.19 D3 — owner- AND agent-scoped, exactly as the real select is. */
  #lpInventoryCreditsGet(params: readonly unknown[]): Row[] {
    const row = this.#lpInventoryCredits.get(params[0] as string);
    if (
      row === undefined ||
      row["owner_address"] !== params[1] ||
      row["agent_id"] !== params[2]
    ) {
      return [];
    }
    return [structuredClone(row)];
  }

  /** `insert … on conflict (application_key) do nothing` — the SET guard (N16). */
  #lpInventoryCreditsInsert(params: readonly unknown[]): Row[] {
    const key = params[0] as string;
    if (this.#lpInventoryCredits.has(key)) return [];
    this.#lpInventoryCredits.set(key, {
      application_key: key,
      owner_address: params[1],
      agent_id: params[2],
      position_id: params[3],
      arm_group_id: params[4] ?? null,
      delta_base_wei: params[5],
      delta_cost_wbnb_wei: params[6],
      created_at: params[7],
    });
    return [{ application_key: key }];
  }

  #lpInventoryCreditsList(params: readonly unknown[]): Row[] {
    return [...this.#lpInventoryCredits.values()]
      .filter(
        (row) =>
          row["owner_address"] === params[0] &&
          row["agent_id"] === params[1] &&
          row["position_id"] === params[2],
      )
      .map((row) => structuredClone(row));
  }

  #lpPositionsSetGridIdentity(params: readonly unknown[]): Row[] {
    const row = this.#lpPositions.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2]
    ) {
      return [];
    }
    row["row_version"] = (BigInt(String(row["row_version"] ?? 0)) + 1n).toString(10);
    row["grid_level"] = params[3];
    row["grid_role"] = params[4];
    row["updated_at"] = params[5];
    return [structuredClone(row)];
  }

  /* ----- LP sequences ----- */

  #lpSequencesCreate(params: readonly unknown[]): Row[] {
    // The partial unique index `lp_sequences_one_nonterminal_idx`: at most one
    // row per position with state 'active', an owner-route `abandoning` lease,
    // `resolving`, OR ('held' with a recovery owed).
    // A conflicting insert is a DO NOTHING no-op, so the store's typed error
    // fires off the empty RETURNING — mirrored here by hand.
    for (const row of this.#lpSequences.values()) {
      if (row["position_id"] !== params[3]) continue;
      const state = row["state"];
      const nonTerminal =
        state === "active" ||
        state === "abandoning" ||
        state === "resolving" ||
        state === "retiring-pre-bind" ||
        (state === "held" && row["recovery_state"] !== "none");
      if (nonTerminal) return [];
    }
    const sequenceId = params[0] as string;
    if (this.#lpSequences.has(sequenceId)) return [];
    const row: Row = {
      sequence_id: sequenceId,
      agent_id: params[1],
      owner_address: params[2],
      position_id: params[3],
      kind: params[4],
      state: "active",
      recovery_state: "none",
      steps: jsonbParam(params[5]),
      // PHASE3.1 Rev2 item 15: the nullable note column, inserted explicitly
      // as null exactly as the store's own values list does.
      note: null,
      // PHASE3.24 C2/C3: APPEND-ONLY $14 mirror; residue starts nullable.
      inline_convert: params[13] === true,
      inline_residue_base_wei: null,
      // PHASE3.11 F1's stall latch, defaulted exactly as the DDL does.
      stall_code: null,
      stall_count: 0,
      abandon_claim_id: null,
      abandon_claimed_at: null,
      abandon_disposition_started_at: null,
      resolver_prior_state: null,
      resolver_prior_recovery_state: null,
      resolver_fence: "0",
      resolver_lease_until: null,
      resolver_snapshot_hash: null,
      resolver_row_version: "0",
      resolution_id: null,
      resolver_action_idempotency_key: null,
      resolution_disposition_started: false,
      retirement_prior_state: null,
      retirement_prior_recovery_state: null,
      retirement_target_journal_key: null,
      retirement_action_idempotency_key: null,
      retirement_fence: "0",
      retirement_lease_until: null,
      retirement_snapshot_hash: null,
      retirement_row_version: "0",
      retirement_disposition_started: false,
      // PHASE3.18 R2.3/C4: mirrored from the real insert's $7/$8; the timestamp
      // moved from $7 to $9 to make room, and a fake that kept reading $6 for
      // `created_at` would stamp every row with a tick number — the same A6
      // hazard the 3.17 position insert records above.
      target_tick_lower: params[6] ?? null,
      target_tick_upper: params[7] ?? null,
      // PHASE3.22 R8 / R2.19: mirrored from the real insert's $11/$12.
      //
      // The two columns were APPENDED at the tail of the insert's column list
      // rather than inserted beside `target_tick_upper`, so — unlike 3.18's
      // widening, whose comment above records the timestamp moving from $6 to
      // $9 — NO existing index moved here. `created_at` is still $9 and
      // `recenter_evidence` still $10. That is the point of appending: this
      // file is the PHASE3.7-AUDIT A6 hazard R2.19 names by name, and the
      // cheapest way not to hit it is to leave every existing index alone.
      target_sell_tick_lower: params[10] ?? null,
      target_sell_tick_upper: params[11] ?? null,
      // PHASE3.23 REVIEW2 N2: APPEND-ONLY mirror of the real INSERT's $13.
      shift_cause: params[12] ?? null,
      // PHASE3.19 item 8: the hedge intent is NOT in the insert's column list —
      // the store writes it later, once, from the hedge step's build — so it
      // defaults to null exactly as the DDL's additive nullable columns do.
      hedge_direction: null,
      hedge_amount_in_wei: null,
      // PHASE3.20 item 7: mirrored from the real insert's $10. Written by the
      // INSERT itself — unlike the hedge intent, which the store writes later —
      // because the reservation taken a few lines after the create must be able
      // to read the lane off the row.
      recenter_evidence: params[9] ?? null,
      created_at: params[8],
      updated_at: params[8],
    };
    this.#lpSequences.set(sequenceId, row);
    return [structuredClone(row)];
  }

  #lpSequencesGet(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2]
    ) {
      return [];
    }
    return [structuredClone(row)];
  }

  #lpSequencesNonTerminalByPosition(params: readonly unknown[]): Row[] {
    for (const row of this.#lpSequences.values()) {
      if (
        row["position_id"] !== params[0] ||
        row["agent_id"] !== params[1] ||
        row["owner_address"] !== params[2]
      ) {
        continue;
      }
      const state = row["state"];
      const nonTerminal =
        state === "active" ||
        state === "abandoning" ||
        state === "resolving" ||
        state === "retiring-pre-bind" ||
        (state === "held" && row["recovery_state"] !== "none");
      if (nonTerminal) return [structuredClone(row)];
    }
    return [];
  }

  /** The same predicate, agent-scoped (PHASE3.4 audit A5). */
  #lpSequencesAnyNonTerminalByAgent(params: readonly unknown[]): Row[] {
    for (const row of this.#lpSequences.values()) {
      if (row["agent_id"] !== params[0] || row["owner_address"] !== params[1]) {
        continue;
      }
      const state = row["state"];
      const nonTerminal =
        state === "active" ||
        state === "abandoning" ||
        state === "resolving" ||
        state === "retiring-pre-bind" ||
        (state === "held" && row["recovery_state"] !== "none");
      if (nonTerminal) return [structuredClone(row)];
    }
    return [];
  }

  #lpSequencesList(params: readonly unknown[]): Row[] {
    return [...this.#lpSequences.values()]
      .filter(
        (row) =>
          row["owner_address"] === params[0] && row["agent_id"] === params[1],
      )
      .sort(
        (a, b) =>
          asTime(a["created_at"]) - asTime(b["created_at"]) ||
          String(a["sequence_id"]).localeCompare(String(b["sequence_id"])),
      )
      .map((row) => structuredClone(row));
  }

  /** Global (worker-only) scan of the non-terminal predicate, no owner scope. */
  #lpSequencesListNonTerminalWorker(): Row[] {
    return [...this.#lpSequences.values()]
      .filter((row) => {
        const state = row["state"];
        return (
          state === "active" ||
          (state === "held" && row["recovery_state"] !== "none")
        );
      })
      .sort(
        (a, b) =>
          asTime(a["created_at"]) - asTime(b["created_at"]) ||
          String(a["sequence_id"]).localeCompare(String(b["sequence_id"])),
      )
      .map((row) => structuredClone(row));
  }

  #lpSequencesUpdate(
    params: readonly unknown[],
    mutate: (row: Row) => void,
  ): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2]
    ) {
      return [];
    }
    mutate(row);
    return [structuredClone(row)];
  }

  /**
   * PHASE3.19 item 8 — the WRITE-ONCE hedge intent, with its null predicate.
   *
   * Not the shared helper: the real statement's `and hedge_direction is null
   * and hedge_amount_in_wei is null` conjunct is the whole guard, and a fake
   * that dropped it would let a mutation pass here while failing on Postgres —
   * the A6 divergence the warning at the top of this file is about.
   */
  #lpSequencesSetHedgeIntent(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] ||
      (row["hedge_direction"] !== null && row["hedge_direction"] !== undefined) ||
      (row["hedge_amount_in_wei"] !== null && row["hedge_amount_in_wei"] !== undefined)
    ) {
      return [];
    }
    row["hedge_direction"] = params[3];
    row["hedge_amount_in_wei"] = params[4];
    row["updated_at"] = params[5];
    return [structuredClone(row)];
  }

  #lpSequencesResolvingByPosition(params: readonly unknown[]): Row[] {
    for (const row of this.#lpSequences.values()) {
      if (row["position_id"] === params[0] && row["agent_id"] === params[1] &&
          row["owner_address"] === params[2] &&
          (row["state"] === "resolving" || row["state"] === "retiring-pre-bind")) {
        return [{ sequence_id: row["sequence_id"] }];
      }
    }
    return [];
  }

  #journalBindPreparedUpdate(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(params[0] as string);
    if (row === undefined || row["kind"] !== "lp" ||
        row["prepared_intent_identity"] !== null ||
        row["prepared_intent_identity_hash"] !== null ||
        BigInt(String(row["prepared_binding_version"])) !== BigInt(String(params[3]))) {
      return [];
    }
    row["prepared_intent_identity"] = params[1];
    row["prepared_intent_identity_hash"] = params[2];
    row["prepared_binding_version"] = (
      BigInt(String(row["prepared_binding_version"])) + 1n
    ).toString(10);
    row["updated_at"] = params[4];
    return [structuredClone(row)];
  }

  #journalBillingCallsIdUpdate(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    if (
      row === undefined ||
      BigInt(String(row["billing_calls_id_version"] ?? 0)) !== BigInt(String(params[2])) ||
      !["PENDING", "IN_PROGRESS", "UNKNOWN"].includes(String(row["state"]))
    ) return [];
    row["external_ref"] = jsonbParam(params[1]);
    row["billing_calls_id_version"] = "1";
    row["updated_at"] = params[3];
    return [structuredClone(row)];
  }

  #journalLandingReserve(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    if (row === undefined || row["state"] !== "UNKNOWN" ||
        row["landing_resolution_id"] !== null || row["landing_resolution_key_hash"] !== null ||
        row["landing_resolution_outcome"] !== null ||
        row["landing_resolution_evidence_hash"] !== null ||
        row["landing_resolution_terminal_at"] !== null) return [];
    row["state"] = params[1]; row["external_ref"] = jsonbParam(params[2]);
    row["landing_resolution_id"] = params[3]; row["landing_resolution_key_hash"] = params[4];
    row["updated_at"] = params[5];
    return [structuredClone(row)];
  }

  #journalLandingActionJoin(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    if (row === undefined || row["kind"] !== "resolveUnknownLandingV1" ||
        (row["state"] !== "PENDING" && row["state"] !== "IN_PROGRESS") ||
        row["landing_resolution_id"] !== null || row["landing_resolution_key_hash"] !== null ||
        row["landing_resolution_outcome"] !== null ||
        row["landing_resolution_evidence_hash"] !== null ||
        row["landing_resolution_terminal_at"] !== null) return [];
    row["state"] = "IN_PROGRESS"; row["external_ref"] = jsonbParam(params[1]);
    row["landing_resolution_id"] = params[2]; row["landing_resolution_key_hash"] = params[3];
    row["updated_at"] = params[4];
    return [structuredClone(row)];
  }

  #journalLandingFinalize(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    if (row === undefined || row["landing_resolution_id"] !== params[1] ||
        row["landing_resolution_key_hash"] !== params[2] ||
        row["landing_resolution_outcome"] !== null ||
        row["landing_resolution_evidence_hash"] !== null ||
        row["landing_resolution_terminal_at"] !== null) return [];
    row["landing_resolution_outcome"] = params[3];
    row["landing_resolution_evidence_hash"] = params[4];
    row["landing_resolution_terminal_at"] = params[5]; row["updated_at"] = params[6];
    return [structuredClone(row)];
  }

  #journalLandingActionComplete(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    if (row === undefined || row["kind"] !== "resolveUnknownLandingV1") return [];
    row["state"] = "COMMITTED"; row["external_ref"] = jsonbParam(params[1]);
    row["updated_at"] = params[2];
    row["landing_resolution_id"] = params[3];
    row["landing_resolution_key_hash"] = params[4];
    return [structuredClone(row)];
  }

  #journalPreBindRetirement(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    if (row === undefined || row["state"] !== "UNKNOWN") return [];
    row["state"] = "ROLLED_BACK";
    row["external_ref"] = jsonbParam(params[1]);
    row["updated_at"] = params[2];
    return [structuredClone(row)];
  }

  #journalPreBindRetirementActionComplete(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    if (row === undefined || row["kind"] !== "retireLpPreBindV1" ||
        (row["state"] !== "PENDING" && row["state"] !== "IN_PROGRESS")) return [];
    row["state"] = "COMMITTED";
    row["external_ref"] = jsonbParam(params[1]);
    row["updated_at"] = params[2];
    return [structuredClone(row)];
  }

  /* ----- atomic proved-pre-bind retirement finalizer ----- */

  #preBindFinalizePositionLock(params: readonly unknown[]): Row[] {
    const row = this.#lpPositions.get(String(params[0]));
    return row === undefined || row["agent_id"] !== params[1] || !sameOwner(row["owner_address"], params[2]) ||
      row["state"] !== "open" || row["token_id"] !== null ||
      BigInt(String(row["row_version"] ?? 0)) !== BigInt(String(params[3]))
      ? [] : [{ position_id: row["position_id"] }];
  }

  #preBindFinalizeSequenceLock(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(String(params[0]));
    return row === undefined || row["agent_id"] !== params[1] || !sameOwner(row["owner_address"], params[2]) ||
      row["position_id"] !== params[3] || row["state"] !== "retiring-pre-bind" ||
      row["retirement_target_journal_key"] !== params[4] ||
      row["retirement_action_idempotency_key"] !== params[5] ||
      BigInt(String(row["retirement_fence"] ?? 0)) !== BigInt(String(params[6])) ||
      BigInt(String(row["retirement_row_version"] ?? 0)) !== BigInt(String(params[7])) ||
      row["retirement_disposition_started"] !== false
      ? [] : [{ sequence_id: row["sequence_id"] }];
  }

  #preBindFinalizeTargetLock(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    const ref = row?.["external_ref"] as Record<string, unknown> | null | undefined;
    return row === undefined || row["agent_id"] !== params[1] || !sameOwner(row["owner_address"], params[2]) ||
      row["kind"] !== "lp" || row["decision_id"] !== params[3] || row["state"] !== "UNKNOWN" ||
      row["prepared_intent_identity"] !== null || row["prepared_intent_identity_hash"] !== null ||
      BigInt(String(row["prepared_binding_version"] ?? 0)) !== 0n ||
      row["landing_resolution_id"] !== null || row["landing_resolution_key_hash"] !== null ||
      row["landing_resolution_outcome"] !== null || row["landing_resolution_evidence_hash"] !== null ||
      row["landing_resolution_terminal_at"] !== null || ref?.["callsId"] !== undefined ||
      ref?.["txHash"] !== undefined || ref?.["retirementEvidence"] !== undefined
      ? [] : [{ idempotency_key: row["idempotency_key"] }];
  }

  #preBindFinalizeActionLock(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    const ref = row?.["external_ref"] as { retirementAction?: Record<string, unknown>;
      retirementResult?: unknown } | null | undefined;
    const action = ref?.retirementAction;
    return row === undefined || row["agent_id"] !== params[1] || !sameOwner(row["owner_address"], params[2]) ||
      row["kind"] !== "retireLpPreBindV1" || row["state"] !== "PENDING" ||
      action?.["scheme"] !== "retire-lp-pre-bind-action-v1" ||
      action?.["targetJournalKey"] !== params[3] || action?.["decisionId"] !== params[4] ||
      action?.["state"] !== "PENDING" || ref?.retirementResult !== undefined
      ? [] : [{ idempotency_key: row["idempotency_key"] }];
  }

  #preBindFinalizeBegin(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(String(params[0]));
    if (row === undefined || row["agent_id"] !== params[1] || !sameOwner(row["owner_address"], params[2]) ||
        row["position_id"] !== params[3] || row["state"] !== "retiring-pre-bind" ||
        row["retirement_target_journal_key"] !== params[4] ||
        row["retirement_action_idempotency_key"] !== params[5] ||
        BigInt(String(row["retirement_fence"] ?? 0)) !== BigInt(String(params[6])) ||
        BigInt(String(row["retirement_row_version"] ?? 0)) !== BigInt(String(params[7])) ||
        row["retirement_disposition_started"] !== false) return [];
    row["retirement_disposition_started"] = true;
    row["retirement_row_version"] = (BigInt(String(row["retirement_row_version"] ?? 0)) + 1n).toString(10);
    row["updated_at"] = params[8];
    return [{ sequence_id: row["sequence_id"] }];
  }

  #preBindFinalizePosition(params: readonly unknown[]): Row[] {
    const row = this.#lpPositions.get(String(params[0]));
    if (row === undefined || row["agent_id"] !== params[1] || !sameOwner(row["owner_address"], params[2]) ||
        BigInt(String(row["row_version"] ?? 0)) !== BigInt(String(params[3])) ||
        row["state"] !== "open" || row["token_id"] !== null) return [];
    row["state"] = "closed"; row["basis_wei"] = "0";
    row["row_version"] = (BigInt(String(row["row_version"] ?? 0)) + 1n).toString(10);
    row["updated_at"] = params[4];
    return [{ position_id: row["position_id"] }];
  }

  #preBindFinalizeTarget(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    const ref = row?.["external_ref"] as Record<string, unknown> | null | undefined;
    if (row === undefined || row["agent_id"] !== params[1] || !sameOwner(row["owner_address"], params[2]) ||
        row["kind"] !== "lp" || row["decision_id"] !== params[3] || row["state"] !== "UNKNOWN" ||
        row["prepared_intent_identity"] !== null || row["prepared_intent_identity_hash"] !== null ||
        BigInt(String(row["prepared_binding_version"] ?? 0)) !== 0n ||
        row["landing_resolution_id"] !== null || row["landing_resolution_key_hash"] !== null ||
        row["landing_resolution_outcome"] !== null || row["landing_resolution_evidence_hash"] !== null ||
        row["landing_resolution_terminal_at"] !== null || ref?.["callsId"] !== undefined ||
        ref?.["txHash"] !== undefined || ref?.["retirementEvidence"] !== undefined) return [];
    row["state"] = "ROLLED_BACK";
    row["external_ref"] = reorderJsonb({ ...(ref ?? {}), retirementEvidence: {
      scheme: "retired-pre-bind-v1",
    } });
    row["updated_at"] = params[4];
    return [{ idempotency_key: row["idempotency_key"] }];
  }

  #preBindFinalizeReservation(params: readonly unknown[]): Row[] {
    const row = this.#lpReservations.get(String(params[0]));
    if (row !== undefined && row["agent_id"] === params[1] && sameOwner(row["owner_address"], params[2]) &&
        row["released_at"] === null) row["released_at"] = params[3];
    return [];
  }

  #preBindFinalizeAction(params: readonly unknown[]): Row[] {
    const row = this.#journal.get(String(params[0]));
    const ref = row?.["external_ref"] as { retirementAction?: Record<string, unknown>;
      retirementResult?: unknown } | null | undefined;
    const action = ref?.retirementAction;
    if (row === undefined || row["agent_id"] !== params[1] || !sameOwner(row["owner_address"], params[2]) ||
        row["kind"] !== "retireLpPreBindV1" || row["state"] !== "PENDING" ||
        action?.["scheme"] !== "retire-lp-pre-bind-action-v1" ||
        action?.["targetJournalKey"] !== params[3] || action?.["decisionId"] !== params[4] ||
        action?.["state"] !== "PENDING" || ref?.retirementResult !== undefined) return [];
    row["state"] = "COMMITTED";
    row["external_ref"] = reorderJsonb({ ...(ref ?? {}), retirementAction: {
      scheme: "retire-lp-pre-bind-action-v1", targetJournalKey: params[3],
      decisionId: params[4], state: "TERMINAL",
    }, retirementResult: {
      scheme: "retire-lp-pre-bind-result-v1", decisionId: params[4], targetJournalKey: params[3],
      sequenceId: params[5], positionId: params[6], targetJournalState: "ROLLED_BACK",
      sequenceState: "rolled-back", positionState: "closed", evidenceCode: "retired-pre-bind-v1",
    } });
    row["updated_at"] = params[7];
    return [{ idempotency_key: row["idempotency_key"] }];
  }

  #preBindFinalizeSequence(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(String(params[0]));
    if (row === undefined || row["agent_id"] !== params[1] || !sameOwner(row["owner_address"], params[2]) ||
        row["position_id"] !== params[3] || row["state"] !== "retiring-pre-bind" ||
        row["retirement_target_journal_key"] !== params[4] ||
        row["retirement_action_idempotency_key"] !== params[5] ||
        BigInt(String(row["retirement_fence"] ?? 0)) !== BigInt(String(params[6])) ||
        BigInt(String(row["retirement_row_version"] ?? 0)) !== BigInt(String(params[7])) ||
        row["retirement_disposition_started"] !== true) return [];
    row["state"] = "rolled-back";
    row["retirement_prior_state"] = null; row["retirement_prior_recovery_state"] = null;
    row["retirement_target_journal_key"] = null; row["retirement_action_idempotency_key"] = null;
    row["retirement_lease_until"] = null; row["retirement_snapshot_hash"] = null;
    row["retirement_disposition_started"] = false;
    row["retirement_row_version"] = (BigInt(String(row["retirement_row_version"] ?? 0)) + 1n).toString(10);
    row["updated_at"] = params[8];
    return [{ sequence_id: row["sequence_id"] }];
  }

  #lpSequencesClaimLandingResolution(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    const state = row?.["state"];
    const recovery = row?.["recovery_state"];
    if (
      row === undefined || row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] || state !== params[3] ||
      recovery !== params[4] || asTime(row["updated_at"]) !== asTime(params[5]) ||
      BigInt(String(row["resolver_row_version"] ?? 0)) !== BigInt(String(params[6])) ||
      row["position_id"] !== params[9] ||
      (state !== "active" && !(state === "held" && recovery !== "none")) ||
      row["resolution_id"] !== null || row["resolver_action_idempotency_key"] !== null
    ) {
      return [];
    }
    row["state"] = "resolving";
    row["resolver_prior_state"] = state;
    row["resolver_prior_recovery_state"] = recovery;
    row["resolver_fence"] = (BigInt(String(row["resolver_fence"] ?? 0)) + 1n).toString(10);
    row["resolver_lease_until"] = params[11];
    row["resolver_snapshot_hash"] = params[12];
    row["resolver_row_version"] = (BigInt(String(row["resolver_row_version"] ?? 0)) + 1n).toString(10);
    row["resolution_id"] = params[7];
    row["resolver_action_idempotency_key"] = params[8];
    row["resolution_disposition_started"] = false;
    row["updated_at"] = params[13];
    return [structuredClone(row)];
  }

  #lpSequencesReclaimLandingResolution(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    if (
      row === undefined || row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] || row["state"] !== "resolving" ||
      row["resolution_id"] !== params[3] ||
      BigInt(String(row["resolver_fence"] ?? 0)) !== BigInt(String(params[4])) ||
      BigInt(String(row["resolver_row_version"] ?? 0)) !== BigInt(String(params[5])) ||
      asTime(row["resolver_lease_until"]) > asTime(params[6]) ||
      row["resolver_snapshot_hash"] !== params[9]
    ) {
      return [];
    }
    row["resolver_fence"] = (BigInt(String(row["resolver_fence"] ?? 0)) + 1n).toString(10);
    row["resolver_lease_until"] = params[8];
    row["resolver_action_idempotency_key"] = params[7];
    row["resolver_row_version"] = (BigInt(String(row["resolver_row_version"] ?? 0)) + 1n).toString(10);
    row["updated_at"] = params[6];
    return [structuredClone(row)];
  }

  #lpResolverRow(params: readonly unknown[]): Row | undefined {
    const row = this.#lpSequences.get(params[0] as string);
    if (
      row === undefined || row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] || row["state"] !== "resolving" ||
      row["resolution_id"] !== params[3] ||
      BigInt(String(row["resolver_fence"] ?? 0)) !== BigInt(String(params[4])) ||
      BigInt(String(row["resolver_row_version"] ?? 0)) !== BigInt(String(params[5]))
    ) {
      return undefined;
    }
    return row;
  }

  #advanceResolverVersion(row: Row, updatedAt: unknown): void {
    row["resolver_row_version"] = (BigInt(String(row["resolver_row_version"] ?? 0)) + 1n).toString(10);
    row["updated_at"] = updatedAt;
  }

  #clearResolver(row: Row): void {
    row["resolver_prior_state"] = null;
    row["resolver_prior_recovery_state"] = null;
    row["resolver_lease_until"] = null;
    row["resolver_snapshot_hash"] = null;
    row["resolution_id"] = null;
    row["resolver_action_idempotency_key"] = null;
    row["resolution_disposition_started"] = false;
  }

  #lpSequencesBeginLandingDisposition(params: readonly unknown[]): Row[] {
    const row = this.#lpResolverRow(params);
    if (row === undefined) return [];
    row["resolution_disposition_started"] = true;
    this.#advanceResolverVersion(row, params[6]);
    return [structuredClone(row)];
  }

  #lpSequencesSetLandingRecovery(params: readonly unknown[]): Row[] {
    const row = this.#lpResolverRow(params);
    if (row === undefined || row["resolution_disposition_started"] !== true) return [];
    row["recovery_state"] = params[6];
    row["note"] = params[7];
    this.#advanceResolverVersion(row, params[8]);
    return [structuredClone(row)];
  }

  #lpSequencesLandingTouch(params: readonly unknown[]): Row[] {
    const row = this.#lpResolverRow(params);
    if (row === undefined || row["resolution_disposition_started"] !== true) return [];
    this.#advanceResolverVersion(row, params[6]);
    return [structuredClone(row)];
  }

  #lpSequencesReleaseLandingResolution(params: readonly unknown[]): Row[] {
    const row = this.#lpResolverRow(params);
    if (row === undefined || row["resolution_disposition_started"] !== false) return [];
    row["state"] = row["resolver_prior_state"];
    row["recovery_state"] = row["resolver_prior_recovery_state"];
    this.#clearResolver(row);
    this.#advanceResolverVersion(row, params[6]);
    return [structuredClone(row)];
  }

  #lpSequencesFinishLandingResolution(
    params: readonly unknown[],
    targetState: "active" | "rolled-back",
  ): Row[] {
    const row = this.#lpResolverRow(params);
    if (row === undefined || row["resolution_disposition_started"] !== true) return [];
    row["state"] = targetState;
    this.#clearResolver(row);
    this.#advanceResolverVersion(row, params[6]);
    return [structuredClone(row)];
  }

  #lpSequencesClaimPreBindRetirement(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    const state = row?.["state"];
    const recovery = row?.["recovery_state"];
    const position = this.#lpPositions.get(params[9] as string);
    if (row === undefined || position === undefined || row["agent_id"] !== params[1] ||
        row["owner_address"] !== params[2] || state !== params[3] || recovery !== params[4] ||
        asTime(row["updated_at"]) !== asTime(params[5]) ||
        BigInt(String(row["retirement_row_version"] ?? 0)) !== BigInt(String(params[6])) ||
        row["position_id"] !== params[9] ||
        BigInt(String(position["row_version"] ?? 0)) !== BigInt(String(params[10])) ||
        (state !== "active" && !(state === "held" && recovery !== "none")) ||
        row["retirement_target_journal_key"] !== null ||
        row["retirement_action_idempotency_key"] !== null) return [];
    row["state"] = "retiring-pre-bind";
    row["retirement_prior_state"] = state;
    row["retirement_prior_recovery_state"] = recovery;
    row["retirement_fence"] = (BigInt(String(row["retirement_fence"] ?? 0)) + 1n).toString(10);
    row["retirement_lease_until"] = params[11];
    row["retirement_snapshot_hash"] = params[12];
    row["retirement_row_version"] = (BigInt(String(row["retirement_row_version"] ?? 0)) + 1n).toString(10);
    row["retirement_target_journal_key"] = params[7];
    row["retirement_action_idempotency_key"] = params[8];
    row["retirement_disposition_started"] = false;
    row["updated_at"] = params[13];
    return [structuredClone(row)];
  }

  #lpSequencesReclaimPreBindRetirement(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    if (row === undefined || row["agent_id"] !== params[1] || row["owner_address"] !== params[2] ||
        row["state"] !== "retiring-pre-bind" || row["retirement_target_journal_key"] !== params[3] ||
        BigInt(String(row["retirement_fence"] ?? 0)) !== BigInt(String(params[4])) ||
        BigInt(String(row["retirement_row_version"] ?? 0)) !== BigInt(String(params[5])) ||
        asTime(row["retirement_lease_until"]) > asTime(params[6]) ||
        row["retirement_snapshot_hash"] !== params[9] || row["retirement_disposition_started"] === true) return [];
    row["retirement_fence"] = (BigInt(String(row["retirement_fence"] ?? 0)) + 1n).toString(10);
    row["retirement_lease_until"] = params[8];
    row["retirement_action_idempotency_key"] = params[7];
    row["retirement_row_version"] = (BigInt(String(row["retirement_row_version"] ?? 0)) + 1n).toString(10);
    row["updated_at"] = params[6];
    return [structuredClone(row)];
  }

  #lpRetirementRow(params: readonly unknown[]): Row | undefined {
    const row = this.#lpSequences.get(params[0] as string);
    if (row === undefined || row["agent_id"] !== params[1] || row["owner_address"] !== params[2] ||
        row["state"] !== "retiring-pre-bind" || row["retirement_target_journal_key"] !== params[3] ||
        BigInt(String(row["retirement_fence"] ?? 0)) !== BigInt(String(params[4])) ||
        BigInt(String(row["retirement_row_version"] ?? 0)) !== BigInt(String(params[5]))) return undefined;
    return row;
  }

  #advanceRetirementVersion(row: Row, updatedAt: unknown): void {
    row["retirement_row_version"] =
      (BigInt(String(row["retirement_row_version"] ?? 0)) + 1n).toString(10);
    row["updated_at"] = updatedAt;
  }

  #clearRetirement(row: Row): void {
    row["retirement_prior_state"] = null;
    row["retirement_prior_recovery_state"] = null;
    row["retirement_target_journal_key"] = null;
    row["retirement_action_idempotency_key"] = null;
    row["retirement_lease_until"] = null;
    row["retirement_snapshot_hash"] = null;
    row["retirement_disposition_started"] = false;
  }

  #lpSequencesBeginPreBindRetirement(params: readonly unknown[]): Row[] {
    const row = this.#lpRetirementRow(params);
    if (row === undefined) return [];
    row["retirement_disposition_started"] = true;
    this.#advanceRetirementVersion(row, params[6]);
    return [structuredClone(row)];
  }

  #lpSequencesPreBindRetirementTouch(params: readonly unknown[]): Row[] {
    const row = this.#lpRetirementRow(params);
    if (row === undefined || row["retirement_disposition_started"] !== true) return [];
    this.#advanceRetirementVersion(row, params[6]);
    return [structuredClone(row)];
  }

  #lpSequencesFinishPreBindRetirement(params: readonly unknown[]): Row[] {
    const row = this.#lpRetirementRow(params);
    if (row === undefined || row["retirement_disposition_started"] !== true) return [];
    row["state"] = "rolled-back";
    this.#clearRetirement(row);
    this.#advanceRetirementVersion(row, params[6]);
    return [structuredClone(row)];
  }

  #lpSequencesClaimAbandon(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] ||
      asTime(row["updated_at"]) !== asTime(params[3])
    ) {
      return [];
    }
    const heldCutoff = asTime(params[7]);
    const staleClaimCutoff = params[8];
    const firstClaim =
      row["state"] === "held" &&
      (row["abandon_claim_id"] ?? null) === null &&
      asTime(row["updated_at"]) <= heldCutoff;
    const staleReclaim =
      row["state"] === "abandoning" &&
      (row["abandon_claim_id"] ?? null) !== null &&
      typeof row["abandon_claimed_at"] === "number" &&
      typeof staleClaimCutoff === "number" &&
      row["abandon_claimed_at"] <= staleClaimCutoff;
    if (!firstClaim && !staleReclaim) return [];

    row["state"] = "abandoning";
    row["abandon_claim_id"] = params[4];
    row["abandon_claimed_at"] = params[5];
    if (firstClaim) row["abandon_disposition_started_at"] = null;
    row["updated_at"] = params[6];
    return [structuredClone(row)];
  }

  #lpSequencesBeginAbandonDisposition(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] ||
      row["state"] !== "abandoning" ||
      row["abandon_claim_id"] !== params[3]
    ) {
      return [];
    }
    row["abandon_disposition_started_at"] ??= params[4];
    row["updated_at"] = params[5];
    return [structuredClone(row)];
  }

  #lpSequencesReleaseAbandon(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] ||
      row["state"] !== "abandoning" ||
      row["abandon_claim_id"] !== params[3] ||
      (row["abandon_disposition_started_at"] ?? null) !== null
    ) {
      return [];
    }
    row["state"] = "held";
    row["abandon_claim_id"] = null;
    row["abandon_claimed_at"] = null;
    row["abandon_disposition_started_at"] = null;
    row["updated_at"] = params[4];
    return [structuredClone(row)];
  }

  #lpSequencesCompleteAbandon(params: readonly unknown[]): Row[] {
    const row = this.#lpSequences.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] ||
      row["state"] !== "abandoning" ||
      row["abandon_claim_id"] !== params[3] ||
      (row["abandon_disposition_started_at"] ?? null) === null
    ) {
      return [];
    }
    row["state"] = "rolled-back";
    row["abandon_claim_id"] = null;
    row["abandon_claimed_at"] = null;
    row["updated_at"] = params[4];
    return [structuredClone(row)];
  }

  /* ----- grid cycles (PHASE3.15) ----- */

  /** `insert … on conflict (sequence_id) do nothing` — idempotent per flip. */
  #gridCyclesInsert(params: readonly unknown[]): Row[] {
    const sequenceId = params[0] as string;
    if (this.#gridCycles.has(sequenceId)) return [];
    this.#gridCycles.set(sequenceId, {
      sequence_id: sequenceId,
      agent_id: params[1],
      owner_address: params[2],
      position_id: params[3],
      direction: params[4],
      from_tick_lower: params[5],
      from_tick_upper: params[6],
      to_tick_lower: params[7],
      to_tick_upper: params[8],
      freed_amount0_wei: params[9],
      freed_amount1_wei: params[10],
      minted_amount0_wei: params[11],
      minted_amount1_wei: params[12],
      residue_wei: params[13],
      residue_bps: params[14],
      from_token_id: params[15],
      to_token_id: params[16],
      completed_at_ms: params[17],
    });
    return [];
  }

  /** `where owner_address = $1 and agent_id = $2 order by completed_at_ms asc`. */
  #gridCyclesList(params: readonly unknown[]): Row[] {
    return [...this.#gridCycles.values()]
      .filter(
        (row) =>
          sameOwner(row["owner_address"], params[0]) && row["agent_id"] === params[1],
      )
      .sort(
        (left, right) =>
          Number(left["completed_at_ms"]) - Number(right["completed_at_ms"])
          || String(left["sequence_id"]).localeCompare(String(right["sequence_id"])),
      )
      .map((row) => structuredClone(row));
  }

  /* ----- LP exit reservations ----- */

  #lpReservationsInsert(params: readonly unknown[]): Row[] {
    const sequenceId = params[0] as string;
    if (this.#lpReservations.has(sequenceId)) return []; // ON CONFLICT DO NOTHING
    this.#lpReservations.set(sequenceId, {
      sequence_id: sequenceId,
      agent_id: params[1],
      owner_address: params[2],
      kind: params[3],
      quota_bound: params[4],
      reserved_at: params[5],
      // PHASE3.5: a fresh reservation is never released.
      released_at: null,
      // PHASE3.20 item 7: mirrored from the real insert's $7. `null` for every
      // non-ladder kind, which is exactly what the store passes.
      quota_lane: params[6] ?? null,
    });
    // `returning sequence_id`: only the caller whose insert took gets a row.
    return [{ sequence_id: sequenceId }];
  }

  #lpReservationsGet(params: readonly unknown[]): Row[] {
    const row = this.#lpReservations.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2]
    ) {
      return [];
    }
    return [structuredClone(row)];
  }

  /** Rolling-window scan: `agent_id = $1 and reserved_at > $2 and sequence_id <> $3`. */
  /** `released_at = $4 where … and released_at is null` — idempotent. */
  #lpReservationsRelease(params: readonly unknown[]): Row[] {
    const row = this.#lpReservations.get(params[0] as string);
    if (
      row === undefined ||
      row["agent_id"] !== params[1] ||
      row["owner_address"] !== params[2] ||
      (row["released_at"] ?? null) !== null
    ) {
      return [];
    }
    row["released_at"] = params[3];
    return [];
  }

  /** The single aggregate `GET /agents/:id/lp` reads (PHASE3.5 decision 4). */
  #lpReservationsQuotaUsage(params: readonly unknown[]): Row[] {
    const cutoff = asTime(params[2]);
    const rows = [...this.#lpReservations.values()].filter(
      (row) =>
        row["agent_id"] === params[0] &&
        row["owner_address"] === params[1] &&
        asTime(row["reserved_at"]) > cutoff,
    );
    // PHASE3.7 F2 (REVIEW M7): `live_count` reports what the GATE counts,
    // so the `filter (where released_at is null and quota_bound)` clause is
    // modelled here too. Without it the fake would let a divergence between
    // dashboard and gate pass the offline suite.
    const live = rows.filter(
      (row) => (row["released_at"] ?? null) === null && row["quota_bound"] === true,
    );
    // PHASE3.15 R2.7: the grid lane is reported alongside, and the store
    // subtracts it to get the exit lane. Mirrored here because the fake never
    // parses SQL (the A6 warning at the top of this file).
    const gridLive = live.filter((row) => row["kind"] === "grid-flip");
    // PHASE3.18 C7: the THIRD lane's aggregate, mirrored for the same reason.
    // The store subtracts BOTH out of `live_count` to get the exit lane, and a
    // fake that reported only two lanes would let the "requote counted against
    // the exit quota" defect through the whole offline suite.
    const requoteLive = live.filter((row) => row["kind"] === "grid-requote");
    // PHASE3.19 item 19: the FOURTH lane's aggregate, mirrored for the identical
    // reason. The store subtracts all THREE out of `live_count`, and a fake that
    // reported only three lanes would let "every ladder motion charged to the
    // EXIT quota" through the whole offline suite — the R2.10 easiest-defect
    // class, one lane later.
    const recenterLive = live.filter((row) => row["kind"] === "grid-recenter");
    // ─── PHASE3.20 B1(a) — THE NULL ARM, MIRRORED EXACTLY ──────────────────
    //
    // The fake never parses SQL (the A6 warning at the top of this file), so the
    // three-valued logic the real predicate depends on has to be reproduced by
    // hand — and reproducing it WRONG here is how the offline suite would
    // certify the very defect B1 is about. The settlement aggregate is
    // `(quota_lane = 'settlement' or quota_lane is null)`; the drift aggregate is
    // exact. That asymmetry is what keeps
    // `settlement + drift === recenter` true over a window that MIXES
    // pre-migration NULL rows with both lanes.
    const settlementLive = recenterLive.filter(
      (row) => (row["quota_lane"] ?? null) === null || row["quota_lane"] === "settlement",
    );
    const driftLive = recenterLive.filter((row) => row["quota_lane"] === "drift");
    // PHASE3.22 R2.21: the FIFTH lane, mirrored for the identical reason the
    // four above it are. The store subtracts ALL FOUR out of `live_count`, and a
    // fake that reported only four lanes would let "every atomic motion charged
    // to the EXIT quota" through the whole offline suite. It filters on the KIND
    // PHASE3.23 R3.3: shifts carry distinct cause-derived lane strings, while
    // kind-scoped filters keep ladder recenter counters independent.
    const shiftLive = live.filter((row) => row["kind"] === "grid-shift");
    // PHASE3.25 R2.6 — mirror Postgres' legacy-NULL-as-settlement predicate.
    const shiftSettleLive = shiftLive.filter(
      (row) => row["quota_lane"] === "shift-settle" || (row["quota_lane"] ?? null) === null,
    );
    const shiftDriftLive = shiftLive.filter((row) => row["quota_lane"] === "shift-drift");
    const latest = rows.length === 0
      ? null
      : rows.reduce((a, b) => (asTime(a["reserved_at"]) >= asTime(b["reserved_at"]) ? a : b))["reserved_at"];
    const oldestLive = live.length === 0
      ? null
      : live.reduce((a, b) => (asTime(a["reserved_at"]) <= asTime(b["reserved_at"]) ? a : b))["reserved_at"];
    return [
      {
        // pg returns bigint counts as strings; the store parses them back.
        live_count: String(live.length),
        grid_live_count: String(gridLive.length),
        requote_live_count: String(requoteLive.length),
        recenter_live_count: String(recenterLive.length),
        settlement_live_count: String(settlementLive.length),
        drift_live_count: String(driftLive.length),
        shift_live_count: String(shiftLive.length),
        shift_settle_live_count: String(shiftSettleLive.length),
        shift_drift_live_count: String(shiftDriftLive.length),
        released_count: String(rows.filter((row) => (row["released_at"] ?? null) !== null).length),
        latest_reserved_at: latest ?? null,
        oldest_live_reserved_at: oldestLive ?? null,
      },
    ];
  }

  #lpReservationsWindow(params: readonly unknown[]): Row[] {
    const cutoff = asTime(params[1]);
    return [...this.#lpReservations.values()]
      .filter(
        (row) =>
          row["agent_id"] === params[0] &&
          // PHASE3.7 F2(3): the query gained the owner conjunct every other
          // query in the file already had.
          row["owner_address"] === params[3] &&
          asTime(row["reserved_at"]) > cutoff &&
          row["sequence_id"] !== params[2],
      )
      // PHASE3.5 Rev2 M3: the window query selects BOTH columns, because the
      // caller splits them — the daily count skips released rows, the spacing
      // anchor does not.
      .map((row) =>
        structuredClone({
          reserved_at: row["reserved_at"],
          released_at: row["released_at"] ?? null,
          // PHASE3.7 F2: the caller now splits on THREE columns, not two.
          quota_bound: row["quota_bound"] === true,
          // PHASE3.20 C5: and on FOUR since the ladder's lane became a property
          // of the ROW rather than of the kind. The filter itself stays in
          // TypeScript at the caller, so this statement gains a column and no
          // predicate.
          quota_lane: row["quota_lane"] ?? null,
          // PHASE3.15 R2.7: FOUR — the daily count is per LANE and the lane is
          // derived from the kind the row already stores.
          kind: row["kind"],
        }),
      );
  }
}

function asTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(String(value)).getTime();
}

function project(row: Row, columns?: readonly string[]): Row {
  if (columns === undefined) return structuredClone(row);
  const out: Row = {};
  for (const column of columns) out[column] = row[column];
  return structuredClone(out);
}

function byCreatedThenId(a: Row, b: Row): number {
  const byTime = Number(a["created_at"]) - Number(b["created_at"]);
  return byTime !== 0 ? byTime : String(a["id"]).localeCompare(String(b["id"]));
}
