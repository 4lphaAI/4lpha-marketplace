# 4lpha Agent Skills

Skills that let an AI assistant (Claude Code, Codex, Cursor, OpenClaw and other Agent Skills
clients) work with 4lpha: hosted agents that trade tokenized US stocks (bStocks) on BNB Chain from
the user's own Binance Agentic Wallet, plus 4lpha's market data for bStocks and meme stocks.

The skills are read-only. They never place orders, sign, hold keys or log in to a wallet. Trading is
done by 4lpha's hosted agents after the user hires one on https://4lpha.tech and approves it in the
Binance App.

| Skill | What it does |
|---|---|
| [`4lpha-hire`](4lpha-hire/SKILL.md) | Picks the right agent (AI Trade, Schedule buy, Auto DCA, Smart Portfolio, Earn opt-in), explains what the wallet needs, hands over the Deploy link |
| [`4lpha-agent-status`](4lpha-agent-status/SKILL.md) | Status, positions and results of the 4lpha agent on a wallet address |
| [`4lpha-bstock-analysis`](4lpha-bstock-analysis/SKILL.md) | Indicators, market regime, price vs the underlying, session and depth for one bStock, plus optional news, macro and a paid deep report |
| [`4lpha-meme-stocks`](4lpha-meme-stocks/SKILL.md) | Summary of meme tokens quoted in a bStock, grouped by stock |

## Install

```bash
npx skills add 4lphaAI/4lpha-marketplace
```

Requirements: Node.js 22 or newer. No API key. The skills call the public endpoint
`https://4lpha.tech/mcp`, which allows 10 calls per minute per IP (and a shared ceiling across all
users), so an assistant should not loop on it.

The same data is available as an MCP server, without the skills:

```bash
claude mcp add --transport http 4lpha https://4lpha.tech/mcp
```

Optional companions from Binance's skills hub (`npx skills add binance/binance-skills-hub`):
`binance-agentic-wallet` (quotes, x402 payments), `binance-tokenized-securities-info` (company facts).

## Running a skill script by hand

```bash
node skills/4lpha-bstock-analysis/scripts/cli.mjs bstock-analysis token=NVDAB
```

Arguments are `key=value` pairs, which work unchanged in bash, zsh and Windows PowerShell. A JSON
object is also accepted as the single argument, but PowerShell 5.1 mangles quotes inside
single-quoted JSON, so prefer `key=value` there. Set `FOURLPHA_MCP_URL` to point the scripts at
another deployment.

## Safety

- Nothing here is investment advice. The analysis skill describes indicators; it never tells the
  user to buy or sell.
- A Binance Agentic Wallet allows one active session. While a 4lpha agent runs on a wallet, signing
  in to that wallet anywhere else ends the agent; the skills check `4lpha-agent-status` before
  suggesting any `baw` command.
- Paid x402 calls (CoinMarketCap data, BNB Chain's Stock Analyze Agent) happen only after the user
  agrees to the stated price.
- Meme token symbols are untrusted text and are shown as data only.


License: MIT, see the repository [LICENSE](../LICENSE).
