/** Independent final-audit regressions. All transports are intercepted offline. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { buildQuantRebalanceWorkerDeps, verifyQuantRebalanceActionReceipt } from "../scripts/quantRebalanceWorkerDeps.js";
import { PORTO_V055_INTENT_PARAMETERS } from "../src/lp/intentDecoder.js";
import { localQuantRebalanceConfigCheck } from "../src/quant/rebalanceOperatorCli.js";
import type { QuantRebalanceActionRow } from "../src/quant/rebalanceTypes.js";
import type { WalletCall } from "../src/core/types.js";
import { parseSessionPlaintext } from "../src/quant/admission.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "../src/wallet/abis.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import { planRebalanceLeg } from "../src/quant/rebalancePortfolio.js";
import { E18, HIGH_TIER, LOW_TIER, REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";
import { buildRebalanceCalls, enumerateRebalanceRoutes, evaluateReferenceGuard, rebalancePathKey, requiredReferencePath } from "../src/quant/rebalanceRoutes.js";
import { verifyQuantPortoFeeQuote, type QuantPortoFeeQuote } from "../src/quant/rebalanceFee.js";
import { QUANT_ORCHESTRATOR_56 } from "../src/quant/receipt.js";
import { MemoryQuantRebalanceStore, type RebalanceActionInsertInput } from "../src/store/quantRebalance.js";
import { MemoryQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import type { QuantRebalanceCapabilityProfile } from "../src/quant/rebalanceConfig.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { WalletProvider } from "../src/core/types.js";
import type { QuantTransport } from "../src/quant/termix.js";
import type { QuantKeypair } from "../src/quant/envelope.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const WALLET = getAddress(`0x${"12".repeat(20)}`);
const PAIR = getAddress(`0x${"23".repeat(20)}`);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const NOW = Date.now();

function profile(): QuantRebalanceCapabilityProfile {
  const routes = ["buy", "sell"].flatMap((side) => enumerateRebalanceRoutes("WBNB", side as "buy" | "sell"));
  return { id: "audit-only", capturedConfigProfileId: "audit-only", wireVersion: "audit-only",
    grantShapes: ["selector-scoped"], toleratedGrantTargets: [], duplicateWholeGrantTargets: [],
    executionRoutes: routes.map((r) => rebalancePathKey(r.path)),
    referenceRoutes: routes.map((r) => rebalancePathKey(requiredReferencePath(r.path)!)),
    maximumExitGasUnits: 500_000n, indexingEvidenceDigest: HASH, reportEvidenceDigest: HASH };
}

async function setup() {
  const claims = new MemoryQuantWalletClaimStore({ noAction: async () => true, terminalAndNoUnresolved: async () => false }, true);
  const journal = new MemoryExecutionJournal(() => NOW);
  const store = new MemoryQuantRebalanceStore(claims);
  const wire: QuantJobRecord = { id: "audit-job", strategyId: "audit-strategy", status: "ACTIVE",
    tradingWalletAddress: WALLET, allocationUWei: 100n * E18, dailyCapUWei: 100n * E18,
    termDays: 30, startedAtMs: NOW - 1_000, endsAtMs: NOW + 86_400_000,
    sessionExpiresAtMs: NOW + 86_400_000, revokedAtMs: null };
  const row = await store.discoverJob({ wire: { ...wire, envelope: null, wireDigest: HASH }, envelopeId: null, envelopeJson: null, nowMs: NOW });
  const attempt = { wallet: WALLET, strategyKind: "rebalance" as const, strategyId: wire.strategyId, jobId: wire.id, attemptId: "audit-attempt", nowMs: NOW };
  const claimed = await claims.claimProvisional(attempt); assert.equal(claimed.kind, "acquired");
  if (claimed.kind !== "acquired") throw new Error("fixture-claim");
  const promotion = await claims.promoteProvisional({ ...attempt, generation: claimed.claim.generation }, async () => {
    const admitted = await store.admit({ jobId: wire.id, expectedRowVersion: row.rowVersion, attemptId: attempt.attemptId,
      claimGeneration: claimed.claim.generation, policyJson: "{}", policyDigest: HASH, tier: "high",
      sessionPublicKey: `0x${"11".repeat(65)}`, sessionExpirySec: Math.floor(wire.sessionExpiresAtMs! / 1_000),
      permissionsDigest: HASH, projectionDigest: HASH, descriptorJson: "{}", projectionJson: "{}", capRowsJson: "[]",
      baselineBlock: 1n, baselineHash: HASH, baselineAtMs: NOW,
      actualBaseline: { USDC: 100n * E18, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n },
      protectedBaseline: { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n }, nowMs: NOW });
    return admitted.kind === "ok" ? admitted.record : null;
  });
  assert.equal(promotion.promoted, true); assert(promotion.value);
  return { claims, journal, store, job: promotion.value, wire };
}

async function intended(f: Awaited<ReturnType<typeof setup>>) {
  const check = (await f.store.listChecks(f.job.jobId))[0]!;
  const calls = buildRebalanceCalls({ router: REBALANCE_ROUTER, path: [REBALANCE_USDC, REBALANCE_WBNB],
    amountInWei: E18, quoteOutWei: E18, recipient: WALLET, deadlineSec: Math.floor(NOW / 1_000) + 600, actionSequence: 1n });
  const input: RebalanceActionInsertInput = { jobId: f.job.jobId, checkId: check.checkId, sequence: 1n,
    side: "buy", asset: "WBNB", tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB,
    path: [REBALANCE_USDC, REBALANCE_WBNB], pairAddresses: [PAIR], amountInWei: E18,
    minOutWei: calls.minOutWei, quoteOutWei: E18, deadlineSec: Math.floor(NOW / 1_000) + 600,
    callsJson: JSON.stringify(calls.calls), callsDigest: HASH, policyDigest: HASH, permissionsDigest: HASH,
    projectionDigest: HASH, claimGeneration: f.job.claimGeneration!, quoteBlockNumber: 2n, quoteBlockHash: HASH,
    quoteObservedAtMs: NOW, referenceBlockNumber: 2n, referenceBlockHash: HASH, referenceObservedAtMs: NOW,
    referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: E18,
    expectedJobRevision: f.job.accountingRev, expectedCheckVersion: check.rowVersion, nowMs: NOW };
  const result = await f.store.insertAction(input); assert.equal(result.kind, "ok");
  if (result.kind !== "ok") throw new Error("fixture-intent");
  return result.record;
}

function productionDeps(f: Awaited<ReturnType<typeof setup>>, reader: QuantChainReader = {} as QuantChainReader, provider: WalletProvider = {} as WalletProvider) {
  return buildQuantRebalanceWorkerDeps({ config: { chainId: 56, databaseUrl: "", envelopeKey: "", apiKey: "",
    agentId: "audit", strategyId: f.wire.strategyId, apiBaseUrl: "https://offline.invalid", rpcUrls: ["https://offline.invalid"], intervalMs: 60_000 },
    capabilityProfile: profile(), store: f.store, claims: f.claims, journal: f.journal,
    reader, provider, transport: {} as QuantTransport, keypair: {} as QuantKeypair });
}

test("audit RB sizing control: untouched 100-USDC bootstrap allocates 40 to WBNB", () => {
  const managed = { USDC: 100n * E18, WBNB: 0n, ETH: 0n, CAKE: 0n };
  const leg = planRebalanceLeg({ managed, values: managed, tier: HIGH_TIER, takenAssets: new Set(), checkMode: "bootstrap" });
  assert.equal(leg.kind, "buy"); if (leg.kind === "buy") assert.equal(leg.amountInWei, 40n * E18);
});

test("audit RB sizing: failed WBNB leaves its target cash and buys only 40 USDC of ETH", () => {
  const managed = { USDC: 100n * E18, WBNB: 0n, ETH: 0n, CAKE: 0n };
  const leg = planRebalanceLeg({ managed, values: managed, tier: HIGH_TIER, takenAssets: new Set(["WBNB"]), checkMode: "bootstrap" });
  assert.equal(leg.kind, "buy"); if (leg.kind === "buy") { assert.equal(leg.asset, "ETH"); assert.equal(leg.amountInWei, 40n * E18); }
});

test("audit RB reference: a sell price 2.01 percent above the reference must fail", () => {
  const path = [REBALANCE_WBNB, REBALANCE_USDC];
  const referencePath = [REBALANCE_WBNB, REBALANCE_USDT, REBALANCE_USDC];
  const result = evaluateReferenceGuard({ candidatePath: path, referencePath,
    candidateBlockHash: HASH, referenceBlockHash: HASH,
    candidatePairs: [{ address: PAIR, token0: REBALANCE_WBNB, token1: REBALANCE_USDC,
      reserve0: 1_000_000n * E18, reserve1: 1_020_100n * E18, blockHash: HASH }],
    referencePairs: [
      { address: getAddress(`0x${"34".repeat(20)}`), token0: REBALANCE_WBNB, token1: REBALANCE_USDT, reserve0: 1_000_000n * E18, reserve1: 1_000_000n * E18, blockHash: HASH },
      { address: getAddress(`0x${"45".repeat(20)}`), token0: REBALANCE_USDT, token1: REBALANCE_USDC, reserve0: 1_000_000n * E18, reserve1: 1_000_000n * E18, blockHash: HASH },
    ] });
  assert.deepEqual(result, { ok: false, code: "reference-deviation" });
});

function fee(intentExtra: Readonly<Record<string, unknown>> = {}) {
  const quote: QuantPortoFeeQuote = { chainId: 56, orchestrator: QUANT_ORCHESTRATOR_56,
    intent: { eoa: WALLET, executionData: "0x1234", expiry: 0n, keyHash: HASH,
      paymentToken: ZERO, payer: ZERO, paymentAmount: 30_000_000_000_000n, paymentMaxAmount: 40_000_000_000_000n,
      encodedPreCalls: [], encodedFundTransfers: [], funder: ZERO, funderSignature: "0x", ...intentExtra },
    nativeFeeEstimate: { maxFeePerGas: 5n }, txGas: 100n, extraPayment: 0n, ttl: 1030 };
  return verifyQuantPortoFeeQuote({ quote, wallet: WALLET, expectedKeyHash: HASH, executionDataHash: keccak256("0x1234"),
    nowSec: 1000, sessionExpirySec: 2000, quotedAtMs: 1_000_000, receivedAtMs: 1_000_001 });
}
test("audit RB fee control: empty funding and pre-call vectors pass", () => assert(fee()));
test("audit RB fee: an unexpected pre-call invalidates the quote", () => assert.equal(fee({ encodedPreCalls: ["0x1234"] }), null));
test("audit RB fee: an unexpected funding intent invalidates the quote", () => assert.equal(fee({ encodedFundTransfers: ["0x1234"], funder: WALLET, funderSignature: "0x1234" }), null));

async function productionAdmissionProbe(ignoreRegistryHash: boolean) {
  const f = await setup();
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: Record<string, unknown> };
  const parsed = parseSessionPlaintext(JSON.stringify({ ...fixture.session, expiry: Math.floor(NOW / 1000) + 86_400 }));
  assert(parsed.ok); const { signerPrivateKey: _discard, ...session } = parsed.session; void _discard;
  const accountHash = accountKeyHashForAddress(publicKeyToAddress(session.publicKey));
  const registryHash = keccak256(session.publicKey);
  let observedRegistryHash: Hex | null = null; let canExecuteCalls = 0;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (_request, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ data: Hex }] };
    assert.equal(body.method, "eth_call");
    const data = body.params[0].data;
    let result: Hex;
    try {
      const decoded = decodeFunctionData({ abi: KEYSTORE_ABI, data });
      assert.equal(decoded.functionName, "isValidKey");
      if (decoded.functionName !== "isValidKey") throw new Error("unexpected");
      observedRegistryHash = decoded.args[1];
      result = encodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "isValidKey", result: ignoreRegistryHash || observedRegistryHash === registryHash });
    } catch {
      const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data });
      if (decoded.functionName === "getKeys") result = encodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "getKeys",
        result: [[{ expiry: session.expiry, keyType: 0, isSuperAdmin: false, publicKey: session.publicKey }], [accountHash]] });
      else { assert.equal(decoded.functionName, "canExecute"); canExecuteCalls += 1;
        result = encodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "canExecute", result: false }); }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  };
  try {
    const reader = { chainId: async () => 56, finalizedBlock: async () => ({ number: 1n, hash: HASH, timestampSec: BigInt(Math.floor(NOW / 1000)) }),
      tokenBalanceAtHash: async () => 100n * E18, nativeBalanceAtHash: async () => E18 } as unknown as QuantChainReader;
    const deps = productionDeps(f, reader, { readSpendInfos: async () => [] } as unknown as WalletProvider);
    await deps.admitChain({ job: { ...f.wire, tradingWalletAddress: session.walletAddress, allocationUWei: 10n * E18 },
      session, grantShape: "selector-scoped", tier: LOW_TIER, capabilityProfile: profile() });
    return { observedRegistryHash, registryHash, canExecuteCalls };
  } finally { globalThis.fetch = priorFetch; }
}
test("audit RB production admission uses the KeyStore public-key ID", async () => {
  const result = await productionAdmissionProbe(false); assert.equal(result.observedRegistryHash, result.registryHash);
});
test("audit RB production admission reaches canExecute with encodable probe amounts", async () => {
  const result = await productionAdmissionProbe(true); assert.equal(result.canExecuteCalls, 1);
});

test("audit RB durable action insertion persists the new router deadline", async () => {
  const f = await setup(); const action = await intended(f);
  assert.equal((await f.store.getJob(f.job.jobId))?.lastDeadlineSec, action.deadlineSec);
});

for (const state of ["absent", "PENDING", "ROLLED_BACK"] as const) test(`audit RB crash recovery resolves an intended action with ${state} journal under sender exclusion`, async () => {
  const f = await setup(); const action = await intended(f);
  if (state !== "absent") {
    await f.journal.beginWithSpend({ idempotencyKey: action.journalKey, agentId: f.job.jobId,
      ownerAddress: WALLET, kind: "quantTrade", decisionId: action.journalKey, externalRef: {}, nativeSpendWei: 0n }, 0);
    if (state === "ROLLED_BACK") await f.journal.markRolledBack(action.journalKey, "offline pre-submit refusal");
  }
  await productionDeps(f).recoverAction((await f.store.getJob(f.job.jobId))!, action);
  assert.equal((await f.store.listUnresolvedActions(f.job.jobId)).length, 0);
});

test("audit RB term-end report failures remain eligible for bounded retries", async () => {
  const f = await setup(); await f.store.markEnded({ jobId: f.job.jobId, unresolved: false, nowMs: NOW });
  await f.store.recordReportAttempt({ jobId: f.job.jobId, payloadDigest: HASH, responseStatus: 0, notesApplied: null, nowMs: NOW });
  assert((await f.store.listWorkableJobs(f.job.strategyId)).some((row) => row.jobId === f.job.jobId));
});

async function submittedFixture() {
  const f = await setup(); const intent = await intended(f);
  const claimed = await f.store.markSubmitted({ actionId: intent.actionId, expectedRowVersion: intent.rowVersion,
    claimGeneration: intent.claimGeneration, blockNumber: 2n, blockHash: HASH, nowMs: NOW, revalidate: async () => true });
  assert.equal(claimed.kind, "ok"); if (claimed.kind !== "ok") throw new Error("fixture-submit");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: { publicKey: Hex } };
  return { ...f, job: { ...(await f.store.getJob(f.job.jobId))!, sessionPublicKey: fixture.session.publicKey }, action: claimed.record };
}

function failedReader(f: Awaited<ReturnType<typeof submittedFixture>>, action: QuantRebalanceActionRow, receiptBlock: bigint) {
  const keyHash = accountKeyHashForAddress(publicKeyToAddress(f.job.sessionPublicKey!));
  const calls = JSON.parse(action.callsJson) as WalletCall[];
  const executionData = encodeAbiParameters([{ type: "tuple[]", components: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
  ] }], [calls.map((call) => ({ target: call.to, value: call.value ?? 0n, data: call.data ?? "0x" }))]);
  const encoded = encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [{ eoa: WALLET, executionData, nonce: 8n,
    payer: ZERO, paymentToken: ZERO, paymentMaxAmount: 0n, combinedGas: 0n, encodedPreCalls: [], encodedFundTransfers: [],
    settler: ZERO, expiry: 0n, isMultichain: false, funder: ZERO, funderSignature: "0x", settlerContext: "0x",
    paymentAmount: 0n, paymentRecipient: ZERO, signature: `0x00${keyHash.slice(2)}00`, paymentSignature: "0x", supportedAccountImplementation: ZERO }]);
  const calldata = encodeFunctionData({ abi: parseAbi(["function execute(bytes encodedIntent) payable returns (bytes4 err)"]), functionName: "execute", args: [encoded] });
  const txHash = `0x${"cd".repeat(32)}` as Hex;
  const reader = { chainId: async () => 56,
    getTransaction: async () => ({ hash: txHash, to: QUANT_ORCHESTRATOR_56, input: calldata, blockNumber: receiptBlock, blockHash: HASH, transactionIndex: 0n }),
    getReceipt: async () => ({ transactionHash: txHash, status: 0n, logs: [], blockNumber: receiptBlock, blockHash: HASH, transactionIndex: 0n }),
    finalizedBlock: async () => ({ number: 3n, hash: HASH, timestampSec: BigInt(Math.floor(NOW / 1_000)) }),
    blockAt: async (number: bigint) => ({ number, hash: HASH, timestampSec: BigInt(Math.floor(NOW / 1_000)) }),
    getPair: async () => PAIR, pairToken0: async () => REBALANCE_USDC, pairToken1: async () => REBALANCE_WBNB,
  } as unknown as QuantChainReader;
  return { reader, txHash };
}

test("audit RB positive failure control: canonical post-submit revert verifies", async () => {
  const f = await submittedFixture(); const fixture = failedReader(f, f.action, 3n);
  assert((await verifyQuantRebalanceActionReceipt({ reader: fixture.reader, job: f.job, action: f.action, txHash: fixture.txHash }))?.failure);
});

test("audit RB receipt proof refuses an otherwise matched transaction before the submit ancestor", async () => {
  const f = await submittedFixture(); const fixture = failedReader(f, f.action, 1n);
  assert.equal(await verifyQuantRebalanceActionReceipt({ reader: fixture.reader, job: f.job, action: f.action, txHash: fixture.txHash }), null);
});

test("audit RB daemon persists a callsId-discovered failure hash before terminal store proof", async () => {
  const f = await submittedFixture(); const fixture = failedReader(f, f.action, 3n);
  await f.journal.beginWithSpend({ idempotencyKey: f.action.journalKey, agentId: f.job.jobId, ownerAddress: WALLET,
    kind: "quantTrade", decisionId: f.action.journalKey, externalRef: {}, nativeSpendWei: 0n }, 0);
  await f.journal.markInProgress(f.action.journalKey, { callsId: "0x1234" });
  const provider = { readExecutionStatus: async () => ({ receipt: { status: "FAILED", transactionHash: fixture.txHash } }) } as unknown as WalletProvider;
  await productionDeps(f, fixture.reader, provider).recoverAction(f.job, f.action);
  assert.equal((await f.journal.get(f.action.journalKey))?.externalRef.txHash, fixture.txHash);
});

test("audit RB config-check returns the exact cleared OFF and missing-profile codes", () => {
  const result = localQuantRebalanceConfigCheck({ chainId: 56, enabled: false, flagValid: true, configProfileCount: 0, capabilityProfileCount: 0 });
  assert.deepEqual(new Set(result.reasons), new Set(["rebalancing-disabled", "production-capability-profile-missing", "platform-config-unreviewed"]));
});
