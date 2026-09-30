/** Fixed v1 policy and integer-only portfolio arithmetic for Quant rebalance. */
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { rebalanceCanonicalEncode } from "./rebalanceCanonical.js";
import {
  PANCAKE_V2_FACTORY_56, QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56,
} from "./config.js";

export const REBALANCE_VERSION = "rebalance-v1-quant:1" as const;
export const G2_FILE_POLICY_VERSION = "rebalance-g2-file:1" as const;
export const G2_FINITE_POLICY_VERSION = "g2-high75-finite-v2" as const;
export const REBALANCE_CHAIN_ID = 56 as const;
export const REBALANCE_USDC = QUANT_U_56;
export const REBALANCE_WBNB = QUANT_WBNB_56;
export const REBALANCE_ETH: Address = getAddress("0x2170Ed0880ac9A755fd29B2688956BD959F933F8");
export const REBALANCE_CAKE: Address = getAddress("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82");
export const REBALANCE_USDT: Address = getAddress("0x55d398326f99059fF775485246999027B3197955");
export const REBALANCE_ROUTER = QUANT_ROUTER_56;
export const REBALANCE_FACTORY = PANCAKE_V2_FACTORY_56;
export const E18 = 10n ** 18n;
export const BPS = 10_000n;
export const MIN_ALLOCATION_WEI = 10n * E18;
export const TIER_BOUNDARY_WEI = 75n * E18;
export const MAX_ALLOCATION_WEI = 1_000n * E18;
export const REBALANCE_MIN_OUT_BPS = 9_950n;
export const REBALANCE_MAX_REFERENCE_DEVIATION_BPS = 200n;
export const REBALANCE_REFERENCE_DEPTH_WEI = 100_000n * E18;
export const REBALANCE_PROVISIONAL_CLAIM_MS = 120_000;
export const REBALANCE_MAX_QUOTE_AGE_MS = 30_000;
export const REBALANCE_MAX_BLOCK_LAG = 40n;
export const REBALANCE_MAX_GAS_PRICE_WEI = 1_000n * 10n ** 9n;
export const REBALANCE_NATIVE_FEE_FLOOR_WEI = 30_000_000_000_000n;
export const REBALANCE_NATIVE_FEE_PAD_BPS = 15_000n;

export type RebalanceAsset = "USDC" | "WBNB" | "ETH" | "CAKE";
export type RebalanceRiskAsset = Exclude<RebalanceAsset, "USDC">;
export type RebalanceTierId = "low" | "high";
export type RebalanceTier = {
  readonly id: RebalanceTierId;
  readonly intervalMs: number;
  readonly driftBps: bigint;
  readonly targetWeightsBps: Readonly<Partial<Record<RebalanceAsset, bigint>>>;
  readonly orderedRiskAssets: readonly RebalanceRiskAsset[];
};

export const LOW_TIER: RebalanceTier = Object.freeze({
  id: "low", intervalMs: 24 * 60 * 60 * 1_000, driftBps: 1_000n,
  targetWeightsBps: Object.freeze({ USDC: 5_000n, WBNB: 5_000n }),
  orderedRiskAssets: Object.freeze(["WBNB"] as const),
});
export const HIGH_TIER: RebalanceTier = Object.freeze({
  id: "high", intervalMs: 4 * 60 * 60 * 1_000, driftBps: 300n,
  targetWeightsBps: Object.freeze({ WBNB: 4_000n, ETH: 4_000n, CAKE: 2_000n }),
  orderedRiskAssets: Object.freeze(["WBNB", "ETH", "CAKE"] as const),
});

/** The accelerated schedule is selected only by the local file capability ID. */
export const G2_FILE_CAPABILITY_ID = "g2-file-direct-wbnb-v1";
export const G2_FINITE_CAPABILITY_ID = "quant-rebalance-g2-high75-finite-v2";
export const G2_FINITE_MAX_GAS_PRICE_WEI = 100_000_000n;
export const G2_FINITE_NATIVE_DAY_CAP_WEI = 1_300_000_000_000_000n;
export const G2_FINITE_SUBMISSION_CEILING = 30;
export const G2_FILE_LOW_TIER: RebalanceTier = Object.freeze({ ...LOW_TIER, intervalMs: 5 * 60_000, driftBps: 10n });
export const G2_FILE_HIGH_TIER: RebalanceTier = Object.freeze({ ...HIGH_TIER, intervalMs: 5 * 60_000, driftBps: 10n });

export function rebalanceTierForProfile(allocationWei: bigint, profileId: string): AllocationDecision {
  const admitted = admitRebalanceAllocation(allocationWei);
  if (!admitted.ok) return admitted;
  if (profileId === G2_FINITE_CAPABILITY_ID) {
    return allocationWei === 75n * E18
      ? { ...admitted, tier: G2_FILE_HIGH_TIER }
      : { ok: false, code: "allocation-invalid" };
  }
  if (profileId !== G2_FILE_CAPABILITY_ID) return admitted;
  return { ...admitted, tier: admitted.tier.id === "low" ? G2_FILE_LOW_TIER : G2_FILE_HIGH_TIER };
}

export function g2PaymentWithinBudget(paymentMaxWei: bigint, pathLength: number): boolean {
  return paymentMaxWei > 0n && (pathLength === 2 && paymentMaxWei <= 45_000_000_000_000n
    || pathLength === 3 && paymentMaxWei <= 90_000_000_000_000n);
}

/** V2 sell must leave a bounded buy and four conservative managed exits payable. */
export function finitePairedSellRequiredNativeWei(input: {
  readonly sellOwnSolvencyWei: bigint;
  readonly routeLength: 2 | 3;
  readonly gasPriceWei: bigint;
  readonly maximumExitGasUnits: bigint;
}): bigint {
  assertUint256(input.sellOwnSolvencyWei);
  if (input.sellOwnSolvencyWei <= 0n || input.gasPriceWei <= 0n
    || input.gasPriceWei > G2_FINITE_MAX_GAS_PRICE_WEI || input.maximumExitGasUnits <= 0n) {
    throw new Error("finite-native-reserve-invalid");
  }
  const buyMax = input.routeLength === 2 ? 45_000_000_000_000n : 90_000_000_000_000n;
  const buySolvency = ceilDiv(buyMax * REBALANCE_NATIVE_FEE_PAD_BPS, BPS);
  const exit = ceilDiv(input.maximumExitGasUnits * input.gasPriceWei * REBALANCE_NATIVE_FEE_PAD_BPS, BPS);
  const oneExit = exit > REBALANCE_NATIVE_FEE_FLOOR_WEI ? exit : REBALANCE_NATIVE_FEE_FLOOR_WEI;
  const total = input.sellOwnSolvencyWei + buySolvency + 4n * oneExit;
  assertUint256(total);
  return total;
}

export const REBALANCE_TOKEN_ADDRESSES: Readonly<Record<RebalanceAsset | "USDT", Address>> = Object.freeze({
  USDC: REBALANCE_USDC, WBNB: REBALANCE_WBNB, ETH: REBALANCE_ETH,
  CAKE: REBALANCE_CAKE, USDT: REBALANCE_USDT,
});

export type AllocationDecision =
  | { readonly ok: true; readonly allocationWei: bigint; readonly tier: RebalanceTier }
  | { readonly ok: false; readonly code: "allocation-invalid" | "below-minimum" | "above-maximum" };

/** `allocationU` is already the resulting deposit/use-% amount when present. */
export function admitRebalanceAllocation(allocationWei: bigint): AllocationDecision {
  if (allocationWei <= 0n || allocationWei > (1n << 256n) - 1n) {
    return { ok: false, code: "allocation-invalid" };
  }
  if (allocationWei < MIN_ALLOCATION_WEI) return { ok: false, code: "below-minimum" };
  if (allocationWei > MAX_ALLOCATION_WEI) return { ok: false, code: "above-maximum" };
  return {
    ok: true, allocationWei,
    tier: allocationWei < TIER_BOUNDARY_WEI ? LOW_TIER : HIGH_TIER,
  };
}

/** Apply a deposit-use percentage only for an explicitly verified alternate wire. */
export function allocatedAmountFromDeposit(depositWei: bigint, usePercent: bigint): bigint {
  assertUint256(depositWei);
  if (usePercent <= 0n || usePercent > 100n) throw new Error("allocation-percent-invalid");
  return depositWei * usePercent / 100n;
}

export function assertUint256(value: bigint): void {
  if (value < 0n || value >= (1n << 256n)) throw new Error("uint256-out-of-range");
}

/** Own relay solvency plus a conservative exit obligation per resulting position. */
export function requiredNativeReserve(input: {
  readonly side: "buy" | "sell";
  readonly ownSolvencyWei: bigint;
  readonly gasPriceWei: bigint;
  readonly maximumExitGasUnits: bigint;
  readonly managed: Readonly<Record<RebalanceRiskAsset, bigint>>;
  readonly asset: RebalanceRiskAsset;
  readonly resultingQuantityWei: bigint;
}): bigint {
  assertUint256(input.ownSolvencyWei);
  assertUint256(input.gasPriceWei);
  assertUint256(input.maximumExitGasUnits);
  assertUint256(input.resultingQuantityWei);
  for (const quantity of Object.values(input.managed)) assertUint256(quantity);
  if (input.gasPriceWei <= 0n || input.maximumExitGasUnits <= 0n) throw new Error("native-reserve-input-invalid");
  if (input.side === "sell") return input.ownSolvencyWei;
  const existingPositions = (Object.values(input.managed) as bigint[]).filter((quantity) => quantity > 0n).length;
  const addsPosition = input.resultingQuantityWei > 0n && input.managed[input.asset] === 0n ? 1 : 0;
  const padded = ceilDiv(input.maximumExitGasUnits * input.gasPriceWei * REBALANCE_NATIVE_FEE_PAD_BPS, BPS);
  const oneExit = padded > REBALANCE_NATIVE_FEE_FLOOR_WEI ? padded : REBALANCE_NATIVE_FEE_FLOOR_WEI;
  const total = input.ownSolvencyWei + oneExit * BigInt(existingPositions + addsPosition);
  assertUint256(total);
  return total;
}

export function parseAtomicInteger(raw: unknown): bigint | null {
  if (typeof raw === "bigint") return raw >= 0n && raw < (1n << 256n) ? raw : null;
  if (typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)) {
    const parsed = BigInt(raw);
    return parsed < (1n << 256n) ? parsed : null;
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  return null;
}

export function serializeAtomic(value: bigint): string {
  assertUint256(value);
  return value.toString(10);
}

export type RebalancePolicyProjection = {
  readonly version: typeof REBALANCE_VERSION | typeof G2_FILE_POLICY_VERSION | typeof G2_FINITE_POLICY_VERSION;
  readonly chainId: 56;
  readonly settlement: { readonly symbol: "USDC"; readonly address: Address; readonly decimals: 18 };
  readonly router: Address;
  readonly factory: Address;
  readonly tokens: Readonly<Record<RebalanceAsset | "USDT", { readonly address: Address; readonly decimals: number }>>;
  readonly minAllocationWei: bigint;
  readonly maxAllocationWei: bigint;
  readonly tierBoundaryWei: bigint;
  readonly tiers: readonly RebalanceTier[];
  readonly routeIntermediates: readonly Address[];
  readonly minOutBps: bigint;
  readonly referenceDeviationBps: bigint;
  readonly referenceDepthWeiPerSide: bigint;
  readonly provisionalClaimMs: number;
  readonly maxQuoteAgeMs: number;
  readonly maxBlockLag: bigint;
  readonly nativeFeeFloorWei: bigint;
  readonly nativeFeePadBps: bigint;
  readonly maxGasPriceWei: bigint;
  readonly lifecycle: "no-liquidation-no-regrant";
  readonly capabilityProfileId: string | null;
  readonly finiteSchedule?: {
    readonly jobId: "self-test-rebalance-g2-high75-finite-v2";
    readonly allocationWei: bigint;
    readonly stageOrder: readonly string[];
    readonly sellClipBps: bigint;
    readonly rebuyFromVerifiedProceedsOnly: true;
    readonly separateCheckIntervalMs: number;
    readonly provenNoSendRepricesPerStage: number;
    readonly submissionOuterCeiling: number;
    readonly nativeDayCapWei: bigint;
    readonly directPaymentMaxWei: bigint;
    readonly twoHopPaymentMaxWei: bigint;
    readonly maxGasPriceWei: bigint;
    readonly termDays: 2;
    readonly sessionTailMs: number;
  };
};

export function rebalancePolicyProjection(capabilityProfileId: string | null): RebalancePolicyProjection {
  const finite = capabilityProfileId === G2_FINITE_CAPABILITY_ID;
  return {
    version: finite ? G2_FINITE_POLICY_VERSION
      : capabilityProfileId === G2_FILE_CAPABILITY_ID ? G2_FILE_POLICY_VERSION : REBALANCE_VERSION, chainId: 56,
    settlement: { symbol: "USDC", address: REBALANCE_USDC, decimals: 18 },
    router: REBALANCE_ROUTER, factory: REBALANCE_FACTORY,
    tokens: {
      USDC: { address: REBALANCE_USDC, decimals: 18 },
      WBNB: { address: REBALANCE_WBNB, decimals: 18 },
      ETH: { address: REBALANCE_ETH, decimals: 18 },
      CAKE: { address: REBALANCE_CAKE, decimals: 18 },
      USDT: { address: REBALANCE_USDT, decimals: 18 },
    },
    minAllocationWei: MIN_ALLOCATION_WEI, maxAllocationWei: MAX_ALLOCATION_WEI,
    tierBoundaryWei: TIER_BOUNDARY_WEI, tiers: capabilityProfileId === G2_FILE_CAPABILITY_ID || finite
      ? [G2_FILE_LOW_TIER, G2_FILE_HIGH_TIER] : [LOW_TIER, HIGH_TIER],
    routeIntermediates: [REBALANCE_USDT, REBALANCE_WBNB],
    minOutBps: REBALANCE_MIN_OUT_BPS,
    referenceDeviationBps: REBALANCE_MAX_REFERENCE_DEVIATION_BPS,
    referenceDepthWeiPerSide: REBALANCE_REFERENCE_DEPTH_WEI,
    provisionalClaimMs: REBALANCE_PROVISIONAL_CLAIM_MS,
    maxQuoteAgeMs: REBALANCE_MAX_QUOTE_AGE_MS,
    maxBlockLag: REBALANCE_MAX_BLOCK_LAG,
    nativeFeeFloorWei: REBALANCE_NATIVE_FEE_FLOOR_WEI,
    nativeFeePadBps: REBALANCE_NATIVE_FEE_PAD_BPS,
    maxGasPriceWei: finite ? G2_FINITE_MAX_GAS_PRICE_WEI : REBALANCE_MAX_GAS_PRICE_WEI,
    lifecycle: "no-liquidation-no-regrant", capabilityProfileId,
    ...(finite ? { finiteSchedule: {
      jobId: "self-test-rebalance-g2-high75-finite-v2" as const,
      allocationWei: 75n * E18,
      stageOrder: ["buy-WBNB", "buy-ETH", "buy-CAKE", "sell-WBNB", "buy-WBNB",
        "sell-ETH", "buy-ETH", "sell-CAKE", "buy-CAKE"],
      sellClipBps: 2_000n,
      rebuyFromVerifiedProceedsOnly: true as const,
      separateCheckIntervalMs: 5 * 60_000,
      provenNoSendRepricesPerStage: 2,
      submissionOuterCeiling: G2_FINITE_SUBMISSION_CEILING,
      nativeDayCapWei: G2_FINITE_NATIVE_DAY_CAP_WEI,
      directPaymentMaxWei: 45_000_000_000_000n,
      twoHopPaymentMaxWei: 90_000_000_000_000n,
      maxGasPriceWei: G2_FINITE_MAX_GAS_PRICE_WEI,
      termDays: 2 as const,
      sessionTailMs: 600_000,
    } } : {}),
  };
}

export function rebalancePolicyDigest(capabilityProfileId: string | null): Hex {
  return keccak256(stringToBytes(rebalanceCanonicalEncode(rebalancePolicyProjection(capabilityProfileId))));
}

export type RebalanceJobPolicyProjection = {
  readonly process: RebalancePolicyProjection;
  readonly job: {
    readonly jobId: string;
    readonly strategyId: string;
    readonly allocationWei: bigint;
    readonly tierId: RebalanceTierId;
    readonly targetWeightsBps: Readonly<Partial<Record<RebalanceAsset, bigint>>>;
    readonly driftBps: bigint;
    readonly intervalMs: number;
    readonly startedAtMs: number;
    readonly endsAtMs: number;
    readonly sessionExpiresAtMs: number;
  };
};

export function rebalanceJobPolicyProjection(input: {
  readonly capabilityProfileId: string;
  readonly jobId: string;
  readonly strategyId: string;
  readonly allocationWei: bigint;
  readonly tier: RebalanceTier;
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  readonly sessionExpiresAtMs: number;
}): RebalanceJobPolicyProjection {
  const admitted = admitRebalanceAllocation(input.allocationWei);
  if (!admitted.ok || admitted.tier.id !== input.tier.id || input.capabilityProfileId.trim() === ""
    || !Number.isSafeInteger(input.startedAtMs) || input.startedAtMs <= 0
    || !Number.isSafeInteger(input.endsAtMs) || input.endsAtMs <= input.startedAtMs
    || !Number.isSafeInteger(input.sessionExpiresAtMs) || input.sessionExpiresAtMs <= 0) {
    throw new Error("rebalance-job-policy-invalid");
  }
  return {
    process: rebalancePolicyProjection(input.capabilityProfileId),
    job: {
      jobId: input.jobId, strategyId: input.strategyId, allocationWei: input.allocationWei,
      tierId: input.tier.id, targetWeightsBps: input.tier.targetWeightsBps,
      driftBps: input.tier.driftBps, intervalMs: input.tier.intervalMs,
      startedAtMs: input.startedAtMs, endsAtMs: input.endsAtMs,
      sessionExpiresAtMs: input.sessionExpiresAtMs,
    },
  };
}

export function rebalanceJobPolicyDigest(input: Parameters<typeof rebalanceJobPolicyProjection>[0]): Hex {
  return keccak256(stringToBytes(rebalanceCanonicalEncode(rebalanceJobPolicyProjection(input))));
}

export type PortfolioVector = Readonly<Record<RebalanceAsset, bigint>>;

/** Relative drift against each asset's own target, with equality triggering. */
export function crossedRelativeDrift(
  values: PortfolioVector,
  tier: RebalanceTier,
): boolean {
  assertPortfolioVector(values);
  const total = Object.values(values).reduce((sum, value) => sum + value, 0n);
  if (total === 0n) return false;
  for (const [asset, weight] of Object.entries(tier.targetWeightsBps) as [RebalanceAsset, bigint][]) {
    if (weight <= 0n) continue;
    const deviation = abs(values[asset] * BPS - total * weight) * BPS;
    if (deviation >= total * weight * tier.driftBps) return true;
  }
  return false;
}

export function hasAnyRelativeDrift(
  values: PortfolioVector,
  tier: RebalanceTier,
): readonly RebalanceAsset[] {
  assertPortfolioVector(values);
  const total = Object.values(values).reduce((sum, value) => sum + value, 0n);
  if (total === 0n) return [];
  const crossed: RebalanceAsset[] = [];
  for (const [asset, weight] of Object.entries(tier.targetWeightsBps) as [RebalanceAsset, bigint][]) {
    if (weight > 0n && abs(values[asset] * BPS - total * weight) * BPS >= total * weight * tier.driftBps) {
      crossed.push(asset);
    }
  }
  return crossed;
}

export function assertPortfolioVector(values: PortfolioVector): void {
  for (const asset of ["USDC", "WBNB", "ETH", "CAKE"] as const) {
    const value = values[asset];
    if (typeof value !== "bigint" || value < 0n || value >= (1n << 256n)) {
      throw new Error("portfolio-amount-invalid");
    }
  }
}

export function nextEligibleSlot(startedAtMs: number, completedAtMs: number, intervalMs: number): number {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0
    || !Number.isSafeInteger(completedAtMs) || completedAtMs < startedAtMs
    || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("schedule-time-invalid");
  }
  const slot = Math.floor((completedAtMs - startedAtMs) / intervalMs) + 1;
  if (!Number.isSafeInteger(slot)) throw new Error("schedule-slot-invalid");
  return slot;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error("division-domain-invalid");
  return (numerator + denominator - 1n) / denominator;
}

export function abs(value: bigint): bigint { return value < 0n ? -value : value; }
