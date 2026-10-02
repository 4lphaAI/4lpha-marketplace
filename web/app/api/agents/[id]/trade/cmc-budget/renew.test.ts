import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { POST } from "./route";

const context = { params: Promise.resolve({ id: "tradfi-agent" }) };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("renew CMC BFF forwards the renew header verbatim through the continuation helper", async () => {
  vi.stubEnv("EXECUTION_URL", "https://execution.test");
  vi.stubEnv("EXECUTION_API_TOKEN", "offline-perimeter");
  const fetcher = vi.fn(async () => new Response('{"data":{"operationId":"op"}}', { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const response = await POST(new NextRequest("https://app.test/api/agents/tradfi-agent/trade/cmc-budget", {
    method: "POST", body: "{}", headers: { "x-renew-action": "exact-encoded-renew" },
  }), context);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"data":{"operationId":"op"}}');
  expect(fetcher).toHaveBeenCalledWith("https://execution.test/agents/tradfi-agent/trade/cmc-budget", expect.objectContaining({
    method: "POST", body: "{}", headers: expect.objectContaining({ "x-renew-action": "exact-encoded-renew" }),
  }));
  const init = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(new Headers(init[1].headers).has("x-provision-action")).toBe(false);
});

it("renew CMC BFF refuses both continuation headers before forwarding", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const response = await POST(new NextRequest("https://app.test/api/agents/tradfi-agent/trade/cmc-budget", {
    method: "POST", body: "{}", headers: { "x-renew-action": "renew", "x-provision-action": "provision" },
  }), context);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "ambiguous_owner_auth" } });
  expect(fetcher).not.toHaveBeenCalled();
});
