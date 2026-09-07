import { createHash } from "node:crypto";

export const PORTO_VERSION = "0.2.37";
export const PORTO_LOCK_INTEGRITY = "sha512-l3IOUvf5O9rM82VW7v/R5Y2X2niU1kmfXMYYPr/VLMvtKKySr7PiAO3TXWjGft5PV17800VnMCmEaRuxA+N4ug==";
export const ALTANA_RELAY_ORIGIN = "https://relay.altana.network";
export const ALTANA_ORCHESTRATOR = "0xaf140d0416a994aebb3fa6212b16ce6700f09751";
export const BILLING_EXPIRY_EVIDENCE_SCHEMA = "4lpha.billing-expiry-evidence.v1";
export const BILLING_EXPIRY_PROBE_INPUT_SCHEMA = "4lpha.billing-expiry-probe-input.v1";

const SHA256 = /^[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const HEX = /^0x(?:[0-9a-f]{2})*$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const EVIDENCE_KEYS = [
  "schema", "observedAt", "portoVersion", "portoLockIntegrity", "relayOrigin", "chainId",
  "orchestrator", "walletClass", "manifestSha256", "bundleSha256", "probeInputSha256",
  "quoteExpiryClass", "intentExpiryClass", "maxExpiresAtDeltaSec", "quoteDeltaSec",
  "intentDeltaSec", "intentToQuoteDeltaSec", "result",
] as const;

export type ExpiryClass = "missing" | "negative" | "fractional" | "zero" | "expired" | "too-short" | "finite-bounded" | "too-long";

export type BillingExpiryProbeInputV1 = Readonly<{
  schema: typeof BILLING_EXPIRY_PROBE_INPUT_SCHEMA;
  manifestSha256: string;
  bundleSha256: string;
  portoVersion: typeof PORTO_VERSION;
  relayOrigin: typeof ALTANA_RELAY_ORIGIN;
  chainId: 56;
  orchestrator: typeof ALTANA_ORCHESTRATOR;
  walletClass: "billing-wallet";
  collector: string;
  calldataSha256: string;
  valueWei: string;
  maxExpiresAt: number;
}>;

export type BillingExpiryEvidenceV1 = Readonly<{
  schema: typeof BILLING_EXPIRY_EVIDENCE_SCHEMA;
  observedAt: number;
  portoVersion: typeof PORTO_VERSION;
  portoLockIntegrity: typeof PORTO_LOCK_INTEGRITY;
  relayOrigin: typeof ALTANA_RELAY_ORIGIN;
  chainId: 56;
  orchestrator: typeof ALTANA_ORCHESTRATOR;
  walletClass: "billing-wallet";
  manifestSha256: string;
  bundleSha256: string;
  probeInputSha256: string;
  quoteExpiryClass: ExpiryClass;
  intentExpiryClass: ExpiryClass;
  maxExpiresAtDeltaSec: string;
  quoteDeltaSec: string | null;
  intentDeltaSec: string | null;
  intentToQuoteDeltaSec: string | null;
  result: "finite-candidate" | "blocked";
}>;

function sha256(value: string, field: string): string {
  if (!SHA256.test(value)) throw new Error(`${field} must be lowercase SHA-256 hex.`);
  return value;
}

function safePositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive safe Unix second.`);
  return value;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalExpiryProbeInput(input: Readonly<{
  manifestSha256: string;
  bundleSha256: string;
  collector: string;
  calldata: string;
  valueWei: string;
  maxExpiresAt: number;
}>): string {
  const manifestSha256 = sha256(input.manifestSha256, "manifestSha256");
  const bundleSha256 = sha256(input.bundleSha256, "bundleSha256");
  if (!ADDRESS.test(input.collector)) throw new Error("collector must be a lowercase EVM address.");
  if (!HEX.test(input.calldata)) throw new Error("calldata must be canonical lowercase even-length hex.");
  if (!DECIMAL.test(input.valueWei)) throw new Error("valueWei must be a canonical unsigned decimal string.");
  const maxExpiresAt = safePositive(input.maxExpiresAt, "maxExpiresAt");
  const value: BillingExpiryProbeInputV1 = {
    schema: BILLING_EXPIRY_PROBE_INPUT_SCHEMA,
    manifestSha256,
    bundleSha256,
    portoVersion: PORTO_VERSION,
    relayOrigin: ALTANA_RELAY_ORIGIN,
    chainId: 56,
    orchestrator: ALTANA_ORCHESTRATOR,
    walletClass: "billing-wallet",
    collector: input.collector,
    calldataSha256: hashBytes(Buffer.from(input.calldata.slice(2), "hex")),
    valueWei: input.valueWei,
    maxExpiresAt,
  };
  return JSON.stringify(value);
}

export function expiryProbeInputSha256(input: Parameters<typeof canonicalExpiryProbeInput>[0]): string {
  return hashText(canonicalExpiryProbeInput(input));
}

type Classified = Readonly<{ kind: ExpiryClass; expiry?: number; delta: string | null }>;

function classify(value: unknown, observedAt: number, maxDelta: number): Classified {
  if (value === undefined || value === null) return { kind: "missing", delta: null };
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return { kind: "fractional", delta: null };
  const delta = value - observedAt;
  const encodedDelta = String(delta);
  if (value < 0) return { kind: "negative", expiry: value, delta: encodedDelta };
  if (value === 0) return { kind: "zero", expiry: value, delta: encodedDelta };
  if (delta <= 0) return { kind: "expired", expiry: value, delta: encodedDelta };
  if (delta < 30) return { kind: "too-short", expiry: value, delta: encodedDelta };
  if (delta > maxDelta) return { kind: "too-long", expiry: value, delta: encodedDelta };
  return { kind: "finite-bounded", expiry: value, delta: encodedDelta };
}

/** Exhaustively classify relay quote/intent expiry and emit independently recomputable evidence. */
export function buildExpiryEvidence(input: Readonly<{
  observedAt: number;
  maxExpiresAt: number;
  quoteExpiresAt: unknown;
  intentExpiresAt: unknown;
  manifestSha256: string;
  bundleSha256: string;
  probeInputSha256: string;
}>): BillingExpiryEvidenceV1 {
  const observedAt = safePositive(input.observedAt, "observedAt");
  const maxExpiresAt = safePositive(input.maxExpiresAt, "maxExpiresAt");
  const maxDelta = maxExpiresAt - observedAt;
  if (!Number.isSafeInteger(maxDelta) || maxDelta <= 0) throw new Error("maxExpiresAtDeltaSec must be positive and safe.");
  const quote = classify(input.quoteExpiresAt, observedAt, maxDelta);
  let intent = classify(input.intentExpiresAt, observedAt, maxDelta);
  if (
    intent.expiry !== undefined && intent.expiry > 0 &&
    quote.expiry !== undefined && quote.expiry > 0 &&
    intent.expiry > quote.expiry
  ) intent = { kind: "too-long", expiry: intent.expiry, delta: intent.delta };
  const intentToQuote = intent.expiry === undefined || quote.expiry === undefined
    ? null
    : String(intent.expiry - quote.expiry);
  const finite = quote.kind === "finite-bounded" && intent.kind === "finite-bounded" &&
    intentToQuote !== null && BigInt(intentToQuote) <= 0n &&
    quote.delta !== null && BigInt(quote.delta) <= BigInt(maxDelta);
  return Object.freeze({
    schema: BILLING_EXPIRY_EVIDENCE_SCHEMA,
    observedAt,
    portoVersion: PORTO_VERSION,
    portoLockIntegrity: PORTO_LOCK_INTEGRITY,
    relayOrigin: ALTANA_RELAY_ORIGIN,
    chainId: 56,
    orchestrator: ALTANA_ORCHESTRATOR,
    walletClass: "billing-wallet",
    manifestSha256: sha256(input.manifestSha256, "manifestSha256"),
    bundleSha256: sha256(input.bundleSha256, "bundleSha256"),
    probeInputSha256: sha256(input.probeInputSha256, "probeInputSha256"),
    quoteExpiryClass: quote.kind,
    intentExpiryClass: intent.kind,
    maxExpiresAtDeltaSec: String(maxDelta),
    quoteDeltaSec: quote.delta,
    intentDeltaSec: intent.delta,
    intentToQuoteDeltaSec: intentToQuote,
    result: finite ? "finite-candidate" : "blocked",
  });
}

export function canonicalExpiryEvidence(evidence: BillingExpiryEvidenceV1): string {
  const keys = Object.keys(evidence);
  if (keys.length !== EVIDENCE_KEYS.length || keys.some((key, index) => key !== EVIDENCE_KEYS[index])) {
    throw new Error("Expiry evidence members are missing, unknown, or reordered.");
  }
  if (
    evidence.schema !== BILLING_EXPIRY_EVIDENCE_SCHEMA || evidence.portoVersion !== PORTO_VERSION ||
    evidence.portoLockIntegrity !== PORTO_LOCK_INTEGRITY || evidence.relayOrigin !== ALTANA_RELAY_ORIGIN ||
    evidence.chainId !== 56 || evidence.orchestrator !== ALTANA_ORCHESTRATOR || evidence.walletClass !== "billing-wallet"
  ) throw new Error("Expiry evidence identity drifted.");
  safePositive(evidence.observedAt, "observedAt");
  sha256(evidence.manifestSha256, "manifestSha256");
  sha256(evidence.bundleSha256, "bundleSha256");
  sha256(evidence.probeInputSha256, "probeInputSha256");
  if (!/^[1-9][0-9]*$/u.test(evidence.maxExpiresAtDeltaSec) || !Number.isSafeInteger(Number(evidence.maxExpiresAtDeltaSec))) {
    throw new Error("maxExpiresAtDeltaSec must be a positive safe canonical decimal.");
  }
  const maxDelta = BigInt(evidence.maxExpiresAtDeltaSec);
  const signed = (value: string | null, field: string): bigint | null => {
    if (value === null) return null;
    if (!/^(0|-?[1-9][0-9]*)$/u.test(value)) throw new Error(`${field} must be a canonical signed decimal.`);
    const parsed = BigInt(value);
    if (!Number.isSafeInteger(Number(parsed))) throw new Error(`${field} must be safe.`);
    return parsed;
  };
  const quoteDelta = signed(evidence.quoteDeltaSec, "quoteDeltaSec");
  const intentDelta = signed(evidence.intentDeltaSec, "intentDeltaSec");
  const intentToQuote = signed(evidence.intentToQuoteDeltaSec, "intentToQuoteDeltaSec");
  const nullClass = (value: ExpiryClass): boolean => value === "missing" || value === "fractional";
  if ((quoteDelta === null) !== nullClass(evidence.quoteExpiryClass) || (intentDelta === null) !== nullClass(evidence.intentExpiryClass)) {
    throw new Error("Expiry class and delta presence disagree.");
  }
  if ((quoteDelta === null || intentDelta === null) !== (intentToQuote === null)) {
    throw new Error("intentToQuoteDeltaSec presence disagrees with expiry deltas.");
  }
  if (quoteDelta !== null && intentDelta !== null && intentToQuote !== intentDelta - quoteDelta) {
    throw new Error("intentToQuoteDeltaSec is inconsistent.");
  }
  const matchesClass = (kind: ExpiryClass, delta: bigint | null, isIntent: boolean): boolean => {
    if (delta === null) return nullClass(kind);
    const expiry = BigInt(evidence.observedAt) + delta;
    if (kind === "negative") return expiry < 0n;
    if (kind === "zero") return expiry === 0n;
    if (kind === "expired") return expiry > 0n && delta <= 0n;
    if (kind === "too-short") return delta >= 1n && delta <= 29n;
    if (kind === "finite-bounded") return delta >= 30n && delta <= maxDelta && (!isIntent || intentToQuote === null || intentToQuote <= 0n);
    if (kind === "too-long") return delta > maxDelta || (isIntent && intentToQuote !== null && intentToQuote > 0n);
    return false;
  };
  if (!matchesClass(evidence.quoteExpiryClass, quoteDelta, false) || !matchesClass(evidence.intentExpiryClass, intentDelta, true)) {
    throw new Error("Expiry class does not match its numeric delta.");
  }
  const finite = evidence.quoteExpiryClass === "finite-bounded" && evidence.intentExpiryClass === "finite-bounded" &&
    intentToQuote !== null && intentToQuote <= 0n && quoteDelta !== null && quoteDelta <= maxDelta;
  if (evidence.result !== (finite ? "finite-candidate" : "blocked")) throw new Error("Expiry evidence result is inconsistent.");
  return JSON.stringify({
    schema: evidence.schema,
    observedAt: evidence.observedAt,
    portoVersion: evidence.portoVersion,
    portoLockIntegrity: evidence.portoLockIntegrity,
    relayOrigin: evidence.relayOrigin,
    chainId: evidence.chainId,
    orchestrator: evidence.orchestrator,
    walletClass: evidence.walletClass,
    manifestSha256: evidence.manifestSha256,
    bundleSha256: evidence.bundleSha256,
    probeInputSha256: evidence.probeInputSha256,
    quoteExpiryClass: evidence.quoteExpiryClass,
    intentExpiryClass: evidence.intentExpiryClass,
    maxExpiresAtDeltaSec: evidence.maxExpiresAtDeltaSec,
    quoteDeltaSec: evidence.quoteDeltaSec,
    intentDeltaSec: evidence.intentDeltaSec,
    intentToQuoteDeltaSec: evidence.intentToQuoteDeltaSec,
    result: evidence.result,
  });
}
