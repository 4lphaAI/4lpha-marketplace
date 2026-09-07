/**
 * The authorization matrix, endpoint by endpoint.
 *
 * This file exists because the three auth layers are easy to describe and easy
 * to wire up wrong. Every route is driven through the same six-case ladder:
 *
 *   no token · bad token · token only · token + wrong-owner signature ·
 *   token + right-owner signature · operator credential
 *
 * and the two ambiguities that carry security weight are asserted directly:
 *   - a cross-tenant probe is BYTE-IDENTICAL to an unknown agent, so the
 *     endpoint cannot be used to learn which agent ids exist;
 *   - every signature failure — forged, expired, replayed, wrong chain, wrong
 *     params, wrong action, wrong agent — produces the SAME code, so it cannot
 *     be used to learn which check failed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  EXEC_TOKEN,
  OPERATOR_TOKEN,
  OWNER_ADDRESS,
  OTHER_AGENT_ID,
  OTHER_OWNER_PK,
  call,
  createHarness,
  errorCode,
  freshNonce,
  signOwnerAction,
  signRuntimeRequest,
  toReadHeader,
  NOW_SEC,
  CHAIN_ID,
} from "./support/serverHarness.js";
import { GLOBAL_AGENT_SENTINEL } from "../src/auth/ownerAuth.js";

/* -------------------------------------------------------------------------- */
/* Layer 1 — the service credential                                           */
/* -------------------------------------------------------------------------- */

const CREDENTIALED_ROUTES = [
  { path: "/status", method: "GET" },
  { path: `/agents/${AGENT_ID}`, method: "GET" },
  { path: "/agents", method: "GET" },
  { path: `/agents/${AGENT_ID}/owner-view`, method: "GET" },
  { path: `/agents/${AGENT_ID}/pause`, method: "POST" },
  { path: `/agents/${AGENT_ID}/unpause`, method: "POST" },
  { path: `/agents/${AGENT_ID}/change-budget`, method: "POST" },
  { path: `/agents/${AGENT_ID}/revoke`, method: "POST" },
  { path: `/agents/${AGENT_ID}/execute`, method: "POST" },
  { path: "/admin/halt", method: "POST" },
  { path: "/admin/resume", method: "POST" },
] as const;

describe("layer 1 — x-exec-token on every route", () => {
  it("lets /health through with no credential at all", async () => {
    const harness = await createHarness();
    const response = await call(harness, "/health", { noExecToken: true });
    assert.equal(response.status, 200);
  });

  for (const route of CREDENTIALED_ROUTES) {
    it(`${route.method} ${route.path} rejects a missing token`, async () => {
      const harness = await createHarness();
      const response = await call(harness, route.path, {
        method: route.method,
        noExecToken: true,
        body: {},
      });
      assert.equal(response.status, 401);
      assert.equal(errorCode(response.body), "unauthorized");
    });

    it(`${route.method} ${route.path} rejects a wrong token`, async () => {
      const harness = await createHarness();
      const response = await call(harness, route.path, {
        method: route.method,
        execToken: `${EXEC_TOKEN}-wrong`,
        body: {},
      });
      assert.equal(response.status, 401);
      assert.equal(errorCode(response.body), "unauthorized");
    });
  }

  it("refuses to run at all when no service credential is configured", async () => {
    // A blank credential is a deployment mistake, not a dev mode. A service that
    // can sign transactions must not start with its front door open.
    const harness = await createHarness({ config: { execToken: "" } });
    const response = await call(harness, "/status");
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "unauthorized");
  });
});

/* -------------------------------------------------------------------------- */
/* Layer 2 — owner signatures                                                 */
/* -------------------------------------------------------------------------- */

const OWNER_MUTATIONS = [
  { path: `/agents/${AGENT_ID}/pause`, action: "pause" as const, params: {} },
  { path: `/agents/${AGENT_ID}/unpause`, action: "unpause" as const, params: {} },
  {
    path: `/agents/${AGENT_ID}/change-budget`,
    action: "changeBudget" as const,
    params: { dailyNativeWei: "1000" },
  },
  { path: `/agents/${AGENT_ID}/revoke`, action: "revoke" as const, params: {} },
];

describe("layer 2 — owner signature on owner-authority routes", () => {
  for (const route of OWNER_MUTATIONS) {
    it(`${route.path} rejects the service credential alone`, async () => {
      const harness = await createHarness();
      const response = await call(harness, route.path, {
        method: "POST",
        body: {},
      });
      assert.equal(response.status, 401);
      assert.equal(errorCode(response.body), "owner_auth_failed");
    });

    it(`${route.path} rejects a signature from the WRONG owner`, async () => {
      const harness = await createHarness();
      // A real, valid signature — just not from the owner of this agent.
      const envelope = await signOwnerAction(route.action, route.params, {
        pk: OTHER_OWNER_PK,
      });
      const response = await call(harness, route.path, {
        method: "POST",
        body: envelope,
      });
      // The signature verifies; the agent lookup is then scoped to the RECOVERED
      // owner and finds nothing. Indistinguishable from an unknown agent.
      assert.equal(response.status, 404);
      assert.equal(errorCode(response.body), "not_found");
    });

    it(`${route.path} accepts a signature from the right owner`, async () => {
      const harness = await createHarness();
      if (route.action === "unpause") {
        await harness.agentStore.updateAgentStatus(OWNER_ADDRESS, AGENT_ID, "paused");
      }
      const envelope = await signOwnerAction(route.action, route.params);
      const response = await call(harness, route.path, {
        method: "POST",
        body: envelope,
      });
      assert.equal(response.status, 200);
    });
  }

  it("refuses a pause signature posted to the unpause route", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("pause", {});
    const response = await call(harness, `/agents/${AGENT_ID}/unpause`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("refuses a signature bound to a DIFFERENT agent than the path", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("pause", {}, { agentId: OTHER_AGENT_ID });
    const response = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("gives ONE non-discriminating code for every class of signature failure", async () => {
    const harness = await createHarness();
    const path = `/agents/${AGENT_ID}/pause`;

    const cases: Record<string, unknown> = {
      expired: await signOwnerAction(
        "pause",
        {},
        { issuedAt: NOW_SEC - 600, expiry: NOW_SEC - 300 },
      ),
      notYetValid: await signOwnerAction(
        "pause",
        {},
        { issuedAt: NOW_SEC + 600, expiry: NOW_SEC + 700 },
      ),
      wrongChain: await signOwnerAction("pause", {}, { chainId: CHAIN_ID + 1 }),
      wrongEnvironment: await signOwnerAction("pause", {}, { envSalt: "other-env" }),
      paramsMismatch: await signOwnerAction(
        "pause",
        { real: "params" },
        { paramsHash: `0x${"00".repeat(32)}` },
      ),
      malformedEnvelope: { signed: { nope: true }, signature: "0x00" },
      emptyBody: {},
    };

    const observed = new Set<string>();
    for (const [name, body] of Object.entries(cases)) {
      const response = await call(harness, path, { method: "POST", body });
      assert.equal(response.status, 401, `${name} should be 401`);
      observed.add(errorCode(response.body) ?? "<none>");
    }
    // One code across every failure class. If this set ever grows, the endpoint
    // has become an oracle for which check failed.
    assert.deepEqual([...observed], ["owner_auth_failed"]);
  });

  it("does not accept a tampered signature", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("pause", {});
    // Flip a byte inside `r`, not the trailing recovery byte: a mangled `v` can
    // still recover the same address, which would make this test pass for the
    // wrong reason.
    const original = envelope.signature;
    const flipped = `${original.slice(0, 10)}${
      original[10] === "a" ? "b" : "a"
    }${original.slice(11)}`;
    const response = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: { ...envelope, signature: flipped },
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });
});

/* -------------------------------------------------------------------------- */
/* Owner reads                                                                */
/* -------------------------------------------------------------------------- */

describe("owner reads", () => {
  it("rejects the service credential alone on the owner view", async () => {
    const harness = await createHarness();
    const response = await call(harness, `/agents/${AGENT_ID}/owner-view`);
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("returns the owner's own agent for a valid read signature", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("read", { agentId: AGENT_ID });
    const response = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["id"], AGENT_ID);
  });

  it("lists only the signer's own agents", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction(
      "read",
      { scope: "list" },
      { agentId: GLOBAL_AGENT_SENTINEL },
    );
    const response = await call(harness, "/agents", {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>[];
    assert.deepEqual(
      data.map((agent) => agent["id"]),
      [AGENT_ID],
    );
  });

  it("refuses a per-agent read signature on the list route", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("read", {}, { agentId: AGENT_ID });
    const response = await call(harness, "/agents", {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("refuses a pause signature used as a read credential", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("pause", {});
    const response = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("does NOT consume a nonce, so a retried read still works", async () => {
    const harness = await createHarness();
    const nonce = freshNonce();
    const envelope = await signOwnerAction("read", { agentId: AGENT_ID }, { nonce });
    const header = toReadHeader(envelope);

    const first = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": header },
    });
    const second = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": header },
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, "a repeated read must not be treated as a replay");
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-tenant indistinguishability                                          */
/* -------------------------------------------------------------------------- */

describe("cross-tenant probes are indistinguishable from unknown agents", () => {
  it("returns an identical body for someone else's agent and a missing one", async () => {
    const harness = await createHarness();

    const otherAgent = await signOwnerAction("read", {}, { agentId: OTHER_AGENT_ID });
    const missing = await signOwnerAction("read", {}, { agentId: "no-such-agent" });

    const crossTenant = await call(harness, `/agents/${OTHER_AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(otherAgent) },
    });
    const unknown = await call(harness, "/agents/no-such-agent/owner-view", {
      headers: { "x-owner-action": toReadHeader(missing) },
    });

    assert.equal(crossTenant.status, 404);
    assert.equal(unknown.status, 404);
    // Byte-identical, not merely same-code: a differing message would still leak.
    assert.equal(crossTenant.text, unknown.text);
  });

  it("refuses a cross-tenant pause with the same 404 as an unknown agent", async () => {
    const harness = await createHarness();

    const crossTenantEnvelope = await signOwnerAction(
      "pause",
      {},
      { agentId: OTHER_AGENT_ID },
    );
    const crossTenant = await call(harness, `/agents/${OTHER_AGENT_ID}/pause`, {
      method: "POST",
      body: crossTenantEnvelope,
    });

    const unknownEnvelope = await signOwnerAction("pause", {}, { agentId: "ghost" });
    const unknown = await call(harness, "/agents/ghost/pause", {
      method: "POST",
      body: unknownEnvelope,
    });

    assert.equal(crossTenant.status, 404);
    assert.equal(unknown.text, crossTenant.text);

    // And the other owner's agent is genuinely untouched.
    assert.equal(
      await harness.killswitch.isAgentPaused(
        OTHER_AGENT_ID,
        (await harness.agentStore.getAgentById(OTHER_AGENT_ID))!.ownerAddress,
      ),
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Layer 3 — the operator credential                                          */
/* -------------------------------------------------------------------------- */

describe("layer 3 — operator credential on global halt/resume", () => {
  it("rejects the service credential alone", async () => {
    const harness = await createHarness();
    const response = await call(harness, "/admin/halt", {
      method: "POST",
      body: { actor: "oncall" },
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "unauthorized");
  });

  it("rejects an owner signature in place of the operator credential", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("pause", {});
    const response = await call(harness, "/admin/halt", {
      method: "POST",
      body: { actor: "oncall", ...envelope },
    });
    assert.equal(response.status, 401);
  });

  it("rejects a wrong operator token", async () => {
    const harness = await createHarness();
    const response = await call(harness, "/admin/halt", {
      method: "POST",
      headers: { "x-operator-token": `${OPERATOR_TOKEN}-wrong` },
      body: { actor: "oncall" },
    });
    assert.equal(response.status, 401);
  });

  it("halts and resumes with both credentials, and requires an actor", async () => {
    const harness = await createHarness();

    const noActor = await call(harness, "/admin/halt", {
      method: "POST",
      headers: { "x-operator-token": OPERATOR_TOKEN },
      body: {},
    });
    assert.equal(noActor.status, 400);

    const halted = await call(harness, "/admin/halt", {
      method: "POST",
      headers: { "x-operator-token": OPERATOR_TOKEN },
      body: { actor: "oncall", reason: "incident 42" },
    });
    assert.equal(halted.status, 200);
    assert.equal(await harness.killswitch.isHalted(), true);

    const resumed = await call(harness, "/admin/resume", {
      method: "POST",
      headers: { "x-operator-token": OPERATOR_TOKEN },
      body: { actor: "oncall" },
    });
    assert.equal(resumed.status, 200);
    assert.equal(await harness.killswitch.isHalted(), false);
  });

  it("refuses admin routes when no operator credential is configured", async () => {
    const harness = await createHarness({ config: { operatorToken: "" } });
    const response = await call(harness, "/admin/halt", {
      method: "POST",
      headers: { "x-operator-token": "" },
      body: { actor: "oncall" },
    });
    assert.equal(response.status, 401);
  });
});

/* -------------------------------------------------------------------------- */
/* Runtime read                                                               */
/* -------------------------------------------------------------------------- */

describe("runtime read needs both service and request-bound runtime authority", () => {
  it("returns the assertion-bound runtime view", async () => {
    const harness = await createHarness();
    const response = await call(harness, `/agents/${AGENT_ID}`);
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["id"], AGENT_ID);
    assert.equal(data["ownerAddress"], OWNER_ADDRESS.toLowerCase());
    assert.equal(data["httpRuntimeProfile"], "trade-v1");
    assert.equal(data["caps"], undefined);
  });

  it("404s an unknown agent only after a valid runtime assertion", async () => {
    const harness = await createHarness();
    const assertion = await signRuntimeRequest(harness, "nope", "agentRead", {}, {
      owner: OWNER_ADDRESS,
      profile: "trade-v1",
    });
    const response = await call(harness, "/agents/nope", { runtimeAssertion: assertion });
    assert.equal(response.status, 404);
    assert.equal(errorCode(response.body), "not_found");
  });
});
