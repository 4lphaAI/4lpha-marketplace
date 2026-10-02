import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { resolveTradeConfig } from "../src/ops/config.js";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { CENSUS_COLUMNS, readWorkerCensus } from "../scripts/trade-worker-census.js";
import { main as statsMain, parseStatsArgs, simulationJournalClass, summarizeTradeSimulations } from "../scripts/tradfi-simulate-stats.js";
import { parseProbeArgs, probeGuardDeadline } from "../scripts/tradfi-simulate-probe.js";
import { readTradeSimulations, type TradeSimulationReport } from "../src/store/tradeSimulations.js";
import type { SqlClient } from "../src/store/sql.js";
import { HttpTradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import { GUARD_DEADLINE_REASONS } from "../src/trade/simulate.js";
import { buildTradfiGuardSwapCall, TRADFI_SWAP_GUARD_ABI, TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { decodeAbiParameters, decodeFunctionData, parseAbi, type Hex } from "viem";
import { dcaSettings, OWNER, WALLET, NV, GUARD } from "./support/dcaFixtures.js";
import { DEFAULT_TRADE_SETTINGS } from "../src/trade/settings.js";
const source = (file: string) => readFileSync(file, "utf8");

it("WI1 default-off composition wires only the daemon, bound client and three verified actual paths", () => {
  const daemon = source("scripts/trade-worker.ts");
  assert.match(daemon, /if \(trade.preflightSimulate === true\)/u); assert.match(daemon, /simulate: input => dataPlane\.binanceSimulate\(input\)/u);
  assert.equal((daemon.match(/\{ preflight \}/gu) ?? []).length, 2); assert.equal((daemon.match(/recordSimulationActual\(simulations/gu) ?? []).length, 2);
  assert.match(source("src/trade/worker.ts"), /recordSimulationActual\(ctx\.dca\.simulations/u);
  assert.ok(daemon.indexOf("await simulations?.shutdown()") < daemon.indexOf("for (const store of [intents"));
  for (const file of ["src/server.ts", "src/index-server.ts"]) assert.ok(!source(file).includes("preflight:"));
  const scan = (dir: string) => { for (const name of readdirSync(dir)) { const file = join(dir, name); if (statSync(file).isDirectory()) { if (name !== "tmp") scan(file); } else if (file.endsWith(".ts")) assert.ok(!/=\s*[\w.]+\.binanceSimulate\s*;/u.test(source(file)), file); } };
  scan("src"); scan("scripts");
});
it("CF1 flag parse mirrors staged submit and defaults off", () => {
  const options = { chainId: 56, nowSeconds: 1_900_000_000 };
  for (const [raw, expected] of [[undefined, false], ["false", false], ["true", true]] as const) {
    assert.equal(resolveTradeConfig({ VENUE_PANCAKE_ROUTER: PANCAKE_V2_ROUTER_56, VENUE_WBNB: WBNB_56, ...(raw === undefined ? {} : { TRADFI_PREFLIGHT_SIMULATE: raw }) }, options).preflightSimulate, expected);
  }
  assert.throws(() => resolveTradeConfig({ TRADFI_PREFLIGHT_SIMULATE: "1" }, options));
});
it("SC1 stats fixed positive, negative, zero predictions and inconsistent joins", async t => {
  const row: TradeSimulationReport = { idempotencyKey: `0x${"11".repeat(32)}`, agentId: "a", ownerAddress: OWNER, journalKind: "trade", exposure: "increase", route: "direct",
    outcome: "success", reason: null, blocked: false, bareRevert: false, failReason: null, latencyMs: 124, upstreamMs: 124, outputToken: NV.stock,
    predictionKind: "swap-output", minOutAtomic: 4280760000000000n, predictedOutAtomic: 4323945330964287n, actualOutAtomic: 4323900000000000n,
    actualTxHash: `0x${"22".repeat(32)}`, createdAtMs: 1, journalState: "COMMITTED", hasCallsId: true };
  const summary = summarizeTradeSimulations([row, ...[178, 218, 171, 138].map(latencyMs => ({ ...row, latencyMs, upstreamMs: latencyMs }))]);
  assert.equal(summary.headroomBps.p50, 100n); assert.equal(summary.swapOutput.deviationsPpm[0], -10n); assert.equal(summary.latencyMs.p50, 171); assert.equal(summary.latencyMs.p90, 218);
  const dca = summarizeTradeSimulations([{ ...row, journalKind: "dcaRange", predictionKind: "net-wallet-delta", predictedOutAtomic: -46778000000000000n, actualOutAtomic: -46777000000000000n },
    { ...row, journalKind: "dcaRange", predictionKind: "net-wallet-delta", predictedOutAtomic: 0n, actualOutAtomic: -5n }], 2);
  assert.deepEqual(dca.netWalletDelta.deviationsPpm, [21n]); assert.deepEqual(dca.netWalletDelta.zeroPredictedAbsoluteAtomic, [5n]); assert.equal(dca.headroomBps.count, 0); assert.equal(dca.actualWithoutSimulation, 2);
  assert.equal(simulationJournalClass({ ...row, blocked: true }), "inconsistent"); assert.equal(simulationJournalClass({ ...row, actualTxHash: null }), "committed-unverified");
  const bare = summarizeTradeSimulations([{ ...row, outcome: "reverted", predictedOutAtomic: null, route: "guard", exposure: "reduce", bareRevert: false, failReason: "execution reverted" }]);
  assert.equal(bare.counts["guard-bare-revert"], undefined);
  const named = summarizeTradeSimulations(["constructor", "__proto__", "toString"].map(failReason => ({ ...row, outcome: "failed-other" as const, predictedOutAtomic: null, failReason })));
  assert.deepEqual(new Map(named.failedOtherReasons), new Map([["constructor", 1], ["__proto__", 1], ["toString", 1]]));
  const sql: SqlClient = { async query(text) { assert.ok(text.trim().startsWith("select")); return { rows: [] }; }, transaction: async fn => fn(sql), close: async () => {} };
  await readTradeSimulations(sql, { sinceMs: 0, limit: 100000 }); assert.throws(() => parseStatsArgs(["--since", "invalid"]));
  const previousUrl = process.env["DATABASE_URL"], previousExit = process.exitCode, messages: string[] = [];
  t.mock.method(console, "error", (line: string) => messages.push(line));
  delete process.env["DATABASE_URL"];
  try { await statsMain([]); assert.equal(process.exitCode, 2); assert.deepEqual(messages, ["DATABASE_URL is required"]); }
  finally { if (previousUrl === undefined) delete process.env["DATABASE_URL"]; else process.env["DATABASE_URL"] = previousUrl; process.exitCode = previousExit; }
});
it("PR1/PR2 diagnostic expired guard bytes make exactly one HTTP simulate request", async () => {
  assert.equal(parseProbeArgs(["--wallet", WALLET, "--token", NV.stock, "--case", "direct"]).amountAtomic, 10n ** 18n);
  assert.throws(() => parseProbeArgs(["--wallet", WALLET, "--token", NV.stock, "--case", "direct", "--amount-usdt", "26"]));
  const probe = source("scripts/tradfi-simulate-probe.ts");
  for (const forbidden of ["EXECUTION_MASTER_KEY", ".env.local", "executeViaSession", "submitPreparedTrade", "readExecutingSession", "--yes-live"]) assert.ok(!probe.includes(forbidden));
  const deadline = 1_900_000_000n - 60n;
  const call = buildTradfiGuardSwapCall({ guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
    canonicalUSDT: USDT_56, tokenIn: USDT_56, tokenOut: NV.stock, amountInWei: 1n, minOutWei: 1n, deadline, calldata: "0xad43f73d" });
  for (const raw of [...GUARD_DEADLINE_REASONS, "execution reverted"]) {
    let count = 0;
    const client = new HttpTradeDataPlaneReads({ baseUrl: "https://offline.invalid", fetch: async (url, init) => {
      count += 1; assert.match(String(url), /internal\/binance\/pre-transaction\/simulate$/u);
      const body = JSON.parse(String(init?.body)) as { data: Hex };
      const decoded = decodeFunctionData({ abi: parseAbi(["function execute(bytes32,bytes)"]), data: body.data });
      const [calls] = decodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], decoded.args[1]);
      const guard = decodeFunctionData({ abi: TRADFI_SWAP_GUARD_ABI, data: calls[0]!.data }); assert.equal(guard.args[4], deadline);
      return new Response(JSON.stringify({ data: { version: "binance-simulate-v1", status: "FAILED", failReason: raw, balanceChanges: [], otherChangeCount: 0 } }));
    } });
    const result = await probeGuardDeadline(client, WALLET, [call]); assert.equal(count, 1); assert.equal(result.outcome, raw === "execution reverted" ? "reverted" : "guard-deadline");
    assert.equal(result.decision, "PROCEED"); assert.equal(result.bareRevert, raw === "execution reverted");
  }
});
it("Census SELECT-only schema gate and conservative eligibility cover the whole worker scope", async () => {
  const rows = [
    { agent_id: "native", status: "armed", params: DEFAULT_TRADE_SETTINGS, draining: false, open_positions: "0", dca_phase: null },
    { agent_id: "dca", status: "paused", params: dcaSettings(), draining: false, open_positions: "0", dca_phase: "active" },
    { agent_id: "revoked", status: "revoked", params: dcaSettings(), draining: false, open_positions: "0", dca_phase: null },
    { agent_id: "drain", status: "armed", params: DEFAULT_TRADE_SETTINGS, draining: true, open_positions: "0", dca_phase: null },
    { agent_id: "ai", status: "armed", params: DEFAULT_TRADE_SETTINGS, draining: false, open_positions: "1", dca_phase: null },
  ].map(row => ({ ...row, unsettled_intents: "0", nonterminal_journal: "0" }));
  const statements: string[] = []; let missing = false;
  const sql: SqlClient = { async query<Row>(text: string) {
    statements.push(text); assert.ok(text === "set transaction read only" || text.startsWith("select")); assert.ok(!text.includes("pg_advisory"));
    const result = text.includes("information_schema") ? Object.entries(CENSUS_COLUMNS).flatMap(([table_name, names]) => names.map(column_name => ({ table_name, column_name }))).slice(missing ? 1 : 0)
      : text.includes("where a.status") ? rows.filter(row => row.status === "armed").map(row => ({ agent_id: row.agent_id })) : text.startsWith("select") ? rows : [];
    return { rows: result as unknown as readonly Row[] };
  }, transaction: async fn => fn(sql), close: async () => {} };
  const lines = await readWorkerCensus(sql);
  assert.match(lines[0]!, /entry-capable=yes protective-capable=no$/u); assert.match(lines[1]!, /entry-capable=no protective-capable=yes$/u);
  assert.match(lines[2]!, /entry-capable=no protective-capable=no$/u); assert.match(lines[3]!, /entry-capable=yes protective-capable=yes$/u);
  assert.match(lines[4]!, /entry-capable=yes protective-capable=yes$/u);
  missing = true; statements.length = 0; await assert.rejects(readWorkerCensus(sql), /census: schema not installed/u); assert.equal(statements.length, 2);
});
