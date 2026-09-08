// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its ~20 inline sub-components would each need a hand-written prop
// interface; annotating them would mean editing the very markup this port exists
// to preserve. Type safety stops at this boundary: KitApp, KitHeader, the design
// system declarations and lib/ are all fully checked.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/DeployAgentScreen.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxies and the window globals became real imports/exports. */
import React from "react";
import { LiquidityChart } from "@/components/lp/LiquidityChart";
import { SwaplessExplainer } from "@/components/explainers/SwaplessExplainer";
import { RangeExplainer } from "@/components/explainers/RangeExplainer";
import { CompoundExplainer } from "@/components/explainers/CompoundExplainer";
import { Button, Checkbox, Icon, Input, SegmentedToggle, Select } from "@/design-system";
import { RESOURCES } from "@/lib/design-resources";
import { LivePoolSection, UI_PRESET_TO_GEOMETRY } from "@/components/deploy/GridLiveDeploy";
import { gridCapitalFloorBnb } from "@/lib/grid/economics";
import { HireGridDeploy } from "@/components/deploy/HireGridDeploy";
import { HireLpDeploy } from "@/components/deploy/HireLpDeploy";
import { HireTradeDeploy } from "@/components/deploy/HireTradeDeploy";
import { DemoTradeDeploy } from "@/components/deploy/DemoTradeDeploy";
import { DemoAgentPanel } from "@/components/demo/DemoAgentPanel";
import { HireLendingDeploy } from "@/components/deploy/HireLendingDeploy";
import { GuardedAccountSection } from "@/components/deploy/GuardedAccountSection";
import { lendingControlNumber } from "@/lib/lending/form";
import { TradeModelSelect } from "@/components/deploy/TradeModelSelect";
import { MAX_INSTRUCTIONS_ENCODED_BYTES,
  MIN_TRADE_CAPITAL_WEI, MIN_TRADE_ENTRY_WEI, checkBoundedText,
  parseBnbToWei, type TradeSettings, validateSkillMarkdown,
  TRADE_LLM_MODELS, stopLossBpsWhenEnabled, stopLossPercentFromBps, tradeModelId } from "@/lib/trade";
import { MAX_RANGE_WIDTH_TICKS, derivedRangeTicks, formatPrice, livePriceInsideBand, poolQuote, priceFromTick, rangeWidthPct, snapTickDown, snapTickUp } from "@/lib/lp/range";

const WORDS = [
  { word: "Trading", color: "var(--cat-yield)" },
  { word: "LPing", color: "var(--cat-lp)" },
  { word: "Lending", color: "var(--cat-health)" },
];

const KINDS = [
  { id: "grid", label: "Grid Agent", icon: "grid-trading", color: "var(--cat-grid)", tint: "var(--cat-grid-tint)",
    venues: { demo: [{ label: "PancakeSwap", asset: "/design/protocols/pancakeswap.png" }], live: [{ label: "PancakeSwap", asset: "/design/protocols/pancakeswap.png" }] },
    blurb: "Automated grid market making that buys low and sells high as market price moves.",
    simLabel: "Backtest window", simNote: "Replays the ladder against historical pair data before any capital moves." },
  { id: "trading", label: "Trading Agent", icon: "yield", color: "var(--cat-yield)", tint: "var(--cat-yield-tint)",
    venues: { demo: [
      { label: "Four.meme", asset: "/design/protocols/fourmeme.png" },
      { label: "Flap.sh", asset: "/design/protocols/flapsh.png" },
      { label: "bStocks", asset: "/design/protocols/bstocks.png" },
      { label: "PancakeSwap", asset: "/design/protocols/pancakeswap.png" },
    ], live: [{ label: "BNB Chain", asset: "/design/protocols/bnb-chain.png" }] },
    blurb: "Screens eligible markets, sizes entries, and automatically manages buys & exits 24/7.",
    simLabel: "Backtest window", simNote: "Replays the model against historical pair data before any capital moves." },
  { id: "lp", label: "LP Agent", icon: "lp-rebalance", color: "var(--cat-lp)", tint: "var(--cat-lp-tint)",
    venues: { demo: [{ label: "PancakeSwap", asset: "/design/protocols/pancakeswap.png" }], live: [{ label: "PancakeSwap", asset: "/design/protocols/pancakeswap.png" }] },
    blurb: "Routes liquidity to the best APR or fees with auto rebalance, compound & risk exits.",
    simLabel: "Backtest window", simNote: "Replays range, rebalance and fee behaviour over the selected pool history." },
  { id: "health", label: "Lending Agent", icon: "health-shield", color: "var(--cat-health)", tint: "var(--cat-health-tint)",
    venues: { demo: [{ label: "Venus", asset: "/design/protocols/venus.png" }], live: [{ label: "Venus", asset: "/design/protocols/venus.png" }] },
    blurb: "Monitors lending positions loan health and automatically repays before liquidation.",
    simLabel: "Stress window", simNote: "Replays the collateral drawdown of the window against your triggers." },
];

const GUIDE_LINKS = {
  grid: "https://docs.4lpha.tech/#grid",
  trading: "https://docs.4lpha.tech/#trading",
  lp: "https://docs.4lpha.tech/#lp",
  health: "https://docs.4lpha.tech/#lending",
};
const TUTORIAL_LINK = "https://www.youtube.com/watch?v=1uIeKGeg1no&list=PLOMsGmPsK-0Q";

// Every id here answers on the 0G router; the names the mock-up carried are
// other providers' and three of the old 0G product's answer HTTP 404.
const MODELS = TRADE_LLM_MODELS.map((model) => model.label);
const FALLBACKS = MODELS;
const LP_OPEN_WIDTH_TICKS = 1_000;

/* Execution models — quant-tuned starting defaults per asset tier / posture.
   Picking one overwrites the primary controls it lists in `set`. */
const PRESETS = {
  grid: [
    { id: "tight", label: "Tight Scalp", gap: "up to 0,45%", note: "Dense levels, highest fill rate.",
      set: { takeProfit: "3", stopLoss: "5" } },
    { id: "balanced", label: "Balanced", gap: "up to 0,90%", note: "Standard ladder for BNB pairs.",
      set: { takeProfit: "6", stopLoss: "10" } },
    { id: "wide", label: "Wide Band", gap: "up to 1,50%", note: "Fewer levels, lower churn.",
      set: { takeProfit: "12", stopLoss: "15" } },
    { id: "volatile", label: "High Volatility", gap: "up to 3,00%", note: "Wide band for thin pairs.",
      set: { takeProfit: "25", stopLoss: "25" } },
  ],
  trading: [
    { id: "midcap", label: "Mid-Cap", executionModel: "mid-cap", note: "$10M – $1B. Balanced entry gate and sizing",
      set: { confidence: "80", minMcap: "10,000,000", maxMcap: "1,000,000,000", perTrade: "0.02", capital: "0.02", tp1: "40", stopLoss: "25", holdTime: "1,440", maxPositions: "3" } },
    { id: "degen", label: "Degen", executionModel: "degen", note: "Runners under $1M selected from Four.meme and Flap.sh",
      set: { confidence: "75", minMcap: "", maxMcap: "1,000,000", perTrade: "0.01", capital: "0.02", tp1: "60", stopLoss: "35", holdTime: "480", maxPositions: "4" } },
    { id: "sigma", label: "Sigma", executionModel: "sigma", note: "Machine learning to spot daily runners by 4lpha",
      set: { confidence: "72", minMcap: "", maxMcap: "", perTrade: "0.005", capital: "0.02", tp1: "100", stopLoss: "50", holdTime: "120", maxPositions: "5" } },
  ],
  lp: [
    { id: "wide", label: "Sigma", note: "Machine learning to route liquidity for the highest available Fee & APR.",
      set: { capital: "0.1", routeBy: "fee", rebalanceOn: true, compoundOn: true, tpOn: true, tpPercent: "40", slOn: true, slPercent: "25", rebalanceMode: "Both ways", rebalanceCooldown: "5", rebalanceCooldownUnit: "mins", minFees: "10", primary: MODELS[0], fallback: MODELS[1] } },
    { id: "blue", label: "Custom", note: "Manually select a pool for the LP Agent to manage the position.",
      set: { capital: "0.02", rebalanceOn: true, compoundOn: true, tpOn: false, tpPercent: "40", slOn: false, slPercent: "25", rebalanceMode: "Both ways", rebalanceCooldown: "5", rebalanceCooldownUnit: "mins", minFees: "10", primary: MODELS[0], fallback: MODELS[1] } },
  ],
  // The thresholds are the OPERATOR's ruling of 2026-09-06 (spec §0.6 / OQ2):
  // 1.20 / 1.50, not the mock's 1.18 / 1.60. `checkEvery` is gone — the cadence
  // is the operator's boot config, never a control. Every value here clears the
  // plane's own bounds (trigger 1.05..3.0, target >= trigger + 0.05).
  health: [
    { id: "conservative", label: "Conservative", note: "Acts early, restores a large buffer.",
      set: { trigger: "1.35", target: "1.90", reservePct: "30" } },
    { id: "balanced", label: "Balanced", note: "Standard buffer for BNB collateral.",
      set: { trigger: "1.20", target: "1.50", reservePct: "20" } },
    { id: "aggressive", label: "Aggressive", note: "Keeps capital deployed, thinner margin of safety.",
      set: { trigger: "1.10", target: "1.35", reservePct: "15" } },
  ],
};

const DEFAULT_PRESET = { grid: "balanced", trading: "sigma", lp: "blue", health: "balanced" };

const CONFIG = {
  grid: [
    { title: "Agent", fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "Grid Agent 01" },
      { k: "capital", label: "Total capital", type: "stepper", v: "0.02", step: 0.01, min: 0.02, suffix: "BNB" },
    ] },
    { title: "Pool", fields: [
      { k: "pool", label: "Pool", type: "pool", v: "WBNB-USDT-001" },
    ] },
    { title: "Exit", fields: [
      { k: "tpOn", type: "hidden", v: false },
      { k: "takeProfit", label: "Take profit", type: "numToggle", on: "tpOn", v: "6", suffix: "%" },
      { k: "slOn", type: "hidden", v: false },
      { k: "stopLoss", label: "Stop loss", type: "numToggle", on: "slOn", v: "10", suffix: "%" },
    ] },
    { title: "Advanced settings", adv: true, fields: [
      { k: "gas", label: "Gas priority", type: "select", v: "Standard", options: ["Low", "Standard", "High"] },
      { k: "quicknode", label: "QuickNode RPC x402", type: "toggle", v: false, text: "Pay per request for faster reads", exclusiveWith: "customRpc" },
      { k: "customRpc", label: "Custom RPC", type: "toggle", v: false, text: "Use your own RPC endpoint", exclusiveWith: "quicknode", inputKey: "customRpcUrl", inputPlaceholder: "https://your-rpc-endpoint.com" },
    ] },
  ],
  trading: [
    { title: "Agent", fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "Trading Agent 01" },
      { k: "perTrade", label: "BNB per entry", type: "stepper", v: "0.005", step: 0.002, min: 0.005, suffix: "BNB" },
      { k: "capital", label: "Total capital", type: "stepper", v: "0.02", step: 0.01, min: 0.02, suffix: "BNB" },
      { k: "maxPositions", label: "Max open positions", type: "stepper", v: "3", step: 1, min: 1 },
    ] },
    { title: "Entry filter", fields: [
      { k: "minMcap", label: "Min market cap", type: "num", v: "", prefix: "$", lockedByPreset: ["sigma"] },
      { k: "maxMcap", label: "Max market cap", type: "num", v: "", prefix: "$", hint: "Leave empty for no ceiling.", lockedByPreset: ["sigma"] },
      { k: "noReentry", label: "check", type: "check", v: true, text: "No re-entry" },
    ] },
    { title: "Exit (if you do not make a choice, the LLM model will decide)", fields: [
      { k: "tp1On", type: "hidden", v: true },
      { k: "tp1", label: "Take profit", type: "numToggle", on: "tp1On", v: "100", suffix: "%", step: 5, min: 0 },
      { k: "stopLossOn", type: "hidden", v: true },
      { k: "stopLoss", label: "Stop loss", type: "numToggle", on: "stopLossOn", v: "50", suffix: "%", step: 5, min: 0, max: 100 },
      { k: "holdTime", label: "Max holding time", type: "num", v: "480", suffix: "min", alignAsCheckbox: true, step: 60, noLimitAtMin: true },
      { k: "moonbag", label: "check", type: "check", v: true, text: "Move the stop to break-even after the last take-profit target fills." },
    ] },
    { title: "Risk and execution", poweredBy: "0g", fields: [
      { k: "slippage", label: "Slippage tolerance", type: "stepper", v: "3", step: 0.5, min: 0.5, max: 5, suffix: "%", hint: "Between 0.5% and 5%." },
      { k: "gas", label: "Gas priority", type: "select", v: "Standard", options: ["Low", "Standard", "High"] },
      { k: "primary", label: "Primary model", type: "select", v: MODELS[0], options: MODELS, excludeValueOf: "fallback", showDisabledOption: true },
      { k: "fallback", label: "Fallback model", type: "select", v: MODELS[1], options: FALLBACKS, excludeValueOf: "primary", showDisabledOption: true },
    ] },
    { title: "Advanced settings", adv: true, note: "Pay-per-call data feeds and optional trading guidance. These never override wallet controls, slippage, stop-loss, or rug protection.", fields: [
      { k: "quicknode", label: "QuickNode RPC x402", type: "toggle", v: false, text: "Pay per request for faster reads", exclusiveWith: "customRpc" },
      { k: "customRpc", label: "Custom RPC", type: "toggle", v: false, text: "Use your own RPC endpoint", exclusiveWith: "quicknode", inputKey: "customRpcUrl", inputPlaceholder: "https://your-rpc-endpoint.com" },
      { k: "cmcHub", label: "CMC Agent Hub x402", type: "toggle", v: false, text: "Pay per request for CoinMarketCap agent data" },
      { k: "instructions", label: "Instructions", type: "textarea", v: "", byteLimit: MAX_INSTRUCTIONS_ENCODED_BYTES, placeholder: "Example: Prefer clean momentum reclaims with confirming volume. Avoid chasing vertical candles after the first impulse.", hint: "Soft preference layer only. Use plain English or Chinese to describe the setups this agent should favor or avoid. This is applied during entry timing only." },
      { k: "skillFile", label: "Add Skill", type: "skillFile", v: null },
    ] },
  ],
  lp: [
    { title: "Agent", fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "LP Agent 01" },
      { k: "capital", label: "Total capital", type: "stepper", v: "0.1", step: 0.01, min: 0.02, suffix: "BNB" },
    ] },
    { title: "Entry filter", fields: [
      { k: "routeBy", type: "radioCheck", value: "fee", v: "fee", text: "Highest fee" },
      { k: "routeBy", type: "radioCheck", value: "volume", v: "fee", text: "Highest volume" },
    ] },
    { title: "Position management", fields: [
      { k: "rebalanceOn", type: "hidden", v: true },
      { k: "compoundOn", type: "hidden", v: true },
      { k: "tpOn", type: "hidden", v: true },
      { k: "slOn", type: "hidden", v: true },
      { k: "rebalanceMode", type: "hidden", v: "Both ways" },
      { k: "rebalanceCooldown", type: "hidden", v: "5" },
      { k: "rebalanceCooldownUnit", type: "hidden", v: "mins" },
      { k: "minFees", type: "hidden", v: "10" },
      { k: "tpPercent", type: "hidden", v: "40" },
      { k: "slPercent", type: "hidden", v: "25" },
      { k: "modeRowsUI", type: "modeRows", v: null },
    ] },
    { title: "Risk and execution", poweredBy: "0g", fields: [
      { k: "primary", label: "Primary model", type: "select", v: MODELS[0], options: MODELS, excludeValueOf: "fallback", showDisabledOption: true },
      { k: "fallback", label: "Fallback model", type: "select", v: MODELS[1], options: FALLBACKS, excludeValueOf: "primary", showDisabledOption: true },
    ] },
    { title: "Advanced settings", adv: true, note: "Advisory range-management guidance only. These never override wallet controls, stop-loss, or the range fence.", fields: [
      { k: "instructions", label: "Instructions", type: "textarea", v: "", byteLimit: MAX_INSTRUCTIONS_ENCODED_BYTES, placeholder: "Example: Prefer pools with rising volume and tightening spreads. Avoid rebalancing during the first 10 minutes after a listing.", hint: "Soft preference layer only. Use plain English or Chinese to describe how this agent should manage the position." },
      { k: "skillFile", label: "Add Skill", type: "skillFile", v: null },
    ] },
  ],
  lpCustom: [
    { title: "Agent", fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "LP Agent 01" },
      { k: "capital", label: "Total capital", type: "stepper", v: "0.02", step: 0.01, min: 0.02, suffix: "BNB" },
    ] },
    { title: "Pool", fields: [
      { k: "pool", label: "Pool", type: "pool", v: "WBNB-USDT-001" },
    ] },
    { title: "", fields: [
      { k: "liquidityChart", type: "liquidityChart", v: null },
    ] },
    { title: "Price range", fields: [
      { k: "minPrice", type: "hidden", v: "598.40" },
      { k: "maxPrice", type: "hidden", v: "648.10" },
      { k: "lpCurrentTick", type: "hidden", v: null },
      { k: "lpCurrentPrice", type: "hidden", v: null },
      { k: "lpTickSpacing", type: "hidden", v: null },
      { k: "lpWbnbIsToken0", type: "hidden", v: null },
      { k: "lpRangeReady", type: "hidden", v: false },
      { k: "lpRangeReason", type: "hidden", v: "Select a pool" },
      { k: "priceRangeUI", type: "priceRangeGroup", v: null },
    ] },
    { title: "Position management", fields: [
      { k: "rebalanceOn", type: "hidden", v: true },
      { k: "compoundOn", type: "hidden", v: true },
      { k: "tpOn", type: "hidden", v: false },
      { k: "slOn", type: "hidden", v: false },
      { k: "rebalanceMode", type: "hidden", v: "Both ways" },
      { k: "rebalanceCooldown", type: "hidden", v: "5" },
      { k: "rebalanceCooldownUnit", type: "hidden", v: "mins" },
      { k: "minFees", type: "hidden", v: "10" },
      { k: "tpPercent", type: "hidden", v: "20" },
      { k: "slPercent", type: "hidden", v: "15" },
      { k: "modeRowsUI", type: "modeRows", v: null },
    ] },
    { title: "Risk and execution", poweredBy: "0g", fields: [
      { k: "primary", label: "Primary model", type: "select", v: MODELS[0], options: MODELS, excludeValueOf: "fallback", showDisabledOption: true },
      { k: "fallback", label: "Fallback model", type: "select", v: MODELS[1], options: FALLBACKS, excludeValueOf: "primary", showDisabledOption: true },
    ] },
    { title: "Advanced settings", adv: true, note: "Advisory range-management guidance only. These never override wallet controls, stop-loss, or the range fence.", fields: [
      { k: "instructions", label: "Instructions", type: "textarea", v: "", byteLimit: MAX_INSTRUCTIONS_ENCODED_BYTES, placeholder: "Example: Widen the range ahead of scheduled unlocks. Avoid rebalancing during the first 10 minutes after a listing.", hint: "Soft preference layer only. Use plain English or Chinese to describe how this agent should manage the position." },
      { k: "skillFile", label: "Add Skill", type: "skillFile", v: null },
    ] },
  ],
  /*
   * MARKETPLACE-LENDING-AGENT §2.1 as amended by R2.17 — every control here maps
   * to a wire field the owner SIGNS, and §2.2's removals render NOTHING: gas
   * priority, slippage (the saga rail is the plane's, not the owner's), the
   * alerts checkbox (no notification channel exists), the oracle deviation guard
   * (the plane already reproduces the protocol's deviation-bounded prices and
   * refuses `protocol-mismatch`), max gas price, the flash-loan checkbox, Lista,
   * and the collateral/debt asset pickers (the CHAIN says what the guarded
   * account holds — the owner does not choose).
   *
   * "Lending market", "Repay from", "Check every" and "Daily repay limit
   * (derived)" are read-only text and are rendered by `HireLendingDeploy`, not
   * as fields: none of them is a choice, and a select the owner cannot change is
   * a lie about what they control.
   */
  health: [
    { title: "Agent", fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "Lending Agent 01" },
      { k: "capital", label: "Total capital", type: "stepper", v: "0.05", step: 0.01, min: 0.01, suffix: "BNB" },
    ] },
    { title: "Guarded account", fields: [
      { k: "guarded", type: "hidden", v: null },
    ] },
    { title: "Triggers", fields: [
      { k: "trigger", label: "Act below health factor", type: "num", v: "1.20" },
      { k: "target", label: "Restore health factor to", type: "num", v: "1.50" },
      { k: "reservePct", label: "Reserve kept as BNB", type: "stepper", v: "20", step: 5, min: 10, max: 50, floor: 10, suffix: "%",
        hint: "The rest is swapped to USDT and supplied to Venus." },
    ] },
    { title: "Repair", fields: [
      { k: "maxRepay", label: "Max repay per event", type: "stepper", v: "", prefix: "$", step: 1, min: 0.000001, floor: 0.000001, preciseStep: true },
      { k: "rescueCount", label: "Rescues to reserve gas for", type: "stepper", v: "6", step: 1, min: 1, max: 24, floor: 1,
        hint: "The guard will still rescue beyond this — refusing a rescue is the trap it exists to avoid." },
      { k: "cooldown", label: "Cooldown between repays", type: "stepper", v: "300", step: 60, min: 300, max: 86400, floor: 300, suffix: "sec" },
    ] },
  ],
};

function sectionsFor(kind, presetId) {
  if (kind === "lp") return presetId === "blue" ? CONFIG.lpCustom : CONFIG.lp;
  return CONFIG[kind];
}

function defaults(kind, presetId) {
  const pid = presetId || DEFAULT_PRESET[kind];
  const out = {};
  sectionsFor(kind, pid).forEach((s) => s.fields.forEach((f) => { out[f.k] = f.v; }));
  const p = PRESETS[kind].find((x) => x.id === pid);
  return p ? { ...out, ...p.set } : out;
}

function decimalOrNull(value) {
  const normalized = String(value ?? "").replace(/,/gu, "").trim();
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function weiToBnb(value) {
  const wei = BigInt(value);
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString(10).padStart(18, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/* Deterministic sandbox results so the panel reads like a real readout. */
const SIM = {
  grid: [
    { pnl: "+8.7%", win: "78%", dd: "-3.4%", n: "64 fills" },
    { pnl: "+14.1%", win: "71%", dd: "-6.8%", n: "182 fills" },
    { pnl: "+21.6%", win: "66%", dd: "-13.2%", n: "430 fills" },
    { pnl: "+17.3%", win: "58%", dd: "-19.5%", n: "96 fills" },
  ],
  trading: [
    { pnl: "+11.4%", win: "64%", dd: "-4.2%", n: "38 trades" },
    { pnl: "+18.9%", win: "58%", dd: "-8.7%", n: "96 trades" },
    { pnl: "+31.2%", win: "51%", dd: "-16.4%", n: "214 trades" },
    { pnl: "+47.6%", win: "39%", dd: "-33.1%", n: "512 trades" },
  ],
  lp: [
    { pnl: "+9.8%", win: "71%", dd: "-5.1%", n: "12 rebalances" },
    { pnl: "+22.3%", win: "63%", dd: "-11.9%", n: "184 rebalances" },
    { pnl: "+14.6%", win: "68%", dd: "-7.4%", n: "46 rebalances" },
    { pnl: "+19.1%", win: "57%", dd: "-14.2%", n: "88 rebalances" },
    { pnl: "+26.5%", win: "44%", dd: "-28.8%", n: "31 rebalances" },
  ],
  health: [
    { pnl: "0 liquidations", win: "1.41 min HF", dd: "-2.1%", n: "9 repays" },
    { pnl: "0 liquidations", win: "1.22 min HF", dd: "-5.6%", n: "4 repays" },
    { pnl: "1 liquidation", win: "1.02 min HF", dd: "-12.3%", n: "2 repays" },
  ],
};
const SIM_LABELS = {
  grid: ["Net PnL", "Levels filled both ways", "Max drawdown", "Activity"],
  trading: ["Net PnL", "Win rate", "Max drawdown", "Activity"],
  lp: ["Net PnL vs HODL", "Time in range", "Max drawdown", "Activity"],
  health: ["Outcome", "Lowest health factor", "Collateral drawdown", "Activity"],
};

const LONGEST = WORDS.reduce((a, b) => (b.word.length > a.length ? b.word : a), "");

const GLITCH_CHARS = "▚▓█/\\<>_=$#@%&*+ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CRT_CSS = `
@keyframes crt-flicker{0%,100%{opacity:1}42%{opacity:.92}44%{opacity:.62}46%{opacity:.97}72%{opacity:.85}74%{opacity:1}}
.crt-word{animation:crt-flicker 3.4s steps(1,end) infinite}
@media (prefers-reduced-motion:reduce){.crt-word{animation:none}}`;

function scramble(word) {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    out += Math.random() < 0.55 ? GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)] : word[i];
  }
  return out;
}

function RotatingWord() {
  const [idx, setIdx] = React.useState(0);
  const [text, setText] = React.useState(WORDS[0].word);
  const [shift, setShift] = React.useState(0);

  React.useEffect(() => {
    let frame = 0, raf = null, alive = true;
    const glitch = (next) => {
      frame = 0;
      const step = () => {
        if (!alive) return;
        frame += 1;
        if (frame <= 7) {
          setText(scramble(next));
          setShift((Math.random() - 0.5) * 6);
          raf = setTimeout(step, 55);
        } else {
          setText(next);
          setShift(0);
        }
      };
      step();
    };
    const cycle = setInterval(() => {
      setIdx((n) => {
        const next = (n + 1) % WORDS.length;
        glitch(WORDS[next].word);
        return next;
      });
    }, 2600);
    return () => { alive = false; clearInterval(cycle); clearTimeout(raf); };
  }, []);

  const color = WORDS[idx].color;
  return (
    <span style={{ position: "relative", display: "inline-block", whiteSpace: "nowrap", color: color, fontFamily: "var(--font-mono)" }}>
      <style>{CRT_CSS}</style>
      <span aria-hidden="true" style={{ visibility: "hidden" }}>{LONGEST}&nbsp;</span>
      <span className="crt-word" style={{ position: "absolute", left: 0, top: 0, textShadow: "0 0 10px currentColor", transform: `translateX(${shift}px)` }}>{text}</span>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, color: "#22d3ee", opacity: 0.35, mixBlendMode: "screen", transform: `translateX(${shift * -0.9 - 1}px)` }}>{text}</span>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, color: "#e5484d", opacity: 0.24, mixBlendMode: "screen", transform: `translateX(${shift * 0.9 + 1}px)` }}>{text}</span>
    </span>
  );
}

const POOLS = [
  { id: "WBNB-USDC-001", pair: "WBNB / USDC", addr: "0x85FA...C7B3", fee: "V3 | 0.01%", tvl: "$1.85M TVL", vol: "$16.2M 24H VOL", c: "#2775ca" },
  { id: "WBNB-USDT-001", pair: "WBNB / USDT", addr: "0x36696...1D0E", fee: "V3 | 0.01%", tvl: "$11.5M TVL", vol: "$66.1M 24H VOL", c: "#26a17b" },
  { id: "WBNB-USDT-005", pair: "WBNB / USDT", addr: "0x47a90...84FF", fee: "V3 | 0.05%", tvl: "$10.1M TVL", vol: "$8.79M 24H VOL", c: "#26a17b" },
  { id: "WBNB-USD1-005", pair: "WBNB / USD1", addr: "0x1B2C...9A41", fee: "V3 | 0.05%", tvl: "$2.35M TVL", vol: "$1.64M 24H VOL", c: "#d0a215" },
  { id: "WBNB-BTCB-005", pair: "WBNB / BTCB", addr: "0x6bBc...E5D2", fee: "V3 | 0.05%", tvl: "$25.2M TVL", vol: "$10.5M 24H VOL", c: "#f7931a" },
  { id: "WBNB-ETH-005", pair: "WBNB / ETH", addr: "0xD0e2...77Ac", fee: "V3 | 0.05%", tvl: "$14.9M TVL", vol: "$7.85M 24H VOL", c: "#8a92b2" },
  { id: "SOL-WBNB-005", pair: "SOL / WBNB", addr: "0xA2F4...31BD", fee: "V3 | 0.05%", tvl: "$1.26M TVL", vol: "$912K 24H VOL", c: "#9945ff" },
  { id: "CAKE-WBNB-005", pair: "Cake / WBNB", addr: "0x1338...B9c4", fee: "V3 | 0.05%", tvl: "$1.18M TVL", vol: "$2.35M 24H VOL", c: "#d1884f" },
];

function PoolDot({ color }) {
  return <span style={{ width: 26, height: 26, borderRadius: 999, background: color, opacity: 0.9, flex: "0 0 auto", border: "1px solid rgba(255,255,255,0.16)" }} />;
}

function PoolRow({ p, selected, onClick }) {
  return (
    <button type="button" onClick={onClick}
      style={{ cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "10px 14px", background: selected ? "var(--cat-grid-tint)" : "transparent", border: "none", borderRadius: "var(--radius-sm)" }}>
      <PoolDot color={p.c} />
      <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{p.pair}</span>
        <span style={{ font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-subtle)" }}>{p.addr} · {p.fee}</span>
      </span>
      <span style={{ marginLeft: "auto", display: "grid", gap: 3, textAlign: "right", flex: "0 0 auto" }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }}>{p.tvl}</span>
        <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{p.vol}</span>
      </span>
    </button>
  );
}

function PoolPicker({ value, onChange }) {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [custom, setCustom] = React.useState(null);
  const selected = custom && custom.id === value ? custom : POOLS.find((p) => p.id === value) || POOLS[1];
  const isAddr = /^0x[a-fA-F0-9]{6,}$/.test(q.trim());
  const list = POOLS.filter((p) => p.pair.toLowerCase().replace(/\s|\//g, "").includes(q.toLowerCase().replace(/\s|-|\//g, "")));

  const pick = (p) => { onChange(p.id); setOpen(false); setQ(""); };
  const useContract = () => {
    const a = q.trim();
    const p = { id: a, pair: "Custom pool", addr: a.slice(0, 6) + "..." + a.slice(-4), fee: "V3 | IMPORTED", tvl: "—", vol: "CONTRACT", c: "var(--cat-grid)" };
    setCustom(p); pick(p);
  };

  return (
    <div style={{ display: "grid", gap: 10, position: "relative" }}>
      <input value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        placeholder="Search pair (e.g. WBNB-USDT) or paste pool contract"
        style={{ width: "100%", padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: `1px solid ${open ? "var(--cat-grid)" : "var(--line-1)"}`, color: "var(--ink-1)", font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-sans)", outline: "none" }} />
      {open ? (
        <div style={{ background: "var(--surface-card)", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", padding: 8, display: "grid", gap: 2, maxHeight: 268, overflowY: "auto" }}>
          <span className="fl-eyebrow" style={{ padding: "4px 8px 6px" }}>{isAddr ? "Imported contract" : "Suggested pools"}</span>
          {isAddr ? (
            <button type="button" onClick={useContract}
              style={{ cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "transparent", border: "none", borderRadius: "var(--radius-sm)", color: "var(--cat-grid)", font: "var(--weight-medium) var(--text-sm)/1.3 var(--font-mono)" }}>
              Use {q.trim().slice(0, 10)}…{q.trim().slice(-6)}
            </button>
          ) : list.length ? list.map((p) => (
            <PoolRow key={p.id} p={p} selected={p.id === value} onClick={() => pick(p)} />
          )) : (
            <span style={{ padding: "10px 14px", font: "var(--weight-regular) var(--text-sm)/1.3 var(--font-sans)", color: "var(--text-subtle)" }}>No pool matches. Paste a pool contract address instead.</span>
          )}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--cat-grid)" }}>
        <PoolDot color={selected.c} />
        <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
          <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{selected.pair}</span>
          <span style={{ font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-subtle)" }}>{selected.addr} · {selected.fee}</span>
        </span>
        <span style={{ marginLeft: "auto", font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--cat-grid)", letterSpacing: "0.06em" }}>SELECTED</span>
      </div>
    </div>
  );
}

/** Zoom levels: bins PER SIDE the chart asks the plane for (route cap 1000). */

function NumStepper({ value, onChange, step = 1, min, max, prefix, suffix, noLimitAtMin, disabled, noClamp, preciseStep }) {
  const raw = value === "" || value == null ? null : parseFloat(String(value).replace(/,/g, ""));
  const round = (n) => Math.round(n / step) * step;
  const fmt = (n) => {
    if (n == null) return "No limit";
    const dp = String(step).includes(".") ? String(step).split(".")[1].length : 0;
    return dp ? n.toFixed(dp) : String(n);
  };
  const dec = () => {
    if (disabled || raw == null) return;
    const next = preciseStep ? Number((raw - step).toFixed(6)) : round(raw - step);
    if (preciseStep && min != null && next < min) return;
    if (noLimitAtMin && next < (min != null ? min : step)) { onChange(""); return; }
    onChange(String(min != null && next < min ? min : next));
  };
  const inc = () => {
    if (disabled) return;
    if (raw == null) { onChange(String(preciseStep ? step : min != null ? min : step)); return; }
    const next = preciseStep ? Number((raw + step).toFixed(6)) : round(raw + step);
    onChange(String(max != null && next > max ? max : next));
  };
  // `noClamp`: the caller shows the violation in red instead of silently
  // rewriting what the owner typed. The − button still stops AT the minimum, so
  // a floor cannot be stepped below, only typed below — and then it is refused.
  const below = !noClamp ? false : min != null && raw != null && raw < min;
  return (
    <div style={{ display: "flex", alignItems: "stretch", border: `1px solid ${below ? "var(--loss)" : "var(--line-1)"}`, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? "none" : "auto" }}>
      <button type="button" onClick={dec} aria-label="Decrease" disabled={disabled || (preciseStep && (raw == null || raw - step < (min ?? 0)))} style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", borderRight: "1px solid var(--line-1)", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>−</button>
      {prefix ? <span style={{ alignSelf: "center", paddingLeft: 12, color: "var(--text-subtle)" }}>{prefix}</span> : null}
      <input value={value == null ? "" : value} placeholder={noLimitAtMin ? "No limit" : undefined} onChange={(e) => onChange(e.target.value)}
        onBlur={() => { if (raw != null && !noClamp) { const clamped = min != null && raw < min ? min : max != null && raw > max ? max : raw; onChange(String(clamped)); } }}
        style={{ flex: 1, minWidth: 0, textAlign: "right", padding: "11px 12px", background: "transparent", border: "none", outline: "none", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: raw == null ? "var(--text-subtle)" : "var(--ink-1)" }} />
      {suffix && raw != null ? <span style={{ display: "flex", alignItems: "center", paddingRight: 12, font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{suffix}</span> : null}
      <button type="button" onClick={inc} aria-label="Increase" style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", borderLeft: "1px solid var(--line-1)", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>+</button>
    </div>
  );
}

/**
 * The pool geometry the range controls work in: orientation (quote per base),
 * the live tick and spacing. `null` until `/api/pool-state` has answered for
 * the selected pool.
 */
function lpRangeGeometry(values) {
  if (values.lpRangeReady !== true) return null;
  const spacing = Number(values.lpTickSpacing ?? 0);
  const currentTick = Number(values.lpCurrentTick ?? 0);
  if (!Number.isInteger(spacing) || spacing <= 0 || !Number.isInteger(currentTick)) return null;
  // BAND orientation: what the typed prices and the signature are expressed in.
  const orientation = { quoteIsToken0: values.lpQuoteIsToken0 === true };
  const quoteSymbol = String(values.lpQuoteSymbol ?? "");
  const baseSymbol = String(values.lpBaseSymbol ?? "");
  // DISPLAY orientation: the band's, or its reverse while the flip is on.
  const flipped = values.lpDisplayFlipped === true;
  const display = flipped
    ? { quoteIsToken0: !orientation.quoteIsToken0, quoteSymbol: baseSymbol, baseSymbol: quoteSymbol }
    : { quoteIsToken0: orientation.quoteIsToken0, quoteSymbol, baseSymbol };
  return {
    orientation,
    display,
    flipped,
    spacing,
    currentTick,
    currentPrice: Number(values.lpCurrentPrice ?? 0),
    quoteSymbol,
    baseSymbol,
  };
}

function parsePrice(value) {
  const num = parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * THE range the form will sign, from the two typed prices: `derivedRangeTicks`
 * is the same outward snap `explicitRangeFromPrices` performs, so the labels,
 * the "Signed range" line, the chart's bins and the signature agree to the
 * tick. Null while either price is unusable or the pair is inverted.
 */
function derivedRange(values, geometry) {
  const minPrice = parsePrice(values.minPrice);
  const maxPrice = parsePrice(values.maxPrice);
  if (minPrice === null || maxPrice === null) return null;
  return derivedRangeTicks({ ...geometry.orientation, minPrice, maxPrice, tickSpacing: geometry.spacing });
}

/**
 * One price bound, shown in the DISPLAY orientation. The authoritative band
 * lives in `values.minPrice/maxPrice` in the BAND orientation and is what the
 * signature derives from; flipping the display never rewrites it (fix review 2,
 * finding 1). Editing while flipped hands the typed number to the field, which
 * re-expresses the band in the display orientation exactly once — the same
 * single rounding any fresh edit carries. The −/+ buttons move ONE TICK SPACING
 * in tick space, which is orientation-free.
 */
function PriceRangeBox({ label, displayValue, onDisplayChange, onTickStep, geometry, signedTick }) {
  const num = parsePrice(displayValue);
  const valid = num !== null;
  const displayCurrent = priceFromTick(geometry.currentTick, geometry.display);
  const pct = valid ? ((num - displayCurrent) / displayCurrent) * 100 : 0;
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
  const stepBy = (bins) => {
    // With no derivable bound yet, start from the spacing multiple at or below the live tick.
    const base = signedTick ?? Math.floor(geometry.currentTick / geometry.spacing) * geometry.spacing;
    const priceUp = priceFromTick(base + geometry.spacing, geometry.display) > priceFromTick(base, geometry.display);
    onTickStep(base + (priceUp ? bins : -bins) * geometry.spacing);
  };
  return (
    <div style={{ display: "grid", gap: 8 }} data-price-box={label} data-signed-tick={signedTick ?? ""}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="fl-eyebrow">{label}</span>
      </div>
      <div style={{ display: "flex", alignItems: "stretch", border: `1px solid ${valid ? "var(--line-1)" : "var(--loss)"}`, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)" }}>
        <button type="button" onClick={() => stepBy(-1)} aria-label={`Decrease ${label}`} style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", borderRight: "1px solid var(--line-1)", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>−</button>
        <input value={displayValue == null ? "" : displayValue} onChange={(e) => onDisplayChange(e.target.value)} inputMode="decimal"
          style={{ flex: 1, minWidth: 0, textAlign: "right", padding: "11px 12px", background: "transparent", border: "none", outline: "none", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }} />
        <span style={{ display: "flex", alignItems: "center", paddingRight: 12, font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{geometry.display.quoteSymbol}</span>
        <button type="button" onClick={() => stepBy(1)} aria-label={`Increase ${label}`} style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", borderLeft: "1px solid var(--line-1)", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>+</button>
      </div>
      <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: !valid ? "var(--loss)" : pct >= 0 ? "var(--profit, #4ade80)" : "var(--loss)" }}>{valid ? pctStr : "Enter a positive price"}</span>
    </div>
  );
}

/**
 * The form's refusal for the typed range, or null when it would sign cleanly.
 * Mirrors `explicitRangeFromPrices` rule for rule (raw band, tick bounds, min
 * and max width, straddle) so the Deploy button is disabled with THIS text
 * before any passkey prompt, and the helper never has anything left to refuse.
 */
function lpRangeProblem(values, geometry) {
  const minNum = parsePrice(values.minPrice);
  const maxNum = parsePrice(values.maxPrice);
  if (minNum === null || maxNum === null) return "Both prices must be positive numbers.";
  if (maxNum <= minNum) return "The maximum price must be above the minimum price.";
  const range = derivedRange(values, geometry);
  if (range === null) return "Both prices must be positive numbers.";
  const live = livePriceInsideBand({ ...geometry.orientation, minPrice: range.minPrice, maxPrice: range.maxPrice, liveTick: geometry.currentTick });
  if (!live.inside) return `The current price ${formatPrice(priceFromTick(geometry.currentTick, geometry.display))} ${geometry.display.quoteSymbol} must sit inside the typed band for a two-sided open.`;
  const floor = snapTickUp(-887272, geometry.spacing);
  const ceiling = snapTickDown(887272, geometry.spacing);
  if (range.tickLower < floor || range.tickUpper > ceiling) return `That range reaches past the pool's tick bounds [${floor}, ${ceiling}]; move the prices inward.`;
  if (range.tickUpper - range.tickLower < 2 * geometry.spacing) return `The range must be at least two tick spacings (${2 * geometry.spacing} ticks) wide.`;
  if (range.tickUpper - range.tickLower > MAX_RANGE_WIDTH_TICKS) return `That range is ${range.tickUpper - range.tickLower} ticks wide; the open accepts at most ${MAX_RANGE_WIDTH_TICKS}. Narrow the price band.`;
  if (!(range.tickLower <= geometry.currentTick && geometry.currentTick < range.tickUpper)) return "The current price must sit inside the range for a two-sided open.";
  return null;
}

function PriceRangeField({ values, set }) {
  const geometry = lpRangeGeometry(values);
  const reason = String(values.lpRangeReason ?? "Select a pool");
  const range = geometry ? derivedRange(values, geometry) : null;
  const lo = range === null ? null : range.tickLower;
  const hi = range === null ? null : range.tickUpper;
  const flipped = geometry ? geometry.flipped : false;
  // Which signed bound each DISPLAYED price box owns: in an orientation with the
  // quote on token0 a higher price is a LOWER tick.
  const minBoxTick = range === null ? null : geometry.display.quoteIsToken0 ? range.tickUpper : range.tickLower;
  const maxBoxTick = range === null ? null : geometry.display.quoteIsToken0 ? range.tickLower : range.tickUpper;
  // The band key that owns a given tick bound, in the BAND orientation.
  const bandKeyForLower = geometry && geometry.orientation.quoteIsToken0 ? "maxPrice" : "minPrice";
  const bandKeyForUpper = geometry && geometry.orientation.quoteIsToken0 ? "minPrice" : "maxPrice";
  const problem = geometry ? lpRangeProblem(values, geometry) : null;
  // Display strings: the band as typed when not flipped; its reciprocal otherwise.
  const bandMin = parsePrice(values.minPrice);
  const bandMax = parsePrice(values.maxPrice);
  const displayMin = !flipped ? values.minPrice : bandMax === null ? "" : formatPrice(1 / bandMax);
  const displayMax = !flipped ? values.maxPrice : bandMin === null ? "" : formatPrice(1 / bandMin);
  /**
   * An edit while flipped re-expresses the band in the display orientation
   * ONCE: the typed number becomes authoritative for its bound, the other bound
   * is converted at full precision, and the display is no longer "flipped".
   */
  const editDisplayed = (bound, typed) => {
    if (!flipped) { set(bound === "min" ? "minPrice" : "maxPrice", typed); return; }
    const otherNative = bound === "min" ? bandMin : bandMax;
    set("lpQuoteIsToken0", !geometry.orientation.quoteIsToken0);
    set("lpQuoteSymbol", geometry.display.quoteSymbol);
    set("lpBaseSymbol", geometry.display.baseSymbol);
    set("lpDisplayFlipped", false);
    set(bound === "min" ? "minPrice" : "maxPrice", typed);
    set(bound === "min" ? "maxPrice" : "minPrice", otherNative === null ? "" : String(1 / otherNative));
  };
  const stepTick = (isLowerBound, nextTick) => {
    // Written in the BAND orientation at a spacing multiple — the outward snap is a no-op.
    set(isLowerBound ? bandKeyForLower : bandKeyForUpper, formatPrice(priceFromTick(nextTick, geometry.orientation)));
  };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {!geometry ? (
        <div style={{ padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px dashed var(--line-1)", font: "var(--weight-regular) var(--text-sm)/1.3 var(--font-sans)", color: "var(--text-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
          {reason.startsWith("Refreshing") ? <span className="fl-spin" aria-hidden="true" data-testid="lp-range-spinner" /> : null}
          {reason}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "center", font: "var(--weight-medium) var(--text-xs)/1.4 var(--font-mono)", color: "var(--text-subtle)" }}>
            <span>Current price {formatPrice(priceFromTick(geometry.currentTick, geometry.display))} {geometry.display.quoteSymbol} per {geometry.display.baseSymbol} · tick {geometry.currentTick}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <span>1 tick spacing = {geometry.spacing} ticks ≈ {(Math.pow(1.0001, geometry.spacing) * 100 - 100).toFixed(2)}%</span>
              {/* Flip ONLY the display. The band and its signed ticks are untouched. */}
              <button type="button" aria-label="Swap price direction" data-testid="lp-flip-quote"
                onClick={() => set("lpDisplayFlipped", !flipped)}
                style={{ cursor: "pointer", padding: "4px 8px", borderRadius: 6, border: "1px solid var(--line-1)", background: "transparent", color: "var(--cat-lp)", font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)" }}>
                ⇄ {geometry.display.baseSymbol} per {geometry.display.quoteSymbol}
              </button>
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 16 }}>
            <PriceRangeBox label="Minimum price" displayValue={displayMin} onDisplayChange={(v) => editDisplayed("min", v)}
              onTickStep={(next) => stepTick(!geometry.display.quoteIsToken0, next)} geometry={geometry} signedTick={minBoxTick} />
            <PriceRangeBox label="Maximum price" displayValue={displayMax} onDisplayChange={(v) => editDisplayed("max", v)}
              onTickStep={(next) => stepTick(geometry.display.quoteIsToken0, next)} geometry={geometry} signedTick={maxBoxTick} />
          </div>
          {typeof values.lpRailsReason === "string" ? (
            <div role="alert" data-testid="lp-rails-warning" style={{ padding: "8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--loss)", font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-sans)", color: "var(--loss)" }}>{values.lpRailsReason}</div>
          ) : null}
          {problem ? (
            <div role="alert" style={{ font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-sans)", color: "var(--loss)" }}>{problem}</div>
          ) : (
            <div data-testid="lp-signed-range" data-lower={lo} data-upper={hi} style={{ font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-mono)", color: "var(--text-subtle)" }}>
              Signed range [{lo}, {hi}) · width {rangeWidthPct(lo, hi).toFixed(2)}% of price
            </div>
          )}
        </>
      )}
    </div>
  );
}

const MODE_DEFS = [
  { key: "rebalanceOn", code: "AR", label: "Auto-rebalance", locked: true, fields: (values) => [
    { k: "rebalanceMode", label: "Rebalance mode", type: "select", options: ["Both ways", "Swapless"] },
    { k: "rebalanceCooldown", label: "Rebalance cooldown", type: "unitStepper", unitKey: "rebalanceCooldownUnit", unitOptions: ["hours", "mins"], step: 1, min: 3 },
  ] },
  { key: "compoundOn", code: "AC", label: "Auto-compound", locked: false, fields: [
    { k: "minFees", label: "Minimum fees to compound", type: "stepper", step: 1, min: 1, suffix: "%" },
  ] },
  { key: "tpOn", code: "TP", label: "Take profit", locked: false, fields: [
    { k: "tpPercent", label: "Take profit at", type: "stepper", step: 5, min: 0, suffix: "%" },
  ] },
  { key: "slOn", code: "SL", label: "Stop loss", locked: false, fields: [
    { k: "slPercent", label: "Stop loss at", type: "stepper", step: 5, min: 0, suffix: "%" },
  ] },
];

const REBALANCE_PREVIEWS = () => ({ "Both ways": RESOURCES.lpRebalanceBothways, "Swapless": RESOURCES.lpRebalanceSwapless, "Up only": RESOURCES.lpRebalanceUponly, "Down only": RESOURCES.lpRebalanceDownonly, "Fixed schedule": RESOURCES.lpRebalanceSchedule });

function ModeRow({ m, values, set, exp, setExp }) {
  const on = m.locked ? true : !!values[m.key];
  const isExp = exp === m.key;
  return (
    <div style={{ borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
        <span style={{ flex: "0 0 auto", pointerEvents: m.locked ? "none" : "auto", opacity: m.locked ? 0.7 : 1 }}>
          {/* Ticking a mode opens its settings right away (and unticking folds
              them), so Take profit / Stop loss never need the "+" to show
              their percentage. The "+" still toggles the panel on its own. */}
          <Checkbox checked={on} onChange={(v) => { if (m.locked) return; set(m.key, v); setExp(v ? m.key : (isExp ? null : exp)); }} />
        </span>
        <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", flex: "0 0 auto" }}>{m.code}</span>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)", flex: 1 }}>{m.label}</span>
        <button type="button" onClick={() => setExp(isExp ? null : m.key)} aria-label="Expand"
          style={{ cursor: "pointer", width: 26, height: 26, borderRadius: 6, border: "1px solid var(--line-1)", background: "transparent", display: "grid", placeItems: "center", color: "var(--text-subtle)", fontSize: 15, lineHeight: 1, transform: isExp ? "rotate(45deg)" : "none", transition: "transform 120ms", flex: "0 0 auto" }}>+</button>
      </div>
      {isExp ? (
        <div style={{ padding: "0 14px 14px", display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {(typeof m.fields === "function" ? m.fields(values) : m.fields).map((f) => (
              <Field key={f.k} f={f} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} />
            ))}
          </div>
          {/* The stills these replace could not show the thing that matters:
              swapless parking the band beside the price without a swap, and
              "Both ways" re-centring on the price after the drift trigger and
              cooldown clear. Both are the agent detail explainers in compact
              mode — chart and facts, no header, no step bar, no prose. */}
          {m.key === "rebalanceOn" && values.rebalanceMode === "Swapless" ? (
            <SwaplessExplainer />
          ) : m.key === "rebalanceOn" && values.rebalanceMode === "Both ways" ? (
            <RangeExplainer compact />
          ) : m.key === "rebalanceOn" && REBALANCE_PREVIEWS()[values.rebalanceMode] ? (
            <img src={REBALANCE_PREVIEWS()[values.rebalanceMode]} alt={values.rebalanceMode + " preview"} style={{ width: "100%", borderRadius: "var(--radius-sm)", border: "1px solid var(--line-1)" }} />
          ) : null}
          {m.key === "compoundOn" ? <CompoundExplainer compact /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ModeRows({ values, set }) {
  const [exp, setExp] = React.useState("rebalanceOn");
  const main = MODE_DEFS.filter((m) => m.key === "rebalanceOn" || m.key === "compoundOn");
  const pair = MODE_DEFS.filter((m) => m.key === "tpOn" || m.key === "slOn");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {main.map((m) => <ModeRow key={m.key} m={m} values={values} set={set} exp={exp} setExp={setExp} />)}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {pair.map((m) => <ModeRow key={m.key} m={m} values={values} set={set} exp={exp} setExp={setExp} />)}
      </div>
    </div>
  );
}

function UnitStepper({ label, value, onChange, unit, onUnitChange, options, step = 1, min }) {
  const raw = value === "" || value == null ? null : parseFloat(String(value).replace(/,/g, ""));
  const dec = () => onChange(String(Math.max(min != null ? min : 0, (raw || 0) - step)));
  const inc = () => onChange(String((raw || 0) + step));
  return (
    <div className="fl-field">
      <label className="fl-field__label">{label}</label>
      <div style={{ display: "flex", alignItems: "stretch", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)" }}>
        <button type="button" onClick={dec} aria-label="Decrease" style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", borderRight: "1px solid var(--line-1)", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>−</button>
        <input value={value == null ? "" : value} onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, minWidth: 0, textAlign: "right", padding: "11px 12px", background: "transparent", border: "none", outline: "none", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 6px", borderLeft: "1px solid var(--line-1)", borderRight: "1px solid var(--line-1)" }}>
          {options.map((o) => (
            <button key={o} type="button" onClick={() => onUnitChange(o)}
              style={{ cursor: "pointer", padding: "4px 8px", borderRadius: 4, border: "none", background: unit === o ? "var(--cat-lp-tint)" : "transparent", color: unit === o ? "var(--cat-lp)" : "var(--text-subtle)", font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)" }}>{o}</button>
          ))}
        </div>
        <button type="button" onClick={inc} aria-label="Increase" style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>+</button>
      </div>
    </div>
  );
}

function Field({ f, value, onChange, values, set, preset }) {
  const [fieldError, setFieldError] = React.useState("");
  if (f.type === "hidden") return null;
  if (f.type === "toggle") return (
    <div style={{ display: "grid", gap: 8 }}>
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{f.label}</span>
      <div style={{ display: "flex", alignItems: "center", minHeight: 42 }}>
        <Checkbox checked={!!value} onChange={(v) => { onChange(v); if (v && f.exclusiveWith) set(f.exclusiveWith, false); }}>{f.text}</Checkbox>
      </div>
      {f.inputKey && value ? (
        <input value={(values && values[f.inputKey]) || ""} onChange={(e) => set(f.inputKey, e.target.value)} placeholder={f.inputPlaceholder}
          style={{ width: "100%", padding: "11px 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", color: "var(--ink-1)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", outline: "none" }} />
      ) : null}
    </div>
  );
  if (f.type === "numToggle") {
    const on = !!values[f.on];
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <Checkbox checked={on} onChange={(v) => set(f.on, v)}>{f.label}</Checkbox>
        <div style={{ opacity: on ? 1 : 0.4, pointerEvents: on ? "auto" : "none" }}>
          <NumStepper value={value} onChange={onChange} step={f.step || 1} min={f.min} max={f.max} suffix={f.suffix} />
        </div>
      </div>
    );
  }
  if (f.type === "stepper") {
    const typed = value === "" || value == null ? null : parseFloat(String(value).replace(/,/gu, ""));
    const below = f.floor != null && typed != null && typed < f.min;
    return (
      <div className="fl-field">
        <label className="fl-field__label">{f.label}</label>
        <NumStepper value={value} onChange={onChange} step={f.step || 1} min={f.min} max={f.max} prefix={f.prefix} suffix={f.suffix} noClamp={f.floor != null} preciseStep={f.preciseStep} disabled={f.lockedByPreset && f.lockedByPreset.includes(preset)} />
        {below ? <span role="alert" style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--loss)" }}>Minimum {f.floor} {f.suffix ?? ""}</span>
          : f.hint ? <span className="fl-field__hint">{f.hint}</span> : null}
      </div>
    );
  }
  if (f.type === "pool") return <PoolPicker value={value} onChange={onChange} />;
  if (f.type === "liquidityChart") {
    const g = lpRangeGeometry(values);
    const r = g ? derivedRange(values, g) : null;
    return <LiquidityChart poolAddress={values.lpRangeReady === true ? String(values.lpRangePoolAddress ?? "") : ""}
      geometry={g ? { spacing: g.spacing, currentTick: g.currentTick, currentTickAsOfMs: 0,
        orientation: { quoteIsToken0: g.display.quoteIsToken0, decimals0: g.display.decimals0, decimals1: g.display.decimals1,
          symbol0: g.display.quoteIsToken0 ? g.display.quoteSymbol : g.display.baseSymbol,
          symbol1: g.display.quoteIsToken0 ? g.display.baseSymbol : g.display.quoteSymbol }, display: { invert: false } } : null}
      range={r ? { mode: "live", tickLower: r.tickLower, tickUpper: r.tickUpper } : { mode: "unavailable", reason: "" }} legend={{ range: "your range" }} />;
  }
  if (f.type === "priceRangeGroup") return <PriceRangeField values={values} set={set} />;
  if (f.type === "modeRows") return <ModeRows values={values} set={set} />;
  if (f.type === "unitStepper") return <UnitStepper label={f.label} value={value} onChange={onChange} unit={values[f.unitKey]} onUnitChange={(u) => set(f.unitKey, u)} options={f.unitOptions} step={f.step} min={f.min} />;
  if (f.type === "textarea") return (
    <div style={{ display: "grid", gap: 8 }}>
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{f.label}</span>
      <textarea value={value || ""} onChange={(e) => {
        const next = e.target.value;
        if (f.byteLimit) {
          const checked = checkBoundedText(next, f.byteLimit, f.label);
          if (!checked.ok) { setFieldError(checked.message); return; }
          setFieldError("");
        }
        onChange(next);
      }} placeholder={f.placeholder} rows={4}
        style={{ width: "100%", resize: "vertical", padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", color: "var(--ink-1)", font: "var(--weight-regular) var(--text-sm)/1.4 var(--font-sans)", outline: "none" }} />
      {f.hint ? <span style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>{f.hint}</span> : null}
      {fieldError ? <span role="alert" style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--loss)" }}>{fieldError}</span> : null}
    </div>
  );
  if (f.type === "skillFile") {
    const fname = value && value.name;
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{f.label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
          <span style={{ display: "grid", gap: 3, minWidth: 0, flex: 1 }}>
            <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{fname || "No skill file attached"}</span>
            <span style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>Markdown only. Stored as advisory guidance and never granted execution authority.</span>
          </span>
          <label style={{ cursor: "pointer", display: "inline-flex", flex: "0 0 auto" }}>
             <input type="file" accept=".md" style={{ display: "none" }} onChange={(e) => {
               const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
               if (file === null) { setFieldError(""); onChange(null); return; }
               void file.text().then((text) => {
                 const checked = validateSkillMarkdown(file.name, text);
                 if (!checked.ok) { setFieldError(checked.message); onChange(null); return; }
                 setFieldError(""); onChange({ name: file.name, text, bytes: checked.bytes });
               });
             }} />
            <span style={{ padding: "8px 16px", borderRadius: 999, border: "1px solid var(--line-1)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)", whiteSpace: "nowrap" }}>Upload .md</span>
          </label>
        </div>
        <span style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>Upload a markdown file when you want a reusable trading doctrine. The file is stored with the agent and used during entry timing only.</span>
        {fieldError ? <span role="alert" style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--loss)" }}>{fieldError}</span> : null}
      </div>
    );
  }
  if (f.type === "check") return <Checkbox checked={!!value} locked={!!f.disabled} title={f.tooltip} onChange={onChange}>{f.text}</Checkbox>;
  if (f.type === "radioCheck") return <Checkbox checked={values[f.k] === f.value} onChange={() => set(f.k, f.value)}>{f.text}</Checkbox>;
  if (f.type === "codeToggle") return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
      <Checkbox checked={!!value} onChange={onChange} />
      <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{f.code}</span>
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{f.text}</span>
    </div>
  );
  if (f.type === "select") {
    // The two model pickers must never land on the same id: a fallback equal to
    // the primary is not a fallback, and the plane refuses the settings.
    const taken = f.excludeValueOf === undefined ? undefined : String(values[f.excludeValueOf] ?? "");
    if (taken !== undefined && f.showDisabledOption) {
      return <TradeModelSelect label={f.label} value={value} options={f.options} disabledValue={taken} onChange={onChange} />;
    }
    const options = taken === undefined ? f.options : f.options.filter((option: string) => option !== taken);
    return <Select label={f.label} value={value} options={options} hint={f.hint} disabled={!!f.disabled} onChange={(e) => onChange(e.target.value)} />;
  }
  if (f.alignAsCheckbox) return (
    <div style={{ display: "grid", gap: 8 }}>
      <span style={{ display: "flex", alignItems: "flex-start", font: "var(--type-body-md)", color: "var(--ink-1)" }}>{f.label}</span>
      <NumStepper value={value} onChange={onChange} step={f.step || 1} min={f.min} max={f.max} suffix={f.suffix} noLimitAtMin={f.noLimitAtMin} />
    </div>
  );
  const locked = f.lockedByPreset && f.lockedByPreset.includes(preset);
  return (
    <div style={locked ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
      <Input label={f.label} mono={f.type !== "text"} value={value} prefix={f.prefix} suffix={f.suffix} hint={f.hint} disabled={locked} style={f.type !== "text" ? { textAlign: "right" } : undefined} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Group({ section, values, set, preset, overrides }) {
  // A field the caller has priced from live chain facts (the grid's capital
  // floor) wins over the CONFIG table's static `min`/`hint`.
  const F = (f) => (overrides && overrides[f.k] ? { ...f, ...overrides[f.k] } : f);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      {section.title ? <span className="fl-eyebrow">{section.title}{section.titleSuffix ? <span style={{ letterSpacing: "0.9px" }}> {section.titleSuffix}</span> : null}</span> : null}
      {section.note ? <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)", marginTop: -6 }}>{section.note}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 16, alignItems: "start" }}>
        {section.fields.filter((f) => !"check codeToggle radioCheck pool textarea skillFile liquidityChart priceRangeGroup modeRows".split(" ").includes(f.type)).map((f) => (
          <Field key={f.k} f={F(f)} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} preset={preset} />
        ))}
      </div>
      {section.fields.filter((f) => f.type === "pool" || f.type === "textarea" || f.type === "skillFile" || f.type === "liquidityChart" || f.type === "priceRangeGroup" || f.type === "modeRows").map((f) => (
        <Field key={f.k} f={F(f)} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} preset={preset} />
      ))}
      {section.fields.filter((f) => f.type === "check" || f.type === "codeToggle" || f.type === "radioCheck").map((f, i) => (
        <Field key={f.k + i} f={F(f)} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} preset={preset} />
      ))}
      {section.poweredBy === "0g" ? (
        <div className="fl-powered-by fl-powered-by--inline">
          <span className="fl-powered-by__label">AI models by</span>
          <img src={RESOURCES.zeroG} alt="0G" />
        </div>
      ) : null}
    </div>
  );
}

function DeployAgentSection({ go }) {
  return (
    <section className="fl-deploy-landing" style={{ marginBottom: 44, paddingBottom: 40, borderBottom: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 26 }}>
        <h2 style={{ font: "var(--weight-semibold) var(--text-3xl)/var(--leading-tight) var(--font-sans)", display: "flex", gap: "0.34em", flexWrap: "wrap", alignItems: "flex-end" }}>
          <span>Deploy Your Agent to</span><RotatingWord />
        </h2>
        <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", maxWidth: "62ch" }}>
          The Smart Money Era is here. Agents live 24/7 on-chain.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        {KINDS.map((k) => (
          <button key={k.id} className="fl-deploy-kind-card" onClick={() => go(`/deploy/${k.id}`)}
            style={{ "--fl-deploy-accent": k.color, textAlign: "left", cursor: "pointer", background: "var(--surface-card)", border: `1px solid ${k.color}`, borderRadius: "var(--radius-md)", padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 37, height: 37, borderRadius: "var(--radius-sm)", background: k.tint, color: k.color, display: "grid", placeItems: "center" }}>
                  <Icon name={k.icon} size={22} />
                </span>
                <span style={{ font: "var(--type-card-title)", color: "var(--ink-1)", fontSize: 18 }}>{k.label}</span>
              </span>
              <span style={{ color: k.color, display: "grid", placeItems: "center" }}><Icon name="chevron-right" size={14} /></span>
            </div>
            <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-muted)" }}>{k.blurb}</p>
            <span style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: k.color, marginTop: "auto" }}>Customise</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function DeployAgentScreen({ kind, go }) {
  const active = KINDS.find((k) => k.id === kind) || KINDS[0];
  const id = active.id;
  const presets = PRESETS[id];
  const [selectedMode, setMode] = React.useState("Live");
  const mode = id === "lp" || id === "health" ? "Live" : selectedMode;
  const [preset, setPreset] = React.useState(DEFAULT_PRESET[id]);
  const [values, setValues] = React.useState(() => defaults(id, DEFAULT_PRESET[id]));
  const [showAdv, setShowAdv] = React.useState(false);
  const [sim, setSim] = React.useState(null);
  const [depth, setDepth] = React.useState("Light");
  const [window_, setWindow] = React.useState({ start: "2026-07-01", end: "2026-08-10", capital: "1,000" });
  const setWin = (k, v) => setWindow((s) => ({ ...s, [k]: v }));
  // A capital the owner typed themselves is never overwritten by the floor
  // machinery below; an untouched one snaps to the floor as pools and presets
  // change, so the field is always already valid.
  const capitalTouched = React.useRef(false);
  const repayTouched = React.useRef(false);
  const activeKind = React.useRef(id);
  activeKind.current = id;
  const [repaySuggestion, setRepaySuggestion] = React.useState(null);
  const acceptRepaySuggestion = React.useCallback((amount) => {
    if (activeKind.current !== "health") return;
    setRepaySuggestion(amount);
    setValues((current) => repayTouched.current || current.maxRepay === (amount ?? "")
      ? current : { ...current, maxRepay: amount ?? "" });
  }, []);
  const set = (k, v) => {
    if (k === "capital") capitalTouched.current = true;
    if (k === "maxRepay") repayTouched.current = true;
    setValues((s) => ({ ...s, [k]: v }));
  };
  // Live-wired grid deploy (spec: MD here/MARKETPLACE-GRID-DEPLOY-SPEC.md):
  // a REAL pool object from /api/pools replaces the design export's static
  // POOLS list for the grid kind only.
  const [livePool, setLivePool] = React.useState(null);
  const [lpRoutingPool, setLpRoutingPool] = React.useState(null);
  const [lpRoutingError, setLpRoutingError] = React.useState(null);
  const selectLivePool = (next) => {
    if (id === "lp") {
      // The selection and its readiness invalidation land in the same event
      // update. There is no render where a new pool can inherit the old tick.
      setValues((current) => ({
        ...current,
        lpRangeReady: false,
        lpRangePoolAddress: null,
        lpRangeReason: next === null ? "Select a pool" : "Refreshing the selected pool's live tick…",
      }));
    }
    setLivePool(next);
  };
  // ── The CAPITAL FLOOR (grid) ──────────────────────────────────────────────
  // "min 0.02 BNB" was a design-export constant, and pricing it from a live
  // chain read replaced one wrong number with a number that arrives late and
  // moves under the owner mid-edit. It is a FIXED TABLE instead: the floor
  // depends only on the execution model and the pool's fee tier, both of which
  // this screen already holds, so it is known the instant the screen renders.
  React.useEffect(() => {
    setPreset(DEFAULT_PRESET[id]); setValues(defaults(id, DEFAULT_PRESET[id])); setMode("Live"); setShowAdv(false); setSim(null);
    capitalTouched.current = false;
    repayTouched.current = false;
    setRepaySuggestion(null);
  }, [id]);

  const capitalFloorText = id !== "grid"
    ? null
    : gridCapitalFloorBnb(UI_PRESET_TO_GEOMETRY[preset] ?? "standard", livePool === null ? null : livePool.fee);
  const capitalFloorBnb = capitalFloorText === null ? null : Number(capitalFloorText);
  React.useEffect(() => {
    if (capitalFloorText === null) return;
    setValues((current) => {
      const now = Number(String(current.capital ?? "").replace(/,/gu, ""));
      // Fill it for them; only a capital they typed themselves survives, and
      // only while it still clears the floor.
      if (capitalTouched.current && Number.isFinite(now) && now >= Number(capitalFloorText)) return current;
      return { ...current, capital: capitalFloorText };
    });
  }, [capitalFloorText]);

  React.useEffect(() => {
    if (id !== "trading") return;
    const raw = window.localStorage.getItem("4lpha:trade-redeploy:v1");
    if (raw === null) return;
    try {
      const saved = JSON.parse(raw);
      const settings = saved.settings ?? saved;
      const presetId = settings.executionModel === "blue-chip" ? "bluechip" : settings.executionModel === "mid-cap" ? "midcap" : settings.executionModel;
      if (!PRESETS.trading.some((entry) => entry.id === presetId)) return;
      setPreset(presetId);
      setValues((current) => ({ ...current,
        agentName: settings.name, capital: saved.capitalBnb ?? current.capital, perTrade: weiToBnb(settings.entryWei), maxPositions: String(settings.maxOpenPositions),
        minMcap: settings.minMarketCapUsd === null ? "" : String(settings.minMarketCapUsd), maxMcap: settings.maxMarketCapUsd === null ? "" : String(settings.maxMarketCapUsd),
        noReentry: settings.noReentry, tp1On: settings.takeProfitBps !== null, tp1: settings.takeProfitBps === null ? "0" : String(settings.takeProfitBps / 100),
        stopLossOn: settings.stopLossBps !== null, stopLoss: settings.stopLossBps === null ? "50" : String(Math.abs(stopLossPercentFromBps(settings.stopLossBps))),
        holdTime: settings.maxHoldSec === null ? "0" : String(settings.maxHoldSec / 60),
        slippage: String(settings.slippageBps / 100), gas: settings.gasPriority[0].toUpperCase() + settings.gasPriority.slice(1),
        instructions: settings.instructions ?? "", skillFile: settings.skillMarkdown === null ? null : { name: "Previous skill.md", text: settings.skillMarkdown },
      }));
      window.localStorage.removeItem("4lpha:trade-redeploy:v1");
    } catch {
      window.localStorage.removeItem("4lpha:trade-redeploy:v1");
    }
  }, [id]);

  React.useEffect(() => {
    if (id !== "lp" || preset !== "wide") {
      setLpRoutingPool(null);
      setLpRoutingError(null);
      return;
    }
    let cancelled = false;
    const rankBy = values.routeBy === "volume" ? "volume" : "fee-apr";
    void fetch(`/api/pools?rankBy=${rankBy}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok || !Array.isArray(payload.data) || payload.data.length === 0) {
          setLpRoutingPool(null);
          setLpRoutingError(payload.error?.code ?? "pools_unavailable");
          return;
        }
        setLpRoutingPool(payload.data[0]);
        setLpRoutingError(null);
      })
      .catch(() => {
        if (!cancelled) {
          setLpRoutingPool(null);
          setLpRoutingError("pools_unavailable");
        }
      });
    return () => { cancelled = true; };
  }, [id, preset, values.routeBy]);

  React.useEffect(() => {
    if (id !== "lp" || preset !== "blue") return;
    if (livePool === null) {
      setValues((current) => ({
        ...current,
        lpCurrentTick: null,
        lpCurrentPrice: null,
        lpTickSpacing: null,
        lpWbnbIsToken0: null,
        lpQuoteIsToken0: null,
        lpQuoteSymbol: null,
        lpBaseSymbol: null,
        lpDisplayFlipped: null,
        lpRailsReason: null,
        lpRangePoolAddress: null,
        lpRangeReady: false,
        lpRangeReason: "Select a pool",
      }));
      return;
    }
    setValues((current) => ({
      ...current,
      lpRangeReady: false,
      lpRangePoolAddress: null,
      lpRangeReason: "Refreshing the selected pool's live tickâ€¦",
    }));
    let cancelled = false;
    void fetch(`/api/pool-state?address=${livePool.pool.toLowerCase()}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok || payload.data === undefined) {
          setValues((current) => ({
            ...current,
            lpRangeReady: false,
            lpRangeReason: payload.error?.message ?? "The pool's current tick is unavailable.",
          }));
          return;
        }
        const currentTick = payload.data.currentTick;
        const tickSpacing = payload.data.tickSpacing;
        const wbnbIsToken0 = livePool.wbnbIsToken0;
        // The displayed price is QUOTE PER BASE under the numeraire rule the
        // agent page uses (USDT/USDC > WBNB > token1) — the number the pool's
        // own PancakeSwap page shows — never "the other leg per WBNB".
        const quote = poolQuote(livePool);
        const orientation = { quoteIsToken0: quote.quoteIsToken0 };
        const halfWidth = Math.floor(LP_OPEN_WIDTH_TICKS / 2);
        const tickLower = snapTickDown(currentTick - halfWidth, tickSpacing);
        const tickUpper = snapTickUp(currentTick + halfWidth, tickSpacing);
        const firstPrice = priceFromTick(tickLower, orientation);
        const secondPrice = priceFromTick(tickUpper, orientation);
        setValues((current) => ({
          ...current,
          minPrice: formatPrice(Math.min(firstPrice, secondPrice)),
          maxPrice: formatPrice(Math.max(firstPrice, secondPrice)),
          lpCurrentTick: currentTick,
          lpCurrentPrice: priceFromTick(currentTick, orientation),
          lpTickSpacing: tickSpacing,
          lpWbnbIsToken0: wbnbIsToken0,
          lpQuoteIsToken0: quote.quoteIsToken0,
          lpQuoteSymbol: quote.quoteSymbol,
          lpBaseSymbol: quote.baseSymbol,
          lpDisplayFlipped: false,
          // The plane says whether its manipulation rails can read this pool.
          // When they cannot (TWAP too short), the range and chart still draw
          // for reference and Deploy is blocked with the plane's own reason.
          lpRailsReason: payload.data.railsReady === false ? String(payload.data.railsReason ?? "The plane's rails cannot read this pool yet.") : null,
          lpRangePoolAddress: livePool.pool.toLowerCase(),
          lpRangeReady: true,
          lpRangeReason: null,
        }));
      })
      .catch(() => {
        if (!cancelled) {
          setValues((current) => ({
            ...current,
            lpRangeReady: false,
            lpRangeReason: "The pool's current tick is unavailable.",
          }));
        }
      });
    return () => { cancelled = true; };
  }, [id, livePool, preset]);

  const applyPreset = (p) => {
    setPreset(p.id);
    if (id === "lp") setValues(defaults(id, p.id));
    else setValues((s) => ({ ...s, ...p.set }));
    setSim(null);
  };
  const presetIdx = Math.max(0, presets.findIndex((p) => p.id === preset));
  const runSim = () => setSim(SIM[id][presetIdx] || SIM[id][0]);

  const sections = sectionsFor(id, preset);
  const primary = sections.filter((s) => !s.adv);
  const advanced = sections.filter((s) => s.adv);
  // Per-field overrides the CONFIG table cannot carry, because they depend on
  // live chain facts. Today: the grid's capital floor.
  const fieldOverrides = React.useMemo(() => {
    if (id === "health") return { maxRepay: { hint: repaySuggestion === null
      ? "Suggested from supported debt and Total capital once account data and BNB price are available. You can enter your own amount."
      : `Suggested $${repaySuggestion} from supported debt and Total capital. You can edit this amount.` } };
    if (id === "trading") return {
      perTrade: { min: 0.005, floor: "0.005", max: undefined },
      capital: { min: 0.02, floor: "0.02", hint: null },
      maxPositions: { min: 1, max: 10 },
    };
    if (id !== "grid" || capitalFloorText === null || capitalFloorBnb === null) return null;
    // `floor` turns the stepper strict: the − button stops here and a smaller
    // typed number goes red instead of being silently rewritten.
    return { capital: { min: capitalFloorBnb, floor: capitalFloorText, hint: null } };
  }, [id, capitalFloorText, capitalFloorBnb, repaySuggestion]);

  const capitalBelowFloor = capitalFloorBnb !== null
    && Number(String(values.capital ?? "").replace(/,/gu, "")) < capitalFloorBnb;
  const tradePreset = id === "trading" ? presets.find((entry) => entry.id === preset) : null;
  const tradeSettings = id === "trading" ? ({
    name: String(values.agentName ?? "Trading Agent 01"), executionModel: tradePreset?.executionModel ?? "sigma",
    entryWei: parseBnbToWei(String(values.perTrade ?? "0")).toString(10), maxOpenPositions: Number(values.maxPositions),
    minMarketCapUsd: decimalOrNull(values.minMcap), maxMarketCapUsd: decimalOrNull(values.maxMcap), noReentry: !!values.noReentry,
    takeProfitBps: values.tp1On ? Math.round(Number(values.tp1) * 100) : null, stopLossBps: stopLossBpsWhenEnabled(!!values.stopLossOn, Number(values.stopLoss)),
    maxHoldSec: Number(values.holdTime) > 0 ? Math.round(Number(values.holdTime) * 60) : null, breakEvenAfterTp: false,
    slippageBps: Math.round(Number(values.slippage) * 100), gasPriority: String(values.gas ?? "Standard").toLowerCase(),
    primaryModel: tradeModelId(String(values.primary ?? MODELS[0])),
    fallbackModel: tradeModelId(String(values.fallback ?? MODELS[1])),
    instructions: String(values.instructions ?? "").trim() === "" ? null : String(values.instructions), skillMarkdown: values.skillFile?.text ?? null,
  } satisfies TradeSettings) : null;
  const tradeBlockedReason = tradeSettings === null ? null : (() => {
    const entryWei = BigInt(tradeSettings.entryWei);
    const totalWei = parseBnbToWei(String(values.capital ?? "0"));
    if (entryWei < MIN_TRADE_ENTRY_WEI) return "BNB per entry must be at least 0.002 BNB.";
    if (!Number.isInteger(tradeSettings.maxOpenPositions) || tradeSettings.maxOpenPositions < 1
      || tradeSettings.maxOpenPositions > 10) return "Max open positions must be an integer from 1 through 10.";
    const stopLossPercent = Number(values.stopLoss);
    if (values.stopLossOn && (!Number.isFinite(stopLossPercent) || stopLossPercent < 1 || stopLossPercent > 100)) {
      return "Stop loss must be between 1% and 100%.";
    }
    if (totalWei < MIN_TRADE_CAPITAL_WEI) return "Total capital must be at least 0.01 BNB.";
    return null;
  })();

  return (
    <div className={`fl-shell fl-deploy-page fl-deploy-polished${id === "grid" ? " fl-grid-deploy" : ""}`} style={{ maxWidth: 1080 }} data-testid={`deploy-${id}-screen`}>
      <Button variant="ghost" size="sm" icon={<span style={{ display: "grid", placeItems: "center", transform: "rotate(180deg)" }}><Icon name="arrow-right" size={13} /></span>} onClick={() => go("/")}>Back to marketplace</Button>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap", margin: "20px 0 26px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ width: 52, height: 52, borderRadius: "var(--radius-sm)", background: active.tint, color: active.color, display: "grid", placeItems: "center" }}>
            <Icon name={active.icon} size={35} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <h1 style={{ font: "var(--type-page-title)" }}>Deploy your <span style={{ color: active.color }}>{active.label.replace(" Agent", "")}</span> Agent</h1>
            <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-muted)" }}>{active.blurb}</p>
          </div>
        </div>
        {/* LP has no demo engine and the plan says so out loud (§9): an honest
            LP PnL needs fee accrual and impermanent loss, which is a simulator
            rather than a skipped submit. So its toggle is DISABLED with a
            reason rather than offering a Demo that cannot run (review finding
            19). Lending also uses only its live hire flow. */}
        {id === "lp" || id === "health" ? (
          <fieldset disabled title="Demo mode covers grid and trading agents; an LP demo needs fee and impermanent-loss modelling and is not built"
            style={{ border: 0, margin: 0, padding: 0, opacity: 0.65 }}>
            <SegmentedToggle options={["Demo", "Live"]} value="Live" onChange={() => undefined} accent />
          </fieldset>
        ) : (
          <SegmentedToggle options={["Demo", "Live"]} value={mode} onChange={setMode} accent />
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
        {KINDS.map((k) => (
          <button key={k.id} onClick={() => go(`/deploy/${k.id}`)}
            style={{ cursor: "pointer", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: k.id === id ? k.color : "var(--text-subtle)", background: k.id === id ? k.tint : "transparent", border: `1px solid ${k.id === id ? k.color : "var(--line-1)"}`, borderRadius: 999, padding: "8px 14px", display: "flex", alignItems: "center", gap: 7 }}>
            <Icon name={k.icon} size={13} />{k.label}
          </button>
        ))}
      </div>

      <section className="fl-deploy-form" style={{ border: "1px solid var(--border-card)", borderTop: `2px solid ${active.color}`, borderRadius: "var(--radius-md)", background: "var(--surface-card)", padding: 24 }}>
        {active.venues ? (
          <div className="fl-deploy-providers" aria-label="Protocols">
            {(mode === "Live" ? active.venues.live : active.venues.demo).map((venue) => (
              <span className="fl-deploy-provider" key={venue.label} title={venue.label}>
                <img src={venue.asset} alt="" />
                <span>{venue.label}</span>
              </span>
            ))}
          </div>
        ) : null}
        <div style={{ display: "grid", gap: 14, marginBottom: 26 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <span className="fl-eyebrow">Execution model</span>
            <span className="fl-deploy-form-links">
              <a href={GUIDE_LINKS[id]} target="_blank" rel="noreferrer">Guides</a>
              <a href={TUTORIAL_LINK} target="_blank" rel="noreferrer">Tutorial Videos</a>
              <button type="button" onClick={() => { repayTouched.current = false; setRepaySuggestion(null); setPreset(DEFAULT_PRESET[id]); setValues(defaults(id, DEFAULT_PRESET[id])); setSim(null); }}>
                Reset parameters to defaults
              </button>
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            {presets.map((p) => {
              const on = p.id === preset;
              return (
                <button key={p.id} onClick={() => applyPreset(p)}
                  style={{ textAlign: "left", cursor: "pointer", display: "grid", gap: 6, padding: "12px 14px", borderRadius: "var(--radius-sm)", background: on ? active.tint : "var(--surface-sunken)", border: `1px solid ${on ? active.color : "var(--line-1)"}` }}>
                  <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: on ? active.color : "var(--ink-1)" }}>{p.label}</span>
                  {p.gap ? <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: on ? active.color : "var(--text-muted)" }}>{p.gap}</span> : null}
                  <span style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>{p.note}</span>
                </button>
              );
            })}
          </div>
          {id === "trading" ? <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>Trades only the tokens pinned when you deploy (up to 25). New launches need a new agent.</p> : null}
        </div>

        <div style={{ display: "grid", gap: 24 }}>
          {primary.map((s) =>
            (id === "grid" || (id === "lp" && preset === "blue")) && s.title === "Pool"
              ? <LivePoolSection key="live-pool" value={livePool} onChange={selectLivePool} />
              // MARKETPLACE-LENDING-AGENT R2.20 / R3.3: the guarded-account
              // stage is the FIRST thing the lending form asks for, swapped in
              // for its section exactly as the live pool picker is for "Pool".
              : id === "health" && s.title === "Guarded account"
                ? <GuardedAccountSection key="guarded-account" value={values.guarded} onChange={(next) => set("guarded", next)} />
                : <Group key={s.title} section={s} values={values} set={set} preset={preset} overrides={fieldOverrides} />)}
        </div>
        {id === "lp" && preset === "wide" ? (
          <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", color: "var(--text-subtle)", font: "var(--weight-regular) var(--text-sm)/1.4 var(--font-sans)" }}>
            {lpRoutingPool !== null
              ? `Routing to: ${lpRoutingPool.token0Symbol ?? "?"} / ${lpRoutingPool.token1Symbol ?? "?"} · ${((lpRoutingPool.fee ?? 0) / 10000).toFixed(2).replace(/0$/u, "")}% · ${values.routeBy === "volume" ? `24h volume ${fmtUsd(lpRoutingPool.volume24hUsd ?? null)}` : `fee APR 24h ${lpRoutingPool.lpFeeApr24h ?? 0}%`}`
              : `Routing preview unavailable${lpRoutingError === null ? "." : ` (${lpRoutingError}).`}`}
          </div>
        ) : null}

        {advanced.length ? (
          <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
            <button onClick={() => setShowAdv((v) => !v)}
              style={{ cursor: "pointer", background: "none", border: "none", padding: 0, display: "flex", alignItems: "center", gap: 8, font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>
              <span style={{ display: "grid", placeItems: "center", color: active.color, transform: showAdv ? "rotate(90deg)" : "none", transition: "transform 120ms" }}><Icon name="chevron-right" size={13} /></span>
              {showAdv ? "Hide advanced settings" : "Show advanced settings"}
            </button>
            {showAdv ? (
              <div style={{ display: "grid", gap: 24, marginTop: 20 }}>
                {advanced.map((s) => <Group key={s.title} section={s} values={values} set={set} preset={preset} overrides={fieldOverrides} />)}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* §2.2: the sandbox panel and its `SIM.health` rows are design chrome.
            "Render nothing that reads as a measured number" — so the lending
            form has no sandbox at all, exactly as grid, trading and LP have
            none. */}
        {id !== "grid" && id !== "trading" && id !== "lp" && id !== "health" ? (
        <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--line-1)", display: "grid", gap: 14 }}>
          <span className="fl-eyebrow">Sandbox</span>
          <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)", marginTop: -6, maxWidth: "70ch" }}>{active.simNote}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 16, alignItems: "start" }}>
            <Input label={active.simLabel + " · start"} mono value={window_.start} onChange={(e) => setWin("start", e.target.value)} />
            <Input label={active.simLabel + " · end"} mono value={window_.end} onChange={(e) => setWin("end", e.target.value)} />
            <Input label="Initial capital" mono prefix="$" value={window_.capital} onChange={(e) => setWin("capital", e.target.value)} />
            <Select label="Search depth" value={depth} options={["Light", "Deep", "Ultra Deep"]} hint="Deeper searches test more candidate settings." onChange={(e) => setDepth(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <Button variant="secondary" size="sm" onClick={runSim}>Run backtest</Button>
            <Button variant="ghost" size="sm" onClick={runSim}>Optimise ({depth})</Button>
            <Button variant="ghost" size="sm">Save model</Button>
          </div>
          {sim ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 1, background: "var(--line-1)", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
              {[sim.pnl, sim.win, sim.dd, sim.n].map((v, i) => (
                <div key={i} style={{ background: "var(--surface-sunken)", padding: "14px 16px", display: "grid", gap: 6 }}>
                  <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-sans)", color: "var(--text-subtle)" }}>{SIM_LABELS[id][i]}</span>
                  <span style={{ font: "var(--weight-medium) var(--text-lg)/1 var(--font-mono)", color: i === 2 ? "var(--loss)" : i === 0 ? active.color : "var(--ink-1)" }}>{v}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        ) : null}

        {id === "grid" ? (
          <HireGridDeploy
            mode={mode}
            agentName={String(values.agentName ?? "Grid Agent")}
            uiPresetId={preset}
            pool={livePool}
            capitalBnb={String(values.capital ?? "0")}
            takeProfitPct={values.tpOn ? Number(values.takeProfit) || 0 : 0}
            stopLossPct={values.slOn ? Number(values.stopLoss) || 0 : 0}
            go={go}
            blockedReason={capitalBelowFloor ? `Total capital is below this pool's minimum of ${capitalFloorText} BNB.` : null}
          />
        ) : id === "trading" && tradeSettings !== null ? (
          // Demo and Live are two components, never one with a flag: the live
          // one is the passkey hire (wallet, grant fence, session) and a demo
          // has none of that. Same split the execution plane keeps.
          mode === "Demo" ? (
            // The exit settings the form is showing MUST reach the demo
            // (review finding 7): the first version passed only name, model and
            // capital, so an agent created from a form displaying a stop loss
            // and a take profit ran with neither, and simply never exited.
            <DemoTradeDeploy agentName={tradeSettings.name} executionModel={tradeSettings.executionModel}
              capitalBnb={String(values.capital ?? "0")} blockedReason={tradeBlockedReason}
              stopLossBps={tradeSettings.stopLossBps === null ? null : Math.abs(tradeSettings.stopLossBps)}
              takeProfitBps={tradeSettings.takeProfitBps}
              maxHoldSec={tradeSettings.maxHoldSec}
              maxOpenPositions={tradeSettings.maxOpenPositions} />
          ) : (
          <HireTradeDeploy agentName={tradeSettings.name} executionModel={tradeSettings.executionModel}
            capitalBnb={String(values.capital ?? "0")} settings={tradeSettings} go={go}
            blockedReason={tradeBlockedReason} />
          )
        ) : id === "lp" ? (
          <HireLpDeploy
            mode={mode}
            agentName={String(values.agentName ?? "LP Agent")}
            uiPresetId={preset}
            pool={preset === "blue" ? livePool : lpRoutingPool}
            capitalBnb={String(values.capital ?? "0")}
            routeBy={values.routeBy === "volume" ? "volume" : "fee-apr"}
            takeProfitPct={values.tpOn ? Number(values.tpPercent) || 0 : 0}
            stopLossPct={values.slOn ? Number(values.slPercent) || 0 : 0}
            rotateMode={values.rebalanceMode === "Swapless" ? "swapless" : "swapped"}
            rotateMinHoldMinutes={Math.max(3, Math.round((Number(values.rebalanceCooldown) || 0) * (values.rebalanceCooldownUnit === "hours" ? 60 : 1)))}
            compoundOn={values.compoundOn === true}
            minFees={Math.max(1, Math.round(Number(values.minFees) || 10))}
            primaryModel={String(values.primary ?? MODELS[0])}
            fallbackModel={String(values.fallback ?? MODELS[1])}
            instructions={String(values.instructions ?? "")}
            skillFile={values.skillFile ?? null}
            blockedReason={preset !== "blue" ? null
              : lpRangeGeometry(values) === null ? "Select a pool and wait for its live tick before deploying."
              : typeof values.lpRailsReason === "string" ? values.lpRailsReason
              : lpRangeProblem(values, lpRangeGeometry(values))}
            explicitPrices={preset === "blue" ? {
              minPrice: parsePrice(values.minPrice) ?? Number.NaN,
              maxPrice: parsePrice(values.maxPrice) ?? Number.NaN,
              currentTick: Number(values.lpCurrentTick),
              tickSpacing: Number(values.lpTickSpacing),
              wbnbIsToken0: values.lpWbnbIsToken0 === true,
              quoteIsToken0: values.lpQuoteIsToken0 === true,
              poolAddress: String(values.lpRangePoolAddress ?? ""),
              ready: values.lpRangeReady === true
                && values.lpRangePoolAddress === livePool?.pool.toLowerCase(),
            } : null}
            go={go}
          />
        ) : id === "health" ? (
          <HireLendingDeploy
            mode={mode}
            agentName={String(values.agentName ?? "Lending Agent")}
            capitalBnb={String(values.capital ?? "0")}
            guarded={values.guarded ?? null}
            triggerHf={String(values.trigger ?? "1.20")}
            targetHf={String(values.target ?? "1.50")}
            maxRepayUsd={String(values.maxRepay ?? "")}
            onRepaySuggestion={acceptRepaySuggestion}
            /* W6: NO silent clamps. The typed value goes through as typed; an
               out-of-range one is REFUSED by `buildLendingForm` inside the hire
               component, which disables Deploy and names the legal range. */
            rescueReserveCount={Math.round(lendingControlNumber(values.rescueCount, 6))}
            cooldownSeconds={Math.round(lendingControlNumber(values.cooldown, 300))}
            reserveBps={Math.round(lendingControlNumber(values.reservePct, 20) * 100)}
            go={go}
          />
        ) : (
        <div className="fl-deploy-actions" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
          <Button variant="primary" size="lg">Deploy {active.label}</Button>
          <Button variant="ghost" onClick={() => { repayTouched.current = false; setRepaySuggestion(null); setPreset(DEFAULT_PRESET[id]); setValues(defaults(id, DEFAULT_PRESET[id])); setSim(null); }}>Reset to preset</Button>
          <span style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)", marginLeft: "auto" }}>
            {mode === "Demo" ? "Demo mode runs the same logic with no funds at risk." : "Live mode signs with a scoped session key. No withdrawals."}
          </span>
        </div>
        )}
      </section>

      {/* The point of demo mode is WATCHING one work (review finding 8), so the
          running demos live directly under the form that creates them. The
          panel renders nothing at all when there are none. */}
      {mode === "Demo" ? <DemoAgentPanel go={go} /> : null}
    </div>
  );
}

export { DeployAgentSection, DeployAgentScreen };
