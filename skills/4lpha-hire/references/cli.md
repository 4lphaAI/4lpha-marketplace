# 4lpha-hire - CLI Reference

```bash
node <skill-dir>/scripts/cli.mjs <command> [key=value ...]
```

Each command sends one JSON-RPC `tools/call` to `https://4lpha.tech/mcp` (override with
`FOURLPHA_MCP_URL`) and prints the tool's JSON. Exit codes: `0` ok, `1` usage, upstream or tool error,
`3` network error or timeout (10 s).

## `list-agents` - tool `list_agents`

No parameters.

Returns `{ agents: [...], note }`. Each agent:

| Field | Type | Description |
|---|---|---|
| `id` | string | `agentic-ai-trade`, `agentic-schedule`, `agentic-dca`, `agentic-portfolio` (Binance Agentic Wallet custody); `grid`, `lp`, `trade`, `health` are 4lpha's passkey-wallet agents for DeFi |
| `name` | string | display name |
| `category` | string | `Tokenized Stocks` for the Agentic agents |
| `status` | string | `available` or `unavailable` (not offered right now) |
| `custody` | string | `binance-agentic` or `altana` |
| `path`, `deployUrl` | string | the Deploy page; every Agentic agent starts at `/deploy/trading` |
| `description` | string | one paragraph |

## `hire-link` - tool `get_hire_link`

| Param | Type | Required | Description |
|---|---|---|---|
| `agent` | string | yes | one of the ids above |

For an Agentic id:

| Field | Type | Description |
|---|---|---|
| `status` | string | `available` / `unavailable` |
| `deployUrl` | string | the plain Deploy link |
| `whatItDoes` | string | short description |
| `steps` | string[] | the setup steps in order (open the link, pick the mode, Deploy, choose Agentic Wallet, QR in the Binance App, code, checks) |
| `requirements.termDays` | number[] | `[7, 30]` |
| `requirements.binanceApp` | string[] | settings the Deploy check verifies in the Binance App |
| `requirements.funding.usdt` / `.bnb` | string | how much USDT and BNB the wallet must hold, as rules |
| `requirements.settings` | string[] | the agent's own minimums and ranges |
| `requirements.termEnd` | string | what happens at the end of the term |
| `rules` | string[] | dedicated wallet, how to stop, holdings, public page |
| `earn` | object or null | `{ offered, note, conditions[] }`; null for Smart Portfolio (no Earn) |
| `authorises` | string | what hiring grants, in one sentence |

For a passkey-wallet id the answer is `{ agent, name, status, deployUrl, authorises }`.

## `explain-strategy` - tool `explain_strategy`

| Param | Type | Required | Description |
|---|---|---|---|
| `agent` | string | yes | `grid`, `lp` or `trade` |

Static product guidance for 4lpha's passkey-wallet agents.

## Errors

| Signal | Meaning | What to do |
|---|---|---|
| HTTP 429, `rate_limited` | the public endpoint allows 10 calls per minute per IP and a shared ceiling for all users | wait for the printed retry time, retry once |
| `-32602 Unknown tool or invalid arguments` | wrong id or argument, or the tool is switched off | check the arguments; do not retry blindly |
| `tool error: <code>` | the tool answered but could not get the data | report the code |
