import assert from "node:assert/strict";
import { it } from "node:test";
import { decodeFunctionData, keccak256, parseAbi, stringToBytes, type Address, type Hex } from "viem";
import { MemoryTradeCmcStore, type CmcOwnerExecutionProof } from "../src/store/tradeCmc.js";
import { buildIncreaseAllowanceCall, buildCheckerApprovalCall } from "../src/trade/cmcOwnerService.js";
import { CMC_PERMIT2 } from "../src/trade/cmcCapability.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { canonicalEncode } from "../src/auth/canonical.js";

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const KEY = `0x04${"22".repeat(64)}` as Hex;
const HASH = `0x${"33".repeat(32)}` as Hex;
const UNIT = 10n ** 18n;
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

async function initial(store: MemoryTradeCmcStore, agentId = "agent-a") {
  await store.putInitial({ agentId, ownerAddress: OWNER, wallet: OWNER, totalWei: 2n * UNIT });
  const operationId = `${agentId}-initial`;
  const prepared = await store.prepareOwnerOperation({ operationId, agentId, ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 0, incrementWei: 2n * UNIT, sessionPublicKey: KEY,
    sessionExpiry: 10_000, priorAllowanceWei: 0n, expectedAllowanceWei: 2n * UNIT,
    keyHash: HASH, ...plan(2n * UNIT) });
  assert.ok(prepared);
  assert.ok(await store.recordOwnerAttempt({ operationId, agentId, ownerAddress: OWNER, attemptId: "first" }));
  const input = { operationId, agentId, ownerAddress: OWNER, expectedGeneration: 0, callsId: HASH, allowanceWei: 2n * UNIT,
    executionProof: executionProof(1) };
  const confirmed = await store.confirmOwnerOperation(input);
  assert.ok(confirmed);
  return { confirmed, input };
}

it("CMC initial owner confirmation adds its signed total exactly once", async () => {
  const store = new MemoryTradeCmcStore(clock);
  const { confirmed, input } = await initial(store);
  assert.equal(confirmed.budget.authorizedTotalWei, 2n * UNIT);
  const duplicate = await store.confirmOwnerOperation(input);
  assert.ok(duplicate);
  assert.equal(duplicate.budget.authorizedTotalWei, 2n * UNIT);
  assert.equal(duplicate.budget.generation, confirmed.budget.generation);
});

it("CMC top-up adopts fresh allowance instead of restoring a pre-prompt balance", async () => {
  const store = new MemoryTradeCmcStore(clock);
  await initial(store);
  const operationId = "topup-after-spend";
  assert.ok(await store.prepareOwnerOperation({ operationId, agentId: "agent-a", ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 1, incrementWei: UNIT, sessionPublicKey: KEY,
    sessionExpiry: 10_000, priorAllowanceWei: 2n * UNIT, expectedAllowanceWei: 3n * UNIT,
    keyHash: HASH, ...plan(UNIT) }));
  assert.ok(await store.recordOwnerAttempt({ operationId, agentId: "agent-a", ownerAddress: OWNER, attemptId: "topup-attempt" }));
  assert.equal(await store.confirmOwnerOperation({ operationId, agentId: "agent-a", ownerAddress: OWNER,
    expectedGeneration: 1, callsId: HASH, allowanceWei: UNIT, executionProof: executionProof(1) }), null,
  "the initial setup execution must not also fund a later top-up");
  assert.equal(await store.confirmOwnerOperation({ operationId, agentId: "agent-a", ownerAddress: OWNER,
    expectedGeneration: 1, callsId: `0x${"44".repeat(32)}` as Hex, allowanceWei: UNIT, executionProof: executionProof(1) }), null,
  "a different relay alias must not reuse the same chain execution");
  const confirmed = await store.confirmOwnerOperation({ operationId, agentId: "agent-a", ownerAddress: OWNER,
    expectedGeneration: 1, callsId: `0x${"44".repeat(32)}` as Hex, allowanceWei: UNIT, executionProof: executionProof(2) });
  assert.ok(confirmed);
  assert.equal(confirmed.budget.authorizedTotalWei, 3n * UNIT);
  assert.equal(confirmed.budget.allowanceWei, UNIT);
});

it("CMC duplicate confirmation cannot read another agent's confirmed operation", async () => {
  const store = new MemoryTradeCmcStore(clock);
  const { input } = await initial(store);
  await store.putInitial({ agentId: "agent-b", ownerAddress: OWNER, wallet: OWNER, totalWei: UNIT });
  assert.equal(await store.confirmOwnerOperation({ ...input, agentId: "agent-b" }), null);
});

it("CMC off-on preserves totals and clears only the intentional disabled reason", async () => {
  const store = new MemoryTradeCmcStore(clock);
  await initial(store);
  await store.toggle({ agentId: "agent-a", ownerAddress: OWNER, optedIn: false });
  const resumed = await store.toggle({ agentId: "agent-a", ownerAddress: OWNER, optedIn: true });
  assert.ok(resumed);
  assert.equal(resumed.authorizedTotalWei, 2n * UNIT);
  assert.equal(resumed.settledWei, 0n);
  assert.notEqual(resumed.reason, "news_disabled");
});

it("CMC owner allowance increments canonical Permit2, not the settlement proxy", () => {
  const call = buildIncreaseAllowanceCall({ amountWei: UNIT });
  assert.equal(call.to.toLowerCase(), USDT_56.toLowerCase());
  const decoded = decodeFunctionData({ abi: parseAbi(["function increaseAllowance(address spender,uint256 addedValue) returns (bool)"]), data: call.data });
  assert.equal(decoded.args[0].toLowerCase(), CMC_PERMIT2.toLowerCase());
  assert.equal(decoded.args[1], UNIT);
});

it("CMC session signature checker is Permit2, the ERC1271 caller", () => {
  const call = buildCheckerApprovalCall({ wallet: OWNER, keyHash: HASH, approved: true });
  assert.equal(call.to, OWNER);
  const decoded = decodeFunctionData({ abi: parseAbi(["function setSignatureCheckerApproval(bytes32 keyHash,address checker,bool approved)"]), data: call.data });
  assert.equal(decoded.args[0], HASH);
  assert.equal(decoded.args[1].toLowerCase(), CMC_PERMIT2.toLowerCase());
  assert.equal(decoded.args[2], true);
});
