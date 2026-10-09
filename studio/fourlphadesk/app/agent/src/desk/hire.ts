/**
 * Hire limits of 4lpha's hosted agents, read from `get_hire_link`.
 *
 * The tool states the limits as sentences (not as numbers), so each one is pulled out of its own
 * sentence with a narrow pattern. A value that does not match, or looks implausible, falls back to the
 * built-in constant of Revision 1 and is listed as such, so the report says where every limit came from.
 */

import { arr, at, safeText, str, type Json } from "./json.js";
import type { HireAgent } from "./mcp.js";

export const DEFAULT_DEPLOY_URL = "https://4lpha.tech/deploy/trading";
const DEPLOY_ORIGIN = "https://4lpha.tech/";

/** The 17 stocks Auto DCA and Smart Portfolio accept (built-in fallback of the sentence "One of 17 stocks"). */
export const BUILT_IN_STOCKS = [
  "NVDAB", "SPCXB", "BABAB", "TSLAB", "QQQB", "GOOGLB", "CRCLB", "SKHYB", "METAB",
  "MSFTB", "TSMB", "SPYB", "INTCB", "MSTRB", "HOODB", "SOXLB", "SNDKB",
] as const;

export interface HireLimits {
  readonly agent: HireAgent;
  readonly available: boolean;
  readonly deployUrl: string;
  readonly stocks: readonly string[] | null;
  readonly values: Readonly<Record<string, number>>;
  /** Schedule frequencies, or the Smart Portfolio check intervals, in hours (null for Auto DCA) */
  readonly intervalsHours: readonly number[] | null;
  /** the Binance App settings the Deploy check verifies (sanitised lines from requirements.binanceApp) */
  readonly binanceApp: readonly string[];
  /** keys read from the live answer, and keys that fell back to the built-in constant */
  readonly fromLink: readonly string[];
  readonly builtIn: readonly string[];
}

type Spec = { readonly key: string; readonly fallback: number; readonly min: number; readonly max: number; readonly int?: boolean };

const DCA: readonly Spec[] = [
  { key: "baseMin", fallback: 25, min: 1, max: 1000 },
  { key: "orderMin", fallback: 10, min: 1, max: 1000 },
  { key: "maxOrders", fallback: 8, min: 1, max: 20, int: true },
  { key: "stepMin", fallback: 1, min: 0.1, max: 10 },
  { key: "stepMax", fallback: 30, min: 5, max: 90 },
  { key: "tpMin", fallback: 1.5, min: 0.1, max: 20 },
  { key: "bnbPerSlot", fallback: 0.0004, min: 0.00001, max: 0.01 },
  { key: "keepAlive7", fallback: 0.2, min: 0, max: 5 },
  { key: "keepAlive30", fallback: 0.8, min: 0, max: 20 },
  { key: "earnMinOrders", fallback: 5, min: 1, max: 20, int: true },
  { key: "dailyMultiple", fallback: 10, min: 1, max: 100 },
  { key: "x402Daily", fallback: 0.5, min: 0, max: 100 },
];
const SCHEDULE: readonly Spec[] = [
  { key: "buyMin", fallback: 5, min: 1, max: 1000 },
  { key: "reservePct", fallback: 5, min: 0, max: 50 },
  { key: "runsMax", fallback: 1000, min: 1, max: 100000, int: true },
  { key: "bnbPerSlot", fallback: 0.0004, min: 0.00001, max: 0.01 },
  { key: "dailyMultiple", fallback: 2, min: 1, max: 100 },
];
const PORTFOLIO: readonly Spec[] = [
  { key: "stocksMin", fallback: 2, min: 1, max: 20, int: true },
  { key: "stocksMax", fallback: 5, min: 2, max: 20, int: true },
  { key: "weightMin", fallback: 10, min: 1, max: 50 },
  { key: "capBase", fallback: 50, min: 1, max: 100000 },
  { key: "capBaseStocks", fallback: 2, min: 1, max: 20, int: true },
  { key: "capPerExtra", fallback: 25, min: 0, max: 100000 },
  { key: "driftMin", fallback: 0.5, min: 0.1, max: 50 },
  { key: "driftMax", fallback: 15, min: 1, max: 100 },
  { key: "driftStep", fallback: 0.5, min: 0.1, max: 5 },
  { key: "bnbPerSlot", fallback: 0.0004, min: 0.00001, max: 0.01 },
  { key: "keepAlive7", fallback: 0.2, min: 0, max: 5 },
  { key: "keepAlive30", fallback: 0.8, min: 0, max: 20 },
  { key: "dailyMultiple", fallback: 10, min: 1, max: 100 },
  { key: "x402Daily", fallback: 0.5, min: 0, max: 100 },
];

/** Built-in Binance App settings (fallback when requirements.binanceApp cannot be read). */
const BUILT_IN_BINANCE_APP: Record<HireAgent, readonly string[]> = {
  "agentic-dca": [
    "Connected, with Trade all tokens switched on in the Binance App.",
    "Abnormal transactions set to AutoReject.",
    "Max sign-in duration long enough for the term (choose 7 days if the Binance cap is short).",
    "Daily limit of at least 10 x the capital.",
    "x402 daily limit of at least 0.50 USDT.",
  ],
  "agentic-schedule": [
    "Connected, with Trade all tokens switched on in the Binance App.",
    "Abnormal transactions set to AutoReject.",
    "Max sign-in duration long enough for the term (choose 7 days if the Binance cap is short).",
    "Daily limit of at least 2 x the capital.",
  ],
  "agentic-portfolio": [
    "Connected, with Trade all tokens switched on in the Binance App.",
    "Abnormal transactions set to AutoReject.",
    "Max sign-in duration long enough for the term (choose 7 days if the Binance cap is short).",
    "Daily limit of at least 10 x the capital.",
    "x402 daily limit of at least 0.50 USDT.",
  ],
};

const N = "(\\d+(?:\\.\\d+)?)";

/** key -> [pattern, [capture groups, one per key it fills]] applied to a given text pool */
function patterns(agent: HireAgent): readonly { re: RegExp; keys: readonly string[] }[] {
  if (agent === "agentic-dca") {
    return [
      { re: new RegExp(`Base order at least ${N} USDT`), keys: ["baseMin"] },
      { re: new RegExp(`each DCA order at least ${N} USDT`), keys: ["orderMin"] },
      { re: new RegExp(`max DCA orders ${N} to ${N}`), keys: ["maxOrdersLow", "maxOrders"] },
      { re: new RegExp(`Price drop step ${N} to ${N} ?%`), keys: ["stepMin", "stepMax"] },
      { re: new RegExp(`Take profit at least ${N} ?%`), keys: ["tpMin"] },
      { re: new RegExp(`${N} BNB per transaction slot`), keys: ["bnbPerSlot"] },
      { re: new RegExp(`plus ${N} USDT \\(7-day term\\) or ${N} USDT \\(30-day term\\)`), keys: ["keepAlive7", "keepAlive30"] },
      { re: new RegExp(`at least ${N} DCA orders`), keys: ["earnMinOrders"] },
      { re: new RegExp(`Daily limit of at least ${N} x the capital`), keys: ["dailyMultiple"] },
      { re: new RegExp(`x402 daily limit of at least ${N} USDT`, "i"), keys: ["x402Daily"] },
    ];
  }
  if (agent === "agentic-schedule") {
    return [
      { re: new RegExp(`amount per buy of at least ${N} USDT`), keys: ["buyMin"] },
      { re: new RegExp(`plus a ${N} ?% fee reserve`), keys: ["reservePct"] },
      { re: new RegExp(`1 to ${N} runs`), keys: ["runsMax"] },
      { re: new RegExp(`${N} BNB per transaction slot`), keys: ["bnbPerSlot"] },
      { re: new RegExp(`Daily limit of at least ${N} x the capital`), keys: ["dailyMultiple"] },
    ];
  }
  return [
    { re: new RegExp(`${N} to ${N} stocks from`), keys: ["stocksMin", "stocksMax"] },
    { re: new RegExp(`each at least ${N} ?%`), keys: ["weightMin"] },
    { re: new RegExp(`at least ${N} USDT for ${N} stocks plus ${N} USDT for each extra stock`), keys: ["capBase", "capBaseStocks", "capPerExtra"] },
    { re: new RegExp(`drift exceeds ${N} to ${N} ?% \\(steps of ${N} ?%\\)`), keys: ["driftMin", "driftMax", "driftStep"] },
    { re: new RegExp(`${N} BNB per transaction slot`), keys: ["bnbPerSlot"] },
    { re: new RegExp(`plus ${N} USDT \\(7-day term\\) or ${N} USDT \\(30-day term\\)`), keys: ["keepAlive7", "keepAlive30"] },
    { re: new RegExp(`Daily limit of at least ${N} x the capital`), keys: ["dailyMultiple"] },
    { re: new RegExp(`x402 daily limit of at least ${N} USDT`, "i"), keys: ["x402Daily"] },
  ];
}

function strings(v: Json): string[] {
  return (arr(v) ?? []).map((x) => str(x)).filter((x): x is string => x !== null);
}

/** "1 hour, 4 hours, Daily" or "4h, 8h, Daily" to hours. */
function parseHours(list: string): number[] {
  const hours: number[] = [];
  for (const item of list.split(",")) {
    const t = item.trim().toLowerCase();
    const hm = /^(\d+) ?(?:hours?|h)$/.exec(t);
    if (hm !== null) hours.push(Number(hm[1]));
    else if (t === "daily") hours.push(24);
  }
  return hours;
}

export function readHireLimits(agent: HireAgent, data: Json): HireLimits {
  const specs = agent === "agentic-dca" ? DCA : agent === "agentic-schedule" ? SCHEDULE : PORTFOLIO;
  const settings = strings(at(data, "requirements", "settings"));
  const funding = [str(at(data, "requirements", "funding", "usdt")), str(at(data, "requirements", "funding", "bnb"))].filter((x): x is string => x !== null);
  const binanceRaw = strings(at(data, "requirements", "binanceApp")).map((l) => safeText(l, 160)).filter((l) => l !== "");
  const earnNote = str(at(data, "earn", "note"));
  const pool = [...settings, ...funding, ...binanceRaw, ...(earnNote === null ? [] : [earnNote])];
  const found: Record<string, number> = {};
  for (const { re, keys } of patterns(agent)) {
    for (const line of pool) {
      const m = re.exec(line);
      if (m === null) continue;
      keys.forEach((k, i) => {
        const v = Number(m[i + 1]);
        if (Number.isFinite(v)) found[k] = v;
      });
      break;
    }
  }
  const values: Record<string, number> = {};
  const fromLink: string[] = [];
  const builtIn: string[] = [];
  for (const s of specs) {
    const v = found[s.key];
    if (v !== undefined && v >= s.min && v <= s.max && (s.int !== true || Number.isInteger(v))) {
      values[s.key] = v;
      fromLink.push(s.key);
    } else {
      values[s.key] = s.fallback;
      builtIn.push(s.key);
    }
  }

  let stocks: string[] | null = null;
  if (agent !== "agentic-schedule") {
    for (const line of settings) {
      const m = /stocks[^:]*: ([A-Z0-9, ]+)\./.exec(line);
      if (m !== null) {
        const list = (m[1] as string).split(",").map((x) => x.trim()).filter((x) => /^[A-Z0-9]{2,12}$/.test(x));
        if (list.length >= 2 && list.length <= 60) {
          stocks = list;
          break;
        }
      }
    }
    if (stocks === null) {
      stocks = [...BUILT_IN_STOCKS];
      builtIn.push("stocks");
    } else {
      fromLink.push("stocks");
    }
  }

  let intervalsHours: number[] | null = null;
  if (agent === "agentic-schedule") {
    for (const line of settings) {
      const m = /Frequency: ([^.]+)\./.exec(line);
      if (m === null) continue;
      const hours = parseHours(m[1] as string);
      if (hours.length >= 2) intervalsHours = hours;
      break;
    }
    if (intervalsHours === null) {
      intervalsHours = [1, 4, 8, 12, 24];
      builtIn.push("intervals");
    } else {
      fromLink.push("intervals");
    }
  }

  if (agent === "agentic-portfolio") {
    for (const line of settings) {
      const m = /checked every ([^.]+)\./.exec(line);
      if (m !== null) {
        const hours = parseHours(m[1] as string);
        if (hours.length >= 2) intervalsHours = hours;
        break;
      }
    }
    if (intervalsHours === null) {
      intervalsHours = [4, 8, 12, 24];
      builtIn.push("checkIntervals");
    } else {
      fromLink.push("checkIntervals");
    }
  }

  const url = str(at(data, "deployUrl"));
  const deployUrl = url !== null && url.startsWith(DEPLOY_ORIGIN) && /^[\x21-\x7e]+$/.test(url) ? url : DEFAULT_DEPLOY_URL;
  const status = str(at(data, "status"));
  let binanceApp = binanceRaw;
  if (binanceApp.length === 0) {
    binanceApp = [...BUILT_IN_BINANCE_APP[agent]];
    builtIn.push("binanceApp");
  } else {
    fromLink.push("binanceApp");
  }
  return { agent, available: status === "available", deployUrl, stocks, values, intervalsHours, binanceApp, fromLink, builtIn };
}

/** Built-in limits, used when the live answer cannot be read at all. */
export function builtInHireLimits(agent: HireAgent): HireLimits {
  return readHireLimits(agent, null);
}
