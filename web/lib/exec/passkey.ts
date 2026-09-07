/**
 * Browser-side port of the execution plane's WebAuthn owner-action ceremony.
 *
 * CONSENSUS-CRITICAL DUPLICATE, exactly like `owner-action.ts`: everything here
 * must reproduce `src/auth/webauthnEnvelope.ts` byte for byte — the owner
 * derivation (`4lpha-p256-owner:v1:`), the tagged challenge
 * (`4lpha-owner-action:v1:` over the EIP-712 digest) and the ABI envelope the
 * plane's ONE decoder accepts. `web/` may not import from `../src/`, so the wire
 * format is ported by hand and PINNED by golden vectors generated from the plane
 * itself (`passkey.test.ts`). A divergence surfaces as a generic 401 from the
 * plane — a bug that looks exactly like a forgery.
 *
 * THE IDENTITY THIS PRODUCES IS NOT AN ACCOUNT. `ownerAddressFromPasskey` is a
 * keccak of the credential's public key; no secp256k1 key exists for it and
 * value sent there is burned. Never render it as a deposit target.
 *
 * CONSENT BOUNDARY (CLAUDE.md, PHASE1.5): the authenticator displays the
 * relying party, never the action. An assertion proves the credential was
 * exercised on an allowlisted origin with user verification — not that the human
 * understood which owner action they approved.
 */

import {
  concat,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  sha256,
  size,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  buildOwnerAction,
  execDomainConfigFromEnv,
  type ExecDomainConfig,
  type OwnerActionEnvelope,
} from "./owner-action";

/* -------------------------------------------------------------------------- */
/* The wire format (port of src/auth/webauthnEnvelope.ts)                     */
/* -------------------------------------------------------------------------- */

/** The plane's `WEBAUTHN_ENVELOPE_PARAMS`, field order included. */
export const WEBAUTHN_ENVELOPE_PARAMS = [
  { name: "x", type: "bytes32" },
  { name: "y", type: "bytes32" },
  { name: "authenticatorData", type: "bytes" },
  { name: "clientDataJSON", type: "bytes" },
  { name: "r", type: "bytes32" },
  { name: "s", type: "bytes32" },
] as const;

/** Versioned and load-bearing: it is part of a PERSISTED identity. */
export const PASSKEY_OWNER_TAG = "4lpha-p256-owner:v1:";

/** Versioned purpose tag on the WebAuthn challenge. */
export const OWNER_ACTION_CHALLENGE_TAG = "4lpha-owner-action:v1:";

export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyError";
  }
}

function assertBytes32(value: Hex, field: string): void {
  if (size(value) !== 32) throw new PasskeyError(`${field} must be exactly 32 bytes.`);
}

/**
 * `ownerAddress = getAddress(keccak256("4lpha-p256-owner:v1:" ‖ x ‖ y)[12..32])`.
 *
 * The tag is what keeps this STRUCTURALLY separate from a secp256k1 address;
 * `keccak(x‖y)[12..]` alone is literally the EOA derivation. Checksummed,
 * matching what the agent store's `ownerKey` validates.
 */
export function ownerAddressFromPasskey(x: Hex, y: Hex): Address {
  assertBytes32(x, "x");
  assertBytes32(y, "y");
  const hash = keccak256(concat([stringToHex(PASSKEY_OWNER_TAG), x, y]));
  return getAddress(`0x${hash.slice(26)}`);
}

/** The typed-data bundle `buildOwnerAction` hands back. */
type OwnerActionTypedData = ReturnType<typeof buildOwnerAction>["typedData"];

/**
 * `sha256(utf8("4lpha-owner-action:v1:") ‖ hashTypedData(...))` — the 32 bytes
 * the assertion must carry. The inner digest is the SAME one a secp256k1 owner
 * signs, so chain/salt separation, `paramsHash` binding and the nonce all
 * transfer unchanged. The digest is concatenated RAW, not as its hex string.
 */
export function ownerActionChallengeBytes(
  typedData: OwnerActionTypedData,
): Uint8Array<ArrayBuffer> {
  const digest = hashTypedData(typedData);
  const bytes = sha256(concat([stringToHex(OWNER_ACTION_CHALLENGE_TAG), digest]), "bytes");
  // Copied into an owned ArrayBuffer so the WebAuthn DOM types accept it.
  const challenge = new Uint8Array(new ArrayBuffer(bytes.length));
  challenge.set(bytes);
  return challenge;
}

/** THE encoder. Same parameter list, same order, as the plane's decoder reads. */
export function encodeWebAuthnEnvelope(input: {
  readonly x: Hex;
  readonly y: Hex;
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  readonly r: Hex;
  readonly s: Hex;
}): Hex {
  for (const [field, value] of [["x", input.x], ["y", input.y], ["r", input.r], ["s", input.s]] as const) {
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
 * DER `SEQUENCE { INTEGER r, INTEGER s }` → fixed 32-byte halves.
 *
 * The authenticator emits DER; the envelope has no place for it, which is how
 * the plane keeps an ASN.1 parser out of the authorization path. The ten lines
 * live here instead.
 */
export function derToP1363(der: Uint8Array): { readonly r: Hex; readonly s: Hex } {
  let offset = 0;
  const readByte = (): number => {
    const value = der[offset];
    if (value === undefined) throw new PasskeyError("DER signature is truncated.");
    offset += 1;
    return value;
  };
  if (readByte() !== 0x30) throw new PasskeyError("DER signature is not a SEQUENCE.");
  const sequenceLength = readByte();
  if (sequenceLength > 0x7f) throw new PasskeyError("DER signature uses a long-form length.");
  if (sequenceLength !== der.length - offset) throw new PasskeyError("DER SEQUENCE length does not fit.");
  const readInteger = (): Hex => {
    if (readByte() !== 0x02) throw new PasskeyError("DER component is not an INTEGER.");
    const length = readByte();
    const bytes = der.slice(offset, offset + length);
    if (bytes.length !== length) throw new PasskeyError("DER INTEGER is truncated.");
    offset += length;
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0x00) start += 1;
    const trimmed = bytes.slice(start);
    if (trimmed.length > 32) throw new PasskeyError("DER INTEGER exceeds 32 bytes.");
    const padded = new Uint8Array(32);
    padded.set(trimmed, 32 - trimmed.length);
    return toHex(padded);
  };
  const r = readInteger();
  const s = readInteger();
  if (offset !== der.length) throw new PasskeyError("DER signature has trailing bytes.");
  return { r, s };
}

/** base64url, no padding — WebAuthn L2 §5.8.1, and what the plane decodes. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/* `Uint8Array<ArrayBuffer>` rather than the default: the WebAuthn DOM types
   require a non-shared buffer, and a plain `Uint8Array` widens to
   `ArrayBufferLike`. Same reason on `randomBytes` below. */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/* -------------------------------------------------------------------------- */
/* The stored credential                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What registration leaves behind, and why the browser has no choice but to
 * hold it: `navigator.credentials.get()` returns neither the public key nor a
 * credential list. `(x, y)` is needed to build the envelope AND to compute
 * `signed.owner`; `credentialId` pins `allowCredentials` so a different
 * credential at the same RP can never be exercised against this owner.
 *
 * Per-browser state that clearing site data wipes. Security-wise that is fine —
 * substituting `(x, y)` still cannot sign — but a synced passkey on a NEW device
 * cannot be used until the UI can recover the key from Altana's on-chain passkey
 * record. That gap is real and is stated in the UI copy.
 */
export type StoredPasskey = {
  readonly x: Hex;
  readonly y: Hex;
  /** base64url, exactly as `create()` returned `rawId`. */
  readonly credentialId: string;
  readonly rpId: string;
  readonly createdAt: number;
  readonly label?: string;
  /**
   * The ALTANA SMART-ACCOUNT ADDRESS (wallet B) this credential is the admin
   * key of — a second, unrelated address to `ownerAddressFromPasskey`.
   *
   * OPTIONAL because an R5-era record was created by the raw ceremony below,
   * which never ran Altana's `createPasskeyWallet`, so no wallet exists for it
   * and none can be inferred. Absent means "no wallet yet"; it is never
   * silently backfilled (MARKETPLACE-WALLET-B D1).
   *
   * This is the ONLY address on the passkey record that is payable. `x`/`y`
   * derive the owner IDENTITY, which burns anything sent to it.
   */
  readonly walletAddress?: Address;
};

/* -------------------------------------------------------------------------- */
/* Altana credential interop                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The SDK's `PasskeyCredential` (webauthn variant), restated structurally.
 *
 * Restated rather than imported so this module stays free of
 * `@altananetwork/sdk` — it is the consensus-critical envelope codec, it is
 * unit-tested in a node environment with no DOM, and the SDK pulls porto plus a
 * relay client behind it. `web/lib/altana/client.ts` is the one module that
 * imports the SDK, and it asserts this type is assignable to the real one.
 */
export type AltanaPasskeyCredential = {
  readonly kind: "webauthn";
  /** base64url, NOT 0x-hex — the same encoding as `StoredPasskey.credentialId`. */
  readonly id: string;
  /** Flat P256 point `x‖y`, 64 bytes, WITHOUT the SEC1 `0x04` prefix. */
  readonly publicKey: Hex;
  readonly rpId?: string;
};

/** Our record → the shape `signerFromPasskey` rehydrates a signer from. */
export function toAltanaCredential(record: StoredPasskey): AltanaPasskeyCredential {
  assertBytes32(record.x, "x");
  assertBytes32(record.y, "y");
  return {
    kind: "webauthn",
    id: record.credentialId,
    // Flat, no 0x04: Porto's relay wire form. Concatenating the two halves we
    // already hold is exact — `coordinatesFromSpki` produced them by stripping
    // the prefix off the same uncompressed point.
    publicKey: concat([record.x, record.y]),
    ...(record.rpId ? { rpId: record.rpId } : {}),
  };
}

/**
 * Altana's credential → our record, splitting the flat key at 32 bytes.
 *
 * The split is the whole risk of this cluster (spec R-CRED): our owner
 * derivation hashes `x‖y`, so a wrong offset produces a DIFFERENT owner address
 * that the plane will refuse with a generic 401. Pinned by golden vector.
 */
export function fromAltanaCredential(
  credential: AltanaPasskeyCredential,
  walletAddress: Address,
  extra?: { readonly rpId?: string; readonly label?: string; readonly createdAt?: number },
): StoredPasskey {
  if (credential.kind !== "webauthn") {
    throw new PasskeyError("Only a WebAuthn credential can be an owner identity.");
  }
  if (size(credential.publicKey) !== 64) {
    throw new PasskeyError("An Altana passkey public key must be 64 bytes (x‖y, no 0x04 prefix).");
  }
  if (credential.id.length === 0) throw new PasskeyError("The credential id is empty.");
  const flat = credential.publicKey.slice(2);
  const rpId = credential.rpId ?? extra?.rpId;
  if (!rpId) throw new PasskeyError("The credential carries no relying-party id.");
  return {
    x: `0x${flat.slice(0, 64)}`,
    y: `0x${flat.slice(64, 128)}`,
    credentialId: credential.id,
    rpId: rpId.toLowerCase(),
    createdAt: extra?.createdAt ?? Math.floor(Date.now() / 1000),
    ...(extra?.label ? { label: extra.label } : {}),
    walletAddress: getAddress(walletAddress),
  };
}

export const PASSKEY_STORAGE_KEY = "4lpha.passkey.owner.v1";
const STORAGE_KEY = PASSKEY_STORAGE_KEY;

/** Capture selection, not just owner: even switching away and back invalidates work. */
export function activePasskeyGuard(record: StoredPasskey): () => void {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  return () => {
    const current = loadStoredPasskey();
    if (raw === null || globalThis.localStorage?.getItem(STORAGE_KEY) !== raw || !current
      || current.credentialId !== record.credentialId || current.rpId !== record.rpId
      || current.x !== record.x || current.y !== record.y || current.walletAddress !== record.walletAddress) {
      throw new PasskeyError("Account changed. Open the account and try again.");
    }
  };
}

function isStoredPasskey(value: unknown): value is StoredPasskey {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["x"] === "string" && /^0x[0-9a-f]{64}$/iu.test(row["x"]) &&
    typeof row["y"] === "string" && /^0x[0-9a-f]{64}$/iu.test(row["y"]) &&
    typeof row["credentialId"] === "string" && row["credentialId"].length > 0 &&
    typeof row["rpId"] === "string" && row["rpId"].length > 0 &&
    typeof row["createdAt"] === "number" &&
    // Absent is legal (an R5 record). Present-but-malformed is not: a bad
    // wallet address would be offered as a deposit target.
    (row["walletAddress"] === undefined ||
      (typeof row["walletAddress"] === "string" && /^0x[0-9a-f]{40}$/iu.test(row["walletAddress"])))
  );
}

/** Every storage touch is wrapped: private mode and blocked site data both throw. */
/**
 * Memoised by the RAW storage string. useSyncExternalStore compares
 * snapshots by reference and re-renders until two consecutive calls agree, so
 * parsing a fresh object on every call is an infinite loop ("The result of
 * getSnapshot should be cached"). Same string -> same object; a different
 * string (store / forget / another tab) -> one new parse.
 */
let snapshotRaw: string | null | undefined;
let snapshotValue: StoredPasskey | null = null;

export function loadStoredPasskey(): StoredPasskey | null {
  let raw: string | null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === snapshotRaw) return snapshotValue;
  snapshotRaw = raw;
  if (raw === null) {
    snapshotValue = null;
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    snapshotValue = isStoredPasskey(parsed) ? parsed : null;
  } catch {
    snapshotValue = null;
  }
  return snapshotValue;
}

export function storePasskey(credential: StoredPasskey): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(credential));
  } catch {
    /* A credential we cannot persist still signs for this page's lifetime. */
  }
  notify();
}

export function forgetStoredPasskey(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
  notify();
}

/* A minimal store so React can subscribe without polling localStorage. */
const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) listener();
}
export function subscribeToPasskey(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The RP ID this deployment registers under. MUST match the plane's `PASSKEY_RP_ID`. */
export function passkeyRpId(): string {
  const configured = process.env["NEXT_PUBLIC_PASSKEY_RP_ID"]?.trim();
  if (configured) return configured.toLowerCase();
  return typeof globalThis.location === "undefined" ? "" : globalThis.location.hostname;
}

export function passkeyEnabled(): boolean {
  return process.env["NEXT_PUBLIC_PASSKEY_ENABLED"] === "true";
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Pull `(x, y)` out of a registration response.
 *
 * `getPublicKey()` returns SPKI. Rather than slicing bytes off a DER structure,
 * import it and export `raw` — WebCrypto then answers with the uncompressed SEC1
 * point (`0x04 ‖ x ‖ y`), which is precisely the form the plane re-imports on
 * the verify path. A key WebCrypto refuses here would be refused there too.
 */
async function coordinatesFromSpki(spki: ArrayBuffer): Promise<{ x: Hex; y: Hex }> {
  const key = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    [],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new PasskeyError("The authenticator did not return an uncompressed P-256 key.");
  }
  return { x: toHex(raw.subarray(1, 33)), y: toHex(raw.subarray(33, 65)) };
}

/**
 * Create the owner credential. ES256 only, user verification REQUIRED (the
 * plane's default `PASSKEY_UV_REQUIRED`), resident key preferred so the
 * credential is discoverable on this device.
 */
export async function createOwnerPasskey(input: {
  readonly rpId: string;
  readonly userName: string;
  readonly rpName?: string;
}): Promise<StoredPasskey> {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new PasskeyError("This browser does not support passkeys.");
  }
  const created = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { id: input.rpId, name: input.rpName ?? "4lpha" },
      // The user handle is per-credential random: this ceremony carries no
      // account system, and a guessable handle would link credentials.
      user: { id: randomBytes(16), name: input.userName, displayName: input.userName },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "preferred",
        requireResidentKey: false,
      },
      attestation: "none",
      timeout: 120_000,
    },
  });
  if (created === null || !("rawId" in created)) {
    throw new PasskeyError("Passkey creation was cancelled.");
  }
  const credential = created as PublicKeyCredential;
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  if (!spki) {
    throw new PasskeyError("The authenticator did not return a public key.");
  }
  const { x, y } = await coordinatesFromSpki(spki);
  const record: StoredPasskey = {
    x,
    y,
    credentialId: encodeBase64Url(new Uint8Array(credential.rawId)),
    rpId: input.rpId,
    createdAt: Math.floor(Date.now() / 1000),
    label: input.userName,
  };
  storePasskey(record);
  return record;
}

/* -------------------------------------------------------------------------- */
/* Assertion                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the `signature` field from an authenticator response. Split out from
 * the ceremony so it is testable without a DOM — the golden vectors and the
 * cross-check against the plane's verifier both go through this function.
 */
export function assembleOwnerActionSignature(input: {
  readonly credential: Pick<StoredPasskey, "x" | "y">;
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
 * Sign ONE owner action with the stored passkey and return the plane's envelope.
 *
 * `signed.owner` is the DERIVED identity, so it sits inside the EIP-712 struct,
 * inside the digest, inside the challenge — the assertion is bound to the exact
 * owner it claims. `allowCredentials` is pinned to the one credential whose key
 * produced that owner.
 */
export async function signOwnerActionWithPasskey(input: {
  readonly credential: StoredPasskey;
  readonly agentId: string;
  readonly action: string;
  readonly params: unknown;
  readonly domain?: ExecDomainConfig;
}): Promise<OwnerActionEnvelope> {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new PasskeyError("This browser does not support passkeys.");
  }
  const owner = ownerAddressFromPasskey(input.credential.x, input.credential.y);
  const { signed, typedData } = buildOwnerAction({
    owner,
    agentId: input.agentId,
    action: input.action,
    params: input.params,
    domain: input.domain ?? execDomainConfigFromEnv(),
  });
  const challenge = ownerActionChallengeBytes(typedData);
  const asserted = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: input.credential.rpId,
      allowCredentials: [
        { id: decodeBase64Url(input.credential.credentialId), type: "public-key" },
      ],
      userVerification: "required",
      timeout: 120_000,
    },
  });
  if (asserted === null || !("rawId" in asserted)) {
    throw new PasskeyError("Passkey approval was cancelled.");
  }
  const response = (asserted as PublicKeyCredential).response as AuthenticatorAssertionResponse;
  const signature = assembleOwnerActionSignature({
    credential: input.credential,
    authenticatorData: new Uint8Array(response.authenticatorData),
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    derSignature: new Uint8Array(response.signature),
  });
  return { signed, signature, params: input.params };
}
