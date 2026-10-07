# 4lpha-bstock-analysis - CLI Reference

```bash
node <skill-dir>/scripts/cli.mjs bstock-analysis token=<SYMBOL or 0x address> [interval=15m|1h]
```

One JSON-RPC `tools/call` (`bstock_analysis`) to `https://4lpha.tech/mcp` (override with
`FOURLPHA_MCP_URL`). Exit codes: `0` ok, `1` usage, upstream or tool error, `3` network error.

## Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `token` | string | yes | bStock symbol (letters and digits, up to 12, case-insensitive, e.g. `NVDAB`) or its BNB Chain contract address |
| `interval` | string | no | `15m` or `1h`; omitted returns both |

## Return fields

| Field | Description |
|---|---|
| `token` | `{ symbol, address, underlyingTicker, sectors[] }` |
| `staleness` | freshness of the bStock row: `fresh`, `stale` or `dead` |
| `market` | `{ openState, reasonCode, nextOpenMs, nextCloseMs, session }`; `session` = `{ usEquity, state (rth, overnight, close), nextBoundaryAt, sessionStart, lastRthCloseAt }` or null |
| `price` | `{ venuePriceUsd (deepest priced pool), navUsd, referencePriceUsd (one share of the stock), tokenToShareRatio, premiumBps, asOf }` |
| `depth` | `{ venueCount, deepest: { dex, version, feeTier, quote{symbol,address}, liquidityUsd, volume24hUsd, asOf } or null, deepPool (liquidity >= deepPoolThresholdUsd), priceImpact: null, priceImpactReason }` |
| `eligibility` | `{ eligible, reason, source, checkedAt }` (may 4lpha's agents trade it) or `{ error }` |
| `indicators["15m"]`, `indicators["1h"]` | `{ source ("pool" or "underlying"), calculatedAt, staleness, coverage{availableBars, contiguousBars, realBars, filledBars, latestClose}, metrics }` or `{ error }` |
| `regime` | `{ label (risk_on, risk_off, neutral, unavailable), reasons[], asOf, sessionState, legs{spy, qqq}, staleness }` or `{ error }` |
| `note` | fixed note: these are the indicators 4lpha AI Trade reads, not a recommendation |

Each metric is `{ value (number or null), reason (null or why it is missing), unit, asOf? }`. Names:
`roc10Pct, ema12, ema26, emaSpreadPct, atr14, atrPct, rvol20, momentum10, rsi14, macd, signal9,
histogram, bbMiddle20, bbUpper20, bbLower20, bbPosition20, bbWidthPct20, stochRsi14, lastRthClose,
gapPct, vwapSession, vwapDistancePct, orbHigh, orbLow, orbBreakPct`. Units: `percent` means already a
percentage; `ratio` means 0 to 1 (`bbPosition20` can leave that range when the price is outside the
bands).

Rules:
- A stale snapshot keeps HTTP 200 but every metric has `value: null` and `reason: "stale_input"`.
- `source: "underlying"` (bStocks without a deep pool) is computed on the stock's per-share price:
  no volume metrics (`unknown_volume_unit`), and prices are per share, not per token.
- `premiumBps` is the deepest priced pool against the underlying price times shares per token.
- Section errors: `data_unavailable`, `features_pending`, `not_in_feature_watchlist`,
  `features_unavailable`, `outside_feature_watchlist`, `store_unavailable`. Report them; the other
  sections are still valid.

## Errors

| Signal | Meaning |
|---|---|
| HTTP 429, `rate_limited` | 10 calls per minute per IP plus a shared ceiling; wait and retry once |
| `-32602` | bad symbol format or interval, or the tool is switched off |
| `tool error: not_a_bstock` | the token is not one of the bStocks 4lpha tracks |
| `tool error: data_unavailable` | 4lpha's market data could not be read; retry later |
