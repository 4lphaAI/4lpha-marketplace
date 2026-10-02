import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as preview } from "../hire/preview/route";
import { GET as schedulable } from "../hire/schedulable/route";
import { POST as settings } from "./trade/settings/route";
import { GET as tradeView } from "./trade/view/route";
import { GET as tradeSimulations } from "./trade/simulations/route";

const context = { params: Promise.resolve({ id: "trade.agent:1" }) };

describe("trade BFF routes", () => {
  beforeEach(() => {
    vi.stubEnv("EXECUTION_URL", "https://execution.test");
    vi.stubEnv("EXECUTION_API_TOKEN", "server-only-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"data":{}}', { status: 200, headers: { "content-type": "application/json" } })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses only the server exec token for a signed trade settings mutation", async () => {
    const response = await settings(new NextRequest("https://app.test/api/agents/trade.agent:1/trade/settings", {
      method: "POST",
      headers: { "x-exec-token": "browser-token", "content-type": "application/json" },
      body: '{"signed":{},"params":{}}',
    }), context);
    expect(response.status).toBe(200);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call?.[0]).toBe("https://execution.test/agents/trade.agent%3A1/trade/settings");
    expect((call?.[1]?.headers as Record<string, string>)["x-exec-token"]).toBe("server-only-token");
  });

  it("keeps the exec token in the BFF while forwarding owner read auth", async () => {
    const response = await tradeView(new NextRequest("https://app.test/api/agents/trade.agent:1/trade/view", {
      headers: { "x-owner-action": "signed-read", "x-exec-token": "browser-token" },
    }), context);
    expect(response.status).toBe(200);
    const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-exec-token"]).toBe("server-only-token");
    expect(headers["x-owner-action"]).toBe("signed-read");
  });

  it("forwards the simulation log read like the trade view: exec token from the BFF, owner read passed through, 401 without a credential", async () => {
    const response = await tradeSimulations(new NextRequest("https://app.test/api/agents/trade.agent:1/trade/simulations", {
      headers: { "x-owner-action": "signed-read", "x-exec-token": "browser-token" },
    }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call?.[0]).toBe("https://execution.test/agents/trade.agent%3A1/trade/simulations");
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers["x-exec-token"]).toBe("server-only-token");
    expect(headers["x-owner-action"]).toBe("signed-read");
    expect((await tradeSimulations(new NextRequest("https://app.test/api/agents/trade.agent:1/trade/simulations"), context)).status).toBe(401);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });

  it("passes executionModel through the hire preview BFF", async () => {
    const request = new NextRequest("https://app.test/api/agents/hire/preview?walletAddress=0x1111111111111111111111111111111111111111&capDayWei=30000000000000000&sizingPreset=trade-v1&executionModel=sigma");
    expect((await preview(request)).status).toBe(200);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://execution.test/agents/hire/preview?walletAddress=0x1111111111111111111111111111111111111111&capDayWei=30000000000000000&sizingPreset=trade-v1&executionModel=sigma");
  });

  it("keeps the exec token in the schedulable BFF", async () => {
    const request = new NextRequest("https://app.test/api/agents/hire/schedulable?amountWei=5000000000000000000&slippageBps=100", {
      headers: { "x-exec-token": "browser-token" },
    });
    expect((await schedulable(request)).status).toBe(200);
    const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-exec-token"]).toBe("server-only-token");
  });
});
