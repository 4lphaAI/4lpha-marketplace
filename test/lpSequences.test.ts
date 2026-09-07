/**
 * Offline tests for the LP sequence/position store (PHASE3-SPEC "Sequence
 * journal"; Revision 2 items 9–13, 16–17, 40; PHASE3-REVIEW R3/R4/R6/R7).
 *
 * Every contract case runs against BOTH the memory store and the Postgres
 * store driven through the fake SQL client, so the two backends are proven to
 * agree — the PHASE2 F3 lesson. The load-bearing assertions:
 *   - ONE non-terminal sequence per position, enforced identically;
 *   - cross-tenant reads return null;
 *   - the exit quota trips rotate/harvest and NEVER protect/manual-exit (R4:
 *     a rate-limited stop-loss is a stop-loss that does not stop);
 *   - the lineage basis survives a rotate and resets on close (R7);
 *   - a step records identity only, with the decision-id format pinned
 *     (Rev2 item 9), and outcomes enter only as caller-supplied input.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_QUOTE_TOKEN,
  deriveLpSequenceProgress,
  isTerminalLpSequence,
  LpActiveSequenceError,
  LpExitQuotaError,
  LpPositionNotFoundError,
  LpSequenceNotFoundError,
  LpTokenIdInUseError,
  lpStepDecisionId,
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  type CreateLpPositionInput,
  type LpRecoveryState,
  type LpSequenceKind,
  type LpSequenceStep,
  type LpSequenceStore,
  type LpStepOutcomeState,
} from "../src/store/lpSequences.js";
import { PostgresLpSettingsStore } from "../src/store/lpSettings.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER_A = getAddress(privateKeyToAccount(`0x${"a1".repeat(32)}`).address);
const OWNER_B = getAddress(privateKeyToAccount(`0x${"b2".repeat(32)}`).address);
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const AGENT = "lp-agent-1";
const START = 1_900_000_000_000;
const MINUTE = 60_000;

function positionInput(
  positionId: string,
  overrides: Partial<CreateLpPositionInput> = {},
): CreateLpPositionInput {
  return {
    positionId,
    agentId: AGENT,
    ownerAddress: OWNER_A,
    token0: WBNB,
    token1: USDT,
    fee: 2500,
    basisWei: parseEther("0.01"),
    ...overrides,
  };
}

type Factory = {
  readonly name: string;
  make(clock: () => number): Promise<LpSequenceStore>;
};

const FACTORIES: readonly Factory[] = [
  {
    name: "memory",
    make: async (clock) => new MemoryLpSequenceStore(clock),
  },
  {
    name: "postgres(fake sql)",
    make: (clock) => PostgresLpSequenceStore.create(new FakeSqlClient(), clock),
  },
];

/** Create a position and one sequence of `kind` on it. */
async function seedSequence(
  store: LpSequenceStore,
  positionId: string,
  kind: LpSequenceKind,
) {
  await store.createPosition(positionInput(positionId));
  return store.createSequence({
    agentId: AGENT,
    ownerAddress: OWNER_A,
    positionId,
    kind,
  });
}

for (const factory of FACTORIES) {
  describe(`LpSequenceStore positions — ${factory.name}`, () => {
    it("creates and reads back a position; lineage fields default per R7", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const created = await store.createPosition(positionInput("p1"));

      assert.equal(created.positionId, "p1");
      assert.equal(created.ownerAddress, OWNER_A.toLowerCase());
      assert.equal(created.token0, WBNB);
      assert.equal(created.token1, USDT);
      assert.equal(created.fee, 2500);
      assert.equal(created.tokenId, null, "no NFT until the mint confirms");
      assert.equal(created.state, "open");
      assert.equal(created.basisSource, "owner-budget");
      assert.equal(typeof created.basisWei, "bigint");
      assert.equal(created.basisWei, parseEther("0.01"));
      assert.notEqual(created.lineageId, "");
      assert.equal(
        created.quoteToken,
        DEFAULT_QUOTE_TOKEN,
        "quoteToken defaults to WBNB",
      );
      assert.equal(DEFAULT_QUOTE_TOKEN, WBNB);

      const fetched = await store.getPosition(OWNER_A, AGENT, "p1");
      assert.deepEqual(fetched, created);
      await store.close();
    });

    it("carries a supplied lineageId forward (item 40's migration seam)", async () => {
      const store = await factory.make(() => START);
      const first = await store.createPosition(positionInput("p1"));
      const migrated = await store.createPosition(
        positionInput("p2", { lineageId: first.lineageId }),
      );
      assert.equal(migrated.lineageId, first.lineageId);
      await store.close();
    });

    it("rotate changes the tokenId on the SAME lineage with the basis untouched; close resets it (R7)", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const created = await store.createPosition(
        positionInput("p1", { tokenId: "111" }),
      );

      now += MINUTE;
      const rotated = await store.updatePositionTokenId(OWNER_A, AGENT, "p1", "222");
      assert.equal(rotated.tokenId, "222");
      assert.equal(rotated.basisWei, created.basisWei, "basis survives a rotate");
      assert.equal(rotated.lineageId, created.lineageId, "same lineage");
      assert.equal(rotated.basisSource, "owner-budget");

      now += MINUTE;
      const closing = await store.setPositionState(OWNER_A, AGENT, "p1", "closing");
      assert.equal(closing.state, "closing");
      assert.equal(closing.basisWei, created.basisWei, "closing does not reset yet");

      now += MINUTE;
      const closed = await store.setPositionState(OWNER_A, AGENT, "p1", "closed");
      assert.equal(closed.state, "closed");
      assert.equal(closed.basisWei, 0n, "closing the lineage resets the basis");
      assert.equal(closed.tokenId, "222", "the token record itself is history, kept");

      await assert.rejects(
        store.updatePositionTokenId(OWNER_A, AGENT, "p1", "333"),
        /closed/,
      );
      await assert.rejects(
        store.setPositionState(OWNER_A, AGENT, "p1", "open"),
        /Illegal LP position transition/,
      );
      await store.close();
    });

    it("cross-tenant position reads return null; mutations throw not-found", async () => {
      const store = await factory.make(() => START);
      await store.createPosition(positionInput("p1"));

      assert.equal(await store.getPosition(OWNER_B, AGENT, "p1"), null);
      assert.equal(await store.getPosition(OWNER_A, "other-agent", "p1"), null);
      assert.deepEqual(await store.listPositions(OWNER_B, AGENT), []);

      await assert.rejects(
        store.updatePositionTokenId(OWNER_B, AGENT, "p1", "222"),
        LpPositionNotFoundError,
      );
      await assert.rejects(
        store.setPositionState(OWNER_B, AGENT, "p1", "closed"),
        LpPositionNotFoundError,
      );
      // The foreign row is untouched.
      const mine = await store.getPosition(OWNER_A, AGENT, "p1");
      assert.equal(mine?.state, "open");
      assert.equal(mine?.tokenId, null);
      await store.close();
    });
  });

  describe(`LpSequenceStore sequences — ${factory.name}`, () => {
    it("enforces ONE non-terminal sequence per position at create", async () => {
      const store = await factory.make(() => START);
      const first = await seedSequence(store, "p1", "rotate");
      assert.equal(first.state, "active");
      assert.equal(first.recoveryState, "none");
      assert.deepEqual(first.steps, []);

      await assert.rejects(
        store.createSequence({
          agentId: AGENT,
          ownerAddress: OWNER_A,
          positionId: "p1",
          kind: "harvest",
        }),
        (error: unknown) => {
          assert.ok(error instanceof LpActiveSequenceError);
          assert.equal(error.code, "LP_ACTIVE_SEQUENCE");
          return true;
        },
      );

      // Completing the first frees the position.
      await store.setSequenceState(OWNER_A, AGENT, first.sequenceId, "completed");
      const second = await store.createSequence({
        agentId: AGENT,
        ownerAddress: OWNER_A,
        positionId: "p1",
        kind: "harvest",
      });
      assert.equal(second.kind, "harvest");
      await store.close();
    });

    it("carries a nullable note, round-trips it, and still allows it on a TERMINAL sequence (PHASE3.1 Rev2 item 15)", async () => {
      const store = await factory.make(() => START);
      const sequence = await seedSequence(store, "p1", "protect");
      assert.equal(sequence.note, null, "a fresh sequence explains nothing");
      assert.equal(
        (await store.getSequence(OWNER_A, AGENT, sequence.sequenceId))?.note,
        null,
      );

      const note = "sweep-token skipped: exitToQuote is off in the owner's settings.";
      const written = await store.setSequenceNote(
        OWNER_A,
        AGENT,
        sequence.sequenceId,
        note,
      );
      assert.equal(written.note, note);
      assert.equal(
        (await store.getSequence(OWNER_A, AGENT, sequence.sequenceId))?.note,
        note,
      );
      // It is only ever an EXPLANATION: nothing about the sequence's identity,
      // state or recovery moves with it.
      assert.equal(written.state, "active");
      assert.equal(written.recoveryState, "none");

      // The driver writes it as the sequence is completing, so a terminal
      // sequence must still accept it — unlike `setRecoveryState`.
      await store.setSequenceState(OWNER_A, AGENT, sequence.sequenceId, "completed");
      const afterTerminal = await store.setSequenceNote(
        OWNER_A,
        AGENT,
        sequence.sequenceId,
        "later",
      );
      assert.equal(afterTerminal.note, "later");
      assert.equal(afterTerminal.state, "completed");

      // Owner-scoped like every other write: a cross-tenant note throws.
      await assert.rejects(
        store.setSequenceNote(OWNER_B, AGENT, sequence.sequenceId, "not yours"),
        LpSequenceNotFoundError,
      );
      // And it clears back to null.
      assert.equal(
        (await store.setSequenceNote(OWNER_A, AGENT, sequence.sequenceId, null)).note,
        null,
      );
      await store.close();
    });

    it("PHASE3.24 C2/C3: persists normalized consent and an idempotent inline residue", async () => {
      const store = await factory.make(() => START);
      await store.createPosition(positionInput("p-false"));
      const legacyShape = await store.createSequence({
        agentId: AGENT,
        ownerAddress: OWNER_A,
        positionId: "p-false",
        kind: "manual-exit",
      });
      assert.equal(legacyShape.inlineConvert, false, "omitted/legacy consent is false");
      assert.equal(legacyShape.inlineResidueBaseWei, null);

      await store.createPosition(positionInput("p-true"));
      const consented = await store.createSequence({
        agentId: AGENT,
        ownerAddress: OWNER_A,
        positionId: "p-true",
        kind: "manual-exit",
        inlineConvert: true,
      });
      assert.equal(consented.inlineConvert, true);
      const first = await store.recordInlineResidue(
        OWNER_A,
        AGENT,
        consented.sequenceId,
        777n,
        "material residue: 777 base-token wei",
      );
      assert.equal(first.inlineResidueBaseWei, 777n);
      const replay = await store.recordInlineResidue(
        OWNER_A,
        AGENT,
        consented.sequenceId,
        777n,
        first.note,
      );
      assert.equal(replay.inlineResidueBaseWei, 777n, "same receipt replay is idempotent");
      await assert.rejects(
        store.recordInlineResidue(
          OWNER_A,
          AGENT,
          consented.sequenceId,
          778n,
          first.note,
        ),
        /disagrees/u,
      );
      await store.close();
    });

    it("a held sequence with a pending recovery still blocks new sequences; held with none does not", async () => {
      const store = await factory.make(() => START);
      const first = await seedSequence(store, "p1", "rotate");

      // held + pending-mint is NON-TERMINAL: the next cycle owes it a resume,
      // and a second saga on the same position would double-drive the funds.
      await store.setRecoveryState(OWNER_A, AGENT, first.sequenceId, "pending-mint");
      await store.setSequenceState(OWNER_A, AGENT, first.sequenceId, "held");
      await assert.rejects(
        store.createSequence({
          agentId: AGENT,
          ownerAddress: OWNER_A,
          positionId: "p1",
          kind: "protect",
        }),
        LpActiveSequenceError,
      );
      assert.equal(
        (await store.getNonTerminalSequence(OWNER_A, AGENT, "p1"))?.sequenceId,
        first.sequenceId,
      );

      // Recovery cleared: held + none is operator-parked, terminal.
      await store.setRecoveryState(OWNER_A, AGENT, first.sequenceId, "none");
      assert.equal(await store.getNonTerminalSequence(OWNER_A, AGENT, "p1"), null);
      const second = await store.createSequence({
        agentId: AGENT,
        ownerAddress: OWNER_A,
        positionId: "p1",
        kind: "protect",
      });
      assert.equal(second.kind, "protect");
      await store.close();
    });

    it("refuses a sequence on an unknown or foreign position", async () => {
      const store = await factory.make(() => START);
      await store.createPosition(positionInput("p1"));
      await assert.rejects(
        store.createSequence({
          agentId: AGENT,
          ownerAddress: OWNER_B,
          positionId: "p1",
          kind: "rotate",
        }),
        LpPositionNotFoundError,
      );
      await store.close();
    });

    it("cross-tenant sequence reads return null; mutations throw not-found", async () => {
      const store = await factory.make(() => START);
      const sequence = await seedSequence(store, "p1", "rotate");

      assert.equal(await store.getSequence(OWNER_B, AGENT, sequence.sequenceId), null);
      assert.equal(
        await store.getSequence(OWNER_A, "other-agent", sequence.sequenceId),
        null,
      );
      assert.equal(await store.getNonTerminalSequence(OWNER_B, AGENT, "p1"), null);
      assert.deepEqual(await store.listSequences(OWNER_B, AGENT), []);
      await assert.rejects(
        store.setSequenceState(OWNER_B, AGENT, sequence.sequenceId, "completed"),
        LpSequenceNotFoundError,
      );
      await assert.rejects(
        store.appendStep(OWNER_B, AGENT, sequence.sequenceId, {
          kind: "zap-out",
          journalIdempotencyKey: "k0",
        }),
        LpSequenceNotFoundError,
      );
      await store.close();
    });

    it("guards sequence state transitions; held → active is the resume path", async () => {
      const store = await factory.make(() => START);
      const sequence = await seedSequence(store, "p1", "rotate");

      await store.setRecoveryState(OWNER_A, AGENT, sequence.sequenceId, "pending-mint");
      await store.setSequenceState(OWNER_A, AGENT, sequence.sequenceId, "held");
      const resumed = await store.setSequenceState(
        OWNER_A,
        AGENT,
        sequence.sequenceId,
        "active",
      );
      assert.equal(resumed.state, "active");
      assert.equal(resumed.recoveryState, "pending-mint", "recovery survives resume");

      await store.setSequenceState(OWNER_A, AGENT, sequence.sequenceId, "completed");
      await assert.rejects(
        store.setSequenceState(OWNER_A, AGENT, sequence.sequenceId, "active"),
        /Illegal LP sequence transition/,
      );
      await assert.rejects(
        store.setRecoveryState(OWNER_A, AGENT, sequence.sequenceId, "wbnb-stranded"),
        /terminal/,
      );
      await store.close();
    });

    it("records steps as identity only, with the decision-id format pinned (Rev2 item 9)", async () => {
      const store = await factory.make(() => START);
      const sequence = await seedSequence(store, "p1", "rotate");

      const step0 = await store.appendStep(OWNER_A, AGENT, sequence.sequenceId, {
        kind: "zap-out",
        journalIdempotencyKey: "idem-0",
      });
      const step1 = await store.appendStep(OWNER_A, AGENT, sequence.sequenceId, {
        kind: "sweep-token",
        journalIdempotencyKey: "idem-1",
      });
      // The reserved CAKE-phase vocabulary needs no migration: no enum CHECK
      // on step kind, by design.
      const step2 = await store.appendStep(OWNER_A, AGENT, sequence.sequenceId, {
        kind: "stake",
        journalIdempotencyKey: "idem-2",
      });

      // Byte-exact step shape: identity ONLY, never an outcome field. The
      // deepEqual pins the whole object, so an added `status`/`outcome`
      // column shows up as a failure here.
      assert.deepEqual(step0, {
        index: 0,
        kind: "zap-out",
        journalIdempotencyKey: "idem-0",
        journalDecisionId: `lp:${sequence.sequenceId}:0`,
      } satisfies LpSequenceStep);
      assert.equal(step1.journalDecisionId, `lp:${sequence.sequenceId}:1`);
      assert.equal(step2.index, 2);
      assert.equal(
        lpStepDecisionId(sequence.sequenceId, 1),
        `lp:${sequence.sequenceId}:1`,
      );

      const fetched = await store.getSequence(OWNER_A, AGENT, sequence.sequenceId);
      assert.deepEqual(fetched?.steps, [step0, step1, step2]);

      // Steps may only be recorded on an active sequence.
      await store.setRecoveryState(OWNER_A, AGENT, sequence.sequenceId, "pending-mint");
      await store.setSequenceState(OWNER_A, AGENT, sequence.sequenceId, "held");
      await assert.rejects(
        store.appendStep(OWNER_A, AGENT, sequence.sequenceId, {
          kind: "zap-in-mint",
          journalIdempotencyKey: "idem-3",
        }),
        /active/,
      );
      await store.close();
    });

    it("round-trips every recovery state", async () => {
      const store = await factory.make(() => START);
      const sequence = await seedSequence(store, "p1", "harvest");
      const states: readonly LpRecoveryState[] = [
        "pending-mint",
        "pending-increase",
        "wbnb-stranded",
        "none",
      ];
      for (const state of states) {
        const updated = await store.setRecoveryState(
          OWNER_A,
          AGENT,
          sequence.sequenceId,
          state,
        );
        assert.equal(updated.recoveryState, state);
        const read = await store.getSequence(OWNER_A, AGENT, sequence.sequenceId);
        assert.equal(read?.recoveryState, state);
      }
      await store.close();
    });
  });

  describe(`LpSequenceStore reservations — ${factory.name}`, () => {
    const NO_SPACING = { maxExitSequencesPerDay: 2, minMinutesBetweenExits: 0 };

    it("trips rotate/harvest at the daily limit and NEVER protect/manual-exit (Rev2 item 13)", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const rotate = await seedSequence(store, "p1", "rotate");
      const harvest = await seedSequence(store, "p2", "harvest");
      const rotate2 = await seedSequence(store, "p3", "rotate");
      const protect = await seedSequence(store, "p4", "protect");
      const manualExit = await seedSequence(store, "p5", "manual-exit");
      const open = await seedSequence(store, "p6", "open");

      const r1 = await store.reserveSequence(OWNER_A, AGENT, rotate.sequenceId, NO_SPACING);
      assert.equal(r1.quotaBound, true);
      // Harvest SHARES the exit quota (the 0G behaviour; Rev2 item 11).
      const r2 = await store.reserveSequence(OWNER_A, AGENT, harvest.sequenceId, NO_SPACING);
      assert.equal(r2.quotaBound, true);

      // The window now holds 2 reservations = maxExitSequencesPerDay.
      await assert.rejects(
        store.reserveSequence(OWNER_A, AGENT, rotate2.sequenceId, NO_SPACING),
        (error: unknown) => {
          assert.ok(error instanceof LpExitQuotaError);
          assert.equal(error.reason, "quota-exhausted");
          return true;
        },
      );
      // The refused reservation left no row behind (compensated on both backends).
      assert.equal(
        await store.getReservation(OWNER_A, AGENT, rotate2.sequenceId),
        null,
      );

      // Protect and manual exit NEVER throw on quota — a rate-limited
      // stop-loss is a stop-loss that does not stop (R4). They still write
      // accounting rows.
      const p = await store.reserveSequence(OWNER_A, AGENT, protect.sequenceId, NO_SPACING);
      assert.equal(p.quotaBound, false);
      const m = await store.reserveSequence(OWNER_A, AGENT, manualExit.sequenceId, NO_SPACING);
      assert.equal(m.quotaBound, false);
      const o = await store.reserveSequence(OWNER_A, AGENT, open.sequenceId, NO_SPACING);
      assert.equal(o.quotaBound, false);
      assert.notEqual(
        await store.getReservation(OWNER_A, AGENT, protect.sequenceId),
        null,
        "protect writes its accounting row",
      );

      // Idempotent re-reservation returns the original row, never re-checks.
      const again = await store.reserveSequence(OWNER_A, AGENT, rotate.sequenceId, NO_SPACING);
      assert.deepEqual(again, r1);
      await store.close();
    });

    it("expires reservations out of the rolling 24h window", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const rotate = await seedSequence(store, "p1", "rotate");
      const harvest = await seedSequence(store, "p2", "harvest");
      const rotate2 = await seedSequence(store, "p3", "rotate");

      const quota = { maxExitSequencesPerDay: 1, minMinutesBetweenExits: 0 };
      await store.reserveSequence(OWNER_A, AGENT, rotate.sequenceId, quota);
      await assert.rejects(
        store.reserveSequence(OWNER_A, AGENT, harvest.sequenceId, quota),
        LpExitQuotaError,
      );

      now += 24 * 60 * MINUTE + 1;
      const later = await store.reserveSequence(OWNER_A, AGENT, rotate2.sequenceId, quota);
      assert.equal(later.quotaBound, true);
      await store.close();
    });

    it("minMinutesBetweenExits blocks a rotate and not a protect", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const rotate = await seedSequence(store, "p1", "rotate");
      const rotate2 = await seedSequence(store, "p2", "rotate");
      const protect = await seedSequence(store, "p3", "protect");

      const quota = { maxExitSequencesPerDay: 10, minMinutesBetweenExits: 30 };
      await store.reserveSequence(OWNER_A, AGENT, rotate.sequenceId, quota);

      now += 10 * MINUTE;
      await assert.rejects(
        store.reserveSequence(OWNER_A, AGENT, rotate2.sequenceId, quota),
        (error: unknown) => {
          assert.ok(error instanceof LpExitQuotaError);
          assert.equal(error.reason, "min-interval");
          return true;
        },
      );
      // A protect inside the spacing window goes through.
      const p = await store.reserveSequence(OWNER_A, AGENT, protect.sequenceId, quota);
      assert.equal(p.quotaBound, false);

      // Once the spacing has elapsed since the LATEST reservation (the
      // protect's accounting row counts — every reservation draws relay gas
      // from the same on-chain meter), the rotate goes through.
      now += 31 * MINUTE;
      const r2 = await store.reserveSequence(OWNER_A, AGENT, rotate2.sequenceId, quota);
      assert.equal(r2.quotaBound, true);
      await store.close();
    });

    it("scopes reservations: cross-tenant getReservation returns null", async () => {
      const store = await factory.make(() => START);
      const rotate = await seedSequence(store, "p1", "rotate");
      await store.reserveSequence(OWNER_A, AGENT, rotate.sequenceId, NO_SPACING);

      assert.equal(await store.getReservation(OWNER_B, AGENT, rotate.sequenceId), null);
      assert.equal(
        await store.getReservation(OWNER_A, "other-agent", rotate.sequenceId),
        null,
      );
      await assert.rejects(
        store.reserveSequence(OWNER_B, AGENT, rotate.sequenceId, NO_SPACING),
        LpSequenceNotFoundError,
      );
      await store.close();
    });
  });

  describe(`LpSequenceStore landing resolver fence — ${factory.name}`, () => {
    const SNAPSHOT = `0x${"44".repeat(32)}` as Hex;

    it("claims an exact ACTIVE snapshot, excludes generic workers, and restores before disposition", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const sequence = await seedSequence(store, "resolve-active", "rotate");
      const position = await store.getPosition(OWNER_A, AGENT, sequence.positionId);
      assert.ok(position);
      const claimed = await store.claimSequenceForLandingResolution(OWNER_A, AGENT,
        sequence.sequenceId, { expectedState: "active", expectedRecoveryState: "none",
          expectedUpdatedAt: sequence.updatedAt, expectedPositionId: sequence.positionId,
          expectedPositionVersion: position.rowVersion,
          expectedResolverRowVersion: sequence.resolverRowVersion,
          resolutionId: "lp-landing:active", actionIdempotencyKey: "owner-action-a",
          snapshotHash: SNAPSHOT, leaseUntilMs: now + MINUTE });
      assert.equal(claimed?.state, "resolving");
      assert.equal(claimed?.resolverPriorState, "active");
      assert.equal(claimed?.resolverPriorRecoveryState, "none");
      assert.equal((await store.listNonTerminalSequencesForWorker())
        .some((row) => row.sequenceId === sequence.sequenceId), false);
      await assert.rejects(store.setSequenceState(OWNER_A, AGENT, sequence.sequenceId, "held"));
      assert.equal(await store.claimSequenceForLandingResolution(OWNER_A, AGENT,
        sequence.sequenceId, { expectedState: "active", expectedRecoveryState: "none",
          expectedUpdatedAt: sequence.updatedAt, expectedPositionId: sequence.positionId,
          expectedPositionVersion: position.rowVersion,
          expectedResolverRowVersion: sequence.resolverRowVersion,
          resolutionId: "lp-landing:other", actionIdempotencyKey: "owner-action-b",
          snapshotHash: SNAPSHOT, leaseUntilMs: now + MINUTE }), null,
      "the stale pre-claim snapshot must lose its CAS");
      assert.ok(claimed);
      const restored = await store.releaseSequenceLandingResolution(OWNER_A, AGENT,
        sequence.sequenceId, "lp-landing:active", claimed.resolverFence,
        claimed.resolverRowVersion);
      assert.equal(restored?.state, "active");
      assert.equal(restored?.recoveryState, "none");
      assert.equal(restored?.resolutionId, null);
      await store.close();
    });

    it("reclaims an expired HELD lease, fences the old owner, and terminalizes only after disposition", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const created = await seedSequence(store, "resolve-held", "harvest");
      await store.setRecoveryState(OWNER_A, AGENT, created.sequenceId, "pending-increase");
      const held = await store.setSequenceState(OWNER_A, AGENT, created.sequenceId, "held");
      const position = await store.getPosition(OWNER_A, AGENT, held.positionId);
      assert.ok(position);
      const claimed = await store.claimSequenceForLandingResolution(OWNER_A, AGENT,
        held.sequenceId, { expectedState: "held", expectedRecoveryState: "pending-increase",
          expectedUpdatedAt: held.updatedAt, expectedPositionId: held.positionId,
          expectedPositionVersion: position.rowVersion,
          expectedResolverRowVersion: held.resolverRowVersion,
          resolutionId: "lp-landing:held", actionIdempotencyKey: "owner-action-a",
          snapshotHash: SNAPSHOT, leaseUntilMs: START + MINUTE });
      assert.ok(claimed);
      assert.equal(await store.reclaimSequenceLandingResolution(OWNER_A, AGENT,
        held.sequenceId, { resolutionId: "lp-landing:held",
          expectedFence: claimed.resolverFence,
          expectedResolverRowVersion: claimed.resolverRowVersion,
          actionIdempotencyKey: "owner-action-b", snapshotHash: SNAPSHOT,
          nowMs: START + MINUTE - 1, leaseUntilMs: START + 2 * MINUTE }), null);
      now = START + MINUTE;
      const reclaimed = await store.reclaimSequenceLandingResolution(OWNER_A, AGENT,
        held.sequenceId, { resolutionId: "lp-landing:held",
          expectedFence: claimed.resolverFence,
          expectedResolverRowVersion: claimed.resolverRowVersion,
          actionIdempotencyKey: "owner-action-b", snapshotHash: SNAPSHOT,
          nowMs: now, leaseUntilMs: now + MINUTE });
      assert.equal(reclaimed?.resolverFence, claimed.resolverFence + 1n);
      assert.ok(reclaimed);
      assert.equal(await store.beginSequenceLandingDisposition(OWNER_A, AGENT, held.sequenceId,
        "lp-landing:held", claimed.resolverFence, claimed.resolverRowVersion), null,
      "a reclaimed fence must make every old-owner mutation lose");
      const begun = await store.beginSequenceLandingDisposition(OWNER_A, AGENT,
        held.sequenceId, "lp-landing:held", reclaimed.resolverFence,
        reclaimed.resolverRowVersion);
      assert.equal(begun?.resolutionDispositionStarted, true);
      assert.ok(begun);
      assert.equal(await store.releaseSequenceLandingResolution(OWNER_A, AGENT,
        held.sequenceId, "lp-landing:held", begun.resolverFence,
        begun.resolverRowVersion), null, "disposition is an irreversible no-restore boundary");
      const recovery = await store.setSequenceLandingRecovery(OWNER_A, AGENT,
        held.sequenceId, { resolutionId: "lp-landing:held", fence: begun.resolverFence,
          expectedResolverRowVersion: begun.resolverRowVersion, recoveryState: "none",
          note: "not-landed:harvest-collect;position-open" });
      assert.ok(recovery);
      const terminal = await store.finishSequenceLandingResolution(OWNER_A, AGENT,
        held.sequenceId, { resolutionId: "lp-landing:held", fence: recovery.resolverFence,
          expectedResolverRowVersion: recovery.resolverRowVersion,
          targetState: "rolled-back" });
      assert.equal(terminal?.state, "rolled-back");
      assert.equal(terminal?.resolverPriorState, null);
      assert.equal(terminal?.resolutionId, null);
      await store.close();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

describe("isTerminalLpSequence truth table", () => {
  const RECOVERIES: readonly LpRecoveryState[] = [
    "pending-mint",
    "pending-increase",
    "wbnb-stranded",
    "none",
  ];

  it("completed and rolled-back are terminal regardless of recovery", () => {
    for (const state of ["completed", "rolled-back"] as const) {
      for (const recovery of RECOVERIES) {
        assert.equal(isTerminalLpSequence(state, recovery), true, `${state}/${recovery}`);
      }
    }
  });

  it("active is never terminal", () => {
    for (const recovery of RECOVERIES) {
      assert.equal(isTerminalLpSequence("active", recovery), false, recovery);
    }
  });

  it("abandoning is never terminal", () => {
    for (const recovery of RECOVERIES) {
      assert.equal(isTerminalLpSequence("abandoning", recovery), false, recovery);
    }
  });

  it("held is terminal ONLY with no recovery owed", () => {
    assert.equal(isTerminalLpSequence("held", "none"), true);
    assert.equal(isTerminalLpSequence("held", "pending-mint"), false);
    assert.equal(isTerminalLpSequence("held", "pending-increase"), false);
    assert.equal(isTerminalLpSequence("held", "wbnb-stranded"), false);
  });
});

describe("deriveLpSequenceProgress: joining caller-supplied journal outcomes", () => {
  const SEQ = "seq-1";
  const steps: LpSequenceStep[] = [
    { index: 0, kind: "zap-out", journalIdempotencyKey: "k0", journalDecisionId: lpStepDecisionId(SEQ, 0) },
    { index: 1, kind: "sweep-token", journalIdempotencyKey: "k1", journalDecisionId: lpStepDecisionId(SEQ, 1) },
    { index: 2, kind: "zap-in-mint", journalIdempotencyKey: "k2", journalDecisionId: lpStepDecisionId(SEQ, 2) },
  ];

  function outcomes(
    entries: readonly (readonly [string, LpStepOutcomeState])[],
  ): ReadonlyMap<string, LpStepOutcomeState> {
    return new Map(entries);
  }

  it("advances past confirmed steps: all COMMITTED ⇒ record the next step", () => {
    const progress = deriveLpSequenceProgress(
      { steps },
      outcomes([["k0", "COMMITTED"], ["k1", "COMMITTED"], ["k2", "COMMITTED"]]),
    );
    assert.equal(progress.disposition, "advance");
    assert.equal(progress.stepIndex, 3);
    assert.equal(progress.confirmedSteps, 3);
  });

  it("an empty sequence advances at index 0", () => {
    const progress = deriveLpSequenceProgress({ steps: [] }, outcomes([]));
    assert.equal(progress.disposition, "advance");
    assert.equal(progress.stepIndex, 0);
  });

  it("holds on an UNKNOWN step — ambiguity never auto-replays", () => {
    const progress = deriveLpSequenceProgress(
      { steps },
      outcomes([["k0", "COMMITTED"], ["k1", "UNKNOWN"], ["k2", "COMMITTED"]]),
    );
    assert.equal(progress.disposition, "hold");
    assert.equal(progress.stepIndex, 1);
    assert.equal(progress.confirmedSteps, 1);
    assert.match(progress.reason, /UNKNOWN/);
  });

  it("holds on a step still PENDING or IN_PROGRESS", () => {
    for (const state of ["PENDING", "IN_PROGRESS"] as const) {
      const progress = deriveLpSequenceProgress(
        { steps },
        outcomes([["k0", "COMMITTED"], ["k1", state]]),
      );
      assert.equal(progress.disposition, "hold");
      assert.equal(progress.stepIndex, 1);
    }
  });

  it("holds on a MISSING journal row — the submit window is ambiguous", () => {
    const progress = deriveLpSequenceProgress(
      { steps },
      outcomes([["k0", "COMMITTED"]]),
    );
    assert.equal(progress.disposition, "hold");
    assert.equal(progress.stepIndex, 1);
    assert.match(progress.reason, /no journal outcome/);
  });

  it("reports a ROLLED_BACK step distinctly — the step provably did not land", () => {
    const progress = deriveLpSequenceProgress(
      { steps },
      outcomes([["k0", "COMMITTED"], ["k1", "ROLLED_BACK"], ["k2", "COMMITTED"]]),
    );
    assert.equal(progress.disposition, "roll-back");
    assert.equal(progress.stepIndex, 1);
    assert.equal(progress.confirmedSteps, 1);
  });

  it("the FIRST non-confirmed step decides: an UNKNOWN before a rolled-back step holds", () => {
    const progress = deriveLpSequenceProgress(
      { steps },
      outcomes([["k0", "UNKNOWN"], ["k1", "ROLLED_BACK"]]),
    );
    assert.equal(progress.disposition, "hold");
    assert.equal(progress.stepIndex, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-backend agreement                                                    */
/* -------------------------------------------------------------------------- */

describe("both backends answer identically (PHASE2 F3 regression shape)", () => {
  it("one-active enforcement, quota refusal and progress inputs agree across backends", async () => {
    let now = START;
    const clock = () => now;
    const stores: LpSequenceStore[] = [
      new MemoryLpSequenceStore(clock),
      await PostgresLpSequenceStore.create(new FakeSqlClient(), clock),
    ];
    const quota = { maxExitSequencesPerDay: 1, minMinutesBetweenExits: 0 };

    const results: string[] = [];
    for (const store of stores) {
      const sequence = await seedSequence(store, "p1", "rotate");
      const other = await seedSequence(store, "p2", "harvest");
      let outcome = "";
      try {
        await store.createSequence({
          agentId: AGENT,
          ownerAddress: OWNER_A,
          positionId: "p1",
          kind: "protect",
        });
        outcome += "second-create-allowed;";
      } catch (error) {
        outcome += `${error instanceof LpActiveSequenceError ? "active-refused" : "other"};`;
      }
      await store.reserveSequence(OWNER_A, AGENT, sequence.sequenceId, quota);
      try {
        await store.reserveSequence(OWNER_A, AGENT, other.sequenceId, quota);
        outcome += "quota-allowed";
      } catch (error) {
        outcome += error instanceof LpExitQuotaError ? error.reason : "other";
      }
      results.push(outcome);
      await store.close();
    }
    assert.equal(results[0], results[1]);
    assert.equal(results[0], "active-refused;quota-exhausted");
  });
});

it("AUDIT A7: a legacy PostgreSQL inline_convert NULL decodes as false", async () => {
  const sql = new FakeSqlClient();
  const store = await PostgresLpSequenceStore.create(sql, () => START);
  await store.createPosition(positionInput("p-legacy-null"));
  const created = await store.createSequence({
    agentId: AGENT,
    ownerAddress: OWNER_A,
    positionId: "p-legacy-null",
    kind: "manual-exit",
    inlineConvert: true,
  });
  sql.setLpSequenceInlineConvertForTest(created.sequenceId, null);

  const decoded = await store.getSequence(OWNER_A, AGENT, created.sequenceId);
  assert.equal(decoded?.inlineConvert, false);
  await store.close();
});

/* -------------------------------------------------------------------------- */
/* SQL-literal pins (audit A9)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Records every statement before delegating to the fake (the journal test's
 * pattern, `test/journal.lp.test.ts`). The fake dispatches on the leading
 * `/* tag *\/` comment only, so a WHERE-clause drift under an unchanged tag
 * passes every cross-backend test while diverging from real Postgres — these
 * pins assert on the REAL SQL text instead (audit A9; the F3 discipline).
 */
class RecordingSqlClient implements SqlClient {
  readonly texts: string[] = [];
  readonly records: Array<{ readonly text: string; readonly params: readonly unknown[] }> = [];
  readonly #inner = new FakeSqlClient();

  async query<R = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<R>> {
    this.texts.push(text);
    this.records.push({ text, params });
    return this.#inner.query<R>(text, params);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    // The fake's `transaction` passes ITSELF to the callback, which would
    // route inner queries around this recorder — re-bind to the recorder.
    return this.#inner.transaction(async () => fn(this));
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

describe("Postgres SQL literals: the non-terminal predicate is pinned (audit A9)", () => {
  // ONE definition of "non-terminal", restated in SQL. Every statement that
  // carries it must carry it CHARACTER-IDENTICALLY — the partial unique
  // index, the insert's ON CONFLICT target, and both non-terminal reads.
  const PREDICATE =
    "state in ('active','abandoning','resolving','retiring-pre-bind') or (state = 'held' and recovery_state <> 'none')";

  async function recordedStore(): Promise<{
    sql: RecordingSqlClient;
    store: PostgresLpSequenceStore;
  }> {
    const sql = new RecordingSqlClient();
    const store = await PostgresLpSequenceStore.create(sql, () => START);
    return { sql, store };
  }

  function statement(sql: RecordingSqlClient, tag: string): string {
    const found = sql.texts.find((text) => text.includes(tag));
    assert.notEqual(found, undefined, `no recorded statement carries ${tag}`);
    return found ?? "";
  }

  it("the partial unique index DDL carries the predicate", async () => {
    const { sql, store } = await recordedStore();
    const ddl =
      sql.texts.find((text) =>
        text.includes("create unique index if not exists lp_sequences_one_nonterminal_v4_idx"),
      ) ?? "";
    assert.ok(ddl.includes(`where ${PREDICATE}`), "index predicate drifted");
    await store.close();
  });

  it("serializes the legacy state-constraint migration before inspecting it", async () => {
    const { sql, store } = await recordedStore();
    for (const column of [
      "abandon_claim_id text",
      "abandon_claimed_at bigint",
      "abandon_disposition_started_at bigint",
    ]) {
      assert.ok(
        sql.texts.some((text) =>
          text.includes(`alter table lp_sequences add column if not exists ${column}`),
        ),
        `missing additive migration for ${column}`,
      );
    }
    const migration = sql.texts.find(
      (text) =>
        text.includes("lp_sequences_state_check") &&
        text.includes("pg_get_constraintdef"),
    );
    assert.notEqual(migration, undefined);
    assert.match(
      migration ?? "",
      /begin\s+--[\s\S]*lock table lp_sequences in access exclusive mode;\s+if exists/s,
    );
    assert.match(migration ?? "", /conrelid = 'lp_sequences'::regclass/);
    await store.close();
  });

  it("lpSequences.create names the predicate in its ON CONFLICT target", async () => {
    const { sql, store } = await recordedStore();
    await store.createPosition(positionInput("p1"));
    await store.createSequence({
      agentId: AGENT,
      ownerAddress: OWNER_A,
      positionId: "p1",
      kind: "rotate",
    });
    const create = statement(sql, "lpSequences.create");
    assert.ok(
      create.includes(`on conflict (position_id) where ${PREDICATE} do nothing`),
      "the insert's conflict target must be the index predicate, verbatim",
    );
    await store.close();
  });

  it("nonTerminalByPosition filters by the predicate", async () => {
    const { sql, store } = await recordedStore();
    await store.getNonTerminalSequence(OWNER_A, AGENT, "p1");
    const text = statement(sql, "lpSequences.nonTerminalByPosition");
    assert.ok(text.includes(`and (${PREDICATE})`), "read predicate drifted");
    await store.close();
  });

  it("listNonTerminalWorker filters by the predicate", async () => {
    const { sql, store } = await recordedStore();
    await store.listNonTerminalSequencesForWorker();
    const text = statement(sql, "lpSequences.listNonTerminalWorker");
    assert.ok(
      text.includes("where state = 'active' or (state = 'held' and recovery_state <> 'none')"),
      "the worker must exclude abandoning and resolving owner leases",
    );
    await store.close();
  });

  it("the abandon claim is one SQL CAS with separate timestamp and bigint cutoffs", async () => {
    const { sql, store } = await recordedStore();
    await store.createPosition(positionInput("p-cas"));
    const created = await store.createSequence({
      agentId: AGENT,
      ownerAddress: OWNER_A,
      positionId: "p-cas",
      kind: "manual-exit",
    });
    const held = await store.setSequenceState(OWNER_A, AGENT, created.sequenceId, "held");
    await store.claimSequenceForAbandon(OWNER_A, AGENT, held.sequenceId, {
      expectedUpdatedAt: held.updatedAt,
      claimId: "route-process-a",
      nowMs: START + MINUTE,
      minIdleMs: MINUTE,
    });

    const record = sql.records.find(({ text }) => text.includes("lpSequences.claimAbandon"));
    assert.notEqual(record, undefined);
    const text = record?.text ?? "";
    assert.match(text, /set state = 'abandoning'/);
    assert.match(text, /and updated_at = \$4/);
    assert.match(text, /state = 'held'.*updated_at <= \$8/s);
    assert.match(text, /state = 'abandoning'.*abandon_claimed_at <= \$9/s);
    assert.ok(record?.params[7] instanceof Date, "held cutoff must be timestamptz");
    assert.equal(typeof record?.params[8], "number", "claim cutoff must be bigint");
    await store.close();
  });

  it("disposition CAS predicates make release-before-start and completion-after-start exclusive", async () => {
    const { sql, store } = await recordedStore();
    await store.beginSequenceAbandonDisposition(OWNER_A, AGENT, "seq", "claim");
    await store.releaseSequenceAbandonClaim(OWNER_A, AGENT, "seq", "claim");
    await store.completeSequenceAbandon(OWNER_A, AGENT, "seq", "claim");

    const begin = statement(sql, "lpSequences.beginAbandonDisposition");
    const release = statement(sql, "lpSequences.releaseAbandon");
    const complete = statement(sql, "lpSequences.completeAbandon");
    for (const text of [begin, release, complete]) {
      assert.match(text, /state = 'abandoning' and abandon_claim_id = \$4/);
    }
    assert.match(begin, /set abandon_disposition_started_at = coalesce/);
    assert.match(release, /abandon_disposition_started_at is null/);
    assert.match(complete, /abandon_disposition_started_at is not null/);
    await store.close();
  });
});

describe("Postgres SQL literals: the note column's migration is pinned (PHASE3.1 Rev2 item 15)", () => {
  it("issues `alter table lp_sequences add column if not exists note text` at create", async () => {
    // LOAD-BEARING: a bare `create table if not exists` does NOTHING to a table
    // that already exists, so without this statement every deployment that
    // already ran Phase 3 would keep a `lp_sequences` with no `note` column and
    // the very first select would fail. Idempotent and additive, so it is safe
    // to run on every boot.
    const sql = new RecordingSqlClient();
    const store = await PostgresLpSequenceStore.create(sql, () => START);
    // PHASE3.4 added two more additive columns, on `lp_positions`, so this can
    // no longer take the FIRST `add column if not exists` and assume it is the
    // note. Matching on the table makes the pin say what it always meant.
    const migration = sql.texts.find((text) =>
      text.replace(/\s+/gu, " ").includes("alter table lp_sequences add column if not exists"),
    );
    assert.notEqual(migration, undefined, "the note migration must run at create");
    assert.ok(
      (migration ?? "")
        .replace(/\s+/gu, " ")
        .trim()
        .includes("alter table lp_sequences add column if not exists note text"),
      "the note migration statement drifted",
    );
    await store.close();
  });

  it("issues both `lp_positions` ownership columns and the live-token index at create (PHASE3.4 M5/M6)", async () => {
    // Same load-bearing reason as the note column, twice over: an existing
    // Phase 3 deployment has an `lp_positions` with neither ownership column,
    // and `POSITION_COLUMNS` names them — so the FIRST select would fail.
    //
    // The INDEX is pinned here rather than left to integration because it is
    // the only thing that makes "one non-closed row per NFT" true. A build that
    // silently stopped issuing it would keep every test green (the memory twin
    // still enforces it) while production admitted two rows for one position.
    const sql = new RecordingSqlClient();
    const store = await PostgresLpSequenceStore.create(sql, () => START);
    const flat = sql.texts.map((text) => text.replace(/\s+/gu, " ").trim());
    for (const column of ["ownership_mismatch_count int", "ownership_lost_reason text"]) {
      assert.ok(
        flat.some((text) =>
          text.includes(`alter table lp_positions add column if not exists ${column}`),
        ),
        `the ${column} migration must run at create`,
      );
    }
    const index = flat.find((text) => text.includes("lp_positions_one_live_token_idx"));
    assert.notEqual(index, undefined, "the live-token index must be created");
    assert.ok(
      (index ?? "").includes("create unique index if not exists"),
      "the live-token index must be UNIQUE and idempotent",
    );
    assert.ok(
      (index ?? "").includes("where token_id is not null and state <> 'closed'"),
      "the live-token index predicate drifted — `closed` rows MUST be excluded, or a re-import after a product close is impossible",
    );
    await store.close();
  });

  it("selects and updates the note column by name — no `select *` anywhere", async () => {
    const sql = new RecordingSqlClient();
    const store = await PostgresLpSequenceStore.create(sql, () => START);
    await store.createPosition(positionInput("p1"));
    const sequence = await store.createSequence({
      agentId: AGENT,
      ownerAddress: OWNER_A,
      positionId: "p1",
      kind: "protect",
    });
    await store.setSequenceNote(OWNER_A, AGENT, sequence.sequenceId, "why");
    const update = sql.texts.find((text) => text.includes("lpSequences.updateNote"));
    assert.notEqual(update, undefined);
    assert.ok((update ?? "").includes("set note = $4"));
    assert.ok(
      (update ?? "").includes(
        "where sequence_id = $1 and agent_id = $2 and owner_address = $3",
      ),
      "the note update must stay owner-scoped",
    );
    const create = sql.texts.find((text) => text.includes("lpSequences.create"));
    // PHASE3.18 R2.3 AMENDS THIS PIN, deliberately and minimally: the requote's
    // two persisted-target columns were inserted between `note` and the
    // timestamps, so the literal moved. The property the pin is about — the
    // note column named in the insert list rather than reached by `select *` —
    // is unchanged and still asserted.
    assert.ok(
      (create ?? "").includes("steps, note, target_tick_lower, target_tick_upper, created_at"),
    );
    await store.close();
  });
});

describe("Postgres SQL literals: the lpSettings upsert owner predicate is pinned (audit A9)", () => {
  it("the UPDATE arm carries the owner-match predicate", async () => {
    const sql = new RecordingSqlClient();
    const store = await PostgresLpSettingsStore.create(sql, () => START);
    await store.put({
      agentId: AGENT,
      ownerAddress: OWNER_A,
      params: { autoHarvest: true },
      digest: `0x${"ab".repeat(32)}` as Hex,
    });
    const put = sql.texts.find((text) => text.includes("lpSettings.put"));
    assert.notEqual(put, undefined);
    assert.ok(
      (put ?? "").includes(
        "where lp_settings.owner_address = excluded.owner_address",
      ),
      "the cross-owner guard on the upsert's UPDATE arm must not drift",
    );
    await store.close();
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.4 audit A3/A5 — the Postgres half of the token index, and the probe  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.4: the live-token index on BOTH backends (audit A3)", () => {
  for (const factory of FACTORIES) {
    describe(factory.name, () => {
      it("createPosition throws LpTokenIdInUseError on a second live row", async () => {
        // The memory twin throws the typed error directly; the Postgres path
        // reaches it only through `isLiveTokenIndexViolation`, which maps a raw
        // driver exception carrying the constraint name. The first build tested
        // only the former, so the mapping that production actually exercises —
        // including the copy inside the saga-hook transaction — was verified by
        // nobody, and a regression would restore R1's forever-held rotate with
        // the whole suite green.
        const store = await factory.make(() => START);
        await store.createPosition(positionInput("p1", { tokenId: "4242" }));
        await assert.rejects(
          store.createPosition(positionInput("p2", { tokenId: "4242" })),
          (error: unknown) => {
            assert.ok(error instanceof LpTokenIdInUseError, String(error));
            assert.equal(error.code, "LP_TOKEN_ID_IN_USE");
            assert.equal(error.tokenId, "4242");
            // And it must NOT leak the constraint name to a caller.
            assert.doesNotMatch(error.message, /lp_positions_one_live_token_idx/u);
            return true;
          },
        );
        await store.close();
      });

      it("updatePositionTokenId throws it too — the saga-hook site R1 is about", async () => {
        const store = await factory.make(() => START);
        await store.createPosition(positionInput("p1", { tokenId: "4242" }));
        await store.createPosition(positionInput("p2"));
        await assert.rejects(
          store.updatePositionTokenId(OWNER_A, AGENT, "p2", "4242"),
          (error: unknown) => error instanceof LpTokenIdInUseError,
        );
        await store.close();
      });

      it("a CLOSED row releases its claim, so a re-import succeeds", async () => {
        const store = await factory.make(() => START);
        await store.createPosition(positionInput("p1", { tokenId: "4242" }));
        await store.setPositionState(OWNER_A, AGENT, "p1", "closed");
        const reimported = await store.createPosition(
          positionInput("p2", { tokenId: "4242" }),
        );
        assert.equal(reimported.tokenId, "4242");
        await store.close();
      });

      it("a POSITION-ID collision is NOT reported as a token collision", async () => {
        // `lp_positions` carries a primary key too; mapping that to "that NFT is
        // already managed" would be a confident lie.
        const store = await factory.make(() => START);
        await store.createPosition(positionInput("p1", { tokenId: "4242" }));
        await assert.rejects(
          store.createPosition(positionInput("p1", { tokenId: "9999" })),
          (error: unknown) => !(error instanceof LpTokenIdInUseError),
        );
        await store.close();
      });

      it("getPositionByTokenId is owner-AND-agent scoped and ignores closed rows", async () => {
        const store = await factory.make(() => START);
        await store.createPosition(positionInput("p1", { tokenId: "4242" }));
        assert.equal(
          (await store.getPositionByTokenId(OWNER_A, AGENT, "4242"))?.positionId,
          "p1",
        );
        // The scope is the feature: another tenant answers `null` here, so the
        // route falls back to the generic voice and cannot leak across.
        assert.equal(await store.getPositionByTokenId(OWNER_B, AGENT, "4242"), null);
        assert.equal(
          await store.getPositionByTokenId(OWNER_A, "other-agent", "4242"),
          null,
        );
        await store.setPositionState(OWNER_A, AGENT, "p1", "closed");
        assert.equal(await store.getPositionByTokenId(OWNER_A, AGENT, "4242"), null);
        await store.close();
      });

      it("setOwnershipMismatch round-trips, and zero clears everything", async () => {
        const store = await factory.make(() => START);
        await store.createPosition(positionInput("p1", { tokenId: "4242" }));
        const marked = await store.setOwnershipMismatch(OWNER_A, AGENT, "p1", {
          count: 1,
          reason: "held by 0xdead",
          firstSeenAtMs: START,
        });
        assert.equal(marked.ownershipMismatchCount, 1);
        assert.equal(marked.ownershipLostReason, "held by 0xdead");
        assert.equal(marked.ownershipFirstSeenAtMs, START);
        const second = await store.setOwnershipMismatch(OWNER_A, AGENT, "p1", {
          count: 2,
          reason: "held by 0xdead",
          firstSeenAtMs: START,
        });
        // FIXREVIEW F1: a LATER confirmation carries the SAME anchor. The store
        // writes what it is told; keeping it unmoved is the worker's job — but
        // the round trip must preserve the value it is given on both backends,
        // or the separation gate measures a number that drifted in the database.
        assert.equal(second.ownershipFirstSeenAtMs, START);

        const cleared = await store.setOwnershipMismatch(OWNER_A, AGENT, "p1", {
          count: 0,
          reason: "held by 0xdead",
          firstSeenAtMs: START,
        });
        assert.equal(cleared.ownershipMismatchCount, 0);
        assert.equal(cleared.ownershipLostReason, null);
        assert.equal(
          cleared.ownershipFirstSeenAtMs,
          null,
          "a reset clears the anchor with the count, or the next run inherits a stale one",
        );
        await store.close();
      });

      it("a fresh row starts at zero mismatches", async () => {
        const store = await factory.make(() => START);
        const position = await store.createPosition(positionInput("p1"));
        assert.equal(position.ownershipMismatchCount, 0);
        assert.equal(position.ownershipLostReason, null);
        assert.equal(position.ownershipFirstSeenAtMs, null);
        await store.close();
      });

      it("basisSource defaults to owner-budget and honours an explicit 'imported'", async () => {
        const store = await factory.make(() => START);
        const opened = await store.createPosition(positionInput("p1"));
        assert.equal(opened.basisSource, "owner-budget");
        const imported = await store.createPosition(
          positionInput("p2", { basisSource: "imported" }),
        );
        assert.equal(imported.basisSource, "imported");
        await store.close();
      });

      it("getAnyNonTerminalSequence answers the agent-scoped predicate (audit A5)", async () => {
        const store = await factory.make(() => START);
        assert.equal(await store.getAnyNonTerminalSequence(OWNER_A, AGENT), null);
        const sequence = await seedSequence(store, "p1", "rotate");
        const found = await store.getAnyNonTerminalSequence(OWNER_A, AGENT);
        assert.equal(found?.sequenceId, sequence.sequenceId);
        // Scoped: another owner and another agent both answer null.
        assert.equal(await store.getAnyNonTerminalSequence(OWNER_B, AGENT), null);
        assert.equal(
          await store.getAnyNonTerminalSequence(OWNER_A, "other-agent"),
          null,
        );
        // Terminal ⇒ no longer blocking, which is the predicate's whole point.
        await store.setSequenceState(OWNER_A, AGENT, sequence.sequenceId, "completed");
        assert.equal(await store.getAnyNonTerminalSequence(OWNER_A, AGENT), null);
        await store.close();
      });

      it("a HELD sequence still owing a recovery is non-terminal here too", async () => {
        const store = await factory.make(() => START);
        const sequence = await seedSequence(store, "p1", "harvest");
        await store.setRecoveryState(
          OWNER_A,
          AGENT,
          sequence.sequenceId,
          "pending-increase",
        );
        await store.setSequenceState(OWNER_A, AGENT, sequence.sequenceId, "held");
        assert.equal(
          (await store.getAnyNonTerminalSequence(OWNER_A, AGENT))?.sequenceId,
          sequence.sequenceId,
        );
        await store.close();
      });
    });
  }
});
