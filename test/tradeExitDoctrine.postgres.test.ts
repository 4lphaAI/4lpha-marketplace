import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { PostgresTradeIntentStore } from "../src/store/tradeIntents.js";
import { createPgSqlClient } from "../src/store/sql.js";
import { PostgresTradePositionStore, type TradeEvidenceExpected } from "../src/store/tradePositions.js";
import { PostgresTradeSettingsStore } from "../src/store/tradeSettings.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest } from "../src/trade/settings.js";
import { localPostgres } from "./support/localPostgres.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const HASH = `0x${"11".repeat(32)}` as Hex;
const NOW = 1_900_000_000_000;

function expected(row: NonNullable<Awaited<ReturnType<PostgresTradePositionStore["get"]>>>): TradeEvidenceExpected {
  return {
    lastQuoteWei: row.lastQuoteWei, lastQuoteBalance: row.lastQuoteBalance, lastQuoteRoute: row.lastQuoteRoute,
    lastQuoteAtMs: row.lastQuoteAtMs, crashPendingSinceMs: row.crashPendingSinceMs,
    crashPendingKind: row.crashPendingKind, crashRefQuoteWei: row.crashRefQuoteWei,
    crashRefBalance: row.crashRefBalance, crashRefAtMs: row.crashRefAtMs, crashRefRoute: row.crashRefRoute,
    autoExitReason: row.autoExitReason, autoExitAtMs: row.autoExitAtMs, autoExitNote: row.autoExitNote,
  };
}

test("trade exit doctrine migration, CAS and fence round-trips use disposable local PostgreSQL", { timeout: 120_000 }, async (t) => {
  const cluster = await localPostgres();
  if (cluster === null) { t.skip("PostgreSQL 17 binaries unavailable; no external database fallback"); return; }
  const sql = await createPgSqlClient(cluster.url);
  const intentSql = await createPgSqlClient(cluster.url);
  const settingsSql = await createPgSqlClient(cluster.url);
  t.after(async () => {
    await sql.close(); await intentSql.close(); await settingsSql.close(); await cluster.close();
  });

  await sql.query(`create table trade_positions (
    id text primary key, agent_id text not null, owner_address text not null, token text not null,
    route jsonb not null, entry_wei numeric(78,0) not null, token_amount numeric(78,0) not null,
    fill_status text not null default 'verified', opened_at timestamptz not null, entry_tx_hash text,
    status text not null, exit_requested_at timestamptz, orphaned_at timestamptz, closed_at timestamptz,
    exit_wei numeric(78,0), exit_tx_hash text, sold_token_amount numeric(78,0), exit_fill_status text,
    close_reason text, last_sell_refusal text, last_sell_refusal_at timestamptz,
    no_price_count integer not null default 0,
    constraint trade_positions_close_reason_v2_check check
      (close_reason is null or close_reason in ('owner-request','stop-loss','take-profit','max-hold','llm','balance-gone'))
  )`);
  await sql.query(`insert into trade_positions
    (id,agent_id,owner_address,token,route,entry_wei,token_amount,fill_status,opened_at,status,no_price_count)
    values ($1,$2,$3,$4,$5::jsonb,$6::numeric,$7::numeric,$8,$9::timestamptz,'open',0)`,
    ["legacy", "trade-agent", OWNER, TOKEN, JSON.stringify({ hops: [], fees: [] }), "100", "100", "verified", new Date(NOW)]);

  const positions = await PostgresTradePositionStore.create(sql, () => NOW);
  const legacy = await positions.get(OWNER, "trade-agent", "legacy");
  assert.equal(legacy?.crashBasisVerified, false);
  assert.equal(legacy?.lastQuoteAtMs, null);

  const created = await positions.open({ positionId: "receipt", agentId: "trade-agent", ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [] }, entryWei: 100n, tokenAmount: 100n, fillStatus: "verified", openedAt: NOW,
    entryTxHash: HASH, crashBasisVerified: true });
  assert.equal(created.crashBasisVerified, true);
  const first = await positions.recordQuote({ ownerAddress: OWNER, agentId: "trade-agent", positionId: "receipt",
    quoteOutWei: 100n, balance: 100n, routeKey: "v2:route", pnlBps: 0n, atMs: NOW });
  assert.equal(first?.lastQuoteWei, 100n);

  const current = await positions.get(OWNER, "trade-agent", "receipt");
  assert.ok(current);
  const initial = expected(current);
  const competing = await Promise.all([
    positions.recordQuote({ ownerAddress: OWNER, agentId: "trade-agent", positionId: "receipt", quoteOutWei: 40n,
      balance: 100n, routeKey: "v2:route", pnlBps: -6_000n, atMs: NOW + 1_000, expected: initial }),
    positions.recordQuote({ ownerAddress: OWNER, agentId: "trade-agent", positionId: "receipt", quoteOutWei: 41n,
      balance: 100n, routeKey: "v2:route", pnlBps: -5_900n, atMs: NOW + 2_000, expected: initial }),
  ]);
  assert.equal(competing.filter((row) => row !== null).length, 1);
  const quoted = await positions.get(OWNER, "trade-agent", "receipt");
  assert.ok(quoted);
  const armed = await positions.recordCrashEvidence({ ownerAddress: OWNER, agentId: "trade-agent", positionId: "receipt",
    expected: expected(quoted), action: { kind: "arm", pendingKind: "collapse", pendingSinceMs: NOW + 3_000,
      reference: { quoteWei: 100n, balance: 100n, routeKey: "v2:route", atMs: NOW } } });
  assert.equal(armed?.crashPendingKind, "collapse");
  const marked = await positions.recordCrashEvidence({ ownerAddress: OWNER, agentId: "trade-agent", positionId: "receipt",
    expected: expected(armed!), action: { kind: "marker", reason: "crash-stop", atMs: NOW + 4_000, note: "quote -60% vs last reading" } });
  assert.equal(marked?.autoExitReason, "crash-stop");
  assert.equal((await positions.closePosition({ ownerAddress: OWNER, agentId: "trade-agent", positionId: "receipt",
    exitWei: 40n, reason: "crash-stop", note: marked?.autoExitNote ?? null }))?.closeNote, "quote -60% vs last reading");

  const settings = await PostgresTradeSettingsStore.create(settingsSql);
  const rawSettings = { ...DEFAULT_TRADE_SETTINGS, crashProtection: true };
  await settings.put({ agentId: "trade-agent", ownerAddress: OWNER, params: rawSettings,
    digest: tradeSettingsDigest(rawSettings) });
  await positions.open({ positionId: "fenced", agentId: "trade-agent", ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [] }, entryWei: 100n, tokenAmount: 100n, fillStatus: "verified", openedAt: NOW });
  await positions.recordCrashEvidence({ ownerAddress: OWNER, agentId: "trade-agent", positionId: "fenced",
    expected: expected((await positions.get(OWNER, "trade-agent", "fenced"))!),
    action: { kind: "marker", reason: "crash-stop", atMs: NOW, note: "marker" } });
  const fenced = await settings.withEntryFence(OWNER, "trade-agent", async (tx) => {
    const next = { ...rawSettings, crashProtection: false };
    await settings.put({ agentId: "trade-agent", ownerAddress: OWNER, params: next, digest: tradeSettingsDigest(next) }, tx);
    return positions.clearCrashEvidenceForAgent(OWNER, "trade-agent", tx);
  });
  assert.equal(fenced.kind, "allowed");
  assert.equal((await positions.get(OWNER, "trade-agent", "fenced"))?.autoExitReason, null);

  const intents = await PostgresTradeIntentStore.create(intentSql, () => NOW);
  const intent = await intents.create({ decisionId: "crash-intent", idempotencyKey: HASH, agentId: "trade-agent", ownerAddress: OWNER,
    side: "sell", token: TOKEN, route: { hops: [], fees: [] }, amountWei: 100n, entryWei: 100n,
    positionId: "fenced", closeReason: "crash-stop", note: "marker" });
  assert.equal((await intents.listUnsettled(OWNER, "trade-agent"))[0]?.closeReason, "crash-stop");
  assert.equal(intent.note, "marker");

  const concurrent = await Promise.all([
    PostgresTradePositionStore.create(await createPgSqlClient(cluster.url), () => NOW),
    PostgresTradePositionStore.create(await createPgSqlClient(cluster.url), () => NOW),
  ]);
  const constraint = await sql.query<{ readonly count: string }>(`select count(*)::text as count from pg_constraint c
    where c.conname = 'trade_positions_close_reason_v3_check' and c.conrelid = 'trade_positions'::regclass`);
  assert.equal(constraint.rows[0]?.count, "1");
  for (const store of concurrent) await store.close();
});
