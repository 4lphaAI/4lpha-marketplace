/**
 * The three job handlers. Each one fetches the data (read-only), computes every number in code
 * (maths.ts), lets the model write only a short summary around those numbers (prose.ts) and assembles
 * the Markdown report itself. Missing data makes its own section say so; nothing is invented.
 */

import { buyBackdrop, type Backdrop, type BuyFn } from "./backdrop.js";
import { bps, fixed, NA, NOT_ADVICE, pct, table, ts, usd } from "./fmt.js";
import { builtInHireLimits, readHireLimits, type HireLimits } from "./hire.js";
import {
  allocate,
  checkPortfolio,
  DCA_BASE_SHARE,
  minCapital,
  planDca,
  planSchedule,
  portfolioSlots,
  suggestDrift,
  type PortfolioLimits,
  type RuleCheck,
} from "./maths.js";
import { bstockAnalysis, getHireLink, stockCompare, type HireAgent, type McpClient, type McpResult } from "./mcp.js";
import { readAnalysis, readCompare, metricValue, type Analysis, type Compare } from "./parse.js";
import { writeSummary, type Llm } from "./prose.js";
import type { DeskRequest } from "./request.js";
import {
  compareSection,
  indicatorTime,
  premiumWord,
  priceSection,
  riskFlags,
  sizeRow,
  technicalsSection,
  unavailable,
  verdictAt,
  versionOf,
} from "./sections.js";

export interface DeskDeps {
  readonly client: McpClient;
  readonly buy: BuyFn | null;
  readonly llm: Llm | null;
  readonly now: () => number;
  /** the job id: a retried delivery of the same job reuses its paid data point */
  readonly jobKey: string;
  /** Aborted at the delivery deadline: no new request, no new payment, no model call after it. */
  readonly signal?: AbortSignal;
  /** Sections computed so far, so a failure or the deadline can still deliver them (see desk/index.ts). */
  readonly progress?: { readonly sections: string[] };
}

export interface Built {
  readonly markdown: string;
  readonly summaryBy: "model" | "template" | "none";
  readonly backdrop: Backdrop["status"] | "none";
}

// ---- data fetching -------------------------------------------------------------------------

interface Got<T> {
  readonly value: T | null;
  readonly code: string | null;
  readonly at: number | null;
}

function failCode(r: McpResult): string {
  return r.ok ? "bad_response" : r.code;
}

function keep(d: DeskDeps, ...blocks: readonly (readonly string[])[]): void {
  if (d.progress === undefined) return;
  for (const b of blocks) d.progress.sections.push(...b, "");
}

async function getCompare(d: DeskDeps, ticker: string | undefined, usdt: number | undefined, keepIt = true): Promise<Got<Compare>> {
  if (d.signal?.aborted) return { value: null, code: "aborted", at: null };
  const r = await stockCompare(d.client, ticker, usdt, d.signal);
  if (!r.ok) return { value: null, code: r.code, at: null };
  const c = readCompare(r.data);
  if (c === null) return { value: null, code: "bad_response", at: r.fetchedAt };
  if (keepIt) keep(d, compareSection(c, null));
  return { value: c, code: null, at: r.fetchedAt };
}

async function getAnalysis(d: DeskDeps, symbol: string): Promise<Got<Analysis>> {
  if (d.signal?.aborted) return { value: null, code: "aborted", at: null };
  const r = await bstockAnalysis(d.client, symbol, undefined, d.signal);
  if (!r.ok) return { value: null, code: r.code, at: null };
  const a = readAnalysis(r.data);
  if (a === null) return { value: null, code: "bad_response", at: r.fetchedAt };
  keep(d, priceSection(a, null));
  return { value: a, code: null, at: r.fetchedAt };
}

interface HireGot {
  readonly limits: HireLimits;
  readonly live: boolean;
  readonly code: string | null;
  readonly at: number | null;
}

async function getHire(d: DeskDeps, agent: HireAgent): Promise<HireGot> {
  if (d.signal?.aborted) return { limits: builtInHireLimits(agent), live: false, code: "aborted", at: null };
  const r = await getHireLink(d.client, agent, d.now, d.signal);
  if (!r.ok) return { limits: builtInHireLimits(agent), live: false, code: r.code, at: null };
  return { limits: readHireLimits(agent, r.data), live: true, code: null, at: r.fetchedAt };
}

const backdropCache = new Map<string, Backdrop>();

async function getBackdrop(d: DeskDeps): Promise<Backdrop> {
  const hit = backdropCache.get(d.jobKey);
  if (hit !== undefined) return hit;
  const b: Backdrop = d.buy === null ? { status: "failed", reason: "no_wallet_configured" } : await buyBackdrop(d.buy, d.now, d.signal);
  keep(d, backdropSection(b));
  // paid, unreadable and unknown are all remembered per job: a retried delivery never buys again
  if (b.status === "paid" || b.status === "unreadable" || b.status === "unknown") {
    backdropCache.set(d.jobKey, b);
    if (backdropCache.size > 100) backdropCache.delete(backdropCache.keys().next().value as string);
  }
  return b;
}

/** Test seam. */
export function clearBackdropCache(): void {
  backdropCache.clear();
}

// ---- shared pieces -------------------------------------------------------------------------

function backdropSection(b: Backdrop): string[] {
  const out = ["## Crypto backdrop (CoinMarketCap data, paid by this agent over x402)"];
  if (b.status === "paid") {
    for (const a of b.assets) out.push(`- ${a.symbol}: ${usd(a.priceUsd)} USD, 24h change ${pct(a.change24hPct)}.`);
    out.push(`- Bought ${ts(b.fetchedAt)} for ${b.paidUsd === null ? NA : usd(b.paidUsd, 4)} USD from the agent wallet${b.tx === null ? "" : `, payment transaction ${b.tx}`}.`);
  } else if (b.status === "unreadable") {
    out.push(`- The data was bought${b.tx === null ? "" : ` (payment transaction ${b.tx})`} but its shape was not recognised, so it is left out.`);
  } else if (b.status === "unknown") {
    out.push(`- A payment was sent but its outcome was not confirmed (${b.reason}), so the data point is not in this report. It was not bought again for this job. Check the agent wallet's transactions.`);
  } else {
    out.push(unavailable("crypto backdrop", b.reason === "" ? b.status : b.reason));
  }
  return out;
}

/** The Binance App settings the Deploy check verifies, with the multiples worked out for this plan's capital. */
function binanceSection(h: HireGot, capital: number): string[] {
  const out = ["## Before you deploy: Binance App settings (the Deploy page verifies these)"];
  for (const line of h.limits.binanceApp) {
    const m = /Daily limit of at least (\d+(?:\.\d+)?) x the capital/i.exec(line);
    out.push(m === null ? `- ${line}` : `- ${line} For this plan: at least ${usd(Number(m[1]) * capital)} USDT.`);
  }
  if (!h.live) out.push("- This list is the built-in one (the live list could not be read).");
  return out;
}

function ruleText(rule: "most_frequent_with_min_multiple" | "least_frequent_feasible" | "runs_end_rule", buyMin: number, days: number, runs: number, spentDays: number): string {
  if (rule === "most_frequent_with_min_multiple") return `the most frequent frequency that keeps each buy at least 5 times the ${buyMin} USDT minimum`;
  if (rule === "least_frequent_feasible") return "no frequency keeps each buy at 5 times the minimum, so the least frequent one that fits is used";
  return `no frequency can spread this budget over the ${days}-day term with buys of at least ${buyMin} USDT, so the form's "after N runs" end rule is used: ${runs} buys at the least frequent setting, then the agent stops (the budget is spent after about ${spentDays} days, before the term ends)`;
}

function deadlineNote(d: DeskDeps): string[] {
  return d.signal?.aborted === true ? ["- The delivery time limit was reached: sections marked unavailable (aborted or deadline) were not fetched."] : [];
}

function hireNote(h: HireGot, agent: HireAgent): string[] {
  const out: string[] = [];
  if (!h.live) {
    out.push(`- The live hire limits could not be read (${h.code ?? "no_data"}); built-in limits from 2026-10-08 are used and may be out of date.`);
  } else {
    out.push(`- Hire limits read from 4lpha's get_hire_link at ${ts(h.at)}: ${h.limits.fromLink.join(", ") || "none"}.`);
    if (h.limits.builtIn.length > 0) out.push(`- Built-in values used because the sentence could not be read: ${h.limits.builtIn.join(", ")}.`);
    if (!h.limits.available) out.push(`- 4lpha shows ${agent} as not offered right now.`);
  }
  return out;
}

function dataTimes(items: readonly (readonly [string, number | null])[]): string[] {
  return ["## Data times", ...items.map(([label, ms]) => `- ${label}: ${ts(ms)}`)];
}

function header(title: string, d: DeskDeps, subject: string): string[] {
  return [`# 4lpha bStock Desk: ${title}`, `Generated ${ts(d.now())}. ${subject}`, ""];
}

function deploySection(h: HireGot, tile: string, extra: string[]): string[] {
  return [
    "## Run it",
    "This desk only plans: it cannot trade, hold or move anyone's funds. To run a plan, hire a hosted 4lpha agent. Open the plain Deploy link below, pick the mode tile, enter the values above, choose Agentic Wallet and follow the steps shown.",
    `Mode tile: ${tile}.`,
    ...extra,
    "",
    h.limits.deployUrl,
  ];
}

function footer(): string[] {
  return ["", "---", NOT_ADVICE];
}

async function summarise(d: DeskDeps, facts: string[], fallback: string): Promise<{ text: string; by: "model" | "template" }> {
  const w = await writeSummary(d.llm, facts, fallback, d.signal);
  return w;
}

// ---- stock_report --------------------------------------------------------------------------

export async function stockReport(req: Extract<DeskRequest, { type: "stock_report" }>, d: DeskDeps): Promise<Built> {
  const cmp = await getCompare(d, req.ticker, req.usdt ?? undefined);
  const symbol = versionOf(cmp.value, "bstock")?.symbol ?? (cmp.code === "not_found" ? null : req.ticker);
  const ana: Got<Analysis> = symbol === null ? { value: null, code: "stock_not_found", at: null } : await getAnalysis(d, symbol);
  if (ana.value !== null) keep(d, technicalsSection(ana.value, null));
  const anyData = cmp.value !== null || ana.value !== null;
  const back: Backdrop | null = anyData ? await getBackdrop(d) : null;

  const c = cmp.value;
  const a = ana.value;
  const size = c?.sizeUsedUsdt ?? null;
  const bRow = sizeRow(versionOf(c, "bstock"), size);
  const v = verdictAt(c, size);
  const rsi1h = metricValue(a?.indicators["1h"] ?? null, "rsi14");
  const spread1h = metricValue(a?.indicators["1h"] ?? null, "emaSpreadPct");
  const flags = riskFlags(a, c, size);

  const facts: string[] = [];
  const sentences: string[] = [];
  if (a !== null) {
    facts.push(`token: ${a.symbol}`, `venue price USD: ${usd(a.price.venuePriceUsd)}`, `premium to NAV: ${premiumWord(a.price.premiumBps)}`);
    sentences.push(`${a.symbol} trades at ${usd(a.price.venuePriceUsd)} USD, ${premiumWord(a.price.premiumBps)}.`);
    if (a.sessionState !== null) {
      facts.push(`US session state: ${a.sessionState}`);
      sentences.push(`The US session state is ${a.sessionState}.`);
    }
    if (rsi1h !== null) {
      facts.push(`1h RSI: ${fixed(rsi1h, 1)}`);
      sentences.push(`The 1h RSI is ${fixed(rsi1h, 1)}${spread1h === null ? "" : ` and the EMA12/EMA26 spread is ${fixed(spread1h, 2)} %`}.`);
    }
    if (!("error" in a.regime) && a.regime.label !== null && a.regime.label !== "unavailable") {
      facts.push(`market regime: ${a.regime.label}`);
      sentences.push(`The SPY and QQQ regime reads ${a.regime.label}.`);
    }
  }
  if (c !== null && bRow !== null && bRow.ok) {
    facts.push(`bStock cost over share price at ${size} USDT: ${bps(bRow.costBps)}`, `round trip loss at ${size} USDT: ${bps(bRow.roundTripBps)}`);
    sentences.push(`Buying ${size} USDT of the bStock costs ${bps(bRow.costBps)} over the share price and a round trip loses ${bps(bRow.roundTripBps)}.`);
  }
  if (v !== null && !v.unreadable) facts.push(`version verdict at ${size} USDT: ${v.best ?? (v.aboutSame ? "about the same" : v.only ?? "no clear leader")}`);
  facts.push(`flags raised: ${flags.length}`);
  if (sentences.length === 0) sentences.push("Little data was available for this stock right now; the sections below say what is missing.");
  const sum = await summarise(d, facts, sentences.join(" "));

  const subject = `Stock: ${c?.ticker ?? req.ticker}${symbol !== null ? ` (token ${symbol})` : ""}${req.usdt === null ? "" : `, amount ${req.usdt} USDT${size !== null && size !== req.usdt ? ` (nearest stored size ${size} USDT)` : ""}`}.`;
  const lines: string[] = [...header(`stock report ${c?.ticker ?? req.ticker}`, d, subject)];
  lines.push("## Summary", sum.text, "");
  lines.push(...priceSection(a, ana.code), "");
  lines.push(...technicalsSection(a, ana.code), "");
  lines.push(...compareSection(c, cmp.code), "");
  if (back !== null) lines.push(...backdropSection(back), "");
  lines.push("## Risks and flags");
  if (a === null && c === null) lines.push("- No data was available, so no flag can be raised.");
  else if (flags.length === 0) lines.push("- No automatic flag was raised on the data above. That is not a guarantee of anything.");
  else lines.push(...flags.map((f) => `- ${f}`));
  lines.push("");
  lines.push(
    ...dataTimes([
      ["Quote comparison (stored quotes)", c?.quotedAt ?? null],
      ["Token price and depth", a?.price.asOf ?? null],
      ["15m indicators", indicatorTime(a?.indicators["15m"] ?? null)],
      ["1h indicators", indicatorTime(a?.indicators["1h"] ?? null)],
      ["Market regime", a === null || "error" in a.regime ? null : a.regime.asOf],
      ["Crypto backdrop", back !== null && (back.status === "paid" || back.status === "unreadable") ? back.fetchedAt : null],
    ]),
  );
  lines.push(`- Summary written by: ${sum.by === "model" ? "the model, from the numbers above" : "a fixed template"}.`, ...deadlineNote(d));
  lines.push(...footer());
  return { markdown: lines.join("\n"), summaryBy: sum.by, backdrop: back === null ? "none" : back.status };
}

// ---- dca_plan ------------------------------------------------------------------------------

export async function dcaPlanReport(req: Extract<DeskRequest, { type: "dca_plan" }>, d: DeskDeps): Promise<Built> {
  const agent: HireAgent = req.mode === "dca" ? "agentic-dca" : "agentic-schedule";
  const hire = await getHire(d, agent);
  const cmp = await getCompare(d, req.ticker, req.usdt);
  const symbol = versionOf(cmp.value, "bstock")?.symbol ?? null;
  const ana: Got<Analysis> = symbol === null ? { value: null, code: cmp.code === null ? "no_bstock_version" : "ticker_unresolved", at: null } : await getAnalysis(d, symbol);
  const anyData = cmp.value !== null || ana.value !== null;
  const back: Backdrop | null = anyData ? await getBackdrop(d) : null;

  const c = cmp.value;
  const a = ana.value;
  const L = hire.limits;
  const v = L.values;
  const size = c?.sizeUsedUsdt ?? null;
  let binanceCapital = req.usdt;
  let dcaOrders: number | null = null;
  const lines: string[] = [];
  const modeName = req.mode === "dca" ? "Auto DCA" : "Schedule buy";
  const subject = `Plan: ${modeName} for ${c?.ticker ?? req.ticker}${symbol !== null ? ` (token ${symbol})` : ""}, budget ${req.usdt} USDT, term ${req.days} days.`;
  lines.push(...header(`${req.mode === "dca" ? "DCA plan" : "schedule plan"} ${c?.ticker ?? req.ticker}`, d, subject));

  const facts: string[] = [`mode: ${modeName}`, `budget USDT: ${req.usdt}`, `term days: ${req.days}`];
  const sentences: string[] = [];
  const planLines: string[] = [];
  let runExtra: string[] = [];

  const acceptedList = L.stocks;
  const notAccepted = req.mode === "dca" && symbol !== null && acceptedList !== null && !acceptedList.includes(symbol);

  if (symbol === null) {
    planLines.push(unavailable("plan", cmp.code === "not_found" ? "stock_not_found" : "no_bstock_version"));
    planLines.push(cmp.code === "not_found" ? "- 4lpha does not quote this stock, so no plan is made." : "- No bStock version of this stock could be read, and the hosted agents trade bStocks only.");
    sentences.push("No plan could be made because the stock could not be resolved to a bStock.");
  } else if (notAccepted) {
    planLines.push(`- ${symbol} is not one of the ${acceptedList?.length ?? 0} stocks Auto DCA accepts (${(acceptedList ?? []).join(", ")}), so no DCA plan is made for it.`);
    sentences.push(`${symbol} is not accepted by Auto DCA, so no plan was made.`);
  } else if (req.mode === "dca") {
    const atr = metricValue(a?.indicators["1h"] ?? null, "atrPct");
    const p0 = a?.price.venuePriceUsd ?? null;
    const plan = planDca({
      budget: req.usdt,
      atrPct1h: atr,
      startPriceUsd: p0,
      limits: { baseMin: v.baseMin as number, orderMin: v.orderMin as number, maxOrders: v.maxOrders as number, stepMin: v.stepMin as number, stepMax: v.stepMax as number, tpMin: v.tpMin as number },
    });
    if (!plan.ok) {
      planLines.push(`- The budget ${req.usdt} USDT is below the Auto DCA minimum of ${usd(plan.minBudget)} USDT (a base order of at least ${v.baseMin} plus one DCA order of at least ${v.orderMin}). No plan is made.`);
      sentences.push(`The budget is below the Auto DCA minimum of ${usd(plan.minBudget)} USDT.`);
    } else {
      planLines.push(
        "## Plan (Auto DCA)",
        ...table(
          ["Setting", "Value", "How it was set"],
          [
            ["Base order", `${usd(plan.base)} USDT`, `about ${DCA_BASE_SHARE * 100} % of the budget in steps of 5, never below the minimum ${v.baseMin}`],
            ["Max DCA orders", String(plan.orders), "3, the form default, or fewer if the budget cannot fund 3 orders"],
            ["DCA order size", `${usd(plan.orderSize)} USDT`, `equal orders in steps of 10, at least ${v.orderMin}`],
            ["Total delegated", `${usd(plan.total)} USDT`, `base + orders x order size; ${usd(plan.leftover)} USDT of the budget stays outside`],
            [
              "Price drop step",
              `${fixed(plan.stepPct, 1)} %`,
              plan.stepSource === "atr"
                ? `1h ATR is ${fixed(plan.atrPct, 2)} % of price, rounded to 0.5${plan.stepClamped ? `, clamped to ${v.stepMin} to ${fixed(plan.stepCeilingPct, 1)} % (the ceiling for ${plan.orders} orders)` : ""}`
                : `the 1h ATR was unavailable (${ana.code ?? "stale or missing"}), so the form minimum ${v.stepMin} % is used`,
            ],
            ["Take profit", `${fixed(plan.tpPct, 1)} %`, `one step, never below the minimum ${v.tpMin} %, counted from the average cost`],
            ["Stop loss (optional)", `${plan.stopLossPct} % of the total`, "the loss if the price fell to where one more level would sit; it ends the agent and sells nothing"],
          ],
        ),
        "",
        "## Ladder",
        ...table(
          ["Level", "Price drop from start", "Price (USD per token)", "Spent so far (USDT)", "Average cost vs start", "Take profit sits at (vs start)", "Gross gain at take profit (USDT)"],
          plan.levels.map((l) => [
            l.k === 0 ? "Base" : `DCA ${l.k}`,
            pct(l.dropPct),
            l.priceUsd === null ? NA : usd(l.priceUsd),
            usd(l.cumulativeSpend),
            pct(-l.avgCostDropPct),
            pct(l.takeProfitAbovePct),
            usd(l.grossProfitAtTp),
          ]),
        ),
        "Gains are gross: before swap costs, slippage and gas. The ladder spacing grows by 1.2 times at each level.",
      );
      binanceCapital = plan.total;
      dcaOrders = plan.orders;
      const keepAlive = req.days === 7 ? v.keepAlive7 : v.keepAlive30;
      const bnb = plan.slots * (v.bnbPerSlot as number);
      planLines.push(
        "",
        "## What the wallet must hold",
        `- USDT: ${usd(plan.total)} (the total) plus ${usd(keepAlive as number)} for keeping the Binance session alive over ${req.days} days: ${usd(plan.total + (keepAlive as number))}.`,
        `- BNB for gas: ${plan.slots} transaction slots (2 x ${plan.orders} orders + 4) x ${v.bnbPerSlot} BNB = ${fixed(bnb, 4)} BNB.`,
      );
      runExtra = [`Suggested values: stock ${symbol}, base ${usd(plan.base)}, orders ${plan.orders} x ${usd(plan.orderSize)}, step ${fixed(plan.stepPct, 1)} %, take profit ${fixed(plan.tpPct, 1)} %, term ${req.days} days.`];
      facts.push(`base order USDT: ${usd(plan.base)}`, `DCA orders: ${plan.orders}`, `order size USDT: ${usd(plan.orderSize)}`, `step percent: ${fixed(plan.stepPct, 1)}`, `take profit percent: ${fixed(plan.tpPct, 1)}`, `stop loss percent: ${plan.stopLossPct}`);
      sentences.push(`The plan buys a base order of ${usd(plan.base)} USDT and up to ${plan.orders} DCA orders of ${usd(plan.orderSize)} USDT each, with a ${fixed(plan.stepPct, 1)} % price drop step and a ${fixed(plan.tpPct, 1)} % take profit.`);
    }
  } else {
    const sched = planSchedule({
      budget: req.usdt,
      days: req.days,
      limits: { buyMin: v.buyMin as number, reservePct: v.reservePct as number, runsMax: v.runsMax as number, intervalsHours: L.intervalsHours ?? [1, 4, 8, 12, 24] },
    });
    if (!sched.ok) {
      planLines.push(`- The budget ${req.usdt} USDT cannot fund a Schedule buy: it needs at least ${usd(sched.minBudget)} USDT (one buy of at least ${v.buyMin} USDT plus a ${v.reservePct} % reserve). No plan is made.`);
      sentences.push("The budget is too small for a Schedule buy.");
    } else {
      const r = sched.recommended;
      const label = (h: number): string => (h === 24 ? "Daily" : `${h} hour${h === 1 ? "" : "s"}`);
      const every = (h: number): string => (h === 24 ? "day" : `${h} hour${h === 1 ? "" : "s"}`);
      planLines.push(
        "## Plan (Schedule buy)",
        ...table(
          ["Frequency", "Buys in the term", "Amount per buy (USDT)", "Spent (USDT)", "Fits the form"],
          sched.rows.map((x) => [label(x.intervalHours), String(x.runs), usd(x.amountPerBuy), usd(x.spent), x.feasible ? "yes" : `no (under ${v.buyMin} USDT per buy)`]),
        ),
        "",
        `Recommended: ${label(r.intervalHours)}, ${r.runs} buys of ${usd(r.amountPerBuy)} USDT. Rule: ${ruleText(sched.recommendedRule, v.buyMin as number, req.days, r.runs, sched.spentWithinDays)}.`,
        `Buy only while the token trades within 0.5 to 1.5 % of NAV (the form default is 1.5 %); the first buy can be now. Finish ${r.endRule === "runs" ? `after ${r.runs} runs` : "when the budget is spent"}.`,
        "",
        "## What the wallet must hold",
        `- USDT: ${usd(req.usdt)} (the capital you set).`,
        `- BNB for gas: ${r.slots} transaction slots (1 + 2 + ${r.runs} buys) x ${v.bnbPerSlot} BNB = ${fixed(r.slots * (v.bnbPerSlot as number), 4)} BNB.`,
      );
      runExtra = [`Suggested values: stock ${symbol}, ${usd(r.amountPerBuy)} USDT per buy, ${label(r.intervalHours)}, total budget ${usd(req.usdt)} USDT, finish ${r.endRule === "runs" ? `after ${r.runs} runs` : "when the budget is spent"}.`];
      facts.push(`recommended frequency hours: ${r.intervalHours}`, `buys in term: ${r.runs}`, `amount per buy USDT: ${usd(r.amountPerBuy)}`);
      sentences.push(`The recommended Schedule buy is ${r.runs} buys of ${usd(r.amountPerBuy)} USDT, one every ${every(r.intervalHours)}.`);
    }
  }

  // version to buy
  const bRow = sizeRow(versionOf(c, "bstock"), size);
  const vd = verdictAt(c, size);
  const flags = riskFlags(a, c, size);
  if (a !== null) {
    facts.push(`venue price USD: ${usd(a.price.venuePriceUsd)}`, `premium to NAV: ${premiumWord(a.price.premiumBps)}`);
    sentences.push(`${a.symbol} trades at ${usd(a.price.venuePriceUsd)} USD, ${premiumWord(a.price.premiumBps)}.`);
  }
  if (bRow !== null && bRow.ok) facts.push(`bStock cost at ${size} USDT: ${bps(bRow.costBps)}`);
  if (vd !== null && !vd.unreadable && vd.best === "ondo") sentences.push("The Ondo version is quoted cheaper, but the hosted agents buy the bStock version only.");
  const sum = await summarise(d, facts, sentences.join(" "));

  lines.push("## Summary", sum.text, "");
  lines.push(...planLines, "");
  lines.push(...compareSection(c, cmp.code), "");
  lines.push(...priceSection(a, ana.code), "");
  if (back !== null) lines.push(...backdropSection(back), "");
  lines.push("## Risks and flags");
  if (flags.length === 0) lines.push("- No automatic flag was raised on the data above. That is not a guarantee of anything.");
  else lines.push(...flags.map((f) => `- ${f}`));
  if (req.mode === "dca") lines.push("- A DCA stop loss ends the agent and sells nothing; at term end open levels are dropped and holdings stay in the wallet.");
  else lines.push("- A Schedule buy never sells: the stock stays in the wallet when the term ends.");
  if (dcaOrders !== null) lines.push(`- Earn (idle USDT lent to Venus or Aave) is offered only with at least ${v.earnMinOrders} DCA orders; this plan has ${dcaOrders}, so it does not apply.`);
  lines.push("");
  lines.push("## Hire limits used", ...hireNote(hire, agent), "");
  lines.push(
    ...dataTimes([
      ["Quote comparison (stored quotes)", c?.quotedAt ?? null],
      ["Token price and indicators", a?.price.asOf ?? null],
      ["Hire limits", hire.at],
      ["Crypto backdrop", back !== null && (back.status === "paid" || back.status === "unreadable") ? back.fetchedAt : null],
    ]),
  );
  lines.push(`- Summary written by: ${sum.by === "model" ? "the model, from the numbers above" : "a fixed template"}.`, ...deadlineNote(d), "");
  lines.push(...binanceSection(hire, binanceCapital), "");
  lines.push(...deploySection(hire, req.mode === "dca" ? '"Auto DCA"' : '"Schedule buy"', runExtra));
  lines.push(...footer());
  return { markdown: lines.join("\n"), summaryBy: sum.by, backdrop: back === null ? "none" : back.status };
}

// ---- rebalance_plan ------------------------------------------------------------------------

export async function rebalanceReport(req: Extract<DeskRequest, { type: "rebalance_plan" }>, d: DeskDeps): Promise<Built> {
  const hire = await getHire(d, "agentic-portfolio");
  const v = hire.limits.values;
  const limits: PortfolioLimits = {
    stocksMin: v.stocksMin as number,
    stocksMax: v.stocksMax as number,
    weightMin: v.weightMin as number,
    capBase: v.capBase as number,
    capBaseStocks: v.capBaseStocks as number,
    capPerExtra: v.capPerExtra as number,
    driftMin: v.driftMin as number,
    driftMax: v.driftMax as number,
    driftStep: v.driftStep as number,
  };
  const alloc = allocate(req.capital, req.weights);
  const compares: Got<Compare>[] = [];
  for (const row of alloc) {
    const g = await getCompare(d, row.ticker, row.usdt >= 1 ? row.usdt : undefined, false);
    compares.push(g);
    keep(d, [`- ${row.ticker}: allocation ${usd(row.usdt)} USDT, quote comparison ${g.value !== null ? "read" : `unavailable (${g.code ?? "no_data"})`}.`]);
  }
  const anyData = compares.some((x) => x.value !== null);
  const back: Backdrop | null = anyData ? await getBackdrop(d) : null;

  const accepted = new Map<string, boolean | null>();
  const resolved: (string | null)[] = [];
  alloc.forEach((row, i) => {
    const c = compares[i]?.value ?? null;
    const sym = versionOf(c, "bstock")?.symbol ?? null;
    resolved.push(c?.ticker ?? null);
    accepted.set(row.ticker, sym === null ? null : (hire.limits.stocks ?? []).includes(sym));
  });
  const rules: RuleCheck[] = checkPortfolio({ capital: req.capital, weights: req.weights, accepted, limits });
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const t of resolved) {
    if (t === null) continue;
    if (seen.has(t)) dup.push(t);
    seen.add(t);
  }
  if (dup.length > 0) rules.push({ rule: "no stock twice", pass: false, detail: `${dup.join(", ")} appears under two names` });
  const failed = rules.filter((r) => !r.pass);

  // per stock rows
  const stockRows: string[][] = [];
  const rtList: number[] = [];
  let ondoCheaper = 0;
  alloc.forEach((row, i) => {
    const g = compares[i] as Got<Compare>;
    const c = g.value;
    const b = versionOf(c, "bstock");
    const size = c?.sizeUsedUsdt ?? null;
    const br = sizeRow(b, size);
    const vd = verdictAt(c, size);
    if (br !== null && br.ok && br.roundTripBps !== null) rtList.push(br.roundTripBps);
    let verdict: string = NA;
    if (c === null) verdict = `unavailable (${g.code ?? "no_data"})`;
    else if (vd === null) verdict = "no verdict at this size";
    else if (vd.unreadable) verdict = "unreadable";
    else if (vd.only !== null) verdict = `only ${vd.only}`;
    else if (vd.best !== null) {
      verdict = `${vd.best} cheaper by ${fixed(vd.edgeBps, 1)} bps`;
      if (vd.best === "ondo") ondoCheaper += 1;
    } else if (vd.aboutSame) verdict = "about the same";
    else verdict = "no clear leader";
    stockRows.push([
      row.ticker,
      `${row.weightPct} %`,
      usd(row.usdt),
      b === null ? NA : b.symbol,
      size === null ? NA : String(size),
      br === null ? NA : br.ok ? bps(br.costBps) : `no quote (${br.code ?? "unknown"})`,
      br === null ? NA : br.ok ? (br.roundTripBps === null ? "n/a (exit not checked)" : bps(br.roundTripBps)) : NA,
      verdict,
    ]);
  });
  const worstRt = rtList.length > 0 ? Math.max(...rtList) : null;
  const drift = suggestDrift(worstRt, limits);

  const n = req.weights.length;
  const facts: string[] = [`capital USDT: ${req.capital}`, `stocks: ${n}`, `rules failed: ${failed.length}`];
  const sentences: string[] = [`The basket has ${n} stocks and ${usd(req.capital)} USDT of capital; ${failed.length === 0 ? "it passes every Smart Portfolio rule" : `${failed.length} Smart Portfolio rule${failed.length === 1 ? " is" : "s are"} not met`}.`];
  if (drift !== null) {
    facts.push(`suggested drift threshold percent: ${fixed(drift, 1)}`, `worst round trip loss bps: ${fixed(worstRt, 1)}`);
    sentences.push(`The suggested drift threshold is ${fixed(drift, 1)} %: five times the worst exit cost of ${fixed(worstRt, 1)} bps, and never below 1 %.`);
  } else {
    sentences.push("A drift threshold could not be derived because no exit cost was available.");
  }
  if (ondoCheaper > 0) sentences.push("For some stocks the Ondo version is quoted cheaper, but the hosted agent buys the bStock version only.");
  const sum = await summarise(d, facts, sentences.join(" "));

  const lines: string[] = [];
  lines.push(...header("rebalance plan", d, `Plan: Smart Portfolio of ${req.weights.map((w) => `${w.ticker} ${w.weightPct} %`).join(", ")}, capital ${req.capital} USDT.`));
  lines.push("## Summary", sum.text, "");
  lines.push(
    "## Allocation and cost per stock",
    ...table(["Stock", "Weight", "Allocation (USDT)", "bStock", "Quote size (USDT)", "Cost over share price", "Round trip loss", "Cheaper version"], stockRows),
    "Rounded to cents. Costs are for the nearest stored quote size, not for the exact allocation. The hosted agent buys the bStock version.",
    "",
  );
  lines.push("## Smart Portfolio rules", ...table(["Rule", "Result", "Detail"], rules.map((r) => [r.rule, r.pass ? "pass" : "FAIL", r.detail])));
  lines.push(failed.length === 0 ? "All rules pass: this basket can be deployed as given." : `Not deployable as given: fix ${failed.map((r) => `"${r.rule}"`).join(", ")}. The minimum capital for ${n} stocks is ${minCapital(n, limits)} USDT.`, "");
  lines.push("## Rebalance trigger");
  if (drift === null) {
    lines.push(unavailable("drift threshold suggestion", "no_exit_cost_data"));
  } else {
    lines.push(
      `- Suggested drift threshold: ${fixed(drift, 1)} % (the form accepts ${limits.driftMin} to ${limits.driftMax} % in steps of ${limits.driftStep} %).`,
      `- Rule of thumb, not a forecast: five times the worst round trip loss in the basket (${bps(worstRt)}${rtList.length < n ? `, from ${rtList.length} of ${n} stocks` : ""}), at least 1 %, on the form's grid.`,
    );
  }
  const intervals = hire.limits.intervalsHours ?? [4, 8, 12, 24];
  lines.push(
    `- Check interval: the form offers ${intervals.map((h) => (h === 24 ? "Daily" : `${h}h`)).join(", ")} (no 1h). Default of this plan: Daily. Nothing here ranks the intervals; a shorter one corrects drift sooner.`,
  );
  const slots = portfolioSlots(n);
  lines.push(
    "",
    "## What the wallet must hold",
    `- USDT: ${usd(req.capital)} plus ${usd(v.keepAlive7 as number)} (7-day term) or ${usd(v.keepAlive30 as number)} (30-day term) for keeping the Binance session alive.`,
    `- BNB for gas: ${slots} transaction slots (2 x ${n} stocks + 2) x ${v.bnbPerSlot} BNB = ${fixed(slots * (v.bnbPerSlot as number), 4)} BNB.`,
    "",
  );
  if (back !== null) lines.push(...backdropSection(back), "");
  lines.push("## Hire limits used", ...hireNote(hire, "agentic-portfolio"), "");
  lines.push(
    ...dataTimes([
      ...alloc.map((row, i): readonly [string, number | null] => [`Quote comparison ${row.ticker}`, compares[i]?.value?.quotedAt ?? null]),
      ["Hire limits", hire.at],
      ["Crypto backdrop", back !== null && (back.status === "paid" || back.status === "unreadable") ? back.fetchedAt : null],
    ]),
  );
  lines.push(`- Summary written by: ${sum.by === "model" ? "the model, from the numbers above" : "a fixed template"}.`, ...deadlineNote(d), "");
  lines.push(...binanceSection(hire, req.capital), "");
  lines.push(...deploySection(hire, '"Smart Portfolio"', [`Suggested values: ${req.weights.map((w) => `${w.ticker} ${w.weightPct} %`).join(", ")}, capital ${usd(req.capital)} USDT${drift === null ? "" : `, drift ${fixed(drift, 1)} %`}, check interval Daily.`]));
  lines.push(...footer());
  return { markdown: lines.join("\n"), summaryBy: sum.by, backdrop: back === null ? "none" : back.status };
}
