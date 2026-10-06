/** AGENTIC-DCA Revision 3: the store (CAS, uniqueness, atomic booking, leaveBound), the flags and boot line, and the source pins (no limit-order write anywhere, the restored files equal their pre-DCA text). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Hex } from "viem";
import { agenticDcaEnabled, resolveAgenticConfig } from "../src/agentic/config.js";
import type { AgenticDcaOrder, AgenticDcaRound } from "../src/agentic/domain.js";
import { NOW, W } from "./support/agenticSchedule.js";
import { dcaLane } from "./support/agenticDca.js";

const round = (patch: Partial<AgenticDcaRound> = {}): AgenticDcaRound => ({ agentId: "agentic-fixture", roundNo: 1, walletAddress: W, phase: "active", baseOrderKey: null, p0UsdtWei: "1", p0StockRaw: "1",
  costUsdtWei: "100", stockRaw: "10", carriedCostWei: "0", carriedStockRaw: "0", soldStockRaw: "0", proceedsUsdtWei: "0", realizedPnlWei: null, markedPnlWei: null, stopCounter: null,
  tpFilledAt: null, closeCause: null, failStreak: 0, backoffUntilMs: null, tpDueAt: null, openedAt: NOW, settledAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW, ...patch });
const dcaOrder = (key: string, patch: Partial<AgenticDcaOrder> = {}): AgenticDcaOrder => ({ orderKey: key, agentId: "agentic-fixture", walletAddress: W, roundNo: 1, role: "level", levelNo: 1, side: "buy",
  priceNum: "1", priceDen: "1", triggerSent: "", qtySent: "", qtyAtomic: "10", slippagePct: "0.5", placeOrderKey: null, cancelOrderKey: null, strategyId: null, listStatus: null, unitQty: null,
  unitTrigger: null, state: "resting", closedBy: null, holdReason: null, txHash: null, fillUsdtWei: null, fillStockRaw: null, executor: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW, ...patch });

test("ST1 rounds: one open round per agent, a stale row version is refused, a settled round frees the slot", async t => {
  const { f } = await dcaLane(t);
  assert.equal(await f.store.insertDcaRound(round()), true);
  assert.equal(await f.store.insertDcaRound(round({ roundNo: 2 })), false, "a second open round");
  assert.equal(await f.store.insertDcaRound(round()), false, "the same key");
  const [current] = await f.store.dcaRounds("agentic-fixture");
  const patched = await f.store.patchDcaRound(current!, { phase: "settled", realizedPnlWei: "5" });
  assert.deepEqual([patched?.phase, patched?.rowVersion], ["settled", 2]);
  assert.equal(await f.store.patchDcaRound(current!, { phase: "stopped" }), null, "the old version no longer matches");
  assert.equal(await f.store.insertDcaRound(round({ roundNo: 2 })), true);
});

test("ST2 orders: one DCA order per transaction hash, a stale row version is refused", async t => {
  const { f } = await dcaLane(t);
  assert.equal(await f.store.insertDcaOrder(dcaOrder("a")), true);
  assert.equal(await f.store.insertDcaOrder(dcaOrder("a")), false);
  assert.equal(await f.store.insertDcaOrder(dcaOrder("b")), true);
  const b = (await f.store.getDcaOrder("b"))!;
  assert.equal((await f.store.patchDcaOrder(b, { txHash: `0x${"11".repeat(32)}` }))?.txHash, `0x${"11".repeat(32)}`);
  assert.equal(await f.store.patchDcaOrder(b, { state: "held" }), null, "the old version no longer matches");
  await f.store.insertDcaOrder(dcaOrder("c"));
  assert.equal(await f.store.patchDcaOrder((await f.store.getDcaOrder("c"))!, { txHash: `0x${"11".repeat(32)}` }), null, "the same hash on another DCA order");
});

test("ST3 booking is one transaction: the order, the round ledger and the entries-stopped marker land together or not at all; a hash that is a swap row's own is accepted (R3.5)", async t => {
  const { f } = await dcaLane(t);
  await f.store.insertDcaRound(round());
  await f.store.insertDcaOrder(dcaOrder("o"));
  const r = (await f.store.dcaRounds("agentic-fixture"))[0]!, o = (await f.store.getDcaOrder("o"))!;
  const patch = { state: "filled" as const, txHash: `0x${"22".repeat(32)}` as Hex };
  assert.equal(await f.store.bookDcaFill({ order: o, orderPatch: patch, round: { ...r, rowVersion: 9 }, roundPatch: { costUsdtWei: "150" }, entriesStopped: null }), null);
  assert.deepEqual([(await f.store.getDcaOrder("o"))!.state, (await f.store.dcaRounds("agentic-fixture"))[0]!.costUsdtWei], ["resting", "100"]);
  const stop = { reason: "dca-fill-above-level" as const, out: "2", min: "1", atMs: NOW };
  const booked = await f.store.bookDcaFill({ order: o, orderPatch: patch, round: r, roundPatch: { costUsdtWei: "150" }, entriesStopped: stop });
  assert.equal(booked?.state, "filled");
  assert.equal((await f.store.dcaRounds("agentic-fixture"))[0]!.costUsdtWei, "150");
  assert.deepEqual((await f.store.byAgent("agentic-fixture"))!.entriesStopped, stop);
  assert.equal(await f.store.bookDcaFill({ order: o, orderPatch: patch, round: r, roundPatch: { costUsdtWei: "200" }, entriesStopped: null }), null, "idempotent: the same booking again is refused");
  assert.equal((await f.store.dcaRounds("agentic-fixture"))[0]!.costUsdtWei, "150");
  // the order's hash is its own swap row's: a hash already on a swap row is not refused
  const w = await dcaLane(t);
  await w.tick(); await w.advance(60_000); await w.tick();
  const swap = (await w.f.store.orders(W)).find(s => s.kind === "swap" && s.txHash !== null)!;
  const [tp] = (await w.orders()).filter(order => order.role === "tp");
  const [wr] = await w.rounds();
  const ok = await w.f.store.bookDcaFill({ order: tp!, orderPatch: { state: "filled", txHash: swap.txHash }, round: wr!, roundPatch: {}, entriesStopped: null });
  assert.equal(ok?.txHash, swap.txHash);
  // a second DCA order cannot take the same hash (the unique index and its twin)
  const [l1] = (await w.orders()).filter(order => order.role === "level");
  assert.equal(await w.f.store.bookDcaFill({ order: l1!, orderPatch: { state: "filled", txHash: swap.txHash }, round: (await w.rounds())[0]!, roundPatch: {}, entriesStopped: null }), null);
});

test("ST4 leaveBound: stop-loss writes the end reason and enters ending; term-ended leaves it null; owner-signed-out ends", async t => {
  for (const [reason, state, end] of [["stop-loss", "ending", "stop-loss"], ["term-ended", "ending", null], ["owner-signed-out", "ended", "owner-signed-out"]] as const) {
    const w = await dcaLane(t);
    const left = await w.f.store.leaveBound(await w.wallet(), reason);
    assert.deepEqual([left?.state, left?.endReason], [state, end], reason);
  }
});

test("FL1 flags: AGENTIC_DCA_ENABLED exactly true enables, empty or false is off, anything else refuses, true needs the wallet flag; the boot line reads the flags back", t => {
  assert.deepEqual([undefined, "", "false", "true"].map(v => agenticDcaEnabled(v === undefined ? {} : { AGENTIC_DCA_ENABLED: v })), [false, false, false, true]);
  for (const bad of ["TRUE", "1", "yes", "True", " true"]) assert.throws(() => agenticDcaEnabled({ AGENTIC_DCA_ENABLED: bad }), /AGENTIC_DCA_ENABLED/u, bad);
  assert.throws(() => resolveAgenticConfig({ AGENTIC_DCA_ENABLED: "true" }, { hireEnabled: true, tradeAgentEnabled: true, rpcUrls: [] }), /requires AGENTIC_WALLET_ENABLED/u);
  assert.deepEqual(resolveAgenticConfig({ AGENTIC_DCA_ENABLED: "false" }, { hireEnabled: true, tradeAgentEnabled: true, rpcUrls: [] }), { enabled: false });
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const env = { AGENTIC_WALLET_ENABLED: "true", DATABASE_URL: "postgres://x", EXECUTION_MASTER_KEY: "k", AGENTIC_BAW_CLI: process.platform === "win32" ? "C:\\\\baw.cjs" : "/baw.cjs" };
  const rpc = ["a", "b", "c"];
  const on = resolveAgenticConfig({ ...env, AGENTIC_DCA_ENABLED: "true" }, { hireEnabled: true, tradeAgentEnabled: true, rpcUrls: rpc });
  const off = resolveAgenticConfig(env, { hireEnabled: true, tradeAgentEnabled: true, rpcUrls: rpc });
  assert.deepEqual([on.enabled && on.dca, off.enabled && off.dca], [true, false]);
  assert.deepEqual(logs, ["agentic-flags wallet=true dca=true", "agentic-flags wallet=true dca=false"]);
  assert.throws(() => resolveAgenticConfig({ ...env, AGENTIC_DCA_ENABLED: "maybe" }, { hireEnabled: true, tradeAgentEnabled: true, rpcUrls: rpc }), /AGENTIC_DCA_ENABLED/u);
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/u.test(name) ? [path] : []; });
}
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/gu, "\n");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("PIN1 (DI3, L5-5) no limit-order write remains: no limit-order buy, sell or cancel, no limit-place or limit-cancel literal in src/agentic or scripts/agentic-gate.ts, outside the DDL, the kind union and the two admission reads", () => {
  const files = [...sources("src/agentic"), "scripts/agentic-gate.ts"];
  const allowed = (path: string, line: string): boolean => {
    const p = path.replaceAll("\\", "/");
    if (p === "src/agentic/store.ts" && /agentic_orders_kind_check/u.test(line)) return true; // the DDL (R3.8: it keeps both legacy kinds)
    if (p === "src/agentic/domain.ts" && /kind: "swap" \| "x402-sign" \| "limit-place" \| "limit-cancel"/u.test(line)) return true; // the kind union
    if (p === "src/agentic/routes.ts" && /"limit-order", "list"/u.test(line)) return true; // the two admission reads
    if (p === "src/agentic/baw.ts") return /limit-order list/u.test(line) || !/limit-(place|cancel)|limit-order (buy|sell|cancel)/u.test(line);
    return false;
  };
  const offenders: string[] = [];
  for (const path of files) for (const [index, line] of read(path).split("\n").entries()) {
    if (/limit-(place|cancel)|limit-order[ "',]*(buy|sell|cancel)|"limit-order"\s*,\s*"(buy|sell|cancel)"/u.test(line) && !allowed(path, line)) offenders.push(`${path}:${index + 1}`);
  }
  assert.deepEqual(offenders, []);
  const lists = files.filter(path => /\["limit-order", "(PENDING|WORKING|TRIGGERED)"\]/u.test(read(path))).map(path => path.replaceAll("\\", "/")).sort();
  assert.deepEqual(lists, ["src/agentic/routes.ts"], "limit-order list stays only for pairing admission");
  assert.ok(read("src/trade/worker.ts").includes("export async function tradfiActualPremiumAllowed"));
});

test("PIN2 (DI2) obligations.ts, cmc.ts and the claim and pay-check SQL and methods equal their pre-DCA text (b1e6aad); baw.ts equals its AGENTIC-EARN text (rule 39)", () => {
  // AGENTIC-EARN-SPEC 3.13: the six defi commands. Re-pinned once; the four other assertions are unchanged.
  assert.equal(sha(read("src/agentic/baw.ts")), "b664ee2217d0f2edffc7e67725195da003feba1a8e90a37b837318ba5db19247");
  assert.equal(sha(read("src/agentic/obligations.ts")), "346859081c990b1a9c15ab6ccb8b86489f37e33ac34cfb2df6a5797a31c7d6bf");
  assert.equal(sha(read("src/agentic/cmc.ts")), "af453b39dc05f48825532aae5bbe728b792359c642d6b480f44c02cf761cef01");
  const store = read("src/agentic/store.ts");
  const methods = store.slice(store.indexOf("  async walletObligations("), store.indexOf("  async createRun("));
  assert.equal(sha(methods), "4b98de8b2c2f200ce097b3305c8743cae2ddf7f2aee3b7a4c866775c5693b306");
  assert.equal(sha(store.slice(store.indexOf("export const AGENTIC_CLAIM_SQL"))), "55dd19103f34afeabb6e890864ee548cdece025aea286cb5be01e572b1276d45");
});

test("PIN3 the lane never calls the CMC runtime or pays, and answers dca-agentic-off, never dca-disabled", () => {
  const lane = read("src/agentic/dcaLane.ts");
  for (const needle of ["x402-payment", "createCmcRuntime", "runtime.worker", ".refresh(", "keepAliveAtMs", "dca-disabled"]) assert.equal(lane.includes(needle), false, needle);
});

test("PIN4 no new source or test string carries the em dash (U+2014)", () => {
  const files = ["src/agentic/dca.ts", "src/agentic/dcaLane.ts", ...sources("test").filter(path => /agentic\.dca\.|agenticDca/u.test(path)), "test/integration/agentic.dca.postgres.integration.ts"];
  for (const path of files) assert.equal(read(path).includes(String.fromCharCode(0x2014)), false, path);
});
