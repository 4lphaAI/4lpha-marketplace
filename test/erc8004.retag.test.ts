import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryIdentityFence } from "../src/identity/fence.js";
import { retagTradfi } from "../src/identity/retag.js";
import { fail, newIdentity, type Erc8004IdentitySummary } from "../src/identity/types.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import { OWNER } from "./support/erc8004.js";

type Agent = { id: string; owner_address: string; status: string; erc8004_identity: Erc8004IdentitySummary; erc8004_agent_id: string | null; row_version: number };
class RetagSql implements SqlClient {
  agents: Agent[] = [];
  settings = new Map<string, unknown>();
  jobs: { public_ref: string; owner_address: string; source_id: string }[] = [];
  statements: string[] = [];
  casMiss = false;
  add(id: string, params?: unknown, status = "armed") {
    const row = { id, owner_address: OWNER, status, erc8004_identity: newIdentity("trading"), erc8004_agent_id: null, row_version: 7 };
    this.agents.push(row);
    if (params !== undefined) this.settings.set(id, params);
    return row;
  }
  async query<Row>(text: string, params: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push(text);
    let rows: unknown[];
    if (text.includes("/* retag.agents */")) {
      assert.match(text, /for update of a/);
      assert.match(text, /a\.erc8004_identity->>'status'='pending'/);
      assert.match(text, /a\.erc8004_identity->>'category'='trading'/);
      assert.match(text, /a\.erc8004_agent_id is null and not exists/);
      assert.match(text, /j\.public_ref=a\.erc8004_identity->>'publicRef'/);
      assert.match(text, /lower\(j\.owner_address\)=lower\(a\.owner_address\) and j\.source_id=a\.id/);
      assert.doesNotMatch(text, /minter|a\.status=/);
      rows = this.agents.filter((row) => row.erc8004_identity.category === "trading" && row.erc8004_identity.status === "pending" && row.erc8004_agent_id === null
        && !this.jobs.some((job) => job.public_ref === row.erc8004_identity.publicRef || job.owner_address.toLowerCase() === row.owner_address.toLowerCase() && job.source_id === row.id));
    } else if (text.includes("/* retag.settings */")) {
      assert.equal(params[1], OWNER);
      const id = String(params[0]);
      rows = this.settings.has(id) ? [{ params: this.settings.get(id) }] : [];
    } else if (text.includes("/* retag.update */")) {
      assert.match(text, /where id=\$1 and owner_address=\$2 and erc8004_identity=\$4::jsonb and erc8004_agent_id is null/);
      assert.doesNotMatch(text, /row_version|updated_at/);
      const row = this.agents.find((row) => row.id === params[0] && row.owner_address === params[1]);
      assert.ok(row);
      assert.deepEqual(JSON.parse(String(params[3])), row.erc8004_identity);
      rows = this.casMiss ? [] : [{ id: row.id }];
      if (!this.casMiss) row.erc8004_identity = JSON.parse(String(params[2])) as Erc8004IdentitySummary;
    } else throw new Error("Unexpected retag statement");
    return { rows: structuredClone(rows) as Row[] };
  }
  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const before = structuredClone(this.agents);
    try { return await fn(this); } catch (error) { this.agents = before; throw error; }
  }
  async close() {}
}
const fence = async () => new MemoryIdentityFence();

test("retag dry run writes nothing, apply changes only eligible rows and a second apply is a no-op", async () => {
  const sql = new RetagSql();
  sql.add("trade", { executionModel: "tradfi" });
  sql.add("schedule", { executionModel: "tradfi", tradeMode: "schedule" }, "revoked");
  sql.add("dca", { executionModel: "tradfi", tradeMode: "dca" });
  sql.add("portfolio", { executionModel: "tradfi", tradeMode: "portfolio" });
  sql.add("sigma", { executionModel: "sigma" });
  sql.add("missing");
  const byRef = sql.add("job-ref", { executionModel: "tradfi" });
  const bySource = sql.add("job-source", { executionModel: "tradfi" });
  sql.jobs.push({ public_ref: byRef.erc8004_identity.publicRef, owner_address: "another-owner", source_id: "other-source" },
    { public_ref: newIdentity("trading").publicRef, owner_address: bySource.owner_address.toUpperCase(), source_id: bySource.id });
  const before = structuredClone(sql.agents);
  const dry = await retagTradfi(sql, false, fence);
  assert.equal(dry.apply, false);
  assert.deepEqual(sql.agents, before);
  assert.ok(sql.statements.every((text) => !text.includes("/* retag.update */")));
  assert.deepEqual(dry.rows.map((row) => [row.id, row.action]), [["trade", "would-retag"], ["schedule", "would-retag"], ["dca", "would-retag"], ["portfolio", "would-retag"], ["sigma", "skip:not-tradfi"], ["missing", "skip:no-settings"]]);
  const applied = await retagTradfi(sql, true, fence);
  assert.equal(applied.apply, true);
  assert.equal(applied.rows.find((row) => row.id === "schedule")!.status, "revoked");
  for (const [index, category] of ["tradfi-trade", "tradfi-schedule", "tradfi-dca", "tradfi-portfolio"].entries()) {
    assert.deepEqual(sql.agents[index], { ...before[index], erc8004_identity: { ...before[index]!.erc8004_identity, category, revision: 2 } });
    assert.equal(applied.rows[index]!.action, "retag");
    assert.equal(applied.rows[index]!.from, "trading");
    assert.equal(applied.rows[index]!.to, category);
  }
  assert.deepEqual(sql.agents.slice(4), before.slice(4));
  const retained = structuredClone(sql.agents);
  sql.statements = [];
  const second = await retagTradfi(sql, true, fence);
  assert.deepEqual(second.rows.map((row) => row.action), ["skip:not-tradfi", "skip:no-settings"]);
  assert.deepEqual(sql.agents, retained);
  assert.ok(sql.statements.every((text) => !text.includes("/* retag.update */")));
});

test("retag reports a CAS miss once without retrying", async () => {
  const sql = new RetagSql(); sql.add("miss", { executionModel: "tradfi" }); sql.casMiss = true;
  const before = structuredClone(sql.agents);
  const result = await retagTradfi(sql, true, fence);
  assert.equal(result.rows[0]!.action, "skip:cas-miss");
  assert.equal(sql.statements.filter((text) => text.includes("/* retag.update */")).length, 1);
  assert.deepEqual(sql.agents, before);
});

test("retag lock_busy stops before any read", async () => {
  const sql = new RetagSql();
  await assert.rejects(retagTradfi(sql, true, async () => fail("lock_busy")), /lock_busy/);
  assert.deepEqual(sql.statements, []);
});
