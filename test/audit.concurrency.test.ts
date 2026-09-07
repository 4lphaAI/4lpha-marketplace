/**
 * Auditor-written: the duplicate-submit race on the money routes.
 *
 * `journal.begin` returns the existing row when the key is already present —
 * but a state check cannot tell the CREATOR of a still-PENDING row from a
 * racing duplicate that arrived while the creator was mid-submit. If both
 * callers believe they own the row, both submit, and an "idempotent" route has
 * double-spent. The fix under test: `beginWithSpend` reports `created`, only
 * the caller whose insert took may submit, and everyone else gets the stored
 * outcome — even when that outcome is still PENDING.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MemoryExecutionJournal,
  PostgresExecutionJournal,
  type ExecutionJournal,
} from "../src/store/journal.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import {
  AGENT_ID,
  call,
  createHarness,
  safeSecurityPayload,
  tradeBody,
  type Harness,
} from "./support/serverHarness.js";

const OWNER = "0x0000000000000000000000000000000000000001";
const NOW = 1_900_000_000_000;

type Backend = {
  readonly label: string;
  create(): Promise<ExecutionJournal>;
};

const BACKENDS: readonly Backend[] = [
  { label: "memory", create: async () => new MemoryExecutionJournal(() => NOW) },
  {
    label: "postgres(fake sql)",
    create: () => PostgresExecutionJournal.create(new FakeSqlClient(), () => NOW),
  },
];

for (const backend of BACKENDS) {
  describe(`journal (${backend.label}): begin reports who created the row`, () => {
    it("exactly one of two concurrent same-key begins is `created`", async () => {
      const journal = await backend.create();
      const input = {
        idempotencyKey: "race-key",
        agentId: AGENT_ID,
        ownerAddress: OWNER,
        kind: "trade" as const,
        decisionId: "d-race",
        nativeSpendWei: 5n,
      };
      const [a, b] = await Promise.all([
        journal.beginWithSpend(input, NOW - 1),
        journal.beginWithSpend(input, NOW - 1),
      ]);
      assert.equal(
        [a.created, b.created].filter(Boolean).length,
        1,
        "both callers claiming creation is the double-submit bug",
      );
      // Both observe the same single row regardless.
      assert.equal(a.entry.idempotencyKey, b.entry.idempotencyKey);
      assert.equal(a.entry.state, "PENDING");
      await journal.close();
    });
  });
}

/**
 * A harness whose scan gate passes. The Four.Meme read needs no seeding: the
 * fake provider answers it the way the live helper would, sized off the request.
 */
async function tradingHarness(): Promise<Harness> {
  const harness = await createHarness();
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  return harness;
}

describe("trade route: a concurrent duplicate never double-submits", () => {
  it("holds the first submit open; the identical duplicate replays PENDING", async () => {
    const harness = await tradingHarness();
    let release: () => void = () => undefined;
    harness.provider.holdExecution = new Promise((resolve) => {
      release = resolve;
    });

    const body = tradeBody({ decisionId: "dup-1", amountWei: "1000" });
    const first = call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body,
    });
    // Let the first request reach the held submit before firing the duplicate.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.provider.executeCalls.length, 1, "first must be in-flight");

    const second = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body,
    });
    // The duplicate saw an existing (still-PENDING) row: it must NOT submit,
    // and it must say PENDING rather than invent an outcome.
    assert.equal(harness.provider.executeCalls.length, 1, "duplicate submitted");
    assert.equal(second.status, 200);
    const data = second.body["data"] as Record<string, unknown>;
    const meta = second.body["meta"] as Record<string, unknown>;
    assert.equal(data["status"], "PENDING");
    assert.equal(meta["replayed"], true);

    release();
    const done = await first;
    assert.equal(done.status, 200);
    assert.equal(
      (done.body["data"] as Record<string, unknown>)["status"],
      "CONFIRMED",
    );
    assert.equal(harness.provider.executeCalls.length, 1);
  });
});
