import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { CLIENT_IP_HEADER, GLOBAL_LIMIT, PER_IP_LIMIT, UNKNOWN_CLIENT, WINDOW_MS, chargeToolCalls, clientIp } from "@/lib/mcp/rateLimit";
import { callBody, installDataPlane, mcpRequest, resetAll } from "./fixtures";

const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const callList = () => callBody("list_agents");
let now = 1_900_000_000_000;
beforeEach(() => { resetAll(); now = 1_900_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now); vi.stubEnv("MCP_DATA_TOOLS_ENABLED", ""); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("MCP rate limit", () => {
  it("allows 10 tools/call per minute per IP and refuses the 11th with 429, Retry-After and rate_limited", async () => {
    const ip = "203.0.113.1";
    for (let i = 0; i < PER_IP_LIMIT; i += 1) expect((await POST(mcpRequest(callList(), ip))).status).toBe(200);
    const refused = await POST(mcpRequest(callList(), ip));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(await refused.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "rate_limited" } });
  });

  it("frees the budget as the window slides, and Retry-After says when", async () => {
    const ip = "203.0.113.2";
    for (let i = 0; i < PER_IP_LIMIT; i += 1) expect((await POST(mcpRequest(callList(), ip))).status).toBe(200);
    now += 20_000;
    const refused = await POST(mcpRequest(callList(), ip));
    expect(refused.headers.get("retry-after")).toBe("40");
    now += 40_000;
    expect((await POST(mcpRequest(callList(), ip))).status).toBe(200);
  });

  it("keeps one IP's block from touching another IP", async () => {
    for (let i = 0; i < PER_IP_LIMIT; i += 1) await POST(mcpRequest(callList(), "203.0.113.3"));
    expect((await POST(mcpRequest(callList(), "203.0.113.3"))).status).toBe(429);
    expect((await POST(mcpRequest(callList(), "203.0.113.4"))).status).toBe(200);
  });

  it("does not count initialize, notifications, ping or tools/list, alone or batched", async () => {
    const ip = "203.0.113.5";
    for (let i = 0; i < 30; i += 1) {
      for (const message of [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }, list]) {
        expect((await POST(mcpRequest(message, ip))).status).toBeLessThan(300);
      }
    }
    expect((await POST(mcpRequest([list, list, { jsonrpc: "2.0", id: 3, method: "ping" }], ip))).status).toBe(200);
    for (let i = 0; i < PER_IP_LIMIT; i += 1) expect((await POST(mcpRequest(callList(), ip))).status).toBe(200);
    expect((await POST(mcpRequest(callList(), ip))).status).toBe(429);
  });

  it("counts every tools/call element of a batch, valid or not, and refuses the whole batch when it does not fit", async () => {
    const ip = "203.0.113.6";
    const batch = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? callBody("no_such_tool", {}, i) : callBody("list_agents", {}, i)));
    expect((await POST(mcpRequest(batch(6), ip))).status).toBe(200);
    const refused = await POST(mcpRequest([...batch(5), list, { jsonrpc: "2.0", method: "notifications/initialized" }], ip));
    expect(refused.status).toBe(429);
    // A refused request is not charged: 4 slots are still free for a batch of 4.
    expect((await POST(mcpRequest(batch(4), ip))).status).toBe(200);
    expect((await POST(mcpRequest(batch(1), ip))).status).toBe(429);
    // A batch bigger than the limit can never pass.
    resetAll();
    expect((await POST(mcpRequest(batch(PER_IP_LIMIT + 1), "203.0.113.7"))).status).toBe(429);
  });

  it("applies a global cap of 100 tools/call per minute across all IPs, whichever the IP", async () => {
    // Literal numbers on purpose: the operator's ruling is 10 per IP and 100 global, not "whatever the constants say".
    expect([PER_IP_LIMIT, GLOBAL_LIMIT, WINDOW_MS]).toEqual([10, 100, 60_000]);
    for (let i = 0; i < 10; i += 1) {
      for (let j = 0; j < 10; j += 1) expect((await POST(mcpRequest(callList(), `192.0.2.${i}`))).status).toBe(200);
    }
    const refused = await POST(mcpRequest(callList(), "192.0.2.250"));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await POST(mcpRequest(list, "192.0.2.250"))).status).toBe(200);
    now += WINDOW_MS + 1;
    expect((await POST(mcpRequest(callList(), "192.0.2.250"))).status).toBe(200);
  });

  it("limits the static tools too, flag off", async () => {
    const ip = "203.0.113.8";
    for (const name of ["explain_strategy", "get_hire_link", "list_agents"]) {
      for (let i = 0; i < 3; i += 1) await POST(mcpRequest(callBody(name, { agent: "grid" }), ip));
    }
    await POST(mcpRequest(callList(), ip));
    expect((await POST(mcpRequest(callList(), ip))).status).toBe(429);
  });

  it("charges a data-tool call like any other and never reaches the upstream once refused", async () => {
    vi.stubEnv("MCP_DATA_TOOLS_ENABLED", "true");
    const { fetcher } = installDataPlane();
    const ip = "203.0.113.9";
    for (let i = 0; i < PER_IP_LIMIT; i += 1) await POST(mcpRequest(callBody("meme_stocks", {}), ip));
    const reads = fetcher.mock.calls.length;
    expect((await POST(mcpRequest(callBody("meme_stocks", {}), ip))).status).toBe(429);
    expect(fetcher.mock.calls.length).toBe(reads);
  });

  it("keys on the header Railway's edge sets, ignores X-Forwarded-For, and shares one bucket when there is no header", async () => {
    expect(CLIENT_IP_HEADER).toBe("x-real-ip");
    // A client rotating X-Forwarded-For does not get a fresh budget.
    for (let i = 0; i < PER_IP_LIMIT; i += 1) await POST(mcpRequest(callList(), "203.0.113.20", undefined, { "x-forwarded-for": `9.9.9.${i}` }));
    expect((await POST(mcpRequest(callList(), "203.0.113.20", undefined, { "x-forwarded-for": "8.8.8.8" }))).status).toBe(429);
    // No usable header: one shared bucket (fail closed).
    expect(clientIp(new Headers())).toBe(UNKNOWN_CLIENT);
    expect(clientIp(new Headers({ "x-real-ip": "not an ip!" }))).toBe(UNKNOWN_CLIENT);
    expect(clientIp(new Headers({ "x-real-ip": " 2001:DB8::1 " }))).toBe("2001:db8::1");
    for (let i = 0; i < PER_IP_LIMIT; i += 1) await POST(mcpRequest(callList(), null, undefined, { "x-forwarded-for": `7.7.7.${i}` }));
    expect((await POST(mcpRequest(callList(), null, undefined, { "x-forwarded-for": "6.6.6.6" }))).status).toBe(429);
  });

  it("behind Cloudflare, keys on cf-connecting-ip only when x-real-ip is a Cloudflare edge address (lib/clientIp.ts)", async () => {
    const edge = "172.64.10.1";
    // Two visitors behind the same Cloudflare edge have separate budgets.
    for (let i = 0; i < PER_IP_LIMIT; i += 1) await POST(mcpRequest(callList(), edge, undefined, { "cf-connecting-ip": "198.51.100.1" }));
    expect((await POST(mcpRequest(callList(), edge, undefined, { "cf-connecting-ip": "198.51.100.1" }))).status).toBe(429);
    expect((await POST(mcpRequest(callList(), edge, undefined, { "cf-connecting-ip": "198.51.100.2" }))).status).toBe(200);
    // A client on the Railway domain directly cannot mint buckets by forging the header: its x-real-ip is not Cloudflare's.
    for (let i = 0; i < PER_IP_LIMIT; i += 1) await POST(mcpRequest(callList(), "203.0.113.77", undefined, { "cf-connecting-ip": `198.51.100.${100 + i}` }));
    expect((await POST(mcpRequest(callList(), "203.0.113.77", undefined, { "cf-connecting-ip": "198.51.100.250" }))).status).toBe(429);
  });

  it("chargeToolCalls with zero calls is free and never throws", () => {
    for (let i = 0; i < 500; i += 1) expect(chargeToolCalls("zero", 0)).toEqual({ ok: true });
  });
});
