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
    VENUE_PANCAKE_ROUTER_V3: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
    VENUE_WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    GRID_ENABLED: "true",
    LP_ENABLED: "true",
    // DEMO MODE. Simulated grid/trading agents on live prices: no session, no
    // key, no grant and no path to a transaction (`src/demo/**`, and the import
    // ban its `types.ts` documents). The worker runs inline in the API process
    // by default — one timer over shared reads — so no second service is
    // needed; set `DEMO_WORKER_INLINE=false` here if one is ever added, so the
    // two never drive the same rows at once.
    DEMO_ENABLED: "true",
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

  // The lending venue, pinned by address rather than discovered. Both the API
  // and the worker resolve the same config, so it lives in one place.
  //
  // VENUS_PRIME_ADDRESS is load-bearing even though the guard grants Prime
  // NOTHING: the boot census compares Prime's EIP-1967 implementation against
  // the recorded routing, and an unset value resolves Prime to the Comptroller,
  // so the comparison cannot match and EVERY lending grant refuses. Verified on
  // chain 2026-09-08: this proxy's implementation slot reads
  // 0x18cb7198cbb6d6e94001458cf3cf47c106d83a1b, exactly what the census records
  // (FINDINGS (bn) §1, which also carries the full PASS table at block
  // 120 530 819).
  //
  // WARNING, blast radius: `buildLendingServerDeps` is awaited at the top level
  // of `src/index-server.ts` with no try/catch and reads the chain — underlying,
  // pool liquidity and the routing census. A failure there is a BOOT failure for
  // execution-api, which serves grid, LP and trading too. Rollback is one step:
  // set LENDING_ENABLED to "false" here (or in the dashboard) and redeploy.
  const lendingVenue = {
    LENDING_ENABLED: "true",
    LENDING_VUSDT_ADDRESS: "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
    VENUS_VBNB_ADDRESS: "0xA07c5b74C9B40447a954e1466938b865b6BBea36",
    VENUS_PRIME_ADDRESS: "0x059eaba8676b03e4e8f009efb7f587c28450f50f",
    LENDING_SWAP_FEE_TIER: "100",
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
      // Lending. Without these three the `/lending/*` routes 404 byte-identically
      // to an unknown path and the hire's preview receipt cannot be minted.
      ...lendingVenue,
      // 64 lowercase hex, its OWN secret — never derived from
      // EXECUTION_MASTER_KEY, which has exactly one consumer. Generate once with
      // `openssl rand -hex 32` in Git Bash and paste the VALUE (cmd.exe has
      // stored the literal `$(openssl …)` string here before). Absent ⇒ S1 is
      // fail-closed and mints no receipt.
      LENDING_PREVIEW_SECRET: preserve(),
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

  // LENDING WORKER — PREPARED, DELIBERATELY NOT DECLARED YET.
  //
  // `scripts/lending-worker.ts` REFUSES to start when `LENDING_ENABLED` is not
  // exactly "true" (it throws; `src/lending/wiring.ts:150-166` does the same for
  // `DATABASE_URL` and chain 56). With `restartPolicyType: "ALWAYS"` a service
  // declared before the flag is on would crash-loop forever, so this block goes
  // live in the SAME change that turns the guard on — not before.
  //
  // Enabling lending touches TWO services, not one:
  //   execution-api   + LENDING_ENABLED, LENDING_VUSDT_ADDRESS,
  //                     LENDING_PREVIEW_SECRET  (without these the `/lending/*`
  //                     routes 404 byte-identically to an unknown path, and the
  //                     hire's preview receipt cannot be minted or verified)
  //   lending-worker  the block below
  //
  // `LENDING_PREVIEW_SECRET` is a DEDICATED 64-hex secret (never derived from
  // `EXECUTION_MASTER_KEY` — that key has exactly one consumer). Set it once in
  // the dashboard on execution-api and reference it here, the way the other
  // shared secrets are wired. `LENDING_VUSDT_ADDRESS` is checked at boot by
  // reading `underlying()`; a wrong address fails the boot rather than a
  // request. `LENDING_SWAP_FEE_TIER` defaults to 100 and is validated at boot
  // against a live WBNB/USDT pool with non-zero liquidity.
  //
  // ACTIVE since 2026-09-08. Without this service nothing ever rescues: the
  // API's flag only opens hire and arm, and the guard is the worker.
  //
  // EXACTLY ONE lending worker per database — the advisory lock and the claim
  // CAS bound two racing workers to one submission per interval, but two
  // daemons are not a supported configuration. If anyone runs
  // `npm run lending-worker` against this Postgres, stop this service first.
  const lending = service("lending-worker", {
    source,
    build: servicesImage,
    deploy: {
      startCommand: "node --import tsx scripts/lending-worker.ts",
      restartPolicyType: "ALWAYS",
    },
    env: {
      ...plane,
      ...fromApi,
      ...lendingVenue,
      LENDING_PREVIEW_SECRET: api.env.LENDING_PREVIEW_SECRET,
      // Optional; the defaults are the audited ones.
      // LENDING_WORKER_INTERVAL_MS: "30000",   // floor 15000
    },
  });

  // ─── TermiX Agent.family Quant — `quant-worker` (QUANT-GRID §7.5 / W11) ────
  //
  // COMMENTED ON PURPOSE, and the reason is NOT the lending one.
  // `scripts/quant-worker.ts` EXITS 0 when `QUANT_ENABLED` is off (a deliberate
  // departure from the lending worker, whose throw crash-loops) — but
  // `restartPolicyType: "ALWAYS"` restarts a CLEAN exit too, so an early
  // declaration is still a restart loop, just a quiet one. R2.13 therefore
  // keeps the lending RULE: this block goes live in the SAME change that sets
  // `QUANT_ENABLED=true`.
  //
  // EXACTLY ONE REPLICA, EVER. The per-job fence protects a job against two
  // cycles; it does not protect the INBOX against two pollers, and a first
  // fetch marks an envelope DELIVERED to the client. `src/deployment/
  // workerSingleton.ts`'s `quant-worker` role is the enforcement — the daemon
  // AND `npm run live-quant -- worker` take the same lock — but two daemons is
  // not a supported configuration and the lock is not a licence to try.
  //
  // Enabling quant touches ONE service only: there is no HTTP route, no `web/`
  // surface and no `execution-api` flag (§11). What it DOES require is the
  // DEPLOYMENT ORDER RULE (R2.7): every service that calls `reconcile` —
  // `execution-api`, `lp-worker`, `trade-worker`, `lending-worker` — must
  // already be running a commit that knows the `quantTrade` journal kind, or a
  // crashed quant row falls through their unrecognized-kind branch and parks as
  // a permanent UNKNOWN. Railway builds every service from one commit, so the
  // precondition is simply "all services healthy on the new commit".
  //
  // SECRETS. `QUANT_ENVELOPE_KEY` (the HKDF seed for our X25519 pair) and
  // `QUANT_API_KEY` (the TermiX REST bearer) are `preserve()` on THIS SERVICE
  // ONLY. Neither is ever read by `execution-api`, `web`, or any other worker;
  // the seed signs nothing and is used for HKDF alone. `QUANT_PARAMS_DIGEST`
  // must equal `keccak(canonical params)` of the resolved economics or the boot
  // refuses (R3.6) — changing a band or a tolerance is therefore a new digest
  // AND a new strategy version on TermiX, not a quiet variable edit.
  //
  // const quant = service("quant-worker", {
  //   source,
  //   build: servicesImage,
  //   deploy: {
  //     startCommand: "node --import tsx scripts/quant-worker.ts",
  //     restartPolicyType: "ALWAYS",
  //   },
  //   env: {
  //     ...plane,
  //     QUANT_ENABLED: "true",
  //     QUANT_AGENT_ID: "<the TermiX agent id for 4lpha>",
  //     QUANT_STRATEGY_ID: "<the listed strategy id>",
  //     QUANT_API_BASE_URL: "https://platform-backend.prod.termix.live",
  //     QUANT_PARAMS_DIGEST: "<keccak of the resolved params; boot refuses on a mismatch>",
  //     // Optional; the defaults are the cleared ones (band 700 bps, 3 levels,
  //     // 10 U min clip, 50 bps edge, 50/50 bps tolerances, 50 bps impact).
  //     // QUANT_WORKER_INTERVAL_MS: "60000",   // floor 30000, ceiling 600000
  //     QUANT_ENVELOPE_KEY: preserve(),
  //     QUANT_API_KEY: preserve(),
  //   },
  // });

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
      ERC8004_MINTER_ADDRESS: "0xD7E004CBda24E079aA3A657Ba7f8E2915192a966",
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
    resources: [db, api, lp, trade, lending, identity, web],
  });
});
