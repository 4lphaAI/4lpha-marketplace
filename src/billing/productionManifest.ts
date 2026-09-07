import { createHash } from "node:crypto";
import { getAddress, getContractAddress, isAddress, zeroAddress, type Address } from "viem";

export const BILLING_PRODUCTION_MANIFEST_SCHEMA = "4lpha.billing-production-manifest.v2";
export const BILLING_PRODUCTION_MIGRATION = "006_phase5_production_enablement.sql";
export const MAX_PLATFORM_USDC_ATOMIC = 100_000_000n;
export const MAX_PLATFORM_OG_NEURON = 100_000_000_000_000_000_000n;
export const MAX_BASE_GAS_RESERVE_WEI = 100_000_000_000_000_000n;
export const ALTANA_KEYSTORE = "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a" as Address;
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const HEX32 = /^0x[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/u;
const VERSION_ID = /^[A-Za-z0-9_-]{32,64}$/u;
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/u;
const U64_MAX = (1n << 64n) - 1n;

const TOP_KEYS = ["schema", "buildCommit", "sourceSha256", "lockSha256", "bundleSha256", "aws", "collector", "networks", "oracles", "caps", "postgres", "providers"] as const;
const AWS_KEYS = ["region", "accountId", "runtimeRoleArn", "credential", "ticketKeyId", "ticketKeyArn", "x402KeyArn", "ogInference", "ogManagement"] as const;
const ECS_CREDENTIAL_KEYS = ["kind"] as const;
const ROLES_ANYWHERE_CREDENTIAL_KEYS = ["kind", "trustAnchorArn", "profileArn", "certificateSha256", "certificateSubjectCn", "certificateIssuerCn", "helperVersion", "helperBytes", "helperSha256"] as const;
const SECRET_KEYS = ["secretArn", "versionId"] as const;
const COLLECTOR_KEYS = ["address", "treasury", "deployer", "nonce", "deploymentTxHash", "deploymentBlock", "deploymentBlockHash", "runtimeCodehash", "attestationSha256"] as const;
const NETWORK_KEYS = ["execution", "chainId", "bsc", "base", "arbitrum", "baseUsdc"] as const;
const RPC_KEYS = ["origins", "finalityDepth"] as const;
const USDC_KEYS = ["address", "decimals"] as const;
const ORACLE_KEYS = ["bnbUsd", "ogUsd", "arbitrumSequencer", "maxAgeSec", "maxSkewSec", "graceSec"] as const;
const FEED_KEYS = ["proxy", "description", "decimals"] as const;
const CAP_KEYS = ["platformUsdcAtomic", "platformOgNeuron", "minBaseGasReserveWei"] as const;
const POSTGRES_KEYS = ["migrationVersion"] as const;
const PROVIDER_KEYS = ["x402Enabled", "x402Authorizer", "ogEnabled", "ogPayerAccountId", "ogBalanceWireFixtureSha256", "minUsdcAtomic", "minOgNeuron"] as const;

export type OgSecretVersionRefV1 = Readonly<{ secretArn: string; versionId: string }>;
export type RpcPairV1<D extends 15 | 20> = Readonly<{
  origins: readonly [string, string];
  finalityDepth: D;
}>;
export type FeedV1 = Readonly<{ proxy: Address; description: string; decimals: number }>;

export type EcsCredentialV2 = Readonly<{ kind: "ecs-task-role-v1" }>;
export type RolesAnywhereCredentialV2 = Readonly<{
  kind: "roles-anywhere-x509-v1";
  trustAnchorArn: string;
  profileArn: string;
  certificateSha256: string;
  certificateSubjectCn: string;
  certificateIssuerCn: string;
  helperVersion: "1.8.4";
  helperBytes: "12094568";
  helperSha256: "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9";
}>;
export type BillingAwsCredentialV2 = EcsCredentialV2 | RolesAnywhereCredentialV2;

export type BillingProductionManifestV2 = Readonly<{
  schema: typeof BILLING_PRODUCTION_MANIFEST_SCHEMA;
  buildCommit: string;
  sourceSha256: string;
  lockSha256: string;
  bundleSha256: string;
  aws: Readonly<{
    region: string;
    accountId: string;
    runtimeRoleArn: string;
    credential: BillingAwsCredentialV2;
    ticketKeyId: string;
    ticketKeyArn: string;
    x402KeyArn: string;
    ogInference: OgSecretVersionRefV1;
    ogManagement: OgSecretVersionRefV1;
  }>;
  collector: Readonly<{
    address: Address;
    treasury: Address;
    deployer: Address;
    nonce: string;
    deploymentTxHash: `0x${string}`;
    deploymentBlock: string;
    deploymentBlockHash: `0x${string}`;
    runtimeCodehash: `0x${string}`;
    attestationSha256: string;
  }>;
  networks: Readonly<{
    execution: "mainnet";
    chainId: 56;
    bsc: RpcPairV1<15>;
    base: RpcPairV1<20>;
    arbitrum: RpcPairV1<20>;
    baseUsdc: Readonly<{ address: Address; decimals: 6 }>;
  }>;
  oracles: Readonly<{
    bnbUsd: FeedV1;
    ogUsd: FeedV1;
    arbitrumSequencer: FeedV1;
    maxAgeSec: "90000";
    maxSkewSec: "90000";
    graceSec: "3600";
  }>;
  caps: Readonly<{
    platformUsdcAtomic: string;
    platformOgNeuron: string;
    minBaseGasReserveWei: string;
  }>;
  postgres: Readonly<{ migrationVersion: typeof BILLING_PRODUCTION_MIGRATION }>;
  providers: Readonly<{
    x402Enabled: boolean;
    x402Authorizer: Address;
    ogEnabled: boolean;
    ogPayerAccountId: string;
    ogBalanceWireFixtureSha256: string | null;
    minUsdcAtomic: string;
    minOgNeuron: string;
  }>;
}>;

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(row);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} members are missing, unknown, or reordered.`);
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function ascii(value: unknown, field: string, min: number, max: number): string {
  const candidate = string(value, field);
  if (candidate.length < min || candidate.length > max || !PRINTABLE_ASCII.test(candidate) || candidate.trim() !== candidate) {
    throw new Error(`${field} must be bounded printable ASCII without edge whitespace.`);
  }
  return candidate;
}

function sha256(value: unknown, field: string): string {
  const candidate = string(value, field);
  if (!HASH.test(candidate)) throw new Error(`${field} must be lowercase SHA-256 hex.`);
  return candidate;
}

function hex32(value: unknown, field: string): `0x${string}` {
  const candidate = string(value, field);
  if (!HEX32.test(candidate)) throw new Error(`${field} must be lowercase bytes32 hex.`);
  return candidate as `0x${string}`;
}

function address(value: unknown, field: string): Address {
  const candidate = string(value, field);
  if (candidate !== candidate.toLowerCase() || !isAddress(candidate, { strict: false })) {
    throw new Error(`${field} must be a lowercase EVM address.`);
  }
  const normalized = getAddress(candidate).toLowerCase() as Address;
  if (normalized === zeroAddress) throw new Error(`${field} must not be zero.`);
  return normalized;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function literalNumber<T extends number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`${field} must be ${expected}.`);
  return expected;
}

function decimal(value: unknown, field: string, min: bigint, max: bigint): string {
  const candidate = string(value, field);
  if (!DECIMAL.test(candidate)) throw new Error(`${field} must be a canonical decimal string.`);
  const parsed = BigInt(candidate);
  if (parsed < min || parsed > max) throw new Error(`${field} is outside its reviewed bound.`);
  return candidate;
}

function httpsOrigin(value: unknown, field: string): string {
  const candidate = string(value, field);
  let parsed: URL;
  try { parsed = new URL(candidate); }
  catch { throw new Error(`${field} must be a canonical HTTPS origin.`); }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
    parsed.port !== "" || parsed.pathname !== "/" || parsed.search !== "" ||
    parsed.hash !== "" || parsed.origin !== candidate
  ) throw new Error(`${field} must be a canonical credential-free HTTPS origin.`);
  return candidate;
}

function secretRef(value: unknown, field: string, region: string, accountId: string): OgSecretVersionRefV1 {
  const row = object(value, field);
  exactKeys(row, SECRET_KEYS, field);
  const secretArn = ascii(row["secretArn"], `${field}.secretArn`, 20, 2_048);
  const prefix = `arn:aws:secretsmanager:${region}:${accountId}:secret:`;
  if (!secretArn.startsWith(prefix) || secretArn.length === prefix.length) {
    throw new Error(`${field}.secretArn must belong to the manifest AWS identity.`);
  }
  const versionId = string(row["versionId"], `${field}.versionId`);
  if (!VERSION_ID.test(versionId)) throw new Error(`${field}.versionId is malformed.`);
  return Object.freeze({ secretArn, versionId });
}

function kmsArn(value: unknown, field: string, region: string, accountId: string): string {
  const candidate = ascii(value, field, 20, 2_048);
  const prefix = `arn:aws:kms:${region}:${accountId}:key/`;
  if (!candidate.startsWith(prefix) || candidate.length === prefix.length) {
    throw new Error(`${field} must be a KMS key ARN for the manifest AWS identity.`);
  }
  return candidate;
}

function runtimeRoleArn(value: unknown, accountId: string): string {
  const candidate = ascii(value, "manifest.aws.runtimeRoleArn", 20, 2_048);
  const prefix = `arn:aws:iam::${accountId}:role/`;
  if (!candidate.startsWith(prefix) || candidate.length === prefix.length || candidate.endsWith("/")) {
    throw new Error("manifest.aws.runtimeRoleArn must be an IAM role in the manifest account.");
  }
  return candidate;
}

function rolesAnywhereArn(value: unknown, field: string, region: string, accountId: string,
  resource: "trust-anchor" | "profile"): string {
  const candidate = ascii(value, field, 20, 2_048);
  const prefix = `arn:aws:rolesanywhere:${region}:${accountId}:${resource}/`;
  const id = candidate.startsWith(prefix) ? candidate.slice(prefix.length) : "";
  if (!/^[A-Za-z0-9-]{1,64}$/u.test(id)) {
    throw new Error(`${field} must be a closed Roles Anywhere ARN for the manifest AWS identity.`);
  }
  return candidate;
}

function credential(value: unknown, region: string, accountId: string): BillingAwsCredentialV2 {
  const row = object(value, "manifest.aws.credential");
  if (row["kind"] === "ecs-task-role-v1") {
    exactKeys(row, ECS_CREDENTIAL_KEYS, "manifest.aws.credential");
    return Object.freeze({ kind: "ecs-task-role-v1" as const });
  }
  if (row["kind"] !== "roles-anywhere-x509-v1") {
    throw new Error("manifest.aws.credential kind is unsupported.");
  }
  exactKeys(row, ROLES_ANYWHERE_CREDENTIAL_KEYS, "manifest.aws.credential");
  const trustAnchorArn = rolesAnywhereArn(row["trustAnchorArn"],
    "manifest.aws.credential.trustAnchorArn", region, accountId, "trust-anchor");
  const profileArn = rolesAnywhereArn(row["profileArn"],
    "manifest.aws.credential.profileArn", region, accountId, "profile");
  const certificateSha256 = sha256(row["certificateSha256"],
    "manifest.aws.credential.certificateSha256");
  const certificateSubjectCn = ascii(row["certificateSubjectCn"],
    "manifest.aws.credential.certificateSubjectCn", 1, 61);
  const certificateIssuerCn = ascii(row["certificateIssuerCn"],
    "manifest.aws.credential.certificateIssuerCn", 1, 61);
  if (certificateSubjectCn === certificateIssuerCn || certificateSubjectCn.includes("*") ||
      certificateIssuerCn.includes("*")) {
    throw new Error("Roles Anywhere certificate subject and issuer CN must differ.");
  }
  if (row["helperVersion"] !== "1.8.4" || row["helperBytes"] !== "12094568" ||
      row["helperSha256"] !== "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9") {
    throw new Error("Roles Anywhere helper identity drifted.");
  }
  return Object.freeze({ kind: "roles-anywhere-x509-v1" as const, trustAnchorArn, profileArn,
    certificateSha256, certificateSubjectCn, certificateIssuerCn, helperVersion: "1.8.4" as const,
    helperBytes: "12094568" as const,
    helperSha256: "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9" as const });
}

function rpcPair<D extends 15 | 20>(value: unknown, field: string, depth: D): RpcPairV1<D> {
  const row = object(value, field);
  exactKeys(row, RPC_KEYS, field);
  const origins = row["origins"];
  if (!Array.isArray(origins) || origins.length !== 2) throw new Error(`${field}.origins must contain exactly two origins.`);
  const first = httpsOrigin(origins[0], `${field}.origins[0]`);
  const second = httpsOrigin(origins[1], `${field}.origins[1]`);
  if (first === second) throw new Error(`${field}.origins must be distinct.`);
  literalNumber(row["finalityDepth"], depth, `${field}.finalityDepth`);
  return Object.freeze({ origins: Object.freeze([first, second]) as readonly [string, string], finalityDepth: depth });
}

function feed(value: unknown, field: string, expected: Readonly<{ proxy: string; description: string; decimals: number }>): FeedV1 {
  const row = object(value, field);
  exactKeys(row, FEED_KEYS, field);
  const proxy = address(row["proxy"], `${field}.proxy`);
  const description = ascii(row["description"], `${field}.description`, 1, 128);
  const decimals = row["decimals"];
  if (proxy !== expected.proxy || description !== expected.description || decimals !== expected.decimals) {
    throw new Error(`${field} does not match the reviewed oracle identity.`);
  }
  return Object.freeze({ proxy, description, decimals: expected.decimals });
}

function collectorAttestationPreimage(collector: BillingProductionManifestV2["collector"]): string {
  return JSON.stringify({
    schema: "4lpha.billing-collector-attestation.v1",
    chainId: 56,
    address: collector.address,
    treasury: collector.treasury,
    deployer: collector.deployer,
    nonce: collector.nonce,
    deploymentTxHash: collector.deploymentTxHash,
    deploymentBlock: collector.deploymentBlock,
    deploymentBlockHash: collector.deploymentBlockHash,
    runtimeCodehash: collector.runtimeCodehash,
  });
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateManifest(value: unknown): BillingProductionManifestV2 {
  const root = object(value, "manifest");
  exactKeys(root, TOP_KEYS, "manifest");
  if (root["schema"] !== BILLING_PRODUCTION_MANIFEST_SCHEMA) throw new Error("manifest.schema is unsupported.");
  const buildCommit = string(root["buildCommit"], "manifest.buildCommit");
  if (!COMMIT.test(buildCommit)) throw new Error("manifest.buildCommit must be 40 lowercase git hex.");
  const sourceSha256 = sha256(root["sourceSha256"], "manifest.sourceSha256");
  const lockSha256 = sha256(root["lockSha256"], "manifest.lockSha256");
  const bundleSha256 = sha256(root["bundleSha256"], "manifest.bundleSha256");

  const awsRow = object(root["aws"], "manifest.aws");
  exactKeys(awsRow, AWS_KEYS, "manifest.aws");
  const region = string(awsRow["region"], "manifest.aws.region");
  if (!AWS_REGION.test(region) || region.length > 64) throw new Error("manifest.aws.region is malformed.");
  const accountId = string(awsRow["accountId"], "manifest.aws.accountId");
  if (!/^[0-9]{12}$/u.test(accountId)) throw new Error("manifest.aws.accountId must contain 12 digits.");
  const roleArn = runtimeRoleArn(awsRow["runtimeRoleArn"], accountId);
  const awsCredential = credential(awsRow["credential"], region, accountId);
  const ticketKeyId = ascii(awsRow["ticketKeyId"], "manifest.aws.ticketKeyId", 1, 64);
  const ticketKeyArn = kmsArn(awsRow["ticketKeyArn"], "manifest.aws.ticketKeyArn", region, accountId);
  const x402KeyArn = kmsArn(awsRow["x402KeyArn"], "manifest.aws.x402KeyArn", region, accountId);
  if (ticketKeyArn === x402KeyArn) throw new Error("Ticket and x402 KMS roles must be distinct.");
  const ogInference = secretRef(awsRow["ogInference"], "manifest.aws.ogInference", region, accountId);
  const ogManagement = secretRef(awsRow["ogManagement"], "manifest.aws.ogManagement", region, accountId);
  if (ogInference.secretArn === ogManagement.secretArn && ogInference.versionId === ogManagement.versionId) {
    throw new Error("0G secret versions must be distinct.");
  }
  const aws = Object.freeze({ region, accountId, runtimeRoleArn: roleArn, credential: awsCredential,
    ticketKeyId, ticketKeyArn, x402KeyArn, ogInference, ogManagement });

  const collectorRow = object(root["collector"], "manifest.collector");
  exactKeys(collectorRow, COLLECTOR_KEYS, "manifest.collector");
  const collector = Object.freeze({
    address: address(collectorRow["address"], "manifest.collector.address"),
    treasury: address(collectorRow["treasury"], "manifest.collector.treasury"),
    deployer: address(collectorRow["deployer"], "manifest.collector.deployer"),
    nonce: decimal(collectorRow["nonce"], "manifest.collector.nonce", 0n, U64_MAX),
    deploymentTxHash: hex32(collectorRow["deploymentTxHash"], "manifest.collector.deploymentTxHash"),
    deploymentBlock: decimal(collectorRow["deploymentBlock"], "manifest.collector.deploymentBlock", 1n, U64_MAX),
    deploymentBlockHash: hex32(collectorRow["deploymentBlockHash"], "manifest.collector.deploymentBlockHash"),
    runtimeCodehash: hex32(collectorRow["runtimeCodehash"], "manifest.collector.runtimeCodehash"),
    attestationSha256: sha256(collectorRow["attestationSha256"], "manifest.collector.attestationSha256"),
  });
  if (hashText(collectorAttestationPreimage(collector)) !== collector.attestationSha256) {
    throw new Error("manifest.collector.attestationSha256 does not bind the collector evidence.");
  }
  const predictedCollector = getContractAddress({ from: collector.deployer, nonce: BigInt(collector.nonce) }).toLowerCase();
  if (collector.address !== predictedCollector) throw new Error("manifest.collector.address does not match deployer and nonce.");

  const networkRow = object(root["networks"], "manifest.networks");
  exactKeys(networkRow, NETWORK_KEYS, "manifest.networks");
  if (networkRow["execution"] !== "mainnet") throw new Error("manifest.networks.execution must be mainnet.");
  literalNumber(networkRow["chainId"], 56, "manifest.networks.chainId");
  const bsc = rpcPair(networkRow["bsc"], "manifest.networks.bsc", 15);
  const base = rpcPair(networkRow["base"], "manifest.networks.base", 20);
  const arbitrum = rpcPair(networkRow["arbitrum"], "manifest.networks.arbitrum", 20);
  const allOrigins = [...bsc.origins, ...base.origins, ...arbitrum.origins];
  if (new Set(allOrigins).size !== allOrigins.length) throw new Error("RPC origins must be pairwise distinct.");
  const usdcRow = object(networkRow["baseUsdc"], "manifest.networks.baseUsdc");
  exactKeys(usdcRow, USDC_KEYS, "manifest.networks.baseUsdc");
  const usdcAddress = address(usdcRow["address"], "manifest.networks.baseUsdc.address");
  if (usdcAddress !== BASE_USDC || usdcRow["decimals"] !== 6) throw new Error("Base USDC identity drifted.");
  const networks = Object.freeze({ execution: "mainnet" as const, chainId: 56 as const, bsc, base, arbitrum, baseUsdc: Object.freeze({ address: usdcAddress, decimals: 6 as const }) });

  const oracleRow = object(root["oracles"], "manifest.oracles");
  exactKeys(oracleRow, ORACLE_KEYS, "manifest.oracles");
  const bnbUsd = feed(oracleRow["bnbUsd"], "manifest.oracles.bnbUsd", {
    proxy: "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee", description: "BNB / USD", decimals: 8,
  });
  const ogUsd = feed(oracleRow["ogUsd"], "manifest.oracles.ogUsd", {
    proxy: "0x47c38c695639ae97a00f57d6d9f5ece1debb033c", description: "0G / USD", decimals: 8,
  });
  const arbitrumSequencer = feed(oracleRow["arbitrumSequencer"], "manifest.oracles.arbitrumSequencer", {
    proxy: "0xfdb631f5ee196f0ed6faa767959853a9f217697d", description: "L2 Sequencer Uptime Status Feed", decimals: 0,
  });
  if (oracleRow["maxAgeSec"] !== "90000" || oracleRow["maxSkewSec"] !== "90000" || oracleRow["graceSec"] !== "3600") {
    throw new Error("Oracle time bounds drifted from Phase 5 Revision 7.");
  }
  const oracles = Object.freeze({ bnbUsd, ogUsd, arbitrumSequencer, maxAgeSec: "90000" as const, maxSkewSec: "90000" as const, graceSec: "3600" as const });

  const capRow = object(root["caps"], "manifest.caps");
  exactKeys(capRow, CAP_KEYS, "manifest.caps");
  const platformUsdcAtomic = decimal(capRow["platformUsdcAtomic"], "manifest.caps.platformUsdcAtomic", 1n, MAX_PLATFORM_USDC_ATOMIC);
  const platformOgNeuron = decimal(capRow["platformOgNeuron"], "manifest.caps.platformOgNeuron", 1n, MAX_PLATFORM_OG_NEURON);
  const minBaseGasReserveWei = decimal(capRow["minBaseGasReserveWei"], "manifest.caps.minBaseGasReserveWei", 1n, MAX_BASE_GAS_RESERVE_WEI);
  const caps = Object.freeze({ platformUsdcAtomic, platformOgNeuron, minBaseGasReserveWei });

  const postgresRow = object(root["postgres"], "manifest.postgres");
  exactKeys(postgresRow, POSTGRES_KEYS, "manifest.postgres");
  if (postgresRow["migrationVersion"] !== BILLING_PRODUCTION_MIGRATION) throw new Error("PostgreSQL migration version drifted.");
  const postgres = Object.freeze({ migrationVersion: BILLING_PRODUCTION_MIGRATION });

  const providerRow = object(root["providers"], "manifest.providers");
  exactKeys(providerRow, PROVIDER_KEYS, "manifest.providers");
  const x402Enabled = boolean(providerRow["x402Enabled"], "manifest.providers.x402Enabled");
  const x402Authorizer = address(providerRow["x402Authorizer"], "manifest.providers.x402Authorizer");
  const ogEnabled = boolean(providerRow["ogEnabled"], "manifest.providers.ogEnabled");
  if (!x402Enabled && !ogEnabled) throw new Error("At least one paid provider must be enabled in an ON manifest.");
  const ogPayerAccountId = ascii(providerRow["ogPayerAccountId"], "manifest.providers.ogPayerAccountId", 1, 256);
  const fixtureValue = providerRow["ogBalanceWireFixtureSha256"];
  const ogBalanceWireFixtureSha256 = fixtureValue === null ? null : sha256(fixtureValue, "manifest.providers.ogBalanceWireFixtureSha256");
  if (ogEnabled !== (ogBalanceWireFixtureSha256 !== null)) {
    throw new Error("0G enablement must match its reviewed balance-wire fixture commitment.");
  }
  if (ogEnabled) {
    throw new Error("0G monetary balance wire is not reviewed in this build.");
  }
  const minUsdcAtomic = decimal(providerRow["minUsdcAtomic"], "manifest.providers.minUsdcAtomic", 1n, MAX_PLATFORM_USDC_ATOMIC);
  const minOgNeuron = decimal(providerRow["minOgNeuron"], "manifest.providers.minOgNeuron", 1n, MAX_PLATFORM_OG_NEURON);
  if (BigInt(minUsdcAtomic) > BigInt(platformUsdcAtomic) || BigInt(minOgNeuron) > BigInt(platformOgNeuron)) {
    throw new Error("Provider funded minimum exceeds its same-asset platform cap.");
  }
  const providers = Object.freeze({ x402Enabled, x402Authorizer, ogEnabled, ogPayerAccountId, ogBalanceWireFixtureSha256, minUsdcAtomic, minOgNeuron });

  const roles = [collector.address, collector.treasury, collector.deployer, providers.x402Authorizer, ALTANA_KEYSTORE];
  if (new Set(roles).size !== roles.length) throw new Error("Billing production roles must be pairwise distinct.");

  return Object.freeze({
    schema: BILLING_PRODUCTION_MANIFEST_SCHEMA,
    buildCommit,
    sourceSha256,
    lockSha256,
    bundleSha256,
    aws,
    collector,
    networks,
    oracles,
    caps,
    postgres,
    providers,
  });
}

/** Validate a value and serialize the one accepted ordered JSON representation. */
export function canonicalProductionManifest(value: unknown): string {
  return JSON.stringify(validateManifest(value));
}

/** Parse exact canonical UTF-8 bytes; whitespace, BOM, duplicate/reordered members and drift refuse. */
export function parseProductionManifest(input: Uint8Array): BillingProductionManifestV2 {
  if (input.byteLength === 0 || input.byteLength > MAX_MANIFEST_BYTES) throw new Error("Production manifest byte length is invalid.");
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) throw new Error("Production manifest must not contain a BOM.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); }
  catch { throw new Error("Production manifest must be valid UTF-8."); }
  let decoded: unknown;
  try { decoded = JSON.parse(text) as unknown; }
  catch { throw new Error("Production manifest must be valid JSON."); }
  const manifest = validateManifest(decoded);
  if (JSON.stringify(manifest) !== text) throw new Error("Production manifest bytes are not canonical.");
  return manifest;
}

export function productionManifestSha256(input: Uint8Array): string {
  parseProductionManifest(input);
  return createHash("sha256").update(input).digest("hex");
}
