# 4LPHA — BNB Chain Agent Marketplace

[Live app](https://4lpha.tech) · [Docs](https://docs.4lpha.tech) · **[Market data repository](https://github.com/4lphaAI/4lpha-market-data)**

Deploy agents that manage PancakeSwap grids and liquidity, screen and trade markets, or protect Venus borrowing positions. This repository contains the marketplace frontend and execution plane. The **[separate market-data plane](https://github.com/4lphaAI/4lpha-market-data)** supplies market discovery, prices, pools and risk evidence; it is a core part of the system.

| Agent | What it does |
|---|---|
| Grid | Places concentrated-liquidity buy/sell ranges and shifts them as the market moves. |
| Trading | Screens an owner-authorized token universe, uses rules and 0G Compute LLM analysis, and executes entries and risk/time-based exits. |
| LP | Opens PancakeSwap V3 liquidity, rebalances, compounds fees and applies configured protection exits. |
| Lending | Supplies a rescue reserve to Venus and repays a monitored account's debt when health-factor conditions trigger. |

## Five mainnet task results

**Evidence captured 8 September 2026.** These are selected real production tasks, not simulated marketplace-card statistics or a 30-day backtest. The five selected tasks cover the active mubarak Grid, the best-returning completed mubarak LP, the stronger of the two active USDT/WBNB LPs, and two separately deployed Lending agents with receipt-confirmed repayments. Different windows are shown explicitly; this is a curated showcase, not an aggregate return or a claim that every agent beats HODL.

| Task / ERC-8004 identity | Measurement window (UTC) | Agent result | Passive comparison, same window | Difference |
|---|---|---|---|---|
| **Grid · mubarak/WBNB** — `grid-agent-01-2` · [#337848](https://8004scan.io/agents/bsc/337848) | Sep 6 17:54:35 → Sep 8 15:22:57; still open | **−2.32%**; 0.062700 → **0.061244 BNB-equivalent** | Hold mubarak: **−5.16%** | **+2.83 percentage points** |
| **LP · mubarak/WBNB** — `lp-agent-01` · [#337272](https://8004scan.io/agents/bsc/337272) | Sep 6 15:58:50 → 17:19:47; closed | **−0.83%**; 0.030000 → **0.029752 BNB-equivalent** | Hold mubarak: **−1.18%** | **+0.35 percentage points** |
| **LP · USDT/WBNB** — `4lpha-lp-agent-01-2` · [#340032](https://8004scan.io/agents/bsc/340032) | Sep 8 03:14:57 → 15:22:57; still open | **+1.13%**; 0.020000 → **0.020226 BNB-equivalent** | Hold USDT, valued in BNB: **−1.63%** | **+2.76 percentage points** |
| **Lending · Venus USDT debt** — `lending-agent-69` · [#341264](https://8004scan.io/agents/bsc/341264) | Sep 8 14:49:30 arm → 14:51:43 repayment | **1.971767 USDT repaid** from a 0.050 BNB rescue budget; debt immediately after repayment: **20.028240 USDT** | A passive reserve makes **no automatic repayments**; absent this action, debt at that point would be **22.000007 USDT**, holding other actions fixed | **1.971767 USDT less debt**, funded by the reserve; not investment profit |
| **Lending · Venus USDT debt** — `lending-agent-01-3` · [#340548](https://8004scan.io/agents/bsc/340548) | Sep 8 04:53:58 arm → 08:37:22 second repayment | **1.619104 USDT repaid** across two transactions from a 0.020 BNB rescue budget | A passive reserve makes **no automatic repayments**; absent these actions, debt would be about **1.619104 USDT higher**, holding other actions fixed and excluding incremental interest | Debt reduction, **not investment profit** or proof that liquidation was imminent |

The roughly “−2% versus −6%” running mubarak example is the **Grid** task above. Its verified snapshot is −2.32% versus −5.16%; live percentages change with the market. The separate mubarak LP row is a completed 81-minute task.

### Transactions and measured costs

Every linked execution receipt was checked for success on BNB Chain (chain ID 56); each ERC-8004 ID was checked against the on-chain registry metadata. Registration proves identity, not returns or execution authority.

| Task | Transaction proof | Receipt gas, BNB |
|---|---|---:|
| Grid mubarak | [Arm](https://bscscan.com/tx/0x6e07bc9c5fd03e6c3ed555d673864b5a5cb8557117507466a14063ee75a94557) · [latest recorded shift](https://bscscan.com/tx/0xafbafd3078f20213fdc10ab9c15cde5fbc385414c33bd05ba3e0aaea5e734c42) · [wallet history](https://bscscan.com/address/0xdfB9fE4922DAF390349D5cfAF94185eA4CC02764) | **0.000778560** / 13 executions |
| LP mubarak | [Arm](https://bscscan.com/tx/0xfde2418aa0d4dfefbf7d11964b19592b11ad17dc76a5fe49e7776ad2db92fcf1) · [collect/close](https://bscscan.com/tx/0x25f22ba6af4dbc3327827ceb569e123e5b1a04d15161e2ba59c635e1adfdc51e) · [sell volatile leg](https://bscscan.com/tx/0xe9d0e7405acad7c0575e9222a8c3ab9ae41e4e697441761c6ea19dd79e0f5257) | **0.000077265** / 3 executions |
| LP USDT/WBNB | [Arm](https://bscscan.com/tx/0xdb5a9db4544e5c03baa60e698785218a01e1a7904a793d910aa70e7606167645) · [latest recorded rebalance](https://bscscan.com/tx/0xdb71d64b551384ea8999d8823729041f79cb5bfb56c2c46eee8b405f9634506f) · [wallet history](https://bscscan.com/address/0x7C523545D5EB79ea69d90BA0A7426cb16018c0fF) | **0.000198952** / 5 executions |
| Lending `lending-agent-69` | [Arm/supply](https://bscscan.com/tx/0xf83a955f19e54d1de1eb187e87e4f5badcab87129568425a95c19043c7f51a53) · [repay 1.971767 USDT](https://bscscan.com/tx/0xe12d4a9cd4de0d79b04fcb4348fda75e7ede50f419ab81623ba21dd5522d945e) | **0.000045343** / arm + 1 repayment |
| Lending `lending-agent-01-3` | [Arm/supply](https://bscscan.com/tx/0xe58e397584be3640bbf3827f3c0f1f3439a26a05e04695bd4fd3698d864d2cd4) · [repay 0.633459 USDT](https://bscscan.com/tx/0x81edce77dc57563eed4adfd687a8dcc3460f0af84280f0ac16b6b3459c219273) · [repay 0.985645 USDT](https://bscscan.com/tx/0xb817b334b035683608dcb8bbdc5feed1cd9e79a0a3317b84ac5039b810106db0) | **0.000067852** / arm + 2 repayments |

**Cost scope:** gas is `sum(gasUsed × effectiveGasPrice)` for the listed task's recorded executions, not the full amount billed by the relay. Pool trading fees/slippage are embedded in execution amounts. Registration/grant, funding/recovery, relay overhead and off-chain AI/infrastructure costs are outside these gas totals. A reconciled per-task relay/AI bill was unavailable, so these results are **not all-in net returns**.

**Method:** returns use selected strategy capital and a **BNB/WBNB numeraire**, not USD. Open Grid/LP values at finalized block **120709583** include position principal, full collectible fees and wallet pool-token balances; compounded fees are not added again. The closed LP reconstructs proceeds, task-generated token dust and the initial unused-native refund from receipts. Gas reserves and grant funding are excluded. HODL allocates the same starting capital entirely to the named base asset and uses the pool's post-entry and endpoint spot prices (V3 `sqrtPriceX96² / 2¹⁹²`). It is a frictionless token-HODL benchmark, not a 50/50 LP basket or a quoted liquidation return. The lending receipts prove repayments; their amounts are transfers from the reserve, not yield. These are two separate deployments using the same reserve wallet and monitored borrower, not two independent customers.

## Architecture

**Execution flow** — read left to right:

```mermaid
flowchart LR
    U["User<br/>Passkey wallet"] --> W["Marketplace<br/>Next.js + BFF"]
    W --> E["Execution plane<br/>API + agent workers"]
    E --> A["Altana<br/>Scoped sessions"]
    A --> B["BNB Chain<br/>PancakeSwap · Venus"]
```

| Component | Responsibility |
|---|---|
| **[Market-data plane](https://github.com/4lphaAI/4lpha-market-data)** | Separate repository supplying discovery, prices, pools and risk evidence to the UI and agents through `DATA_PLANE_URL`. Execution providers also read chain state and receipts. |
| **Marketplace · `web/`** | Independent frontend build and deployment. The server BFF calls the private execution API over HTTP; service credentials never reach the browser. |
| **Execution API + workers** | Hono/TypeScript API and LP/Grid, Trading and Lending workers. PostgreSQL holds tenant-scoped agents, encrypted session keys, strategy state and the idempotent execution journal. Ambiguous submissions are held for reconciliation. |
| **Identity worker** | An isolated platform minter registers each agent in ERC-8004. Identity grants no authority over customer funds. |

**Custody and control:** the browser creates a new passkey-controlled Altana wallet that the user funds. The owner grants a session with call permissions, spend caps and expiry; the server holds no owner private key. Pause/halt stops server execution; the owner signs on-chain revocation and recovery directly. A compromised session key remains a risk within its granted permissions, including approval/recipient limitations. Autonomous HTTP trade/raw requests also require runtime assertions; raw execution defaults off. Lending uses the reserve wallet to repay the monitored account on its behalf.

## Development

Requires Node.js 22+ and PostgreSQL for production persistence. Configure from [`.env.example`](./.env.example); keep credentials out of git and browser bundles.

```bash
# Execution plane — offline checks
npm ci
npm run typecheck
npm test

# Independent marketplace frontend
cd web
npm ci
npm run dev
```

Backend entry points: `src/index-server.ts`, `scripts/lp-worker.ts` (LP/Grid), `scripts/trade-worker.ts`, `scripts/lending-worker.ts` and `scripts/erc8004-worker.ts`. Deployment configuration lives in `.railway/railway.ts`; frontend and backend use separate Docker builds. Live scripts and enabled workers can spend real funds and require deliberate configuration and authorization.
