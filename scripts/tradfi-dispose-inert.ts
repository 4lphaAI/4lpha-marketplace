/**
 * TRADFI-EXPIRY-KEEP-REMOVE §8 (G1) — the operator's half of an inert ambiguous
 * TradFi AI sell: a pending intent whose journal row is a hashless UNKNOWN and
 * whose submitting key (the agent's CURRENT key) is expired at a FINALIZED block.
 *
 *   node --import tsx --env-file-if-exists=.env scripts/tradfi-dispose-inert.ts --agent <id> [--apply]
 *
 * ONE agent per run. It loads the agent's settings and REFUSES anything that is
 * not a TradFi AI agent before it prints anything but the refusal.
 *
 * DRY-RUN (the default) is read-only: every read is its own `set transaction
 * read only` transaction, no store is initialised, no DDL and no migration ever
 * runs. It prints, per pending sell intent, the identity fields, the finalized
 * KeyStore verdict and block (with the block's timestamp against the key's
 * expiry) and the eligibility verdict. `--apply` re-runs the same checks and
 * performs ONLY the guarded `disposeInertSell` CAS for that agent, then the
 * best-effort run row (one scoped insert). NO store is opened, so no boot
 * statement, DDL or migration runs at any point, for an applied or a refused
 * agent alike: a schema without `trade_intents.disposition_evidence` is refused
 * with a message, never altered. It constructs no worker, provider or signer,
 * runs no cycle, and reads or writes nothing of any other agent. It never
 * submits anything.
 */
import { BNB } from "@altananetwork/sdk";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { createKeyStoreReader, readFinalizedSessionRevocation, type FinalizedSessionRevocationVerdict } from "../src/account/keyStoreReader.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { decodeJsonb, encodeJsonbParam } from "../src/store/codec.js";
import type { JournalExternalRef } from "../src/store/journal.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { DISPOSE_INERT_SELL_SQL } from "../src/store/tradeIntents.js";
import { normalizeTradeRunEvents } from "../src/store/tradeRunTrace.js";
import {
  inertDispositionEvidence,
  isInertSubmissionCandidate,
  isInertTradeSubmission,
  type InertIntentFacts,
  type InertJournalFacts,
  type InertSubmissionInput,
} from "../src/trade/inertSubmission.js";
import { isTradfiAiSettings, parseTradeSettings } from "../src/trade/settings.js";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export type ScriptArgs = { readonly agentId: string; readonly apply: boolean };

/** Exactly one `--agent <id>`, optionally `--apply`; anything else is refused. */
export function parseArgs(argv: readonly string[]): ScriptArgs {
  let agentId: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") {
      if (apply) throw new Error("--apply may be given once.");
      apply = true;
    } else if (flag === "--agent") {
      const value = argv[index + 1];
      if (agentId !== undefined) throw new Error("Exactly one --agent is allowed.");
      if (value === undefined || !AGENT_ID.test(value)) throw new Error("--agent needs a valid agent id.");
      agentId = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${flag ?? ""}.`);
  }
  if (agentId === undefined) throw new Error("Usage: tradfi-dispose-inert --agent <id> [--apply]");
  return { agentId, apply };
}

export type ScriptAgent = {
  readonly id: string;
  readonly ownerAddress: Address;
  readonly walletAddress: Address;
  readonly status: string;
  readonly sessionFacts: InertSubmissionInput["agent"]["sessionFacts"];
};

export type ScriptIntent = InertIntentFacts & { readonly decisionId: string; readonly positionId: string; readonly token: Address };

/** Every read the script makes. None of them writes. */
export type InertReads = {
  readAgent(agentId: string): Promise<ScriptAgent | null>;
  readSettingsParams(ownerAddress: Address, agentId: string): Promise<unknown>;
  listPendingSellIntents(ownerAddress: Address, agentId: string): Promise<readonly ScriptIntent[]>;
  readJournal(agentId: string, idempotencyKey: string): Promise<InertJournalFacts | null>;
  readFinalized(input: { readonly wallet: Address; readonly keyId: Hex; readonly publicKey: Hex }): Promise<FinalizedSessionRevocationVerdict>;
};

/** The only writes: the guarded CAS on the selected agent's intent, and its best-effort run row. */
export type InertWrites = {
  dispose(ownerAddress: Address, agentId: string, decisionId: string, evidence: string): Promise<{ readonly changed: boolean }>;
  insertRun(input: { readonly ownerAddress: Address; readonly agentId: string; readonly token: Address }): Promise<void>;
};

export type InertOutcome = { readonly decisionId: string; readonly eligible: boolean; readonly disposed: boolean };

export async function runDisposeInert(input: {
  readonly args: ScriptArgs;
  readonly reads: InertReads;
  /** `null` in a dry-run: there is no write capability at all. */
  readonly writes: InertWrites | null;
  readonly expected: { readonly chainId: number; readonly registry: Address };
  readonly print: (line: string) => void;
}): Promise<readonly InertOutcome[]> {
  const { args, reads, writes, print } = input;
  const agent = await reads.readAgent(args.agentId);
  if (agent === null) throw new Error("No such agent.");
  const settingsParams = await reads.readSettingsParams(agent.ownerAddress, agent.id);
  const parsed = settingsParams === null ? null : parseTradeSettings(settingsParams);
  if (parsed?.ok !== true || !isTradfiAiSettings(parsed.value.effective)) {
    throw new Error("Refused: this agent is not a TradFi AI trade agent. Nothing was read or changed.");
  }
  print(`[dispose-inert] agent=${agent.id} owner=${agent.ownerAddress} status=${agent.status} mode=${args.apply && writes !== null ? "apply" : "dry-run"} expiry=${agent.sessionFacts?.expiry ?? "none"}`);
  const intents = await reads.listPendingSellIntents(agent.ownerAddress, agent.id);
  if (intents.length === 0) print("[dispose-inert] no pending sell intent for this agent.");
  const outcomes: InertOutcome[] = [];
  for (const intent of intents) {
    const journal = await reads.readJournal(agent.id, intent.idempotencyKey);
    const candidate = isInertSubmissionCandidate({ intent, journal });
    print(`[dispose-inert] intent=${intent.decisionId} side=${intent.side} state=${intent.state} txHash=${intent.txHash ?? "none"} scheduleSlot=${intent.scheduleSlot ?? "none"} portfolioSlot=${intent.portfolioSlot ?? "none"} `
      + `journal=${journal === null ? "none" : `${journal.kind}/${journal.state}`} journalHash=${journal?.externalRef.txHash ?? "none"} journalKey=${journal?.externalRef.publicKey ?? "none"} generation=${journal?.externalRef.sessionGeneration ?? 0} s1=${candidate ? "pass" : "fail"}`);
    if (!candidate || journal === null) {
      outcomes.push({ decisionId: intent.decisionId, eligible: false, disposed: false });
      print(`[dispose-inert] intent=${intent.decisionId} eligible=no (identity)`);
      continue;
    }
    const publicKey = journal.externalRef.publicKey!;
    let evidence: FinalizedSessionRevocationVerdict;
    try {
      evidence = await reads.readFinalized({ wallet: agent.walletAddress, keyId: keccak256(publicKey), publicKey });
    } catch {
      evidence = { kind: "unreadable" };
    }
    print(`[dispose-inert] intent=${intent.decisionId} verdict=${evidence.kind}${"observation" in evidence
      ? ` block=${evidence.observation.blockNumber} blockTimeSec=${evidence.observation.blockTimeSec} keyExpirySec=${agent.sessionFacts?.expiry ?? "none"}` : ""}`);
    const check: InertSubmissionInput = { intent, journal, agent, expected: { wallet: agent.walletAddress, chainId: input.expected.chainId, registry: input.expected.registry }, evidence };
    const eligible = isInertTradeSubmission(check);
    print(`[dispose-inert] intent=${intent.decisionId} eligible=${eligible ? "yes" : "no"}`);
    let disposed = false;
    if (eligible && args.apply && writes !== null) {
      disposed = (await writes.dispose(agent.ownerAddress, agent.id, intent.decisionId, inertDispositionEvidence(check))).changed;
      print(`[dispose-inert] intent=${intent.decisionId} ${disposed ? "disposed (rolled-back with evidence); the journal row stays UNKNOWN" : "not changed (already settled or a hash arrived)"}`);
      if (disposed) {
        try { await writes.insertRun({ ownerAddress: agent.ownerAddress, agentId: agent.id, token: intent.token }); }
        catch (error) { print(`[dispose-inert] the run row could not be written (best effort): ${sanitizeMessage(error instanceof Error ? error.message : "unknown error")}`); }
      }
    }
    outcomes.push({ decisionId: intent.decisionId, eligible, disposed });
  }
  return outcomes;
}

/** One read in its own read-only transaction: a write inside it is refused by PostgreSQL itself. */
export async function inReadOnlyTransaction<T>(sql: SqlClient, work: (tx: SqlClient) => Promise<T>): Promise<T> {
  return sql.transaction(async (tx) => {
    await tx.query("set transaction read only");
    return work(tx);
  });
}

type AgentRow = { readonly id: string; readonly owner_address: string; readonly wallet_address: string; readonly status: string; readonly session_facts: unknown };
type IntentRow = { readonly decision_id: string; readonly idempotency_key: string; readonly side: string; readonly state: string; readonly tx_hash: string | null;
  readonly schedule_slot: number | null; readonly portfolio_slot: number | null; readonly position_id: string; readonly token: string };
type JournalRow = { readonly kind: string; readonly state: string; readonly idempotency_key: string; readonly external_ref: unknown };

function sessionFactsOf(value: unknown): ScriptAgent["sessionFacts"] {
  if (value === null || value === undefined) return null;
  const facts = decodeJsonb(value) as { readonly publicKey?: unknown; readonly expiry?: unknown; readonly generation?: unknown };
  if (typeof facts.publicKey !== "string" || typeof facts.expiry !== "number") return null;
  return { publicKey: facts.publicKey as Hex, expiry: facts.expiry, ...(typeof facts.generation === "number" ? { generation: facts.generation } : {}) };
}

/** The script's whole read surface over PostgreSQL: SELECTs only, each in a read-only transaction. */
export function pgInertReads(sql: SqlClient, readFinalized: InertReads["readFinalized"]): InertReads {
  return {
    async readAgent(agentId) {
      const row = (await inReadOnlyTransaction(sql, (tx) => tx.query<AgentRow>(
        "select id, owner_address, wallet_address, status, session_facts from agents where id = $1", [agentId]))).rows[0];
      return row === undefined ? null : { id: row.id, ownerAddress: getAddress(row.owner_address), walletAddress: getAddress(row.wallet_address), status: row.status, sessionFacts: sessionFactsOf(row.session_facts) };
    },
    async readSettingsParams(ownerAddress, agentId) {
      const row = (await inReadOnlyTransaction(sql, (tx) => tx.query<{ readonly params: unknown }>(
        "select params from trade_settings where agent_id = $1 and owner_address = $2", [agentId, ownerAddress.toLowerCase()]))).rows[0];
      return row === undefined ? null : decodeJsonb(row.params);
    },
    async listPendingSellIntents(ownerAddress, agentId) {
      const rows = (await inReadOnlyTransaction(sql, (tx) => tx.query<IntentRow>(
        `select decision_id, idempotency_key, side, state, tx_hash, schedule_slot, portfolio_slot, position_id, token from trade_intents
         where owner_address = $1 and agent_id = $2 and state = 'pending' and side = 'sell' order by created_at asc, decision_id asc`,
        [ownerAddress.toLowerCase(), agentId]))).rows;
      return rows.map((row): ScriptIntent => ({ decisionId: row.decision_id, idempotencyKey: row.idempotency_key as Hex, side: "sell", state: "pending",
        txHash: row.tx_hash as Hex | null, positionId: row.position_id, token: getAddress(row.token),
        ...(row.schedule_slot === null ? {} : { scheduleSlot: row.schedule_slot }), ...(row.portfolio_slot === null ? {} : { portfolioSlot: row.portfolio_slot }) }));
    },
    async readJournal(agentId, idempotencyKey) {
      const row = (await inReadOnlyTransaction(sql, (tx) => tx.query<JournalRow>(
        "select kind, state, idempotency_key, external_ref from execution_journal where idempotency_key = $1 and agent_id = $2", [idempotencyKey, agentId]))).rows[0];
      return row === undefined ? null : { kind: row.kind as InertJournalFacts["kind"], state: row.state as InertJournalFacts["state"],
        idempotencyKey: row.idempotency_key, externalRef: (row.external_ref === null ? {} : decodeJsonb(row.external_ref)) as JournalExternalRef };
    },
    readFinalized,
  };
}

/** A schema this script may NOT create: refuse it, never alter it. */
async function assertMigrated(sql: SqlClient): Promise<void> {
  const row = (await inReadOnlyTransaction(sql, (tx) => tx.query<{ readonly present: number }>(
    `select 1 as present from information_schema.columns
     where table_schema = current_schema() and table_name = 'trade_intents' and column_name = 'disposition_evidence'`))).rows[0];
  if (row === undefined) {
    throw new Error("trade_intents.disposition_evidence does not exist: run the plane once on the merged code (its own boot adds the column), then retry. Nothing was changed.");
  }
}

/**
 * The apply path: NO store is opened, so no boot statement, DDL or migration runs. Exactly two
 * writes exist, both bound to the one selected agent: the plane's guarded CAS text
 * (`DISPOSE_INERT_SELL_SQL`, which repeats the owner and agent scope) and one `trade_runs` insert.
 */
export function pgInertWrites(sql: SqlClient): InertWrites {
  return {
    async dispose(ownerAddress, agentId, decisionId, evidence) {
      await assertMigrated(sql);
      const disposed = await sql.query<{ readonly decision_id: string }>(DISPOSE_INERT_SELL_SQL,
        [decisionId, agentId, ownerAddress.toLowerCase(), evidence, new Date()]);
      return { changed: disposed.rows.length > 0 };
    },
    async insertRun(input) {
      const events = normalizeTradeRunEvents([{ stage: "sell", code: "ambiguous-sell-disposed", token: input.token, elapsedMs: 0,
        reason: sanitizeMessage("Disposed by the operator: the submitting key is expired at a finalized block; this hashless sell can no longer land.").slice(0, 280) }]);
      await sql.query(
        `insert into trade_runs (id, agent_id, owner_address, dry_run, reason, created_at, candidates, refusals, entries, exits, events)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [randomUUID(), input.agentId, input.ownerAddress.toLowerCase(), false, "ambiguous-sell-disposed", new Date(), 0, 0, 0, 0, encodeJsonbParam(events)]);
    },
  };
}

/** The CLI's whole composition over an already-open connection: validate (read-only), then, only with --apply, the two writes. */
export async function runCli(input: {
  readonly args: ScriptArgs;
  readonly sql: SqlClient;
  readonly readFinalized: InertReads["readFinalized"];
  readonly expected: { readonly chainId: number; readonly registry: Address };
  readonly print: (line: string) => void;
}): Promise<readonly InertOutcome[]> {
  return runDisposeInert({ args: input.args, reads: pgInertReads(input.sql, input.readFinalized),
    writes: input.args.apply ? pgInertWrites(input.sql) : null, expected: input.expected, print: input.print });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString === undefined || connectionString === "") throw new Error("DATABASE_URL is required.");
  const keyStore = getAddress(BNB.keyStore);
  const readerNetwork = { chain: BNB.chain, chainId: BNB.chainId, publicRpcUrl: BNB.publicRpcUrl };
  const reader = createKeyStoreReader({ network: readerNetwork, rpcUrls: resolveLpRpcUrls(process.env, readerNetwork), keyStore });
  const sql = await createPgSqlClient(connectionString);
  try {
    await runCli({ args, sql, expected: { chainId: 56, registry: keyStore }, print: (line) => console.log(line),
      readFinalized: (read) => readFinalizedSessionRevocation({ chainId: 56, keyStoreAddress: keyStore, wallet: read.wallet, keyId: read.keyId,
        expectedPublicKey: read.publicKey, observedAtMs: Date.now(), reader }) });
  } finally {
    await sql.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`[dispose-inert] ${sanitizeMessage(error instanceof Error ? error.message : "failed")}`);
    process.exitCode = 1;
  });
}
