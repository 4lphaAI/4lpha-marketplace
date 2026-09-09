# 4LPHA — BNB Chain Agent Marketplace

[Live app](https://4lpha.tech) · [Docs](https://docs.4lpha.tech) · **[Market data repository](https://github.com/4lphaAI/4lpha-market-data)**

Deploy agents that manage PancakeSwap grids and liquidity, screen and trade markets, or protect Venus borrowing positions. This repository contains the marketplace frontend and execution plane. The **[separate market-data plane](https://github.com/4lphaAI/4lpha-market-data)** supplies market discovery, prices, pools and risk evidence; it is a core part of the system.

| Agent | What it does | Demo video |
|---|---|---|
| Grid | Places concentrated-liquidity buy/sell ranges and shifts them as the market moves. | [Watch Grid demo](https://youtu.be/I5uyElPdtfo?si=LveDK1hVZYKhM_Yl) |
| Trading | Screens an owner-authorized token universe, uses rules and 0G Compute LLM analysis, and executes entries and risk/time-based exits. | [Watch Trading demo](https://youtu.be/Y1jobkuKXH8) |
| LP | Opens PancakeSwap V3 liquidity, rebalances, compounds fees and applies configured protection exits. | [Watch LP demo](https://youtu.be/1uIeKGeg1no?si=c3oBJ6ZVtWJp-3v5) |
| Lending | Supplies a rescue reserve to Venus and repays a monitored account's debt when health-factor conditions trigger. | [Watch Lending demo](https://youtu.be/I7wxbKY0-ac?si=qIUkoD_waYymXi6W) |

## 5 mainnet task results

**Evidence refreshed 9 September 2026.** Open Grid/LP snapshots are from **10:40:43 UTC**; completed tasks retain their original measurement windows. These are selected real production tasks, not simulated marketplace-card statistics or a 30-day backtest. The five selected tasks cover the active mubarak Grid, the best-returning completed mubarak LP, the stronger of the two active USDT/WBNB LPs, the best-returning closed Trading position among 11 closed trades rechecked on September 9, and a Lending agent with receipt-confirmed repayments. Different windows are shown explicitly; this is a curated showcase, not an aggregate return or a claim that every agent beats HODL.

| Task / ERC-8004 identity | Measurement window (UTC) | Agent result | Passive comparison, same window | Difference |
|---|---|---|---|---|
| **Grid · mubarak/WBNB** — `grid-agent-01-2` · [#337848](https://8004scan.io/agents/bsc/337848) | Sep 6 17:54:35 → Sep 9 10:40:43; still open | **−3.11%**; 0.062700 → **0.060748385 BNB-equivalent** | Hold mubarak: **−7.05%** | **+3.94%** |
| **LP · mubarak/WBNB** — `lp-agent-01` · [#337272](https://8004scan.io/agents/bsc/337272) | Sep 6 15:58:50 → 17:19:47; closed | **−0.83%**; 0.030000 → **0.029752 BNB-equivalent** | Hold mubarak: **−1.18%** | **+0.35%** |
| **LP · USDT/WBNB** — `4lpha-lp-agent-01-2` · [#340032](https://8004scan.io/agents/bsc/340032) | Sep 8 03:14:57 → Sep 9 10:40:43; still open | **+1.80%**; 0.020000 → **0.020360171 BNB-equivalent** | Hold USDT, valued in BNB: **−1.61%** | **+3.41%** |
| **Trading · LIon** — one position of `trading-agent-01-new` · [#341245](https://8004scan.io/agents/bsc/341245) | Sep 8 15:13:55 → 15:46:23; closed by take-profit rule | **+108.38%**; 0.001800 → **0.003750829 BNB** | Hold LIon: **+106.87%** | **+1.51% before gas/relay** |
| **Lending · Venus USDT debt** — `lending-agent-01-3` · [#340548](https://8004scan.io/agents/bsc/340548) | Sep 8 04:53:58 arm → 08:37:22 second repayment | **1.619104 USDT repaid** across two transactions from a 0.020 BNB rescue budget | A passive reserve makes **no automatic repayments**; absent these actions, debt would be about **1.619104 USDT higher**, holding other actions fixed and excluding incremental interest | Debt reduction, **not investment profit** or proof that liquidation was imminent |

Since the September 8 snapshot, the featured USDT/WBNB LP improved from **+1.13% to +1.80%**. Grid’s return fell from **−2.32% to −3.11%**, while token-HODL fell from **−5.16% to −7.05%**: its gross relative advantage widened from **+2.83 to +3.94%**. LIon remains the best recorded closed trade; no additional lending repayment was recorded.

For return rows, Difference = agent return − HODL return; % is used as shorthand for this arithmetic gap, not a relative percentage increase.

### Transactions and measured costs

Every linked execution receipt was checked for success on BNB Chain (chain ID 56); each ERC-8004 ID was checked against the on-chain registry metadata. Registration proves identity, not returns or execution authority.

| Task | Transaction proof | Receipt gas, BNB |
|---|---|---:|
| Grid mubarak | [Arm](https://bscscan.com/tx/0x6e07bc9c5fd03e6c3ed555d673864b5a5cb8557117507466a14063ee75a94557) · [latest recorded shift](https://bscscan.com/tx/0x0b05fec0362c1aaf146f3ca1c87c1dec0dba56cb8595c804bfa6c7816a2934b2) · [wallet history](https://bscscan.com/address/0xdfB9fE4922DAF390349D5cfAF94185eA4CC02764) | **0.00090554735** / 15 executions |
| LP mubarak | [Arm](https://bscscan.com/tx/0xfde2418aa0d4dfefbf7d11964b19592b11ad17dc76a5fe49e7776ad2db92fcf1) · [collect/close](https://bscscan.com/tx/0x25f22ba6af4dbc3327827ceb569e123e5b1a04d15161e2ba59c635e1adfdc51e) · [sell volatile leg](https://bscscan.com/tx/0xe9d0e7405acad7c0575e9222a8c3ab9ae41e4e697441761c6ea19dd79e0f5257) | **0.000077265** / 3 executions |
| LP USDT/WBNB | [Arm](https://bscscan.com/tx/0xdb5a9db4544e5c03baa60e698785218a01e1a7904a793d910aa70e7606167645) · [latest recorded rebalance](https://bscscan.com/tx/0x6fe25805203374f20cb0fe6226650cb3e053c54e71742c32f6ab80b288c5dc04) · [wallet history](https://bscscan.com/address/0x7C523545D5EB79ea69d90BA0A7426cb16018c0fF) | **0.0002421918** / 6 executions |
| Trading LIon | [Buy](https://bscscan.com/tx/0xa7f286a5c297e517d48b55ae793c5f7900512ed10d67e6f9ffe2371d94bd195b) · [take-profit sell](https://bscscan.com/tx/0xbcccc4290acfe96492ba2a23d13e40e1e6956ac98af8ee7d2a597a31f0f321b6) | **0.0000639502** / 2 executions |
| Lending `lending-agent-01-3` | [Arm/supply](https://bscscan.com/tx/0xe58e397584be3640bbf3827f3c0f1f3439a26a05e04695bd4fd3698d864d2cd4) · [repay 0.633459 USDT](https://bscscan.com/tx/0x81edce77dc57563eed4adfd687a8dcc3460f0af84280f0ac16b6b3459c219273) · [repay 0.985645 USDT](https://bscscan.com/tx/0xb817b334b035683608dcb8bbdc5feed1cd9e79a0a3317b84ac5039b810106db0) | **0.000067852** / arm + 2 repayments |

**Cost scope:** gas is `sum(gasUsed × effectiveGasPrice)` for the listed task's recorded executions, not the full amount billed by the relay. LIon’s buy includes a **0.000017821782178217 BNB platform fee**, already counted in its entry cost. Pool trading fees/slippage are embedded in execution amounts. Subtracting the two receipts’ gas alone would bring LIon’s return to **+104.83%**, before any additional relay charges; the headline comparison is not a net-of-cost advantage. Registration/grant, funding/recovery, relay overhead and off-chain AI/infrastructure costs are outside these gas totals. A reconciled per-task relay/AI bill was unavailable, so these results are **not all-in net returns**.

**Method:** returns use selected strategy capital and a **BNB/WBNB numeraire**, not USD. Open Grid/LP values at finalized block **120863899** include position principal, full collectible fees and wallet pool-token balances; compounded fees are not added again. The closed LP reconstructs proceeds, task-generated token dust and the initial unused-native refund from receipts. Gas reserves and grant funding are excluded. HODL allocates the same starting capital entirely to the named base asset and uses the pool's post-entry and endpoint spot prices (V3 `sqrtPriceX96² / 2¹⁹²`; LIon V2 `Sync` reserves at entry block **120708378** and exit block **120712706**). It is a frictionless token-HODL benchmark, not a 50/50 LP basket or a quoted liquidation return. LIon uses post-swap spot reserves, which include the selected trade’s own price impact; this single winning trade does not establish strategy-wide outperformance. The lending receipts prove repayments; their amounts are transfers from the reserve, not yield.

## Architecture

The marketplace has **two separate planes**: the [market-data plane](https://github.com/4lphaAI/4lpha-market-data) provides read-only market evidence; this repository runs the UI and execution plane. The diagrams separate data dependencies from transaction execution. Arrows in the first diagram show **information supplied**, not transaction authority.

### Market data and AI

```mermaid
flowchart LR
    D["Market-data plane<br/>4lpha-market-data"]
    G["0G Compute<br/>LLM inference"]
    D -->|HTTP| W["Web server / BFF"]
    D -->|HTTP| A["Execution API"]
    D -->|HTTP| T["Trading worker"]
    G --> T
    G -->|optional LP brain| L["LP / Grid worker"]
```

Market discovery, token/pool data and risk evidence use `DATA_PLANE_URL`. This is distinct from execution-time chain reads: LP/Grid and Lending workers read pool/position or Venus account state through their chain readers; the browser also reads wallet/NFT state for display and owner recovery. Lending's health-factor decisions do not require an LLM.

### Execution and custody

```mermaid
flowchart TB
    W["Public marketplace<br/>Browser + server BFF"] -->|HTTP| A
    subgraph P["Private execution services"]
        A["Execution API<br/>Owner actions and agent state"]
        R["Autonomous workers<br/>LP / Grid · Trading · Lending"]
        DB[("PostgreSQL<br/>Agents · journal · strategy state")]
        X["Execution controls<br/>Policy · caps · pause · idempotency"]
        A <--> DB
        R <--> DB
        A --> X
        R --> X
    end
    X --> S["Altana provider / relay<br/>Scoped session execution"]
    S --> C["BNB Chain<br/>User wallet · PancakeSwap · Venus"]
```

API and workers are separate processes sharing stores and execution libraries; workers do **not** route their autonomous actions through the BFF. The controls box represents shared code, not another deployed service. Session permissions, spend caps and expiry are enforced on-chain; the journal holds ambiguous outcomes instead of blindly resubmitting them.

| Boundary | Implementation |
|---|---|
| **Frontend / backend** | `web/` has its own dependencies, build and deployment and never imports backend `src/`. Only its server BFF holds execution-service credentials. The production API and PostgreSQL are private Railway services. |
| **Owner custody** | A new passkey-controlled Altana wallet is funded by the user. The owner signs grants and owner actions; the server stores encrypted session keys, not the owner's private key. Owner-signed on-chain revoke/recovery bypasses the normal agent execution path. |
| **Runtime authority** | Pause/halt is server-side refusal. On-chain revocation is the hard stop. A compromised session key remains a risk within its granted permissions; selector permissions do not universally constrain approval/recipient arguments. Autonomous HTTP trade/raw routes additionally require request-bound runtime assertions; raw execution defaults off. |
| **ERC-8004 identity** | PostgreSQL enrollment → isolated identity worker → BNB Chain registry. A dedicated platform minter registers agents; it has no customer session authority. This identity path is separate from DeFi execution. |
| **Lending** | The monitored borrow stays on account A; reserve wallet B supplies funds on Venus and repays on A's behalf. Repayment is a transfer from the reserve, not investment income. |

Source: [deployment services](./.railway/railway.ts), [API composition](./src/index-server.ts), [LP/Grid worker](./scripts/lp-worker.ts), [Trading worker](./scripts/trade-worker.ts), [Lending wiring](./src/lending/wiring.ts), and [market-data client](./src/clients/dataPlane.ts).

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
