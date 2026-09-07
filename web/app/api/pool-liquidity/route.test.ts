import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({ serviceRead: vi.fn() }));
vi.mock("@/lib/exec/client", () => ({
  execServiceRead: exec.serviceRead,
}));

import { GET } from "./route";

const POOL = "0x172fcd41e0913e95784454622d1c3724f546f849";

describe("pool-liquidity BFF", () => {
  beforeEach(() => {
    exec.serviceRead.mockReset();
    exec.serviceRead.mockResolvedValue(new Response(JSON.stringify({ data: { bins: [] } }), { status: 200 }));
  });

  it("forwards the lower-cased pool address and the window to the plane's liquidity route", async () => {
    const response = await GET(new NextRequest(`https://app.test/api/pool-liquidity?address=${POOL.toUpperCase().replace("0X", "0x")}&window=60`));
    expect(response.status).toBe(200);
    expect(exec.serviceRead).toHaveBeenCalledWith(`/lp/pools/${POOL}/liquidity?window=60`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("defaults the window to 60 bins", async () => {
    await GET(new NextRequest(`https://app.test/api/pool-liquidity?address=${POOL}`));
    expect(exec.serviceRead).toHaveBeenCalledWith(`/lp/pools/${POOL}/liquidity?window=60`);
  });

  it("refuses a malformed address or window before touching the plane", async () => {
    for (const url of [
      "https://app.test/api/pool-liquidity?address=not-an-address",
      "https://app.test/api/pool-liquidity",
      `https://app.test/api/pool-liquidity?address=${POOL}&window=0`,
      `https://app.test/api/pool-liquidity?address=${POOL}&window=1001`,
      `https://app.test/api/pool-liquidity?address=${POOL}&window=abc`,
      `https://app.test/api/pool-liquidity?address=${POOL}&window=-5`,
    ]) {
      const response = await GET(new NextRequest(url));
      expect(response.status, url).toBe(400);
    }
    expect(exec.serviceRead).not.toHaveBeenCalled();
  });

  it("forwards the plane's own status (503 without a reader) and answers 502 when the plane is unreachable", async () => {
    exec.serviceRead.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "internal_error", message: "no reader" } }), { status: 503 }));
    const forwarded = await GET(new NextRequest(`https://app.test/api/pool-liquidity?address=${POOL}`));
    expect(forwarded.status).toBe(503);
    expect(await forwarded.json()).toEqual({ error: { code: "internal_error", message: "no reader" } });

    exec.serviceRead.mockRejectedValueOnce(new Error("ECONNREFUSED secret-host"));
    const unreachable = await GET(new NextRequest(`https://app.test/api/pool-liquidity?address=${POOL}`));
    expect(unreachable.status).toBe(502);
    expect(await unreachable.text()).not.toContain("secret-host");
  });
});
