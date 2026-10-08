/**
 * FOURMEME-CURVE-PAPER-SPEC 8.2: per-row byte identity. Every digest below was recorded at the BASE commit 6d5d2af (before any source change) by running this
 * file with MEME_RECORD=1, inside memeWorld whose Date.now is the fake clock, so every timing field is deterministic. After the change every report, event
 * list, log row and paper row hashes to the base digest except the one intended difference of scenario (d): the brain verdict of a Four.meme curve row with no tax
 * (`screen:fourmeme-curve` before, `screen:tax-unknown` now), asserted explicitly and normalised back before hashing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runAgenticMemeStep } from "../src/agentic/memeLane.js";
import { memeJevRequest } from "../src/agentic/memeJev.js";
import { MEME2, QUOTE, eligibilityRow, memeWorld, passingBars, shortlistRow, type MemeWorld } from "./support/agenticMeme.js";
import { agenticAddress } from "../src/agentic/domain.js";

const CURVE = agenticAddress("0xafafafafafafafafafafafafafafafafafafafaf");
const FLAP_CURVE = agenticAddress("0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0");
const RECORDED: Readonly<Record<string, string>> = {
  "flap-curve": "fd98522961501db7b6480c17459edf1dcd59ed2bde405548181071167f2d54bb",
  "flap-graduated": "f12592059092b9828dde8c9dc7d3ff8ba0f7ff034dcaaa2be3092975f2bc93e8",
  "fourmeme-graduated": "da7d5ef0c0db3cdd2fe00c701a95a179cc4286bb7c58a52628a4959297a00197",
  "mixed-shortlist": "afae5c8c1b7d2d8364910de082c8c8878352d89acef6ca9125838f5bf22334c2",
  "prompt-and-jev": "ab7b2a691f7839f973f136346cbb4a2ba975168d49546eaad952503f5936a251",
};
const record = process.env["MEME_RECORD"] === "1";
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v)).digest("hex");
function check(name: string, value: unknown): void {
  const digest = sha(value);
  if (record) { console.log(`RECORDED ${name} ${digest}`); return; }
  assert.equal(digest, RECORDED[name], name);
}
type Step = Awaited<ReturnType<typeof runAgenticMemeStep>>;
const step = async (world: MemeWorld): Promise<Step> => runAgenticMemeStep(world.deps(), (await world.f.store.byAgent(world.agentId))!);
const state = async (world: MemeWorld, reports: Step["report"][]) => ({ reports, logs: await world.f.store.memeLog(null, 0, Number.MAX_SAFE_INTEGER), paper: await world.f.store.paperList(world.agentId),
  quotes: world.market.quotes, llm: world.llmCalls.map(c => ({ model: c.model, messages: c.messages })) });
const four = (w: MemeWorld, rows: Record<string, unknown>[]) => { w.plane.rows = rows; };

test("(a) a Flap curve entry, three marks and a trailing exit (taxes 300 / 500)", async (t) => {
  const world = await memeWorld(t);
  world.plane.rows = [shortlistRow(world.clock.now, { venue: "flap-bonding" })];
  world.plane.eligibility = [eligibilityRow(world.clock.now, { venue: "flap-bonding" }, { status: 1, progress: "500000000000000000" })];
  const reports = [(await step(world)).report];
  assert.equal(reports[0]!.code, "meme-entered");
  world.plane.down.add("memeShortlist");
  for (const den of [4_000n, 2_500n, 2_500n, 3_000n]) {
    await world.at(world.clock.now + 60_000);
    world.market.sell = { num: 1n, den };
    reports.push((await step(world)).report);
  }
  const closed = (await world.f.store.paperList(world.agentId))[0]!;
  assert.equal(closed.closeCode, "trailing");
  check("flap-curve", await state(world, reports));
});

test("(b) a Flap graduated entry and a stop exit (the default fixture, 300 / 500)", async (t) => {
  const world = await memeWorld(t);
  const reports = [(await step(world)).report];
  assert.equal(reports[0]!.code, "meme-entered");
  world.plane.down.add("memeShortlist");
  await world.at(world.clock.now + 60_000);
  world.market.sell = { num: 1n, den: 8_000n };
  reports.push((await step(world)).report);
  assert.equal((await world.f.store.paperList(world.agentId))[0]!.closeCode, "stop");
  check("flap-graduated", await state(world, reports));
});

test("(c) a graduated Four.meme entry and one mark (the lane.test.ts hotfix fixture)", async (t) => {
  const world = await memeWorld(t);
  world.plane.rows = [shortlistRow(world.clock.now, { launchpad: "fourmeme", tax: { buyBps: 0, sellBps: 0 } })];
  world.plane.eligibility = [eligibilityRow(world.clock.now, { source: "fourmeme", reason: "fourmeme_factory", flap: null,
    fourmeme: { version: 2, tokenManager: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", quote: QUOTE, launchTime: 0, liquidityAdded: true } })];
  const reports = [(await step(world)).report];
  assert.equal(reports[0]!.code, "meme-entered");
  world.plane.down.add("memeShortlist");
  await world.at(world.clock.now + 60_000);
  reports.push((await step(world)).report);
  check("fourmeme-graduated", await state(world, reports));
});

test("(d) one shortlist row of each kind plus a fourmeme-bonding row with no tax: the only difference is that row's verdict", async (t) => {
  const world = await memeWorld(t);
  four(world, [shortlistRow(world.clock.now), shortlistRow(world.clock.now, { address: MEME2, launchpad: "fourmeme", tax: { buyBps: 0, sellBps: 0 } }),
    shortlistRow(world.clock.now, { address: FLAP_CURVE, venue: "flap-bonding" }),
    shortlistRow(world.clock.now, { address: CURVE, launchpad: "fourmeme", venue: "fourmeme-bonding", tax: null }),
    shortlistRow(world.clock.now, { address: "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e", launchpad: "pumpfun" })]);
  for (const address of [MEME2, FLAP_CURVE, CURVE]) world.plane.bars.set(address, { bars: passingBars(world.clock.now) });
  const reports = [(await step(world)).report];
  const logs = await world.f.store.memeLog(null, 0, Number.MAX_SAFE_INTEGER);
  const market = logs.find(r => r.kind === "market")!.data as { rows: [unknown[], string[]][] };
  const verdict = market.rows[3]![1]![0]!;
  if (!record) assert.equal(verdict, "screen:tax-unknown", "the one intended difference (spec 8.2 d)");
  // The one verdict appears as the brain tuple's code and as the key of the cycle's screen counter; both map back to the base name (only this row carries a null tax).
  const normalised = JSON.parse(JSON.stringify({ reports, logs, paper: await world.f.store.paperList(world.agentId) }, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v)
    .replaceAll('"screen:tax-unknown"', '"screen:fourmeme-curve"')) as unknown;
  check("mixed-shortlist", normalised);
});

test("the LLM prompt and the Jev request of a Flap-only candidate set equal their base strings", async (t) => {
  const world = await memeWorld(t);
  await step(world);
  const user = world.llmCalls[0]!.messages[1]!.content;
  check("prompt-and-jev", { messages: world.llmCalls[0]!.messages, shadow: memeJevRequest(user, 1, false), scan: memeJevRequest(user, 1, true) });
});

