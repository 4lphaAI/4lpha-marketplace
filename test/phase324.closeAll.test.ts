import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  DECLARED_AMBIGUITY_ABANDON_SEQUENCE_KIND,
  LP_AMBIGUITY_WIND_DOWN_DOOR,
} from "../src/lp/abandonSequence.js";
import { RESOLVABLE_SEQUENCE_KINDS } from "../src/lp/resolveUnknown.js";
import { parseLpExitParams } from "../src/http/lpWire.js";
import type { JournalState } from "../src/store/journal.js";
import type { LpSequenceKind, LpSequenceStep } from "../src/store/lpSequences.js";
import {
  CLOSE_ALL_BALANCE_EXPLANATIONS,
  runCloseAllWorkflow,
  type CloseAllPosition,
  type CloseAllSequence,
  type CloseAllWorkflowDeps,
} from "../scripts/live-grid-close-all.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x55d398326f99059fF775485246999027B3197955");
const WALLET = getAddress("0x1111111111111111111111111111111111111111");

function position(
  positionId: string,
  state: CloseAllPosition["state"] = "open",
): CloseAllPosition {
  return { positionId, state, token0: TOKEN, token1: WBNB };
}

function step(key: string): LpSequenceStep {
  return {
    index: 0,
    kind: "zap-out",
    journalIdempotencyKey: key,
    journalDecisionId: "lp:sequence:0",
  };
}

function sequence(input: {
  readonly sequenceId: string;
  readonly kind: LpSequenceKind;
  readonly state: CloseAllSequence["state"];
  readonly recoveryState: CloseAllSequence["recoveryState"];
  readonly steps?: readonly LpSequenceStep[];
}): CloseAllSequence {
  return { ...input, steps: input.steps ?? [] };
}

function workflowDeps(overrides: Partial<CloseAllWorkflowDeps> = {}): CloseAllWorkflowDeps {
  return {
    previewCount: 0,
    agentId: "agent-1",
    walletAddress: WALLET,
    wbnb: WBNB,
    inlineConvert: true,
    confirm: () => undefined,
    post: async () => ({ status: 200, body: {} }),
    reportPostResult: () => undefined,
    isAgentPaused: async () => true,
    listPositions: async () => [],
    listSequences: async () => [],
    getPosition: async () => null,
    getNonTerminalSequence: async () => null,
    readStepJournalState: async () => null,
    readBalance: async () => 0n,
    log: () => undefined,
    error: () => undefined,
    setExitCode: () => undefined,
    ...overrides,
  };
}

describe("PHASE3.24 close contracts", () => {
  it("C2 normalizes omitted/false inlineConvert to false and accepts signed true", () => {
    assert.deepEqual(parseLpExitParams({ positionId: "p1" }), {
      ok: true,
      value: { positionId: "p1", inlineConvert: false },
    });
    assert.deepEqual(parseLpExitParams({ positionId: "p1", inlineConvert: false }), {
      ok: true,
      value: { positionId: "p1", inlineConvert: false },
    });
    assert.deepEqual(parseLpExitParams({ positionId: "p1", inlineConvert: true }), {
      ok: true,
      value: { positionId: "p1", inlineConvert: true },
    });
    assert.equal(parseLpExitParams({ positionId: "p1", inlineConvert: "true" }).ok, false);
  });

  it("AUDIT A4 derives every ambiguity door from the capabilities that implement it", () => {
    const declaredAmbiguityKinds: ReadonlySet<LpSequenceKind> =
      new Set<LpSequenceKind>([DECLARED_AMBIGUITY_ABANDON_SEQUENCE_KIND]);
    for (const kind of Object.keys(LP_AMBIGUITY_WIND_DOWN_DOOR) as LpSequenceKind[]) {
      const expected = RESOLVABLE_SEQUENCE_KINDS.has(kind)
        ? "resolve-then-abandon"
        : declaredAmbiguityKinds.has(kind)
          ? "declared-ambiguity-abandon"
          : "none";
      assert.equal(LP_AMBIGUITY_WIND_DOWN_DOOR[kind], expected, kind);
    }
  });

  it("AUDIT A2 dispatches pause before the authoritative read and serializes exit posts", async () => {
    const events: string[] = [];
    const closed = new Set<string>();
    const releases = new Map<string, () => void>();
    let paused = false;
    const positions = [position("p1"), position("p2")];
    const run = runCloseAllWorkflow(workflowDeps({
      previewCount: 2,
      confirm: (count) => {
        events.push(`confirm-${count}`);
      },
      isAgentPaused: async () => paused,
      post: async (request) => {
        if (request.kind === "pause") {
          events.push("pause-dispatch");
          paused = true;
          return { status: 200, body: {} };
        }
        events.push(`${request.positionId}-dispatch`);
        return new Promise((resolve) => {
          releases.set(request.positionId, () => {
            events.push(`${request.positionId}-resolve`);
            closed.add(request.positionId);
            resolve({ status: 200, body: {} });
          });
        });
      },
      listPositions: async () => {
        events.push("positions-read");
        return positions;
      },
      listSequences: async () => [],
      getPosition: async (positionId) =>
        position(positionId, closed.has(positionId) ? "closed" : "open"),
    }));

    await nextTurn();
    assert.deepEqual(events, ["confirm-2", "pause-dispatch", "positions-read", "p1-dispatch"]);
    assert.equal(releases.has("p2"), false, "post 2 dispatched before post 1 resolved");
    releases.get("p1")?.();
    await nextTurn();
    assert.deepEqual(events.slice(-2), ["p1-resolve", "p2-dispatch"]);
    releases.get("p2")?.();
    const result = await run;

    assert.deepEqual(events, [
      "confirm-2",
      "pause-dispatch",
      "positions-read",
      "p1-dispatch",
      "p1-resolve",
      "p2-dispatch",
      "p2-resolve",
    ]);
    assert.deepEqual(result.completed, ["p1", "p2"]);
  });

  it("AUDIT A2 refuses missing --yes-live before any POST", async () => {
    let posts = 0;
    await assert.rejects(
      runCloseAllWorkflow(workflowDeps({
        previewCount: 1,
        confirm: () => {
          throw new Error("--yes-live not supplied");
        },
        post: async () => {
          posts += 1;
          return { status: 200, body: {} };
        },
      })),
      /--yes-live not supplied/u,
    );
    assert.equal(posts, 0);
  });

  it("AUDIT A2 stops at the first failed exit and sets a non-zero exit code", async () => {
    const dispatched: string[] = [];
    const exitCodes: number[] = [];
    const positions = [position("p1"), position("p2"), position("p3")];
    const result = await runCloseAllWorkflow(workflowDeps({
      previewCount: 3,
      listPositions: async () => positions,
      listSequences: async () => [],
      post: async (request) => {
        if (request.kind === "pause") return { status: 200, body: {} };
        dispatched.push(request.positionId);
        return { status: request.positionId === "p1" ? 500 : 200, body: {} };
      },
      getPosition: async (positionId) => position(positionId),
      setExitCode: (code) => exitCodes.push(code),
    }));

    assert.deepEqual(dispatched, ["p1"]);
    assert.deepEqual(exitCodes, [1]);
    assert.equal(result.failedAt, "p1");
    assert.deepEqual(result.notCompleted, ["p1", "p2", "p3"]);
  });

  it("AUDIT A2 rerun skips positions the store now reports closed", async () => {
    const dispatched: string[] = [];
    const positions = [position("p1", "closed"), position("p2")];
    const result = await runCloseAllWorkflow(workflowDeps({
      previewCount: 1,
      listPositions: async () => positions,
      listSequences: async () => [],
      post: async (request) => {
        if (request.kind === "exit") dispatched.push(request.positionId);
        return { status: 200, body: {} };
      },
      getPosition: async (positionId) => position(positionId, "closed"),
    }));

    assert.deepEqual(dispatched, ["p2"]);
    assert.deepEqual(result.completed, ["p2"]);
  });

  it("AUDIT A5 bases blocker advice on settled, UNKNOWN, and active journal evidence", async () => {
    const errors: string[] = [];
    const journal = new Map<string, JournalState>([
      ["settled", "COMMITTED"],
      ["unknown", "UNKNOWN"],
    ]);
    await runCloseAllWorkflow(workflowDeps({
      listPositions: async () => [],
      listSequences: async () => [
        sequence({
          sequenceId: "settled-rotate",
          kind: "rotate",
          state: "held",
          recoveryState: "pending-mint",
          steps: [step("settled")],
        }),
        sequence({
          sequenceId: "unknown-harvest",
          kind: "harvest",
          state: "held",
          recoveryState: "pending-increase",
          steps: [step("unknown")],
        }),
        sequence({
          sequenceId: "active-rotate",
          kind: "rotate",
          state: "active",
          recoveryState: "none",
        }),
      ],
      readStepJournalState: async (key) => journal.get(key) ?? null,
      error: (message) => errors.push(message),
    }));

    assert.match(errors[0] ?? "", /existing owner-signed abandon action/u);
    assert.doesNotMatch(errors[0] ?? "", /custody action/u);
    assert.match(errors[1] ?? "", /UNKNOWN journal row.*resolveUnknown/u);
    assert.match(errors[2] ?? "", /worker is mid-cycle.*re-run close --all once it settles/iu);
  });

  it("C5 and AUDIT A3 pin the truthful product and residual-balance sentences verbatim", async () => {
    const logs: string[] = [];
    await runCloseAllWorkflow(workflowDeps({
      listPositions: async () => [position("already-closed", "closed")],
      listSequences: async () => [],
      log: (message) => logs.push(message),
    }));

    assert.ok(logs.includes(
      "Each position runs its own manual-exit saga, serially. Every submitted batch is atomic, but a position may take ONE OR TWO submissions; the command as a whole is not atomic and may partially complete.",
    ));
    assert.ok(logs.some((line) => line.startsWith("Observed base balance ")));
    assert.ok(logs.some((line) => line.startsWith("Observed WBNB balance ")));
    assert.deepEqual(CLOSE_ALL_BALANCE_EXPLANATIONS, [
      "Part B may have converted its per-position conservative minima and nothing more.",
      "This phase performs neither a whole-wallet base sweep nor a wallet-WBNB unwrap.",
      "PHASE 3.26 is the future base-token sweep; it is not built today and deliberately does not touch WBNB. Wallet WBNB needs an owner-performed unwrap or swap today.",
    ]);
    for (const sentence of CLOSE_ALL_BALANCE_EXPLANATIONS) assert.ok(logs.includes(sentence));

    const source = readFileSync(new URL("../scripts/live-grid.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /withdraw all/iu);
  });

  it("C2 migration is guarded and additive", () => {
    const source = readFileSync(new URL("../src/store/lpSequences.ts", import.meta.url), "utf8");
    assert.match(source, /do \$lp_sequences_inline_conversion\$/u);
    assert.match(source, /add column inline_convert boolean/u);
    assert.match(source, /add column inline_residue_base_wei numeric\(78, 0\)/u);
  });
});
