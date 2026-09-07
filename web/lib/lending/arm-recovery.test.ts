import { describe, expect, it, vi } from "vitest";

import { paramsHash } from "@/lib/exec/owner-action";
import type { LendingGuardStatus } from "@/lib/exec/lending-types";
import {
  lendingArmSettingsFromView,
  recoverLendingArmParams,
  shortDigest,
} from "./arm-recovery";

const ID = "lending-agent-01";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const V_USDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const ACCOUNT = "0x3333333333333333333333333333333333333333";
const BUDGET = "500000000000000000";

/** The settings the owner signed at S1, as `lendingSettingsView` echoes them. */
const SETTINGS_VIEW = {
  triggerHf: "1350000000000000000",
  targetHf: "1900000000000000000",
  maxPerAction: [{ token: USDT, maxWei: "400000000000000000000" }],
  minSecondsBetweenActions: 900,
  rescueReserveCount: 12,
  notifyOnlyBelowHf: null as string | null,
};

/** The bytes the plane hashed: the same object WITHOUT the null optional. */
const SIGNED_PARAMS = {
  triggerHf: "1350000000000000000",
  targetHf: "1900000000000000000",
  maxPerAction: [{ token: USDT, maxWei: "400000000000000000000" }],
  minSecondsBetweenActions: 900,
  rescueReserveCount: 12,
};

const DIGEST = paramsHash("lendingSettings", SIGNED_PARAMS);

function viewBody(overrides: {
  readonly status?: LendingGuardStatus;
  readonly reserveBps?: number;
  readonly settings?: unknown;
  readonly settingsDigest?: string | null;
} = {}) {
  return {
    data: {
      guard: {
        status: overrides.status ?? "provisioning-guard",
        hold: null,
        guardedAccount: ACCOUNT,
        debtMarkets: [V_USDT],
        reserveBps: overrides.reserveBps ?? 3_000,
        // ZERO before the first arm — which is exactly why the budget must come
        // from the hire sizing and not from this row.
        budgetWei: "0",
        reserveCapWei: "44000000000000000000",
        armTxHash: null,
        armBlock: null,
        closeReason: null,
        actionSeq: 0,
        lastActionAtMs: null,
        updatedAtMs: 1_700_000_000_000,
      },
      snapshot: {
        presentAt: null, ageMs: null, staleAfterMs: 60_000, stale: true,
        reason: "The worker has not reported for this guard yet.",
        workerIntervalMs: 30_000, payload: null,
      },
      rescues: [],
      settings: overrides.settings === undefined ? SETTINGS_VIEW : overrides.settings,
      settingsDigest: overrides.settingsDigest === undefined ? DIGEST : overrides.settingsDigest,
      session: { expiresAt: 9_999_999_999, expiring: false },
      recovery: { note: "recoverable with your passkey" },
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

function fetcherFor(response: Response | (() => Promise<Response>)) {
  return vi.fn<typeof fetch>(async () =>
    typeof response === "function" ? await response() : response.clone());
}

describe("lendingArmSettingsFromView", () => {
  it("drops a null notifyOnlyBelowHf, because absent and null hash differently", () => {
    const rebuilt = lendingArmSettingsFromView(SETTINGS_VIEW) as unknown as Record<string, unknown>;
    expect("notifyOnlyBelowHf" in rebuilt).toBe(false);
    expect(rebuilt).toEqual(SIGNED_PARAMS);
    expect(paramsHash("lendingSettings", rebuilt)).toBe(DIGEST);
  });

  it("carries notifyOnlyBelowHf when the owner signed one", () => {
    const withFlag = { ...SETTINGS_VIEW, notifyOnlyBelowHf: "1600000000000000000" };
    const rebuilt = lendingArmSettingsFromView(withFlag) as unknown as Record<string, unknown>;
    expect(rebuilt["notifyOnlyBelowHf"]).toBe("1600000000000000000");
    expect(paramsHash("lendingSettings", rebuilt))
      .toBe(paramsHash("lendingSettings", { ...SIGNED_PARAMS, notifyOnlyBelowHf: "1600000000000000000" }));
  });
});

describe("recoverLendingArmParams — the second device (FIXREVIEW F2)", () => {
  it("rebuilds the three values P19 compares, from the plane's own record", async () => {
    const fetcher = fetcherFor(json(viewBody()));
    const recovery = await recoverLendingArmParams({
      agentId: ID, hireBudgetWei: BUDGET, headers: { "x-owner-action": "signed" }, fetcher,
    });
    expect(recovery.kind).toBe("recovered");
    if (recovery.kind !== "recovered") return;
    expect(recovery.values.settings).toEqual(SIGNED_PARAMS);
    // The BUDGET is the hire's, never the guard row's zero.
    expect(recovery.values.budgetWei).toBe(BUDGET);
    expect(recovery.values.reserveBps).toBe(3_000);
    expect(recovery.digest).toBe(DIGEST);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(`/api/agents/${ID}/lending/view`);
    expect((init as RequestInit & { headers: Record<string, string> }).headers)
      .toEqual({ "x-owner-action": "signed" });
  });

  it("recovers on a closed guard too — the plane's own re-arm path", async () => {
    const recovery = await recoverLendingArmParams({
      agentId: ID, hireBudgetWei: BUDGET, fetcher: fetcherFor(json(viewBody({ status: "closed" }))),
    });
    expect(recovery.kind).toBe("recovered");
  });

  it("REFUSES a digest this browser cannot reproduce, and signs nothing", async () => {
    const other = paramsHash("lendingSettings", { ...SIGNED_PARAMS, rescueReserveCount: 3 });
    const recovery = await recoverLendingArmParams({
      agentId: ID, hireBudgetWei: BUDGET,
      fetcher: fetcherFor(json(viewBody({ settingsDigest: other }))),
    });
    expect(recovery.kind).toBe("refused");
    if (recovery.kind !== "refused") return;
    expect(recovery.reason).toContain(shortDigest(DIGEST));
    expect(recovery.reason).toContain(shortDigest(other));
    expect(recovery.reason).toContain("the plane would refuse them");
  });

  it("refuses when the plane serves no digest it trusts", async () => {
    for (const body of [viewBody({ settingsDigest: null }), viewBody({ settings: null })]) {
      const recovery = await recoverLendingArmParams({
        agentId: ID, hireBudgetWei: BUDGET, fetcher: fetcherFor(json(body)),
      });
      expect(recovery).toMatchObject({ kind: "refused" });
      if (recovery.kind !== "refused") return;
      expect(recovery.reason).toContain("no settings record it trusts");
    }
  });

  it("refuses without the hire budget rather than guessing one", async () => {
    for (const budget of [null, undefined, "0", "not-a-number"]) {
      const recovery = await recoverLendingArmParams({
        agentId: ID, hireBudgetWei: budget, fetcher: fetcherFor(json(viewBody())),
      });
      expect(recovery).toMatchObject({ kind: "refused" });
      if (recovery.kind !== "refused") return;
      expect(recovery.reason).toContain("the budget this hire was funded for");
    }
  });

  it("names why an unreachable or refused view stopped it", async () => {
    const thrower = vi.fn<typeof fetch>(async () => { throw new Error("offline"); });
    await expect(recoverLendingArmParams({ agentId: ID, hireBudgetWei: BUDGET, fetcher: thrower }))
      .resolves.toMatchObject({ kind: "refused", reason: "the execution plane could not be reached" });

    const cases: readonly { readonly status: number; readonly code: string; readonly contains: string }[] = [
      { status: 401, code: "owner_auth_required", contains: "not authorised" },
      { status: 404, code: "not_found", contains: "no lending guard for this agent yet" },
      { status: 502, code: "execution_unavailable", contains: "execution_unavailable" },
    ];
    for (const entry of cases) {
      const recovery = await recoverLendingArmParams({
        agentId: ID, hireBudgetWei: BUDGET,
        fetcher: fetcherFor(json({ error: { code: entry.code } }, entry.status)),
      });
      expect(recovery).toMatchObject({ kind: "refused" });
      if (recovery.kind !== "refused") return;
      expect(recovery.reason).toContain(entry.contains);
    }
  });

  it("refuses a view shape it cannot map", async () => {
    const recovery = await recoverLendingArmParams({
      agentId: ID, hireBudgetWei: BUDGET, fetcher: fetcherFor(json({ data: {} })),
    });
    expect(recovery).toMatchObject({ kind: "refused" });
    if (recovery.kind !== "refused") return;
    expect(recovery.reason).toContain("shape this page cannot map");
  });

  it("reports every past-the-arm status as past-arm, not as a refusal to fix", async () => {
    const past: readonly LendingGuardStatus[] = ["arming", "armed", "held", "retiring", "retired"];
    for (const status of past) {
      const recovery = await recoverLendingArmParams({
        agentId: ID, hireBudgetWei: BUDGET, fetcher: fetcherFor(json(viewBody({ status }))),
      });
      expect(recovery.kind, status).toBe("past-arm");
      if (recovery.kind !== "past-arm") return;
      expect(recovery.guardStatus).toBe(status);
      expect(recovery.reason.length).toBeGreaterThan(0);
    }
  });
});
