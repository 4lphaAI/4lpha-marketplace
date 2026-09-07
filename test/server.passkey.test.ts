/**
 * The passkey backend as the HTTP layer actually sees it.
 *
 * Three things are pinned here that a unit test on the verifier cannot pin:
 *
 *   - a passkey owner can drive a real owner READ and a real owner MUTATION end
 *     to end, against a row provisioned with `custodyModel: "passkey"` and the
 *     DERIVED owner address — the row-creation seam and the verifier agreeing on
 *     one identity is the whole phase;
 *   - `createServer`'s DEFAULT verifier flipped from bare secp256k1 to the
 *     dispatching one, and that flip changed nothing for secp256k1 owners. Every
 *     `test/audit.*.test.ts` runs against this default too (the harness injects
 *     no verifier), which is the actual regression claim for "the secp256k1 path
 *     is byte-for-byte 1b";
 *   - the wire budget. A realistic envelope has to FIT, in the header on reads
 *     and in the body on mutations, or owner actions turn into
 *     `owner_auth_failed` for a reason no log states.
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
  ownerAccount,
  sessionFacts,
  signOwnerAction,
  toReadHeader,
} from "./support/serverHarness.js";
import { DEFAULT_MAX_BODY_BYTES } from "../src/server.js";
import { MAX_OWNER_ENVELOPE_CHARS } from "../src/http/wire.js";
import {
  PASSKEY_CONFIG,
  createTestPasskey,
  signPasskeyOwnerAction,
  type PasskeyEnvelope,
  type TestPasskey,
} from "./support/passkey.js";
import type { Harness, SignedEnvelope } from "./support/serverHarness.js";

const PASSKEY_AGENT_ID = "agent-passkey";
/** A plausible passkey wallet: FINDINGS (a) — never the derived owner address. */
const PASSKEY_WALLET = getAddress("0x000000000000000000000000000000000000a11e");

/**
 * The three fields that actually cross the wire.
 *
 * The fixture carries the parsed struct and the raw assertion parts as well, and
 * neither belongs in a request: `message` holds bigints that `JSON.stringify`
 * refuses outright, which is a useful reminder that the wire form is the one
 * with decimal strings.
 */
function wire(envelope: PasskeyEnvelope): SignedEnvelope {
  return {
    signed: envelope.signed,
    signature: envelope.signature,
    params: envelope.params,
  };
}

async function harnessWithPasskeyAgent(): Promise<{
  harness: Harness;
  passkey: TestPasskey;
}> {
  const harness = await createHarness({ config: { passkey: PASSKEY_CONFIG } });
  const passkey = await createTestPasskey();
  await harness.agentStore.createAgent({
    id: PASSKEY_AGENT_ID,
    ownerAddress: passkey.ownerAddress,
    walletAddress: PASSKEY_WALLET,
    // What `scripts/register-passkey-agent.ts` writes. Never `self-eoa`.
    custodyModel: "passkey",
    sessionFacts: sessionFacts(NOW_SEC + 3_600),
    status: "armed",
  });
  return { harness, passkey };
}

describe("t11 — a passkey owner drives the real routes", () => {
  it("reads their own agent with an assertion in the x-owner-action header", async () => {
    const { harness, passkey } = await harnessWithPasskeyAgent();
    const envelope = await signPasskeyOwnerAction(
      passkey,
      "read",
      { scope: "agent", agentId: PASSKEY_AGENT_ID },
      { agentId: PASSKEY_AGENT_ID },
    );
    const response = await call(harness, `/agents/${PASSKEY_AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(wire(envelope)) },
    });
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["id"], PASSKEY_AGENT_ID);
    assert.equal(data["ownerAddress"], passkey.ownerAddress.toLowerCase());
    assert.equal(data["custodyModel"], "passkey");
  });

  it("pauses their own agent, and the nonce makes it single-use", async () => {
    const { harness, passkey } = await harnessWithPasskeyAgent();
    const envelope = await signPasskeyOwnerAction(passkey, "pause", {}, {
      agentId: PASSKEY_AGENT_ID,
    });
    const body = wire(envelope);
    const first = await call(harness, `/agents/${PASSKEY_AGENT_ID}/pause`, {
      method: "POST",
      body,
    });
    assert.equal(first.status, 200);
    assert.equal(
      (await harness.agentStore.getAgentById(PASSKEY_AGENT_ID))?.status,
      "paused",
    );

    // Byte-identical is a RETRY: it hashes to the same idempotency key, finds
    // the journal row, and returns the stored outcome without touching the
    // nonce. The passkey backend changes nothing about that contract.
    const replay = await call(harness, `/agents/${PASSKEY_AGENT_ID}/pause`, {
      method: "POST",
      body,
    });
    assert.equal(replay.status, 200);
    assert.equal(
      (replay.body["data"] as Record<string, unknown>)["replayed"],
      true,
    );
  });

  it("cannot reach another owner's agent — the derived address is the tenancy key", async () => {
    const { harness, passkey } = await harnessWithPasskeyAgent();
    // AGENT_ID belongs to the secp256k1 owner the harness seeds.
    const envelope = await signPasskeyOwnerAction(
      passkey,
      "read",
      { scope: "agent", agentId: AGENT_ID },
      { agentId: AGENT_ID },
    );
    const response = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(wire(envelope)) },
    });
    assert.equal(response.status, 404, "someone else's agent is indistinguishable from none");
    assert.equal(errorCode(response.body), "not_found");
  });

  it("R2d — the owner view marks a passkey ownerAddress as NOT payable", async () => {
    const { harness, passkey } = await harnessWithPasskeyAgent();
    const assertion = await signPasskeyOwnerAction(
      passkey,
      "read",
      { scope: "agent", agentId: PASSKEY_AGENT_ID },
      { agentId: PASSKEY_AGENT_ID },
    );
    const passkeyView = await call(harness, `/agents/${PASSKEY_AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(wire(assertion)) },
    });
    assert.equal(
      (passkeyView.body["data"] as Record<string, unknown>)["ownerAddressIsPayable"],
      false,
      "funds sent to a derived identity are burned; the UI must be able to see that",
    );

    const eoaView = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: {
        "x-owner-action": toReadHeader(
          await signOwnerAction("read", { scope: "agent", agentId: AGENT_ID }),
        ),
      },
    });
    assert.equal(
      (eoaView.body["data"] as Record<string, unknown>)["ownerAddressIsPayable"],
      true,
    );
  });
});

describe("t18 — the default verifier flip", () => {
  it("still verifies a 65-byte secp256k1 owner action with NO injected verifier", async () => {
    // The harness never injects a `verifier`, so this exercises `createServer`'s
    // own default — which is now the dispatching one.
    const harness = await createHarness();
    const response = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: await signOwnerAction("pause", {}),
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await harness.agentStore.getAgentById(AGENT_ID))?.ownerAddress,
      getAddress(ownerAccount.address).toLowerCase(),
    );
  });

  it("refuses a passkey envelope when the passkey config is absent", async () => {
    const harness = await createHarness();
    const passkey = await createTestPasskey();
    await harness.agentStore.createAgent({
      id: PASSKEY_AGENT_ID,
      ownerAddress: passkey.ownerAddress,
      walletAddress: PASSKEY_WALLET,
      custodyModel: "passkey",
      sessionFacts: sessionFacts(NOW_SEC + 3_600),
      status: "armed",
    });
    const envelope = await signPasskeyOwnerAction(passkey, "pause", {}, {
      agentId: PASSKEY_AGENT_ID,
    });
    const response = await call(harness, `/agents/${PASSKEY_AGENT_ID}/pause`, {
      method: "POST",
      body: {
        signed: envelope.signed,
        signature: envelope.signature,
        params: envelope.params,
      },
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
    assert.equal(
      (await harness.agentStore.getAgentById(PASSKEY_AGENT_ID))?.status,
      "armed",
      "a refused assertion must not have paused anything",
    );
  });
});

describe("t19 — the wire budget", () => {
  it("a realistic passkey envelope fits both the header cap and the body cap", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signPasskeyOwnerAction(
      passkey,
      "read",
      { scope: "agent", agentId: PASSKEY_AGENT_ID },
      {
        agentId: PASSKEY_AGENT_ID,
        // Chrome appends this filler to `clientDataJSON`; budget for it.
        clientData: {
          extraJson: `"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"`,
        },
      },
    );
    const header = toReadHeader({
      signed: envelope.signed,
      signature: envelope.signature,
      params: envelope.params,
    });
    const body = JSON.stringify({
      signed: envelope.signed,
      signature: envelope.signature,
      params: envelope.params,
    });

    // Pinned with the measured numbers, so an envelope change that blows the
    // header budget fails HERE instead of turning owner reads into
    // `owner_auth_failed`.
    assert.ok(
      header.length < MAX_OWNER_ENVELOPE_CHARS,
      `read header ${header.length} chars must fit ${MAX_OWNER_ENVELOPE_CHARS}`,
    );
    assert.ok(
      Buffer.byteLength(body, "utf8") < DEFAULT_MAX_BODY_BYTES,
      `mutation body ${Buffer.byteLength(body, "utf8")} bytes must fit ${DEFAULT_MAX_BODY_BYTES}`,
    );
    // Comfortable margin, not a squeak: at least half the budget spare.
    assert.ok(header.length < MAX_OWNER_ENVELOPE_CHARS / 2);
  });

  it("the envelope that fits actually authenticates over HTTP", async () => {
    const { harness, passkey } = await harnessWithPasskeyAgent();
    const envelope = await signPasskeyOwnerAction(
      passkey,
      "read",
      { scope: "agent", agentId: PASSKEY_AGENT_ID },
      {
        agentId: PASSKEY_AGENT_ID,
        clientData: {
          extraJson: `"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"`,
        },
      },
    );
    const response = await call(harness, `/agents/${PASSKEY_AGENT_ID}/owner-view`, {
      headers: { "x-owner-action": toReadHeader(wire(envelope)) },
    });
    assert.equal(response.status, 200);
  });
});
