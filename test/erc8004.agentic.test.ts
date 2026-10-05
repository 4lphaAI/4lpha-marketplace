import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { INVALID_IDENTITY, categoryForAgenticHire, categoryForHire, categoryForPreset, decodeIdentity, newIdentity, type IdentityJob, type IdentitySource } from "../src/identity/types.js";
import { metadataTemplate, metadataUri, metadataUriV2, metadataUriV3 } from "../src/identity/metadata.js";
import { validateLedger } from "../src/store/erc8004.js";
import { PostgresAgentStore } from "../src/store/agents.js";
import { PostgresIdentitySources } from "../src/store/erc8004Sources.js";
import { IdentityService } from "../src/identity/service.js";
import { MemoryIdentityFence } from "../src/identity/fence.js";
import { MemoryIdentityLedger } from "../src/store/erc8004.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { CONFIG, FixtureGateway, OWNER, fixture } from "./support/erc8004.js";

const REF = "00000000-0000-4000-8000-000000000001";
const MASTER = Buffer.alloc(32, 5);
const AGENTIC = [
  ["agentic-trade", "Trade", 1_317, "An AI trading agent for tokenized US stocks that trades with USDT from the owner's Binance Agentic Wallet on BNB Chain and pays for CoinMarketCap data with x402 from the same wallet. It buys when its rule scores and model agree. It sells on the owner's exit rules, and when the owner leaves take-profit, stop-loss or hold time open, it can also decide to exit on its own."],
  ["agentic-schedule", "Schedule", 1_189, "Buys one tokenized US stock with a fixed USDT amount on a recurring schedule from the owner's Binance Agentic Wallet on BNB Chain, and skips a buy when the on-chain price trades too far above the stock's reference price. It only buys, and the stock stays in the wallet."],
  ["agentic-dca", "DCA", 1_269, "Auto DCA for one tokenized US stock from the owner's Binance Agentic Wallet on BNB Chain. It opens each round with a USDT market buy, buys more at set price steps below that entry, and sells the round's stock at market when the price reaches the take-profit above its average cost. A stop-loss or the end of the term ends it without selling."],
  ["agentic-portfolio", "Portfolio", 1_197, "Holds a weighted basket of tokenized US stocks in the owner's Binance Agentic Wallet on BNB Chain. On the chosen interval it rebalances with USDT toward the owner's target weights when the drift reaches the owner's threshold, and at the end of the term it keeps the stocks."],
] as const;

test("T1 categoryForAgenticHire maps the four predicates and fails closed on anything else", () => {
  const base = { executionModel: "tradfi", settlementAsset: "USDT" };
  assert.equal(categoryForAgenticHire(base), "agentic-trade");
  assert.equal(categoryForAgenticHire({ ...base, tradeMode: "schedule" }), "agentic-schedule");
  assert.equal(categoryForAgenticHire({ ...base, tradeMode: "dca" }), "agentic-dca");
  assert.equal(categoryForAgenticHire({ ...base, tradeMode: "portfolio" }), "agentic-portfolio");
  for (const bad of [{ executionModel: "tradfi" }, { executionModel: "tradfi", settlementAsset: "USDC" }, { ...base, executionModel: "sigma" }, { ...base, executionModel: "degen", tradeMode: "dca" },
    { ...base, tradeMode: "grid" }, { ...base, tradeMode: null }, { ...base, tradeMode: "" }, undefined, null, "tradfi", 7, [base]]) assert.equal(categoryForAgenticHire(bad), null);
  for (const preset of ["grid-v1", "grid-shift-v1", "trade-v1", "lp-v1", "lending-v1", "unknown", undefined]) assert.ok(!String(categoryForPreset(preset)).startsWith("agentic-"));
  const rows: readonly unknown[] = [undefined, null, { executionModel: "tradfi", settlementAsset: "USDT" }, ...["schedule", "dca", "portfolio", "grid", null].map((tradeMode) => ({ executionModel: "tradfi", settlementAsset: "USDT", tradeMode })),
    { executionModel: "sigma", tradeMode: "dca" }, { executionModel: "tradfi" }];
  for (const preset of ["grid-v1", "grid-shift-v1", "trade-v1", "lp-v1", "lending-v1", "unknown", undefined]) for (const row of rows) assert.ok(!String(categoryForHire(preset, row)).startsWith("agentic-"));
});

test("T2 every pre-existing URI is byte identical to the one computed on 08ba511", () => {
  const ids = [null, "0", "1", "115792089237316195423570985008687907853269984665640564039457584007913129639935"], numbers = [1, 17, 9007199254740991];
  const legacy = ["grid", "trading", "lp", "lending"] as const, v3 = [...legacy, "tradfi-trade", "tradfi-schedule", "tradfi-dca", "tradfi-portfolio"] as const;
  const out: string[] = [];
  for (const c of legacy) for (const id of ids) out.push(metadataUri(c, REF, id));
  for (const c of legacy) for (const n of numbers) for (const id of ids) out.push(metadataUriV2(c, n, REF, id));
  for (const c of v3) for (const n of numbers) for (const id of ids) out.push(metadataUriV3(c, n, REF, id));
  for (const c of v3) out.push(JSON.stringify(metadataTemplate(c)));
  assert.equal(out.length, 168);
  assert.equal(createHash("sha256").update(out.join("\n")).digest("hex"), "a68602b0cfc6330ae9e4da80d817234d3a859822a85088c286ecd932037daca3");
});

for (const [category, mode, bytes, description] of AGENTIC) test(`T3 ${category}: v3 copy, template, size, legacy versions refuse`, () => {
  const uri = metadataUriV3(category, 1, REF);
  const value: unknown = JSON.parse(Buffer.from(uri.split(",")[1]!, "base64").toString("utf8"));
  assert.ok(value !== null && typeof value === "object");
  const record = value as Record<string, unknown>;
  assert.equal(record.name, `Agentic ${mode} Agent 1 by 4LPHA`);
  assert.equal(record.description, description);
  const x = record.x4lpha as Record<string, unknown>;
  assert.equal(x.category, category); assert.equal(x.identityCustody, "platform-minter");
  assert.deepEqual((record.services as { name: string }[]).map((service) => service.name), ["MCP", "web", "X"]);
  assert.equal(Buffer.byteLength(uri), bytes);
  assert.equal(metadataTemplate(category).name, `4lpha Agentic ${mode}`);
  assert.equal(metadataTemplate(category).description, description);
  assert.throws(() => metadataUri(category, REF), /invalid_identity/);
  assert.throws(() => metadataUriV2(category, 1, REF), /invalid_identity/);
  assert.ok(!description.includes(String.fromCharCode(0x2014)));
  assert.ok(/^[\x20-\x7e]+$/.test(description));
});

test("T4 ledger: agentic jobs require metadataVersion 3, tradfi and agentic v3 jobs both pass", async () => {
  const f = fixture();
  f.sources.rows.set("agent", { id: "agent", owner: OWNER, identity: newIdentity("agentic-dca"), existingId: null, category: null, eligible: false });
  f.sources.rows.set("tf", { id: "tf", owner: OWNER, identity: newIdentity("tradfi-trade"), existingId: null, category: null, eligible: true });
  await f.service.discover();
  const state = await f.ledger.read();
  const agentic = state.jobs.find((job) => job.category === "agentic-dca")!, tradfi = state.jobs.find((job) => job.category === "tradfi-trade")!;
  assert.equal(agentic.metadataVersion, 3); assert.equal(tradfi.metadataVersion, 3);
  validateLedger({ ...state, jobs: [tradfi] }, CONFIG); validateLedger({ ...state, jobs: [agentic] }, CONFIG);
  for (const metadataVersion of [1, 2, undefined] as const) {
    const job: IdentityJob = { ...agentic, ...(metadataVersion === undefined ? {} : { metadataVersion }) };
    if (metadataVersion === undefined) delete (job as { metadataVersion?: number }).metadataVersion;
    assert.throws(() => validateLedger({ ...state, jobs: [job] }, CONFIG), /intent_mismatch/);
  }
});

for (const postgres of [false, true]) test(`T5 ${postgres ? "SQL fake" : "memory"}: Agentic numbering is per wallet and category and ignores other categories of the same owner`, async () => {
  const f = fixture(postgres);
  const add = async (id: string, category: Parameters<typeof newIdentity>[0]): Promise<void> => {
    f.sources.rows.set(id, { id, owner: OWNER, identity: newIdentity(category), existingId: null, category: null, eligible: true });
    await f.service.discover(id);
  };
  await add("tf", "tradfi-trade"); await add("tr", "trading");
  await add("a1", "agentic-trade"); await add("a2", "agentic-trade"); await add("s1", "agentic-schedule");
  const number = async (category: string): Promise<(number | undefined)[]> => (await f.ledger.read()).jobs.filter((job) => job.category === category).map((job) => job.displayNumber);
  assert.deepEqual(await number("agentic-trade"), [1, 2]);
  assert.deepEqual(await number("agentic-schedule"), [1]);
  assert.deepEqual(await number("tradfi-trade"), [1]);
});

function agenticSql(fake: FakeSqlClient, settingsTable: boolean): { sql: SqlClient; settingsReads: () => number } {
  let reads = 0;
  const sql: SqlClient = {
    async query<Row>(text: string, params?: readonly unknown[]): Promise<SqlResult<Row>> {
      if (text.includes("to_regclass('trade_settings')")) return { rows: [{ name: settingsTable ? "trade_settings" : null }] as Row[] };
      if (text.includes("select params from trade_settings")) { reads++; return { rows: [{ params: { executionModel: "tradfi", settlementAsset: "USDT" } }] as Row[] }; }
      return fake.query<Row>(text, params);
    },
    transaction: (fn) => fn(sql), close: async () => {},
  };
  return { sql, settingsReads: () => reads };
}

test("T6 manual enroll still refuses an Agentic-shaped row with and without a trade_settings table", async () => {
  for (const present of [false, true]) {
    const fake = new FakeSqlClient();
    const store = await PostgresAgentStore.create(fake, MASTER);
    await store.createAgent({ id: "ag", ownerAddress: OWNER, walletAddress: OWNER, custodyModel: "binance-agentic", status: "armed", httpRuntimeProfile: "unbound-v1" });
    const { sql, settingsReads } = agenticSql(fake, present);
    const sources = new PostgresIdentitySources(sql);
    for (const category of [undefined, "trading", "tradfi-trade"] as const) await assert.rejects(sources.enroll("ag", category), /ineligible/);
    assert.equal(settingsReads(), present ? 3 : 0);
    assert.equal((await store.getAgent(OWNER, "ag"))!.erc8004Identity ?? null, null);
  }
});

test("T7 the identity worker runs an Agentic row offline: v3 job, number 1, register, update, registered", async () => {
  const fake = new FakeSqlClient();
  const store = await PostgresAgentStore.create(fake, MASTER);
  await store.createAgent({ id: "ag", ownerAddress: OWNER, walletAddress: OWNER, custodyModel: "binance-agentic", status: "armed", httpRuntimeProfile: "unbound-v1" });
  assert.equal(await store.enrollAgenticIdentity({ ownerAddress: OWNER, agentId: "ag", category: "agentic-portfolio" }), true);
  const sources = new PostgresIdentitySources(fake);
  const read = async (): Promise<IdentitySource> => (await sources.get("ag"))!;
  const first = await read();
  assert.equal(first.category, null); assert.equal(first.eligible, false);
  assert.deepEqual((await sources.enrolled()).map((source) => source.id), ["ag"]);
  assert.equal((first.identity as { category: string }).category, "agentic-portfolio");
  const ledger = new MemoryIdentityLedger(CONFIG), gateway = new FixtureGateway();
  let now = 1_000_000;
  const service = () => new IdentityService(CONFIG, ledger, sources, gateway, new MemoryIdentityFence(), () => now);
  await service().discover();
  let state = await ledger.read();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0]!.category, "agentic-portfolio"); assert.equal(state.jobs[0]!.metadataVersion, 3); assert.equal(state.jobs[0]!.displayNumber, 1);
  assert.equal(state.jobs[0]!.owner.toLowerCase(), OWNER.toLowerCase());
  assert.equal((await service().step("ag", 11_000n)).status, "registering");
  state = await ledger.read(); await gateway.land(state.transactions[0]!, state.jobs[0]!.initialUri);
  assert.equal((await service().step("ag")).status, "updating");
  assert.equal((await service().step("ag")).status, "updating");
  state = await ledger.read(); await gateway.land(state.transactions[1]!, state.jobs[0]!.finalUri!);
  assert.equal((await service().step("ag")).status, "registered");
  const done = await read();
  assert.equal(done.existingId, "0");
  const identity = done.identity as { status: string; agentId: string | null; revision: number; category: string };
  assert.equal(identity.status, "registered"); assert.equal(identity.agentId, "0"); assert.equal(identity.category, "agentic-portfolio"); assert.ok(identity.revision > 1);
  const agent = (await store.getAgent(OWNER, "ag"))!;
  assert.equal(agent.erc8004AgentId, "0");
  assert.equal(JSON.stringify(agent.erc8004Identity), JSON.stringify(done.identity));
});

test("T8 a stored category outside the union is skipped by the daemon discover and refused by a selected one", async () => {
  const f = fixture();
  const identity = decodeIdentity({ ...newIdentity("grid"), category: "agentic-unknown" });
  assert.deepEqual(identity, INVALID_IDENTITY);
  f.sources.rows.set("odd", { id: "odd", owner: OWNER, identity, existingId: null, category: null, eligible: false });
  f.sources.rows.delete("agent");
  await f.service.discover();
  assert.equal((await f.ledger.read()).jobs.length, 0);
  await assert.rejects(f.service.discover("odd"), /invalid_identity/);
});
