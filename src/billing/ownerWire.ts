import { getAddress, isAddress, isHex } from "viem";
import { OG_CHAT_MODELS } from "./models.js";
import type { PaidOperation, PaidServiceSessionParamsV1 } from "./types.js";

type Row = Record<string, unknown>;

function row(value: unknown, field: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Row;
}

function exactKeys(value: Row, required: readonly string[], optional: readonly string[], field: string): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${field} has missing or unknown fields.`);
  }
}

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !/^[\x20-\x7e]+$/.test(value)) {
    throw new Error(`${field} must be printable ASCII.`);
  }
  return value;
}

function address(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`${field} must be an address.`);
  return getAddress(value).toLowerCase();
}

function uint(value: unknown, field: string): bigint {
  const candidate = text(value, field, 78);
  if (!/^(0|[1-9][0-9]{0,77})$/.test(candidate)) throw new Error(`${field} must be a canonical uint string.`);
  return BigInt(candidate);
}

function positiveUint(value: unknown, field: string): bigint {
  const candidate = uint(value, field);
  if (candidate < 1n) throw new Error(`${field} must be positive.`);
  return candidate;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be an integer Unix second.`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const candidate = timestamp(value, field);
  if (candidate < 1) throw new Error(`${field} must be positive.`);
  return candidate;
}

function sortedStrings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error(`${field} must be a nonempty array.`);
  const entries = value.map((entry, index) => text(entry, `${field}[${index}]`));
  if (new Set(entries).size !== entries.length || entries.some((entry, index) => index > 0 && entries[index - 1]! >= entry)) {
    throw new Error(`${field} must be ASCII-sorted and unique.`);
  }
  return entries;
}

function operations(value: unknown): readonly PaidOperation[] {
  const entries = sortedStrings(value, "operations");
  if (entries.some((entry) => entry !== "paid.0g.chat" && entry !== "paid.cmc.quote")) {
    throw new Error("operations contains an unsupported paid operation.");
  }
  return entries as readonly PaidOperation[];
}

function issuerPublicKey(value: unknown): string {
  const candidate = text(value, "issuerPublicKey", 256);
  if (!/^[A-Za-z0-9_-]+$/.test(candidate) || candidate.includes("=")) throw new Error("issuerPublicKey must be canonical base64url.");
  const bytes = Buffer.from(candidate, "base64url");
  if (bytes.length !== 44 || bytes.toString("base64url") !== candidate) throw new Error("issuerPublicKey must be an Ed25519 SPKI key.");
  return candidate;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length !== 66) throw new Error(`${field} must be bytes32.`);
  return value.toLowerCase();
}

export type BillingGrantParams = Readonly<{
  ownerAddress: string;
  walletAddress: string;
  accountId: string;
  agentId: string;
  grantId: string;
  generation: bigint;
  issuerKeyId: string;
  issuerPublicKey: string;
  operations: readonly PaidOperation[];
  templateIds: readonly string[];
  maxAtomic0gPerInference: bigint;
  maxUsdMicrosPerRequest: bigint;
  maxRolling24hUsdMicros: bigint;
  maxTokensPerInference?: number;
  notBefore: number;
  expiresAt: number;
}>;

export function parseBillingGrantParams(value: unknown): BillingGrantParams {
  const input = row(value, "params");
  exactKeys(input, ["ownerAddress", "walletAddress", "accountId", "agentId", "grantId", "generation", "issuerKeyId", "issuerPublicKey", "operations", "templateIds", "maxAtomic0gPerInference", "maxUsdMicrosPerRequest", "maxRolling24hUsdMicros", "notBefore", "expiresAt"], ["maxTokensPerInference"], "params");
  const parsed: BillingGrantParams = {
    ownerAddress: address(input["ownerAddress"], "ownerAddress"),
    walletAddress: address(input["walletAddress"], "walletAddress"),
    accountId: text(input["accountId"], "accountId"),
    agentId: text(input["agentId"], "agentId", 128),
    grantId: text(input["grantId"], "grantId"),
    generation: positiveUint(input["generation"], "generation"),
    issuerKeyId: text(input["issuerKeyId"], "issuerKeyId"),
    issuerPublicKey: issuerPublicKey(input["issuerPublicKey"]),
    operations: operations(input["operations"]),
    templateIds: sortedStrings(input["templateIds"], "templateIds"),
    maxAtomic0gPerInference: positiveUint(input["maxAtomic0gPerInference"], "maxAtomic0gPerInference"),
    maxUsdMicrosPerRequest: positiveUint(input["maxUsdMicrosPerRequest"], "maxUsdMicrosPerRequest"),
    maxRolling24hUsdMicros: positiveUint(input["maxRolling24hUsdMicros"], "maxRolling24hUsdMicros"),
    ...(input["maxTokensPerInference"] === undefined ? {} : { maxTokensPerInference: positiveInteger(input["maxTokensPerInference"], "maxTokensPerInference") }),
    notBefore: timestamp(input["notBefore"], "notBefore"),
    expiresAt: timestamp(input["expiresAt"], "expiresAt"),
  };
  const hasChat = parsed.operations.includes("paid.0g.chat");
  if (hasChat !== (parsed.maxTokensPerInference !== undefined)) throw new Error("maxTokensPerInference is required iff chat is granted.");
  if (parsed.maxTokensPerInference !== undefined) {
    const largest = [...OG_CHAT_MODELS.values()].reduce((max, model) => model.maxCompletionTokens > max ? model.maxCompletionTokens : max, 0n);
    if (BigInt(parsed.maxTokensPerInference) > largest) throw new Error("maxTokensPerInference exceeds the reviewed catalog.");
  }
  if (parsed.notBefore >= parsed.expiresAt) throw new Error("Grant expiry must follow notBefore.");
  return parsed;
}

export type BillingRotateParams = Readonly<{
  ownerAddress: string;
  walletAddress: string;
  accountId: string;
  agentId: string;
  grantId: string;
  oldGeneration: bigint;
  nextGeneration: bigint;
  oldIssuerKeyId: string;
  newIssuerKeyId: string;
  newIssuerPublicKey: string;
  maxTokensPerInference?: number;
  notBefore: number;
  expiresAt: number;
}>;

export function parseBillingRotateParams(value: unknown): BillingRotateParams {
  const input = row(value, "params");
  exactKeys(input, ["ownerAddress", "walletAddress", "accountId", "agentId", "grantId", "oldGeneration", "nextGeneration", "oldIssuerKeyId", "newIssuerKeyId", "newIssuerPublicKey", "notBefore", "expiresAt"], ["maxTokensPerInference"], "params");
  const parsed: BillingRotateParams = {
    ownerAddress: address(input["ownerAddress"], "ownerAddress"),
    walletAddress: address(input["walletAddress"], "walletAddress"),
    accountId: text(input["accountId"], "accountId"),
    agentId: text(input["agentId"], "agentId", 128),
    grantId: text(input["grantId"], "grantId"),
    oldGeneration: positiveUint(input["oldGeneration"], "oldGeneration"),
    nextGeneration: positiveUint(input["nextGeneration"], "nextGeneration"),
    oldIssuerKeyId: text(input["oldIssuerKeyId"], "oldIssuerKeyId"),
    newIssuerKeyId: text(input["newIssuerKeyId"], "newIssuerKeyId"),
    newIssuerPublicKey: issuerPublicKey(input["newIssuerPublicKey"]),
    ...(input["maxTokensPerInference"] === undefined ? {} : { maxTokensPerInference: positiveInteger(input["maxTokensPerInference"], "maxTokensPerInference") }),
    notBefore: timestamp(input["notBefore"], "notBefore"),
    expiresAt: timestamp(input["expiresAt"], "expiresAt"),
  };
  if (parsed.nextGeneration !== parsed.oldGeneration + 1n || parsed.oldIssuerKeyId === parsed.newIssuerKeyId || parsed.notBefore >= parsed.expiresAt) {
    throw new Error("Issuer rotation generation, identity, or time window is invalid.");
  }
  return parsed;
}

export type BillingAccountActionParams = Readonly<{
  ownerAddress: string;
  walletAddress: string;
  accountId: string;
  agentId: string;
}>;

export function parseBillingAccountActionParams(value: unknown): BillingAccountActionParams {
  const input = row(value, "params");
  exactKeys(input, ["ownerAddress", "walletAddress", "accountId", "agentId"], [], "params");
  return {
    ownerAddress: address(input["ownerAddress"], "ownerAddress"),
    walletAddress: address(input["walletAddress"], "walletAddress"),
    accountId: text(input["accountId"], "accountId"),
    agentId: text(input["agentId"], "agentId", 128),
  };
}

export function parsePaidServiceSessionParams(value: unknown): PaidServiceSessionParamsV1 {
  const input = row(value, "params");
  exactKeys(input, ["ownerAddress", "walletAddress", "accountId", "agentId", "grantId", "generation", "operations", "templateIds", "maxSessionUsdMicros", "issuedAt", "expiresAt", "chainId"], ["allowedModelIds", "maxTokensPerInference"], "params");
  if (input["chainId"] !== 56) throw new Error("chainId must be 56.");
  const parsed: PaidServiceSessionParamsV1 = {
    ownerAddress: address(input["ownerAddress"], "ownerAddress"),
    walletAddress: address(input["walletAddress"], "walletAddress"),
    accountId: text(input["accountId"], "accountId"),
    agentId: text(input["agentId"], "agentId", 128),
    grantId: text(input["grantId"], "grantId"),
    generation: positiveUint(input["generation"], "generation"),
    operations: operations(input["operations"]),
    templateIds: sortedStrings(input["templateIds"], "templateIds"),
    ...(input["allowedModelIds"] === undefined ? {} : { allowedModelIds: sortedStrings(input["allowedModelIds"], "allowedModelIds") }),
    ...(input["maxTokensPerInference"] === undefined ? {} : { maxTokensPerInference: positiveInteger(input["maxTokensPerInference"], "maxTokensPerInference") }),
    maxSessionUsdMicros: positiveUint(input["maxSessionUsdMicros"], "maxSessionUsdMicros"),
    issuedAt: timestamp(input["issuedAt"], "issuedAt"),
    expiresAt: timestamp(input["expiresAt"], "expiresAt"),
    chainId: 56,
  };
  const hasChat = parsed.operations.includes("paid.0g.chat");
  if (hasChat !== (parsed.allowedModelIds !== undefined) || hasChat !== (parsed.maxTokensPerInference !== undefined)) {
    throw new Error("Chat service-session fields are required iff chat is enabled.");
  }
  if (parsed.allowedModelIds?.some((model) => !OG_CHAT_MODELS.has(model))) throw new Error("allowedModelIds contains an unreviewed model.");
  return parsed;
}

export function parseOwnerActionHash(value: unknown): string {
  return hash(value, "ownerActionParamsHash");
}
