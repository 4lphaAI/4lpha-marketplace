/**
 * The ONE canonical encoder shared by the owner-action signer and the server
 * verifier.
 *
 * This module is load-bearing. `paramsHash` binds a signed owner action to the
 * exact parameters it authorizes; the binding only holds if the signer and the
 * verifier turn those parameters into bytes IDENTICALLY. If they canonicalize
 * differently — a key in a different order, an address in a different case, a
 * bigint rendered two ways — the recomputed hash diverges and either a valid
 * action is rejected or, worse, a signature is accepted against parameters it
 * never covered. So the encoding is deterministic by construction and the same
 * function is imported by both sides.
 *
 * Determinism rules, each defended by a test:
 *   - OBJECT KEYS are emitted in sorted order, so key insertion order is
 *     irrelevant. `undefined`-valued keys are dropped (an omitted optional and
 *     an explicit `undefined` encode the same, matching exactOptionalPropertyTypes).
 *   - ADDRESSES are normalized to lowercase via viem's `getAddress` (which
 *     validates and canonicalizes) so checksummed and lowercase spellings of the
 *     same address encode identically.
 *   - BIGINTS render in ONE fixed decimal form, tagged so they can never collide
 *     with a same-valued number or string.
 *   - ARRAYS keep their given order. Array order is SEMANTIC here; the caller is
 *     responsible for presenting arrays canonically (session permissions arrive
 *     pre-sorted from `validateSessionSpec`, mirroring session.ts ordering).
 *   - PRIMITIVE TYPES are tagged (`"..."` for strings, `n…` for numbers, `#…`
 *     for bigints, bare `true`/`false`/`null`) so `1`, `"1"` and `1n` never
 *     produce the same bytes.
 */
import { getAddress, isAddress, keccak256, stringToBytes } from "viem";
import type { Hex } from "viem";

/**
 * Normalize a string, folding anything that is a 20-byte address to its
 * lowercase form. `getAddress` accepts checksummed, all-lower and all-upper
 * spellings and rejects only a corrupted mixed-case checksum; we fold to
 * lowercase either way so casing can never change the bytes.
 */
function normalizeString(value: string): string {
  if (!isAddress(value, { strict: false })) return value;
  try {
    return getAddress(value).toLowerCase();
  } catch {
    // Well-formed 40-hex but not a valid checksum: still fold case so the
    // encoding is casing-independent; the paramsHash recompute is the real gate.
    return value.toLowerCase();
  }
}

/** Escape a normalized string into an unambiguous, double-quoted token. */
function encodeString(value: string): string {
  return JSON.stringify(normalizeString(value));
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("canonicalEncode: non-finite number is not encodable.");
  }
  return `n${value}`;
}

/**
 * Encode any JSON-like value (plus `bigint`) to a deterministic string.
 *
 * The output is NOT meant to be parsed back — it exists only to be hashed. Its
 * single contract is that structurally equal inputs (modulo key order, address
 * casing, and bigint spelling) produce byte-identical output.
 */
export function canonicalEncode(value: unknown): string {
  if (value === null) return "null";

  const type = typeof value;
  if (type === "boolean") return value === true ? "true" : "false";
  if (type === "bigint") return `#${(value as bigint).toString(10)}`;
  if (type === "number") return encodeNumber(value as number);
  if (type === "string") return encodeString(value as string);

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalEncode(item)).join(",")}]`;
  }

  if (type === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue; // omit optionals, like JSON.stringify
      parts.push(`${JSON.stringify(key)}:${canonicalEncode(item)}`);
    }
    return `{${parts.join(",")}}`;
  }

  // `undefined`, `function`, `symbol`: never part of a signable action.
  throw new Error(`canonicalEncode: unsupported value of type ${type}.`);
}

/**
 * Byte separator between the action tag and the encoded params.
 *
 * A unit-separator (U+001F) never appears in an action enum value or in
 * `canonicalEncode` output, so `action ‖ SEP ‖ params` is unambiguous: no
 * action string can borrow leading bytes from the params to look like another.
 */
const ACTION_PARAM_SEPARATOR = "";

/**
 * Bind an action name and its parameters into a single hash.
 *
 * `paramsHash(action, params) = keccak256(utf8(action ‖ SEP ‖ canonicalEncode(params)))`.
 *
 * This is the value carried in a signed `OwnerAction`. The verifier recomputes
 * it from the REAL params it is asked to act on and compares; a mismatch means
 * the signature does not cover these parameters and the request is refused.
 */
export function paramsHash(action: string, params: unknown): Hex {
  const encoded = `${action}${ACTION_PARAM_SEPARATOR}${canonicalEncode(params)}`;
  return keccak256(stringToBytes(encoded));
}
