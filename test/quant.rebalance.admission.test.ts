import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { parseSessionPlaintext } from "../src/quant/admission.js";
import { admitRebalanceSession } from "../src/quant/rebalanceAdmission.js";
import { REBALANCE_ETH, REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";
import { enumerateRebalanceRoutes, rebalancePathKey, requiredReferencePath } from "../src/quant/rebalanceRoutes.js";
import type { QuantRebalanceCapabilityProfile } from "../src/quant/rebalanceConfig.js";
import type { QuantJobRecord } from "../src/quant/types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: Record<string, unknown> };
const wizard = JSON.parse(readFileSync(new URL("./fixtures/quant/wizard-session-shape.json", import.meta.url), "utf8")) as { permissions: { calls: readonly { to: string }[]; spend: readonly unknown[] } };
const NOW_MS = (1_800_000_000 - 2 * 86_400) * 1_000;
const DIGEST = `0x${"ab".repeat(32)}` as Hex;

function routeSet(assets: readonly ("WBNB" | "ETH" | "CAKE")[]): { executionRoutes: string[]; referenceRoutes: string[] } {
  const executionRoutes = new Set<string>(); const referenceRoutes = new Set<string>();
  for (const asset of assets) for (const direction of ["buy", "sell"] as const) for (const route of enumerateRebalanceRoutes(asset, direction)) {
    executionRoutes.add(rebalancePathKey(route.path));
    const reference = requiredReferencePath(route.path);
    if (reference !== null) referenceRoutes.add(rebalancePathKey(reference));
  }
  return { executionRoutes: [...executionRoutes], referenceRoutes: [...referenceRoutes] };
}

function capability(input: Partial<QuantRebalanceCapabilityProfile> = {}): QuantRebalanceCapabilityProfile {
  const routes = routeSet(["WBNB", "ETH", "CAKE"]);
  return {
    id: "offline-capability", capturedConfigProfileId: "offline-config", wireVersion: "fixture-v1",
    grantShapes: ["whole-contract", "selector-scoped"], toleratedGrantTargets: [],
    duplicateWholeGrantTargets: [REBALANCE_USDC],
    executionRoutes: routes.executionRoutes, referenceRoutes: routes.referenceRoutes,
    maximumExitGasUnits: 500_000n, indexingEvidenceDigest: DIGEST, reportEvidenceDigest: DIGEST,
    ...input,
  };
}

function sessionWithPermissions(permissions: unknown) {
  const result = parseSessionPlaintext(JSON.stringify({ ...fixture.session, permissions }, (_key, value: unknown) =>
    typeof value === "bigint" ? { "$bigint": value.toString(10) } : value));
  assert.equal(result.ok, true, result.ok ? "" : result.code);
  return result.ok ? result.session : null;
}

function job(session: NonNullable<ReturnType<typeof sessionWithPermissions>>, allocationWei: bigint): QuantJobRecord {
  return {
    id: "admission-job", status: "ACTIVE", strategyId: "strategy-1",
    tradingWalletAddress: getAddress(session.walletAddress), allocationUWei: allocationWei,
    dailyCapUWei: allocationWei, termDays: 30, startedAtMs: NOW_MS - 60_000,
    endsAtMs: session.expiry * 1_000, sessionExpiresAtMs: session.expiry * 1_000, revokedAtMs: null,
  };
}

function callPermissions(): { calls: { to: Address; signature?: string }[]; spend: { token?: Address; limit: bigint; period: string }[] } {
  const base = fixture.session["permissions"] as { calls: { to: Address; signature?: string }[]; spend: { token?: Address; limit: bigint; period: string }[] };
  return structuredClone(base);
}

describe("Quant rebalancing grant and session admission", () => {
  it("admits the wizard's duplicate whole-contract USDC target only when the profile explicitly permits it", () => {
    const permissions = structuredClone(wizard.permissions) as { calls: { to: Address }[]; spend: unknown[] };
    const session = sessionWithPermissions(permissions);
    if (session === null) return;
    const input = { session, job: job(session, 10n * 10n ** 18n), capabilityProfile: capability(), nowMs: NOW_MS };
    assert.equal(admitRebalanceSession(input).ok, true);
    const refused = admitRebalanceSession({ ...input, capabilityProfile: capability({ duplicateWholeGrantTargets: [] }) });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "session-grant-duplicate");
  });

  it("refuses high-tier fallback when ETH/CAKE capabilities or caps are missing", () => {
    const permissions = callPermissions();
    const session = sessionWithPermissions(permissions);
    if (session === null) return;
    const result = admitRebalanceSession({ session, job: job(session, 75n * 10n ** 18n),
      capabilityProfile: capability(), nowMs: NOW_MS });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "session-missing-grant-approve");
  });

  it("admits selector-scoped only for the fixed low-tier input set and refuses excess targets", () => {
    const permissions = callPermissions();
    permissions.calls = [
      { to: REBALANCE_ROUTER, signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" },
      { to: REBALANCE_USDC, signature: "approve(address,uint256)" },
      { to: REBALANCE_WBNB, signature: "approve(address,uint256)" },
    ];
    const session = sessionWithPermissions(permissions);
    if (session === null) return;
    const input = { session, job: job(session, 10n * 10n ** 18n), capabilityProfile: capability({ duplicateWholeGrantTargets: [] }), nowMs: NOW_MS };
    const result = admitRebalanceSession(input);
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (result.ok) assert.equal(result.grantShape, "selector-scoped");
    const extraSession = sessionWithPermissions({ ...permissions,
      calls: [...permissions.calls, { to: REBALANCE_ETH, signature: "approve(address,uint256)" }],
      spend: [...permissions.spend, { token: REBALANCE_ETH, limit: 100n * 10n ** 18n, period: "day" }],
    });
    if (extraSession === null) return;
    const extra = admitRebalanceSession({ ...input, session: extraSession });
    assert.equal(extra.ok, false);
    if (!extra.ok) assert.notEqual(extra.code, "session-projection-invalid");
  });

  it("rejects duplicate cap periods and the above-maximum atomic neighbor", () => {
    const permissions = callPermissions();
    permissions.spend.push({ token: REBALANCE_USDC, limit: 1_000n * 10n ** 18n, period: "day" });
    const session = sessionWithPermissions(permissions);
    if (session === null) return;
    const duplicate = admitRebalanceSession({ session, job: job(session, 10n * 10n ** 18n), capabilityProfile: capability(), nowMs: NOW_MS });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.code, "session-cap-duplicate-period");
    const above = admitRebalanceSession({ session, job: job(session, 1_000n * 10n ** 18n + 1n), capabilityProfile: capability(), nowMs: NOW_MS });
    assert.equal(above.ok, false);
    if (!above.ok) assert.equal(above.code, "above-maximum");
  });

  it("requires exact per-asset buy/sell and reference paths; unsupported upper-tier candidates refuse", () => {
    const permissions = callPermissions();
    permissions.calls = [
      { to: REBALANCE_ROUTER, signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" },
      ...[REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_ETH, getAddress("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82")]
        .map((to) => ({ to, signature: "approve(address,uint256)" })),
    ];
    permissions.spend.push({ token: REBALANCE_ETH, limit: 100n * 10n ** 18n, period: "day" });
    permissions.spend.push({ token: getAddress("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"), limit: 100n * 10n ** 18n, period: "day" });
    const session = sessionWithPermissions(permissions);
    assert(session !== null);
    const high = job(session, 75n * 10n ** 18n);
    const highRoutes = routeSet(["WBNB", "ETH"]);
    const unsupported = admitRebalanceSession({ session, job: high,
      capabilityProfile: capability(highRoutes), nowMs: NOW_MS });
    assert.deepEqual(unsupported, { ok: false, code: "capability-route-unavailable" });

    const lowRoutes = routeSet(["WBNB"]);
    const lowSession = sessionWithPermissions(callPermissions());
    assert(lowSession !== null);
    const low = admitRebalanceSession({ session: lowSession, job: job(lowSession, 10n * 10n ** 18n),
      capabilityProfile: capability(lowRoutes), nowMs: NOW_MS });
    assert.equal(low.ok, true);
  });

  it("permits direct-only WBNB with USDT retained as a read-only reference path", () => {
    const permissions = callPermissions();
    permissions.calls = [
      { to: REBALANCE_ROUTER, signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" },
      { to: REBALANCE_USDC, signature: "approve(address,uint256)" },
      { to: REBALANCE_WBNB, signature: "approve(address,uint256)" },
    ];
    const session = sessionWithPermissions(permissions);
    assert(session !== null);
    const direct = routeSet(["WBNB"]);
    const directOnly = {
      ...direct,
      executionRoutes: direct.executionRoutes.filter((path) => !path.toLowerCase().includes(REBALANCE_USDT.toLowerCase())),
    };
    assert.ok(directOnly.executionRoutes.every((path) => !path.toLowerCase().includes(REBALANCE_USDT.toLowerCase())));
    assert.ok(directOnly.referenceRoutes.some((path) => path.toLowerCase().includes(REBALANCE_USDT.toLowerCase())));
    const result = admitRebalanceSession({ session, job: job(session, 10n * 10n ** 18n),
      capabilityProfile: capability(directOnly), nowMs: NOW_MS });
    assert.equal(result.ok, true, result.ok ? "" : result.code);
  });
});
