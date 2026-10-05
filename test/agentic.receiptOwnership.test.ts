import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, keccak256, stringToBytes, type Hex } from "viem";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";

test("Agentic receipt tag passes the unchanged validator and one receipt log cannot be adopted twice", async () => {
  const tag = keccak256(stringToBytes("agentic-v1"));
  assert.equal(tag, "0x4f21ff96e0d93f9fc1c3efaf0c55d3578e1a223c4c4fc997b53f6f9f91b8c472");
  const wallet = getAddress("0x1111111111111111111111111111111111111111");
  const token = getAddress("0x2222222222222222222222222222222222222222");
  const txHash = `0x${"33".repeat(32)}` as Hex;
  const key = `56|${txHash}|${wallet.toLowerCase()}|0|${tag}`;
  const positions = new MemoryTradePositionStore(() => 1_900_000_000_000);
  for (const positionId of ["first", "second"]) {
    await positions.open({ positionId, agentId: "agentic-receipt", ownerAddress: wallet, token,
      route: { hops: [], fees: [] }, entryWei: 1n, tokenAmount: null, fillStatus: "unverified",
      openedAt: 1_900_000_000_000, settlementAsset: "USDT", requestedEntryAtomic: 1n, verifiedEntryAtomic: null });
  }
  const first = await positions.adoptVerifiedEntry({ ownerAddress: wallet, agentId: "agentic-receipt",
    positionId: "first", verifiedEntryAtomic: 1n, tokenAmount: 2n, receiptOwnershipKey: key });
  assert.equal(first?.receiptOwnershipKey, key);
  assert.equal(first?.verifiedEntryAtomic, 1n);
  const second = await positions.adoptVerifiedEntry({ ownerAddress: wallet, agentId: "agentic-receipt",
    positionId: "second", verifiedEntryAtomic: 1n, tokenAmount: 2n, receiptOwnershipKey: key });
  assert.equal(second?.receiptOwnershipKey ?? null, null);
  assert.equal(second?.verifiedEntryAtomic, null);
  await assert.rejects(positions.open({ positionId: "third", agentId: "agentic-receipt", ownerAddress: wallet, token,
    route: { hops: [], fees: [] }, entryWei: 1n, tokenAmount: 2n, fillStatus: "verified",
    openedAt: 1_900_000_000_000, settlementAsset: "USDT", requestedEntryAtomic: 1n,
    verifiedEntryAtomic: 1n, receiptOwnershipKey: key }), /Receipt ownership is already claimed/);
});
