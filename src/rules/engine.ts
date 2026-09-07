/**
 * Off-chain trade rules. A pure function over injected facts — no clock, no
 * store, no network — so every arithmetic edge is testable exactly.
 *
 * This is the SECOND boundary. The on-chain session policy is the first and the
 * hard one; nothing here can permit something the chain refuses. What it adds is
 * a tighter, server-side bound that (a) costs no gas to enforce, and (b) can
 * express things the account contract cannot — a rolling daily budget across
 * many trades, and a slippage floor relative to the caller's own quote.
 *
 * What it deliberately does NOT do is judge the market. It never asks whether a
 * price is good, only whether the caller declared a floor and stayed inside the
 * budget its owner set.
 */
import type { AgentCaps } from "../store/agents.js";

/** Stable, machine-readable refusal codes. Callers branch on these. */
export type TradeDenyCode =
  | "AMOUNT_INVALID"
  | "MIN_OUT_REQUIRED"
  | "MIN_OUT_TOO_LOW"
  | "PER_TRADE_CAP"
  | "DAILY_CAP";

export type TradeRuleInput = {
  /**
   * The request's amount: native in for a buy, token in for a sell. Checked for
   * positivity independently of `nativeInWei`, which is zero on every sell.
   */
  readonly amountWei: bigint;
  /**
   * Native this trade charges the wallet, INCLUDING the fee call and any venue
   * fee. Zero for sells. This is the quantity the caps are measured against and
   * the quantity the journal records.
   */
  readonly nativeInWei: bigint;
  /** Caller-declared minimum acceptable output. */
  readonly minOutWei: bigint;
  /** Caller-declared expected output, from its own quote. */
  readonly quotedOutWei: bigint;
  /** Off-chain caps from the persisted row. `null` means none configured. */
  readonly caps: AgentCaps | null;
  /** Journal-derived native spend over the rolling window. */
  readonly spentTodayWei: bigint;
  /** Ceiling on declared slippage, in basis points. */
  readonly maxSlippageBps: number;
};

export type TradeRuleVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: TradeDenyCode };

const BPS_DENOMINATOR = 10_000n;

/**
 * Evaluate a trade against the off-chain rules.
 *
 * Order is severity-first and each check is independent:
 *
 *   - `AMOUNT_INVALID` — a non-positive amount, or a non-positive quote. A trade
 *     of nothing is a bug in the caller, not a trade.
 *   - `MIN_OUT_REQUIRED` — `minOutWei <= 0`. This service cannot know the fair
 *     price, but it can refuse a trade that declares no floor AT ALL: an
 *     unbounded-slippage swap is a sandwich attacker's favourite meal, and it is
 *     the one slippage failure that needs no market judgement to detect.
 *   - `MIN_OUT_TOO_LOW` — the floor is more than `maxSlippageBps` below the
 *     caller's OWN quote. The caller's stated expectation is what binds it; we
 *     still make no judgement about whether the quote is right, only that
 *     `minOut = 1` alongside a quote of 100 BNB is not slippage tolerance, it is
 *     the absence of one wearing a number.
 *   - `PER_TRADE_CAP` / `DAILY_CAP` — the owner's off-chain budget. Both are
 *     `>`, not `>=`: a trade landing EXACTLY on the cap is allowed, one wei past
 *     it is not.
 *
 * With no caps configured the cap checks pass. The on-chain caps still bind;
 * these exist to be tighter, never to be the only ones.
 */
export function evaluateTradeRules(input: TradeRuleInput): TradeRuleVerdict {
  if (input.amountWei <= 0n) return { allowed: false, code: "AMOUNT_INVALID" };
  if (input.quotedOutWei <= 0n) return { allowed: false, code: "AMOUNT_INVALID" };

  if (input.minOutWei <= 0n) return { allowed: false, code: "MIN_OUT_REQUIRED" };

  const slippageBps = BigInt(input.maxSlippageBps);
  if (
    input.minOutWei * BPS_DENOMINATOR <
    input.quotedOutWei * (BPS_DENOMINATOR - slippageBps)
  ) {
    return { allowed: false, code: "MIN_OUT_TOO_LOW" };
  }

  const caps = input.caps;
  if (caps !== null) {
    const perTrade = caps.perTradeNativeWei;
    if (perTrade !== undefined && input.nativeInWei > perTrade) {
      return { allowed: false, code: "PER_TRADE_CAP" };
    }
    const daily = caps.dailyNativeWei;
    if (daily !== undefined && input.spentTodayWei + input.nativeInWei > daily) {
      return { allowed: false, code: "DAILY_CAP" };
    }
  }

  return { allowed: true };
}

/**
 * The daily-cap check alone, for the authoritative re-run after `journal.begin`.
 *
 * The pre-begin evaluation above is an EARLY OUT: it reads the ledger and then
 * acts, and two concurrent trades can both read the same pre-spend total. The
 * reservation is the journal row itself, so the binding check is this one, run
 * against a sum taken atomically with the insert (PHASE2 R8).
 */
export function exceedsDailyCap(
  caps: AgentCaps | null,
  otherSpendWei: bigint,
  nativeInWei: bigint,
): boolean {
  const daily = caps?.dailyNativeWei;
  if (daily === undefined) return false;
  return otherSpendWei + nativeInWei > daily;
}
