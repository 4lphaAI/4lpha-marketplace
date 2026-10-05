/** Durable state for the optional TradFi data-service budget.
 *
 * This store deliberately keeps owner setup operations separate from paid data
 * attempts.  A budget reservation is an exposure ledger entry; it is never a
 * substitute for the owner-admin allowance/checker operation.
 */
import { getAddress, type Address, type Hex } from "viem";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

export type CmcBudgetStatus =
  | "disabled"
  | "setup-required"
  | "pending"
  | "ready"
  | "exhausted"
  | "unavailable";
export type CmcAttemptState =
  | "reserved"
  | "prepared"
  | "transmitting"
  | "settled"
  | "unknown"
  | "released";
export type CmcContentState =
  | "pending"
  | "available"
  | "invalid"
  | "service-error";
export type CmcOwnerOperationMode = "topup" | "rebind";
export type CmcOwnerOperationState =
  | "prepared"
  | "attempted"
  | "unknown"
  | "confirmed"
  | "failed";
export type CmcReleaseProof =
  | { readonly kind: "no-disclosure" }
  | {
      readonly kind: "expiry-unused";
      readonly chainId: 56;
      readonly payer: Address;
      readonly nonce: bigint;
      readonly deadline: bigint;
      readonly attemptId: string;
      readonly blockNumber: bigint;
      readonly blockHash: Hex;
      readonly finalizedAtMs: number;
      readonly nonceUnused: true;
    };
export type CmcOwnerFailureProof = {
      readonly kind: "finalized-failure";
  readonly callsId: Hex;
  readonly callsDigest: Hex;
  readonly finalized: true;
};
export type CmcChargeProof = {
  readonly kind: "charge";
  readonly chainId: 56;
  readonly txHash: Hex;
  readonly payer: Address;
  readonly asset: Address;
  readonly amountWei: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly witnessTo: Address;
  readonly validAfter: bigint;
  readonly attemptId: string;
};
export type CmcOwnerExecutionProof = {
  readonly chainId: 56;
  readonly wallet: Address;
  readonly txHash: Hex;
  readonly blockHash: Hex;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly intentId: Hex;
  readonly executionNonce: bigint;
};

export type CmcBudgetRecord = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly wallet: Address;
  readonly generation: number;
  /** Cumulative owner-authorized total, never reset by disable/rebind. */
  readonly authorizedTotalWei: bigint;
  readonly settledWei: bigint;
  /** All reserved/prepared/transmitting/unknown attempts. */
  readonly reservedWei: bigint;
  /** Current independently-read remaining token allowance, when known. */
  readonly allowanceWei: bigint | null;
  readonly checkerSessionPublicKey: Hex | null;
  readonly sessionExpiry: number | null;
  readonly optedIn: boolean;
  readonly setupProved: boolean;
  readonly capabilityAvailable: boolean;
  readonly status: CmcBudgetStatus;
  readonly reason: string | null;
  readonly pendingOperationId: string | null;
  readonly pendingOwnerOperationId: string | null;
  readonly updatedAt: number;
  /** CMC-HIRE-SETUP R2.1: the leftover allowance adopted at initial setup (HOTFIX 2026-09-22). Absent means unknown/legacy. */
  readonly adoptedWei?: bigint;
};

export type CmcAttemptRecord = {
  readonly operationId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly wallet: Address;
  readonly generation: number;
  readonly sessionPublicKey: Hex | null;
  readonly sessionExpiry: number | null;
  readonly amountWei: bigint;
  readonly asset: Address;
  readonly spender: Address | null;
  readonly payee: Address | null;
  readonly witnessTo: Address | null;
  readonly validAfter: bigint | null;
  readonly deadline: bigint | null;
  readonly state: CmcAttemptState;
  readonly contentState: CmcContentState;
  readonly requestDigest: Hex | null;
  readonly nonce: bigint | null;
  readonly bodyHash: Hex | null;
  readonly disclosurePossible: boolean;
  /** AES-GCM ciphertext in its dedicated DB column. */
  readonly encryptedAuthorization: string | null;
  readonly txHash: Hex | null;
  /** Untrusted PAYMENT-RESPONSE transaction hint; exact proof still required. */
  readonly settlementTxHint: Hex | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type CmcOwnerOperationRecord = {
  readonly operationId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly mode: CmcOwnerOperationMode;
  readonly expectedGeneration: number;
  readonly priorGeneration: number;
  readonly incrementWei: bigint;
  readonly sessionPublicKey: Hex;
  readonly sessionExpiry: number;
  readonly priorAllowanceWei: bigint | null;
  readonly expectedAllowanceWei: bigint | null;
  readonly wallet: Address;
  readonly oldCheckerKeyHash: Hex | null;
  readonly keyHash: Hex;
  readonly calls: readonly CmcStoredCall[];
  readonly executionProof: CmcOwnerExecutionProof | null;
  readonly callsDigest: Hex;
  readonly callsId: Hex | null;
  readonly attemptId: string | null;
  readonly state: CmcOwnerOperationState;
  readonly createdAt: number;
  readonly updatedAt: number;
};
export type CmcStoredCall = {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
};

export type CmcNewsRecord = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly ticker: string;
  readonly skill: string;
  readonly generation: number;
  readonly status: CmcContentState;
  readonly context: string | null;
  readonly sourceUrl: string | null;
  readonly publishedAtMs: number | null;
  readonly payloadHash: Hex | null;
  readonly paymentOperationId: string | null;
  readonly asOfMs: number;
  readonly expiresAtMs: number;
  /**
   * TRADFI-CMC-EQUITY R2.2 (M5): the last attempt's timestamp, success or
   * failure. A failed attempt updates this without overwriting an existing
   * `available` row's content, so "due" (R2.1) treats the failure as done for
   * that window without losing yesterday's still-valid data. Absent/null on
   * legacy rows and rows that have never failed.
   */
  readonly lastAttemptAtMs?: number | null;
  /**
   * TRADFI-LLM-CMC-REQUEST R2.7/R3.2: `"llm"` when the row's LATEST attempt
   * (success or fail) came from an LLM-requested call, `null`/absent when it
   * came from a scheduled call. Never inherited from a prior write.
   */
  readonly requestedBy?: "llm" | null;
  /** The model's own request reason, sanitized, <= 160 chars. Never enters a prompt. */
  readonly requestReason?: string | null;
};

export type CmcNewsLlmRequestsCounter = { readonly windowStartMs: number; readonly count: number };

export type CmcNewsLease = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly lastAttemptAtMs: number | null;
  readonly inFlightOperationId: string | null;
  readonly leaseExpiresAtMs: number | null;
  readonly updatedAtMs: number;
  /** TRADFI-LLM-CMC-REQUEST R2.4: the LLM-requested-call counter for the current 16:30-ET window. Absent = legacy/never claimed. */
  readonly llmRequests?: CmcNewsLlmRequestsCounter | null;
};
export type CmcMemorySnapshot = {
  readonly agentId: string;
  readonly budget: CmcBudgetRecord | null;
  readonly attempts: readonly CmcAttemptRecord[];
  readonly ownerOperations: readonly CmcOwnerOperationRecord[];
  readonly news: readonly CmcNewsRecord[];
  readonly lease: CmcNewsLease | null;
};
const PINNED_CMC_CHARGE_WEI = 10_000_000_000_000_000n;

export type CmcBudgetStore = {
  rebindAgenticPaymentNonce?(input: { agentId: string; ownerAddress: Address; operationId: string; budgetGeneration: number;
    preparedNonce: bigint; signedNonce: bigint; signedDeadline: bigint; signedValidAfter: bigint; sessionExpiry: number; nowMs: number }): Promise<CmcAttemptRecord | null>;
  /**
   * Agentic G0 test aid only (never called by Altana): forget the unpaid failed news rows and the hourly-slot stamp so the daily calls are due again.
   * Removes failed news rows with no payment, a released attempt or no attempt record (never reserved). Refuses (null, nothing changed) while anything is pending or any attempt is neither released nor settled.
   */
  rewindFailedNewsForAgenticGate?(input: { agentId: string; ownerAddress: Address; nowMs: number }): Promise<{ removedNews: number } | null>;
  get(agentId: string, ownerAddress: Address): Promise<CmcBudgetRecord | null>;
  putInitial(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly wallet: Address;
    readonly totalWei: bigint;
    readonly nowMs?: number;
  }): Promise<CmcBudgetRecord>;
  /** Compatibility reader for the old composition root; production setup uses ownerConfirm. */
  setSetup(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly wallet: Address;
    readonly generation: number;
    readonly sessionPublicKey: Hex;
    readonly sessionExpiry: number;
    readonly allowanceWei: bigint;
    readonly nowMs?: number;
  }): Promise<CmcBudgetRecord | null>;
  toggle(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly optedIn: boolean;
    readonly nowMs?: number;
  }): Promise<CmcBudgetRecord | null>;
  setCapability(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly generation: number;
    readonly available: boolean;
    readonly reason?: string | null;
    readonly nowMs?: number;
  }): Promise<CmcBudgetRecord | null>;
  reserve(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly wallet: Address;
    readonly operationId: string;
    readonly attemptId: string;
    readonly amountWei: bigint;
    readonly nowMs?: number;
    readonly sessionPublicKey?: Hex;
    readonly sessionExpiry?: number;
    readonly asset?: Address;
    readonly spender?: Address;
    readonly payee?: Address;
    readonly witnessTo?: Address;
  }): Promise<{ readonly budget: CmcBudgetRecord; readonly attempt: CmcAttemptRecord } | null>;
  prepare(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly wallet: Address;
    readonly operationId: string;
    readonly generation: number;
    readonly sessionPublicKey: Hex;
    readonly sessionExpiry: number;
    readonly asset: Address;
    readonly amountWei: bigint;
    readonly spender: Address;
    readonly payee: Address;
    readonly witnessTo: Address;
    readonly validAfter: bigint;
    readonly deadline: bigint;
    readonly nonce: bigint;
    readonly requestDigest: Hex;
    readonly bodyHash: Hex;
    readonly nowMs?: number;
  }): Promise<CmcAttemptRecord | null>;
  saveAuthorization(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly operationId: string;
    readonly generation: number;
    readonly encryptedAuthorization: string;
    readonly nowMs?: number;
  }): Promise<CmcAttemptRecord | null>;
  setSettlementHint(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly operationId: string;
    readonly generation: number;
    readonly txHashHint: Hex;
    readonly nowMs?: number;
  }): Promise<CmcAttemptRecord | null>;
  transition(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly operationId: string;
    readonly generation: number;
    readonly from: CmcAttemptState;
    readonly to: CmcAttemptState;
    readonly nowMs?: number;
    readonly disclosurePossible?: boolean;
    readonly txHash?: Hex;
  }): Promise<CmcAttemptRecord | null>;
  markContent(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly operationId: string;
    readonly generation: number;
    readonly state: CmcContentState;
    readonly nowMs?: number;
  }): Promise<CmcAttemptRecord | null>;
  settle(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly operationId: string;
    readonly generation: number;
    readonly txHash: Hex;
    readonly proof: CmcChargeProof;
    readonly nowMs?: number;
  }): Promise<{ readonly budget: CmcBudgetRecord; readonly attempt: CmcAttemptRecord } | null>;
  markUnknown(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly operationId: string;
    readonly generation: number;
    readonly nowMs?: number;
  }): Promise<CmcAttemptRecord | null>;
  release(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly operationId: string;
    readonly generation: number;
    readonly proof: CmcReleaseProof;
    readonly nowMs?: number;
  }): Promise<{ readonly budget: CmcBudgetRecord; readonly attempt: CmcAttemptRecord } | null>;
  getAttempt(
    agentId: string,
    ownerAddress: Address,
    operationId: string,
  ): Promise<CmcAttemptRecord | null>;
  /** Restart-safe enumeration of attempts whose exposure is not terminal. */
  listPendingAttempts?(agentId: string, ownerAddress: Address): Promise<readonly CmcAttemptRecord[]>;
  prepareOwnerOperation(input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly mode: CmcOwnerOperationMode;
    readonly expectedGeneration: number;
    readonly incrementWei: bigint;
    readonly sessionPublicKey: Hex;
    readonly sessionExpiry: number;
    readonly priorAllowanceWei: bigint | null;
    readonly expectedAllowanceWei: bigint | null;
    readonly wallet: Address;
    readonly oldCheckerKeyHash: Hex | null;
    readonly keyHash: Hex;
    readonly callsDigest: Hex;
    readonly calls: readonly CmcStoredCall[];
    readonly nowMs?: number;
  }): Promise<CmcOwnerOperationRecord | null>;
  recordOwnerAttempt(input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly attemptId: string;
    readonly callsId?: Hex;
    readonly nowMs?: number;
  }): Promise<CmcOwnerOperationRecord | null>;
  confirmOwnerOperation(input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly expectedGeneration: number;
    readonly callsId: Hex;
    /** Fresh post-call allowance read at the same finalized owner proof. */
    readonly allowanceWei: bigint;
    readonly executionProof: CmcOwnerExecutionProof;
    readonly nowMs?: number;
  }): Promise<{ readonly budget: CmcBudgetRecord; readonly operation: CmcOwnerOperationRecord } | null>;
  failOwnerOperation(input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly expectedGeneration: number;
    readonly proof: CmcOwnerFailureProof;
    readonly nowMs?: number;
  }): Promise<CmcOwnerOperationRecord | null>;
  getOwnerOperation(
    agentId: string,
    ownerAddress: Address,
    operationId: string,
  ): Promise<CmcOwnerOperationRecord | null>;
  getNews(agentId: string, ownerAddress: Address, ticker: string, skill: string): Promise<CmcNewsRecord | null>;
  /** Owner-readable log surfaces (2026-09-20): every cached context and every paid attempt, newest first. */
  listNews(agentId: string, ownerAddress: Address): Promise<readonly CmcNewsRecord[]>;
  listAttempts(agentId: string, ownerAddress: Address): Promise<readonly CmcAttemptRecord[]>;
  putNews(input: CmcNewsRecord): Promise<CmcNewsRecord>;
  claimNewsSlot(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly operationId: string;
    readonly nowMs: number;
    /** TRADFI-LLM-CMC-REQUEST R2.4/R3.1: present exactly when the claimed target is an LLM-requested call. */
    readonly llmRequest?: { readonly windowStartMs: number; readonly cap: number };
  }): Promise<boolean>;
  finishNewsSlot(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly operationId: string;
    readonly nowMs: number;
  }): Promise<boolean>;
  getNewsLease(agentId: string, ownerAddress: Address): Promise<CmcNewsLease | null>;
  close(): Promise<void>;
};

function ownerKey(value: Address): Address {
  return `0x${getAddress(value).slice(2).toLowerCase()}`;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function nonnegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}
function budgetRemaining(row: Omit<CmcBudgetRecord, "status">): bigint {
  return nonnegative(row.authorizedTotalWei - row.settledWei - row.reservedWei);
}
function nowOf(nowMs: number | undefined, clock: () => number): number {
  return nowMs ?? clock();
}

const TRANSITIONS: Readonly<Record<CmcAttemptState, readonly CmcAttemptState[]>> = {
  reserved: ["prepared"],
  prepared: ["transmitting"],
  transmitting: ["settled", "unknown"],
  unknown: ["settled"],
  settled: [],
  released: [],
};

function emptyAttempt(input: {
  readonly operationId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly wallet: Address;
  readonly generation: number;
  readonly amountWei: bigint;
  readonly asset: Address;
  readonly nowMs: number;
}): CmcAttemptRecord {
  return {
    operationId: input.operationId,
    attemptId: input.attemptId,
    agentId: input.agentId,
    ownerAddress: input.ownerAddress,
    wallet: input.wallet,
    generation: input.generation,
    sessionPublicKey: null,
    sessionExpiry: null,
    amountWei: input.amountWei,
    asset: input.asset,
    spender: null,
    payee: null,
    witnessTo: null,
    validAfter: null,
    deadline: null,
    state: "reserved",
    contentState: "pending",
    requestDigest: null,
    nonce: null,
    bodyHash: null,
    disclosurePossible: false,
    encryptedAuthorization: null,
    txHash: null,
    settlementTxHint: null,
    createdAt: input.nowMs,
    updatedAt: input.nowMs,
  };
}

function freshBudget(input: {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly wallet: Address;
  readonly totalWei: bigint;
  readonly nowMs: number;
}): CmcBudgetRecord {
  return {
    agentId: input.agentId,
    ownerAddress: ownerKey(input.ownerAddress),
    wallet: getAddress(input.wallet),
    generation: 0,
    authorizedTotalWei: input.totalWei,
    settledWei: 0n,
    reservedWei: 0n,
    allowanceWei: null,
    checkerSessionPublicKey: null,
    sessionExpiry: null,
    optedIn: true,
    setupProved: false,
    capabilityAvailable: false,
    status: "setup-required",
    reason: null,
    pendingOperationId: null,
    pendingOwnerOperationId: null,
    updatedAt: input.nowMs,
  };
}

function deriveStatus(row: Omit<CmcBudgetRecord, "status">, priceWei: bigint): CmcBudgetStatus {
  if (!row.optedIn) return "disabled";
  if (row.pendingOwnerOperationId !== null || row.pendingOperationId !== null) return "pending";
  if (!row.setupProved) return "setup-required";
  if (!row.capabilityAvailable || row.reason !== null) return "unavailable";
  return budgetRemaining(row) < priceWei ? "exhausted" : "ready";
}

/** Process-local backend used by focused offline tests and local development. */
export class MemoryTradeCmcStore implements CmcBudgetStore {
  readonly #budgets = new Map<string, CmcBudgetRecord>();
  readonly #attempts = new Map<string, CmcAttemptRecord>();
  readonly #ownerOperations = new Map<string, CmcOwnerOperationRecord>();
  readonly #news = new Map<string, CmcNewsRecord>();
  readonly #leases = new Map<string, CmcNewsLease>();
  readonly #fences = new Map<string, Promise<void>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async get(agentId: string, ownerAddress: Address): Promise<CmcBudgetRecord | null> {
    const row = this.#budgets.get(agentId);
    return row === undefined || row.ownerAddress !== ownerKey(ownerAddress) ? null : clone(row);
  }

  /** Internal durable snapshot seam used by the Postgres adapter. */
  snapshot(agentId: string): CmcMemorySnapshot {
    return {
      agentId,
      budget: this.#budgets.get(agentId) === undefined ? null : clone(this.#budgets.get(agentId)! ),
      attempts: [...this.#attempts.values()].filter((row) => row.agentId === agentId).map(clone),
      ownerOperations: [...this.#ownerOperations.values()].filter((row) => row.agentId === agentId).map(clone),
      news: [...this.#news.values()].filter((row) => row.agentId === agentId).map(clone),
      lease: this.#leases.get(agentId) === undefined ? null : clone(this.#leases.get(agentId)! ),
    };
  }

  restore(snapshot: CmcMemorySnapshot, encrypted: ReadonlyMap<string, string>): void {
    if (snapshot.budget !== null) this.#budgets.set(snapshot.agentId, clone(snapshot.budget));
    for (const row of snapshot.attempts) {
      const ciphertext = encrypted.get(row.operationId);
      this.#attempts.set(row.operationId, clone(ciphertext === undefined ? row : { ...row, encryptedAuthorization: ciphertext }));
    }
    for (const row of snapshot.ownerOperations) this.#ownerOperations.set(row.operationId, clone(row));
    for (const row of snapshot.news) this.#news.set(newsKey(row.agentId, row.ticker, row.skill), clone(row));
    if (snapshot.lease !== null) this.#leases.set(snapshot.agentId, clone(snapshot.lease));
    // CMC-HIRE-SETUP R2.3: a snapshot taken before this phase has no `adoptedWei`
    // on a budget that was already set up (e.g. the live hotfix confirm). Backfill
    // it from the generation-0 confirmed owner operation so the one live agent
    // shows its adopted amount without a data migration.
    const restoredBudget = this.#budgets.get(snapshot.agentId);
    if (restoredBudget !== undefined && restoredBudget.setupProved && restoredBudget.adoptedWei === undefined) {
      const initialOperation = snapshot.ownerOperations.find((op) => op.priorGeneration === 0 && op.state === "confirmed");
      if (initialOperation !== undefined) {
        const adoptedWei = (initialOperation.expectedAllowanceWei ?? initialOperation.incrementWei) - initialOperation.incrementWei;
        this.#budgets.set(snapshot.agentId, { ...restoredBudget, adoptedWei });
      }
    }
  }

  async putInitial(input: {
    agentId: string;
    ownerAddress: Address;
    wallet: Address;
    totalWei: bigint;
    nowMs?: number;
  }): Promise<CmcBudgetRecord> {
    if (input.totalWei <= 0n || input.totalWei > (1n << 256n) - 1n) {
      throw new Error("CMC budget must be a positive uint256.");
    }
    return this.#fence(input.agentId, async () => {
      const existing = this.#budgets.get(input.agentId);
      if (existing !== undefined) {
        if (existing.ownerAddress !== ownerKey(input.ownerAddress)
          || existing.wallet.toLowerCase() !== input.wallet.toLowerCase()
          || existing.authorizedTotalWei !== input.totalWei) {
          throw new Error("CMC budget is already bound.");
        }
        return clone(existing);
      }
      const row = freshBudget({ ...input, nowMs: nowOf(input.nowMs, this.#now) });
      this.#budgets.set(input.agentId, row);
      return clone(row);
    });
  }

  async setSetup(input: {
    agentId: string;
    ownerAddress: Address;
    wallet: Address;
    generation: number;
    sessionPublicKey: Hex;
    sessionExpiry: number;
    allowanceWei: bigint;
    nowMs?: number;
  }): Promise<CmcBudgetRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (row === null || row.wallet.toLowerCase() !== input.wallet.toLowerCase() || row.generation !== input.generation || input.allowanceWei < 0n
        || input.sessionExpiry <= Math.floor(nowOf(input.nowMs, this.#now) / 1000)) return null;
      // This compatibility method can only prove the first exact finite setup
      // (or return the same fact). It cannot overwrite a live generation.
      if (row.setupProved && (row.checkerSessionPublicKey?.toLowerCase() !== input.sessionPublicKey.toLowerCase()
        || row.allowanceWei !== input.allowanceWei)) return null;
      if (!row.setupProved && input.allowanceWei < row.authorizedTotalWei) return null;
      const next: CmcBudgetRecord = {
        ...row,
        allowanceWei: input.allowanceWei,
        checkerSessionPublicKey: input.sessionPublicKey,
        sessionExpiry: input.sessionExpiry,
        setupProved: true,
        capabilityAvailable: row.capabilityAvailable,
        status: deriveStatus({ ...row, setupProved: true, allowanceWei: input.allowanceWei }, 1n),
        updatedAt: nowOf(input.nowMs, this.#now),
      };
      this.#budgets.set(input.agentId, next);
      return clone(next);
    });
  }

  async toggle(input: {
    agentId: string;
    ownerAddress: Address;
    optedIn: boolean;
    nowMs?: number;
  }): Promise<CmcBudgetRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (row === null) return null;
      const next: CmcBudgetRecord = {
        ...row,
        optedIn: input.optedIn,
        reason: input.optedIn
          ? row.reason === "news_disabled" ? null : row.reason
          : "news_disabled",
        status: input.optedIn
          ? deriveStatus({ ...row, reason: row.reason === "news_disabled" ? null : row.reason }, 1n)
          : "disabled",
        updatedAt: nowOf(input.nowMs, this.#now),
      };
      this.#budgets.set(input.agentId, next);
      return clone(next);
    });
  }

  async setCapability(input: {
    agentId: string;
    ownerAddress: Address;
    generation: number;
    available: boolean;
    reason?: string | null;
    nowMs?: number;
  }): Promise<CmcBudgetRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (row === null || row.generation !== input.generation) return null;
      const at = nowOf(input.nowMs, this.#now);
      const next: CmcBudgetRecord = {
        ...row,
        capabilityAvailable: input.available,
        reason: input.available ? null : (input.reason ?? "capability-unavailable"),
        status: input.available ? deriveStatus({ ...row, capabilityAvailable: true, reason: null }, 1n) : "unavailable",
        updatedAt: at,
      };
      this.#budgets.set(input.agentId, next);
      return clone(next);
    });
  }

  async reserve(input: {
    agentId: string;
    ownerAddress: Address;
    wallet: Address;
    operationId: string;
    attemptId: string;
    amountWei: bigint;
    nowMs?: number;
    sessionPublicKey?: Hex;
    sessionExpiry?: number;
    asset?: Address;
    spender?: Address;
    payee?: Address;
    witnessTo?: Address;
  }): Promise<{ budget: CmcBudgetRecord; attempt: CmcAttemptRecord } | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#ownedBudget(input.agentId, input.ownerAddress);
      const at = nowOf(input.nowMs, this.#now);
      const existing = this.#attempts.get(input.operationId);
      if (existing !== undefined) {
        return existing.agentId === input.agentId && existing.ownerAddress === ownerKey(input.ownerAddress)
          && existing.attemptId === input.attemptId && row !== null && existing.generation === row.generation
          ? { budget: clone(row), attempt: clone(existing) }
          : null;
      }
      if (row === null || row.wallet.toLowerCase() !== input.wallet.toLowerCase() || !row.optedIn || !row.setupProved || !row.capabilityAvailable
        || row.reason !== null || row.pendingOperationId !== null || row.pendingOwnerOperationId !== null
        || !this.#leaseOwns(input.agentId, input.operationId)
        || input.amountWei !== PINNED_CMC_CHARGE_WEI || row.allowanceWei === null
        || row.allowanceWei < row.reservedWei + input.amountWei
        || budgetRemaining(row) < input.amountWei
        || row.sessionExpiry === null || row.sessionExpiry <= Math.floor(at / 1000)) return null;
      const attempt = emptyAttempt({
        operationId: input.operationId,
        attemptId: input.attemptId,
        agentId: input.agentId,
        ownerAddress: ownerKey(input.ownerAddress),
        wallet: getAddress(input.wallet),
        generation: row.generation,
        amountWei: input.amountWei,
        asset: input.asset ?? ("0x0000000000000000000000000000000000000000" as Address),
        nowMs: at,
      });
      const decorated: CmcAttemptRecord = {
        ...attempt,
        sessionPublicKey: input.sessionPublicKey ?? row.checkerSessionPublicKey,
        sessionExpiry: input.sessionExpiry ?? row.sessionExpiry,
        spender: input.spender ?? null,
        payee: input.payee ?? null,
        witnessTo: input.witnessTo ?? null,
      };
      const next: CmcBudgetRecord = {
        ...row,
        reservedWei: row.reservedWei + input.amountWei,
        pendingOperationId: input.operationId,
        status: "pending",
        updatedAt: at,
      };
      this.#attempts.set(input.operationId, decorated);
      this.#budgets.set(input.agentId, next);
      return { budget: clone(next), attempt: clone(decorated) };
    });
  }

  async prepare(input: {
    agentId: string;
    ownerAddress: Address;
    wallet: Address;
    operationId: string;
    generation: number;
    sessionPublicKey: Hex;
    sessionExpiry: number;
    asset: Address;
    amountWei: bigint;
    spender: Address;
    payee: Address;
    witnessTo: Address;
    validAfter: bigint;
    deadline: bigint;
    nonce: bigint;
    requestDigest: Hex;
    bodyHash: Hex;
    nowMs?: number;
  }): Promise<CmcAttemptRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#attempts.get(input.operationId);
      const budget = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (row === undefined || row.agentId !== input.agentId || budget === null || budget.wallet.toLowerCase() !== input.wallet.toLowerCase() || row.wallet.toLowerCase() !== input.wallet.toLowerCase() || row.ownerAddress !== ownerKey(input.ownerAddress)
        || row.generation !== input.generation || budget.generation !== input.generation
        || budget.pendingOperationId !== input.operationId
        || !this.#leaseOwns(input.agentId, input.operationId)
        || row.sessionPublicKey !== null && row.sessionPublicKey.toLowerCase() !== input.sessionPublicKey.toLowerCase()
        || row.sessionExpiry !== null && row.sessionExpiry !== input.sessionExpiry
        || row.state !== "reserved" || input.amountWei !== row.amountWei
        || input.deadline <= input.validAfter || input.sessionExpiry < Number(input.deadline)) return null;
      const at = nowOf(input.nowMs, this.#now);
      const next: CmcAttemptRecord = {
        ...row,
        sessionPublicKey: input.sessionPublicKey,
        sessionExpiry: input.sessionExpiry,
        asset: getAddress(input.asset),
        spender: getAddress(input.spender),
        payee: getAddress(input.payee),
        witnessTo: getAddress(input.witnessTo),
        validAfter: input.validAfter,
        deadline: input.deadline,
        state: "prepared",
        requestDigest: input.requestDigest,
        nonce: input.nonce,
        bodyHash: input.bodyHash,
        updatedAt: at,
      };
      this.#attempts.set(input.operationId, next);
      return clone(next);
    });
  }

  async saveAuthorization(input: {
    agentId: string;
    ownerAddress: Address;
    operationId: string;
    generation: number;
    encryptedAuthorization: string;
    nowMs?: number;
  }): Promise<CmcAttemptRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#attempts.get(input.operationId);
      if (row === undefined || row.agentId !== input.agentId || row.ownerAddress !== ownerKey(input.ownerAddress)
        || row.generation !== input.generation || row.state !== "prepared" || !this.#leaseOwns(input.agentId, input.operationId)) return null;
      const next = { ...row, encryptedAuthorization: input.encryptedAuthorization, updatedAt: nowOf(input.nowMs, this.#now) };
      this.#attempts.set(input.operationId, next);
      return clone(next);
    });
  }

  async setSettlementHint(input: {
    agentId: string;
    ownerAddress: Address;
    operationId: string;
    generation: number;
    txHashHint: Hex;
    nowMs?: number;
  }): Promise<CmcAttemptRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#attempts.get(input.operationId);
      if (row === undefined || row.agentId !== input.agentId || row.ownerAddress !== ownerKey(input.ownerAddress)
        || row.generation !== input.generation || (row.state !== "transmitting" && row.state !== "unknown")
        || !/^0x[0-9a-fA-F]{64}$/u.test(input.txHashHint) || !this.#leaseOwns(input.agentId, input.operationId)) return null;
      const next = { ...row, settlementTxHint: input.txHashHint, updatedAt: nowOf(input.nowMs, this.#now) };
      this.#attempts.set(input.operationId, next);
      return clone(next);
    });
  }

  async transition(input: {
    agentId: string;
    ownerAddress: Address;
    operationId: string;
    generation: number;
    from: CmcAttemptState;
    to: CmcAttemptState;
    nowMs?: number;
    disclosurePossible?: boolean;
    txHash?: Hex;
  }): Promise<CmcAttemptRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#attempts.get(input.operationId);
      if (row === undefined || row.agentId !== input.agentId || row.ownerAddress !== ownerKey(input.ownerAddress)
        || row.generation !== input.generation || row.state !== input.from
        || !TRANSITIONS[input.from].includes(input.to) || !this.#leaseOwns(input.agentId, input.operationId)) return null;
      if (input.to === "transmitting" && input.disclosurePossible !== true) return null;
      if (row.disclosurePossible && input.disclosurePossible === false) return null;
      if ((input.to === "settled" || input.to === "unknown") && !row.disclosurePossible) return null;
      const at = nowOf(input.nowMs, this.#now);
      const budget = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (input.to === "transmitting" && (budget === null || budget.pendingOperationId !== input.operationId
        || !budget.optedIn || !budget.setupProved || !budget.capabilityAvailable || budget.reason !== null
        || row.sessionExpiry === null || row.sessionExpiry <= Math.floor(at / 1000) + 300
        || row.deadline === null || row.deadline <= BigInt(Math.floor(at / 1000)))) return null;
      const next = {
        ...row,
        state: input.to,
        disclosurePossible: row.disclosurePossible || input.disclosurePossible === true,
        txHash: input.txHash ?? row.txHash,
        updatedAt: at,
      };
      this.#attempts.set(input.operationId, next);
      return clone(next);
    });
  }

  async markContent(input: {
    agentId: string;
    ownerAddress: Address;
    operationId: string;
    generation: number;
    state: CmcContentState;
    nowMs?: number;
  }): Promise<CmcAttemptRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#attempts.get(input.operationId);
      if (row === undefined || row.agentId !== input.agentId || row.ownerAddress !== ownerKey(input.ownerAddress)
        || row.generation !== input.generation || row.state === "released" || !this.#leaseOwns(input.agentId, input.operationId)) return null;
      const next = { ...row, contentState: input.state, updatedAt: nowOf(input.nowMs, this.#now) };
      this.#attempts.set(input.operationId, next);
      return clone(next);
    });
  }

  async settle(input: {
    agentId: string;
    ownerAddress: Address;
    operationId: string;
    generation: number;
    txHash: Hex;
    proof: CmcChargeProof;
    nowMs?: number;
  }): Promise<{ budget: CmcBudgetRecord; attempt: CmcAttemptRecord } | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#attempts.get(input.operationId);
      const budget = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (row === undefined || row.agentId !== input.agentId || budget === null || row.ownerAddress !== ownerKey(input.ownerAddress)
        || row.generation !== input.generation || budget.generation !== input.generation
        || budget.pendingOperationId !== input.operationId
        || (row.state !== "transmitting" && row.state !== "unknown") || !row.disclosurePossible
        || budget.reservedWei < row.amountWei || input.proof.kind !== "charge"
        || input.proof.chainId !== 56 || input.proof.txHash.toLowerCase() !== input.txHash.toLowerCase()
        || input.proof.attemptId !== row.attemptId || input.proof.payer.toLowerCase() !== row.wallet.toLowerCase()
        || input.proof.asset.toLowerCase() !== row.asset.toLowerCase() || input.proof.amountWei !== row.amountWei
        || row.nonce === null || input.proof.nonce !== row.nonce || row.deadline === null || input.proof.deadline !== row.deadline
        || row.witnessTo === null || input.proof.witnessTo.toLowerCase() !== row.witnessTo.toLowerCase()
        || row.validAfter === null || input.proof.validAfter !== row.validAfter) return null;
      const at = nowOf(input.nowMs, this.#now);
      const attempt: CmcAttemptRecord = { ...row, state: "settled", txHash: input.txHash, updatedAt: at };
      const next: CmcBudgetRecord = {
        ...budget,
        reservedWei: budget.reservedWei - row.amountWei,
        settledWei: budget.settledWei + row.amountWei,
        allowanceWei: budget.allowanceWei === null ? null : nonnegative(budget.allowanceWei - row.amountWei),
        pendingOperationId: budget.pendingOperationId === input.operationId ? null : budget.pendingOperationId,
        reason: null,
        status: deriveStatus({ ...budget, reservedWei: budget.reservedWei - row.amountWei, settledWei: budget.settledWei + row.amountWei, pendingOperationId: budget.pendingOperationId === input.operationId ? null : budget.pendingOperationId, reason: null }, 1n),
        updatedAt: at,
      };
      this.#attempts.set(input.operationId, attempt);
      this.#budgets.set(input.agentId, next);
      return { budget: clone(next), attempt: clone(attempt) };
    });
  }

  async markUnknown(input: {
    agentId: string;
    ownerAddress: Address;
    operationId: string;
    generation: number;
    nowMs?: number;
  }): Promise<CmcAttemptRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#attempts.get(input.operationId);
      if (row === undefined || row.agentId !== input.agentId || row.ownerAddress !== ownerKey(input.ownerAddress)
        || row.generation !== input.generation || row.state !== "transmitting" || !row.disclosurePossible) return null;
      const at = nowOf(input.nowMs, this.#now);
      const next = { ...row, state: "unknown" as const, updatedAt: at };
      const budget = this.#budgets.get(input.agentId);
      if (budget !== undefined) this.#budgets.set(input.agentId, { ...budget, reason: "reconciliation-required", status: "unavailable", updatedAt: at });
      this.#attempts.set(input.operationId, next);
      return clone(next);
    });
  }

  async release(input: {
    agentId: string;
    ownerAddress: Address;
    operationId: string;
    generation: number;
    proof: CmcReleaseProof;
    nowMs?: number;
  }): Promise<{ budget: CmcBudgetRecord; attempt: CmcAttemptRecord } | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#attempts.get(input.operationId);
      const budget = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (row === undefined || row.agentId !== input.agentId || budget === null || row.ownerAddress !== ownerKey(input.ownerAddress)
        || row.generation !== input.generation || budget.generation !== input.generation
        || (row.state !== "reserved" && row.state !== "prepared" && row.state !== "unknown")
        || budget.pendingOperationId !== input.operationId
        || input.proof.kind === "no-disclosure" && (row.disclosurePossible || row.state === "unknown")
        || input.proof.kind === "expiry-unused" && (row.state !== "unknown" || !row.disclosurePossible || input.proof.nonceUnused !== true
          || input.proof.chainId !== 56 || input.proof.attemptId !== row.attemptId
          || input.proof.payer.toLowerCase() !== row.wallet.toLowerCase()
          || row.nonce === null || input.proof.nonce !== row.nonce
          || row.deadline === null || input.proof.deadline !== row.deadline)
        || budget.reservedWei < row.amountWei) return null;
      const at = nowOf(input.nowMs, this.#now);
      const attempt: CmcAttemptRecord = { ...row, state: "released", updatedAt: at };
      const next: CmcBudgetRecord = {
        ...budget,
        reservedWei: budget.reservedWei - row.amountWei,
        pendingOperationId: budget.pendingOperationId === input.operationId ? null : budget.pendingOperationId,
        reason: input.proof.kind === "expiry-unused" ? null : budget.reason,
        status: deriveStatus({ ...budget, reservedWei: budget.reservedWei - row.amountWei, pendingOperationId: budget.pendingOperationId === input.operationId ? null : budget.pendingOperationId, reason: input.proof.kind === "expiry-unused" ? null : budget.reason }, 1n),
        updatedAt: at,
      };
      this.#attempts.set(input.operationId, attempt);
      this.#budgets.set(input.agentId, next);
      return { budget: clone(next), attempt: clone(attempt) };
    });
  }

  async getAttempt(agentId: string, ownerAddress: Address, operationId: string): Promise<CmcAttemptRecord | null> {
    const row = this.#attempts.get(operationId);
    return row === undefined || row.agentId !== agentId || row.ownerAddress !== ownerKey(ownerAddress) ? null : clone(row);
  }

  async listPendingAttempts(agentId: string, ownerAddress: Address): Promise<readonly CmcAttemptRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#attempts.values()]
      .filter((row) => row.agentId === agentId && row.ownerAddress === owner
        && row.state !== "settled" && row.state !== "released")
      .map(clone);
  }

  async prepareOwnerOperation(input: {
    operationId: string;
    agentId: string;
    ownerAddress: Address;
    mode: CmcOwnerOperationMode;
    expectedGeneration: number;
    incrementWei: bigint;
    sessionPublicKey: Hex;
    sessionExpiry: number;
    priorAllowanceWei: bigint | null;
    expectedAllowanceWei: bigint | null;
    wallet: Address;
    oldCheckerKeyHash: Hex | null;
    keyHash: Hex;
    callsDigest: Hex;
    calls: readonly CmcStoredCall[];
    nowMs?: number;
  }): Promise<CmcOwnerOperationRecord | null> {
    return this.#fence(input.agentId, async () => {
      const at = nowOf(input.nowMs, this.#now);
      const existing = this.#ownerOperations.get(input.operationId);
      if (existing !== undefined) {
        return existing.agentId === input.agentId && existing.ownerAddress === ownerKey(input.ownerAddress)
          && existing.mode === input.mode && existing.expectedGeneration === input.expectedGeneration
          && existing.incrementWei === input.incrementWei && existing.callsDigest.toLowerCase() === input.callsDigest.toLowerCase()
          ? clone(existing)
          : null;
      }
      const budget = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (budget === null || budget.generation !== input.expectedGeneration || budget.pendingOperationId !== null
        || budget.pendingOwnerOperationId !== null || budget.reservedWei !== 0n
        || input.sessionExpiry <= Math.floor(at / 1000)
        || input.incrementWei < 0n || (input.mode === "topup" && input.incrementWei === 0n)
        || (input.mode === "rebind" && input.incrementWei !== 0n)) return null;
      if (input.mode === "topup" && input.expectedGeneration === 0 && budget.setupProved) return null;
      if (input.mode === "rebind" && !budget.setupProved) return null;
      const operation: CmcOwnerOperationRecord = {
        operationId: input.operationId,
        agentId: input.agentId,
        ownerAddress: ownerKey(input.ownerAddress),
        mode: input.mode,
        expectedGeneration: input.expectedGeneration,
        priorGeneration: budget.generation,
        incrementWei: input.incrementWei,
        sessionPublicKey: input.sessionPublicKey,
        sessionExpiry: input.sessionExpiry,
        priorAllowanceWei: input.priorAllowanceWei,
        expectedAllowanceWei: input.expectedAllowanceWei,
        wallet: input.wallet,
        oldCheckerKeyHash: input.oldCheckerKeyHash,
        keyHash: input.keyHash,
        callsDigest: input.callsDigest,
        calls: clone(input.calls),
        executionProof: null,
        callsId: null,
        attemptId: null,
        state: "prepared",
        createdAt: at,
        updatedAt: at,
      };
      this.#ownerOperations.set(input.operationId, operation);
      this.#budgets.set(input.agentId, { ...budget, pendingOwnerOperationId: input.operationId, status: "pending", updatedAt: at });
      return clone(operation);
    });
  }

  async recordOwnerAttempt(input: {
    operationId: string;
    agentId: string;
    ownerAddress: Address;
    attemptId: string;
    callsId?: Hex;
    nowMs?: number;
  }): Promise<CmcOwnerOperationRecord | null> {
    return this.#fence(input.agentId, async () => {
      const row = this.#ownerOperations.get(input.operationId);
      if (row === undefined || row.agentId !== input.agentId || row.ownerAddress !== ownerKey(input.ownerAddress)
        || (row.state !== "prepared" && row.state !== "attempted")
        || row.attemptId !== null && row.attemptId !== input.attemptId
        || row.callsId !== null && input.callsId !== undefined && row.callsId.toLowerCase() !== input.callsId.toLowerCase()) return null;
      const next = { ...row, state: "attempted" as const, attemptId: input.attemptId,
        ...(input.callsId === undefined ? {} : { callsId: input.callsId }), updatedAt: nowOf(input.nowMs, this.#now) };
      this.#ownerOperations.set(input.operationId, next);
      return clone(next);
    });
  }

  async confirmOwnerOperation(input: {
    operationId: string;
    agentId: string;
    ownerAddress: Address;
    expectedGeneration: number;
    callsId: Hex;
    allowanceWei: bigint;
    executionProof: CmcOwnerExecutionProof;
    nowMs?: number;
  }): Promise<{ budget: CmcBudgetRecord; operation: CmcOwnerOperationRecord } | null> {
    return this.#fence(input.agentId, async () => {
      const operation = this.#ownerOperations.get(input.operationId);
      const budget = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (operation?.state === "confirmed") {
        if (operation.agentId !== input.agentId || operation.ownerAddress !== ownerKey(input.ownerAddress)
          || operation.expectedGeneration !== input.expectedGeneration
          || operation.callsId?.toLowerCase() !== input.callsId.toLowerCase()
          || !sameExecutionProof(operation.executionProof, input.executionProof)) return null;
        return budget === null ? null : { budget: clone(budget), operation: clone(operation) };
      }
      if (operation === undefined || budget === null || operation.agentId !== input.agentId
        || operation.ownerAddress !== ownerKey(input.ownerAddress) || operation.expectedGeneration !== input.expectedGeneration
        || budget.generation !== input.expectedGeneration || (operation.state !== "prepared" && operation.state !== "attempted")
        || budget.pendingOwnerOperationId !== input.operationId || input.allowanceWei < 0n
        || operation.expectedAllowanceWei !== null && input.allowanceWei > operation.expectedAllowanceWei) return null;
      if ([...this.#ownerOperations.values()].some((candidate) => candidate.operationId !== operation.operationId
        && candidate.state === "confirmed" && candidate.callsId?.toLowerCase() === input.callsId.toLowerCase())) return null;
      if (!sameExecutionWallet(input.executionProof.wallet, operation.wallet) || input.executionProof.chainId !== 56
        || !isBytes32(input.executionProof.txHash) || !isBytes32(input.executionProof.blockHash) || !isBytes32(input.executionProof.intentId)
        || [...this.#ownerOperations.values()].some((candidate) => candidate.operationId !== operation.operationId
          && candidate.executionProof !== null
          && candidate.executionProof.wallet.toLowerCase() === input.executionProof.wallet.toLowerCase()
          && candidate.executionProof.txHash.toLowerCase() === input.executionProof.txHash.toLowerCase()
          && candidate.executionProof.executionNonce === input.executionProof.executionNonce)) return null;
      const at = nowOf(input.nowMs, this.#now);
      const initial = operation.priorGeneration === 0 && !budget.setupProved;
      // HOTFIX 2026-09-22: the initial setup may adopt a leftover allowance
      // (re-hired wallet); the confirmed allowance must equal prior + increment
      // and that total becomes the authorised budget.
      const initialExpected = operation.expectedAllowanceWei ?? operation.incrementWei;
      if ((initial && input.allowanceWei !== initialExpected)
        || (!initial && operation.mode === "rebind" && input.allowanceWei !== operation.expectedAllowanceWei)) return null;
      const authorizedTotalWei = initial ? input.allowanceWei : budget.authorizedTotalWei + operation.incrementWei;
      const nextBudget: CmcBudgetRecord = {
        ...budget,
        generation: budget.generation + 1,
        authorizedTotalWei,
        allowanceWei: input.allowanceWei,
        checkerSessionPublicKey: operation.sessionPublicKey,
        sessionExpiry: operation.sessionExpiry,
        setupProved: true,
        pendingOwnerOperationId: null,
        reason: null,
        capabilityAvailable: budget.capabilityAvailable,
        // CMC-HIRE-SETUP R2.2: the initial confirm records what was adopted from a
        // leftover allowance (HOTFIX 2026-09-22); a non-initial confirm carries the
        // field unchanged via the `...budget` spread above.
        ...(initial ? { adoptedWei: input.allowanceWei - operation.incrementWei } : {}),
        status: deriveStatus({ ...budget, generation: budget.generation + 1, authorizedTotalWei, allowanceWei: input.allowanceWei, setupProved: true, pendingOwnerOperationId: null, reason: null }, 1n),
        updatedAt: at,
      };
      const nextOperation: CmcOwnerOperationRecord = { ...operation, state: "confirmed", callsId: input.callsId, executionProof: input.executionProof, updatedAt: at };
      this.#budgets.set(input.agentId, nextBudget);
      this.#ownerOperations.set(input.operationId, nextOperation);
      return { budget: clone(nextBudget), operation: clone(nextOperation) };
    });
  }

  async failOwnerOperation(input: {
    operationId: string;
    agentId: string;
    ownerAddress: Address;
    expectedGeneration: number;
    proof: CmcOwnerFailureProof;
    nowMs?: number;
  }): Promise<CmcOwnerOperationRecord | null> {
    return this.#fence(input.agentId, async () => {
      const operation = this.#ownerOperations.get(input.operationId);
      const budget = this.#ownedBudget(input.agentId, input.ownerAddress);
      if (operation === undefined || budget === null || operation.ownerAddress !== ownerKey(input.ownerAddress)
        || operation.expectedGeneration !== input.expectedGeneration || budget.pendingOwnerOperationId !== input.operationId
        || operation.state === "confirmed" || input.proof.kind !== "finalized-failure" || input.proof.finalized !== true
        || operation.callsId === null || input.proof.callsId.toLowerCase() !== operation.callsId.toLowerCase()
        || input.proof.callsDigest.toLowerCase() !== operation.callsDigest.toLowerCase()) return null;
      const at = nowOf(input.nowMs, this.#now);
      const next = { ...operation, state: "failed" as const, updatedAt: at };
      this.#ownerOperations.set(input.operationId, next);
      this.#budgets.set(input.agentId, { ...budget, pendingOwnerOperationId: null, status: deriveStatus({ ...budget, pendingOwnerOperationId: null }, 1n), updatedAt: at });
      return clone(next);
    });
  }

  async getOwnerOperation(agentId: string, ownerAddress: Address, operationId: string): Promise<CmcOwnerOperationRecord | null> {
    const row = this.#ownerOperations.get(operationId);
    return row === undefined || row.agentId !== agentId || row.ownerAddress !== ownerKey(ownerAddress) ? null : clone(row);
  }

  async getNews(agentId: string, ownerAddress: Address, ticker: string, skill: string): Promise<CmcNewsRecord | null> {
    const row = this.#news.get(newsKey(agentId, ticker, skill));
    return row === undefined || row.ownerAddress !== ownerKey(ownerAddress) ? null : clone(row);
  }

  async listNews(agentId: string, ownerAddress: Address): Promise<readonly CmcNewsRecord[]> {
    return [...this.#news.values()].filter((row) => row.agentId === agentId && row.ownerAddress === ownerKey(ownerAddress))
      .sort((left, right) => right.asOfMs - left.asOfMs).map((row) => clone(row));
  }

  async listAttempts(agentId: string, ownerAddress: Address): Promise<readonly CmcAttemptRecord[]> {
    return [...this.#attempts.values()].filter((row) => row.agentId === agentId && row.ownerAddress === ownerKey(ownerAddress))
      .sort((left, right) => right.createdAt - left.createdAt).map((row) => clone(row));
  }

  async putNews(input: CmcNewsRecord): Promise<CmcNewsRecord> {
    return this.#fence(input.agentId, async () => {
      if (input.paymentOperationId !== null && !this.#leaseOwns(input.agentId, input.paymentOperationId)) throw new Error("CMC news lease is stale.");
      const row = { ...input, ownerAddress: ownerKey(input.ownerAddress) };
      this.#news.set(newsKey(input.agentId, input.ticker, input.skill), row);
      return clone(row);
    });
  }

  async claimNewsSlot(input: {
    agentId: string;
    ownerAddress: Address;
    operationId: string;
    nowMs: number;
    llmRequest?: { readonly windowStartMs: number; readonly cap: number };
  }): Promise<boolean> {
    return this.#fence(input.agentId, async () => {
      const key = ownerKey(input.ownerAddress);
      const current = this.#leases.get(input.agentId);
      if (current !== undefined && current.ownerAddress !== key) return false;
      if (current?.lastAttemptAtMs !== null && current?.lastAttemptAtMs !== undefined
        && input.nowMs - current.lastAttemptAtMs < 3_600_000) return false;
      // TRADFI-LLM-CMC-REQUEST R2.4/R3.1/AUDIT L-3: the LLM cap is evaluated
      // BEFORE any stale-lease reclaim mutation below — a cap refusal must
      // never partially mutate the store (releasing an exposed attempt,
      // clearing the budget's pending id) while still returning false, which
      // would leave the lease pointing at a released attempt and wedge every
      // later claim's `safeToReclaim` check. The stored counter is carried
      // UNCHANGED on every scheduled claim (no `llmRequest`) — only the
      // `llmRequest` branch here reads and rewrites it. This is the single
      // lease write in the store; a scheduled claim must never reset the
      // window count a prior LLM claim set.
      const storedLlmRequests = validateCmcLlmRequestsLease(current?.llmRequests);
      let nextLlmRequests = storedLlmRequests;
      if (input.llmRequest !== undefined) {
        const sameWindow = storedLlmRequests.windowStartMs === input.llmRequest.windowStartMs;
        const count = sameWindow ? storedLlmRequests.count : 0;
        if (count >= input.llmRequest.cap) return false;
        nextLlmRequests = { windowStartMs: input.llmRequest.windowStartMs, count: count + 1 };
      }
      if (current?.inFlightOperationId !== null && current?.inFlightOperationId !== undefined) {
        const exposed = this.#attempts.get(current.inFlightOperationId);
        const safeToReclaim = current.leaseExpiresAtMs !== null && input.nowMs > current.leaseExpiresAtMs
          && (exposed === undefined || (exposed.state === "reserved" || exposed.state === "prepared") && !exposed.disclosurePossible);
        if (!safeToReclaim) return false;
        if (exposed !== undefined) {
          const budget = this.#budgets.get(input.agentId);
          if (budget === undefined || budget.pendingOperationId !== current.inFlightOperationId || budget.reservedWei < exposed.amountWei) return false;
          const released = { ...exposed, state: "released" as const, updatedAt: input.nowMs };
          this.#attempts.set(current.inFlightOperationId, released);
          this.#budgets.set(input.agentId, { ...budget, reservedWei: budget.reservedWei - exposed.amountWei,
            pendingOperationId: null, status: deriveStatus({ ...budget, reservedWei: budget.reservedWei - exposed.amountWei, pendingOperationId: null }, PINNED_CMC_CHARGE_WEI), updatedAt: input.nowMs });
        }
      }
      this.#leases.set(input.agentId, { agentId: input.agentId, ownerAddress: key, lastAttemptAtMs: input.nowMs, inFlightOperationId: input.operationId, leaseExpiresAtMs: input.nowMs + 310_000, updatedAtMs: input.nowMs, llmRequests: nextLlmRequests });
      return true;
    });
  }

  async finishNewsSlot(input: {
    agentId: string;
    ownerAddress: Address;
    operationId: string;
    nowMs: number;
  }): Promise<boolean> {
    return this.#fence(input.agentId, async () => {
      const row = this.#leases.get(input.agentId);
      if (row === undefined || row.ownerAddress !== ownerKey(input.ownerAddress) || row.inFlightOperationId !== input.operationId) return false;
      this.#leases.set(input.agentId, { ...row, inFlightOperationId: null, leaseExpiresAtMs: null, updatedAtMs: input.nowMs });
      return true;
    });
  }

  async getNewsLease(agentId: string, ownerAddress: Address): Promise<CmcNewsLease | null> {
    const row = this.#leases.get(agentId);
    return row === undefined || row.ownerAddress !== ownerKey(ownerAddress) ? null : clone(row);
  }

  async close(): Promise<void> {
    this.#budgets.clear();
    this.#attempts.clear();
    this.#ownerOperations.clear();
    this.#news.clear();
    this.#leases.clear();
  }

  async rebindAgenticPaymentNonce(input: { agentId: string; ownerAddress: Address; operationId: string; budgetGeneration: number;
    preparedNonce: bigint; signedNonce: bigint; signedDeadline: bigint; signedValidAfter: bigint; sessionExpiry: number; nowMs: number }): Promise<CmcAttemptRecord | null> {
    return this.#fence(input.agentId, async () => {
      const budget = this.#ownedBudget(input.agentId, input.ownerAddress);
      const attempt = this.#attempts.get(input.operationId);
      const lease = this.#leases.get(input.agentId);
      const now = this.#now();
      if (budget === null || attempt === undefined || attempt.agentId !== input.agentId || attempt.ownerAddress !== ownerKey(input.ownerAddress)
        || attempt.generation !== input.budgetGeneration || budget.generation !== input.budgetGeneration || budget.pendingOperationId !== input.operationId
        || lease === undefined || lease.inFlightOperationId !== input.operationId || lease.leaseExpiresAtMs === null || lease.leaseExpiresAtMs <= now
        || attempt.state !== "prepared" || attempt.encryptedAuthorization !== null || attempt.nonce !== input.preparedNonce || attempt.deadline === null
        || BigInt(Math.floor(now / 1000) + 5) >= input.signedDeadline || input.signedDeadline > (attempt.deadline + 60n > BigInt(Math.floor(now / 1000) + 180) ? attempt.deadline + 60n : BigInt(Math.floor(now / 1000) + 180))
        || input.signedDeadline > BigInt(input.sessionExpiry)
        || input.signedValidAfter < 0n || input.signedValidAfter >= input.signedDeadline || input.signedValidAfter > BigInt(Math.floor(now / 1000) + 60)) return null;
      const next = { ...attempt, nonce: input.signedNonce, deadline: input.signedDeadline, validAfter: input.signedValidAfter, updatedAt: now };
      this.#attempts.set(input.operationId, next); return clone(next);
    });
  }

  async rewindFailedNewsForAgenticGate(input: { agentId: string; ownerAddress: Address; nowMs: number }): Promise<{ removedNews: number } | null> {
    return this.#fence(input.agentId, async () => {
      const budget = this.#ownedBudget(input.agentId, input.ownerAddress), lease = this.#leases.get(input.agentId);
      const attempts = [...this.#attempts.values()].filter((row) => row.agentId === input.agentId);
      if (budget === null || budget.pendingOperationId !== null || (lease?.inFlightOperationId ?? null) !== null
        || attempts.some((row) => row.state !== "released" && row.state !== "settled")) return null;
      const released = new Set(attempts.filter((row) => row.state === "released").map((row) => row.operationId)), known = new Set(attempts.map((row) => row.operationId));
      let removedNews = 0;
      for (const [key, row] of [...this.#news]) {
        if (row.agentId !== input.agentId || row.status === "available") continue;
        // Linked to an existing settled or open attempt: kept. A released attempt, or no attempt record at all (never reserved), means unpaid.
        if (row.paymentOperationId !== null && !released.has(row.paymentOperationId) && known.has(row.paymentOperationId)) continue;
        this.#news.delete(key); removedNews += 1;
      }
      if (lease !== undefined) this.#leases.set(input.agentId, { ...lease, lastAttemptAtMs: null });
      return { removedNews };
    });
  }

  #ownedBudget(agentId: string, ownerAddress: Address): CmcBudgetRecord | null {
    const row = this.#budgets.get(agentId);
    return row === undefined || row.ownerAddress !== ownerKey(ownerAddress) ? null : row;
  }
  #leaseOwns(agentId: string, operationId: string): boolean {
    const lease = this.#leases.get(agentId);
    return lease === undefined || lease.inFlightOperationId === operationId;
  }
  async #fence<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#fences.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.#fences.set(agentId, tail);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (this.#fences.get(agentId) === tail) this.#fences.delete(agentId);
    }
  }
}

/**
 * TRADFI-LLM-CMC-REQUEST R2.4: validate-on-read with a fail-to-zero default.
 * A corrupt value (a hand-edited row, a future writer) can never disable the
 * cap — at worst it resets to 0 for the current window, still bounded by the
 * hourly slot.
 */
function validateCmcLlmRequestsLease(value: CmcNewsLlmRequestsCounter | null | undefined): CmcNewsLlmRequestsCounter {
  if (value === null || value === undefined) return { windowStartMs: 0, count: 0 };
  if (!Number.isInteger(value.count) || value.count < 0 || !Number.isFinite(value.windowStartMs)) return { windowStartMs: 0, count: 0 };
  return { windowStartMs: value.windowStartMs, count: value.count };
}
/** Exported for `selectTarget`'s pre-check read (`store.getNewsLease`); the claim inside `claimNewsSlot` is authoritative. */
export function readCmcLlmRequestsLease(lease: CmcNewsLease | null): CmcNewsLlmRequestsCounter {
  return validateCmcLlmRequestsLease(lease?.llmRequests ?? null);
}

function newsKey(agentId: string, ticker: string, skill: string): string {
  return `${agentId}\u0000${ticker.toUpperCase()}\u0000${skill}`;
}
function sameExecutionWallet(left: Address, right: Address): boolean { return left.toLowerCase() === right.toLowerCase(); }
function isBytes32(value: string): boolean { return /^0x[0-9a-fA-F]{64}$/u.test(value); }
function sameExecutionProof(left: CmcOwnerExecutionProof | null, right: CmcOwnerExecutionProof): boolean {
  return left !== null && isBytes32(right.txHash) && isBytes32(right.blockHash) && isBytes32(right.intentId)
    && isBytes32(left.txHash) && isBytes32(left.blockHash) && isBytes32(left.intentId)
    && left.chainId === right.chainId && left.wallet.toLowerCase() === right.wallet.toLowerCase()
    && left.txHash.toLowerCase() === right.txHash.toLowerCase() && left.blockHash.toLowerCase() === right.blockHash.toLowerCase()
    && left.blockNumber === right.blockNumber && left.blockTimestamp === right.blockTimestamp
    && left.intentId.toLowerCase() === right.intentId.toLowerCase() && left.executionNonce === right.executionNonce;
}

/* -------------------------------------------------------------------------- */
/* PostgreSQL backend                                                         */
/* -------------------------------------------------------------------------- */


const BUDGET_DDL = `create table if not exists trade_cmc_budgets (
 agent_id text primary key, owner_address text not null, generation integer not null default 0,
 authorized_total_wei numeric not null, settled_wei numeric not null default 0,
 reserved_wei numeric not null default 0, allowance_wei numeric, checker_session_public_key text,
 session_expiry bigint, opted_in boolean not null default true, setup_proved boolean not null default false,
 capability_available boolean not null default false, reason text, pending_operation_id text,
 pending_owner_operation_id text, updated_at_ms bigint not null
)`;
const ATTEMPT_DDL = `create table if not exists trade_cmc_attempts (
 operation_id text primary key, attempt_id text not null, agent_id text not null,
 owner_address text not null, generation integer not null, session_public_key text,
 session_expiry bigint, amount_wei numeric not null, asset text not null, spender text, payee text,
 witness_to text, valid_after numeric, deadline numeric, state text not null check (state in ('reserved','prepared','transmitting','settled','unknown','released')),
 content_state text not null check (content_state in ('pending','available','invalid','service-error')),
 request_digest text, nonce numeric, body_hash text, disclosure_possible boolean not null default false,
 encrypted_authorization text, tx_hash text, created_at_ms bigint not null, updated_at_ms bigint not null
)`;
const OWNER_DDL = `create table if not exists trade_cmc_owner_operations (
 operation_id text primary key, agent_id text not null, owner_address text not null,
 mode text not null check (mode in ('topup','rebind')), expected_generation integer not null,
 prior_generation integer not null, increment_wei numeric not null, session_public_key text not null,
 session_expiry bigint not null, prior_allowance_wei numeric, expected_allowance_wei numeric,
 wallet text not null, old_checker_key_hash text, key_hash text not null, calls_digest text not null, calls_json jsonb not null,
 calls_id text, attempt_id text,
 state text not null check (state in ('prepared','attempted','unknown','confirmed','failed')),
 created_at_ms bigint not null, updated_at_ms bigint not null
)`;
const NEWS_DDL = `create table if not exists trade_cmc_news (
 agent_id text not null, owner_address text not null, ticker text not null, skill text not null,
 generation integer not null, status text not null, context text, source_url text,
 published_at_ms bigint, payload_hash text, payment_operation_id text, as_of_ms bigint not null,
 expires_at_ms bigint not null, primary key (agent_id, ticker, skill)
)`;
const LEASE_DDL = `create table if not exists trade_cmc_news_leases (
 agent_id text primary key, owner_address text not null, last_attempt_at_ms bigint,
 in_flight_operation_id text, updated_at_ms bigint not null
)`;
const SNAPSHOT_DDL = `create table if not exists trade_cmc_snapshots (
 agent_id text primary key, owner_address text not null, state_json jsonb not null, updated_at_ms bigint not null
)`;
const AUTH_DDL = `create table if not exists trade_cmc_authorizations (
 operation_id text primary key, agent_id text not null, encrypted_authorization text not null,
 updated_at_ms bigint not null
)`;
const OWNERSHIP_DDL = `create table if not exists trade_cmc_execution_ownership (
 chain_id integer not null, wallet text not null, tx_hash text not null, execution_nonce numeric not null,
 operation_id text not null, agent_id text not null, created_at_ms bigint not null,
 primary key (chain_id, wallet, tx_hash, execution_nonce)
)`;

export class PostgresTradeCmcStore implements CmcBudgetStore {
  readonly #sql: SqlClient;
  readonly #now: () => number;
  private constructor(sql: SqlClient, now: () => number) { this.#sql = sql; this.#now = now; }

  static async create(sql: SqlClient, now: () => number = Date.now): Promise<PostgresTradeCmcStore> {
    for (const ddl of [BUDGET_DDL, ATTEMPT_DDL, OWNER_DDL, NEWS_DDL, LEASE_DDL, SNAPSHOT_DDL, AUTH_DDL, OWNERSHIP_DDL]) await sql.query(ddl);
    return new PostgresTradeCmcStore(sql, now);
  }

  async get(agentId: string, ownerAddress: Address): Promise<CmcBudgetRecord | null> {
    return this.#read(agentId, (memory) => memory.get(agentId, ownerAddress));
  }

  async putInitial(input: { agentId: string; ownerAddress: Address; wallet: Address; totalWei: bigint; nowMs?: number }): Promise<CmcBudgetRecord> {
    return this.#mutate(input.agentId, (memory) => memory.putInitial(input));
  }

  async setSetup(input: { agentId: string; ownerAddress: Address; wallet: Address; generation: number; sessionPublicKey: Hex; sessionExpiry: number; allowanceWei: bigint; nowMs?: number }): Promise<CmcBudgetRecord | null> {
    return this.#mutate(input.agentId, (memory) => memory.setSetup(input));
  }

  async toggle(input: { agentId: string; ownerAddress: Address; optedIn: boolean; nowMs?: number }): Promise<CmcBudgetRecord | null> {
    return this.#mutate(input.agentId, (memory) => memory.toggle(input));
  }

  async setCapability(input: Parameters<CmcBudgetStore["setCapability"]>[0]): ReturnType<CmcBudgetStore["setCapability"]> { return this.#mutate(input.agentId, (memory) => memory.setCapability(input)); }

  async reserve(input: Parameters<CmcBudgetStore["reserve"]>[0]): ReturnType<CmcBudgetStore["reserve"]> { return this.#mutate(input.agentId, (memory) => memory.reserve(input)); }
  async prepare(input: Parameters<CmcBudgetStore["prepare"]>[0]): ReturnType<CmcBudgetStore["prepare"]> { return this.#mutate(input.agentId, (memory) => memory.prepare(input)); }
  async saveAuthorization(input: Parameters<CmcBudgetStore["saveAuthorization"]>[0]): ReturnType<CmcBudgetStore["saveAuthorization"]> { return this.#mutate(input.agentId, (memory) => memory.saveAuthorization(input)); }
  async setSettlementHint(input: Parameters<CmcBudgetStore["setSettlementHint"]>[0]): ReturnType<CmcBudgetStore["setSettlementHint"]> { return this.#mutate(input.agentId, (memory) => memory.setSettlementHint(input)); }
  async transition(input: Parameters<CmcBudgetStore["transition"]>[0]): ReturnType<CmcBudgetStore["transition"]> { return this.#mutate(input.agentId, (memory) => memory.transition(input)); }
  async markContent(input: Parameters<CmcBudgetStore["markContent"]>[0]): ReturnType<CmcBudgetStore["markContent"]> { return this.#mutate(input.agentId, (memory) => memory.markContent(input)); }
  async settle(input: Parameters<CmcBudgetStore["settle"]>[0]): ReturnType<CmcBudgetStore["settle"]> { return this.#mutate(input.agentId, (memory) => memory.settle(input)); }
  async markUnknown(input: Parameters<CmcBudgetStore["markUnknown"]>[0]): ReturnType<CmcBudgetStore["markUnknown"]> { return this.#mutate(input.agentId, (memory) => memory.markUnknown(input)); }
  async release(input: Parameters<CmcBudgetStore["release"]>[0]): ReturnType<CmcBudgetStore["release"]> { return this.#mutate(input.agentId, (memory) => memory.release(input)); }
  async prepareOwnerOperation(input: Parameters<CmcBudgetStore["prepareOwnerOperation"]>[0]): ReturnType<CmcBudgetStore["prepareOwnerOperation"]> { return this.#mutate(input.agentId, (memory) => memory.prepareOwnerOperation(input)); }
  async recordOwnerAttempt(input: Parameters<CmcBudgetStore["recordOwnerAttempt"]>[0]): ReturnType<CmcBudgetStore["recordOwnerAttempt"]> { return this.#mutate(input.agentId, (memory) => memory.recordOwnerAttempt(input)); }
  async confirmOwnerOperation(input: Parameters<CmcBudgetStore["confirmOwnerOperation"]>[0]): ReturnType<CmcBudgetStore["confirmOwnerOperation"]> { return this.#mutate(input.agentId, (memory) => memory.confirmOwnerOperation(input)); }
  async failOwnerOperation(input: Parameters<CmcBudgetStore["failOwnerOperation"]>[0]): ReturnType<CmcBudgetStore["failOwnerOperation"]> { return this.#mutate(input.agentId, (memory) => memory.failOwnerOperation(input)); }
  async getOwnerOperation(agentId: string, ownerAddress: Address, operationId: string): Promise<CmcOwnerOperationRecord | null> { return this.#read(agentId, (memory) => memory.getOwnerOperation(agentId, ownerAddress, operationId)); }
  async getAttempt(agentId: string, ownerAddress: Address, operationId: string): Promise<CmcAttemptRecord | null> { return this.#read(agentId, (memory) => memory.getAttempt(agentId, ownerAddress, operationId)); }
  async listPendingAttempts(agentId: string, ownerAddress: Address): Promise<readonly CmcAttemptRecord[]> { return this.#read(agentId, (memory) => memory.listPendingAttempts(agentId, ownerAddress)); }
  async getNews(agentId: string, ownerAddress: Address, ticker: string, skill: string): Promise<CmcNewsRecord | null> { return this.#read(agentId, (memory) => memory.getNews(agentId, ownerAddress, ticker, skill)); }
  async listNews(agentId: string, ownerAddress: Address): Promise<readonly CmcNewsRecord[]> { return this.#read(agentId, (memory) => memory.listNews(agentId, ownerAddress)); }
  async listAttempts(agentId: string, ownerAddress: Address): Promise<readonly CmcAttemptRecord[]> { return this.#read(agentId, (memory) => memory.listAttempts(agentId, ownerAddress)); }
  async putNews(input: CmcNewsRecord): Promise<CmcNewsRecord> { return this.#mutate(input.agentId, (memory) => memory.putNews(input)); }
  async claimNewsSlot(input: { agentId: string; ownerAddress: Address; operationId: string; nowMs: number; llmRequest?: { readonly windowStartMs: number; readonly cap: number } }): Promise<boolean> { return this.#mutate(input.agentId, (memory) => memory.claimNewsSlot(input)); }
  async finishNewsSlot(input: { agentId: string; ownerAddress: Address; operationId: string; nowMs: number }): Promise<boolean> { return this.#mutate(input.agentId, (memory) => memory.finishNewsSlot(input)); }
  async getNewsLease(agentId: string, ownerAddress: Address): Promise<CmcNewsLease | null> { return this.#read(agentId, (memory) => memory.getNewsLease(agentId, ownerAddress)); }
  async rebindAgenticPaymentNonce(input: Parameters<NonNullable<CmcBudgetStore["rebindAgenticPaymentNonce"]>>[0]): Promise<CmcAttemptRecord | null> {
    return this.#sql.transaction(async tx => {
      await lock(tx, input.agentId);
      const loaded = await this.#load(tx, input.agentId);
      const time = await tx.query<{ ms: string }>("select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms");
      const memory = new MemoryTradeCmcStore(() => Number(time.rows[0]!.ms));
      memory.restore(loaded.snapshot(input.agentId), new Map());
      const result = await memory.rebindAgenticPaymentNonce(input);
      if (result !== null) await this.#save(tx, input.agentId, memory.snapshot(input.agentId));
      return result;
    });
  }
  async rewindFailedNewsForAgenticGate(input: { agentId: string; ownerAddress: Address; nowMs: number }): Promise<{ removedNews: number } | null> {
    return this.#mutate(input.agentId, (memory) => memory.rewindFailedNewsForAgenticGate(input));
  }
  async close(): Promise<void> { await this.#sql.close(); }

  async #read<T>(agentId: string, work: (memory: MemoryTradeCmcStore) => Promise<T>): Promise<T> {
    return this.#sql.transaction(async (tx) => {
      const memory = await this.#load(tx, agentId);
      return work(memory);
    });
  }
  async #mutate<T>(agentId: string, work: (memory: MemoryTradeCmcStore) => Promise<T>): Promise<T> {
    return this.#sql.transaction(async (tx) => {
      await lock(tx, agentId);
      const memory = await this.#load(tx, agentId);
      const result = await work(memory);
      await this.#save(tx, agentId, memory.snapshot(agentId));
      return result;
    });
  }
  async #load(tx: SqlClient, agentId: string): Promise<MemoryTradeCmcStore> {
    const memory = new MemoryTradeCmcStore(this.#now);
    const snapshot = await tx.query<{ agent_id: string; state_json: unknown }>(`select agent_id,state_json from trade_cmc_snapshots where agent_id=$1 for update`, [agentId]);
    const authRows = await tx.query<{ operation_id: string; encrypted_authorization: string }>(`select operation_id,encrypted_authorization from trade_cmc_authorizations where agent_id=$1`, [agentId]);
    const auth = new Map<string, string>();
    for (const row of authRows.rows) auth.set(row.operation_id, row.encrypted_authorization);
    const row = snapshot.rows[0];
    if (row !== undefined) memory.restore(parseSnapshot(agentId, decodeJsonb(row.state_json)), auth);
    return memory;
  }
  async #save(tx: SqlClient, agentId: string, snapshot: CmcMemorySnapshot): Promise<void> {
    const publicSnapshot = { ...snapshot, attempts: snapshot.attempts.map((row) => ({ ...row, encryptedAuthorization: null })) };
    const json = JSON.parse(JSON.stringify(publicSnapshot, bigintReplacer)) as unknown;
    await tx.query(`insert into trade_cmc_snapshots (agent_id,owner_address,state_json,updated_at_ms) values ($1,$2,$3::jsonb,$4) on conflict (agent_id) do update set owner_address=excluded.owner_address,state_json=excluded.state_json,updated_at_ms=excluded.updated_at_ms`, [agentId, snapshot.budget?.ownerAddress ?? "0x0000000000000000000000000000000000000000", encodeJsonbParam(json), this.#now()]);
    await tx.query(`delete from trade_cmc_authorizations where agent_id=$1`, [agentId]);
    for (const row of snapshot.attempts) if (row.encryptedAuthorization !== null) {
      await tx.query(`insert into trade_cmc_authorizations (operation_id,agent_id,encrypted_authorization,updated_at_ms) values ($1,$2,$3,$4)`, [row.operationId, agentId, row.encryptedAuthorization, this.#now()]);
    }
    for (const operation of snapshot.ownerOperations) {
      const proof = operation.executionProof;
      if (proof === null) continue;
      const existing = await tx.query<{ operation_id: string }>(`select operation_id from trade_cmc_execution_ownership where chain_id=$1 and wallet=$2 and tx_hash=$3 and execution_nonce=$4 for update`, [proof.chainId, proof.wallet.toLowerCase(), proof.txHash.toLowerCase(), proof.executionNonce.toString(10)]);
      if (existing.rows[0] !== undefined && existing.rows[0].operation_id !== operation.operationId) throw new Error("CMC owner execution identity was already adopted.");
      if (existing.rows[0] === undefined) await tx.query(`insert into trade_cmc_execution_ownership (chain_id,wallet,tx_hash,execution_nonce,operation_id,agent_id,created_at_ms) values ($1,$2,$3,$4,$5,$6,$7)`, [proof.chainId, proof.wallet.toLowerCase(), proof.txHash.toLowerCase(), proof.executionNonce.toString(10), operation.operationId, agentId, this.#now()]);
    }
  }
}

async function lock(sql: SqlClient, agentId: string): Promise<void> {
  await sql.query(`select pg_advisory_xact_lock(hashtext($1))`, [agentId]);
}
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { __cmcBigint: value.toString(10) } : value;
}
function reviveCmc(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveCmc);
  if (typeof value !== "object" || value === null) return value;
  const row = value as Record<string, unknown>;
  if (typeof row["__cmcBigint"] === "string" && Object.keys(row).length === 1) return BigInt(row["__cmcBigint"]);
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(row)) out[key] = reviveCmc(member);
  return out;
}
function parseSnapshot(agentId: string, value: unknown): CmcMemorySnapshot {
  const parsed = reviveCmc(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("CMC snapshot is malformed.");
  const row = parsed as Record<string, unknown>;
  return { agentId, budget: (row["budget"] ?? null) as CmcBudgetRecord | null,
    attempts: Array.isArray(row["attempts"]) ? row["attempts"] as CmcAttemptRecord[] : [],
    ownerOperations: Array.isArray(row["ownerOperations"]) ? row["ownerOperations"] as CmcOwnerOperationRecord[] : [],
    news: Array.isArray(row["news"]) ? row["news"] as CmcNewsRecord[] : [],
    lease: (row["lease"] ?? null) as CmcNewsLease | null };
}

/** Select the durable backend using DATABASE_URL; tests leave it unset. */
export async function createTradeCmcStore(): Promise<CmcBudgetStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    return PostgresTradeCmcStore.create(await createPgSqlClient(connectionString));
  }
  return new MemoryTradeCmcStore();
}
