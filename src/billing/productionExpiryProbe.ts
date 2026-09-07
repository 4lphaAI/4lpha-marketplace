import { createClient, http, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import { from as portoKeyFrom } from "porto/viem/Key";
import { prepareCalls as portoPrepareCalls } from "porto/viem/RelayActions";
import {
  assertCanonicalBillingPayInvoiceCalldata,
  validatePortoPreparedIdentityV1,
} from "./awsBillingAdapter.js";
import type { Hex65 } from "./custody.js";
import {
  ALTANA_ORCHESTRATOR,
  ALTANA_RELAY_ORIGIN,
  PORTO_VERSION,
  buildExpiryEvidence,
  canonicalExpiryProbeInput,
  expiryProbeInputSha256,
  type BillingExpiryEvidenceV1,
} from "./productionOps.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/u;
const PUBLIC_KEY = /^0x04[0-9a-f]{128}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const FIXTURE_KEYS = [
  "schema", "manifestSha256", "bundleSha256", "wallet", "collector", "calldata", "valueWei", "maxExpiresAt",
  "sessionPublicKey", "sessionExpiresAt", "sessionDayLimitWei",
] as const;

export type ExpiryPrepareFixtureV1 = Readonly<{
  schema: "4lpha.billing-expiry-prepare-fixture.v1";
  manifestSha256: string;
  bundleSha256: string;
  wallet: Address;
  collector: Address;
  calldata: Hex;
  valueWei: string;
  maxExpiresAt: number;
  sessionPublicKey: Hex65;
  sessionExpiresAt: number;
  sessionDayLimitWei: string;
}>;

export type ExpiryPrepareOnlyDependency = Readonly<{
  now(): number;
  prepare(input: Readonly<{
    wallet: Address;
    collector: Address;
    calldata: Hex;
    valueWei: bigint;
    sessionPublicKey: Hex65;
    sessionExpiresAt: number;
    sessionDayLimitWei: bigint;
  }>): Promise<Readonly<{ quoteExpiresAt: unknown; intentExpiresAt: unknown }>>;
  close(): Promise<void>;
}>;

function canonicalJson(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error("Expiry prepare fixture must not contain a BOM.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Expiry prepare fixture must be UTF-8."); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new Error("Expiry prepare fixture must be JSON."); }
  if (value === null || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== text) {
    throw new Error("Expiry prepare fixture must be canonical no-whitespace JSON.");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== FIXTURE_KEYS.length || keys.some((key, index) => key !== FIXTURE_KEYS[index])) throw new Error("Expiry prepare fixture members drifted.");
  return row;
}

function positiveSecond(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${field} must be a positive safe Unix second.`);
  return Number(value);
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || value !== value.toLowerCase() || !isAddress(value, { strict: false })) throw new Error(`${field} must be a lowercase address.`);
  return value as Address;
}

function decimal(value: unknown, field: string, positive: boolean): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || (positive && value === "0")) throw new Error(`${field} must be canonical decimal.`);
  return value;
}

export function parseExpiryPrepareFixture(bytes: Uint8Array): ExpiryPrepareFixtureV1 {
  const value = canonicalJson(bytes);
  if (value["schema"] !== "4lpha.billing-expiry-prepare-fixture.v1") throw new Error("Expiry prepare fixture schema drifted.");
  if (typeof value["manifestSha256"] !== "string" || !SHA256.test(value["manifestSha256"]) ||
      typeof value["bundleSha256"] !== "string" || !SHA256.test(value["bundleSha256"])) throw new Error("Expiry prepare fixture hashes are malformed.");
  if (typeof value["calldata"] !== "string" || !HEX_BYTES.test(value["calldata"]) ||
      typeof value["sessionPublicKey"] !== "string" || !PUBLIC_KEY.test(value["sessionPublicKey"])) throw new Error("Expiry prepare fixture public bytes are malformed.");
  const maxExpiresAt = positiveSecond(value["maxExpiresAt"], "maxExpiresAt");
  const sessionExpiresAt = positiveSecond(value["sessionExpiresAt"], "sessionExpiresAt");
  if (sessionExpiresAt < maxExpiresAt) throw new Error("Session expires before the probe upper bound.");
  const calldata = assertCanonicalBillingPayInvoiceCalldata(value["calldata"], maxExpiresAt);
  return Object.freeze({ schema: "4lpha.billing-expiry-prepare-fixture.v1",
    manifestSha256: value["manifestSha256"], bundleSha256: value["bundleSha256"],
    wallet: address(value["wallet"], "wallet"), collector: address(value["collector"], "collector"),
    calldata, valueWei: decimal(value["valueWei"], "valueWei", true), maxExpiresAt,
    sessionPublicKey: value["sessionPublicKey"] as Hex65, sessionExpiresAt,
    sessionDayLimitWei: decimal(value["sessionDayLimitWei"], "sessionDayLimitWei", true) });
}

export async function acquireExpiryEvidence(
  fixture: ExpiryPrepareFixtureV1,
  dependency: ExpiryPrepareOnlyDependency,
): Promise<BillingExpiryEvidenceV1> {
  const observedAt = dependency.now();
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || fixture.maxExpiresAt <= observedAt) throw new Error("Expiry probe clock or upper bound is invalid.");
  const canonicalInput = canonicalExpiryProbeInput({ manifestSha256: fixture.manifestSha256,
    bundleSha256: fixture.bundleSha256, collector: fixture.collector, calldata: fixture.calldata,
    valueWei: fixture.valueWei, maxExpiresAt: fixture.maxExpiresAt });
  const probeInputSha256 = expiryProbeInputSha256({ manifestSha256: fixture.manifestSha256,
    bundleSha256: fixture.bundleSha256, collector: fixture.collector, calldata: fixture.calldata,
    valueWei: fixture.valueWei, maxExpiresAt: fixture.maxExpiresAt });
  if (canonicalInput.length === 0) throw new Error("Expiry probe input encoding failed.");
  const result = await dependency.prepare({ wallet: fixture.wallet, collector: fixture.collector,
    calldata: fixture.calldata, valueWei: BigInt(fixture.valueWei), sessionPublicKey: fixture.sessionPublicKey,
    sessionExpiresAt: fixture.sessionExpiresAt, sessionDayLimitWei: BigInt(fixture.sessionDayLimitWei) });
  return buildExpiryEvidence({ observedAt, maxExpiresAt: fixture.maxExpiresAt,
    quoteExpiresAt: result.quoteExpiresAt, intentExpiresAt: result.intentExpiresAt,
    manifestSha256: fixture.manifestSha256, bundleSha256: fixture.bundleSha256, probeInputSha256 });
}

export function validatePortoPrepareOnlyResult(input: Readonly<{
  wallet: Address;
  collector: Address;
  calldata: Hex;
  valueWei: bigint;
  sessionPublicKey: Hex65;
}>, value: unknown, expectedKey?: object): Readonly<{ quoteExpiresAt: unknown; intentExpiresAt: unknown }> {
  const prepared = validatePortoPreparedIdentityV1({ ...input, orchestrator: ALTANA_ORCHESTRATOR,
    orchestratorVersion: "0.5.5", ...(expectedKey === undefined ? {} : { expectedKey }) }, value);
  return { quoteExpiresAt: prepared.relayQuoteExpiresAt, intentExpiresAt: prepared.intent.expiry };
}

/** Production implementation deliberately imports prepareCalls only: no KMS, signer, bind, send, or status capability exists. */
export function createPortoPrepareOnlyDependency(now: () => number = () => Math.floor(Date.now() / 1_000)): ExpiryPrepareOnlyDependency {
  const client = createClient({ chain: bsc, transport: http(ALTANA_RELAY_ORIGIN, { retryCount: 0 }) });
  return {
    now,
    async prepare(input) {
      const permissions = { calls: [{ signature: "payInvoice(bytes32,uint64)" as const, to: input.collector }],
        spend: [{ limit: input.sessionDayLimitWei, period: "day" as const }] };
      const key = portoKeyFrom({ expiry: input.sessionExpiresAt, permissions, publicKey: input.sessionPublicKey,
        role: "session", type: "secp256k1" });
      const result = await portoPrepareCalls(client, { account: input.wallet,
        calls: [{ to: input.collector, data: input.calldata, value: input.valueWei }], chain: bsc,
        feeToken: zeroAddress, key });
      return validatePortoPrepareOnlyResult(input, result, key as object);
    },
    async close() { /* viem HTTP transport owns no persistent signer or socket capability. */ },
  };
}

export const EXPIRY_PROBE_PORTO_VERSION = PORTO_VERSION;
