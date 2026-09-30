/** G1: the first reviewed production profiles and the guards that keep file profiles out of production. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { parseConfigBlock } from "../src/quant/termix.js";
import {
  assertProductionRebalanceProfiles, assertProductionRebalanceRegistries, findCapabilityProfile,
  findExpandedConfigProfile, normalizeExpandedQuantConfig, quantExpandedConfigDigest,
  QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES,
  type QuantExpandedConfigProfile, type QuantRebalanceCapabilityProfile,
} from "../src/quant/rebalanceConfig.js";
import {
  G1_EVIDENCE_DIGEST, PRODUCTION_EXPANDED_CONFIG_PROFILE, PRODUCTION_REBALANCE_CAPABILITY_PROFILE,
} from "../src/quant/rebalanceProductionProfiles.js";
import { G2_CAPTURE_SHA256, G2_FINITE_JOB, loadG2FileProfiles } from "../src/quant/rebalanceSelftest.js";
import {
  E18, G2_FILE_CAPABILITY_ID, G2_FINITE_CAPABILITY_ID, HIGH_TIER, LOW_TIER, REBALANCE_CAKE, REBALANCE_ETH,
  REBALANCE_MAX_GAS_PRICE_WEI, REBALANCE_NATIVE_FEE_PAD_BPS, REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_USDT,
  REBALANCE_VERSION, REBALANCE_WBNB, BPS, ceilDiv, rebalanceJobPolicyDigest, rebalanceJobPolicyProjection,
  rebalancePolicyProjection, rebalanceTierForProfile, requiredNativeReserve,
} from "../src/quant/rebalancePolicy.js";
import { admitRebalanceSession } from "../src/quant/rebalanceAdmission.js";
import { planRebalanceLeg } from "../src/quant/rebalancePortfolio.js";
import { parseSessionPlaintext, permissionsDigest, projectGrantedPermissions, specDigest } from "../src/quant/admission.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import { seal } from "../src/quant/envelope.js";
import { runQuantRebalanceWorkerOnce, type QuantRebalanceWorkerDeps } from "../src/quant/rebalanceWorker.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import { MemoryQuantRebalanceStore, type QuantRebalanceStore } from "../src/store/quantRebalance.js";
import { MemoryQuantWalletClaimStore, type QuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { encodeJsonbParam } from "../src/store/codec.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { ExecutionJournal } from "../src/store/journal.js";
import type { WalletProvider } from "../src/core/types.js";
import { main as daemonMain } from "../scripts/quant-rebalance-worker.js";
import { assertQuantRebalanceBoot, buildQuantRebalanceWorkerDeps, type RebalanceRevalidationRefusal } from "../scripts/quantRebalanceWorkerDeps.js";
import { encodeLpFinalCallsV1 } from "../src/lp/preparedIntentWitness.js";
import { QUANT_ORCHESTRATOR_56 } from "../src/quant/receipt.js";
import type { FileQuantTransport } from "../src/quant/selftest.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "../src/wallet/abis.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";

const CONFIG_ID = "termix-quant-config-2026-09-27-v1";
const CAPABILITY_ID = "termix-rebalance-wizard-v1";
const FIXTURE = new URL("./fixtures/quant/contracts-customization-quant.json", import.meta.url);
const R146_FIXTURE = new URL("./fixtures/quant/termix-config-2026-09-30.json", import.meta.url);
const EVIDENCE = new URL("../MD here/QUANT-REBALANCING-G1-EVIDENCE.md", import.meta.url);
const HASH = `0x${"ab".repeat(32)}` as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

function projectionOf(bytes: Buffer) {
  const parsed = parseConfigBlock(JSON.parse(bytes.toString("utf8")) as unknown);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("fixture-parse");
  const normalized = normalizeExpandedQuantConfig(parsed.data);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) throw new Error("fixture-normalize");
  return normalized.projection;
}

describe("B1: the embedded config profile", () => {
  it("is the normalized projection of the SHA-pinned capture, written out literally", () => {
    const bytes = readFileSync(FIXTURE);
    assert.equal(createHash("sha256").update(bytes).digest("hex").toUpperCase(), G2_CAPTURE_SHA256);
    const projection = projectionOf(bytes);
    assert.deepEqual(PRODUCTION_EXPANDED_CONFIG_PROFILE.expected, projection);
    assert.equal(quantExpandedConfigDigest(PRODUCTION_EXPANDED_CONFIG_PROFILE.expected), quantExpandedConfigDigest(projection));
    assert.equal(PRODUCTION_EXPANDED_CONFIG_PROFILE.id, CONFIG_ID);
    assert.equal(PRODUCTION_EXPANDED_CONFIG_PROFILE.expectedVenueRowCount, 14);
    assert.equal(PRODUCTION_EXPANDED_CONFIG_PROFILE.expectedUniqueVenueTargetCount, 12);
    assert.equal(PRODUCTION_EXPANDED_CONFIG_PROFILE.capturedEvidenceDigest,
      "0xBF3D32B15B06BDE032713A49B4583B9DB4C810F9C32787CED7644458C9F7EB46");
    assert.ok(PRODUCTION_EXPANDED_CONFIG_PROFILE.capturedEvidenceRef.includes(G2_CAPTURE_SHA256));
    assert.ok(PRODUCTION_EXPANDED_CONFIG_PROFILE.capturedEvidenceRef.includes(
      "BF3D32B15B06BDE032713A49B4583B9DB4C810F9C32787CED7644458C9F7EB46"));
    assert.equal(findExpandedConfigProfile(projection), PRODUCTION_EXPANDED_CONFIG_PROFILE);
  });

  it("matches the 2026-09-30 live projection recorded by R14.6, once that fixture is in the tree", (t) => {
    if (!existsSync(R146_FIXTURE)) {
      t.skip("test/fixtures/quant/termix-config-2026-09-30.json is not in this tree; pending for the merge with R14.6");
      return;
    }
    assert.deepEqual(projectionOf(readFileSync(R146_FIXTURE)), PRODUCTION_EXPANDED_CONFIG_PROFILE.expected);
  });
});

describe("B2: the production capability profile", () => {
  it("holds exactly the reviewed shape, six routes and the relay gas-equivalent ceiling", () => {
    const profile = PRODUCTION_REBALANCE_CAPABILITY_PROFILE;
    assert.equal(profile.id, CAPABILITY_ID);
    assert.equal(profile.capturedConfigProfileId, CONFIG_ID);
    assert.equal(profile.wireVersion, "quant-job-v1");
    assert.deepEqual(profile.grantShapes, ["whole-contract"]);
    assert.deepEqual(profile.toleratedGrantTargets, [REBALANCE_ETH, REBALANCE_CAKE]);
    assert.deepEqual(profile.duplicateWholeGrantTargets, [REBALANCE_USDC]);
    // Exactly the routes the G2 rehearsals executed, and the reference paths they were compared against.
    const rehearsed = loadG2FileProfiles().capability;
    assert.deepEqual(profile.executionRoutes, rehearsed.executionRoutes);
    assert.deepEqual(profile.referenceRoutes, rehearsed.referenceRoutes);
    assert.equal(profile.executionRoutes.length, 6);
    assert.equal(profile.referenceRoutes.length, 6);
    assert.equal(profile.maximumExitGasUnits, 700_000n);
    assert.equal(profile.indexingEvidenceDigest, G1_EVIDENCE_DIGEST);
    assert.equal(profile.reportEvidenceDigest, G1_EVIDENCE_DIGEST);
  });

  it("is registered, is not a file id, and receives the production tiers and policy", () => {
    assert.deepEqual(QUANT_EXPANDED_CONFIG_PROFILES, [PRODUCTION_EXPANDED_CONFIG_PROFILE]);
    assert.deepEqual(QUANT_REBALANCE_CAPABILITY_PROFILES, [PRODUCTION_REBALANCE_CAPABILITY_PROFILE]);
    assert.equal(findCapabilityProfile(CAPABILITY_ID), PRODUCTION_REBALANCE_CAPABILITY_PROFILE);
    assert.equal(CAPABILITY_ID.startsWith("g2-") || CAPABILITY_ID.startsWith("quant-rebalance-g2-"), false);
    for (const [allocation, tier] of [[10n, LOW_TIER], [74n, LOW_TIER], [75n, HIGH_TIER], [1_000n, HIGH_TIER]] as const) {
      const decision = rebalanceTierForProfile(allocation * E18, CAPABILITY_ID);
      assert.equal(decision.ok && decision.tier, tier);
    }
    const projection = rebalancePolicyProjection(CAPABILITY_ID);
    assert.equal(projection.version, REBALANCE_VERSION);
    assert.deepEqual(projection.tiers, [LOW_TIER, HIGH_TIER]);
    assert.equal(projection.maxGasPriceWei, REBALANCE_MAX_GAS_PRICE_WEI);
    assert.equal("finiteSchedule" in projection, false);
    assert.deepEqual({ ...projection, capabilityProfileId: null }, rebalancePolicyProjection(null));
    for (const id of [G2_FILE_CAPABILITY_ID, G2_FINITE_CAPABILITY_ID]) {
      assert.notDeepEqual(rebalancePolicyProjection(id).tiers, projection.tiers);
    }
  });

  it("admits only the whole-contract wizard shape, USDC at most twice, and no extra targets", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: Record<string, unknown> };
    const wizard = JSON.parse(readFileSync(new URL("./fixtures/quant/wizard-session-shape.json", import.meta.url), "utf8")) as
      { permissions: { calls: { to: string }[]; spend: unknown[] } };
    const nowMs = (1_800_000_000 - 2 * 86_400) * 1_000;
    const session = (permissions: unknown) => {
      const result = parseSessionPlaintext(JSON.stringify({ ...fixture.session, permissions }));
      assert.equal(result.ok, true, result.ok ? "" : result.code);
      if (!result.ok) throw new Error("session");
      return result.session;
    };
    const record = (s: ReturnType<typeof session>, allocation: bigint): QuantJobRecord => ({
      id: "prod-admission", status: "ACTIVE", strategyId: "strategy-prod", tradingWalletAddress: getAddress(s.walletAddress),
      allocationUWei: allocation, dailyCapUWei: allocation, termDays: 30, startedAtMs: nowMs - 60_000,
      endsAtMs: s.expiry * 1_000, sessionExpiresAtMs: s.expiry * 1_000, revokedAtMs: null,
    });
    const admit = (permissions: unknown, allocation: bigint) => {
      const s = session(permissions);
      return admitRebalanceSession({ session: s, job: record(s, allocation), capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE, nowMs });
    };
    const clone = () => structuredClone(wizard.permissions) as { calls: { to: string; signature?: string }[]; spend: unknown[] };

    const low = admit(wizard.permissions, 10n * E18);
    assert.equal(low.ok, true, low.ok ? "" : low.code);
    if (low.ok) assert.equal(low.grantShape, "whole-contract");

    const thrice = clone(); thrice.calls.push({ to: REBALANCE_USDC });
    const duplicated = admit(thrice, 10n * E18);
    assert.equal(duplicated.ok, false); if (!duplicated.ok) assert.equal(duplicated.code, "session-grant-duplicate");

    const extra = clone(); extra.calls.push({ to: REBALANCE_USDT });
    const excess = admit(extra, 10n * E18);
    assert.equal(excess.ok, false); if (!excess.ok) assert.equal(excess.code, "session-grant-excess");

    const scoped = { calls: [
      { to: REBALANCE_ROUTER, signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" },
      { to: REBALANCE_USDC, signature: "approve(address,uint256)" },
      { to: REBALANCE_WBNB, signature: "approve(address,uint256)" },
    ], spend: wizard.permissions.spend };
    const selector = admit(scoped, 10n * E18);
    assert.equal(selector.ok, false); if (!selector.ok) assert.equal(selector.code, "capability-grant-shape-unconfirmed");

    const high = clone();
    high.calls.push({ to: REBALANCE_ETH }, { to: REBALANCE_CAKE });
    high.spend = [
      { token: REBALANCE_USDC, limit: { $bigint: (75n * E18).toString() }, period: "day" },
      { limit: { $bigint: "50000000000000000" }, period: "day" },
      { token: REBALANCE_WBNB, limit: { $bigint: (100n * E18).toString() }, period: "day" },
      { token: REBALANCE_ETH, limit: { $bigint: (100n * E18).toString() }, period: "day" },
      { token: REBALANCE_CAKE, limit: { $bigint: (100n * E18).toString() }, period: "day" },
    ];
    const admittedHigh = admit(high, 75n * E18);
    assert.equal(admittedHigh.ok, true, admittedHigh.ok ? "" : admittedHigh.code);
  });
});

describe("B2: the wizard grants every strategy token to every job (R4 operator ruling 2026-09-30)", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: Record<string, unknown> };
  const wizard = JSON.parse(readFileSync(new URL("./fixtures/quant/wizard-session-shape.json", import.meta.url), "utf8")) as
    { permissions: { calls: { to: string }[] } };
  const BTCB = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
  const nowMs = (1_800_000_000 - 2 * 86_400) * 1_000;
  const amount = (value: bigint) => ({ $bigint: value.toString() });
  /** The wizard's own calls plus ETH and CAKE, with a day cap for each token and native. */
  const grant = (allocation: bigint) => ({
    calls: [...wizard.permissions.calls, { to: REBALANCE_ETH }, { to: REBALANCE_CAKE }],
    spend: [
      { token: REBALANCE_USDC, limit: amount(allocation), period: "day" },
      { limit: amount(50_000_000_000_000_000n), period: "day" },
      { token: REBALANCE_WBNB, limit: amount(100n * E18), period: "day" },
      { token: REBALANCE_ETH, limit: amount(100n * E18), period: "day" },
      { token: REBALANCE_CAKE, limit: amount(100n * E18), period: "day" },
    ] as Record<string, unknown>[],
  });
  const admit = (permissions: unknown, allocation: bigint) => {
    const parsed = parseSessionPlaintext(JSON.stringify({ ...fixture.session, permissions }));
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.code);
    if (!parsed.ok) throw new Error("session");
    const s = parsed.session;
    const job: QuantJobRecord = {
      id: "prod-basket", status: "ACTIVE", strategyId: "strategy-prod", tradingWalletAddress: getAddress(s.walletAddress),
      allocationUWei: allocation, dailyCapUWei: allocation, termDays: 30, startedAtMs: nowMs - 60_000,
      endsAtMs: s.expiry * 1_000, sessionExpiresAtMs: s.expiry * 1_000, revokedAtMs: null,
    };
    return admitRebalanceSession({ session: s, job, capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE, nowMs });
  };

  it("admits a low-tier job carrying ETH and CAKE, whose plan stays on WBNB", () => {
    for (const allocation of [10n * E18, 74_990_000_000_000_000_000n]) {
      const result = admit(grant(allocation), allocation);
      assert.equal(result.ok, true, result.ok ? "" : result.code);
      if (!result.ok) return;
      assert.equal(result.tier, LOW_TIER);
      assert.equal(result.grantShape, "whole-contract");
      const plan = (usdc: bigint, wbnb: bigint) => planRebalanceLeg({ managed: { USDC: usdc, WBNB: wbnb, ETH: 0n, CAKE: 0n },
        values: { USDC: usdc, WBNB: wbnb, ETH: 0n, CAKE: 0n }, tier: result.tier, takenAssets: new Set(), checkMode: "candidate" });
      const buy = plan(allocation, 0n);
      assert.ok(buy.kind === "buy" && buy.asset === "WBNB");
      const sell = plan(0n, allocation);
      assert.ok(sell.kind === "sell" && sell.asset === "WBNB");
      assert.equal(plan(allocation / 2n, allocation / 2n).kind, "none");
    }
  });

  it("still refuses any other token, in the calls or in the caps", () => {
    const extraCall = grant(10n * E18); extraCall.calls.push({ to: BTCB });
    const excess = admit(extraCall, 10n * E18);
    assert.equal(excess.ok, false); if (!excess.ok) assert.equal(excess.code, "session-grant-excess");
    const extraCap = grant(10n * E18); extraCap.spend.push({ token: BTCB, limit: amount(100n * E18), period: "day" });
    const capExcess = admit(extraCap, 10n * E18);
    assert.equal(capExcess.ok, false); if (!capExcess.ok) assert.equal(capExcess.code, "session-cap-excess");
  });

  it("still requires ETH and CAKE, grant and cap, at the high tier", () => {
    const admitted = admit(grant(75n * E18), 75n * E18);
    assert.equal(admitted.ok, true, admitted.ok ? "" : admitted.code);
    for (const token of [REBALANCE_ETH, REBALANCE_CAKE]) {
      const noCall = grant(75n * E18); noCall.calls = noCall.calls.filter((row) => row.to !== token);
      const missingGrant = admit(noCall, 75n * E18);
      assert.equal(missingGrant.ok, false, token); if (!missingGrant.ok) assert.equal(missingGrant.code, "session-missing-grant-approve", token);
      const noCap = grant(75n * E18); noCap.spend = noCap.spend.filter((row) => row["token"] !== token);
      const missingCap = admit(noCap, 75n * E18);
      assert.equal(missingCap.ok, false, token); if (!missingCap.ok) assert.equal(missingCap.code, "session-cap-missing", token);
    }
  });

  it("refuses a repeated ETH or CAKE call and a repeated token and period cap", () => {
    for (const token of [REBALANCE_ETH, REBALANCE_CAKE]) {
      const twice = grant(10n * E18); twice.calls.push({ to: token });
      const duplicateCall = admit(twice, 10n * E18);
      assert.equal(duplicateCall.ok, false, token); if (!duplicateCall.ok) assert.equal(duplicateCall.code, "session-grant-duplicate", token);
      const repeated = grant(10n * E18); repeated.spend.push({ token, limit: amount(50n * E18), period: "day" });
      const duplicateCap = admit(repeated, 10n * E18);
      assert.equal(duplicateCap.ok, false, token); if (!duplicateCap.ok) assert.equal(duplicateCap.code, "session-cap-duplicate-period", token);
    }
  });

  it("admits a low-tier grant whose ETH cap, CAKE cap or both are absent, because those tokens are never traded", () => {
    for (const absent of [[REBALANCE_ETH], [REBALANCE_CAKE], [REBALANCE_ETH, REBALANCE_CAKE]]) {
      const capped = grant(10n * E18);
      capped.spend = capped.spend.filter((row) => !absent.some((token) => row["token"] === token));
      const result = admit(capped, 10n * E18);
      assert.equal(result.ok, true, result.ok ? "" : result.code);
    }
  });

  /**
   * The real production dependencies over a mocked reader, RPC and relay, for a session granted with `permissions`
   * exactly as given (never reordered). Every token the two tiers trade has a 1:1 pair with every other.
   */
  function chainFor(allocation: bigint, permissions: unknown) {
    const realNowMs = Date.now();
    const expiry = Math.floor(realNowMs / 1_000) + 2 * 86_400;
    const parsed = parseSessionPlaintext(JSON.stringify({ ...fixture.session, expiry, permissions }));
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.code);
    if (!parsed.ok) throw new Error("session");
    const session = parsed.session;
    const wallet = getAddress(session.walletAddress);
    const job: QuantJobRecord = {
      id: "prod-chain", status: "ACTIVE", strategyId: "strategy-prod", tradingWalletAddress: wallet,
      allocationUWei: allocation, dailyCapUWei: allocation, termDays: 30, startedAtMs: realNowMs - 1_000,
      endsAtMs: expiry * 1_000, sessionExpiresAtMs: expiry * 1_000, revokedAtMs: null,
    };
    const finalized = { number: 100n, hash: HASH, timestampSec: BigInt(Math.floor(realNowMs / 1_000)) };
    const tokens = [REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_USDT, REBALANCE_ETH, REBALANCE_CAKE];
    const pairRows = new Map<string, { address: `0x${string}`; token0: `0x${string}`; token1: `0x${string}` }>();
    for (let i = 0; i < tokens.length; i += 1) for (let j = i + 1; j < tokens.length; j += 1) {
      pairRows.set([tokens[i]!, tokens[j]!].sort().join(":").toLowerCase(),
        { address: getAddress(`0x${(i * 5 + j).toString(16).padStart(2, "0").repeat(20)}`), token0: tokens[i]!, token1: tokens[j]! });
    }
    const readerWith = (balances: Record<string, bigint>) => ({
      chainId: async () => 56, finalizedBlock: async () => finalized, blockAt: async () => finalized,
      tokenBalanceAtHash: async (token: `0x${string}`) => balances[getAddress(token)] ?? 0n,
      nativeBalanceAtHash: async () => 10n ** 16n, gasPriceWei: async () => 50_000_000n,
      getPair: async (_factory: `0x${string}`, from: `0x${string}`, to: `0x${string}`) => pairRows.get([from, to].sort().join(":").toLowerCase())!.address,
      pairToken1: async (address: `0x${string}`) => [...pairRows.values()].find((pair) => pair.address === address)!.token1,
      reservesAtHash: async (address: `0x${string}`, blockHash: Hex) => {
        const pair = [...pairRows.values()].find((item) => item.address === address)!;
        return { token0: pair.token0, reserve0: 1_000_000n * E18, reserve1: 1_000_000n * E18, blockHash };
      },
      quoteV2AmountsAtHash: async (_router: `0x${string}`, path: readonly `0x${string}`[], value: bigint) => path.map(() => value),
    } as unknown as QuantChainReader);
    const provider = { readSpendInfos: async () => session.permissions.spend.map((cap) => ({
      token: cap.token ?? null, period: cap.period, periodCode: 2, limitWei: cap.limit, currentSpentWei: 0n })) } as unknown as WalletProvider;
    const depsFor = (reader: QuantChainReader, onRevalidationRefusal?: (reason: RebalanceRevalidationRefusal) => void) => buildQuantRebalanceWorkerDeps({
      config: { chainId: 56, databaseUrl: "", envelopeKey: "", apiKey: "", agentId: "prod", strategyId: job.strategyId,
        apiBaseUrl: "https://offline.invalid", rpcUrls: ["https://offline.invalid"], intervalMs: 300_000 },
      capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE, store: {} as MemoryQuantRebalanceStore,
      claims: {} as MemoryQuantWalletClaimStore, journal: {} as ExecutionJournal, transport: {} as FileQuantTransport,
      reader, provider, keypair: {} as never, ...(onRevalidationRefusal === undefined ? {} : { onRevalidationRefusal }) });
    return { session, wallet, expiry, job, finalized, readerWith, depsFor };
  }

  /** Answers the key-store, account and relay calls admission and fee quoting make. */
  async function withRelay<T>(chain: ReturnType<typeof chainFor>, work: () => Promise<T>): Promise<T> {
    const { session, wallet, expiry } = chain;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async (_request, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string;
        params: [{ data?: Hex; calls?: { to: `0x${string}`; data: Hex; value: Hex }[] }] };
      let result: unknown;
      if (body.method === "eth_call") {
        const data = body.params[0].data!;
        try {
          decodeFunctionData({ abi: KEYSTORE_ABI, data });
          result = encodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "isValidKey", result: true });
        } catch {
          const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data });
          result = decoded.functionName === "getKeys"
            ? encodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "getKeys", result: [[{ expiry, keyType: 0, isSuperAdmin: false,
              publicKey: session.publicKey }], [accountKeyHashForAddress(publicKeyToAddress(session.publicKey))]] })
            : encodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "canExecute", result: true });
        }
      } else if (body.method === "wallet_getCapabilities") {
        const contract = { address: QUANT_ORCHESTRATOR_56 };
        result = { "0x38": { contracts: { accountImplementation: contract, accountProxy: contract,
          legacyAccountImplementations: [], legacyOrchestrators: [], orchestrator: contract, simulator: contract },
          fees: { quoteConfig: { rateTtl: 120, ttl: 120 }, recipient: wallet, tokens: [] } } };
      } else {
        const calls = body.params[0].calls!;
        result = { capabilities: {}, context: { quote: { hash: `0x${"12".repeat(32)}`,
          r: `0x${"13".repeat(32)}`, s: `0x${"14".repeat(32)}`, ttl: Math.floor(Date.now() / 1_000) + 120,
          quotes: [{ chainId: "0x38", ethPrice: "0x1", extraPayment: "0x0", feeTokenDeficit: "0x0",
            intent: { combinedGas: "0x1", encodedFundTransfers: [], encodedPreCalls: [], eoa: wallet,
              executionData: encodeLpFinalCallsV1(calls.map((call) => ({ to: call.to, data: call.data,
                value: BigInt(call.value) }))), expiry: "0x0", funder: "0x0000000000000000000000000000000000000000", funderSignature: "0x",
              isMultichain: false, nonce: "0x1", payer: wallet, paymentAmount: "0x193d889278c0",
              paymentMaxAmount: "0x193d889278c0", paymentRecipient: wallet, paymentSignature: "0x",
              paymentToken: "0x0000000000000000000000000000000000000000", settler: wallet,
              settlerContext: "0x", signature: "0x", supportedAccountImplementation: wallet },
            nativeFeeEstimate: { maxFeePerGas: "0x2faf080", maxPriorityFeePerGas: "0x1" },
            orchestrator: QUANT_ORCHESTRATOR_56, paymentTokenDecimals: 18, txGas: "0x683cb" }] } },
          digest: `0x${"15".repeat(32)}`, key: null, signature: "0x",
          typedData: { domain: {}, message: {}, primaryType: "Intent", types: {} } };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
    };
    try { return await work(); } finally { globalThis.fetch = priorFetch; }
  }

  it("prepares a fee quote for the wizard's own unsorted grant order, at both tiers", async () => {
    for (const [allocation, tier] of [[10n * E18, LOW_TIER], [75n * E18, HIGH_TIER]] as const) {
      const permissions = grant(allocation);
      const targets = permissions.calls.map((row) => row.to.toLowerCase());
      assert.notDeepEqual(targets, [...targets].sort(), "the fixture must keep the wizard's order");
      const chain = chainFor(allocation, permissions);
      const admitted = await withRelay(chain, () => chain.depsFor(chain.readerWith({ [REBALANCE_USDC]: allocation })).admitChain({
        job: chain.job, session: chain.session, grantShape: "whole-contract", tier, capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE }));
      assert.equal(admitted.ok, true, admitted.ok ? "" : admitted.code);
    }
  });

  it("keeps a low-tier job's pre-existing ETH and CAKE protected, and a later foreign transfer refuses planning", async () => {
    const allocation = 10n * E18;
    const held = { ETH: 3n * E18, CAKE: 7n * E18 };
    const baseline = { [REBALANCE_USDC]: allocation, [REBALANCE_ETH]: held.ETH, [REBALANCE_CAKE]: held.CAKE };
    const chain = chainFor(allocation, grant(allocation));
    await withRelay(chain, async () => {
      const admitted = await chain.depsFor(chain.readerWith(baseline)).admitChain({ job: chain.job, session: chain.session,
        grantShape: "whole-contract", tier: LOW_TIER, capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE });
      assert.equal(admitted.ok, true, admitted.ok ? "" : admitted.code);
      if (!admitted.ok) return;
      // Only the allocation is managed; everything else the wallet already held, ETH and CAKE included, is protected.
      assert.deepEqual(admitted.protectedBalances, { USDC: 0n, WBNB: 0n, ETH: held.ETH, CAKE: held.CAKE, USDT: 0n });
      const encode = (vector: object) => JSON.stringify(vector, (_key, value: unknown) =>
        typeof value === "bigint" ? { $bigint: value.toString() } : value);
      const row: QuantRebalanceJobRow = { ...storedRow({ jobId: chain.job.id, profileId: CAPABILITY_ID, status: "admitted" }),
        tradingWallet: chain.wallet, endsAtMs: chain.expiry * 1_000, sessionExpirySec: chain.expiry, protectedBaselineJson: encode(admitted.protectedBalances) };
      const portfolio = (balances: Record<string, bigint>) => chain.depsFor(chain.readerWith(balances)).readPortfolio({ job: row, tier: LOW_TIER, nowMs: Date.now() });
      const untouched = await portfolio(baseline);
      assert.equal(untouched.ok, true, untouched.ok ? "" : untouched.code);
      if (!untouched.ok) return;
      assert.equal(untouched.observation.values.ETH, 0n);
      assert.equal(untouched.observation.values.CAKE, 0n);
      const leg = planRebalanceLeg({ managed: row.managed!, values: untouched.observation.values, tier: LOW_TIER,
        takenAssets: new Set(), checkMode: "candidate" });
      assert.ok(leg.kind === "buy" && leg.asset === "WBNB");
      for (const token of [REBALANCE_ETH, REBALANCE_CAKE]) {
        const foreign = await portfolio({ ...baseline, [token]: (baseline as Record<string, bigint>)[token]! + 1n });
        assert.deepEqual(foreign, { ok: false, code: "external-activity" }, token);
      }
    });
  });

  it("re-prices from a stored descriptor in the wizard's order, and refuses one whose rules or caps differ from its projection", async () => {
    const allocation = 10n * E18;
    const chain = chainFor(allocation, grant(allocation));
    const descriptor = chain.session.permissions;
    const projection = projectGrantedPermissions(descriptor, { expiry: chain.expiry, nowSeconds: Math.floor(Date.now() / 1_000),
      termDays: 30, walletAddress: chain.wallet });
    assert.equal(projection.ok, true);
    if (!projection.ok) return;
    const zero = { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n };
    // Its own digest is recorded for each variant, so only the comparison with the projection can refuse it.
    const rowFor = (stored: typeof descriptor): QuantRebalanceJobRow => ({
      ...storedRow({ jobId: chain.job.id, profileId: CAPABILITY_ID, status: "admitted" }),
      tradingWallet: chain.wallet, descriptorJson: encodeJsonbParam(stored), projectionJson: encodeJsonbParam(projection.spec),
      sessionPublicKey: chain.session.publicKey, sessionExpirySec: chain.expiry, permissionsDigest: permissionsDigest(stored),
      projectionDigest: specDigest(projection.spec), protectedBaselineJson: encodeJsonbParam(zero),
    });
    const now = Date.now();
    const action = { asset: "WBNB", side: "buy", sequence: 1n, path: [REBALANCE_USDC, REBALANCE_WBNB], amountInWei: allocation / 2n,
      minOutWei: 0n, deadlineSec: Math.floor(now / 1_000) + 600, quoteBlockNumber: 100n, quoteObservedAtMs: now,
      gasEvidenceJson: JSON.stringify({ feeQuoteExpiresAtSec: Math.floor(now / 1_000) + 60, feeQuoteObservedAtMs: now,
        feeQuoteCreatedAtMs: now, requiredNativeWei: E18.toString() }) } as unknown as QuantRebalanceActionRow;
    const revalidate = async (stored: typeof descriptor) => {
      const reasons: RebalanceRevalidationRefusal[] = [];
      const deps = chain.depsFor(chain.readerWith({ [REBALANCE_USDC]: allocation }), (reason) => { reasons.push(reason); });
      const ok = await withRelay(chain, () => deps.revalidatePlan({ job: rowFor(stored), action, finalized: chain.finalized }));
      return { ok, reasons };
    };
    assert.deepEqual(await revalidate(descriptor), { ok: true, reasons: [] });
    // The wizard lists USDC twice, and its first cap is USDC.
    const usdcRule = descriptor.calls.findIndex((row) => row.to?.toLowerCase() === REBALANCE_USDC.toLowerCase());
    const firstCap = (change: object) => descriptor.spend.map((cap, index) => index === 0 ? { ...cap, ...change } : cap);
    const variants: Record<string, typeof descriptor> = {
      "an extra rule": { ...descriptor, calls: [...descriptor.calls, { to: getAddress(BTCB) }] },
      "a missing rule": { ...descriptor, calls: descriptor.calls.slice(0, -1) },
      "one of the two USDC rules removed": { ...descriptor, calls: descriptor.calls.filter((_row, index) => index !== usdcRule) },
      "a third USDC rule": { ...descriptor, calls: [...descriptor.calls, descriptor.calls[usdcRule]!] },
      "a repeated CAKE rule": { ...descriptor, calls: [...descriptor.calls, descriptor.calls.at(-1)!] },
      "a different cap limit": { ...descriptor, spend: firstCap({ limit: descriptor.spend[0]!.limit + 1n }) },
      "a different cap period": { ...descriptor, spend: firstCap({ period: "week" }) },
      "a different cap token": { ...descriptor, spend: firstCap({ token: getAddress(BTCB) }) },
      "an extra cap": { ...descriptor, spend: [...descriptor.spend, { token: getAddress(BTCB), limit: 1n, period: "day" }] },
      "a missing cap": { ...descriptor, spend: descriptor.spend.slice(0, -1) },
      "an extra descriptor key": { ...descriptor, unexpected: true } as unknown as typeof descriptor,
      "an extra rule key": { ...descriptor, calls: descriptor.calls.map((row, index) => index === 0 ? { ...row, unexpected: true } : row) } as unknown as typeof descriptor,
      "an extra cap key": { ...descriptor, spend: firstCap({ unexpected: true }) } as unknown as typeof descriptor,
    };
    for (const [name, stored] of Object.entries(variants)) {
      assert.deepEqual(await revalidate(stored), { ok: false, reasons: ["route-or-fee-unavailable"] }, name);
    }
  });
});

describe("B3: the exit gas-equivalent ceiling", () => {
  it("rounds the observed two-hop maximum up and pins the reserve arithmetic and its floor boundary", () => {
    const observedTwoHopPaymentMax = 33_064_915_000_000n;
    const gasPrice = 50_000_000n;
    // 661,298.3 units: 661,298 is one unit short, 661,299 is the first integer that covers it.
    assert.ok(661_298n * gasPrice < observedTwoHopPaymentMax);
    assert.ok(661_299n * gasPrice >= observedTwoHopPaymentMax);
    const units = PRODUCTION_REBALANCE_CAPABILITY_PROFILE.maximumExitGasUnits;
    assert.ok(units > 661_299n);
    assert.equal(ceilDiv(observedTwoHopPaymentMax * REBALANCE_NATIVE_FEE_PAD_BPS, BPS), 49_597_372_500_000n);
    const reserve = (gasPriceWei: bigint) => requiredNativeReserve({ side: "buy", ownSolvencyWei: 49_597_372_500_000n,
      gasPriceWei, maximumExitGasUnits: units, managed: { WBNB: 1n, ETH: 0n, CAKE: 0n }, asset: "ETH", resultingQuantityWei: 1n });
    // One held position plus the new one: two future exits of 700,000 x 50,000,000 x 1.5 = 52.5e12 each.
    assert.equal(reserve(gasPrice), 49_597_372_500_000n + 2n * 52_500_000_000_000n);
    // The 3e13 floor binds at 28,571,428 wei/gas and is exceeded one wei of gas price later.
    assert.equal(reserve(28_571_428n), 49_597_372_500_000n + 2n * 30_000_000_000_000n);
    assert.equal(reserve(28_571_429n), 49_597_372_500_000n + 2n * 30_000_000_450_000n);
  });
});

describe("B4: evidence digests", () => {
  it("are the keccak256 of the committed evidence document, which is -text and labels its sections", () => {
    const bytes = readFileSync(EVIDENCE);
    assert.equal(bytes.includes(13), false, "the document must hold LF bytes only");
    const digest = keccak256(bytes);
    assert.equal(digest, G1_EVIDENCE_DIGEST);
    assert.equal(PRODUCTION_REBALANCE_CAPABILITY_PROFILE.indexingEvidenceDigest, digest);
    assert.equal(PRODUCTION_REBALANCE_CAPABILITY_PROFILE.reportEvidenceDigest, digest);
    assert.notEqual(digest, ZERO_HASH);
    const text = bytes.toString("utf8");
    assert.ok(text.includes("## (a) Operator-relayed TermiX answers, 2026-09-28"));
    assert.ok(text.includes("paraphrase relayed by the operator, not verbatim") || text.includes("Paraphrase relayed by the operator, not verbatim"));
    assert.ok(text.includes("## (b) Chain rehearsal evidence"));
    assert.ok(text.includes("## (c) Platform acceptance"));
    assert.ok(text.includes("pending — first pilot job (G3 amendment)"));
    const attributes = readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");
    assert.ok(/^\*\*\/QUANT-REBALANCING-G1-EVIDENCE\.md -text$/mu.test(attributes.replaceAll("\r\n", "\n")));
  });
});

describe("B5: the production validator", () => {
  const config = PRODUCTION_EXPANDED_CONFIG_PROFILE;
  const capability = PRODUCTION_REBALANCE_CAPABILITY_PROFILE;

  it("accepts the reviewed pair and both registries", () => {
    assert.doesNotThrow(() => assertProductionRebalanceProfiles(config, capability));
    assert.doesNotThrow(() => assertProductionRebalanceRegistries(QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES));
  });

  it("refuses each forbidden field", () => {
    const registries = (c: QuantExpandedConfigProfile, k: QuantRebalanceCapabilityProfile, extra: readonly QuantRebalanceCapabilityProfile[] = []) =>
      () => assertProductionRebalanceRegistries([c], [k, ...extra]);
    const withCapability = (patch: Partial<QuantRebalanceCapabilityProfile>): QuantRebalanceCapabilityProfile => ({ ...capability, ...patch });
    const reserved = ["g2-file-direct-wbnb-v1", "quant-rebalance-g2-high75-finite-v2", "g2-file-capture-bf3d32b1-v1",
      "g2-anything", "quant-rebalance-g2-anything", ""];
    for (const id of reserved) {
      assert.throws(registries(config, withCapability({ id })), /production-profile-id-reserved/u, id);
      assert.throws(() => assertProductionRebalanceRegistries([{ ...config, id }], []), /production-profile-id-reserved/u, id);
    }
    for (const field of ["indexingEvidenceDigest", "reportEvidenceDigest"] as const) {
      assert.throws(registries(config, withCapability({ [field]: ZERO_HASH })), /production-profile-digest-invalid/u, field);
      assert.throws(registries(config, withCapability({ [field]: "0x1234" as Hex })), /production-profile-digest-invalid/u, field);
    }
    assert.throws(() => assertProductionRebalanceRegistries([{ ...config, capturedEvidenceDigest: ZERO_HASH }], []), /production-profile-digest-invalid/u);
    assert.throws(registries(config, withCapability({ wireVersion: "quant-job-v1-file" })), /production-profile-wire-invalid/u);
    assert.throws(registries(config, withCapability({ wireVersion: "fixture-v1" })), /production-profile-wire-invalid/u);
    assert.throws(registries(config, withCapability({ capturedConfigProfileId: "another-config" })), /production-profile-config-mismatch/u);
    assert.throws(registries(config, withCapability({ executionRoutes: [] })), /production-profile-routes-invalid/u);
    assert.throws(registries(config, withCapability({ referenceRoutes: [] })), /production-profile-routes-invalid/u);
    assert.throws(registries(config, withCapability({ maximumExitGasUnits: 0n })), /production-profile-routes-invalid/u);
    assert.throws(registries(config, withCapability({ maximumExitGasUnits: -1n })), /production-profile-routes-invalid/u);
    assert.throws(registries(config, capability, [capability]), /production-profile-id-duplicate/u);
    assert.throws(() => assertProductionRebalanceRegistries([config, config], []), /production-profile-id-duplicate/u);
  });

  it("refuses any pair that is not reference-equal to the registry entries", () => {
    const file = loadG2FileProfiles();
    const finite = loadG2FileProfiles(true);
    assert.throws(() => assertProductionRebalanceProfiles(file.config, file.capability), /production-profile-id-reserved/u);
    assert.throws(() => assertProductionRebalanceProfiles(finite.config, finite.capability), /production-profile-id-reserved/u);
    // A renamed zero-sentinel file profile keeps a non-reserved id and is still refused by the sentinel and wire checks.
    const renamed = { ...file.capability, id: "renamed-production-looking", capturedConfigProfileId: config.id };
    assert.throws(() => assertProductionRebalanceProfiles(config, renamed), /production-profile-digest-invalid/u);
    const renamedWire = { ...renamed, indexingEvidenceDigest: HASH, reportEvidenceDigest: HASH };
    assert.throws(() => assertProductionRebalanceProfiles(config, renamedWire), /production-profile-wire-invalid/u);
    // Everything valid, but a copy: registered by value, not by reference.
    assert.throws(() => assertProductionRebalanceProfiles(config, { ...capability }), /production-profile-not-registered/u);
    assert.throws(() => assertProductionRebalanceProfiles({ ...config }, capability), /production-profile-not-registered/u);
  });

  it("keeps the file profiles loadable for the G2 CLI without entering the registries", () => {
    const file = loadG2FileProfiles();
    assert.equal(file.capability.wireVersion, "quant-job-v1-file");
    assert.equal(QUANT_EXPANDED_CONFIG_PROFILES.includes(file.config), false);
    assert.equal(QUANT_REBALANCE_CAPABILITY_PROFILES.includes(file.capability), false);
    assert.equal(findCapabilityProfile(file.capability.id), null);
    assert.equal(loadG2FileProfiles(true).capability.id, G2_FINITE_CAPABILITY_ID);
  });
});

function watchedEnv(values: Record<string, string> = {}) {
  const reads: string[] = [];
  const env = new Proxy(values, {
    get(target, key) { if (typeof key === "string") reads.push(key); return target[key as string]; },
  }) as Record<string, string | undefined>;
  return { env, reads };
}

describe("B5: the production daemon entry", () => {
  const file = loadG2FileProfiles();
  const finite = loadG2FileProfiles(true);
  const sentinel = { ...file.capability, id: "renamed-zero-sentinel", wireVersion: "quant-job-v1" };
  const invalid: readonly (readonly [string, QuantExpandedConfigProfile[], QuantRebalanceCapabilityProfile[]])[] = [
    ["G2 file profiles", [file.config], [file.capability]],
    ["G2 finite profiles", [finite.config], [finite.capability]],
    ["a file capability beside the production config", [PRODUCTION_EXPANDED_CONFIG_PROFILE], [PRODUCTION_REBALANCE_CAPABILITY_PROFILE, file.capability]],
    ["a renamed zero-sentinel profile", [{ ...PRODUCTION_EXPANDED_CONFIG_PROFILE }], [{ ...sentinel, capturedConfigProfileId: PRODUCTION_EXPANDED_CONFIG_PROFILE.id }]],
    // Audit finding 5: field-valid copies of the reviewed profiles are still not the registry entries.
    ["valid-looking unregistered copies of both reviewed profiles", QUANT_EXPANDED_CONFIG_PROFILES.map((profile) => ({ ...profile })),
      QUANT_REBALANCE_CAPABILITY_PROFILES.map((profile) => ({ ...profile }))],
    ["an unregistered copy of the capability profile only", [...QUANT_EXPANDED_CONFIG_PROFILES],
      QUANT_REBALANCE_CAPABILITY_PROFILES.map((profile) => ({ ...profile }))],
  ];

  for (const flag of ["true", "false"] as const) {
    it(`refuses an invalid registry before the flag (${flag}), any credential or any network`, async () => {
      for (const [label, configProfiles, capabilityProfiles] of invalid) {
        const { env, reads } = watchedEnv({ QUANT_REBALANCING_ENABLED: flag });
        await assert.rejects(daemonMain({ env, configProfiles, capabilityProfiles }), /production-profile-/u, label);
        assert.deepEqual(reads, [], `${label}: the environment must not be read before validation`);
      }
    });
  }

  for (const flag of ["true", "false"] as const) {
    it(`re-validates the registry entries at entry, before the flag (${flag}), even after a post-load mutation`, async () => {
      const mutable = PRODUCTION_REBALANCE_CAPABILITY_PROFILE as unknown as { indexingEvidenceDigest: Hex };
      const original = mutable.indexingEvidenceDigest;
      mutable.indexingEvidenceDigest = ZERO_HASH;
      try {
        const { env, reads } = watchedEnv({ QUANT_REBALANCING_ENABLED: flag });
        await assert.rejects(daemonMain({ env }), /production-profile-digest-invalid/u);
        assert.deepEqual(reads, []);
      } finally { mutable.indexingEvidenceDigest = original; }
    });
  }

  it("exits quietly with the flag OFF and reaches credentials only when the flag is ON", async (t) => {
    t.mock.method(console, "log", () => undefined);
    const off = watchedEnv({ QUANT_REBALANCING_ENABLED: "false" });
    await daemonMain({ env: off.env });
    assert.deepEqual([...new Set(off.reads)], ["QUANT_REBALANCING_ENABLED"]);
    const on = watchedEnv({ QUANT_REBALANCING_ENABLED: "true" });
    await assert.rejects(daemonMain({ env: on.env }), /EXECUTION_NETWORK=mainnet/u);
    assert.deepEqual([...new Set(on.reads)].sort(), ["EXECUTION_NETWORK", "QUANT_REBALANCING_ENABLED"]);
  });

  it("requires a registered pair at boot before any read, and keeps the G2 file branch explicit", async () => {
    const reachedReader = new Error("reader-reached");
    const ports = {
      config: { chainId: 56 }, transport: {}, provider: {}, keypair: {},
      reader: { chainId: async () => { throw reachedReader; } },
    } as unknown as Parameters<typeof assertQuantRebalanceBoot>[0];
    // Production composition: a file capability with no explicit config profile never reaches a read.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: file.capability }), /production-profile-not-registered/u);
    // A copy of the production capability is not a registry entry.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: { ...PRODUCTION_REBALANCE_CAPABILITY_PROFILE } }),
      /production-profile-not-registered/u);
    // A registered capability can never be paired with an override config.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE,
      configProfile: { ...PRODUCTION_EXPANDED_CONFIG_PROFILE } }), /production-profile-not-registered/u);
    // The production pair passes the guard and proceeds to its first read.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: PRODUCTION_REBALANCE_CAPABILITY_PROFILE }), (error) => error === reachedReader);
    // The G2 file branch (explicit config profile, file capability) is unchanged.
    await assert.rejects(assertQuantRebalanceBoot({ ...ports, capabilityProfile: file.capability, configProfile: file.config }), (error) => error === reachedReader);
  });
});

/* -------------------------------------------------------------------------- */
/* The worker boundary: R3.E                                                   */
/* -------------------------------------------------------------------------- */

const WALLET = getAddress("0x1000000000000000000000000000000000000001");
const NOW = 1_900_000_000_000;
const PROD_STRATEGY = "strategy-prod";

function storedRow(input: { readonly jobId: string; readonly profileId: string; readonly status: QuantRebalanceJobRow["status"];
  readonly allocationWei?: bigint; readonly startOffsetMs?: number; readonly strategyId?: string; readonly digestOf?: string }): QuantRebalanceJobRow {
  const allocationWei = input.allocationWei ?? 10n * E18;
  const decision = rebalanceTierForProfile(allocationWei, input.profileId);
  assert.equal(decision.ok, true);
  if (!decision.ok) throw new Error("tier");
  const startedAtMs = NOW - 3_600_000 - (input.startOffsetMs ?? 0);
  const endsAtMs = startedAtMs + 30 * 86_400_000;
  const strategyId = input.strategyId ?? PROD_STRATEGY;
  const facts = { capabilityProfileId: input.profileId, jobId: input.jobId, strategyId, allocationWei, tier: decision.tier,
    startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs };
  const projection = rebalanceJobPolicyProjection(facts);
  const digest = rebalanceJobPolicyDigest(input.digestOf === undefined ? facts : { ...facts, jobId: input.digestOf });
  return {
    jobId: input.jobId, strategyId, tradingWallet: WALLET, allocationWei, dailyCapWei: allocationWei, termDays: 30,
    startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs, revokedAtMs: null, platformStatus: "ACTIVE", status: input.status,
    wireJson: "{}", wireDigest: HASH, envelopeJson: null, envelopeId: "env", admittedAtMs: startedAtMs,
    policyJson: encodeJsonbParam(projection), policyDigest: digest, tier: decision.tier.id, sessionPublicKey: `0x${"1".repeat(130)}` as Hex,
    sessionExpirySec: Math.floor(endsAtMs / 1_000), permissionsDigest: HASH, projectionDigest: HASH, descriptorJson: "{}",
    projectionJson: "{}", capRowsJson: "[]", claimGeneration: 1n, baselineBlock: 1n, baselineHash: HASH, baselineAtMs: startedAtMs,
    actualBaselineJson: null, protectedBaselineJson: null, managed: { USDC: allocationWei, WBNB: 0n, ETH: 0n, CAKE: 0n },
    costBasis: { WBNB: 0n, ETH: 0n, CAKE: 0n }, accountingRev: 1n, checkRev: 1n, nextEligibleSlot: 0, actionSequence: 0n,
    lastDeadlineSec: 0, bootstrapComplete: false, externalActivity: false, holdCode: null, holdEvidenceJson: null,
    reportAttempts: 0, reportPayloadDigest: null, reportResponseStatus: null, reportNotesApplied: null, reportedAtMs: null,
    retiredAtMs: null, retirementEvidenceJson: null, rowVersion: 3, createdAtMs: startedAtMs, updatedAtMs: NOW,
  };
}

/** Every port throws except the two the production row check may use; a call is recorded, never absorbed. */
function guardedDeps(input: { readonly rows: QuantRebalanceJobRow[]; readonly profile: QuantRebalanceCapabilityProfile | null;
  readonly inbox?: readonly string[]; readonly freeRecovery?: boolean }) {
  const calls: string[] = []; const holdWrites: { jobId: string; code: string }[] = [];
  const trap = (name: string) => async (): Promise<never> => { calls.push(name); throw new Error(`port-${name}`); };
  const store = {
    async listWorkableJobs() { return input.rows; },
    async setHold(args: { readonly jobId: string; readonly code: string }) {
      holdWrites.push({ jobId: args.jobId, code: args.code });
      const index = input.rows.findIndex((row) => row.jobId === args.jobId);
      const row = input.rows[index];
      if (row !== undefined) input.rows[index] = { ...row, status: row.status === "discovered" ? "discovered" : "held", holdCode: args.code };
    },
    listUnresolvedActions: input.freeRecovery === true ? async () => [] : trap("store.listUnresolvedActions"),
    discoverJob: trap("store.discoverJob"), getJob: trap("store.getJob"), listActions: trap("store.listActions"),
    listChecks: trap("store.listChecks"), markEnded: trap("store.markEnded"), insertAction: trap("store.insertAction"),
  } as unknown as QuantRebalanceStore;
  const deps = {
    store, claims: { migrationInstalled: async () => true, releaseTerminal: trap("claims.releaseTerminal"),
      claimProvisional: trap("claims.claimProvisional") } as unknown as QuantWalletClaimStore,
    journal: {} as ExecutionJournal, provider: {} as WalletProvider, reader: {} as QuantChainReader,
    keypair: quantKeypairFromSeed(`0x${"77".repeat(32)}`), strategyId: PROD_STRATEGY, agentId: "agent-1",
    capabilityProfile: input.profile, nowMs: () => NOW, intervalMs: 60_000,
    transport: {
      async inbox() { return { ok: true, data: { items: (input.inbox ?? []).map((id) => ({ quantJobId: id, envelopeId: `env-${id}` })), nextCursor: null } }; },
      async job(id: string) { calls.push(`transport.job:${id}`); return { ok: false, code: "unavailable" }; },
      config: trap("transport.config"), agentKey: trap("transport.agentKey"), registerKey: trap("transport.registerKey"),
      trades: trap("transport.trades"), report: trap("transport.report"),
    },
    admitChain: trap("admitChain"), readPortfolio: trap("readPortfolio"), priceLeg: trap("priceLeg"),
    revalidatePlan: trap("revalidatePlan"), readCurrentWire: trap("readCurrentWire"),
    recoverAction: trap("recoverAction"), reportJob: trap("reportJob"),
  } as unknown as QuantRebalanceWorkerDeps;
  return { deps, calls, holdWrites };
}

describe("R3.E: the production worker refuses rows it did not derive", () => {
  const production = PRODUCTION_REBALANCE_CAPABILITY_PROFILE;

  it("holds ended, unresolved, reserved-identity and tampered rows with one write each and no other effect", async () => {
    const rows = [
      storedRow({ jobId: "prod-ended-file", profileId: G2_FILE_CAPABILITY_ID, status: "ended" }),
      storedRow({ jobId: "prod-unresolved-finite", profileId: G2_FINITE_CAPABILITY_ID, status: "admitted", allocationWei: 75n * E18 }),
      storedRow({ jobId: G2_FINITE_JOB.job, profileId: CAPABILITY_ID, status: "admitted" }),
      storedRow({ jobId: "prod-tampered", profileId: CAPABILITY_ID, status: "admitted", digestOf: "another-job" }),
      storedRow({ jobId: "prod-strategy", profileId: CAPABILITY_ID, status: "discovered", strategyId: "self-test-rebalance-g2" }),
    ];
    const { deps, calls, holdWrites } = guardedDeps({ rows, profile: production });
    const report = await runQuantRebalanceWorkerOnce(deps);
    assert.deepEqual(calls, [], "no per-job network, key, recovery, report or money port may be reached");
    assert.deepEqual(holdWrites.map((write) => write.jobId).sort(), rows.map((row) => row.jobId).sort());
    assert.ok(holdWrites.every((write) => write.code === "production-profile-mismatch"));
    assert.equal(report.jobsSeen, 5); assert.equal(report.holds, 5); assert.equal(report.errors, 0);
    // The hold is written once: a second cycle finds it and writes nothing.
    await runQuantRebalanceWorkerOnce(deps);
    assert.equal(holdWrites.length, 5);
    assert.deepEqual(calls, []);
  });

  it("lets two distinct admitted production jobs, with their own correct digests, reach the normal path", async () => {
    const first = storedRow({ jobId: "prod-job-a", profileId: CAPABILITY_ID, status: "admitted" });
    const second = storedRow({ jobId: "prod-job-b", profileId: CAPABILITY_ID, status: "admitted", allocationWei: 75n * E18, startOffsetMs: 7_200_000 });
    assert.notEqual(first.policyDigest, second.policyDigest);
    assert.equal(second.tier, "high");
    const { deps, calls, holdWrites } = guardedDeps({ rows: [first, second], profile: production, freeRecovery: true });
    const report = await runQuantRebalanceWorkerOnce(deps);
    assert.deepEqual(holdWrites, []);
    // The first per-job network read is the TermiX wire refresh; the fake answers "unavailable".
    assert.deepEqual([...calls].sort(), ["transport.job:prod-job-a", "transport.job:prod-job-b"]);
    assert.equal(report.errors, 0);
  });

  it("does not apply to the G2 file composition", async () => {
    const file = loadG2FileProfiles().capability;
    const rows = [storedRow({ jobId: "file-job", profileId: G2_FILE_CAPABILITY_ID, status: "admitted" })];
    const { deps, calls, holdWrites } = guardedDeps({ rows, profile: file, freeRecovery: true });
    await runQuantRebalanceWorkerOnce(deps);
    assert.deepEqual(holdWrites, []);
    assert.deepEqual(calls, ["transport.job:file-job"]);
  });

  it("skips a reserved inbox job before any network read, and reads an ordinary one", async () => {
    const { deps, calls } = guardedDeps({ rows: [], profile: production, inbox: [G2_FINITE_JOB.job, "self-test-rebalance-g2-low10", "ordinary-job"] });
    await runQuantRebalanceWorkerOnce(deps);
    assert.deepEqual(calls, ["transport.job:ordinary-job"]);
    const file = guardedDeps({ rows: [], profile: loadG2FileProfiles().capability, inbox: ["self-test-rebalance-g2-low10"] });
    await runQuantRebalanceWorkerOnce(file.deps);
    assert.deepEqual(file.calls, ["transport.job:self-test-rebalance-g2-low10"]);
  });

  it("admits a discovered production job through the normal path and derives its production policy", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: Record<string, unknown> };
    const wizard = JSON.parse(readFileSync(new URL("./fixtures/quant/wizard-session-shape.json", import.meta.url), "utf8")) as { permissions: unknown };
    const session: Record<string, unknown> = { ...fixture.session, permissions: wizard.permissions };
    const keypair = quantKeypairFromSeed(`0x${"77".repeat(32)}`);
    const envelope = seal(JSON.stringify(session), keypair.publicKey);
    const expiry = Number(session["expiry"]);
    const now = (expiry - 2 * 86_400) * 1_000;
    const allocation = 10n * E18;
    const wire: QuantJobRecord = { id: "prod-discovered", status: "ACTIVE", strategyId: PROD_STRATEGY,
      tradingWalletAddress: getAddress(String(session["walletAddress"])), allocationUWei: allocation, dailyCapUWei: 40n * E18,
      termDays: 30, startedAtMs: now - 1_000, endsAtMs: expiry * 1_000, sessionExpiresAtMs: expiry * 1_000, revokedAtMs: null };
    const claims = new MemoryQuantWalletClaimStore(undefined, true);
    const store = new MemoryQuantRebalanceStore(claims);
    const balances = { USDC: allocation, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n };
    const deps = {
      store, claims, journal: {} as ExecutionJournal, provider: {} as WalletProvider, reader: {} as QuantChainReader, keypair,
      strategyId: PROD_STRATEGY, agentId: "agent-1", capabilityProfile: production, nowMs: () => now, intervalMs: 60_000,
      transport: {
        async inbox() { return { ok: true, data: { items: [{ ...envelope, envelopeId: "env-prod", quantJobId: wire.id }], nextCursor: null } }; },
        async job() { return { ok: true, data: wire }; },
      },
      async admitChain() { return { ok: true, baselineBlock: 100n, baselineHash: HASH, baselineAtMs: now, actualBalances: balances,
        protectedBalances: { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n } }; },
      async readPortfolio() { return { ok: false, code: "portfolio-read-unavailable" }; },
    } as unknown as QuantRebalanceWorkerDeps;
    await runQuantRebalanceWorkerOnce(deps);
    const admitted = await store.getJob(wire.id);
    assert.equal(admitted?.status, "admitted");
    assert.equal(admitted?.tier, "low");
    const expected = rebalanceJobPolicyDigest({ capabilityProfileId: CAPABILITY_ID, jobId: wire.id, strategyId: PROD_STRATEGY,
      allocationWei: allocation, tier: LOW_TIER, startedAtMs: wire.startedAtMs!, endsAtMs: wire.endsAtMs!, sessionExpiresAtMs: wire.sessionExpiresAtMs! });
    assert.equal(admitted?.policyDigest, expected);
    // The next cycle sees its own row as production-conformant: no mismatch hold.
    await runQuantRebalanceWorkerOnce(deps);
    assert.notEqual((await store.getJob(wire.id))?.holdCode, "production-profile-mismatch");
  });
});
