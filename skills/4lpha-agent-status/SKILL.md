---
name: 4lpha-agent-status
description: |
  Read-only status of a 4lpha agent running on a Binance Agentic Wallet, looked up by the wallet
  address: whether it is running, held, ending or ended (and why), which strategy it runs (AI Trade,
  Schedule buy, Auto DCA, Smart Portfolio), term dates, positions with entry and exit amounts and
  profit or loss, the Earn position, and its ERC-8004 identity. No login, nothing is changed.
  Use for: "how is my 4lpha agent doing", "is my agent still running", "what did my agent buy",
  "status of the agent on 0x...", "why did my agent stop", "is there a 4lpha agent on this wallet".
  NOT for: hiring a new agent (use 4lpha-hire), the wallet's balances or transfers
  (use binance-agentic-wallet), stock analysis (use 4lpha-bstock-analysis).
license: MIT
metadata:
  author: 4lpha
  version: "1.0"
---

# 4lpha Agent Status Skill

## Overview

Every 4lpha agent on a Binance Agentic Wallet has a public, read-only page at
`https://4lpha.tech/agentic/<wallet>`. This skill returns a compact summary of the same data so the
assistant can answer questions about it. It needs only the wallet address; it cannot pause, stop or
change an agent (the user stops an agent by signing out of the session in the Binance App).

## When to Use This Skill

| User intent | Command |
|---|---|
| Status, positions and results of the agent on a wallet | `agent-status wallet=<0x address>` |
| Check before running any `baw` command on a wallet | `agent-status wallet=<0x address>` |

## How to Call

```bash
node <skill-dir>/scripts/cli.mjs agent-status wallet=<0x address>
```

The address is the 0x address of the Agentic Wallet on BNB Chain (40 hex characters). Equivalent MCP
tool: `agent_status` on `https://4lpha.tech/mcp`.

## Reading the answer

- `agent: null` means no 4lpha agent has ever run on that wallet. Say exactly that.
- `status`: `running` (trading normally), `held` (paused by a safety check, `holdCode` says which;
  often a Binance App setting changed or a limit was reached), `draining` / `entries-stopped` (no new
  entries, exits still managed), `ending` (term end in progress), `ended` (`endReason` says why, for
  example the owner signed out or the term finished).
- Amounts: every field ending in `Wei` is USDT as an integer string with 18 decimals; divide by
  10^18 before showing it (`"25000000000000000000"` = 25 USDT). `pnlBps` is profit or loss in basis
  points (100 bps = 1 %). Open positions carry `live`; their value moves with the market.
- Mode blocks: `schedule`, `portfolio`, `dca` or `earn` appear only for that kind of agent; `null`
  means 4lpha could not read that part this time (say so, do not show zeros).
- Times are epoch milliseconds; convert them to the user's local time.
- Point the user to `pageUrl` for the full run log, the agent's reasons and the order history.

## Rules for you (the assistant)

- Read-only. Never suggest signing in to that wallet with `baw` or another app while the agent is
  active: one Agentic Wallet allows one session, and a new sign-in disconnects 4lpha and ends the agent.
- If the status is `held`, explain the hold code in plain words and, when it is a Binance App setting,
  which setting to fix in the App. Do not invent a fix the answer does not support.
- Do not judge the strategy or promise a result; report what the data says.
- A wallet address is public data, but do not collect or compare other people's wallets unless the
  user asks about a specific address.
- Relay errors as returned. HTTP 429 / `rate_limited`: wait and retry once.

## Full CLI Reference

See [`references/cli.md`](references/cli.md).
