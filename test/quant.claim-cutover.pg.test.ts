/**
 * G4 claim cutover against databases created inside this test's own temporary initdb cluster.
 * Nothing here reads DATABASE_URL, an env file, or any database that this file did not create.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { getAddress, type Hex } from "viem";
import { localPostgres } from "./support/localPostgres.js";
import {
  applyCutover, GRID_LEGACY_CONTRACT, parseCutoverArgs, readInventory, runCensus, runPlanCheck, stableCensusDigest, terminateBackend,
  type CutoverHooks, type CutoverOutcome, type CutoverPlan,
} from "../scripts/quant-claim-cutover.js";
import { parseQuantRebalanceOperatorArgs } from "../src/quant/rebalanceOperatorCli.js";
import { withQuantRebalanceCensusSnapshot } from "../src/quant/rebalanceCensusReaders.js";
import { createPgSqlClient, type SqlClient, type SqlQueryOptions, type SqlResult } from "../src/store/sql.js";
import { PostgresQuantJobStore } from "../src/store/quantJobs.js";
import { PostgresExecutionJournal } from "../src/store/journal.js";
import { PostgresQuantRebalanceStore } from "../src/store/quantRebalance.js";
import { PostgresQuantWalletClaimStore, QUANT_WALLET_CLAIMS_DDL } from "../src/store/quantWalletClaims.js";
import {
  acquireWorkerSingleton, type WorkerLockClient, type WorkerSingletonRole,
} from "../src/deployment/workerSingleton.js";

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const W3 = "0x3333333333333333333333333333333333333333";

/* ----------------------------- seeding helpers ----------------------------- */

async function job(sql: SqlClient, id: string, wallet: string, status: string, admitted: boolean, strategy = "strategy-1"): Promise<void> {
  await sql.query(`insert into quant_jobs (quant_job_id, strategy_id, trading_wallet, status, admitted_at_ms, created_at_ms, updated_at_ms, row_version)
    values ($1, $2, $3, $4, $5, 1000, 1000, 4)`, [id, strategy, wallet, status, admitted ? 2000 : null]);
  await sql.query(`insert into quant_levels (quant_job_id, level_index, state, buy_price_e18, sell_price_e18)
    values ($1, 0, 'armed-quote', 1000, 2000), ($1, 1, 'armed-quote', 3000, 4000)`, [id]);
}
/** A well-formed 32-byte transaction hash derived from a label. */
const hashOf = (label: string) => `0x${Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64)}`;
async function action(sql: SqlClient, jobId: string, key: string, state: string, txHash: string | null = null): Promise<void> {
  await sql.query(`insert into quant_actions (journal_key, quant_job_id, level_index, action_seq, side, state, prior_level_state,
    amount_in_wei, min_out_wei, quote_out_wei, quote_block, trigger_block_1, trigger_block_2, deadline_sec, calls_json, note, created_at_ms, updated_at_ms, tx_hash)
    values ($1, $2, 0, 1, 'buy', $3, 'armed-quote', 1, 1, 1, 1, 1, 1, 1, '[]', '', 1, 1, $4)`, [key, jobId, state, txHash]);
}
/** `callsId` is the relay call id a reported failed submission may leave in a ROLLED_BACK journal. */
async function journal(sql: SqlClient, key: string, agentId: string, state: string, txHash: string | null, callsId?: string): Promise<void> {
  await sql.query(`insert into execution_journal (idempotency_key, agent_id, owner_address, kind, state, external_ref)
    values ($1, $2, $3, 'quantTrade', $4, $5::jsonb)`, [key, agentId, W1, state,
    JSON.stringify({ ...(txHash === null ? {} : { txHash }), ...(callsId === undefined ? {} : { callsId }) })]);
}
async function owner(sql: SqlClient, txHash: string, wallet: string, key: string, logIndex = 3): Promise<void> {
  await sql.query(`insert into quant_receipt_ownership (tx_hash, trading_wallet, swap_log_index, journal_key, created_at_ms) values ($1, $2, $3, $4, 1)`, [txHash, wallet, logIndex, key]);
}
/** The pair `settleAction` produces: a settled action carrying the hash, its COMMITTED journal, and one receipt owner. */
async function settled(sql: SqlClient, jobId: string, key: string, wallet: string): Promise<void> {
  await action(sql, jobId, key, "settled", hashOf(key));
  await journal(sql, key, jobId, "COMMITTED", hashOf(key));
  await owner(sql, hashOf(key), wallet, key);
}
/** The pair Grid recovery leaves for a COMMITTED journal without a hash (`COMMITTED-hash/found`): the journal keeps none. */
async function recovered(sql: SqlClient, jobId: string, key: string, wallet: string): Promise<void> {
  await action(sql, jobId, key, "settled", hashOf(key));
  await journal(sql, key, jobId, "COMMITTED", null, hashOf(`${key}-calls`));
  await owner(sql, hashOf(key), wallet, key);
}

/** The evidence the R14.5 door persists; the cutover reads only `v`, `kind` and `finalizedTimestampSec` (past `action()`'s deadline of 1). */
const doorEvidence = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, kind: "not-executed", finalizedBlock: "100", finalizedTimestampSec: "1790218500", deadlineSec: 1, ...over });
/**
 * The pair `live-quant resolve --not-executed` leaves, written by the real store method: the action fails as
 * `not-executed-proven` with the evidence, its level is restored, and the journal row stays UNKNOWN without a hash.
 */
async function notExecuted(sql: SqlClient, jobId: string, key: string, resolutionJson = doorEvidence()): Promise<void> {
  await action(sql, jobId, key, "unknown");
  await journal(sql, key, jobId, "UNKNOWN", null);
  await sql.query(`update quant_levels set state = 'blocked' where quant_job_id = $1 and level_index = 0`, [jobId]);
  const store = await PostgresQuantJobStore.create(sql);
  const level = (await store.listLevels(jobId))[0]!;
  const row = (await store.getAction(key))!;
  const door = await store.resolveNotExecuted({ journalKey: key, expectedActionRowVersion: row.rowVersion,
    expectedLevelRowVersion: level.rowVersion, expectedLadderGen: level.ladderGen, resolutionJson, nowMs: 5 });
  assert.equal(door.kind, "ok");
  await sql.query("alter table quant_jobs drop column claim_generation"); // a legacy database has none; create() re-adds it
}

/** Current schema of the Grid store and the journal, minus the claim column, as a legacy production database has it. */
async function seedLegacySchema(sql: SqlClient): Promise<void> {
  await PostgresQuantJobStore.create(sql);
  await PostgresExecutionJournal.create(sql);
  await sql.query("alter table quant_jobs drop column claim_generation");
}

/* ------------------------------- test seams -------------------------------- */

type Intercept = {
  readonly before?: (text: string, tx: SqlClient) => Promise<void> | void;
  readonly after?: (text: string, tx: SqlClient) => Promise<void> | void;
};
/** Wraps the statement client of the pinned transaction; `tx` handed to a hook is the unwrapped connection. */
const intercept = (hooks: Intercept) => (tx: SqlClient): SqlClient => {
  const wrapped: SqlClient = {
    ...(tx.transactionScope === undefined ? {} : { transactionScope: tx.transactionScope }),
    query: async <Row>(text: string, params?: readonly unknown[], options?: SqlQueryOptions): Promise<SqlResult<Row>> => {
      await hooks.before?.(text, tx);
      const result = await tx.query<Row>(text, params, options);
      await hooks.after?.(text, tx);
      return result;
    },
    transaction: (fn) => fn(wrapped),
    close: async () => undefined,
  };
  return wrapped;
};

class FakeLockClient implements WorkerLockClient {
  readonly #errors: (() => void)[] = [];
  async connect(): Promise<void> {}
  async query(_text: string, _values: readonly number[]) { return { rows: [{ locked: true, unlocked: true }] }; }
  on(event: "error" | "end", listener: (() => void) | ((error: Error) => void)): this { if (event === "error") this.#errors.push(listener as () => void); return this; }
  async end(): Promise<void> {}
  lose(): void { for (const listener of this.#errors) listener(); }
}
function fakeBarriers() {
  const clients: FakeLockClient[] = [];
  const acquire: NonNullable<CutoverHooks["acquire"]> = (input) => acquireWorkerSingleton({ ...input, dependencies: {
    createClient: () => { const client = new FakeLockClient(); clients.push(client); return client; },
    terminate: () => undefined, reportFatal: () => undefined, schedule: () => undefined, markNonzero: () => undefined } });
  return { acquire, lose: (index: number) => clients[index]!.lose() };
}

/* --------------------------------- the suite -------------------------------- */

test("claim cutover: census, plan-check and apply on isolated databases", { timeout: 600_000 }, async (t) => {
  const cluster = await localPostgres();
  if (cluster === null) { t.skip("PostgreSQL 17 binaries are unavailable; DATABASE_URL is never read"); return; }
  const pools: SqlClient[] = [];
  const admin = await createPgSqlClient(cluster.url); pools.push(admin);
  const urlOf = (name: string) => cluster.url.replace(/\/postgres$/u, `/${name}`);
  let counter = 0;
  const open = async (url: string) => { const sql = await createPgSqlClient(url); pools.push(sql); return sql; };
  try {
    await admin.query("create database cutover_template");
    const template = await createPgSqlClient(urlOf("cutover_template"));
    await seedLegacySchema(template); await template.close();

    await t.test("the pinned Grid legacy contract equals the schema the store builds, so it cannot drift", async () => {
      await admin.query("create database contract_probe");
      const sql = await open(urlOf("contract_probe"));
      await PostgresQuantJobStore.create(sql); await PostgresExecutionJournal.create(sql);
      const built = await withQuantRebalanceCensusSnapshot(sql, readInventory);
      const fromStore = [...built].filter(([table]) => table !== "execution_journal")
        .map(([table, columns]) => [table, columns.filter((column) => column !== "claim_generation")] as const).sort(([a], [b]) => a < b ? -1 : 1);
      const pinned = Object.entries(GRID_LEGACY_CONTRACT).map(([table, columns]) => [table, [...columns]] as const).sort(([a], [b]) => a < b ? -1 : 1);
      assert.deepEqual(fromStore, pinned);
      assert.ok(built.get("quant_jobs")?.includes("claim_generation"), "the one column a legacy database may lack");
      assert.ok(!GRID_LEGACY_CONTRACT["quant_jobs"]!.includes("claim_generation"));
    });

    /** A fresh legacy database; `seed` populates it. */
    const legacy = async (seed?: (sql: SqlClient) => Promise<void>) => {
      const name = `cutover_${counter += 1}`;
      await admin.query(`create database ${name} template cutover_template`);
      const sql = await open(urlOf(name));
      if (seed !== undefined) await seed(sql);
      return { url: urlOf(name), sql };
    };
    const report = async (sql: SqlClient) => await runCensus(sql) as unknown as { digest: Hex; draftPlan: CutoverPlan; unresolved: string[];
      wallets: { wallet: string; jobs: { jobId: string; persistedClaimGeneration: string | null }[] }[]; schema: { supported: boolean; reasons: string[] } };
    const snapshot = (sql: SqlClient) => withQuantRebalanceCensusSnapshot(sql, async (tx) => {
      const inventory = await readInventory(tx);
      return { inventory: JSON.stringify([...inventory]), digest: await stableCensusDigest(tx, inventory) };
    });
    const chosen = (plan: CutoverPlan, wallet: string, holder: string): CutoverPlan => ({ ...plan, groups: plan.groups.map((group) => {
      if (group.wallet !== wallet) return group;
      const all = [...group.excludedJobIds, group.holderJobId].filter((id) => id !== "CHOOSE");
      return { wallet, holderJobId: holder, excludedJobIds: all.filter((id) => id !== holder) };
    }) });
    const dump = async (sql: SqlClient, id: string) => JSON.stringify((await sql.query(
      `select to_jsonb(t) - 'claim_generation' as row from quant_jobs t where quant_job_id = $1`, [id])).rows[0]);
    const refusedWith = (outcome: CutoverOutcome, code: string, detail?: RegExp) => {
      assert.equal(outcome.kind, "refused", JSON.stringify(outcome));
      if (outcome.kind !== "refused") return;
      assert.equal(outcome.code, code);
      if (detail !== undefined) assert.ok(outcome.details.some((reason) => detail.test(reason)), outcome.details.join(","));
    };
    const untouched = async (sql: SqlClient, before: Awaited<ReturnType<typeof snapshot>>) => {
      assert.deepEqual(await snapshot(sql), before);
      assert.equal((await sql.query(`select to_regclass('public.quant_wallet_claims') as a, to_regclass('public.quant_wallet_claim_migration') as b`)).rows[0]?.["a"], null);
    };
    /** The standard populated database: W1 has one admitted job, W2 three jobs of which one is discovered. */
    const populated = () => legacy(async (sql) => {
      await job(sql, "j1", W1, "armed", true);
      await settled(sql, "j1", "k1", W1);
      await recovered(sql, "j1", "k5", W1); // recovery settled it from the relay's hash
      await action(sql, "j1", "k2", "failed"); await journal(sql, "k2", "j1", "ROLLED_BACK", null, hashOf("k2-calls")); // relay reported FAILED, call id kept
      await action(sql, "j1", "k3", "failed"); // refused before the journal began (session-not-admissible, store-conflict)
      await action(sql, "j1", "k4", "aborted"); await journal(sql, "k4", "j1", "ROLLED_BACK", null); // never submitted
      await job(sql, "j2a", W2, "held", true);
      await job(sql, "j2b", W2, "armed", true);
      await job(sql, "j2c", W2, "discovered", false);
      await job(sql, "old", W3, "reported", true);
      await sql.query(`insert into quant_jobs (quant_job_id, status, created_at_ms, updated_at_ms) values ('walletless', 'discovered', 1, 1)`);
    });

    await t.test("an empty legacy database installs with an empty plan, and both daemons' gates then pass", async () => {
      const { url, sql } = await legacy();
      const before = await report(sql);
      assert.equal(before.schema.supported, true);
      assert.deepEqual(before.draftPlan.groups, []);
      const plan = { version: 1, censusDigest: before.digest, groups: [] };
      const check = await runPlanCheck(sql, plan);
      assert.equal(check["ok"], true, JSON.stringify(check));
      const outcome = await applyCutover({ databaseUrl: url, plan });
      assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
      const claims = new PostgresQuantWalletClaimStore(sql);
      assert.equal(await claims.schemaInstalled(), true);
      assert.equal(await claims.migrationInstalled(), true);
      const marker = (await sql.query(`select * from quant_wallet_claim_migration`)).rows;
      assert.equal(marker.length, 1);
      assert.equal(marker[0]?.["installed_by"], "production-cutover-v1");
      assert.equal(marker[0]?.["census_digest"], before.digest);
      assert.match(String(marker[0]?.["disposition_digest"]), /^0x[0-9a-f]{64}$/u);
      assert.ok(Number(marker[0]?.["installed_at_ms"]) > 0);
      // The rebalance daemon's read-only runtime gate.
      const present = (await sql.query(`select to_regclass('public.quant_jobs') is not null and to_regclass('public.quant_epochs') is not null
        and to_regclass('public.quant_actions') is not null and to_regclass('public.quant_rebalance_jobs') is not null
        and to_regclass('public.quant_rebalance_checks') is not null and to_regclass('public.quant_rebalance_actions') is not null
        and to_regclass('public.quant_receipt_ownership') is not null and to_regclass('public.execution_journal') is not null as ready`)).rows[0];
      assert.equal(present?.["ready"], true);
      assert.equal(await new PostgresQuantRebalanceStore(sql).schemaReady(), true);
      await PostgresExecutionJournal.attachExisting(sql);
      // Already migrated: a second run refuses and changes nothing.
      const again = await applyCutover({ databaseUrl: url, plan });
      refusedWith(again, "plan-refused", /claim-schema-present/u);
    });

    await t.test("one admitted Grid holder gets one ACTIVE claim; everything else is untouched", async () => {
      const { url, sql } = await populated();
      const before = await report(sql);
      const w1 = before.draftPlan.groups.find((group) => group.wallet === W1);
      assert.deepEqual(w1, { wallet: W1, holderJobId: "j1", excludedJobIds: [] });
      assert.equal(before.draftPlan.groups.find((group) => group.wallet === W3), undefined, "a reported-only wallet needs no group");
      const plan = chosen(before.draftPlan, W2, "j2b");
      const originals = Object.fromEntries(await Promise.all(["j1", "j2a", "j2b", "j2c", "old", "walletless"].map(async (id) => [id, await dump(sql, id)])));
      const versionBefore = Number((await sql.query(`select row_version from quant_jobs where quant_job_id = 'j1'`)).rows[0]?.["row_version"]);
      const pre = await snapshot(sql);
      // Inside the transaction, after the additive schema and before the first holder write, the original digest domain
      // reconstructed from the frozen inventory equals the plan digest although the inventory has grown.
      const original = new Map(JSON.parse(pre.inventory) as [string, string[]][]);
      let acrossSchema: { digest: Hex; grew: boolean } | null = null;
      const outcome = await applyCutover({ databaseUrl: url, plan, hooks: { wrapTx: intercept({
        before: async (text, tx) => { if (acrossSchema === null && /insert into quant_wallet_claims/u.test(text)) acrossSchema = {
          digest: await stableCensusDigest(tx, original), grew: (await readInventory(tx)).size > original.size }; } }) } });
      assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
      assert.deepEqual(acrossSchema, { digest: before.digest, grew: true });
      const claims = new PostgresQuantWalletClaimStore(sql);
      // The Grid daemon gate (schemaInstalled and migrationInstalled) and the rebalance schema gate pass on this populated database too.
      assert.equal(await claims.schemaInstalled(), true);
      assert.equal(await claims.migrationInstalled(), true);
      assert.equal(await new PostgresQuantRebalanceStore(sql).schemaReady(), true);
      const rows = await claims.list();
      assert.deepEqual(rows.map((row) => [row.wallet.toLowerCase(), row.mode, row.strategyKind, row.strategyId, row.jobId, row.generation, row.rowVersion, row.attemptId]).sort(),
        [[W1, "active", "grid", "strategy-1", "j1", 1n, 1, null], [W2, "active", "grid", "strategy-1", "j2b", 1n, 1, null]]);
      const j1 = (await sql.query(`select claim_generation::text as g, row_version from quant_jobs where quant_job_id = 'j1'`)).rows[0];
      assert.equal(j1?.["g"], "1"); assert.equal(Number(j1?.["row_version"]), versionBefore + 1);
      // Every other job, level, action, journal and ownership row is byte-identical; the digest domain is unchanged by the additions.
      for (const id of ["j2a", "j2c", "old", "walletless"]) assert.equal(await dump(sql, id), originals[id], id);
      assert.equal((await sql.query(`select count(*)::int as n from quant_jobs where claim_generation is not null`)).rows[0]?.["n"], 2);
      // The Grid claim predicate (worker.ts, the gate before observation and planning) admits holders only.
      const gate = async (id: string, wallet: string) => {
        const g = (await sql.query(`select claim_generation::text as g from quant_jobs where quant_job_id = $1`, [id])).rows[0]?.["g"];
        return g !== null && g !== undefined && await claims.isActive({ wallet: getAddress(wallet), strategyKind: "grid", strategyId: "strategy-1", jobId: id, generation: BigInt(String(g)) });
      };
      assert.equal(await gate("j1", W1), true);
      assert.equal(await gate("j2b", W2), true);
      assert.equal(await gate("j2a", W2), false, "a re-armed excluded job holds claim-inconsistent");
      assert.equal(await gate("j2c", W2), false);
      // A rebalance claim on a held wallet is refused; a free wallet is unaffected.
      const attempt = (wallet: string, jobId: string) => claims.claimProvisional({ wallet: getAddress(wallet), strategyKind: "rebalance",
        strategyId: "rb", jobId, attemptId: `attempt-${jobId}`, nowMs: Date.now() });
      assert.equal((await attempt(W1, "rb-1")).kind, "held");
      assert.equal((await attempt(W2, "rb-2")).kind, "held");
      assert.equal((await attempt(W3, "rb-3")).kind, "acquired");
      // The census after the install shows the marker, the claims and the untouched exclusions.
      const after = await report(sql);
      const markers = (after as unknown as { marker: Record<string, unknown>[] }).marker;
      assert.equal(markers.length, 1);
      assert.equal(markers[0]?.["installed_by"], "production-cutover-v1");
      assert.equal(markers[0]?.["census_digest"], before.digest);
      const w2 = after.wallets.find((wallet) => wallet.wallet === W2)!;
      assert.deepEqual(w2.jobs.map((entry) => [entry.jobId, entry.persistedClaimGeneration]).sort(), [["j2a", null], ["j2b", "1"], ["j2c", null]]);
      assert.equal(pre.digest, before.digest);
    });

    await t.test("holder selection: an unadmitted holder is refused with zero writes, then the admitted one applies; paused holders keep the claim", async () => {
      const { url, sql } = await legacy(async (seed) => {
        await job(seed, "a", W1, "held", true); await job(seed, "b", W1, "armed", true);
        await job(seed, "c", W1, "armed", true); await job(seed, "d", W1, "discovered", false);
        await job(seed, "e", W2, "paused", true); await job(seed, "f", W2, "discovered", false);
      });
      const before = await snapshot(sql);
      const draft = (await report(sql)).draftPlan;
      const w1 = draft.groups.find((group) => group.wallet === W1)!;
      assert.equal(w1.holderJobId, "CHOOSE");
      assert.deepEqual(w1.excludedJobIds, ["a", "b", "c", "d"]);
      const start = chosen(chosen(draft, W1, "d"), W2, "e");
      const discovered = await runPlanCheck(sql, start);
      assert.equal(discovered["ok"], false);
      assert.ok((discovered["reasons"] as string[]).includes(`holder-unadmitted:${W1}`));
      refusedWith(await applyCutover({ databaseUrl: url, plan: start }), "plan-refused", /holder-unadmitted/u);
      await untouched(sql, before);
      const unadmitted = chosen(chosen(draft, W1, "f"), W2, "e");
      assert.ok(((await runPlanCheck(sql, unadmitted))["reasons"] as string[]).includes(`holder-invalid:${W1}`), "a holder from another wallet is invalid");
      const good = chosen(chosen(draft, W1, "c"), W2, "e");
      const outcome = await applyCutover({ databaseUrl: url, plan: good });
      assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
      const rows = await new PostgresQuantWalletClaimStore(sql).list();
      assert.deepEqual(rows.map((row) => [row.wallet.toLowerCase(), row.jobId, row.mode]).sort(), [[W1, "c", "active"], [W2, "e", "active"]]);
      assert.equal((await sql.query(`select count(*)::int as n from quant_jobs where claim_generation is not null`)).rows[0]?.["n"], 2);
    });

    await t.test("every plan-check refusal", async () => {
      const { url, sql } = await populated();
      const before = await snapshot(sql);
      const draft = (await report(sql)).draftPlan;
      const good = chosen(draft, W2, "j2b");
      assert.equal((await runPlanCheck(sql, good))["ok"], true);
      const reasons = async (plan: unknown) => (await runPlanCheck(sql, plan))["reasons"] as string[];
      const has = async (plan: unknown, prefix: string) => assert.ok((await reasons(plan)).some((reason) => reason.startsWith(prefix)), `${prefix} in ${JSON.stringify(await reasons(plan))}`);
      await has({ ...good, groups: good.groups.filter((group) => group.wallet !== W2) }, `group-missing:${W2}`);
      await has({ ...good, groups: [...good.groups, { wallet: W3, holderJobId: "old", excludedJobIds: [] }] }, `group-extra:${W3}`);
      await has({ ...good, groups: [...good.groups, good.groups[0]!] }, "group-duplicate:");
      await has(draft, `holder-invalid:${W2}`);
      await has({ ...good, groups: good.groups.map((group) => group.wallet === W2 ? { ...group, holderJobId: "nope" } : group) }, `holder-invalid:${W2}`);
      await has({ ...good, groups: good.groups.map((group) => group.wallet === W2 ? { ...group, excludedJobIds: ["j2a"] } : group) }, `excluded-mismatch:${W2}`);
      await has({ ...good, groups: good.groups.map((group) => group.wallet === W2 ? { ...group, excludedJobIds: ["j2a", "j2c", "j1"] } : group) }, `excluded-mismatch:${W2}`);
      await has({ ...good, censusDigest: `0x${"11".repeat(32)}` }, "census-digest-mismatch");
      assert.deepEqual(await reasons({ ...good, extra: true }), ["plan-invalid"]);
      assert.deepEqual(await reasons({ version: 2, censusDigest: good.censusDigest, groups: [] }), ["plan-invalid"]);
      for (const plan of [{ ...good, groups: good.groups.filter((group) => group.wallet !== W2) }, draft]) {
        assert.equal((await applyCutover({ databaseUrl: url, plan })).kind, "refused");
      }
      await untouched(sql, before);
    });

    await t.test("the pair the R14.5 not-executed door leaves is accepted, and its job applies as the holder", async () => {
      const { url, sql } = await populated();
      await notExecuted(sql, "j1", "n0");
      const rows = () => sql.query(`select to_jsonb(a) as row, (select to_jsonb(j) from execution_journal j where j.idempotency_key = 'n0') as journal
        from quant_actions a where journal_key = 'n0'`);
      const door = (await rows()).rows[0] as { row: Record<string, unknown>; journal: Record<string, unknown> };
      assert.equal(door.row["state"], "failed"); assert.equal(door.row["failure_code"], "not-executed-proven");
      assert.equal(door.journal["state"], "UNKNOWN");
      const before = await report(sql);
      assert.deepEqual(before.unresolved, []);
      assert.deepEqual(before.draftPlan.groups.find((group) => group.wallet === W1), { wallet: W1, holderJobId: "j1", excludedJobIds: [] });
      const plan = chosen(before.draftPlan, W2, "j2b");
      assert.equal((await runPlanCheck(sql, plan))["ok"], true);
      const outcome = await applyCutover({ databaseUrl: url, plan });
      assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
      assert.deepEqual((await new PostgresQuantWalletClaimStore(sql).list()).map((row) => [row.wallet.toLowerCase(), row.jobId, row.mode]).sort(),
        [[W1, "j1", "active"], [W2, "j2b", "active"]]);
      assert.deepEqual((await rows()).rows[0], door, "the action and its UNKNOWN journal are not touched");
      // The numeric form of the finalized time is read the same way.
      const numeric = await populated();
      await notExecuted(numeric.sql, "j1", "n0", doorEvidence({ finalizedTimestampSec: 1790218500 }));
      assert.deepEqual((await report(numeric.sql)).unresolved, []);
    });

    await t.test("unresolved Grid work refuses independently of job status, join, or how it is linked", async () => {
      const scenarios: readonly (readonly [string, (sql: SqlClient) => Promise<void>, RegExp])[] = [
        ...["intended", "submitted", "committed-unverified", "unknown", "needs-operator"].map((state) => [`${state} action`,
          async (sql: SqlClient) => { await action(sql, "j1", `u-${state}`, state); }, new RegExp(`action-unresolved:j1:u-${state}:${state}`, "u")] as const),
        ["an unresolved action on a reported job", async (sql) => { await action(sql, "old", "u-old", "unknown"); }, /action-unresolved:old/u],
        ["an orphan UNKNOWN journal", async (sql) => { await journal(sql, "o1", "no-such-job", "UNKNOWN", null); }, /journal-unresolved:no-such-job:o1:UNKNOWN/u],
        ["an orphan IN_PROGRESS journal", async (sql) => { await journal(sql, "o2", "no-such-job", "IN_PROGRESS", null); }, /journal-unresolved:no-such-job:o2:IN_PROGRESS/u],
        ["an orphan PENDING journal", async (sql) => { await journal(sql, "o3", "j1", "PENDING", null); }, /journal-unresolved:j1:o3:PENDING/u],
        ["a COMMITTED journal without a transaction", async (sql) => { await journal(sql, "o4", "j1", "COMMITTED", null); }, /journal-unresolved:j1:o4:COMMITTED/u],
        ["an UNKNOWN journal linked to an aborted action", async (sql) => { await action(sql, "j1", "o5", "aborted"); await journal(sql, "o5", "j1", "UNKNOWN", null); }, /journal-unresolved:j1:o5:UNKNOWN/u],
        ["a settled action whose journal is missing", async (sql) => { await action(sql, "j1", "o6", "settled", hashOf("o6")); await owner(sql, hashOf("o6"), W1, "o6"); }, /settled-action-evidence-mismatch:j1:o6/u],
        // Audit finding 3: definitive-looking but contradictory or unattributed evidence.
        ["an orphan COMMITTED journal that names a transaction", async (sql) => { await journal(sql, "o7", "no-such-job", "COMMITTED", hashOf("o7")); }, /journal-orphan:no-such-job:o7:COMMITTED/u],
        ["an orphan ROLLED_BACK journal", async (sql) => { await journal(sql, "o7r", "j1", "ROLLED_BACK", null); }, /journal-orphan:j1:o7r:ROLLED_BACK/u],
        ["a settled action whose journal names another transaction", async (sql) => {
          await action(sql, "j1", "o8", "settled", hashOf("o8a")); await journal(sql, "o8", "j1", "COMMITTED", hashOf("o8b")); await owner(sql, hashOf("o8a"), W1, "o8"); },
        /settled-action-evidence-mismatch:j1:o8/u],
        ["a settled action without receipt ownership", async (sql) => { await action(sql, "j1", "o9", "settled", hashOf("o9")); await journal(sql, "o9", "j1", "COMMITTED", hashOf("o9")); },
          /settled-action-evidence-mismatch:j1:o9/u],
        ["a settled action whose owner is another wallet", async (sql) => {
          await action(sql, "j1", "o10", "settled", hashOf("o10")); await journal(sql, "o10", "j1", "COMMITTED", hashOf("o10")); await owner(sql, hashOf("o10"), W3, "o10"); },
        /settled-action-evidence-mismatch:j1:o10/u],
        ["a settled action whose owner names another transaction", async (sql) => {
          await action(sql, "j1", "o11", "settled", hashOf("o11")); await journal(sql, "o11", "j1", "COMMITTED", hashOf("o11")); await owner(sql, hashOf("o11x"), W1, "o11"); },
        /settled-action-evidence-mismatch:j1:o11/u],
        ["a settled action without a transaction hash", async (sql) => {
          await action(sql, "j1", "o12", "settled"); await journal(sql, "o12", "j1", "COMMITTED", hashOf("o12")); await owner(sql, hashOf("o12"), W1, "o12"); },
        /settled-action-evidence-mismatch:j1:o12/u],
        ["a journal that belongs to another job", async (sql) => {
          await action(sql, "j1", "o13", "settled", hashOf("o13")); await journal(sql, "o13", "j2a", "COMMITTED", hashOf("o13")); await owner(sql, hashOf("o13"), W1, "o13"); },
        /journal-attribution-mismatch:j1:o13/u],
        ["invalid transaction evidence", async (sql) => {
          await action(sql, "j1", "o14", "settled", "0x1234"); await journal(sql, "o14", "j1", "COMMITTED", "0x1234"); await owner(sql, "0x1234", W1, "o14"); },
        /settled-action-evidence-mismatch:j1:o14/u],
        ["a failed action paired with a COMMITTED journal", async (sql) => { await action(sql, "j1", "o15", "failed"); await journal(sql, "o15", "j1", "COMMITTED", hashOf("o15")); },
          /terminal-action-with-committed-evidence:j1:o15:failed/u],
        ["an aborted action paired with a COMMITTED journal", async (sql) => { await action(sql, "j1", "o16", "aborted"); await journal(sql, "o16", "j1", "COMMITTED", hashOf("o16")); },
          /terminal-action-with-committed-evidence:j1:o16:aborted/u],
        ["a failed action that carries a transaction hash", async (sql) => { await action(sql, "j1", "o17", "failed", hashOf("o17")); },
          /terminal-action-with-committed-evidence:j1:o17:failed/u],
        ["an aborted action with a receipt owner", async (sql) => { await action(sql, "j1", "o18", "aborted"); await owner(sql, hashOf("o18"), W1, "o18"); },
          /terminal-action-with-committed-evidence:j1:o18:aborted/u],
        ["a receipt owner with no action", async (sql) => { await owner(sql, hashOf("o19"), W1, "ghost"); }, /receipt-ownership-unattributed:ghost/u],
        // Fix audit round 2: every owner row is judged against its own action and a good row masks no extra one.
        ["a settled action with a second owner that names another transaction", async (sql) => {
          await settled(sql, "j1", "o20", W1); await owner(sql, hashOf("o20x"), W1, "o20", 4); }, /settled-action-evidence-mismatch:j1:o20/u],
        ["that extra owner is reported as unattributed", async (sql) => {
          await settled(sql, "j1", "o20", W1); await owner(sql, hashOf("o20x"), W1, "o20", 4); }, /receipt-ownership-unattributed:o20/u],
        ["a settled action with a second owner in another wallet", async (sql) => {
          await settled(sql, "j1", "o21", W1); await owner(sql, hashOf("o21"), W3, "o21", 4); }, /settled-action-evidence-mismatch:j1:o21/u],
        ["a settled action with a second owner row for the same transaction and wallet", async (sql) => {
          await settled(sql, "j1", "o22", W1); await owner(sql, hashOf("o22"), W1, "o22", 4); }, /settled-action-evidence-mismatch:j1:o22/u],
        ["a failed action paired with a ROLLED_BACK journal that names a transaction", async (sql) => {
          await action(sql, "j1", "o23", "failed"); await journal(sql, "o23", "j1", "ROLLED_BACK", hashOf("o23")); }, /terminal-action-with-committed-evidence:j1:o23:failed/u],
        ["an aborted action paired with a ROLLED_BACK journal that names a transaction", async (sql) => {
          await action(sql, "j1", "o24", "aborted"); await journal(sql, "o24", "j1", "ROLLED_BACK", hashOf("o24"), hashOf("o24-calls")); }, /terminal-action-with-committed-evidence:j1:o24:aborted/u],
        // The recovered COMMITTED-without-hash state is accepted only with the rest of its evidence intact.
        ["a failed action paired with a COMMITTED journal that lacks a hash", async (sql) => {
          await action(sql, "j1", "o25", "failed"); await journal(sql, "o25", "j1", "COMMITTED", null); }, /terminal-action-with-committed-evidence:j1:o25:failed/u],
        ["a settled action with a hashless COMMITTED journal and no receipt owner", async (sql) => {
          await action(sql, "j1", "o26", "settled", hashOf("o26")); await journal(sql, "o26", "j1", "COMMITTED", null); }, /settled-action-evidence-mismatch:j1:o26/u],
        ["a settled action with a hashless COMMITTED journal whose owner is another wallet", async (sql) => {
          await recovered(sql, "j1", "o27", W3); }, /settled-action-evidence-mismatch:j1:o27/u],
        ["a hashless COMMITTED journal of another job", async (sql) => {
          await action(sql, "j1", "o28", "settled", hashOf("o28")); await journal(sql, "o28", "j2a", "COMMITTED", null); await owner(sql, hashOf("o28"), W1, "o28"); },
        /journal-attribution-mismatch:j1:o28/u],
        // R14.5 `resolve --not-executed` leaves an UNKNOWN journal on a failed / not-executed-proven action; anything short of that stays refused.
        ["a not-executed-proven action with another failure code", async (sql) => {
          await notExecuted(sql, "j1", "n1"); await sql.query(`update quant_actions set failure_code = 'submit-ambiguous' where journal_key = 'n1'`); },
        /journal-unresolved:j1:n1:UNKNOWN/u],
        ["a not-executed-proven action that is aborted, not failed", async (sql) => {
          await notExecuted(sql, "j1", "n2"); await sql.query(`update quant_actions set state = 'aborted' where journal_key = 'n2'`); },
        /journal-unresolved:j1:n2:UNKNOWN/u],
        ["a not-executed-proven action without a resolution", async (sql) => {
          await notExecuted(sql, "j1", "n3"); await sql.query(`update quant_actions set resolution_json = null where journal_key = 'n3'`); },
        /journal-unresolved:j1:n3:UNKNOWN/u],
        ["a not-executed-proven action with an unreadable resolution", async (sql) => { await notExecuted(sql, "j1", "n4", "not json"); },
          /journal-unresolved:j1:n4:UNKNOWN/u],
        ["a resolution of another version", async (sql) => { await notExecuted(sql, "j1", "n5", doorEvidence({ v: 2 })); }, /journal-unresolved:j1:n5:UNKNOWN/u],
        ["a resolution of another kind", async (sql) => { await notExecuted(sql, "j1", "n6", doorEvidence({ kind: "settled" })); }, /journal-unresolved:j1:n6:UNKNOWN/u],
        ["a resolution finalized exactly at the deadline", async (sql) => { await notExecuted(sql, "j1", "n7", doorEvidence({ finalizedTimestampSec: "1" })); },
          /journal-unresolved:j1:n7:UNKNOWN/u],
        // R4-1: the action's own deadline column decides, not the evidence's copy of it (100 vs 1, finalized at 50).
        ["a resolution past its own recorded deadline but not the action's", async (sql) => {
          await notExecuted(sql, "j1", "n15", doorEvidence({ deadlineSec: 1, finalizedTimestampSec: "50" }));
          await sql.query(`update quant_actions set deadline_sec = 100 where journal_key = 'n15'`); },
        /journal-unresolved:j1:n15:UNKNOWN/u],
        ["a resolution whose finalized time is not a decimal", async (sql) => { await notExecuted(sql, "j1", "n8", doorEvidence({ finalizedTimestampSec: "0x7fffffff" })); },
          /journal-unresolved:j1:n8:UNKNOWN/u],
        ["a not-executed-proven pair whose journal has a call id", async (sql) => {
          await notExecuted(sql, "j1", "n9");
          await sql.query(`update execution_journal set external_ref = jsonb_set(external_ref, '{callsId}', '"${hashOf("n9-calls")}"') where idempotency_key = 'n9'`); },
        /journal-unresolved:j1:n9:UNKNOWN/u],
        ["a not-executed-proven action that carries a transaction hash", async (sql) => {
          await notExecuted(sql, "j1", "n10"); await sql.query(`update quant_actions set tx_hash = '${hashOf("n10")}' where journal_key = 'n10'`); },
        /terminal-action-with-committed-evidence:j1:n10:failed/u],
        ["a not-executed-proven pair whose journal names a transaction", async (sql) => {
          await notExecuted(sql, "j1", "n11");
          await sql.query(`update execution_journal set external_ref = jsonb_set(external_ref, '{txHash}', '"${hashOf("n11")}"') where idempotency_key = 'n11'`); },
        /terminal-action-with-committed-evidence:j1:n11:failed/u],
        ["a not-executed-proven action with a receipt owner", async (sql) => { await notExecuted(sql, "j1", "n12"); await owner(sql, hashOf("n12"), W1, "n12"); },
          /terminal-action-with-committed-evidence:j1:n12:failed/u],
        ["a not-executed-proven action whose journal is not UNKNOWN", async (sql) => {
          await notExecuted(sql, "j1", "n13"); await sql.query(`update execution_journal set state = 'PENDING' where idempotency_key = 'n13'`); },
        /journal-unresolved:j1:n13:PENDING/u],
        ["a not-executed-proven action whose UNKNOWN journal belongs to another job", async (sql) => {
          await notExecuted(sql, "j1", "n14"); await sql.query(`update execution_journal set agent_id = 'j2a' where idempotency_key = 'n14'`); },
        /journal-attribution-mismatch:j1:n14/u],
      ];
      for (const [label, mutate, expected] of scenarios) {
        const { url, sql } = await populated(); await mutate(sql);
        const before = await snapshot(sql);
        const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
        const check = await runPlanCheck(sql, plan);
        assert.equal(check["ok"], false, label);
        assert.ok((check["reasons"] as string[]).some((reason) => expected.test(reason)), `${label}: ${JSON.stringify(check["reasons"])}`);
        refusedWith(await applyCutover({ databaseUrl: url, plan }), "plan-refused", expected);
        await untouched(sql, before);
      }
    });

    await t.test("prior claim, marker, rebalance or generation state, and unsupported legacy schema, refuse", async () => {
      const cases: readonly (readonly [string, (sql: SqlClient) => Promise<void>, RegExp])[] = [
        ["a claims table", async (sql) => { await sql.query(QUANT_WALLET_CLAIMS_DDL); }, /^claim-schema-present/u],
        ["a rebalance table", async (sql) => { await sql.query(`create table quant_rebalance_jobs (job_id text primary key)`); }, /^rebalance-schema-present/u],
        ["a non-null claim generation", async (sql) => { await sql.query(`alter table quant_jobs add column claim_generation numeric`);
          await sql.query(`update quant_jobs set claim_generation = 1 where quant_job_id = 'j1'`); }, /^claim-generation-present/u],
        ["a missing legacy table", async (sql) => { await sql.query(`drop table quant_recenters`); }, /^missing-table:quant_recenters/u],
        ["a missing required job column", async (sql) => { await sql.query(`alter table quant_jobs drop column strategy_id`); }, /^missing-column:quant_jobs\.strategy_id/u],
        // Audit finding 4: the whole contract the Grid store needs, not only the columns the tool reads.
        ["a missing level column", async (sql) => { await sql.query(`alter table quant_levels drop column buy_price_e18`); }, /^missing-column:quant_levels\.buy_price_e18/u],
        ["a missing accounting column", async (sql) => { await sql.query(`alter table quant_jobs drop column accounting_rev`); }, /^missing-column:quant_jobs\.accounting_rev/u],
        ["a missing action column", async (sql) => { await sql.query(`alter table quant_actions drop column fee_est_wei`); }, /^missing-column:quant_actions\.fee_est_wei/u],
        ["a missing ownership column", async (sql) => { await sql.query(`alter table quant_receipt_ownership drop column created_at_ms`); }, /^missing-column:quant_receipt_ownership\.created_at_ms/u],
        ["a missing epoch column", async (sql) => { await sql.query(`alter table quant_epochs drop column verified`); }, /^missing-column:quant_epochs\.verified/u],
        ["a missing journal column", async (sql) => { await sql.query(`alter table execution_journal drop column last_error`); }, /^journal-schema-unsupported/u],
        ["a missing journal", async (sql) => { await sql.query(`drop table execution_journal`); }, /^missing-table:execution_journal/u],
      ];
      for (const [label, mutate, expected] of cases) {
        const { url, sql } = await populated();
        await mutate(sql);
        const before = await snapshot(sql);
        const plan = { ...chosen((await report(sql)).draftPlan, W2, "j2b") };
        const check = await runPlanCheck(sql, plan);
        assert.equal(check["ok"], false, label);
        assert.ok((check["reasons"] as string[]).some((reason) => expected.test(reason)), `${label}: ${JSON.stringify(check["reasons"])}`);
        const outcome = await applyCutover({ databaseUrl: url, plan });
        assert.equal(outcome.kind, "refused", `${label}: ${JSON.stringify(outcome)}`);
        assert.deepEqual(await snapshot(sql), before, label);
      }
    });

    await t.test("a stale plan is refused when one level, journal or receipt-owner row changes at a constant count", async () => {
      const mutations: readonly (readonly [string, string])[] = [
        ["a level row", `update quant_levels set sell_price_e18 = sell_price_e18 + 1 where quant_job_id = 'j1' and level_index = 0`],
        ["a journal row", `update execution_journal set external_ref = jsonb_set(external_ref, '{txHash}', '"0x${"b".repeat(64)}"') where idempotency_key = 'k1'`],
        ["a receipt owner", `update quant_receipt_ownership set trading_wallet = '${W3}' where journal_key = 'k1'`],
        ["a job row", `update quant_jobs set hold_code = 'x' where quant_job_id = 'j2a'`],
        ["a journal-only state", `update execution_journal set state = 'UNKNOWN' where idempotency_key = 'k1'`],
      ];
      for (const [label, statement] of mutations) {
        const { url, sql } = await populated();
        const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
        assert.equal((await runPlanCheck(sql, plan))["ok"], true);
        await sql.query(statement);
        const before = await snapshot(sql);
        refusedWith(await applyCutover({ databaseUrl: url, plan }), "plan-refused", /census-digest-mismatch/u);
        await untouched(sql, before);
        assert.equal((await runPlanCheck(sql, plan))["ok"], false, label);
      }
    });

    await t.test("the census makes zero writes", async () => {
      const { sql } = await populated();
      const statements: string[] = [];
      const check = (text: string) => {
        statements.push(text);
        assert.match(text, /^\s*(\/\*[^]*?\*\/\s*)?(select|set (transaction|local))\b/iu, `write attempted: ${text.slice(0, 80)}`);
      };
      const readOnly: SqlClient = { query: (text, params, options) => { check(text); return sql.query(text, params, options); },
        transaction: (fn) => sql.transaction((tx) => fn(intercept({ before: check })(tx))), close: () => sql.close() };
      const census = await runCensus(readOnly);
      assert.ok(statements.length > 0);
      const plan = chosen((census as unknown as { draftPlan: CutoverPlan }).draftPlan, W2, "j2b");
      assert.equal((await runPlanCheck(readOnly, plan))["ok"], true);
      assert.deepEqual(parseCutoverArgs(["census"]), { command: "census" });
      assert.deepEqual(parseCutoverArgs(["apply", "--plan", "p.json"]), { command: "apply", plan: "p.json", yesLive: false });
      assert.deepEqual(parseCutoverArgs(["apply", "--plan", "p.json", "--yes-live"]), { command: "apply", plan: "p.json", yesLive: true });
      for (const argv of [[], ["migrate"], ["census", "--yes-live"], ["plan-check"], ["plan-check", "--plan", "p", "--yes-live"], ["apply", "--yes-live"]]) {
        assert.throws(() => parseCutoverArgs(argv), /usage/u, JSON.stringify(argv));
      }
      assert.throws(() => parseQuantRebalanceOperatorArgs(["migrate"]));
    });

    await t.test("a held singleton refuses, and a half-acquired pair is released", async () => {
      const { url, sql } = await populated();
      const before = await snapshot(sql);
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      for (const role of ["quant-worker", "quant-rebalance-worker"] as const satisfies readonly WorkerSingletonRole[]) {
        const held = await acquireWorkerSingleton({ role, databaseUrl: url });
        assert.equal(held.kind, "acquired");
        refusedWith(await applyCutover({ databaseUrl: url, plan }), "workers-not-drained");
        if (held.kind === "acquired") await held.closeGracefully();
      }
      // With the second role held, the first barrier the run took has been released again.
      const second = await acquireWorkerSingleton({ role: "quant-rebalance-worker", databaseUrl: url });
      refusedWith(await applyCutover({ databaseUrl: url, plan }), "workers-not-drained");
      const first = await acquireWorkerSingleton({ role: "quant-worker", databaseUrl: url });
      assert.equal(first.kind, "acquired");
      if (first.kind === "acquired") await first.closeGracefully();
      if (second.kind === "acquired") await second.closeGracefully();
      await untouched(sql, before);
    });

    await t.test("a failure after the DDL, the claim insert or the marker insert rolls everything back", async () => {
      for (const [label, pattern] of [["the DDL", /create table if not exists quant_rebalance_actions/u],
        ["the claim insert", /insert into quant_wallet_claims/u], ["the marker insert", /insert into quant_wallet_claim_migration/u]] as const) {
        const { url, sql } = await populated();
        const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
        const before = await snapshot(sql);
        const outcome = await applyCutover({ databaseUrl: url, plan, hooks: { wrapTx: intercept({
          after: (text) => { if (pattern.test(text)) throw new Error("injected-failure"); } }) } });
        refusedWith(outcome, "injected-failure");
        await untouched(sql, before);
        assert.ok(label.length > 0);
      }
    });

    await t.test("a lost COMMIT acknowledgement is outcome-unknown, verified on a fresh connection, and never retried", async (st) => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      let markerInserts = 0; let commits = 0;
      const original = pg.Client.prototype.query as unknown as (...args: unknown[]) => unknown;
      const mocked = st.mock.method(pg.Client.prototype, "query", function (this: pg.Client, ...args: unknown[]) {
        if (typeof args[0] === "string" && /insert into quant_wallet_claim_migration/u.test(args[0])) markerInserts += 1;
        if (args[0] !== "COMMIT") return Reflect.apply(original, this, args);
        commits += 1; // the real COMMIT runs on the server; only its acknowledgement is lost
        return Promise.resolve(Reflect.apply(original, this, args)).then(() => { throw new Error("connection terminated"); });
      } as never);
      let outcome: CutoverOutcome;
      try { outcome = await applyCutover({ databaseUrl: url, plan }); } finally { mocked.mock.restore(); }
      assert.equal(outcome.kind, "outcome-unknown", JSON.stringify(outcome));
      if (outcome.kind === "outcome-unknown") { assert.equal(outcome.markerPresent, true); assert.equal(outcome.terminationConfirmed, true); }
      assert.equal(markerInserts, 1); assert.equal(commits, 1);
      assert.equal(await new PostgresQuantWalletClaimStore(sql).migrationInstalled(), true);
    });

    await t.test("losing either barrier during the DDL, the holder writes or before COMMIT commits nothing", async () => {
      for (const [label, index, where, pattern] of [
        ["during the DDL", 0, "before", /alter table quant_jobs add column/u],
        ["during the holder writes", 1, "before", /insert into quant_wallet_claims/u],
        ["before COMMIT", 0, "after", /insert into quant_wallet_claim_migration/u],
        ["before COMMIT (second barrier)", 1, "after", /insert into quant_wallet_claim_migration/u],
      ] as const) {
        const { url, sql } = await populated();
        const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
        const before = await snapshot(sql);
        const barriers = fakeBarriers();
        const trigger = (text: string) => { if (pattern.test(text)) barriers.lose(index); };
        const outcome = await applyCutover({ databaseUrl: url, plan, hooks: { acquire: barriers.acquire,
          wrapTx: intercept(where === "before" ? { before: trigger } : { after: trigger }) } });
        assert.equal(outcome.kind, "refused", label);
        refusedWith(outcome, "fence-lost");
        await untouched(sql, before);
      }
    });

    await t.test("writers to every census table wait for the whole transaction, and a competing new-wallet insert cannot slip in", async () => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const writer = new pg.Client({ connectionString: url }); await writer.connect();
      try {
        await writer.query("set lock_timeout = '300ms'");
        let locked!: () => void; const isLocked = new Promise<void>((resolve) => { locked = resolve; });
        let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
        const applying = applyCutover({ databaseUrl: url, plan, hooks: { wrapTx: intercept({
          after: async (text) => { if (/^\s*lock table/u.test(text)) { locked(); await gate; } } }) } });
        // Fail at once, not by timeout, if the cutover finishes without ever holding the table locks.
        await Promise.race([isLocked, applying.then((finished) => { throw new Error(`cutover finished (${finished.kind}) without holding the table locks`); })]);
        await assert.rejects(writer.query(`insert into execution_journal (idempotency_key, agent_id, owner_address, kind, state)
          values ('unrelated', 'lp-agent', '${W1}', 'lp', 'PENDING')`), /lock timeout/iu);
        await assert.rejects(writer.query(`insert into quant_jobs (quant_job_id, strategy_id, trading_wallet, status, created_at_ms, updated_at_ms)
          values ('new-wallet', 'strategy-1', '${W3}', 'discovered', 1, 1)`), /lock timeout/iu);
        assert.equal((await writer.query(`select count(*)::int as n from quant_jobs`)).rows[0]?.n, 6, "plain reads are not blocked");
        release();
        assert.equal((await applying).kind, "applied");
        await writer.query(`insert into execution_journal (idempotency_key, agent_id, owner_address, kind, state) values ('unrelated', 'lp-agent', '${W1}', 'lp', 'PENDING')`);
        await writer.query(`insert into quant_jobs (quant_job_id, strategy_id, trading_wallet, status, created_at_ms, updated_at_ms) values ('new-wallet', 'strategy-1', '${W3}', 'discovered', 1, 1)`);
      } finally { await writer.end(); }
    });

    await t.test("an ALTER blocked by a reader times out and rolls the whole cutover back, without a retry", async () => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const before = await snapshot(sql);
      const reader = new pg.Client({ connectionString: url }); await reader.connect();
      try {
        await reader.query("begin"); await reader.query("select count(*) from quant_jobs");
        const outcome = await applyCutover({ databaseUrl: url, plan, hooks: { lockTimeoutMs: 400 } });
        refusedWith(outcome, "lock-timeout");
        await reader.query("rollback");
        await untouched(sql, before);
        // A later, separate operator run succeeds once the reader is gone.
        assert.equal((await applyCutover({ databaseUrl: url, plan })).kind, "applied");
      } finally { await reader.end(); }
    });

    /** Backends of the cutover tool that are still alive in one database. */
    const cutoverBackends = async (url: string) => Number((await admin.query(
      `select count(*)::int as n from pg_stat_activity where datname = $1 and application_name = '4lpha-claim-cutover'`,
      [new URL(url).pathname.slice(1)])).rows[0]?.["n"]);

    await t.test("the deadline terminates a running server statement and frees the locks promptly", async () => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const before = await snapshot(sql);
      const started = Date.now();
      // A real statement is running on the server, with the table locks held, when the 300 ms deadline expires.
      const outcome = await applyCutover({ databaseUrl: url, plan, hooks: { deadlineMs: 300, wrapTx: intercept({
        after: async (statement, tx) => { if (/^\s*lock table/u.test(statement)) await tx.query("select pg_sleep(1.5)"); } }) } });
      const elapsed = Date.now() - started;
      refusedWith(outcome, "deadline-exceeded");
      if (outcome.kind === "refused") assert.deepEqual(outcome.details, [], "the rollback was confirmed");
      assert.ok(elapsed < 1_200, `a 300 ms deadline took ${elapsed} ms; the audit measured 1,573 ms when the query ran to completion`);
      assert.equal(await cutoverBackends(url), 0, "the pinned backend is confirmed terminated");
      await untouched(sql, before);
      const writer = new pg.Client({ connectionString: url }); await writer.connect();
      try {
        await writer.query("set lock_timeout = '250ms'");
        const wrote = Date.now();
        await writer.query(`insert into execution_journal (idempotency_key, agent_id, owner_address, kind, state) values ('after-deadline', 'lp-agent', '${W1}', 'lp', 'PENDING')`);
        assert.ok(Date.now() - wrote < 250, "a competing writer proceeds at once");
      } finally { await writer.end(); }
    });

    await t.test("terminateBackend returns true only once the backend has left pg_stat_activity, and false when it cannot be terminated", async () => {
      const { url } = await legacy();
      const victim = new pg.Client({ connectionString: url }); victim.on("error", () => undefined); await victim.connect();
      const pid = Number((await victim.query("select pg_backend_pid() as pid")).rows[0]?.pid);
      const running = victim.query("select pg_sleep(30)").catch(() => undefined);
      assert.equal(await terminateBackend(url, pid), true);
      assert.equal((await admin.query("select 1 from pg_stat_activity where pid = $1::int", [pid])).rows.length, 0, "true means gone");
      await running;
      // A server process that is not a backend cannot be terminated and stays visible: the confirmation must say so.
      const walwriter = Number((await admin.query("select pid from pg_stat_activity where backend_type = 'walwriter'")).rows[0]?.["pid"]);
      assert.ok(Number.isSafeInteger(walwriter) && walwriter > 0);
      assert.equal(await terminateBackend(url, walwriter, Date.now() + 1_000), false);
    });

    await t.test("when the termination itself fails the run still returns at the deadline and says the rollback is unconfirmed", async () => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const started = Date.now();
      const outcome = await applyCutover({ databaseUrl: url, plan, hooks: { deadlineMs: 300, terminate: async () => false, wrapTx: intercept({
        after: async (statement, tx) => { if (/^\s*lock table/u.test(statement)) await tx.query("select pg_sleep(4)"); } }) } });
      const elapsed = Date.now() - started;
      refusedWith(outcome, "deadline-exceeded", /rollback-unconfirmed/u);
      assert.ok(elapsed < 2_500, `returned after ${elapsed} ms although the server statement runs for 4 s`);
      // Clean up the deliberately unterminated backend.
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and application_name = '4lpha-claim-cutover'`,
        [new URL(url).pathname.slice(1)]);
      assert.equal((await sql.query(`select to_regclass('public.quant_wallet_claims') as a`)).rows[0]?.["a"], null);
    });

    // Fix audit round 2, finding 4: one absolute cleanup deadline shared by every cleanup step.
    const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });
    /**
     * Requests that never answer. `releaseHung` rejects every one, now and later, so code that fails to bound one
     * cannot outlive its test (a mutation of that code must fail the test, not hold the process open).
     */
    const hangs = () => {
      let released = false;
      const stuck: ((error: Error) => void)[] = [];
      return {
        hang: <T>() => released ? Promise.reject<T>(new Error("released")) : new Promise<T>((_resolve, reject) => { stuck.push(reject); }),
        releaseHung: () => { released = true; for (const reject of stuck.splice(0)) reject(new Error("released")); },
      };
    };
    /** The real COMMIT runs on the server; only its acknowledgement is lost. */
    const loseCommitAck = (st: TestContext, extra?: (args: unknown[]) => Promise<unknown> | undefined) => {
      const original = pg.Client.prototype.query as unknown as (...args: unknown[]) => unknown;
      return st.mock.method(pg.Client.prototype, "query", function (this: pg.Client, ...args: unknown[]) {
        const replaced = extra?.(args);
        if (replaced !== undefined) return replaced;
        if (args[0] !== "COMMIT") return Reflect.apply(original, this, args);
        return Promise.resolve(Reflect.apply(original, this, args)).then(() => { throw new Error("connection terminated"); });
      } as never);
    };

    await t.test("termination and its confirmation stop at one absolute deadline, however slowly the control connection answers", async (st) => {
      const { url } = await legacy();
      const victim = new pg.Client({ connectionString: url }); victim.on("error", () => undefined); await victim.connect();
      const pid = Number((await victim.query("select pg_backend_pid() as pid")).rows[0]?.pid);
      const original = pg.Client.prototype.query as unknown as (...args: unknown[]) => unknown;
      const { hang, releaseHung } = hangs();
      let hangReads = false;
      // Only the disposable victim is ever targeted: the terminate request is swallowed and each confirmation read is
      // slow but successful, or (in the second half) never answers.
      const mocked = st.mock.method(pg.Client.prototype, "query", function (this: pg.Client, ...args: unknown[]) {
        if (args[0] === "select pg_terminate_backend($1::int)") return Promise.resolve({ rows: [] });
        if (args[0] === "select 1 from pg_stat_activity where pid = $1::int") {
          return hangReads ? hang() : pause(120).then(() => Reflect.apply(original, this, args));
        }
        return Reflect.apply(original, this, args);
      } as never);
      try {
        const started = Date.now();
        assert.equal(await terminateBackend(url, pid, started + 1_000), false);
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 1_600, `a 1 s absolute deadline took ${elapsed} ms (the audit measured 11.7 s for the per-request bounds)`);
        hangReads = true;
        const hungAt = Date.now();
        const hung = await Promise.race([terminateBackend(url, pid, hungAt + 800), pause(4_000).then(() => "hung" as const)]);
        assert.equal(hung, false, "a confirmation read that never answers must not outlive the deadline");
        assert.ok(Date.now() - hungAt < 1_400);
      } finally { releaseHung(); mocked.mock.restore(); await victim.end(); }
    });

    await t.test("a termination that only completes six seconds in is still confirmed inside the normal cleanup budget", async (st) => {
      const victim = new pg.Client({ connectionString: cluster.url }); victim.on("error", () => undefined); await victim.connect();
      const pid = Number((await victim.query("select pg_backend_pid() as pid")).rows[0]?.pid);
      const original = pg.Client.prototype.query as unknown as (...args: unknown[]) => unknown;
      let polls = 0;
      // The terminate request is swallowed; only this disposable victim is terminated, by the admin pool, six seconds later.
      const mocked = st.mock.method(pg.Client.prototype, "query", function (this: pg.Client, ...args: unknown[]) {
        if (args[0] === "select pg_terminate_backend($1::int)") return Promise.resolve({ rows: [] });
        if (args[0] === "select 1 from pg_stat_activity where pid = $1::int") polls += 1;
        return Reflect.apply(original, this, args);
      } as never);
      const late = pause(6_000).then(() => admin.query("select pg_terminate_backend($1)", [pid]));
      try {
        const started = Date.now();
        const confirmed = await terminateBackend(cluster.url, pid);
        const elapsed = Date.now() - started;
        assert.equal(confirmed, true, `the backend left after 6 s, inside the 15 s budget (${polls} polls, ${elapsed} ms)`);
        assert.ok(polls > 50, `${polls} polls: a 50-poll bound would have given up first`);
        assert.ok(elapsed < 10_000, `confirmed after ${elapsed} ms`);
      } finally { mocked.mock.restore(); await late.catch(() => undefined); await victim.end().catch(() => undefined); }
    });

    await t.test("an unconfirmed termination after the run deadline ends the run at the cleanup budget, saying the rollback is unconfirmed", async (st) => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const original = pg.Client.prototype.query as unknown as (...args: unknown[]) => unknown;
      const mocked = st.mock.method(pg.Client.prototype, "query", function (this: pg.Client, ...args: unknown[]) {
        if (args[0] === "select pg_terminate_backend($1::int)") return Promise.resolve({ rows: [] });
        if (args[0] === "select 1 from pg_stat_activity where pid = $1::int") return pause(120).then(() => Reflect.apply(original, this, args));
        return Reflect.apply(original, this, args);
      } as never);
      const barriers = fakeBarriers();
      const started = Date.now();
      let outcome: CutoverOutcome;
      try {
        outcome = await applyCutover({ databaseUrl: url, plan, hooks: { acquire: barriers.acquire, deadlineMs: 300, cleanupMs: 1_200, wrapTx: intercept({
          after: async (statement, tx) => { if (/^\s*lock table/u.test(statement)) await tx.query("select pg_sleep(6)"); } }) } });
      } finally { mocked.mock.restore(); }
      const elapsed = Date.now() - started;
      refusedWith(outcome, "deadline-exceeded", /rollback-unconfirmed/u);
      assert.ok(elapsed < 2_800, `a 300 ms deadline plus a 1.2 s cleanup budget took ${elapsed} ms`);
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and application_name = '4lpha-claim-cutover'`,
        [new URL(url).pathname.slice(1)]);
    });

    await t.test("a lost COMMIT acknowledgement whose termination is never confirmed is outcome-unknown, unconfirmed, and returns at the cleanup budget", async (st) => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const barriers = fakeBarriers();
      const { hang, releaseHung } = hangs();
      const mocked = loseCommitAck(st);
      const started = Date.now();
      let outcome: CutoverOutcome | "hung";
      try {
        outcome = await Promise.race([
          applyCutover({ databaseUrl: url, plan, hooks: { acquire: barriers.acquire, cleanupMs: 600, terminate: () => hang<boolean>() } }),
          pause(8_000).then(() => "hung" as const)]);
      } finally { releaseHung(); mocked.mock.restore(); }
      assert.notEqual(outcome, "hung", "a termination that never answers must not hold the run past the cleanup budget");
      if (outcome === "hung") return;
      assert.ok(Date.now() - started < 3_000);
      assert.equal(outcome.kind, "outcome-unknown", JSON.stringify(outcome));
      if (outcome.kind === "outcome-unknown") {
        assert.equal(outcome.terminationConfirmed, false, "the backend that sent COMMIT is not known to be gone");
        assert.equal(outcome.markerPresent, null, "no marker check can be conclusive while the backend may still commit");
      }
    });

    await t.test("a marker read that never answers gets only what the termination before it left of one shared cleanup budget", async (st) => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const barriers = fakeBarriers();
      const { hang, releaseHung } = hangs();
      let commitAt = 0;
      const mocked = loseCommitAck(st, (args) => {
        if (args[0] === "COMMIT") commitAt = Date.now();
        return typeof args[0] === "string" && args[0].includes("to_regclass('public.quant_wallet_claim_migration')") ? hang() : undefined;
      });
      let outcome: CutoverOutcome | "hung";
      try {
        // The termination takes 400 ms of the 600 ms budget, so the marker read that never answers gets what remains.
        outcome = await Promise.race([
          applyCutover({ databaseUrl: url, plan, hooks: { acquire: barriers.acquire, cleanupMs: 600, terminate: async () => { await pause(400); return true; } } }),
          pause(8_000).then(() => "hung" as const)]);
      } finally { releaseHung(); mocked.mock.restore(); }
      assert.notEqual(outcome, "hung");
      if (outcome === "hung") return;
      const cleanupTook = Date.now() - commitAt;
      assert.ok(cleanupTook < 850, `termination and the marker read shared one 600 ms budget but cleanup took ${cleanupTook} ms (a per-step budget takes about 1,000 ms)`);
      assert.equal(outcome.kind, "outcome-unknown", JSON.stringify(outcome));
      if (outcome.kind === "outcome-unknown") { assert.equal(outcome.terminationConfirmed, true); assert.equal(outcome.markerPresent, null); }
    });

    await t.test("a barrier release that never answers is cut off by the same cleanup budget and reported", async () => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const inner = fakeBarriers();
      const { hang, releaseHung } = hangs();
      const acquire: NonNullable<CutoverHooks["acquire"]> = async (input) => {
        const lease = await inner.acquire(input);
        return lease.kind === "acquired" ? { ...lease, closeGracefully: () => hang<void>() } : lease;
      };
      const started = Date.now();
      const outcome = await Promise.race([applyCutover({ databaseUrl: url, plan, hooks: { acquire, cleanupMs: 500 } }), pause(8_000).then(() => "hung" as const)]);
      releaseHung();
      assert.notEqual(outcome, "hung", "a barrier release that never answers must not hold the run past the cleanup budget");
      if (outcome === "hung") return;
      assert.ok(Date.now() - started < 3_000);
      assert.equal(outcome.kind, "applied-with-cleanup-failure", JSON.stringify(outcome));
      assert.equal(await new PostgresQuantWalletClaimStore(sql).migrationInstalled(), true, "the cutover itself committed");
    });

    await t.test("a fence lost at any microtask depth after the last statement never precedes COMMIT", async (st) => {
      const original = pg.Client.prototype.query as unknown as (...args: unknown[]) => unknown;
      for (let depth = 0; depth <= 9; depth += 1) {
        const { url, sql } = await populated();
        const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
        const before = await snapshot(sql);
        const barriers = fakeBarriers();
        let lost = false; let commitAfterLoss = false; let commitSeen = false;
        const mocked = st.mock.method(pg.Client.prototype, "query", function (this: pg.Client, ...args: unknown[]) {
          if (args[0] === "COMMIT") { commitSeen = true; if (lost) commitAfterLoss = true; }
          return Reflect.apply(original, this, args);
        } as never);
        const fire = (remaining: number): void => {
          if (remaining === 0) { lost = true; barriers.lose(0); } else queueMicrotask(() => fire(remaining - 1));
        };
        let outcome: CutoverOutcome;
        try {
          outcome = await applyCutover({ databaseUrl: url, plan, hooks: { acquire: barriers.acquire, wrapTx: intercept({
            after: (statement) => { if (/insert into quant_wallet_claim_migration/u.test(statement)) fire(depth); } }) } });
        } finally { mocked.mock.restore(); }
        assert.equal(commitAfterLoss, false, `depth ${depth}: COMMIT was dispatched after the loss was observed`);
        if (commitSeen) {
          // COMMIT was dispatched before the loss: applied, or (loss while COMMIT was in flight) outcome-unknown whose
          // fresh-connection verification must agree with the database.
          assert.ok(["applied", "applied-with-cleanup-failure", "outcome-unknown"].includes(outcome.kind), `depth ${depth}: ${outcome.kind}`);
          if (outcome.kind === "outcome-unknown") {
            assert.equal(outcome.markerPresent, await new PostgresQuantWalletClaimStore(sql).migrationInstalled().catch(() => false), `depth ${depth}`);
          }
        } else { refusedWith(outcome, "fence-lost"); await untouched(sql, before); }
      }
    });

    await t.test("no statement is dispatched to the server once a barrier is observed lost", async (st) => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const before = await snapshot(sql);
      const barriers = fakeBarriers();
      const original = pg.Client.prototype.query as unknown as (...args: unknown[]) => unknown;
      let lost = false; const dispatchedAfterLoss: string[] = [];
      const mocked = st.mock.method(pg.Client.prototype, "query", function (this: pg.Client, ...args: unknown[]) {
        if (lost && typeof args[0] === "string" && (args[0] === "COMMIT" || args[0].includes("quantClaimCutover"))) dispatchedAfterLoss.push(args[0].slice(0, 60));
        return Reflect.apply(original, this, args);
      } as never);
      let outcome: CutoverOutcome;
      try {
        outcome = await applyCutover({ databaseUrl: url, plan, hooks: { acquire: barriers.acquire, wrapTx: intercept({
          after: (statement) => { if (/insert into quant_wallet_claims/u.test(statement) && !lost) { lost = true; barriers.lose(1); } } }) } });
      } finally { mocked.mock.restore(); }
      refusedWith(outcome, "fence-lost");
      assert.deepEqual(dispatchedAfterLoss, []);
      await untouched(sql, before);
    });

    await t.test("an original-row change after the DDL, with no schema change, rolls the whole cutover back", async () => {
      const { url, sql } = await populated();
      const plan = chosen((await report(sql)).draftPlan, W2, "j2b");
      const before = await snapshot(sql);
      const outcome = await applyCutover({ databaseUrl: url, plan, hooks: { wrapTx: intercept({
        after: async (statement, tx) => { if (/create table if not exists quant_rebalance_actions/u.test(statement)) {
          await tx.query(`update quant_levels set sell_price_e18 = sell_price_e18 + 1 where quant_job_id = 'j1' and level_index = 0`); } } }) } });
      refusedWith(outcome, "census-changed-by-schema");
      await untouched(sql, before);
    });
  } finally {
    for (const pool of pools) await pool.close().catch(() => undefined);
    await cluster.close();
  }
});
