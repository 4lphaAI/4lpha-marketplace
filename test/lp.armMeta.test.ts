import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  MemoryLpSequenceStore,
  PostgresLpSequenceStore,
  parseLpArmMeta,
  type LpArmMeta,
  type LpSequenceStore,
} from "../src/store/lpSequences.js";
import { PostgresLpSettingsStore } from "../src/store/lpSettings.js";
import type { SqlClient, SqlQueryOptions, SqlResult } from "../src/store/sql.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN0 = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN1 = getAddress("0x3333333333333333333333333333333333333333");

const CUSTOM_META: LpArmMeta = {
  action: "lpArm",
  model: "custom",
  range: { source: "explicit", tickLower: -500, tickUpper: 500 },
  selectPool: null,
  selection: null,
  budgetWei: "1000",
};

const SIGMA_META: LpArmMeta = {
  action: "lpArm",
  model: "sigma",
  range: { source: "server-fenced", tickLower: -1000, tickUpper: 1000 },
  selectPool: { by: "volume", window: "24h" },
  selection: {
    rankBy: "volume",
    orderBy: "volume24hUsd",
    window: "24h",
    laneAsOfMs: 1_000,
    source: "pancake",
    total: 1,
    matched: 1,
    returned: 1,
    cap: 500,
    ingestOrder: "tvlUSD",
    rowDropCounts: {},
    survivors: [{
      pool: TOKEN1,
      aprBps: "1000",
      aprSource: "pancake-apr24h",
      tvlUsdE6: "1000000",
      volume24hUsdE6: "2000000",
      rowAsOfMs: 1_000,
    }],
    head: TOKEN1,
    chosen: TOKEN1,
  },
  budgetWei: "2000",
};

async function create(store: LpSequenceStore, positionId: string, armMeta?: LpArmMeta) {
  return store.createPosition({
    positionId,
    agentId: "lp-agent",
    ownerAddress: OWNER,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 2500,
    basisWei: 1000n,
    quoteToken: TOKEN0,
    ...(armMeta === undefined ? {} : { armMeta }),
  });
}

describe("LP arm metadata", () => {
  for (const backend of [
    { name: "memory", make: async () => new MemoryLpSequenceStore(() => 1_000) as LpSequenceStore },
    { name: "postgres(fake)", make: async () => PostgresLpSequenceStore.create(new FakeSqlClient(), () => 1_000) as Promise<LpSequenceStore> },
  ]) {
    it(`${backend.name}: round-trips custom and sigma metadata and keeps non-arm rows null`, async () => {
      const store = await backend.make();
      await create(store, "custom", CUSTOM_META);
      await create(store, "sigma", SIGMA_META);
      await create(store, "legacy");

      assert.deepEqual((await store.getPosition(OWNER, "lp-agent", "custom"))?.armMeta, CUSTOM_META);
      assert.deepEqual((await store.getPosition(OWNER, "lp-agent", "sigma"))?.armMeta, SIGMA_META);
      assert.equal((await store.getPosition(OWNER, "lp-agent", "legacy"))?.armMeta, null);
    });
  }

  it("is total and maps every malformed/domain-invalid value to null", () => {
    const invalid: unknown[] = [
      "{",
      null,
      { $bigint: "invalid" },
      { ...CUSTOM_META, nested: { value: { $bigint: "invalid" } } },
      { ...CUSTOM_META, budgetWei: "0" },
      { ...CUSTOM_META, budgetWei: "-1" },
      { ...CUSTOM_META, range: { ...CUSTOM_META.range, tickLower: -887_273 } },
      { ...CUSTOM_META, range: { ...CUSTOM_META.range, tickUpper: 887_273 } },
      { ...CUSTOM_META, range: { ...CUSTOM_META.range, tickLower: 500, tickUpper: 500 } },
      { ...CUSTOM_META, selectPool: { by: "fee-apr", window: "24h" } },
      { ...SIGMA_META, selectPool: null },
    ];
    for (const value of invalid) {
      assert.doesNotThrow(() => parseLpArmMeta(value));
      assert.equal(parseLpArmMeta(value), null);
    }
  });

  for (const backend of [
    { name: "memory", make: async () => new MemoryLpSequenceStore(() => 1_000) as LpSequenceStore },
    { name: "postgres(fake)", make: async () => PostgresLpSequenceStore.create(new FakeSqlClient(), () => 1_000) as Promise<LpSequenceStore> },
  ]) {
    it(`${backend.name}: malformed persisted metadata reads as null`, async () => {
      const store = await backend.make();
      const malformed = [
        { positionId: "malformed-domain", value: { ...CUSTOM_META, budgetWei: "0" } },
        { positionId: "malformed-bigint", value: { $bigint: "invalid" } },
        {
          positionId: "malformed-bigint-nested",
          value: { ...CUSTOM_META, nested: { value: { $bigint: "invalid" } } },
        },
      ] as const;
      for (const entry of malformed) {
        await store.createPosition({
          positionId: entry.positionId,
          agentId: "lp-agent",
          ownerAddress: OWNER,
          token0: TOKEN0,
          token1: TOKEN1,
          fee: 2500,
          basisWei: 1000n,
          quoteToken: TOKEN0,
          armMeta: entry.value as LpArmMeta,
        });
        assert.equal(
          (await store.getPosition(OWNER, "lp-agent", entry.positionId))?.armMeta,
          null,
          `${backend.name}: ${entry.positionId}`,
        );
      }
      assert.equal(
        (await store.listPositions(OWNER, "lp-agent")).every((position) => position.armMeta === null),
        true,
      );
    });
  }

  it("postgres arm fence admits one synchronized contender and pins the advisory-lock statement", async () => {
    const sql = new FakeSqlClient({ interleaveTransactions: true });
    const sequences = await PostgresLpSequenceStore.create(sql, () => 1_000);
    sql.clearObservedStatementsForTest();

    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstEntered = (): void => undefined;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    let secondEntered = false;

    const arm = (positionId: string, pause: boolean): Promise<boolean> =>
      sequences.withArmFence(OWNER, "lp-agent", async (fence) => {
        if (pause) markFirstEntered();
        else secondEntered = true;
        const positions = await fence.listPositions();
        if (positions.some((position) => position.state !== "closed")) return false;
        if (pause) await firstGate;
        await fence.createPosition({
          positionId,
          agentId: "lp-agent",
          ownerAddress: OWNER,
          token0: TOKEN0,
          token1: TOKEN1,
          fee: 2500,
          basisWei: 1000n,
          quoteToken: TOKEN0,
        });
        return true;
      });

    const first = arm("race-first", true);
    await firstEntered;
    const second = arm("race-second", false);
    for (let turn = 0; turn < 10 && !secondEntered; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    releaseFirst();
    const admitted = await Promise.all([first, second]);

    const normalized = sql.observedStatementsForTest().map((text) => text
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase());
    assert.equal(
      normalized.filter((text) => text === "select pg_advisory_xact_lock(hashtext($1))").length,
      2,
      "both arm transactions must execute the exact advisory-lock statement",
    );
    assert.equal(admitted.filter(Boolean).length, 1, "the arm fence must admit exactly one contender");
    assert.equal((await sequences.listPositions(OWNER, "lp-agent")).length, 1);
  });

  it("postgres arm admission pins idle reads, settings, and position insert to the advisory-lock transaction", async () => {
    const base = new FakeSqlClient();
    const calls: string[] = [];
    const tagged = (lane: "pool" | "tx", text: string): void => {
      const tag = /\/\*\s*([\w.]+)\s*\*\//u.exec(text)?.[1];
      if (tag !== undefined) calls.push(`${lane}:${tag}`);
    };
    const sql: SqlClient = {
      async query<Row>(text: string, params?: readonly unknown[], options?: SqlQueryOptions): Promise<SqlResult<Row>> {
        tagged("pool", text);
        return (base as SqlClient).query<Row>(text, params, options);
      },
      transaction: <T>(work: (tx: SqlClient) => Promise<T>) => base.transaction(async (baseTx) => {
        const tx: SqlClient = {
          async query<Row>(text: string, params?: readonly unknown[], options?: SqlQueryOptions): Promise<SqlResult<Row>> {
            tagged("tx", text);
            return baseTx.query<Row>(text, params, options);
          },
          transaction: (nested) => nested(tx),
          close: async () => undefined,
        };
        return work(tx);
      }),
      close: async () => base.close(),
    };
    const sequences = await PostgresLpSequenceStore.create(sql, () => 1_000);
    const settings = await PostgresLpSettingsStore.create(sql, () => 1_000);
    calls.length = 0;

    await sequences.withArmFence(OWNER, "lp-agent", async (fence) => {
      assert.deepEqual(await fence.listPositions(), []);
      assert.equal(await fence.getAnyNonTerminalSequence(), null);
      await fence.putSettings(settings, {
        agentId: "lp-agent",
        ownerAddress: OWNER,
        params: { autoRotate: true },
        digest: `0x${"11".repeat(32)}`,
      });
      await fence.createPosition({
        positionId: "fenced",
        agentId: "lp-agent",
        ownerAddress: OWNER,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 2500,
        basisWei: 1000n,
        quoteToken: TOKEN0,
      });
    });

    assert.deepEqual(calls, [
      "tx:lpPositions.armFence",
      "tx:lpPositions.list",
      "tx:lpSequences.anyNonTerminalByAgent",
      "tx:lpSettings.put",
      "tx:lpPositions.create",
    ]);
    assert.equal(calls.some((call) => call.startsWith("pool:")), false);
  });
});
