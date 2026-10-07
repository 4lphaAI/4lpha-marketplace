/**
 * The three data tools of the public MCP: `agent_status`, `bstock_analysis`, `meme_stocks`.
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
import { DpError, dpGet } from "./dpRead";
import { sanitizeAgentName, sanitizeSymbol } from "./sanitize";

type Json = Record<string, unknown>;
export type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };

export const DATA_TOOL_NAMES = ["agent_status", "bstock_analysis", "meme_stocks"] as const;
export type DataToolName = (typeof DATA_TOOL_NAMES)[number];

type Env = Readonly<Record<string, string | undefined>>;
export const dataToolsEnabled = (env: Env = process.env): boolean => env["MCP_DATA_TOOLS_ENABLED"] === "true";
export const agentStatusEnabled = (env: Env = process.env): boolean => dataToolsEnabled(env) && env["NEXT_PUBLIC_AGENTIC_WALLET_ENABLED"] === "true";
export const isDataToolListed = (name: string, env: Env = process.env): boolean =>
  name === "agent_status" ? agentStatusEnabled(env) : name === "bstock_analysis" || name === "meme_stocks" ? dataToolsEnabled(env) : false;

export const DATA_TOOLS = [
  {
    name: "agent_status",
    description:
      "Public status summary of the 4lpha Binance Agentic Wallet agent running on a wallet: mode, status, hold code, term, positions and short per-mode blocks, plus the link to the full public page. A wallet with no hire answers agent: null.",
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
    exitUsdtWei: weiString(p["exitUsdtWei"]),
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
  const earn = rec(agent["earn"]);
  const identity = rec(agent["erc8004Identity"]);
  return {
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
    settings: pick(settings, ["executionModel", "capitalQuoteWei", "entryWei", "maxOpenPositions", "slippageBps", "stopLossBps", "takeProfitBps", "maxHoldSec"]),
    summary: pick(agent["summary"], ["openPositions", "maxOpenPositions", "closedTrades", "wins", "winRateBps", "grossDeltaWei", "grossComplete"]),
    positions: arr(agent["positions"]).slice(0, 10).map(positionSummary).filter((p): p is Json => p !== null),
    positionCount: arr(agent["positions"]).length,
    schedule: agent["schedule"] === undefined ? undefined : pick(agent["schedule"], ["symbol", "amountWei", "intervalSec", "nextDueAtMs", "plannedBuys", "buysThisSession", "spentWei", "remainingWei", "finished", "endKind", "premiumBps", "maxPremiumBps"]),
    portfolio: agent["portfolio"] === undefined ? undefined : pick(agent["portfolio"], ["capitalQuoteWei", "netInvestedWei", "stockValueWei", "totalValueWei", "pnlWei", "driftBps", "intervalSec", "nextCheckAtMs"]),
    dca: agent["dca"] === undefined ? undefined : pick(agent["dca"], ["symbol", "heldOrders", "reason"]),
    earn: agent["earn"] === undefined ? undefined : pick(earn, ["totalWei", "liquidWei", "earnedWei", "withdrawingBeforeSignOut"]),
    erc8004: identity === null ? null : { status: str(identity["status"]), agentId: typeof identity["agentId"] === "string" && /^[0-9]{1,78}$/u.test(identity["agentId"]) ? identity["agentId"] : null },
    pageUrl: `${origin}/agentic/${wallet}`,
    note: "Summary of the public view. Events, run logs, model reasons and the data-spend log are on the page.",
  };
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

/** `null` = arguments refused (JSON-RPC -32602). */
export async function runDataTool(name: DataToolName, args: Json, origin: string): Promise<ToolResult | null> {
  if (name === "agent_status") return agentStatus(args, origin);
  if (name === "bstock_analysis") return bstockAnalysis(args);
  return memeStocks(args);
}
