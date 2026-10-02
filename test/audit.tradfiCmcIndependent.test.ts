import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeFunctionData, getAddress, padHex, parseAbi, toHex, zeroAddress, type Hex } from "viem";
import { passkeyOwnerAddress } from "../src/auth/webauthnEnvelope.js";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { CMC_MCP_URL, CMC_PAYEE, CMC_PRICE_ATOMIC, CMC_SPENDER, encryptCmcAuthorization, hashCmcBody } from "../src/trade/cmc.js";
import { CMC_PERMIT2, type CmcCapabilityEvidence } from "../src/trade/cmcCapability.js";
import { buildCheckerApprovalCall, createCmcOwnerService } from "../src/trade/cmcOwnerService.js";
import { createCmcFetchTransport, createCmcPaymentClient } from "../src/trade/cmcPayment.js";
import { createCmcRelayOwnerExecutionResolver, verifyCmcOwnerAdminKeyAtBlock } from "../src/trade/cmcRpc.js";
import { INTENT_EXECUTED_TOPIC, PORTO_V055_INTENT_PARAMETERS } from "../src/lp/intentDecoder.js";
import { PORTO_V055_ORCHESTRATOR } from "../src/lp/preparedIntent.js";
import { USDT_56 } from "../src/trade/settlement.js";

const X = "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" as Hex;
const Y = "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5" as Hex;
const OWNER = passkeyOwnerAddress(X, Y);
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const KEY = `0x04${"22".repeat(64)}` as Hex;
const NEXT_KEY = `0x04${"33".repeat(64)}` as Hex;
const H = `0x${"44".repeat(32)}` as Hex;
const NOW = 1_000_000;
const EXPIRY = 10_000;
const TOTAL = 2n * 10n ** 18n;
const AGENT = "cmc-independent";
const OP = "payment-operation";
const ATTEMPT = "payment-attempt";
const NONCE = 42n;
const DEADLINE = 1_500n;
const BODY = "{\"request\":\"fixture\"}";
const MASTER = Buffer.alloc(32, 7);

async function ready() {
  assert.notEqual(OWNER.toLowerCase(), WALLET.toLowerCase());
  const store = new MemoryTradeCmcStore(() => NOW);
  await store.putInitial({ agentId: AGENT, ownerAddress: OWNER, totalWei: TOTAL, ...{ wallet: WALLET } });
  await store.setSetup({ agentId: AGENT, ownerAddress: OWNER, generation: 0, sessionPublicKey: KEY,
    sessionExpiry: EXPIRY, allowanceWei: TOTAL, ...{ wallet: WALLET } });
  await store.setCapability({ agentId: AGENT, ownerAddress: OWNER, generation: 0, available: true });
  return store;
}

async function prepared(store: MemoryTradeCmcStore) {
  assert.ok(await store.reserve({ agentId: AGENT, ownerAddress: OWNER, operationId: OP, attemptId: ATTEMPT,
    amountWei: CMC_PRICE_ATOMIC, ...{ wallet: WALLET } }));
  assert.ok(await store.prepare({ agentId: AGENT, ownerAddress: OWNER, operationId: OP, generation: 0,
    sessionPublicKey: KEY, sessionExpiry: EXPIRY, asset: USDT_56, amountWei: CMC_PRICE_ATOMIC,
    spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE, validAfter: 0n,
    deadline: DEADLINE, nonce: NONCE, requestDigest: hashCmcBody(BODY), bodyHash: hashCmcBody(BODY), ...{ wallet: WALLET } }));
  const ciphertext = encryptCmcAuthorization({ masterKey: MASTER, identity: { chainId: 56, wallet: WALLET,
    agentId: AGENT, budgetGeneration: 0, nonce: `0x${NONCE.toString(16).padStart(64, "0")}` as Hex },
    payload: { header: "offline-fixture-only" } });
  assert.ok(await store.saveAuthorization({ agentId: AGENT, ownerAddress: OWNER, operationId: OP,
    generation: 0, encryptedAuthorization: ciphertext }));
}

test("CMC independent: a payable wallet's passkey admin is distinct from its owner identity", () => {
  const publicKey = `${X}${Y.slice(2)}` as Hex;
  const keys = [[{ expiry: 10_000n, keyType: 1, isSuperAdmin: true, publicKey }], [H]];
  assert.equal(verifyCmcOwnerAdminKeyAtBlock({ getKeysResult: keys, wallet: WALLET,
    signerKeyHash: H, blockTimestamp: 1_000n, ...{ ownerAddress: OWNER } }), true);
});

test("CMC independent: a finalized charge is reconciled against the payable wallet", async () => {
  const store = await ready();
  await prepared(store);
  assert.ok(await store.transition({ agentId: AGENT, ownerAddress: OWNER, operationId: OP, generation: 0,
    from: "prepared", to: "transmitting", disclosurePossible: true }));
  const settled = await store.settle({ agentId: AGENT, ownerAddress: OWNER, operationId: OP,
    generation: 0, txHash: H, proof: { kind: "charge", chainId: 56, txHash: H, payer: WALLET,
      asset: USDT_56, amountWei: CMC_PRICE_ATOMIC, nonce: NONCE, deadline: DEADLINE,
      witnessTo: CMC_PAYEE, validAfter: 0n, attemptId: ATTEMPT } });
  assert.ok(settled);
  assert.equal(settled.budget.settledWei, CMC_PRICE_ATOMIC);
});

test("CMC independent: expiry-unused proof releases the payable wallet's reservation", async () => {
  const store = await ready();
  await prepared(store);
  assert.ok(await store.transition({ agentId: AGENT, ownerAddress: OWNER, operationId: OP, generation: 0,
    from: "prepared", to: "transmitting", disclosurePossible: true }));
  assert.ok(await store.markUnknown({ agentId: AGENT, ownerAddress: OWNER, operationId: OP, generation: 0 }));
  const released = await store.release({ agentId: AGENT, ownerAddress: OWNER, operationId: OP,
    generation: 0, proof: { kind: "expiry-unused", chainId: 56, payer: WALLET, nonce: NONCE,
      deadline: DEADLINE, attemptId: ATTEMPT, blockNumber: 100n, blockHash: H,
      finalizedAtMs: 2_000_000, nonceUnused: true } });
  assert.ok(released);
  assert.equal(released.budget.reservedWei, 0n);
});

test("CMC independent: rebind prepares when only the old key has checker approval", async () => {
  const store = await ready();
  const evidence: CmcCapabilityEvidence = { kind: "cmc-mainnet-capability-v1", source: "live-mainnet",
    chainId: 56, wallet: WALLET, accountCodeHash: H, tokenCodeHash: H, permit2CodeHash: H,
    settlerCodeHash: H, sessionPublicKey: NEXT_KEY, checker: CMC_PERMIT2, finiteAllowanceWei: TOTAL,
    grantShapeDigest: H, ownerApprovalPersists: true, unrelatedTradingPreservesAllowance: true,
    sessionApproveCannotIncreaseAllowance: true, noTemporaryApproveConsumePath: true,
    temporaryApproveCallbackReentryExcluded: true, revokeExpiryRejectsPayment: true,
    walletKeyExclusive: true, additiveIncreaseAllowance: true, proofDigests: [H], observedAtMs: NOW,
    profileId: "offline-reviewed-fixture", generation: 0, checkerApproved: false };
  const service = createCmcOwnerService({ store, now: () => NOW,
    capability: { check: async () => ({ available: true, evidence }) },
    chain: { readState: async () => ({ allowanceWei: TOTAL, checkerApproved: false, oldCheckerKeyHash: H }),
      verifyOwnerExecution: async () => { throw new Error("not called during prepare"); } } });
  const result = await service.prepare({ operationId: "rebind", agentId: AGENT, ownerAddress: OWNER,
    wallet: WALLET, mode: "rebind", expectedGeneration: 0, additionalBudgetWei: "0",
    sessionPublicKey: NEXT_KEY, sessionExpiry: EXPIRY });
  assert.ok(result);
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every(call => call.to.toLowerCase() === WALLET.toLowerCase()));
});

test("CMC independent: disable before disclosure CAS prevents the paid HTTP request", async () => {
  const store = await ready();
  await prepared(store);
  let paidRequests = 0;
  const payment = createCmcPaymentClient({ store, now: () => NOW,
    signer: { sign: async () => { throw new Error("fixture already prepared"); } },
    authorize: async () => { await store.toggle({ agentId: AGENT, ownerAddress: OWNER, optedIn: false }); return { ok: true }; },
    transport: { request: async () => { paidRequests += 1; return { status: 200, headers: {}, body: "{}" }; } } });
  await payment.transmit({ agentId: AGENT, ownerAddress: OWNER, wallet: WALLET, operationId: OP,
    body: BODY, generation: 0, masterKey: MASTER }).catch(() => undefined);
  assert.equal(paidRequests, 0);
});

test("CMC independent: an orphan news lease with no attempt is reclaimable after restart", async () => {
  const store = await ready();
  assert.equal(await store.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER, operationId: "crashed-before-challenge", nowMs: NOW }), true);
  const restarted = new MemoryTradeCmcStore(() => NOW + 7_200_000);
  restarted.restore(store.snapshot(AGENT), new Map());
  assert.equal(await restarted.claimNewsSlot({ agentId: AGENT, ownerAddress: OWNER,
    operationId: "after-restart", nowMs: NOW + 7_200_000 }), true);
});

test("CMC independent: default request transport installs a bounded timeout signal", async () => {
  let hasSignal = false;
  const fakeFetch: typeof fetch = async (_url, init) => {
    hasSignal = init?.signal instanceof AbortSignal;
    return new Response("{}", { status: 402 });
  };
  await createCmcFetchTransport(fakeFetch).request({ url: CMC_MCP_URL, body: BODY });
  assert.equal(hasSignal, true);
});

test("CMC independent: owner proof rejects disagreement in RPC admin and intent evidence", async (context) => {
  const store = await ready();
  const calls = [buildCheckerApprovalCall({ wallet: WALLET, keyHash: H, approved: false }), buildCheckerApprovalCall({ wallet: WALLET, keyHash: H, approved: true })];
  const operation = await store.prepareOwnerOperation({ operationId: "rpc-owner", agentId: AGENT,
    ownerAddress: OWNER, mode: "rebind", expectedGeneration: 0, incrementWei: 0n,
    sessionPublicKey: NEXT_KEY, sessionExpiry: EXPIRY, priorAllowanceWei: TOTAL,
    expectedAllowanceWei: TOTAL, wallet: WALLET, oldCheckerKeyHash: null,
    keyHash: H, callsDigest: H, calls });
  assert.ok(operation);
  const executionData = encodeAbiParameters([{ type: "tuple[]", components: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
  ] }], [calls.map(call => ({ target: call.to, value: call.value, data: call.data }))]);
  const encodedIntent = encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [{ eoa: WALLET,
    executionData, nonce: 1n, payer: WALLET, paymentToken: zeroAddress, paymentMaxAmount: 0n,
    combinedGas: 1n, encodedPreCalls: [], encodedFundTransfers: [], settler: zeroAddress,
    expiry: 10_000n, isMultichain: false, funder: zeroAddress, funderSignature: "0x",
    settlerContext: "0x", paymentAmount: 0n, paymentRecipient: zeroAddress,
    signature: `0x${"11".repeat(65)}${H.slice(2)}00`, paymentSignature: "0x",
    supportedAccountImplementation: zeroAddress }]);
  const input = encodeFunctionData({ abi: parseAbi(["function execute(bytes encodedIntent) payable returns(bytes4)"]),
    functionName: "execute", args: [encodedIntent] });
  const keyParameters = [{ type: "tuple[]", components: [
    { name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" },
    { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" },
  ] }, { type: "bytes32[]" }] as const;
  const fakeFetch: typeof fetch = async (url, init) => {
    const request = JSON.parse(String(init?.body)) as { readonly id: number; readonly method: string };
    const first = String(url).includes("first.invalid");
    let result: unknown;
    if (request.method === "wallet_getCallsStatus") result = { receipts: [{ transactionHash: H }] };
    else if (request.method === "eth_chainId") result = "0x38";
    else if (request.method === "eth_getBlockByNumber") result = { number: "0x64", hash: H, timestamp: "0x3e8", transactions: [] };
    else if (request.method === "eth_getTransactionByHash") result = { hash: H, blockHash: H,
      blockNumber: "0x64", transactionIndex: "0x0", from: WALLET, to: PORTO_V055_ORCHESTRATOR,
      input, nonce: "0x1", gas: "0x1", gasPrice: "0x1", value: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1" };
    else if (request.method === "eth_getTransactionReceipt") result = { transactionHash: H, blockHash: H,
      blockNumber: "0x64", transactionIndex: "0x0", status: "0x1", from: WALLET,
      to: PORTO_V055_ORCHESTRATOR, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
      contractAddress: null, type: "0x0", logsBloom: `0x${"00".repeat(256)}`, logs: [{
        address: PORTO_V055_ORCHESTRATOR, blockHash: H, blockNumber: "0x64", transactionHash: H,
        transactionIndex: "0x0", logIndex: "0x0", removed: false,
        topics: [INTENT_EXECUTED_TOPIC, padHex(WALLET, { size: 32 }), toHex(1n, { size: 32 })],
        data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [first, first ? "0x00000000" : "0xdeadbeef"]),
      }] };
    else if (request.method === "eth_call") result = encodeAbiParameters(keyParameters,
      [[{ expiry: 10_000, keyType: 2, isSuperAdmin: first, publicKey: WALLET }], [H]]);
    else throw new Error(`unexpected offline RPC ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
  };
  context.mock.method(globalThis, "fetch", fakeFetch);
  const resolver = createCmcRelayOwnerExecutionResolver({ relayUrl: "https://relay.invalid",
    rpcUrls: ["https://first.invalid", "https://second.invalid"] });
  await assert.rejects(resolver({ callsId: H, operation, calls }), /disagree|admin|IntentExecuted/);
});
