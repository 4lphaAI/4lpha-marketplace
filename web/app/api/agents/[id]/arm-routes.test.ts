import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({ owner: vi.fn(), continuation: vi.fn(), forward: vi.fn() }));
vi.mock("@/lib/exec/client", () => ({
  execOwnerMutation: exec.owner,
  execProvisionContinuationMutation: exec.continuation,
}));
vi.mock("@/lib/exec/mutation-bff", () => ({ forwardAgentMutation: exec.forward }));

import { POST as GRID } from "./grid/arm/route";
import { POST as LP } from "./lp/arm/route";

const context = { params: Promise.resolve({ id: "grid-agent" }) };

describe("arm continuation BFFs", () => {
  beforeEach(() => {
    exec.owner.mockReset();
    exec.continuation.mockReset();
    exec.forward.mockReset();
    exec.continuation.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
    exec.owner.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
  });

  it("forwards the continuation header, empty body, and exact plane paths", async () => {
    const grid = await GRID(new NextRequest("https://app.test/api/agents/grid-agent/grid/arm", {
      method: "POST", body: "{}", headers: { "x-provision-action": "encoded-provision" },
    }), context);
    expect(grid.status).toBe(200);
    expect(exec.continuation).toHaveBeenCalledWith("/agents/grid-agent/lp/grid/arm", "encoded-provision");

    const lp = await LP(new NextRequest("https://app.test/api/agents/grid-agent/lp/arm", {
      method: "POST", body: "{}", headers: { "x-provision-action": "encoded-provision" },
    }), context);
    expect(lp.status).toBe(200);
    expect(exec.continuation).toHaveBeenCalledWith("/agents/grid-agent/lp/arm", "encoded-provision");
  });

  it("rejects mixed authorities and non-empty continuation bodies before forwarding", async () => {
    const mixed = await GRID(new NextRequest("https://app.test/api/agents/grid-agent/grid/arm", {
      method: "POST", body: "{}", headers: { "x-provision-action": "encoded", "x-owner-action": "signed" },
    }), context);
    expect(mixed.status).toBe(400);
    const body = await mixed.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("ambiguous_owner_auth");

    const nonEmpty = await LP(new NextRequest("https://app.test/api/agents/grid-agent/lp/arm", {
      method: "POST", body: JSON.stringify({ signed: {} }), headers: { "x-provision-action": "encoded" },
    }), context);
    expect(nonEmpty.status).toBe(400);
    expect(exec.continuation).not.toHaveBeenCalled();
  });

  it("keeps the signed LP forwarding path unchanged when the continuation header is absent", async () => {
    exec.forward.mockResolvedValue(NextResponse.json({ data: { signed: true } }));
    const response = await LP(new NextRequest("https://app.test/api/agents/grid-agent/lp/arm", {
      method: "POST", body: "signed-body",
    }), context);
    expect(response.status).toBe(200);
    expect(exec.forward).toHaveBeenCalledWith(expect.anything(), "grid-agent", "/lp/arm");
    expect(exec.continuation).not.toHaveBeenCalled();
  });
});
