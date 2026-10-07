# 4lpha-agent-status - CLI Reference

```bash
node <skill-dir>/scripts/cli.mjs agent-status wallet=<0x address>
```

One JSON-RPC `tools/call` (`agent_status`) to `https://4lpha.tech/mcp` (override with
`FOURLPHA_MCP_URL`). Exit codes: `0` ok, `1` usage, upstream or tool error, `3` network error.

## Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `wallet` | string | yes | the Agentic Wallet address, `0x` + 40 hex characters |

## Return fields

No agent ever ran on the wallet: `{ wallet, custody: "binance-agentic", agent: null, note, pageUrl }`.

Otherwise `agent` carries:

| Field | Type | Description |
|---|---|---|
| `name` | string | agent name |
| `mode` | string | `trade` (AI Trade), `schedule`, `portfolio`, `dca` |
| `status` | string | `running`, `held`, `draining`, `entries-stopped`, `ending`, `ended` |
| `holdCode` | string or null | why it is held: `trade-all-tokens`, `abnormal-handling`, `sign-in-time`, `daily-limit`, `x402-limit` (a Binance App setting changed or a limit was hit), `other` |
| `endReason` | string or null | why it ended |
| `termDays`, `termEndAction` | number, string | term and what happens at its end |
| `hireStartedAtMs`, `entryCutoffAtMs`, `hireEndsAtMs` | number | epoch milliseconds |
| `connection` | object | session state with Binance |
| `settings` | object | `executionModel`, `capitalQuoteWei`, `entryWei`, `maxOpenPositions`, `slippageBps`, `stopLossBps`, `takeProfitBps`, `maxHoldSec` |
| `summary` | object | `openPositions`, `maxOpenPositions`, `closedTrades`, `wins`, `winRateBps`, `grossDeltaWei`, `grossComplete` |
| `positions` | array (max 10) | `{ symbol, status, entryUsdtWei, exitUsdtWei, pnlBps, live }`; `positionCount` gives the total |
| `schedule` | object, null or absent | `symbol, amountWei, intervalSec, nextDueAtMs, plannedBuys, buysThisSession, spentWei, remainingWei, finished, endKind, premiumBps, maxPremiumBps` |
| `portfolio` | object, null or absent | `capitalQuoteWei, netInvestedWei, stockValueWei, totalValueWei, pnlWei, driftBps, intervalSec, nextCheckAtMs` |
| `dca` | object, null or absent | `symbol, heldOrders, reason` |
| `earn` | object, null or absent | `totalWei, liquidWei, earnedWei, withdrawingBeforeSignOut` |
| `erc8004` | object or null | `{ status, agentId }`, the agent's on-chain identity (viewable at 8004scan) |
| `pageUrl` | string | the public page with the full run log |

Rules:
- **Every `...Wei` field is a USDT amount as an integer string with 18 decimals**: divide by 10^18
  (for example `"25000000000000000000"` = 25 USDT). `bps` fields: 100 bps = 1 %.
- A mode block that is absent means the agent is another mode; `null` means 4lpha could not read that
  block this time.
- Not included on purpose: events, run log, the AI's reasons, data-fee log, transaction hashes (all on
  `pageUrl`).

## Errors

| Signal | Meaning |
|---|---|
| HTTP 429, `rate_limited` | 10 calls per minute per IP plus a shared ceiling; wait and retry once |
| `-32602` | malformed address, or the tool is switched off |
| `tool error: agent_unavailable` | 4lpha could not read the agent right now; retry later |
