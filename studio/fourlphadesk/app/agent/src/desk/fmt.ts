/** Formatting helpers. A null always prints as "n/a": a missing value is never shown as zero. */

export const NA = "n/a";

export function fixed(n: number | null, dp: number): string {
  if (n === null || !Number.isFinite(n)) return NA;
  const s = n.toFixed(dp);
  return s === "-0" || /^-0\.0+$/.test(s) ? s.slice(1) : s;
}

export function usd(n: number | null, dp = 2): string {
  return n === null ? NA : fixed(n, dp);
}

export function bps(n: number | null): string {
  return n === null || !Number.isFinite(n) ? NA : `${Math.round(n * 10) / 10} bps`;
}

export function pct(n: number | null, dp = 2): string {
  return n === null ? NA : `${fixed(n, dp)} %`;
}

export function ts(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

export function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(head), row(head.map(() => "---")), ...rows.map(row)];
}

export const NOT_ADVICE =
  "This report is data and arithmetic from public sources. It is not investment advice, it does not recommend buying or selling anything, and quotes move: the live quote for your exact amount is the final word.";
