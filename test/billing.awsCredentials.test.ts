import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { billingAwsRolesAnywhereHelperInvocationV2, createBillingAwsCredentialProviderV2,
  parseAwsSigningHelperCredentialV2, parseCanonicalBillingPemV1,
  runAndParseBillingAwsSigningHelperV2, runBoundedBillingAwsChildV1,
  type BillingAwsCredentialDependencies } from "../src/billing/awsBillingCredentials.js";

const AWS = Object.freeze({
  region: "us-east-1",
  accountId: "123456789012",
  runtimeRoleArn: "arn:aws:iam::123456789012:role/4lpha-billing",
  credential: Object.freeze({ kind: "ecs-task-role-v1" as const }),
});

const ROLES_ANYWHERE_AWS = Object.freeze({ ...AWS,
  credential: Object.freeze({ kind: "roles-anywhere-x509-v1" as const,
    trustAnchorArn: "arn:aws:rolesanywhere:us-east-1:123456789012:trust-anchor/anchor-1",
    profileArn: "arn:aws:rolesanywhere:us-east-1:123456789012:profile/profile-1",
    certificateSha256: "d".repeat(64), certificateSubjectCn: "railway-billing",
    certificateIssuerCn: "4lpha-ca", helperVersion: "1.8.4" as const,
    helperBytes: "12094568" as const,
    helperSha256: "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9" as const }),
});

const ECDSA_SHA256 = Buffer.from("300a06082a8648ce3d040302", "hex");

function canonicalPem(derBytes: Buffer, label: "CERTIFICATE" | "PRIVATE KEY"): Buffer {
  const body = derBytes.toString("base64").match(/.{1,64}/gu)?.join("\n") ?? "";
  return Buffer.from(`-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`);
}

function derLength(length: number): Buffer {
  if (length < 128) return Buffer.from([length]);
  const octets: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) octets.unshift(value & 0xff);
  return Buffer.from([0x80 | octets.length, ...octets]);
}

function der(tag: number, ...parts: readonly Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(content.byteLength), content]);
}

function certificateFixture(signatureAlgorithm = ECDSA_SHA256): Readonly<{
  certificate: Buffer; privateKey: Buffer; sha256: string;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = (commonName: string): Buffer => der(0x30, der(0x31, der(0x30,
    Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from(commonName, "utf8")))));
  const extensions = der(0xa3, der(0x30,
    der(0x30, Buffer.from("0603551d13", "hex"), Buffer.from("0101ff", "hex"),
      der(0x04, Buffer.from("3000", "hex"))),
    der(0x30, Buffer.from("0603551d0f", "hex"), Buffer.from("0101ff", "hex"),
      der(0x04, Buffer.from("03020780", "hex")))));
  const tbs = der(0x30,
    der(0xa0, Buffer.from("020102", "hex")), Buffer.from("020101", "hex"), signatureAlgorithm,
    name("4lpha-ca"), der(0x30, der(0x17, Buffer.from("300101000000Z", "ascii")),
      der(0x17, Buffer.from("300102000000Z", "ascii"))), name("railway-billing"),
    Buffer.from(publicKey.export({ format: "der", type: "spki" })), extensions);
  const signature = sign("sha256", tbs, privateKey);
  const raw = der(0x30, tbs, signatureAlgorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = raw.toString("base64").match(/.{1,64}/gu)?.join("\n") ?? "";
  const certificate = Buffer.from(`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`);
  const privateKeyPem = Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }));
  return Object.freeze({ certificate, privateKey: privateKeyPem,
    sha256: createHash("sha256").update(raw).digest("hex") });
}

function rolesAnywhereDependencies(fixture: ReturnType<typeof certificateFixture>, nowMs: number):
BillingAwsCredentialDependencies {
  return {
    nowMs() { return nowMs; },
    async readFile(path) {
      if (path.endsWith("certificate.pem")) return fixture.certificate;
      if (path.endsWith("private-key.pem")) return fixture.privateKey;
      throw new Error("unreachable");
    },
    async lstat(path) {
      const bytes = path.endsWith("certificate.pem") ? fixture.certificate : fixture.privateKey;
      return { isFile: () => true, isSymbolicLink: () => false, uid: 10_001, mode: 0o600,
        size: bytes.byteLength };
    },
    async fetchEcsCredential() { throw new Error("unreachable"); },
    async runHelper() { throw new Error("unreachable"); },
  };
}

function dependencies(state: { nowMs: number; fetches: number }): BillingAwsCredentialDependencies {
  return {
    nowMs() { return state.nowMs; },
    async readFile() { throw new Error("unreachable"); },
    async lstat() { throw new Error("unreachable"); },
    async fetchEcsCredential(path) {
      state.fetches += 1;
      assert.equal(path, "/v2/credentials/task-1");
      await Promise.resolve();
      return Buffer.from(JSON.stringify({ AccessKeyId: "ASIAABCDEFGHIJKLMNOP",
        SecretAccessKey: "reviewed-placeholder-secret", Token: "reviewed-placeholder-session-token",
        Expiration: new Date(state.nowMs + 300_000).toISOString().replace(".000Z", "Z") }));
    },
    async runHelper() { throw new Error("unreachable"); },
  };
}

test("shared ECS credential provider is one-flight, early-refreshing and closable", async () => {
  const state = { nowMs: Date.parse("2030-01-02T03:04:05Z"), fetches: 0 };
  const provider = await createBillingAwsCredentialProviderV2({ aws: AWS,
    environment: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1" },
    dependencies: dependencies(state) });
  const first = await Promise.all([provider.credentials(), provider.credentials(), provider.credentials()]);
  assert.equal(state.fetches, 1);
  assert.strictEqual(first[0], first[1]);
  state.nowMs += 179_999;
  assert.strictEqual(await provider.credentials(), first[0]);
  state.nowMs += 1;
  await provider.credentials();
  assert.equal(state.fetches, 2);
  await provider.close();
  await assert.rejects(provider.credentials(), /BILLING_AWS_CREDENTIAL_INVALID/);
});

test("canonical PEM accepts DER length modulo three 0, 1 and 2 with only terminal padding", () => {
  for (const label of ["CERTIFICATE", "PRIVATE KEY"] as const) {
    for (const length of [3, 4, 5]) {
      const derBytes = Buffer.alloc(length, 0xa5);
      const pem = canonicalPem(derBytes, label);
      assert.equal(parseCanonicalBillingPemV1(pem, label), pem.toString("utf8"));
    }
  }
  const padded = canonicalPem(Buffer.alloc(4, 0xa5), "CERTIFICATE").toString("utf8");
  assert.throws(() => parseCanonicalBillingPemV1(Buffer.from(padded.replace("paWl", "pa==")),
    "CERTIFICATE"), /BILLING_AWS_CREDENTIAL_INVALID/);
  const nonCanonicalBits = Buffer.from("-----BEGIN CERTIFICATE-----\nZh==\n-----END CERTIFICATE-----\n");
  assert.throws(() => parseCanonicalBillingPemV1(nonCanonicalBits, "CERTIFICATE"),
    /BILLING_AWS_CREDENTIAL_INVALID/);
});

test("shared provider rejects alternate AWS sources and Roles Anywhere path crossover", async () => {
  const state = { nowMs: Date.parse("2030-01-02T03:04:05Z"), fetches: 0 };
  for (const environment of [
    { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1", AWS_ACCESS_KEY_ID: "present" },
    { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1",
      BILLING_AWS_RA_CERTIFICATE_PATH: "/run/4lpha/roles-anywhere/certificate.pem" },
    { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/../metadata" },
    { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1", AWS_ENDPOINT_URL_STS: "" },
    { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1", AWS_ENDPOINT_URL_KMS: "" },
    { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1",
      AWS_ENDPOINT_URL_SECRETS_MANAGER: "" },
  ]) {
    await assert.rejects(createBillingAwsCredentialProviderV2({ aws: AWS, environment,
      dependencies: dependencies(state) }), /BILLING_AWS_CREDENTIAL_INVALID/);
  }
  assert.equal(state.fetches, 0);
});

test("Roles Anywhere helper argv and stdout bytes match the pinned provenance", async () => {
  const fixtureBytes = await readFile(new URL("./fixtures/billing/awsRolesAnywhereHelper184.provenance.json",
    import.meta.url));
  assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"),
    "96620b756cf6f6c28dacb7f5f8d3be3b2e00de021b80b9673d199ae53fe51d4e");
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Readonly<{
    schema: string;
    capturedAt: string;
    upstream: Readonly<{ repository: string; tag: string; commit: string }>;
    linuxAmd64Artifact: Readonly<{ url: string; bytes: number; sha256: string; magicHex: string }>;
    publishedSource: readonly Readonly<{ path: string; bytes: number; sha256: string }>[];
    credentialProcess: Readonly<{
    use: string;
    declaredFlagsInSourceOrder: readonly string[];
    acceptedArgvTemplate: readonly string[];
    stdoutConstruction: string;
    memberOrder: readonly string[];
    terminalBytes: string;
    redactedStdout: Readonly<{ encoding: string; bytes: number; base64: string; usableCredential: boolean }>;
  }> }>;
  assert.deepEqual(Object.keys(fixture),
    ["schema", "capturedAt", "upstream", "linuxAmd64Artifact", "publishedSource", "credentialProcess"]);
  assert.equal(fixture.schema, "4lpha.aws-roles-anywhere-helper-provenance.v1");
  assert.equal(fixture.capturedAt, "2026-08-28");
  assert.deepEqual(Object.keys(fixture.upstream), ["repository", "tag", "commit"]);
  assert.deepEqual(fixture.upstream,
    { repository: "https://github.com/aws/rolesanywhere-credential-helper", tag: "v1.8.4",
      commit: "98b276b61378af7d233b077f0fe5d44e85253ece" });
  assert.deepEqual(fixture.linuxAmd64Artifact, {
    url: "https://rolesanywhere.amazonaws.com/releases/1.8.4/X86_64/Linux/Amzn2023/aws_signing_helper",
    bytes: 12_094_568,
    sha256: "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9",
    magicHex: "7f454c46",
  });
  assert.deepEqual(Object.keys(fixture.credentialProcess), ["use", "declaredFlagsInSourceOrder",
    "acceptedArgvTemplate", "stdoutConstruction", "memberOrder", "terminalBytes", "redactedStdout"]);
  assert.deepEqual(fixture.publishedSource, [
    { path: "cmd/credential_process.go", bytes: 1289,
      sha256: "448ef3a1d511121d5fed7aee570c7bc14e61739274d5d0914298ca89cead7d7d" },
    { path: "cmd/credentials.go", bytes: 11942,
      sha256: "e98167fc9b1d87d781c128e631b11735c4d820180704666135f60736a73eb7f7" },
    { path: "aws_signing_helper/credentials.go", bytes: 6196,
      sha256: "5f476fa2fc1e1270282518e98d8655407823efdebfdd9377319384a34956017a" },
    { path: "aws_signing_helper/signer.go", bytes: 30231,
      sha256: "c3e4e71b7bfe396eb4c5b8054f7f4288912788aa99b206c2abc663116433e8d8" },
  ]);
  assert.deepEqual(fixture.credentialProcess.declaredFlagsInSourceOrder, [
    "role-arn", "profile-arn", "trust-anchor-arn", "session-duration", "region", "endpoint",
    "no-verify-ssl", "with-proxy", "debug", "certificate", "private-key", "intermediates",
    "cert-selector", "system-store-name", "use-latest-expiring-certificate", "pkcs11-lib",
    "reuse-pin", "tpm-key-password", "no-tpm-key-password", "role-session-name", "pkcs8-password",
  ]);
  assert.equal(fixture.credentialProcess.declaredFlagsInSourceOrder.length, 21);
  assert.equal(fixture.credentialProcess.use, "credential-process [flags]");
  assert.equal(fixture.credentialProcess.stdoutConstruction,
    "encoding/json.Marshal(CredentialProcessOutput) followed by fmt.Print(string(buf))");
  assert.deepEqual(fixture.credentialProcess.memberOrder,
    ["Version", "AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration"]);
  assert.equal(fixture.credentialProcess.terminalBytes, "none");
  assert.equal(fixture.credentialProcess.redactedStdout.usableCredential, false);
  assert.equal(fixture.credentialProcess.redactedStdout.encoding, "base64-of-exact-utf8-bytes");
  const invocation = billingAwsRolesAnywhereHelperInvocationV2(ROLES_ANYWHERE_AWS);
  assert.equal(invocation.file, "/usr/local/bin/aws_signing_helper");
  assert.equal(invocation.cwd, "/app");
  assert.equal(invocation.uid, 10_001);
  assert.equal(invocation.gid, 10_001);
  assert.equal(invocation.timeoutMs, 5_000);
  assert.equal(invocation.maxStdoutBytes, 65_536);
  assert.equal(invocation.maxStderrBytes, 65_536);
  assert.equal(invocation.stdin, "eof-via-dev-null");
  assert.deepEqual(invocation.args, fixture.credentialProcess.acceptedArgvTemplate.map((value) =>
    value === "<manifest.trustAnchorArn>" ? ROLES_ANYWHERE_AWS.credential.trustAnchorArn :
      value === "<manifest.profileArn>" ? ROLES_ANYWHERE_AWS.credential.profileArn :
        value === "<manifest.runtimeRoleArn>" ? ROLES_ANYWHERE_AWS.runtimeRoleArn :
          value === "<manifest.region>" ? ROLES_ANYWHERE_AWS.region : value));
  assert.deepEqual(invocation.env,
    { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C" });
  const bytes = Buffer.from(fixture.credentialProcess.redactedStdout.base64, "base64");
  assert.equal(bytes.byteLength, fixture.credentialProcess.redactedStdout.bytes);
  const parsed = parseAwsSigningHelperCredentialV2(bytes, Date.parse("2030-01-02T03:00:05Z"));
  assert.equal(parsed.expiration?.toISOString(), "2030-01-02T03:04:05.000Z");
  assert.doesNotThrow(() => parseAwsSigningHelperCredentialV2(bytes,
    Date.parse("2030-01-02T03:02:04.999Z")));
  assert.throws(() => parseAwsSigningHelperCredentialV2(bytes,
    Date.parse("2030-01-02T03:02:05Z")), /BILLING_AWS_CREDENTIAL_INVALID/);
  assert.doesNotThrow(() => parseAwsSigningHelperCredentialV2(bytes,
    Date.parse("2030-01-02T02:49:05Z")));
  assert.throws(() => parseAwsSigningHelperCredentialV2(bytes,
    Date.parse("2030-01-02T02:49:04.999Z")), /BILLING_AWS_CREDENTIAL_INVALID/);
  assert.throws(() => parseAwsSigningHelperCredentialV2(Buffer.concat([bytes, Buffer.from("\n")]),
    Date.parse("2030-01-02T03:00:05Z")), /BILLING_AWS_CREDENTIAL_INVALID/);
  const reordered = JSON.stringify({ AccessKeyId: parsed.accessKeyId, Version: 1,
    SecretAccessKey: parsed.secretAccessKey, SessionToken: parsed.sessionToken,
    Expiration: "2030-01-02T03:04:05Z" });
  assert.throws(() => parseAwsSigningHelperCredentialV2(Buffer.from(reordered),
    Date.parse("2030-01-02T03:00:05Z")), /BILLING_AWS_CREDENTIAL_INVALID/);
});

test("Roles Anywhere accepts only the reviewed X.509 ECDSA-SHA256 algorithm encoding", async () => {
  const nowMs = Date.parse("2030-01-01T12:00:00Z");
  const environment = {
    BILLING_PRODUCTION_MANIFEST_PATH: "/run/4lpha/manifest.json",
    BILLING_PRODUCTION_BUNDLE_PATH: "/app/artifacts/billing-adapter.mjs",
    BILLING_AWS_RA_CERTIFICATE_PATH: "/run/4lpha/roles-anywhere/certificate.pem",
    BILLING_AWS_RA_PRIVATE_KEY_PATH: "/run/4lpha/roles-anywhere/private-key.pem",
    BILLING_RAILWAY_CLEAN_EXEC: "1",
  };
  const accepted = certificateFixture();
  const aws = { ...ROLES_ANYWHERE_AWS, credential: { ...ROLES_ANYWHERE_AWS.credential,
    certificateSha256: accepted.sha256 } };
  const provider = await createBillingAwsCredentialProviderV2({ aws, environment,
    dependencies: rolesAnywhereDependencies(accepted, nowMs) });
  await provider.close();

  for (const rejectedAlgorithm of [
    Buffer.from("300a06082a8648ce3d040303", "hex"),
    Buffer.from("300c06082a8648ce3d0403020500", "hex"),
    Buffer.from("300d06092a864886f70d01010b0500", "hex"),
  ]) {
    const rejected = certificateFixture(rejectedAlgorithm);
    const rejectedAws = { ...ROLES_ANYWHERE_AWS, credential: { ...ROLES_ANYWHERE_AWS.credential,
      certificateSha256: rejected.sha256 } };
    await assert.rejects(createBillingAwsCredentialProviderV2({ aws: rejectedAws, environment,
      dependencies: rolesAnywhereDependencies(rejected, nowMs) }), /BILLING_AWS_CREDENTIAL_INVALID/);
  }
});

test("helper expiry admission samples its only parse clock after helper completion", async () => {
  const stdout = Buffer.from(JSON.stringify({ Version: 1, AccessKeyId: "ASIAABCDEFGHIJKLMNOP",
    SecretAccessKey: "reviewed-placeholder-secret", SessionToken: "reviewed-placeholder-session-token",
    Expiration: "2030-01-02T03:04:05Z" }));
  const invocation = billingAwsRolesAnywhereHelperInvocationV2(ROLES_ANYWHERE_AWS);
  let clock = Date.parse("2030-01-02T03:00:00Z");
  const acquire = (completionClock: number) => runAndParseBillingAwsSigningHelperV2({ invocation,
    async runHelper() { clock = completionClock; return { stdout, stderr: Buffer.alloc(0) }; },
    nowMs() { return clock; } });
  await assert.doesNotReject(acquire(Date.parse("2030-01-02T03:02:04.999Z")));
  await assert.rejects(acquire(Date.parse("2030-01-02T03:02:05Z")),
    /BILLING_AWS_CREDENTIAL_INVALID/);
  await assert.doesNotReject(acquire(Date.parse("2030-01-02T02:49:05Z")));
  await assert.rejects(acquire(Date.parse("2030-01-02T02:49:04.999Z")),
    /BILLING_AWS_CREDENTIAL_INVALID/);
});

test("bounded helper child closes stdin, caps both pipes, times out, reaps and sanitizes failures", async () => {
  const invoke = (script: string, overrides: Readonly<{
    timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number;
  }> = {}) => runBoundedBillingAwsChildV1({ file: process.execPath, args: ["-e", script],
    cwd: process.cwd(), env: {}, timeoutMs: overrides.timeoutMs ?? 1_000,
    maxStdoutBytes: overrides.maxStdoutBytes ?? 1_024,
    maxStderrBytes: overrides.maxStderrBytes ?? 1_024, stdin: "eof-via-dev-null" });

  const eof = await invoke("process.stdin.once('end',()=>process.stdout.write('eof'));process.stdin.resume()");
  assert.equal(eof.stdout.toString("utf8"), "eof");
  const ordinary = await invoke("process.stdout.write('ok');process.stderr.write('diagnostic')");
  assert.equal(ordinary.stdout.toString("utf8"), "ok");
  assert.equal(ordinary.stderr.toString("utf8"), "diagnostic");
  await assert.rejects(invoke("process.stderr.write('SENSITIVE');process.exit(9)"),
    (error: unknown) => error instanceof Error && error.message === "helper");
  await assert.rejects(invoke("process.stdout.write('x'.repeat(2048))", { maxStdoutBytes: 32 }),
    (error: unknown) => error instanceof Error && error.message === "helper");
  await assert.rejects(invoke("process.stderr.write('x'.repeat(2048))", { maxStderrBytes: 32 }),
    (error: unknown) => error instanceof Error && error.message === "helper");
  await assert.rejects(invoke("setInterval(()=>{},1000)", { timeoutMs: 30 }),
    (error: unknown) => error instanceof Error && error.message === "helper");
  await assert.rejects(runBoundedBillingAwsChildV1({ file: `${process.execPath}.missing`, args: [],
    cwd: process.cwd(), env: {}, timeoutMs: 100, maxStdoutBytes: 32, maxStderrBytes: 32,
    stdin: "eof-via-dev-null" }), (error: unknown) =>
    error instanceof Error && error.message === "helper");

  const temporary = await mkdtemp(join(tmpdir(), "billing-helper-child-"));
  const marker = join(temporary, "late-marker");
  try {
    await assert.rejects(runBoundedBillingAwsChildV1({ file: process.execPath,
      args: ["-e", "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'late'),150)", marker],
      cwd: process.cwd(), env: {}, timeoutMs: 30, maxStdoutBytes: 32, maxStderrBytes: 32,
      stdin: "eof-via-dev-null" }), (error: unknown) =>
      error instanceof Error && error.message === "helper");
    await new Promise<void>((resolve) => setTimeout(resolve, 220));
    await assert.rejects(access(marker));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
