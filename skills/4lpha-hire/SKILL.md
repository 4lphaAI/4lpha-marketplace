---
name: 4lpha-hire
description: |
  Front door to 4lpha's hosted agents that trade tokenized US stocks (bStocks) on BNB Chain from the
  user's own Binance Agentic Wallet, around the clock, without the user's computer staying on:
  (1) list - the agents and what each one does: AI Trade, Schedule buy, Auto DCA, Smart Portfolio,
  plus the Earn opt-in that lends idle USDT to Venus or Aave v3;
  (2) hire link - the Deploy link, the setup steps on 4lpha.tech and in the Binance App, and what the
  wallet must hold and allow (USDT, BNB for gas, Binance App settings, term).
  Use for: "DCA into NVDAB automatically", "buy SPYB every day", "rebalance a basket of stocks",
  "an AI agent that trades tokenized stocks for me", "earn on idle USDT while the agent waits",
  "how do I hire a 4lpha agent", "what do I need in my Agentic Wallet to start".
  NOT for: checking an agent already hired (use 4lpha-agent-status), analysing one stock
  (use 4lpha-bstock-analysis), placing a trade yourself (use binance-agentic-wallet).
license: MIT
metadata:
  author: 4lpha
  version: "1.0"
---

# 4lpha Hire Skill

## Overview

4lpha runs automated strategies for tokenized stocks on BNB Chain. The user connects their Binance
Agentic Wallet once (a QR pairing in the Binance App), funds it, and 4lpha's hosted worker trades on
that wallet 24/7 inside the limits the user set in the Binance App. Holdings stay in the user's
own wallet (or the user's own Venus / Aave position when Earn is on). 4lpha never holds a private key:
it holds the trading session the user approved by QR, bounded by the daily limits in the Binance App,
and the user can end it at any time by signing out.

**This skill does not trade, sign or connect anything.** It helps the user pick the right agent,
checks the numbers with them, and hands over the Deploy link. The hire itself is done by the user in
the browser and the Binance App.

| Agent | What it does | Fits a user who |
|---|---|---|
| AI Trade | Watches the bStocks the user pins and opens or closes positions from technical indicators, a market-regime read and an LLM check; pays small CMC data fees from the wallet via x402 | wants active, rule-driven trading |
| Schedule buy | Buys a fixed USDT amount of one stock at a fixed interval until the budget or end date is reached | wants simple recurring buying |
| Auto DCA | A first buy, then a ladder of lower buys as the price falls, a take-profit on the whole position and a stop-loss | wants to buy dips with a planned exit |
| Smart Portfolio | Holds 2 to 5 stocks at target weights and rebalances when they drift | wants a hands-off basket |
| Earn (opt-in) | Lends part of the idle USDT of AI Trade, Schedule or Auto DCA to Venus or Aave v3 and withdraws it when the strategy needs cash | wants idle cash to earn while waiting |

## When to Use This Skill

| User intent | Command |
|---|---|
| Which agents exist, what each does | `list-agents` |
| How to hire one, what the wallet needs | `hire-link agent=<id>` |
| How a strategy works in more depth | `explain-strategy agent=<id>` |

Agent ids: `agentic-ai-trade`, `agentic-schedule`, `agentic-dca`, `agentic-portfolio`. Earn is an
option inside AI Trade, Schedule and Auto DCA, not a separate id.

## How to Call

```bash
node <skill-dir>/scripts/cli.mjs <command> [key=value ...]
```

Examples:

```bash
node <skill-dir>/scripts/cli.mjs list-agents
node <skill-dir>/scripts/cli.mjs hire-link agent=agentic-dca
```

`key=value` arguments work in every shell, including Windows PowerShell. A JSON object is also
accepted as the single argument. If the 4lpha MCP server is configured in the client
(`https://4lpha.tech/mcp`), calling the tools `list_agents` / `get_hire_link` directly is equivalent.

## Workflow

1. Ask what the user wants to achieve (recurring buys, buying dips, a basket, active trading) and
   with roughly how much USDT. Suggest the agent from the table above; one sentence on why.
2. Run `hire-link agent=<id>`. If its `status` is `unavailable`, say the agent is not offered right
   now and stop. Otherwise present, from its answer, never from memory:
   - the Deploy link and the steps in order;
   - what the wallet must hold: USDT for the capital (plus the data budget where it applies) and BNB
     for gas;
   - the Binance App settings the Deploy check will verify (for example Trade all tokens, the daily
     limit, the x402 daily limit, the maximum sign-in time) and the term (7 or 30 days);
   - the minimums for that agent.
3. Walk the user through the user's own numbers (for example, 100 USDT over 10 buys) against those
   minimums, and say plainly if something will not pass.
4. Tell the user the rules below before they deploy.

## Rules the user must hear before deploying

- **One wallet, one agent.** While a 4lpha agent runs, that Agentic Wallet is dedicated to it: no
  manual trading from it. A Binance Agentic Wallet allows one active session; signing in to the same
  wallet anywhere else (another app, another agent, a local `baw` login) disconnects 4lpha and ends
  the agent.
- **How to stop:** sign out of the Agentic Wallet session in the Binance App. The agent ends for good
  (hire a new one to start again). Holdings stay in the wallet; the user sells them in the Binance App.
- **Term end:** the agent stops and signs its session out. AI Trade asks at Deploy whether to sell
  everything to USDT at the end or keep the holdings; the other agents keep the holdings.
- The agent's activity is public and read-only at `https://4lpha.tech/agentic/<wallet>`.

## Rules for you (the assistant)

- Never place an order, sign, or run `baw auth signin` or any login for the user. The user hires in
  the browser.
- Take every number from the `hire-link` answer. If a number is missing, say so; do not guess.
- Do not promise returns. Do not call any agent safe or recommended for everyone.
- If the user already has an agent on a wallet, use `4lpha-agent-status` before suggesting anything
  that touches that wallet.
- Relay errors as returned. HTTP 429 / `rate_limited` means the shared endpoint allows a few calls per
  minute: wait and retry once, do not loop.

## Full CLI Reference

See [`references/cli.md`](references/cli.md).
