import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import {
  E18, HIGH_TIER, LOW_TIER, MAX_ALLOCATION_WEI, MIN_ALLOCATION_WEI,
  TIER_BOUNDARY_WEI, admitRebalanceAllocation, crossedRelativeDrift,
  hasAnyRelativeDrift, nextEligibleSlot, REBALANCE_CAKE, REBALANCE_ETH,
  REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_USDT,
  REBALANCE_WBNB, requiredNativeReserve,
} from "../src/quant/rebalancePolicy.js";
import {
  buildRebalanceCalls, enumerateRebalanceRoutes, evaluateReferenceGuard,
  rankRoutes, requiredReferencePath, taggedMinimumOutput, validateRebalanceCalls,
  validateRebalancePath, type RoutePairEvidence,
} from "../src/quant/rebalanceRoutes.js";
import {
  applyVerifiedFill, planRebalanceLeg, selectMaximumGrossLiquidation, valueManagedPortfolio, type LiquidationMark,
} from "../src/quant/rebalancePortfolio.js";
import {
  expandedConfigVenueTargets, findExpandedConfigProfile, normalizeExpandedQuantConfig,
  QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES, resolveQuantRebalancingEnabled,
  type QuantExpandedConfigProfile,
} from "../src/quant/rebalanceConfig.js";
import { quantRebalanceImmutableWireDigest } from "../src/quant/rebalanceWorker.js";
import type { QuantJobRecord } from "../src/quant/types.js";

const E17 = 10n ** 17n;
const HASH_A = `0x${"a".repeat(64)}` as const;
const HASH_B = `0x${"b".repeat(64)}` as const;
const ADDR_A = getAddress("0x1000000000000000000000000000000000000001");
const ADDR_B = getAddress("0x1000000000000000000000000000000000000002");
const ADDR_C = getAddress("0x1000000000000000000000000000000000000003");

describe("Quant rebalancing policy", () => {
  it("pins allocation minimum, tier boundary, inclusive maximum, and atomic neighbors", () => {
    assert.equal(admitRebalanceAllocation(MIN_ALLOCATION_WEI - 1n).ok, false);
    assert.equal(admitRebalanceAllocation(MIN_ALLOCATION_WEI).ok, true);
    assert.equal(admitRebalanceAllocation(TIER_BOUNDARY_WEI - 1n).ok, true);
    const boundary = admitRebalanceAllocation(TIER_BOUNDARY_WEI);
    assert.equal(boundary.ok && boundary.tier.id, "high");
    assert.equal(admitRebalanceAllocation(MAX_ALLOCATION_WEI).ok, true);
    assert.deepEqual(admitRebalanceAllocation(MAX_ALLOCATION_WEI + 1n), { ok: false, code: "above-maximum" });
    assert.equal(admitRebalanceAllocation(1n << 256n).ok, false);
  });

  it("uses relative drift equality and rejects unsafe valuation vectors", () => {
    assert.equal(crossedRelativeDrift({ USDC: 45n, WBNB: 55n, ETH: 0n, CAKE: 0n }, LOW_TIER), true);
    assert.equal(crossedRelativeDrift({ USDC: 45n, WBNB: 55n, ETH: 0n, CAKE: 0n }, {
      ...LOW_TIER, driftBps: 1_001n,
    }), false);
    assert.deepEqual(hasAnyRelativeDrift({ USDC: 0n, WBNB: 40n, ETH: 40n, CAKE: 20n }, HIGH_TIER), []);
    assert.throws(() => crossedRelativeDrift({ USDC: -1n, WBNB: 1n, ETH: 0n, CAKE: 0n }, LOW_TIER), /portfolio-amount-invalid/u);
    assert.throws(() => hasAnyRelativeDrift({ USDC: 1n << 256n, WBNB: 0n, ETH: 0n, CAKE: 0n }, LOW_TIER), /portfolio-amount-invalid/u);
  });

  it("advances the schedule strictly beyond completion and skips missed slots", () => {
    const start = 1_800_000_000_000;
    const interval = LOW_TIER.intervalMs;
    assert.equal(nextEligibleSlot(start, start, interval), 1);
    assert.equal(nextEligibleSlot(start, start + interval, interval), 2);
    assert.equal(nextEligibleSlot(start, start + interval * 4 + 1, interval), 5);
    assert.throws(() => nextEligibleSlot(start, start - 1, interval), /schedule-time-invalid/u);
  });
});

describe("Quant rebalancing routes and calls", () => {
  it("enumerates only the fixed direct/USDT/WBNB routes in both directions", () => {
    assert.equal(enumerateRebalanceRoutes("WBNB", "buy").length, 2);
    assert.equal(enumerateRebalanceRoutes("ETH", "buy").length, 3);
    assert.equal(enumerateRebalanceRoutes("CAKE", "sell").length, 3);
    assert.equal(enumerateRebalanceRoutes("WBNB", "sell")[1]?.path[1]?.toLowerCase(), REBALANCE_USDT.toLowerCase());
    assert.equal(validateRebalancePath([REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_ETH], {
      from: REBALANCE_USDC, to: REBALANCE_ETH,
    })?.length, 3);
    assert.equal(validateRebalancePath([REBALANCE_USDC, REBALANCE_ETH, REBALANCE_CAKE], {
      from: REBALANCE_USDC, to: REBALANCE_CAKE,
    }), null);
    assert.equal(validateRebalancePath([REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_USDC], {
      from: REBALANCE_USDC, to: REBALANCE_USDC,
    }), null);
    assert.equal(requiredReferencePath([REBALANCE_USDC, REBALANCE_WBNB])?.length, 3);
    assert.equal(requiredReferencePath(["not-an-address" as never]), null);
  });

  it("builds exactly approve+swap with a stricter identity tag and unique deadlines", () => {
    const first = buildRebalanceCalls({ router: REBALANCE_ROUTER, path: [REBALANCE_USDC, REBALANCE_WBNB],
      amountInWei: E18, quoteOutWei: 2n * E18, recipient: ADDR_A, deadlineSec: 1_800_000_100, actionSequence: 1n });
    const second = buildRebalanceCalls({ router: REBALANCE_ROUTER, path: [REBALANCE_USDC, REBALANCE_WBNB],
      amountInWei: E18, quoteOutWei: 2n * E18, recipient: ADDR_A, deadlineSec: 1_800_000_101, actionSequence: 2n });
    assert.equal(first.calls.length, 2);
    assert(first.minOutWei >= (2n * E18 * 9_950n + 9_999n) / 10_000n);
    assert(first.minOutWei <= 2n * E18);
    assert.notDeepEqual(first.calls, second.calls);
    assert.equal(validateRebalanceCalls({ calls: first.calls, router: REBALANCE_ROUTER, wallet: ADDR_A,
      path: [REBALANCE_USDC, REBALANCE_WBNB], amountInWei: E18, minOutWei: first.minOutWei,
      deadlineSec: 1_800_000_100 })?.minOutWei, first.minOutWei);
    assert.equal(validateRebalanceCalls({ calls: first.calls, router: REBALANCE_ROUTER, wallet: ADDR_B,
      path: [REBALANCE_USDC, REBALANCE_WBNB], amountInWei: E18, minOutWei: first.minOutWei,
      deadlineSec: 1_800_000_100 }), null);
    assert.throws(() => buildRebalanceCalls({ router: ADDR_C, path: [REBALANCE_USDC, REBALANCE_WBNB],
      amountInWei: E18, quoteOutWei: 2n * E18, recipient: ADDR_A, deadlineSec: 1_800_000_100, actionSequence: 1n }), /rebalance-router-refused/u);
    assert(taggedMinimumOutput(100n * E18, 99n) >= (100n * E18 * 9_950n + 9_999n) / 10_000n);
  });

  it("enforces same-block, disjoint V2 references, exact 2% equality, and per-side depth", () => {
    const candidatePath = [REBALANCE_USDC, REBALANCE_WBNB] as const;
    const referencePath = [REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB] as const;
    const pair = (address: string, token0: Address, token1: Address, reserve0: bigint, reserve1: bigint, blockHash = HASH_A): RoutePairEvidence => ({
      address: getAddress(address), token0, token1, reserve0, reserve1, blockHash,
    });
    const candidate = [pair(ADDR_A, REBALANCE_USDC, REBALANCE_WBNB, 200_000n * E18, 204_000n * E18)];
    const reference = [
      pair(ADDR_B, REBALANCE_USDC, REBALANCE_USDT, 200_000n * E18, 200_000n * E18),
      pair(ADDR_C, REBALANCE_USDT, REBALANCE_WBNB, 200_000n * E18, 200_000n * E18),
    ];
    const equal = evaluateReferenceGuard({ candidatePath, candidatePairs: candidate, referencePath, referencePairs: reference,
      candidateBlockHash: HASH_A, referenceBlockHash: HASH_A });
    assert.equal(equal.ok, true);
    const moved = evaluateReferenceGuard({ candidatePath, candidatePairs: [pair(ADDR_A, REBALANCE_USDC, REBALANCE_WBNB, 200_000n * E18, 204_001n * E18)],
      referencePath, referencePairs: reference, candidateBlockHash: HASH_A, referenceBlockHash: HASH_A });
    assert.deepEqual(moved, { ok: false, code: "reference-deviation" });
    const shallow = evaluateReferenceGuard({ candidatePath, candidatePairs: candidate,
      referencePath, referencePairs: [pair(ADDR_B, REBALANCE_USDC, REBALANCE_USDT, 100_000n * E18 - 1n, 100_000n * E18), reference[1]!],
      candidateBlockHash: HASH_A, referenceBlockHash: HASH_A });
    assert.deepEqual(shallow, { ok: false, code: "reference-depth-low" });
    const wrongHash = evaluateReferenceGuard({ candidatePath, candidatePairs: candidate, referencePath,
      referencePairs: reference, candidateBlockHash: HASH_A, referenceBlockHash: HASH_B });
    assert.deepEqual(wrongHash, { ok: false, code: "reference-evidence-invalid" });
    const overlap = evaluateReferenceGuard({ candidatePath, candidatePairs: candidate,
      referencePath, referencePairs: [candidate[0]!, reference[1]!],
      candidateBlockHash: HASH_A, referenceBlockHash: HASH_A });
    assert.deepEqual(overlap, { ok: false, code: "reference-pair-overlap" });
  });

  it("ranks by integer net score, hop count, then canonical route", () => {
    const rows = [
      { outputWei: 10n, feeUsdcWei: 12n, hops: 2, key: "b" },
      { outputWei: 11n, feeUsdcWei: 12n, hops: 1, key: "a" },
      { outputWei: 11n, feeUsdcWei: 12n, hops: 1, key: "b" },
    ];
    assert.deepEqual(rankRoutes(rows, (row) => row.outputWei - row.feeUsdcWei).map((row) => row.key), ["a", "b", "b"]);
  });

  it("selects a portfolio liquidation mark by maximum gross proceeds independent of fees", () => {
    const candidates = [
      { key: "lower-gross", outputWei: 100n, feeUsdcWei: 1n, hops: 1 },
      { key: "higher-gross", outputWei: 101n, feeUsdcWei: 20n, hops: 2 },
    ];
    assert.equal(rankRoutes(candidates, (row) => row.outputWei - row.feeUsdcWei)[0]?.key, "lower-gross");
    assert.equal(selectMaximumGrossLiquidation(candidates)?.key, "higher-gross");
    assert.equal(selectMaximumGrossLiquidation([{ key: "zero", outputWei: 0n }]), null);
  });
});

describe("Quant rebalancing accounting and planning", () => {
  it("requires every positive holding to have one fresh full-balance liquidation mark", () => {
    const managed = { USDC: 5n * E18, WBNB: E18, ETH: 0n, CAKE: 0n };
    const mark: LiquidationMark = { asset: "WBNB", quantityWei: E18, usdcOutWei: 3n * E18,
      path: [REBALANCE_WBNB, REBALANCE_USDC], blockNumber: 123n, blockHash: HASH_A,
      observedAtMs: 50_000, pairAddresses: [ADDR_A], referenceEvidenceDigest: HASH_B };
    const good = valueManagedPortfolio({ managed, marks: [mark], expectedBlockNumber: 123n,
      expectedBlockHash: HASH_A, nowMs: 75_000 });
    assert.equal(good.ok, true);
    assert.equal(good.ok && good.values.WBNB, 3n * E18);
    const missing = valueManagedPortfolio({ managed, marks: [], expectedBlockNumber: 123n,
      expectedBlockHash: HASH_A, nowMs: 75_000 });
    assert.deepEqual(missing, { ok: false, code: "portfolio-quote-missing" });
    const stale = valueManagedPortfolio({ managed, marks: [{ ...mark, observedAtMs: 40_000 }],
      expectedBlockNumber: 123n, expectedBlockHash: HASH_A, nowMs: 75_000 });
    assert.deepEqual(stale, { ok: false, code: "portfolio-mark-mismatch" });
  });

  it("continues an active rebalance below threshold, sells first, and does not rebuy a sold token", () => {
    const values = { USDC: 0n, WBNB: 40_500n, ETH: 39_500n, CAKE: 20_000n };
    assert.equal(hasAnyRelativeDrift(values, HIGH_TIER).length, 0);
    const managed = { USDC: 0n, WBNB: 40_500n, ETH: 39_500n, CAKE: 20_000n };
    assert.deepEqual(planRebalanceLeg({ managed, values, tier: HIGH_TIER, takenAssets: new Set(), checkMode: "candidate" }),
      { kind: "none", reason: "below-threshold" });
    const continuation = planRebalanceLeg({ managed, values, tier: HIGH_TIER, takenAssets: new Set(), checkMode: "continuation" });
    assert.equal(continuation.kind, "sell");
    if (continuation.kind !== "sell") return;
    assert.equal(continuation.asset, "WBNB");
    const next = planRebalanceLeg({ managed: { USDC: 500n, WBNB: 40_000n, ETH: 39_500n, CAKE: 20_000n },
      values: { USDC: 500n, WBNB: 40_000n, ETH: 39_500n, CAKE: 20_000n }, tier: HIGH_TIER,
      takenAssets: new Set(["WBNB"]), checkMode: "continuation" });
    assert.notEqual(next.kind === "buy" ? next.asset : null, "WBNB");
  });

  it("uses no synthetic trade floor and keeps realized basis exact through a final sale", () => {
    const tiny = planRebalanceLeg({ managed: { USDC: 55n * E17, WBNB: 45n * E17, ETH: 0n, CAKE: 0n },
      values: { USDC: 55n * E17, WBNB: 45n * E17, ETH: 0n, CAKE: 0n }, tier: LOW_TIER,
      takenAssets: new Set(), checkMode: "candidate" });
    assert.equal(tiny.kind, "buy");
    if (tiny.kind === "buy") assert(tiny.amountInWei > 0n && tiny.amountInWei < E18);
    const initial = { USDC: 0n, WBNB: 10n * E18, ETH: 0n, CAKE: 0n };
    const basis = { WBNB: 12n * E18, ETH: 0n, CAKE: 0n };
    const partial = applyVerifiedFill(initial, basis, { side: "sell", asset: "WBNB", fillInWei: 3n * E18, fillOutWei: 4n * E18 });
    assert.equal(partial.costBasis.WBNB, 8_400_000_000_000_000_000n);
    const final = applyVerifiedFill(partial.managed, partial.costBasis, {
      side: "sell", asset: "WBNB", fillInWei: 7n * E18, fillOutWei: 8n * E18,
    });
    assert.equal(final.costBasis.WBNB, 0n);
    assert.equal(final.realizedDeltaUsdcWei, -4n * E17);
  });
});

describe("Quant rebalancing config and immutable wire", () => {
  it("keeps the production profile registries and capability switch fail-closed", () => {
    assert.deepEqual(QUANT_EXPANDED_CONFIG_PROFILES.map((profile) => profile.id), ["termix-quant-config-2026-09-27-v1"]);
    assert.deepEqual(QUANT_REBALANCE_CAPABILITY_PROFILES.map((profile) => profile.id), ["termix-rebalance-wizard-v1"]);
    assert.equal(resolveQuantRebalancingEnabled({}), false);
    assert.equal(resolveQuantRebalancingEnabled({ QUANT_REBALANCING_ENABLED: "false" }), false);
    assert.equal(resolveQuantRebalancingEnabled({ QUANT_REBALANCING_ENABLED: "true" }), true);
    assert.throws(() => resolveQuantRebalancingEnabled({ QUANT_REBALANCING_ENABLED: "TRUE" }), /exactly true or false/u);
  });

  it("normalizes exact expanded config sets while preserving decimals and case-sensitive routes", () => {
    const row = (label: string, address: Address) => ({ label, kind: "token", address,
      protocol: null, verified: true, auditUrl: null, officialUrl: null });
    const block = {
      chainId: 56, u: REBALANCE_USDC, uDecimals: 18,
      tradableTokens: [
        { address: REBALANCE_WBNB, decimals: 18, priceRoute: "direct" },
        { address: REBALANCE_CAKE, decimals: 18, priceRoute: "via_wbnb" },
        { address: REBALANCE_ETH, decimals: 18, priceRoute: "via_wbnb" },
        { address: getAddress("0x1111111111111111111111111111111111111111"), decimals: 8, priceRoute: "via_wbnb" },
      ],
      venueAllowlist: [], venueRows: [row("router", REBALANCE_ROUTER), row("usdc", REBALANCE_USDC), row("wbnb", REBALANCE_WBNB)],
    };
    const normalized = normalizeExpandedQuantConfig(block);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const profile: QuantExpandedConfigProfile = {
      id: "offline-exact", capturedEvidenceRef: "fixture", capturedEvidenceDigest: HASH_A,
      expected: normalized.projection, expectedVenueRowCount: 3, expectedUniqueVenueTargetCount: 3,
    };
    assert.equal(findExpandedConfigProfile(normalized.projection, [profile])?.id, "offline-exact");
    const mutated = normalizeExpandedQuantConfig({ ...block,
      tradableTokens: block.tradableTokens.map((row, index) => index === 3 ? { ...row, decimals: 18 } : row),
    });
    assert.equal(mutated.ok, true);
    if (mutated.ok) assert.equal(findExpandedConfigProfile(mutated.projection, [profile]), null);
    const duplicate = normalizeExpandedQuantConfig({ ...block, venueRows: [...block.venueRows, block.venueRows[0]!] });
    assert.equal(duplicate.ok, true);
    if (duplicate.ok) assert.equal(findExpandedConfigProfile(duplicate.projection, [profile]), null);
    assert.deepEqual(expandedConfigVenueTargets(normalized.projection, profile)?.length, 3);
  });

  it("refuses a screenshot-shaped seven-token block without a complete exact profile", () => {
    const xrp = getAddress("0x4100000000000000000000000000000000000001");
    const btcb = getAddress("0x4100000000000000000000000000000000000002");
    const doge = getAddress("0x4100000000000000000000000000000000000003");
    const link = getAddress("0x4100000000000000000000000000000000000004");
    const venusOne = getAddress("0x4200000000000000000000000000000000000001");
    const venusTwo = getAddress("0x4200000000000000000000000000000000000002");
    const block = {
      chainId: 56, u: REBALANCE_USDC, uDecimals: 18,
      tradableTokens: [
        { address: REBALANCE_WBNB, decimals: 18, priceRoute: "direct" },
        { address: REBALANCE_CAKE, decimals: 18, priceRoute: "via_wbnb" },
        { address: xrp, decimals: 18, priceRoute: "via_wbnb" },
        { address: REBALANCE_ETH, decimals: 18, priceRoute: "via_wbnb" },
        { address: btcb, decimals: 18, priceRoute: "via_wbnb" },
        { address: doge, decimals: 8, priceRoute: "via_wbnb" },
        { address: link, decimals: 18, priceRoute: "via_wbnb" },
      ],
      venueAllowlist: [], venueRows: [REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_CAKE,
        xrp, REBALANCE_ETH, btcb, doge, link, venusOne, venusTwo].map((address, index) => ({
          label: `row-${index}`, kind: "token", address, protocol: null, verified: true, auditUrl: null, officialUrl: null,
        })),
    };
    const normalized = normalizeExpandedQuantConfig(block);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    assert.equal(normalized.projection.tradableTokens.find((row) => row.address === doge.toLowerCase())?.decimals, 8);
    assert.equal(normalized.projection.venueRows.some((row) => row.address === REBALANCE_USDT.toLowerCase()), false);
    const profile: QuantExpandedConfigProfile = { id: "screenshot-shape-fixture",
      capturedEvidenceRef: "offline-only-fixture", capturedEvidenceDigest: HASH_A,
      expected: normalized.projection, expectedVenueRowCount: 11, expectedUniqueVenueTargetCount: 11 };
    assert.equal(findExpandedConfigProfile(normalized.projection, [profile])?.id, profile.id);
    const changed = normalizeExpandedQuantConfig({ ...block, tradableTokens: block.tradableTokens.map((row) =>
      row.address.toLowerCase() === doge.toLowerCase() ? { ...row, priceRoute: "via_WBNB" } : row) });
    assert.equal(changed.ok, true);
    if (changed.ok) assert.equal(findExpandedConfigProfile(changed.projection, [profile]), null);
    const withoutVenue = normalizeExpandedQuantConfig({ ...block, venueRows: block.venueRows.slice(0, -1) });
    assert.equal(withoutVenue.ok, true);
    if (withoutVenue.ok) assert.equal(findExpandedConfigProfile(withoutVenue.projection, [profile]), null);
  });

  it("does not bind normal mutable TermiX status or revoke changes into the immutable wire digest", () => {
    const job: QuantJobRecord = {
      id: "job-1", status: "ACTIVE", strategyId: "strategy-1", tradingWalletAddress: ADDR_A,
      allocationUWei: 75n * E18, dailyCapUWei: 100n * E18, termDays: 30,
      startedAtMs: 10_000, endsAtMs: 20_000, sessionExpiresAtMs: 18_000, revokedAtMs: null,
    };
    assert.equal(quantRebalanceImmutableWireDigest(job), quantRebalanceImmutableWireDigest({ ...job, status: "PAUSED" }));
    assert.equal(quantRebalanceImmutableWireDigest(job), quantRebalanceImmutableWireDigest({ ...job, revokedAtMs: 15_000 }));
    assert.notEqual(quantRebalanceImmutableWireDigest(job), quantRebalanceImmutableWireDigest({ ...job, allocationUWei: job.allocationUWei + 1n }));
    assert.notEqual(quantRebalanceImmutableWireDigest(job), quantRebalanceImmutableWireDigest({ ...job, tradingWalletAddress: ADDR_B }));
  });

  it("recomputes future-exit obligations at claim-time gas for every resulting position", () => {
    const managed = { WBNB: E18, ETH: E18, CAKE: 0n };
    const lowGasReserve = requiredNativeReserve({ side: "buy", ownSolvencyWei: 10n, gasPriceWei: 1n,
      maximumExitGasUnits: 500_000n, managed, asset: "CAKE", resultingQuantityWei: E18 });
    const highGasReserve = requiredNativeReserve({ side: "buy", ownSolvencyWei: 10n, gasPriceWei: 100n * 10n ** 9n,
      maximumExitGasUnits: 500_000n, managed, asset: "CAKE", resultingQuantityWei: E18 });
    assert.ok(highGasReserve > lowGasReserve, "a gas spike raises WBNB, ETH and new CAKE exit obligations");
    assert.equal(requiredNativeReserve({ side: "sell", ownSolvencyWei: 10n, gasPriceWei: 100n * 10n ** 9n,
      maximumExitGasUnits: 500_000n, managed, asset: "CAKE", resultingQuantityWei: 0n }), 10n,
    "sells reserve their own fee and do not carry future buys/exits");
  });
});
