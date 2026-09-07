import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(() => ({ execAccountRead: vi.fn(), execOwnerRead: vi.fn() }));
vi.mock("@/lib/exec/client", () => clients);
import { GET } from "./route";

describe("Account portfolio BFF", () => {
  beforeEach(() => {
    clients.execAccountRead.mockReset();
    clients.execOwnerRead.mockReset();
  });

  it("forwards only the signed header when the HttpOnly cookie is also present", async () => {
    clients.execOwnerRead.mockResolvedValue({ status: 200, body: "{}" });
    const request = new NextRequest("https://app.test/api/account/portfolio", {
      headers: { cookie: "4lpha_account_read=opaque-token", "x-owner-action": "signed-read" },
    });
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(clients.execAccountRead).not.toHaveBeenCalled();
    expect(clients.execOwnerRead).toHaveBeenCalledTimes(1);
    expect(clients.execOwnerRead.mock.calls[0]?.[1]).toBe("signed-read");
  });

  it("uses the signed read only when no session cookie exists", async () => {
    clients.execOwnerRead.mockResolvedValue({ status: 200, body: "{}" });
    const response = await GET(new NextRequest("https://app.test/api/account/portfolio", {
      headers: { "x-owner-action": "signed-read" },
    }));
    expect(response.status).toBe(200);
    expect(clients.execOwnerRead).toHaveBeenCalledWith("/account/portfolio", "signed-read");
    expect(clients.execAccountRead).not.toHaveBeenCalled();
  });

  it("expires a rejected bearer so the browser can establish a new session", async () => {
    clients.execAccountRead.mockResolvedValue({ status: 401, body: "{}" });
    const response = await GET(new NextRequest("https://app.test/api/account/portfolio", {
      headers: { cookie: "4lpha_account_read=expired-token" },
    }));
    expect(response.status).toBe(401);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("4lpha_account_read=");
    expect(cookie).toMatch(/(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/u);
  });
});
