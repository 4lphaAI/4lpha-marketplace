import {
  DescribeKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  type KMSClientConfig,
} from "@aws-sdk/client-kms";
import { GetSecretValueCommand, SecretsManagerClient,
  type SecretsManagerClientConfig } from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand, STSClient, type STSClientConfig } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import * as Key from "porto/viem/Key";
import * as RelayActions from "porto/viem/RelayActions";
import { createClient, http, type Hex } from "viem";
import { bsc } from "viem/chains";
import {
  createAwsBillingAdapterFactory,
  validatePortoPreparedIdentityV1,
  type AwsBillingAdapterProtocols,
  type AwsBillingKmsProtocol,
  type AwsBillingPortoProtocol,
  type AwsBillingSecretsProtocol,
  type AwsBillingStsProtocol,
} from "./awsBillingAdapter.js";
import { assertNonRailwayEcsBillingAwsCompositionV1, createBillingAwsCredentialProviderV2,
  type BillingAwsCredentialDependencies } from "./awsBillingCredentials.js";
import type {
  BillingAdapterConfigV2,
  OgSecretVersionRefV1,
  ProductionBillingCustodyAndRelayPrimitives,
} from "./custody.js";

type RawKmsClient = Readonly<{
  describe(keyArn: string): Promise<unknown>;
  publicKey(keyArn: string): Promise<unknown>;
  sign(input: Readonly<{ keyArn: string; algorithm: string; messageType: string;
    message: Uint8Array }>): Promise<unknown>;
  destroy(): void;
}>;

type RawSecretsClient = Readonly<{
  get(ref: OgSecretVersionRefV1): Promise<unknown>;
  destroy(): void;
}>;

type RawStsClient = Readonly<{
  identity(): Promise<unknown>;
  destroy(): void;
}>;

type AwsClientSettings = Readonly<{
  region: string;
  credentials: AwsCredentialIdentityProvider;
  requestHandler: unknown;
  maxAttempts: 1;
  ignoreConfiguredEndpointUrls: true;
}>;

type RelayKeyInput = Readonly<{
  expiry: number;
  permissions: Readonly<{
    calls: readonly [Readonly<{ signature: "payInvoice(bytes32,uint64)"; to: Hex }>];
    spend: readonly [Readonly<{ limit: bigint; period: "day" }>];
  }>;
  publicKey: Hex;
  role: "session";
  type: "secp256k1";
}>;

export type AwsBillingProductionDependencies = Readonly<{
  now(): number;
  createRequestHandler(input: Readonly<{ connectionTimeout: 1_000; requestTimeout: 1_000 }>): unknown;
  createKmsClient(settings: AwsClientSettings): RawKmsClient;
  createSecretsClient(settings: AwsClientSettings): RawSecretsClient;
  createStsClient(settings: AwsClientSettings): RawStsClient;
  createRelayClient(origin: "https://relay.altana.network"): unknown;
  keyFrom(input: RelayKeyInput): unknown;
  keyHash(key: unknown): unknown;
  prepareCalls(client: unknown, input: Readonly<Record<string, unknown>>): Promise<unknown>;
  sendPreparedCalls(client: unknown, input: Readonly<Record<string, unknown>>): Promise<unknown>;
  getCallsStatus(client: unknown, input: Readonly<{ id: Hex }>): Promise<unknown>;
}>;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`BILLING_PRODUCTION_PROTOCOL_INVALID: ${label}.`);
  }
  return value as Record<string, unknown>;
}

function rawKms(settings: AwsClientSettings): RawKmsClient {
  const client = new KMSClient(settings as KMSClientConfig);
  return {
    async describe(keyArn) { return client.send(new DescribeKeyCommand({ KeyId: keyArn })); },
    async publicKey(keyArn) { return client.send(new GetPublicKeyCommand({ KeyId: keyArn })); },
    async sign(input) { return client.send(new SignCommand({ KeyId: input.keyArn,
      SigningAlgorithm: input.algorithm as "ECDSA_SHA_256" | "ED25519_SHA_512",
      MessageType: input.messageType as "RAW" | "DIGEST", Message: input.message })); },
    destroy() { client.destroy(); },
  };
}

function rawSecrets(settings: AwsClientSettings): RawSecretsClient {
  const client = new SecretsManagerClient(settings as SecretsManagerClientConfig);
  return {
    async get(ref) { return client.send(new GetSecretValueCommand({ SecretId: ref.secretArn,
      VersionId: ref.versionId })); },
    destroy() { client.destroy(); },
  };
}

function rawSts(settings: AwsClientSettings): RawStsClient {
  const client = new STSClient(settings as STSClientConfig);
  return {
    async identity() { return client.send(new GetCallerIdentityCommand({})); },
    destroy() { client.destroy(); },
  };
}

const REAL_DEPENDENCIES: AwsBillingProductionDependencies = {
  now() { return Math.floor(Date.now() / 1_000); },
  createRequestHandler(input) { return new NodeHttpHandler(input); },
  createKmsClient: rawKms,
  createSecretsClient: rawSecrets,
  createStsClient: rawSts,
  createRelayClient(origin) { return createClient({ chain: bsc,
    transport: http(origin, { retryCount: 0 }) }); },
  keyFrom(input) { return Key.from(input); },
  keyHash(key) { return Key.hash(key as Pick<Key.Key, "publicKey" | "type">); },
  async prepareCalls(client, input) {
    return RelayActions.prepareCalls(client as Parameters<typeof RelayActions.prepareCalls>[0],
      input as Parameters<typeof RelayActions.prepareCalls>[1]);
  },
  async sendPreparedCalls(client, input) {
    return RelayActions.sendPreparedCalls(client as Parameters<typeof RelayActions.sendPreparedCalls>[0],
      input as Parameters<typeof RelayActions.sendPreparedCalls>[1]);
  },
  async getCallsStatus(client, input) {
    return RelayActions.getCallsStatus(client as Parameters<typeof RelayActions.getCallsStatus>[0], input);
  },
};

function kmsProtocol(client: RawKmsClient): AwsBillingKmsProtocol {
  return {
    async describeKey(keyArn) {
      const row = asRecord(await client.describe(keyArn), "DescribeKey response");
      const metadata = asRecord(row["KeyMetadata"], "DescribeKey metadata");
      return { keyArn: String(metadata["Arn"] ?? ""), keySpec: String(metadata["KeySpec"] ?? ""),
        keyUsage: String(metadata["KeyUsage"] ?? ""), keyState: String(metadata["KeyState"] ?? ""),
        enabled: metadata["Enabled"] === true,
        signingAlgorithms: Array.isArray(metadata["SigningAlgorithms"])
          ? metadata["SigningAlgorithms"].map(String) : [] };
    },
    async getPublicKey(keyArn) {
      const row = asRecord(await client.publicKey(keyArn), "GetPublicKey response");
      if (!(row["PublicKey"] instanceof Uint8Array)) throw new Error("KMS public key is malformed");
      return { keyArn, keySpec: String(row["KeySpec"] ?? ""), keyUsage: String(row["KeyUsage"] ?? ""),
        signingAlgorithms: Array.isArray(row["SigningAlgorithms"])
          ? row["SigningAlgorithms"].map(String) : [], spkiDer: row["PublicKey"] };
    },
    async sign(input) {
      const row = asRecord(await client.sign(input), "Sign response");
      if (!(row["Signature"] instanceof Uint8Array)) throw new Error("KMS signature is malformed");
      return row["Signature"];
    },
    async close() { client.destroy(); },
  };
}

function secretsProtocol(client: RawSecretsClient): AwsBillingSecretsProtocol {
  return {
    async getSecretValue(ref) {
      const row = asRecord(await client.get(ref), "GetSecretValue response");
      if (row["ARN"] !== ref.secretArn || row["VersionId"] !== ref.versionId) {
        throw new Error("secret version identity differs");
      }
      return {
        ...(typeof row["SecretString"] === "string" ? { secretString: row["SecretString"] } : {}),
        ...(row["SecretBinary"] instanceof Uint8Array ? { secretBinary: row["SecretBinary"] } : {}),
      };
    },
    async close() { client.destroy(); },
  };
}

function stsProtocol(client: RawStsClient): AwsBillingStsProtocol {
  return {
    async getCallerIdentity() {
      const row = asRecord(await client.identity(), "GetCallerIdentity response");
      return { ...(typeof row["Account"] === "string" ? { account: row["Account"] } : {}),
        ...(typeof row["Arn"] === "string" ? { arn: row["Arn"] } : {}) };
    },
    async close() { client.destroy(); },
  };
}

function permissions(value: unknown): RelayKeyInput["permissions"] {
  const root = asRecord(value, "session permissions");
  const calls = root["calls"];
  const spend = root["spend"];
  if (!Array.isArray(calls) || calls.length !== 1 || !Array.isArray(spend) || spend.length !== 1) {
    throw new Error("session permissions are malformed");
  }
  const call = asRecord(calls[0], "session call permission");
  const cap = asRecord(spend[0], "session spend permission");
  const uint = asRecord(cap["limit"], "session spend limit");
  if (call["signature"] !== "payInvoice(bytes32,uint64)" || typeof call["to"] !== "string" ||
      cap["period"] !== "day" || typeof uint["$uint"] !== "string" ||
      !/^[1-9][0-9]{0,77}$/u.test(uint["$uint"])) throw new Error("session permissions are malformed");
  return { calls: [{ signature: "payInvoice(bytes32,uint64)", to: call["to"] as Hex }],
    spend: [{ limit: BigInt(uint["$uint"]), period: "day" }] };
}

function portoProtocol(client: unknown, dependencies: AwsBillingProductionDependencies): AwsBillingPortoProtocol {
  return {
    async prepare(input) {
      const key = dependencies.keyFrom({ expiry: input.session.expiresAt,
        permissions: permissions(input.session.permissions), publicKey: input.session.publicKey,
        role: "session", type: "secp256k1" });
      const result = await dependencies.prepareCalls(client, { account: input.wallet,
        calls: input.calls, chain: bsc, feeToken: input.feeToken, key });
      return validatePortoPreparedIdentityV1({ wallet: input.wallet, collector: input.calls[0].to,
        calldata: input.calls[0].data, valueWei: input.calls[0].value,
        sessionPublicKey: input.session.publicKey, orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
        orchestratorVersion: "0.5.5", expectedKey: key as object }, result);
    },
    async send(input) {
      const opaque = asRecord(input.prepared, "prepared opaque handle");
      return asRecord(await dependencies.sendPreparedCalls(client, { capabilities: opaque["capabilities"],
        context: opaque["context"], key: opaque["key"], signature: input.signature }), "send response");
    },
    async status(callsId) { return dependencies.getCallsStatus(client, { id: callsId }); },
  };
}

/** Internal dependency seam; the production entry point never exposes deps or environment as config. */
export function createAwsBillingProductionFactory(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  dependencies?: AwsBillingProductionDependencies;
  credentialDependencies?: BillingAwsCredentialDependencies;
}>): (config: BillingAdapterConfigV2) => Promise<ProductionBillingCustodyAndRelayPrimitives> {
  const dependencies = process.env.BILLING_ADAPTER_BUILD_TARGET === "production"
    ? REAL_DEPENDENCIES
    : input.dependencies ?? REAL_DEPENDENCIES;
  const injectedCredentialDependencies = process.env.BILLING_ADAPTER_BUILD_TARGET === "production"
    ? undefined
    : input.credentialDependencies;
  return async (config) => {
    const provider = await createBillingAwsCredentialProviderV2({ aws: {
      region: config.awsRegion, accountId: config.awsAccountId,
      runtimeRoleArn: config.runtimeRoleArn, credential: config.credential,
    }, environment: input.environment, ...(injectedCredentialDependencies === undefined
      ? {} : { dependencies: injectedCredentialDependencies }) });
    const credentials = provider.credentials;
    const settings = (): AwsClientSettings => ({ region: config.awsRegion, credentials,
      requestHandler: dependencies.createRequestHandler({ connectionTimeout: 1_000, requestTimeout: 1_000 }),
      maxAttempts: 1, ignoreConfiguredEndpointUrls: true });
    let kms: RawKmsClient | undefined;
    let secrets: RawSecretsClient | undefined;
    let sts: RawStsClient | undefined;
    try {
      kms = dependencies.createKmsClient(settings());
      secrets = dependencies.createSecretsClient(settings());
      sts = dependencies.createStsClient(settings());
      const relay = dependencies.createRelayClient(config.relayOrigin);
      const protocols: AwsBillingAdapterProtocols = { kms: kmsProtocol(kms), secrets: secretsProtocol(secrets),
        sts: { ...stsProtocol(sts), async close() { sts?.destroy(); await provider.close(); } },
        porto: portoProtocol(relay, dependencies), now: dependencies.now };
      return await createAwsBillingAdapterFactory(protocols)(config);
    }
    catch (error) {
      kms?.destroy();
      secrets?.destroy();
      sts?.destroy();
      await provider.close();
      throw error;
    }
  };
}

/** Non-Railway entry composition: Roles Anywhere can never reach material or client construction. */
export function createEcsAwsBillingProductionFactory(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  dependencies?: AwsBillingProductionDependencies;
  credentialDependencies?: BillingAwsCredentialDependencies;
}>): (config: BillingAdapterConfigV2) => Promise<ProductionBillingCustodyAndRelayPrimitives> {
  const create = createAwsBillingProductionFactory(input);
  return async (config) => {
    assertNonRailwayEcsBillingAwsCompositionV1({ aws: { region: config.awsRegion,
      accountId: config.awsAccountId, runtimeRoleArn: config.runtimeRoleArn,
      credential: config.credential }, environment: input.environment });
    return create(config);
  };
}
