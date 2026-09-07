/**
 * Isolated D1 command: it derives an ordinary LP-open batch, calls Porto
 * prepare once, and has no signing, sending, owner-action or write surface.
 */
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { getAddress, isAddress, parseEther } from "viem";
import { resolveLpRuntimeConfig, resolveTradeConfig } from "../src/ops/config.js";
import { V3_FEE_TIERS } from "../src/ops/route.js";
import { centeredRotationRange } from "../src/lp/fence.js";
import { buildLpOpenPlan, lpOpenPlanExecutionDataHash } from "../src/lp/openPlanning.js";
import { admitLpPreparePool } from "../src/lp/prepareAdmission.js";
import { forbiddenTokenAddresses } from "../src/ops/forbiddenTokens.js";
import { PortoPrepareDiagnosticAdapter, lpPrepareDiagnosticAdmissionRefusal, lpPrepareDiagnosticBootstrapOutcome, printableLpPrepareDiagnosticOutcome } from "../src/lp/prepareDiagnostic.js";
import { resolveLpRailConfig } from "../src/lp/rails.js";
import { createLpChainReaders, resolveLpAddresses, resolveLpRpcUrls } from "../src/lp/readers.js";
import { withLpPrepareDiagnosticAgent } from "../src/store/lpPrepareDiagnosticRead.js";
import { canSessionSellTokenReadOnly, preflightSessionCallsReadOnly } from "../src/wallet/sessionPreflightRead.js";
import { MAX_TICK, MIN_TICK } from "../src/lp/tickMath.js";

type Flags = Map<string, string>;
const isMainnet = (process.env["EXECUTION_NETWORK"] ?? "").trim() === "mainnet";
const network: NetworkConfig = isMainnet ? BNB : BNB_TESTNET;
let bootstrapFamily: "config" | "read-session" | "read-only-infrastructure" = "config";

function flags(argv: readonly string[]): Flags {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === undefined || !value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out.set(key, next); i += 1; }
    else out.set(key, "true");
  }
  return out;
}

function required(input: Flags, name: string): string {
  const value = input.get(name);
  if (value === undefined || value === "" || value === "true") throw new Error(`Missing --${name}.`);
  return value;
}

function diagnosticRange(input: Flags, tick: number, spacing: number, maxWidth: number, defaultWidth: number): {
  readonly tickLower: number; readonly tickUpper: number;
} {
  if (input.get("range") === "server-fenced") {
    return centeredRotationRange({ currentTick: tick, tickSpacing: spacing,
      priorWidthTicks: Math.max(2 * spacing, defaultWidth) });
  }
  const lower = Number(required(input, "range-lower"));
  const upper = Number(required(input, "range-upper"));
  if (!Number.isInteger(lower) || !Number.isInteger(upper) || lower % spacing !== 0 ||
      upper % spacing !== 0 || lower < MIN_TICK || upper > MAX_TICK || lower >= upper ||
      upper - lower < 2 * spacing || upper - lower > maxWidth || !(lower <= tick && tick < upper)) {
    throw new Error("The explicit LP range is not admissible.");
  }
  return { tickLower: lower, tickUpper: upper };
}

async function main(): Promise<void> {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "prepare-diagnostic") throw new Error("Unknown live-lp diagnostic command.");
  const input = flags(argv);
  if (input.get("yes-prepare-diagnostic") !== "true") {
    throw new Error("Refused: --yes-prepare-diagnostic acknowledges that this sends no transaction.");
  }
  const agentId = required(input, "agent-id");
  const tokenRaw = required(input, "token");
  if (!isAddress(tokenRaw)) throw new Error("Invalid token.");
  const token = getAddress(tokenRaw);
  const fee = Number(required(input, "fee"));
  if (!V3_FEE_TIERS.includes(fee as (typeof V3_FEE_TIERS)[number])) throw new Error("Invalid V3 fee.");
  const budgetWei = parseEther(input.get("budget") ?? "0.003");
  if (budgetWei <= 0n) throw new Error("Budget must be positive.");

  const railsResult = resolveLpRailConfig(process.env);
  if (!railsResult.ok) throw new Error("LP rails are unavailable.");
  const trade = resolveTradeConfig(process.env, { chainId: network.chainId, keyStore: getAddress(network.keyStore) });
  const addresses = resolveLpAddresses(process.env, { chainId: network.chainId, keyStore: getAddress(network.keyStore),
    ...(trade.venues.pancakeRouterV3 === undefined ? {} : { routerV3: trade.venues.pancakeRouterV3 }),
    ...(trade.venues.wbnb === undefined ? {} : { wbnb: trade.venues.wbnb }) });
  const readers = createLpChainReaders({ network: { chain: network.chain, chainId: network.chainId,
    publicRpcUrl: network.publicRpcUrl }, rpcUrls: resolveLpRpcUrls(process.env, { chain: network.chain,
    chainId: network.chainId, publicRpcUrl: network.publicRpcUrl }), nfpm: addresses.nfpm,
    factory: addresses.factory, quoterV2: addresses.quoterV2, twapWindowSeconds: railsResult.config.twapWindowSeconds });
  const runtime = resolveLpRuntimeConfig(process.env);
  const rpcUrl = resolveLpRpcUrls(process.env, { chain: network.chain, chainId: network.chainId,
    publicRpcUrl: network.publicRpcUrl })[0] ?? network.publicRpcUrl;

  bootstrapFamily = "read-session";
  await withLpPrepareDiagnosticAgent(agentId, async ({ agent, sessionPrivateKey }) => {
    bootstrapFamily = "read-only-infrastructure";
    const facts = agent.sessionFacts;
    if (facts === null || agent.status !== "armed" || agent.caps?.dailyNativeWei === undefined ||
        budgetWei > agent.caps.dailyNativeWei) throw new Error("The agent/session/budget is not eligible for LP open.");
    if (budgetWei > await readers.onChainNativeDailyCapWei(agent)) {
      throw new Error("The requested budget exceeds the session's on-chain native cap.");
    }
    const token0 = token.toLowerCase() < addresses.wbnb.toLowerCase() ? token : addresses.wbnb;
    const token1 = token0 === token ? addresses.wbnb : token;
    let admission: Awaited<ReturnType<typeof admitLpPreparePool>>;
    try { admission = await admitLpPreparePool({ agent, token0, token1, fee, wbnb: addresses.wbnb,
      forbiddenTokenAddresses: new Set([...forbiddenTokenAddresses({ wallet: agent.walletAddress,
        keyStore: getAddress(network.keyStore), venues: trade.venues,
        ...(trade.feeTreasury === undefined ? {} : { treasury: trade.feeTreasury }) }), addresses.nfpm.toLowerCase()]), rails: railsResult.config,
      canSessionSellToken: async (candidate, sellToken) => canSessionSellTokenReadOnly({ network, rpcUrl,
        walletAddress: candidate.walletAddress, publicKey: candidate.sessionFacts?.publicKey ?? facts.publicKey, token: sellToken }),
      getPool: readers.getPool, poolState: readers.poolState });
    } catch {
      console.log(JSON.stringify(printableLpPrepareDiagnosticOutcome(lpPrepareDiagnosticAdmissionRefusal())));
      return;
    }
    const state = admission.state;
    const range = diagnosticRange(input, state.currentTick, state.tickSpacing, runtime.maxTickWidth,
      runtime.defaultOpenWidthTicks);
    // PHASE3.16: this diagnostic mirrors `POST /lp/open`, so it states that
    // route's mode. The grid arm has its own operator path (`live-grid arm`).
    const calls = await buildLpOpenPlan({ mode: "two-sided-in-range",
      walletAddress: agent.walletAddress, token0, token1, fee,
      wbnb: addresses.wbnb, nfpm: addresses.nfpm, routerV3: addresses.routerV3, budgetWei,
      tickLower: range.tickLower, tickUpper: range.tickUpper, currentTick: state.currentTick,
      spotSqrtPriceX96: state.evidence.spotSqrtPriceX96,
      deadline: BigInt(Math.floor(Date.now() / 1_000) + 120), rails: railsResult.config,
      quote: readers.quote });
    const executionDataHash = lpOpenPlanExecutionDataHash(calls);
    try { await preflightSessionCallsReadOnly({ network, rpcUrl,
      session: { walletAddress: agent.walletAddress, publicKey: facts.publicKey, spec: facts.spec }, calls });
    } catch {
      console.log(JSON.stringify(printableLpPrepareDiagnosticOutcome(lpPrepareDiagnosticAdmissionRefusal())));
      return;
    }
    const result = await new PortoPrepareDiagnosticAdapter({ network }).prepare({ sessionPrivateKey,
      walletAddress: agent.walletAddress, persistedSession: facts, restoredSessionPublicKey: facts.publicKey,
      restoredSessionExpiry: facts.expiry, calls, expectedExecutionDataHash: executionDataHash });
    if (result === null) console.log("prepare-diagnostic: prepare completed; no signature or transaction was sent.");
    else console.log(JSON.stringify(printableLpPrepareDiagnosticOutcome(result)));
  });
}

main().catch(() => {
  console.log(JSON.stringify(printableLpPrepareDiagnosticOutcome(lpPrepareDiagnosticBootstrapOutcome(bootstrapFamily))));
  process.exitCode = 1;
});
