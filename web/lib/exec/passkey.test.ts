/**
 * Golden vectors generated ONCE from the execution plane's own
 * `src/auth/webauthnEnvelope.ts` (node --import tsx, 2026-09-02) and PINNED
 * here as literals — the same discipline `owner-action.test.ts` applies to
 * `canonicalEncode`. The web port must reproduce them byte for byte; a
 * divergence is a consensus break that surfaces live as a generic 401 from the
 * plane, indistinguishable from a forgery.
 *
 * The end-to-end cross-check (synthetic assertion → this port's envelope →
 * `src/auth/passkeyVerifier.ts`) is run at the repo root with tsx, because
 * `web/` may not import from `../src/`. Its output is recorded in
 * `MD here/MARKETPLACE-ACCOUNT-PASSKEY-REVISION.md` §"R5 local test".
 */
import { describe, expect, it } from "vitest";
import { hashTypedData, toHex, type Hex } from "viem";
import { OWNER_ACTION_TYPES, ownerActionDomain } from "./owner-action";
import {
  assembleOwnerActionSignature,
  derToP1363,
  encodeBase64Url,
  encodeWebAuthnEnvelope,
  ownerActionChallengeBytes,
  fromAltanaCredential,
  ownerAddressFromPasskey,
  toAltanaCredential,
} from "./passkey";

const X = "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20" as Hex;
const Y = "0x202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f" as Hex;

const TYPED_DATA = {
  domain: ownerActionDomain({ chainId: 56, network: "mainnet" }),
  types: OWNER_ACTION_TYPES,
  primaryType: "OwnerAction",
  message: {
    owner: "0x1111111111111111111111111111111111111111" as Hex,
    agentId: "*",
    action: "createAccountReadSession",
    paramsHash: "0x2e6d67dd7d9faa24957dd83cd051f06c911a2b6b4547a2cf9b3d7e90d9ac7ccc" as Hex,
    nonce: `0x${"ab".repeat(32)}` as Hex,
    issuedAt: 1_756_800_000n,
    expiry: 1_756_800_120n,
  },
} as const;

describe("owner identity derivation (golden vectors from src/auth/webauthnEnvelope.ts)", () => {
  it("pins 4lpha-p256-owner:v1 — changing it orphans every passkey owner", () => {
    expect(ownerAddressFromPasskey(X, Y)).toBe("0xBBD8DB1b3Ed8E84f2b1F14B5A7b034632eD76aaE");
  });

  it("refuses coordinates that are not exactly 32 bytes", () => {
    expect(() => ownerAddressFromPasskey("0x01" as Hex, Y)).toThrow(/32 bytes/u);
  });
});

describe("challenge derivation (golden vectors)", () => {
  it("reproduces the plane's domain salt", () => {
    expect(TYPED_DATA.domain.salt).toBe(
      "0x328d4ecd3220ffe4e2f311d722b9bff276b8d5840766f4260df48b151c045b31",
    );
  });

  it("reproduces the EIP-712 digest a secp256k1 owner would sign", () => {
    expect(hashTypedData(TYPED_DATA)).toBe(
      "0x1f6be5e63606dc0720e3ffc028fab77c0ff540d142220e7e37d8a0c6042593c7",
    );
  });

  it("pins 4lpha-owner-action:v1 over that digest, raw bytes not hex", () => {
    expect(toHex(ownerActionChallengeBytes(TYPED_DATA))).toBe(
      "0x3b28b39299f01a5bcb5bf59fa02808043f89d62d43f5a9f474f14c02e3a57050",
    );
    expect(encodeBase64Url(ownerActionChallengeBytes(TYPED_DATA))).toBe(
      "OyizkpnwGlvLW_WfoCgIBD-J1i1D9an0dPFMAuOlcFA",
    );
  });
});

describe("envelope encoding (golden vector)", () => {
  it("reproduces the plane's ABI tuple, field order included", () => {
    expect(
      encodeWebAuthnEnvelope({
        x: X,
        y: Y,
        authenticatorData: new Uint8Array([1, 2, 3]),
        clientDataJSON: new Uint8Array([4, 5, 6, 7]),
        r: `0x${"11".repeat(32)}` as Hex,
        s: `0x${"22".repeat(32)}` as Hex,
      }),
    ).toBe(
      "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f00000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000100111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000003010203000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040405060700000000000000000000000000000000000000000000000000000000",
    );
  });
});

describe("derToP1363 (golden vector)", () => {
  it("strips the DER sign pad and left-pads to the field width", () => {
    expect(derToP1363(Uint8Array.from([0x30, 0x08, 0x02, 0x02, 0x00, 0x9a, 0x02, 0x02, 0x01, 0x02]))).toEqual({
      r: "0x000000000000000000000000000000000000000000000000000000000000009a",
      s: "0x0000000000000000000000000000000000000000000000000000000000000102",
    });
  });

  it("refuses trailing bytes and long-form lengths", () => {
    expect(() => derToP1363(Uint8Array.from([0x30, 0x81, 0x02, 0x02, 0x00]))).toThrow(/long-form/u);
    expect(() =>
      derToP1363(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0xff])),
    ).toThrow(/does not fit/u);
  });
});

/* -------------------------------------------------------------------------- */
/* Round trip against a software P-256 key                                    */
/* -------------------------------------------------------------------------- */

function p1363ToDer(raw: Uint8Array): Uint8Array {
  const encode = (value: Uint8Array): number[] => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    const trimmed = [...value.subarray(start)];
    if ((trimmed[0] ?? 0) >= 0x80) trimmed.unshift(0);
    return [0x02, trimmed.length, ...trimmed];
  };
  const body = [...encode(raw.subarray(0, 32)), ...encode(raw.subarray(32, 64))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

describe("a synthetic WebAuthn assertion assembles into a verifiable envelope", () => {
  it("signs the WebAuthn base and reassembles it byte-identically", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const x = toHex(rawKey.subarray(1, 33));
    const y = toHex(rawKey.subarray(33, 65));

    const challenge = ownerActionChallengeBytes(TYPED_DATA);
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge: encodeBase64Url(challenge),
        origin: "http://localhost:3000",
        crossOrigin: false,
      }),
    );
    // rpIdHash ‖ flags(UP|UV|BE|BS) ‖ signCount — the 37-byte shape the plane
    // requires when no extension data is present.
    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("localhost")),
    );
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(rpIdHash, 0);
    authenticatorData[32] = 0x01 | 0x04 | 0x08 | 0x10;

    const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
    const base = new Uint8Array(authenticatorData.length + 32);
    base.set(authenticatorData, 0);
    base.set(clientDataHash, authenticatorData.length);

    const rawSignature = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, base),
    );
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, rawSignature, base),
    ).toBe(true);

    const envelope = assembleOwnerActionSignature({
      credential: { x, y },
      authenticatorData,
      clientDataJSON,
      derSignature: p1363ToDer(rawSignature),
    });
    // The DER round trip must reproduce the raw halves exactly, and the
    // envelope must be the same bytes the direct encoder produces.
    expect(
      encodeWebAuthnEnvelope({
        x,
        y,
        authenticatorData,
        clientDataJSON,
        r: toHex(rawSignature.subarray(0, 32)),
        s: toHex(rawSignature.subarray(32, 64)),
      }),
    ).toBe(envelope);
    // 256 bytes is the plane's MIN_WEBAUTHN_ENVELOPE_BYTES: an envelope can
    // never be mistaken for a 65-byte secp256k1 signature.
    expect((envelope.length - 2) / 2).toBeGreaterThanOrEqual(256);
    expect(ownerAddressFromPasskey(x, y)).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  });
});

/**
 * R-CRED (MARKETPLACE-WALLET-B §4): Altana hands the P256 key back FLAT — one
 * 64-byte `x‖y` with no SEC1 `0x04` prefix — while our owner derivation hashes
 * the two 32-byte halves. A wrong split offset silently produces a DIFFERENT
 * owner address, which the plane rejects as a generic 401 that looks exactly
 * like a forgery. The pinned address below is the SAME literal the golden
 * vector at the top of this file asserts, reached through the Altana form: that
 * equality is the whole point of the test.
 */
describe("Altana credential interop", () => {
  const ALTANA_KEY = `0x${X.slice(2)}${Y.slice(2)}` as Hex;
  const WALLET = "0x9A1f5d8B6e4C3A2B1D0e9F8a7b6c5D4e3F2a1b0c";
  const CREDENTIAL_ID = "m1-bMPuAqpWx7Q";

  it("derives the SAME owner from Altana's flat key as from (x, y)", () => {
    const record = fromAltanaCredential(
      { kind: "webauthn", id: CREDENTIAL_ID, publicKey: ALTANA_KEY, rpId: "localhost" },
      WALLET as `0x${string}`,
      { createdAt: 1 },
    );
    expect(record.x).toBe(X);
    expect(record.y).toBe(Y);
    expect(ownerAddressFromPasskey(record.x, record.y)).toBe("0xBBD8DB1b3Ed8E84f2b1F14B5A7b034632eD76aaE");
  });

  it("checksums the wallet address and lowercases the relying party", () => {
    const record = fromAltanaCredential(
      { kind: "webauthn", id: CREDENTIAL_ID, publicKey: ALTANA_KEY, rpId: "LocalHost" },
      WALLET.toLowerCase() as `0x${string}`,
      { createdAt: 1, label: "4lpha owner" },
    );
    expect(record.walletAddress).toBe(WALLET);
    expect(record.rpId).toBe("localhost");
    expect(record.label).toBe("4lpha owner");
  });

  it("round-trips our record back into Altana's shape, prefix-free", () => {
    const record = fromAltanaCredential(
      { kind: "webauthn", id: CREDENTIAL_ID, publicKey: ALTANA_KEY, rpId: "localhost" },
      WALLET as `0x${string}`,
      { createdAt: 1 },
    );
    const credential = toAltanaCredential(record);
    expect(credential).toEqual({ kind: "webauthn", id: CREDENTIAL_ID, publicKey: ALTANA_KEY, rpId: "localhost" });
    // The 0x04 prefix stays off: 64 bytes, not 65.
    expect(credential.publicKey.length).toBe(2 + 128);
  });

  it("refuses a key that is not exactly 64 bytes, prefix included", () => {
    const withPrefix = `0x04${ALTANA_KEY.slice(2)}` as Hex;
    expect(() => fromAltanaCredential({ kind: "webauthn", id: CREDENTIAL_ID, publicKey: withPrefix, rpId: "localhost" }, WALLET as `0x${string}`))
      .toThrow(/64 bytes/u);
  });

  it("refuses a credential with no relying party, rather than guessing one", () => {
    expect(() => fromAltanaCredential({ kind: "webauthn", id: CREDENTIAL_ID, publicKey: ALTANA_KEY }, WALLET as `0x${string}`))
      .toThrow(/relying-party/u);
  });
});
