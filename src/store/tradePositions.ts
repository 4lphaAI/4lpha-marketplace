/** Trading positions and bounded worker-run history (TRADING-AGENT R8/R9/R4). */
import { randomUUID } from "node:crypto";
import { getAddress, isHex, type Address, type Hex } from "viem";
import { sanitizeMessage } from "../core/errors.js";
import type { TradeRoute } from "../ops/route.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

import { normalizeTradeRunEvents, type TradeRunEvent } from "./tradeRunTrace.js";

export type Clock = () => number;
export type TradePositionStatus = "open" | "closed" | "orphaned";
export type TradeFillStatus = "verified" | "unverified";
export type TradeCloseReason = "owner-request" | "stop-loss" | "take-profit" | "max-hold" | "llm" | "balance-gone" | "crash-stop" | "session-expiring";
export type TradeCrashPendingKind = "collapse" | "dust";
export type TradeAutoExitReason = "crash-stop" | "session-expiring";

export type TradeEvidenceExpected = {
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
};

export type OpenTradePositionInput = Pick<
  TradePositionRecord,
  "positionId" | "agentId" | "ownerAddress" | "token" | "route" | "entryWei" | "tokenAmount" | "fillStatus" | "openedAt"
> & { readonly entryTxHash?: Hex | null; readonly crashBasisVerified?: boolean };

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
  markOrphaned(ownerAddress: Address, agentId: string, positionId: string, sql?: SqlClient): Promise<TradePositionRecord | null>;
  closePosition(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly exitWei: bigint | null;
    readonly exitTxHash?: Hex | null;
    readonly soldTokenAmount?: bigint | null;
    readonly exitFillStatus?: TradeFillStatus;
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
  recordQuote(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly quoteOutWei: bigint;
    readonly balance?: bigint;
    readonly routeKey?: string;
    readonly pnlBps: bigint | null;
    readonly atMs: number;
    readonly expected?: Pick<TradeEvidenceExpected, "lastQuoteWei" | "lastQuoteBalance" | "lastQuoteRoute" | "lastQuoteAtMs">;
  }, sql?: SqlClient): Promise<TradePositionRecord | null>;
  recordCrashEvidence(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly expected: TradeEvidenceExpected;
    readonly action: TradeCrashEvidenceAction;
  }, sql?: SqlClient): Promise<TradePositionRecord | null>;
  clearCrashEvidenceForAgent(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<number>;
  incrementNoPrice(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null>;
  resetNoPrice(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null>;
  insertRun(input: TradeRunInput): Promise<TradeRunRecord>;
  listRuns(ownerAddress: Address, agentId: string, limit?: number): Promise<readonly TradeRunRecord[]>;
  close(): Promise<void>;
}

function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

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
    autoExitNote: action.note === null ? null : sanitizeMessage(action.note).slice(0, 200) };
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
    if (this.#positions.has(input.positionId)) {
      throw new Error(`Trade position "${input.positionId}" already exists.`);
    }
    const row: TradePositionRecord = {
      ...input,
      entryTxHash: hashOrNull(input.entryTxHash),
      ownerAddress: ownerKey(input.ownerAddress),
      token: getAddress(input.token),
      route: structuredClone(input.route),
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
    readonly reason?: TradeCloseReason;
    readonly note?: string | null;
  }): Promise<TradePositionRecord | null> {
    return this.#mutateOpen(input.ownerAddress, input.agentId, input.positionId, (row) => ({
      ...row,
      status: "closed",
      closedAt: this.#now(),
      exitWei: input.exitWei,
      exitTxHash: hashOrNull(input.exitTxHash),
      soldTokenAmount: input.soldTokenAmount ?? null,
      exitFillStatus: input.exitFillStatus ?? "unverified",
      closeReason: input.reason ?? null,
      closeNote: input.note === null || input.note === undefined ? null : sanitizeMessage(input.note).slice(0, 200),
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

  async recordQuote(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly quoteOutWei: bigint;
    readonly balance?: bigint;
    readonly routeKey?: string;
    readonly pnlBps: bigint | null;
    readonly atMs: number;
    readonly expected?: Pick<TradeEvidenceExpected, "lastQuoteWei" | "lastQuoteBalance" | "lastQuoteRoute" | "lastQuoteAtMs">;
  }): Promise<TradePositionRecord | null> {
    const row = this.#owned(input.ownerAddress, input.agentId, input.positionId);
    if (row === undefined || row.status !== "open") return null;
    const expected = input.expected ?? {
      lastQuoteWei: row.lastQuoteWei,
      lastQuoteBalance: row.lastQuoteBalance,
      lastQuoteRoute: row.lastQuoteRoute,
      lastQuoteAtMs: row.lastQuoteAtMs,
    };
    if (!sameQuoteState(row, expected) || !quoteTimestampCanAdvance(expected.lastQuoteAtMs, input.atMs)) return null;
    const next: TradePositionRecord = {
      ...row,
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
  }): Promise<TradePositionRecord | null> {
    const row = this.#owned(input.ownerAddress, input.agentId, input.positionId);
    if (row === undefined || row.status !== "open" || !sameEvidence(row, input.expected)) return null;
    const next = applyEvidence(row, input.action);
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
    this.#runs.set(input.agentId, rows.slice(0, 200));
    return structuredClone(row);
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
  id: string; agent_id: string; owner_address: string; token: string; route: unknown;
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
};
type RunRow = {
  id: string; agent_id: string; owner_address: string; dry_run: boolean;
  events?: unknown; reason: string; candidates: number; refusals: number; entries: number; exits: number; created_at: Date;
};

const POSITION_COLUMNS = "id, agent_id, owner_address, token, route, entry_wei, token_amount, fill_status, opened_at, entry_tx_hash, status, exit_requested_at, orphaned_at, closed_at, exit_wei, exit_tx_hash, sold_token_amount, exit_fill_status, close_reason, last_sell_refusal, last_sell_refusal_at, no_price_count, crash_basis_verified, last_quote_wei, last_quote_balance, last_quote_route, last_quote_at, peak_pnl_bps, crash_pending_since, crash_pending_kind, crash_ref_quote_wei, crash_ref_balance, crash_ref_at, crash_ref_route, auto_exit_reason, auto_exit_at, auto_exit_note, close_note";
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
    close_note text
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
      // R3.6/R4.4: the name is deliberately scoped to this table, so another
      // store's constraint cannot satisfy the migration check.
      await tx.query(`select pg_advisory_xact_lock(hashtext('trade_positions'))`);
      await tx.query(`alter table trade_positions drop constraint if exists trade_positions_close_reason_check`);
      await tx.query(`alter table trade_positions drop constraint if exists trade_positions_close_reason_v2_check`);
      const constraint = await tx.query(
        `select 1 from pg_constraint c where c.conname = 'trade_positions_close_reason_v3_check'
         and c.conrelid = 'trade_positions'::regclass limit 1`,
      );
      if (constraint.rows.length === 0) {
        await tx.query(`alter table trade_positions add constraint trade_positions_close_reason_v3_check
          check (close_reason is null or close_reason in ('owner-request','stop-loss','take-profit','max-hold','llm','balance-gone','crash-stop','session-expiring'))`);
      }
      await tx.query(TRADE_POSITION_INDEX_DDL);
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
    const result = await this.#sql.query<PositionRow>(
      `/* tradePositions.open */ insert into trade_positions (${POSITION_COLUMNS})
       values ($1,$2,$3,$4,$5::jsonb,$6::numeric,$7::numeric,$8,$9,$10,'open',
         null,null,null,null,null,null,null,null,null,null,0,$11,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null)
       on conflict (id) do nothing returning ${POSITION_COLUMNS}`,
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), getAddress(input.token),
        encodeJsonbParam(input.route), input.entryWei.toString(10), input.tokenAmount?.toString(10) ?? null,
        input.fillStatus, new Date(input.openedAt), hashOrNull(input.entryTxHash),
        input.crashBasisVerified === true && input.fillStatus === "verified" && input.tokenAmount !== null
          && input.tokenAmount > 0n && input.entryTxHash !== null && input.entryTxHash !== undefined],
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

  async closePosition(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly exitWei: bigint | null; readonly exitTxHash?: Hex | null; readonly soldTokenAmount?: bigint | null; readonly exitFillStatus?: TradeFillStatus; readonly reason?: TradeCloseReason; readonly note?: string | null }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.close",
      "status = 'closed', closed_at = $4, exit_wei = $5::numeric, close_reason = $6, exit_tx_hash = $7, sold_token_amount = $8::numeric, exit_fill_status = $9, close_note = $10, last_sell_refusal = null, last_sell_refusal_at = null, crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null, crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null, auto_exit_reason = null, auto_exit_at = null, auto_exit_note = null",
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), new Date(this.#now()), input.exitWei?.toString(10) ?? null, input.reason ?? null,
        hashOrNull(input.exitTxHash), input.soldTokenAmount?.toString(10) ?? null, input.exitFillStatus ?? "unverified", input.note === null || input.note === undefined ? null : sanitizeMessage(input.note).slice(0, 200)], sql);
  }

  async recordSellRefusal(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly refusal: string | null }): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.sellRefusal", "last_sell_refusal = $4, last_sell_refusal_at = case when $4::text is null then null else $5 end",
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.refusal, new Date(this.#now())]);
  }

  async resolveFill(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly tokenAmount: bigint }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    if (input.tokenAmount <= 0n) return null;
    return this.#update("tradePositions.resolveFill", "token_amount = $4::numeric, fill_status = 'verified'",
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.tokenAmount.toString(10)], sql);
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
    readonly expected?: Pick<TradeEvidenceExpected, "lastQuoteWei" | "lastQuoteBalance" | "lastQuoteRoute" | "lastQuoteAtMs">;
  }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    const expected = input.expected;
    const resolved = expected ?? await this.get(input.ownerAddress, input.agentId, input.positionId, sql);
    if (resolved === null || resolved === undefined) return null;
    const state = expected ?? {
      lastQuoteWei: resolved.lastQuoteWei,
      lastQuoteBalance: resolved.lastQuoteBalance,
      lastQuoteRoute: resolved.lastQuoteRoute,
      lastQuoteAtMs: resolved.lastQuoteAtMs,
    };
    if (!quoteTimestampCanAdvance(state.lastQuoteAtMs, input.atMs)) return null;
    const result = await sql.query<PositionRow>(
      `/* tradePositions.recordQuote */ update trade_positions set
         last_quote_wei = $4::numeric, last_quote_balance = $5::numeric, last_quote_route = $6,
         last_quote_at = $7, peak_pnl_bps = case when $8::numeric is null then peak_pnl_bps
           when peak_pnl_bps is null or peak_pnl_bps < $8::numeric then $8::numeric else peak_pnl_bps end
       where id = $1 and agent_id = $2 and owner_address = $3 and status = 'open'
         and last_quote_wei is not distinct from $9::numeric
         and last_quote_balance is not distinct from $10::numeric
         and last_quote_route is not distinct from $11::text
         and last_quote_at is not distinct from $12::timestamptz
         and ($12::timestamptz is null or $7::timestamptz > $12::timestamptz or $12::timestamptz > $7::timestamptz)
       returning ${POSITION_COLUMNS}`,
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.quoteOutWei.toString(10),
        input.balance?.toString(10) ?? null, input.routeKey ?? null, new Date(input.atMs),
        input.pnlBps?.toString(10) ?? null, state.lastQuoteWei?.toString(10) ?? null,
        state.lastQuoteBalance?.toString(10) ?? null, state.lastQuoteRoute, state.lastQuoteAtMs === null ? null : new Date(state.lastQuoteAtMs)],
    );
    return result.rows[0] === undefined ? null : rowToPosition(result.rows[0]);
  }

  async recordCrashEvidence(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly expected: TradeEvidenceExpected;
    readonly action: TradeCrashEvidenceAction;
  }, sql: SqlClient = this.#sql): Promise<TradePositionRecord | null> {
    const expected = input.expected;
    let assignment: string;
    let actionParams: readonly unknown[];
    if (input.action.kind === "arm") {
      assignment = "crash_pending_since = $17, crash_pending_kind = $18, crash_ref_quote_wei = $19::numeric, crash_ref_balance = $20::numeric, crash_ref_at = $21, crash_ref_route = $22";
      actionParams = [new Date(input.action.pendingSinceMs), input.action.pendingKind,
        input.action.reference.quoteWei.toString(10), input.action.reference.balance.toString(10),
        new Date(input.action.reference.atMs), input.action.reference.routeKey];
    } else if (input.action.kind === "marker") {
      assignment = "crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null, crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null, auto_exit_reason = $17, auto_exit_at = $18, auto_exit_note = $19";
      actionParams = [input.action.reason, new Date(input.action.atMs), input.action.note === null ? null : sanitizeMessage(input.action.note).slice(0, 200)];
    } else {
      assignment = "crash_pending_since = null, crash_pending_kind = null, crash_ref_quote_wei = null, crash_ref_balance = null, crash_ref_at = null, crash_ref_route = null";
      actionParams = [];
    }
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
       returning ${POSITION_COLUMNS}`,
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), expected.lastQuoteWei?.toString(10) ?? null,
        expected.lastQuoteBalance?.toString(10) ?? null, expected.lastQuoteRoute,
        expected.lastQuoteAtMs === null ? null : new Date(expected.lastQuoteAtMs),
        expected.crashPendingSinceMs === null ? null : new Date(expected.crashPendingSinceMs), expected.crashPendingKind,
        expected.crashRefQuoteWei?.toString(10) ?? null, expected.crashRefBalance?.toString(10) ?? null,
        expected.crashRefAtMs === null ? null : new Date(expected.crashRefAtMs), expected.crashRefRoute,
        expected.autoExitReason, expected.autoExitAtMs === null ? null : new Date(expected.autoExitAtMs), expected.autoExitNote,
        ...actionParams],
    );
    return result.rows[0] === undefined ? null : rowToPosition(result.rows[0]);
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
function epoch(value: Date | null | undefined): number | null { return value === null || value === undefined ? null : value.getTime(); }
function rowToPosition(row: PositionRow): TradePositionRecord {
  return {
    positionId: row.id, agentId: row.agent_id, ownerAddress: ownerKey(getAddress(row.owner_address)),
    token: getAddress(row.token), route: decodeJsonb(row.route) as TradeRoute,
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
  };
}
function fillStatus(value: string): TradeFillStatus {
  if (value === "verified" || value === "unverified") return value;
  throw new Error("Stored trade fill status is invalid.");
}
function closeReason(value: string | null): TradeCloseReason | null {
  if (value === null) return null;
  if (["owner-request", "stop-loss", "take-profit", "max-hold", "llm", "balance-gone", "crash-stop", "session-expiring"].includes(value)) {
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
