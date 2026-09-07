/**
 * The `EXECUTE_RAW_ENABLED` gate on `POST /agents/:id/execute`.
 *
 * The raw route submits arbitrary calldata under the session key. With the trade
 * template's bare-selector `approve` granted, that is enough for a leaked
 * `x-exec-token` to approve and drain every ERC-20 in the owner's EOA — the
 * trade route cannot, because it hardcodes the spender. So the route is off
 * unless a deployment deliberately turns it on, and off means an ordinary 404:
 * a route that answered "disabled" would confirm it exists.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  ROUTER,
  TARGET,
  call,
  createHarness as createBaseHarness,
  errorCode,
} from "./support/serverHarness.js";

const createHarness = (
  options: Parameters<typeof createBaseHarness>[0] = {},
): ReturnType<typeof createBaseHarness> =>
  createBaseHarness({ ...options, httpRuntimeProfile: "raw-v1" });

const ONE_BNB = 10n ** 18n;

describe("EXECUTE_RAW_ENABLED", () => {
  it("404s when unset, byte-identically to an unknown route", async () => {
    const harness = await createHarness({ executeRaw: "unset" });
    const disabled = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "d-1", calls: [{ to: TARGET, value: "1" }] },
    });
    const unknownRoute = await call(harness, "/agents/whatever/nope", {
      method: "POST",
      body: {},
    });

    assert.equal(disabled.status, 404);
    assert.equal(errorCode(disabled.body), "not_found");
    assert.equal(disabled.text, unknownRoute.text);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("404s before the body is even read", async () => {
    // A disabled route must not report payload_too_large, invalid_request, or
    // anything else that distinguishes it from a path that does not exist.
    const harness = await createHarness({ config: { executeRawEnabled: false } });
    for (const body of [
      undefined,
      "not json",
      { decisionId: "d", calls: [] },
      { decisionId: "x".repeat(10_000), calls: [{ to: TARGET }] },
    ]) {
      const res = await call(harness, `/agents/${AGENT_ID}/execute`, {
        method: "POST",
        ...(body === undefined ? {} : { body }),
      });
      assert.equal(res.status, 404, JSON.stringify(body)?.slice(0, 40));
      assert.equal(errorCode(res.body), "not_found");
    }
  });

  it("still requires the service credential first", async () => {
    // The gate must not become an unauthenticated probe for agent existence.
    const harness = await createHarness({ config: { executeRawEnabled: false } });
    const res = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      noExecToken: true,
      body: {},
    });
    assert.equal(res.status, 401);
  });

  it("works normally when explicitly enabled", async () => {
    const harness = await createHarness({ config: { executeRawEnabled: true } });
    const res = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "d-1", calls: [{ to: TARGET, value: "1" }] },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("leaves the trade route alone", async () => {
    const harness = await createBaseHarness({ config: { executeRawEnabled: false } });
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: {
        decisionId: "d-1",
        venue: "pancake",
        side: "sell",
        token: "0x5555555555555555555555555555555555555555",
        amountWei: "1000",
        minOutWei: "990",
        quotedOutWei: "1000",
      },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.executeCalls.length, 1);
  });
});

describe("/execute native spend accounting", () => {
  it("records the sum of every call value on the journal row", async () => {
    const harness = await createHarness({ config: { executeRawEnabled: true } });
    const res = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: {
        decisionId: "d-1",
        calls: [
          { to: ROUTER, value: ONE_BNB.toString(10) },
          { to: TARGET, value: "7" },
          { to: TARGET },
        ],
      },
    });
    assert.equal(res.status, 200, res.text);

    const row = await harness.journal.getByDecision(AGENT_ID, "d-1");
    assert.equal(row?.kind, "execute");
    assert.equal(
      row?.nativeSpendWei,
      ONE_BNB + 7n,
      "raw spends must count against the same daily cap the trade route uses",
    );
  });

  it("records zero for a batch that moves no native value", async () => {
    const harness = await createHarness({ config: { executeRawEnabled: true } });
    await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "d-1", calls: [{ to: TARGET, data: "0xdeadbeef" }] },
    });
    const row = await harness.journal.getByDecision(AGENT_ID, "d-1");
    assert.equal(row?.nativeSpendWei, 0n);
  });
});
