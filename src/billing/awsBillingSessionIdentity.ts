import { createPublicKey } from "node:crypto";
import {
  DescribeKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  type KMSClientConfig,
} from "@aws-sdk/client-kms";
import { GetCallerIdentityCommand, STSClient, type STSClientConfig } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import type { Hex } from "viem";
import { assertNonRailwayEcsBillingAwsCompositionV1, createBillingAwsCredentialProviderV2,
  type BillingAwsCredentialDependencies } from "./awsBillingCredentials.js";
import type { BillingProductionManifestV2 } from "./productionManifest.js";

type AwsClientSettings = Readonly<{
  region: string;
  credentials: AwsCredentialIdentityProvider;
  requestHandler: unknown;
  maxAttempts: 1;
  ignoreConfiguredEndpointUrls: true;
}>;

type RawKmsIdentityClient = Readonly<{
  describe(keyArn: string): Promise<unknown>;
  publicKey(keyArn: string): Promise<unknown>;
  destroy(): void;
}>;

type RawStsIdentityClient = Readonly<{
  identity(): Promise<unknown>;
  destroy(): void;
}>;

type PublicJwk = Readonly<{
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
}>;

export type AwsBillingSessionIdentityDependencies = Readonly<{
  createRequestHandler(input: Readonly<{ connectionTimeout: 1_000; requestTimeout: 1_000 }>): unknown;
  createKmsClient(settings: AwsClientSettings): RawKmsIdentityClient;
  createStsClient(settings: AwsClientSettings): RawStsIdentityClient;
}>;

export type VerifiedBillingSessionKmsIdentityV1 = Readonly<{
  domain: "4lpha.billing-session-kms-identity.v1";
  kmsKeyArn: string;
  publicKey: Hex;
}>;

export type BillingSessionKmsIdentityReaderV1 = Readonly<{
  read(input: Readonly<{
    domain: "4lpha.billing-session-kms-identity-read.v1";
    manifest: BillingProductionManifestV2;
    kmsKeyArn: string;
  }>): Promise<VerifiedBillingSessionKmsIdentityV1>;
}>;

function refuse(reason: string): never {
  throw new Error(`BILLING_SESSION_IDENTITY_INVALID: ${reason}`);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${field} is malformed.`);
  return value as Record<string, unknown>;
}

function realKms(settings: AwsClientSettings): RawKmsIdentityClient {
  const client = new KMSClient(settings as KMSClientConfig);
  return {
    async describe(keyArn) { return client.send(new DescribeKeyCommand({ KeyId: keyArn })); },
    async publicKey(keyArn) { return client.send(new GetPublicKeyCommand({ KeyId: keyArn })); },
    destroy() { client.destroy(); },
  };
}

function realSts(settings: AwsClientSettings): RawStsIdentityClient {
  const client = new STSClient(settings as STSClientConfig);
  return {
    async identity() { return client.send(new GetCallerIdentityCommand({})); },
    destroy() { client.destroy(); },
  };
}

const REAL_DEPENDENCIES: AwsBillingSessionIdentityDependencies = {
  createRequestHandler(input) { return new NodeHttpHandler(input); },
  createKmsClient: realKms,
  createStsClient: realSts,
};

function assumedRoleMatches(arn: string, expectedRoleArn: string, account: string): boolean {
  const expected = /^arn:(aws(?:-us-gov)?):iam::([0-9]{12}):role\/(.+)$/u.exec(expectedRoleArn);
  const actual = /^arn:(aws(?:-us-gov)?):sts::([0-9]{12}):assumed-role\/(.+)\/[^/]+$/u.exec(arn);
  return expected !== null && actual !== null && expected[1] === actual[1] &&
    expected[2] === account && actual[2] === account && expected[3] === actual[3];
}

function secp256k1PublicKey(spkiDer: Uint8Array): Hex {
  let jwk: PublicJwk;
  try {
    jwk = createPublicKey({ key: Buffer.from(spkiDer), format: "der", type: "spki" })
      .export({ format: "jwk" }) as PublicJwk;
  } catch { return refuse("KMS public key DER is malformed."); }
  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" || typeof jwk.x !== "string" ||
      typeof jwk.y !== "string") refuse("KMS public key curve drifted.");
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  if (x.byteLength !== 32 || y.byteLength !== 32) refuse("KMS public key length drifted.");
  return `0x04${x.toString("hex")}${y.toString("hex")}`;
}

function manifestBoundKeyArn(manifest: BillingProductionManifestV2, keyArn: string): void {
  const prefix = `arn:aws:kms:${manifest.aws.region}:${manifest.aws.accountId}:key/`;
  if (!keyArn.startsWith(prefix) || keyArn.length === prefix.length || keyArn.length > 2_048 ||
      keyArn === manifest.aws.ticketKeyArn || keyArn === manifest.aws.x402KeyArn) {
    refuse("session KMS key is outside the reviewed manifest identity or collides with another role.");
  }
}

/**
 * Closed identity-only AWS path. It performs STS, DescribeKey and GetPublicKey
 * reads and deliberately has no KMS Sign, Secrets Manager, relay or RPC seam.
 */
export function createAwsBillingSessionIdentityReader(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  dependencies?: AwsBillingSessionIdentityDependencies;
  credentialDependencies?: BillingAwsCredentialDependencies;
}>): BillingSessionKmsIdentityReaderV1 {
  const dependencies = process.env.BILLING_ADAPTER_BUILD_TARGET === "production"
    ? REAL_DEPENDENCIES
    : input.dependencies ?? REAL_DEPENDENCIES;
  const injectedCredentialDependencies = process.env.BILLING_ADAPTER_BUILD_TARGET === "production"
    ? undefined
    : input.credentialDependencies;
  return Object.freeze({
    async read(request): Promise<VerifiedBillingSessionKmsIdentityV1> {
      if (Object.keys(request).join("|") !== "domain|manifest|kmsKeyArn" ||
          request.domain !== "4lpha.billing-session-kms-identity-read.v1") {
        refuse("identity request census is malformed.");
      }
      manifestBoundKeyArn(request.manifest, request.kmsKeyArn);
      const provider = await createBillingAwsCredentialProviderV2({ aws: {
        region: request.manifest.aws.region, accountId: request.manifest.aws.accountId,
        runtimeRoleArn: request.manifest.aws.runtimeRoleArn, credential: request.manifest.aws.credential,
      },
        environment: input.environment, ...(injectedCredentialDependencies === undefined
          ? {} : { dependencies: injectedCredentialDependencies }) });
      const credentials = provider.credentials;
      try {
      const settings = (): AwsClientSettings => ({ region: request.manifest.aws.region, credentials,
        requestHandler: dependencies.createRequestHandler({ connectionTimeout: 1_000, requestTimeout: 1_000 }),
        maxAttempts: 1, ignoreConfiguredEndpointUrls: true });

      const sts = dependencies.createStsClient(settings());
      let caller: Record<string, unknown>;
      try { caller = asRecord(await sts.identity(), "GetCallerIdentity response"); }
      catch { return refuse("AWS workload identity read failed."); }
      finally { sts.destroy(); }
      if (caller["Account"] !== request.manifest.aws.accountId || typeof caller["Arn"] !== "string" ||
          !assumedRoleMatches(caller["Arn"], request.manifest.aws.runtimeRoleArn, request.manifest.aws.accountId)) {
        refuse("AWS workload identity differs from the reviewed manifest role.");
      }

      const kms = dependencies.createKmsClient(settings());
      let description: Record<string, unknown>;
      let publicResult: Record<string, unknown>;
      try {
        const [rawDescription, rawPublic] = await Promise.all([
          kms.describe(request.kmsKeyArn),
          kms.publicKey(request.kmsKeyArn),
        ]);
        const envelope = asRecord(rawDescription, "DescribeKey response");
        description = asRecord(envelope["KeyMetadata"], "DescribeKey metadata");
        publicResult = asRecord(rawPublic, "GetPublicKey response");
      } catch { return refuse("KMS identity read failed."); }
      finally { kms.destroy(); }

      const describedAlgorithms = description["SigningAlgorithms"];
      const publicAlgorithms = publicResult["SigningAlgorithms"];
      if (description["Arn"] !== request.kmsKeyArn || description["KeySpec"] !== "ECC_SECG_P256K1" ||
          description["KeyUsage"] !== "SIGN_VERIFY" || description["KeyState"] !== "Enabled" ||
          description["Enabled"] !== true || !Array.isArray(describedAlgorithms) ||
          describedAlgorithms.length !== 1 || describedAlgorithms[0] !== "ECDSA_SHA_256" ||
          publicResult["KeySpec"] !== "ECC_SECG_P256K1" || publicResult["KeyUsage"] !== "SIGN_VERIFY" ||
          !Array.isArray(publicAlgorithms) || publicAlgorithms.length !== 1 ||
          publicAlgorithms[0] !== "ECDSA_SHA_256" || !(publicResult["PublicKey"] instanceof Uint8Array)) {
        refuse("KMS key metadata drifted from the billing adapter contract.");
      }
      const publicKey = secp256k1PublicKey(publicResult["PublicKey"]);
      return Object.freeze({ domain: "4lpha.billing-session-kms-identity.v1",
        kmsKeyArn: request.kmsKeyArn, publicKey });
      } finally {
        await provider.close();
      }
    },
  });
}

/** Identity-only companion for the separately bundled non-Railway ECS artifact. */
export function createEcsAwsBillingSessionIdentityReader(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  dependencies?: AwsBillingSessionIdentityDependencies;
  credentialDependencies?: BillingAwsCredentialDependencies;
}>): BillingSessionKmsIdentityReaderV1 {
  const reader = createAwsBillingSessionIdentityReader(input);
  return Object.freeze({
    async read(request) {
      assertNonRailwayEcsBillingAwsCompositionV1({ aws: {
        region: request.manifest.aws.region, accountId: request.manifest.aws.accountId,
        runtimeRoleArn: request.manifest.aws.runtimeRoleArn, credential: request.manifest.aws.credential,
      }, environment: input.environment });
      return reader.read(request);
    },
  });
}
