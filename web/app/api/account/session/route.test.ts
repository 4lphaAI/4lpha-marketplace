import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execOwnerMutation } = vi.hoisted(() => ({ execOwnerMutation: vi.fn() }));
vi.mock("@/lib/exec/client", () => ({ execOwnerMutation }));
import { DELETE, POST } from "./route";

describe("Account session BFF", () => {
  beforeEach(() => execOwnerMutation.mockReset());
  it("clears only the exact read cookie for same-origin account switching", async () => {
    const response = await DELETE(new NextRequest("https://app.test/api/account/session", { method: "DELETE", headers: { origin: "https://app.test" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/4lpha_account_read=; Path=\/api; Max-Age=0; Secure; HttpOnly; SameSite=strict/u);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(execOwnerMutation).not.toHaveBeenCalled();
    for (const origin of ["https://evil.test", ""]) {
      expect((await DELETE(new NextRequest("https://app.test/api/account/session", { method: "DELETE", headers: { origin } }))).status).toBe(403);
    }
  });

  it("accepts the browser origin behind a TLS-terminating proxy via the forwarded headers", async () => {
    const forwarded = { "x-forwarded-proto": "https", "x-forwarded-host": "web.prod.test", host: "0.0.0.0:8080" };
    const ok = await DELETE(new NextRequest("http://0.0.0.0:8080/api/account/session", { method: "DELETE", headers: { ...forwarded, origin: "https://web.prod.test" } }));
    expect(ok.status).toBe(200);
    for (const origin of ["http://web.prod.test", "https://evil.test", "http://0.0.0.0:8080"]) {
      expect((await DELETE(new NextRequest("http://0.0.0.0:8080/api/account/session", { method: "DELETE", headers: { ...forwarded, origin } }))).status).toBe(403);
    }
  });

  it("keeps the bearer out of JavaScript and sets the hardened cookie", async () => {
    execOwnerMutation.mockResolvedValue({ status: 200, body: JSON.stringify({ data: { token: "sensitive-bearer", expiry: 2_000_000_000 } }) });
    const response = await POST(new NextRequest("https://app.test/api/account/session", { method: "POST", body: "{}" }));
    expect(await response.text()).not.toContain("sensitive-bearer");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=strict"); expect(cookie).toContain("Path=/api");
    expect(cookie).not.toMatch(/Max-Age=|Expires=/iu);
  });

  it("passes capability-hidden status through for signed-read fallback", async () => {
    execOwnerMutation.mockResolvedValue({ status: 404, body: JSON.stringify({ error: { code: "not_found" } }) });
    const response = await POST(new NextRequest("https://app.test/api/account/session", { method: "POST", body: "{}" }));
    expect(response.status).toBe(404);
  });
});
