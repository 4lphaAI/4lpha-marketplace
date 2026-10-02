/**
 * The Auto DCA store's CONTRACT (AUTO-DCA-SPEC §11.1, R2.7, R2.19, R2.21 B1).
 *
 * One suite, two backends. The memory backend always runs. The PostgreSQL
 * backend runs ONLY when `DCA_PG_TEST_DATABASE_URL` names a throwaway database
 * (memory `quant-pg-test-drops-live-tables`): each case runs inside ONE
 * transaction on its own fresh schema and is rolled back at the end, so it
 * never drops or keeps anything. `test/support/fakeSql.ts` is not used: it
 * dispatches on tags and never parses SQL, so it could only prove the two
 * backends agree with each other (the quant store's rule).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";

import {
  DCA_LOCK_CLASSID,
  MemoryDcaRoundStore,
  PostgresDcaRoundStore,
  type DcaOrderRow,
  type DcaRoundInsert,
  type DcaRoundRow,
  type DcaRoundStore,
} from "../src/store/dcaRounds.js";
import { RECONCILE_MIN_ROW_AGE_MS } from "../src/store/journal.js";
import { createPgSqlClient } from "../src/store/sql.js";
import type { DcaBatchPlan } from "../src/trade/dca.js";

const OWNER: Address = getAddress("0x9bb0ab9dcef83f0b39a4be3ebe7a1c9d6d5c1111");
const AGENT = "dca-agent-1";
const T0 = 1_800_000_000_000;

function plan(kind: DcaBatchPlan["kind"], roundNo = 1, orderKey = "1:L1"): DcaBatchPlan {
  return {
    kind, roundNo, readingBlock: 100n, tick: 53_960, sqrtPriceX96: 2n ** 96n, deadlineSec: 1_900_000_120n,
    exits: [], swap: null, feeWei: 0n,
    mints: [{ orderKey, role: "level", levelNo: 1, tickLower: 53_900, tickUpper: 53_950, liquidity: 5n,
      amount0Desired: 0n, amount1Desired: 10n ** 19n, amount0Min: 0n, amount1Min: 10n ** 18n }],
    quoteSpendWei: 10n ** 19n, tpTarget: null,
  };
}

function roundInsert(roundNo: number, phase: "starting" | "active" = "starting"): DcaRoundInsert {
  return {
    agentId: AGENT, ownerAddress: OWNER, roundNo, phase, p0UsdtWei: null, p0StockWei: null,
    costUsdtWei: 0n, stockAcquiredWei: 0n, carriedStockWei: 0n, carriedCostWei: 0n,
    slBaselineWei: 55n * 10n ** 18n, nowMs: T0,
  };
}

function order(key: string, patch: Partial<DcaOrderRow> = {}): DcaOrderRow {
  return {
    agentId: AGENT, roundNo: 1, orderKey: key, role: "level", levelNo: 1, tickLower: 53_900, tickUpper: 53_950,
    tokenId: null, state: "pending", liquidity: 0n, mintedUsdtWei: 0n, mintedStockWei: 0n, collectedUsdtWei: 0n,
    collectedStockWei: 0n, crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: null,
    exitedByAction: null, lastSeenLiveBlock: null, closedBy: null, updatedAtMs: T0, ...patch,
  };
}

async function opened(store: DcaRoundStore): Promise<DcaRoundRow> {
  const round = await store.insertRound(roundInsert(1));
  assert.ok(round);
  return round;
}

type Backend = { readonly name: string; readonly run: (fn: (store: DcaRoundStore) => Promise<void>) => Promise<void>; readonly skip: boolean };

class Rollback extends Error {}

const PG_URL = process.env["DCA_PG_TEST_DATABASE_URL"]?.trim() ?? "";

const BACKENDS: readonly Backend[] = [
  { name: "memory", skip: false, run: async (fn) => fn(new MemoryDcaRoundStore()) },
  {
    name: "postgres (DCA_PG_TEST_DATABASE_URL only)",
    skip: PG_URL === "",
    run: async (fn) => {
      const client = await createPgSqlClient(PG_URL);
      try {
        await client.transaction(async (tx) => {
          const schema = `dca_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
          await tx.query(`create schema ${schema}`);
          await tx.query(`set local search_path to ${schema}`);
          await tx.query(`create table trade_settings (agent_id text primary key, owner_address text not null)`);
          await tx.query(`insert into trade_settings values ($1, $2)`, [AGENT, OWNER.toLowerCase()]);
          await fn(await PostgresDcaRoundStore.create(tx));
          throw new Rollback();
        });
      } catch (error) {
        if (!(error instanceof Rollback)) throw error;
      } finally {
        await client.close();
      }
    },
  },
];

for (const backend of BACKENDS) {
  describe(`dcaRounds contract — ${backend.name}`, { skip: backend.skip }, () => {
    it("one open round per agent (§11.1)", () => backend.run(async (store) => {
      const first = await opened(store);
      assert.equal(await store.insertRound(roundInsert(2)), null, "a second open round is refused");
      assert.equal(await store.insertRound(roundInsert(1)), null, "a taken number is refused");
      const settled = await store.writeRound({ ...first, phase: "settled", settledAtMs: T0 + 1, updatedAtMs: T0 + 1 });
      assert.equal(settled?.rowVersion, first.rowVersion + 1);
      assert.equal(await store.writeRound(first), null, "a stale version loses the CAS");
      assert.ok(await store.insertRound(roundInsert(2, "active")));
      assert.equal((await store.getOpenRound(OWNER, AGENT))?.roundNo, 2);
      assert.deepEqual((await store.listRounds(OWNER, AGENT)).map((round) => round.phase), ["settled", "active"]);
    }));

    it("AUTO-DCA R4.3: unsold_stock_wei/unsold_cost_wei/unsold_value_wei are null on insert, round-trip through writeRound, and survive finishAction", () => backend.run(async (store) => {
      const round = await opened(store);
      assert.equal(round.unsoldStockWei, null);
      assert.equal(round.unsoldCostWei, null);
      assert.equal(round.unsoldValueWei, null);
      const written = await store.writeRound({ ...round, phase: "settled", closeCause: "removed", realizedPnlWei: 7n,
        unsoldStockWei: 3n, unsoldCostWei: 2n, unsoldValueWei: 5n, settledAtMs: T0 + 1, updatedAtMs: T0 + 1 });
      assert.ok(written);
      assert.equal(written!.unsoldStockWei, 3n);
      assert.equal(written!.unsoldCostWei, 2n);
      assert.equal(written!.unsoldValueWei, 5n);
      const reread = (await store.listRounds(OWNER, AGENT)).find((row) => row.roundNo === round.roundNo)!;
      assert.equal(reread.unsoldStockWei, 3n);
      assert.equal(reread.unsoldCostWei, 2n);
      assert.equal(reread.unsoldValueWei, 5n);
      // finishAction writes rounds through writeRound, so the fields survive a finish too.
      const claimed = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: written!.roundNo,
        expectedRowVersion: written!.rowVersion, plan: plan("level-place", written!.roundNo), nowMs: T0 + 2 });
      assert.ok(claimed.kind === "claimed");
      await store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["intended"], to: "submitted", nowMs: T0 + 3 });
      await store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["submitted"], to: "committed", nowMs: T0 + 4 });
      const afterClaim = (await store.listRounds(OWNER, AGENT)).find((row) => row.roundNo === written!.roundNo)!;
      const finished = await store.finishAction({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, plan: plan("level-place", written!.roundNo),
        roundWrites: [{ ...afterClaim, unreliable: true, updatedAtMs: T0 + 5 }], roundInserts: [], orders: [], nowMs: T0 + 5 });
      assert.equal(finished.state, "finished");
      const afterFinish = (await store.listRounds(OWNER, AGENT)).find((row) => row.roundNo === written!.roundNo)!;
      assert.equal(afterFinish.unsoldStockWei, 3n);
      assert.equal(afterFinish.unsoldCostWei, 2n);
      assert.equal(afterFinish.unsoldValueWei, 5n);
    }));

    it("the conditional claim: fresh keys, one in flight, `dca_round_changed` on zero rows and no write (R2.7, B1)", () => backend.run(async (store) => {
      const round = await opened(store);
      const claimed = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: round.rowVersion, plan: plan("level-place"), nowMs: T0 });
      assert.equal(claimed.kind, "claimed");
      if (claimed.kind !== "claimed") return;
      assert.equal(claimed.action.actionKey, `dca:${AGENT}:1:1`);
      assert.equal(claimed.action.state, "intended");
      assert.equal(claimed.roundRowVersion, round.rowVersion + 1);
      // A second claim while one is in flight, and a claim on a stale version: both deny, neither writes.
      const busy = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: claimed.roundRowVersion, plan: plan("level-place"), nowMs: T0 + 1 });
      assert.deepEqual(busy, { kind: "dca_round_changed" });
      await store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["intended"], to: "rolled-back", nowMs: T0 + 2 });
      const stale = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: round.rowVersion, plan: plan("level-place"), nowMs: T0 + 3 });
      assert.deepEqual(stale, { kind: "dca_round_changed" });
      assert.equal((await store.listActions(OWNER, AGENT)).length, 1, "no dca_actions row on a denial");
      assert.equal((await store.getOpenRound(OWNER, AGENT))?.rowVersion, claimed.roundRowVersion, "no round change on a denial");
      // The rolled-back action freed the slot; the retry takes a FRESH key.
      const retry = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: claimed.roundRowVersion, plan: plan("level-place"), nowMs: T0 + 4 });
      assert.equal(retry.kind === "claimed" ? retry.action.actionKey : null, `dca:${AGENT}:1:2`);
    }));

    it("`submitted` holds the slot; `unknown` does not (R2.7)", () => backend.run(async (store) => {
      const round = await opened(store);
      const claimed = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: round.rowVersion, plan: plan("level-place"), nowMs: T0 });
      assert.equal(claimed.kind, "claimed");
      if (claimed.kind !== "claimed") return;
      const key = claimed.action.actionKey;
      const submitted = await store.setActionState({ ownerAddress: OWNER, actionKey: key, from: ["intended"], to: "submitted", txHash: null, note: "sent", nowMs: T0 + 1 });
      assert.equal(submitted?.note, "sent");
      assert.equal((await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: claimed.roundRowVersion, plan: plan("stop-loss"), nowMs: T0 + 2 })).kind, "dca_round_changed");
      assert.equal(await store.setActionState({ ownerAddress: OWNER, actionKey: key, from: ["intended"], to: "rolled-back", nowMs: T0 + 3 }), null, "the CAS names its source states");
      await store.setActionState({ ownerAddress: OWNER, actionKey: key, from: ["submitted"], to: "unknown", nowMs: T0 + 4 });
      assert.equal((await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: claimed.roundRowVersion, plan: plan("stop-loss"), nowMs: T0 + 5 })).kind, "claimed", "a sweep can run past an UNKNOWN");
    }));

    it("a rollback undoes the action's order marks (§5.7)", () => backend.run(async (store) => {
      const round = await opened(store);
      const claimed = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: round.rowVersion, plan: plan("fill"), nowMs: T0 });
      assert.equal(claimed.kind, "claimed");
      if (claimed.kind !== "claimed") return;
      const key = claimed.action.actionKey;
      await store.putOrder(order("1:L2", { levelNo: 2, state: "minting", createdByAction: key }));
      await store.putOrder(order("1:T2", { role: "tp", levelNo: null, state: "minting", createdByAction: key }));
      await store.putOrder(order("1:T1", { role: "tp", levelNo: null, state: "exiting", tokenId: 11n, liquidity: 9n, exitedByAction: key }));
      await store.putOrder(order("1:L1", { state: "exited", tokenId: 12n, exitedByAction: "someone-else" }));
      await store.setActionState({ ownerAddress: OWNER, actionKey: key, from: ["intended", "submitted"], to: "rolled-back", nowMs: T0 + 1 });
      const orders = new Map((await store.listOrders(AGENT, 1)).map((row) => [row.orderKey, row]));
      assert.equal(orders.get("1:L2")?.state, "pending");
      assert.equal(orders.get("1:L2")?.createdByAction, null);
      assert.equal(orders.has("1:T2"), false, "a minting TP is deleted");
      assert.equal(orders.get("1:T1")?.state, "live");
      assert.equal(orders.get("1:T1")?.exitedByAction, null);
      assert.equal(orders.get("1:L1")?.state, "exited", "another action's rows are untouched");
    }));

    it("the persisted plan wins: a finish handed another plan throws before any write (I4)", () => backend.run(async (store) => {
      const round = await opened(store);
      const claimed = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: round.rowVersion, plan: plan("level-place"), nowMs: T0 });
      assert.equal(claimed.kind, "claimed");
      if (claimed.kind !== "claimed") return;
      const key = claimed.action.actionKey;
      const current = await store.getOpenRound(OWNER, AGENT);
      assert.ok(current);
      const finish = { ownerAddress: OWNER, actionKey: key, roundWrites: [{ ...current, phase: "active" as const, updatedAtMs: T0 + 5 }], roundInserts: [],
        orders: [order("1:L1", { state: "live", tokenId: 21n, liquidity: 5n, mintedUsdtWei: 10n ** 19n, createdByAction: key })], nowMs: T0 + 5 };
      await assert.rejects(() => store.finishAction({ ...finish, plan: plan("level-place") }), /cannot finish/, "an intended action has not been submitted");
      await store.setActionState({ ownerAddress: OWNER, actionKey: key, from: ["intended"], to: "submitted", nowMs: T0 + 1 });
      await store.setActionState({ ownerAddress: OWNER, actionKey: key, from: ["submitted"], to: "committed", nowMs: T0 + 2 });
      await assert.rejects(() => store.finishAction({ ...finish, plan: plan("level-place", 1, "1:L9") }), /persisted plan wins \(I4\)/);
      assert.equal((await store.listOrders(AGENT, 1)).length, 0, "nothing written by the refused finish");
      const done = await store.finishAction({ ...finish, plan: plan("level-place") });
      assert.equal(done.state, "finished");
      assert.equal((await store.getOpenRound(OWNER, AGENT))?.phase, "active");
      assert.equal((await store.listOrders(AGENT, 1))[0]?.tokenId, 21n);
      assert.equal((await store.getAction(OWNER, key))?.plan.mints[0]?.amount1Desired, 10n ** 19n, "bigints survive the plan round trip");
    }));

    it("a close + start finish settles round k and opens round k + 1 in one transaction", () => backend.run(async (store) => {
      const round = await opened(store);
      const claimed = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: round.rowVersion, plan: plan("close-start"), nowMs: T0 });
      if (claimed.kind !== "claimed") return assert.fail(claimed.kind);
      await store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["intended"], to: "submitted", nowMs: T0 + 1 });
      const current = await store.getOpenRound(OWNER, AGENT);
      assert.ok(current);
      await store.finishAction({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, plan: plan("close-start"),
        roundWrites: [{ ...current, phase: "settled", closeCause: "take-profit", realizedPnlWei: 3n, settledAtMs: T0 + 2, updatedAtMs: T0 + 2 }],
        roundInserts: [{ ...roundInsert(2, "active"), p0UsdtWei: 15n, p0StockWei: 1n }], orders: [], nowMs: T0 + 2 });
      assert.deepEqual((await store.listRounds(OWNER, AGENT)).map((row) => [row.roundNo, row.phase, row.realizedPnlWei]), [[1, "settled", 3n], [2, "active", null]]);
    }));

    it("an orphaned `intended` is released at RECONCILE_MIN_ROW_AGE_MS and not before (R2.7)", () => backend.run(async (store) => {
      assert.equal(RECONCILE_MIN_ROW_AGE_MS, 120_000);
      const round = await opened(store);
      const claimed = await store.claimAction({ agentId: AGENT, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: round.rowVersion, plan: plan("level-place"), nowMs: T0 });
      if (claimed.kind !== "claimed") return assert.fail(claimed.kind);
      const key = claimed.action.actionKey;
      assert.equal(await store.releaseOrphan({ ownerAddress: OWNER, actionKey: key, nowMs: T0 + 119_999 }), false);
      assert.equal((await store.getAction(OWNER, key))?.state, "intended");
      assert.equal(await store.releaseOrphan({ ownerAddress: OWNER, actionKey: key, nowMs: T0 + 120_000 }), true);
      assert.equal((await store.getAction(OWNER, key))?.state, "rolled-back");
      assert.equal(await store.releaseOrphan({ ownerAddress: OWNER, actionKey: key, nowMs: T0 + 999_999 }), false, "only `intended` is an orphan");
    }));

    it("reads are owner-scoped", () => backend.run(async (store) => {
      await opened(store);
      const stranger = getAddress("0x00000000000000000000000000000000000000aA");
      assert.equal(await store.getOpenRound(stranger, AGENT), null);
      assert.deepEqual(await store.listActions(stranger, AGENT), []);
    }));
  });
}

describe("dcaRounds — the fence and the static statements", () => {
  it("the memory fence serialises one agent's work", async () => {
    const store = new MemoryDcaRoundStore();
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = store.withDcaFence(OWNER, AGENT, async () => { seen.push("a:start"); await held; seen.push("a:end"); });
    const second = store.withDcaFence(OWNER, AGENT, async () => { seen.push("b"); });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen, ["a:start"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(seen, ["a:start", "a:end", "b"]);
  });

  it("every statement is one static tagged string, and the fence uses the two-argument lock with DCAR", () => {
    const source = readFileSync(new URL("../src/store/dcaRounds.ts", import.meta.url), "utf8");
    const calls = [...source.matchAll(/\.query(?:<Row>)?\(\s*(`[^`]*`|[A-Z_]+)/gu)].map((match) => match[1] ?? "");
    assert.ok(calls.length >= 20);
    for (const text of calls) {
      if (/^[A-Z_]+$/u.test(text)) {
        assert.match(text, /^DCA_[A-Z_]+_DDL$/u);
        continue;
      }
      assert.match(text, /^`\/\* dca(Rounds|Orders|Actions)\.[A-Za-z]+ \*\//u, text.slice(0, 60));
      assert.doesNotMatch(text.replace(/\$\{(ROUND|ORDER|ACTION)_COLUMNS\}/gu, ""), /\$\{/u, "no runtime-built predicate");
    }
    assert.equal(DCA_LOCK_CLASSID, 0x44434152);
    assert.equal(Buffer.from(DCA_LOCK_CLASSID.toString(16), "hex").toString("ascii"), "DCAR");
    assert.match(source, /pg_advisory_xact_lock\(\$1::integer, hashtext\(\$2\)\)/u);
    assert.match(source, /from trade_settings\s+where agent_id = \$1 and owner_address = \$2 for update/u);
  });
});
