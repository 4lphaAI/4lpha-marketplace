/**
 * TRADFI-EXPIRY-KEEP-REMOVE §2.2 — `TradeIntentStore.disposeInertSell`, in the
 * memory store AND against a real PostgreSQL. The PostgreSQL variant runs on an
 * OWNED, DISPOSABLE loopback cluster (`localPostgres`, never `DATABASE_URL`) and
 * skips loudly when the binaries are absent.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { MemoryTradeIntentStore, PostgresTradeIntentStore, type TradeIntentStore } from "../src/store/tradeIntents.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { INERT_EVIDENCE_MAX_BYTES, encodeInertEvidence, parseInertEvidence, type InertEvidence } from "../src/trade/inertSubmission.js";
import { localPostgres } from "./support/localPostgres.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER_OWNER = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const PUBLIC_KEY = `0x04${"51".repeat(64)}` as Hex;
const BLOCK_HASH = `0x${"61".repeat(32)}` as Hex;
const TX = `0x${"55".repeat(32)}` as Hex;

let counter = 0;
function key(): Hex { counter += 1; return `0x${counter.toString(16).padStart(64, "0")}` as Hex; }

function evidenceFor(journalKey: string): string {
  const evidence: InertEvidence = { v: 1, kind: "inert-ambiguous-sell", key: PUBLIC_KEY, verdict: "invalid", block: "123456789",
    blockHash: BLOCK_HASH, blockTimeSec: 1_790_620_224, expirySec: 1_790_617_224, journalKey };
  return encodeInertEvidence(evidence);
}

async function seed(store: TradeIntentStore, agentId: string, side: "buy" | "sell" = "sell") {
  const idempotencyKey = key();
  const decisionId = `decision-${counter}`;
  const created = await store.create({ decisionId, idempotencyKey, agentId, ownerAddress: OWNER, side, token: TOKEN,
    route: { hops: [], fees: [] }, amountWei: 5n, entryWei: 5n, positionId: `position-${counter}`, closeReason: "llm",
    settlementAsset: "USDT" });
  return { decisionId, idempotencyKey, created };
}

describe("disposeInertSell — memory and PostgreSQL parity", () => {
  let local: Awaited<ReturnType<typeof localPostgres>> = null;
  let sql: SqlClient | undefined;
  let pg: PostgresTradeIntentStore | undefined;
  before(async () => {
    local = await localPostgres();
    if (local !== null) { sql = await createPgSqlClient(local.url); pg = await PostgresTradeIntentStore.create(sql); }
  });
  after(async () => { await sql?.close(); await local?.close(); });

  const variants: readonly { readonly name: string; readonly make: () => TradeIntentStore | undefined }[] = [
    { name: "memory", make: () => new MemoryTradeIntentStore(() => 1_000) },
    { name: "postgres", make: () => pg },
  ];

  for (const variant of variants) {
    const run = (name: string, body: (store: TradeIntentStore, agentId: string) => Promise<void>) => it(`${name} — ${variant.name}`, async (t) => {
      const store = variant.make();
      if (store === undefined) { t.skip("owned disposable PostgreSQL is unavailable"); return; }
      counter += 1;
      await body(store, `agent-${variant.name}-${counter}`);
    });

    run("changes a pending hashless intent once, then reports false on repeat", async (store, agentId) => {
      const { decisionId, idempotencyKey } = await seed(store, agentId);
      const evidence = evidenceFor(idempotencyKey);
      assert.deepEqual(await store.disposeInertSell(OWNER, agentId, decisionId, evidence), { changed: true });
      assert.deepEqual(await store.disposeInertSell(OWNER, agentId, decisionId, evidence), { changed: false });
      const row = await store.get(OWNER, agentId, decisionId);
      assert.equal(row?.state, "rolled-back");
      assert.equal(row?.txHash, null);
      assert.equal(row?.dispositionEvidence, evidence);
      assert.deepEqual((await store.listUnsettled(OWNER, agentId)).map((item) => item.decisionId), []);
    });

    run("disposition-evidence-full-payload-roundtrips (a 430-byte payload is stored verbatim; an over-limit one is refused)", async (store, agentId) => {
      const { decisionId, idempotencyKey } = await seed(store, agentId);
      const evidence = evidenceFor(idempotencyKey);
      assert.equal(Buffer.byteLength(evidence, "utf8"), 430);
      assert.equal((await store.disposeInertSell(OWNER, agentId, decisionId, evidence)).changed, true);
      const stored = (await store.get(OWNER, agentId, decisionId))?.dispositionEvidence;
      assert.equal(stored, evidence);
      assert.equal(parseInertEvidence(stored)?.journalKey, idempotencyKey);
      const other = await seed(store, agentId);
      const oversized = "x".repeat(INERT_EVIDENCE_MAX_BYTES + 1);
      await assert.rejects(store.disposeInertSell(OWNER, agentId, other.decisionId, oversized), /too large/u);
      const untouched = await store.get(OWNER, agentId, other.decisionId);
      assert.equal(untouched?.state, "pending");
      assert.equal(untouched?.dispositionEvidence, undefined);
      // The limit itself is accepted.
      assert.equal((await store.disposeInertSell(OWNER, agentId, other.decisionId, "y".repeat(INERT_EVIDENCE_MAX_BYTES))).changed, true);
    });

    run("does not change a non-pending row", async (store, agentId) => {
      const projected = await seed(store, agentId);
      await store.markProjected(OWNER, agentId, projected.decisionId);
      assert.deepEqual(await store.disposeInertSell(OWNER, agentId, projected.decisionId, evidenceFor(projected.idempotencyKey)), { changed: false });
      assert.equal((await store.get(OWNER, agentId, projected.decisionId))?.state, "projected");
      const rolledBack = await seed(store, agentId);
      await store.markRolledBack(OWNER, agentId, rolledBack.decisionId, "refused");
      assert.deepEqual(await store.disposeInertSell(OWNER, agentId, rolledBack.decisionId, evidenceFor(rolledBack.idempotencyKey)), { changed: false });
      assert.equal((await store.get(OWNER, agentId, rolledBack.decisionId))?.dispositionEvidence, undefined);
    });

    run("does not change a row that gained a tx hash while still pending", async (store, agentId) => {
      const { decisionId, idempotencyKey } = await seed(store, agentId);
      await store.markSubmitted(OWNER, agentId, decisionId, TX);
      assert.equal((await store.get(OWNER, agentId, decisionId))?.state, "pending");
      assert.deepEqual(await store.disposeInertSell(OWNER, agentId, decisionId, evidenceFor(idempotencyKey)), { changed: false });
      const row = await store.get(OWNER, agentId, decisionId);
      assert.equal(row?.state, "pending");
      assert.equal(row?.txHash, TX);
      assert.equal(row?.dispositionEvidence, undefined);
    });

    run("an ordinary markRolledBack never writes evidence", async (store, agentId) => {
      const { decisionId } = await seed(store, agentId);
      const row = await store.markRolledBack(OWNER, agentId, decisionId, "Trade journal rolled back before projection.");
      assert.equal(row?.state, "rolled-back");
      assert.equal(row?.dispositionEvidence, undefined);
      assert.equal((await store.get(OWNER, agentId, decisionId))?.dispositionEvidence, undefined);
    });

    run("dispose-wrong-owner-refuses", async (store, agentId) => {
      const { decisionId, idempotencyKey } = await seed(store, agentId);
      assert.deepEqual(await store.disposeInertSell(OTHER_OWNER as Address, agentId, decisionId, evidenceFor(idempotencyKey)), { changed: false });
      assert.equal((await store.get(OWNER, agentId, decisionId))?.state, "pending");
    });

    run("dispose-wrong-agent-refuses", async (store, agentId) => {
      const { decisionId, idempotencyKey } = await seed(store, agentId);
      assert.deepEqual(await store.disposeInertSell(OWNER, `${agentId}-other`, decisionId, evidenceFor(idempotencyKey)), { changed: false });
      assert.equal((await store.get(OWNER, agentId, decisionId))?.state, "pending");
    });

    run("two concurrent disposals: exactly one wins", async (store, agentId) => {
      const { decisionId, idempotencyKey } = await seed(store, agentId);
      const results = await Promise.all([
        store.disposeInertSell(OWNER, agentId, decisionId, evidenceFor(idempotencyKey)),
        store.disposeInertSell(OWNER, agentId, decisionId, evidenceFor(idempotencyKey)),
      ]);
      assert.deepEqual(results.map((row) => row.changed).sort(), [false, true]);
    });

    run("a disposed row leaves the unsettled and projected inventories but stays readable", async (store, agentId) => {
      const { decisionId, idempotencyKey } = await seed(store, agentId);
      await store.disposeInertSell(OWNER, agentId, decisionId, evidenceFor(idempotencyKey));
      assert.deepEqual(await store.listUnsettled(OWNER, agentId), []);
      assert.deepEqual(await store.listProjectedV2(OWNER, agentId), []);
      assert.equal((await store.get(OWNER, agentId, decisionId))?.decisionId, decisionId);
    });
  }
});
