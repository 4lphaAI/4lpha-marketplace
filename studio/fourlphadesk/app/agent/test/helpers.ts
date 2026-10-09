/**
 * Test helpers: fixtures saved once from the live 4lpha MCP on 2026-10-08 (bstock-NVDAB, compare-NVDA-500,
 * hire-agentic-*), a fake MCP client and mutators that derive SYNTHETIC variants (other stocks, stale
 * data, errors). Synthetic variants are always built from the real shapes here, never invented shapes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BuyFn } from "../src/desk/backdrop.js";
import type { DeskDeps } from "../src/desk/handlers.js";
import type { McpClient, McpResult } from "../src/desk/mcp.js";
import type { Llm } from "../src/desk/prose.js";

export type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function fixture(name: string): J {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8")) as J;
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function editedHire(agent: string, from: string, to: string): J {
  const d = clone(fixture(`hire-${agent}`));
  const s = JSON.stringify(d);
  if (!s.includes(from)) throw new Error(`fixture lacks ${from}`);
  return JSON.parse(s.replace(from, to)) as J;
}

export const NOW = Date.parse("2026-10-08T12:00:00Z");

/** The live compare answer re-labelled for another stock (SYNTHETIC: same shape, edited values). */
export function compareFor(ticker: string, edit?: (c: J) => void): J {
  const c = clone(fixture("compare-NVDA-500"));
  c.ticker = ticker;
  c.versions[0].symbol = `${ticker}B`;
  c.versions[1].symbol = `${ticker}on`;
  if (edit) edit(c);
  return c;
}

export function analysisFor(symbol: string, edit?: (a: J) => void): J {
  const a = clone(fixture("bstock-NVDAB"));
  a.token.symbol = symbol;
  a.token.underlyingTicker = symbol.replace(/B$/, "");
  if (edit) edit(a);
  return a;
}

export interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export type Responder = (name: string, args: Record<string, unknown>) => McpResult;

export function fakeClient(respond: Responder): McpClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      return respond(name, args);
    },
  };
}

export const ok = (data: unknown): McpResult => ({ ok: true, data, fetchedAt: NOW });
export const err = (code: string): McpResult => ({ ok: false, code });

/** Responder that serves the live fixtures: NVDA everywhere, other tickers as synthetic copies. */
export function liveResponder(over: Partial<Record<string, (args: Record<string, unknown>) => McpResult>> = {}): Responder {
  return (name, args) => {
    const o = over[name];
    if (o) return o(args);
    if (name === "stock_compare") {
      const t = String(args.ticker ?? "NVDA").toUpperCase().replace(/B$/, "");
      return ok(t === "NVDA" ? fixture("compare-NVDA-500") : compareFor(t));
    }
    if (name === "bstock_analysis") return ok(analysisFor(String(args.token).toUpperCase()));
    if (name === "get_hire_link") return ok(fixture(`hire-${String(args.agent)}`));
    return err("invalid_arguments");
  };
}

export const paidOk = (json: unknown = btcBnbJson()): Record<string, unknown> => ({
  ok: true,
  status: 200,
  json,
  paid_usd: 0.01,
  settlement_tx: `0x${"ab".repeat(32)}`,
});

/** A CoinMarketCap-shaped answer for BTC and BNB (SYNTHETIC: shape per the public v3 docs, values made up). */
export function btcBnbJson(): unknown {
  return {
    data: [
      { id: 1, symbol: "BTC", quote: [{ symbol: "USD", price: 65000.5, percent_change_24h: -1.25 }] },
      { id: 1839, symbol: "BNB", quote: { USD: { price: 612.4, percent_change_24h: 0.8 } } },
    ],
    status: { error_code: 0 },
  };
}

export interface Rig {
  deps: DeskDeps;
  client: McpClient & { calls: Call[] };
  buyCalls: { url: string; maxUsd: number }[];
  llmCalls: { system: string; prompt: string }[];
}

export function rig(opts: { respond?: Responder; buy?: BuyFn | null; llm?: Llm | null; jobKey?: string } = {}): Rig {
  const client = fakeClient(opts.respond ?? liveResponder());
  const buyCalls: { url: string; maxUsd: number }[] = [];
  const llmCalls: { system: string; prompt: string }[] = [];
  const buy: BuyFn | null =
    opts.buy === undefined
      ? async (url, maxUsd) => {
          buyCalls.push({ url, maxUsd });
          return paidOk();
        }
      : opts.buy === null
        ? null
        : async (url, maxUsd, m) => {
            buyCalls.push({ url, maxUsd });
            return (opts.buy as BuyFn)(url, maxUsd, m);
          };
  const llm: Llm | null =
    opts.llm === undefined
      ? null
      : opts.llm === null
        ? null
        : async (a) => {
            llmCalls.push({ system: a.system, prompt: a.prompt });
            return (opts.llm as Llm)(a);
          };
  return {
    client,
    buyCalls,
    llmCalls,
    deps: { client, buy, llm, now: () => NOW, jobKey: opts.jobKey ?? `job-${Math.random()}` },
  };
}
