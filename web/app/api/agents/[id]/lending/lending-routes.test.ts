import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({
  accountRead: vi.fn(),
  ownerRead: vi.fn(),
  ownerMutation: vi.fn(),
  serviceRead: vi.fn(),
}));
vi.mock("@/lib/exec/client", () => ({
  execAccountRead: exec.accountRead,
  execOwnerRead: exec.ownerRead,
  execOwnerMutation: exec.ownerMutation,
  execServiceRead: exec.serviceRead,
}));

import { GET as lendingView } from "./view/route";
import { POST as arm } from "./arm/route";
import { POST as settings } from "./settings/route";
import { POST as retire } from "./retire/route";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const context = { params: Promise.resolve({ id: "lending-agent-01" }) };

const guard = {
  status: "armed", hold: null, guardedAccount: ACCOUNT, debtMarkets: [],
  reserveBps: 2000, budgetWei: "1", reserveCapWei: "1",
  armTxHash: null, armBlock: null, closeReason: null,
  actionSeq: 0, lastActionAtMs: null, updatedAtMs: 1,
};

function viewBody(stale: boolean) {
  return JSON.stringify({
    data: {
      guard,
      snapshot: {
        presentAt: 1, ageMs: 1, staleAfterMs: 60_000, stale,
        reason: stale ? "The worker has not reported since 2026-09-07T00:00:00.000Z." : null,
        workerIntervalMs: 30_000, payload: stale ? null : { version: 1 },
      },
      rescues: [], settings: null, settingsDigest: null,
      session: { expiresAt: null, expiring: false }, recovery: { note: "" },
    },
    meta: { agentId: "lending-agent-01" },
  });
}

const GUARDABLE = {
  account: ACCOUNT, blockNumber: "2",
  bases: {
    borrowingPower: { hf: "1300000000000000000", matched: true },
    liquidation: { hf: "1050000000000000000", matched: true },
  },
  markets: [], debts: [], guardable: true,
};

beforeEach(() => {
  for (const fn of Object.values(exec)) fn.mockReset();
  exec.ownerMutation.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
});

describe("the three lending mutations forward the SIGNED BYTES, unchanged", () => {
  it("posts arm, settings and retire to their exact plane paths", async () => {
    const raw = "{\"signed\":{\"action\":\"lendingArm\"},\"signature\":\"0x01\",\"params\":{}}";
    const request = () => new NextRequest("https://app.test/api/agents/lending-agent-01/lending/arm", {
      method: "POST", body: raw,
    });
    expect((await arm(request(), context)).status).toBe(200);
    expect((await settings(request(), context)).status).toBe(200);
    expect((await retire(request(), context)).status).toBe(200);
    expect(exec.ownerMutation.mock.calls.map(([path]) => path)).toEqual([
      "/agents/lending-agent-01/lending/arm",
      "/agents/lending-agent-01/lending/settings",
      "/agents/lending-agent-01/lending/retire",
    ]);
    // Byte-for-byte: the plane recomputes `paramsHash` over exactly these bytes.
    for (const call of exec.ownerMutation.mock.calls) expect(call[1]).toBe(raw);
  });

  it("refuses an invalid agent id and an empty body without calling the plane", async () => {
    const bad = { params: Promise.resolve({ id: "not a valid id!" }) };
    const request = new NextRequest("https://app.test/x", { method: "POST", body: "{}" });
    expect((await arm(request, bad)).status).toBe(400);
    const empty = new NextRequest("https://app.test/x", { method: "POST" });
    expect((await retire(empty, context)).status).toBe(400);
    expect(exec.ownerMutation).not.toHaveBeenCalled();
  });
});

describe("GET /api/agents/:id/lending/view", () => {
  it("forwards EXACTLY ONE credential — the cookie, or the signed header, never both", async () => {
    exec.accountRead.mockResolvedValue({ status: 200, body: viewBody(false) });
    exec.ownerRead.mockResolvedValue({ status: 200, body: viewBody(false) });

    const cookie = new NextRequest("https://app.test/x", { headers: { cookie: "4lpha_account_read=opaque" } });
    expect((await lendingView(cookie, context)).status).toBe(200);
    expect(exec.accountRead).toHaveBeenCalledWith("/agents/lending-agent-01/lending/view", "opaque");
    expect(exec.ownerRead).not.toHaveBeenCalled();

    exec.accountRead.mockClear();
    const signed = new NextRequest("https://app.test/x", { headers: { "x-owner-action": "signed" } });
    expect((await lendingView(signed, context)).status).toBe(200);
    expect(exec.ownerRead).toHaveBeenCalledWith("/agents/lending-agent-01/lending/view", "signed");
    expect(exec.accountRead).not.toHaveBeenCalled();

    exec.ownerRead.mockClear();
    const both = new NextRequest("https://app.test/x", {
      headers: { cookie: "4lpha_account_read=opaque", "x-owner-action": "signed" },
    });
    expect((await lendingView(both, context)).status).toBe(200);
    expect(exec.ownerRead).toHaveBeenCalledTimes(1);
    expect(exec.accountRead).not.toHaveBeenCalled();
  });

  it("refuses with no credential and never reaches the plane", async () => {
    expect((await lendingView(new NextRequest("https://app.test/x"), context)).status).toBe(401);
    expect(exec.accountRead).not.toHaveBeenCalled();
    expect(exec.ownerRead).not.toHaveBeenCalled();
  });

  it("passes a FRESH view through untouched — no live read, no added fields", async () => {
    exec.accountRead.mockResolvedValue({ status: 200, body: viewBody(false) });
    const response = await lendingView(
      new NextRequest("https://app.test/x", { headers: { cookie: "4lpha_account_read=opaque" } }), context);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data["liveAccount"]).toBeUndefined();
    expect(body.data["liveAccountReason"]).toBeUndefined();
    expect(exec.serviceRead).not.toHaveBeenCalled();
  });

  // R2.18: a stale snapshot gets the ACCOUNT half from a live display-mode read,
  // labelled — while the guard half stays dashed with the staleness reason.
  it("adds the live account fallback for a STALE snapshot, in display mode only", async () => {
    exec.accountRead.mockResolvedValue({ status: 200, body: viewBody(true) });
    exec.serviceRead.mockResolvedValue({ status: 200, body: JSON.stringify({ data: GUARDABLE }) });
    const response = await lendingView(
      new NextRequest("https://app.test/x", { headers: { cookie: "4lpha_account_read=opaque" } }), context);
    const body = await response.json() as { data: { liveAccount?: unknown; snapshot: { reason: string } } };
    expect(body.data.liveAccount).toEqual(GUARDABLE);
    // Display mode: the fallback must never take sizing inputs or a receipt.
    expect(String(exec.serviceRead.mock.calls[0]?.[0])).toBe(`/lending/guardable?account=${ACCOUNT}`);
    // The staleness reason survives, so the guard tiles still dash WITH it.
    expect(body.data.snapshot.reason).toContain("has not reported since");
  });

  it("names why the fallback is missing instead of leaving the page to guess", async () => {
    exec.accountRead.mockResolvedValue({ status: 200, body: viewBody(true) });
    exec.serviceRead.mockResolvedValue({ status: 429, body: "{}" });
    const limited = await lendingView(
      new NextRequest("https://app.test/x", { headers: { cookie: "4lpha_account_read=opaque" } }), context);
    expect((await limited.json() as { data: { liveAccountReason: string } }).data.liveAccountReason)
      .toBe("the live read is rate-limited");

    exec.serviceRead.mockResolvedValue({ status: 404, body: "{}" });
    const off = await lendingView(
      new NextRequest("https://app.test/x", { headers: { cookie: "4lpha_account_read=opaque" } }), context);
    expect((await off.json() as { data: { liveAccountReason: string } }).data.liveAccountReason)
      .toContain("not enabled");
  });

  it("passes an upstream refusal through and clears a dead bearer cookie", async () => {
    exec.accountRead.mockResolvedValue({ status: 401, body: "{\"error\":{\"code\":\"unauthorized\"}}" });
    const response = await lendingView(
      new NextRequest("https://app.test/x", { headers: { cookie: "4lpha_account_read=opaque" } }), context);
    expect(response.status).toBe(401);
    expect(response.cookies.get("4lpha_account_read")?.value).toBe("");
    expect(exec.serviceRead).not.toHaveBeenCalled();
  });

  it("passes an unparseable body through rather than inventing a shape", async () => {
    exec.accountRead.mockResolvedValue({ status: 200, body: "not json" });
    const response = await lendingView(
      new NextRequest("https://app.test/x", { headers: { cookie: "4lpha_account_read=opaque" } }), context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("not json");
    expect(exec.serviceRead).not.toHaveBeenCalled();
  });
});
