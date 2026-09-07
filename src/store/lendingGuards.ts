/**
 * The lending guard's durable substrate (MARKETPLACE-LENDING-AGENT §8.1 as
 * amended by R3.3, R3.4, R3.7, L2, and REVIEW2 §4's status-reachability
 * obligation).
 *
 * FIVE tables live here and each carries a different guarantee:
 *
 *   `lending_guards`    the AUTHORITY on what an agent's guard is doing. Every
 *                       transition is a CAS on `(owner, id, status, row_version)`,
 *                       `guarded_account` is IMMUTABLE once written, and the
 *                       row is materialized at CONVERGENCE in
 *                       `provisioning-guard` from `PendingGrant.initialLendingHire`
 *                       — never by a second statement at S1 that a crash could
 *                       tear away from the agent row (R3.3, REVIEW2 H3(c)).
 *   `lending_settings`  the owner-signed bytes plus their digest. The Venus
 *                       settings class, parameterized by table name.
 *   `lending_observations` the durable hysteresis counter. The Venus
 *                       observation class, parameterized by table name.
 *   `lending_actions`   the charged-row ledger. Telemetry PLUS the 24 h
 *                       `rescuesChargedInWindow` count the count-aware wallet
 *                       floor narrows on (R2.8).
 *   `lending_rescues`   per-rescue telemetry the owner view renders.
 *   `lending_snapshots` the view payload, written LAST in every cycle and
 *                       swallowed on failure (OQ8): a presentation write must
 *                       never abort a cycle that has already submitted money.
 *
 * ─── THE CLAIM IS THE COOLDOWN AND THE SEQUENCE NUMBER (R3.7) ──────────────
 *
 * {@link LendingGuardStore.claimAction} is ONE conditional UPDATE that both
 * enforces `minSecondsBetweenActions` and returns the next `action_seq`. It
 * replaces Revision 2's `(agent_id, window_start)` bucket insert, which was not
 * a minimum gap at all: with a 300 s floor, actions at t=299 s and t=301 s fall
 * in different buckets and BOTH claim, giving a two-second gap under a
 * five-minute floor. It also gives the decision id its `n`, so a crashed
 * submission can never reuse one — a reused `n` is refused by `getByDecision`
 * as a replay, silently (L11).
 *
 * ─── THE FENCE IS RELEASED BEFORE THE SUBMIT (R3.7) ────────────────────────
 *
 * {@link LendingGuardStore.withLendingFence} covers READ → DECIDE → CLAIM and
 * nothing else. Holding a PostgreSQL transaction across a relay submission
 * would pin a pool connection for tens of seconds AND — worse — the journal
 * writes inside that window go through a DIFFERENT connection, so a fence
 * transaction that later aborted would leave the journal row and the on-chain
 * submission standing while the claim did not. `lpArm` closes its fence and
 * then calls `runLpOpen`; this does the same.
 *
 * Its advisory lock uses the TWO-ARGUMENT `pg_advisory_xact_lock(classid,
 * objid)` form with a lending-specific classid (L7), so it cannot alias the LP
 * fence's single-argument `hashtext($1)` space.
 */
import { getAddress, type Address, type Hex } from "viem";

import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import {
  LENDING_GUARD_STATUSES,
  type LendingCloseReason,
  type LendingGuardStatus,
  type LendingHold,
  type LendingRescueEffect,
  type LendingRescueRecord,
} from "../lending/types.js";
import type { LendingCondition } from "../lending/types.js";

/** Injectable clock; defaults to `Date.now`. */
export type Clock = () => number;

/**
 * Where an `armBlock` came from (FIXREVIEW F7).
 *
 * `"receipt"` — the block the arm's transaction landed in, read back from the
 * relay-answered hash. `"post-arm-read"` — the finalized block of a read taken
 * after the arm, which is normally BEHIND it. Only the null/non-null
 * distinction is consumed today (`detectOwnerRecovery`), so this exists to stop
 * the NEXT reader from treating the weaker figure as the stronger one.
 */
export type LendingArmBlockSource = "receipt" | "post-arm-read";

/**
 * Consecutive qualifying cycles a hold clear needs before it fires
 * (FIXREVIEW F5).
 *
 * TWO, the same number every other durable confirmation in this plane takes,
 * and the worker additionally requires one interval between them — so two
 * `--once` runs back to back cannot manufacture a clear, which is the
 * PHASE3.2 lesson in this enum.
 */
export const LENDING_HOLD_CLEAR_CONFIRMATIONS = 2;

/**
 * The advisory-lock CLASS this store owns (L7).
 *
 * `pg_advisory_xact_lock(hashtext($1))` is a SINGLE 32-bit space shared with
 * the LP arm fence (`src/store/lpSequences.ts`), so two different keys that
 * happen to collide there would serialize an LP arm against a lending cycle for
 * no reason — and, worse, would make either fence's exclusivity a property of
 * a hash rather than of a design. The two-argument form gives this store its
 * own class.
 */
export const LENDING_LOCK_CLASSID = 0x4c454e44; // "LEND"

/** 24 hours, the rolling window every action count is taken over. */
export const LENDING_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

/* -------------------------------------------------------------------------- */
/* The guard row                                                              */
/* -------------------------------------------------------------------------- */

export type LendingGuardRecord = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  /** A — IMMUTABLE once written. The store refuses any change. */
  readonly guardedAccount: Address;
  /** USDT, pinned at hire. */
  readonly reserveToken: Address;
  readonly debtMarkets: readonly Address[];
  readonly status: LendingGuardStatus;
  readonly hold: LendingHold | null;
  /** The USDT rolling-day cap the session was granted. */
  readonly reserveCapWei: bigint;
  readonly reserveBps: number;
  /** Zero until the arm is admitted. */
  readonly budgetWei: bigint;
  readonly supplyNativeWei: bigint;
  readonly reserveNativeWei: bigint;
  readonly mintUsdtWei: bigint;
  /** R2.18's arm delta and R2.21's `arm-unknown` evidence rule both need these. */
  readonly preArmVUsdtWei: bigint;
  readonly preArmExchangeRate: bigint;
  readonly armJournalKey: string | null;
  readonly armBlock: bigint | null;
  /**
   * WHICH block `armBlock` is — FIXREVIEW F7.
   *
   * `"receipt"` is the block the arm's own transaction landed in, read back
   * from its hash. `"post-arm-read"` is the FINALIZED block of a read taken
   * AFTER the arm, which is normally BEHIND the arm's own block: it proves the
   * arm was observed, not when it landed. The two were indistinguishable on the
   * record while the field name promised the stronger one, so anything that
   * ever compares `armBlock` to a chain height would have compared the wrong
   * thing. `null` exactly when `armBlock` is null.
   */
  readonly armBlockSource: LendingArmBlockSource | null;
  readonly armTxHash: Hex | null;
  /**
   * Consecutive worker cycles that have SEEN the reason for the current hold
   * disappear — FIXREVIEW F5, and the durable twin of the trigger's own
   * `protectConsecutive`.
   *
   * A hold used to be cleared the first cycle its condition stopped applying,
   * so an account hovering at `LENDING_MAX_MARKETS` (24/25) wrote a status
   * change EVERY cycle and flickered `held`/`armed` on the owner's page. It is
   * a COUNTER rather than a timestamp for the reason every other confirmation
   * in this plane is: a per-process count resets on restart, and a restart is
   * exactly when a flapping guard is most likely to be observed once.
   *
   * Reset to 0 by every statement that writes a hold or re-arms the row, so it
   * can never carry evidence from a previous hold into the next one.
   */
  readonly holdClearConsecutive: number;
  /** R3.7: the claim's own stamp, and the cooldown's authority. */
  readonly lastActionAtMs: number | null;
  readonly actionSeq: number;
  readonly closeReason: LendingCloseReason | null;
  readonly rowVersion: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type CreateLendingGuardInput = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly guardedAccount: Address;
  readonly reserveToken: Address;
  readonly debtMarkets: readonly Address[];
  readonly reserveCapWei: bigint;
  readonly reserveBps: number;
};

export type LendingGuardInitialResult =
  | { readonly kind: "created"; readonly record: LendingGuardRecord }
  | { readonly kind: "same"; readonly record: LendingGuardRecord }
  | { readonly kind: "conflict" };

/** Everything an admitted arm writes onto the row under one CAS. */
export type ArmLendingGuardInput = {
  readonly ownerAddress: Address;
  readonly agentId: string;
  readonly expectedRowVersion: number;
  readonly budgetWei: bigint;
  readonly reserveBps: number;
  readonly supplyNativeWei: bigint;
  readonly reserveNativeWei: bigint;
  readonly mintUsdtWei: bigint;
  readonly preArmVUsdtWei: bigint;
  readonly preArmExchangeRate: bigint;
  readonly armJournalKey: string;
};

export type FinishArmInput = {
  readonly ownerAddress: Address;
  readonly agentId: string;
  readonly expectedRowVersion: number;
} & (
  | {
      readonly outcome: "armed";
      readonly armBlock: bigint | null;
      /** FIXREVIEW F7 — required with a block, ignored without one. */
      readonly armBlockSource?: LendingArmBlockSource;
      readonly armTxHash: Hex | null;
    }
  | { readonly outcome: "held"; readonly hold: LendingHold }
  | { readonly outcome: "closed"; readonly closeReason: LendingCloseReason }
);

export type LendingGuardCasResult =
  | { readonly kind: "ok"; readonly record: LendingGuardRecord }
  | { readonly kind: "conflict"; readonly record: LendingGuardRecord | null };

export type ClaimLendingActionInput = {
  readonly ownerAddress: Address;
  readonly agentId: string;
  /** The FROZEN cycle clock. */
  readonly nowMs: number;
  readonly minSecondsBetweenActions: number;
};

export type ClaimLendingActionResult =
  | { readonly kind: "claimed"; readonly actionSeq: number }
  | { readonly kind: "cooldown"; readonly elapsedSec: number }
  | { readonly kind: "not_found" };

/**
 * The work a fence may do, ALL of it on the lock's own transaction
 * (AUDIT B-L9, completed by FIXREVIEW F6).
 *
 * ═══ WHAT IS AND IS NOT ROLLED BACK BY AN ABORTING FENCE ═════════════════
 *
 * Every method here runs on the transaction that holds `pg_advisory_xact_lock`,
 * so a fence body that throws takes ALL of them with it. B-L9 fixed `get` and
 * `claim`; F6 found `armCas` and `beginRetire` still running on the POOL — an
 * aborting fence left the admission standing while its claim rolled back, which
 * is the same class of split B-L9 named, and each open fence was also checking
 * out a second pool connection while holding its own (`createPgSqlClient`
 * passes only a connection string, so `pg`'s default `max` of 10 applies).
 *
 * ONE write inside the arm's fence is still NOT on this transaction and cannot
 * be: `lending.settingsStore.put`. The settings store is a DIFFERENT store
 * class over its own `SqlClient`, with no `tx`-aware method and no way to join
 * a transaction this store owns. The arm therefore runs it AFTER `armCas` has
 * succeeded, so the case P12 left open — a losing CAS with the digest already
 * moved — cannot happen; what remains is an aborting fence leaving a settings
 * row whose bytes the owner signed and which P19 already accepts as
 * admissible. That residue is named here rather than implied.
 */
export type LendingGuardFence = {
  /** The guard row, read INSIDE the fence. */
  get(): Promise<LendingGuardRecord | null>;
  /** The R3.7 claim, executed inside the fence and released before the submit. */
  claim(input: Omit<ClaimLendingActionInput, "ownerAddress" | "agentId">): Promise<ClaimLendingActionResult>;
  /** The arm's admission CAS, on the LOCK'S transaction (FIXREVIEW F6). */
  armCas(
    input: Omit<ArmLendingGuardInput, "ownerAddress" | "agentId">,
  ): Promise<LendingGuardCasResult>;
  /** The retire's admission CAS, on the LOCK'S transaction (FIXREVIEW F6). */
  beginRetire(input: {
    readonly expectedRowVersion: number;
  }): Promise<LendingGuardCasResult>;
};

export type LendingSnapshotRecord = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly blockNumber: bigint;
  readonly observedAtMs: number;
  readonly snapshot: unknown;
};

export type LendingActionUsage = {
  readonly rescues: number;
  readonly lastRescueAtMs: number | null;
};

export interface LendingGuardStore {
  /** Materialize the pre-arm row at convergence. Idempotent-if-identical. */
  putInitialIfAbsentOrSame(
    input: CreateLendingGuardInput,
  ): Promise<LendingGuardInitialResult>;
  get(ownerAddress: Address, agentId: string): Promise<LendingGuardRecord | null>;
  /**
   * Every row the worker must look at: `arming | armed | held | retiring`.
   *
   * `arming` IS included — that is R3.4's door. Without it a crash between the
   * fence commit and `journal.begin` leaves a row nothing converges, which is
   * the PHASE3.11 / PHASE3.14 wedge in a new enum.
   *
   * `retiring` IS included (AUDIT B-H1/P2): a partial retire parks there, and
   * before this the worker skipped it, so its view snapshot froze and the only
   * exit was another owner signature. The worker now keeps its snapshot fresh
   * and converges an emptied reserve to `retired` — a real EXIT owned by a
   * named surface. It NEVER plans a rescue for a retiring row.
   */
  listForWorker(): Promise<readonly LendingGuardRecord[]>;
  /** `provisioning-guard | closed` -> `arming`, under CAS. */
  armCas(input: ArmLendingGuardInput): Promise<LendingGuardCasResult>;
  /** `arming` -> `armed | held | closed`, under CAS. */
  finishArm(input: FinishArmInput): Promise<LendingGuardCasResult>;
  /**
   * Set or clear the hold on an `armed`/`held` row, under CAS.
   *
   * FIXREVIEW F1 — `armBlock` IS WRITABLE HERE, and only upwards from `null`.
   *
   * `armBlock` used to have ONE writer (`finishArm` with `outcome: "armed"`),
   * so a guard that reached `armed` through the P15 hold clear — the
   * `arm-unknown` row whose reserve later PROVED the arm landed — was armed
   * with `armBlock === null` forever, and `detectOwnerRecovery` refuses on
   * exactly that. §6.2's passkey-recovery observation was therefore
   * unreachable for the population C-M2 was about.
   *
   * The write is one-way: an `armBlock` that is already set is NEVER
   * overwritten (the block that proved the arm landed is the older, better
   * answer), and omitting the field leaves the column exactly as it was.
   */
  setHold(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly hold: LendingHold | null;
    /** Recorded only when the row still has none. */
    readonly armBlock?: bigint;
    /** FIXREVIEW F7 — travels with `armBlock` and is written the same one way. */
    readonly armBlockSource?: LendingArmBlockSource;
  }): Promise<LendingGuardCasResult>;
  /**
   * Record how many consecutive cycles have seen the hold's reason gone
   * (FIXREVIEW F5), WITHOUT clearing it.
   *
   * It writes one column on a `held` row and nothing else, so a guard that is
   * halfway to a clear is still, in every other respect, held: the view says
   * held, the fence admits it, rescues continue. `setHold` is what actually
   * clears, and it resets this counter in the same statement.
   */
  noteHoldClearProgress(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly consecutive: number;
  }): Promise<LendingGuardCasResult>;
  /** `armed | held` -> `retiring`, under CAS. */
  beginRetire(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
  }): Promise<LendingGuardCasResult>;
  /**
   * `retiring` -> `retired | armed | held | retiring`, under CAS.
   *
   * `rolled-back` is the AUDIT B-H1 outcome: a retire that was refused before
   * the submit, or whose relay answered FAILED, spent NOTHING, so parking the
   * guard at `retiring` would strand it in a status the retire gate, the
   * settings route and the worker all refused. It RESTORES the pre-retire
   * status (`armed | held` plus its hold) instead.
   */
  finishRetire(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly outcome: "retired" | "partial" | "held" | "rolled-back";
    readonly hold?: LendingHold;
    /** Required for `rolled-back`: the status (and hold) to restore. */
    readonly restore?: {
      readonly status: "armed" | "held";
      readonly hold: LendingHold | null;
    };
  }): Promise<LendingGuardCasResult>;
  /** Any non-terminal status -> `closed`, under CAS. */
  close(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly closeReason: LendingCloseReason;
  }): Promise<LendingGuardCasResult>;
  /** The R3.7 conditional claim. Rowcount 1 required; returns `action_seq`. */
  claimAction(input: ClaimLendingActionInput): Promise<ClaimLendingActionResult>;
  /**
   * Give a claim back when the cycle SUBMITTED NOTHING (AUDIT C-H1).
   *
   * The claim is taken inside the fence, above the submit, so a preflight
   * refusal or a transport throw between the claim and the relay left the
   * cooldown stamp standing and starved the next — real — rescue for
   * `minSecondsBetweenActions`, in exactly the crash this guard exists for.
   *
   * It is a CONDITIONAL CAS on `action_seq`: the restore lands only while the
   * sequence number is still the one this cycle claimed, so a concurrent
   * successful claim is NEVER undone. `action_seq` itself is not rewound — it
   * is a monotonic decision-id input and reusing one is a replay.
   */
  restoreClaim(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    /** The `action_seq` the claim returned. The CAS predicate. */
    readonly expectedActionSeq: number;
    /** The stamp to put back; `null` restores "never acted". */
    readonly previousLastActionAtMs: number | null;
  }): Promise<{ readonly kind: "restored" | "superseded" }>;
  /**
   * Serialize READ -> DECIDE -> CLAIM for one owner+agent. RELEASED before any
   * submit; the same key covers the worker cycle, the arm and the retire.
   */
  withLendingFence<T>(
    ownerAddress: Address,
    agentId: string,
    work: (fence: LendingGuardFence) => Promise<T>,
  ): Promise<T>;

  /* ----- telemetry ----- */
  recordRescue(input: Omit<LendingRescueRecord, "createdAtMs">): Promise<void>;
  listRescues(
    ownerAddress: Address,
    agentId: string,
    limit: number,
  ): Promise<readonly LendingRescueRecord[]>;
  /** Charge one action row. NEVER refuses — rescues are counted, not gated. */
  chargeAction(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly actionId: string;
    readonly kind: "rescue" | "arm" | "retire";
    readonly chargedAtMs: number;
  }): Promise<void>;
  usageSince(
    ownerAddress: Address,
    agentId: string,
    sinceMs: number,
  ): Promise<LendingActionUsage>;
  /**
   * The most recently charged action id of one kind, or `null`.
   *
   * FIXREVIEW F3 needs the RETIRE's journal key and the guard row does not
   * carry one: the retire's decision id is derived from the row version its own
   * `beginRetire` CAS produced, and every later write moves that number. The
   * charged-row ledger already records it verbatim — `chargeAction` is called
   * with `actionId` = the journal key — so this reads the key back instead of
   * adding a column that would have to be filled by a second write after the
   * CAS that names it.
   *
   * A retire is refused while `retire-unknown` stands, so the latest `retire`
   * row IS the ambiguous one for as long as the hold exists.
   */
  lastActionId(
    ownerAddress: Address,
    agentId: string,
    kind: "rescue" | "arm" | "retire",
  ): Promise<string | null>;

  /* ----- the view snapshot ----- */
  putSnapshot(input: LendingSnapshotRecord): Promise<void>;
  getSnapshot(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LendingSnapshotRecord | null>;

  close_(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Transition table — the 3.14 invariant, in one place                        */
/* -------------------------------------------------------------------------- */

/**
 * Every status transition any path may write, as DATA.
 *
 * REVIEW2 C28 requires a table-driven test proving every status the enum
 * carries is reachable by at least one of {worker cycle, arm, retire, an
 * owner-signed door} — and the test must enumerate the enum rather than a
 * hand-written list. Exporting the table is what lets it do that without
 * asserting against a copy of itself: the test reads
 * {@link LENDING_GUARD_STATUSES} and checks each member appears as a
 * destination here AND that each destination has a named surface.
 *
 * AUDIT B-H1 added the OTHER half of that obligation, which is the half the
 * PHASE3.11 and PHASE3.14 wedges were actually made of: every NON-TERMINAL
 * status must also be a SOURCE — an accepted state with an exit some named
 * surface can drive. A status that is only a destination is a dead end, and
 * `retiring` was one: a rolled-back retire landed there having spent nothing,
 * and the retire gate, the settings route and the worker all refused it.
 *
 * Every row below is EXERCISED by code. `retiring -> closed / worker` was a
 * PHANTOM when it was written (the worker did not scan `retiring`); the worker
 * now scans it, and its exits are the two rows named `worker` below.
 */
/**
 * The store methods that can WRITE a status. Every transition names one
 * (FIXREVIEW F4).
 */
export type LendingGuardCasMethod =
  | "armCas"
  | "finishArm"
  | "setHold"
  | "beginRetire"
  | "finishRetire"
  | "close";

export const LENDING_GUARD_TRANSITIONS: readonly {
  readonly from: LendingGuardStatus;
  readonly to: LendingGuardStatus;
  readonly surface: "convergence" | "arm" | "worker" | "retire" | "owner-door";
  /**
   * The store method that performs it — FIXREVIEW F4.
   *
   * This field is what turns the table from documentation into ENFORCEMENT:
   * {@link LENDING_GUARD_CAS_SOURCES} is derived from it, and every CAS's
   * accepted-source list is read from that derivation rather than hand-written
   * beside the statement. A row nothing drives can no longer sit here quietly,
   * and a CAS can no longer accept a source the table never declared.
   */
  readonly via: LendingGuardCasMethod;
}[] = [
  { from: "provisioning-guard", to: "arming", surface: "arm", via: "armCas" },
  // A re-arm after a rolled-back or never-submitted arm. `retired` is NOT a
  // source: L11 refuses a re-arm after `retired` so two budgets can never be
  // summed across arms on one session.
  { from: "closed", to: "arming", surface: "arm", via: "armCas" },
  { from: "arming", to: "armed", surface: "arm", via: "finishArm" },
  { from: "arming", to: "held", surface: "arm", via: "finishArm" },
  { from: "arming", to: "closed", surface: "arm", via: "finishArm" },
  // R3.4's door: an `arming` row with no live `"lending"` journal row, older
  // than one interval, converges to `closed` with `arm-never-submitted`.
  { from: "arming", to: "closed", surface: "worker", via: "close" },
  { from: "arming", to: "armed", surface: "worker", via: "finishArm" },
  { from: "arming", to: "held", surface: "worker", via: "finishArm" },
  { from: "armed", to: "held", surface: "worker", via: "setHold" },
  { from: "held", to: "armed", surface: "worker", via: "setHold" },
  // The owner-recovery observation (§6.2): B holds no vUSDT and no retire row
  // explains it, so the guard closes itself.
  //
  // `held -> closed / worker` was here and was NOT DRIVEN (FIXREVIEW F4):
  // `detectOwnerRecovery` requires `status === "armed"`, so a held guard can
  // only reach `closed` as TWO writes — the P15 hold clear, then this edge —
  // and both of those are separately declared. The row is REMOVED and the
  // `close` CAS is NARROWED to match, rather than the reverse: an accepted
  // source no surface drives is a capability nothing is testing, and the two
  // dormant ones this CAS carried (`held` and `retiring`) were exactly the
  // pair P2 deleted from this table on purpose.
  { from: "armed", to: "closed", surface: "worker", via: "close" },
  { from: "armed", to: "retiring", surface: "retire", via: "beginRetire" },
  { from: "held", to: "retiring", surface: "retire", via: "beginRetire" },
  // FIXREVIEW F3: the worker's exit for `held` + `retire-unknown`. Evidence —
  // the retire's own journal row, or a reserve that is demonstrably empty —
  // resumes the retire it interrupted, and the `retiring` door above finishes
  // it. Without this the PAIR (`held`, `retire-unknown`) had no exit at all,
  // which is the wedge shape at hold granularity rather than status
  // granularity.
  { from: "held", to: "retiring", surface: "worker", via: "beginRetire" },
  // AUDIT B-H1's retry: a pool-short retire is signed AGAIN while the guard is
  // already `retiring`, so the admission CAS re-enters the status it is in.
  // Declared separately from the `finishRetire` row below because it is a
  // different writer — that is what `via` is for.
  { from: "retiring", to: "retiring", surface: "retire", via: "beginRetire" },
  { from: "retiring", to: "retired", surface: "retire", via: "finishRetire" },
  // A pool-short retire submits its bounded partial and STAYS retiring, with
  // `pool-cash-short` on the view and "retire again when the pool refills" —
  // and the gate ACCEPTS `retiring`, so that sentence is a real remedy.
  { from: "retiring", to: "retiring", surface: "retire", via: "finishRetire" },
  { from: "retiring", to: "held", surface: "retire", via: "finishRetire" },
  // AUDIT B-H1: a retire that spent NOTHING (refused before the submit, or a
  // relay FAILED) restores the status it interrupted — `armed`, or `held` with
  // the hold it carried.
  { from: "retiring", to: "armed", surface: "retire", via: "finishRetire" },
  // The worker's own exit for `retiring` (AUDIT B-H1/P2): a reserve that is
  // demonstrably empty converges to `retired`.
  //
  // `retiring -> closed / worker` was in this table and was a PHANTOM — the
  // worker did not scan `retiring` at all — and it is deliberately NOT restored
  // by the fix: `closed` on this path would have to carry the close reason
  // `recovered-by-owner`, which names a passkey withdrawal, and a retiring row
  // whose reserve is empty has a nearer explanation (its own retire). The
  // §6.2 observation stays on `armed | held`, where it can say something true.
  { from: "retiring", to: "retired", surface: "worker", via: "finishRetire" },
];

/**
 * Every status each CAS accepts as a SOURCE, DERIVED from the table above
 * (FIXREVIEW F4).
 *
 * Both backends read their accepted-source list from here, and the PostgreSQL
 * statements interpolate {@link lendingCasStatusIn} rather than repeating a
 * literal. So "the table documents what the code does" is not a claim anyone
 * has to re-check: the code cannot do anything else.
 *
 * The statements stay STATIC despite the interpolation — each list is a
 * constant computed once at module load, so every tag still maps to exactly one
 * SQL string and `test/support/fakeSql.ts`'s tag dispatch is unaffected.
 */
export const LENDING_GUARD_CAS_SOURCES: Readonly<
  Record<LendingGuardCasMethod, readonly LendingGuardStatus[]>
> = (() => {
  const methods: readonly LendingGuardCasMethod[] = [
    "armCas", "finishArm", "setHold", "beginRetire", "finishRetire", "close",
  ];
  const out = {} as Record<LendingGuardCasMethod, readonly LendingGuardStatus[]>;
  for (const method of methods) {
    const sources = new Set<LendingGuardStatus>();
    for (const transition of LENDING_GUARD_TRANSITIONS) {
      if (transition.via === method) sources.add(transition.from);
    }
    // Ordered by the enum so the SQL text is stable across runs.
    out[method] = LENDING_GUARD_STATUSES.filter((status) => sources.has(status));
  }
  return out;
})();

/** `'a','b'` — the derived source list, as a SQL literal list. */
export function lendingCasStatusIn(method: LendingGuardCasMethod): string {
  return LENDING_GUARD_CAS_SOURCES[method]
    .map((status) => `'${status}'`)
    .join(",");
}

/**
 * The exit of every (status, hold) PAIR — FIXREVIEW F3.
 *
 * The status-granularity table above is not the granularity the wedges have
 * ever had. PHASE3.11's was `active` **+** `none`; this enum's was `held` **+**
 * `retire-unknown`, which the P2 reachability test passed straight over
 * because `held` is a source of `armed` and of `retiring` — for OTHER holds.
 *
 * Every hold `LENDING_HOLDS` carries appears here exactly once, with the
 * surface that can leave it and the evidence that surface acts on. A hold added
 * without a row makes the test fail, which is the only way "every pair has an
 * exit" can be an enforced sentence rather than a hopeful one.
 */
export const LENDING_HOLD_EXITS: readonly {
  readonly status: LendingGuardStatus;
  readonly hold: LendingHold;
  /** Every status the exit can land on. Never the pair it started in. */
  readonly to: readonly LendingGuardStatus[];
  readonly surface: "worker" | "retire" | "owner-door";
  /** What the surface must observe before it may take the exit. */
  readonly evidence: string;
}[] = [
  {
    status: "held",
    hold: "account-too-complex",
    to: ["armed"],
    surface: "worker",
    evidence: "A reads inside LENDING_MAX_MARKETS again (AUDIT C-M1 / P15).",
  },
  {
    status: "held",
    hold: "arm-unknown",
    to: ["armed"],
    surface: "worker",
    evidence:
      "B holds more vUSDT than it did before the arm, which proves the arm landed "
      + "(R2.21); the clear records `armBlock` from that same reading (FIXREVIEW F1).",
  },
  {
    status: "held",
    hold: "retire-unknown",
    to: ["armed", "retiring", "retired"],
    surface: "worker",
    evidence:
      "The retire's own journal row is COMMITTED or ROLLED_BACK, or the reserve is "
      + "demonstrably empty and the retire is the explanation on hand (FIXREVIEW F3).",
  },
];

const STATUS_SET: ReadonlySet<string> = new Set<string>(LENDING_GUARD_STATUSES);

function assertStatus(value: string): LendingGuardStatus {
  if (!STATUS_SET.has(value)) {
    throw new Error(`Unknown lending guard status "${value}".`);
  }
  return value as LendingGuardStatus;
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

type MemoryAction = {
  readonly actionId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly kind: "rescue" | "arm" | "retire";
  readonly chargedAtMs: number;
};

export class MemoryLendingGuardStore implements LendingGuardStore {
  readonly #rows = new Map<string, LendingGuardRecord>();
  readonly #rescues = new Map<string, LendingRescueRecord>();
  readonly #actions = new Map<string, MemoryAction>();
  readonly #snapshots = new Map<string, LendingSnapshotRecord>();
  readonly #fences = new Map<string, Promise<void>>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  #owned(ownerAddress: Address, agentId: string): LendingGuardRecord | undefined {
    const row = this.#rows.get(agentId);
    if (row === undefined || row.ownerAddress !== ownerKey(ownerAddress)) {
      return undefined;
    }
    return row;
  }

  async putInitialIfAbsentOrSame(
    input: CreateLendingGuardInput,
  ): Promise<LendingGuardInitialResult> {
    const owner = ownerKey(input.ownerAddress);
    const existing = this.#rows.get(input.agentId);
    if (existing !== undefined) {
      const same =
        existing.ownerAddress === owner
        && existing.guardedAccount.toLowerCase() === getAddress(input.guardedAccount).toLowerCase()
        && existing.reserveToken.toLowerCase() === getAddress(input.reserveToken).toLowerCase()
        && existing.reserveCapWei === input.reserveCapWei
        && existing.reserveBps === input.reserveBps
        && existing.debtMarkets.length === input.debtMarkets.length
        && existing.debtMarkets.every(
          (market, index) =>
            market.toLowerCase() === getAddress(input.debtMarkets[index]!).toLowerCase(),
        );
      return same
        ? { kind: "same", record: structuredClone(existing) }
        : { kind: "conflict" };
    }
    const nowMs = this.#now();
    const record: LendingGuardRecord = {
      agentId: input.agentId,
      ownerAddress: owner,
      guardedAccount: getAddress(input.guardedAccount),
      reserveToken: getAddress(input.reserveToken),
      debtMarkets: input.debtMarkets.map((market) => getAddress(market)),
      status: "provisioning-guard",
      hold: null,
      reserveCapWei: input.reserveCapWei,
      reserveBps: input.reserveBps,
      budgetWei: 0n,
      supplyNativeWei: 0n,
      reserveNativeWei: 0n,
      mintUsdtWei: 0n,
      preArmVUsdtWei: 0n,
      preArmExchangeRate: 0n,
      armJournalKey: null,
      armBlock: null,
      armBlockSource: null,
      armTxHash: null,
      holdClearConsecutive: 0,
      lastActionAtMs: null,
      actionSeq: 0,
      closeReason: null,
      rowVersion: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.#rows.set(record.agentId, structuredClone(record));
    return { kind: "created", record: structuredClone(record) };
  }

  async get(ownerAddress: Address, agentId: string): Promise<LendingGuardRecord | null> {
    const row = this.#owned(ownerAddress, agentId);
    return row === undefined ? null : structuredClone(row);
  }

  async listForWorker(): Promise<readonly LendingGuardRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (row) =>
          row.status === "arming"
          || row.status === "armed"
          || row.status === "held"
          || row.status === "retiring",
      )
      .map((row) => structuredClone(row))
      .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  }

  #cas(
    ownerAddress: Address,
    agentId: string,
    expectedRowVersion: number,
    allowedFrom: readonly LendingGuardStatus[],
    mutate: (row: LendingGuardRecord) => LendingGuardRecord,
  ): LendingGuardCasResult {
    const row = this.#owned(ownerAddress, agentId);
    if (row === undefined) return { kind: "conflict", record: null };
    if (row.rowVersion !== expectedRowVersion || !allowedFrom.includes(row.status)) {
      return { kind: "conflict", record: structuredClone(row) };
    }
    const next: LendingGuardRecord = {
      ...mutate(row),
      rowVersion: row.rowVersion + 1,
      updatedAtMs: this.#now(),
    };
    // `guarded_account` is IMMUTABLE. The memory twin of the PostgreSQL
    // predicate, so both backends refuse the same write.
    if (next.guardedAccount.toLowerCase() !== row.guardedAccount.toLowerCase()) {
      throw new Error("lending_guards.guarded_account is immutable.");
    }
    this.#rows.set(agentId, structuredClone(next));
    return { kind: "ok", record: structuredClone(next) };
  }

  async armCas(input: ArmLendingGuardInput): Promise<LendingGuardCasResult> {
    return this.#cas(
      input.ownerAddress,
      input.agentId,
      input.expectedRowVersion,
      LENDING_GUARD_CAS_SOURCES.armCas,
      (row) => ({
        ...row,
        status: "arming",
        hold: null,
        holdClearConsecutive: 0,
        closeReason: null,
        budgetWei: input.budgetWei,
        reserveBps: input.reserveBps,
        supplyNativeWei: input.supplyNativeWei,
        reserveNativeWei: input.reserveNativeWei,
        mintUsdtWei: input.mintUsdtWei,
        preArmVUsdtWei: input.preArmVUsdtWei,
        preArmExchangeRate: input.preArmExchangeRate,
        armJournalKey: input.armJournalKey,
        armBlock: null,
        armBlockSource: null,
        armTxHash: null,
      }),
    );
  }

  async finishArm(input: FinishArmInput): Promise<LendingGuardCasResult> {
    return this.#cas(
      input.ownerAddress,
      input.agentId,
      input.expectedRowVersion,
      LENDING_GUARD_CAS_SOURCES.finishArm,
      (row) =>
        input.outcome === "armed"
          ? {
              ...row,
              status: "armed",
              hold: null,
              holdClearConsecutive: 0,
              armBlock: input.armBlock,
              armBlockSource:
                input.armBlock === null ? null : (input.armBlockSource ?? "post-arm-read"),
              armTxHash: input.armTxHash,
            }
          : input.outcome === "held"
            ? { ...row, status: "held", hold: input.hold, holdClearConsecutive: 0 }
            : { ...row, status: "closed", closeReason: input.closeReason },
    );
  }

  async setHold(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly hold: LendingHold | null;
    readonly armBlock?: bigint;
    readonly armBlockSource?: LendingArmBlockSource;
  }): Promise<LendingGuardCasResult> {
    return this.#cas(
      input.ownerAddress,
      input.agentId,
      input.expectedRowVersion,
      LENDING_GUARD_CAS_SOURCES.setHold,
      (row) => ({
        ...row,
        status: input.hold === null ? "armed" : "held",
        hold: input.hold,
        // FIXREVIEW F5: setting OR clearing a hold restarts the confirmation
        // count. A counter that outlived its own hold would carry evidence
        // about one condition into the clear of another.
        holdClearConsecutive: 0,
        // FIXREVIEW F1: one-way, and only from null. The twin of the PG
        // `coalesce(arm_block, $7::numeric)`.
        armBlock:
          row.armBlock === null && input.armBlock !== undefined
            ? input.armBlock
            : row.armBlock,
        armBlockSource:
          row.armBlock === null && input.armBlock !== undefined
            ? (input.armBlockSource ?? "post-arm-read")
            : row.armBlockSource,
      }),
    );
  }

  async noteHoldClearProgress(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly consecutive: number;
  }): Promise<LendingGuardCasResult> {
    return this.#cas(
      input.ownerAddress,
      input.agentId,
      input.expectedRowVersion,
      // A hold only exists on a `held` row, so this is the only source there
      // can be. It is NOT derived from the transition table because it writes
      // no status — the row stays exactly as held as it was.
      ["held"],
      (row) => ({ ...row, holdClearConsecutive: input.consecutive }),
    );
  }

  async beginRetire(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
  }): Promise<LendingGuardCasResult> {
    return this.#cas(
      input.ownerAddress,
      input.agentId,
      input.expectedRowVersion,
      // AUDIT B-H1: `retiring` is accepted so a partial retire can be retried
      // once the pool refills, which is the remedy its own refusal names.
      LENDING_GUARD_CAS_SOURCES.beginRetire,
      (row) => ({ ...row, status: "retiring" }),
    );
  }

  async finishRetire(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly outcome: "retired" | "partial" | "held" | "rolled-back";
    readonly hold?: LendingHold;
    readonly restore?: {
      readonly status: "armed" | "held";
      readonly hold: LendingHold | null;
    };
  }): Promise<LendingGuardCasResult> {
    return this.#cas(
      input.ownerAddress,
      input.agentId,
      input.expectedRowVersion,
      LENDING_GUARD_CAS_SOURCES.finishRetire,
      (row) =>
        input.outcome === "retired"
          ? { ...row, status: "retired", hold: null, closeReason: "retired" }
          : input.outcome === "held"
            ? {
                ...row,
                status: "held",
                hold: input.hold ?? "retire-unknown",
                holdClearConsecutive: 0,
              }
            : input.outcome === "rolled-back"
              ? {
                  ...row,
                  status: input.restore?.status ?? "armed",
                  hold: input.restore?.hold ?? null,
                  holdClearConsecutive: 0,
                  closeReason: null,
                }
              : { ...row, status: "retiring" },
    );
  }

  async close(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly closeReason: LendingCloseReason;
  }): Promise<LendingGuardCasResult> {
    return this.#cas(
      input.ownerAddress,
      input.agentId,
      input.expectedRowVersion,
      // FIXREVIEW F4: DERIVED, and therefore narrowed to `arming | armed`. The
      // three sources it used to accept — `provisioning-guard`, `held` and
      // `retiring` — were driven by nothing, and `retiring -> closed` is the
      // edge P2 deliberately deleted from the table because
      // `recovered-by-owner` would name a passkey withdrawal the plane did not
      // observe. Enforcement now cannot be broader than documentation.
      LENDING_GUARD_CAS_SOURCES.close,
      (row) => ({
        ...row,
        status: "closed",
        hold: null,
        closeReason: input.closeReason,
      }),
    );
  }

  async claimAction(input: ClaimLendingActionInput): Promise<ClaimLendingActionResult> {
    const row = this.#owned(input.ownerAddress, input.agentId);
    if (row === undefined) return { kind: "not_found" };
    const floorMs = input.minSecondsBetweenActions * 1_000;
    if (
      row.lastActionAtMs !== null
      && input.nowMs - row.lastActionAtMs < floorMs
    ) {
      return {
        kind: "cooldown",
        elapsedSec: Math.floor((input.nowMs - row.lastActionAtMs) / 1_000),
      };
    }
    const next: LendingGuardRecord = {
      ...row,
      lastActionAtMs: input.nowMs,
      actionSeq: row.actionSeq + 1,
      rowVersion: row.rowVersion + 1,
      updatedAtMs: this.#now(),
    };
    this.#rows.set(input.agentId, structuredClone(next));
    return { kind: "claimed", actionSeq: next.actionSeq };
  }

  async restoreClaim(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedActionSeq: number;
    readonly previousLastActionAtMs: number | null;
  }): Promise<{ readonly kind: "restored" | "superseded" }> {
    const row = this.#owned(input.ownerAddress, input.agentId);
    if (row === undefined) return { kind: "superseded" };
    // CONDITIONAL on `action_seq`: a claim taken after this one must never be
    // undone by a restore from an earlier cycle.
    if (row.actionSeq !== input.expectedActionSeq) return { kind: "superseded" };
    const next: LendingGuardRecord = {
      ...row,
      lastActionAtMs: input.previousLastActionAtMs,
      rowVersion: row.rowVersion + 1,
      updatedAtMs: this.#now(),
    };
    this.#rows.set(input.agentId, structuredClone(next));
    return { kind: "restored" };
  }

  async withLendingFence<T>(
    ownerAddress: Address,
    agentId: string,
    work: (fence: LendingGuardFence) => Promise<T>,
  ): Promise<T> {
    const key = `${ownerKey(ownerAddress)}|${agentId}`;
    const prior = this.#fences.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => turn);
    this.#fences.set(key, tail);
    await prior.catch(() => undefined);
    try {
      return await work({
        get: () => this.get(ownerAddress, agentId),
        claim: (claimInput) =>
          this.claimAction({ ownerAddress, agentId, ...claimInput }),
        // FIXREVIEW F6: the memory twin has no transaction to abort, so these
        // are the same writes. The PostgreSQL fence is where the guarantee
        // lives, and `test/lending.pg.test.ts` is where it is proven.
        armCas: (armInput) =>
          this.armCas({ ownerAddress, agentId, ...armInput }),
        beginRetire: (retireInput) =>
          this.beginRetire({ ownerAddress, agentId, ...retireInput }),
      });
    } finally {
      release();
      if (this.#fences.get(key) === tail) this.#fences.delete(key);
    }
  }

  async recordRescue(input: Omit<LendingRescueRecord, "createdAtMs">): Promise<void> {
    if (this.#rescues.has(input.rescueId)) return;
    this.#rescues.set(input.rescueId, {
      ...structuredClone(input),
      ownerAddress: ownerKey(input.ownerAddress),
      createdAtMs: this.#now(),
    });
  }

  async listRescues(
    ownerAddress: Address,
    agentId: string,
    limit: number,
  ): Promise<readonly LendingRescueRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#rescues.values()]
      .filter((row) => row.agentId === agentId && row.ownerAddress === owner)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, Math.max(0, limit))
      .map((row) => structuredClone(row));
  }

  async chargeAction(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly actionId: string;
    readonly kind: "rescue" | "arm" | "retire";
    readonly chargedAtMs: number;
  }): Promise<void> {
    if (this.#actions.has(input.actionId)) return;
    this.#actions.set(input.actionId, {
      actionId: input.actionId,
      agentId: input.agentId,
      ownerAddress: ownerKey(input.ownerAddress),
      kind: input.kind,
      chargedAtMs: input.chargedAtMs,
    });
  }

  async usageSince(
    ownerAddress: Address,
    agentId: string,
    sinceMs: number,
  ): Promise<LendingActionUsage> {
    const owner = ownerKey(ownerAddress);
    const rows = [...this.#actions.values()].filter(
      (row) =>
        row.agentId === agentId
        && row.ownerAddress === owner
        && row.kind === "rescue"
        && row.chargedAtMs >= sinceMs,
    );
    let lastRescueAtMs: number | null = null;
    for (const row of rows) {
      if (lastRescueAtMs === null || row.chargedAtMs > lastRescueAtMs) {
        lastRescueAtMs = row.chargedAtMs;
      }
    }
    return { rescues: rows.length, lastRescueAtMs };
  }

  async lastActionId(
    ownerAddress: Address,
    agentId: string,
    kind: "rescue" | "arm" | "retire",
  ): Promise<string | null> {
    const owner = ownerKey(ownerAddress);
    let latest: MemoryAction | null = null;
    for (const row of this.#actions.values()) {
      if (row.agentId !== agentId || row.ownerAddress !== owner || row.kind !== kind) {
        continue;
      }
      if (latest === null || row.chargedAtMs >= latest.chargedAtMs) latest = row;
    }
    return latest === null ? null : latest.actionId;
  }

  async putSnapshot(input: LendingSnapshotRecord): Promise<void> {
    this.#snapshots.set(input.agentId, {
      ...input,
      ownerAddress: ownerKey(input.ownerAddress),
      snapshot: structuredClone(input.snapshot),
    });
  }

  async getSnapshot(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LendingSnapshotRecord | null> {
    const row = this.#snapshots.get(agentId);
    if (row === undefined || row.ownerAddress !== ownerKey(ownerAddress)) return null;
    return structuredClone(row);
  }

  async close_(): Promise<void> {
    this.#rows.clear();
    this.#rescues.clear();
    this.#actions.clear();
    this.#snapshots.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

type GuardRow = {
  agent_id: string;
  owner_address: string;
  guarded_account: string;
  reserve_token: string;
  debt_markets: unknown;
  status: string;
  hold: string | null;
  reserve_cap_wei: string;
  reserve_bps: number;
  budget_wei: string;
  supply_native_wei: string;
  reserve_native_wei: string;
  mint_usdt_wei: string;
  pre_arm_vusdt_wei: string;
  pre_arm_exchange_rate: string;
  arm_journal_key: string | null;
  arm_block: string | null;
  arm_block_source: string | null;
  arm_tx_hash: string | null;
  hold_clear_consecutive: string | number | null;
  last_action_at_ms: string | number | null;
  action_seq: number;
  close_reason: string | null;
  row_version: number;
  created_at_ms: string | number;
  updated_at_ms: string | number;
};

const GUARD_COLUMNS =
  "agent_id, owner_address, guarded_account, reserve_token, debt_markets, status, hold, "
  + "reserve_cap_wei, reserve_bps, budget_wei, supply_native_wei, reserve_native_wei, "
  + "mint_usdt_wei, pre_arm_vusdt_wei, pre_arm_exchange_rate, arm_journal_key, arm_block, "
  + "arm_block_source, arm_tx_hash, hold_clear_consecutive, last_action_at_ms, action_seq, "
  + "close_reason, row_version, created_at_ms, updated_at_ms";

const LENDING_GUARDS_DDL = `
  create table if not exists lending_guards (
    agent_id text primary key,
    owner_address text not null,
    guarded_account text not null,
    reserve_token text not null,
    debt_markets jsonb not null,
    status text not null check (status in ('provisioning-guard','arming','armed','held','retiring','retired','closed')),
    hold text null,
    reserve_cap_wei numeric not null,
    reserve_bps int not null,
    budget_wei numeric not null default 0,
    supply_native_wei numeric not null default 0,
    reserve_native_wei numeric not null default 0,
    mint_usdt_wei numeric not null default 0,
    pre_arm_vusdt_wei numeric not null default 0,
    pre_arm_exchange_rate numeric not null default 0,
    arm_journal_key text null,
    arm_block numeric null,
    arm_block_source text null,
    arm_tx_hash text null,
    hold_clear_consecutive int not null default 0,
    last_action_at_ms bigint null,
    action_seq int not null default 0,
    close_reason text null,
    row_version int not null default 1,
    created_at_ms bigint not null,
    updated_at_ms bigint not null
  )
`;

/**
 * Additive migrations for a table that already exists (FIXREVIEW F5 / F7).
 *
 * `create table if not exists` does NOT add a column to a table that is already
 * there, which is how a schema change becomes an unreadable column on a live
 * deployment. The repo's established shape is `alter table … add column if not
 * exists`, and both of these are nullable-or-defaulted, so an existing row is
 * valid the moment they land.
 */
const LENDING_GUARDS_MIGRATIONS: readonly string[] = [
  `alter table lending_guards add column if not exists arm_block_source text`,
  `alter table lending_guards add column if not exists hold_clear_consecutive int not null default 0`,
];

const LENDING_GUARDS_WORKER_INDEX_DDL = `
  create index if not exists lending_guards_worker_idx
    on lending_guards (status, agent_id)
`;

const LENDING_RESCUES_DDL = `
  create table if not exists lending_rescues (
    rescue_id text primary key,
    agent_id text not null,
    owner_address text not null,
    journal_key text not null,
    market text not null,
    amount_wei numeric not null,
    hf_before numeric null,
    hf_after numeric null,
    achieved_hf numeric null,
    tx_hash text null,
    effect text not null,
    partial boolean not null,
    conditions jsonb not null,
    created_at_ms bigint not null
  )
`;

const LENDING_RESCUES_INDEX_DDL = `
  create index if not exists lending_rescues_agent_idx
    on lending_rescues (owner_address, agent_id, created_at_ms desc)
`;

const LENDING_ACTIONS_DDL = `
  create table if not exists lending_actions (
    action_id text primary key,
    agent_id text not null,
    owner_address text not null,
    kind text not null,
    charged_at_ms bigint not null
  )
`;

const LENDING_ACTIONS_INDEX_DDL = `
  create index if not exists lending_actions_window_idx
    on lending_actions (owner_address, agent_id, charged_at_ms)
`;

const LENDING_SNAPSHOTS_DDL = `
  create table if not exists lending_snapshots (
    agent_id text primary key,
    owner_address text not null,
    block_number numeric not null,
    observed_at_ms bigint not null,
    snapshot jsonb not null
  )
`;

function toWei(value: string | number | null): bigint {
  if (value === null) return 0n;
  return BigInt(value);
}

function rowToGuard(row: GuardRow): LendingGuardRecord {
  const markets = decodeJsonb(row.debt_markets);
  return {
    agentId: row.agent_id,
    ownerAddress: ownerKey(getAddress(row.owner_address)),
    guardedAccount: getAddress(row.guarded_account),
    reserveToken: getAddress(row.reserve_token),
    debtMarkets: Array.isArray(markets)
      ? markets.map((entry) => getAddress(String(entry)))
      : [],
    status: assertStatus(row.status),
    hold: row.hold === null ? null : (row.hold as LendingHold),
    reserveCapWei: BigInt(row.reserve_cap_wei),
    reserveBps: Number(row.reserve_bps),
    budgetWei: BigInt(row.budget_wei),
    supplyNativeWei: BigInt(row.supply_native_wei),
    reserveNativeWei: BigInt(row.reserve_native_wei),
    mintUsdtWei: BigInt(row.mint_usdt_wei),
    preArmVUsdtWei: BigInt(row.pre_arm_vusdt_wei),
    preArmExchangeRate: BigInt(row.pre_arm_exchange_rate),
    armJournalKey: row.arm_journal_key,
    armBlock: row.arm_block === null ? null : BigInt(row.arm_block),
    armBlockSource:
      row.arm_block === null || row.arm_block_source === null
        ? null
        : (row.arm_block_source as LendingArmBlockSource),
    armTxHash: row.arm_tx_hash === null ? null : (row.arm_tx_hash as Hex),
    holdClearConsecutive:
      row.hold_clear_consecutive === null || row.hold_clear_consecutive === undefined
        ? 0
        : Number(row.hold_clear_consecutive),
    lastActionAtMs:
      row.last_action_at_ms === null ? null : Number(row.last_action_at_ms),
    actionSeq: Number(row.action_seq),
    closeReason:
      row.close_reason === null ? null : (row.close_reason as LendingCloseReason),
    rowVersion: Number(row.row_version),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(toWei(row.updated_at_ms)),
  };
}

export class PostgresLendingGuardStore implements LendingGuardStore {
  readonly #sql: SqlClient;
  readonly #now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.#now = now;
  }

  static async create(
    sql: SqlClient,
    now: Clock = Date.now,
  ): Promise<PostgresLendingGuardStore> {
    await sql.query(LENDING_GUARDS_DDL);
    for (const migration of LENDING_GUARDS_MIGRATIONS) await sql.query(migration);
    await sql.query(LENDING_GUARDS_WORKER_INDEX_DDL);
    await sql.query(LENDING_RESCUES_DDL);
    await sql.query(LENDING_RESCUES_INDEX_DDL);
    await sql.query(LENDING_ACTIONS_DDL);
    await sql.query(LENDING_ACTIONS_INDEX_DDL);
    await sql.query(LENDING_SNAPSHOTS_DDL);
    return new PostgresLendingGuardStore(sql, now);
  }

  async putInitialIfAbsentOrSame(
    input: CreateLendingGuardInput,
  ): Promise<LendingGuardInitialResult> {
    const owner = ownerKey(input.ownerAddress);
    const nowMs = this.#now();
    const inserted = await this.#sql.query<GuardRow>(
      `/* lendingGuards.putInitial */
       insert into lending_guards (agent_id, owner_address, guarded_account, reserve_token,
         debt_markets, status, hold, reserve_cap_wei, reserve_bps, budget_wei,
         supply_native_wei, reserve_native_wei, mint_usdt_wei, pre_arm_vusdt_wei,
         pre_arm_exchange_rate, arm_journal_key, arm_block, arm_block_source, arm_tx_hash,
         hold_clear_consecutive,
         last_action_at_ms, action_seq, close_reason, row_version, created_at_ms, updated_at_ms)
       values ($1, $2, $3, $4, $5::jsonb, 'provisioning-guard', null, $6, $7, 0,
         0, 0, 0, 0, 0, null, null, null, null, 0, null, 0, null, 1, $8, $8)
       on conflict (agent_id) do nothing
       returning ${GUARD_COLUMNS}`,
      [
        input.agentId,
        owner,
        getAddress(input.guardedAccount),
        getAddress(input.reserveToken),
        encodeJsonbParam(input.debtMarkets.map((market) => getAddress(market))),
        input.reserveCapWei.toString(10),
        input.reserveBps,
        nowMs,
      ],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return { kind: "created", record: rowToGuard(created) };
    const existing = await this.#sql.query<GuardRow>(
      `/* lendingGuards.get */
       select ${GUARD_COLUMNS} from lending_guards where agent_id = $1 and owner_address = $2`,
      [input.agentId, owner],
    );
    const row = existing.rows[0];
    if (row === undefined) return { kind: "conflict" };
    const record = rowToGuard(row);
    const same =
      record.guardedAccount.toLowerCase() === getAddress(input.guardedAccount).toLowerCase()
      && record.reserveToken.toLowerCase() === getAddress(input.reserveToken).toLowerCase()
      && record.reserveCapWei === input.reserveCapWei
      && record.reserveBps === input.reserveBps
      && record.debtMarkets.length === input.debtMarkets.length
      && record.debtMarkets.every(
        (market, index) =>
          market.toLowerCase() === getAddress(input.debtMarkets[index]!).toLowerCase(),
      );
    return same ? { kind: "same", record } : { kind: "conflict" };
  }

  async get(ownerAddress: Address, agentId: string): Promise<LendingGuardRecord | null> {
    return this.#getOn(this.#sql, ownerAddress, agentId);
  }

  /** The row, on a NAMED connection — the fence reads inside its own tx (B-L9). */
  async #getOn(
    sql: SqlClient,
    ownerAddress: Address,
    agentId: string,
  ): Promise<LendingGuardRecord | null> {
    const result = await sql.query<GuardRow>(
      `/* lendingGuards.get */
       select ${GUARD_COLUMNS} from lending_guards where agent_id = $1 and owner_address = $2`,
      [agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToGuard(row);
  }

  async listForWorker(): Promise<readonly LendingGuardRecord[]> {
    const result = await this.#sql.query<GuardRow>(
      `/* lendingGuards.listForWorker */
       select ${GUARD_COLUMNS} from lending_guards
       where status in ('arming','armed','held','retiring')
       order by agent_id asc`,
    );
    return result.rows.map(rowToGuard);
  }

  /**
   * Settle one conditional UPDATE.
   *
   * Every transition below is a SEPARATE, STATIC statement with its own tag and
   * its own `status in (...)` literal — no dynamic SET clause, no dynamic
   * status list. That is deliberate: `test/support/fakeSql.ts` dispatches on
   * the tag and NEVER PARSES THE SQL, so a statement whose predicate is built
   * at runtime would have zero executed coverage in the offline suite while the
   * cross-backend tests stayed green.
   *
   * `guarded_account` appears in no SET list anywhere in this class, which is
   * how the column is immutable: there is no statement that can change it.
   */
  async #settle(
    ownerAddress: Address,
    agentId: string,
    result: { readonly rows: readonly GuardRow[] },
    sql: SqlClient = this.#sql,
  ): Promise<LendingGuardCasResult> {
    const row = result.rows[0];
    if (row !== undefined) return { kind: "ok", record: rowToGuard(row) };
    // FIXREVIEW F6: the conflict re-read runs on the SAME connection as the CAS
    // that lost, so a fence's re-read sees its own transaction rather than the
    // pool's uncommitted-to view of it.
    const current = await this.#getOn(sql, ownerAddress, agentId);
    return { kind: "conflict", record: current };
  }

  async armCas(input: ArmLendingGuardInput): Promise<LendingGuardCasResult> {
    return this.#armCasOn(this.#sql, input);
  }

  /** The arm's admission CAS, on a NAMED connection (FIXREVIEW F6). */
  async #armCasOn(
    sql: SqlClient,
    input: ArmLendingGuardInput,
  ): Promise<LendingGuardCasResult> {
    const result = await sql.query<GuardRow>(
      `/* lendingGuards.arm */
       update lending_guards set
         status = 'arming', hold = null, close_reason = null,
         budget_wei = $5, reserve_bps = $6, supply_native_wei = $7,
         reserve_native_wei = $8, mint_usdt_wei = $9, pre_arm_vusdt_wei = $10,
         pre_arm_exchange_rate = $11, arm_journal_key = $12,
         arm_block = null, arm_block_source = null, arm_tx_hash = null,
         hold_clear_consecutive = 0,
         row_version = row_version + 1, updated_at_ms = $3
       where agent_id = $1 and owner_address = $2 and row_version = $4
         and status in (${lendingCasStatusIn("armCas")})
       returning ${GUARD_COLUMNS}`,
      [
        input.agentId, ownerKey(input.ownerAddress), this.#now(), input.expectedRowVersion,
        input.budgetWei.toString(10), input.reserveBps,
        input.supplyNativeWei.toString(10), input.reserveNativeWei.toString(10),
        input.mintUsdtWei.toString(10), input.preArmVUsdtWei.toString(10),
        input.preArmExchangeRate.toString(10), input.armJournalKey,
      ],
    );
    return this.#settle(input.ownerAddress, input.agentId, result, sql);
  }

  async finishArm(input: FinishArmInput): Promise<LendingGuardCasResult> {
    const status =
      input.outcome === "armed" ? "armed" : input.outcome === "held" ? "held" : "closed";
    const result = await this.#sql.query<GuardRow>(
      `/* lendingGuards.finishArm */
       update lending_guards set
         status = $5, hold = $6, close_reason = $7, arm_block = $8,
         arm_block_source = $10, arm_tx_hash = $9, hold_clear_consecutive = 0,
         row_version = row_version + 1, updated_at_ms = $3
       where agent_id = $1 and owner_address = $2 and row_version = $4
         and status in (${lendingCasStatusIn("finishArm")})
       returning ${GUARD_COLUMNS}`,
      [
        input.agentId, ownerKey(input.ownerAddress), this.#now(), input.expectedRowVersion,
        status,
        input.outcome === "held" ? input.hold : null,
        input.outcome === "closed" ? input.closeReason : null,
        input.outcome === "armed" && input.armBlock !== null
          ? input.armBlock.toString(10)
          : null,
        input.outcome === "armed" ? input.armTxHash : null,
        // FIXREVIEW F7: the label travels with the figure and only with it.
        input.outcome === "armed" && input.armBlock !== null
          ? (input.armBlockSource ?? "post-arm-read")
          : null,
      ],
    );
    return this.#settle(input.ownerAddress, input.agentId, result);
  }

  async setHold(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly hold: LendingHold | null;
    readonly armBlock?: bigint;
    readonly armBlockSource?: LendingArmBlockSource;
  }): Promise<LendingGuardCasResult> {
    const result = await this.#sql.query<GuardRow>(
      `/* lendingGuards.setHold */
       update lending_guards set
         status = $5, hold = $6, hold_clear_consecutive = 0,
         -- FIXREVIEW F1: one-way, and only from null — the block that proved
         -- the arm landed is never overwritten by a later observation, and an
         -- omitted parameter leaves the column alone. The cast is EXPLICIT by
         -- house style after AUDIT B-B1; it was measured on real PostgreSQL
         -- that an untyped $7 also resolves here (coalesce takes its type from
         -- the column, unlike B-B1's unknown-minus-unknown), so this is
         -- clarity, not a fix.
         arm_block = coalesce(arm_block, $7::numeric),
         -- FIXREVIEW F7: the label follows the figure. The coalesce above is on
         -- the BLOCK, not on the label, and this case reads the PRE-UPDATE
         -- arm_block, so the two are written by exactly the same statement.
         arm_block_source = case when arm_block is null then $8::text else arm_block_source end,
         row_version = row_version + 1, updated_at_ms = $3
       where agent_id = $1 and owner_address = $2 and row_version = $4
         and status in (${lendingCasStatusIn("setHold")})
       returning ${GUARD_COLUMNS}`,
      [
        input.agentId, ownerKey(input.ownerAddress), this.#now(), input.expectedRowVersion,
        input.hold === null ? "armed" : "held", input.hold,
        input.armBlock === undefined ? null : input.armBlock.toString(10),
        input.armBlock === undefined
          ? null
          : (input.armBlockSource ?? "post-arm-read"),
      ],
    );
    return this.#settle(input.ownerAddress, input.agentId, result);
  }

  async noteHoldClearProgress(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly consecutive: number;
  }): Promise<LendingGuardCasResult> {
    const result = await this.#sql.query<GuardRow>(
      `/* lendingGuards.noteHoldClear */
       update lending_guards set
         hold_clear_consecutive = $5,
         row_version = row_version + 1, updated_at_ms = $3
       where agent_id = $1 and owner_address = $2 and row_version = $4
         and status in ('held')
       returning ${GUARD_COLUMNS}`,
      [
        input.agentId, ownerKey(input.ownerAddress), this.#now(),
        input.expectedRowVersion, input.consecutive,
      ],
    );
    return this.#settle(input.ownerAddress, input.agentId, result);
  }

  async beginRetire(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
  }): Promise<LendingGuardCasResult> {
    return this.#beginRetireOn(this.#sql, input);
  }

  /** The retire's admission CAS, on a NAMED connection (FIXREVIEW F6). */
  async #beginRetireOn(
    sql: SqlClient,
    input: {
      readonly ownerAddress: Address;
      readonly agentId: string;
      readonly expectedRowVersion: number;
    },
  ): Promise<LendingGuardCasResult> {
    const result = await sql.query<GuardRow>(
      `/* lendingGuards.beginRetire */
       update lending_guards set
         status = 'retiring', row_version = row_version + 1, updated_at_ms = $3
       where agent_id = $1 and owner_address = $2 and row_version = $4
         and status in (${lendingCasStatusIn("beginRetire")})
       returning ${GUARD_COLUMNS}`,
      [input.agentId, ownerKey(input.ownerAddress), this.#now(), input.expectedRowVersion],
    );
    return this.#settle(input.ownerAddress, input.agentId, result, sql);
  }

  async finishRetire(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly outcome: "retired" | "partial" | "held" | "rolled-back";
    readonly hold?: LendingHold;
    readonly restore?: {
      readonly status: "armed" | "held";
      readonly hold: LendingHold | null;
    };
  }): Promise<LendingGuardCasResult> {
    const status =
      input.outcome === "retired"
        ? "retired"
        : input.outcome === "held"
          ? "held"
          : input.outcome === "rolled-back"
            ? (input.restore?.status ?? "armed")
            : "retiring";
    const result = await this.#sql.query<GuardRow>(
      `/* lendingGuards.finishRetire */
       update lending_guards set
         status = $5, hold = $6, close_reason = $7, hold_clear_consecutive = 0,
         row_version = row_version + 1, updated_at_ms = $3
       where agent_id = $1 and owner_address = $2 and row_version = $4
         and status in (${lendingCasStatusIn("finishRetire")})
       returning ${GUARD_COLUMNS}`,
      [
        input.agentId, ownerKey(input.ownerAddress), this.#now(), input.expectedRowVersion,
        status,
        input.outcome === "held"
          ? (input.hold ?? "retire-unknown")
          : input.outcome === "rolled-back"
            ? (input.restore?.hold ?? null)
            : null,
        input.outcome === "retired" ? "retired" : null,
      ],
    );
    return this.#settle(input.ownerAddress, input.agentId, result);
  }

  async close(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedRowVersion: number;
    readonly closeReason: LendingCloseReason;
  }): Promise<LendingGuardCasResult> {
    const result = await this.#sql.query<GuardRow>(
      `/* lendingGuards.close */
       update lending_guards set
         status = 'closed', hold = null, close_reason = $5,
         row_version = row_version + 1, updated_at_ms = $3
       where agent_id = $1 and owner_address = $2 and row_version = $4
         and status in (${lendingCasStatusIn("close")})
       returning ${GUARD_COLUMNS}`,
      [
        input.agentId, ownerKey(input.ownerAddress), this.#now(),
        input.expectedRowVersion, input.closeReason,
      ],
    );
    return this.#settle(input.ownerAddress, input.agentId, result);
  }

  async claimAction(input: ClaimLendingActionInput): Promise<ClaimLendingActionResult> {
    return this.#claimOn(this.#sql, input);
  }

  /**
   * The claim, on a NAMED connection (AUDIT B-L9).
   *
   * `withLendingFence` passes the LOCK'S OWN transaction, so a fence that
   * aborts takes its claim with it. Running it on the pool's connection —
   * which is what it did — meant the advisory lock serialized the workers but
   * an aborting fence left the cooldown stamp and the sequence number standing.
   */
  async #claimOn(
    sql: SqlClient,
    input: ClaimLendingActionInput,
  ): Promise<ClaimLendingActionResult> {
    const owner = ownerKey(input.ownerAddress);
    const floorMs = input.minSecondsBetweenActions * 1_000;
    const result = await sql.query<{ action_seq: number }>(
      `/* lendingGuards.claim */
       update lending_guards
       set last_action_at_ms = $3, action_seq = action_seq + 1,
           row_version = row_version + 1, updated_at_ms = $3
       where agent_id = $1 and owner_address = $2
         -- BOTH OPERANDS ARE CAST (AUDIT B-B1). $3 - $4 with two untyped
         -- parameters is unknown - unknown, which real PostgreSQL refuses with
         -- "operator is not unique", so every claim threw inside the fence and
         -- NO rescue could ever be submitted in production. The fake SQL client
         -- never parses SQL, so nothing offline could see it -- the ERC-8004
         -- attname::text lesson, in this store.
         and (last_action_at_ms is null or last_action_at_ms <= $3::bigint - $4::bigint)
       returning action_seq`,
      [input.agentId, owner, input.nowMs, floorMs],
    );
    const row = result.rows[0];
    if (row !== undefined) return { kind: "claimed", actionSeq: Number(row.action_seq) };
    const current = await this.#getOn(sql, input.ownerAddress, input.agentId);
    if (current === null) return { kind: "not_found" };
    return {
      kind: "cooldown",
      elapsedSec:
        current.lastActionAtMs === null
          ? 0
          : Math.floor((input.nowMs - current.lastActionAtMs) / 1_000),
    };
  }

  async restoreClaim(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly expectedActionSeq: number;
    readonly previousLastActionAtMs: number | null;
  }): Promise<{ readonly kind: "restored" | "superseded" }> {
    const result = await this.#sql.query<{ action_seq: number }>(
      `/* lendingGuards.restoreClaim */
       update lending_guards
       set last_action_at_ms = $4, row_version = row_version + 1, updated_at_ms = $5
       where agent_id = $1 and owner_address = $2 and action_seq = $3
       returning action_seq`,
      [
        input.agentId,
        ownerKey(input.ownerAddress),
        input.expectedActionSeq,
        input.previousLastActionAtMs,
        this.#now(),
      ],
    );
    return { kind: result.rows.length > 0 ? "restored" : "superseded" };
  }

  async withLendingFence<T>(
    ownerAddress: Address,
    agentId: string,
    work: (fence: LendingGuardFence) => Promise<T>,
  ): Promise<T> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* lendingGuards.fence */ select pg_advisory_xact_lock($1, hashtext($2))`,
        [LENDING_LOCK_CLASSID, `${ownerKey(ownerAddress)}|${agentId}`],
      );
      // B-L9 + FIXREVIEW F6: the reads, the claim AND both admission CASes run
      // on the LOCK'S transaction, so an aborting fence rolls all of them back
      // together — and no fence checks out a second pool connection while
      // holding its own.
      return work({
        get: () => this.#getOn(tx, ownerAddress, agentId),
        claim: (claimInput) =>
          this.#claimOn(tx, { ownerAddress, agentId, ...claimInput }),
        armCas: (armInput) =>
          this.#armCasOn(tx, { ownerAddress, agentId, ...armInput }),
        beginRetire: (retireInput) =>
          this.#beginRetireOn(tx, { ownerAddress, agentId, ...retireInput }),
      });
    });
  }

  async recordRescue(input: Omit<LendingRescueRecord, "createdAtMs">): Promise<void> {
    await this.#sql.query(
      `/* lendingRescues.insert */
       insert into lending_rescues (rescue_id, agent_id, owner_address, journal_key, market,
         amount_wei, hf_before, hf_after, achieved_hf, tx_hash, effect, partial, conditions, created_at_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
       on conflict (rescue_id) do nothing`,
      [
        input.rescueId, input.agentId, ownerKey(input.ownerAddress), input.journalKey,
        getAddress(input.market), input.amountWei.toString(10),
        input.hfBefore === null ? null : input.hfBefore.toString(10),
        input.hfAfter === null ? null : input.hfAfter.toString(10),
        input.achievedHf === null ? null : input.achievedHf.toString(10),
        input.txHash, input.effect, input.partial,
        encodeJsonbParam(input.conditions), this.#now(),
      ],
    );
  }

  async listRescues(
    ownerAddress: Address,
    agentId: string,
    limit: number,
  ): Promise<readonly LendingRescueRecord[]> {
    const result = await this.#sql.query<{
      rescue_id: string; agent_id: string; owner_address: string; journal_key: string;
      market: string; amount_wei: string; hf_before: string | null; hf_after: string | null;
      achieved_hf: string | null; tx_hash: string | null; effect: string; partial: boolean;
      conditions: unknown; created_at_ms: string | number;
    }>(
      `/* lendingRescues.list */
       select rescue_id, agent_id, owner_address, journal_key, market, amount_wei,
              hf_before, hf_after, achieved_hf, tx_hash, effect, partial, conditions, created_at_ms
       from lending_rescues
       where owner_address = $1 and agent_id = $2
       order by created_at_ms desc
       limit $3`,
      [ownerKey(ownerAddress), agentId, Math.max(0, limit)],
    );
    return result.rows.map((row) => {
      const conditions = decodeJsonb(row.conditions);
      return {
        rescueId: row.rescue_id,
        agentId: row.agent_id,
        ownerAddress: ownerKey(getAddress(row.owner_address)),
        journalKey: row.journal_key,
        market: getAddress(row.market),
        amountWei: BigInt(row.amount_wei),
        hfBefore: row.hf_before === null ? null : BigInt(row.hf_before),
        hfAfter: row.hf_after === null ? null : BigInt(row.hf_after),
        achievedHf: row.achieved_hf === null ? null : BigInt(row.achieved_hf),
        txHash: row.tx_hash === null ? null : (row.tx_hash as Hex),
        effect: row.effect as LendingRescueEffect,
        partial: row.partial,
        conditions: Array.isArray(conditions)
          ? conditions.map((entry) => String(entry) as LendingCondition)
          : [],
        createdAtMs: Number(row.created_at_ms),
      };
    });
  }

  async chargeAction(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly actionId: string;
    readonly kind: "rescue" | "arm" | "retire";
    readonly chargedAtMs: number;
  }): Promise<void> {
    await this.#sql.query(
      `/* lendingActions.charge */
       insert into lending_actions (action_id, agent_id, owner_address, kind, charged_at_ms)
       values ($1,$2,$3,$4,$5)
       on conflict (action_id) do nothing`,
      [
        input.actionId, input.agentId, ownerKey(input.ownerAddress),
        input.kind, input.chargedAtMs,
      ],
    );
  }

  async usageSince(
    ownerAddress: Address,
    agentId: string,
    sinceMs: number,
  ): Promise<LendingActionUsage> {
    const result = await this.#sql.query<{ charged_at_ms: string | number }>(
      `/* lendingActions.usageSince */
       select charged_at_ms from lending_actions
       where owner_address = $1 and agent_id = $2 and kind = 'rescue' and charged_at_ms >= $3
       order by charged_at_ms asc`,
      [ownerKey(ownerAddress), agentId, sinceMs],
    );
    let lastRescueAtMs: number | null = null;
    for (const row of result.rows) {
      const at = Number(row.charged_at_ms);
      if (lastRescueAtMs === null || at > lastRescueAtMs) lastRescueAtMs = at;
    }
    return { rescues: result.rows.length, lastRescueAtMs };
  }

  async lastActionId(
    ownerAddress: Address,
    agentId: string,
    kind: "rescue" | "arm" | "retire",
  ): Promise<string | null> {
    const result = await this.#sql.query<{ action_id: string }>(
      `/* lendingActions.lastOfKind */
       select action_id from lending_actions
       where owner_address = $1 and agent_id = $2 and kind = $3
       order by charged_at_ms desc
       limit 1`,
      [ownerKey(ownerAddress), agentId, kind],
    );
    const row = result.rows[0];
    return row === undefined ? null : row.action_id;
  }

  async putSnapshot(input: LendingSnapshotRecord): Promise<void> {
    await this.#sql.query(
      `/* lendingSnapshots.put */
       insert into lending_snapshots (agent_id, owner_address, block_number, observed_at_ms, snapshot)
       values ($1,$2,$3,$4,$5::jsonb)
       on conflict (agent_id) do update
         set block_number = excluded.block_number,
             observed_at_ms = excluded.observed_at_ms,
             snapshot = excluded.snapshot
         where lending_snapshots.owner_address = excluded.owner_address`,
      [
        input.agentId, ownerKey(input.ownerAddress), input.blockNumber.toString(10),
        input.observedAtMs, encodeJsonbParam(input.snapshot),
      ],
    );
  }

  async getSnapshot(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LendingSnapshotRecord | null> {
    const result = await this.#sql.query<{
      agent_id: string; owner_address: string; block_number: string;
      observed_at_ms: string | number; snapshot: unknown;
    }>(
      `/* lendingSnapshots.get */
       select agent_id, owner_address, block_number, observed_at_ms, snapshot
       from lending_snapshots where agent_id = $1 and owner_address = $2`,
      [agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      agentId: row.agent_id,
      ownerAddress: ownerKey(getAddress(row.owner_address)),
      blockNumber: BigInt(row.block_number),
      observedAtMs: Number(row.observed_at_ms),
      snapshot: decodeJsonb(row.snapshot),
    };
  }

  async close_(): Promise<void> {
    await this.#sql.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export async function createLendingGuardStore(): Promise<LendingGuardStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresLendingGuardStore.create(sql);
    console.log("[lending-guard-store] backend=postgres");
    return store;
  }
  console.log("[lending-guard-store] backend=memory (DATABASE_URL not set)");
  return new MemoryLendingGuardStore();
}
