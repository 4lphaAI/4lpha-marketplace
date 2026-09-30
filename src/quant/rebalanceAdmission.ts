/** Rebalancing session grant projection and all-or-nothing policy admission. */
import { getAddress, toFunctionSelector, type Address } from "viem";
import { privateKeyToAddress, publicKeyToAddress } from "viem/accounts";
import { APPROVE_SIGNATURE, SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE } from "../ops/pancakeTokens.js";
import type { QuantJobRecord, QuantSessionPlaintext } from "./types.js";
import {
  descriptorOf, permissionsDigest, projectGrantedPermissions, specDigest,
  TOLERATED_PLATFORM_TARGETS_56,
} from "./admission.js";
import { encodeJsonbParam } from "../store/codec.js";
import {
  BPS, G2_FINITE_CAPABILITY_ID, G2_FINITE_NATIVE_DAY_CAP_WEI,
  REBALANCE_ROUTER, REBALANCE_TOKEN_ADDRESSES, rebalanceTierForProfile,
  rebalanceJobPolicyDigest, rebalanceJobPolicyProjection, type RebalanceTier,
} from "./rebalancePolicy.js";
import type { QuantRebalanceCapabilityProfile } from "./rebalanceConfig.js";
import { enumerateRebalanceRoutes, rebalancePathKey, requiredReferencePath } from "./rebalanceRoutes.js";

export type RebalanceSessionAdmission = {
  readonly ok: true;
  readonly tier: RebalanceTier;
  readonly policyJson: string;
  readonly policyDigest: `0x${string}`;
  readonly sessionPublicKey: `0x${string}`;
  readonly sessionExpirySec: number;
  readonly permissionsDigest: `0x${string}`;
  readonly projectionDigest: `0x${string}`;
  readonly descriptorJson: string;
  readonly projectionJson: string;
  readonly capRowsJson: string;
  readonly grantShape: "selector-scoped" | "whole-contract";
  readonly targets: readonly Address[];
};
export type RebalanceAdmissionRefusal = {
  readonly ok: false;
  readonly code: string;
};
export type RebalanceAdmissionResult = RebalanceSessionAdmission | RebalanceAdmissionRefusal;

const APPROVE_SELECTOR = toFunctionSelector(APPROVE_SIGNATURE).toLowerCase();
const SWAP_SELECTOR = toFunctionSelector(SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE).toLowerCase();
const PERIODS = new Set(["minute", "hour", "day", "week", "month", "year"]);

function refuse(code: string): RebalanceAdmissionRefusal { return { ok: false, code }; }
function signatureSelector(signature: string | undefined): string | null {
  if (signature === undefined) return null;
  try { return toFunctionSelector(signature).toLowerCase(); } catch { return "invalid"; }
}

function riskAssets(tier: RebalanceTier): readonly ("WBNB" | "ETH" | "CAKE")[] { return tier.orderedRiskAssets; }

function allowedWholeTargets(profile: QuantRebalanceCapabilityProfile, requiredAddresses: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([
    REBALANCE_ROUTER,
    ...[...requiredAddresses],
    ...profile.toleratedGrantTargets,
    ...TOLERATED_PLATFORM_TARGETS_56,
  ].map((address) => address.toLowerCase()));
}

export function admitRebalanceSession(input: {
  readonly session: QuantSessionPlaintext;
  readonly job: QuantJobRecord;
  readonly capabilityProfile: QuantRebalanceCapabilityProfile;
  readonly nowMs: number;
}): RebalanceAdmissionResult {
  const allocation = rebalanceTierForProfile(input.job.allocationUWei, input.capabilityProfile.id);
  if (!allocation.ok) return refuse(allocation.code);
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 || input.job.startedAtMs === null
    || input.job.endsAtMs === null || input.job.sessionExpiresAtMs === null
    || input.job.startedAtMs <= 0 || input.job.endsAtMs <= input.job.startedAtMs
    || input.job.sessionExpiresAtMs <= input.nowMs || input.job.dailyCapUWei < allocation.allocationWei) return refuse("job-wire-invalid");
  if (input.capabilityProfile.id === G2_FINITE_CAPABILITY_ID
    && (input.job.id !== "self-test-rebalance-g2-high75-finite-v2"
      || input.job.allocationUWei !== 75n * 10n ** 18n || input.job.termDays !== 2
      || input.job.endsAtMs - input.job.startedAtMs !== 2 * 86_400_000
      || input.job.sessionExpiresAtMs - input.job.endsAtMs !== 600_000)) return refuse("finite-job-wire-invalid");
  const session = input.session;
  if (session.walletAddress.toLowerCase() !== input.job.tradingWalletAddress.toLowerCase()) return refuse("session-wallet-mismatch");
  if (session.expiry <= Math.floor(input.nowMs / 1_000)
    || session.expiry > Math.floor(input.job.sessionExpiresAtMs / 1_000) + 300) return refuse("session-expiry-mismatch");
  if (input.capabilityProfile.id === G2_FINITE_CAPABILITY_ID
    && session.expiry * 1_000 !== input.job.sessionExpiresAtMs) return refuse("finite-session-expiry-mismatch");
  let derivedAddress: Address;
  try {
    derivedAddress = publicKeyToAddress(session.publicKey);
    if (privateKeyToAddress(session.signerPrivateKey).toLowerCase() !== derivedAddress.toLowerCase()) return refuse("session-key-mismatch");
  } catch { return refuse("session-key-mismatch"); }

  const capPeriods = new Set<string>();
  for (const cap of session.permissions.spend) {
    if (!PERIODS.has(cap.period) || cap.limit <= 0n || cap.limit >= (1n << 256n)) return refuse("session-cap-invalid");
    let token: string;
    try { token = cap.token === undefined ? "native" : getAddress(cap.token).toLowerCase(); }
    catch { return refuse("session-cap-invalid"); }
    const key = `${token}|${cap.period}`;
    if (capPeriods.has(key)) return refuse("session-cap-duplicate-period");
    capPeriods.add(key);
  }

  const projection = projectGrantedPermissions(session.permissions, {
    expiry: session.expiry, nowSeconds: Math.floor(input.nowMs / 1_000),
    termDays: input.job.termDays, walletAddress: session.walletAddress,
  });
  if (!projection.ok) return refuse(projection.code);
  let policyProjection: ReturnType<typeof rebalanceJobPolicyProjection>;
  let policyDigest: `0x${string}`;
  try {
    policyProjection = rebalanceJobPolicyProjection({
      capabilityProfileId: input.capabilityProfile.id, jobId: input.job.id,
      strategyId: input.job.strategyId, allocationWei: input.job.allocationUWei,
      tier: allocation.tier, startedAtMs: input.job.startedAtMs,
      endsAtMs: input.job.endsAtMs, sessionExpiresAtMs: input.job.sessionExpiresAtMs,
    });
    policyDigest = rebalanceJobPolicyDigest({
      capabilityProfileId: input.capabilityProfile.id, jobId: input.job.id,
      strategyId: input.job.strategyId, allocationWei: input.job.allocationUWei,
      tier: allocation.tier, startedAtMs: input.job.startedAtMs,
      endsAtMs: input.job.endsAtMs, sessionExpiresAtMs: input.job.sessionExpiresAtMs,
    });
  } catch { return refuse("job-policy-invalid"); }
  const calls = session.permissions.calls;
  if (calls.length === 0) return refuse("session-grants-missing");
  const whole = calls.some((rule) => rule.signature === undefined);
  const selector = calls.some((rule) => rule.signature !== undefined);
  if (whole && selector) return refuse("session-grant-shape-mixed");
  const grantShape = whole ? "whole-contract" : "selector-scoped";
  const targets = new Set<string>();
  const approvals = new Set<string>();
  let hasRouterSwap = false;
  const requiredInputs = ["USDC", ...riskAssets(allocation.tier)] as const;
  const requiredAddresses = new Set(requiredInputs.map((asset) => REBALANCE_TOKEN_ADDRESSES[asset].toLowerCase()));
  const wholeTargets = allowedWholeTargets(input.capabilityProfile, requiredAddresses);
  const targetCounts = new Map<string, number>();
  for (const row of calls) {
    if (row.to === undefined) return refuse("session-grant-unbound");
    let target: string;
    try { target = getAddress(row.to).toLowerCase(); } catch { return refuse("session-grant-invalid"); }
    const priorCount = targetCounts.get(target) ?? 0;
    if (priorCount > 0 && (grantShape !== "whole-contract" || priorCount > 1
      || !input.capabilityProfile.duplicateWholeGrantTargets.some((address) => address.toLowerCase() === target))) {
      return refuse("session-grant-duplicate");
    }
    targetCounts.set(target, priorCount + 1);
    targets.add(target);
    if (grantShape === "whole-contract") {
      if (row.signature !== undefined || !wholeTargets.has(target)) return refuse("session-grant-excess");
      continue;
    }
    const selectorId = signatureSelector(row.signature);
    if (selectorId === "invalid" || row.signature === undefined) return refuse("session-grant-invalid");
    if (target === REBALANCE_ROUTER.toLowerCase() && selectorId === SWAP_SELECTOR) {
      hasRouterSwap = true; continue;
    }
    if (requiredAddresses.has(target) && selectorId === APPROVE_SELECTOR) {
      if (approvals.has(target)) return refuse("session-grant-duplicate");
      approvals.add(target); continue;
    }
    return refuse("session-grant-excess");
  }
  if (grantShape === "selector-scoped") {
    if (!hasRouterSwap) return refuse("session-missing-grant-swap");
    for (const target of requiredAddresses) if (!approvals.has(target)) return refuse("session-missing-grant-approve");
  } else {
    if (!targets.has(REBALANCE_ROUTER.toLowerCase())) return refuse("session-missing-grant-swap");
    for (const target of requiredAddresses) if (!targets.has(target)) return refuse("session-missing-grant-approve");
  }
  if (!input.capabilityProfile.grantShapes.includes(grantShape)) return refuse("capability-grant-shape-unconfirmed");

  // A profile binds canonical paths, never labels such as "via_wbnb". Missing
  // candidates are omitted individually, but every basket asset needs at least
  // one supported executable path and its explicit independent reference in
  // both directions.
  for (const asset of allocation.tier.orderedRiskAssets) for (const direction of ["buy", "sell"] as const) {
    const viable = enumerateRebalanceRoutes(asset, direction).some((route) => {
      const reference = requiredReferencePath(route.path);
      return reference !== null
        && input.capabilityProfile.executionRoutes.some((path) => path.toLowerCase() === rebalancePathKey(route.path))
        && input.capabilityProfile.referenceRoutes.some((path) => path.toLowerCase() === rebalancePathKey(reference));
    });
    if (!viable) return refuse("capability-route-unavailable");
  }

  const spend = session.permissions.spend;
  if (spend.length === 0) return refuse("session-caps-missing");
  const initialRiskWeightBps = allocation.tier.orderedRiskAssets.reduce(
    (sum, asset) => sum + (allocation.tier.targetWeightsBps[asset] ?? 0n), 0n);
  const initialUsdcSpendWei = allocation.allocationWei * initialRiskWeightBps / BPS;
  const capRowsSeen = new Set<string>();
  for (const cap of spend) {
    if (!PERIODS.has(cap.period) || cap.limit <= 0n || cap.limit >= (1n << 256n)) return refuse("session-cap-invalid");
    let token: string | null;
    try { token = cap.token === undefined ? null : getAddress(cap.token).toLowerCase(); } catch { return refuse("session-cap-invalid"); }
    const capIdentity = `${token ?? "native"}|${cap.period}`;
    if (capRowsSeen.has(capIdentity)) return refuse("session-cap-duplicate-period");
    capRowsSeen.add(capIdentity);
    if (token === null) continue;
    if (!requiredAddresses.has(token)
      && !input.capabilityProfile.toleratedGrantTargets.some((address) => address.toLowerCase() === token)) return refuse("session-cap-excess");
  }
  for (const asset of requiredInputs) {
    const target = REBALANCE_TOKEN_ADDRESSES[asset].toLowerCase();
    const caps = spend.filter((cap) => cap.token !== undefined && cap.token.toLowerCase() === target);
    if (caps.length === 0) return refuse("session-cap-missing");
    if (asset === "USDC" && caps.some((cap) => cap.limit < initialUsdcSpendWei)) return refuse("session-cap-too-small");
  }
  const nativeCaps = spend.filter((cap) => cap.token === undefined);
  if (nativeCaps.length === 0) return refuse("session-native-cap-missing");
  if (input.capabilityProfile.id === G2_FINITE_CAPABILITY_ID
    && (nativeCaps.length !== 1 || nativeCaps[0]?.period !== "day"
      || nativeCaps[0].limit !== G2_FINITE_NATIVE_DAY_CAP_WEI)) return refuse("finite-native-cap-invalid");
  const capRows = spend.map((cap) => ({ token: cap.token?.toLowerCase() ?? null, period: cap.period, limit: cap.limit.toString(10) }))
    .sort((a, b) => `${a.token}|${a.period}|${a.limit}`.localeCompare(`${b.token}|${b.period}|${b.limit}`));
  const descriptor = descriptorOf(session);
  return {
    ok: true, tier: allocation.tier, policyJson: encodeJsonbParam(policyProjection), policyDigest,
    sessionPublicKey: session.publicKey, sessionExpirySec: session.expiry,
    permissionsDigest: permissionsDigest(session.permissions), projectionDigest: specDigest(projection.spec),
    descriptorJson: encodeJsonbParam(descriptor), projectionJson: encodeJsonbParam(projection.spec),
    capRowsJson: JSON.stringify(capRows), grantShape, targets: [...targets].sort() as Address[],
  };
}
