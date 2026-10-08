/**
 * The data tools of the public MCP: `agent_status`, `bstock_analysis`, `meme_stocks`, `stock_compare`.
 *
 * Listed only when MCP_DATA_TOOLS_ENABLED === "true" (agent_status also needs NEXT_PUBLIC_AGENTIC_WALLET_ENABLED),
 * both read at request time. Every datum comes from a cached, single-flight read: the data plane through `dpGet`
 * (closed path table) and the execution plane through the one wallet read the agentic BFF also uses. Nothing here
 * writes, signs or reaches an upstream the plane does not already serve from its store.
 *
 * A tool that cannot answer returns a normal result flagged `isError` whose text is `{"error":{"code":...}}` with a
 * closed code; bad arguments are JSON-RPC -32602 (`null` from `runDataTool`). Upstream bodies are never echoed.
 * A section that fails alone (eligibility, regime, one interval) degrades to `{ error: code }`; only the universe
 * read fails a whole bstock_analysis.
 */
import { readAgenticWallet } from "../exec/agentic-wallet-read";
import { dcaBlock, earnBlock, money, portfolioBlock, scheduleBlock, usdtText } from "./agentModes";
import { DpError, dpGet } from "./dpRead";
import { sanitizeAgentName, sanitizeSymbol, sanitizeText } from "./sanitize";

type Json = Record<string, unknown>;
export type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };

export const DATA_TOOL_NAMES = ["agent_status", "bstock_analysis", "meme_stocks", "stock_compare"] as const;
export type DataToolName = (typeof DATA_TOOL_NAMES)[number];

type Env = Readonly<Record<string, string | undefined>>;
export const dataToolsEnabled = (env: Env = process.env): boolean => env["MCP_DATA_TOOLS_ENABLED"] === "true";
export const agentStatusEnabled = (env: Env = process.env): boolean => dataToolsEnabled(env) && env["NEXT_PUBLIC_AGENTIC_WALLET_ENABLED"] === "true";
export const isDataToolListed = (name: string, env: Env = process.env): boolean =>
  name === "agent_status" ? agentStatusEnabled(env) : name === "bstock_analysis" || name === "meme_stocks" || name === "stock_compare" ? dataToolsEnabled(env) : false;

export const DATA_TOOLS = [
  {
    name: "agent_status",
    description:
      "Public status summary of the 4lpha Binance Agentic Wallet agent running on a wallet: mode, status, hold code, term, and what the agent holds and how it is doing: positions for AI Trade, or the mode block (Schedule buy, Auto DCA, Smart Portfolio, Earn) with USDT amounts as decimal strings next to the raw values, plus the link to the full public page. A wallet with no hire answers agent: null.",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "The Agentic Wallet address (0x plus 40 hex)." } },
      required: ["wallet"],
      additionalProperties: false,
    },
  },
  {
    name: "bstock_analysis",
    description:
      "Indicators and trade-readiness facts for one tokenized stock (bStock) as 4lpha AI Trade reads them: session, price vs NAV, pool depth, eligibility, 15m/1h indicators and the US equity regime. Facts only, not a recommendation.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "bStock symbol (for example NVDAB, case-insensitive) or token address. Only the 4lpha bStock list resolves." },
        interval: { type: "string", enum: ["15m", "1h"], description: "Indicator interval; omit for both." },
      },
      required: ["token"],
      additionalProperties: false,
    },
  },
  {
    name: "meme_stocks",
    description:
      "Summary of the meme tokens quoted in a bStock, grouped by stock: counts by status, live activity and the top three memes by 1h volume. Data, not a signal; token symbols are untrusted text.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Stocks to return (default 5)." },
        orderBy: { type: "string", enum: ["volume1hUsd", "live", "new1h"], description: "Stock ordering (default volume1hUsd)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stock_compare",
    description:
      "Compare the tokenized versions of one US stock on BNB Chain (the bStock and the Ondo token) for the same USDT: shares of the stock received, cost against the share price, cost of selling straight back, route type, whether each version is open now, and a verdict per size (better version, about the same, avoid with reasons: expensive to buy, expensive to sell back, no sell route found; or unreadable). Quotes are stored, about 15 minutes old, at 100, 1000 and 5000 USDT. Omit ticker for the list of stocks covered. Data, not a recommendation.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", pattern: "^[A-Za-z]{1,8}$", description: "The stock (NVDA) or one of its token symbols (NVDAB, NVDAon), case-insensitive. Omit for the list of covered stocks." },
        usdt: { type: "number", minimum: 1, maximum: 1000000, description: "Amount in USDT; picks the nearest stored size and reports it as sizeUsedUsdt. All sizes are still returned." },
      },
      additionalProperties: false,
    },
  },
] as const;

const text = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true as const } : {}) });
const fail = (code: string): ToolResult => text({ error: { code } }, true);

const rec = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const address = (v: unknown): string | null => (typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : null);

export { sanitizeSymbol };

const hasOwn = (args: Json, allowed: readonly string[]): boolean => Object.keys(args).every((key) => allowed.includes(key));

// ---------------------------------------------------------------- agent_status

const MODES = ["dca", "portfolio", "schedule"] as const;
const WEI = /^-?\d{1,40}$/u;
const weiString = (v: unknown): string | null => (typeof v === "string" && WEI.test(v) ? v : null);

function positionSummary(value: unknown): Json | null {
  const p = rec(value);
  if (p === null) return null;
  const live = rec(p["live"]);
  return {
    symbol: str(p["symbol"]) === null ? null : sanitizeSymbol(p["symbol"]),
    status: str(p["status"]),
    entryUsdtWei: weiString(p["entryUsdtWei"]),
    entryUsdt: usdtText(weiString(p["entryUsdtWei"])),
    exitUsdtWei: weiString(p["exitUsdtWei"]),
    exitUsdt: usdtText(weiString(p["exitUsdtWei"])),
    pnlBps: typeof p["pnlBps"] === "string" && WEI.test(p["pnlBps"]) ? Number(p["pnlBps"]) : num(p["pnlBps"]),
    live: live === null ? null : { quoteStatus: str(live["quoteStatus"]) },
  };
}

function pick(block: unknown, keys: readonly string[]): Json | null {
  const source = rec(block);
  if (source === null) return null;
  const out: Json = {};
  for (const key of keys) {
    const v = source[key];
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v;
  }
  return out;
}

export function summariseAgent(wallet: string, agent: Json, origin: string): Json {
  // A meme paper hire (flag off in production) reports as trade; its block is never summarised here.
  const mode = MODES.find((m) => agent[m] !== undefined) ?? "trade";
  const settings = rec(agent["settings"]);
  const identity = rec(agent["erc8004Identity"]);
  const common = {
    wallet,
    name: sanitizeAgentName(agent["name"]),
    mode,
    status: str(agent["status"]),
    holdCode: str(agent["holdCode"]),
    endReason: str(agent["endReason"]),
    termDays: num(agent["termDays"]),
    termEndAction: str(agent["termEndAction"]),
    hireStartedAtMs: num(agent["hireStartedAtMs"]),
    entryCutoffAtMs: num(agent["entryCutoffAtMs"]),
    hireEndsAtMs: num(agent["hireEndsAtMs"]),
    connection: str(agent["connection"]),
  };
  const tail = {
    earn: agent["earn"] === undefined ? undefined : earnBlock(agent["earn"]),
    erc8004: identity === null ? null : { status: str(identity["status"]), agentId: typeof identity["agentId"] === "string" && /^[0-9]{1,78}$/u.test(identity["agentId"]) ? identity["agentId"] : null },
    pageUrl: `${origin}/agentic/${wallet}`,
    note: "Summary of the public view. Events, run logs, model reasons and the data-spend log are on the page.",
  };
  if (mode === "trade") {
    const summary = pick(agent["summary"], ["openPositions", "maxOpenPositions", "closedTrades", "wins", "winRateBps", "grossDeltaWei", "grossComplete"]);
    return {
      ...common,
      settings: withUsdt(pick(settings, ["executionModel", "capitalQuoteWei", "entryWei", "maxOpenPositions", "slippageBps", "stopLossBps", "takeProfitBps", "maxHoldSec"]), ["capitalQuote", "entry"]),
      summary: summary === null ? null : { ...summary, ...money("grossDelta", summary["grossDeltaWei"]) },
      positions: arr(agent["positions"]).slice(0, 10).map(positionSummary).filter((p): p is Json => p !== null),
      positionCount: arr(agent["positions"]).length,
      ...tail,
    };
  }
  // Schedule, DCA and Smart Portfolio: the mode block is the body. The AI Trade position list, summary and per-trade settings do not apply.
  const own = settings === null ? null : {
    ...money("capitalQuote", settings["capitalQuoteWei"]),
    slippageBps: num(settings["slippageBps"]),
    ...(mode === "portfolio" ? { portfolioDriftBps: num(settings["portfolioDriftBps"]) } : {}),
  };
  return {
    ...common,
    settings: own,
    ...(mode === "schedule" ? { schedule: scheduleBlock(agent["schedule"]) } : {}),
    ...(mode === "portfolio" ? { portfolio: portfolioBlock(agent["portfolio"]) } : {}),
    ...(mode === "dca" ? { dca: dcaBlock(agent["dca"], settings?.["capitalQuoteWei"]) } : {}),
    ...tail,
  };
}

/** Adds the two-decimal USDT string next to each named raw `...Wei` field the block carries. */
function withUsdt(block: Json | null, names: readonly string[]): Json | null {
  if (block === null) return null;
  const out: Json = { ...block };
  for (const name of names) {
    const raw = block[`${name}Wei`];
    if (raw !== undefined) out[`${name}Usdt`] = usdtText(raw);
  }
  return out;
}

async function agentStatus(args: Json, origin: string): Promise<ToolResult | null> {
  if (!hasOwn(args, ["wallet"]) || typeof args["wallet"] !== "string" || !ADDRESS.test(args["wallet"])) return null;
  const wallet = args["wallet"].toLowerCase();
  let read;
  try {
    read = await readAgenticWallet(`wallets/${wallet}`);
  } catch {
    return fail("agent_unavailable");
  }
  if (read.status < 200 || read.status >= 300) return fail("agent_unavailable");
  let envelope: Json | null;
  try { envelope = rec(JSON.parse(read.body)); } catch { envelope = null; }
  const data = rec(envelope?.["data"]);
  if (data === null) return fail("agent_unavailable");
  const agent = rec(data["agent"]);
  if (agent === null) return text({ wallet, custody: "binance-agentic", agent: null, note: "No 4lpha agent is running or was recorded on this wallet.", pageUrl: `${origin}/agentic/${wallet}` });
  return text({ wallet, custody: "binance-agentic", agent: summariseAgent(wallet, agent, origin) });
}

// ------------------------------------------------------------- bstock_analysis

const INTERVALS = ["15m", "1h"] as const;
type Interval = (typeof INTERVALS)[number];
export const DEEP_POOL_LIQUIDITY_USD = 10_000;
const PRICE_IMPACT_REASON =
  "4lpha publishes no price-impact estimate: no cached source exists and a single-range guess would ignore tick crossings and aggregator or RFQ routing. Use the depth facts, and the free `baw market-order quote` for the real price of an amount.";
const ANALYSIS_NOTE =
  "These are the indicators 4lpha AI Trade reads; AI Trade's own scoring is not published. This is data, not a recommendation or investment advice.";

const code = (e: unknown): string => (e instanceof DpError ? e.code : "data_unavailable");

function metricView(v: unknown): Json | null {
  const m = rec(v);
  if (m === null) return null;
  return { value: num(m["value"]), reason: str(m["reason"]), unit: str(m["unit"]), ...(num(m["asOf"]) === null ? {} : { asOf: num(m["asOf"]) }) };
}

function indicatorView(source: "pool" | "underlying", snapshot: Json): Json {
  const coverage = rec(snapshot["coverage"]);
  const metrics: Json = {};
  for (const [name, value] of Object.entries(rec(snapshot["metrics"]) ?? {})) {
    const view = metricView(value);
    if (view !== null) metrics[name] = view;
  }
  return {
    source,
    calculatedAt: num(snapshot["calculatedAt"]),
    staleness: oneOf(snapshot["staleness"], ["fresh", "stale"] as const),
    coverage: coverage === null ? null : { availableBars: num(coverage["availableBars"]), contiguousBars: num(coverage["contiguousBars"]), realBars: num(coverage["realBars"]), filledBars: num(coverage["filledBars"]), latestClose: num(coverage["latestClose"]) },
    metrics,
  };
}

function sessionView(v: unknown): Json | null {
  const s = rec(v);
  return s === null ? null : { usEquity: bool(s["usEquity"]), reason: str(s["reason"]), state: str(s["state"]), nextBoundaryAt: num(s["nextBoundaryAt"]), sessionStart: num(s["sessionStart"]), lastRthCloseAt: num(s["lastRthCloseAt"]) };
}

/** One interval of one series: `{ indicators }` / `{ error }`, and the session block the snapshot carried. */
async function readInterval(source: "pool" | "underlying", key: string, interval: Interval): Promise<{ view: Json; session: Json | null }> {
  const path = source === "pool"
    ? `/trading/features/v2?pools=${key}&interval=${interval}`
    : `/trading/underlying-features/v1?tokens=${key}&interval=${interval}`;
  try {
    const body = rec(await dpGet(path));
    const entry = rec(rec(body?.["data"])?.[key]);
    const snapshot = rec(entry?.["data"]);
    if (snapshot === null) return { view: { error: str(rec(entry?.["error"])?.["code"]) ?? "features_pending" }, session: null };
    return { view: indicatorView(source, snapshot), session: sessionView(snapshot["session"]) };
  } catch (e) {
    return { view: { error: code(e) }, session: null };
  }
}

async function readIndicators(token: string, intervals: readonly Interval[]): Promise<{ indicators: Json; session: Json | null }> {
  let source: "pool" | "underlying" | null = null, key = token;
  try {
    const index = rec(rec(await dpGet("/trading/features/v2/pools"))?.["data"]);
    const hit = index === null ? undefined : arr(index["pools"]).map(rec).find((p) => p !== null && address(p["tokenAddress"]) === token);
    if (hit !== undefined && hit !== null && address(hit["pool"]) !== null) { source = "pool"; key = address(hit["pool"])!; }
  } catch (e) {
    return { indicators: Object.fromEntries(intervals.map((i) => [i, { error: code(e) }])), session: null };
  }
  if (source === null) {
    try {
      const index = rec(rec(await dpGet("/trading/underlying-features/v1/tokens"))?.["data"]);
      if (index !== null && arr(index["tokens"]).map(rec).some((t) => t !== null && address(t["tokenAddress"]) === token)) source = "underlying";
      else return { indicators: Object.fromEntries(intervals.map((i) => [i, { error: index === null ? "features_pending" : "not_in_feature_watchlist" }])), session: null };
    } catch (e) {
      return { indicators: Object.fromEntries(intervals.map((i) => [i, { error: code(e) }])), session: null };
    }
  }
  const results = await Promise.all(intervals.map((interval) => readInterval(source!, key, interval)));
  return { indicators: Object.fromEntries(intervals.map((interval, i) => [interval, results[i]!.view])), session: results.find((r) => r.session !== null)?.session ?? null };
}

async function readEligibility(token: string): Promise<Json> {
  try {
    const data = rec(rec(await dpGet(`/eligibility/${token}`))?.["data"]);
    if (data === null) return { error: "data_unavailable" };
    return { eligible: bool(data["eligible"]), reason: str(data["reason"]), source: str(data["source"]), checkedAt: num(data["checkedAt"]) };
  } catch (e) {
    return { error: code(e) };
  }
}

async function readRegime(): Promise<Json> {
  try {
    const body = rec(await dpGet("/trading/regime/us-equity"));
    const data = rec(body?.["data"]);
    if (data === null) return { error: "data_unavailable" };
    const leg = (v: unknown): Json | null => { const l = rec(v); return l === null ? null : { staleness: str(l["staleness"]), available: bool(l["available"]), reason: str(l["reason"]) }; };
    return {
      label: oneOf(data["regime"], ["risk_on", "risk_off", "neutral", "unavailable"] as const),
      reasons: arr(data["reasons"]).filter((r): r is string => typeof r === "string").slice(0, 8).map((r) => r.slice(0, 120)),
      asOf: num(data["asOf"]),
      sessionState: str(data["sessionState"]),
      legs: { spy: leg(data["spy"]), qqq: leg(data["qqq"]) },
      staleness: str(rec(body?.["meta"])?.["staleness"]),
    };
  } catch (e) {
    return { error: code(e) };
  }
}

function deepestVenue(entry: Json): Json | null {
  const venues = arr(entry["venues"]).map(rec).filter((v): v is Json => v !== null);
  const sorted = [...venues].sort((a, b) => (num(b["liquidityUsd"]) ?? -1) - (num(a["liquidityUsd"]) ?? -1));
  return sorted[0] ?? null;
}

async function bstockAnalysis(args: Json): Promise<ToolResult | null> {
  if (!hasOwn(args, ["token", "interval"]) || typeof args["token"] !== "string") return null;
  const raw = args["token"].trim();
  const asAddress = ADDRESS.test(raw), asSymbol = /^[A-Za-z0-9]{1,12}$/u.test(raw);
  if (!asAddress && !asSymbol) return null;
  if (args["interval"] !== undefined && oneOf(args["interval"], INTERVALS) === null) return null;
  const intervals: readonly Interval[] = args["interval"] === undefined ? INTERVALS : [args["interval"] as Interval];

  // M3: nothing else is read before the token is resolved inside the bStock universe.
  let universe: Json | null;
  try { universe = rec(await dpGet("/universe?lane=bstocks")); } catch { return fail("data_unavailable"); }
  const rows = arr(universe?.["data"]).map(rec).filter((r): r is Json => r !== null && r["lane"] === "bstocks");
  const entry = rows.find((r) => asAddress ? address(r["address"]) === raw.toLowerCase() : str(r["symbol"])?.toUpperCase() === raw.toUpperCase());
  const token = entry === undefined ? null : address(entry["address"]);
  if (entry === undefined || token === null) return fail("not_a_bstock");

  const [eligibility, regime, features] = await Promise.all([readEligibility(token), readRegime(), readIndicators(token, intervals)]);
  const venue = deepestVenue(entry);
  const liquidity = venue === null ? null : num(venue["liquidityUsd"]);
  const quote = rec(venue?.["quote"]);
  return text({
    token: { symbol: str(entry["symbol"]) === null ? null : sanitizeSymbol(entry["symbol"]), address: token, underlyingTicker: str(entry["underlyingTicker"]), sectors: arr(entry["sectors"]).filter((s): s is string => typeof s === "string").slice(0, 12) },
    staleness: str(entry["staleness"]),
    market: { openState: bool(entry["openState"]), reasonCode: str(entry["reasonCode"]), nextOpenMs: num(entry["nextOpenMs"]), nextCloseMs: num(entry["nextCloseMs"]), session: features.session },
    price: { venuePriceUsd: venue === null ? null : num(venue["priceUsd"]), navUsd: num(entry["tokenPriceUsd"]), referencePriceUsd: num(entry["referencePriceUsd"]), tokenToShareRatio: num(entry["tokenToShareRatio"]), premiumBps: num(entry["premiumBps"]), asOf: venue === null ? null : num(venue["asOf"]) },
    depth: {
      venueCount: arr(entry["venues"]).length,
      deepest: venue === null ? null : { dex: str(venue["dex"]), version: str(venue["version"]), feeTier: num(venue["feeTier"]), quote: quote === null ? null : { symbol: str(quote["symbol"]), address: address(quote["address"]) }, liquidityUsd: liquidity, volume24hUsd: num(venue["volume24hUsd"]), asOf: num(venue["asOf"]) },
      deepPool: liquidity === null ? null : liquidity >= DEEP_POOL_LIQUIDITY_USD,
      deepPoolThresholdUsd: DEEP_POOL_LIQUIDITY_USD,
      priceImpact: null,
      priceImpactReason: PRICE_IMPACT_REASON,
    },
    eligibility,
    indicators: features.indicators,
    regime,
    note: ANALYSIS_NOTE,
  });
}

// ----------------------------------------------------------------- meme_stocks

const STATUSES = ["runner", "active", "quiet", "fading", "dead", "unknown"] as const;
const STAGES = ["new", "bonding", "graduating", "graduated"] as const;
const CATEGORIES = ["daily_runner", "long_runner", "bluechip"] as const;
const LAUNCHPADS = ["flap", "fourmeme"] as const;
/** The data plane's real names (`MemeFlag`): the plan wrote sniper|bundler, the plane says sniper_heavy|bundler_heavy. */
export const MEME_FLAG_ALLOWLIST = ["clone", "dev_sold_all", "wash_trading", "churn", "sniper_heavy", "bundler_heavy", "top10_heavy"] as const;
const ORDERS = ["volume1hUsd", "live", "new1h"] as const;

function memeView(v: unknown): Json | null {
  const m = rec(v);
  const memeAddress = m === null ? null : address(m["address"]);
  if (m === null || memeAddress === null) return null;
  const tax = rec(m["tax"]);
  return {
    address: memeAddress,
    symbol: sanitizeSymbol(m["symbol"]),
    launchpad: oneOf(m["launchpad"], LAUNCHPADS),
    stage: oneOf(m["stage"], STAGES),
    status: oneOf(m["status"], STATUSES),
    category: oneOf(m["category"], CATEGORIES),
    marketCapUsd: num(m["marketCapUsd"]),
    liquidityUsd: num(m["liquidityUsd"]),
    volume1hUsd: num(m["volume1hUsd"]),
    priceChange1hPct: num(m["priceChange1hPct"]),
    tax: tax === null ? null : { buyBps: num(tax["buyBps"]), sellBps: num(tax["sellBps"]) },
    flags: arr(m["flags"]).filter((f): f is (typeof MEME_FLAG_ALLOWLIST)[number] => oneOf(f, MEME_FLAG_ALLOWLIST) !== null),
  };
}

function stockView(v: unknown): Json | null {
  const g = rec(v);
  const stock = rec(g?.["stock"]);
  const stockAddress = stock === null ? null : address(stock["address"]);
  if (g === null || stock === null || stockAddress === null) return null;
  const memes = rec(g["memes"]), activity = rec(g["activity"]), by = rec(memes?.["byStatus"]);
  const top = arr(g["top"]).map(memeView).filter((m): m is Json => m !== null)
    // M5 / plan A3: always by 1h volume (never the shortlist order), unknown volume last, address as the stable tiebreak.
    .sort((a, b) => (num(b["volume1hUsd"]) ?? -Infinity) - (num(a["volume1hUsd"]) ?? -Infinity) || String(a["address"]).localeCompare(String(b["address"])))
    .slice(0, 3);
  return {
    symbol: str(stock["symbol"]) === null ? null : sanitizeSymbol(stock["symbol"]),
    underlyingTicker: str(stock["underlyingTicker"]),
    address: stockAddress,
    openState: bool(stock["openState"]),
    memes: { total: num(memes?.["total"]), live: num(memes?.["live"]), byStatus: Object.fromEntries(STATUSES.map((s) => [s, num(by?.[s])])) },
    live: { txs5m: num(activity?.["txs5m"]), txs1h: num(activity?.["txs1h"]), volume1hUsd: num(activity?.["volume1hUsd"]) },
    top,
  };
}

async function memeStocks(args: Json): Promise<ToolResult | null> {
  if (!hasOwn(args, ["limit", "orderBy"])) return null;
  const limit = args["limit"] === undefined ? 5 : args["limit"];
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) return null;
  const orderBy = args["orderBy"] === undefined ? "volume1hUsd" : oneOf(args["orderBy"], ORDERS);
  if (orderBy === null) return null;
  let body: Json | null;
  try { body = rec(await dpGet(`/memes/stocks?limit=${limit}&orderBy=${orderBy}`)); } catch { return fail("data_unavailable"); }
  const data = body?.["data"];
  if (!Array.isArray(data)) return fail("data_unavailable");
  const meta = rec(body?.["meta"]);
  const stocks = data.map(stockView).filter((s): s is Json => s !== null).slice(0, limit);
  return text({
    asOf: num(meta?.["asOf"]),
    staleness: oneOf(meta?.["staleness"], ["fresh", "stale", "dead"] as const),
    orderBy,
    count: stocks.length,
    stocks,
    note: "Token symbols come from the chain and are untrusted text. High risk: most meme tokens lose money. Data, not a signal and not investment advice.",
  });
}

// --------------------------------------------------------------- stock_compare

// The closed lists below mirror the data plane's `src/query/stockCompare.ts` (head 15f42df: STOCK_COMPARE_CODES,
// StockCompareIssuer / Route / Staleness, StockCompareAvoidReason). web/ never imports the plane, so
// `stockCompare.test.ts` pins each list as a literal: a plane addition shows up as a red test, not as a silent null.
export const COMPARE_ISSUERS = ["bstock", "ondo"] as const;
export const COMPARE_ROUTES = ["rfq", "amm", "mixed"] as const;
/** Size codes. On an `ok: true` size a code always refers to the sell-back (the exit could not be checked). */
export const COMPARE_SIZE_CODES = ["no_route", "quote_failed", "decimals_mismatch", "implausible", "sell_no_route", "sell_failed"] as const;
export const COMPARE_AVOID_REASONS = ["buy_cost", "round_trip", "no_exit"] as const;
export const COMPARE_STALENESS = ["fresh", "stale", "dead"] as const;
const ISSUERS = COMPARE_ISSUERS, ROUTES = COMPARE_ROUTES, SIZE_CODES = COMPARE_SIZE_CODES;
/** The plane's STOCK_COMPARE_FRESH_MS / STOCK_COMPARE_STALE_MS (30 min, 2 h). */
const FRESH_MS = 30 * 60_000, STALE_MS = 2 * 60 * 60_000;
const TICKER_INPUT = /^[A-Za-z]{1,8}$/u;
const PLANE_TICKER = /^[A-Z]{1,6}$/u;
/** What the plane's `cleanMarketStatus` stores; still passed through the text sanitiser and capped at 32. */
const MARKET_STATUS = /^[A-Za-z0-9._ -]{1,32}$/u;
const MAX_TICKERS = 100;
const MAX_VENUES = 4;
const MAX_SIZES = 5;
const COMPARE_NOTE =
  "Quotes are stored and refresh about every 15 minutes at fixed sizes (100, 1000 and 5000 USDT). The Binance quote for the exact amount is the final word. Data, not a recommendation and not investment advice.";

function compareSize(v: unknown): Json | null {
  const s = rec(v);
  const usdt = s === null ? null : num(s["usdt"]);
  if (s === null || usdt === null) return null;
  const venues = arr(s["venues"]).map((name) => sanitizeText(name, 32, "")).filter((name) => name !== "").slice(0, MAX_VENUES);
  const failure = oneOf(s["code"], SIZE_CODES);
  return {
    usdt,
    ok: s["ok"] === true,
    ...(failure === null ? {} : { code: failure }),
    tokensOut: num(s["tokensOut"]),
    shares: num(s["shares"]),
    costBps: num(s["costBps"]),
    roundTripBps: num(s["roundTripBps"]),
    route: oneOf(s["route"], ROUTES),
    venues,
  };
}

function compareVersion(v: unknown): Json | null {
  const x = rec(v);
  const issuer = x === null ? null : oneOf(x["issuer"], ISSUERS);
  if (x === null || issuer === null) return null;
  const status = str(x["marketStatus"]);
  return {
    issuer,
    symbol: str(x["symbol"]) === null ? null : sanitizeSymbol(x["symbol"]),
    address: address(x["address"]),
    ratio: num(x["ratio"]),
    openState: bool(x["openState"]),
    marketStatus: status !== null && MARKET_STATUS.test(status) ? sanitizeText(status, 32, "") || null : null,
    sizes: arr(x["sizes"]).map(compareSize).filter((s): s is Json => s !== null).sort((a, b) => (a["usdt"] as number) - (b["usdt"] as number)).slice(0, MAX_SIZES),
  };
}

/**
 * One avoid entry: the plane's `{ issuer, reasons[] }`, or the older bare issuer string (no reasons). `null` when the entry
 * is neither, which makes the whole verdict unreadable rather than letting an unknown shape read as "nothing to avoid".
 */
function avoidEntry(v: unknown): Json | null {
  const bare = oneOf(v, ISSUERS);
  if (bare !== null) return { issuer: bare, reasons: [] };
  const e = rec(v);
  const issuer = e === null ? null : oneOf(e["issuer"], ISSUERS);
  if (e === null || issuer === null) return null;
  const reasons = [...new Set(arr(e["reasons"]).filter((r): r is (typeof COMPARE_AVOID_REASONS)[number] => oneOf(r, COMPARE_AVOID_REASONS) !== null))].slice(0, COMPARE_AVOID_REASONS.length);
  return { issuer, reasons };
}

/** An issuer field that is null or a known issuer; anything else is unrecognisable (`undefined`). */
const issuerOrNull = (v: unknown): (typeof ISSUERS)[number] | null | undefined => (v === null ? null : oneOf(v, ISSUERS) ?? undefined);

function compareVerdict(v: unknown): Json | null {
  const x = rec(v);
  const usdt = x === null ? null : num(x["usdt"]);
  if (x === null || usdt === null) return null;
  const best = issuerOrNull(x["best"]), only = issuerOrNull(x["only"]);
  const entries = Array.isArray(x["avoid"]) ? x["avoid"].map(avoidEntry) : null;
  // Fail closed: an unreadable verdict names no winner, no empty avoid list and no "about the same".
  if (best === undefined || only === undefined || typeof x["about_same"] !== "boolean" || entries === null || entries.some((e) => e === null)) {
    return { usdt, unreadable: true, best: null, edgeBps: num(x["edgeBps"]), about_same: false, avoid: null, only: null };
  }
  return {
    usdt,
    unreadable: false,
    best,
    edgeBps: num(x["edgeBps"]),
    about_same: x["about_same"],
    avoid: entries.slice(0, ISSUERS.length),
    only,
  };
}

/** Nearest by absolute distance; the smaller size on a tie. */
function nearestSize(sizes: readonly number[], usdt: number): number | null {
  let best: number | null = null;
  for (const size of [...sizes].sort((a, b) => a - b)) if (best === null || Math.abs(size - usdt) < Math.abs(best - usdt)) best = size;
  return best;
}

/** The size to report for `usdt`: the nearest stored size that has an answered buy in some version, plus a note when that is not the whole story. */
function pickSize(stored: readonly number[], quoted: readonly number[], usdt: number): { used: number | null; note: string | null } {
  const notes: string[] = [];
  const nearestAny = nearestSize(stored, usdt);
  const used = nearestSize(quoted, usdt);
  const largest = stored.length === 0 ? null : Math.max(...stored);
  if (used === null) notes.push("No stored size has a quote.");
  else if (nearestAny !== used) notes.push(`The nearest stored size (${nearestAny} USDT) has no quote, so the nearest size with a quote is used.`);
  if (largest !== null && usdt > largest) notes.push(`The largest stored size is ${largest} USDT; the numbers do not describe a larger amount.`);
  return { used, note: notes.length === 0 ? null : notes.join(" ") };
}

/** Staleness from an age, with the plane's own limits, so `staleness` and `ageMinutes` come from the same moment. */
const stalenessAt = (ageMs: number): (typeof COMPARE_STALENESS)[number] => (ageMs <= FRESH_MS ? "fresh" : ageMs <= STALE_MS ? "stale" : "dead");

/** The underlying ticker for a ticker or a version symbol, only when the plane's own list has it. */
function resolveTicker(raw: string, known: ReadonlySet<string>): string | null {
  const up = raw.toUpperCase();
  if (known.has(up)) return up;
  if (up.endsWith("B") && known.has(up.slice(0, -1))) return up.slice(0, -1);
  if (up.endsWith("ON") && known.has(up.slice(0, -2))) return up.slice(0, -2);
  return null;
}

async function stockCompare(args: Json): Promise<ToolResult | null> {
  if (!hasOwn(args, ["ticker", "usdt"])) return null;
  const rawTicker = args["ticker"];
  if (rawTicker !== undefined && (typeof rawTicker !== "string" || !TICKER_INPUT.test(rawTicker))) return null;
  const usdt = args["usdt"];
  if (usdt !== undefined && (typeof usdt !== "number" || !Number.isFinite(usdt) || usdt < 1 || usdt > 1_000_000)) return null;

  let listBody: Json | null;
  try { listBody = rec(await dpGet("/trading/stock-compare")); } catch { return fail("data_unavailable"); }
  if (!Array.isArray(listBody?.["data"])) return fail("data_unavailable");
  const listed = arr(listBody?.["data"]).map(rec).filter((r): r is Json => r !== null && typeof r["ticker"] === "string" && PLANE_TICKER.test(r["ticker"]));
  const listMeta = rec(listBody?.["meta"]);

  if (rawTicker === undefined) {
    const newest = num(listMeta?.["newestQuotedAt"]);
    return text({
      count: Math.min(listed.length, MAX_TICKERS),
      total: listed.length,
      truncated: listed.length > MAX_TICKERS,
      staleness: newest === null ? oneOf(listMeta?.["staleness"], COMPARE_STALENESS) : stalenessAt(Date.now() - newest),
      tickers: listed.slice(0, MAX_TICKERS).map((r) => ({ ticker: r["ticker"] as string, quotedAt: num(r["quotedAt"]) })),
      note: COMPARE_NOTE,
    });
  }

  const ticker = resolveTicker(rawTicker, new Set(listed.map((r) => r["ticker"] as string)));
  if (ticker === null) return fail("not_found");
  let body: Json | null;
  try { body = rec(await dpGet(`/trading/stock-compare?ticker=${ticker}`)); } catch { return fail("data_unavailable"); }
  const row = rec(body?.["data"]);
  if (row === null || row["ticker"] !== ticker) return fail("data_unavailable");
  const meta = rec(body?.["meta"]);
  const versions = arr(row["versions"]).map(compareVersion).filter((x): x is Json => x !== null).slice(0, ISSUERS.length);
  const verdicts = arr(row["verdicts"]).map(compareVerdict).filter((x): x is Json => x !== null).sort((a, b) => (a["usdt"] as number) - (b["usdt"] as number)).slice(0, MAX_SIZES);
  const allSizes = versions.flatMap((x) => x["sizes"] as Json[]);
  const stored = [...new Set([...allSizes.map((s) => s["usdt"] as number), ...verdicts.map((x) => x["usdt"] as number)])].sort((a, b) => a - b);
  const quoted = [...new Set(allSizes.filter((s) => s["ok"] === true).map((s) => s["usdt"] as number))];
  const picked = usdt === undefined ? null : pickSize(stored, quoted, usdt);
  const quotedAt = num(row["quotedAt"]);
  const ageMs = quotedAt === null ? num(meta?.["ageMs"]) : Math.max(0, Date.now() - quotedAt);
  return text({
    ticker,
    quotedAt,
    ageMinutes: ageMs === null ? null : Math.round(ageMs / 60_000),
    staleness: quotedAt === null ? oneOf(meta?.["staleness"], COMPARE_STALENESS) : stalenessAt(ageMs as number),
    referencePriceUsd: num(row["referencePriceUsd"]),
    sizeUsedUsdt: picked === null ? null : picked.used,
    sizeNote: picked === null ? null : picked.note,
    versions,
    verdicts,
    thresholds: { aboutSameBps: num(meta?.["aboutSameBps"]), avoidCostBps: num(meta?.["avoidCostBps"]), avoidRoundTripBps: num(meta?.["avoidRoundTripBps"]), roundTripGapBps: num(meta?.["roundTripGapBps"]) },
    note: COMPARE_NOTE,
  });
}

/** `null` = arguments refused (JSON-RPC -32602). */
export async function runDataTool(name: DataToolName, args: Json, origin: string): Promise<ToolResult | null> {
  if (name === "agent_status") return agentStatus(args, origin);
  if (name === "bstock_analysis") return bstockAnalysis(args);
  if (name === "stock_compare") return stockCompare(args);
  return memeStocks(args);
}
