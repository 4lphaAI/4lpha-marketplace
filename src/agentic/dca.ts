/** AGENTIC-DCA Revision 3 (R15, AGENTIC-DCA-SPEC R3.12): the pure pieces of the Agentic Auto DCA lane. The ladder and take-profit helpers, the fire arithmetic (need, minOut, slippage cap),
 *  the BNB floors and the closed code sets. No store, no runner, no clock: dcaLane.ts composes them. Nothing here builds or reads a Binance limit order. */
import { DCA_POOLS_56, DCA_COOLDOWN_SEC, dcaAdvanceCounter, dcaCounterConfirmed, dcaLevelPrice, type DcaCrossCounter, type DcaPrice } from "../trade/dca.js";
import type { AgenticDcaOrder, AgenticDcaRound } from "./domain.js";

/** The per-execution BNB reserve of the Agentic lane (src/agentic/execute.ts: 0.0004 BNB). */
export const DCA_BNB_RESERVE_WEI = 400_000_000_000_000n;
/** R31.2: the lane's take-profit fire floor is one swap's reserve. The executor's own sell floor (0.0001) is unchanged. */
export const DCA_TP_BNB_FLOOR_WEI = DCA_BNB_RESERVE_WEI;
/** R3.7: a level fire needs the executor's buy floor, (open + 2) x R with open = 0. */
export const DCA_BUY_BNB_FLOOR_WEI = 2n * DCA_BNB_RESERVE_WEI;
export const DCA_COOLDOWN_MS = DCA_COOLDOWN_SEC * 1_000;
export const DCA_FAIL_BACKOFF_MS = 600_000;
export const DCA_THROTTLE_MS = 300_000;
/** D1 (R3.4 step 6, R17.1): every fill, the base included, is held to min(50, trade.maxSlippageBps) bps of its quote. */
export const DCA_SLIPPAGE_BPS = 50;

const E8 = 100_000_000n;

/* ------------------------------ floors (R3.7) ------------------------------ */

/** Round start: the base, N levels and the take profit are N + 2 swaps. */
export function dcaRoundStartBnbFloorWei(maxOrders: number): bigint { return BigInt(maxOrders + 2) * DCA_BNB_RESERVE_WEI; }
/** Hire gate: one more round, (2N + 4) swaps. */
export function dcaHireBnbFloorWei(maxOrders: number): bigint { return BigInt(2 * maxOrders + 4) * DCA_BNB_RESERVE_WEI; }

/* ------------------------------- price helpers ------------------------------- */

/** The same price as an exact rational, ordered. */
export const dcaLte = (a: DcaPrice, b: DcaPrice): boolean => a.num * b.den <= b.num * a.den;
export const dcaGte = (a: DcaPrice, b: DcaPrice): boolean => a.num * b.den >= b.num * a.den;
/** A price x 1e8, rounded down: the public and event convention. */
export function dcaPriceE8(price: DcaPrice): bigint { return price.num * E8 / price.den; }

/* ------------------------------ the fire arithmetic (R3.4) ------------------------------ */

/** R3.4 step 2: a level fires when the finalized mid is at or below it; the take profit when the mid is at or above T. A level the mid is at or below when it would be armed is skipped (N6 (a)). */
export const dcaLevelReached = (mid: DcaPrice, level: DcaPrice): boolean => dcaLte(mid, level);
export const dcaTargetReached = (mid: DcaPrice, target: DcaPrice): boolean => dcaGte(mid, target);
/** s = min(50, trade.maxSlippageBps) bps; a missing cap means 50. */
export function dcaSlippageBps(maxSlippageBps: number | undefined): number { return Math.min(DCA_SLIPPAGE_BPS, maxSlippageBps ?? DCA_SLIPPAGE_BPS); }
/** Step 6: minOut = floor(quotedOut x (10 000 - s) / 10 000). */
export function dcaMinOut(quotedOut: bigint, slippageBps: number): bigint { return quotedOut * BigInt(10_000 - slippageBps) / 10_000n; }
/** Step 5, buy: the quote must reach `need = ceil(D x L.den / L.num)` raw token (its price is at or below L). */
export function dcaBuyNeedRaw(usdtWei: bigint, level: DcaPrice): bigint { return (usdtWei * level.den + level.num - 1n) / level.num; }
/** Step 5, sell: the quote must reach `ceil(Q x T.num / T.den)` USDT wei (its price is at or above T). */
export function dcaSellNeedWei(qtyRaw: bigint, target: DcaPrice): bigint { return (qtyRaw * target.num + target.den - 1n) / target.den; }
/** Step 5: the lane quote still reaches the level (buy) or the target (sell) itself. */
export const dcaBuyQuoteReaches = (quotedOut: bigint, usdtWei: bigint, level: DcaPrice): boolean => quotedOut >= dcaBuyNeedRaw(usdtWei, level);
export const dcaSellQuoteReaches = (quotedOut: bigint, qtyRaw: bigint, target: DcaPrice): boolean => quotedOut >= dcaSellNeedWei(qtyRaw, target);
/** R3.6: Q = min(H - sold, chain balance of the stock). */
export function dcaTpQty(stockRaw: bigint, soldRaw: bigint, balanceRaw: bigint): bigint { const held = stockRaw - soldRaw; return balanceRaw < held ? balanceRaw : held; }

/* ---------------------------- keys and attempts (R23.3) ---------------------------- */

export function dcaOrderKey(agentId: string, roundNo: number, role: "level" | "tp", levelNo: number | null, attempt: number): string {
  return `dca:${agentId}:${roundNo}:${role}${levelNo ?? ""}:${attempt}`;
}
/** 1 + the highest attempt stored for the same agent, round, role and level; 1 when none. */
export function dcaNextAttempt(orders: readonly Pick<AgenticDcaOrder, "orderKey">[], agentId: string, roundNo: number, role: "level" | "tp", levelNo: number | null): number {
  const prefix = dcaOrderKey(agentId, roundNo, role, levelNo, 0).slice(0, -1);
  let highest = 0;
  for (const order of orders) if (order.orderKey.startsWith(prefix)) {
    const tail = order.orderKey.slice(prefix.length);
    if (/^\d+$/u.test(tail)) highest = Math.max(highest, Number(tail));
  }
  return highest + 1;
}
export function dcaBaseDecisionId(agentId: string, roundNo: number, attempt: number): string { return `dca:${agentId}:${roundNo}:base:${attempt}`; }
/** R3.4 step 7: the decision id of one fire, `dca:<agent>:<round>:level<k>:<n>` or `dca:<agent>:<round>:tp:<n>`. */
export function dcaFireDecisionPrefix(agentId: string, roundNo: number, role: "level" | "tp", levelNo: number | null): string { return `dca:${agentId}:${roundNo}:${role}${levelNo ?? ""}:`; }
export function dcaFireDecisionId(agentId: string, roundNo: number, role: "level" | "tp", levelNo: number | null, n: number): string { return `${dcaFireDecisionPrefix(agentId, roundNo, role, levelNo)}${n}`; }

/* ------------------------------- round math ------------------------------- */

export const dcaPriceOf = (order: Pick<AgenticDcaOrder, "priceNum" | "priceDen">): DcaPrice => ({ num: BigInt(order.priceNum), den: BigInt(order.priceDen) });
export function dcaP0(round: Pick<AgenticDcaRound, "p0UsdtWei" | "p0StockRaw">): DcaPrice | null {
  return round.p0UsdtWei === null || round.p0StockRaw === null || BigInt(round.p0StockRaw) <= 0n ? null : { num: BigInt(round.p0UsdtWei), den: BigInt(round.p0StockRaw) };
}
export function dcaLevelAt(round: Pick<AgenticDcaRound, "p0UsdtWei" | "p0StockRaw">, levelNo: number, stepBps: number): DcaPrice | null {
  const p0 = dcaP0(round);
  return p0 === null ? null : dcaLevelPrice(p0, levelNo, stepBps);
}
/** Stop-loss counter in and out of its jsonb form (the block is a decimal string there). */
export function dcaCounterIn(value: AgenticDcaRound["stopCounter"]): DcaCrossCounter {
  return value === null ? { count: 0, lastBlock: null, lastAtMs: null } : { count: value.count, lastBlock: value.lastBlock === null ? null : BigInt(value.lastBlock), lastAtMs: value.lastAtMs };
}
export function dcaCounterOut(value: DcaCrossCounter): NonNullable<AgenticDcaRound["stopCounter"]> {
  return { count: value.count, lastBlock: value.lastBlock === null ? null : value.lastBlock.toString(), lastAtMs: value.lastAtMs };
}
export { dcaAdvanceCounter, dcaCounterConfirmed };

/* ------------------------------ states and phases ------------------------------ */

export const DCA_TERMINAL_STATES: readonly AgenticDcaOrder["state"][] = ["filled", "cancelled", "expired", "failed", "skipped", "below-range"];
export const dcaOrderTerminal = (order: Pick<AgenticDcaOrder, "state">): boolean => DCA_TERMINAL_STATES.includes(order.state);
export const DCA_OPEN_PHASES: readonly AgenticDcaRound["phase"][] = ["starting", "active", "closing", "stopping", "winding-down"];
export const dcaRoundOpen = (round: Pick<AgenticDcaRound, "phase">): boolean => DCA_OPEN_PHASES.includes(round.phase);

/* ------------------------------- the stocks (R2) ------------------------------- */

export const DCA_STOCKS: ReadonlySet<string> = new Set(DCA_POOLS_56.map(pool => pool.stock.toLowerCase()));
