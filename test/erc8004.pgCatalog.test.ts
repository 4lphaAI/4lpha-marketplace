import assert from "node:assert/strict";
import { it } from "node:test";
import pg from "pg";
import { checkIdentitySchema } from "../src/store/erc8004.js";
import type { SqlClient } from "../src/store/sql.js";

// pg supports array OIDs at runtime that its TypeId declaration omits.
const parser = pg.types.getTypeParser as (oid: number) => (literal: string) => unknown;

it("schema catalog selects text[] so real pg decodes ordered keys and the empty expression key", async () => {
  assert.equal(parser(1003)("{public_ref}"), "{public_ref}");
  assert.deepEqual(parser(1009)("{public_ref}"), ["public_ref"]);
  assert.deepEqual(parser(1009)("{}"), []);

  const keys = [
    ["erc8004_jobs", "{public_ref}"],
    ["erc8004_jobs", "{owner_address,source_id}"],
    ["erc8004_transactions", "{hash}"],
    ["erc8004_transactions", "{job_ref,phase}"],
    ["erc8004_transactions", "{chain,minter,nonce}"],
    ["erc8004_nonces", "{chain,minter}"],
  ] as const;
  const sql: SqlClient = {
    async query<Row>(text: string) {
      if (!text.includes("erc8004.schemaIndexes")) return { rows: [] as Row[] };
      const decode = parser(/select\s+a\.attname\s*::\s*text\b/i.test(text) ? 1009 : 1003);
      const rows = keys.map(([table_name, literal]) => ({ table_name, key_columns: decode(literal), expression: null, predicate: null }));
      const expressionRow = { table_name: "agents", key_columns: decode("{}"), expression: "(erc8004_identity ->> 'publicRef'::text)", predicate: "(erc8004_identity IS NOT NULL)" };
      return { rows: [...rows, expressionRow] as unknown as Row[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) { return fn(sql); },
    async close() {},
  };
  await checkIdentitySchema(sql);
});
