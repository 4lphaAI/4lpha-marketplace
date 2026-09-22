import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WBNB_56 } from "@/lib/exec/pairs";
import { GET } from "./route";

const POOL = "0x172fcd41e0913e95784454622d1c3724f546f849";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OHLCV BFF", () => {
  it("forwards a valid token param to the upstream pool feed", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [],
      meta: { source: "fixture", asOf: 1, staleness: "fresh", base: { address: WBNB_56 }, quote: { address: WBNB_56 } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("DATA_PLANE_URL", "https://data.test/");
    const response = await GET(new NextRequest(
      `https://app.test/api/market-data/ohlcv?kind=pool&address=${POOL}&interval=1m&limit=8&token=${WBNB_56.toUpperCase().replace("0X", "0x")}`,
    ));
    expect(response.status).toBe(200);
    const requestedUrl = fetch.mock.calls[0]?.[0] as URL;
    expect(requestedUrl.toString()).toBe(`https://data.test/pools/${POOL}/ohlcv?interval=1m&limit=8&token=${WBNB_56}`);
  });

  it("omits the token param entirely when the caller does not pass one", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [], meta: { source: "fixture", asOf: 1, staleness: "fresh" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("DATA_PLANE_URL", "https://data.test/");
    await GET(new NextRequest(`https://app.test/api/market-data/ohlcv?kind=pool&address=${POOL}&interval=1m&limit=8`));
    const requestedUrl = fetch.mock.calls[0]?.[0] as URL;
    expect(requestedUrl.searchParams.has("token")).toBe(false);
  });

  it("rejects a malformed token before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await GET(new NextRequest(`https://app.test/api/market-data/ohlcv?kind=pool&address=${POOL}&interval=1m&limit=8&token=nope`));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_token" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
