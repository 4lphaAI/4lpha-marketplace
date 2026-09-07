/** Pure staged-intent witnesses; deliberately free of Porto sign/send capability. */
import { encodeAbiParameters, getAddress, isAddress, keccak256, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";

export const LP_FINAL_CALLS_SCHEME = "porto-erc7579-calls-v1" as const;
const PARAMETERS = [{ type: "tuple[]", components: [
  { name: "target", type: "address" }, { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
] }] as const;

export function encodeLpFinalCallsV1(calls: readonly WalletCall[]): Hex {
  if (calls.length === 0) throw new Error("LP final calls must not be empty.");
  return encodeAbiParameters(PARAMETERS, [calls.map((call) => ({ target: getAddress(call.to),
    value: call.value ?? 0n, data: call.data ?? "0x" }))]);
}

export function fingerprintLpFinalCallsV1(calls: readonly WalletCall[]): {
  readonly value: { readonly scheme: typeof LP_FINAL_CALLS_SCHEME; readonly executionDataHash: Hex };
  readonly canonical: string; readonly hash: Hex;
} {
  const value = { scheme: LP_FINAL_CALLS_SCHEME, executionDataHash: keccak256(encodeLpFinalCallsV1(calls)) };
  const canonical = JSON.stringify(value);
  if (Buffer.byteLength(canonical, "utf8") > 192) throw new Error("LP final-calls fingerprint exceeds 192 bytes.");
  return { value, canonical, hash: keccak256(`0x${Buffer.from(canonical, "utf8").toString("hex")}`) };
}

export function canonicalProviderPermissionsV1(value: unknown): string {
  if (!isRecord(value) || !sameKeys(value, ["calls", "spend"]) || !Array.isArray(value.calls) || !Array.isArray(value.spend)) {
    throw new Error("Session permissions are not a complete descriptor.");
  }
  return JSON.stringify({ calls: value.calls.map(call), spend: value.spend.map(spend) });
}
function call(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("Session call permission is not an object.");
  const signature = Object.hasOwn(value, "signature"); const to = Object.hasOwn(value, "to");
  if ((!signature && !to) || !sameKeys(value, signature && to ? ["signature", "to"] : signature ? ["signature"] : ["to"])) throw new Error("Session call permission has an unsupported shape.");
  if (signature && typeof value.signature !== "string") throw new Error("Session call permission signature is invalid.");
  if (to && (typeof value.to !== "string" || !isAddress(value.to, { strict: false }))) throw new Error("Session call permission target is invalid.");
  if (signature && to) return { signature: value.signature as string, to: getAddress(value.to as string) };
  return signature ? { signature: value.signature as string } : { to: getAddress(value.to as string) };
}
function spend(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Session spend permission is not an object.");
  const token = Object.hasOwn(value, "token");
  if (!sameKeys(value, token ? ["limit", "period", "token"] : ["limit", "period"]) || typeof value.limit !== "bigint" || value.limit < 0n || typeof value.period !== "string" || !PERIODS.has(value.period)) throw new Error("Session spend permission is invalid.");
  const result: Record<string, unknown> = { limit: { $uint: value.limit.toString(10) }, period: value.period };
  if (token) { if (typeof value.token !== "string" || !isAddress(value.token, { strict: false })) throw new Error("Session spend permission token is invalid."); result.token = getAddress(value.token); }
  return result;
}
const PERIODS = new Set(["minute", "hour", "day", "week", "month", "year"]);
function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value); return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
