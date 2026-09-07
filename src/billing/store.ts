import { randomBytes } from "node:crypto";
import { isAddress, keccak256, stringToBytes, type Hex } from "viem";
import type {
  AgentBillingGrant,
  BillingAccount,
  BillingSpendLedgerEntry,
  Invoice,
  OgReconciliationCursor,
  OgResponseFacts,
  OgUsageFacts,
  OracleSnapshot,
  PaidServiceAssertionV1,
  PaidServiceSessionTicketV1,
  Usage,
  X402UsageFacts,
} from "./types.js";
import { paidUsageId } from "./canonical.js";
import { billingAccountId } from "./serviceSession.js";
import { MAX_BILLING_DAILY_USD_MICROS, MAX_SEEN_OG_HISTORY_IDS } from "./config.js";
import { buildQuotedInvoice, ogNeuronToUsdMicros } from "./math.js";
import { assertOracleQuoteSet, ORACLE_MANIFEST } from "./oracles.js";

type AssertionReplay = Readonly<{
  digest: string;
  usageId: string;
}>;

type AttemptLease = Readonly<{
  usageId: string;
  token: string;
  expiresAt: number;
  contacted: boolean;
}>;

export type ReservePaidUsageInput = Readonly<{
  assertion: PaidServiceAssertionV1;
  assertionDigest: string;
  ticket: PaidServiceSessionTicketV1;
  grant: AgentBillingGrant;
  source: "x402" | "0g";
  provider: "cmc" | "0g-router";
  asset: "USDC_BASE" | "0G_MAINNET";
  payerIdentity: string;
  reservedAtomic: bigint;
  reservedUsdMicros: bigint;
  providerExposureCapAtomic: bigint;
  platformPayerExposureCapAtomic: bigint;
  ogOracle?: OracleSnapshot;
  arbitrumSequencer?: OracleSnapshot;
  sourceFacts?: OgUsageFacts;
  now: number;
}>;

export type PreparedUsage = Readonly<{
  usage: Usage;
  leaseToken: string;
  joined: boolean;
}>;

export type PreparedInvoiceIntent = {
  readonly digest: Hex;
  readonly chainId: 56;
  readonly wallet: string;
  readonly collector: string;
  readonly calldata: Hex;
  readonly valueWei: bigint;
  readonly sessionGeneration: bigint;
  readonly relayQuoteExpiresAt: number;
  readonly relayIntentExpiresAt: number;
};

export type PreparedInvoiceBindingToken = Readonly<{
  opaque: symbol;
  preparedHandle: object;
  invoiceId: string;
  invoiceVersion: bigint;
  preparedDigest: Hex;
}>;

export type PreparedInvoiceBinding = Readonly<{
  invoice: Invoice;
  bindingToken: PreparedInvoiceBindingToken;
}>;

export type BillingStoreSnapshot = Readonly<{
  accounts: readonly (readonly [string, BillingAccount])[];
  walletAccounts: readonly (readonly [string, string])[];
  grants: readonly (readonly [string, AgentBillingGrant])[];
  tickets: readonly (readonly [string, PaidServiceSessionTicketV1])[];
  replays: readonly (readonly [string, AssertionReplay])[];
  logical: readonly (readonly [string, string])[];
  usages: readonly (readonly [string, Usage])[];
  debitIdentities: readonly (readonly [string, string])[];
  leases: readonly (readonly [string, AttemptLease])[];
  invoices: readonly (readonly [string, Invoice])[];
  nonterminalInvoiceByUsage: readonly (readonly [string, string])[];
  ledger: readonly (readonly [string, BillingSpendLedgerEntry])[];
  ogReconciliations?: readonly (readonly [string, OgReconciliationCursor])[];
  billingWorkerAccountCursor?: string;
}>;

export interface BillingStore {
  createAccount(account: BillingAccount): Promise<BillingAccount>;
  listAccounts(): Promise<readonly BillingAccount[]>;
  claimBillingWorkerAccountBatch?(limit: number): Promise<readonly BillingAccount[]>;
  getAccount(accountId: string): Promise<BillingAccount | null>;
  getAccountByWallet(walletAddress: string): Promise<BillingAccount | null>;
  putGrant(grant: AgentBillingGrant): Promise<AgentBillingGrant>;
  getGrant(grantId: string, generation: bigint): Promise<AgentBillingGrant | null>;
  listGrants(accountId: string): Promise<readonly AgentBillingGrant[]>;
  putSessionTicket(ticket: PaidServiceSessionTicketV1): Promise<PaidServiceSessionTicketV1>;
  getSessionTicket(ticketId: string): Promise<PaidServiceSessionTicketV1 | null>;
  setAccountStatus(accountId: string, status: BillingAccount["status"], now: number): Promise<BillingAccount>;
  beginAccountClose(accountId: string, closeRequestId: string, now: number): Promise<BillingAccount>;
  closeAccountIfSettled(accountId: string, now: number): Promise<BillingAccount>;
  reservePaidUsage(input: ReservePaidUsageInput): Promise<PreparedUsage>;
  reclaimPreparedLease(accountId: string, now: number): Promise<boolean>;
  bindX402Authorization(usageId: string, leaseToken: string, expectedVersion: bigint, facts: X402UsageFacts): Promise<Usage>;
  markUpstreamContact(usageId: string, leaseToken: string, expectedVersion: bigint, now: number): Promise<Usage>;
  bindExternalRequestId(usageId: string, leaseToken: string, expectedVersion: bigint, requestId: string, now: number): Promise<Usage>;
  bindOgResponseFacts(usageId: string, leaseToken: string, expectedVersion: bigint, facts: OgResponseFacts, now: number): Promise<Usage>;
  finalizeActual(usageId: string, leaseToken: string, actualAtomic: bigint, evidenceKind: string, evidenceDigest: string, now: number): Promise<Usage>;
  finalizeProvenNotCharged(usageId: string, leaseToken: string, evidenceKind: string, evidenceDigest: string, now: number): Promise<Usage>;
  markUnknown(usageId: string, leaseToken: string, evidenceKind: string, evidenceDigest: string, now: number): Promise<Usage>;
  reconcileUnknown(usageId: string, expectedVersion: bigint, resolution: Readonly<{ actualAtomic?: bigint; evidenceKind: string; evidenceDigest: string; now: number }>): Promise<Usage>;
  getUsage(usageId: string): Promise<Usage | null>;
  listUsages(accountId: string): Promise<readonly Usage[]>;
  claimInvoice(invoice: Invoice): Promise<Invoice>;
  getInvoice(invoiceId: string): Promise<Invoice | null>;
  listInvoices(accountId: string): Promise<readonly Invoice[]>;
  expireQuotedInvoice(invoiceId: string, expectedVersion: bigint, now: number): Promise<Invoice>;
  markInvoiceSubmitting(invoiceId: string, expectedVersion: bigint, decisionId: string, intent: PreparedInvoiceIntent, preparedHandle: object, now: number): Promise<Readonly<{ invoice: Invoice; bindingToken: PreparedInvoiceBindingToken }>>;
  bindInvoiceCallsId(
    invoiceId: string,
    expectedVersion: bigint,
    callsId: string,
    now: number,
    binding?: Readonly<{ decisionId: string; witnessDigest: Hex }>,
  ): Promise<Invoice>;
  projectInvoicePaid(invoiceId: string, expectedVersion: bigint, paidAt: number, allocations: ReadonlyMap<string, bigint>, evidence: Readonly<{ callsId: string; transactionHash: string }>, now: number): Promise<Invoice>;
  projectInvoiceRolledBack(invoiceId: string, expectedVersion: bigint, evidence: Readonly<{ callsId: string; transactionHash: string }>, now: number): Promise<Invoice>;
  markInvoiceUnknown(invoiceId: string, expectedVersion: bigint, evidenceDigest: string, now: number): Promise<Invoice>;
  listLedger(accountId: string): Promise<readonly BillingSpendLedgerEntry[]>;
  getOgReconciliation(usageId: string): Promise<OgReconciliationCursor | null>;
  putOgReconciliation(cursor: OgReconciliationCursor, expectedVersion: bigint | null): Promise<OgReconciliationCursor>;
  close(): Promise<void>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function key(...parts: readonly (string | number | bigint)[]): string {
  return parts.map(String).join("\u001f");
}

function ensureNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Billing timestamps must be nonnegative integer seconds.");
}

function assertFreshOgValuation(
  og: OracleSnapshot | undefined,
  sequencer: OracleSnapshot | undefined,
  now: number,
): asserts og is OracleSnapshot {
  const ogManifest = ORACLE_MANIFEST["0G_USD"];
  const sequencerManifest = ORACLE_MANIFEST["ARBITRUM_SEQUENCER"];
  if (
    og === undefined || sequencer === undefined ||
    og.feed !== "0G_USD" || og.chainId !== ogManifest.chainId ||
    og.proxy.toLowerCase() !== ogManifest.proxy.toLowerCase() || og.decimals !== ogManifest.decimals ||
    og.answer <= 0n || og.answeredInRound < og.roundId || og.startedAt <= 0 || og.updatedAt <= 0 ||
    og.updatedAt > now + 5 ||
    now - og.updatedAt > (ogManifest.maxAgeSec ?? -1) ||
    sequencer.feed !== "ARBITRUM_SEQUENCER" || sequencer.chainId !== sequencerManifest.chainId ||
    sequencer.proxy.toLowerCase() !== sequencerManifest.proxy.toLowerCase() ||
    sequencer.decimals !== sequencerManifest.decimals || sequencer.answer !== 0n ||
    sequencer.answeredInRound < sequencer.roundId || sequencer.startedAt <= 0 ||
    sequencer.updatedAt <= 0 || sequencer.startedAt > now + 5 ||
    now - sequencer.startedAt < (sequencerManifest.sequencerGraceSec ?? Number.MAX_SAFE_INTEGER)
  ) throw new Error("ORACLE_UNAVAILABLE");
}

function sameUsageIntent(existing: Usage, input: ReservePaidUsageInput): boolean {
  const assertion = input.assertion;
  return existing.grantId === assertion.grantId &&
    existing.generation === assertion.generation &&
    existing.operation === assertion.operation &&
    existing.logicalRequestId === assertion.logicalRequestId &&
    existing.requestDigest === assertion.requestDigest &&
    existing.sessionTicketHash === assertion.sessionTicketHash &&
    existing.templateId === assertion.templateId &&
    existing.accountId === assertion.accountId &&
    existing.agentId === assertion.agentId &&
    existing.walletAddress.toLowerCase() === assertion.walletAddress.toLowerCase() &&
    existing.source === input.source &&
    existing.provider === input.provider &&
    existing.asset === input.asset &&
    existing.payerIdentity === input.payerIdentity &&
    existing.reservedAtomic === input.reservedAtomic &&
    JSON.stringify(existing.sourceFacts, bigintJson) === JSON.stringify(input.sourceFacts, bigintJson);
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

const livePreparedInvoiceBindings = new Set<symbol>();

/** Consume the in-process half of the durable prepared-intent fence exactly once. */
export function consumePreparedInvoiceBinding(
  token: PreparedInvoiceBindingToken,
  preparedHandle: object,
  invoice: Invoice,
): void {
  if (
    token.preparedHandle !== preparedHandle ||
    token.invoiceId !== invoice.invoiceId ||
    token.invoiceVersion !== invoice.version ||
    token.preparedDigest.toLowerCase() !== invoice.preparedIntentDigest?.toLowerCase() ||
    !livePreparedInvoiceBindings.delete(token.opaque)
  ) {
    throw new Error("Prepared invoice binding token is stale, substituted, or already consumed.");
  }
}

function mergeOgFacts(current: OgResponseFacts | undefined, next: OgResponseFacts): OgResponseFacts {
  if (current === undefined) return copy(next);
  const fields: readonly (keyof OgResponseFacts)[] = [
    "routerRequestId", "inputTokens", "outputTokens", "traceProvider",
    "traceTeeVerified", "traceCostNeuron", "traceDigest",
  ];
  const merged: Record<string, unknown> = {};
  for (const field of fields) {
    const oldValue = current[field];
    const newValue = next[field];
    if (oldValue !== undefined && newValue !== undefined && oldValue !== newValue) {
      throw new Error("0G response facts are write-once.");
    }
    const selected = oldValue ?? newValue;
    if (selected !== undefined) merged[field] = selected;
  }
  return merged as OgResponseFacts;
}

export class MemoryBillingStore implements BillingStore {
  readonly #accounts = new Map<string, BillingAccount>();
  readonly #walletAccounts = new Map<string, string>();
  readonly #grants = new Map<string, AgentBillingGrant>();
  readonly #tickets = new Map<string, PaidServiceSessionTicketV1>();
  readonly #replays = new Map<string, AssertionReplay>();
  readonly #logical = new Map<string, string>();
  readonly #usages = new Map<string, Usage>();
  readonly #debitIdentities = new Map<string, string>();
  readonly #leases = new Map<string, AttemptLease>();
  readonly #invoices = new Map<string, Invoice>();
  readonly #nonterminalInvoiceByUsage = new Map<string, string>();
  readonly #ledger = new Map<string, BillingSpendLedgerEntry>();
  readonly #ogReconciliations = new Map<string, OgReconciliationCursor>();
  #billingWorkerAccountCursor: string | undefined;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(snapshot?: BillingStoreSnapshot) {
    if (snapshot === undefined) return;
    for (const [id, row] of snapshot.accounts) this.#accounts.set(id, copy(row));
    for (const [wallet, id] of snapshot.walletAccounts) this.#walletAccounts.set(wallet, id);
    for (const [id, row] of snapshot.grants) this.#grants.set(id, copy(row));
    for (const [id, row] of snapshot.tickets) this.#tickets.set(id, copy(row));
    for (const [id, row] of snapshot.replays) this.#replays.set(id, copy(row));
    for (const [id, row] of snapshot.logical) this.#logical.set(id, row);
    for (const [id, row] of snapshot.usages) this.#usages.set(id, copy(row));
    for (const [id, row] of snapshot.debitIdentities) this.#debitIdentities.set(id, row);
    for (const [id, row] of snapshot.leases) this.#leases.set(id, copy(row));
    for (const [id, row] of snapshot.invoices) this.#invoices.set(id, copy(row));
    for (const [id, row] of snapshot.nonterminalInvoiceByUsage) this.#nonterminalInvoiceByUsage.set(id, row);
    for (const [id, row] of snapshot.ledger) this.#ledger.set(id, copy(row));
    for (const [id, row] of snapshot.ogReconciliations ?? []) this.#ogReconciliations.set(id, copy(row));
    this.#billingWorkerAccountCursor = snapshot.billingWorkerAccountCursor;
  }

  dump(): BillingStoreSnapshot {
    return copy({
      accounts: [...this.#accounts.entries()],
      walletAccounts: [...this.#walletAccounts.entries()],
      grants: [...this.#grants.entries()],
      tickets: [...this.#tickets.entries()],
      replays: [...this.#replays.entries()],
      logical: [...this.#logical.entries()],
      usages: [...this.#usages.entries()],
      debitIdentities: [...this.#debitIdentities.entries()],
      leases: [...this.#leases.entries()],
      invoices: [...this.#invoices.entries()],
      nonterminalInvoiceByUsage: [...this.#nonterminalInvoiceByUsage.entries()],
      ledger: [...this.#ledger.entries()],
      ogReconciliations: [...this.#ogReconciliations.entries()],
      ...(this.#billingWorkerAccountCursor === undefined ? {} : {
        billingWorkerAccountCursor: this.#billingWorkerAccountCursor,
      }),
    });
  }

  async #atomic<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.#lock.catch(() => undefined).then(fn);
    this.#lock = run.catch(() => undefined);
    return run;
  }

  async createAccount(account: BillingAccount): Promise<BillingAccount> {
    return this.#atomic(() => {
      if (
        !isAddress(account.ownerAddress, { strict: false }) ||
        !isAddress(account.walletAddress, { strict: false }) ||
        account.accountId.toLowerCase() !== billingAccountId(account.ownerAddress, account.walletAddress) ||
        account.status !== "active" || account.closeRequestId !== undefined ||
        account.closeRequestedAt !== undefined || account.closeFlushInvoiceId !== undefined ||
        account.closedAt !== undefined || account.sessionFactsBytes === "" ||
        account.encryptedSessionKey === "" || account.createdAt !== account.updatedAt ||
        account.grantExpiresAt <= account.createdAt
      ) throw new Error("Billing account creation record is invalid.");
      const normalizedWallet = account.walletAddress.toLowerCase();
      const existingId = this.#walletAccounts.get(normalizedWallet);
      if (existingId !== undefined) {
        const existing = this.#accounts.get(existingId);
        if (existing !== undefined && existing.accountId === account.accountId && JSON.stringify(existing, bigintJson) === JSON.stringify(account, bigintJson)) {
          return copy(existing);
        }
        throw new Error("Billing wallet identity is permanently assigned.");
      }
      if (this.#accounts.has(account.accountId)) throw new Error("Billing account already exists.");
      if (
        account.thresholdUsdMicros !== 100_000n || account.maxDailyUsdMicros < 1n ||
        account.maxDailyUsdMicros > MAX_BILLING_DAILY_USD_MICROS ||
        account.maxUnpaidExposureUsdMicros < 1n ||
        account.maxUnpaidExposureUsdMicros > account.maxDailyUsdMicros
      ) {
        throw new Error("Invalid billing account limits.");
      }
      const stored = copy(account);
      this.#accounts.set(account.accountId, stored);
      this.#walletAccounts.set(normalizedWallet, account.accountId);
      return copy(stored);
    });
  }

  async getAccount(accountId: string): Promise<BillingAccount | null> {
    const row = this.#accounts.get(accountId);
    return row === undefined ? null : copy(row);
  }

  async listAccounts(): Promise<readonly BillingAccount[]> {
    return [...this.#accounts.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.accountId.localeCompare(b.accountId))
      .map(copy);
  }

  async claimBillingWorkerAccountBatch(limit: number): Promise<readonly BillingAccount[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Billing worker account-batch limit is invalid.");
    }
    return this.#atomic(() => {
      const accounts = [...this.#accounts.values()]
        .sort((a, b) => a.createdAt - b.createdAt || a.accountId.localeCompare(b.accountId));
      if (accounts.length === 0) {
        this.#billingWorkerAccountCursor = undefined;
        return [];
      }
      const previous = this.#billingWorkerAccountCursor;
      const previousIndex = previous === undefined
        ? -1
        : accounts.findIndex((account) => account.accountId === previous);
      const start = previousIndex < 0 || previousIndex + 1 >= accounts.length ? 0 : previousIndex + 1;
      const selected = accounts.slice(start, start + limit);
      this.#billingWorkerAccountCursor = selected.at(-1)?.accountId;
      return selected.map(copy);
    });
  }

  async getAccountByWallet(walletAddress: string): Promise<BillingAccount | null> {
    const accountId = this.#walletAccounts.get(walletAddress.toLowerCase());
    return accountId === undefined ? null : this.getAccount(accountId);
  }

  async putGrant(grant: AgentBillingGrant): Promise<AgentBillingGrant> {
    return this.#atomic(() => {
      const account = this.#accounts.get(grant.accountId);
      if (account === undefined || account.ownerAddress.toLowerCase() !== grant.ownerAddress.toLowerCase() || account.walletAddress.toLowerCase() !== grant.walletAddress.toLowerCase()) {
        throw new Error("Grant is not bound to its billing account.");
      }
      if (grant.operations.length === 0 || new Set(grant.operations).size !== grant.operations.length || grant.templateIds.length === 0 || new Set(grant.templateIds).size !== grant.templateIds.length) {
        throw new Error("Billing grants require closed, unique scopes.");
      }
      if (grant.agentId === "*" || grant.agentId === "all" || grant.agentId.trim() === "") throw new Error("Wildcard billing agents are forbidden.");
      const hasChat = grant.operations.includes("paid.0g.chat");
      if (hasChat !== (grant.maxTokensPerInference !== undefined)) throw new Error("maxTokensPerInference is required iff chat is granted.");
      const sameGeneration = [...this.#grants.values()].find((entry) => entry.agentId === grant.agentId && entry.status === "active");
      if (sameGeneration !== undefined && sameGeneration.generation >= grant.generation && sameGeneration.grantId !== grant.grantId) {
        throw new Error("Grant generation must advance monotonically.");
      }
      if (grant.maxRolling24hUsdMicros > account.maxDailyUsdMicros || grant.expiresAt > account.grantExpiresAt) {
        throw new Error("Grant exceeds its account limits.");
      }
      for (const [id, existing] of this.#grants) {
        if (existing.agentId === grant.agentId && existing.status === "active" && id !== key(grant.grantId, grant.generation)) {
          this.#grants.set(id, { ...existing, status: "rotated" });
        }
        if (existing.issuerKeyId === grant.issuerKeyId && existing.agentId !== grant.agentId) {
          throw new Error("Issuer keys are per-agent and cannot be shared.");
        }
      }
      const stored = copy(grant);
      this.#grants.set(key(grant.grantId, grant.generation), stored);
      return copy(stored);
    });
  }

  async getGrant(grantId: string, generation: bigint): Promise<AgentBillingGrant | null> {
    const row = this.#grants.get(key(grantId, generation));
    return row === undefined ? null : copy(row);
  }

  async listGrants(accountId: string): Promise<readonly AgentBillingGrant[]> {
    return [...this.#grants.values()]
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || Number(a.generation - b.generation))
      .map(copy);
  }

  async putSessionTicket(ticket: PaidServiceSessionTicketV1): Promise<PaidServiceSessionTicketV1> {
    return this.#atomic(() => {
      const current = this.#tickets.get(ticket.ticketId);
      if (current !== undefined && JSON.stringify(current, bigintJson) !== JSON.stringify(ticket, bigintJson)) {
        throw new Error("Ticket identity conflict.");
      }
      this.#tickets.set(ticket.ticketId, copy(ticket));
      return copy(ticket);
    });
  }

  async getSessionTicket(ticketId: string): Promise<PaidServiceSessionTicketV1 | null> {
    const row = this.#tickets.get(ticketId);
    return row === undefined ? null : copy(row);
  }

  async setAccountStatus(accountId: string, status: BillingAccount["status"], now: number): Promise<BillingAccount> {
    ensureNow(now);
    return this.#atomic(() => {
      const account = this.#accounts.get(accountId);
      if (account === undefined) throw new Error("Billing account not found.");
      if (account.status === "closed") throw new Error("Closed billing accounts are terminal.");
      const transitionAllowed =
        (account.status === "active" && (status === "paused" || status === "revoked" || status === "closing")) ||
        (account.status === "paused" && (status === "active" || status === "revoked" || status === "closing")) ||
        (account.status === "revoked" && status === "revoked") ||
        (account.status === "closing" && status === "closing");
      if (!transitionAllowed) throw new Error("Billing account status transition is forbidden.");
      const updated: BillingAccount = { ...account, status, updatedAt: now };
      this.#accounts.set(accountId, updated);
      if (status === "revoked" || status === "closing") {
        for (const [id, grant] of this.#grants) {
          if (grant.accountId === accountId && grant.status === "active") this.#grants.set(id, { ...grant, status: "revoked" });
        }
      }
      return copy(updated);
    });
  }

  async beginAccountClose(accountId: string, closeRequestId: string, now: number): Promise<BillingAccount> {
    ensureNow(now);
    if (closeRequestId.trim() === "") throw new Error("Billing close request ID is required.");
    return this.#atomic(() => {
      const account = this.#accounts.get(accountId);
      if (account === undefined) throw new Error("Billing account not found.");
      if (account.status === "closed") throw new Error("Closed billing accounts are terminal.");
      if (account.closeRequestId !== undefined && account.closeRequestId !== closeRequestId) {
        throw new Error("Billing account close request conflicts with the existing close.");
      }
      const updated: BillingAccount = {
        ...account,
        status: "closing",
        closeRequestId,
        closeRequestedAt: account.closeRequestedAt ?? now,
        updatedAt: now,
      };
      this.#accounts.set(accountId, updated);
      for (const [id, grant] of this.#grants) {
        if (grant.accountId === accountId && grant.status === "active") {
          this.#grants.set(id, { ...grant, status: "revoked" });
        }
      }
      return copy(updated);
    });
  }

  async closeAccountIfSettled(accountId: string, now: number): Promise<BillingAccount> {
    ensureNow(now);
    return this.#atomic(() => {
      const account = this.#accounts.get(accountId);
      if (account === undefined) throw new Error("Billing account not found.");
      if (account.status === "closed") return copy(account);
      if (account.status !== "closing" || account.closeRequestId === undefined) {
        throw new Error("Only a closing billing account can become closed.");
      }
      const holdsUsage = [...this.#usages.values()].some((usage) =>
        usage.accountId === accountId &&
        usage.state !== "released" &&
        usage.state !== "invoiced");
      const holdsInvoice = [...this.#invoices.values()].some((invoice) =>
        invoice.accountId === accountId &&
        (invoice.state === "quoted" || invoice.state === "submitting" || invoice.state === "unknown"));
      if (holdsUsage || holdsInvoice) throw new Error("Billing account still has unsettled exposure.");
      const updated: BillingAccount = { ...account, status: "closed", closedAt: now, updatedAt: now };
      this.#accounts.set(accountId, updated);
      return copy(updated);
    });
  }

  #usageExposureUsdMicros(usage: Usage, ogOracle: OracleSnapshot | undefined): bigint {
    const atomic = usage.state === "actual" || usage.state === "claimed"
      ? usage.actualAtomic
      : usage.reservedAtomic;
    if (atomic === undefined) throw new Error("Billable Usage lacks an actual amount.");
    if (usage.asset === "USDC_BASE") return atomic;
    if (ogOracle === undefined) throw new Error("ORACLE_UNAVAILABLE");
    return ogNeuronToUsdMicros(atomic, ogOracle.answer, ogOracle.decimals);
  }

  #rollingUse(
    accountId: string,
    agentId: string | undefined,
    ticketHash: string | undefined,
    now: number,
    ogOracle: OracleSnapshot | undefined,
    ticketLifetime: boolean,
  ): bigint {
    let total = 0n;
    for (const entry of this.#ledger.values()) {
      if (entry.accountId === accountId && (ticketLifetime || entry.paidAt > now - 86_400) && (agentId === undefined || entry.agentId === agentId) && (ticketHash === undefined || entry.sessionTicketHash === ticketHash)) {
        total += entry.usdMicros;
      }
    }
    for (const usage of this.#usages.values()) {
      if (
        usage.accountId === accountId &&
        usage.state !== "released" && usage.state !== "invoiced" &&
        (agentId === undefined || usage.agentId === agentId) &&
        (ticketHash === undefined || usage.sessionTicketHash === ticketHash)
      ) total += this.#usageExposureUsdMicros(usage, ogOracle);
    }
    return total;
  }

  async reservePaidUsage(input: ReservePaidUsageInput): Promise<PreparedUsage> {
    ensureNow(input.now);
    return this.#atomic(() => {
      const { assertion, ticket, grant } = input;
      const account = this.#accounts.get(assertion.accountId);
      if (account === undefined) throw new Error("runtime_auth_failed");
      if (account.status === "paused") throw new Error("BILLING_PAUSED");
      if (account.status !== "active") throw new Error("BILLING_REVOKED");
      if (grant.status !== "active" || grant.notBefore > input.now + 5 || grant.expiresAt <= input.now) throw new Error("runtime_auth_failed");
      if (ticket.expiresAt <= input.now || assertion.expiresAt <= input.now - 5) throw new Error("runtime_auth_failed");
      if (
        assertion.grantId !== grant.grantId || assertion.generation !== grant.generation ||
        assertion.accountId !== grant.accountId || assertion.agentId !== grant.agentId ||
        assertion.ownerAddress.toLowerCase() !== grant.ownerAddress.toLowerCase() ||
        assertion.walletAddress.toLowerCase() !== grant.walletAddress.toLowerCase() ||
        ticket.grantId !== grant.grantId || ticket.generation !== grant.generation ||
        ticket.accountId !== grant.accountId || ticket.agentId !== grant.agentId ||
        ticket.ownerAddress.toLowerCase() !== grant.ownerAddress.toLowerCase() ||
        ticket.walletAddress.toLowerCase() !== grant.walletAddress.toLowerCase() ||
        !grant.operations.includes(assertion.operation) || !ticket.operations.includes(assertion.operation) ||
        !grant.templateIds.includes(assertion.templateId) || !ticket.templateIds.includes(assertion.templateId)
      ) throw new Error("runtime_auth_failed");
      const hasLiveOgExposure = input.source === "0g" || [...this.#usages.values()].some((usage) =>
        usage.accountId === account.accountId && usage.asset === "0G_MAINNET" &&
        usage.state !== "released" && usage.state !== "invoiced");
      if (hasLiveOgExposure) assertFreshOgValuation(input.ogOracle, input.arbitrumSequencer, input.now);
      const reservedUsdMicros = input.source === "0g"
        ? ogNeuronToUsdMicros(input.reservedAtomic, input.ogOracle!.answer, input.ogOracle!.decimals)
        : input.reservedAtomic;
      if (
        input.reservedAtomic < 0n || input.reservedUsdMicros !== reservedUsdMicros ||
        input.providerExposureCapAtomic <= 0n || input.platformPayerExposureCapAtomic <= 0n ||
        reservedUsdMicros > grant.maxUsdMicrosPerRequest
      ) {
        throw new Error("EXPOSURE_LIMIT");
      }
      const normalizedInput: ReservePaidUsageInput = { ...input, reservedUsdMicros };
      if (input.source === "0g") {
        if (input.sourceFacts?.kind !== "0g" || input.reservedAtomic > grant.maxAtomic0gPerInference || assertion.maxTokens === undefined) {
          throw new Error("EXPOSURE_LIMIT");
        }
        if (ticket.maxTokensPerInference === undefined || grant.maxTokensPerInference === undefined || assertion.maxTokens > ticket.maxTokensPerInference || assertion.maxTokens > grant.maxTokensPerInference) {
          throw new Error("MODEL_NOT_ALLOWED");
        }
      } else if (input.sourceFacts !== undefined || assertion.maxTokens !== undefined) {
        throw new Error("runtime_auth_failed");
      }

      const replayKey = key(assertion.issuerKeyId, assertion.nonce);
      const replay = this.#replays.get(replayKey);
      if (replay !== undefined && replay.digest !== input.assertionDigest) throw new Error("runtime_auth_failed");
      const logicalKey = key(assertion.grantId, assertion.generation, assertion.operation, assertion.logicalRequestId);
      const existingId = this.#logical.get(logicalKey);
      if (existingId !== undefined) {
        const existing = this.#usages.get(existingId);
        if (existing === undefined || !sameUsageIntent(existing, normalizedInput)) throw new Error("IDEMPOTENCY_CONFLICT");
        this.#replays.set(replayKey, { digest: input.assertionDigest, usageId: existingId });
        const lease = this.#leases.get(account.accountId);
        return { usage: copy(existing), leaseToken: lease?.usageId === existingId ? lease.token : "joined-terminal", joined: true };
      }
      if (replay !== undefined) throw new Error("runtime_auth_failed");
      if (this.#leases.has(account.accountId)) throw new Error("EXPOSURE_LIMIT");

      const accountUse = this.#rollingUse(account.accountId, undefined, undefined, input.now, input.ogOracle, false) + reservedUsdMicros;
      const agentUse = this.#rollingUse(account.accountId, grant.agentId, undefined, input.now, input.ogOracle, false) + reservedUsdMicros;
      const ticketUse = this.#rollingUse(account.accountId, undefined, assertion.sessionTicketHash, input.now, input.ogOracle, true) + reservedUsdMicros;
      const unpaidExposure = [...this.#usages.values()].reduce((sum, usage) =>
        usage.accountId === account.accountId && usage.state !== "released" && usage.state !== "invoiced"
          ? sum + this.#usageExposureUsdMicros(usage, input.ogOracle) : sum, 0n) + reservedUsdMicros;
      const liveAtomic = (usage: Usage): bigint =>
        usage.state === "actual" || usage.state === "claimed"
          ? usage.actualAtomic ?? usage.reservedAtomic
          : usage.reservedAtomic;
      const providerExposureAtomic = [...this.#usages.values()].reduce((sum, usage) =>
        usage.provider === input.provider && usage.asset === input.asset &&
        usage.state !== "released" && usage.state !== "invoiced"
          ? sum + liveAtomic(usage) : sum, 0n) + input.reservedAtomic;
      const payerExposureAtomic = [...this.#usages.values()].reduce((sum, usage) =>
        usage.payerIdentity === input.payerIdentity && usage.asset === input.asset &&
        usage.state !== "released" && usage.state !== "invoiced"
          ? sum + liveAtomic(usage) : sum, 0n) + input.reservedAtomic;
      if (
        accountUse > account.maxDailyUsdMicros || agentUse > grant.maxRolling24hUsdMicros ||
        ticketUse > ticket.maxSessionUsdMicros || unpaidExposure > account.maxUnpaidExposureUsdMicros ||
        providerExposureAtomic > input.providerExposureCapAtomic ||
        payerExposureAtomic > input.platformPayerExposureCapAtomic
      ) throw new Error("EXPOSURE_LIMIT");

      const usageId = paidUsageId(assertion);
      const usage: Usage = {
        usageId,
        assertionNonce: assertion.nonce,
        sessionTicketHash: assertion.sessionTicketHash,
        accountId: assertion.accountId,
        ownerAddress: assertion.ownerAddress.toLowerCase(),
        walletAddress: assertion.walletAddress.toLowerCase(),
        agentId: assertion.agentId,
        grantId: assertion.grantId,
        generation: assertion.generation,
        operation: assertion.operation,
        source: input.source,
        provider: input.provider,
        templateId: assertion.templateId,
        logicalRequestId: assertion.logicalRequestId,
        requestDigest: assertion.requestDigest,
        payerIdentity: input.payerIdentity,
        state: "prepared",
        version: 0n,
        asset: input.asset,
        reservedAtomic: input.reservedAtomic,
        reservedUsdMicros,
        ...(input.sourceFacts === undefined ? {} : { sourceFacts: copy(input.sourceFacts) }),
        createdAt: input.now,
        updatedAt: input.now,
      };
      const leaseToken = randomBytes(32).toString("base64url");
      this.#usages.set(usageId, usage);
      this.#logical.set(logicalKey, usageId);
      this.#replays.set(replayKey, { digest: input.assertionDigest, usageId });
      this.#leases.set(account.accountId, { usageId, token: leaseToken, expiresAt: input.now + 60, contacted: false });
      return { usage: copy(usage), leaseToken, joined: false };
    });
  }

  async reclaimPreparedLease(accountId: string, now: number): Promise<boolean> {
    ensureNow(now);
    return this.#atomic(() => {
      const lease = this.#leases.get(accountId);
      if (lease === undefined || lease.contacted || now <= lease.expiresAt) return false;
      const usage = this.#usages.get(lease.usageId);
      if (usage === undefined || usage.state !== "prepared" || usage.upstreamContactedAt !== undefined) return false;
      this.#usages.set(usage.usageId, { ...usage, state: "released", version: usage.version + 1n, evidenceKind: "pre_contact_lease_expired", evidenceDigest: keccak256(stringToBytes(usage.usageId)), updatedAt: now });
      this.#leases.delete(accountId);
      return true;
    });
  }

  #fenced(usageId: string, leaseToken: string, expectedVersion: bigint): readonly [Usage, AttemptLease] {
    const usage = this.#usages.get(usageId);
    if (usage === undefined || usage.version !== expectedVersion) throw new Error("Stale Usage version.");
    const lease = this.#leases.get(usage.accountId);
    if (lease === undefined || lease.usageId !== usageId || lease.token !== leaseToken) throw new Error("Stale Usage lease.");
    return [usage, lease];
  }

  async bindX402Authorization(usageId: string, leaseToken: string, expectedVersion: bigint, facts: X402UsageFacts): Promise<Usage> {
    return this.#atomic(() => {
      const [usage] = this.#fenced(usageId, leaseToken, expectedVersion);
      if (usage.source !== "x402" || usage.state !== "prepared") throw new Error("x402 facts require a prepared x402 Usage.");
      if (usage.sourceFacts !== undefined) {
        if (JSON.stringify(usage.sourceFacts, bigintJson) !== JSON.stringify(facts, bigintJson)) throw new Error("x402 facts are immutable.");
        return copy(usage);
      }
      const debitIdentity = key(facts.chainId, facts.usdcAddress.toLowerCase(), facts.authorizer.toLowerCase(), facts.authorizationNonce.toLowerCase());
      const collision = this.#debitIdentities.get(debitIdentity);
      if (collision !== undefined && collision !== usageId) throw new Error("x402 debit identity collision.");
      const updated: Usage = { ...usage, sourceFacts: copy(facts), debitIdentity, version: usage.version + 1n, updatedAt: usage.updatedAt };
      this.#debitIdentities.set(debitIdentity, usageId);
      this.#usages.set(usageId, updated);
      return copy(updated);
    });
  }

  async markUpstreamContact(usageId: string, leaseToken: string, expectedVersion: bigint, now: number): Promise<Usage> {
    ensureNow(now);
    return this.#atomic(() => {
      const [usage, lease] = this.#fenced(usageId, leaseToken, expectedVersion);
      if (usage.state !== "prepared" || (usage.source === "x402" && usage.sourceFacts?.kind !== "x402")) throw new Error("Usage is not ready for upstream contact.");
      const updated: Usage = { ...usage, state: "transmitting", upstreamContactedAt: now, version: usage.version + 1n, updatedAt: now };
      this.#usages.set(usageId, updated);
      this.#leases.set(usage.accountId, { ...lease, contacted: true });
      return copy(updated);
    });
  }

  async bindExternalRequestId(usageId: string, leaseToken: string, expectedVersion: bigint, requestId: string, now: number): Promise<Usage> {
    ensureNow(now);
    return this.#atomic(() => {
      const [usage] = this.#fenced(usageId, leaseToken, expectedVersion);
      if (usage.source !== "0g" || usage.state !== "transmitting" || requestId.trim() === "") throw new Error("Router request ID requires a transmitting 0G Usage.");
      if (usage.externalRequestId !== undefined) {
        if (usage.externalRequestId !== requestId) throw new Error("Router request ID is immutable.");
        return copy(usage);
      }
      const identity = key(usage.payerIdentity, requestId);
      const collision = this.#debitIdentities.get(identity);
      if (collision !== undefined && collision !== usageId) throw new Error("Router request ID collision.");
      const updated: Usage = { ...usage, externalRequestId: requestId, debitIdentity: identity, version: usage.version + 1n, updatedAt: now };
      this.#debitIdentities.set(identity, usageId);
      this.#usages.set(usageId, updated);
      return copy(updated);
    });
  }

  async bindOgResponseFacts(usageId: string, leaseToken: string, expectedVersion: bigint, facts: OgResponseFacts, now: number): Promise<Usage> {
    ensureNow(now);
    return this.#atomic(() => {
      const [usage] = this.#fenced(usageId, leaseToken, expectedVersion);
      if (usage.source !== "0g" || usage.state !== "transmitting" || usage.externalRequestId !== facts.routerRequestId) {
        throw new Error("0G response facts do not bind the transmitting Usage.");
      }
      const merged = mergeOgFacts(usage.ogResponseFacts, facts);
      if (usage.ogResponseFacts !== undefined && JSON.stringify(merged, bigintJson) === JSON.stringify(usage.ogResponseFacts, bigintJson)) return copy(usage);
      const updated: Usage = { ...usage, ogResponseFacts: merged, version: usage.version + 1n, updatedAt: now };
      this.#usages.set(usageId, updated);
      return copy(updated);
    });
  }

  #terminal(usageId: string, leaseToken: string, actualAtomic: bigint | undefined, state: "actual" | "released" | "unknown", evidenceKind: string, evidenceDigest: string, now: number): Usage {
    const [usage] = this.#fenced(usageId, leaseToken, this.#usages.get(usageId)?.version ?? -1n);
    if (usage.state !== "transmitting" && !(state === "released" && usage.state === "prepared")) throw new Error("Usage cannot be terminalized from this state.");
    if (state === "actual" && (actualAtomic === undefined || actualAtomic <= 0n || actualAtomic > usage.reservedAtomic)) throw new Error("Actual debit is outside its reservation.");
    const updated: Usage = {
      ...usage,
      state,
      ...(actualAtomic === undefined ? {} : { actualAtomic }),
      evidenceKind,
      evidenceDigest,
      version: usage.version + 1n,
      updatedAt: now,
    };
    this.#usages.set(usageId, updated);
    if (state !== "unknown") this.#leases.delete(usage.accountId);
    return copy(updated);
  }

  async finalizeActual(usageId: string, leaseToken: string, actualAtomic: bigint, evidenceKind: string, evidenceDigest: string, now: number): Promise<Usage> {
    ensureNow(now);
    return this.#atomic(() => this.#terminal(usageId, leaseToken, actualAtomic, "actual", evidenceKind, evidenceDigest, now));
  }

  async finalizeProvenNotCharged(usageId: string, leaseToken: string, evidenceKind: string, evidenceDigest: string, now: number): Promise<Usage> {
    ensureNow(now);
    return this.#atomic(() => this.#terminal(usageId, leaseToken, undefined, "released", evidenceKind, evidenceDigest, now));
  }

  async markUnknown(usageId: string, leaseToken: string, evidenceKind: string, evidenceDigest: string, now: number): Promise<Usage> {
    ensureNow(now);
    return this.#atomic(() => this.#terminal(usageId, leaseToken, undefined, "unknown", evidenceKind, evidenceDigest, now));
  }

  async reconcileUnknown(usageId: string, expectedVersion: bigint, resolution: Readonly<{ actualAtomic?: bigint; evidenceKind: string; evidenceDigest: string; now: number }>): Promise<Usage> {
    ensureNow(resolution.now);
    return this.#atomic(() => {
      const usage = this.#usages.get(usageId);
      if (usage === undefined || usage.state !== "unknown" || usage.version !== expectedVersion) throw new Error("Unknown Usage fence failed.");
      const actual = resolution.actualAtomic;
      if (actual !== undefined && (actual <= 0n || actual > usage.reservedAtomic)) throw new Error("Reconciled debit is outside reservation.");
      const updated: Usage = {
        ...usage,
        state: actual === undefined ? "released" : "actual",
        ...(actual === undefined ? {} : { actualAtomic: actual }),
        evidenceKind: resolution.evidenceKind,
        evidenceDigest: resolution.evidenceDigest,
        version: usage.version + 1n,
        updatedAt: resolution.now,
      };
      this.#usages.set(usageId, updated);
      this.#leases.delete(usage.accountId);
      return copy(updated);
    });
  }

  async getUsage(usageId: string): Promise<Usage | null> {
    const row = this.#usages.get(usageId);
    return row === undefined ? null : copy(row);
  }

  async listUsages(accountId: string): Promise<readonly Usage[]> {
    return [...this.#usages.values()].filter((row) => row.accountId === accountId).sort((a, b) => a.createdAt - b.createdAt || a.usageId.localeCompare(b.usageId)).map(copy);
  }

  async claimInvoice(invoice: Invoice): Promise<Invoice> {
    return this.#atomic(() => {
      if (
        invoice.state !== "quoted" || invoice.usageIds.length === 0 ||
        new Set(invoice.usageIds).size !== invoice.usageIds.length ||
        [...invoice.usageIds].sort().some((id, index) => id !== invoice.usageIds[index])
      ) {
        throw new Error("Invoice claim must be a sorted nonempty quoted batch.");
      }
      assertOracleQuoteSet({
        ogNeuron: invoice.ogNeuron,
        bnb: invoice.bnbOracle,
        ...(invoice.ogOracle === undefined ? {} : { og: invoice.ogOracle }),
        ...(invoice.arbitrumSequencer === undefined ? {} : { sequencer: invoice.arbitrumSequencer }),
        quoteTimestamp: invoice.quoteTimestamp,
      });
      const canonical = buildQuotedInvoice({
        accountId: invoice.accountId,
        usageIds: invoice.usageIds,
        baseUsdcAtomic: invoice.baseUsdcAtomic,
        ogNeuron: invoice.ogNeuron,
        ...(invoice.ogOracle === undefined ? {} : { ogOracle: invoice.ogOracle }),
        bnbOracle: invoice.bnbOracle,
        ...(invoice.arbitrumSequencer === undefined ? {} : { arbitrumSequencer: invoice.arbitrumSequencer }),
        quoteTimestamp: invoice.quoteTimestamp,
        attempt: invoice.attempt,
      });
      if (JSON.stringify(canonical, bigintJson) !== JSON.stringify(invoice, bigintJson)) {
        throw new Error("Invoice quote is not canonical.");
      }
      const current = this.#invoices.get(invoice.invoiceId);
      if (current !== undefined) return copy(current);
      const account = this.#accounts.get(invoice.accountId);
      if (account === undefined || (account.status !== "active" && account.status !== "closing")) {
        throw new Error("Invoice account is not collectable.");
      }
      if (
        account.status === "closing" &&
        account.closeFlushInvoiceId !== undefined &&
        account.closeFlushInvoiceId !== invoice.invoiceId
      ) {
        throw new Error("Billing close already owns another flush invoice.");
      }
      if (account.status === "closing") {
        const allActual = [...this.#usages.values()]
          .filter((usage) => usage.accountId === invoice.accountId && usage.state === "actual")
          .map((usage) => usage.usageId)
          .sort();
        if (JSON.stringify(allActual) !== JSON.stringify(invoice.usageIds)) {
          throw new Error("Billing close flush must claim all proven actual Usage together.");
        }
      }
      let baseUsdcAtomic = 0n;
      let ogNeuron = 0n;
      for (const usageId of invoice.usageIds) {
        const usage = this.#usages.get(usageId);
        if (
          usage === undefined || usage.accountId !== invoice.accountId || usage.state !== "actual" ||
          usage.actualAtomic === undefined || usage.actualAtomic <= 0n || this.#nonterminalInvoiceByUsage.has(usageId)
        ) {
          throw new Error("Invoice member is not claimable.");
        }
        if (usage.asset === "USDC_BASE") baseUsdcAtomic += usage.actualAtomic;
        else ogNeuron += usage.actualAtomic;
      }
      const expected = buildQuotedInvoice({
        accountId: invoice.accountId,
        usageIds: invoice.usageIds,
        baseUsdcAtomic,
        ogNeuron,
        ...(invoice.ogOracle === undefined ? {} : { ogOracle: invoice.ogOracle }),
        bnbOracle: invoice.bnbOracle,
        ...(invoice.arbitrumSequencer === undefined ? {} : { arbitrumSequencer: invoice.arbitrumSequencer }),
        quoteTimestamp: invoice.quoteTimestamp,
        attempt: invoice.attempt,
      });
      if (JSON.stringify(expected, bigintJson) !== JSON.stringify(invoice, bigintJson)) {
        throw new Error("Invoice quote does not match its actual members.");
      }
      for (const usageId of invoice.usageIds) {
        const usage = this.#usages.get(usageId);
        if (usage === undefined) throw new Error("Invoice member disappeared.");
        this.#usages.set(usageId, { ...usage, state: "claimed", invoiceId: invoice.invoiceId, version: usage.version + 1n, updatedAt: invoice.createdAt });
        this.#nonterminalInvoiceByUsage.set(usageId, invoice.invoiceId);
      }
      if (account.status === "closing" && account.closeFlushInvoiceId === undefined) {
        this.#accounts.set(account.accountId, { ...account, closeFlushInvoiceId: invoice.invoiceId, updatedAt: invoice.createdAt });
      }
      this.#invoices.set(invoice.invoiceId, copy(invoice));
      return copy(invoice);
    });
  }

  async getInvoice(invoiceId: string): Promise<Invoice | null> {
    const row = this.#invoices.get(invoiceId);
    return row === undefined ? null : copy(row);
  }

  async listInvoices(accountId: string): Promise<readonly Invoice[]> {
    return [...this.#invoices.values()]
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => a.createdAt - b.createdAt || a.invoiceId.localeCompare(b.invoiceId))
      .map(copy);
  }

  #invoiceFence(invoiceId: string, expectedVersion: bigint): Invoice {
    const invoice = this.#invoices.get(invoiceId);
    if (invoice === undefined || invoice.version !== expectedVersion) throw new Error("Stale Invoice version.");
    return invoice;
  }

  #releaseInvoiceMembers(invoice: Invoice, now: number): void {
    for (const usageId of invoice.usageIds) {
      const usage = this.#usages.get(usageId);
      if (usage === undefined || usage.state !== "claimed" || usage.invoiceId !== invoice.invoiceId) throw new Error("Invoice member claim drifted.");
      const released: Usage = { ...usage, state: "actual", version: usage.version + 1n, updatedAt: now };
      delete (released as { invoiceId?: string }).invoiceId;
      this.#usages.set(usageId, released);
      this.#nonterminalInvoiceByUsage.delete(usageId);
    }
  }

  async expireQuotedInvoice(invoiceId: string, expectedVersion: bigint, now: number): Promise<Invoice> {
    ensureNow(now);
    return this.#atomic(() => {
      const invoice = this.#invoiceFence(invoiceId, expectedVersion);
      if (invoice.state === "expired") return copy(invoice);
      if (invoice.state !== "quoted" || now <= invoice.quoteExpiresAt || invoice.journalDecisionId !== undefined || invoice.preparedIntentDigest !== undefined) {
        throw new Error("Only a never-bound expired quote may release its members.");
      }
      this.#releaseInvoiceMembers(invoice, now);
      const account = this.#accounts.get(invoice.accountId);
      if (account?.closeFlushInvoiceId === invoice.invoiceId) {
        const released = { ...account, updatedAt: now };
        delete (released as { closeFlushInvoiceId?: string }).closeFlushInvoiceId;
        this.#accounts.set(account.accountId, released);
      }
      const updated: Invoice = { ...invoice, state: "expired", version: invoice.version + 1n, updatedAt: now };
      this.#invoices.set(invoiceId, updated);
      return copy(updated);
    });
  }

  async markInvoiceSubmitting(invoiceId: string, expectedVersion: bigint, decisionId: string, intent: PreparedInvoiceIntent, preparedHandle: object, now: number): Promise<PreparedInvoiceBinding> {
    ensureNow(now);
    return this.#atomic(() => {
      const invoice = this.#invoiceFence(invoiceId, expectedVersion);
      const account = this.#accounts.get(invoice.accountId);
      if (
        invoice.state !== "quoted" || account === undefined ||
        now + 30 > invoice.quoteExpiresAt || intent.relayIntentExpiresAt <= now ||
        intent.relayIntentExpiresAt > intent.relayQuoteExpiresAt ||
        intent.relayQuoteExpiresAt > invoice.quoteExpiresAt || intent.chainId !== 56 ||
        !isAddress(intent.wallet, { strict: false }) ||
        intent.wallet.toLowerCase() !== account.walletAddress.toLowerCase() ||
        !isAddress(intent.collector, { strict: false }) ||
        !/^0x[0-9a-fA-F]{64}$/.test(intent.digest) ||
        !/^0x[0-9a-fA-F]+$/.test(intent.calldata) ||
        intent.valueWei !== invoice.bnbWei || intent.sessionGeneration < 0n ||
        typeof preparedHandle !== "object" || preparedHandle === null
      ) {
        throw new Error("Invoice cannot cross the submitting ambiguity boundary.");
      }
      const updated: Invoice = {
        ...invoice,
        state: "submitting",
        journalDecisionId: decisionId,
        preparedIntentDigest: intent.digest,
        preparedChainId: intent.chainId,
        preparedWallet: intent.wallet.toLowerCase(),
        preparedCollector: intent.collector.toLowerCase(),
        preparedCalldata: intent.calldata.toLowerCase(),
        preparedValueWei: intent.valueWei,
        preparedSessionGeneration: intent.sessionGeneration,
        relayQuoteExpiresAt: intent.relayQuoteExpiresAt,
        relayIntentExpiresAt: intent.relayIntentExpiresAt,
        version: invoice.version + 1n,
        updatedAt: now,
      };
      this.#invoices.set(invoiceId, updated);
      const opaque = Symbol(intent.digest);
      livePreparedInvoiceBindings.add(opaque);
      return {
        invoice: copy(updated),
        bindingToken: {
          opaque,
          preparedHandle,
          invoiceId: updated.invoiceId,
          invoiceVersion: updated.version,
          preparedDigest: intent.digest,
        },
      };
    });
  }

  async bindInvoiceCallsId(
    invoiceId: string,
    expectedVersion: bigint,
    callsId: string,
    now: number,
    binding?: Readonly<{ decisionId: string; witnessDigest: Hex }>,
  ): Promise<Invoice> {
    ensureNow(now);
    return this.#atomic(() => {
      const invoice = this.#invoices.get(invoiceId);
      if (!/^0x[0-9a-f]{64}$/.test(callsId)) {
        throw new Error("Invoice callsId must be canonical lowercase bytes32.");
      }
      if (
        invoice === undefined ||
        (invoice.state !== "submitting" && invoice.state !== "unknown") ||
        binding === undefined ||
        invoice.journalDecisionId === undefined ||
        invoice.journalDecisionId !== binding.decisionId ||
        invoice.preparedIntentDigest === undefined ||
        invoice.preparedIntentDigest.toLowerCase() !== binding.witnessDigest.toLowerCase() ||
        invoice.preparedChainId !== 56 ||
        invoice.preparedWallet === undefined ||
        invoice.preparedCollector === undefined ||
        invoice.preparedCalldata === undefined ||
        invoice.preparedValueWei !== invoice.bnbWei ||
        invoice.preparedSessionGeneration === undefined ||
        invoice.relayQuoteExpiresAt === undefined ||
        invoice.relayIntentExpiresAt === undefined
      ) {
        throw new Error("Invoice callsId requires a transmitted invoice.");
      }
      if (invoice.callsId !== undefined) {
        if (invoice.callsId !== callsId) throw new Error("Invoice callsId is immutable.");
        return copy(invoice);
      }
      if (invoice.version !== expectedVersion) throw new Error("Invoice version conflict.");
      const updated: Invoice = { ...invoice, callsId, version: invoice.version + 1n, updatedAt: now };
      this.#invoices.set(invoiceId, updated);
      return copy(updated);
    });
  }

  async projectInvoicePaid(invoiceId: string, expectedVersion: bigint, paidAt: number, allocations: ReadonlyMap<string, bigint>, evidence: Readonly<{ callsId: string; transactionHash: string }>, now: number): Promise<Invoice> {
    ensureNow(now); ensureNow(paidAt);
    return this.#atomic(() => {
      const invoice = this.#invoiceFence(invoiceId, expectedVersion);
      if (invoice.state !== "submitting" && invoice.state !== "unknown") throw new Error("Only transmitted invoices can become paid.");
      let sum = 0n;
      for (const usageId of invoice.usageIds) sum += allocations.get(usageId) ?? -invoice.usdMicros - 1n;
      if (sum !== invoice.usdMicros || allocations.size !== invoice.usageIds.length) throw new Error("Invoice allocation does not conserve USD micros.");
      for (const usageId of invoice.usageIds) {
        const usage = this.#usages.get(usageId);
        const allocated = allocations.get(usageId);
        if (usage === undefined || allocated === undefined || allocated < 0n || usage.state !== "claimed" || usage.invoiceId !== invoiceId) throw new Error("Invoice member drifted.");
        this.#ledger.set(usageId, { usageId, accountId: usage.accountId, agentId: usage.agentId, sessionTicketHash: usage.sessionTicketHash, invoiceId, usdMicros: allocated, paidAt });
        this.#usages.set(usageId, { ...usage, state: "invoiced", version: usage.version + 1n, updatedAt: now });
        this.#nonterminalInvoiceByUsage.delete(usageId);
      }
      const updated: Invoice = { ...invoice, state: "paid", callsId: evidence.callsId, transactionHash: evidence.transactionHash, version: invoice.version + 1n, updatedAt: now };
      this.#invoices.set(invoiceId, updated);
      return copy(updated);
    });
  }

  async projectInvoiceRolledBack(invoiceId: string, expectedVersion: bigint, evidence: Readonly<{ callsId: string; transactionHash: string }>, now: number): Promise<Invoice> {
    ensureNow(now);
    return this.#atomic(() => {
      const invoice = this.#invoiceFence(invoiceId, expectedVersion);
      if (invoice.state !== "submitting" && invoice.state !== "unknown") throw new Error("Only transmitted invoices can roll back.");
      this.#releaseInvoiceMembers(invoice, now);
      const account = this.#accounts.get(invoice.accountId);
      if (account?.closeFlushInvoiceId === invoice.invoiceId) {
        const released = { ...account, updatedAt: now };
        delete (released as { closeFlushInvoiceId?: string }).closeFlushInvoiceId;
        this.#accounts.set(account.accountId, released);
      }
      const updated: Invoice = { ...invoice, state: "rolled_back", callsId: evidence.callsId, transactionHash: evidence.transactionHash, version: invoice.version + 1n, updatedAt: now };
      this.#invoices.set(invoiceId, updated);
      return copy(updated);
    });
  }

  async markInvoiceUnknown(invoiceId: string, expectedVersion: bigint, evidenceDigest: string, now: number): Promise<Invoice> {
    ensureNow(now);
    return this.#atomic(() => {
      const invoice = this.#invoiceFence(invoiceId, expectedVersion);
      if (invoice.state !== "submitting") throw new Error("Only submitting invoices become unknown.");
      const updated: Invoice = { ...invoice, state: "unknown", preparedIntentDigest: invoice.preparedIntentDigest ?? evidenceDigest, version: invoice.version + 1n, updatedAt: now };
      this.#invoices.set(invoiceId, updated);
      return copy(updated);
    });
  }

  async listLedger(accountId: string): Promise<readonly BillingSpendLedgerEntry[]> {
    return [...this.#ledger.values()].filter((entry) => entry.accountId === accountId).sort((a, b) => a.paidAt - b.paidAt || a.usageId.localeCompare(b.usageId)).map(copy);
  }

  async getOgReconciliation(usageId: string): Promise<OgReconciliationCursor | null> {
    const row = this.#ogReconciliations.get(usageId);
    return row === undefined ? null : copy(row);
  }

  async putOgReconciliation(
    cursor: OgReconciliationCursor,
    expectedVersion: bigint | null,
  ): Promise<OgReconciliationCursor> {
    return this.#atomic(() => {
      ensureNow(cursor.nextRunAt);
      ensureNow(cursor.updatedAt);
      const current = this.#ogReconciliations.get(cursor.usageId);
      if (
        (expectedVersion === null && current !== undefined) ||
        (expectedVersion !== null && current?.version !== expectedVersion) ||
        cursor.version !== (expectedVersion ?? -1n) + 1n ||
        new Set(cursor.seenHistoryIds).size !== cursor.seenHistoryIds.length ||
        cursor.seenHistoryIds.length > MAX_SEEN_OG_HISTORY_IDS ||
        cursor.nextCursor !== undefined && cursor.seenHistoryIds.length >= MAX_SEEN_OG_HISTORY_IDS ||
        cursor.nextCursor === undefined && cursor.haltReason === undefined &&
          cursor.seenHistoryIds.length !== 0 ||
        cursor.seenHistoryIds.some((id) => !/^(0|[1-9][0-9]*)$/.test(id)) ||
        cursor.haltReason !== undefined && cursor.haltReason !== "HISTORY_SCAN_LIMIT" ||
        cursor.nextCursor !== undefined && (cursor.nextCursor === "" || cursor.nextCursor.length > 4_096)
      ) {
        throw new Error("0G reconciliation cursor fence failed.");
      }
      const stored = copy(cursor);
      this.#ogReconciliations.set(cursor.usageId, stored);
      return copy(stored);
    });
  }

  async close(): Promise<void> {
    await this.#atomic(() => {
      this.#accounts.clear(); this.#walletAccounts.clear(); this.#grants.clear(); this.#tickets.clear();
      this.#replays.clear(); this.#logical.clear(); this.#usages.clear(); this.#debitIdentities.clear();
      this.#leases.clear(); this.#invoices.clear(); this.#nonterminalInvoiceByUsage.clear(); this.#ledger.clear();
      this.#ogReconciliations.clear();
      this.#billingWorkerAccountCursor = undefined;
    });
  }
}
