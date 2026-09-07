/**
 * PHASE3.5 — releasing the slot a sequence never spent.
 *
 * The two regressions that decide whether this phase is safe, both pinned here
 * because both were BLOCKERS in `PHASE3.5-REVIEW.md`:
 *
 *   - **M1**: the release predicate is NARROWER than `driveSequence`'s retry
 *     predicate. A `ROLLED_BACK` row carrying a `callsId` or a `txHash` reached
 *     a relay and drew gas, and this limit is a proxy for the gas meter;
 *   - **M3**: the daily COUNT skips released rows and the `minMinutesBetweenExits`
 *     ANCHOR does not. Filtering both would re-open a pacing floor the owner
 *     signed AND remove the only bound on a reserve→refuse→roll-back loop.
 *
 * Plus the no-drift regression: with nothing released, both backends count
 * exactly as they did before this phase.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  LpExitQuotaError,
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  type CreateLpPositionInput,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import { lpReservationReleasable } from "../src/lp/sagas.js";
import { lpQuotaView } from "../src/http/lpWire.js";
import type { JournalEntry } from "../src/store/journal.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER = getAddress(privateKeyToAccount(`0x${"a1".repeat(32)}`).address);
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const AGENT = "quota-agent";
const START = 1_900_000_000_000;
const MINUTE = 60_000;

const FACTORIES: readonly {
  readonly name: string;
  make(clock: () => number): Promise<LpSequenceStore>;
}[] = [
  { name: "memory", make: async (clock) => new MemoryLpSequenceStore(clock) },
  {
    name: "postgres(fake sql)",
    make: (clock) => PostgresLpSequenceStore.create(new FakeSqlClient(), clock),
  },
];

function positionInput(
  positionId: string,
  ownerAddress: `0x${string}` = OWNER,
): CreateLpPositionInput {
  return {
    positionId,
    agentId: AGENT,
    ownerAddress,
    token0: USDT,
    token1: WBNB,
    fee: 100,
    basisWei: parseEther("0.005"),
  };
}

/** A quota with generous spacing, so the COUNT is what a test trips. */
const COUNT_QUOTA = { maxExitSequencesPerDay: 2, minMinutesBetweenExits: 0 };

async function seed(
  store: LpSequenceStore,
  positionId: string,
  kind: "rotate" | "harvest" | "protect" | "manual-exit" | "open",
  ownerAddress: `0x${string}` = OWNER,
) {
  await store.createPosition(positionInput(positionId, ownerAddress));
  return store.createSequence({
    agentId: AGENT,
    ownerAddress,
    positionId,
    kind,
  });
}

/* -------------------------------------------------------------------------- */
/* M1 — the predicate                                                         */
/* -------------------------------------------------------------------------- */

function row(
  state: JournalEntry["state"],
  externalRef: Record<string, unknown> = {},
): JournalEntry {
  return {
    state,
    externalRef,
  } as unknown as JournalEntry;
}

describe("PHASE3.5 M1: the release predicate is narrower than the retry join's", () => {
  const step = { journalIdempotencyKey: "k1" };

  it("zero recorded steps releases", () => {
    assert.equal(lpReservationReleasable(new Map(), []), true);
  });

  it("an ABSENT row releases — it died in the appendStep->begin window", () => {
    assert.equal(
      lpReservationReleasable(new Map([["k1", null]]), [step]),
      true,
    );
  });

  it("a bare ROLLED_BACK row releases", () => {
    assert.equal(
      lpReservationReleasable(new Map([["k1", row("ROLLED_BACK")]]), [step]),
      true,
    );
  });

  it("ROLLED_BACK carrying a callsId does NOT release — the FAILED-receipt rollback", () => {
    // `markInProgress{callsId}` runs BEFORE `markRolledBack` on that path, so
    // this row reached a relay and drew gas. The retry join calls its slot
    // open, correctly, for retries — and this predicate must not agree.
    assert.equal(
      lpReservationReleasable(
        new Map([["k1", row("ROLLED_BACK", { callsId: "0xabc" })]]),
        [step],
      ),
      false,
    );
  });

  it("ROLLED_BACK carrying a txHash does NOT release — reconcile's FAILED resolution", () => {
    assert.equal(
      lpReservationReleasable(
        new Map([["k1", row("ROLLED_BACK", { txHash: "0xdef" })]]),
        [step],
      ),
      false,
    );
  });

  it("ROLLED_BACK carrying a resolution does NOT release — the resolveUnknown abandon", () => {
    // Its evidence is that the EFFECT is absent, which cannot discharge gas:
    // the relay may have taken the bundle (FINDINGS (aa)) and this deployment
    // cannot read logs to check. This is the case that motivated the phase and
    // it deliberately ships unfixed.
    assert.equal(
      lpReservationReleasable(
        new Map([["k1", row("ROLLED_BACK", { resolution: { action: "resolveUnknown" } })]]),
        [step],
      ),
      false,
    );
  });

  for (const state of ["PENDING", "IN_PROGRESS", "UNKNOWN", "COMMITTED"] as const) {
    it(`a ${state} row does NOT release`, () => {
      assert.equal(
        lpReservationReleasable(new Map([["k1", row(state)]]), [step]),
        false,
      );
    });
  }

  it("ONE spent step among many holds the whole sequence", () => {
    const steps = [
      { journalIdempotencyKey: "k1" },
      { journalIdempotencyKey: "k2" },
      { journalIdempotencyKey: "k3" },
    ];
    const rows = new Map<string, JournalEntry | null>([
      ["k1", row("ROLLED_BACK")],
      ["k2", row("COMMITTED")],
      ["k3", null],
    ]);
    assert.equal(lpReservationReleasable(rows, steps), false);
  });
});

/* -------------------------------------------------------------------------- */
/* M3 — the split, on both backends                                           */
/* -------------------------------------------------------------------------- */

for (const factory of FACTORIES) {
  describe(`PHASE3.5 M3: count vs spacing — ${factory.name}`, () => {
    it("a released row frees a COUNT slot", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const a = await seed(store, "p1", "rotate");
      await store.reserveSequence(OWNER, AGENT, a.sequenceId, COUNT_QUOTA);
      now += MINUTE;
      const b = await seed(store, "p2", "harvest");
      await store.reserveSequence(OWNER, AGENT, b.sequenceId, COUNT_QUOTA);

      // 2 of 2 used: a third is refused.
      now += MINUTE;
      const c = await seed(store, "p3", "rotate");
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT, c.sequenceId, COUNT_QUOTA),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.reason === "quota-exhausted",
      );

      // Give one back, and the same request is admitted.
      await store.releaseReservation(OWNER, AGENT, a.sequenceId);
      const reserved = await store.reserveSequence(
        OWNER,
        AGENT,
        c.sequenceId,
        COUNT_QUOTA,
      );
      assert.equal(reserved.sequenceId, c.sequenceId);
      await store.close();
    });

    it("a released row STILL anchors the spacing gate", async () => {
      // The half the natural build gets wrong. `minMinutesBetweenExits` is a
      // pacing floor the owner SIGNED, and it is the only bound on a worker
      // loop that reserves, refuses above the submit, and rolls back every
      // cycle. Released from both, that loop runs once per cycle for ever.
      let now = START;
      const store = await factory.make(() => now);
      const quota = { maxExitSequencesPerDay: 10, minMinutesBetweenExits: 5 };
      const a = await seed(store, "p1", "rotate");
      await store.reserveSequence(OWNER, AGENT, a.sequenceId, quota);
      await store.releaseReservation(OWNER, AGENT, a.sequenceId);

      now += MINUTE; // one minute later, inside the five-minute floor
      const b = await seed(store, "p2", "harvest");
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT, b.sequenceId, quota),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.reason === "min-interval",
        "a released row must not stop anchoring the spacing gate",
      );

      now += 5 * MINUTE; // past the floor
      const admitted = await store.reserveSequence(
        OWNER,
        AGENT,
        b.sequenceId,
        quota,
      );
      assert.equal(admitted.sequenceId, b.sequenceId);
      await store.close();
    });

    it("release is IDEMPOTENT and a no-op when no reservation exists", async () => {
      // The quota-REFUSED path rolls its sequence back with no reservation in
      // existence (the insert went back with the transaction) and must not
      // error.
      const store = await factory.make(() => START);
      await store.releaseReservation(OWNER, AGENT, "never-reserved");
      const a = await seed(store, "p1", "rotate");
      await store.reserveSequence(OWNER, AGENT, a.sequenceId, COUNT_QUOTA);
      await store.releaseReservation(OWNER, AGENT, a.sequenceId);
      await store.releaseReservation(OWNER, AGENT, a.sequenceId);
      const usage = await store.quotaUsage(OWNER, AGENT);
      assert.equal(usage.liveCount, 0);
      assert.equal(usage.releasedCount, 1);
      await store.close();
    });

    it("release is owner-AND-agent scoped", async () => {
      const store = await factory.make(() => START);
      const a = await seed(store, "p1", "rotate");
      await store.reserveSequence(OWNER, AGENT, a.sequenceId, COUNT_QUOTA);
      const other = getAddress(privateKeyToAccount(`0x${"b2".repeat(32)}`).address);
      await store.releaseReservation(other, AGENT, a.sequenceId);
      await store.releaseReservation(OWNER, "other-agent", a.sequenceId);
      assert.equal((await store.quotaUsage(OWNER, AGENT)).liveCount, 1);
      await store.close();
    });

    it("NO DRIFT among quota-bound kinds: three rotates still exhaust a cap of three", async () => {
      // PHASE3.7 F2 narrowed WHICH rows count; it did not change the count for
      // the kinds the cap is about. Three quota-bound reservations against a
      // cap of three still refuse the fourth, exactly as before the phase.
      let now = START;
      const store = await factory.make(() => now);
      const quota = { maxExitSequencesPerDay: 3, minMinutesBetweenExits: 0 };
      for (const [i, kind] of (["rotate", "harvest", "rotate"] as const).entries()) {
        const seq = await seed(store, `p${i}`, kind);
        await store.reserveSequence(OWNER, AGENT, seq.sequenceId, quota);
        now += MINUTE;
      }
      const fourth = await seed(store, "p9", "rotate");
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT, fourth.sequenceId, quota),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.reason === "quota-exhausted",
        "quota-bound rows still fill the cap at exactly the same point",
      );
      await store.close();
    });

    it("PHASE3.7 F2: an EXEMPT kind no longer occupies the cap it is exempt from", async () => {
      // The measured defect (FINDINGS ap-3). `protect` and `manual-exit` skip
      // the check entirely as callers, yet their rows filled the window, so on
      // 2026-08-18 five unreleased rows against a cap of four refused two
      // rotates BEFORE they reserved — leaving no reservation row behind to
      // explain the refusal. Invert the `quota_bound` conjunct and this fails.
      let now = START;
      const store = await factory.make(() => now);
      const quota = { maxExitSequencesPerDay: 2, minMinutesBetweenExits: 0 };
      for (const [i, kind] of (["protect", "manual-exit"] as const).entries()) {
        const seq = await seed(store, `x${i}`, kind);
        await store.reserveSequence(OWNER, AGENT, seq.sequenceId, quota);
        now += MINUTE;
      }
      // Two exempt rows sit in the window against a cap of two. Both
      // quota-bound kinds must still get their full allowance.
      for (const [i, kind] of (["rotate", "harvest"] as const).entries()) {
        const seq = await seed(store, `y${i}`, kind);
        await store.reserveSequence(OWNER, AGENT, seq.sequenceId, quota);
        now += MINUTE;
      }
      // ...and the cap still bites once the quota-bound rows themselves fill it.
      const third = await seed(store, "y9", "rotate");
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT, third.sequenceId, quota),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.reason === "quota-exhausted",
      );
      await store.close();
    });

    it("PHASE3.7 F2 (REVIEW M7): quotaUsage.used agrees with the gate about exempt rows", async () => {
      // The A3 class: the dashboard reporting `exhausted` while the gate
      // admits. `liveCount` must count what the gate counts.
      let now = START;
      const store = await factory.make(() => now);
      const quota = { maxExitSequencesPerDay: 1, minMinutesBetweenExits: 0 };
      const exempt = await seed(store, "e1", "protect");
      await store.reserveSequence(OWNER, AGENT, exempt.sequenceId, quota);
      now += MINUTE;

      assert.equal(
        (await store.quotaUsage(OWNER, AGENT)).liveCount,
        0,
        "an exempt reservation is not USED quota, so the owner's view must not say it is",
      );

      // And the gate agrees: the single quota slot is still available.
      const bound = await seed(store, "b1", "rotate");
      await store.reserveSequence(OWNER, AGENT, bound.sequenceId, quota);
      assert.equal((await store.quotaUsage(OWNER, AGENT)).liveCount, 1);
      await store.close();
    });

    it("AUDIT A6: the REAL Postgres statements carry the F2 conjuncts", () => {
      // The fake dispatches on the tag comment and never parses SQL, so the
      // cross-implementation tests above cannot see a raw predicate edit. This
      // pin is crude and it is the only mechanism available without a live
      // database. Measured: dropping `and quota_bound` from the real
      // `quotaUsage` statement killed no other test in the suite.
      const source = readFileSync(
        new URL("../src/store/lpSequences.ts", import.meta.url),
        "utf8",
      );
      const statement = (tag: string): string => {
        const at = source.indexOf(`/* ${tag} */`);
        assert.notEqual(at, -1, `statement ${tag} not found`);
        const end = source.indexOf("`", at);
        // FIXREVIEW N4: the first version matched inside SQL comments, so
        // demoting `owner_address = $4` to a `/* … */` left this pin green with
        // the predicate gone. Strip comments before matching, and drop the tag
        // itself so a needle can never match the tag comment.
        return source
          .slice(at + `/* ${tag} */`.length, end)
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/--[^\n]*/g, " ");
      };

      const usage = statement("lpReservations.quotaUsage");
      assert.match(
        usage,
        /released_at is null and quota_bound\) as live_count/,
        "quotaUsage.live_count must count what the GATE counts (F2, review M7)",
      );
      assert.match(
        usage,
        /released_at is null and quota_bound\) as oldest_live_reserved_at/,
      );
      // FIXREVIEW N5: quotaUsage's OWN owner scope was unpinned, and dropping
      // it silently un-scopes the query on real Postgres — `$3` still sets the
      // parameter count, so there is no bind error to notice.
      assert.match(
        usage,
        /where agent_id = \$1 and owner_address = \$2/,
        "quotaUsage must stay owner-scoped like every other query in the file",
      );

      const window = statement("lpReservations.window");
      assert.match(
        window,
        /select reserved_at, released_at, quota_bound/,
        "the window query must SELECT quota_bound or the gate cannot filter on it",
      );
      assert.match(
        window,
        /owner_address = \$4/,
        "F2(3): the window query gained the owner conjunct every sibling had",
      );
    });

    it("FIXREVIEW N1/A7: another OWNER's reservations neither count nor pace", async () => {
      // F2(3) added `owner_address` to the Postgres window query; AUDIT A7
      // added it to the memory gate. Both were uncovered — the fake's own
      // conjunct (`row["owner_address"] === params[3]`) could be deleted with
      // the suite green, which is F2-S6.
      //
      // Agent ids are owner-scoped in practice, so this is defence in depth
      // rather than a live hole; it is also the only assertion that can see
      // three implementations agreeing.
      let now = START;
      const store = await factory.make(() => now);
      const other = getAddress(privateKeyToAccount(`0x${"c3".repeat(32)}`).address);
      const quota = { maxExitSequencesPerDay: 1, minMinutesBetweenExits: 5 };

      const theirs = await seed(store, "o1", "rotate", other);
      await store.reserveSequence(other, AGENT, theirs.sequenceId, quota);
      now += MINUTE;

      // Our single slot must still be free, and their row must not pace us.
      const ours = await seed(store, "m1", "rotate");
      await store.reserveSequence(OWNER, AGENT, ours.sequenceId, quota);
      assert.equal((await store.quotaUsage(OWNER, AGENT)).liveCount, 1);
      assert.equal((await store.quotaUsage(other, AGENT)).liveCount, 1);
      await store.close();
    });

    it("PHASE3.5 M3 survives F2: the SPACING anchor still sees exempt rows", async () => {
      // F2 narrowed the COUNT alone. The pacing floor is about gas cadence,
      // not about which kind spent it, so an exempt row must still push the
      // next quota-bound reservation out.
      let now = START;
      const store = await factory.make(() => now);
      const quota = { maxExitSequencesPerDay: 5, minMinutesBetweenExits: 5 };
      const exempt = await seed(store, "e1", "protect");
      await store.reserveSequence(OWNER, AGENT, exempt.sequenceId, quota);
      now += MINUTE;
      const bound = await seed(store, "b1", "rotate");
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT, bound.sequenceId, quota),
        (error: unknown) =>
          error instanceof LpExitQuotaError && error.reason === "min-interval",
        "the anchor is unfiltered: an exempt row still paces the next one",
      );
      await store.close();
    });

    it("quotaUsage reports the split the enforcement uses", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const a = await seed(store, "p1", "rotate");
      await store.reserveSequence(OWNER, AGENT, a.sequenceId, COUNT_QUOTA);
      now += MINUTE;
      const b = await seed(store, "p2", "harvest");
      await store.reserveSequence(OWNER, AGENT, b.sequenceId, COUNT_QUOTA);
      await store.releaseReservation(OWNER, AGENT, b.sequenceId);

      const usage = await store.quotaUsage(OWNER, AGENT);
      assert.equal(usage.liveCount, 1);
      assert.equal(usage.releasedCount, 1);
      // The spacing anchor is the LATEST of all rows — the released one.
      assert.equal(usage.latestReservedAtMs, START + MINUTE);
      assert.equal(usage.oldestLiveExpiresAtMs, START + 24 * 60 * MINUTE);
      await store.close();
    });

    it("rows outside the 24h window count for nothing", async () => {
      let now = START;
      const store = await factory.make(() => now);
      const a = await seed(store, "p1", "rotate");
      await store.reserveSequence(OWNER, AGENT, a.sequenceId, COUNT_QUOTA);
      now += 25 * 60 * MINUTE;
      const usage = await store.quotaUsage(OWNER, AGENT);
      assert.equal(usage.liveCount, 0);
      assert.equal(usage.latestReservedAtMs, null);
      await store.close();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Decision 4 — the surface that says why automation stopped                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.5 decision 4: the quota view", () => {
  it("reports remaining, exhaustion and the next-eligible time", () => {
    const view = lpQuotaView({
      usage: {
        liveCount: 4,
        releasedCount: 1,
        latestReservedAtMs: START,
        oldestLiveExpiresAtMs: START + 24 * 60 * MINUTE,
      },
      maxExitSequencesPerDay: 4,
      minMinutesBetweenExits: 5,
    });
    assert.equal(view["limit"], 4);
    assert.equal(view["used"], 4);
    assert.equal(view["remaining"], 0);
    assert.equal(view["exhausted"], true);
    assert.equal(view["releasedInWindow"], 1);
    assert.equal(view["nextEligibleAtMs"], START + 5 * MINUTE);
    // The note must say which kinds this limit can and cannot refuse — an
    // owner reading "exhausted" must not conclude their stop-loss is off.
    assert.match(String(view["note"]), /protect, manual exit and open are exempt/iu);
  });

  it("never reports negative headroom", () => {
    const view = lpQuotaView({
      usage: {
        liveCount: 9,
        releasedCount: 0,
        latestReservedAtMs: null,
        oldestLiveExpiresAtMs: null,
      },
      maxExitSequencesPerDay: 4,
      minMinutesBetweenExits: 5,
    });
    assert.equal(view["remaining"], 0);
    assert.equal(view["nextEligibleAtMs"], null);
  });
});
