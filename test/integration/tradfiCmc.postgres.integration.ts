/** Opt-in audit against a disposable loopback database, never DATABASE_URL. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getAddress, type Hex } from "viem";
import { PostgresTradeCmcStore } from "../../src/store/tradeCmc.js";
import { createPgSqlClient, type SqlClient, type SqlQueryOptions } from "../../src/store/sql.js";
import { CMC_PAYEE, CMC_PRICE_ATOMIC, CMC_SPENDER } from "../../src/trade/cmc.js";
import { USDT_56 } from "../../src/trade/settlement.js";

const connectionString = process.env["TRADFI_AUDIT_DATABASE_URL"] ?? "";
const parsed = new URL(connectionString);
if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/tradfi_cmc_audit"
  || parsed.username !== "tradfi_auditor" || parsed.port !== "15493") {
  throw new Error("This audit requires its dedicated disposable loopback database.");
}
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const KEY = `0x04${"33".repeat(64)}` as Hex;
const NOW = 1_000_000;
const TOTAL = 2n * 10n ** 18n;

async function seed(store: PostgresTradeCmcStore, agentId: string): Promise<void> {
  await store.putInitial({ agentId, ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId, ownerAddress: OWNER, wallet: WALLET, generation: 0,
    sessionPublicKey: KEY, sessionExpiry: 2_000_000, allowanceWei: TOTAL });
  await store.setCapability({ agentId, ownerAddress: OWNER, generation: 0, available: true });
}

function reservation(agentId: string, operationId = randomUUID()) {
  return { agentId, ownerAddress: OWNER, wallet: WALLET, operationId, attemptId: randomUUID(),
    amountWei: CMC_PRICE_ATOMIC, sessionPublicKey: KEY, sessionExpiry: 2_000_000,
    asset: USDT_56, spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE };
}

test("real PostgreSQL serializes independent CMC reservations and survives reconnect", async () => {
  const first = await PostgresTradeCmcStore.create(await createPgSqlClient(connectionString), () => NOW);
  const second = await PostgresTradeCmcStore.create(await createPgSqlClient(connectionString), () => NOW);
  const agentId = randomUUID();
  try {
    await seed(first, agentId);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 === 0 ? first : second).reserve(reservation(agentId))));
    const winners = results.filter((result) => result !== null);
    assert.equal(winners.length, 1);
    const restarted = await PostgresTradeCmcStore.create(await createPgSqlClient(connectionString), () => NOW);
    try {
      const row = await restarted.get(agentId, OWNER);
      assert.equal(row?.reservedWei, CMC_PRICE_ATOMIC);
      assert.equal(row?.pendingOperationId, winners[0]!.attempt.operationId);
      assert.equal((await restarted.getAttempt(agentId, OWNER, winners[0]!.attempt.operationId))?.state, "reserved");
    } finally { await restarted.close(); }
  } finally { await first.close(); await second.close(); }
});

test("real PostgreSQL rolls back a snapshot already written before an injected failure", async () => {
  const base = await createPgSqlClient(connectionString);
  let inject = false;
  const wrapped: SqlClient = {
    query: (text, params, options) => base.query(text, params, options),
    close: () => base.close(),
    transaction: (work) => base.transaction((tx) => work({ ...tx,
      async query<Row>(text: string, params?: readonly unknown[], options?: SqlQueryOptions) {
        const result = await tx.query<Row>(text, params, options);
        if (inject && text.startsWith("insert into trade_cmc_snapshots")) {
          inject = false;
          throw new Error("audit failure after persisted write");
        }
        return result;
      },
    })),
  };
  const store = await PostgresTradeCmcStore.create(wrapped, () => NOW);
  const observer = await PostgresTradeCmcStore.create(await createPgSqlClient(connectionString), () => NOW);
  const agentId = randomUUID();
  try {
    await seed(store, agentId);
    inject = true;
    await assert.rejects(store.toggle({ agentId, ownerAddress: OWNER, optedIn: false }), /audit failure/);
    const after = await observer.get(agentId, OWNER);
    assert.equal(after?.optedIn, true);
    assert.equal(after?.authorizedTotalWei, TOTAL);
    assert.equal(after?.reservedWei, 0n);
  } finally { await store.close(); await observer.close(); }
});

test("real PostgreSQL opt-out is visible to another payment process before reservation", async () => {
  const first = await PostgresTradeCmcStore.create(await createPgSqlClient(connectionString), () => NOW);
  const second = await PostgresTradeCmcStore.create(await createPgSqlClient(connectionString), () => NOW);
  const agentId = randomUUID();
  try {
    await seed(first, agentId);
    await second.get(agentId, OWNER);
    await first.toggle({ agentId, ownerAddress: OWNER, optedIn: false });
    assert.equal(await second.reserve(reservation(agentId)), null);
    assert.equal((await second.get(agentId, OWNER))?.reservedWei, 0n);
  } finally { await first.close(); await second.close(); }
});
