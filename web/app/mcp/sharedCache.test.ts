import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as mcpPost } from "./route";
import { GET as bffGet } from "../api/agentic/[...path]/route";
import { WALLET, callBody, installExecPlane, mcpRequest, resetAll } from "./fixtures";

let ip = 0;
const bff = (path: string) => bffGet(new NextRequest("https://app.test/api/agentic/" + path, { headers: { "x-forwarded-for": "bff-" + (ip += 1) } }), { params: Promise.resolve({ path: path.split("/") }) });
const status = () => mcpPost(mcpRequest(callBody("agent_status", { wallet: WALLET })));
beforeEach(() => { resetAll(); vi.stubEnv("MCP_DATA_TOOLS_ENABLED", "true"); vi.stubEnv("NEXT_PUBLIC_AGENTIC_WALLET_ENABLED", "true"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("the public page route and the MCP agent_status share one execution read per wallet per 15 seconds", async () => {
  let now = 1_900_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { calls } = installExecPlane();
  expect((await bff("wallets/" + WALLET)).status).toBe(200);
  const viaMcp = await (await status()).json();
  expect(JSON.parse(viaMcp.result.content[0].text).agent.name).toBe("Agentic AI Trade 01");
  expect((await bff("wallets/" + WALLET)).status).toBe(200);
  await status();
  expect(calls).toHaveLength(1);
  now += 14_999;
  await status();
  await bff("wallets/" + WALLET);
  expect(calls).toHaveLength(1);
  now += 2;
  await status();
  await bff("wallets/" + WALLET);
  expect(calls).toHaveLength(2);
});

it("works in the other order too: MCP first, then the page", async () => {
  const { calls } = installExecPlane();
  await status();
  await bff("wallets/" + WALLET);
  expect(calls).toHaveLength(1);
});

it("concurrent page and MCP reads for one wallet make a single execution read", async () => {
  const { calls } = installExecPlane();
  await Promise.all([bff("wallets/" + WALLET), status(), bff("wallets/" + WALLET), status()]);
  expect(calls).toHaveLength(1);
});

it("does not cache a failed execution read for either surface", async () => {
  const { calls, fetcher } = installExecPlane({}, 502);
  await bff("wallets/" + WALLET);
  await status();
  expect(calls).toHaveLength(2);
  fetcher.mockImplementation(async (input) => { calls.push(String(input)); return new Response(JSON.stringify({ data: { wallet: WALLET, custody: "binance-agentic", agent: null } }), { status: 200 }); });
  expect((await bff("wallets/" + WALLET)).status).toBe(200);
  expect(calls).toHaveLength(3);
});

it("keeps the page's own 60 per minute limit and the MCP budget separate", async () => {
  installExecPlane();
  const get = () => bffGet(new NextRequest("https://app.test/api/agentic/wallets/" + WALLET, { headers: { "x-forwarded-for": "same-bff-client" } }), { params: Promise.resolve({ path: ["wallets", WALLET] }) });
  for (let i = 0; i < 60; i += 1) expect((await get()).status).toBe(200);
  expect((await get()).status).toBe(429);
  expect((await status()).status).toBe(200);
});
