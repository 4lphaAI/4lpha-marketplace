/**
 * TRADFI-LLM-CMC-REQUEST R2.6/R3.5 — operator-only, ONE-SHOT probe of
 * `us_equity_upcoming_event_calendar`, whose payload shape is not measured
 * (memory `tradfi-cmc-equity-phase`: a parser written from a description was
 * wrong). This makes exactly ONE real paid call through the SAME `refreshOne`
 * path the trade-worker daemon uses (`refreshProbeOnce`, `src/trade/cmcNews.ts`)
 * against a chosen LIVE agent's own CMC budget, and writes the untransformed
 * response body to disk for a human to read before a follow-up hotfix writes
 * `compactEventCalendar` from it.
 *
 * SPENDS REAL MONEY: 0.01 USDT of that agent's authorized CMC allowance, and
 * takes that agent's hourly CMC slot for the rest of the hour (its scheduled
 * macro/sector/scanner/planning call for this hour is delayed). It refuses to
 * run unless `--yes-spend-0.01` is passed. Never run this from a test, a loop,
 * or "to check something" — only on an explicit per-run operator "go"
 * (AGENTS.md §2).
 *
 * Usage:
 *   node --import tsx scripts/live-cmc-probe-skill.ts <agentId> <symbol> --yes-spend-0.01
 *
 * Writes the raw response body to
 * `scripts/tmp/probe-us_equity_upcoming_event_calendar-<symbol>.json`
 * (gitignored). Nothing else reads or logs the raw body.
 *
 * The follow-up hotfix (NOT part of this build) writes the parser from that
 * file and adds `us_equity_upcoming_event_calendar` to `CMC_CURRENT_SKILLS`
 * (`src/trade/cmcUsEquity.ts`) before flipping `CMC_EVENT_CALENDAR_ENABLED`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import { createAgentStore } from "../src/store/agents.js";
import { createTradeSettingsStore } from "../src/store/tradeSettings.js";
import { createTradeCmcStore } from "../src/store/tradeCmc.js";
import { createJournal } from "../src/store/journal.js";
import { createKillSwitch } from "../src/killswitch/killswitch.js";
import { AltanaProvider, agentAuthorityFromPrivateKey } from "../src/wallet/altana.js";
import { loadMasterKey } from "../src/store/crypto.js";
import { isTradfiV2Settings, parseTradeSettings } from "../src/trade/settings.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { refreshProbeOnce } from "../src/trade/cmcNews.js";
import { createCmcSessionAdapter } from "../src/trade/cmcRuntime.js";
import { createCmcPaymentClient, createCmcProductionPaymentWiring, type CmcRuntimeAuthorization } from "../src/trade/cmcPayment.js";
import { CMC_PRICE_ATOMIC, type CmcTarget } from "../src/trade/cmc.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { BNB } from "@altananetwork/sdk";

/** The one skill this script may ever probe — never a caller-supplied name. */
const PROBE_SKILL = "us_equity_upcoming_event_calendar";
const PROBE_STORE_SKILL = `${PROBE_SKILL}:probe`;

export type ProbeArgs = { readonly agentId: string; readonly symbol: string };

/**
 * R2.8.10: the argument guard, tested directly and in isolation — this
 * function performs no I/O and spends nothing. Throws when the arguments are
 * missing or the spend confirmation flag is absent.
 */
/** AUDIT L-2: a plain ticker shape only — this also feeds the output filename, so a `../` segment must never reach it. */
const PROBE_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/u;

export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const agentId = positional[0];
  const symbol = positional[1];
  if (agentId === undefined || agentId.trim() === "" || symbol === undefined || symbol.trim() === "") {
    throw new Error("Usage: live-cmc-probe-skill.ts <agentId> <symbol> --yes-spend-0.01");
  }
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!PROBE_SYMBOL_PATTERN.test(normalizedSymbol)) {
    throw new Error(`<symbol> must match ${PROBE_SYMBOL_PATTERN.source}, got: ${normalizedSymbol}`);
  }
  if (!argv.includes("--yes-spend-0.01")) {
    throw new Error("Refusing to run: pass --yes-spend-0.01 to confirm this spends 0.01 USDT of that live agent's CMC allowance and takes its hourly slot.");
  }
  return { agentId: agentId.trim(), symbol: normalizedSymbol };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (value === "") throw new Error(`${name} is required.`);
  return value;
}

async function probeMain(argv: readonly string[]): Promise<void> {
  const { agentId, symbol } = parseProbeArgs(argv);
  if ((process.env["EXECUTION_NETWORK"] ?? "").trim() !== "mainnet" || BNB.chainId !== 56) {
    throw new Error("live-cmc-probe-skill requires BNB mainnet chain 56.");
  }
  required(process.env, "DATABASE_URL");
  required(process.env, "EXECUTION_MASTER_KEY");
  const masterKey = loadMasterKey();
  if (masterKey === null) throw new Error("EXECUTION_MASTER_KEY did not resolve to a usable key.");

  const agentStore = await createAgentStore();
  const settingsStore = await createTradeSettingsStore(agentStore);
  const cmcStore = await createTradeCmcStore();
  const journal = await createJournal();
  const killswitch = await createKillSwitch();
  const rpcUrls = resolveLpRpcUrls(process.env, { chain: BNB.chain, chainId: BNB.chainId, publicRpcUrl: BNB.publicRpcUrl });
  const provider = new AltanaProvider({ network: BNB, rpcUrls });

  try {
    const agent = await agentStore.getAgentById(agentId);
    if (agent === null || agent.sessionFacts === null) throw new Error("Agent has no live session.");
    const settingsRow = await settingsStore.get(agent.ownerAddress, agent.id);
    const parsedSettings = settingsRow === null ? null : parseTradeSettings(settingsRow.params);
    if (parsedSettings?.ok !== true || !isTradfiV2Settings(parsedSettings.value.effective)) {
      throw new Error("Agent is not a TradFi v2 agent.");
    }

    // R2.6/R3.6: the SAME payment path the daemon uses — no new payment code.
    // `authorize` mirrors `scripts/trade-worker.ts`'s CMC authorize exactly
    // (AUDIT L-1: including the per-call `cmcNewsEnabled`/TradFi-v2 settings
    // re-check, not just the one-time startup check above), so a probe can
    // never spend where the live daemon itself would refuse — including the
    // case where the owner turns CMC news off between the startup check and
    // this call.
    // Live 2026-09-25: like the runtime (`cmcRuntime.ts` authorize wrapper),
    // the payment path carries the CMC BUDGET generation while the session
    // check compares the TRADING-SESSION generation captured here.
    const sessionGeneration = agent.sessionFacts.generation ?? 0;
    const budgetAtStart = await cmcStore.get(agent.id, agent.ownerAddress);
    if (budgetAtStart === null) throw new Error("Agent has no CMC data budget.");
    const authorize: CmcRuntimeAuthorization = async (request) => {
      const current = await agentStore.getAgentById(request.agentId);
      const budget = await cmcStore.get(request.agentId, request.ownerAddress);
      const currentSettingsRow = current === null ? null : await settingsStore.get(current.ownerAddress, current.id);
      const currentParsedSettings = currentSettingsRow === null ? null : parseTradeSettings(currentSettingsRow.params);
      const walletUsdt = current === null ? 0n : await provider.getTokenBalance({
        wallet: { address: current.walletAddress, ownerAddress: current.ownerAddress, custodyModel: current.custodyModel, chainId: 56 }, token: USDT_56 });
      const blocked = current === null ? true : await killswitch.isBlocked(current.id, current.ownerAddress);
      const pendingBuyHolds = current === null ? 0n : await journal.sumPendingQuoteSpendSince(current.id, 0);
      const spendableWalletUsdt = walletUsdt > pendingBuyHolds ? walletUsdt - pendingBuyHolds : 0n;
      if (current === null || current.ownerAddress.toLowerCase() !== request.ownerAddress.toLowerCase()
        || current.walletAddress.toLowerCase() !== request.wallet.toLowerCase() || current.sessionFacts === null
        || current.status !== "armed" || blocked || current.pendingRenewal !== null && current.pendingRenewal !== undefined
        || current.sessionFacts.publicKey.toLowerCase() !== request.sessionPublicKey.toLowerCase()
        || (current.sessionFacts.generation ?? 0) !== sessionGeneration
        || current.sessionFacts.expiry !== request.sessionExpiry
        || currentParsedSettings?.ok !== true || !isTradfiV2Settings(currentParsedSettings.value.effective)
        || currentParsedSettings.value.effective.cmcNewsEnabled !== true
        || budget === null || spendableWalletUsdt < request.amountWei || !budget.optedIn) {
        return { ok: false as const, reason: "cmc_session_or_budget_mismatch" };
      }
      return { ok: true as const };
    };
    const sessionForAgent = createCmcSessionAdapter({
      read: async (requestedAgentId) => {
        const current = await agentStore.getAgentById(requestedAgentId);
        if (current === null || current.sessionFacts === null) return null;
        const executing = await agentStore.readExecutingSession(current.ownerAddress, current.id);
        if (executing === null) return null;
        return { walletAddress: current.walletAddress, agent: agentAuthorityFromPrivateKey(executing.key),
          sessionFacts: { spec: executing.facts.spec, publicKey: executing.facts.publicKey, expiry: executing.facts.expiry } };
      },
      restoreSession: (params) => provider.restoreSession(params),
    });
    const wiring = createCmcProductionPaymentWiring({ sessionForAgent });
    const payment = createCmcPaymentClient({ store: cmcStore, signer: wiring.signer, transport: wiring.transport, now: Date.now, authorize });

    const probeTarget: CmcTarget = { kind: "skill", ticker: "_PROBE", uniqueName: PROBE_SKILL, storeSkill: PROBE_STORE_SKILL, parameters: { symbol } };
    console.log(`[live-cmc-probe-skill] agent=${agentId} symbol=${symbol} price=${CMC_PRICE_ATOMIC.toString(10)} wei — making ONE paid call now`);
    const { result, rawBody } = await refreshProbeOnce(cmcStore, payment, {
      agentId: agent.id, ownerAddress: getAddress(agent.ownerAddress), wallet: getAddress(agent.walletAddress),
      sessionPublicKey: agent.sessionFacts.publicKey, sessionExpiry: agent.sessionFacts.expiry,
      generation: budgetAtStart.generation, heldTickers: [], shortlistedTickers: [], masterKey,
    }, probeTarget, Date.now);

    console.log(`[live-cmc-probe-skill] result state=${result.state} reason=${result.reason ?? "-"} operationId=${result.operationId ?? "-"}`);
    if (rawBody === null) {
      console.log("[live-cmc-probe-skill] no raw response body was captured (the call did not reach transmit).");
      return;
    }
    mkdirSync("scripts/tmp", { recursive: true });
    const outPath = `scripts/tmp/probe-${PROBE_SKILL}-${symbol}.json`;
    writeFileSync(outPath, rawBody, "utf8");
    console.log(`[live-cmc-probe-skill] wrote raw response body to ${outPath} (${rawBody.length} chars)`);
  } finally {
    for (const store of [settingsStore, journal, killswitch, agentStore, cmcStore]) {
      try { await store.close(); } catch { /* independent close */ }
    }
  }
}

// Only runs when invoked directly (`node ... scripts/live-cmc-probe-skill.ts`),
// never on import — so a test may import `parseProbeArgs` without spending anything.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeMain(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`live-cmc-probe-skill failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
