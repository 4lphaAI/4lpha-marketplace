/** Authorization audit: temporary tables on the dedicated disposable cluster only. */
import assert from "node:assert/strict";
import test from "node:test";
import { AGENTIC_DDL, AGENTIC_CLAIM_SQL, AGENTIC_PAY_CHECK_SQL } from "../../src/agentic/store.js";
import { createPgSqlClient, type SqlClient } from "../../src/store/sql.js";

const connectionString = process.env["AGENTIC_AUDIT_DATABASE_URL"] ?? "";
const url = new URL(connectionString);
if (url.hostname !== "127.0.0.1" || url.port !== "15493" || url.pathname !== "/agentic_audit"
  || url.username !== "agentic_auditor" || url.protocol !== "postgres:" || url.password !== "" || url.search !== "" || url.hash !== "") {
  throw new Error("Dedicated disposable Agentic audit database required.");
}
const W = "0x1111111111111111111111111111111111111111", OTHER = "0x2222222222222222222222222222222222222222";
const TABLES = "agentic_wallets,agentic_orders,agentic_instances,agentic_wallet_fences,agents,execution_journal,trade_intents,global_halt,agent_pause";
async function fixture(sql: SqlClient): Promise<number> {
  await sql.query(`truncate ${TABLES}`);
  const now = Number((await sql.query<{ ms: string }>("select (extract(epoch from clock_timestamp())*1000)::bigint as ms")).rows[0]!.ms);
  await sql.query(`insert into agentic_wallets (pairing_id,state,wallet_address,owner_address,pairing_secret_hash,code_hash,agent_id,hire_end_ms,entry_cutoff_ms,created_at,updated_at)
    values ('current','bound',$1,$1,'fixture','fixture','agent',$2,$3,$4,$4)`, [W, now + 600_000, now + 300_000, now]);
  await sql.query("insert into agents values ('agent','armed','binance-agentic')");
  await sql.query(`insert into agentic_instances (instance_id,service,host,pid,machine_id,os_boot_marker,boot_at,heartbeat_at)
    values ('holder','trade-worker','offline',1,'machine','boot',$1,$1)`, [now]);
  await sql.query("insert into agentic_wallet_fences values ($1,7,'holder',$2)", [W, now + 120_000]);
  await sql.query(`insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,decision_id,side,quote_at,dispatch,outcome,created_at,updated_at)
    values ('order','swap',$1,'agent','decision','buy',$2,'unclaimed','open',$2,$2)`, [W, now]);
  await sql.query("insert into execution_journal values ('order','PENDING')");
  return now;
}
async function history(sql: SqlClient, wallet: string = W): Promise<void> {
  await sql.query(`insert into agentic_wallets (pairing_id,state,wallet_address,owner_address,pairing_secret_hash,code_hash,agent_id,hire_end_ms,entry_cutoff_ms,created_at,updated_at)
    values ('history','ended',$1,$1,'fixture','fixture','historical',123,100,0,0)`, [wallet]);
}
async function otherOrder(sql: SqlClient, wallet: string = W): Promise<void> {
  await sql.query(`insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,dispatch,outcome,created_at,updated_at)
    values ('other','swap',$1,'historical','spawned','open',0,0)`, [wallet]);
}

test("production Agentic claim and payment SQL enforce independent authorization predicates", async t => {
  const client = await createPgSqlClient(connectionString, { connectionTimeoutMillis: 3_000 });
  try {
    await client.transaction(async sql => {
      // Session-local tables shadow production names; no persistent table is dropped or altered.
      for (const ddl of AGENTIC_DDL.slice(0, 4)) await sql.query(ddl.replace(/create table if not exists/g, "create temporary table"));
      await sql.query(`create temporary table agents(id text primary key,status text,custody_model text);
        create temporary table execution_journal(idempotency_key text primary key,state text);
        create temporary table trade_intents(agent_id text,decision_id text,state text);
        create temporary table global_halt(id text);
        create temporary table agent_pause(agent_id text)`);
      for (const mode of ["claim", "payment"] as const) {
        const execute = (params: readonly unknown[]) => sql.query<Record<string, unknown>>(mode === "claim" ? AGENTIC_CLAIM_SQL : AGENTIC_PAY_CHECK_SQL, params);
        const parameters = () => mode === "claim" ? ["order", "holder", 7, "swap"] : ["agent", "holder", 7, "order"];
        await t.test(`${mode}: positive control, historical deadline and current-order exemption`, async () => {
          const now = await fixture(sql); await history(sql);
          const result = await execute(parameters()); assert.equal(result.rows.length, 1);
          if (mode === "claim") {
            assert.equal(result.rows[0]!["dispatch"], "spawned");
            assert.equal(Number(result.rows[0]!["claim_deadline"]), now + 300_000);
            assert.ok(Number(result.rows[0]!["claimed_at"]) >= now);
          } else assert.equal(result.rows[0]!["agent_id"], "agent");
        });
        const cases = ["service", "instance", "fence-wallet", "agent-identity", "other-open-order", "pending-intent", "database-clock",
          "holder", "token", "retired", "heartbeat", "lease", "bound", "settings-hold", "armed", "custody", "halt", "pause", "pending-fill",
          ...(mode === "claim" ? ["order-key", "command-kind", "journal-key", "buy-cutoff", "sell-end", "unclaimed", "outcome", "quote", "entries", "drain", "deadline-margin"] : ["hire-agent", "hire-end"])];
        for (const condition of cases) await t.test(`${mode}: refuses only invalid ${condition}`, async () => {
          const now = await fixture(sql), params = parameters();
          switch (condition) {
            case "order-key": params[0] = "missing"; break;
            case "command-kind": params[3] = "x402-sign"; break;
            case "service": await sql.query("update agentic_instances set service='execution-api'"); break;
            case "instance": await sql.query("update agentic_instances set instance_id='other-holder'"); break;
            case "fence-wallet": await sql.query("update agentic_wallet_fences set wallet_address=$1", [OTHER]); break;
            case "holder": await sql.query("update agentic_wallet_fences set holder='other-holder'"); break;
            case "token": params[2] = 6; break;
            case "retired": await sql.query("update agentic_instances set retired_at=$1", [now]); break;
            case "heartbeat": await sql.query("update agentic_instances set heartbeat_at=$1", [now - 60_000]); break;
            case "lease": await sql.query("update agentic_wallet_fences set lease_until=$1", [now + 20_000]); break;
            case "bound": await sql.query("update agentic_wallets set state='ending'"); break;
            case "settings-hold": await sql.query("update agentic_wallets set settings_hold='{}'::jsonb"); break;
            case "armed": await sql.query("update agents set status='revoked'"); break;
            case "custody": await sql.query("update agents set custody_model='passkey'"); break;
            case "halt": await sql.query("insert into global_halt values ('global')"); break;
            case "pause": await sql.query("insert into agent_pause values ('agent')"); break;
            case "agent-identity":
              await sql.query("update agents set status='revoked'; insert into agents values ('foreign','armed','binance-agentic')"); break;
            case "hire-agent":
              params[0] = "missing-agent"; break;
            case "journal-key":
              await sql.query("update execution_journal set state='UNKNOWN'; insert into execution_journal values ('foreign','PENDING')"); break;
            case "buy-cutoff": await sql.query("update agentic_wallets set entry_cutoff_ms=$1", [now - 60_000]); break;
            case "sell-end":
              await sql.query("update agentic_orders set side='sell'");
              await sql.query("update agentic_wallets set hire_end_ms=$1", [now - 60_000]); break;
            case "database-clock": case "hire-end":
              await sql.query("update agentic_wallets set entry_cutoff_ms=$1,hire_end_ms=$1", [now - 60_000]); break;
            case "deadline-margin": await sql.query("update agentic_wallets set entry_cutoff_ms=$1", [now + 4_000]); break;
            case "unclaimed": await sql.query("update agentic_orders set dispatch='sealed'"); break;
            case "outcome": await sql.query("update agentic_orders set outcome='rolled-back'"); break;
            case "quote": await sql.query("update agentic_orders set quote_at=$1", [now - 60_000]); break;
            case "entries": await sql.query("update agentic_wallets set entries_stopped='{}'::jsonb"); break;
            case "drain": await sql.query("update agentic_wallets set drain_requested_at=$1", [now]); break;
            case "other-open-order": await otherOrder(sql); break;
            case "pending-fill":
              await otherOrder(sql); await sql.query("update agentic_orders set outcome='committed',fill_check='pending' where idempotency_key='other'"); break;
            case "pending-intent":
              await history(sql); await sql.query("insert into trade_intents values ('historical','foreign-decision','pending')"); break;
            default: assert.fail(condition);
          }
          assert.equal((await execute(params)).rows.length, 0);
          assert.equal((await sql.query<{ dispatch: string }>("select dispatch from agentic_orders where idempotency_key='order'")).rows[0]!.dispatch,
            condition === "unclaimed" ? "sealed" : "unclaimed");
        });
        await t.test(`${mode}: unrelated wallet order does not block`, async () => {
          await fixture(sql); await otherOrder(sql, OTHER);
          assert.equal((await execute(parameters())).rows.length, 1);
        });
        await t.test(`${mode}: unrelated historical wallet intent does not block`, async () => {
          await fixture(sql); await history(sql, OTHER);
          await sql.query("insert into trade_intents values ('historical','foreign-decision','pending')");
          assert.equal((await execute(parameters())).rows.length, 1);
        });
      }
    });
  } finally { await client.close(); }
});
