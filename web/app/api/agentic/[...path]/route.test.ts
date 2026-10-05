import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secret = "ab".repeat(32), credential = id + "." + secret;
const params = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });
let ip = 0;
function request(path: string, method = "GET", cookie = "", origin = "https://app.test", content = "application/json") {
  return new NextRequest("https://app.test/api/agentic/" + path, { method, headers: { origin, "content-type": content,
    "x-forwarded-for": "offline-" + ip, cookie, "x-owner-read": "must-not-forward", authorization: "must-not-forward" }, ...(method === "POST" ? { body: "{}" } : {}) });
}
const fetcher = vi.fn();
beforeEach(() => { ip += 1; vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", "true"); vi.stubEnv("EXECUTION_URL", "https://execution.test"); vi.stubEnv("EXECUTION_API_TOKEN", "offline-perimeter");
  vi.stubGlobal("fetch", fetcher); fetcher.mockReset(); fetcher.mockImplementation(async () => new Response(JSON.stringify({ data: { state: "waiting", continuationDeadlineMs: null } }), { status: 200 })); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("Agentic BFF", () => {
  it("mints only an HttpOnly strict pairing cookie and strips the secret", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: { pairingId: id, pairingSecret: secret, urlForWeb: "https://app.binance.com/uni-qr/offline", expireAtMs: 10 } }), { status: 201 }));
    const response = await POST(request("pairings", "POST"), params("pairings"));
    expect(response.status).toBe(201); const body = await response.text(); expect(body).not.toContain(secret); expect(body).not.toContain("pairingSecret");
    const cookie = response.headers.get("set-cookie")!; for (const text of ["HttpOnly", "Secure", "SameSite=strict", "Path=/api/agentic", "Max-Age=2400"]) expect(cookie).toContain(text);
    expect(fetcher.mock.calls[0][1].headers["x-agentic-pairing"]).toBeUndefined();
  });
  it("forwards the cookie to hire and paired routes, never owner headers", async () => {
    await POST(request("hire", "POST", "4lpha_agentic_pairing=" + credential), params("hire"));
    const headers = fetcher.mock.calls[0][1].headers; expect(headers["x-agentic-pairing"]).toBe(credential);
    expect(headers["x-owner-read"]).toBeUndefined(); expect(headers.authorization).toBeUndefined(); expect(headers.origin).toBe("https://app.test");
    const publicPath = "wallets/0x" + "17".repeat(20);
    await GET(request(publicPath, "GET", "4lpha_agentic_pairing=" + credential), params(publicPath));
    expect(fetcher.mock.calls[1][1].headers["x-agentic-pairing"]).toBeUndefined();
  });
  it("renews through delayed admission using the server deadline plus 300 seconds", async () => {
    const now = 1_900_000_400_000, deadline = now + 1_800_000; vi.spyOn(Date, "now").mockReturnValue(now);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: { state: "verified", continuationDeadlineMs: deadline } }), { status: 200 }));
    const response = await GET(request("pairings/" + id, "GET", "4lpha_agentic_pairing=" + credential), params("pairings/" + id));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=2100"); expect((await response.json()).data.continuationDeadlineMs).toBe(deadline);
  });
  it("refuses cross-origin, non-JSON, missing cookies, foreign paths and flag-off routes", async () => {
    expect((await POST(request("pairings", "POST", "", "https://evil.test"), params("pairings"))).status).toBe(403);
    expect((await POST(request("pairings", "POST", "", "https://app.test", "text/plain"), params("pairings"))).status).toBe(403);
    expect((await POST(request("hire", "POST"), params("hire"))).status).toBe(401);
    expect((await POST(request("wallets/" + id + "/pause", "POST"), params("wallets/" + id + "/pause"))).status).toBe(404);
    vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", "false"); expect((await POST(request("pairings", "POST"), params("pairings"))).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("behind the Railway edge, compares and forwards the public origin from the proxy headers", async () => {
    const behindEdge = (origin: string) => new NextRequest("http://0.0.0.0:3000/api/agentic/pairings", { method: "POST", body: "{}",
      headers: { origin, "content-type": "application/json", "x-forwarded-for": "offline-" + ip, "x-forwarded-proto": "https", "x-forwarded-host": "4lpha.tech" } });
    expect((await POST(behindEdge("https://4lpha.tech"), params("pairings"))).status).toBe(200);
    expect(fetcher.mock.calls[0][1].headers.origin).toBe("https://4lpha.tech");
    expect((await POST(behindEdge("https://evil.test"), params("pairings"))).status).toBe(403);
    expect((await POST(behindEdge("http://0.0.0.0:3000"), params("pairings"))).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("limits starts to five per ten minutes and public reads to sixty per minute", async () => {
    for (let i = 0; i < 5; i += 1) expect((await POST(request("pairings", "POST"), params("pairings"))).status).toBe(200);
    expect((await POST(request("pairings", "POST"), params("pairings"))).status).toBe(429);
    const path = "wallets/0x" + "19".repeat(20);
    for (let i = 0; i < 60; i += 1) expect((await GET(request(path), params(path))).status).toBe(200);
    expect((await GET(request(path), params(path))).status).toBe(429);
  });
  it("caches a public wallet for fifteen seconds", async () => {
    let now = 1_900_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const path = "wallets/0x" + "21".repeat(20);
    await GET(request(path), params(path)); await GET(request(path), params(path)); expect(fetcher).toHaveBeenCalledTimes(1);
    now += 15_001; await GET(request(path), params(path)); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
