/** Minimal TermiX trade annotation payload; quantities stay in local state only. */
import type { QuantReportPayload } from "./termix.js";
import type { QuantRebalanceActionRow } from "./rebalanceTypes.js";

export function buildQuantRebalanceReportPayload(
  actions: readonly QuantRebalanceActionRow[],
): QuantReportPayload {
  return {
    trades: actions.filter((action) => action.state === "settled" && action.txHash !== null)
      .map((action) => ({ txHash: action.txHash!, note: `${action.side}:${action.asset}` })),
  };
}
