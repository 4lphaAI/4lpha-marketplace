/**
 * DEMO MODE — the BFF proxy.
 *
 * Two properties matter here and nothing else does: the anonymous session id
 * never reaches browser JS (HttpOnly), and the proxy forwards the demo paths
 * and ONLY the demo paths — it must never become a general tunnel to the
 * execution plane with the service token attached.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const execDemo = vi.fn();
vi.mock("@/lib/exec/client", () => ({ execDemo: (...args: unknown[]) => execDemo(...args) }));

const { GET, POST } = await import("./route");

function request(path: string, init: { method?: string; cookie?: string; body?: string } = {}): NextRequest {
  return new NextRequest(`https://app.test/api/demo/${path}`, {
    method: init.method ?? "GET",
    ...(init.cookie === undefined ? {} : { headers: { cookie: init.cookie } }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

const params = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });

beforeEach(() => {
  execDemo.mockReset();
  execDemo.mockResolvedValue({ status: 200, body: JSON.stringify({ data: { agents: [] } }) });
});

describe("demo BFF", () => {
  it("mints an HttpOnly session cookie on the first call", async () => {
    const response = await GET(request("agents"), params("agents"));
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/4lpha_demo_session=[0-9a-f]{32}/u);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=strict");
  });

  it("reuses an existing session id and does not re-set it", async () => {
    const id = "a".repeat(32);
    const response = await GET(request("agents", { cookie: `4lpha_demo_session=${id}` }), params("agents"));
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(execDemo).toHaveBeenCalledWith("/demo/agents", id, { method: "GET" });
  });

  it("replaces a malformed cookie rather than forwarding it", async () => {
    const response = await GET(request("agents", { cookie: "4lpha_demo_session=../../etc" }), params("agents"));
    expect(response.headers.get("set-cookie")).toMatch(/4lpha_demo_session=[0-9a-f]{32}/u);
    expect(execDemo.mock.calls[0]?.[1]).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("forwards ONLY the demo paths", async () => {
    for (const path of ["agents", "agents/abc123", "agents/abc123/fills"]) {
      expect((await GET(request(path), params(path))).status).toBe(200);
    }
    for (const path of ["agents/x/../../trade", "health", "agents/abc/settings"]) {
      const response = await GET(request(path), params(path));
      expect(response.status).toBe(404);
    }
    // A POST allowlist of its own: the GET paths are not POST-able.
    const badPost = await POST(request("agents/abc/fills", { method: "POST", body: "{}" }), params("agents/abc/fills"));
    expect(badPost.status).toBe(404);
  });

  it("passes an upstream refusal through unchanged", async () => {
    execDemo.mockResolvedValue({ status: 409, body: JSON.stringify({ error: { code: "at_cap", message: "Stop one." } }) });
    const response = await POST(request("agents", { method: "POST", body: "{}" }), params("agents"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "at_cap", message: "Stop one." } });
  });

  it("refuses an oversized body before calling the plane", async () => {
    const response = await POST(
      request("agents", { method: "POST", body: "x".repeat(9_000) }),
      params("agents"),
    );
    expect(response.status).toBe(413);
    expect(execDemo).not.toHaveBeenCalled();
  });

  it("answers 502 when the plane is unreachable", async () => {
    execDemo.mockRejectedValue(new Error("down"));
    const response = await GET(request("agents"), params("agents"));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "execution_unavailable" } });
  });
});
