import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, getAddress, padHex, toHex, type Hex } from "viem";
import {
  CMC_CONFIG_ID,
  CMC_MCP_RESOURCE,
  CMC_PAYEE,
  CMC_PRICE_ATOMIC,
  CMC_SIGNER,
  CMC_SPENDER,
  DEFAULT_CMC_BUDGET,
  MemoryTradeCmcStore,
  decryptCmcAuthorization,
  encryptCmcAuthorization,
  hashCmcBody,
  parseCmcChallenge,
} from "../src/trade/cmc.js";
import { CMC_SETTLED_TOPIC, ERC20_TRANSFER_TOPIC, verifyCmcChargeProof, verifyCmcExpiryUnused } from "../src/trade/cmcProof.js";
import { evaluateCmcCapability } from "../src/trade/cmcCapability.js";
import { CMC_PERMIT2, cmcCapabilityEvidenceDigest, createCmcCapabilityGate } from "../src/trade/cmcCapability.js";
import { createCmcOwnerService } from "../src/trade/cmcOwnerService.js";
import { verifyCmcOwnerAdminKeyAtBlock } from "../src/trade/cmcRpc.js";
import { createCmcPaymentClient } from "../src/trade/cmcPayment.js";
import { USDT_56 } from "../src/trade/settlement.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const KEY = `0x04${"22".repeat(64)}` as Hex;
const NOW_MS = 1_000_000_000;
const BODY = "{\"request\":\"fixture\"}";

function challenge() {
  return {
    x402Version: 2,
    resource: { url: CMC_MCP_RESOURCE },
    accepts: [
      { scheme: "exact", network: "eip155:56", asset: USDT_56, amount: CMC_PRICE_ATOMIC.toString(), payTo: CMC_PAYEE,
        maxTimeoutSeconds: 500,
        extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact",
          x402PaymentConfigId: CMC_CONFIG_ID, spenderAddress: CMC_SPENDER, signerAddress: CMC_SIGNER } },
      { scheme: "exact", network: "eip155:56", asset: getAddress("0x2222222222222222222222222222222222222222"), amount: CMC_PRICE_ATOMIC.toString(), payTo: CMC_PAYEE,
        maxTimeoutSeconds: 500, extra: { name: "Other", version: "1", assetTransferMethod: "permit2-exact" } },
    ],
  };
}

async function readyStore() {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "a", ownerAddress: OWNER, wallet: OWNER, totalWei: DEFAULT_CMC_BUDGET });
  await store.setSetup({ agentId: "a", ownerAddress: OWNER, wallet: OWNER, generation: 0, sessionPublicKey: KEY, sessionExpiry: 2_000_000, allowanceWei: DEFAULT_CMC_BUDGET });
  await store.setCapability({ agentId: "a", ownerAddress: OWNER, generation: 0, available: true });
  return store;
}

test("CMC parser binds the v2 root resource and ignores alternate assets", () => {
  const parsed = parseCmcChallenge(challenge());
  assert.ok(parsed);
  assert.equal(parsed.resource, CMC_MCP_RESOURCE);
  assert.equal(parseCmcChallenge({ ...challenge(), resource: { url: "wrong" } }), null);
  assert.equal(parseCmcChallenge({ ...challenge(), accepts: [challenge().accepts[0], challenge().accepts[0]] }), null);
  assert.equal(parseCmcChallenge({ ...challenge(), accepts: [{ ...challenge().accepts[0], resource: { url: "wrong" } }] }), null);
});

test("CMC authorization encryption binds agent, generation and nonce", () => {
  const identity = { chainId: 56 as const, wallet: OWNER, agentId: "a", budgetGeneration: 4, nonce: `0x${"11".repeat(32)}` as Hex };
  const ciphertext = encryptCmcAuthorization({ identity, payload: { signature: "secret" }, masterKey: Buffer.alloc(32, 7) });
  assert.deepEqual(decryptCmcAuthorization({ ciphertext, identity, masterKey: Buffer.alloc(32, 7) }), { signature: "secret" });
  assert.throws(() => decryptCmcAuthorization({ ciphertext, identity: { ...identity, budgetGeneration: 5 }, masterKey: Buffer.alloc(32, 7) }));
});

test("CMC payment states require disclosure CAS and owner/generation binding", async () => {
  const store = await readyStore();
  const reserved = await store.reserve({ agentId: "a", ownerAddress: OWNER, wallet: OWNER, operationId: "op", attemptId: "attempt", amountWei: CMC_PRICE_ATOMIC, sessionPublicKey: KEY, sessionExpiry: 2_000_000, asset: USDT_56, spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE });
  assert.ok(reserved);
  assert.equal(await store.transition({ agentId: "a", ownerAddress: OWNER, operationId: "op", generation: 0, from: "reserved", to: "transmitting", disclosurePossible: true }), null);
  assert.equal(await store.settle({ agentId: "other", ownerAddress: OWNER, operationId: "op", generation: 0, txHash: `0x${"11".repeat(32)}` as Hex,
    proof: { kind: "charge", chainId: 56, txHash: `0x${"11".repeat(32)}` as Hex, payer: OWNER, asset: USDT_56, amountWei: CMC_PRICE_ATOMIC,
      nonce: 1n, deadline: 2_000_000n, witnessTo: CMC_PAYEE, validAfter: 0n, attemptId: "attempt" } }), null);
  assert.ok(await store.release({ agentId: "a", ownerAddress: OWNER, operationId: "op", generation: 0, proof: { kind: "no-disclosure" } }));
});

test("CMC expiry proof needs matching finalized blocks and an unused nonce", async () => {
  const block = { number: 20n, hash: `0x${"aa".repeat(32)}` as Hex, timestamp: 2_000n };
  const reader = { readChainId: async () => 56, readFinalizedBlock: async () => block, readNonceBitmap: async () => 0n };
  const proof = await verifyCmcExpiryUnused({ attemptId: "attempt", payer: OWNER, nonce: 513n, deadline: 1_999n, readers: [reader, reader], nowMs: NOW_MS });
  assert.equal(proof.ok, true);
  const used = await verifyCmcExpiryUnused({ attemptId: "attempt", payer: OWNER, nonce: 513n, deadline: 1_999n, readers: [{ ...reader, readNonceBitmap: async () => 2n }, reader], nowMs: NOW_MS });
  assert.equal(used.ok, false);
  const wrongChain = await verifyCmcExpiryUnused({ attemptId: "attempt", payer: OWNER, nonce: 513n, deadline: 1_999n, readers: [{ ...reader, readChainId: async () => 1 }, reader], nowMs: NOW_MS });
  assert.equal(wrongChain.ok, false);
});

test("CMC charge proof binds direct settle calldata, transfer and Settled event", () => {
  const amount = CMC_PRICE_ATOMIC;
  const nonce = 7n;
  const deadline = 2_000_000n;
  const input = encodeFunctionData({ abi: [{ type: "function", name: "settle", stateMutability: "nonpayable", inputs: [
    { name: "permit", type: "tuple", components: [{ name: "permitted", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { name: "owner", type: "address" }, { name: "witness", type: "tuple", components: [{ name: "to", type: "address" }, { name: "validAfter", type: "uint256" }] }, { name: "signature", type: "bytes" },
  ], outputs: [] }] as const, functionName: "settle", args: [{ permitted: { token: USDT_56, amount }, nonce, deadline }, OWNER, { to: CMC_PAYEE, validAfter: 0n }, "0x"] });
  const receipt = { chainId: 56, status: "success" as const, blockNumber: 10n, blockHash: `0x${"aa".repeat(32)}` as Hex, transactionHash: `0x${"bb".repeat(32)}` as Hex,
    from: CMC_SIGNER, to: CMC_SPENDER, input, finalized: true,
    logs: [{ address: USDT_56, topics: [ERC20_TRANSFER_TOPIC, padHex(OWNER, { size: 32 }), padHex(CMC_PAYEE, { size: 32 })] as readonly Hex[], data: toHex(amount, { size: 32 }) },
      { address: CMC_SPENDER, topics: [CMC_SETTLED_TOPIC] as readonly Hex[], data: "0x" as Hex }] };
  const result = verifyCmcChargeProof({ receipt, facts: { wallet: OWNER, asset: USDT_56, amountWei: amount, spender: CMC_SPENDER, payee: CMC_PAYEE, validAfter: 0n, deadline, nonce } });
  assert.equal(result.ok, true);
});

test("CMC capability rejects forged matrix evidence without a reviewed profile", () => {
  const evidence = {
    kind: "cmc-mainnet-capability-v1" as const, source: "live-mainnet" as const, chainId: 56 as const,
    wallet: OWNER, accountCodeHash: `0x${"11".repeat(32)}` as Hex, tokenCodeHash: `0x${"22".repeat(32)}` as Hex,
    permit2CodeHash: `0x${"33".repeat(32)}` as Hex, settlerCodeHash: `0x${"44".repeat(32)}` as Hex,
    sessionPublicKey: KEY, checker: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"), checkerApproved: false, finiteAllowanceWei: 0n,
    grantShapeDigest: `0x${"55".repeat(32)}` as Hex, ownerApprovalPersists: true as const,
    unrelatedTradingPreservesAllowance: true as const, sessionApproveCannotIncreaseAllowance: true as const,
    noTemporaryApproveConsumePath: true as const, temporaryApproveCallbackReentryExcluded: true as const, revokeExpiryRejectsPayment: true as const,
    walletKeyExclusive: true as const, additiveIncreaseAllowance: true as const, proofDigests: [`0x${"66".repeat(32)}` as Hex],
    observedAtMs: NOW_MS, profileId: "forged", generation: 0,
  };
  assert.equal(evaluateCmcCapability({ evidence, wallet: OWNER, sessionPublicKey: KEY, generation: 0, nowMs: NOW_MS }).available, false);
});

test("CMC initial owner setup accepts zero allowance and zero checker under a reviewed profile", async () => {
  const base = { kind: "cmc-mainnet-capability-v1" as const, source: "live-mainnet" as const, chainId: 56 as const,
    wallet: OWNER, accountCodeHash: `0x${"11".repeat(32)}` as Hex, tokenCodeHash: `0x${"22".repeat(32)}` as Hex,
    permit2CodeHash: `0x${"33".repeat(32)}` as Hex, settlerCodeHash: `0x${"44".repeat(32)}` as Hex, checker: CMC_PERMIT2,
    grantShapeDigest: `0x${"55".repeat(32)}` as Hex };
  const evidence = { ...base, sessionPublicKey: KEY, checkerApproved: false, finiteAllowanceWei: 0n,
    ownerApprovalPersists: true as const, unrelatedTradingPreservesAllowance: true as const,
    sessionApproveCannotIncreaseAllowance: true as const, noTemporaryApproveConsumePath: true as const,
    temporaryApproveCallbackReentryExcluded: true as const, revokeExpiryRejectsPayment: true as const,
    walletKeyExclusive: true as const, additiveIncreaseAllowance: true as const, proofDigests: [`0x${"66".repeat(32)}` as Hex],
    observedAtMs: NOW_MS, profileId: "reviewed", generation: 0 };
  const matrix = { ownerApprovalPersists: evidence.ownerApprovalPersists, unrelatedTradingPreservesAllowance: evidence.unrelatedTradingPreservesAllowance,
    sessionApproveCannotIncreaseAllowance: evidence.sessionApproveCannotIncreaseAllowance, noTemporaryApproveConsumePath: evidence.noTemporaryApproveConsumePath,
    temporaryApproveCallbackReentryExcluded: evidence.temporaryApproveCallbackReentryExcluded, revokeExpiryRejectsPayment: evidence.revokeExpiryRejectsPayment,
    walletKeyExclusive: evidence.walletKeyExclusive, additiveIncreaseAllowance: evidence.additiveIncreaseAllowance, proofDigests: evidence.proofDigests };
  const capability = createCmcCapabilityGate({ reader: { read: async () => evidence }, profiles: [{ ...base, profileId: "reviewed", matrix, evidenceDigest: cmcCapabilityEvidenceDigest(evidence) }] });
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "owner-setup", ownerAddress: OWNER, wallet: OWNER, totalWei: 2n * 10n ** 18n });
  const ownerService = createCmcOwnerService({ store, capability, chain: {
    readState: async () => ({ allowanceWei: 0n, checkerApproved: false, oldCheckerKeyHash: null }),
    verifyOwnerExecution: async () => { throw new Error("not reached during prepare"); },
  }, now: () => NOW_MS });
  const prepared = await ownerService.prepare({ operationId: "owner-op", agentId: "owner-setup", ownerAddress: OWNER, wallet: OWNER,
    mode: "topup", expectedGeneration: 0, additionalBudgetWei: (2n * 10n ** 18n).toString(), sessionPublicKey: KEY,
    sessionExpiry: 2_000_000, signedInitialTotalWei: 2n * 10n ** 18n });
  assert.ok(prepared);
  assert.equal(prepared.calls[0]?.to.toLowerCase(), USDT_56.toLowerCase());
  assert.equal(prepared.calls[1]?.to.toLowerCase(), OWNER.toLowerCase());
});

test("CMC owner execution proof rejects a trading-session signer", () => {
  const ownerHash = `0x${"11".repeat(32)}` as Hex;
  const sessionHash = `0x${"22".repeat(32)}` as Hex;
  const ownerKey = { expiry: 10_000n, keyType: 2, isSuperAdmin: true, publicKey: OWNER.toLowerCase() };
  const sessionKey = { expiry: 10_000n, keyType: 2, isSuperAdmin: false, publicKey: `0x${"33".repeat(20)}` };
  const getKeysResult = [[ownerKey, sessionKey], [ownerHash, sessionHash]];
  assert.equal(verifyCmcOwnerAdminKeyAtBlock({ getKeysResult, wallet: OWNER, ownerAddress: OWNER, signerKeyHash: ownerHash, blockTimestamp: 1_000n }), true);
  assert.equal(verifyCmcOwnerAdminKeyAtBlock({ getKeysResult, wallet: OWNER, ownerAddress: OWNER, signerKeyHash: sessionHash, blockTimestamp: 1_000n }), false);
});

test("CMC PAYMENT-RESPONSE transaction hint is persisted as untrusted until exact proof", async () => {
  const store = await readyStore();
  const operationId = "hinted";
  await store.reserve({ agentId: "a", ownerAddress: OWNER, wallet: OWNER, operationId, attemptId: "hint-attempt", amountWei: CMC_PRICE_ATOMIC, sessionPublicKey: KEY, sessionExpiry: 2_000_000, asset: USDT_56, spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE });
  await store.prepare({ agentId: "a", ownerAddress: OWNER, wallet: OWNER, operationId, generation: 0, sessionPublicKey: KEY, sessionExpiry: 2_000_000, asset: USDT_56, amountWei: CMC_PRICE_ATOMIC, spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE, validAfter: 0n, deadline: 1_000_500n, nonce: 42n, requestDigest: hashCmcBody(BODY), bodyHash: hashCmcBody(BODY) });
  const ciphertext = encryptCmcAuthorization({ masterKey: Buffer.alloc(32, 7), identity: { chainId: 56, wallet: OWNER, agentId: "a", budgetGeneration: 0, nonce: `0x${(42n).toString(16).padStart(64, "0")}` as Hex }, payload: { header: "fixture" } });
  await store.saveAuthorization({ agentId: "a", ownerAddress: OWNER, operationId, generation: 0, encryptedAuthorization: ciphertext });
  const payment = createCmcPaymentClient({ store, now: () => NOW_MS, authorize: async () => ({ ok: true }), signer: { sign: async () => { throw new Error("prepared fixture"); } }, transport: { request: async () => ({ status: 200, headers: { "payment-response": Buffer.from(JSON.stringify({ success: true, network: "eip155:56", transaction: `0x${"99".repeat(32)}` })).toString("base64") }, body: "{}" }) } });
  await payment.transmit({ agentId: "a", ownerAddress: OWNER, wallet: OWNER, operationId, body: BODY, generation: 0, masterKey: Buffer.alloc(32, 7) });
  assert.equal((await store.getAttempt("a", OWNER, operationId))?.settlementTxHint, `0x${"99".repeat(32)}`);
});
