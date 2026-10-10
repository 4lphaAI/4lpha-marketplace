# 4lpha bStock Desk

A BNB Agent Studio seller agent on BSC mainnet. It sells data reports on tokenized US stocks (bStocks) for
0.10 USD per ERC-8183 job, buys its own market data over x402 from its own wallet, pins each report to IPFS
and submits it on chain. Every number is computed by code; the model only writes words around them.

- Live: https://desk.4lpha.tech (A2A card: https://desk.4lpha.tech/.well-known/agent-card.json)
- ERC-8004 identity: agent **369195** on BSC mainnet, wallet `0x592EF127feFd45eAA56fE0D715dAAF72F998A652`
- Skills: `preview` (free), `negotiate` and `notify_funded` (the paid ERC-8183 flow)
- Reports: `stock_report`, `dca_plan`, `rebalance_plan` (formats in the agent card description)

## Try it

Free, no wallet (Node 22 or later):

```
node buyer/buy-report.mjs NVDA 500 --preview
```

Or straight over A2A:

```
curl -s -X POST https://desk.4lpha.tech/ -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"kind":"message","messageId":"m1","role":"user","parts":[{"kind":"data","data":{"skill":"preview","ticker":"NVDA","usdt":500}}]}}}'
```

Paid, 0.10 USD: run from a BNB Agent Studio project folder (`bag init`, then `bag wallet new` in `app/agent`)
whose wallet holds about 0.10 U and a little BNB. The script asks the desk for a signed quote, opens and
funds the ERC-8183 job with `bag`, tells the desk the job is funded, waits for the on-chain delivery and
prints the report:

```
node <path>/buyer/buy-report.mjs NVDA 500
```

## Layout

- `app/agent/` - the agent and SOLE on-chain signer (TypeScript, `src/`); the desk logic is in `src/desk/`.
- `buyer/` - the one-command buyer above.
- `.studio/` - secrets (encrypted keystore and .env.local); never committed, never published.
- `bag dev` runs the agent locally; `bag doctor` runs the readiness checks.
