/** Pure exit arithmetic and precedence (TRADING-AGENT R8 / R3.7). */

/** Bigint mathematical floor, including negative PnL where `/` truncates toward zero. */
export function pnlBps(quoteOutWei: bigint, entryWei: bigint): bigint | null {
  // AUDIT H2: legacy or unverified bases are held without poisoning the agent's whole exit pass.
  if (entryWei <= 0n) return null;
  const numerator = (quoteOutWei - entryWei) * 10_000n;
  const quotient = numerator / entryWei;
  return numerator < 0n && numerator % entryWei !== 0n ? quotient - 1n : quotient;
}

/** Ported verbatim from D:/4alpha/lib/agents/runtime/worker.ts:2692-2695 (R3.7). */
export function applySlippageFloorWei(amountWei: bigint, slippageBps: number): bigint {
  const normalizedBps = Math.max(0, Math.min(9_999, Math.trunc(slippageBps)));
  return (amountWei * BigInt(10_000 - normalizedBps)) / BigInt(10_000);
}

export type ExitDecisionInput = {
  readonly quoteOutWei: bigint;
  readonly entryWei: bigint;
  readonly openedAtMs: number;
  readonly nowMs: number;
  readonly stopLossBps: number | null;
  readonly takeProfitBps: number | null;
  readonly maxHoldSec: number | null;
  readonly exitRequestedAt: number | null;
  readonly llmExit?: boolean;
  readonly llmReason?: string;
};

export type ExitDecision =
  | { readonly exit: false; readonly reason: "hold" }
  | {
      readonly exit: true;
      readonly reason: "owner-request" | "stop-loss" | "take-profit" | "max-hold" | "llm";
      readonly pnlBps: bigint;
      readonly note?: string;
    };

/** Owner-requested exits run before every automatic rule (R3.1); SL then TP then age then LLM. */
export function decideExit(input: ExitDecisionInput): ExitDecision {
  const currentPnlBps = pnlBps(input.quoteOutWei, input.entryWei);
  if (currentPnlBps === null) return { exit: false, reason: "hold" };
  if (input.exitRequestedAt !== null) {
    return { exit: true, reason: "owner-request", pnlBps: currentPnlBps };
  }
  if (input.stopLossBps !== null && currentPnlBps <= -BigInt(input.stopLossBps)) {
    return { exit: true, reason: "stop-loss", pnlBps: currentPnlBps };
  }
  if (input.takeProfitBps !== null && currentPnlBps >= BigInt(input.takeProfitBps)) {
    return { exit: true, reason: "take-profit", pnlBps: currentPnlBps };
  }
  if (
    input.maxHoldSec !== null
    && input.nowMs - input.openedAtMs >= input.maxHoldSec * 1_000
  ) {
    return { exit: true, reason: "max-hold", pnlBps: currentPnlBps };
  }
  const hasBlankThreshold = input.takeProfitBps === null || input.stopLossBps === null;
  if (hasBlankThreshold && input.llmExit === true) {
    return {
      exit: true,
      reason: "llm",
      pnlBps: currentPnlBps,
      ...(input.llmReason === undefined ? {} : { note: input.llmReason.slice(0, 200) }),
    };
  }
  return { exit: false, reason: "hold" };
}
