import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getAddress } from "viem";
import { PostgresLpSequenceStore, type LpArmFenceContext } from "../../src/store/lpSequences.js";
import { createPgSqlClient, type SqlClient } from "../../src/store/sql.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN0 = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN1 = getAddress("0x3333333333333333333333333333333333333333");

test("LP H6.1: real PostgreSQL serializes two arm transactions on separate connections", {
  timeout: 120_000,
}, async (t) => {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url.trim() === "") {
    t.skip("DATABASE_URL is not set");
    return;
  }

  const schema = `lp_arm_${randomUUID().replace(/-/gu, "")}`;
  const admin = await createPgSqlClient(url);
  let firstSql: SqlClient | undefined;
  let secondSql: SqlClient | undefined;
  try {
    await admin.query(`create schema "${schema}"`);
    firstSql = await createPgSqlClient(url);
    secondSql = await createPgSqlClient(url);
    await firstSql.query(`set search_path to "${schema}"`);
    await secondSql.query(`set search_path to "${schema}"`);
    const firstStore = await PostgresLpSequenceStore.create(firstSql, () => 1_000);
    const secondStore = await PostgresLpSequenceStore.create(secondSql, () => 1_000);

    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstEntered = (): void => undefined;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    let secondEntered = false;
    const arm = (
      store: PostgresLpSequenceStore,
      positionId: string,
      pause: boolean,
    ): Promise<boolean> => store.withArmFence(OWNER, "lp-agent", async (fence: LpArmFenceContext) => {
      if (pause) markFirstEntered();
      else secondEntered = true;
      if ((await fence.listPositions()).some((position) => position.state !== "closed")) return false;
      if (pause) await firstGate;
      await fence.createPosition({ positionId, agentId: "lp-agent", ownerAddress: OWNER,
        token0: TOKEN0, token1: TOKEN1, fee: 2500, basisWei: 1000n, quoteToken: TOKEN0 });
      return true;
    });

    const first = arm(firstStore, "real-pg-first", true);
    await firstEntered;
    const second = arm(secondStore, "real-pg-second", false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(secondEntered, false, "second connection crossed the held advisory lock");
    releaseFirst();
    const admitted = await Promise.all([first, second]);
    assert.equal(admitted.filter(Boolean).length, 1);
    assert.equal((await firstStore.listPositions(OWNER, "lp-agent")).length, 1);
  } finally {
    await Promise.all([firstSql?.close(), secondSql?.close()].filter((value): value is Promise<void> => value !== undefined));
    await admin.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await admin.close();
  }
});
