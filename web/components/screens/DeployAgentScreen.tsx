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
import { TUTORIAL_LINKS } from "@/lib/tutorials";
import { LivePoolSection, UI_PRESET_TO_GEOMETRY } from "@/components/deploy/GridLiveDeploy";
import { DEFAULT_RELAY_FEE_PER_SUBMIT_WEI, gridCapitalFloorBnb, gridCapitalFloorBnbAtFee } from "@/lib/grid/economics";
import { HireGridDeploy } from "@/components/deploy/HireGridDeploy";
import { HireLpDeploy } from "@/components/deploy/HireLpDeploy";
import { HireTradeDeploy } from "@/components/deploy/HireTradeDeploy";
import { DemoTradeDeploy } from "@/components/deploy/DemoTradeDeploy";
import { DemoAgentPanel } from "@/components/demo/DemoAgentPanel";
import { HireLendingDeploy } from "@/components/deploy/HireLendingDeploy";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import type { GridHireChoices } from "@/lib/altana/grid-hire-recovery";
import { GuardedAccountSection } from "@/components/deploy/GuardedAccountSection";
import { lendingControlNumber } from "@/lib/lending/form";
import { TradeModelSelect } from "@/components/deploy/TradeModelSelect";
import { fetchSchedulable, type SchedulableTokenDto } from "@/lib/exec/schedulable";
import { TokenIcon, useTokenIcons } from "@/components/TokenIcon";
import { MAX_INSTRUCTIONS_ENCODED_BYTES,
  DEFAULT_CMC_TOTAL_BUDGET_WEI, DEFAULT_TRADFI_V2_MAX_ENTRY_WEI, DEFAULT_TRADFI_V2_MIN_ENTRY_WEI,
  MIN_TRADE_CAPITAL_WEI, MIN_TRADE_ENTRY_WEI, checkBoundedText,
  parseBnbToWei, scheduleBuysThisSession, type TradeSettings, validateSkillMarkdown,
  TRADE_LLM_MODELS, dcaMaxStepBps, stopLossBpsWhenEnabled, stopLossPercentFromBps, tradeModelId } from "@/lib/trade";
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
      { label: "Uniswap", asset: "/design/protocols/uniswap.png" },
      { label: "Ondo", asset: "/design/protocols/ondo.png" },
      { label: "PancakeSwap", asset: "/design/protocols/pancakeswap.png" },
    ], live: [
      { label: "Four.meme", asset: "/design/protocols/fourmeme.png" },
      { label: "Flap.sh", asset: "/design/protocols/flapsh.png" },
      { label: "bStocks", asset: "/design/protocols/bstocks.png" },
      { label: "Uniswap", asset: "/design/protocols/uniswap.png" },
      { label: "Ondo", asset: "/design/protocols/ondo.png" },
      { label: "PancakeSwap", asset: "/design/protocols/pancakeswap.png" },
    ] },
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
// Per-agent tutorial videos live in `lib/tutorials.ts` — the header links the
// whole playlist from the same file, so the two can never drift apart.

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
    { id: "tradfi", label: "TradFi", executionModel: "tradfi", note: "Tokenized US stocks only (bStocks, Ondo).",
      set: { confidence: "80", minMcap: "", maxMcap: "", minEntry: weiToBnb(DEFAULT_TRADFI_V2_MIN_ENTRY_WEI), perTrade: weiToBnb(DEFAULT_TRADFI_V2_MAX_ENTRY_WEI), capital: "63", maxPositions: "3" } },
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

const DEFAULT_PRESET = { grid: "balanced", trading: "tradfi", lp: "blue", health: "balanced" };

const CONFIG = {
  grid: [
    { title: "Agent", fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "Grid Agent 01" },
      { k: "capital", label: "Total capital", type: "stepper", v: "0.02", step: 0.01, min: 0.02, suffix: "BNB" },
      { k: "utilizationPct", label: "Capital utilization", type: "stepper", v: "30", step: 5, min: 30, max: 50, floor: 30, suffix: "%", tooltip: "Share of total capital held in live grid orders. Between 30% and 50%; the rest stays as idle inventory.", liveOnly: true },
      { k: "maxRequotesDaily", label: "Max requotes daily", type: "stepper", v: "16", step: 1, min: 1, max: 16, floor: 1, tooltip: "How many times per day the agent may re-place the ladder after a fill.", liveOnly: true },
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
      { k: "tradfiV2", type: "hidden", v: true, tradfiOnly: true },
      { k: "minEntry", label: "Min entry", type: "stepper", v: "5", step: 1, min: 0.000000000000000001, suffix: "USDT", tradfiOnly: true },
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
      { k: "crashProtection", label: "Crash protection", type: "check", v: true, text: "Crash protection" },
      { k: "moonbag", label: "check", type: "check", v: true, text: "Move the stop to break-even after the last take-profit target fills." },
    ] },
    { title: "Risk and execution", poweredBy: "0g", fields: [
      { k: "slippage", label: "Slippage tolerance", type: "stepper", v: "3", step: 0.5, min: 0.5, max: 5, suffix: "%", hint: "Between 0.5% and 5%." },
      { k: "gas", label: "Gas priority", type: "select", v: "Standard", options: ["Low", "Standard", "High"] },
      { k: "primary", label: "Primary model", type: "select", v: MODELS[0], options: MODELS, excludeValueOf: "fallback", showDisabledOption: true },
      { k: "fallback", label: "Fallback model", type: "select", v: MODELS[1], options: FALLBACKS, excludeValueOf: "primary", showDisabledOption: true },
    ] },
    { title: "Advanced settings", adv: true, note: "Pay-per-call data feeds and optional trading guidance. These never override wallet controls, slippage, stop-loss, or crash protection.", fields: [
      { k: "quicknode", label: "QuickNode RPC x402", type: "toggle", v: false, text: "Pay per request for faster reads", exclusiveWith: "customRpc" },
      { k: "customRpc", label: "Custom RPC", type: "toggle", v: false, text: "Use your own RPC endpoint", exclusiveWith: "quicknode", inputKey: "customRpcUrl", inputPlaceholder: "https://your-rpc-endpoint.com" },
      { k: "cmcHub", label: "CMC Agent Hub x402", type: "toggle", v: false, text: "Pay per request for CoinMarketCap agent data" },
      { k: "cmcTotalBudget", label: "CMC total budget", type: "stepper", v: weiToBnb(DEFAULT_CMC_TOTAL_BUDGET_WEI), step: 1, min: 0.000000000000000001, suffix: "USDT", cmcOnly: true, hint: "Finite total allowance for this agent. There is no daily reset; top up only with an owner action." },
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

/* TradFi — tokenized equities. One execution model with four modes; each mode
   swaps the whole form, so the filters stay specific to what that mode does.
   Only "AI Trade" reaches the plane today; the other three are ported UI and
   their Deploy stays locked until a backend exists for them. */
const TRADFI_MODES = [
  { id: "ai", label: "AI Trade", icon: RESOURCES.modeAi, note: "The model screens tokenized equities and manages entries and exits." },
  { id: "sched", label: "Schedule buy", icon: RESOURCES.modeSched, note: "Buys a fixed amount of one tokenized stock on a set frequency." },
  { id: "dca", label: "Auto DCA", icon: RESOURCES.modeDca, note: "Opens with a base order, then adds a DCA order each time price drops one step." },
  { id: "smart", label: "Smart Portfolio", icon: RESOURCES.modeSmart, note: "Holds a weighted basket and rebalances back to target." },
];

function TradFiModes({ value, onChange }) {
  const [hover, setHover] = React.useState(null);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
      {TRADFI_MODES.map((m) => {
        const on = m.id === (value || "ai");
        const tip = hover === m.id;
        return (
          <div key={m.id} style={{ position: "relative" }} onMouseEnter={() => setHover(m.id)} onMouseLeave={() => setHover((h) => (h === m.id ? null : h))}>
            <button type="button" onClick={() => onChange(m.id)} title=""
              style={{ width: "100%", textAlign: "center", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: "10px 14px", borderRadius: "var(--radius-sm)", background: on ? "var(--cat-yield-tint)" : "var(--surface-sunken)", border: `1px solid ${on ? "var(--cat-yield)" : "var(--line-1)"}` }}>
              <span aria-hidden="true" style={{ width: 32, height: 32, flex: "0 0 auto", display: "block", background: on ? "var(--cat-yield)" : "var(--ink-1)", opacity: on ? 1 : 0.65, WebkitMaskImage: `url("${m.icon}")`, maskImage: `url("${m.icon}")`, WebkitMaskSize: "contain", maskSize: "contain", WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat", WebkitMaskPosition: "center", maskPosition: "center" }} />
              <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: on ? "var(--cat-yield)" : "var(--ink-1)" }}>{m.label}</span>
            </button>
            {tip ? (
              <span role="tooltip"
                style={{ position: "absolute", left: 0, right: 0, bottom: "calc(100% + 8px)", zIndex: 20, padding: "8px 10px", borderRadius: "var(--radius-sm)", background: "var(--surface-raised, #1a1d21)", border: "1px solid var(--line-2, var(--line-1))", boxShadow: "0 8px 24px rgba(0,0,0,.45)", font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--ink-1)", display: "block" }}>
                {m.note}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* Smart Portfolio (operator rulings 2026-09-26): 2–5 stocks from the same
   17-stock liquid universe as Auto DCA, every weight at least 10 %, capital
   at least 50 USDT for two stocks plus 25 per extra stock. */
const SP_MIN_STOCKS = 2, SP_MAX_STOCKS = 5, SP_MIN_WEIGHT = 10;
const spMinCapital = (n: number): number => 50 + 25 * Math.max(0, n - SP_MIN_STOCKS);
const SP_DEFAULT_WEIGHTS = [
  { sym: "NVDAB", w: "25" },
  { sym: "MSFTB", w: "25" },
  { sym: "GOOGLB", w: "25" },
  { sym: "SPYB", w: "25" },
];
/* Quick-fill baskets: the data plane's bStock sector labels (2026-09-26),
   narrowed to the liquid universe. Fixed here; the UI does not read them live. */
const SP_BASKETS = [
  { name: "Magnificent", syms: ["MSFTB", "GOOGLB", "NVDAB", "TSLAB", "METAB"] },
  { name: "AI Chips", syms: ["NVDAB", "TSMB", "INTCB"] },
  { name: "ETF", syms: ["SPYB", "QQQB"] },
  { name: "Crypto Stocks", syms: ["CRCLB", "MSTRB", "HOODB"] },
  { name: "Memory", syms: ["SKHYB", "SNDKB"] },
  { name: "Elon Musk", syms: ["SPCXB", "TSLAB"] },
];
/* "Smart" weighting favours liquidity, fixed from the on-chain depth measured
   2026-09-24 (no live read): QQQB / SPYB have 0.01 % pools plus the deepest
   books, the other ten deep stocks come next, the five thin ones last. */
const SP_SMART_SCORE: Readonly<Record<string, number>> = {
  QQQB: 4, SPYB: 4,
  NVDAB: 3, SPCXB: 3, BABAB: 3, TSLAB: 3, GOOGLB: 3, CRCLB: 3, SKHYB: 3, METAB: 3, MSFTB: 3, TSMB: 3,
  INTCB: 1, MSTRB: 1, HOODB: 1, SOXLB: 1, SNDKB: 1,
};
function spFixSum(ws: readonly number[]): number[] {
  const out = ws.map((w) => Math.floor(w));
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = ws.map((w, i) => [w - Math.floor(w), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]]++;
  return out;
}
const spEqual = (syms: readonly string[]): number[] => spFixSum(syms.map(() => 100 / syms.length));
function spSmart(syms: readonly string[]): number[] {
  const sc = syms.map((s) => SP_SMART_SCORE[s] ?? 1);
  const fixed = syms.map(() => false);
  let ws: number[] = [];
  for (let pass = 0; pass < syms.length; pass++) {
    const free = 100 - fixed.filter(Boolean).length * SP_MIN_WEIGHT;
    const sum = sc.reduce((a, s, i) => a + (fixed[i] ? 0 : s), 0);
    ws = sc.map((s, i) => (fixed[i] ? SP_MIN_WEIGHT : (s / sum) * free));
    const low = ws.findIndex((w, i) => !fixed[i] && w < SP_MIN_WEIGHT);
    if (low < 0) break;
    fixed[low] = true;
  }
  return spFixSum(ws);
}
const spAddress = (sym: string): string => (DCA_BSTOCKS.find((s) => s.symbol === sym) ?? DCA_BSTOCKS[0]).address;
const spRows = (value) => (Array.isArray(value) ? value : SP_DEFAULT_WEIGHTS) as readonly { readonly sym: string; readonly w: string }[];

/* Same hand-drawn listbox as DcaStockField, so each row carries a logo. */
function SpStockPicker({ value, options, icons, onChange }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLSpanElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <span ref={rootRef} style={{ position: "relative", flex: "0 0 auto", width: 112 }}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={"Change " + value} onClick={() => setOpen((v) => !v)}
        style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: "4px 0", background: "transparent", border: "none", color: "var(--ink-1)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)" }}>
        <TokenIcon src={icons[spAddress(value)] ?? null} symbol={value} size={22} />
        <span>{value}</span>
        <Icon name="chevron-down" size={13} />
      </button>
      {open ? <div role="listbox" aria-label="Tokenized stock" style={{ position: "absolute", top: "calc(100% + 4px)", left: -8, width: "max-content", minWidth: 124, zIndex: 20, maxHeight: 320, overflowY: "auto",
        background: "var(--surface-input)", border: "var(--border-width) solid var(--border-control)", borderRadius: "var(--radius-sm)", padding: 4 }}>
        {options.map((sym) => <button key={sym} type="button" role="option" aria-selected={sym === value} onClick={() => { onChange(sym); setOpen(false); }}
          style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 10px", border: 0, background: sym === value ? "var(--surface-sunken)" : "transparent", color: "var(--ink-1)", font: "var(--type-body-md)", cursor: "pointer", textAlign: "left" }}>
          <TokenIcon src={icons[spAddress(sym)] ?? null} symbol={sym} size={20} />
          <span>{sym}</span>
        </button>)}
      </div> : null}
    </span>
  );
}

function WeightsField({ value, onChange: setRows, values, set }) {
  const rows = spRows(value);
  const icons = useTokenIcons(DCA_BSTOCKS.map((s) => s.address));
  // weighting: "smart" | "equal" while the rows are exactly what that button
  // produced; any hand edit clears the highlight.
  const onChange = (next, weighting: string | null = null) => {
    setRows(next);
    set("weighting", weighting);
    // Total capital follows the stock count while it sits at the old floor
    // (the default), and is always raised to the new floor.
    const c = dcaNum(values.capital), m = spMinCapital(next.length), old = spMinCapital(rows.length);
    if (!Number.isFinite(c) || c < m || (c === old && m !== old)) set("capital", String(m));
  };
  const total = rows.reduce((a, r) => a + (parseFloat(r.w) || 0), 0);
  const remaining = 100 - total;
  const setRow = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const avail = DCA_BSTOCKS.map((s) => s.symbol as string).filter((s) => !rows.some((r) => r.sym === s));
  const apply = (syms: readonly string[], fn: (s: readonly string[]) => number[], weighting: string) => { const ws = fn(syms); onChange(syms.map((s, i) => ({ sym: s, w: String(ws[i]) })), weighting); };
  const canAdd = rows.length < SP_MAX_STOCKS && avail.length > 0;
  const canRemove = rows.length > SP_MIN_STOCKS;
  const pill = { cursor: "pointer", padding: "7px 14px", borderRadius: 999, background: "var(--surface-sunken)", border: "1px solid var(--line-1)", color: "var(--text-muted)", font: "var(--weight-medium) var(--text-xs)/1 var(--font-sans)" };
  const pillOn = (on: boolean) => (on ? { ...pill, background: "var(--cat-yield-tint)", border: "1px solid var(--cat-yield)", color: "var(--cat-yield)" } : pill);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {SP_BASKETS.map((b) => (
          <button key={b.name} type="button" onClick={() => apply(b.syms, spEqual, "equal")} title={b.syms.join(", ")}
            style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "8px 14px 8px 10px", borderRadius: 999, background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
            <span style={{ display: "flex" }}>{b.syms.map((s, i) => <TokenIcon key={s} src={icons[spAddress(s)] ?? null} symbol={s} size={22} offset={i ? -7 : 0} />)}</span>
            <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)", whiteSpace: "nowrap" }}>{b.name}</span>
          </button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" aria-pressed={values.weighting === "smart"} style={pillOn(values.weighting === "smart")} title="More weight on the most liquid stocks, each at least 10 %." onClick={() => apply(rows.map((r) => r.sym), spSmart, "smart")}>Smart</button>
          <button type="button" aria-pressed={values.weighting === "equal"} style={pillOn(values.weighting === "equal")} onClick={() => apply(rows.map((r) => r.sym), spEqual, "equal")}>Equal</button>
        </div>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--text-muted)" }}>
          Remaining <span style={{ color: remaining === 0 ? "var(--ink-1)" : "var(--loss)" }}>{remaining > 0 ? "+" : ""}{remaining}%</span>/100%
        </span>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={r.sym} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
            <SpStockPicker value={r.sym} options={[r.sym, ...avail]} icons={icons} onChange={(sym) => setRow(i, { sym })} />
            <span style={{ flex: 1, minWidth: 40, height: 6, borderRadius: 999, background: "var(--line-1)", overflow: "hidden", display: "block" }}>
              <span style={{ display: "block", height: "100%", width: `${Math.min(100, parseFloat(r.w) || 0)}%`, background: "var(--cat-yield)" }} />
            </span>
            <span style={{ width: 148, flex: "0 0 auto" }}>
              <NumStepper value={r.w} onChange={(v) => setRow(i, { w: v })} step={5} min={SP_MIN_WEIGHT} max={100 - SP_MIN_WEIGHT * (rows.length - 1)} suffix="%" />
            </span>
            <button type="button" disabled={!canRemove} onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={"Remove " + r.sym}
              style={{ cursor: canRemove ? "pointer" : "not-allowed", opacity: canRemove ? 1 : 0.35, width: 26, height: 26, borderRadius: 6, border: "1px solid var(--line-1)", background: "transparent", color: "var(--text-subtle)", fontSize: 15, lineHeight: 1, flex: "0 0 auto" }}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        {canAdd ? (
          <select value="" onChange={(e) => e.target.value && onChange([...rows, { sym: e.target.value, w: String(SP_MIN_WEIGHT) }])} style={{ ...pill, padding: "7px 10px" }}>
            <option value="">+ Add Stocks</option>
            {avail.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        ) : <span />}
      </div>
    </div>
  );
}

function SpChips({ options, value, onChange, fmt = (o) => o }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`, gap: 8 }}>
      {options.map((o) => {
        const on = o === value;
        return <button key={o} type="button" aria-pressed={on} onClick={() => onChange(o)}
          style={{ cursor: "pointer", padding: "12px 10px", borderRadius: "var(--radius-sm)", background: on ? "var(--cat-yield-tint)" : "var(--surface-sunken)", border: `1px solid ${on ? "var(--cat-yield)" : "var(--line-1)"}`, font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: on ? "var(--cat-yield)" : "var(--ink-1)" }}>{fmt(o)}</button>;
      })}
    </div>
  );
}

/* The design referenced `FieldLabel` without shipping it. It wraps a control
   in the label / control / hint order every other field on this screen uses.
   `tooltip` reuses the generic per-field renderer's own info-glyph affordance
   (line ~1316) instead of a second hint line, for a label whose explanation
   is long enough to crowd the field. */
function FieldLabel({ label, hint, tooltip, children }) {
  return (
    <>
      <label className="fl-field__label">{label}{typeof tooltip === "string" ? <span aria-label={tooltip} title={tooltip} tabIndex={0} style={{ display: "inline-grid", placeItems: "center", width: 13, height: 13, marginLeft: 6, border: "1px solid var(--line-1)", borderRadius: "50%", color: "var(--text-subtle)", cursor: "help", font: "var(--weight-medium) 9px/1 var(--font-mono)" }}>i</span> : null}</label>
      {children}
      {hint ? <span className="fl-field__hint">{hint}</span> : null}
    </>
  );
}

const SCHED_FREQS = ["1 hour", "4 hours", "8 hours", "12 hours", "Daily", "Weekly"];
const SCHED_INTERVALS: Record<string, 3600 | 14400 | 28800 | 43200 | 86400> = { "1 hour": 3600, "4 hours": 14400, "8 hours": 28800, "12 hours": 43200, Daily: 86400 };
const SCHED_FIRST = ["Now", "Custom"];
const SCHED_TIMES = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0") + ":00");

/* Conservative buys estimate for the deploy screen's own hints — no live
   preview fetch exists here (only the hire flow reads one), so this mirrors
   the same MAX_PLATFORM_FEE_BPS ceiling the schedule blocked-reason check
   below already uses for "at least one buy plus the platform fee". */
function scheduleBuysEstimate(values) {
  const amountWei = parseBnbToWei(String(values.schedAmount ?? "0"));
  const totalWei = parseBnbToWei(String(values.capital ?? "0"));
  const reservation = amountWei + amountWei * 500n / 10_000n;
  const intervalSec = SCHED_INTERVALS[String(values.schedFreq ?? "Daily")] ?? 86400;
  if (reservation <= 0n) return { plannedBuys: 0, buysThisSession: scheduleBuysThisSession(604_800, intervalSec) };
  const raw = Number(totalWei / reservation);
  const bounded = Number.isSafeInteger(raw) ? raw : Number.MAX_SAFE_INTEGER;
  const byRuns = values.endRule === "runs" ? Math.min(bounded, Math.max(1, Math.min(1000, Number(values.endRuns ?? 1)))) : bounded;
  const firstAtSec = values.schedFirst === "Custom" && values.schedStartDate
    ? Math.floor(new Date(`${values.schedStartDate}T${values.schedStartTime || "00:00"}:00`).getTime() / 1_000) : Math.floor(Date.now() / 1_000);
  const endAtSec = values.endRule === "date" && values.endDate ? Math.floor(new Date(`${values.endDate}T23:59:59`).getTime() / 1_000) : null;
  const plannedBuys = values.endRule === "date" && endAtSec !== null
    ? Math.min(byRuns, Math.max(0, Math.floor((endAtSec * 1_000 - firstAtSec * 1_000 - 1) / (intervalSec * 1_000)) + 1))
    : byRuns;
  return { plannedBuys, buysThisSession: scheduleBuysThisSession(604_800, intervalSec) };
}

function ScheduleField({ values, set }) {
  const freq = values.schedFreq || "Daily";
  const first = values.schedFirst || "Now";
  const estimate = scheduleBuysEstimate(values);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>Frequency</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 8 }}>
          {SCHED_FREQS.map((o) => {
            const on = o === freq;
            return (
              <button key={o} type="button" disabled={o === "Weekly"} aria-disabled={o === "Weekly"} title={o === "Weekly" ? "Needs a session longer than 7 days." : undefined} onClick={() => o !== "Weekly" && set("schedFreq", o)}
                style={{ cursor: o === "Weekly" ? "not-allowed" : "pointer", opacity: o === "Weekly" ? 0.4 : 1, padding: "12px 10px", borderRadius: "var(--radius-sm)", background: on ? "var(--cat-yield-tint)" : "var(--surface-sunken)", border: `1px solid ${on ? "var(--cat-yield)" : "var(--line-1)"}`, font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: on ? "var(--cat-yield)" : "var(--ink-1)" }}>{o}</button>
            );
          })}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }}>
        <div className="fl-field">
          <FieldLabel label="First buy time" tooltip={first === "Now" ? "The first cycle runs as soon as the agent is deployed, then repeats on the frequency above." : "The first cycle runs at the date and time you pick, then repeats on the frequency above."}>
            <Select value={first} options={SCHED_FIRST} onChange={(e) => set("schedFirst", e.target.value)} />
          </FieldLabel>
        </div>
        {first === "Custom" ? (
          <div className="fl-field">
            <label className="fl-field__label">Start date</label>
            <input type="date" value={values.schedStartDate || ""} onChange={(e) => set("schedStartDate", e.target.value)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-input)", border: "1px solid var(--line-1)", color: "var(--ink-1)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", outline: "none" }} />
          </div>
        ) : null}
        {first === "Custom" ? (
          <div className="fl-field">
            <label className="fl-field__label">Start time <span style={{ color: "var(--text-subtle)", fontWeight: "var(--weight-regular)" }}>(your local time)</span></label>
            <Select value={values.schedStartTime || "18:00"} options={SCHED_TIMES} onChange={(e) => set("schedStartTime", e.target.value)} />
          </div>
        ) : null}
      </div>
      <span data-testid="schedule-session-hint" style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>
        Your 7-day session covers up to {estimate.buysThisSession} buys; {estimate.plannedBuys} are planned. Renew the session after it expires to continue.
      </span>
    </div>
  );
}

/* Auto DCA universe (operator 2026-09-24): bStocks with a usable Pancake V3
   USDT pool, measured on chain that day. QQQB and SPYB use their 0.01% pools;
   the rest sit on 0.25%. */
const DCA_BSTOCKS = [
  { symbol: "NVDAB", address: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", feeBps: 25 },
  { symbol: "SPCXB", address: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1", feeBps: 25 },
  { symbol: "BABAB", address: "0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec", feeBps: 25 },
  { symbol: "TSLAB", address: "0x5b1910eaad6450e50f816082aa078c41f10c292f", feeBps: 25 },
  { symbol: "QQQB", address: "0x205812cdbed920aff76c6580abd681a46d11efc7", feeBps: 1 },
  { symbol: "GOOGLB", address: "0x3f53de71c126bdabae20f9cd64848d317f6c3238", feeBps: 25 },
  { symbol: "CRCLB", address: "0x80f3d493ebce97e343c53d29a137942416b4ffc0", feeBps: 25 },
  { symbol: "SKHYB", address: "0xca750ef65f295bbecd685abf54e82caf297bdb61", feeBps: 25 },
  { symbol: "METAB", address: "0x7425889fe94f9d693e8daefe88bcced6acfef4c0", feeBps: 25 },
  { symbol: "MSFTB", address: "0x80106cb3ead06659a5ad19df39d9b4733863b9b0", feeBps: 25 },
  { symbol: "TSMB", address: "0xab78b89b5bb00236be0b4b20704cbfa04efc711c", feeBps: 25 },
  { symbol: "SPYB", address: "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8", feeBps: 1 },
  { symbol: "INTCB", address: "0xe614e2fc6c787035ff51f452e8e826bfd32d5283", feeBps: 25 },
  { symbol: "MSTRB", address: "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14", feeBps: 25 },
  { symbol: "HOODB", address: "0xa394dcea3fd3847fd793afbfd163e2e3858b7c65", feeBps: 25 },
  { symbol: "SOXLB", address: "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf", feeBps: 25 },
  { symbol: "SNDKB", address: "0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb", feeBps: 25 },
] as const;
/** Max DCA orders default: 3 on the 0.25 % pools, 4 on the 0.01 % pools (operator 2026-09-25, D4). */
const dcaDefaultMaxOrders = (symbol): string => ((DCA_BSTOCKS.find((stock) => stock.symbol === symbol) ?? DCA_BSTOCKS[0]).feeBps === 1 ? "4" : "3");
const dcaNum = (s) => parseFloat(String(s == null ? "" : s).replace(/,/gu, ""));
/* A USDT price as the signed ×1e8 canonical decimal (§8.1); null when not a positive number. */
const dcaE8 = (s): string | null => {
  const text = String(s == null ? "" : s).replace(/,/gu, "").trim();
  if (!/^\d+(?:\.\d{0,8})?$/u.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const value = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
  return value > 0n ? value.toString(10) : null;
};

/* Same hand-drawn listbox as BstockField (a native <option> cannot carry a
   logo), over the fixed Auto DCA universe instead of live quotes. */
function DcaStockField({ f, value, onChange }) {
  const selected = DCA_BSTOCKS.find((s) => s.symbol === value) ?? DCA_BSTOCKS[0];
  const icons = useTokenIcons(DCA_BSTOCKS.map((s) => s.address));
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const rowStyle = (active: boolean) => ({ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px var(--space-5)", border: 0,
    background: active ? "var(--surface-sunken)" : "transparent", color: "var(--ink-1)", font: "var(--type-body-md)", cursor: "pointer", textAlign: "left" as const });
  return <div className="fl-field" ref={rootRef}>
    <label className="fl-field__label" htmlFor="fl-sel-dca-stock">{f.label}</label>
    <div className="fl-select-wrap" style={{ position: "relative" }}>
      <button id="fl-sel-dca-stock" type="button" className="fl-select" aria-haspopup="listbox" aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left" }} onClick={() => setOpen((v) => !v)}>
        <TokenIcon src={icons[selected.address] ?? null} symbol={selected.symbol} size={20} />
        <span>{selected.symbol}</span>
      </button>
      <span className="fl-select__chev"><Icon name="chevron-down" size={15} /></span>
      {open ? <div role="listbox" aria-label={f.label} style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20, maxHeight: 320, overflowY: "auto",
        background: "var(--surface-input)", border: "var(--border-width) solid var(--border-control)", borderRadius: "var(--radius-sm)", padding: 4 }}>
        {DCA_BSTOCKS.map((s) => <button key={s.address} type="button" role="option" aria-selected={s.symbol === selected.symbol} style={rowStyle(s.symbol === selected.symbol)}
          onClick={() => { onChange(s.symbol); setOpen(false); }}>
          <TokenIcon src={icons[s.address] ?? null} symbol={s.symbol} size={20} />
          <span>{s.symbol}</span>
        </button>)}
      </div> : null}
    </div>
  </div>;
}

/* Price range: buys (base + DCA) only fill while price sits inside [min, max]. */
function DcaRangeField({ values, set }) {
  const on = !!values.dcaRangeOn;
  const lo = dcaNum(values.dcaRangeMin), hi = dcaNum(values.dcaRangeMax);
  const bad = on && Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi;
  return (
    <div style={{ gridColumn: "span 2", display: "grid", gap: 8 }}>
      <Checkbox checked={on} onChange={(v) => set("dcaRangeOn", v)}>Price range</Checkbox>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8, opacity: on ? 1 : 0.4, pointerEvents: on ? "auto" : "none" }}>
        <NumStepper prefix="Min" value={values.dcaRangeMin} onChange={(v) => set("dcaRangeMin", v)} step={1} min={0} suffix="USDT" />
        <NumStepper prefix="Max" value={values.dcaRangeMax} onChange={(v) => set("dcaRangeMax", v)} step={1} min={0} suffix="USDT" />
      </div>
      {bad ? <span style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--warn)" }}>Min must be below max.</span> : null}
    </div>
  );
}

/* Total capital = base order + DCA order × max DCA orders. Read-only. */
function DcaTotalField({ f, values }) {
  const b = dcaNum(values.dcaBase), o = dcaNum(values.dcaOrder), m = dcaNum(values.dcaMaxOrders);
  const ok = Number.isFinite(b) && Number.isFinite(o) && Number.isFinite(m);
  return (
    <div className="fl-field">
      <label className="fl-field__label">{f.label}</label>
      <div aria-readonly="true" title="Base order size + DCA order size × Max DCA orders" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, height: 40, boxSizing: "border-box", padding: "0 12px", borderRadius: "var(--radius-sm)", background: "var(--cat-yield-tint)", border: "1px solid var(--cat-yield)", cursor: "not-allowed" }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: ok ? "var(--ink-1)" : "var(--text-subtle)" }}>{ok ? (b + o * m).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "--"}</span>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--text-subtle)" }}>USDT</span>
      </div>
    </div>
  );
}

function BstockField({ values, set }) {
  const [state, setState] = React.useState<{ kind: "idle" | "loading" | "ready" | "empty" | "error"; tokens: readonly SchedulableTokenDto[]; message?: string }>({ kind: "idle", tokens: [] });
  React.useEffect(() => {
    const amount = parseBnbToWei(String(values.schedAmount ?? "0"));
    const slippageBps = Math.round(Number(values.slippage ?? "1") * 100);
    if (amount < 5n * 10n ** 18n || !Number.isInteger(slippageBps)) { setState({ kind: "idle", tokens: [] }); return; }
    const controller = new AbortController();
    // Re-quoting keeps the previous list selectable (stale-while-revalidate):
    // the set of quotable bStocks barely moves between amounts, and a blank
    // control on every keystroke reads as broken.
    setState((previous) => ({ kind: "loading", tokens: previous.tokens }));
    const timer = window.setTimeout(() => {
      void fetchSchedulable(amount.toString(10), slippageBps, controller.signal)
        .then((result) => setState(result.tokens.length === 0 ? { kind: "empty", tokens: [] } : { kind: "ready", tokens: result.tokens }))
        .catch((error: unknown) => { if (!controller.signal.aborted) setState((previous) => ({ kind: "error", tokens: previous.tokens, message: error instanceof Error ? error.message : "Quotes are unavailable." })); });
    }, 600);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [values.schedAmount, values.slippage]);
  const selected = values.schedAsset?.address ?? "";
  const icons = useTokenIcons(state.tokens.map((token) => token.address));
  const selectedToken = state.tokens.find((token) => token.address.toLowerCase() === selected.toLowerCase()) ?? null;
  React.useEffect(() => {
    // A token that stopped quoting at the new amount must not stay in the signed tuple.
    if (state.kind === "ready" && selected !== "" && selectedToken === null) set("schedAsset", null);
  }, [state.kind, selected, selectedToken]);
  // A listbox drawn by hand, because a native <option> cannot carry a logo. The
  // trigger reuses the design-system .fl-select look so the row matches the
  // three controls beside it.
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const hint = state.kind === "loading" ? undefined
    : state.kind === "empty" ? "No bStock quotes at this amount. Lower the amount per buy."
      : state.kind === "error" ? "— quotes unavailable right now; try again in a moment." : undefined;
  const choose = (token: SchedulableTokenDto | null) => { set("schedAsset", token === null ? null : { address: token.address.toLowerCase(), symbol: token.symbol }); setOpen(false); };
  const rowStyle = (active: boolean) => ({ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px var(--space-5)", border: 0,
    background: active ? "var(--surface-sunken)" : "transparent", color: "var(--ink-1)", font: "var(--type-body-md)", cursor: "pointer", textAlign: "left" as const });
  return <div className="fl-field" ref={rootRef}>
    <label className="fl-field__label" htmlFor="fl-sel-tokenized-stock">Tokenized stock</label>
    <div className="fl-select-wrap" style={{ position: "relative" }}>
      <button id="fl-sel-tokenized-stock" type="button" className="fl-select" disabled={state.tokens.length === 0} aria-haspopup="listbox" aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left" }} onClick={() => setOpen((value) => !value)}>
        {selectedToken !== null ? <TokenIcon src={icons[selectedToken.address.toLowerCase()] ?? null} symbol={selectedToken.symbol} size={20} /> : null}
        <span>{selectedToken !== null ? selectedToken.symbol : state.tokens.length > 0 ? "Select a bStock" : state.kind === "loading" || state.kind === "idle" ? "Loading…" : "No quoted bStocks yet"}</span>
      </button>
      <span className="fl-select__chev"><Icon name="chevron-down" size={15} /></span>
      {open ? <div role="listbox" aria-label="Tokenized stock" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20, maxHeight: 320, overflowY: "auto",
        background: "var(--surface-input)", border: "var(--border-width) solid var(--border-control)", borderRadius: "var(--radius-sm)", padding: 4 }}>
        <button type="button" role="option" aria-selected={selectedToken === null} style={rowStyle(selectedToken === null)} onClick={() => choose(null)}>Select a bStock</button>
        {state.tokens.map((token) => <button key={token.address} type="button" role="option" aria-selected={selectedToken?.address === token.address} style={rowStyle(selectedToken?.address === token.address)} onClick={() => choose(token)}>
          <TokenIcon src={icons[token.address.toLowerCase()] ?? null} symbol={token.symbol} size={20} />
          <span>{token.symbol}</span>
        </button>)}
      </div> : null}
    </div>
    {hint !== undefined ? <span className="fl-field__hint">{hint}</span> : null}
  </div>;
}

/* NAV guard: a premium ceiling against the underlying stock. A breach holds the
   cycle rather than cancelling the agent, the same way a buy price range does. */
function NavGuardField({ values, set }) {
  const on = values.navGuard !== false;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Checkbox checked={on} onChange={(v) => set("navGuard", v)}>Guard NAV — do not buy while the token trades above the stock it tracks.</Checkbox>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }}>
        <div className="fl-field" style={{ opacity: on ? 1 : 0.4, pointerEvents: on ? "auto" : "none" }}>
          <FieldLabel label="Max premium to NAV" tooltip="A breach postpones that cycle instead of cancelling it: the buy is skipped for the period and the schedule resumes at the next cycle once the premium is back inside the limit — the same behaviour as a buy price range. The platform never buys above +1.5% regardless.">
            <NumStepper value={values.navPremium} onChange={(v) => set("navPremium", v)} step={0.1} min={0.5} max={1.5} suffix="%" />
          </FieldLabel>
        </div>
        <div className="fl-field">
          <FieldLabel label="Slippage tolerance" hint="Between 0.5% and 5%.">
            <NumStepper value={values.slippage} onChange={(v) => set("slippage", v)} step={0.5} min={0.5} max={5} suffix="%" />
          </FieldLabel>
        </div>
      </div>
    </div>
  );
}

const END_RULES = [
  { id: "budget", label: "Run until the budget is spent" },
  { id: "date", label: "Run until a date" },
  { id: "runs", label: "Run a set number of times" },
];

function EndRuleField({ values, set }) {
  const sel = values.endRule || "budget";
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8, alignItems: "start" }}>
      {END_RULES.map((r) => {
        const on = r.id === sel;
        return (
          <div key={r.id} style={{ display: "grid", gap: 10, padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: `1px solid ${on ? "var(--cat-yield)" : "var(--line-1)"}` }}>
            <Checkbox checked={on} onChange={() => set("endRule", r.id)}>{r.label}</Checkbox>
            {r.id === "date" && on ? (
              <input type="date" value={values.endDate || ""} onChange={(e) => set("endDate", e.target.value)}
                style={{ width: "100%", padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-input)", border: "1px solid var(--line-1)", color: "var(--ink-1)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", outline: "none" }} />
            ) : null}
            {r.id === "runs" && on ? (
              <NumStepper value={values.endRuns} onChange={(v) => set("endRuns", v)} step={1} min={1} suffix="runs" />
            ) : null}
          </div>
        );
      })}
      </div>
      <span style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>Pick one. Postponed cycles do not count as runs.</span>
    </div>
  );
}

const TF_MODE_SECTION = { title: "Mode", fields: [{ k: "tradfiMode", type: "tradfiModes", v: "ai" }] };

const TF_RISK = { title: "Risk and execution", checkRow: true, poweredBy: "0g", fields: [
  { k: "slippage", label: "Slippage tolerance", type: "stepper", v: "1", step: 0.5, min: 0.5, max: 5, suffix: "%", hint: "Between 0.5% and 5%." },
  { k: "crashProtection", label: "check", type: "check", v: true, text: "Crash protection" },
  { k: "noReentry", label: "check", type: "check", v: false, text: "No re-entry" },
  { k: "gas", label: "Gas priority", type: "select", v: "Standard", options: ["Low", "Standard", "High"] },
  { k: "primary", label: "Primary model", type: "select", v: MODELS[0], options: MODELS, excludeValueOf: "fallback", showDisabledOption: true },
  { k: "fallback", label: "Fallback model", type: "select", v: MODELS[1], options: FALLBACKS, excludeValueOf: "primary", showDisabledOption: true },
] };

/* Schedule buy, DCA and portfolio rebalancing are deterministic: no model row. */
const TF_RISK_RULES = { title: "Risk and execution", cols: 4, fields: [
  { k: "slippage", label: "Slippage tolerance", type: "stepper", v: "1", step: 0.5, min: 0.5, max: 5, suffix: "%", hint: "Between 0.5% and 5%." },
] };

/* Schedule buy, Auto DCA and Smart Portfolio run to fixed rules: no model
   guidance, no paid market data — only routing and gas. */
const TF_ADV_RULES = { title: "Advanced settings", adv: true, note: "Execution routing. These never override wallet controls, slippage, stop-loss, or the market-hours guard.", fields: [
  { k: "gas", label: "Gas priority", type: "select", v: "Standard", options: ["Low", "Standard", "High"] },
  { k: "quicknode", label: "QuickNode RPC x402", type: "toggle", v: false, text: "Pay per request for faster reads", exclusiveWith: "customRpc" },
  { k: "customRpc", label: "Custom RPC", type: "toggle", v: false, text: "Use your own RPC endpoint", exclusiveWith: "quicknode", inputKey: "customRpcUrl", inputPlaceholder: "https://your-rpc-endpoint.com" },
] };
const TF_ADV_PORTFOLIO = { ...TF_ADV_RULES, note: "Execution routing. These never override wallet controls, slippage or stop-loss." };

const TF_ADV = { title: "Advanced settings", adv: true, note: "Pay-per-call data feeds and optional trading guidance. These never override wallet controls, slippage, stop-loss, or the market-hours guard.", fields: [
  { k: "quicknode", label: "QuickNode RPC x402", type: "toggle", v: false, text: "Pay per request for faster reads", exclusiveWith: "customRpc" },
  { k: "customRpc", label: "Custom RPC", type: "toggle", v: false, text: "Use your own RPC endpoint", exclusiveWith: "quicknode", inputKey: "customRpcUrl", inputPlaceholder: "https://your-rpc-endpoint.com" },
  { k: "cmcHub", label: "CMC Agent Hub x402", type: "toggle", v: false, text: "Pay per request for CoinMarketCap agent data" },
  { k: "cmcTotalBudget", label: "CMC total budget", type: "stepper", v: weiToBnb(DEFAULT_CMC_TOTAL_BUDGET_WEI), step: 1, min: 0.000000000000000001, suffix: "USDT", cmcOnly: true, hint: "Finite total allowance for this agent. There is no daily reset; top up only with an owner action." },
  { k: "instructions", label: "Instructions", type: "textarea", v: "", byteLimit: MAX_INSTRUCTIONS_ENCODED_BYTES, placeholder: "Example: Favour post-earnings drift on large-cap tech. Stay flat through rate decisions.", hint: "Soft preference layer only. Use plain English or Chinese to describe the setups this agent should favor or avoid." },
  { k: "skillFile", label: "Add Skill", type: "skillFile", v: null },
] };

const TRADFI_SECTIONS = {
  ai: [
    { title: "Agent", cols: 5, fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "TradFi Trade Agent" },
      { k: "tradfiV2", type: "hidden", v: true },
      { k: "capital", label: "Total capital", type: "stepper", v: "63", step: 1, min: 0.000000000000000001, suffix: "USDT" },
      { k: "minEntry", label: "Min per entry", type: "stepper", v: weiToBnb(DEFAULT_TRADFI_V2_MIN_ENTRY_WEI), step: 1, min: 0.000000000000000001, suffix: "USDT" },
      { k: "perTrade", label: "Max per entry", type: "stepper", v: weiToBnb(DEFAULT_TRADFI_V2_MAX_ENTRY_WEI), step: 1, min: 0.000000000000000001, suffix: "USDT" },
      { k: "maxPositions", label: "Max open positions", type: "stepper", v: "3", step: 1, min: 1 },
    ] },
    { title: "Exit (if you do not make a choice, the LLM model will decide)", fields: [
      { k: "tp1On", type: "hidden", v: false },
      { k: "tp1", label: "Take profit", type: "numToggle", on: "tp1On", v: "25", suffix: "%", step: 5, min: 0 },
      { k: "stopLossOn", type: "hidden", v: false },
      { k: "stopLoss", label: "Stop loss", type: "numToggle", on: "stopLossOn", v: "15", suffix: "%", step: 5, min: 0, max: 100 },
      { k: "holdTimeOn", type: "hidden", v: false },
      { k: "holdTime", label: "Max holding time", type: "numToggle", on: "holdTimeOn", v: "4,320", suffix: "min", step: 60, min: 60, offNote: "No limit — LLM model decides when to exit." },
    ] },
    TF_RISK, TF_ADV,
  ],
  sched: [
    // R2.10 (LOW-7): no model row (deterministic, no LLM) — this note explains why in its place.
    { title: "Agent", fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "TradFi Schedule Agent" },
      { k: "schedAsset", type: "bstockSelect", v: null },
      { k: "capital", label: "Total budget", type: "stepper", v: "50", step: 5, min: 5, suffix: "USDT" },
      { k: "schedAmount", label: "Amount per buy", type: "stepper", v: "5", step: 1, min: 5, suffix: "USDT" },
    ] },
    { title: "Schedule", fields: [
      { k: "schedFreq", type: "hidden", v: "Daily" },
      { k: "schedFirst", type: "hidden", v: "Now" },
      { k: "schedStartDate", type: "hidden", v: "2026-09-21" },
      { k: "schedStartTime", type: "hidden", v: "18:00" },
      { k: "scheduleUI", type: "scheduleGroup", v: null },
    ] },
    { title: "Risk and execution", fields: [
      { k: "navGuard", type: "hidden", v: true },
      { k: "navPremium", type: "hidden", v: "1.5" },
      { k: "slippage", type: "hidden", v: "1" },
      { k: "navGuardUI", type: "navGuard", v: null },
      { k: "sessionGuard", label: "check", type: "check", v: false, text: "Only buy during US market hours (9:30–16:00 ET, Mon–Fri). Exchange holidays are not modelled." },
    ] },
    { title: "Finish", fields: [
      { k: "endRule", type: "hidden", v: "budget" },
      { k: "endDate", type: "hidden", v: "2026-12-31" },
      { k: "endRuns", type: "hidden", v: "12" },
      { k: "endRuleUI", type: "endRule", v: null },
    ] },
    TF_ADV_RULES,
  ],
  // Auto DCA (AUTO-DCA-SPEC §14.1): wired to the signed DCA tuple; bounds follow
  // the operator's rulings (operator 2026-09-25: base at least 25 USDT, take profit at least 1.5 % on every stock; the plane still accepts 15 / 1 %).
  dca: [
    { title: "Agent", cols: 4, fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "TradFi DCA Agent" },
      { k: "dcaAsset", label: "Tokenized stock", type: "dcaStock", v: "NVDAB" },
      { k: "dcaStep", label: "Price drop steps", type: "stepper", v: "1", step: 0.5, min: 1, max: 30, suffix: "%" },
      { k: "dcaTp", label: "Take profit", type: "stepper", v: "1.5", step: 0.5, min: 1.5, suffix: "%" },
      { k: "dcaBase", label: "Base order size", type: "stepper", v: "25", step: 5, min: 25, suffix: "USDT" },
      { k: "dcaOrder", label: "DCA order size", type: "stepper", v: "10", step: 10, min: 10, suffix: "USDT" },
      { k: "dcaMaxOrders", label: "Max DCA orders", type: "stepper", v: "3", step: 1, min: 1, max: 8 },
      { k: "dcaTotal", label: "Total Delegated", type: "dcaTotal", v: null },
    ] },
    { title: "Entry", cols: 3, fields: [
      { k: "dcaTriggerOn", type: "hidden", v: false },
      { k: "dcaTrigger", label: "Trigger price", type: "numToggle", on: "dcaTriggerOn", v: "178", suffix: "USDT", step: 1, min: 0, offNote: "Off. The base order buys at market on deploy." },
      { k: "dcaRangeOn", type: "hidden", v: false },
      { k: "dcaRangeMin", type: "hidden", v: "150" },
      { k: "dcaRangeMax", type: "hidden", v: "200" },
      { k: "dcaRangeUI", type: "dcaRange", v: null },
    ] },
    { title: "Exit", cols: 4, fields: [
      { k: "dcaSlOn", type: "hidden", v: false },
      { k: "dcaSl", label: "Stop loss", type: "numToggle", on: "dcaSlOn", v: "15", suffix: "%", step: 1, min: 0 },
      { k: "slippage", label: "Slippage tolerance", type: "num", alignAsCheckbox: true, v: "1", step: 0.5, min: 0.5, max: 5, suffix: "%" },
    ] },
    TF_ADV_RULES,
  ],
  smart: [
    { title: "Agent", fields: [
      { k: "agentName", label: "Agent name", type: "text", v: "TradFi Portfolio Agent" },
      { k: "capital", label: "Total capital", type: "stepper", v: "100", step: 25, min: 50, suffix: "USDT" },
    ] },
    { title: "Allocation", fields: [
      { k: "weighting", type: "hidden", v: "equal" },
      { k: "weights", type: "weights", v: null },
    ] },
    { title: "Rebalance", cols: 4, fields: [
      { k: "drift", label: "Rebalance when drift exceeds", type: "stepper", v: "5", step: 0.5, min: 0.5, max: 15, suffix: "%" },
      { k: "rebalanceEvery", label: "Rebalance every", type: "segChips", span: 3, v: "Daily", options: ["4h", "8h", "12h", "Daily"] },
    ] },
    TF_RISK_RULES, TF_ADV_PORTFOLIO,
  ],
};

function tradfiSections(mode) {
  return [TF_MODE_SECTION].concat(TRADFI_SECTIONS[mode] || TRADFI_SECTIONS.ai);
}

function sectionsFor(kind, presetId, mode = "Live", values) {
  if (kind === "lp") return presetId === "blue" ? CONFIG.lpCustom : CONFIG.lp;
  if (kind === "trading" && presetId === "tradfi") return tradfiSections(values && values.tradfiMode);
  const sections = CONFIG[kind];
  return mode === "Live" ? sections : sections.map((section) => ({
    ...section,
    fields: section.fields.filter((field) => !field.liveOnly),
  }));
}

function defaults(kind, presetId) {
  const pid = presetId || DEFAULT_PRESET[kind];
  const out = {};
  const collect = (secs) => secs.forEach((s) => s.fields.forEach((f) => { out[f.k] = f.v; }));
  if (kind === "trading" && pid === "tradfi") {
    /* Reverse order so the default mode's values win on shared keys. */
    TRADFI_MODES.slice().reverse().forEach((m) => collect(tradfiSections(m.id)));
  } else {
    collect(sectionsFor(kind, pid));
  }
  const p = PRESETS[kind].find((x) => x.id === pid);
  return p ? { ...out, ...p.set } : out;
}

function decimalOrNull(value) {
  const normalized = String(value ?? "").replace(/,/gu, "").trim();
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseUtilization(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const percent = Number(raw);
  return Number.isInteger(percent) && percent >= 30 && percent <= 50 && percent % 5 === 0 ? percent * 100 : null;
}

function parseRequotes(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const count = Number(raw);
  return Number.isInteger(count) && count >= 1 && count <= 16 ? count : null;
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
  const tradfiV2 = preset === "tradfi" && values.tradfiV2 !== false;
  if (f.tradfiOnly && !tradfiV2) return null;
  if (f.cmcOnly && (!tradfiV2 || values.cmcHub !== true)) return null;
  if (f.type === "hidden") return null;
  if (f.type === "toggle") return (
    <div style={{ display: "grid", gap: 8 }}>
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{f.label}</span>
      <div style={{ display: "flex", alignItems: "center", minHeight: 42 }}>
        <Checkbox checked={f.k === "cmcHub" && !tradfiV2 ? false : !!value}
          locked={f.k === "cmcHub" && !tradfiV2}
          onChange={(v) => {
            if (f.k === "cmcHub" && !tradfiV2) return;
            onChange(v); if (v && f.exclusiveWith) set(f.exclusiveWith, false);
          }}>{f.text}</Checkbox>
      </div>
      {f.k === "cmcHub" && !tradfiV2 ? <span className="fl-field__hint">TradFi v2 hires only. This legacy control cannot authorize a payer.</span> : null}
      {f.inputKey && value ? (
        <input value={(values && values[f.inputKey]) || ""} onChange={(e) => set(f.inputKey, e.target.value)} placeholder={f.inputPlaceholder}
          style={{ width: "100%", padding: "11px 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", color: "var(--ink-1)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", outline: "none" }} />
      ) : null}
    </div>
  );
  if (f.type === "numToggle") {
    const on = !!values[f.on];
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
        <Checkbox checked={on} onChange={(v) => set(f.on, v)}>{f.label}</Checkbox>
        {!on && f.offNote ? (
          <div style={{ display: "flex", alignItems: "center", minHeight: 42, padding: "0 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-sans)", color: "var(--text-subtle)" }}>{f.offNote}</div>
        ) : (
          <div style={{ opacity: on ? 1 : 0.4, pointerEvents: on ? "auto" : "none" }}>
            <NumStepper value={value} onChange={onChange} step={f.step || 1} min={f.min} max={f.max} suffix={f.suffix} />
          </div>
        )}
        {on && f.hint ? <span className="fl-field__hint">{f.hint}</span> : null}
      </div>
    );
  }
  if (f.type === "tradfiModes") return <TradFiModes value={value} onChange={(mode) => {
    onChange(mode);
    // `agentName` is shared too: swap the default name, never a name the user typed.
    const defaultNames = { ai: "TradFi Trade Agent", sched: "TradFi Schedule Agent", dca: "TradFi DCA Agent", smart: "TradFi Portfolio Agent" };
    const currentName = String(values.agentName ?? "");
    if (currentName === "" || Object.values(defaultNames).includes(currentName)) set("agentName", defaultNames[mode] ?? defaultNames.ai);
    // `capital` is one key shared by every TradFi mode; each mode has its own default
    // (AI Trade: 3 positions × 21 USDT = 63; Schedule buy: 50 / 5 per buy).
    if (mode === "sched") { set("capital", "50"); set("schedAmount", "5"); }
    else if (mode === "ai") set("capital", "63");
    else if (mode === "smart") set("capital", String(spMinCapital(spRows(values.weights).length)));
  }} />;
  if (f.type === "bstockSelect") return <BstockField values={values} set={set} />;
  if (f.type === "dcaStock") return <DcaStockField f={f} value={value} onChange={onChange} />;
  if (f.type === "dcaRange") return <DcaRangeField values={values} set={set} />;
  if (f.type === "dcaTotal") return <DcaTotalField f={f} values={values} />;
  if (f.type === "weights") return <WeightsField value={value} onChange={onChange} values={values} set={set} />;
  if (f.type === "segChips") return <div className="fl-field" style={{ gridColumn: `span ${f.span ?? 1}` }}><FieldLabel label={f.label}><SpChips options={f.options} value={String(value ?? f.v)} onChange={onChange} /></FieldLabel></div>;
  if (f.type === "scheduleGroup") return <ScheduleField values={values} set={set} />;
  if (f.type === "navGuard") return <NavGuardField values={values} set={set} />;
  if (f.type === "endRule") return <EndRuleField values={values} set={set} />;
  if (f.type === "stepper") {
    const tradfi = tradfiV2;
    const tradfiEntry = f.k === "perTrade" && tradfi;
    const tradfiCapital = f.k === "capital" && tradfi;
    // The TradFi sections carry their own labels ("Min per entry" / "Max per entry").
    const label = f.label;
    const suffix = tradfiEntry || tradfiCapital ? "USDT" : f.suffix;
    const min = tradfiEntry || tradfiCapital ? 0.000000000000000001 : f.min;
    const step = tradfiEntry || tradfiCapital ? 1 : f.step;
    const typed = value === "" || value == null ? null : parseFloat(String(value).replace(/,/gu, ""));
    const below = f.floor != null && typed != null && typed < f.min;
    return (
      <div className="fl-field">
        <label className="fl-field__label">{label}{typeof f.tooltip === "string" ? <span aria-label={f.tooltip} title={f.tooltip} tabIndex={0} style={{ display: "inline-grid", placeItems: "center", width: 13, height: 13, marginLeft: 6, border: "1px solid var(--line-1)", borderRadius: "50%", color: "var(--text-subtle)", cursor: "help", font: "var(--weight-medium) 9px/1 var(--font-mono)" }}>i</span> : null}</label>
        <NumStepper value={value} onChange={onChange} step={step || 1} min={min} max={f.max} prefix={f.prefix} suffix={suffix} noClamp={f.floor != null} preciseStep={f.preciseStep} disabled={f.lockedByPreset && f.lockedByPreset.includes(preset)} />
        {below ? <span role="alert" style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--loss)" }}>Minimum {f.floor} {suffix ?? ""}</span>
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
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
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
      <div style={{ display: "grid", gridTemplateColumns: section.cols ? `repeat(${section.cols}, minmax(0, 1fr))` : "repeat(auto-fit, minmax(190px, 1fr))", gap: 16, alignItems: "start" }}>
      {section.fields.filter((f) => !"check codeToggle radioCheck pool textarea skillFile liquidityChart priceRangeGroup scheduleGroup navGuard endRule modeRows tradfiModes weights".split(" ").includes(f.type)).map((f) => (
          <Field key={f.k} f={F(f)} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} preset={preset} />
        ))}
      </div>
      {section.fields.filter((f) => f.type === "pool" || f.type === "textarea" || f.type === "skillFile" || f.type === "liquidityChart" || f.type === "priceRangeGroup" || f.type === "scheduleGroup" || f.type === "navGuard" || f.type === "endRule" || f.type === "modeRows" || f.type === "tradfiModes" || f.type === "weights").map((f) => (
        <Field key={f.k} f={F(f)} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} preset={preset} />
      ))}
      {section.checkRow ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "14px 32px" }}>
          {section.fields.filter((f) => f.type === "check" || f.type === "codeToggle" || f.type === "radioCheck").map((f, i) => (
            <Field key={f.k + i} f={F(f)} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} preset={preset} />
          ))}
        </div>
      ) : section.fields.filter((f) => f.type === "check" || f.type === "codeToggle" || f.type === "radioCheck").map((f, i) => (
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
  const owner = useOwnerActions();
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
  const restoredCapital = React.useRef(false);
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
    if (k === "capital") { capitalTouched.current = true; restoredCapital.current = false; }
    if (k === "maxRepay") repayTouched.current = true;
    // Operator 2026-09-25 (D4): Max DCA orders defaults to 3 on the 0.25 % pools and 4 on the
    // 0.01 % pools; a count still on the old stock's default follows the new stock's.
    if (k === "dcaAsset") {
      setValues((s) => ({ ...s, dcaAsset: v,
        ...(String(s.dcaMaxOrders) === dcaDefaultMaxOrders(s.dcaAsset) ? { dcaMaxOrders: dcaDefaultMaxOrders(v) } : {}) }));
      return;
    }
    setValues((s) => ({ ...s, [k]: v }));
  };
  // A restore arrives from HireGridDeploy's mount-time resume effect, which
  // React runs BEFORE this screen's own `[id]` reset effect below — so the
  // record is also parked in a ref and the reset re-applies it instead of
  // the defaults (audit finding A1).
  const pendingRestore = React.useRef(null);
  const withChoices = (current, record) => ({ ...current,
    capital: record.capitalBnb,
    utilizationPct: String(record.utilizationPct),
    maxRequotesDaily: String(record.maxRequotesDaily),
    tpOn: record.takeProfitPct !== 0,
    takeProfit: String(record.takeProfitPct),
    slOn: record.stopLossPct !== 0,
    stopLoss: String(record.stopLossPct),
  });
  const restoreGridChoices = React.useCallback((record: GridHireChoices) => {
    if (id !== "grid" || mode !== "Live") return;
    pendingRestore.current = record;
    capitalTouched.current = true;
    restoredCapital.current = true;
    setPreset(record.uiPresetId);
    setValues((current) => withChoices(current, record));
  }, [id, mode]);
  // Live-wired grid deploy (spec: MD here/MARKETPLACE-GRID-DEPLOY-SPEC.md):
  // a REAL pool object from /api/pools replaces the design export's static
  // POOLS list for the grid kind only.
  const [livePool, setLivePool] = React.useState(null);
  const [lpRoutingPool, setLpRoutingPool] = React.useState(null);
  const [lpRoutingError, setLpRoutingError] = React.useState(null);
  const [relayFeePerSubmitWei, setRelayFeePerSubmitWei] = React.useState(null);
  const relayFeeCache = React.useRef(new Map());
  const relayFeeAttempted = React.useRef(new Set());
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
    const record = id === "grid" ? pendingRestore.current : null;
    pendingRestore.current = null;
    const presetId = record === null ? DEFAULT_PRESET[id] : record.uiPresetId;
    setPreset(presetId); setValues(record === null ? defaults(id, presetId) : withChoices(defaults(id, presetId), record)); setMode("Live"); setShowAdv(false); setSim(null);
    capitalTouched.current = record !== null;
    restoredCapital.current = record !== null;
    repayTouched.current = false;
    setRepaySuggestion(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  React.useEffect(() => {
    if (id !== "grid" || mode !== "Live" || owner.walletAddress === undefined) return;
    const walletAddress = owner.walletAddress;
    const cached = relayFeeCache.current.get(walletAddress);
    if (cached !== undefined || relayFeeAttempted.current.has(walletAddress)) {
      setRelayFeePerSubmitWei(cached ?? null);
      return;
    }
    relayFeeAttempted.current.add(walletAddress);
    setRelayFeePerSubmitWei(null);
    let cancelled = false;
    const query = new URLSearchParams({ walletAddress, openNativeBudgetWei: "1", sizingPreset: "grid-shift-v1" });
    void fetch(`/api/agents/hire/preview?${query}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { data?: { sizing?: { relayFeePerSubmitWei?: unknown } } };
        if (!response.ok) return;
        const fee = payload.data?.sizing?.relayFeePerSubmitWei;
        if (typeof fee !== "string" || !/^\d+$/u.test(fee) || BigInt(fee) <= 0n) return;
        // Cache even after a cancel (mode/kind flipped mid-flight): the fetch
        // is one per wallet, so a dropped result would otherwise never return.
        relayFeeCache.current.set(walletAddress, fee);
        if (!cancelled) setRelayFeePerSubmitWei(fee);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [id, mode, owner.walletAddress]);

  const utilizationBps = id === "grid" ? parseUtilization(values.utilizationPct) : null;
  const shiftsPerDay = id === "grid" ? parseRequotes(values.maxRequotesDaily) : null;
  const geometryPreset = UI_PRESET_TO_GEOMETRY[preset] ?? "standard";
  const capitalFloorText = id !== "grid"
    ? null
    : mode !== "Live"
      ? gridCapitalFloorBnb(geometryPreset, livePool === null ? null : livePool.fee)
      : gridCapitalFloorBnbAtFee({
        presetId: geometryPreset,
        fee: livePool === null ? null : livePool.fee,
        relayFeePerSubmitWei: relayFeePerSubmitWei === null ? DEFAULT_RELAY_FEE_PER_SUBMIT_WEI : BigInt(relayFeePerSubmitWei),
        deployPctBps: utilizationBps ?? 3_000,
      });
  const capitalFloorHint = id === "grid" && mode === "Live"
    ? relayFeePerSubmitWei === null
      ? "Estimated minimum for this pool and model, priced on a padded relay fee. The figure is refined once your wallet's hire preview loads."
      : "Minimum for this pool and model at the plane's current relay fee."
    : null;
  const capitalFloorBnb = capitalFloorText === null ? null : Number(capitalFloorText);
  React.useEffect(() => {
    if (capitalFloorText === null) return;
    setValues((current) => {
      const now = Number(String(current.capital ?? "").replace(/,/gu, ""));
      // Fill it for them; only a capital they typed themselves survives, and
      // only while it still clears the floor.
      if (capitalTouched.current && Number.isFinite(now) && (restoredCapital.current || now >= Number(capitalFloorText))) return current;
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
      // A saved legacy `blue-chip` or `mid-cap` redeploy has no panel any more; it falls through the `some` check below and is ignored.
      const presetId = settings.executionModel;
      if (!PRESETS.trading.some((entry) => entry.id === presetId)) return;
      setPreset(presetId);
      // Start from the saved preset's own table: the mount-time defaults are
      // TradFi's, whose keys and hidden flags differ from the BNB presets'.
      const current = defaults(id, presetId);
      setValues(() => ({ ...current,
        agentName: settings.name,
        capital: settings.settlementAsset === "USDT" ? weiToBnb(settings.capitalQuoteWei ?? "0") : saved.capitalBnb ?? current.capital,
        perTrade: settings.settlementAsset === "USDT" ? weiToBnb(settings.entryWei) : weiToBnb(settings.entryWei),
        minEntry: settings.settlementAsset === "USDT" ? weiToBnb(settings.minEntryWei ?? "0") : current.minEntry,
        tradfiV2: settings.settlementAsset === "USDT",
        cmcHub: settings.settlementAsset === "USDT" && settings.cmcNewsEnabled === true,
        cmcTotalBudget: settings.cmcTotalBudgetWei === undefined ? current.cmcTotalBudget : weiToBnb(settings.cmcTotalBudgetWei),
        maxPositions: String(settings.maxOpenPositions),
        minMcap: settings.minMarketCapUsd === null ? "" : String(settings.minMarketCapUsd), maxMcap: settings.maxMarketCapUsd === null ? "" : String(settings.maxMarketCapUsd),
        noReentry: settings.noReentry, tp1On: settings.takeProfitBps !== null, tp1: settings.takeProfitBps === null ? "0" : String(settings.takeProfitBps / 100),
        stopLossOn: settings.stopLossBps !== null, stopLoss: settings.stopLossBps === null ? "50" : String(Math.abs(stopLossPercentFromBps(settings.stopLossBps))),
        holdTimeOn: settings.maxHoldSec !== null,
        holdTime: settings.maxHoldSec === null ? (presetId === "tradfi" ? "4,320" : "0") : String(settings.maxHoldSec / 60),
        ...(presetId === "tradfi" ? { tradfiMode: "ai" } : {}),
        crashProtection: settings.crashProtection !== false,
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
    // TradFi has its own section table, so crossing that boundary in either
    // direction starts from that table's defaults (the merge would carry the
    // other table's keys and hidden flags across).
    if (id === "lp" || p.id === "tradfi" || preset === "tradfi") setValues(defaults(id, p.id));
    else setValues((s) => ({ ...s, ...p.set, tradfiV2: p.id === "tradfi", ...(p.id === "tradfi" ? {} : { cmcHub: false }) }));
    setSim(null);
  };
  const presetIdx = Math.max(0, presets.findIndex((p) => p.id === preset));
  const runSim = () => setSim(SIM[id][presetIdx] || SIM[id][0]);

  const sections = sectionsFor(id, preset, mode, values);
  const primary = sections.filter((s) => !s.adv);
  const advanced = sections.filter((s) => s.adv);
  // Per-field overrides the CONFIG table cannot carry, because they depend on
  // live chain facts. Today: the grid's capital floor.
  const fieldOverrides = React.useMemo(() => {
    if (id === "health") return { maxRepay: { hint: repaySuggestion === null
      ? "Suggested from supported debt and Total capital once account data and BNB price are available. You can enter your own amount."
      : `Suggested $${repaySuggestion} from supported debt and Total capital. You can edit this amount.` } };
    // Schedule buy is the one non-ai TradFi mode with a derived, value-dependent
    // hint (the others keep their own table minimums untouched, hint: null).
    if (id === "trading" && preset === "tradfi" && values.tradfiMode === "sched") {
      // R2.10 (LOW-7): the per-buy stepper's max is bound to the total budget above it.
      const scheduleTotalBudget = Number(String(values.capital ?? "0").replace(/,/gu, ""));
      return { capital: { hint: `≈ ${scheduleBuysEstimate(values).plannedBuys} buys at the amount per buy above.` },
        ...(Number.isFinite(scheduleTotalBudget) && scheduleTotalBudget > 0 ? { schedAmount: { max: scheduleTotalBudget } } : {}) };
    }
    if (id === "trading" && preset === "tradfi" && values.tradfiMode === "dca") {
      // D1: the step's max follows N (a bound, not a control); the copy is R2.14 / R2.16's.
      const orders = dcaNum(values.dcaMaxOrders);
      const base = dcaNum(values.dcaBase), total = base + dcaNum(values.dcaOrder) * orders, stop = dcaNum(values.dcaSl);
      const baseOnlyFall = Math.min(100, Math.round((stop * total) / base));
      // RV-1 (operator 2026-09-25): the 0.01 % pools need a take profit of at least 1.5 %.
      const lowFeeStock = (DCA_BSTOCKS.find((stock) => stock.symbol === values.dcaAsset) ?? DCA_BSTOCKS[0]).feeBps === 1;
      return {
        ...(lowFeeStock ? { dcaTp: { min: 1.5 } } : {}),
        ...(Number.isInteger(orders) && orders >= 1 && orders <= 8 ? { dcaStep: { max: dcaMaxStepBps(orders) / 100,
          hint: "Orders sit on the pool's price grid, never above the price you set. On 0.25 % pools a level can sit up to 0.5 % deeper than its step." } } : {}),
        dcaTrigger: { hint: `The base order fires when it can fill at or below ${String(values.dcaTrigger ?? "")} after slippage.` },
        ...(Number.isFinite(baseOnlyFall) ? { dcaSl: { hint: `Stop loss is measured on your total deposit. With only the base order filled, the stock must fall about ${baseOnlyFall} % to reach a ${stop} % stop; with every DCA order filled, about ${stop} % below your average price.` } } : {}),
      };
    }
    if (id === "trading" && preset === "tradfi" && values.tradfiMode === "smart") {
      const floor = spMinCapital(spRows(values.weights).length);
      return { capital: { min: floor, floor: String(floor), hint: null } };
    }
    if (id === "trading" && preset === "tradfi" && (values.tradfiMode ?? "ai") !== "ai") return null;
    if (id === "trading") return {
      perTrade: preset === "tradfi" ? { min: 0.000000000000000001, max: undefined } : { min: 0.005, floor: "0.005", max: undefined },
      capital: preset === "tradfi" ? { min: 0.000000000000000001, max: undefined, hint: null } : { min: 0.02, floor: "0.02", hint: null },
      maxPositions: { min: 1, max: 10 },
    };
    if (id !== "grid" || capitalFloorText === null || capitalFloorBnb === null) return null;
    // `floor` turns the stepper strict: the − button stops here and a smaller
    // typed number goes red instead of being silently rewritten.
    return { capital: { min: capitalFloorBnb, floor: capitalFloorText, hint: capitalFloorHint } };
  }, [id, preset, values, capitalFloorText, capitalFloorBnb, capitalFloorHint, repaySuggestion]);

  const capitalBelowFloor = capitalFloorBnb !== null
    && Number(String(values.capital ?? "").replace(/,/gu, "")) < capitalFloorBnb;
  const gridBlockedReason = id !== "grid" ? null
    : mode === "Live" && utilizationBps === null ? "Capital utilization must be a whole 5% step between 30% and 50%."
      : mode === "Live" && shiftsPerDay === null ? "Max requotes daily must be a whole number between 1 and 16."
        : mode === "Live" && (values.tpOn || values.slOn) ? "This grid model closes rungs on price crossings, not on a % target. Turn Take profit and Stop loss off to deploy."
          : capitalBelowFloor ? `Total capital is below this pool's minimum of ${capitalFloorText} BNB.` : null;
  const tradePreset = id === "trading" ? presets.find((entry) => entry.id === preset) : null;
  const tradfiV2 = id === "trading" && tradePreset?.id === "tradfi" && values.tradfiV2 !== false;
  const tradfiSchedule = tradfiV2 && values.tradfiMode === "sched";
  const scheduleFirstAtSec = tradfiSchedule && values.schedFirst === "Custom" && values.schedStartDate
    ? Math.floor(new Date(`${values.schedStartDate}T${values.schedStartTime || "00:00"}:00`).getTime() / 1_000) : null;
  const scheduleEndAtSec = tradfiSchedule && values.endRule === "date" && values.endDate
    ? Math.floor(new Date(`${values.endDate}T23:59:59`).getTime() / 1_000) : null;
  const scheduleToken = typeof values.schedAsset?.address === "string" ? values.schedAsset.address.toLowerCase() : undefined;
  // Auto DCA (§14.1): the mock's fields map one-to-one onto the signed DCA tuple;
  // everything the mode does not use is pinned to its unset value (§8.2).
  const tradfiDca = tradfiV2 && values.tradfiMode === "dca";
  // Smart Portfolio: crash protection is off and not shown (operator 2026-09-26).
  const tradfiSmart = tradfiV2 && values.tradfiMode === "smart";
  const smartRows = spRows(values.weights);
  const smartCapitalWei = parseBnbToWei(String(values.capital ?? "0"));
  const smartInterval = ({ "4h": 14400, "8h": 28800, "12h": 43200, Daily: 86400 } as const)[String(values.rebalanceEvery) as "4h" | "8h" | "12h" | "Daily"] ?? 86400;
  const dcaStock = DCA_BSTOCKS.find((stock) => stock.symbol === values.dcaAsset) ?? DCA_BSTOCKS[0];
  const dcaMaxOrders = dcaNum(values.dcaMaxOrders);
  const dcaBaseWei = parseBnbToWei(String(values.dcaBase ?? "0"));
  const dcaOrderWei = parseBnbToWei(String(values.dcaOrder ?? "0"));
  const dcaCapitalWei = Number.isInteger(dcaMaxOrders) && dcaMaxOrders > 0 ? dcaBaseWei + dcaOrderWei * BigInt(dcaMaxOrders) : 0n;
  const tradeSettings = id === "trading" ? ({
    name: String(values.agentName ?? "Trading Agent 01"), executionModel: tradePreset?.executionModel ?? "sigma",
    entryWei: tradfiDca ? dcaBaseWei.toString(10) : tradfiSmart ? smartCapitalWei.toString(10) : parseBnbToWei(String(tradfiSchedule ? values.schedAmount ?? "0" : values.perTrade ?? "0")).toString(10), maxOpenPositions: tradfiSchedule || tradfiDca || tradfiSmart ? 1 : Number(values.maxPositions),
    minMarketCapUsd: tradfiDca || tradfiSmart ? null : decimalOrNull(values.minMcap), maxMarketCapUsd: tradfiDca || tradfiSmart ? null : decimalOrNull(values.maxMcap), noReentry: !tradfiDca && !tradfiSmart && !!values.noReentry,
    takeProfitBps: tradfiSchedule || tradfiDca || tradfiSmart ? null : values.tp1On ? Math.round(Number(values.tp1) * 100) : null, stopLossBps: tradfiSchedule || tradfiDca || tradfiSmart ? null : stopLossBpsWhenEnabled(!!values.stopLossOn, Number(values.stopLoss)),
    // `holdTimeOn` exists only on the TradFi form (a toggle); the BNB presets
    // keep the "0 = no limit" stepper. A preset value like "4,320" carries a comma.
    maxHoldSec: tradfiSchedule || tradfiDca || tradfiSmart ? null : values.holdTimeOn !== false && (decimalOrNull(values.holdTime) ?? 0) > 0 ? Math.round((decimalOrNull(values.holdTime) ?? 0) * 60) : null, breakEvenAfterTp: false,
    crashProtection: !tradfiDca && !tradfiSmart && values.crashProtection !== false,
    slippageBps: Math.round(Number(values.slippage) * 100), gasPriority: String(values.gas ?? "Standard").toLowerCase(),
    primaryModel: tradeModelId(String(values.primary ?? MODELS[0])),
    fallbackModel: tradeModelId(String(values.fallback ?? MODELS[1])),
    instructions: tradfiDca || tradfiSmart || String(values.instructions ?? "").trim() === "" ? null : String(values.instructions), skillMarkdown: tradfiDca || tradfiSmart ? null : values.skillFile?.text ?? null,
    ...(tradfiV2 ? {
      settlementAsset: "USDT" as const,
      minEntryWei: tradfiDca ? dcaBaseWei.toString(10) : tradfiSmart ? (10n ** 17n).toString(10) : parseBnbToWei(String(tradfiSchedule ? values.schedAmount ?? "0" : values.minEntry ?? "0")).toString(10),
      capitalQuoteWei: tradfiDca ? dcaCapitalWei.toString(10) : parseBnbToWei(String(values.capital ?? "0")).toString(10),
      cmcNewsEnabled: tradfiSchedule || tradfiDca ? false : tradfiSmart ? false : values.cmcHub === true,
      ...(tradfiSchedule ? {
        tradeMode: "schedule" as const, scheduleToken: scheduleToken ?? "", scheduleIntervalSec: SCHED_INTERVALS[String(values.schedFreq ?? "Daily")] ?? 86400,
        scheduleFirstAtSec, scheduleEndKind: values.endRule ?? "budget", scheduleEndAtSec,
        scheduleEndRuns: values.endRule === "runs" ? Math.max(1, Math.min(1000, Number(values.endRuns ?? 1))) : null,
        scheduleMarketHoursOnly: values.sessionGuard === true, scheduleMaxPremiumBps: values.navGuard === false ? 150 : Math.max(50, Math.min(150, Math.round(Number(values.navPremium ?? "1.5") * 100))),
      } : tradfiDca ? {
        tradeMode: "dca" as const, dcaToken: dcaStock.address, dcaStepBps: Math.round(dcaNum(values.dcaStep) * 100), dcaStepMultiplierBps: 12_000,
        dcaTakeProfitBps: Math.round(dcaNum(values.dcaTp) * 100), dcaOrderWei: dcaOrderWei.toString(10), dcaMaxOrders,
        dcaTriggerPriceE8: values.dcaTriggerOn ? dcaE8(values.dcaTrigger) : null,
        dcaRangeMinE8: values.dcaRangeOn ? dcaE8(values.dcaRangeMin) : null, dcaRangeMaxE8: values.dcaRangeOn ? dcaE8(values.dcaRangeMax) : null,
        dcaStopLossBps: values.dcaSlOn ? Math.round(dcaNum(values.dcaSl) * 100) : null,
      } : tradfiSmart ? {
        tradeMode: "portfolio" as const, portfolioTokens: smartRows.map((row) => spAddress(row.sym).toLowerCase()),
        portfolioWeightsBps: smartRows.map((row) => Math.round(Number(row.w) * 100)),
        portfolioDriftBps: Math.round(Number(values.drift) * 100), portfolioIntervalSec: smartInterval,
      } : values.cmcHub === true ? { cmcTotalBudgetWei: parseBnbToWei(String(values.cmcTotalBudget ?? "0")).toString(10) } : {}),
    } : {}),
  } satisfies TradeSettings) : null;
  const tradeBlockedReason = tradeSettings === null ? null : (() => {
    const entryWei = BigInt(tradeSettings.entryWei);
    const totalWei = parseBnbToWei(String(values.capital ?? "0"));
    if (tradfiV2) {
      if (tradfiSchedule) {
        const amountWei = BigInt(tradeSettings.entryWei);
        if (amountWei < 5n * 10n ** 18n) return "Amount per buy must be at least 5 USDT.";
        if (totalWei < amountWei) return "Total budget must be at least the amount per buy.";
        const reservation = amountWei + amountWei * 500n / 10_000n;
        if (totalWei < reservation) return "Total budget must cover at least one buy plus the platform fee.";
        if (typeof scheduleToken !== "string" || !/^0x[0-9a-f]{40}$/u.test(scheduleToken)) return "Select a quoted bStock.";
        if (values.endRule === "date" && scheduleEndAtSec !== null && scheduleEndAtSec <= Math.floor(Date.now() / 1_000)) return "The schedule end date must be in the future.";
        if (values.schedFirst === "Custom" && (scheduleFirstAtSec === null || scheduleFirstAtSec < Math.floor(Date.now() / 1_000) - 300 || scheduleFirstAtSec > Math.floor(Date.now() / 1_000) + 604_800 - 7200)) return "First buy must fall inside the 7-day session.";
        return null;
      }
      if (tradfiDca) {
        // §14.1 / R2.16 blocked reasons, in form order.
        const step = dcaNum(values.dcaStep), tp = dcaNum(values.dcaTp), stop = dcaNum(values.dcaSl);
        if (!Number.isInteger(dcaMaxOrders) || dcaMaxOrders < 1 || dcaMaxOrders > 8) return "Max DCA orders must be a whole number from 1 through 8.";
        if (!(step >= 1 && step <= 30)) return "Price drop step must be between 1 % and 30 %.";
        if (Math.round(step * 100) > dcaMaxStepBps(dcaMaxOrders)) return `With ${dcaMaxOrders} DCA orders the price drop step can be at most ${(dcaMaxStepBps(dcaMaxOrders) / 100).toFixed(2)} %.`;
        if (!(tp >= 1.5)) return "Take profit must be at least 1.5 %.";
        if (dcaStock.feeBps === 1 && !(tp >= 1.5)) return `On ${dcaStock.symbol} the take profit must be at least 1.5 %.`;
        if (dcaBaseWei < 25n * 10n ** 18n) return "Base order must be at least 25 USDT.";
        if (dcaOrderWei < 10n * 10n ** 18n) return "DCA order must be at least 10 USDT.";
        if (values.dcaTriggerOn && dcaE8(values.dcaTrigger) === null) return "Trigger price must be above 0.";
        if (values.dcaRangeOn && (dcaE8(values.dcaRangeMin) === null || !(dcaNum(values.dcaRangeMin) < dcaNum(values.dcaRangeMax)))) return "Min must be below max.";
        if (values.dcaSlOn && !(stop >= 1 && stop <= 99)) return "Stop loss must be between 1 % and 99 %.";
        return null;
      }
      if (tradfiSmart) {
        if (smartRows.length < 2 || smartRows.length > 5 || new Set(smartRows.map((row) => row.sym)).size !== smartRows.length
          || smartRows.some((row) => !DCA_BSTOCKS.some((stock) => stock.symbol === row.sym))) return "Pick 2 to 5 stocks.";
        const weights = smartRows.map((row) => Number(row.w));
        if (weights.some((weight) => !Number.isInteger(weight) || weight < 10)) return "Each stock needs a whole percent of at least 10 %.";
        if (weights.reduce((sum, weight) => sum + weight, 0) !== 100) return "Weights must add up to 100 %.";
        const minimum = spMinCapital(smartRows.length);
        if (totalWei < BigInt(minimum) * 10n ** 18n) return `Total capital must be at least ${minimum} USDT for ${smartRows.length} stocks.`;
        const drift = Number(values.drift);
        if (!Number.isInteger(drift * 2) || drift < 0.5 || drift > 15) return "Drift must be 0.5 % to 15 % in 0.5 % steps.";
        return null;
      }
      if ((values.tradfiMode ?? "ai") !== "ai") return "";
      const minEntryWei = BigInt(tradeSettings.minEntryWei ?? "0");
      const cmcBudgetWei = values.cmcHub === true ? BigInt(tradeSettings.cmcTotalBudgetWei ?? "0") : 0n;
      if (minEntryWei <= 0n) return "Min entry must be greater than 0 USDT.";
      if (entryWei < minEntryWei) return "Max entry must be at least Min entry.";
      if (!Number.isInteger(tradeSettings.maxOpenPositions) || tradeSettings.maxOpenPositions < 1 || tradeSettings.maxOpenPositions > 10) return "Max open positions must be an integer from 1 through 10.";
      if (totalWei <= 0n) return "Enter positive USDT capital; the live preview will calculate the configured buy-fee headroom.";
      if (values.cmcHub === true && cmcBudgetWei <= 0n) return "CMC total budget must be greater than 0 USDT.";
      const stopLossPercent = Number(values.stopLoss);
      if (values.stopLossOn && (!Number.isFinite(stopLossPercent) || stopLossPercent < 1 || stopLossPercent > 100)) return "Stop loss must be between 1% and 100%.";
      return null;
    }
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
              <a href={TUTORIAL_LINKS[id]} target="_blank" rel="noreferrer">Tutorial Videos</a>
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
          {id === "trading" ? preset === "tradfi"
            ? <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>Trades only the tokens pinned when you deploy (up to 28). New launches need a new agent.</p>
            : <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>Trades only the tokens pinned when you deploy (up to 25). New launches need a new agent.</p>
            : null}
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
            {...(mode === "Live" ? {
              utilizationPct: utilizationBps === null ? 30 : utilizationBps / 100,
              maxRequotesDaily: shiftsPerDay ?? 16,
              onRestoreChoices: restoreGridChoices,
            } : {})}
            blockedReason={gridBlockedReason}
          />
        ) : id === "trading" && preset === "tradfi" && values.tradfiMode === "smart" && mode === "Demo" ? (
          <div style={{ display: "grid", gap: 14, marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
            <span className="fl-eyebrow">Hire the scoped agent session</span>
            <p style={{ font: "var(--type-body-sm)", color: "var(--text-muted)" }}>Smart Portfolio has no demo engine.</p>
            <Button variant="primary" size="lg" disabled>Sign hire and create the session key</Button>
          </div>
        ) : id === "trading" && preset === "tradfi" && values.tradfiMode === "dca" && mode === "Demo" ? (
          // D8: Auto DCA has no demo engine; the Demo tab shows the mode disabled with its reason.
          <div style={{ display: "grid", gap: 14, marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
            <span className="fl-eyebrow">Hire the scoped agent session</span>
            <p style={{ font: "var(--type-body-sm)", color: "var(--text-muted)" }}>Auto DCA runs live only.</p>
            <Button variant="primary" size="lg" disabled>Sign hire and create the session key</Button>
          </div>
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
            capitalBnb={tradfiV2 ? "" : String(values.capital ?? "0")} settings={tradeSettings} go={go}
            blockedReason={tradeBlockedReason} showCrashProtection={!tradfiSmart} />
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
