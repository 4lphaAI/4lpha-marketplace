/**
 * PHASE3.19 — the LADDER's STORAGE, in BOTH backends, plus the raw-SQL pins the
 * fake cannot see.
 *
 * THE A6 WARNING IS WHY HALF OF THIS FILE EXISTS: `test/support/fakeSql.ts`
 * dispatches on each statement's tag comment and NEVER PARSES THE SQL, so a
 * cross-implementation test proves the two AGREE, not that either matches
 * Postgres. Where a raw predicate is load-bearing — the FOUR-LANE SUBTRACTION
 * (item 19/45), the write-once hedge intent (item 46) and the credits' ON
 * CONFLICT guard (R4.1's own mutation) — it is ALSO pinned at the TEXT level,
 * the `test/lpQuotaRelease.test.ts` precedent.
 *
 * ─── WHAT THIS FILE OWES ──────────────────────────────────────────────────
 *
 *  - item 45: a mutation dropping the `recenter` subtraction from EITHER store's
 *    `quotaUsage` must die;
 *  - item 19: the lane FAILS CLOSED at zero when `maxMovesPerDay` is absent;
 *  - R4.1 + D1: exactly one credit row per key however many times it is
 *    replayed, the book EQUAL to the sum of distinct credits, the clamp on the
 *    DELTA (never the running column), and the two backends computing the
 *    IDENTICAL function;
 *  - D3: the credits table is owner- and agent-scoped;
 *  - item 46: the persisted hedge intent is WRITE-ONCE.
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
  LpInventoryAnchorMissingError,
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  clampInventoryDelta,
  type LpExitQuota,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER_OWNER = getAddress("0x2222222222222222222222222222222222222222");
const AGENT_ID = "grid-ladder-agent";
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
  options?: {
    readonly inventoryAnchor?: boolean;
    readonly armGroupId?: string;
    readonly ownerAddress?: `0x${string}`;
  },
): Promise<void> {
  await store.createPosition({
    positionId,
    agentId: AGENT_ID,
    ownerAddress: options?.ownerAddress ?? OWNER,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 2_500,
    tokenId: positionId,
    basisWei: 0n,
    gridLevel: 1,
    gridRole: "buy",
    ...(options?.armGroupId === undefined ? {} : { armGroupId: options.armGroupId }),
    ...(options?.inventoryAnchor === true ? { inventoryAnchor: true } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* Item 19/45 — the FOURTH quota lane                                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 items 19/45: the `recenter` lane, in BOTH backends", () => {
  for (const backend of BACKENDS) {
    it(`${backend.name}: a recenter reserves in its OWN lane and NOT the exit lane`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      const quota: LpExitQuota = {
        maxExitSequencesPerDay: 4,
        minMinutesBetweenExits: 5,
        maxGridFlipsPerDay: 1,
        maxRequotesPerDay: 21,
        maxMovesPerDay: 12,
      };
      // THREE lanes live at once, so the subtraction has something to get wrong.
      for (const [index, kind] of (
        ["rotate", "grid-flip", "grid-requote", "grid-recenter"] as const
      ).entries()) {
        await seed(store, `pos-${index}`);
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: `pos-${index}`,
          kind,
        });
        await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota);
        now += 6 * MINUTE;
      }
      const usage = await store.quotaUsage(OWNER, AGENT_ID);
      // THE MUTATION THIS KILLS: a `recenter` NOT subtracted here counts against
      // the owner's EXIT quota — the lane that pays for rotates, harvests and
      // the protect headroom. R2.10 named it "the easiest defect in this phase"
      // and it stays easiest one lane later.
      assert.equal(usage.liveCount, 1, "only the rotate belongs to the exit lane");
      assert.equal(usage.gridFlipLiveCount, 1);
      assert.equal(usage.requoteLiveCount, 1);
      assert.equal(usage.recenterLiveCount, 1);
    });

    // PHASE3.20 DECLARED EDIT: a `grid-recenter` with no persisted evidence now
    // reserves in the SETTLEMENT lane (C6/R3.3 — NULL counts as settlement at
    // every seam), so the LANE NAME moves while the fail-closed-at-zero property
    // this test exists for is unchanged and still asserted.
    it(`${backend.name}: an ABSENT maxMovesPerDay FAILS CLOSED at zero`, async () => {
      const now = START;
      const store = await backend.make(() => now);
      await seed(store, "pos-closed");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "pos-closed",
        kind: "grid-recenter",
      });
      await assert.rejects(
        store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, {
          maxExitSequencesPerDay: 4,
          minMinutesBetweenExits: 5,
        }),
        (error: unknown) => {
          assert.ok(error instanceof LpExitQuotaError);
          assert.equal(error.reason, "quota-exhausted");
          assert.equal(error.lane, "settlement");
          return true;
        },
      );
    });

    it(`${backend.name}: the recenter lane's own exhaustion names the LADDER, not the flip`, async () => {
      let now = START;
      const store = await backend.make(() => now);
      const quota: LpExitQuota = {
        maxExitSequencesPerDay: 4,
        minMinutesBetweenExits: 5,
        maxGridFlipsPerDay: 12,
        maxMovesPerDay: 1,
      };
      for (const index of [0, 1]) {
        await seed(store, `p-${index}`);
        const sequence = await store.createSequence({
          agentId: AGENT_ID,
          ownerAddress: OWNER,
          positionId: `p-${index}`,
          kind: "grid-recenter",
        });
        if (index === 0) {
          await store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota);
          now += 6 * MINUTE;
          continue;
        }
        await assert.rejects(
          store.reserveSequence(OWNER, AGENT_ID, sequence.sequenceId, quota),
          (error: unknown) => {
            assert.ok(error instanceof LpExitQuotaError);
            // PHASE3.20 DECLARED EDIT, same cause as the test above: the lane a
            // legacy ladder motion charges is now SETTLEMENT and its sentence
            // names that lane, because "the ladder is out of quota" while the
            // drift lane is still open sends an owner to the wrong knob. The
            // property under test — the LADDER's own sentence, never the flip's
            // — is unchanged and still asserted.
            assert.equal(error.lane, "settlement");
            assert.match(error.message, /grid-recenter SETTLEMENT quota is exhausted/u);
            assert.doesNotMatch(error.message, /grid-flip/u);
            return true;
          },
        );
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/* D1 — the delta clamp, as a pure function                                   */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 D1: clampInventoryDelta clamps the DELTA, never the column", () => {
  it("a credit passes through unchanged", () => {
    assert.deepEqual(
      clampInventoryDelta({ baseWei: 5n, costWbnbWei: 50n }, { baseWei: 7n, costWbnbWei: 70n }),
      { baseWei: 7n, costWbnbWei: 70n },
    );
  });

  it("a partial deduction retires cost PROPORTIONALLY, at the book average", () => {
    // Book: 10 base cost 100 ⇒ average 10. Selling 4 retires 40 of cost.
    assert.deepEqual(
      clampInventoryDelta({ baseWei: 10n, costWbnbWei: 100n }, { baseWei: -4n, costWbnbWei: -999n }),
      { baseWei: -4n, costWbnbWei: -40n },
    );
  });

  it("a deduction larger than the book empties it EXACTLY — never `{0, something}`", () => {
    // The state that would divide by zero in the markout gate is unreachable.
    assert.deepEqual(
      clampInventoryDelta({ baseWei: 10n, costWbnbWei: 100n }, { baseWei: -40n, costWbnbWei: -1n }),
      { baseWei: -10n, costWbnbWei: -100n },
    );
    assert.deepEqual(
      clampInventoryDelta({ baseWei: 0n, costWbnbWei: 0n }, { baseWei: -5n, costWbnbWei: -5n }),
      { baseWei: 0n, costWbnbWei: 0n },
    );
  });

  it("D1's worked case: the STORED deltas sum to the column, and to 20 — not 15", () => {
    // D1's own contrast, reproduced. `+10, -15, +20`:
    //   clamp-of-the-SUM  = max(0, 10 - 15 + 20) = 15
    //   clamp of the DELTA at write time         = 10, -10, +20 ⇒ 20
    // The second is what ships, and its property is the one item 49 asserts:
    // BOOK = SUM OF DISTINCT CREDITS, unconditionally, on both backends. A
    // running-COLUMN clamp would break exactly that equality the moment a
    // deduction ever exceeded the book, which is why the clamp is on the delta.
    let book = { baseWei: 0n, costWbnbWei: 0n };
    const stored: bigint[] = [];
    for (const delta of [10n, -15n, 20n]) {
      const clamped = clampInventoryDelta(book, { baseWei: delta, costWbnbWei: delta });
      stored.push(clamped.baseWei);
      book = {
        baseWei: book.baseWei + clamped.baseWei,
        costWbnbWei: book.costWbnbWei + clamped.costWbnbWei,
      };
    }
    assert.deepEqual(stored, [10n, -10n, 20n]);
    assert.equal(book.baseWei, 20n);
    assert.equal(
      book.baseWei,
      stored.reduce((a, b) => a + b, 0n),
      "book must equal the sum of distinct credits",
    );
    // And the clamp-of-the-sum answers something else, which is the whole point.
    assert.notEqual(book.baseWei, 15n);
  });
});

/* -------------------------------------------------------------------------- */
/* R4.1 + D1 + D3 — the append-only credit set                                */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 R4.1: the VWAP book advances at most once per key", () => {
  for (const backend of BACKENDS) {
    it(`${backend.name}: a REPLAYED credit applies NOTHING and reports the STORED deltas`, async () => {
      const now = START;
      const store = await backend.make(() => now);
      await seed(store, "anchor", { inventoryAnchor: true, armGroupId: "grp" });
      const first = await store.applyInventoryCredit(OWNER, AGENT_ID, {
        applicationKey: "key-1",
        positionId: "anchor",
        armGroupId: "grp",
        deltaBaseWei: 100n,
        deltaCostWbnbWei: 1_000n,
      });
      assert.equal(first.applied, true);
      // THE MUTATION THIS KILLS: removing the ON CONFLICT guard (or the
      // inserted-check) makes every resume re-apply the credit, and FINDINGS
      // (aw) makes resume the DEFAULT path — so the book would be wrong in
      // ORDINARY OPERATION and the markout gate reads it.
      for (const _replay of [1, 2, 3]) {
        const again = await store.applyInventoryCredit(OWNER, AGENT_ID, {
          applicationKey: "key-1",
          positionId: "anchor",
          armGroupId: "grp",
          deltaBaseWei: 100n,
          deltaCostWbnbWei: 1_000n,
        });
        assert.equal(again.applied, false);
        assert.equal(again.deltaBaseWei, 100n);
      }
      assert.deepEqual(await store.readInventoryBook(OWNER, AGENT_ID, "anchor"), {
        baseWei: 100n,
        costWbnbWei: 1_000n,
      });
      const credits = await store.sumInventoryCredits(OWNER, AGENT_ID, "anchor");
      assert.equal(credits.count, 1, "exactly one credit row per key");
      assert.equal(credits.baseWei, 100n);
    });

    it(`${backend.name}: replaying TWO keys in EITHER order leaves the same book`, async () => {
      // N16's second failure mode: a SLOT thrashes when a sequence has two
      // book-writing afters and the replay loop walks them in plan order. A SET
      // is order-independent, which is what this asserts.
      const forward = await backend.make(() => START);
      const backward = await backend.make(() => START);
      const writes: readonly {
        readonly key: string;
        readonly baseWei: bigint;
        readonly costWbnbWei: bigint;
      }[] = [
        { key: "S:0", baseWei: 900n, costWbnbWei: 9_000n },
        // Both CREDITS, so the clamp never fires and the only thing this test can
        // measure is the SET's ORDER-INDEPENDENCE — which is exactly N16's property.
        // (A clamped deduction is order-DEPENDENT by construction; pinning that
        // here would test arithmetic rather than the guard.)
        { key: "S:1", baseWei: 250n, costWbnbWei: 2_500n },
      ];
      for (const [store, order] of [
        [forward, writes],
        [backward, [...writes].reverse()],
      ] as const) {
        await seed(store, "anchor", { inventoryAnchor: true, armGroupId: "grp" });
        // Live, then replayed TWICE, in this store's own order.
        for (const pass of [0, 1, 2]) {
          void pass;
          for (const write of order) {
            await store.applyInventoryCredit(OWNER, AGENT_ID, {
              applicationKey: write.key,
              positionId: "anchor",
              armGroupId: "grp",
              deltaBaseWei: write.baseWei,
              deltaCostWbnbWei: write.costWbnbWei,
            });
          }
        }
      }
      const a = await forward.readInventoryBook(OWNER, AGENT_ID, "anchor");
      const b = await backward.readInventoryBook(OWNER, AGENT_ID, "anchor");
      assert.deepEqual(a, b);
      assert.equal((await forward.sumInventoryCredits(OWNER, AGENT_ID, "anchor")).count, 2);
      assert.equal((await backward.sumInventoryCredits(OWNER, AGENT_ID, "anchor")).count, 2);
    });

    it(`${backend.name}: the book EQUALS the sum of distinct credits, clamps included`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "anchor", { inventoryAnchor: true });
      for (const [index, delta] of [10n, -15n, 20n].entries()) {
        await store.applyInventoryCredit(OWNER, AGENT_ID, {
          applicationKey: `k-${index}`,
          positionId: "anchor",
          armGroupId: null,
          deltaBaseWei: delta,
          deltaCostWbnbWei: delta * 10n,
        });
      }
      const book = await store.readInventoryBook(OWNER, AGENT_ID, "anchor");
      const credits = await store.sumInventoryCredits(OWNER, AGENT_ID, "anchor");
      assert.deepEqual(book, { baseWei: credits.baseWei, costWbnbWei: credits.costWbnbWei });
      assert.equal(book?.baseWei, 20n, "the DELTA clamp: 10, then -10 (empties), then +20");
    });

    it(`${backend.name}: a NON-anchor row refuses rather than opening a second book`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "sibling", { armGroupId: "grp" });
      assert.equal(await store.readInventoryBook(OWNER, AGENT_ID, "sibling"), null);
      await assert.rejects(
        store.applyInventoryCredit(OWNER, AGENT_ID, {
          applicationKey: "k",
          positionId: "sibling",
          armGroupId: "grp",
          deltaBaseWei: 1n,
          deltaCostWbnbWei: 1n,
        }),
        (error: unknown) => error instanceof LpInventoryAnchorMissingError,
      );
    });

    it(`${backend.name}: D3 — credits are owner- and agent-scoped`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "anchor", { inventoryAnchor: true });
      await store.applyInventoryCredit(OWNER, AGENT_ID, {
        applicationKey: "k",
        positionId: "anchor",
        armGroupId: null,
        deltaBaseWei: 5n,
        deltaCostWbnbWei: 50n,
      });
      // A cross-tenant read answers "no rows", indistinguishable from empty.
      const foreign = await store.sumInventoryCredits(OTHER_OWNER, AGENT_ID, "anchor");
      assert.equal(foreign.count, 0);
      assert.equal(foreign.baseWei, 0n);
      const wrongAgent = await store.sumInventoryCredits(OWNER, "other-agent", "anchor");
      assert.equal(wrongAgent.count, 0);
    });
  }

  it("D1: BOTH backends compute the IDENTICAL book from the identical writes", async () => {
    const memory = await BACKENDS[0]!.make(() => START);
    const postgres = await BACKENDS[1]!.make(() => START);
    const writes: readonly (readonly [string, bigint, bigint])[] = [
      ["a", 1_000n, 10_000n],
      ["b", -300n, -1n],
      ["c", 250n, 3_000n],
      ["d", -5_000n, -1n],
      ["e", 40n, 400n],
    ];
    for (const store of [memory, postgres]) {
      await seed(store, "anchor", { inventoryAnchor: true });
      for (const pass of [0, 1]) {
        void pass;
        for (const [key, base, cost] of writes) {
          await store.applyInventoryCredit(OWNER, AGENT_ID, {
            applicationKey: key,
            positionId: "anchor",
            armGroupId: null,
            deltaBaseWei: base,
            deltaCostWbnbWei: cost,
          });
        }
      }
    }
    const a = await memory.readInventoryBook(OWNER, AGENT_ID, "anchor");
    const b = await postgres.readInventoryBook(OWNER, AGENT_ID, "anchor");
    assert.deepEqual(a, b, "the two backends must compute the same function (D1)");
    assert.deepEqual(
      await memory.sumInventoryCredits(OWNER, AGENT_ID, "anchor"),
      await postgres.sumInventoryCredits(OWNER, AGENT_ID, "anchor"),
    );
    assert.deepEqual(a, {
      baseWei: (await memory.sumInventoryCredits(OWNER, AGENT_ID, "anchor")).baseWei,
      costWbnbWei: (await memory.sumInventoryCredits(OWNER, AGENT_ID, "anchor")).costWbnbWei,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Item 8/46 — the WRITE-ONCE hedge intent                                    */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19 items 8/46: the persisted hedge intent is WRITE-ONCE", () => {
  for (const backend of BACKENDS) {
    it(`${backend.name}: a second write leaves the FIRST intent in place`, async () => {
      const store = await backend.make(() => START);
      await seed(store, "pos");
      const sequence = await store.createSequence({
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        positionId: "pos",
        kind: "grid-recenter",
      });
      assert.equal(sequence.hedgeDirection, null);
      assert.equal(sequence.hedgeAmountInWei, null);
      const first = await store.setHedgeIntent(OWNER, AGENT_ID, sequence.sequenceId, {
        direction: "token-to-wbnb",
        amountInWei: 777n,
      });
      assert.equal(first.hedgeDirection, "token-to-wbnb");
      assert.equal(first.hedgeAmountInWei, 777n);
      // THE MUTATION THIS KILLS (item 46): an overwrite on resume would rebind a
      // DIFFERENT market swap at a different price — 3.18's B4 in a step that
      // trades.
      const second = await store.setHedgeIntent(OWNER, AGENT_ID, sequence.sequenceId, {
        direction: "wbnb-to-token",
        amountInWei: 999n,
      });
      assert.equal(second.hedgeDirection, "token-to-wbnb");
      assert.equal(second.hedgeAmountInWei, 777n);
      const reread = await store.getSequence(OWNER, AGENT_ID, sequence.sequenceId);
      assert.equal(reread?.hedgeAmountInWei, 777n);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The raw-SQL pins the fake cannot see (the A6 discipline)                    */
/* -------------------------------------------------------------------------- */

describe("PHASE3.19: the store's raw SQL, pinned at the TEXT level", () => {
  const source = readFileSync(
    new URL("../src/store/lpSequences.ts", import.meta.url),
    "utf8",
  );

  it("item 45: the FOURTH lane is subtracted out of the exit lane", () => {
    assert.match(
      source,
      /kind = 'grid-recenter'\) as recenter_live_count/u,
      "the aggregate must exist",
    );
    assert.match(
      source,
      /toCount\(row\?\.live_count\) - gridFlipLiveCount - requoteLiveCount - recenterLiveCount/u,
      "and it must be subtracted, or every ladder motion charges the EXIT quota",
    );
  });

  it("item 32: the FIFTH guarded-DO widening chains AFTER the fourth", () => {
    assert.match(source, /pg_get_constraintdef\(oid\) not like '%grid-recenter%'/u);
    assert.match(
      source,
      /check \(kind in \('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip', 'grid-arm', 'grid-requote', 'grid-recenter'\)\)/u,
    );
    assert.match(
      source,
      /LP_SEQUENCES_REQUOTE_KIND_CHECK_DDL\) await sql\.query\(ddl\);[\s\S]{0,400}?LP_SEQUENCES_RECENTER_KIND_CHECK_DDL/u,
      "the 3.18 block still runs, and this one runs after it",
    );
  });

  it("the additive columns are `add column if not exists`, never a table rebuild", () => {
    for (const column of [
      "inventory_base_wei numeric(78, 0)",
      "inventory_cost_wbnb_wei numeric(78, 0)",
      "hedge_direction text",
      "hedge_amount_in_wei numeric(78, 0)",
    ]) {
      assert.match(
        source,
        new RegExp(
          `add column if not exists ${column.replace(/[()]/gu, "\\$&").replace(/ /gu, "\\s+")}`,
          "u",
        ),
      );
    }
  });

  it("C11: the SELECT lists name the new columns — and the 3.18 tail pins still hold", () => {
    assert.match(source, /row_version, created_at, updated_at, inventory_base_wei, inventory_cost_wbnb_wei/u);
    assert.match(source, /created_at, updated_at, hedge_direction, hedge_amount_in_wei/u);
    // The two shipped 3.18 pins, unmoved — which is WHY the new columns were
    // appended rather than inserted.
    assert.match(source, /arm_group_id, grid_level, grid_role, row_version/u);
    assert.match(
      source,
      /retirement_disposition_started, target_tick_lower, target_tick_upper, created_at/u,
    );
  });

  it("R4.1: the credit insert is ON CONFLICT DO NOTHING and the anchor update is IN-SQL", () => {
    assert.match(source, /insert into lp_inventory_credits[\s\S]{0,400}?on conflict \(application_key\) do nothing/u);
    assert.match(
      source,
      /set inventory_base_wei = inventory_base_wei \+ \$4::numeric/u,
      "the increment must be IN SQL — never a read-modify-write outside the row lock",
    );
    assert.match(
      source,
      /and inventory_base_wei is not null/u,
      "a non-anchor row must match nothing",
    );
    assert.match(source, /row_version = row_version \+ 1/u);
  });

  it("D3: the credits table carries owner_address, agent_id and position_id", () => {
    assert.match(
      source,
      /create table if not exists lp_inventory_credits[\s\S]{0,600}?owner_address text not null[\s\S]{0,200}?agent_id text not null[\s\S]{0,200}?position_id text not null/u,
    );
  });

  it("item 46: the hedge-intent update carries its own null predicate", () => {
    assert.match(
      source,
      /set hedge_direction = \$4[\s\S]{0,300}?and hedge_direction is null and hedge_amount_in_wei is null/u,
      "without the predicate a resume could overwrite the intent that bound the swap",
    );
  });
});
