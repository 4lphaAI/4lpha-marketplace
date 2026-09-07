/**
 * PHASE3.18 — the requote's STORAGE, in BOTH backends, plus the raw-SQL pins
 * the fake cannot see.
 *
 * THE A6 WARNING IS WHY HALF OF THIS FILE EXISTS (see `lp.gridStores.test.ts`
 * for the full statement): `test/support/fakeSql.ts` dispatches on each
 * statement's tag comment and NEVER PARSES THE SQL, so a cross-implementation
 * test proves the two AGREE, not that either matches Postgres. Where a raw
 * predicate is load-bearing — and the THREE-LANE SUBTRACTION is the one R2.10
 * calls "the easiest defect in this phase" — it is ALSO pinned at the TEXT
 * level, the `test/lpQuotaRelease.test.ts` precedent.
 *
 * Offline: the memory store and the fake SQL client, nothing else.
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
  type LpSequenceStore,
} from "../src/store/lpSequences.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const AGENT_ID = "grid-requote-agent";
const TOKEN0 = getAddress("0x00000000000000000000000000000000000000AA");
const TOKEN1 = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const START = 1_900_000_000_000;
const MINUTE = 60_000;

const BACKENDS: readonly {
  readonly name: string;
  readonly make: (now: () => number) => Promise<LpSequenceStore>;
}[] = [
  { name: "memory", make: async (now) => new MemoryLpSequenceStore(now) },
  {
    name: "postgres(fake)",
    make: async (now) => PostgresLpSequenceStore.create(new FakeSqlClient(), now),
  },
];

async function seed(
  store: LpSequenceStore,
  positionId: string,
  identity?: { gridLevel: 1 | 2; gridRole: "buy" | "sell" },
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
    ...(identity ?? {}),
  });
}

/* -------------------------------------------------------------------------- */
/* R2.6 — the durable identity columns                                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.6: grid_level and grid_role, in BOTH backends", () => {
  for (const backend of BACKENDS) {
    it(`${backend.name}: written at row creation and read back`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "p1", { gridLevel: 2, gridRole: "sell" });
      const row = await store.getPosition(OWNER, AGENT_ID, "p1");
      assert.equal(row?.gridLevel, 2);
      assert.equal(row?.gridRole, "sell");
      await store.close();
    });

    it(`${backend.name}: a row created without them reads NULL on both`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "p2");
      const row = await store.getPosition(OWNER, AGENT_ID, "p2");
      assert.equal(row?.gridLevel, null);
      assert.equal(row?.gridRole, null);
      await store.close();
    });

    it(`${backend.name}: the flip's tokenId write INVERTS the role atomically`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "p3", { gridLevel: 1, gridRole: "buy" });
      const updated = await store.updatePositionTokenId(
        OWNER,
        AGENT_ID,
        "p3",
        "999",
        undefined,
        "sell",
      );
      assert.equal(updated.tokenId, "999");
      assert.equal(updated.gridRole, "sell");
      assert.equal(updated.gridLevel, 1, "the LEVEL never moves — only the role inverts");
      await store.close();
    });

    it(`${backend.name}: an OMITTED role leaves the column exactly as it was`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "p4", { gridLevel: 1, gridRole: "buy" });
      // This is the requote's own write: same side, so no role argument.
      const updated = await store.updatePositionTokenId(OWNER, AGENT_ID, "p4", "1000");
      assert.equal(updated.tokenId, "1000");
      assert.equal(updated.gridRole, "buy");
      await store.close();
    });

    it(`${backend.name}: M7's backfill writes ONLY the two identity columns`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "p5");
      const before = await store.getPosition(OWNER, AGENT_ID, "p5");
      const after = await store.setGridIdentity(OWNER, AGENT_ID, "p5", {
        gridLevel: 2,
        gridRole: "buy",
      });
      assert.equal(after.gridLevel, 2);
      assert.equal(after.gridRole, "buy");
      assert.equal(after.tokenId, before?.tokenId);
      assert.equal(after.basisWei, before?.basisWei);
      assert.equal(after.state, before?.state);
      await store.close();
    });
  }
});

/* -------------------------------------------------------------------------- */
/* R2.3 / C4 — the persisted target                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 R2.3: the requote's target is persisted at CREATE", () => {
  for (const backend of BACKENDS) {
    it(`${backend.name}: written in the create and read back off the row`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "t1");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "t1",
        kind: "grid-requote",
        targetRange: { tickLower: -350, tickUpper: -150 },
      });
      assert.equal(sequence.targetTickLower, -350);
      assert.equal(sequence.targetTickUpper, -150);
      // And it survives the READ path, which is what a resume actually uses.
      const reread = await store.getNonTerminalSequence(OWNER, AGENT_ID, "t1");
      assert.equal(reread?.targetTickLower, -350);
      assert.equal(reread?.targetTickUpper, -150);
      await store.close();
    });

    it(`${backend.name}: every OTHER kind leaves both columns null`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "t2");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "t2",
        kind: "rotate",
      });
      assert.equal(sequence.targetTickLower, null);
      assert.equal(sequence.targetTickUpper, null);
      await store.close();
    });

    it(`${backend.name}: a NEGATIVE lower bound round-trips (the ordinary case)`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "t3");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "t3",
        kind: "grid-requote",
        targetRange: { tickLower: -887_200, tickUpper: -887_000 },
      });
      assert.equal(sequence.targetTickLower, -887_200);
      await store.close();
    });
  }
});

/* -------------------------------------------------------------------------- */
/* C7 — the THIRD quota lane                                                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18 C7: three lanes, and a requote occupies neither other one", () => {
  const quota: LpExitQuota = {
    maxExitSequencesPerDay: 1,
    minMinutesBetweenExits: 0,
    maxGridFlipsPerDay: 1,
    maxRequotesPerDay: 4,
  };

  for (const backend of BACKENDS) {
    it(`${backend.name}: C12(f) — all THREE kinds live at once, each counted once`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      await seed(store, "q1");
      // One of each kind, each reserved and then completed so the next may run.
      for (const kind of ["rotate", "grid-flip", "grid-requote"] as const) {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: "q1",
          kind,
        });
        await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota);
        await store.setSequenceState(OWNER, AGENT_ID, sequence.sequenceId, "completed");
        now += MINUTE;
      }
      const usage = await store.quotaUsage(OWNER, AGENT_ID);
      // THE SUBTRACTION, pinned: without it `liveCount` would be 3 and both the
      // exit lane and the owner's dashboard would be wrong by two.
      assert.equal(usage.liveCount, 1, "the EXIT lane counts the rotate and nothing else");
      assert.equal(usage.gridFlipLiveCount ?? 0, 1);
      assert.equal(usage.requoteLiveCount ?? 0, 1);
      await store.close();
    });

    it(`${backend.name}: the exit lane is untouched by a burst of re-centres`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      await seed(store, "q2");
      for (let index = 0; index < 4; index += 1) {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: "q2",
          kind: "grid-requote",
        });
        await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota);
        await store.setSequenceState(OWNER, AGENT_ID, sequence.sequenceId, "completed");
        now += MINUTE;
      }
      // The exit cap is ONE and has been spent by nobody.
      const rotate = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "q2",
        kind: "rotate",
      });
      await store.reserveSequence(OWNER, AGENT_ID, rotate.sequenceId, quota);
      await store.close();
    });

    it(`${backend.name}: the FLIP lane is untouched by a burst of re-centres`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      await seed(store, "q3");
      for (let index = 0; index < 4; index += 1) {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: "q3",
          kind: "grid-requote",
        });
        await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota);
        await store.setSequenceState(OWNER, AGENT_ID, sequence.sequenceId, "completed");
        now += MINUTE;
      }
      // A flip settles a fill that already happened; a re-centre must never be
      // able to starve it. That is the SAFETY argument ruling Q6 decided on.
      const flip = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "q3",
        kind: "grid-flip",
      });
      await store.reserveSequence(OWNER, AGENT_ID, flip.sequenceId, quota);
      await store.close();
    });

    it(`${backend.name}: the REQUOTE lane refuses on its own count, in its own words`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      await seed(store, "q4");
      const tight: LpExitQuota = { ...quota, maxRequotesPerDay: 1 };
      for (const attempt of [0, 1]) {
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: "q4",
          kind: "grid-requote",
        });
        if (attempt === 0) {
          await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, tight);
          await store.setSequenceState(OWNER, AGENT_ID, sequence.sequenceId, "completed");
          now += MINUTE;
          continue;
        }
        await assert.rejects(
          store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, tight),
          (error: unknown) => {
            assert.ok(error instanceof LpExitQuotaError);
            assert.equal(error.lane, "requote");
            assert.equal(error.reason, "quota-exhausted");
            assert.match(error.message, /grid-requote quota is exhausted/u);
            assert.match(error.message, /flips are unaffected/u);
            return true;
          },
        );
      }
      await store.close();
    });

    it(`${backend.name}: an ABSENT maxRequotesPerDay fails CLOSED at zero`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "q5");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "q5",
        kind: "grid-requote",
      });
      // A fixed-mode grid supplies no limit; the store must refuse rather than
      // default to a number nobody signed.
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, {
          maxExitSequencesPerDay: 4,
          minMinutesBetweenExits: 0,
          maxGridFlipsPerDay: 12,
        }),
        (error: unknown) => error instanceof LpExitQuotaError,
      );
      await store.close();
    });

    it(`${backend.name}: the spacing anchor STILL sees a requote reservation`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      await seed(store, "q6");
      const spaced: LpExitQuota = { ...quota, minMinutesBetweenExits: 30 };
      const first = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "q6",
        kind: "grid-requote",
      });
      await store.reserveSequence(OWNER, AGENT_ID, first.sequenceId, spaced);
      await store.setSequenceState(OWNER, AGENT_ID, first.sequenceId, "completed");
      now += MINUTE;
      // A FLIP, one minute later: refused by the agent-wide, UNFILTERED spacing
      // gate. Lane isolation is about the daily COUNT, never about pacing.
      const flip = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "q6",
        kind: "grid-flip",
      });
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT_ID, flip.sequenceId, spaced),
        (error: unknown) => {
          assert.ok(error instanceof LpExitQuotaError);
          assert.equal(error.reason, "min-interval");
          return true;
        },
      );
      await store.close();
    });
  }

  it("the EXISTING two lane sentences are BYTE-IDENTICAL (the A6 text pin)", () => {
    assert.equal(
      new LpExitQuotaError("quota-exhausted", "grid").message,
      "Rolling 24-hour grid-flip quota is exhausted.",
    );
    assert.equal(
      new LpExitQuotaError("quota-exhausted", "exit").message,
      "Rolling 24-hour LP exit-sequence quota is exhausted.",
    );
    assert.equal(
      new LpExitQuotaError("min-interval").message,
      "Minimum interval between LP exit sequences has not elapsed.",
    );
    assert.equal(
      new LpExitQuotaError("min-interval", "grid").message,
      "Minimum interval between LP sequences has not elapsed; the grid's cycle rate is floored by minMinutesBetweenExits.",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The raw-SQL pins the fake cannot see (A6)                                  */
/* -------------------------------------------------------------------------- */

describe("PHASE3.18: the raw statements, pinned at the TEXT level", () => {
  const source = readFileSync(
    new URL("../src/store/lpSequences.ts", import.meta.url),
    "utf8",
  );

  it("the quota aggregate has a THIRD filter and SUBTRACTS it out of the exit lane", () => {
    assert.match(
      source,
      /count\(\*\) filter \(where released_at is null and quota_bound and kind = 'grid-requote'\) as requote_live_count/u,
      "the requote lane needs its own aggregate",
    );
    assert.match(
      source,
      /toCount\(row\?\.live_count\) - gridFlipLiveCount - requoteLiveCount/u,
      "R2.10's 'easiest defect in this phase': an unsubtracted third lane counts against the EXIT quota",
    );
    // The two 3.15 filters are untouched — the A6 text pin those already carry.
    assert.match(
      source,
      /count\(\*\) filter \(where released_at is null and quota_bound\) as live_count/u,
    );
    assert.match(
      source,
      /count\(\*\) filter \(where released_at is null and quota_bound and kind = 'grid-flip'\) as grid_live_count/u,
    );
  });

  it("the FOURTH guarded DO block widens the kind CHECK idempotently", () => {
    assert.match(
      source,
      /kind text not null check \(kind in \('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip', 'grid-arm', 'grid-requote'\)\)/u,
      "a fresh database must get the widened list from create table",
    );
    const block =
      /do \$lp_sequences_requote_kind\$[\s\S]*?\$lp_sequences_requote_kind\$/u.exec(source)?.[0];
    assert.ok(block !== undefined, "the guarded DO block must exist");
    assert.match(block!, /lock table lp_sequences in access exclusive mode/u);
    assert.match(
      block!,
      /pg_get_constraintdef\(oid\) not like '%grid-requote%'/u,
      "the drop is guarded on the constraint LACKING the NEW member",
    );
    assert.match(block!, /add constraint lp_sequences_kind_check[\s\S]*'grid-requote'/u);
    assert.doesNotMatch(block!, /recovery_state/u, "ONE constraint migration, not two");
    // Chained AFTER 3.16's, never instead of it: a database that already ran
    // 3.16 never re-enters that block, so widening its list alone would reach
    // only a fresh database.
    assert.match(
      source,
      /LP_SEQUENCES_ARM_KIND_CHECK_DDL\) await sql\.query\(ddl\);[\s\S]{0,400}?LP_SEQUENCES_REQUOTE_KIND_CHECK_DDL/u,
      "the 3.16 block still runs, and this one runs after it",
    );
  });

  it("the additive columns are `add column if not exists`, never a table rebuild", () => {
    for (const column of [
      "target_tick_lower int",
      "target_tick_upper int",
      "grid_level int",
      "grid_role text",
    ]) {
      assert.match(
        source,
        new RegExp(`add column if not exists ${column.replace(/ /gu, "\\s+")}`, "u"),
      );
    }
  });

  it("the two column lists name the new columns — no `select *` anywhere", () => {
    assert.match(source, /arm_group_id, grid_level, grid_role, row_version/u);
    assert.match(
      source,
      /retirement_disposition_started, target_tick_lower, target_tick_upper, created_at/u,
    );
  });

  it("the tokenId write sets the role with COALESCE, in ONE statement", () => {
    assert.match(
      source,
      /update lp_positions set token_id = \$5, grid_role = coalesce\(\$7, grid_role\)/u,
      "an omitted role must leave the column alone, and never through a second UPDATE",
    );
  });
});
