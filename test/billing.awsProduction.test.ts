import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { encodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, padHex,
  type Address, type Hex } from "viem";
import { privateKeyToAccount, publicKeyToAddress } from "viem/accounts";
import {
  createAwsBillingProductionFactory,
  createEcsAwsBillingProductionFactory,
  type AwsBillingProductionDependencies,
} from "../src/billing/awsBillingProduction.internal.js";
import type { BillingAdapterConfigV2, BillingRelayPrepareV1, BillingSessionRefV1,
  Hex32 } from "../src/billing/custody.js";

const ACCOUNT = privateKeyToAccount(`0x${"00".repeat(31)}01` as Hex);
const WALLET = "0x2000000000000000000000000000000000000002" as Address;
const COLLECTOR = "0x3000000000000000000000000000000000000003" as Address;
const ORCHESTRATOR = "0xaf140d0416a994aebb3fa6212b16ce6700f09751";
const TICKET = "arn:aws:kms:us-east-1:123456789012:key/ticket-key";
const X402 = "arn:aws:kms:us-east-1:123456789012:key/x402-key";
const SESSION = "arn:aws:kms:us-east-1:123456789012:key/session-key";
const INFERENCE = "arn:aws:secretsmanager:us-east-1:123456789012:secret:inference";
const MANAGEMENT = "arn:aws:secretsmanager:us-east-1:123456789012:secret:management";
const TICKET_PUBLIC_DER = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
const PAY_INVOICE_ABI = [{ type: "function", name: "payInvoice", stateMutability: "payable",
  inputs: [{ name: "invoiceId", type: "bytes32" }, { name: "quoteExpiresAt", type: "uint64" }],
  outputs: [] }] as const;

function config(): BillingAdapterConfigV2 {
  return { domain: "4lpha.billing-adapter-config.v2", awsRegion: "us-east-1",
    awsAccountId: "123456789012", runtimeRoleArn: "arn:aws:iam::123456789012:role/4lpha-billing",
    credential: { kind: "ecs-task-role-v1" },
    relayOrigin: "https://relay.altana.network", chainId: 56, orchestrator: ORCHESTRATOR,
    keyStore: "0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a", ticketKeyArn: TICKET,
    ticketPublicKeySpkiBase64url: TICKET_PUBLIC_DER.toString("base64url"), x402KeyArn: X402,
    x402Authorizer: ACCOUNT.address.toLowerCase() as Address, x402Enabled: true, ogEnabled: true,
    ogPayerAccountId: "payer-1", ogInference: { secretArn: INFERENCE, versionId: "a".repeat(32) },
    ogManagement: { secretArn: MANAGEMENT, versionId: "b".repeat(32) } };
}

function session(): BillingSessionRefV1 {
  const facts = JSON.stringify({ version: "billing-session-facts-v1",
    spec: { allowedCalls: [{ to: COLLECTOR, selector: "payInvoice(bytes32,uint64)" }],
      spendCaps: [{ limit: "1000", period: "day" }], expiresAt: 2_000 },
    permissions: { calls: [{ signature: "payInvoice(bytes32,uint64)", to: COLLECTOR }],
      spend: [{ limit: { $uint: "1000" }, period: "day" }] },
    publicKey: ACCOUNT.publicKey, expiry: 2_000 });
  return { domain: "4lpha.billing-session-ref.v1", accountId: "billing-account-1", wallet: WALLET,
    kmsKeyArn: SESSION, publicKey: ACCOUNT.publicKey, generation: 1n, expiresAt: 2_000,
    sessionFactsBytes: Buffer.from(facts).toString("base64") };
}

function secpSpki(): Uint8Array {
  return Uint8Array.from(Buffer.from(
    `3056301006072a8648ce3d020106052b8104000a034200${ACCOUNT.publicKey.slice(2)}`, "hex"));
}

function accountKeyHash(): Hex32 {
  const inner = keccak256(padHex(publicKeyToAddress(ACCOUNT.publicKey), { size: 32 }));
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, inner])) as Hex32;
}

function executionData(input: BillingRelayPrepareV1): Hex {
  return encodeAbiParameters([{ type: "tuple[]", components: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ] }], [[{ target: input.collector, value: input.valueWei, data: input.calldata }]]);
}

test("production closure maps fixed AWS settings and observable Porto response fields", async () => {
  const clientSettings: unknown[] = [];
  const handlerSettings: unknown[] = [];
  const preparedInputs: Readonly<Record<string, unknown>>[] = [];
  let relayExpiry = 1_100n;
  let relaySendCalls = 0;
  const dependencies: AwsBillingProductionDependencies = {
    now() { return 1_000; },
    createRequestHandler(input) { handlerSettings.push(input); return Object.freeze({ handler: true }); },
    createKmsClient(settings) {
      clientSettings.push(settings);
      return {
        async describe(keyArn) {
          const ticket = keyArn === TICKET;
          return { KeyMetadata: { Arn: keyArn,
            KeySpec: ticket ? "ECC_NIST_EDWARDS25519" : "ECC_SECG_P256K1",
            KeyUsage: "SIGN_VERIFY", KeyState: "Enabled", Enabled: true,
            SigningAlgorithms: [ticket ? "ED25519_SHA_512" : "ECDSA_SHA_256"] } };
        },
        async publicKey(keyArn) {
          const ticket = keyArn === TICKET;
          return { KeySpec: ticket ? "ECC_NIST_EDWARDS25519" : "ECC_SECG_P256K1",
            KeyUsage: "SIGN_VERIFY", SigningAlgorithms: [ticket ? "ED25519_SHA_512" : "ECDSA_SHA_256"],
            PublicKey: ticket ? Uint8Array.from(TICKET_PUBLIC_DER) : secpSpki() };
        },
        async sign() { return { Signature: new Uint8Array(64).fill(9) }; },
        destroy() {},
      };
    },
    createSecretsClient(settings) {
      clientSettings.push(settings);
      return { async get(ref) { const inference = ref.secretArn === INFERENCE;
        return { ARN: ref.secretArn, VersionId: ref.versionId,
          SecretString: JSON.stringify({ version: "4lpha-0g-credential-v1",
            bearerToken: inference ? "inference-secret-token" : "management-secret-token",
            apiKeyId: inference ? "inference-key" : "management-key", payerAccountId: "payer-1" }) }; },
      destroy() {} };
    },
    createStsClient(settings) {
      clientSettings.push(settings);
      return { async identity() { return { Account: "123456789012",
        Arn: "arn:aws:sts::123456789012:assumed-role/4lpha-billing/task-1" }; }, destroy() {} };
    },
    createRelayClient(origin) { assert.equal(origin, "https://relay.altana.network"); return {}; },
    keyFrom(input) { return Object.freeze({ ...input, publicKey: publicKeyToAddress(input.publicKey),
      prehash: false }); },
    keyHash() { return accountKeyHash(); },
    async prepareCalls(_client, input) {
      preparedInputs.push(input);
      const quote = { ttl: 1_120, quotes: [{ chainId: 56, orchestrator: ORCHESTRATOR,
        intent: { eoa: WALLET, executionData: executionData({
          domain: "4lpha.billing-collection-prepare.v1", session: session(), collector: COLLECTOR,
          calldata: (input["calls"] as readonly [{ data: Hex }])[0].data, valueWei: 5n,
          maxExpiresAt: 1_130 }), expiry: relayExpiry, nonce: 1n } }] };
      const typedData = { domain: { name: "Altana", version: "0.5.5", chainId: 56,
        verifyingContract: ORCHESTRATOR }, message: { value: `0x${"11".repeat(32)}` },
        primaryType: "Intent", types: { Intent: [{ name: "value", type: "bytes32" }] } } as const;
      return { capabilities: { quote }, context: { quote }, digest: hashTypedData(typedData),
        key: input["key"], typedData };
    },
    async sendPreparedCalls() { relaySendCalls += 1; return { id: `0x${"33".repeat(32)}` }; },
    async getCallsStatus() { return null; },
  };

  const adapter = await createAwsBillingProductionFactory({ environment: {
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1",
  }, dependencies })(config());
  assert.equal(clientSettings.length, 3);
  for (const raw of clientSettings) {
    const settings = raw as Record<string, unknown>;
    assert.deepEqual(Object.keys(settings), ["region", "credentials", "requestHandler", "maxAttempts",
      "ignoreConfiguredEndpointUrls"]);
    assert.equal(settings["region"], "us-east-1");
    assert.equal(settings["maxAttempts"], 1);
    assert.equal(settings["ignoreConfiguredEndpointUrls"], true);
    assert.equal(typeof settings["credentials"], "function");
  }
  assert.deepEqual(handlerSettings, [
    { connectionTimeout: 1_000, requestTimeout: 1_000 },
    { connectionTimeout: 1_000, requestTimeout: 1_000 },
    { connectionTimeout: 1_000, requestTimeout: 1_000 },
  ]);
  assert.equal((await adapter.signExecutionTicket({ keyArn: TICKET,
    bytes: Uint8Array.from([1]) })).length, 86);

  const input: BillingRelayPrepareV1 = { domain: "4lpha.billing-collection-prepare.v1",
    session: session(), collector: COLLECTOR,
    calldata: encodeFunctionData({ abi: PAY_INVOICE_ABI, functionName: "payInvoice",
      args: [`0x${"44".repeat(32)}`, 1_130n] }), valueWei: 5n,
    maxExpiresAt: 1_130 };
  const prepared = await adapter.relayPrepare(input);
  assert.equal(prepared.relayIntentExpiresAt, 1_100);
  assert.equal((preparedInputs[0]?.["feeToken"]), "0x0000000000000000000000000000000000000000");
  const key = preparedInputs[0]?.["key"] as Record<string, unknown>;
  assert.deepEqual((key["permissions"] as { spend: readonly unknown[] }).spend,
    [{ limit: 1000n, period: "day" }]);

  relayExpiry = 0n;
  await assert.rejects(adapter.relayPrepare(input), /prepared response/);
  assert.equal(relaySendCalls, 0);
});

test("production closure rejects alternate AWS credential sources before clients exist", async () => {
  let constructed = false;
  const dependencies = { createKmsClient() { constructed = true; throw new Error("unreachable"); } } as unknown as AwsBillingProductionDependencies;
  await assert.rejects(createAwsBillingProductionFactory({ environment: {
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1",
    AWS_ACCESS_KEY_ID: "forbidden",
  }, dependencies })(config()), /BILLING_AWS_CREDENTIAL_INVALID/);
  assert.equal(constructed, false);
});

test("non-Railway ECS composition rejects Roles Anywhere and Railway crossover before clients", async () => {
  let constructed = false;
  const dependencies = {
    createKmsClient() { constructed = true; throw new Error("unreachable"); },
  } as unknown as AwsBillingProductionDependencies;
  const rolesAnywhere = { ...config(), credential: {
    kind: "roles-anywhere-x509-v1" as const,
    trustAnchorArn: "arn:aws:rolesanywhere:us-east-1:123456789012:trust-anchor/anchor-1",
    profileArn: "arn:aws:rolesanywhere:us-east-1:123456789012:profile/profile-1",
    certificateSha256: "d".repeat(64), certificateSubjectCn: "railway-billing",
    certificateIssuerCn: "4lpha-ca", helperVersion: "1.8.4" as const,
    helperBytes: "12094568" as const,
    helperSha256: "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9" as const,
  } };
  await assert.rejects(createEcsAwsBillingProductionFactory({ environment: {
    BILLING_PRODUCTION_MANIFEST_PATH: "/run/4lpha/manifest.json",
    BILLING_PRODUCTION_BUNDLE_PATH: "/app/artifacts/billing-adapter.mjs",
    BILLING_AWS_RA_CERTIFICATE_PATH: "/run/4lpha/roles-anywhere/certificate.pem",
    BILLING_AWS_RA_PRIVATE_KEY_PATH: "/run/4lpha/roles-anywhere/private-key.pem",
    BILLING_RAILWAY_CLEAN_EXEC: "1",
  }, dependencies })(rolesAnywhere), /BILLING_AWS_CREDENTIAL_INVALID/);
  await assert.rejects(createEcsAwsBillingProductionFactory({ environment: {
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1",
    BILLING_RAILWAY_CLEAN_EXEC: "1",
  }, dependencies })(config()), /BILLING_AWS_CREDENTIAL_INVALID/);
  assert.equal(constructed, false);
});
