import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, type Hex } from "viem";
import { PostgresTradeCmcStore } from "../src/store/tradeCmc.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import { CMC_PAYEE, CMC_SPENDER, CMC_PRICE_ATOMIC } from "../src/trade/cmc.js";
import { USDT_56 } from "../src/trade/settlement.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const KEY = `0x04${"22".repeat(64)}` as Hex;
const NOW = 1_000_000;

type Snapshot = { readonly agent_id: string; readonly state_json: unknown };
class SharedFakeSql implements SqlClient {
  readonly snapshots = new Map<string, Snapshot>();
  readonly authorizations = new Map<string, { agent_id: string; encrypted_authorization: string }>();
  readonly ownership = new Map<string, string>();
  failNextSnapshot = false;
  async query<Row = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const lower = text.toLowerCase();
    if (lower.startsWith("create table") || lower.startsWith("create index") || lower.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (lower.includes("select agent_id,state_json from trade_cmc_snapshots")) {
      const row = this.snapshots.get(String(params[0]));
      return { rows: row === undefined ? [] : [row as Row] };
    }
    if (lower.includes("select operation_id,encrypted_authorization from trade_cmc_authorizations")) {
      return { rows: [...this.authorizations.entries()].filter(([, row]) => row.agent_id === String(params[0])).map(([operation_id, row]) => ({ operation_id, encrypted_authorization: row.encrypted_authorization }) as Row) };
    }
    if (lower.startsWith("insert into trade_cmc_snapshots")) {
      if (this.failNextSnapshot) { this.failNextSnapshot = false; throw new Error("simulated commit failure"); }
      this.snapshots.set(String(params[0]), { agent_id: String(params[0]), state_json: JSON.parse(String(params[2])) });
      return { rows: [] };
    }
    if (lower.startsWith("delete from trade_cmc_authorizations")) {
      for (const [operationId, row] of this.authorizations) if (row.agent_id === String(params[0])) this.authorizations.delete(operationId);
      return { rows: [] };
    }
    if (lower.startsWith("insert into trade_cmc_authorizations")) {
      this.authorizations.set(String(params[0]), { agent_id: String(params[1]), encrypted_authorization: String(params[2]) });
      return { rows: [] };
    }
    if (lower.startsWith("select operation_id from trade_cmc_execution_ownership")) {
      const key = `${params[0]}:${params[1]}:${params[2]}:${params[3]}`;
      const operationId = this.ownership.get(key);
      return { rows: operationId === undefined ? [] : [{ operation_id: operationId } as Row] };
    }
    if (lower.startsWith("insert into trade_cmc_execution_ownership")) {
      const key = `${params[0]}:${params[1]}:${params[2]}:${params[3]}`;
      if (this.ownership.has(key)) throw new Error("duplicate ownership");
      this.ownership.set(key, String(params[4]));
      return { rows: [] };
    }
    throw new Error(`fake SQL does not implement: ${text}`);
  }
  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> { return fn(this); }
  async close(): Promise<void> {}
}

test("Postgres CMC snapshots are fresh across store instances and survive restart", async () => {
  const sql = new SharedFakeSql();
  const first = await PostgresTradeCmcStore.create(sql, () => NOW);
  const second = await PostgresTradeCmcStore.create(sql, () => NOW);
  await first.putInitial({ agentId: "agent", ownerAddress: OWNER, wallet: OWNER, totalWei: 2n * 10n ** 18n });
  assert.equal((await second.get("agent", OWNER))?.authorizedTotalWei, 2n * 10n ** 18n);
  await first.setSetup({ agentId: "agent", ownerAddress: OWNER, wallet: OWNER, generation: 0, sessionPublicKey: KEY, sessionExpiry: 2_000_000, allowanceWei: 2n * 10n ** 18n });
  await first.setCapability({ agentId: "agent", ownerAddress: OWNER, generation: 0, available: true });
  const reservation = await second.reserve({ agentId: "agent", ownerAddress: OWNER, wallet: OWNER, operationId: "paid", attemptId: "a", amountWei: CMC_PRICE_ATOMIC, sessionPublicKey: KEY, sessionExpiry: 2_000_000, asset: USDT_56, spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE });
  assert.ok(reservation);
  const restarted = await PostgresTradeCmcStore.create(sql, () => NOW);
  assert.equal((await restarted.getAttempt("agent", OWNER, "paid"))?.state, "reserved");
});

test("Postgres CMC failed commit does not leak an in-memory mutation", async () => {
  const sql = new SharedFakeSql();
  const first = await PostgresTradeCmcStore.create(sql, () => NOW);
  await first.putInitial({ agentId: "agent", ownerAddress: OWNER, wallet: OWNER, totalWei: 2n * 10n ** 18n });
  sql.failNextSnapshot = true;
  await assert.rejects(first.toggle({ agentId: "agent", ownerAddress: OWNER, optedIn: false }));
  const second = await PostgresTradeCmcStore.create(sql, () => NOW);
  assert.equal((await second.get("agent", OWNER))?.optedIn, true);
});

// ---------------------------------------------------------------------------
// TRADFI-LLM-CMC-REQUEST R2.8.6: the LLM-requested-call counter round-trips
// through the SAME fake `SqlClient` this file already uses (never a real
// DATABASE_URL, per memory `quant-pg-test-drops-live-tables`) — the counter
// rides the JSONB snapshot, so a fresh store instance on the same fake `sql`
// models a process restart.
// ---------------------------------------------------------------------------

test("Postgres CMC: the LLM-requested-call counter survives a restart and a scheduled claim never resets it", async () => {
  const sql = new SharedFakeSql();
  const WINDOW_START = NOW - 30_000;
  const first = await PostgresTradeCmcStore.create(sql, () => NOW);
  await first.claimNewsSlot({ agentId: "agent", ownerAddress: OWNER, operationId: "llm-1", nowMs: NOW,
    llmRequest: { windowStartMs: WINDOW_START, cap: 10 } });
  await first.finishNewsSlot({ agentId: "agent", ownerAddress: OWNER, operationId: "llm-1", nowMs: NOW });
  // A scheduled (non-LLM) claim, on the SAME store instance.
  const scheduledAt = NOW + 3_700_000;
  await first.claimNewsSlot({ agentId: "agent", ownerAddress: OWNER, operationId: "scheduled-1", nowMs: scheduledAt });
  await first.finishNewsSlot({ agentId: "agent", ownerAddress: OWNER, operationId: "scheduled-1", nowMs: scheduledAt });
  const leaseAfterScheduled = await first.getNewsLease("agent", OWNER);
  assert.deepEqual(leaseAfterScheduled?.llmRequests, { windowStartMs: WINDOW_START, count: 1 },
    "a scheduled claim on Postgres must carry the LLM counter unchanged, exactly as the memory store does");
  // Restart: a brand-new store instance reading the SAME fake sql.
  const restarted = await PostgresTradeCmcStore.create(sql, () => NOW);
  const leaseAfterRestart = await restarted.getNewsLease("agent", OWNER);
  assert.deepEqual(leaseAfterRestart?.llmRequests, { windowStartMs: WINDOW_START, count: 1 }, "the counter must survive a restart");
});
