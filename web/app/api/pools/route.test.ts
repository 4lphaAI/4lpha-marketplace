import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { poolAddressFor, USDT_56, WBNB_56 } from "@/lib/exec/pairs";
import { GET } from "./route";

const TOKEN = "0xd270d4e1ec6e6e0d28c0ecb8be966ec75997ffff";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function poolRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pool: "0x899c84a12a7b55db3afe150c0706e8e1862cff65",
    protocol: "v3",
    token0: WBNB_56,
    token1: TOKEN,
    token0Symbol: "WBNB",
    token1Symbol: "4Stock",
    fee: 10_000,
    tick: 95_184,
    tvlUsd: 39_782,
    volume24hUsd: 286_949,
    combinedApr: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("resolves a token through deterministic V3 fee-tier pools outside the ranking lane", async () => {
  const directPool = poolAddressFor(TOKEN, WBNB_56, 10_000)!;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("tokens.pancakeswap.finance")) return json({ tokens: [] });
    if (url.endsWith(`/pools/${TOKEN}`)) return json({ error: { code: "not_found" } }, 404);
    if (url.endsWith(`/pools/${directPool}`)) {
      return json({
        data: poolRow({ pool: directPool }),
        meta: { staleness: "fresh", source: "live" },
      });
    }
    if (url.includes("/pools/")) return json({ error: { code: "not_found" } }, 404);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("DATA_PLANE_URL", "https://data.example");

  const response = await GET(new NextRequest(`https://local.invalid/api/pools?address=${TOKEN}`));
  const body = await response.json() as {
    data?: { pool: string; fee: number; wbnbIsToken0: boolean };
    meta?: { resolvedFrom?: string; candidates?: Array<{ pool: string }> };
  };

  expect(response.status).toBe(200);
  expect(body.data?.pool).toBe(directPool);
  expect(body.data?.fee).toBe(10_000);
  expect(body.data?.wbnbIsToken0).toBe(true);
  expect(body.meta?.resolvedFrom).toBe("token");
  expect(body.meta?.candidates?.map((candidate) => candidate.pool)).toEqual([directPool]);
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/pools/top?"))).toBe(false);
});

it("refuses a directly pasted V3 pool that has no WBNB leg", async () => {
  const pool = poolAddressFor(USDT_56, WBNB_56, 100)!;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("tokens.pancakeswap.finance")) return json({ tokens: [] });
    if (url.endsWith(`/pools/${pool}`)) {
      return json({
        data: poolRow({
          pool,
          token0: USDT_56,
          token1: "0x1111111111111111111111111111111111111111",
          token0Symbol: "USDT",
          token1Symbol: "OTHER",
          fee: 100,
        }),
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("DATA_PLANE_URL", "https://data.example");

  const response = await GET(new NextRequest(`https://local.invalid/api/pools?address=${pool}`));
  const body = await response.json() as { error?: { code?: string } };

  expect(response.status).toBe(404);
  expect(body.error?.code).toBe("no_wbnb_v3_pool");
});
