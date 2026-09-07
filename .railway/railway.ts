// Railway infrastructure for the 4lpha marketplace (project `4lpha-execution`).
//
//   railway config plan     preview
//   railway config apply    apply (run from the repo root or from .railway/)
//
// One GitHub source (branch `main`), five services and one Postgres. Every
// backend service is built from `Dockerfile.services` (repo root) and picks
// its entry through `startCommand`; the web is the Next.js app under `web/`
// with its own Dockerfile and the ONLY public domain.
//
// Secrets never live in this file. Values marked `preserve()` are set once in
// the Railway dashboard (or with `railway variable set`) and kept as they are
// by every apply; the workers read the shared ones through service references
// so a secret exists in exactly one place:
//   execution-api    EXECUTION_MASTER_KEY, EXECUTION_API_TOKEN,
//                    EXECUTION_OPERATOR_TOKEN, OWNER_READ_SESSION_SECRET,
//                    DATA_PLANE_TOKEN
//   trade-worker     TRADE_LLM_API_KEY
//   identity-worker  ERC8004_MINTER_PRIVATE_KEY   (this service only)
//   web              NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
//
// The passkey RP ID is PINNED to the custom domain `4lpha.tech`. Changing it
// again re-registers every passkey and mints different owner addresses, so it
// moves only after every account on the current host is wound down — the first
// attempt (2026-09-06) was made on the belief that production held no agent,
// stranded two that had been hired since, and had to be rolled back to let
// their owner sign at all. `BILLING_ENABLED` stays off.
import { defineRailway, github, postgres, preserve, project, service } from "railway/iac";

const REPO = "4lphaAI/4lpha-marketplace";
const BRANCH = "main";
const DATA_PLANE_URL = "https://data-plane-production.up.railway.app";
const API_PORT = "8090";

export default defineRailway(() => {
  const db = postgres("Postgres");
  const source = github(REPO, { branch: BRANCH });
  const servicesImage = { builder: "DOCKERFILE" as const, dockerfilePath: "Dockerfile.services" };

  // Shared, non-secret execution-plane configuration (mirrors the local setup).
  const plane = {
    EXECUTION_NETWORK: "mainnet",
    DATABASE_URL: db.env.DATABASE_URL,
    BILLING_ENABLED: "off",
    DATA_PLANE_URL,
    FEE_TREASURY_ADDRESS: "0x7e41F09dF5cb1Ec9323bC101D3a9e65bE4e510AD",
    FEE_BPS: "100",
    GRID_ENABLED: "true",
    LP_ENABLED: "true",
    HIRE_ENABLED: "true",
    TRADE_AGENT_ENABLED: "true",
    LP_MAX_PRICE_IMPACT_BPS: "100",
    LP_MAX_SPOT_TWAP_DEVIATION_BPS: "2000",
    LP_MIN_OBSERVATION_CARDINALITY: "100",
    LP_MIN_POOL_LIQUIDITY_WEI: "1000000000000000000000",
    LP_TWAP_WINDOW_SECONDS: "1800",
    LP_MAX_SAGA_SLIPPAGE_BPS: "100",
    LP_RELAY_FEE_PER_SUBMIT_WEI: "37600000000000",
    LP_WORKER_INTERVAL_SEC: "30",
    LP_CONVERSION_COMPATIBLE_TOKENS_JSON: '["0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"]',
    // The workers resolve the hire config too (HIRE_ENABLED requires
    // PASSKEY_ENABLED), so the passkey trio is shared, not API-only.
    //
    // A passkey is scoped by RP ID and the owner address is derived from the
    // credential's own public key, so moving the RP ID does not migrate an
    // account — it mints a different one and strands whatever the old wallet
    // holds. `passkeyVerifier` enforces both halves (exact origin allowlist,
    // then `sha256(rpId)` against `authenticatorData`), and `PASSKEY_RP_ID`
    // takes ONE value, so the two hosts cannot be served at once.
    //
    // Moved to `4lpha.tech` on 2026-09-07 only after the operator confirmed the
    // two accounts held on the railway.app host were wound down. Those
    // credentials can no longer sign here; the railway.app origin is
    // deliberately absent so nobody creates a third account on a dead host.
    //
    // A literal, NOT `${{web.RAILWAY_PUBLIC_DOMAIN}}`: that variable's meaning
    // is no longer obvious now the service carries a custom domain too.
    PASSKEY_ENABLED: "true",
    PASSKEY_RP_ID: "4lpha.tech",
    PASSKEY_ORIGINS: "https://4lpha.tech",
  };
  const llm = {
    TRADE_LLM_BASE_URL: "https://router-api.0g.ai/v1",
    TRADE_LLM_MODEL: "0gm-1.0-35b-a3b",
  };

  const api = service("execution-api", {
    source,
    build: servicesImage,
    deploy: {
      startCommand: "node --import tsx src/index-server.ts",
      healthcheckPath: "/health",
      healthcheckTimeout: 180,
      restartPolicyType: "ALWAYS",
    },
    env: {
      ...plane,
      PORT: API_PORT,
      EXECUTION_MASTER_KEY: preserve(),
      EXECUTION_API_TOKEN: preserve(),
      EXECUTION_OPERATOR_TOKEN: preserve(),
      OWNER_READ_SESSION_SECRET: preserve(),
      DATA_PLANE_TOKEN: preserve(),
    },
  });

  const fromApi = {
    EXECUTION_MASTER_KEY: api.env.EXECUTION_MASTER_KEY,
    DATA_PLANE_TOKEN: api.env.DATA_PLANE_TOKEN,
  };

  const trade = service("trade-worker", {
    source,
    build: servicesImage,
    deploy: {
      startCommand: "node --import tsx scripts/trade-worker.ts",
      restartPolicyType: "ALWAYS",
    },
    env: {
      ...plane,
      ...fromApi,
      ...llm,
      TRADE_LLM_API_KEY: preserve(),
    },
  });

  const lp = service("lp-worker", {
    source,
    build: servicesImage,
    deploy: {
      startCommand: "node --import tsx scripts/lp-worker.ts",
      restartPolicyType: "ALWAYS",
    },
    env: {
      ...plane,
      ...fromApi,
      ...llm,
      TRADE_LLM_API_KEY: trade.env.TRADE_LLM_API_KEY,
    },
  });

  const identity = service("identity-worker", {
    source,
    build: servicesImage,
    deploy: {
      startCommand:
        "sh -c 'node --import tsx scripts/erc8004-identity.ts migrate && exec node --import tsx scripts/erc8004-worker.ts --daemon'",
      restartPolicyType: "ALWAYS",
    },
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      ERC8004_IDENTITY_ENABLED: "true",
      ERC8004_IDENTITY_DAEMON_ENABLED: "true",
      ERC8004_MINTER_EXCLUSIVE: "true",
      ERC8004_REGISTRY_ADDRESS: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      ERC8004_RPC_URL: "https://bsc-dataseed.binance.org",
      ERC8004_MINTER_ADDRESS: "0x273987e9d86D5231b0Be928Aba88129AC479Ca9d",
      ERC8004_CHAIN_ID: "56",
      ERC8004_MAX_GAS_PER_TX: "2000000",
      ERC8004_MAX_GAS_PRICE_WEI: "100000000",
      ERC8004_MAX_INSTANCE_FEE_WEI: "300000000000000",
      // 0.1 BNB/day (operator decision 2026-09-06) ≈ 400 registrations at the
      // measured ~0.00025 BNB each; the per-instance cap stays 0.0003 BNB.
      ERC8004_MAX_DAILY_FEE_WEI: "100000000000000000",
      ERC8004_MINTER_PRIVATE_KEY: preserve(),
    },
  });

  const web = service("web", {
    source: github(REPO, { branch: BRANCH, rootDirectory: "web" }),
    deploy: {
      healthcheckPath: "/api/pools",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      EXECUTION_URL: `http://execution-api.railway.internal:${API_PORT}`,
      EXECUTION_API_TOKEN: api.env.EXECUTION_API_TOKEN,
      DATA_PLANE_URL,
      DATA_PLANE_TOKEN: api.env.DATA_PLANE_TOKEN,
      NEXT_PUBLIC_EXEC_CHAIN_ID: "56",
      NEXT_PUBLIC_EXEC_NETWORK: "mainnet",
      NEXT_PUBLIC_PASSKEY_ENABLED: "true",
      // INERT IN THE BROWSER TODAY, kept deliberately. `passkeyRpId()` reads
      // `process.env["NEXT_PUBLIC_PASSKEY_RP_ID"]` with BRACKET notation, which
      // Next does not statically replace (dot notation is), so the bundle keeps
      // the variable name and the value never lands: measured on the deployed
      // build, 27 scripts / 2.8 MB contain the name once and neither host
      // string at all. The browser therefore always falls back to
      // `location.hostname`, which is why the service can answer on two hosts
      // and still agree with the plane on whichever one is loaded.
      //
      // It stays set so the value is already correct if that read is ever
      // switched to dot notation — at which point loading the wrong host fails
      // at the ceremony instead of at the plane, which is the better failure.
      NEXT_PUBLIC_PASSKEY_RP_ID: "4lpha.tech",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: preserve(),
    },
  });

  return project("4lpha-execution", {
    resources: [db, api, lp, trade, identity, web],
  });
});
