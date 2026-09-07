/**
 * THE one constructor for the WebAuthn owner-action envelope — encoder, decoder,
 * owner-address derivation, and challenge derivation, shared by the server
 * verifier, the tests, and the marketplace UI client.
 *
 * Same reasoning this codebase already records for `buildOwnerActionDomain` and
 * `canonicalEncode`, and it is the reason this module exists at all: a client
 * that hand-assembles the envelope and gets one field wrong produces rejections
 * that are indistinguishable from forgery — a bug that looks exactly like an
 * attack. So there is exactly one implementation of each half, and both sides
 * import it.
 *
 * THE WIRE SHAPE. A WebAuthn assertion travels inside the EXISTING
 * `OwnerActionRequest.signature: Hex`. No HTTP envelope change, no new
 * validation surface, no client schema break:
 *
 *   abi.encode(
 *     bytes32 x, bytes32 y,      // P-256 public key, uncompressed coordinates
 *     bytes authenticatorData,
 *     bytes clientDataJSON,
 *     bytes32 r, bytes32 s       // IEEE P1363 (raw r‖s) — the client converts
 *   )                            // from the authenticator's DER
 *
 * DER is refused BY CONSTRUCTION: the tuple has no place for it and the server
 * never parses ASN.1. The DER→P1363 conversion is ten lines of CLIENT code (see
 * the client section at the bottom) rather than an ASN.1 parser sitting in front
 * of owner authority.
 *
 * `r` and `s` are `bytes32` rather than `bytes` deliberately: the ABI decode is
 * then what guarantees the signature is exactly 64 bytes, so `subtle.verify`
 * never has to be handed a length it did not expect. Do not "improve" this to
 * `bytes signature`.
 */
import {
  concat,
  encodeAbiParameters,
  decodeAbiParameters,
  getAddress,
  hashTypedData,
  hexToBytes,
  keccak256,
  sha256,
  size,
  stringToBytes,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import { OWNER_ACTION_TYPES, type OwnerActionStruct } from "./ownerAuth.js";

/* -------------------------------------------------------------------------- */
/* The ABI tuple                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The envelope's parameter list. Exported so a client encodes against the same
 * definition the decoder reads, rather than a copy that can drift.
 */
export const WEBAUTHN_ENVELOPE_PARAMS = [
  { name: "x", type: "bytes32" },
  { name: "y", type: "bytes32" },
  { name: "authenticatorData", type: "bytes" },
  { name: "clientDataJSON", type: "bytes" },
  { name: "r", type: "bytes32" },
  { name: "s", type: "bytes32" },
] as const;

/**
 * Ceiling on `authenticatorData`, in bytes. A real value is 37; the bound is a
 * parser-DoS stop, not a format claim.
 *
 * MEASURED (PHASE1.5 review): viem's `decodeAbiParameters` rejects a huge length
 * prefix and a huge offset immediately with `PositionOutOfBoundsError`, and the
 * HTTP layer caps an owner envelope long before either bound is reachable
 * (`MAX_OWNER_ENVELOPE_CHARS` on reads, `DEFAULT_MAX_BODY_BYTES` on mutations).
 * These bounds are belt-and-braces for direct callers, not load-bearing.
 */
export const MAX_AUTHENTICATOR_DATA_BYTES = 1_024;

/** Ceiling on `clientDataJSON`, in bytes. A real value is ~130. See above. */
export const MAX_CLIENT_DATA_BYTES = 4_096;

/**
 * The smallest possible valid encoding of the tuple, in bytes: six head words
 * plus two empty length-prefixed tails.
 *
 * MEASURED at 256 bytes. This is half of the disjointness argument that lets
 * {@link https://github.com/wevm/viem viem}'s exact-65-byte secp256k1 guard and
 * this envelope share one `signature` field with no scheme selector — a 65-byte
 * blob can never decode to this tuple, and this tuple can never be 65 bytes.
 * Pinned by test.
 */
export const MIN_WEBAUTHN_ENVELOPE_BYTES = 256;

/** A decoded, canonical WebAuthn assertion envelope. */
export type WebAuthnEnvelope = {
  /** P-256 public key X coordinate, exactly 32 bytes. */
  readonly x: Hex;
  /** P-256 public key Y coordinate, exactly 32 bytes. */
  readonly y: Hex;
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  /** The IEEE P1363 signature, `r ‖ s`, exactly 64 bytes by construction. */
  readonly signature: Uint8Array;
  readonly r: Hex;
  readonly s: Hex;
};

/** Everything an encoder needs. Byte arrays for the tails, bytes32 for the rest. */
export type WebAuthnEnvelopeInput = {
  readonly x: Hex;
  readonly y: Hex;
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  readonly r: Hex;
  readonly s: Hex;
};

/** Thrown by everything in this module. Callers collapse it into one generic error. */
export class WebAuthnEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthnEnvelopeError";
  }
}

function assertBytes32(value: Hex, field: string): void {
  if (size(value) !== 32) {
    throw new WebAuthnEnvelopeError(`${field} must be exactly 32 bytes.`);
  }
}

/** Encode an assertion into the `signature` field. The ONLY encoder. */
export function encodeWebAuthnEnvelope(input: WebAuthnEnvelopeInput): Hex {
  for (const [field, value] of [
    ["x", input.x],
    ["y", input.y],
    ["r", input.r],
    ["s", input.s],
  ] as const) {
    assertBytes32(value, field);
  }
  return encodeAbiParameters(WEBAUTHN_ENVELOPE_PARAMS, [
    input.x,
    input.y,
    toHex(input.authenticatorData),
    toHex(input.clientDataJSON),
    input.r,
    input.s,
  ]);
}

/**
 * Decode and CANONICALITY-CHECK an envelope. The ONLY decoder.
 *
 * The canonicality check is not decoration. MEASURED against viem@2.55.13: the
 * decoder ACCEPTS a valid encoding followed by arbitrary trailing bytes, and
 * ACCEPTS two dynamic head words pointing at the same tail. Neither is
 * exploitable today — single-use is keyed on `(owner, nonce)` and never on
 * signature bytes, and the aliased-tail case dies at the rpIdHash check — but
 * "not exploitable because nothing currently hashes the signature bytes" is a
 * property held by accident, and the 65-byte secp256k1 path has no such slack.
 * So: re-encode the decoded tuple and refuse unless it reproduces the input.
 * Three lines, and it makes "the envelope has exactly one encoding" a CHECKED
 * property rather than an assumption. Trailing bytes, aliased tails and
 * non-minimal offsets all die here.
 *
 * The comparison is case-insensitive because it is a comparison of BYTES: viem
 * emits lowercase hex, and a client that upper-cased its hex string sent the
 * same bytes.
 */
export function decodeWebAuthnEnvelope(signature: Hex): WebAuthnEnvelope {
  let decoded: readonly [Hex, Hex, Hex, Hex, Hex, Hex];
  try {
    decoded = decodeAbiParameters(WEBAUTHN_ENVELOPE_PARAMS, signature);
  } catch {
    throw new WebAuthnEnvelopeError("Signature is not a WebAuthn envelope.");
  }
  const [x, y, authenticatorDataHex, clientDataHex, r, s] = decoded;

  // Bound the tails BEFORE re-encoding them: a re-encode of a hostile blob
  // should never be the expensive part of a rejection.
  if (size(authenticatorDataHex) > MAX_AUTHENTICATOR_DATA_BYTES) {
    throw new WebAuthnEnvelopeError("authenticatorData exceeds its bound.");
  }
  if (size(clientDataHex) > MAX_CLIENT_DATA_BYTES) {
    throw new WebAuthnEnvelopeError("clientDataJSON exceeds its bound.");
  }

  const reencoded = encodeAbiParameters(WEBAUTHN_ENVELOPE_PARAMS, [
    x,
    y,
    authenticatorDataHex,
    clientDataHex,
    r,
    s,
  ]);
  if (reencoded.toLowerCase() !== signature.toLowerCase()) {
    throw new WebAuthnEnvelopeError("Envelope encoding is not canonical.");
  }

  return {
    x,
    y,
    authenticatorData: hexToBytes(authenticatorDataHex),
    clientDataJSON: hexToBytes(clientDataHex),
    signature: hexToBytes(concat([r, s])),
    r,
    s,
  };
}

/* -------------------------------------------------------------------------- */
/* Owner identity derived from the credential key                             */
/* -------------------------------------------------------------------------- */

/**
 * The domain tag for a P256-derived owner identity. VERSIONED, and the version
 * is the point.
 *
 * This string is part of a PERSISTED IDENTITY. The derived address is written
 * into agent rows, kill-switch pause records, journal rows and nonce keys. If
 * the tag, the hash, the byte order or the slice ever changes, every existing
 * passkey owner becomes a DIFFERENT owner and every one of their agents becomes
 * unreachable — with a generic auth failure as the only symptom. Change the
 * version deliberately or not at all; a golden-vector test names that
 * consequence in its title.
 */
export const PASSKEY_OWNER_TAG = "4lpha-p256-owner:v1:";

/**
 * Derive the owner identity from the credential's public key.
 *
 *   ownerAddress = getAddress( keccak256("4lpha-p256-owner:v1:" ‖ x ‖ y)[12..32] )
 *
 * `x` and `y` are fixed 32 bytes each, so the preimage is fixed-length and
 * unambiguous. The tag is what makes the separation from a secp256k1 EOA
 * STRUCTURAL rather than accidental: `keccak(x‖y)[12..]` is *literally* the
 * secp256k1 address derivation, and adopting it would leave a comment as the
 * only evidence distinguishing an identity from an account. The RP ID is
 * deliberately NOT in the preimage — credentials are already RP-scoped by the
 * browser, so it would add no separation, and it would silently orphan every row
 * if an operator ever migrated the RP ID.
 *
 * The result is `getAddress`-checksummed, matching what the agent store's
 * `ownerKey` validates on the write path.
 *
 * THIS ADDRESS IS AN IDENTITY, NOT AN ACCOUNT. No secp256k1 key exists for it.
 * See the invariant on `AgentWalletRef.ownerAddress`.
 */
export function passkeyOwnerAddress(x: Hex, y: Hex): Address {
  assertBytes32(x, "x");
  assertBytes32(y, "y");
  const hash = keccak256(concat([stringToHex(PASSKEY_OWNER_TAG), x, y]));
  return getAddress(`0x${hash.slice(26)}`);
}

/* -------------------------------------------------------------------------- */
/* Challenge derivation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Purpose tag on the WebAuthn challenge, versioned like the owner tag.
 *
 * WebAuthn scopes a credential by RP ID, NOT by purpose: every ceremony at the
 * same RP ID uses the same credential and produces assertions of the same shape.
 * A bare 32-byte digest as a challenge is therefore indistinguishable from any
 * other ceremony's challenge at that RP ID, and any ceremony there that signs a
 * CALLER-SUPPLIED challenge is a signing oracle for this server.
 *
 * Be honest about what the tag buys: against an oracle that signs a FREELY
 * CHOSEN challenge it buys nothing, because the attacker tags it too. It buys
 * separation from ceremonies that STRUCTURE their own challenges, and it makes
 * the requirement legible to whoever builds the login flow. The real control is
 * the RP-ID deployment invariant documented on the verifier.
 */
export const OWNER_ACTION_CHALLENGE_TAG = "4lpha-owner-action:v1:";

/**
 * The 32 bytes a passkey owner's assertion must carry as its challenge:
 *
 *   sha256( utf8("4lpha-owner-action:v1:") ‖ hashTypedData(domain, OwnerAction) )
 *
 * The inner digest is the SAME one a secp256k1 owner signs, so every property
 * the EIP-712 path buys transfers unchanged: chainId and env-salt domain
 * separation, `paramsHash` parameter binding, and the per-request nonce inside
 * the struct. No second signing format, no second canonical encoder.
 *
 * The digest bytes are concatenated RAW (32 bytes), not as their hex string.
 */
export function ownerActionChallengeBytes(input: {
  readonly domain: TypedDataDomain;
  readonly message: OwnerActionStruct;
}): Uint8Array {
  const digest = hashTypedData({
    domain: input.domain,
    types: OWNER_ACTION_TYPES,
    primaryType: "OwnerAction",
    message: input.message,
  });
  return sha256(
    concat([stringToHex(OWNER_ACTION_CHALLENGE_TAG), digest]),
    "bytes",
  );
}

/** The same value as the browser expects it: base64url, no padding. */
export function ownerActionChallenge(input: {
  readonly domain: TypedDataDomain;
  readonly message: OwnerActionStruct;
}): string {
  return encodeBase64Url(ownerActionChallengeBytes(input));
}

/* -------------------------------------------------------------------------- */
/* base64url, strictly                                                        */
/* -------------------------------------------------------------------------- */

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Encode bytes as base64url with NO padding, per WebAuthn L2 §5.8.1. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Decode base64url STRICTLY, or return `null`.
 *
 * `Buffer.from(s, "base64url")` is lenient: it tolerates the standard `+/`
 * alphabet and silently DROPS characters outside it, so two different strings
 * can decode to the same bytes and a malformed challenge can decode to a valid
 * one. A comparison built on that is not the comparison it looks like.
 *
 * This decoder refuses anything outside the base64url alphabet, refuses padding
 * anywhere but the end, refuses a length that cannot be a base64 encoding, and
 * refuses non-zero trailing bits — so a given byte string has exactly ONE
 * accepted spelling (modulo the padding a lenient client may add).
 */
export function decodeBase64UrlStrict(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return null;
  const body = value.replace(/=+$/, "");
  const padding = value.length - body.length;
  if (body.length % 4 === 1) return null;
  // Padding, when present at all, must bring the string to a multiple of four.
  if (padding > 0 && value.length % 4 !== 0) return null;

  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of body) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  // Leftover bits belong to no byte and MUST be zero; anything else is a second
  // spelling of the same bytes.
  if ((accumulator & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

/* -------------------------------------------------------------------------- */
/* CLIENT-SIDE ceremony helpers                                               */
/* -------------------------------------------------------------------------- */

/*
 * Everything below this line runs in the MARKETPLACE UI, never on the authz
 * path. No server module imports it — the verifier imports the decoder, the
 * derivation and the challenge, and nothing else — and a test pins that, because
 * "the server never parses ASN.1" is a claim worth keeping true by construction.
 *
 * It lives in this module anyway for the same reason the decoder does: the
 * client half of the ceremony is exactly where a hand-rolled implementation
 * produces failures that look like forgeries.
 */

/**
 * What the UI MUST persist from the REGISTRATION ceremony, and why it has no
 * choice.
 *
 * `navigator.credentials.get()` returns neither the public key nor a usable
 * credential list. The public key is available ONLY from `create()` plus the
 * `getPublicKey()` extension — and this repo never sees a registration. So the
 * client, not the server, holds this state:
 *
 *   - `(x, y)` is needed to build the envelope AND to compute `signed.owner`,
 *     which is inside the signed struct and therefore inside the challenge;
 *   - `credentialId` is needed to pin `allowCredentials`, so that a different
 *     credential at the same RP can never be exercised against a `signed.owner`
 *     derived from this one. Without the pin, the platform may pick another
 *     credential and the request fails generically.
 *
 * This is client-side state that nothing backs up and clearing site data wipes.
 * Security-wise that is fine — substituting `(x, y)` still cannot sign, and the
 * recovered-vs-declared match catches it. AVAILABILITY-wise it is a known gap: a
 * synced passkey on a NEW DEVICE produces perfectly valid assertions and still
 * cannot be used, because the new device does not know the public key. The
 * recovery source is Altana's on-chain passkey record (`recoverFromPasskey`,
 * FINDINGS (a)); the UI's new-device path depends on it.
 */
export type PasskeyCredentialRecord = {
  /** P-256 public key X coordinate, 32 bytes. */
  readonly x: Hex;
  /** P-256 public key Y coordinate, 32 bytes. */
  readonly y: Hex;
  /** The credential id, base64url — exactly as `create()` returned it. */
  readonly credentialId: string;
};

/** The subset of `PublicKeyCredentialRequestOptions` this ceremony pins. */
export type PasskeyAssertionRequest = {
  /** base64url, no padding. The client converts to an ArrayBuffer. */
  readonly challenge: string;
  readonly allowCredentials: readonly {
    readonly id: string;
    readonly type: "public-key";
  }[];
  readonly userVerification: "required" | "preferred";
  readonly rpId?: string;
};

/**
 * Build the assertion request for one owner action. CLIENT-SIDE.
 *
 * `allowCredentials` is always pinned to the one credential whose `(x, y)` the
 * caller is about to derive `signed.owner` from — see
 * {@link PasskeyCredentialRecord}.
 */
export function buildOwnerActionAssertionRequest(input: {
  readonly credential: PasskeyCredentialRecord;
  readonly domain: TypedDataDomain;
  readonly message: OwnerActionStruct;
  readonly rpId?: string;
  /** Defaults to `"required"`, matching the server's default `PASSKEY_UV_REQUIRED`. */
  readonly userVerification?: "required" | "preferred";
}): PasskeyAssertionRequest {
  return {
    challenge: ownerActionChallenge({
      domain: input.domain,
      message: input.message,
    }),
    allowCredentials: [
      { id: input.credential.credentialId, type: "public-key" },
    ],
    userVerification: input.userVerification ?? "required",
    ...(input.rpId === undefined ? {} : { rpId: input.rpId }),
  };
}

/**
 * Assemble the `signature` field from an authenticator's response. CLIENT-SIDE.
 *
 * Accepts the authenticator's DER signature and converts it, so the ten lines of
 * conversion exist ONCE rather than once per client.
 */
export function assembleOwnerActionSignature(input: {
  readonly credential: PasskeyCredentialRecord;
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  /** The authenticator's DER-encoded ECDSA signature. */
  readonly derSignature: Uint8Array;
}): Hex {
  const { r, s } = derToP1363(input.derSignature);
  return encodeWebAuthnEnvelope({
    x: input.credential.x,
    y: input.credential.y,
    authenticatorData: input.authenticatorData,
    clientDataJSON: input.clientDataJSON,
    r,
    s,
  });
}

/**
 * Convert a DER `SEQUENCE { INTEGER r, INTEGER s }` to fixed 32-byte halves.
 * CLIENT-SIDE ONLY — no server code path reaches this, by design.
 */
export function derToP1363(der: Uint8Array): { r: Hex; s: Hex } {
  let offset = 0;
  const readByte = (): number => {
    const value = der[offset];
    if (value === undefined) {
      throw new WebAuthnEnvelopeError("DER signature is truncated.");
    }
    offset += 1;
    return value;
  };
  if (readByte() !== 0x30) {
    throw new WebAuthnEnvelopeError("DER signature is not a SEQUENCE.");
  }
  const sequenceLength = readByte();
  if (sequenceLength > 0x7f) {
    throw new WebAuthnEnvelopeError("DER signature uses a long-form length.");
  }
  if (sequenceLength !== der.length - offset) {
    throw new WebAuthnEnvelopeError("DER SEQUENCE length does not fit.");
  }
  const readInteger = (): Hex => {
    if (readByte() !== 0x02) {
      throw new WebAuthnEnvelopeError("DER component is not an INTEGER.");
    }
    const length = readByte();
    const bytes = der.slice(offset, offset + length);
    if (bytes.length !== length) {
      throw new WebAuthnEnvelopeError("DER INTEGER is truncated.");
    }
    offset += length;
    // DER integers are signed and minimally encoded: strip a leading zero pad
    // and left-pad to the curve's 32-byte field width.
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0x00) start += 1;
    const trimmed = bytes.slice(start);
    if (trimmed.length > 32) {
      throw new WebAuthnEnvelopeError("DER INTEGER exceeds 32 bytes.");
    }
    const padded = new Uint8Array(32);
    padded.set(trimmed, 32 - trimmed.length);
    return toHex(padded);
  };
  const r = readInteger();
  const s = readInteger();
  if (offset !== der.length) {
    throw new WebAuthnEnvelopeError("DER signature has trailing bytes.");
  }
  return { r, s };
}

/** Encode a UTF-8 string to bytes. Exported so both sides agree on the encoding. */
export function utf8Bytes(value: string): Uint8Array {
  return stringToBytes(value);
}
