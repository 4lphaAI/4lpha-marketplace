import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  OTHER_OWNER_PK,
  SESSION_KEY,
  TARGET,
  call,
  createHarness,
  errorCode,
  signOwnerAction,
  toReadHeader,
} from "./support/serverHarness.js";

/** Independent audit pass: attack the HTTP surface rather than trust the suite. */

describe("AUDIT: tenant isolation", () => {
  it("wrong-owner and unknown-agent are byte-identical responses", async () => {
    const harness = await createHarness();
    const foreign = await signOwnerAction("read", {}, { pk: OTHER_OWNER_PK });
    const wrongOwner = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(foreign) },
    });
    const ghost = await signOwnerAction("read", {}, { agentId: "no-such-agent" });
    const unknown = await call(harness, "/agents/no-such-agent/owner-view", {
      headers: { "x-owner-action": toReadHeader(ghost) },
    });
    assert.equal(wrongOwner.status, 404, "wrong owner must be 404, never 403");
    assert.equal(unknown.status, 404);
    assert.equal(wrongOwner.text, unknown.text, "bodies must be indistinguishable");
  });

  it("a foreign owner cannot pause another tenant agent", async () => {
    const harness = await createHarness();
    const foreign = await signOwnerAction("pause", {}, { pk: OTHER_OWNER_PK });
    const res = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: foreign,
    });
    assert.ok(res.status === 404 || res.status === 401, `got ${res.status}`);
    const paused = await harness.killswitch.isAgentPaused(
      AGENT_ID,
      (await harness.agentStore.getAgentById(AGENT_ID))?.ownerAddress ??
        "0x0000000000000000000000000000000000000000",
    );
    assert.equal(paused, false, "a foreign signature must not have paused the agent");
  });
});

describe("AUDIT: service credential", () => {
  it("every non-health route refuses a missing or wrong exec token", async () => {
    const harness = await createHarness();
    const routes: Array<readonly [string, string]> = [
      ["GET", "/status"],
      ["GET", `/agents/${AGENT_ID}`],
      ["GET", "/agents"],
      ["POST", `/agents/${AGENT_ID}/execute`],
      ["POST", `/agents/${AGENT_ID}/pause`],
      ["POST", "/admin/halt"],
    ];
    for (const [method, path] of routes) {
      const missing = await call(harness, path, { method, noExecToken: true, body: {} });
      assert.equal(missing.status, 401, `${path} without token`);
      const wrong = await call(harness, path, { method, execToken: "not-the-token", body: {} });
      assert.equal(wrong.status, 401, `${path} with a wrong token`);
    }
    const health = await call(harness, "/health", { noExecToken: true });
    assert.equal(health.status, 200, "health must stay open for the platform probe");
  });

  it("an owner signature alone cannot reach the global halt", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("pause", {});
    const res = await call(harness, "/admin/halt", {
      method: "POST",
      body: { ...envelope, actor: "auditor", reason: "audit" },
    });
    assert.equal(res.status, 401, "halt requires the operator credential");
    assert.equal(await harness.killswitch.isHalted(), false, "halt must not have engaged");
  });
});

describe("AUDIT: the money path", () => {
  it("a paused agent never reaches the provider", async () => {
    const harness = await createHarness();
    const pause = await signOwnerAction("pause", {});
    const paused = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: pause,
    });
    assert.equal(paused.status, 200, `pause failed: ${paused.text}`);

    const before = harness.provider.executeCalls.length;
    const res = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "d-audit", calls: [{ to: TARGET, value: "1" }] },
    });
    assert.equal(res.status, 409);
    assert.equal(errorCode(res.body), "paused");
    assert.equal(
      harness.provider.executeCalls.length,
      before,
      "a paused agent must never reach the provider",
    );
  });

  it("no request shape can turn off the local policy check", async () => {
    const harness = await createHarness();
    const shapes: Array<Record<string, unknown>> = [
      { bypassLocalPolicyCheck: true },
      { params: { bypassLocalPolicyCheck: true } },
      { bypass_local_policy_check: true },
      { session: { bypassLocalPolicyCheck: true } },
    ];
    for (const [index, extra] of shapes.entries()) {
      await call(harness, `/agents/${AGENT_ID}/execute`, {
        method: "POST",
        body: {
          decisionId: `d-bypass-${index}`,
          calls: [{ to: TARGET, value: "1" }],
          ...extra,
        },
      });
    }
    for (const submitted of harness.provider.executeCalls) {
      assert.notEqual(
        submitted.bypassLocalPolicyCheck,
        true,
        "the local policy check was disabled from the wire",
      );
    }
  });
});

describe("AUDIT: secret containment", () => {
  it("the session key never appears in any response body", async () => {
    const harness = await createHarness();
    const bare = SESSION_KEY.slice(2).toLowerCase();
    const read = await signOwnerAction("read", {});
    const responses = [
      await call(harness, "/status"),
      await call(harness, `/agents/${AGENT_ID}`),
      await call(harness, `/agents/${AGENT_ID}/owner-view`, {
        headers: { "x-owner-action": toReadHeader(read) },
      }),
      await call(harness, `/agents/${AGENT_ID}/execute`, {
        method: "POST",
        body: { decisionId: "d-secret", calls: [{ to: TARGET, value: "1" }] },
      }),
    ];
    for (const res of responses) {
      assert.equal(
        res.text.toLowerCase().includes(bare),
        false,
        "the session key leaked into a response body",
      );
    }
  });
});
