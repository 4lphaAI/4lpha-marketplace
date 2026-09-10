/**
 * The TermiX Quant envelope: X25519 + HKDF-SHA256 + ChaCha20-Poly1305.
 *
 * REIMPLEMENTED from the skill package's own `aacp-session.mjs` (v1.7.0)
 * rather than executed inside our worker, because running a third-party script
 * in the process that holds the decryption seed puts the seed inside that
 * script's blast radius. Correctness is pinned by GOLDEN VECTORS produced once,
 * offline, by their `deriveKeypair` + `sealForSelfTest` with a throwaway seed
 * (`test/fixtures/quant/termix-envelope-golden.json`, W2): a mismatch is a test
 * failure at build time, not a surprise at runtime.
 *
 * `node:crypto` only — zero dependencies, no network, no clock.
 *
 * ─── THE SECRET SURFACE ────────────────────────────────────────────────────
 *
 * {@link deriveKeypair} and {@link open} are the two functions that touch the
 * seed and the plaintext. R3.11 / BC11 pins them: they may be imported BY NAME
 * from exactly two files (`src/quant/execute.ts`, `src/quant/admission.ts`),
 * never re-exported under any name, never namespace-imported, and never
 * imported by a composition root. `test/quant.boundary.test.ts` enforces every
 * one of those forms, including the alias `export { open as decrypt }`.
 *
 * NOTHING here logs, persists, or returns the seed. {@link deriveKeypair}
 * returns the PUBLIC key as bytes and the private key as an opaque
 * `KeyObject`; the seed itself is zeroed after derivation.
 */
import {
  createDecipheriv,
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

/**
 * The algorithm string the skill sends with every envelope and with
 * `register-key`, read from `aacp-quant.mjs` on 2026-09-10 and pinned by a
 * test. An envelope declaring anything else is REFUSED — we do not have a
 * second algorithm and a best-effort parse of an unknown one is how a
 * downgrade gets accepted.
 */
export const QUANT_ENVELOPE_ALGORITHM = "x25519-hkdf-chacha20poly1305" as const;

/** HKDF info string for the KEY derivation. Salt is empty (the skill's shape). */
const HKDF_INFO_KEY = "termix-quant-x25519-v1";

/** HKDF info string for the ENVELOPE derivation. Salt is the ephemeral pubkey. */
const HKDF_INFO_ENVELOPE = "termix-quant-envelope-v1";

/**
 * DER prefixes for raw X25519 keys.
 *
 * Node's `createPrivateKey`/`createPublicKey` take DER, and X25519 keys have a
 * fixed-length encoding, so the prefix is a constant rather than a parse. Both
 * are recorded in the golden-vector fixture, so a change in either would fail
 * the round trip rather than produce a subtly wrong key.
 */
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const X25519_KEY_BYTES = 32;
const CHACHA_NONCE_BYTES = 12;
const POLY1305_TAG_BYTES = 16;

/** A sealed session as the inbox delivers it. Every field is base64. */
export type QuantEnvelope = {
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly algorithm: string;
};

export type QuantKeypair = {
  /** Raw 32-byte X25519 public key. Safe to publish; this IS `register-key`. */
  readonly publicKey: Buffer;
  /** Opaque private handle. Never serialized, never logged. */
  readonly privateKey: KeyObject;
};

/** Every failure this module can produce, as a fixed code. */
export type QuantEnvelopeErrorCode =
  | "seed-invalid"
  | "envelope-algorithm-unsupported"
  | "envelope-malformed"
  | "envelope-invalid"
  | "recipient-invalid";

export class QuantEnvelopeError extends Error {
  readonly code: QuantEnvelopeErrorCode;

  constructor(code: QuantEnvelopeErrorCode) {
    // The message is built from the CODE and nothing else. An envelope error
    // carrying upstream text would be a channel for ciphertext or key material
    // to reach a log line.
    super(`Quant envelope refused: ${code}.`);
    this.name = "QuantEnvelopeError";
    this.code = code;
  }
}

/**
 * The skill's key derivation, verbatim.
 *
 * `ikm` is the WALLET_KEY **as the 0x-hex STRING's utf-8 bytes** — not the 32
 * bytes it spells. That is what their script passes, and deriving from the
 * decoded bytes instead produces a different, silently-wrong public key that
 * would register fine and open nothing. The golden vector is the only thing
 * that can catch that, which is why it exists.
 */
export function deriveKeypair(seedHex: string): QuantKeypair {
  const trimmed = seedHex.trim();
  if (!/^0x[0-9a-fA-F]{64}$/u.test(trimmed)) {
    throw new QuantEnvelopeError("seed-invalid");
  }
  const seed = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(trimmed, "utf8"),
      Buffer.alloc(0),
      Buffer.from(HKDF_INFO_KEY, "utf8"),
      X25519_KEY_BYTES,
    ),
  );
  try {
    const privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_X25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = Buffer.from(
      createPublicKey(privateKey)
        .export({ format: "der", type: "spki" })
        .subarray(SPKI_X25519_PREFIX.length),
    );
    return { publicKey, privateKey };
  } finally {
    seed.fill(0);
  }
}

function rawPublicKeyObject(raw: Buffer): KeyObject {
  if (raw.length !== X25519_KEY_BYTES) {
    throw new QuantEnvelopeError("recipient-invalid");
  }
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_X25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new QuantEnvelopeError("recipient-invalid");
  }
}

/**
 * Decode a base64 field STRICTLY.
 *
 * Node's base64 decoder is permissive: it drops anything it does not
 * recognise, so a truncated or corrupted field decodes to a shorter buffer
 * instead of failing. Re-encoding and comparing is what turns that into a
 * refusal.
 */
function decodeBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new QuantEnvelopeError("envelope-malformed");
  }
  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/u, "");
  if (canonical !== value.replace(/=+$/u, "")) {
    throw new QuantEnvelopeError("envelope-malformed");
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new QuantEnvelopeError("envelope-malformed");
  }
  return decoded;
}

function envelopeKey(shared: Buffer, ephemeralPublicKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      ephemeralPublicKey,
      Buffer.from(HKDF_INFO_ENVELOPE, "utf8"),
      X25519_KEY_BYTES,
    ),
  );
}

/**
 * Open a sealed envelope to its plaintext STRING.
 *
 * The returned string is the serialized Altana session — the client's money.
 * It is never persisted, never logged, and never leaves the one closure that
 * calls this (spec §3.2, and `test/quant.execute.test.ts` scans every persisted
 * string for it).
 *
 * A tampered ciphertext, a wrong recipient and a wrong nonce are all
 * `envelope-invalid`: Poly1305 does not distinguish them and neither do we.
 */
export function open(envelope: QuantEnvelope, keypair: QuantKeypair): string {
  if (envelope === null || typeof envelope !== "object") {
    throw new QuantEnvelopeError("envelope-malformed");
  }
  if (envelope.algorithm !== QUANT_ENVELOPE_ALGORITHM) {
    throw new QuantEnvelopeError("envelope-algorithm-unsupported");
  }
  const ephemeral = decodeBase64(envelope.ephemeralPublicKey, X25519_KEY_BYTES);
  const nonce = decodeBase64(envelope.nonce, CHACHA_NONCE_BYTES);
  const sealed = decodeBase64(envelope.ciphertext);
  if (sealed.length <= POLY1305_TAG_BYTES) {
    throw new QuantEnvelopeError("envelope-malformed");
  }
  const body = sealed.subarray(0, sealed.length - POLY1305_TAG_BYTES);
  const tag = sealed.subarray(sealed.length - POLY1305_TAG_BYTES);

  let shared: Buffer;
  try {
    shared = diffieHellman({
      privateKey: keypair.privateKey,
      publicKey: rawPublicKeyObject(ephemeral),
    });
  } catch {
    throw new QuantEnvelopeError("envelope-invalid");
  }
  const key = envelopeKey(shared, ephemeral);
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, nonce, {
      authTagLength: POLY1305_TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new QuantEnvelopeError("envelope-invalid");
  } finally {
    key.fill(0);
    shared.fill(0);
  }
}

/**
 * Our seal — the test-only twin of the skill's `sealForSelfTest`.
 *
 * It exists for exactly two callers: the round-trip tests, and
 * `live-quant self-test`, which seals a session WE granted to OUR OWN public
 * key so the mainnet proof runs the production open/admission/execute path
 * without TermiX in it (R2.10). It seals to a recipient's raw public key and
 * has no way to reach a seed.
 */
export function seal(
  plaintext: string,
  recipientPublicKey: Buffer,
  options?: { readonly nonce?: Buffer },
): QuantEnvelope {
  const recipient = rawPublicKeyObject(recipientPublicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = Buffer.from(
    ephemeral.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(SPKI_X25519_PREFIX.length),
  );
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipient,
  });
  const key = envelopeKey(shared, ephemeralRaw);
  const nonce = options?.nonce ?? randomBytes(CHACHA_NONCE_BYTES);
  if (nonce.length !== CHACHA_NONCE_BYTES) {
    throw new QuantEnvelopeError("envelope-malformed");
  }
  try {
    const cipher = createCipheriv("chacha20-poly1305", key, nonce, {
      authTagLength: POLY1305_TAG_BYTES,
    });
    const body = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    return {
      ephemeralPublicKey: ephemeralRaw.toString("base64"),
      nonce: nonce.toString("base64"),
      ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
      algorithm: QUANT_ENVELOPE_ALGORITHM,
    };
  } finally {
    key.fill(0);
    shared.fill(0);
  }
}

/**
 * Whether a raw public key equals the one TermiX has registered for us.
 *
 * Constant-time, because it is compared against a value fetched over the
 * network and there is no reason to leak the position of the first difference.
 */
export function publicKeyEquals(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
