# External sources for 4lpha-bstock-analysis

Everything here is optional. The 4lpha data alone is enough for a reading. Paid sources are paid by
the user's own Binance Agentic Wallet through x402 with the `baw` CLI from the
`binance-agentic-wallet` skill; this skill never signs anything itself.

## Before any paid call (mandatory)

1. Run `4lpha-agent-status` for the wallet that would pay. If a 4lpha agent is active on it, stop:
   using `baw` on that wallet needs its session, and a new sign-in there disconnects 4lpha and ends
   the agent. Offer the free sources instead, or a different wallet.
2. Tell the user the service, what it returns, the price and the token (read both from the 402
   answer, never from this file), and ask. Anything other than a clear yes is a no.
3. One payment per request. If a payment result is unclear, do not sign a second one; report it.
4. Payment signing follows the `binance-agentic-wallet` skill's x402 instructions
   (`baw x402-payment preview` then `baw x402-payment sign`). Both services below use x402 v2 header
   names: the 402 answer carries `payment-required`, the paid retry sends `PAYMENT-SIGNATURE`, the
   settled answer carries `payment-response`.

## Free: news

Use the assistant's own web search for the underlying company (for NVDAB search NVIDIA / NVDA) and
for the US market. Name each source and its date in the answer.

## Paid, about 0.01 USDT per call: CoinMarketCap macro data

- Endpoint: `https://mcp.coinmarketcap.com/x402/mcp` (MCP over HTTP, header
  `Accept: application/json, text/event-stream`; the data is in the SSE `data:` line at
  `result.content[0].text`).
- Useful tools: `get_upcoming_macro_events` (scheduled US macro releases such as CPI or FOMC) and
  `get_global_metrics_latest` (a whole-crypto-market snapshot: market cap, volume, fear and greed).
- Flow: `tools/call` without payment -> HTTP 402 with `payment-required` -> preview and sign with
  `baw` -> repeat the same request with `PAYMENT-SIGNATURE` -> data.

## Paid, about 0.1 U per report: BNB Chain Stock Analyze Agent

- Base URL: `https://stock-agent.bnbchain.org` (answered on 2026-10-07; check the price first, it may
  change or go away).
- It analyses the UNDERLYING ticker (NVDA, not NVDAB): rating, target price, fundamentals,
  technicals, risk, as a Markdown report. It knows nothing about the token's pool or premium; the 4lpha
  data covers that.
- `GET /x402/price` returns the current price and accepted tokens (no payment).
- `POST /x402/analyze/async` with body `{"symbols":["NVDA"],"analysis_type":"comprehensive"}` ->
  402 -> preview and sign with `baw` (U or USD1 sign without an on-chain approval; USDT or USDC need a
  one-time Permit2 allowance) -> repeat with `PAYMENT-SIGNATURE` -> 202 with `jobId` and `jobToken`.
- Save `jobId` and `jobToken` before anything else and show them to the user: they are the only way
  to fetch the paid report.
- Poll `GET /x402/jobs/{jobId}` with header `X-Job-Token: <jobToken>` every 10 to 20 seconds; status
  goes `queued` -> `running` -> `succeeded` (usually 2 to 5 minutes), then `downloadUrl` gives the
  report. Do not block the conversation while it runs; tell the user it is coming.
- Never submit the same request again because it is slow (a new submit is a new payment). If status
  is `failed` with `retryable: true`, `POST /x402/jobs/{jobId}/resume` with the same `X-Job-Token`
  retries without a new payment.
- Limit: 30 new jobs per wallet per rolling hour (HTTP 429 `wallet_rate_limited`, honour
  `Retry-After`).
