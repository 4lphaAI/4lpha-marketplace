/**
 * The money path.
 *
 * Every property here is one where being wrong costs funds rather than
 * convenience:
 *   - the runtime submits with NO owner signature, but the kill switch still
 *     stops it — that asymmetry is the whole point of a scoped session, and it is
 *     only safe if the switch really does bind the trusted caller;
 *   - an identical retry returns the STORED outcome instead of trading twice;
 *   - a retry that changes the calls under an identifier that already means
 *     something is a CONFLICT, never a quietly-reported success for the wrong
 *     trade;
 *   - `bypassLocalPolicyCheck` cannot be reached from any request field, at any
 *     nesting depth;
 *   - the throttle bounds how fast a leaked service credential can burn a cap
 *     period.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  AGENT_ID,
  TARGET,
  call,
  createHarness as createBaseHarness,
  errorCode,
  ownerAccount,
  NOW_SEC,
  sessionFacts,
} from "./support/serverHarness.js";

const createHarness = (
  options: Parameters<typeof createBaseHarness>[0] = {},
): ReturnType<typeof createBaseHarness> =>
  createBaseHarness({ ...options, httpRuntimeProfile: "raw-v1" });
import {
  InfrastructureError,
  NotAllowedError,
  ProviderError,
  SessionExpiredError,
} from "../src/core/types.js";
import { MAX_CALLS_PER_EXECUTE } from "../src/wallet/altana.js";

function executeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decisionId: "decision-1",
    calls: [{ to: TARGET, value: "1000", data: "0x" }],
    ...overrides,
  };
}

async function execute(
  harness: Awaited<ReturnType<typeof createHarness>>,
  body: Record<string, unknown> = executeBody(),
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  return call(harness, `/agents/${AGENT_ID}/execute`, { method: "POST", body });
}

describe("execute — the happy path", () => {
  it("submits with only the service credential and no owner signature", async () => {
    const harness = await createHarness();
    const response = await execute(harness);

    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["status"], "CONFIRMED");
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("resolves tenancy from the STORED ROW, not from the request", async () => {
    const harness = await createHarness();
    // A body that tries to name a different owner must change nothing.
    await execute(harness, executeBody({ ownerAddress: "0x" + "de".repeat(20) }));

    const restore = harness.provider.restoreCalls[0];
    assert.notEqual(restore, undefined);
    assert.equal(restore?.walletAddress, ownerAccount.address);

    const entry = await harness.journal.getByDecision(AGENT_ID, "decision-1");
    assert.equal(entry?.ownerAddress, getAddress(ownerAccount.address).toLowerCase());
  });

  it("journals begin → in-progress → committed with the callsId and tx hash", async () => {
    const harness = await createHarness();
    const response = await execute(harness);
    const meta = response.body["meta"] as Record<string, unknown>;
    const key = meta["idempotencyKey"] as string;

    const entry = await harness.journal.get(key);
    assert.equal(entry?.state, "COMMITTED");
    assert.equal(entry?.externalRef.callsId, harness.provider.nextReceipt.callsId);
    assert.equal(
      entry?.externalRef.txHash,
      harness.provider.nextReceipt.transactionHash,
    );
  });

  it("returns FAILED with a failureCode when the chain rejects the policy", async () => {
    const harness = await createHarness();
    harness.provider.nextReceipt = {
      status: "FAILED",
      callsId: `0x${"c2".repeat(32)}`,
      failureCode: "CAP_EXCEEDED",
    };

    const response = await execute(harness);
    assert.equal(response.status, 200, "a policy rejection is an outcome, not an HTTP error");
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["status"], "FAILED");
    assert.equal(data["failureCode"], "CAP_EXCEEDED");

    const meta = response.body["meta"] as Record<string, unknown>;
    const entry = await harness.journal.get(meta["idempotencyKey"] as string);
    assert.equal(entry?.state, "ROLLED_BACK");
  });

  /*
   * DO NOT FLIP THIS TEST (PHASE2.4 R4 item 15).
   *
   * It is one of three that pin the direction that is a DOUBLE SPEND. The error
   * arrives from the SUBMIT — a generic relay failure, not a pre-flight refusal
   * — and a transport error can follow a request the relay already accepted. If
   * a future change makes this row ROLLED_BACK, it releases cap headroom for a
   * trade that may well have landed. UNKNOWN and HELD is the only safe answer,
   * and the positional split exists precisely so that this case cannot be
   * confused with `preflightError`, which never reached anyone.
   */
  it("holds an ambiguous transport failure as UNKNOWN rather than guessing", async () => {
    const harness = await createHarness();
    harness.provider.nextError = new InfrastructureError("relay 503");

    const response = await execute(harness);
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    // PENDING, not FAILED: a transport error can follow a request the relay
    // already accepted, so claiming failure could be claiming a trade did not
    // happen when it did.
    assert.equal(data["status"], "PENDING");

    const meta = response.body["meta"] as Record<string, unknown>;
    assert.equal(meta["journalState"], "UNKNOWN");
    const entry = await harness.journal.get(meta["idempotencyKey"] as string);
    assert.equal(entry?.state, "UNKNOWN");
  });
});

/* -------------------------------------------------------------------------- */
/* Pre-submission refusals (PHASE2.4 R3/R4)                                   */
/* -------------------------------------------------------------------------- */

describe("execute — a refusal that never submitted", () => {
  it("rolls the row back and reports FAILED, not PENDING", async () => {
    const harness = await createHarness();
    harness.provider.preflightError = new NotAllowedError(
      "Call target is not in the session allowlist; rejected before submission.",
    );

    const response = await execute(harness);
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    // Not PENDING. A definite refusal must read as one: `PENDING` here is what
    // made a purely local refusal look like a slow relay for three rounds of
    // diagnosis (FINDINGS (v)).
    assert.equal(data["status"], "FAILED");
    assert.equal(data["failureCode"], "NOT_ALLOWED");

    const meta = response.body["meta"] as Record<string, unknown>;
    assert.equal(meta["journalState"], "ROLLED_BACK");
    assert.equal(meta["note"], "Refused before submission; nothing was sent.");
    const entry = await harness.journal.get(meta["idempotencyKey"] as string);
    assert.equal(entry?.state, "ROLLED_BACK");
    assert.equal(harness.provider.executeCalls.length, 0, "nothing was submitted");
  });

  it("keeps the thrown error's own code rather than collapsing it", async () => {
    // The direct benefit of positional over taxonomic classification: a caller
    // that already branches on SESSION_EXPIRED still can.
    const harness = await createHarness();
    harness.provider.preflightError = new SessionExpiredError();

    const response = await execute(harness);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["failureCode"], "SESSION_EXPIRED");
  });

  it("releases the cap headroom the rolled-back row was holding", async () => {
    const harness = await createHarness();
    harness.provider.preflightError = new NotAllowedError("refused");
    const refused = await execute(harness);
    const key = (refused.body["meta"] as Record<string, unknown>)["idempotencyKey"];
    assert.equal((await harness.journal.get(key as string))?.state, "ROLLED_BACK");

    // A ROLLED_BACK row does not count against the daily window; an UNKNOWN one
    // would. That difference is the whole reason the split exists.
    const spent = await harness.journal.sumNativeSpendSince(AGENT_ID, 0);
    assert.equal(spent, 0n);
  });

  it("journals UNKNOWN when the submit RESOLVES and the signal aborts after", async () => {
    // PHASE2.4 R4 item 16. An abort is ambiguous by construction — the SDK takes
    // no signal, so nothing can prove the accepted request did not land — and an
    // abort that arrives after a successful submit must never be reclassified as
    // a refusal. Modelled here by a provider that resolves the submit and then
    // throws the abort error the real helper throws.
    const harness = await createHarness();
    harness.provider.nextError = new ProviderError("Request aborted by caller.");

    const response = await execute(harness);
    const meta = response.body["meta"] as Record<string, unknown>;
    assert.equal(meta["journalState"], "UNKNOWN");
    assert.notEqual(meta["journalState"], "ROLLED_BACK");
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotency and conflict                                                   */
/* -------------------------------------------------------------------------- */

describe("execute — idempotency", () => {
  it("returns the stored outcome for the SAME calls and never re-submits", async () => {
    const harness = await createHarness();
    const first = await execute(harness);
    const second = await execute(harness);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(
      harness.provider.executeCalls.length,
      1,
      "the second request must not reach the provider",
    );

    const data = second.body["data"] as Record<string, unknown>;
    assert.equal(data["status"], "CONFIRMED");
    const meta = second.body["meta"] as Record<string, unknown>;
    assert.equal(meta["replayed"], true);
  });

  it("409s a DIFFERENT set of calls under the same decisionId", async () => {
    const harness = await createHarness();
    await execute(harness);

    const conflicting = await execute(
      harness,
      executeBody({ calls: [{ to: TARGET, value: "999999" }] }),
    );

    assert.equal(conflicting.status, 409);
    assert.equal(errorCode(conflicting.body), "conflict");
    assert.equal(
      harness.provider.executeCalls.length,
      1,
      "a conflicting retry must not submit anything",
    );
  });

  it("treats a different decisionId as a genuinely new execute", async () => {
    const harness = await createHarness();
    await execute(harness);
    const second = await execute(harness, executeBody({ decisionId: "decision-2" }));

    assert.equal(second.status, 200);
    assert.equal(harness.provider.executeCalls.length, 2);
  });

  it("hashes calls canonically, so address casing is not a new trade", async () => {
    const harness = await createHarness();
    await execute(harness);
    const lowercased = await execute(
      harness,
      executeBody({ calls: [{ to: TARGET.toLowerCase(), value: "1000", data: "0x" }] }),
    );

    assert.equal(lowercased.status, 200);
    assert.equal(
      harness.provider.executeCalls.length,
      1,
      "the same batch spelled differently must collapse onto one submit",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Kill switch binds the trusted caller                                       */
/* -------------------------------------------------------------------------- */

describe("execute — the kill switch binds even the trusted runtime", () => {
  it("409s `paused` while the agent is paused", async () => {
    const harness = await createHarness();
    await harness.killswitch.pauseAgent(AGENT_ID, ownerAccount.address);

    const response = await execute(harness);
    assert.equal(response.status, 409);
    assert.equal(errorCode(response.body), "paused");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("409s `halted` while the global halt is engaged", async () => {
    const harness = await createHarness();
    await harness.killswitch.halt("incident");

    const response = await execute(harness);
    assert.equal(response.status, 409);
    assert.equal(errorCode(response.body), "halted");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("409s an expired session without touching the provider", async () => {
    const harness = await createHarness();
    await harness.agentStore.updateAgentSessionFacts(
      ownerAccount.address,
      AGENT_ID,
      sessionFacts(NOW_SEC - 1),
    );

    const response = await execute(harness);
    assert.equal(response.status, 409);
    assert.equal(errorCode(response.body), "not_executable");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("409s `revoked` once the owner has revoked", async () => {
    const harness = await createHarness();
    await harness.agentStore.updateAgentStatus(
      ownerAccount.address,
      AGENT_ID,
      "revoked",
    );

    const response = await execute(harness);
    assert.equal(response.status, 409);
    assert.equal(errorCode(response.body), "revoked");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("re-checks the switch AFTER journal.begin, immediately before submit", async () => {
    const harness = await createHarness();
    // Let the FIRST kill-switch read pass and block every later one. That models
    // an operator's halt landing in the window between the pre-flight check and
    // the submit — the window this second check exists to close.
    let reads = 0;
    const realIsHalted = harness.killswitch.isHalted.bind(harness.killswitch);
    harness.killswitch.isHalted = async () => {
      reads += 1;
      // Allow the first check, block the second.
      return reads > 1;
    };

    const response = await execute(harness);
    assert.ok(reads >= 2, "the switch must be consulted more than once");
    assert.equal(response.status, 409);
    assert.equal(errorCode(response.body), "halted");
    assert.equal(
      harness.provider.executeCalls.length,
      0,
      "a halt landing after begin must still stop the submit",
    );

    harness.killswitch.isHalted = realIsHalted;
  });
});

/* -------------------------------------------------------------------------- */
/* bypassLocalPolicyCheck is structurally unreachable                         */
/* -------------------------------------------------------------------------- */

describe("execute — bypassLocalPolicyCheck cannot be set from a request", () => {
  const ATTEMPTS: Record<string, Record<string, unknown>> = {
    "top level": executeBody({ bypassLocalPolicyCheck: true }),
    "inside a call": executeBody({
      calls: [{ to: TARGET, value: "1000", bypassLocalPolicyCheck: true }],
    }),
    "nested under params": executeBody({
      params: { bypassLocalPolicyCheck: true },
    }),
    "nested under session": executeBody({
      session: { bypassLocalPolicyCheck: true },
    }),
    "snake case": executeBody({ bypass_local_policy_check: true }),
  };

  for (const [name, body] of Object.entries(ATTEMPTS)) {
    it(`ignores an attempt to set it at ${name}`, async () => {
      const harness = await createHarness();
      const response = await execute(harness, body);
      assert.equal(response.status, 200);

      const params = harness.provider.executeCalls[0];
      assert.notEqual(params, undefined);
      assert.equal(
        params?.bypassLocalPolicyCheck,
        false,
        "the flag must be the hard-coded false, whatever the request said",
      );
    });
  }

  it("passes through only `to`, `value` and `data` from each call", async () => {
    const harness = await createHarness();
    await execute(
      harness,
      executeBody({
        calls: [
          {
            to: TARGET,
            value: "1000",
            data: "0xdeadbeef",
            gas: "9999999",
            from: "0x" + "11".repeat(20),
            bypassLocalPolicyCheck: true,
          },
        ],
      }),
    );

    const submitted = harness.provider.executeCalls[0]?.calls[0];
    assert.deepEqual(submitted, {
      to: TARGET,
      value: 1000n,
      data: "0xdeadbeef",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Throttle                                                                   */
/* -------------------------------------------------------------------------- */

describe("execute — the per-agent throttle bounds a burst", () => {
  it("blocks a second submit inside the minimum interval", async () => {
    const harness = await createHarness({
      config: {
        throttle: { minIntervalMs: 10_000, maxPerWindow: 100, windowMs: 60_000 },
      },
    });

    const first = await execute(harness);
    const second = await execute(harness, executeBody({ decisionId: "decision-2" }));

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(errorCode(second.body), "throttled");
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("lets the next submit through once the interval has elapsed", async () => {
    const harness = await createHarness({
      config: {
        throttle: { minIntervalMs: 10_000, maxPerWindow: 100, windowMs: 60_000 },
      },
    });

    await execute(harness);
    harness.advance(10_001);
    const later = await execute(harness, executeBody({ decisionId: "decision-2" }));

    assert.equal(later.status, 200);
    assert.equal(harness.provider.executeCalls.length, 2);
  });

  it("caps how many executes one agent gets inside a rolling window", async () => {
    const harness = await createHarness({
      config: {
        throttle: { minIntervalMs: 0, maxPerWindow: 3, windowMs: 60_000 },
      },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await execute(harness, executeBody({ decisionId: `d-${i}` }));
      statuses.push(response.status);
    }

    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    assert.equal(harness.provider.executeCalls.length, 3);
  });

  it("throttles per agent, not globally", async () => {
    const harness = await createHarness({
      config: {
        throttle: { minIntervalMs: 10_000, maxPerWindow: 100, windowMs: 60_000 },
      },
    });

    await execute(harness);
    // A different agent (a different owner's) is unaffected.
    const other = await call(harness, "/agents/agent-2/execute", {
      method: "POST",
      body: executeBody({ decisionId: "decision-other" }),
    });
    assert.equal(other.status, 200);
  });
});

/* -------------------------------------------------------------------------- */
/* Input validation                                                           */
/* -------------------------------------------------------------------------- */

describe("execute — input validation", () => {
  it("rejects an empty calls array", async () => {
    const harness = await createHarness();
    const response = await execute(harness, executeBody({ calls: [] }));
    assert.equal(response.status, 400);
    assert.equal(errorCode(response.body), "invalid_request");
  });

  it(`rejects more than MAX_CALLS_PER_EXECUTE (${MAX_CALLS_PER_EXECUTE}) calls`, async () => {
    const harness = await createHarness();
    const calls = Array.from({ length: MAX_CALLS_PER_EXECUTE + 1 }, () => ({
      to: TARGET,
    }));
    const response = await execute(harness, executeBody({ calls }));
    assert.equal(response.status, 400);
    assert.equal(errorCode(response.body), "invalid_request");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("rejects a non-address target", async () => {
    const harness = await createHarness();
    const response = await execute(
      harness,
      executeBody({ calls: [{ to: "not-an-address" }] }),
    );
    assert.equal(response.status, 400);
  });

  it("rejects a value that is not a decimal string", async () => {
    const harness = await createHarness();
    const response = await execute(
      harness,
      executeBody({ calls: [{ to: TARGET, value: "0x10" }] }),
    );
    assert.equal(response.status, 400);
  });

  it("accepts a wei value far beyond Number.MAX_SAFE_INTEGER without loss", async () => {
    const harness = await createHarness();
    const huge = "123456789012345678901234567890";
    await execute(harness, executeBody({ calls: [{ to: TARGET, value: huge }] }));

    assert.equal(harness.provider.executeCalls[0]?.calls[0]?.value, BigInt(huge));
  });

  it("404s an unknown agent before doing anything else", async () => {
    const harness = await createHarness();
    const response = await call(harness, "/agents/ghost/execute", {
      method: "POST",
      body: executeBody(),
    });
    assert.equal(response.status, 404);
    assert.equal(errorCode(response.body), "not_found");
  });
});
