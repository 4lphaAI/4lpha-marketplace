/**
 * PHASE2.3 R1: the trade route refuses a BUY the session could never SELL.
 *
 * The defect this pins is FINDINGS (h), reproduced per token. A Pancake buy
 * needs no `approve`, so it succeeds for any token that clears the blacklist —
 * and the blacklist is a BLACKLIST, not a granted-token allowlist. The matching
 * sell then needs an `approve` with no per-token cap to meter against,
 * `GuardedExecutor` declines, and the trade returns `PENDING` with no
 * transaction and no gas. Silent, and indistinguishable from a slow relay.
 *
 * So the invariant is `buy => sellable`, enforced at step 1 against the
 * PERSISTED session facts. A SELL is deliberately not gated the same way: the
 * wallet IS the owner's own EOA and may hold a token from before the grant, so
 * refusing its exit would trap it — the reasoning of FINDINGS (s).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  HOP,
  NOW_SEC,
  OWNER_ADDRESS,
  SESSION_KEY,
  TEST_VENUES,
  TOKEN,
  call,
  createHarness,
  errorCode,
  safeSecurityPayload,
  tradeBody,
  type Harness,
} from "./support/serverHarness.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { validateSessionSpec } from "../src/core/session.js";

const ONE_BNB = 10n ** 18n;

/**
 * A token the seeded agent's session does NOT cap.
 *
 * `HOP` is an ordinary ERC-20 in the harness — not a venue, not the treasury,
 * not the wallet — so it clears `forbiddenTokenAddresses` and is refused (or
 * not) purely on the grant.
 */
const UNGRANTED = HOP;

async function tradingHarness(): Promise<Harness> {
  const harness = await createHarness();
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  return harness;
}

describe("PHASE2.3 R1: buy ⇒ sellable", () => {
  it("REFUSES a buy of a token with no per-token spend cap", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ token: UNGRANTED, amountWei: ONE_BNB.toString(10) }),
    });

    assert.equal(res.status, 400, res.text);
    assert.equal(errorCode(res.body), "invalid_request");
    assert.match(res.text, /spend cap/i);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses at step 1 — before the journal, the throttle and the scan gate", async () => {
    // The refusal must cost nothing: no journal row to bind the decisionId, no
    // throttle budget, and no data-plane read. Anything later would make a
    // structurally impossible trade expensive to discover.
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-ungranted", token: UNGRANTED }),
    });

    assert.equal(res.status, 400, res.text);
    assert.deepEqual(harness.dataPlane.requested, []);
    assert.equal(await harness.journal.getByDecision(AGENT_ID, "d-ungranted"), null);
  });

  it("still admits a buy of a token the session DOES cap", async () => {
    // The counterweight: if the gate matched nothing, the case above would pass
    // for the wrong reason.
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ token: TOKEN, amountWei: ONE_BNB.toString(10) }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("does NOT gate a SELL — a pre-existing holding stays exitable", async () => {
    // The wallet is the owner's own EOA. A token bought before the session was
    // granted, or airdropped into it, has no cap and never will until the owner
    // adds one (FINDINGS i) — and refusing the exit would trap it. The sell may
    // still fail on chain for want of a cap; that is the chain's answer to give,
    // and it is not a reason to refuse the attempt.
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "sell", token: UNGRANTED, amountWei: "5000" }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("gates every venue's buy, not just pancake", async () => {
    for (const venue of ["pancake", "pancake_v3", "fourmeme"] as const) {
      const harness = await tradingHarness();
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({
          venue,
          token: UNGRANTED,
          ...(venue === "pancake_v3" ? { route: { hops: [], fees: [2500] } } : {}),
        }),
      });
      assert.equal(res.status, 400, `${venue}: ${res.text}`);
      // The GRANT is what refused it, not a venue-configuration 400: every
      // venue in the harness is wired.
      assert.match(res.text, /spend cap/i, venue);
      assert.equal(harness.provider.executeCalls.length, 0, venue);
    }
  });
});

describe("PHASE2.3: provisioning wires the token list end to end", () => {
  it("a row provisioned from the REAL template can buy its granted token", async () => {
    // template -> persisted sessionFacts -> the route's R1 gate, with nothing
    // hand-written in between. This is the wiring `scripts/provision-agent.ts`
    // performs, minus the chain: `tradeSessionSpec` emits the approve rule and
    // the cap together, `validateSessionSpec` derives the canonical
    // permissions, and the row carries both byte-exact.
    const harness = await tradingHarness();
    const spec = tradeSessionSpec({
      venues: TEST_VENUES,
      tokens: [{ token: UNGRANTED }],
      nativeCaps: [{ limit: ONE_BNB, period: "day" }],
      expiresAt: NOW_SEC + 3_600,
      nowSeconds: NOW_SEC,
    });

    // The persisted facts carry the per-token cap, which is the whole point.
    assert.ok(spec.spendCaps.some((cap) => cap.token === UNGRANTED));

    const id = "agent-provisioned";
    await harness.agentStore.createAgent({
      httpRuntimeProfile: "trade-v1",
      id,
      ownerAddress: OWNER_ADDRESS,
      walletAddress: OWNER_ADDRESS,
      custodyModel: "self-eoa",
      sessionFacts: {
        spec,
        permissions: validateSessionSpec(spec, { nowSeconds: NOW_SEC }),
        publicKey: `0x04${"ab".repeat(64)}`,
        expiry: spec.expiresAt,
      },
      status: "armed",
    });
    await harness.agentStore.putAgentSessionKey(OWNER_ADDRESS, id, SESSION_KEY);

    const res = await call(harness, `/agents/${id}/trade`, {
      method: "POST",
      body: tradeBody({ token: UNGRANTED, amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.executeCalls.length, 1);

    // And the token the template was NOT given remains un-buyable on that row.
    const refused = await call(harness, `/agents/${id}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-other", token: TOKEN }),
    });
    assert.equal(refused.status, 400, refused.text);
  });
});
