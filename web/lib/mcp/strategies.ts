/** Public product explanations only; no instance settings or live performance. */
export const STRATEGIES = {
  grid: {
    summary: "Uses PancakeSwap V3 concentrated-liquidity positions on BNB Chain to buy and sell across configured price ranges.",
    howItWorks: [
      "The owner configures the grid and budget before authorising the agent.",
      "Market movement converts tokens within liquidity ranges. A price touch alone is not a completed grid fill.",
      "The worker checks observed market state and may reposition the grid according to the configured mode and execution limits.",
    ],
    parameters: ["Price range and grid spacing", "Budget", "Grid mode", "Session spend limits and expiry"],
    risks: ["A trending market can leave the position concentrated in the falling asset.", "Gas, fees and execution delays can reduce returns; fills and profit are not guaranteed."],
  },
  lp: {
    summary: "Manages PancakeSwap V3 concentrated liquidity on BNB Chain, with behaviour determined by the selected LP strategy and settings.",
    howItWorks: [
      "The owner selects a pool, range, budget and strategy settings.",
      "Liquidity can earn swap fees while it is active in the pool's price range.",
      "The worker evaluates configured conditions for rebalancing, fee collection and protective exits; limits or unavailable evidence can prevent an action.",
    ],
    parameters: ["Pool and price range", "Budget", "Rebalance conditions", "Fee collection and exit settings"],
    risks: ["Impermanent loss and token-price losses can outweigh earned fees.", "Out-of-range liquidity does not earn active-range swap fees.", "Exit proceeds can contain multiple assets; a skipped optional conversion can leave the volatile token.", "Gas, slippage and delayed execution affect results; stop-loss execution and returns are not guaranteed."],
  },
  trade: {
    summary: "Screens eligible tokens on BNB Chain and manages entries and exits within the owner's configured trading permissions.",
    howItWorks: [
      "The owner configures the eligible market scope, budget and exit rules.",
      "The worker evaluates entry candidates and submits only when the configured policy and session limits allow it.",
      "Open trades are monitored against configured exit rules, including stop-loss, take-profit and holding-time conditions.",
    ],
    parameters: ["Eligible token universe", "Position and spending limits", "Stop-loss and take-profit", "Maximum holding time"],
    risks: ["Volatility, low liquidity and token behaviour can cause losses or prevent an exit.", "Quotes and observed prices can change before execution.", "A trading signal does not guarantee a fill or profit; exit rules cannot guarantee an execution price."],
  },
} as const;
