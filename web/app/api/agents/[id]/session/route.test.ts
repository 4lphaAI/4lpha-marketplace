import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({ accountRead: vi.fn(), continuationRead: vi.fn(), ownerMutation: vi.fn(), ownerRead: vi.fn() }));
vi.mock("@/lib/exec/client", () => ({
  execAccountRead: exec.accountRead,
  execProvisionContinuationRead: exec.continuationRead,
  execOwnerMutation: exec.ownerMutation,
  execOwnerRead: exec.ownerRead,
}));

import { GET, POST } from "./route";
import { POST as CANCEL } from "./cancel/route";
import { POST as GRANT_ATTEMPT } from "./grant-attempt/route";
import { POST as RESET_GRANT_ATTEMPT } from "./grant-attempt/reset/route";

const context = { params: Promise.resolve({ id: "agent-1" }) };

describe("hire session BFF", () => {
  beforeEach(() => {
    exec.accountRead.mockReset();
    exec.continuationRead.mockReset();
    exec.ownerMutation.mockReset();
    exec.ownerRead.mockReset();
  });

  it("forwards S1 and cancel bodies byte-for-byte", async () => {
    exec.ownerMutation.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
    const raw = "{ \"signed\": {}, \"signature\": \"0x01\", \"params\": {} }";
    expect((await POST(new NextRequest("https://app.test/api/agents/agent-1/session", { method: "POST", body: raw }), context)).status).toBe(200);
    expect((await CANCEL(new NextRequest("https://app.test/api/agents/agent-1/session/cancel", { method: "POST", body: raw }), context)).status).toBe(200);
    expect((await GRANT_ATTEMPT(new NextRequest("https://app.test/api/agents/agent-1/session/grant-attempt", { method: "POST", body: raw }), context)).status).toBe(200);
    expect((await RESET_GRANT_ATTEMPT(new NextRequest("https://app.test/api/agents/agent-1/session/grant-attempt/reset", { method: "POST", body: raw }), context)).status).toBe(200);
    expect(exec.ownerMutation.mock.calls).toEqual([
      ["/agents/agent-1/session", raw],
      ["/agents/agent-1/session/cancel", raw],
      ["/agents/agent-1/session/grant-attempt", raw],
      ["/agents/agent-1/session/grant-attempt/reset", raw],
    ]);
  });

  it("moves a provision-issued read token into the strict /api cookie and strips it from the browser body", async () => {
    exec.ownerMutation.mockResolvedValue({ status: 200, body: JSON.stringify({ data: { status: "provisioning", readSession: { token: "secret-bearer", expiry: 2_000_000_000 } } }) });
    const response = await POST(new NextRequest("https://app.test/api/agents/agent-1/session", { method: "POST", body: "{}" }), context);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("secret-bearer");
    expect(JSON.parse(body) as unknown).toEqual({ data: { status: "provisioning", readSession: { expiry: 2_000_000_000 } } });
    expect(response.headers.get("set-cookie") ?? "").toMatch(/4lpha_account_read=secret-bearer;.*Path=\/api;.*HttpOnly;.*SameSite=strict/u);

    exec.ownerMutation.mockResolvedValue({ status: 409, body: JSON.stringify({ error: { code: "agent_exists" } }) });
    const refused = await POST(new NextRequest("https://app.test/api/agents/agent-1/session", { method: "POST", body: "{}" }), context);
    expect(refused.status).toBe(409);
    expect(refused.headers.get("set-cookie")).toBeNull();
  });

  it("forwards the reusable read header and never exposes the service token", async () => {
    exec.ownerRead.mockResolvedValue({ status: 200, body: "{\"data\":{\"status\":\"provisioning\"}}" });
    const response = await GET(new NextRequest("https://app.test/api/agents/agent-1/session", { headers: { "x-owner-action": "signed-read" } }), context);
    expect(response.status).toBe(200);
    expect(exec.ownerRead).toHaveBeenCalledWith("/agents/agent-1/session", "signed-read");
    expect(await response.text()).not.toContain("EXECUTION_API_TOKEN");
  });

  it("uses the HttpOnly account bearer and rejects ambiguous credentials", async () => {
    exec.accountRead.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
    const cookieOnly = new NextRequest("https://app.test/api/agents/agent-1/session", {
      headers: { cookie: "4lpha_account_read=opaque-token" },
    });
    expect((await GET(cookieOnly, context)).status).toBe(200);
    expect(exec.accountRead).toHaveBeenCalledWith("/agents/agent-1/session", "opaque-token");

    const both = new NextRequest("https://app.test/api/agents/agent-1/session", {
      headers: { cookie: "4lpha_account_read=opaque-token", "x-owner-action": "signed" },
    });
    exec.ownerRead.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
    exec.accountRead.mockClear();
    expect((await GET(both, context)).status).toBe(200);
    expect(exec.ownerRead).toHaveBeenCalledWith("/agents/agent-1/session", "signed");
    expect(exec.accountRead).not.toHaveBeenCalled();
  });

  it("expires a rejected bearer cookie at the same /api path it was issued on", async () => {
    exec.accountRead.mockResolvedValue({ status: 401, body: "{}" });
    const result = await GET(new NextRequest("https://app.test/api/agents/agent-1/session", {
      headers: { cookie: "4lpha_account_read=expired-token" },
    }), context);
    expect(result.status).toBe(401);
    expect(result.headers.get("set-cookie") ?? "")
      .toMatch(/4lpha_account_read=;.*Path=\/api;.*Max-Age=0/u);
  });

  it("forwards the exact S1 continuation without exposing or mixing another owner credential", async () => {
    exec.continuationRead.mockResolvedValue({ status: 200, body: "{\"data\":{\"status\":\"provisioning\"}}" });
    const continued = new NextRequest("https://app.test/api/agents/agent-1/session", {
      headers: { cookie: "4lpha_account_read=opaque-token", "x-provision-action": "exact-s1" },
    });
    expect((await GET(continued, context)).status).toBe(200);
    expect(exec.continuationRead).toHaveBeenCalledWith("/agents/agent-1/session", "exact-s1");
    expect(exec.accountRead).not.toHaveBeenCalled();

    const ambiguous = new NextRequest("https://app.test/api/agents/agent-1/session", {
      headers: { "x-owner-action": "other-owner-action", "x-provision-action": "exact-s1" },
    });
    expect((await GET(ambiguous, context)).status).toBe(400);
  });
});
