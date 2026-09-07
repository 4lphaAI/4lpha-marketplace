import type { AgentRecord } from "../store/agents.js";
import { preparePaidServiceTicket } from "./serviceSession.js";
import type { BillingStore } from "./store.js";
import type {
  AgentBillingGrant,
  BillingAccount,
  Invoice,
  PaidServiceSessionParamsV1,
  PaidServiceSessionTicketV1,
  Usage,
} from "./types.js";
import type {
  BillingAccountActionParams,
  BillingGrantParams,
  BillingRotateParams,
} from "./ownerWire.js";

function same(value: string, expected: string): boolean {
  return value.toLowerCase() === expected.toLowerCase();
}

export function assertBillingAgentBinding(
  agent: AgentRecord,
  params: BillingAccountActionParams,
): void {
  if (
    params.agentId !== agent.id ||
    !same(params.ownerAddress, agent.ownerAddress) ||
    !same(params.walletAddress, agent.walletAddress)
  ) throw new Error("Billing account is not bound to this agent.");
}

async function boundAccount(
  store: BillingStore,
  agent: AgentRecord,
  params: BillingAccountActionParams,
): Promise<BillingAccount> {
  assertBillingAgentBinding(agent, params);
  const account = await store.getAccount(params.accountId);
  if (
    account === null ||
    !same(account.ownerAddress, agent.ownerAddress) ||
    !same(account.walletAddress, agent.walletAddress)
  ) throw new Error("Billing account is not available for this owner and wallet.");
  return account;
}

export async function grantAgentBilling(input: Readonly<{
  store: BillingStore;
  agent: AgentRecord;
  params: BillingGrantParams;
  ownerConsentHash: string;
  now: number;
}>): Promise<AgentBillingGrant> {
  const account = await boundAccount(input.store, input.agent, input.params);
  if (account.status !== "active" || input.params.notBefore > input.now + 5 || input.params.expiresAt <= input.now) {
    throw new Error("Billing grant window or account status is invalid.");
  }
  return input.store.putGrant({
    ...input.params,
    ownerAddress: input.params.ownerAddress.toLowerCase(),
    walletAddress: input.params.walletAddress.toLowerCase(),
    status: "active",
    ownerConsentHash: input.ownerConsentHash.toLowerCase(),
  });
}

export async function rotateAgentBillingIssuer(input: Readonly<{
  store: BillingStore;
  agent: AgentRecord;
  params: BillingRotateParams;
  ownerConsentHash: string;
  now: number;
}>): Promise<AgentBillingGrant> {
  const account = await boundAccount(input.store, input.agent, input.params);
  const current = await input.store.getGrant(input.params.grantId, input.params.oldGeneration);
  if (
    account.status !== "active" || current === null || current.status !== "active" ||
    current.agentId !== input.agent.id || current.issuerKeyId !== input.params.oldIssuerKeyId ||
    current.generation + 1n !== input.params.nextGeneration ||
    input.params.notBefore > input.now + 5 || input.params.expiresAt <= input.now
  ) throw new Error("Issuer rotation does not match the active grant.");
  const next: AgentBillingGrant = {
    ...current,
    generation: input.params.nextGeneration,
    issuerKeyId: input.params.newIssuerKeyId,
    issuerPublicKey: input.params.newIssuerPublicKey,
    ...(input.params.maxTokensPerInference === undefined
      ? current.maxTokensPerInference === undefined ? {} : { maxTokensPerInference: current.maxTokensPerInference }
      : { maxTokensPerInference: input.params.maxTokensPerInference }),
    notBefore: input.params.notBefore,
    expiresAt: input.params.expiresAt,
    status: "active",
    ownerConsentHash: input.ownerConsentHash.toLowerCase(),
  };
  return input.store.putGrant(next);
}

export async function issueAgentPaidServiceSession(input: Readonly<{
  store: BillingStore;
  agent: AgentRecord;
  params: PaidServiceSessionParamsV1;
  ownerActionParamsHash: string;
  outerIssuedAt: number;
  onChainSessionExpiresAt: number;
  now: number;
  executionTicketKeyId: string;
  signExecutionTicket(bytes: Uint8Array): Promise<string>;
}>): Promise<PaidServiceSessionTicketV1> {
  const account = await boundAccount(input.store, input.agent, input.params);
  const grant = await input.store.getGrant(input.params.grantId, input.params.generation);
  if (grant === null) throw new Error("The active billing grant was not found.");
  const prepared = preparePaidServiceTicket({
    params: input.params,
    ownerActionParamsHash: input.ownerActionParamsHash,
    outerIssuedAt: input.outerIssuedAt,
    account,
    grant,
    onChainSessionExpiresAt: input.onChainSessionExpiresAt,
    now: input.now,
    executionTicketKeyId: input.executionTicketKeyId,
  });
  const ticket = { ...prepared.unsigned, signature: await input.signExecutionTicket(prepared.signingBytes) };
  return input.store.putSessionTicket(ticket);
}

function usageView(usage: Usage): Readonly<Record<string, string | number>> {
  return {
    usageId: usage.usageId,
    state: usage.state,
    operation: usage.operation,
    provider: usage.provider,
    asset: usage.asset,
    reservedAtomic: usage.reservedAtomic.toString(),
    reservedUsdMicros: usage.reservedUsdMicros.toString(),
    ...(usage.actualAtomic === undefined ? {} : { actualAtomic: usage.actualAtomic.toString() }),
    ...(usage.evidenceKind === undefined ? {} : { evidenceKind: usage.evidenceKind }),
    createdAt: usage.createdAt,
    updatedAt: usage.updatedAt,
  };
}

function invoiceView(invoice: Invoice): Readonly<Record<string, unknown>> {
  return {
    invoiceId: invoice.invoiceId,
    state: invoice.state,
    usageIds: invoice.usageIds,
    baseUsdcAtomic: invoice.baseUsdcAtomic.toString(),
    ogNeuron: invoice.ogNeuron.toString(),
    usdMicros: invoice.usdMicros.toString(),
    bnbWei: invoice.bnbWei.toString(),
    quoteTimestamp: invoice.quoteTimestamp,
    quoteExpiresAt: invoice.quoteExpiresAt,
    ...(invoice.callsId === undefined ? {} : { callsId: invoice.callsId }),
    ...(invoice.transactionHash === undefined ? {} : { transactionHash: invoice.transactionHash }),
  };
}

export async function billingOwnerView(input: Readonly<{
  store: BillingStore;
  account: BillingAccount;
  actualUsdMicros: bigint;
}>): Promise<Readonly<Record<string, unknown>>> {
  const [usages, invoices, grants] = await Promise.all([
    input.store.listUsages(input.account.accountId),
    input.store.listInvoices(input.account.accountId),
    input.store.listGrants(input.account.accountId),
  ]);
  const reservedUsdMicros = usages
    .filter((usage) => usage.state === "prepared" || usage.state === "transmitting")
    .reduce((sum, usage) => sum + usage.reservedUsdMicros, 0n);
  const unknownUsdMicros = usages
    .filter((usage) => usage.state === "unknown")
    .reduce((sum, usage) => sum + usage.reservedUsdMicros, 0n);
  return {
    accountId: input.account.accountId,
    ownerAddress: input.account.ownerAddress,
    walletAddress: input.account.walletAddress,
    status: input.account.status,
    grantExpiresAt: input.account.grantExpiresAt,
    maxDailyUsdMicros: input.account.maxDailyUsdMicros.toString(),
    maxUnpaidExposureUsdMicros: input.account.maxUnpaidExposureUsdMicros.toString(),
    thresholdUsdMicros: input.account.thresholdUsdMicros.toString(),
    thresholdProgressUsdMicros: (input.actualUsdMicros > input.account.thresholdUsdMicros ? input.account.thresholdUsdMicros : input.actualUsdMicros).toString(),
    actualUsdMicros: input.actualUsdMicros.toString(),
    reservedUsdMicros: reservedUsdMicros.toString(),
    unknownUsdMicros: unknownUsdMicros.toString(),
    grants: grants.map((grant) => ({
      grantId: grant.grantId,
      generation: grant.generation.toString(),
      agentId: grant.agentId,
      issuerKeyId: grant.issuerKeyId,
      operations: grant.operations,
      templateIds: grant.templateIds,
      status: grant.status,
      expiresAt: grant.expiresAt,
    })),
    usages: usages.map(usageView),
    invoices: invoices.map(invoiceView),
    onChainRevokeRequired: input.account.status === "revoked" || input.account.status === "closing" || input.account.status === "closed",
  };
}
