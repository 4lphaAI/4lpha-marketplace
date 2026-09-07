import type { LpWorkerDeps, LpWorkerState } from "./worker.js";
import { isFeeCollectionStep, recordLpFeeEvents } from "./feeRecorder.js";
import { feeCoverage, type LpFeeEvent } from "../store/lpFeeEvents.js";

const cursors = new WeakMap<LpWorkerState, { createdAt: number; sequenceId: string }>();
export const FEE_REPAIR_CYCLE_MS = 3000;
export const FEE_REPAIR_AGENT_MS = 1000;

/** Runs after money work; terminal/closed sequences are deliberately included. */
export async function repairLpFeeEvents(deps: LpWorkerDeps, state: LpWorkerState): Promise<void> {
  if (deps.dryRun || !deps.feeEvents || !deps.readers.receipts.feeEvents || !deps.store.listFeeRepairSequencesForWorker) return;
  const deadlineMs = Date.now() + FEE_REPAIR_CYCLE_MS;
  const controller = new AbortController();
  const signal = deps.feeWorkerFence ? AbortSignal.any([controller.signal, deps.feeWorkerFence.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), FEE_REPAIR_CYCLE_MS);
  const check = (agentDeadline = deadlineMs) => {
    signal.throwIfAborted(); deps.feeWorkerFence?.assertOpen();
    if (Date.now() >= Math.min(deadlineMs, agentDeadline)) throw new Error("Fee repair deadline");
  };
  const bounded = async <T>(operation: () => Promise<T>, agentDeadline = deadlineMs): Promise<T> => {
    check(agentDeadline);
    let cancel: (() => void) | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation().then(value => { check(agentDeadline); return value; }), new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("Fee repair deadline")); signal.addEventListener("abort", cancel, { once: true });
        // Wake a hung read to compare its deadline; only the cycle timer aborts.
        const compareDeadline = () => {
          try { check(agentDeadline); deadlineTimer = setTimeout(compareDeadline, 1); }
          catch (error) { reject(error); }
        };
        deadlineTimer = setTimeout(compareDeadline, Math.max(1, agentDeadline - Date.now()));
      })]);
    } finally {
      if (cancel) signal.removeEventListener("abort", cancel);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  };
  const agents = new Map<string, { deadline: number; count: number; rows: Promise<LpFeeEvent[]> | null }>();
  try {
    const sequences = await bounded(() => deps.store.listFeeRepairSequencesForWorker!({ after: cursors.get(state) ?? null, limit: 64, deadlineMs, signal }));
    for (const sequence of sequences) {
      check();
      const budget = agents.get(sequence.agentId) ?? { deadline: Math.min(deadlineMs, Date.now() + FEE_REPAIR_AGENT_MS), count: 0, rows: null };
      agents.set(sequence.agentId, budget);
      if (budget.count >= 8 || Date.now() >= budget.deadline) continue;
      const agentBounded = <T>(operation: () => Promise<T>) => bounded(operation, budget.deadline);
      try {
        budget.rows ??= agentBounded(() => deps.feeEvents!.snapshot(sequence.ownerAddress, sequence.agentId, signal));
        const rows = await budget.rows;
        for (const step of sequence.steps) {
          check(budget.deadline);
          if (budget.count >= 8 || Date.now() >= budget.deadline) break;
          if (!isFeeCollectionStep(sequence.kind, step.kind)) continue;
          const journal = await agentBounded(() => deps.journal.get(step.journalIdempotencyKey));
          if (journal?.state !== "COMMITTED" || !journal.externalRef.txHash) continue;
          if (feeCoverage(rows, [{ sequenceId:sequence.sequenceId, journalIdempotencyKey:step.journalIdempotencyKey, txHash:journal.externalRef.txHash }], (1n << 256n)-1n).status === "complete") continue;
          // Insert-only gaps cannot be cleared by replay; leave them disclosed.
          if (rows.some(r => r.sequenceId === sequence.sequenceId && r.journalIdempotencyKey === step.journalIdempotencyKey && r.status === "gap")) continue;
          const agent = await agentBounded(() => deps.agentStore.getAgent(sequence.ownerAddress, sequence.agentId));
          const position = await agentBounded(() => deps.store.getPosition(sequence.ownerAddress, sequence.agentId, sequence.positionId));
          if (!agent || !position) continue;
          const associations = sequence.kind === "grid-shift"
            ? (await agentBounded(() => deps.store.listPositions(sequence.ownerAddress, sequence.agentId))).filter(p => p.armGroupId === position.armGroupId) : [position];
          budget.count++;
          await agentBounded(() => recordLpFeeEvents({ deps: { agent, store: deps.store, receipts: deps.readers.receipts, feeEvents: deps.feeEvents!, now: deps.now },
            ctx: { sequenceId: sequence.sequenceId, journalIdempotencyKey: step.journalIdempotencyKey }, txHash: journal.externalRef.txHash, position, associations, signal, deadlineMs: budget.deadline }));
        }
        cursors.set(state, { createdAt: sequence.createdAt, sequenceId: sequence.sequenceId });
      } catch { check(); /* One agent's failure or deadline must not consume another's budget. */ }
    }
    if (sequences.length < 64) cursors.delete(state);
  } catch { /* Reporting gaps remain incomplete; no sequence is held. */ }
  finally { clearTimeout(timer); }
}
