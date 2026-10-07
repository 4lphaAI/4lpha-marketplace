import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { PROTOCOL_VERSION, SERVER_INFO, TOOLS } from "@/lib/mcp/server";
import { DATA_TOOLS } from "@/lib/mcp/dataTools";
import { AGENTIC_PRODUCT_IDS } from "@/lib/mcp/agenticProducts";
import { ORIGIN, WALLET, callBody, installDataPlane, installExecPlane, mcpRequest, resetAll } from "./fixtures";

const post = async (body: unknown, ip?: string | null) => POST(ip === undefined ? mcpRequest(body) : mcpRequest(body, ip));
const call = (name: string, args: Record<string, unknown> = {}) => post(callBody(name, args));
const dataOn = () => { vi.stubEnv("MCP_DATA_TOOLS_ENABLED", "true"); vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", "true"); };

beforeEach(() => { resetAll(); vi.stubEnv("MCP_DATA_TOOLS_ENABLED", ""); vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("initialize echoes a supported protocol version and identifies the server", async () => {
  const body = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })).json();
  expect(body.result.protocolVersion).toBe("2024-11-05");
  expect(body.result.serverInfo).toEqual(SERVER_INFO);
  expect(body.result.capabilities.tools).toBeDefined();
  const garbage = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "whenever" } })).json();
  expect(garbage.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

/** Sample arguments that satisfy each tool's required schema fields. */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  explain_strategy: { agent: "lp" }, get_hire_link: { agent: "lp" }, list_agents: {},
  agent_status: { wallet: WALLET }, bstock_analysis: { token: "NVDAB" }, meme_stocks: {},
};

/**
 * The drift guard. A tool we advertise but cannot run is a false public claim
 * on an endpoint written into an on-chain registration, so every declared name
 * must answer (not error) with its schema's required arguments supplied, with
 * the data tools both off and on.
 */
it("implements every tool it advertises, flag off and flag on", async () => {
  const off = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  expect(off.result.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
  dataOn();
  installDataPlane();
  installExecPlane(); // replaces fetch: agent_status reads the execution plane
  const on = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const names: string[] = on.result.tools.map((tool: { name: string }) => tool.name);
  expect(names).toEqual([...TOOLS, ...DATA_TOOLS].map((tool) => tool.name));
  for (const tool of on.result.tools as { name: string; inputSchema: { required?: string[] } }[]) {
    const args = SAMPLE_ARGS[tool.name]!;
    for (const required of tool.inputSchema.required ?? []) expect(Object.keys(args), `${tool.name} sample must supply ${required}`).toContain(required);
    if (tool.name === "bstock_analysis" || tool.name === "meme_stocks") installDataPlane();
    else if (tool.name === "agent_status") installExecPlane();
    const body = await (await call(tool.name, args)).json();
    expect(body.error, `${tool.name} must be implemented`).toBeUndefined();
    expect(body.result.content[0].type).toBe("text");
  }
});

it("hides the data tools everywhere when the flag is off, and answers -32602 like an unknown tool", async () => {
  const listed = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["explain_strategy", "list_agents", "get_hire_link"]);
  const descriptor = await (await GET(new NextRequest(`${ORIGIN}/mcp`))).json();
  expect(descriptor.tools.map((tool: { name: string }) => tool.name)).toEqual(["explain_strategy", "list_agents", "get_hire_link"]);
  const { fetcher } = installDataPlane();
  for (const name of ["agent_status", "bstock_analysis", "meme_stocks"]) {
    const body = await (await call(name, SAMPLE_ARGS[name])).json();
    expect(body.error.code, name).toBe(-32602);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("lists agent_status only when the Agentic Wallet flag is also on", async () => {
  vi.stubEnv("MCP_DATA_TOOLS_ENABLED", "true");
  const noWallet = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  expect(noWallet.result.tools.map((tool: { name: string }) => tool.name)).toEqual([...TOOLS.map((t) => t.name), "bstock_analysis", "meme_stocks"]);
  expect((await (await call("agent_status", { wallet: WALLET })).json()).error.code).toBe(-32602);
  vi.stubEnv("MCP_DATA_TOOLS_ENABLED", "yes");
  vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", "true");
  const wrongValue = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  expect(wrongValue.result.tools).toHaveLength(TOOLS.length);
});

it("GET lists the data tools too when they are on", async () => {
  dataOn();
  const body = await (await GET(new NextRequest(`${ORIGIN}/mcp`))).json();
  expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([...TOOLS, ...DATA_TOOLS].map((tool) => tool.name));
});

it.each(["grid", "lp", "trade"])("explains %s without accessing live services", async (agent) => {
  const { fetcher } = installDataPlane();
  const result = JSON.parse((await (await call("explain_strategy", { agent })).json()).result.content[0].text);
  expect(result.agent).toBe(agent);
  expect(result.howItWorks.length).toBeGreaterThan(0);
  expect(result.risks.length).toBeGreaterThan(0);
  expect(result.scope).toMatch(/Static/);
  expect(result.custody).toMatch(/separate passkey-controlled wallet/);
  expect(result.controls).toMatch(/Pause stops submissions by the 4lpha server/);
  expect(JSON.stringify(result)).not.toMatch(/exec-token|sessionKey|privateKey|ownerAddress/);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([{}, { agent: "health" }, { agent: "__proto__" }, { agent: "lp", instanceId: "private" }])("rejects unsupported explanation arguments %j", async (args) => {
  expect((await (await call("explain_strategy", args)).json()).error.code).toBe(-32602);
});

it("lists the four Altana categories untouched and adds the four Agentic products", async () => {
  vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_AGENTIC_DCA_ENABLED", "true");
  const body = await (await call("list_agents")).json();
  const { agents } = JSON.parse(body.result.content[0].text) as { agents: { id: string; category: string; custody: string; status: string; deployUrl: string }[] };
  const altana = agents.filter((agent) => agent.custody === "altana");
  expect(altana.map((agent) => agent.category).sort()).toEqual(["Grid Trading", "Health Factor Monitoring", "Rebalancing", "Yield Optimisation"]);
  expect(altana.find((agent) => agent.id === "health")!.status).toBe("coming-soon");
  const agentic = agents.filter((agent) => agent.custody === "binance-agentic");
  expect(agentic.map((agent) => agent.id)).toEqual([...AGENTIC_PRODUCT_IDS]);
  expect(agentic.every((agent) => agent.status === "available" && agent.deployUrl === `${ORIGIN}/deploy/trading`)).toBe(true);
});

it("does not call an Agentic product available while its Deploy flag is off", async () => {
  vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", "true");
  const { agents } = JSON.parse((await (await call("list_agents")).json()).result.content[0].text) as { agents: { id: string; status: string }[] };
  expect(agents.find((agent) => agent.id === "agentic-dca")!.status).toBe("unavailable");
  expect(agents.find((agent) => agent.id === "agentic-schedule")!.status).toBe("available");
});

it("links the Trading agent to /deploy/trading, not the Grid fallback /deploy/trade", async () => {
  const { agents } = JSON.parse((await (await call("list_agents")).json()).result.content[0].text) as { agents: { id: string; deployUrl: string }[] };
  expect(agents.find((agent) => agent.id === "trade")!.deployUrl).toBe(`${ORIGIN}/deploy/trading`);
  const link = JSON.parse((await (await call("get_hire_link", { agent: "trade" })).json()).result.content[0].text);
  expect(link.deployUrl).toBe(`${ORIGIN}/deploy/trading`);
  expect(JSON.stringify(agents)).not.toContain("/deploy/trade\"");
});

it("uses the public origin behind the Railway edge, not the internal one, for links and the GET descriptor", async () => {
  const edge = { "x-forwarded-proto": "https", "x-forwarded-host": "4lpha.tech" };
  const response = await POST(new NextRequest("http://0.0.0.0:3000/mcp", { method: "POST", body: JSON.stringify(callBody("get_hire_link", { agent: "grid" })), headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", ...edge } }));
  expect(JSON.parse((await response.json()).result.content[0].text).deployUrl).toBe("https://4lpha.tech/deploy/grid");
  const list = await POST(new NextRequest("http://0.0.0.0:3000/mcp", { method: "POST", body: JSON.stringify(callBody("list_agents")), headers: { "content-type": "application/json", "x-real-ip": "203.0.113.10", ...edge } }));
  expect(JSON.stringify(await list.json())).not.toContain("0.0.0.0");
  const descriptor = await (await GET(new NextRequest("http://0.0.0.0:3000/mcp", { headers: edge }))).json();
  expect(descriptor.endpoint).toBe("https://4lpha.tech/mcp");
});

it("says a hire needs the owner's own passkey signature, and never offers to do it", async () => {
  const body = await (await call("get_hire_link", { agent: "grid" })).json();
  const result = JSON.parse(body.result.content[0].text);
  expect(result.deployUrl).toBe(`${ORIGIN}/deploy/grid`);
  expect(result.authorises).toMatch(/passkey/i);
  expect(JSON.stringify(result)).not.toMatch(/exec-token|sessionKey|privateKey|ownerAddress/);
});

it.each(AGENTIC_PRODUCT_IDS)("get_hire_link %s returns the plain link, the steps, the numbers and the stop rule", async (agent) => {
  vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_AGENTIC_DCA_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_AGENTIC_EARN_ENABLED", "true");
  const result = JSON.parse((await (await call("get_hire_link", { agent })).json()).result.content[0].text);
  expect(result.agent).toBe(agent);
  expect(result.status).toBe("available");
  expect(result.custody).toBe("binance-agentic");
  expect(result.deployUrl).toBe(`${ORIGIN}/deploy/trading`);
  expect(result.deployUrl).not.toContain("?");
  expect(result.steps.join(" ")).toMatch(/Agentic Wallet/);
  expect(result.steps.join(" ")).toMatch(/QR/);
  expect(result.requirements.termDays).toEqual([7, 30]);
  expect(result.requirements.binanceApp.join(" ")).toMatch(/Trade all tokens/);
  expect(result.requirements.settings.length).toBeGreaterThan(2);
  expect(result.rules.join(" ")).toMatch(/sign 4lpha out in the Binance App/);
  expect(result.rules.join(" ")).toMatch(/Holdings stay in your wallet/);
  expect(result.authorises).toMatch(/cannot hire, sign/);
  if (agent === "agentic-portfolio") expect(result.earn).toBeNull();
  else expect(result.earn.conditions.join(" ")).toMatch(/60 %.*20 USDT/);
  expect(JSON.stringify(result)).not.toMatch(/exec-token|sessionKey|privateKey/);
});

it.each([["unknown_tool", {}], ["get_hire_link", { agent: "../etc" }], ["get_hire_link", {}], ["get_hire_link", { agent: "agentic-meme" }]])("refuses %s rather than guessing", async (name, args) => {
  const body = await (await call(name, args as Record<string, unknown>)).json();
  expect(body.error.code).toBe(-32602);
});

it("answers malformed and unsupported JSON-RPC without a 500", async () => {
  const parse = await POST(mcpRequest("not json"));
  expect((await parse.json()).error.code).toBe(-32700);
  expect((await (await post({ jsonrpc: "2.0", id: 1, method: "resources/list" })).json()).error.code).toBe(-32601);
  expect((await (await post(JSON.stringify("string"))).json()).error.code).toBe(-32600);
});

it("accepts notifications with no JSON-RPC body, alone and inside a batch", async () => {
  const single = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect(single.status).toBe(202);
  expect(await single.text()).toBe("");
  const batch = await post([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 7, method: "ping" }]);
  const body = await batch.json();
  expect(body).toHaveLength(1);
  expect(body[0].id).toBe(7);
});

it("GET is a live descriptor a health probe can classify, not an error", async () => {
  const response = await GET(new NextRequest(`${ORIGIN}/mcp`));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.endpoint).toBe(`${ORIGIN}/mcp`);
  expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(body.serverInfo).toEqual(SERVER_INFO);
  expect(body.tools).toHaveLength(TOOLS.length);
});
