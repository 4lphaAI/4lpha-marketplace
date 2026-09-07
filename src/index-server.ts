/**
 * Process entry point for the execution plane's HTTP service.
 *
 * Everything impure lives here and nowhere else: reading the environment,
 * constructing the durable stores, running the startup reconcile pass, binding a
 * port, and shutting down cleanly. `createServer` itself stays pure so the whole
 * API surface is testable offline — this file is the thin, untested-by-design
 * shell around it, mirroring the data plane's entry.
 *
 * Startup order matters and is deliberate:
 *   1. read and VALIDATE configuration — a missing credential aborts the boot
 *      rather than starting a service that signs transactions with auth off;
 *   2. build the stores;
 *   3. RECONCILE before serving. A crash leaves journal rows whose outcome is
 *      unknown; resolving them against chain state before accepting new work is
 *      what keeps a restart from stacking a second submit on top of an ambiguous
 *      first one. Rows that stay ambiguous are HELD and logged for an operator;
 *   4. only then listen.
 *
 * NO SECRET IS EVER LOGGED HERE. The boot banner reports which backends were
 * selected and which credentials are PRESENT — never a value, never a URL.
 */
import { buildDemoWiring } from "./demo/wiring.js";
import { startDemoWorker } from "./demo/worker.js";
import { serve } from "@hono/node-server";
import { getAddress, type Address } from "viem";
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { createServer, type ServerConfig } from "./server.js";
import { createAgentStore } from "./store/agents.js";
import {
  createJournal,
  reconcile,
  RECONCILE_MIN_ROW_AGE_MS,
  assertReconcileGuardCoversSubmitWindow,
  type ReconcileInput,
} from "./store/journal.js";
import { createNonceStore } from "./store/nonces.js";
import { createRuntimeReplayStore } from "./store/runtimeReplays.js";
import {
  assertRuntimeVerifierOnlyEnvironment,
  resolveRuntimeAuthConfig,
} from "./auth/runtimeAuth.js";
import { createKillSwitch } from "./killswitch/killswitch.js";
import { createProviderRegistry } from "./wallet/registry.js";
import { HttpDataPlaneClient } from "./clients/dataPlane.js";
import { sanitizeMessage } from "./core/errors.js";
import {
  resolveExecuteRawEnabled,
  resolveGridEnabled,
  resolveHireEnabled,
  resolveHireGrantGasHeadroomWei,
  resolveLpEnabled,
  resolvePasskeyConfig,
  resolveTradeConfig,
} from "./ops/config.js";
import { buildLpServerDeps, type BuiltLpServerDeps } from "./lp/wiring.js";
import {
  buildVenusServerDeps,
  closeVenusServerDeps,
  type BuiltVenusServerDeps,
} from "./venus/wiring.js";
import {
  buildLendingServerDeps,
  closeLendingServerDeps,
  type BuiltLendingServerDeps,
} from "./lending/wiring.js";
import { resolveLendingEnabled } from "./ops/config.js";
import { resolveLpRpcUrls } from "./lp/readers.js";
import { createKeyStoreReader } from "./account/keyStoreReader.js";
import { createBalanceReader } from "./account/balanceReader.js";
import { createPreBindRetirementFinalizer } from "./lp/preBindRetirementFinalizer.js";
import { resolveBillingConfig } from "./billing/config.js";
import { resolveDomainSalt } from "./auth/ownerAuth.js";
import { parseAccountReadSessionSecret } from "./auth/accountReadSession.js";
import { loadBillingProductionRuntime } from "./billing/runtime.js";
import { listenBillingInternalGateway } from "./billing/listener.js";
import { createGrantEvidenceReader } from "./wallet/grantEvidence.js";
import { createProvisioningWorker } from "./wallet/provisioningWorker.js";
import { createTradeSettingsStore } from "./store/tradeSettings.js";
import { createTradePositionStore } from "./store/tradePositions.js";
import { createTradeIntentStore } from "./store/tradeIntents.js";
import { HttpTradeDataPlaneReads } from "./trade/dataPlaneReads.js";
import { createHttpTradeReadinessDataPlane, createTradeReadiness } from "./trade/readiness.js";
import { createTradeDetailObserver } from "./trade/detail.js";
import { createRouteQuoteReader } from "./trade/route.js";

const DEFAULT_PORT = 8090;

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (value === "") {
    throw new Error(`${name} is required; refusing to start without it.`);
  }
  return value;
}

function resolvePort(raw: string): number {
  if (raw === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("PORT is not a valid port number.");
  }
  return parsed;
}

/** `mainnet` means chain 56 and real funds. Anything else is testnet. */
function resolveNetwork(): { config: NetworkConfig; label: string } {
  const label = readEnv("EXECUTION_NETWORK") === "mainnet" ? "mainnet" : "testnet";
  return {
    config: label === "mainnet" ? BNB : BNB_TESTNET,
    label,
  };
}

const { config: network, label: networkLabel } = resolveNetwork();

// Credentials are mandatory. A service that can move funds must not be able to
// start with its auth layers switched off by an unset variable.
const execToken = requireEnv("EXECUTION_API_TOKEN");
const operatorToken = requireEnv("EXECUTION_OPERATOR_TOKEN");
const dataPlaneUrl = requireEnv("DATA_PLANE_URL");

const envSalt = readEnv("EXECUTION_ENV_SALT");
assertRuntimeVerifierOnlyEnvironment(process.env);
const runtimeAuthConfig = resolveRuntimeAuthConfig(process.env, {
  chainId: network.chainId,
  ...(envSalt === "" ? {} : { envSalt }),
});
const keyStore: Address = getAddress(network.keyStore);

// Every trade knob is validated HERE, before anything is served. A bad fee
// rate, a venue address with a flipped nibble, a slippage ceiling that disables
// the slippage rule — each of those aborts the boot rather than surfacing at
// the first submit. `resolveTradeConfig` throws with a named variable.
const executeRawEnabled = resolveExecuteRawEnabled(process.env);
const tradeConfig = resolveTradeConfig(process.env, {
  chainId: network.chainId,
  keyStore,
});
// Same discipline, for the auth layer instead of the money layer: a passkey
// deployment whose RP ID does not match its origins, or whose origin has a
// trailing slash, can never authenticate anybody — and would answer every
// passkey owner with the same generic failure a forgery gets. So it fails the
// BOOT, with the variable named. `PASSKEY_ENABLED` defaults to false.
const passkeyConfig = resolvePasskeyConfig(process.env);
const hireEnabled = resolveHireEnabled(process.env);
const tradeAgentEnabledRaw = readEnv("TRADE_AGENT_ENABLED");
if (tradeAgentEnabledRaw !== "" && tradeAgentEnabledRaw !== "true" && tradeAgentEnabledRaw !== "false") {
  throw new Error('TRADE_AGENT_ENABLED must be exactly "true" or "false".');
}
const tradeAgentEnabled = tradeAgentEnabledRaw === "true";
if (tradeAgentEnabled && (network.chainId !== 56 || !hireEnabled
  || readEnv("DATABASE_URL") === "" || readEnv("EXECUTION_MASTER_KEY") === "")) {
  throw new Error("TRADE_AGENT_ENABLED requires chain 56, DATABASE_URL, EXECUTION_MASTER_KEY, and HIRE_ENABLED.");
}
const billingConfig = resolveBillingConfig(process.env);
const enabledBillingConfig = billingConfig.mode === "on" ? billingConfig : undefined;
const accountReadSessionKey = parseAccountReadSessionSecret(process.env["OWNER_READ_SESSION_SECRET"]);

const serverConfig: ServerConfig = {
  chainId: network.chainId,
  network: networkLabel,
  keyStore,
  execToken,
  operatorToken,
  executeRawEnabled,
  trade: tradeConfig,
  passkey: passkeyConfig,
  runtimeAuth: runtimeAuthConfig,
  hireEnabled,
  tradeAgentEnabled,
  ...(accountReadSessionKey === null ? {} : { accountReadSession: {
    key: accountReadSessionKey,
    chainId: network.chainId,
    environment: resolveDomainSalt({
      chainId: network.chainId,
      network: networkLabel,
      ...(envSalt === "" ? {} : { envSalt }),
    }),
  } }),
  ...(tradeConfig.venues.wbnb === undefined ? {} : { accountPortfolioWbnb: tradeConfig.venues.wbnb }),
  ...(envSalt === "" ? {} : { envSalt }),
};

const agentStore = await createAgentStore({ chainId: network.chainId, keyStoreAddress: keyStore });
const journal = await createJournal();
const nonceStore = await createNonceStore();
const runtimeReplayStore = await createRuntimeReplayStore();
const killswitch = await createKillSwitch();
// The Four.Meme helper is PINNED onto the provider here and nowhere else: one
// boot-validated address, resolved from the same venue config the route's
// availability gate reads, so the two can never disagree about whether the
// venue exists on this chain. Nothing downstream can supply or override it.
const providerRegistry = createProviderRegistry([
  {
    network,
    options: {
      ...(tradeConfig.venues.fourMemeHelper === undefined
        ? {}
        : { fourMemeHelper: tradeConfig.venues.fourMemeHelper }),
      // Same pinning, same reason, and more of it: the flap Portal is the read
      // target, the swap target AND the approval spender on every flap sell.
      ...(tradeConfig.venues.flapPortal === undefined
        ? {}
        : { flapPortal: tradeConfig.venues.flapPortal }),
    },
  },
]);
const dataPlane = new HttpDataPlaneClient({
  baseUrl: dataPlaneUrl,
  ...(readEnv("DATA_PLANE_TOKEN") === ""
    ? {}
    : { token: readEnv("DATA_PLANE_TOKEN") }),
});
const tradeDataPlaneOptions = {
  baseUrl: dataPlaneUrl,
  ...(readEnv("DATA_PLANE_TOKEN") === "" ? {} : { token: readEnv("DATA_PLANE_TOKEN") }),
};
const tradeSettingsStore = tradeAgentEnabled ? await createTradeSettingsStore(agentStore) : undefined;
const tradePositions = tradeAgentEnabled ? await createTradePositionStore() : undefined;
const tradeIntents = tradeAgentEnabled ? await createTradeIntentStore() : undefined;
const tradeDataPlane = tradeAgentEnabled ? new HttpTradeDataPlaneReads(tradeDataPlaneOptions) : undefined;
const tradeReadiness = tradeAgentEnabled ? await createTradeReadiness({
  dataPlane: createHttpTradeReadinessDataPlane(tradeDataPlaneOptions),
  intervalMs: 60_000,
  log: (message) => console.warn(message),
}) : undefined;

// The LP surface (PHASE3): `LP_ENABLED` defaults OFF ⇒ `lp` stays undefined ⇒
// the routes answer 404 byte-identically to an unknown path. Enabled, every
// LP boot value resolves HERE and a malformed one fails the process (the
// passkey posture); only the manipulation rails ride through as a typed
// result, because their contract is per-request hold, never default-open.
const lpReaderNetwork = {
  chain: network.chain,
  chainId: network.chainId,
  publicRpcUrl: network.publicRpcUrl,
};
const tradeRpcUrls = tradeAgentEnabled ? resolveLpRpcUrls(process.env, lpReaderNetwork) : undefined;
const tradeRouteReader = tradeRpcUrls === undefined ? undefined : createRouteQuoteReader({ rpcUrls: tradeRpcUrls });
const tradeObserver = tradeRpcUrls === undefined ? undefined : createTradeDetailObserver({
  provider: providerRegistry.get(network.chainId),
  rpcUrls: tradeRpcUrls,
  ...(tradeRouteReader === undefined ? {} : { routeReader: tradeRouteReader }),
});
// PHASE3.15 (L3). Grid deps are built INSIDE the LP branch below, so a boot
// with `GRID_ENABLED="true"` and LP off would otherwise produce a
// healthy-looking server that skips every grid agent — the PHASE4-AUDIT A1
// shape. `resolveGridEnabled` throws on that pair; calling it here is what
// makes the throw reachable when LP is off, and the boot ternary below carries
// the flag itself (which `buildLpServerDeps` resolves again, once, at the one
// site that composes `LpServerDeps`).
resolveGridEnabled(process.env);
const lpBuilt: BuiltLpServerDeps | undefined = resolveLpEnabled(process.env)
  ? await buildLpServerDeps({
      env: process.env,
      network: lpReaderNetwork,
      rpcUrls: resolveLpRpcUrls(process.env, lpReaderNetwork),
      keyStore,
      venues: tradeConfig.venues,
    })
  : undefined;
// PHASE4-AUDIT A1. Without this, `VENUS_ENABLED=true` enabled NOTHING:
// `createServer` registers the Venus routes only when `deps.venus` is present,
// so both owner-signed routes 404'd, no settings row could ever be written, and
// the worker's queue was permanently empty — while the server looked healthy.
// The reader network is the LP one: same chain, same public RPC posture.
// The Altana KeyStore read that PROVES a caller-declared wallet on the Account
// read is controlled by the authenticated owner. Same network and same RPC
// posture as the LP readers — `resolveLpRpcUrls`, no env var of its own — and
// wired UNCONDITIONALLY, because it only ever answers a question the account
// route already asks and it holds no key and submits nothing.
const keyStoreReader = createKeyStoreReader({
  network: lpReaderNetwork,
  rpcUrls: resolveLpRpcUrls(process.env, lpReaderNetwork),
  keyStore,
});
// The BATCHED balance reader for the Account read. Same network, same
// `resolveLpRpcUrls` posture, no env var of its own — and deliberately a
// SEPARATE client from the provider's, whose unbatched one-endpoint read
// timing the LP sagas' receipt and finality reads depend on. Wired
// unconditionally: it holds no key, submits nothing, and only makes the
// question the account route already asks cost one HTTP round trip instead of
// twenty.
const balanceReader = createBalanceReader({
  network: lpReaderNetwork,
  rpcUrls: resolveLpRpcUrls(process.env, lpReaderNetwork),
});
if (hireEnabled && (
  network.chainId !== 56
  || readEnv("DATABASE_URL") === ""
  || !agentStore.durable
  || !agentStore.keyEncryptionConfigured
  || !passkeyConfig.enabled
  || lpBuilt === undefined
  || tradeConfig.feeTreasury === undefined
)) {
  throw new Error("HIRE_ENABLED requires BNB mainnet, DATABASE_URL, EXECUTION_MASTER_KEY, encrypted durable Postgres, passkeys, LP wiring, and FEE_TREASURY_ADDRESS.");
}
const hireRelayFeePerSubmitWei = lpBuilt?.lp.relayFeePerSubmitWei;
const hireGrantGasHeadroomWei = hireEnabled && hireRelayFeePerSubmitWei !== undefined
  ? resolveHireGrantGasHeadroomWei(process.env, hireRelayFeePerSubmitWei)
  : undefined;
const hireEvidence = hireEnabled ? createGrantEvidenceReader({
  network: {
    chain: network.chain,
    chainId: network.chainId,
    publicRpcUrl: network.publicRpcUrl,
    keyStoreController: getAddress(network.keyStoreController),
  },
  rpcUrls: resolveLpRpcUrls(process.env, lpReaderNetwork),
  keyStoreReader,
}) : undefined;
const venusBuilt: BuiltVenusServerDeps | undefined = await buildVenusServerDeps({
  env: process.env,
  network: lpReaderNetwork,
});

// MARKETPLACE-LENDING-AGENT §8.5. The SAME PHASE4-AUDIT A1 lesson the Venus
// wiring above records: `createServer` registers the lending routes only when
// `deps.lending` is present, so a boot that resolved the flag and forgot to
// pass the deps would make `LENDING_ENABLED=true` enable NOTHING while the
// server looked healthy. `resolveLendingEnabled` is also the one place
// `LP_ENABLED` and `HIRE_ENABLED` are required, so calling it here makes those
// throws reachable — the router, WBNB and the QuoterV2 all come from the LP
// venue, and the guard's only entry is the lending-v1 hire.
const lendingBuilt: BuiltLendingServerDeps | undefined =
  lpBuilt === undefined
    ? (resolveLendingEnabled(process.env), undefined)
    : await buildLendingServerDeps({
        env: process.env,
        network: lpReaderNetwork,
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
if (lendingBuilt !== undefined && !lpBuilt!.railsResult.ok) {
  throw new Error(
    "LENDING_ENABLED is true but the LP manipulation rails are unset, so "
      + "`maxSagaSlippageBps` — the ONE floor every lending swap leg is derived "
      + "from — has no value. A guard whose swaps have no slippage floor must "
      + "not boot.",
  );
}

// The retirement finalizer owns a separate pool so that its journal, position,
// reservation and sequence mutations share ONE pinned transaction.  No
// DATABASE_URL means the dev-memory participant is selected only when both
// stores explicitly expose snapshot/restore support.
const preBindRetirementFinalizer = lpBuilt === undefined ? undefined
  : await createPreBindRetirementFinalizer({
      journal,
      store: lpBuilt.lp.store,
      databaseUrl: readEnv("DATABASE_URL"),
    });

// Provider-specific custody/RPC composition is a local reviewed deployment
// module. OFF/report never import it or resolve any paid hostname/credential.
const billingBuilt = enabledBillingConfig === undefined
  ? undefined
  : await loadBillingProductionRuntime(enabledBillingConfig, process.env);

console.log(
  `[execution-plane] network=${networkLabel} chain=${network.chainId} ` +
    `auth=on operator-auth=on runtime-auth=${runtimeAuthConfig.kind} ` +
    `env-salt=${envSalt === "" ? "derived" : "explicit"}`,
);

// Which capabilities are live, never a value. `execute-raw=on` is the line an
// operator should be able to grep for: it is the one setting that widens what a
// leaked service credential can do.
console.log(
  `[execution-plane] execute-raw=${executeRawEnabled ? "ON (raw calldata accepted)" : "off"} ` +
    `venues=${
      [
        tradeConfig.venues.pancakeRouterV2 === undefined ? null : "pancake",
        tradeConfig.venues.pancakeRouterV3 === undefined ? null : "pancake_v3",
        tradeConfig.venues.fourMemeHelper === undefined ? null : "fourmeme",
        tradeConfig.venues.flapPortal === undefined ? null : "flap",
      ]
        .filter((name): name is string => name !== null)
        .join("+") || "none"
    } ` +
    `fee=${tradeConfig.feeBps === undefined ? "off" : `${tradeConfig.feeBps}bps`} ` +
    `slippage-max=${tradeConfig.maxSlippageBps}bps scan-ttl=${tradeConfig.scanTtlSec}s`,
);

// Which owner-signature backends are live. The allowlist IN FORCE is logged in
// full rather than counted, because "which origins" is the entire defense for a
// passkey owner (see the consent boundary on the WebAuthn verifier) and an
// operator should be able to read it rather than infer it.
// Which LP posture is live. The rails line matters most: an operator who
// enabled LP but left the rails unset gets a server whose LP money routes all
// refuse with the rails' own reason — visible here rather than discovered
// per request.
console.log(
  lpBuilt === undefined
    ? "[execution-plane] lp=off"
    : `[execution-plane] lp=on nfpm=${lpBuilt.addresses.nfpm} ` +
        `router-v3=${lpBuilt.addresses.routerV3} ` +
        `rails=${lpBuilt.railsResult.ok ? "configured" : `MISSING (${lpBuilt.railsResult.failure.keys.join(", ")}) — LP money routes will refuse`} ` +
        `landing-evidence=${lpBuilt.evidence === undefined ? "off" : "on (curated finalized full-block quorum)"}`,
);

// Which capability is live, never a value. A deployment that believes Venus is
// on has one line to check (PHASE4-AUDIT A1: the previous silence was the whole
// defect — "enabled" and "unreachable" looked identical).
console.log(
  venusBuilt === undefined
    ? "[execution-plane] venus=off"
    : `[execution-plane] venus=on comptroller=${venusBuilt.venue.comptroller} ` +
        `vbnb=${venusBuilt.venue.vBnb} markets=${Object.keys(venusBuilt.marketIndex).length} ` +
        `interval=${venusBuilt.intervalMs}ms`,
);

// Which lending posture is live. The preview-secret line matters: absent, the
// hire refuses `preview-receipt-unavailable`, and an operator should read that
// here rather than discover it at a customer's first Deploy.
console.log(
  lendingBuilt === undefined
    ? "[execution-plane] lending=off"
    : `[execution-plane] lending=on vusdt=${lendingBuilt.venue.vUsdt} `
      + `usdt=${lendingBuilt.venue.usdt} pool=${lendingBuilt.venue.swapPool} `
      + `fee=${lendingBuilt.venue.swapFeeTier} interval=${lendingBuilt.intervalMs}ms `
      + `preview-secret=${lendingBuilt.previewSecret === null ? "MISSING — hires will refuse" : "configured"}`,
);

console.log(
  `[execution-plane] billing=${billingConfig.mode} x402=${billingConfig.x402} 0g=${billingConfig.og} ` +
    (billingBuilt === undefined || enabledBillingConfig === undefined ? "runtime=not-loaded" : `runtime=loaded internal=${enabledBillingConfig.internalHost}:${enabledBillingConfig.internalPort}`),
);

console.log(
  passkeyConfig.enabled
    ? `[execution-plane] passkey=on rp=${passkeyConfig.rpId} ` +
        `origins=${passkeyConfig.origins.length} uv=${passkeyConfig.uvRequired} ` +
        `[${passkeyConfig.origins.join(" ")}]`
    : "[execution-plane] passkey=off",
);
if (passkeyConfig.enabled && !passkeyConfig.uvRequired) {
  console.warn(
    "[execution-plane] PASSKEY_UV_REQUIRED=false is a CUSTODY DOWNGRADE: owner " +
      "actions will be accepted from an unlocked device with no user verification.",
  );
}

/* -------------------------------------------------------------------------- */
/* Startup reconcile                                                          */
/* -------------------------------------------------------------------------- */

// PHASE3.7 Rev2 F1.2. `RECONCILE_MIN_ROW_AGE_MS` restates the submit window
// rather than importing it, because the journal is the storage substrate and
// must not depend on a wallet implementation. THIS is what keeps the two
// honest: raise the relay timeout past half the guard and the process refuses
// to START, rather than a request quietly reproducing FINDINGS (ap-1).
// AUDIT A5 / FIXREVIEW N7: the shared, fail-closed boot check. The LP worker
// calls the same one — covering only this process left the one that actually
// reproduced FINDINGS (ap-1) unchecked.
assertReconcileGuardCoversSubmitWindow(providerRegistry.get(network.chainId));

const reconcileInput: ReconcileInput = {
  provider: providerRegistry.get(network.chainId),
  journal,
  // The journal stores an owner and an agent id; the wallet ref a session check
  // needs lives in the agent store, so the resolver bridges the two.
  resolveWallet: async (ownerAddress, agentId) => {
    const agent = await agentStore.getAgentById(agentId);
    if (agent === null) return null;
    if (agent.ownerAddress !== ownerAddress.toLowerCase()) return null;
    return {
      address: agent.walletAddress,
      chainId: network.chainId,
      ownerAddress: agent.ownerAddress,
      custodyModel: agent.custodyModel,
    };
  },
};

const summary = await reconcile(reconcileInput);

console.log(
  `[execution-plane] reconcile committed=${summary.committed} ` +
    `rolledBack=${summary.rolledBack} held=${summary.held.length}`,
);
if (summary.held.length > 0) {
  // UNKNOWN is terminal-until-operator by design; surfacing the count and the
  // keys is the whole point of holding them.
  console.warn(`[execution-plane] held_for_operator: ${summary.held.join(", ")}`);
}

// PHASE3.7 Rev2 F1.4 (REVIEW M4). The boot pass runs ONCE, and only the LP
// worker reconciles periodically — so with LP disabled a row younger than the
// age guard at boot would never be looked at again, and the owner resolve route
// refuses anything that is not UNKNOWN. That is a REGRESSION the guard would
// otherwise introduce, not merely a delay. Exactly one delayed second pass
// covers it: by then every row this boot skipped has aged past the guard.
//
// `unref` so a short-lived process is never held open by a timer it is not
// waiting on.
let secondReconcilePass: NodeJS.Timeout | undefined;
if (summary.skippedYoung > 0) {
  console.log(
    `[execution-plane] reconcile skippedYoung=${summary.skippedYoung}; ` +
      `ONE further pass in ${RECONCILE_MIN_ROW_AGE_MS + 5_000}ms covers the rows ` +
      `present at boot. It does not re-arm (AUDIT A8): rows written after it ` +
      `are the periodic worker's, and with LP disabled they wait for the next ` +
      `process start.`,
  );
  secondReconcilePass = setTimeout(() => {
    void reconcile(reconcileInput)
      .then((second) => {
        console.log(
          `[execution-plane] reconcile(second) committed=${second.committed} ` +
            `rolledBack=${second.rolledBack} held=${second.held.length} ` +
            `skippedYoung=${second.skippedYoung}`,
        );
      })
      .catch((error: unknown) => {
        console.warn(
          `[execution-plane] reconcile(second) failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
  }, RECONCILE_MIN_ROW_AGE_MS + 5_000);
  secondReconcilePass.unref();
}

/* -------------------------------------------------------------------------- */
/* Listen                                                                     */
/* -------------------------------------------------------------------------- */

const demoWiring = await buildDemoWiring({
  env: process.env,
  ...(readEnv("DATA_PLANE_URL") === undefined ? {} : { dataPlaneUrl: readEnv("DATA_PLANE_URL") }),
  ...(readEnv("DATA_PLANE_TOKEN") === undefined ? {} : { dataPlaneToken: readEnv("DATA_PLANE_TOKEN") }),
});

const app = createServer({
  agentStore,
  journal,
  nonceStore,
  runtimeReplayStore,
  killswitch,
  providerRegistry,
  dataPlane,
  ...(lpBuilt === undefined ? {} : { lp: {
    ...lpBuilt.lp,
    ...(preBindRetirementFinalizer === undefined ? {} : { preBindRetirementFinalizer }),
  } }),
  ...(venusBuilt === undefined ? {} : { venus: venusBuilt }),
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
    // AUDIT A-M2: the boot-read routing census, forwarded so S1's session spec
    // can assert it. Absent only when the composition injected its readers.
    ...(lendingBuilt.routing === undefined ? {} : { routing: lendingBuilt.routing }),
  } }),
  ...(billingBuilt === undefined ? {} : { billingOwner: billingBuilt.owner }),
  keyStoreReader,
  balanceReader,
  ...(tradeSettingsStore === undefined || tradePositions === undefined || tradeIntents === undefined
    || tradeDataPlane === undefined || tradeReadiness === undefined || tradeObserver === undefined ? {} : { tradeAgent: {
      settingsStore: tradeSettingsStore,
      positions: tradePositions,
      intents: tradeIntents,
      observer: tradeObserver,
      dataPlane: tradeDataPlane,
      readiness: tradeReadiness,
      feeBps: tradeConfig.feeBps ?? 0,
    } }),
  ...(hireEnabled && lpBuilt !== undefined && hireEvidence !== undefined
    && hireRelayFeePerSubmitWei !== undefined && hireGrantGasHeadroomWei !== undefined
    && tradeConfig.feeTreasury !== undefined ? { hire: {
      evidence: hireEvidence,
      nfpm: lpBuilt.addresses.nfpm,
      routerV3: lpBuilt.addresses.routerV3,
      wbnb: lpBuilt.addresses.wbnb,
      treasury: tradeConfig.feeTreasury,
      feeBps: tradeConfig.feeBps ?? 0,
      relayFeePerSubmitWei: hireRelayFeePerSubmitWei,
      grantGasHeadroomWei: hireGrantGasHeadroomWei,
    } } : {}),
  ...(demoWiring === null ? {} : { demo: demoWiring.server }),
  config: serverConfig,
});

/**
 * DEMO MODE — the worker runs INLINE in the API process by default.
 *
 * It is one timer over a bounded agent list doing bigint arithmetic on shared
 * reads, so its cost is nearer a health check than a worker. Running it here is
 * the difference between demo mode working on a single-service deployment and
 * needing a second one; `npm run demo-worker` remains available for a
 * deployment that would rather run it apart, and `DEMO_WORKER_INLINE=false`
 * turns the inline one off so the two never both drive the same rows.
 *
 * It holds no key and submits nothing, so an inline demo worker cannot affect
 * anything the API process does with money.
 */
const demoWorker =
  demoWiring === null || readEnv("DEMO_WORKER_INLINE") === "false"
    ? undefined
    : startDemoWorker({
        ...demoWiring.worker,
        onError: (agentId, error) => {
          console.warn(
            `[execution-plane] demo ${agentId}: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`,
          );
        },
      });

const provisioningWorker = hireEvidence === undefined ? undefined : createProvisioningWorker({
  store: agentStore,
  evidence: hireEvidence,
  keyStore,
  ...(tradeSettingsStore === undefined ? {} : { tradeSettings: tradeSettingsStore }),
  // R3.3(3): the 60 s sweep materializes a lending hire's settings and guard
  // row exactly as the owner READ does, so a browser that never re-reads still
  // converges.
  ...(lendingBuilt === undefined ? {} : {
    lendingSettings: lendingBuilt.settingsStore,
    lendingGuards: lendingBuilt.guards,
  }),
  onError: (message) => console.warn(`[execution-plane] hire convergence failed: ${message}`),
});
const provisioningTimer = provisioningWorker === undefined ? undefined : setInterval(() => {
  void provisioningWorker.sweep().catch((error: unknown) => {
    console.warn(`[execution-plane] hire sweep failed: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`);
  });
}, 60_000);
provisioningTimer?.unref();

const port = resolvePort(readEnv("PORT"));
const billingInternalServer = billingBuilt === undefined || enabledBillingConfig === undefined ? undefined : listenBillingInternalGateway({
  app: billingBuilt.gateway,
  host: enabledBillingConfig.internalHost,
  port: enabledBillingConfig.internalPort,
});
const server = serve({ fetch: app.fetch, port });

console.log(
  `[execution-plane] listening on port ${port} (private network only; do not expose)`,
);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[execution-plane] ${signal} received, shutting down`);
  // AUDIT A8: the delayed reconcile pass would otherwise fire against stores
  // this function is about to close. `unref` keeps it from HOLDING the process
  // open; it does not keep it from running during a graceful shutdown.
  if (secondReconcilePass !== undefined) clearTimeout(secondReconcilePass);
  if (provisioningTimer !== undefined) clearInterval(provisioningTimer);
  demoWorker?.stop();
  tradeReadiness?.stop();
  lpBuilt?.evidence?.observer.stop();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (billingInternalServer !== undefined) {
    await new Promise<void>((resolve) => billingInternalServer.close(() => resolve()));
  }
  // The three Venus stores, closed together and independently of the loop
  // below: `closeVenusServerDeps` already settles each one on its own, so a
  // single failing pool cannot strand the others.
  await closeVenusServerDeps(venusBuilt);
  // The lending stores, on the same terms and for the same reason.
  await closeLendingServerDeps(lendingBuilt);
  // Closed in dependency order; each `close` is independent, so one failure must
  // not strand the others.
  for (const closeable of [
    journal,
    nonceStore,
    runtimeReplayStore,
    killswitch,
    agentStore,
    ...(lpBuilt === undefined ? [] : [lpBuilt.lp.store, lpBuilt.lp.settingsStore]),
    ...(lpBuilt?.feeEvents === undefined ? [] : [lpBuilt.feeEvents]),
    ...(tradeSettingsStore === undefined ? [] : [tradeSettingsStore]),
    ...(tradePositions === undefined ? [] : [tradePositions]),
    ...(tradeIntents === undefined ? [] : [tradeIntents]),
    ...(preBindRetirementFinalizer?.close === undefined ? [] : [{
      close: () => preBindRetirementFinalizer.close!(),
    }]),
    ...(lpBuilt?.evidence === undefined
      ? [] : [lpBuilt.evidence.store, lpBuilt.evidence.coverageStore,
        ...(lpBuilt.evidence.finalizer === undefined ? [] : [lpBuilt.evidence.finalizer])]),
    ...(billingBuilt === undefined ? [] : [{ close: () => billingBuilt.close() }]),
  ]) {
    try {
      await closeable.close();
    } catch (error) {
      console.error(
        `[execution-plane] close_failed: ${sanitizeMessage(
          error instanceof Error ? error.message : "unknown error",
        )}`,
      );
    }
  }
  console.log("[execution-plane] shutdown complete");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      console.error(
        `[execution-plane] shutdown_failed: ${sanitizeMessage(
          error instanceof Error ? error.message : "unknown error",
        )}`,
      );
      process.exitCode = 1;
    });
  });
}
