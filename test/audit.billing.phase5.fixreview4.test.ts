import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Address, Hex } from "viem";
import { submitBillingInvoice } from "../src/billing/collection.js";
import { resolveBillingConfig, type EnabledBillingConfig } from "../src/billing/config.js";
import { createCoreBillingClients } from "../src/billing/coreClients.js";
import {
  loadBillingCustodyAndRelayPrimitives,
  type BillingCustodyAndRelayPrimitives,
} from "../src/billing/custody.js";
import { buildQuotedInvoice } from "../src/billing/math.js";
import { ORACLE_MANIFEST, validateOraclePair, type OracleObservation } from "../src/billing/oracles.js";
import { MemoryBillingStore, type BillingStore, type BillingStoreSnapshot } from "../src/billing/store.js";
import {
  resolveBillingDestinationPins,
  type BootPinnedOrigin,
  type PinnedBillingTransport,
} from "../src/billing/transport.js";
import type { AgentBillingGrant, BillingAccount, Usage } from "../src/billing/types.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";

const PAYER = "payer-account";
const NOW = 100_000;
const OWNER = "0x0000000000000000000000000000000000000001" as Address;
const WALLET = "0x0000000000000000000000000000000000000002" as Address;
const COLLECTOR = "0x0000000000000000000000000000000000000003" as Address;
const ACCOUNT_ID = "billing-account-a";
const HASH = `0x${"11".repeat(32)}` as Hex;

function enabledOgConfig(inferenceKeyId: string, managementKeyId: string): EnabledBillingConfig {
  const resolved = resolveBillingConfig({
    BILLING_ENABLED: "on",
    BILLING_X402_ENABLED: "off",
    BILLING_0G_ENABLED: "on",
    BILLING_INTERNAL_HOST: "127.0.0.1",
    BILLING_INTERNAL_PORT: "8091",
    DATABASE_URL: "postgres://loopback.invalid/billing",
    EXECUTION_MASTER_KEY: "present",
    BILLING_COLLECTOR_ADDRESS: "0x0000000000000000000000000000000000000011",
    BILLING_COLLECTOR_RUNTIME_CODEHASH: `0x${"12".repeat(32)}`,
    BILLING_TREASURY_ADDRESS: "0x0000000000000000000000000000000000000012",
    BILLING_TICKET_KEY_ID: "ticket",
    BILLING_TICKET_PUBLIC_KEY: "public",
    BILLING_BSC_RPC_A: "https://bsc-a.example",
    BILLING_BSC_RPC_B: "https://bsc-b.example",
    BILLING_BASE_RPC_A: "https://base-a.example",
    BILLING_BASE_RPC_B: "https://base-b.example",
    BILLING_ARBITRUM_RPC_A: "https://arb-a.example",
    BILLING_ARBITRUM_RPC_B: "https://arb-b.example",
    BILLING_PLATFORM_BASE_USDC_CAP_ATOMIC: "10000",
    BILLING_PLATFORM_0G_CAP_NEURON: "1000000000000000000",
    BILLING_0G_PAYER_ACCOUNT_ID: PAYER,
    BILLING_0G_INFERENCE_KEY_ID: inferenceKeyId,
    BILLING_0G_MANAGEMENT_KEY_ID: managementKeyId,
  });
  assert.equal(resolved.mode, "on");
  return resolved;
}

function emptyStore(): MemoryBillingStore {
  return new MemoryBillingStore({
    accounts: [], walletAccounts: [], grants: [], tickets: [], replays: [], logical: [],
    usages: [], debitIdentities: [], leases: [], invoices: [], nonterminalInvoiceByUsage: [],
    ledger: [], ogReconciliations: [],
  });
}

function unusedTransport(): PinnedBillingTransport {
  const unused = async (): Promise<never> => { throw new Error("unused transport"); };
  return {
    origin: (value) => value as BootPinnedOrigin,
    readRpc: unused,
    fetch: unused,
    readOracleObservation: unused,
    readReceiptObservation: unused,
    readX402AuthorizationObservation: unused,
    close: async () => undefined,
  };
}

test("fix-review4: boot refuses the same configured 0G inference and management key ID", () => {
  assert.throws(() => enabledOgConfig("shared-key", "shared-key"), /distinct|inference|management/i);
});

test("fix-review4: core refuses distinct key handles resolving to the same 0G API-key identity", async () => {
  const config = enabledOgConfig("inference-key", "management-key");
  const primitives: BillingCustodyAndRelayPrimitives = {
    signExecutionTicket: async () => "unused",
    signX402: async () => "unused",
    loadOgCredential: async (keyId) => ({
      bearerToken: keyId === "inference-key" ? "sk-token" : "mk-token",
      apiKeyId: "same-api-key-id",
      payerAccountId: PAYER,
    }),
    readBillingSession: async () => ({ generation: 1n, expiresAt: 9_999_999_999 }),
    readBillingMeter: async () => ({ balanceWei: 1n, remainingDayCapWei: 1n }),
    relayPrepare: async () => { throw new Error("unused relay"); },
    relaySend: async () => { throw new Error("unused relay"); },
    relayStatus: async () => { throw new Error("unused relay"); },
    close: async () => undefined,
  };
  await assert.rejects(
    createCoreBillingClients({ config, store: emptyStore(), primitives, transport: unusedTransport() }),
    /distinct|inference|management|identity/i,
  );
});

const VALID_MODULE = `
export async function createBillingCustodyAndRelayPrimitives() {
  return {
    signExecutionTicket: async () => "",
    signX402: async () => "",
    loadOgCredential: async () => ({ bearerToken: "", apiKeyId: "", payerAccountId: "" }),
    readBillingSession: async () => ({ generation: 0n, expiresAt: 1 }),
    readBillingMeter: async () => ({ balanceWei: 0n, remainingDayCapWei: 0n }),
    relayPrepare: async () => { throw new Error("unused"); },
    relaySend: async () => { throw new Error("unused"); },
    relayStatus: async () => ({ state: "PENDING" }),
    close: async () => undefined,
  };
}
`;

test("fix-review4: custody loader pins bytes and rejects a callback outside the closed census", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase5-custody-audit-"));
  try {
    const validPath = join(root, "valid.mjs");
    await writeFile(validPath, VALID_MODULE, "utf8");
    const validHash = createHash("sha256").update(VALID_MODULE).digest("hex");
    const config = enabledOgConfig("inference-key", "management-key");
    const valid = await loadBillingCustodyAndRelayPrimitives(config, {
      BILLING_INFRASTRUCTURE_MODULE: pathToFileURL(validPath).href,
      BILLING_INFRASTRUCTURE_MODULE_SHA256: validHash,
    });
    assert.equal(typeof valid.relaySend, "function");

    await assert.rejects(loadBillingCustodyAndRelayPrimitives(config, {
      BILLING_INFRASTRUCTURE_MODULE: pathToFileURL(validPath).href,
      BILLING_INFRASTRUCTURE_MODULE_SHA256: "00".repeat(32),
    }), /hash/i);

    const wideSource = VALID_MODULE.replace(
      "close: async () => undefined,",
      "close: async () => undefined, fetch: async () => new Response(),",
    );
    const widePath = join(root, "wide.mjs");
    await writeFile(widePath, wideSource, "utf8");
    await assert.rejects(loadBillingCustodyAndRelayPrimitives(config, {
      BILLING_INFRASTRUCTURE_MODULE: pathToFileURL(widePath).href,
      BILLING_INFRASTRUCTURE_MODULE_SHA256: createHash("sha256").update(wideSource).digest("hex"),
    }), /closed census/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fix-review4: DNS boot pinning rejects non-global IPv4 special-purpose addresses", async () => {
  const config = enabledOgConfig("inference-key", "management-key");
  let call = 0;
  await assert.rejects(resolveBillingDestinationPins(config, async () => {
    call += 1;
    return call === 1
      ? [{ address: "192.0.0.8", family: 4 as const }]
      : [{ address: `8.8.8.${call + 10}`, family: 4 as const }];
  }), /private|reserved|public|unicast/i);
});

test("fix-review4: DNS boot pinning rejects non-global IPv6 special-purpose addresses", async () => {
  const config = enabledOgConfig("inference-key", "management-key");
  let call = 0;
  await assert.rejects(resolveBillingDestinationPins(config, async () => {
    call += 1;
    return call === 1
      ? [{ address: "100::1", family: 6 as const }]
      : [{ address: `2606:4700:4700::${call}`, family: 6 as const }];
  }), /private|reserved|public|unicast/i);
});

test("fix-review4: transport refuses a configured origin port it cannot preserve", async () => {
  const config = enabledOgConfig("inference-key", "management-key");
  const nonDefaultPort: EnabledBillingConfig = {
    ...config,
    bscRpcOrigins: ["https://bsc-a.example:8443", config.bscRpcOrigins[1]],
  };
  let call = 0;
  await assert.rejects(resolveBillingDestinationPins(nonDefaultPort, async () => {
    call += 1;
    return [{ address: `8.8.8.${call + 10}`, family: 4 as const }];
  }), /port|origin|reviewed/i);
});

test("fix-review4: a known callsId survives more than the old three-attempt retry window", async () => {
  const account: BillingAccount = {
    accountId: ACCOUNT_ID,
    ownerAddress: OWNER,
    walletAddress: WALLET,
    status: "active",
    sessionFactsBytes: "0x01",
    encryptedSessionKey: "ciphertext",
    maxDailyUsdMicros: 1_000_000n,
    maxUnpaidExposureUsdMicros: 500_000n,
    thresholdUsdMicros: 100_000n,
    grantExpiresAt: NOW + 1_000,
    createdAt: NOW - 100,
    updatedAt: NOW - 100,
  };
  const usage: Usage = {
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
  const grant: AgentBillingGrant = {
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
  const snapshot: BillingStoreSnapshot = {
    accounts: [[ACCOUNT_ID, account]],
    walletAccounts: [[WALLET.toLowerCase(), ACCOUNT_ID]],
    grants: [[`${grant.grantId}\u001f${grant.generation}`, grant]],
    tickets: [], replays: [], logical: [],
    usages: [[usage.usageId, usage]],
    debitIdentities: [], leases: [], invoices: [], nonterminalInvoiceByUsage: [], ledger: [],
    ogReconciliations: [],
  };
  const backing = new MemoryBillingStore(snapshot);
  const manifest = ORACLE_MANIFEST.BNB_USD;
  const observation: OracleObservation = {
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
  const quoted = await backing.claimInvoice(buildQuotedInvoice({
    accountId: ACCOUNT_ID,
    usageIds: [usage.usageId],
    baseUsdcAtomic: 100_000n,
    ogNeuron: 0n,
    bnbOracle: validateOraclePair("BNB_USD", observation, observation, NOW),
    quoteTimestamp: NOW,
    attempt: 1n,
  }));
  let bindAttempts = 0;
  const store = new Proxy(backing, {
    get(target, property) {
      if (property === "bindInvoiceCallsId") {
        return async (...args: Parameters<BillingStore["bindInvoiceCallsId"]>) => {
          bindAttempts += 1;
          if (bindAttempts <= 3) throw new Error("simulated pre-commit store outage");
          return target.bindInvoiceCallsId(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as BillingStore;
  const callsId = `0x${"22".repeat(32)}` as Hex;
  const result = await submitBillingInvoice({
    store,
    journal: new MemoryExecutionJournal(() => NOW * 1_000),
    relay: {
      prepare: async (request) => ({
        handle: {}, digest: HASH, chainId: 56,
        wallet: request.wallet, collector: request.collector, calldata: request.calldata,
        value: request.value, sessionGeneration: request.sessionGeneration,
        relayQuoteExpiresAt: NOW + 50, relayIntentExpiresAt: NOW + 40,
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
  assert.ok(bindAttempts >= 4);
});

test("fix-review4: receipt timestamp and collector code are bound to the receipt block", async () => {
  // parseReceiptObservation is intentionally private. Keep one auditor-owned
  // structural guard on the source boundary that reduces the second RPC block
  // read: agreeing on a block number alone must never authorize ledger paidAt.
  const source = await readFile(new URL("../src/billing/transport.ts", import.meta.url), "utf8");
  assert.match(source, /receiptBlockHash\s*=\s*hash\(rawReceipt\["blockHash"\]/u);
  assert.match(source, /lookedUpBlockHash\s*=\s*hash\(receiptBlock\["hash"\]/u);
  assert.match(source, /receiptBlockHash\s*!==\s*lookedUpBlockHash/u);
  assert.match(source, /method:\s*"eth_getCode"[\s\S]{0,180}params:\s*\[getAddress\(request\.collector\),\s*blockNumber\]/u);
  assert.doesNotMatch(source, /method:\s*"eth_getCode"[\s\S]{0,180}params:\s*\[getAddress\(request\.collector\),\s*"latest"\]/u);
});

test("fix-review4: x402 positive absence reads state and logs at one explicit finalized block", async () => {
  const source = await readFile(new URL("../src/billing/transport.ts", import.meta.url), "utf8");
  assert.match(source, /finalizedBlockTag\s*=\s*`0x\$\{finalizedBlock\.toString\(16\)\}`/u);
  assert.match(source, /method:\s*"eth_call"[\s\S]{0,420}authorizationState[\s\S]{0,220}finalizedBlockTag/u);
  assert.match(source, /method:\s*"eth_getLogs"[\s\S]{0,180}toBlock:\s*finalizedBlockTag/u);
});
