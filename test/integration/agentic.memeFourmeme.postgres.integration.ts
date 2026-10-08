/** FOURMEME-CURVE-PAPER-SPEC 8.3: the paper ledger's venue CHECK on the disposable cluster. Run only against 127.0.0.1:15493 / agentic_audit (the guard of agentic.dca.postgres.integration.ts);
 *  never against a live database (memory quant-pg-test-drops-live-tables). Not part of the offline gate. */
import assert from "node:assert/strict";
import test from "node:test";
import { AGENTIC_DDL } from "../../src/agentic/store.js";
import { createPgSqlClient } from "../../src/store/sql.js";

const connectionString = process.env["AGENTIC_AUDIT_DATABASE_URL"] ?? "";
const url = new URL(connectionString);
if (url.hostname !== "127.0.0.1" || url.port !== "15493" || url.pathname !== "/agentic_audit"
  || url.username !== "agentic_auditor" || url.protocol !== "postgres:" || url.password !== "" || url.search !== "" || url.hash !== "") {
  throw new Error("Dedicated disposable Agentic audit database required.");
}

test("AGENTIC_DDL, a row, AGENTIC_DDL again: one agentic_meme_paper_venue_entry_check, the migration is idempotent on a table with rows, a fourmeme-bonding row inserts, a bogus venue is refused", async () => {
  const client = await createPgSqlClient(connectionString, { connectionTimeoutMillis: 3_000 });
  try {
    await assert.rejects(client.transaction(async sql => {
      await sql.query("create schema fourmeme_ddl_check");
      await sql.query("set local search_path to fourmeme_ddl_check");
      for (const ddl of AGENTIC_DDL) await sql.query(ddl);
      const insert = (id: string, venue: string) => sql.query(`insert into agentic_meme_paper (position_id,agent_id,wallet_address,token,quote_token,venue_entry,buy_tax_bps,sell_tax_bps,token_version,entry_usdt,gas_buy_usdt,bnb_usdt_e18,tokens,cost_bps,status,opened_at)
        values ($1,'a','w',$1,'q',$2,300,300,2,'1','1','1','1',1,'open',0)`, [id, venue]);
      // Audit LOW-2: a row is in the table before the second pass, so the CHECK migration is proven idempotent on a populated table.
      await insert("t-flap", "flap-bonding");
      for (const ddl of AGENTIC_DDL) await sql.query(ddl);
      const names = (await sql.query<{ conname: string }>("select conname from pg_constraint where conname = 'agentic_meme_paper_venue_entry_check' and connamespace = 'fourmeme_ddl_check'::regnamespace")).rows;
      assert.equal(names.length, 1);
      await sql.query("savepoint ok");
      await insert("t-fourmeme", "fourmeme-bonding");
      await sql.query("release savepoint ok");
      await sql.query("savepoint bad");
      await assert.rejects(insert("t-bogus", "bogus"));
      await sql.query("rollback to savepoint bad");
      throw new Error("ROLLBACK_DDL_CHECK");
    }), /ROLLBACK_DDL_CHECK/);
  } finally { await client.close(); }
});
