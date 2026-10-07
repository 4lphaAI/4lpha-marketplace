---
name: 4lpha-bstock-analysis
description: |
  Technical and market read of a tokenized US stock (bStock) traded on BNB Chain, for example NVDAB,
  SPYB, TSLAB, MUB: the same indicators 4lpha's AI Trade agent reads (RSI, MACD, EMA trend, Bollinger,
  Stochastic RSI, ATR, relative volume, session gap, VWAP distance, opening-range break) on 15m and 1h
  bars, the US equity market regime from SPYB/QQQB, the token's price against its NAV and the
  underlying share price, whether the US market session is open, pool depth, and whether 4lpha's
  agents can trade it. Combines with news, macro data and an optional paid deep report.
  Use for: "analyse NVDAB", "is NVDAB worth buying now", "technical view on SPYB", "is TSLAB
  overbought", "how does the market look for tokenized stocks today", "can I buy 50 USDT of MUB cheaply".
  NOT for: company profile and fundamentals only (use binance-tokenized-securities-info), placing the
  trade (use binance-agentic-wallet), meme tokens quoted in a stock (use 4lpha-meme-stocks),
  automating a strategy (use 4lpha-hire).
license: MIT
metadata:
  author: 4lpha
  version: "1.0"
---

# 4lpha bStock Analysis Skill

## Overview

bStocks are BEP-20 tokens on BNB Chain that track one US share (or an ETF) each and trade 24/7 on
PancakeSwap and through Binance's routing. This skill reads 4lpha's market data for one bStock and
helps the assistant write a balanced reading of it. The data is the same set 4lpha's AI Trade agent
reads; 4lpha's own scoring is not published, and this skill never tells the user to buy or sell.

## When to Use This Skill

| User intent | What to run |
|---|---|
| Analyse one bStock, "worth buying now?" | `bstock-analysis token=<SYMBOL or 0x address>` then the workflow below |
| Only one timeframe | `bstock-analysis token=NVDAB interval=1h` (or `15m`) |
| Market mood for US stocks on chain | `bstock-analysis token=SPYB` and read `regime` |

## How to Call

```bash
node <skill-dir>/scripts/cli.mjs bstock-analysis token=NVDAB
node <skill-dir>/scripts/cli.mjs bstock-analysis token=0x<CONTRACT_ADDRESS> interval=15m
```

`token` is the bStock symbol (ticker + "B", case-insensitive) or its contract address on BNB Chain.
A token that is not a bStock answers `not_a_bstock`. `interval` is `15m` or `1h`; omitted returns
both. Equivalent MCP tool: `bstock_analysis` on `https://4lpha.tech/mcp`.

## Workflow

1. **4lpha data**: run `bstock-analysis`. Check `staleness` and each metric's availability first.
2. **Company facts (optional, free)**: Binance's `binance-tokenized-securities-info` skill answers
   for bStocks too: call its token list **without** a `type` filter (its text describes Ondo only,
   but type 3 rows are bStocks) or its per-address endpoints with `chainId=56`.
3. **News and macro (optional)**: use your own web search for recent news on the underlying company
   and the US market (free). For scheduled macro events, the CoinMarketCap MCP sells them per call via
   x402 (about 0.01 USDT); only with the user's explicit yes, see
   [`references/external-sources.md`](references/external-sources.md).
4. **Deep report (optional, paid)**: BNB Chain's Stock Analyze Agent writes a fundamentals +
   technicals report on the underlying ticker for about 0.1 U, delivered in 2 to 5 minutes. Only with
   the user's explicit yes after stating the price; flow in `references/external-sources.md`.
5. **Real buy or sell price (optional, free)**: 4lpha does not estimate price impact. For the price the
   user would actually get, a `baw market-order quote` through the `binance-agentic-wallet` skill is
   free and places nothing. Before suggesting it, run `4lpha-agent-status` for that wallet: if a 4lpha
   agent is active on it, do not run or suggest any `baw` command that needs that wallet's session
   (one session per wallet; a new sign-in ends the agent).
6. **Write the reading** with the rubric and the template below.

## Reading the data (rubric)

Metrics live at `indicators["1h"].metrics.<name>` and `indicators["15m"].metrics.<name>`, each
`{ value, reason, unit }`. Use `value` only when it is not null; otherwise say why it is missing (its
`reason`). `unit: "percent"` is already a percentage; `unit: "ratio"` is 0 to 1. Prices are under
`price`, depth under `depth.deepest`, the session under `market.session`, the regime under
`regime.label`. Full field list: [`references/cli.md`](references/cli.md).

| Area | Fields | How to read |
|---|---|---|
| Trend | `emaSpreadPct` (EMA12 vs EMA26), `roc10Pct` | positive and rising = up-trend; negative = down-trend; near 0 = flat |
| Momentum | `rsi14`, `histogram` (MACD), `stochRsi14` | RSI above 70 stretched, below 30 washed out; MACD histogram turning up or down; Stoch RSI above 0.8 / below 0.2 |
| Volatility | `atrPct`, `bbWidthPct20`, `bbPosition20` | wide bands / high ATR = bigger swings; `bbPosition20` near 1 = at the upper band, near 0 = lower band |
| Volume | `rvol20` | above 1 = more activity than usual (not available when the source is `underlying`) |
| Session | `session.state`, `gapPct`, `vwapDistancePct`, `orbBreakPct` | `rth` = NYSE regular hours, `overnight` / `close` = the token trades while the stock market is shut, so moves can lack a reference |
| Regime | `regime` (`risk_on`, `risk_off`, `neutral`) and `reasons` | the broad US equity backdrop from SPYB and QQQB |
| Price vs fair value | `premiumBps` and the prices | `premiumBps` compares the pool price with the underlying share price times the shares per token: positive = paying a premium over the stock, negative = a discount; large gaps tend to close. NAV is shown separately |
| Depth | deepest pool liquidity and 24h volume, `deepPool` | a shallow pool means a large order moves the price; get a real quote (step 5) |
| Tradability | eligibility | whether 4lpha's agents may trade this token |

Indicators come from the token's own pool bars when the `source` is `pool`, or from the underlying
share price when it is `underlying` (tokens without a deep pool); in the second case there is no
volume data and prices are per share of the stock, not per token.

## Answer template

1. **Reading in one line**: leans positive, leans negative, or mixed, with how much data supports it
   (stale data or few bars = low confidence).
2. **Price**: pool price, NAV, underlying price, premium or discount, market session.
3. **Trend and momentum** on 1h, then 15m.
4. **Backdrop**: regime, plus news or macro if fetched (name the source and its time).
5. **Trade readiness**: depth, eligibility, and the real quote if the user got one.
6. **Risks**: at least two concrete ones (for example a premium over the stock price, a thin pool, trading
   outside US hours, an upcoming earnings date).
7. Close with: "This is information for your own decision, not investment advice. Tokenized stocks
   can move quickly, outside US market hours too."

## Rules for you (the assistant)

- Never say "buy" or "sell" as an instruction, never size a position for the user, never promise a
  result. Present evidence on both sides.
- Never place an order, sign, or run `baw auth signin` or any login. Any x402 payment only after you
  state the price and the user says yes; anything other than a clear yes is a no.
- Quote `asOf` / `calculatedAt` with the numbers; if `staleness` is not fresh, say the data is old.
- A null is not zero. Relay errors as returned. HTTP 429 / `rate_limited`: wait and retry once.

## Full CLI Reference

See [`references/cli.md`](references/cli.md) and
[`references/external-sources.md`](references/external-sources.md).
