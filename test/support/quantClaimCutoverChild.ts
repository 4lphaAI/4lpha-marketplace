/**
 * Offline helper for test/quant.claim-cutover.process.pg.test.ts: `applyCutover` with the REAL singleton lifecycle
 * against the (throwaway) database URL in argv[2], holding its transaction on a server-side sleep after the table
 * locks are taken, and reporting over IPC. It never reads the environment or any file, and starts no worker.
 */
import { applyCutover, runCensus } from "../../scripts/quant-claim-cutover.js";
import { createPgSqlClient, type SqlClient, type SqlQueryOptions, type SqlResult } from "../../src/store/sql.js";

const url = process.argv[2]!;
const sql = await createPgSqlClient(url);
const census = await runCensus(sql);
await sql.close();

// A stray handle the cutover does not own: without a fail-stop exit this process would never end.
setInterval(() => undefined, 1_000);

const holdAfterLocks = (tx: SqlClient): SqlClient => {
  const held: SqlClient = {
    ...(tx.transactionScope === undefined ? {} : { transactionScope: tx.transactionScope }),
    query: async <Row>(text: string, params?: readonly unknown[], options?: SqlQueryOptions): Promise<SqlResult<Row>> => {
      const result = await tx.query<Row>(text, params, options);
      if (text.startsWith("lock table")) {
        process.send?.({ lockedPid: Number((await tx.query("select pg_backend_pid() as pid")).rows[0]?.["pid"]) });
        await tx.query("select pg_sleep(30)");
      }
      return result;
    },
    transaction: (work) => work(held),
    close: async () => undefined,
  };
  return held;
};

const outcome = await applyCutover({ databaseUrl: url, plan: census["draftPlan"], hooks: { wrapTx: holdAfterLocks } });
process.send?.({ outcome });
