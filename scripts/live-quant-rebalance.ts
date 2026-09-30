/** Quant rebalancing diagnostics and explicitly gated file-only rehearsal entry. */
import { BNB } from "@altananetwork/sdk";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createPublicClient, fallback, getAddress, http, keccak256, stringToBytes, toHex, type Hex } from "viem";
import { bsc } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount, publicKeyToAddress } from "viem/accounts";
import { sanitizeMessage } from "../src/core/errors.js";
import {
  parseQuantRebalanceOperatorArgs, runQuantRebalanceOperatorCommand,
  safeQuantRebalanceCliJson, localQuantRebalanceConfigCheck,
  type QuantRebalanceCliRehearsal, type QuantRebalanceOperatorArgs, type QuantRebalanceOperatorPorts,
} from "../src/quant/rebalanceOperatorCli.js";
import {
  QUANT_EXPANDED_CONFIG_PROFILES, QUANT_REBALANCE_CAPABILITY_PROFILES,
  quantExpandedConfigDigest, resolveQuantRebalancingEnabled,
} from "../src/quant/rebalanceConfig.js";
import { rebalanceCanonicalEncode } from "../src/quant/rebalanceCanonical.js";
import { buildQuantWalletCensus } from "../src/quant/rebalanceCensus.js";
import type { QuantRebalanceActionRow, QuantRebalanceCheckRow, QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";
import type { RebalanceBalanceVector } from "../src/quant/rebalanceTypes.js";
import { G2_FINITE_MAX_GAS_PRICE_WEI, REBALANCE_MAX_GAS_PRICE_WEI, REBALANCE_TOKEN_ADDRESSES } from "../src/quant/rebalancePolicy.js";
import { rebalanceTierForProfile } from "../src/quant/rebalancePolicy.js";
import { planRebalanceLeg, valueManagedPortfolio } from "../src/quant/rebalancePortfolio.js";
import { assessFiniteJournalHistory, deriveFiniteCloseoutState, deriveFiniteState,
  finiteIntendedMatchesStage, finiteJournalHistoryValid, planFiniteLeg } from "../src/quant/rebalanceFinite.js";
import { PostgresQuantWalletClaimStore, type QuantWalletClaim } from "../src/store/quantWalletClaims.js";
import { decodeJsonb } from "../src/store/codec.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { createQuantChainReader, type QuantChainReader } from "../src/quant/readers.js";
import { AltanaProvider } from "../src/wallet/altana.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "../src/wallet/abis.js";
import { PostgresQuantRebalanceStore, REBALANCE_ACTION_TERMINAL } from "../src/store/quantRebalance.js";
import { PostgresExecutionJournal, type ExecutionJournal } from "../src/store/journal.js";
import { proveQuantRebalanceNotExecuted, proveQuantRebalanceRetirement } from "../src/quant/rebalanceOperatorProof.js";
import { quantRebalanceJournalProofAllowed } from "../src/quant/rebalanceJournalProof.js";
import { verifyQuantRebalanceActionReceipt, quantRebalanceJournalResolutionEvidence, loadPathPairs } from "./quantRebalanceWorkerDeps.js";
import { assertQuantRebalanceBoot, buildQuantRebalanceWorkerDeps, type RebalanceRevalidationRefusal } from "./quantRebalanceWorkerDeps.js";
import { quantKeypairFromSeed, submitQuantRebalanceAction } from "../src/quant/execute.js";
import { balancesEqual, expectedBalances, reportFiniteEndedJobOnce, runQuantRebalanceWorkerOnce } from "../src/quant/rebalanceWorker.js";
import type { QuantRebalanceWorkerDeps } from "../src/quant/rebalanceWorker.js";
import { claimSelfTestFile, FileQuantTransport, serializeGrantedSession } from "../src/quant/selftest.js";
import { acquireWorkerSingleton } from "../src/deployment/workerSingleton.js";
import { createG2GrantClaim, g2SessionSpec, loadG2FileProfiles, loadG2OwnerKey,
  findG2GrantClaimForFile, markG2GrantUncertain, publishG2GrantedOutput, readG2ReadyFile, readG2GrantClaim, releaseG2PreProviderClaim, closeG2GrantClaim,
  G2_FILE_AGENT_ID, G2_FILE_STRATEGY_ID, G2_FINITE_JOB, G2_PROTECTED_U, g2ProposedFileDigest, g2RiskCap, g2SubmissionVerdict, type G2File, type G2GrantClaim } from "../src/quant/rebalanceSelftest.js";
import type { QuantRebalanceRuntimeConfig } from "../src/quant/rebalanceConfig.js";
import { agentAuthorityFromPrivateKey, ownerAuthorityFromPrivateKey } from "../src/wallet/altana.js";
import { QUANT_ENVELOPE_ALGORITHM } from "../src/quant/envelope.js";
import { parseSessionPlaintext, permissionsDigest } from "../src/quant/admission.js";
import { admitRebalanceSession } from "../src/quant/rebalanceAdmission.js";
import { evaluateReferenceGuard, requiredReferencePath } from "../src/quant/rebalanceRoutes.js";
import type { AgentWalletRef, WalletProvider } from "../src/core/types.js";
import { assertG2PreparedDatabase, canonicalG2File, g2JobForFile, prepareG2Database } from "../src/quant/rebalanceSelftest.js";
import {
  bigint, gridCensusActions, gridCensusJobs, numberOrNull, readGridActions, readGridJobs, readReceiptOwnership,
  tableInventory, textOrNull, withQuantRebalanceCensusSnapshot, type Tables,
} from "../src/quant/rebalanceCensusReaders.js";

// The snapshot wrapper and the shared read-only census readers live in one small module that the
// claim-cutover tool also uses; tests keep importing the wrapper from here.
export { withQuantRebalanceCensusSnapshot };
function bigintJson(value: unknown): unknown { return decodeJsonb(value); }
function digest(value: unknown): `0x${string}` {
  return keccak256(stringToBytes(rebalanceCanonicalEncode(value)));
}

export function selectFreshRebalanceOperatorProof<T extends { readonly evidenceJson: string }>(
  previousEvidenceJson: string, freshProof: T,
): T | null {
  const stable = (raw: string): { readonly block: bigint; readonly hash: string; readonly timestamp: string;
    readonly evidence: string } | null => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      const evidence = { ...parsed as Record<string, unknown> };
      const block = evidence["finalizedBlock"];
      const hash = evidence["finalizedHash"];
      const timestamp = evidence["finalizedTimestampSec"];
      if (typeof block !== "string" || !/^(0|[1-9][0-9]*)$/u.test(block)
        || typeof hash !== "string" || typeof timestamp !== "string"
        || typeof evidence["evidenceDigest"] !== "string") return null;
      delete evidence["finalizedBlock"];
      delete evidence["finalizedHash"];
      delete evidence["finalizedTimestampSec"];
      delete evidence["evidenceDigest"];
      return { block: BigInt(block), hash: hash.toLowerCase(), timestamp,
        evidence: rebalanceCanonicalEncode(evidence) };
    } catch { return null; }
  };
  const previous = stable(previousEvidenceJson); const fresh = stable(freshProof.evidenceJson);
  return previous !== null && fresh !== null && fresh.block >= previous.block
    && (fresh.block !== previous.block || fresh.hash === previous.hash && fresh.timestamp === previous.timestamp)
    && fresh.evidence === previous.evidence ? freshProof : null;
}

type PreviewProof = Readonly<{ evidenceJson: string; finalizedNumber: bigint; finalizedHash: Hex; jobVersion?: number }>;

async function readRebalanceJobs(sql: SqlClient): Promise<readonly Record<string, unknown>[]> {
  const result = await sql.query<Record<string, unknown>>(`/* quantRebalanceCli.rebalanceJobs */ select
    job_id,strategy_id,wallet_address,status,row_version,admitted_at_ms,claim_generation,
    data_json->'allocationWei' as allocation_wei,data_json->'endsAtMs' as ends_at_ms,
    data_json->'sessionExpiresAtMs' as session_expires_at_ms,data_json->'revokedAtMs' as revoked_at_ms,
    (data_json->>'sessionExpirySec') as session_expiry_sec,(data_json->>'holdCode') as hold_code,
    (data_json->>'externalActivity') as external_activity,data_json->'accountingRev' as accounting_rev,
    data_json->'reportedAtMs' as reported_at_ms,data_json->'reportAttempts' as report_attempts,
    data_json->'reportPayloadDigest' as report_payload_digest,
    data_json->'reportResponseStatus' as report_response_status,
    data_json->'reportNotesApplied' as report_notes_applied,
    data_json->'bootstrapComplete' as bootstrap_complete,data_json->'retiredAtMs' as retired_at_ms,managed_json,
    data_json->'costBasis' as cost_basis
    from quant_rebalance_jobs order by lower(wallet_address),job_id`);
  return result.rows;
}

async function readRebalanceActions(sql: SqlClient): Promise<readonly QuantRebalanceActionRow[]> {
  const result = await sql.query<Record<string, unknown>>(`/* quantRebalanceCli.rebalanceActions */ select data_json
    from quant_rebalance_actions order by job_id,created_at_ms,action_id`);
  return result.rows.map((row) => bigintJson(row["data_json"]) as QuantRebalanceActionRow);
}

async function readJournalStates(sql: SqlClient, journalKeys: readonly string[]): Promise<readonly Readonly<{ journalKey: string; state: string }>[]> {
  if (journalKeys.length === 0) return [];
  const result = await sql.query<Record<string, unknown>>(`/* quantRebalanceCli.journalStates */ select idempotency_key,state
    from execution_journal where idempotency_key = any($1::text[]) order by idempotency_key`, [journalKeys]);
  return result.rows.map((row) => ({ journalKey: String(row["idempotency_key"]), state: String(row["state"]) }));
}

async function readRebalanceChecks(sql: SqlClient): Promise<readonly Record<string, unknown>[]> {
  const result = await sql.query<Record<string, unknown>>(`/* quantRebalanceCli.rebalanceChecks */ select
    job_id,check_kind,slot,state,row_version,updated_at_ms,data_json from quant_rebalance_checks order by job_id,check_kind,slot`);
  return result.rows;
}

function parsedCheckEvidence(check: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (check === undefined) return null;
  const decoded = bigintJson(check["data_json"]);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
  const evidenceText = (decoded as Record<string, unknown>)["evidenceJson"];
  if (typeof evidenceText !== "string") return null;
  try {
    const evidence: unknown = JSON.parse(evidenceText);
    return typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
      ? evidence as Record<string, unknown> : null;
  } catch { return null; }
}

function latestCheckEvidence(checks: readonly Record<string, unknown>[], jobId: string): Record<string, unknown> | null {
  const latest = checks.filter((row) => row["job_id"] === jobId)
    .sort((left, right) => (numberOrNull(right["updated_at_ms"]) ?? 0) - (numberOrNull(left["updated_at_ms"]) ?? 0))[0];
  return parsedCheckEvidence(latest);
}

function bootstrapStatusFor(checks: readonly Record<string, unknown>[], jobId: string, complete: boolean): string | null {
  const check = checks.find((row) => row["job_id"] === jobId && row["check_kind"] === "bootstrap");
  const status = parsedCheckEvidence(check)?.["bootstrapStatus"];
  if (status === "bootstrap-partial" || status === "bootstrap-complete") return status;
  return complete ? "bootstrap-complete" : null;
}

function publicJobs(
  gridJobs: readonly Record<string, unknown>[], gridActions: readonly Record<string, unknown>[],
  rebalanceJobs: readonly Record<string, unknown>[], rebalanceActions: readonly QuantRebalanceActionRow[],
  rebalanceChecks: readonly Record<string, unknown>[],
  claims: readonly Readonly<{ wallet: string; mode: string; generation: string; strategyKind: string | null; strategyId: string | null; jobId: string | null }>[],
  journalStates: readonly Readonly<{ journalKey: string; state: string }>[],
): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const claimFor = (wallet: string): Record<string, unknown> => claims.find((row) =>
    row.wallet.toLowerCase() === wallet.toLowerCase()) as unknown as Record<string, unknown> ?? {};
  const journalStateFor = new Map(journalStates.map((row) => [row.journalKey, row.state]));
  const hasVerifiedNotExecutedEvidence = (action: QuantRebalanceActionRow): boolean => {
    if (action.state !== "aborted" || action.resolutionJson === null) return false;
    try {
      const parsed: unknown = JSON.parse(action.resolutionJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      const evidence = parsed as Record<string, unknown>;
      return evidence["v"] === 1 && evidence["kind"] === "not-executed"
        && evidence["actionId"] === action.actionId && evidence["jobId"] === action.jobId
        && evidence["claimGeneration"] === action.claimGeneration.toString(10)
        && typeof evidence["evidenceDigest"] === "string" && /^0x[0-9a-fA-F]{64}$/u.test(evidence["evidenceDigest"]);
    } catch { return false; }
  };
  for (const row of gridJobs) {
    const id = String(row["quant_job_id"]); const wallet = String(row["trading_wallet"]);
    const actions = gridActions.filter((action) => action["quant_job_id"] === id);
    const claim = claimFor(wallet);
    result.push({
      jobId: id, strategyKind: "grid", strategyId: row["strategy_id"], wallet, status: row["status"],
      rowVersion: row["row_version"], admitted: row["admitted_at_ms"] !== null,
      allocationWei: bigint(row["allocation_u_wei"])?.toString(10) ?? null,
      endsAtMs: numberOrNull(row["ends_at_ms"]), sessionExpiresAtMs: numberOrNull(row["session_expires_at_ms"]),
      revokedAtMs: numberOrNull(row["revoked_at_ms"]), holdCode: row["hold_code"],
      claimMode: claim["mode"] ?? null, claimGeneration: bigint(claim["generation"])?.toString(10) ?? textOrNull(claim["generation"]),
      accountingState: row["accounting_state"], accountingRev: bigint(row["accounting_rev"])?.toString(10) ?? null,
      checkStates: [], actionStates: actions.map((action) => action["state"]),
      actionSetDigest: digest(actions.map((action) => ({
        journalKey: action["journal_key"], levelIndex: action["level_index"], actionSeq: action["action_seq"],
        side: action["side"], state: action["state"], amountInWei: bigint(action["amount_in_wei"]),
        minOutWei: bigint(action["min_out_wei"]), quoteOutWei: bigint(action["quote_out_wei"]),
        quoteBlock: bigint(action["quote_block"]), deadlineSec: action["deadline_sec"],
        callsDigest: digest(String(action["calls_json"] ?? "")), txHash: action["tx_hash"],
        fillInWei: bigint(action["fill_in_wei"]), fillOutWei: bigint(action["fill_out_wei"]), rowVersion: action["row_version"],
      }))), reportStatus: row["reported_at_ms"] === null ? "not-applicable" : "reported",
      managedBalances: { USDC: null, WBNB: null, ETH: null, CAKE: null }, bootstrapStatus: null,
      reportAttempts: 0, reportPayloadDigest: null, reportResponseStatus: null, reportNotesApplied: null,
      retainedClaimReason: null, retainedClaimRemedy: null,
    });
  }
  for (const row of rebalanceJobs) {
    const id = String(row["job_id"]); const wallet = String(row["wallet_address"]);
    const actions = rebalanceActions.filter((action) => action.jobId === id);
    const claim = claimFor(wallet);
    const managed = bigintJson(row["managed_json"]);
    const managedValues = typeof managed === "object" && managed !== null && !Array.isArray(managed)
      ? managed as Record<string, unknown> : {};
    const checkEvidence = latestCheckEvidence(rebalanceChecks, id);
    const marked = checkEvidence?.["markedValues"];
    const markedValues = typeof marked === "object" && marked !== null && !Array.isArray(marked)
      ? marked as Record<string, unknown> : {};
    const markedSum = ["USDC", "WBNB", "ETH", "CAKE"].map((asset) => bigint(markedValues[asset]));
    const bootstrapStatus = bootstrapStatusFor(rebalanceChecks, id, row["bootstrap_complete"] === true);
    const failedAssetsRaw = checkEvidence?.["failedAssets"];
    const failedAssets = Array.isArray(failedAssetsRaw) ? failedAssetsRaw.filter((asset) => ["WBNB", "ETH", "CAKE"].includes(String(asset))) : [];
    const unresolvedAction = actions.find((action) => !["settled", "failed", "aborted"].includes(action.state));
    const retainedClaim = claim["mode"] === "active" && claim["strategyKind"] === "rebalance"
      && claim["strategyId"] === String(row["strategy_id"]) && claim["jobId"] === id
      && actions.some((action) => journalStateFor.get(action.journalKey) === "UNKNOWN" && hasVerifiedNotExecutedEvidence(action));
    const realizedUsdc = actions.reduce((sum, action) => sum + (typeof action.realizedDeltaUsdcWei === "bigint" ? action.realizedDeltaUsdcWei : 0n), 0n);
    result.push({
      jobId: id, strategyKind: "rebalance", strategyId: row["strategy_id"], wallet, status: row["status"],
      rowVersion: row["row_version"], admitted: row["admitted_at_ms"] !== null,
      allocationWei: bigint(row["allocation_wei"])?.toString(10) ?? null,
      endsAtMs: numberOrNull(row["ends_at_ms"]), sessionExpiresAtMs: numberOrNull(row["session_expires_at_ms"]),
      revokedAtMs: numberOrNull(row["revoked_at_ms"]), holdCode: row["hold_code"],
      claimMode: claim["mode"] ?? null, claimGeneration: bigint(row["claim_generation"] ?? claim["generation"])?.toString(10)
        ?? textOrNull(row["claim_generation"] ?? claim["generation"]),
      accountingState: row["external_activity"] === "true" ? "external-activity" : "verified",
      accountingRev: bigint(row["accounting_rev"])?.toString(10) ?? null,
      checkStates: rebalanceChecks.filter((check) => check["job_id"] === id).map((check) => check["state"]),
      actionStates: actions.map((action) => action.state),
      actionSetDigest: digest(actions.map((action) => ({ actionId: action.actionId, checkId: action.checkId,
        sequence: action.sequence, state: action.state, side: action.side, asset: action.asset,
        tokenIn: action.tokenIn.toLowerCase(), tokenOut: action.tokenOut.toLowerCase(),
        path: action.path.map((token) => token.toLowerCase()), pairAddresses: action.pairAddresses.map((address) => address.toLowerCase()),
        amountInWei: action.amountInWei, minOutWei: action.minOutWei, quoteOutWei: action.quoteOutWei,
        deadlineSec: action.deadlineSec, callsDigest: action.callsDigest, txHash: action.txHash,
        fillInWei: action.fillInWei, fillOutWei: action.fillOutWei, proofDigest: action.proofDigest, rowVersion: action.rowVersion,
      }))),
      reportStatus: row["reported_at_ms"] !== null ? "reported"
        : (numberOrNull(row["report_attempts"]) ?? 0) >= 24 ? "exhausted"
          : (numberOrNull(row["report_attempts"]) ?? 0) > 0 ? "unavailable"
            : row["status"] === "ended" ? "pending" : "not-applicable",
      managedBalances: (() => {
        const managed = bigintJson(row["managed_json"]);
        const values = typeof managed === "object" && managed !== null && !Array.isArray(managed)
          ? managed as Record<string, unknown> : {};
        return { USDC: bigint(values["USDC"])?.toString(10) ?? null,
          WBNB: bigint(values["WBNB"])?.toString(10) ?? null,
          ETH: bigint(values["ETH"])?.toString(10) ?? null,
          CAKE: bigint(values["CAKE"])?.toString(10) ?? null };
      })(),
      bootstrapStatus: bootstrapStatusFor(rebalanceChecks, id, row["bootstrap_complete"] === true),
      reportAttempts: numberOrNull(row["report_attempts"]) ?? 0,
      reportPayloadDigest: textOrNull(row["report_payload_digest"]),
      reportResponseStatus: numberOrNull(row["report_response_status"]),
      reportNotesApplied: numberOrNull(row["report_notes_applied"]),
      realizedUsdcWei: realizedUsdc.toString(10),
      markedValues: { USDC: bigint(markedValues["USDC"])?.toString(10) ?? null,
        WBNB: bigint(markedValues["WBNB"])?.toString(10) ?? null, ETH: bigint(markedValues["ETH"])?.toString(10) ?? null,
        CAKE: bigint(markedValues["CAKE"])?.toString(10) ?? null },
      markedPortfolioUsdcWei: markedSum.every((value) => value !== null)
        ? markedSum.reduce((sum, value) => sum + (value ?? 0n), 0n).toString(10) : null,
      residualUsdcWei: bigint(managedValues["USDC"])?.toString(10) ?? null,
      markBlock: bigint(checkEvidence?.["block"])?.toString(10) ?? null,
      markHash: textOrNull(checkEvidence?.["hash"]),
      partialReason: bootstrapStatus === "bootstrap-partial"
        ? failedAssets.length > 0 ? "submitted-leg-failed" : "residual-holdings" : null,
      unresolvedReason: unresolvedAction === undefined ? null
        : unresolvedAction.ambiguousCause ?? (unresolvedAction.state === "needs-operator" ? "operator-review" : "action-unresolved"),
      retiredAtMs: numberOrNull(row["retired_at_ms"]),
      retainedClaimReason: retainedClaim ? "not-executed-journal-unknown" : null,
      retainedClaimRemedy: retainedClaim ? "use-separate-wallet-for-next-job" : null,
      actionDetails: actions.map((action) => ({ actionId: action.actionId, side: action.side, asset: action.asset,
        state: action.state, amountInWei: action.amountInWei.toString(10), fillInWei: action.fillInWei?.toString(10) ?? null,
        fillOutWei: action.fillOutWei?.toString(10) ?? null,
        realizedDeltaUsdcWei: action.realizedDeltaUsdcWei?.toString(10) ?? null,
        txHash: action.txHash, proofDigest: action.proofDigest,
        receiptBlockNumber: action.receiptBlockNumber?.toString(10) ?? null,
        receiptBlockHash: action.receiptBlockHash, failureCode: action.failureCode, ambiguousCause: action.ambiguousCause })),
    });
  }
  return result;
}

export type QuantRebalanceCliOperatorTestSeam = Readonly<{
  /** Offline test-only readers; the process CLI never accepts or constructs this seam. */
  reader: QuantChainReader;
  provider: WalletProvider;
  publicClient: ReturnType<typeof createPublicClient>;
}>;

export async function createQuantRebalanceCliPorts(
  env: NodeJS.ProcessEnv, needsDatabase: boolean, operatorTestSeam?: QuantRebalanceCliOperatorTestSeam,
  verifiedSql?: SqlClient,
): Promise<QuantRebalanceOperatorPorts> {
  const databaseUrl = env["DATABASE_URL"]?.trim() ?? "";
  let sql: SqlClient | null = null;
  let inventory: Tables | null = null;
  let gridJobs: readonly Record<string, unknown>[] = [];
  let gridActions: readonly Record<string, unknown>[] = [];
  let rebalanceJobs: readonly Record<string, unknown>[] = [];
  let rebalanceChecks: readonly Record<string, unknown>[] = [];
  let rebalanceActions: readonly QuantRebalanceActionRow[] = [];
  let journalStates: readonly Readonly<{ journalKey: string; state: string }>[] = [];
  let claimRows: readonly Readonly<{ wallet: string; mode: string; generation: string; strategyKind: string | null; strategyId: string | null; jobId: string | null }>[] = [];
  let migrationInstalled = false;
  if (needsDatabase && databaseUrl !== "") {
    try {
      sql = verifiedSql ?? await createPgSqlClient(databaseUrl);
      inventory = await tableInventory(sql);
      if (inventory.gridJobs) gridJobs = await readGridJobs(sql);
      if (inventory.gridActions) gridActions = await readGridActions(sql);
      if (inventory.rebalanceJobs) rebalanceJobs = await readRebalanceJobs(sql);
      if (inventory.rebalanceChecks) rebalanceChecks = await readRebalanceChecks(sql);
      if (inventory.rebalanceActions) rebalanceActions = await readRebalanceActions(sql);
      if (inventory.journal) journalStates = await readJournalStates(sql, rebalanceActions.map((action) => action.journalKey));
      if (inventory.claims) {
        const claims = new PostgresQuantWalletClaimStore(sql);
        claimRows = (await claims.list()).map((claim: QuantWalletClaim) => ({
          wallet: claim.wallet, mode: claim.mode, generation: claim.generation.toString(10),
          strategyKind: claim.strategyKind, strategyId: claim.strategyId, jobId: claim.jobId,
        }));
        migrationInstalled = inventory.claimMigration && await claims.migrationInstalled();
      }
    } catch {
      if (verifiedSql === undefined) await sql?.close().catch(() => undefined);
      sql = null; inventory = null; gridJobs = []; gridActions = []; rebalanceJobs = [];
      rebalanceJobs = []; rebalanceChecks = []; rebalanceActions = []; journalStates = []; claimRows = []; migrationInstalled = false;
    }
  }
  const schemaReady = databaseUrl !== "" && inventory !== null
    && inventory.gridJobs && inventory.gridActions && inventory.rebalanceJobs
    && inventory.rebalanceChecks && inventory.rebalanceActions && inventory.claims
    && inventory.claimMigration && inventory.receiptOwnership && inventory.journal && migrationInstalled;
  const jobs = publicJobs(gridJobs, gridActions, rebalanceJobs, rebalanceActions, rebalanceChecks, claimRows, journalStates);
  let finished = false;
  const finish = async () => { if (finished) return; finished = true; if (verifiedSql === undefined) await sql?.close(); };
  async function operatorContext(): Promise<{
    readonly store: PostgresQuantRebalanceStore; readonly claims: PostgresQuantWalletClaimStore;
    readonly journal: ExecutionJournal; readonly reader: QuantChainReader; readonly provider: WalletProvider;
    readonly publicClient: ReturnType<typeof createPublicClient>;
  } | null> {
    if (!schemaReady || sql === null || !migrationInstalled) return null;
    try {
      const rpcUrls = [...new Set([env["QUANT_RPC_URL"]?.trim() ?? "", BNB.publicRpcUrl].filter(Boolean))];
      if (rpcUrls.length === 0 || rpcUrls.some((url) => !url.startsWith("https://"))) return null;
      const store = new PostgresQuantRebalanceStore(sql);
      if (!(await store.schemaReady())) return null;
      const claims = new PostgresQuantWalletClaimStore(sql);
      if (!(await claims.migrationInstalled())) return null;
      const journal = await PostgresExecutionJournal.attachExisting(sql);
      const reader = operatorTestSeam?.reader ?? createQuantChainReader({ rpcUrls });
      const provider = operatorTestSeam?.provider ?? new AltanaProvider({ network: BNB, rpcUrls });
      const publicClient = operatorTestSeam?.publicClient ?? createPublicClient({ chain: bsc, transport: fallback(rpcUrls.map((url) => http(url))) });
      if (await reader.chainId() !== 56) return null;
      return { store, claims, journal, reader, provider, publicClient };
    } catch { return null; }
  }

  async function readKeyValidity(context: NonNullable<Awaited<ReturnType<typeof operatorContext>>>, job: QuantRebalanceJobRow, blockNumber: bigint): Promise<boolean | null> {
    if (job.sessionPublicKey === null) return null;
    try {
      const keyHash = keccak256(job.sessionPublicKey);
      return await context.publicClient.readContract({ address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI,
        functionName: "isValidKey", args: [job.tradingWallet, keyHash], blockNumber });
    } catch { return null; }
  }

  async function resolveProof(input: Extract<QuantRebalanceOperatorArgs, { readonly command: "resolve" }>,
    previous?: PreviewProof): Promise<QuantRebalanceCliRehearsal> {
    const context = await operatorContext();
    if (context === null) return { ok: false, code: schemaReady ? "operator-read-unavailable" : "migration-not-installed",
      evidence: { code: schemaReady ? "operator-read-unavailable" : "migration-not-installed" }, async apply() { return {}; } };
    const action = await context.store.getAction(input.actionId);
    if (action === null) return { ok: false, code: "action-not-found", evidence: { actionId: input.actionId, code: "action-not-found" }, async apply() { return {}; } };
    const job = await context.store.getJob(action.jobId);
    const journal = await context.journal.get(action.journalKey);
    if (job === null || journal === null) return { ok: false, code: "journal-or-job-missing", evidence: { actionId: action.actionId,
      jobId: action.jobId, actionState: action.state, code: "journal-or-job-missing" }, async apply() { return {}; } };
    if (!["submitted", "unknown", "committed-unverified"].includes(action.state)) return { ok: false,
      code: "action-state-ineligible", evidence: { actionId: action.actionId, jobId: job.jobId,
        actionState: action.state, journalState: journal.state, claimGeneration: job.claimGeneration, code: "action-state-ineligible" }, async apply() { return {}; } };
    if (input.proofMode === "not-executed" && journal.state !== "UNKNOWN") {
      return { ok: false, code: "journal-state-ineligible", evidence: { actionId: action.actionId, jobId: job.jobId,
        actionState: action.state, journalState: journal.state, claimGeneration: job.claimGeneration, code: "journal-state-ineligible" }, async apply() { return {}; } };
    }
    if (job.claimGeneration === null || !(await context.claims.isActive({ wallet: job.tradingWallet, strategyKind: "rebalance",
      strategyId: job.strategyId, jobId: job.jobId, generation: job.claimGeneration }))) return { ok: false, code: "claim-missing",
      evidence: { actionId: action.actionId, jobId: job.jobId, actionState: action.state, journalState: journal.state, code: "claim-missing" }, async apply() { return {}; } };

    if (input.proofMode === "not-executed") {
      const actions = await context.store.listActions(job.jobId);
      const walletJobs = await sql!.query<Record<string, unknown>>(`/* quantRebalanceCli.sharedWalletJobCount */ select
        ((select count(*) from quant_jobs where lower(trading_wallet)=lower($1)) +
         (select count(*) from quant_rebalance_jobs where lower(wallet_address)=lower($1)))::int as count`, [job.tradingWallet]);
      const finalized = await context.reader.finalizedBlock();
      const finalizedCanonical = await context.reader.blockAt(finalized.number);
      const baselineBlock = job.baselineBlock === null ? null : await context.reader.blockAt(job.baselineBlock);
      const submitBlock = action.preSubmitBlockNumber === null ? null : await context.reader.blockAt(action.preSubmitBlockNumber);
      const canonicalIds = new Set<string>();
      for (const settled of actions.filter((item) => item.state === "settled")) {
        if (settled.receiptBlockNumber === null || settled.receiptBlockHash === null) continue;
        const block = await context.reader.blockAt(settled.receiptBlockNumber);
        if (block.hash.toLowerCase() === settled.receiptBlockHash.toLowerCase()) canonicalIds.add(settled.actionId);
      }
      if (context.reader.tokenBalanceAtHash === undefined || finalizedCanonical.hash.toLowerCase() !== finalized.hash.toLowerCase()) {
        return { ok: false, code: "hash-pinned-balance-reader-unavailable", evidence: { actionId: action.actionId,
          jobId: job.jobId, blockNumber: finalized.number, blockHash: finalized.hash, code: "hash-pinned-balance-reader-unavailable" }, async apply() { return {}; } };
      }
      const assets = ["USDC", "WBNB", "ETH", "CAKE", "USDT"] as const;
      const balances = await Promise.all(assets.map((asset) => context.reader.tokenBalanceAtHash!(REBALANCE_TOKEN_ADDRESSES[asset], job.tradingWallet, finalized.hash)));
      const actual = Object.fromEntries(assets.map((asset, index) => [asset, balances[index] ?? 0n])) as unknown as RebalanceBalanceVector;
      const proof = proveQuantRebalanceNotExecuted({ job, action, allActions: actions, journalState: journal.state,
        journalHasCallsId: journal.externalRef.callsId !== undefined, sharedWalletJobs: Number(walletJobs.rows[0]?.["count"] ?? 0),
        finalized, baselineBlockHash: baselineBlock?.hash ?? null, submitBlockHash: submitBlock?.hash ?? null,
        canonicalReceiptActionIds: canonicalIds, actual });
      if (!proof.ok) return { ok: false, code: proof.code, evidence: { actionId: action.actionId, jobId: job.jobId,
        journalState: journal.state, actionState: action.state, claimGeneration: job.claimGeneration,
        blockNumber: finalized.number, blockHash: finalized.hash, code: proof.code, vectorDigest: digest(actual) }, async apply() { return {}; } };
      const evidence = { actionId: action.actionId, jobId: job.jobId, journalState: journal.state, actionState: action.state,
        claimGeneration: job.claimGeneration, blockNumber: finalized.number, blockHash: finalized.hash,
        proofDigest: proof.proof.evidenceDigest, vectorDigest: digest(actual), code: "proof-ready" };
      return { ok: true, code: "proof-ready", evidence, async apply() {
        if (previous === undefined) {
          const fresh = await resolveProof({ ...input, yesLive: false }, { evidenceJson: proof.proof.evidenceJson,
            finalizedNumber: finalized.number, finalizedHash: finalized.hash });
          if (!fresh.ok) throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
          return fresh.apply();
        }
        const previewBlock = await context.reader.blockAt(previous.finalizedNumber);
        if (previewBlock.number !== previous.finalizedNumber
          || previewBlock.hash.toLowerCase() !== previous.finalizedHash.toLowerCase()) {
          throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
        }
        const freshProof = selectFreshRebalanceOperatorProof(previous.evidenceJson, proof.proof);
        if (freshProof === null) throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
        const latestAction = await context.store.getAction(action.actionId); const latestJob = await context.store.getJob(job.jobId);
        const latestCheck = latestAction === null ? undefined : (await context.store.listChecks(job.jobId)).find((row) => row.checkId === latestAction.checkId);
        const latestJournal = await context.journal.get(action.journalKey);
        if (latestAction === null || latestJob === null || latestCheck === undefined || latestJournal?.state !== "UNKNOWN") throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
        const applied = await context.store.resolveNotExecuted({ actionId: latestAction.actionId,
          expectedActionVersion: latestAction.rowVersion, expectedJobVersion: latestJob.rowVersion,
          expectedCheckVersion: latestCheck.rowVersion, proof: freshProof, nowMs: Date.now() });
        if (applied.kind !== "ok") throw Object.assign(new Error(applied.kind === "inconsistent" ? applied.code : "proof-stale"), { code: applied.kind === "inconsistent" ? applied.code : "proof-stale" });
        return { ...evidence, actionState: "aborted" };
      } };
    }

    let txHash: Hex | null = null;
    if (input.proofMode === "tx") txHash = input.txHash ?? null;
    else {
      const callsId = journal.externalRef.callsId;
      if (callsId === undefined || context.provider.readExecutionStatus === undefined) return { ok: false,
        code: "calls-id-unavailable", evidence: { actionId: action.actionId, jobId: job.jobId, journalState: journal.state,
          actionState: action.state, code: "calls-id-unavailable" }, async apply() { return {}; } };
      try { txHash = (await context.provider.readExecutionStatus({ callsId })).receipt.transactionHash ?? null; } catch { txHash = null; }
      if (txHash === null) return { ok: false, code: "receipt-pending-or-unavailable", evidence: { actionId: action.actionId,
        jobId: job.jobId, journalState: journal.state, actionState: action.state,
        claimGeneration: job.claimGeneration, code: "receipt-pending-or-unavailable" }, async apply() { return {}; } };
    }
    if (txHash === null || action.txHash !== null && action.txHash.toLowerCase() !== txHash.toLowerCase()
      || journal.externalRef.txHash !== undefined && journal.externalRef.txHash.toLowerCase() !== txHash.toLowerCase()) {
      return { ok: false, code: "transaction-hash-conflict", evidence: { actionId: action.actionId, jobId: job.jobId,
        txHash, journalState: journal.state, actionState: action.state, claimGeneration: job.claimGeneration, code: "transaction-hash-conflict" }, async apply() { return {}; } };
    }
    const verified = await verifyQuantRebalanceActionReceipt({ reader: context.reader, action, job, txHash });
    if (verified === null || verified.receipt === null && verified.failure === null) return { ok: false,
      code: "receipt-proof-refused", evidence: { actionId: action.actionId, jobId: job.jobId, txHash,
        journalState: journal.state, actionState: action.state, claimGeneration: job.claimGeneration, code: "receipt-proof-refused" }, async apply() { return {}; } };
    const proofKind = verified.failure === null ? "success" : "failure";
    const matchedStoredTx = journal.externalRef.txHash?.toLowerCase() === txHash.toLowerCase();
    const storedTxPresent = journal.externalRef.txHash !== undefined;
    if (!quantRebalanceJournalProofAllowed({ journalState: journal.state, proof: proofKind, proofSource: input.proofMode,
      matchedStoredTransaction: matchedStoredTx, storedTransactionPresent: storedTxPresent })) return { ok: false,
      code: "journal-proof-conflict", evidence: { actionId: action.actionId, jobId: job.jobId, txHash,
        journalState: journal.state, actionState: action.state, claimGeneration: job.claimGeneration, code: "journal-proof-conflict" }, async apply() { return {}; } };
    const receiptProof = verified.receipt;
    const proofDigest = receiptProof?.proofDigest ?? verified.failure!.failureDigest;
    const evidence = { actionId: action.actionId, jobId: job.jobId, txHash,
      proofDigest, blockNumber: receiptProof?.blockNumber ?? verified.failure!.blockNumber,
      blockHash: receiptProof?.blockHash ?? verified.failure!.blockHash, journalState: journal.state,
      actionState: action.state, claimGeneration: job.claimGeneration, code: "proof-ready" };
    return { ok: true, code: "proof-ready", evidence, async apply() {
      const fresh = await resolveProof({ ...input, yesLive: false });
      const freshEvidence = fresh.evidence as Record<string, unknown>;
      if (!fresh.ok || freshEvidence["proofDigest"] !== evidence.proofDigest || freshEvidence["txHash"] !== evidence.txHash) {
        throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
      }
      const latestAction = await context.store.getAction(action.actionId); const latestJournal = await context.journal.get(action.journalKey);
      if (latestAction === null || latestJournal === null || latestAction.rowVersion !== action.rowVersion || latestJournal.state !== journal.state) {
        throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
      }
      const freshProof = await verifyQuantRebalanceActionReceipt({ reader: context.reader, action: latestAction, job, txHash: evidence.txHash as Hex });
      if (freshProof === null || freshProof.receipt === null && freshProof.failure === null) throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
      const block = freshProof.receipt?.blockNumber ?? freshProof.failure!.blockNumber;
      const resolution = quantRebalanceJournalResolutionEvidence(job, latestAction, block, Date.now());
      if (freshProof.receipt !== null) {
        if (latestJournal.state === "UNKNOWN") await context.journal.advanceUnknown(latestAction.journalKey, resolution, { txHash: freshProof.receipt.txHash });
        else if (latestJournal.state === "PENDING") await context.journal.markInProgress(latestAction.journalKey, { txHash: freshProof.receipt.txHash });
        if (latestJournal.state === "PENDING" || latestJournal.state === "IN_PROGRESS") await context.journal.markCommitted(latestAction.journalKey, { txHash: freshProof.receipt.txHash });
        else if (latestJournal.state === "COMMITTED" && latestJournal.externalRef.txHash === undefined) await context.journal.markCommitted(latestAction.journalKey, { txHash: freshProof.receipt.txHash });
        const settled = await context.store.settleAction({ actionId: latestAction.actionId, expectedRowVersion: latestAction.rowVersion,
          proof: freshProof.receipt, ownership: freshProof.ownership, nowMs: Date.now() });
        if (settled.kind !== "ok") throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
        return { ...evidence, actionState: "settled" };
      }
      if (latestJournal.state === "UNKNOWN") {
        await context.journal.resolveUnknown(latestAction.journalKey, resolution, { txHash: freshProof.failure!.txHash });
      } else if (latestJournal.state === "PENDING" || latestJournal.state === "IN_PROGRESS") {
        await context.journal.markRolledBack(latestAction.journalKey, "Quant rebalancing receipt proof verified failure.", { txHash: freshProof.failure!.txHash });
      } else if ((latestJournal.state === "ROLLED_BACK" || latestJournal.state === "COMMITTED")
        && latestJournal.externalRef.txHash?.toLowerCase() === freshProof.failure!.txHash.toLowerCase()) {
        // Preserve the journal's landed/rolled-back transaction fact; the action
        // changes only after the inner failure proof has been independently matched.
      } else if (latestJournal.state === "COMMITTED" && latestJournal.externalRef.txHash === undefined) {
        await context.journal.markCommitted(latestAction.journalKey, { txHash: freshProof.failure!.txHash });
      } else throw Object.assign(new Error("journal-state-conflict"), { code: "journal-state-conflict" });
      const failed = await context.store.failAction({ actionId: latestAction.actionId, expectedRowVersion: latestAction.rowVersion,
        evidence: { kind: "submitted-failure", proof: freshProof.failure! }, nowMs: Date.now() });
      if (failed.kind !== "ok") throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
      return { ...evidence, actionState: "failed" };
    } };
  }

  async function retirementProof(jobId: string, previous?: PreviewProof): Promise<QuantRebalanceCliRehearsal> {
    const context = await operatorContext();
    if (context === null) return { ok: false, code: schemaReady ? "operator-read-unavailable" : "migration-not-installed",
      evidence: { code: schemaReady ? "operator-read-unavailable" : "migration-not-installed" }, async apply() { return {}; } };
    const job = await context.store.getJob(jobId);
    if (job === null) return { ok: false, code: "job-not-found", evidence: { jobId, code: "job-not-found" }, async apply() { return {}; } };
    if (job.claimGeneration === null || !(await context.claims.isActive({ wallet: job.tradingWallet, strategyKind: "rebalance",
      strategyId: job.strategyId, jobId: job.jobId, generation: job.claimGeneration }))) return { ok: false,
      code: "claim-missing", evidence: { jobId, code: "claim-missing" }, async apply() { return {}; } };
    const [actions, finalized] = await Promise.all([context.store.listActions(jobId), context.reader.finalizedBlock()]);
    const finalizedCanonical = await context.reader.blockAt(finalized.number);
    if (context.reader.tokenBalanceAtHash === undefined || finalizedCanonical.hash.toLowerCase() !== finalized.hash.toLowerCase()) return { ok: false,
      code: "hash-pinned-balance-reader-unavailable", evidence: { jobId, blockNumber: finalized.number, blockHash: finalized.hash,
        code: "hash-pinned-balance-reader-unavailable" }, async apply() { return {}; } };
    const keyValid = await readKeyValidity(context, job, finalized.number);
    if (keyValid === null) return { ok: false, code: "key-state-unavailable", evidence: { jobId,
      blockNumber: finalized.number, blockHash: finalized.hash, code: "key-state-unavailable" }, async apply() { return {}; } };
    const canonicalAfterKeyRead = await context.reader.blockAt(finalized.number);
    if (canonicalAfterKeyRead.hash.toLowerCase() !== finalized.hash.toLowerCase()) return { ok: false,
      code: "key-state-snapshot-changed", evidence: { jobId, blockNumber: finalized.number,
        blockHash: finalized.hash, code: "key-state-snapshot-changed" }, async apply() { return {}; } };
    const assets = ["USDC", "WBNB", "ETH", "CAKE", "USDT"] as const;
    const balances = await Promise.all(assets.map((asset) => context.reader.tokenBalanceAtHash!(REBALANCE_TOKEN_ADDRESSES[asset], job.tradingWallet, finalized.hash)));
    const actual = Object.fromEntries(assets.map((asset, index) => [asset, balances[index] ?? 0n])) as unknown as RebalanceBalanceVector;
    const proof = proveQuantRebalanceRetirement({ job, actions, keyValid, finalized, actual });
    if (!proof.ok) return { ok: false, code: proof.code, evidence: { jobId,
      actionState: actions.find((action) => !["settled", "failed", "aborted"].includes(action.state))?.state ?? null,
      blockNumber: finalized.number, blockHash: finalized.hash, keyDead: !keyValid,
      deadlinePassed: proof.code !== "deadline-not-passed", vectorDigest: digest(actual), code: proof.code }, async apply() { return {}; } };
    const evidence = { actionId: actions.find((action) => !["settled", "failed", "aborted"].includes(action.state))?.actionId ?? null,
      jobId, proofDigest: proof.proof.evidenceDigest, blockNumber: finalized.number, blockHash: finalized.hash,
      actionState: actions.find((action) => !["settled", "failed", "aborted"].includes(action.state))?.state ?? null,
      claimGeneration: job.claimGeneration, keyDead: true, deadlinePassed: true, vectorDigest: digest(actual), code: "proof-ready" };
    return { ok: true, code: "proof-ready", evidence, async apply() {
      if (previous === undefined) {
        const fresh = await retirementProof(jobId, { evidenceJson: proof.proof.evidenceJson,
          finalizedNumber: finalized.number, finalizedHash: finalized.hash, jobVersion: job.rowVersion });
        if (!fresh.ok) throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
        return fresh.apply();
      }
      const previewBlock = await context.reader.blockAt(previous.finalizedNumber);
      if (previewBlock.number !== previous.finalizedNumber
        || previewBlock.hash.toLowerCase() !== previous.finalizedHash.toLowerCase()) {
        throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
      }
      const freshProof = selectFreshRebalanceOperatorProof(previous.evidenceJson, proof.proof);
      if (freshProof === null) throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
      const latest = await context.store.getJob(jobId);
      if (latest === null || previous.jobVersion === undefined || latest.rowVersion !== previous.jobVersion) {
        throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
      }
      const retired = await context.store.retireJob({ jobId, expectedRowVersion: latest.rowVersion, proof: freshProof, nowMs: Date.now() });
      if (retired.kind !== "ok") throw Object.assign(new Error(retired.kind === "inconsistent" ? retired.code : "proof-stale"), { code: retired.kind === "inconsistent" ? retired.code : "proof-stale" });
      if (retired.record.status === "ended") await context.claims.releaseTerminal({ wallet: retired.record.tradingWallet,
        strategyKind: "rebalance", strategyId: retired.record.strategyId, jobId,
        generation: retired.record.claimGeneration ?? 0n, nowMs: Date.now() });
      return { ...evidence, actionState: retired.record.status === "ended-unresolved" ? evidence.actionState : "retired" };
    } };
  }
  return {
    async close() { await finish(); },
    async status(jobId) {
      const selected = jobId === null ? jobs : jobs.filter((job) => job["jobId"] === jobId);
      const data = { schema: schemaReady ? "ready" : "migration-not-installed", jobs: selected,
        code: databaseUrl === "" ? "database-unavailable" : schemaReady ? null : "migration-not-installed" };
      await finish(); return data;
    },
    async configCheck() {
      let enabled = false; let flagValid = true;
      try { enabled = resolveQuantRebalancingEnabled(env); } catch { flagValid = false; }
      const result = localQuantRebalanceConfigCheck({ chainId: BNB.chainId, enabled, flagValid,
        configProfileCount: QUANT_EXPANDED_CONFIG_PROFILES.length,
        capabilityProfileCount: QUANT_REBALANCE_CAPABILITY_PROFILES.length });
      await finish(); return result;
    },
    async walletCensus() {
      if (sql === null) {
        await finish(); return { schema: "migration-not-installed", migrationInstalled: false, digest: null, groups: [], code: "migration-not-installed" };
      }
      try {
        const consistent = await withQuantRebalanceCensusSnapshot(sql, async (tx) => {
          const currentInventory = await tableInventory(tx);
          const currentGridJobs = currentInventory.gridJobs ? await readGridJobs(tx) : [];
          const currentGridActions = currentInventory.gridActions ? await readGridActions(tx) : [];
          const currentRebalanceJobs = currentInventory.rebalanceJobs ? await readRebalanceJobs(tx) : [];
          const currentRebalanceChecks = currentInventory.rebalanceChecks ? await readRebalanceChecks(tx) : [];
          const currentRebalanceActions = currentInventory.rebalanceActions ? await readRebalanceActions(tx) : [];
          const currentOwnership = currentInventory.receiptOwnership ? await readReceiptOwnership(tx) : [];
          let currentClaims: readonly QuantWalletClaim[] = [];
          let currentMigrationInstalled = false;
          if (currentInventory.claims) {
            const claimStore = new PostgresQuantWalletClaimStore(tx);
            currentClaims = await claimStore.list();
            currentMigrationInstalled = currentInventory.claimMigration && await claimStore.migrationInstalled();
          }
          return { inventory: currentInventory, gridJobs: currentGridJobs, gridActions: currentGridActions,
            rebalanceJobs: currentRebalanceJobs, rebalanceChecks: currentRebalanceChecks,
            rebalanceActions: currentRebalanceActions, receiptOwnership: currentOwnership,
            claims: currentClaims, migrationInstalled: currentMigrationInstalled };
        });
        const hasAnyJobStore = (consistent.inventory.gridJobs && consistent.inventory.gridActions)
          || (consistent.inventory.rebalanceJobs && consistent.inventory.rebalanceActions);
        if (!hasAnyJobStore) {
          await finish(); return { schema: "migration-not-installed", migrationInstalled: false, digest: null, groups: [], code: "migration-not-installed" };
        }
        const gridRows = gridCensusJobs(consistent.gridJobs);
        const gridActionRows = gridCensusActions(consistent.gridActions);
        const rebalanceRows = consistent.rebalanceJobs.map((row) => ({
          jobId: String(row["job_id"]), strategyId: String(row["strategy_id"]), tradingWallet: getAddress(String(row["wallet_address"])),
          status: String(row["status"]), rowVersion: Number(row["row_version"]), admittedAtMs: numberOrNull(row["admitted_at_ms"]),
          sessionExpirySec: numberOrNull(row["session_expiry_sec"]), revokedAtMs: numberOrNull(row["revoked_at_ms"]),
          claimGeneration: bigint(row["claim_generation"]), accountingRev: bigint(row["accounting_rev"]) ?? 0n,
          externalActivity: row["external_activity"] === "true",
          managed: bigintJson(row["managed_json"]), costBasis: bigintJson(row["cost_basis"]),
        }) as unknown as QuantRebalanceJobRow);
        const snapshot = buildQuantWalletCensus({ generatedAtMs: Date.now(), migrationInstalled: consistent.migrationInstalled,
          gridJobs: gridRows, gridActions: gridActionRows, rebalanceJobs: rebalanceRows,
          rebalanceActions: consistent.rebalanceActions, claims: consistent.claims, receiptOwnership: consistent.receiptOwnership });
        await finish(); return { schema: consistent.migrationInstalled ? "ready" : "migration-not-installed", migrationInstalled: consistent.migrationInstalled,
          digest: snapshot.digest, groups: snapshot.groups.map((group) => ({
          wallet: group.wallet, claimMode: consistent.claims.find((claim) => claim.wallet.toLowerCase() === group.wallet.toLowerCase())?.mode ?? null,
          receiptOwnershipCount: group.receiptOwnershipCount,
          claimGeneration: consistent.claims.find((claim) => claim.wallet.toLowerCase() === group.wallet.toLowerCase())?.generation.toString(10) ?? null,
          dispositionRequired: group.disposition === "operator-disposition-required", actionSetDigest: digest(group.jobs.map((job) => job.actionSetDigest)),
          jobs: group.jobs.map((job) => ({ strategyKind: job.strategyKind, jobId: job.jobId, status: job.status,
            rowVersion: job.rowVersion, admitted: job.admitted, receiptOwnershipCount: job.receiptOwnershipCount,
            sessionExpirySec: job.sessionExpirySec, revokedAtMs: job.revokedAtMs,
            claimGeneration: job.claimGeneration?.toString(10) ?? null, accountingDigest: job.accountingDigest,
            actionStates: job.actionStates, actionSetDigest: job.actionSetDigest })),
        })), code: null };
      } catch { await finish(); return { schema: "migration-not-installed", migrationInstalled: false, digest: null, groups: [], code: "census-unavailable" }; }
    },
    async resolve(input) { return resolveProof(input); },
    async retire(input) { return retirementProof(input.jobId); },
  };
}

function g2Runtime(args: QuantRebalanceOperatorArgs): { readonly allocation: 10 | 30 | 75; readonly finite: boolean;
  readonly file: string; readonly databaseUrl: string; readonly envelopeKey: string; readonly rpcUrl: string; readonly selector: string } {
  if (!process.execArgv.includes("--env-file=.env.rebalance-g2.local")) throw new Error("g2-dedicated-env-required");
  const parsed = parseEnv(readFileSync(".env.rebalance-g2.local", "utf8"));
  const keys = ["QUANT_ENVELOPE_KEY", "DATABASE_URL", "QUANT_RPC_URL", "EXECUTION_NETWORK", "QUANT_REBALANCE_SELFTEST_OWNER_KEY_VAR"];
  if (Object.keys(parsed).some((key) => !keys.includes(key))) throw new Error("g2-dedicated-env-invalid");
  for (const key of keys) if (!Object.hasOwn(parsed, key) || process.env[key] !== parsed[key]) throw new Error("g2-inherited-env-conflict");
  if (parsed["EXECUTION_NETWORK"] !== "mainnet"
    || !/^0x[0-9a-fA-F]{64}$/u.test(parsed["QUANT_ENVELOPE_KEY"] ?? "")
    || !/^https:\/\//u.test(parsed["QUANT_RPC_URL"] ?? "")
    || !/^[A-Za-z_][A-Za-z0-9_]{0,100}$/u.test(parsed["QUANT_REBALANCE_SELFTEST_OWNER_KEY_VAR"] ?? "")) throw new Error("g2-dedicated-env-invalid");
  try {
    const rpc = new URL(parsed["QUANT_RPC_URL"]!);
    if (rpc.protocol !== "https:" || rpc.username !== "" || rpc.password !== "" || rpc.hash !== "") throw new Error("invalid");
  } catch { throw new Error("g2-rpc-url-invalid"); }
  for (const forbidden of ["QUANT_API_KEY", "QUANT_REBALANCE_STRATEGY_ID", "QUANT_SELF_TEST_FILE", "QUANT_AGENT_ID", "QUANT_STRATEGY_ID"]) {
    if (process.env[forbidden] !== undefined) throw new Error("g2-production-identity-conflict");
  }
  if (process.env["QUANT_REBALANCING_ENABLED"] !== undefined && process.env["QUANT_REBALANCING_ENABLED"] !== "false") throw new Error("g2-production-flag-conflict");
  if (!("file" in args) || args.file === undefined) throw new Error("g2-file-required");
  const selected = g2JobForFile(args.file);
  const finite = selected.mapping.job === G2_FINITE_JOB.job;
  if (finite && parsed["QUANT_REBALANCE_SELFTEST_OWNER_KEY_VAR"] !== "QUANT_G2_HIGH75_FINITE_OWNER_KEY") {
    throw new Error("g2-finite-owner-selector-invalid");
  }
  if ("allocation" in args && args.allocation !== selected.allocation) throw new Error("g2-file-allocation-mismatch");
  const urlText = parsed["DATABASE_URL"] ?? "";
  let url: URL;
  try { url = new URL(urlText); } catch { throw new Error("g2-database-url-invalid"); }
  if (!(url.protocol === "postgresql:" || url.protocol === "postgres:") || url.hostname !== "127.0.0.1"
    || url.port !== "5432" || url.pathname !== `/${selected.mapping.db}` || url.username !== selected.mapping.db
    || url.password === "" || url.search !== "" || url.hash !== "") throw new Error("g2-database-url-invalid");
  return { allocation: selected.allocation, finite, file: canonicalG2File(args.file), databaseUrl: urlText,
    envelopeKey: parsed["QUANT_ENVELOPE_KEY"]!, rpcUrl: parsed["QUANT_RPC_URL"]!, selector: parsed["QUANT_REBALANCE_SELFTEST_OWNER_KEY_VAR"]! };
}

function g2WorkerConfig(runtime: ReturnType<typeof g2Runtime>): QuantRebalanceRuntimeConfig {
  return { chainId: 56, databaseUrl: runtime.databaseUrl, envelopeKey: runtime.envelopeKey,
    apiKey: "", agentId: G2_FILE_AGENT_ID, strategyId: G2_FILE_STRATEGY_ID,
    apiBaseUrl: "https://platform-backend.prod.termix.live", rpcUrls: [runtime.rpcUrl], intervalMs: 300_000 };
}

export function protectedG2PortfolioRead(base: QuantRebalanceWorkerDeps, reader: QuantChainReader,
  claim: G2GrantClaim): QuantRebalanceWorkerDeps["readPortfolio"] {
  const protectedNative = BigInt(claim.protectedBaseline.BNB);
  return async (input) => {
    const result = await base.readPortfolio(input);
    if (!result.ok) return result;
    const u = await reader.tokenBalanceAtHash?.(G2_PROTECTED_U, input.job.tradingWallet, result.observation.blockHash);
    return result.observation.nativeBalanceWei < protectedNative || u?.toString(10) !== claim.protectedBaseline.U
      ? { ok: false, code: "g2-native-baseline-changed" } : result;
  };
}

function assertNoG2CompetingProcess(): void {
  if (process.platform !== "win32") throw new Error("g2-process-census-unavailable");
  const query = `$p=Get-CimInstance Win32_Process -Filter "Name='node.exe'";` +
    `$u=$p|Where-Object { $_.ProcessId -ne ${process.pid} -and (` +
    `$null -eq $_.CommandLine -or $_.CommandLine -match 'quant-worker\\.ts|quant-rebalance-worker\\.ts|live-quant\\.ts|live-quant-rebalance\\.ts') };` +
    `$u|ForEach-Object { $_.ProcessId }`;
  let found: string;
  try { found = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 }); }
  catch { throw new Error("g2-process-census-unavailable"); }
  if (found.trim() !== "") throw new Error("g2-competing-process-present");
}

export async function readG2AccountKeys(input: {
  readonly readCode: () => Promise<unknown>;
  readonly readRegistered: () => Promise<readonly Hex[]>;
  readonly readAccount: () => Promise<readonly [readonly { readonly publicKey: Hex; readonly isSuperAdmin: boolean; readonly expiry: number }[], readonly Hex[]]>;
  readonly readBlockHash: () => Promise<Hex>;
  readonly finalizedHash: Hex;
}): Promise<{ readonly accountKeys: readonly { readonly publicKey: Hex; readonly isSuperAdmin: boolean; readonly expiry: number }[];
  readonly accountHashes: readonly Hex[]; readonly registered: readonly Hex[]; readonly virgin: boolean }> {
  const code = await input.readCode();
  if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(code)) throw new Error("g2-account-code-unavailable");
  const registered = await input.readRegistered();
  if (code === "0x" && registered.length !== 0) throw new Error("g2-virgin-keystore-nonempty");
  const [accountKeys, accountHashes] = code === "0x" ? [[], []] as const : await input.readAccount();
  if ((await input.readBlockHash()).toLowerCase() !== input.finalizedHash.toLowerCase()) throw new Error("g2-finalized-block-changed");
  return { accountKeys, accountHashes, registered, virgin: code === "0x" };
}

export function g2PreSubmitRefusalField(notes: readonly string[], reason: RebalanceRevalidationRefusal | null):
  Readonly<{ preSubmitRefusal?: RebalanceRevalidationRefusal }> {
  return reason !== null && notes.some((note) => note.endsWith(":refused:price-moved"))
    ? { preSubmitRefusal: reason } : {};
}

async function runG2Grant(runtime: ReturnType<typeof g2Runtime>, yesLive: boolean): Promise<void> {
  const mapping = g2JobForFile(runtime.file).mapping;
  if (existsSync(runtime.file)) throw new Error("g2-output-file-exists");
  assertNoG2CompetingProcess();
  const ownerKey = loadG2OwnerKey(runtime.selector);
  const owner = ownerAuthorityFromPrivateKey(ownerKey);
  const reader = createQuantChainReader({ rpcUrls: [runtime.rpcUrl] });
  // A raw-key Altana wallet is the owner's EOA. SDK createWallet may sign an upgrade,
  // so even wallet resolution belongs after the durable live grant claim.
  const wallet: AgentWalletRef = { address: owner.address, ownerAddress: owner.address,
    chainId: 56, custodyModel: "self-eoa" };
  const finalized = await reader.finalizedBlock();
  if (await reader.chainId() !== 56 || reader.tokenBalanceAtHash === undefined || reader.nativeBalanceAtHash === undefined
    || reader.quoteV2AtHash === undefined) throw new Error("g2-chain-reader-unavailable");
  const publicClient = createPublicClient({ chain: bsc, transport: http(runtime.rpcUrl) });
  const { accountKeys, accountHashes, registered, virgin } = await readG2AccountKeys({
    readCode: () => publicClient.request({ method: "eth_getCode", params: [wallet.address, toHex(finalized.number)] }),
    readRegistered: () => publicClient.readContract({ address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI,
      functionName: "getKeys", args: [wallet.address], blockNumber: finalized.number }),
    readAccount: () => publicClient.readContract({ address: wallet.address, abi: ACCOUNT_ABI,
      functionName: "getKeys", blockNumber: finalized.number }),
    readBlockHash: async () => (await publicClient.getBlock({ blockNumber: finalized.number })).hash,
    finalizedHash: finalized.hash,
  });
  const keyCensus: Array<{ keyId: Hex; valid: boolean; superAdmin: boolean; expirySec: string | null }> = [];
  for (const keyId of registered) {
    const valid = await publicClient.readContract({ address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI,
      functionName: "isValidKey", args: [wallet.address, keyId], blockNumber: finalized.number });
    const accountIndex = accountKeys.findIndex((key) => keccak256(key.publicKey).toLowerCase() === keyId.toLowerCase());
    keyCensus.push({ keyId, valid, superAdmin: accountKeys[accountIndex]?.isSuperAdmin === true,
      expirySec: accountKeys[accountIndex] === undefined ? null : accountKeys[accountIndex].expiry.toString(10) });
    if (!valid) continue;
    // The owner's own KeyStore root key (its public key derives the wallet address) is not a session.
    if (accountIndex < 0) {
      const rootPublicKey = await publicClient.readContract({ address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI,
        functionName: "getPublicKey", args: [wallet.address, keyId], blockNumber: finalized.number });
      if (typeof rootPublicKey === "string" && /^0x04[0-9a-fA-F]{128}$/u.test(rootPublicKey)
        && publicKeyToAddress(rootPublicKey as Hex).toLowerCase() === wallet.address.toLowerCase()) {
        keyCensus[keyCensus.length - 1] = { ...keyCensus[keyCensus.length - 1]!, superAdmin: true };
        continue;
      }
    }
    if (accountIndex < 0 || accountKeys[accountIndex]?.isSuperAdmin !== true
      || accountHashes[accountIndex] === undefined) throw new Error("g2-active-nonrehearsal-key");
  }
  if ((await publicClient.getBlock({ blockNumber: finalized.number })).hash.toLowerCase() !== finalized.hash.toLowerCase()) {
    throw new Error("g2-finalized-block-changed");
  }
  const assets = ["USDC", "WBNB", "ETH", "CAKE", "USDT", "U"] as const;
  const balancePairs = await Promise.all(assets.map(async (asset) => [asset,
    (await reader.tokenBalanceAtHash!(asset === "U" ? G2_PROTECTED_U : REBALANCE_TOKEN_ADDRESSES[asset],
      wallet.address, finalized.hash)).toString(10)] as const));
  const balances = Object.fromEntries(balancePairs) as Record<typeof assets[number], string>;
  const native = await reader.nativeBalanceAtHash(wallet.address, finalized.hash);
  const allocationWei = BigInt(runtime.allocation) * 10n ** 18n;
  const approvedFloat = 10n ** 16n;
  if (BigInt(balances.USDC) < allocationWei || native < approvedFloat) throw new Error("g2-wallet-funding-insufficient");
  const gasPriceWei = await reader.gasPriceWei();
  if (gasPriceWei <= 0n || gasPriceWei > (runtime.finite ? G2_FINITE_MAX_GAS_PRICE_WEI : REBALANCE_MAX_GAS_PRICE_WEI)) {
    throw new Error("g2-gas-price-unavailable");
  }
  const estimatedExit = (600_000n * gasPriceWei * 15_000n + 9_999n) / 10_000n;
  const perExit = estimatedExit > 30_000_000_000_000n ? estimatedExit : 30_000_000_000_000n;
  const initialOwnBudget = runtime.allocation === 75 ? 2n * 45_000_000_000_000n + 90_000_000_000_000n : 45_000_000_000_000n;
  const planningNativeReserve = 3_000_000_000_000_000n + initialOwnBudget
    + perExit * BigInt(runtime.allocation === 75 ? 3 : 1);
  if (approvedFloat < planningNativeReserve) throw new Error("g2-native-planning-reserve-insufficient");
  const protectedBalances = { ...balances, USDC: (BigInt(balances.USDC) - allocationWei).toString(10),
    BNB: (native - approvedFloat).toString(10) };
  const actualBalances = { ...balances, BNB: native.toString(10) };
  const profiles = loadG2FileProfiles(runtime.finite);
  const routes = runtime.allocation === 75
    ? [[REBALANCE_TOKEN_ADDRESSES.USDC, REBALANCE_TOKEN_ADDRESSES.WBNB],
      [REBALANCE_TOKEN_ADDRESSES.USDC, REBALANCE_TOKEN_ADDRESSES.ETH],
      [REBALANCE_TOKEN_ADDRESSES.USDC, REBALANCE_TOKEN_ADDRESSES.WBNB, REBALANCE_TOKEN_ADDRESSES.CAKE]]
    : [[REBALANCE_TOKEN_ADDRESSES.USDC, REBALANCE_TOKEN_ADDRESSES.WBNB]];
  const amounts = runtime.allocation === 75 ? [30n, 30n, 15n] : [BigInt(runtime.allocation) / 2n];
  const outputs: bigint[] = [];
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index]!;
    const reference = requiredReferencePath(route);
    if (reference === null) throw new Error("g2-reference-unavailable");
    const pairs = await loadPathPairs(reader, route, finalized.hash);
    const referencePairs = await loadPathPairs(reader, reference, finalized.hash);
    if (pairs === null || referencePairs === null || !evaluateReferenceGuard({ candidatePath: route,
      candidatePairs: pairs, referencePath: reference, referencePairs,
      candidateBlockHash: finalized.hash, referenceBlockHash: finalized.hash }).ok) throw new Error("g2-reference-unavailable");
    const quantity = await reader.quoteV2AtHash!(getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E"),
      route, amounts[index]! * 10n ** 18n, finalized.hash);
    if (quantity <= 0n) throw new Error("g2-initial-quote-unavailable");
    outputs.push(quantity);
  }
  const riskCaps = { WBNB: g2RiskCap(outputs[0]!),
    ...(runtime.allocation === 75 ? { ETH: g2RiskCap(outputs[1]!), CAKE: g2RiskCap(outputs[2]!) } : {}) };
  const nowMs = Date.now();
  const startedAtMs = runtime.finite ? Math.floor(nowMs / 1_000) * 1_000 : nowMs;
  const endsAtMs = startedAtMs + 2 * 86_400_000;
  const expiresAt = Math.floor(endsAtMs / 1_000) + 600;
  const spec = g2SessionSpec({ allocation: runtime.allocation, finite: runtime.finite, riskCaps,
    verifiedPreGrantPaymentMaxWei: null, expiresAt, nowSeconds: Math.floor(nowMs / 1000), wallet: wallet.address });
  const agentKey = generatePrivateKey();
  const publicKey = privateKeyToAccount(agentKey).publicKey;
  const proposed = parseSessionPlaintext(serializeGrantedSession({ walletAddress: wallet.address, publicKey,
    expiry: expiresAt, permissions: {
      calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
        ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
      spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }),
        limit: cap.limit, period: cap.period })),
    }, privateKey: agentKey }));
  if (!proposed.ok) throw new Error("g2-proposed-session-invalid");
  const jobWire = { id: mapping.job, status: "ACTIVE", strategyId: G2_FILE_STRATEGY_ID,
    tradingWalletAddress: wallet.address, allocationUWei: allocationWei, dailyCapUWei: 2n * allocationWei,
    termDays: 2, startedAtMs, endsAtMs,
    sessionExpiresAtMs: expiresAt * 1000, revokedAtMs: null } as const;
  const admission = admitRebalanceSession({ session: proposed.session, job: jobWire,
    capabilityProfile: profiles.capability, nowMs });
  if (!admission.ok) throw new Error("g2-proposed-admission-refused");
  const keypair = quantKeypairFromSeed(runtime.envelopeKey);
  const preview = { kind: "self-test", verdict: "proposed-session-feasible", wallet: wallet.address,
    chainId: 56, finalizedBlock: finalized.number.toString(10), finalizedHash: finalized.hash,
    jobId: mapping.job, allocationUsdc: runtime.allocation, tier: runtime.allocation === 75 ? "high" : "low",
    file: runtime.file, profile: profiles.capability.id,
    configDigest: quantExpandedConfigDigest(profiles.config.expected), policyDigest: admission.policyDigest,
    routes, initialQuotedRiskAtoms: outputs.map((output) => output.toString(10)),
    expirySec: expiresAt, callRules: spec.allowedCalls.map((rule) => ({ to: rule.to, selector: rule.selector })),
    caps: spec.spendCaps.map((cap) => ({
      token: cap.token ?? "native", limitWei: cap.limit.toString(10), period: cap.period })),
    balances: actualBalances, protectedBalances, approvedNativeFloatWei: approvedFloat.toString(10),
    gasPriceWei: gasPriceWei.toString(10), planningNativeReserveWei: planningNativeReserve.toString(10),
    grantQuote: "unavailable-before-registration", grantBudgetWei: "3000000000000000",
    bootVerdict: "public-pairs-and-reference-ready", admissionVerdict: "proposed-session-feasible",
    keyCensus,
    writes: false };
  console.log(JSON.stringify({ data: preview }));
  if (!yesLive) return;
  if (existsSync(runtime.file)) throw new Error("g2-output-file-exists");
  const claim: G2GrantClaim = { version: 1, chainId: 56, wallet: wallet.address,
    database: mapping.db, role: mapping.db, server: "127.0.0.1:5432",
    jobId: mapping.job, file: runtime.file, fileFactsDigest: g2ProposedFileDigest(runtime.allocation, runtime.file),
    publicKey, keyId: keccak256(publicKey), permissionsDigest: permissionsDigest(proposed.session.permissions),
    expirySec: expiresAt, state: "claiming", outputDigest: null, grantNativeDebitWei: null,
    baselineBlock: finalized.number.toString(10), baselineHash: finalized.hash,
    ...(virgin ? { freshWalletProof: { wallet: wallet.address, blockNumber: finalized.number.toString(10), blockHash: finalized.hash,
      code: "0x" as const, registryKeys: 0 as const } } : {}),
    actualBaseline: actualBalances, protectedBaseline: protectedBalances, approvedNativeFloatWei: approvedFloat.toString(10) };
  createG2GrantClaim(claim);
  let entered = false;
  try {
    const placeholder: G2File = { version: 1, config: profiles.block,
      agentKey: { encryptionPublicKey: keypair.publicKey.toString("base64"), algorithm: QUANT_ENVELOPE_ALGORITHM },
      inbox: [], jobs: [], reports: [], grantState: "claiming" };
    claimSelfTestFile(runtime.file, placeholder);
    entered = true;
    const provider = new AltanaProvider({ network: BNB, rpcUrls: [runtime.rpcUrl] });
    const resolved = await provider.resolveOwnerWallet({ owner });
    if (resolved.chainId !== 56 || resolved.address.toLowerCase() !== wallet.address.toLowerCase()
      || resolved.ownerAddress.toLowerCase() !== owner.address.toLowerCase()
      || resolved.custodyModel !== "self-eoa") throw new Error("g2-owner-wallet-mismatch");
    const granted = await provider.grantSession({ wallet, owner, spec, agent: agentAuthorityFromPrivateKey(agentKey) });
    if (granted.publicKey.toLowerCase() !== publicKey.toLowerCase()
      || granted.walletAddress.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("g2-grant-return-mismatch");
    const sdkSession = (granted.handle as { session: { permissions: Parameters<typeof serializeGrantedSession>[0]["permissions"] } }).session;
    let afterNative: bigint | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const block = await reader.finalizedBlock();
      const valid = await publicClient.readContract({ address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI,
        functionName: "isValidKey", args: [wallet.address, claim.keyId], blockNumber: block.number });
      if (valid && block.number > finalized.number) {
        afterNative = await reader.nativeBalanceAtHash!(wallet.address, block.hash);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (afterNative === null || afterNative > native) throw new Error("g2-grant-finality-unavailable");
    const ready = publishG2GrantedOutput({ claim, publicKey: granted.publicKey, permissions: sdkSession.permissions,
      privateKey: agentKey, keypair, config: profiles.block,
      job: { id: mapping.job, status: "ACTIVE", strategyId: G2_FILE_STRATEGY_ID,
        tradingWalletAddress: wallet.address, allocationUWei: allocationWei.toString(10),
        dailyCapUWei: (2n * allocationWei).toString(10), termDays: 2, startedAtMs,
        endsAtMs, sessionExpiresAtMs: expiresAt * 1000, revokedAtMs: null },
      grantNativeDebitWei: native - afterNative });
    console.log(JSON.stringify({ data: { kind: "self-test", verdict: "granted", wallet: wallet.address,
      jobId: mapping.job, keyId: claim.keyId, grantNativeDebitWei: (native - afterNative).toString(10),
      fileFactsDigest: ready.outputDigest, grantTxHash: null } }));
  } catch {
    if (entered) { try { markG2GrantUncertain(claim); } catch { /* retained guard and claim */ } }
    else { try { releaseG2PreProviderClaim(claim); } catch { /* retained claim */ } }
    throw new Error(entered ? "g2-grant-uncertain" : "g2-grant-pre-provider-refused");
  }
}

export async function previewG2Worker(input: {
  readonly jobId: string;
  readonly job: QuantRebalanceJobRow | null;
  readonly actions: readonly QuantRebalanceActionRow[];
  readonly allocation: 10 | 30 | 75;
  readonly finite?: boolean;
  readonly finiteJournalValid?: boolean;
  readonly finiteOwnershipValid?: boolean;
  readonly deps: QuantRebalanceWorkerDeps;
  readonly listChecks: (jobId: string) => Promise<readonly QuantRebalanceCheckRow[]>;
  readonly nowMs: number;
  readonly grantCostExcess?: boolean;
}): Promise<Readonly<Record<string, unknown>>> {
  const { job, actions, nowMs } = input;
  const pending = actions.filter((action) => !REBALANCE_ACTION_TERMINAL.has(action.state));
  const phase = job === null ? "discovery-and-admission" : pending.length > 0 ? "recovery"
    : job.endsAtMs <= nowMs ? input.finite ? "term-end-closeout" : "term-end-report"
      : job.bootstrapComplete ? "scheduled-check" : "bootstrap";
  const finiteChecks = input.finite && job !== null ? await input.listChecks(job.jobId) : [];
  const finiteState = input.finite && job !== null ? deriveFiniteState(actions, finiteChecks) : null;
  const finiteAccountingValid = finiteState === null || finiteState.kind === "stop" || job?.managed !== null
    && job?.managed !== undefined && finiteState.managed.USDC === job.managed.USDC
    && finiteState.managed.WBNB === job.managed.WBNB && finiteState.managed.ETH === job.managed.ETH
    && finiteState.managed.CAKE === job.managed.CAKE;
  let plan: unknown = null;
  if (job !== null && pending.length === 0 && job.endsAtMs > nowMs && job.managed !== null
    && finiteState?.kind !== "complete") {
    const tier = rebalanceTierForProfile(job.allocationWei, input.deps.capabilityProfile?.id ?? "");
    if (tier.ok) {
      const slot = Math.floor((nowMs - job.startedAtMs) / tier.tier.intervalMs);
      if (!job.bootstrapComplete || slot >= job.nextEligibleSlot) {
        const snapshot = await input.deps.readPortfolio({ job, tier: tier.tier, nowMs });
        if (snapshot.ok) {
          const valuationNowMs = input.deps.nowMs();
          const valued = valueManagedPortfolio({ managed: job.managed, marks: snapshot.observation.marks,
            expectedBlockNumber: snapshot.observation.blockNumber, expectedBlockHash: snapshot.observation.blockHash,
            nowMs: valuationNowMs });
          if (valued.ok) {
            const checks = await input.listChecks(job.jobId);
            const active = checks.find((check) => check.state === "rebalancing");
            const check: QuantRebalanceCheckRow = active ?? { checkId: "g2-preview-only", jobId: job.jobId,
              kind: job.bootstrapComplete ? "scheduled" : "bootstrap", slot, state: "rebalancing",
              evidenceJson: null, takenAssets: [], rowVersion: 0, createdAtMs: nowMs, updatedAtMs: nowMs };
            const leg = input.finite && check.kind === "scheduled"
              ? finiteState?.kind === "ready" && check.takenAssets.length === 0
                ? planFiniteLeg(job, finiteState) : { kind: "none", reason: "already-balanced" } as const
              : planRebalanceLeg({ managed: job.managed, values: valued.values, tier: tier.tier,
                takenAssets: new Set(check.takenAssets), checkMode: check.kind === "bootstrap" ? "bootstrap"
                  : active === undefined ? "candidate" : "continuation" });
            if (leg.kind === "buy" || leg.kind === "sell") {
              const priced = await input.deps.priceLeg({ job, check, leg, observation: snapshot.observation, nowMs: valuationNowMs });
              plan = "hold" in priced ? { kind: "hold", reason: priced.hold }
                : { kind: leg.kind, asset: leg.asset, amountInWei: leg.amountInWei.toString(10),
                  path: priced.action.path, quoteOutWei: priced.action.quoteOutWei.toString(10),
                  gasEvidence: JSON.parse(priced.action.gasEvidenceJson) as unknown };
            } else plan = leg;
          }
        }
      }
    }
  }
  const submissions = input.finite ? (() => {
    const used = 1 + actions.filter((action) => action.preSubmitBlockNumber !== null).length;
    return { used, remaining: Math.max(0, 30 - used), stop: null as string | null };
  })() : g2SubmissionVerdict(actions, input.allocation);
  let finiteCompletion: "complete" | "check-pending" | "portfolio-unverified" | null = null;
  if (finiteState?.kind === "complete" && job !== null) {
    const scheduled = finiteChecks.filter((check) => check.kind === "scheduled" && check.state === "done");
    if (!finiteChecks.some((check) => check.kind === "bootstrap" && check.state === "done")
      || scheduled.length !== 6 || scheduled.some((check) => check.takenAssets.length !== 1)
      || finiteChecks.some((check) => check.state === "rebalancing")) finiteCompletion = "check-pending";
    else {
      const tier = rebalanceTierForProfile(job.allocationWei, input.deps.capabilityProfile?.id ?? "");
      const snapshot = tier.ok ? await input.deps.readPortfolio({ job, tier: tier.tier, nowMs }) : null;
      const expected = expectedBalances(job);
      const valued = snapshot?.ok && job.managed !== null
        ? valueManagedPortfolio({ managed: job.managed, marks: snapshot.observation.marks,
          expectedBlockNumber: snapshot.observation.blockNumber, expectedBlockHash: snapshot.observation.blockHash,
          nowMs: input.deps.nowMs() }) : null;
      finiteCompletion = snapshot?.ok && expected !== null
        && balancesEqual(expected, snapshot.observation.actualBalances) && valued?.ok
        ? "complete" : "portfolio-unverified";
    }
  }
  const stop = input.finite && input.finiteJournalValid === false ? "finite-journal-inconsistent"
    : input.finite && input.finiteOwnershipValid === false ? "finite-ownership-inconsistent"
    : input.finite && !finiteAccountingValid ? "finite-accounting-inconsistent"
    : finiteCompletion === "complete" ? "routes-complete"
      : finiteCompletion === "portfolio-unverified" ? "finite-portfolio-unverified"
    : finiteState?.kind === "stop" && pending.length === 0 ? finiteState.code
      : input.finite && submissions.used >= 30 ? "budget" : submissions.stop;
  return { kind: "worker", verdict: "preview", jobId: input.jobId, phase,
    actionId: pending[0]?.actionId ?? null, firstLeg: job === null ? "unknown-until-fenced-promotion" : null,
    plan, submissionsUsed: submissions.used, submissionsRemaining: submissions.remaining,
    submissionStop: input.grantCostExcess === true ? "grant-budget" : stop, writes: false };
}

export async function verifyFiniteReceiptOwnership(sql: SqlClient, job: QuantRebalanceJobRow,
  actions: readonly QuantRebalanceActionRow[]): Promise<boolean> {
  const settled = actions.filter((action) => action.state === "settled");
  const expected = new Map<string, string>();
  for (const action of settled) {
    if (action.txHash === null || action.swapLogIndices.length !== action.pairAddresses.length
      || action.swapLogIndices.length === 0) return false;
    for (const index of action.swapLogIndices) {
      const identity = `${action.txHash.toLowerCase()}|${job.tradingWallet.toLowerCase()}|${index}`;
      if (expected.has(identity)) return false;
      expected.set(identity, action.journalKey);
    }
  }
  if (settled.length === 0) return true;
  const rows = await sql.query<Record<string, unknown>>(`/* g2.finiteOwnership */ select tx_hash,trading_wallet,
    swap_log_index::text as swap_log_index,journal_key from quant_receipt_ownership
    where journal_key = any($1::text[])`, [settled.map((action) => action.journalKey)]);
  if (rows.rows.length !== expected.size) return false;
  for (const row of rows.rows) {
    if (typeof row["tx_hash"] !== "string" || typeof row["trading_wallet"] !== "string"
      || typeof row["swap_log_index"] !== "string" || typeof row["journal_key"] !== "string"
      || expected.get(`${row["tx_hash"].toLowerCase()}|${row["trading_wallet"].toLowerCase()}|${row["swap_log_index"]}`)
        !== row["journal_key"]) return false;
  }
  return true;
}

export async function verifyFiniteTerminalReceipt(reader: QuantChainReader, job: QuantRebalanceJobRow,
  action: QuantRebalanceActionRow, cause: "submitted-failure" | "unknown-settled"): Promise<boolean> {
  if (action.txHash === null) return false;
  try {
    const verified = await verifyQuantRebalanceActionReceipt({ reader, job, action, txHash: action.txHash });
    if (verified === null) return false;
    if (cause === "submitted-failure") return verified.failure?.txHash.toLowerCase() === action.txHash.toLowerCase();
    return verified.receipt !== null && verified.receipt.proofDigest === action.proofDigest
      && verified.receipt.fillInWei === action.fillInWei && verified.receipt.fillOutWei === action.fillOutWei
      && verified.ownership.length === action.swapLogIndices.length
      && verified.ownership.every((row, index) => row.swapLogIndex === action.swapLogIndices[index]);
  } catch { return false; }
}

export function finiteExpiryWitnessValid(input: { readonly job: QuantRebalanceJobRow;
  readonly claim: G2GrantClaim; readonly finalizedTimestampSec: bigint;
  readonly finalizedHash: Hex; readonly canonicalHash: Hex; readonly keyValid: boolean }): boolean {
  return input.job.tradingWallet.toLowerCase() === input.claim.wallet.toLowerCase()
    && input.job.sessionExpiresAtMs === input.claim.expirySec * 1_000
    && input.finalizedHash.toLowerCase() === input.canonicalHash.toLowerCase()
    && input.finalizedTimestampSec >= BigInt(input.claim.expirySec) && !input.keyValid;
}

async function verifyFiniteExpiredAuthority(reader: QuantChainReader, rpcUrl: string,
  claim: G2GrantClaim, job: QuantRebalanceJobRow): Promise<boolean> {
  try {
    const finalized = await reader.finalizedBlock();
    const canonical = await reader.blockAt(finalized.number);
    const client = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
    const keyValid = await client.readContract({ address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI,
      functionName: "isValidKey", args: [claim.wallet, claim.keyId], blockNumber: finalized.number });
    const canonicalAfter = await reader.blockAt(finalized.number);
    return canonical.hash.toLowerCase() === canonicalAfter.hash.toLowerCase()
      && finiteExpiryWitnessValid({ job, claim, finalizedTimestampSec: finalized.timestampSec,
        finalizedHash: finalized.hash, canonicalHash: canonicalAfter.hash, keyValid });
  } catch { return false; }
}

async function runG2Command(args: QuantRebalanceOperatorArgs): Promise<void> {
  const runtime = g2Runtime(args);
  const sql = await createPgSqlClient(runtime.databaseUrl);
  try {
    if (args.command === "prepare-self-test-db") {
      const identity = await prepareG2Database(sql, runtime.allocation, args.yesLive,
        undefined, runtime.finite ? G2_FINITE_JOB : null);
      console.log(JSON.stringify({ data: { kind: args.command, verdict: args.yesLive ? "prepared" : "empty-dedicated-db",
        database: identity.database, role: identity.role, server: identity.server, userObjects: identity.userObjects,
        conflictingConnections: identity.conflictingConnections, identityFingerprint: digest(identity),
        marker: args.yesLive ? "g2-file-selftest" : "absent", productionCutover: false } }));
      return;
    }
    await assertG2PreparedDatabase(sql, runtime.allocation, runtime.finite ? G2_FINITE_JOB : null);
    if (args.command === "self-test") {
      const empty = await sql.query<Record<string, unknown>>(`/* g2.grantEmpty */ select
        (select count(*)::int from quant_rebalance_jobs) as jobs,
        (select count(*)::int from quant_rebalance_actions) as actions,
        (select count(*)::int from quant_wallet_claims) as claims,
        (select count(*)::int from quant_jobs) as grid_jobs`);
      if (empty.rows.length !== 1 || Object.values(empty.rows[0]!).some((count) => count !== 0)) {
        throw new Error("g2-grant-db-not-empty");
      }
      await runG2Grant(runtime, args.yesLive);
      return;
    }
    if (args.command === "config-check" || args.command === "worker") {
      const keypair = quantKeypairFromSeed(runtime.envelopeKey);
      const file = readG2ReadyFile(runtime.file, runtime.allocation, keypair);
      const profiles = loadG2FileProfiles(runtime.finite);
      const config = g2WorkerConfig(runtime);
      const transport = new FileQuantTransport(runtime.file,
        { u: REBALANCE_TOKEN_ADDRESSES.USDC, wbnb: REBALANCE_TOKEN_ADDRESSES.WBNB,
          router: getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E") }, profiles.block);
      const reader = createQuantChainReader({ rpcUrls: config.rpcUrls });
      const provider = new AltanaProvider({ network: BNB, rpcUrls: [...config.rpcUrls] });
      await assertQuantRebalanceBoot({ config, capabilityProfile: profiles.capability,
        configProfile: profiles.config, transport, reader, provider, keypair });
      if (args.command === "config-check") {
        console.log(JSON.stringify({ data: { kind: "config-check", verdict: "rehearsal-ready",
          profile: profiles.capability.id, jobId: file.jobs[0]!.id, chainId: 56 } }));
        return;
      }
      const store = new PostgresQuantRebalanceStore(sql);
      const claims = new PostgresQuantWalletClaimStore(sql);
      const journal = await PostgresExecutionJournal.attachExisting(sql);
      const job = await store.getJob(file.jobs[0]!.id);
      const actions = await store.listActions(file.jobs[0]!.id);
      const claim = readG2GrantClaim(file.jobs[0]!.tradingWalletAddress);
      if (claim.grantNativeDebitWei === null || !/^(0|[1-9][0-9]*)$/u.test(claim.grantNativeDebitWei)) {
        throw new Error("g2-grant-budget-unverified");
      }
      const grantCostExcess = BigInt(claim.grantNativeDebitWei) > 3_000_000_000_000_000n;
      if (!args.yesLive) {
        const base = buildQuantRebalanceWorkerDeps({ config, capabilityProfile: profiles.capability,
          store, claims, journal, transport, reader, provider, keypair });
        const deps: typeof base = { ...base, readPortfolio: protectedG2PortfolioRead(base, reader, claim) };
        const preview = await previewG2Worker({ jobId: file.jobs[0]!.id, job, actions,
          allocation: runtime.allocation, finite: runtime.finite,
          finiteJournalValid: !runtime.finite || await finiteJournalHistoryValid(actions, journal),
          finiteOwnershipValid: !runtime.finite || job === null
            || await verifyFiniteReceiptOwnership(sql, job, actions),
          deps, listChecks: (jobId) => store.listChecks(jobId),
          nowMs: Date.now(), grantCostExcess });
        console.log(JSON.stringify({ data: preview }));
        return;
      }
      const lease = await acquireWorkerSingleton({ role: "quant-rebalance-worker", databaseUrl: runtime.databaseUrl });
      if (lease.kind !== "acquired") throw new Error("g2-worker-singleton-held");
      try {
        let revalidationRefusal: RebalanceRevalidationRefusal | null = null;
        const recordRevalidationRefusal = (reason: RebalanceRevalidationRefusal): void => { revalidationRefusal = reason; };
        const base = buildQuantRebalanceWorkerDeps({ config, capabilityProfile: profiles.capability,
          store, claims, journal, transport, reader, provider, keypair, signal: lease.fence.signal,
          onRevalidationRefusal: recordRevalidationRefusal });
        const jobId = file.jobs[0]!.id;
        const protectedNative = BigInt(claim.protectedBaseline.BNB);
        const canSend = async () => {
          const rows = await store.listActions(jobId);
          if (grantCostExcess) return false;
          if (!runtime.finite) return g2SubmissionVerdict(rows, runtime.allocation).stop === null;
          const finiteState = deriveFiniteState(rows, await store.listChecks(jobId));
          return finiteState.kind === "ready" && 1 + rows.filter((row) => row.preSubmitBlockNumber !== null).length < 30;
        };
        const canSubmitCurrent = async (current: QuantRebalanceActionRow): Promise<boolean> => {
          if (!runtime.finite) return canSend();
          if (grantCostExcess) return false;
          const rows = await store.listActions(jobId);
          const intended = rows.filter((row) => row.actionId === current.actionId);
          if (intended.length !== 1 || intended[0]?.state !== "intended"
            || intended[0].preSubmitBlockNumber !== null || intended[0].txHash !== null
            || rows.some((row) => row.actionId !== current.actionId && row.sequence >= current.sequence)) return false;
          const prior = rows.filter((row) => row.actionId !== current.actionId);
          const checks = await store.listChecks(jobId);
          const currentJob = await store.getJob(jobId);
          const state = deriveFiniteState(prior, checks);
          return state.kind === "ready" && finiteIntendedMatchesStage(state, current)
            && await finiteJournalHistoryValid(prior, journal)
            && currentJob !== null && await verifyFiniteReceiptOwnership(sql, currentJob, prior)
            && await journal.get(current.journalKey) === null
            && 1 + prior.filter((row) => row.preSubmitBlockNumber !== null).length < 30;
        };
        const deps: typeof base = { ...base,
          ...(runtime.finite ? { verifyFiniteOwnership: (job, actions) => verifyFiniteReceiptOwnership(sql, job, actions) } : {}),
          async admitChain(input) {
            const result = await base.admitChain(input);
            if (!result.ok) return result;
            for (const asset of ["USDC", "WBNB", "ETH", "CAKE", "USDT"] as const) {
              if (result.actualBalances[asset].toString(10) !== claim.actualBaseline[asset]
                || result.protectedBalances[asset].toString(10) !== claim.protectedBaseline[asset]) {
                return { ok: false, code: "g2-protected-baseline-changed" };
              }
            }
            const native = await reader.nativeBalanceAtHash?.(input.job.tradingWalletAddress, result.baselineHash);
            const u = await reader.tokenBalanceAtHash?.(G2_PROTECTED_U, input.job.tradingWalletAddress, result.baselineHash);
            return native === undefined || native < protectedNative || u?.toString(10) !== claim.protectedBaseline.U
              ? { ok: false, code: "g2-native-baseline-changed" } : result;
          },
          readPortfolio: protectedG2PortfolioRead(base, reader, claim),
          async priceLeg(input) {
            if (!await canSend()) return { hold: "g2-submission-or-route-stop" };
            const priced = await base.priceLeg(input);
            if (runtime.finite && !('hold' in priced)
              && input.observation.nativeBalanceWei < protectedNative + priced.requiredNativeWei) {
              return { hold: "g2-protected-native-reserve" };
            }
            return priced;
          },
          async revalidatePlan(input) {
            const gas = JSON.parse(input.action.gasEvidenceJson) as Record<string, unknown>;
            const required = gas["requiredNativeWei"];
            if (typeof required !== "string" || !/^(0|[1-9][0-9]*)$/u.test(required)) {
              recordRevalidationRefusal("g2-required-native-invalid"); return false;
            }
            const native = await reader.nativeBalanceAtHash?.(input.job.tradingWallet, input.finalized.hash);
            const u = await reader.tokenBalanceAtHash?.(G2_PROTECTED_U, input.job.tradingWallet, input.finalized.hash);
            if (native === undefined) { recordRevalidationRefusal("g2-protected-native-unavailable"); return false; }
            if (native < protectedNative + BigInt(required)) {
              recordRevalidationRefusal("g2-protected-native-shortfall"); return false;
            }
            if (u?.toString(10) !== claim.protectedBaseline.U) {
              recordRevalidationRefusal("g2-protected-u-mismatch"); return false;
            }
            return base.revalidatePlan(input);
          },
          async submitAction(input) {
            if (!await canSubmitCurrent(input.action)) return { kind: "refused", code: "g2-submission-or-route-stop" };
            const block = await reader.finalizedBlock();
            const native = await reader.nativeBalanceAtHash?.(input.job.tradingWallet, block.hash);
            const u = await reader.tokenBalanceAtHash?.(G2_PROTECTED_U, input.job.tradingWallet, block.hash);
            if (native === undefined || native < protectedNative + input.requiredNativeWei
              || u?.toString(10) !== claim.protectedBaseline.U) {
              return { kind: "refused", code: "g2-protected-native-reserve" };
            }
            return submitQuantRebalanceAction({ store, journal, provider, reader, keypair,
              nowMs: base.nowMs, revalidatePlan: deps.revalidatePlan,
              readCurrentWire: base.readCurrentWire, signal: lease.fence.signal }, input);
          },
        };
        lease.fence.assertOpen();
        const result = await runQuantRebalanceWorkerOnce(deps);
        console.log(JSON.stringify({ data: { kind: "worker", verdict: "one-cycle", jobs: result.jobsSeen,
          actions: result.actions, holds: result.holds, errors: result.errors,
          notes: result.notes.filter((note) => /^[A-Za-z0-9._:-]{1,200}$/u.test(note)),
          ...g2PreSubmitRefusalField(result.notes, revalidationRefusal) } }));
        if (result.errors > 0) process.exitCode = 1;
      } finally { await lease.closeGracefully(); }
      return;
    }
    if (args.command === "closeout-report") {
      if (!runtime.finite) throw new Error("g2-finite-report-profile-required");
      assertNoG2CompetingProcess();
      const keypair = quantKeypairFromSeed(runtime.envelopeKey);
      const file = readG2ReadyFile(runtime.file, runtime.allocation, keypair);
      const claim = readG2GrantClaim(file.jobs[0]!.tradingWalletAddress);
      const store = new PostgresQuantRebalanceStore(sql);
      const job = await store.getJob(claim.jobId);
      const actions = await store.listActions(claim.jobId);
      const journal = await PostgresExecutionJournal.attachExisting(sql);
      const journalHistory = await assessFiniteJournalHistory(actions, journal);
      const state = deriveFiniteCloseoutState(actions, await store.listChecks(claim.jobId),
        journalHistory.recoveredUnknownActionIds);
      const nowMs = Date.now();
      if (job === null || job.endsAtMs > nowMs || job.reportedAtMs !== null || state.kind === "invalid"
        || state.kind === "incomplete" && nowMs < job.sessionExpiresAtMs
        || job.managed === null || (state.managed.USDC !== job.managed.USDC
          || state.managed.WBNB !== job.managed.WBNB || state.managed.ETH !== job.managed.ETH
          || state.managed.CAKE !== job.managed.CAKE)
        || actions.some((action) => !REBALANCE_ACTION_TERMINAL.has(action.state))
        || !journalHistory.valid
        || !await verifyFiniteReceiptOwnership(sql, job, actions)) {
        throw new Error("g2-finite-report-ineligible");
      }
      const reader = createQuantChainReader({ rpcUrls: [runtime.rpcUrl] });
      if (state.kind === "incomplete" && !await verifyFiniteExpiredAuthority(reader, runtime.rpcUrl, claim, job)) {
        throw new Error("g2-finite-expiry-unproven");
      }
      if (state.kind === "incomplete" && state.cause !== "no-send-exhausted") {
        const terminal = actions.find((action) => action.actionId === state.terminalActionId);
        if (terminal === undefined || !await verifyFiniteTerminalReceipt(reader, job, terminal, state.cause)) {
          throw new Error("g2-finite-terminal-proof-invalid");
        }
      }
      if (!args.yesLive) {
        console.log(JSON.stringify({ data: { kind: "closeout-report", verdict: "preview", jobId: claim.jobId,
          tradingProof: state.kind === "complete" ? "complete" : "incomplete", writes: false } }));
        return;
      }
      const lease = await acquireWorkerSingleton({ role: "quant-rebalance-worker", databaseUrl: runtime.databaseUrl });
      if (lease.kind !== "acquired") throw new Error("g2-worker-singleton-held");
      try {
        if (job.status !== "ended") {
          await store.markEnded({ jobId: job.jobId, unresolved: false, nowMs });
        }
        const ended = await store.getJob(job.jobId);
        if (ended?.status !== "ended") throw new Error("g2-finite-end-not-confirmed");
        if (ended.claimGeneration !== null) {
          const claims = new PostgresQuantWalletClaimStore(sql);
          await claims.releaseTerminal({ wallet: ended.tradingWallet, strategyKind: "rebalance",
            strategyId: ended.strategyId, jobId: ended.jobId, generation: ended.claimGeneration, nowMs });
        }
        const config = g2WorkerConfig(runtime);
        const profiles = loadG2FileProfiles(true);
        const transport = new FileQuantTransport(runtime.file,
          { u: REBALANCE_TOKEN_ADDRESSES.USDC, wbnb: REBALANCE_TOKEN_ADDRESSES.WBNB,
            router: getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E") }, profiles.block);
        const provider = new AltanaProvider({ network: BNB, rpcUrls: [...config.rpcUrls] });
        const claims = new PostgresQuantWalletClaimStore(sql);
        const deps = buildQuantRebalanceWorkerDeps({ config, capabilityProfile: profiles.capability,
          store, claims, journal, transport, reader, provider, keypair, signal: lease.fence.signal });
        const notes = await reportFiniteEndedJobOnce({ ...deps,
          verifyFiniteOwnership: (job, actions) => verifyFiniteReceiptOwnership(sql, job, actions),
          verifyFiniteTerminal: (job, action, cause) => verifyFiniteTerminalReceipt(reader, job, action, cause),
          verifyFiniteExpiredAuthority: (job) => verifyFiniteExpiredAuthority(reader, runtime.rpcUrl, claim, job) }, job.jobId);
        const reported = await store.getJob(job.jobId);
        if (reported?.reportedAtMs == null) process.exitCode = 1;
        console.log(JSON.stringify({ data: { kind: "closeout-report", verdict: reported?.reportedAtMs == null ? "retry" : "reported",
          jobId: job.jobId, notes: notes.filter((note) => /^[A-Za-z0-9._:-]{1,200}$/u.test(note)) } }));
      } finally { await lease.closeGracefully(); }
      return;
    }
    if (args.command === "close-grant-claim") {
      assertNoG2CompetingProcess();
      const file = readG2ReadyFile(runtime.file, runtime.allocation, quantKeypairFromSeed(runtime.envelopeKey));
      const claim = readG2GrantClaim(file.jobs[0]!.tradingWalletAddress);
      const store = new PostgresQuantRebalanceStore(sql);
      const job = await store.getJob(claim.jobId);
      const actions = await store.listActions(claim.jobId);
      const journal = await PostgresExecutionJournal.attachExisting(sql);
      const journalRows = await Promise.all(actions.map((action) => journal.get(action.journalKey)));
      if (job === null || job.status === "ended-unresolved" || job.reportedAtMs === null
        || job.reportPayloadDigest === null || job.sessionPublicKey !== claim.publicKey
        || actions.some((action) => !REBALANCE_ACTION_TERMINAL.has(action.state))
        || actions.some((action, index) => action.state === "settled" && journalRows[index]?.state !== "COMMITTED"
          || action.state === "failed" && journalRows[index]?.state !== "ROLLED_BACK"
            && !(runtime.finite && action.failureCode === "submitted-failed-proven"
              && action.txHash !== null && journalRows[index]?.state === "COMMITTED"
              && journalRows[index]?.externalRef.txHash?.toLowerCase() === action.txHash.toLowerCase())
          || action.state === "aborted" && journalRows[index] !== null && journalRows[index]?.state !== "ROLLED_BACK")
        || actions.some((action) => action.resolutionJson?.includes("not-executed"))
        || file.reports.length === 0
        || file.reports.some((report) => report.quantJobId !== claim.jobId || digest(report.payload) !== job.reportPayloadDigest)) {
        throw new Error("g2-close-ledger-or-report-unverified");
      }
      const reader = createQuantChainReader({ rpcUrls: [runtime.rpcUrl] });
      const finalized = await reader.finalizedBlock();
      const client = createPublicClient({ chain: bsc, transport: http(runtime.rpcUrl) });
      const valid = await client.readContract({ address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI,
        functionName: "isValidKey", args: [claim.wallet, claim.keyId], blockNumber: finalized.number });
      if (valid || finalized.timestampSec < BigInt(claim.expirySec)) throw new Error("g2-authority-still-live-or-unproven");
      const proof = { blockNumber: finalized.number.toString(10), blockHash: finalized.hash,
        timestampSec: Number(finalized.timestampSec), keyId: claim.keyId, expired: true as const };
      if (!args.yesLive) {
        console.log(JSON.stringify({ data: { kind: "close-grant-claim", verdict: "preview", jobId: claim.jobId,
          keyId: claim.keyId, blockNumber: proof.blockNumber, blockHash: proof.blockHash,
          reportDigest: job.reportPayloadDigest, writes: false } }));
        return;
      }
      const archive = closeG2GrantClaim(claim, proof);
      console.log(JSON.stringify({ data: { kind: "close-grant-claim", verdict: "archived", jobId: claim.jobId,
        archive, reportDigest: job.reportPayloadDigest } }));
      return;
    }
    if (args.command === "status" || args.command === "resolve" || args.command === "retire") {
      if (args.command !== "status") readG2ReadyFile(runtime.file, runtime.allocation, quantKeypairFromSeed(runtime.envelopeKey));
      if (args.command === "status") {
        const claim = findG2GrantClaimForFile(runtime.file);
        console.log(JSON.stringify({ data: { kind: "g2-public-claim", state: claim?.state ?? "absent",
          jobId: claim?.jobId ?? g2JobForFile(runtime.file).mapping.job, keyId: claim?.keyId ?? null,
          expirySec: claim?.expirySec ?? null, outputDigest: claim?.outputDigest ?? null } }));
      }
      const ports = await createQuantRebalanceCliPorts(process.env, true, undefined, sql);
      try {
        const legacy = args.command === "status" ? { command: "status" as const, jobId: args.jobId }
          : args.command === "retire" ? { command: "retire" as const, jobId: args.jobId, yesLive: args.yesLive }
            : { command: "resolve" as const, actionId: args.actionId, proofMode: args.proofMode,
              ...(args.txHash === undefined ? {} : { txHash: args.txHash }), yesLive: args.yesLive };
        const result = await runQuantRebalanceOperatorCommand(legacy, ports);
        console.log(safeQuantRebalanceCliJson(result));
        if (result.error !== undefined) process.exitCode = 1;
      } finally { await ports.close?.(); }
      return;
    }
    throw new Error("g2-command-not-ready");
  } finally { await sql.close(); }
}

async function main(): Promise<void> {
  try {
    const args = parseQuantRebalanceOperatorArgs(process.argv.slice(2));
    if (args.command === "prepare-self-test-db" || args.command === "self-test" || args.command === "worker"
      || args.command === "closeout-report"
      || args.command === "close-grant-claim" || "file" in args && args.file !== undefined) {
      await runG2Command(args);
      return;
    }
    const ports = await createQuantRebalanceCliPorts(process.env, args.command !== "config-check");
    try {
      const result = await runQuantRebalanceOperatorCommand(args, ports);
      console.log(safeQuantRebalanceCliJson(result));
      if (result.error !== undefined) process.exitCode = 1;
    } finally { await ports.close?.(); }
  } catch (error) {
    // G2 refusals are fixed literal codes; the runbook's stop conditions need them.
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code : error instanceof Error && /^g2-[a-z0-9-]{1,80}$/u.test(error.message) ? error.message : "command-failed";
    console.error(`live-quant-rebalance: ${sanitizeMessage(code)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exitCode = 1; });
}
