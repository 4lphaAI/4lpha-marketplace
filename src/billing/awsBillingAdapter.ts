/**
 * Phase 5 production custody/relay adapter.
 *
 * The monetary state machines and BSC/RPC reads stay in core. This module owns
 * only the closed AWS identity/signing/secret and staged-relay primitives. The
 * protocol object is closed over by the factory, never accepted from runtime
 * configuration; production bundling supplies the exact reviewed AWS/Porto
 * implementations while tests use in-memory protocol fakes.
 */
import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import {
  encodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  padHex,
  recoverAddress,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { PreparedCollection } from "./collection.js";
import type {
  BillingAccountKeyV1,
  BillingAdapterConfigV2,
  BillingBscObservationV1,
  BillingCanExecuteCheckV1,
  BillingSessionRefV1,
  BillingSpendInfoV1,
  ClosedRelayStatus,
  Hex32,
  Hex65,
  OgCredentialV1,
  OgSecretVersionRefV1,
  ProductionBillingCustodyAndRelayPrimitives,
} from "./custody.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;
const MAX_TICKET_BYTES = 4_096;
const MAX_FACTS_BYTES = 32 * 1_024;
const MAX_SECRET_BYTES = 16 * 1_024;
const MAX_SESSION_GENERATION = (1n << 63n) - 1n;
const MIN_PREPARE_LIFETIME_SEC = 30;
const MIN_SEND_LIFETIME_SEC = 10;
const MAX_BLOCK_AGE_SEC = 120;
const NATIVE_DAY_PERIOD = 2;
const PAY_INVOICE_SIGNATURE = "payInvoice(bytes32,uint64)";
const PAY_INVOICE_SELECTOR = toFunctionSelector(PAY_INVOICE_SIGNATURE);
const PAY_INVOICE_SELECTOR_SHA256 = createHash("sha256")
  .update(Buffer.from(PAY_INVOICE_SELECTOR.slice(2), "hex"))
  .digest("hex");
const HEX32 = /^0x[0-9a-f]{64}$/u;
const HEX65 = /^0x04[0-9a-f]{128}$/u;
const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/u;
const KMS_ARN = /^arn:aws:kms:[\x21-\x7e]{8,2036}$/u;
const SECRET_ARN = /^arn:aws:secretsmanager:[\x21-\x7e]{8,2036}$/u;
const VERSION_ID = /^[A-Za-z0-9_-]{32,64}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]?$/u;

type KmsKeySpec = "ECC_SECG_P256K1" | "ECC_NIST_EDWARDS25519";
type KmsAlgorithm = "ECDSA_SHA_256" | "ED25519_SHA_512";

type PublicJwk = Readonly<{
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
}>;

export type AwsKmsKeyDescriptionV1 = Readonly<{
  keyArn: string;
  keySpec: string;
  keyUsage: string;
  keyState: string;
  enabled: boolean;
  signingAlgorithms: readonly string[];
}>;

export type AwsBillingKmsProtocol = Readonly<{
  describeKey(keyArn: string): Promise<AwsKmsKeyDescriptionV1>;
  getPublicKey(keyArn: string): Promise<Readonly<{
    keyArn: string;
    keySpec: string;
    keyUsage: string;
    signingAlgorithms: readonly string[];
    spkiDer: Uint8Array;
  }>>;
  sign(input: Readonly<{
    keyArn: string;
    algorithm: KmsAlgorithm;
    messageType: "RAW" | "DIGEST";
    message: Uint8Array;
  }>): Promise<Uint8Array>;
  close?(): Promise<void>;
}>;

export type AwsBillingSecretsProtocol = Readonly<{
  getSecretValue(input: OgSecretVersionRefV1): Promise<Readonly<{
    secretString?: string;
    secretBinary?: Uint8Array;
  }>>;
  close?(): Promise<void>;
}>;

export type AwsBillingStsProtocol = Readonly<{
  getCallerIdentity(): Promise<Readonly<{
    account?: string;
    arn?: string;
  }>>;
  close?(): Promise<void>;
}>;

export type PortoPreparedCollectionV1 = Readonly<{
  opaque: object;
  digest: unknown;
  chainId: unknown;
  wallet: unknown;
  orchestrator: unknown;
  orchestratorVersion: unknown;
  collector: unknown;
  calldata: unknown;
  valueWei: unknown;
  keyPublicKey: unknown;
  intent: Readonly<{
    eoa: unknown;
    nonce: unknown;
    expiry: unknown;
    executionDataHash: unknown;
    keyHash: unknown;
  }>;
  relayQuoteExpiresAt: unknown;
  capabilitiesPresent: boolean;
  contextPresent: boolean;
  typedDataPresent: boolean;
}>;

export type PortoPreparedIdentityInputV1 = Readonly<{
  wallet: Address;
  collector: Address;
  calldata: Hex;
  valueWei: bigint;
  sessionPublicKey: Hex65;
  orchestrator: Address;
  orchestratorVersion: "0.5.5";
  expectedKey?: object;
}>;

export type AwsBillingPortoProtocol = Readonly<{
  prepare(input: Readonly<{
    relayOrigin: "https://relay.altana.network";
    chainId: 56;
    wallet: Address;
    calls: readonly [Readonly<{ to: Address; data: Hex; value: bigint }>];
    feeToken: typeof zeroAddress;
    session: Readonly<{
      publicKey: Hex65;
      expiresAt: number;
      permissions: unknown;
    }>;
  }>): Promise<PortoPreparedCollectionV1>;
  send(input: Readonly<{
    prepared: object;
    signature: Hex65;
  }>): Promise<Readonly<{ id?: unknown }>>;
  status(callsId: Hex32): Promise<unknown>;
  close?(): Promise<void>;
}>;

export type AwsBillingAdapterProtocols = Readonly<{
  kms: AwsBillingKmsProtocol;
  secrets: AwsBillingSecretsProtocol;
  sts: AwsBillingStsProtocol;
  porto: AwsBillingPortoProtocol;
  now: () => number;
}>;

type VerifiedKmsKey = Readonly<{
  arn: string;
  spec: KmsKeySpec;
  algorithm: KmsAlgorithm;
  publicBytes: Uint8Array;
  spkiDer: Uint8Array;
  publicHex?: Hex65;
  evmAddress?: Address;
}>;

type SessionFacts = Readonly<{
  collector: Address;
  publicKey: Hex65;
  expiry: number;
  dayLimitWei: bigint;
  permissions: unknown;
}>;

type LivePrepared = Readonly<{
  opaque: object;
  witness: Omit<PreparedCollection, "handle">;
  session: BillingSessionRefV1;
  key: VerifiedKmsKey;
}>;

function refuse(reason: string): never {
  throw new Error(`BILLING_ADAPTER_INVALID: ${reason}`);
}

function isPrintableAscii(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max && /^[\x20-\x7e]+$/u.test(value) && value.trim() === value;
}

function assertKeyArn(value: string): void {
  if (value.length < 20 || value.length > 2_048 || !KMS_ARN.test(value)) refuse("KMS reference is malformed.");
}

function assertSecretRef(value: OgSecretVersionRefV1): void {
  if (Object.keys(value).sort().join("|") !== "secretArn|versionId" ||
      value.secretArn.length < 20 || value.secretArn.length > 2_048 ||
      !SECRET_ARN.test(value.secretArn) || !VERSION_ID.test(value.versionId)) {
    refuse("secret reference is malformed.");
  }
}

function sameSecretRef(left: OgSecretVersionRefV1, right: OgSecretVersionRefV1): boolean {
  return left.secretArn === right.secretArn && left.versionId === right.versionId;
}

function safeUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) refuse(`${field} is malformed.`);
  const address = getAddress(value);
  if (address === zeroAddress) refuse(`${field} is zero.`);
  return address;
}

function lowerAddress(value: unknown, field: string): Address {
  return canonicalAddress(value, field).toLowerCase() as Address;
}

function bytesFromHex(value: Hex): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function hexFromBytes(value: Uint8Array): Hex {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  if (Object.keys(value).join("|") !== expected.join("|")) refuse(`${field} member census is malformed.`);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${field} is malformed.`);
  return value as Record<string, unknown>;
}

function canonicalDecimal(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/u.test(value)) refuse(`${field} is malformed.`);
  return BigInt(value);
}

function decodeSessionFacts(session: BillingSessionRefV1): SessionFacts {
  if (typeof session.sessionFactsBytes !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(session.sessionFactsBytes)) {
    refuse("session facts encoding is malformed.");
  }
  const bytes = Buffer.from(session.sessionFactsBytes, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FACTS_BYTES || bytes.toString("base64") !== session.sessionFactsBytes) {
    refuse("session facts encoding is not canonical.");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { refuse("session facts are not UTF-8."); }
  let decoded: unknown;
  try { decoded = JSON.parse(text) as unknown; }
  catch { refuse("session facts JSON is malformed."); }
  const root = asRecord(decoded, "session facts");
  exactKeys(root, ["version", "spec", "permissions", "publicKey", "expiry"], "session facts");
  if (root["version"] !== "billing-session-facts-v1") refuse("session facts version is unsupported.");
  const spec = asRecord(root["spec"], "session spec");
  exactKeys(spec, ["allowedCalls", "spendCaps", "expiresAt"], "session spec");
  const allowedCalls = spec["allowedCalls"];
  const spendCaps = spec["spendCaps"];
  if (!Array.isArray(allowedCalls) || allowedCalls.length !== 1 ||
      !Array.isArray(spendCaps) || spendCaps.length !== 1) refuse("session policy cardinality is invalid.");
  const call = asRecord(allowedCalls[0], "session call");
  exactKeys(call, ["to", "selector"], "session call");
  const collector = lowerAddress(call["to"], "session collector");
  if (call["to"] !== collector || call["selector"] !== PAY_INVOICE_SIGNATURE) {
    refuse("session selector or collector encoding is invalid.");
  }
  const cap = asRecord(spendCaps[0], "session cap");
  exactKeys(cap, ["limit", "period"], "session cap");
  const dayLimitWei = canonicalDecimal(cap["limit"], "session cap limit");
  if (dayLimitWei <= 0n || cap["period"] !== "day") refuse("session cap is invalid.");
  const permissions = asRecord(root["permissions"], "session permissions");
  exactKeys(permissions, ["calls", "spend"], "session permissions");
  const permissionCalls = permissions["calls"];
  const permissionSpend = permissions["spend"];
  if (!Array.isArray(permissionCalls) || permissionCalls.length !== 1 ||
      !Array.isArray(permissionSpend) || permissionSpend.length !== 1) refuse("session permissions cardinality is invalid.");
  const permissionCall = asRecord(permissionCalls[0], "permission call");
  exactKeys(permissionCall, ["signature", "to"], "permission call");
  if (permissionCall["signature"] !== PAY_INVOICE_SIGNATURE ||
      permissionCall["to"] !== collector ||
      lowerAddress(permissionCall["to"], "permission collector") !== collector) refuse("permission call differs from spec.");
  const permissionCap = asRecord(permissionSpend[0], "permission cap");
  exactKeys(permissionCap, ["limit", "period"], "permission cap");
  const uint = asRecord(permissionCap["limit"], "permission uint");
  exactKeys(uint, ["$uint"], "permission uint");
  if (canonicalDecimal(uint["$uint"], "permission limit") !== dayLimitWei ||
      permissionCap["period"] !== "day") refuse("permission cap differs from spec.");
  if (!safeUnixSeconds(spec["expiresAt"]) || !safeUnixSeconds(root["expiry"]) ||
      spec["expiresAt"] !== root["expiry"] || root["expiry"] !== session.expiresAt) {
    refuse("session expiry differs from canonical facts.");
  }
  if (typeof root["publicKey"] !== "string" || root["publicKey"] !== session.publicKey) {
    refuse("session public key differs from canonical facts.");
  }
  if (JSON.stringify(decoded) !== text) refuse("session facts JSON is not canonical.");
  return { collector, publicKey: session.publicKey, expiry: session.expiresAt,
    dayLimitWei, permissions };
}

function validateSessionRef(session: BillingSessionRefV1): SessionFacts {
  if (Object.keys(session).join("|") !==
      "domain|accountId|wallet|kmsKeyArn|publicKey|generation|expiresAt|sessionFactsBytes" ||
      session.domain !== "4lpha.billing-session-ref.v1" ||
      !isPrintableAscii(session.accountId, 1, 128) ||
      !HEX65.test(session.publicKey) || session.generation < 1n ||
      session.generation > MAX_SESSION_GENERATION || !safeUnixSeconds(session.expiresAt)) {
    refuse("billing session reference is malformed.");
  }
  canonicalAddress(session.wallet, "billing wallet");
  assertKeyArn(session.kmsKeyArn);
  return decodeSessionFacts(session);
}

function parseSpkiPublicKey(der: Uint8Array, spec: KmsKeySpec): Readonly<{
  raw: Uint8Array;
  sec1?: Hex65;
  address?: Address;
}> {
  let jwk: PublicJwk;
  try {
    jwk = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" })
      .export({ format: "jwk" }) as PublicJwk;
  } catch { return refuse("KMS public key DER is malformed."); }
  if (spec === "ECC_NIST_EDWARDS25519") {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
      refuse("KMS Ed25519 public key identity drifted.");
    }
    const raw = Uint8Array.from(Buffer.from(jwk.x, "base64url"));
    if (raw.byteLength !== 32) refuse("KMS Ed25519 public key length drifted.");
    return { raw };
  }
  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" ||
      typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    refuse("KMS secp256k1 public key identity drifted.");
  }
  const x = Uint8Array.from(Buffer.from(jwk.x, "base64url"));
  const y = Uint8Array.from(Buffer.from(jwk.y, "base64url"));
  if (x.byteLength !== 32 || y.byteLength !== 32) refuse("KMS secp256k1 public key length drifted.");
  const raw = Uint8Array.from([4, ...x, ...y]);
  const sec1 = hexFromBytes(raw) as Hex65;
  return { raw, sec1, address: getAddress(publicKeyToAddress(sec1)) };
}

async function verifyKmsKey(
  kms: AwsBillingKmsProtocol,
  keyArn: string,
  spec: KmsKeySpec,
  algorithm: KmsAlgorithm,
): Promise<VerifiedKmsKey> {
  assertKeyArn(keyArn);
  let description: AwsKmsKeyDescriptionV1;
  let publicResult: Awaited<ReturnType<AwsBillingKmsProtocol["getPublicKey"]>>;
  try {
    [description, publicResult] = await Promise.all([kms.describeKey(keyArn), kms.getPublicKey(keyArn)]);
  } catch { return refuse("KMS identity read failed."); }
  if (description.keyArn !== keyArn || publicResult.keyArn !== keyArn ||
      description.keySpec !== spec || publicResult.keySpec !== spec ||
      description.keyUsage !== "SIGN_VERIFY" || publicResult.keyUsage !== "SIGN_VERIFY" ||
      description.keyState !== "Enabled" || description.enabled !== true ||
      description.signingAlgorithms.length !== 1 || description.signingAlgorithms[0] !== algorithm ||
      publicResult.signingAlgorithms.length !== 1 || publicResult.signingAlgorithms[0] !== algorithm) {
    refuse("KMS key metadata drifted.");
  }
  const parsed = parseSpkiPublicKey(publicResult.spkiDer, spec);
  return { arn: keyArn, spec, algorithm, publicBytes: parsed.raw,
    spkiDer: Uint8Array.from(publicResult.spkiDer),
    ...(parsed.sec1 === undefined ? {} : { publicHex: parsed.sec1 }),
    ...(parsed.address === undefined ? {} : { evmAddress: parsed.address }) };
}

function derLength(bytes: Uint8Array, offset: number): readonly [number, number] {
  const first = bytes[offset];
  if (first === undefined) refuse("ECDSA DER length is missing.");
  if (first < 0x80) return [first, offset + 1];
  const count = first & 0x7f;
  if (count < 1 || count > 2 || offset + count >= bytes.length) refuse("ECDSA DER length is malformed.");
  let length = 0;
  for (let index = 0; index < count; index += 1) length = length * 256 + bytes[offset + 1 + index]!;
  if (length < 0x80 || (count === 2 && bytes[offset + 1] === 0)) refuse("ECDSA DER length is non-canonical.");
  return [length, offset + 1 + count];
}

function derInteger(bytes: Uint8Array, offset: number): readonly [bigint, number] {
  if (bytes[offset] !== 0x02) refuse("ECDSA DER integer tag is malformed.");
  const [length, start] = derLength(bytes, offset + 1);
  const end = start + length;
  if (length < 1 || end > bytes.length) refuse("ECDSA DER integer length is malformed.");
  const first = bytes[start]!;
  if ((first & 0x80) !== 0 || (length > 1 && first === 0 && (bytes[start + 1]! & 0x80) === 0)) {
    refuse("ECDSA DER integer is not canonical positive form.");
  }
  let value = 0n;
  for (let index = start; index < end; index += 1) value = (value << 8n) | BigInt(bytes[index]!);
  return [value, end];
}

function parseDerSignature(bytes: Uint8Array): Readonly<{ r: bigint; s: bigint }> {
  if (bytes[0] !== 0x30) refuse("ECDSA DER sequence tag is malformed.");
  const [length, bodyStart] = derLength(bytes, 1);
  if (bodyStart + length !== bytes.length) refuse("ECDSA DER sequence length is malformed.");
  const [r, afterR] = derInteger(bytes, bodyStart);
  const [s, afterS] = derInteger(bytes, afterR);
  if (afterS !== bytes.length || r <= 0n || r >= SECP256K1_N || s <= 0n || s >= SECP256K1_N) {
    refuse("ECDSA scalar is out of range.");
  }
  return { r, s };
}

function scalarHex(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

async function ethereumSignature(
  digest: Hex32,
  der: Uint8Array,
  expectedAddress: Address,
): Promise<Hex65> {
  const { r, s } = parseDerSignature(der);
  const candidates: number[] = [];
  for (const parity of [0, 1] as const) {
    const candidate = `0x${scalarHex(r)}${scalarHex(s)}0${parity}` as Hex65;
    try {
      if ((await recoverAddress({ hash: digest, signature: candidate })).toLowerCase() ===
          expectedAddress.toLowerCase()) candidates.push(parity);
    } catch { /* malformed recovery is simply not the matching candidate */ }
  }
  if (candidates.length !== 1) refuse("ECDSA recovery parity is ambiguous.");
  let parity = candidates[0]!;
  let normalizedS = s;
  if (s > SECP256K1_HALF_N) {
    normalizedS = SECP256K1_N - s;
    parity ^= 1;
  }
  const signature = `0x${scalarHex(r)}${scalarHex(normalizedS)}0${parity}` as Hex65;
  if (!HEX65_SIGNATURE.test(signature) ||
      (await recoverAddress({ hash: digest, signature })).toLowerCase() !== expectedAddress.toLowerCase()) {
    refuse("ECDSA normalized signature does not recover the expected signer.");
  }
  return signature;
}

const HEX65_SIGNATURE = /^0x[0-9a-f]{128}(?:00|01)$/u;

async function kmsEthereumSign(
  kms: AwsBillingKmsProtocol,
  key: VerifiedKmsKey,
  digest: Hex32,
): Promise<Hex65> {
  if (!HEX32.test(digest) || key.spec !== "ECC_SECG_P256K1" || key.evmAddress === undefined) {
    refuse("secp256k1 signing input is malformed.");
  }
  let der: Uint8Array;
  try {
    der = await kms.sign({ keyArn: key.arn, algorithm: "ECDSA_SHA_256",
      messageType: "DIGEST", message: bytesFromHex(digest) });
  } catch { return refuse("KMS signing failed."); }
  return ethereumSignature(digest, der, key.evmAddress);
}

async function loadSecret(
  secrets: AwsBillingSecretsProtocol,
  ref: OgSecretVersionRefV1,
): Promise<OgCredentialV1> {
  assertSecretRef(ref);
  let result: Awaited<ReturnType<AwsBillingSecretsProtocol["getSecretValue"]>>;
  try { result = await secrets.getSecretValue(ref); }
  catch { return refuse("secret read failed."); }
  if (result.secretBinary !== undefined || typeof result.secretString !== "string" ||
      Buffer.byteLength(result.secretString, "utf8") > MAX_SECRET_BYTES) refuse("secret payload is malformed.");
  let decoded: unknown;
  try { decoded = JSON.parse(result.secretString) as unknown; }
  catch { refuse("secret payload is malformed."); }
  const row = asRecord(decoded, "0G credential");
  exactKeys(row, ["version", "bearerToken", "apiKeyId", "payerAccountId"], "0G credential");
  if (row["version"] !== "4lpha-0g-credential-v1" ||
      typeof row["bearerToken"] !== "string" || !isPrintableAscii(row["bearerToken"], 16, 8_192) ||
      typeof row["apiKeyId"] !== "string" || !isPrintableAscii(row["apiKeyId"], 1, 256) ||
      typeof row["payerAccountId"] !== "string" || !isPrintableAscii(row["payerAccountId"], 1, 256)) {
    refuse("0G credential fields are malformed.");
  }
  return { bearerToken: row["bearerToken"], apiKeyId: row["apiKeyId"], payerAccountId: row["payerAccountId"] };
}

function assumedRoleMatches(arn: string, expectedRoleArn: string, account: string): boolean {
  const expected = /^arn:(aws(?:-us-gov)?):iam::([0-9]{12}):role\/(.+)$/u.exec(expectedRoleArn);
  const actual = /^arn:(aws(?:-us-gov)?):sts::([0-9]{12}):assumed-role\/(.+)\/[^/]+$/u.exec(arn);
  return expected !== null && actual !== null && expected[1] === actual[1] &&
    expected[2] === account && actual[2] === account && expected[3] === actual[3];
}

function validCredentialConfig(config: BillingAdapterConfigV2): boolean {
  const rolePrefix = `arn:aws:iam::${config.awsAccountId}:role/`;
  if (!config.runtimeRoleArn.startsWith(rolePrefix) || config.runtimeRoleArn.length === rolePrefix.length ||
      config.runtimeRoleArn.endsWith("/")) return false;
  const credential = config.credential;
  if (credential.kind === "ecs-task-role-v1") return Object.keys(credential).join("|") === "kind";
  const keys = "kind|trustAnchorArn|profileArn|certificateSha256|certificateSubjectCn|certificateIssuerCn|helperVersion|helperBytes|helperSha256";
  const trustPrefix = `arn:aws:rolesanywhere:${config.awsRegion}:${config.awsAccountId}:trust-anchor/`;
  const profilePrefix = `arn:aws:rolesanywhere:${config.awsRegion}:${config.awsAccountId}:profile/`;
  const id = (value: string, prefix: string): boolean => value.startsWith(prefix) &&
    /^[A-Za-z0-9-]{1,64}$/u.test(value.slice(prefix.length));
  return Object.keys(credential).join("|") === keys && id(credential.trustAnchorArn, trustPrefix) &&
    id(credential.profileArn, profilePrefix) && /^[0-9a-f]{64}$/u.test(credential.certificateSha256) &&
    isPrintableAscii(credential.certificateSubjectCn, 1, 61) &&
    isPrintableAscii(credential.certificateIssuerCn, 1, 61) &&
    !credential.certificateSubjectCn.includes("*") && !credential.certificateIssuerCn.includes("*") &&
    credential.certificateSubjectCn !== credential.certificateIssuerCn && credential.helperVersion === "1.8.4" &&
    credential.helperBytes === "12094568" &&
    credential.helperSha256 === "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9";
}

function validateConfig(config: BillingAdapterConfigV2): void {
  if (Object.keys(config).join("|") !==
      "domain|awsRegion|awsAccountId|runtimeRoleArn|credential|relayOrigin|chainId|orchestrator|keyStore|ticketKeyArn|ticketPublicKeySpkiBase64url|x402KeyArn|x402Authorizer|x402Enabled|ogEnabled|ogPayerAccountId|ogInference|ogManagement" ||
      config.domain !== "4lpha.billing-adapter-config.v2" || !REGION.test(config.awsRegion) ||
      !ACCOUNT_ID.test(config.awsAccountId) || !validCredentialConfig(config) ||
      config.relayOrigin !== "https://relay.altana.network" ||
      config.chainId !== 56 || config.orchestrator.toLowerCase() !==
        "0xaf140d0416a994aebb3fa6212b16ce6700f09751" || config.keyStore.toLowerCase() !==
        "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a" ||
      typeof config.x402Enabled !== "boolean" || typeof config.ogEnabled !== "boolean" ||
      (!config.x402Enabled && !config.ogEnabled) || !isPrintableAscii(config.ogPayerAccountId, 1, 256) ||
      lowerAddress(config.x402Authorizer, "x402 authorizer") !== config.x402Authorizer ||
      !/^[A-Za-z0-9_-]{40,256}$/u.test(config.ticketPublicKeySpkiBase64url)) {
    refuse("adapter config is malformed.");
  }
  const ticketPublicDer = Buffer.from(config.ticketPublicKeySpkiBase64url, "base64url");
  if (ticketPublicDer.byteLength === 0 || ticketPublicDer.toString("base64url") !==
      config.ticketPublicKeySpkiBase64url) refuse("ticket public key encoding is malformed.");
  assertKeyArn(config.ticketKeyArn);
  assertKeyArn(config.x402KeyArn);
  assertSecretRef(config.ogInference);
  assertSecretRef(config.ogManagement);
  if (config.ticketKeyArn === config.x402KeyArn || sameSecretRef(config.ogInference, config.ogManagement)) {
    refuse("adapter roles collide.");
  }
}

const PAY_INVOICE_ABI = [{
  type: "function", name: "payInvoice", stateMutability: "payable",
  inputs: [{ name: "invoiceId", type: "bytes32" }, { name: "quoteExpiresAt", type: "uint64" }],
  outputs: [],
}] as const;

export function assertCanonicalBillingPayInvoiceCalldata(value: unknown, expectedExpiry?: number): Hex {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) refuse("billing calldata is malformed.");
  let decoded: ReturnType<typeof decodeFunctionData<typeof PAY_INVOICE_ABI>>;
  try { decoded = decodeFunctionData({ abi: PAY_INVOICE_ABI, data: value as Hex }); }
  catch { return refuse("billing calldata is not payInvoice."); }
  const invoiceId = decoded.args[0];
  const expiry = decoded.args[1];
  if (!HEX32.test(invoiceId) || invoiceId === `0x${"00".repeat(32)}` || expiry <= 0n ||
      expiry > BigInt(Number.MAX_SAFE_INTEGER) ||
      (expectedExpiry !== undefined && expiry !== BigInt(expectedExpiry))) {
    refuse("billing calldata arguments are invalid.");
  }
  const canonical = encodeFunctionData({ abi: PAY_INVOICE_ABI, functionName: "payInvoice",
    args: [invoiceId, expiry] });
  if (canonical !== value) refuse("billing calldata is not canonical.");
  return canonical;
}

function expectedCanExecuteHash(check: BillingCanExecuteCheckV1): string {
  if (check.kind === "selector" && Object.keys(check).join("|") === "kind") {
    return PAY_INVOICE_SELECTOR_SHA256;
  }
  if (check.kind === "calldata" && Object.keys(check).join("|") === "kind|calldata") {
    const calldata = assertCanonicalBillingPayInvoiceCalldata(check.calldata);
    return createHash("sha256").update(Buffer.from(calldata.slice(2), "hex")).digest("hex");
  }
  return refuse("canExecute evidence boundary is malformed.");
}

export function billingAccountKeyHash(publicKey: Hex65): Hex32 {
  if (!HEX65.test(publicKey)) refuse("billing session public key is malformed.");
  const address = publicKeyToAddress(publicKey);
  const publicKeyHash = keccak256(padHex(getAddress(address), { size: 32 }));
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }], [2n, publicKeyHash],
  )) as Hex32;
}

function validateAccountKeys(
  keys: readonly BillingAccountKeyV1[],
  hashes: readonly Hex32[],
  forbidden: Hex32,
): void {
  if (keys.length !== hashes.length || keys.length > 64 || new Set(hashes).size !== hashes.length ||
      hashes.some((hash) => !HEX32.test(hash))) refuse("account key census is malformed.");
  for (const key of keys) {
    if (Object.keys(key).join("|") !== "expiry|keyType|isSuperAdmin|publicKey" ||
        !Number.isInteger(key.keyType) || key.keyType < 0 || key.keyType > 255 || key.expiry < 0n ||
        typeof key.isSuperAdmin !== "boolean" || !HEX_BYTES.test(key.publicKey)) {
      refuse("account key row is malformed.");
    }
  }
  if (hashes.includes(forbidden)) refuse("account contains duplicate local session authority.");
}

function canonicalObservation(observation: BillingBscObservationV1): string {
  return JSON.stringify(observation, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}

function validateObservationPair(input: Readonly<{
  session: BillingSessionRefV1;
  canExecute: BillingCanExecuteCheckV1;
  observations: readonly [BillingBscObservationV1, BillingBscObservationV1];
  now: number;
}>): Readonly<{ facts: SessionFacts; observation: BillingBscObservationV1; positive: BillingSpendInfoV1 }> {
  const facts = validateSessionRef(input.session);
  if (Object.keys(input).join("|") !== "session|canExecute|observations|now") refuse("BSC read input is malformed.");
  const canExecuteHash = expectedCanExecuteHash(input.canExecute);
  if (!safeUnixSeconds(input.now) || input.session.expiresAt <= input.now) refuse("billing session is expired.");
  const [first, second] = input.observations;
  const observationKeys = "blockNumber|blockHash|blockTimestamp|keyStoreValid|canPayCollector|canExecuteCalldataSha256|accountKeys|accountKeyHashes|spendInfos|walletBalanceWei";
  if (input.observations.length !== 2 || Object.keys(first).join("|") !== observationKeys ||
      Object.keys(second).join("|") !== observationKeys) refuse("BSC observation census is malformed.");
  if (canonicalObservation(first) !== canonicalObservation(second)) refuse("BSC observations disagree.");
  if (first.blockNumber < 0n || !HEX32.test(first.blockHash) || !safeUnixSeconds(first.blockTimestamp) ||
      first.blockTimestamp > input.now || input.now - first.blockTimestamp > MAX_BLOCK_AGE_SEC ||
      first.keyStoreValid !== true || first.canPayCollector !== true ||
      first.canExecuteCalldataSha256 !== canExecuteHash || first.walletBalanceWei < 0n) {
    refuse("BSC observation is stale or unauthorized.");
  }
  validateAccountKeys(first.accountKeys, first.accountKeyHashes, billingAccountKeyHash(input.session.publicKey));
  const positive = first.spendInfos.filter((row) => row.limit > 0n);
  if (positive.length !== 1) refuse("native DAY meter is ambiguous.");
  const selected = positive[0]!;
  for (const row of first.spendInfos) validateSpendInfo(row);
  if (selected.token.toLowerCase() !== zeroAddress || selected.period !== NATIVE_DAY_PERIOD ||
      selected.limit !== facts.dayLimitWei || selected.currentSpent > selected.limit) {
    refuse("native DAY meter differs from session facts.");
  }
  return { facts, observation: first, positive: selected };
}

function validateSpendInfo(row: BillingSpendInfoV1): void {
  if (Object.keys(row).join("|") !== "token|period|limit|spent|lastUpdated|currentSpent|current" ||
      !isAddress(row.token, { strict: false }) || !Number.isInteger(row.period) || row.period < 0 ||
      row.limit < 0n || row.spent < 0n || row.lastUpdated < 0n || row.currentSpent < 0n || row.current < 0n) {
    refuse("spend meter row is malformed.");
  }
}

export function billingCallsExecutionDataHash(input: Readonly<{
  collector: Address;
  calldata: Hex;
  valueWei: bigint;
}>): Hex32 {
  return keccak256(encodeAbiParameters([{
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  }], [[{ target: input.collector, value: input.valueWei, data: input.calldata }]])) as Hex32;
}

function decimalNonce(value: unknown): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/u.test(value);
}

const PORTO_QUOTE_KEYS = new Set([
  "additionalAuthorization", "assetDeficits", "authorizationAddress", "chainId", "ethPrice",
  "extraPayment", "feeTokenDeficit", "intent", "nativeFeeEstimate", "orchestrator",
  "paymentTokenDecimals", "txGas",
]);
const PORTO_INTENT_KEYS = new Set([
  "combinedGas", "encodedFundTransfers", "encodedPreCalls", "eoa", "executionData", "expiry",
  "funder", "funderSignature", "isMultichain", "nonce", "payer", "paymentAmount",
  "paymentMaxAmount", "paymentRecipient", "paymentSignature", "paymentToken", "prePaymentAmount",
  "prePaymentMaxAmount", "settler", "settlerContext", "signature", "supportedAccountImplementation",
  "totalPaymentAmount", "totalPaymentMaxAmount",
]);

function hasOnlyKnownMembers(value: Record<string, unknown>, known: ReadonlySet<string>): boolean {
  return Object.keys(value).every((member) => known.has(member));
}

function portoWireSecond(value: unknown): unknown {
  return typeof value === "bigint" && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) : value;
}

/**
 * One public, non-signing validator for the Porto prepare response used by both
 * the production relay protocol and the prepare-only expiry diagnostic.
 */
export function validatePortoPreparedIdentityV1(
  input: PortoPreparedIdentityInputV1,
  value: unknown,
): PortoPreparedCollectionV1 {
  const result = asRecord(value, "Porto prepare response");
  const context = asRecord(result["context"], "Porto prepare context");
  const capabilities = asRecord(result["capabilities"], "Porto prepare capabilities");
  const quote = asRecord(context["quote"], "Porto prepare quote");
  if (capabilities["quote"] !== context["quote"] || !Array.isArray(quote["quotes"]) ||
      quote["quotes"].length !== 1) refuse("Porto prepare response is ambiguous.");
  const selected = asRecord(quote["quotes"][0], "Porto selected quote");
  const intent = asRecord(selected["intent"], "Porto selected intent");
  if (!hasOnlyKnownMembers(selected, PORTO_QUOTE_KEYS) ||
      !hasOnlyKnownMembers(intent, PORTO_INTENT_KEYS)) {
    refuse("Porto prepare identity drifted.");
  }
  const typedData = asRecord(result["typedData"], "Porto prepare typed data");
  const domain = asRecord(typedData["domain"], "Porto prepare typed-data domain");
  const preparedKey = asRecord(result["key"], "Porto prepared key");
  const typedDataKeys = Object.keys(typedData).sort().join("|");
  const domainKeys = Object.keys(domain).sort().join("|");
  let digest: Hex;
  try { digest = hashTypedData(typedData as Parameters<typeof hashTypedData>[0]); }
  catch { return refuse("Porto prepared typed data is malformed."); }
  const expectedAddress = publicKeyToAddress(input.sessionPublicKey).toLowerCase();
  const expectedKeyHash = billingAccountKeyHash(input.sessionPublicKey);
  const preparedAddress = typeof preparedKey["publicKey"] === "string"
    ? preparedKey["publicKey"].toLowerCase() : "";
  const preparedKeyHash = isAddress(preparedAddress, { strict: false })
    ? keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }],
      [2n, keccak256(padHex(preparedAddress as Address, { size: 32 }))])) : "";
  const executionData = intent["executionData"];
  const nonce = typeof intent["nonce"] === "bigint" && intent["nonce"] >= 0n
    ? intent["nonce"].toString(10) : intent["nonce"];
  const sameAddress = (value: unknown, expected: Address): boolean =>
    typeof value === "string" && isAddress(value, { strict: false }) &&
    value.toLowerCase() === expected.toLowerCase();
  if (!HEX32.test(String(result["digest"])) || result["digest"] !== digest ||
      typedDataKeys !== "domain|message|primaryType|types" ||
      domainKeys !== "chainId|name|verifyingContract|version" ||
      typeof domain["name"] !== "string" || domain["name"].length === 0 ||
      (domain["chainId"] !== 56 && domain["chainId"] !== 56n) ||
      !sameAddress(domain["verifyingContract"], input.orchestrator) ||
      domain["version"] !== input.orchestratorVersion ||
      (selected["chainId"] !== 56 && selected["chainId"] !== 56n) ||
      !sameAddress(selected["orchestrator"], input.orchestrator) ||
      !sameAddress(intent["eoa"], input.wallet) ||
      !decimalNonce(nonce) || typeof executionData !== "string" || !HEX_BYTES.test(executionData) ||
      keccak256(executionData as Hex) !== billingCallsExecutionDataHash(input) ||
      preparedKey["type"] !== "secp256k1" || preparedAddress !== expectedAddress ||
      preparedKeyHash !== expectedKeyHash ||
      (preparedKey["hash"] !== undefined && preparedKey["hash"] !== expectedKeyHash) ||
      (preparedKey["id"] !== undefined && preparedKey["id"]?.toString().toLowerCase() !== expectedAddress) ||
      (preparedKey["prehash"] !== undefined && preparedKey["prehash"] !== false) ||
      (preparedKey["role"] !== undefined && preparedKey["role"] !== "session") ||
      (input.expectedKey !== undefined && result["key"] !== input.expectedKey)) {
    refuse("Porto prepare identity drifted.");
  }
  return Object.freeze({
    opaque: Object.freeze({ capabilities, context, key: preparedKey }), digest: result["digest"],
    chainId: 56, wallet: intent["eoa"], orchestrator: selected["orchestrator"],
    orchestratorVersion: domain["version"], collector: input.collector, calldata: input.calldata,
    valueWei: input.valueWei, keyPublicKey: input.sessionPublicKey,
    intent: { eoa: intent["eoa"], nonce, expiry: portoWireSecond(intent["expiry"]),
      executionDataHash: keccak256(executionData as Hex), keyHash: expectedKeyHash },
    relayQuoteExpiresAt: portoWireSecond(quote["ttl"]), capabilitiesPresent: true,
    contextPresent: true, typedDataPresent: true,
  });
}

function exactPreparedWitness(left: PreparedCollection, right: Omit<PreparedCollection, "handle">): boolean {
  return left.digest === right.digest && left.chainId === right.chainId &&
    left.wallet.toLowerCase() === right.wallet.toLowerCase() &&
    left.collector.toLowerCase() === right.collector.toLowerCase() && left.calldata === right.calldata &&
    left.value === right.value && left.sessionGeneration === right.sessionGeneration &&
    left.relayQuoteExpiresAt === right.relayQuoteExpiresAt &&
    left.relayIntentExpiresAt === right.relayIntentExpiresAt;
}

function closedStatus(value: unknown, requested: Hex32): ClosedRelayStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { state: "PENDING" };
  const row = value as Record<string, unknown>;
  if (row["id"] !== requested || typeof row["status"] !== "number" ||
      !Number.isInteger(row["status"]) || !Array.isArray(row["receipts"]) || row["receipts"].length !== 1) {
    return { state: "PENDING" };
  }
  const receipt = row["receipts"][0];
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return { state: "PENDING" };
  const typed = receipt as Record<string, unknown>;
  if (typed["chainId"] !== 56 || typeof typed["transactionHash"] !== "string" ||
      !HEX32.test(typed["transactionHash"])) return { state: "PENDING" };
  const transactionHash = typed["transactionHash"] as Hex32;
  if (row["status"] === 200 && typed["status"] === "0x1") return { state: "CONFIRMED", transactionHash };
  if (row["status"] >= 400 && row["status"] <= 599) return { state: "FAILED", transactionHash };
  return { state: "PENDING" };
}

/**
 * Creates the exact-config production factory while keeping protocol clients
 * out of operator input. The reviewed self-contained bundle closes over the
 * AWS SDK/Porto implementations; offline tests close over deterministic fakes.
 */
export function createAwsBillingAdapterFactory(protocols: AwsBillingAdapterProtocols): (
  config: BillingAdapterConfigV2,
) => Promise<ProductionBillingCustodyAndRelayPrimitives> {
  return async (config) => {
    validateConfig(config);
    let caller: Awaited<ReturnType<AwsBillingStsProtocol["getCallerIdentity"]>>;
    try { caller = await protocols.sts.getCallerIdentity(); }
    catch { return refuse("AWS workload identity read failed."); }
    if (caller.account !== config.awsAccountId || typeof caller.arn !== "string" ||
        !assumedRoleMatches(caller.arn, config.runtimeRoleArn, config.awsAccountId)) {
      refuse("AWS workload identity differs from the reviewed role.");
    }
    const [ticketKey, x402Key] = await Promise.all([
      verifyKmsKey(protocols.kms, config.ticketKeyArn, "ECC_NIST_EDWARDS25519", "ED25519_SHA_512"),
      verifyKmsKey(protocols.kms, config.x402KeyArn, "ECC_SECG_P256K1", "ECDSA_SHA_256"),
    ]);
    if (!constantEqual(base64url(ticketKey.spkiDer), config.ticketPublicKeySpkiBase64url) ||
        x402Key.evmAddress?.toLowerCase() !== config.x402Authorizer) {
      refuse("KMS public identity differs from the reviewed provider identity.");
    }
    let inference: OgCredentialV1 | undefined;
    let management: OgCredentialV1 | undefined;
    if (config.ogEnabled) {
      [inference, management] = await Promise.all([
        loadSecret(protocols.secrets, config.ogInference),
        loadSecret(protocols.secrets, config.ogManagement),
      ]);
      if (inference.payerAccountId !== config.ogPayerAccountId ||
          management.payerAccountId !== config.ogPayerAccountId ||
          inference.payerAccountId !== management.payerAccountId ||
          constantEqual(inference.apiKeyId, management.apiKeyId) ||
          constantEqual(inference.bearerToken, management.bearerToken)) {
        refuse("0G credential roles collide or payer identities differ.");
      }
    }
    const liveHandles = new WeakSet<object>();
    const preparedByHandle = new WeakMap<object, LivePrepared>();
    const sessionKeys = new Map<string, VerifiedKmsKey>();
    let closed = false;
    const open = (): void => { if (closed) refuse("adapter is closed."); };

    const adapter: ProductionBillingCustodyAndRelayPrimitives = {
      async signExecutionTicket(input) {
        open();
        if (Object.keys(input).join("|") !== "keyArn|bytes" ||
            input.keyArn !== config.ticketKeyArn || input.keyArn !== ticketKey.arn ||
            !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 ||
            input.bytes.byteLength > MAX_TICKET_BYTES) refuse("ticket signing input is malformed.");
        let signature: Uint8Array;
        try {
          signature = await protocols.kms.sign({ keyArn: ticketKey.arn,
            algorithm: "ED25519_SHA_512", messageType: "RAW", message: input.bytes });
        } catch { return refuse("KMS signing failed."); }
        if (signature.byteLength !== 64) refuse("Ed25519 signature length drifted.");
        return base64url(signature);
      },

      async signX402(input) {
        open();
        if (Object.keys(input).join("|") !== "keyArn|digest" ||
            !config.x402Enabled || input.keyArn !== config.x402KeyArn ||
            input.keyArn !== x402Key.arn || !HEX32.test(input.digest)) {
          refuse("x402 signing input is malformed.");
        }
        return kmsEthereumSign(protocols.kms, x402Key, input.digest);
      },

      async loadOgCredential(input) {
        open();
        if (!config.ogEnabled || inference === undefined || management === undefined) {
          return refuse("0G provider is disabled.");
        }
        if (sameSecretRef(input, config.ogInference)) return { ...inference };
        if (sameSecretRef(input, config.ogManagement)) return { ...management };
        return refuse("secret reference is outside the closed adapter config.");
      },

      async readBillingSession(input) {
        open();
        if (Object.keys(input).join("|") !== "session|canExecute|observations|now") refuse("billing session read input is malformed.");
        const result = validateObservationPair(input);
        return { generation: input.session.generation, expiresAt: result.facts.expiry };
      },

      async readBillingMeter(input) {
        open();
        if (Object.keys(input).join("|") !== "meter|canExecute|observations|now" ||
            Object.keys(input.meter).join("|") !== "session|meterPeriod|meterToken" ||
            input.meter.meterPeriod !== "DAY" || input.meter.meterToken !== "native") {
          refuse("billing meter reference is malformed.");
        }
        const result = validateObservationPair({ session: input.meter.session,
          canExecute: input.canExecute, observations: input.observations, now: input.now });
        return { balanceWei: result.observation.walletBalanceWei,
          remainingDayCapWei: result.positive.limit - result.positive.currentSpent };
      },

      async relayPrepare(input) {
        open();
        if (Object.keys(input).join("|") !== "domain|session|collector|calldata|valueWei|maxExpiresAt" ||
            input.domain !== "4lpha.billing-collection-prepare.v1" ||
            input.valueWei <= 0n || !safeUnixSeconds(input.maxExpiresAt)) refuse("relay prepare input is malformed.");
        assertCanonicalBillingPayInvoiceCalldata(input.calldata, input.maxExpiresAt);
        const facts = validateSessionRef(input.session);
        const collector = canonicalAddress(input.collector, "collector");
        const now = protocols.now();
        if (!safeUnixSeconds(now) || now + MIN_PREPARE_LIFETIME_SEC > input.maxExpiresAt ||
            input.session.expiresAt <= now || facts.collector.toLowerCase() !== collector.toLowerCase()) {
          refuse("relay prepare lifetime or collector is invalid.");
        }
        if (input.session.kmsKeyArn === config.ticketKeyArn || input.session.kmsKeyArn === config.x402KeyArn) {
          refuse("billing session KMS role collides.");
        }
        const key = await verifyKmsKey(protocols.kms, input.session.kmsKeyArn,
          "ECC_SECG_P256K1", "ECDSA_SHA_256");
        if (key.publicHex !== input.session.publicKey) refuse("billing session KMS public key drifted.");
        sessionKeys.set(input.session.kmsKeyArn, key);
        let response: PortoPreparedCollectionV1;
        try {
          response = await protocols.porto.prepare({ relayOrigin: config.relayOrigin,
            chainId: 56, wallet: getAddress(input.session.wallet), calls: [{ to: collector,
              data: input.calldata, value: input.valueWei }], feeToken: zeroAddress,
            session: { publicKey: input.session.publicKey, expiresAt: input.session.expiresAt,
              permissions: facts.permissions } });
        } catch { return refuse("relay prepare failed."); }
        const quoteExpiry = response.relayQuoteExpiresAt;
        const intentExpiry = response.intent.expiry;
        const expectedExecutionHash = billingCallsExecutionDataHash(input);
        const expectedKeyHash = billingAccountKeyHash(input.session.publicKey);
        if (!HEX32.test(String(response.digest)) || response.chainId !== 56 ||
            lowerAddress(response.wallet, "prepared wallet") !== input.session.wallet.toLowerCase() ||
            lowerAddress(response.collector, "prepared collector") !== collector.toLowerCase() ||
            lowerAddress(response.orchestrator, "prepared orchestrator") !== config.orchestrator.toLowerCase() ||
            response.orchestratorVersion !== "0.5.5" || response.calldata !== input.calldata ||
            response.valueWei !== input.valueWei || response.keyPublicKey !== input.session.publicKey ||
            lowerAddress(response.intent.eoa, "prepared intent wallet") !== input.session.wallet.toLowerCase() ||
            !decimalNonce(response.intent.nonce) || response.intent.executionDataHash !== expectedExecutionHash ||
            response.intent.keyHash !== expectedKeyHash || response.capabilitiesPresent !== true ||
            response.contextPresent !== true || response.typedDataPresent !== true ||
            typeof response.opaque !== "object" || response.opaque === null ||
            !safeUnixSeconds(quoteExpiry) || !safeUnixSeconds(intentExpiry) ||
            now + MIN_PREPARE_LIFETIME_SEC > quoteExpiry ||
            now + MIN_PREPARE_LIFETIME_SEC > intentExpiry || intentExpiry > quoteExpiry ||
            quoteExpiry > input.maxExpiresAt) {
          refuse("relay prepared response differs from the closed request.");
        }
        const handle = Object.freeze({});
        const witness = Object.freeze({ digest: response.digest as Hex32, chainId: 56 as const,
          wallet: input.session.wallet, collector, calldata: input.calldata, value: input.valueWei,
          sessionGeneration: input.session.generation, relayQuoteExpiresAt: quoteExpiry,
          relayIntentExpiresAt: intentExpiry });
        liveHandles.add(handle);
        preparedByHandle.set(handle, { opaque: response.opaque, witness, session: input.session, key });
        return Object.freeze({ handle, ...witness });
      },

      async relaySend(prepared) {
        open();
        const live = preparedByHandle.get(prepared.handle);
        if (live === undefined || !liveHandles.delete(prepared.handle) || !exactPreparedWitness(prepared, live.witness)) {
          refuse("prepared collection handle is missing or substituted.");
        }
        preparedByHandle.delete(prepared.handle);
        const now = protocols.now();
        if (!safeUnixSeconds(now) || now + MIN_SEND_LIFETIME_SEC > prepared.relayQuoteExpiresAt ||
            now + MIN_SEND_LIFETIME_SEC > prepared.relayIntentExpiresAt ||
            prepared.relayIntentExpiresAt <= 0) refuse("prepared collection lifetime is insufficient.");
        const currentKey = await verifyKmsKey(protocols.kms, live.session.kmsKeyArn,
          "ECC_SECG_P256K1", "ECDSA_SHA_256");
        if (currentKey.publicHex !== live.session.publicKey || currentKey.publicHex !== live.key.publicHex ||
            sessionKeys.get(live.session.kmsKeyArn)?.publicHex !== currentKey.publicHex) {
          refuse("billing session KMS public key drifted before send.");
        }
        const signature = await kmsEthereumSign(protocols.kms, currentKey, prepared.digest as Hex32);
        let sent: Awaited<ReturnType<AwsBillingPortoProtocol["send"]>>;
        try { sent = await protocols.porto.send({ prepared: live.opaque, signature }); }
        catch { return refuse("relay send outcome is ambiguous."); }
        if (sent.id === undefined) return {};
        if (typeof sent.id !== "string" || !HEX32.test(sent.id)) refuse("relay calls ID is malformed.");
        return { callsId: sent.id as Hex32 };
      },

      async relayStatus(callsId) {
        open();
        if (!HEX32.test(callsId)) refuse("relay calls ID is malformed.");
        let result: unknown;
        try { result = await protocols.porto.status(callsId); }
        catch { return { state: "PENDING" }; }
        return closedStatus(result, callsId);
      },

      async close() {
        if (closed) return;
        closed = true;
        await Promise.allSettled([
          protocols.porto.close?.(), protocols.secrets.close?.(), protocols.kms.close?.(), protocols.sts.close?.(),
        ].filter((promise): promise is Promise<void> => promise !== undefined));
      },
    };
    return Object.freeze(adapter);
  };
}

/** Pure alias used by a self-contained production bundle after closing over its protocol clients. */
export const createBillingCustodyAndRelayPrimitivesFactory = createAwsBillingAdapterFactory;
