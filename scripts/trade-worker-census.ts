import { pathToFileURL } from "node:url";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { parseTradeSettings } from "../src/trade/settings.js";

export const CENSUS_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  agents: ["id", "status"], trade_settings: ["agent_id", "params", "draining_at"],
  trade_positions: ["agent_id", "status"], trade_intents: ["agent_id", "state"],
  dca_rounds: ["agent_id", "phase", "round_no"], execution_journal: ["agent_id", "state"],
};
export async function readWorkerCensus(sql: SqlClient): Promise<readonly string[]> {
  return sql.transaction(async tx => {
    await tx.query("set transaction read only");
    const columns = await tx.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name = any($1)", [Object.keys(CENSUS_COLUMNS)]);
    for (const [table, names] of Object.entries(CENSUS_COLUMNS)) for (const column of names) {
      if (!columns.rows.some(row => row.table_name === table && row.column_name === column)) throw new Error(`census: schema not installed: ${table}.${column}`);
    }
    const rows = await tx.query<{ agent_id: string; params: unknown; draining: boolean; status: string; open_positions: string; unsettled_intents: string; nonterminal_journal: string; dca_phase: string | null }>(
      `select s.agent_id, s.params, s.draining_at is not null as draining, a.status,
      (select count(*)::text from trade_positions p where p.agent_id = s.agent_id and p.status = 'open') as open_positions,
      (select count(*)::text from trade_intents i where i.agent_id = s.agent_id and i.state = 'pending') as unsettled_intents,
      (select count(*)::text from execution_journal j where j.agent_id = s.agent_id and j.state in ('PENDING','IN_PROGRESS','UNKNOWN')) as nonterminal_journal,
      (select r.phase from dca_rounds r where r.agent_id = s.agent_id and r.phase <> 'settled' order by r.round_no desc limit 1) as dca_phase
      from trade_settings s left join agents a on a.id = s.agent_id order by s.agent_id`);
    const workers = await tx.query<{ agent_id: string }>("select s.agent_id from trade_settings s join agents a on a.id = s.agent_id where a.status = 'armed'");
    return rows.rows.map(row => {
      const parsed = parseTradeSettings(row.params);
      if (!parsed.ok) throw new Error("census: invalid trade settings");
      const settings = parsed.value.effective;
      const entry = workers.rows.some(worker => worker.agent_id === row.agent_id);
      const protective = (settings.tradeMode === "dca" && ["armed", "paused"].includes(row.status) && (row.dca_phase !== null || row.draining))
        || (row.status === "armed" && (Number(row.open_positions) > 0 || row.draining));
      const mode = settings.settlementAsset === "USDT" ? `${settings.executionModel}/${settings.tradeMode ?? "ai"}` : "native";
      return `${row.agent_id} status=${row.status} mode=${mode} draining=${row.draining ? "yes" : "no"} open-positions=${row.open_positions} unsettled-intents=${row.unsettled_intents} nonterminal-journal=${row.nonterminal_journal} dca-round=${row.dca_phase ?? "none"} entry-capable=${entry ? "yes" : "no"} protective-capable=${protective ? "yes" : "no"}`;
    });
  });
}
export async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"]?.trim();
  if (!url) { console.error("DATABASE_URL is required"); process.exitCode = 2; return; }
  const sql = await createPgSqlClient(url);
  try { for (const line of await readWorkerCensus(sql)) console.log(line); }
  finally { await sql.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => { console.error(error instanceof Error && error.message.startsWith("census:") ? error.message : "census: inspection unavailable"); process.exitCode = 2; });
}
