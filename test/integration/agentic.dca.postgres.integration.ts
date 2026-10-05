/** AGENTIC-DCA Revision 3: the DDL (constraint names, idempotence, the legacy kinds, the indexes), leaveBound and the booking transaction on the disposable cluster.
 *  The claim and pay-check SQL are the pre-DCA text again (src/agentic/store.ts, pinned by agentic.dca.store.test.ts PIN2); the AI suite agentic.postgres.integration.ts covers them.
 *  Run only against 127.0.0.1:15493 / agentic_audit (the same guard as the Agentic authorization audit); nothing persistent is touched. */
import assert from "node:assert/strict";
import test from "node:test";
import { AGENTIC_DDL, AgenticStore } from "../../src/agentic/store.js";
import { createPgSqlClient, type SqlClient } from "../../src/store/sql.js";

const connectionString = process.env["AGENTIC_AUDIT_DATABASE_URL"] ?? "";
const url = new URL(connectionString);
if (url.hostname !== "127.0.0.1" || url.port !== "15493" || url.pathname !== "/agentic_audit"
  || url.username !== "agentic_auditor" || url.protocol !== "postgres:" || url.password !== "" || url.search !== "" || url.hash !== "") {
  throw new Error("Dedicated disposable Agentic audit database required.");
}

test("DDL: constraint names, the new kinds and end reason, and idempotence on a throwaway schema", async t => {
  const client = await createPgSqlClient(connectionString, { connectionTimeoutMillis: 3_000 });
  try {
    await assert.rejects(client.transaction(async sql => {
      await sql.query("create schema dca_ddl_check");
      await sql.query("set local search_path to dca_ddl_check");
      for (let pass = 0; pass < 2; pass += 1) for (const ddl of AGENTIC_DDL) await sql.query(ddl);
      const names = (await sql.query<{ conname: string }>("select conname from pg_constraint where conname in ('agentic_orders_kind_check','agentic_wallets_end_reason_check')")).rows.map(r => r.conname).sort();
      assert.deepEqual(names, ["agentic_orders_kind_check", "agentic_wallets_end_reason_check"]);
      await t.test("limit kinds and the stop-loss end reason are accepted, others refused", async () => {
        for (const kind of ["swap", "x402-sign", "limit-place", "limit-cancel"]) {
          await sql.query("savepoint s");
          await sql.query(`insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,dispatch,outcome,created_at,updated_at) values ($1,$1,'w','a','unclaimed','open',0,0)`, [kind]);
          await sql.query("release savepoint s");
        }
        await sql.query("savepoint bad");
        await assert.rejects(sql.query(`insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,dispatch,outcome,created_at,updated_at) values ('x','limit-amend','w','a','unclaimed','open',0,0)`));
        await sql.query("rollback to savepoint bad");
        await sql.query(`insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,dispatch,outcome,created_at,updated_at,binance_answered_at) values ('answered','limit-cancel','w','a','sealed','open',0,0,5)`);
        for (const reason of ["owner-signed-out", "term-ended", "stop-loss"]) {
          await sql.query("savepoint e");
          await sql.query(`insert into agentic_wallets (pairing_id,state,pairing_secret_hash,code_hash,end_reason,created_at,updated_at) values ($1,'waiting','x','y',$2,0,0)`, [`p-${reason}`, reason]);
          await sql.query("release savepoint e");
        }
        await sql.query("savepoint e2");
        await assert.rejects(sql.query(`insert into agentic_wallets (pairing_id,state,pairing_secret_hash,code_hash,end_reason,created_at,updated_at) values ('p-bad','waiting','x','y','other',0,0)`));
        await sql.query("rollback to savepoint e2");
      });
      await t.test("one open round per agent, one strategy per wallet, one transaction hash", async () => {
        const round = (agent: string, no: number, phase: string) => sql.query(`insert into agentic_dca_rounds (agent_id,round_no,wallet_address,phase,cost_usdt_wei,stock_raw,carried_cost_wei,carried_stock_raw,opened_at,created_at,updated_at) values ($1,$2,'w',$3,0,0,0,0,0,0,0)`, [agent, no, phase]);
        await round("a", 1, "active"); await round("a", 2, "settled");
        // every closed phase frees the slot: a stopped, an ended and an interrupted round sit beside an open one
        await round("b", 1, "stopped"); await round("b", 2, "ended"); await round("b", 3, "interrupted"); await round("b", 4, "winding-down");
        await sql.query("savepoint r");
        await assert.rejects(round("a", 3, "starting"));
        await sql.query("rollback to savepoint r");
        const order = (key: string, strategy: string | null, hash: string | null) => sql.query(`insert into agentic_dca_orders (order_key,agent_id,wallet_address,round_no,role,side,price_num,price_den,trigger_sent,qty_sent,qty_atomic,slippage_pct,state,strategy_id,tx_hash,created_at,updated_at) values ($1,'a','w',1,'level','buy',1,1,'1','1',1,'0.5','resting',$2,$3,0,0)`, [key, strategy, hash]);
        await order("o1", "7", "0xaa");
        await sql.query("savepoint o");
        await assert.rejects(order("o2", "7", null));
        await sql.query("rollback to savepoint o");
        await sql.query("savepoint h");
        await assert.rejects(order("o3", null, "0xaa"));
        await sql.query("rollback to savepoint h");
        await order("o4", null, null);
      });
      await t.test("leaveBound writes the stop-loss end reason in SQL and keeps the stored reason for a term end", async () => {
        await sql.query("create table agent_pause (agent_id text)");
        await sql.query("create table global_halt (id text)");
        const insert = (id: string, wallet: string) => sql.query("insert into agentic_wallets (pairing_id,state,pairing_secret_hash,code_hash,agent_id,wallet_address,created_at,updated_at) values ($1,'bound','x','y',$2,$3,0,0)", [id, "agent-" + id, wallet]);
        const store = new AgenticStore(sql as unknown as SqlClient, {} as never);
        await insert("lb-stop", "0x" + "a1".repeat(20)); await insert("lb-term", "0x" + "a2".repeat(20)); await insert("lb-out", "0x" + "a3".repeat(20));
        const stop = await store.leaveBound((await store.getWallet("lb-stop"))!, "stop-loss");
        assert.deepEqual([stop?.state, stop?.endReason], ["ending", "stop-loss"]);
        const term = await store.leaveBound((await store.getWallet("lb-term"))!, "term-ended");
        assert.deepEqual([term?.state, term?.endReason], ["ending", null]);
        const out = await store.leaveBound((await store.getWallet("lb-out"))!, "owner-signed-out");
        assert.deepEqual([out?.state, out?.endReason], ["ended", "owner-signed-out"]);
      });
      await t.test("bookDcaFill on Postgres: a hash that is a swap row's own is accepted, a second DCA order cannot take it, and entries_stopped lands with the booking (the atomic rollback on a stale version is the memory twin's ST3: the harness wraps this schema in one outer transaction)", async () => {
        const store = new AgenticStore(sql as unknown as SqlClient, {} as never);
        const wallet = "0x" + "b1".repeat(20);
        await sql.query("insert into agentic_wallets (pairing_id,state,pairing_secret_hash,code_hash,agent_id,wallet_address,created_at,updated_at) values ('bk','bound','x','y','agent-bk',$1,0,0)", [wallet]);
        const round = { agentId: "agent-bk", roundNo: 1, walletAddress: wallet, phase: "active", baseOrderKey: null, p0UsdtWei: "1", p0StockRaw: "1", costUsdtWei: "100", stockRaw: "10", carriedCostWei: "0", carriedStockRaw: "0",
          soldStockRaw: "0", proceedsUsdtWei: "0", realizedPnlWei: null, markedPnlWei: null, stopCounter: null, tpFilledAt: null, closeCause: null, failStreak: 0, backoffUntilMs: null, tpDueAt: null,
          openedAt: 0, settledAt: null, rowVersion: 1, createdAt: 0, updatedAt: 0 } as const;
        assert.equal(await store.insertDcaRound(round as never), true);
        const order = (key: string) => ({ orderKey: key, agentId: "agent-bk", walletAddress: wallet, roundNo: 1, role: "level", levelNo: 1, side: "buy", priceNum: "1", priceDen: "1", triggerSent: "", qtySent: "", qtyAtomic: "10",
          slippagePct: "0.5", placeOrderKey: null, cancelOrderKey: null, strategyId: null, listStatus: null, unitQty: null, unitTrigger: null, state: "placing", closedBy: null, holdReason: null, txHash: null,
          fillUsdtWei: null, fillStockRaw: null, executor: null, rowVersion: 1, createdAt: 0, updatedAt: 0 });
        assert.equal(await store.insertDcaOrder(order("bk-1") as never), true);
        assert.equal(await store.insertDcaOrder({ ...order("bk-2"), levelNo: 2 } as never), true);
        const hash = "0x" + "cc".repeat(32);
        await sql.query("insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,dispatch,outcome,tx_hash,created_at,updated_at) values ('swap-bk','swap',$1,'agent-bk','spawned','committed',$2,0,0)", [wallet, hash]);
        const stored = (await store.dcaRounds("agent-bk"))[0]!;
        const stop = { reason: "dca-fill-above-level" as const, out: "2", min: "3", atMs: 5 };
        const booked = await store.bookDcaFill({ order: (await store.getDcaOrder("bk-1"))!, orderPatch: { state: "filled", txHash: hash as never }, round: stored, roundPatch: { costUsdtWei: "150" }, entriesStopped: stop });
        assert.deepEqual([booked?.state, booked?.txHash], ["filled", hash]);
        assert.equal((await store.dcaRounds("agent-bk"))[0]!.costUsdtWei, "150");
        assert.deepEqual((await store.byAgent("agent-bk"))!.entriesStopped, stop);
        assert.equal(await store.bookDcaFill({ order: (await store.getDcaOrder("bk-2"))!, orderPatch: { state: "filled", txHash: hash as never }, round: (await store.dcaRounds("agent-bk"))[0]!, roundPatch: {}, entriesStopped: null }), null,
          "the unique index: one DCA order per transaction hash");
      });
      throw new Error("ROLLBACK_DDL_CHECK");
    }), /ROLLBACK_DDL_CHECK/);
  } finally { await client.close(); }
});
