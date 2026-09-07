import type { Hex } from "viem";
import type { LpSagaDeps } from "./sagas.js";
import type { LpFeeReceipt } from "./feeTelemetry.js";
import type { LpPositionRecord, LpSequenceRecord } from "../store/lpSequences.js";
import type { LpFeeEvent } from "../store/lpFeeEvents.js";
import { sanitizeMessage } from "../core/errors.js";
import { LpFeeReceiptEvidenceError } from "./readers.js";

export function isFeeCollectionStep(kind: string, step: string): boolean {
  if (kind === "rotate" && step === "rotate-atomic") return true;
  return kind === "harvest" ? step === "collect-fees" : kind === "grid-shift" ? step === "grid-shift"
    : ["protect", "manual-exit", "rotate", "grid-flip", "grid-requote", "grid-recenter"].includes(kind) && step === "zap-out";
}
export type FeeHookContext = { sequenceId: string; journalIdempotencyKey: string };
export type FeeRecorderDeps = Pick<LpSagaDeps, "agent" | "store" | "receipts" | "feeEvents" | "feeSignal" | "now">;

/** Isolated finalizer: even failed post-verification must retain landed accounting. */
export async function recordLpFeeEvents(input: {
  deps: FeeRecorderDeps; ctx: FeeHookContext; txHash: Hex | undefined; position: LpPositionRecord;
  associations?: readonly Pick<LpPositionRecord, "positionId" | "tokenId" | "lineageId">[]; signal?: AbortSignal; deadlineMs?: number;
}): Promise<void> {
  try {
    const { deps, ctx, txHash, position } = input;
    const signal = input.signal ?? deps.feeSignal;
    if (txHash === undefined || deps.feeEvents === undefined || deps.receipts.feeEvents === undefined) return;
    const check = () => {
      signal?.throwIfAborted();
      if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) throw new Error("Fee repair agent deadline");
    };
    check();
    const sequence = await deps.store.getSequence(deps.agent.ownerAddress, deps.agent.id, ctx.sequenceId);
    const step = sequence?.steps.find(s => s.journalIdempotencyKey === ctx.journalIdempotencyKey);
    if (!sequence || !step || !isFeeCollectionStep(sequence.kind, step.kind)) return;
    check();
    let invalidReason: string | null = null;
    let evidence: LpFeeReceipt;
    try {
      if (step.kind === "rotate-atomic" && sequence.priorTokenId == null) throw new LpFeeReceiptEvidenceError("Atomic rotate prior NFT identity is missing");
      evidence = await deps.receipts.feeEvents(txHash, step.kind === "rotate-atomic" ? {
        oldTokenId: BigInt(sequence.priorTokenId!), wallet: deps.agent.walletAddress,
        token0: position.token0, token1: position.token1, fee: position.fee,
      } : undefined);
      if (step.kind === "rotate-atomic" && (evidence.atomicRotate === undefined || evidence.byTokenId.size !== 1 || !evidence.byTokenId.has(sequence.priorTokenId!))) {
        throw new LpFeeReceiptEvidenceError("Atomic rotate cardinality or old-NFT attribution is invalid");
      }
    } catch (error) {
      if (!(error instanceof LpFeeReceiptEvidenceError)) throw error;
      invalidReason = `receipt-evidence-invalid: ${sanitizeMessage(error.message)}`;
      evidence = { blockNumber: error.blockNumber, byTokenId: new Map<string, never>() };
    }
    check();
    const receiptTokenIds = [...evidence.byTokenId.keys()].sort();
    const base = { ownerAddress: deps.agent.ownerAddress, agentId: deps.agent.id,
      sequenceId: ctx.sequenceId, journalIdempotencyKey: ctx.journalIdempotencyKey, stepIndex: step.index,
      kind: sequence.kind, txHash, blockNumber: evidence.blockNumber, recordedAtMs: (deps.now ?? Date.now)(), receiptTokenIds };
    const gap = (p: Pick<LpPositionRecord, "positionId" | "lineageId">, reason: string): LpFeeEvent => ({ ...base, positionId: p.positionId, lineageId: p.lineageId,
      tokenId: "-", collected0Wei: 0n, collected1Wei: 0n, decreased0Wei: 0n, decreased1Wei: 0n,
      realised0Wei: 0n, realised1Wei: 0n, status: "gap", reason });
    let rows: LpFeeEvent[] = [];
    const associations = input.associations ?? [position];
    if (invalidReason !== null) rows = associations.map(p => gap(p, invalidReason));
    else if (!receiptTokenIds.length) rows = [gap(position, "no-nfpm-collection-event")];
    else {
      for (const [tokenId, amounts] of evidence.byTokenId) {
        const p = sequence.kind === "grid-shift" ? associations.find(p => p.tokenId === tokenId) : position;
        if (!p || (sequence.kind !== "grid-shift" && receiptTokenIds.length !== 1)) {
          // No invented old-NFT association on replay: disclose every affected position.
          check();
          const affected = (await deps.store.listPositions(deps.agent.ownerAddress, deps.agent.id)).filter(p => p.armGroupId === position.armGroupId);
          check();
          rows = (affected.length ? affected : associations).map(p => gap(p, "attribution-unavailable"));
          break;
        }
        rows.push({ ...base, positionId: p.positionId, lineageId: p.lineageId, tokenId,
          collected0Wei: amounts.collected0, collected1Wei: amounts.collected1, decreased0Wei: amounts.decreased0, decreased1Wei: amounts.decreased1,
          realised0Wei: amounts.collected0 - amounts.decreased0, realised1Wei: amounts.collected1 - amounts.decreased1,
          status: "recorded", reason: null });
      }
    }
    check();
    await deps.feeEvents.recordReceipt(rows, signal);
  } catch { /* Telemetry never changes a hook's return or exception disposition. */ }
}

export function sequenceAffectsPosition(sequence: LpSequenceRecord, position: LpPositionRecord, anchor?: LpPositionRecord): boolean {
  return sequence.positionId === position.positionId || (sequence.kind === "grid-shift" && position.armGroupId !== null && anchor?.armGroupId === position.armGroupId);
}
