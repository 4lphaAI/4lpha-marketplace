import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  TARGET,
  call,
  createHarness,
  errorCode,
  freshNonce,
  signOwnerAction,
  toReadHeader,
} from "./support/serverHarness.js";

/** Independent audit pass 2: replay semantics and idempotency. */

describe("AUDIT: read-signature blast radius", () => {
  it("a captured read signature is replayable within its window (documented tradeoff)", async () => {
    const harness = await createHarness();
    const read = await signOwnerAction("read", {});
    const header = toReadHeader(read);
    const first = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": header },
    });
    const second = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": header },
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, "reads are deliberately not nonce-consumed");
  });

  it("a read signature CANNOT be repurposed for any mutation", async () => {
    const harness = await createHarness();
    const read = await signOwnerAction("read", {});
    for (const route of ["pause", "unpause", "revoke", "change-budget"]) {
      const res = await call(harness, `/agents/${AGENT_ID}/${route}`, {
        method: "POST",
        body: read,
      });
      assert.equal(res.status, 401, `${route} accepted a read signature`);
    }
    assert.equal(await harness.killswitch.isAgentPaused(
      AGENT_ID,
      (await harness.agentStore.getAgentById(AGENT_ID))!.ownerAddress,
    ), false);
  });

  it("a read signature expires with its window", async () => {
    const harness = await createHarness();
    const read = await signOwnerAction("read", {});
    harness.advance(301_000);
    const res = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(read) },
    });
    assert.equal(res.status, 401, "an expired read signature must be refused");
  });
});

describe("AUDIT: mutation replay vs idempotent retry", () => {
  it("the SAME signed mutation replays as an idempotent retry, consuming one nonce", async () => {
    const harness = await createHarness();
    const pause = await signOwnerAction("pause", {});
    const first = await call(harness, `/agents/${AGENT_ID}/pause`, { method: "POST", body: pause });
    const second = await call(harness, `/agents/${AGENT_ID}/pause`, { method: "POST", body: pause });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, "a retry of the identical request must succeed");
  });

  it("a DIFFERENT signature reusing a spent nonce is refused", async () => {
    const harness = await createHarness();
    const nonce = freshNonce();
    const first = await signOwnerAction("pause", {}, { nonce });
    const okRes = await call(harness, `/agents/${AGENT_ID}/pause`, { method: "POST", body: first });
    assert.equal(okRes.status, 200);

    // Same nonce, different action → different idempotency key, so it reaches
    // the nonce store and must be rejected as a replay.
    const second = await signOwnerAction("unpause", {}, { nonce });
    const replay = await call(harness, `/agents/${AGENT_ID}/unpause`, {
      method: "POST",
      body: second,
    });
    assert.equal(replay.status, 401, "a spent nonce must not authorize a new action");
    assert.equal(errorCode(replay.body), "owner_auth_failed");
  });
});

describe("AUDIT: execute idempotency", () => {
  it("the same decisionId with DIFFERENT calls is a conflict, never a false success", async () => {
    const harness = await createHarness();
    const first = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "d-conflict", calls: [{ to: TARGET, value: "1" }] },
    });
    assert.equal(first.status, 200, first.text);

    const submitted = harness.provider.executeCalls.length;
    const second = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "d-conflict", calls: [{ to: TARGET, value: "999" }] },
    });
    assert.equal(second.status, 409, "different calldata under one decisionId must conflict");
    assert.equal(
      harness.provider.executeCalls.length,
      submitted,
      "the conflicting call must not have been submitted",
    );
  });
});
