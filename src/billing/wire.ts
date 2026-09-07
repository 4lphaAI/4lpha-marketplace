import { paidCanonicalJsonV1 } from "./canonical.js";
import type { OgMessage } from "./models.js";
import type { PaidOperation, PaidServiceAssertionV1, PaidServiceSessionTicketV1 } from "./types.js";
import type { CmcQuoteQuery } from "./x402Registry.js";

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], field: string): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${field} has missing or unknown fields.`);
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${field} must be a nonempty string.`);
  return value;
}

function uint(value: unknown, field: string): bigint {
  const candidate = string(value, field);
  if (!/^(0|[1-9][0-9]{0,77})$/.test(candidate)) throw new Error(`${field} must be a canonical unsigned decimal string.`);
  return BigInt(candidate);
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a nonnegative integer.`);
  return value;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry, index) => string(entry, `${field}[${index}]`));
}

function operations(value: unknown): readonly PaidOperation[] {
  const values = strings(value, "operations");
  if (values.some((entry) => entry !== "paid.0g.chat" && entry !== "paid.cmc.quote")) throw new Error("Unknown paid operation.");
  return values as readonly PaidOperation[];
}

export function parsePaidTicket(value: unknown): PaidServiceSessionTicketV1 {
  const row = record(value, "sessionTicket");
  keys(row, ["domain", "ticketId", "accountId", "agentId", "ownerAddress", "walletAddress", "grantId", "generation", "operations", "templateIds", "maxSessionUsdMicros", "ownerActionParamsHash", "issuedAt", "expiresAt", "executionTicketKeyId", "signature"], ["allowedModelIds", "maxTokensPerInference"], "sessionTicket");
  if (row["domain"] !== "4lpha.paid-service-ticket.v1") throw new Error("Invalid sessionTicket domain.");
  const ticket: PaidServiceSessionTicketV1 = {
    domain: "4lpha.paid-service-ticket.v1",
    ticketId: string(row["ticketId"], "ticketId"),
    accountId: string(row["accountId"], "accountId"),
    agentId: string(row["agentId"], "agentId"),
    ownerAddress: string(row["ownerAddress"], "ownerAddress"),
    walletAddress: string(row["walletAddress"], "walletAddress"),
    grantId: string(row["grantId"], "grantId"),
    generation: uint(row["generation"], "generation"),
    operations: operations(row["operations"]),
    templateIds: strings(row["templateIds"], "templateIds"),
    ...(row["allowedModelIds"] === undefined ? {} : { allowedModelIds: strings(row["allowedModelIds"], "allowedModelIds") }),
    ...(row["maxTokensPerInference"] === undefined ? {} : { maxTokensPerInference: integer(row["maxTokensPerInference"], "maxTokensPerInference") }),
    maxSessionUsdMicros: uint(row["maxSessionUsdMicros"], "maxSessionUsdMicros"),
    ownerActionParamsHash: string(row["ownerActionParamsHash"], "ownerActionParamsHash"),
    issuedAt: integer(row["issuedAt"], "issuedAt"),
    expiresAt: integer(row["expiresAt"], "expiresAt"),
    executionTicketKeyId: string(row["executionTicketKeyId"], "executionTicketKeyId"),
    signature: string(row["signature"], "signature"),
  };
  paidCanonicalJsonV1(ticket);
  return ticket;
}

export function parsePaidAssertion(value: unknown): PaidServiceAssertionV1 {
  const row = record(value, "assertion");
  keys(row, ["domain", "issuerKeyId", "grantId", "generation", "accountId", "agentId", "ownerAddress", "walletAddress", "operation", "templateId", "logicalRequestId", "requestDigest", "sessionTicketHash", "nonce", "issuedAt", "expiresAt", "signature"], ["maxTokens"], "assertion");
  if (row["domain"] !== "4lpha.paid-service.v1") throw new Error("Invalid assertion domain.");
  const operation = string(row["operation"], "operation");
  if (operation !== "paid.0g.chat" && operation !== "paid.cmc.quote") throw new Error("Unknown paid operation.");
  const assertion: PaidServiceAssertionV1 = {
    domain: "4lpha.paid-service.v1",
    issuerKeyId: string(row["issuerKeyId"], "issuerKeyId"),
    grantId: string(row["grantId"], "grantId"),
    generation: uint(row["generation"], "generation"),
    accountId: string(row["accountId"], "accountId"),
    agentId: string(row["agentId"], "agentId"),
    ownerAddress: string(row["ownerAddress"], "ownerAddress"),
    walletAddress: string(row["walletAddress"], "walletAddress"),
    operation,
    templateId: string(row["templateId"], "templateId"),
    logicalRequestId: string(row["logicalRequestId"], "logicalRequestId"),
    requestDigest: string(row["requestDigest"], "requestDigest"),
    sessionTicketHash: string(row["sessionTicketHash"], "sessionTicketHash"),
    ...(row["maxTokens"] === undefined ? {} : { maxTokens: integer(row["maxTokens"], "maxTokens") }),
    nonce: string(row["nonce"], "nonce"),
    issuedAt: integer(row["issuedAt"], "issuedAt"),
    expiresAt: integer(row["expiresAt"], "expiresAt"),
    signature: string(row["signature"], "signature"),
  };
  paidCanonicalJsonV1(assertion);
  return assertion;
}

export type InternalOgBody = Readonly<{
  assertion: PaidServiceAssertionV1;
  sessionTicket: PaidServiceSessionTicketV1;
  model: string;
  maxTokens: number;
  messages: readonly OgMessage[];
  stream: true;
}>;

export function parseInternalOgBody(value: unknown): InternalOgBody {
  const row = record(value, "body");
  keys(row, ["assertion", "sessionTicket", "model", "maxTokens", "messages", "stream"], [], "body");
  if (row["stream"] !== true) throw new Error("stream must be true.");
  const rawMessages = row["messages"];
  if (!Array.isArray(rawMessages)) throw new Error("messages must be an array.");
  const messages = rawMessages.map((raw, index): OgMessage => {
    const message = record(raw, `messages[${index}]`);
    keys(message, ["role", "content"], [], `messages[${index}]`);
    const role = string(message["role"], `messages[${index}].role`);
    if (role !== "system" && role !== "user" && role !== "assistant") throw new Error("Unsupported message role.");
    return { role, content: string(message["content"], `messages[${index}].content`) };
  });
  return {
    assertion: parsePaidAssertion(row["assertion"]),
    sessionTicket: parsePaidTicket(row["sessionTicket"]),
    model: string(row["model"], "model"),
    maxTokens: integer(row["maxTokens"], "maxTokens"),
    messages,
    stream: true,
  };
}

export type InternalCmcBody = Readonly<{
  assertion: PaidServiceAssertionV1;
  sessionTicket: PaidServiceSessionTicketV1;
  query: CmcQuoteQuery;
}>;

export function parseInternalCmcBody(value: unknown): InternalCmcBody {
  const row = record(value, "body");
  keys(row, ["assertion", "sessionTicket", "id"], ["convert", "aux"], "body");
  return {
    assertion: parsePaidAssertion(row["assertion"]),
    sessionTicket: parsePaidTicket(row["sessionTicket"]),
    query: {
      id: string(row["id"], "id"),
      ...(row["convert"] === undefined ? {} : { convert: string(row["convert"], "convert") }),
      ...(row["aux"] === undefined ? {} : { aux: string(row["aux"], "aux") }),
    },
  };
}
