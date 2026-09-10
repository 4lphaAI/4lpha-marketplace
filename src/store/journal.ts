/**
 * Execution journal.
 *
 * Ports the pattern proven in the LP sequence journal — NOT its schema — to the
 * execution plane. Two properties are load-bearing and everything else serves
 * them:
 *
 *   (a) Outcomes are READ BACK from authoritative state, never inferred from a
 *       receipt. A CONFIRMED transaction that did the wrong thing looks like
 *       success from the outside; only the chain (via awaitExecution /
 *       isSessionActive) is trusted to say what actually happened.
 *   (b) An ambiguous crash window — a call submitted but not confirmed, or a row
 *       that was begun and may or may not have been submitted — resolves to
 *       UNKNOWN and is HELD. UNKNOWN is terminal-until-operator: reconcile never
 *       auto-advances or replays it.
 *
 * ─── THE OPERATOR HALF OF (b) (PHASE3.3, review R1 / Rev2 items 4–5) ────────
 *
 * "Terminal-until-operator" named an operator with no way to act, and FINDINGS
 * (al) measured what that costs: one relay timeout left a funded mainnet
 * position with no protection and no exit, because a row with no `callsId` can
 * never be resolved by `reconcile` and a non-terminal sequence refuses every
 * saga of another kind.
 *
 * The invariant is therefore RESTATED, not relaxed:
 *
 *   `UNKNOWN` is terminal-until-operator; {@link ExecutionJournal.resolveUnknown}
 *   is the operator, and it is the ONLY write that may follow `markUnknown`.
 *
 * Mechanically: {@link assertTransition}'s base table still gives `UNKNOWN` an
 * EMPTY legal set, so `markCommitted` / `markRolledBack` still throw on an
 * UNKNOWN row on both backends and the relaxation cannot leak to `reconcile`.
 * The one edge `UNKNOWN → ROLLED_BACK` exists only on the `"resolve-unknown"`
 * transition path, which only `resolveUnknown` can name, and `resolveUnknown`
 * asserts `current.state === "UNKNOWN"` itself rather than relying on the
 * table. It never overwrites `lastError` — the reason the row went UNKNOWN is
 * history — and it records the server's own findings under
 * {@link JournalExternalRef.resolution}.
 *
 * The idempotency key is the primary key: a second `begin` with the same key
 * returns the existing row and never creates a duplicate or re-runs the work.
 */
import { keccak256, stringToHex, type Hex } from "viem";
import { sanitizeMessage } from "../core/errors.js";
import type { JournalPrincipal } from "../billing/types.js";
import type {
  AgentWalletRef,
  ExecutionReceipt,
  WalletProvider,
} from "../core/types.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

/** State of a journalled operation. */
export type JournalState =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMMITTED"
  | "ROLLED_BACK"
  | "UNKNOWN";

/**
 * What kind of operation a row records.
 *
 * `grant`, `execute`, `trade`, `lp` and `revoke` have an ON-CHAIN component, so
 * their rows are resolved against chain state. `pause`, `unpause` and
 * `changeBudget` are LOCAL-ONLY owner actions — they change what this server
 * will agree to do and place nothing on-chain — and they are journalled purely
 * so a retried owner signature is idempotent. See {@link LOCAL_ONLY_KINDS}.
 *
 * `lp` is one LP saga STEP (PHASE3-SPEC Revision 2 items 7–10): it submits via
 * the same session-key relay as `execute`/`trade` and resolves from its
 * `callsId` the same way. The saga's ORDER lives in the sequence store; the
 * step's OUTCOME lives here and nowhere else.
 *
 * `lpOpen`, `lpSettings` and `lpExit` are the SIGNED OWNER ACTIONS that start
 * LP work (PHASE3 Rev2 item 20) — journalled like `changeBudget`, purely so a
 * retried owner signature is idempotent. They are LOCAL-ONLY on purpose: the
 * money their sagas move is journalled per STEP under kind `lp` (its own rows,
 * its own callsIds), and the sequence store is the authority on saga order and
 * resume — so there is nothing on-chain to resolve THESE rows against, and an
 * interrupted one is closed out rather than parked.
 *
 * `resolveUnknown` (PHASE3.3 Rev2 item 7) is the SIGNED OWNER ACTION that
 * abandons a stuck LP sequence. It is LOCAL-ONLY for the same reason the other
 * owner actions are — the truth lives in the row it resolved and in the
 * sequence store, and re-signing is free — and being local-only is
 * load-bearing rather than tidy: a kind absent from {@link LOCAL_ONLY_KINDS}
 * falls through `resolveRow`'s unrecognized-kind branch, so an interrupted
 * resolution would be parked as a permanent `UNKNOWN` row with no `callsId`,
 * and the action would manufacture the exact defect it exists to cure.
 *
 * `lpImport` (PHASE3.4 Rev2 M3) is the SIGNED OWNER ACTION that puts an existing
 * NFPM position under automation. It submits NOTHING — no relay call, no session
 * key, no `callsId` — and writes exactly one position row, so it is LOCAL-ONLY
 * for the strongest form of the reason above: there is not merely nothing to
 * resolve it against, there is nothing on chain it could have done. The spec's
 * first draft said "no journal step" and was wrong at the wrapper —
 * `ownerMutation` journals a row of the route's kind whether the spec mentions
 * it or not, and a kind missing from {@link LOCAL_ONLY_KINDS} would park every
 * interrupted import as a permanent `UNKNOWN` that `resolveUnknown` itself
 * refuses (it verifies `lp` rows only). One phase after PHASE3.3 documented that
 * trap.
 */
export type JournalKind =
  | "agentProvision"
  | "agentProvisionCancel"
  | "grantAttemptReset"
  | "grant"
  | "execute"
  | "trade"
  | "lp"
  | "revoke"
  | "pause"
  | "unpause"
  | "changeBudget"
  | "bindRuntimeProfile"
  | "lpOpen"
  | "lpSettings"
  | "lpExit"
  | "resolveUnknown"
  | "resolveUnknownLandingV1"
  | "retireLpPreBindV1"
  | "lpImport"
  | "abandonSequence"
  // PHASE4 R2.5. FOUR money kinds and ONE owner action, and the five had to be
  // enumerated together because they land in six hand-maintained places:
  // this union, {@link MONEY_KINDS}, the Postgres `getByDecision` SQL literal,
  // `test/support/fakeSql.ts`'s copy of that filter, {@link LOCAL_ONLY_KINDS},
  // and `resolveRow`'s callsId branch. The Venus worker submits through the
  // same session-key relay as `trade`, so a money row resolves from its
  // `callsId` identically — and `venusSettings` is the `ownerMutation` wrapper's
  // unconditional row, which is LOCAL-ONLY for the reason the docstring above
  // records twice.
  | "venusRepay"
  | "venusSupply"
  | "venusClaim"
  | "venusClaimRepayLeg"
  | "venusSettings"
  | "billingGrant"
  | "billingIssuerRotate"
  | "billingPause"
  | "billingResume"
  | "billingRevoke"
  | "billingClose"
  | "billingServiceSession"
  | "billingCollect"
  // PHASE3.16 R2.5 (ruling Q3). The grid arm's OWNER-ACTION row, and it needs
  // its own kind on two independent grounds.
  //
  // MASQUERADE: `lpOpen` is the row for `POST /lp/open` — a route the arm does
  // not use and whose semantics (two-sided, in-range, non-zero owner-budget
  // basis) the arm inverts on every count. An audit reading the journal to
  // reconstruct what an owner authorized would read "the owner signed an
  // lpOpen" and be wrong about the action, the params and the basis.
  //
  // MECHANICS, the harder ground: a kind absent from {@link LOCAL_ONLY_KINDS}
  // falls through `resolveRow`'s unrecognized-kind branch and is parked as a
  // permanent UNKNOWN row with no `callsId` that no resolver can clear
  // (`resolveUnknown` verifies `lp` rows only). Reusing `lpOpen` would dodge
  // that by ACCIDENT, which is the worst reason to reuse a kind. The membership
  // below is added in the same change as this union member, deliberately.
  //
  // It stays OUT of {@link MONEY_KINDS}: the money lives in the kind-`lp` step
  // row under `lp:<sequenceId>:0`, exactly as `lpOpen` describes.
  | "lpGridArm"
  | "lpArm"
  | "tradeSettings"
  | "tradeExit"
  | "tradeDrain"
  // MARKETPLACE-LENDING-AGENT R2.1 (closing REVIEW B1). THREE owner-action
  // rows and ONE money kind, and the four had to be enumerated together
  // because they land in the same six hand-maintained places the Venus note
  // above names: this union, {@link MONEY_KINDS}, the Postgres `getByDecision`
  // SQL literal, `test/support/fakeSql.ts`'s copy of that filter,
  // {@link LOCAL_ONLY_KINDS}, and `resolveRow`'s callsId branch.
  //
  // The three owner actions are `ownerMutation`'s unconditional rows and never
  // carry money — the arm and the retire open and settle their OWN `"lending"`
  // money row INSIDE `act`, exactly as `lpArm` does for kind `lp`. Making them
  // money kinds would park every ambiguous owner action as a permanent UNKNOWN
  // that `ownerMutation`'s unconditional `markCommitted` cannot reach.
  | "lendingArm"
  | "lendingSettings"
  | "lendingRetire"
  // QUANT-GRID R2.7. ONE money kind for the TermiX Quant grid, and it is
  // enumerated in the SAME five hand-maintained places every kind above names:
  // this union, {@link MONEY_KINDS}, the Postgres `getByDecision` SQL literal,
  // `test/support/fakeSql.ts`'s copy of that filter, and `resolveRow`'s callsId
  // branch. There is no quant OWNER-ACTION kind, because this plane has no HTTP
  // route and no owner signature — the client's authority is the on-chain
  // session their wizard granted, and everything we do under it is money.
  //
  // `JournalExternalRef` gains NO fields: the level and side live on
  // `quant_actions`, and the body's `externalRef: { level, side }` was withdrawn
  // by R2.7 for exactly that reason.
  | "quantTrade"
  // The ONE money kind for EVERY session-key submission this phase makes: the
  // arm batch, every rescue batch, and the retire batch. `lendingRescue` does
  // NOT exist as a kind — one namespace, `lending:<agentId>:<day>:<n>`, so a
  // decision id used by a rescue can never be reused by the retire.
  | "lending";

/**
 * Kinds that move money under a session key.
 *
 * They share ONE `decisionId` namespace (see {@link ExecutionJournal.getByDecision}):
 * a decision id used on `/execute` cannot be reused on `/trade` or by an LP saga
 * step, or any other way round. Anything less means the replay check silently
 * passes for the second route and the same decision spends twice.
 *
 * The Postgres `getByDecision` SQL literal and the fake SQL client's filter
 * (`test/support/fakeSql.ts`) enumerate the SAME set by hand — extend all three
 * together, and keep the cross-implementation tests green (PHASE2 F3).
 */
export const MONEY_KINDS: ReadonlySet<JournalKind> = new Set<JournalKind>([
  "execute",
  "trade",
  "lp",
  // PHASE4 R2.5. Each is a session-key submission with its own `callsId`, so
  // each shares the decisionId namespace: without this membership a decision id
  // used on `/trade` could be reused by a Venus rescue and the replay check
  // would silently pass for the second one.
  "venusRepay",
  "venusSupply",
  "venusClaim",
  "venusClaimRepayLeg",
  "billingCollect",
  // MARKETPLACE-LENDING-AGENT R2.1. The lending guard submits through the same
  // `executeViaSession` relay as `trade` and `lp`, records a `callsId`, and
  // shares this decision-id namespace so a decision used on `/trade` cannot be
  // reused by a lending rescue with the replay check silently passing.
  "lending",
  // QUANT-GRID R2.7. The quant grid submits through the same
  // `executeViaSession` relay as `trade`, `lp` and `lending`, records a
  // `callsId`, and shares this decision-id namespace. Its `agentId` is the
  // TermiX `quantJobId` and its `ownerAddress` is the client's task wallet —
  // both opaque strings to the journal, which is what lets `sumNativeSpendSince`
  // and `reconcile` work here unmodified.
  "quantTrade",
]);

/** Journal states that HOLD budget. Only `ROLLED_BACK` releases it. */
export const SPEND_COUNTING_STATES: ReadonlySet<JournalState> =
  new Set<JournalState>(["PENDING", "IN_PROGRESS", "COMMITTED", "UNKNOWN"]);

/**
 * Kinds with no on-chain component.
 *
 * Reconcile treats these differently on purpose: there is no chain to ask, and
 * nothing ambiguous about MONEY to hold for an operator. The authoritative state
 * for a pause is the kill-switch table and for a budget the agent row — never the
 * journal — so an interrupted row is closed out rather than parked as UNKNOWN,
 * and the owner re-signs if they want to be certain.
 */
export const LOCAL_ONLY_KINDS: ReadonlySet<JournalKind> = new Set<JournalKind>([
  "agentProvision",
  "agentProvisionCancel",
  "grantAttemptReset",
  "pause",
  "unpause",
  "changeBudget",
  "bindRuntimeProfile",
  // The LP owner-action rows (Rev2 item 20). The MONEY lives in kind-`lp` step
  // rows; these record only that a signed action was consumed, and the sequence
  // store holds the truth about what it started — same shape as changeBudget's
  // "the agent row holds the truth".
  "lpOpen",
  "lpSettings",
  "lpExit",
  // PHASE3.3 Rev2 item 7. See the `JournalKind` note: without this membership
  // an interrupted resolution becomes a permanent UNKNOWN row that this very
  // action cannot resolve (it verifies `lp` rows only).
  "resolveUnknown",
  // Phase 3.9c. This owner action drives only durable local evidence and
  // disposition stores. It has no callsId and reconcile must never poll it.
  "resolveUnknownLandingV1",
  // The custom retirement route is local-only yet deliberately excluded from
  // generic reconcile below: PENDING is its crash-reentry marker, not an
  // interrupted action that can safely be closed without its sequence fence.
  "retireLpPreBindV1",
  // PHASE3.8 F4a, and the membership matters more than the kind does. A kind
  // absent from this set falls through `resolveRow`'s unrecognized-kind branch
  // and is parked as a permanent UNKNOWN row with no `callsId` — so an
  // interrupted ABANDON would become exactly the stuck row this action exists
  // to clear, and `resolveUnknown` would refuse it (it verifies `lp` rows
  // only). That is the trap PHASE3.3 documented for its own action and PHASE3.4
  // walked into again for `lpImport`; twice is enough.
  //
  // Local-only is also simply TRUE here: this action submits nothing, holds no
  // session key and touches no chain. Everything it changes is in the sequence
  // store, which is the authority on saga state, and re-signing is free.
  "abandonSequence",
  // PHASE3.4 Rev2 M3. The import submits nothing at all — no relay call, no
  // callsId — so this is the strongest case in the set: the truth is the
  // position row it wrote, and re-signing costs one signature.
  "lpImport",
  // PHASE4 R2.5, and the trap this membership avoids is the one documented
  // above TWICE already. `ownerMutation` journals a row of the route's kind
  // whether the spec mentions it or not (`src/server.ts:2254`), so a
  // `venusSettings` kind missing from this set would park every interrupted
  // settings write as a permanent UNKNOWN — and NOTHING resolves a Venus
  // UNKNOWN in v1 (see the note at `resolveRow`), so it would be permanent in
  // the strongest sense available. The truth for a settings write lives in the
  // `venus_settings` row, and re-signing costs one signature.
  "venusSettings",
  // Phase 5 owner billing controls mutate only the durable billing ledger.
  // The collection itself is the separate money row `billingCollect`.
  "billingGrant",
  "billingIssuerRotate",
  "billingPause",
  "billingResume",
  "billingRevoke",
  "billingClose",
  "billingServiceSession",
  // PHASE3.16 R2.5 (ruling Q3), and the third time this file records the same
  // trap: `ownerMutation` journals a row of the route's kind unconditionally,
  // so an interrupted `POST /lp/grid/arm` whose kind were missing here becomes
  // a permanent UNKNOWN row with no `callsId` that `resolveUnknown` refuses
  // (it verifies `lp` rows only). The MONEY the arm attaches is in the
  // kind-`lp` step row `lp:<sequenceId>:0`, which reconcile does poll; this row
  // records only that a signed action was consumed, and the sequence store
  // holds the truth about what it started.
  "lpGridArm",
  "lpArm",
  // TRADING-AGENT R5/R3.1: these owner actions only mutate local durable rows.
  "tradeSettings",
  "tradeExit",
  "tradeDrain",
  // MARKETPLACE-LENDING-AGENT R2.1, and the FOURTH time this file records the
  // same trap: `ownerMutation` journals a row of the route's kind
  // unconditionally, so an interrupted `POST /lending/arm` whose kind were
  // missing here becomes a permanent UNKNOWN row with no `callsId` that
  // `resolveUnknown` refuses (it verifies `lp` rows only). The MONEY the arm
  // and the retire attach lives in the kind-`lending` row they open and settle
  // inside `act`; these rows record only that a signed action was consumed,
  // and the `lending_guards` row holds the truth about what it started.
  "lendingArm",
  "lendingSettings",
  "lendingRetire",
]);

/**
 * What the SERVER found when it resolved an `UNKNOWN` row (PHASE3.3 Rev2 item
 * 17). Stored on the row so the decision is auditable after the fact rather
 * than a state change with no reason — which is the whole difference between
 * this action and a `psql` edit.
 *
 * Every field records the SERVER's own finding, never the caller's claim, with
 * the single exception of `observedBlock`, which is labelled as the caller's
 * and is recorded precisely so a later audit can compare the two. Strings, and
 * SIZE-BOUNDED by {@link boundResolutionEvidence}: an evidence blob is written
 * into the row's one jsonb column and must not be able to grow it without
 * limit.
 */
export type JournalResolutionEvidence = {
  /** Always `"resolveUnknown"` — the action that wrote this record. */
  readonly action: "resolveUnknown";
  /** Server clock, epoch ms, at the moment the resolution was written. */
  readonly at: number;
  /** The authenticated owner address that signed the action. */
  readonly ownerAddress: string;
  /** The CALLER's claimed observation height, decimal. Never trusted. */
  readonly observedBlock: string;
  /** The block the SERVER read at, decimal, or `null` when unavailable. */
  readonly serverBlock: string | null;
  /** Finalized block used for a position-closing NFPM read, when applicable. */
  readonly positionEvidenceBlock?: string | null;
  /** Each check the verifier ran and what it found, in order. */
  readonly checks: readonly { readonly name: string; readonly result: string }[];
  /** Per-leg inputs-still-present evidence (Rev2 item 10(e)/(f)). */
  readonly legs: readonly {
    readonly token: string;
    readonly neededWei: string;
    readonly walletWei: string;
    readonly discriminating: boolean;
  }[];
  /** The optional log-absence probe: checked, or unavailable with a reason. */
  readonly logAbsence: { readonly checked: boolean; readonly detail: string };
  /** What was done to the sequence and the position. */
  readonly disposition: string;
};

/** Longest any single evidence string may be. */
const MAX_EVIDENCE_CHARS = 200;
/** Most checks / legs an evidence record may carry. */
const MAX_EVIDENCE_ENTRIES = 24;

function clampEvidenceText(value: string): string {
  return value.slice(0, MAX_EVIDENCE_CHARS);
}

/**
 * Bound an evidence record before it is written. The per-leg records of Rev2
 * item 10(e) are small; a probe result is not, and nothing downstream re-reads
 * this blob to decide anything, so truncation costs an audit detail and never a
 * decision.
 */
export function boundResolutionEvidence(
  evidence: JournalResolutionEvidence,
): JournalResolutionEvidence {
  return {
    action: "resolveUnknown",
    at: evidence.at,
    ownerAddress: clampEvidenceText(evidence.ownerAddress),
    observedBlock: clampEvidenceText(evidence.observedBlock),
    serverBlock:
      evidence.serverBlock === null ? null : clampEvidenceText(evidence.serverBlock),
    ...(evidence.positionEvidenceBlock === undefined
      ? {}
      : {
          positionEvidenceBlock:
            evidence.positionEvidenceBlock === null
              ? null
              : clampEvidenceText(evidence.positionEvidenceBlock),
        }),
    checks: evidence.checks.slice(0, MAX_EVIDENCE_ENTRIES).map((check) => ({
      name: clampEvidenceText(check.name),
      result: clampEvidenceText(check.result),
    })),
    legs: evidence.legs.slice(0, MAX_EVIDENCE_ENTRIES).map((leg) => ({
      token: clampEvidenceText(leg.token),
      neededWei: clampEvidenceText(leg.neededWei),
      walletWei: clampEvidenceText(leg.walletWei),
      discriminating: leg.discriminating,
    })),
    logAbsence: {
      checked: evidence.logAbsence.checked,
      detail: clampEvidenceText(evidence.logAbsence.detail),
    },
    disposition: clampEvidenceText(evidence.disposition),
  };
}

/** External identifiers a row accumulates as the operation progresses. */
export type JournalExternalRef = {
  readonly callsId?: Hex;
  readonly txHash?: Hex;
  readonly publicKey?: Hex;
  /**
   * Hash of the exact calls an execute row submitted.
   *
   * Recorded so a SECOND request under the same `decisionId` can be compared
   * against what was actually sent. Same hash means the client is retrying and
   * gets the stored outcome; a different hash means it is asking for a different
   * trade under an identifier that already means something else, and reporting
   * the first trade's outcome for the second one would be a lie. See
   * {@link ExecutionJournal.getByDecision}.
   */
  readonly callsHash?: Hex;
  /**
   * Hash of a trade's REQUEST parameters and the resolved venue configuration.
   *
   * Separate from `callsHash` because it binds things the calls alone do not: a
   * `VENUE_*` override changing between a submit and its retry produces the same
   * request but different calldata, and a paramsHash that covered only the
   * request would replay the old outcome for a trade aimed somewhere new. It is
   * also recorded on DENIED trades, which have no calls at all — that is what
   * stops a denied decisionId from being re-bound to different parameters.
   */
  readonly paramsHash?: Hex;
  /**
   * The server's findings from an owner-signed `resolveUnknown` (PHASE3.3 Rev2
   * item 17). This ref field is the row's only jsonb, and the evidence lands
   * here under a reserved key rather than in a new column so the phase needs no
   * migration.
   *
   * Two writers, and the distinction is load-bearing:
   *
   *   - on the `lp` MONEY ROW being resolved, written exactly once and by
   *     {@link ExecutionJournal.resolveUnknown} alone. Its presence on such a
   *     row is what lets the action recognise its own partially-applied
   *     resolution and re-enter it (PHASE3.3-AUDIT A1);
   *   - on the ACTION'S OWN `resolveUnknown`-kind row, written by
   *     {@link ExecutionJournal.markRolledBack} when the action REFUSED
   *     (PHASE3.3-AUDIT A7), because a refusal changes no state and would
   *     otherwise archive nothing but a 300-character message.
   */
  readonly resolution?: JournalResolutionEvidence;
  readonly landingAction?: {
    readonly scheme: "resolve-landing-action-v1";
    readonly resolutionId: string;
    readonly state: "IN_PROGRESS" | "TERMINAL";
    readonly completionRole?: "terminalizer" | "refusal-winner" | "joiner";
  };
  readonly landingResult?: {
    readonly decisionId: string;
    readonly outcome: "landed" | "absent" | "ambiguous" | "unavailable";
    readonly action: "resume-committed" | "retire-not-landed" | "none";
    readonly journalState: "COMMITTED" | "ROLLED_BACK" | "UNKNOWN";
    readonly inference: "landed" | "absent" | "ambiguous" | "unavailable";
    readonly resolutionId: string;
    readonly evidenceDigest: Hex | null;
    readonly evidenceRetainedUntil: string | null;
    readonly replayed: boolean;
  };
  /** Versioned local-only action record for the proved no-bind retirement. */
  readonly retirementAction?: {
    readonly scheme: "retire-lp-pre-bind-action-v1";
    readonly targetJournalKey: string;
    readonly decisionId: string;
    readonly state: "PENDING" | "TERMINAL";
  };
  readonly retirementResult?: {
    readonly scheme: "retire-lp-pre-bind-result-v1";
    readonly decisionId: string;
    readonly targetJournalKey: string;
    readonly sequenceId: string;
    readonly positionId: string;
    readonly targetJournalState: "ROLLED_BACK";
    readonly sequenceState: "rolled-back";
    readonly positionState: "closed";
    readonly evidenceCode: "retired-pre-bind-v1";
  };
  /** Immutable provenance written on the target LP row by the fenced finalizer. */
  readonly retirementEvidence?: {
    readonly scheme: "retired-pre-bind-v1";
  };
  /** Phase 5: durable account identity for a billing collection money row. */
  readonly billingPrincipal?: Readonly<{
    readonly kind: "billing_account";
    readonly id: string;
  }>;
  readonly billingInvoice?: Readonly<{
    readonly invoiceId: string;
    readonly preparedDigest: Hex;
    readonly wallet: string;
    readonly collector: string;
    readonly valueWei: string;
    readonly quoteExpiresAt: number;
    readonly sessionGeneration: string;
  }>;
};

export type JournalEntry = {
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly ownerAddress: string;
  readonly kind: JournalKind;
  /** Present on Phase 5 collection rows; old agent rows retain their shape. */
  readonly principal?: JournalPrincipal;
  /**
   * The agent-runtime decision this row serves, for `execute` rows. `null` for
   * owner actions, which are identified by their signed struct instead.
   */
  readonly decisionId: string | null;
  readonly state: JournalState;
  readonly externalRef: JournalExternalRef;
  /**
   * Native the row's operation charges the wallet, in wei. `0n` for rows that
   * spend nothing, including denials.
   *
   * Written at `begin`, never updated: spend is counted the moment it is
   * ATTEMPTED and released only when the row reaches `ROLLED_BACK`. Counting an
   * in-flight or ambiguous row is deliberate — an unresolved crash window must
   * reduce the remaining budget, not free it.
   */
  readonly nativeSpendWei: bigint;
  /**
   * Finalized chain height observed immediately before an LP submission row
   * began. It is only a conservative lower bound for a future evidence search;
   * `null` means no honest bound was available (including every non-LP row and
   * rows written before Phase 3.9b).
   */
  readonly begunAtBlock: bigint | null;
  /** Canonical C1 calls fingerprint. LP submit rows only. */
  readonly finalCallsFingerprint: string | null;
  readonly finalCallsFingerprintHash: Hex | null;
  /** Canonical C1 prepared identity, first-wins after prepare and before sign. */
  readonly preparedIntentIdentity: string | null;
  readonly preparedIntentIdentityHash: Hex | null;
  readonly preparedBindingVersion: number;
  /** Phase 5 collection callsId CAS: 0 before bind, 1 after the sole bind. */
  readonly billingCallsIdVersion: number;
  readonly landingResolutionId: string | null;
  readonly landingResolutionKeyHash: Hex | null;
  readonly landingResolutionOutcome: "landed" | "absent" | null;
  readonly landingResolutionEvidenceHash: Hex | null;
  readonly landingResolutionTerminalAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type JournalBeginInput = {
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly ownerAddress: string;
  readonly kind: JournalKind;
  readonly principal?: JournalPrincipal;
  /** Set for `execute` and `trade` rows so `getByDecision` can find them. */
  readonly decisionId?: string;
  /** Seed values known at begin time — for money rows, the calls hash. */
  readonly externalRef?: JournalExternalRef;
  /** Native this operation charges, in wei. Defaults to `0n`. */
  readonly nativeSpendWei?: bigint;
  /** Existing finalized LP market height; omitted for every non-LP begin. */
  readonly begunAtBlock?: bigint;
  /** Both fields are required together and accepted only for kind `lp`. */
  readonly finalCallsFingerprint?: string;
  readonly finalCallsFingerprintHash?: Hex;
};

export type JournalPreparedIntentBindInput = {
  readonly canonicalIdentity: string;
  readonly identityHash: Hex;
  readonly expectedBindingVersion: number;
};

export type JournalPreparedIntentBindResult = {
  readonly entry: JournalEntry;
  readonly boundBindingVersion: number;
};

export type BillingCollectCallsIdBindInput = Readonly<{
  principal: Readonly<{ kind: "billing_account"; id: string }>;
  decisionId: string;
  expectedCallsIdVersion: number;
  witnessDigest: Hex;
  callsId: Hex;
}>;

export type BillingCollectionResolution = Readonly<{
  outcome: "paid" | "rolled_back";
  callsId: Hex;
  transactionHash: Hex;
}>;

/**
 * A `begin` that also reports the spend already reserved by OTHER rows.
 *
 * The insert and the sum happen atomically — one transaction on Postgres, one
 * uninterrupted turn on the memory journal — which is what makes the daily cap a
 * RESERVATION rather than a read-then-act. Two concurrent trades serialize here:
 * the second one's sum includes the first one's row, so exactly one can be under
 * the cap.
 */
export type JournalBeginWithSpendResult = {
  readonly entry: JournalEntry;
  /** Sum over every OTHER counting row for this agent since `sinceMs`. */
  readonly otherSpendWei: bigint;
  /**
   * Whether THIS call inserted the row. `false` means the key already existed —
   * including a concurrent request's still-PENDING row. The money routes gate
   * on this rather than on `entry.state`: a state check cannot tell the creator
   * apart from a racing duplicate that arrived while the creator was mid-flight,
   * and two callers who both believe they own a PENDING row both submit.
   */
  readonly created: boolean;
};

export interface ExecutionJournal {
  /** Memory-only rollback participant for the no-SQL landing finalizer. */
  snapshotLandingResolutionTransaction?(idempotencyKeys: readonly string[]): unknown;
  restoreLandingResolutionTransaction?(snapshot: unknown): void;
  /**
   * Create the row PENDING, or return the existing row unchanged. Idempotent:
   * the primary key dedupes retries, so a second call with the same key never
   * creates a duplicate and never re-runs the work.
   */
  begin(input: JournalBeginInput): Promise<JournalEntry>;
  /**
   * {@link begin}, plus the atomically-taken sum of every OTHER counting row's
   * native spend for this agent since `sinceMs`. See
   * {@link JournalBeginWithSpendResult}.
   */
  beginWithSpend(
    input: JournalBeginInput,
    sinceMs: number,
  ): Promise<JournalBeginWithSpendResult>;
  /** Atomic first-wins C1 bind. Different bytes can never replace a binding. */
  bindPreparedIntent(
    idempotencyKey: string,
    input: JournalPreparedIntentBindInput,
  ): Promise<JournalPreparedIntentBindResult>;
  /** Immutable journal-side Phase 5 callsId projection; does not change state. */
  bindBillingCollectCallsId(input: BillingCollectCallsIdBindInput): Promise<JournalEntry>;
  markInProgress(
    idempotencyKey: string,
    externalRef: JournalExternalRef,
  ): Promise<JournalEntry>;
  markCommitted(
    idempotencyKey: string,
    externalRef?: JournalExternalRef,
  ): Promise<JournalEntry>;
  /**
   * `externalRef` is how a REFUSED owner action archives its evidence
   * (PHASE3.3-AUDIT A7): the action's own row is the only place a refusal can
   * be recorded, and without it the auditable-receipt promise held for the half
   * that changes state and not for the half that declines to. It is a merge, so
   * the row's existing refs survive; it does NOT widen the transition table.
   */
  markRolledBack(
    idempotencyKey: string,
    lastError?: string,
    externalRef?: JournalExternalRef,
  ): Promise<JournalEntry>;
  markUnknown(
    idempotencyKey: string,
    lastError?: string,
  ): Promise<JournalEntry>;
  /**
   * THE OPERATOR HALF OF UNKNOWN (PHASE3.3 review R1 / Rev2 item 4).
   *
   * Move an `UNKNOWN` row to `ROLLED_BACK` under an owner-signed,
   * server-verified resolution, recording `evidence` on the row. Deliberately
   * DISTINCT from {@link markRolledBack}:
   *
   *   - it asserts `current.state === "UNKNOWN"` ITSELF, so it can never be
   *     used to re-terminalize an already-terminal row, and so the assertion
   *     does not depend on the shared transition table;
   *   - it is the ONLY caller that may name the `"resolve-unknown"` transition
   *     path, which is the only path on which the `UNKNOWN → ROLLED_BACK` edge
   *     exists — `reconcile` and `resolveRow` reach neither;
   *   - it PRESERVES `lastError`. The relay's silence is why the row was ever
   *     in doubt, and an audit that read only the outcome would lose it.
   *
   * Throws when the row does not exist or is not `UNKNOWN`.
   */
  resolveUnknown(
    idempotencyKey: string,
    evidence: JournalResolutionEvidence,
  ): Promise<JournalEntry>;
  /**
   * Record an UNKNOWN step as COMMITTED on positive on-chain proof that it
   * landed (PHASE3.9a). The mirror of {@link resolveUnknown}, and the only other
   * write permitted to follow `markUnknown`.
   *
   * `externalRef` carries whatever the proof yielded — a tx hash when one is
   * known — and the evidence records what was read and why it is proof.
   */
  advanceUnknown(
    idempotencyKey: string,
    evidence: JournalResolutionEvidence,
    externalRef?: JournalExternalRef,
  ): Promise<JournalEntry>;
  /** Canonical two-RPC proof is the only edge out of a billing UNKNOWN row. */
  resolveBillingCollection(
    idempotencyKey: string,
    resolution: BillingCollectionResolution,
  ): Promise<JournalEntry>;
  joinLandingAction(input: {
    readonly idempotencyKey: string;
    readonly resolutionId: string;
    readonly resolutionKeyHash: Hex;
  }): Promise<JournalEntry>;
  reserveLandingDisposition(input: {
    readonly idempotencyKey: string;
    readonly resolutionId: string;
    readonly resolutionKeyHash: Hex;
    readonly outcome: "landed" | "absent";
    readonly txHash?: Hex;
  }): Promise<JournalEntry>;
  finalizeLandingDisposition(input: {
    readonly idempotencyKey: string;
    readonly resolutionId: string;
    readonly resolutionKeyHash: Hex;
    readonly outcome: "landed" | "absent";
    readonly evidenceHash: Hex;
    readonly terminalAt: number;
  }): Promise<JournalEntry>;
  completeLandingAction(
    idempotencyKey: string,
    externalRef: JournalExternalRef,
  ): Promise<JournalEntry>;
  /** The only pre-bind retirement edge from UNKNOWN to ROLLED_BACK. */
  retireProvenPreBind(idempotencyKey: string): Promise<JournalEntry>;
  /** Complete the custom local-only action with its canonical stored result. */
  completePreBindRetirementAction(
    idempotencyKey: string,
    externalRef: JournalExternalRef,
  ): Promise<JournalEntry>;
  get(idempotencyKey: string): Promise<JournalEntry | null>;
  /**
   * The execute row already recorded for this `(agentId, decisionId)` pair, or
   * `null`.
   *
   * The idempotency key folds the calls hash in, so two submits of DIFFERENT
   * calls under the same decision land on different keys and `get` would report
   * neither as a conflict. This is the lookup that catches it: it is keyed on the
   * decision alone, and the row it returns carries the calls hash that decision
   * has already committed to.
   */
  getByDecision(agentId: string, decisionId: string): Promise<JournalEntry | null>;
  /** True when an owner mutation must not race an unsettled money row. */
  hasPendingForAgent(agentId: string, excludeIdempotencyKey?: string): Promise<boolean>;
  /**
   * Every `UNKNOWN` row this agent holds, oldest first.
   *
   * Added by PHASE4 R3.7, and narrow on purpose. NOTHING resolves a Venus
   * UNKNOWN automatically in v1, so an ambiguous submission has to be VISIBLE
   * and has to change behaviour: while a `venusSupply` or `venusClaimRepayLeg`
   * row is UNKNOWN, further supplies and claim legs are BLOCKED (a repeated
   * supply is the owner's capital locked a second time) while `venusRepay`
   * CONTINUES (clamped by the submit-time `min(…, borrowCurrent)` re-read, so
   * at worst a `no-effect`). The worker and the owner view both need to see the
   * held rows to say that, and the journal is the only authority on them.
   *
   * Not filtered by kind here: the caller knows which kinds it cares about, and
   * a store method that silently drops kinds is a store method that hides a
   * held row from whoever adds the next kind.
   */
  listUnknownForAgent(agentId: string): Promise<JournalEntry[]>;
  /**
   * Native spend this agent has reserved since `sinceMs`, in wei.
   *
   * Sums `nativeSpendWei` over rows in PENDING, IN_PROGRESS, COMMITTED and
   * UNKNOWN — every state that has not released its budget. `ROLLED_BACK` is the
   * only state that gives spend back, because it is the only one that proves
   * nothing landed.
   *
   * `excludeIdempotencyKey` omits one row, for the post-`begin` re-check that
   * must not count the row it just inserted twice.
   */
  sumNativeSpendSince(
    agentId: string,
    sinceMs: number,
    excludeIdempotencyKey?: string,
  ): Promise<bigint>;
  /** Rows still eligible for reconcile: PENDING or IN_PROGRESS only. */
  listNonTerminal(): Promise<JournalEntry[]>;
  close(): Promise<void>;
}

export type Clock = () => number;

const MAX_ERROR_CHARS = 300;
const HASH_HEX = /^0x[0-9a-f]{64}$/;

function normalizeFinalCallsBinding(input: JournalBeginInput): {
  readonly canonical: string | null;
  readonly hash: Hex | null;
} {
  const canonical = input.finalCallsFingerprint;
  const hash = input.finalCallsFingerprintHash;
  if ((canonical === undefined) !== (hash === undefined)) {
    throw new Error("Journal final-calls fingerprint fields must be supplied together.");
  }
  if (canonical === undefined || hash === undefined) return { canonical: null, hash: null };
  if (input.kind !== "lp") {
    throw new Error("Only LP money rows may carry a final-calls fingerprint.");
  }
  if (Buffer.byteLength(canonical, "utf8") > 192 || !HASH_HEX.test(hash)) {
    throw new Error("Journal final-calls fingerprint is malformed or over 192 bytes.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(canonical); } catch {
    throw new Error("Journal final-calls fingerprint must be canonical JSON.");
  }
  if (!isStringRecord(parsed) || Object.keys(parsed).join("|") !== "scheme|executionDataHash" ||
      parsed["scheme"] !== "porto-erc7579-calls-v1" ||
      typeof parsed["executionDataHash"] !== "string" ||
      !HASH_HEX.test(parsed["executionDataHash"]) || JSON.stringify(parsed) !== canonical ||
      keccak256(stringToHex(canonical)) !== hash) {
    throw new Error("Journal final-calls fingerprint is not canonical or hash-bound.");
  }
  return { canonical, hash };
}

function normalizePreparedBind(input: JournalPreparedIntentBindInput): void {
  if (!Number.isSafeInteger(input.expectedBindingVersion) || input.expectedBindingVersion < 0) {
    throw new Error("Prepared binding expected version must be a non-negative integer.");
  }
  if (Buffer.byteLength(input.canonicalIdentity, "utf8") > 1_024 ||
      !HASH_HEX.test(input.identityHash)) {
    throw new Error("Prepared intent identity is malformed or over 1024 bytes.");
  }
}

function assertPreparedBindMatchesFinalCalls(
  row: Pick<JournalEntry, "finalCallsFingerprint" | "finalCallsFingerprintHash">,
  input: JournalPreparedIntentBindInput,
): void {
  if (row.finalCallsFingerprint === null || row.finalCallsFingerprintHash === null ||
      keccak256(stringToHex(input.canonicalIdentity)) !== input.identityHash) {
    throw new Error("Prepared intent identity is not durably hash-bound.");
  }
  let fingerprint: unknown; let identity: unknown;
  try {
    fingerprint = JSON.parse(row.finalCallsFingerprint);
    identity = JSON.parse(input.canonicalIdentity);
  } catch { throw new Error("Prepared intent binding is not canonical JSON."); }
  if (!isStringRecord(fingerprint) || !isStringRecord(identity) ||
      fingerprint["executionDataHash"] !== identity["executionDataHash"] ||
      keccak256(stringToHex(row.finalCallsFingerprint)) !== row.finalCallsFingerprintHash) {
    throw new Error("Prepared intent identity does not match the final calls fingerprint.");
  }
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NON_TERMINAL: ReadonlySet<JournalState> = new Set<JournalState>([
  "PENDING",
  "IN_PROGRESS",
]);

/**
 * Which caller is asking for a transition.
 *
 * `"standard"` is every ordinary write — `markInProgress`, `markCommitted`,
 * `markRolledBack`, `markUnknown` — and its table is the pre-PHASE3.3 table
 * unchanged. `"resolve-unknown"` is nameable only from
 * {@link ExecutionJournal.resolveUnknown}; it adds EXACTLY ONE edge and
 * nothing else.
 */
type TransitionPath = "standard" | "resolve-unknown" | "advance-on-chain" | "retire-pre-bind";

function assertBillingCallsIdInput(input: BillingCollectCallsIdBindInput): void {
  if (
    input.principal.kind !== "billing_account" || input.principal.id === "" ||
    input.decisionId === "" || input.expectedCallsIdVersion < 0 ||
    !Number.isSafeInteger(input.expectedCallsIdVersion) ||
    !/^0x[0-9a-f]{64}$/.test(input.witnessDigest) ||
    !/^0x[0-9a-f]{64}$/.test(input.callsId)
  ) throw new Error("Billing collection callsId bind input is invalid.");
}

function billingCallsIdNext(
  current: JournalEntry,
  input: BillingCollectCallsIdBindInput,
  now: number,
): JournalEntry {
  assertBillingCallsIdInput(input);
  const witness = current.externalRef.billingInvoice;
  if (
    current.kind !== "billingCollect" || current.principal?.kind !== "billing_account" ||
    current.principal.id !== input.principal.id || current.idempotencyKey !== input.decisionId ||
    current.decisionId !== input.decisionId || witness === undefined ||
    witness.preparedDigest.toLowerCase() !== input.witnessDigest
  ) throw new Error("Billing collection callsId identity conflict.");
  const existing = current.externalRef.callsId;
  if (existing !== undefined) {
    if (existing.toLowerCase() !== input.callsId || current.billingCallsIdVersion !== 1) {
      throw new Error("Billing collection callsId is already bound to different bytes.");
    }
    return current;
  }
  if (
    current.state === "COMMITTED" || current.state === "ROLLED_BACK" ||
    current.billingCallsIdVersion !== 0 || input.expectedCallsIdVersion !== 0
  ) throw new Error("Billing collection callsId binding version conflict.");
  return {
    ...current,
    externalRef: mergeRef(current.externalRef, { callsId: input.callsId }),
    billingCallsIdVersion: 1,
    updatedAt: now,
  };
}

/**
 * The one edge PHASE3.3 adds, named rather than assumed (review R1, Rev2 item
 * 4). It is deliberately NOT a widening of the base table below: putting
 * `ROLLED_BACK` into `UNKNOWN`'s legal set would let `reconcile`'s
 * `markRolledBack` move an UNKNOWN row, which is exactly the leak the phase
 * promises will not happen.
 */
const RESOLVE_UNKNOWN_EDGE = { from: "UNKNOWN", to: "ROLLED_BACK" } as const;

/**
 * The SECOND named edge (PHASE3.9a), and it is the honest counterpart of the
 * first.
 *
 * PHASE3.3 could only ever record "this step did not land". But
 * `zapOutStillFunded` has always been able to prove the OPPOSITE for one step
 * kind — a burned token or zero liquidity means the withdrawal DID land — and
 * with no way to say so, that proof produced a permanent REFUSAL that left the
 * position `closing` for ever and its row counting in `openPositionsCount`.
 * PHASE3.3-AUDIT A2 raised it; `resolveUnknown.ts` names this very edge in a
 * comment as the missing piece.
 *
 * Recording a step that DID happen as `ROLLED_BACK` would be a lie with money
 * attached — `ROLLED_BACK` is the one state that RELEASES budget
 * ({@link SPEND_COUNTING_STATES}), so it would also hand back a spend the chain
 * actually made.
 *
 * Named for the same reason the first one is: widening `UNKNOWN`'s legal set
 * would let `reconcile`'s `markCommitted` advance an UNKNOWN row on nothing
 * better than a receipt, and the whole point is that only an owner-signed action
 * holding positive on-chain proof may do it.
 */
const ADVANCE_ON_CHAIN_EDGE = { from: "UNKNOWN", to: "COMMITTED" } as const;

/**
 * The state assertion `resolveUnknown` makes ITSELF (review R1, NORMATIVE),
 * rather than relying on the transition table. Both backends call it, so the
 * rule cannot drift between them.
 */
function assertResolvableUnknown(current: JournalEntry): void {
  if (current.state !== "UNKNOWN") {
    throw new Error(
      `Journal row "${current.idempotencyKey}" is ${current.state}, not UNKNOWN; resolveUnknown refuses it.`,
    );
  }
}

/**
 * Whether `from → to` is a legal transition on `path`. Same-state is always
 * legal (idempotent no-op). A move out of a terminal state is not — with the
 * single, named exception above, reachable only from `resolveUnknown`.
 */
function assertTransition(
  from: JournalState,
  to: JournalState,
  path: TransitionPath = "standard",
): void {
  if (from === to) return;
  if (
    path === "resolve-unknown" &&
    from === RESOLVE_UNKNOWN_EDGE.from &&
    to === RESOLVE_UNKNOWN_EDGE.to
  ) {
    return;
  }
  if (
    path === "advance-on-chain" &&
    from === ADVANCE_ON_CHAIN_EDGE.from &&
    to === ADVANCE_ON_CHAIN_EDGE.to
  ) {
    return;
  }
  if (path === "retire-pre-bind" && from === "UNKNOWN" && to === "ROLLED_BACK") return;
  const legal: Record<JournalState, readonly JournalState[]> = {
    PENDING: ["IN_PROGRESS", "COMMITTED", "ROLLED_BACK", "UNKNOWN"],
    IN_PROGRESS: ["COMMITTED", "ROLLED_BACK", "UNKNOWN"],
    COMMITTED: [],
    ROLLED_BACK: [],
    UNKNOWN: [],
  };
  if (!legal[from].includes(to)) {
    throw new Error(`Illegal journal transition ${from} → ${to}.`);
  }
}

function mergeRef(
  current: JournalExternalRef,
  update: JournalExternalRef | undefined,
): JournalExternalRef {
  if (update === undefined) return current;
  if (
    current.billingPrincipal !== undefined && update.billingPrincipal !== undefined &&
    (
      current.billingPrincipal.kind !== update.billingPrincipal.kind ||
      current.billingPrincipal.id !== update.billingPrincipal.id
    )
  ) throw new Error("Billing journal principal is immutable.");
  if (
    current.billingInvoice !== undefined && update.billingInvoice !== undefined &&
    (
      current.billingInvoice.invoiceId !== update.billingInvoice.invoiceId ||
      current.billingInvoice.preparedDigest !== update.billingInvoice.preparedDigest ||
      current.billingInvoice.wallet !== update.billingInvoice.wallet ||
      current.billingInvoice.collector !== update.billingInvoice.collector ||
      current.billingInvoice.valueWei !== update.billingInvoice.valueWei ||
      current.billingInvoice.quoteExpiresAt !== update.billingInvoice.quoteExpiresAt ||
      current.billingInvoice.sessionGeneration !== update.billingInvoice.sessionGeneration
    )
  ) throw new Error("Billing invoice journal binding is immutable.");
  return {
    ...current,
    ...(update.callsId === undefined ? {} : { callsId: update.callsId }),
    ...(update.txHash === undefined ? {} : { txHash: update.txHash }),
    ...(update.publicKey === undefined ? {} : { publicKey: update.publicKey }),
    ...(update.callsHash === undefined ? {} : { callsHash: update.callsHash }),
    ...(update.paramsHash === undefined ? {} : { paramsHash: update.paramsHash }),
    // R18: this merge is field-by-field and SILENTLY DROPS anything it does not
    // enumerate, which is why the evidence key has to be listed here rather
    // than spread in at the call site.
    ...(update.resolution === undefined ? {} : { resolution: update.resolution }),
    ...(update.landingAction === undefined ? {} : { landingAction: update.landingAction }),
    ...(update.landingResult === undefined ? {} : { landingResult: update.landingResult }),
    ...(update.retirementAction === undefined ? {} : { retirementAction: update.retirementAction }),
    ...(update.retirementResult === undefined ? {} : { retirementResult: update.retirementResult }),
    ...(update.retirementEvidence === undefined ? {} : { retirementEvidence: update.retirementEvidence }),
    ...(update.billingPrincipal === undefined ? {} : { billingPrincipal: update.billingPrincipal }),
    ...(update.billingInvoice === undefined ? {} : { billingInvoice: update.billingInvoice }),
  };
}

function journalPrincipal(input: JournalBeginInput): JournalPrincipal | undefined {
  const principal = input.principal;
  if (input.kind === "billingCollect") {
    if (principal?.kind !== "billing_account" || principal.id.trim() === "" || principal.id !== input.agentId) {
      throw new Error("billingCollect requires the exact BillingAccount journal principal.");
    }
    return principal;
  }
  if (principal !== undefined && (principal.kind !== "agent" || principal.id !== input.agentId)) {
    throw new Error("Non-billing journal rows cannot use a billing-account principal.");
  }
  return principal;
}

function canonicalBytes32(value: Hex, field: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${field} must be a canonical bytes32 value.`);
  }
  return value.toLowerCase() as Hex;
}

function assertBillingCollectionResolution(
  current: JournalEntry,
  resolution: BillingCollectionResolution,
): BillingCollectionResolution {
  if (
    current.kind !== "billingCollect" ||
    current.principal?.kind !== "billing_account" ||
    current.principal.id !== current.agentId ||
    current.externalRef.billingPrincipal?.kind !== "billing_account" ||
    current.externalRef.billingPrincipal.id !== current.agentId ||
    current.externalRef.billingInvoice === undefined
  ) {
    throw new Error("Billing collection journal binding is incomplete.");
  }
  const callsId = canonicalBytes32(resolution.callsId, "Billing collection callsId");
  const transactionHash = canonicalBytes32(
    resolution.transactionHash,
    "Billing collection transactionHash",
  );
  if (
    current.externalRef.callsId !== undefined &&
    current.externalRef.callsId.toLowerCase() !== callsId
  ) {
    throw new Error("Billing collection callsId conflicts with the prepared row.");
  }
  const expectedState = resolution.outcome === "paid" ? "COMMITTED" : "ROLLED_BACK";
  if (
    current.state !== "IN_PROGRESS" &&
    current.state !== "UNKNOWN" &&
    current.state !== expectedState
  ) {
    throw new Error(`Billing collection journal row cannot resolve from ${current.state}.`);
  }
  if (
    current.state === expectedState &&
    (current.externalRef.callsId?.toLowerCase() !== callsId ||
      current.externalRef.txHash?.toLowerCase() !== transactionHash)
  ) {
    throw new Error("Billing collection terminal proof conflicts with the stored proof.");
  }
  return { outcome: resolution.outcome, callsId, transactionHash };
}

function assertPreBindRetirementResult(ref: JournalExternalRef): void {
  assertPreBindRetirementAction(ref, "TERMINAL");
  const action = ref.retirementAction;
  const result = ref.retirementResult;
  if (action === undefined || !isExactRecord(result, [
    "decisionId", "evidenceCode", "positionId", "positionState", "scheme",
    "sequenceId", "sequenceState", "targetJournalKey", "targetJournalState",
  ]) ||
      result.scheme !== "retire-lp-pre-bind-result-v1" ||
      result.targetJournalState !== "ROLLED_BACK" || result.sequenceState !== "rolled-back" ||
      result.positionState !== "closed" || result.evidenceCode !== "retired-pre-bind-v1" ||
      action.targetJournalKey !== result.targetJournalKey || action.decisionId !== result.decisionId ||
      action.targetJournalKey.length === 0 || action.targetJournalKey.length > 128 ||
      action.decisionId.length === 0 || action.decisionId.length > 128 ||
      result.sequenceId.length === 0 || result.sequenceId.length > 128 ||
      result.positionId.length === 0 || result.positionId.length > 128) {
    throw new Error("Pre-bind retirement action result has an invalid shape.");
  }
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function assertPreBindRetirementAction(
  ref: JournalExternalRef,
  expectedState: "PENDING" | "TERMINAL",
): void {
  const action = ref.retirementAction;
  if (!isExactRecord(action, ["decisionId", "scheme", "state", "targetJournalKey"]) ||
      action.scheme !== "retire-lp-pre-bind-action-v1" || action.state !== expectedState ||
      typeof action.targetJournalKey !== "string" || action.targetJournalKey.length === 0 ||
      action.targetJournalKey.length > 128 || typeof action.decisionId !== "string" ||
      !/^lp:[^:]{1,112}:\d{1,9}$/.test(action.decisionId)) {
    throw new Error("Pre-bind retirement action has an invalid shape.");
  }
}

function assertRetirementExternalRef(kind: JournalKind, state: JournalState, ref: JournalExternalRef): void {
  if (ref.retirementEvidence !== undefined &&
      (!isExactRecord(ref.retirementEvidence, ["scheme"]) ||
       ref.retirementEvidence.scheme !== "retired-pre-bind-v1" || kind !== "lp")) {
    throw new Error("Pre-bind retirement evidence has an invalid shape.");
  }
  if (kind !== "retireLpPreBindV1") return;
  if (state === "COMMITTED") {
    assertPreBindRetirementResult(ref);
    return;
  }
  assertPreBindRetirementAction(ref, "PENDING");
  if (ref.retirementResult !== undefined) {
    throw new Error("Pending pre-bind retirement action cannot contain a result.");
  }
}

function samePreBindRetirementResult(
  current: JournalExternalRef,
  expected: JournalExternalRef,
): boolean {
  return JSON.stringify(current.retirementAction) === JSON.stringify(expected.retirementAction) &&
    JSON.stringify(current.retirementResult) === JSON.stringify(expected.retirementResult);
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Process-local journal. Concurrent operations on the SAME key are serialized
 * through a per-key promise chain — the memory equivalent of `select ... for
 * update` — so two racing `begin`s cannot both insert.
 */
export class MemoryExecutionJournal implements ExecutionJournal {
  readonly #rows = new Map<string, JournalEntry>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  snapshotLandingResolutionTransaction(idempotencyKeys: readonly string[]): unknown {
    return structuredClone(idempotencyKeys.map((key) =>
      [key, this.#rows.get(key) ?? null] as const));
  }

  restoreLandingResolutionTransaction(snapshot: unknown): void {
    const rows = snapshot as readonly (readonly [string, JournalEntry | null])[];
    for (const [key, row] of rows) {
      if (row === null) this.#rows.delete(key);
      else this.#rows.set(key, structuredClone(row));
    }
  }

  async begin(input: JournalBeginInput): Promise<JournalEntry> {
    return this.#withLock(input.idempotencyKey, async () => this.#insert(input));
  }

  async beginWithSpend(
    input: JournalBeginInput,
    sinceMs: number,
  ): Promise<JournalBeginWithSpendResult> {
    return this.#withLock(input.idempotencyKey, async () => {
      // No await between the insert and the sum, so no other turn of the event
      // loop can interleave: the memory equivalent of one transaction.
      const created = !this.#rows.has(input.idempotencyKey);
      const entry = this.#insert(input);
      const otherSpendWei = this.#sum(input.agentId, sinceMs, input.idempotencyKey);
      return { entry, otherSpendWei, created };
    });
  }

  #insert(input: JournalBeginInput): JournalEntry {
    const begunAtBlock = normalizeBegunAtBlock(input.begunAtBlock);
    const finalCalls = normalizeFinalCallsBinding(input);
    assertRetirementExternalRef(input.kind, "PENDING", input.externalRef ?? {});
    const principal = journalPrincipal(input);
    const existing = this.#rows.get(input.idempotencyKey);
    if (existing !== undefined) return existing;
    const at = this.#now();
    const entry: JournalEntry = {
      idempotencyKey: input.idempotencyKey,
      agentId: input.agentId,
      ownerAddress: input.ownerAddress,
      kind: input.kind,
      decisionId: input.decisionId ?? null,
      state: "PENDING",
      externalRef: mergeRef({}, {
        ...input.externalRef,
        ...(principal?.kind === "billing_account" ? { billingPrincipal: principal } : {}),
      }),
      ...(principal === undefined ? {} : { principal }),
      nativeSpendWei: input.nativeSpendWei ?? 0n,
      begunAtBlock,
      finalCallsFingerprint: finalCalls.canonical,
      finalCallsFingerprintHash: finalCalls.hash,
      preparedIntentIdentity: null,
      preparedIntentIdentityHash: null,
      preparedBindingVersion: 0,
      billingCallsIdVersion: 0,
      landingResolutionId: null,
      landingResolutionKeyHash: null,
      landingResolutionOutcome: null,
      landingResolutionEvidenceHash: null,
      landingResolutionTerminalAt: null,
      lastError: null,
      createdAt: at,
      updatedAt: at,
    };
    this.#rows.set(input.idempotencyKey, entry);
    return entry;
  }

  bindPreparedIntent(
    idempotencyKey: string,
    input: JournalPreparedIntentBindInput,
  ): Promise<JournalPreparedIntentBindResult> {
    normalizePreparedBind(input);
    return this.#withLock(idempotencyKey, async () => {
      const current = this.#rows.get(idempotencyKey);
      if (current === undefined) throw new Error(`Journal row "${idempotencyKey}" does not exist.`);
      if (current.kind !== "lp" || current.finalCallsFingerprint === null ||
          current.finalCallsFingerprintHash === null) {
        throw new Error("Prepared intent binding requires a fingerprinted LP row.");
      }
      assertPreparedBindMatchesFinalCalls(current, input);
      if (current.preparedIntentIdentity !== null) {
        if (current.preparedIntentIdentity !== input.canonicalIdentity ||
            current.preparedIntentIdentityHash !== input.identityHash) {
          throw new Error("Prepared intent identity is already bound to different bytes.");
        }
        return { entry: current, boundBindingVersion: current.preparedBindingVersion };
      }
      if (current.preparedBindingVersion !== input.expectedBindingVersion) {
        throw new Error("Prepared intent binding version conflict.");
      }
      const next: JournalEntry = {
        ...current,
        preparedIntentIdentity: input.canonicalIdentity,
        preparedIntentIdentityHash: input.identityHash,
        preparedBindingVersion: current.preparedBindingVersion + 1,
        updatedAt: this.#now(),
      };
      this.#rows.set(idempotencyKey, next);
      return { entry: next, boundBindingVersion: next.preparedBindingVersion };
    });
  }

  #sum(agentId: string, sinceMs: number, excludeKey?: string): bigint {
    let total = 0n;
    for (const row of this.#rows.values()) {
      if (row.agentId !== agentId) continue;
      if (row.createdAt < sinceMs) continue;
      if (excludeKey !== undefined && row.idempotencyKey === excludeKey) continue;
      if (!SPEND_COUNTING_STATES.has(row.state)) continue;
      total += row.nativeSpendWei;
    }
    return total;
  }

  markInProgress(
    idempotencyKey: string,
    externalRef: JournalExternalRef,
  ): Promise<JournalEntry> {
    return this.#transition(idempotencyKey, "IN_PROGRESS", { externalRef });
  }

  markCommitted(
    idempotencyKey: string,
    externalRef?: JournalExternalRef,
  ): Promise<JournalEntry> {
    return this.#transition(idempotencyKey, "COMMITTED", { externalRef });
  }

  markRolledBack(
    idempotencyKey: string,
    lastError?: string,
    externalRef?: JournalExternalRef,
  ): Promise<JournalEntry> {
    return this.#transition(idempotencyKey, "ROLLED_BACK", {
      lastError,
      externalRef,
    });
  }

  markUnknown(
    idempotencyKey: string,
    lastError?: string,
  ): Promise<JournalEntry> {
    return this.#transition(idempotencyKey, "UNKNOWN", { lastError });
  }

  resolveUnknown(
    idempotencyKey: string,
    evidence: JournalResolutionEvidence,
  ): Promise<JournalEntry> {
    // `lastError` is deliberately NOT passed: the merge already honours
    // `undefined` as "leave it alone", which is Rev2 item 17's promise.
    return this.#transition(
      idempotencyKey,
      "ROLLED_BACK",
      { externalRef: { resolution: boundResolutionEvidence(evidence) } },
      "resolve-unknown",
    );
  }

  bindBillingCollectCallsId(input: BillingCollectCallsIdBindInput): Promise<JournalEntry> {
    assertBillingCallsIdInput(input);
    return this.#withLock(input.decisionId, async () => {
      const current = this.#rows.get(input.decisionId);
      if (current === undefined) throw new Error(`Journal row "${input.decisionId}" does not exist.`);
      const next = billingCallsIdNext(current, input, this.#now());
      if (next !== current) this.#rows.set(input.decisionId, next);
      return next;
    });
  }

  resolveBillingCollection(
    idempotencyKey: string,
    resolution: BillingCollectionResolution,
  ): Promise<JournalEntry> {
    return this.#withLock(idempotencyKey, async () => {
      const current = this.#rows.get(idempotencyKey);
      if (current === undefined) {
        throw new Error(`Journal row "${idempotencyKey}" does not exist.`);
      }
      const normalized = assertBillingCollectionResolution(current, resolution);
      const target = normalized.outcome === "paid" ? "COMMITTED" : "ROLLED_BACK";
      if (current.state === target) return current;
      const next: JournalEntry = {
        ...current,
        state: target,
        externalRef: mergeRef(current.externalRef, {
          callsId: normalized.callsId,
          txHash: normalized.transactionHash,
        }),
        updatedAt: this.#now(),
      };
      this.#rows.set(idempotencyKey, next);
      return next;
    });
  }

  advanceUnknown(
    idempotencyKey: string,
    evidence: JournalResolutionEvidence,
    externalRef?: JournalExternalRef,
  ): Promise<JournalEntry> {
    // `lastError` preserved for the same reason: why the row went UNKNOWN is history.
    return this.#transition(
      idempotencyKey,
      "COMMITTED",
      {
        externalRef: {
          ...(externalRef ?? {}),
          resolution: boundResolutionEvidence(evidence),
        },
      },
      "advance-on-chain",
    );
  }

  joinLandingAction(input: {
    readonly idempotencyKey: string; readonly resolutionId: string;
    readonly resolutionKeyHash: Hex;
  }): Promise<JournalEntry> {
    return this.#withLock(input.idempotencyKey, async () => {
      const current = this.#rows.get(input.idempotencyKey);
      if (current === undefined || current.kind !== "resolveUnknownLandingV1") {
        throw new Error("Landing action journal row does not exist.");
      }
      if (current.state === "COMMITTED") return current;
      if (current.landingResolutionId !== null &&
          (current.landingResolutionId !== input.resolutionId ||
           current.landingResolutionKeyHash !== input.resolutionKeyHash)) {
        throw new Error("Landing action resolution join conflict.");
      }
      const next: JournalEntry = { ...current, state: "IN_PROGRESS",
        landingResolutionId: input.resolutionId,
        landingResolutionKeyHash: input.resolutionKeyHash,
        externalRef: mergeRef(current.externalRef, { landingAction: {
          scheme: "resolve-landing-action-v1", resolutionId: input.resolutionId,
          state: "IN_PROGRESS",
        } }), updatedAt: this.#now() };
      this.#rows.set(input.idempotencyKey, next);
      return next;
    });
  }

  reserveLandingDisposition(input: {
    readonly idempotencyKey: string; readonly resolutionId: string;
    readonly resolutionKeyHash: Hex; readonly outcome: "landed" | "absent";
    readonly txHash?: Hex;
  }): Promise<JournalEntry> {
    return this.#withLock(input.idempotencyKey, async () => {
      const current = this.#rows.get(input.idempotencyKey);
      if (current === undefined) throw new Error(`Journal row "${input.idempotencyKey}" does not exist.`);
      const target = input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK";
      if (current.landingResolutionId !== null) {
        assertLandingReservation(current, input.resolutionId, input.resolutionKeyHash, target);
        return current;
      }
      assertResolvableUnknown(current);
      const next: JournalEntry = { ...current, state: target,
        externalRef: mergeRef(current.externalRef,
          input.txHash === undefined ? undefined : { txHash: input.txHash }),
        landingResolutionId: input.resolutionId,
        landingResolutionKeyHash: input.resolutionKeyHash, updatedAt: this.#now() };
      this.#rows.set(input.idempotencyKey, next);
      return next;
    });
  }

  finalizeLandingDisposition(input: {
    readonly idempotencyKey: string; readonly resolutionId: string;
    readonly resolutionKeyHash: Hex; readonly outcome: "landed" | "absent";
    readonly evidenceHash: Hex; readonly terminalAt: number;
  }): Promise<JournalEntry> {
    return this.#withLock(input.idempotencyKey, async () => {
      const current = this.#rows.get(input.idempotencyKey);
      if (current === undefined) throw new Error(`Journal row "${input.idempotencyKey}" does not exist.`);
      const target = input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK";
      assertLandingReservation(current, input.resolutionId, input.resolutionKeyHash, target);
      if (current.landingResolutionOutcome !== null) {
        if (current.landingResolutionOutcome !== input.outcome ||
            current.landingResolutionEvidenceHash !== input.evidenceHash ||
            current.landingResolutionTerminalAt !== input.terminalAt) {
          throw new Error("Landing resolution terminal evidence conflict.");
        }
        return current;
      }
      const next: JournalEntry = { ...current, landingResolutionOutcome: input.outcome,
        landingResolutionEvidenceHash: input.evidenceHash,
        landingResolutionTerminalAt: input.terminalAt, updatedAt: this.#now() };
      this.#rows.set(input.idempotencyKey, next);
      return next;
    });
  }

  completeLandingAction(
    idempotencyKey: string,
    externalRef: JournalExternalRef,
  ): Promise<JournalEntry> {
    return this.#withLock(idempotencyKey, async () => {
      const current = this.#rows.get(idempotencyKey);
      if (current === undefined || current.kind !== "resolveUnknownLandingV1") {
        throw new Error("Landing action journal row does not exist.");
      }
      if (current.state === "COMMITTED") return current;
      const refusal = externalRef.landingResult?.outcome === "ambiguous" ||
        externalRef.landingResult?.outcome === "unavailable";
      const next = { ...current, state: "COMMITTED" as const,
        externalRef: mergeRef(current.externalRef, externalRef),
        ...(refusal ? { landingResolutionId: null, landingResolutionKeyHash: null } : {}),
        updatedAt: this.#now() };
      this.#rows.set(idempotencyKey, next);
      return next;
    });
  }

  async retireProvenPreBind(idempotencyKey: string): Promise<JournalEntry> {
    return this.#withLock(idempotencyKey, async () => {
      const current = this.#rows.get(idempotencyKey);
      if (current === undefined || current.kind !== "lp" || current.state !== "UNKNOWN" ||
          current.preparedIntentIdentity !== null || current.preparedIntentIdentityHash !== null ||
          current.preparedBindingVersion !== 0 || current.landingResolutionId !== null ||
          current.landingResolutionKeyHash !== null || current.landingResolutionOutcome !== null ||
          current.landingResolutionEvidenceHash !== null || current.landingResolutionTerminalAt !== null) {
        throw new Error("LP journal row is not eligible for proved pre-bind retirement.");
      }
      assertTransition(current.state, "ROLLED_BACK", "retire-pre-bind");
      const next = { ...current, state: "ROLLED_BACK" as const,
        externalRef: mergeRef(current.externalRef, { retirementEvidence: {
          scheme: "retired-pre-bind-v1",
        } }), updatedAt: this.#now() };
      this.#rows.set(idempotencyKey, next);
      return next;
    });
  }

  async completePreBindRetirementAction(
    idempotencyKey: string,
    externalRef: JournalExternalRef,
  ): Promise<JournalEntry> {
    assertPreBindRetirementResult(externalRef);
    return this.#withLock(idempotencyKey, async () => {
      const current = this.#rows.get(idempotencyKey);
      if (current === undefined || current.kind !== "retireLpPreBindV1") {
        throw new Error("Pre-bind retirement action journal row does not exist.");
      }
      if (current.state === "COMMITTED") {
        if (!samePreBindRetirementResult(current.externalRef, externalRef)) {
          throw new Error("Pre-bind retirement action result conflict.");
        }
        return current;
      }
      const next = { ...current, state: "COMMITTED" as const,
        externalRef: mergeRef(current.externalRef, externalRef), updatedAt: this.#now() };
      this.#rows.set(idempotencyKey, next);
      return next;
    });
  }


  async get(idempotencyKey: string): Promise<JournalEntry | null> {
    return this.#rows.get(idempotencyKey) ?? null;
  }

  async getByDecision(
    agentId: string,
    decisionId: string,
  ): Promise<JournalEntry | null> {
    // Oldest first: the first row a decision produced is the one that fixed its
    // calls hash, so a later conflicting submit is compared against THAT.
    const matches = [...this.#rows.values()]
      .filter(
        (entry) =>
          MONEY_KINDS.has(entry.kind) &&
          entry.agentId === agentId &&
          entry.decisionId === decisionId,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    return matches[0] ?? null;
  }

  async listUnknownForAgent(agentId: string): Promise<JournalEntry[]> {
    return [...this.#rows.values()]
      .filter((entry) => entry.agentId === agentId && entry.state === "UNKNOWN")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async hasPendingForAgent(agentId: string, excludeIdempotencyKey?: string): Promise<boolean> {
    return [...this.#rows.values()].some((entry) => entry.agentId === agentId && entry.state === "PENDING"
      && entry.idempotencyKey !== excludeIdempotencyKey);
  }

  async sumNativeSpendSince(
    agentId: string,
    sinceMs: number,
    excludeIdempotencyKey?: string,
  ): Promise<bigint> {
    return this.#sum(agentId, sinceMs, excludeIdempotencyKey);
  }

  async listNonTerminal(): Promise<JournalEntry[]> {
    return [...this.#rows.values()]
      .filter((entry) => NON_TERMINAL.has(entry.state))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async close(): Promise<void> {
    this.#rows.clear();
    this.#locks.clear();
  }

  #transition(
    idempotencyKey: string,
    target: JournalState,
    change: {
      externalRef?: JournalExternalRef | undefined;
      lastError?: string | undefined;
    },
    path: TransitionPath = "standard",
  ): Promise<JournalEntry> {
    return this.#withLock(idempotencyKey, async () => {
      const current = this.#rows.get(idempotencyKey);
      if (current === undefined) {
        throw new Error(`Journal row "${idempotencyKey}" does not exist.`);
      }
      if (path === "resolve-unknown" || path === "advance-on-chain" || path === "retire-pre-bind") {
        assertResolvableUnknown(current);
      }
      if (
        current.kind === "billingCollect" &&
        (target === "COMMITTED" || target === "ROLLED_BACK")
      ) {
        throw new Error("billingCollect may become terminal only through canonical billing collection proof.");
      }
      assertTransition(current.state, target, path);
      const next: JournalEntry = {
        ...current,
        state: target,
        externalRef: mergeRef(current.externalRef, change.externalRef),
        lastError:
          change.lastError === undefined
            ? current.lastError
            : change.lastError.slice(0, MAX_ERROR_CHARS),
        updatedAt: this.#now(),
      };
      this.#rows.set(idempotencyKey, next);
      return next;
    });
  }

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Serialize same-key operations: each run chains after the previous one has
    // settled. The map stores a failure-swallowed tail so one rejected op does
    // not break the chain for the next; the caller still sees `run`'s result.
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.#locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

type JournalRow = {
  idempotency_key: string;
  agent_id: string;
  owner_address: string;
  kind: string;
  decision_id: string | null;
  state: string;
  external_ref: unknown;
  native_spend_wei: string | number | null;
  begun_at_block: string | number | bigint | null;
  final_calls_fingerprint: string | null;
  final_calls_fingerprint_hash: Hex | null;
  prepared_intent_identity: string | null;
  prepared_intent_identity_hash: Hex | null;
  prepared_binding_version: string | number | bigint;
  billing_calls_id_version: string | number | bigint;
  landing_resolution_id: string | null;
  landing_resolution_key_hash: Hex | null;
  landing_resolution_outcome: "landed" | "absent" | null;
  landing_resolution_evidence_hash: Hex | null;
  landing_resolution_terminal_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Every column a row read selects. One constant so the list cannot drift. */
const JOURNAL_COLUMNS =
  "idempotency_key, agent_id, owner_address, kind, decision_id, state, external_ref, native_spend_wei, begun_at_block, final_calls_fingerprint, final_calls_fingerprint_hash, prepared_intent_identity, prepared_intent_identity_hash, prepared_binding_version, billing_calls_id_version, landing_resolution_id, landing_resolution_key_hash, landing_resolution_outcome, landing_resolution_evidence_hash, landing_resolution_terminal_at, last_error, created_at, updated_at";

const JOURNAL_DDL = `
  create table if not exists execution_journal (
    idempotency_key text primary key,
    agent_id text not null,
    owner_address text not null,
    kind text not null,
    decision_id text,
    state text not null,
    external_ref jsonb,
    native_spend_wei numeric(78, 0),
    begun_at_block bigint,
    final_calls_fingerprint varchar(192),
    final_calls_fingerprint_hash char(66),
    prepared_intent_identity varchar(1024),
    prepared_intent_identity_hash char(66),
    prepared_binding_version bigint not null default 0 check (prepared_binding_version >= 0),
    billing_calls_id_version bigint not null default 0 check (billing_calls_id_version in (0, 1)),
    landing_resolution_id varchar(128),
    landing_resolution_key_hash char(66),
    landing_resolution_outcome varchar(16),
    landing_resolution_evidence_hash char(66),
    landing_resolution_terminal_at timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )
`;

/**
 * Additive migration for journals created before 1b-api. `if not exists` makes
 * it a no-op on a fresh table and on every restart after the first.
 */
const JOURNAL_DECISION_COLUMN_DDL = `
  alter table execution_journal add column if not exists decision_id text
`;

const JOURNAL_DECISION_INDEX_DDL = `
  create index if not exists execution_journal_decision_idx
    on execution_journal (agent_id, decision_id)
`;

/**
 * Additive migration for journals created before Phase 2. `numeric(78, 0)` holds
 * a full uint256 exactly; a `bigint` column would silently overflow at 2^63, and
 * a float would lose wei.
 */
const JOURNAL_SPEND_COLUMN_DDL = `
  alter table execution_journal add column if not exists native_spend_wei numeric(78, 0)
`;

/** Phase 3.9b: nullable because old and non-LP rows have no honest chain bound. */
const JOURNAL_BEGUN_BLOCK_COLUMN_DDL = `
  alter table execution_journal add column if not exists begun_at_block bigint
`;

const JOURNAL_PREPARED_BINDING_DDL = `
  alter table execution_journal
    add column if not exists final_calls_fingerprint varchar(192),
    add column if not exists final_calls_fingerprint_hash char(66),
    add column if not exists prepared_intent_identity varchar(1024),
    add column if not exists prepared_intent_identity_hash char(66),
    add column if not exists prepared_binding_version bigint not null default 0
`;

const JOURNAL_BILLING_CALLS_ID_DDL = `
  alter table execution_journal
    add column if not exists billing_calls_id_version bigint not null default 0
`;

const JOURNAL_BILLING_CALLS_ID_CHECK_DDL = `
  do $journal_billing_calls_id$
  begin
    if not exists (select 1 from pg_constraint where conname = 'execution_journal_billing_calls_id_check') then
      alter table execution_journal add constraint execution_journal_billing_calls_id_check
        check (billing_calls_id_version in (0, 1));
    end if;
  end $journal_billing_calls_id$
`;

const JOURNAL_PREPARED_BINDING_CHECK_DDL = `
  do $journal_prepared_binding$
  begin
    if not exists (select 1 from pg_constraint where conname = 'execution_journal_prepared_binding_check') then
      alter table execution_journal add constraint execution_journal_prepared_binding_check check (
        prepared_binding_version >= 0 and
        ((final_calls_fingerprint is null and final_calls_fingerprint_hash is null) or
         (kind = 'lp' and final_calls_fingerprint is not null and final_calls_fingerprint_hash ~ '^0x[0-9a-f]{64}$')) and
        ((prepared_intent_identity is null and prepared_intent_identity_hash is null) or
         (kind = 'lp' and prepared_intent_identity is not null and prepared_intent_identity_hash ~ '^0x[0-9a-f]{64}$'))
      );
    end if;
  end $journal_prepared_binding$
`;

const JOURNAL_LANDING_RESOLUTION_DDL = `
  alter table execution_journal
    add column if not exists landing_resolution_id varchar(128),
    add column if not exists landing_resolution_key_hash char(66),
    add column if not exists landing_resolution_outcome varchar(16),
    add column if not exists landing_resolution_evidence_hash char(66),
    add column if not exists landing_resolution_terminal_at timestamptz
`;

const JOURNAL_LANDING_RESOLUTION_CHECK_DDL = `
  do $journal_landing_resolution$
  begin
    if not exists(select 1 from pg_constraint
      where conname='execution_journal_landing_resolution_check' and
        conrelid='execution_journal'::regclass) then
      alter table execution_journal add constraint execution_journal_landing_resolution_check check(
       (landing_resolution_id is null and landing_resolution_key_hash is null and
        landing_resolution_outcome is null and landing_resolution_evidence_hash is null and
        landing_resolution_terminal_at is null)
       or
       (landing_resolution_id is not null and landing_resolution_key_hash ~ '^0x[0-9a-f]{64}$' and
        landing_resolution_outcome is null and landing_resolution_evidence_hash is null and
        landing_resolution_terminal_at is null)
       or
       (landing_resolution_id is not null and landing_resolution_key_hash ~ '^0x[0-9a-f]{64}$' and
        landing_resolution_outcome in ('landed','absent') and
        landing_resolution_evidence_hash ~ '^0x[0-9a-f]{64}$' and
        landing_resolution_terminal_at is not null)
      );
    end if;
  end $journal_landing_resolution$
`;

/** Serves the rolling-window spend sum, which runs on every trade. */
const JOURNAL_SPEND_INDEX_DDL = `
  create index if not exists execution_journal_spend_idx
    on execution_journal (agent_id, created_at)
`;

export class PostgresExecutionJournal implements ExecutionJournal {
  readonly #sql: SqlClient;
  readonly #now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.#now = now;
  }

  static async create(
    sql: SqlClient,
    now: Clock = Date.now,
  ): Promise<PostgresExecutionJournal> {
    await sql.query(JOURNAL_DDL);
    await sql.query(JOURNAL_DECISION_COLUMN_DDL);
    await sql.query(JOURNAL_SPEND_COLUMN_DDL);
    await sql.query(JOURNAL_BEGUN_BLOCK_COLUMN_DDL);
    await sql.query(JOURNAL_PREPARED_BINDING_DDL);
    await sql.query(JOURNAL_PREPARED_BINDING_CHECK_DDL);
    await sql.query(JOURNAL_BILLING_CALLS_ID_DDL);
    await sql.query(JOURNAL_BILLING_CALLS_ID_CHECK_DDL);
    await sql.query(JOURNAL_LANDING_RESOLUTION_DDL);
    await sql.query(JOURNAL_LANDING_RESOLUTION_CHECK_DDL);
    await sql.query(JOURNAL_DECISION_INDEX_DDL);
    await sql.query(JOURNAL_SPEND_INDEX_DDL);
    return new PostgresExecutionJournal(sql, now);
  }

  async begin(input: JournalBeginInput): Promise<JournalEntry> {
    return this.#sql.transaction(async (tx) => this.#insert(tx, input));
  }

  async beginWithSpend(
    input: JournalBeginInput,
    sinceMs: number,
  ): Promise<JournalBeginWithSpendResult> {
    return this.#sql.transaction(async (tx) => {
      // ONE transaction: the row is inserted and the competing spend is summed
      // under the same snapshot, so a concurrent trade either sees this row or
      // is seen by it — never neither.
      const { entry, created } = await this.#insertDetecting(tx, input);
      const otherSpendWei = await this.#sum(
        tx,
        input.agentId,
        sinceMs,
        input.idempotencyKey,
      );
      return { entry, otherSpendWei, created };
    });
  }

  async #insert(tx: SqlClient, input: JournalBeginInput): Promise<JournalEntry> {
    return (await this.#insertDetecting(tx, input)).entry;
  }

  async #insertDetecting(
    tx: SqlClient,
    input: JournalBeginInput,
  ): Promise<{ entry: JournalEntry; created: boolean }> {
    // The retirement action's JSON is its durable authorization descriptor.
    // Validate it before `beginInsert`: PostgreSQL must not leave a malformed
    // PENDING row behind while the in-memory backend refuses it pre-write.
    assertRetirementExternalRef(input.kind, "PENDING", input.externalRef ?? {});
    const principal = journalPrincipal(input);
    const begunAtBlock = normalizeBegunAtBlock(input.begunAtBlock);
    const finalCalls = normalizeFinalCallsBinding(input);
    // Insert if absent; the conflict clause makes concurrent begins a no-op
    // for all but the first. `returning` yields a row ONLY for the caller whose
    // insert took — that is what `created` means, and it is the only signal that
    // can tell the creator from a racing duplicate, because by read-back time
    // both observe the same committed PENDING row. FOR UPDATE then serializes
    // the read-back so both callers observe that single row.
    const inserted = await tx.query<{ idempotency_key: string }>(
      `/* journal.beginInsert */
       insert into execution_journal
         (idempotency_key, agent_id, owner_address, kind, decision_id, state, external_ref, native_spend_wei, begun_at_block, created_at, updated_at, final_calls_fingerprint, final_calls_fingerprint_hash)
       values ($1, $2, $3, $4, $5, 'PENDING', $6::jsonb, $7::numeric, $8::bigint, $9, $9, $10, $11)
       on conflict (idempotency_key) do nothing
       returning idempotency_key`,
      [
        input.idempotencyKey,
        input.agentId,
        input.ownerAddress,
        input.kind,
        input.decisionId ?? null,
        encodeJsonbParam(mergeRef({}, {
          ...input.externalRef,
          ...(principal?.kind === "billing_account" ? { billingPrincipal: principal } : {}),
        })),
        (input.nativeSpendWei ?? 0n).toString(10),
        begunAtBlock === null ? null : begunAtBlock.toString(10),
        new Date(this.#now()),
        finalCalls.canonical,
        finalCalls.hash,
      ],
    );
    const locked = await tx.query<JournalRow>(
      `/* journal.beginSelect */
       select ${JOURNAL_COLUMNS}
       from execution_journal where idempotency_key = $1 for update`,
      [input.idempotencyKey],
    );
    const row = locked.rows[0];
    if (row === undefined) {
      throw new Error("Journal begin failed to read back the inserted row.");
    }
    return { entry: rowToEntry(row), created: inserted.rows.length > 0 };
  }

  async bindPreparedIntent(
    idempotencyKey: string,
    input: JournalPreparedIntentBindInput,
  ): Promise<JournalPreparedIntentBindResult> {
    normalizePreparedBind(input);
    return this.#sql.transaction(async (tx) => {
      const locked = await tx.query<JournalRow>(
        `/* journal.bindPreparedSelect */
         select ${JOURNAL_COLUMNS} from execution_journal
         where idempotency_key = $1 for update`,
        [idempotencyKey],
      );
      const row = locked.rows[0];
      if (row === undefined) throw new Error(`Journal row "${idempotencyKey}" does not exist.`);
      const current = rowToEntry(row);
      if (current.kind !== "lp" || current.finalCallsFingerprint === null ||
          current.finalCallsFingerprintHash === null) {
        throw new Error("Prepared intent binding requires a fingerprinted LP row.");
      }
      assertPreparedBindMatchesFinalCalls(current, input);
      if (current.preparedIntentIdentity !== null) {
        if (current.preparedIntentIdentity !== input.canonicalIdentity ||
            current.preparedIntentIdentityHash !== input.identityHash) {
          throw new Error("Prepared intent identity is already bound to different bytes.");
        }
        return { entry: current, boundBindingVersion: current.preparedBindingVersion };
      }
      const updated = await tx.query<JournalRow>(
        `/* journal.bindPreparedUpdate */
         update execution_journal
         set prepared_intent_identity = $2,
             prepared_intent_identity_hash = $3,
             prepared_binding_version = prepared_binding_version + 1,
             updated_at = $5
         where idempotency_key = $1
           and kind = 'lp'
           and prepared_binding_version = $4
           and prepared_intent_identity is null
           and prepared_intent_identity_hash is null
         returning ${JOURNAL_COLUMNS}`,
        [
          idempotencyKey,
          input.canonicalIdentity,
          input.identityHash,
          input.expectedBindingVersion,
          new Date(this.#now()),
        ],
      );
      const next = updated.rows[0];
      if (next === undefined) throw new Error("Prepared intent binding version conflict.");
      const entry = rowToEntry(next);
      return { entry, boundBindingVersion: entry.preparedBindingVersion };
    });
  }

  async #sum(
    tx: SqlClient,
    agentId: string,
    sinceMs: number,
    excludeIdempotencyKey?: string,
  ): Promise<bigint> {
    const result = await tx.query<{ total: string | number | null }>(
      `/* journal.sumNativeSpend */
       select coalesce(sum(native_spend_wei), 0)::text as total
       from execution_journal
       where agent_id = $1
         and created_at >= $2
         and state in ('PENDING', 'IN_PROGRESS', 'COMMITTED', 'UNKNOWN')
         and ($3::text is null or idempotency_key <> $3)`,
      [agentId, new Date(sinceMs), excludeIdempotencyKey ?? null],
    );
    return toWei(result.rows[0]?.total ?? null);
  }

  markInProgress(
    idempotencyKey: string,
    externalRef: JournalExternalRef,
  ): Promise<JournalEntry> {
    return this.#transition(idempotencyKey, "IN_PROGRESS", { externalRef });
  }

  markCommitted(
    idempotencyKey: string,
    externalRef?: JournalExternalRef,
  ): Promise<JournalEntry> {
    return this.#transition(idempotencyKey, "COMMITTED", { externalRef });
  }

  markRolledBack(
    idempotencyKey: string,
    lastError?: string,
    externalRef?: JournalExternalRef,
  ): Promise<JournalEntry> {
    return this.#transition(idempotencyKey, "ROLLED_BACK", {
      lastError,
      externalRef,
    });
  }

  markUnknown(
    idempotencyKey: string,
    lastError?: string,
  ): Promise<JournalEntry> {
    return this.#transition(idempotencyKey, "UNKNOWN", { lastError });
  }

  resolveUnknown(
    idempotencyKey: string,
    evidence: JournalResolutionEvidence,
  ): Promise<JournalEntry> {
    // `lastError` omitted on purpose — the transition below preserves it.
    return this.#transition(
      idempotencyKey,
      "ROLLED_BACK",
      { externalRef: { resolution: boundResolutionEvidence(evidence) } },
      "resolve-unknown",
    );
  }

  advanceUnknown(
    idempotencyKey: string,
    evidence: JournalResolutionEvidence,
    externalRef?: JournalExternalRef,
  ): Promise<JournalEntry> {
    // `lastError` omitted on purpose — the transition preserves it.
    return this.#transition(
      idempotencyKey,
      "COMMITTED",
      {
        externalRef: {
          ...(externalRef ?? {}),
          resolution: boundResolutionEvidence(evidence),
        },
      },
      "advance-on-chain",
    );
  }

  async bindBillingCollectCallsId(input: BillingCollectCallsIdBindInput): Promise<JournalEntry> {
    assertBillingCallsIdInput(input);
    return this.#sql.transaction(async (tx) => {
      const locked = await tx.query<JournalRow>(
        `/* journal.billingCallsIdSelect */
         select ${JOURNAL_COLUMNS} from execution_journal
         where idempotency_key = $1 for update`,
        [input.decisionId],
      );
      const row = locked.rows[0];
      if (row === undefined) throw new Error(`Journal row "${input.decisionId}" does not exist.`);
      const current = rowToEntry(row);
      const next = billingCallsIdNext(current, input, this.#now());
      if (next === current) return current;
      const updated = await tx.query<JournalRow>(
        `/* journal.billingCallsIdUpdate */
         update execution_journal
         set external_ref = $2::jsonb,
             billing_calls_id_version = 1,
             updated_at = $4
         where idempotency_key = $1
           and billing_calls_id_version = $3
           and state in ('PENDING', 'IN_PROGRESS', 'UNKNOWN')
         returning ${JOURNAL_COLUMNS}`,
        [
          input.decisionId,
          encodeJsonbParam(next.externalRef),
          input.expectedCallsIdVersion,
          new Date(next.updatedAt),
        ],
      );
      const bound = updated.rows[0];
      if (bound === undefined) throw new Error("Billing collection callsId binding version conflict.");
      return rowToEntry(bound);
    });
  }

  resolveBillingCollection(
    idempotencyKey: string,
    resolution: BillingCollectionResolution,
  ): Promise<JournalEntry> {
    return this.#sql.transaction(async (tx) => {
      const locked = await tx.query<JournalRow>(
        `/* journal.billingCollectionResolveSelect */
         select ${JOURNAL_COLUMNS} from execution_journal
         where idempotency_key = $1 for update`,
        [idempotencyKey],
      );
      const raw = locked.rows[0];
      if (raw === undefined) throw new Error(`Journal row "${idempotencyKey}" does not exist.`);
      const current = rowToEntry(raw);
      const normalized = assertBillingCollectionResolution(current, resolution);
      const target = normalized.outcome === "paid" ? "COMMITTED" : "ROLLED_BACK";
      if (current.state === target) return current;
      const externalRef = mergeRef(current.externalRef, {
        callsId: normalized.callsId,
        txHash: normalized.transactionHash,
      });
      const updated = await tx.query<JournalRow>(
        `/* journal.billingCollectionResolveUpdate */
         update execution_journal
         set state = $2, external_ref = $3::jsonb, updated_at = $4
         where idempotency_key = $1 and kind = 'billingCollect'
           and state in ('IN_PROGRESS', 'UNKNOWN')
         returning ${JOURNAL_COLUMNS}`,
        [idempotencyKey, target, encodeJsonbParam(externalRef), new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Billing collection journal resolution conflict.");
      return rowToEntry(row);
    });
  }

  joinLandingAction(input: {
    readonly idempotencyKey: string; readonly resolutionId: string;
    readonly resolutionKeyHash: Hex;
  }): Promise<JournalEntry> {
    return this.#sql.transaction(async (tx) => {
      const resolution = await tx.query<{ resolution_id: string }>(
        `/* journal.landingActionJoinResolutionLock */ select resolution_id from
         lp_landing_resolutions where resolution_id=$1 for update`, [input.resolutionId],
      );
      if (resolution.rows[0] === undefined) {
        throw new Error("Landing action resolution does not exist.");
      }
      const locked = await tx.query<JournalRow>(
        `/* journal.landingActionJoinLock */ select ${JOURNAL_COLUMNS} from execution_journal
         where idempotency_key=$1 and kind='resolveUnknownLandingV1' for update`,
        [input.idempotencyKey],
      );
      const raw = locked.rows[0];
      if (raw === undefined) throw new Error("Landing action journal row does not exist.");
      const current = rowToEntry(raw);
      if (current.state === "COMMITTED") return current;
      if (current.landingResolutionId !== null) {
        if (current.landingResolutionId !== input.resolutionId ||
            current.landingResolutionKeyHash !== input.resolutionKeyHash) {
          throw new Error("Landing action resolution join conflict.");
        }
        return current;
      }
      const externalRef = mergeRef(current.externalRef, { landingAction: {
        scheme: "resolve-landing-action-v1", resolutionId: input.resolutionId,
        state: "IN_PROGRESS",
      } });
      const updated = await tx.query<JournalRow>(
        `/* journal.landingActionJoin */ update execution_journal set state='IN_PROGRESS',
          external_ref=$2::jsonb,landing_resolution_id=$3,landing_resolution_key_hash=$4,
          updated_at=$5 where idempotency_key=$1 and kind='resolveUnknownLandingV1' and
          state in ('PENDING','IN_PROGRESS') and landing_resolution_id is null and
          landing_resolution_key_hash is null and landing_resolution_outcome is null and
          landing_resolution_evidence_hash is null and landing_resolution_terminal_at is null
          returning ${JOURNAL_COLUMNS}`,
        [input.idempotencyKey, encodeJsonbParam(externalRef), input.resolutionId,
          input.resolutionKeyHash, new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Landing action resolution join conflict.");
      return rowToEntry(row);
    });
  }

  reserveLandingDisposition(input: {
    readonly idempotencyKey: string; readonly resolutionId: string;
    readonly resolutionKeyHash: Hex; readonly outcome: "landed" | "absent";
    readonly txHash?: Hex;
  }): Promise<JournalEntry> {
    return this.#sql.transaction(async (tx) => {
      const locked = await tx.query<JournalRow>(
        `/* journal.landingLock */ select ${JOURNAL_COLUMNS} from execution_journal
         where idempotency_key=$1 for update`, [input.idempotencyKey],
      );
      const raw = locked.rows[0];
      if (raw === undefined) throw new Error(`Journal row "${input.idempotencyKey}" does not exist.`);
      const current = rowToEntry(raw);
      const target = input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK";
      if (current.landingResolutionId !== null) {
        assertLandingReservation(current, input.resolutionId, input.resolutionKeyHash, target);
        return current;
      }
      assertResolvableUnknown(current);
      const updated = await tx.query<JournalRow>(
        `/* journal.landingReserve */ update execution_journal set state=$2,
          external_ref=$3::jsonb,landing_resolution_id=$4,landing_resolution_key_hash=$5,
          updated_at=$6 where idempotency_key=$1 and state='UNKNOWN' and
          landing_resolution_id is null and landing_resolution_key_hash is null and
          landing_resolution_outcome is null and landing_resolution_evidence_hash is null and
          landing_resolution_terminal_at is null returning ${JOURNAL_COLUMNS}`,
        [input.idempotencyKey, target, encodeJsonbParam(mergeRef(current.externalRef,
          input.txHash === undefined ? undefined : { txHash: input.txHash })),
          input.resolutionId, input.resolutionKeyHash, new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Landing resolution journal reservation conflict.");
      return rowToEntry(row);
    });
  }

  finalizeLandingDisposition(input: {
    readonly idempotencyKey: string; readonly resolutionId: string;
    readonly resolutionKeyHash: Hex; readonly outcome: "landed" | "absent";
    readonly evidenceHash: Hex; readonly terminalAt: number;
  }): Promise<JournalEntry> {
    return this.#sql.transaction(async (tx) => {
      const locked = await tx.query<JournalRow>(
        `/* journal.landingLock */ select ${JOURNAL_COLUMNS} from execution_journal
         where idempotency_key=$1 for update`, [input.idempotencyKey],
      );
      const raw = locked.rows[0];
      if (raw === undefined) throw new Error(`Journal row "${input.idempotencyKey}" does not exist.`);
      const current = rowToEntry(raw);
      const target = input.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK";
      assertLandingReservation(current, input.resolutionId, input.resolutionKeyHash, target);
      if (current.landingResolutionOutcome !== null) {
        if (current.landingResolutionOutcome !== input.outcome ||
            current.landingResolutionEvidenceHash !== input.evidenceHash ||
            current.landingResolutionTerminalAt !== input.terminalAt) {
          throw new Error("Landing resolution terminal evidence conflict.");
        }
        return current;
      }
      const updated = await tx.query<JournalRow>(
        `/* journal.landingFinalize */ update execution_journal set
          landing_resolution_outcome=$4,landing_resolution_evidence_hash=$5,
          landing_resolution_terminal_at=$6,updated_at=$7
         where idempotency_key=$1 and landing_resolution_id=$2 and
          landing_resolution_key_hash=$3 and landing_resolution_outcome is null and
          landing_resolution_evidence_hash is null and landing_resolution_terminal_at is null
         returning ${JOURNAL_COLUMNS}`,
        [input.idempotencyKey, input.resolutionId, input.resolutionKeyHash, input.outcome,
          input.evidenceHash, new Date(input.terminalAt), new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Landing resolution terminal evidence conflict.");
      return rowToEntry(row);
    });
  }

  completeLandingAction(
    idempotencyKey: string,
    externalRef: JournalExternalRef,
  ): Promise<JournalEntry> {
    return this.#sql.transaction(async (tx) => {
      const locked = await tx.query<JournalRow>(
        `/* journal.landingActionLock */ select ${JOURNAL_COLUMNS} from execution_journal
         where idempotency_key=$1 and kind='resolveUnknownLandingV1' for update`,
        [idempotencyKey],
      );
      const raw = locked.rows[0];
      if (raw === undefined) throw new Error("Landing action journal row does not exist.");
      const current = rowToEntry(raw);
      if (current.state === "COMMITTED") return current;
      const refusal = externalRef.landingResult?.outcome === "ambiguous" ||
        externalRef.landingResult?.outcome === "unavailable";
      const updated = await tx.query<JournalRow>(
        `/* journal.landingActionComplete */ update execution_journal set state='COMMITTED',
          external_ref=$2::jsonb,updated_at=$3,landing_resolution_id=$4,
          landing_resolution_key_hash=$5 where idempotency_key=$1 and
          kind='resolveUnknownLandingV1' returning ${JOURNAL_COLUMNS}`,
        [idempotencyKey, encodeJsonbParam(mergeRef(current.externalRef, externalRef)),
          new Date(this.#now()), refusal ? null : current.landingResolutionId,
          refusal ? null : current.landingResolutionKeyHash],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Landing action completion conflict.");
      return rowToEntry(row);
    });
  }

  async retireProvenPreBind(idempotencyKey: string): Promise<JournalEntry> {
    return this.#sql.transaction(async (tx) => {
      const locked = await tx.query<JournalRow>(
        `/* journal.preBindRetirementLock */ select ${JOURNAL_COLUMNS} from execution_journal
         where idempotency_key=$1 for update`, [idempotencyKey],
      );
      const raw = locked.rows[0];
      if (raw === undefined) throw new Error("LP journal row is not eligible for proved pre-bind retirement.");
      const current = rowToEntry(raw);
      if (current.kind !== "lp" || current.state !== "UNKNOWN" ||
          current.preparedIntentIdentity !== null || current.preparedIntentIdentityHash !== null ||
          current.preparedBindingVersion !== 0 || current.landingResolutionId !== null ||
          current.landingResolutionKeyHash !== null || current.landingResolutionOutcome !== null ||
          current.landingResolutionEvidenceHash !== null || current.landingResolutionTerminalAt !== null) {
        throw new Error("LP journal row is not eligible for proved pre-bind retirement.");
      }
      const updated = await tx.query<JournalRow>(
        `/* journal.preBindRetirement */ update execution_journal set state='ROLLED_BACK',external_ref=$2::jsonb,updated_at=$3
         where idempotency_key=$1 and state='UNKNOWN' returning ${JOURNAL_COLUMNS}`,
        [idempotencyKey, encodeJsonbParam(mergeRef(current.externalRef, { retirementEvidence: {
          scheme: "retired-pre-bind-v1",
        } })), new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("LP journal row retirement conflict.");
      return rowToEntry(row);
    });
  }

  async completePreBindRetirementAction(
    idempotencyKey: string,
    externalRef: JournalExternalRef,
  ): Promise<JournalEntry> {
    assertPreBindRetirementResult(externalRef);
    return this.#sql.transaction(async (tx) => {
      const locked = await tx.query<JournalRow>(
        `/* journal.preBindRetirementActionLock */ select ${JOURNAL_COLUMNS} from execution_journal
         where idempotency_key=$1 and kind='retireLpPreBindV1' for update`, [idempotencyKey],
      );
      const raw = locked.rows[0];
      if (raw === undefined) throw new Error("Pre-bind retirement action journal row does not exist.");
      const current = rowToEntry(raw);
      if (current.state === "COMMITTED") {
        if (!samePreBindRetirementResult(current.externalRef, externalRef)) {
          throw new Error("Pre-bind retirement action result conflict.");
        }
        return current;
      }
      const updated = await tx.query<JournalRow>(
        `/* journal.preBindRetirementActionComplete */ update execution_journal set state='COMMITTED',
          external_ref=$2::jsonb,updated_at=$3 where idempotency_key=$1 and
          kind='retireLpPreBindV1' and state in ('PENDING','IN_PROGRESS') returning ${JOURNAL_COLUMNS}`,
        [idempotencyKey, encodeJsonbParam(mergeRef(current.externalRef, externalRef)),
          new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Pre-bind retirement action completion conflict.");
      return rowToEntry(row);
    });
  }


  async get(idempotencyKey: string): Promise<JournalEntry | null> {
    const result = await this.#sql.query<JournalRow>(
      `/* journal.get */
       select ${JOURNAL_COLUMNS}
       from execution_journal where idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToEntry(row);
  }

  async getByDecision(
    agentId: string,
    decisionId: string,
  ): Promise<JournalEntry | null> {
    const result = await this.#sql.query<JournalRow>(
      `/* journal.getByDecision */
       select ${JOURNAL_COLUMNS}
       from execution_journal
       where agent_id = $1 and decision_id = $2 and kind in ('execute', 'trade', 'lp', 'venusRepay', 'venusSupply', 'venusClaim', 'venusClaimRepayLeg', 'billingCollect', 'lending', 'quantTrade')
       order by created_at asc
       limit 1`,
      [agentId, decisionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToEntry(row);
  }

  async listUnknownForAgent(agentId: string): Promise<JournalEntry[]> {
    const result = await this.#sql.query<JournalRow>(
      `/* journal.listUnknownForAgent */
       select ${JOURNAL_COLUMNS}
       from execution_journal where agent_id = $1 and state = 'UNKNOWN'
       order by created_at asc`,
      [agentId],
    );
    return result.rows.map(rowToEntry);
  }

  async hasPendingForAgent(agentId: string, excludeIdempotencyKey?: string): Promise<boolean> {
    const result = await this.#sql.query<{ present: boolean }>(
      `/* journal.hasPendingForAgent */ select exists(
         select 1 from execution_journal where agent_id = $1 and state = 'PENDING'
           and ($2::text is null or idempotency_key <> $2)
       ) as present`,
      [agentId, excludeIdempotencyKey ?? null],
    );
    return result.rows[0]?.present === true;
  }

  async sumNativeSpendSince(
    agentId: string,
    sinceMs: number,
    excludeIdempotencyKey?: string,
  ): Promise<bigint> {
    return this.#sum(this.#sql, agentId, sinceMs, excludeIdempotencyKey);
  }

  async listNonTerminal(): Promise<JournalEntry[]> {
    const result = await this.#sql.query<JournalRow>(
      `/* journal.listNonTerminal */
       select ${JOURNAL_COLUMNS}
       from execution_journal where state in ('PENDING', 'IN_PROGRESS')
       order by created_at asc`,
    );
    return result.rows.map(rowToEntry);
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }

  #transition(
    idempotencyKey: string,
    target: JournalState,
    change: {
      externalRef?: JournalExternalRef | undefined;
      lastError?: string | undefined;
    },
    path: TransitionPath = "standard",
  ): Promise<JournalEntry> {
    return this.#sql.transaction(async (tx) => {
      const locked = await tx.query<JournalRow>(
        `/* journal.transitionSelect */
         select ${JOURNAL_COLUMNS}
         from execution_journal where idempotency_key = $1 for update`,
        [idempotencyKey],
      );
      const current = locked.rows[0];
      if (current === undefined) {
        throw new Error(`Journal row "${idempotencyKey}" does not exist.`);
      }
      const entry = rowToEntry(current);
      if (path === "resolve-unknown" || path === "advance-on-chain" || path === "retire-pre-bind") {
        assertResolvableUnknown(entry);
      }
      if (
        entry.kind === "billingCollect" &&
        (target === "COMMITTED" || target === "ROLLED_BACK")
      ) {
        throw new Error("billingCollect may become terminal only through canonical billing collection proof.");
      }
      assertTransition(entry.state, target, path);
      const nextRef = mergeRef(entry.externalRef, change.externalRef);
      const nextError =
        change.lastError === undefined
          ? entry.lastError
          : change.lastError.slice(0, MAX_ERROR_CHARS);
      const updated = await tx.query<JournalRow>(
        `/* journal.transitionUpdate */
         update execution_journal
         set state = $2, external_ref = $3::jsonb, last_error = $4, updated_at = $5
         where idempotency_key = $1
         returning ${JOURNAL_COLUMNS}`,
        [idempotencyKey, target, encodeJsonbParam(nextRef), nextError, new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("Journal transition failed to update the row.");
      }
      return rowToEntry(row);
    });
  }
}

/**
 * Read a `numeric(78, 0)` back as a bigint. `pg` hands numerics over as strings
 * precisely so nothing is lost to a double; parsing anything unexpected as `0n`
 * would UNDER-count spend, so a malformed value throws instead.
 */
function toWei(value: string | number | null): bigint {
  if (value === null) return 0n;
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error("Journal native_spend_wei is not an integer.");
  }
  return BigInt(text);
}

function assertLandingReservation(
  current: JournalEntry,
  resolutionId: string,
  resolutionKeyHash: Hex,
  target: "COMMITTED" | "ROLLED_BACK",
): void {
  if (current.state !== target || current.landingResolutionId !== resolutionId ||
      current.landingResolutionKeyHash !== resolutionKeyHash) {
    throw new Error("Landing resolution journal reservation conflict.");
  }
}

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

/** Keep the memory and Postgres contracts identical before a query is issued. */
function normalizeBegunAtBlock(value: unknown): bigint | null {
  if (value === undefined) return null;
  if (typeof value !== "bigint") {
    throw new Error("Journal begunAtBlock must be a bigint.");
  }

  if (value < 0n || value > MAX_POSTGRES_BIGINT) {
    throw new Error("Journal begunAtBlock must fit a non-negative PostgreSQL bigint.");
  }
  return value;
}

function toBegunAtBlock(value: string | number | bigint | null): bigint | null {
  if (value === null) return null;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Journal begun_at_block number is not a safe non-negative integer.");
  }
  const text = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error("Journal begun_at_block is not a non-negative integer.");
  }
  const block = BigInt(text);
  if (block > MAX_POSTGRES_BIGINT) {
    throw new Error("Journal begun_at_block exceeds PostgreSQL bigint.");
  }
  return block;
}

function rowToEntry(row: JournalRow): JournalEntry {
  const externalRef =
    row.external_ref === null
      ? {}
      : (decodeJsonb(row.external_ref) as JournalExternalRef);
  const entry: JournalEntry = {
    idempotencyKey: row.idempotency_key,
    agentId: row.agent_id,
    ownerAddress: row.owner_address,
    kind: row.kind as JournalKind,
    ...(externalRef.billingPrincipal === undefined ? {} : { principal: externalRef.billingPrincipal }),
    decisionId: row.decision_id ?? null,
    state: row.state as JournalState,
    externalRef,
    nativeSpendWei: toWei(row.native_spend_wei),
    begunAtBlock: toBegunAtBlock(row.begun_at_block),
    finalCallsFingerprint: row.final_calls_fingerprint,
    finalCallsFingerprintHash: row.final_calls_fingerprint_hash,
    preparedIntentIdentity: row.prepared_intent_identity,
    preparedIntentIdentityHash: row.prepared_intent_identity_hash,
    preparedBindingVersion: toNonNegativeSafeInteger(
      row.prepared_binding_version,
      "prepared_binding_version",
    ),
    billingCallsIdVersion: toNonNegativeSafeInteger(
      row.billing_calls_id_version,
      "billing_calls_id_version",
    ),
    landingResolutionId: row.landing_resolution_id,
    landingResolutionKeyHash: row.landing_resolution_key_hash,
    landingResolutionOutcome: row.landing_resolution_outcome,
    landingResolutionEvidenceHash: row.landing_resolution_evidence_hash,
    landingResolutionTerminalAt: row.landing_resolution_terminal_at?.getTime() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
  assertRetirementExternalRef(entry.kind, entry.state, entry.externalRef);
  return entry;
}

function toNonNegativeSafeInteger(
  value: string | number | bigint,
  field: string,
): number {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Journal ${field} is outside the safe integer range.`);
  }
  return Number(parsed);
}

/* -------------------------------------------------------------------------- */
/* Reconcile                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Inputs to the startup reconcile pass.
 *
 * `resolveWallet` is required because verifying a grant/revoke needs the wallet
 * ref (chain id + address) that isSessionActive takes, and that lives in the
 * agent store, not in a journal row. Execute rows are resolved from `callsId`
 * alone and never touch it.
 */
export type ReconcileInput = {
  readonly provider: WalletProvider;
  readonly journal: ExecutionJournal;
  readonly resolveWallet: (
    ownerAddress: string,
    agentId: string,
  ) => Promise<AgentWalletRef | null>;
  /**
   * Rows whose `updatedAt` is newer than this many ms are SKIPPED — not read,
   * not resolved, not written (PHASE3.7 F1).
   *
   * ABSENT MEANS {@link RECONCILE_MIN_ROW_AGE_MS}, and that default is the whole
   * fix (PHASE3.7 Rev2 F1.1). Defaulting to zero and passing the guard at each
   * call site would keep every existing test green while reintroducing the
   * defect verbatim, so the protection has to live where a caller cannot forget
   * it. Pass `0` explicitly to opt out — tests do; production never should.
   */
  readonly minRowAgeMs?: number;
  /**
   * The clock the age guard reads. Defaults to `Date.now`.
   *
   * It MUST be the same clock the journal stamps rows with, or the comparison
   * is meaningless: the guard subtracts from this clock and compares against a
   * row `updatedAt` the store wrote. A fixture journal on an injected clock and
   * a guard on the wall clock disagree by whatever the two differ by, which for
   * the suites here is four years.
   *
   * Both journal backends stamp `updatedAt` from their OWN injected clock —
   * Postgres included, which writes the value rather than using the column's
   * `default now()` — so in production both sides of the comparison are the
   * app clock and a database clock skew cannot reach this.
   */
  readonly now?: () => number;
};

/**
 * How long a non-terminal row must have been UNTOUCHED before a reconcile pass
 * is allowed to form an opinion about it.
 *
 * DERIVED, not chosen (PHASE3.7 Rev2 F1.2): two full submit windows plus
 * margin. A step may write on both sides of the relay timeout, so one window is
 * not enough.
 *
 * The submit window is restated here rather than imported: this module is the
 * storage substrate and must not depend on a wallet implementation. Two things
 * keep the restatement honest, and neither is sufficient alone (FIXREVIEW N8,
 * which caught the comment here overstating the first):
 *
 *   - an OFFLINE equality test pins this constant against the provider's
 *     `DEFAULT_SUBMIT_TIMEOUT_MS`, catching drift in the default;
 *   - {@link assertReconcileGuardCoversSubmitWindow} reads the provider's
 *     EFFECTIVE timeout at BOOT in both processes, catching a per-registry
 *     override the offline test cannot see.
 *
 * It is a HEURISTIC and not a proof, exactly as `resolveUnknown.ts` says of its
 * own age guard. A pre-submit leg slower than this still reproduces FINDINGS
 * (ap-1); the guard narrows the window, it does not close it.
 */
export const RECONCILE_ASSUMED_SUBMIT_TIMEOUT_MS = 45_000;

export const RECONCILE_MIN_ROW_AGE_MS =
  2 * RECONCILE_ASSUMED_SUBMIT_TIMEOUT_MS + 30_000;

/**
 * Refuse to start when the relay's EFFECTIVE submit timeout has grown past what
 * {@link RECONCILE_MIN_ROW_AGE_MS} covers (PHASE3.7-AUDIT A5, FIXREVIEW N7/N8).
 *
 * FAIL-CLOSED, and the first version was not: it read the field through a cast
 * with a `?? DEFAULT` fallback, so a provider exposing `undefined` — or anything
 * non-numeric — booted clean on an assumption rather than a reading. A boot
 * check that cannot read its input must say so, not guess.
 *
 * Lives here, and is called from BOTH `src/index-server.ts` and
 * `scripts/lp-worker.ts`: the LP worker builds its own provider and reconciles
 * every cycle, so covering only the server left the process that actually
 * reproduced FINDINGS (ap-1) unchecked.
 */
export function assertReconcileGuardCoversSubmitWindow(
  provider: unknown,
  minRowAgeMs: number = RECONCILE_MIN_ROW_AGE_MS,
): void {
  const effective = (provider as { readonly submitTimeoutMs?: unknown })
    .submitTimeoutMs;
  if (typeof effective !== "number" || !Number.isFinite(effective)) {
    throw new Error(
      "Boot refused: the wallet provider does not report a numeric " +
        "submitTimeoutMs, so the reconcile age guard cannot be shown to cover a " +
        "submit window. See PHASE3.7 F1 / FINDINGS (ap-1).",
    );
  }
  if (effective * 2 >= minRowAgeMs) {
    throw new Error(
      `Boot refused: this chain's relay submit timeout (${effective}ms) has grown ` +
        `past half of the reconcile age guard (${minRowAgeMs}ms). The guard would ` +
        `no longer cover a submit window, so a live submission could again be ` +
        `marked UNKNOWN under its own writer (FINDINGS ap-1). Lower the provider's ` +
        `submitTimeoutMs, or raise RECONCILE_MIN_ROW_AGE_MS to at least ` +
        `${effective * 2 + 30_000}ms — note that the constant is pinned by ` +
        `test/reconcileAgeGuard.test.ts, which must be updated with it.`,
    );
  }
}

export type ReconcileSummary = {
  readonly committed: number;
  readonly rolledBack: number;
  /** Rows parked as UNKNOWN — held for an operator, never auto-replayed. */
  readonly held: readonly string[];
  /**
   * Rows left alone because they were younger than the age guard.
   *
   * REPORTED rather than silent, for the reason `previousObservationDiscarded`
   * exists (PHASE3.6 FIXREVIEW N3/P3): a pass that quietly declines to look at
   * rows is indistinguishable from a pass that found nothing.
   */
  readonly skippedYoung: number;
};

/**
 * Resolve every non-terminal row against authoritative state.
 *
 * Poll-only: `awaitExecution` and `isSessionActive` read, they never submit, so
 * a crash mid-execute is resolved rather than re-run. Any answer short of a
 * definite outcome — a still-pending execute, a grant not yet observed active, a
 * missing external reference, or a thrown error — parks the row as UNKNOWN.
 */
export async function reconcile(
  input: ReconcileInput,
): Promise<ReconcileSummary> {
  const rows = await input.journal.listNonTerminal();
  let committed = 0;
  let rolledBack = 0;
  let skippedYoung = 0;
  const held: string[] = [];

  // PHASE3.7 F1. The measured defect (FINDINGS ap-1): this pass read a row that
  // another process was still writing, saw no `callsId` — which a mid-submit row
  // legitimately does not have yet — and marked it UNKNOWN. The open's own
  // `markInProgress` then hit UNKNOWN -> IN_PROGRESS and 500'd, while the mint
  // it described LANDED. The guard that exists to protect the money is what
  // destroyed the record of it.
  //
  // `updatedAt`, not `createdAt`: it moves whenever a row makes progress, so it
  // measures time since the last sign of life rather than time since birth,
  // which is the quantity a staleness guard actually wants.
  const minRowAgeMs = input.minRowAgeMs ?? RECONCILE_MIN_ROW_AGE_MS;
  // AUDIT A9: `NaN`, `-1` and `Infinity` all used to sail through and either
  // disable the guard or freeze it on. A guard that can be switched off by a
  // malformed number is not a guard.
  if (!Number.isFinite(minRowAgeMs) || minRowAgeMs < 0) {
    throw new Error(
      `reconcile: minRowAgeMs must be a finite, non-negative number (got ${String(
        input.minRowAgeMs,
      )}). Pass 0 to disable the age guard deliberately.`,
    );
  }
  // A NON-POSITIVE value DISABLES the guard rather than setting a zero
  // threshold, and the difference is not cosmetic: a zero threshold still
  // compares two clocks, so a caller whose rows are stamped from a different
  // source than `now` would skip everything while believing it opted out. Only
  // tests pass this.
  const guardActive = minRowAgeMs > 0;
  const youngerThan = (input.now?.() ?? Date.now()) - minRowAgeMs;

  for (const row of rows) {
    // The custom pre-bind retirement action uses PENDING as a durable
    // re-entry marker while it owns a worker-excluding sequence lease. Generic
    // local-only settlement would sever that protocol after a crash.
    if (row.kind === "retireLpPreBindV1") {
      held.push(row.idempotencyKey);
      continue;
    }
    if (guardActive && row.updatedAt > youngerThan) {
      skippedYoung += 1;
      continue;
    }
    try {
      const outcome = await resolveRow(input, row);
      if (outcome.state === "COMMITTED") {
        await input.journal.markCommitted(row.idempotencyKey, outcome.externalRef);
        committed += 1;
      } else if (outcome.state === "ROLLED_BACK") {
        await input.journal.markRolledBack(row.idempotencyKey, outcome.reason);
        rolledBack += 1;
      } else {
        await input.journal.markUnknown(row.idempotencyKey, outcome.reason);
        held.push(row.idempotencyKey);
      }
    } catch (error) {
      // A reconcile that throws mid-pass must not strand the remaining rows,
      // and an error here is itself ambiguous: hold, never guess.
      await input.journal.markUnknown(
        row.idempotencyKey,
        sanitizeMessage(error instanceof Error ? error.message : "reconcile error"),
      );
      held.push(row.idempotencyKey);
    }
  }

  return { committed, rolledBack, held, skippedYoung };
}

type RowOutcome =
  | { readonly state: "COMMITTED"; readonly externalRef?: JournalExternalRef }
  | { readonly state: "ROLLED_BACK"; readonly reason: string }
  | { readonly state: "UNKNOWN"; readonly reason: string };

/**
 * Resolve one row against authoritative state.
 *
 * The dispatch is EXHAUSTIVE and every branch is named. It used to end with an
 * unguarded fallthrough into the grant/revoke logic, which meant a crashed
 * `trade` row — a kind that did not exist when the fallthrough was written —
 * would have been resolved by asking whether the SESSION was active. It always
 * is, so the row would have been marked COMMITTED without the trade ever having
 * landed: a false success with money attached. An unrecognized kind now parks as
 * UNKNOWN and is held for an operator. A fallthrough must never produce
 * COMMITTED.
 */
async function resolveRow(
  input: ReconcileInput,
  row: JournalEntry,
): Promise<RowOutcome> {
  const kind = row.kind;

  if (LOCAL_ONLY_KINDS.has(kind)) {
    // No chain to consult and no funds at risk. Closing the row out keeps the
    // held list about money; the kill switch and agent row already hold the
    // truth, and re-signing the action is free.
    return {
      state: "ROLLED_BACK",
      reason: "Local-only owner action was interrupted; re-sign to be certain.",
    };
  }

  if (
    kind === "execute"
    || kind === "trade"
    || kind === "lp"
    || kind === "venusRepay"
    || kind === "venusSupply"
    || kind === "venusClaim"
    || kind === "venusClaimRepayLeg"
    // MARKETPLACE-LENDING-AGENT R2.1. The sixth hand-maintained site. A
    // `lending` row is one relay submission with a `callsId`, so it resolves
    // exactly as `lp` and the Venus kinds do — and WITHOUT this branch a
    // crashed lending arm, rescue or retire would fall through to the
    // unrecognized-kind branch below and park as a PERMANENT UNKNOWN, because
    // v1 ships no owner-signed resolver for this kind either.
    || kind === "lending"
    // QUANT-GRID R2.7. The fifth hand-maintained site. A `quantTrade` row is
    // one relay submission with a `callsId`, so it resolves exactly as `lp`,
    // the Venus kinds and `lending` do — and WITHOUT this branch a crashed
    // quant buy or sell would fall through to the unrecognized-kind branch and
    // park as a PERMANENT UNKNOWN. `src/quant/reconcile.ts` is what resolves a
    // quant UNKNOWN with evidence; generic reconcile is what stops one from
    // being manufactured by a restart in the first place.
    //
    // DEPLOYMENT ORDER RULE (R2.7): every service that calls `reconcile` —
    // `execution-api`, `trade-worker`, `lp-worker`, `lending-worker`,
    // `dev-stack` — must be running the commit that knows this kind BEFORE
    // `QUANT_ENABLED=true` is set anywhere. Railway builds all services from
    // one commit; the runbook makes "all services healthy on the new commit"
    // the precondition of enablement.
    || kind === "quantTrade"
  ) {
    // An `lp` row is one saga step submitted through the same relay, so it
    // resolves identically: only its callsId — never a live session, never the
    // sequence store — can say whether the step landed.
    //
    // The four Venus money kinds are the same shape (PHASE4 R2.5): the worker
    // submits through `executeViaSession` and records a `callsId`, so reconcile
    // can ask the relay. WITHOUT this branch a crashed Venus repay would fall
    // through to the unrecognized-kind branch below and park as a PERMANENT
    // UNKNOWN — which for Venus really is permanent, because v1 ships no
    // resolver for these kinds at all: `resolveUnknown` verifies `lp` rows only
    // (`:1855`) and the 3.9c landing path is gated to `kind = 'lp'` in the
    // schema CHECK itself. An UNKNOWN Venus row is HELD, surfaced on the owner
    // view with its `callsId`, and degrades the guard (R3.7's `unknown-held`)
    // until an owner-signed `venusResolveUnknown` phase ships.
    const callsId = row.externalRef.callsId;
    if (callsId === undefined) {
      return {
        state: "UNKNOWN",
        reason: "No callsId recorded; the submit window is ambiguous.",
      };
    }
    const receipt: ExecutionReceipt = await input.provider.awaitExecution({
      callsId,
    });
    if (receipt.status === "CONFIRMED") {
      return {
        state: "COMMITTED",
        ...(receipt.transactionHash === undefined
          ? {}
          : { externalRef: { txHash: receipt.transactionHash } }),
      };
    }
    if (receipt.status === "FAILED") {
      return {
        state: "ROLLED_BACK",
        reason: receipt.failureCode ?? "Execution reported FAILED.",
      };
    }
    return { state: "UNKNOWN", reason: "Execution still pending after await." };
  }

  if (kind === "grant" || kind === "revoke") {
    const publicKey = row.externalRef.publicKey;
    const wallet =
      publicKey === undefined
        ? null
        : await input.resolveWallet(row.ownerAddress, row.agentId);
    if (publicKey === undefined || wallet === null) {
      return {
        state: "UNKNOWN",
        reason: "No session key or wallet to verify the session against.",
      };
    }
    const active = await input.provider.isSessionActive({ wallet, publicKey });
    if (kind === "grant") {
      return active
        ? { state: "COMMITTED" }
        : { state: "UNKNOWN", reason: "Grant not observed active on-chain." };
    }
    return active
      ? { state: "UNKNOWN", reason: "Session still active after revoke." }
      : { state: "COMMITTED" };
  }

  // A kind this build does not recognize — a row written by a newer version, or
  // a corrupted one. There is no safe guess, so it is held.
  return {
    state: "UNKNOWN",
    reason: "Unrecognized journal kind; held for an operator.",
  };
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick the durable journal when `DATABASE_URL` is set, otherwise the in-memory
 * one. The connection string is never logged.
 */
export async function createJournal(): Promise<ExecutionJournal> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const journal = await PostgresExecutionJournal.create(sql);
    console.log("[execution-journal] backend=postgres");
    return journal;
  }
  console.log("[execution-journal] backend=memory (DATABASE_URL not set)");
  return new MemoryExecutionJournal();
}
