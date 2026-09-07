/**
 * PHASE3.15 — storage, in BOTH backends, plus the raw-SQL pins the fake cannot
 * see.
 *
 * THE A6 WARNING IS WHY HALF OF THIS FILE EXISTS. `test/support/fakeSql.ts`
 * dispatches on each statement's tag comment and NEVER PARSES THE SQL, so every
 * predicate in it is a hand-written restatement of a real query: editing a real
 * `where` / `filter` / `check` clause and forgetting the fake leaves that edit
 * with ZERO executed coverage while the suite stays green. Cross-implementation
 * tests therefore prove the two AGREE, not that either matches Postgres — so
 * where a raw predicate is load-bearing it is ALSO pinned at the TEXT level,
 * the `test/lpQuotaRelease.test.ts` precedent.
 *
 * Offline: the memory stores and the fake SQL client, nothing else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { FakeSqlClient } from "./support/fakeSql.js";
import {
  LpExitQuotaError,
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  type LpExitQuota,
  type LpSequenceKind,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import {
  MemoryLpObservationStore,
  PostgresLpObservationStore,
  parseLpTriggerObservation,
  type LpObservationStore,
} from "../src/store/lpObservations.js";
import {
  MemoryLpGridCycleStore,
  PostgresLpGridCycleStore,
  type LpGridCycleRecord,
  type LpGridCycleStore,
} from "../src/store/gridCycles.js";
import type { LpTriggerObservation } from "../src/lp/triggers.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const AGENT_ID = "grid-store-agent";
const POSITION_ID = "grid-store-position";
const TOKEN0 = getAddress("0x00000000000000000000000000000000000000AA");
const TOKEN1 = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const START = 1_900_000_000_000;
const MINUTE = 60_000;

const SEQUENCE_BACKENDS: readonly {
  readonly name: string;
  readonly make: (now: () => number) => Promise<LpSequenceStore>;
}[] = [
  { name: "memory", make: async (now) => new MemoryLpSequenceStore(now) },
  {
    name: "postgres(fake)",
    make: async (now) => PostgresLpSequenceStore.create(new FakeSqlClient(), now),
  },
];

const OBSERVATION_BACKENDS: readonly {
  readonly name: string;
  readonly make: () => Promise<LpObservationStore>;
}[] = [
  { name: "memory", make: async () => new MemoryLpObservationStore() },
  {
    name: "postgres(fake)",
    make: async () => PostgresLpObservationStore.create(new FakeSqlClient()),
  },
];

const CYCLE_BACKENDS: readonly {
  readonly name: string;
  readonly make: () => Promise<LpGridCycleStore>;
}[] = [
  { name: "memory", make: async () => new MemoryLpGridCycleStore() },
  {
    name: "postgres(fake)",
    make: async () => PostgresLpGridCycleStore.create(new FakeSqlClient()),
  },
];

/* -------------------------------------------------------------------------- */
/* M1 — the observation fields ride the existing jsonb                        */
/* -------------------------------------------------------------------------- */

function gridObservation(
  overrides: Partial<LpTriggerObservation> = {},
): LpTriggerObservation {
  return {
    blockNumber: 100n,
    currentTick: -1_100,
    evaluatedAtMs: START,
    poolAddress: POOL,
    protectConsecutive: 0,
    rotationBreach: false,
    rotationConsecutive: 0,
    gridCrossConsecutive: 2,
    gridCrossSide: "above",
    tokenId: "42",
    ...overrides,
  };
}

describe("PHASE3.15 M1: the grid hysteresis round-trips in BOTH backends", () => {
  for (const backend of OBSERVATION_BACKENDS) {
    it(`${backend.name}: gridCrossConsecutive and gridCrossSide survive put/get`, async () => {
      const store = await backend.make();
      const observation = gridObservation();
      await store.put({
        ownerAddress: OWNER,
        agentId: AGENT_ID,
        positionId: POSITION_ID,
        observation,
      });
      const read = await store.get(OWNER, AGENT_ID, POSITION_ID);
      // THE (ae) TRAP, closed: a field written into the jsonb but not rebuilt
      // by `parseLpTriggerObservation` is silently DROPPED on read, the count
      // restarts every cycle, and a grid fill can NEVER reach two consecutive
      // confirmations.
      assert.equal(read?.gridCrossConsecutive, 2);
      assert.equal(read?.gridCrossSide, "above");
      assert.equal(read?.blockNumber, 100n, "the bigint codec still round-trips");
      await store.close();
    });

    it(`${backend.name}: an absent pair comes back ABSENT, never defaulted`, async () => {
      const store = await backend.make();
      const legacy = gridObservation();
      const stripped: LpTriggerObservation = { ...legacy };
      delete (stripped as { gridCrossConsecutive?: number }).gridCrossConsecutive;
      delete (stripped as { gridCrossSide?: string }).gridCrossSide;
      await store.put({
        ownerAddress: OWNER,
        agentId: AGENT_ID,
        positionId: POSITION_ID,
        observation: stripped,
      });
      const read = await store.get(OWNER, AGENT_ID, POSITION_ID);
      assert.ok(read !== null);
      assert.equal("gridCrossConsecutive" in (read ?? {}), false);
      assert.equal("gridCrossSide" in (read ?? {}), false);
      await store.close();
    });

    it(`${backend.name}: still owner-scoped — a cross-tenant read is null`, async () => {
      const store = await backend.make();
      await store.put({
        ownerAddress: OWNER,
        agentId: AGENT_ID,
        positionId: POSITION_ID,
        observation: gridObservation(),
      });
      assert.equal(await store.get(OTHER, AGENT_ID, POSITION_ID), null);
      await store.close();
    });
  }

  it("an UNRECOGNISED side rejects the WHOLE observation — the fail-safe direction", () => {
    // `null` means "no previous observation", which RESTARTS the count. The
    // reset is observation-WIDE, not field-local, and that is deliberate.
    assert.equal(
      parseLpTriggerObservation({ ...gridObservation(), gridCrossSide: "up" }),
      null,
    );
    assert.equal(
      parseLpTriggerObservation({ ...gridObservation(), gridCrossConsecutive: -1 }),
      null,
    );
    assert.equal(
      parseLpTriggerObservation({ ...gridObservation(), gridCrossConsecutive: 1.5 }),
      null,
    );
    // Both legal members of the closed set survive.
    for (const side of ["above", "below"] as const) {
      const parsed = parseLpTriggerObservation({ ...gridObservation(), gridCrossSide: side });
      assert.equal(parsed?.gridCrossSide, side);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* R2.9 item 6 / C10 — the widened kind CHECK                                 */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.9/OQ3: the lp_sequences kind CHECK accepts grid-flip", () => {
  for (const backend of SEQUENCE_BACKENDS) {
    it(`${backend.name}: a grid-flip sequence is created and read back`, async () => {
      const store = await backend.make(() => START);
      await store.createPosition({
        positionId: POSITION_ID,
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 2_500,
        tokenId: "42",
        basisWei: 0n,
        basisSource: "imported",
      });
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: POSITION_ID,
        kind: "grid-flip",
      });
      assert.equal(sequence.kind, "grid-flip");
      const read = await store.getSequence(OWNER, AGENT_ID, sequence.sequenceId);
      assert.equal(read?.kind, "grid-flip");
      // And it is visible to the worker queue like every other kind.
      const queue = await store.listNonTerminalSequencesForWorker();
      assert.equal(queue.some((row) => row.kind === "grid-flip"), true);
      await store.close();
    });

    it(`${backend.name}: an UNKNOWN kind is still rejected`, async () => {
      const store = await backend.make(() => START);
      await store.createPosition({
        positionId: POSITION_ID,
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 2_500,
        tokenId: "42",
        basisWei: 0n,
      });
      await assert.rejects(
        store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: POSITION_ID,
          kind: "grid-flop" as LpSequenceKind,
        }),
        /Unknown LP sequence kind/u,
      );
      await store.close();
    });
  }

  it("C10: the REAL DDL widens the constraint through a guarded, idempotent DO block", () => {
    // The fake never parses SQL, so the cross-implementation cases above cannot
    // see this. Pinned at the TEXT level, the `lpQuotaRelease` precedent.
    const source = readFileSync(
      new URL("../src/store/lpSequences.ts", import.meta.url),
      "utf8",
    );
    // The create-table list, for a fresh database.
    assert.match(
      source,
      // PHASE3.16 widened this literal again, for `grid-arm`. The 3.15
      // guarantee this line exists for is unchanged and is what is asserted:
      // a FRESH database gets `grid-flip` from `create table`. The trailing
      // members are deliberately not anchored, so the next kind moves one
      // literal rather than two.
      /kind text not null check \(kind in \('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip'/u,
      "a fresh database must get the widened list",
    );
    // The migration, for one that already ran Phase 3 — a bare
    // `create table if not exists` does NOTHING to an existing table.
    const block = /do \$lp_sequences_kind\$[\s\S]*?\$lp_sequences_kind\$/u.exec(source)?.[0];
    assert.ok(block !== undefined, "the guarded DO block must exist");
    assert.match(
      block!,
      /lock table lp_sequences in access exclusive mode/u,
      "server and worker initialize the same store independently",
    );
    assert.match(
      block!,
      /pg_get_constraintdef\(oid\) not like '%grid-flip%'/u,
      "the drop is guarded on the constraint LACKING the new member",
    );
    assert.match(block!, /drop constraint lp_sequences_kind_check/u);
    assert.match(
      block!,
      /add constraint lp_sequences_kind_check[\s\S]*'grid-flip'/u,
    );
    // ONE constraint migration, not two: `recovery_state` is untouched because
    // the flip declares only existing LpRecoveryState members.
    assert.doesNotMatch(block!, /recovery_state/u);
  });
});

/* -------------------------------------------------------------------------- */
/* R2.7 — the per-kind quota split                                            */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.7: the quota lanes are separate in BOTH backends", () => {
  async function seed(
    store: LpSequenceStore,
    positionId: string,
  ): Promise<void> {
    await store.createPosition({
      positionId,
      agentId: AGENT_ID,
      ownerAddress: OWNER,
      token0: TOKEN0,
      token1: TOKEN1,
      fee: 2_500,
      tokenId: positionId,
      basisWei: 0n,
    });
  }

  for (const backend of SEQUENCE_BACKENDS) {
    it(`${backend.name}: a grid flip does NOT occupy the rotate/harvest count`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      const quota: LpExitQuota = {
        maxExitSequencesPerDay: 1,
        minMinutesBetweenExits: 0,
        maxGridFlipsPerDay: 4,
      };
      await seed(store, "p1");
      // Two grid flips, back to back.
      for (const index of [0, 1]) {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: "p1",
          kind: "grid-flip",
        });
        await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota);
        await store.setSequenceState(OWNER, AGENT_ID, sequence.sequenceId, "completed");
        now += MINUTE;
        void index;
      }
      // The EXIT lane is still untouched, even though its cap is 1.
      const rotate = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "rotate",
      });
      await store.reserveSequence(OWNER, AGENT_ID, rotate.sequenceId, quota);
      await store.close();
    });

    it(`${backend.name}: the GRID lane refuses on its own count, naming the grid`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      const quota: LpExitQuota = {
        maxExitSequencesPerDay: 24,
        minMinutesBetweenExits: 0,
        maxGridFlipsPerDay: 1,
      };
      await seed(store, "p1");
      const first = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "grid-flip",
      });
      await store.reserveSequence(OWNER, AGENT_ID, first.sequenceId, quota);
      await store.setSequenceState(OWNER, AGENT_ID, first.sequenceId, "completed");
      now += MINUTE;
      const second = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "grid-flip",
      });
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT_ID, second.sequenceId, quota),
        (error: unknown) =>
          error instanceof LpExitQuotaError
          && error.reason === "quota-exhausted"
          && error.lane === "grid"
          && /grid-flip quota is exhausted/u.test(error.message),
      );
      await store.close();
    });

    it(`${backend.name}: an ABSENT maxGridFlipsPerDay fails CLOSED at zero`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "p1");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "grid-flip",
      });
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, {
          maxExitSequencesPerDay: 24,
          minMinutesBetweenExits: 0,
        }),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.reason === "quota-exhausted",
      );
      await store.close();
    });

    it(`${backend.name}: the SPACING anchor still sees BOTH lanes (PHASE3.5 M3)`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      const quota: LpExitQuota = {
        maxExitSequencesPerDay: 24,
        minMinutesBetweenExits: 30,
        maxGridFlipsPerDay: 24,
      };
      await seed(store, "p1");
      const flip = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "grid-flip",
      });
      await store.reserveSequence(OWNER, AGENT_ID, flip.sequenceId, quota);
      await store.setSequenceState(OWNER, AGENT_ID, flip.sequenceId, "completed");
      now += MINUTE;
      // The lanes are separate for the COUNT and shared for the PACE: the
      // spacing gate is a floor the owner signed, and it is the only bound on a
      // reserve -> refuse -> roll-back loop.
      const rotate = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "p1",
        kind: "rotate",
      });
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT_ID, rotate.sequenceId, quota),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.reason === "min-interval",
      );
      await store.close();
    });

    it(`${backend.name}: quotaUsage reports the two lanes separately`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      const quota: LpExitQuota = {
        maxExitSequencesPerDay: 24,
        minMinutesBetweenExits: 0,
        maxGridFlipsPerDay: 24,
      };
      await seed(store, "p1");
      for (const kind of ["grid-flip", "grid-flip", "rotate"] as const) {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: "p1",
          kind,
        });
        await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota);
        await store.setSequenceState(OWNER, AGENT_ID, sequence.sequenceId, "completed");
        now += MINUTE;
      }
      const usage = await store.quotaUsage(OWNER, AGENT_ID);
      assert.equal(usage.gridFlipLiveCount, 2);
      // `liveCount` keeps meaning the EXIT lane, which is what
      // `maxExitSequencesPerDay` bounds and what the existing quota view says.
      assert.equal(usage.liveCount, 1);
      await store.close();
    });
  }

  it("A6: the REAL quotaUsage keeps its pinned filters and gains the grid lane", () => {
    const source = readFileSync(
      new URL("../src/store/lpSequences.ts", import.meta.url),
      "utf8",
    );
    const at = source.indexOf("/* lpReservations.quotaUsage */");
    assert.notEqual(at, -1);
    const statement = source.slice(at, source.indexOf("`", at));
    // The three predicates `test/lpQuotaRelease.test.ts` already pins are
    // UNTOUCHED — the lane split is done in TypeScript precisely so this text
    // does not move.
    assert.match(statement, /released_at is null and quota_bound\) as live_count/u);
    assert.match(
      statement,
      /released_at is null and quota_bound\) as oldest_live_reserved_at/u,
    );
    assert.match(statement, /where agent_id = \$1 and owner_address = \$2/u);
    // And the one new aggregate.
    assert.match(
      statement,
      /released_at is null and quota_bound and kind = 'grid-flip'\) as grid_live_count/u,
    );

    const windowAt = source.indexOf("/* lpReservations.window */");
    const windowStatement = source.slice(windowAt, source.indexOf("`", windowAt));
    assert.match(
      windowStatement,
      /select reserved_at, released_at, quota_bound, kind/u,
      "the window query must SELECT kind or the gate cannot split the lanes",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R2.11 — the cycle ledger                                                   */
/* -------------------------------------------------------------------------- */

function cycle(overrides: Partial<LpGridCycleRecord> = {}): LpGridCycleRecord {
  return {
    sequenceId: "seq-1",
    agentId: AGENT_ID,
    ownerAddress: OWNER,
    positionId: POSITION_ID,
    direction: "to-sell",
    fromTickLower: -1_000,
    fromTickUpper: -500,
    toTickLower: 500,
    toTickUpper: 1_000,
    freedAmount0Wei: 10n ** 15n,
    freedAmount1Wei: 0n,
    mintedAmount0Wei: 10n ** 15n,
    mintedAmount1Wei: 0n,
    residueWei: 7n,
    residueBps: 3n,
    fromTokenId: "42",
    toTokenId: "43",
    completedAtMs: START,
    ...overrides,
  };
}

describe("PHASE3.15 R2.11: the grid cycle ledger, in BOTH backends", () => {
  for (const backend of CYCLE_BACKENDS) {
    it(`${backend.name}: records, round-trips the bigints, and lists oldest first`, async () => {
      const store = await backend.make();
      await store.record(cycle({ sequenceId: "seq-2", completedAtMs: START + MINUTE }));
      await store.record(cycle({ sequenceId: "seq-1", completedAtMs: START }));
      const rows = await store.list(OWNER, AGENT_ID);
      assert.deepEqual(rows.map((row) => row.sequenceId), ["seq-1", "seq-2"]);
      assert.equal(rows[0]?.freedAmount0Wei, 10n ** 15n);
      assert.equal(rows[0]?.residueBps, 3n);
      assert.equal(rows[0]?.direction, "to-sell");
      await store.close();
    });

    it(`${backend.name}: is IDEMPOTENT on sequenceId — one flip, one row`, async () => {
      const store = await backend.make();
      await store.record(cycle());
      await store.record(cycle({ direction: "to-buy", toTokenId: "99" }));
      const rows = await store.list(OWNER, AGENT_ID);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.direction, "to-sell", "the first write wins");
      await store.close();
    });

    it(`${backend.name}: is owner-scoped — another owner sees nothing`, async () => {
      const store = await backend.make();
      await store.record(cycle());
      assert.deepEqual(await store.list(OTHER, AGENT_ID), []);
      assert.deepEqual(await store.list(OWNER, "another-agent"), []);
      await store.close();
    });
  }
});
