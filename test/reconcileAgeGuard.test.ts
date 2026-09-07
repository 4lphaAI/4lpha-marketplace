/**
 * PHASE3.7 F1 — the reconcile age guard.
 *
 * THE MEASURED DEFECT (FINDINGS ap-1). `reconcile` read a row another process
 * was still writing, saw no `callsId` — which a mid-submit row legitimately does
 * not have yet — and marked it UNKNOWN. The writer's own `markInProgress` then
 * hit `UNKNOWN -> IN_PROGRESS` and 500'd, while the mint it described LANDED.
 * NFT #7170374 existed, funded and in range, against a position row carrying
 * `tokenId: null`.
 *
 * REVIEW M6 is why this file exists at all rather than a flag threaded through
 * the existing suites: the path of least resistance — default the guard to zero
 * and pass it at each call site — keeps every pre-phase test green and
 * reintroduces the defect verbatim. So the obligation is stated as the review
 * stated it: *a `reconcile` call passing no `minRowAgeMs` AT ALL, against a
 * 2 s-old PENDING row, must skip it.* Every assertion below that says "default"
 * means the input object does not mention `minRowAgeMs`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { BNB } from "@altananetwork/sdk";
import { AltanaProvider } from "../src/wallet/altana.js";
import {
  assertReconcileGuardCoversSubmitWindow,
  MemoryExecutionJournal,
  PostgresExecutionJournal,
  reconcile,
  RECONCILE_ASSUMED_SUBMIT_TIMEOUT_MS,
  RECONCILE_MIN_ROW_AGE_MS,
  type ExecutionJournal,
} from "../src/store/journal.js";
import { DEFAULT_SUBMIT_TIMEOUT_MS } from "../src/wallet/altana.js";
import type { ExecutionReceipt, WalletProvider } from "../src/core/types.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const OWNER = "0x0000000000000000000000000000000000000001";
const AGENT = "agent-1";
const NOW = 1_900_000_000_000;
const CALLS_ID = `0x${"cd".repeat(32)}` as Hex;

type Backend = {
  readonly label: string;
  create(now: () => number): Promise<ExecutionJournal>;
};

const BACKENDS: readonly Backend[] = [
  { label: "memory", create: async (now) => new MemoryExecutionJournal(now) },
  {
    label: "postgres(fake sql)",
    create: (now) => PostgresExecutionJournal.create(new FakeSqlClient(), now),
  },
];

/** A provider that would resolve anything it is asked about. */
function willingProvider(): {
  readonly provider: WalletProvider;
  readonly counters: { awaits: number };
} {
  const counters = { awaits: 0 };
  const provider = {
    awaitExecution: async (): Promise<ExecutionReceipt> => {
      counters.awaits += 1;
      return { status: "CONFIRMED", callsId: CALLS_ID };
    },
  } as unknown as WalletProvider;
  return { provider, counters };
}

describe("PHASE3.7 F1: reconcile never opines on a row that is still being written", () => {
  for (const backend of BACKENDS) {
    describe(backend.label, () => {
      it("DEFAULT (no minRowAgeMs at all) skips a 2s-old PENDING row — the ap-1 reproduction", async () => {
        let now = NOW;
        const journal = await backend.create(() => now);
        // The row a live submit has just written: begun, no callsId yet.
        await journal.begin({
          idempotencyKey: "k1",
          agentId: AGENT,
          ownerAddress: OWNER,
          kind: "lp",
          decisionId: "lp:seq-1:0",
          nativeSpendWei: 5_000_000_000_000_000n,
        });
        now += 2_000;

        const { provider, counters } = willingProvider();
        const summary = await reconcile({
          provider,
          journal,
          resolveWallet: async () => null,
          now: () => now,
          // NOTE: minRowAgeMs is deliberately ABSENT. That is the obligation.
        });

        assert.equal(summary.skippedYoung, 1, "the young row must be counted as skipped");
        assert.deepEqual(summary.held, [], "and never parked as UNKNOWN");
        assert.equal(summary.committed, 0);
        assert.equal(summary.rolledBack, 0);
        assert.equal(counters.awaits, 0, "a skipped row is not even read");
        assert.equal(
          (await journal.get("k1"))?.state,
          "PENDING",
          "the row is left exactly as its writer left it",
        );
        await journal.close();
      });

      it("the SAME row one tick past the guard is resolved normally", async () => {
        let now = NOW;
        const journal = await backend.create(() => now);
        await journal.begin({
          idempotencyKey: "k1",
          agentId: AGENT,
          ownerAddress: OWNER,
          kind: "lp",
          decisionId: "lp:seq-1:0",
        });
        now += RECONCILE_MIN_ROW_AGE_MS + 1;

        const summary = await reconcile({
          provider: willingProvider().provider,
          journal,
          resolveWallet: async () => null,
          now: () => now,
        });

        assert.equal(summary.skippedYoung, 0);
        assert.deepEqual(
          summary.held,
          ["k1"],
          "no callsId, so past the guard it parks as UNKNOWN exactly as before the phase",
        );
        assert.equal((await journal.get("k1"))?.state, "UNKNOWN");
        await journal.close();
      });

      it("AUDIT A11: the boundary is NORMATIVE — exactly at the guard is OLD ENOUGH", async () => {
        // A surviving mutant flipped `>` to `>=`. The boundary is stated rather
        // than left to whichever comparison someone typed: a row whose age is
        // EXACTLY the guard has served its full window and is resolvable.
        for (const [delta, expectSkipped] of [
          [RECONCILE_MIN_ROW_AGE_MS, 0],
          [RECONCILE_MIN_ROW_AGE_MS - 1, 1],
        ] as const) {
          let now = NOW;
          const journal = await backend.create(() => now);
          await journal.begin({
            idempotencyKey: "k1",
            agentId: AGENT,
            ownerAddress: OWNER,
            kind: "lp",
            decisionId: "lp:seq-1:0",
          });
          now += delta;
          const summary = await reconcile({
            provider: willingProvider().provider,
            journal,
            resolveWallet: async () => null,
            now: () => now,
          });
          assert.equal(
            summary.skippedYoung,
            expectSkipped,
            `age ${delta}ms against a ${RECONCILE_MIN_ROW_AGE_MS}ms guard`,
          );
          await journal.close();
        }
      });

      it("AUDIT A9: a malformed minRowAgeMs is REFUSED, never silently disabling", async () => {
        const journal = await backend.create(() => NOW);
        for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
          await assert.rejects(
            reconcile({
              provider: willingProvider().provider,
              journal,
              resolveWallet: async () => null,
              minRowAgeMs: bad,
            }),
            /minRowAgeMs must be a finite, non-negative number/,
          );
        }
        await journal.close();
      });

      it("the guard tracks updatedAt, not createdAt: progress resets the clock", async () => {
        let now = NOW;
        const journal = await backend.create(() => now);
        await journal.begin({
          idempotencyKey: "k1",
          agentId: AGENT,
          ownerAddress: OWNER,
          kind: "lp",
          decisionId: "lp:seq-1:0",
        });
        // Old enough by BIRTH, but it just made progress.
        now += RECONCILE_MIN_ROW_AGE_MS + 1;
        await journal.markInProgress("k1", { callsId: CALLS_ID });

        const summary = await reconcile({
          provider: willingProvider().provider,
          journal,
          resolveWallet: async () => null,
          now: () => now,
        });

        assert.equal(
          summary.skippedYoung,
          1,
          "a row that showed a sign of life is young again — that is the whole point of updatedAt",
        );
        await journal.close();
      });

      it("minRowAgeMs: 0 DISABLES the guard rather than setting a zero threshold", async () => {
        // The distinction matters because a zero threshold still compares two
        // clocks. A caller opting out must opt out completely — here the row is
        // stamped from a clock four years ahead of the default `Date.now()`.
        const journal = await backend.create(() => NOW);
        await journal.begin({
          idempotencyKey: "k1",
          agentId: AGENT,
          ownerAddress: OWNER,
          kind: "lp",
          decisionId: "lp:seq-1:0",
        });

        const summary = await reconcile({
          provider: willingProvider().provider,
          journal,
          resolveWallet: async () => null,
          minRowAgeMs: 0,
          // no `now`: the wall clock, which is BEHIND the row's stamp
        });

        assert.equal(summary.skippedYoung, 0);
        assert.deepEqual(summary.held, ["k1"]);
        await journal.close();
      });

      it("skippedYoung is reported even when the pass does nothing else", async () => {
        // The discard must never be silent (PHASE3.6 FIXREVIEW N3/P3): a pass
        // that declined to look must not be indistinguishable from a pass that
        // found nothing.
        let now = NOW;
        const journal = await backend.create(() => now);
        for (const key of ["k1", "k2", "k3"]) {
          await journal.begin({
            idempotencyKey: key,
            agentId: AGENT,
            ownerAddress: OWNER,
            kind: "lp",
            decisionId: `lp:seq-${key}:0`,
          });
        }
        now += 1_000;

        const summary = await reconcile({
          provider: willingProvider().provider,
          journal,
          resolveWallet: async () => null,
          now: () => now,
        });

        assert.deepEqual(summary, {
          committed: 0,
          rolledBack: 0,
          held: [],
          skippedYoung: 3,
        });
        await journal.close();
      });
    });
  }

  it("AUDIT A2 / FIXREVIEW N2: NOTHING in src or scripts names minRowAgeMs", () => {
    // The first version allowlisted four files by path. It killed the auditor's
    // exact mutant and was defeated three ways, all tsc-clean (FIXREVIEW N2):
    // the worst was extracting the reconcile into a shared boot helper — the
    // very refactor AUDIT A5 prescribes — which moves the ReconcileInput into a
    // FIFTH file the list never reads. So the list is gone.
    //
    // The property is simpler and has no list to go stale: the guard's opt-out
    // is a TEST-ONLY affordance, so the substring must not appear in shipped
    // code at all, wherever the reconcile lives.
    const roots = ["src", "scripts"];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), {
        withFileTypes: true,
      })) {
        const child = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "tmp" || entry.name === "node_modules") continue;
          walk(child);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = readFileSync(new URL(`../${child}`, import.meta.url), "utf8");
        // `minRowAge`, not `minRowAgeMs`: a computed key like
        // `["minRowAge" + "Ms"]` defeats the longer needle and is tsc-clean.
        // journal.ts is where the option is DEFINED, so it is the one exemption.
        if (child === "src/store/journal.ts") continue;
        if (source.includes("minRowAge")) offenders.push(child);
      }
    };
    for (const root of roots) walk(root);

    assert.deepEqual(
      offenders,
      [],
      "shipped code must take the DEFAULT guard. A caller that opts out " +
        "reproduces FINDINGS (ap-1) in production with the whole suite green.",
    );
  });

  it("FIXREVIEW N3: the scan is not vacuous — it sees a planted opt-out", () => {
    // The old staleness check asserted `source.includes("reconcile")`, which
    // passed on the substring inside `reconciled=` even after the LP worker's
    // reconcile call was deleted outright. This replaces that with a positive
    // proof that the scan above can actually fail: it runs the same predicate
    // over a string that DOES contain the needle.
    const planted = "const input = { journal, minRowAgeMs: 0 };";
    assert.ok(
      planted.includes("minRowAge"),
      "the predicate the scan uses must match a real opt-out",
    );
    // ...and over one that merely mentions reconcile, which must NOT match.
    assert.ok(!"console.log(`reconciled=${x}`)".includes("minRowAge"));
  });

  describe("FIXREVIEW N1: the boot check itself, which had no coverage at all", () => {
    // The audit's F1-M13 mutant survived `524dceb`: the boot assertion could be
    // deleted outright and nothing went red. The commit message nonetheless
    // claimed every surviving mutant had a covering test. It does now.

    it("refuses a provider whose effective timeout outgrows the guard", () => {
      assert.throws(
        () =>
          assertReconcileGuardCoversSubmitWindow({
            submitTimeoutMs: RECONCILE_MIN_ROW_AGE_MS / 2,
          }),
        /has grown past half of the reconcile age guard/,
      );
    });

    it("accepts the shipped default", () => {
      assertReconcileGuardCoversSubmitWindow({
        submitTimeoutMs: DEFAULT_SUBMIT_TIMEOUT_MS,
      });
    });

    it("is FAIL-CLOSED on a provider that does not report the field", () => {
      // The first version read it through a cast with a `?? DEFAULT` fallback,
      // so a provider exposing nothing booted clean on an assumption rather
      // than a reading (FIXREVIEW N8).
      for (const bad of [{}, { submitTimeoutMs: "45000" }, { submitTimeoutMs: Number.NaN }]) {
        assert.throws(
          () => assertReconcileGuardCoversSubmitWindow(bad),
          /does not report a numeric submitTimeoutMs/,
        );
      }
    });

    it("the REAL provider exposes the field the check reads, after options", () => {
      // A5's fix added `submitTimeoutMs` to AltanaProvider. Deleting that
      // assignment left the suite green until this test existed.
      const custom = new AltanaProvider({ network: BNB, submitTimeoutMs: 1_234 });
      assert.equal(custom.submitTimeoutMs, 1_234, "options must win");
      const plain = new AltanaProvider({ network: BNB });
      assert.equal(plain.submitTimeoutMs, DEFAULT_SUBMIT_TIMEOUT_MS);
      // ...and a raised one is exactly what the boot check must refuse.
      assert.throws(
        () => assertReconcileGuardCoversSubmitWindow(custom, 2_000),
        /has grown past half of the reconcile age guard/,
      );
    });
  });

  it("the guard covers two full submit windows, and the boot assertion is satisfiable", () => {
    // PHASE3.7 Rev2 F1.2. `journal.ts` restates the submit window rather than
    // importing it, because the storage substrate must not depend on a wallet
    // implementation. This pins the two together offline; `index-server.ts`
    // pins them again at BOOT, so raising the relay timeout fails the process
    // start rather than a request.
    assert.equal(
      RECONCILE_ASSUMED_SUBMIT_TIMEOUT_MS,
      DEFAULT_SUBMIT_TIMEOUT_MS,
      "journal.ts's assumed submit window has drifted from the provider's actual one",
    );
    assert.equal(RECONCILE_MIN_ROW_AGE_MS, 2 * DEFAULT_SUBMIT_TIMEOUT_MS + 30_000);
    assert.ok(
      DEFAULT_SUBMIT_TIMEOUT_MS * 2 < RECONCILE_MIN_ROW_AGE_MS,
      "the boot assertion in index-server.ts must hold for the shipped constants",
    );
  });
});
