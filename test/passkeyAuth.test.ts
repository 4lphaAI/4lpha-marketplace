/**
 * Adversarial tests for the passkey (WebAuthn/P-256) owner-auth backend.
 *
 * ALL OFFLINE, and all of the cryptography is REAL: `node:crypto`'s webcrypto
 * generates genuine P-256 keypairs and signs genuine assertion bases, so a
 * fixture that "verifies" verified against the same primitive production uses.
 * Nothing here mocks a verifier.
 *
 * Each block maps to a claim the design rests on, and several exist specifically
 * to pin a RUNTIME property that is relied on rather than guaranteed — WebCrypto
 * `raw` import validation, OpenSSL's signature-range rejection, and viem's
 * exact-65-byte secp256k1 guard. If a dependency ever stops holding one of
 * those, a test here fails instead of the authorization layer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { webcrypto } from "node:crypto";
import {
  concat,
  encodeAbiParameters,
  getAddress,
  keccak256,
  size,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  OWNER_ACTION_TYPES,
  OwnerAuthError,
  authorizeOwnerAction,
  secp256k1Verifier,
  verifyOwnerAction,
  type OwnerActionStruct,
} from "../src/auth/ownerAuth.js";
import {
  PASSKEY_DISABLED,
  createDispatchingVerifier,
  createWebAuthnVerifier,
} from "../src/auth/passkeyVerifier.js";
import {
  MAX_AUTHENTICATOR_DATA_BYTES,
  MAX_CLIENT_DATA_BYTES,
  MIN_WEBAUTHN_ENVELOPE_BYTES,
  WEBAUTHN_ENVELOPE_PARAMS,
  decodeBase64UrlStrict,
  decodeWebAuthnEnvelope,
  derToP1363,
  encodeBase64Url,
  encodeWebAuthnEnvelope,
  ownerActionChallenge,
  ownerActionChallengeBytes,
  passkeyOwnerAddress,
} from "../src/auth/webauthnEnvelope.js";
import { MemoryNonceStore } from "../src/store/nonces.js";
import { paramsHash } from "../src/auth/canonical.js";
import { AGENT_ID, CHAIN_ID, NETWORK, NOW_SEC, freshNonce } from "./support/serverHarness.js";
import {
  DEFAULT_FLAGS,
  EVIL_ORIGIN,
  FLAG_AT,
  FLAG_BS,
  FLAG_ED,
  FLAG_UP,
  FLAG_UV,
  ORIGIN,
  PASSKEY_CONFIG,
  buildAuthenticatorData,
  buildClientData,
  createTestPasskey,
  domainFor,
  signAssertion,
  signPasskeyOwnerAction,
  type PasskeyEnvelope,
  type PasskeySignOptions,
  type TestPasskey,
} from "./support/passkey.js";

const verifier = createWebAuthnVerifier(PASSKEY_CONFIG);

/** The one public message every rejection must carry, whatever went wrong. */
const GENERIC = "Owner authorization failed.";

/**
 * Assert a refusal, and assert it was the RIGHT refusal.
 *
 * The public message is checked to be the single generic string — that is the
 * indistinguishable-failures contract. The internal reason is checked so the
 * test proves the intended check fired rather than any check at all; it is
 * server-side only and never reaches a client.
 */
async function assertRefused(
  run: () => Promise<unknown>,
  expectedInternal: RegExp,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof OwnerAuthError, `expected OwnerAuthError, got ${String(error)}`);
    assert.equal(error.message, GENERIC);
    assert.match(error.internalReason, expectedInternal);
    return true;
  });
}

function recover(envelope: PasskeyEnvelope): Promise<unknown> {
  return verifier.recover({
    domain: envelope.domain,
    message: envelope.message,
    signature: envelope.signature,
  });
}

async function signed(
  passkey: TestPasskey,
  options: PasskeySignOptions = {},
): Promise<PasskeyEnvelope> {
  return signPasskeyOwnerAction(passkey, "pause", { reason: "test" }, options);
}

/* -------------------------------------------------------------------------- */
/* Happy path                                                                 */
/* -------------------------------------------------------------------------- */

describe("passkey owner auth — the path that must work", () => {
  it("verifies a real assertion and derives the owner from the carried key", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey);
    assert.equal(await recover(envelope), passkey.ownerAddress);
  });

  it("t11 — runs end to end through authorizeOwnerAction, consuming the nonce once", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey);
    const nonceStore = new MemoryNonceStore();
    const options = {
      now: NOW_SEC,
      expectedChainId: CHAIN_ID,
      network: NETWORK,
      verifier,
      nonceStore,
    };
    const result = await authorizeOwnerAction(
      { signed: envelope.message, signature: envelope.signature, params: envelope.params },
      options,
    );
    assert.equal(result.ownerAddress, passkey.ownerAddress);
    assert.equal(result.action, "pause");
    assert.equal(result.agentId, AGENT_ID);

    // The exact same envelope again is a replay, and dies on the nonce.
    await assertRefused(
      () =>
        authorizeOwnerAction(
          { signed: envelope.message, signature: envelope.signature, params: envelope.params },
          options,
        ),
      /Nonce already consumed/,
    );
  });

  it("accepts an ED-flagged assertion longer than 37 bytes", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, {
      authenticatorData: {
        flags: DEFAULT_FLAGS | FLAG_ED,
        extra: new Uint8Array([0xa0, 0x00, 0x01, 0x02]),
      },
    });
    assert.equal(await recover(envelope), passkey.ownerAddress);
  });

  it("accepts a device-bound (BE=0) credential as well as a synced one", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, {
      authenticatorData: { flags: FLAG_UP | FLAG_UV },
    });
    assert.equal(await recover(envelope), passkey.ownerAddress);
  });
});

/* -------------------------------------------------------------------------- */
/* R11 — the derivation is persisted identity                                 */
/* -------------------------------------------------------------------------- */

describe("owner-address derivation", () => {
  it("GOLDEN VECTOR — changing this orphans every provisioned passkey agent", () => {
    // Hardcoded on both sides ON PURPOSE. This address is written into agent
    // rows, kill-switch pause records, journal rows and nonce keys; if the tag,
    // the hash, the byte order or the slice ever changes, every existing passkey
    // owner silently becomes a different owner and every one of their agents
    // becomes unreachable behind a generic auth failure.
    const x = `0x${"01".repeat(32)}` as Hex;
    const y = `0x${"02".repeat(32)}` as Hex;
    assert.equal(
      passkeyOwnerAddress(x, y),
      "0x977afcf8E54308623d3620aEEbB08690FEe39d6c",
    );
  });

  it("returns an EIP-55 checksummed address the agent store will accept", () => {
    const address = passkeyOwnerAddress(`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`);
    assert.equal(getAddress(address), address);
  });

  it("is domain-separated from the secp256k1 derivation of the same key", () => {
    // `keccak(x‖y)[12..]` IS the secp256k1 address derivation. The tag is what
    // keeps an identity from ever colliding with an account by construction,
    // rather than by a comment.
    const x = `0x${"01".repeat(32)}` as Hex;
    const y = `0x${"02".repeat(32)}` as Hex;
    const untagged = getAddress(`0x${keccak256(concat([x, y])).slice(26)}` as Hex);
    assert.notEqual(untagged, passkeyOwnerAddress(x, y));
  });

  it("refuses coordinates that are not exactly 32 bytes", () => {
    assert.throws(() => passkeyOwnerAddress(`0x${"01".repeat(31)}`, `0x${"02".repeat(32)}`));
    assert.throws(() => passkeyOwnerAddress(`0x${"01".repeat(32)}`, `0x${"02".repeat(33)}`));
  });
});

/* -------------------------------------------------------------------------- */
/* R6 step 2 — clientDataJSON                                                 */
/* -------------------------------------------------------------------------- */

describe("clientDataJSON checks", () => {
  it("t1 — refuses an origin that is not in the allowlist", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, {
      clientData: { origin: "https://other.example" },
    });
    await assertRefused(() => recover(envelope), /origin is not an allowlisted origin/);
  });

  it("t1b — refuses an origin that merely CONTAINS an allowlisted one", async () => {
    // `https://evil-4lpha.app` must not pass an allowlist holding
    // `https://4lpha.app`. Exact membership, no substring or suffix logic.
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, { clientData: { origin: EVIL_ORIGIN } });
    await assertRefused(() => recover(envelope), /origin is not an allowlisted origin/);
    const suffixed = await signed(passkey, {
      clientData: { origin: `${ORIGIN}.evil.example` },
    });
    await assertRefused(() => recover(suffixed), /origin is not an allowlisted origin/);
  });

  it("t4 — refuses an attestation (type webauthn.create)", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, {
      clientData: { type: "webauthn.create" },
    });
    await assertRefused(() => recover(envelope), /type is not webauthn\.get/);
  });

  it("t5 — refuses crossOrigin: true and any present topOrigin", async () => {
    const passkey = await createTestPasskey();
    const crossOrigin = await signed(passkey, { clientData: { crossOrigin: true } });
    await assertRefused(() => recover(crossOrigin), /crossOrigin is set/);
    const topOrigin = await signed(passkey, {
      clientData: { crossOrigin: false, topOrigin: "https://embedder.example" },
    });
    await assertRefused(() => recover(topOrigin), /topOrigin is present/);
  });

  it("accepts crossOrigin: false and an absent crossOrigin alike", async () => {
    const passkey = await createTestPasskey();
    assert.equal(
      await recover(await signed(passkey, { clientData: { crossOrigin: false } })),
      passkey.ownerAddress,
    );
  });

  it("t16 — refuses clientDataJSON that parses to something other than an object", async () => {
    const passkey = await createTestPasskey();
    for (const raw of ["123", "null", "[]", `"webauthn.get"`]) {
      const authenticatorData = buildAuthenticatorData();
      const clientDataJSON = new TextEncoder().encode(raw);
      const { r, s } = await signAssertion(passkey, authenticatorData, clientDataJSON);
      const signature = encodeWebAuthnEnvelope({
        x: passkey.x,
        y: passkey.y,
        authenticatorData,
        clientDataJSON,
        r,
        s,
      });
      await assertRefused(
        () =>
          verifier.recover({
            domain: domainFor(),
            message: messageFor(passkey),
            signature,
          }),
        /clientDataJSON is not a JSON object/,
      );
    }
  });

  it("t16 — refuses clientDataJSON that is not valid JSON at all", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, { clientData: { raw: "{not json" } });
    await assertRefused(() => recover(envelope), /not valid JSON/);
  });

  it("t16 — a duplicate key resolves LAST-WINS, pinned as a decision", async () => {
    const passkey = await createTestPasskey();
    const domain = domainFor();
    const message = messageFor(passkey);
    const good = ownerActionChallenge({ domain, message });

    // Correct challenge LAST: `JSON.parse` keeps the last occurrence, so it
    // verifies. This is documented behaviour, not luck.
    const lastWins = await buildEnvelope(passkey, {
      raw: `{"type":"webauthn.get","challenge":"AAAA","origin":${JSON.stringify(
        ORIGIN,
      )},"challenge":${JSON.stringify(good)}}`,
    });
    assert.equal(
      await verifier.recover({ domain, message, signature: lastWins }),
      passkey.ownerAddress,
    );

    // Correct challenge FIRST, garbage last: refused, for the same reason.
    const firstLoses = await buildEnvelope(passkey, {
      raw: `{"type":"webauthn.get","challenge":${JSON.stringify(
        good,
      )},"origin":${JSON.stringify(ORIGIN)},"challenge":"AAAA"}`,
    });
    await assertRefused(
      () => verifier.recover({ domain, message, signature: firstLoses }),
      /challenge is not 32 bytes|challenge does not bind/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R3 / R14-t20 — the challenge                                               */
/* -------------------------------------------------------------------------- */

describe("challenge binding", () => {
  it("t3 — an assertion made for one action does not authorize another", async () => {
    const passkey = await createTestPasskey();
    // Signed for `pause`, presented as `revoke` with revoke's params.
    const envelope = await signPasskeyOwnerAction(passkey, "pause", { reason: "a" });
    const swapped: OwnerActionStruct = {
      ...envelope.message,
      action: "revoke",
      paramsHash: paramsHash("revoke", { reason: "a" }),
    };
    await assertRefused(
      () =>
        verifier.recover({
          domain: envelope.domain,
          message: swapped,
          signature: envelope.signature,
        }),
      /challenge does not bind this owner action/,
    );
  });

  it("t12 — an assertion made under a different chainId is refused", async () => {
    // THE direct authenticity test for this backend: the challenge is recomputed
    // from the domain the SERVER built, so a chain-97 assertion presented to a
    // chain-56 server carries a different challenge and dies before the owner
    // match — no address-collision argument involved.
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, { chainId: 97, network: "testnet" });
    await assertRefused(
      () =>
        verifier.recover({
          domain: domainFor({ chainId: 56, network: "mainnet" }),
          message: envelope.message,
          signature: envelope.signature,
        }),
      /challenge does not bind this owner action/,
    );
  });

  it("t12 — an assertion made under a different environment salt is refused", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, { envSalt: "staging" });
    await assertRefused(
      () =>
        verifier.recover({
          domain: domainFor({ envSalt: "production" }),
          message: envelope.message,
          signature: envelope.signature,
        }),
      /challenge does not bind this owner action/,
    );
  });

  it("t20 — accepts a PADDED challenge and refuses a 31- or 33-byte decode", async () => {
    const passkey = await createTestPasskey();
    const domain = domainFor();
    const message = messageFor(passkey);
    const expected = ownerActionChallengeBytes({ domain, message });

    const padded = `${encodeBase64Url(expected)}=`;
    const paddedEnvelope = await buildEnvelope(passkey, {
      challenge: padded,
    });
    assert.equal(
      await verifier.recover({ domain, message, signature: paddedEnvelope }),
      passkey.ownerAddress,
    );

    for (const wrong of [expected.subarray(0, 31), concat32Plus(expected)]) {
      const envelope = await buildEnvelope(passkey, {
        challenge: encodeBase64Url(wrong),
      });
      await assertRefused(
        () => verifier.recover({ domain, message, signature: envelope }),
        /challenge is not 32 bytes/,
      );
    }
  });

  it("t20 — refuses a challenge spelled in the standard base64 alphabet", async () => {
    // `Buffer.from(s, "base64url")` is lenient: it tolerates `+/` and silently
    // drops invalid characters, so a string compare and a byte compare are not
    // the same check. This pins the strict decoder.
    const passkey = await createTestPasskey();
    const domain = domainFor();
    const message = messageFor(passkey);
    const good = ownerActionChallenge({ domain, message });
    const mangled = `+${good.slice(1)}`;
    const envelope = await buildEnvelope(passkey, { challenge: mangled });
    await assertRefused(
      () => verifier.recover({ domain, message, signature: envelope }),
      /challenge is not base64url|challenge does not bind/,
    );
  });

  it("strict base64url decoding rejects what Buffer would silently accept", () => {
    assert.equal(decodeBase64UrlStrict("QQ+="), null, "standard-alphabet '+'");
    assert.equal(decodeBase64UrlStrict("QQ/="), null, "standard-alphabet '/'");
    assert.equal(decodeBase64UrlStrict("Q Q"), null, "whitespace");
    assert.equal(decodeBase64UrlStrict("QQ=Q"), null, "interior padding");
    assert.equal(decodeBase64UrlStrict("Q"), null, "impossible length");
    // Non-zero trailing bits are a SECOND spelling of the same bytes.
    assert.deepEqual(decodeBase64UrlStrict("QQ"), Uint8Array.from([0x41]));
    assert.equal(decodeBase64UrlStrict("QR"), null, "non-canonical trailing bits");
  });
});

/* -------------------------------------------------------------------------- */
/* R6 step 3 — authenticatorData                                              */
/* -------------------------------------------------------------------------- */

describe("authenticatorData checks", () => {
  it("t2 — refuses an assertion made at a different RP ID", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, {
      authenticatorData: { rpId: "evil.example" },
    });
    await assertRefused(() => recover(envelope), /rpIdHash does not match/);
  });

  it("t6 — refuses a UV-clear assertion while UV is required", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, {
      authenticatorData: { flags: FLAG_UP },
    });
    await assertRefused(() => recover(envelope), /user-verified flag is clear/);
  });

  it("t6 — accepts the same assertion when UV is not required", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, { authenticatorData: { flags: FLAG_UP } });
    const relaxed = createWebAuthnVerifier({ ...PASSKEY_CONFIG, uvRequired: false });
    assert.equal(
      await relaxed.recover({
        domain: envelope.domain,
        message: envelope.message,
        signature: envelope.signature,
      }),
      passkey.ownerAddress,
    );
  });

  it("t17 — refuses UP clear even when UV is set", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, { authenticatorData: { flags: FLAG_UV } });
    await assertRefused(() => recover(envelope), /user-present flag is clear/);
  });

  it("t17 — refuses the AT flag, the byte-level counterpart of webauthn.create", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, {
      authenticatorData: { flags: DEFAULT_FLAGS | FLAG_AT },
    });
    await assertRefused(() => recover(envelope), /attested-credential-data flag/);
  });

  it("t17 — refuses BE=0 with BS=1", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, {
      authenticatorData: { flags: FLAG_UP | FLAG_UV | FLAG_BS },
    });
    await assertRefused(() => recover(envelope), /backup-state flag is set/);
  });

  it("t17 — refuses a longer-than-37-byte blob with ED clear", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey, {
      authenticatorData: { extra: new Uint8Array([0, 0, 0]) },
    });
    await assertRefused(() => recover(envelope), /longer than 37 bytes/);
  });

  it("refuses a truncated authenticatorData", async () => {
    const passkey = await createTestPasskey();
    const domain = domainFor();
    const message = messageFor(passkey);
    const authenticatorData = buildAuthenticatorData().subarray(0, 30);
    const clientDataJSON = buildClientData({
      challenge: ownerActionChallenge({ domain, message }),
    });
    const { r, s } = await signAssertion(passkey, authenticatorData, clientDataJSON);
    const signature = encodeWebAuthnEnvelope({
      x: passkey.x,
      y: passkey.y,
      authenticatorData,
      clientDataJSON,
      r,
      s,
    });
    await assertRefused(
      () => verifier.recover({ domain, message, signature }),
      /authenticatorData is too short/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R6 steps 4-5 — key import and signature, pinned on the target runtime       */
/* -------------------------------------------------------------------------- */

describe("key import and signature validation", () => {
  it("t13 — refuses an off-curve point, (0,0), and an out-of-range x", async () => {
    const passkey = await createTestPasskey();
    const domain = domainFor();
    const message = messageFor(passkey);
    const cases: readonly (readonly [string, Hex, Hex])[] = [
      ["off-curve", passkey.x, flipLastByte(passkey.y)],
      ["zero point", `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`],
      ["x >= p", `0x${"ff".repeat(32)}`, passkey.y],
    ];
    for (const [label, x, y] of cases) {
      const signature = await buildEnvelopeWithKey(passkey, message, domain, x, y);
      await assert.rejects(
        () => verifier.recover({ domain, message, signature }),
        (error: unknown) => {
          assert.ok(error instanceof OwnerAuthError, label);
          assert.equal(error.message, GENERIC);
          assert.match(error.internalReason, /not a valid P-256 point/, label);
          return true;
        },
      );
    }
  });

  it("t13 — the pinned importKey call is what does that validation", async () => {
    // Directly measured, so this stays true only for the exact format the
    // verifier uses: uncompressed SEC1, `raw`, P-256.
    const passkey = await createTestPasskey();
    const bad = new Uint8Array(65);
    bad[0] = 0x04;
    await assert.rejects(
      webcrypto.subtle.importKey(
        "raw",
        bad,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      ),
    );
    assert.ok(passkey.x.length === 66);
  });

  it("t14 — refuses r = 0 and s >= n (the OpenSSL property this relies on)", async () => {
    const passkey = await createTestPasskey();
    const domain = domainFor();
    const message = messageFor(passkey);
    const authenticatorData = buildAuthenticatorData();
    const clientDataJSON = buildClientData({
      challenge: ownerActionChallenge({ domain, message }),
    });
    const { r, s } = await signAssertion(passkey, authenticatorData, clientDataJSON);
    const N = "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551" as Hex;

    for (const [badR, badS] of [
      [`0x${"00".repeat(32)}` as Hex, s],
      [r, N],
      [r, `0x${"00".repeat(32)}` as Hex],
    ] as const) {
      const signature = encodeWebAuthnEnvelope({
        x: passkey.x,
        y: passkey.y,
        authenticatorData,
        clientDataJSON,
        r: badR,
        s: badS,
      });
      await assertRefused(
        () => verifier.recover({ domain, message, signature }),
        /signature does not verify/,
      );
    }
  });

  it("t7 — a victim's public key with an attacker's signature fails the verify", async () => {
    const victim = await createTestPasskey();
    const attacker = await createTestPasskey();
    const envelope = await signed(attacker, { carryKeyOf: victim, signWith: attacker });
    await assertRefused(() => recover(envelope), /signature does not verify/);
  });

  it("t7 — an attacker's key under a victim's declared owner fails the owner match", async () => {
    const victim = await createTestPasskey();
    const attacker = await createTestPasskey();
    // Genuinely signed by the attacker, carrying the attacker's key, but the
    // struct claims the victim owns it. The challenge covers `signed.owner`, so
    // the attacker must sign the victim's claim — and then the derived address
    // is still the attacker's.
    const envelope = await signed(attacker, { owner: victim.ownerAddress });
    await assertRefused(
      () =>
        verifyOwnerAction(
          { signed: envelope.message, signature: envelope.signature, params: envelope.params },
          { now: NOW_SEC, expectedChainId: CHAIN_ID, network: NETWORK, verifier },
        ),
      /does not match declared owner/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R7 — the envelope has exactly one encoding                                 */
/* -------------------------------------------------------------------------- */

describe("envelope canonicality", () => {
  it("t15 — refuses trailing bytes appended to a valid envelope", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey);
    const padded = `${envelope.signature}ffff` as Hex;
    await assertRefused(
      () =>
        verifier.recover({
          domain: envelope.domain,
          message: envelope.message,
          signature: padded,
        }),
      /not canonical/,
    );
  });

  it("t15 — refuses two dynamic heads aliased onto one tail", () => {
    const head = [
      "11".repeat(32),
      "22".repeat(32),
      (6 * 32).toString(16).padStart(64, "0"),
      (6 * 32).toString(16).padStart(64, "0"),
      "33".repeat(32),
      "44".repeat(32),
    ].join("");
    const tail = (4).toString(16).padStart(64, "0") + "deadbeef".padEnd(64, "0");
    assert.throws(
      () => decodeWebAuthnEnvelope(`0x${head}${tail}` as Hex),
      /not canonical/,
    );
  });

  it("t15 — refuses a non-minimal offset", () => {
    // Same tuple, but the first tail starts 32 bytes later than it needs to.
    const gap = "00".repeat(32);
    const head = [
      "11".repeat(32),
      "22".repeat(32),
      (7 * 32).toString(16).padStart(64, "0"),
      (9 * 32).toString(16).padStart(64, "0"),
      "33".repeat(32),
      "44".repeat(32),
    ].join("");
    const tail1 = (4).toString(16).padStart(64, "0") + "deadbeef".padEnd(64, "0");
    const tail2 = (4).toString(16).padStart(64, "0") + "cafebabe".padEnd(64, "0");
    assert.throws(
      () => decodeWebAuthnEnvelope(`0x${head}${gap}${tail1}${tail2}` as Hex),
      /not canonical/,
    );
  });

  it("t8 — refuses oversized tails at the decoder, unreachable though they are over HTTP", () => {
    const huge = encodeAbiParameters(WEBAUTHN_ENVELOPE_PARAMS, [
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
      toHex(new Uint8Array(MAX_AUTHENTICATOR_DATA_BYTES + 1)),
      toHex(new Uint8Array(8)),
      `0x${"33".repeat(32)}`,
      `0x${"44".repeat(32)}`,
    ]);
    assert.throws(() => decodeWebAuthnEnvelope(huge), /authenticatorData exceeds/);

    const hugeClient = encodeAbiParameters(WEBAUTHN_ENVELOPE_PARAMS, [
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
      toHex(new Uint8Array(8)),
      toHex(new Uint8Array(MAX_CLIENT_DATA_BYTES + 1)),
      `0x${"33".repeat(32)}`,
      `0x${"44".repeat(32)}`,
    ]);
    assert.throws(() => decodeWebAuthnEnvelope(hugeClient), /clientDataJSON exceeds/);
  });

  it("round-trips a real envelope through encode and decode", async () => {
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey);
    const decoded = decodeWebAuthnEnvelope(envelope.signature);
    assert.equal(decoded.x, passkey.x);
    assert.equal(decoded.y, passkey.y);
    assert.deepEqual(decoded.authenticatorData, envelope.authenticatorData);
    assert.deepEqual(decoded.clientDataJSON, envelope.clientDataJSON);
    assert.equal(decoded.signature.length, 64);
  });
});

/* -------------------------------------------------------------------------- */
/* R10 — dispatch, pinned on both sides                                       */
/* -------------------------------------------------------------------------- */

describe("dispatch between the two backends", () => {
  it("t8/R10 — the minimum valid envelope encoding is 256 bytes, never 65", () => {
    const minimum = encodeAbiParameters(WEBAUTHN_ENVELOPE_PARAMS, [
      `0x${"00".repeat(32)}`,
      `0x${"00".repeat(32)}`,
      "0x",
      "0x",
      `0x${"00".repeat(32)}`,
      `0x${"00".repeat(32)}`,
    ]);
    assert.equal(size(minimum), MIN_WEBAUTHN_ENVELOPE_BYTES);
    assert.equal(MIN_WEBAUTHN_ENVELOPE_BYTES, 256);
  });

  it("R10 — the secp256k1 path itself refuses 64- and 66-byte signatures", async () => {
    // The OTHER half of the coupling. viem's `recoverPublicKey` throws unless the
    // signature is exactly 65 bytes; if a viem bump ever widened that (accepting
    // an ERC-2098 compact signature, say), THIS test fails rather than the
    // dispatch silently diverting those inputs to the WebAuthn branch.
    const message = messageFor(await createTestPasskey());
    for (const length of [64, 66]) {
      await assert.rejects(
        secp256k1Verifier.recover({
          domain: domainFor(),
          message,
          signature: `0x${"ab".repeat(length)}` as Hex,
        }),
      );
    }
  });

  it("R10 — 65 bytes goes to secp256k1; anything else goes to the WebAuthn branch", async () => {
    const dispatching = createDispatchingVerifier(PASSKEY_DISABLED);
    const message = messageFor(await createTestPasskey());
    const domain = domainFor();

    // 65 bytes reaches viem, which fails on its own terms — NOT with the
    // disabled-passkey refusal.
    await assert.rejects(
      dispatching.recover({ domain, message, signature: `0x${"ab".repeat(65)}` as Hex }),
      (error: unknown) => !(error instanceof OwnerAuthError),
    );

    // 64 and 66 bytes reach the WebAuthn branch, which is switched off.
    for (const length of [64, 66]) {
      await assertRefused(
        () =>
          dispatching.recover({
            domain,
            message,
            signature: `0x${"ab".repeat(length)}` as Hex,
          }),
        /Passkey backend is disabled/,
      );
    }
  });

  it("t10 — with passkeys disabled a VALID assertion is refused and secp still verifies", async () => {
    const dispatching = createDispatchingVerifier(PASSKEY_DISABLED);
    const passkey = await createTestPasskey();
    const envelope = await signed(passkey);
    await assertRefused(
      () =>
        dispatching.recover({
          domain: envelope.domain,
          message: envelope.message,
          signature: envelope.signature,
        }),
      /Passkey backend is disabled/,
    );

    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const message: OwnerActionStruct = { ...envelope.message, owner: account.address };
    const domain = domainFor();
    const secpSignature = await account.signTypedData({
      domain,
      types: OWNER_ACTION_TYPES,
      primaryType: "OwnerAction",
      message,
    });
    assert.equal(
      await dispatching.recover({ domain, message, signature: secpSignature }),
      account.address,
    );
  });

  it("a non-decoding blob is refused by the WebAuthn branch", async () => {
    const dispatching = createDispatchingVerifier(PASSKEY_CONFIG);
    const message = messageFor(await createTestPasskey());
    await assertRefused(
      () =>
        dispatching.recover({
          domain: domainFor(),
          message,
          signature: `0x${"ab".repeat(300)}` as Hex,
        }),
      /not a WebAuthn envelope|not canonical/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R12 — the residuals, pinned as decisions                                   */
/* -------------------------------------------------------------------------- */

describe("accepted residuals", () => {
  it("t9 — a flipped-s assertion of a MUTATING action replays into a consumed nonce", async () => {
    // Malleability is real and measured: flipping `s` yields a second signature
    // that verifies for the same message and key. It grants nothing here —
    // identity comes from the carried public key, which flipping does not
    // change, and single-use is keyed on the nonce. Written against `pause`
    // deliberately: a `read` has no nonce to replay into, so the same test
    // there would pass while proving nothing.
    const passkey = await createTestPasskey();
    const envelope = await signPasskeyOwnerAction(passkey, "pause", { reason: "x" });
    const nonceStore = new MemoryNonceStore();
    const options = {
      now: NOW_SEC,
      expectedChainId: CHAIN_ID,
      network: NETWORK,
      verifier,
      nonceStore,
    };
    await authorizeOwnerAction(
      { signed: envelope.message, signature: envelope.signature, params: envelope.params },
      options,
    );

    const flipped = flipSignatureS(envelope);
    assert.notEqual(flipped, envelope.signature, "the flipped envelope is different bytes");
    // It still VERIFIES — that is the residual — and is still refused, by the nonce.
    assert.equal(
      await verifier.recover({
        domain: envelope.domain,
        message: envelope.message,
        signature: flipped,
      }),
      passkey.ownerAddress,
    );
    await assertRefused(
      () =>
        authorizeOwnerAction(
          { signed: envelope.message, signature: flipped, params: envelope.params },
          options,
        ),
      /Nonce already consumed/,
    );
  });

  it("t9 — a flipped-s READ is a second valid read envelope, accepted by decision", async () => {
    // `read` is verified but NOT nonce-consumed (`READ_ACTION_NONCE_POLICY`), so
    // there is no nonce for a flipped assertion to replay into. That is a
    // decision, not a hole: a read has no second side effect, which is the same
    // reason a byte-identical read replay is accepted.
    const passkey = await createTestPasskey();
    const envelope = await signPasskeyOwnerAction(passkey, "read", { scope: "agent" });
    const options = {
      now: NOW_SEC,
      expectedChainId: CHAIN_ID,
      network: NETWORK,
      verifier,
    };
    const request = {
      signed: envelope.message,
      signature: envelope.signature,
      params: envelope.params,
    };
    assert.equal((await verifyOwnerAction(request, options)).ownerAddress, passkey.ownerAddress);
    const flipped = flipSignatureS(envelope);
    assert.equal(
      (await verifyOwnerAction({ ...request, signature: flipped }, options)).ownerAddress,
      passkey.ownerAddress,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Structural pins                                                            */
/* -------------------------------------------------------------------------- */

describe("structural invariants", () => {
  it("the verifier never reaches the client-side ASN.1 helpers", () => {
    // "The server never parses ASN.1 on the authz path" is a claim worth keeping
    // true by construction rather than by intention. The client ceremony helpers
    // live in the shared module so a UI cannot hand-roll them; nothing the
    // verifier imports may reference them.
    const source = readFileSync(new URL("../src/auth/passkeyVerifier.ts", import.meta.url), "utf8");
    for (const name of [
      "derToP1363",
      "assembleOwnerActionSignature",
      "buildOwnerActionAssertionRequest",
    ]) {
      assert.doesNotMatch(
        source.replace(/\/\*[\s\S]*?\*\//g, ""),
        new RegExp(name),
        `${name} must not be reachable from the verifier`,
      );
    }
  });

  it("derToP1363 converts an authenticator's DER output to fixed halves", () => {
    // The client-side half of the wire contract, exercised so the ten lines the
    // UI depends on are not the untested ones.
    // `r` needs a 0x00 sign pad (high bit set); `s` is short and unpadded, which
    // is exactly the pair of shapes a real authenticator emits.
    const r = `0x${"81".repeat(32)}` as Hex;
    const s = `0x00${"7f".repeat(31)}` as Hex;
    const body = [
      0x02,
      0x21,
      0x00,
      ...hexBytes(r),
      0x02,
      0x1f,
      ...hexBytes(s).slice(1),
    ];
    const der = Uint8Array.from([0x30, body.length, ...body]);
    assert.deepEqual(derToP1363(der), { r, s });
    assert.throws(() => derToP1363(Uint8Array.from([...der, 0x00])), /trailing|does not fit/);
  });

  it("the challenge and owner tags are versioned", async () => {
    const source = readFileSync(
      new URL("../src/auth/webauthnEnvelope.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /"4lpha-p256-owner:v1:"/);
    assert.match(source, /"4lpha-owner-action:v1:"/);
  });
});

/* -------------------------------------------------------------------------- */
/* Local helpers                                                              */
/* -------------------------------------------------------------------------- */

function messageFor(passkey: TestPasskey): OwnerActionStruct {
  return {
    owner: passkey.ownerAddress,
    agentId: AGENT_ID,
    action: "pause",
    paramsHash: paramsHash("pause", { reason: "test" }),
    nonce: freshNonce(),
    issuedAt: BigInt(NOW_SEC),
    expiry: BigInt(NOW_SEC + 120),
  };
}

async function buildEnvelope(
  passkey: TestPasskey,
  clientData: Parameters<typeof buildClientData>[0],
): Promise<Hex> {
  const authenticatorData = buildAuthenticatorData();
  const clientDataJSON = buildClientData(clientData);
  const { r, s } = await signAssertion(passkey, authenticatorData, clientDataJSON);
  return encodeWebAuthnEnvelope({
    x: passkey.x,
    y: passkey.y,
    authenticatorData,
    clientDataJSON,
    r,
    s,
  });
}

async function buildEnvelopeWithKey(
  passkey: TestPasskey,
  message: OwnerActionStruct,
  domain: ReturnType<typeof domainFor>,
  x: Hex,
  y: Hex,
): Promise<Hex> {
  const authenticatorData = buildAuthenticatorData();
  const clientDataJSON = buildClientData({
    challenge: ownerActionChallenge({ domain, message }),
  });
  const { r, s } = await signAssertion(passkey, authenticatorData, clientDataJSON);
  return encodeWebAuthnEnvelope({ x, y, authenticatorData, clientDataJSON, r, s });
}

function hexBytes(value: Hex): number[] {
  const out: number[] = [];
  for (let i = 2; i < value.length; i += 2) {
    out.push(Number.parseInt(value.slice(i, i + 2), 16));
  }
  return out;
}

function flipLastByte(value: Hex): Hex {
  const bytes = hexBytes(value);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
  return toHex(Uint8Array.from(bytes));
}

function concat32Plus(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(value.length + 1);
  out.set(value, 0);
  return out;
}

const CURVE_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Produce the second, equally valid signature over the same assertion base. */
function flipSignatureS(envelope: PasskeyEnvelope): Hex {
  const s = BigInt(envelope.s);
  const flipped = CURVE_N - s;
  const hex = flipped.toString(16).padStart(64, "0");
  return encodeWebAuthnEnvelope({
    x: decodeWebAuthnEnvelope(envelope.signature).x,
    y: decodeWebAuthnEnvelope(envelope.signature).y,
    authenticatorData: envelope.authenticatorData,
    clientDataJSON: envelope.clientDataJSON,
    r: envelope.r,
    s: `0x${hex}` as Hex,
  });
}
