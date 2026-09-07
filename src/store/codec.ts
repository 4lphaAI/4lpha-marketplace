/**
 * jsonb codec that survives `bigint`.
 *
 * Spend caps and permissions carry `bigint` limits, and jsonb has no bigint
 * type — a naive `JSON.stringify` throws on the first one. Worse, the whole
 * point of persisting these is that a restored session must hash byte-for-byte
 * to what was granted, so a lossy number round-trip (bigint → JS number →
 * precision loss) would silently produce an unusable key.
 *
 * Encoding tags each bigint as `{ "$bigint": "<decimal>" }`; decoding reverses
 * it. Everything else passes through unchanged.
 */

const BIGINT_TAG = "$bigint";

/**
 * Serialize a value to a jsonb-ready JSON string, tagging every bigint.
 *
 * The result is passed as a bind parameter to a `$n::jsonb` placeholder — never
 * interpolated into SQL.
 */
export function encodeJsonbParam(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? { [BIGINT_TAG]: item.toString() } : item,
  );
}

/**
 * Revive a decoded jsonb value, turning tagged bigints back into `bigint`.
 *
 * `value` is what the driver hands back for a jsonb column: an already-parsed
 * object tree, not a string.
 */
export function decodeJsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => decodeJsonb(item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const tagged = record[BIGINT_TAG];
    if (typeof tagged === "string" && Object.keys(record).length === 1) {
      return BigInt(tagged);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      out[key] = decodeJsonb(item);
    }
    return out;
  }
  return value;
}
