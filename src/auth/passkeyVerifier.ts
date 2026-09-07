/**
 * The passkey (WebAuthn / P-256) owner-signature backend, behind the existing
 * {@link Verifier} seam.
 *
 * FINDINGS (a) closed the door on browser EOAs: SDK 0.7.0 has no working
 * injected-signer path, so a MetaMask/Rabby user cannot be a wallet's root owner
 * at all. The two working owners are a raw private key and a passkey — a P-256
 * credential held by the platform authenticator, in device hardware for
 * device-bound credentials and SYNCED THROUGH THE USER'S PLATFORM ACCOUNT for
 * backup-eligible (BE=1) credentials, which is the common case.
 *
 * HOW IDENTITY WORKS HERE, since P-256 signatures do not encode their signer.
 * The envelope carries the credential's public key; this verifier verifies the
 * assertion against THAT key and returns `keccak`-derived address material from
 * it (see `passkeyOwnerAddress`). `verifyOwnerAction` then performs its unchanged
 * recovered-vs-declared match. Carrying an attacker-controlled public key in the
 * envelope is safe BECAUSE that match exists: a victim's key with an attacker's
 * signature fails the P-256 verify, and an attacker's key under a victim's
 * `signed.owner` fails the match.
 *
 * WHAT THAT RESTORES, PRECISELY. It restores the secp256k1 AUTHORIZATION model —
 * recover-then-compare, owner-scoped queries, zero new SERVER-SIDE storage. It
 * does NOT restore the secp256k1 CONSENT model. See the consent boundary on
 * {@link createWebAuthnVerifier}.
 */
import { webcrypto } from "node:crypto";
import {
  getAddress,
  hexToBytes,
  sha256,
  size,
  stringToBytes,
  type Address,
} from "viem";
import {
  OwnerAuthError,
  secp256k1Verifier,
  type RecoverInput,
  type Verifier,
} from "./ownerAuth.js";
import {
  decodeBase64UrlStrict,
  decodeWebAuthnEnvelope,
  ownerActionChallengeBytes,
  passkeyOwnerAddress,
} from "./webauthnEnvelope.js";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** The passkey backend's resolved configuration. Server-side and global. */
export type PasskeyConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      /** The relying-party id: a bare registrable domain, e.g. `4lpha.app`. */
      readonly rpId: string;
      /** EXACT serialized origins. No substring logic anywhere. */
      readonly origins: readonly string[];
      /**
       * Require the UV (user verified) flag. Default TRUE.
       *
       * UV lives inside `authenticatorData`, which the authenticator SIGNS, so
       * it is one of the very few things a browser tells us that the client
       * cannot forge. It is also the only thing standing between "the device is
       * unlocked" and "the human is present" for `revoke` and `changeBudget`.
       * GLOBAL and SERVER-SIDE ONLY — never a request field, never per-action.
       * The answer to per-read biometrics is the short-lived read-session token
       * in CLAUDE.md's UX note, not a lower UV bar.
       */
      readonly uvRequired: boolean;
    };

/** The disabled configuration. What a server that never heard of passkeys gets. */
export const PASSKEY_DISABLED: PasskeyConfig = { enabled: false };

/** The enabled half of {@link PasskeyConfig}, for callers that already branched. */
export type EnabledPasskeyConfig = Extract<PasskeyConfig, { enabled: true }>;

/* -------------------------------------------------------------------------- */
/* Authenticator-data flags                                                   */
/* -------------------------------------------------------------------------- */

/** User present. */
const FLAG_UP = 0x01;
/** User verified. */
const FLAG_UV = 0x04;
/** Backup eligible (the credential may be synced). */
const FLAG_BE = 0x08;
/** Backup state (the credential currently IS backed up). */
const FLAG_BS = 0x10;
/** Attested credential data present — a REGISTRATION artefact. */
const FLAG_AT = 0x40;
/** Extension data present. */
const FLAG_ED = 0x80;

/** Length of `authenticatorData` with neither attested data nor extensions. */
const AUTHENTICATOR_DATA_BASE_LENGTH = 37;

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a successful assertion establishes.
 *
 * `backupEligible` / `backupState` are surfaced rather than discarded because
 * they name the real custody boundary of the credential that just authorized an
 * owner action: BE=1 means the private key is synced through the user's
 * Apple/Google/1Password account and that account's recovery flow is part of the
 * trust boundary. BE=1 is ACCEPTED — refusing it would exclude most real users
 * and push them to a worse custody option — and the boundary is recorded here
 * and in the consent comment rather than pretended away.
 */
export type PasskeyAssertionResult = {
  readonly ownerAddress: Address;
  readonly backupEligible: boolean;
  readonly backupState: boolean;
  readonly userVerified: boolean;
};

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

const utf8 = new TextDecoder("utf-8", { fatal: true });

function refuse(reason: string): never {
  // ONE error type, ONE public message. The internal reason is for logs only and
  // `verifyOwnerAction` never surfaces it.
  throw new OwnerAuthError(`Passkey assertion rejected: ${reason}`);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Verify a WebAuthn assertion against the owner action it claims to authorize,
 * in the ONE order that is correct.
 *
 * Every step throws {@link OwnerAuthError}; the caller collapses all of them into
 * the single generic message, so a wrong origin, a stale challenge and a forged
 * signature are indistinguishable from outside.
 *
 *   1. canonical ABI-decode, tails bounded;
 *   2. `clientDataJSON`: strict UTF-8 → JSON → an actual object; `type`,
 *      challenge BYTES, exact origin, `crossOrigin` absent-or-false, `topOrigin`
 *      absent;
 *   3. `authenticatorData`: rpIdHash, UP, UV-when-required, AT clear,
 *      BE=0 ⇒ BS=0, length exactly 37 unless ED;
 *   4. pinned `importKey("raw", 0x04‖x‖y, …)` — this is what enforces on-curve,
 *      rejects `(0, 0)` and rejects out-of-range coordinates;
 *   5. `subtle.verify` over `authenticatorData ‖ sha256(clientDataJSON)`;
 *   6. derive the owner identity from the carried key.
 */
export async function verifyWebAuthnAssertion(
  input: RecoverInput,
  config: EnabledPasskeyConfig,
): Promise<PasskeyAssertionResult> {
  /* (1) ------------------------------------------------------------------- */
  // Re-thrown as the ONE error type so every rejection out of this function is
  // uniform. The decoder's own messages are fixed strings of ours — no caller
  // data — so carrying them into the internal reason leaks nothing and keeps a
  // malformed envelope diagnosable in a server log.
  let envelope: ReturnType<typeof decodeWebAuthnEnvelope>;
  try {
    envelope = decodeWebAuthnEnvelope(input.signature);
  } catch (error) {
    refuse(error instanceof Error ? error.message : "envelope decode failed");
  }

  /* (2) ------------------------------------------------------------------- */
  let clientDataText: string;
  try {
    clientDataText = utf8.decode(envelope.clientDataJSON);
  } catch {
    refuse("clientDataJSON is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientDataText);
  } catch {
    refuse("clientDataJSON is not valid JSON");
  }
  // `JSON.parse` returns `unknown`: `"123"`, `"null"` and `"[]"` are all valid
  // JSON. Reading `.type` off a string would yield `undefined` and refuse by
  // luck; refusing the shape makes it refuse by construction. A duplicate key
  // resolves last-wins, which is `JSON.parse`'s documented behaviour and is
  // pinned by test so it is a decision rather than an accident.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse("clientDataJSON is not a JSON object");
  }
  const clientData = parsed as Record<string, unknown>;

  if (clientData["type"] !== "webauthn.get") {
    // An attestation from `webauthn.create` must never authorize an action. Its
    // byte-level counterpart is the AT flag check below; checking one and not
    // the other would be inconsistent.
    refuse("clientData.type is not webauthn.get");
  }

  const challenge = clientData["challenge"];
  if (typeof challenge !== "string") refuse("clientData.challenge is missing");
  const challengeBytes = decodeBase64UrlStrict(challenge);
  if (challengeBytes === null) refuse("clientData.challenge is not base64url");
  // DECIDED: compare decoded BYTES, requiring exactly 32, rather than comparing
  // the base64url STRING. A padded challenge is then accepted and a 31- or
  // 33-byte decode refused, and the check cannot be broken by a client that
  // spells the same bytes differently. Nothing in this system is keyed on the
  // challenge string, so nothing is weakened.
  const expected = ownerActionChallengeBytes({
    domain: input.domain,
    message: input.message,
  });
  if (challengeBytes.length !== expected.length) {
    refuse("clientData.challenge is not 32 bytes");
  }
  if (!equalBytes(challengeBytes, expected)) {
    // THE authenticity check for this backend. The challenge is recomputed from
    // the domain the SERVER built, so an assertion made under a different
    // chainId or a different environment salt carries a different challenge and
    // dies here — before the owner match, with no dependence on an address
    // collision argument.
    refuse("clientData.challenge does not bind this owner action");
  }

  const origin = clientData["origin"];
  if (typeof origin !== "string" || !config.origins.includes(origin)) {
    // EXACT membership. No substring, no suffix logic: an allowlist containing
    // `https://4lpha.app` must not admit `https://evil-4lpha.app`.
    refuse("clientData.origin is not an allowlisted origin");
  }

  if (Object.hasOwn(clientData, "crossOrigin") && clientData["crossOrigin"] !== false) {
    refuse("clientData.crossOrigin is set");
  }
  // WebAuthn L3 adds `topOrigin`, present when `crossOrigin` is true. Requiring
  // it ABSENT keeps the two checks from disagreeing on a future client.
  if (Object.hasOwn(clientData, "topOrigin")) {
    refuse("clientData.topOrigin is present");
  }

  /* (3) ------------------------------------------------------------------- */
  const authData = envelope.authenticatorData;
  if (authData.length < AUTHENTICATOR_DATA_BASE_LENGTH) {
    refuse("authenticatorData is too short");
  }
  const rpIdHash = sha256(stringToBytes(config.rpId), "bytes");
  if (!equalBytes(authData.subarray(0, 32), rpIdHash)) {
    refuse("authenticatorData rpIdHash does not match the configured RP ID");
  }
  const flags = authData[32] ?? 0;
  if ((flags & FLAG_UP) === 0) refuse("user-present flag is clear");
  if (config.uvRequired && (flags & FLAG_UV) === 0) {
    refuse("user-verified flag is clear and UV is required");
  }
  if ((flags & FLAG_AT) !== 0) {
    // Attested credential data belongs to a registration, never to an assertion.
    refuse("attested-credential-data flag is set");
  }
  const backupEligible = (flags & FLAG_BE) !== 0;
  const backupState = (flags & FLAG_BS) !== 0;
  if (!backupEligible && backupState) {
    // WebAuthn L3 consistency rule: a credential that cannot be backed up cannot
    // be backed up.
    refuse("backup-state flag is set without backup-eligible");
  }
  if (
    (flags & FLAG_ED) === 0 &&
    authData.length !== AUTHENTICATOR_DATA_BASE_LENGTH
  ) {
    // With AT required clear, the only legitimate reason to exceed 37 bytes is
    // extension data. A longer blob with ED clear is malformed.
    refuse("authenticatorData is longer than 37 bytes with no extension data");
  }

  /* (4) ------------------------------------------------------------------- */
  // PINNED CALL. On-curve validation, the point at infinity and out-of-range
  // coordinates are ALL this call's, and the verification that it rejects them
  // (`DataError` on Node's webcrypto) is only meaningful for the exact format it
  // was measured against: uncompressed SEC1, `raw`, P-256. Pinned by test.
  const keyBytes = new Uint8Array(65);
  keyBytes[0] = 0x04;
  keyBytes.set(hexToBytes(envelope.x), 1);
  keyBytes.set(hexToBytes(envelope.y), 33);
  let key: webcrypto.CryptoKey;
  try {
    key = await webcrypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    refuse("credential public key is not a valid P-256 point");
  }

  /* (5) ------------------------------------------------------------------- */
  // The WebAuthn signature base. `envelope.signature` is `r ‖ s` and is exactly
  // 64 bytes BY CONSTRUCTION of the `bytes32 r, bytes32 s` tuple — the ABI
  // decode guarantees it, which is why the tuple is not `bytes signature`.
  // `r = 0` and `s ≥ n` are rejected by the verify itself (an OpenSSL property,
  // relied on and therefore pinned by test), so no explicit range check exists.
  const base = new Uint8Array(authData.length + 32);
  base.set(authData, 0);
  base.set(sha256(envelope.clientDataJSON, "bytes"), authData.length);
  const ok = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    envelope.signature,
    base,
  );
  if (!ok) refuse("P-256 signature does not verify");

  /* (6) ------------------------------------------------------------------- */
  return {
    ownerAddress: passkeyOwnerAddress(envelope.x, envelope.y),
    backupEligible,
    backupState,
    userVerified: (flags & FLAG_UV) !== 0,
  };
}

/**
 * The WebAuthn {@link Verifier}.
 *
 * ── PASSKEY CONSENT BOUNDARY ────────────────────────────────────────────────
 * An EIP-712 signature is DISPLAYED by the wallet: the signer reads
 * `action: "revoke"`, `agentId`, `paramsHash`, `expiry` before approving, and
 * that display is a load-bearing part of why a per-action owner signature means
 * anything. A WebAuthn assertion displays NOTHING BUT THE RELYING PARTY. The
 * challenge is 43 opaque base64url characters and the platform prompt says "Use
 * Touch ID to sign in to 4lpha.app".
 *
 * So, stated plainly rather than claimed away: an assertion proves the
 * credential was exercised on an ALLOWLISTED ORIGIN with user verification. It
 * does NOT prove the human understood which owner action they authorized, and a
 * user touching the sensor to log in will touch it for an attacker's
 * `changeBudget` in exactly the same way. SCRIPT EXECUTION ON AN ALLOWLISTED
 * ORIGIN IS EQUIVALENT TO OWNER AUTHORITY FOR EVERY MEMBER OF `OwnerActionType`,
 * for as long as the script runs — it can mint fresh assertions at will.
 * `PASSKEY_ORIGINS` and `PASSKEY_RP_ID` are therefore the entire defense at this
 * layer, with `PASSKEY_UV_REQUIRED` the third.
 *
 * For a BE=1 (synced) credential — the common case — the private key lives in
 * the user's Apple/Google/1Password account, so that account and its recovery
 * flow are inside the boundary too. Accepted, because refusing synced passkeys
 * would exclude most real users and push them to a worse custody option.
 *
 * The HARD STOPS remain the ones that always were, and none of them is affected
 * by any of the above: on-chain caps, the call allowlist, session expiry, and an
 * owner-signed on-chain revoke.
 *
 * ── RP-ID DEPLOYMENT INVARIANT (NORMATIVE) ──────────────────────────────────
 * `PASSKEY_RP_ID` MUST be an RP ID at which NO OTHER CEREMONY signs an
 * unstructured caller-supplied challenge. WebAuthn scopes a credential by RP ID,
 * not by purpose, so any such ceremony is a signing oracle for this server: feed
 * it this server's challenge and the resulting assertion verifies here,
 * unmodified. If the marketplace adds passkey LOGIN it MUST use a different RP
 * ID (a distinct registrable subdomain) or tag its own challenges disjointly.
 * The Altana SDK's passkey signer MUST be audited against this before the
 * marketplace ships — FINDINGS (a) makes that passkey the wallet's lasting
 * on-chain authority, and it signs in the same page. If it signs arbitrary
 * caller digests at our RP ID, the owner-auth credential must be a DIFFERENT
 * credential at a DIFFERENT RP ID.
 *
 * ── RESIDUALS, DECIDED RATHER THAN IGNORED ──────────────────────────────────
 * MALLEABILITY. A flipped-`s` P-256 signature verifies for the same message and
 * key (MEASURED). It grants nothing for a MUTATING action: identity comes from
 * the carried public key, which flipping `s` does not change, and single-use is
 * keyed on `signed.nonce`, so the "second" signature replays into a consumed
 * nonce. `read` is deliberately NOT nonce-consumed (`READ_ACTION_NONCE_POLICY`),
 * so a flipped-`s` read assertion is simply a second valid read envelope —
 * accepted for the same reason a byte-identical read replay is accepted: a read
 * has no second side effect.
 *
 * signCount. NOT enforced. It is a clone-detection heuristic needing
 * per-credential persisted state — the store this design exists to avoid — and
 * major platform authenticators return a constant 0, making enforcement either
 * vacuous or false-positive-prone. Be honest about the compensating controls: a
 * cloned or exfiltrated credential MINTS FRESH ASSERTIONS, so signature windows
 * and nonces bound replay, not cloning, and bound it not at all here. What
 * bounds a cloned credential is what bounds a leaked owner key generally — the
 * server-side refusal (pause/emergency-kill, a LIVENESS control), and the hard
 * stops above. Re-binding an agent to a new credential is an OPERATOR action,
 * not an owner one.
 */
export function createWebAuthnVerifier(config: EnabledPasskeyConfig): Verifier {
  return {
    async recover(input: RecoverInput): Promise<Address> {
      const result = await verifyWebAuthnAssertion(input, config);
      return getAddress(result.ownerAddress);
    },
  };
}

/**
 * The dispatching verifier: secp256k1 for a 65-byte signature, WebAuthn for
 * anything else.
 *
 * Dispatch is by STRUCTURAL DISJOINTNESS, not by a scheme field, and both halves
 * are measured facts rather than arguments:
 *
 *   - viem's `recoverPublicKey` throws unless the signature is EXACTLY 65 bytes
 *     (`node_modules/viem/utils/signature/recoverPublicKey.ts:46`,
 *     `if (size(signatureHex) !== 65) throw`), so `size === 65` is precisely
 *     today's accepted secp256k1 set — no 64-byte ERC-2098 compact signature is
 *     accepted now, and none would be diverted later;
 *   - the minimum valid WebAuthn envelope encoding is 256 bytes, and a 65-byte
 *     blob raises `PositionOutOfBoundsError` in the ABI decoder.
 *
 * That coupling is to a PINNED dependency version: a viem bump that widened
 * `recoverPublicKey` to accept 64-byte compact signatures would silently move
 * those inputs to the WebAuthn branch. Both halves are pinned by test so such a
 * bump breaks a test instead of the dispatch.
 *
 * An explicit `scheme` field would perform the same routing while adding an
 * envelope change, a schema break for existing clients, and an unauthenticated
 * field whose only power is to make a request fail differently.
 */
export function createDispatchingVerifier(config: PasskeyConfig): Verifier {
  const webauthn = config.enabled ? createWebAuthnVerifier(config) : null;
  return {
    async recover(input: RecoverInput): Promise<Address> {
      if (size(input.signature) === 65) {
        // BYTE-FOR-BYTE the Phase 1b path. Nothing about passkeys gates it.
        return secp256k1Verifier.recover(input);
      }
      if (webauthn === null) {
        // Refused BEFORE any parsing: a deployment that has not switched
        // passkeys on behaves exactly as it did in 1b, and cannot half-enable
        // them by accident.
        throw new OwnerAuthError("Passkey backend is disabled.");
      }
      return webauthn.recover(input);
    },
  };
}
