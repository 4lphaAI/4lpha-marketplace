/** AGENTIC-EARN-SPEC ET6 (real Postgres): the earn claim statement predicate by predicate, the stored claim deadlines, the redeem exceptions, the DDL run twice with an earn row present, and the pre-earn claim text.
 *  Everything runs in a transaction on a throwaway schema that is rolled back. Run only against 127.0.0.1:15493 / agentic_audit (the same guard as the other Agentic audits); nothing persistent is touched. */
import assert from "node:assert/strict";
import test from "node:test";
import { AGENTIC_DDL, AGENTIC_CLAIM_SQL, EARN_CLAIM_SQL } from "../../src/agentic/store.js";
import { createPgSqlClient, type SqlClient } from "../../src/store/sql.js";

const connectionString = process.env["AGENTIC_AUDIT_DATABASE_URL"] ?? "";
const url = new URL(connectionString);
if (url.hostname !== "127.0.0.1" || url.port !== "15493" || url.pathname !== "/agentic_audit"
  || url.username !== "agentic_auditor" || url.protocol !== "postgres:" || url.password !== "" || url.search !== "" || url.hash !== "") {
  throw new Error("Dedicated disposable Agentic audit database required.");
}
const W = "0x1111111111111111111111111111111111111111", OTHER = "0x2222222222222222222222222222222222222222", DAY = 86_400_000, MAX = 90 * DAY;
type Kind = "earn-deposit" | "earn-redeem";
async function fixture(sql: SqlClient, kind: Kind): Promise<number> {
  await sql.query("truncate agentic_wallets,agentic_orders,agentic_instances,agentic_wallet_fences,agents,trade_intents,global_halt,agent_pause");
  const now = Number((await sql.query<{ ms: string }>("select (extract(epoch from clock_timestamp())*1000)::bigint as ms")).rows[0]!.ms);
  await sql.query(`insert into agentic_wallets (pairing_id,state,wallet_address,owner_address,pairing_secret_hash,code_hash,agent_id,session_ciphertext,hire_facts,hire_end_ms,entry_cutoff_ms,created_at,updated_at)
    values ('current','bound',$1,$1,'fixture','fixture','agent','cipher',$2::jsonb,$3,$4,$5,$5)`, [W, JSON.stringify({ earn: { v: 1 }, signInMaxTimeMs: now + MAX }), now + 7 * DAY, now + 7 * DAY - 7_200_000, now]);
  await sql.query("insert into agents values ('agent','armed','binance-agentic')");
  await sql.query(`insert into agentic_instances (instance_id,service,host,pid,machine_id,os_boot_marker,boot_at,heartbeat_at) values ('holder','trade-worker','offline',1,'machine','boot',$1,$1)`, [now]);
  await sql.query("insert into agentic_wallet_fences values ($1,7,'holder',$2)", [W, now + 120_000]);
  await sql.query(`insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,dispatch,outcome,created_at,updated_at) values ('order',$2,$1,'agent','unclaimed','open',$3,$3)`, [W, kind, now]);
  return now;
}
async function otherOrder(sql: SqlClient, wallet: string = W, extra = "'spawned','open'"): Promise<void> {
  await sql.query(`insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,dispatch,outcome,created_at,updated_at) values ('other','swap',$1,'historical',${extra},0,0)`, [wallet]);
}

test("earn claim SQL: every predicate alone, the redeem exceptions, the stored deadlines, the DDL twice with an earn row, the pre-earn text", async t => {
  const client = await createPgSqlClient(connectionString, { connectionTimeoutMillis: 3_000 });
  try {
    await assert.rejects(client.transaction(async sql => {
      await sql.query("create schema earn_claim_check");
      await sql.query("set local search_path to earn_claim_check");
      for (const ddl of AGENTIC_DDL) await sql.query(ddl);
      await sql.query(`create table agents(id text primary key,status text,custody_model text); create table trade_intents(agent_id text,decision_id text,state text);
        create table global_halt(id text); create table agent_pause(agent_id text)`);
      const run = (params: readonly unknown[]) => sql.query<Record<string, unknown>>(EARN_CLAIM_SQL, params);
      const control = (kind: Kind): unknown[] => ["order", "holder", 7, kind];

      await t.test("positive controls store the per-kind claim deadline", async () => {
        const now = await fixture(sql, "earn-deposit");
        const dep = await run(control("earn-deposit"));
        assert.equal(dep.rows.length, 1);
        assert.deepEqual([dep.rows[0]!["dispatch"], dep.rows[0]!["claimant"], Number(dep.rows[0]!["claim_deadline"]) - (now + 7 * DAY - DAY) < 5_000], ["spawned", "holder", true]);
        const red0 = await fixture(sql, "earn-redeem");
        const red = await run(control("earn-redeem"));
        assert.equal(red.rows.length, 1);
        assert.ok(Math.abs(Number(red.rows[0]!["claim_deadline"]) - (red0 + MAX - 1_800_000)) < 5_000);
      });

      const common = ["service", "instance", "fence-wallet", "holder", "token", "retired", "heartbeat", "lease", "settings-hold-flag", "halt", "pause", "other-open-order", "pending-fill", "pending-intent",
        "order-key", "command-kind", "unclaimed", "outcome", "row-age", "no-earn-fact", "no-session", "custody", "swap-kind", "wallet-pairing", "agent-identity"];
      for (const condition of common) for (const kind of ["earn-deposit", "earn-redeem"] as const) {
        if (condition === "settings-hold-flag") continue;
        await t.test(`${kind}: refuses only invalid ${condition}`, async () => {
          const now = await fixture(sql, kind), params = control(kind);
          switch (condition) {
            case "service": await sql.query("update agentic_instances set service='execution-api'"); break;
            case "instance": await sql.query("update agentic_instances set instance_id='other-holder'"); break;
            case "fence-wallet": await sql.query("update agentic_wallet_fences set wallet_address=$1", [OTHER]); break;
            case "holder": await sql.query("update agentic_wallet_fences set holder='other-holder'"); break;
            case "token": params[2] = 6; break;
            case "retired": await sql.query("update agentic_instances set retired_at=$1", [now]); break;
            case "heartbeat": await sql.query("update agentic_instances set heartbeat_at=$1", [now - 60_000]); break;
            case "lease": await sql.query("update agentic_wallet_fences set lease_until=$1", [now + 60_000]); break;
            case "halt": await sql.query("insert into global_halt values ('global')"); break;
            case "pause": await sql.query("insert into agent_pause values ('agent')"); break;
            case "other-open-order": await otherOrder(sql); break;
            case "pending-fill": await otherOrder(sql, W, "'spawned','committed'"); await sql.query("update agentic_orders set fill_check='pending' where idempotency_key='other'"); break;
            case "pending-intent": await sql.query("insert into agentic_wallets (pairing_id,state,wallet_address,owner_address,pairing_secret_hash,code_hash,agent_id,created_at,updated_at) values ('history','ended',$1,$1,'f','f','historical',0,0)", [W]);
              await sql.query("insert into trade_intents values ('historical','foreign-decision','pending')"); break;
            case "order-key": params[0] = "missing"; break;
            case "command-kind": params[3] = kind === "earn-deposit" ? "earn-redeem" : "earn-deposit"; break;
            case "unclaimed": await sql.query("update agentic_orders set dispatch='sealed'"); break;
            case "outcome": await sql.query("update agentic_orders set outcome='rolled-back'"); break;
            case "row-age": await sql.query("update agentic_orders set created_at=$1", [now - 61_000]); break;
            case "no-earn-fact": await sql.query(`update agentic_wallets set hire_facts='{"signInMaxTimeMs":1}'::jsonb`); await sql.query("update agentic_wallets set hire_facts=jsonb_build_object('signInMaxTimeMs',$1::bigint)", [now + MAX]); break;
            case "no-session": await sql.query("update agentic_wallets set session_ciphertext=null"); break;
            case "custody": await sql.query("update agents set custody_model='passkey'"); break;
            case "swap-kind": await sql.query("update agentic_orders set kind='swap'"); params[3] = "swap"; break;
            case "wallet-pairing": await sql.query("update agentic_wallets set wallet_address=$1,owner_address=$1", [OTHER]); break;
            case "agent-identity": await sql.query("update agents set id='foreign'"); break;
            default: assert.fail(condition);
          }
          assert.equal((await run(params)).rows.length, 0, condition);
        });
      }

      await t.test("a deposit alone refuses on the deposit predicates", async () => {
        const cases: [string, string][] = [["bound", "update agentic_wallets set state='ending'"], ["settings hold", "update agentic_wallets set settings_hold='{}'::jsonb"],
          ["entries", "update agentic_wallets set entries_stopped='{}'::jsonb"], ["drain", "update agentic_wallets set drain_requested_at=1"],
          ["armed", "update agents set status='revoked'"], ["24 h", "update agentic_wallets set hire_end_ms=(extract(epoch from clock_timestamp())*1000)::bigint+86_400_000-4_000"]];
        for (const [label, statement] of cases) { await fixture(sql, "earn-deposit"); await sql.query(statement); assert.equal((await run(control("earn-deposit"))).rows.length, 0, label); }
        await fixture(sql, "earn-deposit");
        await sql.query("update agentic_wallets set hire_end_ms=(extract(epoch from clock_timestamp())*1000)::bigint+86_400_000+60_000");
        assert.equal((await run(control("earn-deposit"))).rows.length, 1, "a minute past the 24 h edge is admitted");
      });

      await t.test("a redeem is admitted in ending, on a revoked agent, under a hold, drain and stopped entries, past the hire end; refused ended, halted, paused and at the maximum-time margin", async () => {
        for (const [label, statement] of [["ending", "update agentic_wallets set state='ending'"], ["revoked", "update agents set status='revoked'"], ["hold", "update agentic_wallets set settings_hold='{}'::jsonb"],
          ["entries and drain", "update agentic_wallets set entries_stopped='{}'::jsonb,drain_requested_at=1"], ["past the end", "update agentic_wallets set state='ending',hire_end_ms=1"]] as const) {
          await fixture(sql, "earn-redeem"); await sql.query(statement);
          assert.equal((await run(control("earn-redeem"))).rows.length, 1, label);
        }
        for (const [label, statement] of [["ended", "update agentic_wallets set state='ended',session_ciphertext=null"], ["halt", "insert into global_halt values ('global')"], ["pause", "insert into agent_pause values ('agent')"]] as const) {
          await fixture(sql, "earn-redeem"); await sql.query(statement);
          assert.equal((await run(control("earn-redeem"))).rows.length, 0, label);
        }
        const now = await fixture(sql, "earn-redeem");
        await sql.query("update agentic_wallets set hire_facts=jsonb_build_object('earn',jsonb_build_object('v',1),'signInMaxTimeMs',$1::bigint)", [now + 1_800_000 + 3_000]);
        assert.equal((await run(control("earn-redeem"))).rows.length, 0, "signInMax - 30 min within 5 s");
        await sql.query("update agentic_wallets set hire_facts=jsonb_build_object('earn',jsonb_build_object('v',1),'signInMaxTimeMs',$1::bigint)", [now + 1_800_000 + 60_000]);
        assert.equal((await run(control("earn-redeem"))).rows.length, 1, "a minute inside the margin");
      });

      await t.test("an unrelated wallet's order or intent does not block", async () => {
        await fixture(sql, "earn-deposit"); await otherOrder(sql, OTHER);
        await sql.query("insert into agentic_wallets (pairing_id,state,wallet_address,owner_address,pairing_secret_hash,code_hash,agent_id,created_at,updated_at) values ('history','ended',$1,$1,'f','f','historical',0,0)", [OTHER]);
        await sql.query("insert into trade_intents values ('historical','foreign-decision','pending')");
        assert.equal((await run(control("earn-deposit"))).rows.length, 1);
      });

      await t.test("the DDL run twice with an earn row present succeeds, accepts both earn kinds and refuses any other", async () => {
        await fixture(sql, "earn-deposit");
        await sql.query(`insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,dispatch,outcome,created_at,updated_at) values ('r','earn-redeem',$1,'agent','sealed','rolled-back',0,0)`, [W]);
        for (let pass = 0; pass < 2; pass += 1) for (const ddl of AGENTIC_DDL) await sql.query(ddl);
        const names = (await sql.query<{ conname: string }>("select conname from pg_constraint where conname='agentic_orders_kind_check'")).rows.map(r => r.conname);
        assert.deepEqual(names, ["agentic_orders_kind_check"]);
        await sql.query("savepoint s");
        await assert.rejects(sql.query(`insert into agentic_orders (idempotency_key,kind,wallet_address,agent_id,dispatch,outcome,created_at,updated_at) values ('bad','earn-claim',$1,'agent','sealed','open',0,0)`, [W]));
        await sql.query("rollback to savepoint s");
      });

      await t.test("the pre-earn claim is a different statement and still names no earn kind", () => {
        assert.notEqual(EARN_CLAIM_SQL, AGENTIC_CLAIM_SQL);
        assert.equal(/earn/u.test(AGENTIC_CLAIM_SQL), false);
      });
      throw new Error("rollback");
    }), /rollback/);
  } finally { await client.close(); }
});
