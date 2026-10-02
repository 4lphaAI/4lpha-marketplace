import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  AGENT_ID,
  ROUTER,
  ROUTER_V3,
  TOKEN,
  TEST_VENUES,
  WBNB,
  call,
  createHarness,
  tradeBody,
  tradeConfig,
} from "./support/serverHarness.js";
import { tradeExecutionIdentity } from "../src/trade/execute.js";

const UNISWAP_ROUTER = getAddress("0x8888888888888888888888888888888888888888");
const UNI_VENUES = { ...TEST_VENUES, uniswapRouterV3: UNISWAP_ROUTER };

describe("POST /agents/:id/trade: uniswap_v3", () => {
  it("builds a single-hop buy through SwapRouter02 and refundETH", async () => {
    const harness = await createHarness({ config: { trade: tradeConfig({ venues: UNI_VENUES }) } });
    const response = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "uniswap_v3", route: { fees: [3000] } }),
    });
    assert.equal(response.status, 200, response.text);
    const calls = harness.provider.executeCalls[0]?.calls ?? [];
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.to, UNISWAP_ROUTER);
    assert.equal(calls[0]?.value, 1_000_000_000_000_000_000n);
    assert.ok(calls[0]?.data?.startsWith("0x04e45aaf"));
    assert.equal(calls[1]?.to, UNISWAP_ROUTER);
    assert.equal(calls[1]?.data, "0x12210e8a");
  });

  it("builds the four-call sell and unwraps to the agent wallet", async () => {
    const harness = await createHarness({ config: { trade: tradeConfig({ venues: UNI_VENUES }) } });
    const response = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "uniswap-sell", venue: "uniswap_v3", side: "sell", route: { fees: [3000] } }),
    });
    assert.equal(response.status, 200, response.text);
    const calls = harness.provider.executeCalls[0]?.calls ?? [];
    assert.equal(calls.length, 4);
    assert.equal(calls[2]?.to, UNISWAP_ROUTER);
    assert.ok(calls[2]?.data?.startsWith("0x04e45aaf"));
    assert.equal(calls[3]?.to, UNISWAP_ROUTER);
    assert.ok(calls[3]?.data?.startsWith("0x49404b7c"));
    assert.ok(calls[3]?.data?.includes(harness.provider.restoreCalls[0]?.walletAddress.slice(2).toLowerCase() ?? ""));
  });

  it("rejects the Pancake-only 2500 tier at the wire", async () => {
    const harness = await createHarness({ config: { trade: tradeConfig({ venues: UNI_VENUES }) } });
    const response = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "uniswap_v3", route: { fees: [2500] } }),
    });
    assert.equal(response.status, 400);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses an unconfigured Uniswap venue", async () => {
    const harness = await createHarness();
    const response = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "uniswap_v3", route: { fees: [3000] } }),
    });
    assert.equal(response.status, 400);
    assert.equal(harness.provider.executeCalls.length, 0);
  });
});

describe("Uniswap execution identity", () => {
  it("binds the Uniswap router and WBNB separately from the Pancake twin", () => {
    const trade = tradeConfig({ venues: UNI_VENUES });
    const common = {
      agentId: "identity-agent",
      chainId: 97,
      trade,
      pancake: { router: ROUTER, wbnb: WBNB },
      pancakeV3: { router: ROUTER_V3, wbnb: WBNB },
      uniswapV3: { router: UNISWAP_ROUTER, wbnb: WBNB },
      flapPortal: null,
    } as const;
    const route = { hops: [], fees: [3000] as const };
    const pancake = tradeExecutionIdentity({ ...common, request: {
      decisionId: "identity-pancake", venue: "pancake_v3", side: "buy", token: TOKEN,
      amountWei: 1n, minOutWei: 1n, quotedOutWei: 1n, route,
    } });
    const uniswap = tradeExecutionIdentity({ ...common, request: {
      decisionId: "identity-uniswap", venue: "uniswap_v3", side: "buy", token: TOKEN,
      amountWei: 1n, minOutWei: 1n, quotedOutWei: 1n, route,
    } });
    assert.notEqual(pancake.paramsHash, uniswap.paramsHash);
  });
});
