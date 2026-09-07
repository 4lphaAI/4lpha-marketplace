import { getAddress, isAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { ownerActionIdempotencyKey } from "../auth/executeDecision.js";
import type { OwnerActionStruct } from "../auth/ownerAuth.js";
import { BILLING_THRESHOLD_USD_MICROS } from "./config.js";
import { billingSessionSpec } from "./sessionPolicy.js";
import {
  canonicalBillingSessionFacts,
  canonicalBillingSessionOwnerParams,
  type BillingSessionActionV1,
  type BillingSessionChainObservationV1,
  type BillingSessionGenerationRepository,
  type BillingSessionGenerationV1,
  type BillingSessionSagaSnapshotV1,
} from "./sessionGenerations.js";
import type { ClosedRelayStatus } from "./custody.js";
import type { BillingStore } from "./store.js";
import { billingAccountCustodyKind, type BillingAccount } from "./types.js";
import type {
  BillingSessionKmsIdentityReaderV1,
} from "./awsBillingSessionIdentity.js";

const KEYSTORE = "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a" as const;
const HASH = /^0x[0-9a-f]{64}$/u;

export type BillingSessionOwnerActionSeedV1 = Readonly<{
  agentId: string;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
}>;

export type PrepareKmsBillingSessionInputV1 = Readonly<{
  store: BillingStore;
  repository: BillingSessionGenerationRepository;
  accountId: string;
  ownerAddress: Address;
  walletAddress: Address;
  collector: Address;
  treasury: Address;
  keyStore: Address;
  kmsKeyArn: string;
  publicKey: Hex;
  dayCapWei: bigint;
  sessionExpiresAt: number;
  maxDailyUsdMicros: bigint;
  maxUnpaidExposureUsdMicros: bigint;
  grant: BillingSessionOwnerActionSeedV1;
  revoke?: BillingSessionOwnerActionSeedV1;
  now: number;
}>;

export type PreparedKmsBillingSessionV1 = Readonly<{
  account: BillingAccount;
  generation: BillingSessionGenerationV1;
  grant: BillingSessionActionV1;
  revoke?: BillingSessionActionV1;
}>;

export type PrepareVerifiedKmsBillingSessionInputV1 = Omit<
  PrepareKmsBillingSessionInputV1,
  "store" | "repository" | "kmsKeyArn" | "publicKey"
> & Readonly<{
  identityReader: BillingSessionKmsIdentityReaderV1;
  manifest: import("./productionManifest.js").BillingProductionManifestV2;
  kmsKeyArn: string;
  openDurableState(): Promise<Readonly<{
    store: BillingStore;
    repository: BillingSessionGenerationRepository;
    close(): Promise<void>;
  }>>;
}>;

export type BillingSessionActionReconcilerV1 = Readonly<{
  reconcileAccount(accountId: string): Promise<BillingSessionSagaSnapshotV1 | null>;
}>;

function canonicalFacts(input: Readonly<{
  collector: Address;
  treasury: Address;
  wallet: Address;
  keyStore: Address;
  publicKey: Hex;
  dayCapWei: bigint;
  now: number;
  expiresAt: number;
}>): string {
  const spec = billingSessionSpec({
    collector: input.collector,
    treasury: input.treasury,
    wallet: input.wallet,
    keyStore: input.keyStore,
    dayCapWei: input.dayCapWei,
    now: input.now,
    expiresAt: input.expiresAt,
  });
  const collector = getAddress(input.collector).toLowerCase();
  return Buffer.from(JSON.stringify({
    version: "billing-session-facts-v1",
    spec: {
      allowedCalls: [{ to: collector, selector: "payInvoice(bytes32,uint64)" }],
      spendCaps: [{ limit: spec.spendCaps[0]!.limit.toString(10), period: "day" }],
      expiresAt: spec.expiresAt,
    },
    permissions: {
      calls: [{ signature: "payInvoice(bytes32,uint64)", to: collector }],
      spend: [{ limit: { $uint: spec.spendCaps[0]!.limit.toString(10) }, period: "day" }],
    },
    publicKey: input.publicKey,
    expiry: spec.expiresAt,
  }), "utf8").toString("base64");
}

function preparedAction(input: Readonly<{
  kind: "grant" | "revoke";
  account: BillingAccount;
  generation: BillingSessionGenerationV1;
  target: BillingSessionGenerationV1;
  oldGeneration: bigint;
  collector: Address;
  dayCapWei: bigint;
  seed: BillingSessionOwnerActionSeedV1;
  now: number;
}>): BillingSessionActionV1 {
  if (input.seed.agentId.length < 1 || input.seed.agentId.length > 256 || !HASH.test(input.seed.nonce)) {
    throw new Error("Billing session owner-action seed is malformed.");
  }
  const owner = canonicalBillingSessionOwnerParams({
    action: input.kind,
    accountId: input.account.accountId,
    wallet: input.account.walletAddress,
    oldGeneration: input.oldGeneration,
    newGeneration: input.generation.generation,
    kmsPublicKey: input.target.publicKey,
    keyId: keccak256(input.target.publicKey),
    sessionFactsHash: input.target.sessionFactsHash,
    collector: input.collector,
    dayCapWei: input.dayCapWei,
    expiry: input.target.expiresAt,
    nonce: input.seed.nonce,
    issuedAt: input.seed.issuedAt,
    expiresAt: input.seed.expiresAt,
  });
  const actionName = input.kind === "grant" ? "billingSessionGrant" : "billingSessionRevoke";
  const signed: OwnerActionStruct = {
    owner: getAddress(input.account.ownerAddress),
    agentId: input.seed.agentId,
    action: actionName,
    paramsHash: owner.paramsHash,
    nonce: input.seed.nonce,
    issuedAt: BigInt(input.seed.issuedAt),
    expiry: BigInt(input.seed.expiresAt),
  };
  return {
    actionId: keccak256(stringToBytes(`4lpha.billing-session-action.v1|${actionName}|${owner.canonical}`)),
    accountId: input.account.accountId,
    generation: input.generation.generation,
    kind: input.kind,
    targetGeneration: input.target.generation,
    targetKeyId: keccak256(input.target.publicKey),
    nonce: input.seed.nonce,
    ownerActionIdempotencyKey: ownerActionIdempotencyKey(signed),
    ownerParamsBytes: owner.canonical,
    ownerParamsHash: owner.paramsHash,
    state: "prepared",
    version: 1n,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function matchingAction(snapshot: BillingSessionSagaSnapshotV1, candidate: BillingSessionActionV1): BillingSessionActionV1 | undefined {
  const existing = snapshot.actions.find((row) => row.actionId === candidate.actionId);
  if (existing === undefined) return undefined;
  if (existing.ownerParamsBytes !== candidate.ownerParamsBytes || existing.kind !== candidate.kind ||
      existing.generation !== candidate.generation || existing.targetGeneration !== candidate.targetGeneration ||
      existing.ownerActionIdempotencyKey !== candidate.ownerActionIdempotencyKey) {
    throw new Error("Prepared billing session action identity conflicts with durable state.");
  }
  return existing;
}

/**
 * Prepare owner-visible KMS grant/revoke rows only. This path creates no key,
 * loads no raw secret, signs nothing and never contacts the chain or relay.
 */
export async function prepareKmsBillingSession(
  input: PrepareKmsBillingSessionInputV1,
): Promise<PreparedKmsBillingSessionV1> {
  if (!Number.isSafeInteger(input.now) || input.now < 0 || getAddress(input.keyStore).toLowerCase() !== KEYSTORE ||
      !/^arn:aws:kms:[\x21-\x7e]{8,2036}$/u.test(input.kmsKeyArn) || !/^0x04[0-9a-f]{128}$/u.test(input.publicKey) ||
      !isAddress(input.ownerAddress, { strict: false }) || !isAddress(input.walletAddress, { strict: false })) {
    throw new Error("KMS billing session preparation identity is malformed.");
  }
  const sessionFactsBytes = canonicalFacts({
    collector: input.collector, treasury: input.treasury, wallet: input.walletAddress,
    keyStore: input.keyStore, publicKey: input.publicKey, dayCapWei: input.dayCapWei,
    now: input.now, expiresAt: input.sessionExpiresAt,
  });
  let account = await input.store.getAccount(input.accountId);
  if (account === null) {
    account = await input.store.createAccount({
      accountId: input.accountId,
      ownerAddress: getAddress(input.ownerAddress).toLowerCase(),
      walletAddress: getAddress(input.walletAddress).toLowerCase(),
      status: "paused",
      sessionFactsBytes,
      encryptedSessionKey: null,
      sessionKmsKeyArn: null,
      sessionGeneration: null,
      sessionPublicKey: null,
      sessionStateVersion: 1n,
      maxDailyUsdMicros: input.maxDailyUsdMicros,
      maxUnpaidExposureUsdMicros: input.maxUnpaidExposureUsdMicros,
      thresholdUsdMicros: BILLING_THRESHOLD_USD_MICROS,
      grantExpiresAt: input.sessionExpiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    });
  } else if (billingAccountCustodyKind(account) !== "kms" ||
      account.ownerAddress.toLowerCase() !== input.ownerAddress.toLowerCase() ||
      account.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase() ||
      account.maxDailyUsdMicros !== input.maxDailyUsdMicros ||
      account.maxUnpaidExposureUsdMicros !== input.maxUnpaidExposureUsdMicros) {
    throw new Error("KMS billing session preparation refuses legacy or conflicting account state.");
  }

  let snapshot = await input.repository.snapshot(input.accountId);
  if (snapshot === null) throw new Error("Billing session repository cannot see the prepared account.");
  const existingGeneration = snapshot.generations.find((row) => row.kmsKeyArn === input.kmsKeyArn);
  const nextNumber = existingGeneration?.generation ??
    snapshot.generations.reduce((max, row) => row.generation > max ? row.generation : max, 0n) + 1n;
  const generation: BillingSessionGenerationV1 = existingGeneration ?? {
    accountId: input.accountId,
    generation: nextNumber,
    kmsKeyArn: input.kmsKeyArn,
    publicKey: input.publicKey,
    sessionFactsBytes,
    sessionFactsHash: keccak256(Buffer.from(sessionFactsBytes, "base64")),
    expiresAt: input.sessionExpiresAt,
    state: "prepared",
    version: 1n,
    createdAt: input.now,
    updatedAt: input.now,
  };
  if (existingGeneration !== undefined && (existingGeneration.publicKey !== input.publicKey ||
      existingGeneration.sessionFactsBytes !== sessionFactsBytes || existingGeneration.expiresAt !== input.sessionExpiresAt)) {
    throw new Error("KMS generation identity conflicts with durable state.");
  }
  canonicalBillingSessionFacts(generation);
  if (existingGeneration === undefined) await input.repository.insertGeneration(generation);

  snapshot = await input.repository.snapshot(input.accountId);
  if (snapshot === null) throw new Error("Prepared billing session snapshot disappeared.");
  const current = snapshot.account.currentGeneration === null ? undefined :
    snapshot.generations.find((row) => row.generation === snapshot!.account.currentGeneration);
  if (snapshot.account.currentGeneration !== null && current === undefined) {
    throw new Error("Billing account current generation is missing.");
  }
  if (current !== undefined && snapshot.account.status === "active") {
    await input.repository.pauseForReplacement(input.accountId, snapshot.account.version);
    snapshot = await input.repository.snapshot(input.accountId);
    if (snapshot === null) throw new Error("Billing replacement pause disappeared.");
  }
  const grantCandidate = preparedAction({
    kind: "grant", account, generation, target: generation,
    oldGeneration: current?.generation ?? 0n, collector: input.collector,
    dayCapWei: input.dayCapWei, seed: input.grant, now: input.now,
  });
  const grant = matchingAction(snapshot, grantCandidate) ?? await input.repository.insertAction(grantCandidate);

  let revoke: BillingSessionActionV1 | undefined;
  if (current !== undefined) {
    if (input.revoke === undefined) throw new Error("Replacement preparation requires a distinct revoke owner action.");
    const revokeCandidate = preparedAction({
      kind: "revoke", account, generation, target: current,
      oldGeneration: current.generation, collector: canonicalBillingSessionFacts(current).collector,
      dayCapWei: canonicalBillingSessionFacts(current).dayCapWei, seed: input.revoke, now: input.now,
    });
    const afterGrant = await input.repository.snapshot(input.accountId);
    if (afterGrant === null) throw new Error("Billing replacement snapshot disappeared.");
    revoke = matchingAction(afterGrant, revokeCandidate) ?? await input.repository.insertAction(revokeCandidate);
  } else if (input.revoke !== undefined) {
    throw new Error("First-generation preparation cannot create a revoke action.");
  }
  return { account, generation, grant, ...(revoke === undefined ? {} : { revoke }) };
}

/**
 * Production preparation gate: AWS proves the KMS/session public identity
 * before the durable writer can create an account, generation or owner action.
 */
export async function prepareVerifiedKmsBillingSession(
  input: PrepareVerifiedKmsBillingSessionInputV1,
): Promise<PreparedKmsBillingSessionV1> {
  const identity = await input.identityReader.read({
    domain: "4lpha.billing-session-kms-identity-read.v1",
    manifest: input.manifest,
    kmsKeyArn: input.kmsKeyArn,
  });
  if (identity.domain !== "4lpha.billing-session-kms-identity.v1" ||
      identity.kmsKeyArn !== input.kmsKeyArn || !/^0x04[0-9a-f]{128}$/u.test(identity.publicKey)) {
    throw new Error("Verified billing session KMS identity is malformed or substituted.");
  }
  const durable = await input.openDurableState();
  try {
    return await prepareKmsBillingSession({
      store: durable.store,
      repository: durable.repository,
      accountId: input.accountId,
      ownerAddress: input.ownerAddress,
      walletAddress: input.walletAddress,
      collector: input.collector,
      treasury: input.treasury,
      keyStore: input.keyStore,
      kmsKeyArn: identity.kmsKeyArn,
      publicKey: identity.publicKey,
      dayCapWei: input.dayCapWei,
      sessionExpiresAt: input.sessionExpiresAt,
      maxDailyUsdMicros: input.maxDailyUsdMicros,
      maxUnpaidExposureUsdMicros: input.maxUnpaidExposureUsdMicros,
      grant: input.grant,
      ...(input.revoke === undefined ? {} : { revoke: input.revoke }),
      now: input.now,
    });
  } finally {
    await durable.close();
  }
}

/**
 * Core-owned observer for already-contacted owner actions. It can read status
 * and finalized BSC facts only; no branch has a prepare, sign or send seam.
 */
export function createBillingSessionActionReconciler(input: Readonly<{
  repository: BillingSessionGenerationRepository;
  wallet(accountId: string): Promise<Address>;
  relayStatus(callsId: Hex): Promise<ClosedRelayStatus>;
  observe(action: BillingSessionActionV1, transactionHash: Hex): Promise<readonly [BillingSessionChainObservationV1, BillingSessionChainObservationV1] | null>;
  keyStore: Address;
  finalityDepth: number;
  unknownAfterSec: number;
  now(): number;
}>): BillingSessionActionReconcilerV1 {
  if (!Number.isSafeInteger(input.finalityDepth) || input.finalityDepth < 1 ||
      !Number.isSafeInteger(input.unknownAfterSec) || input.unknownAfterSec < 1) {
    throw new Error("Billing session reconciler bounds are malformed.");
  }
  return Object.freeze({
    async reconcileAccount(accountId: string): Promise<BillingSessionSagaSnapshotV1 | null> {
      let snapshot = await input.repository.snapshot(accountId);
      if (snapshot === null) return null;
      for (const candidate of snapshot.actions.filter((row) => row.state === "submitted" || row.state === "unknown")) {
        const action = snapshot.actions.find((row) => row.actionId === candidate.actionId);
        if (action === undefined || action.callsId === undefined || (action.state !== "submitted" && action.state !== "unknown")) continue;
        const status = await input.relayStatus(action.callsId);
        const now = input.now();
        if (status.state === "PENDING" || status.transactionHash === undefined) {
          if (action.state === "submitted" && now >= action.updatedAt + input.unknownAfterSec) {
            await input.repository.transitionAction(action.actionId, action.version, "unknown", { callsId: action.callsId }, now);
            snapshot = await input.repository.snapshot(accountId) ?? snapshot;
          }
          continue;
        }
        if (!HASH.test(status.transactionHash)) throw new Error("Billing session relay status transaction hash is malformed.");
        const observations = await input.observe(action, status.transactionHash);
        if (observations === null) continue;
        const [first, second] = observations;
        if (first.receiptStatus === "failed" || second.receiptStatus === "failed" || status.state === "FAILED") {
          if (first.receiptStatus !== "failed" || second.receiptStatus !== "failed" ||
              first.transactionHash !== status.transactionHash || second.transactionHash !== status.transactionHash ||
              first.callsId !== action.callsId || second.callsId !== action.callsId ||
              first.blockNumber !== second.blockNumber || first.blockHash !== second.blockHash ||
              first.stateBlockNumber !== first.blockNumber || second.stateBlockNumber !== second.blockNumber ||
              first.latestBlockNumber < first.blockNumber + BigInt(input.finalityDepth) ||
              second.latestBlockNumber < second.blockNumber + BigInt(input.finalityDepth)) {
            throw new Error("Billing session failed receipt is not dual-finalized.");
          }
          await input.repository.transitionAction(action.actionId, action.version, "failed", {
            callsId: action.callsId,
            transactionHash: status.transactionHash,
          }, now);
          snapshot = await input.repository.snapshot(accountId) ?? snapshot;
          continue;
        }
        if (status.state !== "CONFIRMED") continue;
        const wallet = await input.wallet(accountId);
        const expectedGenerationVersions = Object.fromEntries(snapshot.generations.map((row) =>
          [row.generation.toString(10), row.version])) as Readonly<Record<string, bigint>>;
        snapshot = await input.repository.finalizeAction({
          actionId: action.actionId,
          expectedActionVersion: action.version,
          expectedAccountVersion: snapshot.account.version,
          expectedGenerationVersions,
          wallet,
          keyStore: input.keyStore,
          finalityDepth: input.finalityDepth,
          observations,
          now,
        });
      }
      return snapshot;
    },
  });
}
