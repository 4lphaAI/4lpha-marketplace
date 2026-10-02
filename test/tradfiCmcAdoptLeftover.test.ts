/**
 * HOTFIX 2026-09-22: a re-hired passkey wallet keeps the removed agent's Permit2
 * allowance on chain. The initial CMC owner setup adopts it instead of refusing.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { MemoryTradeCmcStore, type CmcOwnerExecutionProof } from "../src/store/tradeCmc.js";
import { buildIncreaseAllowanceCall, buildCheckerApprovalCall, createCmcOwnerService } from "../src/trade/cmcOwnerService.js";
import { canonicalEncode } from "../src/auth/canonical.js";

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const KEY = `0x04${"22".repeat(64)}` as Hex;
const HASH = `0x${"33".repeat(32)}` as Hex;
const UNIT = 10n ** 18n;
const LEFTOVER = 187n * UNIT / 100n; // 1.87 USDT observed on 0x2714…9da6
const clock = () => 1_000_000;

function executionProof(sequence: number): CmcOwnerExecutionProof {
  const suffix = sequence.toString(16).padStart(64, "0");
  return { chainId: 56, wallet: OWNER, txHash: `0x${suffix}`, blockHash: HASH,
    blockNumber: 100n, blockTimestamp: 1000n, intentId: `0x${suffix}`, executionNonce: BigInt(sequence) };
}

function plan(amountWei: bigint) {
  const calls = [buildIncreaseAllowanceCall({ amountWei }), buildCheckerApprovalCall({ wallet: OWNER, keyHash: HASH, approved: true })];
  return { wallet: OWNER, oldCheckerKeyHash: null, calls, callsDigest: keccak256(stringToBytes(canonicalEncode(calls))) };
}

it("CMC initial owner service prepare accepts a leftover allowance and expects prior + increment", async () => {
  const store = new MemoryTradeCmcStore(clock);
  await store.putInitial({ agentId: "rehire", ownerAddress: OWNER, wallet: OWNER, totalWei: UNIT });
  const ownerService = createCmcOwnerService({ store,
    capability: { check: async () => ({ available: true, profileId: "reviewed" }) },
    chain: {
      readState: async () => ({ allowanceWei: LEFTOVER, checkerApproved: false, oldCheckerKeyHash: null }),
      verifyOwnerExecution: async () => { throw new Error("not reached during prepare"); },
    }, now: clock });
  const prepared = await ownerService.prepare({ operationId: "op", agentId: "rehire", ownerAddress: OWNER, wallet: OWNER,
    mode: "topup", expectedGeneration: 0, additionalBudgetWei: UNIT.toString(), sessionPublicKey: KEY,
    sessionExpiry: 2_000_000, signedInitialTotalWei: UNIT });
  assert.ok(prepared, "a leftover allowance must not refuse the initial setup");
  assert.equal(prepared.operation.priorAllowanceWei, LEFTOVER);
  assert.equal(prepared.operation.expectedAllowanceWei, LEFTOVER + UNIT);
  assert.equal(prepared.operation.incrementWei, UNIT);
});

it("CMC initial owner confirmation adopts the leftover: allowance must equal prior + increment and becomes the authorised total", async () => {
  const store = new MemoryTradeCmcStore(clock);
  await store.putInitial({ agentId: "rehire", ownerAddress: OWNER, wallet: OWNER, totalWei: UNIT });
  const operationId = "rehire-initial";
  assert.ok(await store.prepareOwnerOperation({ operationId, agentId: "rehire", ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 0, incrementWei: UNIT, sessionPublicKey: KEY,
    sessionExpiry: 10_000, priorAllowanceWei: LEFTOVER, expectedAllowanceWei: LEFTOVER + UNIT,
    keyHash: HASH, ...plan(UNIT) }));
  assert.ok(await store.recordOwnerAttempt({ operationId, agentId: "rehire", ownerAddress: OWNER, attemptId: "first" }));
  const base = { operationId, agentId: "rehire", ownerAddress: OWNER, expectedGeneration: 0, callsId: HASH, executionProof: executionProof(1) };
  assert.equal(await store.confirmOwnerOperation({ ...base, allowanceWei: UNIT }), null, "the bare increment no longer matches the chain");
  const confirmed = await store.confirmOwnerOperation({ ...base, allowanceWei: LEFTOVER + UNIT });
  assert.ok(confirmed);
  assert.equal(confirmed.budget.authorizedTotalWei, LEFTOVER + UNIT);
  assert.equal(confirmed.budget.allowanceWei, LEFTOVER + UNIT);
  assert.equal(confirmed.budget.setupProved, true);
});

it("CMC initial owner confirmation on a clean wallet is unchanged (allowance == increment)", async () => {
  const store = new MemoryTradeCmcStore(clock);
  await store.putInitial({ agentId: "clean", ownerAddress: OWNER, wallet: OWNER, totalWei: UNIT });
  const operationId = "clean-initial";
  assert.ok(await store.prepareOwnerOperation({ operationId, agentId: "clean", ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 0, incrementWei: UNIT, sessionPublicKey: KEY,
    sessionExpiry: 10_000, priorAllowanceWei: 0n, expectedAllowanceWei: UNIT,
    keyHash: HASH, ...plan(UNIT) }));
  assert.ok(await store.recordOwnerAttempt({ operationId, agentId: "clean", ownerAddress: OWNER, attemptId: "first" }));
  const confirmed = await store.confirmOwnerOperation({ operationId, agentId: "clean", ownerAddress: OWNER, expectedGeneration: 0,
    callsId: HASH, allowanceWei: UNIT, executionProof: executionProof(2) });
  assert.ok(confirmed);
  assert.equal(confirmed.budget.authorizedTotalWei, UNIT);
});
