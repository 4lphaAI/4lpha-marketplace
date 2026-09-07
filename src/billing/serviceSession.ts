import { keccak256, stringToBytes } from "viem";
import { signPaidBytes, ticketSigningBytes } from "./canonical.js";
import { OG_CHAT_MODELS } from "./models.js";
import type {
  AgentBillingGrant,
  BillingAccount,
  PaidOperation,
  PaidServiceSessionParamsV1,
  PaidServiceSessionTicketV1,
} from "./types.js";

function sortedSubset<T extends string>(child: readonly T[], parent: readonly T[], field: string): readonly T[] {
  if (child.length === 0 || new Set(child).size !== child.length || child.some((entry, index) => index > 0 && child[index - 1]! >= entry)) {
    throw new Error(`${field} must be nonempty, ASCII-sorted, and unique.`);
  }
  if (child.some((entry) => !parent.includes(entry))) throw new Error(`${field} exceeds the active grant.`);
  return child;
}

export function billingAccountId(ownerAddress: string, walletAddress: string): string {
  return keccak256(stringToBytes(JSON.stringify({
    domain: "4lpha.billing-account.v1",
    ownerAddress: ownerAddress.toLowerCase(),
    walletAddress: walletAddress.toLowerCase(),
  })));
}

export type IssuePaidServiceTicketInput = Readonly<{
  params: PaidServiceSessionParamsV1;
  ownerActionParamsHash: string;
  outerIssuedAt: number;
  account: BillingAccount;
  grant: AgentBillingGrant;
  onChainSessionExpiresAt: number;
  now: number;
  executionTicketKeyId: string;
  executionTicketPrivateKey: string;
}>;

export type PreparePaidServiceTicketInput = Omit<IssuePaidServiceTicketInput, "executionTicketPrivateKey">;

export function preparePaidServiceTicket(input: PreparePaidServiceTicketInput): Readonly<{
  unsigned: PaidServiceSessionTicketV1;
  signingBytes: Uint8Array;
}> {

  const { params, account, grant } = input;
  if (
    params.chainId !== 56 || params.issuedAt !== input.outerIssuedAt ||
    !Number.isSafeInteger(params.issuedAt) || !Number.isSafeInteger(params.expiresAt) ||
    params.issuedAt > input.now + 5 || params.expiresAt <= input.now ||
    params.expiresAt > params.issuedAt + 15 * 60 ||
    params.expiresAt > grant.expiresAt || params.expiresAt > account.grantExpiresAt ||
    params.expiresAt > input.onChainSessionExpiresAt
  ) throw new Error("BILLING_SESSION_INVALID");
  if (
    account.status !== "active" || grant.status !== "active" || grant.notBefore > input.now + 5 ||
    params.accountId !== account.accountId || params.accountId !== grant.accountId ||
    params.grantId !== grant.grantId || params.generation !== grant.generation ||
    params.agentId !== grant.agentId ||
    params.ownerAddress.toLowerCase() !== account.ownerAddress.toLowerCase() ||
    params.walletAddress.toLowerCase() !== account.walletAddress.toLowerCase()
  ) throw new Error("runtime_auth_failed");
  const operations = sortedSubset(params.operations, grant.operations, "operations") as readonly PaidOperation[];
  const templateIds = sortedSubset(params.templateIds, grant.templateIds, "templateIds");
  const hasChat = operations.includes("paid.0g.chat");
  if (hasChat !== (params.allowedModelIds !== undefined) || hasChat !== (params.maxTokensPerInference !== undefined)) {
    throw new Error("BILLING_SESSION_INVALID");
  }
  let allowedModelIds: readonly string[] | undefined;
  if (params.allowedModelIds !== undefined) {
    allowedModelIds = sortedSubset(params.allowedModelIds, [...OG_CHAT_MODELS.keys()].sort(), "allowedModelIds");
  }
  if (
    params.maxSessionUsdMicros < 1n || params.maxSessionUsdMicros > grant.maxRolling24hUsdMicros ||
    (params.maxTokensPerInference !== undefined && (
      !Number.isSafeInteger(params.maxTokensPerInference) || params.maxTokensPerInference < 1 ||
      grant.maxTokensPerInference === undefined || params.maxTokensPerInference > grant.maxTokensPerInference
    ))
  ) throw new Error("BILLING_SESSION_INVALID");

  const ticketId = keccak256(stringToBytes(JSON.stringify({
    domain: "4lpha.paid-service-ticket-id.v1",
    accountId: params.accountId,
    agentId: params.agentId,
    grantId: params.grantId,
    generation: params.generation.toString(),
    ownerActionParamsHash: input.ownerActionParamsHash.toLowerCase(),
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt,
  })));
  const unsigned: PaidServiceSessionTicketV1 = {
    domain: "4lpha.paid-service-ticket.v1",
    ticketId,
    accountId: params.accountId,
    agentId: params.agentId,
    ownerAddress: params.ownerAddress.toLowerCase(),
    walletAddress: params.walletAddress.toLowerCase(),
    grantId: params.grantId,
    generation: params.generation,
    operations,
    templateIds,
    ...(allowedModelIds === undefined ? {} : { allowedModelIds }),
    ...(params.maxTokensPerInference === undefined ? {} : { maxTokensPerInference: params.maxTokensPerInference }),
    maxSessionUsdMicros: params.maxSessionUsdMicros,
    ownerActionParamsHash: input.ownerActionParamsHash.toLowerCase(),
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt,
    executionTicketKeyId: input.executionTicketKeyId,
    signature: "A".repeat(86),
  };
  return { unsigned, signingBytes: ticketSigningBytes(unsigned) };
}

/** Offline/local helper; production owner routes use the injected KMS signer. */
export function issuePaidServiceTicket(input: IssuePaidServiceTicketInput): PaidServiceSessionTicketV1 {
  const prepared = preparePaidServiceTicket(input);
  return {
    ...prepared.unsigned,
    signature: signPaidBytes(input.executionTicketPrivateKey, prepared.signingBytes),
  };
}
