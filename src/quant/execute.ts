/**
 * ONE quant action, from a durable intent to a marked journal row
 * (QUANT-GRID §5, R2.2, R3.4, R5.1, R5.6).
 *
 * ─── THE ONLY MODULE THAT SEES A SESSION KEY ───────────────────────────────
 *
 * The envelope is opened INSIDE `withJobSession`, the parsed record never
 * leaves that closure, and nothing it contains is persisted, logged, journaled
 * or put in an error message. `QuantExecuteError`'s message is built from a
 * FIXED CODE TABLE and nothing else, because an SDK error could echo request
 * material (spec §3.2). `test/quant.execute.test.ts` scans every persisted
 * string for the fixture key.
 *
 * ─── PHASE ORDER, AND WHY EACH BOUNDARY IS WHERE IT IS ─────────────────────
 *
 *   Phase 0  RECOVERY — `src/quant/reconcile.ts`, before any decision.
 *   Phase 1  INTENT — inside the job fence, in the worker. A durable
 *            `quant_actions` row plus the level's `→ blocked` CAS, in ONE
 *            transaction. Dry-run stops BEFORE this insert.
 *   Phase 2  JOURNAL BEGIN, from PUBLIC facts only. The public key comes from
 *            admission, so NO KEY IS OPENED BEFORE THE JOURNAL ROW EXISTS —
 *            the body's impossible ordering is gone and a test asserts the
 *            order by construction. `created === false` means the recovery
 *            table owns this key; return.
 *   Phase 3  OPEN and EXECUTE, in one closure. Anything thrown BEFORE
 *            `executeViaSession` is entered is pre-submit: `markRolledBack`,
 *            action `failed:<code>`, level restored. The moment the submit is
 *            entered the action is CAS'd `intended → submitted` FIRST — a store
 *            failure there ABORTS the submit, because it is still pre-submit —
 *            and from there ANY throw is `markUnknown` and the level stays
 *            blocked (PHASE2.4's positional rule).
 *
 * A post-submit store error NEVER releases the level: the action stays
 * `submitted` and the next cycle re-derives the truth from the journal. The
 * journal is the authority on submission; the action row is the authority on
 * inventory; settlement is the one CAS that moves inventory, and it is
 * idempotent.
 */
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAddress, publicKeyToAddress } from "viem/accounts";
import {
  accountKeyHashForAddress, agentAuthorityFromPrivateKey, RELAY_SUBMIT_TIMEOUT_PREFIX,
} from "../wallet/altana.js";
import { ExecutionPlaneError, ProviderError } from "../core/types.js";
import type {
  ExecutionReceipt,
  SessionRef,
  SpendInfoReading,
  WalletCall,
  WalletProvider,
} from "../core/types.js";
import type { ExecutionJournal } from "../store/journal.js";
import type { QuantWalletClaimStore } from "../store/quantWalletClaims.js";
import type { QuantActionRow, QuantJobRow, QuantJobStore } from "../store/quantJobs.js";
import {
  descriptorOf,
  openSession,
  permissionsDigest,
  projectGrantedPermissions,
  specDigest,
} from "./admission.js";
import { deriveKeypair, type QuantKeypair } from "./envelope.js";
import type { QuantStrategyParams } from "./config.js";
import type { QuantChainReader } from "./readers.js";
import { callsDigest } from "./receipt.js";
import { callsEqual } from "./receipt.js";
import { buildPancakeTokenSwap } from "../ops/pancakeTokens.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow } from "./rebalanceTypes.js";
import type { QuantJobRecord } from "./types.js";
import type { QuantRebalanceStore } from "../store/quantRebalance.js";
import { buildRebalanceCalls, validateRebalanceCalls } from "./rebalanceRoutes.js";
import { REBALANCE_ROUTER, REBALANCE_MAX_BLOCK_LAG, REBALANCE_MAX_QUOTE_AGE_MS } from "./rebalancePolicy.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type QuantExecuteCode =
  | "envelope-missing"
  | "envelope-invalid"
  | "session-changed"
  | "calls-mismatch"
  | "session-not-admissible"
  | "session-restore-unsupported"
  | "session-restore-refused"
  | "preflight-refused"
  | "meter-unreadable"
  | "meter-exhausted"
  | "no-native-grant"
  | "no-gas"
  | "store-conflict"
  | "submit-ambiguous"
  | "submit-failed"
  | "quote-stale"
  | "price-moved"
  | "worker-lease-lost"
  | "wire-changed";

/**
 * The ONE error this module throws.
 *
 * Its message is built from the code table alone: no cause, no upstream text,
 * no identifiers. An SDK error can carry request material, and a message that
 * concatenated it would put a client's calldata — and one day a key — into a
 * log line.
 */
export class QuantExecuteError extends Error {
  readonly code: QuantExecuteCode;

  constructor(code: QuantExecuteCode) {
    super(QUANT_EXECUTE_MESSAGES[code]);
    this.name = "QuantExecuteError";
    this.code = code;
  }
}

const QUANT_EXECUTE_MESSAGES: Readonly<Record<QuantExecuteCode, string>> = Object.freeze({
  "envelope-missing": "No sealed session is stored for this job.",
  "envelope-invalid": "The stored envelope did not open.",
  "session-changed": "The granted session no longer matches the admitted one.",
  "calls-mismatch": "The persisted action calls do not match the admitted task wallet.",
  "session-not-admissible": "The granted session is not admissible.",
  "session-restore-unsupported": "This provider cannot restore an externally granted session.",
  "session-restore-refused": "The granted session could not be restored.",
  "preflight-refused": "The pre-flight refused this batch before submission.",
  "meter-unreadable": "The account's spend meters could not be read.",
  "meter-exhausted": "A spend meter cannot cover this submission.",
  "no-native-grant": "The session has no native spend grant, so the relay cannot bill it.",
  "no-gas": "The task wallet does not hold enough BNB for relay gas.",
  "store-conflict": "Another process owns this action.",
  "submit-ambiguous": "The relay's answer is unknown; the action is held.",
  "submit-failed": "The relay reported the submission failed.",
  "quote-stale": "The rebalancing quote is stale and must be refreshed.",
  "price-moved": "The route or reference price changed before the submit claim.",
  "worker-lease-lost": "The worker lease was lost before the submit claim.",
  "wire-changed": "The authenticated TermiX job is no longer eligible for submission.",
});

/**
 * R14.5: classify an ambiguous submit into a FIXED token. Only the token is
 * ever emitted — never the error's message, which an SDK may have written.
 */
export function ambiguousCause(error: unknown): string {
  if (error instanceof QuantExecuteError) return `quant-${error.code}`;
  if (error instanceof ProviderError && error.message.startsWith(RELAY_SUBMIT_TIMEOUT_PREFIX)) {
    return "relay-timeout";
  }
  if (error instanceof ExecutionPlaneError) return `plane-${error.code.toLowerCase()}`;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "other";
}

/* -------------------------------------------------------------------------- */
/* Deps                                                                       */
/* -------------------------------------------------------------------------- */

export type QuantExecuteDeps = {
  readonly store: QuantJobStore;
  readonly claims?: QuantWalletClaimStore;
  readonly journal: ExecutionJournal;
  readonly provider: WalletProvider;
  readonly reader: QuantChainReader;
  readonly keypair: QuantKeypair;
  readonly params: QuantStrategyParams;
  readonly venue: {
    readonly router: Address;
    readonly u: Address;
    readonly wbnb: Address;
  };
  readonly nowMs: () => number;
  readonly signal?: AbortSignal;
};

export type QuantExecuteOutcome =
  | { readonly kind: "committed"; readonly receipt: ExecutionReceipt }
  | { readonly kind: "in-progress"; readonly receipt: ExecutionReceipt }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "rolled-back"; readonly code: QuantExecuteCode }
  | { readonly kind: "unknown"; readonly code: QuantExecuteCode }
  | { readonly kind: "replay" };

/* -------------------------------------------------------------------------- */
/* The one closure that holds a session                                       */
/* -------------------------------------------------------------------------- */

export type OpenedJobSession = {
  readonly session: SessionRef;
  readonly publicKey: Hex;
  readonly keyHash: Hex;
  readonly walletAddress: Address;
};

function parsePersistedCalls(callsJson: string): readonly WalletCall[] | null {
  try {
    const value: unknown = JSON.parse(callsJson);
    if (!Array.isArray(value)) return null;
    return value.map((item) => {
      if (typeof item !== "object" || item === null) throw new Error("calls");
      const record = item as Record<string, unknown>;
      if (typeof record["to"] !== "string") throw new Error("calls");
      return {
        to: getAddress(record["to"]),
        value: BigInt(String(record["value"] ?? "0")),
        data: String(record["data"] ?? "0x") as Hex,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Open the persisted envelope, verify it is STILL the admitted session, and
 * build a live `SessionRef` — then drop everything else.
 *
 * `permissions_digest` and `projection_digest` must BOTH reproduce (R2.1): a
 * client who re-grants mid-term gets a new admission, never a silently
 * different key running under an old one's bookkeeping.
 */
export async function withJobSession<T>(
  deps: Pick<QuantExecuteDeps, "provider" | "keypair" | "params" | "venue" | "nowMs">,
  job: QuantJobRow,
  work: (opened: OpenedJobSession) => Promise<T>,
): Promise<T> {
  if (job.envelopeJson === null) throw new QuantExecuteError("envelope-missing");
  let envelope: unknown;
  try {
    envelope = JSON.parse(job.envelopeJson);
  } catch {
    throw new QuantExecuteError("envelope-invalid");
  }
  const opened = openSession(
    envelope as Parameters<typeof openSession>[0],
    deps.keypair,
  );
  if (!opened.ok) throw new QuantExecuteError("envelope-invalid");
  const plaintext = opened.session;
  if (job.sessionPublicKey === null
    || plaintext.publicKey.toLowerCase() !== job.sessionPublicKey.toLowerCase()) {
    throw new QuantExecuteError("session-changed");
  }
  if (getAddress(plaintext.walletAddress).toLowerCase() !== getAddress(job.tradingWallet).toLowerCase()) {
    throw new QuantExecuteError("session-changed");
  }
  if (job.permissionsDigest === null
    || permissionsDigest(plaintext.permissions).toLowerCase()
      !== job.permissionsDigest.toLowerCase()) {
    throw new QuantExecuteError("session-changed");
  }
  // The INJECTED clock, not `Date.now`: every expiry comparison on this path
  // must read the same clock the worker decided with, or an offline suite and
  // a live cycle disagree about whether a session is still valid.
  const nowSeconds = Math.floor(deps.nowMs() / 1_000);
  const projection = projectGrantedPermissions(plaintext.permissions, {
    expiry: plaintext.expiry,
    nowSeconds,
    termDays: job.termDays,
    walletAddress: plaintext.walletAddress,
  });
  if (!projection.ok) throw new QuantExecuteError("session-not-admissible");
  if (job.projectionDigest === null
    || specDigest(projection.spec).toLowerCase() !== job.projectionDigest.toLowerCase()) {
    throw new QuantExecuteError("session-changed");
  }
  if (deps.provider.restoreGrantedSession === undefined) {
    throw new QuantExecuteError("session-restore-unsupported");
  }
  let session: SessionRef;
  try {
    session = deps.provider.restoreGrantedSession({
      walletAddress: plaintext.walletAddress,
      publicKey: plaintext.publicKey,
      expiresAt: plaintext.expiry,
      permissions: descriptorOf(plaintext),
      spec: projection.spec,
      agent: agentAuthorityFromPrivateKey(plaintext.signerPrivateKey),
    });
  } catch {
    throw new QuantExecuteError("session-restore-refused");
  }
  return work({
    session,
    publicKey: plaintext.publicKey,
    keyHash: accountKeyHashForAddress(publicKeyToAddress(plaintext.publicKey)),
    walletAddress: plaintext.walletAddress,
  });
}

/* -------------------------------------------------------------------------- */
/* Meters (R3.4, BC27, BC33)                                                  */
/* -------------------------------------------------------------------------- */

export type MeterVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "meter-unreadable" | "meter-exhausted" | "no-native-grant"; readonly detail: string };

/**
 * EVERY period row, for native AND for the token being spent (R3.4).
 *
 * `nativeDayMeter` answers about the DAY row only, which is the wrong question
 * here: a granted session may carry a MINUTE cap a day-only read reports as
 * unlimited, and a sell sized against the day row would be refused on chain
 * after the journal had already reserved it. `nativeDayMeter` is deliberately
 * NOT used by quant (R3.13 withdrew it).
 */
export async function checkQuantMeters(input: {
  readonly provider: WalletProvider;
  readonly walletAddress: Address;
  readonly publicKey: Hex;
  readonly tokenIn: Address;
  readonly amountInWei: bigint;
  readonly requiredNativeWei: bigint;
  readonly signal?: AbortSignal;
}): Promise<MeterVerdict> {
  if (input.provider.readSpendInfos === undefined) {
    return { ok: false, code: "meter-unreadable", detail: "capability" };
  }
  let rows: readonly SpendInfoReading[];
  try {
    rows = await input.provider.readSpendInfos({
      walletAddress: input.walletAddress,
      publicKey: input.publicKey,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return { ok: false, code: "meter-unreadable", detail: "read" };
  }
  const nativeRows = rows.filter((row) => row.token === null);
  // FINDINGS (h): no native row is not "unlimited" — `GuardedExecutor` finds no
  // limit for the native the relay bills and the batch reverts in simulation:
  // PENDING, no transaction, no gas, which reads like a slow relay rather than
  // a refusal. The remedy is a GRANT, not a cap raise.
  if (nativeRows.length === 0) {
    return { ok: false, code: "no-native-grant", detail: "native" };
  }
  for (const row of nativeRows) {
    if (row.limitWei - row.currentSpentWei < input.requiredNativeWei) {
      return { ok: false, code: "meter-exhausted", detail: `native:${row.period}` };
    }
  }
  const tokenKey = getAddress(input.tokenIn).toLowerCase();
  const tokenRows = rows.filter(
    (row) => row.token !== null && row.token.toLowerCase() === tokenKey,
  );
  if (tokenRows.length === 0) {
    return { ok: false, code: "meter-exhausted", detail: `${tokenKey}:absent` };
  }
  for (const row of tokenRows) {
    if (row.limitWei - row.currentSpentWei < input.amountInWei) {
      return { ok: false, code: "meter-exhausted", detail: `${tokenKey}:${row.period}` };
    }
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Phase 2 + Phase 3                                                          */
/* -------------------------------------------------------------------------- */

export type SubmitQuantActionInput = {
  readonly job: QuantJobRow;
  readonly action: QuantActionRow;
  readonly calls: readonly WalletCall[];
  readonly requiredNativeWei: bigint;
  readonly tokenIn: Address;
};

/**
 * Phases 2 and 3 for one action. The intent already exists durably.
 *
 * Returns an OUTCOME rather than throwing, because every failure here has a
 * durable consequence the caller must record and a thrown error would let a
 * caller skip it.
 */
export async function submitQuantAction(
  deps: QuantExecuteDeps,
  input: SubmitQuantActionInput,
): Promise<QuantExecuteOutcome> {
  const { job, action } = input;
  const nowMs = deps.nowMs();

  /* Phase 2 — the journal row, from PUBLIC facts only. */
  const paramsHash = keccak256(stringToHex(JSON.stringify({
    job: job.quantJobId,
    level: action.levelIndex,
    seq: action.actionSeq,
    side: action.side,
    amountIn: action.amountInWei.toString(10),
    minOut: action.minOutWei.toString(10),
    deadline: action.deadlineSec,
    paramsDigest: job.paramsDigest,
  })));
  const publicKey = job.sessionPublicKey;
  if (publicKey === null) {
    await failPreSubmit(deps, action, "session-not-admissible", nowMs);
    return { kind: "rolled-back", code: "session-not-admissible" };
  }
  const beginInput = {
    idempotencyKey: action.journalKey,
    agentId: job.quantJobId,
    ownerAddress: getAddress(job.tradingWallet),
    kind: "quantTrade",
    decisionId: action.journalKey,
    externalRef: {
      paramsHash,
      callsHash: callsDigest(input.calls),
      publicKey,
    },
    // The legs move NO native. The relay's fee is metered by the ACCOUNT, not
    // by us, so a non-zero figure here would double-count it against a cap this
    // plane does not own.
    nativeSpendWei: 0n,
  } as const;
  let begun: Awaited<ReturnType<ExecutionJournal["beginWithSpend"]>> | null;
  if (deps.claims === undefined) {
    begun = await deps.journal.beginWithSpend(beginInput, nowMs);
  } else if (job.claimGeneration === undefined || job.claimGeneration === null) {
    begun = null;
  } else {
    begun = await deps.claims.withWalletFence(getAddress(job.tradingWallet), async (tx) => {
      const active = await deps.claims?.isActive({ wallet: getAddress(job.tradingWallet), strategyKind: "grid",
        strategyId: job.strategyId, jobId: job.quantJobId, generation: job.claimGeneration! }, tx) ?? false;
      return active ? deps.journal.beginWithSpend(beginInput, nowMs) : null;
    });
  }
  if (begun === null) {
    await failPreSubmit(deps, action, "store-conflict", nowMs);
    return { kind: "rolled-back", code: "store-conflict" };
  }
  if (!begun.created) {
    // The recovery table owns this key. Never re-open, never re-submit.
    return { kind: "replay" };
  }

  /* Phase 3 — open, check, CAS, submit. */
  let receipt: ExecutionReceipt;
  let submitEnteredAtMs: number | null = null;
  try {
    receipt = await withJobSession(deps, job, async (opened) => {
      const rebuiltCalls = buildPancakeTokenSwap({
        router: deps.venue.router,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenIn.toLowerCase() === deps.venue.u.toLowerCase()
          ? deps.venue.wbnb : deps.venue.u,
        amountInWei: action.amountInWei,
        minOutWei: action.minOutWei,
        recipient: opened.walletAddress,
        deadline: BigInt(action.deadlineSec),
      });
      const persistedCalls = parsePersistedCalls(action.callsJson);
      if (persistedCalls === null || !callsEqual(input.calls, persistedCalls)
        || !callsEqual(persistedCalls, rebuiltCalls)) {
        throw new QuantExecuteError("calls-mismatch");
      }
      const requiredNativeWei = action.requiredNativeWei ?? input.requiredNativeWei;
      await deps.provider.preflightExecute({
        session: opened.session,
        calls: rebuiltCalls,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      const meters = await checkQuantMeters({
        provider: deps.provider,
        walletAddress: opened.walletAddress,
        publicKey: opened.publicKey,
        tokenIn: input.tokenIn,
        amountInWei: action.amountInWei,
        requiredNativeWei,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      if (!meters.ok) throw new QuantExecuteError(meters.code);
      // R5.1: the finalized ancestor is read IMMEDIATELY before the CAS and
      // persisted IN it, so a later positive resolution has a lower bound that
      // `latest` could never give it.
      const finalized = await deps.reader.finalizedBlock();
      const claimInput = {
        journalKey: action.journalKey,
        expectedRowVersion: action.rowVersion,
        ...(deps.claims === undefined ? {} : { claimGeneration: job.claimGeneration ?? null }),
        submitFinalizedNumber: finalized.number,
        submitFinalizedHash: finalized.hash,
        nowMs: deps.nowMs(),
      } as const;
      const claimed = deps.claims === undefined
        ? await deps.store.markActionSubmitted(claimInput)
        : job.claimGeneration === undefined || job.claimGeneration === null
          ? { kind: "conflict" as const, record: await deps.store.getAction(action.journalKey) }
          : await deps.claims.withWalletFence(getAddress(job.tradingWallet), async (tx) => {
            const active = await deps.claims?.isActive({ wallet: getAddress(job.tradingWallet), strategyKind: "grid",
              strategyId: job.strategyId, jobId: job.quantJobId, generation: job.claimGeneration! }, tx) ?? false;
            if (!active) return { kind: "conflict" as const, record: await deps.store.getAction(action.journalKey) };
            return deps.store.markActionSubmitted(claimInput, tx);
          });
      // A store failure HERE is still PRE-SUBMIT and aborts the submit: nothing
      // has been sent, so the honest outcome is a rollback, not a hold.
      if (claimed.kind !== "ok") throw new QuantExecuteError("store-conflict");
      // ─── FROM HERE EVERY THROW IS AMBIGUOUS ───────────────────────────────
      submitEnteredAtMs = deps.nowMs();
      return deps.provider.executeViaSession({
        session: opened.session,
        calls: rebuiltCalls,
        bypassLocalPolicyCheck: false,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
    });
  } catch (error) {
    const current = await deps.store.getAction(action.journalKey);
    const entered = current !== null && current.state !== "intended";
    const code = error instanceof QuantExecuteError ? error.code : "submit-ambiguous";
    if (!entered) {
      await deps.journal.markRolledBack(
        action.journalKey, `Quant action refused before submit: ${code}.`,
      );
      await deps.store.setActionState({
        journalKey: action.journalKey,
        state: "failed",
        failureCode: code,
        restoreLevel: true,
        nowMs: deps.nowMs(),
      });
      return { kind: "rolled-back", code: code as QuantExecuteCode };
    }
    // R14.5: a token from a FIXED vocabulary plus our own clock — never the
    // SDK/relay message text.
    const waitedMs = submitEnteredAtMs === null ? null : deps.nowMs() - submitEnteredAtMs;
    await deps.journal.markUnknown(
      action.journalKey,
      `Quant submission outcome is unknown; held for reconciliation. cause=${ambiguousCause(error)}`
        + (waitedMs === null ? "" : ` waited_ms=${waitedMs}`),
    );
    await deps.store.setActionState({
      journalKey: action.journalKey,
      state: "unknown",
      failureCode: code,
      nowMs: deps.nowMs(),
    });
    return { kind: "unknown", code: "submit-ambiguous" };
  }

  /* Post-submit marks. A store error here NEVER releases the level. */
  if (receipt.callsId !== undefined) {
    await deps.journal.markInProgress(action.journalKey, { callsId: receipt.callsId });
  }
  if (receipt.status === "CONFIRMED") {
    await deps.journal.markCommitted(
      action.journalKey,
      receipt.transactionHash === undefined ? {} : { txHash: receipt.transactionHash },
    );
    // NOT settled yet: `committed-unverified` is the honest state until the
    // receipt has been READ and verified (R6.2/R7.1). A COMMITTED journal row
    // is evidence a submission landed, not evidence of what it did.
    await deps.store.setActionState({
      journalKey: action.journalKey,
      state: "committed-unverified",
      ...(receipt.transactionHash === undefined ? {} : { txHash: receipt.transactionHash }),
      nowMs: deps.nowMs(),
    });
    return { kind: "committed", receipt };
  }
  if (receipt.status === "FAILED") {
    const code = receipt.failureCode ?? "submit-failed";
    await deps.journal.markRolledBack(action.journalKey, `Quant submission FAILED: ${code}.`);
    await deps.store.setActionState({
      journalKey: action.journalKey,
      state: "failed",
      failureCode: code,
      restoreLevel: true,
      nowMs: deps.nowMs(),
    });
    return { kind: "failed", code };
  }
  // PENDING: the relay accepted it and has not answered. IN_PROGRESS in the
  // journal, `submitted` in the store, level stays blocked, R3.3 resolves it.
  return { kind: "in-progress", receipt };
}

async function failPreSubmit(
  deps: QuantExecuteDeps,
  action: QuantActionRow,
  code: QuantExecuteCode,
  nowMs: number,
): Promise<void> {
  await deps.store.setActionState({
    journalKey: action.journalKey,
    state: "failed",
    failureCode: code,
    restoreLevel: true,
    nowMs,
  });
}

/**
 * The worker's X25519 pair, derived from the seed.
 *
 * It lives HERE, in the one module the spec already designates as the place a
 * session key may be seen, because R3.11 pins `deriveKeypair` to a direct named
 * import from exactly two files and names the COMPOSITION ROOTS as files that
 * must import neither. `scripts/quant-worker.ts` and `scripts/live-quant.ts`
 * therefore take this wrapper instead of the primitive, and
 * `test/quant.boundary.test.ts` enforces both halves.
 *
 * The seed is not retained: only the opaque `KeyObject` and the PUBLIC key
 * leave this call.
 */
export function quantKeypairFromSeed(seedHex: string): QuantKeypair {
  return deriveKeypair(seedHex);
}

/** BC12 admission opener for the rebalancer; callers never import `openSession`. */
export function openQuantRebalanceEnvelope(
  envelopeJson: string | null,
  keypair: QuantKeypair,
): ReturnType<typeof openSession> {
  if (envelopeJson === null) return { ok: false, code: "envelope-missing" };
  let envelope: unknown;
  try { envelope = JSON.parse(envelopeJson); } catch { return { ok: false, code: "envelope-invalid" }; }
  return openSession(envelope as Parameters<typeof openSession>[0], keypair);
}

/** The deterministic journal key / decision id for one action (R2.2). */
export function quantJournalKey(
  quantJobId: string,
  levelIndex: number,
  actionSeq: number,
): string {
  return keccak256(stringToHex(`quant:v1|${quantJobId}|${levelIndex}|${actionSeq}`));
}

export type OpenedQuantRebalanceSession = {
  readonly session: SessionRef;
  readonly walletAddress: Address;
  readonly publicKey: Hex;
  readonly keyHash: Hex;
};

/** The same narrow key closure for the rebalancing session. */
export async function withRebalanceJobSession<T>(
  deps: Pick<QuantExecuteDeps, "provider" | "keypair" | "nowMs" | "signal">,
  job: QuantRebalanceJobRow,
  work: (opened: OpenedQuantRebalanceSession) => Promise<T>,
): Promise<T> {
  if (job.envelopeJson === null || job.sessionPublicKey === null || job.permissionsDigest === null || job.projectionDigest === null) {
    throw new QuantExecuteError("envelope-missing");
  }
  let envelope: unknown;
  try { envelope = JSON.parse(job.envelopeJson); } catch { throw new QuantExecuteError("envelope-invalid"); }
  const opened = openSession(envelope as Parameters<typeof openSession>[0], deps.keypair);
  if (!opened.ok) throw new QuantExecuteError("envelope-invalid");
  const plaintext = opened.session;
  if (!addressEqual(plaintext.walletAddress, job.tradingWallet)
    || plaintext.publicKey.toLowerCase() !== job.sessionPublicKey.toLowerCase()
    || plaintext.expiry !== job.sessionExpirySec
    || permissionsDigest(plaintext.permissions).toLowerCase() !== job.permissionsDigest.toLowerCase()) {
    throw new QuantExecuteError("session-changed");
  }
  try {
    if (privateKeyToAddress(plaintext.signerPrivateKey).toLowerCase()
      !== publicKeyToAddress(plaintext.publicKey).toLowerCase()) throw new Error("identity");
  } catch { throw new QuantExecuteError("session-changed"); }
  const nowSeconds = Math.floor(deps.nowMs() / 1_000);
  const projection = projectGrantedPermissions(plaintext.permissions, {
    expiry: plaintext.expiry, nowSeconds, termDays: job.termDays,
    walletAddress: plaintext.walletAddress,
  });
  if (!projection.ok || specDigest(projection.spec).toLowerCase() !== job.projectionDigest.toLowerCase()) {
    throw new QuantExecuteError("session-changed");
  }
  if (deps.provider.restoreGrantedSession === undefined) throw new QuantExecuteError("session-restore-unsupported");
  let session: SessionRef;
  try {
    session = deps.provider.restoreGrantedSession({
      walletAddress: plaintext.walletAddress, publicKey: plaintext.publicKey,
      expiresAt: plaintext.expiry, permissions: descriptorOf(plaintext), spec: projection.spec,
      agent: agentAuthorityFromPrivateKey(plaintext.signerPrivateKey),
    });
  } catch { throw new QuantExecuteError("session-restore-refused"); }
  return work({
    session, walletAddress: plaintext.walletAddress, publicKey: plaintext.publicKey,
    keyHash: accountKeyHashForAddress(publicKeyToAddress(plaintext.publicKey)),
  });
}

function addressEqual(a: string, b: string): boolean { return getAddress(a).toLowerCase() === getAddress(b).toLowerCase(); }

export type QuantRebalanceSubmitOutcome =
  | { readonly kind: "replay" }
  | { readonly kind: "committed"; readonly receipt: ExecutionReceipt }
  | { readonly kind: "pending"; readonly receipt: ExecutionReceipt }
  | { readonly kind: "unknown"; readonly code: string }
  | { readonly kind: "refused"; readonly code: string };

/** Worker singleton cancellation is a pre-submit refusal until execute entry. */
export function quantRebalanceWorkerLeaseOpen(signal?: AbortSignal): boolean {
  return signal?.aborted !== true;
}

/** Immutable row identity plus mutable TermiX liveness at the submit boundary. */
export function quantRebalanceWireMatchesJob(job: QuantRebalanceJobRow, wire: QuantJobRecord | null): boolean {
  return wire !== null && wire.status === "ACTIVE" && wire.revokedAtMs === null
    && wire.id === job.jobId && wire.strategyId === job.strategyId
    && wire.tradingWalletAddress.toLowerCase() === job.tradingWallet.toLowerCase()
    && wire.allocationUWei === job.allocationWei && wire.dailyCapUWei === job.dailyCapWei
    && wire.termDays === job.termDays && wire.startedAtMs === job.startedAtMs
    && wire.endsAtMs === job.endsAtMs && wire.sessionExpiresAtMs === job.sessionExpiresAtMs;
}

export type QuantRebalanceExecuteDeps = {
  readonly store: QuantRebalanceStore;
  readonly journal: ExecutionJournal;
  readonly provider: WalletProvider;
  readonly reader: QuantChainReader;
  readonly keypair: QuantKeypair;
  readonly nowMs: () => number;
  /** Hash-pinned route/reference, balance and accounting re-read immediately before the claim. */
  readonly revalidatePlan: (input: { readonly job: QuantRebalanceJobRow; readonly action: QuantRebalanceActionRow; readonly finalized: Awaited<ReturnType<QuantChainReader["finalizedBlock"]>> }) => Promise<boolean>;
  /** Authenticated public job wire reread at the submit boundary. */
  readonly readCurrentWire: (job: QuantRebalanceJobRow) => Promise<QuantJobRecord | null>;
  readonly signal?: AbortSignal;
};

/** Journal-first execute closure for one already-persisted rebalancing action. */
export async function submitQuantRebalanceAction(
  deps: QuantRebalanceExecuteDeps,
  input: {
    readonly job: QuantRebalanceJobRow;
    readonly action: QuantRebalanceActionRow;
    readonly calls: readonly WalletCall[];
    readonly requiredNativeWei: bigint;
  },
): Promise<QuantRebalanceSubmitOutcome> {
  const { job, action } = input;
  const persistedAction = await deps.store.getAction(action.actionId);
  if (persistedAction === null) return { kind: "refused", code: "action-missing" };
  if (!(persistedAction.state === "intended" && persistedAction.rowVersion === action.rowVersion)) {
    return { kind: "refused", code: "action-terminal-or-stale" };
  }
  if (job.sessionPublicKey === null || job.policyDigest === null || job.permissionsDigest === null || job.projectionDigest === null) {
    return { kind: "refused", code: "session-not-admissible" };
  }
  const paramsHash = keccak256(stringToHex(JSON.stringify({
    strategy: job.strategyId, job: job.jobId, policy: job.policyDigest, check: action.checkId,
    sequence: action.sequence.toString(10), side: action.side, asset: action.asset,
    tokenIn: action.tokenIn.toLowerCase(), tokenOut: action.tokenOut.toLowerCase(),
    path: action.path.map((token) => token.toLowerCase()), amountIn: action.amountInWei.toString(10),
    minOut: action.minOutWei.toString(10), deadline: action.deadlineSec,
  })));
  const journalBegin = {
    idempotencyKey: action.journalKey, agentId: job.jobId, ownerAddress: getAddress(job.tradingWallet),
    kind: "quantTrade", decisionId: action.journalKey,
    externalRef: { paramsHash, callsHash: callsDigest(input.calls), publicKey: job.sessionPublicKey },
    nativeSpendWei: 0n,
  } as const;
  let journalStarted: Awaited<ReturnType<typeof deps.store.beginJournalForIntended>>;
  try {
    journalStarted = await deps.store.beginJournalForIntended({ actionId: action.actionId,
      expectedRowVersion: action.rowVersion, claimGeneration: action.claimGeneration,
      journalBegin: { journal: deps.journal, input: journalBegin, sinceMs: 0 }, nowMs: deps.nowMs() });
  } catch { return { kind: "refused", code: "journal-begin-failed" }; }
  if (journalStarted.kind !== "ok") return journalStarted.kind === "inconsistent" && journalStarted.code === "action-unresolved"
    ? { kind: "replay" }
    : { kind: "refused", code: journalStarted.kind === "inconsistent" ? journalStarted.code : "action-state-changed" };
  const afterJournalBegin = await deps.store.getAction(action.actionId);
  if (afterJournalBegin === null || afterJournalBegin.state !== "intended"
    || afterJournalBegin.rowVersion !== action.rowVersion) return { kind: "refused", code: "action-state-changed" };

  let submitEntered = false;
  try {
    if (!quantRebalanceWorkerLeaseOpen(deps.signal)) throw new QuantExecuteError("worker-lease-lost");
    const receipt = await withRebalanceJobSession(deps, job, async (opened) => {
      const built = buildRebalanceCalls({
        router: REBALANCE_ROUTER, path: action.path, amountInWei: action.amountInWei,
        quoteOutWei: action.quoteOutWei, recipient: opened.walletAddress,
        deadlineSec: action.deadlineSec, actionSequence: action.sequence,
      });
      const persistedCalls = parsePersistedCalls(action.callsJson);
      if (built.minOutWei !== action.minOutWei || persistedCalls === null
        || !callsEqual(input.calls, persistedCalls) || !callsEqual(built.calls, persistedCalls)
        || validateRebalanceCalls({ calls: persistedCalls, router: REBALANCE_ROUTER,
          wallet: opened.walletAddress, path: action.path, amountInWei: action.amountInWei,
          minOutWei: action.minOutWei, deadlineSec: action.deadlineSec }) === null) {
        throw new QuantExecuteError("calls-mismatch");
      }
      await deps.provider.preflightExecute({ session: opened.session, calls: built.calls,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
      const meters = await checkQuantMeters({
        provider: deps.provider, walletAddress: opened.walletAddress, publicKey: opened.publicKey,
        tokenIn: action.tokenIn, amountInWei: action.amountInWei, requiredNativeWei: input.requiredNativeWei,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      if (!meters.ok) throw new QuantExecuteError(meters.code);
      if (!quantRebalanceWorkerLeaseOpen(deps.signal)) throw new QuantExecuteError("worker-lease-lost");
      const finalized = await deps.reader.finalizedBlock();
      if (deps.reader.nativeBalanceAtHash === undefined) throw new QuantExecuteError("meter-unreadable");
      const nativeBalance = await deps.reader.nativeBalanceAtHash(opened.walletAddress, finalized.hash);
      if (nativeBalance < input.requiredNativeWei) throw new QuantExecuteError("no-gas");
      if (finalized.number < action.quoteBlockNumber || finalized.number - action.quoteBlockNumber > REBALANCE_MAX_BLOCK_LAG
        || action.quoteBlockNumber !== action.referenceBlockNumber
        || action.quoteBlockHash.toLowerCase() !== action.referenceBlockHash.toLowerCase()
        || deps.nowMs() - action.quoteObservedAtMs > REBALANCE_MAX_QUOTE_AGE_MS
        || deps.nowMs() - action.referenceObservedAtMs > REBALANCE_MAX_QUOTE_AGE_MS
        || finalized.timestampSec * 1_000n > BigInt(deps.nowMs() + 1_000)
        || BigInt(deps.nowMs()) - finalized.timestampSec * 1_000n > BigInt(REBALANCE_MAX_QUOTE_AGE_MS)) {
        throw new QuantExecuteError("quote-stale");
      }
      if (!(await deps.revalidatePlan({ job, action, finalized }))) throw new QuantExecuteError("price-moved");
      const latestWire = await deps.readCurrentWire(job);
      if (latestWire === null || !quantRebalanceWireMatchesJob(job, latestWire)) throw new QuantExecuteError("wire-changed");
      const acceptedWire = latestWire;
      if (!quantRebalanceWorkerLeaseOpen(deps.signal)) throw new QuantExecuteError("worker-lease-lost");
      const chainReadAtMs = deps.nowMs();
      const claimed = await deps.store.markSubmitted({
        actionId: action.actionId, expectedRowVersion: action.rowVersion,
        claimGeneration: action.claimGeneration, blockNumber: finalized.number,
        blockHash: finalized.hash, nowMs: chainReadAtMs,
        revalidate: async (snapshot) => quantRebalanceWorkerLeaseOpen(deps.signal)
          && snapshot.job.jobId === job.jobId
          && snapshot.job.status === "admitted" && snapshot.job.platformStatus === acceptedWire.status
          && snapshot.job.revokedAtMs === acceptedWire.revokedAtMs
          && snapshot.job.tradingWallet.toLowerCase() === acceptedWire.tradingWalletAddress.toLowerCase()
          && snapshot.job.allocationWei === acceptedWire.allocationUWei
          && snapshot.job.dailyCapWei === acceptedWire.dailyCapUWei
          && snapshot.job.termDays === acceptedWire.termDays
          && snapshot.job.startedAtMs === acceptedWire.startedAtMs
          && snapshot.job.endsAtMs === acceptedWire.endsAtMs
          && snapshot.job.sessionExpiresAtMs === acceptedWire.sessionExpiresAtMs
          && snapshot.job.rowVersion === job.rowVersion
          && snapshot.job.accountingRev === action.plannedAccountingRev + 1n
          && snapshot.check.checkId === action.checkId
          && snapshot.check.rowVersion === action.plannedCheckVersion
          && snapshot.check.state === "rebalancing"
          && !snapshot.check.takenAssets.includes(action.asset)
          && snapshot.action.actionId === action.actionId
          && snapshot.action.rowVersion === action.rowVersion
          && snapshot.action.claimGeneration === job.claimGeneration
          && snapshot.job.policyDigest?.toLowerCase() === action.policyDigest.toLowerCase()
          && snapshot.job.permissionsDigest?.toLowerCase() === action.permissionsDigest.toLowerCase()
          && snapshot.job.projectionDigest?.toLowerCase() === action.projectionDigest.toLowerCase()
          && snapshot.job.revokedAtMs === null && snapshot.job.endsAtMs > chainReadAtMs
          && snapshot.job.sessionExpiresAtMs > chainReadAtMs
          && deps.nowMs() - chainReadAtMs <= REBALANCE_MAX_QUOTE_AGE_MS,
      });
      if (claimed.kind !== "ok") throw new QuantExecuteError("store-conflict");
      submitEntered = true;
      if (!quantRebalanceWorkerLeaseOpen(deps.signal)) throw new QuantExecuteError("worker-lease-lost");
      return deps.provider.executeViaSession({
        session: opened.session, calls: built.calls, bypassLocalPolicyCheck: false,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
    });
    const currentAction = await deps.store.getAction(action.actionId);
    if (currentAction === null || !(currentAction.state === "submitted" || currentAction.state === "unknown"
      || currentAction.state === "committed-unverified")) return { kind: "refused", code: "action-terminal" };
    if (receipt.callsId !== undefined) await deps.journal.markInProgress(action.journalKey, { callsId: receipt.callsId });
    if (receipt.status === "CONFIRMED") {
      await deps.journal.markCommitted(action.journalKey, receipt.transactionHash === undefined ? {} : { txHash: receipt.transactionHash });
      if (currentAction !== null) await deps.store.markAmbiguous({ actionId: action.actionId, expectedRowVersion: currentAction.rowVersion,
        state: "committed-unverified", cause: "receipt-unverified",
        ...(receipt.transactionHash === undefined ? {} : { txHash: receipt.transactionHash }), nowMs: deps.nowMs() });
      return { kind: "committed", receipt };
    }
    if (receipt.status === "FAILED") {
      await deps.journal.markUnknown(action.journalKey, "Quant submit returned FAILED; awaiting matched failure proof.");
      if (currentAction !== null) await deps.store.markAmbiguous({ actionId: action.actionId, expectedRowVersion: currentAction.rowVersion,
        state: "unknown", cause: "provider-failed-unproven", nowMs: deps.nowMs() });
      return { kind: "unknown", code: "provider-failed-unproven" };
    }
    if (receipt.callsId === undefined) {
      await deps.journal.markUnknown(action.journalKey, "Quant submit returned PENDING without a callsId.");
      if (currentAction !== null) await deps.store.markAmbiguous({ actionId: action.actionId, expectedRowVersion: currentAction.rowVersion,
        state: "unknown", cause: "pending-without-calls-id", nowMs: deps.nowMs() });
      return { kind: "unknown", code: "pending-without-calls-id" };
    }
    return { kind: "pending", receipt };
  } catch (error) {
    const code = error instanceof QuantExecuteError ? error.code : "submit-ambiguous";
    const current = await deps.store.getAction(action.actionId);
    if (current === null || current.state === "aborted" || current.state === "failed"
      || current.state === "settled" || current.state === "retired") return { kind: "refused", code: "action-terminal" };
    if (!submitEntered && current.state === "intended") {
      const journal = await deps.journal.get(action.journalKey);
      const journalState = journal === null ? "absent"
        : journal.state === "PENDING" || journal.state === "ROLLED_BACK" ? journal.state : null;
      if (journalState === null || journal !== null
        && (journal.externalRef.callsId !== undefined || journal.externalRef.txHash !== undefined)) {
        return { kind: "refused", code: "journal-entry-evidence" };
      }
      const aborted = await deps.store.abortIntendedAction({ actionId: action.actionId,
        expectedRowVersion: current.rowVersion, expectedJournalState: journalState, reasonCode: code, nowMs: deps.nowMs() });
      return aborted.kind === "ok" ? { kind: "refused", code }
        : { kind: "refused", code: aborted.kind === "inconsistent" ? aborted.code : "store-conflict" };
    }
    if (!(current.state === "submitted" || current.state === "unknown" || current.state === "committed-unverified")) {
      return { kind: "refused", code: "action-state-changed" };
    }
    await deps.journal.markUnknown(action.journalKey, `Quant rebalancing submit outcome unknown: ${ambiguousCause(error)}.`);
    const latest = await deps.store.getAction(action.actionId);
    if (latest?.state === "submitted") {
      await deps.store.markAmbiguous({ actionId: action.actionId, expectedRowVersion: latest.rowVersion,
        state: "unknown", cause: ambiguousCause(error), nowMs: deps.nowMs() });
    }
    return { kind: "unknown", code: "submit-ambiguous" };
  }
}
