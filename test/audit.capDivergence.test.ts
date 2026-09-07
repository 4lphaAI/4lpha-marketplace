/**
 * Auditor-written: the granted spec is a SNAPSHOT, and the chain moves on.
 *
 * PHASE2.3 R1 refuses a buy whose token has no spend cap, so an agent cannot
 * open a position it could never close. The question this file exists for is
 * WHERE that check reads its answer.
 *
 * `sessionFacts.spec` records the caps that existed at grant time and can never
 * be rewritten — `restoreSession` needs it byte-exact or the on-chain key hash
 * stops matching. But `setSpendLimit` lets the owner authorise a new token on a
 * LIVE session without re-granting (FINDINGS (i)), and that is the documented
 * route to anything that did not exist at hire — every launchpad token, by
 * definition.
 *
 * So the two diverge by design. Measured on the live mainnet wallet during this
 * audit: the persisted spec listed ONE cap while the account enforced SEVEN,
 * including every token the agent had just been used to trade. A gate reading
 * only the snapshot would have refused all six, and no action available to the
 * owner could have lifted it — they had already done the documented remediation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  AGENT_ID,
  TOKEN,
  call,
  createHarness,
  errorCode,
  safeSecurityPayload,
  tradeBody,
  type Harness,
} from "./support/serverHarness.js";

/** A token the harness's seeded grant does NOT carry a cap for. */
const UNGRANTED = getAddress("0x00000000000000000000000000000000000f00d1");

async function tradingHarness(): Promise<Harness> {
  const harness = await createHarness();
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  return harness;
}

async function buy(harness: Harness, token: string) {
  return call(harness, `/agents/${AGENT_ID}/trade`, {
    method: "POST",
    body: tradeBody({ token, side: "buy", amountWei: "1000" }),
  });
}

describe("audit: a cap the OWNER added after the grant must count", () => {
  it("refuses a buy when neither the grant nor the chain knows the token", async () => {
    const harness = await tradingHarness();
    const res = await buy(harness, UNGRANTED);

    assert.equal(res.status, 400);
    assert.equal(errorCode(res.body), "invalid_request");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("ALLOWS the buy once the chain reports a cap the grant never had", async () => {
    // This is the whole finding. The owner ran owner-add-spend-limit, the chain
    // accepted it, and the persisted spec cannot record it. If the gate reads
    // only the snapshot, the owner's remediation is inert.
    const harness = await tradingHarness();
    harness.provider.chainSellableTokens.add(UNGRANTED.toLowerCase());

    const res = await buy(harness, UNGRANTED);
    assert.equal(res.status, 200, res.text);
    assert.equal(
      harness.provider.executeCalls.length,
      1,
      "a token the owner authorised on chain must be buyable",
    );
  });

  it("does not spend a chain read when the grant already covers the token", async () => {
    // The snapshot is checked first precisely so the common case costs nothing.
    const harness = await tradingHarness();
    const res = await buy(harness, TOKEN);

    assert.equal(res.status, 200, res.text);
    assert.equal(
      harness.provider.spendCapReads.length,
      0,
      "the granted case must not pay for an RPC round trip",
    );
  });

  it("falls back to the grant when the chain read fails, and stays closed", async () => {
    // An RPC blip may narrow what the agent can reach; it must never widen it,
    // and it must never turn into a 500.
    const harness = await tradingHarness();
    harness.provider.spendCapReadError = new Error("rpc unreachable at https://secret.internal");

    const granted = await buy(harness, TOKEN);
    assert.equal(granted.status, 200, "the snapshot still permits what it granted");

    const ungranted = await buy(harness, UNGRANTED);
    assert.equal(ungranted.status, 400, "an unknown token stays refused");
    assert.equal(
      JSON.stringify(ungranted.body).includes("secret.internal"),
      false,
      "upstream error text must not reach the caller",
    );
  });

  it("never asks the chain for a SELL", async () => {
    // A sell is not gated at all — a pre-existing holding must stay exitable —
    // so the read would be pure cost.
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ token: UNGRANTED, side: "sell", amountWei: "5000" }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.spendCapReads.length, 0);
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("refuses when the chain has the LIMIT but not the approve rule", async () => {
    // The half grant, at the route. `owner-add-spend-limit` used to set only the
    // meter, so `spendInfos` listed the token and `canExecute(approve)` refused
    // — a buy that looked authorised and a sell that could never submit. The
    // provider answers the whole question, both halves, so half-authorised must
    // reach the route as a plain refusal.
    const harness = await tradingHarness();
    harness.provider.chainCappedNotSellableTokens.add(UNGRANTED.toLowerCase());

    const res = await buy(harness, UNGRANTED);
    assert.equal(res.status, 400, res.text);
    assert.equal(errorCode(res.body), "invalid_request");
    assert.equal(
      harness.provider.executeCalls.length,
      0,
      "a position that could not be closed must never be opened",
    );
  });

  it("asks about the RIGHT session key and wallet", async () => {
    // The account indexes limits per key. Reading another key's limits would
    // answer a question nobody asked.
    const harness = await tradingHarness();
    await buy(harness, UNGRANTED);

    const read = harness.provider.spendCapReads[0];
    assert.ok(read !== undefined, "the chain must have been consulted");
    const agent = await harness.agentStore.getAgentById(AGENT_ID);
    assert.equal(read.wallet.address, agent?.walletAddress);
    assert.equal(read.sessionPublicKey, agent?.sessionFacts?.publicKey);
  });
});
