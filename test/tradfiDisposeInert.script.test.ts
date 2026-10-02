/**
 * TRADFI-EXPIRY-KEEP-REMOVE §8 — `scripts/tradfi-dispose-inert.ts`. Never
 * executed against a real database: the logic is driven through injected reads
 * and writes, and the SQL layer runs only on an OWNED, DISPOSABLE loopback
 * cluster (`localPostgres`, never DATABASE_URL). Dry-run is proven read-only,
 * apply is proven scoped to the selected agent, a non-AI agent is refused.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import type { FinalizedSessionRevocationVerdict } from "../src/account/keyStoreReader.js";
import { PostgresAgentStore, type SessionFacts } from "../src/store/agents.js";
import { PostgresExecutionJournal } from "../src/store/journal.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { DISPOSE_INERT_SELL_SQL, PostgresTradeIntentStore } from "../src/store/tradeIntents.js";
import { PostgresTradeSettingsStore } from "../src/store/tradeSettings.js";
import { parseInertEvidence } from "../src/trade/inertSubmission.js";
import { DEFAULT_TRADE_SETTINGS, isTradfiAiSettings, parseTradeSettings, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import {
  inReadOnlyTransaction,
  parseArgs,
  pgInertReads,
  runCli,
  runDisposeInert,
  type InertReads,
  type InertWrites,
  type ScriptIntent,
} from "../scripts/tradfi-dispose-inert.js";
import { localPostgres } from "./support/localPostgres.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const KEYSTORE = getAddress("0x6666666666666666666666666666666666666666");
const KEY = `0x04${"77".repeat(64)}` as Hex;
const HASH = `0x${"66".repeat(32)}` as Hex;
const JOURNAL_KEY = `0x${"a1".repeat(32)}` as Hex;
const EXPIRY = 1_790_617_224;
const E = 10n ** 18n;

const aiSettings = (): TradeSettings => ({ ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT", minEntryWei: (5n * E).toString(),
  entryWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString(), cmcNewsEnabled: false, maxOpenPositions: 1, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, crashProtection: false });

function verdict(over: { readonly kind?: "invalid" | "missing" | "registered" | "unreadable"; readonly blockTimeSec?: number; readonly wallet?: Address } = {}): FinalizedSessionRevocationVerdict {
  const kind = over.kind ?? "invalid";
  if (kind === "unreadable") return { kind };
  const observation = { blockNumber: "101", blockHash: HASH, blockTimeSec: over.blockTimeSec ?? EXPIRY + 3_000 };
  if (kind === "registered") return { kind, observation };
  return { kind, observation, evidence: { version: 1, chainId: 56, keyStoreAddress: KEYSTORE, walletAddress: over.wallet ?? WALLET, keyId: keccak256(KEY),
    sessionPublicKey: KEY, verdict: kind, blockNumber: "101", blockHash: HASH, observedAtMs: 1 } };
}

describe("parseArgs", () => {
  it("takes exactly one valid --agent and an optional --apply", () => {
    assert.deepEqual(parseArgs(["--agent", "tradfi-trade-agent-01"]), { agentId: "tradfi-trade-agent-01", apply: false });
    assert.deepEqual(parseArgs(["--apply", "--agent", "a_1.b:c"]), { agentId: "a_1.b:c", apply: true });
    for (const bad of [[], ["--apply"], ["--agent"], ["--agent", "--apply"], ["--agent", "a", "--agent", "b"], ["--agent", "a", "--apply", "--apply"],
      ["--agent", "bad id"], ["--agent", "../x"], ["--agent", ""], ["--agent", "a", "--owner", "0x1"], ["--agent", "a", "extra"]]) {
      assert.throws(() => parseArgs(bad), Error, JSON.stringify(bad));
    }
  });
});

type Fake = {
  readonly reads: InertReads;
  readonly calls: string[];
  readonly writes: InertWrites & { readonly disposed: { owner: Address; agent: string; decision: string; evidence: string }[]; readonly runs: { agent: string }[] };
  readonly lines: string[];
};

function fake(over: { readonly settings?: TradeSettings | null; readonly agent?: boolean; readonly intents?: readonly (ScriptIntent & { readonly journalHash?: boolean; readonly noJournal?: boolean })[];
  readonly finalized?: FinalizedSessionRevocationVerdict | Error; readonly failRun?: boolean; readonly facts?: SessionFacts | null } = {}): Fake {
  const calls: string[] = [];
  const lines: string[] = [];
  const intents = over.intents ?? [{ decisionId: "ambiguous-sell", idempotencyKey: JOURNAL_KEY, side: "sell", state: "pending", txHash: null, positionId: "position", token: TOKEN }];
  const reads: InertReads = {
    async readAgent(agentId) {
      calls.push("readAgent");
      return over.agent === false ? null : { id: agentId, ownerAddress: OWNER, walletAddress: WALLET, status: "armed",
        sessionFacts: over.facts === undefined ? { publicKey: KEY, expiry: EXPIRY } : over.facts };
    },
    async readSettingsParams() { calls.push("readSettingsParams"); return over.settings === undefined ? aiSettings() : over.settings; },
    async listPendingSellIntents() { calls.push("listPendingSellIntents"); return intents; },
    async readJournal(_agent, key) {
      calls.push("readJournal");
      const intent = intents.find((row) => row.idempotencyKey === key);
      if (intent?.noJournal === true) return null;
      return { kind: "trade", state: "UNKNOWN", idempotencyKey: key, externalRef: { publicKey: KEY, sessionGeneration: 0, ...(intent?.journalHash === true ? { txHash: HASH } : {}) } };
    },
    async readFinalized() {
      calls.push("readFinalized");
      const value = over.finalized ?? verdict();
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const disposed: Fake["writes"]["disposed"] = [];
  const runs: Fake["writes"]["runs"] = [];
  const writes = { disposed, runs,
    async dispose(owner: Address, agent: string, decision: string, evidence: string) { calls.push("dispose"); disposed.push({ owner, agent, decision, evidence }); return { changed: true }; },
    async insertRun(input: { readonly agentId: string }) { calls.push("insertRun"); if (over.failRun === true) throw new Error("run store unavailable"); runs.push({ agent: input.agentId }); } };
  return { reads, calls, writes, lines };
}

const expected = { chainId: 56, registry: KEYSTORE } as const;

describe("runDisposeInert", () => {
  it("dry-run: prints the identity fields, the verdict, the block and the eligibility, and performs ZERO writes", async () => {
    const f = fake();
    const outcomes = await runDisposeInert({ args: { agentId: "agent-1", apply: false }, reads: f.reads, writes: null, expected, print: (line) => f.lines.push(line) });
    assert.deepEqual(outcomes, [{ decisionId: "ambiguous-sell", eligible: true, disposed: false }]);
    const text = f.lines.join("\n");
    assert.match(text, /mode=dry-run/u);
    assert.match(text, /side=sell state=pending txHash=none scheduleSlot=none portfolioSlot=none/u);
    assert.match(text, /journal=trade\/UNKNOWN journalHash=none/u);
    assert.match(text, /verdict=invalid block=101 blockTimeSec=1790620224 keyExpirySec=1790617224/u);
    assert.match(text, /eligible=yes/u);
    assert.equal(f.calls.includes("dispose"), false);
    assert.equal(f.calls.includes("insertRun"), false);
  });

  it("dry-run never writes even if a write capability is handed in without --apply", async () => {
    const f = fake();
    await runDisposeInert({ args: { agentId: "agent-1", apply: false }, reads: f.reads, writes: f.writes, expected, print: () => undefined });
    assert.deepEqual(f.writes.disposed, []);
    assert.deepEqual(f.writes.runs, []);
  });

  it("--apply re-runs the same checks and performs ONLY the guarded CAS for the selected agent, then the run row", async () => {
    const f = fake({ intents: [
      { decisionId: "ambiguous-sell", idempotencyKey: JOURNAL_KEY, side: "sell", state: "pending", txHash: null, positionId: "p1", token: TOKEN },
      { decisionId: "sell-with-hash", idempotencyKey: `0x${"a2".repeat(32)}` as Hex, side: "sell", state: "pending", txHash: null, positionId: "p2", token: TOKEN, journalHash: true },
      { decisionId: "no-journal", idempotencyKey: `0x${"a3".repeat(32)}` as Hex, side: "sell", state: "pending", txHash: null, positionId: "p3", token: TOKEN, noJournal: true },
      { decisionId: "scheduled", idempotencyKey: `0x${"a4".repeat(32)}` as Hex, side: "sell", state: "pending", txHash: null, positionId: "p4", token: TOKEN, scheduleSlot: 1 },
    ] });
    const outcomes = await runDisposeInert({ args: { agentId: "agent-1", apply: true }, reads: f.reads, writes: f.writes, expected, print: (line) => f.lines.push(line) });
    assert.deepEqual(outcomes.map((row) => [row.decisionId, row.eligible, row.disposed]), [["ambiguous-sell", true, true], ["sell-with-hash", false, false], ["no-journal", false, false], ["scheduled", false, false]]);
    assert.equal(f.writes.disposed.length, 1, "only the one eligible intent is disposed");
    assert.deepEqual([f.writes.disposed[0]!.owner, f.writes.disposed[0]!.agent, f.writes.disposed[0]!.decision], [OWNER, "agent-1", "ambiguous-sell"]);
    const evidence = parseInertEvidence(f.writes.disposed[0]!.evidence);
    assert.equal(evidence?.key, KEY);
    assert.equal(evidence?.journalKey, JOURNAL_KEY);
    assert.equal(evidence?.expirySec, EXPIRY);
    assert.deepEqual(f.writes.runs, [{ agent: "agent-1" }]);
    assert.match(f.lines.join("\n"), /mode=apply/u);
  });

  it("refuses a non-AI agent before any output other than the refusal, and reads nothing further", async () => {
    const schedule: TradeSettings = { ...aiSettings(), minEntryWei: (20n * E).toString(), tradeMode: "schedule" as const, scheduleToken: TOKEN.toLowerCase(), scheduleIntervalSec: 3_600 as const,
      scheduleFirstAtSec: null, scheduleEndKind: "budget" as const, scheduleEndAtSec: null, scheduleEndRuns: null, scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150 };
    for (const settings of [{ ...DEFAULT_TRADE_SETTINGS, executionModel: "sigma" as const }, null, schedule]) {
      if (settings !== null) {
        const parsed = parseTradeSettings(settings);
        assert.equal(parsed.ok && !isTradfiAiSettings(parsed.value.effective), true, "the fixture is a VALID settings row of another model");
      }
      const f = fake({ settings });
      await assert.rejects(runDisposeInert({ args: { agentId: "agent-1", apply: true }, reads: f.reads, writes: f.writes, expected, print: (line) => f.lines.push(line) }), /not a TradFi AI trade agent/u);
      assert.deepEqual(f.lines, [], "nothing but the refusal");
      assert.equal(f.calls.includes("listPendingSellIntents"), false);
      assert.equal(f.calls.includes("readFinalized"), false);
      assert.deepEqual(f.writes.disposed, []);
    }
    await assert.rejects(runDisposeInert({ args: { agentId: "ghost", apply: false }, reads: fake({ agent: false }).reads, writes: null, expected, print: () => undefined }), /No such agent/u);
  });

  it("an unreadable or thrown finalized read, a registered key and a block before the expiry never dispose", async () => {
    for (const finalized of [verdict({ kind: "unreadable" }), new Error("rpc down"), verdict({ kind: "registered" }), verdict({ blockTimeSec: EXPIRY - 1 }), verdict({ wallet: getAddress("0x2000000000000000000000000000000000000009") })]) {
      const f = fake({ finalized });
      const outcomes = await runDisposeInert({ args: { agentId: "agent-1", apply: true }, reads: f.reads, writes: f.writes, expected, print: () => undefined });
      assert.equal(outcomes[0]?.eligible, false);
      assert.deepEqual(f.writes.disposed, []);
    }
  });

  it("a missing session (no current key) is never eligible, and a lost run row is best effort", async () => {
    const noKey = fake({ facts: null });
    assert.equal((await runDisposeInert({ args: { agentId: "agent-1", apply: true }, reads: noKey.reads, writes: noKey.writes, expected, print: () => undefined }))[0]?.eligible, false);
    const failing = fake({ failRun: true });
    const outcomes = await runDisposeInert({ args: { agentId: "agent-1", apply: true }, reads: failing.reads, writes: failing.writes, expected, print: (line) => failing.lines.push(line) });
    assert.equal(outcomes[0]?.disposed, true, "the CAS stands");
    assert.match(failing.lines.join("\n"), /run row could not be written \(best effort\)/u);
  });
});

// ------------------------------------------------ the actual CLI composition (runCli) over a recording SQL client

type Statement = { readonly text: string; readonly params: readonly unknown[] };
const flat = (text: string): string => text.replace(/\/\*.*?\*\//gsu, "").replace(/\s+/gu, " ").trim();
const isWrite = (statement: Statement): boolean => /^(insert|update|delete|create|alter|drop|truncate|grant|revoke)\b/iu.test(flat(statement.text));
const isDdl = (statement: Statement): boolean => /^(create|alter|drop|truncate|grant|revoke)\b/iu.test(flat(statement.text));

/** Answers exactly the script's statements from canned rows, RECORDS every one, and throws on any other. */
function recordingSql(over: { readonly settings?: TradeSettings | null; readonly noAgent?: boolean; readonly migrated?: boolean } = {}) {
  const statements: Statement[] = [];
  const answer = (text: string, params: readonly unknown[]): readonly Record<string, unknown>[] => {
    const t = flat(text);
    if (t === "set transaction read only") return [];
    if (t === "select id, owner_address, wallet_address, status, session_facts from agents where id = $1") {
      return over.noAgent === true ? [] : [{ id: params[0], owner_address: OWNER.toLowerCase(), wallet_address: WALLET, status: "armed", session_facts: { publicKey: KEY, expiry: EXPIRY } }];
    }
    if (t === "select params from trade_settings where agent_id = $1 and owner_address = $2") {
      const settings = over.settings === undefined ? aiSettings() : over.settings;
      return settings === null ? [] : [{ params: settings }];
    }
    if (t.startsWith("select decision_id, idempotency_key, side, state, tx_hash, schedule_slot, portfolio_slot, position_id, token from trade_intents")) {
      return [{ decision_id: "ambiguous-sell", idempotency_key: JOURNAL_KEY, side: "sell", state: "pending", tx_hash: null, schedule_slot: null, portfolio_slot: null, position_id: "position", token: TOKEN }];
    }
    if (t.startsWith("select kind, state, idempotency_key, external_ref from execution_journal")) {
      return [{ kind: "trade", state: "UNKNOWN", idempotency_key: params[0], external_ref: { publicKey: KEY, sessionGeneration: 0 } }];
    }
    if (t.startsWith("select 1 as present from information_schema.columns")) return over.migrated === false ? [] : [{ present: 1 }];
    if (t === flat(DISPOSE_INERT_SELL_SQL)) return [{ decision_id: params[0] }];
    if (t.startsWith("insert into trade_runs")) return [];
    throw new Error(`unexpected statement: ${t.slice(0, 100)}`);
  };
  const client: SqlClient = {
    async query<Row>(text: string, params: readonly unknown[] = []) { statements.push({ text, params }); return { rows: answer(text, params) as unknown as readonly Row[] }; },
    transaction: (fn) => fn(client),
    close: async () => undefined,
  };
  return { client, statements };
}

/** A recording wrapper over a REAL client (the owned disposable cluster): every statement is kept, then forwarded. */
function spied(base: SqlClient) {
  const statements: Statement[] = [];
  const wrap = (client: SqlClient): SqlClient => ({
    async query(text: string, params?: readonly unknown[]) { statements.push({ text, params: params ?? [] }); return client.query(text, params) as never; },
    transaction: (fn) => client.transaction((tx) => fn(wrap(tx))),
    close: async () => undefined,
  });
  return { client: wrap(base), statements };
}

const readFinalized: InertReads["readFinalized"] = async (read) => verdict({ wallet: read.wallet });
const cli = (sql: SqlClient, apply: boolean, agentId = "agent-1") => runCli({ args: { agentId, apply }, sql, readFinalized, expected, print: () => undefined });

describe("the CLI composition (runCli) issues no DDL and only the two scoped writes", () => {
  it("--apply on a refused agent (another model, no settings row, unknown agent): only read-only selects, ZERO DDL, ZERO writes", async () => {
    for (const over of [{ settings: { ...DEFAULT_TRADE_SETTINGS, executionModel: "sigma" as const } }, { settings: null }, { noAgent: true }]) {
      const rec = recordingSql(over);
      await assert.rejects(cli(rec.client, true), /not a TradFi AI trade agent|No such agent/u, JSON.stringify(over));
      assert.deepEqual(rec.statements.filter(isWrite), [], "no write of any kind");
      assert.deepEqual(rec.statements.filter(isDdl), [], "no DDL");
      assert.equal(rec.statements.some((statement) => flat(statement.text).includes("information_schema")), false, "a refused agent never reaches the schema check");
    }
  });

  it("--apply on an unmigrated schema (no disposition_evidence column) is refused with a clear message: nothing is altered, nothing is written", async () => {
    const rec = recordingSql({ migrated: false });
    await assert.rejects(cli(rec.client, true), /trade_intents\.disposition_evidence does not exist.*Nothing was changed/u);
    assert.deepEqual(rec.statements.filter(isWrite), []);
    assert.equal(rec.statements.some((statement) => flat(statement.text).includes("information_schema")), true, "the refusal is a read-only schema check");
  });

  it("a normal --apply issues ZERO DDL and EXACTLY the guarded CAS plus one run insert, both bound to the one selected agent", async () => {
    const rec = recordingSql();
    const outcomes = await cli(rec.client, true, "agent-1");
    assert.deepEqual(outcomes, [{ decisionId: "ambiguous-sell", eligible: true, disposed: true }]);
    assert.deepEqual(rec.statements.filter(isDdl), []);
    const writes = rec.statements.filter(isWrite);
    assert.equal(writes.length, 2, writes.map((statement) => flat(statement.text).slice(0, 60)).join(" | "));
    const [cas, run] = writes as [Statement, Statement];
    assert.equal(cas.text, DISPOSE_INERT_SELL_SQL, "the plane's own guarded CAS text, not a copy");
    assert.deepEqual(cas.params.slice(0, 3), ["ambiguous-sell", "agent-1", OWNER.toLowerCase()]);
    assert.equal(parseInertEvidence(cas.params[3] as string)?.journalKey, JOURNAL_KEY);
    assert.match(flat(run.text), /^insert into trade_runs \(id, agent_id, owner_address, dry_run, reason, created_at, candidates, refusals, entries, exits, events\) values \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11::jsonb\)$/u);
    assert.deepEqual([run.params[1], run.params[2], run.params[3], run.params[4]], ["agent-1", OWNER.toLowerCase(), false, "ambiguous-sell-disposed"]);
    // The schema check is read-only and runs BEFORE the first write.
    const order = rec.statements.map((statement) => flat(statement.text).includes("information_schema") ? "schema" : isWrite(statement) ? "write" : "read");
    assert.equal(order.indexOf("schema") < order.indexOf("write"), true);
  });

  it("the dry-run composition performs ZERO writes and ZERO DDL", async () => {
    const rec = recordingSql();
    const outcomes = await cli(rec.client, false, "agent-1");
    assert.deepEqual(outcomes, [{ decisionId: "ambiguous-sell", eligible: true, disposed: false }]);
    assert.deepEqual(rec.statements.filter(isWrite), []);
    assert.equal(rec.statements.every((statement) => statement.text === "set transaction read only" || flat(statement.text).startsWith("select ")), true);
  });

  it("the reads are scoped: agent by id, settings by agent AND owner, pending intents by owner AND agent, the journal row by key AND agent", async () => {
    const rec = recordingSql();
    await cli(rec.client, false, "agent-1");
    const reads = rec.statements.filter((statement) => flat(statement.text) !== "set transaction read only").map((statement) => [flat(statement.text), statement.params] as const);
    assert.deepEqual(reads, [
      ["select id, owner_address, wallet_address, status, session_facts from agents where id = $1", ["agent-1"]],
      ["select params from trade_settings where agent_id = $1 and owner_address = $2", ["agent-1", OWNER.toLowerCase()]],
      ["select decision_id, idempotency_key, side, state, tx_hash, schedule_slot, portfolio_slot, position_id, token from trade_intents "
        + "where owner_address = $1 and agent_id = $2 and state = 'pending' and side = 'sell' order by created_at asc, decision_id asc", [OWNER.toLowerCase(), "agent-1"]],
      ["select kind, state, idempotency_key, external_ref from execution_journal where idempotency_key = $1 and agent_id = $2", [JOURNAL_KEY, "agent-1"]],
    ]);
  });
});

describe("the PostgreSQL layer (owned disposable cluster)", () => {
  let local: Awaited<ReturnType<typeof localPostgres>> = null;
  let sql: SqlClient | undefined;
  before(async () => {
    local = await localPostgres();
    if (local === null) return;
    sql = await createPgSqlClient(local.url);
    // Setup ONLY: the plane's own boot statements create the tables the script reads.
    const agents = await PostgresAgentStore.create(sql, Buffer.alloc(32, 7), () => 1_000);
    const settingsStore = await PostgresTradeSettingsStore.create(sql, () => 1_000);
    const intents = await PostgresTradeIntentStore.create(sql, () => 1_000);
    const journal = await PostgresExecutionJournal.create(sql, () => 1_000);
    await (await import("../src/store/tradePositions.js")).PostgresTradePositionStore.create(sql, () => 1_000);
    const facts: SessionFacts = { spec: { allowedCalls: [{ to: WALLET }], spendCaps: [{ limit: 1_000n, period: "day" }], expiresAt: EXPIRY }, permissions: { calls: [], spend: [] },
      publicKey: KEY, expiry: EXPIRY, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT" } };
    for (const [index, id] of ["agent-a", "agent-b", "agent-legacy"].entries()) {
      const wallet = getAddress(`0x20000000000000000000000000000000000000${(index + 10).toString(16).padStart(2, "0")}`);
      await agents.createAgent({ id, ownerAddress: OWNER, walletAddress: wallet, custodyModel: "passkey", sessionFacts: facts, status: "armed" });
      const settings = id === "agent-legacy" ? { ...DEFAULT_TRADE_SETTINGS, executionModel: "sigma" as const } : aiSettings();
      await settingsStore.put({ agentId: id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
      const key = `0x${(index + 1).toString(16).padStart(2, "0")}${"b1".repeat(31)}` as Hex;
      await intents.create({ decisionId: `${id}-sell`, idempotencyKey: key, agentId: id, ownerAddress: OWNER, side: "sell", token: TOKEN, route: { hops: [], fees: [] },
        amountWei: 9n, entryWei: 5n * E, positionId: `${id}-position`, closeReason: "llm", settlementAsset: "USDT" });
      await journal.begin({ idempotencyKey: key, agentId: id, ownerAddress: OWNER, kind: "trade", decisionId: `${id}-sell`, externalRef: { paramsHash: HASH, publicKey: KEY, sessionGeneration: 0 } });
      await journal.markUnknown(key, "provider error -32602: please assign a tracer");
    }
  });
  after(async () => { await sql?.close(); await local?.close(); });

  const walletOf = async (agent: string): Promise<Address> => getAddress((await sql!.query<{ readonly wallet_address: string }>("select wallet_address from agents where id = $1", [agent])).rows[0]!.wallet_address);
  const finalizedFor = (agent: string): InertReads["readFinalized"] => async (read) => {
    assert.equal(read.wallet, await walletOf(agent));
    return verdict({ wallet: read.wallet });
  };
  async function snapshot(): Promise<string> {
    const tables = ["agents", "trade_settings", "trade_intents", "execution_journal", "trade_runs"];
    const parts: string[] = [];
    for (const table of tables) parts.push(JSON.stringify((await sql!.query(`select * from ${table} order by 1`)).rows));
    parts.push(JSON.stringify((await sql!.query("select table_name from information_schema.tables where table_schema = 'public' order by 1")).rows));
    parts.push(JSON.stringify((await sql!.query("select column_name, table_name from information_schema.columns where table_schema = 'public' order by 2, 1")).rows));
    return parts.join("\n");
  }

  it("a read inside the script's read transaction cannot write (PostgreSQL refuses it)", async (t) => {
    if (sql === undefined) { t.skip("owned disposable PostgreSQL is unavailable"); return; }
    await assert.rejects(inReadOnlyTransaction(sql, (tx) => tx.query("update trade_intents set note = 'x'")), /read-only transaction/iu);
    await assert.rejects(inReadOnlyTransaction(sql, (tx) => tx.query("create table script_should_not_ddl (id int)")), /read-only transaction/iu);
  });

  it("dry-run changes NOTHING: no row, no table, no column, and no store initialisation", async (t) => {
    if (sql === undefined) { t.skip("owned disposable PostgreSQL is unavailable"); return; }
    const before = await snapshot();
    const lines: string[] = [];
    const outcomes = await runDisposeInert({ args: { agentId: "agent-a", apply: false }, reads: pgInertReads(sql, finalizedFor("agent-a")), writes: null, expected, print: (line) => lines.push(line) });
    assert.deepEqual(outcomes, [{ decisionId: "agent-a-sell", eligible: true, disposed: false }]);
    assert.match(lines.join("\n"), /eligible=yes/u);
    assert.equal(await snapshot(), before);
  });

  it("--apply disposes ONLY the selected agent's intent (both other agents are untouched) and leaves the journal row UNKNOWN", async (t) => {
    if (sql === undefined) { t.skip("owned disposable PostgreSQL is unavailable"); return; }
    const untouched = async () => JSON.stringify((await sql!.query("select decision_id, state, disposition_evidence from trade_intents where agent_id <> 'agent-a' order by 1")).rows);
    const journalBefore = JSON.stringify((await sql!.query("select idempotency_key, state, last_error from execution_journal order by 1")).rows);
    const others = await untouched();
    const spy = spied(sql);
    const outcomes = await runCli({ args: { agentId: "agent-a", apply: true }, sql: spy.client, readFinalized: finalizedFor("agent-a"), expected, print: () => undefined });
    assert.deepEqual(outcomes, [{ decisionId: "agent-a-sell", eligible: true, disposed: true }]);
    assert.deepEqual(spy.statements.filter(isDdl), [], "no statement of the whole apply is DDL");
    assert.equal(spy.statements.filter(isWrite).length, 2, "exactly the guarded CAS and one run insert");
    const row = (await sql.query<{ readonly state: string; readonly disposition_evidence: string | null }>("select state, disposition_evidence from trade_intents where decision_id = 'agent-a-sell'")).rows[0];
    assert.equal(row?.state, "rolled-back");
    assert.equal(parseInertEvidence(row?.disposition_evidence)?.journalKey, `0x01${"b1".repeat(31)}`);
    assert.equal(await untouched(), others, "agent-b and the legacy agent are untouched");
    assert.equal(JSON.stringify((await sql.query("select idempotency_key, state, last_error from execution_journal order by 1")).rows), journalBefore, "no journal row moves");
    const runs = (await sql.query<{ readonly agent_id: string; readonly reason: string }>("select agent_id, reason from trade_runs order by created_at")).rows;
    assert.deepEqual(runs, [{ agent_id: "agent-a", reason: "ambiguous-sell-disposed" }]);
    // Running --apply again changes nothing: the intent is no longer pending.
    const lines: string[] = [];
    const again = await runCli({ args: { agentId: "agent-a", apply: true }, sql, readFinalized: finalizedFor("agent-a"), expected, print: (line) => lines.push(line) });
    assert.deepEqual(again, []);
    assert.match(lines.join("\n"), /no pending sell intent for this agent/u, "a repeat apply finds nothing: the disposed row left the query");
  });

  it("refuses the legacy (non-AI) agent against the real tables: no change, no DDL, no write", async (t) => {
    if (sql === undefined) { t.skip("owned disposable PostgreSQL is unavailable"); return; }
    const before = await snapshot();
    const spy = spied(sql);
    await assert.rejects(runCli({ args: { agentId: "agent-legacy", apply: true }, sql: spy.client, readFinalized: finalizedFor("agent-legacy"), expected, print: () => undefined }),
      /not a TradFi AI trade agent/u);
    assert.equal(await snapshot(), before);
    assert.deepEqual(spy.statements.filter(isWrite), []);
  });

  it("an unmigrated schema (no disposition_evidence column) is refused with a message and is NOT altered", async (t) => {
    if (sql === undefined) { t.skip("owned disposable PostgreSQL is unavailable"); return; }
    // Test setup on the disposable cluster only: recreate the state of a plane that has not yet booted the new code.
    await sql.query("alter table trade_intents drop column disposition_evidence");
    try {
      const before = await snapshot();
      const spy = spied(sql);
      await assert.rejects(runCli({ args: { agentId: "agent-b", apply: true }, sql: spy.client, readFinalized: finalizedFor("agent-b"), expected, print: () => undefined }),
        /disposition_evidence does not exist/u);
      assert.equal(await snapshot(), before, "no column was added and no row changed");
      assert.deepEqual(spy.statements.filter(isWrite), []);
    } finally {
      await sql.query("alter table trade_intents add column if not exists disposition_evidence text");
    }
  });

  it("builds no worker, provider or signer and opens none of the plane's store factories", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("../scripts/tradfi-dispose-inert.ts", import.meta.url), "utf8");
    for (const forbidden of ["runTradeWorkerOnce", "AltanaProvider", "executeViaSession", "agentAuthorityFromPrivateKey", "loadMasterKey", "createAgentStore", "createTradeIntentStore", "createJournal",
      "PostgresTradeIntentStore", "PostgresTradePositionStore", ".create("]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
