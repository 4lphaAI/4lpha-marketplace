/**
 * What a human needs to hire a Binance Agentic Wallet product, kept in ONE table (AGENTIC-SKILLS-PLAN A2).
 *
 * Every value is what the web Deploy form and `web/lib/agentic.ts` enforce today, with the file:line it comes from.
 * Where the execution-plane gate (`src/agentic/domain.ts`, `src/trade/settings.ts`) differs, the web value is used
 * (it is the stricter one a user actually meets) and the difference is listed in HIRE_CONFLICTS and in the build
 * report. A test pins every number below, so a form change that is not mirrored here turns red.
 * Line numbers refer to the tree at build time (2026-10-07).
 */

export const REQ = {
  /** HireAgenticTradeDeploy.tsx:258-259 (the two OptionCards); plane `AgenticHireParams.term` is 7 | 30 too. */
  termDays: [7, 30] as const,
  /** lib/agentic.ts:98-139 `agenticGate`: the Binance App checks rows. */
  gate: {
    /** lib/agentic.ts:119-121 and domain.ts:259 of the plane: x402 daily limit of at least 0.50 USDT (no such row on Schedule buy). */
    x402DailyLimitMinUsdt: 0.5,
    /** lib/agentic.ts:106 `dailyNeed = (quoteDayCapWei ?? capital * 5) * 2`: ten times the capital. */
    dailyLimitCapitalMultiple: 10,
    /** lib/agentic.ts:106 with `quoteDayCapWei = capital` for Schedule (HireAgenticTradeDeploy.tsx:186): two times the capital. */
    dailyLimitCapitalMultipleSchedule: 2,
    /** lib/agentic.ts:108 and HireAgenticTradeDeploy.tsx:30 `BNB_PER_SLOT_WEI`: 0.0004 BNB per transaction slot. */
    bnbPerSlot: 0.0004,
    /** lib/agentic.ts:110: the Earn opt-in adds two slots (0.0008 BNB). */
    bnbEarnExtraSlots: 2,
  },
  /** BNB slots per product, lib/agentic.ts:108-109 (+ HireAgenticTradeDeploy.tsx:188 for the whole-term Schedule count). */
  bnbSlots: {
    ai: "max open positions + 2",
    schedule: "1 + 2 + min(planned buys, buys the term can run)",
    portfolio: "2 x stocks + 2",
    dca: "2 x max DCA orders + 4",
  },
  /** Paid data / keep-alive budget in USDT per term; lib/agentic.ts:87 and :141, HireAgenticTradeDeploy.tsx:175. */
  budgetUsdt: {
    ai: { 7: 2, 30: 8 },
    schedule: { 7: 0, 30: 0 },
    portfolio: { 7: 0.2, 30: 0.8 },
    dca: { 7: 0.2, 30: 0.8 },
  },
  ai: {
    /** DeployAgentScreen.tsx:882 stepper and the blocked reason at :2264: whole number 1..10. */
    maxOpenPositions: { min: 1, max: 10, default: 3 },
    /** DeployAgentScreen.tsx:879-882 defaults (capital, min, max per entry, max positions) (63 / 5 / 20 USDT, DEFAULT_TRADFI_V2_* in lib/trade.ts:103-104). */
    capitalUsdtDefault: 63,
    minEntryUsdtDefault: 5,
    maxEntryUsdtDefault: 20,
    /** lib/agentic.ts:111 sizing row: capital must cover max open positions x max per entry. */
    capitalMustCover: "max open positions x max per entry",
    /** DeployAgentScreen.tsx:888 and :2268 stop loss 1..100 %, optional; :843 slippage 0.5..5 %. */
    stopLossPct: { min: 1, max: 100 },
    slippagePct: { min: 0.5, max: 5 },
  },
  schedule: {
    /** DeployAgentScreen.tsx:2223 (and plane SCHEDULE_MIN_BUY_WEI, settings.ts:197). */
    minAmountPerBuyUsdt: 5,
    /** DeployAgentScreen.tsx:544 SCHED_INTERVALS; plane SCHEDULE_INTERVALS_SEC settings.ts:196. "Weekly" in SCHED_FREQS (:543) has no interval. */
    intervals: ["1 hour", "4 hours", "8 hours", "12 hours", "Daily"] as const,
    /** DeployAgentScreen.tsx:2226: the form wants the total budget to cover one buy plus a 5 % platform fee (plane gate: fee 0). */
    totalBudgetMinFeeBps: 500,
    /** DeployAgentScreen.tsx:2202 and plane settings.ts:532: end after 1..1000 runs, or on a date, or when the budget is spent. */
    endRuns: { min: 1, max: 1000 },
    endKinds: ["budget", "date", "runs"] as const,
    /** DeployAgentScreen.tsx:911 and :2203 (50..150 bps, default 150): the NAV premium cap, i.e. the guard against buying above NAV. */
    maxPremiumBps: { min: 50, max: 150, default: 150 },
    /** DeployAgentScreen.tsx:2229 and lib/agentic.ts:115: a first buy "Now" or inside the next 7 days (2 hours before the 7-day mark), never before the entry cutoff. */
    firstBuyWindow: "now, or within the next 7 days and before the entry cutoff",
  },
  dca: {
    /** DeployAgentScreen.tsx:2240 and the dcaBase stepper min :932. Plane DCA_MIN_BASE_WEI is 15 (settings.ts:199). */
    minBaseUsdt: 25,
    /** DeployAgentScreen.tsx:2241 and :933 (plane DCA_MIN_ORDER_WEI, settings.ts:201). */
    minOrderUsdt: 10,
    /** DeployAgentScreen.tsx:2238 and :931: 1.5 % on every stock. Plane: 1 %, and 1.5 % only on the 0.01 % pools (settings.ts:411-416). */
    minTakeProfitPct: 1.5,
    /** DeployAgentScreen.tsx:2236 and :930: price drop step 1..30 %, further capped by max orders (lib/trade.ts:164 `dcaMaxStepBps`). */
    stepPct: { min: 1, max: 30 },
    /** DeployAgentScreen.tsx:2235 and :934. */
    maxOrders: { min: 1, max: 8, default: 3 },
    /** DeployAgentScreen.tsx:2244: optional stop loss 1..99 % of the total deposit. */
    stopLossPct: { min: 1, max: 99 },
    /** lib/agentic.ts:152-155: Earn is offered on DCA only with at least 5 orders. */
    earnMinOrders: 5,
  },
  portfolio: {
    /** DeployAgentScreen.tsx:364 and :2249. */
    stocks: { min: 2, max: 5 },
    /** DeployAgentScreen.tsx:364 SP_MIN_WEIGHT and :2251: whole percent, each at least 10, summing to 100. */
    minWeightPct: 10,
    /** DeployAgentScreen.tsx:365 `spMinCapital`: 50 USDT for two stocks plus 25 per extra stock. */
    minCapitalUsdt: { base: 50, perExtraStock: 25 },
    /** DeployAgentScreen.tsx:2256 and :962: drift 0.5..15 % in 0.5 % steps; rebalance chips :963-964. */
    driftPct: { min: 0.5, max: 15, step: 0.5 },
    intervals: ["4h", "8h", "12h", "Daily"] as const,
  },
  earn: {
    /** lib/agentic.ts:178-188 AGENTIC_EARN_COPY and :163 (FLOOR 20 USDT, 60 % of capital). */
    maxShareOfCapitalPct: 60,
    minLendUsdt: 20,
    allBackHoursBeforeEnd: 2,
    protocols: ["Venus", "Aave v3"] as const,
  },
} as const;

/** DeployAgentScreen.tsx:618-636: the 17 stocks Auto DCA and Smart Portfolio accept (a Pancake V3 USDT pool measured on chain 2026-09-24). */
export const DCA_PORTFOLIO_STOCKS = ["NVDAB", "SPCXB", "BABAB", "TSLAB", "QQQB", "GOOGLB", "CRCLB", "SKHYB", "METAB", "MSFTB", "TSMB", "SPYB", "INTCB", "MSTRB", "HOODB", "SOXLB", "SNDKB"] as const;

/** Where the web form and the execution plane disagree, which value this table uses, and why. */
export const HIRE_CONFLICTS: readonly { readonly item: string; readonly web: string; readonly plane: string; readonly used: string; readonly why: string }[] = [
  { item: "DCA base order minimum", web: "25 USDT (DeployAgentScreen.tsx:2240)", plane: "15 USDT (settings.ts:199)", used: "25 USDT", why: "operator ruling 2026-09-25 lifted the web floor; a hire below 25 cannot be made in the form" },
  { item: "DCA take profit minimum", web: "1.5 % on every stock (:2238)", plane: "1 %, 1.5 % only on 0.01 % pools (settings.ts:411-416)", used: "1.5 %", why: "the form is the stricter door" },
  { item: "Schedule total budget", web: "at least one buy plus a 5 % platform fee (:2226)", plane: "Agentic gate prices the fee at 0 (domain.ts:241)", used: "web value (listed as the form's rule)", why: "the form refuses first; the plane would accept a smaller budget" },
  { item: "Schedule frequency", web: "the select offers Weekly (:543) but SCHED_INTERVALS has no Weekly (:544), so it signs Daily", plane: "1h, 4h, 8h, 12h, daily (settings.ts:196)", used: "five intervals, no Weekly", why: "Weekly is a form defect, not a product option" },
];
