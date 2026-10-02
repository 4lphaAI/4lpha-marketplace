/** Receipt adoption audit against the dedicated disposable loopback cluster. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getAddress, keccak256, stringToBytes } from "viem";
import { PostgresTradePositionStore } from "../../src/store/tradePositions.js";
import { createPgSqlClient } from "../../src/store/sql.js";

const connectionString = process.env["TRADFI_AUDIT_DATABASE_URL"] ?? "";
const url = new URL(connectionString);
if (url.hostname !== "127.0.0.1" || url.port !== "15493" || url.pathname !== "/tradfi_cmc_audit"
  || url.username !== "tradfi_auditor") throw new Error("Dedicated disposable audit database required.");
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const E = 10n ** 18n;

test("real PostgreSQL adopts late entry and exit evidence on closed TradFi positions", async () => {
  const store = await PostgresTradePositionStore.create(await createPgSqlClient(connectionString));
  const agentId = randomUUID();
  const positionId = randomUUID();
  const hash = keccak256(stringToBytes(positionId));
  try {
    await store.open({ positionId, agentId, ownerAddress: OWNER, token: TOKEN,
      route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: null, fillStatus: "unverified",
      openedAt: Date.now(), settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: null });
    await store.closePosition({ positionId, agentId, ownerAddress: OWNER, exitWei: null,
      exitFillStatus: "unverified", reason: "owner-request" });
    const entryKey = `56|${hash}|${OWNER.toLowerCase()}|0|${hash}`;
    const exitKey = `56|${hash}|${OWNER.toLowerCase()}|1|${hash}`;
    await store.adoptVerifiedEntry({ positionId, agentId, ownerAddress: OWNER,
      verifiedEntryAtomic: 5n * E, receiptOwnershipKey: entryKey });
    const incomplete = await store.get(OWNER, agentId, positionId);
    assert.ok(incomplete);
    assert.equal(incomplete.verifiedEntryAtomic ?? null, null,
      "Missing verified token quantity must not create a verified fill.");
    assert.equal(incomplete.fillStatus, "unverified");
    assert.equal(incomplete.tokenAmount, null);
    assert.ok(await store.adoptVerifiedEntry({ positionId, agentId, ownerAddress: OWNER,
      verifiedEntryAtomic: 5n * E, tokenAmount: 5n * E, receiptOwnershipKey: entryKey }));
    assert.ok(await store.adoptVerifiedExit({ positionId, agentId, ownerAddress: OWNER,
      exitWei: 6n * E, receiptOwnershipKey: exitKey }));
    const row = await store.get(OWNER, agentId, positionId);
    assert.equal(row?.status, "closed");
    assert.equal(row?.verifiedEntryAtomic, 5n * E);
    assert.equal(row?.fillStatus, "verified");
    assert.equal(row?.tokenAmount, 5n * E);
    assert.equal(row?.exitWei, 6n * E);
    assert.equal(row?.exitFillStatus, "verified");
    assert.equal(row?.receiptOwnershipKey, entryKey);
    assert.equal(row?.exitReceiptOwnershipKey, exitKey);
    await store.adoptVerifiedExit({ positionId, agentId, ownerAddress: OWNER,
      exitWei: 99n * E, receiptOwnershipKey: exitKey });
    assert.equal((await store.get(OWNER, agentId, positionId))?.exitWei, 6n * E);
  } finally { await store.close(); }
});

test("real PostgreSQL permits only one position to claim a shared exit receipt", async () => {
  const first = await PostgresTradePositionStore.create(await createPgSqlClient(connectionString));
  const second = await PostgresTradePositionStore.create(await createPgSqlClient(connectionString));
  const agentId = randomUUID();
  const ids = [randomUUID(), randomUUID()];
  const hash = keccak256(stringToBytes(agentId));
  const receiptOwnershipKey = `56|${hash}|${OWNER.toLowerCase()}|1|${hash}`;
  try {
    for (const positionId of ids) {
      await first.open({ positionId, agentId, ownerAddress: OWNER, token: TOKEN,
        route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: null, fillStatus: "unverified",
        openedAt: Date.now(), settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: null });
      await first.closePosition({ positionId, agentId, ownerAddress: OWNER,
        exitWei: null, exitFillStatus: "unverified", reason: "owner-request" });
    }
    const results = await Promise.allSettled(ids.map((positionId, index) =>
      (index === 0 ? first : second).adoptVerifiedExit({ positionId, agentId, ownerAddress: OWNER,
        exitWei: 6n * E, receiptOwnershipKey })));
    for (const result of results) {
      if (result.status === "rejected") {
        assert.equal((result.reason as { code?: string }).code, "23505", "Only the ownership uniqueness conflict may reject.");
      }
    }
    const rows = await first.list(OWNER, agentId);
    assert.equal(rows.filter((row) => row.exitWei === 6n * E && row.exitReceiptOwnershipKey === receiptOwnershipKey).length, 1);
    assert.equal(rows.filter((row) => row.exitWei === null).length, 1);
  } finally { await first.close(); await second.close(); }
});
