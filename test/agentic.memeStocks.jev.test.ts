/** JEV-MEME-BENCHMARK-PLAN 3.5: the Jev shadow of the meme arbiter (3.1, 3.2) and the Jev-only scan of dropped tokens (3.3), over an offline world with a fake fetch. Nothing here may change a decision. */
import assert from "node:assert/strict";
import test from "node:test";
import { agenticAddress, type AgenticMemeLog } from "../src/agentic/domain.js";
import { createAgenticPublicView } from "../src/agentic/publicView.js";
import { memeDecisionLog, memeLastCycle } from "../src/agentic/memePublic.js";
import { MEME_DOCTRINE } from "../src/agentic/memeBrain.js";
import { AGENTIC_DDL } from "../src/agentic/store.js";
import { runAgenticCycle } from "../src/agentic/worker.js";
import { runAgenticMemeStep, type MemeStepDeps } from "../src/agentic/memeLane.js";
import { askMemeJev, memeJevConfig, memeJevRequest, parseMemeJev } from "../src/agentic/memeJev.js";
import { W } from "./support/agenticSchedule.js";
import { MEME, MEME2, eligibilityRow, memeWorld, passingBars, shortlistRow, type MemeWorld } from "./support/agenticMeme.js";

const MEME3 = agenticAddress("0xadadadadadadadadadadadadadadadadadadadad");
const MEME4 = agenticAddress("0xaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae");
type Body = { model: string; state: { candidates: Record<string, unknown>[] }; questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> };
type Choice = "buy_now" | "wait" | "reject";
const P = { buy_now: { buy_now: 1, wait: 0, reject: 0 }, wait: { buy_now: 0, wait: 1, reject: 0 }, reject: { buy_now: 0, wait: 0, reject: 1 } } as const;
/** A valid System One answer set: every question id answered with the given choice (or the per-id choice). */
const answers = (body: Body, choice: Choice | Record<string, Choice>) => new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 1234 },
  answers: Object.fromEntries(Object.keys(body.questions).map(id => { const c = typeof choice === "string" ? choice : choice[id]!; return [id, { type: "choice", choice: c, probabilities: P[c], confidence: 0.9 }]; })) }));
const named = (name: string, message = "x") => Object.assign(new Error(message), { name });
const macro = async (times = 3): Promise<void> => { for (let i = 0; i < times; i += 1) await new Promise<void>(resolve => setImmediate(resolve)); };

type Call = { url: string; init: RequestInit; body: Body; signal: AbortSignal };
const BEHAVIOURS = {
  hostile: async (body: Body) => answers(body, "buy_now"),
  invalid: async () => new Response("not json at all"),
  timeout: async () => { throw named("TimeoutError"); },
  late: (_body: Body, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => { signal.addEventListener("abort", () => reject(named("AbortError")), { once: true }); }),
  network: async () => { throw new TypeError("fetch failed"); },
  /** Never settles and ignores its signal (review L12). */
  stall: () => new Promise<Response>(() => undefined),
} as const;
const EXPECTED: Record<keyof typeof BEHAVIOURS, string> = { hostile: "ok", invalid: "invalid", timeout: "timeout", late: "late", network: "error", stall: "late" };
const fake = (calls: Call[], handler: (body: Body, signal: AbortSignal) => Promise<Response>): typeof fetch => (async (input: unknown, init?: RequestInit) => {
  const body = JSON.parse(init!.body as string) as Body;
  calls.push({ url: String(input), init: init!, body, signal: init!.signal! });
  return handler(body, init!.signal!);
}) as typeof fetch;
const withJev = (deps: MemeStepDeps, fetchFn: typeof fetch): MemeStepDeps => ({ ...deps, jev: { apiKey: "test-key", fetch: fetchFn } });
const step = async (world: MemeWorld, deps: MemeStepDeps, options: { dryRun?: boolean } = {}) => runAgenticMemeStep(deps, (await world.f.store.byAgent(world.agentId))!, options);
const allLogs = async (world: MemeWorld, kind?: string) => (await world.f.store.memeLog(null, 0, Number.MAX_SAFE_INTEGER)).filter(r => kind === undefined || r.kind === kind);
const jevOf = (row: AgenticMemeLog) => (row.data as { jev?: Record<string, unknown> }).jev;
/** A new shortlist refresh at `ms`: the same rows, a fresh `asOf`, bars and eligibility. */
async function refresh(world: MemeWorld, ms: number, rows: Record<string, unknown>[]): Promise<void> {
  await world.at(ms);
  world.plane.asOf = ms - 5_000; world.plane.rows = rows;
  for (const address of [MEME, MEME2]) world.plane.bars.set(address, { bars: passingBars(ms) });
  world.plane.eligibility = [eligibilityRow(ms)];
}

test("3.1 request: Bearer key, jev-latest, one Choice per index, state byte-identical to the LLM's user content, 3 000 ms bound; the key reaches no log row", async (t) => {
  const timeouts: number[] = [];
  const original = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return original(ms); });
  const world = await memeWorld(t, { llm: async () => { await macro(); return JSON.stringify({ decisions: [{ index: 0, action: "reject", confidence: 90 }, { index: 1, action: "reject", confidence: 90 }] }); } });
  world.plane.rows.push(shortlistRow(world.clock.now, { address: MEME2 }));
  world.plane.bars.set(MEME2, { bars: passingBars(world.clock.now) });
  const calls: Call[] = [];
  await step(world, withJev(world.deps(), fake(calls, BEHAVIOURS.hostile)));
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.init.headers, { "content-type": "application/json", authorization: "Bearer test-key" });
  assert.equal(call.body.model, "jev-latest");
  assert.equal(world.llmCalls.length, 1);
  assert.equal(JSON.stringify(call.body.state), world.llmCalls[0]!.messages[1]!.content, "state is the LLM user content, byte for byte");
  assert.deepEqual(Object.keys(call.body.questions), ["c0", "f0", "c1", "f1"]);
  const choices = Object.entries(call.body.questions).filter(([id]) => id.startsWith("c")).map(([, q]) => q);
  for (const q of choices) { assert.equal(q.type, "choice"); assert.deepEqual(Object.keys(q.criteria), ["buy_now", "wait", "reject"]); }
  assert.ok(call.body.questions["c1"]!.instructions.includes("candidates[1]"));
  // Operator 2026-10-07: the 60-minute forecast Noul per index, structured instructions naming its own candidate and cost.
  const forecast = call.body.questions["f1"] as unknown as { type: string; instructions: Record<string, string>; criteria: Record<string, string> };
  assert.equal(forecast.type, "noul");
  assert.deepEqual(Object.keys(forecast.instructions), ["question", "cost", "inputs"]);
  assert.ok(forecast.instructions["question"]!.includes("candidates[1]") && forecast.instructions["question"]!.includes("60 minutes") && forecast.instructions["cost"]!.includes("candidates[1].costBps"));
  assert.deepEqual(Object.keys(forecast.criteria), ["true", "false"]);
  for (const q of choices) assert.ok(q.instructions.endsWith("Every candidate already passed the deterministic checks.") && !q.instructions.includes("verdict"), "the shadow's question carries the LLM's own sentence");
  assert.ok(timeouts.includes(3_000) && timeouts.includes(8_000), String(timeouts));
  assert.ok(!JSON.stringify(await allLogs(world)).includes("test-key"));
  const jev = jevOf((await allLogs(world, "llm"))[0]!)!;
  assert.equal(jev["outcome"], "ok");
  assert.equal(jev["model"], "jev-1.13.0");
  assert.equal(jev["inputTokens"], 1234);
  assert.deepEqual(jev["answers"], [0, 1].map(index => ({ index, choice: "buy_now", pBuy: 1, pWait: 0, pReject: 0, confidence: 0.9, pUp60: null })));
});

test("3.1 parser: a valid Choice per index is kept; anything else is invalid", () => {
  const good = (extra: Record<string, unknown> = {}) => ({ type: "choice", choice: "wait", probabilities: { buy_now: 0.1, wait: 0.6, reject: 0.3 }, confidence: 0.6, ...extra });
  const raw = (answersValue: unknown, rest: Record<string, unknown> = {}) => ({ model: "jev-1.13.0", usage: { input_tokens: 10 }, answers: answersValue, ...rest });
  assert.deepEqual(parseMemeJev(raw({ c0: good() }), 1), { model: "jev-1.13.0", inputTokens: 10, answers: [{ index: 0, choice: "wait", pBuy: 0.1, pWait: 0.6, pReject: 0.3, confidence: 0.6, pUp60: null }] });
  // Operator 2026-10-07: the forecast Noul is kept as pUp60; a malformed one is null and never invalidates the Choice.
  assert.equal(parseMemeJev(raw({ c0: good(), f0: { type: "noul", noul: 0.42 } }), 1)!.answers[0]!.pUp60, 0.42);
  for (const f of [{ type: "noul", noul: 1.2 }, { type: "noul", noul: "0.4" }, { type: "choice", noul: 0.4 }, "x"]) assert.equal(parseMemeJev(raw({ c0: good(), f0: f }), 1)!.answers[0]!.pUp60, null, JSON.stringify(f));
  assert.equal(parseMemeJev(raw({ c0: good() }, { usage: undefined }), 1)!.inputTokens, null, "a missing usage is a null count, not an invalid answer");
  const bad: [string, unknown, number][] = [
    ["not an object", "x", 1], ["null", null, 1], ["no answers", { model: "m" }, 1], ["answers is an array", raw([good()]), 1], ["a missing index", raw({ c0: good() }), 2],
    ["an extra answer", raw({ c0: good(), c1: good() }), 1], ["an extra forecast", raw({ c0: good(), f1: { type: "noul", noul: 0.5 } }), 1], ["a wrong id", raw({ c1: good() }), 1], ["a Score", raw({ c0: good({ type: "score" }) }), 1],
    ["an unknown choice", raw({ c0: good({ choice: "maybe" }) }), 1], ["a missing probability", raw({ c0: good({ probabilities: { buy_now: 0.5, wait: 0.5 } }) }), 1],
    ["a fourth probability", raw({ c0: good({ probabilities: { buy_now: 0.5, wait: 0.25, reject: 0.2, other: 0.05 } }) }), 1],
    ["a probability above 1", raw({ c0: good({ probabilities: { buy_now: 1.5, wait: 0, reject: 0 } }) }), 1], ["a negative probability", raw({ c0: good({ probabilities: { buy_now: -0.1, wait: 0.6, reject: 0.5 } }) }), 1],
    ["a string probability", raw({ c0: good({ probabilities: { buy_now: "0.5", wait: 0.25, reject: 0.25 } }) }), 1],
    ["a NaN confidence", raw({ c0: good({ confidence: Number.NaN }) }), 1], ["a confidence above 1", raw({ c0: good({ confidence: 1.2 }) }), 1], ["a negative confidence", raw({ c0: good({ confidence: -0.1 }) }), 1], ["a missing confidence", raw({ c0: good({ confidence: undefined }) }), 1],
  ];
  for (const [name, value, k] of bad) assert.equal(parseMemeJev(value, k), null, name);
});

test("3.2 / 3.4 flag off or key absent: no request and no data.jev; only the exact flag plus a key builds a config", async (t) => {
  const key = (flag: string | undefined, apiKey: string | undefined) => memeJevConfig({ ...(flag === undefined ? {} : { AGENTIC_MEME_JEV_SHADOW: flag }), ...(apiKey === undefined ? {} : { TYPESAFE_API_KEY: apiKey }) });
  assert.deepEqual([key(undefined, "k"), key("false", "k"), key("TRUE", "k"), key("1", "k"), key("true", undefined), key("true", ""), key("true", "  ")], Array(7).fill(undefined));
  assert.equal(key("true", "k")?.apiKey, "k");
  const world = await memeWorld(t);
  world.plane.rows.push(shortlistRow(world.clock.now, { address: MEME3, flow5m: null }));
  const fetchCalls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (...args: unknown[]) => { fetchCalls.push(args); throw new Error("no network in tests"); });
  const { report } = await step(world, world.deps());
  await macro();
  assert.equal(report.code, "meme-entered");
  assert.deepEqual(fetchCalls, []);
  assert.equal(Object.hasOwn((await allLogs(world, "llm"))[0]!.data as object, "jev"), false);
  assert.deepEqual(await allLogs(world, "jev"), []);
});

test("3.4 wiring: runAgenticCycle reads the trade-worker's env; flag on plus a key reaches the scan and the shadow through the global fetch, off sends nothing", async (t) => {
  const saved = { flag: process.env["AGENTIC_MEME_JEV_SHADOW"], key: process.env["TYPESAFE_API_KEY"] };
  t.after(() => { for (const [name, value] of [["AGENTIC_MEME_JEV_SHADOW", saved.flag], ["TYPESAFE_API_KEY", saved.key]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => { urls.push(String(input)); throw new Error("no network in tests"); });
  for (const on of [false, true]) {
    delete process.env["AGENTIC_MEME_JEV_SHADOW"]; delete process.env["TYPESAFE_API_KEY"];
    if (on) { process.env["AGENTIC_MEME_JEV_SHADOW"] = "true"; process.env["TYPESAFE_API_KEY"] = "test-key"; }
    const world = await memeWorld(t);
    await runAgenticCycle({ ...world.f.lifecycle, memeEnabled: true });
    await macro();
    assert.equal(Object.hasOwn((await allLogs(world, "llm"))[0]!.data as object, "jev"), on, String(on));
  }
  assert.deepEqual(urls, ["https://api.typesafe.ai/v1/systemone"], "one request: the shadow of the on run (the off run and a world with no dropped token send no scan)");
});

test("3.2 invariant: for any Jev behaviour the decisions, model rotation, run events, counters, paper entries and every row but data.jev / the jev rows equal the flag-off cycle", async (t) => {
  const run = async (behaviour: keyof typeof BEHAVIOURS | null) => {
    let n = 0;
    const world = await memeWorld(t, { llm: async () => { await macro(); n += 1; if (n === 1) throw named("TimeoutError", "slow"); return JSON.stringify({ decisions: [{ index: 0, action: "buy_now", confidence: 80 }] }); } });
    const dropped = (ms: number) => shortlistRow(ms, { address: MEME3, flow5m: null });
    world.plane.rows.push(dropped(world.clock.now));
    const calls: Call[] = [];
    const deps = behaviour === null ? world.deps() : withJev(world.deps(), fake(calls, BEHAVIOURS[behaviour]));
    const first = await step(world, deps);
    await macro();
    await refresh(world, world.clock.now + 200_000, [shortlistRow(world.clock.now + 200_000), dropped(world.clock.now + 200_000)]);
    const second = await step(world, deps);
    await macro();
    const strip = (rows: readonly AgenticMemeLog[]) => rows.filter(r => r.kind !== "jev").map(r => { const { jev: _jev, ...data } = r.data as Record<string, unknown>; return r.kind === "llm" ? { ...r, data } : r; });
    // Operator 2026-10-07: the Jev answer is also a display-only run event (`meme-jev:*`); every other event must be unchanged.
    const report = (r: typeof first) => ({ code: r.report.code, events: r.report.events.filter(e => !e.code.startsWith("meme-jev:")), cycle: r.report.cycle, logs: strip(r.report.logs), paper: r.report.paper });
    const jevEvents = [first, second].map(r => r.report.events.filter(e => e.code.startsWith("meme-jev:")).map(e => e.code));
    return { calls, world, jevEvents, snapshot: JSON.stringify({ first: report(first), second: report(second), models: world.llmCalls.map(c => c.model), stored: strip(await allLogs(world)),
      paper: await world.f.store.paperList(world.agentId), runner: world.f.runner.calls, orders: await world.f.store.orders() }) };
  };
  const base = await run(null);
  assert.equal(base.calls.length, 0);
  assert.deepEqual(base.jevEvents, [[], []], "flag off: no meme-jev run event");
  assert.ok(base.snapshot.includes("meme-entered") && base.snapshot.includes("meme-llm:timeout"), "the scenario enters after a primary timeout");
  for (const behaviour of Object.keys(BEHAVIOURS) as (keyof typeof BEHAVIOURS)[]) {
    const jev = await run(behaviour);
    assert.equal(jev.snapshot, base.snapshot, behaviour);
    assert.ok(jev.calls.length >= 2, behaviour);
    const llmRows = await allLogs(jev.world, "llm");
    assert.deepEqual(llmRows.map(r => jevOf(r)?.["outcome"]), [EXPECTED[behaviour], EXPECTED[behaviour]], behaviour);
    assert.deepEqual(jev.jevEvents.map(codes => codes.length), [1, 1], `${behaviour}: one meme-jev run event per ask`);
    if (EXPECTED[behaviour] !== "ok") assert.deepEqual(jev.jevEvents, [[`meme-jev:${EXPECTED[behaviour]}`], [`meme-jev:${EXPECTED[behaviour]}`]], behaviour);
    if (behaviour === "late") {
      const shadow = jev.calls.filter(c => c.body.state.candidates.every(candidate => !("verdict" in candidate)));
      assert.equal(shadow.length, 2);
      assert.ok(shadow.every(c => c.signal.aborted), "a late request is aborted");
      assert.deepEqual(jevOf(llmRows[0]!), { model: null, latencyMs: 0, outcome: "late", answers: [], inputTokens: null });
    }
  }
});

test("3.3 scan rows: the dropped tokens only, closed verdict and index, answers kept per token; the step never waits for it", async (t) => {
  const world = await memeWorld(t);
  world.plane.rows = [shortlistRow(world.clock.now, { address: MEME3, flow5m: null }), shortlistRow(world.clock.now, { address: MEME4, tax: null }), shortlistRow(world.clock.now, { address: MEME2 })];
  world.plane.bars.set(MEME2, { bars: passingBars(world.clock.now, 120_000, 7) });
  const calls: Call[] = [];
  let release: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { report } = await step(world, withJev(world.deps(), fake(calls, async body => { await gate; return answers(body, { c0: "reject", c1: "buy_now", c2: "wait" }); })));
  assert.equal(calls.length, 1, "one request for the whole refresh");
  assert.equal(report.code, "meme-no-candidate", "the step finished while the scan request was still open");
  assert.deepEqual(await allLogs(world, "jev"), []);
  release!();
  await macro();
  const rows = await allLogs(world, "jev");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.agentId, rows[0]!.token, rows[0]!.id], [null, null, `jev:${world.plane.asOf}:${world.clock.now}`], "unique per scan, so a restart inside one refresh never loses a row");
  const data = rows[0]!.data as { outcome: string; model: string; asked: number; answers: Record<string, unknown>[] };
  assert.deepEqual([data.outcome, data.model, data.asked], ["ok", "jev-1.13.0", 3]);
  assert.deepEqual(data.answers.map(a => [a["index"], a["token"], a["verdict"], a["choice"]]),
    [[0, MEME3, "screen:flow-unknown", "reject"], [1, MEME4, "screen:tax-unknown", "buy_now"], [2, MEME2, "bars-unavailable", "wait"]]);
  const candidates = calls[0]!.body.state.candidates;
  assert.deepEqual(candidates.map(c => c["verdict"]), ["screen:flow-unknown", "screen:tax-unknown", "bars-unavailable"]);
  assert.equal(candidates[0]!["flow5m"], null);
  assert.equal(candidates[0]!["burstRatio"], null, "a field a dropped token lacks is null");
  assert.ok(!JSON.stringify(calls[0]!.body).includes(MEME3), "no address or symbol leaves");
  for (const q of Object.entries(calls[0]!.body.questions).filter(([id]) => id.startsWith("c")).map(([, q]) => q)) assert.ok(q.instructions.endsWith("The candidate was dropped by a deterministic check, named by its `verdict` field; judge it on its numbers regardless.") && !q.instructions.includes("already passed"), "only the scan names the verdict");
});

test("3.3 scan: due only when not judged in 30 minutes or the verdict changed; one scan at a time; a failed request is retried at the next refresh", async (t) => {
  const world = await memeWorld(t);
  const calls: Call[] = [], pending: { body: Body; resolve: (r: Response) => void; reject: (e: Error) => void }[] = [];
  const fetchFn = fake(calls, body => new Promise<Response>((resolve, reject) => { pending.push({ body, resolve, reject }); }));
  const deps = withJev(world.deps(), fetchFn);
  const rows = (ms: number, patch: Record<string, unknown> = {}) => [shortlistRow(ms, { address: MEME3, flow5m: null }), shortlistRow(ms, { address: MEME4, tax: null, ...patch })];
  const t0 = world.clock.now;
  await refresh(world, t0, rows(t0));
  await step(world, deps);
  assert.equal(calls.length, 1);
  // A refresh while the first scan is open: skipped, not queued.
  await refresh(world, t0 + 60_000, rows(t0 + 60_000));
  await step(world, deps);
  await macro();
  assert.equal(calls.length, 1, "at most one scan in flight");
  // The first request fails: nothing is marked judged, so the next refresh asks again for both.
  pending[0]!.reject(new TypeError("fetch failed"));
  await macro();
  assert.deepEqual((await allLogs(world, "jev")).map(r => (r.data as { outcome: string }).outcome), ["error"]);
  await refresh(world, t0 + 120_000, rows(t0 + 120_000));
  await step(world, deps);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.body.state.candidates.length, 2);
  pending[1]!.resolve(answers(pending[1]!.body, "reject"));
  await macro();
  // Judged under the same verdicts a minute ago: nothing is due, no request.
  await refresh(world, t0 + 180_000, rows(t0 + 180_000));
  await step(world, deps);
  await macro();
  assert.equal(calls.length, 2, "judged within 30 minutes and the verdict unchanged");
  // One verdict changes (the tax is known now, the token reaches the bars layer): only it is due.
  await refresh(world, t0 + 240_000, rows(t0 + 240_000, { tax: { buyBps: 300, sellBps: 500 } }));
  await step(world, deps);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2]!.body.state.candidates.map(c => c["verdict"]), ["bars-unavailable"]);
  pending[2]!.resolve(answers(pending[2]!.body, "wait"));
  await macro();
  // 31 minutes after the last judgement of both: both are due again.
  await refresh(world, t0 + 240_000 + 1_860_000, rows(t0 + 240_000 + 1_860_000, { tax: { buyBps: 300, sellBps: 500 } }));
  await step(world, deps);
  assert.equal(calls.length, 4);
  assert.equal(calls[3]!.body.state.candidates.length, 2);
  pending[3]!.resolve(answers(pending[3]!.body, "reject"));
  await macro();
  assert.equal((await allLogs(world, "jev")).length, 4, "three ok rows and the failed one, each under its own refresh id");
});

test("3.3 migration: the jev kind joins the CHECK by an appended, idempotent statement; the memory store holds it", async (t) => {
  const last = AGENTIC_DDL.find(ddl => ddl.includes("agentic_meme_log_kind_check"))!;
  assert.match(last, /alter table agentic_meme_log drop constraint if exists agentic_meme_log_kind_check;/u);
  assert.match(last, /add constraint agentic_meme_log_kind_check check \(kind in \('market','cycle','signal','llm','entry','mark','exit','jev'\)\)/u);
  assert.equal(AGENTIC_DDL.filter(ddl => ddl.includes("agentic_meme_log_kind_check")).length, 1, "only the migration names the constraint; the create statement is untouched");
  const world = await memeWorld(t);
  assert.equal(await world.f.store.insertMemeLog({ id: "jev:1", agentId: null, kind: "jev", token: null, atMs: world.clock.now, data: { asOf: 1 } }), true);
  assert.equal(await world.f.store.insertMemeLog({ id: "jev:1", agentId: null, kind: "jev", token: null, atMs: world.clock.now, data: { asOf: 1 } }), false);
});

test("3.3 readers: the public view, the decision log, lastCycle and the model rotation see exactly what they saw without any jev row or data.jev", async (t) => {
  const key = "AGENTIC_MEME_DECISION_LOG_PUBLIC", before = process.env[key];
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  process.env[key] = "true";
  const meme = async (withJevRows: boolean) => {
    const world = await memeWorld(t);
    const now = await world.f.store.now(), a = world.agentId;
    const rows: AgenticMemeLog[] = [
      { id: `cycle:${a}:${now - 60_000}`, agentId: a, kind: "cycle", token: null, atMs: now - 60_000, data: { code: "meme-no-candidate", counts: { "no-burst": 3, llmAsked: 1 }, picked: { flap: 3, fourmeme: 0 }, survivors61: 2, barsRequested: 2, elapsedMs: 900 } },
      { id: `llm:${a}:${now - 50_000}`, agentId: a, kind: "llm", token: null, atMs: now - 50_000, data: { model: world.settings.primaryModel, latencyMs: 2_000, outcome: "timeout", tokens: [MEME], decisions: null,
        ...(withJevRows ? { jev: { model: "jev-1.13.0", latencyMs: 300, outcome: "ok", answers: [{ index: 0, choice: "buy_now", pBuy: 1, pWait: 0, pReject: 0, confidence: 1 }], inputTokens: 5 } } : {}) } },
      { id: `market:${now - 40_000}`, agentId: null, kind: "market", token: null, atMs: now - 40_000, data: { rows: [] } },
    ];
    if (withJevRows) rows.push({ id: `jev:${now - 30_000}`, agentId: null, kind: "jev", token: null, atMs: now - 30_000, data: { outcome: "ok", answers: [] } },
      { id: `jev:agent:${now - 20_000}`, agentId: a, kind: "jev", token: null, atMs: now - 20_000, data: { outcome: "timeout", model: world.settings.primaryModel } });
    for (const row of rows) await world.f.store.insertMemeLog(row);
    const agentRows = await world.f.store.memeLog(a, now - 1_800_000, now), globalRows = await world.f.store.memeLog(null, now - 300_000, now);
    const dto = await createAgenticPublicView({ store: world.f.store, agents: world.f.agents, settings: world.f.settings, positions: world.f.positions, intents: world.f.intents, cmc: world.f.cmcStore,
      killswitch: world.f.killswitch, observer: { observe: async () => [] } })(W);
    const models: string[] = [];
    await step(world, world.deps());
    models.push(...world.llmCalls.map(c => c.model));
    // Operator 2026-10-07: the decision log now shows Jev (display only); strip those fields to compare everything else.
    const normalize = (value: unknown, strip = false) => JSON.stringify(value, (k, v: unknown) => strip && (k === "jev" || k === "jevScan") ? undefined : v).split(a).join("AGENT");
    const view = (dto.agent as unknown as { meme: unknown }).meme, log = memeDecisionLog(agentRows, globalRows, globalRows);
    return { view: normalize(view, true), log: normalize(log, true), rawLog: normalize(log), last: normalize(memeLastCycle(agentRows)), models,
      expected: world.settings.fallbackModel };
  };
  const plain = await meme(false), withJevRows = await meme(true);
  assert.deepEqual([withJevRows.view, withJevRows.log, withJevRows.last, withJevRows.models], [plain.view, plain.log, plain.last, plain.models]);
  assert.deepEqual(plain.models, [plain.expected], "the last llm row timed out on the primary: the fallback asks next, whatever jev rows follow it");
  assert.ok(!plain.log.includes("jev") && !withJevRows.log.includes("jev") && !withJevRows.view.includes("jev"), "apart from the Jev display fields, nothing changes");
  const shown = JSON.parse(withJevRows.rawLog) as { llm: { jev: { outcome: string; answers: { choice: string; pBuy: number }[] } | null }[]; jevScan: { outcome: string }[] };
  assert.deepEqual([shown.llm[0]!.jev!.outcome, shown.llm[0]!.jev!.answers[0]!.choice, shown.llm[0]!.jev!.answers[0]!.pBuy], ["ok", "buy_now", 1], "the shadow answer is shown beside the model ask");
  assert.deepEqual(shown.jevScan.map(r => r.outcome), ["ok"], "only the global scan row is shown; an agent-scoped jev row is not a scan");
  assert.equal((JSON.parse(plain.rawLog) as { llm: { jev: unknown }[] }).llm[0]!.jev, null);
});

test("review H1: the two question wordings differ only in their last sentence", () => {
  const state = JSON.stringify({ candidates: [{ index: 0 }] });
  const shadow = memeJevRequest(state, 1, false).questions["c0"] as { instructions: string }, scan = memeJevRequest(state, 1, true).questions["c0"] as { instructions: string };
  const common = "Doctrine: " + MEME_DOCTRINE + " ";
  assert.ok(shadow.instructions.includes(common) && scan.instructions.includes(common), "the same doctrine in both");
  assert.ok(shadow.instructions.endsWith("Every candidate already passed the deterministic checks.") && !shadow.instructions.includes("verdict"));
  assert.ok(scan.instructions.includes("named by its `verdict` field") && !scan.instructions.includes("Every candidate already passed"));
});

test("review M1: a dry run sends no request and writes no jev row, from the shadow or the scan", async (t) => {
  const world = await memeWorld(t);
  world.plane.rows.push(shortlistRow(world.clock.now, { address: MEME3, flow5m: null }));
  const calls: Call[] = [];
  const { report } = await step(world, withJev(world.deps(), fake(calls, BEHAVIOURS.hostile)), { dryRun: true });
  await macro();
  assert.equal(report.code, "meme-entered", "the dry run still decides as before");
  assert.deepEqual(calls, []);
  assert.deepEqual(report.logs.filter(r => r.kind === "llm").map(jevOf), [undefined]);
  assert.deepEqual(await allLogs(world), []);
});

test("review M2: a late record's latencyMs is Jev's own time since its request started, not the LLM's", async (t) => {
  const world = await memeWorld(t, { llm: async () => { world.clock.advance(300); await macro(); world.clock.advance(200); return JSON.stringify({ decisions: [{ index: 0, action: "reject", confidence: 90 }] }); } });
  const calls: Call[] = [];
  await step(world, withJev(world.deps(), fake(calls, BEHAVIOURS.late)));
  const data = (await allLogs(world, "llm"))[0]!.data as { latencyMs: number; jev: { outcome: string; latencyMs: number } };
  assert.deepEqual([data.latencyMs, data.jev.outcome, data.jev.latencyMs], [500, "late", 200]);
});

test("review M3: the scan sends nothing while the lane takes no entries (meme flag off, entry cutoff passed, drain requested)", async (t) => {
  const cases: [string, boolean, Parameters<typeof memeWorld>[1]][] = [["meme flag off", false, {}], ["entry cutoff passed", true, { initial: { entryCutoffMs: 1 } }],
    ["drain requested", true, { initial: { drainRequestedAt: 1 } }], ["control: entries open", true, {}]];
  for (const [name, enabled, options] of cases) {
    const world = await memeWorld(t, options);
    world.plane.rows = [shortlistRow(world.clock.now, { address: MEME3, flow5m: null })];
    const calls: Call[] = [];
    await step(world, withJev(world.deps(enabled), fake(calls, BEHAVIOURS.hostile)));
    await macro();
    assert.equal(calls.length, name.startsWith("control") ? 1 : 0, name);
  }
});

test("review L11: a non-OK status is an error outcome and its body is cancelled", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const result = await askMemeJev({ apiKey: "k", fetch: (async () => new Response(body, { status: 429 })) as typeof fetch }, JSON.stringify({ candidates: [{ index: 0 }] }), 1, undefined, false);
  assert.equal(result.outcome, "error");
  await macro();
  assert.equal(cancelled, true);
});
