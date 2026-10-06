/** AGENTIC-EARN-SPEC ET8 (+ R11.2): the receipt verifier of rule 25, the value band and USDT-leg bounds, the attested waiver, the balance delta of rule 26 and the receipt-missing hold. */
import assert from "node:assert/strict";
import test from "node:test";
import { type Address, type Hex } from "viem";
import type { AgenticOrder } from "../src/agentic/domain.js";
import type { AgenticReceipt } from "../src/agentic/resolve.js";
import type { EarnProtocol } from "../src/agentic/earnAdapter.js";
import { EARN_DUST_WEI, earnAccrualWei, earnBalanceDelta, earnDepositDebitOk, verifyEarnReceipt, type EarnEvidence } from "../src/agentic/earn.js";
import { APPROVAL, E, HOUR, MINUTE, POOL, RECEIPT, TRANSFER, USDT, W, ZERO, earnWorld, swapReceipt, topicOf, tx } from "./support/agenticEarn.js";

const OTHER = "0x8888888888888888888888888888888888888888" as Address;
const word = (v: bigint): Hex => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
function mk(kind: "earn-deposit" | "earn-redeem", amount: bigint, o: { ratio?: boolean; protocol?: EarnProtocol; preValue?: bigint; preUsdt?: bigint; createdAt?: number; nonce?: string; claimedAt?: number } = {}): AgenticOrder {
  const protocol = o.protocol ?? "venus";
  const evidence: EarnEvidence = { v: 1, protocol, investmentId: "venus-usdt", receiptToken: RECEIPT[protocol], reason: "lane", apyBps: null,
    pre: { block: "1", usdt: (o.preUsdt ?? 100n * E).toString(), valueWei: (o.preValue ?? 0n).toString(), bnb: "0" } };
  return { idempotencyKey: "earn:a:1", kind, walletAddress: W, agentId: "a", decisionId: null, side: null, fromToken: null, toToken: null, amountAtomic: amount.toString(), intendedRaw: null,
    fromQty: o.ratio === true ? "ratio:1" : "1", minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null, operationId: null,
    walletNoncePre: o.nonce ?? "0", quoteAt: null, dispatch: "spawned", claimedAt: o.claimedAt ?? 0, claimant: "x", fenceToken: "1", claimDeadline: null, response: "accepted", cliResult: "accepted",
    returnedOrderId: null, listedOrderId: null, txHash: tx(1), approveTxHash: null, outcome: "open", holdReason: null, evidence, fillCheck: "none", createdAt: o.createdAt ?? 0, updatedAt: 0 };
}
const deposit = (protocol: EarnProtocol, out: bigint, minted: bigint): AgenticReceipt => swapReceipt(tx(1), [[USDT, W, POOL, out], [RECEIPT[protocol], ZERO, W, minted]]);
const redeem = (protocol: EarnProtocol, burned: bigint, back: bigint): AgenticReceipt => swapReceipt(tx(1), [[RECEIPT[protocol], W, ZERO, burned], [USDT, POOL, W, back]]);
const withLog = (r: AgenticReceipt, log: { address: Address; topics: Hex[]; data: Hex }): AgenticReceipt => ({ ...r, observation: { ...r.observation, receipt: { ...r.observation.receipt,
  logs: [...r.observation.receipt.logs, { ...log, logIndex: 9n }] } } } as unknown as AgenticReceipt);
const verdict = (proof: AgenticReceipt | null, row: AgenticOrder, value: bigint | null, waive = false, nowMs = 120_000) => verifyEarnReceipt(proof, row, { value, nowMs, waive }).kind;
const U = (n: number): bigint => BigInt(n) * E;

test("R1 a Venus mint and redeem and an Aave supply and withdraw pass (an Aave mint includes accrued interest, so it is not equal)", () => {
  assert.equal(verdict(deposit("venus", U(60), U(60)), mk("earn-deposit", U(60)), U(60)), "commit");
  assert.equal(verdict(deposit("aave-v3", U(60), U(60) + 5n), mk("earn-deposit", U(60), { protocol: "aave-v3" }), U(60)), "commit");
  assert.equal(verdict(redeem("venus", U(20), U(20)), mk("earn-redeem", U(20), { preValue: U(60) }), null), "commit");
  assert.equal(verdict(redeem("aave-v3", U(30), U(30)), mk("earn-redeem", U(30), { protocol: "aave-v3", ratio: true, preValue: U(30) }), null), "commit");
});

test("R2 an extra token Transfer, a foreign Approval, a wrong sender, a wrong USDT debit and a zero receipt are held; a reverted transaction rolls back; no receipt waits", () => {
  const row = mk("earn-deposit", U(60)), good = deposit("venus", U(60), U(60));
  const transfer = { address: OTHER, topics: [TRANSFER, topicOf(W), topicOf(POOL)] as Hex[], data: word(1n) };
  assert.equal(verdict(withLog(good, transfer), row, U(60)), "hold", "extra Transfer");
  assert.equal(verdict(withLog(good, { ...transfer, topics: [TRANSFER, topicOf(POOL), topicOf(W)] }), row, U(60)), "hold", "extra Transfer into W");
  assert.equal(verdict(withLog(good, { address: OTHER, topics: [APPROVAL, topicOf(W), topicOf(POOL)], data: word(1n) }), row, U(60)), "hold", "foreign Approval naming W");
  assert.equal(verdict(withLog(good, { address: OTHER, topics: ["0x" + "ab".repeat(32) as Hex, topicOf(W)], data: "0x" }), row, U(60)), "commit", "an unrelated event that indexes W moves nothing and is ignored");
  assert.equal(verdict({ ...good, from: POOL }, row, U(60)), "hold", "from != W");
  assert.equal(verdict(deposit("venus", U(60) - 1n, U(60)), row, U(60)), "hold", "USDT out below the amount");
  assert.equal(verdict(deposit("venus", U(60) + 1n, U(60)), row, U(60)), "hold", "USDT out above the amount at excess 0");
  assert.equal(verdict(deposit("venus", U(60), 0n), row, U(60)), "hold", "receipt token in 0");
  assert.equal(verdict(swapReceipt(tx(1), [[USDT, W, POOL, U(60)]]), row, U(60)), "hold", "no receipt token at all");
  const reverted = { ...good, observation: { ...good.observation, receipt: { ...good.observation.receipt, status: 0n, logs: [] } } } as unknown as AgenticReceipt;
  assert.equal(verdict(reverted, row, U(60)), "reverted");
  assert.equal(verdict(null, row, U(60)), "wait");
  assert.equal(verdict(good, row, null), "wait", "a failed value read means wait this cycle, not hold");
});

test("R3 the deposit value band edges: floor - 1 held, floor committed, pre + amount + dust + A committed, one above held; A at 120 s and at 30 days", () => {
  const row = mk("earn-deposit", U(60), { preValue: 0n }), proof = deposit("venus", U(60), U(60));
  const floor = U(60) * 9_000n / 10_000n, a = earnAccrualWei(U(60), 120_000);
  assert.ok(a > 20_000_000_000_000n && a < 30_000_000_000_000n, "about 0.0000228 USDT");
  assert.equal(verdict(proof, row, floor - 1n), "hold");
  assert.equal(verdict(proof, row, floor), "commit");
  assert.equal(verdict(proof, row, U(60) + EARN_DUST_WEI + a), "commit");
  assert.equal(verdict(proof, row, U(60) + EARN_DUST_WEI + a + 1n), "hold");
  const month = earnAccrualWei(U(60), 30 * 24 * HOUR);
  assert.ok(month > 490_000_000_000_000_000n && month < 500_000_000_000_000_000n, "10 % a year on 60 USDT for 30 days");
});

test("R4 the stranding fixture (the USDT debit is exact, the receipt is above zero, the value is half) is held, not committed as parked value", () => {
  assert.equal(verdict(deposit("venus", U(60), U(30)), mk("earn-deposit", U(60)), U(30)), "hold");
});

test("R5 the USDT leg: S = amount + 1 is held at excess 0 and accepted at 10 bps; S = amount - 1 is never accepted", () => {
  assert.deepEqual([earnDepositDebitOk(U(60) + 1n, U(60), 0), earnDepositDebitOk(U(60) + 1n, U(60), 10), earnDepositDebitOk(U(60) - 1n, U(60), 10), earnDepositDebitOk(U(60) + U(60) / 1000n, U(60), 10), earnDepositDebitOk(U(60) + U(60) / 1000n + 1n, U(60), 10)],
    [false, true, false, true, false]);
});

test("R6 redeem by amount: USDT received must be within [90 % of the amount, amount + dust]; ratio 1 needs only a positive amount", () => {
  const row = mk("earn-redeem", U(20), { preValue: U(60) }), floor = U(20) * 9_000n / 10_000n;
  assert.equal(verdict(redeem("venus", U(20), floor - 1n), row, null), "hold");
  assert.equal(verdict(redeem("venus", U(20), floor), row, null), "commit");
  assert.equal(verdict(redeem("venus", U(20), U(20) + EARN_DUST_WEI), row, null), "commit");
  assert.equal(verdict(redeem("venus", U(20), U(20) + EARN_DUST_WEI + 1n), row, null), "hold");
  assert.equal(verdict(redeem("venus", U(30), 1n), mk("earn-redeem", U(30), { ratio: true, preValue: U(30) }), null), "commit");
  assert.equal(verdict(redeem("venus", U(30), 0n), mk("earn-redeem", U(30), { ratio: true, preValue: U(30) }), null), "hold");
});

test("R7 the attested waiver (dispose --commit-tx --attest) waives the value band and the USDT leg, never the allowlist, the sender, the status or the receipt token into the wallet", () => {
  const row = mk("earn-deposit", U(60)), partial = deposit("venus", U(40), U(40));
  assert.equal(verdict(partial, row, U(40)), "hold");
  assert.equal(verdict(partial, row, U(40), true), "commit", "a partial debit has a truthful operator exit");
  assert.equal(verdict(deposit("venus", U(60), U(30)), row, U(30), true), "commit", "a stranded value");
  assert.equal(verdict(withLog(partial, { address: OTHER, topics: [TRANSFER, topicOf(W), topicOf(POOL)], data: word(1n) }), row, U(40), true), "hold", "allowlist stays");
  assert.equal(verdict({ ...partial, from: POOL }, row, U(40), true), "hold", "sender stays");
  assert.equal(verdict(deposit("venus", U(40), 0n), row, U(40), true), "hold", "receipt token into W stays");
  const reverted = { ...partial, observation: { ...partial.observation, receipt: { ...partial.observation.receipt, status: 0n, logs: [] } } } as unknown as AgenticReceipt;
  assert.equal(verdict(reverted, row, U(40), true), "reverted", "status stays");
});

test("R8 rule 26: the balance delta commits a held no-response row only with positive evidence (nonce moved, the balances moved, the age is at least 120 000 ms)", () => {
  const dep = mk("earn-deposit", U(60), { claimedAt: 1_000 }), at = 1_000 + 120_000;
  const ok = { nonce: 1n, usdt: U(40), value: U(60), nowMs: at };
  assert.equal(earnBalanceDelta(dep, ok), true);
  assert.equal(earnBalanceDelta(dep, { ...ok, nowMs: at - 1 }), false, "age 119 999 ms");
  assert.equal(earnBalanceDelta(dep, { ...ok, nonce: 0n }), false, "nonce unchanged");
  assert.equal(earnBalanceDelta(dep, { ...ok, usdt: U(100) }), false, "USDT did not move");
  assert.equal(earnBalanceDelta(dep, { ...ok, value: U(10) }), false, "value short");
  assert.equal(earnBalanceDelta(dep, { ...ok, usdt: U(100) - U(60) + EARN_DUST_WEI }), true, "within the dust slack");
  const red = mk("earn-redeem", U(20), { claimedAt: 1_000, preValue: U(60), preUsdt: U(10) });
  assert.equal(earnBalanceDelta(red, { nonce: 1n, usdt: U(30), value: U(40), nowMs: at }), true);
  assert.equal(earnBalanceDelta(red, { nonce: 1n, usdt: U(30), value: U(55), nowMs: at }), false, "value did not fall");
  const all = mk("earn-redeem", U(60), { ratio: true, claimedAt: 1_000, preValue: U(60), preUsdt: U(10) });
  assert.equal(earnBalanceDelta(all, { nonce: 1n, usdt: U(70), value: 0n, nowMs: at }), true);
  assert.equal(earnBalanceDelta(all, { nonce: 1n, usdt: U(70), value: EARN_DUST_WEI, nowMs: at }), false, "ratio 1 needs the receipt balance below dust");
});

test("R9 lane: a landed deposit whose answer was lost commits by the balance delta after 120 s; before that, or with the nonce unmoved, it stays held", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  w.market.deposit = "land-lost";
  await w.step();
  const [held] = await w.rows();
  assert.deepEqual([held!.outcome, held!.holdReason], ["open", "no-response"]);
  await w.at(held!.claimedAt! + 119_999); await w.step();
  assert.equal((await w.rows())[0]!.outcome, "open");
  await w.at(held!.claimedAt! + 120_000); await w.step();
  const [done] = await w.rows();
  assert.deepEqual([done!.outcome, (done!.evidence as { disposition: string }).disposition], ["committed", "balance-delta"]);
  assert.ok((await w.codes()).includes("earn-deposited"));
});

test("R10 lane: an accepted row with no finalized receipt waits, then holds receipt-missing at 30 minutes; the unique transaction hash is bound once", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  w.market.deposit = "land-lost";
  await w.step();
  const row = (await w.rows())[0]!;
  assert.ok(await w.f.store.patchOrder(row, { response: "accepted", cliResult: "accepted", holdReason: null, txHash: tx(99) }), "an accepted row whose receipt never arrives");
  await w.at(row.claimedAt! + 30 * MINUTE - 1); await w.step();
  assert.deepEqual([(await w.rows())[0]!.outcome, (await w.rows())[0]!.holdReason], ["open", null]);
  await w.at(row.claimedAt! + 30 * MINUTE); await w.step();
  assert.equal((await w.rows())[0]!.holdReason, "receipt-missing");
  assert.equal((await w.f.store.createOrder({ ...(await w.rows())[0]!, idempotencyKey: "earn:other:1", outcome: "open" })), false, "the same transaction hash cannot be bound twice");
});
