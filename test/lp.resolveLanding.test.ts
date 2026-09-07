import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { resolveLpEvidenceConfig } from "../src/ops/config.js";
import { canonicalPreparedIntentIdentityV1 } from "../src/lp/preparedIntent.js";
import {
  resolveUnknownLandingV1,
  type LandingEvidenceProvider,
} from "../src/lp/resolveLanding.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryLpEvidenceStore, canonicalLandingEvidence } from "../src/store/lpEvidence.js";
import { MemoryLpSequenceStore, lpStepDecisionId } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import type { LpServerDeps } from "../src/server.js";
import { AGENT_ID, call, createHarness, ownerAccount,
  signOwnerAction } from "./support/serverHarness.js";

const OWNER = `0x${"12".repeat(20)}` as Address;
const TOKEN0 = `0x${"34".repeat(20)}` as Address;
const TOKEN1 = `0x${"56".repeat(20)}` as Address;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const H3 = `0x${"33".repeat(32)}` as Hex;

function fixture(outcome: "landed" | "absent") {
  let now = 1_000;
  const clock = () => now;
  const journal = new MemoryExecutionJournal(clock);
  const sequences = new MemoryLpSequenceStore(clock);
  const evidenceStore = new MemoryLpEvidenceStore(resolveLpEvidenceConfig({}), clock);
  let providerReads = 0;
  const provider: LandingEvidenceProvider = {
    enabled: true,
    async admission() {
      return { coverageVersion: H1, quorumId: H2, laneId: H3 };
    },
    async snapshot(input) {
      providerReads += 1;
      const common = {
        scheme: "lp-landing-evidence-v1" as const,
        preparedIdentityHash: input.requirement.preparedIdentityHash,
        coverageVersion: H1,
        quorumId: H2,
        laneId: H3,
        generation: "0",
        cursorRowVersion: "1",
        requiredSourceIds: ["a", "b"],
        fromBlock: "10",
        toBlock: "11",
        toBlockHash: H2,
      };
      return outcome === "landed"
        ? { outcome, evidence: canonicalLandingEvidence({ ...common, outcome,
            landed: { txHash: H3, inputHash: H1, blockNumber: "10", blockHash: H3,
              transactionIndex: "0", intentIndex: 0, logIndex: "1",
              eventTopicsHash: H1, eventDataHash: H2 } }) }
        : { outcome, evidence: canonicalLandingEvidence({ ...common, outcome,
            absent: { toBlockTimestamp: "401", expirySafetySeconds: 300,
              zeroMatchCount: 0 } }) };
    },
    async validateStored() { return true; },
    async withCurrentEvidence(_evidence, mutation) {
      // This fixture has no mutable coverage generation; the callback is its
      // explicit atomic citation boundary.
      return mutation();
    },
  };
  return { journal, sequences, evidenceStore, provider, clock,
    advance: (ms = 100) => { now += ms; }, reads: () => providerReads };
}

async function seed(outcome: "landed" | "absent") {
  const fx = fixture(outcome);
  const position = await fx.sequences.createPosition({ positionId: `position-${outcome}`,
    agentId: "agent", ownerAddress: OWNER, token0: TOKEN0, token1: TOKEN1,
    fee: 500, basisWei: 5n });
  const sequence = await fx.sequences.createSequence({ agentId: "agent", ownerAddress: OWNER,
    positionId: position.positionId, kind: "open" });
  const targetKey = `target-${outcome}`;
  const decisionId = lpStepDecisionId(sequence.sequenceId, 0);
  await fx.sequences.appendStep(OWNER, "agent", sequence.sequenceId,
    { kind: "zap-in-mint", journalIdempotencyKey: targetKey });
  const calls = JSON.stringify({ scheme: "porto-erc7579-calls-v1", executionDataHash: H1 });
  await fx.journal.begin({ idempotencyKey: targetKey, agentId: "agent", ownerAddress: OWNER,
    kind: "lp", decisionId, begunAtBlock: 10n, finalCallsFingerprint: calls,
    finalCallsFingerprintHash: keccak256(stringToHex(calls)) });
  const prepared = canonicalPreparedIntentIdentityV1({ scheme: "porto-intent-v1",
    decoder: "porto-orchestrator-intent-v055", chainId: "56", eoa: OWNER,
    orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
    orchestratorVersion: "0.5.5", nonce: "7", expiry: "100",
    executionDataHash: H1, keyHash: H2 });
  await fx.journal.bindPreparedIntent(targetKey, { canonicalIdentity: prepared.canonical,
    identityHash: prepared.hash, expectedBindingVersion: 0 });
  await fx.journal.markUnknown(targetKey, "submission outcome unknown");
  const actionKey = `action-${outcome}`;
  await fx.journal.begin({ idempotencyKey: actionKey, agentId: "agent", ownerAddress: OWNER,
    kind: "resolveUnknownLandingV1" });
  return { ...fx, decisionId, targetKey, actionKey, sequenceId: sequence.sequenceId,
    positionId: position.positionId };
}

async function run(fx: Awaited<ReturnType<typeof seed>>, actionKey = fx.actionKey,
  provider: LandingEvidenceProvider = fx.provider) {
  const [row, sequence, position] = await Promise.all([
    fx.journal.get(fx.targetKey),
    fx.sequences.getSequence(OWNER, "agent", fx.sequenceId),
    fx.sequences.getPosition(OWNER, "agent", fx.positionId),
  ]);
  assert.ok(row); assert.ok(sequence); assert.ok(position);
  return resolveUnknownLandingV1({ decisionId: fx.decisionId, row, sequence, position,
    actionIdentity: { owner: OWNER, agent: "agent", kind: "resolveUnknownLandingV1",
      idempotencyKey: actionKey }, priorRows: [], deps: {
      journal: fx.journal, sequences: fx.sequences, evidenceStore: fx.evidenceStore,
      evidenceProvider: provider, receipts: {
        async collectAmounts() { return { amount0Wei: 0n, amount1Wei: 0n }; },
        async swapAmounts() { return { tokenIn: TOKEN0, amountInWei: 0n,
          tokenOut: TOKEN1, amountOutWei: 0n }; },
        async mintedTokenId() { return 99n; },
      },
      async positions(tokenId, block, blockHash) {
        assert.equal(tokenId, 99n); assert.equal(block, 11n); assert.equal(blockHash, H2);
        return { liquidity: 1n, tickLower: -10, tickUpper: 10 };
      },
      now: fx.clock, resolverLeaseMs: 1_000,
    } });
}

describe("Phase 3.9c resolver end-to-end — memory parity", () => {
  it("retires a proven-absent open atomically in the prescribed logical order", async () => {
    const fx = await seed("absent");
    const result = await run(fx);
    assert.equal(result.kind, "terminal");
    if (result.kind !== "terminal") return;
    assert.deepEqual({ outcome: result.data.outcome, action: result.data.action,
      state: result.data.journalState, replayed: result.data.replayed },
    { outcome: "absent", action: "retire-not-landed", state: "ROLLED_BACK", replayed: false });
    assert.equal((await fx.journal.get(fx.targetKey))?.state, "ROLLED_BACK");
    assert.equal((await fx.sequences.getPosition(OWNER, "agent", fx.positionId))?.state, "closed");
    assert.equal((await fx.sequences.getSequence(OWNER, "agent", fx.sequenceId))?.state,
      "rolled-back");
  });

  it("resumes a proven landed mint, pins finalized lineage, and never rereads evidence on replay", async () => {
    const fx = await seed("landed");
    const result = await run(fx);
    assert.equal(result.kind, "terminal");
    assert.equal((await fx.journal.get(fx.targetKey))?.externalRef.txHash, H3);
    assert.equal((await fx.sequences.getPosition(OWNER, "agent", fx.positionId))?.tokenId, "99");
    assert.equal((await fx.sequences.getSequence(OWNER, "agent", fx.sequenceId))?.state, "active");
    assert.equal(fx.reads(), 1);

    const terminalizerRepair = await run(fx);
    assert.equal(terminalizerRepair.kind, "terminal");
    if (terminalizerRepair.kind === "terminal") {
      assert.equal(terminalizerRepair.data.replayed, false,
        "terminal-before-action-COMMIT repairs the original terminalizer identity");
      assert.equal(terminalizerRepair.completionRole, "terminalizer");
    }
    assert.equal(fx.reads(), 1, "terminalizer repair has zero provider reads");

    const secondAction = "action-landed-retry";
    await fx.journal.begin({ idempotencyKey: secondAction, agentId: "agent",
      ownerAddress: OWNER, kind: "resolveUnknownLandingV1" });
    const replay = await run(fx, secondAction);
    assert.equal(replay.kind, "terminal");
    if (replay.kind !== "terminal") return;
    assert.equal(replay.data.replayed, true);
    assert.equal(replay.completionRole, "joiner");
    assert.equal(fx.reads(), 1, "terminal replay has zero provider reads");
  });

  it("fences invalidation before every Memory disposition phase", async () => {
    for (const failAt of [1, 2, 3, 4, 5]) {
      const fx = await seed("absent");
      let phase = 0;
      const provider: LandingEvidenceProvider = { ...fx.provider,
        async withCurrentEvidence(_evidence, mutation) {
          phase += 1;
          if (phase === failAt) {
            throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence was invalidated.");
          }
          return mutation();
        } };
      await assert.rejects(run(fx, fx.actionKey, provider), /evidence was invalidated/);
      const [target, sequence, position, action] = await Promise.all([
        fx.journal.get(fx.targetKey),
        fx.sequences.getSequence(OWNER, "agent", fx.sequenceId),
        fx.sequences.getPosition(OWNER, "agent", fx.positionId),
        fx.journal.get(fx.actionKey),
      ]);
      assert.ok(target); assert.ok(sequence); assert.ok(position); assert.ok(action);
      if (failAt <= 2) assert.equal(target.state, "UNKNOWN",
        "journal disposition cannot cross a failed citation fence");
      if (failAt <= 3) assert.equal(sequence.recoveryState, "none",
        "recovery mutation cannot cross a failed citation fence");
      if (failAt <= 4) assert.equal(position.state, "open",
        "position/accounting mutation cannot cross a failed citation fence");
      if (failAt === 5) {
        assert.equal(sequence.state, "resolving", "terminal sequence release stays inside the fence");
        assert.notEqual(action.state, "COMMITTED", "action completion stays inside the fence");
      }
    }
  });

  it("rolls back every Memory terminal write and releases the sequence last", async () => {
    for (const outcome of ["landed", "absent"] as const) {
      for (const stage of ["resolution", "journal", "action", "sequence"] as const) {
        const fx = await seed(outcome);
        let restoreStage: () => void;
        if (stage === "resolution") {
          const original = fx.evidenceStore.terminalize.bind(fx.evidenceStore);
          fx.evidenceStore.terminalize = async (input) => {
            await original(input); throw new Error(`injected ${stage} failure`);
          };
          restoreStage = () => { fx.evidenceStore.terminalize = original; };
        } else if (stage === "journal") {
          const original = fx.journal.finalizeLandingDisposition.bind(fx.journal);
          fx.journal.finalizeLandingDisposition = async (input) => {
            await original(input); throw new Error(`injected ${stage} failure`);
          };
          restoreStage = () => { fx.journal.finalizeLandingDisposition = original; };
        } else if (stage === "action") {
          const original = fx.journal.completeLandingAction.bind(fx.journal);
          fx.journal.completeLandingAction = async (key, input) => {
            await original(key, input); throw new Error(`injected ${stage} failure`);
          };
          restoreStage = () => { fx.journal.completeLandingAction = original; };
        } else {
          const original = fx.sequences.finishSequenceLandingResolution.bind(fx.sequences);
          fx.sequences.finishSequenceLandingResolution = async (owner, agent, sequenceId, input) => {
            await original(owner, agent, sequenceId, input);
            throw new Error(`injected ${stage} failure`);
          };
          restoreStage = () => { fx.sequences.finishSequenceLandingResolution = original; };
        }
        await assert.rejects(run(fx), new RegExp(`injected ${stage} failure`));
        const [sequence, action] = await Promise.all([
          fx.sequences.getSequence(OWNER, "agent", fx.sequenceId),
          fx.journal.get(fx.actionKey),
        ]);
        const resolutionId = action?.externalRef.landingAction?.resolutionId;
        assert.ok(resolutionId);
        const resolution = await fx.evidenceStore.getResolution(resolutionId);
        assert.equal(sequence?.state, "resolving",
          `${outcome}/${stage}: a failed terminal transaction remains worker-excluded`);
        assert.notEqual(action?.state, "COMMITTED",
          `${outcome}/${stage}: action completion rolls back with the terminal transaction`);
        assert.equal(resolution?.phase, "postprocessed",
          `${outcome}/${stage}: the terminal tombstone rolls back for idempotent re-entry`);

        restoreStage();
        fx.advance(1_001);
        const retried = await run(fx);
        assert.equal(retried.kind, "terminal", `${outcome}/${stage}: re-entry finishes exactly once`);
        assert.equal((await fx.sequences.getSequence(OWNER, "agent", fx.sequenceId))?.state,
          outcome === "landed" ? "active" : "rolled-back");
        assert.equal((await fx.journal.get(fx.actionKey))?.state, "COMMITTED");
      }
    }
  });

  it("restores the exact pre-disposition origin on an evidence lookup failure", async () => {
    const fx = await seed("absent");
    const failing: LandingEvidenceProvider = { ...fx.provider,
      async snapshot() { throw new Error("injected local snapshot timeout"); } };
    const result = await run(fx, fx.actionKey, failing);
    assert.equal(result.kind, "terminal");
    if (result.kind !== "terminal") return;
    assert.equal(result.data.outcome, "unavailable");
    assert.equal(result.data.journalState, "UNKNOWN");
    const sequence = await fx.sequences.getSequence(OWNER, "agent", fx.sequenceId);
    assert.equal(sequence?.state, "active");
    assert.equal(sequence?.resolutionId, null);
    assert.equal(sequence?.resolverSnapshotHash, null);
    assert.equal((await fx.journal.get(fx.targetKey))?.state, "UNKNOWN");
  });
});

describe("Phase 3.9c owner route", () => {
  it("is capability-gated, nonce-authenticated, terminal, and exactly replayable", async () => {
    const unwired = await createHarness();
    const hiddenIssuedAt = unwired.nowSec();
    const hiddenEnvelope = await signOwnerAction("resolveUnknownLandingV1",
      { decisionId: "lp:hidden:0", evidenceVersion: "lp-landing-evidence-v1" },
      { agentId: AGENT_ID, issuedAt: hiddenIssuedAt, expiry: hiddenIssuedAt + 120 });
    assert.equal((await call(unwired,
      `/agents/${AGENT_ID}/journal/lp:hidden:0/resolve-landing/v1`,
      { method: "POST", body: hiddenEnvelope })).status, 404);

    const sequences = new MemoryLpSequenceStore();
    const evidenceStore = new MemoryLpEvidenceStore(resolveLpEvidenceConfig({}));
    let providerReads = 0;
    const provider: LandingEvidenceProvider = {
      enabled: true,
      async admission() { return { coverageVersion: H1, quorumId: H2, laneId: H3 }; },
      async snapshot(input) {
        providerReads += 1;
        return { outcome: "absent", evidence: canonicalLandingEvidence({
          scheme: "lp-landing-evidence-v1", outcome: "absent",
          preparedIdentityHash: input.requirement.preparedIdentityHash,
          coverageVersion: H1, quorumId: H2, laneId: H3, generation: "0",
          cursorRowVersion: "1", requiredSourceIds: ["a", "b"], fromBlock: "10",
          toBlock: "11", toBlockHash: H2,
          absent: { toBlockTimestamp: "401", expirySafetySeconds: 300, zeroMatchCount: 0 },
        }) };
      },
      async validateStored() { return true; },
      async withCurrentEvidence(_evidence, mutation) { return mutation(); },
    };
    const lp = { store: sequences, settingsStore: new MemoryLpSettingsStore(),
      observations: new MemoryLpObservationStore(), workerIntervalMs: 60_000,
      railsResult: { ok: false, message: "unused" }, runtime: {
        maxTickWidth: 4_000, maxSlippageBps: 500, maxZapPriceImpactBps: 500,
        minPoolLiquidity: 1n, twapWindowSec: 300, minObservationCardinality: 2,
        maxTwapDeviationBps: 500, maxTickDivergence: 500, maxBuildAttempts: 1,
        maxTransientRetries: 1, resolveMinAgeSec: 1_800,
        resolveDiscriminatingMultipleBps: 12_000, knownStakers: [],
        conversionCompatibleTokens: new Set(),
      }, venue: { nfpm: TOKEN0, routerV3: TOKEN1, wbnb: TOKEN0 },
      readers: { positions: async () => "burned" as const, receipts: {
        async collectAmounts() { return { amount0Wei: 0n, amount1Wei: 0n }; },
        async swapAmounts() { return { tokenIn: TOKEN0, amountInWei: 0n,
          tokenOut: TOKEN1, amountOutWei: 0n }; },
        async mintedTokenId() { return 1n; },
      } }, landingEvidence: { store: evidenceStore, provider, resolverLeaseMs: 30_000 },
    } as unknown as LpServerDeps;
    const harness = await createHarness({ lp, strictLpReaderCapabilities: true });
    const position = await sequences.createPosition({ positionId: "route-position",
      agentId: AGENT_ID, ownerAddress: ownerAccount.address, token0: TOKEN0, token1: TOKEN1,
      fee: 500, basisWei: 5n });
    const sequence = await sequences.createSequence({ agentId: AGENT_ID,
      ownerAddress: ownerAccount.address, positionId: position.positionId, kind: "open" });
    const decisionId = lpStepDecisionId(sequence.sequenceId, 0);
    const targetKey = "route-target";
    await sequences.appendStep(ownerAccount.address, AGENT_ID, sequence.sequenceId,
      { kind: "zap-in-mint", journalIdempotencyKey: targetKey });
    const calls = JSON.stringify({ scheme: "porto-erc7579-calls-v1", executionDataHash: H1 });
    await harness.journal.begin({ idempotencyKey: targetKey, agentId: AGENT_ID,
      ownerAddress: ownerAccount.address, kind: "lp", decisionId, begunAtBlock: 10n,
      finalCallsFingerprint: calls,
      finalCallsFingerprintHash: keccak256(stringToHex(calls)) });
    const prepared = canonicalPreparedIntentIdentityV1({ scheme: "porto-intent-v1",
      decoder: "porto-orchestrator-intent-v055", chainId: "56",
      eoa: ownerAccount.address.toLowerCase() as Address,
      orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
      orchestratorVersion: "0.5.5", nonce: "8", expiry: "100",
      executionDataHash: H1, keyHash: H2 });
    await harness.journal.bindPreparedIntent(targetKey, { canonicalIdentity: prepared.canonical,
      identityHash: prepared.hash, expectedBindingVersion: 0 });
    await harness.journal.markUnknown(targetKey, "unknown");
    const issuedAt = harness.nowSec();
    const envelope = await signOwnerAction("resolveUnknownLandingV1",
      { decisionId, evidenceVersion: "lp-landing-evidence-v1" },
      { agentId: AGENT_ID, issuedAt, expiry: issuedAt + 120 });
    const path = `/agents/${AGENT_ID}/journal/${decisionId}/resolve-landing/v1`;
    const first = await call(harness, path, { method: "POST", body: envelope });
    assert.equal(first.status, 200);
    assert.equal((first.body["data"] as Record<string, unknown>)["outcome"], "absent");
    const replay = await call(harness, path, { method: "POST", body: envelope });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    assert.equal(providerReads, 1);
  });
});

it("atomic rotate landing resolver refuses persisted steps before claims or disposition writes", async () => {
  for (const outcome of ["landed", "absent"] as const) {
    const fx = await seed(outcome);
    const row = (await fx.journal.get(fx.targetKey))!, position = (await fx.sequences.getPosition(OWNER, "agent", fx.positionId))!;
    const original = (await fx.sequences.getSequence(OWNER, "agent", fx.sequenceId))!;
    const sequence = { ...original, kind: "rotate" as const, priorTokenId: "42", steps: original.steps.map(s => ({ ...s, kind: "rotate-atomic" as const })) };
    const result = await resolveUnknownLandingV1({ decisionId: fx.decisionId, row, position, sequence,
      actionIdentity: { owner: OWNER, agent: "agent", kind: "resolveUnknownLandingV1", idempotencyKey: fx.actionKey }, priorRows: [],
      deps: { journal: fx.journal, sequences: fx.sequences, evidenceStore: fx.evidenceStore, evidenceProvider: fx.provider,
        receipts: { async collectAmounts() { assert.fail("no receipt read"); }, async swapAmounts() { assert.fail("no swap read"); }, async mintedTokenId() { assert.fail("no mint read"); } },
        async positions() { assert.fail("no chain read"); }, now: fx.clock, resolverLeaseMs: 1000 } });
    assert.equal(result.kind, "terminal"); if (result.kind === "terminal") { assert.equal(result.data.action, "none"); assert.equal(result.data.outcome, "unavailable"); }
    assert.equal(fx.reads(), 0); assert.deepEqual(await fx.journal.get(fx.targetKey), row);
    assert.deepEqual(await fx.sequences.getSequence(OWNER, "agent", fx.sequenceId), original);
    assert.deepEqual(await fx.sequences.getPosition(OWNER, "agent", fx.positionId), position);
  }
});
