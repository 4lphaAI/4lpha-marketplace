import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { DP_ALLOWLIST, DpError, dpGet } from "@/lib/mcp/dpRead";
import { MEME_FLAG_ALLOWLIST, sanitizeSymbol } from "@/lib/mcp/dataTools";
import { MAX_CACHE_ENTRIES, cacheSize, cachedFlight } from "@/lib/mcp/ttlCache";
import { AGENTIC_WALLET_TTL_MS } from "@/lib/exec/agentic-wallet-read";
import { NVDAB, NVDAB_POOL, OUTSIDE, PLTRB, SPYB, WALLET, agentView, callBody, freshIp, installDataPlane, installExecPlane, mcpRequest, memeGroups, memeRow, resetAll } from "./fixtures";

const run = async (name: string, args: Record<string, unknown> = {}) => (await POST(mcpRequest(callBody(name, args), freshIp()))).json();
const payload = (body: { result: { content: { text: string }[] } }) => JSON.parse(body.result.content[0]!.text);
beforeEach(() => { resetAll(); vi.stubEnv("MCP_DATA_TOOLS_ENABLED", "true"); vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", "true"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("bstock_analysis", () => {
  it("answers the whole reading for a pool-backed bStock, symbol case-insensitive", async () => {
    installDataPlane();
    const body = await run("bstock_analysis", { token: "nvdab" });
    expect(body.result.isError).toBeUndefined();
    const out = payload(body);
    expect(out.token).toEqual({ symbol: "NVDAB", address: NVDAB, underlyingTicker: "NVDA", sectors: ["mag7", "ai-chips"] });
    expect(out.market).toMatchObject({ openState: true, nextCloseMs: 1_900_000_500_000, session: { usEquity: true, state: "rth" } });
    // deepest venue is picked by liquidity, whatever the upstream order.
    expect(out.price).toMatchObject({ venuePriceUsd: 191.2, navUsd: 190, referencePriceUsd: 190.5, tokenToShareRatio: 1, premiumBps: 63 });
    expect(out.depth.deepest).toMatchObject({ dex: "pancakeswap", version: "v3", feeTier: 2500, liquidityUsd: 120_000, quote: { symbol: "USDT" } });
    expect(out.depth).toMatchObject({ venueCount: 2, deepPool: true, priceImpact: null });
    expect(out.depth.priceImpactReason).toMatch(/baw market-order quote/);
    expect(out.eligibility).toEqual({ eligible: true, reason: "listed", source: "allowlist", checkedAt: 5 });
    expect(out.regime).toMatchObject({ label: "neutral", staleness: "fresh" });
    expect(Object.keys(out.indicators)).toEqual(["15m", "1h"]);
    expect(out.indicators["15m"]).toMatchObject({ source: "pool", staleness: "fresh", metrics: { rsi14: { value: 55.5, unit: "pct" } } });
    expect(out.note).toMatch(/not a recommendation/);
  });

  it("flags a shallow pool and never estimates a price impact", async () => {
    installDataPlane();
    const out = payload(await run("bstock_analysis", { token: PLTRB }));
    expect(out.depth).toMatchObject({ venueCount: 0, deepest: null, deepPool: null, priceImpact: null });
  });

  it("always sends the interval explicitly and only for the asked one", async () => {
    const { planeUrls } = installDataPlane();
    await run("bstock_analysis", { token: "NVDAB", interval: "1h" });
    const featureReads = planeUrls.filter((p) => p.startsWith("/trading/features/v2?"));
    expect(featureReads).toEqual([`/trading/features/v2?pools=${NVDAB_POOL}&interval=1h`]);
    expect(planeUrls.every((p) => !/\/trading\/features\/v2\/0x/.test(p))).toBe(true);
    resetAll();
    const both = installDataPlane();
    await run("bstock_analysis", { token: "NVDAB" });
    expect(both.planeUrls.filter((p) => p.includes("interval="))).toHaveLength(2);
    expect(both.planeUrls.filter((p) => p.includes("interval=")).every((p) => /interval=(15m|1h)$/.test(p))).toBe(true);
  });

  it("passes a stale feature set through as nulls with reasons, not as numbers", async () => {
    installDataPlane({ stale: true });
    const out = payload(await run("bstock_analysis", { token: "NVDAB", interval: "15m" }));
    expect(out.indicators["15m"]).toMatchObject({ staleness: "stale", metrics: { rsi14: { value: null, reason: "stale_input" }, roc10Pct: { value: null, reason: "stale_input" } } });
  });

  it("uses the underlying series for a pool-less bStock and reports a pending series as a reason", async () => {
    const { planeUrls } = installDataPlane();
    const out = payload(await run("bstock_analysis", { token: "PLTRB", interval: "15m" }));
    expect(out.indicators["15m"]).toEqual({ error: "features_pending" });
    expect(planeUrls).toContain(`/trading/underlying-features/v1?tokens=${PLTRB}&interval=15m`);
  });

  it("reports a bStock outside both feature watchlists as such", async () => {
    installDataPlane();
    const rows = (await import("./fixtures")).universeRows;
    const extra = { ...rows[0]!, address: "0x" + "99".repeat(20), symbol: "NEWB" };
    rows.push(extra);
    try {
      const out = payload(await run("bstock_analysis", { token: "NEWB", interval: "1h" }));
      expect(out.indicators["1h"]).toEqual({ error: "not_in_feature_watchlist" });
    } finally { rows.pop(); }
  });

  it("answers not_a_bstock for an unknown symbol, an Ondo token and an address outside the universe, and reads nothing else", async () => {
    const { planeUrls } = installDataPlane();
    for (const token of ["NOPE", "0x12", "ONDOX", OUTSIDE, "0x" + "55".repeat(20)]) {
      const body = await run("bstock_analysis", { token });
      expect(body.result.isError, token).toBe(true);
      expect(payload(body)).toEqual({ error: { code: "not_a_bstock" } });
    }
    expect(planeUrls).toEqual(["/universe?lane=bstocks"]);
  });

  it.each([{}, { token: "" }, { token: "bad token!" }, { token: "A".repeat(13) }, { token: "NVDAB", interval: "5m" }, { token: "NVDAB", interval: "1h", extra: 1 }, { token: 5 }])("rejects arguments %j with -32602", async (args) => {
    installDataPlane();
    expect((await run("bstock_analysis", args as Record<string, unknown>)).error.code).toBe(-32602);
  });

  it("fails the tool with a closed code when the universe cannot be read, never an upstream body", async () => {
    installDataPlane({ universeStatus: 503 });
    const body = await run("bstock_analysis", { token: "NVDAB" });
    expect(body.result.isError).toBe(true);
    expect(payload(body)).toEqual({ error: { code: "data_unavailable" } });
  });

  it("degrades one section alone: a failed eligibility read does not fail the analysis", async () => {
    installDataPlane({ eligibilityStatus: 500 });
    const out = payload(await run("bstock_analysis", { token: "NVDAB", interval: "15m" }));
    expect(out.eligibility).toEqual({ error: "data_unavailable" });
    expect(out.token.symbol).toBe("NVDAB");
    expect(out.regime.label).toBe("neutral");
  });

  it("sends the data-plane token server-side and never leaks it", async () => {
    const { fetcher } = installDataPlane();
    const raw = JSON.stringify(await run("bstock_analysis", { token: "NVDAB" }));
    expect(raw).not.toContain("dp-secret");
    expect(fetcher.mock.calls.every(([, init]) => (init?.headers as Record<string, string>)["x-dp-token"] === "dp-secret")).toBe(true);
  });
});

describe("data-plane path allowlist (M1, M3)", () => {
  const forbidden = [
    "/klines/" + NVDAB, "/pools/" + NVDAB_POOL, "/pools/" + NVDAB_POOL + "/ohlcv", "/pools/" + NVDAB_POOL + "/range", "/pools/top", "/tokens/" + NVDAB, "/security/" + NVDAB,
    "/holders/" + NVDAB, "/socials/" + NVDAB, "/diag/latency", "/venus/" + WALLET, "/memes/shortlist?segment=memestock", "/memes/" + NVDAB, "/memes/measure", "/memes/bars?addresses=" + NVDAB,
    "/trading/binance/quote-and-swap", "/internal/binance/pre-transaction/simulate", "/status", "/universe", "/universe?lane=meme", "/universe?lane=bstocks&x=1",
    "/trading/features/v2/" + NVDAB_POOL + "?interval=15m", `/trading/features/v2?pools=${NVDAB_POOL}`, `/trading/features/v2?pools=${NVDAB_POOL}&interval=5m`,
    `/trading/features/v2?pools=${NVDAB_POOL},${NVDAB_POOL}&interval=1h`, "/trading/regime/us-equity?x=1", "/memes/stocks", "/memes/stocks?limit=11&orderBy=live", "/memes/stocks?limit=5&orderBy=smartMoney",
    "/eligibility?addresses=" + NVDAB, "/eligibility/0xZZ", "//dp.evil/eligibility/" + NVDAB, "/universe?lane=bstocks#x",
  ];
  it.each(forbidden)("refuses %s before any request exists", async (path) => {
    const { fetcher } = installDataPlane();
    await expect(dpGet(path)).rejects.toMatchObject({ code: "path_not_allowed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("dpGet is GET only: every request it ever makes is a GET to an allowlisted path", async () => {
    const { fetcher, planeUrls } = installDataPlane();
    await run("bstock_analysis", { token: "NVDAB" });
    await run("meme_stocks", { limit: 3, orderBy: "live" });
    expect(fetcher).toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET" && init.body === undefined)).toBe(true);
    for (const path of planeUrls) expect(DP_ALLOWLIST.some((rule) => rule.pattern.test(path)), path).toBe(true);
  });

  it("only ever asks eligibility and feature reads about addresses it resolved from the bStock universe", async () => {
    const { planeUrls } = installDataPlane();
    for (const token of ["NVDAB", "SPYB", "PLTRB", OUTSIDE, "0x" + "77".repeat(20), "ONDOX"]) await run("bstock_analysis", { token });
    const universe = new Set([NVDAB, PLTRB, SPYB]);
    for (const path of planeUrls.filter((p) => p.startsWith("/eligibility/"))) expect(universe.has(path.slice("/eligibility/".length))).toBe(true);
    const pools = new Set([NVDAB_POOL, "0x" + "cd".repeat(20)]);
    for (const path of planeUrls) {
      const pool = /pools=(0x[0-9a-f]{40})/.exec(path)?.[1];
      if (pool) expect(pools.has(pool)).toBe(true);
    }
  });

  it("maps every upstream failure to a closed code", async () => {
    installDataPlane({ universeStatus: 500 });
    await expect(dpGet("/universe?lane=bstocks")).rejects.toBeInstanceOf(DpError);
    await expect(dpGet("/universe?lane=bstocks")).rejects.toMatchObject({ code: "data_unavailable" });
  });
});

describe("meme_stocks", () => {
  it("returns the field allowlist only, with the top re-sorted by 1h volume and unknown volume last", async () => {
    installDataPlane();
    const out = payload(await run("meme_stocks", {}));
    expect(out.count).toBe(1);
    const stock = out.stocks[0];
    expect(Object.keys(stock).sort()).toEqual(["address", "live", "memes", "openState", "symbol", "top", "underlyingTicker"]);
    expect(stock.memes.byStatus).toEqual({ runner: 2, active: 7, quiet: 5, fading: 10, dead: 16, unknown: 0 });
    expect(stock.live).toEqual({ txs5m: 50, txs1h: 700, volume1hUsd: 60_000 });
    expect(stock.top.map((m: { volume1hUsd: number | null }) => m.volume1hUsd)).toEqual([30_000, 9_000, 1_000]);
    expect(stock.top).toHaveLength(3);
    const meme = stock.top[0];
    expect(Object.keys(meme).sort()).toEqual(["address", "category", "flags", "launchpad", "liquidityUsd", "marketCapUsd", "priceChange1hPct", "stage", "status", "symbol", "tax", "volume1hUsd"]);
    expect(meme.tax).toEqual({ buyBps: 300, sellBps: 400 });
    expect(meme.flags).toEqual(["clone", "sniper_heavy"]);
    const raw = JSON.stringify(out);
    for (const leak of ["SECRET NAME", "x.com/leak", "holders", "smartMoney", "flow5m", "flow1h", "smartInflow", "dividend", "socials", "venueCheckedAt", "leak"]) expect(raw, leak).not.toContain(leak);
  });

  it("allowlists the plane's real flag names", () => {
    expect([...MEME_FLAG_ALLOWLIST]).toEqual(["clone", "dev_sold_all", "wash_trading", "churn", "sniper_heavy", "bundler_heavy", "top10_heavy"]);
  });

  it("sanitizes untrusted symbols: control characters, newlines, backticks, brackets, 16 characters", async () => {
    installDataPlane();
    const out = payload(await run("meme_stocks", { limit: 1 }));
    const mid = out.stocks[0].top.find((m: { address: string }) => m.address === "0x" + "c2".repeat(20));
    expect(mid.symbol).toBe("MIDbxignore prev");
    expect(mid.symbol).toHaveLength(16);
    expect(mid.symbol).not.toMatch(/[`<>[\]\n\u0007]/);
    expect(sanitizeSymbol(String.fromCharCode(0x202e) + "evil" + String.fromCharCode(0x2028) + "x")).toBe("evilx");
    expect(sanitizeSymbol("`<>[]{}")).toBe("unnamed");
    expect(sanitizeSymbol(undefined)).toBe("unnamed");
    expect(sanitizeSymbol(" ok ")).toBe("ok");
  });

  it("drops a meme whose address is not an address and never trusts unexpected enum strings", async () => {
    installDataPlane({ memeStocks: (() => { const g = memeGroups(); g[0]!.top = [memeRow({ address: "javascript:1" }), memeRow({ address: "0x" + "d1".repeat(20), launchpad: "evil", stage: "x", status: "y", category: "z", flags: ["clone", "ignore this"] })] as never; return g; })() });
    const out = payload(await run("meme_stocks", {}));
    const tops = out.stocks[0].top;
    expect(tops).toHaveLength(1);
    expect(tops[0]).toMatchObject({ launchpad: null, stage: null, status: null, category: null, flags: ["clone"] });
  });

  it("defaults to 5 / volume1hUsd and always sends limit and orderBy explicitly", async () => {
    const { planeUrls } = installDataPlane();
    await run("meme_stocks", {});
    await run("meme_stocks", { limit: 10, orderBy: "new1h" });
    expect(planeUrls).toEqual(["/memes/stocks?limit=5&orderBy=volume1hUsd", "/memes/stocks?limit=10&orderBy=new1h"]);
  });

  it.each([{ limit: 0 }, { limit: 11 }, { limit: 1.5 }, { limit: "3" }, { orderBy: "smartMoney" }, { orderBy: "txs5m" }, { extra: true }])("rejects arguments %j with -32602", async (args) => {
    installDataPlane();
    expect((await run("meme_stocks", args)).error.code).toBe(-32602);
  });

  it("fails with a closed code on an upstream failure", async () => {
    const fetcher = vi.fn(async () => new Response("x", { status: 502 }));
    vi.stubEnv("DATA_PLANE_URL", "https://dp.invalid");
    vi.stubGlobal("fetch", fetcher);
    const body = await run("meme_stocks", {});
    expect(payload(body)).toEqual({ error: { code: "data_unavailable" } });
    expect(body.result.isError).toBe(true);
  });
});

describe("agent_status", () => {
  it("returns a bounded summary and leaves out events, runs, reasons and the data-spend log", async () => {
    const { calls } = installExecPlane();
    const mixed = "0x" + "Ab".repeat(20), lower = mixed.toLowerCase();
    const out = payload(await run("agent_status", { wallet: mixed }));
    expect(calls).toEqual([`https://execution.invalid/agentic/wallets/${lower}`]);
    expect(out.wallet).toBe(lower);
    const agent = out.agent;
    expect(agent).toMatchObject({ name: "Agentic AI Trade 01", mode: "trade", status: "running", holdCode: null, endReason: null, termDays: 7, connection: "connected", erc8004: { status: "registered", agentId: "42" }, pageUrl: `https://marketplace.invalid/agentic/${lower}` });
    expect(agent.positions).toHaveLength(10);
    expect(agent.positionCount).toBe(12);
    for (const absent of ["schedule", "portfolio", "dca", "earn", "meme"]) expect(agent, absent).not.toHaveProperty(absent);
    expect(agent.positions[0]).toEqual({ symbol: "S0", status: "open", entryUsdtWei: "20000000000000000000", entryUsdt: "20.00", exitUsdtWei: null, exitUsdt: null, pnlBps: 150, live: { quoteStatus: "quoted" } });
    const raw = JSON.stringify(out);
    for (const leak of ["LLM reasoning leak", "cmc leak", "events", "runs", "cmcLog", "entryTxHash", "secret\"", "exec-secret", "leak"]) expect(raw, leak).not.toContain(leak);
  });

  it.each([["dca", "dca"], ["portfolio", "portfolio"], ["schedule", "schedule"]])("derives mode %s from the block present", async (block, mode) => {
    installExecPlane({ wallet: WALLET, agent: agentView({ [block]: { symbol: "NVDAB", extra: "x" } }) });
    const out = payload(await run("agent_status", { wallet: WALLET }));
    expect(out.agent.mode).toBe(mode);
    expect(out.agent[block]).toBeDefined();
    expect(JSON.stringify(out.agent[block])).not.toContain("extra");
  });

  it("reports a meme paper hire as trade and never summarises its block", async () => {
    installExecPlane({ wallet: WALLET, agent: agentView({ meme: { mode: "paper", paper: { positions: [{ symbol: "SECRETMEME" }] } } }) });
    const out = payload(await run("agent_status", { wallet: WALLET }));
    expect(out.agent.mode).toBe("trade");
    expect(JSON.stringify(out)).not.toContain("SECRETMEME");
  });

  it("answers agent: null for a wallet with no hire", async () => {
    installExecPlane({ wallet: WALLET, custody: "binance-agentic", agent: null });
    const out = payload(await run("agent_status", { wallet: WALLET }));
    expect(out).toMatchObject({ wallet: WALLET, agent: null, pageUrl: `https://marketplace.invalid/agentic/${WALLET}` });
  });

  it.each([{}, { wallet: "0x12" }, { wallet: "vitalik.eth" }, { wallet: WALLET, extra: 1 }, { wallet: 1 }])("rejects arguments %j with -32602 and reads nothing", async (args) => {
    const { fetcher } = installExecPlane();
    expect((await run("agent_status", args as Record<string, unknown>)).error.code).toBe(-32602);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed with agent_unavailable on an execution failure or a missing config", async () => {
    installExecPlane({}, 502);
    expect(payload(await run("agent_status", { wallet: WALLET }))).toEqual({ error: { code: "agent_unavailable" } });
    resetAll();
    vi.stubEnv("EXECUTION_URL", "");
    expect(payload(await run("agent_status", { wallet: WALLET }))).toEqual({ error: { code: "agent_unavailable" } });
  });
});

describe("server-side cache and single flight (M2)", () => {
  it("serves a repeat read inside the window from cache and refetches after it", async () => {
    let now = 1_900_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { planeUrls } = installDataPlane();
    await dpGet("/universe?lane=bstocks");
    await dpGet("/universe?lane=bstocks");
    expect(planeUrls).toHaveLength(1);
    now += 59_000;
    await dpGet("/universe?lane=bstocks");
    expect(planeUrls).toHaveLength(1);
    now += 2_000;
    await dpGet("/universe?lane=bstocks");
    expect(planeUrls).toHaveLength(2);
    // eligibility keeps its own 60 s window, features 30 s.
    await dpGet(`/trading/features/v2?pools=${NVDAB_POOL}&interval=15m`);
    now += 31_000;
    await dpGet(`/trading/features/v2?pools=${NVDAB_POOL}&interval=15m`);
    expect(planeUrls.filter((p) => p.startsWith("/trading/features/v2?"))).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("shares one flight between concurrent callers", async () => {
    const { planeUrls } = installDataPlane();
    await Promise.all(Array.from({ length: 8 }, () => dpGet("/trading/regime/us-equity")));
    expect(planeUrls).toEqual(["/trading/regime/us-equity"]);
    resetAll();
    const again = installDataPlane();
    await Promise.all(Array.from({ length: 5 }, (_, i) => run("meme_stocks", i % 2 ? {} : { limit: 5 })));
    expect(again.planeUrls).toEqual(["/memes/stocks?limit=5&orderBy=volume1hUsd"]);
  });

  it("never caches a failure", async () => {
    let fail = true;
    const loads = vi.fn(async () => { if (fail) throw new Error("boom"); return 1; });
    await expect(cachedFlight("k", 1_000, loads)).rejects.toThrow("boom");
    fail = false;
    await expect(cachedFlight("k", 1_000, loads)).resolves.toBe(1);
    expect(loads).toHaveBeenCalledTimes(2);
  });

  it("pins every window and the entry cap to the plan's literal numbers (M2)", () => {
    expect(Object.fromEntries(DP_ALLOWLIST.map((rule) => [rule.name, rule.ttlMs]))).toEqual({
      universe: 60_000, featureIndex: 60_000, features: 30_000, underlyingIndex: 60_000, underlyingFeatures: 30_000, regime: 30_000, eligibility: 60_000, memeStocks: 30_000, stockCompare: 60_000,
    });
    expect(MAX_CACHE_ENTRIES).toBe(500);
    expect(AGENTIC_WALLET_TTL_MS).toBe(15_000);
  });

  it("holds at most 500 entries", async () => {
    for (let i = 0; i < MAX_CACHE_ENTRIES + 40; i += 1) await cachedFlight("key" + i, 60_000, async () => i);
    expect(cacheSize()).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
  });
});
