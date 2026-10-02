import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({ continuation: vi.fn(), forward: vi.fn() }));
vi.mock("@/lib/exec/client", () => ({ execProvisionContinuationMutation: exec.continuation }));
vi.mock("@/lib/exec/mutation-bff", () => ({ forwardAgentMutation: exec.forward }));

import { POST } from "./route";

const context = { params: Promise.resolve({ id: "tradfi-agent" }) };

describe("CMC-HIRE-SETUP R3: the /trade/cmc-budget BFF continuation branch", () => {
  beforeEach(() => {
    exec.continuation.mockReset();
    exec.forward.mockReset();
    exec.continuation.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
  });

  it("forwards the continuation header and the exact plane path with an empty body", async () => {
    const response = await POST(new NextRequest("https://app.test/api/agents/tradfi-agent/trade/cmc-budget", {
      method: "POST", body: "{}", headers: { "x-provision-action": "encoded-provision" },
    }), context);
    expect(response.status).toBe(200);
    expect(exec.continuation).toHaveBeenCalledWith("/agents/tradfi-agent/trade/cmc-budget", "encoded-provision");
    expect(exec.forward).not.toHaveBeenCalled();
  });

  it("rejects mixed authorities and a non-empty continuation body before forwarding", async () => {
    const mixed = await POST(new NextRequest("https://app.test/api/agents/tradfi-agent/trade/cmc-budget", {
      method: "POST", body: "{}", headers: { "x-provision-action": "encoded", "x-owner-action": "signed" },
    }), context);
    expect(mixed.status).toBe(400);
    const mixedBody = await mixed.json() as { error?: { code?: string } };
    expect(mixedBody.error?.code).toBe("ambiguous_owner_auth");

    const nonEmpty = await POST(new NextRequest("https://app.test/api/agents/tradfi-agent/trade/cmc-budget", {
      method: "POST", body: JSON.stringify({ signed: {} }), headers: { "x-provision-action": "encoded" },
    }), context);
    expect(nonEmpty.status).toBe(400);
    expect(exec.continuation).not.toHaveBeenCalled();
  });

  it("keeps the signed forwarding path unchanged when the continuation header is absent", async () => {
    exec.forward.mockResolvedValue(NextResponse.json({ data: { signed: true } }));
    const response = await POST(new NextRequest("https://app.test/api/agents/tradfi-agent/trade/cmc-budget", {
      method: "POST", body: "signed-body",
    }), context);
    expect(response.status).toBe(200);
    expect(exec.forward).toHaveBeenCalledWith(expect.anything(), "tradfi-agent", "/trade/cmc-budget");
    expect(exec.continuation).not.toHaveBeenCalled();
  });
});
