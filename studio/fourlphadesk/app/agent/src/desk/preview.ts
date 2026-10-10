/**
 * Free preview: the price and "where to buy" sections of a stock report, so anyone can see what the desk
 * sells before paying. No payment, no x402 data buy, no model call, no chain write.
 *
 * It shares the public 4lpha MCP budget (10 calls per minute per client IP) with the paid jobs, so a result
 * is cached per ticker and size for PREVIEW_TTL_MS and at most PREVIEW_BUILDS_PER_MIN fresh previews are
 * built per minute (two MCP calls each); beyond that the caller is asked to retry.
 */

import { NOT_ADVICE, ts } from "./fmt.js";
import { bstockAnalysis, createMcpClient, stockCompare, validUsdt, type McpClient } from "./mcp.js";
import { readAnalysis, readCompare } from "./parse.js";
import { compareSection, priceSection, versionOf } from "./sections.js";

export const PREVIEW_TTL_MS = 120_000;
export const PREVIEW_BUILDS_PER_MIN = 2;
const TICKER = /^[A-Za-z]{1,8}$/;

export type PreviewResult =
  | { readonly status: "ok"; readonly ticker: string; readonly markdown: string; readonly full_report: Record<string, unknown> }
  | { readonly status: "invalid"; readonly error: string }
  | { readonly status: "retry"; readonly error: string };

export interface PreviewDeps {
  readonly client?: McpClient;
  readonly now?: () => number;
}

const cache = new Map<string, { at: number; result: PreviewResult }>();
let builds: number[] = [];
let sharedClient: McpClient | null = null;

/** Test seam. */
export function clearPreviewState(): void {
  cache.clear();
  builds = [];
}

function fullReportOffer(ticker: string, usdt: number | undefined): Record<string, unknown> {
  const task = usdt === undefined ? { type: "stock_report", ticker } : { type: "stock_report", ticker, usdt };
  return {
    price: "0.10 USD (U, USD1, USDC or USDT) through an ERC-8183 job on BSC mainnet",
    adds: "technical indicators on 15m and 1h, market regime, risk flags, a crypto backdrop the desk buys over x402, a written summary, IPFS delivery",
    negotiate: { skill: "negotiate", task_description: JSON.stringify(task), terms: { deliverables: "Markdown desk report pinned to IPFS", quality_standards: "numbers computed by code" } },
  };
}

export async function previewStock(data: Record<string, unknown>, deps: PreviewDeps = {}): Promise<PreviewResult> {
  const now = deps.now ?? Date.now;
  const tickerRaw = data.ticker;
  if (typeof tickerRaw !== "string" || !TICKER.test(tickerRaw)) {
    return { status: "invalid", error: 'send {"skill":"preview","ticker":"NVDA"} with a 1 to 8 letter ticker, optionally "usdt": 500' };
  }
  const ticker = tickerRaw.toUpperCase();
  const usdt = data.usdt === undefined ? undefined : data.usdt;
  if (usdt !== undefined && !validUsdt(usdt)) return { status: "invalid", error: "usdt must be a number from 1 to 1000000" };

  const key = `${ticker}:${usdt ?? ""}`;
  const hit = cache.get(key);
  if (hit !== undefined && now() - hit.at < PREVIEW_TTL_MS) return hit.result;

  builds = builds.filter((t) => now() - t < 60_000);
  if (builds.length >= PREVIEW_BUILDS_PER_MIN) return { status: "retry", error: "free previews are busy; retry in a minute or buy the full report" };
  builds.push(now());

  const client = deps.client ?? (sharedClient ??= createMcpClient());
  const cmpRes = await stockCompare(client, ticker, usdt as number | undefined);
  const cmp = cmpRes.ok ? readCompare(cmpRes.data) : null;
  const symbol = versionOf(cmp, "bstock")?.symbol ?? ticker;
  const anaRes = await bstockAnalysis(client, symbol);
  const ana = anaRes.ok ? readAnalysis(anaRes.data) : null;

  const lines = [
    `# 4lpha bStock Desk: free preview, ${ticker}`,
    `Generated ${ts(now())}. Price and where-to-buy only; the paid report has the rest.`,
    "",
    ...priceSection(ana, ana === null ? (anaRes.ok ? "bad_response" : anaRes.code) : null),
    "",
    ...compareSection(cmp, cmp === null ? (cmpRes.ok ? "bad_response" : cmpRes.code) : null),
    "",
    "## The full report (0.10 USD, ERC-8183 job)",
    "Adds technical indicators on 15m and 1h, the market regime, risk flags, a crypto backdrop the desk pays for over x402, and a written summary; delivered on IPFS and anchored on chain. Send the `negotiate` envelope in `full_report.negotiate`.",
    "",
    "---",
    NOT_ADVICE,
  ];
  const result: PreviewResult = { status: "ok", ticker, markdown: lines.join("\n"), full_report: fullReportOffer(ticker, usdt as number | undefined) };
  cache.set(key, { at: now(), result });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return result;
}
