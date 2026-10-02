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
import { createPublicClient, getAddress, http, type Address } from "viem";
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
  resolveDcaEnabled,
  resolvePortfolioEnabled,
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
import { createKeyStoreReader, readFinalizedSessionRevocation } from "./account/keyStoreReader.js";
import { createBalanceReader } from "./account/balanceReader.js";
import { createPreBindRetirementFinalizer } from "./lp/preBindRetirementFinalizer.js";
import { resolveBillingConfig } from "./billing/config.js";
import { resolveDomainSalt } from "./auth/ownerAuth.js";
import { parseAccountReadSessionSecret } from "./auth/accountReadSession.js";
import { loadBillingProductionRuntime } from "./billing/runtime.js";
import { listenBillingInternalGateway } from "./billing/listener.js";
import { createGrantEvidenceReader } from "./wallet/grantEvidence.js";
import { createProvisioningWorker } from "./wallet/provisioningWorker.js";
import { assessRenewalQuiescence } from "./wallet/provisioning.js";
import { createTradeSettingsStore } from "./store/tradeSettings.js";
import { createTradePositionStore } from "./store/tradePositions.js";
import { createTradeIntentStore } from "./store/tradeIntents.js";
import { createTradeCmcStore } from "./store/tradeCmc.js";
import { PostgresTradeSimulationStore } from "./store/tradeSimulations.js";
import { createPgSqlClient } from "./store/sql.js";
import { createDcaRoundStore } from "./store/dcaRounds.js";
import { createDcaChainReads } from "./trade/dcaResolve.js";
import { NFPM_56 } from "./ops/nfpm.js";
import { HttpTradeDataPlaneReads } from "./trade/dataPlaneReads.js";
import { createHttpTradeReadinessDataPlane, createTradeReadiness } from "./trade/readiness.js";
import { createTradeDetailObserver } from "./trade/detail.js";
import { createRouteQuoteReader, quoteBestTradfiBuy, quoteBestTradfiSell } from "./trade/route.js";
import { portfolioStockValue } from "./trade/portfolio.js";
import { createPortfolioFillCache, verifyPortfolioFill } from "./trade/portfolioReceipt.js";
import { createTradfiV2ReceiptReader } from "./trade/receipt.js";
import { assertTradfiGuardRuntimeExact, cachedGuardVerification, classifyTradfiFlashError, createTradfiCapabilityProbeCache, flashRequest, TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56, TRADFI_SWAP_GUARD_ABI, type TradfiCapabilityProbeResult } from "./trade/guard.js";
import { USDT_56 } from "./trade/settlement.js";
import { admittedVenueRows } from "./trade/rwa.js";
import { uniswapV3Venue } from "./ops/venues.js";
import { createCmcRuntime } from "./trade/cmcRuntime.js";

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
  // The deploy screen's defaults (5 USDT per buy, 1 % slippage): keep that schedulable list warm.
  schedulableWarm: { amountWei: 5n * 10n ** 18n, slippageBps: 100 },
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
const tradeCmc = tradeAgentEnabled ? await createTradeCmcStore() : undefined;
// Read-only owner view of the pre-flight simulation log: the constructor runs no DDL
// (the trade-worker owns the tables); a missing table reads as `no-table`.
const tradeSimulations = tradeAgentEnabled && readEnv("DATABASE_URL") !== ""
  ? new PostgresTradeSimulationStore(await createPgSqlClient(readEnv("DATABASE_URL"), { max: 2 })) : undefined;
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
const portfolioReceiptReader = tradeRpcUrls === undefined || tradeRpcUrls.length < 2
  ? undefined : createTradfiV2ReceiptReader({ rpcUrls: tradeRpcUrls.slice(0, 2) });
const portfolioFillCache = createPortfolioFillCache();
const tradeRouteReader = tradeRpcUrls === undefined ? undefined : createRouteQuoteReader({
  rpcUrls: tradeRpcUrls,
  ...(tradeConfig.venues.uniswapQuoterV3 === undefined ? {} : { uniswapQuoter: tradeConfig.venues.uniswapQuoterV3 }),
});
const cmcRpcPair = tradeRpcUrls !== undefined && tradeRpcUrls.length >= 2
  ? [tradeRpcUrls[0]!, tradeRpcUrls[1]!] as const : undefined;
const cmcRuntime = tradeCmc === undefined ? undefined : createCmcRuntime({
  store: tradeCmc,
  ...(cmcRpcPair === undefined || network.relayUrl === undefined ? {} : { owner: { rpcUrls: cmcRpcPair, relayUrl: network.relayUrl,
    // Live grant shape for the capability reader: the persisted descriptor
    // only, never the session ciphertext, and only for the requested wallet.
    sessionSpec: async (request) => {
      const agent = await agentStore.getAgentById(request.agentId);
      if (agent === null || agent.walletAddress.toLowerCase() !== request.wallet.toLowerCase()) return null;
      return agent.sessionFacts?.spec ?? null;
    } } }),
});
const cmcOwner = cmcRuntime?.owner.service ?? undefined;
const cmcNews = cmcRuntime?.worker?.news ?? undefined;
const tradfiGuardVerified = tradeConfig.aggregatorGuard === undefined ? undefined : async (guard: Address): Promise<boolean> => {
  try {
    const client = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });
    const runtime = await client.getBytecode({ address: guard });
    if (runtime === undefined) return false;
    assertTradfiGuardRuntimeExact({ deployedRuntime: runtime, router: TRADFI_BINANCE_FLASH_ROUTER_56,
      spender: TRADFI_BINANCE_FLASH_SPENDER_56, canonicalUSDT: USDT_56 });
    const [router, spender, canonicalUSDT] = await Promise.all([
      client.readContract({ address: guard, abi: TRADFI_SWAP_GUARD_ABI, functionName: "router" }),
      client.readContract({ address: guard, abi: TRADFI_SWAP_GUARD_ABI, functionName: "spender" }),
      client.readContract({ address: guard, abi: TRADFI_SWAP_GUARD_ABI, functionName: "canonicalUSDT" }),
    ]);
    return getAddress(router as Address) === TRADFI_BINANCE_FLASH_ROUTER_56
      && getAddress(spender as Address) === TRADFI_BINANCE_FLASH_SPENDER_56
      && getAddress(canonicalUSDT as Address) === USDT_56;
  } catch { return false; }
};
// C9: a `false` verdict (which a transient RPC blip can produce, `catch { return false; }`
// above) is retried after 60 s; a `true` verdict, once observed, is never re-read for the
// process lifetime — the deployed runtime is immutable.
const cachedTradfiGuardVerified = tradeConfig.aggregatorGuard === undefined || tradfiGuardVerified === undefined
  ? undefined
  : cachedGuardVerification(() => tradfiGuardVerified!(tradeConfig.aggregatorGuard!));
// R2.4/R2.8 (H3/M3): the tri-state probe, cached only on a definite answer and
// deduped in-flight per (token, minEntryAtomic); the request slippage is fixed
// at 300 bps (the Flash maximum) — capability means "a route exists both
// ways", execution slippage still binds every trade at submit time.
const tradfiCapabilityProbeCache = createTradfiCapabilityProbeCache();
const tradfiV2CapabilityDetail = tradeDataPlane === undefined ? undefined : async (input: {
  readonly candidate: import("./trade/universe.js").PinnedCandidate;
  readonly minEntryAtomic: bigint;
  readonly signal?: AbortSignal;
}): Promise<TradfiCapabilityProbeResult> => {
  if (admittedVenueRows(input.candidate.venues).length > 0) return "capable";
  const guard = tradeConfig.aggregatorGuard;
  // Bound: the HTTP client's method reads private fields, so a detached
  // reference throws a TypeError before any request (every probe was "unknown").
  const flash = tradeDataPlane.binanceQuoteAndSwap?.bind(tradeDataPlane);
  if (guard === undefined || flash === undefined || cachedTradfiGuardVerified === undefined) return "unknown";
  if (!await cachedTradfiGuardVerified()) return "unknown";
  let buy: Awaited<ReturnType<typeof flash>>;
  try {
    buy = await flash(flashRequest({ tokenIn: USDT_56, tokenOut: input.candidate.address, amountAtomic: input.minEntryAtomic.toString(10), slippageBps: 300, ...(input.signal === undefined ? {} : { signal: input.signal }) }));
  } catch (error) { return classifyTradfiFlashError(error); }
  if (buy.observedAt > Date.now() || Date.now() - buy.observedAt > 30_000 || buy.expiresAt <= Date.now()
    || buy.amountInAtomic !== input.minEntryAtomic.toString(10) || buy.tokenIn.toLowerCase() !== USDT_56.toLowerCase()
    || buy.tokenOut.toLowerCase() !== input.candidate.address.toLowerCase() || getAddress(buy.taker) !== getAddress(guard)
    || buy.quotedOutAtomic === "0" || buy.minOutAtomic === "0") return "incapable";
  const sellAmount = BigInt(buy.minOutAtomic);
  if (sellAmount <= 0n) return "incapable";
  let sell: Awaited<ReturnType<typeof flash>>;
  try {
    sell = await flash(flashRequest({ tokenIn: input.candidate.address, tokenOut: USDT_56, amountAtomic: sellAmount.toString(10), slippageBps: 300, ...(input.signal === undefined ? {} : { signal: input.signal }) }));
  } catch (error) { return classifyTradfiFlashError(error); }
  return sell.observedAt > 0 && sell.observedAt <= Date.now() && Date.now() - sell.observedAt <= 30_000
    && sell.expiresAt > Date.now() && sell.amountInAtomic === sellAmount.toString(10)
    && sell.tokenIn.toLowerCase() === input.candidate.address.toLowerCase() && sell.tokenOut.toLowerCase() === USDT_56.toLowerCase()
    && getAddress(sell.taker) === getAddress(guard) && BigInt(sell.quotedOutAtomic) > 0n && BigInt(sell.minOutAtomic) > 0n
    ? "capable" : "incapable";
};
// G5: direct-venue candidates return `capable` without a call (unchanged) and
// are never cached; only a Flash-backed answer is worth remembering.
const tradfiV2CapabilityProbe = tradfiV2CapabilityDetail === undefined ? undefined : async (input: {
  readonly candidate: import("./trade/universe.js").PinnedCandidate;
  readonly minEntryAtomic: bigint;
  readonly signal?: AbortSignal;
}): Promise<TradfiCapabilityProbeResult> => {
  if (admittedVenueRows(input.candidate.venues).length > 0) return "capable";
  const key = `${input.candidate.address.toLowerCase()}:${input.minEntryAtomic.toString(10)}`;
  // AUDIT LOW-3: the shared/deduped probe (R2.8) is not scoped to any one
  // caller's request, so it must not carry any one caller's own abort signal
  // — a closed preview tab must not cancel a concurrent hire's in-flight
  // probe for the same (token, minEntryAtomic).
  return tradfiCapabilityProbeCache.probe(key, () => tradfiV2CapabilityDetail({
    candidate: input.candidate, minEntryAtomic: input.minEntryAtomic,
  }));
};
// Residual L6 (guard-preference review): a pool-less bStock's detail-page mark
// falls back to the same Flash guard the worker trades through, read-only.
const flashSellQuote = tradeDataPlane === undefined || tradeConfig.aggregatorGuard === undefined || cachedTradfiGuardVerified === undefined
  ? undefined
  : async (input: { readonly token: Address; readonly amountInAtomic: bigint; readonly signal?: AbortSignal }): Promise<bigint> => {
    if (!await cachedTradfiGuardVerified()) throw new Error("Tradfi guard is not verified.");
    const flash = await tradeDataPlane.binanceQuoteAndSwap!(flashRequest({ tokenIn: input.token, tokenOut: USDT_56,
      amountAtomic: input.amountInAtomic.toString(10), slippageBps: 300, ...(input.signal === undefined ? {} : { signal: input.signal }) }));
    if (getAddress(flash.taker) !== getAddress(tradeConfig.aggregatorGuard!) || flash.tokenIn.toLowerCase() !== input.token.toLowerCase()
      || flash.tokenOut.toLowerCase() !== USDT_56.toLowerCase() || flash.amountInAtomic !== input.amountInAtomic.toString(10)
      || flash.expiresAt <= Date.now()) {
      throw new Error("Tradfi Flash mark quote failed validation.");
    }
    return BigInt(flash.quotedOutAtomic);
  };
const scheduleFlashMarks = new Map<string, { readonly quotedOutAtomic: bigint; readonly expiresAt: number }>();
const tradeObserver = tradeRpcUrls === undefined ? undefined : createTradeDetailObserver({
  provider: providerRegistry.get(network.chainId),
  rpcUrls: tradeRpcUrls,
  ...(tradeRouteReader === undefined ? {} : { routeReader: tradeRouteReader }),
  ...(flashSellQuote === undefined ? {} : { flashSellQuote }),
});
// PHASE3.15 (L3). Grid deps are built INSIDE the LP branch below, so a boot
// with `GRID_ENABLED="true"` and LP off would otherwise produce a
// healthy-looking server that skips every grid agent — the PHASE4-AUDIT A1
// shape. `resolveGridEnabled` throws on that pair; calling it here is what
// makes the throw reachable when LP is off, and the boot ternary below carries
// the flag itself (which `buildLpServerDeps` resolves again, once, at the one
// site that composes `LpServerDeps`).
resolveGridEnabled(process.env);
// AUTO-DCA §0.2 (D17). The same boot rule for `DCA_ENABLED`: a bad value, or
// "true" with the trade agent off, fails the boot here rather than serving a
// hire branch that cannot run.
// DEPLOYMENT ORDER (§11.2): every service that calls `reconcile` must run the
// commit that knows the `dcaRange` journal kind before this is "true" anywhere.
const dcaEnabled = resolveDcaEnabled(process.env);
const portfolioEnabled = resolvePortfolioEnabled(process.env);
// AUTO-DCA §13: composed whatever the flag says, as the worker's are — the flag
// gates the hire and its preview; revoke and the view serve an existing DCA agent.
const tradeDca = tradeAgentEnabled && tradeRpcUrls !== undefined
  ? { enabled: dcaEnabled, store: await createDcaRoundStore(), chain: createDcaChainReads({ rpcUrls: tradeRpcUrls.slice(0, 2), nfpm: NFPM_56 }) }
  : undefined;
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

// R2.7 (LOW-3): the same Uniswap ROUTER value scripts/trade-worker.ts computes for the
// worker (uniswapV3Venue's router, gated on the quoter being configured), never the quoter.
const scheduleUniswapV3 = uniswapV3Venue(tradeConfig.venues);

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
      ...(tradeCmc === undefined ? {} : { cmc: tradeCmc }),
      ...(cmcOwner === undefined ? {} : { cmcOwner }),
      ...(cmcRuntime === undefined ? {} : { cmcOwnerResumePending: cmcRuntime.owner.resumePending }),
      ...(cmcRuntime === undefined ? {} : { cmcProtectedExposure: cmcRuntime.owner.protectedExposure }),
      ...(cmcNews === undefined ? {} : { cmcNews }),
      ...(tradfiGuardVerified === undefined ? {} : { guardVerified: tradfiGuardVerified }),
      ...(tradfiV2CapabilityProbe === undefined ? {} : { tradfiV2CapabilityProbe }),
      ...(tradeDca === undefined ? {} : { dca: tradeDca }),
      portfolio: { enabled: portfolioEnabled,
        ...(portfolioReceiptReader === undefined ? {} : { resolveFill: ({ agent, intent, journalEntry, txHash }) =>
          portfolioFillCache.resolve(`${intent.idempotencyKey.toLowerCase()}:${txHash.toLowerCase()}`, () =>
            verifyPortfolioFill({ agent, intent, journalEntry, txHash, reader: portfolioReceiptReader, trade: tradeConfig })) }),
      },
      ...(tradeSimulations === undefined ? {} : { simulations: tradeSimulations }),
      ...(tradeRouteReader === undefined ? {} : { portfolioValue: (input: { readonly token: Address; readonly amountInAtomic: bigint }) =>
        portfolioStockValue(tradeRouteReader, input.token, input.amountInAtomic) }),
      ...(tradeRpcUrls === undefined || tradeRouteReader === undefined ? {} : { scheduleQuotes: {
        buy: (input: { readonly token: Address; readonly amountInAtomic: bigint; readonly slippageBps: number; readonly venues?: readonly import("./trade/dataPlaneReads.js").VenueRow[]; readonly signal?: AbortSignal }) => quoteBestTradfiBuy({
          token: input.token, amountInAtomic: input.amountInAtomic, slippageBps: input.slippageBps, rpcUrls: tradeRpcUrls, reader: tradeRouteReader,
          ...(input.venues === undefined ? {} : { venues: input.venues }), ...(scheduleUniswapV3 === null || tradeConfig.venues.uniswapQuoterV3 === undefined ? {} : { uniswapRouter: scheduleUniswapV3.router }), ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
        sell: async (input: { readonly token: Address; readonly amountInAtomic: bigint; readonly slippageBps: number; readonly venues?: readonly import("./trade/dataPlaneReads.js").VenueRow[]; readonly signal?: AbortSignal }) => {
          try {
            return await quoteBestTradfiSell({
              token: input.token, amountInAtomic: input.amountInAtomic, slippageBps: input.slippageBps, rpcUrls: tradeRpcUrls, reader: tradeRouteReader,
              ...(input.venues === undefined ? {} : { venues: input.venues }), ...(scheduleUniswapV3 === null || tradeConfig.venues.uniswapQuoterV3 === undefined ? {} : { uniswapRouter: scheduleUniswapV3.router }), ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
          } catch (error) {
            // Schedule holding mark for a pool-less bStock: the same Flash fallback as the
            // position observer, cached 60 s per (token, amount) for the shared 5 rps key.
            if (flashSellQuote === undefined) throw error;
            const key = `${input.token.toLowerCase()}:${input.amountInAtomic.toString(10)}`;
            const cached = scheduleFlashMarks.get(key);
            if (cached !== undefined && cached.expiresAt > Date.now()) return { quotedOutAtomic: cached.quotedOutAtomic };
            const quotedOutAtomic = await flashSellQuote({ token: input.token, amountInAtomic: input.amountInAtomic, ...(input.signal === undefined ? {} : { signal: input.signal }) });
            scheduleFlashMarks.set(key, { quotedOutAtomic, expiresAt: Date.now() + 60_000 });
            return { quotedOutAtomic };
          }
        },
      } }),
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
  renewalQuiescence: async (agent) => assessRenewalQuiescence(agent, {
    ...(tradeIntents === undefined ? {} : { tradeIntents }),
    ...(tradeSettingsStore === undefined ? {} : { tradeSettings: tradeSettingsStore }),
    ...(lpBuilt === undefined ? {} : { lpSequences: lpBuilt.lp.store }),
    journal,
  }),
  renewalCoverage: async (agent, pending) => {
    if (pending.sizing.sizingPreset !== "trade-v1") return { ok: true };
    if (tradePositions === undefined || tradeIntents === undefined) return { ok: false };
    const allowed = new Set(pending.sessionSpec.allowedCalls
      .filter((rule) => rule.selector === "approve(address,uint256)" && rule.to !== undefined)
      .map((rule) => rule.to!.toLowerCase()));
    const capped = new Set(pending.sessionSpec.spendCaps.filter((cap) => cap.token !== undefined).map((cap) => cap.token!.toLowerCase()));
    const [positions, unsettled] = await Promise.all([
      tradePositions.list(agent.ownerAddress, agent.id),
      tradeIntents.listUnsettled(agent.ownerAddress, agent.id),
    ]);
    const held = [...positions.filter((row) => row.status === "open").map((row) => row.token), ...unsettled.map((row) => row.token)];
    const missing = held.find((token) => !allowed.has(token.toLowerCase()) || !capped.has(token.toLowerCase()));
    return missing === undefined ? { ok: true } : { ok: false, token: missing };
  },
  ...(tradePositions === undefined || tradeSettingsStore === undefined ? {} : { rebaseTradeEvidence: async (owner: Address, id: string, generation: number) => {
    const fenced = await tradeSettingsStore.withEntryFence(owner, id, (sql) => tradePositions!.rebaseRenewalEvidenceForAgent(owner, id, generation, sql));
    return fenced.kind === "allowed" && fenced.value;
  } }),
  ...(tradePositions === undefined || tradeSettingsStore === undefined ? {} : { clearRenewalMarkers: async (agent: import("./store/agents.js").AgentRecord) => {
    const fenced = await tradeSettingsStore.withEntryFence(agent.ownerAddress, agent.id, (sql) => tradePositions!.clearSessionExpiringMarkers({ ownerAddress: agent.ownerAddress, agentId: agent.id }, sql));
    // The pre-swap rebase already cleared the transient marker. Once a drain
    // owns the entry fence, there is no later writer that can recreate it.
    return fenced.kind === "allowed" || fenced.kind === "draining";
  } }),
  readK2Revocation: async (pending) => {
    const result = await readFinalizedSessionRevocation({
      chainId: network.chainId, keyStoreAddress: keyStore, wallet: pending.walletAddress, keyId: pending.keyStoreKeyId,
      expectedPublicKey: pending.sessionPublicKey, observedAtMs: Date.now(), reader: keyStoreReader,
    });
    return result.kind;
  },
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
  await cmcRuntime?.close();
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
    ...(tradeCmc === undefined ? [] : [tradeCmc]),
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
