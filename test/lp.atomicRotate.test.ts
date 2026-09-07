import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, toEventSelector, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { parseAtomicRotateReceipt } from "../src/lp/atomicRotateReceipt.js";
import { verifyLpAbandonSequence, lpAmbiguityWindDownDoor } from "../src/lp/abandonSequence.js";
import { MemoryLpSequenceStore, PostgresLpSequenceStore, lpStepDecisionId } from "../src/store/lpSequences.js";
import { MemoryExecutionJournal, type JournalState, type JournalEntry } from "../src/store/journal.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { resolveLpAtomicRotate } from "../src/lp/wiring.js";
import { sagaMintFloors } from "../src/lp/rails.js";
import { getLiquidityForAmounts, getMintAmountsForLiquidity } from "../src/lp/tickMath.js";
const NFPM = "0x1111111111111111111111111111111111111111" as Address;
const WALLET = "0x2222222222222222222222222222222222222222" as Address;
const POOL = "0x3333333333333333333333333333333333333333" as Address;
const TOKEN = "0x4444444444444444444444444444444444444444" as Address;
const TX = `0x${"ab".repeat(32)}` as Hex;
const topic = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const addressTopic = (a: Address): Hex => `0x${a.slice(2).padStart(64, "0")}`;
type Log = Parameters<typeof parseAtomicRotateReceipt>[0][number];
const identity = { oldTokenId: 42n, nfpm: NFPM, pool: POOL, wallet: WALLET };
function logs(direction: -1 | 0 | 1): Log[] {
  const event = (sig: string, id: bigint, data: Hex): Log => ({ address: NFPM, topics: [toEventSelector(sig), topic(id)], data });
  const amounts = (a: bigint, b: bigint) => encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], [100n, a, b]);
  const list: Log[] = [event("DecreaseLiquidity(uint256,uint128,uint256,uint256)", 42n, amounts(1000n, 1000n)),
    event("Collect(uint256,address,uint256,uint256)", 42n, encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [WALLET, 1010n, 1020n]))];
  // Actual ERC-20 transfer noise: collect out and mint in, plus swap in/out.
  for (let i = 0; i < 6; i++) list.push({ address: TOKEN, topics: [toEventSelector("Transfer(address,address,uint256)"), addressTopic(i % 2 ? POOL : WALLET), addressTopic(i % 2 ? WALLET : POOL)], data: topic(100n) });
  if (direction !== 0) list.push({ address: POOL,
    topics: [toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"), addressTopic(WALLET), addressTopic(WALLET)],
    data: encodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint128" }, { type: "uint128" }],
      direction === 1 ? [100n, -90n, 1n << 96n, 100n, 0, 0n, 0n] : [-90n, 100n, 1n << 96n, 100n, 0, 0n, 0n]) });
  list.push({ address: NFPM, topics: [toEventSelector("Transfer(address,address,uint256)"), topic(0n), addressTopic(WALLET), topic(99n)], data: "0x" });
  list.push(event("IncreaseLiquidity(uint256,uint128,uint256,uint256)", 99n, amounts(800n, 800n)));
  return list;
}
describe("atomic rotate combined receipt", () => {
  for (const direction of [-1, 0, 1] as const) it(`mixed real-shaped logs decode direct pool deltas direction=${direction}`, () => {
    const receipt = parseAtomicRotateReceipt(logs(direction), identity);
    assert.deepEqual(receipt.decreased, { amount0: 1000n, amount1: 1000n }); assert.deepEqual(receipt.collected, { amount0: 1010n, amount1: 1020n });
    assert.deepEqual(receipt.minted, { tokenId: 99n, amount0: 800n, amount1: 800n });
    assert.deepEqual(receipt.swap, direction === 0 ? null : direction === 1 ? { amount0Delta: 100n, amount1Delta: -90n } : { amount0Delta: -90n, amount1Delta: 100n });
  });
  for (const name of ["decrease", "collect", "mint", "increase", "swap"] as const) for (const alteration of ["missing", "duplicate"] as const) {
    if (name === "swap" && alteration === "missing") continue;
    it(`refuses ${alteration} ${name} evidence`, () => {
      const base = logs(1); const indices = { decrease: 0, collect: 1, swap: 8, mint: 9, increase: 10 }; const i = indices[name];
      const altered = alteration === "duplicate" ? [...base, base[i]!] : base.filter((_, index) => i !== index);
      assert.throws(() => parseAtomicRotateReceipt(altered, identity), /receipt evidence/);
    });
  }
  it("rejects wrong old/new identity, recipient, pool, signs and malformed ABI", () => {
    const base = logs(1);
    assert.throws(() => parseAtomicRotateReceipt(base, { ...identity, oldTokenId: 41n }));
    assert.throws(() => parseAtomicRotateReceipt(base, { ...identity, wallet: TOKEN }));
    assert.throws(() => parseAtomicRotateReceipt(base, { ...identity, pool: TOKEN }));
    assert.throws(() => parseAtomicRotateReceipt(base.map((l, i) => i === 10 ? { ...l, topics: [l.topics[0]!, topic(42n)] } : l), identity));
    assert.throws(() => parseAtomicRotateReceipt(base.map((l, i) => i === 8 ? { ...l, data: `0x${topic(100n).slice(2)}${l.data.slice(66)}` as Hex, address: TOKEN } : l), identity));
    assert.throws(() => parseAtomicRotateReceipt(base.map((l, i) => i === 1 ? { ...l, data: "0x" } : l), identity));
  });
});

async function seedStates(states: readonly JournalState[]) {
  const store = new MemoryLpSequenceStore(() => 1000); const journal = new MemoryExecutionJournal(() => 1000);
  const position = await store.createPosition({ positionId: "p", ownerAddress: WALLET, agentId: "a", token0: NFPM, token1: TOKEN, fee: 500, tokenId: "42", basisWei: 100n });
  let sequence = await store.createSequence({ positionId: "p", ownerAddress: WALLET, agentId: "a", kind: "rotate" });
  const rows = new Map<string, JournalEntry | null>();
  for (const [index, state] of states.entries()) {
    const key = "attempt-" + index;
    await store.appendStep(WALLET, "a", sequence.sequenceId, { kind: "rotate-atomic", journalIdempotencyKey: key, priorTokenId: "42" });
    await journal.begin({ idempotencyKey: key, ownerAddress: WALLET, agentId: "a", kind: "lp", decisionId: lpStepDecisionId(sequence.sequenceId, index) });
    if (state === "ROLLED_BACK") await journal.markRolledBack(key, "pre-bind refusal");
    if (state === "UNKNOWN") await journal.markUnknown(key, "ambiguous");
    if (state === "IN_PROGRESS") await journal.markInProgress(key, { callsId: TX });
    if (state === "COMMITTED") { await journal.markInProgress(key, { callsId: TX }); await journal.markCommitted(key, { txHash: TX }); }
    rows.set(key, await journal.get(key));
  }
  await store.setRecoveryState(WALLET, "a", sequence.sequenceId, "rotate-ambiguous");
  sequence = await store.setSequenceState(WALLET, "a", sequence.sequenceId, "held");
  return { store, journal, position, sequence, rows, input: { sequence, stepRows: rows, nextIndexRow: null, positionState: "open" as const, nowMs: 100_000, minIdleMs: 1000, stallLatchAttempts: 3 } };
}
describe("atomic rotate complete-history abandon", () => {
  for (const state of ["UNKNOWN", "PENDING", "IN_PROGRESS"] as const) it(`${state} after clean retries relinquishes only this position and leaves journal untouched`, async () => {
    const fx = await seedStates(["ROLLED_BACK", "ROLLED_BACK", state]); const before = await fx.journal.get("attempt-2");
    const verdict = verifyLpAbandonSequence(fx.input); assert.ok(verdict.ok); if (!verdict.ok) return;
    assert.equal(verdict.positionAction, "close"); assert.equal(verdict.positionScope, "position"); assert.match(verdict.note!, /old NFT 42/); assert.match(verdict.note!, /MAY exist/); assert.match(verdict.note!, /may still land/);
    assert.deepEqual(await fx.journal.get("attempt-2"), before); assert.equal(lpAmbiguityWindDownDoor(fx.sequence), "declared-ambiguity-abandon");
  });
  it("COMMITTED attempt is replay-only until the durable stall threshold, including earlier attempts", async () => {
    const fx = await seedStates(["ROLLED_BACK", "COMMITTED", "ROLLED_BACK"]);
    assert.equal(verifyLpAbandonSequence(fx.input).ok, false);
    const verdict = verifyLpAbandonSequence({ ...fx.input, sequence: { ...fx.sequence, stallCount: 3 } });
    assert.ok(verdict.ok); if (verdict.ok) assert.equal(verdict.positionAction, "close");
  });
  it("all clean rollbacks leave the old position open; submitted rollback is not called clean", async () => {
    const fx = await seedStates(["ROLLED_BACK", "ROLLED_BACK"]); const verdict = verifyLpAbandonSequence(fx.input);
    assert.ok(verdict.ok); if (verdict.ok) assert.equal(verdict.positionAction, "leave");
    const row = fx.rows.get("attempt-1")!; fx.rows.set("attempt-1", { ...row, externalRef: { callsId: TX } });
    assert.equal(verifyLpAbandonSequence(fx.input).ok, false);
  });
  it("refuses a next-index row, missing lookup, mixed history, active/fresh sequence and legacy UNKNOWN", async () => {
    const fx = await seedStates(["ROLLED_BACK", "UNKNOWN"]);
    assert.equal(verifyLpAbandonSequence({ ...fx.input, nextIndexRow: fx.rows.get("attempt-0")! }).ok, false);
    assert.throws(() => verifyLpAbandonSequence({ ...fx.input, stepRows: new Map() }), /every attempt lookup/);
    assert.equal(verifyLpAbandonSequence({ ...fx.input, sequence: { ...fx.sequence, state: "active" } }).ok, false);
    assert.equal(verifyLpAbandonSequence({ ...fx.input, nowMs: 1000 }).ok, false);
    const legacy = { ...fx.sequence, recoveryState: "pending-mint" as const, steps: fx.sequence.steps.map(s => ({ ...s, kind: "zap-out" as const })) };
    assert.equal(verifyLpAbandonSequence({ ...fx.input, sequence: legacy }).ok, false); assert.equal(lpAmbiguityWindDownDoor(legacy), "none");
    assert.equal(verifyLpAbandonSequence({ ...fx.input, sequence: { ...legacy, recoveryState: "rotate-ambiguous" } }).ok, false);
  });
});

describe("atomic rotate stores and configuration", () => {
  for (const backend of ["memory", "postgres"] as const) it(`${backend} persists immutable prior identity and validates rotate recovery across reads`, async () => {
    const sql = new FakeSqlClient(); const store = backend === "memory" ? new MemoryLpSequenceStore() : await PostgresLpSequenceStore.create(sql);
    if (backend === "postgres") await PostgresLpSequenceStore.create(sql);
    await store.createPosition({ positionId: "p", ownerAddress: WALLET, agentId: "a", token0: NFPM, token1: TOKEN, fee: 500, tokenId: "42", basisWei: 100n });
    const seq = await store.createSequence({ positionId: "p", ownerAddress: WALLET, agentId: "a", kind: "rotate" });
    await store.appendStep(WALLET, "a", seq.sequenceId, { kind: "rotate-atomic", journalIdempotencyKey: "k", priorTokenId: "42" });
    await store.setRecoveryState(WALLET, "a", seq.sequenceId, "rotate-ambiguous");
    assert.equal((await store.getSequence(WALLET, "a", seq.sequenceId))?.priorTokenId, "42");
    assert.equal((await store.getSequence(WALLET, "a", seq.sequenceId))?.recoveryState, "rotate-ambiguous");
    await assert.rejects(store.appendStep(WALLET, "a", seq.sequenceId, { kind: "rotate-atomic", journalIdempotencyKey: "bad", priorTokenId: "99" }), /immutable/);
    assert.equal((await store.getSequence(WALLET, "a", seq.sequenceId))?.steps.length, 1);
  });
  it("fresh and upgrade recovery DDL include rotate and boot invokes idempotent widening", () => {
    const source = readFileSync(new URL("../src/store/lpSequences.ts", import.meta.url), "utf8");
    assert.match(source, /not like '%rotate-ambiguous%'/); assert.match(source, /for \(const ddl of LP_SEQUENCES_ROTATE_RECOVERY_CHECK_DDL\) await sql.query\(ddl\)/);
    assert.match(source, /add column if not exists prior_token_id text/);
    assert.equal((source.match(/check \(recovery_state in \([^\n]*'rotate-ambiguous'/g) ?? []).length, 2);
  });
  it("operator flag defaults on and false/0/off disable new atomic plans", () => {
    assert.equal(resolveLpAtomicRotate({}), true);
    for (const value of ["false", "0", "off", " OFF "]) assert.equal(resolveLpAtomicRotate({ LP_ROTATE_ATOMIC: value }), false);
    assert.equal(resolveLpAtomicRotate({ LP_ROTATE_ATOMIC: "true" }), true);
  });
});

it("R2.5 known gap: review-5 fixture re-admits +250 bps under the 100-bps rail", { todo: "Operator deferred analytic certification; shipped floor mathematics retained unchanged." }, () => {
  const sqrt = 269501145059849690938n, a0 = 77782240258547434474793250151n, a1 = 1000000000000n;
  const liquidity = getLiquidityForAmounts(sqrt, -400000, -380000, a0, a1);
  const floors = sagaMintFloors({ sqrtPriceX96: sqrt, tickLower: -400000, tickUpper: -380000, liquidity, maxSagaSlippageBps: 100, amount0Desired: a0, amount1Desired: a1 });
  const execution = 272849113739294975679n;
  const consumed = getMintAmountsForLiquidity(execution, -400000, -380000, getLiquidityForAmounts(execution, -400000, -380000, a0, a1));
  assert.ok(consumed.amount0 < floors.amount0Min || consumed.amount1 < floors.amount1Min, "known rail violation: both floors admit execution outside the signed rail");
});

it("atomic abandon inspects retired legacy attempts but never admits live legacy work", async () => {
  const fx = await seedStates(["ROLLED_BACK", "UNKNOWN"]);
  const steps = fx.sequence.steps.map((step, index) => index === 0 ? { ...step, kind: "zap-out" as const } : step);
  assert.equal(verifyLpAbandonSequence({ ...fx.input, sequence: { ...fx.sequence, steps } }).ok, true);
  const row = fx.rows.get("attempt-0")!; fx.rows.set("attempt-0", { ...row, state: "UNKNOWN" });
  assert.equal(verifyLpAbandonSequence({ ...fx.input, sequence: { ...fx.sequence, steps } }).ok, false);
});
