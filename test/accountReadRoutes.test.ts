import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import {
  AGENT_ID,
  CHAIN_ID,
  NETWORK,
  OTHER_AGENT_ID,
  call,
  createHarness,
  signOwnerAction,
  toReadHeader,
  type Harness,
} from "./support/serverHarness.js";

const WBNB = getAddress("0x3333333333333333333333333333333333333333");

function accountConfig() {
  return {
    key: parseAccountReadSessionSecret("cd".repeat(32))!,
    chainId: CHAIN_ID,
    environment: resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK }),
  };
}

async function issue(harness: Harness): Promise<string> {
  const envelope = await signOwnerAction("createAccountReadSession", {}, { agentId: "*" });
  const response = await call(harness, "/owner-read-session", { method: "POST", body: envelope });
  assert.equal(response.status, 200);
  return (response.body["data"] as { token: string }).token;
}

describe("Marketplace detail C1 account-read route matrix", () => {
  it("accepts bearer or signed read, never both/neither, on owner-view", async () => {
    const harness = await createHarness({ config: {
      accountReadSession: accountConfig(),
      accountPortfolioWbnb: WBNB,
    } });
    const token = await issue(harness);
    assert.equal((await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 200);
    assert.equal((await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(await signOwnerAction("read", {}, { agentId: AGENT_ID })) },
    })).status, 200);
    assert.equal((await call(harness, `/agents/${AGENT_ID}/owner-view`)).status, 401);
    assert.equal((await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-owner-action": toReadHeader(await signOwnerAction("read", {}, { agentId: AGENT_ID })),
      },
    })).status, 401);
    for (const authorization of ["bearer token", "Bearer", "Bearer one two", "Basic token"]) {
      assert.equal((await call(harness, `/agents/${AGENT_ID}/owner-view`, {
        headers: { authorization },
      })).status, 401);
    }
    harness.advance(901_000);
    assert.equal((await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 200);
    harness.advance(86_400_000);
    assert.equal((await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 401);
  });

  it("keeps bearer lookup owner-scoped and returns cross-owner 404", async () => {
    const harness = await createHarness({ config: { accountReadSession: accountConfig() } });
    const token = await issue(harness);
    assert.equal((await call(harness, `/agents/${OTHER_AGENT_ID}/owner-view`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 404);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("changes no non-allowlisted route and grants no mutation/runtime/operator authority", async () => {
    const harness = await createHarness({ config: {
      accountReadSession: accountConfig(),
      rateLimit: { capacity: 1_000, refillPerSecond: 1_000 },
    } });
    const token = await issue(harness);
    const bearer = { authorization: `Bearer ${token}` };
    const probes = [
      { path: "/owner-read-session", options: { method: "POST", body: {} } },
      { path: "/agents", options: {} },
      { path: `/agents/${AGENT_ID}`, options: { noRuntimeAssertion: true } },
      { path: `/agents/${AGENT_ID}/billing`, options: {} },
      { path: `/agents/${AGENT_ID}/lp/importable/1`, options: {} },
      { path: `/agents/${AGENT_ID}/venus/owner-view`, options: {} },
      { path: `/agents/${AGENT_ID}/pause`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/unpause`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/change-budget`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/runtime-profile`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/revoke`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/session`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/session/cancel`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/billing/grant`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/billing/issuer/rotate`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/billing/pause`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/billing/resume`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/billing/revoke`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/billing/close`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/billing/service-session`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/lp/settings`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/lp/grid/arm`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/lp/open`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/lp/import`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/lp/position-1/exit`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/lp/sequences/sequence-1/abandon`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/journal/decision-1/retire-pre-bind/v1`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/journal/decision-1/resolve-landing/v1`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/journal/decision-1/resolve`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/venus/settings`, options: { method: "POST", body: {} } },
      { path: `/agents/${AGENT_ID}/trade`, options: { method: "POST", body: {}, noRuntimeAssertion: true } },
      { path: `/agents/${AGENT_ID}/execute`, options: { method: "POST", body: {}, noRuntimeAssertion: true } },
      { path: `/admin/halt`, options: { method: "POST", body: {} } },
      { path: `/admin/resume`, options: { method: "POST", body: {} } },
    ] as const;
    for (const probe of probes) {
      const control = await call(harness, probe.path, probe.options);
      const withBearer = await call(harness, probe.path, {
        ...probe.options,
        headers: bearer,
      });
      assert.equal(withBearer.status, control.status, probe.path);
      assert.equal(withBearer.text, control.text, probe.path);
    }
    for (const path of ["/status", "/agents/hire/preview", "/lp/pools/0x1111111111111111111111111111111111111111/state", "/health"] as const) {
      const control = await call(harness, path, path === "/health" ? { noExecToken: true } : {});
      const withBearer = await call(harness, path, {
        ...(path === "/health" ? { noExecToken: true } : {}),
        headers: bearer,
      });
      assert.equal(withBearer.status, control.status);
      assert.equal(withBearer.text, control.text);
    }
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("returns a distinct 429 when a valid bearer exhausts the owner bucket", async () => {
    const harness = await createHarness({ config: {
      accountReadSession: accountConfig(),
      accountPortfolioWbnb: WBNB,
      ownerRateLimit: { capacity: 2, refillPerSecond: 0.0001 },
    } });
    const token = await issue(harness);
    assert.equal((await call(harness, "/account/portfolio", {
      headers: { authorization: `Bearer ${token}` },
    })).status, 200);
    const limited = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(limited.status, 429);
    assert.equal((limited.body["error"] as { code: string }).code, "rate_limited");
    assert.equal(harness.provider.executeCalls.length, 0);
  });
});
