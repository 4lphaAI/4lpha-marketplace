import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";
import { BILLING_FORBIDDEN_AWS_ENV_NAMES } from "./awsBillingEnvironment.js";
import type { BillingAwsCredentialV2 } from "./productionManifest.js";

export const BILLING_AWS_SIGNING_HELPER_PATH = "/usr/local/bin/aws_signing_helper";
export const BILLING_AWS_RA_CERTIFICATE_PATH = "/run/4lpha/roles-anywhere/certificate.pem";
export const BILLING_AWS_RA_PRIVATE_KEY_PATH = "/run/4lpha/roles-anywhere/private-key.pem";
export const BILLING_AWS_SIGNING_HELPER_BYTES = 12_094_568;
export const BILLING_AWS_SIGNING_HELPER_SHA256 =
  "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9";

const ECS_HOST = "169.254.170.2";
const MAX_ECS_BYTES = 16 * 1_024;
const MAX_HELPER_OUTPUT_BYTES = 65_536;
const MAX_PEM_BYTES = 16_384;
const REFRESH_EARLY_MS = 120_000;
const HELPER_TIMEOUT_MS = 5_000;
const MAX_HELPER_LIFETIME_MS = 900_000;
const MIN_CERTIFICATE_REMAINING_MS = 30 * 60_000;
const MAX_CERTIFICATE_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const ECDSA_SHA256_ALGORITHM = Buffer.from("300a06082a8648ce3d040302", "hex");
const P256_SPKI_ALGORITHM = Buffer.from("301306072a8648ce3d020106082a8648ce3d030107", "hex");
const BASIC_CONSTRAINTS_OID = Buffer.from("0603551d13", "hex");
const KEY_USAGE_OID = Buffer.from("0603551d0f", "hex");

const RAW_RAILWAY_NAMES = [
  "BILLING_PRODUCTION_MANIFEST_BASE64",
  "BILLING_AWS_RA_CERTIFICATE_PEM",
  "BILLING_AWS_RA_PRIVATE_KEY_PEM",
] as const;
const RA_PATH_NAMES = [
  "BILLING_AWS_RA_CERTIFICATE_PATH",
  "BILLING_AWS_RA_PRIVATE_KEY_PATH",
  "BILLING_RAILWAY_CLEAN_EXEC",
] as const;
const FORBIDDEN_AWS_ENV = BILLING_FORBIDDEN_AWS_ENV_NAMES;

export type BillingAwsHelperInvocationV2 = Readonly<{
  file: typeof BILLING_AWS_SIGNING_HELPER_PATH;
  args: readonly string[];
  cwd: "/app";
  uid: 10_001;
  gid: 10_001;
  env: Readonly<{ PATH: "/usr/local/bin:/usr/bin:/bin"; HOME: "/nonexistent"; LANG: "C"; LC_ALL: "C" }>;
  timeoutMs: 5_000;
  maxStdoutBytes: 65_536;
  maxStderrBytes: 65_536;
  stdin: "eof-via-dev-null";
}>;

export type BoundedBillingAwsChildInvocationV1 = Readonly<{
  file: string;
  args: readonly string[];
  cwd: string;
  uid?: number;
  gid?: number;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdin: "eof-via-dev-null";
}>;

export type BillingAwsCredentialProviderV2 = Readonly<{
  credentials: AwsCredentialIdentityProvider;
  close(): Promise<void>;
}>;

export type BillingAwsCredentialDependencies = Readonly<{
  nowMs(): number;
  readFile(path: string): Promise<Buffer>;
  lstat(path: string): Promise<Readonly<{ isFile(): boolean; isSymbolicLink(): boolean;
    uid: number; mode: number; size: number }>>;
  fetchEcsCredential(path: string): Promise<Buffer>;
  runHelper(input: BillingAwsHelperInvocationV2): Promise<Readonly<{ stdout: Buffer; stderr: Buffer }>>;
}>;

export type BillingAwsIdentityV2 = Readonly<{
  region: string;
  accountId: string;
  runtimeRoleArn: string;
  credential: BillingAwsCredentialV2;
}>;

function refuse(): never {
  throw new Error("BILLING_AWS_CREDENTIAL_INVALID");
}

function present(environment: NodeJS.ProcessEnv, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(environment, name);
}

function rejectNames(environment: NodeJS.ProcessEnv, names: readonly string[]): void {
  if (names.some((name) => present(environment, name))) refuse();
}

function printable(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    /^[\x20-\x7e]+$/u.test(value) && value.trim() === value;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(row);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) refuse();
}

function validateAwsIdentity(aws: BillingAwsIdentityV2): void {
  if (Object.keys(aws).join("|") !== "region|accountId|runtimeRoleArn|credential" ||
      !/^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/u.test(aws.region) || aws.region.length > 64 ||
      !/^[0-9]{12}$/u.test(aws.accountId)) refuse();
  const rolePrefix = `arn:aws:iam::${aws.accountId}:role/`;
  if (!aws.runtimeRoleArn.startsWith(rolePrefix) || aws.runtimeRoleArn.length === rolePrefix.length ||
      aws.runtimeRoleArn.endsWith("/")) refuse();
  const credential = aws.credential;
  if (credential.kind === "ecs-task-role-v1") {
    if (Object.keys(credential).join("|") !== "kind") refuse();
    return;
  }
  if (Object.keys(credential).join("|") !==
      "kind|trustAnchorArn|profileArn|certificateSha256|certificateSubjectCn|certificateIssuerCn|helperVersion|helperBytes|helperSha256") refuse();
  const trustPrefix = `arn:aws:rolesanywhere:${aws.region}:${aws.accountId}:trust-anchor/`;
  const profilePrefix = `arn:aws:rolesanywhere:${aws.region}:${aws.accountId}:profile/`;
  const resource = (value: string, prefix: string): boolean => value.startsWith(prefix) &&
    /^[A-Za-z0-9-]{1,64}$/u.test(value.slice(prefix.length));
  if (!resource(credential.trustAnchorArn, trustPrefix) || !resource(credential.profileArn, profilePrefix) ||
      !/^[0-9a-f]{64}$/u.test(credential.certificateSha256) ||
      !printable(credential.certificateSubjectCn, 1, 61) || !printable(credential.certificateIssuerCn, 1, 61) ||
      credential.certificateSubjectCn.includes("*") || credential.certificateIssuerCn.includes("*") ||
      credential.certificateSubjectCn === credential.certificateIssuerCn || credential.helperVersion !== "1.8.4" ||
      credential.helperBytes !== "12094568" || credential.helperSha256 !== BILLING_AWS_SIGNING_HELPER_SHA256) refuse();
}

function exactRelativeCredentialPath(environment: NodeJS.ProcessEnv): string {
  rejectNames(environment, [...FORBIDDEN_AWS_ENV, ...RAW_RAILWAY_NAMES, ...RA_PATH_NAMES]);
  const path = environment["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
  if (typeof path !== "string" || path.length < 1 || path.length > 1_024 || !path.startsWith("/") ||
      path.includes("\\") || path.includes("?") || path.includes("#") || path.includes(":") ||
      /%2e|%2f|%5c/iu.test(path) || path.split("/").some((part) => part === "." || part === "..") ||
      !/^\/[A-Za-z0-9._~!$&'()*+,;=@%/-]+$/u.test(path)) refuse();
  return path;
}

/** Pre-work gate for the separately bundled non-Railway ECS composition. */
export function assertNonRailwayEcsBillingAwsCompositionV1(input: Readonly<{
  aws: BillingAwsIdentityV2;
  environment: NodeJS.ProcessEnv;
}>): void {
  validateAwsIdentity(input.aws);
  if (input.aws.credential.kind !== "ecs-task-role-v1") refuse();
  exactRelativeCredentialPath(input.environment);
}

function parseRfc3339Utc(value: unknown): Date {
  if (typeof value !== "string") refuse();
  const match = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.[0-9]{1,9})?Z$/u.exec(value);
  if (match === null) refuse();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== Number(match[1]) ||
      date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3]) ||
      date.getUTCHours() !== Number(match[4]) || date.getUTCMinutes() !== Number(match[5]) ||
      date.getUTCSeconds() !== Number(match[6])) refuse();
  return date;
}

function credentialIdentity(row: Record<string, unknown>, tokenMember: "Token" | "SessionToken",
  nowMs: number, maxLifetimeMs?: number): AwsCredentialIdentity {
  const token = row[tokenMember];
  if (!printable(row["AccessKeyId"], 16, 256) || !printable(row["SecretAccessKey"], 16, 512) ||
      !printable(token, 16, 8_192)) refuse();
  const expiration = parseRfc3339Utc(row["Expiration"]);
  const remaining = expiration.getTime() - nowMs;
  if (remaining <= REFRESH_EARLY_MS || (maxLifetimeMs !== undefined && remaining > maxLifetimeMs)) refuse();
  return Object.freeze({ accessKeyId: row["AccessKeyId"], secretAccessKey: row["SecretAccessKey"],
    sessionToken: token, expiration });
}

function parseEcsCredential(bytes: Buffer, nowMs: number): AwsCredentialIdentity {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ECS_BYTES) refuse();
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { refuse(); }
  const row = object(decoded);
  return credentialIdentity(row, "Token", nowMs);
}

export function parseAwsSigningHelperCredentialV2(bytes: Uint8Array, nowMs: number): AwsCredentialIdentity {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_HELPER_OUTPUT_BYTES) refuse();
  let text: string;
  let decoded: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    decoded = JSON.parse(text) as unknown;
  } catch { refuse(); }
  const row = object(decoded);
  exactKeys(row, ["Version", "AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration"]);
  if (row["Version"] !== 1 || JSON.stringify(row) !== text) refuse();
  return credentialIdentity(row, "SessionToken", nowMs, MAX_HELPER_LIFETIME_MS);
}

type DerNode = Readonly<{ tag: number; start: number; contentStart: number; end: number }>;

function derNode(bytes: Buffer, offset: number): DerNode {
  if (offset < 0 || offset + 2 > bytes.byteLength) refuse();
  const tag = bytes[offset] ?? -1;
  const first = bytes[offset + 1] ?? -1;
  let length = first;
  let contentStart = offset + 2;
  if ((first & 0x80) !== 0) {
    const count = first & 0x7f;
    if (count < 1 || count > 4 || contentStart + count > bytes.byteLength || bytes[contentStart] === 0) refuse();
    length = 0;
    for (let index = 0; index < count; index += 1) length = (length * 256) + (bytes[contentStart + index] ?? 0);
    if (length < 128) refuse();
    contentStart += count;
  }
  const end = contentStart + length;
  if (end > bytes.byteLength) refuse();
  return { tag, start: offset, contentStart, end };
}

function derChildren(bytes: Buffer, parent: DerNode): readonly DerNode[] {
  const children: DerNode[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = derNode(bytes, offset);
    children.push(child);
    offset = child.end;
  }
  if (offset !== parent.end) refuse();
  return children;
}

function derSlice(bytes: Buffer, node: DerNode): Buffer {
  return bytes.subarray(node.start, node.end);
}

function assertCertificateExtensions(bytes: Buffer, tbs: readonly DerNode[]): void {
  const extensionWrappers = tbs.filter((node) => node.tag === 0xa3);
  if (extensionWrappers.length !== 1) refuse();
  const wrapperChildren = derChildren(bytes, extensionWrappers[0] ?? refuse());
  if (wrapperChildren.length !== 1 || wrapperChildren[0]?.tag !== 0x30) refuse();
  const extensions = derChildren(bytes, wrapperChildren[0]);
  let basicConstraints = 0;
  let keyUsage = 0;
  for (const extension of extensions) {
    if (extension.tag !== 0x30) refuse();
    const members = derChildren(bytes, extension);
    if (members.length < 2 || members.length > 3 || members[0]?.tag !== 0x06 ||
        members[members.length - 1]?.tag !== 0x04) refuse();
    if (members.length === 3) {
      const critical = members[1];
      if (critical?.tag !== 0x01 || !derSlice(bytes, critical).equals(Buffer.from("0101ff", "hex"))) refuse();
    }
    const oid = derSlice(bytes, members[0]);
    const valueNode = members[members.length - 1] ?? refuse();
    const value = bytes.subarray(valueNode.contentStart, valueNode.end);
    if (oid.equals(BASIC_CONSTRAINTS_OID)) {
      basicConstraints += 1;
      if (!value.equals(Buffer.from("3000", "hex"))) refuse();
    } else if (oid.equals(KEY_USAGE_OID)) {
      keyUsage += 1;
      const bitString = derNode(value, 0);
      if (bitString.tag !== 0x03 || bitString.end !== value.byteLength ||
          bitString.contentStart >= bitString.end) refuse();
      const unused = value[bitString.contentStart] ?? 8;
      const usageBytes = value.subarray(bitString.contentStart + 1, bitString.end);
      if (unused > 7 || usageBytes.byteLength < 1) refuse();
      const first = usageBytes[0] ?? 0;
      if ((first & 0x80) === 0 || (first & 0x06) !== 0) refuse();
    }
  }
  if (basicConstraints !== 1 || keyUsage !== 1) refuse();
}

function assertCertificateDer(cert: X509Certificate): void {
  const bytes = Buffer.from(cert.raw);
  const outer = derNode(bytes, 0);
  if (outer.tag !== 0x30 || outer.end !== bytes.byteLength) refuse();
  const certificate = derChildren(bytes, outer);
  if (certificate.length !== 3 || certificate[0]?.tag !== 0x30 || certificate[1]?.tag !== 0x30) refuse();
  const tbs = derChildren(bytes, certificate[0]);
  if (tbs.length < 7 || tbs[0]?.tag !== 0xa0 || tbs[2]?.tag !== 0x30 || tbs[6]?.tag !== 0x30) refuse();
  const version = derChildren(bytes, tbs[0]);
  const versionNode = version[0];
  if (version.length !== 1 || versionNode === undefined ||
      !derSlice(bytes, versionNode).equals(Buffer.from("020102", "hex"))) refuse();
  if (!derSlice(bytes, tbs[2]).equals(ECDSA_SHA256_ALGORITHM) ||
      !derSlice(bytes, certificate[1]).equals(ECDSA_SHA256_ALGORITHM)) refuse();
  const spki = derChildren(bytes, tbs[6]);
  const spkiAlgorithm = spki[0];
  if (spki.length !== 2 || spkiAlgorithm === undefined ||
      !derSlice(bytes, spkiAlgorithm).equals(P256_SPKI_ALGORITHM)) refuse();
  assertCertificateExtensions(bytes, tbs);
}

export function parseCanonicalBillingPemV1(bytes: Uint8Array,
  label: "CERTIFICATE" | "PRIVATE KEY"): string {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_PEM_BYTES || buffer.includes(0)) refuse();
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { refuse(); }
  const expression = new RegExp(`^-----BEGIN ${label}-----\\n([A-Za-z0-9+/=\\n]+)\\n-----END ${label}-----\\n?$`, "u");
  const match = expression.exec(value);
  if (match === null || (value.match(/-----BEGIN /gu)?.length ?? 0) !== 1) refuse();
  const lines = (match[1] ?? "").split("\n");
  if (lines.length < 1 || lines.some((line) => line.length < 1 || line.length > 64) ||
      lines.slice(0, -1).some((line) => line.length !== 64 || !/^[A-Za-z0-9+/]{64}$/u.test(line))) refuse();
  const last = lines[lines.length - 1] ?? "";
  if (last.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(last) || /=[A-Za-z0-9+/]/u.test(last)) refuse();
  const canonicalBase64 = lines.join("");
  const derBytes = Buffer.from(canonicalBase64, "base64");
  if (derBytes.byteLength < 1 || derBytes.toString("base64") !== canonicalBase64) refuse();
  return value;
}

function distinguishedNameCn(value: string): string {
  const matches = value.split(/\n/u).filter((member) => member.startsWith("CN="));
  if (matches.length !== 1) refuse();
  return matches[0]?.slice(3) ?? refuse();
}

async function validateCertificate(aws: BillingAwsIdentityV2, dependencies: BillingAwsCredentialDependencies,
  nowMs: number): Promise<void> {
  if (aws.credential.kind !== "roles-anywhere-x509-v1") refuse();
  const [certificateStat, privateKeyStat, certificateBytes, privateKeyBytes] = await Promise.all([
    dependencies.lstat(BILLING_AWS_RA_CERTIFICATE_PATH),
    dependencies.lstat(BILLING_AWS_RA_PRIVATE_KEY_PATH),
    dependencies.readFile(BILLING_AWS_RA_CERTIFICATE_PATH),
    dependencies.readFile(BILLING_AWS_RA_PRIVATE_KEY_PATH),
  ]).catch(() => refuse());
  for (const stat of [certificateStat, privateKeyStat]) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 10_001 ||
        (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > MAX_PEM_BYTES) refuse();
  }
  if (certificateBytes.byteLength !== certificateStat.size || privateKeyBytes.byteLength !== privateKeyStat.size) refuse();
  const certificatePem = parseCanonicalBillingPemV1(certificateBytes, "CERTIFICATE");
  const privateKeyPem = parseCanonicalBillingPemV1(privateKeyBytes, "PRIVATE KEY");
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(certificatePem); }
  catch { refuse(); }
  assertCertificateDer(certificate);
  if (certificate.ca || distinguishedNameCn(certificate.subject) !== aws.credential.certificateSubjectCn ||
      distinguishedNameCn(certificate.issuer) !== aws.credential.certificateIssuerCn ||
      createHash("sha256").update(certificate.raw).digest("hex") !== aws.credential.certificateSha256) refuse();
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore > nowMs ||
      notAfter - nowMs < MIN_CERTIFICATE_REMAINING_MS || notAfter - notBefore > MAX_CERTIFICATE_LIFETIME_MS) refuse();
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
        !certificate.checkPrivateKey(privateKey) ||
        !Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }))
          .equals(Buffer.from(certificate.publicKey.export({ format: "der", type: "spki" })))) refuse();
  } catch { refuse(); }
}

async function verifyHelper(dependencies: BillingAwsCredentialDependencies): Promise<void> {
  const stat = await dependencies.lstat(BILLING_AWS_SIGNING_HELPER_PATH).catch(() => refuse());
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o7777) !== 0o555 ||
      stat.size !== BILLING_AWS_SIGNING_HELPER_BYTES) refuse();
  const bytes = await dependencies.readFile(BILLING_AWS_SIGNING_HELPER_PATH).catch(() => refuse());
  if (bytes.byteLength !== BILLING_AWS_SIGNING_HELPER_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== BILLING_AWS_SIGNING_HELPER_SHA256) refuse();
}

function rolesAnywhereEnvironment(environment: NodeJS.ProcessEnv): void {
  rejectNames(environment, [...FORBIDDEN_AWS_ENV, ...RAW_RAILWAY_NAMES, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"]);
  const expected: Readonly<Record<string, string>> = {
    BILLING_PRODUCTION_MANIFEST_PATH: "/run/4lpha/manifest.json",
    BILLING_PRODUCTION_BUNDLE_PATH: "/app/artifacts/billing-adapter.mjs",
    BILLING_AWS_RA_CERTIFICATE_PATH,
    BILLING_AWS_RA_PRIVATE_KEY_PATH,
    BILLING_RAILWAY_CLEAN_EXEC: "1",
  };
  if (Object.entries(expected).some(([name, value]) => environment[name] !== value)) refuse();
}

function helperArgs(aws: BillingAwsIdentityV2): readonly string[] {
  if (aws.credential.kind !== "roles-anywhere-x509-v1") refuse();
  return ["credential-process", "--certificate", BILLING_AWS_RA_CERTIFICATE_PATH,
    "--private-key", BILLING_AWS_RA_PRIVATE_KEY_PATH, "--trust-anchor-arn",
    aws.credential.trustAnchorArn, "--profile-arn", aws.credential.profileArn,
    "--role-arn", aws.runtimeRoleArn, "--session-duration", "900", "--region", aws.region];
}

export function billingAwsRolesAnywhereHelperInvocationV2(
  aws: BillingAwsIdentityV2,
): BillingAwsHelperInvocationV2 {
  validateAwsIdentity(aws);
  if (aws.credential.kind !== "roles-anywhere-x509-v1") refuse();
  return Object.freeze({ file: BILLING_AWS_SIGNING_HELPER_PATH, args: Object.freeze([...helperArgs(aws)]),
    cwd: "/app", uid: 10_001, gid: 10_001,
    env: Object.freeze({ PATH: "/usr/local/bin:/usr/bin:/bin" as const, HOME: "/nonexistent" as const,
      LANG: "C" as const, LC_ALL: "C" as const }), timeoutMs: HELPER_TIMEOUT_MS,
    maxStdoutBytes: MAX_HELPER_OUTPUT_BYTES, maxStderrBytes: MAX_HELPER_OUTPUT_BYTES,
    stdin: "eof-via-dev-null" });
}

export async function runAndParseBillingAwsSigningHelperV2(input: Readonly<{
  invocation: BillingAwsHelperInvocationV2;
  runHelper(invocation: BillingAwsHelperInvocationV2): Promise<Readonly<{ stdout: Buffer; stderr: Buffer }>>;
  nowMs(): number;
}>): Promise<AwsCredentialIdentity> {
  const result = await input.runHelper(input.invocation).catch(() => refuse());
  if (result.stderr.byteLength > MAX_HELPER_OUTPUT_BYTES) refuse();
  // This is intentionally after the awaited child completion, never the cache/certificate clock.
  return parseAwsSigningHelperCredentialV2(result.stdout, input.nowMs());
}

function fetchEcs(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: ECS_HOST, port: 80, method: "GET", path,
      headers: { Accept: "application/json" }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > MAX_ECS_BYTES) response.destroy(new Error("oversized"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => response.statusCode === 200
        ? resolve(Buffer.concat(chunks)) : reject(new Error("status")));
    });
    request.setTimeout(1_000, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}

export function runBoundedBillingAwsChildV1(
  input: BoundedBillingAwsChildInvocationV1,
): Promise<Readonly<{ stdout: Buffer; stderr: Buffer }>> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(input.file, [...input.args], { cwd: input.cwd, env: { ...input.env },
        ...(input.uid === undefined ? {} : { uid: input.uid }),
        ...(input.gid === undefined ? {} : { gid: input.gid }),
        // Node maps "ignore" to the null device: fd 0 is readable only as immediate EOF.
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch { reject(new Error("spawn")); return; }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let failed = false;
    const stop = (): void => { if (!failed) { failed = true; child.kill("SIGKILL"); } };
    const timer = setTimeout(stop, input.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.byteLength;
      if (stdoutLength > input.maxStdoutBytes) stop(); else stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrLength += chunk.byteLength;
      if (stderrLength > input.maxStderrBytes) stop(); else stderr.push(chunk);
    });
    child.on("error", () => stop());
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error("helper"));
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

const REAL_DEPENDENCIES: BillingAwsCredentialDependencies = {
  nowMs: Date.now,
  readFile,
  lstat,
  fetchEcsCredential: fetchEcs,
  runHelper: runBoundedBillingAwsChildV1,
};

/** One closed credential source shared by the full adapter and identity-only reader. */
export async function createBillingAwsCredentialProviderV2(input: Readonly<{
  aws: BillingAwsIdentityV2;
  environment: NodeJS.ProcessEnv;
  dependencies?: BillingAwsCredentialDependencies;
}>): Promise<BillingAwsCredentialProviderV2> {
  const dependencies = process.env.BILLING_ADAPTER_BUILD_TARGET === "production"
    ? REAL_DEPENDENCIES
    : input.dependencies ?? REAL_DEPENDENCIES;
  validateAwsIdentity(input.aws);
  let closed = false;
  let cached: AwsCredentialIdentity | undefined;
  let refreshing: Promise<AwsCredentialIdentity> | undefined;
  let ecsPath: string | undefined;
  if (input.aws.credential.kind === "ecs-task-role-v1") {
    ecsPath = exactRelativeCredentialPath(input.environment);
  } else {
    rolesAnywhereEnvironment(input.environment);
    await validateCertificate(input.aws, dependencies, dependencies.nowMs());
  }
  const refresh = async (): Promise<AwsCredentialIdentity> => {
    if (closed) refuse();
    if (input.aws.credential.kind === "ecs-task-role-v1") {
      const bytes = await dependencies.fetchEcsCredential(ecsPath ?? refuse()).catch(() => refuse());
      return parseEcsCredential(bytes, dependencies.nowMs());
    }
    await validateCertificate(input.aws, dependencies, dependencies.nowMs());
    await verifyHelper(dependencies);
    return runAndParseBillingAwsSigningHelperV2({
      invocation: billingAwsRolesAnywhereHelperInvocationV2(input.aws),
      runHelper: dependencies.runHelper,
      nowMs: dependencies.nowMs,
    });
  };
  const credentials: AwsCredentialIdentityProvider = async () => {
    if (closed) refuse();
    const nowMs = dependencies.nowMs();
    if (cached?.expiration !== undefined && cached.expiration.getTime() - nowMs > REFRESH_EARLY_MS) return cached;
    refreshing ??= refresh().then((value) => { cached = value; return value; })
      .finally(() => { refreshing = undefined; });
    return refreshing;
  };
  return Object.freeze({ credentials, async close() { closed = true; cached = undefined; refreshing = undefined; } });
}
