/** AGENTIC-PORTFOLIO: the public read-only view of a portfolio hire (the Altana block's shape, opaque leg ids, null-on-failed-read, closed run codes). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { keccak256, stringToBytes } from "viem";
import { createAgenticPublicView } from "../src/agentic/publicView.js";
import { agenticExecutedQuantity } from "../src/agentic/resolve.js";
import type { AgenticOrder } from "../src/agentic/domain.js";
import { E, NOW, W, fixture, scheduleParams, type Fixture } from "./support/agenticSchedule.js";
import { QQQB, SPYB } from "./support/agenticPortfolio.js";
import { SLOT, afterBasket, lane } from "./support/agenticPortfolioLane.js";

const opaque = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 16);
/** The Altana owner view's portfolio block, key by key (src/server.ts): the public block must expose exactly these at every level. */
const KEYS = {
  block: ["tokens", "capitalQuoteWei", "netInvestedWei", "cashCapWei", "walletUsdtWei", "portfolioCashWei", "idleUsdtWei", "stockValueWei", "totalValueWei", "pnlWei", "driftBps", "intervalSec",
    "anchorMs", "currentSlot", "nextCheckAtMs", "check", "legs"],
  token: ["token", "symbol", "displayName", "initial", "targetBps", "balanceAtomic", "valueWei", "valueReason", "weightBps", "driftBps"],
  initial: ["quantityAtomic", "quantityReason", "quoteWei", "quoteReason"],
  check: ["slot", "state", "maxDriftBps", "valueWei", "checkedAt"],
  leg: ["slot", "side", "token", "symbol", "amountWei", "quotedOutAtomic", "minOutAtomic", "proceedsAtomic", "state", "txHash", "createdAt", "detail"],
  detail: ["id", "executionState", "executionReason", "quantityAtomic", "quantityReason", "quoteWei", "quoteReason"],
};
const sorted = (value: object): string[] => Object.keys(value).sort();

function viewFor(f: Fixture, extra: Partial<Parameters<typeof createAgenticPublicView>[0]> = {}, observed: { count: number } = { count: 0 }) {
  return createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore, killswitch: f.killswitch,
    observer: { observe: async () => { observed.count += 1; return []; } }, chain: f.chain, journal: f.journal,
    portfolioNames: () => async () => new Map([[SPYB, "SPDR S&P 500"], [QQQB, "Invesco QQQ"], ["0x0000000000000000000000000000000000000001", "ignored"]]),
    portfolioValue: () => async ({ amountInAtomic }) => amountInAtomic, ...extra });
}
type Block = { tokens: Record<string, unknown>[]; check: Record<string, unknown> | null; legs: { detail: Record<string, unknown> }[] } & Record<string, unknown>;

test("PV1 public view: the portfolio block has the Altana block's keys at every level, opaque leg ids, executed quantities from the stored receipts, and no observer call", async t => {
  const world = await lane(t), observed = { count: 0 };
  await world.tick(); await world.at(NOW + 60_000); await world.tick(); await world.at(NOW + 120_000); await world.tick();
  const dto = (await viewFor(world.f, {}, observed)(W)).agent!;
  const block = dto.portfolio as Block;
  assert.equal(observed.count, 0);
  assert.deepEqual(sorted(block), [...KEYS.block].sort());
  assert.deepEqual(sorted(block.tokens[0]!), [...KEYS.token].sort());
  assert.deepEqual(sorted(block.tokens[0]!["initial"] as object), [...KEYS.initial].sort());
  assert.deepEqual(sorted(block.check!), [...KEYS.check].sort());
  assert.equal(block.legs.length, 2);
  for (const leg of block.legs) { assert.deepEqual(sorted(leg), [...KEYS.leg].sort()); assert.deepEqual(sorted(leg.detail), [...KEYS.detail].sort()); }
  const decisions = (await world.f.intents.listPortfolio(W, world.f.agent.id)).map(i => i.decisionId);
  assert.deepEqual(block.legs.map(l => l.detail["id"]).sort(), decisions.map(opaque).sort());
  for (const leg of block.legs) { assert.match(String(leg.detail["id"]), /^[0-9a-f]{16}$/u); assert.equal(decisions.includes(String(leg.detail["id"])), false); }
  // Executed quantities come from the chain receipt stored with each committed Agentic order (the lane's fake fills are 1:1: 25 USDT buys 25 shares).
  for (const token of block.tokens) assert.deepEqual([(token["initial"] as Record<string, unknown>)["quantityAtomic"], (token["initial"] as Record<string, unknown>)["quantityReason"]], [(25n * E).toString(), null]);
  for (const leg of block.legs) assert.deepEqual([leg.detail["quantityAtomic"], leg.detail["quantityReason"]], [(25n * E).toString(), null]);
  assert.deepEqual({ capital: block["capitalQuoteWei"], invested: block["netInvestedWei"], cashCap: block["cashCapWei"], wallet: block["walletUsdtWei"], idle: block["idleUsdtWei"],
    stock: block["stockValueWei"], total: block["totalValueWei"], pnl: block["pnlWei"], drift: block["driftBps"], interval: block["intervalSec"], anchor: block["anchorMs"], slot: block["currentSlot"] },
  { capital: (50n * E).toString(), invested: (50n * E).toString(), cashCap: "0", wallet: (2n * E).toString(), idle: (2n * E).toString(), stock: (50n * E).toString(),
    total: (50n * E).toString(), pnl: "0", drift: 0, interval: 14_400, anchor: NOW, slot: 0 });
  assert.deepEqual(block.tokens.map(token => [token["token"], token["symbol"], token["displayName"], token["targetBps"], token["weightBps"], token["valueWei"]]),
    [[SPYB, "SPYB", "SPDR S&P 500", 5_000, 5_000, (25n * E).toString()], [QQQB, "QQQB", "Invesco QQQ", 5_000, 5_000, (25n * E).toString()]]);
  assert.deepEqual({ slot: block.check!["slot"], state: block.check!["state"] }, { slot: 0, state: "done" });
  assert.equal((dto.settings as Record<string, unknown>)["portfolioDriftBps"], 50);
  assert.equal(dto.status, "running"); assert.equal(dto.termEndAction, "keep");
  assert.deepEqual(dto.positions, []);
});

test("PV2 public view: a failed required read gives portfolio null; a failed value read nulls every total, weight and drift; name and journal failures degrade only their fields", async t => {
  const world = await lane(t);
  await world.tick(); await world.at(NOW + 60_000); await world.tick();
  const read = async (extra: Parameters<typeof viewFor>[1]) => (await viewFor(world.f, extra)(W)).agent!;
  const usdt = world.f.chain.balance;
  world.f.chain.balance = async (wallet, token) => { if (token !== null && token.toLowerCase() === SPYB) throw new Error("rpc"); return usdt(wallet, token); };
  let dto = await read({});
  assert.equal(Object.hasOwn(dto, "portfolio"), true); assert.equal(dto.portfolio, null);
  world.f.chain.balance = async (wallet, token) => { if (token !== null && token.toLowerCase() === "0x55d398326f99059ff775485246999027b3197955") throw new Error("rpc"); return usdt(wallet, token); };
  assert.equal((await read({})).portfolio, null);
  world.f.chain.balance = usdt;
  assert.equal((await read({ journal: { get: world.f.journal.get.bind(world.f.journal), sumPendingQuoteSpendSince: async () => { throw new Error("db"); } } })).portfolio, null);
  dto = await read({ portfolioValue: () => async ({ token, amountInAtomic }) => { if (token === QQQB) throw new Error("pool"); return amountInAtomic; } });
  const block = dto.portfolio as Block;
  assert.deepEqual({ stock: block["stockValueWei"], total: block["totalValueWei"], pnl: block["pnlWei"], drift: block["driftBps"] }, { stock: null, total: null, pnl: null, drift: null });
  assert.deepEqual(block.tokens.map(token => [token["valueWei"], token["valueReason"], token["weightBps"], token["driftBps"]]),
    [[(25n * E).toString(), null, null, null], [null, "quote-unavailable", null, null]]);
  dto = await read({ portfolioValue: () => undefined, portfolioNames: () => async () => { throw new Error("plane"); } });
  assert.deepEqual((dto.portfolio as Block).tokens.map(token => [token["valueWei"], token["valueReason"], token["displayName"]]), [[null, "quote-unavailable", null], [null, "quote-unavailable", null]]);
  dto = await read({ journal: { get: async () => { throw new Error("db"); }, sumPendingQuoteSpendSince: async () => 0n } });
  const legs = (dto.portfolio as Block).legs;
  // A failed journal read degrades only the execution state; the executed quantity is read from the order's own stored receipt.
  assert.deepEqual(legs.map(l => [l.detail["executionReason"], l.detail["quantityAtomic"], l.detail["quantityReason"]]),
    [["unavailable", (25n * E).toString(), null], ["unavailable", (25n * E).toString(), null]]);
  assert.equal((dto.portfolio as Block).tokens[0]!["displayName"], "SPDR S&P 500");
});

test("PV3 public view: AI and Schedule agents carry no portfolio key and today's settings keys, and the AI agent still calls the observer", async t => {
  for (const [name, f] of [["ai", await fixture(t)], ["schedule", await fixture(t, {}, scheduleParams)]] as const) {
    const observed = { count: 0 }, dto = (await viewFor(f, {}, observed)(W)).agent!;
    assert.equal(Object.hasOwn(dto, "portfolio"), false, name);
    assert.equal(Object.hasOwn(dto.settings, "portfolioDriftBps"), false, name);
    assert.equal(observed.count, name === "ai" ? 1 : 0, name);
  }
});

test("PV4 public view: a portfolio run keeps its closed refusal codes; an AI run keeps today's rule; a proof-conflict reason never leaves the plane", async t => {
  const insert = async (f: Fixture) => f.positions.insertRun({ agentId: f.agent.id, ownerAddress: W, dryRun: false, reason: "AGENTIC_LOW_BNB;candidates=2", events: [
    { stage: "screen", code: "portfolio-refused", token: SPYB, reason: "portfolio_leg_taken", elapsedMs: 0 },
    { stage: "screen", code: "portfolio-refused", token: QQQB, reason: "not a closed code; private text", elapsedMs: 0 },
    { stage: "screen", code: "portfolio-proof-conflict", token: SPYB, reason: "decision-5f6a1c52-6a44-4f0e-9d6c-2d3b1e6a9d10", elapsedMs: 0 },
    { stage: "cycle", code: "agent-error:private", token: SPYB, reason: "portfolio_leg_taken", elapsedMs: 0 }] });
  const { f } = await afterBasket(t);
  await insert(f);
  const portfolioRun = (await viewFor(f)(W)).agent!.runs.find(run => run.reason.startsWith("AGENTIC_LOW_BNB"))!;
  assert.equal(portfolioRun.reason, "AGENTIC_LOW_BNB;candidates=2");
  assert.deepEqual(portfolioRun.events.map(e => [e.code, "reason" in e ? e.reason : undefined]), [["portfolio-refused", "portfolio_leg_taken"], ["portfolio-refused", undefined], ["portfolio-proof-conflict", undefined], ["agent-error:private", undefined]]);
  assert.equal(JSON.stringify(portfolioRun).includes("5f6a1c52"), false);
  await f.positions.insertRun({ agentId: f.agent.id, ownerAddress: W, dryRun: false, reason: "portfolio_leg_taken;candidates=1", events: [] });
  assert.equal((await viewFor(f)(W)).agent!.runs.some(run => run.reason === "portfolio_leg_taken;candidates=1"), true);
  const ai = await fixture(t);
  await insert(ai);
  await ai.positions.insertRun({ agentId: ai.agent.id, ownerAddress: W, dryRun: false, reason: "portfolio_leg_taken;candidates=1", events: [] });
  assert.equal((await viewFor(ai)(W)).agent!.runs.some(run => run.reason === "other;candidates=1"), true);
  const aiRun = (await viewFor(ai)(W)).agent!.runs.find(run => run.reason.endsWith("candidates=2"))!;
  assert.equal(aiRun.reason, "other;candidates=2");
  assert.deepEqual(aiRun.events.map(e => "reason" in e), [false, false, false, false]);
});

test("PV5 wiring (source scan): the plane passes the journal, the trimmed lane names and a lazy pinned-pool valuation to the public view", () => {
  const index = readFileSync("src/index-server.ts", "utf8").replaceAll("\r\n", "\n");
  for (const needle of ["journal, portfolioNames: () => tradeDataPlane === undefined ? undefined : async () => new Map(((await tradeDataPlane.universe(\"bstocks\")) ?? []).flatMap(row =>",
    "typeof row.name === \"string\" && row.name.trim() !== \"\" ? [[row.address.toLowerCase(), row.name.trim()] as const] : [])),",
    "portfolioValue: () => tradeRouteReader === undefined ? undefined : input => portfolioStockValue(tradeRouteReader, input.token, input.amountInAtomic) }),"]) assert.ok(index.includes(needle), needle);
});

test("PV6 public view: after a rebalance sale the cash cap, portfolio cash, idle amount and per-token drift follow the Altana formulas", async t => {
  const world = await afterBasket(t);
  await world.at(NOW + SLOT); await world.tick();
  const block = (await viewFor(world.f)(W)).agent!.portfolio as Block;
  // SPYB 24, QQQB 24.5, 0.5 USDT of proceeds inside the capital cap, 2.05 USDT in the wallet before the sale plus the proceeds.
  assert.deepEqual({ invested: block["netInvestedWei"], cashCap: block["cashCapWei"], cash: block["portfolioCashWei"], wallet: block["walletUsdtWei"], idle: block["idleUsdtWei"],
    stock: block["stockValueWei"], total: block["totalValueWei"], pnl: block["pnlWei"], drift: block["driftBps"] },
  { invested: (495n * E / 10n).toString(), cashCap: (E / 2n).toString(), cash: (E / 2n).toString(), wallet: (255n * E / 100n).toString(), idle: (205n * E / 100n).toString(),
    stock: (485n * E / 10n).toString(), total: (49n * E).toString(), pnl: (-E).toString(), drift: 204 });
  assert.deepEqual(block.tokens.map(token => [token["valueWei"], token["weightBps"], token["driftBps"]]), [[(24n * E).toString(), 4897, 204], [(245n * E / 10n).toString(), 5000, 0]]);
});
test("PV7 executed quantity: the stock moved by a committed swap, summed from its stored receipt's Transfer logs (in for a buy, out for a sell), else null", () => {
  const TRANSFER = keccak256(stringToBytes("Transfer(address,address,uint256)"));
  const USDT = "0x55d398326f99059ff775485246999027b3197955", OTHER = "0x00000000000000000000000000000000000000aa";
  const word = (a: string): string => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const log = (token: string, from: string, to: string, v: bigint, extra: Record<string, unknown> = {}) =>
    ({ address: token, topics: [TRANSFER, word(from), word(to)], data: "0x" + v.toString(16).padStart(64, "0"), ...extra });
  const order = (side: "buy" | "sell", logs: unknown[], over: Record<string, unknown> = {}) => ({ side, outcome: "committed", walletAddress: W,
    fromToken: side === "buy" ? USDT : SPYB, toToken: side === "buy" ? SPYB : USDT, evidence: { observation: { receipt: { logs } } }, ...over }) as unknown as AgenticOrder;
  assert.equal(agenticExecutedQuantity(order("buy", [log(USDT, W, OTHER, 25n * E), log(SPYB, OTHER, W, 7n), log(SPYB.toUpperCase().replace("0X", "0x"), OTHER, W, 3n),
    log(SPYB, W, OTHER, 100n), log(SPYB, OTHER, W, 50n, { removed: true }), log(QQQB, OTHER, W, 9n), { ...log(SPYB, OTHER, W, 11n), topics: [TRANSFER, word(OTHER)] },
    { ...log(SPYB, OTHER, W, 13n), data: "0x01" }, { ...log(SPYB, OTHER, W, 17n), topics: [TRANSFER, word(W), word(W), word(W)] }, null])), 10n);
  // An operator disposition stores the receipt under `proof` (scripts/agentic-gate.ts dispose).
  assert.equal(agenticExecutedQuantity(order("buy", [], { evidence: { disposition: "commit", proof: { observation: { receipt: { logs: [log(SPYB, OTHER, W, 8n)] } } } } })), 8n);
  assert.equal(agenticExecutedQuantity(order("sell", [log(SPYB, W, OTHER, 4n), log(SPYB, OTHER, W, 6n), log(USDT, OTHER, W, 5n * E)])), 4n);
  assert.equal(agenticExecutedQuantity(order("buy", [log(SPYB, OTHER, W, 7n)], { outcome: "open" })), null);
  assert.equal(agenticExecutedQuantity(order("buy", [log(SPYB, OTHER, W, 7n)], { outcome: "rolled-back" })), null);
  assert.equal(agenticExecutedQuantity(order("buy", [], { evidence: { code: "binance-rejected" } })), null);
  assert.equal(agenticExecutedQuantity(order("buy", [], { evidence: null })), null);
  assert.equal(agenticExecutedQuantity(order("buy", [log(USDT, W, OTHER, E)])), null);
  assert.equal(agenticExecutedQuantity(undefined), null);
});
