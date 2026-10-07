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
| `settings` | object | AI Trade: `executionModel`, `capitalQuoteWei` + `capitalQuoteUsdt`, `entryWei` + `entryUsdt`, `maxOpenPositions`, `slippageBps`, `stopLossBps`, `takeProfitBps`, `maxHoldSec`. Other modes: `capitalQuoteWei`, `capitalQuoteUsdt`, `slippageBps` (and `portfolioDriftBps` for a portfolio) |
| `summary` | object, AI Trade only | `openPositions`, `maxOpenPositions`, `closedTrades`, `wins`, `winRateBps`, `grossDeltaWei`, `grossDeltaUsdt`, `grossComplete` |
| `positions` | array (max 10), AI Trade only | `{ symbol, status, entryUsdtWei, entryUsdt, exitUsdtWei, exitUsdt, pnlBps, live }`; `positionCount` gives the total |
| `schedule` | object, null or absent | `symbol, token, amountWei, amountUsdt, intervalSec, firstAtSec, nextDueAtMs, currentSlot, currentSlotTaken, plannedBuys, doneBuys, postponedBuys, buysThisSession, spentWei, spentUsdt, remainingWei, remainingUsdt, finished, endKind, endAtSec, endRuns, marketHoursOnly, premiumBps, maxPremiumBps, gasBnbAtomic, gasBnb, sessionExpiresAtSec`, and `holding: { quantityAtomic, quantity, valueWei, valueUsdt, verifiedSpentWei, verifiedSpentUsdt, boughtQuantityAtomic, boughtQuantity, verifiedFills, averageCostUsdt, marketPriceUsdt, pnlWei, pnlUsdt, valueReason }` (`valueWei` is the sell quote of what it holds; `averageCostUsdt`, `marketPriceUsdt` and `pnl*` are null until a buy is verified or while there is no quote) |
| `portfolio` | object, null or absent | `stocks` (max 5) of `{ symbol, token, targetBps, weightBps, driftBps, quantityAtomic, quantity, valueWei, valueUsdt, valueReason, entryCostWei, entryCostUsdt }`; totals `capitalQuoteWei/Usdt, netInvestedWei/Usdt, stockValueWei/Usdt, totalValueWei/Usdt, pnlWei/Usdt, cashWei/Usdt, idleWei/Usdt`; `driftBps` (largest), `intervalSec, currentSlot, nextCheckAtMs`; `check` (last rebalance check) `{ slot, state, maxDriftBps, valueWei, valueUsdt, checkedAtMs }`; `recentLegs` (max 5, newest first) of `{ slot, side, symbol, state, executionState, createdAtMs, plannedWei, plannedUsdt (buys) or plannedQuantityAtomic, plannedQuantity (sells), quantityAtomic, quantity, valueWei, valueUsdt }` |
| `dca` | object, null or absent | `symbol, token, reason, heldOrders, markPriceUsdt`; `settings { stepBps, takeProfitBps, baseWei/Usdt, orderWei/Usdt, maxOrders, stopLossBps, triggerPriceUsdt, rangeMinPriceUsdt, rangeMaxPriceUsdt }`; `round` (null with no round) `{ roundNo, phase, closeCause, openedAtMs, startPriceUsdt, averagePriceUsdt, takeProfitPriceUsdt, costWei/Usdt, realizedPnlWei/Usdt, levels (max 8) [{ levelNo, state, priceUsdt, sizeWei/Usdt, filledQuantityAtomic, filledQuantity }], takeProfit { state, priceUsdt } }`; `rounds { settled, realizedPnlWei/Usdt, markedPnlWei/Usdt }`; `holding { quantityAtomic, quantity, valueWei/Usdt, walletWei/Usdt }`; `pnlSinceHireWei/Usdt`, `equityWei/Usdt`, `stopLineWei/Usdt` |
| `earn` | object, null or absent | `totalWei, totalUsdt, liquidWei, liquidUsdt, earnedWei, earnedUsdt, withdrawingBeforeSignOut` |
| `erc8004` | object or null | `{ status, agentId }`, the agent's on-chain identity (viewable at 8004scan) |
| `pageUrl` | string | the public page with the full run log |

Rules:
- **Every `...Wei` field is a USDT amount as an integer string with 18 decimals, and the same
  object carries its decimal string ending in `Usdt`** (`"25000000000000000000"` and `"25.00"`, two
  decimals): show the `Usdt` string. `...Atomic` is a raw token quantity; the field of the same name
  without the suffix is the plain decimal (six significant digits). `...PriceUsdt` is USDT per share
  with four decimals. `bps` fields are numbers: 100 bps = 1 %.
- A mode block that is absent means the agent is another mode; `null` means 4lpha could not read that
  block this time. For `schedule`, `portfolio` and `dca` agents `positions`, `positionCount` and
  `summary` are not returned (they describe AI Trade).
- Not included on purpose: events, run log, the AI's reasons, data-fee log, transaction hashes (all on
  `pageUrl`).

## Errors

| Signal | Meaning |
|---|---|
| HTTP 429, `rate_limited` | 10 calls per minute per IP plus a shared ceiling; wait and retry once |
| `-32602` | malformed address, or the tool is switched off |
| `tool error: agent_unavailable` | 4lpha could not read the agent right now; retry later |
