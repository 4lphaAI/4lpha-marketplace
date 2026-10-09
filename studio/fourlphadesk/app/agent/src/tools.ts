/**
 * Read-only tools of the 4lpha bStock Desk: thin AI SDK wrappers over 4lpha's public MCP.
 *
 * All three only read: `bstock_analysis`, `stock_compare`, `get_hire_link`. They go through the same
 * validated, rate-limited client the job pipeline uses (desk/mcp.ts), and what they return is data,
 * never instructions. Nothing here signs, pays or writes.
 *
 * The delivery pipeline (desk/index.ts) calls the client directly and runs the model WITHOUT tools: a
 * model with tools could spend the public rate limit and introduce numbers the code did not compute.
 * This set is exported for a future MCP face or an interactive helper, and stays read-only.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { bstockAnalysis, createMcpClient, getHireLink, HIRE_AGENTS, stockCompare, type McpClient, type McpResult } from "./desk/mcp.js";

function asOutput(r: McpResult): unknown {
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.code };
}

export function buildDeskTools(client: McpClient): ToolSet {
  return {
    bstock_analysis: tool({
      description: "Read-only technical and market read of a tokenized US stock (bStock) from 4lpha: price, premium, session, depth, indicators, regime.",
      inputSchema: z.object({ token: z.string().regex(/^[A-Za-z0-9]{1,12}$/), interval: z.enum(["15m", "1h"]).optional() }),
      execute: async ({ token, interval }) => asOutput(await bstockAnalysis(client, token, interval)),
    }),
    stock_compare: tool({
      description: "Read-only comparison of the bStock and Ondo versions of a US stock at stored quote sizes: cost over the share price, round trip loss, verdict.",
      inputSchema: z.object({ ticker: z.string().regex(/^[A-Za-z]{1,8}$/).optional(), usdt: z.number().min(1).max(1_000_000).optional() }),
      execute: async ({ ticker, usdt }) => asOutput(await stockCompare(client, ticker, usdt)),
    }),
    get_hire_link: tool({
      description: "Read-only hire limits and the plain Deploy link of a hosted 4lpha agent (Auto DCA, Schedule buy, Smart Portfolio).",
      inputSchema: z.object({ agent: z.enum(HIRE_AGENTS) }),
      execute: async ({ agent }) => asOutput(await getHireLink(client, agent)),
    }),
  };
}

export const LLM_READ_TOOLS: ToolSet = buildDeskTools(createMcpClient());
