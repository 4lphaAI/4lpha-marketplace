/** AGENTIC-ERC8004: the pending identity mark is written by the pairing sweep, for a bound / active hire only, by one store CAS. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getAddress, type Address } from "viem";
import { IdentityError, validIdentity, type IdentityCategory } from "../src/identity/types.js";
import { MemoryAgentStore, PostgresAgentStore, type AgentStore } from "../src/store/agents.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import type { TradeSettings } from "../src/trade/settings.js";
import { tradeSettingsDigest } from "../src/trade/settings.js";
import { agenticHireIdentity, parseAgenticHireParams, type AgenticWallet } from "../src/agentic/domain.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { localPostgres } from "./support/localPostgres.js";
import { PAIRED, PAIRING, W, aiParams, fixture, scheduleParams, type Fixture } from "./support/agenticSchedule.js";
import { dcaParams } from "./support/agenticDca.js";
import { portfolioParams } from "./support/agenticPortfolio.js";

const AGENT = "agentic-fixture";
const request = (settings: TradeSettings) => ({ pairingId: PAIRING, term: 7, termEndAction: "keep", executionModel: "tradfi",
  hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings });
const quiet = (t: TestContext): void => { t.mock.method(console, "error", () => undefined); };
const identityOf = async (f: Fixture, id = AGENT) => (await f.agents.getAgentById(id))?.erc8004Identity ?? null;

test("T9 the hire path writes no mark; one sweep writes a pending agentic-trade identity at revision 1 and a second changes nothing", async t => {
  quiet(t);
  const f = await fixture(t, PAIRED);
  const hired = await f.pairings.hire(f.row, request(aiParams));
  assert.equal(hired.state, "bound"); assert.equal(hired.hireStage, "active");
  assert.equal(await identityOf(f, hired.agentId!), null);
  await f.pairings.sweep();
  const marked = await identityOf(f, hired.agentId!);
  assert.ok(validIdentity(marked));
  assert.equal(marked.category, "agentic-trade"); assert.equal(marked.status, "pending"); assert.equal(marked.revision, 1); assert.equal(marked.agentId, null);
  const record = (await f.agents.getAgentById(hired.agentId!))!;
  await f.pairings.sweep();
  const again = (await f.agents.getAgentById(hired.agentId!))!;
  assert.deepEqual(again.erc8004Identity, marked); assert.equal(again.rowVersion, record.rowVersion);
});

for (const [category, settings] of [["agentic-schedule", scheduleParams], ["agentic-dca", dcaParams()], ["agentic-portfolio", portfolioParams], ["agentic-trade", aiParams]] as const)
  test(`T9 a bound / active ${category} row gets its category from one sweep`, async t => {
    quiet(t);
    const f = await fixture(t, {}, settings);
    assert.equal(await identityOf(f), null);
    await f.pairings.sweep();
    const marked = await identityOf(f);
    assert.ok(validIdentity(marked)); assert.equal(marked.category, category); assert.equal(marked.status, "pending"); assert.equal(marked.revision, 1);
  });

test("T9 I9 the sweep mark takes no wallet fence: it is written while another holder owns the fence and touches no fence call", async t => {
  quiet(t);
  const f = await fixture(t, {}, aiParams);
  const held = await f.store.acquireFence(W, "other-holder");
  assert.ok(held !== null);
  const calls = [t.mock.method(f.store, "acquireFence"), t.mock.method(f.store, "renewFence"), t.mock.method(f.store, "releaseFence")];
  await f.pairings.sweep();
  const marked = await identityOf(f);
  assert.ok(validIdentity(marked)); assert.equal(marked.category, "agentic-trade");
  assert.deepEqual(calls.map((call) => call.mock.callCount()), [0, 0, 0]);
});

const NOT_ACTIVE:readonly [string, Partial<AgenticWallet>][] = [
  ...["accepted", "gated", "agent-created", "settings-stored", "cmc-initialized"].map((hireStage): [string, Partial<AgenticWallet>] => [`hiring ${hireStage}`, { state: "hiring", hireStage }]),
  ["cleaning", { state: "cleaning", cleanupReason: "gate-failed", failure: "gate-rows" }],
  ["failed", { state: "failed" }], ["expired", { state: "expired" }],
  ["ending", { state: "ending", endReason: "owner-signed-out", endStage: "stopped" }], ["ended", { state: "ended", endReason: "owner-signed-out" }],
  ["bound cmc-initialized", { state: "bound", hireStage: "cmc-initialized" }], ["bound null", { state: "bound", hireStage: null }], ["bound failed", { state: "bound", hireStage: "failed" }],
];
for (const [label, initial] of NOT_ACTIVE) test(`T10 a ${label} row gets no identity from the sweep`, async t => {
  quiet(t);
  const f = await fixture(t, initial);
  await f.pairings.sweep();
  assert.equal(await identityOf(f), null);
});

test("T11 a gate failure writes no agent row and no identity", async t => {
  quiet(t);
  const f = await fixture(t, PAIRED);
  f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { tradeAllTokens: false, abnormalTxnHandling: "AutoReject", dailyLimit: 1_000, quotaUsed: 0,
    x402DailyLimit: 20, x402QuotaUsed: 0, signInMaxTime: new Date(1_900_000_000_000 + 90 * 86_400_000).toISOString(), sessionExpireTime: null, inactiveSignOutTime: null } });
  const body = parseAgenticHireParams(request(aiParams))!, identity = agenticHireIdentity(body);
  await assert.rejects(() => f.pairings.hire(f.row, request(aiParams)));
  assert.ok(["cleaning", "failed"].includes((await f.store.getWallet(PAIRING))!.state));
  f.runner.replies.set("auth signout", { kind: "ok", sessionPresent: false, rwaTokens: null, data: { status: "LOGGED_OUT" } });
  await f.pairings.sweep(); await f.pairings.sweep();
  assert.equal(await f.agents.getAgentById(identity.agentId), null);
  assert.equal(await identityOf(f), null);
});

test("T11 a hire failing after agent-created stays hiring and its armed agent row has no identity after the sweep", async t => {
  quiet(t);
  const f = await fixture(t, PAIRED);
  const body = parseAgenticHireParams(request(aiParams))!, identity = agenticHireIdentity(body);
  await f.agents.createAgent({ id: identity.agentId, ownerAddress: W, walletAddress: W, custodyModel: "binance-agentic", status: "armed", httpRuntimeProfile: "unbound-v1" });
  const other: TradeSettings = { ...aiParams, name: "Conflicting settings" };
  await f.settings.put({ ownerAddress: W, agentId: identity.agentId, params: other, digest: tradeSettingsDigest(other) });
  await assert.rejects(() => f.pairings.hire(f.row, request(aiParams)), /conflict/);
  const row = (await f.store.getWallet(PAIRING))!;
  assert.equal(row.state, "hiring"); assert.equal(row.hireStage, "agent-created");
  await f.pairings.sweep();
  assert.equal(await identityOf(f, identity.agentId), null);
  f.setTime(1_900_000_000_000 + 61_000);
  await f.pairings.sweep();
  assert.equal((await f.store.getWallet(PAIRING))?.state, "hiring");
  assert.equal(await identityOf(f, identity.agentId), null);
});

test("T14 a bound row whose signed settings map to no category gets no identity and the sweep does not throw", async t => {
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
  const grid = { ...aiParams, tradeMode: "grid" } as unknown as TradeSettings;
  const f = await fixture(t, { hireParams: { pairingId: PAIRING, term: 7, termEndAction: "keep", executionModel: "tradfi", hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", settings: grid, acceptedDedicatedWallet: true } });
  await f.pairings.sweep();
  assert.equal(await identityOf(f), null);
  assert.deepEqual(logged, []);
});

const OWNER2 = getAddress("0x4444444444444444444444444444444444444444");
const pendingFor = (id: string) => ({ ...PENDING, publicRef: "00000000-0000-4000-8000-" + Buffer.from(id.padEnd(6, "_")).toString("hex").slice(0, 12) });
const PENDING = { version: 1, publicRef: "00000000-0000-4000-8000-0000000000aa", revision: 4, category: "agentic-trade", status: "pending", agentId: null, registrationTxHash: null, uriUpdateTxHash: null, errorCode: null };
const wallet = (id: string): Address => getAddress("0x" + Buffer.from(id.padEnd(20, "_")).toString("hex").slice(0, 40));
const HASH = `0x${"ab".repeat(32)}`;
const REGISTERED = { ...PENDING, status: "registered", agentId: "7", registrationTxHash: HASH, uriUpdateTxHash: HASH };

type Case = { readonly label: string; readonly setIdentity?: (id: string, json: string) => Promise<void> | void; readonly statements?: () => readonly string[] };
async function casCases(store: AgentStore, c: Case): Promise<void> {
  const make = async (id: string, patch: Partial<Parameters<AgentStore["createAgent"]>[0]> = {}) =>
    store.createAgent({ id, ownerAddress: W, walletAddress: wallet(id), custodyModel: "binance-agentic", status: "armed", httpRuntimeProfile: "unbound-v1", ...patch });
  const enroll = (id: string, category: IdentityCategory = "agentic-trade", owner: Address = W) => store.enrollAgenticIdentity({ ownerAddress: owner, agentId: id, category });
  const before = await make("a1");
  assert.equal(await enroll("a1"), true);
  const written = (await store.getAgent(W, "a1"))!;
  assert.ok(validIdentity(written.erc8004Identity)); assert.equal(written.erc8004Identity.category, "agentic-trade"); assert.equal(written.erc8004Identity.revision, 1);
  assert.equal(written.rowVersion, before.rowVersion); assert.equal(written.updatedAt, before.updatedAt);
  assert.equal(await enroll("a1", "agentic-dca"), false);
  assert.deepEqual((await store.getAgent(W, "a1"))!.erc8004Identity, written.erc8004Identity);
  await make("a2", { erc8004AgentId: "9" });
  assert.equal(await enroll("a2"), false); assert.equal((await store.getAgent(W, "a2"))!.erc8004Identity ?? null, null);
  if (c.setIdentity !== undefined) for (const [id, json] of [["a3", JSON.stringify({ ...REGISTERED, publicRef: pendingFor("a3").publicRef })], ["a4", JSON.stringify({ bogus: 1 })], ["a5", JSON.stringify(pendingFor("a5"))]] as const) {
    await make(id); await c.setIdentity(id, json);
    const kept = (await store.getAgent(W, id))!.erc8004Identity;
    assert.equal(await enroll(id), false); assert.deepEqual((await store.getAgent(W, id))!.erc8004Identity, kept);
  }
  await make("a6", { status: "paused" }); assert.equal(await enroll("a6"), true);
  await make("a7", { status: "revoked" }); assert.equal(await enroll("a7"), false);
  await make("a8", { custodyModel: "passkey" }); assert.equal(await enroll("a8"), false);
  await make("a9", { custodyModel: "self-eoa" }); assert.equal(await enroll("a9"), false);
  for (const id of ["a8", "a9", "a7"]) assert.equal((await store.getAgent(W, id))!.erc8004Identity ?? null, null);
  await make("b1"); assert.equal(await enroll("b1", "agentic-trade", OWNER2), false); assert.equal(await enroll("missing"), false);
  assert.equal((await store.getAgent(W, "b1"))!.erc8004Identity ?? null, null);
  for (const category of ["tradfi-trade", "grid", "trading", "lp"] as const) await assert.rejects(enroll("b1", category), (error: unknown) => error instanceof IdentityError && error.code === "invalid_identity");
  await make("b2");
  const results = await Promise.all([enroll("b2"), enroll("b2")]);
  assert.deepEqual(results.slice().sort(), [false, true]);
  if (c.statements !== undefined) {
    const sql = c.statements().find((text) => text.includes("/* agents.enrollAgenticIdentity */"))!;
    for (const part of ["custody_model = 'binance-agentic'", "erc8004_identity is null", "erc8004_agent_id is null", "status in ('armed','paused')"]) assert.ok(sql.includes(part), part);
    assert.ok(!sql.includes("row_version"));
  }
}

test("T12 store CAS in memory", async () => { await casCases(new MemoryAgentStore(Buffer.alloc(32, 5), () => 1000), { label: "memory" }); });
test("T12 store CAS over the SQL fake", async () => {
  const fake = new FakeSqlClient();
  await casCases(await PostgresAgentStore.create(fake, Buffer.alloc(32, 5), () => 1000), { label: "fake", setIdentity: (id, json) => fake.setAgentIdentityForTest(id, json), statements: () => fake.observedStatementsForTest() });
});
test("T13 store CAS on real PostgreSQL", { timeout: 120_000 }, async t => {
  const cluster = await localPostgres();
  if (cluster === null) { t.skip("PostgreSQL 17 binaries unavailable; no external database fallback"); return; }
  const sql: SqlClient = await createPgSqlClient(cluster.url);
  t.after(async () => { await sql.close(); await cluster.close(); });
  const store = await PostgresAgentStore.create(sql, Buffer.alloc(32, 5), () => 1000);
  await casCases(store, { label: "postgres", setIdentity: async (id, json) => { await sql.query("update agents set erc8004_identity = $2::jsonb where id = $1", [id, json]); } });
});

