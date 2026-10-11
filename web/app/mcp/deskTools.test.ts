import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { callBody, freshIp, installDesk, mcpRequest, resetAll } from "./fixtures";

const run = async (name: string, args: Record<string, unknown>) => (await POST(mcpRequest(callBody(name, args), freshIp()))).json();
const payload = (body: { result: { content: { text: string }[] } }) => JSON.parse(body.result.content[0]!.text);

beforeEach(() => { resetAll(); vi.stubEnv("MCP_DATA_TOOLS_ENABLED", "true"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("desk_preview", () => {
  it("relays the desk's free preview, upper-casing the ticker", async () => {
    const { calls } = installDesk();
    const body = await run("desk_preview", { ticker: "nvda", usdt: 500 });
    const out = payload(body);
    expect(out.markdown).toMatch(/free preview, NVDA/);
    expect(out.agent.erc8004).toBe(369195);
    expect(calls).toEqual([{ skill: "preview", ticker: "NVDA", usdt: 500 }]);
  });
  it("caches a repeat so assistants share the desk's preview budget", async () => {
    const { fetcher } = installDesk();
    await run("desk_preview", { ticker: "TSLA" });
    await run("desk_preview", { ticker: "TSLA" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("maps a busy desk and an unreachable desk to closed error codes", async () => {
    installDesk(() => ({ status: "retry", error: "busy" }));
    expect(payload(await run("desk_preview", { ticker: "AAPL" })).error.code).toBe("desk_busy");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(payload(await run("desk_preview", { ticker: "MSFT" })).error.code).toBe("desk_unavailable");
  });
  it("refuses bad arguments before any call", async () => {
    const { fetcher } = installDesk();
    for (const args of [{}, { ticker: "NVDA1" }, { ticker: "NVDA", usdt: 0 }, { ticker: "NVDA", extra: 1 }]) {
      expect((await run("desk_preview", args)).error.code, JSON.stringify(args)).toBe(-32602);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses an oversized desk reply", async () => {
    installDesk(() => ({ status: "ok", markdown: "x".repeat(70_000) }));
    expect(payload(await run("desk_preview", { ticker: "AMD" })).error.code).toBe("desk_unavailable");
  });
});

describe("desk_quote", () => {
  it("returns the signed quote, the price and the buying steps, naming the payment asset", async () => {
    const { calls } = installDesk();
    const out = payload(await run("desk_quote", { ticker: "NVDA", usdt: 500 }));
    expect(out.priceU).toBe(0.1);
    expect(out.quote.provider_sig).toMatch(/^0x22/);
    expect(out.howToBuy.join(" ")).toMatch(/bag erc8183 buy --network bsc-mainnet --provider 0x592EF127feFd45eAA56fE0D715dAAF72F998A652/);
    expect(calls[0]).toMatchObject({ skill: "negotiate", task_description: '{"type":"stock_report","ticker":"NVDA","usdt":500}' });
    expect((calls[0]!.terms as Record<string, unknown>).currency).toBe("0xcE24439F2D9C6a2289F741120FE202248B666666");
  });
  it("fails closed on a reply without a signature", async () => {
    installDesk(() => ({ response: { terms: {} } }));
    expect(payload(await run("desk_quote", { ticker: "NVDA" })).error.code).toBe("desk_unavailable");
  });
});

describe("listing", () => {
  it("hides both desk tools when the data tools are off", async () => {
    vi.stubEnv("MCP_DATA_TOOLS_ENABLED", "");
    const { fetcher } = installDesk();
    expect((await run("desk_preview", { ticker: "NVDA" })).error.code).toBe(-32602);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
