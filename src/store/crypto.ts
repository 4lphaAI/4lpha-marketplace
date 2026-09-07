/**
 * Envelope encryption for agent session keys at rest.
 *
 * A session key is the one secret this substrate holds that can move a user's
 * funds. It is never stored in a jsonb blob and never logged; it lives in its
 * own column, AES-256-GCM encrypted under a master key supplied out-of-band via
 * `EXECUTION_MASTER_KEY`.
 *
 * The master key is 32 bytes, provided as 64 hex chars (with or without a `0x`
 * prefix) or as base64. A wrong length is a hard error rather than a silent
 * truncation — an under-length key would weaken every ciphertext without a
 * single visible symptom.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

/** Name of the env var holding the master key. */
export const MASTER_KEY_ENV = "EXECUTION_MASTER_KEY";

/**
 * Parse a raw master-key string into a 32-byte buffer.
 *
 * Accepts hex (64 chars, optional `0x`) or base64. Throws on any other length
 * so a misconfigured key fails loudly at startup.
 */
export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === MASTER_KEY_BYTES) {
    return decoded;
  }
  throw new Error(
    `${MASTER_KEY_ENV} must be a 32-byte key as 64 hex chars or base64; got a value of the wrong length.`,
  );
}

/**
 * Load the master key from the environment, or `null` when it is unset.
 *
 * A present-but-invalid value throws; an absent one returns `null` so callers
 * can decide their own policy (memory stores tolerate it; the Postgres store
 * refuses to persist a key without it).
 */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[MASTER_KEY_ENV]?.trim();
  if (raw === undefined || raw === "") return null;
  return parseMasterKey(raw);
}

/**
 * Encrypt a secret under the master key. Output is base64 of
 * `iv || authTag || ciphertext`, self-describing enough to decrypt without any
 * side metadata.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decrypt a value produced by {@link encryptSecret}. */
export function decryptSecret(ciphertext: string, key: Buffer): string {
  const raw = Buffer.from(ciphertext, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Ciphertext is too short to be a valid session-key envelope.");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}
