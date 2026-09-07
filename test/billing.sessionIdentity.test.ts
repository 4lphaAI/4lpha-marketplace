import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createAwsBillingSessionIdentityReader,
  createEcsAwsBillingSessionIdentityReader,
  type AwsBillingSessionIdentityDependencies } from "../src/billing/awsBillingSessionIdentity.js";
import { parseProductionManifest } from "../src/billing/productionManifest.js";
import { GOLDEN_PRODUCTION_MANIFEST_V2 } from "./fixtures/billing/productionManifestV2.js";

const manifest = parseProductionManifest(Buffer.from(GOLDEN_PRODUCTION_MANIFEST_V2));
const account = privateKeyToAccount(`0x${"00".repeat(31)}01`);
const sessionArn = "arn:aws:kms:us-east-1:123456789012:key/session-identity";

function secpSpki(): Uint8Array {
  return Uint8Array.from(Buffer.from(
    `3056301006072a8648ce3d020106052b8104000a034200${account.publicKey.slice(2)}`, "hex"));
}

function dependencies(input: Readonly<{
  callerAccount?: string;
  callerArn?: string;
  describedArn?: string;
  keySpec?: string;
  keyUsage?: string;
  keyState?: string;
  enabled?: boolean;
  algorithms?: readonly string[];
  publicKey?: Uint8Array;
  calls?: string[];
  settings?: unknown[];
}> = {}): AwsBillingSessionIdentityDependencies {
  return {
    createRequestHandler() { return {}; },
    createStsClient(settings) {
      input.settings?.push(settings);
      input.calls?.push("sts");
      return { async identity() { return {
        Account: input.callerAccount ?? manifest.aws.accountId,
        Arn: input.callerArn ?? "arn:aws:sts::123456789012:assumed-role/4lpha-billing/task-1",
      }; }, destroy() { input.calls?.push("sts-close"); } };
    },
    createKmsClient(settings) {
      input.settings?.push(settings);
      input.calls?.push("kms");
      return {
        async describe(keyArn) { input.calls?.push("describe"); return { KeyMetadata: {
          Arn: input.describedArn ?? keyArn,
          KeySpec: input.keySpec ?? "ECC_SECG_P256K1",
          KeyUsage: input.keyUsage ?? "SIGN_VERIFY",
          KeyState: input.keyState ?? "Enabled",
          Enabled: input.enabled ?? true,
          SigningAlgorithms: input.algorithms ?? ["ECDSA_SHA_256"],
        } }; },
        async publicKey() { input.calls?.push("public-key"); return {
          KeySpec: input.keySpec ?? "ECC_SECG_P256K1",
          KeyUsage: input.keyUsage ?? "SIGN_VERIFY",
          SigningAlgorithms: input.algorithms ?? ["ECDSA_SHA_256"],
          PublicKey: input.publicKey ?? secpSpki(),
        }; },
        destroy() { input.calls?.push("kms-close"); },
      };
    },
  };
}

function reader(deps: AwsBillingSessionIdentityDependencies, environment: NodeJS.ProcessEnv = {
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1",
}) {
  return createAwsBillingSessionIdentityReader({ environment, dependencies: deps });
}

test("closed AWS session identity reader verifies STS before exact KMS identity and returns only ARN/public key", async () => {
  const calls: string[] = [];
  const settings: unknown[] = [];
  const identity = await reader(dependencies({ calls, settings })).read({
    domain: "4lpha.billing-session-kms-identity-read.v1", manifest, kmsKeyArn: sessionArn,
  });
  assert.deepEqual(identity, {
    domain: "4lpha.billing-session-kms-identity.v1",
    kmsKeyArn: sessionArn,
    publicKey: account.publicKey,
  });
  assert.deepEqual(calls, ["sts", "sts-close", "kms", "describe", "public-key", "kms-close"]);
  assert.equal(settings.length, 2);
  for (const value of settings) {
    assert.equal((value as Record<string, unknown>)["ignoreConfiguredEndpointUrls"], true);
  }
  assert.deepEqual(Object.keys(dependencies().createKmsClient({} as never)).sort(),
    ["describe", "destroy", "publicKey"]);
});

test("session identity reader rejects workload, role collision and KMS metadata/public-key drift", async () => {
  await assert.rejects(reader(dependencies({ callerAccount: "999999999999" })).read({
    domain: "4lpha.billing-session-kms-identity-read.v1", manifest, kmsKeyArn: sessionArn,
  }), /workload identity differs/);
  await assert.rejects(reader(dependencies()).read({
    domain: "4lpha.billing-session-kms-identity-read.v1", manifest, kmsKeyArn: manifest.aws.x402KeyArn,
  }), /collides/);
  await assert.rejects(reader(dependencies({ keySpec: "RSA_2048" })).read({
    domain: "4lpha.billing-session-kms-identity-read.v1", manifest, kmsKeyArn: sessionArn,
  }), /metadata drifted/);
  await assert.rejects(reader(dependencies({ algorithms: ["ECDSA_SHA_384"] })).read({
    domain: "4lpha.billing-session-kms-identity-read.v1", manifest, kmsKeyArn: sessionArn,
  }), /metadata drifted/);
  await assert.rejects(reader(dependencies({ publicKey: Uint8Array.from([1, 2, 3]) })).read({
    domain: "4lpha.billing-session-kms-identity-read.v1", manifest, kmsKeyArn: sessionArn,
  }), /DER is malformed/);
});

test("session identity reader refuses alternate credential sources before constructing an AWS client", async () => {
  let constructed = false;
  await assert.rejects(reader({
    createRequestHandler() { return {}; },
    createKmsClient() { constructed = true; throw new Error("unreachable"); },
    createStsClient() { constructed = true; throw new Error("unreachable"); },
  }, {
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1",
    AWS_ACCESS_KEY_ID: "forbidden",
  }).read({ domain: "4lpha.billing-session-kms-identity-read.v1", manifest, kmsKeyArn: sessionArn }),
  /BILLING_AWS_CREDENTIAL_INVALID/);
  assert.equal(constructed, false);
});

test("non-Railway ECS identity composition rejects Roles Anywhere before constructing a client", async () => {
  let constructed = false;
  const raManifest = { ...manifest, aws: { ...manifest.aws, credential: {
    kind: "roles-anywhere-x509-v1" as const,
    trustAnchorArn: "arn:aws:rolesanywhere:us-east-1:123456789012:trust-anchor/anchor-1",
    profileArn: "arn:aws:rolesanywhere:us-east-1:123456789012:profile/profile-1",
    certificateSha256: "d".repeat(64), certificateSubjectCn: "railway-billing",
    certificateIssuerCn: "4lpha-ca", helperVersion: "1.8.4" as const,
    helperBytes: "12094568" as const,
    helperSha256: "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9" as const,
  } } };
  const ecs = createEcsAwsBillingSessionIdentityReader({ environment: {
    BILLING_AWS_RA_CERTIFICATE_PATH: "/run/4lpha/roles-anywhere/certificate.pem",
    BILLING_AWS_RA_PRIVATE_KEY_PATH: "/run/4lpha/roles-anywhere/private-key.pem",
    BILLING_RAILWAY_CLEAN_EXEC: "1",
  }, dependencies: {
    createRequestHandler() { return {}; },
    createKmsClient() { constructed = true; throw new Error("unreachable"); },
    createStsClient() { constructed = true; throw new Error("unreachable"); },
  } });
  await assert.rejects(ecs.read({ domain: "4lpha.billing-session-kms-identity-read.v1",
    manifest: raManifest, kmsKeyArn: sessionArn }), /BILLING_AWS_CREDENTIAL_INVALID/);
  assert.equal(constructed, false);
});

test("billing preparation command accepts no independently trusted public key and identity module has no signing/send capability", async () => {
  const [command, identityModule] = await Promise.all([
    readFile(new URL("../scripts/provision-billing.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/billing/awsBillingSessionIdentity.ts", import.meta.url), "utf8"),
  ]);
  assert.ok(!command.includes("session-public-key"));
  assert.match(command, /loadProductionBillingSessionIdentityReader/u);
  assert.match(command, /prepareVerifiedKmsBillingSession/u);
  assert.match(command, /awsIdentityRead: true/u);
  assert.match(command, /transactionOrRelayContacted: false/u);
  assert.ok(!identityModule.includes("SignCommand"));
  assert.ok(!identityModule.includes("SecretsManager"));
  assert.ok(!identityModule.includes("sendPreparedCalls"));
});
