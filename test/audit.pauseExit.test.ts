/**
 * Auditor-written: a pause must not trap the position it was meant to protect.
 *
 * `pause` is the owner's risk control — the thing they reach for when an agent
 * is misbehaving. If it blocked selling as well as buying, using it would lock
 * the owner into whatever the agent had already bought, with no way out until
 * the session expired. The safety action would become the trap.
 *
 * The same reasoning already governs the scan gate, which never evaluates a
 * sell because blocking an exit does the honeypot's work for it. This file
 * pins the equivalent rule for the kill switch, and pins the boundaries: a
 * pause still blocks BUYING, and a global halt still blocks everything, because
 * halt is the operator's emergency stop rather than one owner's risk tool.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  OWNER_ADDRESS,
  call,
  createHarness,
  errorCode,
  safeSecurityPayload,
  tradeBody,
  type Harness,
} from "./support/serverHarness.js";

async function pausedHarness(): Promise<Harness> {
  const harness = await createHarness();
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  await harness.killswitch.pauseAgent(AGENT_ID, OWNER_ADDRESS);
  return harness;
}

describe("audit: a paused agent can still get out", () => {
  it("allows a SELL while paused, and actually submits it", async () => {
    const harness = await pausedHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "sell", amountWei: "5000" }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(
      (res.body["data"] as Record<string, unknown>)["status"],
      "CONFIRMED",
      "a paused owner must be able to close a position",
    );
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("still refuses a BUY while paused", async () => {
    // The carve-out is for reducing exposure, not for ignoring the pause.
    const harness = await pausedHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "buy", amountWei: "1000" }),
    });

    assert.equal(res.status, 409);
    assert.equal(errorCode(res.body), "paused");
    assert.equal(harness.provider.executeCalls.length, 0, "no buy may reach the provider");
  });

  it("a GLOBAL HALT still blocks the sell too", async () => {
    // Halt is the operator's stop for our own infrastructure, not an owner's
    // risk tool, and "stop everything" is exactly what it is for.
    const harness = await createHarness();
    harness.dataPlane.nextSecurity = safeSecurityPayload();
    await harness.killswitch.halt("incident");
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "sell", amountWei: "5000" }),
    });

    assert.equal(res.status, 409);
    assert.equal(errorCode(res.body), "halted");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("an EXPIRED session still blocks the sell", async () => {
    // Expiry is enforced on chain; letting a sell through here would only spend
    // a relay round trip to be refused by the account.
    const harness = await createHarness();
    harness.dataPlane.nextSecurity = safeSecurityPayload();
    const agent = await harness.agentStore.getAgent(OWNER_ADDRESS, AGENT_ID);
    assert.ok(agent?.sessionFacts !== null && agent?.sessionFacts !== undefined);
    await harness.agentStore.updateAgentSessionFacts(OWNER_ADDRESS, AGENT_ID, {
      ...agent.sessionFacts,
      spec: { ...agent.sessionFacts.spec, expiresAt: 1 },
      expiry: 1,
    });
    await harness.killswitch.pauseAgent(AGENT_ID, OWNER_ADDRESS);

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "sell", amountWei: "5000" }),
    });
    assert.equal(res.status, 409);
    assert.equal(errorCode(res.body), "not_executable");
    assert.equal(harness.provider.executeCalls.length, 0);
  });
});
