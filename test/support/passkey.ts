/**
 * Offline WebAuthn/P-256 fixtures.
 *
 * Every keypair here is REAL and every assertion is REALLY SIGNED, by
 * `node:crypto`'s webcrypto, with no network and no mocked verifier. A test that
 * stubbed the cryptography would prove nothing about the thing most likely to
 * break; these fixtures exercise the same `subtle.sign` / `subtle.verify` pair
 * the production verifier depends on, on the runtime that ships.
 *
 * The builders below are deliberately UNSAFE by parameter: every field of
 * `clientDataJSON` and every flag of `authenticatorData` is overridable, because
 * the adversarial set is mostly "produce a genuinely signed assertion that is
 * wrong in exactly one way".
 */
import { webcrypto } from "node:crypto";
import { sha256, toHex, type Address, type Hex, type TypedDataDomain } from "viem";
import {
  buildOwnerActionDomain,
  resolveDomainSalt,
  type OwnerActionStruct,
  type OwnerActionType,
} from "../../src/auth/ownerAuth.js";
import { paramsHash } from "../../src/auth/canonical.js";
import {
  encodeBase64Url,
  encodeWebAuthnEnvelope,
  ownerActionChallenge,
  passkeyOwnerAddress,
} from "../../src/auth/webauthnEnvelope.js";
import type { EnabledPasskeyConfig } from "../../src/auth/passkeyVerifier.js";
import { AGENT_ID, CHAIN_ID, NETWORK, NOW_SEC, freshNonce } from "./serverHarness.js";

/** The RP ID and origin every passkey test runs against. */
export const RP_ID = "4lpha.app";
export const ORIGIN = "https://4lpha.app";
/** The lookalike from the spec's own example. Must never pass an exact match. */
export const EVIL_ORIGIN = "https://evil-4lpha.app";

export const PASSKEY_CONFIG: EnabledPasskeyConfig = {
  enabled: true,
  rpId: RP_ID,
  origins: [ORIGIN],
  uvRequired: true,
};

/* Authenticator-data flag bits, restated here so a test can name what it sets. */
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

/** What a synced platform authenticator sets on an ordinary verified assertion. */
export const DEFAULT_FLAGS = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS;

export type TestPasskey = {
  readonly privateKey: webcrypto.CryptoKey;
  readonly x: Hex;
  readonly y: Hex;
  /** The identity this credential derives to, through the shared derivation. */
  readonly ownerAddress: Address;
};

/** A real P-256 credential. */
export async function createTestPasskey(): Promise<TestPasskey> {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", pair.publicKey),
  );
  const x = toHex(raw.subarray(1, 33));
  const y = toHex(raw.subarray(33, 65));
  return {
    privateKey: pair.privateKey,
    x,
    y,
    ownerAddress: passkeyOwnerAddress(x, y),
  };
}

/** Build `authenticatorData`: rpIdHash ‖ flags ‖ signCount ‖ (optional extra). */
export function buildAuthenticatorData(
  options: {
    readonly rpId?: string;
    readonly flags?: number;
    readonly signCount?: number;
    readonly extra?: Uint8Array;
  } = {},
): Uint8Array {
  const extra = options.extra ?? new Uint8Array(0);
  const out = new Uint8Array(37 + extra.length);
  out.set(sha256(new TextEncoder().encode(options.rpId ?? RP_ID), "bytes"), 0);
  out[32] = options.flags ?? DEFAULT_FLAGS;
  const count = options.signCount ?? 0;
  out[33] = (count >>> 24) & 0xff;
  out[34] = (count >>> 16) & 0xff;
  out[35] = (count >>> 8) & 0xff;
  out[36] = count & 0xff;
  out.set(extra, 37);
  return out;
}

/** Build `clientDataJSON`. `raw` bypasses the object entirely, for shape tests. */
export function buildClientData(
  options: {
    readonly type?: string;
    readonly challenge?: string;
    readonly origin?: string;
    readonly crossOrigin?: boolean;
    readonly topOrigin?: string;
    readonly raw?: string;
    /** Appended verbatim inside the object, e.g. a duplicate key. */
    readonly extraJson?: string;
  } = {},
): Uint8Array {
  if (options.raw !== undefined) {
    return new TextEncoder().encode(options.raw);
  }
  const fields: string[] = [
    `"type":${JSON.stringify(options.type ?? "webauthn.get")}`,
    `"challenge":${JSON.stringify(options.challenge ?? "")}`,
    `"origin":${JSON.stringify(options.origin ?? ORIGIN)}`,
  ];
  if (options.crossOrigin !== undefined) {
    fields.push(`"crossOrigin":${options.crossOrigin ? "true" : "false"}`);
  }
  if (options.topOrigin !== undefined) {
    fields.push(`"topOrigin":${JSON.stringify(options.topOrigin)}`);
  }
  if (options.extraJson !== undefined) fields.push(options.extraJson);
  return new TextEncoder().encode(`{${fields.join(",")}}`);
}

/** Sign the WebAuthn signature base: `authenticatorData ‖ sha256(clientDataJSON)`. */
export async function signAssertion(
  passkey: TestPasskey,
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
): Promise<{ r: Hex; s: Hex; raw: Uint8Array }> {
  const base = new Uint8Array(authenticatorData.length + 32);
  base.set(authenticatorData, 0);
  base.set(sha256(clientDataJSON, "bytes"), authenticatorData.length);
  const raw = new Uint8Array(
    await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      passkey.privateKey,
      base,
    ),
  );
  return { r: toHex(raw.subarray(0, 32)), s: toHex(raw.subarray(32, 64)), raw };
}

/* -------------------------------------------------------------------------- */
/* Whole envelopes                                                            */
/* -------------------------------------------------------------------------- */

export type PasskeySignOptions = {
  readonly agentId?: string;
  readonly nonce?: Hex;
  readonly issuedAt?: number;
  readonly expiry?: number;
  readonly chainId?: number;
  readonly network?: string;
  readonly envSalt?: string;
  readonly paramsHash?: Hex;
  /** Owner declared in the struct. Defaults to the passkey's derived identity. */
  readonly owner?: Address;
  /** Overrides applied to `clientDataJSON` AFTER the challenge is computed. */
  readonly clientData?: Parameters<typeof buildClientData>[0];
  readonly authenticatorData?: Parameters<typeof buildAuthenticatorData>[0];
  /** Sign with a DIFFERENT key than the one carried in the envelope. */
  readonly signWith?: TestPasskey;
  /** Carry a DIFFERENT public key than the one that signed. */
  readonly carryKeyOf?: TestPasskey;
};

export type PasskeyEnvelope = {
  readonly signed: Record<string, unknown>;
  readonly message: OwnerActionStruct;
  readonly domain: TypedDataDomain;
  readonly signature: Hex;
  readonly params: unknown;
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  readonly r: Hex;
  readonly s: Hex;
};

export function domainFor(options: PasskeySignOptions = {}): TypedDataDomain {
  const chainId = options.chainId ?? CHAIN_ID;
  return buildOwnerActionDomain(
    chainId,
    resolveDomainSalt({
      chainId,
      network: options.network ?? NETWORK,
      ...(options.envSalt === undefined ? {} : { envSalt: options.envSalt }),
    }),
  );
}

/**
 * A complete, genuinely-signed passkey owner action in wire form.
 *
 * The challenge comes from `ownerActionChallenge` — the SAME exported helper a
 * production client is told to use — so this doubles as the test that the
 * exported helper produces a challenge the verifier accepts.
 */
export async function signPasskeyOwnerAction(
  passkey: TestPasskey,
  action: OwnerActionType,
  params: unknown,
  options: PasskeySignOptions = {},
): Promise<PasskeyEnvelope> {
  const carried = options.carryKeyOf ?? passkey;
  const issuedAt = BigInt(options.issuedAt ?? NOW_SEC);
  const expiry = BigInt(options.expiry ?? NOW_SEC + 120);
  const message: OwnerActionStruct = {
    owner: options.owner ?? carried.ownerAddress,
    agentId: options.agentId ?? AGENT_ID,
    action,
    paramsHash: options.paramsHash ?? paramsHash(action, params),
    nonce: options.nonce ?? freshNonce(),
    issuedAt,
    expiry,
  };
  const domain = domainFor(options);

  const authenticatorData = buildAuthenticatorData(options.authenticatorData ?? {});
  const clientDataJSON = buildClientData({
    challenge: ownerActionChallenge({ domain, message }),
    ...options.clientData,
  });
  const { r, s } = await signAssertion(
    options.signWith ?? passkey,
    authenticatorData,
    clientDataJSON,
  );
  const signature = encodeWebAuthnEnvelope({
    x: carried.x,
    y: carried.y,
    authenticatorData,
    clientDataJSON,
    r,
    s,
  });

  return {
    signed: {
      owner: message.owner,
      agentId: message.agentId,
      action: message.action,
      paramsHash: message.paramsHash,
      nonce: message.nonce,
      issuedAt: message.issuedAt.toString(10),
      expiry: message.expiry.toString(10),
    },
    message,
    domain,
    signature,
    params,
    authenticatorData,
    clientDataJSON,
    r,
    s,
  };
}

/** Base64url a challenge exactly as a browser would, for hand-built client data. */
export { encodeBase64Url };
