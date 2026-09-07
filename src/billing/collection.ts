import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { BILLING_RELAY_RESERVE_WEI, BILLING_THRESHOLD_USD_MICROS, MIN_COLLECTION_PREPARE_LIFETIME_SEC, MIN_COLLECTION_SEND_LIFETIME_SEC } from "./config.js";
import {
  billingCollectorCalldata,
  proveBillingCollection,
  type RpcReceiptObservation,
} from "./evidence.js";
import { assertOracleQuoteSet } from "./oracles.js";
import { allocateInvoiceMembers, allocateInvoiceUsdMicros, buildQuotedInvoice } from "./math.js";
import {
  consumePreparedInvoiceBinding,
  type BillingStore,
  type PreparedInvoiceBindingToken,
} from "./store.js";
import type { BillingAccount, Invoice, OracleSnapshot, Usage } from "./types.js";
import type { ExecutionJournal, JournalEntry, JournalExternalRef } from "../store/journal.js";

export function billingCollectionDecisionId(accountId: string, invoiceId: string, attempt: bigint): string {
  return `billing:${keccak256(stringToBytes(JSON.stringify({
    accountId,
    invoiceId: invoiceId.toLowerCase(),
    attempt: attempt.toString(),
  })))}`;
}

export type DueInvoiceInput = Readonly<{
  accountId: string;
  usages: readonly Usage[];
  bnbOracle: OracleSnapshot;
  ogOracle?: OracleSnapshot;
  arbitrumSequencer?: OracleSnapshot;
  quoteTimestamp: number;
  attempt: bigint;
  flushBelowThreshold: boolean;
  accountRemainingRollingUsdMicros: bigint;
  agentRemainingRollingUsdMicros: ReadonlyMap<string, bigint>;
}>;

export function quoteDueInvoice(input: DueInvoiceInput): Invoice | null {
  const actual = input.usages
    .filter((usage) => usage.accountId === input.accountId && usage.state === "actual" && usage.actualAtomic !== undefined)
    .sort((a, b) => a.createdAt - b.createdAt || a.usageId.localeCompare(b.usageId));
  if (actual.length === 0 || input.accountRemainingRollingUsdMicros < 0n) return null;
  const selected: Usage[] = [];
  let invoice: Invoice | null = null;
  for (const usage of actual) {
    const candidate = [...selected, usage];
    let baseUsdcAtomic = 0n;
    let ogNeuron = 0n;
    const ogWeights = new Map<string, bigint>();
    for (const member of candidate) {
      if (member.actualAtomic === undefined) throw new Error("Actual Usage lacks its exact debit.");
      if (member.asset === "USDC_BASE") baseUsdcAtomic += member.actualAtomic;
      else {
        ogNeuron += member.actualAtomic;
        ogWeights.set(member.usageId, member.actualAtomic);
      }
    }
    assertOracleQuoteSet({ ogNeuron, bnb: input.bnbOracle, ...(input.ogOracle === undefined ? {} : { og: input.ogOracle }), ...(input.arbitrumSequencer === undefined ? {} : { sequencer: input.arbitrumSequencer }), quoteTimestamp: input.quoteTimestamp });
    const candidateInvoice = buildQuotedInvoice({
      accountId: input.accountId,
      usageIds: candidate.map((member) => member.usageId).sort(),
      baseUsdcAtomic,
      ogNeuron,
      ...(input.ogOracle === undefined ? {} : { ogOracle: input.ogOracle }),
      bnbOracle: input.bnbOracle,
      ...(input.arbitrumSequencer === undefined ? {} : { arbitrumSequencer: input.arbitrumSequencer }),
      quoteTimestamp: input.quoteTimestamp,
      attempt: input.attempt,
    });
    const allocations = new Map<string, bigint>();
    for (const member of candidate) {
      if (member.asset === "USDC_BASE") allocations.set(member.usageId, member.actualAtomic!);
    }
    if (ogWeights.size > 0) {
      const ogUsdMicros = candidateInvoice.usdMicros - baseUsdcAtomic;
      for (const [usageId, value] of allocateInvoiceUsdMicros(ogUsdMicros, ogWeights)) allocations.set(usageId, value);
    }
    const byAgent = new Map<string, bigint>();
    for (const member of candidate) byAgent.set(member.agentId, (byAgent.get(member.agentId) ?? 0n) + (allocations.get(member.usageId) ?? 0n));
    const fits = candidateInvoice.usdMicros <= input.accountRemainingRollingUsdMicros &&
      [...byAgent].every(([agentId, value]) => value <= (input.agentRemainingRollingUsdMicros.get(agentId) ?? -1n));
    if (!fits) break;
    selected.push(usage);
    invoice = candidateInvoice;
  }
  if (invoice === null) return null;
  if (!input.flushBelowThreshold && invoice.usdMicros < BILLING_THRESHOLD_USD_MICROS) return null;
  return invoice;
}

export function assertCollectability(balanceWei: bigint, remainingDayCapWei: bigint, invoiceBnbWei: bigint): void {
  const required = invoiceBnbWei + BILLING_RELAY_RESERVE_WEI;
  if (balanceWei < required || remainingDayCapWei < required) throw new Error("PAYMENT_DUE");
}

export type PreparedCollection = Readonly<{
  handle: object;
  digest: Hex;
  chainId: 56;
  wallet: Address;
  collector: Address;
  calldata: Hex;
  value: bigint;
  sessionGeneration: bigint;
  relayQuoteExpiresAt: number;
  relayIntentExpiresAt: number;
}>;

export type DurablePreparedCollectionWitness = Omit<PreparedCollection, "handle">;

export type CollectionRelay = Readonly<{
  prepare(input: Readonly<{
    wallet: Address;
    collector: Address;
    calldata: Hex;
    value: bigint;
    sessionGeneration: bigint;
    maxExpiresAt: number;
  }>): Promise<PreparedCollection>;
  signAndSend(prepared: PreparedCollection, bindingToken: PreparedInvoiceBindingToken): Promise<Readonly<{ callsId?: Hex }>>;
}>;

export type CollectionMeterReader = () => Promise<Readonly<{ balanceWei: bigint; remainingDayCapWei: bigint }>>;

function canonicalCallsId(value: string): Hex {
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error("Relay callsId must be canonical lowercase bytes32.");
  }
  return value as Hex;
}

async function waitCallsIdProjectionRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(1_000, 25 * (2 ** Math.min(attempt, 5)));
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function persistReturnedCallsId(input: Readonly<{
  store: BillingStore;
  journal: ExecutionJournal;
  invoiceId: string;
  accountId: string;
  decisionId: string;
  witnessDigest: Hex;
  callsId: Hex;
  now: () => number;
}>): Promise<Invoice> {
  let bound: Invoice | null = null;
  for (let attempt = 0; bound === null; attempt += 1) {
    let latest: Invoice | null;
    try {
      latest = await input.store.getInvoice(input.invoiceId);
    } catch {
      await waitCallsIdProjectionRetry(attempt);
      continue;
    }
    if (latest === null) throw new Error("Returned relay callsId lost its invoice projection target.");
    if (latest.callsId !== undefined) {
      if (latest.callsId !== input.callsId) throw new Error("Returned relay callsId conflicts with the invoice projection.");
      bound = latest;
      continue;
    }
    try {
      bound = await input.store.bindInvoiceCallsId(
        latest.invoiceId,
        latest.version,
        input.callsId,
        input.now(),
        { decisionId: input.decisionId, witnessDigest: input.witnessDigest },
      );
    } catch {
      await waitCallsIdProjectionRetry(attempt);
    }
  }

  let lastJournalError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let journal: JournalEntry | null;
    try {
      journal = await input.journal.get(input.decisionId);
    } catch (error) {
      lastJournalError = error;
      await waitCallsIdProjectionRetry(attempt);
      continue;
    }
    if (journal === null) throw new Error("Returned relay callsId lost its journal projection target.");
    if (journal.externalRef.callsId !== undefined) {
      if (journal.externalRef.callsId !== input.callsId) {
        throw new Error("Returned relay callsId conflicts with the journal projection.");
      }
      return bound;
    }
    try {
      await input.journal.bindBillingCollectCallsId({
        principal: { kind: "billing_account", id: input.accountId },
        decisionId: input.decisionId,
        expectedCallsIdVersion: journal.billingCallsIdVersion,
        witnessDigest: input.witnessDigest,
        callsId: input.callsId,
      });
      return bound;
    } catch (error) {
      lastJournalError = error;
      await waitCallsIdProjectionRetry(attempt);
    }
  }
  throw lastJournalError instanceof Error
    ? lastJournalError
    : new Error("Journal callsId projection failed after durable store binding.");
}

function assertPreparedMatches(
  prepared: PreparedCollection,
  invoice: Invoice,
  wallet: Address,
  collector: Address,
  sessionGeneration: bigint,
  now: number,
  minLifetime: number,
): void {
  const expectedCalldata = billingCollectorCalldata(invoice.invoiceId as Hex, invoice.quoteExpiresAt);
  if (
    prepared.chainId !== 56 || prepared.wallet.toLowerCase() !== wallet.toLowerCase() ||
    prepared.collector.toLowerCase() !== collector.toLowerCase() || prepared.calldata !== expectedCalldata ||
    prepared.value !== invoice.bnbWei || prepared.sessionGeneration !== sessionGeneration ||
    !Number.isSafeInteger(prepared.relayQuoteExpiresAt) || !Number.isSafeInteger(prepared.relayIntentExpiresAt) ||
    prepared.relayIntentExpiresAt <= 0 || prepared.relayIntentExpiresAt > prepared.relayQuoteExpiresAt ||
    prepared.relayQuoteExpiresAt > invoice.quoteExpiresAt ||
    now + minLifetime > invoice.quoteExpiresAt || now + minLifetime > prepared.relayQuoteExpiresAt ||
    now + minLifetime > prepared.relayIntentExpiresAt
  ) throw new Error("BILLING_SESSION_INVALID");
}

export async function submitBillingInvoice(input: Readonly<{
  store: BillingStore;
  journal: ExecutionJournal;
  relay: CollectionRelay;
  meter: CollectionMeterReader;
  invoice: Invoice;
  wallet: Address;
  collector: Address;
  ownerAddress: Address;
  sessionGeneration: bigint;
  now: () => number;
}>): Promise<Invoice> {
  if (input.invoice.state !== "quoted") throw new Error("Invoice is not quoted.");
  const beforePrepare = input.now();
  if (beforePrepare + MIN_COLLECTION_PREPARE_LIFETIME_SEC > input.invoice.quoteExpiresAt) {
    throw new Error("BILLING_SESSION_INVALID");
  }
  const initialMeter = await input.meter();
  assertCollectability(initialMeter.balanceWei, initialMeter.remainingDayCapWei, input.invoice.bnbWei);
  const prepared = await input.relay.prepare({
    wallet: input.wallet,
    collector: input.collector,
    calldata: billingCollectorCalldata(input.invoice.invoiceId as Hex, input.invoice.quoteExpiresAt),
    value: input.invoice.bnbWei,
    sessionGeneration: input.sessionGeneration,
    maxExpiresAt: input.invoice.quoteExpiresAt,
  });
  assertPreparedMatches(prepared, input.invoice, input.wallet, input.collector, input.sessionGeneration, input.now(), MIN_COLLECTION_PREPARE_LIFETIME_SEC);
  const decisionId = billingCollectionDecisionId(input.invoice.accountId, input.invoice.invoiceId, input.invoice.attempt);
  const journalRef: JournalExternalRef = {
    billingPrincipal: { kind: "billing_account", id: input.invoice.accountId },
    billingInvoice: {
      invoiceId: input.invoice.invoiceId,
      preparedDigest: prepared.digest,
      wallet: input.wallet.toLowerCase(),
      collector: input.collector.toLowerCase(),
      valueWei: input.invoice.bnbWei.toString(),
      quoteExpiresAt: input.invoice.quoteExpiresAt,
      sessionGeneration: input.sessionGeneration.toString(),
    },
  };
  const submissionBinding = await input.store.markInvoiceSubmitting(input.invoice.invoiceId, input.invoice.version, decisionId, {
    digest: prepared.digest,
    chainId: prepared.chainId,
    wallet: prepared.wallet,
    collector: prepared.collector,
    calldata: prepared.calldata,
    valueWei: prepared.value,
    sessionGeneration: prepared.sessionGeneration,
    relayQuoteExpiresAt: prepared.relayQuoteExpiresAt,
    relayIntentExpiresAt: prepared.relayIntentExpiresAt,
  }, prepared.handle, input.now());
  const submitting = submissionBinding.invoice;
  try {
    const journalRow = await input.journal.begin({
      idempotencyKey: decisionId,
      agentId: input.invoice.accountId,
      ownerAddress: input.ownerAddress.toLowerCase(),
      kind: "billingCollect",
      principal: { kind: "billing_account", id: input.invoice.accountId },
      decisionId,
      externalRef: journalRef,
      nativeSpendWei: input.invoice.bnbWei,
    });
    const durableInvoice = await input.store.getInvoice(submitting.invoiceId);
    if (
      durableInvoice?.version !== submitting.version ||
      durableInvoice.preparedIntentDigest?.toLowerCase() !== prepared.digest.toLowerCase() ||
      journalRow.kind !== "billingCollect" || journalRow.principal?.kind !== "billing_account" ||
      journalRow.principal.id !== input.invoice.accountId ||
      JSON.stringify(journalRow.externalRef.billingInvoice) !== JSON.stringify(journalRef.billingInvoice) ||
      journalRow.state !== "PENDING"
    ) throw new Error("Billing collection journal identity conflict.");
    const beforeSign = input.now();
    assertPreparedMatches(prepared, submitting, input.wallet, input.collector, input.sessionGeneration, beforeSign, MIN_COLLECTION_SEND_LIFETIME_SEC);
    const signMeter = await input.meter();
    assertCollectability(signMeter.balanceWei, signMeter.remainingDayCapWei, submitting.bnbWei);
    const beforeSend = input.now();
    assertPreparedMatches(prepared, submitting, input.wallet, input.collector, input.sessionGeneration, beforeSend, MIN_COLLECTION_SEND_LIFETIME_SEC);
    const sendMeter = await input.meter();
    assertCollectability(sendMeter.balanceWei, sendMeter.remainingDayCapWei, submitting.bnbWei);
    await input.journal.markInProgress(decisionId, journalRef);
    consumePreparedInvoiceBinding(submissionBinding.bindingToken, prepared.handle, submitting);
    const sent = await input.relay.signAndSend(prepared, submissionBinding.bindingToken);
    if (sent.callsId === undefined) {
      const unknown = await input.store.markInvoiceUnknown(submitting.invoiceId, submitting.version, prepared.digest, input.now());
      await input.journal.markUnknown(decisionId, "Relay returned no calls ID after the billing submission boundary.");
      return unknown;
    }
    const callsId = canonicalCallsId(sent.callsId);
    return await persistReturnedCallsId({
      store: input.store,
      journal: input.journal,
      invoiceId: submitting.invoiceId,
      accountId: submitting.accountId,
      decisionId,
      witnessDigest: prepared.digest,
      callsId,
      now: input.now,
    });
  } catch (error) {
    const latest = await input.store.getInvoice(submitting.invoiceId);
    if (latest?.state === "submitting") {
      const unknown = await input.store.markInvoiceUnknown(latest.invoiceId, latest.version, prepared.digest, input.now());
      const journalLatest = await input.journal.get(decisionId);
      if (journalLatest?.state === "PENDING" || journalLatest?.state === "IN_PROGRESS") {
        await input.journal.markUnknown(decisionId, "Billing collection outcome is ambiguous.");
      }
      return unknown;
    }
    throw error;
  }
}

function durablePreparedWitness(invoice: Invoice): DurablePreparedCollectionWitness {
  if (
    invoice.preparedIntentDigest === undefined || invoice.preparedChainId !== 56 ||
    invoice.preparedWallet === undefined || invoice.preparedCollector === undefined ||
    invoice.preparedCalldata === undefined || invoice.preparedValueWei === undefined ||
    invoice.preparedSessionGeneration === undefined || invoice.relayQuoteExpiresAt === undefined ||
    invoice.relayIntentExpiresAt === undefined
  ) {
    throw new Error("Billing collection invoice lacks its complete durable prepared witness.");
  }
  return {
    digest: invoice.preparedIntentDigest as Hex,
    chainId: invoice.preparedChainId,
    wallet: invoice.preparedWallet as Address,
    collector: invoice.preparedCollector as Address,
    calldata: invoice.preparedCalldata as Hex,
    value: invoice.preparedValueWei,
    sessionGeneration: invoice.preparedSessionGeneration,
    relayQuoteExpiresAt: invoice.relayQuoteExpiresAt,
    relayIntentExpiresAt: invoice.relayIntentExpiresAt,
  };
}

/**
 * Restart convergence uses only the two durable local callsId projections.
 * Altana has no reviewed digest lookup: when both sides lost the handle this
 * creates a permanent UNKNOWN hold and can never trigger another send.
 */
export async function recoverBillingInvoiceCallsId(input: Readonly<{
  store: BillingStore;
  journal: ExecutionJournal;
  account: BillingAccount;
  invoice: Invoice;
  now: number;
}>): Promise<Invoice> {
  if (input.invoice.state !== "submitting" && input.invoice.state !== "unknown") return input.invoice;
  const witness = durablePreparedWitness(input.invoice);
  const decisionId = input.invoice.journalDecisionId;
  if (decisionId === undefined || input.account.accountId !== input.invoice.accountId) {
    throw new Error("Billing collection recovery identity is incomplete.");
  }
  const journalRef: JournalExternalRef = {
    billingPrincipal: { kind: "billing_account", id: input.invoice.accountId },
    billingInvoice: {
      invoiceId: input.invoice.invoiceId,
      preparedDigest: witness.digest,
      wallet: witness.wallet.toLowerCase(),
      collector: witness.collector.toLowerCase(),
      valueWei: witness.value.toString(),
      quoteExpiresAt: input.invoice.quoteExpiresAt,
      sessionGeneration: witness.sessionGeneration.toString(),
    },
  };
  let journal = await input.journal.get(decisionId);
  if (journal === null) {
    journal = await input.journal.begin({
      idempotencyKey: decisionId,
      agentId: input.invoice.accountId,
      ownerAddress: input.account.ownerAddress,
      kind: "billingCollect",
      principal: { kind: "billing_account", id: input.invoice.accountId },
      decisionId,
      externalRef: journalRef,
      nativeSpendWei: input.invoice.bnbWei,
    });
  }
  if (
    journal.kind !== "billingCollect" || journal.principal?.kind !== "billing_account" ||
    journal.principal.id !== input.invoice.accountId || journal.decisionId !== decisionId ||
    JSON.stringify(journal.externalRef.billingInvoice) !== JSON.stringify(journalRef.billingInvoice)
  ) throw new Error("Billing collection recovery journal identity conflict.");

  const storeCallsId = input.invoice.callsId?.toLowerCase() as Hex | undefined;
  const journalCallsId = journal.externalRef.callsId?.toLowerCase() as Hex | undefined;
  if (storeCallsId !== undefined && journalCallsId !== undefined && storeCallsId !== journalCallsId) {
    throw new Error("Billing collection callsId projections conflict.");
  }
  let recovered = input.invoice;
  const callsId = storeCallsId ?? journalCallsId;
  if (callsId !== undefined && storeCallsId === undefined) {
    recovered = await input.store.bindInvoiceCallsId(
      input.invoice.invoiceId,
      input.invoice.version,
      callsId,
      input.now,
      { decisionId, witnessDigest: witness.digest },
    );
  }
  if (callsId !== undefined && journalCallsId === undefined) {
    journal = await input.journal.bindBillingCollectCallsId({
      principal: { kind: "billing_account", id: input.invoice.accountId },
      decisionId,
      expectedCallsIdVersion: journal.billingCallsIdVersion,
      witnessDigest: witness.digest,
      callsId,
    });
  }
  if (callsId === undefined || recovered.state === "submitting") {
    if (recovered.state === "submitting") {
      recovered = await input.store.markInvoiceUnknown(
        recovered.invoiceId,
        recovered.version,
        witness.digest,
        input.now,
      );
    }
    if (journal.state === "PENDING" || journal.state === "IN_PROGRESS") {
      await input.journal.markUnknown(decisionId, callsId === undefined
        ? "Billing collection lost its only relay handle."
        : "Billing collection awaits canonical proof after restart.");
    }
  }
  return recovered;
}

/**
 * Project one canonical two-RPC collection proof. The billing projection is
 * written before the journal terminal state: if the process dies between the
 * two durable writes, replaying this same proof observes the terminal invoice
 * and converges the still-IN_PROGRESS/UNKNOWN journal without charging again.
 */
export async function projectBillingCollectionProof(input: Readonly<{
  store: BillingStore;
  journal: ExecutionJournal;
  invoiceId: Hex;
  wallet: Address;
  collector: Address;
  reviewedRuntimeBytecodeHash: Hex;
  callsId: Hex;
  rpcA: RpcReceiptObservation;
  rpcB: RpcReceiptObservation;
  now: number;
}>): Promise<Invoice> {
  const invoice = await input.store.getInvoice(input.invoiceId);
  if (invoice === null || invoice.journalDecisionId === undefined || invoice.preparedIntentDigest === undefined) {
    throw new Error("Billing collection invoice is not durably submission-bound.");
  }
  const journal = await input.journal.get(invoice.journalDecisionId);
  const binding = journal?.externalRef.billingInvoice;
  if (
    journal === null ||
    journal.kind !== "billingCollect" ||
    journal.principal?.kind !== "billing_account" ||
    journal.principal.id !== invoice.accountId ||
    binding === undefined ||
    binding.invoiceId.toLowerCase() !== invoice.invoiceId.toLowerCase() ||
    binding.preparedDigest.toLowerCase() !== invoice.preparedIntentDigest.toLowerCase() ||
    binding.wallet.toLowerCase() !== input.wallet.toLowerCase() ||
    binding.collector.toLowerCase() !== input.collector.toLowerCase() ||
    binding.valueWei !== invoice.bnbWei.toString() ||
    binding.quoteExpiresAt !== invoice.quoteExpiresAt ||
    (journal.externalRef.callsId !== undefined &&
      journal.externalRef.callsId.toLowerCase() !== input.callsId.toLowerCase()) ||
    (invoice.callsId !== undefined && invoice.callsId.toLowerCase() !== input.callsId.toLowerCase())
  ) {
    throw new Error("Billing collection proof does not match its durable intent.");
  }
  const proof = proveBillingCollection(
    invoice,
    input.wallet,
    input.collector,
    input.reviewedRuntimeBytecodeHash,
    input.rpcA,
    input.rpcB,
  );
  const evidence = {
    callsId: input.callsId,
    transactionHash: proof.transactionHash,
  };
  let projected: Invoice;
  if (invoice.state === "paid" || invoice.state === "rolled_back") {
    const expected = proof.outcome === "paid" ? "paid" : "rolled_back";
    if (
      invoice.state !== expected ||
      invoice.callsId?.toLowerCase() !== input.callsId.toLowerCase() ||
      invoice.transactionHash?.toLowerCase() !== proof.transactionHash.toLowerCase()
    ) {
      throw new Error("Billing collection terminal projection conflicts with canonical proof.");
    }
    projected = invoice;
  } else if (proof.outcome === "paid") {
    const usages = await input.store.listUsages(invoice.accountId);
    const allocations = allocateInvoiceMembers(invoice, usages);
    projected = await input.store.projectInvoicePaid(
      invoice.invoiceId,
      invoice.version,
      proof.paidAt,
      allocations,
      evidence,
      input.now,
    );
  } else {
    projected = await input.store.projectInvoiceRolledBack(
      invoice.invoiceId,
      invoice.version,
      evidence,
      input.now,
    );
  }
  await input.journal.resolveBillingCollection(invoice.journalDecisionId, {
    outcome: proof.outcome,
    callsId: input.callsId,
    transactionHash: proof.transactionHash,
  });
  return projected;
}
