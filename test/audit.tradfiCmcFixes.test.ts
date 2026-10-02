import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { CMC_PAYEE, CMC_PRICE_ATOMIC, CMC_SPENDER, hashCmcBody } from "../src/trade/cmc.js";
import { CMC_PERMIT2 } from "../src/trade/cmcCapability.js";
import { createCmcRpcCapabilityReader, type CmcMatrixTrace } from "../src/trade/cmcRpc.js";
import { USDT_56 } from "../src/trade/settlement.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const KEY = `0x04${"33".repeat(64)}` as Hex;
const OLD_KEY = `0x04${"22".repeat(64)}` as Hex;
const H = `0x${"44".repeat(32)}` as Hex;
const OTHER_H = `0x${"55".repeat(32)}` as Hex;
const TOTAL = 2n * 10n ** 18n;
const AGENT = "cmc-fix-review";

async function ready(clock: () => number) {
  const store = new MemoryTradeCmcStore(clock);
  await store.putInitial({ agentId: AGENT, ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId: AGENT, ownerAddress: OWNER, wallet: WALLET, generation: 0,
    sessionPublicKey: KEY, sessionExpiry: 100_000, allowanceWei: TOTAL });
  await store.setCapability({ agentId: AGENT, ownerAddress: OWNER, generation: 0, available: true });
  return store;
}

test("CMC fix review: expired former checker does not block concrete rebind capability", async (context) => {
  const now = Math.floor(Date.now() / 1000);
  const currentHash = accountKeyHashForAddress(publicKeyToAddress(KEY));
  const oldHash = accountKeyHashForAddress(publicKeyToAddress(OLD_KEY));
  const abi = parseAbi([
    "function getKeys() view returns ((uint40 expiry,uint8 keyType,bool isSuperAdmin,bytes publicKey)[] keys,bytes32[] keyHashes)",
    "function approvedSignatureCheckers(bytes32 keyHash) view returns(address[])",
    "function allowance(address owner,address spender) view returns(uint256)",
  ]);
  const trace: CmcMatrixTrace = { ownerApprovalPersists: true, unrelatedTradingPreservesAllowance: true,
    sessionApproveCannotIncreaseAllowance: true, noTemporaryApproveConsumePath: true,
    temporaryApproveCallbackReentryExcluded: true, revokeExpiryRejectsPayment: true,
    walletKeyExclusive: true, additiveIncreaseAllowance: true, proofDigests: [H],
    grantShapeDigest: H, profileId: "offline-reviewed-fixture" };
  const SPEC = { allowedCalls: [{ to: USDT_56, selector: "approve(address,uint256)" }], spendCaps: [{ token: USDT_56 }] };
  const fakeFetch: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { readonly id: number; readonly method: string; readonly params: readonly { readonly data: Hex }[] };
    let result: unknown;
    if (request.method === "eth_getCode") result = "0x6000";
    else if (request.method === "eth_chainId") result = "0x38";
    else if (request.method === "eth_getBlockByNumber" || request.method === "eth_getBlockByHash") {
      result = { number: "0x64", hash: H, timestamp: `0x${now.toString(16)}`, transactions: [] };
    }
    else if (request.method === "eth_call") {
      const decoded = decodeFunctionData({ abi, data: request.params[0]!.data });
      if (decoded.functionName === "getKeys") result = encodeFunctionResult({ abi, functionName: "getKeys", result: [[
        { expiry: now + 10_000, keyType: 2, isSuperAdmin: false, publicKey: KEY },
        { expiry: now - 1, keyType: 2, isSuperAdmin: false, publicKey: OLD_KEY },
      ], [currentHash, oldHash]] });
      else if (decoded.functionName === "allowance") result = encodeFunctionResult({ abi, functionName: "allowance", result: TOTAL });
      else result = encodeFunctionResult({ abi, functionName: "approvedSignatureCheckers",
        result: decoded.args[0].toLowerCase() === oldHash.toLowerCase() ? [CMC_PERMIT2] : [] });
    } else throw new Error(`unexpected offline RPC ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
  };
  context.mock.method(globalThis, "fetch", fakeFetch);
  const reader = createCmcRpcCapabilityReader({ rpcUrl: "https://offline.invalid", sessionSpec: async () => SPEC, matrixTrace: async () => trace });
  const evidence = await reader.read({ agentId: AGENT, wallet: WALLET, sessionPublicKey: KEY, generation: 1 });
  assert.ok(evidence);
  assert.equal(evidence.checkerApproved, false);
});

test("CMC fix review: displaced pre-challenge worker cannot reserve against a replacement lease", async () => {
  let now = 1_000_000;
  const store = await ready(() => now);
  await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "old", nowMs: now });
  now += 7_200_000;
  assert.equal(await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "new", nowMs: now }), true);
  const staleReservation = await store.reserve({ agentId: AGENT, ownerAddress: OWNER, wallet: WALLET,
    operationId: "old", attemptId: "old-attempt", amountWei: CMC_PRICE_ATOMIC, nowMs: now });
  assert.equal(staleReservation, null);
});

test("CMC fix review: reclaiming an unsigned reservation also releases its budget hold", async () => {
  let now = 1_000_000;
  const store = await ready(() => now);
  await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "old", nowMs: now });
  assert.ok(await store.reserve({ agentId: AGENT, ownerAddress: OWNER, wallet: WALLET,
    operationId: "old", attemptId: "old-attempt", amountWei: CMC_PRICE_ATOMIC, nowMs: now }));
  now += 7_200_000;
  assert.equal(await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "new", nowMs: now }), true);
  assert.ok(await store.reserve({ agentId: AGENT, ownerAddress: OWNER, wallet: WALLET,
    operationId: "new", attemptId: "new-attempt", amountWei: CMC_PRICE_ATOMIC, nowMs: now }));
  assert.equal((await store.get(AGENT, OWNER))?.reservedWei, CMC_PRICE_ATOMIC);
});

test("CMC fix review: an untrusted transaction hint cannot veto exact charge proof", async () => {
  const now = 1_000_000;
  const store = await ready(() => now);
  await store.reserve({ agentId: AGENT, ownerAddress: OWNER, wallet: WALLET,
    operationId: "paid", attemptId: "paid-attempt", amountWei: CMC_PRICE_ATOMIC });
  await store.prepare({ agentId: AGENT, ownerAddress: OWNER, wallet: WALLET, operationId: "paid", generation: 0,
    sessionPublicKey: KEY, sessionExpiry: 100_000, asset: USDT_56, amountWei: CMC_PRICE_ATOMIC,
    spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE, validAfter: 0n, deadline: 1_500n,
    nonce: 42n, requestDigest: hashCmcBody("fixture"), bodyHash: hashCmcBody("fixture") });
  await store.transition({ agentId: AGENT, ownerAddress: OWNER, operationId: "paid", generation: 0,
    from: "prepared", to: "transmitting", disclosurePossible: true });
  await store.setSettlementHint({ agentId: AGENT, ownerAddress: OWNER, operationId: "paid", generation: 0, txHashHint: OTHER_H });
  const result = await store.settle({ agentId: AGENT, ownerAddress: OWNER, operationId: "paid", generation: 0,
    txHash: H, proof: { kind: "charge", chainId: 56, txHash: H, payer: WALLET, asset: USDT_56,
      amountWei: CMC_PRICE_ATOMIC, nonce: 42n, deadline: 1_500n, witnessTo: CMC_PAYEE,
      validAfter: 0n, attemptId: "paid-attempt" } });
  assert.ok(result);
  assert.equal(result.attempt.txHash, H);
});
