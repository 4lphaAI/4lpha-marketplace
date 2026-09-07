/**
 * `lending_guards` — the CAS transitions, the R3.7 claim, the fence, and the
 * 3.14 STATUS-REACHABILITY invariant as a table-driven test
 * (MARKETPLACE-LENDING-AGENT §8.1, R3.3, R3.4, R3.7, L2; REVIEW2 C28).
 *
 * Every behavioural test runs against BOTH backends — the memory store and the
 * PostgreSQL store over `FakeSqlClient` — because a memory twin that disagrees
 * with the SQL is how a durable deployment behaves differently from every test
 * that proved it correct.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";

import { FakeSqlClient } from "./support/fakeSql.js";
import {
  LENDING_GUARD_CAS_SOURCES,
  LENDING_GUARD_TRANSITIONS,
  LENDING_HOLD_EXITS,
  LENDING_LOCK_CLASSID,
  MemoryLendingGuardStore,
  PostgresLendingGuardStore,
  lendingCasStatusIn,
  type LendingGuardCasMethod,
  type LendingGuardRecord,
  type LendingGuardStore,
} from "../src/store/lendingGuards.js";
import {
  LENDING_GUARD_STATUSES,
  LENDING_HOLDS,
  LENDING_TERMINAL_STATUSES,
} from "../src/lending/types.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const AGENT = "lending-agent-1";
const GUARDED = getAddress("0x00000000000000000000000000000000000000a9");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const V_USDT = getAddress("0xfD5840Cd36d94D7229439859C0112a4185BC0255");
const E18 = 10n ** 18n;

type Backend = { readonly name: string; make(now: () => number): Promise<LendingGuardStore> };

const BACKENDS: readonly Backend[] = [
  { name: "memory", async make(now) { return new MemoryLendingGuardStore(now); } },
  {
    name: "postgres(fake)",
    async make(now) { return PostgresLendingGuardStore.create(new FakeSqlClient(), now); },
  },
];

async function seeded(store: LendingGuardStore) {
  const created = await store.putInitialIfAbsentOrSame({
    agentId: AGENT, ownerAddress: OWNER, guardedAccount: GUARDED,
    reserveToken: USDT, debtMarkets: [V_USDT],
    reserveCapWei: 1_000n * E18, reserveBps: 2_000,
  });
  assert.equal(created.kind, "created");
  return created.kind === "created" ? created.record : (() => { throw new Error("seed"); })();
}

for (const backend of BACKENDS) {
  describe(`lending_guards (${backend.name})`, () => {
    it("materializes the pre-arm row and is idempotent-if-identical", async () => {
      const store = await backend.make(() => 1_000);
      const first = await seeded(store);
      assert.equal(first.status, "provisioning-guard");
      assert.equal(first.guardedAccount, GUARDED);
      assert.equal(first.rowVersion, 1);
      assert.equal(first.actionSeq, 0);
      assert.equal(first.lastActionAtMs, null);

      const again = await store.putInitialIfAbsentOrSame({
        agentId: AGENT, ownerAddress: OWNER, guardedAccount: GUARDED,
        reserveToken: USDT, debtMarkets: [V_USDT],
        reserveCapWei: 1_000n * E18, reserveBps: 2_000,
      });
      assert.equal(again.kind, "same");
      await store.close_();
    });

    it("REFUSES a re-materialization that names a different guarded account", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      const conflict = await store.putInitialIfAbsentOrSame({
        agentId: AGENT, ownerAddress: OWNER, guardedAccount: OTHER,
        reserveToken: USDT, debtMarkets: [V_USDT],
        reserveCapWei: 1_000n * E18, reserveBps: 2_000,
      });
      assert.equal(conflict.kind, "conflict", "guarded_account is IMMUTABLE");
      const row = await store.get(OWNER, AGENT);
      assert.equal(row?.guardedAccount, GUARDED);
      await store.close_();
    });

    it("is owner-scoped: a cross-tenant read answers null", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      assert.equal(await store.get(OTHER, AGENT), null);
      await store.close_();
    });

    it("arms under CAS, and a stale rowVersion CONFLICTS", async () => {
      const store = await backend.make(() => 1_000);
      const row = await seeded(store);
      const armed = await store.armCas({
        ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: row.rowVersion,
        budgetWei: 5n * 10n ** 17n, reserveBps: 2_000,
        supplyNativeWei: 4n * 10n ** 17n, reserveNativeWei: 10n ** 17n,
        mintUsdtWei: 240n * E18, preArmVUsdtWei: 0n, preArmExchangeRate: 2n * 10n ** 26n,
        armJournalKey: `${AGENT}:lending:${AGENT}:arm:1`,
      });
      assert.equal(armed.kind, "ok");
      assert.equal(armed.kind === "ok" ? armed.record.status : "", "arming");
      assert.equal(armed.kind === "ok" ? armed.record.rowVersion : 0, row.rowVersion + 1);

      const stale = await store.armCas({
        ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: row.rowVersion,
        budgetWei: 1n, reserveBps: 2_000, supplyNativeWei: 1n, reserveNativeWei: 0n,
        mintUsdtWei: 1n, preArmVUsdtWei: 0n, preArmExchangeRate: 1n, armJournalKey: "x",
      });
      assert.equal(stale.kind, "conflict");
      await store.close_();
    });

    it("finishes an arm into armed / held / closed, and only from `arming`", async () => {
      const store = await backend.make(() => 1_000);
      const row = await seeded(store);
      const armFrom = async (): Promise<number> => {
        const armed = await store.armCas({
          ownerAddress: OWNER, agentId: AGENT,
          expectedRowVersion: (await store.get(OWNER, AGENT))!.rowVersion,
          budgetWei: 1n, reserveBps: 2_000, supplyNativeWei: 1n, reserveNativeWei: 0n,
          mintUsdtWei: 1n, preArmVUsdtWei: 0n, preArmExchangeRate: 1n, armJournalKey: "k",
        });
        assert.equal(armed.kind, "ok");
        return armed.kind === "ok" ? armed.record.rowVersion : 0;
      };
      void row;

      let version = await armFrom();
      const held = await store.finishArm({
        ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: version,
        outcome: "held", hold: "arm-unknown",
      });
      assert.equal(held.kind === "ok" ? held.record.status : "", "held");
      assert.equal(held.kind === "ok" ? held.record.hold : "", "arm-unknown");

      // `finishArm` only accepts `arming` — a second call CONFLICTS.
      const twice = await store.finishArm({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: held.kind === "ok" ? held.record.rowVersion : 0,
        outcome: "armed", armBlock: null, armTxHash: null,
      });
      assert.equal(twice.kind, "conflict");
      await store.close_();
    });

    it("re-arms from `closed` but NEVER from `retired` (L11 is enforced at the route; the store's source set is the other half)", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      const v0 = (await store.get(OWNER, AGENT))!.rowVersion;
      const armed = await store.armCas({
        ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: v0,
        budgetWei: 1n, reserveBps: 2_000, supplyNativeWei: 1n, reserveNativeWei: 0n,
        mintUsdtWei: 1n, preArmVUsdtWei: 0n, preArmExchangeRate: 1n, armJournalKey: "k",
      });
      const closed = await store.finishArm({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: armed.kind === "ok" ? armed.record.rowVersion : 0,
        outcome: "closed", closeReason: "arm-rolled-back",
      });
      assert.equal(closed.kind === "ok" ? closed.record.status : "", "closed");
      const reArm = await store.armCas({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: closed.kind === "ok" ? closed.record.rowVersion : 0,
        budgetWei: 2n, reserveBps: 2_000, supplyNativeWei: 2n, reserveNativeWei: 0n,
        mintUsdtWei: 2n, preArmVUsdtWei: 0n, preArmExchangeRate: 1n, armJournalKey: "k2",
      });
      assert.equal(reArm.kind, "ok", "a rolled-back arm re-arms; nothing was spent");
      await store.close_();
    });

    it("R3.7 — the claim IS the cooldown AND the sequence number", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      const first = await store.claimAction({
        ownerAddress: OWNER, agentId: AGENT, nowMs: 1_000_000,
        minSecondsBetweenActions: 300,
      });
      assert.equal(first.kind, "claimed");
      assert.equal(first.kind === "claimed" ? first.actionSeq : 0, 1);

      // t = 299 s later: INSIDE the floor. A bucket insert would have let this
      // through (299 s and 301 s fall in different 300 s buckets).
      const early = await store.claimAction({
        ownerAddress: OWNER, agentId: AGENT, nowMs: 1_000_000 + 299_000,
        minSecondsBetweenActions: 300,
      });
      assert.equal(early.kind, "cooldown");

      const late = await store.claimAction({
        ownerAddress: OWNER, agentId: AGENT, nowMs: 1_000_000 + 300_000,
        minSecondsBetweenActions: 300,
      });
      assert.equal(late.kind, "claimed");
      assert.equal(late.kind === "claimed" ? late.actionSeq : 0, 2, "`n` never repeats");
      await store.close_();
    });

    it("two concurrent claims produce ONE claim (the worker-vs-worker case)", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      const [a, b] = await Promise.all([
        store.claimAction({ ownerAddress: OWNER, agentId: AGENT, nowMs: 5_000_000, minSecondsBetweenActions: 300 }),
        store.claimAction({ ownerAddress: OWNER, agentId: AGENT, nowMs: 5_000_000, minSecondsBetweenActions: 300 }),
      ]);
      const claimed = [a, b].filter((entry) => entry.kind === "claimed");
      assert.equal(claimed.length, 1, "one submission per interval, whichever raced");
      await store.close_();
    });

    it("AUDIT C-H1 — a claim can be GIVEN BACK, and the give-back is a CAS on action_seq", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      const first = await store.claimAction({
        ownerAddress: OWNER, agentId: AGENT, nowMs: 1_000_000,
        minSecondsBetweenActions: 300,
      });
      assert.equal(first.kind, "claimed");
      const seq = first.kind === "claimed" ? first.actionSeq : 0;

      // Nothing was submitted: give the stamp back to what it was (never).
      const restored = await store.restoreClaim({
        ownerAddress: OWNER, agentId: AGENT,
        expectedActionSeq: seq, previousLastActionAtMs: null,
      });
      assert.equal(restored.kind, "restored");
      const row = await store.get(OWNER, AGENT);
      assert.equal(row?.lastActionAtMs, null, "the cooldown is not consumed by a refusal");
      assert.equal(row?.actionSeq, seq, "`n` is NEVER rewound — reusing one is a replay");

      // The very next cycle can act: this is the starvation the audit measured.
      const next = await store.claimAction({
        ownerAddress: OWNER, agentId: AGENT, nowMs: 1_000_030,
        minSecondsBetweenActions: 300,
      });
      assert.equal(next.kind, "claimed");
      assert.equal(next.kind === "claimed" ? next.actionSeq : 0, seq + 1);

      // A LATE restore from the first cycle must not undo the second claim.
      const superseded = await store.restoreClaim({
        ownerAddress: OWNER, agentId: AGENT,
        expectedActionSeq: seq, previousLastActionAtMs: null,
      });
      assert.equal(superseded.kind, "superseded");
      assert.equal((await store.get(OWNER, AGENT))?.lastActionAtMs, 1_000_030);
      await store.close_();
    });

    it("AUDIT B-H1 — `retiring` is not a dead end: rolled-back restores, and retire re-enters", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      const toHeld = async (): Promise<void> => {
        const current = (await store.get(OWNER, AGENT))!;
        const armed = await store.armCas({
          ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: current.rowVersion,
          budgetWei: 1n, reserveBps: 2_000, supplyNativeWei: 1n, reserveNativeWei: 0n,
          mintUsdtWei: 1n, preArmVUsdtWei: 0n, preArmExchangeRate: 1n, armJournalKey: "k",
        });
        assert.equal(armed.kind, "ok");
        const finished = await store.finishArm({
          ownerAddress: OWNER, agentId: AGENT,
          expectedRowVersion: armed.kind === "ok" ? armed.record.rowVersion : 0,
          outcome: "held", hold: "arm-unknown",
        });
        assert.equal(finished.kind, "ok");
      };
      await toHeld();

      const began = await store.beginRetire({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: (await store.get(OWNER, AGENT))!.rowVersion,
      });
      assert.equal(began.kind, "ok");
      assert.equal(began.kind === "ok" ? began.record.status : "", "retiring");

      // NOTHING WAS SPENT: the pre-retire status and its hold come back.
      const rolled = await store.finishRetire({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: began.kind === "ok" ? began.record.rowVersion : 0,
        outcome: "rolled-back",
        restore: { status: "held", hold: "arm-unknown" },
      });
      assert.equal(rolled.kind, "ok");
      assert.equal(rolled.kind === "ok" ? rolled.record.status : "", "held");
      assert.equal(rolled.kind === "ok" ? rolled.record.hold : "", "arm-unknown");

      // A partial retire parks at `retiring` — and the gate ACCEPTS it, so
      // "retire again when the pool refills" is a remedy that works.
      const again = await store.beginRetire({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: (await store.get(OWNER, AGENT))!.rowVersion,
      });
      assert.equal(again.kind, "ok");
      const partial = await store.finishRetire({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: again.kind === "ok" ? again.record.rowVersion : 0,
        outcome: "partial",
      });
      assert.equal(partial.kind === "ok" ? partial.record.status : "", "retiring");
      const retry = await store.beginRetire({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: partial.kind === "ok" ? partial.record.rowVersion : 0,
      });
      assert.equal(retry.kind, "ok", "a partial retire can be retried without a new status");

      // And the WORKER sees it, which is what keeps its snapshot alive.
      const scanned = await store.listForWorker();
      assert.deepEqual(scanned.map((entry) => entry.status), ["retiring"]);
      await store.close_();
    });

    it("the fence serializes read -> decide -> claim for one owner+agent", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      const order: string[] = [];
      await Promise.all([
        store.withLendingFence(OWNER, AGENT, async (fence) => {
          order.push("a:in");
          await fence.get();
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push("a:out");
        }),
        store.withLendingFence(OWNER, AGENT, async () => {
          order.push("b:in");
          order.push("b:out");
        }),
      ]);
      assert.deepEqual(order, ["a:in", "a:out", "b:in", "b:out"]);
      await store.close_();
    });

    it("records rescues newest-first, owner-scoped, and idempotent by id", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      for (const [index, id] of ["r1", "r2"].entries()) {
        await store.recordRescue({
          rescueId: id, agentId: AGENT, ownerAddress: OWNER, journalKey: `k${index}`,
          market: V_USDT, amountWei: BigInt(index + 1) * E18,
          hfBefore: null, hfAfter: null, achievedHf: null, txHash: null,
          effect: "changed", partial: false, conditions: ["reserve-low"],
        });
      }
      // A duplicate id is a no-op, not a second row.
      await store.recordRescue({
        rescueId: "r1", agentId: AGENT, ownerAddress: OWNER, journalKey: "k0",
        market: V_USDT, amountWei: 99n, hfBefore: null, hfAfter: null,
        achievedHf: null, txHash: null, effect: "changed", partial: false, conditions: [],
      });
      const rows = await store.listRescues(OWNER, AGENT, 50);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[0]?.conditions, ["reserve-low"]);
      assert.equal((await store.listRescues(OTHER, AGENT, 50)).length, 0);
      await store.close_();
    });

    it("counts ONLY rescue action rows in the 24 h window", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      await store.chargeAction({ ownerAddress: OWNER, agentId: AGENT, actionId: "a1", kind: "arm", chargedAtMs: 10 });
      await store.chargeAction({ ownerAddress: OWNER, agentId: AGENT, actionId: "r1", kind: "rescue", chargedAtMs: 20 });
      await store.chargeAction({ ownerAddress: OWNER, agentId: AGENT, actionId: "r1", kind: "rescue", chargedAtMs: 30 });
      await store.chargeAction({ ownerAddress: OWNER, agentId: AGENT, actionId: "t1", kind: "retire", chargedAtMs: 40 });
      const usage = await store.usageSince(OWNER, AGENT, 0);
      assert.equal(usage.rescues, 1, "the arm and the retire are telemetry, not rescues");
      assert.equal(usage.lastRescueAtMs, 20, "a duplicate id never re-charges");
      await store.close_();
    });

    it("FIXREVIEW F1 — `setHold` records `armBlock` ONE WAY, and only from null", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      const armed = await store.armCas({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: (await store.get(OWNER, AGENT))!.rowVersion,
        budgetWei: 1n, reserveBps: 2_000, supplyNativeWei: 1n, reserveNativeWei: 0n,
        mintUsdtWei: 1n, preArmVUsdtWei: 0n, preArmExchangeRate: 1n, armJournalKey: "k",
      });
      // The `arm-unknown` shape: an arm that never reached `finishArm`'s
      // `armed` branch, so no block was ever recorded.
      const held = await store.finishArm({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: armed.kind === "ok" ? armed.record.rowVersion : 0,
        outcome: "held", hold: "arm-unknown",
      });
      assert.equal(held.kind === "ok" ? held.record.armBlock : 1n, null);

      const cleared = await store.setHold({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: held.kind === "ok" ? held.record.rowVersion : 0,
        hold: null, armBlock: 120_000_000n,
      });
      assert.equal(cleared.kind, "ok");
      assert.equal(cleared.kind === "ok" ? cleared.record.status : "", "armed");
      assert.equal(
        cleared.kind === "ok" ? cleared.record.armBlock : null, 120_000_000n,
        "without this, detectOwnerRecovery can never fire for this guard",
      );

      // A later clear NEVER moves it, and an omitted parameter leaves it alone.
      const heldAgain = await store.setHold({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: cleared.kind === "ok" ? cleared.record.rowVersion : 0,
        hold: "account-too-complex",
      });
      assert.equal(
        heldAgain.kind === "ok" ? heldAgain.record.armBlock : null, 120_000_000n,
        "an omitted armBlock is not a null armBlock",
      );
      const second = await store.setHold({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: heldAgain.kind === "ok" ? heldAgain.record.rowVersion : 0,
        hold: null, armBlock: 130_000_000n,
      });
      assert.equal(
        second.kind === "ok" ? second.record.armBlock : null, 120_000_000n,
        "one way: the older answer is the one that saw the arm land",
      );
      await store.close_();
    });

    it("FIXREVIEW F3 — `lastActionId` reads the charged key back, newest first", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      assert.equal(await store.lastActionId(OWNER, AGENT, "retire"), null);
      await store.chargeAction({
        ownerAddress: OWNER, agentId: AGENT, actionId: `${AGENT}:retire:1`,
        kind: "retire", chargedAtMs: 10,
      });
      await store.chargeAction({
        ownerAddress: OWNER, agentId: AGENT, actionId: `${AGENT}:rescue:1`,
        kind: "rescue", chargedAtMs: 20,
      });
      await store.chargeAction({
        ownerAddress: OWNER, agentId: AGENT, actionId: `${AGENT}:retire:2`,
        kind: "retire", chargedAtMs: 30,
      });
      assert.equal(
        await store.lastActionId(OWNER, AGENT, "retire"), `${AGENT}:retire:2`,
        "the retire the `retire-unknown` hold is about is the latest one",
      );
      assert.equal(await store.lastActionId(OWNER, AGENT, "rescue"), `${AGENT}:rescue:1`);
      assert.equal(
        await store.lastActionId(OTHER, AGENT, "retire"), null,
        "owner-scoped like every other query in this store",
      );
      await store.close_();
    });

    it("stores and serves the view snapshot, owner-scoped", async () => {
      const store = await backend.make(() => 1_000);
      await seeded(store);
      await store.putSnapshot({
        agentId: AGENT, ownerAddress: OWNER, blockNumber: 42n,
        observedAtMs: 7, snapshot: { version: 1, hello: "world" },
      });
      const read = await store.getSnapshot(OWNER, AGENT);
      assert.equal(read?.blockNumber, 42n);
      assert.deepEqual(read?.snapshot, { version: 1, hello: "world" });
      assert.equal(await store.getSnapshot(OTHER, AGENT), null);
      await store.close_();
    });
  });
}

describe("the 3.14 status-reachability invariant (REVIEW2 C28)", () => {
  it("EVERY status the enum carries is a destination of some named surface", () => {
    // The test enumerates the ENUM, not a hand-written list — that is the whole
    // point: a status added without a door is what wedged PHASE3.11's
    // `active`+`none` and PHASE3.14's stable-300 row.
    const destinations = new Map<string, Set<string>>();
    for (const transition of LENDING_GUARD_TRANSITIONS) {
      const set = destinations.get(transition.to) ?? new Set<string>();
      set.add(transition.surface);
      destinations.set(transition.to, set);
    }
    // `provisioning-guard` is written by CONVERGENCE, which is not a transition
    // (it is the row's creation), so it is named explicitly here.
    destinations.set("provisioning-guard", new Set(["convergence"]));

    for (const status of LENDING_GUARD_STATUSES) {
      const surfaces = destinations.get(status);
      assert.ok(
        surfaces !== undefined && surfaces.size > 0,
        `status "${status}" is reachable by no surface — that is the wedge this repo has paid for three times`,
      );
    }
  });

  it("EVERY non-terminal status is also a SOURCE — it has an EXIT (AUDIT B-H1)", () => {
    // The half the original test did not check, and the half the PHASE3.11 and
    // PHASE3.14 wedges were actually made of: `retiring` was a DESTINATION of
    // three surfaces and the SOURCE of nothing a rolled-back retire could
    // reach, so a retire that spent NOTHING parked the guard forever.
    const exits = new Map<string, Set<string>>();
    for (const transition of LENDING_GUARD_TRANSITIONS) {
      const set = exits.get(transition.from) ?? new Set<string>();
      set.add(`${transition.to}/${transition.surface}`);
      exits.set(transition.from, set);
    }
    for (const status of LENDING_GUARD_STATUSES) {
      // Terminal statuses are exempt from the EXIT requirement — but they are
      // not symmetric: `closed` is deliberately re-armable (a never-submitted
      // arm must not cost the owner their hire) while `retired` is a source of
      // nothing, which the L11 test below pins by name.
      if (LENDING_TERMINAL_STATUSES.has(status)) continue;
      const out = exits.get(status);
      assert.ok(
        out !== undefined && out.size > 0,
        `non-terminal status "${status}" has no exit — that is a dead end, and a dead end is the wedge`,
      );
      // An exit to ITSELF is not an exit.
      assert.ok(
        [...out].some((entry) => !entry.startsWith(`${status}/`)),
        `non-terminal status "${status}" only transitions to itself`,
      );
    }
  });

  it("`retiring` exits to armed (rolled back) and to retired (AUDIT B-H1)", () => {
    const from = LENDING_GUARD_TRANSITIONS.filter((t) => t.from === "retiring");
    assert.ok(from.some((t) => t.to === "armed" && t.surface === "retire"),
      "a retire that spent nothing must restore the status it interrupted");
    assert.ok(from.some((t) => t.to === "retired" && t.surface === "worker"),
      "the worker converges an emptied reserve");
    // And the phantom is GONE: no surface closes a retiring row, because
    // `recovered-by-owner` would be a fabricated reason for an observation the
    // row's own retire already explains.
    assert.ok(!from.some((t) => t.to === "closed"),
      "`retiring -> closed` had no surface; a table entry nothing drives is a phantom");
  });

  it("`arming` has a door, and the door is the WORKER", () => {
    const doors = LENDING_GUARD_TRANSITIONS.filter(
      (transition) => transition.from === "arming",
    );
    assert.ok(doors.some((door) => door.surface === "worker"),
      "R3.4: a crash between the fence commit and journal.begin must not brick the guard");
    assert.ok(doors.some((door) => door.to === "closed"));
    assert.ok(doors.some((door) => door.to === "armed"));
    assert.ok(doors.some((door) => door.to === "held"));
  });

  it("`retired` is NEVER a source — renewal is retire + re-hire (L11)", () => {
    assert.ok(
      !LENDING_GUARD_TRANSITIONS.some((transition) => transition.from === "retired"),
      "a re-arm after retire would sum two budgets against one session's caps",
    );
  });

  it("the advisory-lock classid is this store's own, never LP's space", () => {
    assert.equal(LENDING_LOCK_CLASSID, 0x4c454e44);
  });
});

/* -------------------------------------------------------------------------- */
/* FIXREVIEW F4 — the table is DRIVEN, not merely complete                    */
/* -------------------------------------------------------------------------- */

/**
 * Put a seeded row into `status`, using only real store writes.
 *
 * Nothing here reaches into a private map: a status you cannot get to with the
 * store's own methods is a status the table should not be claiming either.
 */
async function drive(
  store: LendingGuardStore,
  status: string,
): Promise<LendingGuardRecord> {
  const row = await seeded(store);
  const v = (result: { kind: string; record: LendingGuardRecord | null }): number => {
    assert.equal(result.kind, "ok", `could not reach ${status}`);
    return result.record!.rowVersion;
  };
  if (status === "provisioning-guard") return row;
  const arming = await store.armCas({
    ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: row.rowVersion,
    budgetWei: E18, reserveBps: 2_000, supplyNativeWei: E18, reserveNativeWei: 0n,
    mintUsdtWei: 1n, preArmVUsdtWei: 0n, preArmExchangeRate: E18, armJournalKey: "k",
  });
  if (status === "arming") return (await store.get(OWNER, AGENT))!;
  if (status === "closed") {
    await store.close({
      ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: v(arming),
      closeReason: "arm-never-submitted",
    });
    return (await store.get(OWNER, AGENT))!;
  }
  const armed = await store.finishArm({
    ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: v(arming),
    outcome: "armed", armBlock: 1n, armBlockSource: "receipt", armTxHash: null,
  });
  if (status === "armed") return (await store.get(OWNER, AGENT))!;
  if (status === "held") {
    await store.setHold({
      ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: v(armed),
      hold: "account-too-complex",
    });
    return (await store.get(OWNER, AGENT))!;
  }
  const retiring = await store.beginRetire({
    ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: v(armed),
  });
  if (status === "retiring") return (await store.get(OWNER, AGENT))!;
  if (status === "retired") {
    await store.finishRetire({
      ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: v(retiring),
      outcome: "retired",
    });
    return (await store.get(OWNER, AGENT))!;
  }
  throw new Error(`no path to ${status}`);
}

/** Invoke one CAS so it produces `to`, on a row already sitting at `from`. */
async function invoke(
  store: LendingGuardStore,
  method: LendingGuardCasMethod,
  to: string,
  row: LendingGuardRecord,
): Promise<{ readonly kind: string; readonly record: LendingGuardRecord | null }> {
  const base = {
    ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: row.rowVersion,
  };
  switch (method) {
    case "armCas":
      return store.armCas({
        ...base, budgetWei: E18, reserveBps: 2_000, supplyNativeWei: E18,
        reserveNativeWei: 0n, mintUsdtWei: 1n, preArmVUsdtWei: 0n,
        preArmExchangeRate: E18, armJournalKey: "k",
      });
    case "finishArm":
      return to === "armed"
        ? store.finishArm({ ...base, outcome: "armed", armBlock: null, armTxHash: null })
        : to === "held"
          ? store.finishArm({ ...base, outcome: "held", hold: "arm-unknown" })
          : store.finishArm({ ...base, outcome: "closed", closeReason: "arm-rolled-back" });
    case "setHold":
      return store.setHold({
        ...base, hold: to === "armed" ? null : "account-too-complex",
      });
    case "beginRetire":
      return store.beginRetire(base);
    case "finishRetire":
      return to === "retired"
        ? store.finishRetire({ ...base, outcome: "retired" })
        : to === "held"
          ? store.finishRetire({ ...base, outcome: "held", hold: "retire-unknown" })
          : to === "armed"
            ? store.finishRetire({
                ...base, outcome: "rolled-back",
                restore: { status: "armed", hold: null },
              })
            : store.finishRetire({ ...base, outcome: "partial" });
    case "close":
      return store.close({ ...base, closeReason: "recovered-by-owner" });
  }
}

for (const backend of BACKENDS) {
  describe(`FIXREVIEW F4 — every declared edge is DRIVEN (${backend.name})`, () => {
    /**
     * The status table was proven COMPLETE (every status a destination, every
     * non-terminal status a source) and one phantom was proven absent. What no
     * test proved was that each REMAINING edge is performed by a real writer —
     * and one was not: `held -> closed / worker` is reachable only as two
     * writes, because `detectOwnerRecovery` requires `status === "armed"`.
     *
     * Each row now names the store method that performs it (`via`), so this
     * test can put a row in `from`, call that method, and assert the row lands
     * in `to`. A row nothing drives fails here, by name.
     */
    for (const transition of LENDING_GUARD_TRANSITIONS) {
      it(`${transition.from} -> ${transition.to} via ${transition.via} (${transition.surface})`,
        async () => {
          const store = await backend.make(() => 1_000);
          const row = await drive(store, transition.from);
          assert.equal(row.status, transition.from);
          const result = await invoke(store, transition.via, transition.to, row);
          assert.equal(
            result.kind, "ok",
            `${transition.via} refused a source the table declares it accepts`,
          );
          assert.equal(
            (await store.get(OWNER, AGENT))!.status, transition.to,
            "the declared destination is where the writer actually leaves it",
          );
          await store.close_();
        });
    }

    /**
     * The other direction, and the one that lets documentation and enforcement
     * drift apart silently: a CAS that accepts a source the table never
     * declared. `close` used to accept five and the table declared two of them.
     */
    it("no CAS accepts a source the table does not declare", async () => {
      for (const method of Object.keys(LENDING_GUARD_CAS_SOURCES) as LendingGuardCasMethod[]) {
        for (const from of LENDING_GUARD_CAS_SOURCES[method]) {
          assert.ok(
            LENDING_GUARD_TRANSITIONS.some(
              (transition) => transition.via === method && transition.from === from,
            ),
            `${method} accepts "${from}", which no transition declares`,
          );
        }
      }
      // And the refusal is REAL, not just documented: `close` on a `retiring`
      // row — the edge P2 deleted from the table — must conflict.
      const store = await backend.make(() => 1_000);
      const retiring = await drive(store, "retiring");
      const refused = await store.close({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: retiring.rowVersion, closeReason: "recovered-by-owner",
      });
      assert.equal(
        refused.kind, "conflict",
        "`retiring -> closed` would report a passkey withdrawal the plane never saw",
      );
      assert.equal((await store.get(OWNER, AGENT))!.status, "retiring");
      await store.close_();
    });
  });
}

describe("FIXREVIEW F4 — the SQL predicate is the derived list, not a copy", () => {
  it("`lendingCasStatusIn` renders exactly the derived sources", () => {
    for (const method of Object.keys(LENDING_GUARD_CAS_SOURCES) as LendingGuardCasMethod[]) {
      assert.equal(
        lendingCasStatusIn(method),
        LENDING_GUARD_CAS_SOURCES[method].map((s) => `'${s}'`).join(","),
        "the PostgreSQL statements interpolate this, so a drifting list is impossible",
      );
    }
    // Spot-checks in DECLARATION order: the sources are derived from
    // `LENDING_GUARD_TRANSITIONS` in the order the table lists them, and
    // `provisioning-guard -> arming` (the first hire) is declared before
    // `closed -> arming` (the re-arm after an abandoned one). A literal written
    // in any other order is asserting against a list that does not exist.
    assert.equal(lendingCasStatusIn("close"), "'arming','armed'");
    assert.equal(lendingCasStatusIn("armCas"), "'provisioning-guard','closed'");
  });

  it("each edge's named SURFACE is a caller of the method that performs it", async () => {
    // The `via` half is proven by execution above. This is the `surface` half:
    // the file the table names must actually call that writer, or the surface
    // attribution is decoration.
    const { readFile } = await import("node:fs/promises");
    const files: Record<string, string> = {
      arm: "src/server.ts",
      retire: "src/server.ts",
      worker: "src/lending/worker.ts",
      convergence: "src/wallet/provisioning.ts",
    };
    const sources = new Map<string, string>();
    for (const [surface, path] of Object.entries(files)) {
      sources.set(surface, await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
    }
    for (const transition of LENDING_GUARD_TRANSITIONS) {
      const text = sources.get(transition.surface);
      assert.ok(
        text !== undefined,
        `surface "${transition.surface}" names no file; add it or drop the edge`,
      );
      assert.match(
        text,
        new RegExp(`\\.${transition.via}\\(`, "u"),
        `${transition.surface} declares ${transition.from} -> ${transition.to} `
        + `but never calls ${transition.via}`,
      );
    }
  });
});

describe("cross-backend parity", () => {
  it("both backends answer identically for the same sequence", async () => {
    const snapshots: unknown[] = [];
    for (const backend of BACKENDS) {
      const store = await backend.make(() => 1_000);
      const row = await seeded(store);
      const armed = await store.armCas({
        ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: row.rowVersion,
        budgetWei: 5n * 10n ** 17n, reserveBps: 2_500,
        supplyNativeWei: 375n * 10n ** 15n, reserveNativeWei: 125n * 10n ** 15n,
        mintUsdtWei: 200n * E18, preArmVUsdtWei: 3n, preArmExchangeRate: 9n,
        armJournalKey: "key",
      });
      const done = await store.finishArm({
        ownerAddress: OWNER, agentId: AGENT,
        expectedRowVersion: armed.kind === "ok" ? armed.record.rowVersion : 0,
        outcome: "armed", armBlock: 12_345n, armTxHash: `0x${"ab".repeat(32)}`,
      });
      const final = done.kind === "ok" ? done.record : null;
      snapshots.push({
        status: final?.status, hold: final?.hold,
        guardedAccount: final?.guardedAccount, debtMarkets: final?.debtMarkets,
        reserveCapWei: final?.reserveCapWei.toString(), reserveBps: final?.reserveBps,
        budgetWei: final?.budgetWei.toString(),
        supplyNativeWei: final?.supplyNativeWei.toString(),
        reserveNativeWei: final?.reserveNativeWei.toString(),
        mintUsdtWei: final?.mintUsdtWei.toString(),
        preArmVUsdtWei: final?.preArmVUsdtWei.toString(),
        preArmExchangeRate: final?.preArmExchangeRate.toString(),
        armBlock: final?.armBlock?.toString(), armTxHash: final?.armTxHash,
        actionSeq: final?.actionSeq, rowVersion: final?.rowVersion,
      });
      await store.close_();
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
  });
});

/** A helper the compiler must be able to see is exhaustive. */
function _statusIsClosed(status: (typeof LENDING_GUARD_STATUSES)[number]): Address | null {
  void status;
  return null;
}
void _statusIsClosed;

describe("FIXREVIEW F3 — the invariant at (status, HOLD) granularity", () => {
  /**
   * P2 strengthened the reachability test to "every non-terminal STATUS has an
   * exit", and that half is now enforced. But no wedge this repo has paid for
   * was ever at status granularity: PHASE3.11's was `active` **+** `none`, a
   * PAIR, and this enum had one — `held` + `retire-unknown`, which the status
   * test walked straight over because `held` exits to `armed` and to `retiring`
   * for the OTHER two holds.
   *
   * So the pairs are enumerated from `LENDING_HOLDS`, not from a hand-written
   * list, and each must name a surface that can LEAVE it.
   */
  it("EVERY hold the enum carries has an exit owned by a named surface", () => {
    for (const hold of LENDING_HOLDS) {
      const exits = LENDING_HOLD_EXITS.filter((exit) => exit.hold === hold);
      assert.ok(
        exits.length > 0,
        `hold "${hold}" has no exit — a (status, hold) dead end is the wedge, and the `
        + "status-granularity test cannot see it",
      );
      for (const exit of exits) {
        assert.ok(exit.to.length > 0, `hold "${hold}" names no destination`);
        assert.ok(
          exit.evidence.length > 0,
          `hold "${hold}" names a surface but no evidence it acts on`,
        );
        // An exit to the pair it started in is not an exit.
        assert.ok(
          !exit.to.includes(exit.status) || exit.to.some((to) => to !== exit.status),
          `hold "${hold}" only transitions to its own status`,
        );
        // And the status half of the pair must be a real edge of the status
        // table, driven by the same surface — the two tables cannot drift.
        for (const to of exit.to) {
          assert.ok(
            LENDING_GUARD_TRANSITIONS.some(
              (transition) =>
                transition.from === exit.status
                && (transition.to === to
                  // `retired` is reached through `retiring`, the way every
                  // `retired` in this store is reached.
                  || (to === "retired" && transition.to === "retiring")),
            ),
            `the (${exit.status}, ${hold}) exit to ${to} is not an edge of the status table`,
          );
        }
      }
    }
  });

  it("`retire-unknown` is the pair the fix review found, and its surface is the WORKER", () => {
    const exit = LENDING_HOLD_EXITS.find((entry) => entry.hold === "retire-unknown");
    assert.ok(exit !== undefined, "the pair that had no exit at all");
    assert.equal(exit.status, "held");
    assert.equal(exit.surface, "worker");
    assert.ok(
      exit.to.includes("armed") && exit.to.includes("retired"),
      "a rolled-back retire spent nothing; a landed one is retired",
    );
    assert.ok(
      LENDING_GUARD_TRANSITIONS.some(
        (transition) =>
          transition.from === "held"
          && transition.to === "retiring"
          && transition.surface === "worker",
      ),
      "and the worker edge it needs is in the status table too",
    );
  });

  it("only `held` carries a hold, so the pair table needs no other status", () => {
    for (const exit of LENDING_HOLD_EXITS) {
      assert.equal(
        exit.status, "held",
        "every store write that sets a hold sets `status = held` in the same statement",
      );
    }
  });
});
