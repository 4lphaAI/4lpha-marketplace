import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";
import { MemoryTradePositionStore, PostgresTradePositionStore, type ExitLlmContextRecord } from "../src/store/tradePositions.js";
import { createPgSqlClient } from "../src/store/sql.js";
import { localPostgres } from "./support/localPostgres.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const NOW = 1_900_000_000_000;

const CONTEXT: ExitLlmContextRecord = {
  askedAtMs: NOW, pnlBps: -120, peakPnlBps: 300, macdHistSign: 1, emaSpreadSign: -1,
  regime: "risk_off", session: "rth", trigger: "cost-band-breach",
};

it("memory store round-trips exit_llm_context; absent means never asked", async () => {
  const store = new MemoryTradePositionStore(() => NOW);
  const opened = await store.open({ positionId: "p1", agentId: "a", ownerAddress: OWNER, token: TOKEN,
    route: { kind: "pancake-v2" } as never, entryWei: 1n, tokenAmount: 1n, fillStatus: "verified", openedAt: NOW });
  assert.equal(opened.exitLlmContext, undefined);
  const updated = await store.setExitLlmContext(OWNER, "a", "p1", CONTEXT);
  assert.deepEqual(updated?.exitLlmContext, CONTEXT);
  const fetched = await store.get(OWNER, "a", "p1");
  assert.deepEqual(fetched?.exitLlmContext, CONTEXT);
});

describe("trade positions: exit_llm_context migration + round-trip (disposable local PostgreSQL)", () => {
  it("adds the column idempotently and round-trips a written context", async () => {
    const cluster = await localPostgres();
    if (cluster === null) { console.log("skipping: no local PostgreSQL binaries"); return; }
    const sql = await createPgSqlClient(cluster.url);
    try {
      // Twice, to prove the migration is idempotent.
      await PostgresTradePositionStore.create(sql, () => NOW);
      const store = await PostgresTradePositionStore.create(sql, () => NOW);
      await store.open({ positionId: "p1", agentId: "a", ownerAddress: OWNER, token: TOKEN,
        route: { kind: "pancake-v2" } as never, entryWei: 1n, tokenAmount: 1n, fillStatus: "verified", openedAt: NOW });
      const updated = await store.setExitLlmContext(OWNER, "a", "p1", CONTEXT);
      assert.deepEqual(updated?.exitLlmContext, CONTEXT);
      const fetched = await store.get(OWNER, "a", "p1");
      assert.deepEqual(fetched?.exitLlmContext, CONTEXT);
    } finally {
      await sql.close(); await cluster.close();
    }
  });
});
