/** AGENTIC-MEME-STOCKS-SPEC 9.3: the public `meme` key of a paper meme hire, built only from the paper rows. */
import assert from "node:assert/strict";
import test from "node:test";
import { createAgenticPublicView } from "../src/agentic/publicView.js";
import { E, W, fixture, type Fixture } from "./support/agenticSchedule.js";
import { MEME2, memeWorld, paperRow } from "./support/agenticMeme.js";

const view = (f: Fixture) => createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore,
  killswitch: f.killswitch, observer: { observe: async () => [] } });

test("meme.paper is built from the paper rows only, labelled paper; real positions empty; pinned []; the AI key set plus meme; refs only", async (t) => {
  const world = await memeWorld(t);
  await world.f.store.insertPaper(paperRow(world, { lastMarkUsdt: (12n * E).toString(), lastMarkAt: world.clock.now }));
  await world.f.store.insertPaper(paperRow(world, { token: MEME2, positionId: "secret-closed-id", status: "closed", closeCode: "stop", exitUsdt: (6n * E).toString(), gasSellUsdt: "1",
    pnlUsdt: (-4n * E).toString(), closedAt: world.clock.now, openedAt: world.clock.now - 120_000 }));
  // Operator 2026-10-07: the open position's own entry row carries the market cap at entry; the closed one has none.
  const open = (await world.f.store.paperList(world.agentId)).find(p => p.status === "open")!;
  await world.f.store.insertMemeLog({ id: `entry:${open.positionId}`, agentId: world.agentId, kind: "entry", token: open.token, atMs: open.openedAt, data: { positionId: open.positionId, mcapUsd: 32_551.15 } });
  await world.f.store.insertMemeLog({ id: `entry:other`, agentId: world.agentId, kind: "entry", token: open.token, atMs: open.openedAt + 1, data: { positionId: "other", mcapUsd: 1 } });
  const dto = await view(world.f)(W);
  const agent = dto.agent as unknown as Record<string, unknown> & { meme: { mode: string; tokens: unknown[]; paper: { summary: Record<string, unknown>; positions: Record<string, unknown>[] } } };
  assert.deepEqual(agent.meme.paper.positions.map(p => p["entryMcapUsd"]), [null, 32_551.15], "market cap at entry from the position's own entry row; none recorded is null");
  assert.equal(agent.meme.mode, "paper");
  assert.deepEqual(agent["positions"], []);
  assert.deepEqual(agent["pinned"], []);
  assert.deepEqual(agent.meme.paper.summary, { open: 1, closed: 1, wins: 0, pnlUsdtWei: (-4n * E).toString(), winRateBps: 0 });
  assert.deepEqual(agent.meme.paper.positions.map(p => p["ref"]), ["m0", "m1"]);
  assert.equal(agent.meme.tokens.length, 2);
  assert.ok(!JSON.stringify(agent.meme).includes("secret-closed-id") && !JSON.stringify(agent.meme).includes(world.agentId), "no internal id");
  assert.equal(agent.meme.paper.positions[0]!["closeCode"], "stop", "ordered by openedAt, as meme-close counts refs");
  // Hotfix 2026-10-06 (detail parity): closed PnL in USDT is the booked pnlUsdt; open PnL is mark - (entry + buy gas), the basis pnlBps uses.
  const pick = (p: Record<string, unknown>) => [p["tokens"], p["pnlUsdtWei"], p["peakPnlBps"], p["costBps"]];
  assert.deepEqual(pick(agent.meme.paper.positions[0]!), [(38_800n * E).toString(), (-4n * E).toString(), null, 1_000]);
  assert.deepEqual(pick(agent.meme.paper.positions[1]!), [(38_800n * E).toString(), (12n * E - 10n * E - 40_510_500_000_000_000n).toString(), null, 1_000]);
  const ai = await fixture(t);
  const aiKeys = Object.keys((await view(ai)(W)).agent as object).sort();
  assert.deepEqual(Object.keys(agent).filter(key => key !== "meme").sort(), aiKeys, "the AI-hire key set is unchanged");
  assert.equal(Object.hasOwn((await view(ai)(W)).agent as object, "meme"), false);
});

test("a paper hire with no closed trade has no PnL and no win rate (a dash with its reason on the screen, never a zero)", async (t) => {
  const world = await memeWorld(t);
  const dto = await view(world.f)(W);
  assert.deepEqual((dto.agent as unknown as { meme: { paper: { summary: unknown } } }).meme.paper.summary, { open: 0, closed: 0, wins: 0, pnlUsdtWei: null, winRateBps: null });
});

test("hotfix 2026-10-06: lastCycle is the newest cycle as counts (lane tallies are not reasons, no internal id); decisionLog only with AGENTIC_MEME_DECISION_LOG_PUBLIC exactly true", async (t) => {
  const world = await memeWorld(t);
  const now = await world.f.store.now(), key = "AGENTIC_MEME_DECISION_LOG_PUBLIC", before = process.env[key];
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  const agentOf = async (): Promise<{ meme: Record<string, unknown> }> => (await view(world.f)(W)).agent as unknown as { meme: Record<string, unknown> };
  delete process.env[key];
  assert.equal((await agentOf()).meme["lastCycle"], null, "no cycle row yet: null, never zeros");
  await world.f.store.insertMemeLog({ id: `cycle:${world.agentId}:${now - 60_000}`, agentId: world.agentId, kind: "cycle", token: null, atMs: now - 60_000, data: { code: "meme-idle", counts: {} } });
  await world.f.store.insertMemeLog({ id: `cycle:${world.agentId}:${now}`, agentId: world.agentId, kind: "cycle", token: null, atMs: now, data: { code: "meme-no-candidate",
    picked: { flap: 21, fourmeme: 1 }, survivors61: 17, barsRequested: 17, barLagMedianMs: 25_005, elapsedMs: 1_001,
    counts: { "no-burst": 14, "screen:flow-unknown": 4, llmAsked: 1, entered: 0, quoteFailures: 2 } } });
  await world.f.store.insertMemeLog({ id: `market:${now}`, agentId: null, kind: "market", token: null, atMs: now, data: { rows: [[
    [MEME2, "flap", "graduated", "active", null, "pancake-v2", 0, 100, 5_000, 0.001, 300, 12, 8, 2, 50, 40, -10, now, 20, now, "0x4902c5ebc598265ed2212b559b042de8a5eeec3f", "BNCB", true, false, ["bstock_quote"]],
    ["no-burst", 25_000, now - 85_000, 60, 0.001, 12, false, 1, 1.4, "volume", null, null, 900, 450]]] } });
  const off = await agentOf();
  assert.deepEqual(off.meme["lastCycle"], { atMs: now, code: "meme-no-candidate", listSize: 22, checked: 17, passedScreen: 17, reasons: { "no-burst": 14, "screen:flow-unknown": 4 },
    llmAsked: 1, paperEntries: 0, paperExits: 0, barLagMs: 25_005, elapsedMs: 1_001 });
  assert.equal(Object.hasOwn(off.meme, "decisionLog"), false, "flag unset: no decision log");
  assert.ok(!JSON.stringify(off.meme).includes(world.agentId), "no internal id");
  process.env[key] = "yes";
  assert.equal(Object.hasOwn((await agentOf()).meme, "decisionLog"), false, "anything but exactly true is off");
  process.env[key] = "true";
  const on = await agentOf(), log = on.meme["decisionLog"] as { market: { atMs: number; rows: Record<string, unknown>[] } | null; signals: unknown[]; llm: unknown[] };
  assert.equal(log.market?.atMs, now);
  assert.deepEqual([log.market?.rows[0]?.["address"], log.market?.rows[0]?.["verdict"], log.market?.rows[0]?.["burstRatio"], log.market?.rows[0]?.["costEstBps"], log.market?.rows[0]?.["quoteSymbol"],
    log.market?.rows[0]?.["flow5mBuys"], log.market?.rows[0]?.["smart5mNetUsd"]], [MEME2, "no-burst", 1.4, 450, "BNCB", 8, -10]);
  assert.deepEqual([log.signals, log.llm], [[], []]);
  assert.ok(!JSON.stringify(on.meme).includes(world.agentId), "no internal id with the log on");
});

test("hotfix 2026-10-07: a paper meme hire keeps 24 h of cycles; the public runs are the latest 50 plus every notable cycle of those 24 h; a Binance refusal code stays readable", async (t) => {
  const world = await memeWorld(t);
  const run = (reason: string, extra: Record<string, number> = {}) => world.f.positions.insertRun({ agentId: world.agentId, ownerAddress: W, dryRun: false, reason,
    events: [{ stage: "cycle", code: reason, elapsedMs: 1 }], ...extra });
  await run("meme-llm:reject", { candidates: 1 });
  world.clock.advance(60_000); await run("meme-refused:SERVICE_ERROR");
  world.clock.advance(60_000); await run("meme-no-candidate", { exits: 1 });
  for (let i = 0; i < 300; i += 1) { world.clock.advance(60_000); await run("meme-no-candidate"); }
  const reasons = async () => ((await view(world.f)(W)).agent as unknown as { runs: { reason: string; exits: number }[] }).runs;
  const listed = await reasons();
  assert.equal(listed.length, 53, "latest 50 + the model ask + the refusal + the paper exit, all older than the latest 50");
  assert.deepEqual(listed.slice(-3).map(r => r.reason), ["meme-no-candidate", "meme-refused:SERVICE_ERROR", "meme-llm:reject"], "newest first");
  assert.equal((await world.f.positions.listNotableMemeRuns!(W, world.agentId, 0)).length, 3, "302 quiet cycles are not notable; the paper exit is");
  // After 24 h the non-executed meme cycles fall back to the generic 200-row prune; the paper exit run survives like any executed run.
  world.clock.advance(86_400_000); await run("meme-no-candidate");
  const after = await reasons();
  assert.equal(after.some(r => r.reason === "meme-llm:reject" || r.reason === "meme-refused:SERVICE_ERROR"), false);
  assert.equal(after.filter(r => r.exits === 1).length, 0, "older than the 24 h listing window");
  assert.equal((await world.f.positions.listExecutedRuns(W, world.agentId)).length, 1, "the paper exit run is still stored");
});
