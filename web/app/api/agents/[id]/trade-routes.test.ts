import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as preview } from "../hire/preview/route";
import { POST as settings } from "./trade/settings/route";
import { GET as tradeView } from "./trade/view/route";

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

  it("passes executionModel through the hire preview BFF", async () => {
    const request = new NextRequest("https://app.test/api/agents/hire/preview?walletAddress=0x1111111111111111111111111111111111111111&capDayWei=30000000000000000&sizingPreset=trade-v1&executionModel=sigma");
    expect((await preview(request)).status).toBe(200);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://execution.test/agents/hire/preview?walletAddress=0x1111111111111111111111111111111111111111&capDayWei=30000000000000000&sizingPreset=trade-v1&executionModel=sigma");
  });
});
