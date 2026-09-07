/** A 200 response alone says nothing about the exit's outcome. */
export function lpWithdrawOutcome(payload: unknown): string {
  const fallback = "Outcome unavailable — refreshed from the plane";
  if (typeof payload !== "object" || payload === null) return fallback;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return fallback;
  const exit = (data as { exit?: unknown }).exit;
  if (typeof exit !== "object" || exit === null || Array.isArray(exit)) return fallback;
  const row = exit as Record<string, unknown>;
  if (!["completed", "held", "rolled-back"].includes(String(row.status)) || typeof row.code !== "string" || !row.code
    || typeof row.reason !== "string" || typeof row.sequenceId !== "string" || !row.sequenceId
    || typeof row.confirmedSteps !== "number" || !Number.isSafeInteger(row.confirmedSteps) || row.confirmedSteps < 0
    || typeof row.inlineConvert !== "boolean" || typeof row.submissionModel !== "string"
    || (row.note !== null && typeof row.note !== "string")
    || (row.inlineResidueBaseWei !== null && (typeof row.inlineResidueBaseWei !== "string" || !/^(0|[1-9]\d*)$/u.test(row.inlineResidueBaseWei)))) return fallback;
  const text = row.status === "completed" ? "Withdrawn — assets returned to the agent wallet"
    : row.status === "held" ? `Exit held: ${row.reason}` : `Exit refused: ${row.reason}`;
  return [text, row.note, row.inlineResidueBaseWei === undefined || row.inlineResidueBaseWei === null ? null : `Residue: ${row.inlineResidueBaseWei} base-token wei`].filter(v => v !== null && v !== undefined && v !== "").join(" · ");
}
