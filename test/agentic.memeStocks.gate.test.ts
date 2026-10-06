/** AGENTIC-MEME-STOCKS-SPEC 9.6: meme-data and meme-log write nothing, the meme dry run writes nothing, meme-close is operator-only and changes one row. */
import assert from "node:assert/strict";
import test from "node:test";
import { parseAgenticGateArgs, runAgenticGate, agenticGateWallets, type AgenticGateContext } from "../scripts/agentic-gate.js";
import { W, fixture } from "./support/agenticSchedule.js";
import { MEME2, memeWorld, paperRow, type MemeWorld } from "./support/agenticMeme.js";

function context(world: MemeWorld, printed: unknown[], wallets = agenticGateWallets(W)): AgenticGateContext {
  const f = world.f;
  return { store: f.store, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, runner: f.runner, chain: f.chain, masterKey: f.execution.masterKey,
    instance: f.instance, wallets, meme: { worker: f.worker, enabled: true }, print: value => printed.push(value), cycle: async () => { throw new Error("no cycle"); } };
}
async function snapshot(world: MemeWorld) {
  return JSON.stringify({ paper: await world.f.store.paperList(world.agentId), log: await world.f.store.memeLog(null, 0, Number.MAX_SAFE_INTEGER),
    runs: await world.f.positions.listRuns(W, world.agentId, 50), orders: await world.f.store.orders() }, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v);
}

test("meme-data, meme-log and the meme dry run write nothing", async (t) => {
  const world = await memeWorld(t);
  await world.f.store.insertPaper(paperRow(world, { token: MEME2 }));
  await world.f.store.insertMemeLog({ id: "market:1", agentId: null, kind: "market", token: null, atMs: 5, data: {} });
  await world.f.store.insertMemeLog({ id: "cycle:x", agentId: "other-agent", kind: "cycle", token: null, atMs: 6, data: {} });
  const before = await snapshot(world), printed: unknown[] = [];
  await runAgenticGate(parseAgenticGateArgs(["meme-data"]), context(world, printed));
  assert.equal((printed[0] as { rows: number }).rows, 1);
  await runAgenticGate(parseAgenticGateArgs(["meme-log", "--agent", world.agentId, "--since", "0"]), context(world, printed));
  assert.deepEqual(printed.slice(1).map(row => (row as { id: string }).id), ["market:1"], "the agent's rows and the market rows, not another agent's");
  await runAgenticGate(parseAgenticGateArgs(["dry-run", "--agent", world.agentId]), context(world, printed));
  const report = printed.at(-1) as { code: string; logs: unknown[] };
  assert.equal(report.code, "meme-entered", "the dry run prints the decision it would take");
  assert.ok(report.logs.length > 0);
  assert.equal(await snapshot(world), before, "nothing written");
  assert.ok(world.f.runner.calls.every(args => args.slice(0, 2).join(" ") === "market-order quote"), "quotes are reads");
});

test("meme-close: refuses a wallet outside AGENTIC_GATE_WALLETS, a non-meme hire, an unknown ref and a closed position; otherwise sets only close_requested_at and version", async (t) => {
  const world = await memeWorld(t);
  await world.f.store.insertPaper(paperRow(world));
  await world.f.store.insertPaper(paperRow(world, { token: MEME2, positionId: "closed", status: "closed", closedAt: 1, openedAt: world.clock.now }));
  const printed: unknown[] = [];
  const close = (ref: string, wallets?: ReturnType<typeof agenticGateWallets>) => runAgenticGate(parseAgenticGateArgs(["meme-close", "--agent", world.agentId, "--ref", ref]), context(world, printed, wallets));
  await assert.rejects(close("m0", agenticGateWallets("0x9999999999999999999999999999999999999999")), /AGENTIC_GATE_CONFINEMENT/u);
  await assert.rejects(close("m7"), /AGENTIC_GATE_POSITION/u);
  await assert.rejects(close("x0"), /AGENTIC_GATE_POSITION/u);
  await assert.rejects(close("m1"), /AGENTIC_GATE_POSITION/u);
  const [beforeOpen] = await world.f.store.paperList(world.agentId);
  await close("m0");
  const [after] = await world.f.store.paperList(world.agentId);
  assert.deepEqual({ ...after, closeRequestedAt: null, version: beforeOpen!.version }, beforeOpen);
  assert.deepEqual([after!.closeRequestedAt, after!.version], [world.clock.now, beforeOpen!.version + 1]);
  const ai = await fixture(t);
  await assert.rejects(runAgenticGate(parseAgenticGateArgs(["meme-close", "--agent", ai.agent.id, "--ref", "m0"]), { ...context(world, printed), store: ai.store, agents: ai.agents }), /AGENTIC_GATE_NOT_MEME/u);
});
