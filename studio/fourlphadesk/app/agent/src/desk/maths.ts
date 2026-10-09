/**
 * Plan maths. Pure functions, no I/O: every number in a plan comes from here, never from the model.
 *
 * Sources of the rules (all public in the hire form of 4lpha.tech): the DCA ladder shape and the
 * step ceiling for N orders, form granularity (base in 5s, order in 10s, step and take profit in 0.5 %),
 * the Schedule intervals and Smart Portfolio rules. Limits that the hire link states are passed in.
 */

const round2 = (x: number): number => Math.round(x * 100) / 100;
const floorTo = (x: number, step: number): number => Math.floor(x / step + 1e-9) * step;
const roundHalf = (x: number): number => Math.round(x * 2) / 2;

/** Largest step (in bps) the hosted DCA ladder admits for N orders: the deepest level stays within 90 %. */
export function dcaMaxStepBps(maxOrders: number): number {
  const n = BigInt(maxOrders);
  const exact = (9000n * 5n ** n) / (5n * (6n ** n - 5n ** n));
  return Math.min(3000, Number(exact));
}

/** Cumulative drop of level k from the start price, in units of one step (steps grow by 1.2 each level). */
export function ladderUnits(k: number): number {
  return 5 * (Math.pow(1.2, k) - 1);
}

export interface DcaLimits {
  readonly baseMin: number;
  readonly orderMin: number;
  readonly maxOrders: number;
  readonly stepMin: number;
  readonly stepMax: number;
  readonly tpMin: number;
}

export const DCA_BASE_GRANULARITY = 5;
export const DCA_ORDER_GRANULARITY = 10;
export const DCA_BASE_SHARE = 0.4;
export const DCA_DEFAULT_ORDERS = 3;
export const DCA_ORDERS_NOTE_SLOTS = (n: number): number => 2 * n + 4;

export interface DcaLevel {
  readonly k: number;
  readonly dropPct: number;
  readonly priceUsd: number | null;
  readonly cumulativeSpend: number;
  readonly avgCostDropPct: number;
  readonly takeProfitAbovePct: number;
  readonly grossProfitAtTp: number;
}

export type DcaPlan =
  | { readonly ok: false; readonly minBudget: number }
  | {
      readonly ok: true;
      readonly base: number;
      readonly orders: number;
      readonly orderSize: number;
      readonly total: number;
      readonly leftover: number;
      readonly stepPct: number;
      readonly stepSource: "atr" | "minimum";
      readonly stepClamped: boolean;
      readonly stepCeilingPct: number;
      readonly atrPct: number | null;
      readonly tpPct: number;
      readonly stopLossPct: number;
      readonly levels: readonly DcaLevel[];
      readonly slots: number;
    };

export function planDca(input: { budget: number; atrPct1h: number | null; startPriceUsd: number | null; limits: DcaLimits }): DcaPlan {
  const { budget, limits } = input;
  const minBudget = limits.baseMin + limits.orderMin;
  if (!(budget >= minBudget)) return { ok: false, minBudget };

  let base = Math.max(limits.baseMin, floorTo(budget * DCA_BASE_SHARE, DCA_BASE_GRANULARITY));
  let rem = budget - base;
  if (rem < limits.orderMin) {
    base = limits.baseMin;
    rem = budget - base;
  }
  const orders = Math.min(limits.maxOrders, rem >= DCA_DEFAULT_ORDERS * limits.orderMin ? DCA_DEFAULT_ORDERS : Math.max(1, Math.floor(rem / limits.orderMin)));
  const orderSize = Math.max(limits.orderMin, floorTo(rem / orders, DCA_ORDER_GRANULARITY));
  const orderSizeFit = orderSize * orders <= rem + 1e-9 ? orderSize : limits.orderMin;
  const leftoverAfterOrders = rem - orderSizeFit * orders;
  base += floorTo(leftoverAfterOrders, DCA_BASE_GRANULARITY);
  const total = round2(base + orderSizeFit * orders);
  const leftover = round2(budget - total);

  const ceilingBps = dcaMaxStepBps(orders);
  const stepCeilingPct = Math.min(limits.stepMax, floorTo(ceilingBps / 100, 0.5));
  const atrOk = input.atrPct1h !== null && input.atrPct1h > 0;
  const stepRaw = atrOk ? roundHalf(input.atrPct1h as number) : limits.stepMin;
  const stepPct = Math.min(stepCeilingPct, Math.max(limits.stepMin, stepRaw));
  const tpPct = Math.max(limits.tpMin, roundHalf(stepPct));

  const p0 = input.startPriceUsd !== null && input.startPriceUsd > 0 ? input.startPriceUsd : null;
  const rel = (k: number): number => 1 - (stepPct * ladderUnits(k)) / 100;
  const levels: DcaLevel[] = [];
  let spent = base;
  let tokens = base / 1; // token units in "start price" terms: spend / (price relative to start)
  levels.push(levelRow(0, 0, p0, spent, tokens, tpPct));
  for (let k = 1; k <= orders; k++) {
    const price = rel(k);
    spent += orderSizeFit;
    tokens += orderSizeFit / price;
    levels.push(levelRow(k, stepPct * ladderUnits(k), p0, spent, tokens, tpPct));
  }
  // stop loss: the loss, as a share of the total, if the price falls to where one more level would sit
  const pNext = rel(orders + 1);
  const lossAll = pNext <= 0 ? total : Math.max(0, spent - tokens * pNext);
  const stopLossPct = Math.min(99, Math.max(1, Math.ceil((lossAll / total) * 100)));

  return {
    ok: true,
    base: round2(base),
    orders,
    orderSize: orderSizeFit,
    total,
    leftover,
    stepPct,
    stepSource: atrOk ? "atr" : "minimum",
    stepClamped: atrOk && stepPct !== stepRaw,
    stepCeilingPct,
    atrPct: atrOk ? (input.atrPct1h as number) : null,
    tpPct,
    stopLossPct,
    levels,
    slots: DCA_ORDERS_NOTE_SLOTS(orders),
  };
}

function levelRow(k: number, dropPct: number, p0: number | null, spent: number, tokensInStartTerms: number, tpPct: number): DcaLevel {
  // tokensInStartTerms is tokens bought, measured in units where the start price is 1.
  const avgRel = spent / tokensInStartTerms; // average cost relative to the start price
  return {
    k,
    dropPct: round2(dropPct),
    priceUsd: p0 === null ? null : round2(p0 * (1 - dropPct / 100)),
    cumulativeSpend: round2(spent),
    avgCostDropPct: round2((1 - avgRel) * 100),
    takeProfitAbovePct: round2((avgRel * (1 + tpPct / 100) - 1) * 100),
    grossProfitAtTp: round2(spent * (tpPct / 100)),
  };
}

// ---------------------------------------------------------------------------------------------

export interface ScheduleLimits {
  readonly buyMin: number;
  readonly reservePct: number;
  readonly runsMax: number;
  readonly intervalsHours: readonly number[];
}

export const SCHEDULE_RECOMMENDED_MIN_BUY_MULT = 5;

export interface ScheduleRow {
  readonly intervalHours: number;
  readonly runs: number;
  readonly amountPerBuy: number;
  readonly feasible: boolean;
  readonly slots: number;
  readonly spent: number;
  /** "budget": the agent stops when the budget is spent (spread over the term); "runs": it stops after `runs` buys */
  readonly endRule: "budget" | "runs";
}

export type SchedulePlan =
  | { readonly ok: false; readonly minBudget: number }
  | {
      readonly ok: true;
      readonly rows: readonly ScheduleRow[];
      readonly recommended: ScheduleRow;
      readonly recommendedRule: "most_frequent_with_min_multiple" | "least_frequent_feasible" | "runs_end_rule";
      /** days the recommended plan takes to spend the budget (below the term for the runs end rule) */
      readonly spentWithinDays: number;
    };

/**
 * Schedule plan. First choice: spread the whole budget over the term at some frequency with buys of at
 * least the minimum. If no frequency can (the budget is small for the term), the hosted form still accepts
 * it through the "runs" end rule (1 to 1000 buys): buy the minimum-sized amounts at the least frequent
 * interval and stop after floor(budget / minimum buy) runs.
 */
export function planSchedule(input: { budget: number; days: number; limits: ScheduleLimits }): SchedulePlan {
  const { budget, days, limits } = input;
  const reserve = 1 + limits.reservePct / 100;
  const minBudget = round2(limits.buyMin * reserve);
  if (!(budget >= minBudget)) return { ok: false, minBudget };
  const intervals = [...limits.intervalsHours].sort((a, b) => a - b);
  const rows: ScheduleRow[] = intervals.map((h) => {
    const runs = Math.max(1, Math.floor((days * 24) / h));
    const amount = Math.floor((budget / runs) * 100) / 100;
    return {
      intervalHours: h,
      runs,
      amountPerBuy: amount,
      feasible: amount >= limits.buyMin && amount * reserve <= budget + 1e-9 && runs <= limits.runsMax,
      slots: 1 + 2 + runs,
      spent: round2(amount * runs),
      endRule: "budget",
    };
  });
  const feasible = rows.filter((r) => r.feasible);
  if (feasible.length > 0) {
    const preferred = feasible.find((r) => r.amountPerBuy >= SCHEDULE_RECOMMENDED_MIN_BUY_MULT * limits.buyMin);
    return preferred !== undefined
      ? { ok: true, rows, recommended: preferred, recommendedRule: "most_frequent_with_min_multiple", spentWithinDays: days }
      : { ok: true, rows, recommended: feasible[feasible.length - 1] as ScheduleRow, recommendedRule: "least_frequent_feasible", spentWithinDays: days };
  }
  const h = intervals[intervals.length - 1] as number;
  const termRuns = Math.max(1, Math.floor((days * 24) / h));
  const runs = Math.max(1, Math.min(termRuns, limits.runsMax, Math.floor(budget / limits.buyMin)));
  let amount = Math.floor((budget / runs) * 100) / 100;
  if (amount * reserve > budget + 1e-9) amount = Math.floor((budget / reserve) * 100) / 100;
  if (amount < limits.buyMin) return { ok: false, minBudget };
  const row: ScheduleRow = { intervalHours: h, runs, amountPerBuy: amount, feasible: true, slots: 1 + 2 + runs, spent: round2(amount * runs), endRule: "runs" };
  return { ok: true, rows, recommended: row, recommendedRule: "runs_end_rule", spentWithinDays: Math.ceil((runs * h) / 24) };
}

// ---------------------------------------------------------------------------------------------

export interface PortfolioLimits {
  readonly stocksMin: number;
  readonly stocksMax: number;
  readonly weightMin: number;
  readonly capBase: number;
  readonly capBaseStocks: number;
  readonly capPerExtra: number;
  readonly driftMin: number;
  readonly driftMax: number;
  readonly driftStep: number;
}

export interface RuleCheck {
  readonly rule: string;
  readonly pass: boolean;
  readonly detail: string;
}

export function minCapital(n: number, l: PortfolioLimits): number {
  return l.capBase + l.capPerExtra * Math.max(0, n - l.capBaseStocks);
}

export function checkPortfolio(input: {
  capital: number;
  weights: readonly { ticker: string; weightPct: number }[];
  /** per ticker: is its bStock one of the accepted stocks (null = could not be resolved) */
  accepted: ReadonlyMap<string, boolean | null>;
  limits: PortfolioLimits;
}): RuleCheck[] {
  const { capital, weights, limits } = input;
  const n = weights.length;
  const sum = weights.reduce((a, w) => a + w.weightPct, 0);
  const lowest = Math.min(...weights.map((w) => w.weightPct));
  const whole = weights.every((w) => Number.isInteger(w.weightPct));
  const need = minCapital(n, limits);
  const unsupported = weights.filter((w) => input.accepted.get(w.ticker) === false).map((w) => w.ticker);
  const unknown = weights.filter((w) => input.accepted.get(w.ticker) === null || input.accepted.get(w.ticker) === undefined).map((w) => w.ticker);
  return [
    { rule: `${limits.stocksMin} to ${limits.stocksMax} stocks`, pass: n >= limits.stocksMin && n <= limits.stocksMax, detail: `${n} given` },
    { rule: "weights are whole percents", pass: whole, detail: whole ? "yes" : "at least one weight has decimals" },
    { rule: `each weight at least ${limits.weightMin} %`, pass: lowest >= limits.weightMin, detail: `lowest is ${lowest} %` },
    { rule: "weights add up to 100 %", pass: Math.abs(sum - 100) < 1e-9, detail: `sum is ${round2(sum)} %` },
    { rule: `capital at least ${need} USDT (${limits.capBase} for ${limits.capBaseStocks} stocks plus ${limits.capPerExtra} per extra stock)`, pass: capital >= need, detail: `${capital} USDT given for ${n} stocks` },
    {
      rule: "every stock is one the hosted agent accepts",
      pass: unsupported.length === 0 && unknown.length === 0,
      detail: unsupported.length > 0 ? `not accepted: ${unsupported.join(", ")}` : unknown.length > 0 ? `could not be checked: ${unknown.join(", ")}` : "yes",
    },
  ];
}

export function allocate(capital: number, weights: readonly { ticker: string; weightPct: number }[]): { ticker: string; weightPct: number; usdt: number }[] {
  return weights.map((w) => ({ ticker: w.ticker, weightPct: w.weightPct, usdt: round2((capital * w.weightPct) / 100) }));
}

export const DRIFT_COST_MULTIPLE = 5;
export const DRIFT_FLOOR_PCT = 1;

/** Drift threshold: five times the worst exit cost, on the form's 0.5 % grid, never below 1 % and inside the form range. */
export function suggestDrift(worstRoundTripBps: number | null, l: PortfolioLimits): number | null {
  if (worstRoundTripBps === null || worstRoundTripBps < 0) return null;
  const raw = (DRIFT_COST_MULTIPLE * worstRoundTripBps) / 100;
  const stepped = Math.ceil(raw / l.driftStep - 1e-9) * l.driftStep;
  return Math.min(l.driftMax, Math.max(l.driftMin, DRIFT_FLOOR_PCT, stepped));
}

/** Portfolio gas slots per the hire form: two per stock plus two. */
export const portfolioSlots = (n: number): number => 2 * n + 2;
