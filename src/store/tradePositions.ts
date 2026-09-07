/** Trading positions and bounded worker-run history (TRADING-AGENT R8/R9/R3.1). */
import { randomUUID } from "node:crypto";
import { getAddress, isHex, type Address, type Hex } from "viem";
import type { TradeRoute } from "../ops/route.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

import { normalizeTradeRunEvents, type TradeRunEvent } from "./tradeRunTrace.js";

export type Clock = () => number;
export type TradePositionStatus = "open" | "closed" | "orphaned";
export type TradeFillStatus = "verified" | "unverified";
export type TradeCloseReason = "owner-request" | "stop-loss" | "take-profit" | "max-hold" | "llm" | "balance-gone";

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
  readonly lastSellRefusal: string | null;
  readonly lastSellRefusalAt: number | null;
  readonly noPriceCount: number;
};

export type OpenTradePositionInput = Pick<
  TradePositionRecord,
  "positionId" | "agentId" | "ownerAddress" | "token" | "route" | "entryWei" | "tokenAmount" | "fillStatus" | "openedAt"
> & { readonly entryTxHash?: Hex | null };

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
  get(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null>;
  list(ownerAddress: Address, agentId: string): Promise<readonly TradePositionRecord[]>;
  listOpen(ownerAddress: Address, agentId: string): Promise<readonly TradePositionRecord[]>;
  requestExit(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null>;
  markOrphaned(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null>;
  closePosition(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly exitWei: bigint | null;
    readonly exitTxHash?: Hex | null;
    readonly soldTokenAmount?: bigint | null;
    readonly exitFillStatus?: TradeFillStatus;
    readonly reason?: TradeCloseReason;
  }): Promise<TradePositionRecord | null>;
  recordSellRefusal(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly refusal: string | null;
  }): Promise<TradePositionRecord | null>;
  resolveFill(input: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
    readonly tokenAmount: bigint;
  }): Promise<TradePositionRecord | null>;
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
      lastSellRefusal: null,
      lastSellRefusalAt: null,
      noPriceCount: 0,
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
      lastSellRefusal: null,
      lastSellRefusalAt: null,
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
};
type RunRow = {
  id: string; agent_id: string; owner_address: string; dry_run: boolean;
  events?: unknown; reason: string; candidates: number; refusals: number; entries: number; exits: number; created_at: Date;
};

const POSITION_COLUMNS = "id, agent_id, owner_address, token, route, entry_wei, token_amount, fill_status, opened_at, entry_tx_hash, status, exit_requested_at, orphaned_at, closed_at, exit_wei, exit_tx_hash, sold_token_amount, exit_fill_status, close_reason, last_sell_refusal, last_sell_refusal_at, no_price_count";
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
    no_price_count integer not null default 0
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
    await sql.query(TRADE_POSITIONS_DDL);
    await sql.query(TRADE_RUNS_DDL);
    // TRADING-AGENT item 1 follow-up: existing durable tables gain honest structural counts.
    await sql.query(`alter table trade_runs add column if not exists events jsonb not null default '[]'::jsonb`);
    await sql.query(`alter table trade_runs add column if not exists candidates integer not null default 0`);
    await sql.query(`alter table trade_runs add column if not exists refusals integer not null default 0`);
    await sql.query(`alter table trade_runs add column if not exists entries integer not null default 0`);
    await sql.query(`alter table trade_runs add column if not exists exits integer not null default 0`);
    // AUDIT H2/L7: additive columns retain legacy rows as verified while making uncertainty durable.
    await sql.query(`alter table trade_positions alter column token_amount drop not null`);
    await sql.query(`alter table trade_positions add column if not exists fill_status text not null default 'verified'`);
    await sql.query(`alter table trade_positions add column if not exists close_reason text`);
    await sql.query(`alter table trade_positions add column if not exists last_sell_refusal_at timestamptz`);
    await sql.query(`alter table trade_positions add column if not exists entry_tx_hash text`);
    await sql.query(`alter table trade_positions add column if not exists exit_tx_hash text`);
    await sql.query(`alter table trade_positions add column if not exists sold_token_amount numeric(78,0)`);
    await sql.query(`alter table trade_positions add column if not exists exit_fill_status text`);
    await sql.query(`alter table trade_positions drop constraint if exists trade_positions_close_reason_check`);
    await sql.query(`alter table trade_positions drop constraint if exists trade_positions_close_reason_v2_check`);
    await sql.query(`alter table trade_positions add constraint trade_positions_close_reason_v2_check check (close_reason is null or close_reason in ('owner-request','stop-loss','take-profit','max-hold','llm','balance-gone'))`);
    await sql.query(TRADE_POSITION_INDEX_DDL);
    await sql.query(TRADE_RUN_INDEX_DDL);
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
         null,null,null,null,null,null,null,null,null,null,0)
       on conflict (id) do nothing returning ${POSITION_COLUMNS}`,
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), getAddress(input.token),
        encodeJsonbParam(input.route), input.entryWei.toString(10), input.tokenAmount?.toString(10) ?? null,
        input.fillStatus, new Date(input.openedAt), hashOrNull(input.entryTxHash)],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Trade position "${input.positionId}" already exists.`);
    return rowToPosition(row);
  }

  async get(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    const result = await this.#sql.query<PositionRow>(
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

  async listOpen(ownerAddress: Address, agentId: string): Promise<readonly TradePositionRecord[]> {
    const result = await this.#sql.query<PositionRow>(
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

  async markOrphaned(ownerAddress: Address, agentId: string, positionId: string): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.orphan", "status = 'orphaned', orphaned_at = $4",
      [positionId, agentId, ownerKey(ownerAddress), new Date(this.#now())]);
  }

  async closePosition(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly exitWei: bigint | null; readonly exitTxHash?: Hex | null; readonly soldTokenAmount?: bigint | null; readonly exitFillStatus?: TradeFillStatus; readonly reason?: TradeCloseReason }): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.close",
      "status = 'closed', closed_at = $4, exit_wei = $5::numeric, close_reason = $6, exit_tx_hash = $7, sold_token_amount = $8::numeric, exit_fill_status = $9, last_sell_refusal = null, last_sell_refusal_at = null",
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), new Date(this.#now()), input.exitWei?.toString(10) ?? null, input.reason ?? null,
        hashOrNull(input.exitTxHash), input.soldTokenAmount?.toString(10) ?? null, input.exitFillStatus ?? "unverified"]);
  }

  async recordSellRefusal(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly refusal: string | null }): Promise<TradePositionRecord | null> {
    return this.#update("tradePositions.sellRefusal", "last_sell_refusal = $4, last_sell_refusal_at = case when $4::text is null then null else $5 end",
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.refusal, new Date(this.#now())]);
  }

  async resolveFill(input: { readonly ownerAddress: Address; readonly agentId: string; readonly positionId: string; readonly tokenAmount: bigint }): Promise<TradePositionRecord | null> {
    if (input.tokenAmount <= 0n) return null;
    return this.#update("tradePositions.resolveFill", "token_amount = $4::numeric, fill_status = 'verified'",
      [input.positionId, input.agentId, ownerKey(input.ownerAddress), input.tokenAmount.toString(10)]);
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

  async #update(tag: string, assignment: string, params: readonly unknown[]): Promise<TradePositionRecord | null> {
    const result = await this.#sql.query<PositionRow>(
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
function epoch(value: Date | null): number | null { return value === null ? null : value.getTime(); }
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
    closeReason: closeReason(row.close_reason),
    lastSellRefusal: row.last_sell_refusal, lastSellRefusalAt: epoch(row.last_sell_refusal_at), noPriceCount: row.no_price_count,
  };
}
function fillStatus(value: string): TradeFillStatus {
  if (value === "verified" || value === "unverified") return value;
  throw new Error("Stored trade fill status is invalid.");
}
function closeReason(value: string | null): TradeCloseReason | null {
  if (value === null) return null;
  if (["owner-request", "stop-loss", "take-profit", "max-hold", "llm", "balance-gone"].includes(value)) {
    return value as TradeCloseReason;
  }
  throw new Error("Stored trade close reason is invalid.");
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
