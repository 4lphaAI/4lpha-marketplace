import assert from "node:assert/strict";
import { it } from "node:test";
import { decodeFunctionData, keccak256, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { InfrastructureError } from "../src/core/types.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { encodeLpFinalCallsV1, fingerprintLpFinalCallsV1 } from "../src/lp/preparedIntentWitness.js";
import { MAX_CALLS_PER_EXECUTE } from "../src/wallet/altana.js";
import { MemoryTradeSimulationStore } from "../src/store/tradeSimulations.js";
import { classifySimulation, createTradfiEvidenceWriter, encodeTradfiSimulateTx, GUARD_DEADLINE_REASONS, netTransferDelta,
  predictedChange, preflightSimulate, recordSimulationActual, tradfiSimulateBudgetMs, TRADFI_SIMULATE_MAX_CALLS } from "../src/trade/simulate.js";
import type { TradfiSimulateResult } from "../src/trade/dataPlaneReads.js";
import { transferLog, WALLET, NV, OUTSIDER } from "./support/dcaFixtures.js";
const KEY = `0x${"11".repeat(32)}` as Hex;
const calls = [{ to: WALLET, data: "0x1234" as Hex }];
const result = (raw: string | null, status: "SUCCESS" | "FAILED" = "FAILED"): TradfiSimulateResult => ({ status, failReason: raw, balanceChanges: [], otherChangeCount: 0, upstreamMs: 10 });
const input = { agent: { id: "a", ownerAddress: WALLET, walletAddress: WALLET }, idempotencyKey: KEY, journalKind: "trade" as const,
  exposure: "increase" as const, route: "direct" as const, calls, outputToken: NV.stock, minOutAtomic: 1n, nowMs: 1_900_000_000_000 };

it("S1/S2 encoder uses final executionData, batch mode, count and value bounds", () => {
  const tx = encodeTradfiSimulateTx(WALLET, calls)!;
  assert.equal(tx.from, WALLET); assert.equal(tx.to, WALLET); assert.equal(tx.data.slice(0, 10), "0xe9ae5c53");
  const decoded = decodeFunctionData({ abi: parseAbi(["function execute(bytes32,bytes)"]), data: tx.data });
  assert.equal(decoded.args[0], `0x0100${"0".repeat(60)}`); assert.equal(decoded.args[1], encodeLpFinalCallsV1(calls));
  assert.equal(keccak256(decoded.args[1]), fingerprintLpFinalCallsV1(calls).value.executionDataHash);
  assert.equal(TRADFI_SIMULATE_MAX_CALLS, MAX_CALLS_PER_EXECUTE);
  for (const invalid of [[], Array(21).fill(calls[0]), [{ ...calls[0]!, value: 1n }], [{ to: WALLET, data: `0x${"00".repeat(98_304)}` as Hex }]]) assert.equal(encodeTradfiSimulateTx(WALLET, invalid), null);
});
it("S3 all A1 budget boundaries", () => {
  const deadline = 1_900_000_000n;
  assert.equal(tradfiSimulateBudgetMs(0), 2_000);
  for (const [remaining, expected] of [[14000, 2000], [8250, 2000], [8249, 1999], [7000, 750], [6550, 300], [6549, null], [6001, null], [5999, null]])
    assert.equal(tradfiSimulateBudgetMs(Number(deadline) * 1000 - remaining!, deadline), expected);
});
it("S4/S4b/S4c/R4.5 exact raw policy and bare-revert fact across exposure and routes", async () => {
  const vectors: [string | null, string][] = [
    ...GUARD_DEADLINE_REASONS.map(raw => [raw, "guard-deadline"] as [string, string]),
    ...["execution reverted", "execution reverted: Too little received", "execution reverted ", "execution reverted Arguments: x", "execution reverted: STF",
      "execution reverted: OutputShortfall() context=0xdccae4f5", "execution reverted: BEP20: transfer amount exceeds balance for 0xdccae4f51111111111111111111111111111111111",
      "execution reverted: 0xdccae4f5 ", "execution reverted: 0xDCCAE4F5", "execution reverted: 0xdccae4f50000", "execution reverted: 0x0b681433",
      "execution reverted: custom error 0xc1d86c6a", "execution reverted: panic: arithmetic underflow or overflow (0x11)",
      "execution reverted: DeadlineOutOfBounds() OutputShortfall()", "execution reverted Request body: details"].map(raw => [raw, "reverted"] as [string, string]),
    ...[null, " execution reverted", " execution reverted: 0xdccae4f5", "execution  reverted: x", "execution\nreverted: x", "Execution reverted: x",
      "transaction execution reverted", "insufficient funds for gas * price + value", "out of gas", ""].map(raw => [raw, "failed-other"] as [string | null, string]),
  ];
  for (const exposure of ["increase", "reduce"] as const) for (const route of ["direct", "guard", "none"] as const) for (const [raw, guardOutcome] of vectors) {
    const outcome = guardOutcome === "guard-deadline" && route !== "guard" ? "reverted" : guardOutcome;
    const store = new MemoryTradeSimulationStore(), writer = createTradfiEvidenceWriter(store, () => {});
    const verdict = await preflightSimulate({ simulate: async () => result(raw), evidence: writer }, { ...input, route, exposure });
    await writer.shutdown();
    const row = store.simulations.get(KEY)!;
    assert.equal(row.outcome, outcome, String(raw)); assert.equal(verdict.block, exposure === "increase" && outcome === "reverted" && route !== "guard");
    assert.equal(row.blocked, verdict.block);
    assert.equal(row.bareRevert, raw === "execution reverted"); assert.equal(row.failReason, raw === null ? null : sanitizeMessage(raw).slice(0, 160));
  }
  assert.equal(classifySimulation(result("execution reverted", "SUCCESS"), "guard").outcome, "success");
});
it("S4c recomputes every guard error selector", () => {
  const errors = { DeadlineOutOfBounds: "dccae4f5", InvalidAddress: "e6c4247b", InvalidPair: "1e4f7d8c", InvalidAmount: "2c5211c6",
    UnsupportedCall: "ddcfed35", TokenCallFailed: "3f409f9a", InputFundingMismatch: "6adb3f06", InputBalanceChanged: "cdce5670",
    OutputShortfall: "0b681433", OutputTransferMismatch: "9d042c4d", ReentrantCall: "37ed32e8", RouterCallFailed: "c1d86c6a" };
  for (const [name, selector] of Object.entries(errors)) assert.equal(toFunctionSelector(`${name}()`), `0x${selector}`);
});
it("S5/S6 failures never block, storage cannot change a verdict, prediction is unique and case-insensitive", async () => {
  for (const reason of ["window", "shape", "timeout", "rate-limited", "auth", "credentials", "unavailable", "malformed", "upstream-error", "bogus"] as const) {
    const store = new MemoryTradeSimulationStore(); const evidence = createTradfiEvidenceWriter(store, () => {});
    assert.equal((await preflightSimulate({ evidence, simulate: async () => { throw new InfrastructureError(`simulate:${reason}`); } }, input)).block, false);
    await evidence.shutdown(); assert.equal(store.simulations.get(KEY)?.reason, reason === "bogus" ? "unavailable" : reason);
  }
  for (const answer of [result(null, "SUCCESS"), result("execution reverted: x")]) {
    const verdict = await preflightSimulate({ evidence: { insert: () => { throw new Error("store"); } }, simulate: async () => answer }, input);
    assert.equal(verdict.block, answer.status === "FAILED");
  }
  assert.equal((await preflightSimulate({ evidence: { insert: () => {} }, simulate: async () => { throw new Error("plain"); } }, input)).block, false);
  const row = { token: NV.stock.toUpperCase() as Address, owner: WALLET.toUpperCase() as Address, change: -10n };
  const answer = { ...result(null, "SUCCESS"), balanceChanges: [row] };
  assert.equal(predictedChange(answer, WALLET, NV.stock), -10n);
  assert.equal(predictedChange({ ...answer, balanceChanges: [row, row] }, WALLET, NV.stock), null);
  assert.equal(predictedChange(answer, OUTSIDER, NV.stock), null);
});
it("B2 simulator race ends despite an ignored abort; late rejection is consumed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectLate: (error: Error) => void = () => {};
  let signal: AbortSignal | undefined;
  let reason: string | null = null;
  let returned = false;
  const pending = preflightSimulate({ evidence: { insert: row => { reason = row.reason; } }, simulate: async tx => {
    signal = tx.signal; return new Promise((_resolve, reject) => { rejectLate = reject; });
  } }, input).then(value => { returned = true; return value; });
  await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(2_000);
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  assert.equal(returned, true); assert.equal((await pending).block, false); assert.equal(reason, "timeout"); assert.equal(signal?.aborted, true); rejectLate(new Error("late")); await Promise.resolve();
  let guardSignal: AbortSignal | undefined;
  const guard = preflightSimulate({ evidence: { insert: () => {} }, simulate: async tx => {
    guardSignal = tx.signal; return new Promise(() => {});
  } }, { ...input, route: "guard", guardDeadlineSec: BigInt(input.nowMs / 1000) + 7n });
  await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(749);
  assert.equal(guardSignal?.aborted, false); t.mock.timers.tick(1);
  assert.equal((await guard).block, false); assert.equal(guardSignal?.aborted, true);
});
it("B2 evidence taking 400 ms or never settling adds no decision wait at 7000 ms guard headroom", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const delay of [400, Infinity]) {
    let returned = false, stored = false;
    const pending = preflightSimulate({ evidence: { insert: async () => {
      await new Promise<void>(resolve => { if (delay !== Infinity) setTimeout(resolve, delay); }); stored = true;
    } }, simulate: async () => result(null, "SUCCESS") }, { ...input, route: "guard", guardDeadlineSec: BigInt(input.nowMs / 1000) + 7n }).then(value => { returned = true; return value; });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    assert.equal(returned, true); assert.equal(stored, false); assert.equal((await pending).block, false);
    t.mock.timers.tick(400);
  }
});
it("S7/H1 net deltas and first-write actuals need no simulation row", async () => {
  const logs = [transferLog(NV.stock, OUTSIDER, WALLET, 10n), transferLog(NV.stock, WALLET, OUTSIDER, 3n), transferLog(NV.stock, WALLET, WALLET, 5n)];
  assert.equal(netTransferDelta(logs, NV.stock, WALLET), 7n);
  assert.equal(netTransferDelta([...logs, { ...logs[0]!, data: "0x" }], NV.stock, WALLET), null);
  const store = new MemoryTradeSimulationStore(), writer = createTradfiEvidenceWriter(store, () => {});
  recordSimulationActual(writer, { idempotencyKey: KEY, txHash: KEY, token: NV.stock, wallet: WALLET, logs, atMs: 1 });
  recordSimulationActual(writer, { idempotencyKey: KEY, txHash: `0x${"22".repeat(32)}`, token: NV.stock, wallet: WALLET, logs: [], atMs: 2 });
  await writer.shutdown(); assert.equal(store.actuals.get(KEY)?.actualOutAtomic, 7n); assert.equal(store.actuals.get(KEY)?.txHash, KEY);
});
