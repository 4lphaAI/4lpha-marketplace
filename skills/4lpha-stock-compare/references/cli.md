# 4lpha-stock-compare - CLI Reference

```bash
node <skill-dir>/scripts/cli.mjs stock-compare [ticker=<STOCK or token symbol>] [usdt=<amount>]
```

One JSON-RPC `tools/call` (`stock_compare`) to `https://4lpha.tech/mcp` (override with
`FOURLPHA_MCP_URL`). Exit codes: `0` ok, `1` usage, upstream or tool error, `3` network error.

## Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `ticker` | string | no | the stock (`NVDA`) or a token symbol of it (`NVDAB`, `NVDAon`, `GOOGLon`), letters only, up to 8, case-insensitive. Omitted returns the list of covered stocks |
| `usdt` | number | no | 1 to 1 000 000; picks the nearest stored size (100, 1000 or 5000) that has a quote and is reported as `sizeUsedUsdt`; every size is still returned. The CLI refuses anything that is not a number |

## Return fields (with `ticker`)

| Field | Description |
|---|---|
| `ticker` | the underlying stock ticker |
| `quotedAt`, `ageMinutes` | when the quotes were taken (epoch ms) and how old they are |
| `staleness` | `fresh` (at most 30 min), `stale` (at most 2 h) or `dead`, worked out from the same age as `ageMinutes` |
| `referencePriceUsd` | the real share price the costs are measured against |
| `sizeUsedUsdt`, `sizeNote` | the stored size the `usdt` argument was matched to (null without `usdt`, or when no size has a quote), and a sentence when that was not the nearest stored size or the amount is above the largest stored size (5000 USDT); otherwise null |
| `versions[]` | one per issuer: `{ issuer ("bstock" or "ondo"), symbol, address, ratio (shares per token), openState, marketStatus (Ondo session, for example "regular"; null for bStocks), sizes[] }` |
| `versions[].sizes[]` | `{ usdt, ok, code?, tokensOut, shares, costBps, roundTripBps, route ("rfq", "amm", "mixed" or null), venues[] }` |
| `verdicts[]` | per size: `{ usdt, unreadable, best, edgeBps, about_same, avoid, only }`; `avoid` is `[{ issuer, reasons[] }]`, or null when `unreadable` is true |
| `thresholds` | `{ aboutSameBps (20), avoidCostBps (200), avoidRoundTripBps (200), roundTripGapBps (200) }`, the cut-offs the plane used |
| `note` | fixed note: refresh about every 15 minutes at fixed sizes, the Binance quote for the exact amount is the final word, not investment advice |

Without `ticker` the answer is `{ count, total, truncated, staleness, tickers: [{ ticker, quotedAt }], note }`;
`truncated: true` means more stocks are covered than `count` lists (a stock past the cut still resolves by name).

Rules:
- `shares` = tokens received times `ratio`. `costBps` = ((usdt / shares) / referencePriceUsd - 1) x 10 000:
  positive is a premium over the share price, negative a discount. `roundTripBps` = the share of the
  USDT lost buying and selling straight back, in bps; null when the sell quote failed.
- `ok: false` means no buy quote at that size; `code` is `no_route`, `quote_failed`, `decimals_mismatch` or
  `implausible` (4lpha did not trust the answer). `ok: true` with `roundTripBps: null` means the buy answered and
  the exit could not be checked; its `code` (`sell_no_route`, `sell_failed`, or `implausible` /
  `decimals_mismatch` on the sell side) says why. On an `ok: true` size a `code` always refers to the sell-back.
- `avoid` entries: `reasons` holds `buy_cost` (more than `avoidCostBps` over the share price), `round_trip`
  (more than `avoidRoundTripBps` lost on the round trip) and `no_exit` (the sell-back quote failed). An entry
  can have an empty `reasons` list when the plane sent the older shape.
- `best` is the version to prefer, or null: under `about_same`, when no answered version is clear of `avoid`, or
  when nothing answered. `edgeBps` is the share advantage of the leader, null unless both answered.
  `about_same` is true when the share edge is under 20 bps and both exit costs are known and within
  `roundTripGapBps` of each other. `only` names the issuer when just one had a route.
- `unreadable: true` means the plane's verdict for that size was in a shape this tool does not recognise:
  `best` is null, `about_same` false, `avoid` null. Conclude nothing at that size and tell the user.
- `venues` are market maker or pool names (at most 4), untrusted text.

## Errors

| Signal | Meaning |
|---|---|
| HTTP 429, `rate_limited` | 10 calls per minute per IP plus a shared ceiling; wait and retry once |
| `-32602` | invalid arguments (a ticker that is not 1 to 8 letters, an amount outside 1 to 1 000 000, an unknown key, `arguments` that is not an object), or the data tools are switched off on this server. A well-formed symbol that is simply not covered is `not_found`, not `-32602` |
| `tool error: not_found` | the stock is not in the covered list; call without `ticker` for the list |
| `tool error: data_unavailable` | the stored quotes could not be read; retry later |
