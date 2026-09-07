/**
 * Venus rescue sizing — the pure layer (PHASE4-SPEC R2.4, corrected by R3.1,
 * instantiated per basis by R3.11, with market selection from R2.10).
 *
 * ═══ THE CLOSED FORM SIZES; THE RECOMPUTE DECIDES ═════════════════════════
 *
 * NORMATIVE, not an optimisation. Between `s` and `W'` there are FIVE
 * truncations (`mulExp` three times, the mint's floor, and the final `/1e18`),
 * so a closed form that is correct in ℝ is off by up to several base units in
 * ℤ — and the direction of that error is the difference between reaching
 * `targetHf` and missing it. So: the closed form proposes an amount, then the
 * amount is re-driven through the FULL truncating pipeline, and
 *
 *   - a partial rescue REPORTS the `HF'` it actually achieves;
 *   - a supply whose recomputed `ΔW == 0` is REFUSED — a fee paid for nothing.
 *
 * ═══ THE RESERVE IS SUBTRACTED ONCE, IN WHICHEVER BRANCH IS NATIVE ════════
 *
 * R3.1/S1: Revision 2's REPAY line omitted `walletNativeFloor`, contradicting
 * R2.11 in the same revision, and a builder implementing it literally would
 * ship a native `repayBorrow{value: entire wallet}` — the trapped-exit family
 * this plane has spent three phases on, reintroduced inside its own fix. BOTH
 * branches carry the term now, it is subtracted ONCE inside the wallet-balance
 * term and nowhere else, and a floor-clamped rescue SUBMITS THE REDUCED AMOUNT
 * rather than refusing.
 *
 * ═══ WHY THE MINIMUM NEVER REFUSES ════════════════════════════════════════
 *
 * Moving HF from 1.05 to 1.20 with insufficient funds beats refusing. Every
 * clamp in the `min(...)` therefore produces a SMALLER submission, never a
 * refusal, and the shortfall is reported as `insufficient-wallet-balance` with
 * its figures. The only refusals this module produces are ones where submitting
 * would be actively wrong: nothing to repay, nothing the market can accept, or
 * a supply that provably moves `W` by zero.
 */
import type { Address } from "viem";
import {
  E18,
  basisCollateralPrice,
  basisDebtPrice,
  basisFactor,
  calculateVenusRisk,
  collateralValue,
  debtValue,
  tokensToDenom,
  type VenusRiskBasis,
  type VenusRiskMarketInput,
  type VenusRiskResult,
} from "./risk.js";
import type { VenusCondition } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Ceil helpers — named, because every one of them is a decision              */
/* -------------------------------------------------------------------------- */

/** `ceil(a / b)` for positive `b`. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: divisor must be positive.");
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

function minOf(values: readonly bigint[]): bigint {
  let best: bigint | null = null;
  for (const value of values) {
    if (best === null || value < best) best = value;
  }
  return best ?? 0n;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One market as the sizer sees it — the risk inputs plus everything the
 * `min(...)` clamps on and everything the R2.10 filter reads.
 */
export type VenusSizingMarket = VenusRiskMarketInput & {
  readonly vToken: Address;
  /** `null` for the native market (vBNB). */
  readonly underlying: Address | null;
  readonly native: boolean;
  readonly listed: boolean;
  readonly borrowAllowed: boolean;
  readonly mintPaused: boolean;
  readonly repayPaused: boolean;
  /** `supplyCap - suppliedUnderlying`, floored at zero. */
  readonly supplyHeadroom: bigint;
  /** `borrowBalanceCurrent`, re-read at submit time. */
  readonly borrowCurrent: bigint;
  /** The wallet's balance of this market's underlying (native ⇒ BNB). */
  readonly walletBalance: bigint;
  /**
   * The wallet's CURRENT allowance to this vToken, `0n` for the native market.
   *
   * PHASE4-AUDIT A2: this field is the seam that lets the builder decide
   * whether to emit `approve(vToken, 0)` first (R2.16/R25), and it was
   * originally dropped here and read back through a structural cast that was
   * always `0n`. The residual-allowance case is not hypothetical — it is this
   * phase's own measured mechanism: a failOpaque `no-effect` repay leaves the
   * batch's approve standing, and USDT reverts a non-zero -> non-zero approve,
   * so a lost allowance wedges every subsequent rescue on that market. It is a
   * REQUIRED field precisely so no caller can forget it again.
   */
  readonly allowance: bigint;
  /** Owner's `maxPerAction` for this token, or `null` when unnamed. */
  readonly maxPerActionWei: bigint | null;
  /**
   * Remaining on-chain per-token spend cap for this period, or `null` when the
   * plane did not read it.
   *
   * `null` OMITS the term rather than treating it as unbounded: the chain
   * enforces the cap either way, and a rescue clamped to a number this plane
   * guessed would be smaller than it needed to be for no reason.
   */
  readonly capRemainingWei: bigint | null;
  /** Whether the session grant actually names this market. */
  readonly inGrant: boolean;
  /** Whether the owner's settings name this market for the action in question. */
  readonly inDebtSettings: boolean;
  readonly inCollateralSettings: boolean;
};

export type VenusSizingContext = {
  readonly basis: VenusRiskBasis;
  readonly targetHf: bigint;
  readonly vaiDebt: bigint;
  readonly protocolPaused: boolean;
  /** `walletNativeFloorWei()`. Subtracted ONCE, in whichever branch is native. */
  readonly walletNativeFloorWei: bigint;
  /**
   * Whether the session has a native day meter at all. `false` makes any
   * NATIVE rescue a typed `no-native-grant` refusal at sizing time — a session
   * with no native row cannot attach value at all (FINDINGS (h)) — while
   * ERC-20 rescues proceed untouched (R2.11).
   */
  readonly hasNativeGrant: boolean;
};

/* -------------------------------------------------------------------------- */
/* Outputs                                                                    */
/* -------------------------------------------------------------------------- */

/** Why one market was SKIPPED. A skip is not a refusal (R2.10). */
export type VenusMarketSkip = {
  readonly vToken: Address;
  readonly condition: VenusCondition;
  readonly detail: string;
};

export type VenusRepayPlan = {
  readonly action: "venusRepay";
  readonly vToken: Address;
  readonly underlying: Address | null;
  readonly native: boolean;
  /** The exact amount to submit. NEVER the `2^256-1` sentinel (D1). */
  readonly amountWei: bigint;
  /** The unclamped need, so a partial rescue can report its shortfall. */
  readonly neededWei: bigint;
  /** `true` when a clamp reduced the submission below `neededWei`. */
  readonly partial: boolean;
  /** Which clamp bound the amount — the figure the owner view reports. */
  readonly boundBy: VenusRepayBound;
  /** HF the RECOMPUTE says this amount actually achieves. `null` = no debt. */
  readonly achievedHf: bigint | null;
  readonly currentHf: bigint | null;
};

export type VenusRepayBound =
  | "need"
  | "borrow-balance"
  | "wallet-balance"
  | "max-per-action"
  | "on-chain-cap";

export type VenusSupplyPlan = {
  readonly action: "venusSupply";
  readonly vToken: Address;
  readonly underlying: Address | null;
  readonly native: boolean;
  readonly amountWei: bigint;
  readonly neededWei: bigint;
  readonly partial: boolean;
  readonly boundBy: VenusSupplyBound;
  /** The recomputed collateral gain. REFUSED when this is zero. */
  readonly collateralGainWei: bigint;
  readonly achievedHf: bigint | null;
  readonly currentHf: bigint | null;
};

export type VenusSupplyBound =
  | "need"
  | "wallet-balance"
  | "max-per-action"
  | "on-chain-cap"
  | "supply-headroom";

export type VenusSizingOutcome =
  | { readonly kind: "repay"; readonly plan: VenusRepayPlan; readonly skipped: readonly VenusMarketSkip[] }
  | { readonly kind: "supply"; readonly plan: VenusSupplyPlan; readonly skipped: readonly VenusMarketSkip[] }
  | {
      readonly kind: "refused";
      readonly condition: VenusCondition;
      readonly detail: string;
      readonly skipped: readonly VenusMarketSkip[];
    };

/* -------------------------------------------------------------------------- */
/* The basis pipeline                                                         */
/* -------------------------------------------------------------------------- */

/** `W`, `D` and `HF` on one basis, through the truncating pipeline. */
export function basisTotals(
  markets: readonly VenusRiskMarketInput[],
  vaiDebt: bigint,
  basis: VenusRiskBasis,
): VenusRiskResult {
  const pair = calculateVenusRisk(markets, vaiDebt);
  return basis === "liquidation" ? pair.liquidationRisk : pair.borrowingPower;
}

/* -------------------------------------------------------------------------- */
/* REPAY                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Size one repay against one market. Pure, and the caller has already decided
 * this market is usable.
 *
 * The `+1` slack on `r0` is not decoration: `need` was floored (so it errs
 * HIGH, the safe direction) and `r0` was ceiled, and one more base unit is what
 * absorbs the residual truncation between the closed form and the recompute.
 */
export function sizeVenusRepay(
  markets: readonly VenusSizingMarket[],
  market: VenusSizingMarket,
  context: VenusSizingContext,
): VenusRepayPlan | { readonly refused: VenusCondition; readonly detail: string } {
  const basis = context.basis;
  const current = basisTotals(markets, context.vaiDebt, basis);
  if (current.debt === 0n) {
    return { refused: "hf-above-trigger", detail: "The account carries no debt." };
  }

  // need = D − (W * 1e18) / targetHf. Floored, so `need` errs HIGH.
  const need = current.debt - (current.collateral * E18) / context.targetHf;
  if (need <= 0n) {
    return {
      refused: "hf-above-trigger",
      detail: "No repay is required to reach targetHf.",
    };
  }

  const price = basisDebtPrice(basis, market);
  if (price <= 0n) {
    return { refused: "oracle-invalid", detail: "The debt-leg price is zero." };
  }
  const r0 = ceilDiv(need * E18, price);
  const neededWei = r0 + 1n;

  const maxPerAction = market.maxPerActionWei;
  if (maxPerAction === null) {
    // R2.1: a MISSING ceiling is not "unlimited". Defaulting it here is the
    // DEFAULT_TOKEN_CAP_LIMIT posture that revision forbids.
    return {
      refused: "market-not-in-settings",
      detail: `No maxPerAction ceiling is set for ${market.vToken}; a Venus ceiling is never defaulted.`,
    };
  }
  if (market.native && !context.hasNativeGrant) {
    return {
      refused: "no-native-grant",
      detail:
        "The session has no native spend row, so it cannot attach msg.value at all; " +
        "a native repay is refused while ERC-20 repays are unaffected.",
    };
  }

  // R3.1/S1: BOTH branches carry the wallet-native floor. Subtracted ONCE.
  const walletTerm = market.native
    ? market.walletBalance - context.walletNativeFloorWei
    : market.walletBalance;
  const walletAvailable = walletTerm > 0n ? walletTerm : 0n;

  const terms: { readonly bound: VenusRepayBound; readonly value: bigint }[] = [
    { bound: "need", value: neededWei },
    { bound: "borrow-balance", value: market.borrowCurrent },
    { bound: "wallet-balance", value: walletAvailable },
    { bound: "max-per-action", value: maxPerAction },
    ...(market.capRemainingWei === null
      ? []
      : [{ bound: "on-chain-cap" as const, value: market.capRemainingWei }]),
  ];
  const amountWei = minOf(terms.map((term) => term.value));
  if (amountWei <= 0n) {
    return {
      refused: "insufficient-wallet-balance",
      detail:
        `Nothing can be repaid on ${market.vToken}: need ${neededWei}, ` +
        `borrow ${market.borrowCurrent}, wallet available ${walletAvailable} ` +
        `(after the ${context.walletNativeFloorWei} wei native floor), ` +
        `maxPerAction ${maxPerAction}.`,
    };
  }
  const boundBy =
    terms.find((term) => term.value === amountWei)?.bound ?? "need";

  // THE RECOMPUTE. Re-derive `D'` with `b_u − amount` through the same
  // truncating pipeline and report the HF this submission actually achieves.
  const after = markets.map((entry) =>
    entry.vToken === market.vToken
      ? { ...entry, borrowBalance: subClamped(entry.borrowBalance, amountWei) }
      : entry,
  );
  const recomputed = basisTotals(after, context.vaiDebt, basis);

  return {
    action: "venusRepay",
    vToken: market.vToken,
    underlying: market.underlying,
    native: market.native,
    amountWei,
    neededWei,
    partial: amountWei < neededWei,
    boundBy,
    achievedHf: recomputed.healthFactor,
    currentHf: current.healthFactor,
  };
}

function subClamped(value: bigint, amount: bigint): bigint {
  return value > amount ? value - amount : 0n;
}

/* -------------------------------------------------------------------------- */
/* SUPPLY                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Size one supply against one already-member market.
 *
 * The vToken round-trip is modelled explicitly: supplying `s` underlying MINTS
 * `Δbal = floor(s * 1e18 / xr)` vTokens, and `W` rises by the DIFFERENCE of two
 * truncated collateral values — not by `s * p * lt`, which is both the wrong
 * scale and the wrong shape. A small supply can move `W` by ZERO, and that case
 * is refused rather than paid for.
 */
export function sizeVenusSupply(
  markets: readonly VenusSizingMarket[],
  market: VenusSizingMarket,
  context: VenusSizingContext,
): VenusSupplyPlan | { readonly refused: VenusCondition; readonly detail: string } {
  // REVISION 4.1 (V1): FIRST, even before the zero-debt check — a native
  // market is refused for WHAT IT IS, not for the account's current state.
  if (market.native) {
    return {
      refused: "native-collateral-trapped",
      detail:
        // The remedy LEADS: the worker's sanitized hold reason (~300 chars)
        // is the only sentence a BNB-only wallet ever sees, and a remedy past
        // the cap is a remedy nobody receives (the PHASE3.3-A7 lesson).
        "Wrap BNB to WBNB by hand to re-enable the supply route (market vWBNB " +
        "0x6bCa74586218db34cDB402295796b79663d816e9, WBNB " +
        "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c — identical CORE-pool " +
        "factors; this guard deliberately holds no wrap grant): vBNB pays out " +
        "via a 2300-gas `.transfer()` an EIP-7702 wallet cannot receive " +
        "(FINDINGS (at)), so supplying it mints a one-way position.",
    };
  }
  const basis = context.basis;
  const current = basisTotals(markets, context.vaiDebt, basis);
  if (current.debt === 0n) {
    return { refused: "hf-above-trigger", detail: "The account carries no debt." };
  }
  if (!market.collateralMember) {
    // v1 mints ONLY into markets the account is already a member of: minting
    // into a non-member market does not move HF and would need an
    // `enterMarkets` grant this template refuses to give. Membership is not
    // collateral, and this is its other half.
    return {
      refused: "market-not-collateral-member",
      detail: `${market.vToken} is not an entered market; a mint there would not move HF.`,
    };
  }

  // Wneed = ceil(targetHf * D / 1e18) − W.
  const wNeed = ceilDiv(context.targetHf * current.debt, E18) - current.collateral;
  if (wNeed <= 0n) {
    return {
      refused: "hf-above-trigger",
      detail: "No supply is required to reach targetHf.",
    };
  }

  const factor = basisFactor(basis, market);
  const price = basisCollateralPrice(basis, market);
  const denom = tokensToDenom(factor, market.exchangeRate, price);
  if (denom <= 0n) {
    return {
      refused: "oracle-invalid",
      detail:
        `${market.vToken} weights to zero (factor ${factor}, price ${price}); ` +
        "no supply into it can move W.",
    };
  }
  const deltaBal = ceilDiv(wNeed * E18, denom);
  const s0 = ceilDiv(deltaBal * market.exchangeRate, E18);

  const maxPerAction = market.maxPerActionWei;
  if (maxPerAction === null) {
    return {
      refused: "market-not-in-settings",
      detail: `No maxPerAction ceiling is set for ${market.vToken}; a Venus ceiling is never defaulted.`,
    };
  }
  if (market.native && !context.hasNativeGrant) {
    return {
      refused: "no-native-grant",
      detail:
        "The session has no native spend row, so it cannot attach msg.value at all; " +
        "a native supply is refused while ERC-20 supplies are unaffected.",
    };
  }

  const walletTerm = market.native
    ? market.walletBalance - context.walletNativeFloorWei
    : market.walletBalance;
  const walletAvailable = walletTerm > 0n ? walletTerm : 0n;

  const terms: { readonly bound: VenusSupplyBound; readonly value: bigint }[] = [
    { bound: "need", value: s0 },
    { bound: "wallet-balance", value: walletAvailable },
    { bound: "max-per-action", value: maxPerAction },
    { bound: "supply-headroom", value: market.supplyHeadroom },
    ...(market.capRemainingWei === null
      ? []
      : [{ bound: "on-chain-cap" as const, value: market.capRemainingWei }]),
  ];
  const amountWei = minOf(terms.map((term) => term.value));
  if (amountWei <= 0n) {
    return {
      refused: "insufficient-wallet-balance",
      detail:
        `Nothing can be supplied to ${market.vToken}: need ${s0}, wallet available ` +
        `${walletAvailable} (after the ${context.walletNativeFloorWei} wei native floor), ` +
        `maxPerAction ${maxPerAction}, supply headroom ${market.supplyHeadroom}.`,
    };
  }
  const boundBy = terms.find((term) => term.value === amountWei)?.bound ?? "need";

  // THE RECOMPUTE, through mint-then-collateralValue. The mint FLOORS.
  const mintedBal = (amountWei * E18) / market.exchangeRate;
  const before = collateralValue(
    market.vTokenBalance,
    market.exchangeRate,
    factor,
    price,
  );
  const afterValue = collateralValue(
    market.vTokenBalance + mintedBal,
    market.exchangeRate,
    factor,
    price,
  );
  const collateralGainWei = afterValue - before;
  if (collateralGainWei <= 0n) {
    // A fee paid for nothing. NORMATIVE refusal (R2.4).
    return {
      refused: "no-effect",
      detail:
        `Supplying ${amountWei} to ${market.vToken} mints ${mintedBal} vTokens and moves ` +
        "weighted collateral by ZERO after truncation; the submission would be a fee " +
        "paid for no change.",
    };
  }

  const after = markets.map((entry) =>
    entry.vToken === market.vToken
      ? { ...entry, vTokenBalance: entry.vTokenBalance + mintedBal }
      : entry,
  );
  const recomputed = basisTotals(after, context.vaiDebt, basis);

  return {
    action: "venusSupply",
    vToken: market.vToken,
    underlying: market.underlying,
    native: market.native,
    amountWei,
    neededWei: s0,
    partial: amountWei < s0,
    boundBy,
    collateralGainWei,
    achievedHf: recomputed.healthFactor,
    currentHf: current.healthFactor,
  };
}

/* -------------------------------------------------------------------------- */
/* Selection (R2.10)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Choose the rescue to submit.
 *
 * FILTER to markets usable NOW → RANK by ACHIEVABLE EFFECT → submit the best →
 * REFUSE only when the filtered set is empty, with the refusal naming every
 * skipped market and its reason.
 *
 * The three bugs the first draft had, and what replaced each:
 *
 *   1. "repay the largest debt first" IGNORED THE WALLET. Every USD repaid
 *      moves HF identically regardless of market, so largest-debt buys nothing
 *      — and it can produce a ZERO-amount rescue while a fully funded second
 *      allowed market is never considered. Ranking is on the CLAMPED value now.
 *   2. "supply the largest wallet balance first" compared base units across
 *      tokens with different decimals and different prices — dimensionless
 *      nonsense. Ranking is on the recomputed `ΔW`.
 *   3. A paused or unfunded market was a REFUSAL. It is a SKIP: one paused
 *      market in the owner's list must not block a rescue another allowed
 *      market can perform.
 *
 * Repay is preferred over supply when both are available: repaying removes
 * debt the account is charged interest on, and it is the action whose amount is
 * clamped by `borrowCurrent` — a bound that cannot lock up the owner's capital.
 * Ties inside a kind break by ranked effect and then by address ordering.
 */
export function selectVenusRescue(
  markets: readonly VenusSizingMarket[],
  context: VenusSizingContext,
): VenusSizingOutcome {
  const skipped: VenusMarketSkip[] = [];
  if (context.protocolPaused) {
    return {
      kind: "refused",
      condition: "protocol-paused",
      detail: "The Venus Comptroller reports protocolPaused; no action is submitted.",
      skipped,
    };
  }

  const ordered = [...markets].sort((a, b) =>
    a.vToken.toLowerCase() < b.vToken.toLowerCase()
      ? -1
      : a.vToken.toLowerCase() > b.vToken.toLowerCase()
        ? 1
        : 0,
  );

  const repayPlans: VenusRepayPlan[] = [];
  for (const market of ordered) {
    const skip = repayFilter(market);
    if (skip !== null) {
      skipped.push({ vToken: market.vToken, ...skip });
      continue;
    }
    const sized = sizeVenusRepay(ordered, market, context);
    if ("refused" in sized) {
      skipped.push({
        vToken: market.vToken,
        condition: sized.refused,
        detail: sized.detail,
      });
      continue;
    }
    repayPlans.push(sized);
  }

  if (repayPlans.length > 0) {
    // Rank by the value actually repayable, which is the effect on HF.
    const best = repayPlans.reduce((left, right) => {
      const leftMarket = ordered.find((m) => m.vToken === left.vToken);
      const rightMarket = ordered.find((m) => m.vToken === right.vToken);
      const leftValue =
        leftMarket === undefined
          ? 0n
          : debtValue(left.amountWei, basisDebtPrice(context.basis, leftMarket));
      const rightValue =
        rightMarket === undefined
          ? 0n
          : debtValue(right.amountWei, basisDebtPrice(context.basis, rightMarket));
      return rightValue > leftValue ? right : left;
    });
    return { kind: "repay", plan: best, skipped };
  }

  const supplyPlans: VenusSupplyPlan[] = [];
  for (const market of ordered) {
    const skip = supplyFilter(market);
    if (skip !== null) {
      skipped.push({ vToken: market.vToken, ...skip });
      continue;
    }
    const sized = sizeVenusSupply(ordered, market, context);
    if ("refused" in sized) {
      skipped.push({
        vToken: market.vToken,
        condition: sized.refused,
        detail: sized.detail,
      });
      continue;
    }
    supplyPlans.push(sized);
  }

  if (supplyPlans.length > 0) {
    const best = supplyPlans.reduce((left, right) =>
      right.collateralGainWei > left.collateralGainWei ? right : left,
    );
    return { kind: "supply", plan: best, skipped };
  }

  // REVISION 4.1 (V2, closed by the build verification): when the native trap
  // is among the skips, ITS remedy leads the aggregate detail — the skip list
  // alone told the owner a condition NAME while the wrap-by-hand remedy never
  // left this function, and the worker's sanitized hold reason is the only
  // sentence a BNB-only wallet ever sees.
  const nativeSkip = skipped.find(
    (entry) => entry.condition === "native-collateral-trapped",
  );
  return {
    kind: "refused",
    condition: skipped.length === 0 ? "hf-above-trigger" : "insufficient-wallet-balance",
    detail:
      skipped.length === 0
        ? "No allowed market needs or can take a rescue."
        : `${nativeSkip === undefined ? "" : `${nativeSkip.detail} `}No allowed ` +
          `market could act. Skipped: ${skipped
            .map((entry) => `${entry.vToken}=${entry.condition}`)
            .join(", ")}.`,
    skipped,
  };
}

function repayFilter(
  market: VenusSizingMarket,
): { readonly condition: VenusCondition; readonly detail: string } | null {
  if (!market.inDebtSettings) {
    return {
      condition: "market-not-in-settings",
      detail: "Not named in the owner's debtMarkets.",
    };
  }
  if (!market.inGrant) {
    return {
      condition: "market-not-in-grant",
      detail: "The session grant does not name this market's repay selectors.",
    };
  }
  if (!market.listed) {
    return { condition: "market-delisted", detail: "The market is not listed." };
  }
  if (market.repayPaused) {
    return { condition: "action-paused", detail: "repay is paused on this market." };
  }
  if (market.borrowCurrent <= 0n) {
    return {
      condition: "hf-above-trigger",
      detail: "No debt in this market to repay.",
    };
  }
  if (market.walletBalance <= 0n) {
    return {
      condition: "insufficient-wallet-balance",
      detail: "The wallet holds none of this market's underlying.",
    };
  }
  return null;
}

function supplyFilter(
  market: VenusSizingMarket,
): { readonly condition: VenusCondition; readonly detail: string } | null {
  // REVISION 4.1 (V1): the native refusal comes FIRST — before settings,
  // grant, membership or balance — so the owner is never told "no balance"
  // about a market refused for being a one-way door. This is also the
  // decision-layer backstop for a session granted BEFORE Revision 4, whose
  // immutable on-chain grant still carries `mint()` on vBNB.
  if (market.native) {
    return {
      condition: "native-collateral-trapped",
      detail:
        // The remedy LEADS: the worker's sanitized hold reason (~300 chars)
        // is the only sentence a BNB-only wallet ever sees, and a remedy past
        // the cap is a remedy nobody receives (the PHASE3.3-A7 lesson).
        "Wrap BNB to WBNB by hand to re-enable the supply route (market vWBNB " +
        "0x6bCa74586218db34cDB402295796b79663d816e9, WBNB " +
        "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c — identical CORE-pool " +
        "factors; this guard deliberately holds no wrap grant): vBNB pays out " +
        "via a 2300-gas `.transfer()` an EIP-7702 wallet cannot receive " +
        "(FINDINGS (at)), so supplying it mints a one-way position.",
    };
  }
  if (!market.inCollateralSettings) {
    return {
      condition: "market-not-in-settings",
      detail: "Not named in the owner's collateralMarkets.",
    };
  }
  if (!market.inGrant) {
    return {
      condition: "market-not-in-grant",
      detail: "The session grant does not name this market's mint selector.",
    };
  }
  if (!market.listed) {
    return { condition: "market-delisted", detail: "The market is not listed." };
  }
  if (market.mintPaused) {
    return { condition: "action-paused", detail: "mint is paused on this market." };
  }
  if (!market.collateralMember) {
    return {
      condition: "market-not-collateral-member",
      detail: "Not an entered market; a mint there would not move HF.",
    };
  }
  if (market.supplyHeadroom <= 0n) {
    return {
      condition: "supply-cap-exceeded",
      detail: "The market's supply cap leaves no headroom.",
    };
  }
  if (market.walletBalance <= 0n) {
    return {
      condition: "insufficient-wallet-balance",
      detail: "The wallet holds none of this market's underlying.",
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The rescue-capacity report (D10)                                           */
/* -------------------------------------------------------------------------- */

/**
 * How much HF improvement the CURRENT wallet could buy, per market.
 *
 * This is where "guard requires funded wallet" becomes visible on the owner
 * view: a guard armed over an empty wallet is a guard that will refuse at the
 * moment it matters, and nothing else on the view says so.
 */
export function venusRescueCapacity(
  markets: readonly VenusSizingMarket[],
  context: VenusSizingContext,
): {
  readonly currentHf: bigint | null;
  readonly bestAchievableHf: bigint | null;
  readonly perMarket: readonly {
    readonly vToken: Address;
    readonly kind: "repay" | "supply";
    readonly amountWei: bigint;
    readonly achievedHf: bigint | null;
  }[];
} {
  const current = basisTotals(markets, context.vaiDebt, context.basis);
  const perMarket: {
    readonly vToken: Address;
    readonly kind: "repay" | "supply";
    readonly amountWei: bigint;
    readonly achievedHf: bigint | null;
  }[] = [];
  let best: bigint | null = current.healthFactor;
  for (const market of markets) {
    if (repayFilter(market) === null) {
      const sized = sizeVenusRepay(markets, market, context);
      if (!("refused" in sized)) {
        perMarket.push({
          vToken: market.vToken,
          kind: "repay",
          amountWei: sized.amountWei,
          achievedHf: sized.achievedHf,
        });
        if (sized.achievedHf !== null && (best === null || sized.achievedHf > best)) {
          best = sized.achievedHf;
        }
      }
    }
    if (supplyFilter(market) === null) {
      const sized = sizeVenusSupply(markets, market, context);
      if (!("refused" in sized)) {
        perMarket.push({
          vToken: market.vToken,
          kind: "supply",
          amountWei: sized.amountWei,
          achievedHf: sized.achievedHf,
        });
        if (sized.achievedHf !== null && (best === null || sized.achievedHf > best)) {
          best = sized.achievedHf;
        }
      }
    }
  }
  return { currentHf: current.healthFactor, bestAchievableHf: best, perMarket };
}
