import { expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { SERVER_INFO, TOOLS } from "@/lib/mcp/server";

const ORIGIN = "https://marketplace.invalid";
const post = async (body: unknown) => POST(new NextRequest(`${ORIGIN}/mcp`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const call = (name: string, args: Record<string, unknown> = {}) => post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

it("initialize echoes a supported protocol version and identifies the server", async () => {
  const body = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })).json();
  expect(body.result.protocolVersion).toBe("2024-11-05");
  expect(body.result.serverInfo).toEqual(SERVER_INFO);
  expect(body.result.capabilities.tools).toBeDefined();
  const garbage = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "whenever" } })).json();
  expect(garbage.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

/**
 * The drift guard. A tool we advertise but cannot run is a false public claim
 * on an endpoint written into an on-chain registration, so every declared name
 * must answer — not error — with its schema's required arguments supplied.
 */
it("implements every tool it advertises", async () => {
  const listed = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
  for (const tool of TOOLS) {
    const args = tool.name === "get_hire_link" || tool.name === "explain_strategy" ? { agent: "lp" } : {};
    const body = await (await call(tool.name, args)).json();
    expect(body.error, `${tool.name} must be implemented`).toBeUndefined();
    expect(body.result.content[0].type).toBe("text");
  }
});

it.each(["grid", "lp", "trade"])("explains %s without accessing live services", async (agent) => {
  const result = JSON.parse((await (await call("explain_strategy", { agent })).json()).result.content[0].text);
  expect(result.agent).toBe(agent);
  expect(result.howItWorks.length).toBeGreaterThan(0);
  expect(result.risks.length).toBeGreaterThan(0);
  expect(result.scope).toMatch(/Static/);
  expect(result.custody).toMatch(/separate passkey-controlled wallet/);
  expect(result.controls).toMatch(/Pause stops submissions by the 4lpha server/);
  expect(JSON.stringify(result)).not.toMatch(/exec-token|sessionKey|privateKey|ownerAddress/);
});

it.each([{}, { agent: "health" }, { agent: "__proto__" }, { agent: "lp", instanceId: "private" }])("rejects unsupported explanation arguments %j", async (args) => {
  expect((await (await call("explain_strategy", args)).json()).error.code).toBe(-32602);
});

it("lists the four agent-marketplace categories and links them to this origin", async () => {
  const body = await (await call("list_agents")).json();
  const { agents } = JSON.parse(body.result.content[0].text);
  expect(agents.map((agent: { category: string }) => agent.category).sort()).toEqual(["Grid Trading", "Health Factor Monitoring", "Rebalancing", "Yield Optimisation"]);
  expect(agents.every((agent: { deployUrl: string }) => agent.deployUrl.startsWith(`${ORIGIN}/deploy/`))).toBe(true);
  expect(agents.find((agent: { id: string }) => agent.id === "health").status).toBe("coming-soon");
});

it("says a hire needs the owner's own passkey signature, and never offers to do it", async () => {
  const body = await (await call("get_hire_link", { agent: "grid" })).json();
  const result = JSON.parse(body.result.content[0].text);
  expect(result.deployUrl).toBe(`${ORIGIN}/deploy/grid`);
  expect(result.authorises).toMatch(/passkey/i);
  expect(JSON.stringify(result)).not.toMatch(/exec-token|sessionKey|privateKey|ownerAddress/);
});

it.each([["unknown_tool", {}], ["get_hire_link", { agent: "../etc" }], ["get_hire_link", {}]])("refuses %s rather than guessing", async (name, args) => {
  const body = await (await call(name, args as Record<string, unknown>)).json();
  expect(body.error.code).toBe(-32602);
});

it("answers malformed and unsupported JSON-RPC without a 500", async () => {
  const parse = await POST(new NextRequest(`${ORIGIN}/mcp`, { method: "POST", body: "not json", headers: { "content-type": "application/json" } }));
  expect((await parse.json()).error.code).toBe(-32700);
  expect((await (await post({ jsonrpc: "2.0", id: 1, method: "resources/list" })).json()).error.code).toBe(-32601);
  expect((await (await post("string")).json()).error.code).toBe(-32600);
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
  expect(body.serverInfo).toEqual(SERVER_INFO);
  expect(body.tools).toHaveLength(TOOLS.length);
});

