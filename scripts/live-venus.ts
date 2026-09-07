/**
 * `live-venus` — the Venus guard operator script (PHASE4-SPEC D10).
 *
 * Subcommands:
 *
 *   status          read-only: the account's finalized reconstruction on BOTH
 *                   bases, each with its protocol match flag, plus the durable
 *                   hysteresis row and the quota ledger.
 *   simulate        read-only: what a live worker cycle WOULD do — a dry run
 *                   through the real worker, writing nothing.
 *   settings        print the stored settings and their digest.
 *   rescue          ONE live worker cycle. SPENDS. Requires `--yes-live`.
 *   untrack-sweep   drop the data plane's tracked-owner reference for every
 *                   Venus-settings row whose agent is revoked or absent — the
 *                   named runbook command for the case R3.9 documents as
 *                   leaking references BY DESIGN (a disabled worker cannot
 *                   converge them). Requires `--yes-live` because it mutates
 *                   the data plane.
 *
 * EVERY SPENDING PATH IS BEHIND `--yes-live`, and the flag is checked before
 * anything is constructed. `rescue` additionally requires the mainnet
 * confirmation the rest of this repo uses, because it submits under the
 * standing session and moves the owner's funds into the owner's own position.
 *
 * READ-ONLY BY DEFAULT: `status`, `simulate` and `settings` make chain reads
 * and store reads and nothing else. `simulate` drives the REAL worker with
 * `dryRun: true`, which performs ZERO provider calls and ZERO writes — the same
 * contract the LP worker's rehearsal has, so what it reports is what a live
 * cycle would record rather than a second implementation of the decision.
 */
import { getAddress, type Address } from "viem";
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { AltanaProvider } from "../src/wallet/altana.js";
import { createAgentStore } from "../src/store/agents.js";
import { createJournal } from "../src/store/journal.js";
import { createKillSwitch } from "../src/killswitch/killswitch.js";
import { createVenusSettingsStore } from "../src/store/venusSettings.js";
import { createVenusObservationStore } from "../src/store/venusObservations.js";
import {
  VENUS_QUOTA_WINDOW_MS,
  createVenusActionStore,
} from "../src/store/venusActions.js";
import { HttpDataPlaneClient } from "../src/clients/dataPlane.js";
import {
  resolveVenusEnabled,
  resolveVenusRuntimeConfig,
} from "../src/ops/config.js";
import {
  createVenusChainReaders,
  resolveVenusRpcUrls,
} from "../src/venus/readers.js";
import { venusBasisView } from "../src/venus/triggers.js";
import {
  runVenusWorkerOnce,
  type VenusWorkerDeps,
} from "../src/venus/worker.js";
import { parseVenusSettingsParams } from "../src/http/venusWire.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { assertMainnetConfirmed } from "./spike/network.js";

const COMMANDS = new Set([
  "status",
  "simulate",
  "settings",
  "rescue",
  "untrack-sweep",
]);

/** Subcommands that SPEND or mutate something outside this process. */
const LIVE_COMMANDS = new Set(["rescue", "untrack-sweep"]);

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (entry === `--${name}`) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith("--") ? next : undefined;
    }
    if (entry !== undefined && entry.startsWith(`--${name}=`)) {
      return entry.slice(name.length + 3);
    }
  }
  return undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function format(value: bigint | null, decimals = 18): string {
  if (value === null) return "inf";
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/u, "");
  return `${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === undefined || !COMMANDS.has(command)) {
    throw new Error(
      `Usage: npm run live-venus -- <${[...COMMANDS].join("|")}> [--agent-id <id>] [--yes-live]`,
    );
  }

  // The gate is checked FIRST, before anything is constructed, so a forgotten
  // flag cannot spend on the way to discovering it was forgotten.
  if (LIVE_COMMANDS.has(command) && !flag("yes-live")) {
    throw new Error(
      `\`${command}\` ${command === "rescue" ? "SPENDS REAL FUNDS" : "MUTATES THE DATA PLANE"} ` +
        "and requires --yes-live. Nothing was constructed and nothing ran.",
    );
  }

  if (!resolveVenusEnabled(process.env)) {
    throw new Error(
      'VENUS_ENABLED is not "true"; live-venus refuses on a deployment that has not enabled the guard.',
    );
  }
  const runtime = resolveVenusRuntimeConfig(process.env);

  const isMainnet = (process.env["EXECUTION_NETWORK"] ?? "").trim() === "mainnet";
  if (command === "rescue" && isMainnet) assertMainnetConfirmed();
  const network: NetworkConfig = isMainnet ? BNB : BNB_TESTNET;
  const readerNetwork = {
    chain: network.chain,
    chainId: network.chainId,
    publicRpcUrl: network.publicRpcUrl,
  };
  if (network.chainId !== 56) {
    throw new Error(
      `The Venus guard is chain-56 only; this run resolves chain ${network.chainId}.`,
    );
  }
  const rpcUrls = resolveVenusRpcUrls(process.env, readerNetwork);

  const settingsStore = await createVenusSettingsStore();
  const observations = await createVenusObservationStore();
  const actions = await createVenusActionStore();
  const agentStore = await createAgentStore();

  const agentId = argValue("agent-id");
  const rows = (await settingsStore.listForWorker()).filter(
    (row) => agentId === undefined || row.agentId === agentId,
  );

  const markets = new Set<string>([runtime.venue.vBnb.toLowerCase()]);
  for (const row of rows) {
    const parsed = parseVenusSettingsParams(row.params);
    if (!parsed.ok) continue;
    for (const market of [
      ...parsed.value.debtMarkets,
      ...parsed.value.collateralMarkets,
    ]) {
      markets.add(market.toLowerCase());
    }
  }
  const readers = createVenusChainReaders({
    network: readerNetwork,
    rpcUrls,
    venue: runtime.venue,
    markets: [...markets].map((entry) => getAddress(entry)),
  });

  const dataPlaneUrl = process.env["DATA_PLANE_URL"]?.trim() ?? "";
  const dataPlane =
    dataPlaneUrl === ""
      ? undefined
      : new HttpDataPlaneClient({
          baseUrl: dataPlaneUrl,
          ...(process.env["DATA_PLANE_TOKEN"]?.trim()
            ? { token: process.env["DATA_PLANE_TOKEN"]?.trim() ?? "" }
            : {}),
        });

  try {
    if (command === "settings") {
      for (const row of rows) {
        const parsed = parseVenusSettingsParams(row.params);
        console.log(`agent ${row.agentId} owner ${row.ownerAddress}`);
        console.log(`  digest   : ${row.digest}`);
        console.log(`  updatedAt: ${new Date(row.updatedAt).toISOString()}`);
        console.log(
          `  parsed   : ${parsed.ok ? JSON.stringify(parsed.value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : `UNREADABLE — ${parsed.message}`}`,
        );
      }
      if (rows.length === 0) console.log("(no Venus settings rows)");
      return;
    }

    if (command === "status") {
      for (const row of rows) {
        console.log(`\nagent ${row.agentId} owner ${row.ownerAddress}`);
        const reading = await readers.readAccount(row.ownerAddress);
        const view = venusBasisView(reading);
        console.log(`  block            : ${reading.blockNumber} (finalized)`);
        console.log(`  userPoolId       : ${reading.userPoolId} / lastPoolId ${reading.lastPoolId}`);
        console.log(`  protocolPaused   : ${reading.protocolPaused}`);
        // BOTH bases, unconditionally, each with its match flag (R2.15/R21).
        console.log(
          `  liquidation      : W ${format(view.pair.liquidationRisk.collateral)} ` +
            `D ${format(view.pair.liquidationRisk.debt)} ` +
            `HF ${format(view.pair.liquidationRisk.healthFactor)} ` +
            `matched=${view.liquidationMatched}`,
        );
        console.log(
          `  borrowing power  : W ${format(view.pair.borrowingPower.collateral)} ` +
            `D ${format(view.pair.borrowingPower.debt)} ` +
            `HF ${format(view.pair.borrowingPower.healthFactor)} ` +
            `matched=${view.borrowingPowerMatched}`,
        );
        if (!view.liquidationMatched || !view.borrowingPowerMatched) {
          console.error(
            "  PROTOCOL MISMATCH: the local reconstruction does not equal the protocol's " +
              "own answer. The guard FAILS CLOSED on this rather than acting on a smaller " +
              "number.",
          );
        }
        const observation = await observations.get(
          row.ownerAddress,
          row.agentId,
          "rescue",
        );
        console.log(
          `  hysteresis       : ${
            observation === null
              ? "no durable observation"
              : `block ${observation.blockNumber} at ${new Date(observation.evaluatedAtMs).toISOString()} ` +
                `breach=${observation.breach} consecutive=${observation.consecutive} ` +
                `digest-matches=${observation.settingsDigest === row.digest}`
          }`,
        );
        const usage = await actions.usageSince(
          row.ownerAddress,
          row.agentId,
          Date.now() - VENUS_QUOTA_WINDOW_MS,
        );
        console.log(
          `  ledger (24h)     : rescues=${usage.rescues} claims=${usage.claims} ` +
            `submissions=${usage.submissions}`,
        );
        for (const market of reading.markets) {
          if (
            market.vTokenBalance === 0n
            && market.borrowStored === 0n
            && !market.collateralMember
          ) {
            continue;
          }
          console.log(
            `    ${market.vTokenSymbol.padEnd(8)} member=${market.collateralMember ? "y" : "n"} ` +
              `borrow=${market.borrowCurrent ?? market.borrowStored} ` +
              `wallet=${market.walletBalance} allowance=${market.allowance} ` +
              `mintPaused=${market.mintPaused} repayPaused=${market.repayPaused}`,
          );
        }
      }
      if (rows.length === 0) console.log("(no Venus settings rows)");
      return;
    }

    if (command === "untrack-sweep") {
      if (dataPlane === undefined) {
        throw new Error("DATA_PLANE_URL is required for untrack-sweep.");
      }
      // R3.9's named runbook command. A deployment with VENUS_ENABLED=false has
      // no worker to converge tracked references, so they persist BY DESIGN
      // until this runs — and the data plane's capacity is 1 000 subjects, so
      // leaked references are how a deployment reaches it.
      let dropped = 0;
      for (const row of rows) {
        const agent = await agentStore.getAgent(row.ownerAddress, row.agentId);
        if (agent !== null && agent.status !== "revoked") continue;
        const result = await dataPlane.venusUntrackOwner(
          row.ownerAddress,
          row.agentId,
        );
        dropped += 1;
        console.log(
          `dropped tracking for agent ${row.agentId} owner ${row.ownerAddress}: ${result.kind}`,
        );
      }
      console.log(`untrack-sweep done: ${dropped} reference(s) dropped.`);
      return;
    }

    // `simulate` and `rescue` both drive the REAL worker; only the flag differs.
    const journal = await createJournal();
    const killswitch = await createKillSwitch();
    const provider = new AltanaProvider({ network, rpcUrls });
    const deps: VenusWorkerDeps = {
      agentStore,
      journal,
      killswitch,
      provider,
      settingsStore,
      observations,
      actions,
      readers,
      venue: runtime.venue,
      ...(dataPlane === undefined ? {} : { dataPlane }),
      intervalMs: runtime.intervalMs,
      maxObservationAgeMs: runtime.maxObservationAgeMs,
      agentConcurrency: runtime.agentConcurrency,
      now: Date.now,
      dryRun: command === "simulate",
      log: (outcome) => {
        console.log(
          `[live-venus] agent=${outcome.agentId} action=${outcome.action} ` +
            `condition=${outcome.condition ?? "-"} kind=${outcome.kind ?? "-"} ` +
            `market=${outcome.vToken ?? "-"} amount=${outcome.amountWei ?? "-"} ` +
            `hf=${outcome.healthFactor ?? "inf"} effect=${outcome.effect ?? "-"} ` +
            `reason=${sanitizeMessage(outcome.reason)}`,
        );
      },
    };
    if (command === "simulate") {
      console.log(
        "[live-venus] REHEARSAL: zero provider calls, zero writes, zero durable " +
          "observations. Chain reads still happen — they ARE the decision.",
      );
    } else {
      console.log(
        "[live-venus] LIVE: this cycle may submit under the standing on-chain session.",
      );
    }
    const report = await runVenusWorkerOnce(deps);
    console.log(
      `[live-venus] cycle done outcomes=${report.outcomes.length} dry-run=${report.dryRun}`,
    );
    await Promise.all([journal.close(), killswitch.close()]);
  } finally {
    await Promise.all([
      settingsStore.close(),
      observations.close(),
      actions.close(),
      agentStore.close(),
    ]);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

/** Exported only so the address helper is not tree-shaken out of the bundle. */
export type LiveVenusOwner = Address;
