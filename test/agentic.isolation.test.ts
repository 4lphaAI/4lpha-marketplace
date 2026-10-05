import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { MemoryAgentStore, PostgresAgentStore, type AgentStore } from "../src/store/agents.js";
import { MemoryTradeSettingsStore, PostgresTradeSettingsStore, type TradeSettingsStore, type TradeWorkerSettingsPage } from "../src/store/tradeSettings.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest } from "../src/trade/settings.js";
import { altanaAgentStore, excludeCustody } from "../src/agentic/domain.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const NOW = 1_900_000_000_000;
class SettingsPageSql implements SqlClient {
  readonly rows: Record<string, unknown>[] = [];
  async query<R>(text: string, p: readonly unknown[] = []): Promise<SqlResult<R>> {
    if (!text.includes("tradeSettings.list")) return { rows: [] };
    const rows = this.rows.filter(r => p[0] === null || String(r["agent_id"]) > String(p[0]))
      .sort((a, b) => String(a["agent_id"]).localeCompare(String(b["agent_id"]))).slice(0, Number(p[1]));
    return { rows: structuredClone(rows) as R[] };
  }
  transaction<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> { return fn(this); }
  async close(): Promise<void> {}
}

describe("Agentic custody isolation", () => {
  for (const backend of ["memory", "postgres"] as const) for (const count of [31, 32, 33]) for (const trailing of [false, true]) {
    it(`${backend}: ${count} Altana rows, trailing Agentic=${trailing}, worker and projection pages equal Altana-only`, async () => {
      const agents = new MemoryAgentStore(null, () => NOW);
      const sql = new SettingsPageSql();
      const settings: TradeSettingsStore = backend === "memory" ? new MemoryTradeSettingsStore(agents, () => NOW) : await PostgresTradeSettingsStore.create(sql, () => NOW);
      const baseline = new MemoryTradeSettingsStore(agents, () => NOW);
      for (let i = 0; i < count + Number(trailing); i += 1) {
        const id = i < count ? `a${String(i).padStart(2, "0")}` : "agentic-trailing";
        await agents.createAgent({ id, ownerAddress: OWNER, walletAddress: getAddress(`0x${(i + 100).toString(16).padStart(40, "0")}`),
          custodyModel: i < count ? "passkey" : "binance-agentic", status: "armed" });
        const record = { agentId: id, ownerAddress: OWNER, params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) };
        if (i < count) await baseline.put(record);
        if (backend === "memory") await settings.put(record);
        else sql.rows.push({ agent_id: id, owner_address: OWNER, params: record.params, digest: record.digest, updated_at: new Date(NOW), draining_at: null });
      }
      const view = excludeCustody(settings, agents);
      for (const method of ["listTradeAgentsForWorker", "listTradeAgentsForProjection"] as const) {
        let cursor: string | null = null;
        do {
          const page: TradeWorkerSettingsPage = await view[method]({ limit: 32, cursor });
          const expected: TradeWorkerSettingsPage = await baseline[method]({ limit: 32, cursor });
          assert.deepEqual(page, expected);
          if (!page.hasMore) assert.equal(page.cursor, null);
          cursor = page.cursor;
        } while (cursor !== null);
      }
    });
  }
  for (const backend of ["memory", "postgres"] as const) for (const first of [false, true]) {
    it(`${backend}: account bound excludes an Agentic row sorting ${first ? "first" : "last"} before hasMore`, async () => {
      const agents: AgentStore = backend === "memory" ? new MemoryAgentStore(null, () => NOW)
        : await PostgresAgentStore.create(new FakeSqlClient(), null, () => NOW);
      for (let i = 0; i < 33; i += 1) await agents.createAgent({ id: i === 32 ? first ? "000-agentic" : "zz-agentic" : `a${String(i).padStart(2, "0")}`,
        ownerAddress: OWNER, walletAddress: getAddress(`0x${(i + 100).toString(16).padStart(40, "0")}`),
        custodyModel: i === 32 ? "binance-agentic" : "passkey", status: "armed" });
      const view = altanaAgentStore(agents);
      const page = await view.listAgentsBounded(OWNER, 32);
      assert.equal(page.rows.length, 32); assert.equal(page.hasMore, false);
      const hidden = first ? "000-agentic" : "zz-agentic";
      assert.equal(await view.getAgent(OWNER, hidden), null);
      assert.equal(await view.getAgentById(hidden), null);
      assert.equal(await view.getAgentSessionKey(OWNER, hidden), null);
      assert.equal(await view.readExecutingSession(OWNER, hidden), null);
      assert.equal(await view.hasAgentSessionKey(OWNER, hidden), false);
      assert.equal((await view.listAgents(OWNER)).length, 32);
    });
  }
});
