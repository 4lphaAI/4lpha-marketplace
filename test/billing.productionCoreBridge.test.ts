import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Hex } from "viem";
import type { EnabledBillingConfig } from "../src/billing/config.js";
import type {
  BillingCanExecuteCheckV1,
  BillingSessionRefV1,
  ProductionBillingCustodyAndRelayPrimitives,
} from "../src/billing/custody.js";
import { parseProductionManifest } from "../src/billing/productionManifest.js";
import { createProductionCoreBridge } from "../src/billing/productionCoreBridge.js";
import { MemoryBillingStore } from "../src/billing/store.js";
import type { BillingAccount } from "../src/billing/types.js";
import { GOLDEN_PRODUCTION_MANIFEST_V2 } from "./fixtures/billing/productionManifestV2.js";

const WALLET = "0x0000000000000000000000000000000000000002" as Address;
const PUBLIC_KEY = `0x04${"11".repeat(64)}` as Hex;
const CALLDATA = `0x${"22".repeat(36)}` as Hex;
const DIGEST = `0x${"33".repeat(32)}` as Hex;

function account(): BillingAccount {
  return {
    accountId: "account-a", ownerAddress: "0x0000000000000000000000000000000000000001",
    walletAddress: WALLET, status: "active", sessionFactsBytes: "e30=", encryptedSessionKey: null,
    sessionKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/session-a",
    sessionGeneration: 1n, sessionPublicKey: PUBLIC_KEY, sessionStateVersion: 1n,
    maxDailyUsdMicros: 1_000_000n, maxUnpaidExposureUsdMicros: 1_000_000n,
    thresholdUsdMicros: 100000n, grantExpiresAt: 2_000, createdAt: 1, updatedAt: 1,
  };
}

function store(value: BillingAccount): MemoryBillingStore {
  return new MemoryBillingStore({ accounts: [[value.accountId, value]], walletAccounts: [[value.walletAddress.toLowerCase(), value.accountId]],
    grants: [], tickets: [], replays: [], logical: [], usages: [], debitIdentities: [], leases: [], invoices: [],
    nonterminalInvoiceByUsage: [], ledger: [], ogReconciliations: [] });
}

test("production core bridge keeps selector/full-calldata evidence in core and maps only pinned identities", async () => {
  const manifest = parseProductionManifest(new TextEncoder().encode(GOLDEN_PRODUCTION_MANIFEST_V2));
  const value = account();
  const config = {
    mode: "on", x402: "on", og: "off", internalHost: "127.0.0.1", internalPort: 8091,
    databaseUrl: "postgres://unused", executionMasterKeyPresent: true, collector: manifest.collector.address,
    collectorRuntimeBytecodeHash: manifest.collector.runtimeCodehash, treasury: manifest.collector.treasury,
    executionTicketKeyId: manifest.aws.ticketKeyId, executionTicketPublicKey: "ticket-public",
    bscRpcOrigins: manifest.networks.bsc.origins, baseRpcOrigins: manifest.networks.base.origins,
    arbitrumRpcOrigins: manifest.networks.arbitrum.origins, platformBaseUsdcCapAtomic: 100n,
    platformOgCapNeuron: 100n, x402PayerKeyId: "x402", x402Authorizer: manifest.providers.x402Authorizer,
  } satisfies EnabledBillingConfig;
  const boundaries: BillingCanExecuteCheckV1[] = [];
  const productionCalls: string[] = [];
  let preparedSession: BillingSessionRefV1 | undefined;
  const production: ProductionBillingCustodyAndRelayPrimitives = {
    signExecutionTicket: async () => "ticket",
    signX402: async ({ keyArn, digest }) => {
      assert.equal(keyArn, manifest.aws.x402KeyArn); assert.equal(digest, DIGEST);
      return `0x${"44".repeat(65)}`;
    },
    loadOgCredential: async () => { throw new Error("disabled"); },
    async readBillingSession(input) {
      productionCalls.push("session"); assert.equal(input.session.kmsKeyArn, value.sessionKmsKeyArn);
      assert.equal(input.observations.length, 2); return { generation: 1n, expiresAt: 2_000 };
    },
    async readBillingMeter(input) {
      productionCalls.push("meter"); assert.equal(input.observations.length, 2);
      return { balanceWei: 10n ** 18n, remainingDayCapWei: 10n ** 18n };
    },
    async relayPrepare(input) {
      preparedSession = input.session;
      return { handle: {}, digest: DIGEST, chainId: 56, wallet: input.session.wallet,
        collector: input.collector, calldata: input.calldata, value: input.valueWei,
        sessionGeneration: input.session.generation, relayQuoteExpiresAt: 1_900,
        relayIntentExpiresAt: 1_800 };
    },
    relaySend: async () => ({ callsId: DIGEST }),
    relayStatus: async () => ({ state: "PENDING" }),
    close: async () => undefined,
  };
  const bridge = createProductionCoreBridge({ config, manifest, store: store(value), production,
    now: () => 1_000, readAuthority: async (_session, boundary) => {
      boundaries.push(boundary);
      const observation = { blockNumber: 100n, blockHash: DIGEST, blockTimestamp: 999,
        keyStoreValid: true, canPayCollector: true, canExecuteCalldataSha256: "00".repeat(32),
        accountKeys: [], accountKeyHashes: [], spendInfos: [], walletBalanceWei: 10n ** 18n };
      return [observation, observation];
    } });

  await bridge.verifyBootAccounts([value]);
  await bridge.primitives.readBillingMeter(value.accountId);
  const authority = bridge.authority(value);
  await authority.beforePrepare(CALLDATA, 1n);
  await authority.beforeSign({ handle: {}, digest: DIGEST, chainId: 56, wallet: WALLET,
    collector: manifest.collector.address, calldata: CALLDATA, value: 1n, sessionGeneration: 1n,
    relayQuoteExpiresAt: 1_900, relayIntentExpiresAt: 1_800 });
  await authority.beforeSend({ handle: {}, digest: DIGEST, chainId: 56, wallet: WALLET,
    collector: manifest.collector.address, calldata: CALLDATA, value: 1n, sessionGeneration: 1n,
    relayQuoteExpiresAt: 1_900, relayIntentExpiresAt: 1_800 });
  assert.deepEqual(boundaries.map((item) => item.kind), ["selector", "selector", "calldata", "calldata", "calldata"]);
  assert.deepEqual(productionCalls, ["session", "meter", "meter", "meter", "meter"]);

  assert.equal(await bridge.signX402Digest(DIGEST), `0x${"44".repeat(65)}`);
  const prepareBytes = new TextEncoder().encode(JSON.stringify({
    domain: "4lpha.billing-collection-prepare.v1", chainId: 56, wallet: WALLET.toLowerCase(),
    collector: manifest.collector.address, calldata: CALLDATA, value: "1", sessionGeneration: "1", maxExpiresAt: 1_900,
  }));
  await bridge.primitives.relayPrepare(prepareBytes);
  assert.equal(preparedSession?.accountId, value.accountId);
  await assert.rejects(bridge.primitives.signX402("x402", new Uint8Array()), /EIP-712 digest/);
});
