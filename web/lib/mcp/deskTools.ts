/**
 * MCP tools that reach the 4lpha bStock Desk, the BNB Agent Studio seller agent at desk.4lpha.tech, so an AI
 * assistant connected to 4lpha.tech/mcp can use it without an A2A client:
 *   desk_preview - the desk's free `preview` skill (price, premium and where-to-buy for one stock);
 *   desk_quote   - the desk's `negotiate` skill: a wallet-signed 0.10 USD quote for the full report, plus the
 *                  steps to buy it with a BNB Agent Studio wallet.
 * Both are free and read-only on this side: this server never pays, never signs and never holds a key. The
 * call goes to one fixed URL; the reply is size-capped and only known fields are passed on. Previews are cached
 * per ticker and size so assistants share the desk's small preview budget.
 */
import { cachedFlight } from "./ttlCache";

type Json = Record<string, unknown>;
export type DeskToolResult = { content: [{ type: "text"; text: string }]; isError?: true };

export const DESK_TOOL_NAMES = ["desk_preview", "desk_quote"] as const;
export type DeskToolName = (typeof DESK_TOOL_NAMES)[number];

const DESK_URL = "https://desk.4lpha.tech/";
const DESK_WALLET = "0x592EF127feFd45eAA56fE0D715dAAF72F998A652";
const U_TOKEN = "0xcE24439F2D9C6a2289F741120FE202248B666666";
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_MARKDOWN = 12_000;
const PREVIEW_TTL_MS = 120_000;
const TICKER = /^[A-Za-z]{1,8}$/u;

export const DESK_TOOLS = [
  {
    name: "desk_preview",
    description:
      "Free preview from the 4lpha bStock Desk (a BNB Agent Studio agent, ERC-8004 #369195): price, premium to NAV, US session, pool depth and the bStock vs Ondo where-to-buy table for one US stock, as Markdown. The full paid report (indicators, regime, risks, crypto data the desk buys over x402) is available with desk_quote. Data, not investment advice.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", pattern: "^[A-Za-z]{1,8}$", description: "The stock (NVDA) or its bStock symbol (NVDAB), case-insensitive." },
        usdt: { type: "number", minimum: 1, maximum: 1000000, description: "Order size in USDT for the where-to-buy verdict (optional)." },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  {
    name: "desk_quote",
    description:
      "A wallet-signed price quote (0.10 USD, paid in U through an ERC-8183 job on BSC mainnet) for the full 4lpha bStock Desk stock report, plus the steps to buy it with a BNB Agent Studio wallet (bag CLI). Getting the quote is free and moves no money; buying needs your own wallet. The quote expires after about 15 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", pattern: "^[A-Za-z]{1,8}$", description: "The stock (NVDA) or its bStock symbol (NVDAB), case-insensitive." },
        usdt: { type: "number", minimum: 1, maximum: 1000000, description: "Order size in USDT the report should size the where-to-buy section for (optional)." },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
] as const;

const text = (value: unknown, isError = false): DeskToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true as const } : {}) });
const fail = (code: string, detail?: string): DeskToolResult => text({ error: { code, ...(detail ? { detail } : {}) } }, true);
const rec = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** Validated arguments, or null (JSON-RPC -32602). */
function readArgs(args: Json): { ticker: string; usdt: number | undefined } | null {
  if (!Object.keys(args).every((k) => k === "ticker" || k === "usdt")) return null;
  const t = args["ticker"];
  if (typeof t !== "string" || !TICKER.test(t)) return null;
  const u = args["usdt"];
  if (u !== undefined && (typeof u !== "number" || !Number.isFinite(u) || u < 1 || u > 1_000_000)) return null;
  return { ticker: t.toUpperCase(), usdt: u as number | undefined };
}

/** One A2A `message/send` with a data part; returns the reply's data part, or a closed error code. */
async function a2a(data: Json): Promise<Json | string> {
  const body = {
    jsonrpc: "2.0",
    id: "mcp",
    method: "message/send",
    params: { message: { kind: "message", messageId: `mcp-${Date.now()}`, role: "user", parts: [{ kind: "data", data }] } },
  };
  let res: Response;
  try {
    res = await fetch(DESK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), cache: "no-store" });
  } catch {
    return "desk_unavailable";
  }
  if (!res.ok) return "desk_unavailable";
  const raw = await res.text().catch(() => "");
  if (raw.length === 0 || raw.length > MAX_REPLY_BYTES) return "desk_unavailable";
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return "desk_unavailable";
  }
  const parts = rec(rec(json)?.["result"])?.["parts"];
  const part = Array.isArray(parts) ? parts.map(rec).find((p) => p?.["kind"] === "data") : undefined;
  return rec(part?.["data"]) ?? "desk_unavailable";
}

async function deskPreview(args: Json): Promise<DeskToolResult | null> {
  const a = readArgs(args);
  if (a === null) return null;
  const key = `desk-preview:${a.ticker}:${a.usdt ?? ""}`;
  const got = await cachedFlight(key, PREVIEW_TTL_MS, () => a2a({ skill: "preview", ticker: a.ticker, ...(a.usdt === undefined ? {} : { usdt: a.usdt }) }));
  if (typeof got === "string") return fail(got);
  if (got["status"] === "retry") return fail("desk_busy", "The desk builds at most a few free previews a minute; retry shortly.");
  if (got["status"] !== "ok" || typeof got["markdown"] !== "string") return fail("desk_unavailable");
  return text({
    agent: { name: "4lpha bStock Desk", erc8004: 369195, card: `${DESK_URL}.well-known/agent-card.json` },
    ticker: a.ticker,
    markdown: (got["markdown"] as string).slice(0, MAX_MARKDOWN),
    fullReport: "0.10 USD through an ERC-8183 job; call desk_quote for a signed quote and the buying steps.",
  });
}

async function deskQuote(args: Json): Promise<DeskToolResult | null> {
  const a = readArgs(args);
  if (a === null) return null;
  const task = JSON.stringify(a.usdt === undefined ? { type: "stock_report", ticker: a.ticker } : { type: "stock_report", ticker: a.ticker, usdt: a.usdt });
  const got = await a2a({
    skill: "negotiate",
    task_description: task,
    terms: { deliverables: "Markdown desk report pinned to IPFS", quality_standards: "numbers computed by code, data times included", currency: U_TOKEN },
  });
  if (typeof got === "string") return fail(got);
  if (got["status"] === "retry") return fail("desk_busy", "The desk is rate limiting this caller; retry in a minute.");
  const response = rec(got["response"]);
  const terms = rec(response?.["terms"]);
  if (typeof got["negotiation_hash"] !== "string" || typeof got["provider_sig"] !== "string" || terms === null) return fail("desk_unavailable");
  const price = typeof terms["price"] === "string" && /^\d+$/u.test(terms["price"]) ? Number(BigInt(terms["price"])) / 1e18 : null;
  const expires = typeof response?.["quote_expires_at"] === "number" ? new Date((response["quote_expires_at"] as number) * 1000).toISOString() : null;
  return text({
    agent: { name: "4lpha bStock Desk", erc8004: 369195, wallet: DESK_WALLET },
    task,
    priceU: price,
    expiresAt: expires,
    quote: got,
    howToBuy: [
      "Save `quote` (the whole object) as quote.json inside a BNB Agent Studio project folder whose wallet holds about 0.10 U and a little BNB.",
      `bag erc8183 buy --network bsc-mainnet --provider ${DESK_WALLET} --quote-json quote.json --budget-usd 0.10 --deadline-min 60`,
      `Send the desk {"skill":"notify_funded","job_id":<job_id>} over A2A at ${DESK_URL}; it delivers to IPFS and submits on chain, usually within a minute.`,
      "Or run all steps at once from the 4lpha repo: node studio/fourlphadesk/buyer/buy-report.mjs <TICKER> <USDT>.",
    ],
  });
}

/** `null` = arguments refused (JSON-RPC -32602). */
export async function runDeskTool(name: DeskToolName, args: Json): Promise<DeskToolResult | null> {
  return name === "desk_preview" ? deskPreview(args) : deskQuote(args);
}
