import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { getAddress, type Hex } from "viem";
import { MemoryExecutionJournal, PostgresExecutionJournal, type ExecutionJournal } from "../src/store/journal.js";
import { canonicalPreparedIntentIdentityV1, fingerprintLpFinalCallsV1,
  PORTO_INTENT_SCHEME, PORTO_V055_DECODER, PORTO_V055_ORCHESTRATOR, PORTO_V055_VERSION } from "../src/lp/preparedIntent.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import { createPgSqlClient } from "../src/store/sql.js";
import { localPostgres } from "./support/localPostgres.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const CALLS_ID = `0x${"ab".repeat(32)}` as Hex;
const TX = `0x${"cd".repeat(32)}` as Hex;
const OTHER_TX = `0x${"ef".repeat(32)}` as Hex;
const fingerprint = fingerprintLpFinalCallsV1([{ to: OWNER, data: "0x" }]);
const identity = canonicalPreparedIntentIdentityV1({ scheme: PORTO_INTENT_SCHEME, decoder: PORTO_V055_DECODER,
  chainId: "56", eoa: OWNER, orchestrator: PORTO_V055_ORCHESTRATOR, orchestratorVersion: PORTO_V055_VERSION,
  nonce: "1", expiry: "0", executionDataHash: fingerprint.value.executionDataHash,
  keyHash: `0x${"12".repeat(32)}` as Hex });
const backends = [
  { name: "memory", create: async (): Promise<ExecutionJournal> => new MemoryExecutionJournal() },
  { name: "postgres fake", create: async (): Promise<ExecutionJournal> => PostgresExecutionJournal.create(new FakeSqlClient()) },
];

async function begin(journal: ExecutionJournal, key: string, kind: "trade" | "lp" | "execute" = "trade") {
  return journal.begin({ idempotencyKey: key, agentId: "a", ownerAddress: OWNER, kind,
    finalCallsFingerprint: fingerprint.canonical, finalCallsFingerprintHash: fingerprint.hash });
}

for (const backend of backends) {
  it(`${backend.name}: J1-J2 trade fingerprint and immutable PENDING bind`, async () => {
    const journal = await backend.create();
    await begin(journal, "t");
    const bind = { canonicalIdentity: identity.canonical, identityHash: identity.hash, expectedBindingVersion: 0 };
    const first = await journal.bindPreparedIntent("t", bind);
    assert.equal(first.boundBindingVersion, 1);
    assert.equal((await journal.bindPreparedIntent("t", bind)).boundBindingVersion, 1);
    await assert.rejects(journal.bindPreparedIntent("t", { ...bind, identityHash: `0x${"00".repeat(32)}` as Hex }));
    await journal.markUnknown("t", "stale reconcile");
    await assert.rejects(journal.bindPreparedIntent("t", bind), /PENDING/);
    await assert.rejects(begin(journal, "e", "execute"));
    await journal.close();
  });

  it(`${backend.name}: J4 trade cannot use LP retirement`, async () => {
    const journal = await backend.create();
    await begin(journal, "t");
    await journal.markUnknown("t", "ambiguous");
    await assert.rejects(journal.retireProvenPreBind("t"));
    await journal.close();
  });

  it(`${backend.name}: R2.3 delayed pre-lock binder cannot bind an abandoned trade`, async () => {
    const journal = await backend.create();
    await begin(journal, "delayed");
    await journal.markUnknown("delayed", "stale reconcile snapshot");
    await assert.rejects(journal.bindPreparedIntent("delayed", { canonicalIdentity: identity.canonical,
      identityHash: identity.hash, expectedBindingVersion: 0 }), /PENDING/u);
    assert.equal((await journal.get("delayed"))?.preparedIntentIdentity, null);
    await journal.close();
  });

  it(`${backend.name}: R4.1 completion applies only to its locked trade row and callsId`, async () => {
    const journal = await backend.create();
    await begin(journal, "commit");
    await journal.markInProgress("commit", { callsId: CALLS_ID });
    assert.equal((await journal.completeStagedTrade("commit", { callsId: OTHER_TX }, { state: "COMMITTED", txHash: TX })).applied, false);
    assert.equal((await journal.completeStagedTrade("commit", { callsId: CALLS_ID }, { state: "COMMITTED", txHash: TX })).applied, true);
    assert.equal((await journal.completeStagedTrade("commit", { callsId: CALLS_ID }, { state: "COMMITTED", txHash: OTHER_TX })).applied, false);
    assert.equal((await journal.get("commit"))?.externalRef.txHash, TX);
    await begin(journal, "rollback");
    await journal.markInProgress("rollback", { callsId: CALLS_ID });
    assert.equal((await journal.completeStagedTrade("rollback", { callsId: CALLS_ID }, { state: "ROLLED_BACK", lastError: "refused" })).applied, true);
    assert.equal((await journal.get("rollback"))?.lastError, "refused");
    await begin(journal, "lp", "lp");
    await journal.markInProgress("lp", { callsId: CALLS_ID });
    assert.equal((await journal.completeStagedTrade("lp", { callsId: CALLS_ID }, { state: "COMMITTED", txHash: TX })).applied, false);
    await journal.close();
  });

  it(`${backend.name}: competing terminal hash wins before staged completion`, async () => {
    const journal = await backend.create();
    await begin(journal, "race");
    await journal.markInProgress("race", { callsId: CALLS_ID });
    await journal.markCommitted("race", { txHash: OTHER_TX });
    const completed = await journal.completeStagedTrade("race", { callsId: CALLS_ID }, { state: "COMMITTED", txHash: TX });
    assert.equal(completed.applied, false);
    assert.equal(completed.entry.externalRef.txHash, OTHER_TX);
    await journal.close();
  });
}

it("J3 prepared constraint migration scopes catalog, locks and widens both arms", () => {
  const source = readFileSync(new URL("../src/store/journal.ts", import.meta.url), "utf8");
  const ddl = source.split("const JOURNAL_PREPARED_BINDING_CHECK_DDL = `")[1]?.split("`;", 1)[0];
  assert.ok(ddl);
  assert.match(ddl, /pg_advisory_xact_lock/u);
  assert.equal((ddl.match(/conrelid = 'execution_journal'::regclass/gu) ?? []).length, 2);
  assert.equal((ddl.match(/kind in \('lp', 'trade'\)/gu) ?? []).length, 4);
  assert.match(ddl, /drop constraint execution_journal_prepared_binding_check/u);
});

it("R4.5 d2 serialized SQL bind holds the lock while reconciliation waits", async () => {
  const inner = new FakeSqlClient();
  let enteredBind: () => void = () => {};
  let releaseBind: () => void = () => {};
  const bindEntered = new Promise<void>((resolve) => { enteredBind = resolve; });
  const bindHeld = new Promise<void>((resolve) => { releaseBind = resolve; });
  const wrapped: SqlClient = {
    async query<R = Record<string, unknown>>(query: string, params: readonly unknown[] = []): Promise<SqlResult<R>> {
      const result = await inner.query<R>(query, params);
      if (query.includes("journal.bindPreparedUpdate")) { enteredBind(); await bindHeld; }
      return result;
    },
    transaction: (work) => inner.transaction(async () => work(wrapped)),
    close: () => inner.close(),
  };
  const journal = await PostgresExecutionJournal.create(wrapped);
  await begin(journal, "d2");
  const binding = journal.bindPreparedIntent("d2", { canonicalIdentity: identity.canonical,
    identityHash: identity.hash, expectedBindingVersion: 0 });
  await bindEntered;
  let reconciled = false;
  const reconcile = journal.markUnknown("d2", "stale snapshot").then(() => { reconciled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reconciled, false);
  releaseBind();
  assert.equal((await binding).boundBindingVersion, 1);
  await reconcile;
  assert.equal((await journal.get("d2"))?.state, "UNKNOWN");
  assert.equal((await journal.get("d2"))?.preparedIntentIdentity, identity.canonical);
  await journal.close();
});

it("J3 isolated PostgreSQL installs, replaces and preserves the prepared CHECK across concurrent boots", { timeout: 120_000 }, async (t) => {
  const cluster = await localPostgres();
  if (cluster === null) { t.skip("PostgreSQL 17 binaries unavailable; no external database fallback"); return; }
  const sql = await createPgSqlClient(cluster.url);
  const second = await createPgSqlClient(cluster.url);
  t.after(async () => { await sql.close(); await second.close(); await cluster.close(); });
  const definition = async () => (await sql.query<{ readonly def: string }>(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conname='execution_journal_prepared_binding_check' and conrelid='execution_journal'::regclass"
  )).rows[0]?.def;
  await PostgresExecutionJournal.create(sql);
  assert.match(await definition() ?? "", /trade/u);
  await sql.query("alter table execution_journal drop constraint execution_journal_prepared_binding_check");
  await sql.query(`alter table execution_journal add constraint execution_journal_prepared_binding_check check (
    prepared_binding_version >= 0 and
    ((final_calls_fingerprint is null and final_calls_fingerprint_hash is null) or
     (kind = 'lp' and final_calls_fingerprint is not null and final_calls_fingerprint_hash ~ '^0x[0-9a-f]{64}$')) and
    ((prepared_intent_identity is null and prepared_intent_identity_hash is null) or
     (kind = 'lp' and prepared_intent_identity is not null and prepared_intent_identity_hash ~ '^0x[0-9a-f]{64}$'))
  )`);
  assert.doesNotMatch(await definition() ?? "", /trade/u);
  await Promise.all([PostgresExecutionJournal.create(sql), PostgresExecutionJournal.create(second)]);
  const widened = await definition();
  assert.match(widened ?? "", /trade/u);
  await PostgresExecutionJournal.create(sql);
  assert.equal(await definition(), widened);
  const olderBuildDdl = `do $journal_prepared_binding$ begin
    if not exists (select 1 from pg_constraint where conname = 'execution_journal_prepared_binding_check') then
      alter table execution_journal add constraint execution_journal_prepared_binding_check check (
        prepared_binding_version >= 0 and
        ((final_calls_fingerprint is null and final_calls_fingerprint_hash is null) or
         (kind = 'lp' and final_calls_fingerprint is not null and final_calls_fingerprint_hash ~ '^0x[0-9a-f]{64}$')) and
        ((prepared_intent_identity is null and prepared_intent_identity_hash is null) or
         (kind = 'lp' and prepared_intent_identity is not null and prepared_intent_identity_hash ~ '^0x[0-9a-f]{64}$'))
      );
    end if;
  end $journal_prepared_binding$`;
  await sql.query(olderBuildDdl);
  assert.equal(await definition(), widened);
  await sql.query("alter table execution_journal drop constraint execution_journal_prepared_binding_check");
  await sql.query("create table prepared_collision (id integer constraint execution_journal_prepared_binding_check check (id > 0))");
  await PostgresExecutionJournal.create(sql);
  assert.match(await definition() ?? "", /trade/u);
});
