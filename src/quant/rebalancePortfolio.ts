/** Managed-balance valuation, cost basis and one-leg-at-a-time planning. */
import type { Address, Hex } from "viem";
import {
  BPS, assertPortfolioVector, ceilDiv, hasAnyRelativeDrift, REBALANCE_TOKEN_ADDRESSES,
  type PortfolioVector, type RebalanceAsset, type RebalanceRiskAsset, type RebalanceTier,
} from "./rebalancePolicy.js";
import { validateRebalancePath } from "./rebalanceRoutes.js";

export type ManagedVector = PortfolioVector;
export type AssetValues = Readonly<Record<RebalanceAsset, bigint>>;
export type CostBasisVector = Readonly<Record<RebalanceRiskAsset, bigint>>;

export type LiquidationMark = {
  readonly asset: RebalanceRiskAsset;
  readonly quantityWei: bigint;
  readonly usdcOutWei: bigint;
  readonly path: readonly Address[];
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly observedAtMs: number;
  readonly pairAddresses: readonly Address[];
  readonly referenceEvidenceDigest: Hex;
};

export type MarkResult =
  | { readonly ok: true; readonly values: AssetValues; readonly marks: Readonly<Partial<Record<RebalanceRiskAsset, LiquidationMark>>> }
  | { readonly ok: false; readonly code: "portfolio-vector-invalid" | "portfolio-quote-missing" | "portfolio-mark-mismatch" };

/** Positive holdings require one fresh full-balance executable liquidation mark. */
export function valueManagedPortfolio(input: {
  readonly managed: ManagedVector;
  readonly marks: readonly LiquidationMark[];
  readonly expectedBlockNumber: bigint;
  readonly expectedBlockHash: Hex;
  readonly nowMs: number;
}): MarkResult {
  try { assertPortfolioVector(input.managed); } catch { return { ok: false, code: "portfolio-vector-invalid" }; }
  const byAsset = new Map<RebalanceRiskAsset, LiquidationMark>();
  for (const mark of input.marks) {
    if (byAsset.has(mark.asset)) return { ok: false, code: "portfolio-mark-mismatch" };
    byAsset.set(mark.asset, mark);
  }
  const values: Record<RebalanceAsset, bigint> = {
    USDC: input.managed.USDC, WBNB: 0n, ETH: 0n, CAKE: 0n,
  };
  for (const asset of ["WBNB", "ETH", "CAKE"] as const) {
    const quantityWei = input.managed[asset];
    const mark = byAsset.get(asset);
    if (quantityWei === 0n) {
      if (mark !== undefined && mark.quantityWei !== 0n) return { ok: false, code: "portfolio-mark-mismatch" };
      continue;
    }
    if (mark === undefined || mark.usdcOutWei <= 0n || mark.quantityWei !== quantityWei) {
      return { ok: false, code: "portfolio-quote-missing" };
    }
    const normalizedPath = validateRebalancePath(mark.path, {
      from: mark.path[0] ?? ("0x0000000000000000000000000000000000000000" as Address),
      to: mark.path.at(-1) ?? ("0x0000000000000000000000000000000000000000" as Address),
    });
    if (mark.blockNumber !== input.expectedBlockNumber
      || mark.blockHash.toLowerCase() !== input.expectedBlockHash.toLowerCase()
      || normalizedPath === null
      || mark.path[0]?.toLowerCase() !== assetAddress(mark.asset).toLowerCase()
      || mark.path.at(-1)?.toLowerCase() !== REBALANCE_TOKEN_ADDRESSES.USDC.toLowerCase()
      || mark.pairAddresses.length !== mark.path.length - 1
      || mark.pairAddresses.some((address) => !/^0x[0-9a-fA-F]{40}$/u.test(address))
      || mark.blockNumber < 0n || mark.usdcOutWei >= (1n << 256n)
      || !/^0x[0-9a-fA-F]{64}$/u.test(mark.blockHash)
      || !Number.isSafeInteger(mark.observedAtMs) || mark.observedAtMs > input.nowMs
      || input.nowMs - mark.observedAtMs > 30_000) {
      return { ok: false, code: "portfolio-mark-mismatch" };
    }
    values[asset] = mark.usdcOutWei;
  }
  return { ok: true, values, marks: Object.fromEntries(byAsset) as Partial<Record<RebalanceRiskAsset, LiquidationMark>> };
}

function assetAddress(asset: RebalanceRiskAsset): Address {
  return REBALANCE_TOKEN_ADDRESSES[asset];
}

export type PlannedRebalanceLeg =
  | { readonly kind: "none"; readonly reason: "below-threshold" | "already-balanced" }
  | { readonly kind: "hold"; readonly reason: "portfolio-empty" | "rounds-to-zero" }
  | { readonly kind: "sell"; readonly asset: RebalanceRiskAsset; readonly amountInWei: bigint; readonly targetExcessValueWei: bigint }
  | { readonly kind: "buy"; readonly asset: RebalanceRiskAsset; readonly amountInWei: bigint; readonly targetDeficitValueWei: bigint };

/** Select one action from current settled state; a later tick must mark again. */
export function planRebalanceLeg(input: {
  readonly managed: ManagedVector;
  readonly values: AssetValues;
  readonly tier: RebalanceTier;
  readonly takenAssets: ReadonlySet<RebalanceRiskAsset>;
  readonly checkMode: "candidate" | "bootstrap" | "continuation";
}): PlannedRebalanceLeg {
  try {
    assertPortfolioVector(input.managed);
    assertPortfolioVector(input.values);
  } catch { throw new Error("portfolio-vector-invalid"); }
  const totalValue = input.values.USDC + input.values.WBNB + input.values.ETH + input.values.CAKE;
  if (totalValue === 0n) return { kind: "hold", reason: "portfolio-empty" };
  if (input.checkMode === "candidate" && hasAnyRelativeDrift(input.values, input.tier).length === 0) {
    return { kind: "none", reason: "below-threshold" };
  }

  const targetValues = new Map<RebalanceAsset, bigint>();
  for (const [asset, weightBps] of Object.entries(input.tier.targetWeightsBps) as [RebalanceAsset, bigint][]) {
    targetValues.set(asset, totalValue * weightBps / BPS);
  }
  const excesses = input.tier.orderedRiskAssets
    .filter((asset) => !input.takenAssets.has(asset))
    .map((asset, order) => ({
      asset, order,
      excess: input.values[asset] - (targetValues.get(asset) ?? 0n),
      assetValue: input.values[asset],
      quantity: input.managed[asset],
    }))
    .filter((row) => row.excess > 0n && row.assetValue > 0n && row.quantity > 0n)
    .sort((a, b) => a.excess === b.excess ? a.order - b.order : a.excess > b.excess ? -1 : 1);
  const excess = excesses[0];
  if (excess !== undefined) {
    const amountInWei = excess.quantity * excess.excess / excess.assetValue;
    if (amountInWei > 0n) return { kind: "sell", asset: excess.asset, amountInWei, targetExcessValueWei: excess.excess };
  }

  const deficits = input.tier.orderedRiskAssets
    .filter((asset) => !input.takenAssets.has(asset))
    .map((asset, order) => ({
      asset, order,
      deficit: (targetValues.get(asset) ?? 0n) - input.values[asset],
    }))
    .filter((row) => row.deficit > 0n)
    .sort((a, b) => a.deficit === b.deficit ? a.order - b.order : a.deficit > b.deficit ? -1 : 1);
  if (deficits.length === 0) return { kind: "none", reason: "already-balanced" };
  const totalDeficit = deficits.reduce((sum, row) => sum + row.deficit, 0n);
  const cashTarget = targetValues.get("USDC") ?? 0n;
  const availableCash = input.values.USDC > cashTarget ? input.managed.USDC - (cashTarget > input.managed.USDC ? input.managed.USDC : cashTarget) : 0n;
  if (availableCash <= 0n || totalDeficit <= 0n) return { kind: "hold", reason: "rounds-to-zero" };
  // Surplus cash must not be redirected into another asset when one bootstrap
  // leg has already been consumed by a definitive failure.
  const distributableCash = availableCash < totalDeficit ? availableCash : totalDeficit;
  const scaled = deficits.map((row) => ({ ...row, scaledValue: row.deficit * distributableCash / totalDeficit }));
  const selected = [...scaled].sort((a, b) => a.scaledValue === b.scaledValue
    ? a.order - b.order : a.scaledValue > b.scaledValue ? -1 : 1)[0];
  if (selected === undefined || selected.scaledValue <= 0n) return { kind: "hold", reason: "rounds-to-zero" };
  return {
    kind: "buy", asset: selected.asset, amountInWei: selected.scaledValue,
    targetDeficitValueWei: selected.deficit,
  };
}

export type VerifiedPortfolioFill = {
  readonly side: "buy" | "sell";
  readonly asset: RebalanceRiskAsset;
  readonly fillInWei: bigint;
  readonly fillOutWei: bigint;
};

export type SettledPortfolio = {
  readonly managed: ManagedVector;
  readonly costBasis: CostBasisVector;
  readonly realizedDeltaUsdcWei: bigint;
};

/** A unique verified receipt is the only source of a managed-vector delta. */
export function applyVerifiedFill(
  managed: ManagedVector,
  costBasis: CostBasisVector,
  fill: VerifiedPortfolioFill,
): SettledPortfolio {
  assertPortfolioVector(managed);
  for (const asset of ["WBNB", "ETH", "CAKE"] as const) {
    const basis = costBasis[asset];
    if (typeof basis !== "bigint" || basis < 0n || basis >= (1n << 256n)) throw new Error("cost-basis-invalid");
  }
  if (fill.fillInWei <= 0n || fill.fillOutWei <= 0n
    || fill.fillInWei >= (1n << 256n) || fill.fillOutWei >= (1n << 256n)) throw new Error("fill-amount-invalid");
  if (fill.side === "buy") {
    if (managed.USDC < fill.fillInWei) throw new Error("fill-exceeds-managed-cash");
    const nextManaged = { ...managed, USDC: managed.USDC - fill.fillInWei, [fill.asset]: managed[fill.asset] + fill.fillOutWei };
    const nextBasis = { ...costBasis, [fill.asset]: costBasis[fill.asset] + fill.fillInWei };
    assertPortfolioVector(nextManaged);
    if (nextBasis[fill.asset] >= (1n << 256n)) throw new Error("cost-basis-overflow");
    return { managed: nextManaged, costBasis: nextBasis, realizedDeltaUsdcWei: 0n };
  }
  const priorQuantity = managed[fill.asset];
  if (priorQuantity < fill.fillInWei) throw new Error("fill-exceeds-managed-token");
  const basisShare = fill.fillInWei === priorQuantity
    ? costBasis[fill.asset]
    : costBasis[fill.asset] * fill.fillInWei / priorQuantity;
  const nextManaged = { ...managed, USDC: managed.USDC + fill.fillOutWei, [fill.asset]: priorQuantity - fill.fillInWei };
  const nextBasis = { ...costBasis, [fill.asset]: costBasis[fill.asset] - basisShare };
  assertPortfolioVector(nextManaged);
  return { managed: nextManaged, costBasis: nextBasis, realizedDeltaUsdcWei: fill.fillOutWei - basisShare };
}

export function valueToTokenAmountFloor(
  valueUsdcWei: bigint,
  fullValueUsdcWei: bigint,
  fullQuantityWei: bigint,
): bigint {
  if (valueUsdcWei < 0n || fullValueUsdcWei <= 0n || fullQuantityWei < 0n) throw new Error("valuation-domain-invalid");
  return fullQuantityWei * valueUsdcWei / fullValueUsdcWei;
}

export function minOutFloor(quoteOutWei: bigint, minOutBps: bigint): bigint {
  if (quoteOutWei <= 0n || minOutBps <= 0n || minOutBps > BPS) throw new Error("min-out-domain-invalid");
  return ceilDiv(quoteOutWei * minOutBps, BPS);
}

/** Pick portfolio liquidation marks by gross proceeds, without gas ranking. */
export function selectMaximumGrossLiquidation<T extends { readonly outputWei: bigint; readonly key: string }>(
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (candidate.outputWei <= 0n) continue;
    if (best === null || candidate.outputWei > best.outputWei
      || candidate.outputWei === best.outputWei && candidate.key.localeCompare(best.key) < 0) best = candidate;
  }
  return best;
}
