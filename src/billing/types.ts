/**
 * Phase 5 billing-domain records.
 *
 * Money never crosses this boundary as a JavaScript number. Atomic assets and
 * USD micros are bigint; timestamps are integer Unix seconds.
 */

export const PAID_OPERATIONS = ["paid.0g.chat", "paid.cmc.quote"] as const;
export type PaidOperation = (typeof PAID_OPERATIONS)[number];

export type BillingMode = "off" | "report" | "on";
export type BillingProviderMode = "off" | "on";
export type BillingAccountStatus =
  | "active"
  | "paused"
  | "revoked"
  | "closing"
  | "closed";

export type BillingAccount = Readonly<{
  accountId: string;
  ownerAddress: string;
  walletAddress: string;
  status: BillingAccountStatus;
  sessionFactsBytes: string;
  encryptedSessionKey: string;
  maxDailyUsdMicros: bigint;
  maxUnpaidExposureUsdMicros: bigint;
  thresholdUsdMicros: 100000n;
  grantExpiresAt: number;
  closeRequestId?: string;
  closeRequestedAt?: number;
  closeFlushInvoiceId?: string;
  closedAt?: number;
  createdAt: number;
  updatedAt: number;
}>;

export type AgentBillingGrant = Readonly<{
  grantId: string;
  generation: bigint;
  accountId: string;
  agentId: string;
  ownerAddress: string;
  walletAddress: string;
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
  status: "active" | "rotated" | "revoked";
  ownerConsentHash: string;
}>;

export type PaidServiceSessionParamsV1 = Readonly<{
  ownerAddress: string;
  walletAddress: string;
  accountId: string;
  agentId: string;
  grantId: string;
  generation: bigint;
  operations: readonly PaidOperation[];
  templateIds: readonly string[];
  allowedModelIds?: readonly string[];
  maxTokensPerInference?: number;
  maxSessionUsdMicros: bigint;
  issuedAt: number;
  expiresAt: number;
  chainId: 56;
}>;

export type PaidServiceSessionTicketV1 = Readonly<{
  domain: "4lpha.paid-service-ticket.v1";
  ticketId: string;
  accountId: string;
  agentId: string;
  ownerAddress: string;
  walletAddress: string;
  grantId: string;
  generation: bigint;
  operations: readonly PaidOperation[];
  templateIds: readonly string[];
  allowedModelIds?: readonly string[];
  maxTokensPerInference?: number;
  maxSessionUsdMicros: bigint;
  ownerActionParamsHash: string;
  issuedAt: number;
  expiresAt: number;
  executionTicketKeyId: string;
  signature: string;
}>;

export type PaidServiceAssertionV1 = Readonly<{
  domain: "4lpha.paid-service.v1";
  issuerKeyId: string;
  grantId: string;
  generation: bigint;
  accountId: string;
  agentId: string;
  ownerAddress: string;
  walletAddress: string;
  operation: PaidOperation;
  templateId: string;
  logicalRequestId: string;
  requestDigest: string;
  sessionTicketHash: string;
  maxTokens?: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}>;

export type PaidRequestProjection = Readonly<{
  method: "GET" | "POST";
  fixedRoutePath: string;
  canonicalQuery: string;
  businessPayload: string;
  sessionTicketHash: string;
}>;

export type UsageState =
  | "prepared"
  | "transmitting"
  | "actual"
  | "claimed"
  | "unknown"
  | "released"
  | "invoiced";

export type X402UsageFacts = Readonly<{
  kind: "x402";
  registryVersion: "x402-v1-2026-08-26";
  chainId: 8453;
  usdcAddress: string;
  authorizer: string;
  authorizationNonce: string;
  validAfter: bigint;
  validBefore: bigint;
  payee: string;
  amountAtomic: bigint;
  challengeDigest: string;
}>;

export type OgUsageFacts = Readonly<{
  kind: "0g";
  manifestVersion: string;
  routerPayerAccountId: string;
  routerApiKeyId: string;
  rawModelId: string;
  canonicalModelId: string;
  providerAddress: string;
  reviewedProviderIdentity: string | null;
  providerIdentityRule: "match-if-present";
  reviewedContextLength: bigint;
  reviewedMaxCompletionTokens: bigint;
  requestedMaxTokens: bigint;
  requestBodyBytes: bigint;
  inputReserveNeuronPerToken: bigint;
  completionReserveNeuronPerToken: bigint;
  liveModelObservationDigest: string;
}>;

export type OgResponseFacts = Readonly<{
  routerRequestId: string;
  inputTokens?: bigint;
  outputTokens?: bigint;
  traceProvider?: string;
  traceTeeVerified?: boolean;
  traceCostNeuron?: bigint;
  traceDigest?: string;
}>;

export type Usage = Readonly<{
  usageId: string;
  assertionNonce: string;
  sessionTicketHash: string;
  accountId: string;
  ownerAddress: string;
  walletAddress: string;
  agentId: string;
  grantId: string;
  generation: bigint;
  operation: PaidOperation;
  source: "x402" | "0g";
  provider: "cmc" | "0g-router";
  templateId: string;
  logicalRequestId: string;
  requestDigest: string;
  externalRequestId?: string;
  payerIdentity: string;
  debitIdentity?: string;
  state: UsageState;
  version: bigint;
  asset: "USDC_BASE" | "0G_MAINNET";
  reservedAtomic: bigint;
  reservedUsdMicros: bigint;
  sourceFacts?: X402UsageFacts | OgUsageFacts;
  ogResponseFacts?: OgResponseFacts;
  actualAtomic?: bigint;
  evidenceKind?: string;
  evidenceDigest?: string;
  invoiceId?: string;
  upstreamContactedAt?: number;
  createdAt: number;
  updatedAt: number;
}>;

export type OracleFeed = "0G_USD" | "BNB_USD" | "ARBITRUM_SEQUENCER";
export type OracleSnapshot = Readonly<{
  feed: OracleFeed;
  chainId: bigint;
  proxy: string;
  roundId: bigint;
  answer: bigint;
  decimals: number;
  startedAt: number;
  updatedAt: number;
  answeredInRound: bigint;
}>;

export type InvoiceState =
  | "quoted"
  | "submitting"
  | "paid"
  | "rolled_back"
  | "unknown"
  | "expired";

export type Invoice = Readonly<{
  invoiceId: string;
  accountId: string;
  usageIds: readonly string[];
  baseUsdcAtomic: bigint;
  ogNeuron: bigint;
  usdMicros: bigint;
  unroundedBnbWei: bigint;
  bnbWei: bigint;
  ogOracle?: OracleSnapshot;
  bnbOracle: OracleSnapshot;
  arbitrumSequencer?: OracleSnapshot;
  quoteTimestamp: number;
  quoteExpiresAt: number;
  attempt: bigint;
  state: InvoiceState;
  version: bigint;
  journalDecisionId?: string;
  preparedIntentDigest?: string;
  preparedChainId?: 56;
  preparedWallet?: string;
  preparedCollector?: string;
  preparedCalldata?: string;
  preparedValueWei?: bigint;
  preparedSessionGeneration?: bigint;
  relayQuoteExpiresAt?: number;
  relayIntentExpiresAt?: number;
  callsId?: string;
  transactionHash?: string;
  createdAt: number;
  updatedAt: number;
}>;

export type BillingSpendLedgerEntry = Readonly<{
  usageId: string;
  accountId: string;
  agentId: string;
  sessionTicketHash: string;
  invoiceId: string;
  usdMicros: bigint;
  paidAt: number;
}>;

export type OgHistoryDebit = Readonly<{
  historyId: bigint;
  routerRequestId: string;
  apiKeyId: string;
  modelId: string;
  canonicalId: string;
  providerAddress: string;
  providerIdentity?: string;
  inputTokens: bigint;
  outputTokens: bigint;
  cachedTokens: bigint;
  cacheWriteTokens: bigint;
  cacheWrite1hTokens: bigint;
  totalCostNeuron: bigint;
  creditUsedNeuron: bigint;
  depositUsedNeuron: bigint;
  completedAt: number;
}>;

/** Durable, resumable cursor for one unknown 0G Usage history scan. */
export type OgReconciliationCursor = Readonly<{
  usageId: string;
  version: bigint;
  nextCursor?: string;
  seenHistoryIds: readonly string[];
  candidate?: OgHistoryDebit;
  haltReason?: "HISTORY_SCAN_LIMIT";
  scanGeneration: bigint;
  attemptCount: bigint;
  nextRunAt: number;
  updatedAt: number;
}>;

export type JournalPrincipal =
  | Readonly<{ kind: "agent"; id: string }>
  | Readonly<{ kind: "billing_account"; id: string }>;
