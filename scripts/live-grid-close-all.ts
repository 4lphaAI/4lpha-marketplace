import type { Address } from "viem";
import type { JournalState } from "../src/store/journal.js";
import {
  isTerminalLpSequence,
  type LpPositionRecord,
  type LpSequenceRecord,
} from "../src/store/lpSequences.js";
import { LP_AMBIGUITY_WIND_DOWN_DOOR } from "../src/lp/abandonSequence.js";

export type CloseAllPosition = Pick<
  LpPositionRecord,
  "positionId" | "state" | "token0" | "token1"
>;

export type CloseAllSequence = Pick<
  LpSequenceRecord,
  "sequenceId" | "kind" | "state" | "recoveryState" | "steps"
>;

export type CloseAllPost =
  | { readonly kind: "pause" }
  | {
      readonly kind: "exit";
      readonly positionId: string;
      readonly inlineConvert: boolean;
    };

export type CloseAllPostResult = {
  readonly status: number;
  readonly body: unknown;
};

export type CloseAllWorkflowDeps = {
  /** The pre-pause snapshot is count-only and is discarded by this workflow. */
  readonly previewCount: number;
  readonly agentId: string;
  readonly walletAddress: Address;
  readonly wbnb: Address;
  readonly inlineConvert: boolean;
  readonly confirm: (previewCount: number) => void | Promise<void>;
  readonly post: (request: CloseAllPost) => Promise<CloseAllPostResult>;
  readonly reportPostResult: (label: string, result: CloseAllPostResult) => void;
  readonly isAgentPaused: () => Promise<boolean>;
  readonly listPositions: () => Promise<readonly CloseAllPosition[]>;
  readonly listSequences: () => Promise<readonly CloseAllSequence[]>;
  readonly getPosition: (positionId: string) => Promise<CloseAllPosition | null>;
  readonly getNonTerminalSequence: (positionId: string) => Promise<CloseAllSequence | null>;
  readonly readStepJournalState: (idempotencyKey: string) => Promise<JournalState | null>;
  readonly readBalance: (token: Address, walletAddress: Address) => Promise<bigint>;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly setExitCode: (code: number) => void;
};

export type CloseAllWorkflowResult = {
  readonly completed: readonly string[];
  readonly notCompleted: readonly string[];
  readonly failedAt: string | null;
};

const SETTLED_JOURNAL_STATES: ReadonlySet<JournalState> = new Set<JournalState>([
  "COMMITTED",
  "ROLLED_BACK",
]);

/** AUDIT A3: the three mandatory explanations printed after observed balances. */
export const CLOSE_ALL_BALANCE_EXPLANATIONS = [
  "Part B may have converted its per-position conservative minima and nothing more.",
  "This phase performs neither a whole-wallet base sweep nor a wallet-WBNB unwrap.",
  "PHASE 3.26 is the future base-token sweep; it is not built today and deliberately does not touch WBNB. Wallet WBNB needs an owner-performed unwrap or swap today.",
] as const;

async function reportObservedBalances(
  deps: CloseAllWorkflowDeps,
  positions: readonly CloseAllPosition[],
): Promise<void> {
  const baseTokens = new Map<string, Address>();
  for (const position of positions) {
    const base = position.token0.toLowerCase() === deps.wbnb.toLowerCase()
      ? position.token1
      : position.token0;
    baseTokens.set(base.toLowerCase(), base);
  }
  for (const base of baseTokens.values()) {
    const observed = await deps.readBalance(base, deps.walletAddress);
    deps.log(`Observed base balance ${base}: ${observed.toString(10)} wei`);
  }
  const observedWbnb = await deps.readBalance(deps.wbnb, deps.walletAddress);
  deps.log(`Observed WBNB balance ${deps.wbnb}: ${observedWbnb.toString(10)} wei`);
  for (const sentence of CLOSE_ALL_BALANCE_EXPLANATIONS) deps.log(sentence);
}

async function reportBlocker(
  deps: CloseAllWorkflowDeps,
  sequence: CloseAllSequence,
): Promise<void> {
  const states = await Promise.all(
    sequence.steps.map((step) => deps.readStepJournalState(step.journalIdempotencyKey)),
  );
  const allRecordedStepsSettled = states.length > 0
    && states.every((state) => state !== null && SETTLED_JOURNAL_STATES.has(state));
  if (allRecordedStepsSettled) {
    deps.error(
      `BLOCKED: ${sequence.kind} sequence ${sequence.sequenceId} has all recorded steps settled. Use the existing owner-signed abandon action, then re-run close --all.`,
    );
    return;
  }

  const hasUnknown = states.some((state) => state === "UNKNOWN");
  if (!hasUnknown) {
    const detail = sequence.state === "active"
      ? "The worker is mid-cycle"
      : "Its journal work has not settled";
    deps.error(
      `BLOCKED: ${sequence.kind} sequence ${sequence.sequenceId} has no UNKNOWN journal row. ${detail}; re-run close --all once it settles.`,
    );
    return;
  }

  // AUDIT A5: this is an ambiguity table, so consult it only after the row's
  // journal evidence proves an UNKNOWN rather than for every non-terminal row.
  const door = LP_AMBIGUITY_WIND_DOWN_DOOR[sequence.kind];
  if (door === "resolve-then-abandon") {
    deps.error(
      `BLOCKED: ${sequence.kind} sequence ${sequence.sequenceId} has an UNKNOWN journal row. Use the owner-signed resolveUnknown action; after settlement, the existing owner-signed abandon action may be available.`,
    );
    return;
  }
  if (door === "declared-ambiguity-abandon") {
    deps.error(
      `BLOCKED: ${sequence.kind} sequence ${sequence.sequenceId} has an UNKNOWN journal row and the declared-ambiguity owner-signed abandon door.`,
    );
    return;
  }
  const phase = sequence.kind === "grid-flip"
    ? " PHASE 3.25 is the separately reviewed grid-flip ambiguity-door work."
    : "";
  deps.error(
    `BLOCKED: ${sequence.kind} sequence ${sequence.sequenceId} has an UNKNOWN journal row and no in-plane ambiguity door. Manually inspect the position and any NFT it may have minted before taking custody action.${phase}`,
  );
}

/**
 * PHASE3.24 C4 / AUDIT A2 — pause-first, authoritative-refresh, serial client.
 *
 * Every side effect is a collaborator so tests can prove dispatch order and
 * stop-at-first-failure without importing the live script or touching a chain.
 */
export async function runCloseAllWorkflow(
  deps: CloseAllWorkflowDeps,
): Promise<CloseAllWorkflowResult> {
  await deps.confirm(deps.previewCount);

  deps.log(
    "Each position runs its own manual-exit saga, serially. Every submitted batch is atomic, but a position may take ONE OR TWO submissions; the command as a whole is not atomic and may partially complete.",
  );
  deps.log(
    "This addresses the two-submission exposure and ambiguity window observed live on 2026-08-30.",
  );

  if (!(await deps.isAgentPaused())) {
    const pause = await deps.post({ kind: "pause" });
    if (pause.status !== 200) {
      deps.reportPostResult(`POST /agents/${deps.agentId}/pause (${pause.status})`, pause);
      throw new Error("The owner-signed pause did not complete; no position exit started.");
    }
  }
  if (!(await deps.isAgentPaused())) {
    throw new Error("Pause could not be confirmed; no position exit started.");
  }

  const positions = await deps.listPositions();
  const sequences = await deps.listSequences();
  const blocking = sequences.filter(
    (sequence) => !isTerminalLpSequence(sequence.state, sequence.recoveryState),
  );
  if (blocking.length > 0) {
    for (const sequence of blocking) await reportBlocker(deps, sequence);
    await reportObservedBalances(deps, positions);
    deps.setExitCode(1);
    return {
      completed: [],
      notCompleted: positions
        .filter((position) => position.state !== "closed")
        .map((position) => position.positionId),
      failedAt: null,
    };
  }

  const pending = positions.filter((position) => position.state !== "closed");
  const completed: string[] = [];
  let failedAt: string | null = null;
  for (const position of pending) {
    const result = await deps.post({
      kind: "exit",
      positionId: position.positionId,
      inlineConvert: deps.inlineConvert,
    });
    const refreshed = await deps.getPosition(position.positionId);
    const nonTerminal = await deps.getNonTerminalSequence(position.positionId);
    if (result.status !== 200 || refreshed?.state !== "closed" || nonTerminal !== null) {
      deps.reportPostResult(
        `POST /lp/${position.positionId}/exit (${result.status})`,
        result,
      );
      failedAt = position.positionId;
      deps.setExitCode(1);
      break;
    }
    completed.push(position.positionId);
  }

  const notCompleted = pending
    .map((position) => position.positionId)
    .filter((id) => !completed.includes(id));
  deps.log(`Completed positions: ${completed.length === 0 ? "none" : completed.join(", ")}`);
  deps.log(
    `Not completed positions: ${notCompleted.length === 0 ? "none" : notCompleted.join(", ")}`,
  );
  if (failedAt !== null) {
    deps.error(`Stopped at position ${failedAt}; no later exit was started.`);
  }

  await reportObservedBalances(deps, positions);
  deps.log(
    "Settings were not changed. The existing manual command `live-grid settings --agent-id <id> --clear-grid --yes-live` is outside this phase's review.",
  );
  return { completed, notCompleted, failedAt };
}
