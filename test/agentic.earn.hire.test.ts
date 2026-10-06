/** AGENTIC-EARN-SPEC ET2 (+ R11.3, R11.4): the earn hire body and its agent id, the lanes that may opt in, hireFacts.earn written once, the two refusal reasons (pre-check and gated stage, persisted and carried by the 409 body), the BNB gate. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Hono } from "hono";
import { AGENTIC_HIRE_REASONS, agenticGate, agenticGateInput, agenticHireIdentity, parseAgenticHireParams, type AgenticFactsRead, type AgenticWallet } from "../src/agentic/domain.js";
import { registerAgenticRoutes } from "../src/agentic/routes.js";
import { DCA_POOLS_56 } from "../src/trade/dca.js";
import type { TradeSettings } from "../src/trade/settings.js";
import { E, FACTS, NOW, PAIRED, PAIRING, SECRET, W, aiParams, fixture, scheduleParams, type Fixture } from "./support/agenticSchedule.js";
import { USDT, SPYB, dcaParams } from "./support/agenticDca.js";
import { NULL_PRODUCTS, PRODUCTS, earnSettings } from "./support/agenticEarn.js";
import { EARN_PRODUCTS } from "../src/agentic/earnAdapter.js";
import { memeBody } from "./support/agenticMeme.js";

const body = (settings: TradeSettings, extra: Record<string, unknown> = {}, term: 7 | 30 = 7) => ({ pairingId: PAIRING, term, termEndAction: "keep", executionModel: "tradfi", hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  acceptedDedicatedWallet: true, settings, ...extra });
const aiBody = (extra: Record<string, unknown> = {}) => ({ ...body({ ...aiParams }, extra) });
const parse = (b: unknown, earn = true) => parseAgenticHireParams(b, { earn });
const facts = (patch: Partial<AgenticFactsRead> = {}): AgenticFactsRead => ({ ...FACTS, ...patch });

async function paired(t: TestContext, settings: TradeSettings = aiParams, opts: { earnEnabled?: boolean; products?: boolean; supply?: bigint; pins?: boolean } = {}): Promise<Fixture> {
  const f = await fixture(t, { ...PAIRED }, settings);
  Object.assign(f.pairings.deps, { earnEnabled: opts.earnEnabled ?? true, dcaEnabled: true, earnProducts: opts.products === false ? NULL_PRODUCTS : PRODUCTS });
  f.chain.earnPins = async () => ({ venus: opts.pins !== false, "aave-v3": opts.pins !== false });
  f.chain.earnBalances = async () => ({ block: 1n, usdt: 100n * E, vBalance: opts.supply ?? 0n, vRate: E, venusWei: opts.supply ?? 0n, aaveWei: 0n });
  if (settings.tradeMode === "dca") {
    const pool = DCA_POOLS_56.find(p => p.stock.toLowerCase() === SPYB)!;
    f.chain.poolState = async () => ({ token0: pool.usdtIsToken0 ? USDT : SPYB, token1: pool.usdtIsToken0 ? SPYB : USDT, fee: pool.fee, tickSpacing: pool.tickSpacing, sqrtPriceX96: 1n << 96n, tick: 0, block: 1n });
  }
  return f;
}
const wire = (f: Fixture) => { const app = new Hono(); registerAgenticRoutes(app, f.pairings, async () => [TOKEN_OF_FIXTURE]); return app; };
const TOKEN_OF_FIXTURE = "0x2222222222222222222222222222222222222222" as const;
const post = (app: Hono, payload: unknown) => app.request("/agentic/hire", { method: "POST", body: JSON.stringify(payload),
  headers: { "content-type": "application/json", origin: "https://4lpha.test", "x-agentic-pairing": PAIRING + "." + SECRET } });
type Refusal = { data: unknown; error?: { code: string }; meta?: { reason: string | null; gate: { code: string; state: string }[] } };
const stored = async (f: Fixture): Promise<AgenticWallet> => (await f.store.getWallet(PAIRING))!;

test("H1 params: the 7-key body keeps today's agent id; the earn key refuses with the flag off; AI, Schedule and DCA with N >= 5 may opt in; portfolio, meme, DCA N < 5 and earn false may not; the key changes the agent id", () => {
  const plain = parse(aiBody(), false)!, withFlag = parse(aiBody(), true)!;
  assert.equal(agenticHireIdentity(plain).agentId, agenticHireIdentity(withFlag).agentId, "a body without the key is the same agent id whatever the flag");
  assert.equal(parse(aiBody({ earn: true }), false), null, "flag off: 8 keys is the wrong key count");
  const ai = parse(aiBody({ earn: true }))!;
  assert.equal(ai.earn, true);
  assert.notEqual(agenticHireIdentity(ai).agentId, agenticHireIdentity(withFlag).agentId);
  assert.ok(parse(body({ ...scheduleParams }, { earn: true })));
  assert.ok(parse(body(dcaParams({ dcaMaxOrders: 5 }), { earn: true })));
  assert.equal(parse(body(dcaParams({ dcaMaxOrders: 4 }), { earn: true })), null, "DCA N 4");
  assert.equal(parse(aiBody({ earn: false })), null, "earn: false");
  for (const bad of ["true", 1, null, {}]) assert.equal(parse(aiBody({ earn: bad })), null, String(bad));
  assert.ok(parseAgenticHireParams(memeBody(), { meme: true, earn: true }), "a meme body alone is accepted with both flags on");
  assert.equal(parseAgenticHireParams(memeBody(undefined, { earn: true }), { meme: true, earn: true }), null, "meme + earn");
  assert.equal(parseAgenticHireParams(memeBody(undefined, { earn: true }), { meme: true }), null, "meme + earn with the earn flag off");
  assert.equal(parse(aiBody({ earn: true, extra: 1 })), null);
});

test("H2 gate: an earn hire needs two more reserves of BNB (0.0008); only an earn hire; every lane", () => {
  for (const settings of [aiParams, scheduleParams, dcaParams({ dcaMaxOrders: 5 })]) {
    const extra = settings.tradeMode === "dca" ? { earn: true } : { earn: true };
    const plain = parse(body(settings), true)!, earn = parse(body(settings, extra), true)!;
    const need = (p: typeof plain) => { const g = agenticGate(agenticGateInput(p, facts({ bnbWei: "0" }), W, NOW)).rows.find(r => r.code === "bnb")!.fix.match(/need ([0-9.]+) BNB/u)![1]!; return BigInt(Math.round(Number(g) * 1e4)) * 10n ** 14n; };
    assert.equal(need(earn) - need(plain), 800_000_000_000_000n, String(settings.tradeMode));
    // the same absolute figures as web/lib/agenticEarn.test.ts (the web gate mirror)
    const expected = settings.tradeMode === "dca" ? [56n, 64n] : settings.tradeMode === "schedule" ? [20n, 28n] : [16n, 24n];
    assert.deepEqual([need(plain), need(earn)], expected.map(n => n * 10n ** 14n), String(settings.tradeMode));
  }
});

test("H3 hire: an earn hire binds with hireFacts.earn written once at stage gated; a hire without the key has no earn fact; the stored params carry earn", async t => {
  const f = await paired(t);
  const hired = await f.pairings.hire(f.row, aiBody({ earn: true }));
  assert.equal(hired.state, "bound");
  assert.deepEqual(hired.hireFacts!.earn, { v: 1 });
  assert.equal(hired.hireParams!.earn, true);
  const g = await paired(t);
  const plain = await g.pairings.hire(g.row, aiBody());
  assert.equal(plain.hireFacts!.earn, undefined);
  assert.equal(Object.hasOwn(plain.hireFacts!, "earn"), false);
  const sched = await paired(t, scheduleParams);
  sched.pairings.schedulable = async () => [TOKEN_OF_FIXTURE];
  assert.deepEqual((await sched.pairings.hire(sched.row, body(scheduleParams, { earn: true }))).hireFacts!.earn, { v: 1 });
});

test("H4 refusals: earn-unavailable (no configured product, no pin, a failed read, a missing reader) and earn-wallet-has-supply (0.01 USDT refuses, 0.0099 passes) at the pre-check; the 409 body carries them and nothing is written", async t => {
  for (const code of ["earn-unavailable", "earn-wallet-has-supply"]) assert.ok(AGENTIC_HIRE_REASONS.includes(code), code);
  const cases: [string, (f: Fixture) => void, Parameters<typeof paired>[2]?][] = [
    ["earn-unavailable", () => undefined, { products: false }],
    ["earn-unavailable", () => undefined, { pins: false }],
    ["earn-unavailable", f => { f.chain.earnPins = async () => { throw new Error("rpc"); }; }],
    ["earn-unavailable", f => { f.chain.earnBalances = async () => { throw new Error("rpc"); }; }],
    ["earn-unavailable", f => { delete (f.chain as { earnBalances?: unknown }).earnBalances; }],
    ["earn-wallet-has-supply", () => undefined, { supply: E / 100n }],
  ];
  for (const [code, configure, opts] of cases) {
    const f = await paired(t, aiParams, opts), before = await stored(f), calls = f.runner.calls.length;
    configure(f);
    const response = await post(wire(f), aiBody({ earn: true })), result = await response.json() as Refusal;
    assert.equal(response.status, 409, code); assert.equal(result.error?.code, code); assert.equal(result.meta?.reason, code);
    const after = await stored(f);
    assert.deepEqual({ state: after.state, version: after.version }, { state: "paired", version: before.version });
    assert.equal(f.runner.calls.length, calls, "no Binance call");
  }
  const ok = await paired(t, aiParams, { supply: E / 100n - 1n });
  assert.equal((await post(wire(ok), aiBody({ earn: true }))).status, 200, "0.0099 USDT is below dust");
});

test("H5 gated stage (R11.3): the refusal persists as the failure (not sizing) and rethrows its own code; the flag-off process refuses the earn body", async t => {
  const accept = async (f: Fixture) => { const params = parse(aiBody({ earn: true }))!, identity = agenticHireIdentity(params);
    return (await f.store.acceptHire(f.row, { hireOpId: identity.hireOpId, agentId: identity.agentId, hireParams: params, termEndAction: "keep" }))!; };
  for (const [opts, reason] of [[{ supply: E }, "earn-wallet-has-supply"], [{ pins: false }, "earn-unavailable"], [{ products: false }, "earn-unavailable"]] as const) {
    const f = await paired(t, aiParams, opts), accepted = await accept(f);
    await assert.rejects(() => f.pairings.resumeHire(accepted), new RegExp(reason, "u"));
    assert.deepEqual({ state: (await stored(f)).state, failure: (await stored(f)).failure }, { state: "cleaning", failure: reason });
  }
  const off = await paired(t, aiParams, { earnEnabled: false });
  const response = await post(wire(off), aiBody({ earn: true }));
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as Refusal).error?.code, "agentic_hire_invalid");
  void earnSettings; void EARN_PRODUCTS;
});
