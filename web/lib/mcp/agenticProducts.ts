/**
 * The Binance Agentic Wallet products as the MCP lists them, and the hire guide `get_hire_link` returns for each.
 * Numbers come from `hireRequirements.ts` only. Read-only: nothing here hires, signs or touches a key.
 */
import { DCA_PORTFOLIO_STOCKS, REQ } from "./hireRequirements";

export type AgenticProductId = "agentic-ai-trade" | "agentic-schedule" | "agentic-dca" | "agentic-portfolio";

type AgenticProduct = {
  readonly id: AgenticProductId;
  readonly name: string;
  readonly tile: string;
  readonly whatItDoes: string;
  /** Build-time flags that must all be "true" for the Deploy tile to exist; read at request time. */
  readonly flags: readonly string[];
  readonly settings: readonly string[];
  readonly termEnd: string;
  readonly earn: string | null;
};

const WALLET_FLAG = "NEXT_PUBLIC_AGENTIC_WALLET_ENABLED";
const DCA_FLAG = "NEXT_PUBLIC_AGENTIC_DCA_ENABLED";
export const EARN_FLAG = "NEXT_PUBLIC_AGENTIC_EARN_ENABLED";
const SCHED = REQ.schedule, DCA = REQ.dca, PORT = REQ.portfolio, AI = REQ.ai;

export const AGENTIC_PRODUCTS: readonly AgenticProduct[] = [
  {
    id: "agentic-ai-trade", name: "Agentic AI Trade", tile: "AI Trade", flags: [WALLET_FLAG],
    whatItDoes: "A model screens tokenized US stocks (bStocks, Ondo) and manages entries and exits from your Binance Agentic Wallet, in USDT.",
    settings: [
      `Total capital in USDT (form default ${AI.capitalUsdtDefault}).`,
      `Min per entry and max per entry in USDT (form defaults ${AI.minEntryUsdtDefault} and ${AI.maxEntryUsdtDefault}); max must be at least min.`,
      `Max open positions: a whole number from ${AI.maxOpenPositions.min} to ${AI.maxOpenPositions.max} (default ${AI.maxOpenPositions.default}); capital must cover max open positions x max per entry.`,
      `Optional exits: take profit, stop loss (${AI.stopLossPct.min} to ${AI.stopLossPct.max} %), max holding time; the model decides any exit you leave off.`,
      `Slippage tolerance ${AI.slippagePct.min} to ${AI.slippagePct.max} %.`,
    ],
    termEnd: "You choose at Deploy: sell all to USDT at term end, or keep holdings.",
    earn: "Optional.",
  },
  {
    id: "agentic-schedule", name: "Agentic Schedule buy", tile: "Schedule buy", flags: [WALLET_FLAG],
    whatItDoes: "Buys a fixed USDT amount of one tokenized stock on a fixed frequency. Deterministic: no model, no selling.",
    settings: [
      `One quoted bStock, a total budget and an amount per buy of at least ${SCHED.minAmountPerBuyUsdt} USDT.`,
      `The Deploy form wants the total budget to cover at least one buy plus a ${SCHED.totalBudgetMinFeeBps / 100} % fee reserve.`,
      `Frequency: ${SCHED.intervals.join(", ")}.`,
      `First buy: ${SCHED.firstBuyWindow}.`,
      `Finish: when the budget is spent, on an end date, or after ${SCHED.endRuns.min} to ${SCHED.endRuns.max} runs.`,
      `Buy only while the price is within ${SCHED.maxPremiumBps.min / 100} to ${SCHED.maxPremiumBps.max / 100} % of NAV (form default ${SCHED.maxPremiumBps.default / 100} %); optional: only during US market hours.`,
    ],
    termEnd: "Holdings are kept at term end (a Schedule buy never sells).",
    earn: "Optional.",
  },
  {
    id: "agentic-dca", name: "Agentic Auto DCA", tile: "Auto DCA", flags: [WALLET_FLAG, DCA_FLAG],
    whatItDoes: "Opens with a base market buy, then buys again each time the price falls one step, and sells the round when the take-profit is reached. The agent watches the price and sends market swaps itself (no resting limit orders on Binance). Deterministic.",
    settings: [
      `One of ${DCA_PORTFOLIO_STOCKS.length} stocks: ${DCA_PORTFOLIO_STOCKS.join(", ")}.`,
      `Base order at least ${DCA.minBaseUsdt} USDT and each DCA order at least ${DCA.minOrderUsdt} USDT; max DCA orders ${DCA.maxOrders.min} to ${DCA.maxOrders.max} (default ${DCA.maxOrders.default}); total delegated = base + orders x order size.`,
      `Price drop step ${DCA.stepPct.min} to ${DCA.stepPct.max} % (a higher order count lowers the allowed maximum).`,
      `Take profit at least ${DCA.minTakeProfitPct} %.`,
      `Optional: trigger price, price range, stop loss (${DCA.stopLossPct.min} to ${DCA.stopLossPct.max} % of the total deposit); a stop loss ends the agent and sells nothing.`,
    ],
    termEnd: "At term end the agent stops: open DCA levels and the take-profit are dropped and holdings are kept in the wallet.",
    earn: `Optional, offered only with at least ${DCA.earnMinOrders} DCA orders.`,
  },
  {
    id: "agentic-portfolio", name: "Agentic Smart Portfolio", tile: "Smart Portfolio", flags: [WALLET_FLAG],
    whatItDoes: "Holds a weighted basket of tokenized stocks and rebalances back to target when a weight drifts. Deterministic.",
    settings: [
      `${PORT.stocks.min} to ${PORT.stocks.max} stocks from the same ${DCA_PORTFOLIO_STOCKS.length} as Auto DCA: ${DCA_PORTFOLIO_STOCKS.join(", ")}.`,
      `Whole-percent weights, each at least ${PORT.minWeightPct} %, adding up to 100 %.`,
      `Total capital at least ${PORT.minCapitalUsdt.base} USDT for ${PORT.stocks.min} stocks plus ${PORT.minCapitalUsdt.perExtraStock} USDT for each extra stock.`,
      `Rebalance when drift exceeds ${PORT.driftPct.min} to ${PORT.driftPct.max} % (steps of ${PORT.driftPct.step} %), checked every ${PORT.intervals.join(", ")}.`,
    ],
    termEnd: "Holdings are kept at term end.",
    earn: null,
  },
];

export const AGENTIC_PRODUCT_IDS = AGENTIC_PRODUCTS.map((product) => product.id);

type Env = Readonly<Record<string, string | undefined>>;
const on = (env: Env, name: string): boolean => env[name] === "true";
export const isAgenticAvailable = (product: AgenticProduct, env: Env = process.env): boolean => product.flags.every((flag) => on(env, flag));

export const AGENTIC_NOTE =
  "Hiring is a human action in the user's own browser and Binance App. This MCP cannot hire, sign, move funds or place an order; it returns the link and the numbers.";

function binanceChecks(product: AgenticProduct): string[] {
  const g = REQ.gate, schedule = product.id === "agentic-schedule";
  return [
    "Connected, with Trade all tokens switched on in the Binance App.",
    "Abnormal transactions set to AutoReject.",
    "Max sign-in duration long enough for the term (choose 7 days if the Binance cap is short).",
    `Daily limit of at least ${schedule ? g.dailyLimitCapitalMultipleSchedule : g.dailyLimitCapitalMultiple} x the capital.`,
    ...(schedule ? [] : [`x402 daily limit of at least ${g.x402DailyLimitMinUsdt.toFixed(2)} USDT.`]),
  ];
}

function funding(product: AgenticProduct): { usdt: string; bnb: string } {
  const b = REQ.budgetUsdt, slot = REQ.gate.bnbPerSlot;
  const budget = product.id === "agentic-ai-trade" ? b.ai : product.id === "agentic-schedule" ? b.schedule : product.id === "agentic-dca" ? b.dca : b.portfolio;
  const slots = product.id === "agentic-ai-trade" ? REQ.bnbSlots.ai : product.id === "agentic-schedule" ? REQ.bnbSlots.schedule : product.id === "agentic-dca" ? REQ.bnbSlots.dca : REQ.bnbSlots.portfolio;
  return {
    usdt: budget[7] === 0 ? "The capital you set." : `The capital you set plus ${budget[7]} USDT (7-day term) or ${budget[30]} USDT (30-day term) for ${product.id === "agentic-ai-trade" ? "paid market data" : "keeping the Binance session alive"}.`,
    bnb: `${slot} BNB per transaction slot; slots = ${slots}${product.earn === null ? "" : `; ${REQ.gate.bnbEarnExtraSlots} more slots (${(slot * REQ.gate.bnbEarnExtraSlots).toFixed(4)} BNB) if you opt in to Earn`}.`,
  };
}

export function hireGuide(product: AgenticProduct, deployUrl: string, env: Env = process.env) {
  const earnOn = product.earn !== null && on(env, EARN_FLAG);
  return {
    agent: product.id,
    name: product.name,
    status: isAgenticAvailable(product, env) ? "available" : "unavailable",
    custody: "binance-agentic",
    deployUrl,
    whatItDoes: product.whatItDoes,
    steps: [
      `Open ${deployUrl} (a plain link: nothing is prefilled; the TradFi preset is the default).`,
      `Pick the "${product.tile}" mode tile and set the options listed under requirements.settings.`,
      "Press Deploy and choose Agentic Wallet (not Altana).",
      `Choose the term: ${REQ.termDays.join(" or ")} days${product.id === "agentic-ai-trade" ? ", and what happens at term end" : ""}.`,
      "Scan the QR with the Binance App, tap Confirm, then type the 6-character code the App shows.",
      "Fund the Agentic Wallet with the USDT and BNB the page asks for.",
      "Review the Binance checks and press Deploy; the page then opens your agent's public view.",
    ],
    requirements: {
      termDays: [...REQ.termDays],
      binanceApp: binanceChecks(product),
      funding: funding(product),
      settings: [...product.settings],
      termEnd: product.termEnd,
    },
    rules: [
      "Use a dedicated Agentic Wallet while the agent runs; deploying records that the wallet is dedicated to this agent.",
      "To stop the agent, sign 4lpha out in the Binance App (or sign in to that wallet anywhere else). That ends the agent for good: it cannot reconnect, and starting again takes a new hire with a new QR.",
      "A local Binance Agentic Wallet (baw) sign-in on a hired wallet ends the agent the same way.",
      "Holdings stay in your wallet when the agent ends or you sign out; sell them in the Binance App.",
      `A hire lasts ${REQ.termDays.join(" or ")} days.`,
    ],
    earn: product.earn === null ? null : {
      offered: earnOn,
      note: product.earn,
      conditions: [
        `Spare USDT goes to ${REQ.earn.protocols.join(" or ")} (best rate) until a buy needs it.`,
        `Up to ${REQ.earn.maxShareOfCapitalPct} % of capital, and only if at least ${REQ.earn.minLendUsdt} USDT.`,
        `Everything comes back ${REQ.earn.allBackHoursBeforeEnd} hours before the end.`,
        "A small BNB fee per move; the protocols are third parties.",
      ],
    },
    authorises: AGENTIC_NOTE,
  };
}
