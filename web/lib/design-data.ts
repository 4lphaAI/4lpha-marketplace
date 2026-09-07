/* Ported verbatim from the Claude Design export (ui_kits/marketplace/data.js).
   Only the trailing `Object.assign(window, ...)` was replaced by ES exports. */

export interface AgentMetric { label: string; value: string; tone?: string; note?: string }
export interface AgentActivity { title: string; detail: string; time: string; txHash?: string; icon?: string; tone?: string }

/** One catalogue agent. Everything past id/name is optional because the design own
    data set fills only what each card needs. */
export interface Agent {
  id: string;
  name: string;
  categoryId: string;
  protocol: string;
  tier: string;
  status: string;
  tagline: string;
  /** Picks the animated explainer the detail page renders for this agent. */
  explainer?: string;
  /** Extra venue logos rendered beside the protocol logo on the card meta row. */
  relatedProtocols?: string[];
  venues?: string[];
  metricValue: string;
  metricTone?: string;
  metricLabel?: string;
  hiredCount: number;
  price: string;
  priceUnit: string;
  pair?: string;
  dailyCap?: string;
  series?: number[];
  metrics?: AgentMetric[];
  activity?: AgentActivity[];
  statusLine?: string;
  disabled?: boolean;
}

/** Public deploy route for the hire action on marketplace and detail cards. */
export function agentDeployKind(agent: Pick<Agent, "categoryId">): "grid" | "trading" | "lp" | "lending" {
  if (agent.categoryId === "grid") return "grid";
  if (agent.categoryId === "trading") return "trading";
  if (agent.categoryId === "lp") return "lp";
  return "lending";
}

/** A hired-agent overlay, merged over the catalogue Agent by route. */
export interface HiredAgent {
  id: string;
  value: string;
  valueTone?: string;
  valueSub: string;
  status?: string;
  warning?: boolean;
  statusLine?: string;
}

export const AGENTS: Agent[] = [
  { id: "grid-keeper", name: "Grid Keeper", categoryId: "grid", protocol: "PancakeSwap v3", tier: "verified", status: "live",
    tagline: "A wider, slower grid for people who trade less often.",
    metricValue: "+18.2%", metricTone: "profit", hiredCount: 412, price: "$12", priceUnit: "per month",
    pair: "BNB / USDT", dailyCap: "500 USDT", series: [0,18,12,44,38,70,96,88,132,160,151,190,214,240,284],
    metrics: [
      { label: "30d PnL", value: "+18.2%", tone: "profit", note: "net of fees" },
      { label: "Trades / week", value: "126", note: "median 18 per day" },
      { label: "Max drawdown", value: "-4.1%", tone: "loss", note: "worst 30d window" },
      { label: "Running since", value: "412d", note: "no manual stops" },
    ],
    activity: [
      { title: "Bought 0.42 BNB at grid level 3", detail: "Filled at $612.40 · fee $0.18", time: "4m ago", txHash: "0x8f2a…c41", icon: "activate", tone: "live" },
      { title: "Sold 0.31 BNB at grid level 6", detail: "Filled at $631.10 · realized +$5.82", time: "22m ago", txHash: "0x4b71…9de", icon: "payment", tone: "live" },
      { title: "Refilled the buy ladder", detail: "12 levels armed between $598 and $624", time: "1h ago", txHash: "0x22cd…f04", icon: "grid-trading" },
      { title: "Skipped a trade", detail: "Slippage above your 0.75% limit", time: "3h ago", icon: "revoke", tone: "danger" },
    ],
    statusLine: "12 buy levels armed · BNB/USDT" },
  { id: "ladder-bnb", name: "Ladder BNB", categoryId: "grid", protocol: "PancakeSwap v3", tier: "verified", status: "live",
    tagline: "Places a ladder of buy and sell orders around $BNB.",
    metricValue: "+6.4%", metricTone: "profit", hiredCount: 128, price: "$9", priceUnit: "per month" },
  { id: "range-pilot", name: "Range Pilot", categoryId: "lp", protocol: "PancakeSwap v3", tier: "verified", status: "live",
    tagline: "Moves your liquidity back into range when the price drifts away.",
    metricValue: "+$412 vs -$96 IL", metricTone: "profit", hiredCount: 96, price: "0.8%", priceUnit: "performance fee",
    statusLine: "In range · $598 – $648 · rebalanced 2h ago" },
  { id: "aegis-lp", name: "Aegis LP", categoryId: "lp", protocol: "PancakeSwap v3", tier: "registry", status: "paused", explainer: "compound",
    tagline: "Collects fees earns and adds them back into the same position.",
    metricValue: "+$180 vs -$40 IL", metricTone: "profit", hiredCount: 64, price: "1.0%", priceUnit: "performance fee" },
  { id: "yield-router", name: "Sigma Trader", categoryId: "trading", protocol: "PancakeSwap v3", relatedProtocols: ["fourmeme", "flapsh", "bstocks"],
    tier: "verified", status: "live", explainer: "trade",
    tagline: "Machine learning find Runner on Four.meme, Flap.sh & bStocks.",
    metricValue: "14.2%", metricTone: "profit", hiredCount: 289, price: "10%", priceUnit: "of profit",
    pair: "BNB / USDT", dailyCap: "500 USDT",
    metrics: [
      { label: "30d PnL", value: "+14.2%", tone: "profit", note: "net of fees" },
      { label: "Trades / week", value: "48", note: "median 7 per day" },
      { label: "Win rate", value: "64%", note: "38 trades" },
      { label: "Fee", value: "10%", note: "of profit" },
    ],
    statusLine: "2 of 3 positions open · last entry 41m ago" },
  { id: "vector-trader", name: "Vector Trader", categoryId: "trading", protocol: "PancakeSwap v3", relatedProtocols: ["fourmeme", "flapsh"],
    tier: "verified", status: "live", explainer: "trade",
    tagline: "Targets $10M–$1B markets with filters.",
    metricValue: "14.2%", metricTone: "profit", hiredCount: 156, price: "0 Fees", priceUnit: "this month" },
  { id: "degen-trader", name: "Degen Trader", categoryId: "trading", protocol: "PancakeSwap v3", relatedProtocols: ["fourmeme", "flapsh"],
    tier: "verified", status: "live", explainer: "trade",
    tagline: "Hunts runners from Four.meme & Flap.sh.",
    metricValue: "14.2%", metricTone: "profit", hiredCount: 89, price: "0 Fees", priceUnit: "this month" },
  { id: "atlas-trader", name: "Atlas Trader", categoryId: "trading", protocol: "PancakeSwap v3", relatedProtocols: ["bstocks"],
    tier: "verified", status: "live", explainer: "trade",
    tagline: "Trades established $1B+ tokens and bStocks with filters.",
    metricValue: "14.2%", metricTone: "profit", hiredCount: 203, price: "0 Fees", priceUnit: "this month" },
  { id: "health-guard", name: "Health Guard", categoryId: "health", protocol: "Venus", tier: "verified", status: "warning", explainer: "lending",
    tagline: "Watches your Venus health factor & avoid liquidated.",
    metricValue: "37", metricTone: "flat", metricLabel: "POSITIONS SAVED", hiredCount: 1204, price: "$8", priceUnit: "per month",
    statusLine: "Repaying 240 USDT — health factor hit 1.18" },
];

export const HIRED: HiredAgent[] = [
  { id: "grid-keeper", value: "+$284.10", valueSub: "since 12 Jun", status: "live" },
  { id: "health-guard", value: "+$0.00", valueTone: "flat", valueSub: "guarding $3,100", warning: true },
  { id: "range-pilot", value: "-$18.20", valueSub: "14 d", status: "paused", statusLine: "Paused by you · position left in range" },
];

export const SORTS: string[] = ["Most hired", "Best 30d PnL", "Newest", "Lowest fee"];
