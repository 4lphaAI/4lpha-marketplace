/**
 * The nonce ↔ idempotency contract, and revoke's honest half-completion.
 *
 * The ordering these tests pin is the one thing a naive implementation always
 * gets wrong, in one of two directions:
 *
 *   - consume the nonce first, and a client whose response was dropped can never
 *     safely retry — its second attempt looks exactly like a replay;
 *   - skip the nonce for anything that "looks like" a retry, and a genuine replay
 *     of a captured signature succeeds.
 *
 * Both are avoided by ORDER, not by inspection: journal lookup by
 * `ownerActionIdempotencyKey` FIRST (a row means retry — return the stored
 * outcome, touch nothing), and only with no row does the request reach
 * `authorizeOwnerAction`, which verifies and only then consumes. A replay of a
 * DIFFERENT signature carrying an already-spent nonce hashes to a different key,
 * finds no row, and is caught by `consume` returning false.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  AGENT_ID,
  NOW_SEC,
  call,
  createHarness,
  errorCode,
  freshNonce,
  ownerAccount,
  signOwnerAction,
  tradeBody,
} from "./support/serverHarness.js";
import { ownerActionIdempotencyKey } from "../src/auth/executeDecision.js";

describe("owner action — retry versus replay", () => {
  it("returns the stored outcome for an identical retry", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("pause", {});

    const first = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: envelope,
    });
    const second = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: envelope,
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200, "a dropped response must be safely retryable");
    const data = second.body["data"] as Record<string, unknown>;
    assert.equal(data["replayed"], true);
    assert.equal(data["state"], "COMMITTED");
  });

  it("does NOT re-consume the nonce on a retry", async () => {
    const harness = await createHarness();
    const nonce = freshNonce();
    const envelope = await signOwnerAction("pause", {}, { nonce });

    await call(harness, `/agents/${AGENT_ID}/pause`, { method: "POST", body: envelope });
    await call(harness, `/agents/${AGENT_ID}/pause`, { method: "POST", body: envelope });

    // The nonce was consumed exactly once. If the retry had re-consumed it, this
    // direct consume would still return false either way — so instead we assert
    // the store's own view: consuming it now must fail because the FIRST request
    // took it, and the retry must not have needed it at all.
    const stillFree = await harness.nonceStore.consume(
      ownerAccount.address,
      nonce,
      (NOW_SEC + 600) * 1000,
    );
    assert.equal(stillFree, false, "the first request consumed the nonce");
  });

  it("counts the nonce store's consumptions: exactly one across N retries", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("pause", {});

    let consumes = 0;
    const real = harness.nonceStore.consume.bind(harness.nonceStore);
    harness.nonceStore.consume = async (owner, nonce, expiresAt) => {
      consumes += 1;
      return real(owner, nonce, expiresAt);
    };

    for (let i = 0; i < 4; i += 1) {
      const response = await call(harness, `/agents/${AGENT_ID}/pause`, {
        method: "POST",
        body: envelope,
      });
      assert.equal(response.status, 200);
    }

    assert.equal(consumes, 1, "the journal must absorb every retry after the first");
  });

  it("REJECTS a different signature that reuses a consumed nonce", async () => {
    const harness = await createHarness();
    const nonce = freshNonce();

    const first = await signOwnerAction("pause", {}, { nonce });
    const accepted = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: first,
    });
    assert.equal(accepted.status, 200);

    // Same nonce, different signed struct (a different window), so a DIFFERENT
    // idempotency key: no journal row shields it, and the nonce store refuses.
    const replay = await signOwnerAction(
      "pause",
      {},
      { nonce, issuedAt: NOW_SEC + 1, expiry: NOW_SEC + 121 },
    );
    assert.notEqual(replay.signature, first.signature);

    const rejected = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: replay,
    });
    assert.equal(rejected.status, 401);
    assert.equal(errorCode(rejected.body), "owner_auth_failed");
  });

  it("looks the journal up BEFORE it verifies anything", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction("pause", {});

    // Seed the journal row by hand, then send a signature that would FAIL
    // verification (tampered). The journal lookup happens first, so the stored
    // outcome comes back and the broken signature is never reached.
    const key = ownerActionIdempotencyKey({
      owner: ownerAccount.address,
      agentId: AGENT_ID,
      action: "pause",
      paramsHash: envelope.signed["paramsHash"] as `0x${string}`,
      nonce: envelope.signed["nonce"] as `0x${string}`,
      issuedAt: BigInt(envelope.signed["issuedAt"] as string),
      expiry: BigInt(envelope.signed["expiry"] as string),
    });
    await harness.journal.begin({
      idempotencyKey: key,
      agentId: AGENT_ID,
      ownerAddress: getAddress(ownerAccount.address).toLowerCase(),
      kind: "pause",
    });

    const tampered = {
      ...envelope,
      signature: `0x${"00".repeat(65)}`,
    };
    const response = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: tampered,
    });

    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["replayed"], true);
  });

  it("leaves the nonce unspent when the per-owner rate limit refuses", async () => {
    const harness = await createHarness({
      config: { ownerRateLimit: { capacity: 1, refillPerSecond: 0.0001 } },
    });

    const first = await signOwnerAction("pause", {});
    assert.equal(
      (await call(harness, `/agents/${AGENT_ID}/pause`, { method: "POST", body: first }))
        .status,
      200,
    );

    const nonce = freshNonce();
    const limited = await signOwnerAction("unpause", {}, { nonce });
    const refused = await call(harness, `/agents/${AGENT_ID}/unpause`, {
      method: "POST",
      body: limited,
    });
    assert.equal(refused.status, 429);
    assert.equal(errorCode(refused.body), "rate_limited");

    // The nonce survived the refusal, so the owner can simply retry later.
    const unspent = await harness.nonceStore.consume(
      ownerAccount.address,
      nonce,
      (NOW_SEC + 600) * 1000,
    );
    assert.equal(unspent, true, "a rate-limited request must not burn the nonce");
  });
});

/* -------------------------------------------------------------------------- */
/* Effects                                                                    */
/* -------------------------------------------------------------------------- */

describe("owner action — effects", () => {
  it("pause sets both the kill switch and the agent status", async () => {
    const harness = await createHarness();
    await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: await signOwnerAction("pause", {}),
    });

    assert.equal(
      await harness.killswitch.isAgentPaused(AGENT_ID, ownerAccount.address),
      true,
    );
    const agent = await harness.agentStore.getAgentById(AGENT_ID);
    assert.equal(agent?.status, "paused");
  });

  it("unpause clears both", async () => {
    const harness = await createHarness();
    await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: await signOwnerAction("pause", {}),
    });
    await call(harness, `/agents/${AGENT_ID}/unpause`, {
      method: "POST",
      body: await signOwnerAction("unpause", {}),
    });

    assert.equal(
      await harness.killswitch.isAgentPaused(AGENT_ID, ownerAccount.address),
      false,
    );
    const agent = await harness.agentStore.getAgentById(AGENT_ID);
    assert.equal(agent?.status, "armed");
  });

  it("change-budget records the cap and says plainly that it is off-chain only", async () => {
    const harness = await createHarness();
    const params = { dailyNativeWei: "5000000000000000000" };
    const response = await call(harness, `/agents/${AGENT_ID}/change-budget`, {
      method: "POST",
      body: await signOwnerAction("changeBudget", params),
    });

    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["offChainOnly"], true);
    assert.match(String(data["note"]), /on-chain/i);

    const agent = await harness.agentStore.getAgentById(AGENT_ID);
    assert.equal(agent?.caps?.dailyNativeWei, 5_000_000_000_000_000_000n);
  });

  it("rejects malformed budget params AFTER a valid signature", async () => {
    const harness = await createHarness();
    const params = { dailyNativeWei: "not-a-number" };
    const response = await call(harness, `/agents/${AGENT_ID}/change-budget`, {
      method: "POST",
      body: await signOwnerAction("changeBudget", params),
    });
    assert.equal(response.status, 400);
    assert.equal(errorCode(response.body), "invalid_request");
  });
});

/* -------------------------------------------------------------------------- */
/* Revoke                                                                     */
/* -------------------------------------------------------------------------- */

describe("revoke — the guaranteed half and the honest half", () => {
  it("stops this server from submitting, immediately and durably", async () => {
    const harness = await createHarness();
    const response = await call(harness, `/agents/${AGENT_ID}/revoke`, {
      method: "POST",
      body: await signOwnerAction("revoke", {}),
    });
    assert.equal(response.status, 200);

    const agent = await harness.agentStore.getAgentById(AGENT_ID);
    assert.equal(agent?.status, "revoked");
    assert.equal(
      await harness.killswitch.isAgentPaused(AGENT_ID, ownerAccount.address),
      true,
    );

    // And the money path is actually closed.
    const attempted = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d", side: "sell" }),
    });
    assert.equal(attempted.status, 409);
    assert.equal(errorCode(attempted.body), "revoked");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("journals a revoke row so a crash mid-revoke reconciles", async () => {
    const harness = await createHarness();
    const response = await call(harness, `/agents/${AGENT_ID}/revoke`, {
      method: "POST",
      body: await signOwnerAction("revoke", {}),
    });

    const data = response.body["data"] as Record<string, unknown>;
    const entry = await harness.journal.get(data["idempotencyKey"] as string);
    assert.equal(entry?.kind, "revoke");
    assert.equal(entry?.state, "COMMITTED");
    // The public key is recorded so reconcile can check the session on-chain.
    assert.notEqual(entry?.externalRef.publicKey, undefined);
  });

  it("returns unsigned on-chain instructions and does NOT claim to have revoked", async () => {
    const harness = await createHarness();
    const response = await call(harness, `/agents/${AGENT_ID}/revoke`, {
      method: "POST",
      body: await signOwnerAction("revoke", {}),
    });

    const data = response.body["data"] as Record<string, unknown>;
    const onChain = data["onChainRevoke"] as Record<string, unknown>;
    assert.equal(onChain["state"], "pending_owner_broadcast");
    assert.equal(onChain["chainId"], 97);
    // The wording must not let a reader believe the chain was touched.
    assert.match(String(onChain["note"]), /has NOT revoked on-chain/);

    const calls = onChain["calls"] as Record<string, unknown>[];
    assert.equal(calls.length, 2, "an account-level leg and a KeyStore leg");
    // Leg 1 is a self-call from the wallet; leg 2 targets the KeyStore.
    assert.equal(calls[0]?.["to"], calls[0]?.["from"]);
    assert.equal(
      String(calls[1]?.["to"]).toLowerCase(),
      "0x00000000000000000000000000000000000000ff",
    );
    for (const leg of calls) {
      assert.match(String(leg["data"]), /^0x[0-9a-f]+$/i);
    }

    // The provider was never asked to broadcast anything.
    assert.equal(harness.provider.executeCalls.length, 0);
  });
});
