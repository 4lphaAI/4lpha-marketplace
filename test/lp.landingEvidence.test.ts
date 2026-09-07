import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { custom, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BNB } from "@altananetwork/sdk";
import { prepareCalls, sendPreparedCalls, signCalls } from "porto/viem/RelayActions";
import * as PortoKey from "porto/viem/Key";
import {
  MemoryLpCoverageStore,
  PostgresLpCoverageStore,
  chunkChargedLogicalBytes,
  zeroPrefixChargedLogicalBytes,
  type CoverageCandidate,
} from "../src/store/lpCoverage.js";
import {
  MemoryLpEvidenceStore,
  PostgresLpEvidenceStore,
  canonicalLandingEvidence,
  type EvidenceRequirement,
  type LpEvidenceStore,
} from "../src/store/lpEvidence.js";
import {
  canonicalPreparedIntentIdentityV1,
  encodeLpFinalCallsV1,
  fingerprintLpFinalCallsV1,
  isProvenPreBindStagedLpError,
  PortoStagedLpAdapter,
  PORTO_V055_ORCHESTRATOR,
  type PreparedIntentIdentityV1,
} from "../src/lp/preparedIntent.js";
import { validateSessionSpec } from "../src/core/session.js";
import { AltanaProvider } from "../src/wallet/altana.js";
import {
  absentDispositionReleasesReservation,
  landingDispositionFor,
} from "../src/lp/resolveLanding.js";
import { parseLpResolveLandingV1Params } from "../src/http/lpWire.js";
import { isMutatingOwnerAction } from "../src/auth/ownerAuth.js";
import { resolveLpEvidenceConfig } from "../src/ops/config.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { createLpEvidenceObserver, resolveLpEvidenceDestinationPins } from
  "../src/lp/evidenceObserver.js";
import { PostgresLandingResolutionFinalizer } from "../src/lp/landingFinalizer.js";
import {
  decodeIntentExecutedV055,
  decodePortoV055Transaction,
  pairPreparedIntentCandidate,
} from "../src/lp/intentDecoder.js";
import { PINNED_PORTO_ALTANA_SANITIZED_FIXTURE } from "../src/lp/rpcCapabilities.js";
import { chunkDigest } from "../src/lp/evidenceDigests.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";

const H0 = `0x${"00".repeat(32)}` as Hex;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const H3 = `0x${"33".repeat(32)}` as Hex;
const OWNER = `0x${"12".repeat(20)}` as Address;

function sourceMethod(source: string, className: string, signature: string,
  nextSignature: string): string {
  const classStart = source.indexOf(`export class ${className}`);
  assert.notEqual(classStart, -1, `missing ${className}`);
  const start = source.indexOf(signature, classStart);
  assert.notEqual(start, -1, `missing ${className}.${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `missing boundary after ${className}.${signature}`);
  return source.slice(start, end);
}

function assertSourceOrder(body: string, markers: readonly string[]): void {
  let prior = -1;
  for (const marker of markers) {
    const at = body.indexOf(marker);
    assert.ok(at > prior, `expected ${markers.join(" -> ")}; ${marker} was absent or out of order`);
    prior = at;
  }
}

function requirement(laneId: Hex, expiry = 100n): EvidenceRequirement {
  return { journalOwner: OWNER, journalAgent: "agent", journalAction: "lp",
    journalIdempotencyKey: "target", begunAtBlock: 10n, expiry,
    preparedIdentityHash: H1, coverageVersion: H2, quorumId: H3, laneId,
    state: "eligible", unavailableCode: null, createdAt: 1, terminalAt: null,
    evidenceRetainedUntil: null, updatedAt: 1, rowVersion: 0,
    chargedLogicalBytes: 512n };
}

const identity: PreparedIntentIdentityV1 = {
  scheme: "porto-intent-v1", decoder: "porto-orchestrator-intent-v055",
  chainId: "56", eoa: OWNER,
  orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
  orchestratorVersion: "0.5.5", nonce: "7", expiry: "100",
  executionDataHash: H2, keyHash: H3,
};

describe("Phase 3.9c PostgreSQL quota lock discipline", () => {
  const coverageSource = readFileSync(new URL("../src/store/lpCoverage.ts", import.meta.url), "utf8");
  const evidenceSource = readFileSync(new URL("../src/store/lpEvidence.ts", import.meta.url), "utf8");
  const finalizerSource = readFileSync(new URL("../src/lp/landingFinalizer.ts", import.meta.url), "utf8");

  it("pins the quota prefix ahead of ordinary locks on every charged insert/delete path", () => {
    const compact = sourceMethod(coverageSource, "PostgresLpCoverageStore",
      "  async compactZeroExpiry(", "  async commitAgreedRange(");
    const commit = sourceMethod(coverageSource, "PostgresLpCoverageStore",
      "  async commitAgreedRange(", "  async markGap(");
    const rewind = sourceMethod(coverageSource, "PostgresLpCoverageStore",
      "  async rewind(", "  async snapshot(");
    assertSourceOrder(compact, ["compactQuotaGlobal", "compactQuotaVersion",
      "await lockLane", "await assertLease", "compactRequirements"]);
    assertSourceOrder(commit, ["quotaLockGlobal", "quotaLockVersion",
      "await lockLane", "await assertLease", "chunkInsert"]);
    assertSourceOrder(rewind, ["rewindQuotaGlobal", "rewindQuotaVersion",
      "await lockLane", "await assertLease", "rewindPrefixesLock"]);

    const admit = sourceMethod(evidenceSource, "PostgresLpEvidenceStore",
      "  async admitRequirement(", "  async createOrJoinResolution(");
    const bind = sourceMethod(evidenceSource, "PostgresLpEvidenceStore",
      "  async bindEvidence(", "  async advanceResolution(");
    const release = sourceMethod(evidenceSource, "PostgresLpEvidenceStore",
      "  async releaseProvisional(", "  async cleanupRetained(");
    const cleanup = sourceMethod(evidenceSource, "PostgresLpEvidenceStore",
      "  async cleanupRetained(", "  async quota(");
    assertSourceOrder(admit, ["#lockCounters", "requirementInsert"]);
    assertSourceOrder(bind, ["#lockCounters", "#lockResolution",
      "requirementAuthorize", "evidenceInsert"]);
    assertSourceOrder(release, ["releaseQuotaGlobal", "evidencePreview",
      "releaseQuotaVersion", "#lockResolution", "evidenceGet", "evidenceDelete"]);
    assertSourceOrder(cleanup, ["cleanupQuotaGlobal", "cleanupSelect",
      ".sort((left, right) => left < right", "cleanupQuotaVersion",
      "cleanupCursorLock", "cleanupLeaseLock", "#lockResolution", "cleanupChunksLock"]);

    const bindFinal = sourceMethod(finalizerSource, "PostgresLandingResolutionFinalizer",
      "  bindEvidence(input:", "  refuseProvisional(");
    const refuseFinal = sourceMethod(finalizerSource, "PostgresLandingResolutionFinalizer",
      "  refuseProvisional(", "  beginDisposition(");
    assertSourceOrder(bindFinal, ["bindQuotaGlobal", "bindQuotaVersion",
      "lockEvidenceAuthority", "lockPositionSequence", "bindEvidenceInsert"]);
    assertSourceOrder(refuseFinal, ["refuseQuotaEnsure", "refuseQuotaGlobal",
      "refuseQuotaVersion", "refusePositionLock", "refuseSequenceLock",
      "refuseEvidenceDelete"]);
  });

  it("models the rewind/resolver interleaving without a PostgreSQL deadlock cycle", () => {
    const rewind = sourceMethod(coverageSource, "PostgresLpCoverageStore",
      "  async rewind(", "  async snapshot(");
    const bind = sourceMethod(finalizerSource, "PostgresLandingResolutionFinalizer",
      "  bindEvidence(input:", "  refuseProvisional(");
    const actualOrder = (body: string, markers: Readonly<Record<string, string>>) =>
      Object.entries(markers).map(([resource, marker]) => ({ resource,
        at: body.indexOf(marker) })).sort((left, right) => left.at - right.at)
        .map(({ resource }) => resource);
    const rewindLocks = actualOrder(rewind, { global: "rewindQuotaGlobal",
      version: "rewindQuotaVersion", cursor: "await lockLane" });
    const bindLocks = actualOrder(bind, { global: "bindQuotaGlobal",
      version: "bindQuotaVersion", cursor: "lockEvidenceAuthority" });
    assert.deepEqual(rewindLocks, ["global", "version", "cursor"]);
    assert.deepEqual(bindLocks, ["global", "version", "cursor"]);

    const completes = (sessions: readonly (readonly string[])[]): boolean => {
      const positions = sessions.map(() => 0);
      const held = new Map<string, number>();
      const done = new Set<number>();
      for (let turn = 0; turn < 32; turn += 1) {
        let progressed = false;
        sessions.forEach((locks, session) => {
          if (done.has(session)) return;
          if (positions[session] === locks.length) {
            for (const [resource, owner] of held) if (owner === session) held.delete(resource);
            done.add(session); progressed = true; return;
          }
          const resource = locks[positions[session]!]!;
          const owner = held.get(resource);
          if (owner === undefined || owner === session) {
            held.set(resource, session); positions[session]! += 1; progressed = true;
          }
        });
        if (done.size === sessions.length) return true;
        if (!progressed) return false;
      }
      return false;
    };
    assert.equal(completes([rewindLocks, bindLocks]), true);
    assert.equal(completes([["cursor", "global", "version"], bindLocks]), false,
      "the scheduler must detect the historical cursor/global wait cycle");
  });
});

describe("Phase 3.9c durable coverage boundary", () => {
  it("persists final calls before the immutable prepared-intent CAS", async () => {
    const journal = new MemoryExecutionJournal(() => 1);
    const fingerprint = '{"scheme":"porto-erc7579-calls-v1","executionDataHash":"' +
      H2 + '"}';
    const row = await journal.begin({ idempotencyKey: "lp-bind", agentId: "agent",
      ownerAddress: OWNER, kind: "lp", decisionId: "lp:s:0", begunAtBlock: 9n,
      finalCallsFingerprint: fingerprint,
      finalCallsFingerprintHash: keccak256(stringToHex(fingerprint)) });
    assert.equal(row.preparedIntentIdentity, null);
    const prepared = canonicalPreparedIntentIdentityV1(identity);
    const bound = await journal.bindPreparedIntent("lp-bind", {
      canonicalIdentity: prepared.canonical, identityHash: prepared.hash,
      expectedBindingVersion: 0 });
    assert.equal(bound.boundBindingVersion, 1);
    await assert.rejects(journal.bindPreparedIntent("lp-bind", {
      canonicalIdentity: '{"scheme":"different"}', identityHash: H2,
      expectedBindingVersion: 1 }));
  });

  it("orders prepare -> durable bind -> sign -> send and fails key/bind mutations before send", async () => {
    const sessionPrivateKey = `0x${"00".repeat(31)}01` as Hex;
    const sessionAccount = privateKeyToAccount(sessionPrivateKey);
    const wallet = `0x${"34".repeat(20)}` as Address;
    const target = `0x${"56".repeat(20)}` as Address;
    const expiry = Math.floor(Date.now() / 1_000) + 3_600;
    const spec = { allowedCalls: [{ to: target }],
      spendCaps: [{ limit: 1n, period: "hour" as const }], expiresAt: expiry };
    const permissions = validateSessionSpec(spec, { minSessionSeconds: 0 });
    const calls = [{ to: target, value: 0n, data: "0x" as Hex }] as const;
    const fingerprint = fingerprintLpFinalCallsV1(calls);
    const selected = PortoKey.fromSecp256k1({ privateKey: sessionPrivateKey,
      role: "session", expiry, permissions });
    const order: string[] = [];
    const prepared = {
      capabilities: { quote: { quotes: [{ chainId: 56,
        orchestrator: PORTO_V055_ORCHESTRATOR,
        intent: { eoa: wallet, executionData: encodeLpFinalCallsV1(calls), nonce: 7n,
          expiry: BigInt(expiry) } }] } },
      context: {}, digest: H1, key: selected, typedData: {},
    } as unknown as Awaited<ReturnType<typeof prepareCalls>>;
    const functions = {
      prepare: (async () => { order.push("prepare"); return prepared; }) as typeof prepareCalls,
      sign: (async () => { order.push("sign");
        return `0x${"11".repeat(65)}` as Hex; }) as typeof signCalls,
      send: (async () => { order.push("send"); return { id: "0x01" as Hex }; }) as typeof sendPreparedCalls,
    };
    const adapter = new PortoStagedLpAdapter({ network: BNB,
      transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }),
      functions, submitTimeoutMs: 1_000 });
    const base = { journalIdempotencyKey: "lp-bind", expectedBindingVersion: 0,
      sessionPrivateKey, walletAddress: wallet,
      persistedSession: { spec, permissions, publicKey: sessionAccount.publicKey, expiry },
      restoredSessionPublicKey: sessionAccount.publicKey, restoredSessionExpiry: expiry,
      calls,
      expectedExecutionDataHash: fingerprint.value.executionDataHash,
      bind: async (request: Parameters<NonNullable<Parameters<PortoStagedLpAdapter["submit"]>[0]["bind"]>>[0]) => {
        order.push("bind");
        return { ...request, boundBindingVersion: request.expectedBindingVersion + 1 };
      } } as const;
    assert.deepEqual(await adapter.submit(base), { status: "PENDING", callsId: "0x01" });
    assert.deepEqual(order, ["prepare", "bind", "sign", "send"]);

    // PostgreSQL jsonb does not preserve object-member insertion order.  This
    // is the exact old failure shape: semantically identical persisted
    // permissions arrive with their top-level fields in the opposite order.
    order.length = 0;
    assert.deepEqual(await adapter.submit({ ...base, persistedSession: {
      ...base.persistedSession,
      permissions: { spend: permissions.spend, calls: permissions.calls },
    } }), { status: "PENDING", callsId: "0x01" });
    assert.deepEqual(order, ["prepare", "bind", "sign", "send"]);

    order.length = 0;
    let validationError: unknown;
    try {
      await adapter.submit({ ...base, restoredSessionPublicKey: `0x04${"00".repeat(64)}` as Hex });
    } catch (error) { validationError = error; }
    assert.equal(isProvenPreBindStagedLpError(validationError), true);
    assert.equal(order.length, 0, "SEC1 substitution must refuse before prepare");

    order.length = 0;
    let bindError: unknown;
    try {
      await adapter.submit({ ...base, bind: async () => {
        order.push("bind"); throw new Error("injected durable bind failure");
      } });
    } catch (error) { bindError = error; }
    assert.equal(isProvenPreBindStagedLpError(bindError), false,
      "a binder may have committed before it threw, so this must stay ambiguous");
    assert.deepEqual(order, ["prepare", "bind"], "bind failure must sign/send zero times");

    const assertFailureBoundary = async (input: {
      readonly name: string;
      readonly run: () => Promise<void>;
      readonly provenPreBind: boolean;
      readonly expectedOrder: readonly string[];
    }): Promise<void> => {
      order.length = 0;
      let failure: unknown;
      try { await input.run(); } catch (error) { failure = error; }
      assert.equal(isProvenPreBindStagedLpError(failure), input.provenPreBind, input.name);
      assert.deepEqual(order, input.expectedOrder, input.name);
    };

    // F2's complete staging matrix.  `prepare` and prepared-object failures
    // precede the binder and therefore prove no submit; every later case is
    // deliberately ordinary/ambiguous because the binder may have committed.
    functions.prepare = (async () => { order.push("prepare"); throw new Error("prepare rejected"); }) as typeof prepareCalls;
    await assertFailureBoundary({ name: "prepare rejection", provenPreBind: true,
      expectedOrder: ["prepare"], run: async () => { await adapter.submit(base); } });
    const timeoutAdapter = new PortoStagedLpAdapter({ network: BNB,
      transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }),
      functions: { ...functions, prepare: (async () => {
        order.push("prepare");
        return await new Promise<never>(() => undefined);
      }) as typeof prepareCalls }, submitTimeoutMs: 2 });
    await assertFailureBoundary({ name: "prepare timeout", provenPreBind: true,
      expectedOrder: ["prepare"], run: async () => { await timeoutAdapter.submit(base); } });
    functions.prepare = (async () => {
      order.push("prepare");
      return { ...prepared, capabilities: { quote: { quotes: [] } } } as unknown as typeof prepared;
    }) as typeof prepareCalls;
    await assertFailureBoundary({ name: "prepared-object rejection", provenPreBind: true,
      expectedOrder: ["prepare"], run: async () => { await adapter.submit(base); } });
    functions.prepare = (async () => { order.push("prepare"); return prepared; }) as typeof prepareCalls;
    await assertFailureBoundary({ name: "malformed post-bind token", provenPreBind: false,
      expectedOrder: ["prepare", "bind"], run: async () => {
        await adapter.submit({ ...base, bind: async (request) => {
          order.push("bind"); return { ...request, boundBindingVersion: request.expectedBindingVersion + 2 };
        } });
      } });
    const abort = new AbortController();
    await assertFailureBoundary({ name: "abort after binder invocation", provenPreBind: false,
      expectedOrder: ["prepare", "bind"], run: async () => {
        await adapter.submit({ ...base, signal: abort.signal, bind: async (request) => {
          order.push("bind"); abort.abort();
          return { ...request, boundBindingVersion: request.expectedBindingVersion + 1 };
        } });
      } });
    functions.sign = (async () => { order.push("sign"); throw new Error("sign failed"); }) as typeof signCalls;
    await assertFailureBoundary({ name: "sign failure", provenPreBind: false,
      expectedOrder: ["prepare", "bind", "sign"], run: async () => { await adapter.submit(base); } });
    functions.sign = (async () => { order.push("sign"); return `0x${"11".repeat(65)}` as Hex; }) as typeof signCalls;
    functions.send = (async () => { order.push("send"); throw new Error("send failed"); }) as typeof sendPreparedCalls;
    await assertFailureBoundary({ name: "send failure", provenPreBind: false,
      expectedOrder: ["prepare", "bind", "sign", "send"], run: async () => { await adapter.submit(base); } });

    // Altana owns the mapping boundary.  Replace only its newly-constructed
    // private adapter with this already-exercised offline adapter, then prove
    // the module-private proof crosses the provider unchanged rather than
    // becoming an ordinary ProviderError.  Capture the original method before
    // patching so the delegated instance cannot recurse through the prototype.
    const originalSubmit = PortoStagedLpAdapter.prototype.submit;
    const sourceSubmit = adapter.submit.bind(adapter);
    functions.prepare = (async () => { order.push("prepare"); throw new Error("prepare rejected"); }) as typeof prepareCalls;
    try {
      PortoStagedLpAdapter.prototype.submit = async function (input) {
        return sourceSubmit(input);
      };
      const altana = new AltanaProvider({ network: BNB });
      order.length = 0;
      let propagated: unknown;
      try { await altana.submitPreparedLp(base); } catch (error) { propagated = error; }
      assert.equal(isProvenPreBindStagedLpError(propagated), true,
        "Altana must preserve the adapter's private pre-bind proof");
      assert.deepEqual(order, ["prepare"]);
    } finally {
      PortoStagedLpAdapter.prototype.submit = originalSubmit;
    }
  });

  it("keeps evidence egress off and curated at boot", () => {
    assert.equal(resolveLpEvidenceConfig({}).enabled, false);
    const sources = JSON.stringify([
      { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
      { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
    ]);
    assert.equal(resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: sources }).sources.length, 2);
    assert.throws(() => resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "custom", url: "https://example.com", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) }));
  });

  it("pins curated evidence DNS to distinct public destinations and rejects rebinding targets", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    const pins = await resolveLpEvidenceDestinationPins(config, async (hostname) =>
      [{ address: hostname.includes("bnbchain") ? "8.8.8.8" : "1.1.1.1", family: 4 }]);
    assert.deepEqual(pins.map((pin) => pin.address), ["8.8.8.8", "1.1.1.1"]);
    await assert.rejects(resolveLpEvidenceDestinationPins(config, async () =>
      [{ address: "127.0.0.1", family: 4 }]), /private or reserved/);
    await assert.rejects(resolveLpEvidenceDestinationPins(config, async () =>
      [{ address: "8.8.8.8", family: 4 }]), /one destination/);
  });

  it("decodes and pairs the pinned Porto transaction only with its exact receipt event", () => {
    const fixture = PINNED_PORTO_ALTANA_SANITIZED_FIXTURE;
    const members = decodePortoV055Transaction(56, PORTO_V055_ORCHESTRATOR,
      fixture.rawTransactionInput);
    assert.equal(members.length, 1);
    const member = members[0];
    assert.ok(member);
    assert.equal(member.eoa, fixture.eoa);
    assert.equal(member.nonce, fixture.nonce);
    assert.equal(member.executionDataHash, fixture.executionDataHash);
    assert.equal(member.keyHash, fixture.keyHash);
    const log = { address: fixture.rawReceiptLog.address as Address,
      topics: fixture.rawReceiptLog.topics as readonly Hex[],
      data: fixture.rawReceiptLog.data as Hex, logIndex: fixture.eventLogIndex };
    const event = decodeIntentExecutedV055(log);
    assert.equal(event?.incremented, true);
    assert.equal(event?.err, "0x00000000");
    const preparedIdentity: PreparedIntentIdentityV1 = { scheme: "porto-intent-v1",
      decoder: "porto-orchestrator-intent-v055", chainId: "56", eoa: fixture.eoa,
      orchestrator: PORTO_V055_ORCHESTRATOR, orchestratorVersion: "0.5.5",
      nonce: fixture.nonce.toString(10), expiry: fixture.expiry.toString(10),
      executionDataHash: fixture.executionDataHash, keyHash: fixture.keyHash };
    const transaction = { hash: fixture.transactionHash as Hex,
      to: PORTO_V055_ORCHESTRATOR, input: fixture.rawTransactionInput,
      blockNumber: fixture.blockNumber, blockHash: fixture.blockHash as Hex,
      transactionIndex: fixture.transactionIndex };
    const receipt = { status: fixture.receiptStatus,
      transactionHash: fixture.transactionHash as Hex, blockNumber: fixture.blockNumber,
      blockHash: fixture.blockHash as Hex, transactionIndex: fixture.transactionIndex,
      logs: [log] };
    const paired = pairPreparedIntentCandidate(preparedIdentity, transaction, receipt);
    assert.equal(paired.outcome, "landed");
    assert.equal(paired.outcome === "landed" ? paired.proof.logIndex : -1n,
      fixture.eventLogIndex);
    assert.equal(pairPreparedIntentCandidate(preparedIdentity, transaction,
      { ...receipt, logs: [log, { ...log, logIndex: log.logIndex + 1n }] }).outcome,
    "ambiguous", "a duplicate matching event must never upgrade evidence");
    assert.equal(pairPreparedIntentCandidate(preparedIdentity,
      { ...transaction, blockHash: H0 }, receipt).outcome, "ambiguous");
    assert.throws(() => decodePortoV055Transaction(97, PORTO_V055_ORCHESTRATOR,
      fixture.rawTransactionInput));
  });

  it("is inclusive at begunAtBlock and requires strict post-expiry finalized time", async () => {
    const store = new MemoryLpCoverageStore();
    const lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
      laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await store.claimLease(lane, "test", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    const first = await store.commitAgreedRange({ lane, lease, expectedRowVersion: 0,
      blocks: [{ number: 10n, hash: H1, parentHash: H0, timestamp: 400n,
        orderedTransactionDigest: H2 }],
      sourceChunkDigests: { a: H1, b: H1 }, candidates: [], now: 1 });
    assert.equal(await store.snapshot({ requirement: requirement(H1), identity,
      requiredSourceIds: ["a", "b"], expirySafetySeconds: 300 }), null,
    "equality at expiry+safety must not prove absence");
    await store.commitAgreedRange({ lane: first, lease, expectedRowVersion: 1,
      blocks: [{ number: 11n, hash: H2, parentHash: H1, timestamp: 401n,
        orderedTransactionDigest: H3 }],
      sourceChunkDigests: { a: H2, b: H2 }, candidates: [], now: 2 });
    const absent = await store.snapshot({ requirement: requirement(H1), identity,
      requiredSourceIds: ["a", "b"], expirySafetySeconds: 300 });
    assert.equal(absent?.outcome, "absent");
    assert.equal(absent?.fromBlock, "10");
  });

  it("returns one exactly paired candidate and invalidates it across a generation rewind", async () => {
    const store = new MemoryLpCoverageStore();
    const lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
      laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await store.claimLease(lane, "test", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    const candidate: CoverageCandidate = { txHash: H1, inputHash: H2, blockNumber: 10n,
      blockHash: H1, transactionIndex: 0n, intentIndex: 0, memberCount: 1, eoa: OWNER,
      nonce: 7n, executionDataHash: H2, keyHash: H3, logIndex: 1n,
      eventTopicsHash: H2, eventDataHash: H3, candidateDigest: H1 };
    const advanced = await store.commitAgreedRange({ lane, lease, expectedRowVersion: 0,
      blocks: [{ number: 10n, hash: H1, parentHash: H0, timestamp: 200n,
        orderedTransactionDigest: H2 }], sourceChunkDigests: { a: H1, b: H1 },
      candidates: [candidate], now: 1 });
    const landed = await store.snapshot({ requirement: requirement(H1), identity,
      requiredSourceIds: ["a", "b"], expirySafetySeconds: 300 });
    assert.equal(landed?.outcome, "landed");
    assert.equal(landed === null ? false : await store.validate(landed), true);
    await store.rewind(advanced, null, lease);
    assert.equal(landed === null ? true : await store.validate(landed), false);
  });

  it("reports two exact identity matches as ambiguous on both durable backends", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    for (const store of [new MemoryLpCoverageStore(config),
      new PostgresLpCoverageStore(new FakeSqlClient(), config)]) {
      const lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
        laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
      const lease = await store.claimLease(lane, "test", 0, 8_000_000_000_000_000);
      assert.ok(lease);
      const base: CoverageCandidate = { txHash: H1, inputHash: H2, blockNumber: 10n,
        blockHash: H1, transactionIndex: 0n, intentIndex: 0, memberCount: 1, eoa: OWNER,
        nonce: 7n, executionDataHash: H2, keyHash: H3, logIndex: 1n,
        eventTopicsHash: H2, eventDataHash: H3, candidateDigest: H1 };
      await store.commitAgreedRange({ lane, lease, expectedRowVersion: 0,
        blocks: [{ number: 10n, hash: H1, parentHash: H0, timestamp: 401n,
          orderedTransactionDigest: H2 }], sourceChunkDigests: {
          "bnbchain-public": H1, publicnode: H1 },
        candidates: [base, { ...base, txHash: H2, transactionIndex: 1n,
          logIndex: 2n, candidateDigest: H2 }], now: 1 });
      const snapshot = await store.snapshot({ requirement: requirement(H1), identity,
        requiredSourceIds: ["bnbchain-public", "publicnode"], expirySafetySeconds: 300 });
      assert.deepEqual(snapshot, { outcome: "ambiguous",
        reason: "multiple-matching-candidates" });
      await store.close();
    }
  });

  it("reserves a chunk's longest mutable future projection", () => {
    assert.ok(chunkChargedLogicalBytes("a") >= 64n);
    assert.equal(chunkChargedLogicalBytes("ab"), chunkChargedLogicalBytes("a") + 1n);
    assert.throws(() => chunkChargedLogicalBytes(""));
  });

  it("uses one reusable base lane and fences cross-process scan handover", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    const store = new MemoryLpCoverageStore(config);
    const observer = createLpEvidenceObserver({ config, store, fetchFn: async () => {
      throw new Error("admission never reads an upstream");
    } });
    const first = await observer.admission({ begunAtBlock: 10n, preparedIdentity: identity,
      requirementKeyHash: H1 });
    const second = await observer.admission({ begunAtBlock: 11n, preparedIdentity: identity,
      requirementKeyHash: H2 });
    assert.equal(second?.laneId, first?.laneId, "retained raw history is shared by the base lane");
    assert.ok(first);
    await store.registerRequirement(requirement(first.laneId));
    const lane = (await store.listActiveLanes())[0];
    assert.ok(lane);
    const leaseA = await store.claimLease(lane, "process-a", 1_000, 2_000);
    assert.ok(leaseA);
    assert.equal(await store.claimLease(lane, "process-b", 1_500, 2_500), null);
    const leaseB = await store.claimLease(lane, "process-b", 2_000, 3_000);
    assert.ok(leaseB);
    await assert.rejects(store.commitAgreedRange({ lane, lease: leaseA,
      expectedRowVersion: lane.rowVersion, blocks: [{ number: 10n, hash: H1,
        parentHash: H0, timestamp: 401n, orderedTransactionDigest: H2 }],
      sourceChunkDigests: { "bnbchain-public": H1, publicnode: H1 }, candidates: [], now: 2_100 }),
    /LEASE_CONFLICT/);
    const advanced = await store.commitAgreedRange({ lane, lease: leaseB,
      expectedRowVersion: lane.rowVersion, blocks: [{ number: 10n, hash: H1,
        parentHash: H0, timestamp: 401n, orderedTransactionDigest: H2 }],
      sourceChunkDigests: { "bnbchain-public": H1, publicnode: H1 }, candidates: [], now: 2_100 });
    assert.equal(advanced.coveredThrough, 10n);
  });

  it("persists the per-version hourly backfill equality boundary", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    for (const store of [new MemoryLpCoverageStore(config),
      new PostgresLpCoverageStore(new FakeSqlClient(), config)] as const) {
      assert.equal(await store.reserveBackfillBlocks(H1, 19_999, 3_600_000, 20_000), true);
      assert.equal(await store.reserveBackfillBlocks(H1, 1, 3_600_001, 20_000), true);
      assert.equal(await store.reserveBackfillBlocks(H1, 1, 3_600_002, 20_000), false);
      assert.equal(await store.reserveBackfillBlocks(H1, 20_000, 7_200_000, 20_000), true);
      await store.close();
    }
  });

  it("compacts only a sole zero-expiry identity and carries its prefix across a shallow generation", async () => {
    const hash = (value: number): Hex => `0x${value.toString(16).padStart(64, "0")}` as Hex;
    const store = new MemoryLpCoverageStore();
    const lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
      laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await store.claimLease(lane, "compactor", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    const first = await store.commitAgreedRange({ lane, lease, expectedRowVersion: 0,
      blocks: [{ number: 10n, hash: hash(10), parentHash: hash(9), timestamp: 10n,
        orderedTransactionDigest: H2 }], sourceChunkDigests: { a: H1, b: H1 },
      candidates: [], now: 1 });
    const tail = Array.from({ length: 257 }, (_, index) => ({ number: BigInt(11 + index),
      hash: hash(11 + index), parentHash: hash(10 + index), timestamp: BigInt(11 + index),
      orderedTransactionDigest: H2 }));
    const advanced = await store.commitAgreedRange({ lane: first, lease, expectedRowVersion: 1,
      blocks: tail, sourceChunkDigests: { a: H2, b: H2 }, candidates: [], now: 2 });
    const zero = requirement(H1, 0n);
    await store.registerRequirement(zero);
    assert.ok(zeroPrefixChargedLogicalBytes(zero) >= 64n);
    assert.equal(await store.compactZeroExpiry(advanced, lease, 3), 1);
    const compacted = (await store.listActiveLanes())[0];
    assert.equal(compacted?.rawRetainedFrom, 11n);
    assert.deepEqual(await store.prefixBoundaries(compacted!),
      [{ toBlock: 10n, toBlockHash: hash(10) }]);
    const carried = await store.rewind(compacted!, tail.at(-1)!, lease,
      [{ toBlock: 10n, toBlockHash: hash(10), agreed: true }]);
    assert.equal(carried.generation, 1n);
    assert.deepEqual(await store.prefixBoundaries(carried),
      [{ toBlock: 10n, toBlockHash: hash(10) }]);
  });

  it("rolls back every Memory rewind quota gate before safe or unavailable prefix publication", async () => {
    type QuotaGate = "global-bytes" | "version-bytes" | "block-rows" | "candidate-rows";
    const gates: readonly QuotaGate[] = [
      "global-bytes", "version-bytes", "block-rows", "candidate-rows",
    ];
    const sourceIds = ["bnbchain-public", "publicnode"] as const;
    const hash = (value: number): Hex =>
      `0x${value.toString(16).padStart(64, "0")}` as Hex;
    const block = (value: number) => ({ number: BigInt(value), hash: hash(value + 1),
      parentHash: value === 0 ? H0 : hash(value), timestamp: BigInt(value),
      orderedTransactionDigest: H2 });
    const setGate = (config: ReturnType<typeof resolveLpEvidenceConfig>,
      gate: QuotaGate, value: number): void => {
      const mutable = config as {
        maxGlobalLogicalBytes: number; maxVersionLogicalBytes: number;
        maxVersionBlockRows: number; maxVersionCandidateRows: number;
      };
      if (gate === "global-bytes") mutable.maxGlobalLogicalBytes = value;
      else if (gate === "version-bytes") mutable.maxVersionLogicalBytes = value;
      else if (gate === "block-rows") mutable.maxVersionBlockRows = value;
      else mutable.maxVersionCandidateRows = value;
    };

    for (const prefixOutcome of ["safe", "unavailable"] as const) {
      for (const gate of gates) {
        const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
          LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
            { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org",
              role: "required" },
            { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
          ]) });
        const store = new MemoryLpCoverageStore(config);
        let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
          laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 0n });
        const zero = { ...requirement(H1, 0n), begunAtBlock: 0n };
        await store.registerRequirement(zero);
        const lease = await store.claimLease(lane, `${prefixOutcome}-${gate}`, 0,
          8_000_000_000_000_000);
        assert.ok(lease);
        for (let from = 0; from <= 300; from += 50) {
          const to = Math.min(from + 49, 306);
          const blocks = Array.from({ length: to - from + 1 }, (_, offset) =>
            block(from + offset));
          const sourceChunkDigests = Object.fromEntries(sourceIds.map((sourceId) => [sourceId,
            chunkDigest({ sourceId, laneId: H1, generation: lane.generation,
              fromBlock: BigInt(from), toBlock: BigInt(to), blocks: blocks.map((row) => ({
                number: row.number, hash: row.hash, parentHash: row.parentHash,
                timestamp: row.timestamp, transactionListDigest: row.orderedTransactionDigest,
              })) })])) as Record<string, Hex>;
          const candidates: CoverageCandidate[] = from === 250 ? [{
            txHash: H1, inputHash: H2, blockNumber: 250n, blockHash: block(250).hash,
            transactionIndex: 0n, intentIndex: 0, memberCount: 1, eoa: OWNER,
            nonce: 7n, executionDataHash: H2, keyHash: H3, logIndex: 1n,
            eventTopicsHash: H2, eventDataHash: H3, candidateDigest: H1,
          }] : [];
          lane = await store.commitAgreedRange({ lane, lease,
            expectedRowVersion: lane.rowVersion, blocks, sourceChunkDigests, candidates, now: to });
        }
        assert.equal(await store.compactZeroExpiry(lane, lease, 1_000), 1);
        lane = (await store.listActiveLanes())[0]!;
        const proof = [{ toBlock: 49n, toBlockHash: block(49).hash,
          agreed: prefixOutcome === "safe" }];
        const evidence = await store.snapshot({ requirement: zero, identity,
          requiredSourceIds: sourceIds, expirySafetySeconds: 300 });
        assert.equal(evidence?.outcome, "landed");
        const before = {
          lanes: await store.listActiveLanes(),
          prefix: await store.prefixBoundaries(lane),
          raw: await store.recentBlocks(lane, 1_000),
          evidence,
          valid: evidence === null ? false : await store.validate(evidence),
        };

        setGate(config, gate, 1);
        await assert.rejects(store.rewind(lane, block(250), lease, proof),
          /LP_EVIDENCE_STORAGE_QUOTA/, `${prefixOutcome}/${gate} rejects atomically`);
        assert.deepEqual({
          lanes: await store.listActiveLanes(),
          prefix: await store.prefixBoundaries(lane),
          raw: await store.recentBlocks(lane, 1_000),
          evidence: await store.snapshot({ requirement: zero, identity,
            requiredSourceIds: sourceIds, expirySafetySeconds: 300 }),
          valid: evidence === null ? false : await store.validate(evidence),
        }, before, `${prefixOutcome}/${gate} restores cursor, prefix, requirement and raw evidence`);

        setGate(config, gate, Number.MAX_SAFE_INTEGER);
        const retried = await store.rewind(lane, block(250), lease, proof);
        assert.equal(retried.generation, lane.generation + 1n,
          `${prefixOutcome}/${gate} succeeds once the same admission is available`);
        assert.deepEqual(await store.prefixBoundaries(retried), prefixOutcome === "safe"
          ? [{ toBlock: 49n, toBlockHash: block(49).hash }] : []);
        if (prefixOutcome === "unavailable") assert.deepEqual(await store.listActiveLanes(), []);
      }
    }
  });

  it("keeps Postgres/FakeSql zero-prefix compaction and charged-counter CAS parity", async () => {
    const hash = (value: number): Hex => `0x${value.toString(16).padStart(64, "0")}` as Hex;
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    const sql = new FakeSqlClient();
    const evidence = await PostgresLpEvidenceStore.create(sql, config, () => 1);
    const store = new PostgresLpCoverageStore(sql, config);
    let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
      laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await store.claimLease(lane, "postgres-compactor", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    for (let from = 10; from <= 267;) {
      const to = Math.min(267, from + (from === 10 ? 0 : 49));
      const blocks = Array.from({ length: to - from + 1 }, (_, index) => {
        const number = from + index;
        return { number: BigInt(number), hash: hash(number), parentHash: hash(number - 1),
          timestamp: BigInt(number), orderedTransactionDigest: H2 };
      });
      lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
        blocks, sourceChunkDigests: { "bnbchain-public": H1, publicnode: H1 },
        candidates: [], now: from });
      from = to + 1;
    }
    const zero = requirement(H1, 0n);
    const admitted = await evidence.admitRequirement({ journalOwner: zero.journalOwner,
      journalAgent: zero.journalAgent, journalAction: zero.journalAction,
      journalIdempotencyKey: zero.journalIdempotencyKey, begunAtBlock: zero.begunAtBlock,
      expiry: zero.expiry, preparedIdentityHash: zero.preparedIdentityHash,
      coverageVersion: zero.coverageVersion, quorumId: zero.quorumId, laneId: zero.laneId });
    assert.equal("unavailable" in admitted, false);
    assert.equal(await store.compactZeroExpiry(lane, lease, 1_000), 1);
    const compacted = (await store.listActiveLanes())[0];
    assert.equal(compacted?.rawRetainedFrom, 11n);
    assert.deepEqual(await store.prefixBoundaries(compacted!),
      [{ toBlock: 10n, toBlockHash: hash(10) }]);
    const observer = createLpEvidenceObserver({ config, store, fetchFn: async () => {
      throw new Error("admission must not read an upstream");
    } });
    const backfill = await observer.admission({ begunAtBlock: 10n,
      preparedIdentity: { ...identity, nonce: "8" }, requirementKeyHash: H3 });
    assert.ok(backfill);
    assert.notEqual(backfill.laneId, lane.laneId,
      "Postgres/FakeSql must allocate the same exact post-compaction backfill as Memory");
    await evidence.close();
  });

  it("keeps Postgres/FakeSql cursor, candidate and generation CAS parity", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    const store = new PostgresLpCoverageStore(new FakeSqlClient(), config);
    const lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
      laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await store.claimLease(lane, "test", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    const advanced = await store.commitAgreedRange({ lane, lease, expectedRowVersion: 0,
      blocks: [{ number: 10n, hash: H1, parentHash: H0, timestamp: 401n,
        orderedTransactionDigest: H2 }],
      sourceChunkDigests: { "bnbchain-public": H1, publicnode: H1 }, candidates: [], now: 1 });
    assert.equal(advanced.coveredThrough, 10n);
    const snapshot = await store.snapshot({ requirement: requirement(H1), identity,
      requiredSourceIds: ["bnbchain-public", "publicnode"], expirySafetySeconds: 300 });
    assert.equal(snapshot?.outcome, "absent");
    assert.equal(snapshot === null ? false : await store.validate(snapshot), true);
    assert.equal((await store.recentBlocks(advanced, 10)).length, 1);
    const exhausted = await store.rewind(advanced, null, lease);
    assert.equal(exhausted.state, "exhausted");
    await store.close();
  });

  it("carries canonical raw prefixes through repeated shallow rewinds on both stores", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    for (const store of [new MemoryLpCoverageStore(config),
      new PostgresLpCoverageStore(new FakeSqlClient(), config)] as const) {
      let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
        laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
      await store.registerRequirement(requirement(H1));
      let lease = await store.claimLease(lane, "rewind", 0, 8_000_000_000_000_000);
      assert.ok(lease);
      const candidate: CoverageCandidate = { txHash: H1, inputHash: H2, blockNumber: 10n,
        blockHash: H1, transactionIndex: 0n, intentIndex: 0, memberCount: 1, eoa: OWNER,
        nonce: 7n, executionDataHash: H2, keyHash: H3, logIndex: 1n,
        eventTopicsHash: H2, eventDataHash: H3, candidateDigest: H1 };
      lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
        blocks: [{ number: 10n, hash: H1, parentHash: H0, timestamp: 401n,
          orderedTransactionDigest: H2 }], sourceChunkDigests: {
          "bnbchain-public": H1, publicnode: H1 }, candidates: [candidate], now: 1 });
      lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
        blocks: [{ number: 11n, hash: H2, parentHash: H1,
          timestamp: 402n, orderedTransactionDigest: H3 }], sourceChunkDigests: {
          "bnbchain-public": H2, publicnode: H2 }, candidates: [], now: 1 });
      for (const replacementHash of [H3, H0]) {
        lane = await store.rewind(lane, { number: 10n, hash: H1, parentHash: H0,
          timestamp: 401n, orderedTransactionDigest: H2 }, lease);
        lease = await store.claimLease(lane, "rewind", 2, 8_000_000_000_000_000);
        assert.ok(lease);
        lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
          blocks: [{ number: 11n, hash: replacementHash, parentHash: H1, timestamp: 403n,
            orderedTransactionDigest: H3 }], sourceChunkDigests: {
            "bnbchain-public": replacementHash, publicnode: replacementHash },
          candidates: [], now: 3 });
        const current = await store.snapshot({ requirement: requirement(H1), identity,
          requiredSourceIds: ["bnbchain-public", "publicnode"], expirySafetySeconds: 300 });
        assert.equal(current?.outcome, "landed");
        assert.equal(current === null ? false : await store.validate(current), true);
      }
      await store.close();
    }
  });

  it("rolls back every carried chunk mutation when the rewind cursor CAS fails", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    const sql = new FakeSqlClient();
    const store = new PostgresLpCoverageStore(sql, config);
    let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
      laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await store.claimLease(lane, "rollback", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    const range = Array.from({ length: 50 }, (_, offset) => {
      const number = BigInt(10 + offset); const value = 10 + offset;
      return { number, hash: `0x${value.toString(16).padStart(64, "0")}` as Hex,
        parentHash: `0x${(value - 1).toString(16).padStart(64, "0")}` as Hex,
        timestamp: number, orderedTransactionDigest: H2 };
    });
    const sourceChunkDigests = Object.fromEntries(
      ["bnbchain-public", "publicnode"].map((sourceId) => [sourceId, chunkDigest({ sourceId,
        laneId: H1, generation: 0n, fromBlock: 10n, toBlock: 59n,
        blocks: range.map((block) => ({ number: block.number, hash: block.hash,
          parentHash: block.parentHash, timestamp: block.timestamp,
          transactionListDigest: block.orderedTransactionDigest })) })]),
    ) as Record<string, Hex>;
    lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
      blocks: range, sourceChunkDigests, candidates: [], now: 59 });
    lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
      blocks: [{ number: 60n, hash: H3, parentHash: range.at(-1)!.hash,
        timestamp: 60n, orderedTransactionDigest: H2 }],
      sourceChunkDigests: { "bnbchain-public": H3, publicnode: H3 }, candidates: [], now: 60 });
    for (const [tag, occurrence] of [["lpCoverage.invalidateChunkExact", 2],
      ["lpCoverage.rewindChunkInsert", 2], ["lpCoverage.rewindBlocksCarry", 1],
      ["lpCoverage.rewindCandidatesCarry", 1], ["lpCoverage.rewindQuotaUpdate", 2],
      ["lpCoverage.cursorRewind", 1]] as const) {
      sql.failNextQuery(tag, occurrence);
      await assert.rejects(store.rewind(lane, range.at(-1)!, lease),
        /FakeSql injected failure/);
      const oldRows = await sql.query<{ source_id: string; ordered_block_digest: Hex }>(
        "/* lpCoverage.compactChunksLock */ rollback inspect", [H1, "0", "10", "59"]);
      const leakedRows = await sql.query<{ source_id: string }>(
        "/* lpCoverage.compactChunksLock */ rollback inspect", [H1, "1", "10", "59"]);
      assert.equal(oldRows.rows.length, 2, `${tag} rollback preserves both old source chunks`);
      assert.equal(leakedRows.rows.length, 0,
        `${tag} rollback cannot leak a new-generation chunk`);
    }
    const oldRows = await sql.query<{ source_id: string; ordered_block_digest: Hex }>(
      "/* lpCoverage.compactChunksLock */ rollback inspect", [H1, "0", "10", "59"]);
    for (const old of oldRows.rows) {
      assert.equal(old.ordered_block_digest, sourceChunkDigests[old.source_id]);
    }
    const rewound = await store.rewind(lane, range.at(-1)!, lease);
    const carriedRows = await sql.query<{ source_id: string; ordered_block_digest: Hex }>(
      "/* lpCoverage.compactChunksLock */ carried inspect", [H1, "1", "10", "59"]);
    assert.equal(carriedRows.rows.length, 2);
    for (const carried of carriedRows.rows) {
      assert.equal(carried.ordered_block_digest, chunkDigest({ sourceId: carried.source_id,
        laneId: H1, generation: rewound.generation, fromBlock: 10n, toBlock: 59n,
        blocks: range.map((block) => ({ number: block.number, hash: block.hash,
          parentHash: block.parentHash, timestamp: block.timestamp,
          transactionListDigest: block.orderedTransactionDigest })) }));
    }
  });

  it("keeps split-rewind floors contiguous at first/middle/last and exact age boundaries", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_EVIDENCE_CHUNK_BLOCKS: "50",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    const block = (value: number) => ({ number: BigInt(value),
      hash: `0x${value.toString(16).padStart(64, "0")}` as Hex,
      parentHash: `0x${(value - 1).toString(16).padStart(64, "0")}` as Hex,
      timestamp: BigInt(value), orderedTransactionDigest: H2 });
    const run = async (backend: "memory" | "postgres", ancestorNumber: number) => {
      const sql = new FakeSqlClient();
      const store = backend === "memory" ? new MemoryLpCoverageStore(config) :
        new PostgresLpCoverageStore(sql, config);
      const evidence = backend === "postgres" ?
        await PostgresLpEvidenceStore.create(sql, config, () => 1) : null;
      let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
        laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
      if (evidence === null) await store.registerRequirement(requirement(H1, 0n));
      else {
        const admitted = await evidence.admitRequirement({ journalOwner: OWNER,
          journalAgent: "agent", journalAction: "lp", journalIdempotencyKey: "target",
          begunAtBlock: 10n, expiry: 0n, preparedIdentityHash: H1,
          coverageVersion: H2, quorumId: H3, laneId: H1 });
        assert.equal("unavailable" in admitted, false);
      }
      let lease = await store.claimLease(lane, `${backend}-${ancestorNumber}`, 0,
        8_000_000_000_000_000);
      assert.ok(lease);
      const commitRange = async (from: number, to: number) => {
        const range = Array.from({ length: to - from + 1 }, (_, index) => block(from + index));
        const sourceChunkDigests = Object.fromEntries(
          ["bnbchain-public", "publicnode"].map((sourceId) => [sourceId, chunkDigest({ sourceId,
            laneId: H1, generation: lane.generation, fromBlock: BigInt(from), toBlock: BigInt(to),
            blocks: range.map((entry) => ({ number: entry.number, hash: entry.hash,
              parentHash: entry.parentHash, timestamp: entry.timestamp,
              transactionListDigest: entry.orderedTransactionDigest })) })]),
        ) as Record<string, Hex>;
        lane = await store.commitAgreedRange({ lane, lease: lease!,
          expectedRowVersion: lane.rowVersion, blocks: range,
          sourceChunkDigests, candidates: [], now: to });
      };
      await commitRange(10, 59); await commitRange(60, 60);
      lane = await store.rewind(lane, block(ancestorNumber), lease);
      lease = await store.claimLease(lane, `${backend}-${ancestorNumber}`, 61,
        8_000_000_000_000_000);
      assert.ok(lease);
      let next = ancestorNumber + 1;
      const beforeBoundary = ancestorNumber + 256;
      while (next <= beforeBoundary) {
        const to = Math.min(beforeBoundary, next + 49);
        await commitRange(next, to); next = to + 1;
      }
      assert.equal(await store.compactZeroExpiry(lane, lease, 1_000), 0,
        "256 blocks after the split boundary are still retained");
      await commitRange(next, next);
      assert.equal(await store.compactZeroExpiry(lane, lease, 1_001), 1,
        "the exact 257-block boundary compacts a contiguous split prefix");
      assert.equal((await store.listActiveLanes())[0]?.rawRetainedFrom,
        BigInt(ancestorNumber + 1));
      await evidence?.close();
    };
    for (const backend of ["memory", "postgres"] as const) {
      for (const ancestor of [10, 30, 59]) await run(backend, ancestor);
    }
  });

  it("holds the Memory generation fence across every awaited disposition mutation", async () => {
    const store = new MemoryLpCoverageStore();
    let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
      laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await store.claimLease(lane, "citation", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
      blocks: [{ number: 10n, hash: H1, parentHash: H0, timestamp: 401n,
        orderedTransactionDigest: H2 }],
      sourceChunkDigests: { "bnbchain-public": H1, publicnode: H1 },
      candidates: [], now: 1 });
    const snapshot = await store.snapshot({ requirement: requirement(H1), identity,
      requiredSourceIds: ["bnbchain-public", "publicnode"], expirySafetySeconds: 300 });
    assert.ok(snapshot && snapshot.outcome !== "ambiguous");
    await store.withCurrentEvidence!(snapshot, async () => {
      await Promise.resolve();
      await assert.rejects(store.rewind(lane, { number: 10n, hash: H1, parentHash: H0,
        timestamp: 401n, orderedTransactionDigest: H2 }, lease), /LP_EVIDENCE_CITATION_LOCKED/);
      await assert.rejects(store.markGap(lane, lease), /LP_EVIDENCE_CITATION_LOCKED/);
      assert.equal(await store.validate(snapshot), true);
    });
    assert.equal((await store.rewind(lane, { number: 10n, hash: H1, parentHash: H0,
      timestamp: 401n, orderedTransactionDigest: H2 }, lease)).generation, 1n);
  });

  it("survives successive split rewinds and still refuses candidate-bearing compaction", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_EVIDENCE_CHUNK_BLOCKS: "50",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    const block = (value: number) => ({ number: BigInt(value),
      hash: `0x${value.toString(16).padStart(64, "0")}` as Hex,
      parentHash: `0x${(value - 1).toString(16).padStart(64, "0")}` as Hex,
      timestamp: BigInt(value), orderedTransactionDigest: H2 });
    for (const backend of ["memory", "postgres"] as const) {
      for (const hasCandidate of [false, true]) {
        const sql = new FakeSqlClient();
        const store = backend === "memory" ? new MemoryLpCoverageStore(config) :
          new PostgresLpCoverageStore(sql, config);
        const evidence = backend === "postgres" ?
          await PostgresLpEvidenceStore.create(sql, config, () => 1) : null;
        let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3,
          laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
        if (evidence === null) await store.registerRequirement(requirement(H1, 0n));
        else {
          const admitted = await evidence.admitRequirement({ journalOwner: OWNER,
            journalAgent: "agent", journalAction: "lp", journalIdempotencyKey: "target",
            begunAtBlock: 10n, expiry: 0n, preparedIdentityHash: H1,
            coverageVersion: H2, quorumId: H3, laneId: H1 });
          assert.equal("unavailable" in admitted, false);
        }
        let lease = await store.claimLease(lane, `${backend}-${hasCandidate}`, 0,
          8_000_000_000_000_000);
        assert.ok(lease);
        const commitRange = async (from: number, to: number,
          candidates: readonly CoverageCandidate[] = []) => {
          const range = Array.from({ length: to - from + 1 }, (_, index) => block(from + index));
          const sourceChunkDigests = Object.fromEntries(
            ["bnbchain-public", "publicnode"].map((sourceId) => [sourceId, chunkDigest({ sourceId,
              laneId: H1, generation: lane.generation, fromBlock: BigInt(from), toBlock: BigInt(to),
              blocks: range.map((entry) => ({ number: entry.number, hash: entry.hash,
                parentHash: entry.parentHash, timestamp: entry.timestamp,
                transactionListDigest: entry.orderedTransactionDigest })) })]),
          ) as Record<string, Hex>;
          lane = await store.commitAgreedRange({ lane, lease: lease!,
            expectedRowVersion: lane.rowVersion, blocks: range,
            sourceChunkDigests, candidates, now: to });
        };
        const candidate: CoverageCandidate = { txHash: H1, inputHash: H2,
          blockNumber: 10n, blockHash: block(10).hash, transactionIndex: 0n,
          intentIndex: 0, memberCount: 1, eoa: OWNER, nonce: 7n,
          executionDataHash: H2, keyHash: H3, logIndex: 1n,
          eventTopicsHash: H2, eventDataHash: H3, candidateDigest: H1 };
        await commitRange(10, 59, hasCandidate ? [candidate] : []);
        await commitRange(60, 60);
        lane = await store.rewind(lane, block(30), lease);
        lease = await store.claimLease(lane, `${backend}-${hasCandidate}`, 61,
          8_000_000_000_000_000);
        assert.ok(lease);
        await commitRange(31, 60);
        lane = await store.rewind(lane, block(20), lease);
        lease = await store.claimLease(lane, `${backend}-${hasCandidate}`, 62,
          8_000_000_000_000_000);
        assert.ok(lease);
        for (let from = 21; from <= 277;) {
          const to = Math.min(277, from + 49);
          await commitRange(from, to); from = to + 1;
        }
        assert.equal(await store.compactZeroExpiry(lane, lease, 1_000),
          hasCandidate ? 0 : 1,
          hasCandidate ? "a surviving candidate prevents zero-prefix compaction" :
            "successive split chunks retain exact contiguous provenance");
        await evidence?.close();
      }
    }
  });

  it("commits only all-required finalized agreement and turns disagreement into a gap", async () => {
    const sources = JSON.stringify([
      { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
      { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
    ]);
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: sources });
    const run = async (disagree: boolean): Promise<{ advanced: number; gaps: number }> => {
      const coverage = new MemoryLpCoverageStore();
      const fetchFn: typeof fetch = async (resource, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string; params: readonly unknown[] };
        const url = String(resource);
        const result = body.method === "eth_getBlockByNumber" && body.params[1] === false
          ? { number: "0xa" }
          : { number: "0xa",
              hash: disagree && url.includes("publicnode") ? H2 : H1,
              parentHash: H0, timestamp: "0x191", transactions: [] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
          { status: 200, headers: { "content-type": "application/json" } });
      };
      const observer = createLpEvidenceObserver({ config, store: coverage, fetchFn });
      const admission = await observer.admission({ begunAtBlock: 10n, preparedIdentity: identity,
        requirementKeyHash: H0 });
      assert.ok(admission);
      await coverage.registerRequirement(requirement(admission.laneId));
      return observer.scanOnce();
    };
    assert.deepEqual(await run(false), { advanced: 1, gaps: 0 });
    assert.deepEqual(await run(true), { advanced: 0, gaps: 1 });
  });

  it("advances past unrelated traffic and scopes failed intents to matching-identity ambiguity", async () => {
    const fixture = PINNED_PORTO_ALTANA_SANITIZED_FIXTURE;
    const fixtureIdentity: PreparedIntentIdentityV1 = { scheme: "porto-intent-v1",
      decoder: "porto-orchestrator-intent-v055", chainId: "56", eoa: fixture.eoa,
      orchestrator: fixture.orchestrator, orchestratorVersion: fixture.orchestratorVersion,
      nonce: fixture.nonce.toString(10), expiry: fixture.expiry.toString(10),
      executionDataHash: fixture.executionDataHash, keyHash: fixture.keyHash };
    const run = async (receiptMode: "success" | "reverted" | "member-error") => {
      const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
        LP_EVIDENCE_REQUESTS_PER_SECOND: "100",
        LP_EVIDENCE_CHUNK_BLOCKS: "1",
        LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
          { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
          { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
        ]) });
      const coverage = new MemoryLpCoverageStore(config);
      const blockNumber = fixture.blockNumber;
      const transactions: Array<{ hash: Hex; from: Address; to: Address | null; input: Hex;
        transactionIndex: Hex; blockNumber: Hex; blockHash: Hex }> =
        Array.from({ length: 106 }, (_, index) => ({
        hash: `0x${(1_000 + index).toString(16).padStart(64, "0")}` as Hex,
        from: OWNER, to: null, input: "0x" as Hex,
        transactionIndex: `0x${index.toString(16)}` as Hex,
        blockNumber: `0x${blockNumber.toString(16)}` as Hex, blockHash: fixture.blockHash,
        }));
      transactions[0] = { ...transactions[0]!, to: fixture.orchestrator,
        input: "0xdeadbeef" as Hex };
      transactions[105] = { ...fixture.rawTransaction,
        input: fixture.rawTransactionInput };
      const logData = receiptMode === "member-error"
        ? `0x${"0".repeat(63)}1deadbeef${"0".repeat(56)}` as Hex
        : fixture.rawReceiptLog.data;
      const fetchFn: typeof fetch = async (_resource, init) => {
        const request = JSON.parse(String(init?.body)) as {
          method: string; params: readonly unknown[] };
        const result = request.method === "eth_getBlockByNumber" && request.params[1] === false
          ? { number: `0x${blockNumber.toString(16)}` }
          : request.method === "eth_getBlockByNumber"
            ? { number: `0x${blockNumber.toString(16)}`, hash: fixture.blockHash,
                parentHash: H0, timestamp: fixture.rawBlockTimestamp, transactions }
            : { ...fixture.rawReceipt,
                status: receiptMode === "reverted" ? "0x0" : "0x1",
                logs: receiptMode === "reverted" ? [] : [{ ...fixture.rawReceiptLog,
                  data: logData }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
          { status: 200, headers: { "content-type": "application/json" } });
      };
      const observer = createLpEvidenceObserver({ config, store: coverage, fetchFn });
      const admission = await observer.admission({ begunAtBlock: blockNumber,
        preparedIdentity: fixtureIdentity, requirementKeyHash: H1 });
      assert.ok(admission);
      const target: EvidenceRequirement = { ...requirement(admission.laneId, 0n),
        begunAtBlock: blockNumber, preparedIdentityHash: H1,
        coverageVersion: admission.coverageVersion, quorumId: admission.quorumId,
        coverageGeneration: admission.generation ?? 0n };
      await coverage.registerRequirement(target);
      assert.deepEqual(await observer.scanOnce(), { advanced: 1, gaps: 0 });
      const snapshot = await coverage.snapshot({ requirement: target, identity: fixtureIdentity,
        requiredSourceIds: ["bnbchain-public", "publicnode"], expirySafetySeconds: 300 });
      await coverage.close();
      return snapshot;
    };
    assert.equal((await run("success"))?.outcome, "landed",
      "unknown-selector traffic beside a valid target is ignored locally");
    assert.deepEqual(await run("reverted"), { outcome: "ambiguous",
      reason: "matching-candidate-not-successful" });
    assert.deepEqual(await run("member-error"), { outcome: "ambiguous",
      reason: "matching-candidate-not-successful" });
  });

  it("uses the cold cap for initial catch-up, not as a lifetime cursor-height limit", async () => {
    const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]), LP_EVIDENCE_CHUNK_BLOCKS: "1", LP_EVIDENCE_MAX_COLD_BACKFILL_BLOCKS: "1" });
    const coverage = new MemoryLpCoverageStore(config);
    let head = 10n;
    const fetchFn: typeof fetch = async (_resource, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: readonly unknown[] };
      const full = body.method === "eth_getBlockByNumber" && body.params[1] === true;
      const number = full ? BigInt(String(body.params[0])) : head;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: full
        ? { number: `0x${number.toString(16)}`, hash: number === 10n ? H1 : H2,
            parentHash: number === 10n ? H0 : H1, timestamp: "0x191", transactions: [] }
        : { number: `0x${head.toString(16)}` } }), { status: 200,
        headers: { "content-type": "application/json" } });
    };
    const observer = createLpEvidenceObserver({ config, store: coverage, fetchFn });
    const admission = await observer.admission({ begunAtBlock: 10n, preparedIdentity: identity,
      requirementKeyHash: H0 });
    assert.ok(admission);
    await coverage.registerRequirement(requirement(admission.laneId));
    assert.deepEqual(await observer.scanOnce(), { advanced: 1, gaps: 0 });
    head = 11n;
    assert.deepEqual(await observer.scanOnce(), { advanced: 1, gaps: 0 });
    assert.equal((await coverage.listActiveLanes())[0]?.coveredThrough, 11n);
  });
});

for (const backend of [
  { name: "memory", make: async (): Promise<LpEvidenceStore> =>
    new MemoryLpEvidenceStore(resolveLpEvidenceConfig({}), () => 1_000) },
  { name: "postgres(fake)", make: async (): Promise<LpEvidenceStore> =>
    PostgresLpEvidenceStore.create(new FakeSqlClient(), resolveLpEvidenceConfig({}), () => 1_000) },
] as const) {
  describe(`Phase 3.9c resolution tombstone — ${backend.name}`, () => {
    it("retains the permanent response while exactly-once cleanup frees the requirement slot", async () => {
      const store = await backend.make();
      const source = requirement(H1);
      const admitted = await store.admitRequirement({ journalOwner: source.journalOwner,
        journalAgent: source.journalAgent, journalAction: source.journalAction,
        journalIdempotencyKey: source.journalIdempotencyKey, begunAtBlock: source.begunAtBlock,
        expiry: source.expiry, preparedIdentityHash: source.preparedIdentityHash,
        coverageVersion: source.coverageVersion, quorumId: source.quorumId, laneId: source.laneId });
      assert.equal("unavailable" in admitted, false);
      const target = { journalOwner: OWNER, journalAgent: "agent", journalAction: "lp",
        journalIdempotencyKey: "target" };
      let resolution = (await store.createOrJoinResolution({ target,
        preparedIdentityHash: H1,
        action: { owner: OWNER, agent: "agent", kind: "resolveUnknownLandingV1",
          idempotencyKey: "action" }, originSequenceId: "sequence", originSnapshotHash: H2 })).resolution;
      const evidence = canonicalLandingEvidence({ scheme: "lp-landing-evidence-v1",
        outcome: "absent", preparedIdentityHash: H1, coverageVersion: H2, quorumId: H3,
        laneId: H1, generation: "0", cursorRowVersion: "1", requiredSourceIds: ["a", "b"],
        fromBlock: "10", toBlock: "11", toBlockHash: H2,
        absent: { toBlockTimestamp: "401", expirySafetySeconds: 300, zeroMatchCount: 0 } });
      resolution = (await store.bindEvidence({ resolutionId: resolution.resolutionId,
        expectedRowVersion: resolution.rowVersion, evidence })).resolution;
      resolution = await store.advanceResolution({ resolutionId: resolution.resolutionId,
        expectedRowVersion: resolution.rowVersion, expectedPhase: "evidence-bound",
        phase: "disposition-started" });
      resolution = await store.advanceResolution({ resolutionId: resolution.resolutionId,
        expectedRowVersion: resolution.rowVersion, expectedPhase: "disposition-started",
        phase: "journal-written", outcome: "absent", targetJournalTerminalState: "ROLLED_BACK",
        responseAction: "retire-not-landed" });
      resolution = await store.advanceResolution({ resolutionId: resolution.resolutionId,
        expectedRowVersion: resolution.rowVersion, expectedPhase: "journal-written",
        phase: "recovery-written", recoveryAfterConfirm: "none" });
      resolution = await store.advanceResolution({ resolutionId: resolution.resolutionId,
        expectedRowVersion: resolution.rowVersion, expectedPhase: "recovery-written",
        phase: "postprocessed" });
      resolution = await store.terminalize({ resolutionId: resolution.resolutionId,
        expectedRowVersion: resolution.rowVersion,
        terminalizingAction: { owner: OWNER, agent: "agent", kind: "resolveUnknownLandingV1",
          idempotencyKey: "action" } });
      assert.equal(resolution.phase, "terminal");
      assert.equal(await store.cleanupRetained(resolution.evidenceRetainedUntil ?? 0), 1);
      assert.equal((await store.getResolution(resolution.resolutionId))?.phase, "terminal");
      assert.equal(await store.cleanupRetained(Number.MAX_SAFE_INTEGER), 0);
      await store.close();
    });
  });
}

it("atomically debits exact owned and raw charges when a retained lane becomes unshared", async () => {
  const config = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
    LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
      { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
      { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
    ]) });
  const sql = new FakeSqlClient();
  const evidenceStore = await PostgresLpEvidenceStore.create(sql, config, () => 1_000);
  const coverageStore = new PostgresLpCoverageStore(sql, config);
  let lane = await coverageStore.ensureLane({ coverageVersion: H2, quorumId: H3,
    laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
  const lease = await coverageStore.claimLease(lane, "cleanup", 0, 8_000_000_000_000_000);
  assert.ok(lease);
  const rawBlocks = Array.from({ length: 50 }, (_, offset) => {
    const value = 10 + offset;
    return { number: BigInt(value), hash: `0x${value.toString(16).padStart(64, "0")}` as Hex,
      parentHash: `0x${(value - 1).toString(16).padStart(64, "0")}` as Hex,
      timestamp: BigInt(400 + value), orderedTransactionDigest: H2 };
  });
  const unrelatedCandidate: CoverageCandidate = { txHash: H3, inputHash: H2,
    blockNumber: 20n, blockHash: rawBlocks[10]!.hash, transactionIndex: 0n,
    intentIndex: 0, memberCount: 1, eoa: `0x${"ab".repeat(20)}`, nonce: 99n,
    executionDataHash: H2, keyHash: H3, logIndex: 1n,
    eventTopicsHash: H2, eventDataHash: H3, candidateDigest: H3 };
  lane = await coverageStore.commitAgreedRange({ lane, lease, expectedRowVersion: 0,
    blocks: rawBlocks, sourceChunkDigests: {
      "bnbchain-public": H1, publicnode: H1 }, candidates: [unrelatedCandidate], now: 1 });
  lane = await coverageStore.rewind(lane, rawBlocks[20]!, lease);
  const retained = await sql.query<{ generation: string; source_id: string; from_block: string;
    to_block: string; state: string; first_hash: Hex; last_hash: Hex;
    ordered_block_digest: Hex; candidate_count: string; charged_logical_bytes: string }>(
    "/* lpEvidence.cleanupChunksLock */ provenance inspect", [H1]);
  const originals = retained.rows.filter((row) => row.generation === "0" &&
    row.from_block === "10" && row.to_block === "59" && row.state === "invalidated");
  assert.equal(originals.length, 2);
  for (const original of originals) {
    assert.equal(original.first_hash, rawBlocks[0]!.hash);
    assert.equal(original.last_hash, rawBlocks.at(-1)!.hash);
    assert.equal(original.ordered_block_digest, H1);
    assert.equal(String(original.candidate_count), "1");
    assert.equal(BigInt(original.charged_logical_bytes),
      chunkChargedLogicalBytes(original.source_id));
  }
  const currentPrefixes = retained.rows.filter((row) => row.generation === "1" &&
    row.from_block === "10" && row.to_block === "30" && row.state === "complete");
  assert.equal(currentPrefixes.length, 2);
  for (const sourceId of ["bnbchain-public", "publicnode"]) {
    const oldRaw = await sql.query<{ block_number: string }>(
      "/* lpCoverage.rewindChunkBlocks */ old raw inspect",
      [H2, H3, H1, "0", sourceId, "10", "59"]);
    const newRaw = await sql.query<{ block_number: string }>(
      "/* lpCoverage.rewindChunkBlocks */ new raw inspect",
      [H2, H3, H1, "1", sourceId, "10", "30"]);
    assert.equal(oldRaw.rows.length, 50, "the invalidated generation retains its exact tail");
    assert.equal(newRaw.rows.length, 21, "the current generation owns a separately charged prefix");
    const oldCandidates = await sql.query<{ candidate_count: string }>(
      "/* lpCoverage.rewindChunkCandidateCount */ old candidate inspect",
      [H2, H3, H1, "0", sourceId, "10", "59"]);
    const newCandidates = await sql.query<{ candidate_count: string }>(
      "/* lpCoverage.rewindChunkCandidateCount */ new candidate inspect",
      [H2, H3, H1, "1", sourceId, "10", "30"]);
    assert.equal(Number(oldCandidates.rows[0]?.candidate_count), 1);
    assert.equal(Number(newCandidates.rows[0]?.candidate_count), 1);
  }
  const source = requirement(H1);
  await evidenceStore.admitRequirement({ journalOwner: source.journalOwner,
    journalAgent: source.journalAgent, journalAction: source.journalAction,
    journalIdempotencyKey: source.journalIdempotencyKey, begunAtBlock: source.begunAtBlock,
    expiry: source.expiry, preparedIdentityHash: source.preparedIdentityHash,
    coverageVersion: source.coverageVersion, quorumId: source.quorumId, laneId: source.laneId,
    coverageGeneration: lane.generation });
  const target = { journalOwner: OWNER, journalAgent: "agent", journalAction: "lp",
    journalIdempotencyKey: "target" };
  let resolution = (await evidenceStore.createOrJoinResolution({ target,
    preparedIdentityHash: H1, action: { owner: OWNER, agent: "agent",
      kind: "resolveUnknownLandingV1", idempotencyKey: "action" },
    originSequenceId: "sequence", originSnapshotHash: H2 })).resolution;
  const body = canonicalLandingEvidence({ scheme: "lp-landing-evidence-v1",
    outcome: "absent", preparedIdentityHash: H1, coverageVersion: H2, quorumId: H3,
    laneId: H1, generation: lane.generation.toString(10),
    cursorRowVersion: lane.rowVersion.toString(10),
    requiredSourceIds: ["bnbchain-public", "publicnode"], fromBlock: "10", toBlock: "30",
    toBlockHash: rawBlocks[20]!.hash,
    absent: { toBlockTimestamp: "401", expirySafetySeconds: 300, zeroMatchCount: 0 } });
  resolution = (await evidenceStore.bindEvidence({ resolutionId: resolution.resolutionId,
    expectedRowVersion: resolution.rowVersion, evidence: body })).resolution;
  for (const [from, to, fields] of [
    ["evidence-bound", "disposition-started", {}],
    ["disposition-started", "journal-written", { outcome: "absent",
      targetJournalTerminalState: "ROLLED_BACK", responseAction: "retire-not-landed" }],
    ["journal-written", "recovery-written", { recoveryAfterConfirm: "none" }],
    ["recovery-written", "postprocessed", {}],
  ] as const) {
    resolution = await evidenceStore.advanceResolution({ resolutionId: resolution.resolutionId,
      expectedRowVersion: resolution.rowVersion, expectedPhase: from, phase: to, ...fields });
  }
  resolution = await evidenceStore.terminalize({ resolutionId: resolution.resolutionId,
    expectedRowVersion: resolution.rowVersion, terminalizingAction: { owner: OWNER,
      agent: "agent", kind: "resolveUnknownLandingV1", idempotencyKey: "action" } });
  const chargedBefore = (await evidenceStore.quota()).logicalBytes;
  assert.ok(chargedBefore > 0n);
  assert.equal(await evidenceStore.cleanupRetained(resolution.evidenceRetainedUntil ?? 0), 1);
  assert.equal((await evidenceStore.quota()).logicalBytes, 0n);
  const tombstone = await evidenceStore.getResolution(resolution.resolutionId);
  assert.equal(tombstone?.evidenceCleanupChargedBytes, chargedBefore);
  assert.equal((await coverageStore.listActiveLanes()).length, 0);
  await evidenceStore.close();
});

describe("Phase 3.9c exhaustive disposition/accounting pins", () => {
  it("pins atomic step-8 lock/write order with sequence release last", async () => {
    const terminalEvidence = canonicalLandingEvidence({ scheme: "lp-landing-evidence-v1",
      outcome: "absent", preparedIdentityHash: H1, coverageVersion: H2, quorumId: H3,
      laneId: H1, generation: "0", cursorRowVersion: "1",
      requiredSourceIds: ["a", "b"], fromBlock: "10", toBlock: "10",
      toBlockHash: H1, absent: { toBlockTimestamp: "401",
        expirySafetySeconds: 300, zeroMatchCount: 0 } });
    class FinalizerSql implements SqlClient {
      readonly tags: string[] = [];
      readonly statements: string[] = [];
      async query<R = Record<string, unknown>>(text: string): Promise<SqlResult<R>> {
        const tag = /\/\*\s*([\w.]+)\s*\*\//.exec(text)?.[1] ?? "ddl";
        this.tags.push(tag);
        this.statements.push(text);
        const rows: Record<string, unknown>[] = tag === "landingFinalize.phaseEvidenceLock"
          ? [{ evidence_bytes: JSON.stringify(terminalEvidence),
              evidence_hash: terminalEvidence.evidenceDigest, coverage_version: H2,
              quorum_id: H3, lane_id: H1, generation: "0", cursor_row_version: "1" }]
          : tag === "landingFinalize.phaseCursorValidate"
            ? [{ lane_id: H1 }]
          : tag === "landingFinalize.phaseRequirementValidate"
            ? [{ journal_owner: OWNER }]
          : tag.endsWith("positionLock") ? [{ position_id: "position" }]
          : tag.endsWith("sequenceLock") || tag.endsWith("sequenceRelease")
            ? [{ sequence_id: "sequence" }]
          : tag.endsWith("journalLock") || tag.endsWith("journalTerminal") ||
              tag.endsWith("actionLock") || tag.endsWith("actionComplete")
            ? [{ idempotency_key: "target" }]
          : tag.endsWith("resolutionLock") || tag.endsWith("resolutionTerminal") ||
              tag.endsWith("evidenceRetain") ? [{ resolution_id: "resolution" }]
          : tag.endsWith("requirementTerminal") ? [{ journal_idempotency_key: "target" }]
          : [];
        return { rows: structuredClone(rows) as R[] };
      }
      transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> { return fn(this); }
      async close(): Promise<void> {}
    }
    const sql = new FinalizerSql();
    const finalizer = new PostgresLandingResolutionFinalizer(sql, resolveLpEvidenceConfig({}));
    await finalizer.finalize({ decisionId: "lp:s:0", owner: OWNER, agentId: "agent",
      positionId: "position",
      sequenceId: "sequence", resolutionId: "resolution", resolverFence: 1n,
      expectedResolverRowVersion: 2, expectedResolutionRowVersion: 3,
      targetSequenceState: "rolled-back", journalIdempotencyKey: "target",
      resolutionKeyHash: H2, outcome: "absent", evidenceHash: terminalEvidence.evidenceDigest,
      terminalizingAction: { owner: OWNER, agent: "agent", kind: "resolveUnknownLandingV1",
        idempotencyKey: "action" }, now: 1_000 });
    assert.deepEqual(sql.tags.slice(0, 7), ["landingFinalize.phaseEvidenceLock",
      "landingFinalize.phaseCursorValidate", "landingFinalize.phaseRequirementValidate",
      "landingFinalize.positionLock",
      "landingFinalize.sequenceLock", "landingFinalize.journalLock",
      "landingFinalize.resolutionLock"]);
    assert.equal(sql.tags.at(-1), "landingFinalize.sequenceRelease");
    for (const statement of sql.statements.filter((value) => value.includes("owner_address") ||
      value.includes("journal_owner"))) {
      assert.match(statement, /lower\((?:r\.)?(?:owner_address|journal_owner)\)=lower\(/,
        "checksum/lowercase owner representations must share one SQL tenant boundary");
    }
  });

  it("revalidates the durable requirement before every disposition phase", async () => {
    const evidence = canonicalLandingEvidence({ scheme: "lp-landing-evidence-v1",
      outcome: "absent", preparedIdentityHash: H1, coverageVersion: H2, quorumId: H3,
      laneId: H1, generation: "0", cursorRowVersion: "1",
      requiredSourceIds: ["a", "b"], fromBlock: "10", toBlock: "10",
      toBlockHash: H1, absent: { toBlockTimestamp: "401",
        expirySafetySeconds: 300, zeroMatchCount: 0 } });
    class InvalidatedSql implements SqlClient {
      readonly tags: string[] = [];
      async query<R = Record<string, unknown>>(text: string): Promise<SqlResult<R>> {
        const tag = /\/\*\s*([\w.]+)\s*\*\//.exec(text)?.[1] ?? "ddl";
        this.tags.push(tag);
        const rows = tag === "landingFinalize.phaseEvidenceLock" ? [{
          evidence_bytes: JSON.stringify(evidence), evidence_hash: evidence.evidenceDigest,
          coverage_version: H2, quorum_id: H3, lane_id: H1, generation: "0",
          cursor_row_version: "1",
        }] : tag === "landingFinalize.phaseCursorValidate" ? [{ lane_id: H1 }] : [];
        return { rows: structuredClone(rows) as R[] };
      }
      transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> { return fn(this); }
      async close(): Promise<void> {}
    }
    const common = { owner: OWNER, agentId: "agent", positionId: "position",
      sequenceId: "sequence", resolutionId: "resolution", resolverFence: 1n,
      expectedResolverRowVersion: 2, expectedResolutionRowVersion: 3, now: 1_000 } as const;
    const phases = [
      (finalizer: PostgresLandingResolutionFinalizer) => finalizer.beginDisposition({
        ...common, evidence }),
      (finalizer: PostgresLandingResolutionFinalizer) => finalizer.writeJournalDisposition({
        ...common, journalIdempotencyKey: "target", resolutionKeyHash: H2,
        outcome: "absent" }),
      (finalizer: PostgresLandingResolutionFinalizer) => finalizer.writeRecovery({
        ...common, journalIdempotencyKey: "target", resolutionKeyHash: H2,
        outcome: "absent", recoveryState: "none", note: "not-landed:open-mint" }),
      (finalizer: PostgresLandingResolutionFinalizer) => finalizer.postprocess({
        ...common, expectedPositionVersion: 1, journalIdempotencyKey: "target",
        resolutionKeyHash: H2, outcome: "absent", positionMutation: "close",
        releaseReservation: true }),
      (finalizer: PostgresLandingResolutionFinalizer) => finalizer.finalize({
        ...common, decisionId: "lp:s:0", targetSequenceState: "rolled-back",
        journalIdempotencyKey: "target",
        resolutionKeyHash: H2, outcome: "absent", evidenceHash: evidence.evidenceDigest,
        terminalizingAction: { owner: OWNER, agent: "agent",
          kind: "resolveUnknownLandingV1", idempotencyKey: "action" } }),
    ];
    for (const phase of phases) {
      const sql = new InvalidatedSql();
      await assert.rejects(phase(new PostgresLandingResolutionFinalizer(sql,
        resolveLpEvidenceConfig({}))), /requirement is no longer eligible/);
      assert.deepEqual(sql.tags, ["landingFinalize.phaseEvidenceLock",
        "landingFinalize.phaseCursorValidate", "landingFinalize.phaseRequirementValidate"],
      "an unavailable requirement must abort before any phase row lock or write");
    }
  });

  it("makes a missing requirement a strict Memory/Postgres authorization veto", async () => {
    const { MemoryEvidenceRequirementRegistry } = await import("../src/store/lpEvidence.js");
    const memory = new MemoryLpCoverageStore(undefined,
      new MemoryEvidenceRequirementRegistry(), true);
    const lane = await memory.ensureLane({ coverageVersion: H2, quorumId: H3,
      laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await memory.claimLease(lane, "strict", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    await memory.commitAgreedRange({ lane, lease, expectedRowVersion: 0,
      blocks: [{ number: 10n, hash: H1, parentHash: H0, timestamp: 401n,
        orderedTransactionDigest: H2 }], sourceChunkDigests: { a: H1, b: H1 },
      candidates: [], now: 1 });
    assert.equal(await memory.snapshot({ requirement: requirement(H1), identity,
      requiredSourceIds: ["a", "b"], expirySafetySeconds: 300 }), null);

    const strictConfig = resolveLpEvidenceConfig({ LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]) });
    const postgres = new PostgresLpCoverageStore(
      new FakeSqlClient({ strictLpRequirementAuthorization: true }),
      strictConfig,
    );
    const pgLane = await postgres.ensureLane({ coverageVersion: H2, quorumId: H3,
      laneId: H1, purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const pgLease = await postgres.claimLease(pgLane, "strict", 0, 8_000_000_000_000_000);
    assert.ok(pgLease);
    await postgres.commitAgreedRange({ lane: pgLane, lease: pgLease, expectedRowVersion: 0,
      blocks: [{ number: 10n, hash: H1, parentHash: H0, timestamp: 401n,
        orderedTransactionDigest: H2 }], sourceChunkDigests: {
          "bnbchain-public": H1, publicnode: H1 }, candidates: [], now: 1 });
    assert.equal(await postgres.snapshot({ requirement: requirement(H1), identity,
      requiredSourceIds: ["bnbchain-public", "publicnode"], expirySafetySeconds: 300 }), null);
  });

  it("keeps the v1 signed schema exact and nonce-consuming", () => {
    assert.deepEqual(parseLpResolveLandingV1Params({ decisionId: "lp:s:0",
      evidenceVersion: "lp-landing-evidence-v1" }), { ok: true,
      value: { decisionId: "lp:s:0", evidenceVersion: "lp-landing-evidence-v1" } });
    assert.equal(parseLpResolveLandingV1Params({ decisionId: "lp:s:0",
      evidenceVersion: "lp-landing-evidence-v1", txHash: H1 }).ok, false);
    assert.equal(parseLpResolveLandingV1Params({ decisionId: "lp:s:0",
      evidenceVersion: "v2" }).ok, false);
    assert.equal(isMutatingOwnerAction("resolveUnknownLandingV1"), true);
  });

  it("defines every legal kind/step/outcome row", () => {
    const expected = {
      "open:0:landed": ["none", "landing-evidence:landed:open-mint", "attach-token"],
      "open:0:absent": ["none", "not-landed:open-mint", "close"],
      "rotate:0:landed": ["pending-mint", "landing-evidence:landed:rotate-zap-out", "none"],
      "rotate:0:absent": ["none", "not-landed:rotate-zap-out;original-open", "open"],
      "rotate:1:landed": ["wbnb-stranded", "landing-evidence:landed:rotate-sweep", "none"],
      "rotate:1:absent": ["none", "not-landed:rotate-sweep;principal-in-wallet", "close"],
      "rotate:2:landed": ["none", "landing-evidence:landed:rotate-mint", "attach-token"],
      "rotate:2:absent": ["none", "not-landed:rotate-mint;no-new-nft", "close"],
      "harvest:0:landed": ["pending-increase", "landing-evidence:landed:harvest-collect", "none"],
      "harvest:0:absent": ["none", "not-landed:harvest-collect;position-open", "none"],
      "harvest:1:landed": ["wbnb-stranded", "landing-evidence:landed:harvest-sweep", "none"],
      "harvest:1:absent": ["none", "not-landed:harvest-sweep;fees-in-wallet", "none"],
      "harvest:2:landed": ["none", "landing-evidence:landed:harvest-increase", "none"],
      "harvest:2:absent": ["none", "not-landed:harvest-increase;proceeds-in-wallet", "none"],
      "protect:0:landed": ["none", "landing-evidence:landed:protect-zap-out", "close"],
      "protect:0:absent": ["none", "not-landed:protect-zap-out;restored-open", "open"],
      "protect:1:landed": ["none", "landing-evidence:landed:protect-sweep", "close"],
      "protect:1:absent": ["none", "not-landed:protect-sweep;conversion-missing", "close"],
      "manual-exit:0:landed": ["none", "landing-evidence:landed:manual-zap-out", "close"],
      "manual-exit:0:absent": ["none", "not-landed:manual-zap-out;restored-open", "open"],
      "manual-exit:1:landed": ["none", "landing-evidence:landed:manual-sweep", "close"],
      "manual-exit:1:absent": ["none", "not-landed:manual-sweep;conversion-missing", "close"],
    } as const;
    const widths = { open: 1, rotate: 3, harvest: 3, protect: 2, "manual-exit": 2 } as const;
    let rows = 0;
    for (const [kind, width] of Object.entries(widths)) {
      for (let step = 0; step < width; step += 1) {
        for (const outcome of ["landed", "absent"] as const) {
          const disposition = landingDispositionFor({ kind: kind as keyof typeof widths }, step,
            outcome);
          assert.deepEqual([disposition.recovery, disposition.note, disposition.position],
            expected[`${kind}:${step}:${outcome}` as keyof typeof expected]);
          rows += 1;
        }
      }
    }
    assert.equal(rows, 22);
    assert.throws(() => landingDispositionFor({ kind: "open" }, 1, "landed"));
  });

  it("releases only a never-spent quota reservation on absent", () => {
    assert.equal(absentDispositionReleasesReservation({ kind: "open" }, 0, []), true);
    assert.equal(absentDispositionReleasesReservation({ kind: "rotate" }, 1, [{
      state: "COMMITTED", externalRef: {},
    } as never]), true, "a bookkeeping commit is not a transaction");
    assert.equal(absentDispositionReleasesReservation({ kind: "rotate" }, 1, [{
      state: "COMMITTED", externalRef: { txHash: H1 },
    } as never]), false);
    assert.equal(absentDispositionReleasesReservation({ kind: "protect" }, 0, []), true);
    assert.equal(absentDispositionReleasesReservation({ kind: "manual-exit" }, 0, []), true);
    assert.equal(absentDispositionReleasesReservation({ kind: "protect" }, 1, []), true);
    assert.equal(absentDispositionReleasesReservation({ kind: "manual-exit" }, 1, []), true);
    assert.equal(absentDispositionReleasesReservation({ kind: "protect" }, 1, [{
      state: "COMMITTED", externalRef: { txHash: H1 },
    } as never]), false);
    assert.equal(absentDispositionReleasesReservation({ kind: "manual-exit" }, 1, [{
      state: "COMMITTED", externalRef: { txHash: H1 },
    } as never]), false);
  });
});
