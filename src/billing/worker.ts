import { quoteDueInvoice } from "./collection.js";
import {
  assertTransportOracleProvenance,
  validateOraclePair,
  type OracleObservation,
} from "./oracles.js";
import type { BillingStore } from "./store.js";
import type { BillingAccount, Invoice, Usage } from "./types.js";

export type BillingWorkerAccountResult = Readonly<{
  accountId: string;
  action: "none" | "would_reconcile" | "would_quote" | "reconciled" | "submitted" | "closed" | "deferred";
  invoiceId?: string;
}>;

export const MAX_BILLING_WORKER_ACCOUNTS_PER_PASS = 64;
export const MAX_BILLING_WORKER_ROWS_PER_ACCOUNT = 2_048;
export const MAX_BILLING_WORKER_ROWS_PER_PASS = 8_192;
export const MAX_BILLING_WORKER_RUNTIME_MS = 30_000;

export type BillingWorkerDeps = Readonly<{
  store: BillingStore;
  now: () => number;
  bscRpcOrigins: readonly [string, string];
  arbitrumRpcOrigins: readonly [string, string];
  readOracleObservation(origin: string, feed: "0G_USD" | "BNB_USD" | "ARBITRUM_SEQUENCER"): Promise<OracleObservation>;
  reconcileOgUsage(usage: Usage): Promise<Usage | null>;
  reconcileX402Usage(usage: Usage): Promise<Usage | null>;
  reconcileInvoice(invoice: Invoice): Promise<Invoice | null>;
  submitInvoice(account: BillingAccount, invoice: Invoice): Promise<Invoice>;
}>;

export type OracleObservationPair = Readonly<{
  originA: string;
  observationA: OracleObservation;
  originB: string;
  observationB: OracleObservation;
}>;

async function readQuoteOracles(
  deps: BillingWorkerDeps,
  origins: readonly [string, string],
  feed: "0G_USD" | "BNB_USD" | "ARBITRUM_SEQUENCER",
): Promise<OracleObservationPair> {
  const [originA, originB] = origins;
  if (originA === "" || originB === "" || originA === originB) throw new Error("ORACLE_UNAVAILABLE");
  const [observationA, observationB] = await Promise.all([
    deps.readOracleObservation(originA, feed),
    deps.readOracleObservation(originB, feed),
  ]);
  return { originA, observationA, originB, observationB };
}

function reduceOraclePair(
  feed: "0G_USD" | "BNB_USD" | "ARBITRUM_SEQUENCER",
  pair: OracleObservationPair,
  now: number,
) {
  if (pair.originA === "" || pair.originB === "" || pair.originA === pair.originB) {
    throw new Error("ORACLE_UNAVAILABLE");
  }
  assertTransportOracleProvenance(pair.observationA, pair.originA, feed);
  assertTransportOracleProvenance(pair.observationB, pair.originB, feed);
  return validateOraclePair(feed, pair.observationA, pair.observationB, now);
}

function grantKey(grantId: string, generation: bigint): string {
  return `${grantId}\u001f${generation}`;
}

/** One bounded worker pass. Every network/signing seam is injected and dry-run calls none. */
export async function runBillingWorkerOnce(
  deps: BillingWorkerDeps,
  dryRun: boolean,
): Promise<readonly BillingWorkerAccountResult[]> {
  const now = deps.now();
  const deadlineMs = Date.now() + MAX_BILLING_WORKER_RUNTIME_MS;
  const results: BillingWorkerAccountResult[] = [];
  let rowsObserved = 0;
  const accounts = dryRun || deps.store.claimBillingWorkerAccountBatch === undefined
    ? (await deps.store.listAccounts()).slice(0, MAX_BILLING_WORKER_ACCOUNTS_PER_PASS)
    : await deps.store.claimBillingWorkerAccountBatch(MAX_BILLING_WORKER_ACCOUNTS_PER_PASS);
  accountLoop: for (const account of accounts) {
    if (!dryRun && Date.now() >= deadlineMs) break;
    let usages = await deps.store.listUsages(account.accountId);
    let invoices = await deps.store.listInvoices(account.accountId);
    let accountRowsObserved = usages.length + invoices.length;
    rowsObserved += accountRowsObserved;
    if (
      accountRowsObserved > MAX_BILLING_WORKER_ROWS_PER_ACCOUNT ||
      rowsObserved > MAX_BILLING_WORKER_ROWS_PER_PASS
    ) {
      results.push({ accountId: account.accountId, action: "deferred" });
      continue;
    }
    const needsReconciliation = usages.some((usage) => usage.state === "unknown") ||
      invoices.some((invoice) => invoice.state === "submitting" || invoice.state === "unknown" || invoice.state === "quoted" && now > invoice.quoteExpiresAt);
    if (dryRun) {
      const hasActual = usages.some((usage) => usage.state === "actual");
      results.push({
        accountId: account.accountId,
        action: needsReconciliation ? "would_reconcile" : hasActual ? "would_quote" : "none",
      });
      continue;
    }

    await deps.store.reclaimPreparedLease(account.accountId, now);
    for (const invoice of invoices) {
      if (Date.now() >= deadlineMs) break accountLoop;
      if (invoice.state !== "quoted" || now <= invoice.quoteExpiresAt) continue;
      try {
        await deps.store.expireQuotedInvoice(invoice.invoiceId, invoice.version, now);
      } catch (error) {
        const latest = await deps.store.getInvoice(invoice.invoiceId);
        if (latest === null || latest.version === invoice.version || latest.state === "quoted") throw error;
      }
    }
    usages = await deps.store.listUsages(account.accountId);
    invoices = await deps.store.listInvoices(account.accountId);
    accountRowsObserved += usages.length + invoices.length;
    rowsObserved += usages.length + invoices.length;
    if (
      accountRowsObserved > MAX_BILLING_WORKER_ROWS_PER_ACCOUNT ||
      rowsObserved > MAX_BILLING_WORKER_ROWS_PER_PASS
    ) {
      results.push({ accountId: account.accountId, action: "deferred" });
      continue;
    }
    for (const usage of usages) {
      if (Date.now() >= deadlineMs) break accountLoop;
      if (usage.state === "unknown" && usage.source === "0g") await deps.reconcileOgUsage(usage);
      if (usage.state === "unknown" && usage.source === "x402") await deps.reconcileX402Usage(usage);
    }
    for (const invoice of invoices) {
      if (Date.now() >= deadlineMs) break accountLoop;
      if (invoice.state === "submitting" || invoice.state === "unknown") await deps.reconcileInvoice(invoice);
    }
    usages = await deps.store.listUsages(account.accountId);
    invoices = await deps.store.listInvoices(account.accountId);
    accountRowsObserved += usages.length + invoices.length;
    rowsObserved += usages.length + invoices.length;
    if (
      accountRowsObserved > MAX_BILLING_WORKER_ROWS_PER_ACCOUNT ||
      rowsObserved > MAX_BILLING_WORKER_ROWS_PER_PASS
    ) {
      results.push({ accountId: account.accountId, action: "deferred" });
      continue;
    }
    if (invoices.some((invoice) => invoice.state === "quoted" || invoice.state === "submitting" || invoice.state === "unknown")) {
      results.push({ accountId: account.accountId, action: needsReconciliation ? "reconciled" : "none" });
      continue;
    }
    if (account.status !== "active" && account.status !== "closing") {
      results.push({ accountId: account.accountId, action: needsReconciliation ? "reconciled" : "none" });
      continue;
    }
    const actual = usages.filter((usage) => usage.state === "actual");
    if (actual.length === 0) {
      if (account.status === "closing") {
        await deps.store.closeAccountIfSettled(account.accountId, now);
        results.push({ accountId: account.accountId, action: "closed" });
      } else results.push({ accountId: account.accountId, action: needsReconciliation ? "reconciled" : "none" });
      continue;
    }

    const hasOg = actual.some((usage) => usage.asset === "0G_MAINNET");
    const bnbOracle = reduceOraclePair(
      "BNB_USD",
      await readQuoteOracles(deps, deps.bscRpcOrigins, "BNB_USD"),
      now,
    );
    const ogOracle = hasOg
      ? reduceOraclePair("0G_USD", await readQuoteOracles(deps, deps.arbitrumRpcOrigins, "0G_USD"), now)
      : undefined;
    const arbitrumSequencer = hasOg
      ? reduceOraclePair(
          "ARBITRUM_SEQUENCER",
          await readQuoteOracles(deps, deps.arbitrumRpcOrigins, "ARBITRUM_SEQUENCER"),
          now,
        )
      : undefined;
    const [ledger, grants] = await Promise.all([
      deps.store.listLedger(account.accountId),
      deps.store.listGrants(account.accountId),
    ]);
    accountRowsObserved += ledger.length + grants.length;
    rowsObserved += ledger.length + grants.length;
    if (
      accountRowsObserved > MAX_BILLING_WORKER_ROWS_PER_ACCOUNT ||
      rowsObserved > MAX_BILLING_WORKER_ROWS_PER_PASS
    ) {
      results.push({ accountId: account.accountId, action: "deferred" });
      continue;
    }
    const recent = ledger.filter((entry) => entry.paidAt > now - 86_400);
    const accountPaid = recent.reduce((sum, entry) => sum + entry.usdMicros, 0n);
    const accountHeadroom = account.maxDailyUsdMicros - accountPaid;
    const paidByAgent = new Map<string, bigint>();
    for (const entry of recent) paidByAgent.set(entry.agentId, (paidByAgent.get(entry.agentId) ?? 0n) + entry.usdMicros);
    const agentHeadroom = new Map<string, bigint>();
    for (const usage of actual) {
      const grant = grants.find((candidate) =>
        grantKey(candidate.grantId, candidate.generation) === grantKey(usage.grantId, usage.generation));
      if (grant === undefined) throw new Error("Actual Usage lost its authorizing billing grant.");
      const remaining = grant.maxRolling24hUsdMicros - (paidByAgent.get(usage.agentId) ?? 0n);
      const old = agentHeadroom.get(usage.agentId);
      agentHeadroom.set(usage.agentId, old === undefined || remaining < old ? remaining : old);
    }
    const flushBelowThreshold = account.status === "closing" || account.grantExpiresAt <= now + 1_800;
    const attempt = BigInt(invoices.length + 1);
    const quoted = quoteDueInvoice({
      accountId: account.accountId,
      usages,
      bnbOracle,
      ...(ogOracle === undefined ? {} : { ogOracle }),
      ...(arbitrumSequencer === undefined ? {} : { arbitrumSequencer }),
      quoteTimestamp: now,
      attempt,
      flushBelowThreshold,
      accountRemainingRollingUsdMicros: accountHeadroom,
      agentRemainingRollingUsdMicros: agentHeadroom,
    });
    if (quoted === null) {
      results.push({ accountId: account.accountId, action: needsReconciliation ? "reconciled" : "none" });
      continue;
    }
    if (account.status === "closing" && quoted.usageIds.length !== actual.length) {
      results.push({ accountId: account.accountId, action: needsReconciliation ? "reconciled" : "none" });
      continue;
    }
    const claimed = await deps.store.claimInvoice(quoted);
    const submitted = await deps.submitInvoice(account, claimed);
    results.push({ accountId: account.accountId, action: "submitted", invoiceId: submitted.invoiceId });
  }
  return results;
}
