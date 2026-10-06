/** AGENTIC-MEME-STOCKS-SPEC 9.1, 10 hire: the 8-key paper body, its bounds, the paper gate rows (trade-all-tokens WARN, review R2-H2), the paper hire_facts, ERC-8004 skip. */
import assert from "node:assert/strict";
import test from "node:test";
import { AgenticPairings } from "../src/agentic/routes.js";
import { agenticGate, agenticGateInput, agenticHireIdentity, parseAgenticHireParams } from "../src/agentic/domain.js";
import type { TradeSettings } from "../src/trade/settings.js";
import { E, FACTS, PAIRED, W, fixture, settingsOutput } from "./support/agenticSchedule.js";
import { memeBody, memeSettings } from "./support/agenticMeme.js";

const parse = (body: unknown, meme = true) => parseAgenticHireParams(body, { meme });
const s = (patch: Partial<TradeSettings>): TradeSettings => ({ ...memeSettings, ...patch });

test("the 8-key body parses only with the flag; strategy is inside the canonical params, so the agent id differs from a stock hire with identical settings", () => {
  assert.equal(parse(memeBody(), false), null);
  const params = parse(memeBody())!;
  assert.equal(params.strategy, "meme-stocks-paper");
  assert.equal(parse(memeBody(memeSettings, { strategy: "meme-stocks" })), null, "live is refused until Phase B");
  const { strategy: _strategy, ...stock } = params;
  assert.notEqual(agenticHireIdentity(params).agentId, agenticHireIdentity(stock).agentId);
});

test("every settings bound of 9.1 is refused", () => {
  const refused: [string, Record<string, unknown>][] = [
    ["min 9", { settings: s({ minEntryWei: (9n * E).toString() }) }], ["min 11", { settings: s({ minEntryWei: (11n * E).toString(), entryWei: (11n * E).toString() }) }],
    ["entry 51", { settings: s({ entryWei: (51n * E).toString(), capitalQuoteWei: (200n * E).toString() }) }],
    ["max open 4", { settings: s({ maxOpenPositions: 4, capitalQuoteWei: (200n * E).toString() }) }],
    ["capital below max open x entry", { settings: s({ capitalQuoteWei: (19n * E).toString() }) }],
    ["slippage 300", { settings: s({ slippageBps: 300 }) }], ["take profit", { settings: s({ takeProfitBps: 1_000 }) }], ["stop loss", { settings: s({ stopLossBps: 1_000 }) }],
    ["max hold", { settings: s({ maxHoldSec: 600 }) }], ["keep", { termEndAction: "keep" }], ["cmc on", { settings: s({ cmcNewsEnabled: true, cmcTotalBudgetWei: (2n * E).toString() }) }],
    ["owner instructions", { settings: s({ instructions: "buy everything" }) }], ["owner skill", { settings: s({ skillMarkdown: "# skill" }) }],
  ];
  for (const [name, patch] of refused) assert.equal(parse(memeBody(memeSettings, patch)), null, name);
  for (const [name, patch] of [["entry 50", { settings: s({ entryWei: (50n * E).toString(), capitalQuoteWei: (150n * E).toString(), maxOpenPositions: 3 }) }], ["max open 3", { settings: s({ maxOpenPositions: 3, capitalQuoteWei: (30n * E).toString() }) }]] as const) {
    assert.notEqual(parse(memeBody(memeSettings, patch)), null, name);
  }
});

test("paper gate rows are exactly status, trade-all-tokens, sign-in-time, sizing; trade-all-tokens WARNs when off and PASSes when on", () => {
  const params = parse(memeBody())!;
  const on = agenticGate(agenticGateInput(params, FACTS, W, FACTS.readAtMs)), off = agenticGate(agenticGateInput(params, { ...FACTS, tradeAllTokens: false, usdtWei: "0", bnbWei: "0", x402DailyLimit: 0 }, W, FACTS.readAtMs));
  assert.deepEqual(on.rows.map(r => r.code), ["status", "trade-all-tokens", "sign-in-time", "sizing"]);
  assert.deepEqual(off.rows.map(r => [r.code, r.state]), [["status", "PASS"], ["trade-all-tokens", "WARN"], ["sign-in-time", "PASS"], ["sizing", "PASS"]]);
  assert.equal(on.rows[1]!.state, "PASS");
  assert.equal(off.rows[1]!.fix, "Not needed for paper trading. A live agent will need Trade all tokens.");
  // The web mirror (web/components/deploy/HireAgenticTradeDeploy.meme.test.tsx) pins these exact rows for the same input.
  assert.deepEqual(off.rows, [{ code: "status", state: "PASS", fix: "Connect in the Binance App." },
    { code: "trade-all-tokens", state: "WARN", fix: "Not needed for paper trading. A live agent will need Trade all tokens." },
    { code: "sign-in-time", state: "PASS", fix: "Raise Max sign-in duration in the Binance App, or choose 7 days." },
    { code: "sizing", state: "PASS", fix: "Capital 20 USDT is below 2 positions x 10 USDT = 20 USDT; raise capital or lower the entry size." }]);
});

async function hire(t: import("node:test").TestContext, tradeAllTokens = true, memeEnabled = true) {
  const f = await fixture(t, { ...PAIRED, termEndAction: null }, memeSettings);
  f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { ...settingsOutput(), tradeAllTokens } });
  const pairings = new AgenticPairings({ ...f.pairings.deps, memeEnabled });
  pairings.pin = async () => { throw new Error("a paper meme hire reads no pin"); };
  return { f, pairings, result: await pairings.hire(f.row, memeBody()).then(row => row, (error: Error) => error) };
}

test("a paper hire binds with pinned [], hire_facts.meme paper, no CMC budget, no funding; with Trade all tokens off it is not refused", async (t) => {
  for (const tradeAllTokens of [true, false]) {
    const { f, result } = await hire(t, tradeAllTokens);
    assert.ok(!(result instanceof Error), String(result));
    const row = result as Exclude<typeof result, Error>;
    assert.equal(row.state, "bound");
    assert.deepEqual(row.hireFacts!.pinned, []);
    assert.deepEqual(row.hireFacts!.meme, { v: 1, mode: "paper" });
    assert.equal(row.hireFacts!.budgetWei, "0");
    assert.equal(row.hireFacts!.hireSizing.cmcNewsEnabled, false);
    assert.equal(Object.hasOwn(row.hireFacts!.hireSizing, "cmcTotalBudgetWei"), false);
    assert.equal(await f.cmcStore.get(row.agentId!, W), null, "no CMC budget row");
    assert.equal(row.termEndAction, "sell-all");
  }
});

test("the 8-key body is refused when the execution-api flag is off", async (t) => {
  const { result } = await hire(t, true, false);
  assert.ok(result instanceof Error && result.message === "agentic_hire_invalid");
});

test("ERC-8004 sweep skips a bound meme hire (D15)", async (t) => {
  const { f, pairings, result } = await hire(t);
  assert.ok(!(result instanceof Error));
  let enrolled = 0;
  t.mock.method(f.agents, "enrollAgenticIdentity", async () => { enrolled += 1; return null as never; });
  await pairings.sweep();
  assert.equal(enrolled, 0);
});
