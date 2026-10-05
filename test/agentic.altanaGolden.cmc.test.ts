import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import type { X402PaymentPayload } from "@altananetwork/sdk";
import {
  CMC_CONFIG_ID,
  CMC_GLOBAL_TOOL,
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
  type CmcRuntimeTarget,
} from "../src/trade/cmcRuntime.js";
import type { CmcChargeProofResult } from "../src/trade/cmcProof.js";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import type { CustodyModel } from "../src/core/types.js";

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


import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
test("Agentic golden Altana: CMC payment through the Altana runtime", async testContext => {
  let uuid = 0;
  testContext.mock.method(Date, "now", () => NOW_MS);
  testContext.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  testContext.after(() => { testContext.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const withAgenticRows of [false, true]) {
  uuid = 0;
  const agents = new MemoryAgentStore(null, () => NOW_MS);
  await agents.createAgent({ id: "runtime-agent", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", status: "armed" });
  if (withAgenticRows) await agents.createAgent({ id: "agentic-golden", ownerAddress: getAddress("0x3333333333333333333333333333333333333333"),
    walletAddress: getAddress("0x4444444444444444444444444444444444444444"), custodyModel: "binance-agentic" as CustodyModel, status: "armed" });
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
    authorize: async (input) => {
      assert.equal((await agents.getAgent(input.ownerAddress, input.agentId))?.custodyModel, "passkey");
      authorizationAmounts.push(input.amountWei); return { ok: true as const };
    },
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
  const transcript = JSON.stringify({ requests, signs, authorizationAmounts, refreshed, reconciled,
    budget: await store.get("runtime-agent", OWNER), context: await runtime.worker.getFreshContext({ target: target(), ticker: "NVDA" })
  }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  assert.equal(crypto.createHash("sha256").update(transcript).digest("hex"), "d0cc515956c806a939351f9b6707636d9d8205209e57bd4547ab618c0295a59e");
  await runtime.close();
  }
});

