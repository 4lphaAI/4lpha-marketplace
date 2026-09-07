import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WBNB_56 } from "@/lib/exec/pairs";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("token snapshot BFF", () => {
  it("proxies the exact address with the server-only credential", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { address: WBNB_56, priceUsd: 700 },
      meta: { source: "fixture", asOf: 1, staleness: "fresh" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("DATA_PLANE_URL", "https://data.test/");
    vi.stubEnv("DATA_PLANE_TOKEN", "server-secret");
    const response = await GET(new NextRequest(`https://app.test/api/market-data/tokens/${WBNB_56}`), {
      params: Promise.resolve({ address: WBNB_56.toUpperCase().replace("0X", "0x") }),
    });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      `https://data.test/tokens/${WBNB_56}`,
      expect.objectContaining({ headers: expect.objectContaining({ "x-dp-token": "server-secret" }) }),
    );
    expect(await response.text()).not.toContain("server-secret");
  });

  it("rejects malformed addresses before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await GET(new NextRequest("https://app.test/api/market-data/tokens/nope"), {
      params: Promise.resolve({ address: "nope" }),
    });
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
