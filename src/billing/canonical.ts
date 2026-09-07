import {
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { getAddress, isAddress, isHex, keccak256, stringToBytes, type Hex } from "viem";
import type {
  PaidOperation,
  PaidRequestProjection,
  PaidServiceAssertionV1,
  PaidServiceSessionTicketV1,
} from "./types.js";

const TICKET_DOMAIN = "4lpha.paid-service-ticket.v1";
const ASSERTION_DOMAIN = "4lpha.paid-service.v1";
const USAGE_DOMAIN = "4lpha.paid-usage.v1";
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function canonicalAddress(value: string, field: string): string {
  if (!isAddress(value, { strict: false })) throw new Error(`${field} must be an EVM address.`);
  return getAddress(value).toLowerCase();
}

function canonicalHash(value: string, field: string): string {
  if (!isHex(value, { strict: true }) || value.length !== 66) throw new Error(`${field} must be 32 bytes.`);
  return value.toLowerCase();
}

function ascii(value: string, field: string, max = 256): string {
  if (value.length < 1 || value.length > max || !PRINTABLE_ASCII.test(value)) {
    throw new Error(`${field} must be printable ASCII.`);
  }
  return value;
}

function integer(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a nonnegative integer.`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer.`);
  return value;
}

function sortedUnique(values: readonly string[], field: string): readonly string[] {
  if (values.length === 0) throw new Error(`${field} must be nonempty.`);
  const checked = values.map((entry) => ascii(entry, field));
  const sorted = [...checked].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((entry, index) => entry !== checked[index])) {
    throw new Error(`${field} must be ASCII-sorted and unique.`);
  }
  return sorted;
}

function base64urlBytes(value: string, field: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(value) || value.includes("=")) throw new Error(`${field} must be unpadded base64url.`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error(`${field} is not canonical base64url.`);
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new Error(`${field} must decode to ${expectedBytes} bytes.`);
  }
  return bytes;
}

function ticketObject(ticket: PaidServiceSessionTicketV1, signature: boolean): Record<string, unknown> {
  if (ticket.domain !== TICKET_DOMAIN) throw new Error("Invalid paid-service ticket domain.");
  const operations = sortedUnique(ticket.operations, "operations") as readonly PaidOperation[];
  const templateIds = sortedUnique(ticket.templateIds, "templateIds");
  const hasChat = operations.includes("paid.0g.chat");
  if (hasChat !== (ticket.allowedModelIds !== undefined) || hasChat !== (ticket.maxTokensPerInference !== undefined)) {
    throw new Error("Chat ticket fields must be present iff paid.0g.chat is granted.");
  }
  const object: Record<string, unknown> = {
    domain: ticket.domain,
    ticketId: ascii(ticket.ticketId, "ticketId"),
    accountId: ascii(ticket.accountId, "accountId"),
    agentId: ascii(ticket.agentId, "agentId"),
    ownerAddress: canonicalAddress(ticket.ownerAddress, "ownerAddress"),
    walletAddress: canonicalAddress(ticket.walletAddress, "walletAddress"),
    grantId: ascii(ticket.grantId, "grantId"),
    generation: ticket.generation.toString(),
    operations,
    templateIds,
  };
  if (ticket.allowedModelIds !== undefined) object["allowedModelIds"] = sortedUnique(ticket.allowedModelIds, "allowedModelIds");
  if (ticket.maxTokensPerInference !== undefined) {
    object["maxTokensPerInference"] = positiveInteger(ticket.maxTokensPerInference, "maxTokensPerInference");
  }
  object["maxSessionUsdMicros"] = ticket.maxSessionUsdMicros.toString();
  object["ownerActionParamsHash"] = canonicalHash(ticket.ownerActionParamsHash, "ownerActionParamsHash");
  object["issuedAt"] = integer(ticket.issuedAt, "issuedAt");
  object["expiresAt"] = integer(ticket.expiresAt, "expiresAt");
  object["executionTicketKeyId"] = ascii(ticket.executionTicketKeyId, "executionTicketKeyId");
  if (signature) {
    base64urlBytes(ticket.signature, "ticket signature", 64);
    object["signature"] = ticket.signature;
  }
  return object;
}

function assertionObject(assertion: PaidServiceAssertionV1, signature: boolean): Record<string, unknown> {
  if (assertion.domain !== ASSERTION_DOMAIN) throw new Error("Invalid paid-service assertion domain.");
  const object: Record<string, unknown> = {
    domain: assertion.domain,
    issuerKeyId: ascii(assertion.issuerKeyId, "issuerKeyId"),
    grantId: ascii(assertion.grantId, "grantId"),
    generation: assertion.generation.toString(),
    accountId: ascii(assertion.accountId, "accountId"),
    agentId: ascii(assertion.agentId, "agentId"),
    ownerAddress: canonicalAddress(assertion.ownerAddress, "ownerAddress"),
    walletAddress: canonicalAddress(assertion.walletAddress, "walletAddress"),
    operation: assertion.operation,
    templateId: ascii(assertion.templateId, "templateId"),
    logicalRequestId: ascii(assertion.logicalRequestId, "logicalRequestId", 128),
    requestDigest: canonicalHash(assertion.requestDigest, "requestDigest"),
    sessionTicketHash: canonicalHash(assertion.sessionTicketHash, "sessionTicketHash"),
  };
  if (assertion.maxTokens !== undefined) object["maxTokens"] = positiveInteger(assertion.maxTokens, "maxTokens");
  base64urlBytes(assertion.nonce, "assertion nonce");
  if (Buffer.from(assertion.nonce, "base64url").length < 16) throw new Error("assertion nonce must contain at least 128 bits.");
  object["nonce"] = assertion.nonce;
  object["issuedAt"] = integer(assertion.issuedAt, "issuedAt");
  object["expiresAt"] = integer(assertion.expiresAt, "expiresAt");
  if (signature) {
    base64urlBytes(assertion.signature, "assertion signature", 64);
    object["signature"] = assertion.signature;
  }
  return object;
}

export function paidCanonicalJsonV1(value: PaidServiceSessionTicketV1 | PaidServiceAssertionV1): string {
  return value.domain === TICKET_DOMAIN
    ? JSON.stringify(ticketObject(value, true))
    : JSON.stringify(assertionObject(value, true));
}

export function ticketSigningBytes(ticket: PaidServiceSessionTicketV1): Uint8Array {
  return Buffer.from(JSON.stringify(ticketObject(ticket, false)), "utf8");
}

export function assertionSigningBytes(assertion: PaidServiceAssertionV1): Uint8Array {
  return Buffer.from(JSON.stringify(assertionObject(assertion, false)), "utf8");
}

export function sessionTicketHash(ticket: PaidServiceSessionTicketV1): Hex {
  return keccak256(stringToBytes(JSON.stringify(ticketObject(ticket, true))));
}

export function canonicalPaidRequestProjection(projection: PaidRequestProjection): string {
  if (projection.method !== "GET" && projection.method !== "POST") throw new Error("Unsupported paid method.");
  if (!projection.fixedRoutePath.startsWith("/") || projection.fixedRoutePath.includes("?") || projection.fixedRoutePath.includes("#")) {
    throw new Error("fixedRoutePath must be a path without query or fragment.");
  }
  canonicalHash(projection.sessionTicketHash, "sessionTicketHash");
  return JSON.stringify({
    method: projection.method,
    fixedRoutePath: projection.fixedRoutePath,
    canonicalQuery: projection.canonicalQuery,
    businessPayload: projection.businessPayload,
    sessionTicketHash: projection.sessionTicketHash.toLowerCase(),
  });
}

export function paidRequestDigest(projection: PaidRequestProjection): Hex {
  return keccak256(stringToBytes(canonicalPaidRequestProjection(projection)));
}

export function paidUsageId(input: Readonly<{
  grantId: string;
  generation: bigint;
  operation: PaidOperation;
  logicalRequestId: string;
}>): Hex {
  const logicalRequestId = ascii(input.logicalRequestId, "logicalRequestId", 128);
  const unique = JSON.stringify({
    grantId: ascii(input.grantId, "grantId"),
    generation: input.generation.toString(),
    operation: input.operation,
    logicalRequestId,
  });
  return keccak256(Buffer.concat([Buffer.from(USAGE_DOMAIN, "utf8"), Buffer.from(unique, "utf8")]));
}

/** Ed25519 keys are canonical PKCS#8/SPKI DER encoded as unpadded base64url. */
export function signPaidBytes(privateKeyPkcs8Base64Url: string, bytes: Uint8Array): string {
  const key = createPrivateKey({
    key: base64urlBytes(privateKeyPkcs8Base64Url, "Ed25519 private key"),
    format: "der",
    type: "pkcs8",
  });
  const signature = nodeSign(null, bytes, key);
  if (signature.length !== 64) throw new Error("Ed25519 signer returned an invalid signature.");
  return signature.toString("base64url");
}

export function verifyPaidBytes(publicKeySpkiBase64Url: string, bytes: Uint8Array, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: base64urlBytes(publicKeySpkiBase64Url, "Ed25519 public key"),
      format: "der",
      type: "spki",
    });
    return nodeVerify(null, bytes, key, base64urlBytes(signature, "signature", 64));
  } catch {
    return false;
  }
}

export function verifyPaidTicket(
  ticket: PaidServiceSessionTicketV1,
  expectedKeyId: string,
  publicKeySpkiBase64Url: string,
  now: number,
): Hex {
  if (ticket.executionTicketKeyId !== expectedKeyId || ticket.issuedAt > now + 5 || ticket.expiresAt <= now) {
    throw new Error("runtime_auth_failed");
  }
  if (!verifyPaidBytes(publicKeySpkiBase64Url, ticketSigningBytes(ticket), ticket.signature)) {
    throw new Error("runtime_auth_failed");
  }
  return sessionTicketHash(ticket);
}

export function verifyPaidAssertion(
  assertion: PaidServiceAssertionV1,
  issuerPublicKeySpkiBase64Url: string,
  now: number,
): void {
  if (
    assertion.issuedAt > now + 5 ||
    assertion.expiresAt <= now - 5 ||
    assertion.expiresAt > assertion.issuedAt + 30 ||
    !verifyPaidBytes(issuerPublicKeySpkiBase64Url, assertionSigningBytes(assertion), assertion.signature)
  ) {
    throw new Error("runtime_auth_failed");
  }
}
