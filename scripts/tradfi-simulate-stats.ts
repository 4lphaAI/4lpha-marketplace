import { pathToFileURL } from "node:url";
import { createPgSqlClient } from "../src/store/sql.js";
import { readTradeSimulations, type TradeSimulationReport } from "../src/store/tradeSimulations.js";

export function simulationJournalClass(row: TradeSimulationReport): string {
  if (row.blocked && row.actualTxHash !== null) return "inconsistent";
  if (row.actualTxHash !== null) return "verified-landed";
  if (row.journalState === "COMMITTED") return "committed-unverified";
  if (row.journalState === "ROLLED_BACK") return row.hasCallsId ? "submitted-failed" : "not-submitted";
  return ["PENDING", "IN_PROGRESS", "UNKNOWN"].includes(row.journalState ?? "") ? "open" : "missing";
}
function percentile(values: readonly number[], p: number): number | null {
  return [...values].sort((a, b) => a - b)[Math.ceil(p / 100 * values.length) - 1] ?? null;
}
function bigintPercentile(values: readonly bigint[], p: number): bigint | null {
  return [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)[Math.ceil(p / 100 * values.length) - 1] ?? null;
}
const abs = (n: bigint) => n < 0n ? -n : n;
export function summarizeTradeSimulations(rows: readonly TradeSimulationReport[], actualWithoutSimulation = 0) {
  const counts: Record<string, number> = {};
  const failedReasons = new Map<string, number>();
  const increment = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  const latencies: number[] = [], upstream: number[] = [], headroom: bigint[] = [];
  const accuracy = (kind: "swap-output" | "net-wallet-delta") => {
    const matches = rows.filter(row => row.predictionKind === kind && row.predictedOutAtomic !== null && row.actualOutAtomic !== null && !row.blocked);
    const deviations = matches.filter(row => row.predictedOutAtomic !== 0n).map(row => (row.actualOutAtomic! - row.predictedOutAtomic!) * 1_000_000n / abs(row.predictedOutAtomic!));
    const zeroAbsolute = matches.filter(row => row.predictedOutAtomic === 0n).map(row => abs(row.actualOutAtomic!));
    const absolute = deviations.map(abs);
    return { count: matches.length, exact: matches.filter(row => row.actualOutAtomic === row.predictedOutAtomic).length,
      deviationsPpm: deviations, absoluteP50: bigintPercentile(absolute, 50), absoluteP90: bigintPercentile(absolute, 90),
      absoluteMax: bigintPercentile(absolute, 100), zeroPredictedAbsoluteAtomic: zeroAbsolute };
  };
  for (const row of rows) {
    increment(`kind:${row.journalKind}`); increment(`route:${row.route}`);
    increment(`exposure:${row.exposure}:${row.outcome}`); increment(`route-outcome:${row.route}:${row.outcome}`);
    const cls = simulationJournalClass(row);
    increment(`journal:${cls}`); increment(`agreement:${row.outcome}:${cls}`);
    if (row.blocked) increment("blocked");
    if (row.route === "guard" && row.bareRevert) increment("guard-bare-revert");
    if (row.reason !== null) increment(`not-simulated:${row.reason}`);
    if (row.outcome === "failed-other") { const reason = row.failReason ?? "null"; failedReasons.set(reason, (failedReasons.get(reason) ?? 0) + 1); }
    if (row.outcome === "success" && cls === "submitted-failed") increment("false-success");
    if (row.outcome === "reverted" && row.exposure === "reduce") {
      increment("sell-reverted-log-only");
      if (cls === "submitted-failed") increment("sell-reverted-confirmed");
      if (cls === "verified-landed") increment("sell-reverted-contradicted");
    }
    if (row.outcome === "guard-deadline" || row.outcome === "failed-other") {
      if (cls === "verified-landed") increment(`${row.outcome}-landed`);
      if (cls === "submitted-failed") increment(`${row.outcome}-failed`);
    }
    if (row.latencyMs !== null) latencies.push(row.latencyMs);
    if (row.upstreamMs !== null) upstream.push(row.upstreamMs);
    if (row.predictionKind === "swap-output" && row.outcome === "success" && row.predictedOutAtomic !== null) {
      if (row.predictedOutAtomic <= 0n) increment("anomalous-swap-prediction");
      else if (row.minOutAtomic !== null) {
        const numerator = (row.predictedOutAtomic - row.minOutAtomic) * 10_000n;
        const quotient = numerator / row.minOutAtomic;
        headroom.push(quotient - (numerator < 0n && numerator % row.minOutAtomic !== 0n ? 1n : 0n));
      }
    }
  }
  const timing = (values: number[]) => ({ count: values.length, p50: percentile(values, 50), p90: percentile(values, 90), max: percentile(values, 100) });
  return { total: rows.length, actualWithoutSimulation, counts,
    failedOtherReasons: [...failedReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    latencyMs: timing(latencies), upstreamMs: timing(upstream),
    headroomBps: { count: headroom.length, min: headroom.reduce<bigint | null>((min, value) => min === null || value < min ? value : min, null), p10: bigintPercentile(headroom, 10), p50: bigintPercentile(headroom, 50) },
    swapOutput: accuracy("swap-output"), netWalletDelta: accuracy("net-wallet-delta"),
    dcaSwapMinOut: rows.filter(row => row.journalKind === "dcaRange").map(row => ({ key: row.idempotencyKey, minOutAtomic: row.minOutAtomic })) };
}

export function parseStatsArgs(argv: readonly string[], nowMs = Date.now()) {
  let sinceMs = nowMs - 7 * 86_400_000, agentId: string | undefined, json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--json") json = true;
    else if (flag === "--since") { const value = argv[++i]; sinceMs = value === undefined ? NaN : Date.parse(value); if (!Number.isFinite(sinceMs)) throw new Error("Invalid --since."); }
    else if (flag === "--agent") { agentId = argv[++i]; if (!agentId) throw new Error("Missing --agent."); }
    else throw new Error("Unknown stats argument.");
  }
  return { sinceMs, ...(agentId === undefined ? {} : { agentId }), json };
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const url = process.env["DATABASE_URL"]?.trim();
  if (!url) { console.error("DATABASE_URL is required"); process.exitCode = 2; return; }
  const args = parseStatsArgs(argv);
  const sql = await createPgSqlClient(url);
  try {
    const report = await readTradeSimulations(sql, { ...args, limit: 100_000 });
    const summary = { since: new Date(args.sinceMs).toISOString(), agent: args.agentId ?? null, missingTable: report.missingTable,
      ...summarizeTradeSimulations(report.rows, report.actualWithoutSimulation) };
    console.log(JSON.stringify(summary, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, args.json ? undefined : 2));
  } finally { await sql.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error("Simulation stats unavailable."); process.exitCode = 2; });
}
