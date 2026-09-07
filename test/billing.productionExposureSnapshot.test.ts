import assert from "node:assert/strict";
import test from "node:test";
import { validateWindowsPrivateAclEvidence } from "../scripts/billing-enable-preflight.js";
import { PostgresBillingSessionGenerationRepository } from "../src/billing/sessionGenerations.js";
import type { BillingStoreSnapshot } from "../src/billing/store.js";
import type { BillingAccount, Usage } from "../src/billing/types.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";

const ACCOUNT_ID = "exposure-account";
const WALLET = "0x1111111111111111111111111111111111111111";
const AUTHORIZER = "0x4444444444444444444444444444444444444444";

function account(legacy = false): BillingAccount {
  return {
    accountId: ACCOUNT_ID, ownerAddress: WALLET, walletAddress: WALLET, status: "paused",
    sessionFactsBytes: "", encryptedSessionKey: legacy ? "legacy-ciphertext" : null,
    ...(legacy ? {} : { sessionKmsKeyArn: null, sessionGeneration: null, sessionPublicKey: null, sessionStateVersion: 1n }),
    maxDailyUsdMicros: 1_000n, maxUnpaidExposureUsdMicros: 1_000n, thresholdUsdMicros: 100_000n,
    grantExpiresAt: 2_000, createdAt: 1, updatedAt: 1,
  };
}

function usage(id: string, state: Usage["state"], reservedAtomic: bigint, input: Readonly<{
  payer?: string;
  actualAtomic?: bigint;
}> = {}): Usage {
  return {
    usageId: id, assertionNonce: `nonce-${id}`, sessionTicketHash: `ticket-${id}`, accountId: ACCOUNT_ID,
    ownerAddress: WALLET, walletAddress: WALLET, agentId: "agent", grantId: "grant", generation: 1n,
    operation: "paid.cmc.quote", source: "x402", provider: "cmc", templateId: "template",
    logicalRequestId: `logical-${id}`, requestDigest: `digest-${id}`, payerIdentity: input.payer ?? AUTHORIZER,
    state, version: 1n, asset: "USDC_BASE", reservedAtomic, reservedUsdMicros: reservedAtomic,
    ...(input.actualAtomic === undefined ? {} : { actualAtomic: input.actualAtomic }), createdAt: 1, updatedAt: 1,
  };
}

function snapshot(owner = account()): BillingStoreSnapshot {
  const usages = [
    usage("prepared", "prepared", 7n),
    usage("actual", "actual", 8n, { actualAtomic: 3n }),
    usage("released", "released", 9n),
    usage("other-payer", "unknown", 100n, { payer: "0x5555555555555555555555555555555555555555" }),
  ];
  return { accounts: [[ACCOUNT_ID, owner]], walletAccounts: [[WALLET, ACCOUNT_ID]], grants: [], tickets: [],
    replays: [], logical: [], usages: usages.map((row) => [row.usageId, row]), debitIdentities: [], leases: [],
    invoices: [], nonterminalInvoiceByUsage: [], ledger: [], ogReconciliations: [] };
}

class ExposureSql implements SqlClient {
  readonly texts: string[] = [];
  migrationOk = true;
  constructor(readonly payload: BillingStoreSnapshot) {}

  async query<Row = Record<string, unknown>>(text: string): Promise<SqlResult<Row>> {
    this.texts.push(text);
    let rows: readonly unknown[] = [];
    if (text.includes("billing.session.enablementMigration")) rows = [{ state_table: this.migrationOk,
      accounts_table: true, generations_table: true, actions_table: true, encrypted_key_nullable: true,
      kms_projection_columns: true }];
    else if (text.includes("billing.session.enablementState")) rows = [{ payload: this.payload }];
    else if (text.includes("billing.session.censusGenerations") || text.includes("billing.session.censusActions")) rows = [];
    return { rows: rows as readonly Row[] };
  }

  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> { return fn(this); }
  async close(): Promise<void> {}
}

test("read-only PostgreSQL enablement snapshot verifies migration and KMS census before deriving exact Usage exposure", async () => {
  const sql = new ExposureSql(snapshot());
  const result = await PostgresBillingSessionGenerationRepository.attach(sql).readOnlyEnablementExposure({
    migrationVersion: "006_phase5_production_enablement.sql", x402Authorizer: AUTHORIZER,
  });
  assert.equal(result.liveUsdcExposureAtomic, 10n);
  assert.equal(result.census.length, 1);
  const isolation = sql.texts.findIndex((text) => text.includes("enablementIsolation"));
  const migration = sql.texts.findIndex((text) => text.includes("enablementMigration"));
  const state = sql.texts.findIndex((text) => text.includes("enablementState"));
  assert.ok(isolation >= 0 && isolation < migration && migration < state);
  assert.match(sql.texts[isolation]!, /repeatable read read only/iu);
});

test("read-only exposure snapshot refuses missing migration shape before reading Usage", async () => {
  const sql = new ExposureSql(snapshot());
  sql.migrationOk = false;
  await assert.rejects(PostgresBillingSessionGenerationRepository.attach(sql).readOnlyEnablementExposure({
    migrationVersion: "006_phase5_production_enablement.sql", x402Authorizer: AUTHORIZER,
  }), /migration is not installed/u);
  assert.equal(sql.texts.some((text) => text.includes("enablementState")), false);
});

test("read-only exposure snapshot refuses legacy custody in the same transaction", async () => {
  const sql = new ExposureSql(snapshot(account(true)));
  await assert.rejects(PostgresBillingSessionGenerationRepository.attach(sql).readOnlyEnablementExposure({
    migrationVersion: "006_phase5_production_enablement.sql", x402Authorizer: AUTHORIZER,
  }), /legacy or dual custody/u);
});

test("Windows credential ACL admits only the current identity, SYSTEM, and Administrators", () => {
  const currentSid = "S-1-5-21-100-200-300-400";
  const privateAcl = {
    ownerSid: currentSid,
    currentSid,
    areAccessRulesProtected: true,
    access: [
      { sid: currentSid, type: "Allow" },
      { sid: "S-1-5-18", type: "Allow" },
      { sid: "S-1-5-32-544", type: "Allow" },
    ],
  } as const;
  assert.doesNotThrow(() => validateWindowsPrivateAclEvidence(privateAcl));
  assert.throws(() => validateWindowsPrivateAclEvidence({ ...privateAcl, areAccessRulesProtected: false }), /not private/u);
  assert.throws(() => validateWindowsPrivateAclEvidence({ ...privateAcl,
    access: [...privateAcl.access, { sid: "S-1-5-32-545", type: "Allow" }] }), /another principal/u);
  assert.throws(() => validateWindowsPrivateAclEvidence({ ...privateAcl, ownerSid: "S-1-5-18" }), /not private/u);
  assert.throws(() => validateWindowsPrivateAclEvidence({ ...privateAcl, unexpected: true }), /unknown or missing/u);
});
