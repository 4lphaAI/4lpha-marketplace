/** Trading positions and bounded worker-run history (TRADING-AGENT R8/R9/R4). */
import { randomUUID } from "node:crypto";
import { getAddress, isHex, type Address, type Hex } from "viem";
import { sanitizeNote } from "../core/errors.js";
/** Owner-readable notes (LLM exit reasoning) keep up to this many chars — operator 2026-09-20, was 200. */
const MAX_NOTE_CHARS = 1_200;
import type { TradeRoute, TradeVenueId } from "../ops/route.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import { MAX_UINT256 } from "../trade/settlement.js";

import { isUnknownSubmissionEvent, normalizeTradeRunEvents, type TradeRunEvent } from "./tradeRunTrace.js";

export type Clock = () => number;
export type TradePositionStatus = "open" | "closed" | "orphaned";
export type TradeFillStatus = "verified" | "unverified";
export type TradeCloseReason = "owner-request" | "stop-loss" | "take-profit" | "max-hold" | "llm" | "balance-gone" | "crash-stop" | "session-expiring" | "trailing-stop" | "stale-exit";
export type TradeCrashPendingKind = "collapse" | "dust";
export type TradeAutoExitReason = "crash-stop" | "session-expiring";

export type TradeEvidenceExpected = {
  readonly sessionGeneration?: number;
  readonly lastQuoteWei: bigint | null;
  readonly lastQuoteBalance: bigint | null;
  readonly lastQuoteRoute: string | null;
  readonly lastQuoteAtMs: number | null;
  readonly crashPendingSinceMs: number | null;
  readonly crashPendingKind: TradeCrashPendingKind | null;
  readonly crashRefQuoteWei: bigint | null;
  readonly crashRefBalance: bigint | null;
  readonly crashRefAtMs: number | null;
  readonly crashRefRoute: string | null;
  readonly autoExitReason: TradeAutoExitReason | null;
  readonly autoExitAtMs: number | null;
  readonly autoExitNote: string | null;
};

export type TradeCrashEvidenceAction =
  | { readonly kind: "arm"; readonly pendingKind: TradeCrashPendingKind; readonly pendingSinceMs: number; readonly reference: { readonly quoteWei: bigint; readonly balance: bigint; readonly routeKey: string; readonly atMs: number } }
  | { readonly kind: "clear" }
  | { readonly kind: "marker"; readonly reason: TradeAutoExitReason; readonly atMs: number; readonly note: string | null };

export type TradePositionRecord = {
  readonly positionId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly token: Address;
  readonly route: TradeRoute;
  readonly venue: TradeVenueId | null;
  readonly entryWei: bigint;
  readonly tokenAmount: bigint | null;
  readonly fillStatus: TradeFillStatus;
  readonly openedAt: number;
  readonly entryTxHash: Hex | null;
  readonly status: TradePositionStatus;
  readonly exitRequestedAt: number | null;
  readonly orphanedAt: number | null;
  readonly closedAt: number | null;
  readonly exitWei: bigint | null;
  readonly exitTxHash: Hex | null;
  readonly soldTokenAmount: bigint | null;
  readonly exitFillStatus: TradeFillStatus | null;
  readonly closeReason: TradeCloseReason | null;
  readonly closeNote: string | null;
  readonly lastSellRefusal: string | null;
  readonly lastSellRefusalAt: number | null;
  readonly noPriceCount: number;
  readonly crashBasisVerified: boolean;
  readonly lastQuoteWei: bigint | null;
  readonly lastQuoteBalance: bigint | null;
  readonly lastQuoteRoute: string | null;
  readonly lastQuoteAtMs: number | null;
  readonly peakPnlBps: bigint | null;
  readonly crashPendingSinceMs: number | null;
  readonly crashPendingKind: TradeCrashPendingKind | null;
  readonly crashRefQuoteWei: bigint | null;
  readonly crashRefBalance: bigint | null;
  readonly crashRefAtMs: number | null;
  readonly crashRefRoute: string | null;
  readonly autoExitReason: TradeAutoExitReason | null;
  readonly autoExitAtMs: number | null;
  readonly autoExitNote: string | null;
  readonly sessionGeneration?: number;
  /** Null/absent means the historical native denomination. */
  readonly settlementAsset?: "USDT" | null;
  /** Requested input stays separate from verified receipt basis for v2. */
  readonly requestedEntryAtomic?: bigint | null;
  readonly verifiedEntryAtomic?: bigint | null;
  /** Unique finalized receipt ownership claim, absent while basis is unknown. */
  readonly receiptOwnershipKey?: string | null;
  /** Unique finalized receipt ownership claim for the exit leg. */
  readonly exitReceiptOwnershipKey?: string | null;
  /** TRADFI-AI-TRADE-V3 §3.1: last tradfi exit-LLM ask context, absent means "never asked". */
  readonly exitLlmContext?: ExitLlmContextRecord | null;
};

export type ExitLlmContextRecord = {
  readonly askedAtMs: number;
  readonly pnlBps: number;
  readonly peakPnlBps: number | null;
  readonly macdHistSign: -1 | 0 | 1 | null;
  readonly emaSpreadSign: -1 | 0 | 1 | null;
  readonly regime: string;
  readonly session: string;
  readonly trigger: string;
};

export type OpenTradePositionInput = Pick<
  TradePositionRecord,
  "positionId" | "agentId" | "ownerAddress" | "token" | "route" | "entryWei" | "tokenAmount" | "fillStatus" | "openedAt"
> & { readonly venue?: TradeVenueId | null; readonly entryTxHash?: Hex | null; readonly crashBasisVerified?: boolean; readonly sessionGeneration?: number; readonly settlementAsset?: "USDT" | null; readonly requestedEntryAtomic?: bigint | null; readonly verifiedEntryAtomic?: bigint | null; readonly receiptOwnershipKey?: string | null };

/** Closed telemetry fields; event projection discards arbitrary payloads and credentials. */
export type TradeRunInput = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly dryRun: boolean;
  readonly reason: string;
  readonly events?: readonly TradeRunEvent[];
  readonly candidates?: number;
  readonly refusals?: number;
  readonly entries?: number;
  readonly exits?: number;
};

export type TradeRunRecord = Omit<TradeRunInput, "candidates" | "refusals" | "entries" | "exits"> & {
  readonly candidates: number;
  readonly refusals: number;
  readonly entries: number;
  readonly exits: number;
  readonly id: string;
  readonly createdAt: number;
};

export interface TradePositionStore {
  open(input: OpenTradePositionInput): Promise<TradePositionRecord>;
  get(ownerAddress: Address, agentId: string, positionId: string, sql?: SqlClient): Promise<TradePositionRecord | null>;
  list(ownerAddress: Address, agentId: string): Promise<readonly TradePositionRecord[]>;
  listOpen(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<readonly TradePositionRecord[]>;
  requestExit(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null>;
  /** TRADFI-AI-TRADE-V3 §3.1: written after every exit-LLM ask, whatever the answer. */
  setExitLlmContext(ownerAddress: Address, agentId: string, positionId: string, context: ExitLlmContextRecord, sql?: SqlClient): Promise<TradePositionRecord | null>;
  markOrphaned(ownerAddress: Address, agentId: string, positionId: string, sql?: SqlClient): Promise<TradePositionRecord | null>;
  closePosition(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly exitWei: bigint | null;
    readonly exitTxHash?: Hex | null;
    readonly soldTokenAmount?: bigint | null;
    readonly exitFillStatus?: TradeFillStatus;
    readonly exitReceiptOwnershipKey?: string;
    readonly reason?: TradeCloseReason;
    readonly note?: string | null;
  }, sql?: SqlClient): Promise<TradePositionRecord | null>;
  recordSellRefusal(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly refusal: string | null;
  }, sql?: SqlClient): Promise<TradePositionRecord | null>;
  resolveFill(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly tokenAmount: bigint;
  }, sql?: SqlClient): Promise<TradePositionRecord | null>;
  adoptVerifiedEntry(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly verifiedEntryAtomic: bigint;
    readonly receiptOwnershipKey?: string;
    readonly tokenAmount?: bigint;
  }, sql?: SqlClient): Promise<TradePositionRecord | null>;
  adoptVerifiedExit(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly exitWei: bigint;
    readonly receiptOwnershipKey: string;
  }, sql?: SqlClient): Promise<TradePositionRecord | null>;
  recordQuote(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly quoteOutWei: bigint;
    readonly balance?: bigint;
    readonly routeKey?: string;
    readonly pnlBps: bigint | null;
    readonly atMs: number;
    readonly sessionGeneration?: number;
    readonly expected?: Pick<TradeEvidenceExpected, "lastQuoteWei" | "lastQuoteBalance" | "lastQuoteRoute" | "lastQuoteAtMs" | "sessionGeneration">;
  }, sql?: SqlClient): Promise<TradePositionRecord | null>;
  recordCrashEvidence(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly expected: TradeEvidenceExpected;
    readonly action: TradeCrashEvidenceAction;
    readonly writerGeneration?: number;
  }, sql?: SqlClient): Promise<TradePositionRecord | null>;
  rebaseRenewalEvidenceForAgent(ownerAddress: Address, agentId: string, generation: number, sql?: SqlClient): Promise<boolean>;
  clearSessionExpiringMarkers(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly beforeMs?: number;
  }, sql?: SqlClient): Promise<number>;
  clearCrashEvidenceForAgent(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<number>;
  incrementNoPrice(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null>;
  resetNoPrice(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null>;
  insertRun(input: TradeRunInput): Promise<TradeRunRecord>;
  listRuns(ownerAddress: Address, agentId: string, limit?: number): Promise<readonly TradeRunRecord[]>;
  /** Every retained run that committed a buy or a sell, or submitted one whose outcome is unknown, newest first: these survive the 200-row prune. */
  listExecutedRuns(ownerAddress: Address, agentId: string): Promise<readonly TradeRunRecord[]>;
  close(): Promise<void>;
}

function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

/** Executed runs are bounded by the positions a session can open; the read still caps them. */
const EXECUTED_RUN_LIMIT = 1_000;

function runExecuted(run: TradeRunRecord): boolean {
  return run.entries > 0 || run.exits > 0 || (run.events ?? []).some(isUnknownSubmissionEvent);
}

/** AGENTIC-RECEIPT-WAIT F2: a run holding an unknown buy or sell submission, in SQL; the same predicate as the memory store's runExecuted. */
const UNKNOWN_SUBMISSION_SQL = `(events @> '[{"stage":"buy","code":"unknown"}]'::jsonb or events @> '[{"stage":"sell","code":"unknown"}]'::jsonb)`;

function assertRunLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Trade run limit must be an integer in 1..200.");
  }
}

function hashOrNull(value: Hex | null | undefined): Hex | null {
  if (value === undefined || value === null) return null;
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error("Trade transaction hash must be 32-byte hex.");
  }
  return value;
}

function sameNullable(left: bigint | string | number | null, right: bigint | string | number | null): boolean {
  return left === null ? right === null : right !== null && left === right;
}

function quoteTimestampCanAdvance(previous: number | null, next: number): boolean {
  return previous === null || next > previous || previous > next;
}

function sameQuoteState(row: TradePositionRecord, expected: Pick<TradeEvidenceExpected, "lastQuoteWei" | "lastQuoteBalance" | "lastQuoteRoute" | "lastQuoteAtMs">): boolean {
  return sameNullable(row.lastQuoteWei, expected.lastQuoteWei)
    && sameNullable(row.lastQuoteBalance, expected.lastQuoteBalance)
    && sameNullable(row.lastQuoteRoute, expected.lastQuoteRoute)
    && sameNullable(row.lastQuoteAtMs, expected.lastQuoteAtMs);
}

function sameEvidence(row: TradePositionRecord, expected: TradeEvidenceExpected): boolean {
  return sameQuoteState(row, expected)
    && sameNullable(row.crashPendingSinceMs, expected.crashPendingSinceMs)
    && sameNullable(row.crashPendingKind, expected.crashPendingKind)
    && sameNullable(row.crashRefQuoteWei, expected.crashRefQuoteWei)
    && sameNullable(row.crashRefBalance, expected.crashRefBalance)
    && sameNullable(row.crashRefAtMs, expected.crashRefAtMs)
    && sameNullable(row.crashRefRoute, expected.crashRefRoute)
    && sameNullable(row.autoExitReason, expected.autoExitReason)
    && sameNullable(row.autoExitAtMs, expected.autoExitAtMs)
    && sameNullable(row.autoExitNote, expected.autoExitNote);
}

function applyEvidence(row: TradePositionRecord, action: TradeCrashEvidenceAction): TradePositionRecord {
  if (action.kind === "clear") {
    return { ...row, crashPendingSinceMs: null, crashPendingKind: null,
      crashRefQuoteWei: null, crashRefBalance: null, crashRefAtMs: null, crashRefRoute: null };
  }
  if (action.kind === "arm") {
    return { ...row, crashPendingSinceMs: action.pendingSinceMs, crashPendingKind: action.pendingKind,
      crashRefQuoteWei: action.reference.quoteWei, crashRefBalance: action.reference.balance,
      crashRefAtMs: action.reference.atMs, crashRefRoute: action.reference.routeKey };
  }
  return { ...row, crashPendingSinceMs: null, crashPendingKind: null,
    crashRefQuoteWei: null, crashRefBalance: null, crashRefAtMs: null, crashRefRoute: null,
    autoExitReason: action.reason, autoExitAtMs: action.atMs,
    autoExitNote: action.note === null ? null : sanitizeNote(action.note, MAX_NOTE_CHARS) };
}

export class MemoryTradePositionStore implements TradePositionStore {
  readonly #positions = new Map<string, TradePositionRecord>();
  readonly #runs = new Map<string, TradeRunRecord[]>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async open(input: OpenTradePositionInput): Promise<TradePositionRecord> {
    // AUDIT H2: a zero basis poisons every later PnL/exit decision.
    if (input.entryWei <= 0n) throw new Error("Trade position entryWei must be positive.");
    if (input.fillStatus === "verified" && (input.tokenAmount ?? 0n) <= 0n) {
      throw new Error("A verified trade fill must have a positive token amount.");
    }
    if (input.fillStatus === "unverified" && input.tokenAmount !== null) {
      throw new Error("An unverified trade fill must not claim a token amount.");
    }
    const ownershipKey = normalizeReceiptOwnershipKey(input.receiptOwnershipKey);
    validateV2PositionFacts(input.settlementAsset, input.requestedEntryAtomic, input.verifiedEntryAtomic, input.fillStatus, ownershipKey);
    if (this.#positions.has(input.positionId)) {
      throw new Error(`Trade position "${input.positionId}" already exists.`);
    }
    if (ownershipKey !== null && [...this.#positions.values()].some((row) => row.receiptOwnershipKey === ownershipKey)) {
      throw new Error("Receipt ownership is already claimed by another trade position.");
    }
    const row: TradePositionRecord = {
      ...input,
      entryTxHash: hashOrNull(input.entryTxHash),
      ownerAddress: ownerKey(input.ownerAddress),
      token: getAddress(input.token),
      route: structuredClone(input.route),
      venue: positionVenue(input.venue),
      status: "open",
      exitRequestedAt: null,
      orphanedAt: null,
      closedAt: null,
      exitWei: null,
      exitTxHash: null,
      soldTokenAmount: null,
      exitFillStatus: null,
      closeReason: null,
      closeNote: null,
      lastSellRefusal: null,
      lastSellRefusalAt: null,
      noPriceCount: 0,
      crashBasisVerified: input.crashBasisVerified === true
        && input.fillStatus === "verified" && input.tokenAmount !== null && input.tokenAmount > 0n
        && input.entryTxHash !== null && input.entryTxHash !== undefined,
      lastQuoteWei: null,
      lastQuoteBalance: null,
      lastQuoteRoute: null,
      lastQuoteAtMs: null,
      peakPnlBps: null,
      crashPendingSinceMs: null,
      crashPendingKind: null,
      crashRefQuoteWei: null,
      crashRefBalance: null,
      crashRefAtMs: null,
      crashRefRoute: null,
      autoExitReason: null,
      autoExitAtMs: null,
      autoExitNote: null,
       sessionGeneration: input.sessionGeneration ?? 0,
      ...(input.settlementAsset === undefined || input.settlementAsset === null ? {} : { settlementAsset: input.settlementAsset }),
      ...(input.settlementAsset === "USDT" && input.requestedEntryAtomic !== undefined ? { requestedEntryAtomic: input.requestedEntryAtomic } : {}),
      ...(input.settlementAsset === "USDT" && input.verifiedEntryAtomic !== undefined ? { verifiedEntryAtomic: input.verifiedEntryAtomic } : {}),
      ...(ownershipKey === null ? {} : { receiptOwnershipKey: ownershipKey }),
    };
    this.#positions.set(row.positionId, structuredClone(row));
    return structuredClone(row);
  }

  async get(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    const row = this.#owned(ownerAddress, agentId, positionId);
    return row === undefined ? null : structuredClone(row);
  }

  async list(ownerAddress: Address, agentId: string): Promise<readonly TradePositionRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#positions.values()]
      .filter((row) => row.ownerAddress === owner && row.agentId === agentId)
      .sort((left, right) => right.openedAt - left.openedAt || right.positionId.localeCompare(left.positionId))
      .map((row) => structuredClone(row));
  }

  async listOpen(ownerAddress: Address, agentId: string): Promise<readonly TradePositionRecord[]> {
    return (await this.list(ownerAddress, agentId)).filter((row) => row.status === "open");
  }

  async requestExit(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    return this.#mutateOpen(ownerAddress, agentId, positionId, (row) => ({
      ...row,
      exitRequestedAt: row.exitRequestedAt ?? this.#now(),
    }));
  }

  async markOrphaned(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    return this.#mutateOpen(ownerAddress, agentId, positionId, (row) => ({
      ...row,
      status: "orphaned",
      orphanedAt: this.#now(),
      crashPendingSinceMs: null,
      crashPendingKind: null,
      crashRefQuoteWei: null,
      crashRefBalance: null,
      crashRefAtMs: null,
      crashRefRoute: null,
      autoExitReason: null,
      autoExitAtMs: null,
      autoExitNote: null,
    }));
  }

  async closePosition(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly exitWei: bigint | null;
    readonly exitTxHash?: Hex | null;
    readonly soldTokenAmount?: bigint | null;
    readonly exitFillStatus?: TradeFillStatus;
    readonly exitReceiptOwnershipKey?: string;
    readonly reason?: TradeCloseReason;
    readonly note?: string | null;
  }): Promise<TradePositionRecord | null> {
    const ownershipKey = input.exitReceiptOwnershipKey === undefined ? null : normalizeReceiptOwnershipKey(input.exitReceiptOwnershipKey);
    if (ownershipKey !== null && [...this.#positions.values()].some((candidate) => candidate.exitReceiptOwnershipKey === ownershipKey && candidate.positionId !== input.positionId)) return null;
    return this.#mutateOpen(input.ownerAddress, input.agentId, input.positionId, (row) => ({
      ...row,
      status: "closed",
      closedAt: this.#now(),
      exitWei: input.exitWei,
      exitTxHash: hashOrNull(input.exitTxHash),
      soldTokenAmount: input.soldTokenAmount ?? null,
      exitFillStatus: input.exitFillStatus ?? "unverified",
      ...(ownershipKey === null ? {} : { exitReceiptOwnershipKey: ownershipKey }),
      closeReason: input.reason ?? null,
      closeNote: input.note === null || input.note === undefined ? null : sanitizeNote(input.note, MAX_NOTE_CHARS),
      lastSellRefusal: null,
      lastSellRefusalAt: null,
      crashPendingSinceMs: null,
      crashPendingKind: null,
      crashRefQuoteWei: null,
      crashRefBalance: null,
      crashRefAtMs: null,
      crashRefRoute: null,
      autoExitReason: null,
      autoExitAtMs: null,
      autoExitNote: null,
    }));
  }

  async recordSellRefusal(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly refusal: string | null;
  }): Promise<TradePositionRecord | null> {
    return this.#mutateOpen(input.ownerAddress, input.agentId, input.positionId, (row) => ({
      ...row,
      lastSellRefusal: input.refusal,
      lastSellRefusalAt: input.refusal === null ? null : this.#now(),
    }));
  }

  async setExitLlmContext(ownerAddress: Address, agentId: string, positionId: string, context: ExitLlmContextRecord): Promise<TradePositionRecord | null> {
    return this.#mutateOpen(ownerAddress, agentId, positionId, (row) => ({ ...row, exitLlmContext: context }));
  }

  async resolveFill(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly tokenAmount: bigint;
  }): Promise<TradePositionRecord | null> {
    if (input.tokenAmount <= 0n) return null;
    return this.#mutateOpen(input.ownerAddress, input.agentId, input.positionId, (row) => ({
      ...row,
      tokenAmount: input.tokenAmount,
      fillStatus: "verified",
    }));
  }

  async adoptVerifiedEntry(input: { ownerAddress: Address; agentId: string; positionId: string; verifiedEntryAtomic: bigint; receiptOwnershipKey?: string; tokenAmount?: bigint }): Promise<TradePositionRecord | null> {
    if (input.verifiedEntryAtomic <= 0n || input.verifiedEntryAtomic > MAX_UINT256) return null;
    const ownershipKey = normalizeReceiptOwnershipKey(input.receiptOwnershipKey);
    const row = this.#owned(input.ownerAddress, input.agentId, input.positionId);
    if (row === undefined || (row.status !== "open" && row.status !== "closed")) return null;
    if (row.settlementAsset !== "USDT" || row.verifiedEntryAtomic !== null && row.verifiedEntryAtomic !== undefined || ownershipKey === null) return row;
    const claimed = [...this.#positions.values()].find((candidate) => candidate.receiptOwnershipKey === ownershipKey);
    if (claimed !== undefined && claimed.positionId !== row.positionId) return row;
    const tokenAmount = input.tokenAmount ?? row.tokenAmount;
    if (tokenAmount === null || tokenAmount === undefined || tokenAmount <= 0n || tokenAmount > MAX_UINT256) return null;
    const next = { ...row, verifiedEntryAtomic: input.verifiedEntryAtomic, fillStatus: "verified" as const,
      tokenAmount, receiptOwnershipKey: ownershipKey };
    this.#positions.set(row.positionId, structuredClone(next));
    return structuredClone(next);
  }

  async adoptVerifiedExit(input: { ownerAddress: Address; agentId: string; positionId: string; exitWei: bigint; receiptOwnershipKey: string }): Promise<TradePositionRecord | null> {
    if (input.exitWei <= 0n || input.exitWei > MAX_UINT256) return null;
    const ownershipKey = normalizeReceiptOwnershipKey(input.receiptOwnershipKey);
    if (ownershipKey === null) return null;
    const row = this.#owned(input.ownerAddress, input.agentId, input.positionId);
    if (row === undefined || row.status !== "closed" ||
        !(row.exitWei === null || row.exitWei === 0n && row.closeReason === "balance-gone" && row.exitFillStatus !== "verified")) return null;
    if (row.exitReceiptOwnershipKey !== null && row.exitReceiptOwnershipKey !== undefined) return row;
    const claimed = [...this.#positions.values()].find((candidate) => candidate.exitReceiptOwnershipKey === ownershipKey);
    if (claimed !== undefined && claimed.positionId !== row.positionId) return row;
    const next = { ...row, exitWei: input.exitWei, exitFillStatus: "verified" as const, exitReceiptOwnershipKey: ownershipKey };
    this.#positions.set(row.positionId, structuredClone(next));
    return structuredClone(next);
  }

  async recordQuote(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly quoteOutWei: bigint;
    readonly balance?: bigint;
    readonly routeKey?: string;
    readonly pnlBps: bigint | null;
    readonly atMs: number;
    readonly sessionGeneration?: number;
    readonly expected?: Pick<TradeEvidenceExpected, "lastQuoteWei" | "lastQuoteBalance" | "lastQuoteRoute" | "lastQuoteAtMs" | "sessionGeneration">;
  }): Promise<TradePositionRecord | null> {
    const row = this.#owned(input.ownerAddress, input.agentId, input.positionId);
    if (row === undefined || row.status !== "open") return null;
    const expected = input.expected ?? {
      lastQuoteWei: row.lastQuoteWei,
      lastQuoteBalance: row.lastQuoteBalance,
      lastQuoteRoute: row.lastQuoteRoute,
      lastQuoteAtMs: row.lastQuoteAtMs,
      sessionGeneration: row.sessionGeneration ?? 0,
    };
    const storedGeneration = row.sessionGeneration ?? 0;
    const expectedGeneration = expected.sessionGeneration ?? storedGeneration;
    const writerGeneration = input.sessionGeneration ?? expectedGeneration;
    if (storedGeneration !== expectedGeneration || writerGeneration < expectedGeneration) return null;
    const rebased = writerGeneration > storedGeneration
      ? { ...row, sessionGeneration: writerGeneration, crashPendingSinceMs: null, crashPendingKind: null,
          crashRefQuoteWei: null, crashRefBalance: null, crashRefAtMs: null, crashRefRoute: null,
          ...(row.autoExitReason === "session-expiring" ? { autoExitReason: null, autoExitAtMs: null, autoExitNote: null } : {}) }
      : row;
    if (!sameQuoteState(rebased, expected) || !quoteTimestampCanAdvance(expected.lastQuoteAtMs, input.atMs)) return null;
    const next: TradePositionRecord = {
      ...rebased,
      lastQuoteWei: input.quoteOutWei,
      lastQuoteBalance: input.balance ?? null,
      lastQuoteRoute: input.routeKey ?? null,
      lastQuoteAtMs: input.atMs,
      peakPnlBps: input.pnlBps === null ? row.peakPnlBps
        : row.peakPnlBps === null || input.pnlBps > row.peakPnlBps ? input.pnlBps : row.peakPnlBps,
    };
    this.#positions.set(row.positionId, structuredClone(next));
    return structuredClone(next);
  }

  async recordCrashEvidence(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly expected: TradeEvidenceExpected;
    readonly action: TradeCrashEvidenceAction;
    readonly writerGeneration?: number;
  }): Promise<TradePositionRecord | null> {
    const row = this.#owned(input.ownerAddress, input.agentId, input.positionId);
    if (row === undefined || row.status !== "open") return null;
    const storedGeneration = row.sessionGeneration ?? 0;
    const expectedGeneration = input.expected.sessionGeneration ?? storedGeneration;
    const writerGeneration = input.writerGeneration ?? expectedGeneration;
    if (storedGeneration !== expectedGeneration || writerGeneration < expectedGeneration || !sameEvidence(row, input.expected)) return null;
    if (writerGeneration > storedGeneration) {
      this.#positions.set(row.positionId, structuredClone({ ...row, sessionGeneration: writerGeneration,
        crashPendingSinceMs: null, crashPendingKind: null, crashRefQuoteWei: null, crashRefBalance: null,
        crashRefAtMs: null, crashRefRoute: null,
        ...(row.autoExitReason === "session-expiring" ? { autoExitReason: null, autoExitAtMs: null, autoExitNote: null } : {}) }));
      return null;
    }
    const next = applyEvidence({ ...row, sessionGeneration: writerGeneration }, input.action);
    this.#positions.set(row.positionId, structuredClone(next));
    return structuredClone(next);
  }

  async clearCrashEvidenceForAgent(ownerAddress: Address, agentId: string): Promise<number> {
    const owner = ownerKey(ownerAddress);
    let cleared = 0;
    for (const [positionId, row] of this.#positions) {
      if (row.ownerAddress !== owner || row.agentId !== agentId || row.status !== "open") continue;
      this.#positions.set(positionId, structuredClone({
        ...row,
        crashPendingSinceMs: null, crashPendingKind: null,
        crashRefQuoteWei: null, crashRefBalance: null, crashRefAtMs: null, crashRefRoute: null,
        ...(row.autoExitReason === "crash-stop" ? { autoExitReason: null, autoExitAtMs: null, autoExitNote: null } : {}),
      }));
      cleared += 1;
    }
    return cleared;
  }

  async rebaseRenewalEvidenceForAgent(ownerAddress: Address, agentId: string, generation: number): Promise<boolean> {
    if (!Number.isSafeInteger(generation) || generation < 0) return false;
    const owner = ownerKey(ownerAddress);
    for (const [positionId, row] of this.#positions) {
      if (row.ownerAddress !== owner || row.agentId !== agentId || row.status !== "open") continue;
      this.#positions.set(positionId, structuredClone({ ...row, sessionGeneration: Math.max(row.sessionGeneration ?? 0, generation),
        crashPendingSinceMs: null, crashPendingKind: null, crashRefQuoteWei: null, crashRefBalance: null,
        crashRefAtMs: null, crashRefRoute: null,
        ...(row.autoExitReason === "session-expiring" ? { autoExitReason: null, autoExitAtMs: null, autoExitNote: null } : {}) }));
    }
    return true;
  }

  async clearSessionExpiringMarkers(input: { readonly ownerAddress: Address; readonly agentId: string; readonly beforeMs?: number }): Promise<number> {
    const owner = ownerKey(input.ownerAddress);
    let cleared = 0;
    for (const [positionId, row] of this.#positions) {
      if (row.ownerAddress !== owner || row.agentId !== input.agentId || row.status !== "open" || row.autoExitReason !== "session-expiring"
        || input.beforeMs !== undefined && (row.autoExitAtMs === null || row.autoExitAtMs >= input.beforeMs)) continue;
      this.#positions.set(positionId, structuredClone({ ...row, autoExitReason: null, autoExitAtMs: null, autoExitNote: null }));
      cleared += 1;
    }
    return cleared;
  }

  async incrementNoPrice(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    return this.#mutateOpen(ownerAddress, agentId, positionId, (row) => ({
      ...row,
      noPriceCount: row.noPriceCount + 1,
    }));
  }

  async resetNoPrice(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    return this.#mutateOpen(ownerAddress, agentId, positionId, (row) => ({
      ...row,
      noPriceCount: 0,
    }));
  }

  async insertRun(input: TradeRunInput): Promise<TradeRunRecord> {
    const row: TradeRunRecord = {
      ...input,
      events: normalizeTradeRunEvents(input.events),
      candidates: input.candidates ?? 0,
      refusals: input.refusals ?? 0,
      entries: input.entries ?? 0,
      exits: input.exits ?? 0,
      ownerAddress: ownerKey(input.ownerAddress),
      id: randomUUID(),
      createdAt: this.#now(),
    };
    const rows = this.#runs.get(input.agentId) ?? [];
    rows.push(structuredClone(row));
    rows.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    // The prune keeps the latest 200 cycles plus every cycle that executed: a fill's run
    // stays readable after a night of refusals has rolled the window past it.
    this.#runs.set(input.agentId, rows.filter((candidate, index) => index < 200 || runExecuted(candidate)));
    return structuredClone(row);
  }

  async listExecutedRuns(ownerAddress: Address, agentId: string): Promise<readonly TradeRunRecord[]> {
    const owner = ownerKey(ownerAddress);
    return (this.#runs.get(agentId) ?? [])
      .filter((row) => row.ownerAddress === owner && runExecuted(row))
      .slice(0, EXECUTED_RUN_LIMIT)
      .map((row) => structuredClone(row));
  }

  async listRuns(ownerAddress: Address, agentId: string, limit = 10): Promise<readonly TradeRunRecord[]> {
    assertRunLimit(limit);
    const owner = ownerKey(ownerAddress);
    return (this.#runs.get(agentId) ?? [])
      .filter((row) => row.ownerAddress === owner)
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async close(): Promise<void> {
    this.#positions.clear();
    this.#runs.clear();
  }

  #owned(ownerAddress: Address, agentId: string, positionId: string): TradePositionRecord | undefined {
    const row = this.#positions.get(positionId);
    return row?.ownerAddress === ownerKey(ownerAddress) && row.agentId === agentId ? row : undefined;
  }

  #mutateOpen(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    mutate: (row: TradePositionRecord) => TradePositionRecord,
  ): TradePositionRecord | null {
    const row = this.#owned(ownerAddress, agentId, positionId);
    if (row === undefined || row.status !== "open") return null;
    const next = mutate(row);
    this.#positions.set(positionId, structuredClone(next));
    return structuredClone(next);
  }
}

type PositionRow = {
  id: string; agent_id: string; owner_address: string; token: string; route: unknown; venue?: string | null;
  entry_wei: string; token_amount: string | null; fill_status: string; opened_at: Date;
  entry_tx_hash: string | null; status: string;
  exit_requested_at: Date | null; orphaned_at: Date | null; closed_at: Date | null;
  exit_wei: string | null; exit_tx_hash: string | null; sold_token_amount: string | null;
  exit_fill_status: string | null; close_reason: string | null; last_sell_refusal: string | null;
  last_sell_refusal_at: Date | null; no_price_count: number;
  crash_basis_verified: boolean; last_quote_wei: string | null; last_quote_balance: string | null;
  last_quote_route: string | null; last_quote_at: Date | null; peak_pnl_bps: string | null;
  crash_pending_since: Date | null; crash_pending_kind: string | null;
  crash_ref_quote_wei: string | null; crash_ref_balance: string | null; crash_ref_at: Date | null;
  crash_ref_route: string | null; auto_exit_reason: string | null; auto_exit_at: Date | null;
  auto_exit_note: string | null; close_note: string | null;
  session_generation?: number;
  settlement_asset?: string | null;
  requested_entry_atomic?: string | null;
  verified_entry_atomic?: string | null;
  receipt_ownership_key?: string | null;
  exit_receipt_ownership_key?: string | null;
  exit_llm_context?: unknown;
};
type RunRow = {
  id: string; agent_id: string; owner_address: string; dry_run: boolean;
  events?: unknown; reason: string; candidates: number; refusals: number; entries: number; exits: number; created_at: Date;
};

const POSITION_COLUMNS = "id, agent_id, owner_address, token, route, entry_wei, token_amount, fill_status, opened_at, entry_tx_hash, status, exit_requested_at, orphaned_at, closed_at, exit_wei, exit_tx_hash, sold_token_amount, exit_fill_status, close_reason, last_sell_refusal, last_sell_refusal_at, no_price_count, crash_basis_verified, last_quote_wei, last_quote_balance, last_quote_route, last_quote_at, peak_pnl_bps, crash_pending_since, crash_pending_kind, crash_ref_quote_wei, crash_ref_balance, crash_ref_at, crash_ref_route, auto_exit_reason, auto_exit_at, auto_exit_note, close_note, session_generation, venue, settlement_asset, requested_entry_atomic, verified_entry_atomic, receipt_ownership_key, exit_receipt_ownership_key, exit_llm_context";
const RUN_COLUMNS = "id, agent_id, owner_address, dry_run, reason, candidates, refusals, entries, exits, created_at, events";

const TRADE_POSITIONS_DDL = `
  create table if not exists trade_positions (
    id text primary key,
    agent_id text not null,
    owner_address text not null,
    token text not null,
    route jsonb not null,
    entry_wei numeric(78,0) not null,
    token_amount numeric(78,0),
    fill_status text not null default 'verified' check (fill_status in ('verified', 'unverified')),
    opened_at timestamptz not null,
    entry_tx_hash text,
    status text not null check (status in ('open', 'closed', 'orphaned')),
    exit_requested_at timestamptz,
    orphaned_at timestamptz,
    closed_at timestamptz,
    exit_wei numeric(78,0),
    exit_tx_hash text,
    sold_token_amount numeric(78,0),
    exit_fill_status text check (exit_fill_status is null or exit_fill_status in ('verified', 'unverified')),
    close_reason text,
    last_sell_refusal text,
    last_sell_refusal_at timestamptz,
    no_price_count integer not null default 0,
    crash_basis_verified boolean not null default false,
    last_quote_wei numeric(78,0),
    last_quote_balance numeric(78,0),
    last_quote_route text,
    last_quote_at timestamptz,
    peak_pnl_bps numeric(78,0),
    crash_pending_since timestamptz,
    crash_pending_kind text,
    crash_ref_quote_wei numeric(78,0),
    crash_ref_balance numeric(78,0),
    crash_ref_at timestamptz,
    crash_ref_route text,
    auto_exit_reason text,
    auto_exit_at timestamptz,
    auto_exit_note text,
    close_note text,
    session_generation integer not null default 0,
    venue text,
    settlement_asset text check (settlement_asset is null or settlement_asset = 'USDT'),
    requested_entry_atomic numeric(78,0),
    verified_entry_atomic numeric(78,0),
    receipt_ownership_key text,
    exit_receipt_ownership_key text,
    exit_llm_context jsonb
  )
`;
const TRADE_RUNS_DDL = `
  create table if not exists trade_runs (
    id text primary key,
    agent_id text not null,
    owner_address text not null,
    dry_run boolean not null,
    reason text not null,
    candidates integer not null default 0,
    refusals integer not null default 0,
    entries integer not null default 0,
    exits integer not null default 0,
    created_at timestamptz not null
  )
`;
const TRADE_POSITION_INDEX_DDL = `create index if not exists trade_positions_agent_idx on trade_positions (owner_address, agent_id, opened_at desc)`;
const TRADE_RECEIPT_OWNERSHIP_INDEX_DDL = `create unique index if not exists trade_positions_receipt_ownership_idx on trade_positions (receipt_ownership_key) where receipt_ownership_key is not null`;
const TRADE_EXIT_RECEIPT_OWNERSHIP_INDEX_DDL = `create unique index if not exists trade_positions_exit_receipt_ownership_idx on trade_positions (exit_receipt_ownership_key) where exit_receipt_ownership_key is not null`;
const TRADE_RUN_INDEX_DDL = `create index if not exists trade_runs_agent_idx on trade_runs (owner_address, agent_id, created_at desc, id desc)`;

export class PostgresTradePositionStore implements TradePositionStore {
  readonly #sql: SqlClient;
  readonly #now: Clock;
  private constructor(sql: SqlClient, now: Clock) { this.#sql = sql; this.#now = now; }

  static async create(sql: SqlClient, now: Clock = Date.now): Promise<PostgresTradePositionStore> {
    await sql.transaction(async (tx) => {
      await tx.query(TRADE_POSITIONS_DDL);
      await tx.query(TRADE_RUNS_DDL);
      // TRADING-AGENT item 1 follow-up: existing durable tables gain honest structural counts.
      await tx.query(`alter table trade_runs add column if not exists events jsonb not null default '[]'::jsonb`);
      await tx.query(`alter table trade_runs add column if not exists candidates integer not null default 0`);
      await tx.query(`alter table trade_runs add column if not exists refusals integer not null default 0`);
      await tx.query(`alter table trade_runs add column if not exists entries integer not null default 0`);
      await tx.query(`alter table trade_runs add column if not exists exits integer not null default 0`);
      // AUDIT H2/L7: additive columns retain legacy rows while making uncertainty durable.
      await tx.query(`alter table trade_positions alter column token_amount drop not null`);
      await tx.query(`alter table trade_positions add column if not exists fill_status text not null default 'verified'`);
      await tx.query(`alter table trade_positions add column if not exists close_reason text`);
      await tx.query(`alter table trade_positions add column if not exists last_sell_refusal_at timestamptz`);
      await tx.query(`alter table trade_positions add column if not exists entry_tx_hash text`);
      await tx.query(`alter table trade_positions add column if not exists exit_tx_hash text`);
      await tx.query(`alter table trade_positions add column if not exists sold_token_amount numeric(78,0)`);
      await tx.query(`alter table trade_positions add column if not exists exit_fill_status text`);
      await tx.query(`alter table trade_positions add column if not exists crash_basis_verified boolean not null default false`);
      await tx.query(`alter table trade_positions add column if not exists last_quote_wei numeric(78,0)`);
      await tx.query(`alter table trade_positions add column if not exists last_quote_balance numeric(78,0)`);
      await tx.query(`alter table trade_positions add column if not exists last_quote_route text`);
      await tx.query(`alter table trade_positions add column if not exists last_quote_at timestamptz`);
      await tx.query(`alter table trade_positions add column if not exists peak_pnl_bps numeric(78,0)`);
      await tx.query(`alter table trade_positions add column if not exists crash_pending_since timestamptz`);
      await tx.query(`alter table trade_positions add column if not exists crash_pending_kind text`);
      await tx.query(`alter table trade_positions add column if not exists crash_ref_quote_wei numeric(78,0)`);
      await tx.query(`alter table trade_positions add column if not exists crash_ref_balance numeric(78,0)`);
      await tx.query(`alter table trade_positions add column if not exists crash_ref_at timestamptz`);
      await tx.query(`alter table trade_positions add column if not exists crash_ref_route text`);
      await tx.query(`alter table trade_positions add column if not exists auto_exit_reason text`);
      await tx.query(`alter table trade_positions add column if not exists auto_exit_at timestamptz`);
      await tx.query(`alter table trade_positions add column if not exists auto_exit_note text`);
      await tx.query(`alter table trade_positions add column if not exists close_note text`);
      await tx.query(`alter table trade_positions add column if not exists session_generation integer not null default 0`);
      await tx.query(`alter table trade_positions add column if not exists venue text`);
      await tx.query(`alter table trade_positions add column if not exists settlement_asset text`);
      await tx.query(`alter table trade_positions add column if not exists requested_entry_atomic numeric(78,0)`);
      await tx.query(`alter table trade_positions add column if not exists verified_entry_atomic numeric(78,0)`);
      await tx.query(`alter table trade_positions add column if not exists receipt_ownership_key text`);
      await tx.query(`alter table trade_positions add column if not exists exit_receipt_ownership_key text`);
      await tx.query(`alter table trade_positions add column if not exists exit_llm_context jsonb`);
      // R3.6/R4.4: the name is deliberately scoped to this table, so another
      // store's constraint cannot satisfy the migration check.
      await tx.query(`select pg_advisory_xact_lock(hashtext('trade_positions'))`);
      await tx.query(`alter table trade_positions drop constraint if exists trade_positions_close_reason_check`);
      await tx.query(`alter table trade_positions drop constraint if exists trade_positions_close_reason_v2_check`);
      await tx.query(`alter table trade_positions drop constraint if exists trade_positions_close_reason_v3_check`);
      const constraint = await tx.query(
        `select 1 from pg_constraint c where c.conname = 'trade_positions_close_reason_v4_check'
         and c.conrelid = 'trade_positions'::regclass limit 1`,
      );
      if (constraint.rows.length === 0) {
        await tx.query(`alter table trade_positions add constraint trade_positions_close_reason_v4_check
          check (close_reason is null or close_reason in ('owner-request','stop-loss','take-profit','max-hold','llm','balance-gone','crash-stop','session-expiring','trailing-stop','stale-exit'))`);
      }
      await tx.query(TRADE_POSITION_INDEX_DDL);
      await tx.query(TRADE_RECEIPT_OWNERSHIP_INDEX_DDL);
      await tx.query(TRADE_EXIT_RECEIPT_OWNERSHIP_INDEX_DDL);
      await tx.query(TRADE_RUN_INDEX_DDL);
    });
    return new PostgresTradePositionStore(sql, now);
  }

  async open(input: OpenTradePositionInput): Promise<TradePositionRecord> {
    if (input.entryWei <= 0n) throw new Error("Trade position entryWei must be positive.");
    if (input.fillStatus === "verified" && (input.tokenAmount ?? 0n) <= 0n) {
      throw new Error("A verified trade fill must have a positive token amount.");
    }
    if (input.fillStatus === "unverified" && input.tokenAmount !== null) {
      throw new Error("An unverified trade fill must not claim a token amount.");
    }
    const ownershipKey = normalizeReceiptOwnershipKey(input.receiptOwnershipKey);
    validateV2PositionFacts(input.settlementAsset, input.requestedEntryAtomic, input.verifiedEntryAtomic, input.fillStatus, ownershipKey);
    const result = await this.#sql.query<PositionRow>(
      `/* tradePositions.open */ insert into trade_positions (${POSITION_COLUMNS})
       values ($1,$2,$3,$4,$5::jsonb,$6::numeric,$7::numeric,$8,$9,$10,'open',
          null,null,null,null,null,null,null,null,null,null,0,$11,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,$12,$13,$14,$15,$16,$17,null,null)
       on conflict (id) do nothing returning ${POSITION_COLUMNS}`,
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), getAddress(input.token),
        encodeJsonbParam(input.route), input.entryWei.toString(10), input.tokenAmount?.toString(10) ?? null,
        input.fillStatus, new Date(input.openedAt), hashOrNull(input.entryTxHash),
         input.crashBasisVerified === true && input.fillStatus === "verified" && input.tokenAmount !== null
           && input.tokenAmount > 0n && input.entryTxHash !== null && input.entryTxHash !== undefined,
         input.sessionGeneration ?? 0, positionVenue(input.venue), input.settlementAsset ?? null,
         input.requestedEntryAtomic?.toString(10) ?? null, input.verifiedEntryAtomic?.toString(10) ?? null, ownershipKey],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Trade position "${input.positionId}" already exists.`);
    return rowToPosition(row);
  }

  async get(ownerAddress: Address, agentId: string, positionId: string, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    const result = await sql.query<PositionRow>(
      `/* tradePositions.get */ select ${POSITION_COLUMNS} from trade_positions
       where id = $1 and agent_id = $2 and owner_address = $3`,
      [positionId, agentId, ownerKey(ownerAddress)],
    );
    return result.rows[0] === undefined ? null : rowToPosition(result.rows[0]);
  }

  async list(ownerAddress: Address, agentId: string): Promise<readonly TradePositionRecord[]> {
    const result = await this.#sql.query<PositionRow>(
      `/* tradePositions.list */ select ${POSITION_COLUMNS} from trade_positions
       where owner_address = $1 and agent_id = $2 order by opened_at desc, id desc`,
      [ownerKey(ownerAddress), agentId],
    );
    return result.rows.map(rowToPosition);
  }

  async listOpen(ownerAddress: Address, agentId: string, sql: SqlClient = this.#sql): Promise<readonly TradePositionRecord[]> {
    const result = await sql.query<PositionRow>(
      `/* tradePositions.listOpen */ select ${POSITION_COLUMNS} from trade_positions
       where owner_address = $1 and agent_id = $2 and status = 'open'
       order by opened_at asc, id asc`,
      [ownerKey(ownerAddress), agentId],
    );
    return result.rows.map(rowToPosition);
  }

  async requestExit(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.requestExit",
      "exit_requested_at = coalesce(exit_requested_at, $4)",
      [positionId, agentId, ownerKey(ownerAddress), new Date(this.#now())]);
  }

  async markOrphaned(ownerAddress: Address, agentId: string, positionId: string, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.orphan", "status = 'orphaned', orphaned_at = $4, crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null, crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null, auto_exit_reason = null, auto_exit_at = null, auto_exit_note = null",
      [positionId, agentId, ownerKey(ownerAddress), new Date(this.#now())], sql);
  }

  async closePosition(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly exitWei: bigint | null; readonly exitTxHash?: Hex | null; readonly soldTokenAmount?: bigint | null; readonly exitFillStatus?: TradeFillStatus; readonly exitReceiptOwnershipKey?: string; readonly reason?: TradeCloseReason; readonly note?: string | null }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    const ownershipKey = input.exitReceiptOwnershipKey === undefined ? null : normalizeReceiptOwnershipKey(input.exitReceiptOwnershipKey);
    return this.#update("tradePositions.close",
      "status = 'closed', closed_at = $4, exit_wei = $5::numeric, close_reason = $6, exit_tx_hash = $7, sold_token_amount = $8::numeric, exit_fill_status = $9, close_note = $10, exit_receipt_ownership_key = $11, last_sell_refusal = null, last_sell_refusal_at = null, crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null, crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null, auto_exit_reason = null, auto_exit_at = null, auto_exit_note = null",
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), new Date(this.#now()), input.exitWei?.toString(10) ?? null, input.reason ?? null,
        hashOrNull(input.exitTxHash), input.soldTokenAmount?.toString(10) ?? null, input.exitFillStatus ?? "unverified", input.note === null || input.note === undefined ? null : sanitizeNote(input.note, MAX_NOTE_CHARS), ownershipKey], sql);
  }

  async recordSellRefusal(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly refusal: string | null }): Promise<TradePositionRecord | null> {
    // MEASURED 2026-09-20 (`agent-error` cycle on tradfi-agent-01): without the
    // cast PostgreSQL types the CASE as text and refuses the timestamptz column.
    return this.#update("tradePositions.sellRefusal", "last_sell_refusal = $4, last_sell_refusal_at = case when $4::text is null then null else $5::timestamptz end",
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.refusal, new Date(this.#now())]);
  }

  async setExitLlmContext(ownerAddress: Address, agentId: string, positionId: string, context: ExitLlmContextRecord, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.exitLlmContext", "exit_llm_context = $4::jsonb",
      [positionId, agentId, ownerKey(ownerAddress), JSON.stringify(context)], sql);
  }

  async resolveFill(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly tokenAmount: bigint }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    if (input.tokenAmount <= 0n) return null;
    return this.#update("tradePositions.resolveFill", "token_amount = $4::numeric, fill_status = 'verified'",
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.tokenAmount.toString(10)], sql);
  }

  async adoptVerifiedEntry(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly verifiedEntryAtomic: bigint; readonly receiptOwnershipKey?: string; readonly tokenAmount?: bigint }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    if (input.verifiedEntryAtomic <= 0n || input.verifiedEntryAtomic > MAX_UINT256) return null;
    if (input.tokenAmount !== undefined && (input.tokenAmount <= 0n || input.tokenAmount > MAX_UINT256)) return null;
    const existing = (await this.get(input.ownerAddress, input.agentId, input.positionId, sql))?.tokenAmount;
    if ((input.tokenAmount ?? existing) === null || (input.tokenAmount ?? existing) === undefined || (input.tokenAmount ?? existing)! <= 0n) return null;
    const ownershipKey = normalizeReceiptOwnershipKey(input.receiptOwnershipKey);
    if (ownershipKey === null) return null;
    const claimed = await sql.query<{ readonly id: string }>(`/* tradePositions.receiptOwnership */ select id from trade_positions where receipt_ownership_key = $1`, [ownershipKey]);
    if (claimed.rows[0] !== undefined && claimed.rows[0].id !== input.positionId) return null;
    const result = await sql.query<PositionRow>(`/* tradePositions.adoptVerifiedEntry */ update trade_positions set verified_entry_atomic = $4::numeric, token_amount = coalesce($5::numeric, token_amount), fill_status = 'verified', receipt_ownership_key = $6
      where id=$1 and agent_id=$2 and owner_address=$3 and status in ('open','closed') and settlement_asset='USDT' and verified_entry_atomic is null and receipt_ownership_key is null
      returning ${POSITION_COLUMNS}`,
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.verifiedEntryAtomic.toString(10), input.tokenAmount?.toString(10) ?? existing?.toString(10) ?? null, ownershipKey]);
    return result.rows[0] === undefined ? this.get(input.ownerAddress, input.agentId, input.positionId, sql) : rowToPosition(result.rows[0]);
  }

  async adoptVerifiedExit(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly exitWei: bigint; readonly receiptOwnershipKey: string }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    if (input.exitWei <= 0n || input.exitWei > MAX_UINT256) return null;
    const ownershipKey = normalizeReceiptOwnershipKey(input.receiptOwnershipKey);
    if (ownershipKey === null) return null;
    const claimed = await sql.query<{ readonly id: string }>(`/* tradePositions.exitReceiptOwnership */ select id from trade_positions where exit_receipt_ownership_key = $1`, [ownershipKey]);
    if (claimed.rows[0] !== undefined && claimed.rows[0].id !== input.positionId) return null;
    const result = await sql.query<PositionRow>(`/* tradePositions.adoptVerifiedExit */ update trade_positions set exit_wei = $4::numeric, exit_fill_status = 'verified', exit_receipt_ownership_key = $5
      where id=$1 and agent_id=$2 and owner_address=$3 and status='closed'
        and (exit_wei is null or (close_reason='balance-gone' and exit_wei=0 and exit_fill_status is distinct from 'verified'))
        and exit_receipt_ownership_key is null
      returning ${POSITION_COLUMNS}`,
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.exitWei.toString(10), ownershipKey]);
    return result.rows[0] === undefined ? this.get(input.ownerAddress, input.agentId, input.positionId, sql) : rowToPosition(result.rows[0]);
  }

  async recordQuote(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly quoteOutWei: bigint;
    readonly balance?: bigint;
    readonly routeKey?: string;
    readonly pnlBps: bigint | null;
    readonly atMs: number;
    readonly sessionGeneration?: number;
    readonly expected?: Pick<TradeEvidenceExpected, "lastQuoteWei" | "lastQuoteBalance" | "lastQuoteRoute" | "lastQuoteAtMs" | "sessionGeneration">;
  }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    const expected = input.expected;
    const resolved = expected ?? await this.get(input.ownerAddress, input.agentId, input.positionId, sql);
    if (resolved === null || resolved === undefined) return null;
    const state = expected ?? {
      lastQuoteWei: resolved.lastQuoteWei,
      lastQuoteBalance: resolved.lastQuoteBalance,
      lastQuoteRoute: resolved.lastQuoteRoute,
      lastQuoteAtMs: resolved.lastQuoteAtMs,
      sessionGeneration: resolved.sessionGeneration ?? 0,
    };
    const expectedGeneration = state.sessionGeneration ?? resolved.sessionGeneration ?? 0;
    const writerGeneration = input.sessionGeneration ?? expectedGeneration;
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || !Number.isSafeInteger(writerGeneration) || writerGeneration < expectedGeneration) return null;
    if (!quoteTimestampCanAdvance(state.lastQuoteAtMs, input.atMs)) return null;
    const result = await sql.query<PositionRow>(
      `/* tradePositions.recordQuote */ update trade_positions set
         last_quote_wei = $4::numeric, last_quote_balance = $5::numeric, last_quote_route = $6,
         last_quote_at = $7, peak_pnl_bps = case when $8::numeric is null then peak_pnl_bps
           when peak_pnl_bps is null or peak_pnl_bps < $8::numeric then $8::numeric else peak_pnl_bps end,
         session_generation = greatest(session_generation, $13::integer),
         crash_pending_since = case when $13::integer > session_generation then null else crash_pending_since end,
         crash_pending_kind = case when $13::integer > session_generation then null else crash_pending_kind end,
         crash_ref_quote_wei = case when $13::integer > session_generation then null else crash_ref_quote_wei end,
         crash_ref_balance = case when $13::integer > session_generation then null else crash_ref_balance end,
         crash_ref_at = case when $13::integer > session_generation then null else crash_ref_at end,
         crash_ref_route = case when $13::integer > session_generation then null else crash_ref_route end,
         auto_exit_reason = case when $13::integer > session_generation and auto_exit_reason = 'session-expiring' then null else auto_exit_reason end,
         auto_exit_at = case when $13::integer > session_generation and auto_exit_reason = 'session-expiring' then null else auto_exit_at end,
         auto_exit_note = case when $13::integer > session_generation and auto_exit_reason = 'session-expiring' then null else auto_exit_note end
       where id = $1 and agent_id = $2 and owner_address = $3 and status = 'open'
         and last_quote_wei is not distinct from $9::numeric
         and last_quote_balance is not distinct from $10::numeric
         and last_quote_route is not distinct from $11::text
         and last_quote_at is not distinct from $12::timestamptz
         and ($12::timestamptz is null or $7::timestamptz > $12::timestamptz or $12::timestamptz > $7::timestamptz)
         and session_generation = $14::integer
       returning ${POSITION_COLUMNS}`,
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.quoteOutWei.toString(10),
        input.balance?.toString(10) ?? null, input.routeKey ?? null, new Date(input.atMs),
        input.pnlBps?.toString(10) ?? null, state.lastQuoteWei?.toString(10) ?? null,
        state.lastQuoteBalance?.toString(10) ?? null, state.lastQuoteRoute, state.lastQuoteAtMs === null ? null : new Date(state.lastQuoteAtMs), writerGeneration, expectedGeneration],
    );
    return result.rows[0] === undefined ? null : rowToPosition(result.rows[0]);
  }

  async recordCrashEvidence(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly expected: TradeEvidenceExpected;
    readonly action: TradeCrashEvidenceAction;
    readonly writerGeneration?: number;
  }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    const expected = input.expected;
    const expectedGeneration = expected.sessionGeneration ?? 0;
    const writerGeneration = input.writerGeneration ?? expectedGeneration;
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || !Number.isSafeInteger(writerGeneration) || writerGeneration < expectedGeneration) return null;
    let assignment: string;
    let actionParams: readonly unknown[];
    if (input.action.kind === "arm") {
      assignment = "crash_pending_since = $17, crash_pending_kind = $18, crash_ref_quote_wei = $19::numeric, crash_ref_balance = $20::numeric, crash_ref_at = $21, crash_ref_route = $22";
      actionParams = [new Date(input.action.pendingSinceMs), input.action.pendingKind,
        input.action.reference.quoteWei.toString(10), input.action.reference.balance.toString(10),
        new Date(input.action.reference.atMs), input.action.reference.routeKey];
    } else if (input.action.kind === "marker") {
      assignment = "crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null, crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null, auto_exit_reason = $17, auto_exit_at = $18, auto_exit_note = $19";
      actionParams = [input.action.reason, new Date(input.action.atMs), input.action.note === null ? null : sanitizeNote(input.action.note, MAX_NOTE_CHARS)];
    } else {
      assignment = "crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null, crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null";
      actionParams = [];
    }
    const rebasing = writerGeneration > expectedGeneration;
    if (rebasing) {
      assignment = "crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null, crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null, auto_exit_reason = case when auto_exit_reason = 'session-expiring' then null else auto_exit_reason end, auto_exit_at = case when auto_exit_reason = 'session-expiring' then null else auto_exit_at end, auto_exit_note = case when auto_exit_reason = 'session-expiring' then null else auto_exit_note end, session_generation = $17";
      actionParams = [];
    }
    const generationParam = 17 + actionParams.length;
    const expectedGenerationParam = generationParam + 1;
    if (!rebasing) assignment = `${assignment}, session_generation = $${generationParam}`;
    const result = await sql.query<PositionRow>(
      `/* tradePositions.recordEvidence */ update trade_positions set ${assignment}
       where id = $1 and agent_id = $2 and owner_address = $3 and status = 'open'
         and last_quote_wei is not distinct from $4::numeric
         and last_quote_balance is not distinct from $5::numeric
         and last_quote_route is not distinct from $6::text
         and last_quote_at is not distinct from $7::timestamptz
         and crash_pending_since is not distinct from $8::timestamptz
         and crash_pending_kind is not distinct from $9::text
         and crash_ref_quote_wei is not distinct from $10::numeric
         and crash_ref_balance is not distinct from $11::numeric
         and crash_ref_at is not distinct from $12::timestamptz
         and crash_ref_route is not distinct from $13::text
         and auto_exit_reason is not distinct from $14::text
         and auto_exit_at is not distinct from $15::timestamptz
         and auto_exit_note is not distinct from $16::text
         and session_generation = $${expectedGenerationParam}::integer
       returning ${POSITION_COLUMNS}`,
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), expected.lastQuoteWei?.toString(10) ?? null,
        expected.lastQuoteBalance?.toString(10) ?? null, expected.lastQuoteRoute,
        expected.lastQuoteAtMs === null ? null : new Date(expected.lastQuoteAtMs),
        expected.crashPendingSinceMs === null ? null : new Date(expected.crashPendingSinceMs), expected.crashPendingKind,
        expected.crashRefQuoteWei?.toString(10) ?? null, expected.crashRefBalance?.toString(10) ?? null,
        expected.crashRefAtMs === null ? null : new Date(expected.crashRefAtMs), expected.crashRefRoute,
        expected.autoExitReason, expected.autoExitAtMs === null ? null : new Date(expected.autoExitAtMs), expected.autoExitNote,
        ...actionParams, writerGeneration, expectedGeneration],
    );
    return rebasing || result.rows[0] === undefined ? null : rowToPosition(result.rows[0]);
  }

  async clearCrashEvidenceForAgent(ownerAddress: Address, agentId: string, sql: SqlClient = this.#sql): Promise<number> {
    const result = await sql.query<{ readonly id: string }>(
      `/* tradePositions.clearCrashEvidence */ update trade_positions set
         crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null,
         crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null,
         auto_exit_reason = case when auto_exit_reason = 'crash-stop' then null else auto_exit_reason end,
         auto_exit_at = case when auto_exit_reason = 'crash-stop' then null else auto_exit_at end,
         auto_exit_note = case when auto_exit_reason = 'crash-stop' then null else auto_exit_note end
       where owner_address = $1 and agent_id = $2 and status = 'open' returning id`,
      [ownerKey(ownerAddress), agentId],
    );
    return result.rows.length;
  }

  async rebaseRenewalEvidenceForAgent(ownerAddress: Address, agentId: string, generation: number, sql: SqlClient = this.#sql): Promise<boolean> {
    if (!Number.isSafeInteger(generation) || generation < 0) return false;
    await sql.query(
      `/* tradePositions.rebaseRenewalEvidence */ update trade_positions set
         session_generation = greatest(session_generation, $3::integer),
         crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null,
         crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null,
         auto_exit_reason = case when auto_exit_reason = 'session-expiring' then null else auto_exit_reason end,
         auto_exit_at = case when auto_exit_reason = 'session-expiring' then null else auto_exit_at end,
         auto_exit_note = case when auto_exit_reason = 'session-expiring' then null else auto_exit_note end
       where owner_address = $1 and agent_id = $2 and status = 'open'`,
      [ownerKey(ownerAddress), agentId, generation],
    );
    return true;
  }

  async clearSessionExpiringMarkers(input: { readonly ownerAddress: Address; readonly agentId: string; readonly beforeMs?: number }, sql: SqlClient = this.#sql): Promise<number> {
    const result = await sql.query<{ readonly id: string }>(
      `/* tradePositions.clearSessionExpiringMarkers */ update trade_positions set
         auto_exit_reason = null, auto_exit_at = null, auto_exit_note = null
       where owner_address = $1 and agent_id = $2 and status = 'open' and auto_exit_reason = 'session-expiring'
         and ($3::timestamptz is null or auto_exit_at < $3::timestamptz)
       returning id`,
      [ownerKey(input.ownerAddress), input.agentId, input.beforeMs === undefined ? null : new Date(input.beforeMs)],
    );
    return result.rows.length;
  }

  async incrementNoPrice(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.noPrice", "no_price_count = no_price_count + 1",
      [positionId, agentId, ownerKey(ownerAddress)]);
  }

  async resetNoPrice(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.resetNoPrice", "no_price_count = 0",
      [positionId, agentId, ownerKey(ownerAddress)]);
  }

  async insertRun(input: TradeRunInput): Promise<TradeRunRecord> {
    const row: TradeRunRecord = { ...input, events: normalizeTradeRunEvents(input.events), candidates: input.candidates ?? 0, refusals: input.refusals ?? 0,
      entries: input.entries ?? 0, exits: input.exits ?? 0,
      ownerAddress: ownerKey(input.ownerAddress), id: randomUUID(), createdAt: this.#now() };
    // TRADING-AGENT R9/R3.9: insertion and deterministic 200-row pruning are atomic.
    await this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* tradeRuns.insert */ insert into trade_runs
          (id, agent_id, owner_address, dry_run, reason, created_at, candidates, refusals, entries, exits, events)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [row.id, row.agentId, row.ownerAddress, row.dryRun, row.reason, new Date(row.createdAt),
          row.candidates, row.refusals, row.entries, row.exits, encodeJsonbParam(row.events ?? [])],
      );
      await tx.query(
        `/* tradeRuns.prune */ delete from trade_runs where agent_id = $1
         and entries = 0 and exits = 0 and not ${UNKNOWN_SUBMISSION_SQL}
         and id not in (select id from trade_runs where agent_id = $1
                        order by created_at desc, id desc limit 200)`,
        [row.agentId],
      );
    });
    return row;
  }

  async listRuns(ownerAddress: Address, agentId: string, limit = 10): Promise<readonly TradeRunRecord[]> {
    assertRunLimit(limit);
    const result = await this.#sql.query<RunRow>(
      `/* tradeRuns.list */ select ${RUN_COLUMNS} from trade_runs
       where owner_address = $1 and agent_id = $2 order by created_at desc, id desc limit $3`,
      [ownerKey(ownerAddress), agentId, limit],
    );
    return result.rows.map(rowToRun);
  }

  async listExecutedRuns(ownerAddress: Address, agentId: string): Promise<readonly TradeRunRecord[]> {
    const result = await this.#sql.query<RunRow>(
      `/* tradeRuns.listExecuted */ select ${RUN_COLUMNS} from trade_runs
       where owner_address = $1 and agent_id = $2 and (entries > 0 or exits > 0 or ${UNKNOWN_SUBMISSION_SQL})
       order by created_at desc, id desc limit $3`,
      [ownerKey(ownerAddress), agentId, EXECUTED_RUN_LIMIT],
    );
    return result.rows.map(rowToRun);
  }

  async close(): Promise<void> { await this.#sql.close(); }

  async #update(tag: string, assignment: string, params: readonly unknown[], sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    const result = await sql.query<PositionRow>(
      `/* ${tag} */ update trade_positions set ${assignment}
       where id = $1 and agent_id = $2 and owner_address = $3 and status = 'open'
       returning ${POSITION_COLUMNS}`,
      params,
    );
    return result.rows[0] === undefined ? null : rowToPosition(result.rows[0]);
  }
}

function positionStatus(value: string): TradePositionStatus {
  if (value === "open" || value === "closed" || value === "orphaned") return value;
  throw new Error("Stored trade position status is invalid.");
}
function positionVenue(value: string | null | undefined): TradeVenueId | null {
  if (value === undefined || value === null) return null;
  if (value === "pancake_v2" || value === "pancake_v3" || value === "uniswap_v3") return value;
  throw new Error("Stored trade position venue is invalid.");
}
function positionSettlementAsset(value: string | null | undefined): "USDT" | null {
  if (value === undefined || value === null) return null;
  if (value === "USDT") return "USDT";
  throw new Error("Stored trade position settlement asset is invalid.");
}
function epoch(value: Date | null | undefined): number | null { return value === null || value === undefined ? null : value.getTime(); }
function rowToPosition(row: PositionRow): TradePositionRecord {
  const storedSettlement = positionSettlementAsset(row.settlement_asset);
  const storedRequested = row.requested_entry_atomic === null || row.requested_entry_atomic === undefined ? undefined : BigInt(row.requested_entry_atomic);
  const storedVerified = row.verified_entry_atomic === null || row.verified_entry_atomic === undefined ? undefined : BigInt(row.verified_entry_atomic);
  const storedOwnership = normalizeReceiptOwnershipKey(row.receipt_ownership_key);
  const storedExitOwnership = normalizeReceiptOwnershipKey(row.exit_receipt_ownership_key);
  validateV2PositionFacts(storedSettlement, storedRequested, storedVerified, fillStatus(row.fill_status), storedOwnership);
  return {
    positionId: row.id, agentId: row.agent_id, ownerAddress: ownerKey(getAddress(row.owner_address)),
    token: getAddress(row.token), route: decodeJsonb(row.route) as TradeRoute, venue: positionVenue(row.venue),
    entryWei: BigInt(row.entry_wei), tokenAmount: row.token_amount === null ? null : BigInt(row.token_amount),
    fillStatus: fillStatus(row.fill_status), openedAt: row.opened_at.getTime(), entryTxHash: hashOrNull(row.entry_tx_hash as Hex | null),
    status: positionStatus(row.status), exitRequestedAt: epoch(row.exit_requested_at), orphanedAt: epoch(row.orphaned_at),
    closedAt: epoch(row.closed_at), exitWei: row.exit_wei === null ? null : BigInt(row.exit_wei),
    exitTxHash: hashOrNull(row.exit_tx_hash as Hex | null), soldTokenAmount: row.sold_token_amount === null ? null : BigInt(row.sold_token_amount),
    exitFillStatus: row.exit_fill_status === null ? null : fillStatus(row.exit_fill_status),
    closeReason: closeReason(row.close_reason), closeNote: row.close_note ?? null,
    lastSellRefusal: row.last_sell_refusal, lastSellRefusalAt: epoch(row.last_sell_refusal_at), noPriceCount: row.no_price_count,
    crashBasisVerified: row.crash_basis_verified === true,
    lastQuoteWei: row.last_quote_wei === null || row.last_quote_wei === undefined ? null : BigInt(row.last_quote_wei),
    lastQuoteBalance: row.last_quote_balance === null || row.last_quote_balance === undefined ? null : BigInt(row.last_quote_balance),
    lastQuoteRoute: row.last_quote_route ?? null, lastQuoteAtMs: epoch(row.last_quote_at),
    peakPnlBps: row.peak_pnl_bps === null || row.peak_pnl_bps === undefined ? null : BigInt(row.peak_pnl_bps),
    crashPendingSinceMs: epoch(row.crash_pending_since),
    crashPendingKind: crashPendingKind(row.crash_pending_kind),
    crashRefQuoteWei: row.crash_ref_quote_wei === null || row.crash_ref_quote_wei === undefined ? null : BigInt(row.crash_ref_quote_wei),
    crashRefBalance: row.crash_ref_balance === null || row.crash_ref_balance === undefined ? null : BigInt(row.crash_ref_balance),
    crashRefAtMs: epoch(row.crash_ref_at), crashRefRoute: row.crash_ref_route ?? null,
    autoExitReason: autoExitReason(row.auto_exit_reason), autoExitAtMs: epoch(row.auto_exit_at), autoExitNote: row.auto_exit_note ?? null,
    sessionGeneration: row.session_generation ?? 0,
    ...(storedSettlement === null ? {} : { settlementAsset: storedSettlement }),
    ...(storedRequested === undefined ? {} : { requestedEntryAtomic: storedRequested }),
    ...(storedVerified === undefined ? {} : { verifiedEntryAtomic: storedVerified }),
    ...(storedOwnership === null ? {} : { receiptOwnershipKey: storedOwnership }),
    ...(storedExitOwnership === null ? {} : { exitReceiptOwnershipKey: storedExitOwnership }),
    ...(row.exit_llm_context === null || row.exit_llm_context === undefined ? {} : { exitLlmContext: decodeExitLlmContext(row.exit_llm_context) }),
  };
}

function decodeExitLlmContext(raw: unknown): ExitLlmContextRecord | null {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const sign = (input: unknown): -1 | 0 | 1 | null => input === -1 || input === 0 || input === 1 ? input : null;
  if (typeof row.askedAtMs !== "number" || typeof row.pnlBps !== "number"
    || typeof row.regime !== "string" || typeof row.session !== "string" || typeof row.trigger !== "string") return null;
  return {
    askedAtMs: row.askedAtMs, pnlBps: row.pnlBps,
    peakPnlBps: typeof row.peakPnlBps === "number" ? row.peakPnlBps : null,
    macdHistSign: sign(row.macdHistSign), emaSpreadSign: sign(row.emaSpreadSign),
    regime: row.regime, session: row.session, trigger: row.trigger,
  };
}

function validateV2PositionFacts(
  asset: "USDT" | null | undefined,
  requested: bigint | null | undefined,
  verified: bigint | null | undefined,
  fillStatus: TradeFillStatus,
  ownershipKey: string | null = null,
): void {
  if (asset === undefined || asset === null) {
    if (requested !== undefined || verified !== undefined || ownershipKey !== null) throw new Error("Legacy trade positions cannot carry v2 settlement facts.");
    return;
  }
  if (asset !== "USDT" || requested === undefined || requested === null || requested <= 0n) {
    throw new Error("USDT trade positions require a positive requested entry amount.");
  }
  if (requested > MAX_UINT256 || verified !== undefined && verified !== null && verified > MAX_UINT256) throw new Error("V2 position facts exceed uint256.");
  if (verified !== undefined && verified !== null && verified <= 0n) throw new Error("Verified entry basis must be positive or null.");
  if (verified !== undefined && verified !== null && fillStatus !== "verified") throw new Error("An unverified v2 fill cannot claim verified entry basis.");
}
function normalizeReceiptOwnershipKey(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!/^56\|0x[0-9a-f]{64}\|0x[0-9a-f]{40}\|\d{1,78}\|0x[0-9a-f]{64}$/iu.test(value)) {
    throw new Error("Trade receipt ownership key is invalid.");
  }
  return value.toLowerCase();
}
function fillStatus(value: string): TradeFillStatus {
  if (value === "verified" || value === "unverified") return value;
  throw new Error("Stored trade fill status is invalid.");
}
function closeReason(value: string | null): TradeCloseReason | null {
  if (value === null) return null;
  if (["owner-request", "stop-loss", "take-profit", "max-hold", "llm", "balance-gone", "crash-stop", "session-expiring", "trailing-stop", "stale-exit"].includes(value)) {
    return value as TradeCloseReason;
  }
  throw new Error("Stored trade close reason is invalid.");
}
function crashPendingKind(value: string | null | undefined): TradeCrashPendingKind | null {
  if (value === null || value === undefined) return null;
  if (value === "collapse" || value === "dust") return value;
  throw new Error("Stored trade crash pending kind is invalid.");
}
function autoExitReason(value: string | null | undefined): TradeAutoExitReason | null {
  if (value === null || value === undefined) return null;
  if (value === "crash-stop" || value === "session-expiring") return value;
  throw new Error("Stored trade automatic exit reason is invalid.");
}
function rowToRun(row: RunRow): TradeRunRecord {
  return { id: row.id, agentId: row.agent_id, ownerAddress: ownerKey(getAddress(row.owner_address)),
    events: normalizeTradeRunEvents(row.events),
    dryRun: row.dry_run, reason: row.reason, candidates: row.candidates ?? 0, refusals: row.refusals ?? 0,
    entries: row.entries ?? 0, exits: row.exits ?? 0, createdAt: row.created_at.getTime() };
}

export async function createTradePositionStore(): Promise<TradePositionStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const store = await PostgresTradePositionStore.create(await createPgSqlClient(connectionString));
    console.log("[trade-position-store] backend=postgres");
    return store;
  }
  console.log("[trade-position-store] backend=memory (DATABASE_URL not set)");
  return new MemoryTradePositionStore();
}
