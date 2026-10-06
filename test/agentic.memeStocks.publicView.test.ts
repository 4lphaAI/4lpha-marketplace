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
  const dto = await view(world.f)(W);
  const agent = dto.agent as unknown as Record<string, unknown> & { meme: { mode: string; tokens: unknown[]; paper: { summary: Record<string, unknown>; positions: Record<string, unknown>[] } } };
  assert.equal(agent.meme.mode, "paper");
  assert.deepEqual(agent["positions"], []);
  assert.deepEqual(agent["pinned"], []);
  assert.deepEqual(agent.meme.paper.summary, { open: 1, closed: 1, wins: 0, pnlUsdtWei: (-4n * E).toString(), winRateBps: 0 });
  assert.deepEqual(agent.meme.paper.positions.map(p => p["ref"]), ["m0", "m1"]);
  assert.equal(agent.meme.tokens.length, 2);
  assert.ok(!JSON.stringify(agent.meme).includes("secret-closed-id") && !JSON.stringify(agent.meme).includes(world.agentId), "no internal id");
  assert.equal(agent.meme.paper.positions[0]!["closeCode"], "stop", "ordered by openedAt, as meme-close counts refs");
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
