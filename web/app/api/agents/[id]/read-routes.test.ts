import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({ accountRead: vi.fn(), ownerRead: vi.fn() }));
vi.mock("@/lib/exec/client", () => ({
  execAccountRead: exec.accountRead,
  execOwnerRead: exec.ownerRead,
}));

import { GET as ownerView } from "./route";
import { GET as lpView } from "./lp/route";
import { GET as tradeView } from "./trade/view/route";

const context = { params: Promise.resolve({ id: "agent.exact:1" }) };

describe("agent account-read BFF credential choice", () => {
  beforeEach(() => {
    exec.accountRead.mockReset();
    exec.ownerRead.mockReset();
    exec.accountRead.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
    exec.ownerRead.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
  });

  it("forwards the HttpOnly bearer to the owner, LP, and trade projections", async () => {
    const request = () => new NextRequest("https://app.test/api/agents/agent.exact:1", {
      headers: { cookie: "4lpha_account_read=opaque-token" },
    });
    expect((await ownerView(request(), context)).status).toBe(200);
    expect((await lpView(request(), context)).status).toBe(200);
    expect((await tradeView(request(), context)).status).toBe(200);
    expect(exec.accountRead.mock.calls).toEqual([
      ["/agents/agent.exact%3A1/owner-view", "opaque-token"],
      ["/agents/agent.exact%3A1/lp", "opaque-token"],
      ["/agents/agent.exact%3A1/trade/view", "opaque-token"],
    ]);
    expect(exec.ownerRead).not.toHaveBeenCalled();
  });

  it("forwards a signed read only without a cookie", async () => {
    const request = new NextRequest("https://app.test/api/agents/agent.exact:1", {
      headers: { "x-owner-action": "signed-read" },
    });
    expect((await ownerView(request, context)).status).toBe(200);
    expect(exec.ownerRead).toHaveBeenCalledWith(
      "/agents/agent.exact%3A1/owner-view",
      "signed-read",
    );
    expect(exec.accountRead).not.toHaveBeenCalled();
  });

  it("forwards only the signed header when both are present, and rejects neither", async () => {
    exec.ownerRead.mockResolvedValue({ status: 200, body: "{\"data\":{}}" });
    const both = new NextRequest("https://app.test/api/agents/agent.exact:1", {
      headers: { cookie: "4lpha_account_read=opaque-token", "x-owner-action": "signed" },
    });
    expect((await lpView(both, context)).status).toBe(200);
    expect(exec.ownerRead).toHaveBeenCalledTimes(1);
    expect(exec.ownerRead.mock.calls[0]?.[1]).toBe("signed");
    expect(exec.accountRead).not.toHaveBeenCalled();
    exec.ownerRead.mockClear();
    expect((await ownerView(new NextRequest("https://app.test/api/agents/agent.exact:1"), context)).status).toBe(401);
    expect(exec.accountRead).not.toHaveBeenCalled();
    expect(exec.ownerRead).not.toHaveBeenCalled();
  });
});
