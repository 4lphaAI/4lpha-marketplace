/** Pure exit arithmetic and precedence (TRADING-AGENT R8 / R4.1). */

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

export const RUG_QUOTE_WINDOW_MS = 900_000;
export const SESSION_EXIT_LEAD_MS = 3_600_000;
export const SESSION_ENTRY_CUTOFF_MS = 7_200_000;

export type CrashPendingKind = "collapse" | "dust";
export type AutoExitReason = "crash-stop" | "session-expiring";

export type ExitEvidence =
  | {
      readonly kind: "arm";
      readonly pendingKind: CrashPendingKind;
      readonly pendingSinceMs: number;
      readonly reference: {
        readonly quoteWei: bigint;
        readonly balance: bigint;
        readonly routeKey: string;
        readonly atMs: number;
      };
    }
  | { readonly kind: "clear" }
  | {
      readonly kind: "marker";
      readonly reason: AutoExitReason;
      readonly atMs: number;
      readonly note: string | null;
    };

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
  readonly sessionExpiresAtMs?: number | null;
  readonly sessionExitLeadMs?: number;
  readonly crashProtection?: boolean;
  readonly balance?: bigint;
  readonly routeKey?: string;
  readonly lastQuoteWei?: bigint | null;
  readonly lastQuoteBalance?: bigint | null;
  readonly lastQuoteRoute?: string | null;
  readonly lastQuoteAtMs?: number | null;
  readonly rugQuoteWindowMs?: number;
  readonly peakPnlBps?: bigint | null;
  readonly crashPendingSinceMs?: number | null;
  readonly crashPendingKind?: CrashPendingKind | null;
  readonly crashRefQuoteWei?: bigint | null;
  readonly crashRefBalance?: bigint | null;
  readonly crashRefAtMs?: number | null;
  readonly crashRefRoute?: string | null;
  readonly crashBasisVerified?: boolean;
  readonly tokenAmount?: bigint | null;
  readonly fillStatus?: "verified" | "unverified";
  readonly autoExitReason?: AutoExitReason | null;
  readonly autoExitNote?: string | null;
  /** The worker grants the model the time limit only for live trade settings. */
  readonly timeLimitAuthority?: boolean;
};

export type ExitDecision =
  | { readonly exit: false; readonly reason: "hold"; readonly evidence?: ExitEvidence }
  | {
      readonly exit: true;
      readonly reason: "owner-request" | "stop-loss" | "take-profit" | "crash-stop" | "max-hold" | "session-expiring" | "llm";
      readonly pnlBps: bigint | null;
      readonly note?: string;
      readonly evidence?: ExitEvidence;
    };

type Observation = {
  readonly quoteWei: bigint;
  readonly balance: bigint;
  readonly routeKey: string;
  readonly atMs: number;
};

function currentObservation(input: ExitDecisionInput): Observation | null {
  if (input.balance === undefined || input.routeKey === undefined) return null;
  if (input.balance <= 0n || input.quoteOutWei < 0n || !Number.isFinite(input.nowMs)) return null;
  return { quoteWei: input.quoteOutWei, balance: input.balance, routeKey: input.routeKey, atMs: input.nowMs };
}

function previousObservation(input: ExitDecisionInput): Observation | null {
  if (input.lastQuoteWei === null || input.lastQuoteWei === undefined
    || input.lastQuoteBalance === null || input.lastQuoteBalance === undefined
    || input.lastQuoteRoute === null || input.lastQuoteRoute === undefined
    || input.lastQuoteAtMs === null || input.lastQuoteAtMs === undefined) return null;
  return {
    quoteWei: input.lastQuoteWei,
    balance: input.lastQuoteBalance,
    routeKey: input.lastQuoteRoute,
    atMs: input.lastQuoteAtMs,
  };
}

function frozenReference(input: ExitDecisionInput): Observation | null {
  if (input.crashRefQuoteWei === null || input.crashRefQuoteWei === undefined
    || input.crashRefBalance === null || input.crashRefBalance === undefined
    || input.crashRefRoute === null || input.crashRefRoute === undefined
    || input.crashRefAtMs === null || input.crashRefAtMs === undefined) return null;
  return {
    quoteWei: input.crashRefQuoteWei,
    balance: input.crashRefBalance,
    routeKey: input.crashRefRoute,
    atMs: input.crashRefAtMs,
  };
}

function comparable(current: Observation, reference: Observation, windowMs: number, strictLater: boolean): boolean {
  if (!Number.isFinite(reference.atMs) || !Number.isFinite(windowMs) || windowMs < 0) return false;
  const elapsed = current.atMs - reference.atMs;
  if (strictLater ? elapsed <= 0 : elapsed < 0) return false;
  if (elapsed > windowMs) return false;
  if (current.routeKey !== reference.routeKey || reference.balance <= 0n) return false;
  const difference = current.balance >= reference.balance
    ? current.balance - reference.balance : reference.balance - current.balance;
  return 100n * difference <= reference.balance;
}

/** `uNow <= uReference / 2`, without division or Number conversion. */
function collapse(current: Observation, reference: Observation): boolean {
  return reference.quoteWei > 0n
    && 2n * current.quoteWei * reference.balance <= reference.quoteWei * current.balance;
}

/** Mathematical floor of a signed ratio in basis points. */
function ratioBps(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator * 10_000n / denominator;
  return numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient;
}

function quantityAdjustedPnl(input: ExitDecisionInput): bigint | null {
  if (input.fillStatus !== "verified" || input.crashBasisVerified !== true
    || input.tokenAmount === null || input.tokenAmount === undefined || input.tokenAmount <= 0n
    || input.entryWei <= 0n || input.balance === undefined || input.balance <= 0n) return null;
  const denominator = input.entryWei * input.balance;
  return ratioBps(input.quoteOutWei * input.tokenAmount - denominator, denominator);
}

function signedPercent(value: bigint | null): string {
  if (value === null) return "unknown";
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${negative ? "-" : value > 0n ? "+" : ""}${whole.toString(10)}${fraction === 0n ? "" : `.${fraction.toString(10).padStart(2, "0")}`}%`;
}

function crashNote(input: ExitDecisionInput, reference: Observation, current: Observation, kind: CrashPendingKind): string {
  const drop = kind === "collapse" && reference.quoteWei > 0n
    ? ratioBps(current.quoteWei * reference.balance - reference.quoteWei * current.balance,
      reference.quoteWei * current.balance)
    : null;
  const pnl = pnlBps(input.quoteOutWei, input.entryWei);
  const peak = input.peakPnlBps ?? null;
  return `${kind === "collapse" ? "quote" : "pnl"} ${kind === "collapse" ? signedPercent(drop) : signedPercent(quantityAdjustedPnl(input))} vs last reading, pnl ${signedPercent(pnl)}, peak ${signedPercent(peak)}`;
}

function markerNote(input: ExitDecisionInput): string | null {
  return input.autoExitNote === undefined ? null : input.autoExitNote;
}

/** Whether a live worker should include this position in the exit-model call. */
export function hasBlankThreshold(input: Pick<ExitDecisionInput, "takeProfitBps" | "stopLossBps" | "timeLimitAuthority">): boolean {
  return input.takeProfitBps === null || input.stopLossBps === null || input.timeLimitAuthority === true;
}

function crashEvidence(input: ExitDecisionInput, currentPnlBps: bigint | null): {
  readonly evidence?: ExitEvidence;
  readonly decision?: ExitDecision;
} {
  if (input.crashProtection !== true) return {};
  const current = currentObservation(input);
  if (current === null) return {};
  const pending = input.crashPendingSinceMs !== null && input.crashPendingSinceMs !== undefined;
  if (pending) {
    const reference = frozenReference(input);
    if (reference === null || input.crashPendingKind === null || input.crashPendingKind === undefined
      || !comparable(current, reference, RUG_QUOTE_WINDOW_MS, true)) {
      return { evidence: { kind: "clear" } };
    }
    const adjusted = quantityAdjustedPnl(input);
    const dust = adjusted !== null && adjusted <= -7_500n;
    const qualifies = input.crashPendingKind === "collapse"
      ? collapse(current, reference) : dust;
    if (!qualifies) return { evidence: { kind: "clear" } };
    const note = crashNote(input, reference, current, input.crashPendingKind);
    const evidence: ExitEvidence = { kind: "marker", reason: "crash-stop", atMs: input.nowMs, note };
    return {
      evidence,
      decision: { exit: true, reason: "crash-stop", pnlBps: currentPnlBps, note, evidence },
    };
  }

  const reference = previousObservation(input);
  if (reference === null || !comparable(current, reference, input.rugQuoteWindowMs ?? RUG_QUOTE_WINDOW_MS, false)) return {};
  const adjusted = quantityAdjustedPnl(input);
  const dust = adjusted !== null && adjusted <= -7_500n;
  const kind: CrashPendingKind | null = collapse(current, reference) ? "collapse" : dust ? "dust" : null;
  if (kind === null) return {};
  return { evidence: { kind: "arm", pendingKind: kind, pendingSinceMs: input.nowMs, reference } };
}

/** Full precedence table. The function has no store, provider or time source. */
export function decideExit(input: ExitDecisionInput): ExitDecision {
  const currentPnlBps = pnlBps(input.quoteOutWei, input.entryWei);
  if (input.exitRequestedAt !== null) {
    return { exit: true, reason: "owner-request", pnlBps: currentPnlBps };
  }
  if (input.autoExitReason === "crash-stop" && input.crashProtection === true) {
    const note = markerNote(input);
    return { exit: true, reason: "crash-stop", pnlBps: currentPnlBps, ...(note === null ? {} : { note }) };
  }
  if (input.autoExitReason === "session-expiring") {
    const note = markerNote(input);
    return { exit: true, reason: "session-expiring", pnlBps: currentPnlBps, ...(note === null ? {} : { note }) };
  }
  if (currentPnlBps !== null && input.stopLossBps !== null && currentPnlBps <= -BigInt(input.stopLossBps)) {
    return { exit: true, reason: "stop-loss", pnlBps: currentPnlBps };
  }
  if (currentPnlBps !== null && input.takeProfitBps !== null && currentPnlBps >= BigInt(input.takeProfitBps)) {
    return { exit: true, reason: "take-profit", pnlBps: currentPnlBps };
  }

  const crash = crashEvidence(input, currentPnlBps);
  if (crash.decision !== undefined) return crash.decision;

  if (input.maxHoldSec !== null && input.nowMs - input.openedAtMs >= input.maxHoldSec * 1_000) {
    return { exit: true, reason: "max-hold", pnlBps: currentPnlBps };
  }
  const sessionExpiresAtMs = input.sessionExpiresAtMs ?? null;
  const leadMs = input.sessionExitLeadMs ?? SESSION_EXIT_LEAD_MS;
  if (sessionExpiresAtMs !== null && input.nowMs >= sessionExpiresAtMs - leadMs) {
    const note = `Session expires at ${new Date(sessionExpiresAtMs).toISOString()}.`;
    const evidence: ExitEvidence = { kind: "marker", reason: "session-expiring", atMs: input.nowMs, note };
    return { exit: true, reason: "session-expiring", pnlBps: currentPnlBps, note, evidence };
  }
  if (hasBlankThreshold(input) && input.llmExit === true) {
    return {
      exit: true,
      reason: "llm",
      pnlBps: currentPnlBps,
      ...(input.llmReason === undefined ? {} : { note: input.llmReason.slice(0, 200) }),
    };
  }
  return crash.evidence === undefined
    ? { exit: false, reason: "hold" }
    : { exit: false, reason: "hold", evidence: crash.evidence };
}
