/**
 * Provision an agent and serve the API from ONE process, on the in-memory store.
 *
 * WHY THIS EXISTS
 *
 * `scripts/provision-agent.ts` requires `DATABASE_URL` for a good reason: it
 * writes a row that a SEPARATE server process has to read, and a row written to
 * memory dies with the script. But that turns "try one trade" into "stand up a
 * Postgres first", which is a lot of setup to prove a pipeline works. Running
 * both halves in one process removes the requirement honestly — the two halves
 * share the same store objects, so there is nothing to persist between them.
 *
 * WHAT IT IS NOT
 *
 * Not a deployment. State lives in memory and is gone when this exits. Anything
 * beyond a smoke test wants Postgres and the two scripts run separately, exactly
 * as `npm run provision` and `npm run serve` do.
 *
 * WHAT IT REUSES, AND WHY THAT MATTERS AT THESE BALANCES
 *
 * A session grant costs gas AND a KeyStore registration fee, so re-granting on
 * every restart would quietly burn the wallet. The granted session's facts are
 * therefore written to `.provision-state.json` (gitignored, PUBLIC data only —
 * no key material), and on the next run the session is REUSED when the chain
 * still reports it active. This mirrors `.spike-state.json`, which exists for
 * the same reason.
 *
 * USAGE
 *   npx tsx scripts/dev-stack.ts --agent-id test-1 --cap-day 0.05 --tokens 0xA,0xB
 *   (then, in another terminal, npm run live-trade -- ...)
 */
import { MemoryLpFeeEventStore } from "../src/store/lpFeeEvents.js";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { getAddress, isAddress, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createServer, type ServerConfig } from "../src/server.js";
import { buildDemoWiring } from "../src/demo/wiring.js";
import { startDemoWorker } from "../src/demo/worker.js";
import { MemoryAgentStore, type SessionFacts } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryNonceStore } from "../src/store/nonces.js";
import { MemoryRuntimeReplayStore } from "../src/store/runtimeReplays.js";
import {
  assertRuntimeVerifierOnlyEnvironment,
  resolveRuntimeAuthConfig,
} from "../src/auth/runtimeAuth.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { loadMasterKey } from "../src/store/crypto.js";
import { HttpDataPlaneClient } from "../src/clients/dataPlane.js";
import { AltanaProvider, authorityFromPrivateKey } from "../src/wallet/altana.js";
import { createProviderRegistry } from "../src/wallet/registry.js";
import { validateSessionSpec } from "../src/core/session.js";
import { encodeJsonbParam, decodeJsonb } from "../src/store/codec.js";
import {
  checkNativeCapSizing,
  exitReserveWei,
  maxOffChainDailyCapWei,
  resolveLpRelayFeePerSubmitWei,
  tradeSessionSpec,
} from "../src/ops/policy.js";
import {
  resolveTradeConfig,
  resolveExecuteRawEnabled,
  resolveLpEnabled,
} from "../src/ops/config.js";
import { MemoryLpSequenceStore } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { buildLpServerDeps, type BuiltLpServerDeps } from "../src/lp/wiring.js";
import { buildLendingServerDeps } from "../src/lending/wiring.js";
import { resolveLendingEnabled } from "../src/ops/config.js";
import {
  nextLendingCycleDelayMs,
  runLendingWorkerOnce,
  type LendingWorkerDeps,
} from "../src/lending/worker.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import {
  createLpWorkerState,
  resolveLpWorkerBootConfig,
  runLpWorkerOnce,
  sleepUntilNextCycle,
  type LpWorkerDeps,
} from "../src/lp/worker.js";
import { createLpBrainTransport } from "../src/lp/brain.js";
import { reconcile } from "../src/store/journal.js";
import { readEnvValue, writeEnvValue } from "./spike/env.js";

const STATE_PATH = new URL("../.provision-state.json", import.meta.url);

type ProvisionState = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly walletAddress: Address;
  readonly publicKey: Hex;
  readonly expiresAt: number;
  readonly chainId: number;
  /** The granted spec, re-validated on load. Public policy data, no secrets. */
  readonly spec: unknown;
};

function arg(name: string, fallback?: string): string {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (entry === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) return next;
      return "true";
    }
    if (entry !== undefined && entry.startsWith(`--${name}=`)) {
      return entry.slice(name.length + 3);
    }
  }
  if (fallback === undefined) throw new Error(`--${name} is required.`);
  return fallback;
}

/**
 * `--tokens 0xA,0xB` — the ERC-20s the session may trade.
 *
 * Same meaning as `provision-agent.ts`: each becomes an `approve` rule plus a
 * per-token spend cap, and a token absent from the list cannot be BOUGHT at all
 * (PHASE2.3 R1). Validated here so a typo fails before a grant costs gas.
 */
function parseTokens(raw: string): readonly Address[] {
  if (raw.trim() === "" || raw === "true") return [];
  const seen = new Set<string>();
  const tokens: Address[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === "") continue;
    if (!isAddress(value)) {
      throw new Error(`--tokens contains "${value}", which is not a valid address.`);
    }
    const address = getAddress(value);
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    tokens.push(address);
  }
  return tokens;
}

function loadState(): ProvisionState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    // The spec carries bigint spend caps, so this file goes through the same
    // bigint-safe codec the Postgres store uses. Plain JSON.parse would hand
    // back strings where bigints belong and the permissions would not match
    // the ones the grant was signed over.
    return decodeJsonb(JSON.parse(readFileSync(STATE_PATH, "utf8"))) as ProvisionState;
  } catch {
    return null;
  }
}

/**
 * Persist the grant's facts, LOUDLY.
 *
 * This runs immediately after a grant that cost real gas and a KeyStore
 * registration fee. If it throws, the money is already spent and the facts are
 * the only thing that makes the session usable — so a failure prints them
 * rather than letting them die with the process. (The first version of this
 * script used a plain `JSON.stringify`, which cannot serialize the bigint spend
 * caps: it threw here, right after a successful paid grant, and orphaned it.)
 */
function saveState(state: ProvisionState): void {
  try {
    writeFileSync(STATE_PATH, `${encodeJsonbParam(state)}\n`);
  } catch (error) {
    console.error(
      `\n[dev-stack] COULD NOT WRITE ${STATE_PATH.pathname}: ` +
        `${error instanceof Error ? error.message : "unknown"}\n` +
        `The session below is granted and PAID FOR. Save this by hand or the fee is wasted:\n` +
        `${JSON.stringify(state, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}`,
    );
  }
}

async function main(): Promise<void> {
  assertRuntimeVerifierOnlyEnvironment(process.env);
  const agentId = arg("agent-id");
  const capDay = arg("cap-day", "0.05");
  const capDayOffChain = arg("cap-day-offchain", "");
  const tokens = parseTokens(arg("tokens", ""));
  const isMainnet = (process.env["EXECUTION_NETWORK"] ?? "").trim() === "mainnet";
  const network: NetworkConfig = isMainnet ? BNB : BNB_TESTNET;
  const keyStore = getAddress(network.keyStore);

  const execToken = process.env["EXECUTION_API_TOKEN"]?.trim() ?? "";
  const operatorToken = process.env["EXECUTION_OPERATOR_TOKEN"]?.trim() ?? "";
  const dataPlaneUrl = process.env["DATA_PLANE_URL"]?.trim() ?? "";
  for (const [name, value] of [
    ["EXECUTION_API_TOKEN", execToken],
    ["EXECUTION_OPERATOR_TOKEN", operatorToken],
    ["DATA_PLANE_URL", dataPlaneUrl],
  ] as const) {
    if (value === "") throw new Error(`${name} is required.`);
  }

  const ownerKeyVar = readEnvValue("SPIKE_OWNER_KEY_VAR") ?? "OWNER_TEST_KEY";
  const ownerKeyValue = readEnvValue(ownerKeyVar);
  if (ownerKeyValue === undefined || ownerKeyValue.trim() === "") {
    throw new Error(`No owner key: ${ownerKeyVar} is unset. This script never generates one.`);
  }
  const owner = authorityFromPrivateKey(ownerKeyValue.trim() as Hex);

  const executeRawEnabled = resolveExecuteRawEnabled(process.env);
  const tradeConfig = resolveTradeConfig(process.env, { chainId: network.chainId, keyStore });

  // THE SIZING INVARIANT (PHASE2.4 R6), checked BEFORE anything costs gas and
  // REFUSED rather than warned about. `--cap-day` is the on-chain meter, and the
  // relay's gas reimbursement comes out of it too — so an agent whose off-chain
  // budget consumes the whole thing can open positions it cannot close, and a
  // pause will not save it (FINDINGS (s), FINDINGS (w)).
  const onChainDailyCapWei = parseEther(capDay);
  const sizing = {
    ...(tradeConfig.feeBps === undefined ? {} : { feeBps: tradeConfig.feeBps }),
    grantedTokenCount: tokens.length,
  };
  const defaultOffChain = maxOffChainDailyCapWei({ onChainDailyCapWei, ...sizing });
  if (capDayOffChain === "" && defaultOffChain === null) {
    throw new Error(
      `--cap-day ${capDay} does not even cover the exit reserve of ` +
        `${exitReserveWei(tokens.length)} wei. Raise it, or this agent can buy and never sell.`,
    );
  }
  const requestedOffChainWei =
    capDayOffChain === "" ? (defaultOffChain as bigint) : parseEther(capDayOffChain);
  const sizedRequest = checkNativeCapSizing({
    onChainDailyCapWei,
    offChainDailyCapWei: requestedOffChainWei,
    ...sizing,
  });
  // Checked here so the GRANT path fails before it costs gas. It is checked
  // AGAIN below against the spec actually in force, because on the reuse path
  // `--cap-day` and `--tokens` describe a session this run will not grant
  // (PHASE2.4 audit A2).
  if (!sizedRequest.ok) throw new Error(sizedRequest.message);

  const venueOptions = {
    ...(tradeConfig.venues.fourMemeHelper === undefined
      ? {}
      : { fourMemeHelper: tradeConfig.venues.fourMemeHelper }),
    ...(tradeConfig.venues.flapPortal === undefined
      ? {}
      : { flapPortal: tradeConfig.venues.flapPortal }),
  };
  const provider = new AltanaProvider({ network, ...venueOptions });
  const providerRegistry = createProviderRegistry([
    { network, options: venueOptions },
  ]);

  const wallet = await provider.resolveOwnerWallet({ owner });
  const balance = await provider.getBalance({ address: wallet.address });
  console.log(`[dev-stack] network=${isMainnet ? "MAINNET" : "testnet"} chain=${network.chainId}`);
  console.log(`[dev-stack] owner wallet=${wallet.address} balance=${balance} wei`);

  /* ---- the session: reuse when the chain still honours it ---- */

  const sessionVar = `AGENT_SESSION_KEY_${agentId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  let sessionKey = readEnvValue(sessionVar);
  if (sessionKey === undefined || sessionKey.trim() === "") {
    sessionKey = generatePrivateKey();
    writeEnvValue(sessionVar, sessionKey);
    console.log(`[dev-stack] session key generated -> .env as ${sessionVar}`);
  }
  const agentAuthority = authorityFromPrivateKey(sessionKey.trim() as Hex);
  console.log(
    `[dev-stack] session signer=${privateKeyToAccount(sessionKey.trim() as Hex).address}`,
  );

  const nowSeconds = Math.floor(Date.now() / 1000);
  const prior = loadState();
  let facts: SessionFacts | null = null;

  if (
    prior !== null &&
    prior.agentId === agentId &&
    prior.chainId === network.chainId &&
    prior.walletAddress.toLowerCase() === wallet.address.toLowerCase() &&
    prior.expiresAt > nowSeconds + 60
  ) {
    const active = await provider.isSessionActive({
      wallet,
      publicKey: prior.publicKey,
      expiresAt: prior.expiresAt,
    });
    if (active) {
      // Re-validating rather than trusting the file: the spec drives the local
      // pre-flight, and a hand-edited state file must not be able to widen it.
      const spec = prior.spec as Parameters<typeof validateSessionSpec>[0];
      facts = {
        spec,
        permissions: validateSessionSpec(spec),
        publicKey: prior.publicKey,
        expiry: prior.expiresAt,
      };
      console.log(
        `[dev-stack] reusing the live session (expires ${new Date(prior.expiresAt * 1000).toISOString()}) — no gas spent`,
      );
    } else {
      console.log("[dev-stack] the recorded session is no longer active on chain; re-granting");
    }
  }

  if (facts === null) {
    if (balance === 0n) {
      throw new Error(
        `${wallet.address} holds no native balance and a grant costs gas. Fund it and re-run.`,
      );
    }

    // Never pay for the same grant twice. The session public key is derivable
    // from the session private key, so the chain can be asked whether this key
    // is ALREADY registered — independently of whether the state file survived.
    // If it is, granting again would burn a second registration fee for a key
    // the KeyStore already knows, and the exact spec it was granted under is not
    // readable back from the chain, so the honest move is to stop and say so.
    const derivedPublicKey = privateKeyToAccount(sessionKey.trim() as Hex).publicKey;
    const alreadyRegistered = await provider.isSessionActive({
      wallet,
      publicKey: derivedPublicKey,
    });
    if (alreadyRegistered) {
      throw new Error(
        `Session key ${sessionVar} is ALREADY registered on chain, but there is no ` +
          `usable state file for it — so the permissions it was granted under are ` +
          `unknown and it cannot be rebuilt. Granting again would pay a second ` +
          `registration fee. Use a different --agent-id (which derives a fresh key), ` +
          `or let this one expire.`,
      );
    }
    const spec = tradeSessionSpec({
      venues: tradeConfig.venues,
      ...(tradeConfig.feeTreasury === undefined ? {} : { treasury: tradeConfig.feeTreasury }),
      // Each token gets an `approve` rule AND a cap, so a position opened here
      // can be closed here. Omit `--tokens` and every buy is refused by the
      // route (PHASE2.3 R1) rather than silently un-sellable (FINDINGS (h)).
      tokens: tokens.map((token) => ({ token })),
      nativeCaps: [{ limit: onChainDailyCapWei, period: "day" }],
      expiresAt: nowSeconds + 86_400,
      nowSeconds,
    });
    console.log(
      `[dev-stack] tradeable tokens: ${
        tokens.length === 0
          ? "(none) — every BUY will be refused; pass --tokens 0x...,0x..."
          : tokens.join(", ")
      }`,
    );
    console.log("[dev-stack] granting a session — the OWNER signs and this costs gas...");
    const granted = await provider.grantSession({ wallet, owner, spec, agent: agentAuthority });
    facts = {
      spec,
      permissions: validateSessionSpec(spec),
      publicKey: granted.publicKey,
      expiry: spec.expiresAt,
    };
    const state: ProvisionState = {
      agentId,
      ownerAddress: wallet.ownerAddress,
      walletAddress: wallet.address,
      publicKey: granted.publicKey,
      expiresAt: spec.expiresAt,
      chainId: network.chainId,
      spec,
    };
    saveState(state);
    console.log(`[dev-stack] granted publicKey=${granted.publicKey}`);
  }

  /* ---- the sizing invariant, AGAINST THE SPEC ACTUALLY IN FORCE ---- */

  // PHASE2.4 audit A2. The check above ran on `--cap-day` and `--tokens`, which
  // on the reuse path describe a session this run never granted: reusing a
  // session granted at 0.001 BNB while passing `--cap-day 5` would have armed an
  // agent whose off-chain budget was thousands of times its on-chain meter, and
  // the off-chain cap is the only half 4lpha enforces. So the numbers that reach
  // the store come from `facts.spec` — the caps the CHAIN is holding — on both
  // paths, and on the grant path they are the same numbers by construction.
  const grantedNativeDayCap = facts.spec.spendCaps.find(
    (cap) => cap.token === undefined && cap.period === "day",
  );
  if (grantedNativeDayCap === undefined) {
    throw new Error(
      `The session in force has no DAILY native cap, so there is no on-chain ` +
        `budget to size against. Let it expire and provision a fresh one.`,
    );
  }
  const grantedTokenCount = facts.spec.spendCaps.filter(
    (cap) => cap.token !== undefined,
  ).length;
  const effectiveSizing = {
    ...(tradeConfig.feeBps === undefined ? {} : { feeBps: tradeConfig.feeBps }),
    grantedTokenCount,
  };
  const effectiveDefault = maxOffChainDailyCapWei({
    onChainDailyCapWei: grantedNativeDayCap.limit,
    ...effectiveSizing,
  });
  if (capDayOffChain === "" && effectiveDefault === null) {
    throw new Error(
      `The session in force caps native at ${grantedNativeDayCap.limit} wei/day, which ` +
        `does not even cover the exit reserve of ${exitReserveWei(grantedTokenCount)} wei ` +
        `for its ${grantedTokenCount} granted token(s). This agent could buy and never sell.`,
    );
  }
  const offChainDailyCapWei =
    capDayOffChain === "" ? (effectiveDefault as bigint) : parseEther(capDayOffChain);
  const sizedEffective = checkNativeCapSizing({
    onChainDailyCapWei: grantedNativeDayCap.limit,
    offChainDailyCapWei,
    ...effectiveSizing,
  });
  if (!sizedEffective.ok) throw new Error(sizedEffective.message);
  console.log(
    `[dev-stack] budget: on-chain ${grantedNativeDayCap.limit} wei/day (as GRANTED), ` +
      `off-chain ${offChainDailyCapWei} wei/day, exit reserve ` +
      `${exitReserveWei(grantedTokenCount)} wei for ${grantedTokenCount} token(s)`,
  );
  // The caveat rides the PASS path too (PHASE2.4 audit A1-P). An operator who
  // sees a refusal reads why; the one at risk of mistaking this for a guarantee
  // is the one who sees it pass.
  console.log(
    `[dev-stack] that reserve is sized per GRANTED TOKEN, and the relay bills per ` +
      `SUBMISSION — a busy day can still exhaust the on-chain cap before the off-chain one.`,
  );

  /* ---- the stores, shared by both halves ---- */

  const masterKey = loadMasterKey();
  const agentStore = new MemoryAgentStore(masterKey);
  const journal = new MemoryExecutionJournal();
  const nonceStore = new MemoryNonceStore();
  const runtimeReplayStore = new MemoryRuntimeReplayStore();
  const killswitch = new MemoryKillSwitch();

  const record = await agentStore.createAgent({
    httpRuntimeProfile: "trade-v1",
    id: agentId,
    ownerAddress: wallet.ownerAddress,
    walletAddress: wallet.address,
    custodyModel: wallet.custodyModel,
    sessionFacts: facts,
    // The off-chain half of the sizing invariant, so `exceedsDailyCap` enforces
    // the number this run was sized against rather than nothing at all.
    caps: { dailyNativeWei: offChainDailyCapWei },
    status: "armed",
  });
  await agentStore.putAgentSessionKey(record.ownerAddress, record.id, sessionKey.trim() as Hex);
  console.log(`[dev-stack] agent "${record.id}" armed in the in-memory store`);

  const config: ServerConfig = {
    chainId: network.chainId,
    network: isMainnet ? "mainnet" : "testnet",
    keyStore,
    execToken,
    operatorToken,
    executeRawEnabled,
    trade: tradeConfig,
    runtimeAuth: resolveRuntimeAuthConfig(process.env, {
      chainId: network.chainId,
      ...(process.env["EXECUTION_ENV_SALT"]?.trim()
        ? { envSalt: process.env["EXECUTION_ENV_SALT"]!.trim() }
        : {}),
    }),
    ...(process.env["EXECUTION_ENV_SALT"]?.trim()
      ? { envSalt: process.env["EXECUTION_ENV_SALT"]!.trim() }
      : {}),
  };

  // LP wiring (PHASE3): same tri-state as production — `LP_ENABLED` defaults
  // OFF and the LP routes 404; enabled, the deps are built over the MEMORY
  // stores this process already lives on, dying with it exactly like the rest.
  const lpEnabled = resolveLpEnabled(process.env);
  const lpBuilt: BuiltLpServerDeps | undefined = lpEnabled
    ? await buildLpServerDeps({
        env: process.env,
        network: {
          chain: network.chain,
          chainId: network.chainId,
          publicRpcUrl: network.publicRpcUrl,
        },
        rpcUrls: resolveLpRpcUrls(process.env, {
          chain: network.chain,
          chainId: network.chainId,
          publicRpcUrl: network.publicRpcUrl,
        }),
        keyStore,
        venues: tradeConfig.venues,
        stores: {
          store: new MemoryLpSequenceStore(),
          settingsStore: new MemoryLpSettingsStore(),
          // ONE observation store, SHARED with the in-process worker below
          // (PHASE3.2 Rev2 item 38). A second instance would make
          // `GET /agents/:id/lp` report a state the worker in the same process
          // does not hold — the read side lying, in the phase that exists
          // because nothing reported the truth.
          observations: new MemoryLpObservationStore(),
          feeEvents: new MemoryLpFeeEventStore(),
        },
      })
    : undefined;
  console.log(
    lpBuilt === undefined
      ? "[dev-stack] lp=off (LP_ENABLED not set)"
      : `[dev-stack] lp=on rails=${lpBuilt.railsResult.ok ? "configured" : "MISSING — LP money routes will refuse"}`,
  );

  // MARKETPLACE-LENDING-AGENT §8.5 — the OFFLINE REHEARSAL wiring.
  //
  // `rehearsal: true` is the named carve-out that lets this stack run over
  // MEMORY stores with no `DATABASE_URL`. It is passed HERE and nowhere else;
  // the production composition site never passes it, so a durable deployment
  // that merely forgot the database still refuses to boot.
  const lendingWanted = process.argv.includes("--lending-worker");
  const lendingBuilt = lpBuilt === undefined
    ? (resolveLendingEnabled(process.env), undefined)
    : await buildLendingServerDeps({
        env: process.env,
        network: {
          chain: network.chain,
          chainId: network.chainId,
          publicRpcUrl: network.publicRpcUrl,
        },
        rehearsal: true,
        lpVenue: {
          routerV3: lpBuilt.addresses.routerV3,
          wbnb: lpBuilt.addresses.wbnb,
          quoterV2: lpBuilt.addresses.quoterV2,
          factoryV3: lpBuilt.addresses.factory,
          maxSagaSlippageBps: lpBuilt.railsResult.ok
            ? lpBuilt.railsResult.config.maxSagaSlippageBps
            : 0,
        },
      });
  if (lendingWanted && lendingBuilt === undefined) {
    throw new Error("--lending-worker requires LENDING_ENABLED=true (which requires LP_ENABLED and HIRE_ENABLED).");
  }
  console.log(
    lendingBuilt === undefined
      ? "[dev-stack] lending=off (LENDING_ENABLED not set)"
      : `[dev-stack] lending=on (REHEARSAL: memory stores, dying with this process) `
        + `vusdt=${lendingBuilt.venue.vUsdt} usdt=${lendingBuilt.venue.usdt} `
        + `pool=${lendingBuilt.venue.swapPool} fee=${lendingBuilt.venue.swapFeeTier}`,
  );
  if (lendingBuilt !== undefined) {
    console.log(
      "[dev-stack] NOTE: the lending hire route needs Postgres and this stack has none, so "
      + "no guard row can be created here through S1. The rehearsal exercises the worker's "
      + "decision layer, the read side and the dry-run gate — never the restart property.",
    );
  }

  const dataPlane = new HttpDataPlaneClient({
    baseUrl: dataPlaneUrl,
    ...(process.env["DATA_PLANE_TOKEN"]?.trim()
      ? { token: process.env["DATA_PLANE_TOKEN"].trim() }
      : {}),
  });

  // DEMO MODE, on the same in-memory stores as everything else here.
  //
  // `src/demo/wiring.ts` calls itself the one composition site for "the server,
  // the worker script and the dev stack", and until now it was wired into the
  // first two only — so a local `dev-stack` answered `/demo/*` with the
  // server's own 404 even with the flag set, which reads as a broken feature
  // rather than an unwired one. The dev stack has no `DATABASE_URL`, so the
  // demo store is the memory one: demos die with this process, like every other
  // row in it.
  const demoWiring = await buildDemoWiring({
    env: process.env,
    dataPlaneUrl,
    ...(process.env["DATA_PLANE_TOKEN"]?.trim()
      ? { dataPlaneToken: process.env["DATA_PLANE_TOKEN"].trim() }
      : {}),
  });
  console.log(
    demoWiring === null
      ? "[dev-stack] demo=off (DEMO_ENABLED not \"true\")"
      : `[dev-stack] demo=on every ${demoWiring.config.workerIntervalMs / 1_000}s, `
        + `cap ${demoWiring.config.maxAgentsPerOwner}/owner (in-memory)`,
  );

  const app = createServer({
    agentStore,
    journal,
    nonceStore,
    runtimeReplayStore,
    killswitch,
    providerRegistry,
    dataPlane,
    ...(lpBuilt === undefined ? {} : { lp: lpBuilt.lp }),
    ...(demoWiring === null ? {} : { demo: demoWiring.server }),
    ...(lendingBuilt === undefined ? {} : { lending: {
      guards: lendingBuilt.guards,
      settingsStore: lendingBuilt.settingsStore,
      observations: lendingBuilt.observations,
      readers: lendingBuilt.readers,
      venue: lendingBuilt.venue,
      intervalMs: lendingBuilt.intervalMs,
      maxObservationAgeMs: lendingBuilt.maxObservationAgeMs,
      maxSagaSlippageBps: lendingBuilt.maxSagaSlippageBps,
      previewSecret: lendingBuilt.previewSecret,
    } }),
    config,
  });

  // The demo worker runs INLINE here for the same reason it does in the API
  // process: it is one timer over shared reads, and a local stack that served
  // demo agents without ever advancing them would be worse than not serving
  // them at all.
  const demoWorker =
    demoWiring === null
      ? undefined
      : startDemoWorker({
          ...demoWiring.worker,
          onError: (agentId, error) => {
            console.warn(
              `[dev-stack] demo ${agentId}: ${error instanceof Error ? error.message : "error"}`,
            );
          },
        });
  void demoWorker;

  const port = Number.parseInt(process.env["PORT"] ?? "8090", 10);
  serve({ fetch: app.fetch, port });
  console.log(
    `\n[dev-stack] serving on http://127.0.0.1:${port} — state is IN MEMORY and dies with this process.`,
  );
  console.log(
    `[dev-stack] now run, in another terminal:\n` +
      `  npm run live-trade -- --agent-id ${agentId} --venue pancake --token 0x... --amount 0.002`,
  );

  // Optional in-process LP worker (`--lp-worker`): the SAME stores the routes
  // write, so a position opened over HTTP is managed in the same process.
  // Boot posture matches the standalone daemon: missing rails refuse to start.
  if (process.argv.includes("--lp-worker")) {
    if (lpBuilt === undefined) {
      throw new Error("--lp-worker requires LP_ENABLED=true.");
    }
    const workerBoot = resolveLpWorkerBootConfig(process.env);
    const workerDryRun = process.argv.includes("--lp-worker-dry-run");
    const llmKey = (process.env["TRADE_LLM_API_KEY"]?.trim() || process.env["OPENROUTER_API_KEY"]?.trim() || "");
    const llmBaseUrl = process.env["TRADE_LLM_BASE_URL"]?.trim() ?? "";
    const llmModel = process.env["TRADE_LLM_MODEL"]?.trim() ?? "";
    const workerDeps: LpWorkerDeps = {
      ...(lpBuilt.feeEvents === undefined ? {} : { feeEvents: lpBuilt.feeEvents }),
      agentStore,
      journal,
      killswitch,
      store: lpBuilt.lp.store,
      settingsStore: lpBuilt.lp.settingsStore,
      observations: lpBuilt.lp.observations,
      provider,
      readers: lpBuilt.readers,
      rails: workerBoot.rails,
      atomicRotate: workerBoot.atomicRotate,
      maxTickWidth: workerBoot.runtime.maxTickWidth,
      conversionCompatibleTokens: workerBoot.runtime.conversionCompatibleTokens,
      // PHASE3.15: the same flag and the SAME ledger instance the in-process
      // server was built with, for the reason the observation store is shared
      // here — a second instance would make `GET /agents/:id/lp` report a cycle
      // history the worker in this very process does not hold.
      gridEnabled: workerBoot.gridEnabled,
      ...(lpBuilt.gridCycles === undefined
        ? {}
        : { gridCycles: lpBuilt.gridCycles }),
      // PHASE3.1 Rev2 item 17 — the same constant the routes size the reserve
      // on, so the in-process worker and the in-process server agree.
      relayFeePerSubmitWei: resolveLpRelayFeePerSubmitWei(process.env),
      venue: lpBuilt.lp.venue,
      ...(llmKey === ""
        ? {}
        : {
            brainTransport: createLpBrainTransport({
              readKey: () => llmKey,
              ...(llmBaseUrl === "" ? {} : { baseUrl: llmBaseUrl }),
              ...(llmModel === "" ? {} : { modelOverride: llmModel }),
            }),
          }),
      reconcile: () =>
        reconcile({
          provider,
          journal,
          resolveWallet: async (ownerAddress, id) => {
            const row = await agentStore.getAgentById(id);
            if (row === null) return null;
            if (row.ownerAddress !== ownerAddress.toLowerCase()) return null;
            return {
              address: row.walletAddress,
              chainId: network.chainId,
              ownerAddress: row.ownerAddress,
              custodyModel: row.custodyModel,
            };
          },
        }),
      now: Date.now,
      intervalMs: workerBoot.intervalMs,
      ...(workerBoot.maxObservationAgeMs === undefined
        ? {}
        : { maxObservationAgeMs: workerBoot.maxObservationAgeMs }),
      dryRun: workerDryRun,
      log: (outcome) =>
        console.log(
          `[dev-stack lp-worker] agent=${outcome.agentId} position=${outcome.positionId} ` +
            `action=${outcome.action} reason=${outcome.reason}`,
        ),
    };
    const workerState = createLpWorkerState();
    console.log(
      `[dev-stack] lp-worker running in-process every ${workerBoot.intervalMs}ms` +
        `${workerDryRun ? " (dry-run)" : ""}`,
    );
    console.log(
      `[dev-stack] NOTE: the observation store here is IN MEMORY and dies with this ` +
        `process, so this stack can demonstrate the read side, the staleness discard ` +
        `and the dry-run overlay — but it can NEVER prove the restart property ` +
        `FINDINGS (ae) is about. A green dev-stack is not the acceptance for (ae).`,
    );
    // ANCHORED on the tick's START and re-checked (PHASE3.2 Rev2 item 4). This
    // loop used to re-arm for a full `intervalMs` AFTER the cycle resolved,
    // drifting by one cycle-duration per cycle — the defect the PHASE3.2 body
    // wrongly attributed to `scripts/lp-worker.ts`, which had already been
    // fixed. Same shape as the standalone daemon's now.
    const tick = async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        await runLpWorkerOnce(workerDeps, workerState);
      } catch (error) {
        console.error(
          `[dev-stack lp-worker] cycle failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      await sleepUntilNextCycle({
        cycleStartedAtMs: startedAt,
        intervalMs: workerBoot.intervalMs,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      void tick();
    };
    setTimeout(() => void tick(), workerBoot.intervalMs);
  }

  // Optional in-process LENDING worker (`--lending-worker`), over the SAME
  // memory stores the routes above were given — so a guard read over HTTP is
  // the guard this worker is deciding about. `--lending-worker-dry-run` runs
  // the decision layer with the dry-run gate on, writing nothing at all.
  if (lendingWanted && lendingBuilt !== undefined) {
    const lendingDryRun = process.argv.includes("--lending-worker-dry-run");
    const lendingDeps: LendingWorkerDeps = {
      agentStore,
      journal,
      killswitch,
      provider,
      guards: lendingBuilt.guards,
      settingsStore: lendingBuilt.settingsStore,
      observations: lendingBuilt.observations,
      readers: lendingBuilt.readers,
      venue: lendingBuilt.venue,
      intervalMs: lendingBuilt.intervalMs,
      maxObservationAgeMs: lendingBuilt.maxObservationAgeMs,
      agentConcurrency: lendingBuilt.agentConcurrency,
      maxSagaSlippageBps: lendingBuilt.maxSagaSlippageBps,
      now: Date.now,
      dryRun: lendingDryRun,
      log: (outcome) =>
        console.log(
          `[dev-stack lending-worker] agent=${outcome.agentId} action=${outcome.action} `
          + `${outcome.condition === undefined ? "" : `condition=${outcome.condition} `}`
          + `reason=${outcome.reason}`,
        ),
    };
    console.log(
      `[dev-stack] lending-worker running in-process every ${lendingBuilt.intervalMs}ms`
      + `${lendingDryRun ? " (dry-run)" : ""}`,
    );
    const lendingTick = async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        await runLendingWorkerOnce(lendingDeps);
      } catch (error) {
        console.error(
          `[dev-stack lending-worker] cycle failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          nextLendingCycleDelayMs(startedAt, Date.now(), lendingBuilt.intervalMs),
        ),
      );
      void lendingTick();
    };
    setTimeout(() => void lendingTick(), lendingBuilt.intervalMs);
  }
}

main().catch((error: unknown) => {
  console.error(`\ndev-stack failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
