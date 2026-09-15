// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerActionEnvelope } from "@/lib/exec/owner-action";
import type { HireArmPlan, HireArmPlanOutcome } from "@/lib/altana/hire-state";

vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => ({}) }));

import { armGridAgent } from "./GridLiveDeploy";

/**
 * HIRE-SIGNATURES-BC audit: the grid continuation consumer is mocked out of the
 * hire recovery suite, so its own branching is pinned here — one POST carrying
 * the provision envelope and an empty body, and the four outcome branches.
 */
const envelope: OwnerActionEnvelope = {
  signed: {
    owner: "0x2222222222222222222222222222222222222222", action: "provisionAgent", agentId: "grid-agent-01",
    nonce: `0x${"11".repeat(32)}`, paramsHash: `0x${"22".repeat(32)}`, issuedAt: "1", expiry: "2",
  },
  signature: "0xsig",
  params: {},
} as unknown as OwnerActionEnvelope;

const pool = {
  pool: "0x3333333333333333333333333333333333333333", token0: "0x1111111111111111111111111111111111111111",
  token1: "0x4444444444444444444444444444444444444444", fee: 100, wbnbIsToken0: true,
} as unknown as Parameters<typeof armGridAgent>[0]["pool"];

function plan(outcome: HireArmPlanOutcome | null): HireArmPlan {
  return { digest: `0x${"33".repeat(32)}`, kind: "grid", claim: { by: "continuation", claimedAtSec: 1, outcome } };
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function run(extra: Partial<Parameters<typeof armGridAgent>[0]> = {}) {
  const signEnvelope = vi.fn();
  const onArmPlanFallback = vi.fn();
  const onArmPlanOutcome = vi.fn();
  const promise = armGridAgent({
    agentId: "grid-agent-01", pool, uiPresetId: "balanced", capitalBnb: "0.03", stopLossPct: 0, takeProfitPct: 0,
    signEnvelope, hireProfile: "grid-shift-v1",
    provisionEnvelope: envelope, armPlan: { digest: `0x${"33".repeat(32)}`, kind: "grid", claim: null },
    onArmPlanFallback, onArmPlanOutcome,
    ...extra,
  });
  return { promise, signEnvelope, onArmPlanFallback, onArmPlanOutcome };
}

describe("armGridAgent by provision continuation", () => {
  it("POSTs the provision envelope with an empty body, signs nothing, and returns on completed", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { arm: { status: "completed", tokenId: "7" }, armPlan: plan({ status: "completed", atSec: 2 }) } }), { status: 200 }));
    const { promise, signEnvelope, onArmPlanFallback, onArmPlanOutcome } = run();
    const data = await promise;
    expect((data["arm"] as { tokenId: string }).tokenId).toBe("7");
    expect(signEnvelope).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/agents/grid-agent-01/grid/arm");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    expect(new Headers(init?.headers).get("x-provision-action")).toBeTruthy();
    expect(onArmPlanOutcome).toHaveBeenCalledTimes(1);
    expect(onArmPlanFallback).not.toHaveBeenCalled();
  });

  it("offers the signed fallback on a proven rollback and on a pre-claim 400, never on held/interrupted", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { arm: { status: "rolled-back" }, armPlan: plan({ status: "rolled-back", message: "reverted", atSec: 2 }) } }), { status: 200 }));
    const rolled = run();
    await expect(rolled.promise).rejects.toThrow(/reverted/u);
    expect(rolled.onArmPlanFallback).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "invalid_request", message: "tickSpacing mismatch" } }), { status: 400 }));
    const refused = run();
    await expect(refused.promise).rejects.toThrow(/tickSpacing mismatch/u);
    expect(refused.onArmPlanFallback).toHaveBeenCalledTimes(1);

    for (const status of ["held", "interrupted"] as const) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { arm: { status: "held" }, armPlan: plan({ status, sequenceId: "seq-1", message: "settle it", atSec: 2 }) } }), { status: 200 }));
      const held = run();
      await expect(held.promise).rejects.toThrow(/settle it/u);
      expect(held.onArmPlanFallback).not.toHaveBeenCalled();
      expect(held.signEnvelope).not.toHaveBeenCalled();
    }
  });

  it("takes the signed door when the plan is already claimed or the fallback was chosen", async () => {
    // No provision POST: the signed path reads the tick from /api/pool-state first, which this stub refuses.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "unavailable" } }), { status: 503 }));
    const claimed = run({ armPlan: plan({ status: "completed", atSec: 2 }) });
    await expect(claimed.promise).rejects.toThrow();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/pool-state");
    fetchMock.mockClear();
    const fallback = run({ armPlanFallback: "signed" });
    await expect(fallback.promise).rejects.toThrow();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/pool-state");
  });
});
