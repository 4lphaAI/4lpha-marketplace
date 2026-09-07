import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { MemoryTradeIntentStore, type CreateTradeIntentInput } from "../src/store/tradeIntents.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const HASH = `0x${"44".repeat(32)}` as Hex;
const TX = `0x${"55".repeat(32)}` as Hex;

describe("durable trade intents", () => {
  it("ignores route object key order but preserves every intent binding", async () => {
    const store = new MemoryTradeIntentStore(() => 1_000);
    const input: CreateTradeIntentInput = { decisionId: "ordered-route", idempotencyKey: HASH,
      agentId: "a1", ownerAddress: OWNER, side: "buy", token: TOKEN,
      route: { hops: [OWNER, OTHER], fees: [100, 500, 2500] }, amountWei: 5n,
      entryWei: 6n, positionId: "p1", closeReason: null };
    const first = await store.create(input);
    assert.deepEqual(await store.create({ ...input,
      route: { fees: [100, 500, 2500], hops: [OWNER, OTHER] } }), first);
    const conflicts: readonly Partial<CreateTradeIntentInput>[] = [
      { idempotencyKey: TX }, { agentId: "a2" }, { ownerAddress: OTHER },
      { side: "sell" }, { token: OTHER }, { amountWei: 6n }, { entryWei: 5n },
      { positionId: "p2" }, { closeReason: "llm" },
      { route: { hops: [OTHER, OWNER], fees: [100, 500, 2500] } },
      { route: { hops: [OWNER, OTHER], fees: [500, 100, 2500] } },
      { route: { hops: [OWNER], fees: [100, 500] } },
    ];
    for (const conflict of conflicts) {
      await assert.rejects(store.create({ ...input, ...conflict }), /already bound/u);
    }
    assert.deepEqual(await store.get(OWNER, "a1", input.decisionId), first);
  });

  it("binds one immutable decision and scopes the unsettled projection by owner", async () => {
    const store = new MemoryTradeIntentStore(() => 1_000);
    const input = { decisionId: "decision-1", idempotencyKey: HASH, agentId: "a1", ownerAddress: OWNER,
      side: "buy" as const, token: TOKEN, route: { hops: [], fees: [] }, amountWei: 5n,
      entryWei: 5n, positionId: "position-1", closeReason: null };
    const first = await store.create(input);
    assert.equal(first.state, "pending");
    assert.equal((await store.create(input)).decisionId, first.decisionId);
    await assert.rejects(store.create({ ...input, amountWei: 6n }), /already bound/u);
    assert.equal((await store.listUnsettled(OTHER, "a1")).length, 0);
    assert.equal((await store.listUnsettled(OWNER, "a1")).length, 1);
    assert.equal((await store.markSubmitted(OWNER, "a1", input.decisionId, TX))?.txHash, TX);
    assert.equal((await store.markProjected(OWNER, "a1", input.decisionId))?.state, "projected");
    assert.equal((await store.listUnsettled(OWNER, "a1")).length, 0);
  });

  it("makes a rollback terminal and bounds its diagnostic note", async () => {
    const store = new MemoryTradeIntentStore(() => 2_000);
    await store.create({ decisionId: "decision-2", idempotencyKey: HASH, agentId: "a1", ownerAddress: OWNER,
      side: "sell", token: TOKEN, route: { hops: [], fees: [] }, amountWei: 9n,
      entryWei: 5n, positionId: "position-1", closeReason: "owner-request" });
    const rolled = await store.markRolledBack(OWNER, "a1", "decision-2", "x".repeat(400));
    assert.equal(rolled?.state, "rolled-back");
    assert.equal(rolled?.note?.length, 300);
    assert.equal((await store.markProjected(OWNER, "a1", "decision-2"))?.state, "rolled-back");
  });
});
