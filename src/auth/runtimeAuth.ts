/**
 * Short-lived, request-bound authorization for the three autonomous HTTP
 * runtime routes. The shared service bearer remains the outer perimeter; this
 * assertion is the tenant/agent-specific authority inside it.
 */
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { canonicalEncode, paramsHash } from "./canonical.js";
import { resolveDomainSalt } from "./ownerAuth.js";
import { decodeBase64UrlStrict, encodeBase64Url } from "./webauthnEnvelope.js";

export const RUNTIME_ASSERTION_VERSION = "4lpha-runtime-assertion:v1" as const;
export const MAX_RUNTIME_ASSERTION_SECONDS = 60;
export const RUNTIME_ASSERTION_SKEW_SECONDS = 5;
export const MAX_RUNTIME_ASSERTION_HEADER_CHARS = 4096;

export type HttpRuntimeProfile =
  | "unbound-v1"
  | "trade-v1"
  | "raw-v1"
  | "lp-v1"
  | "venus-v1";

export type BindableHttpRuntimeProfile = "trade-v1" | "lp-v1" | "venus-v1";
export type HttpRuntimeOperation = "agentRead" | "trade" | "executeRaw";

const HTTP_RUNTIME_PROFILES: ReadonlySet<string> = new Set<HttpRuntimeProfile>([
  "unbound-v1",
  "trade-v1",
  "raw-v1",
  "lp-v1",
  "venus-v1",
]);

const BINDABLE_HTTP_RUNTIME_PROFILES: ReadonlySet<string> =
  new Set<BindableHttpRuntimeProfile>(["trade-v1", "lp-v1", "venus-v1"]);

const HTTP_RUNTIME_OPERATIONS: ReadonlySet<string> =
  new Set<HttpRuntimeOperation>(["agentRead", "trade", "executeRaw"]);

export function parseHttpRuntimeProfile(value: string): HttpRuntimeProfile {
  if (!HTTP_RUNTIME_PROFILES.has(value)) {
    throw new Error(`Unknown HTTP runtime profile "${value}".`);
  }
  return value as HttpRuntimeProfile;
}

export function parseBindableHttpRuntimeProfile(
  value: string,
): BindableHttpRuntimeProfile | null {
  return BINDABLE_HTTP_RUNTIME_PROFILES.has(value)
    ? (value as BindableHttpRuntimeProfile)
    : null;
}

export function httpRuntimeProfileAllows(
  profile: HttpRuntimeProfile,
  operation: HttpRuntimeOperation,
): boolean {
  if (operation === "agentRead") return true;
  if (operation === "trade") return profile === "trade-v1";
  return profile === "raw-v1";
}

export function httpRuntimeProfileHash(profile: HttpRuntimeProfile): Hex {
  return paramsHash("4lpha-execution-profile:v1", { profile });
}

export function runtimeRequestHash(
  operation: HttpRuntimeOperation,
  agentId: string,
  params: unknown,
): Hex {
  return paramsHash(`runtime:${operation}:v1`, { agentId, params });
}

export type RuntimeAssertionClaims = {
  readonly version: typeof RUNTIME_ASSERTION_VERSION;
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly agentId: string;
  readonly owner: Address;
  readonly executionProfileHash: Hex;
  readonly operation: HttpRuntimeOperation;
  readonly requestHash: Hex;
  readonly nonce: Hex;
  readonly issuedAt: number;
  readonly expiry: number;
};

export type EnabledRuntimeAuthConfig = {
  readonly kind: "enabled";
  readonly issuer: string;
  readonly audience: string;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
};

export type RuntimeAuthConfig =
  | { readonly kind: "disabled" }
  | EnabledRuntimeAuthConfig;

export type RuntimeAuthEnvironment = Readonly<
  Record<string, string | undefined>
>;

const CLAIM_KEYS = [
  "agentId",
  "audience",
  "expiry",
  "executionProfileHash",
  "issuedAt",
  "issuer",
  "keyId",
  "nonce",
  "operation",
  "owner",
  "requestHash",
  "version",
] as const;

const ENVELOPE_KEYS = ["claims", "signature"] as const;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class RuntimeAuthError extends Error {
  constructor() {
    super("Runtime assertion verification failed.");
    this.name = "RuntimeAuthError";
  }
}

export function runtimeAudience(input: {
  readonly chainId: number;
  readonly envSalt: string;
}): string {
  return `4lpha-execution:${input.chainId}:${resolveDomainSalt({
    chainId: input.chainId,
    envSalt: input.envSalt,
  })}`;
}

export function resolveRuntimeAuthConfig(
  env: RuntimeAuthEnvironment,
  input: { readonly chainId: number; readonly envSalt?: string },
): RuntimeAuthConfig {
  const issuer = nonBlank(env["RUNTIME_ASSERTION_ISSUER"]);
  const encodedKeys = nonBlank(env["RUNTIME_ASSERTION_PUBLIC_KEYS_JSON"]);
  if (issuer === undefined && encodedKeys === undefined) {
    return { kind: "disabled" };
  }
  if (issuer === undefined || encodedKeys === undefined) {
    throw new Error(
      "RUNTIME_ASSERTION_ISSUER and RUNTIME_ASSERTION_PUBLIC_KEYS_JSON must be configured together.",
    );
  }
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(issuer)) {
    throw new Error("RUNTIME_ASSERTION_ISSUER is malformed.");
  }
  const envSalt = nonBlank(input.envSalt);
  if (envSalt === undefined || envSalt.length > 256) {
    throw new Error(
      "Enabled runtime authorization requires a non-empty EXECUTION_ENV_SALT.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedKeys) as unknown;
  } catch {
    throw new Error("RUNTIME_ASSERTION_PUBLIC_KEYS_JSON must be valid JSON.");
  }
  if (!isPlainObject(parsed)) {
    throw new Error("RUNTIME_ASSERTION_PUBLIC_KEYS_JSON must be an object.");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 8) {
    throw new Error(
      "RUNTIME_ASSERTION_PUBLIC_KEYS_JSON must contain between one and eight keys.",
    );
  }

  const publicKeys = new Map<string, KeyObject>();
  const decodedKeys = new Set<string>();
  for (const [keyId, encoded] of entries) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(keyId) || typeof encoded !== "string") {
      throw new Error("Runtime assertion key ids or values are malformed.");
    }
    const raw = decodeCanonicalBase64Url(encoded);
    if (raw === null || raw.length !== 32) {
      throw new Error(`Runtime assertion public key "${keyId}" is malformed.`);
    }
    const fingerprint = Buffer.from(raw).toString("hex");
    if (decodedKeys.has(fingerprint)) {
      throw new Error("Duplicate runtime assertion public keys are not allowed.");
    }
    decodedKeys.add(fingerprint);
    publicKeys.set(
      keyId,
      createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
        format: "der",
        type: "spki",
      }),
    );
  }

  return {
    kind: "enabled",
    issuer,
    audience: runtimeAudience({ chainId: input.chainId, envSalt }),
    publicKeys,
  };
}

/** Execution-server boot guard: verifier processes must never hold issuer keys. */
export function assertRuntimeVerifierOnlyEnvironment(
  env: RuntimeAuthEnvironment,
): void {
  if (nonBlank(env["RUNTIME_ASSERTION_PRIVATE_KEY"]) !== undefined) {
    throw new Error(
      "RUNTIME_ASSERTION_PRIVATE_KEY must not be present in the execution server; refusing to start.",
    );
  }
}

export function createRuntimeAssertionNonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function createRuntimeAssertionClaims(input: {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly agentId: string;
  readonly owner: Address;
  readonly httpRuntimeProfile: HttpRuntimeProfile;
  readonly operation: HttpRuntimeOperation;
  readonly requestHash: Hex;
  readonly nonce?: Hex;
  readonly issuedAt: number;
  readonly expiry?: number;
}): RuntimeAssertionClaims {
  const expiry = input.expiry ?? input.issuedAt + MAX_RUNTIME_ASSERTION_SECONDS;
  return {
    version: RUNTIME_ASSERTION_VERSION,
    issuer: input.issuer,
    audience: input.audience,
    keyId: input.keyId,
    agentId: input.agentId,
    owner: getAddress(input.owner),
    executionProfileHash: httpRuntimeProfileHash(input.httpRuntimeProfile),
    operation: input.operation,
    requestHash: input.requestHash,
    nonce: input.nonce ?? createRuntimeAssertionNonce(),
    issuedAt: input.issuedAt,
    expiry,
  };
}

export function runtimeAssertionPrivateKeyFromBase64Url(value: string): KeyObject {
  const bytes = decodeCanonicalBase64Url(value);
  if (bytes === null) throw new Error("Runtime assertion private key is malformed.");
  try {
    return createPrivateKey({ key: Buffer.from(bytes), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("Runtime assertion private key is malformed.");
  }
}

export function encodeRuntimeAssertion(
  claims: RuntimeAssertionClaims,
  privateKey: KeyObject,
): string {
  const signature = sign(null, signedBytes(claims), privateKey);
  if (signature.length !== 64) {
    throw new Error("Runtime assertion signer did not produce an Ed25519 signature.");
  }
  return encodeBase64Url(
    Buffer.from(
      JSON.stringify({ claims, signature: encodeBase64Url(signature) }),
      "utf8",
    ),
  );
}

export function verifyRuntimeAssertion(input: {
  readonly header: string | undefined;
  readonly config: EnabledRuntimeAuthConfig;
  readonly operation: HttpRuntimeOperation;
  readonly requestHash: Hex;
  readonly nowSec: number;
}): RuntimeAssertionClaims {
  try {
    const header = input.header;
    if (
      header === undefined ||
      header.length === 0 ||
      header.length > MAX_RUNTIME_ASSERTION_HEADER_CHARS
    ) {
      throw new Error("header");
    }
    const envelopeBytes = decodeCanonicalBase64Url(header);
    if (envelopeBytes === null || envelopeBytes.length > 3072) throw new Error("encoding");
    const envelope = JSON.parse(Buffer.from(envelopeBytes).toString("utf8")) as unknown;
    if (!isPlainObject(envelope) || !hasExactKeys(envelope, ENVELOPE_KEYS)) {
      throw new Error("envelope");
    }
    const claims = parseClaims(envelope["claims"]);
    const signatureText = envelope["signature"];
    if (typeof signatureText !== "string") throw new Error("signature");
    const signature = decodeCanonicalBase64Url(signatureText);
    if (signature === null || signature.length !== 64) throw new Error("signature");

    if (
      claims.issuer !== input.config.issuer ||
      claims.audience !== input.config.audience ||
      claims.operation !== input.operation ||
      !equalHex32(claims.requestHash, input.requestHash) ||
      claims.expiry < claims.issuedAt ||
      claims.expiry - claims.issuedAt > MAX_RUNTIME_ASSERTION_SECONDS ||
      input.nowSec < claims.issuedAt - RUNTIME_ASSERTION_SKEW_SECONDS ||
      input.nowSec > claims.expiry
    ) {
      throw new Error("claims");
    }
    const key = input.config.publicKeys.get(claims.keyId);
    if (key === undefined || !verify(null, signedBytes(claims), key, signature)) {
      throw new Error("signature");
    }
    return claims;
  } catch {
    throw new RuntimeAuthError();
  }
}

function signedBytes(claims: RuntimeAssertionClaims): Buffer {
  return Buffer.from(
    `${RUNTIME_ASSERTION_VERSION}\u001f${canonicalEncode(claims)}`,
    "utf8",
  );
}

function parseClaims(value: unknown): RuntimeAssertionClaims {
  if (!isPlainObject(value) || !hasExactKeys(value, CLAIM_KEYS)) {
    throw new Error("claims");
  }
  const version = boundedString(value["version"], 64);
  const issuer = boundedString(value["issuer"], 64);
  const audience = boundedString(value["audience"], 256);
  const keyId = boundedString(value["keyId"], 64);
  const agentId = boundedString(value["agentId"], 128);
  const ownerText = boundedString(value["owner"], 42);
  const profileHash = bytes32(value["executionProfileHash"]);
  const operation = boundedString(value["operation"], 16);
  const requestHash = bytes32(value["requestHash"]);
  const nonce = bytes32(value["nonce"]);
  const issuedAt = safeInteger(value["issuedAt"]);
  const expiry = safeInteger(value["expiry"]);
  if (
    version !== RUNTIME_ASSERTION_VERSION ||
    !HTTP_RUNTIME_OPERATIONS.has(operation) ||
    !/^[A-Za-z0-9._:-]{1,64}$/.test(keyId) ||
    !/^[A-Za-z0-9._:-]{1,64}$/.test(issuer)
  ) {
    throw new Error("claims");
  }
  return {
    version,
    issuer,
    audience,
    keyId,
    agentId,
    owner: getAddress(ownerText),
    executionProfileHash: profileHash,
    operation: operation as HttpRuntimeOperation,
    requestHash,
    nonce,
    issuedAt,
    expiry,
  };
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i]);
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error("string");
  }
  return value;
}

function bytes32(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("bytes32");
  }
  return value as Hex;
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("integer");
  }
  return value;
}

function decodeCanonicalBase64Url(value: string): Uint8Array | null {
  const decoded = decodeBase64UrlStrict(value);
  return decoded !== null && encodeBase64Url(decoded) === value ? decoded : null;
}

function equalHex32(left: Hex, right: Hex): boolean {
  const a = Buffer.from(left.slice(2), "hex");
  const b = Buffer.from(right.slice(2), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
