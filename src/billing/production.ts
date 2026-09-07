import type { Hono } from "hono";
import { getAddress, type Address, type Hex } from "viem";
import type { BillingOwnerServerDeps } from "../server.js";
import { createJournal, type ExecutionJournal } from "../store/journal.js";
import {
  projectBillingCollectionProof,
  recoverBillingInvoiceCallsId,
  submitBillingInvoice,
} from "./collection.js";
import type { EnabledBillingConfig } from "./config.js";
import { createCoreBillingClients, type CoreBillingClients } from "./coreClients.js";
import {
  loadBillingCustodyAndRelayPrimitives,
  type BillingCustodyAndRelayPrimitives,
} from "./custody.js";
import { proveBaseX402Debit, proveBaseX402NotDebited } from "./evidence.js";
import { createBillingInternalGateway } from "./http.js";
import { reconcileOgUsageFromHistory } from "./og.js";
import { createBillingStore } from "./postgres.js";
import type { BillingStore } from "./store.js";
import { createPinnedBillingTransport, type PinnedBillingTransport } from "./transport.js";
import type { Usage } from "./types.js";
import type { BillingWorkerDeps } from "./worker.js";

export type BillingProductionRuntime = Readonly<{
  store: BillingStore;
  gateway: Hono;
  owner: BillingOwnerServerDeps;
  worker: BillingWorkerDeps;
  close(): Promise<void>;
}>;

function requireCollectionAddress(value: string): Address {
  return getAddress(value);
}

/**
 * Phase 5 never asks custody code to reconcile x402. A contacted Usage without
 * a durable Base transaction candidate remains UNKNOWN until reviewed core can
 * prove debit or positive absence from the authorization identity.
 */
export async function reconcileX402UsageFromBase(
  baseRpcOrigins: readonly [string, string],
  store: BillingStore,
  transport: PinnedBillingTransport,
  usage: Usage,
  now: number,
): Promise<Usage | null> {
  if (usage.sourceFacts?.kind !== "x402") throw new Error("x402 Usage lost its immutable authorization identity.");
  const facts = usage.sourceFacts;
  const [authorizationA, authorizationB] = await Promise.all([
    transport.readX402AuthorizationObservation(baseRpcOrigins[0], facts),
    transport.readX402AuthorizationObservation(baseRpcOrigins[1], facts),
  ]);
  const candidateA = authorizationA.candidateTransactionHash;
  const candidateB = authorizationB.candidateTransactionHash;
  if (candidateA !== candidateB) throw new Error("Independent Base RPC authorization evidence disagrees.");
  if (candidateA === undefined) {
    if (
      authorizationA.finalizedTimestamp <= facts.validBefore ||
      authorizationB.finalizedTimestamp <= facts.validBefore
    ) return null;
    proveBaseX402NotDebited(facts, authorizationA, authorizationB);
    return store.reconcileUnknown(usage.usageId, usage.version, {
      evidenceKind: "base_x402_authorization_unused",
      evidenceDigest: authorizationA.finalizedBlockHash,
      now,
    });
  }
  const [receiptA, receiptB] = await Promise.all([
    transport.readReceiptObservation(baseRpcOrigins[0], {
      chain: "base", kind: "x402_proof", transactionHash: candidateA,
    }),
    transport.readReceiptObservation(baseRpcOrigins[1], {
      chain: "base", kind: "x402_proof", transactionHash: candidateA,
    }),
  ]);
  if (receiptA === null || receiptB === null) return null;
  const proof = proveBaseX402Debit(facts, receiptA, receiptB);
  return store.reconcileUnknown(usage.usageId, usage.version, {
    actualAtomic: facts.amountAtomic,
    evidenceKind: "base_x402_finalized",
    evidenceDigest: proof.transactionHash,
    now,
  });
}

function createCoreWorker(
  config: EnabledBillingConfig,
  store: BillingStore,
  journal: ExecutionJournal,
  clients: CoreBillingClients,
  transport: PinnedBillingTransport,
): BillingWorkerDeps {
  const now = (): number => Math.floor(Date.now() / 1_000);
  return {
    store,
    now,
    bscRpcOrigins: config.bscRpcOrigins,
    arbitrumRpcOrigins: config.arbitrumRpcOrigins,
    readOracleObservation: (origin, feed) => transport.readOracleObservation(origin, feed),
    async reconcileOgUsage(usage) {
      if (clients.ogManagement === undefined) return null;
      return reconcileOgUsageFromHistory({
        store,
        fetch: transport.fetch.bind(transport),
        credential: clients.ogManagement,
        usageId: usage.usageId,
        now: now(),
      });
    },
    reconcileX402Usage: (usage) => reconcileX402UsageFromBase(
      config.baseRpcOrigins,
      store,
      transport,
      usage,
      now(),
    ),
    async reconcileInvoice(invoice) {
      const account = await store.getAccount(invoice.accountId);
      if (account === null) throw new Error("Billing collection account is missing.");
      const recovered = await recoverBillingInvoiceCallsId({
        store,
        journal,
        account,
        invoice,
        now: now(),
      });
      if (recovered.callsId === undefined) return recovered;
      const callsId = recovered.callsId as Hex;
      const [rpcA, rpcB] = await Promise.all([
        clients.collection.readProof(config.bscRpcOrigins[0], callsId),
        clients.collection.readProof(config.bscRpcOrigins[1], callsId),
      ]);
      if (rpcA === null || rpcB === null) return recovered;
      return projectBillingCollectionProof({
        store,
        journal,
        invoiceId: recovered.invoiceId as Hex,
        wallet: requireCollectionAddress(account.walletAddress),
        collector: config.collector,
        reviewedRuntimeBytecodeHash: config.collectorRuntimeBytecodeHash,
        callsId,
        rpcA,
        rpcB,
        now: now(),
      });
    },
    async submitInvoice(account, invoice) {
      const sessionGeneration = await clients.collection.sessionGeneration(account);
      return submitBillingInvoice({
        store,
        journal,
        relay: clients.collection.relay,
        meter: clients.collection.meter(account),
        invoice,
        wallet: requireCollectionAddress(account.walletAddress),
        collector: config.collector,
        ownerAddress: requireCollectionAddress(account.ownerAddress),
        sessionGeneration,
        now,
      });
    },
  };
}

async function closeCoreRuntime(
  primitives: BillingCustodyAndRelayPrimitives | undefined,
  transport: PinnedBillingTransport | undefined,
  journal: ExecutionJournal | undefined,
  store: BillingStore | undefined,
): Promise<void> {
  await Promise.allSettled([
    primitives?.close(),
    transport?.close(),
    journal?.close(),
    store?.close(),
  ]);
}

/** The sole production composition; reviewed core owns every monetary state machine. */
export async function createBillingProductionRuntime(
  config: EnabledBillingConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BillingProductionRuntime> {
  let transport: PinnedBillingTransport | undefined;
  let primitives: BillingCustodyAndRelayPrimitives | undefined;
  let store: BillingStore | undefined;
  let journal: ExecutionJournal | undefined;
  try {
    // Refuse bad destinations before loading any credential or signing seam.
    transport = await createPinnedBillingTransport(config);
    primitives = await loadBillingCustodyAndRelayPrimitives(config, env);
    [store, journal] = await Promise.all([createBillingStore(env), createJournal()]);
    const clients = await createCoreBillingClients({ config, store, primitives, transport });
    const gateway = createBillingInternalGateway({
      store,
      executionTicketKeyId: config.executionTicketKeyId,
      executionTicketPublicKey: config.executionTicketPublicKey,
      preAdmissionCheck: clients.preAdmissionCheck,
      resolveGrant: (grantId, generation) => store!.getGrant(grantId, generation),
      ...(config.og === "on" ? { og: clients.og! } : {}),
      ...(config.x402 === "on" ? { cmc: clients.cmc! } : {}),
    });
    const worker = createCoreWorker(config, store, journal, clients, transport);
    return {
      store,
      gateway,
      owner: {
        store,
        executionTicketKeyId: config.executionTicketKeyId,
        ...clients.owner,
      },
      worker,
      close: () => closeCoreRuntime(primitives, transport, journal, store),
    };
  } catch (error) {
    await closeCoreRuntime(primitives, transport, journal, store);
    throw error;
  }
}
