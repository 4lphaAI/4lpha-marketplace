/** Production composition for the separately gated rebalancing worker. */
import { createClient, createPublicClient, fallback, getAddress, http, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { prepareCalls } from "porto/viem/RelayActions";
import * as PortoKey from "porto/viem/Key";
import { BNB } from "@altananetwork/sdk";
import { publicKeyToAddress } from "viem/accounts";
import { bsc } from "viem/chains";
import type { ExecutionJournal, JournalResolutionEvidence } from "../src/store/journal.js";
import type { QuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import type { QuantRebalanceStore } from "../src/store/quantRebalance.js";
import type { SessionSpec, WalletCall, WalletProvider } from "../src/core/types.js";
import { sortProviderPermissions, validateSessionSpec, type ProviderPermissions } from "../src/core/session.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import { decodeJsonb } from "../src/store/codec.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "../src/wallet/abis.js";
import type { QuantKeypair } from "../src/quant/envelope.js";
import { publicKeyEquals, QUANT_ENVELOPE_ALGORITHM } from "../src/quant/envelope.js";
import type { QuantChainReader, QuantBlock } from "../src/quant/readers.js";
import type { QuantTransport } from "../src/quant/termix.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import type { QuantRebalanceRuntimeConfig, QuantRebalanceCapabilityProfile, QuantExpandedConfigProfile } from "../src/quant/rebalanceConfig.js";
import {
  assertProductionRebalanceProfiles, findExpandedConfigProfile, normalizeExpandedQuantConfig,
  QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES,
} from "../src/quant/rebalanceConfig.js";
import {
  enumerateRebalanceRoutes, buildRebalanceCalls, evaluateReferenceGuard,
  requiredReferencePath, nextUniqueDeadlineSec, marginalRouteSpot, referencePathMeetsDepth, rebalancePathKey,
  type RebalanceRoute, type RoutePairEvidence,
} from "../src/quant/rebalanceRoutes.js";
import {
  admitRebalanceAllocation, assertUint256, BPS, ceilDiv, G2_FILE_CAPABILITY_ID, G2_FINITE_CAPABILITY_ID,
  G2_FINITE_MAX_GAS_PRICE_WEI, g2PaymentWithinBudget, REBALANCE_FACTORY, REBALANCE_MAX_BLOCK_LAG,
  finitePairedSellRequiredNativeWei,
  REBALANCE_MAX_GAS_PRICE_WEI, REBALANCE_MAX_QUOTE_AGE_MS, REBALANCE_NATIVE_FEE_FLOOR_WEI,
  REBALANCE_NATIVE_FEE_PAD_BPS, REBALANCE_ROUTER, REBALANCE_TOKEN_ADDRESSES, REBALANCE_USDC,
  REBALANCE_WBNB, type RebalanceRiskAsset,
  requiredNativeReserve,
} from "../src/quant/rebalancePolicy.js";
import { selectMaximumGrossLiquidation, valueManagedPortfolio } from "../src/quant/rebalancePortfolio.js";
import {
  verifyQuantRebalanceReceipt, verifyQuantRebalanceSubmittedFailure,
  type RebalanceFinalityEvidence, type RebalancePairIdentity,
} from "../src/quant/rebalanceReceipt.js";
import {
  type PortfolioReadResult, type QuantRebalanceWorkerDeps,
  type RebalanceAdmissionEvidenceResult, type RebalancePricedLeg, type RebalanceRecoveryResult,
} from "../src/quant/rebalanceWorker.js";
import type {
  QuantRebalanceActionRow, QuantRebalanceJobRow, RebalanceBalanceVector,
} from "../src/quant/rebalanceTypes.js";
import { rebalanceCanonicalEncode } from "../src/quant/rebalanceCanonical.js";
import { callsDigest } from "../src/quant/receipt.js";
import { fingerprintLpFinalCallsV1, canonicalProviderPermissionsV1 } from "../src/lp/preparedIntentWitness.js";
import { permissionsDigest, specDigest } from "../src/quant/admission.js";
import { projectGrantedPermissions } from "../src/quant/admission.js";
import { verifyQuantPortoFeeQuote, verifyQuantPreparedPublicKey, type QuantVerifiedFeeQuote } from "../src/quant/rebalanceFee.js";
import { buildQuantRebalanceReportPayload } from "../src/quant/rebalanceReporting.js";
import { checkQuantMeters } from "../src/quant/execute.js";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const finiteProfile = (id: string): boolean => id === G2_FINITE_CAPABILITY_ID;
const fileProfile = (id: string): boolean => id === G2_FILE_CAPABILITY_ID || finiteProfile(id);
const profileGasCeiling = (id: string): bigint => finiteProfile(id) ? G2_FINITE_MAX_GAS_PRICE_WEI : REBALANCE_MAX_GAS_PRICE_WEI;
const UINT256_MAX = (1n << 256n) - 1n;

type RouteEvaluation = Readonly<{
  route: RebalanceRoute;
  pairs: readonly RoutePairEvidence[];
  referencePath: readonly Address[];
  referencePairs: readonly RoutePairEvidence[];
  outputWei: bigint;
  gasFeeNativeWei: bigint;
  solvencyNativeWei: bigint;
  gasFeeUsdcWei: bigint;
  netScoreWei: bigint;
  amounts: readonly bigint[];
  evidenceJson: string;
  feeQuote: QuantVerifiedFeeQuote;
  quoteObservedAtMs: number;
}>;

type FeeQuoteReader = (job: QuantRebalanceJobRow, wallet: Address, calls: readonly WalletCall[], nowMs: number) => Promise<QuantVerifiedFeeQuote | null>;

export type RebalanceRevalidationRefusal =
  | "reader-capability-unavailable" | "quote-block-lag" | "quote-age"
  | "fee-evidence-invalid" | "fee-quote-expired" | "fee-quote-age"
  | "expected-balance-invalid" | "balance-mismatch" | "finalized-hash-mismatch"
  | "gas-price-unavailable" | "route-or-fee-unavailable" | "g2-payment-budget"
  | "route-changed" | "min-out-shortfall" | "native-reserve-evidence-invalid"
  | "native-reserve-increased" | "g2-required-native-invalid"
  | "g2-protected-native-unavailable" | "g2-protected-native-shortfall"
  | "g2-protected-u-mismatch" | "read-error";

function jsonBigints(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
function digest(value: unknown): Hex { return keccak256(stringToBytes(rebalanceCanonicalEncode(value))); }
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function bigintFromJson(value: unknown): bigint | null {
  const decoded = decodeJsonb(value);
  if (typeof decoded === "bigint") return decoded;
  if (typeof decoded === "string" && /^(0|[1-9][0-9]*)$/u.test(decoded)) return BigInt(decoded);
  if (typeof decoded === "number" && Number.isSafeInteger(decoded) && decoded >= 0) return BigInt(decoded);
  return null;
}
function numberOrUndefined(value: unknown): number | null {
  const decoded = decodeJsonb(value);
  if (typeof decoded === "number" && Number.isSafeInteger(decoded)) return decoded;
  if (typeof decoded === "string" && /^(0|[1-9][0-9]*)$/u.test(decoded)) return Number(decoded);
  return null;
}

function parseBalanceVector(raw: string | null): RebalanceBalanceVector | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const read = (asset: string): bigint | null => {
      const item = value[asset];
      const number = typeof item === "object" && item !== null && "$bigint" in item
        ? BigInt(String((item as Record<string, unknown>)["$bigint"])) : typeof item === "bigint" ? item : null;
      return number !== null && number >= 0n && number <= UINT256_MAX ? number : null;
    };
    const USDC = read("USDC"); const WBNB = read("WBNB"); const ETH = read("ETH"); const CAKE = read("CAKE"); const USDT = read("USDT");
    return USDC === null || WBNB === null || ETH === null || CAKE === null || USDT === null
      ? null : { USDC, WBNB, ETH, CAKE, USDT };
  } catch { return null; }
}

function balancesExpected(job: QuantRebalanceJobRow): RebalanceBalanceVector | null {
  const protectedVector = parseBalanceVector(job.protectedBaselineJson);
  if (protectedVector === null || job.managed === null) return null;
  const expected = {
    USDC: protectedVector.USDC + job.managed.USDC,
    WBNB: protectedVector.WBNB + job.managed.WBNB,
    ETH: protectedVector.ETH + job.managed.ETH,
    CAKE: protectedVector.CAKE + job.managed.CAKE,
    USDT: protectedVector.USDT,
  };
  try {
    for (const value of Object.values(expected)) assertUint256(value);
    return expected;
  } catch { return null; }
}

function sameBalances(left: RebalanceBalanceVector, right: RebalanceBalanceVector): boolean {
  return left.USDC === right.USDC && left.WBNB === right.WBNB && left.ETH === right.ETH
    && left.CAKE === right.CAKE && left.USDT === right.USDT;
}

export async function loadPathPairs(reader: QuantChainReader, path: readonly Address[], blockHash: Hex): Promise<readonly RoutePairEvidence[] | null> {
  if (reader.reservesAtHash === undefined || reader.pairToken1 === undefined) return null;
  const pairs: RoutePairEvidence[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = path[index]; const to = path[index + 1];
    if (from === undefined || to === undefined) return null;
    try {
      const address = getAddress(await reader.getPair(REBALANCE_FACTORY, from, to));
      if (address.toLowerCase() === ZERO.toLowerCase()) return null;
      const [reserves, token1Raw] = await Promise.all([
        reader.reservesAtHash(address, blockHash), reader.pairToken1(address),
      ]);
      const token0 = getAddress(reserves.token0); const token1 = getAddress(token1Raw);
      if (reserves.blockHash?.toLowerCase() !== blockHash.toLowerCase()
        || ![from.toLowerCase(), to.toLowerCase()].includes(token0.toLowerCase())
        || ![from.toLowerCase(), to.toLowerCase()].includes(token1.toLowerCase())
        || token0.toLowerCase() === token1.toLowerCase()) return null;
      pairs.push({ address, token0, token1, reserve0: reserves.reserve0,
        reserve1: reserves.reserve1, blockHash });
    } catch { return null; }
  }
  return pairs;
}

function pathIdentity(path: readonly Address[], pairs: readonly RoutePairEvidence[]): readonly RebalancePairIdentity[] | null {
  if (path.length !== pairs.length + 1) return null;
  const result: RebalancePairIdentity[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]; const from = path[index]; const to = path[index + 1];
    if (pair === undefined || from === undefined || to === undefined) return null;
    const token0 = pair.token0; const token1 = pair.token1;
    if (new Set([from.toLowerCase(), to.toLowerCase()]).size !== 2
      || ![from.toLowerCase(), to.toLowerCase()].includes(token0.toLowerCase())
      || ![from.toLowerCase(), to.toLowerCase()].includes(token1.toLowerCase())) return null;
    result.push({ address: pair.address, factory: REBALANCE_FACTORY, derivedAddress: pair.address, token0, token1 });
  }
  return result;
}

async function quoteAmounts(reader: QuantChainReader, path: readonly Address[], amountInWei: bigint, blockHash: Hex): Promise<readonly bigint[] | null> {
  if (reader.quoteV2AmountsAtHash === undefined || amountInWei <= 0n) return null;
  try {
    const amounts = await reader.quoteV2AmountsAtHash(REBALANCE_ROUTER, path, amountInWei, blockHash);
    if (amounts.length !== path.length || amounts[0] !== amountInWei || amounts.some((amount) => amount <= 0n || amount > UINT256_MAX)) return null;
    return amounts;
  } catch { return null; }
}

function routeReferenceJson(route: RebalanceRoute, candidate: readonly RoutePairEvidence[], referencePath: readonly Address[], reference: readonly RoutePairEvidence[], deviation: unknown): string {
  return jsonBigints({ candidatePath: route.path, candidatePairs: candidate, referencePath, referencePairs: reference, deviation });
}

async function evaluateRoutes(input: {
  readonly reader: QuantChainReader;
  readonly profile: QuantRebalanceCapabilityProfile;
  readonly job: QuantRebalanceJobRow;
  readonly wallet: Address;
  readonly asset: RebalanceRiskAsset;
  readonly direction: "buy" | "sell";
  readonly amountInWei: bigint;
  readonly actionSequence: bigint;
  readonly deadlineSec: number;
  readonly block: QuantBlock;
  readonly nowMs: number;
  readonly gasPriceWei: bigint;
  readonly quoteFee: FeeQuoteReader;
}): Promise<readonly RouteEvaluation[]> {
  if (input.profile.maximumExitGasUnits <= 0n || input.gasPriceWei <= 0n
    || input.gasPriceWei > REBALANCE_MAX_GAS_PRICE_WEI) return [];
  const candidateRoutes = enumerateRebalanceRoutes(input.asset, input.direction).filter((route) => {
    const reference = requiredReferencePath(route.path);
    return reference !== null && profileHasPath(input.profile.executionRoutes, route.path)
      && profileHasPath(input.profile.referenceRoutes, reference);
  });
  if (candidateRoutes.length === 0) return [];
  let commonBuyMark: { readonly numerator: bigint; readonly denominator: bigint } | null = null;
  if (input.direction === "buy") {
    const referencePaths = [...new Map(candidateRoutes.map((route) => {
      const reference = requiredReferencePath(route.path)!;
      return [rebalancePathKey(reference), reference] as const;
    })).entries()].sort(([left], [right]) => left.localeCompare(right));
    for (const [, referencePath] of referencePaths) {
      const referencePairs = await loadPathPairs(input.reader, referencePath, input.block.hash);
      if (referencePairs === null || !referencePathMeetsDepth(referencePath, referencePairs, input.block.hash)) continue;
      const spot = marginalRouteSpot(referencePath, referencePairs);
      if (spot !== null) { commonBuyMark = { numerator: spot.denominator, denominator: spot.numerator }; break; }
    }
    if (commonBuyMark === null) return [];
  }
  const gasMark = await loadGasUsdcMark(input.reader, input.profile, input.block.hash);
  if (gasMark === null) return [];
  const result: RouteEvaluation[] = [];
  for (const route of candidateRoutes) {
    const referencePath = requiredReferencePath(route.path);
    if (referencePath === null) continue;
    const [pairs, referencePairs] = await Promise.all([
      loadPathPairs(input.reader, route.path, input.block.hash),
      loadPathPairs(input.reader, referencePath, input.block.hash),
    ]);
    if (pairs === null || referencePairs === null) continue;
    const guard = evaluateReferenceGuard({ candidatePath: route.path, candidatePairs: pairs,
      referencePath, referencePairs, candidateBlockHash: input.block.hash, referenceBlockHash: input.block.hash });
    if (!guard.ok) continue;
    const quoteObservedAtMs = Date.now();
    if (quoteObservedAtMs < input.nowMs || quoteObservedAtMs - input.nowMs > REBALANCE_MAX_QUOTE_AGE_MS) return [];
    const amounts = await quoteAmounts(input.reader, route.path, input.amountInWei, input.block.hash);
    if (amounts === null) continue;
    const outputWei = amounts.at(-1);
    if (outputWei === undefined) continue;
    const built = buildRebalanceCalls({ router: REBALANCE_ROUTER, path: route.path,
      amountInWei: input.amountInWei, quoteOutWei: outputWei, recipient: input.wallet,
      deadlineSec: input.deadlineSec, actionSequence: input.actionSequence });
    const feeQuote = await input.quoteFee(input.job, input.wallet, built.calls, input.nowMs);
    if (feeQuote === null || feeQuote.receivedAtMs < input.nowMs
      || feeQuote.receivedAtMs - quoteObservedAtMs > REBALANCE_MAX_QUOTE_AGE_MS
      || Date.now() - quoteObservedAtMs > REBALANCE_MAX_QUOTE_AGE_MS
      || observedStale(feeQuote.receivedAtMs, Date.now())) continue;
    const gasFeeNativeWei = feeQuote.paymentWei > REBALANCE_NATIVE_FEE_FLOOR_WEI
      ? feeQuote.paymentWei : REBALANCE_NATIVE_FEE_FLOOR_WEI;
    const paddedMax = ceilDiv(feeQuote.paymentMaxWei * REBALANCE_NATIVE_FEE_PAD_BPS, BPS);
    const solvencyNativeWei = paddedMax > REBALANCE_NATIVE_FEE_FLOOR_WEI ? paddedMax : REBALANCE_NATIVE_FEE_FLOOR_WEI;
    const gasFeeUsdcWei = ceilDiv(gasFeeNativeWei * gasMark.numerator, gasMark.denominator);
    const outputValueUsdc = input.direction === "sell" ? outputWei
      : commonBuyMark === null ? null : outputWei * commonBuyMark.numerator / commonBuyMark.denominator;
    if (outputValueUsdc === null) continue;
    const evidenceJson = routeReferenceJson(route, pairs, referencePath, referencePairs, guard);
    result.push({ route, pairs, referencePath, referencePairs, outputWei, gasFeeNativeWei, solvencyNativeWei,
      gasFeeUsdcWei, netScoreWei: outputValueUsdc - gasFeeUsdcWei, amounts, evidenceJson, feeQuote, quoteObservedAtMs });
  }
  if (input.nowMs > 0 && input.block.number < 0n) return [];
  return result.sort((left, right) => left.netScoreWei === right.netScoreWei
    ? left.route.path.length - right.route.path.length || left.route.key.localeCompare(right.route.key)
    : left.netScoreWei > right.netScoreWei ? -1 : 1);
}

function profileHasPath(paths: readonly string[], path: readonly string[]): boolean {
  const wanted = rebalancePathKey(path);
  return paths.some((candidate) => candidate.toLowerCase() === wanted);
}

async function loadGasUsdcMark(reader: QuantChainReader, profile: QuantRebalanceCapabilityProfile, blockHash: Hex): Promise<{ readonly numerator: bigint; readonly denominator: bigint } | null> {
  const path = [REBALANCE_WBNB, REBALANCE_USDC] as const;
  const referencePath = requiredReferencePath(path);
  if (referencePath === null || !profileHasPath(profile.executionRoutes, path)
    || !profileHasPath(profile.referenceRoutes, referencePath)) return null;
  const [pairs, referencePairs] = await Promise.all([
    loadPathPairs(reader, path, blockHash), loadPathPairs(reader, referencePath, blockHash),
  ]);
  if (pairs === null || referencePairs === null || !referencePathMeetsDepth(referencePath, referencePairs, blockHash)) return null;
  const guard = evaluateReferenceGuard({ candidatePath: path, candidatePairs: pairs, referencePath, referencePairs,
    candidateBlockHash: blockHash, referenceBlockHash: blockHash });
  if (!guard.ok) return null;
  return marginalRouteSpot(path, pairs);
}

function parsePersistedCalls(raw: string): readonly WalletCall[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    return parsed.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("call");
      const row = item as Record<string, unknown>;
      if (typeof row["to"] !== "string" || typeof row["data"] !== "string") throw new Error("call");
      return { to: getAddress(row["to"]), value: BigInt(String(row["value"] ?? "0")), data: row["data"] as Hex };
    });
  } catch { return null; }
}

function sameHex(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }

export function buildQuantRebalanceWorkerDeps(input: {
  readonly config: QuantRebalanceRuntimeConfig;
  readonly capabilityProfile: QuantRebalanceCapabilityProfile;
  readonly store: QuantRebalanceStore;
  readonly claims: QuantWalletClaimStore;
  readonly journal: ExecutionJournal;
  readonly transport: QuantTransport;
  readonly reader: QuantChainReader;
  readonly provider: WalletProvider;
  readonly keypair: QuantKeypair;
  readonly signal?: AbortSignal;
  readonly onRevalidationRefusal?: (reason: RebalanceRevalidationRefusal) => void;
}): QuantRebalanceWorkerDeps {
  const publicClient = createPublicClient({ chain: bsc, transport: fallback(input.config.rpcUrls.map((url) => http(url))) });
  const capabilityProfile = input.capabilityProfile;
  const nowMs = Date.now;
  const relayUrl = BNB.relayUrl ?? "";
  if (relayUrl === "") throw new Error("quant-rebalance-relay-unavailable");
  const relayClient = createClient({ chain: bsc, transport: http(new URL(relayUrl).origin) });
  const prepareFeeFromFacts = async (facts: {
    readonly wallet: Address; readonly publicKey: Hex; readonly expiry: number;
    readonly permissions: unknown; readonly spec: SessionSpec;
    readonly permissionsDigest: Hex; readonly projectionDigest: Hex;
  }, calls: readonly WalletCall[]): Promise<QuantVerifiedFeeQuote | null> => {
    try {
      const quotedAtMs = nowMs();
      const nowSec = Math.floor(quotedAtMs / 1_000);
      if (facts.expiry <= nowSec || facts.spec.expiresAt !== facts.expiry) return null;
      const validated = validateSessionSpec(facts.spec, { nowSeconds: nowSec, minSessionSeconds: 0 });
      // The granted descriptor keeps its granter's order (the wizard's is not sorted); the validated form is sorted.
      if (canonicalProviderPermissionsV1(validated)
        !== canonicalProviderPermissionsV1(sortProviderPermissions(facts.permissions as ProviderPermissions))) return null;
      if (permissionsDigest(facts.permissions as ProviderPermissions as Parameters<typeof permissionsDigest>[0]).toLowerCase()
        !== facts.permissionsDigest.toLowerCase()
        || specDigest(facts.spec).toLowerCase() !== facts.projectionDigest.toLowerCase()) return null;
      const key = PortoKey.fromSecp256k1({ publicKey: facts.publicKey, role: "session",
        expiry: facts.expiry, permissions: validated });
      const prepared = await prepareCalls(relayClient, { account: facts.wallet, chain: bsc,
        calls: calls.map((call) => ({ to: getAddress(call.to), value: call.value ?? 0n, data: call.data ?? "0x" })),
        key, feeToken: ZERO });
      const receivedAtMs = nowMs();
      if (!verifyQuantPreparedPublicKey({ preparedKey: prepared.key, publicKey: key.publicKey,
        expiry: facts.expiry, permissions: validated })) return null;
      const quote = prepared.capabilities.quote.quotes[0];
      if (quote === undefined) return null;
      const executionDataHash = fingerprintLpFinalCallsV1(calls).value.executionDataHash;
      return verifyQuantPortoFeeQuote({ quote: { chainId: quote.chainId,
        orchestrator: getAddress(quote.orchestrator), intent: quote.intent as unknown as Readonly<Record<string, unknown>>,
        nativeFeeEstimate: quote.nativeFeeEstimate as unknown as Readonly<Record<string, unknown>>,
        txGas: quote.txGas, extraPayment: quote.extraPayment, ttl: prepared.capabilities.quote.ttl },
        wallet: facts.wallet, expectedKeyHash: PortoKey.hash(key), executionDataHash,
        nowSec: Math.floor(receivedAtMs / 1_000), sessionExpirySec: facts.expiry, quotedAtMs, receivedAtMs });
    } catch { return null; }
  };
  const quoteFee: FeeQuoteReader = async (job, wallet, calls) => {
    if (job.descriptorJson === null || job.projectionJson === null || job.sessionPublicKey === null
      || job.sessionExpirySec === null || job.permissionsDigest === null || job.projectionDigest === null) return null;
    try {
      const permissions = decodeJsonb(JSON.parse(job.descriptorJson) as unknown);
      const specRaw = decodeJsonb(JSON.parse(job.projectionJson) as unknown);
      if (typeof specRaw !== "object" || specRaw === null || Array.isArray(specRaw)) return null;
      return prepareFeeFromFacts({ wallet, publicKey: job.sessionPublicKey, expiry: job.sessionExpirySec,
        permissions, spec: specRaw as SessionSpec, permissionsDigest: job.permissionsDigest,
        projectionDigest: job.projectionDigest }, calls);
    } catch { return null; }
  };

  const deps: QuantRebalanceWorkerDeps = {
    store: input.store, claims: input.claims, journal: input.journal,
    transport: input.transport, provider: input.provider, reader: input.reader, keypair: input.keypair,
    strategyId: input.config.strategyId, agentId: input.config.agentId, capabilityProfile,
    nowMs, intervalMs: input.config.intervalMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    async admitChain({ job, session, tier, capabilityProfile: profile }): Promise<RebalanceAdmissionEvidenceResult> {
      if (await input.reader.chainId() !== 56 || input.provider.readSpendInfos === undefined) return { ok: false, code: "session-chain-unreadable" };
      const wallet = getAddress(job.tradingWalletAddress);
      const keyHash = accountKeyHashForAddress(publicKeyToAddress(session.publicKey));
      const registryKeyHash = keccak256(session.publicKey);
      try {
        if (input.reader.tokenBalanceAtHash === undefined || input.reader.nativeBalanceAtHash === undefined) return { ok: false, code: "baseline-unverified" };
        const admissionReadStarted = nowMs();
        const finalized = await input.reader.finalizedBlock();
        const valid = await publicClient.readContract({ address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI,
          functionName: "isValidKey", args: [wallet, registryKeyHash], blockNumber: finalized.number });
        if (!valid) return { ok: false, code: "session-chain-refused" };
        const [keys, hashes] = await publicClient.readContract({ address: wallet, abi: ACCOUNT_ABI,
          functionName: "getKeys", blockNumber: finalized.number });
        if (!hashes.some((hash) => hash.toLowerCase() === keyHash.toLowerCase())
          || keys.some((key, index) => hashes[index]?.toLowerCase() === keyHash.toLowerCase() && key.isSuperAdmin)) {
          return { ok: false, code: "session-chain-refused" };
        }
        const allocation = admitRebalanceAllocation(job.allocationUWei);
        if (!allocation.ok) return { ok: false, code: allocation.code };
        const required = ["USDC", ...allocation.tier.orderedRiskAssets] as const;
        const initialRiskWeightBps = allocation.tier.orderedRiskAssets.reduce(
          (sum, asset) => sum + (allocation.tier.targetWeightsBps[asset] ?? 0n), 0n);
        const initialUsdcSpendWei = job.allocationUWei * initialRiskWeightBps / BPS;
        const supportedRoutes = (asset: RebalanceRiskAsset, direction: "buy" | "sell") => enumerateRebalanceRoutes(asset, direction).filter((route) => {
          const reference = requiredReferencePath(route.path);
          return reference !== null && profileHasPath(profile.executionRoutes, route.path)
            && profileHasPath(profile.referenceRoutes, reference);
        });
        const projected = projectGrantedPermissions(session.permissions, { expiry: session.expiry,
          nowSeconds: Math.floor(admissionReadStarted / 1_000), termDays: job.termDays, walletAddress: wallet });
        if (!projected.ok) return { ok: false, code: projected.code };
        const feeFacts = { wallet, publicKey: session.publicKey, expiry: session.expiry,
          permissions: session.permissions, spec: projected.spec, permissionsDigest: permissionsDigest(session.permissions),
          projectionDigest: specDigest(projected.spec) };
        const admissionDeadline = nextUniqueDeadlineSec({ nowMs: admissionReadStarted, lastDeadlineSec: 0,
          sessionExpirySec: session.expiry, jobEndMs: job.endsAtMs ?? 0 });
        // Exact calldata authorization is checked for every capability-enabled path in both directions.
        let probeSequence = 1n;
        for (const asset of allocation.tier.orderedRiskAssets) for (const direction of ["buy", "sell"] as const) {
          const routes = supportedRoutes(asset, direction);
          if (routes.length === 0) return { ok: false, code: "capability-route-unavailable" };
          for (const route of routes) {
            const probe = buildRebalanceCalls({ router: REBALANCE_ROUTER, path: route.path,
              amountInWei: 10n ** 18n, quoteOutWei: 10n ** 18n, recipient: wallet, deadlineSec: admissionDeadline,
              actionSequence: probeSequence });
            probeSequence += 1n;
            for (const call of probe.calls) {
              const allowed = await publicClient.readContract({ address: wallet, abi: ACCOUNT_ABI,
                functionName: "canExecute", args: [keyHash, getAddress(call.to), (call.data ?? "0x") as Hex],
                blockNumber: finalized.number });
              if (!allowed) return { ok: false, code: "session-chain-refused" };
            }
          }
        }
        const readings = await input.provider.readSpendInfos({ walletAddress: wallet, publicKey: session.publicKey,
          ...(input.signal === undefined ? {} : { signal: input.signal }) });
        const capRows = session.permissions.spend;
        for (const asset of required) {
          const address = REBALANCE_TOKEN_ADDRESSES[asset];
          const caps = capRows.filter((cap) => cap.token !== undefined && cap.token.toLowerCase() === address.toLowerCase());
          for (const cap of caps) {
            const reading = readings.find((row) => row.token?.toLowerCase() === address.toLowerCase()
              && row.period === cap.period);
            if (reading === undefined || reading.limitWei !== cap.limit || reading.currentSpentWei > cap.limit
              || asset === "USDC" && reading.currentSpentWei + initialUsdcSpendWei > cap.limit) {
              return { ok: false, code: "session-chain-unreadable" };
            }
          }
        }
        const nativeCaps = capRows.filter((cap) => cap.token === undefined);
        for (const cap of nativeCaps) {
          const reading = readings.find((row) => row.token === null && row.period === cap.period);
          if (reading === undefined || reading.limitWei !== cap.limit || reading.currentSpentWei > cap.limit) {
            return { ok: false, code: "session-chain-unreadable" };
          }
        }
        const assets = ["USDC", "WBNB", "ETH", "CAKE", "USDT"] as const;
        const pairs = await Promise.all(assets.map(async (asset) => [asset, await input.reader.tokenBalanceAtHash!(REBALANCE_TOKEN_ADDRESSES[asset], wallet, finalized.hash)] as const));
        const balances = Object.fromEntries(pairs) as unknown as RebalanceBalanceVector;
        const actualBaseline: RebalanceBalanceVector = balances;
        if (actualBaseline.USDC < job.allocationUWei) return { ok: false, code: "baseline-unverified" };
        const protectedBalances: RebalanceBalanceVector = { ...actualBaseline, USDC: actualBaseline.USDC - job.allocationUWei };
        const nativeBalance = await input.reader.nativeBalanceAtHash(wallet, finalized.hash);
        const gasPriceWei = await input.reader.gasPriceWei();
        if (nativeBalance <= 0n || gasPriceWei <= 0n || gasPriceWei > profileGasCeiling(profile.id)
          || profile.maximumExitGasUnits <= 0n) return { ok: false, code: "baseline-unverified" };
        let initialOwnFees = 0n;
        let initialSequence = 1n;
        for (const asset of allocation.tier.orderedRiskAssets) {
          const weight = allocation.tier.targetWeightsBps[asset] ?? 0n;
          const amountInWei = job.allocationUWei * weight / BPS;
          if (amountInWei <= 0n) return { ok: false, code: "initial-route-unavailable" };
          const riskToken = REBALANCE_TOKEN_ADDRESSES[asset];
          const riskCaps = capRows.filter((cap) => cap.token?.toLowerCase() === riskToken.toLowerCase());
          const buyRoutes = supportedRoutes(asset, "buy");
          const viableBuySolvencyFees: bigint[] = [];
          for (const route of buyRoutes) {
            const referencePath = requiredReferencePath(route.path);
            if (referencePath === null) continue;
            const [pairs, referencePairs] = await Promise.all([
              loadPathPairs(input.reader, route.path, finalized.hash), loadPathPairs(input.reader, referencePath, finalized.hash),
            ]);
            if (pairs === null || referencePairs === null) continue;
            const guard = evaluateReferenceGuard({ candidatePath: route.path, candidatePairs: pairs,
              referencePath, referencePairs, candidateBlockHash: finalized.hash, referenceBlockHash: finalized.hash });
            if (!guard.ok) continue;
            const amounts = await quoteAmounts(input.reader, route.path, amountInWei, finalized.hash);
            const out = amounts?.at(-1); if (out === undefined) continue;
            const calls = buildRebalanceCalls({ router: REBALANCE_ROUTER, path: route.path, amountInWei,
              quoteOutWei: out, recipient: wallet, deadlineSec: admissionDeadline, actionSequence: initialSequence });
            const fee = await prepareFeeFromFacts(feeFacts, calls.calls);
            if (fee === null || nowMs() - admissionReadStarted > REBALANCE_MAX_QUOTE_AGE_MS) continue;
            const padded = ceilDiv(fee.paymentMaxWei * REBALANCE_NATIVE_FEE_PAD_BPS, BPS);
            const buySolvency = padded > REBALANCE_NATIVE_FEE_FLOOR_WEI ? padded : REBALANCE_NATIVE_FEE_FLOOR_WEI;
            // Every candidate the runtime may later choose must leave a verified
            // exit route for its resulting quantity. One unsupported candidate
            // is omitted; the asset still needs at least one complete pair.
            let sellPathReady = false;
            for (const sellRoute of supportedRoutes(asset, "sell")) {
              const sellReference = requiredReferencePath(sellRoute.path);
              if (sellReference === null) continue;
              const [sellPairs, sellReferencePairs] = await Promise.all([
                loadPathPairs(input.reader, sellRoute.path, finalized.hash), loadPathPairs(input.reader, sellReference, finalized.hash),
              ]);
              if (sellPairs === null || sellReferencePairs === null) continue;
              const sellGuard = evaluateReferenceGuard({ candidatePath: sellRoute.path, candidatePairs: sellPairs,
                referencePath: sellReference, referencePairs: sellReferencePairs,
                candidateBlockHash: finalized.hash, referenceBlockHash: finalized.hash });
              if (!sellGuard.ok) continue;
              const sellAmounts = await quoteAmounts(input.reader, sellRoute.path, out, finalized.hash);
              const sellOut = sellAmounts?.at(-1); if (sellOut === undefined) continue;
              if (riskCaps.some((cap) => {
                const reading = readings.find((row) => row.token?.toLowerCase() === riskToken.toLowerCase()
                  && row.period === cap.period);
                return reading === undefined || reading.limitWei !== cap.limit || reading.currentSpentWei > cap.limit
                  || cap.limit - reading.currentSpentWei < out;
              })) continue;
              if (nowMs() - admissionReadStarted <= REBALANCE_MAX_QUOTE_AGE_MS) { sellPathReady = true; break; }
            }
            if (!sellPathReady) continue;
            viableBuySolvencyFees.push(buySolvency);
            initialSequence += 2n;
          }
          if (viableBuySolvencyFees.length === 0) return { ok: false, code: "initial-route-or-exit-unavailable" };
          initialOwnFees += viableBuySolvencyFees.reduce((max, value) => value > max ? value : max, 0n);
        }
        const futureExitFee = ceilDiv(profile.maximumExitGasUnits * gasPriceWei * REBALANCE_NATIVE_FEE_PAD_BPS, BPS);
        const paddedExit = futureExitFee > REBALANCE_NATIVE_FEE_FLOOR_WEI ? futureExitFee : REBALANCE_NATIVE_FEE_FLOOR_WEI;
        const initialNativeRequired = initialOwnFees + paddedExit * BigInt(allocation.tier.orderedRiskAssets.length);
        if (nativeBalance < initialNativeRequired) return { ok: false, code: "initial-native-balance-insufficient" };
        for (const cap of nativeCaps) {
          const reading = readings.find((row) => row.token === null && row.period === cap.period);
          if (reading === undefined || reading.currentSpentWei + initialNativeRequired > cap.limit) {
            return { ok: false, code: "initial-native-cap-insufficient" };
          }
        }
        const baselineAtMs = nowMs();
        if (baselineAtMs - admissionReadStarted > REBALANCE_MAX_QUOTE_AGE_MS) return { ok: false, code: "baseline-stale" };
        const evidence: RebalanceAdmissionEvidenceResult = { ok: true, baselineBlock: finalized.number, baselineHash: finalized.hash,
          baselineAtMs, actualBalances: actualBaseline, protectedBalances };
        void tier;
        return evidence;
      } catch { return { ok: false, code: "session-chain-unreadable" }; }
    },
    async readPortfolio({ job }): Promise<PortfolioReadResult> {
      try {
        if (input.reader.tokenBalanceAtHash === undefined || input.reader.nativeBalanceAtHash === undefined) return { ok: false, code: "portfolio-read-unavailable" };
        const block = await input.reader.finalizedBlock(); const gasPriceWei = await input.reader.gasPriceWei();
        if (gasPriceWei <= 0n || gasPriceWei > profileGasCeiling(capabilityProfile.id)) return { ok: false, code: "gas-price-unavailable" };
        const measuredAtMs = nowMs();
        const wallet = getAddress(job.tradingWallet);
        const tokenNames = ["USDC", "WBNB", "ETH", "CAKE", "USDT"] as const;
        const actualBalances = Object.fromEntries(await Promise.all(tokenNames.map(async (asset) => [
          asset, await input.reader.tokenBalanceAtHash!(REBALANCE_TOKEN_ADDRESSES[asset], wallet, block.hash),
        ]))) as unknown as RebalanceBalanceVector;
        const expected = balancesExpected(job);
        if (expected === null || !sameBalances(actualBalances, expected)) return { ok: false, code: "external-activity" };
        const marks = [] as import("../src/quant/rebalancePortfolio.js").LiquidationMark[];
        const values: Record<"USDC" | RebalanceRiskAsset, bigint> = { USDC: job.managed?.USDC ?? 0n, WBNB: 0n, ETH: 0n, CAKE: 0n };
        const markSequence = job.actionSequence + 1n;
        const markDeadline = nextUniqueDeadlineSec({ nowMs: measuredAtMs, lastDeadlineSec: job.lastDeadlineSec,
          sessionExpirySec: job.sessionExpirySec ?? 0, jobEndMs: job.endsAtMs });
        for (const asset of ["WBNB", "ETH", "CAKE"] as const) {
          const quantityWei = job.managed?.[asset] ?? 0n;
          if (quantityWei === 0n) continue;
          const routes = await evaluateRoutes({ reader: input.reader, profile: capabilityProfile, asset, direction: "sell",
            job, wallet, amountInWei: quantityWei, actionSequence: markSequence, deadlineSec: markDeadline,
            block, nowMs: measuredAtMs, gasPriceWei, quoteFee });
          const best = selectMaximumGrossLiquidation(routes.map((route) => ({
            outputWei: route.outputWei, key: route.route.key, route,
          })));
          if (best === null) return { ok: false, code: "portfolio-quote-missing" };
          values[asset] = best.outputWei;
          const pairs = best.route.pairs;
          const identity = pathIdentity(best.route.route.path, pairs);
          if (identity === null) return { ok: false, code: "portfolio-pair-unverified" };
          marks.push({ asset, quantityWei, usdcOutWei: best.outputWei, path: best.route.route.path,
            blockNumber: block.number, blockHash: block.hash, observedAtMs: best.route.quoteObservedAtMs, pairAddresses: pairs.map((pair) => pair.address),
            referenceEvidenceDigest: digest(best.route.evidenceJson) });
        }
        const completedAtMs = nowMs();
        if (completedAtMs < measuredAtMs || completedAtMs - measuredAtMs > REBALANCE_MAX_QUOTE_AGE_MS) return { ok: false, code: "portfolio-quote-stale" };
        const valued = valueManagedPortfolio({ managed: job.managed ?? { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n },
          marks, expectedBlockNumber: block.number, expectedBlockHash: block.hash, nowMs: completedAtMs });
        if (!valued.ok) return { ok: false, code: valued.code };
        const nativeBalanceWei = await input.reader.nativeBalanceAtHash(wallet, block.hash);
        return { ok: true, observation: { blockNumber: block.number, blockHash: block.hash, observedAtMs: measuredAtMs,
          actualBalances, values: valued.values, marks, nativeBalanceWei, gasPriceWei } };
      } catch { return { ok: false, code: "portfolio-read-unavailable" }; }
    },
    async priceLeg({ job, check, leg, observation, nowMs: observedAtMs }): Promise<RebalancePricedLeg | { readonly hold: string }> {
      try {
        if (observedAtMs < observation.observedAtMs || observedAtMs - observation.observedAtMs > REBALANCE_MAX_QUOTE_AGE_MS
          || observation.gasPriceWei <= 0n || observation.gasPriceWei > profileGasCeiling(capabilityProfile.id)) return { hold: "gas-price-stale" };
        const direction = leg.kind === "buy" ? "buy" : "sell";
        const block = { number: observation.blockNumber, hash: observation.blockHash, timestampSec: 0n };
        const sequence = job.actionSequence + 1n;
        const deadlineSec = nextUniqueDeadlineSec({ nowMs: observedAtMs, lastDeadlineSec: job.lastDeadlineSec,
          sessionExpirySec: job.sessionExpirySec ?? 0, jobEndMs: job.endsAtMs });
        const routes = await evaluateRoutes({ reader: input.reader, profile: capabilityProfile, asset: leg.asset,
          job, wallet: job.tradingWallet, direction, amountInWei: leg.amountInWei, actionSequence: sequence,
          deadlineSec, block, nowMs: observedAtMs, gasPriceWei: observation.gasPriceWei, quoteFee });
        const best = routes[0]; if (best === undefined) return { hold: "route-unavailable" };
        if (fileProfile(capabilityProfile.id)
          && !g2PaymentWithinBudget(best.feeQuote.paymentMaxWei, best.route.path.length)) {
          return { hold: "g2-payment-budget-exceeded" };
        }
        const calls = buildRebalanceCalls({ router: REBALANCE_ROUTER, path: best.route.path,
          amountInWei: leg.amountInWei, quoteOutWei: best.outputWei, recipient: job.tradingWallet,
          deadlineSec, actionSequence: sequence });
        const tokenIn = best.route.path[0]; const tokenOut = best.route.path.at(-1);
        if (tokenIn === undefined || tokenOut === undefined) return { hold: "route-invalid" };
        let requiredNativeWei = requiredNativeReserve({ side: direction, ownSolvencyWei: best.solvencyNativeWei,
          gasPriceWei: observation.gasPriceWei, maximumExitGasUnits: capabilityProfile.maximumExitGasUnits,
          managed: job.managed ?? { WBNB: 0n, ETH: 0n, CAKE: 0n }, asset: leg.asset,
          resultingQuantityWei: direction === "buy" ? best.outputWei : 0n });
        if (finiteProfile(capabilityProfile.id) && direction === "sell") {
          requiredNativeWei = finitePairedSellRequiredNativeWei({ sellOwnSolvencyWei: requiredNativeWei,
            routeLength: best.route.path.length === 3 ? 3 : 2,
            gasPriceWei: observation.gasPriceWei, maximumExitGasUnits: capabilityProfile.maximumExitGasUnits });
          if (job.sessionPublicKey === null) return { hold: "finite-session-key-unavailable" };
          const meter = await checkQuantMeters({ provider: input.provider, walletAddress: job.tradingWallet,
            publicKey: job.sessionPublicKey, tokenIn, amountInWei: leg.amountInWei,
            requiredNativeWei, ...(input.signal === undefined ? {} : { signal: input.signal }) });
          if (!meter.ok) return { hold: `finite-${meter.code}` };
        }
        const action: RebalancePricedLeg["action"] = {
          jobId: job.jobId, checkId: check.checkId, sequence, side: direction, asset: leg.asset,
          tokenIn, tokenOut, path: best.route.path, pairAddresses: best.pairs.map((pair) => pair.address),
          amountInWei: leg.amountInWei, minOutWei: calls.minOutWei, quoteOutWei: best.outputWei, deadlineSec,
          callsJson: jsonBigints(calls.calls.map((call) => ({ to: call.to, value: call.value ?? 0n, data: call.data ?? "0x" }))),
          callsDigest: callsDigest(calls.calls), policyDigest: job.policyDigest!, permissionsDigest: job.permissionsDigest!,
          projectionDigest: job.projectionDigest!, claimGeneration: job.claimGeneration!,
          quoteBlockNumber: observation.blockNumber, quoteBlockHash: observation.blockHash, quoteObservedAtMs: best.quoteObservedAtMs,
          referenceBlockNumber: observation.blockNumber, referenceBlockHash: observation.blockHash, referenceObservedAtMs: best.quoteObservedAtMs,
          referenceEvidenceJson: best.evidenceJson,
          gasEvidenceJson: jsonBigints({ gasPriceWei: observation.gasPriceWei, gasUnits: capabilityProfile.maximumExitGasUnits,
            paymentWei: best.feeQuote.paymentWei, paymentMaxWei: best.feeQuote.paymentMaxWei,
            feeQuoteExpiresAtSec: best.feeQuote.expiresAtSec, feeQuoteObservedAtMs: best.feeQuote.receivedAtMs,
            feeQuoteCreatedAtMs: best.feeQuote.quotedAtMs,
            feeNativeWei: best.gasFeeNativeWei, solvencyNativeWei: best.solvencyNativeWei,
            feeUsdcWei: best.gasFeeUsdcWei, requiredNativeWei }),
          reservationWei: leg.amountInWei,
        };
        return { action, calls: calls.calls, requiredNativeWei };
      } catch { return { hold: "route-unavailable" }; }
    },
    async readCurrentWire(job): Promise<QuantJobRecord | null> {
      try {
        const result = await input.transport.job(job.jobId);
        return result.ok ? result.data : null;
      } catch { return null; }
    },
    async revalidatePlan({ job, action, finalized }): Promise<boolean> {
      const refuse = (reason: RebalanceRevalidationRefusal): false => {
        try { input.onRevalidationRefusal?.(reason); } catch { /* diagnostics never affect the refusal */ }
        return false;
      };
      try {
        if (input.reader.tokenBalanceAtHash === undefined) return refuse("reader-capability-unavailable");
        if (finalized.number < action.quoteBlockNumber
          || finalized.number - action.quoteBlockNumber > REBALANCE_MAX_BLOCK_LAG) return refuse("quote-block-lag");
        if (observedStale(action.quoteObservedAtMs, nowMs())) return refuse("quote-age");
        let gasEvidence: Record<string, unknown>;
        try { gasEvidence = asRecord(JSON.parse(action.gasEvidenceJson) as unknown); }
        catch { return refuse("fee-evidence-invalid"); }
        const feeExpiry = numberOrUndefined(gasEvidence["feeQuoteExpiresAtSec"]);
        const feeObserved = numberOrUndefined(gasEvidence["feeQuoteObservedAtMs"]);
        const feeCreated = numberOrUndefined(gasEvidence["feeQuoteCreatedAtMs"]);
        if (feeExpiry === null || feeObserved === null) return refuse("fee-evidence-invalid");
        if (feeExpiry <= Math.floor(nowMs() / 1_000)) return refuse("fee-quote-expired");
        if (feeCreated === null) return refuse("fee-evidence-invalid");
        if (observedStale(feeObserved, nowMs()) || observedStale(feeCreated, nowMs())) return refuse("fee-quote-age");
        const expected = balancesExpected(job); if (expected === null) return refuse("expected-balance-invalid");
        const actual = Object.fromEntries(await Promise.all((Object.keys(REBALANCE_TOKEN_ADDRESSES) as (keyof typeof REBALANCE_TOKEN_ADDRESSES)[]).map(async (asset) => [
          asset, await input.reader.tokenBalanceAtHash!(REBALANCE_TOKEN_ADDRESSES[asset], job.tradingWallet, finalized.hash),
        ]))) as unknown as RebalanceBalanceVector;
        if (!sameBalances(actual, expected)) return refuse("balance-mismatch");
        const block = await input.reader.blockAt(finalized.number);
        if (!sameHex(block.hash, finalized.hash)) return refuse("finalized-hash-mismatch");
        const gasPriceWei = await input.reader.gasPriceWei();
        if (gasPriceWei <= 0n || gasPriceWei > profileGasCeiling(capabilityProfile.id)) return refuse("gas-price-unavailable");
        const refreshed = await evaluateRoutes({ reader: input.reader, profile: capabilityProfile, job,
          wallet: job.tradingWallet, asset: action.asset, direction: action.side, amountInWei: action.amountInWei,
          actionSequence: action.sequence, deadlineSec: action.deadlineSec, block: finalized,
          nowMs: nowMs(), gasPriceWei, quoteFee });
        const best = refreshed[0];
        if (best !== undefined && fileProfile(capabilityProfile.id)
          && !g2PaymentWithinBudget(best.feeQuote.paymentMaxWei, best.route.path.length)) return refuse("g2-payment-budget");
        if (best === undefined) return refuse("route-or-fee-unavailable");
        if (best.route.key !== action.path.map((token) => token.toLowerCase()).join("/")) return refuse("route-changed");
        if (best.outputWei < action.minOutWei) return refuse("min-out-shortfall");
        const storedRequired = bigintFromJson(gasEvidence["requiredNativeWei"]);
        let freshRequired = requiredNativeReserve({ side: action.side, ownSolvencyWei: best.solvencyNativeWei,
          gasPriceWei, maximumExitGasUnits: capabilityProfile.maximumExitGasUnits,
          managed: job.managed ?? { WBNB: 0n, ETH: 0n, CAKE: 0n }, asset: action.asset,
          resultingQuantityWei: action.side === "buy" ? best.outputWei : 0n });
        if (finiteProfile(capabilityProfile.id) && action.side === "sell") {
          freshRequired = finitePairedSellRequiredNativeWei({ sellOwnSolvencyWei: freshRequired,
            routeLength: best.route.path.length === 3 ? 3 : 2,
            gasPriceWei, maximumExitGasUnits: capabilityProfile.maximumExitGasUnits });
        }
        if (storedRequired === null) return refuse("native-reserve-evidence-invalid");
        if (freshRequired > storedRequired) return refuse("native-reserve-increased");
        return true;
      } catch { return refuse("read-error"); }
    },
    async recoverAction(job, action): Promise<RebalanceRecoveryResult> {
      try {
        const journal = await input.journal.get(action.journalKey);
        if (action.state === "intended") {
          const state = journal === null ? "absent"
            : journal.state === "PENDING" || journal.state === "ROLLED_BACK" ? journal.state : null;
          if (state !== null && (journal === null || journal.externalRef.callsId === undefined && journal.externalRef.txHash === undefined)) {
            const aborted = await input.store.abortIntendedAction({ actionId: action.actionId,
              expectedRowVersion: action.rowVersion, expectedJournalState: state, nowMs: nowMs() });
            return aborted.kind === "ok" ? { kind: "resolved" } : { kind: "waiting" };
          }
          return { kind: "needs-operator" };
        }
        if (journal === null) return { kind: "needs-operator" };
        if (action.txHash !== null && journal.externalRef.txHash !== undefined
          && action.txHash.toLowerCase() !== journal.externalRef.txHash.toLowerCase()) return { kind: "waiting" };
        let txHash = action.txHash ?? journal.externalRef.txHash ?? null;
        const callsId = journal.externalRef.callsId;
        if (txHash === null && callsId !== undefined && input.provider.readExecutionStatus !== undefined) {
          const status = await input.provider.readExecutionStatus({ callsId });
          txHash = status.receipt.transactionHash ?? null;
          if (status.receipt.status === "PENDING" || txHash === null) return { kind: "waiting" };
        }
        if (txHash === null) return { kind: "waiting" };
        const verified = await verifyQuantRebalanceActionReceipt({ reader: input.reader, action, job, txHash });
        if (verified === null) return { kind: "waiting" };
        if (verified.failure !== null) {
          if (journal.state === "UNKNOWN") {
            await input.journal.resolveUnknown(action.journalKey,
              quantRebalanceJournalResolutionEvidence(job, action, verified.failure.blockNumber, nowMs()),
              { txHash: verified.failure.txHash });
          }
          else if (journal.state === "IN_PROGRESS" || journal.state === "PENDING") await input.journal.markRolledBack(
            action.journalKey, "Quant receipt proof verified failure.", { txHash: verified.failure.txHash });
          else if (journal.state === "COMMITTED" && journal.externalRef.txHash === undefined) {
            await input.journal.markCommitted(action.journalKey, { txHash: verified.failure.txHash });
          }
          const failed = await input.store.failAction({ actionId: action.actionId, expectedRowVersion: action.rowVersion,
            evidence: { kind: "submitted-failure", proof: verified.failure }, nowMs: nowMs() });
          return failed.kind === "ok" ? { kind: "failed" } : { kind: "waiting" };
        }
        const proof = verified.receipt;
        if (proof === null) return { kind: "waiting" };
        if (journal.state === "UNKNOWN") await input.journal.advanceUnknown(action.journalKey,
          quantRebalanceJournalResolutionEvidence(job, action, proof.blockNumber, nowMs()), { txHash: proof.txHash });
        else if (journal.state === "PENDING") await input.journal.markInProgress(action.journalKey, { txHash: proof.txHash });
        if (journal.state === "PENDING" || journal.state === "IN_PROGRESS") await input.journal.markCommitted(action.journalKey, { txHash: proof.txHash });
        const settled = await input.store.settleAction({ actionId: action.actionId, expectedRowVersion: action.rowVersion,
          proof, ownership: verified.ownership, nowMs: nowMs() });
        return settled.kind === "ok" ? { kind: "settled" } : { kind: "waiting" };
      } catch { return { kind: "waiting" }; }
    },
    async reportJob(job, actions) {
      const payload = buildQuantRebalanceReportPayload(actions);
      const payloadDigest = keccak256(stringToBytes(rebalanceCanonicalEncode(payload)));
      const response = await input.transport.report(job.jobId, payload);
      return response.ok
        ? { ok: true, payloadDigest, responseStatus: 200, notesApplied: response.data.notesApplied }
        : { ok: false, code: `report-${response.code}`, payloadDigest, responseStatus: 0, notesApplied: null };
    },
  };
  return deps;
}

/** Public, read-only boot assertions; no envelope open or execute capability is used. */
export async function assertQuantRebalanceBoot(input: {
  readonly config: QuantRebalanceRuntimeConfig;
  readonly capabilityProfile: QuantRebalanceCapabilityProfile;
  /** Explicit only for the CLI's verified local file branch. */
  readonly configProfile?: QuantExpandedConfigProfile;
  readonly transport: QuantTransport;
  readonly reader: QuantChainReader;
  readonly provider: WalletProvider;
  readonly keypair: QuantKeypair;
}): Promise<void> {
  // G1: the production composition takes registry entries only, before any read. An explicit
  // config profile is the G2 file branch alone and can never accompany a production profile.
  if (input.configProfile === undefined || QUANT_REBALANCE_CAPABILITY_PROFILES.includes(input.capabilityProfile)) {
    const registered = QUANT_EXPANDED_CONFIG_PROFILES.find((profile) => profile.id === input.capabilityProfile.capturedConfigProfileId);
    if (registered === undefined || input.configProfile !== undefined && input.configProfile !== registered) {
      throw new Error("production-profile-not-registered");
    }
    assertProductionRebalanceProfiles(registered, input.capabilityProfile);
  }
  if (input.config.chainId !== 56 || await input.reader.chainId() !== 56) throw new Error("quant-rebalance-chain-refused");
  if (input.provider.restoreGrantedSession === undefined || input.provider.readSpendInfos === undefined) {
    throw new Error("quant-rebalance-provider-capability-unavailable");
  }
  const remoteConfig = await input.transport.config();
  if (!remoteConfig.ok) throw new Error("quant-rebalance-platform-config-unavailable");
  const normalized = normalizeExpandedQuantConfig(remoteConfig.data);
  if (!normalized.ok) throw new Error("quant-rebalance-platform-config-invalid");
  const configProfile = findExpandedConfigProfile(normalized.projection,
    input.configProfile === undefined ? QUANT_EXPANDED_CONFIG_PROFILES : [input.configProfile]);
  if (configProfile === null || configProfile.id !== input.capabilityProfile.capturedConfigProfileId) {
    throw new Error("quant-rebalance-platform-config-unreviewed");
  }
  const key = await input.transport.agentKey(input.config.agentId);
  if (!key.ok || key.data.encryptionPublicKey === null) throw new Error("quant-rebalance-agent-key-unavailable");
  let registered: Buffer;
  try { registered = Buffer.from(key.data.encryptionPublicKey, "base64"); } catch { throw new Error("quant-rebalance-agent-key-invalid"); }
  if (!publicKeyEquals(registered, input.keypair.publicKey)
    || key.data.algorithm !== null && key.data.algorithm !== QUANT_ENVELOPE_ALGORITHM) {
    throw new Error("quant-rebalance-agent-key-mismatch");
  }
  if (input.reader.reservesAtHash === undefined || input.reader.pairToken1 === undefined) {
    throw new Error("quant-rebalance-hash-pinned-pair-reader-unavailable");
  }
  const finalized = await input.reader.finalizedBlock();
  for (const encodedPath of [...input.capabilityProfile.executionRoutes, ...input.capabilityProfile.referenceRoutes]) {
    const tokens = encodedPath.split("/").map((token) => getAddress(token));
    if (tokens.length < 2 || tokens.length > 3) throw new Error("quant-rebalance-profile-path-invalid");
    const pairs = await loadPathPairs(input.reader, tokens, finalized.hash);
    if (pairs === null || pathIdentity(tokens, pairs) === null) throw new Error("quant-rebalance-pair-identity-unavailable");
    if (input.capabilityProfile.referenceRoutes.includes(encodedPath)
      && !referencePathMeetsDepth(tokens, pairs, finalized.hash)) {
      throw new Error("quant-rebalance-reference-depth-unavailable");
    }
  }
}

function observedStale(observedAtMs: number, now: number): boolean {
  return observedAtMs > now || now - observedAtMs > REBALANCE_MAX_QUOTE_AGE_MS;
}

export function quantRebalanceJournalResolutionEvidence(job: QuantRebalanceJobRow, action: QuantRebalanceActionRow, block: bigint, at: number): JournalResolutionEvidence {
  return { action: "resolveUnknown", at, ownerAddress: job.tradingWallet, observedBlock: block.toString(10),
    serverBlock: block.toString(10), checks: [{ name: "quant-rebalance-receipt", result: action.actionId }],
    legs: [], logAbsence: { checked: false, detail: "not-applicable" }, disposition: "receipt-proof-verified" };
}

export async function verifyQuantRebalanceActionReceipt(input: { readonly reader: QuantChainReader; readonly action: QuantRebalanceActionRow; readonly job: QuantRebalanceJobRow; readonly txHash: Hex }): Promise<{
  readonly receipt: import("../src/store/quantRebalanceProof.js").VerifiedQuantRebalanceReceiptProof | null;
  readonly ownership: readonly import("../src/quant/rebalanceTypes.js").QuantRebalanceReceiptOwnership[];
  readonly failure: import("../src/store/quantRebalanceProof.js").VerifiedQuantRebalanceFailureProof | null;
} | null> {
  const [chainId, transaction, receipt] = await Promise.all([
    input.reader.chainId(), input.reader.getTransaction(input.txHash), input.reader.getReceipt(input.txHash),
  ]);
  if (transaction === null || receipt === null) return null;
  const submitNumber = input.action.preSubmitBlockNumber;
  if (submitNumber === null || input.action.preSubmitBlockHash === null) return null;
  if (transaction.blockNumber !== receipt.blockNumber || transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;
  const [finalized, canonical, submitAncestor] = await Promise.all([
    input.reader.finalizedBlock(), input.reader.blockAt(receipt.blockNumber), input.reader.blockAt(submitNumber),
  ]);
  if (!quantRebalanceReceiptWithinSubmitWindow({ action: input.action, receiptBlockNumber: receipt.blockNumber,
    receiptTimestampSec: canonical.timestampSec, submitAncestorNumber: submitAncestor.number,
    submitAncestorHash: submitAncestor.hash }) || canonical.number !== receipt.blockNumber) return null;
  const finality: RebalanceFinalityEvidence = { finalizedNumber: finalized.number, finalizedHash: finalized.hash,
    canonicalReceiptHash: canonical.hash, canonicalReceiptNumber: canonical.number };
  const calls = parsePersistedCalls(input.action.callsJson); if (calls === null || input.job.sessionPublicKey === null) return null;
  const identities: RebalancePairIdentity[] = [];
  for (let index = 0; index < input.action.path.length - 1; index += 1) {
    const from = input.action.path[index]; const to = input.action.path[index + 1]; const pair = input.action.pairAddresses[index];
    if (from === undefined || to === undefined || pair === undefined) return null;
    const derived = getAddress(await input.reader.getPair(REBALANCE_FACTORY, from, to));
    const token0 = getAddress(await input.reader.pairToken0(derived));
    const token1Raw = input.reader.pairToken1 === undefined ? null : await input.reader.pairToken1(derived);
    const token1 = token1Raw === null ? null : getAddress(token1Raw);
    if (token1 === null || derived.toLowerCase() !== pair.toLowerCase()) return null;
    identities.push({ address: pair, factory: REBALANCE_FACTORY, derivedAddress: derived, token0, token1: getAddress(token1) });
  }
  const keyHash = accountKeyHashForAddress(publicKeyToAddress(input.job.sessionPublicKey));
  const verifyInput = { chainId, transaction, receipt, finalized: finality, action: input.action,
    tradingWallet: input.job.tradingWallet, sessionKeyHash: keyHash, persistedCalls: calls, pairs: identities };
  const success = verifyQuantRebalanceReceipt(verifyInput);
  if (success.ok) return { receipt: success.proof, ownership: success.ownership, failure: null };
  const failure = verifyQuantRebalanceSubmittedFailure({ chainId, transaction, receipt, finalized: finality,
    action: input.action, wallet: input.job.tradingWallet, keyHash, calls });
  return failure === null ? null : { receipt: null, ownership: [], failure };
}

/** Require a canonical persisted pre-submit ancestor and an on-time router inclusion. */
export function quantRebalanceReceiptWithinSubmitWindow(input: {
  readonly action: Pick<QuantRebalanceActionRow, "preSubmitBlockNumber" | "preSubmitBlockHash" | "deadlineSec">;
  readonly receiptBlockNumber: bigint;
  readonly receiptTimestampSec: bigint;
  readonly submitAncestorNumber: bigint;
  readonly submitAncestorHash: Hex;
}): boolean {
  const ancestorNumber = input.action.preSubmitBlockNumber;
  const ancestorHash = input.action.preSubmitBlockHash;
  return ancestorNumber !== null && ancestorHash !== null && ancestorNumber >= 0n
    && input.receiptBlockNumber >= ancestorNumber && input.submitAncestorNumber === ancestorNumber
    && input.submitAncestorHash.toLowerCase() === ancestorHash.toLowerCase()
    && input.receiptTimestampSec >= 0n && Number.isSafeInteger(input.action.deadlineSec)
    && input.action.deadlineSec > 0 && input.receiptTimestampSec <= BigInt(input.action.deadlineSec);
}
