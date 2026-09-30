/** Quant-local canonical encoder: no import edge into owner-signing/auth code. */
import { getAddress, isAddress } from "viem";

function canonicalString(value: string): string {
  if (!isAddress(value, { strict: false })) return value;
  try { return getAddress(value).toLowerCase(); } catch { return value.toLowerCase(); }
}

export function rebalanceCanonicalEncode(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "bigint": return `#${value.toString(10)}`;
    case "number":
      if (!Number.isFinite(value)) throw new Error("rebalance-canonical-number-invalid");
      return `n${value}`;
    case "string": return JSON.stringify(canonicalString(value));
    case "undefined":
    case "function":
    case "symbol":
      throw new Error("rebalance-canonical-value-invalid");
    case "object":
      if (Array.isArray(value)) return `[${value.map((item) => rebalanceCanonicalEncode(item)).join(",")}]`;
      {
        const record = value as Record<string, unknown>;
        const fields: string[] = [];
        for (const key of Object.keys(record).sort()) {
          const item = record[key];
          if (item === undefined) continue;
          fields.push(`${JSON.stringify(key)}:${rebalanceCanonicalEncode(item)}`);
        }
        return `{${fields.join(",")}}`;
      }
    default: throw new Error("rebalance-canonical-value-invalid");
  }
}
