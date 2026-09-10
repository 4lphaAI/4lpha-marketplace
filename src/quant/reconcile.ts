/**
 * Phase 0: drive every non-terminal action to the truth, BEFORE any decision
 * (QUANT-GRID R2.2, R3.3, R5.2, R6.1, R7.3, R7.4).
 *
 * ─── THE INVARIANT THIS FILE EXISTS FOR ────────────────────────────────────
 *
 * A level with ANY non-terminal action is BLOCKED and cannot receive a new
 * intent. So a COMMITTED buy whose level update was lost is found HERE, by its
 * journal state, and settled before any new decision is made. That is what
 * kills the double buy — not a heuristic, and not a timeout.
 *
 * ─── THERE IS NO ABSENCE PROOF IN v1 (R6.1) ────────────────────────────────
 *
 * `resolve --invalidated` and the `eth_getLogs` invalidation scan are DELETED.
 * Silence, elapsed time and unchanged balances never release a possibly
 * submitted action. An action that is `submitted` with a journal row that never
 * obtained a `callsId` has exactly two exits:
 *
 *   - POSITIVE EVIDENCE — `resolve --calls-id-read` (the journal later learns a
 *     callsId) or `resolve --tx <hash>` under R7.1 identity, which SETTLES it;
 *   - RETIREMENT — after the key is dead on-chain AND the router deadline has
 *     passed at a finalized block, `live-quant retire-level`, which is
 *     PERMANENT.
 *
 * Disclosed consequence: a lost relay response can idle one level until the
 * session expires. That is the fail-closed price of not double-buying. Funds
 * never leave the client's wallet either way.
 *
 * ─── THE JOURNAL API RULE (R3.3, second half) ──────────────────────────────
 *
 * NO code path here calls `markRolledBack` or `markCommitted` on an UNKNOWN
 * journal row: the transition table forbids it and PHASE3.14 deliberately left
 * it so. Evidence-based resolution moves the ACTION and the LEVEL only; the
 * journal row stays UNKNOWN with `quant_actions.resolution_json` as the record,
 * and `status` shows both.
 */
import { getAddress, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { accountKeyHashForAddress } from "../wallet/altana.js";
import type { ExecutionJournal, JournalEntry } from "../store/journal.js";
import type {
  QuantActionRow,
  QuantJobRow,
  QuantJobStore,
} from "../store/quantJobs.js";
import type { WalletProvider, WalletCall } from "../core/types.js";
import type { QuantChainReader } from "./readers.js";
import { verifyQuantFill, type VerifiedFill } from "./receipt.js";
import { ceilDiv, DUST_WEI, feeEstInU, partitionExit } from "./grid.js";
import type { QuantStrategyParams } from "./config.js";

export type QuantReconcileDeps = {
  readonly store: QuantJobStore;
  readonly journal: ExecutionJournal;
  readonly provider: WalletProvider;
  readonly reader: QuantChainReader;
  readonly params: QuantStrategyParams;
  readonly venue: {
    readonly router: Address;
    readonly u: Address;
    readonly wbnb: Address;
    readonly pair: Address;
  };
  readonly nowMs: () => number;
};

export type QuantReconcileOutcome = {
  readonly journalKey: string;
  /** The R3.3 cell that decided, named, so `status` can show it verbatim. */
  readonly cell: string;
  readonly settled: boolean;
  readonly released: boolean;
};

/** Two full submit windows plus margin, the journal's own guard, restated. */
const SUBMIT_TIMEOUT_MS = 45_000;

function parseCalls(callsJson: string): readonly WalletCall[] {
  const parsed: unknown = JSON.parse(callsJson);
  if (!Array.isArray(parsed)) throw new Error("Persisted calls are malformed.");
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      to: getAddress(String(record["to"])),
      ...(record["value"] === undefined || record["value"] === null
        ? {}
        : { value: BigInt(String(record["value"])) }),
      ...(record["data"] === undefined || record["data"] === null
        ? {}
        : { data: String(record["data"]) as Hex }),
    };
  });
}

/**
 * Verify a candidate transaction against ONE action, and settle it if it holds.
 *
 * `settleAction` accepts ONLY a fill produced here (M1 / R2.4): no indexer row
 * and no bare operator hash can reach inventory, and a boundary test asserts
 * this module never imports the indexer parser.
 */
export async function verifyAndSettle(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  txHash: Hex,
): Promise<{ readonly ok: true; readonly fill: VerifiedFill } | { readonly ok: false; readonly code: string }> {
  if (job.sessionPublicKey === null) return { ok: false, code: "session-unknown" };
  const [transaction, receipt] = await Promise.all([
    deps.reader.getTransaction(txHash),
    deps.reader.getReceipt(txHash),
  ]);
  if (transaction === null || receipt === null) return { ok: false, code: "receipt-absent" };
  // R7.4: a positive receipt is accepted at any canonical block from the
  // persisted finalized ancestor through the action's deadline block. There is
  // no other cutoff; Revision 2's 200-block window is withdrawn.
  if (action.submitFinalizedNumber !== null
    && receipt.blockNumber < action.submitFinalizedNumber) {
    return { ok: false, code: "receipt-before-anchor" };
  }
  let calls: readonly WalletCall[];
  try {
    calls = parseCalls(action.callsJson);
  } catch {
    return { ok: false, code: "calls-malformed" };
  }
  const { keyHash } = sessionIdentity(job);
  const verdict = verifyQuantFill({
    transaction,
    receipt,
    tradingWallet: getAddress(job.tradingWallet),
    sessionKeyHash: keyHash,
    calls,
    pair: deps.venue.pair,
    tokenIn: action.side === "buy" ? deps.venue.u : deps.venue.wbnb,
    tokenOut: action.side === "buy" ? deps.venue.wbnb : deps.venue.u,
    amountInWei: action.amountInWei,
    minOutWei: action.minOutWei,
  });
  if (!verdict.ok) return { ok: false, code: verdict.code };
  const settled = await settleVerified(deps, job, action, verdict.fill);
  return settled ? { ok: true, fill: verdict.fill } : { ok: false, code: "settle-conflict" };
}

/** The account key hash for the job's ADMITTED public key. No key is opened. */
function sessionIdentity(job: QuantJobRow): { readonly keyHash: Hex } {
  if (job.sessionPublicKey === null) throw new Error("The job has no admitted session key.");
  return { keyHash: accountKeyHashForAddress(publicKeyToAddress(job.sessionPublicKey)) };
}

/**
 * Move inventory. ONE CAS, idempotent on `action.state`, and the only place in
 * this plane that changes what a level owns.
 */
async function settleVerified(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  fill: VerifiedFill,
): Promise<boolean> {
  const levels = await deps.store.listLevels(job.quantJobId);
  const level = levels.find((row) => row.levelIndex === action.levelIndex);
  if (level === undefined) return false;
  const nowMs = deps.nowMs();
  if (action.side === "buy") {
    // The buy's cycle opens: the exact WBNB the later sells will spend, and
    // the exact U it cost. `entryCostUWei` is ONE fee estimate (R5.6) valued at
    // the fill's own price, and it is charged to the cycle, never measured.
    const midE18 = fill.fillOutWei === 0n
      ? 0n
      : (fill.fillInWei * 10n ** 18n) / fill.fillOutWei;
    const entryCostUWei = feeEstInU(deps.params, midE18);
    const plan = job.wbnbCapMinLimitWei > 0n
      ? partitionExit(fill.fillOutWei, job.wbnbCapMinLimitWei)
      : [fill.fillOutWei];
    const result = await deps.store.settleAction({
      journalKey: action.journalKey,
      quantJobId: job.quantJobId,
      levelIndex: action.levelIndex,
      txHash: fill.txHash,
      swapLogIndex: fill.swapLogIndex,
      fillInWei: fill.fillInWei,
      fillOutWei: fill.fillOutWei,
      feeDeltaWei: null,
      entryCostUWei,
      nextLevelState: "holding-base",
      nextBaseWei: fill.fillOutWei,
      nextBaseAtCycleStartWei: fill.fillOutWei,
      nextBasisUWei: fill.fillInWei,
      cyclesClosedDelta: 0,
      realizedDeltaUWei: 0n,
      residualDeltaWei: 0n,
      // BC29: the plan is a SNAPSHOT of the partition, not of the floors. Every
      // chunk's floor is recomputed with the CURRENT fee valuation before every
      // intent, so a stale valuation can never admit a sell that no longer
      // covers its own gas.
      exitPlanJson: JSON.stringify({
        chunks: plan.map((chunk) => chunk.toString(10)),
        capLimitWei: job.wbnbCapMinLimitWei.toString(10),
      }),
      nowMs,
    });
    return result.kind === "ok";
  }
  const remaining = level.baseWei > action.amountInWei
    ? level.baseWei - action.amountInWei
    : 0n;
  const closes = remaining < DUST_WEI;
  // The realized delta is the cycle's PROCEEDS minus the share of basis this
  // chunk carried. The final chunk carries the rounding residual, so the sum of
  // the shares equals the basis exactly (R4.4).
  const basisShare = closes
    ? level.basisUWei
    : ceilDiv(level.basisUWei * action.amountInWei, level.baseAtCycleStartWei || 1n);
  const result = await deps.store.settleAction({
    journalKey: action.journalKey,
    quantJobId: job.quantJobId,
    levelIndex: action.levelIndex,
    txHash: fill.txHash,
    swapLogIndex: fill.swapLogIndex,
    fillInWei: fill.fillInWei,
    fillOutWei: fill.fillOutWei,
    feeDeltaWei: null,
    entryCostUWei: closes ? 0n : level.entryCostUWei,
    nextLevelState: closes ? "armed-quote" : "holding-base",
    nextBaseWei: closes ? 0n : remaining,
    nextBaseAtCycleStartWei: closes ? 0n : level.baseAtCycleStartWei,
    nextBasisUWei: closes ? 0n : level.basisUWei - basisShare,
    cyclesClosedDelta: closes ? 1 : 0,
    realizedDeltaUWei: fill.fillOutWei - basisShare,
    // A cycle that closes with an unsold remainder records it as RESIDUAL, and
    // the level keeps it as unattributed inventory (R7.2). Nothing is dropped.
    residualDeltaWei: closes ? remaining : 0n,
    exitPlanJson: closes ? null : level.exitPlanJson,
    nowMs,
  });
  return result.kind === "ok";
}

/**
 * The R3.3 table, driven for every non-terminal action of one job.
 *
 * ONE bounded read per action per cycle. No polling loop, no `awaitExecution`.
 */
export async function recoverUnsettledActions(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
): Promise<readonly QuantReconcileOutcome[]> {
  const actions = await deps.store.listNonTerminalActions(job.quantJobId);
  const outcomes: QuantReconcileOutcome[] = [];
  for (const action of actions) {
    outcomes.push(await recoverOne(deps, job, action));
  }
  return outcomes;
}

async function recoverOne(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
): Promise<QuantReconcileOutcome> {
  const entry = await deps.journal.get(action.journalKey);
  const nowMs = deps.nowMs();

  /* journal: none */
  if (entry === null) {
    if (action.state === "intended") {
      // R5.2: the abort is a CAS on the SAME row and version the sender's
      // `intended → submitted` CAS uses, so exactly one of the two wins. Only a
      // recovery that WON may touch the journal; one that lost does nothing.
      const aborted = await deps.store.abortIntent({
        journalKey: action.journalKey,
        expectedRowVersion: action.rowVersion,
        nowMs,
      });
      return {
        journalKey: action.journalKey,
        cell: "none/intended",
        settled: false,
        released: aborted.kind === "ok",
      };
    }
    // A `submitted` action with no journal row is impossible by construction
    // (the CAS runs after `begin`), so it is an operator matter, not a guess.
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "needs-operator",
      failureCode: `none/${action.state}`, nowMs,
    });
    return {
      journalKey: action.journalKey, cell: `none/${action.state}`,
      settled: false, released: false,
    };
  }

  switch (entry.state) {
    case "PENDING":
      return recoverPending(deps, job, action, entry, nowMs);
    case "IN_PROGRESS":
      return recoverInProgress(deps, job, action, entry, nowMs);
    case "COMMITTED":
      return recoverCommitted(deps, job, action, entry, nowMs);
    case "ROLLED_BACK":
      await deps.store.setActionState({
        journalKey: action.journalKey, state: "failed",
        failureCode: entry.lastError ?? "rolled-back", restoreLevel: true, nowMs,
      });
      return {
        journalKey: action.journalKey, cell: "ROLLED_BACK/*",
        settled: false, released: true,
      };
    case "UNKNOWN":
      return recoverUnknown(deps, job, action, entry, nowMs);
    default:
      return {
        journalKey: action.journalKey, cell: `${entry.state}/${action.state}`,
        settled: false, released: false,
      };
  }
}

async function recoverPending(
  deps: QuantReconcileDeps,
  _job: QuantJobRow,
  action: QuantActionRow,
  entry: JournalEntry,
  nowMs: number,
): Promise<QuantReconcileOutcome> {
  if (action.state === "intended") {
    // R5.2 again: the CAS decides, and only the winner may move the journal.
    // `PENDING → ROLLED_BACK` is a legal transition, and "never-submitted" is
    // TRUE here — the `submitted` CAS provably never ran.
    const aborted = await deps.store.abortIntent({
      journalKey: action.journalKey,
      expectedRowVersion: action.rowVersion,
      nowMs,
    });
    if (aborted.kind === "ok") {
      await deps.journal.markRolledBack(action.journalKey, "never-submitted");
    }
    return {
      journalKey: action.journalKey, cell: "PENDING/intended",
      settled: false, released: aborted.kind === "ok",
    };
  }
  if (entry.externalRef.callsId === undefined
    && nowMs - entry.updatedAt < 2 * SUBMIT_TIMEOUT_MS) {
    return {
      journalKey: action.journalKey, cell: "PENDING/submitted(wait)",
      settled: false, released: false,
    };
  }
  // Older than two submit windows with no callsId: the boot reconcile parks it
  // UNKNOWN. Until then, WAIT — never guess.
  return {
    journalKey: action.journalKey, cell: "PENDING/submitted",
    settled: false, released: false,
  };
}

async function recoverInProgress(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  entry: JournalEntry,
  nowMs: number,
): Promise<QuantReconcileOutcome> {
  const callsId = entry.externalRef.callsId;
  if (callsId === undefined || deps.provider.readExecutionStatus === undefined) {
    return {
      journalKey: action.journalKey, cell: "IN_PROGRESS/no-read",
      settled: false, released: false,
    };
  }
  let txHash: Hex | undefined;
  let status: "CONFIRMED" | "FAILED" | "PENDING";
  try {
    const reading = await deps.provider.readExecutionStatus({ callsId });
    status = reading.receipt.status;
    txHash = reading.receipt.transactionHash;
  } catch {
    // Relay unavailability NEVER produces a verdict here (PHASE3.14's rule one
    // layer up): the action keeps its state and the next cycle asks again.
    return {
      journalKey: action.journalKey, cell: "IN_PROGRESS/unreadable",
      settled: false, released: false,
    };
  }
  if (status === "CONFIRMED" && txHash !== undefined) {
    await deps.journal.markCommitted(action.journalKey, { txHash });
    const verdict = await verifyAndSettle(deps, job, action, txHash);
    if (verdict.ok) {
      return {
        journalKey: action.journalKey, cell: "IN_PROGRESS/confirmed",
        settled: true, released: true,
      };
    }
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "committed-unverified",
      failureCode: verdict.code, txHash, nowMs,
    });
    return {
      journalKey: action.journalKey, cell: "IN_PROGRESS/unverified",
      settled: false, released: false,
    };
  }
  if (status === "FAILED") {
    await deps.journal.markRolledBack(action.journalKey, "relay reported FAILED");
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "failed",
      failureCode: "relay-failed", restoreLevel: true, nowMs,
    });
    return {
      journalKey: action.journalKey, cell: "IN_PROGRESS/failed",
      settled: false, released: true,
    };
  }
  return {
    journalKey: action.journalKey, cell: "IN_PROGRESS/pending",
    settled: false, released: false,
  };
}

async function recoverCommitted(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  entry: JournalEntry,
  nowMs: number,
): Promise<QuantReconcileOutcome> {
  const txHash = entry.externalRef.txHash ?? action.txHash;
  if (txHash === null || txHash === undefined) {
    // COMMITTED with no hash: ONE bounded read for it, then the operator.
    const callsId = entry.externalRef.callsId;
    if (callsId !== undefined && deps.provider.readExecutionStatus !== undefined) {
      try {
        const reading = await deps.provider.readExecutionStatus({ callsId });
        const found = reading.receipt.transactionHash;
        if (found !== undefined) {
          const verdict = await verifyAndSettle(deps, job, action, found);
          if (verdict.ok) {
            return {
              journalKey: action.journalKey, cell: "COMMITTED-hash/found",
              settled: true, released: true,
            };
          }
        }
      } catch {
        return {
          journalKey: action.journalKey, cell: "COMMITTED-hash/unreadable",
          settled: false, released: false,
        };
      }
    }
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "needs-operator",
      failureCode: "committed-without-hash", nowMs,
    });
    return {
      journalKey: action.journalKey, cell: "COMMITTED-hash/absent",
      settled: false, released: false,
    };
  }
  const verdict = await verifyAndSettle(deps, job, action, txHash);
  if (verdict.ok) {
    return {
      journalKey: action.journalKey, cell: "COMMITTED+hash/verified",
      settled: true, released: true,
    };
  }
  // Unverifiable for 48 h ⇒ the operator. Before that, retry every cycle: a
  // reorg or a lagging node is a reason to ask again, not to decide.
  const stale = nowMs - action.createdAtMs > 48 * 60 * 60 * 1_000;
  await deps.store.setActionState({
    journalKey: action.journalKey,
    state: stale ? "needs-operator" : "committed-unverified",
    failureCode: verdict.code, txHash, nowMs,
  });
  return {
    journalKey: action.journalKey,
    cell: stale ? "COMMITTED+hash/needs-operator" : "COMMITTED+hash/unverified",
    settled: false, released: false,
  };
}

async function recoverUnknown(
  deps: QuantReconcileDeps,
  job: QuantJobRow,
  action: QuantActionRow,
  entry: JournalEntry,
  nowMs: number,
): Promise<QuantReconcileOutcome> {
  if (action.state === "intended") {
    // The submit CAS never ran, so NOTHING was sent — a durable proof of
    // non-entry, and the ONE case where an UNKNOWN journal row's action may be
    // released. The journal row itself stays UNKNOWN (R3.3, journal API rule).
    const aborted = await deps.store.abortIntent({
      journalKey: action.journalKey,
      expectedRowVersion: action.rowVersion,
      nowMs,
    });
    return {
      journalKey: action.journalKey, cell: "UNKNOWN/intended",
      settled: false, released: aborted.kind === "ok",
    };
  }
  // Positive evidence only. A `callsId` that arrived late is exactly that.
  const callsId = entry.externalRef.callsId;
  if (callsId !== undefined && deps.provider.readExecutionStatus !== undefined) {
    try {
      const reading = await deps.provider.readExecutionStatus({ callsId });
      const txHash = reading.receipt.transactionHash;
      if (reading.receipt.status === "CONFIRMED" && txHash !== undefined) {
        const verdict = await verifyAndSettle(deps, job, action, txHash);
        if (verdict.ok) {
          return {
            journalKey: action.journalKey, cell: "UNKNOWN/settled",
            settled: true, released: true,
          };
        }
      }
    } catch {
      /* Unavailability is not evidence. Ask again next cycle. */
    }
  }
  if (action.state !== "unknown") {
    await deps.store.setActionState({
      journalKey: action.journalKey, state: "unknown",
      failureCode: "journal-unknown", nowMs,
    });
  }
  return {
    journalKey: action.journalKey, cell: "UNKNOWN/blocked",
    settled: false, released: false,
  };
}

/**
 * Whether a level may be RETIRED — the only release for an action whose
 * outcome can never be established (R6.1).
 *
 * BOTH preconditions, on FINALIZED evidence:
 *   1. the key can no longer execute (`isValidKey` false, or expiry passed);
 *   2. the action's router deadline has passed at a finalized block, so any
 *      in-flight batch would revert.
 *
 * Until both hold the level stays blocked and `status` says why.
 */
export async function retirementAllowed(input: {
  readonly action: QuantActionRow;
  readonly keyIsValid: boolean;
  readonly sessionExpiry: number | null;
  readonly finalizedTimestampSec: bigint;
}): Promise<{ readonly allowed: boolean; readonly reason: string }> {
  const deadlinePassed = input.finalizedTimestampSec > BigInt(input.action.deadlineSec);
  const expired = input.sessionExpiry !== null
    && input.finalizedTimestampSec > BigInt(input.sessionExpiry);
  const keyDead = !input.keyIsValid || expired;
  if (!keyDead) return { allowed: false, reason: "session-still-valid" };
  if (!deadlinePassed) return { allowed: false, reason: "deadline-not-passed" };
  return { allowed: true, reason: "key-dead-and-deadline-passed" };
}
