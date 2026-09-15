import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({ accountRead: vi.fn(), ownerRead: vi.fn() }));
vi.mock("@/lib/exec/client", () => ({
  execAccountRead: exec.accountRead,
  execOwnerRead: exec.ownerRead,
}));

import { GET } from "./route";

const response = { status: 200, body: "{\"data\":[]}" };

describe("agent list BFF", () => {
  beforeEach(() => {
    exec.accountRead.mockReset();
    exec.ownerRead.mockReset();
    exec.accountRead.mockResolvedValue(response);
    exec.ownerRead.mockResolvedValue(response);
  });

  it("forwards the HttpOnly cookie as a bearer without echoing it", async () => {
    const request = new NextRequest("https://app.test/api/agents", {
      headers: { cookie: "4lpha_account_read=opaque-token" },
    });
    const result = await GET(request);
    expect(result.status).toBe(200);
    expect(exec.accountRead).toHaveBeenCalledWith("/agents", "opaque-token");
    expect(exec.ownerRead).not.toHaveBeenCalled();
    expect(await result.text()).not.toContain("opaque-token");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });

  it("forwards a signed read when no cookie exists", async () => {
    const result = await GET(new NextRequest("https://app.test/api/agents", {
      headers: { "x-owner-action": "signed-list" },
    }));
    expect(result.status).toBe(200);
    expect(exec.ownerRead).toHaveBeenCalledWith("/agents", "signed-list");
    expect(exec.accountRead).not.toHaveBeenCalled();
  });

  it("returns the missing-owner error without calling the plane", async () => {
    const result = await GET(new NextRequest("https://app.test/api/agents"));
    expect(result.status).toBe(401);
    await expect(result.json()).resolves.toEqual({ error: { code: "owner_auth_required" } });
    expect(exec.accountRead).not.toHaveBeenCalled();
    expect(exec.ownerRead).not.toHaveBeenCalled();
  });

  it("uses the signed credential when both cookie and header are present", async () => {
    const result = await GET(new NextRequest("https://app.test/api/agents", {
      headers: { cookie: "4lpha_account_read=opaque-token", "x-owner-action": "signed-list" },
    }));
    expect(result.status).toBe(200);
    expect(exec.ownerRead).toHaveBeenCalledWith("/agents", "signed-list");
    expect(exec.accountRead).not.toHaveBeenCalled();
  });

  it("expires only a rejected bearer cookie at /api", async () => {
    exec.accountRead.mockResolvedValue({ status: 401, body: "{\"error\":{\"code\":\"owner_auth_failed\"}}" });
    const bearer = await GET(new NextRequest("https://app.test/api/agents", {
      headers: { cookie: "4lpha_account_read=expired-token" },
    }));
    expect(bearer.status).toBe(401);
    const setCookie = bearer.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/4lpha_account_read=;.*Path=\/api;.*Max-Age=0/u);

    exec.ownerRead.mockResolvedValue({ status: 401, body: "{}" });
    const signed = await GET(new NextRequest("https://app.test/api/agents", {
      headers: { "x-owner-action": "signed-list" },
    }));
    expect(signed.status).toBe(401);
    expect(signed.headers.get("set-cookie")).toBeNull();
  });

  it("sanitizes a transport failure", async () => {
    exec.accountRead.mockRejectedValue(new Error("secret upstream detail"));
    const result = await GET(new NextRequest("https://app.test/api/agents", {
      headers: { cookie: "4lpha_account_read=opaque-token" },
    }));
    expect(result.status).toBe(502);
    await expect(result.json()).resolves.toEqual({ error: { code: "execution_unavailable" } });
  });
});
