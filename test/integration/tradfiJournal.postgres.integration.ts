/** Cash-reservation storage audit; accepts only the disposable local cluster. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PostgresExecutionJournal } from "../../src/store/journal.js";
import { createPgSqlClient } from "../../src/store/sql.js";

const connectionString = process.env["TRADFI_AUDIT_DATABASE_URL"] ?? "";
const url = new URL(connectionString);
if (url.hostname !== "127.0.0.1" || url.port !== "15493" || url.pathname !== "/tradfi_cmc_audit"
  || url.username !== "tradfi_auditor") throw new Error("Dedicated disposable audit database required.");

test("real PostgreSQL persists old quote holds and reconciles actual debit across processes", async () => {
  const now = Date.now();
  const first = await PostgresExecutionJournal.create(await createPgSqlClient(connectionString), () => now - 2 * 86_400_000);
  const second = await PostgresExecutionJournal.create(await createPgSqlClient(connectionString));
  const agentId = randomUUID();
  const idempotencyKey = randomUUID();
  const ownerAddress = "0x1111111111111111111111111111111111111111";
  const amount = 10n * 10n ** 18n;
  try {
    await first.beginWithSpend({ idempotencyKey, agentId, ownerAddress, kind: "trade",
      decisionId: randomUUID(), nativeSpendWei: 0n, quoteSpendWei: amount,
      externalRef: { quoteSpendWei: amount.toString() } }, 0);
    assert.equal((await second.get(idempotencyKey))?.externalRef.quoteSpendWei, amount.toString());
    assert.equal(await second.sumPendingQuoteSpendSince(agentId, 0), amount);
    assert.equal(await second.sumPendingQuoteSpendSince(agentId, now - 86_400_000), 0n);
    await first.markInProgress(idempotencyKey, {});
    assert.equal(await second.sumPendingQuoteSpendSince(agentId, 0), amount);
    const actual = 8n * 10n ** 18n;
    await first.markCommitted(idempotencyKey, { actualQuoteSpendWei: actual.toString() });
    assert.equal(await second.sumPendingQuoteSpendSince(agentId, 0), 0n);
    assert.equal((await second.get(idempotencyKey))?.externalRef.actualQuoteSpendWei, actual.toString());
    const next = await second.beginWithSpend({ idempotencyKey: randomUUID(), agentId, ownerAddress, kind: "trade",
      decisionId: randomUUID(), nativeSpendWei: 0n, quoteSpendWei: amount,
      externalRef: { quoteSpendWei: amount.toString() } }, 0);
    assert.equal(next.otherQuoteSpendWei, actual);
  } finally { await first.close(); await second.close(); }
});
