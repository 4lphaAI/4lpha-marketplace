import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Address, Hex } from "viem";
import {
  submitBillingInvoice,
} from "../src/billing/collection.js";
import { buildQuotedInvoice } from "../src/billing/math.js";
import {
  ORACLE_MANIFEST,
  validateOraclePair,
  type OracleObservation,
} from "../src/billing/oracles.js";
import {
  MemoryBillingStore,
  type BillingStore,
  type BillingStoreSnapshot,
} from "../src/billing/store.js";
import type {
  AgentBillingGrant,
  BillingAccount,
  Usage,
} from "../src/billing/types.js";
import { runBillingWorkerOnce } from "../src/billing/worker.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";

const NOW = 100_000;
const OWNER = "0x0000000000000000000000000000000000000001" as Address;
const WALLET = "0x0000000000000000000000000000000000000002" as Address;
const COLLECTOR = "0x0000000000000000000000000000000000000003" as Address;
const ACCOUNT_ID = "billing-account-a";
const HASH = `0x${"11".repeat(32)}` as Hex;

function emptySnapshot(): BillingStoreSnapshot {
  return {
    accounts: [],
    walletAccounts: [],
    grants: [],
    tickets: [],
    replays: [],
    logical: [],
    usages: [],
    debitIdentities: [],
    leases: [],
    invoices: [],
    nonterminalInvoiceByUsage: [],
    ledger: [],
    ogReconciliations: [],
  };
}

function account(): BillingAccount {
  return {
    accountId: ACCOUNT_ID,
    ownerAddress: OWNER,
    walletAddress: WALLET,
    status: "active",
    sessionFactsBytes: "0x01",
    encryptedSessionKey: "ciphertext",
    maxDailyUsdMicros: 1_000_000n,
    maxUnpaidExposureUsdMicros: 500_000n,
    thresholdUsdMicros: 100000n,
    grantExpiresAt: NOW + 1_000,
    createdAt: NOW - 100,
    updatedAt: NOW - 100,
  };
}

function usage(): Usage {
  return {
    usageId: "usage-a",
    assertionNonce: "assertion-a",
    sessionTicketHash: HASH,
    accountId: ACCOUNT_ID,
    ownerAddress: OWNER,
    walletAddress: WALLET,
    agentId: "agent-a",
    grantId: "grant-a",
    generation: 1n,
    operation: "paid.cmc.quote",
    source: "x402",
    provider: "cmc",
    templateId: "cmc.quote.v1",
    logicalRequestId: "logical-a",
    requestDigest: HASH,
    payerIdentity: OWNER,
    state: "actual",
    version: 1n,
    asset: "USDC_BASE",
    reservedAtomic: 100_000n,
    reservedUsdMicros: 100_000n,
    actualAtomic: 100_000n,
    createdAt: NOW - 10,
    updatedAt: NOW - 1,
  };
}

function grant(): AgentBillingGrant {
  return {
    grantId: "grant-a",
    generation: 1n,
    accountId: ACCOUNT_ID,
    agentId: "agent-a",
    ownerAddress: OWNER,
    walletAddress: WALLET,
    issuerKeyId: "issuer-a",
    issuerPublicKey: "public-a",
    operations: ["paid.cmc.quote"],
    templateIds: ["cmc.quote.v1"],
    maxAtomic0gPerInference: 1n,
    maxUsdMicrosPerRequest: 1_000_000n,
    maxRolling24hUsdMicros: 1_000_000n,
    notBefore: NOW - 100,
    expiresAt: NOW + 1_000,
    status: "active",
    ownerConsentHash: HASH,
  };
}

function bnbObservation(): OracleObservation {
  const manifest = ORACLE_MANIFEST.BNB_USD;
  return {
    chainId: manifest.chainId,
    proxy: manifest.proxy,
    description: manifest.description,
    decimals: manifest.decimals,
    roundId: 1n,
    answer: 60_000_000_000n,
    startedAt: NOW - 10,
    updatedAt: NOW - 1,
    answeredInRound: 1n,
  };
}

function storeWithActualUsage(): MemoryBillingStore {
  const billingAccount = account();
  const actualUsage = usage();
  const billingGrant = grant();
  return new MemoryBillingStore({
    ...emptySnapshot(),
    accounts: [[ACCOUNT_ID, billingAccount]],
    walletAccounts: [[WALLET.toLowerCase(), ACCOUNT_ID]],
    grants: [[`${billingGrant.grantId}\u001f${billingGrant.generation}`, billingGrant]],
    usages: [[actualUsage.usageId, actualUsage]],
  });
}

test("fix-review3 A12: an origin-ignoring oracle primitive cannot authorize an invoice", async () => {
  const store = storeWithActualUsage();
  const fabricated = bnbObservation();
  let submits = 0;
  await assert.rejects(runBillingWorkerOnce({
    store,
    now: () => NOW,
    bscRpcOrigins: ["https://bsc-a.invalid", "https://bsc-b.invalid"],
    arbitrumRpcOrigins: ["https://arb-a.invalid", "https://arb-b.invalid"],
    // This is the attack the current adapter surface permits: ignore the
    // core-supplied label and fabricate the same already-reduced observation.
    readOracleObservation: async () => fabricated,
    reconcileOgUsage: async () => null,
    reconcileX402Usage: async () => null,
    reconcileInvoice: async () => null,
    submitInvoice: async (_account, invoice) => {
      submits += 1;
      return invoice;
    },
  }, false), /ORACLE_UNAVAILABLE/);
  assert.equal(submits, 0);
});

test("fix-review3 A7: billing-store callsId CAS rejects non-canonical bytes", async () => {
  const oracle = validateOraclePair("BNB_USD", bnbObservation(), bnbObservation(), NOW);
  const invoice = {
    ...buildQuotedInvoice({
      accountId: ACCOUNT_ID,
      usageIds: ["usage-a"],
      baseUsdcAtomic: 100_000n,
      ogNeuron: 0n,
      bnbOracle: oracle,
      quoteTimestamp: NOW,
      attempt: 1n,
    }),
    state: "unknown" as const,
  };
  const store = new MemoryBillingStore({
    ...emptySnapshot(),
    invoices: [[invoice.invoiceId, invoice]],
  });
  await assert.rejects(
    store.bindInvoiceCallsId(invoice.invoiceId, invoice.version, "not-a-canonical-calls-id", NOW + 1),
    /callsId/i,
  );
});

test("fix-review3 A7: a returned callsId survives a transient first store-bind failure", async () => {
  const backing = storeWithActualUsage();
  const oracle = validateOraclePair("BNB_USD", bnbObservation(), bnbObservation(), NOW);
  const quoted = await backing.claimInvoice(buildQuotedInvoice({
    accountId: ACCOUNT_ID,
    usageIds: ["usage-a"],
    baseUsdcAtomic: 100_000n,
    ogNeuron: 0n,
    bnbOracle: oracle,
    quoteTimestamp: NOW,
    attempt: 1n,
  }));
  let bindAttempts = 0;
  const store = new Proxy(backing, {
    get(target, property) {
      if (property === "bindInvoiceCallsId") {
        return async (...args: Parameters<BillingStore["bindInvoiceCallsId"]>) => {
          bindAttempts += 1;
          if (bindAttempts === 1) throw new Error("simulated pre-commit store outage");
          return target.bindInvoiceCallsId(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as BillingStore;
  const journal = new MemoryExecutionJournal(() => NOW * 1_000);
  const callsId = `0x${"22".repeat(32)}` as Hex;
  const result = await submitBillingInvoice({
    store,
    journal,
    relay: {
      prepare: async (request) => ({
        handle: {},
        digest: HASH,
        chainId: 56,
        wallet: request.wallet,
        collector: request.collector,
        calldata: request.calldata,
        value: request.value,
        sessionGeneration: request.sessionGeneration,
        relayQuoteExpiresAt: NOW + 50,
        relayIntentExpiresAt: NOW + 40,
      }),
      signAndSend: async () => ({ callsId }),
    },
    meter: async () => ({ balanceWei: 10n ** 18n, remainingDayCapWei: 10n ** 18n }),
    invoice: quoted,
    wallet: WALLET,
    collector: COLLECTOR,
    ownerAddress: OWNER,
    sessionGeneration: 1n,
    now: () => NOW + 1,
  });
  assert.equal(result.callsId, callsId);
  assert.ok(bindAttempts >= 2, "the known relay handle must not be discarded after one failed store write");
});

test("fix-review3 A7: generic journal transitions cannot terminalize billingCollect without canonical proof", async () => {
  const journal = new MemoryExecutionJournal(() => NOW * 1_000);
  const decisionId = `billing:${"33".repeat(32)}`;
  const externalRef = {
    billingPrincipal: { kind: "billing_account" as const, id: ACCOUNT_ID },
    billingInvoice: {
      invoiceId: HASH,
      preparedDigest: HASH,
      wallet: WALLET.toLowerCase(),
      collector: COLLECTOR.toLowerCase(),
      valueWei: "1",
      quoteExpiresAt: NOW + 60,
      sessionGeneration: "1",
    },
  };
  await journal.begin({
    idempotencyKey: decisionId,
    agentId: ACCOUNT_ID,
    ownerAddress: OWNER,
    kind: "billingCollect",
    principal: externalRef.billingPrincipal,
    decisionId,
    externalRef,
    nativeSpendWei: 1n,
  });
  await journal.markInProgress(decisionId, externalRef);
  await assert.rejects(journal.markCommitted(decisionId), /canonical|billing/i);
});

test("fix-review3 A3: legacy migration installs logical and assertion uniqueness, not only new-table DDL", async () => {
  const source = await readFile(new URL("../src/billing/postgres.ts", import.meta.url), "utf8");
  const start = source.indexOf("const BILLING_IDENTITIES_MIGRATION_DDL");
  const end = source.indexOf("const BILLING_X402_IDENTITY_INDEX_DDL");
  assert.ok(start >= 0 && end > start);
  const migration = source.slice(start, end);
  assert.match(migration, /unique[\s\S]*grant_id[\s\S]*logical_request_id/i);
  assert.match(migration, /unique[\s\S]*grant_id[\s\S]*assertion_nonce/i);
});

test("fix-review3 A9: a continuing cursor never stores 10,000 IDs, including a halted row", async () => {
  const store = new MemoryBillingStore();
  await assert.rejects(store.putOgReconciliation({
    usageId: "usage-history-cap",
    version: 0n,
    nextCursor: "request-cursor",
    seenHistoryIds: Array.from({ length: 10_000 }, (_value, index) => String(index + 1)),
    haltReason: "HISTORY_SCAN_LIMIT",
    scanGeneration: 1n,
    attemptCount: 1n,
    nextRunAt: NOW,
    updatedAt: NOW,
  }, null));
});
