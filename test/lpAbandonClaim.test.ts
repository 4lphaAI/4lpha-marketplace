/**
 * PHASE3.8-FIXREVIEW N1 — the cross-process abandon claim contract.
 *
 * The route and worker are separate processes in production, so a route-only
 * re-read is not evidence. These cases run the same lease/CAS matrix against
 * Memory and Postgres(fake), including the stale-crash recovery path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import {
  LP_STALL_BACKOFF_INTERVALS,
  LP_STALL_LATCH_ATTEMPTS,
  shouldDeferStalledResume,
} from "../src/lp/worker.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER = getAddress("0x0000000000000000000000000000000000000001");
const TOKEN0 = getAddress("0x0000000000000000000000000000000000000002");
const TOKEN1 = getAddress("0x0000000000000000000000000000000000000003");
const AGENT = "claim-agent";
const INTERVAL = 60_000;

type Backend = {
  readonly label: string;
  create(now: () => number): Promise<LpSequenceStore>;
};

const BACKENDS: readonly Backend[] = [
  { label: "memory", create: async (now) => new MemoryLpSequenceStore(now) },
  {
    label: "postgres(fake sql)",
    create: (now) => PostgresLpSequenceStore.create(new FakeSqlClient(), now),
  },
];

async function heldSequence(
  store: LpSequenceStore,
  positionId: string,
) {
  await store.createPosition({
    positionId,
    agentId: AGENT,
    ownerAddress: OWNER,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 100,
    basisWei: 1n,
  });
  const sequence = await store.createSequence({
    agentId: AGENT,
    ownerAddress: OWNER,
    positionId,
    kind: "harvest",
  });
  await store.setRecoveryState(
    OWNER,
    AGENT,
    sequence.sequenceId,
    "wbnb-stranded",
  );
  return store.setSequenceState(OWNER, AGENT, sequence.sequenceId, "held");
}

for (const backend of BACKENDS) {
  describe(`abandon claim CAS — ${backend.label}`, () => {
    it("rejects generic HELD -> abandoning while dedicated claim and stale reclaim remain legal", async () => {
      let now = 1_900_000_000_000;
      const store = await backend.create(() => now);
      const held = await heldSequence(store, "p-entry");

      await assert.rejects(
        () => store.setSequenceState(OWNER, AGENT, held.sequenceId, "abandoning"),
        /Illegal LP sequence transition held → abandoning/u,
      );
      assert.equal(
        (await store.getSequence(OWNER, AGENT, held.sequenceId))?.state,
        "held",
      );

      now += INTERVAL;
      const claimed = await store.claimSequenceForAbandon(
        OWNER,
        AGENT,
        held.sequenceId,
        {
          expectedUpdatedAt: held.updatedAt,
          claimId: "entry-claim",
          nowMs: now,
          minIdleMs: INTERVAL,
        },
      );
      assert.equal(claimed?.state, "abandoning");

      now += INTERVAL;
      const reclaimed = await store.claimSequenceForAbandon(
        OWNER,
        AGENT,
        held.sequenceId,
        {
          expectedUpdatedAt: claimed?.updatedAt ?? 0,
          claimId: "entry-reclaim",
          nowMs: now,
          minIdleMs: INTERVAL,
        },
      );
      assert.equal(reclaimed?.state, "abandoning");
      assert.equal(
        await store.releaseSequenceAbandonClaim(
          OWNER,
          AGENT,
          held.sequenceId,
          "entry-claim",
        ),
        null,
        "the stale claim loses ownership on reclaim",
      );
      assert.equal(
        (
          await store.releaseSequenceAbandonClaim(
            OWNER,
            AGENT,
            held.sequenceId,
            "entry-reclaim",
          )
        )?.state,
        "held",
      );
      await store.close();
    });

    it("atomically fences a stale worker snapshot and stays non-terminal", async () => {
      let now = 1_900_000_000_000;
      const store = await backend.create(() => now);
      const held = await heldSequence(store, "p-fence");
      now += INTERVAL;

      const claimed = await store.claimSequenceForAbandon(
        OWNER,
        AGENT,
        held.sequenceId,
        {
          expectedUpdatedAt: held.updatedAt,
          claimId: "claim-a",
          nowMs: now,
          minIdleMs: INTERVAL,
        },
      );
      assert.equal(claimed?.state, "abandoning");
      await assert.rejects(
        () => store.setSequenceState(OWNER, AGENT, held.sequenceId, "active"),
        /Illegal LP sequence transition abandoning/u,
      );
      assert.equal(
        (await store.getNonTerminalSequence(OWNER, AGENT, "p-fence"))?.sequenceId,
        held.sequenceId,
        "the lease still blocks a second saga/import",
      );
      assert.equal(
        (await store.listNonTerminalSequencesForWorker()).length,
        0,
        "but the worker cannot resume the owner route's lease",
      );
      await store.close();
    });

    it("releases only before disposition; after the marker it must finish forward", async () => {
      let now = 1_900_000_000_000;
      const store = await backend.create(() => now);
      const held = await heldSequence(store, "p-release");
      now += INTERVAL;
      await store.claimSequenceForAbandon(OWNER, AGENT, held.sequenceId, {
        expectedUpdatedAt: held.updatedAt,
        claimId: "claim-release",
        nowMs: now,
        minIdleMs: INTERVAL,
      });
      assert.equal(
        (
          await store.releaseSequenceAbandonClaim(
            OWNER,
            AGENT,
            held.sequenceId,
            "claim-release",
          )
        )?.state,
        "held",
      );

      now += INTERVAL;
      const refreshed = await store.getSequence(OWNER, AGENT, held.sequenceId);
      assert.notEqual(refreshed, null);
      await store.claimSequenceForAbandon(OWNER, AGENT, held.sequenceId, {
        expectedUpdatedAt: refreshed?.updatedAt ?? 0,
        claimId: "claim-forward",
        nowMs: now,
        minIdleMs: INTERVAL,
      });
      now += 1;
      assert.notEqual(
        await store.beginSequenceAbandonDisposition(
          OWNER,
          AGENT,
          held.sequenceId,
          "claim-forward",
        ),
        null,
      );
      assert.equal(
        await store.releaseSequenceAbandonClaim(
          OWNER,
          AGENT,
          held.sequenceId,
          "claim-forward",
        ),
        null,
        "the persisted marker forbids returning a partial disposition to the worker",
      );
      assert.equal(
        (
          await store.completeSequenceAbandon(
            OWNER,
            AGENT,
            held.sequenceId,
            "claim-forward",
          )
        )?.state,
        "rolled-back",
      );
      await store.close();
    });

    it("reclaims a stale crash lease, preserves the disposition marker, and rejects the old owner", async () => {
      let now = 1_900_000_000_000;
      const store = await backend.create(() => now);
      const held = await heldSequence(store, "p-reclaim");
      now += INTERVAL;
      const first = await store.claimSequenceForAbandon(
        OWNER,
        AGENT,
        held.sequenceId,
        {
          expectedUpdatedAt: held.updatedAt,
          claimId: "dead-process",
          nowMs: now,
          minIdleMs: INTERVAL,
        },
      );
      assert.notEqual(first, null);
      now += 1;
      await store.beginSequenceAbandonDisposition(
        OWNER,
        AGENT,
        held.sequenceId,
        "dead-process",
      );

      const crashed = await store.getSequence(OWNER, AGENT, held.sequenceId);
      now += INTERVAL;
      const reclaimed = await store.claimSequenceForAbandon(
        OWNER,
        AGENT,
        held.sequenceId,
        {
          expectedUpdatedAt: crashed?.updatedAt ?? 0,
          claimId: "new-process",
          nowMs: now,
          minIdleMs: INTERVAL,
        },
      );
      assert.equal(reclaimed?.state, "abandoning");
      assert.equal(
        await store.completeSequenceAbandon(
          OWNER,
          AGENT,
          held.sequenceId,
          "dead-process",
        ),
        null,
        "the old process lost ownership when the lease was reclaimed",
      );
      assert.equal(
        await store.releaseSequenceAbandonClaim(
          OWNER,
          AGENT,
          held.sequenceId,
          "new-process",
        ),
        null,
        "the first process's disposition-start marker survived the reclaim",
      );
      assert.equal(
        (
          await store.completeSequenceAbandon(
            OWNER,
            AGENT,
            held.sequenceId,
            "new-process",
          )
        )?.state,
        "rolled-back",
      );
      await store.close();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* PHASE3.11 F1 — the worker must not starve the owner's abandon claim        */
/* -------------------------------------------------------------------------- */

/**
 * One worker cycle against a sequence that cannot progress, at the store level
 * the contention actually happens at: claim `held -> active`, drive, re-hold,
 * record the stall. Every one of those writes refreshes `updated_at`.
 *
 * `defer` is F1 itself — {@link shouldDeferStalledResume}, the predicate
 * `runLpWorkerOnce` consults before it touches the row. Passing `false` for it
 * reproduces the pre-F1 worker exactly.
 */
async function stalledWorkerCycle(
  store: LpSequenceStore,
  sequenceId: string,
  nowMs: number,
  defer: boolean,
): Promise<void> {
  const current = await store.getSequence(OWNER, AGENT, sequenceId);
  if (current === null || current.state !== "held") return;
  if (defer && shouldDeferStalledResume(current, nowMs, INTERVAL)) return;
  await store.setSequenceState(OWNER, AGENT, sequenceId, "active");
  await store.setSequenceState(OWNER, AGENT, sequenceId, "held");
  await store.recordSequenceStall(OWNER, AGENT, sequenceId, "BUILD_REFUSED@2");
}

/** The owner's abandon, as the route issues it: read, then CAS on that read. */
async function ownerClaim(
  store: LpSequenceStore,
  sequenceId: string,
  nowMs: number,
): Promise<boolean> {
  const row = await store.getSequence(OWNER, AGENT, sequenceId);
  if (row === null || row.state !== "held") return false;
  const claimed = await store.claimSequenceForAbandon(OWNER, AGENT, sequenceId, {
    expectedUpdatedAt: row.updatedAt,
    claimId: "owner-claim-1",
    nowMs,
    minIdleMs: INTERVAL,
  });
  return claimed !== null;
}

/**
 * Drive `cycles` worker intervals, attempting the owner's abandon halfway
 * through each one, and report the interval on which the claim succeeded.
 */
async function claimAgainstCyclingWorker(
  store: LpSequenceStore,
  sequenceId: string,
  start: number,
  setNow: (ms: number) => void,
  defer: boolean,
  cycles: number,
): Promise<number | null> {
  for (let index = 1; index <= cycles; index += 1) {
    const cycleAt = start + index * INTERVAL;
    setNow(cycleAt);
    await stalledWorkerCycle(store, sequenceId, cycleAt, defer);
    const requestAt = cycleAt + INTERVAL / 2;
    setNow(requestAt);
    if (await ownerClaim(store, sequenceId, requestAt)) return index;
  }
  return null;
}

for (const backend of BACKENDS) {
  describe(`PHASE3.11 F1: abandon against a cycling worker — ${backend.label}`, () => {
    it("B7: the owner's claim succeeds once the stalled sequence stops being resumed", async () => {
      let now = 1_900_000_000_000;
      const store = await backend.create(() => now);
      const held = await heldSequence(store, "p-stalled");
      const start = now;

      const succeededOn = await claimAgainstCyclingWorker(
        store,
        held.sequenceId,
        start,
        (ms) => {
          now = ms;
        },
        true,
        12,
      );

      assert.notEqual(
        succeededOn,
        null,
        "an owner cannot be told to stop the daemon serving every other tenant",
      );
      assert.ok(
        (succeededOn ?? 0) > LP_STALL_LATCH_ATTEMPTS,
        "and it only becomes claimable AFTER the latch trips, never mid-drive",
      );
      assert.equal(
        (await store.getSequence(OWNER, AGENT, held.sequenceId))?.state,
        "abandoning",
      );
    });

    it("B7 control: the same owner, against the pre-F1 worker, never gets the claim", async () => {
      let now = 1_900_000_000_000;
      const store = await backend.create(() => now);
      const held = await heldSequence(store, "p-starved");

      const succeededOn = await claimAgainstCyclingWorker(
        store,
        held.sequenceId,
        now,
        (ms) => {
          now = ms;
        },
        false,
        12,
      );

      assert.equal(
        succeededOn,
        null,
        "the held -> active -> held round trip refreshes updated_at inside every interval",
      );
    });

    it("the latch counts only CONSECUTIVE identical parks; any change restarts it", async () => {
      let now = 1_900_000_000_000;
      const store = await backend.create(() => now);
      const held = await heldSequence(store, "p-latch");

      const first = await store.recordSequenceStall(
        OWNER,
        AGENT,
        held.sequenceId,
        "BUILD_REFUSED@2",
      );
      assert.equal(first.stallCount, 1);
      const second = await store.recordSequenceStall(
        OWNER,
        AGENT,
        held.sequenceId,
        "BUILD_REFUSED@2",
      );
      assert.equal(second.stallCount, 2);
      const moved = await store.recordSequenceStall(
        OWNER,
        AGENT,
        held.sequenceId,
        "HELD_AMBIGUOUS@3",
      );
      assert.equal(moved.stallCount, 1, "progress releases the latch");
      assert.equal(moved.stallCode, "HELD_AMBIGUOUS@3");
    });

    it("a fresh sequence is never deferred, and a latched one is resumed again after the backoff", async () => {
      let now = 1_900_000_000_000;
      const store = await backend.create(() => now);
      const held = await heldSequence(store, "p-backoff");
      assert.equal(shouldDeferStalledResume(held, now, INTERVAL), false);

      let latched = held;
      for (let index = 0; index < LP_STALL_LATCH_ATTEMPTS; index += 1) {
        latched = await store.recordSequenceStall(
          OWNER,
          AGENT,
          held.sequenceId,
          "BUILD_REFUSED@2",
        );
      }
      assert.equal(shouldDeferStalledResume(latched, now, INTERVAL), true);
      assert.equal(
        shouldDeferStalledResume(
          latched,
          latched.updatedAt + INTERVAL * LP_STALL_BACKOFF_INTERVALS,
          INTERVAL,
        ),
        false,
        "a backoff, not a stop: a refusal that heals by itself is still picked up",
      );
    });
  });
}
