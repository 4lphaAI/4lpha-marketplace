import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({ serviceRead: vi.fn() }));
vi.mock("@/lib/exec/client", () => ({
  execServiceRead: exec.serviceRead,
  execAccountRead: vi.fn(),
  execOwnerRead: vi.fn(),
  execOwnerMutation: vi.fn(),
}));

import { GET as config } from "./config/route";
import { GET as quote } from "./quote/route";
import { GET as guardable } from "./guardable/route";

const V_USDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const V_BNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ACCOUNT = "0x1111111111111111111111111111111111111111";

const CONFIG = {
  chainId: 56, vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB,
  routerV3: "0x1b81D678ffb9C0263b24A97847620C99d213eB14", wbnb: WBNB,
  quoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
  swapFeeTier: 100, maxSagaSlippageBps: 50, dustUsdtWei: "10000000000000000", maxMarkets: 24,
};

const GUARDABLE = {
  account: ACCOUNT, blockNumber: "120362697",
  bases: {
    borrowingPower: { hf: "1300000000000000000", matched: true },
    liquidation: { hf: "1180000000000000000", matched: true },
  },
  markets: [], debts: [], guardable: true,
};

const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });

beforeEach(() => {
  exec.serviceRead.mockReset();
});

describe("GET /api/lending/config", () => {
  it("forwards the perimeter read and re-validates the payload", async () => {
    exec.serviceRead.mockResolvedValue(ok(CONFIG));
    const response = await config();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: CONFIG });
    expect(exec.serviceRead).toHaveBeenCalledWith("/lending/config");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  // A recovery batch built against an unchecked address would approve the wrong
  // spender, so an unmappable payload is a 502 and never a partial config.
  it("refuses a payload it cannot map, and reports a disabled plane as 404", async () => {
    exec.serviceRead.mockResolvedValue(ok({ ...CONFIG, routerV3: "0x00" }));
    expect((await config()).status).toBe(502);
    exec.serviceRead.mockResolvedValue({ status: 404, body: "{}" });
    expect((await config()).status).toBe(404);
    exec.serviceRead.mockResolvedValue({ status: 200, body: "not json" });
    expect((await config()).status).toBe(502);
    exec.serviceRead.mockRejectedValue(new Error("down"));
    expect((await config()).status).toBe(502);
  });
});

describe("GET /api/lending/quote", () => {
  const request = (query: string) => new NextRequest(`https://app.test/api/lending/quote?${query}`);

  it("validates the query BEFORE spending an upstream call", async () => {
    for (const query of [
      "", `tokenIn=${USDT}`, `tokenIn=nope&tokenOut=${WBNB}&amountInWei=1`,
      `tokenIn=${USDT}&tokenOut=${WBNB}&amountInWei=0`,
      `tokenIn=${USDT}&tokenOut=${WBNB}&amountInWei=1e18`,
    ]) {
      const response = await quote(request(query));
      expect(response.status, query).toBe(400);
    }
    expect(exec.serviceRead).not.toHaveBeenCalled();
  });

  it("passes a well-formed pair through and re-validates the answer", async () => {
    const view = {
      tokenIn: USDT, tokenOut: WBNB, fee: 100, amountInWei: "31000000000000000000",
      quotedOutWei: "50000000000000000", minOutWei: "49750000000000000", maxSagaSlippageBps: 50,
    };
    exec.serviceRead.mockResolvedValue(ok(view));
    const response = await quote(request(`tokenIn=${USDT}&tokenOut=${WBNB}&amountInWei=31000000000000000000`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: view });
    expect(String(exec.serviceRead.mock.calls[0]?.[0])).toContain("/lending/quote?tokenIn=");
  });

  it("maps upstream refusals without inventing a floor", async () => {
    exec.serviceRead.mockResolvedValue({ status: 429, body: "{}" });
    expect((await quote(request(`tokenIn=${USDT}&tokenOut=${WBNB}&amountInWei=1`))).status).toBe(429);
    exec.serviceRead.mockResolvedValue({ status: 503, body: "{}" });
    expect((await quote(request(`tokenIn=${USDT}&tokenOut=${WBNB}&amountInWei=1`))).status).toBe(502);
    exec.serviceRead.mockResolvedValue(ok({ tokenIn: USDT }));
    expect((await quote(request(`tokenIn=${USDT}&tokenOut=${WBNB}&amountInWei=1`))).status).toBe(502);
  });
});

describe("GET /api/lending/guardable", () => {
  const request = (query: string) => new NextRequest(`https://app.test/api/lending/guardable?${query}`);

  it("refuses a malformed address before spending an upstream call", async () => {
    expect((await guardable(request("account=not-an-address"))).status).toBe(400);
    expect((await guardable(request(""))).status).toBe(400);
    expect(exec.serviceRead).not.toHaveBeenCalled();
  });

  it("passes DISPLAY mode through with no sizing inputs", async () => {
    exec.serviceRead.mockResolvedValue(ok(GUARDABLE));
    const response = await guardable(request(`account=${ACCOUNT}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: GUARDABLE });
    expect(String(exec.serviceRead.mock.calls[0]?.[0])).toBe(`/lending/guardable?account=${ACCOUNT}`);
  });

  // A receipt that bound only SOME of its inputs would verify at S1 for a budget
  // it never priced, so a partial set is refused here as it is on the plane.
  it("refuses a PARTIAL receipt-mode input set", async () => {
    const response = await guardable(request(`account=${ACCOUNT}&budgetWei=1000&reserveBps=2000`));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { message: string } }).error.message).toContain("together");
    expect(exec.serviceRead).not.toHaveBeenCalled();
  });

  it("forwards a COMPLETE receipt-mode set, zero USDT ceiling included", async () => {
    exec.serviceRead.mockResolvedValue(ok({
      ...GUARDABLE,
      sizing: {
        reserveCapFloorWei: "44000000000000000000", minimumCapDayWei: "90000000000000000",
        mintUsdtWei: "40000000000000000000", reserveNativeWei: "10000000000000000",
        supplyNativeWei: "40000000000000000", ok: true,
      },
      previewReceipt: "v1.abc",
      expiresAtSec: 1_700_000_030,
    }));
    // `maxPerActionUsdtWei=0` is LEGAL: a vBNB-only guard names no USDT ceiling.
    const response = await guardable(request(
      `account=${ACCOUNT}&budgetWei=50000000000000000&reserveBps=2000&maxPerActionUsdtWei=0&rescueReserveCount=6`,
    ));
    expect(response.status).toBe(200);
    const url = String(exec.serviceRead.mock.calls[0]?.[0]);
    expect(url).toContain("maxPerActionUsdtWei=0");
    expect(url).toContain("rescueReserveCount=6");
    const body = await response.json() as { data: { previewReceipt: string } };
    expect(body.data.previewReceipt).toBe("v1.abc");
  });

  it("refuses out-of-band sizing inputs before the upstream call", async () => {
    for (const query of [
      `account=${ACCOUNT}&budgetWei=0&reserveBps=2000&maxPerActionUsdtWei=1&rescueReserveCount=6`,
      `account=${ACCOUNT}&budgetWei=1&reserveBps=999&maxPerActionUsdtWei=1&rescueReserveCount=6`,
      `account=${ACCOUNT}&budgetWei=1&reserveBps=5001&maxPerActionUsdtWei=1&rescueReserveCount=6`,
      `account=${ACCOUNT}&budgetWei=1&reserveBps=2000&maxPerActionUsdtWei=1&rescueReserveCount=0`,
      `account=${ACCOUNT}&budgetWei=1&reserveBps=2000&maxPerActionUsdtWei=1&rescueReserveCount=25`,
      `account=${ACCOUNT}&budgetWei=1&reserveBps=2000&maxPerActionUsdtWei=-1&rescueReserveCount=6`,
    ]) {
      expect((await guardable(request(query))).status, query).toBe(400);
    }
    expect(exec.serviceRead).not.toHaveBeenCalled();
  });

  it("maps the metered and disabled answers, and refuses an unmappable payload", async () => {
    exec.serviceRead.mockResolvedValue({ status: 429, body: "{}" });
    expect((await guardable(request(`account=${ACCOUNT}`))).status).toBe(429);
    exec.serviceRead.mockResolvedValue({ status: 404, body: "{}" });
    expect((await guardable(request(`account=${ACCOUNT}`))).status).toBe(404);
    exec.serviceRead.mockResolvedValue(ok({ ...GUARDABLE, guardable: "maybe" }));
    expect((await guardable(request(`account=${ACCOUNT}`))).status).toBe(502);
  });
});
