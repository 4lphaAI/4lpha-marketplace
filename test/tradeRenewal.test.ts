import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x2222222222222222222222222222222222222222");
const ROUTE = { hops: [], fees: [] } as const;

function expected(row: Awaited<ReturnType<MemoryTradePositionStore["get"]>> extends infer T ? Exclude<T, null> : never) {
  return {
    sessionGeneration: row.sessionGeneration ?? 0,
    lastQuoteWei: row.lastQuoteWei, lastQuoteBalance: row.lastQuoteBalance, lastQuoteRoute: row.lastQuoteRoute, lastQuoteAtMs: row.lastQuoteAtMs,
    crashPendingSinceMs: row.crashPendingSinceMs, crashPendingKind: row.crashPendingKind,
    crashRefQuoteWei: row.crashRefQuoteWei, crashRefBalance: row.crashRefBalance, crashRefAtMs: row.crashRefAtMs, crashRefRoute: row.crashRefRoute,
    autoExitReason: row.autoExitReason, autoExitAtMs: row.autoExitAtMs, autoExitNote: row.autoExitNote,
  };
}

describe("trade renewal evidence generation", () => {
  it("[F4] re-stamps confirmed crash-stop, clears session-expiring evidence, and is idempotent", async () => {
    const store = new MemoryTradePositionStore(() => 1_900_000_000_000);
    const crash = await store.open({ positionId: "crash", agentId: "agent", ownerAddress: OWNER, token: TOKEN, route: ROUTE, entryWei: 100n, tokenAmount: 10n, fillStatus: "verified", openedAt: 1, entryTxHash: `0x${"11".repeat(32)}` as Hex });
    const expiring = await store.open({ positionId: "expiring", agentId: "agent", ownerAddress: OWNER, token: TOKEN, route: ROUTE, entryWei: 100n, tokenAmount: 10n, fillStatus: "verified", openedAt: 1, entryTxHash: `0x${"22".repeat(32)}` as Hex });
    await store.recordCrashEvidence({ ownerAddress: OWNER, agentId: "agent", positionId: crash.positionId, expected: expected(crash), action: { kind: "marker", reason: "crash-stop", atMs: 10, note: "keep" }, writerGeneration: 0 });
    await store.recordCrashEvidence({ ownerAddress: OWNER, agentId: "agent", positionId: expiring.positionId, expected: expected(expiring), action: { kind: "marker", reason: "session-expiring", atMs: 10, note: "old" }, writerGeneration: 0 });
    assert.equal(await store.rebaseRenewalEvidenceForAgent(OWNER, "agent", 1), true);
    const rows = await store.list(OWNER, "agent");
    assert.equal(rows.find((row) => row.positionId === "crash")?.autoExitReason, "crash-stop");
    assert.equal(rows.find((row) => row.positionId === "crash")?.sessionGeneration, 1);
    assert.equal(rows.find((row) => row.positionId === "crash")?.autoExitAtMs, 10);
    assert.equal(rows.find((row) => row.positionId === "crash")?.autoExitNote, "keep");
    assert.equal(rows.find((row) => row.positionId === "expiring")?.autoExitReason, null);
    assert.equal(await store.rebaseRenewalEvidenceForAgent(OWNER, "agent", 1), true);
    assert.deepEqual(expected((await store.get(OWNER, "agent", "crash"))!), expected(rows.find((row) => row.positionId === "crash")!));
    assert.deepEqual(expected((await store.get(OWNER, "agent", "expiring"))!), expected(rows.find((row) => row.positionId === "expiring")!));
    await store.close();
  });
});
