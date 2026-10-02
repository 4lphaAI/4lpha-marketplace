/**
 * The operator's half of a `dcaRange` UNKNOWN (AUTO-DCA R2.8, REVIEW2 conditions
 * 3 and 16).
 *
 *   node --import tsx --env-file-if-exists=.env scripts/dca-resolve.ts --agent <id> --action <key> [--apply]
 *
 * READ-ONLY without `--apply`: it prints the evidence — each planned exit's
 * liquidity, the wallet's NFPM positions against each planned mint, the wallet
 * balances against the pre-submit snapshot, the action's age — all read with
 * `eth_call` at the finalized tip. It submits NOTHING to chain, ever.
 *
 * `--apply` writes, and only on a NOT-LANDED verdict with every evidence read
 * answered: the journal row `UNKNOWN → ROLLED_BACK` with the evidence on it
 * (`resolveUnknown`), then the action `rolled-back`. It refuses when any read
 * errored. A LANDED verdict is the worker's to finish automatically, from the
 * receipt. A `dca_actions` row with NO journal row (nothing was ever submitted
 * under its key) is released by the same `--apply`, whether `intended` or
 * `submitted`: the executor never leaves a `submitted` action without its
 * journal row (it journals before it submits), so that pair means no submission
 * happened and releasing it is safe (audit L-7).
 */
import { BNB } from "@altananetwork/sdk";
import { getAddress } from "viem";
import { createAgentStore } from "../src/store/agents.js";
import { createTradeSettingsStore } from "../src/store/tradeSettings.js";
import { createJournal } from "../src/store/journal.js";
import { createDcaRoundStore } from "../src/store/dcaRounds.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { parseTradeSettings } from "../src/trade/settings.js";
import { dcaPoolForToken } from "../src/trade/dca.js";
import { dcaIdempotencyKey } from "../src/trade/dcaExecute.js";
import { createDcaChainReads, dcaUnknownEvidence } from "../src/trade/dcaResolve.js";

function parseArgs(argv: readonly string[]): { readonly agentId: string; readonly actionKey: string; readonly apply: boolean } {
  let agentId = "";
  let actionKey = "";
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") { apply = true; continue; }
    const value = argv[index + 1];
    if ((flag === "--agent" || flag === "--action") && value !== undefined && !value.startsWith("--")) {
      if (flag === "--agent") agentId = value; else actionKey = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${flag ?? ""}.`);
  }
  if (agentId === "" || actionKey === "") throw new Error("Usage: dca-resolve --agent <id> --action <key> [--apply]");
  return { agentId, actionKey, apply };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const agentStore = await createAgentStore();
  const settingsStore = await createTradeSettingsStore(agentStore);
  const journal = await createJournal();
  const store = await createDcaRoundStore();
  const agent = await agentStore.getAgentById(args.agentId);
  if (agent === null) throw new Error("No such agent.");
  const settingsRow = await settingsStore.get(agent.ownerAddress, agent.id);
  const parsed = settingsRow === null ? null : parseTradeSettings(settingsRow.params);
  const pool = parsed === null || !parsed.ok ? null : dcaPoolForToken(parsed.value.effective.dcaToken ?? "");
  if (pool === null) throw new Error("The agent's settings name no Auto DCA stock.");
  const action = await store.getAction(agent.ownerAddress, args.actionKey);
  if (action === null || action.agentId !== agent.id) throw new Error("No such DCA action for this agent.");
  const key = dcaIdempotencyKey(action.actionKey);
  const entry = await journal.get(key);
  console.log(`[dca-resolve] agent=${agent.id} action=${action.actionKey} kind=${action.kind} state=${action.state} journal=${entry?.state ?? "none"} callsId=${entry?.externalRef.callsId ?? "none"}`);

  if (entry === null) {
    console.log("[dca-resolve] no journal row: nothing was ever submitted under this key.");
    if (args.apply && (action.state === "intended" || action.state === "submitted")) {
      await store.setActionState({ ownerAddress: agent.ownerAddress, actionKey: action.actionKey, from: ["intended", "submitted"],
        to: "rolled-back", note: "operator: no journal row", nowMs: Date.now() });
      console.log("[dca-resolve] applied: action rolled-back.");
    }
    return;
  }
  if (entry.state !== "UNKNOWN") {
    console.log("[dca-resolve] the journal row is not UNKNOWN; the worker converges it. Nothing to do.");
    return;
  }
  const readerNetwork = { chain: BNB.chain, chainId: BNB.chainId, publicRpcUrl: BNB.publicRpcUrl };
  const rpcUrls = resolveLpRpcUrls(process.env, readerNetwork);
  const reads = createDcaChainReads({ rpcUrls: rpcUrls.slice(0, 2), nfpm: NFPM_56 });
  const orders = await store.listOrders(agent.id, action.roundNo);
  const others = (await store.listActions(agent.ownerAddress, agent.id))
    .filter((row) => row.actionKey !== action.actionKey)
    .map((row) => ({ actionKey: row.actionKey, state: row.state, txHash: row.txHash, plan: { exits: row.plan.exits } }));
  const evidence = await dcaUnknownEvidence({ reads, pool, wallet: getAddress(agent.walletAddress), plan: action.plan,
    knownTokenIds: new Set(orders.flatMap((row) => row.tokenId === null ? [] : [row.tokenId])), ageMs: Date.now() - action.createdAtMs, others });
  for (const check of evidence.checks) console.log(`[dca-resolve]   ${check.name}: ${check.result}`);
  console.log(`[dca-resolve] verdict=${evidence.verdict} errored=${evidence.errored}`);
  if (!args.apply) return;
  if (evidence.errored) throw new Error("Refusing --apply: an evidence read errored (REVIEW2 condition 3).");
  if (evidence.verdict !== "not-landed" && evidence.verdict !== "superseded") throw new Error(`Refusing --apply: the verdict is ${evidence.verdict}, not not-landed or superseded.`);
  if (evidence.verdict === "superseded") {
    // AUTO-DCA R4.5 (I18): a finished action's verified receipt already exited
    // the same position(s); A provably never landed.
    await journal.resolveUnknown(key, {
      action: "resolveUnknown", at: Date.now(), ownerAddress: agent.ownerAddress,
      observedBlock: evidence.block?.toString(10) ?? "unavailable", serverBlock: evidence.block?.toString(10) ?? null,
      checks: evidence.checks, legs: [],
      logAbsence: { checked: false, detail: "not used: a finished action's verified receipt is the evidence" },
      disposition: "dcaRange superseded: ROLLED_BACK by the operator; a finished action's verified receipt exited the same position(s)",
    });
    await store.setActionState({ ownerAddress: agent.ownerAddress, actionKey: action.actionKey, from: ["unknown"], to: "rolled-back",
      note: "operator: superseded", nowMs: Date.now() });
    console.log("[dca-resolve] applied: journal ROLLED_BACK, action rolled-back.");
    return;
  }
  await journal.resolveUnknown(key, {
    action: "resolveUnknown", at: Date.now(), ownerAddress: agent.ownerAddress,
    observedBlock: evidence.block?.toString(10) ?? "unavailable", serverBlock: evidence.block?.toString(10) ?? null,
    checks: evidence.checks, legs: [],
    logAbsence: { checked: false, detail: "not used: state at the finalized tip is the evidence (condition 3)" },
    disposition: "dcaRange not landed: ROLLED_BACK by the operator on chain-state evidence",
  });
  await store.setActionState({ ownerAddress: agent.ownerAddress, actionKey: action.actionKey, from: ["unknown"], to: "rolled-back",
    note: "operator: not landed", nowMs: Date.now() });
  console.log("[dca-resolve] applied: journal ROLLED_BACK, action rolled-back.");
}

main().catch((error: unknown) => {
  console.error(`dca-resolve failed: ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`);
  process.exitCode = 1;
});
