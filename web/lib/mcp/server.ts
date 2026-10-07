/**
 * The 4lpha MCP face: the ONE callable surface an external agent or LLM client
 * reaches us on.
 *
 * WHY this exists at all: an ERC-8004 registration whose `services[]` names no
 * protocol adapter is classified `listed_only` -> `discoverable` by every
 * marketplace that reads the registry, i.e. a dormant wallet entry. A live MCP
 * endpoint named in `services[]` is what makes the identity callable.
 *
 * WHY it is read-only: hiring a 4lpha agent means granting an on-chain Altana
 * session (or pairing a Binance Agentic Wallet), and that requires the human
 * owner in their own browser or Binance App. No caller reaching this file can
 * produce that, and we do not want one to. So the contract here is: describe
 * the products, hand back a deep link and the numbers, and let the human do it.
 *
 * Three static tools need no I/O. Three data tools (`dataTools.ts`) are listed
 * only with MCP_DATA_TOOLS_ENABLED=true: they read the data plane through one
 * allowlisted GET helper (`dpRead.ts`) and the public Agentic wallet view through
 * the read the agentic BFF also uses, all cached. Nothing here writes, signs,
 * holds a key or forwards a caller-supplied path. The rate limit is applied by
 * the route (`rateLimit.ts`), before any message is handled.
 *
 * Every tool declared by `listTools` is implemented below. A tool we cannot
 * honour is a false public claim, so the list and the dispatcher must not drift.
 */

import { AGENTIC_NOTE, AGENTIC_PRODUCTS, AGENTIC_PRODUCT_IDS, hireGuide, isAgenticAvailable, type AgenticProductId } from "./agenticProducts";
import { DATA_TOOLS, DATA_TOOL_NAMES, isDataToolListed, runDataTool, type DataToolName } from "./dataTools";
import { STRATEGIES } from "./strategies";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "4lpha-marketplace", version: "1.0.0" } as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Altana products, not runtime flags. `coming-soon` is a scope statement we control. */
const AGENTS = [
  {
    id: "grid",
    name: "Grid Agent",
    category: "Grid Trading",
    status: "available",
    custody: "altana",
    path: "/deploy/grid",
    description:
      "Automated grid market making that buys low and sells high as market prices move, using PancakeSwap V3 on BNB Chain.",
  },
  {
    id: "lp",
    name: "LP Agent",
    category: "Rebalancing",
    status: "available",
    custody: "altana",
    path: "/deploy/lp",
    description:
      "Routes liquidity to the best APR or fee opportunities with auto-rebalancing, compounding, and risk exits, using PancakeSwap V3 on BNB Chain.",
  },
  {
    id: "trade",
    name: "Trading Agent",
    category: "Yield Optimisation",
    status: "available",
    custody: "altana",
    path: "/deploy/trading",
    description:
      "Screens eligible markets, sizes entries, and automatically manages buys and exits using Four.Meme, Flap.sh, and PancakeSwap V3 on BNB Chain.",
  },
  {
    id: "health",
    name: "Lending Agent",
    category: "Health Factor Monitoring",
    status: "coming-soon",
    custody: "altana",
    path: "/deploy/health",
    description:
      "Monitors a Venus lending position and repays before liquidation. Built but not yet released to hire.",
  },
] as const;

export type AgentId = (typeof AGENTS)[number]["id"];

const HIRE_NOTE =
  "Hiring is a human action: it grants an on-chain Altana session (per-token spend caps, call allowlist, expiry) and that grant must be signed by the owner's passkey in their own browser. This MCP surface cannot hire, sign, move funds, or read a private agent; it returns the link the human opens.";

/** The static tools: always listed, no I/O. */
export const TOOLS = [
  {
    name: "explain_strategy",
    description: "Explain how a 4lpha Grid, LP or Trading strategy works, its main settings, risks and custody boundary. Static product guidance, not live analysis or a private agent report.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string", enum: ["grid", "lp", "trade"], description: "Product id from list_agents." } },
      required: ["agent"],
      additionalProperties: false,
    },
  },
  {
    name: "list_agents",
    description:
      "List the 4lpha autonomous DeFi agents available to hire on BNB Chain (Altana passkey wallets and Binance Agentic Wallet products), with their agent-marketplace category, custody and deploy link.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_hire_link",
    description:
      "Return the deploy link a human opens to hire one 4lpha agent, plus what the hire authorises. For the Agentic Wallet products (agentic-*) it also returns the Deploy steps, the numbers the form and the Binance checks require, and the stop and Earn rules.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string", enum: [...AGENTS.map((agent) => agent.id), ...AGENTIC_PRODUCT_IDS], description: "Agent id from list_agents." } },
      required: ["agent"],
      additionalProperties: false,
    },
  },
] as const;

/** What `tools/list` and the GET descriptor show right now: the static tools plus the data tools whose flags are on. */
export function listTools(env: Env = process.env) {
  return [...TOOLS, ...DATA_TOOLS.filter((tool) => isDataToolListed(tool.name, env))];
}

type Json = Record<string, unknown>;
export type McpReply = { readonly status: number; readonly body: Json | null };

const ok = (id: unknown, result: Json): McpReply => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
const err = (id: unknown, code: number, message: string): McpReply => ({ status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } });

function catalog(origin: string, env: Env) {
  return [
    ...AGENTS.map((agent) => ({ ...agent, deployUrl: `${origin}${agent.path}` })),
    ...AGENTIC_PRODUCTS.map((product) => ({
      id: product.id,
      name: product.name,
      category: "Tokenized Stocks",
      status: isAgenticAvailable(product, env) ? "available" : "unavailable",
      custody: "binance-agentic",
      path: "/deploy/trading",
      description: product.whatItDoes,
      deployUrl: `${origin}/deploy/trading`,
    })),
  ];
}

function text(value: unknown): Json {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const isDataTool = (name: unknown): name is DataToolName => typeof name === "string" && (DATA_TOOL_NAMES as readonly string[]).includes(name);

/** null = the caller named a tool we do not implement (or that is switched off), or arguments we refuse. */
async function callTool(name: unknown, args: Json, origin: string, env: Env): Promise<Json | null> {
  if (name === "explain_strategy") {
    if (Object.keys(args).length !== 1 || (args.agent !== "grid" && args.agent !== "lp" && args.agent !== "trade")) return null;
    return text({
      agent: args.agent,
      scope: "Static product explanation. Does not inspect a user's configuration, positions or performance.",
      ...STRATEGIES[args.agent],
      custody: "Browser users create and fund a separate passkey-controlled wallet. The owner authorises an Altana session with on-chain spend caps, call allowlist and expiry. The platform-managed ERC-8004 identity does not grant access to trading funds.",
      controls: "Pause stops submissions by the 4lpha server. On-chain session limits and an owner-authorised revocation provide the on-chain restrictions.",
      nextStep: HIRE_NOTE,
    });
  }
  if (name === "list_agents") return text({ agents: catalog(origin, env), note: `${HIRE_NOTE} ${AGENTIC_NOTE}` });
  if (name === "get_hire_link") {
    if (Object.keys(args).length !== 1) return null;
    const product = AGENTIC_PRODUCTS.find((entry) => entry.id === (args.agent as AgenticProductId));
    if (product !== undefined) return text(hireGuide(product, `${origin}/deploy/trading`, env));
    const agent = catalog(origin, env).find((entry) => entry.id === args.agent && entry.custody === "altana");
    return agent ? text({ agent: agent.id, name: agent.name, status: agent.status, deployUrl: agent.deployUrl, authorises: HIRE_NOTE }) : null;
  }
  if (isDataTool(name) && isDataToolListed(name, env)) return (await runDataTool(name, args, origin)) as Json | null;
  return null;
}

/**
 * One JSON-RPC message in, one reply out. `body: null` means "accepted, no
 * response": the MCP notification case, which must NOT carry a JSON-RPC body.
 *
 * `origin` comes from the request (the public origin the browser sees, see
 * `lib/exec/public-origin.ts`) rather than a constant so the same code serves
 * the Railway domain today and a custom domain later without an edit.
 */
export async function handleMcpMessage(message: unknown, origin: string, env: Env = process.env): Promise<McpReply> {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return err(null, -32600, "Invalid Request");
  const { id = null, method, params } = message as Json;
  const args: Json = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Json) : {};

  if (typeof method !== "string") return err(id, -32600, "Invalid Request");
  if (method.startsWith("notifications/")) return { status: 202, body: null };

  if (method === "initialize") {
    const requested = args.protocolVersion;
    return ok(id, {
      protocolVersion: typeof requested === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: listTools(env) });
  if (method === "tools/call") {
    const called = await callTool(args.name, args.arguments !== null && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? (args.arguments as Json) : {}, origin, env);
    return called ? ok(id, called) : err(id, -32602, "Unknown tool or invalid arguments");
  }
  return err(id, -32601, `Method not found: ${method}`);
}
