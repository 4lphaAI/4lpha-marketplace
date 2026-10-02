import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { X402PaymentPayload } from "@altananetwork/sdk";
import {
  CMC_CONFIG_ID,
  CMC_GLOBAL_TOOL,
  CMC_LLM_REQUEST_MIN_REMAINING_WEI,
  CMC_MCP_RESOURCE,
  CMC_PAYEE,
  CMC_PRICE_ATOMIC,
  CMC_SIGNER,
  CMC_SPENDER,
} from "../src/trade/cmc.js";
import { CMC_SKILL_MACRO, CMC_SKILL_PLANNING, CMC_SKILL_SCANNER, CMC_SKILL_SECTOR } from "../src/trade/cmcUsEquity.js";
import { GLOBAL_TICKER } from "../src/trade/cmcNews.js";
import { CMC_PERMIT2, type CmcCapabilityGate } from "../src/trade/cmcCapability.js";
import {
  createCmcRuntime,
  createCmcRuntimeProfileRegistry,
  cmcProtectedExposureWei,
  type CmcRuntimeTarget,
} from "../src/trade/cmcRuntime.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import { createCmcRpcCapabilityReader, verifyCmcOwnerAdminKeyAtBlock, type CmcMatrixTrace } from "../src/trade/cmcRpc.js";
import type { CmcChargeProofResult } from "../src/trade/cmcProof.js";
import { MemoryTradeCmcStore, type CmcOwnerExecutionProof } from "../src/store/tradeCmc.js";
import { USDT_56 } from "../src/trade/settlement.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const KEY = `0x04${"22".repeat(64)}` as Hex;
// Wed 2026-09-23 21:00 UTC = 17:00 ET (EDT): after every daily/trading-day anchor.
const NOW_MS = Date.UTC(2026, 8, 23, 21, 0);
const EXPIRY = NOW_MS + 100_000;
const TOTAL = 2n * CMC_PRICE_ATOMIC;
const MASTER = Buffer.alloc(32, 7);
const CAPABILITY_DIGEST = `0x${"66".repeat(32)}` as Hex;

function capabilityGate(allowanceWei: bigint = TOTAL): CmcCapabilityGate {
  return {
    check: async (request) => ({ available: true, evidence: {
      kind: "cmc-mainnet-capability-v1", source: "live-mainnet", chainId: 56,
      wallet: request.wallet, accountCodeHash: CAPABILITY_DIGEST, tokenCodeHash: CAPABILITY_DIGEST,
      permit2CodeHash: CAPABILITY_DIGEST, settlerCodeHash: CAPABILITY_DIGEST,
      sessionPublicKey: request.sessionPublicKey, checker: CMC_PERMIT2,
      finiteAllowanceWei: allowanceWei, grantShapeDigest: CAPABILITY_DIGEST,
      ownerApprovalPersists: true, unrelatedTradingPreservesAllowance: true,
      sessionApproveCannotIncreaseAllowance: true, noTemporaryApproveConsumePath: true,
      temporaryApproveCallbackReentryExcluded: true, revokeExpiryRejectsPayment: true,
      walletKeyExclusive: true, additiveIncreaseAllowance: true, proofDigests: [CAPABILITY_DIGEST],
      observedAtMs: NOW_MS, profileId: "runtime-fixture", generation: request.generation,
      checkerApproved: true,
    } }),
  };
}

function target(overrides: Partial<CmcRuntimeTarget> = {}): CmcRuntimeTarget {
  return {
    agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: EXPIRY, sessionGeneration: 0, budgetGeneration: 0, isTradfiV2: true, cmcNewsEnabled: true,
    heldTickers: ["NVDA"], shortlistedTickers: ["MSFT"], ...overrides,
  };
}

function challengeHeader(): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2, resource: { url: CMC_MCP_RESOURCE },
    accepts: [{ scheme: "exact", network: "eip155:56", asset: USDT_56,
      amount: CMC_PRICE_ATOMIC.toString(10), payTo: CMC_PAYEE, maxTimeoutSeconds: 500,
      extra: { name: "Tether USD", version: "1", assetTransferMethod: "permit2-exact",
        x402PaymentConfigId: CMC_CONFIG_ID, spenderAddress: CMC_SPENDER, signerAddress: CMC_SIGNER } }],
  })).toString("base64");
}

async function readyStore(): Promise<MemoryTradeCmcStore> {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, generation: 0,
    sessionPublicKey: KEY, sessionExpiry: EXPIRY, allowanceWei: TOTAL });
  await store.setCapability({ agentId: "runtime-agent", ownerAddress: OWNER, generation: 0, available: true });
  // TRADFI-CMC-EQUITY N8: macro/global/sector/scanner all rank ahead of a
  // per-ticker planning call. Seed all four fresh so these pre-existing
  // ticker scenarios still exercise the planning path they were written for.
  for (const skill of [CMC_SKILL_MACRO, CMC_GLOBAL_TOOL, CMC_SKILL_SECTOR, CMC_SKILL_SCANNER]) {
    await store.putNews({ agentId: "runtime-agent", ownerAddress: OWNER, ticker: GLOBAL_TICKER, skill,
      generation: 0, status: "available", context: "{}", sourceUrl: null, publishedAtMs: null,
      payloadHash: null, paymentOperationId: null, asOfMs: NOW_MS, expiresAtMs: NOW_MS + 24 * 60 * 60_000, lastAttemptAtMs: NOW_MS });
  }
  return store;
}

/** R2.2: the MCP text content is a JSON string of `{result:{output:"<pack json>"}}`, the pack itself `{type,skill_id,timestamp,data:{evidence:{...}}}`. */
function wrapPlanningPack(): string {
  const pack = { type: "evidence_pack", skill_id: CMC_SKILL_PLANNING, timestamp: "2026-09-23T00:00:00Z",
    data: { evidence: { identity: { sector_proxy: { symbol: "SMH" } }, price_basis: { latest_close_usd: 228.87 },
      market_structure: { ema_distance_pct: { "20": 3.91, "50": 5.89, "200": 14.55 }, atr14_pct: 2.73, returns_pct: { "5": 7.87, "20": 9.78, "63": 14.41 } },
      benchmark_context: { relative_returns_pct: { SPY: { "5": 5.76, "20": 8.48, "63": 8.99 } } },
      last_completed_session: { session_date: "2026-09-22" }, key_levels: { static_zones: [] } } } };
  return JSON.stringify({ result: { ok: true, success: true, exitCode: 0, error: "", output: JSON.stringify(pack) } });
}
function paymentFixture(state: {
  readonly requests: string[];
  readonly signs: { value: number };
}, responseBody = JSON.stringify({ result: { content: [{ type: "text", text: wrapPlanningPack() }] } })) {
  return {
    async request(request: { readonly headers?: Readonly<Record<string, string>> }): Promise<{
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }> {
      state.requests.push(request.headers === undefined ? "challenge" : "paid");
      if (request.headers === undefined) return { status: 402, headers: { "payment-required": challengeHeader() }, body: "" };
      return {
        status: 200,
        headers: { "payment-response": Buffer.from(JSON.stringify({ success: true, network: "eip155:56", transaction: `0x${"99".repeat(32)}` })).toString("base64") },
        body: responseBody,
      };
    },
    async sign(input: { readonly nonce: bigint; readonly onSigned: (authorization: {
      readonly header: string;
      readonly payload: X402PaymentPayload;
      readonly nonce: bigint;
      readonly deadline: bigint;
      readonly validAfter: bigint;
      readonly token: Address;
      readonly payer: Address;
      readonly spender: Address;
      readonly witnessTo: Address;
    }) => Promise<void> }) {
      state.signs.value += 1;
      const authorization = {
        header: "offline-payment-header",
        payload: {} as unknown as X402PaymentPayload,
        nonce: input.nonce, deadline: 1_500n, validAfter: 0n, token: USDT_56,
        payer: WALLET, spender: CMC_SPENDER, witnessTo: CMC_PAYEE,
      } as const;
      await input.onSigned(authorization);
      return authorization;
    },
  };
}

test("CMC runtime off and non-v2 targets perform no challenge, signature or payment", async () => {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.toggle({ agentId: "runtime-agent", ownerAddress: OWNER, optedIn: false });
  const requests: string[] = [];
  const signs = { value: 0 };
  let authorizations = 0;
  const runtime = createCmcRuntime({ store, now: () => NOW_MS, worker: {
    masterKey: MASTER, authorize: async () => { authorizations += 1; return { ok: true as const }; },
    signer: { sign: paymentFixture({ requests, signs }).sign },
    transport: { request: paymentFixture({ requests, signs }).request },
  } });
  assert.ok(runtime.worker);
  assert.equal(runtime.worker.enqueue(target({ cmcNewsEnabled: true })), undefined);
  const off = await runtime.worker.refresh(target({ cmcNewsEnabled: false }));
  const legacy = await runtime.worker.refresh(target({ isTradfiV2: false }));
  assert.equal(off.reason, "news_disabled");
  assert.equal(legacy.reason, "not_tradfi_v2");
  assert.deepEqual(requests, []);
  assert.equal(signs.value, 0);
  assert.equal(authorizations, 0);
  await runtime.close();
});

test("CMC runtime refreshes once, persists the response hint, reconciles, and exposes cache", async () => {
  const store = await readyStore();
  const requests: string[] = [];
  const signs = { value: 0 };
  const fixture = paymentFixture({ requests, signs });
  const authorizationAmounts: bigint[] = [];
  const receiptProof: CmcChargeProofResult = {
    ok: true,
    proof: { chainId: 56, status: "success", blockNumber: 100n, blockHash: `0x${"aa".repeat(32)}`,
      transactionHash: `0x${"99".repeat(32)}`, from: CMC_SIGNER, to: CMC_SPENDER,
      input: "0x", logs: [], finalized: true },
  };
  const runtime = createCmcRuntime({ store, now: () => NOW_MS, worker: {
    masterKey: MASTER,
    authorize: async (input) => { authorizationAmounts.push(input.amountWei); return { ok: true as const }; },
    capability: capabilityGate(),
    signer: { sign: fixture.sign }, transport: { request: fixture.request },
    chargeReconciler: { reconcile: async () => receiptProof },
  } });
  assert.ok(runtime.worker);
  const refreshed = await runtime.worker.refresh(target());
  assert.equal(refreshed.state, "available", refreshed.reason ?? "no-reason");
  assert.ok(refreshed.operationId);
  assert.deepEqual(requests, ["challenge", "paid"]);
  assert.equal(signs.value, 1);
  assert.deepEqual(authorizationAmounts, [CMC_PRICE_ATOMIC, CMC_PRICE_ATOMIC, CMC_PRICE_ATOMIC]);
  const pending = await store.getAttempt("runtime-agent", OWNER, refreshed.operationId!);
  assert.equal(pending?.state, "unknown");
  assert.equal(pending?.settlementTxHint, `0x${"99".repeat(32)}`);
  const reconciled = await runtime.worker.reconcileAttempt({ target: target(), operationId: refreshed.operationId! });
  assert.equal(reconciled.action, "settled");
  assert.equal((await store.get("runtime-agent", OWNER))?.settledWei, CMC_PRICE_ATOMIC);
  assert.equal((await store.get("runtime-agent", OWNER))?.reservedWei, 0n);
  const context = await runtime.worker.getFreshContext({ target: target(), ticker: "NVDA" });
  assert.equal(context?.ticker, "NVDA");
  await runtime.close();
});

test("CMC news parser treats nested JSON and SSE MCP errors as service errors", async () => {
  for (const responseBody of [
    JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "provider error" }] } }),
    `data: ${JSON.stringify({ result: { isError: true } })}\n\n`,
  ]) {
    const store = await readyStore();
    const state = { requests: [] as string[], signs: { value: 0 } };
    const fixture = paymentFixture(state, responseBody);
    const runtime = createCmcRuntime({ store, now: () => NOW_MS, worker: {
      masterKey: MASTER, authorize: async () => ({ ok: true as const }), capability: capabilityGate(),
      signer: { sign: fixture.sign }, transport: { request: fixture.request },
    } });
    const result = await runtime.worker!.refresh(target());
    assert.equal(result.state, "service-error");
    assert.equal(result.context, null);
    // M5: a failure now bookkeeps a `service-error` row (closing "a failed planning
    // call writes nothing and is retried the very next hourly slot"), never `available`.
    const row = await store.getNews("runtime-agent", OWNER, "NVDA", CMC_SKILL_PLANNING);
    assert.equal(row?.status, "service-error");
    assert.equal(row?.context, null);
    await runtime.close();
  }
});

test("CMC runtime keeps an unknown attempt held across restart and does not replay it", async () => {
  const store = await readyStore();
  const requests: string[] = [];
  const signs = { value: 0 };
  const fixture = paymentFixture({ requests, signs });
  const runtime = createCmcRuntime({ store, now: () => NOW_MS, worker: {
    masterKey: MASTER, authorize: async () => ({ ok: true as const }),
    capability: capabilityGate(),
    signer: { sign: fixture.sign }, transport: { request: fixture.request },
  } });
  assert.ok(runtime.worker);
  const refreshed = await runtime.worker.refresh(target());
  assert.ok(refreshed.operationId);
  const restarted = createCmcRuntime({ store, now: () => NOW_MS + 2 * 60 * 60 * 1_000, worker: {
    masterKey: MASTER, authorize: async () => ({ ok: true as const }),
    capability: capabilityGate(),
    signer: { sign: async () => { throw new Error("replay signer"); } },
    transport: { request: async () => { throw new Error("replay transport"); } },
  } });
  assert.ok(restarted.worker);
  const replay = await restarted.worker.refresh(target({ cmcNewsEnabled: true }));
  assert.equal(replay.state, "skipped", replay.reason ?? "no-reason");
  assert.equal(replay.reason, "reconciliation-required");
  assert.deepEqual(requests, ["challenge", "paid"]);
  assert.equal(signs.value, 1);
  const held = await restarted.worker.reconcileAttempt({ target: target(), operationId: refreshed.operationId! });
  assert.equal(held.action, "held");
  assert.equal((await store.getAttempt("runtime-agent", OWNER, refreshed.operationId!))?.state, "unknown");
  await runtime.close();
  await restarted.close();
});

test("CMC runtime reclaims only stale undisclosed reservations before the ready gate", async () => {
  const store = await readyStore();
  const orphanOperation = "orphan-undisclosed";
  assert.equal(await store.claimNewsSlot({ agentId: "runtime-agent", ownerAddress: OWNER, operationId: orphanOperation, nowMs: NOW_MS }), true);
  assert.ok(await store.reserve({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, operationId: orphanOperation,
    attemptId: "orphan-attempt", amountWei: CMC_PRICE_ATOMIC, sessionPublicKey: KEY, sessionExpiry: EXPIRY,
    asset: USDT_56, spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE, nowMs: NOW_MS }));
  const requests: string[] = [];
  const runtime = createCmcRuntime({ store, now: () => NOW_MS + 3_700_000, worker: {
    masterKey: MASTER, capability: capabilityGate(),
    authorize: async () => ({ ok: false as const, reason: "paused" }),
    signer: { sign: async () => { throw new Error("unsigned orphan must not sign"); } },
    transport: { request: async () => { requests.push("network"); throw new Error("unsigned orphan must not request"); } },
  } });
  const result = await runtime.worker!.refresh(target({ heldTickers: ["AAPL"], shortlistedTickers: [] }));
  assert.equal(result.state, "skipped");
  assert.equal(result.reason, "stale_undisclosed_reclaimed");
  assert.deepEqual(requests, []);
  assert.equal((await store.getAttempt("runtime-agent", OWNER, orphanOperation))?.state, "released");
  assert.equal((await store.get("runtime-agent", OWNER))?.reservedWei, 0n);
  await runtime.close();
});

test("CMC orphan reclaim never funds a new call with stale capability evidence", async () => {
  const store = await readyStore();
  const operationId = "stale-capability-orphan";
  assert.equal(await store.claimNewsSlot({ agentId: "runtime-agent", ownerAddress: OWNER, operationId, nowMs: NOW_MS }), true);
  assert.ok(await store.reserve({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, operationId,
    attemptId: "stale-capability-attempt", amountWei: CMC_PRICE_ATOMIC, sessionPublicKey: KEY, sessionExpiry: EXPIRY,
    asset: USDT_56, spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE, nowMs: NOW_MS }));
  const requests: string[] = [];
  const unavailable: CmcCapabilityGate = { check: async () => ({ available: false, reason: "cmc-profile-unavailable" }) };
  const runtime = createCmcRuntime({ store, now: () => NOW_MS + 3_700_000, worker: {
    masterKey: MASTER, capability: unavailable, authorize: async () => ({ ok: true as const }),
    signer: { sign: async () => { throw new Error("stale capability must not sign"); } },
    transport: { request: async () => { requests.push("paid"); throw new Error("stale capability must not request"); } },
  } });
  const result = await runtime.worker!.refresh(target());
  assert.equal(result.reason, "stale_undisclosed_reclaimed");
  assert.deepEqual(requests, []);
  assert.equal((await store.getAttempt("runtime-agent", OWNER, operationId))?.state, "released");
  await runtime.close();
});

test("CMC runtime scheduler has no trade fence and refreshes only its independent target list", async () => {
  const store = await readyStore();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let exitRan = false;
  const runtime = createCmcRuntime({ store, now: () => NOW_MS, worker: {
    masterKey: MASTER, authorize: async () => ({ ok: true as const }),
    capability: capabilityGate(),
    signer: { sign: async () => { throw new Error("not reached"); } },
    transport: { request: async () => { await pending; return { status: 402, headers: { "payment-required": challengeHeader() }, body: "" }; } },
    listTargets: async () => [target({ heldTickers: [], shortlistedTickers: [] })],
  } });
  assert.ok(runtime.worker);
  const tick = runtime.worker.scheduler.tick();
  await Promise.resolve();
  exitRan = true;
  assert.equal(exitRan, true);
  release();
  const results = await tick;
  assert.equal(results.length, 1);
  await runtime.close();
});

test("CMC scheduler reconciles a pending exposed attempt after opt-out without refreshing", async () => {
  const store = await readyStore();
  const state = { requests: [] as string[], signs: { value: 0 } };
  const fixture = paymentFixture(state);
  const proof: CmcChargeProofResult = { ok: true, proof: {
    chainId: 56, status: "success", blockNumber: 1n, blockHash: `0x${"a1".repeat(32)}`,
    transactionHash: `0x${"99".repeat(32)}`, from: CMC_SIGNER, to: CMC_SPENDER,
    input: "0x", logs: [], finalized: true,
  } };
  const first = createCmcRuntime({ store, now: () => NOW_MS, worker: {
    masterKey: MASTER, capability: capabilityGate(), authorize: async () => ({ ok: true as const }),
    signer: { sign: fixture.sign }, transport: { request: fixture.request }, chargeReconciler: { reconcile: async () => proof },
  } });
  const refreshed = await first.worker!.refresh(target());
  assert.ok(refreshed.operationId);
  await store.toggle({ agentId: "runtime-agent", ownerAddress: OWNER, optedIn: false });
  const restarted = createCmcRuntime({ store, now: () => NOW_MS + 3_700_000, worker: {
    masterKey: MASTER, capability: capabilityGate(), authorize: async () => ({ ok: true as const }),
    signer: { sign: async () => { throw new Error("opted-out pending attempt must not sign"); } },
    transport: { request: async () => { throw new Error("opted-out pending attempt must not refresh"); } },
    listTargets: async () => [],
    listReconciliationTargets: async () => [target({ cmcNewsEnabled: false })],
    chargeReconciler: { reconcile: async () => proof },
  } });
  const results = await restarted.worker!.scheduler.tick();
  assert.deepEqual(results, []);
  assert.equal((await store.getAttempt("runtime-agent", OWNER, refreshed.operationId!))?.state, "settled");
  assert.deepEqual(state.requests, ["challenge", "paid"]);
  await first.close();
  await restarted.close();
});

test("CMC scheduler reclaims a stale undisclosed orphan for an opted-out agent", async () => {
  const store = await readyStore();
  const operationId = "restart-orphan";
  assert.equal(await store.claimNewsSlot({ agentId: "runtime-agent", ownerAddress: OWNER, operationId, nowMs: NOW_MS }), true);
  assert.ok(await store.reserve({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, operationId,
    attemptId: "restart-orphan-attempt", amountWei: CMC_PRICE_ATOMIC, sessionPublicKey: KEY, sessionExpiry: EXPIRY,
    asset: USDT_56, spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE, nowMs: NOW_MS }));
  await store.toggle({ agentId: "runtime-agent", ownerAddress: OWNER, optedIn: false });
  const runtime = createCmcRuntime({ store, now: () => NOW_MS + 3_700_000, worker: {
    masterKey: MASTER, listTargets: async () => [], listReconciliationTargets: async () => [target({ cmcNewsEnabled: false })],
    authorize: async () => ({ ok: true as const }), capability: capabilityGate(),
    signer: { sign: async () => { throw new Error("orphan must not sign"); } },
    transport: { request: async () => { throw new Error("orphan must not refresh"); } },
  } });
  assert.deepEqual(await runtime.worker!.scheduler.tick(), []);
  assert.equal((await store.getAttempt("runtime-agent", OWNER, operationId))?.state, "released");
  await runtime.close();
});

test("CMC runtime default profile registry is explicitly unavailable when empty", () => {
  const registry = createCmcRuntimeProfileRegistry([]);
  assert.equal(registry.profiles.length, 0);
  assert.equal(registry.find({ accountCodeHash: CAPABILITY_DIGEST, tokenCodeHash: CAPABILITY_DIGEST,
    permit2CodeHash: CAPABILITY_DIGEST, settlerCodeHash: CAPABILITY_DIGEST, grantShapeDigest: CAPABILITY_DIGEST, grantShapeVersion: 1 }), null);
  assert.equal(CMC_PERMIT2.toLowerCase(), "0x000000000022d473030f116ddee9f6b43ac78ba3");
});

test("CMC runtime maps only a populated source-reviewed matrix profile to a trace", () => {
  const digest = `0x${"ab".repeat(32)}` as Hex;
  const registry = createCmcRuntimeProfileRegistry([{
    profileId: "reviewed-fixture", chainId: 56,
    accountCodeHash: digest, tokenCodeHash: digest, permit2CodeHash: digest,
    settlerCodeHash: digest, checker: CMC_PERMIT2, grantShapeDigest: digest, evidenceDigest: digest,
    matrix: {
      ownerApprovalPersists: true, unrelatedTradingPreservesAllowance: true,
      sessionApproveCannotIncreaseAllowance: true, noTemporaryApproveConsumePath: true,
      temporaryApproveCallbackReentryExcluded: true, revokeExpiryRejectsPayment: true,
      walletKeyExclusive: true, additiveIncreaseAllowance: true, proofDigests: [digest],
    },
  }]);
  const trace = registry.find({ accountCodeHash: digest, tokenCodeHash: digest,
    permit2CodeHash: digest, settlerCodeHash: digest, grantShapeDigest: digest, grantShapeVersion: 1 });
  assert.equal(registry.profiles.length, 1);
  assert.equal(trace?.profileId, "reviewed-fixture");
  assert.equal(trace?.grantShapeDigest, digest);
  assert.deepEqual(trace?.proofDigests, [digest]);
});

test("CMC RPC capability accepts expiry-zero owner admin and uses finalized chain time for foreign sessions", async (context) => {
  const currentHash = accountKeyHashForAddress(publicKeyToAddress(KEY));
  const ownerHash = `0x${"77".repeat(32)}` as Hex;
  const foreignHash = `0x${"88".repeat(32)}` as Hex;
  const ownerPublicKey = `0x${WALLET.slice(2)}` as Hex;
  const currentPublicKey = `0x${publicKeyToAddress(KEY).slice(2)}` as Hex;
  const foreignPublicKey = `0x${"44".repeat(20)}` as Hex;
  const keyParameters = [{ type: "tuple[]", components: [
    { name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" },
    { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" },
  ] }, { type: "bytes32[]" }] as const;
  const allowanceSelector = keccak256(stringToBytes("allowance(address,address)")).slice(0, 10).toLowerCase();
  const checkerSelector = keccak256(stringToBytes("approvedSignatureCheckers(bytes32)")).slice(0, 10).toLowerCase();
  const keysSelector = keccak256(stringToBytes("getKeys()")).slice(0, 10).toLowerCase();
  const blockHash = `0x${"ab".repeat(32)}` as Hex;
  let foreignActive = false;
  let foreignCheckerApproved = false;
  let chainId = 56;
  const trace: CmcMatrixTrace = {
    ownerApprovalPersists: true, unrelatedTradingPreservesAllowance: true,
    sessionApproveCannotIncreaseAllowance: true, noTemporaryApproveConsumePath: true,
    temporaryApproveCallbackReentryExcluded: true, revokeExpiryRejectsPayment: true,
    walletKeyExclusive: true, additiveIncreaseAllowance: true, proofDigests: [CAPABILITY_DIGEST],
    grantShapeDigest: CAPABILITY_DIGEST, profileId: "rpc-fixture",
  };
  const SPEC = { allowedCalls: [{ to: WALLET, selector: "approve(address,uint256)" }], spendCaps: [{}] };
  const fakeFetch: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { readonly id: number; readonly method: string; readonly params?: readonly unknown[] };
    let result: unknown;
    if (request.method === "eth_chainId") result = `0x${chainId.toString(16)}`;
    else if (request.method === "eth_getBlockByNumber") result = { number: "0x64", hash: blockHash, timestamp: "0x7d0", transactions: [] };
    else if (request.method === "eth_getCode") result = "0x6000";
    else if (request.method === "eth_call") {
      const call = request.params?.[0] as { readonly data?: string } | undefined;
      const data = call?.data?.toLowerCase() ?? "";
      if (data.startsWith(keysSelector)) {
        result = encodeAbiParameters(keyParameters, [[
          { expiry: 0, keyType: 2, isSuperAdmin: true, publicKey: ownerPublicKey },
          { expiry: 3_000, keyType: 2, isSuperAdmin: false, publicKey: currentPublicKey },
          { expiry: foreignActive ? 2_500 : 1_500, keyType: 2, isSuperAdmin: false, publicKey: foreignPublicKey },
        ], [ownerHash, currentHash, foreignHash]]);
      } else if (data.startsWith(allowanceSelector)) {
        result = encodeAbiParameters([{ type: "uint256" }], [TOTAL]);
      } else if (data.startsWith(checkerSelector)) {
        const key = `0x${data.slice(-64)}`.toLowerCase();
        result = encodeAbiParameters([{ type: "address[]" }], [key === currentHash.toLowerCase() || foreignCheckerApproved && key === foreignHash.toLowerCase() ? [CMC_PERMIT2] : []]);
      } else throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
    } else throw new Error(`unexpected RPC method ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
  };
  context.mock.method(globalThis, "fetch", fakeFetch);
  context.mock.method(Date, "now", () => 1_000_000);
  const reader = createCmcRpcCapabilityReader({ rpcUrl: "https://rpc.invalid", sessionSpec: async () => SPEC, matrixTrace: async () => trace });
  const request = { agentId: "runtime-agent", wallet: WALLET, sessionPublicKey: KEY, generation: 0 };
  assert.equal(verifyCmcOwnerAdminKeyAtBlock({ getKeysResult: [
    [{ expiry: 0n, keyType: 2, isSuperAdmin: true, publicKey: ownerPublicKey }], [ownerHash],
  ], wallet: WALLET, ownerAddress: WALLET, signerKeyHash: ownerHash, blockTimestamp: 2_000n }), true);
  assert.ok(await reader.read(request));
  foreignActive = true;
  assert.equal(await reader.read(request), null);
  foreignCheckerApproved = true;
  assert.equal(await reader.read(request), null);
  foreignActive = false;
  foreignCheckerApproved = false;
  chainId = 31337;
  assert.equal(await reader.read(request), null);
});

test("CMC runtime owner confirmation refreshes capability before the first paid request", async () => {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  for (const skill of [CMC_SKILL_MACRO, CMC_GLOBAL_TOOL, CMC_SKILL_SECTOR, CMC_SKILL_SCANNER]) {
    await store.putNews({ agentId: "runtime-agent", ownerAddress: OWNER, ticker: GLOBAL_TICKER, skill,
      generation: 0, status: "available", context: "{}", sourceUrl: null, publishedAtMs: null,
      payloadHash: null, paymentOperationId: null, asOfMs: NOW_MS, expiresAtMs: NOW_MS + 24 * 60 * 60_000, lastAttemptAtMs: NOW_MS });
  }
  let checkerApproved = false;
  const dynamicCapability: CmcCapabilityGate = {
    check: async (request) => ({ available: true, evidence: {
      kind: "cmc-mainnet-capability-v1", source: "live-mainnet", chainId: 56,
      wallet: request.wallet, accountCodeHash: CAPABILITY_DIGEST, tokenCodeHash: CAPABILITY_DIGEST,
      permit2CodeHash: CAPABILITY_DIGEST, settlerCodeHash: CAPABILITY_DIGEST,
      sessionPublicKey: request.sessionPublicKey, checker: CMC_PERMIT2, finiteAllowanceWei: TOTAL,
      grantShapeDigest: CAPABILITY_DIGEST, ownerApprovalPersists: true,
      unrelatedTradingPreservesAllowance: true, sessionApproveCannotIncreaseAllowance: true,
      noTemporaryApproveConsumePath: true, temporaryApproveCallbackReentryExcluded: true,
      revokeExpiryRejectsPayment: true, walletKeyExclusive: true, additiveIncreaseAllowance: true,
      proofDigests: [CAPABILITY_DIGEST], observedAtMs: NOW_MS, profileId: "runtime-owner-fixture",
      generation: request.generation, checkerApproved,
    } }),
  };
  const executionProof: CmcOwnerExecutionProof = { chainId: 56, wallet: WALLET,
    txHash: `0x${"90".repeat(32)}`, blockHash: `0x${"91".repeat(32)}`,
    blockNumber: 100n, blockTimestamp: 1_000n, intentId: `0x${"92".repeat(32)}`, executionNonce: 1n };
  const paymentState = { requests: [] as string[], signs: { value: 0 } };
  const payment = paymentFixture(paymentState);
  const runtime = createCmcRuntime({ store, now: () => NOW_MS,
    owner: { capability: dynamicCapability, chain: {
      readState: async () => ({ allowanceWei: 0n, checkerApproved: false, oldCheckerKeyHash: null }),
      verifyOwnerExecution: async ({ operation }) => ({ finalized: true, callsDigest: operation.callsDigest,
        allowanceWei: TOTAL, checkerApproved: true, sessionKeyHash: operation.keyHash, executionProof }),
    } },
    worker: {
      masterKey: MASTER, capability: dynamicCapability,
      authorize: async () => ({ ok: true as const }),
      signer: { sign: payment.sign },
      transport: { request: payment.request },
    },
  });
  assert.ok(runtime.owner.prepare);
  assert.ok(runtime.owner.recordAttempt);
  assert.ok(runtime.owner.confirm);
  const prepared = await runtime.owner.prepare({ operationId: "owner-setup", agentId: "runtime-agent", ownerAddress: OWNER,
    wallet: WALLET, mode: "topup", expectedGeneration: 0, additionalBudgetWei: TOTAL.toString(10),
    signedInitialTotalWei: TOTAL, sessionPublicKey: KEY, sessionExpiry: EXPIRY });
  assert.ok(prepared);
  assert.ok(await runtime.owner.recordAttempt({ operationId: "owner-setup", agentId: "runtime-agent", ownerAddress: OWNER,
    attemptId: "owner-attempt" }));
  checkerApproved = true;
  const confirmed = await runtime.owner.confirm({ operationId: "owner-setup", agentId: "runtime-agent", ownerAddress: OWNER,
    callsId: CAPABILITY_DIGEST });
  assert.ok(confirmed);
  assert.equal((await store.get("runtime-agent", OWNER))?.capabilityAvailable, true);
  const refreshed = await runtime.worker!.refresh(target({ budgetGeneration: 1 }));
  assert.equal(refreshed.state, "available");
  assert.ok(refreshed.operationId);
  assert.deepEqual(paymentState.requests, ["challenge", "paid"]);
  assert.equal(paymentState.signs.value, 1);
  await runtime.close();
});

test("CMC projection separates the CMC ledger generation from trading-session generation", async () => {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  const initialDigest = `0x${"77".repeat(32)}` as Hex;
  assert.ok(await store.prepareOwnerOperation({ operationId: "initial-setup", agentId: "runtime-agent", ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 0, incrementWei: TOTAL, sessionPublicKey: KEY,
    sessionExpiry: EXPIRY, priorAllowanceWei: 0n, expectedAllowanceWei: TOTAL,
    wallet: WALLET, oldCheckerKeyHash: null, keyHash: initialDigest, callsDigest: initialDigest, calls: [] }));
  assert.ok(await store.recordOwnerAttempt({ operationId: "initial-setup", agentId: "runtime-agent", ownerAddress: OWNER, attemptId: "initial-attempt" }));
  assert.ok(await store.confirmOwnerOperation({ operationId: "initial-setup", agentId: "runtime-agent", ownerAddress: OWNER,
    expectedGeneration: 0, callsId: initialDigest, allowanceWei: TOTAL,
    executionProof: { chainId: 56, wallet: WALLET, txHash: initialDigest, blockHash: `0x${"66".repeat(32)}` as Hex,
      blockNumber: 100n, blockTimestamp: 1_000n, intentId: `0x${"55".repeat(32)}` as Hex, executionNonce: 1n } }));
  await store.setCapability({ agentId: "runtime-agent", ownerAddress: OWNER, generation: 1, available: true });
  const operationId = "ledger-topup";
  const digest = `0x${"88".repeat(32)}` as Hex;
  assert.ok(await store.prepareOwnerOperation({ operationId, agentId: "runtime-agent", ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 1, incrementWei: CMC_PRICE_ATOMIC, sessionPublicKey: KEY,
    sessionExpiry: EXPIRY, priorAllowanceWei: TOTAL, expectedAllowanceWei: TOTAL + CMC_PRICE_ATOMIC,
    wallet: WALLET, oldCheckerKeyHash: null, keyHash: digest, callsDigest: digest, calls: [] }));
  assert.ok(await store.recordOwnerAttempt({ operationId, agentId: "runtime-agent", ownerAddress: OWNER, attemptId: "topup-attempt" }));
  const proof = { chainId: 56 as const, wallet: WALLET, txHash: digest, blockHash: `0x${"99".repeat(32)}` as Hex,
    blockNumber: 101n, blockTimestamp: 1_001n, intentId: `0x${"aa".repeat(32)}` as Hex, executionNonce: 2n };
  assert.ok(await store.confirmOwnerOperation({ operationId, agentId: "runtime-agent", ownerAddress: OWNER,
    expectedGeneration: 1, callsId: digest, allowanceWei: TOTAL + CMC_PRICE_ATOMIC, executionProof: proof }));
  const runtime = createCmcRuntime({ store });
  const sameKey = await runtime.owner.budgetProjection({ agentId: "runtime-agent", ownerAddress: OWNER, optedIn: true,
    currentSession: { generation: 0, publicKey: KEY } });
  assert.equal(sameKey.rebindRequired, false);
  assert.equal(sameKey.status, "ready");
  const nextKey = `0x04${"33".repeat(64)}` as Hex;
  const changedKey = await runtime.owner.budgetProjection({ agentId: "runtime-agent", ownerAddress: OWNER, optedIn: true,
    currentSession: { generation: 0, publicKey: nextKey } });
  assert.equal(changedKey.rebindRequired, true);
  assert.equal(changedKey.reason, "session_rebind_required");
  assert.equal(changedKey.authorizedTotalWei, (TOTAL + CMC_PRICE_ATOMIC).toString(10));
  await runtime.close();
});

test("CMC protected exposure keeps the full finite allowance once across an off toggle and pending charge", async () => {
  const store = await readyStore();
  const operationId = "pending-data-charge";
  assert.equal(await store.claimNewsSlot({ agentId: "runtime-agent", ownerAddress: OWNER, operationId, nowMs: NOW_MS }), true);
  assert.ok(await store.reserve({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, operationId,
    attemptId: "pending-attempt", amountWei: CMC_PRICE_ATOMIC, sessionPublicKey: KEY, sessionExpiry: EXPIRY,
    asset: USDT_56, spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE }));
  const row = await store.get("runtime-agent", OWNER);
  assert.ok(row);
  assert.equal(cmcProtectedExposureWei(row), TOTAL);
  const runtime = createCmcRuntime({ store });
  const off = await runtime.owner.budgetProjection({ agentId: "runtime-agent", ownerAddress: OWNER, optedIn: false });
  const on = await runtime.owner.budgetProjection({ agentId: "runtime-agent", ownerAddress: OWNER, optedIn: true });
  assert.equal(off.protectedExposureWei, TOTAL.toString(10));
  assert.equal(on.protectedExposureWei, TOTAL.toString(10));
  assert.equal(off.reservedWei, CMC_PRICE_ATOMIC.toString(10));
  await runtime.close();
});

test("CMC protected exposure includes a pending owner top-up before confirmation", async () => {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  const initialDigest = `0x${"a3".repeat(32)}` as Hex;
  assert.ok(await store.prepareOwnerOperation({ operationId: "initial", agentId: "runtime-agent", ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 0, incrementWei: TOTAL, sessionPublicKey: KEY, sessionExpiry: EXPIRY,
    priorAllowanceWei: 0n, expectedAllowanceWei: TOTAL, wallet: WALLET, oldCheckerKeyHash: null,
    keyHash: initialDigest, callsDigest: initialDigest, calls: [] }));
  assert.ok(await store.recordOwnerAttempt({ operationId: "initial", agentId: "runtime-agent", ownerAddress: OWNER, attemptId: "initial-attempt" }));
  assert.ok(await store.confirmOwnerOperation({ operationId: "initial", agentId: "runtime-agent", ownerAddress: OWNER,
    expectedGeneration: 0, callsId: initialDigest, allowanceWei: TOTAL,
    executionProof: { chainId: 56, wallet: WALLET, txHash: initialDigest, blockHash: `0x${"a4".repeat(32)}` as Hex,
      blockNumber: 1n, blockTimestamp: 1n, intentId: `0x${"a5".repeat(32)}` as Hex, executionNonce: 1n } }));
  const topupDigest = `0x${"a6".repeat(32)}` as Hex;
  assert.ok(await store.prepareOwnerOperation({ operationId: "pending-topup", agentId: "runtime-agent", ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 1, incrementWei: 5n * CMC_PRICE_ATOMIC, sessionPublicKey: KEY, sessionExpiry: EXPIRY,
    priorAllowanceWei: TOTAL, expectedAllowanceWei: 7n * CMC_PRICE_ATOMIC, wallet: WALLET, oldCheckerKeyHash: null,
    keyHash: topupDigest, callsDigest: topupDigest, calls: [] }));
  const runtime = createCmcRuntime({ store });
  assert.equal(cmcProtectedExposureWei(await store.get("runtime-agent", OWNER)), (1n << 256n) - 1n);
  assert.equal(await runtime.owner.protectedExposure({ agentId: "runtime-agent", ownerAddress: OWNER }), 7n * CMC_PRICE_ATOMIC);
  await runtime.close();
});

test("a supplied sessionSpec reader clears cmc-session-spec-unavailable on the owner runtime", async () => {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  const network = { rpcUrls: ["http://127.0.0.1:1/rpc", "http://127.0.0.1:1/rpc"] as const, relayUrl: "http://127.0.0.1:1/relay" };
  const without = createCmcRuntime({ store, owner: { ...network } });
  assert.equal(without.owner.unavailableReason, "cmc-session-spec-unavailable");
  assert.deepEqual(await without.owner.capability?.check({ agentId: "runtime-agent", wallet: WALLET,
    sessionPublicKey: KEY, generation: 0, nowMs: NOW_MS }), { available: false, reason: "cmc-session-spec-unavailable" });
  await without.close();
  const withSpec = createCmcRuntime({ store, owner: { ...network, sessionSpec: async () => ({ allowedCalls: [], spendCaps: [] }) } });
  assert.equal(withSpec.owner.unavailableReason, null);
  await withSpec.close();
});

test("H7/N2: two enqueues in one cycle union held and shortlisted tickers instead of the second overwriting the first", async () => {
  const store = await readyStore();
  const state = { requests: [] as string[], signs: { value: 0 } };
  const fixture = paymentFixture(state);
  const runtime = createCmcRuntime({ store, now: () => NOW_MS, worker: {
    masterKey: MASTER, authorize: async () => ({ ok: true as const }), capability: capabilityGate(),
    signer: { sign: fixture.sign }, transport: { request: fixture.request },
  } });
  assert.ok(runtime.worker);
  // Exit lane enqueues held only, then (seconds later, same cycle) the entry
  // lane enqueues shortlisted only — the H7 failure mode is the second call
  // wiping the first lane's list via a plain Map.set overwrite.
  runtime.worker.enqueue(target({ heldTickers: ["NVDA"], shortlistedTickers: [] }));
  runtime.worker.enqueue(target({ heldTickers: [], shortlistedTickers: ["MSFT"] }));
  const results = await runtime.worker.scheduler.tick();
  assert.equal(results.length, 1);
  // Held outranks shortlisted (R2.3): only a merged target could still see NVDA here.
  assert.equal(results[0]?.ticker, "NVDA", "the held ticker from the first enqueue survived the second enqueue");
  await runtime.close();
});

// ---------------------------------------------------------------------------
// TRADFI-LLM-CMC-REQUEST R2.1: the runtime's separate `pendingLlmRequests`
// queue, kept out of `queuedTargets` so `scheduler.tick`'s clear/merge never
// touches it.
// ---------------------------------------------------------------------------

function llmRequest(overrides: Partial<{ ticker: string; skill: "planning" | "events"; reason: string; source: "entry" | "exit"; model: string }> = {}) {
  return { ticker: "TSLA", skill: "planning" as const, reason: "TSLA line reads unknown", source: "entry" as const, model: "offline", ...overrides };
}

/** `readyStore()`'s TOTAL (2x `CMC_PRICE_ATOMIC` = 2e16 wei) sits BELOW `CMC_LLM_REQUEST_MIN_REMAINING_WEI` (2e17), so these LLM-request tests need real headroom above that reserve. */
const LLM_REQUEST_TOTAL = 10n * CMC_LLM_REQUEST_MIN_REMAINING_WEI;
async function readyStoreWithLlmBudget(): Promise<MemoryTradeCmcStore> {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, totalWei: LLM_REQUEST_TOTAL });
  await store.setSetup({ agentId: "runtime-agent", ownerAddress: OWNER, wallet: WALLET, generation: 0,
    sessionPublicKey: KEY, sessionExpiry: EXPIRY, allowanceWei: LLM_REQUEST_TOTAL });
  await store.setCapability({ agentId: "runtime-agent", ownerAddress: OWNER, generation: 0, available: true });
  for (const skill of [CMC_SKILL_MACRO, CMC_GLOBAL_TOOL, CMC_SKILL_SECTOR, CMC_SKILL_SCANNER]) {
    await store.putNews({ agentId: "runtime-agent", ownerAddress: OWNER, ticker: GLOBAL_TICKER, skill,
      generation: 0, status: "available", context: "{}", sourceUrl: null, publishedAtMs: null,
      payloadHash: null, paymentOperationId: null, asOfMs: NOW_MS, expiresAtMs: NOW_MS + 24 * 60 * 60_000, lastAttemptAtMs: NOW_MS });
  }
  return store;
}

test("R2.1.2-3/H1: a queued LLM request survives a tick in which listTargets ALSO returns the same agent (bare, no held/shortlisted)", async () => {
  const store = await readyStoreWithLlmBudget();
  const state = { requests: [] as string[], signs: { value: 0 } };
  const fixture = paymentFixture(state);
  const runtime = createCmcRuntime({ store, now: () => NOW_MS, worker: {
    masterKey: MASTER, authorize: async () => ({ ok: true as const }), capability: capabilityGate(LLM_REQUEST_TOTAL),
    signer: { sign: fixture.sign }, transport: { request: fixture.request },
    // The H1 failure mode: `listTargets` returns the SAME agent with EMPTY
    // held/shortlisted, which (pre-fix) replaced the queued target outright.
    listTargets: async () => [target({ heldTickers: [], shortlistedTickers: [] })],
  } });
  assert.ok(runtime.worker);
  runtime.worker.enqueue(target({ heldTickers: [], shortlistedTickers: [], llmRequests: [llmRequest({ ticker: "TSLA" })] }));
  const results = await runtime.worker.scheduler.tick();
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ticker, "TSLA", "the LLM request must survive the listed/queued merge");
  assert.equal(results[0]?.state, "available");
  assert.deepEqual(results[0]?.llmRequestServed, { ticker: "TSLA", skill: "planning" });
  await runtime.close();
});

test("R2.1.2: pending LLM requests are bounded at 56 per agent; the oldest is dropped beyond that", async () => {
  // A budget below CMC_LLM_REQUEST_MIN_REMAINING_WEI refuses every pending
  // request `low-budget` in ONE tick with no store I/O, so the refusal count
  // directly proves how many survived the 56-entry bound.
  const store = await readyStore();
  const state = { requests: [] as string[], signs: { value: 0 } };
  const fixture = paymentFixture(state);
  const runtime = createCmcRuntime({ store, now: () => NOW_MS, worker: {
    masterKey: MASTER, authorize: async () => ({ ok: true as const }), capability: capabilityGate(TOTAL),
    signer: { sign: fixture.sign }, transport: { request: fixture.request },
  } });
  assert.ok(runtime.worker);
  const requests = Array.from({ length: 57 }, (_, index) => llmRequest({ ticker: `TICK${index}`, skill: "events" }));
  runtime.worker.enqueue(target({ heldTickers: [], shortlistedTickers: [], llmRequests: requests }));
  const results = await runtime.worker.scheduler.tick();
  assert.equal(results.length, 1);
  const refusedTickers = new Set((results[0]?.llmRequestsRefused ?? []).map((r) => r.ticker));
  assert.equal(refusedTickers.size, 56, "exactly 56 of the 57 enqueued requests must have survived");
  assert.ok(!refusedTickers.has("TICK0"), "the OLDEST enqueued request must be the one dropped");
  assert.ok(refusedTickers.has("TICK1") && refusedTickers.has("TICK56"));
  await runtime.close();
});

test("R2.1.5: a pending request survives a tick where the hourly slot is already taken by a different served request, and is served on the next free slot", async () => {
  const store = await readyStoreWithLlmBudget();
  const state = { requests: [] as string[], signs: { value: 0 } };
  const fixture = paymentFixture(state);
  const clock = { value: NOW_MS };
  const receiptProof: CmcChargeProofResult = {
    ok: true,
    proof: { chainId: 56, status: "success", blockNumber: 100n, blockHash: `0x${"aa".repeat(32)}`,
      transactionHash: `0x${"99".repeat(32)}`, from: CMC_SIGNER, to: CMC_SPENDER, input: "0x", logs: [], finalized: true },
  };
  // A dynamic gate (unlike `capabilityGate()`'s fixed allowance): re-reads the
  // store's CURRENT allowance each check, so a second/third capability
  // re-verification after a settled spend does not itself look like an
  // allowance change (`cmc-allowance-or-session-changed`) — this test drives
  // three ticks across real settlements, which the other fixed-allowance
  // tests never do.
  const dynamicCapabilityGate: CmcCapabilityGate = { check: async (request) => {
    const row = await store.get(request.agentId, OWNER);
    return { available: true, evidence: {
      kind: "cmc-mainnet-capability-v1", source: "live-mainnet", chainId: 56,
      wallet: request.wallet, accountCodeHash: CAPABILITY_DIGEST, tokenCodeHash: CAPABILITY_DIGEST,
      permit2CodeHash: CAPABILITY_DIGEST, settlerCodeHash: CAPABILITY_DIGEST,
      sessionPublicKey: request.sessionPublicKey, checker: CMC_PERMIT2,
      finiteAllowanceWei: row?.allowanceWei ?? LLM_REQUEST_TOTAL, grantShapeDigest: CAPABILITY_DIGEST,
      ownerApprovalPersists: true, unrelatedTradingPreservesAllowance: true,
      sessionApproveCannotIncreaseAllowance: true, noTemporaryApproveConsumePath: true,
      temporaryApproveCallbackReentryExcluded: true, revokeExpiryRejectsPayment: true,
      walletKeyExclusive: true, additiveIncreaseAllowance: true, proofDigests: [CAPABILITY_DIGEST],
      observedAtMs: clock.value, profileId: "runtime-fixture", generation: request.generation,
      checkerApproved: true,
    } };
  } };
  const runtime = createCmcRuntime({ store, now: () => clock.value, worker: {
    masterKey: MASTER, authorize: async () => ({ ok: true as const }), capability: dynamicCapabilityGate,
    signer: { sign: fixture.sign }, transport: { request: fixture.request },
    // Settle each served attempt within its own tick (as `scheduler.tick`
    // already reconciles pending operations) so the SECOND tick's blocker is
    // purely the hourly slot throttle, not an unrelated unsettled disclosure.
    chargeReconciler: { reconcile: async () => receiptProof },
    // Production always returns the agent from `listTargets` every tick
    // (armed + cmcNewsEnabled), regardless of whether anything was enqueued
    // that cycle — this is what lets a pending request be re-evaluated on a
    // LATER tick with no further `enqueue` call.
    listTargets: async () => [target({ heldTickers: [], shortlistedTickers: [] })],
  } });
  assert.ok(runtime.worker);
  runtime.worker.enqueue(target({ heldTickers: [], shortlistedTickers: [],
    llmRequests: [llmRequest({ ticker: "TSLA" }), llmRequest({ ticker: "GOOGL" })] }));
  const first = await runtime.worker.scheduler.tick();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.ticker, "TSLA", "oldest-first: TSLA was enqueued before GOOGL");
  assert.deepEqual(first[0]?.llmRequestServed, { ticker: "TSLA", skill: "planning" });
  // Same hour: the hourly slot is taken, so a second tick makes no paid call
  // at all (R3.8) — GOOGL stays pending, not served and not refused.
  const secondSameHour = await runtime.worker.scheduler.tick();
  assert.equal(secondSameHour[0]?.state, "skipped");
  assert.equal(secondSameHour[0]?.reason, "hourly_slot_unavailable");
  // An hour later, the slot frees up: GOOGL is served.
  clock.value += 3_600_000 + 1_000;
  const third = await runtime.worker.scheduler.tick();
  assert.equal(third.length, 1);
  assert.equal(third[0]?.ticker, "GOOGL");
  assert.deepEqual(third[0]?.llmRequestServed, { ticker: "GOOGL", skill: "planning" });
  await runtime.close();
});

test("AUDIT L-6/R2.1.5: a pending request queued in an EARLIER 16:30-ET window is dropped, not served, once the window has ended", async () => {
  const store = await readyStoreWithLlmBudget();
  const state = { requests: [] as string[], signs: { value: 0 } };
  const fixture = paymentFixture(state);
  const windowA = NOW_MS; // Wed 17:00 ET, inside window A
  const windowB = Date.UTC(2026, 8, 24, 21, 0); // Thu 17:00 ET, inside the NEXT window
  const clock = { value: windowA };
  const runtime = createCmcRuntime({ store, now: () => clock.value, worker: {
    masterKey: MASTER, authorize: async () => ({ ok: true as const }), capability: capabilityGate(LLM_REQUEST_TOTAL),
    signer: { sign: fixture.sign }, transport: { request: fixture.request },
    listTargets: async () => [target({ heldTickers: [], shortlistedTickers: [] })],
  } });
  assert.ok(runtime.worker);
  // Queued inside window A, never served that window (nothing ticks window A).
  runtime.worker.enqueue(target({ heldTickers: [], shortlistedTickers: [], llmRequests: [llmRequest({ ticker: "TSLA" })] }));
  // Seed macro/global/sector/scanner fresh for window B's day too, so the
  // ONLY thing that could possibly be served on this tick is the (stale) TSLA
  // request — if it were served, `ticker` would read "TSLA" directly.
  for (const skill of ["macro_news_aggregator", "get_global_metrics_latest", "us_equity_sector_rotation", "us_equity_uptrend_quality_scanner"]) {
    await store.putNews({ agentId: "runtime-agent", ownerAddress: OWNER, ticker: "_GLOBAL", skill, generation: 0, status: "available",
      context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: null,
      asOfMs: windowB, expiresAtMs: windowB + 24 * 60 * 60_000, lastAttemptAtMs: windowB });
  }
  clock.value = windowB;
  const tick = await runtime.worker.scheduler.tick();
  assert.equal(tick.length, 1);
  assert.notEqual(tick[0]?.ticker, "TSLA", "a request from the ended window A must never be served in window B");
  assert.equal(tick[0]?.llmRequestServed, undefined);
  assert.equal(tick[0]?.state, "skipped", "with nothing scheduled due either, the tick finds nothing to do");
  await runtime.close();
});
