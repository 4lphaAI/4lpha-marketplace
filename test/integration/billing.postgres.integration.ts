import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { encodeJsonbParam } from "../../src/store/codec.js";
import { PostgresExecutionJournal } from "../../src/store/journal.js";
import { createPgSqlClient } from "../../src/store/sql.js";
import { PostgresBillingStore } from "../../src/billing/postgres.js";
import { billingAccountId } from "../../src/billing/serviceSession.js";
import type { BillingAccount, OgUsageFacts, Usage } from "../../src/billing/types.js";
import type { BillingStoreSnapshot } from "../../src/billing/store.js";

const OWNER = "0x0000000000000000000000000000000000000001";
const OTHER_OWNER = "0x0000000000000000000000000000000000000002";
const WALLET = "0x0000000000000000000000000000000000000003";
const HASH = `0x${"11".repeat(32)}` as `0x${string}`;

async function command(file: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`PostgreSQL test command failed (${code}): ${Buffer.concat(errors).toString("utf8").slice(0, 1_000)}`)));
  });
}

async function waitReady(pgIsReady: string, port: number, process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Temporary PostgreSQL exited before readiness (${process.exitCode}).`);
    try { await command(pgIsReady, ["-h", "127.0.0.1", "-p", String(port)]); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("Temporary PostgreSQL did not become ready.");
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("Could not reserve a PostgreSQL test port."));
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

function account(ownerAddress: string): BillingAccount {
  const now = 100_000;
  return {
    accountId: billingAccountId(ownerAddress, WALLET),
    ownerAddress,
    walletAddress: WALLET,
    status: "active",
    sessionFactsBytes: "0x01",
    encryptedSessionKey: "ciphertext",
    maxDailyUsdMicros: 1_000_000n,
    maxUnpaidExposureUsdMicros: 500_000n,
    thresholdUsdMicros: 100000n,
    grantExpiresAt: now + 1_000,
    createdAt: now,
    updatedAt: now,
  };
}

function legacySnapshot(): BillingStoreSnapshot {
  const sourceFacts: OgUsageFacts = {
    kind: "0g",
    manifestVersion: "legacy-v1",
    routerPayerAccountId: "payer-old",
    routerApiKeyId: "key-old",
    rawModelId: "model-old",
    canonicalModelId: "model-old",
    providerAddress: OWNER,
    reviewedProviderIdentity: null,
    providerIdentityRule: "match-if-present",
    reviewedContextLength: 1n,
    reviewedMaxCompletionTokens: 1n,
    requestedMaxTokens: 1n,
    requestBodyBytes: 1n,
    inputReserveNeuronPerToken: 1n,
    completionReserveNeuronPerToken: 1n,
    liveModelObservationDigest: HASH,
  };
  const usage: Usage = {
    usageId: "usage-old",
    assertionNonce: "nonce-old",
    sessionTicketHash: HASH,
    accountId: "account-old",
    ownerAddress: OWNER,
    walletAddress: WALLET,
    agentId: "agent-old",
    grantId: "grant-old",
    generation: 1n,
    operation: "paid.0g.chat",
    source: "0g",
    provider: "0g-router",
    templateId: "0g.chat.v1",
    logicalRequestId: "logical-old",
    requestDigest: HASH,
    externalRequestId: "request-old",
    debitIdentity: "0g:payer-old:request-old",
    payerIdentity: "payer-old",
    state: "unknown",
    version: 1n,
    asset: "0G_MAINNET",
    reservedAtomic: 1n,
    reservedUsdMicros: 1n,
    sourceFacts,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    accounts: [], walletAccounts: [], grants: [], tickets: [], replays: [], logical: [],
    usages: [[usage.usageId, usage]], debitIdentities: [[usage.debitIdentity!, usage.usageId]],
    leases: [], invoices: [], nonterminalInvoiceByUsage: [], ledger: [], ogReconciliations: [],
  };
}

test("Phase 5 real PostgreSQL migration/backfill and two-replica constraints", { timeout: 120_000 }, async (t) => {
  const postgresBin = process.env["PHASE5_POSTGRES_BIN"] ?? "C:\\Program Files\\PostgreSQL\\17\\bin";
  const initdb = join(postgresBin, process.platform === "win32" ? "initdb.exe" : "initdb");
  const postgres = join(postgresBin, process.platform === "win32" ? "postgres.exe" : "postgres");
  const pgCtl = join(postgresBin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  const pgIsReady = join(postgresBin, process.platform === "win32" ? "pg_isready.exe" : "pg_isready");
  try { await Promise.all([access(initdb), access(postgres), access(pgCtl), access(pgIsReady)]); }
  catch { t.skip(`PostgreSQL binaries are unavailable at ${postgresBin}`); return; }

  const root = await mkdtemp(join(tmpdir(), "4lpha-phase5-pg-"));
  const data = join(root, "data");
  const port = await freePort();
  let postgresProcess: ChildProcess | undefined;
  let postmasterPid: string | undefined;
  try {
    await command(initdb, [
      "-D", data,
      "--auth=trust",
      "--encoding=UTF8",
      "--no-locale",
      "--username=phase5_test",
    ]);
    postgresProcess = spawn(postgres, ["-D", data, "-F", "-p", String(port), "-h", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
    });
    await waitReady(pgIsReady, port, postgresProcess);
    postmasterPid = (await readFile(join(data, "postmaster.pid"), "utf8")).split(/\r?\n/u, 1)[0]?.trim();
    const url = `postgresql://phase5_test@127.0.0.1:${port}/postgres`;
    const bootstrap = await createPgSqlClient(url);
    await bootstrap.query(`create table phase5_billing_state (
      singleton boolean primary key default true check (singleton), payload jsonb not null)`);
    await bootstrap.query(
      "insert into phase5_billing_state(singleton,payload) values(true,$1::jsonb)",
      [encodeJsonbParam(legacySnapshot())],
    );
    await bootstrap.query(`create table phase5_billing_usage_identities (
      usage_id text primary key, grant_id text not null, generation numeric(78,0) not null,
      operation text not null, logical_request_id text not null, assertion_nonce text not null,
      debit_identity text unique)`);
    await bootstrap.query(`insert into phase5_billing_usage_identities
      (usage_id,grant_id,generation,operation,logical_request_id,assertion_nonce,debit_identity)
      values('usage-old','grant-old',1,'paid.0g.chat','logical-old','nonce-old','0g:payer-old:request-old')`);
    await bootstrap.close();

    const first = await PostgresBillingStore.create(await createPgSqlClient(url), Buffer.alloc(32, 1));
    const inspector = await createPgSqlClient(url);
    const backfilled = await inspector.query<Record<string, unknown>>(`select source,router_payer_account_id,router_request_id
      from phase5_billing_usage_identities where usage_id='usage-old'`);
    assert.deepEqual(backfilled.rows[0], {
      source: "0g", router_payer_account_id: "payer-old", router_request_id: "request-old",
    });
    const second = await PostgresBillingStore.create(await createPgSqlClient(url), Buffer.alloc(32, 1));
    const race = await Promise.allSettled([
      first.createAccount(account(OWNER)),
      second.createAccount(account(OTHER_OWNER)),
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(race.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await first.getAccountByWallet(WALLET))?.walletAddress.toLowerCase(), WALLET.toLowerCase());

    const indexes = await inspector.query<{ indexname: string }>(`select indexname from pg_indexes
      where schemaname='public' and indexname like 'phase5_billing_%'`);
    const names = new Set(indexes.rows.map((row) => row.indexname));
    for (const required of [
      "phase5_billing_x402_debit_identity_uq",
      "phase5_billing_0g_debit_identity_uq",
      "phase5_billing_one_active_lease_per_account_uq",
    ]) assert.equal(names.has(required), true, `missing real PostgreSQL index ${required}`);

    const journal = await PostgresExecutionJournal.create(await createPgSqlClient(url), () => 1_000_000);
    const decisionId = `billing:${"12".repeat(32)}`;
    await journal.begin({
      idempotencyKey: decisionId,
      agentId: account(OWNER).accountId,
      ownerAddress: OWNER,
      kind: "billingCollect",
      principal: { kind: "billing_account", id: account(OWNER).accountId },
      decisionId,
      externalRef: {
        billingPrincipal: { kind: "billing_account", id: account(OWNER).accountId },
        billingInvoice: {
          invoiceId: HASH,
          preparedDigest: HASH,
          wallet: WALLET,
          collector: OTHER_OWNER,
          valueWei: "1",
          quoteExpiresAt: 2_000,
          sessionGeneration: "1",
        },
      },
      nativeSpendWei: 1n,
    });
    const callsId = `0x${"22".repeat(32)}` as `0x${string}`;
    const bound = await journal.bindBillingCollectCallsId({
      principal: { kind: "billing_account", id: account(OWNER).accountId },
      decisionId,
      expectedCallsIdVersion: 0,
      witnessDigest: HASH,
      callsId,
    });
    assert.equal(bound.billingCallsIdVersion, 1);
    assert.equal((await journal.bindBillingCollectCallsId({
      principal: { kind: "billing_account", id: account(OWNER).accountId },
      decisionId,
      expectedCallsIdVersion: 0,
      witnessDigest: HASH,
      callsId,
    })).externalRef.callsId, callsId);
    await assert.rejects(journal.bindBillingCollectCallsId({
      principal: { kind: "billing_account", id: account(OWNER).accountId },
      decisionId,
      expectedCallsIdVersion: 1,
      witnessDigest: HASH,
      callsId: `0x${"33".repeat(32)}`,
    }));

    await Promise.all([first.close(), second.close(), inspector.close(), journal.close()]);
  } finally {
    const childExit = postgresProcess === undefined || postgresProcess.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => postgresProcess!.once("exit", () => resolve()));
    if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      await command(pgCtl, ["stop", "-D", data, "-m", "fast", "-w"]).catch(() => undefined);
      await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    }
    if (process.platform === "win32" && postmasterPid !== undefined && /^\d+$/u.test(postmasterPid)) {
      await command("C:\\Windows\\System32\\taskkill.exe", ["/PID", postmasterPid, "/T", "/F"])
        .catch(() => undefined);
    } else if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      const exited = new Promise<void>((resolve) => postgresProcess!.once("exit", () => resolve()));
      postgresProcess.kill("SIGTERM");
      await exited;
    }
    await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});
