/** AGENTIC-DCA Revision 3 (3.16 as amended by R3.10, R31.3): the public DCA block, field by field. */
import assert from "node:assert/strict";
import test from "node:test";
import { createAgenticPublicView } from "../src/agentic/publicView.js";
import { E, NOW, W } from "./support/agenticSchedule.js";
import { MINUTE, dcaLane, type DcaWorld } from "./support/agenticDca.js";

const view = (w: DcaWorld) => createAgenticPublicView({ store: w.f.store, agents: w.f.agents, settings: w.f.settings, positions: w.f.positions, intents: w.f.intents, cmc: w.f.cmcStore,
  killswitch: w.f.killswitch, observer: { observe: async () => { throw new Error("a DCA hire has no observer"); } }, chain: w.f.chain, journal: w.f.journal });
const dto = async (w: DcaWorld) => (await view(w)(W)).agent as unknown as Record<string, unknown> & { dca: Record<string, unknown> };
async function run(w: DcaWorld, n: number) { for (let i = 0; i < n; i += 1) { await w.tick(); await w.advance(MINUTE); } }

test("V1 the DCA block carries exactly the R3.10 keys; no strategy id, no noTakeProfit, no ordersUnverified, no unattributed; no cmcLog, no positions, no observer call", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  const a = await dto(w);
  assert.equal("cmcLog" in a, false);
  assert.deepEqual(a["positions"], []);
  assert.deepEqual(Object.keys(a.dca), ["token", "symbol", "fee", "usdtIsToken0", "mark", "settings", "round", "rounds", "equity", "wallet", "walletReason", "reason", "heldOrders",
    "history", "actions", "keepAlive"]);
  assert.deepEqual(Object.keys(a.dca["settings"] as object), ["stepBps", "takeProfitBps", "baseWei", "orderWei", "maxOrders", "triggerE8", "rangeMinE8", "rangeMaxE8", "stopLossBps"]);
  const round = a.dca["round"] as Record<string, unknown>;
  assert.deepEqual(Object.keys(round), ["roundNo", "phase", "closeCause", "openedAt", "p0E8", "avgCostE8", "tpTargetE8", "costUsdtWei", "stockHeldWei", "realizedPnlWei", "levels", "tp", "base"]);
  assert.deepEqual(Object.keys((round["levels"] as object[])[0]!), ["levelNo", "levelPriceE8", "state", "priceE8", "usdtWei", "stockWei", "txHash", "closedBy"]);
  assert.deepEqual(Object.keys(round["tp"] as object), ["state", "priceE8", "usdtWei", "stockWei", "txHash", "closedBy"]);
  assert.deepEqual(Object.keys(round["base"] as object), ["usdtWei", "stockWei", "txHash", "atMs"]);
  assert.deepEqual(Object.keys(a.dca["keepAlive"] as object), ["lastActivityAtMs", "dueAtMs", "lastPaidAtMs"]);
  assert.deepEqual(Object.keys(a.dca["mark"] as object), ["e8", "block"]);
  assert.deepEqual(Object.keys(a.dca["wallet"] as object), ["usdtWei", "stockWei"]);
  assert.deepEqual(Object.keys(a.dca["equity"] as object), ["equityWei", "baselineWei", "stopAtWei", "markE8", "readingBlock"]);
  assert.equal(a.dca["walletReason"], null);
});

test("V2 values: prices x 1e8, level states (pending / resting / filled), the armed take profit, the base, fills and actions", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  w.setPrice(692.5); await w.tick(); // L1 fires and books
  await run(w, 2);
  w.setPrice(700);
  const a = await dto(w), round = a.dca["round"] as { levels: Record<string, unknown>[]; tp: Record<string, unknown>; base: Record<string, unknown>; p0E8: string; stockHeldWei: string };
  assert.equal(round.p0E8, "70000000000");
  assert.deepEqual(round.levels.map(l => [l["levelNo"], l["state"], l["levelPriceE8"]]), [[1, "filled", "69300000000"], [2, "resting", "68460000000"], [3, "pending", "67452000000"]]);
  assert.equal(round.levels[0]!["priceE8"], "69300000000", "the intended level price");
  assert.equal(round.levels[0]!["usdtWei"], (10n * E).toString());
  assert.equal(round.base["usdtWei"], (25n * E).toString());
  assert.match(String(round.base["txHash"]), /^0x[0-9a-f]{64}$/u);
  assert.equal(round.tp["state"], "resting");
  const fills = (a.dca["history"] as { fills: Record<string, unknown>[] }).fills;
  assert.deepEqual(fills.map(f => f["kind"]).sort(), ["base", "level"]);
  assert.deepEqual((a.dca["actions"] as Record<string, unknown>[]).map(x => x["kind"]).sort(), ["fill", "start"]);
  assert.equal(a.dca["reason"], null);
  assert.match(String(((a.dca["mark"] as { e8: string }).e8)), /^7\d{10}$/u);
});

test("V3 no internal key, operation id, fence or session field leaves the plane", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  const text = JSON.stringify(await view(w)(W));
  for (const needle of ["dca:" + w.f.agent.id, "limit-place:", "limit-cancel:", "claimant", "fenceToken", "sessionCiphertext", "pairingSecret", "operationId", "strategyId", w.f.agent.id]) {
    assert.equal(text.includes(needle), false, needle);
  }
});

test("V4 every failed read leaves its field null with a closed reason and never throws; a failed wallet read carries wallet-unreadable", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.failures.pool = true; w.failures.balance = true;
  const a = await dto(w);
  assert.deepEqual([a.dca["mark"], a.dca["wallet"], a.dca["equity"], a.dca["walletReason"], a.dca["reason"]], [null, null, null, "wallet-unreadable", "mark-unavailable"]);
  const walletOnly = await dcaLane(t);
  await run(walletOnly, 2);
  walletOnly.failures.balance = true;
  const b = await dto(walletOnly);
  assert.deepEqual([b.dca["wallet"], b.dca["walletReason"]], [null, "wallet-unreadable"], "the wallet reason does not depend on the pool read");
  const fresh = await dcaLane(t);
  assert.equal(((await dto(fresh)).dca["round"]), null);
  assert.equal((await dto(fresh)).dca["reason"], "no-active-round");
});

test("V5 a held order is counted; the keep-alive times follow the swap quotes", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  w.setPrice(692.5);
  w.market.swap = "lost";
  await w.tick(); await w.advance(MINUTE); await w.tick();
  assert.equal((await dto(w)).dca["heldOrders"], 1);
  const ka = (await dto(w)).dca["keepAlive"] as { lastActivityAtMs: number; dueAtMs: number; lastPaidAtMs: number | null };
  assert.equal(ka.dueAtMs, ka.lastActivityAtMs + 43_200_000);
  assert.equal(ka.lastPaidAtMs, null);
  assert.ok(ka.lastActivityAtMs >= NOW);
});

test("V6 a stop loss shows end reason stop-loss and the stopped round", async t => {
  const w = await dcaLane(t, { settings: { dcaStopLossBps: 100 } });
  await w.tick(); await w.advance(MINUTE);
  w.setPrice(690);
  await run(w, 3);
  const a = await dto(w);
  assert.equal(a["endReason"], "stop-loss");
  assert.equal((a.dca["round"] as { phase: string }).phase, "stopped");
});

test("V7 the marked total counts settled, stopped, ended and interrupted rounds once: an interrupted round's own marked value joins the realized PnL", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.setPrice(725); await w.tick(); // round 1 settles
  const [r1] = await w.rounds();
  await w.advance(2 * MINUTE); await w.tick(); // round 2: base at 725
  w.setPrice(700);
  await w.f.store.patchWallet(await w.wallet(), { state: "ended", sessionCiphertext: null, endReason: "owner-signed-out" });
  await w.advance(MINUTE); await w.tick();
  const rounds = await w.rounds();
  assert.deepEqual(rounds.map(r => r.phase), ["settled", "interrupted"]);
  const own = BigInt(rounds[1]!.markedPnlWei!);
  assert.ok(own < 0n, "round 2 was bought at 725 and marked at 700");
  const a = await dto(w);
  assert.equal(BigInt((a.dca["rounds"] as { markedPnlWei: string }).markedPnlWei), BigInt(r1!.realizedPnlWei!) + own);
});
