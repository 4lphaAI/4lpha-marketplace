import { decodeJsonb, encodeJsonbParam } from "../store/codec.js";
import { loadMasterKey } from "../store/crypto.js";
import { createPgSqlClient, type SqlClient } from "../store/sql.js";
import type { Hex } from "viem";
import {
  MemoryBillingStore,
  type BillingStore,
  type BillingStoreSnapshot,
  type PreparedInvoiceBinding,
  type PreparedInvoiceIntent,
  type PreparedUsage,
  type ReservePaidUsageInput,
} from "./store.js";
import type {
  AgentBillingGrant,
  BillingAccount,
  BillingSpendLedgerEntry,
  Invoice,
  OgReconciliationCursor,
  OgResponseFacts,
  PaidServiceSessionTicketV1,
  Usage,
  X402UsageFacts,
} from "./types.js";

const BILLING_STATE_DDL = `
  create table if not exists phase5_billing_state (
    singleton boolean primary key default true check (singleton),
    payload jsonb not null
  )
`;

const BILLING_ACCOUNTS_DDL = `
  create table if not exists phase5_billing_accounts (
    account_id text primary key,
    wallet_address text not null unique,
    owner_address text not null,
    encrypted_session_key text not null,
    record jsonb not null,
    created_at bigint not null
  )
`;

const BILLING_IDENTITIES_DDL = `
  create table if not exists phase5_billing_usage_identities (
    usage_id text primary key,
    grant_id text not null,
    generation numeric(78,0) not null check (generation >= 0),
    operation text not null check (operation in ('paid.0g.chat','paid.cmc.quote')),
    logical_request_id text not null,
    assertion_nonce text not null,
    source text not null check (source in ('x402','0g')),
    debit_identity text unique,
    x402_chain_id bigint,
    usdc_address text,
    authorizer text,
    authorization_nonce text,
    router_payer_account_id text,
    router_request_id text,
    unique (grant_id, generation, operation, logical_request_id),
    unique (grant_id, generation, assertion_nonce),
    unique (router_payer_account_id, router_request_id),
    check (
      source <> 'x402' or
      (x402_chain_id is not null and usdc_address is not null and authorizer is not null and authorization_nonce is not null) or
      debit_identity is null
    ),
    check (
      source <> '0g' or
      (router_payer_account_id is not null and router_request_id is not null) or
      debit_identity is null
    )
  )
`;

const BILLING_IDENTITIES_MIGRATION_DDL = `
  alter table phase5_billing_usage_identities
    add column if not exists source text,
    add column if not exists x402_chain_id bigint,
    add column if not exists usdc_address text,
    add column if not exists authorizer text,
    add column if not exists authorization_nonce text,
    add column if not exists router_payer_account_id text,
    add column if not exists router_request_id text;
  create unique index if not exists phase5_billing_logical_request_uq
    on phase5_billing_usage_identities
      (grant_id, generation, operation, logical_request_id);
  create unique index if not exists phase5_billing_assertion_nonce_uq
    on phase5_billing_usage_identities
      (grant_id, generation, assertion_nonce)
`;

const BILLING_X402_IDENTITY_INDEX_DDL = `
  create unique index if not exists phase5_billing_x402_debit_identity_uq
  on phase5_billing_usage_identities
    (x402_chain_id, usdc_address, authorizer, authorization_nonce)
  where source = 'x402' and debit_identity is not null
`;

const BILLING_0G_IDENTITY_INDEX_DDL = `
  create unique index if not exists phase5_billing_0g_debit_identity_uq
  on phase5_billing_usage_identities
    (router_payer_account_id, router_request_id)
  where source = '0g' and debit_identity is not null
`;

const BILLING_IDENTITIES_FINALIZE_DDL = `
  alter table phase5_billing_usage_identities alter column source set not null;
  do $$ begin
    if not exists (select 1 from pg_constraint where conname='phase5_billing_usage_source_ck') then
      alter table phase5_billing_usage_identities add constraint phase5_billing_usage_source_ck
        check (source in ('x402','0g'));
    end if;
    if not exists (select 1 from pg_constraint where conname='phase5_billing_x402_shape_ck') then
      alter table phase5_billing_usage_identities add constraint phase5_billing_x402_shape_ck
        check (source <> 'x402' or debit_identity is null or
          (x402_chain_id is not null and usdc_address is not null and authorizer is not null and authorization_nonce is not null));
    end if;
    if not exists (select 1 from pg_constraint where conname='phase5_billing_0g_shape_ck') then
      alter table phase5_billing_usage_identities add constraint phase5_billing_0g_shape_ck
        check (source <> '0g' or debit_identity is null or
          (router_payer_account_id is not null and router_request_id is not null));
    end if;
  end $$
`;

const BILLING_LEASES_DDL = `
  create table if not exists phase5_billing_attempt_leases (
    account_id text primary key,
    usage_id text not null unique,
    expires_at bigint not null,
    contacted boolean not null,
    active boolean not null default true check (active)
  )
`;

const BILLING_ACTIVE_LEASE_INDEX_DDL = `
  create unique index if not exists phase5_billing_one_active_lease_per_account_uq
  on phase5_billing_attempt_leases (account_id)
  where active
`;

const BILLING_INVOICE_MEMBERS_DDL = `
  create table if not exists phase5_billing_invoice_members (
    usage_id text primary key,
    invoice_id text not null,
    account_id text not null
  )
`;

const BILLING_CLOSE_CLAIMS_DDL = `
  create table if not exists phase5_billing_close_claims (
    account_id text primary key,
    close_request_id text not null,
    invoice_id text not null unique
  )
`;

const BILLING_LEDGER_DDL = `
  create table if not exists phase5_billing_spend_ledger (
    usage_id text primary key,
    invoice_id text not null,
    account_id text not null,
    agent_id text not null,
    session_ticket_hash text not null,
    usd_micros numeric(78,0) not null check (usd_micros >= 0),
    paid_at bigint not null
  )
`;

type StateRow = Readonly<{ payload: unknown }>;
type AccountIdentityRow = Readonly<{ account_id: string; wallet_address: string; owner_address: string }>;

const EMPTY_SNAPSHOT: BillingStoreSnapshot = {
  accounts: [], walletAccounts: [], grants: [], tickets: [], replays: [], logical: [], usages: [],
  debitIdentities: [], leases: [], invoices: [], nonterminalInvoiceByUsage: [], ledger: [],
  ogReconciliations: [],
};

/**
 * PostgreSQL backend with one serialized monetary-state row.
 *
 * The coarse row lock is intentional for v1: the product already permits only
 * one paid attempt per account, and one global lock makes every multi-map
 * transition/rollback atomic across processes. Permanent wallet assignment is
 * additionally enforced by a database UNIQUE constraint, not by this snapshot.
 */
export class PostgresBillingStore implements BillingStore {
  readonly #sql: SqlClient;

  private constructor(sql: SqlClient) { this.#sql = sql; }

  static async create(sql: SqlClient, masterKey: Buffer | null): Promise<PostgresBillingStore> {
    if (masterKey === null) throw new Error("EXECUTION_MASTER_KEY is required for PostgreSQL billing storage.");
    await sql.query(BILLING_STATE_DDL);
    await sql.query(BILLING_ACCOUNTS_DDL);
    await sql.query(BILLING_IDENTITIES_DDL);
    await sql.query(BILLING_IDENTITIES_MIGRATION_DDL);
    await sql.query(BILLING_X402_IDENTITY_INDEX_DDL);
    await sql.query(BILLING_0G_IDENTITY_INDEX_DDL);
    await sql.query(BILLING_LEASES_DDL);
    await sql.query(BILLING_ACTIVE_LEASE_INDEX_DDL);
    await sql.query(BILLING_INVOICE_MEMBERS_DDL);
    await sql.query(BILLING_CLOSE_CLAIMS_DDL);
    await sql.query(BILLING_LEDGER_DDL);
    await sql.query(
      `/* billing.state.init */
       insert into phase5_billing_state (singleton, payload)
       values (true, $1::jsonb) on conflict (singleton) do nothing`,
      [encodeJsonbParam(EMPTY_SNAPSHOT)],
    );
    const store = new PostgresBillingStore(sql);
    await store.#backfillProjection();
    await sql.query(BILLING_IDENTITIES_FINALIZE_DDL);
    return store;
  }

  /**
   * Open an already-provisioned store without DDL, seed writes, or key loading.
   * This exists only for the operator dry-run/status surface; all mutating
   * callers must continue through {@link create}.
   */
  static openReadOnly(sql: SqlClient): PostgresBillingStore {
    return new PostgresBillingStore(sql);
  }

  async #store(tx: SqlClient, lock: boolean): Promise<MemoryBillingStore> {
    const result = await tx.query<StateRow>(
      `/* billing.state.read */ select payload from phase5_billing_state where singleton=true${lock ? " for update" : ""}`,
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Phase 5 billing state row is missing.");
    return new MemoryBillingStore(decodeJsonb(row.payload) as BillingStoreSnapshot);
  }

  async #mutate<T>(fn: (store: MemoryBillingStore, tx: SqlClient) => Promise<T>): Promise<T> {
    return this.#sql.transaction(async (tx) => {
      const store = await this.#store(tx, true);
      const result = await fn(store, tx);
      await this.#replaceConstraintProjection(tx, store.dump());
      await tx.query(
        `/* billing.state.write */ update phase5_billing_state set payload=$1::jsonb where singleton=true`,
        [encodeJsonbParam(store.dump())],
      );
      return result;
    });
  }

  async #backfillProjection(): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      const store = await this.#store(tx, true);
      await this.#replaceConstraintProjection(tx, store.dump());
    });
  }

  /**
   * Mirror every monetary identity into normalized relations in the same
   * transaction as the canonical state row. The singleton row lock means no
   * second writer can observe the replace window; PostgreSQL uniqueness/check
   * constraints validate the complete post-transition state before JSONB can
   * commit. Rebuilding also backfills deployments created by an older Phase 5
   * binary instead of silently leaving their historical identities unguarded.
   */
  async #replaceConstraintProjection(tx: SqlClient, snapshot: BillingStoreSnapshot): Promise<void> {
    await tx.query(`/* billing.projection.closeClaimsClear */ delete from phase5_billing_close_claims`);
    await tx.query(`/* billing.projection.invoiceMembersClear */ delete from phase5_billing_invoice_members`);
    await tx.query(`/* billing.projection.leasesClear */ delete from phase5_billing_attempt_leases`);

    const usages = new Map(snapshot.usages);
    for (const [, usage] of snapshot.usages) {
      const x402 = usage.sourceFacts?.kind === "x402" ? usage.sourceFacts : undefined;
      const og = usage.sourceFacts?.kind === "0g" ? usage.sourceFacts : undefined;
      const identity = await tx.query<{ usage_id: string }>(
        `/* billing.projection.identityInsert */
         insert into phase5_billing_usage_identities
           (usage_id,grant_id,generation,operation,logical_request_id,assertion_nonce,source,debit_identity,
            x402_chain_id,usdc_address,authorizer,authorization_nonce,router_payer_account_id,router_request_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (usage_id) do update set
           source = coalesce(phase5_billing_usage_identities.source, excluded.source),
           debit_identity = coalesce(phase5_billing_usage_identities.debit_identity, excluded.debit_identity),
           x402_chain_id = coalesce(phase5_billing_usage_identities.x402_chain_id, excluded.x402_chain_id),
           usdc_address = coalesce(phase5_billing_usage_identities.usdc_address, excluded.usdc_address),
           authorizer = coalesce(phase5_billing_usage_identities.authorizer, excluded.authorizer),
           authorization_nonce = coalesce(phase5_billing_usage_identities.authorization_nonce, excluded.authorization_nonce),
           router_payer_account_id = coalesce(phase5_billing_usage_identities.router_payer_account_id, excluded.router_payer_account_id),
           router_request_id = coalesce(phase5_billing_usage_identities.router_request_id, excluded.router_request_id)
         where phase5_billing_usage_identities.grant_id = excluded.grant_id
           and phase5_billing_usage_identities.generation = excluded.generation
           and phase5_billing_usage_identities.operation = excluded.operation
           and phase5_billing_usage_identities.logical_request_id = excluded.logical_request_id
           and phase5_billing_usage_identities.assertion_nonce = excluded.assertion_nonce
           and (phase5_billing_usage_identities.source is null or
                phase5_billing_usage_identities.source = excluded.source)
           and (phase5_billing_usage_identities.debit_identity is null or
                phase5_billing_usage_identities.debit_identity is not distinct from excluded.debit_identity)
         returning usage_id`,
        [
          usage.usageId, usage.grantId, usage.generation.toString(), usage.operation,
          usage.logicalRequestId, usage.assertionNonce, usage.source, usage.debitIdentity ?? null,
          x402?.chainId ?? null, x402?.usdcAddress.toLowerCase() ?? null,
          x402?.authorizer.toLowerCase() ?? null, x402?.authorizationNonce.toLowerCase() ?? null,
          og?.routerPayerAccountId ?? null, usage.source === "0g" ? usage.externalRequestId ?? null : null,
        ],
      );
      if (identity.rows[0]?.usage_id !== usage.usageId) {
        throw new Error("Billing permanent Usage identity conflicts with its checked backfill.");
      }
    }
    for (const [accountId, lease] of snapshot.leases) {
      await tx.query(
        `/* billing.projection.leaseInsert */
         insert into phase5_billing_attempt_leases
           (account_id,usage_id,expires_at,contacted,active) values ($1,$2,$3,$4,true)`,
        [accountId, lease.usageId, lease.expiresAt, lease.contacted],
      );
    }
    for (const [usageId, invoiceId] of snapshot.nonterminalInvoiceByUsage) {
      const usage = usages.get(usageId);
      if (usage === undefined) throw new Error("Billing invoice-member projection lost its Usage.");
      await tx.query(
        `/* billing.projection.invoiceMemberInsert */
         insert into phase5_billing_invoice_members (usage_id,invoice_id,account_id) values ($1,$2,$3)`,
        [usageId, invoiceId, usage.accountId],
      );
    }
    for (const [, account] of snapshot.accounts) {
      if (account.closeFlushInvoiceId === undefined) continue;
      if (account.closeRequestId === undefined) throw new Error("Billing close claim lost its close request identity.");
      await tx.query(
        `/* billing.projection.closeClaimInsert */
         insert into phase5_billing_close_claims (account_id,close_request_id,invoice_id) values ($1,$2,$3)`,
        [account.accountId, account.closeRequestId, account.closeFlushInvoiceId],
      );
    }
    for (const [, entry] of snapshot.ledger) {
      const ledger = await tx.query<{ usage_id: string }>(
        `/* billing.projection.ledgerInsert */
         insert into phase5_billing_spend_ledger
           (usage_id,invoice_id,account_id,agent_id,session_ticket_hash,usd_micros,paid_at)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (usage_id) do update set usage_id=excluded.usage_id
         where phase5_billing_spend_ledger.invoice_id=excluded.invoice_id
           and phase5_billing_spend_ledger.account_id=excluded.account_id
           and phase5_billing_spend_ledger.agent_id=excluded.agent_id
           and phase5_billing_spend_ledger.session_ticket_hash=excluded.session_ticket_hash
           and phase5_billing_spend_ledger.usd_micros=excluded.usd_micros
           and phase5_billing_spend_ledger.paid_at=excluded.paid_at
         returning usage_id`,
        [entry.usageId, entry.invoiceId, entry.accountId, entry.agentId, entry.sessionTicketHash, entry.usdMicros.toString(), entry.paidAt],
      );
      if (ledger.rows[0]?.usage_id !== entry.usageId) {
        throw new Error("Billing permanent ledger allocation conflicts with its checked backfill.");
      }
    }
  }

  async #read<T>(fn: (store: MemoryBillingStore) => Promise<T>): Promise<T> {
    const store = await this.#store(this.#sql, false);
    return fn(store);
  }

  async createAccount(account: BillingAccount): Promise<BillingAccount> {
    return this.#mutate(async (store, tx) => {
      const inserted = await tx.query<AccountIdentityRow>(
        `/* billing.account.identityInsert */
         insert into phase5_billing_accounts
           (account_id,wallet_address,owner_address,encrypted_session_key,record,created_at)
         values ($1,$2,$3,$4,$5::jsonb,$6)
         on conflict do nothing returning account_id,wallet_address,owner_address`,
        [account.accountId, account.walletAddress.toLowerCase(), account.ownerAddress.toLowerCase(), account.encryptedSessionKey, encodeJsonbParam(account), account.createdAt],
      );
      if (inserted.rows[0] === undefined) {
        const existing = await tx.query<AccountIdentityRow>(
          `/* billing.account.identityGet */
           select account_id,wallet_address,owner_address from phase5_billing_accounts
           where account_id=$1 or wallet_address=$2`,
          [account.accountId, account.walletAddress.toLowerCase()],
        );
        const row = existing.rows[0];
        if (row === undefined || row.account_id !== account.accountId || row.wallet_address !== account.walletAddress.toLowerCase() || row.owner_address !== account.ownerAddress.toLowerCase()) {
          throw new Error("Billing wallet identity is permanently assigned.");
        }
      }
      return store.createAccount(account);
    });
  }

  listAccounts(): Promise<readonly BillingAccount[]> { return this.#read((store) => store.listAccounts()); }
  claimBillingWorkerAccountBatch(limit: number): Promise<readonly BillingAccount[]> {
    return this.#mutate((store) => store.claimBillingWorkerAccountBatch(limit));
  }
  getAccount(accountId: string): Promise<BillingAccount | null> { return this.#read((store) => store.getAccount(accountId)); }
  getAccountByWallet(walletAddress: string): Promise<BillingAccount | null> { return this.#read((store) => store.getAccountByWallet(walletAddress)); }
  putGrant(grant: AgentBillingGrant): Promise<AgentBillingGrant> { return this.#mutate((store) => store.putGrant(grant)); }
  getGrant(grantId: string, generation: bigint): Promise<AgentBillingGrant | null> { return this.#read((store) => store.getGrant(grantId, generation)); }
  listGrants(accountId: string): Promise<readonly AgentBillingGrant[]> { return this.#read((store) => store.listGrants(accountId)); }
  putSessionTicket(ticket: PaidServiceSessionTicketV1): Promise<PaidServiceSessionTicketV1> { return this.#mutate((store) => store.putSessionTicket(ticket)); }
  getSessionTicket(ticketId: string): Promise<PaidServiceSessionTicketV1 | null> { return this.#read((store) => store.getSessionTicket(ticketId)); }
  setAccountStatus(accountId: string, status: BillingAccount["status"], now: number): Promise<BillingAccount> { return this.#mutate((store) => store.setAccountStatus(accountId, status, now)); }
  beginAccountClose(accountId: string, closeRequestId: string, now: number): Promise<BillingAccount> { return this.#mutate((store) => store.beginAccountClose(accountId, closeRequestId, now)); }
  closeAccountIfSettled(accountId: string, now: number): Promise<BillingAccount> { return this.#mutate((store) => store.closeAccountIfSettled(accountId, now)); }
  reservePaidUsage(input: ReservePaidUsageInput): Promise<PreparedUsage> {
    return this.#mutate((store) => store.reservePaidUsage(input));
  }
  reclaimPreparedLease(accountId: string, now: number): Promise<boolean> { return this.#mutate((store) => store.reclaimPreparedLease(accountId, now)); }
  bindX402Authorization(usageId: string, leaseToken: string, expectedVersion: bigint, facts: X402UsageFacts): Promise<Usage> {
    return this.#mutate((store) => store.bindX402Authorization(usageId, leaseToken, expectedVersion, facts));
  }
  markUpstreamContact(usageId: string, leaseToken: string, expectedVersion: bigint, now: number): Promise<Usage> { return this.#mutate((store) => store.markUpstreamContact(usageId, leaseToken, expectedVersion, now)); }
  bindExternalRequestId(usageId: string, leaseToken: string, expectedVersion: bigint, requestId: string, now: number): Promise<Usage> { return this.#mutate((store) => store.bindExternalRequestId(usageId, leaseToken, expectedVersion, requestId, now)); }
  bindOgResponseFacts(usageId: string, leaseToken: string, expectedVersion: bigint, facts: OgResponseFacts, now: number): Promise<Usage> { return this.#mutate((store) => store.bindOgResponseFacts(usageId, leaseToken, expectedVersion, facts, now)); }
  finalizeActual(usageId: string, leaseToken: string, actualAtomic: bigint, evidenceKind: string, evidenceDigest: string, now: number): Promise<Usage> { return this.#mutate((store) => store.finalizeActual(usageId, leaseToken, actualAtomic, evidenceKind, evidenceDigest, now)); }
  finalizeProvenNotCharged(usageId: string, leaseToken: string, evidenceKind: string, evidenceDigest: string, now: number): Promise<Usage> { return this.#mutate((store) => store.finalizeProvenNotCharged(usageId, leaseToken, evidenceKind, evidenceDigest, now)); }
  markUnknown(usageId: string, leaseToken: string, evidenceKind: string, evidenceDigest: string, now: number): Promise<Usage> { return this.#mutate((store) => store.markUnknown(usageId, leaseToken, evidenceKind, evidenceDigest, now)); }
  reconcileUnknown(usageId: string, expectedVersion: bigint, resolution: Readonly<{ actualAtomic?: bigint; evidenceKind: string; evidenceDigest: string; now: number }>): Promise<Usage> { return this.#mutate((store) => store.reconcileUnknown(usageId, expectedVersion, resolution)); }
  getUsage(usageId: string): Promise<Usage | null> { return this.#read((store) => store.getUsage(usageId)); }
  listUsages(accountId: string): Promise<readonly Usage[]> { return this.#read((store) => store.listUsages(accountId)); }
  claimInvoice(invoice: Invoice): Promise<Invoice> { return this.#mutate((store) => store.claimInvoice(invoice)); }
  getInvoice(invoiceId: string): Promise<Invoice | null> { return this.#read((store) => store.getInvoice(invoiceId)); }
  listInvoices(accountId: string): Promise<readonly Invoice[]> { return this.#read((store) => store.listInvoices(accountId)); }
  expireQuotedInvoice(invoiceId: string, expectedVersion: bigint, now: number): Promise<Invoice> { return this.#mutate((store) => store.expireQuotedInvoice(invoiceId, expectedVersion, now)); }
  markInvoiceSubmitting(invoiceId: string, expectedVersion: bigint, decisionId: string, intent: PreparedInvoiceIntent, preparedHandle: object, now: number): Promise<PreparedInvoiceBinding> { return this.#mutate((store) => store.markInvoiceSubmitting(invoiceId, expectedVersion, decisionId, intent, preparedHandle, now)); }
  bindInvoiceCallsId(
    invoiceId: string,
    expectedVersion: bigint,
    callsId: string,
    now: number,
    binding?: Readonly<{ decisionId: string; witnessDigest: Hex }>,
  ): Promise<Invoice> {
    return this.#mutate((store) => store.bindInvoiceCallsId(invoiceId, expectedVersion, callsId, now, binding));
  }
  projectInvoicePaid(invoiceId: string, expectedVersion: bigint, paidAt: number, allocations: ReadonlyMap<string, bigint>, evidence: Readonly<{ callsId: string; transactionHash: string }>, now: number): Promise<Invoice> { return this.#mutate((store) => store.projectInvoicePaid(invoiceId, expectedVersion, paidAt, allocations, evidence, now)); }
  projectInvoiceRolledBack(invoiceId: string, expectedVersion: bigint, evidence: Readonly<{ callsId: string; transactionHash: string }>, now: number): Promise<Invoice> { return this.#mutate((store) => store.projectInvoiceRolledBack(invoiceId, expectedVersion, evidence, now)); }
  markInvoiceUnknown(invoiceId: string, expectedVersion: bigint, evidenceDigest: string, now: number): Promise<Invoice> { return this.#mutate((store) => store.markInvoiceUnknown(invoiceId, expectedVersion, evidenceDigest, now)); }
  listLedger(accountId: string): Promise<readonly BillingSpendLedgerEntry[]> { return this.#read((store) => store.listLedger(accountId)); }
  getOgReconciliation(usageId: string): Promise<OgReconciliationCursor | null> { return this.#read((store) => store.getOgReconciliation(usageId)); }
  putOgReconciliation(cursor: OgReconciliationCursor, expectedVersion: bigint | null): Promise<OgReconciliationCursor> { return this.#mutate((store) => store.putOgReconciliation(cursor, expectedVersion)); }
  close(): Promise<void> { return this.#sql.close(); }
}

export async function createBillingStore(env: NodeJS.ProcessEnv = process.env): Promise<BillingStore> {
  const connectionString = env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    return PostgresBillingStore.create(sql, loadMasterKey(env));
  }
  return new MemoryBillingStore();
}

export async function openBillingStoreReadOnly(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BillingStore> {
  const connectionString = env["DATABASE_URL"]?.trim();
  if (connectionString === undefined || connectionString === "") {
    throw new Error("DATABASE_URL is required for billing status and dry-run.");
  }
  return PostgresBillingStore.openReadOnly(await createPgSqlClient(connectionString));
}
