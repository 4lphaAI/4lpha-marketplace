/** AGENTIC-EARN-SPEC 3.3 to 3.6, 3.8, 3.10 and R11.2: the pure pieces of Agentic Earn. Constants, the per-lane needs, the one decision, the chain value, and the receipt and balance-delta verifiers.
 *  No store, no runner, no clock: earnLane.ts composes them. */
import { keccak256, stringToBytes, type Address } from "viem";
import { agenticAddress, type AgenticOrder } from "./domain.js";
import type { AgenticReceipt } from "./resolve.js";
import { EARN_USDT, EARN_USDT_OUT_EXCESS_BPS, type EarnProtocol } from "./earnAdapter.js";

const E16 = 10n ** 16n, E18 = 10n ** 18n;
/** A product below this counts as empty everywhere (decision, sign-out guard, hire check). */
export const EARN_DUST_WEI = E16;
export const EARN_PARK_CAP_BPS = 6_000n;
export const EARN_MIN_DEPOSIT_WEI = 20n * E18;
export const EARN_DEPOSIT_SPACING_MS = 86_400_000;
export const EARN_DEPOSIT_CUTOFF_MS = 86_400_000;
export const EARN_REDEEM_ALL_MS = 7_200_000;
export const EARN_BACKOFF_MS = 600_000;
export const EARN_DELTA_MIN_AGE_MS = 120_000;
export const EARN_RECEIPT_WAIT_MS = 1_800_000;
/** The lane's per-operation BNB reserve (the same 0.0004 BNB as the executor's). */
export const EARN_OP_BNB_WEI = 400_000_000_000_000n;
export const EARN_DEPOSIT_BNB_FLOOR_WEI = 3n * EARN_OP_BNB_WEI;
export const EARN_REDEEM_BNB_FLOOR_WEI = 100_000_000_000_000n;
/** R11.2: the value band and the accrual allowance. */
export const EARN_VALUE_FLOOR_BPS = 9_000n;
export const EARN_ACCRUAL_BPS_YEAR = 1_000n;

const TRANSFER = keccak256(stringToBytes("Transfer(address,address,uint256)"));
const APPROVAL = keccak256(stringToBytes("Approval(address,address,uint256)"));

/** Compound valuation: underlying wei = vBalance x exchangeRateStored / 1e18 (vUSDT has 8 decimals over an 18-decimal underlying). */
export const venusWei = (vBalance: bigint, vRate: bigint): bigint => vBalance * vRate / E18;
export const earnRoundDown = (wei: bigint): bigint => wei / E16 * E16;
export const earnRoundUp = (wei: bigint): bigint => (wei + E16 - 1n) / E16 * E16;

export type EarnNeeds = { low: bigint; high: bigint };
export type EarnNeedsInput =
  | { lane: "schedule"; entryWei: bigint; left: number; intervalSec: number }
  | { lane: "ai"; entryWei: bigint; slots: number }
  | { lane: "dca"; baseWei: bigint; orderWei: bigint; ahead: number; baseNeeded: boolean; undone: number; entriesOpen: boolean };
/** Rule 3.5: the idle USDT the lane itself keeps liquid (low) and the band a redeem refills (high), before the CMC exposure X. */
export function earnNeeds(i: EarnNeedsInput): EarnNeeds {
  const min = (a: number, b: number): bigint => BigInt(Math.max(0, Math.min(a, b)));
  if (i.lane === "schedule") {
    const n24 = Math.floor(86_400 / i.intervalSec);
    return { low: i.entryWei * min(i.left, 2), high: i.entryWei * min(i.left, n24 + 2) };
  }
  if (i.lane === "ai") return { low: i.entryWei * min(i.slots, 1), high: i.entryWei * min(i.slots, 2) };
  if (!i.entriesOpen) return { low: 0n, high: 0n };
  const base = i.baseNeeded ? i.baseWei : 0n;
  return { low: base + min(i.ahead, i.undone) * i.orderWei, high: base + min(i.ahead + 1, i.undone) * i.orderWei };
}

export type EarnApy = Readonly<Partial<Record<EarnProtocol, number | null>>>;
/** Redeem order: the product with the lower APY (from the last committed lane deposit's evidence) first; unknown or equal APYs, the larger balance first; then the configured order. */
export function earnOrder<T extends { protocol: EarnProtocol; valueWei: bigint }>(products: readonly T[], apy: EarnApy | null): T[] {
  const known = (p: T): number | null => apy?.[p.protocol] ?? null;
  return products.map((p, index) => ({ p, index })).sort((a, b) => {
    const x = known(a.p), y = known(b.p);
    if (x !== null && y !== null && x !== y) return x - y;
    if (a.p.valueWei !== b.p.valueWei) return a.p.valueWei > b.p.valueWei ? -1 : 1;
    return a.index - b.index;
  }).map(e => e.p);
}

export type EarnDecideInput = {
  now: number; hireEndMs: number; state: "bound" | "ending" | "ended";
  capitalWei: bigint; idleWei: bigint; parkedWei: bigint; xWei: bigint; needs: EarnNeeds;
  /** every product in the configured order, with its chain value; an unconfigured one can be neither deposited into nor redeemed from */
  products: readonly { protocol: EarnProtocol; valueWei: bigint; configured: boolean }[];
  apy: EarnApy | null;
  /** every non-arithmetic condition of rule 15 (flag, state, holds, spacing, back-off, BNB, unreadable exposure) */
  canDeposit: boolean;
};
export type EarnDecision =
  | { action: "redeem-all"; protocol: EarnProtocol }
  | { action: "redeem"; protocol: EarnProtocol; amountWei: bigint; ratio: boolean }
  | { action: "deposit"; amountWei: bigint }
  | { action: "blocked"; reason: "unconfigured" }
  | { action: "none" };
/** Rules 13 to 16, first match wins. */
export function earnDecide(i: EarnDecideInput): EarnDecision {
  const held = i.products.filter(p => p.valueWei >= EARN_DUST_WEI), ordered = earnOrder(held.filter(p => p.configured), i.apy);
  if (i.state === "ending" || i.now >= i.hireEndMs - EARN_REDEEM_ALL_MS) {
    return ordered.length > 0 ? { action: "redeem-all", protocol: ordered[0]!.protocol } : held.length > 0 ? { action: "blocked", reason: "unconfigured" } : { action: "none" };
  }
  if (i.idleWei < i.needs.low + i.xWei && i.parkedWei >= EARN_DUST_WEI) {
    if (ordered.length === 0) return { action: "blocked", reason: "unconfigured" };
    const product = ordered[0]!, want = earnRoundUp(i.needs.high + i.xWei - i.idleWei);
    if (want >= product.valueWei - E18 || want > product.valueWei) return { action: "redeem", protocol: product.protocol, amountWei: product.valueWei, ratio: true };
    return { action: "redeem", protocol: product.protocol, amountWei: want, ratio: false };
  }
  if (!i.canDeposit || i.now >= i.hireEndMs - EARN_DEPOSIT_CUTOFF_MS) return { action: "none" };
  const cap = i.capitalWei * EARN_PARK_CAP_BPS / 10_000n - i.parkedWei, free = i.idleWei - (i.needs.high + i.xWei);
  const amount = earnRoundDown(cap < free ? cap : free);
  return amount >= EARN_MIN_DEPOSIT_WEI ? { action: "deposit", amountWei: amount } : { action: "none" };
}

/** What a dispatched row stores (rule 19): the pre-dispatch chain reading and the choice evidence. */
export type EarnEvidence = { v: 1; protocol: EarnProtocol; investmentId: string; receiptToken: Address; reason: "lane" | "redeem-all" | "gate";
  apyBps: Partial<Record<EarnProtocol, number | null>> | null; pre: { block: string; usdt: string; valueWei: string; bnb: string } };
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const decimalString = (v: unknown): v is string => typeof v === "string" && /^\d+$/u.test(v);
export function earnEvidence(value: unknown): EarnEvidence | null {
  if (!isRecord(value) || value["v"] !== 1 || (value["protocol"] !== "venus" && value["protocol"] !== "aave-v3") || typeof value["investmentId"] !== "string"
    || typeof value["receiptToken"] !== "string" || !["lane", "redeem-all", "gate"].includes(String(value["reason"])) || !isRecord(value["pre"])) return null;
  const pre = value["pre"];
  if (!decimalString(pre["block"]) || !decimalString(pre["usdt"]) || !decimalString(pre["valueWei"]) || !decimalString(pre["bnb"])) return null;
  return value as unknown as EarnEvidence;
}
export const earnIsRatio = (row: Pick<AgenticOrder, "fromQty">): boolean => row.fromQty === "ratio:1";

/** R11.2: interest moves the value while a row waits, at most EARN_ACCRUAL_BPS_YEAR a year, on what the product held after the operation. */
export function earnAccrualWei(baseWei: bigint, ageMs: number): bigint {
  return baseWei * EARN_ACCRUAL_BPS_YEAR * BigInt(Math.max(0, Math.floor(ageMs))) / (10_000n * 31_536_000_000n);
}
const usdtOutMax = (amount: bigint, excessBps: number): bigint => amount + amount * BigInt(excessBps) / 10_000n;

/** The deposit value band (R11.2): the product's chain value after the operation. */
export function earnDepositValueOk(pre: bigint, amount: bigint, value: bigint, ageMs: number): boolean {
  return value >= pre + amount * EARN_VALUE_FLOOR_BPS / 10_000n && value <= pre + amount + EARN_DUST_WEI + earnAccrualWei(pre + amount, ageMs);
}
/** The USDT leg bands of a deposit (rule 25 `debit` is the summed USDT out of W; rule 26 derives it from the balance delta, with the dust slack). */
export const earnDepositDebitOk = (debit: bigint, amount: bigint, excessBps = EARN_USDT_OUT_EXCESS_BPS): boolean => debit >= amount && debit <= usdtOutMax(amount, excessBps);
export const earnDepositDeltaOk = (debit: bigint, amount: bigint, excessBps = EARN_USDT_OUT_EXCESS_BPS): boolean => debit >= amount - EARN_DUST_WEI && debit <= usdtOutMax(amount, excessBps) + EARN_DUST_WEI;
export const earnRedeemUsdtOk = (received: bigint, amount: bigint): boolean => received >= amount * EARN_VALUE_FLOOR_BPS / 10_000n && received <= amount + EARN_DUST_WEI;

export type EarnVerdict =
  | { kind: "wait" } | { kind: "reverted" } | { kind: "hold" }
  | { kind: "commit"; usdtMoved: bigint; receiptMoved: bigint; block: bigint };
const topicOf = (a: string): string => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
/**
 * Rule 25 and R11.2. `value` is the product's chain value at the current finalized block (null: the read failed, so wait). `waive` is the operator's attested disposition:
 * it waives the value band and the USDT-leg bounds, never the token allowlist, the sender, the status or the receipt token into the wallet.
 */
export function verifyEarnReceipt(proof: AgenticReceipt | null, row: AgenticOrder, input: { value: bigint | null; nowMs: number; waive?: boolean }): EarnVerdict {
  const ev = earnEvidence(row.evidence);
  if (proof === null) return { kind: "wait" };
  if (ev === null || row.amountAtomic === null || (row.kind !== "earn-deposit" && row.kind !== "earn-redeem") || agenticAddress(proof.from) !== agenticAddress(row.walletAddress)) return { kind: "hold" };
  const receipt = proof.observation.receipt;
  if (receipt.status === 0n) return { kind: "reverted" };
  if (receipt.status !== 1n) return { kind: "hold" };
  const wallet = topicOf(row.walletAddress), usdt = EARN_USDT, token = agenticAddress(ev.receiptToken);
  let usdtOut = 0n, usdtIn = 0n, receiptOut = 0n, receiptIn = 0n;
  for (const log of receipt.logs) {
    const kind = log.topics[0]?.toLowerCase();
    if (kind !== TRANSFER && kind !== APPROVAL) continue;
    const names = log.topics.slice(1, 3).some(t => t.toLowerCase() === wallet);
    if (!names) continue;
    const emitter = agenticAddress(log.address);
    if (log.removed === true || emitter !== usdt && emitter !== token) return { kind: "hold" };
    if (log.topics.length !== 3 || !/^0x[0-9a-f]{64}$/iu.test(log.data)) return { kind: "hold" };
    if (kind !== TRANSFER) continue;
    const amount = BigInt(log.data);
    if (log.topics[1]!.toLowerCase() === wallet) { if (emitter === usdt) usdtOut += amount; else receiptOut += amount; }
    if (log.topics[2]!.toLowerCase() === wallet) { if (emitter === usdt) usdtIn += amount; else receiptIn += amount; }
  }
  const amount = BigInt(row.amountAtomic), ratio = earnIsRatio(row), deposit = row.kind === "earn-deposit";
  if (deposit ? receiptIn <= 0n : receiptOut <= 0n) return { kind: "hold" };
  if (input.waive !== true) {
    if (deposit) {
      if (!earnDepositDebitOk(usdtOut, amount)) return { kind: "hold" };
      if (input.value === null) return { kind: "wait" };
      if (!earnDepositValueOk(BigInt(ev.pre.valueWei), amount, input.value, input.nowMs - row.createdAt)) return { kind: "hold" };
    } else if (ratio ? usdtIn <= 0n : !earnRedeemUsdtOk(usdtIn, amount)) return { kind: "hold" };
  }
  return { kind: "commit", usdtMoved: deposit ? usdtOut : usdtIn, receiptMoved: deposit ? receiptIn : receiptOut, block: receipt.blockNumber };
}

/** Rule 26 and R11.2 (positive evidence only): the finalized nonce moved and the wallet's own balances moved the way the operation says, within the same bands as the receipt. */
export function earnBalanceDelta(row: AgenticOrder, input: { nonce: bigint; usdt: bigint; value: bigint; nowMs: number }): boolean {
  const ev = earnEvidence(row.evidence);
  if (ev === null || row.amountAtomic === null || row.walletNoncePre === null || row.claimedAt === null) return false;
  if (input.nowMs - row.claimedAt < EARN_DELTA_MIN_AGE_MS || input.nonce <= BigInt(row.walletNoncePre)) return false;
  const amount = BigInt(row.amountAtomic), preUsdt = BigInt(ev.pre.usdt), preValue = BigInt(ev.pre.valueWei), age = input.nowMs - row.createdAt;
  if (row.kind === "earn-deposit") return preUsdt >= input.usdt && earnDepositDeltaOk(preUsdt - input.usdt, amount) && earnDepositValueOk(preValue, amount, input.value, age);
  if (row.kind !== "earn-redeem") return false;
  if (earnIsRatio(row)) return input.value < EARN_DUST_WEI && input.usdt > preUsdt;
  const floor = amount * EARN_VALUE_FLOOR_BPS / 10_000n, back = preValue > floor ? preValue - floor : 0n;
  return input.usdt >= preUsdt && earnRedeemUsdtOk(input.usdt - preUsdt, amount) && input.value <= back + earnAccrualWei(preValue, age);
}

