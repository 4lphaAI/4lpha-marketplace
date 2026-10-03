/**
 * TRADFI-EXIT-RULES: two deterministic robot exits for the TradFi AI-trade
 * lane. Pure, no I/O. Every value is the worker's net quote PnL in bps (what
 * selling the whole position returns against the USDT paid), so it is already
 * net of the entry premium and the current sell quote.
 */

export type TradfiExitRule = "trailing-stop" | "stale-exit";
export type TradfiExitRulesMode = "off" | "log" | "enforce";

/** T arms once the peak reaches this, then fires when pnl falls this far under the peak. */
export const TRADFI_TRAIL_ARM_BPS = 200;
export const TRADFI_TRAIL_GIVEBACK_BPS = 150;
/**
 * The stored peak is an all-time max, so one inflated reading (a doubled balance from a duplicate worker, a
 * transfer in, a repair-fill basis) would arm T for good. Above this, T is skipped and the worker logs it.
 */
export const TRADFI_TRAIL_MAX_PEAK_BPS = 2_000;
/** S fires on a position held at least this long whose pnl is at or under the ceiling. */
export const TRADFI_STALE_AGE_MS = 48 * 3_600_000;
export const TRADFI_STALE_PNL_CEILING_BPS = 100;

const signed = (value: number): string => (value >= 0 ? `+${value}` : `${value}`);

export const tradfiPeakImplausible = (peakPnlBps: number): boolean => peakPnlBps > TRADFI_TRAIL_MAX_PEAK_BPS;
/**
 * T is checked first and one rule fires per position per cycle. The owner's
 * own take profit / max hold keep priority: T applies only when the take
 * profit is blank, S only when the max hold is blank.
 */
export function tradfiRobotExit(input: {
  readonly pnlBps: number;
  readonly peakPnlBps: number;
  readonly openedAtMs: number;
  readonly nowMs: number;
  readonly takeProfitBlank: boolean;
  readonly maxHoldBlank: boolean;
}): { readonly rule: TradfiExitRule; readonly detail: string } | null {
  if (input.takeProfitBlank && input.peakPnlBps >= TRADFI_TRAIL_ARM_BPS && !tradfiPeakImplausible(input.peakPnlBps)
    && input.pnlBps <= input.peakPnlBps - TRADFI_TRAIL_GIVEBACK_BPS) {
    return { rule: "trailing-stop", detail: `peak=${signed(input.peakPnlBps)} now=${signed(input.pnlBps)}` };
  }
  const heldMs = input.nowMs - input.openedAtMs;
  if (input.maxHoldBlank && heldMs >= TRADFI_STALE_AGE_MS && input.pnlBps <= TRADFI_STALE_PNL_CEILING_BPS) {
    return { rule: "stale-exit", detail: `held=${(heldMs / 3_600_000).toFixed(1)}h pnl=${signed(input.pnlBps)}` };
  }
  return null;
}

/** Read once at worker start: unset or unrecognised is `log` (the unrecognised case warns once). */
export function resolveTradfiExitRulesMode(raw: string | undefined, warn: (line: string) => void): TradfiExitRulesMode {
  const value = raw?.trim();
  if (value === undefined || value === "") return "log";
  if (value === "off" || value === "log" || value === "enforce") return value;
  warn(`[trade-worker] TRADFI_EXIT_RULES_MODE "${value.slice(0, 20)}" is not off, log or enforce; using log.`);
  return "log";
}
