/** FIX1 reproduction: route authorization does not prove remaining token spend capacity.
 * Public RPC/relay fixtures are copied from the builder admission test; no network or durable keys. */
import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, publicKeyToAddress } from "viem/accounts";
import { buildQuantRebalanceWorkerDeps } from "../scripts/quantRebalanceWorkerDeps.js";
import { admitRebalanceSession } from "../src/quant/rebalanceAdmission.js";
import { G2_JOBS, g2SessionSpec, loadG2FileProfiles } from "../src/quant/rebalanceSelftest.js";
import { LOW_TIER, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";
import { checkQuantMeters } from "../src/quant/execute.js";
import { encodeLpFinalCallsV1 } from "../src/lp/preparedIntentWitness.js";
import { QUANT_ORCHESTRATOR_56 } from "../src/quant/receipt.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "../src/wallet/abis.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { WalletProvider } from "../src/core/types.js";
import type { MemoryQuantRebalanceStore } from "../src/store/quantRebalance.js";
import type { MemoryQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import type { ExecutionJournal } from "../src/store/journal.js";
import type { FileQuantTransport } from "../src/quant/selftest.js";

for (const scenario of ["exhausted", "too-small"] as const) test(`audit FIX1: production admission must refuse when the exit spend cap is ${scenario}`, async () => {
  const wallet = getAddress("0x1111111111111111111111111111111111111111");
  const nowMs = Date.now();
  const expiry = Math.floor(nowMs / 1_000) + 2 * 86_400 + 600;
  const signerPrivateKey = generatePrivateKey();
  const publicKey = privateKeyToAccount(signerPrivateKey).publicKey;
  const spec = g2SessionSpec({ allocation: 10, riskCaps: { WBNB: scenario === "too-small" ? 1n : 11n * 10n ** 18n },
    verifiedPreGrantPaymentMaxWei: null, expiresAt: expiry, nowSeconds: Math.floor(nowMs / 1_000), wallet });
  const session = { version: 1 as const, walletAddress: wallet, publicKey, expiry, permissions: {
    calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
      ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
    spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }),
      limit: cap.limit, period: "token" in cap && cap.token?.toLowerCase() === REBALANCE_WBNB.toLowerCase() ? "year" as const : cap.period })),
  } };
  // Inject a non-file profile without changing either empty production registry.
  const profile = { ...loadG2FileProfiles().capability, id: "audit-fix1-production" };
  const job = { id: G2_JOBS[10].job, strategyId: "self-test-rebalance-g2", status: "ACTIVE" as const,
    tradingWalletAddress: wallet, allocationUWei: 10n * 10n ** 18n, dailyCapUWei: 20n * 10n ** 18n,
    termDays: 2, startedAtMs: nowMs - 1_000, endsAtMs: nowMs + 2 * 86_400_000,
    sessionExpiresAtMs: expiry * 1_000, revokedAtMs: null };
  const USDC = getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
  const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
  const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
  const tokens = [USDC, WBNB, USDT];
  const pairRows = new Map<string, { address: `0x${string}`; token0: `0x${string}`; token1: `0x${string}` }>();
  for (let i = 0; i < tokens.length; i += 1) for (let j = i + 1; j < tokens.length; j += 1) {
    const key = [tokens[i]!, tokens[j]!].sort().join(":").toLowerCase();
    pairRows.set(key, { address: getAddress(`0x${String(i * 3 + j).repeat(40)}`),
      token0: tokens[i]!, token1: tokens[j]! });
  }
  const priorFetch = globalThis.fetch;
  try {
    for (const refusal of ["none"] as readonly string[]) {
      let buyPrepares = 0; let exitPrepares = 0;
      globalThis.fetch = async (_request, init) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string;
          params: [{ data?: Hex; calls?: { to: `0x${string}`; data: Hex; value: Hex }[] }] };
        let result: unknown;
        if (body.method === "eth_call") {
          const data = body.params[0].data!;
          try {
            const decoded = decodeFunctionData({ abi: KEYSTORE_ABI, data });
            assert.equal(decoded.functionName, "isValidKey");
            result = encodeFunctionResult({ abi: KEYSTORE_ABI, functionName: "isValidKey", result: true });
          } catch {
            const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data });
            if (decoded.functionName === "getKeys") result = encodeFunctionResult({ abi: ACCOUNT_ABI,
              functionName: "getKeys", result: [[{ expiry, keyType: 0, isSuperAdmin: false, publicKey }],
                [accountKeyHashForAddress(publicKeyToAddress(publicKey))]] });
            else {
              assert.equal(decoded.functionName, "canExecute");
              result = encodeFunctionResult({ abi: ACCOUNT_ABI, functionName: "canExecute",
                result: refusal !== "canExecute" || decoded.args[1].toLowerCase() !== WBNB.toLowerCase() });
            }
          }
        } else if (body.method === "wallet_getCapabilities") {
          const contract = { address: QUANT_ORCHESTRATOR_56 };
          result = { "0x38": { contracts: { accountImplementation: contract, accountProxy: contract,
            legacyAccountImplementations: [], legacyOrchestrators: [], orchestrator: contract, simulator: contract },
            fees: { quoteConfig: { rateTtl: 120, ttl: 120 }, recipient: wallet, tokens: [] } } };
        } else {
          assert.equal(body.method, "wallet_prepareCalls");
          const calls = body.params[0].calls!;
          const sell = calls[0]?.to.toLowerCase() === WBNB.toLowerCase();
          if (sell) { exitPrepares += 1; throw new Error("zero WBNB balance"); }
          buyPrepares += 1;
          result = { capabilities: {}, context: { quote: { hash: `0x${"12".repeat(32)}`,
            r: `0x${"13".repeat(32)}`, s: `0x${"14".repeat(32)}`,
            ttl: Math.floor(Date.now() / 1_000) + 120,
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
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
          { headers: { "content-type": "application/json" } });
      };
      const reader = { chainId: async () => 56,
        finalizedBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` as Hex,
          timestampSec: BigInt(Math.floor(Date.now() / 1_000)) }),
        tokenBalanceAtHash: async (token: `0x${string}`) => token.toLowerCase() === USDC.toLowerCase() ? 10n * 10n ** 18n : 0n,
        nativeBalanceAtHash: async () => 10n ** 16n, gasPriceWei: async () => 50_000_000n,
        getPair: async (_factory: `0x${string}`, from: `0x${string}`, to: `0x${string}`) => {
          if (refusal === "pair" && from.toLowerCase() === WBNB.toLowerCase()
            && to.toLowerCase() === USDC.toLowerCase()) return "0x0000000000000000000000000000000000000000";
          if (refusal === "reference" && from.toLowerCase() === WBNB.toLowerCase()
            && to.toLowerCase() === USDT.toLowerCase()) return "0x0000000000000000000000000000000000000000";
          return pairRows.get([from, to].sort().join(":").toLowerCase())!.address;
        },
        pairToken1: async (address: `0x${string}`) => [...pairRows.values()].find((pair) => pair.address === address)!.token1,
        reservesAtHash: async (address: `0x${string}`, blockHash: Hex) => {
          const pair = [...pairRows.values()].find((item) => item.address === address)!;
          return { token0: pair.token0, reserve0: 1_000_000n * 10n ** 18n,
            reserve1: 1_000_000n * 10n ** 18n, blockHash };
        },
        quoteV2AmountsAtHash: async (_router: `0x${string}`, path: readonly `0x${string}`[], amount: bigint) => {
          if (refusal === "quote" && path[0]?.toLowerCase() === WBNB.toLowerCase()) throw new Error("sell quote unavailable");
          return path.map(() => amount);
        },
      } as unknown as QuantChainReader;
      const provider = { readSpendInfos: async () => session.permissions.spend.map((cap) => ({
        token: "token" in cap ? cap.token : null, period: cap.period, periodCode: cap.period === "year" ? 5 : 2,
        limitWei: cap.limit, currentSpentWei: scenario === "exhausted" && "token" in cap && cap.token?.toLowerCase() === WBNB.toLowerCase() ? cap.limit : 0n })) } as unknown as WalletProvider;
      const deps = buildQuantRebalanceWorkerDeps({ config: { chainId: 56, databaseUrl: "", envelopeKey: "",
        apiKey: "", agentId: "g2", strategyId: job.strategyId, apiBaseUrl: "https://offline.invalid",
        rpcUrls: ["https://offline.invalid"], intervalMs: 300_000 },
        capabilityProfile: refusal === "route" ? { ...profile, executionRoutes: profile.executionRoutes.filter((route) =>
          !route.startsWith(WBNB.toLowerCase())) } : profile,
        store: {} as MemoryQuantRebalanceStore, claims: {} as MemoryQuantWalletClaimStore,
        journal: {} as ExecutionJournal, transport: {} as FileQuantTransport,
        reader, provider, keypair: {} as never });
      assert.equal(admitRebalanceSession({ session: { ...session, signerPrivateKey }, job, capabilityProfile: profile, nowMs }).ok, true, "static session admission accepts this grant");
      const result = await deps.admitChain({ job, session, grantShape: "selector-scoped",
        tier: LOW_TIER, capabilityProfile: deps.capabilityProfile! });
      const sellMeter = await checkQuantMeters({ provider, walletAddress: wallet, publicKey,
        tokenIn: WBNB, amountInWei: 5n * 10n ** 18n, requiredNativeWei: 45_000_000_000_000n });
      assert.equal(sellMeter.ok, false, "the real execution meter predicate refuses the resulting position's exit");
      const buyMeter = await checkQuantMeters({ provider, walletAddress: wallet, publicKey,
        tokenIn: USDC, amountInWei: 5n * 10n ** 18n, requiredNativeWei: 90_000_000_000_000n });
      assert.equal(buyMeter.ok, true, "the buy's meters do not catch missing exit capacity");
      assert.equal(buyPrepares, refusal === "route" || refusal === "canExecute" ? 0 : 1, refusal);
      assert.equal(exitPrepares, 0, refusal);
      assert.equal(result.ok, false, `${refusal}: ${result.ok ? "ok" : result.code}, buyPrepares=${buyPrepares}`);
    }
  } finally { globalThis.fetch = priorFetch; }
});
