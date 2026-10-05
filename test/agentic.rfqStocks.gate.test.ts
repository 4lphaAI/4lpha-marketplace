/** AGENTIC-RFQ-STOCKS 4.13 (E13, OQ-7): the gate tool's rfq-buy and the gate-only submitTradfiV2GateBuy. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import type { Address } from "viem";
import { agenticGateWallets, parseAgenticGateArgs, runAgenticGate } from "../scripts/agentic-gate.js";
import { agenticAddress, type AgenticGateRun } from "../src/agentic/domain.js";
import { submitTradfiV2GateBuy } from "../src/trade/worker.js";
import { admittedVenueRows } from "../src/trade/rwa.js";
import { E, NOW, TOKEN, W, aiParams, fixture, type Fixture } from "./support/agenticSchedule.js";
import { loadRfqUniverse } from "./support/agenticRfq.js";
import { fakeRfqStocks, worldHarness } from "./support/agenticRfqWorker.js";

const OTHER = agenticAddress("0x3333333333333333333333333333333333333333");
const rfqFacts = (base: NonNullable<Fixture["row"]["hireFacts"]>) => ({ ...base, pinned: [TOKEN, OTHER], rfq: { v: 1 as const, notionalWei: (20n * E).toString(), pooledCount: 1, rfqOnly: [TOKEN], costs: [] } });

async function gate(t: TestContext, options: { marker?: boolean; wallets?: ReadonlySet<Address>; rfqEnabled?: boolean } = {}) {
  const base = (await fixture(t)).row.hireFacts!;
  const f = await fixture(t, options.marker === false ? {} : { hireFacts: rfqFacts(base) });
  const calls: { agentId: string; token: Address; live: boolean }[] = [];
  const printed: unknown[] = [];
  const context = { ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets: options.wallets ?? agenticGateWallets(W),
    print: (value: unknown) => printed.push(value), cycle: async () => undefined, ...(options.rfqEnabled === false ? {} : { rfqEnabled: true }),
    rfqBuy: async (input: { agentId: string; token: Address; live: boolean }) => { calls.push({ agentId: input.agentId, token: input.token, live: input.live }); return { result: "priced" }; } };
  const run = async (patch: Partial<AgenticGateRun> = {}): Promise<AgenticGateRun> => {
    const created: AgenticGateRun = { runId: "11111111-1111-4111-8111-111111111111", gate: "RG2", side: "buy", agentId: f.agent.id, wallet: W, maxDispatches: 1, dispatches: 0, maxNotionalUsdt: "5",
      maxCmcPayments: 0, cmcPayments: 0, cmcOperationIds: [], deadlineMs: NOW + 1_800_000, createdAt: NOW, closedAt: null, ...patch };
    assert.ok(await f.store.createRun(created));
    return created;
  };
  const go = (argv: string[]) => runAgenticGate(parseAgenticGateArgs(argv), context as never);
  return { f, calls, printed, run, go };
}
const buy = (run: AgenticGateRun, token: string = TOKEN, extra: string[] = []) => ["rfq-buy", "--run", run.runId, "--token", token, ...extra];

test("parsing: rfq-buy takes --run, --token and --yes-live only; run-start accepts RG1..RG4", async (t) => {
  assert.deepEqual(parseAgenticGateArgs(buy({ runId: "r" } as AgenticGateRun, TOKEN, ["--yes-live"])).live, true);
  for (const extra of ["--agent", "--side", "--max-notional-usdt"]) assert.throws(() => parseAgenticGateArgs([...buy({ runId: "r" } as AgenticGateRun), extra, "x"]), /AGENTIC_GATE_ARGUMENT/u, extra);
  const g = await gate(t);
  for (const name of ["RG1", "RG2", "RG3", "RG4"]) {
    await g.go(["run-start", "--gate", name, "--agent", g.f.agent.id, "--side", "buy", "--max-dispatches", "1", "--max-notional-usdt", "5", "--max-cmc-payments", "0", "--deadline-min", "30"]);
    assert.equal((g.printed.at(-1) as AgenticGateRun).gate, name);
  }
  await assert.rejects(g.go(["run-start", "--gate", "RG5", "--agent", g.f.agent.id, "--side", "buy", "--max-dispatches", "1", "--max-notional-usdt", "5", "--max-cmc-payments", "0", "--deadline-min", "30"]), /AGENTIC_GATE_LIMITS/u);
});

test("rfq-buy is dry by default and live only with --yes-live; the call carries the agent, the token and the live flag", async (t) => {
  const g = await gate(t), run = await g.run();
  await g.go(buy(run));
  await g.go(buy(run, TOKEN.toUpperCase().replace("0X", "0x"), ["--yes-live"]));
  assert.deepEqual(g.calls, [{ agentId: g.f.agent.id, token: TOKEN, live: false }, { agentId: g.f.agent.id, token: TOKEN, live: true }]);
});

test("rfq-buy confinement: every refusal happens before any quote or command", async (t) => {
  const refuse = async (label: string, options: Parameters<typeof gate>[1], patch: Partial<AgenticGateRun>, token: string, code: RegExp) => {
    const g = await gate(t, options), run = await g.run(patch);
    await assert.rejects(g.go(buy(run, token)), code, label);
    assert.equal(g.calls.length, 0, label);
  };
  await refuse("flag off in the gate's environment", { rfqEnabled: false }, {}, TOKEN, /AGENTIC_GATE_RFQ_DISABLED/u);
  await refuse("wallet outside AGENTIC_GATE_WALLETS", { wallets: agenticGateWallets(OTHER) }, {}, TOKEN, /AGENTIC_GATE_CONFINEMENT/u);
  await refuse("a hire without the rfq marker", { marker: false }, {}, TOKEN, /AGENTIC_GATE_RFQ_NOT_ACTIVE/u);
  await refuse("a sell run", {}, { side: "sell" }, TOKEN, /AGENTIC_GATE_CLOSED/u);
  await refuse("no free dispatch slot", {}, { dispatches: 1 }, TOKEN, /AGENTIC_GATE_CLOSED/u);
  await refuse("a closed run", {}, { closedAt: NOW }, TOKEN, /AGENTIC_GATE_CLOSED/u);
  await refuse("an expired run", {}, { deadlineMs: NOW }, TOKEN, /AGENTIC_GATE_CLOSED/u);
  await refuse("a pooled token (pinned, not RFQ-only)", {}, {}, OTHER, /AGENTIC_GATE_TOKEN/u);
  await refuse("a token that is not pinned", {}, {}, "0x4444444444444444444444444444444444444444", /AGENTIC_GATE_TOKEN/u);
  await refuse("a malformed token", {}, {}, "0x12", /AGENTIC_GATE_TARGET/u);
  await refuse("the minimum entry exceeds the run's notional cap", {}, { maxNotionalUsdt: "4.99" }, TOKEN, /AGENTIC_GATE_LIMITS/u);
});

test("rfq-buy refuses an unknown run", async (t) => {
  const g = await gate(t);
  await assert.rejects(g.go(["rfq-buy", "--run", "99999999-9999-4999-8999-999999999999", "--token", TOKEN]), /AGENTIC_GATE_TARGET/u);
});

const T = Date.UTC(2026, 9, 2, 15, 45, 0);
async function gateWorld(t: TestContext, options: { rfq?: boolean; quote?: Parameters<typeof fakeRfqStocks>[0]["quote"] } = {}) {
  t.mock.method(Date, "now", () => T);
  const rows = await loadRfqUniverse(true);
  const amd = rows.find((row) => row.symbol === "AMDB")!.address, nvda = rows.find((row) => row.symbol === "NVDAB")!.address;
  const fake = fakeRfqStocks({ entries: options.rfq ?? true, rfqOnlyAtHire: [amd], quote: options.quote ?? ((call) => call.side === "buy" ? { ok: true, outAtomic: 7_900_000_000_000_000n } : { ok: true, outAtomic: 4_900_000_000_000_000_000n }) });
  const world = await worldHarness({ now: () => T, rows, custody: "binance-agentic", pinned: rows.map((row) => row.address), settings: { maxOpenPositions: 1 }, extraDeps: { rfqStocks: fake.dep } });
  const settingsRow = (await world.settingsStore.get(world.owner, world.agent.id))!;
  const gateBuy = (token: Address, live: boolean) => submitTradfiV2GateBuy(world.deps, world.agent, settingsRow, token, { live });
  return { world, fake, amd, nvda, gateBuy, rows };
}

test("dry: prices the buy at the minimum entry (quote, premium, exit check, minOut), prints the numbers and writes nothing", async (t) => {
  const w = await gateWorld(t);
  const result = await w.gateBuy(w.amd, false);
  assert.equal(result.result, "priced");
  assert.deepEqual(result.numbers, { amountAtomic: (5n * E).toString(), quotedOutAtomic: "7900000000000000", minOutAtomic: (7_900_000_000_000_000n * 9_900n / 10_000n).toString() });
  assert.deepEqual(w.fake.calls.map((call) => call.side), ["buy", "sell"]);
  assert.equal(w.world.submitted.length, 0);
  assert.deepEqual(await w.world.positions.listRuns(w.world.owner, w.world.agent.id, 5), [], "no run row");
  assert.equal((await w.world.intents.listUnsettled(w.world.owner, w.world.agent.id)).length, 0);
  assert.equal(w.world.llm.entryCalls + w.world.llm.exitCalls, 0, "no model call");
});

test("live: one buy through the executor with the RFQ marker, a run row, no score, no model, no pacing", async (t) => {
  const w = await gateWorld(t);
  const result = await w.gateBuy(w.amd, true);
  assert.equal(result.result, "entered");
  assert.equal(w.world.submitted.length, 1);
  assert.deepEqual([w.world.submitted[0]!.side, w.world.submitted[0]!.amountWei, w.world.submitted[0]!.token.toLowerCase()], ["buy", 5n * E, w.amd.toLowerCase()]);
  assert.equal(w.world.llm.entryCalls, 0);
  assert.equal((await w.world.positions.listOpen(w.world.owner, w.world.agent.id)).length, 1);
  assert.equal((await w.world.positions.listRuns(w.world.owner, w.world.agent.id, 5)).length, 1);
  assert.ok(result.events.some((event) => event.code === "binance-rfq"));
});

test("refusals: a pooled token, an agent without the marker or with entries off, a full book and a failed exit check", async (t) => {
  const pooled = await gateWorld(t);
  assert.equal((await pooled.gateBuy(pooled.nvda, true)).result, "not-rfq-only");
  assert.equal(pooled.world.submitted.length, 0);
  assert.equal(admittedVenueRows(pooled.rows.find((row) => row.symbol === "NVDAB")!.venues).length > 0, true);
  const off = await gateWorld(t, { rfq: false });
  assert.equal((await off.gateBuy(off.amd, true)).result, "rfq-not-active");
  const noExit = await gateWorld(t, { quote: (call) => call.side === "buy" ? { ok: true, outAtomic: E / 100n } : { ok: false, code: "rfq-unreachable" } });
  assert.equal((await noExit.gateBuy(noExit.amd, true)).result, "no-route");
  assert.equal(noExit.world.submitted.length, 0);
  const full = await gateWorld(t);
  await full.world.positions.open({ positionId: "held", agentId: full.world.agent.id, ownerAddress: full.world.owner, token: full.nvda, route: { hops: [], fees: [100] }, entryWei: 5n * E, tokenAmount: E,
    fillStatus: "verified", openedAt: T - 1, sessionGeneration: 1, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${"0x" + "66".repeat(32)}|${"0x2222222222222222222222222222222222222222"}|0|${"0x" + "66".repeat(32)}` });
  assert.equal((await full.gateBuy(full.amd, true)).result, "at-capacity");
});

test("source scan: scripts/agentic-gate.ts is the only importer of submitTradfiV2GateBuy", () => {
  const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && /\.(ts|tsx|mjs|cjs)$/u.test(entry.name))
    .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/"));
  const users = [...files("src"), ...files("scripts")].filter((path) => !path.includes("/tmp/") && readFileSync(path, "utf8").includes("submitTradfiV2GateBuy")).map((path) => path.replace(/^.*\/(src|scripts)\//u, "$1/"));
  assert.deepEqual(users.sort(), ["scripts/agentic-gate.ts", "src/trade/worker.ts"]);
  void aiParams;
});
