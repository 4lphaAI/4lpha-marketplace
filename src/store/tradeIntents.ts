/** Durable pre-submit trade identities and exactly-once position projection. */
import { isDeepStrictEqual } from "node:util";
import { getAddress, isHex, type Address, type Hex } from "viem";
import { sanitizeMessage } from "../core/errors.js";
import type { TradeRoute, TradeVenueId } from "../ops/route.js";
import type { TradeCloseReason } from "./tradePositions.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import { MAX_UINT256 } from "../trade/settlement.js";
import { INERT_EVIDENCE_MAX_BYTES } from "../trade/inertSubmission.js";

/**
 * The guarded disposition CAS. ONE text, shared with `scripts/tradfi-dispose-inert.ts`, which runs
 * it without opening this store (so without the store's boot statements).
 */
export const DISPOSE_INERT_SELL_SQL = `/* tradeIntents.disposeInertSell */ update trade_intents
       set state='rolled-back', disposition_evidence=$4, updated_at=$5
       where decision_id=$1 and agent_id=$2 and owner_address=$3 and state='pending' and tx_hash is null returning decision_id`;

function assertEvidenceSize(evidence: string): void {
  if (Buffer.byteLength(evidence, "utf8") > INERT_EVIDENCE_MAX_BYTES) throw new Error("Disposition evidence is too large.");
}

export type TradeIntentState = "pending" | "projected" | "rolled-back";

export type TradeIntentRecord = {
  readonly decisionId: string;
  readonly idempotencyKey: Hex;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly side: "buy" | "sell";
  readonly token: Address;
  readonly route: TradeRoute;
  readonly amountWei: bigint;
  readonly entryWei: bigint;
  readonly positionId: string;
  readonly closeReason: Exclude<TradeCloseReason, "balance-gone"> | null;
  readonly state: TradeIntentState;
  readonly txHash: Hex | null;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly venue: TradeVenueId | null;
  readonly settlementAsset?: "USDT" | null;
  readonly platformFeeAtomic?: bigint | null;
  readonly minOutAtomic?: bigint | null;
  readonly quotedOutAtomic?: bigint | null;
  readonly scheduleSlot?: number | null;
  readonly portfolioSlot?: number | null;
  readonly portfolioProceedsAtomic?: bigint | null;
  readonly portfolioReceiptKey?: string | null;
  /**
   * TRADFI-EXPIRY-KEEP-REMOVE §2.2: JSON written only by `disposeInertSell`, so
   * an ordinary rollback can never carry it. Absent/null on every other row.
   */
  readonly dispositionEvidence?: string | null;
};

export type CreateTradeIntentInput = Pick<TradeIntentRecord,
  "decisionId" | "idempotencyKey" | "agentId" | "ownerAddress" | "side" | "token" |
  "route" | "amountWei" | "entryWei" | "positionId" | "closeReason"> & {
    readonly venue?: TradeVenueId | null;
    readonly note?: string | null;
    readonly settlementAsset?: "USDT" | null;
    readonly platformFeeAtomic?: bigint | null;
    readonly minOutAtomic?: bigint | null;
    readonly quotedOutAtomic?: bigint | null;
    readonly scheduleSlot?: number | null;
    readonly portfolioSlot?: number | null;
  };

export type PortfolioCheck = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly slot: number;
  readonly state: "held" | "rebalancing" | "done";
  readonly maxDriftBps: number;
  readonly valueWei: bigint;
  readonly checkedAt: number;
  readonly updatedAt: number;
};

export type PortfolioProceedsOutcome = "invalid" | "credited" | "conflict" | "sealed" | "same" | "settled";

export interface TradeIntentStore {
  create(input: CreateTradeIntentInput, sql?: SqlClient): Promise<TradeIntentRecord>;
  get(ownerAddress: Address, agentId: string, decisionId: string, sql?: SqlClient): Promise<TradeIntentRecord | null>;
  listUnsettled(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<readonly TradeIntentRecord[]>;
  listSchedule(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<readonly TradeIntentRecord[]>;
  listPortfolio(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<readonly TradeIntentRecord[]>;
  getPortfolioCheck(ownerAddress: Address, agentId: string, slot: number, sql?: SqlClient): Promise<PortfolioCheck | null>;
  insertPortfolioCheck(input: Pick<PortfolioCheck, "agentId" | "ownerAddress" | "slot" | "state" | "maxDriftBps" | "valueWei">, sql?: SqlClient): Promise<PortfolioCheck>;
  markPortfolioCheckDone(ownerAddress: Address, agentId: string, slot: number, sql?: SqlClient): Promise<PortfolioCheck | null>;
  setPortfolioProceeds(ownerAddress: Address, agentId: string, decisionId: string, proceedsAtomic: bigint, receiptKey: string | null, sql?: SqlClient): Promise<{ readonly outcome: PortfolioProceedsOutcome; readonly row: TradeIntentRecord | null }>;
  /** Projected USDT intents whose position may still lack receipt basis. */
  listProjectedV2(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<readonly TradeIntentRecord[]>;
  markSubmitted(ownerAddress: Address, agentId: string, decisionId: string, txHash: Hex | null): Promise<TradeIntentRecord | null>;
  markProjected(ownerAddress: Address, agentId: string, decisionId: string): Promise<TradeIntentRecord | null>;
  markRolledBack(ownerAddress: Address, agentId: string, decisionId: string, note: string | null): Promise<TradeIntentRecord | null>;
  /**
   * One guarded statement: `pending` AND hashless → `rolled-back` with the
   * evidence. `changed` is whether THIS call won. Repeats, a hash that arrived
   * meanwhile, and any other owner/agent return `changed: false`.
   */
  disposeInertSell(ownerAddress: Address, agentId: string, decisionId: string, evidence: string): Promise<{ readonly changed: boolean }>;
  close(): Promise<void>;
}

function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

function hash(value: string): Hex {
  if (!isHex(value, { strict: true }) || value.length !== 66) throw new Error("Stored trade hash is invalid.");
  return value as Hex;
}

function intentVenue(value: string | null | undefined): TradeVenueId | null {
  if (value === undefined || value === null) return null;
  if (value === "pancake_v2" || value === "pancake_v3" || value === "uniswap_v3") return value;
  throw new Error("Stored trade intent venue is invalid.");
}

function sameIntent(left: TradeIntentRecord, right: CreateTradeIntentInput): boolean {
  return left.idempotencyKey === right.idempotencyKey
    && left.agentId === right.agentId
    && left.ownerAddress === ownerKey(right.ownerAddress)
    && left.side === right.side
    && left.token.toLowerCase() === right.token.toLowerCase()
    && left.venue === (right.venue ?? null)
    // JSONB reorders object keys; hop/fee values and array order still bind the intent.
    && isDeepStrictEqual(left.route, right.route)
    && left.amountWei === right.amountWei
    && left.entryWei === right.entryWei
    && left.positionId === right.positionId
    && left.closeReason === right.closeReason
    && (left.settlementAsset ?? null) === (right.settlementAsset ?? null)
    && (left.platformFeeAtomic ?? null) === (right.platformFeeAtomic ?? null)
    && (left.minOutAtomic ?? null) === (right.minOutAtomic ?? null)
    && (left.quotedOutAtomic ?? null) === (right.quotedOutAtomic ?? null)
    && (left.scheduleSlot ?? null) === (right.scheduleSlot ?? null)
    && (left.portfolioSlot ?? null) === (right.portfolioSlot ?? null);
}

export class MemoryTradeIntentStore implements TradeIntentStore {
  readonly #rows = new Map<string, TradeIntentRecord>();
  readonly #portfolioChecks = new Map<string, PortfolioCheck>();
  constructor(private readonly now: () => number = Date.now) {}

  async create(input: CreateTradeIntentInput): Promise<TradeIntentRecord> {
    if (input.platformFeeAtomic !== undefined && input.platformFeeAtomic !== null
      && (input.platformFeeAtomic < 0n || input.platformFeeAtomic > MAX_UINT256)) throw new Error("Trade intent platform fee is outside uint256.");
    if (input.minOutAtomic !== undefined && input.minOutAtomic !== null && (input.minOutAtomic <= 0n || input.minOutAtomic > MAX_UINT256)) throw new Error("Trade intent minOut is outside uint256.");
    if (input.quotedOutAtomic !== undefined && input.quotedOutAtomic !== null && (input.quotedOutAtomic <= 0n || input.quotedOutAtomic > MAX_UINT256)) throw new Error("Trade intent quote is outside uint256.");
    if (input.scheduleSlot !== undefined && input.scheduleSlot !== null && (!Number.isSafeInteger(input.scheduleSlot) || input.scheduleSlot < 0)) throw new Error("Trade schedule slot is invalid.");
    if (input.scheduleSlot !== undefined && input.scheduleSlot !== null) {
      const duplicate = [...this.#rows.values()].find((row) => row.decisionId !== input.decisionId && row.agentId === input.agentId && row.scheduleSlot === input.scheduleSlot && row.state !== "rolled-back");
      if (duplicate !== undefined) throw new Error("Trade schedule slot is already taken.");
    }
    if (input.portfolioSlot !== undefined && input.portfolioSlot !== null) {
      if (!Number.isSafeInteger(input.portfolioSlot) || input.portfolioSlot < 0) throw new Error("Trade portfolio slot is invalid.");
      const duplicate = [...this.#rows.values()].find((row) => row.decisionId !== input.decisionId && row.agentId === input.agentId
        && row.portfolioSlot === input.portfolioSlot && row.token.toLowerCase() === input.token.toLowerCase() && row.state !== "rolled-back");
      if (duplicate !== undefined) throw new Error("Trade portfolio leg is already taken.");
    }
    const existing = this.#rows.get(input.decisionId);
    if (existing !== undefined) {
      if (!sameIntent(existing, input)) throw new Error("Trade decisionId is already bound to another intent.");
      return structuredClone(existing);
    }
    const at = this.now();
    const row: TradeIntentRecord = {
      ...input,
      ownerAddress: ownerKey(input.ownerAddress),
      token: getAddress(input.token),
      route: structuredClone(input.route),
      venue: intentVenue(input.venue),
      state: "pending",
      txHash: null,
      note: input.note === null || input.note === undefined ? null : sanitizeMessage(input.note).slice(0, 200),
      createdAt: at,
      updatedAt: at,
      ...(input.settlementAsset === undefined || input.settlementAsset === null ? {} : { settlementAsset: input.settlementAsset }),
      ...(input.platformFeeAtomic === undefined || input.platformFeeAtomic === null ? {} : { platformFeeAtomic: input.platformFeeAtomic }),
      ...(input.minOutAtomic === undefined || input.minOutAtomic === null ? {} : { minOutAtomic: input.minOutAtomic }),
      ...(input.quotedOutAtomic === undefined || input.quotedOutAtomic === null ? {} : { quotedOutAtomic: input.quotedOutAtomic }),
      ...(input.scheduleSlot === undefined || input.scheduleSlot === null ? {} : { scheduleSlot: input.scheduleSlot }),
      ...(input.portfolioSlot === undefined || input.portfolioSlot === null ? {} : { portfolioSlot: input.portfolioSlot }),
      ...(input.portfolioSlot === undefined || input.portfolioSlot === null ? {} : { portfolioProceedsAtomic: null, portfolioReceiptKey: null }),
    };
    this.#rows.set(row.decisionId, structuredClone(row));
    return structuredClone(row);
  }

  async get(ownerAddress: Address, agentId: string, decisionId: string): Promise<TradeIntentRecord | null> {
    const row = this.#rows.get(decisionId);
    return row === undefined || row.ownerAddress !== ownerKey(ownerAddress) || row.agentId !== agentId
      ? null : structuredClone(row);
  }

  async listUnsettled(ownerAddress: Address, agentId: string): Promise<readonly TradeIntentRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#rows.values()]
      .filter((row) => row.ownerAddress === owner && row.agentId === agentId && row.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt || a.decisionId.localeCompare(b.decisionId))
      .map((row) => structuredClone(row));
  }

  async listSchedule(ownerAddress: Address, agentId: string): Promise<readonly TradeIntentRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#rows.values()]
      .filter((row) => row.ownerAddress === owner && row.agentId === agentId && row.scheduleSlot !== null && row.scheduleSlot !== undefined && row.state !== "rolled-back")
      .sort((a, b) => (a.scheduleSlot! - b.scheduleSlot!) || a.createdAt - b.createdAt)
      .map((row) => structuredClone(row));
  }

  async listPortfolio(ownerAddress: Address, agentId: string): Promise<readonly TradeIntentRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#rows.values()].filter((row) => row.ownerAddress === owner && row.agentId === agentId
      && row.portfolioSlot !== null && row.portfolioSlot !== undefined && row.state !== "rolled-back")
      .sort((a, b) => a.createdAt - b.createdAt || a.decisionId.localeCompare(b.decisionId)).map((row) => structuredClone(row));
  }

  async getPortfolioCheck(ownerAddress: Address, agentId: string, slot: number): Promise<PortfolioCheck | null> {
    const row = this.#portfolioChecks.get(`${agentId}:${slot}`);
    return row?.ownerAddress === ownerKey(ownerAddress) ? structuredClone(row) : null;
  }

  async insertPortfolioCheck(input: Pick<PortfolioCheck, "agentId" | "ownerAddress" | "slot" | "state" | "maxDriftBps" | "valueWei">): Promise<PortfolioCheck> {
    const key = `${input.agentId}:${input.slot}`;
    const existing = this.#portfolioChecks.get(key);
    if (existing !== undefined) return structuredClone(existing);
    const at = this.now();
    const row = { ...input, ownerAddress: ownerKey(input.ownerAddress), checkedAt: at, updatedAt: at };
    this.#portfolioChecks.set(key, row);
    return structuredClone(row);
  }

  async markPortfolioCheckDone(ownerAddress: Address, agentId: string, slot: number): Promise<PortfolioCheck | null> {
    const key = `${agentId}:${slot}`;
    const row = this.#portfolioChecks.get(key);
    if (row === undefined || row.ownerAddress !== ownerKey(ownerAddress)) return null;
    if (row.state !== "rebalancing") return structuredClone(row);
    const next = { ...row, state: "done" as const, updatedAt: this.now() };
    this.#portfolioChecks.set(key, next);
    return structuredClone(next);
  }

  async setPortfolioProceeds(ownerAddress: Address, agentId: string, decisionId: string, proceedsAtomic: bigint, receiptKey: string | null): Promise<{ readonly outcome: PortfolioProceedsOutcome; readonly row: TradeIntentRecord | null }> {
    if (proceedsAtomic < 0n || proceedsAtomic > MAX_UINT256 || (proceedsAtomic > 0n) !== (receiptKey !== null)) return { outcome: "invalid", row: null };
    const row = this.#rows.get(decisionId);
    if (row === undefined || row.ownerAddress !== ownerKey(ownerAddress) || row.agentId !== agentId || row.side !== "sell" || row.portfolioSlot == null) return { outcome: "invalid", row: null };
    if (row.portfolioProceedsAtomic !== null && row.portfolioProceedsAtomic !== undefined) {
      return { outcome: row.portfolioProceedsAtomic === proceedsAtomic && (row.portfolioReceiptKey ?? null) === receiptKey ? "same" : "settled", row: structuredClone(row) };
    }
    const conflict = receiptKey !== null && [...this.#rows.values()].some((other) => other.decisionId !== decisionId && other.portfolioReceiptKey === receiptKey);
    const next = { ...row, portfolioProceedsAtomic: conflict ? 0n : proceedsAtomic, portfolioReceiptKey: conflict ? null : receiptKey, updatedAt: this.now() };
    this.#rows.set(decisionId, next);
    return { outcome: conflict ? "conflict" : proceedsAtomic === 0n ? "sealed" : "credited", row: structuredClone(next) };
  }

  async listProjectedV2(ownerAddress: Address, agentId: string): Promise<readonly TradeIntentRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#rows.values()]
      .filter((row) => row.ownerAddress === owner && row.agentId === agentId && row.state === "projected" && row.settlementAsset === "USDT" && row.portfolioSlot == null)
      .sort((a, b) => a.createdAt - b.createdAt || a.decisionId.localeCompare(b.decisionId))
      .map((row) => structuredClone(row));
  }

  async markSubmitted(ownerAddress: Address, agentId: string, decisionId: string, txHash: Hex | null): Promise<TradeIntentRecord | null> {
    return this.#update(ownerAddress, agentId, decisionId, (row) => ({ ...row, txHash: txHash === null ? row.txHash : hash(txHash), updatedAt: this.now() }));
  }

  async markProjected(ownerAddress: Address, agentId: string, decisionId: string): Promise<TradeIntentRecord | null> {
    return this.#update(ownerAddress, agentId, decisionId, (row) => ({ ...row, state: "projected", updatedAt: this.now() }));
  }

  async markRolledBack(ownerAddress: Address, agentId: string, decisionId: string, note: string | null): Promise<TradeIntentRecord | null> {
    return this.#update(ownerAddress, agentId, decisionId, (row) => ({ ...row, state: "rolled-back", note: note?.slice(0, 300) ?? null, updatedAt: this.now() }));
  }

  async disposeInertSell(ownerAddress: Address, agentId: string, decisionId: string, evidence: string): Promise<{ readonly changed: boolean }> {
    assertEvidenceSize(evidence);
    const row = this.#rows.get(decisionId);
    if (row === undefined || row.ownerAddress !== ownerKey(ownerAddress) || row.agentId !== agentId
      || row.state !== "pending" || row.txHash !== null) return { changed: false };
    this.#rows.set(decisionId, structuredClone({ ...row, state: "rolled-back" as const, dispositionEvidence: evidence, updatedAt: this.now() }));
    return { changed: true };
  }

  async close(): Promise<void> { this.#rows.clear(); this.#portfolioChecks.clear(); }

  #update(ownerAddress: Address, agentId: string, decisionId: string, update: (row: TradeIntentRecord) => TradeIntentRecord): TradeIntentRecord | null {
    const row = this.#rows.get(decisionId);
    if (row === undefined || row.ownerAddress !== ownerKey(ownerAddress) || row.agentId !== agentId) return null;
    if (row.state !== "pending") return structuredClone(row);
    const next = update(row);
    this.#rows.set(decisionId, structuredClone(next));
    return structuredClone(next);
  }
}

type IntentRow = {
  decision_id: string; idempotency_key: string; agent_id: string; owner_address: string;
  side: string; token: string; route: unknown; amount_wei: string; entry_wei: string;
  position_id: string; close_reason: string | null; state: string; tx_hash: string | null;
  note: string | null; created_at: Date; updated_at: Date; venue?: string | null;
  settlement_asset?: string | null; platform_fee_atomic?: string | null; min_out_atomic?: string | null; quoted_out_atomic?: string | null; schedule_slot?: number | null;
  portfolio_slot?: number | null; portfolio_proceeds_atomic?: string | null; portfolio_receipt_key?: string | null;
  disposition_evidence?: string | null;
};

const COLUMNS = "decision_id, idempotency_key, agent_id, owner_address, side, token, route, amount_wei, entry_wei, position_id, close_reason, state, tx_hash, note, created_at, updated_at, venue, settlement_asset, platform_fee_atomic, min_out_atomic, quoted_out_atomic, schedule_slot, portfolio_slot, portfolio_proceeds_atomic, portfolio_receipt_key, disposition_evidence";
const DDL = `create table if not exists trade_intents (
  decision_id text primary key,
  idempotency_key text not null,
  agent_id text not null,
  owner_address text not null,
  side text not null check (side in ('buy','sell')),
  token text not null,
  route jsonb not null,
  amount_wei numeric(78,0) not null,
  entry_wei numeric(78,0) not null,
  position_id text not null,
  close_reason text,
  state text not null check (state in ('pending','projected','rolled-back')),
  tx_hash text,
  note text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  venue text,
  settlement_asset text check (settlement_asset is null or settlement_asset = 'USDT'),
  platform_fee_atomic numeric(78,0)
  , min_out_atomic numeric(78,0), quoted_out_atomic numeric(78,0), schedule_slot integer,
  portfolio_slot integer, portfolio_proceeds_atomic numeric(78,0), portfolio_receipt_key text
)`;

type CheckRow = { agent_id: string; owner_address: string; slot: number; state: PortfolioCheck["state"]; max_drift_bps: number; value_wei: string; checked_at: Date; updated_at: Date };
const CHECK_COLUMNS = "agent_id, owner_address, slot, state, max_drift_bps, value_wei, checked_at, updated_at";
function rowToCheck(row: CheckRow): PortfolioCheck {
  return { agentId: row.agent_id, ownerAddress: ownerKey(getAddress(row.owner_address)), slot: row.slot,
    state: row.state, maxDriftBps: row.max_drift_bps, valueWei: BigInt(row.value_wei),
    checkedAt: row.checked_at.getTime(), updatedAt: row.updated_at.getTime() };
}

export class PostgresTradeIntentStore implements TradeIntentStore {
  private constructor(private readonly sql: SqlClient, private readonly now: () => number) {}
  static async create(sql: SqlClient, now: () => number = Date.now): Promise<PostgresTradeIntentStore> {
    await sql.query(DDL);
    await sql.query("alter table trade_intents add column if not exists venue text");
    await sql.query("alter table trade_intents add column if not exists settlement_asset text");
    await sql.query("alter table trade_intents add column if not exists platform_fee_atomic numeric(78,0)");
    await sql.query("alter table trade_intents add column if not exists min_out_atomic numeric(78,0)");
    await sql.query("alter table trade_intents add column if not exists quoted_out_atomic numeric(78,0)");
    await sql.query("alter table trade_intents add column if not exists schedule_slot integer");
    await sql.query("alter table trade_intents add column if not exists portfolio_slot integer");
    await sql.query("alter table trade_intents add column if not exists portfolio_proceeds_atomic numeric(78,0)");
    await sql.query("alter table trade_intents add column if not exists portfolio_receipt_key text");
    await sql.query("alter table trade_intents add column if not exists disposition_evidence text");
    await sql.query("create unique index if not exists trade_intents_schedule_slot_idx on trade_intents (agent_id, schedule_slot) where schedule_slot is not null and state <> 'rolled-back'");
    await sql.query("create unique index if not exists trade_intents_portfolio_leg_idx on trade_intents (agent_id, portfolio_slot, lower(token)) where portfolio_slot is not null and state <> 'rolled-back'");
    await sql.query("create unique index if not exists trade_intents_portfolio_receipt_idx on trade_intents (portfolio_receipt_key) where portfolio_receipt_key is not null");
    await sql.query(`create table if not exists trade_portfolio_checks (
      agent_id text not null, owner_address text not null, slot integer not null,
      state text not null check (state in ('held','rebalancing','done')),
      max_drift_bps integer not null, value_wei numeric(78,0) not null,
      checked_at timestamptz not null, updated_at timestamptz not null,
      primary key (agent_id, slot))`);
    await sql.query(`create index if not exists trade_intents_agent_idx on trade_intents (owner_address, agent_id, state, created_at)`);
    return new PostgresTradeIntentStore(sql, now);
  }

  async create(input: CreateTradeIntentInput, sql: SqlClient = this.sql): Promise<TradeIntentRecord> {
    if (input.platformFeeAtomic !== undefined && input.platformFeeAtomic !== null
      && (input.platformFeeAtomic < 0n || input.platformFeeAtomic > MAX_UINT256)) throw new Error("Trade intent platform fee is outside uint256.");
    if (input.minOutAtomic !== undefined && input.minOutAtomic !== null && (input.minOutAtomic <= 0n || input.minOutAtomic > MAX_UINT256)) throw new Error("Trade intent minOut is outside uint256.");
    if (input.quotedOutAtomic !== undefined && input.quotedOutAtomic !== null && (input.quotedOutAtomic <= 0n || input.quotedOutAtomic > MAX_UINT256)) throw new Error("Trade intent quote is outside uint256.");
    const at = new Date(this.now());
    const inserted = await sql.query<IntentRow>(
      `/* tradeIntents.create */ insert into trade_intents (${COLUMNS})
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::numeric,$9::numeric,$10,$11,'pending',null,$12,$13,$13,$14,$15,$16,$17::numeric,$18::numeric,$19,$20,null,null,null)
       on conflict (decision_id) do nothing returning ${COLUMNS}`,
      [input.decisionId, input.idempotencyKey, input.agentId, ownerKey(input.ownerAddress), input.side,
        getAddress(input.token), encodeJsonbParam(input.route), input.amountWei.toString(10), input.entryWei.toString(10),
        input.positionId, input.closeReason, input.note === null || input.note === undefined ? null : sanitizeMessage(input.note).slice(0, 200), at,
        input.venue ?? null, input.settlementAsset ?? null, input.platformFeeAtomic?.toString(10) ?? null,
        input.minOutAtomic?.toString(10) ?? null, input.quotedOutAtomic?.toString(10) ?? null, input.scheduleSlot ?? null, input.portfolioSlot ?? null],
    );
    const row = inserted.rows[0] ?? (await sql.query<IntentRow>(
      `/* tradeIntents.getByDecision */ select ${COLUMNS} from trade_intents where decision_id = $1`, [input.decisionId],
    )).rows[0];
    if (row === undefined) throw new Error("Trade intent could not be stored.");
    const record = rowToIntent(row);
    if (!sameIntent(record, input)) throw new Error("Trade decisionId is already bound to another intent.");
    return record;
  }

  async get(ownerAddress: Address, agentId: string, decisionId: string, sql: SqlClient = this.sql): Promise<TradeIntentRecord | null> {
    const row = (await sql.query<IntentRow>(
      `/* tradeIntents.get */ select ${COLUMNS} from trade_intents where decision_id=$1 and agent_id=$2 and owner_address=$3`,
      [decisionId, agentId, ownerKey(ownerAddress)],
    )).rows[0];
    return row === undefined ? null : rowToIntent(row);
  }

  async listUnsettled(ownerAddress: Address, agentId: string, sql: SqlClient = this.sql): Promise<readonly TradeIntentRecord[]> {
    const rows = await sql.query<IntentRow>(
      `/* tradeIntents.listUnsettled */ select ${COLUMNS} from trade_intents
       where owner_address=$1 and agent_id=$2 and state='pending' order by created_at asc, decision_id asc`,
      [ownerKey(ownerAddress), agentId],
    );
    return rows.rows.map(rowToIntent);
  }

  async listSchedule(ownerAddress: Address, agentId: string, sql: SqlClient = this.sql): Promise<readonly TradeIntentRecord[]> {
    const rows = await sql.query<IntentRow>(
      `/* tradeIntents.listSchedule */ select ${COLUMNS} from trade_intents
       where owner_address=$1 and agent_id=$2 and schedule_slot is not null and state <> 'rolled-back' order by schedule_slot asc, created_at asc`,
      [ownerKey(ownerAddress), agentId],
    );
    return rows.rows.map(rowToIntent);
  }

  async listPortfolio(ownerAddress: Address, agentId: string, sql: SqlClient = this.sql): Promise<readonly TradeIntentRecord[]> {
    const rows = await sql.query<IntentRow>(
      `/* tradeIntents.listPortfolio */ select ${COLUMNS} from trade_intents
       where owner_address=$1 and agent_id=$2 and portfolio_slot is not null and state <> 'rolled-back'
       order by created_at asc, decision_id asc`, [ownerKey(ownerAddress), agentId]);
    return rows.rows.map(rowToIntent);
  }

  async getPortfolioCheck(ownerAddress: Address, agentId: string, slot: number, sql: SqlClient = this.sql): Promise<PortfolioCheck | null> {
    const row = (await sql.query<CheckRow>(`/* tradeIntents.getPortfolioCheck */ select ${CHECK_COLUMNS} from trade_portfolio_checks where owner_address=$1 and agent_id=$2 and slot=$3`, [ownerKey(ownerAddress), agentId, slot])).rows[0];
    return row === undefined ? null : rowToCheck(row);
  }

  async insertPortfolioCheck(input: Pick<PortfolioCheck, "agentId" | "ownerAddress" | "slot" | "state" | "maxDriftBps" | "valueWei">, sql: SqlClient = this.sql): Promise<PortfolioCheck> {
    const at = new Date(this.now());
    await sql.query(`/* tradeIntents.insertPortfolioCheck */ insert into trade_portfolio_checks (${CHECK_COLUMNS})
      values ($1,$2,$3,$4,$5,$6::numeric,$7,$7) on conflict (agent_id, slot) do nothing`,
    [input.agentId, ownerKey(input.ownerAddress), input.slot, input.state, input.maxDriftBps, input.valueWei.toString(10), at]);
    const row = await this.getPortfolioCheck(input.ownerAddress, input.agentId, input.slot, sql);
    if (row === null) throw new Error("Portfolio check could not be stored.");
    return row;
  }

  async markPortfolioCheckDone(ownerAddress: Address, agentId: string, slot: number, sql: SqlClient = this.sql): Promise<PortfolioCheck | null> {
    const row = (await sql.query<CheckRow>(`/* tradeIntents.markPortfolioCheckDone */ update trade_portfolio_checks
      set state='done', updated_at=$4 where owner_address=$1 and agent_id=$2 and slot=$3 and state='rebalancing' returning ${CHECK_COLUMNS}`,
    [ownerKey(ownerAddress), agentId, slot, new Date(this.now())])).rows[0];
    return row === undefined ? this.getPortfolioCheck(ownerAddress, agentId, slot, sql) : rowToCheck(row);
  }

  async setPortfolioProceeds(ownerAddress: Address, agentId: string, decisionId: string, proceedsAtomic: bigint, receiptKey: string | null, sql: SqlClient = this.sql): Promise<{ readonly outcome: PortfolioProceedsOutcome; readonly row: TradeIntentRecord | null }> {
    if (proceedsAtomic < 0n || proceedsAtomic > MAX_UINT256 || (proceedsAtomic > 0n) !== (receiptKey !== null)) return { outcome: "invalid", row: null };
    const params = [decisionId, agentId, ownerKey(ownerAddress), proceedsAtomic.toString(10), receiptKey, new Date(this.now())];
    return sql.transaction(async (tx) => {
      await tx.query("savepoint portfolio_proceeds_credit");
      try {
      const changed = (await tx.query<IntentRow>(`/* tradeIntents.setPortfolioProceeds */ update trade_intents
        set portfolio_proceeds_atomic=$4::numeric, portfolio_receipt_key=$5, updated_at=$6
        where decision_id=$1 and agent_id=$2 and owner_address=$3 and side='sell' and portfolio_slot is not null
          and portfolio_proceeds_atomic is null and portfolio_receipt_key is null returning ${COLUMNS}`, params)).rows[0];
      if (changed !== undefined) {
        await tx.query("release savepoint portfolio_proceeds_credit");
        return { outcome: proceedsAtomic === 0n ? "sealed" : "credited", row: rowToIntent(changed) };
      }
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "23505") throw error;
      await tx.query("rollback to savepoint portfolio_proceeds_credit");
      const sealed = (await tx.query<IntentRow>(`/* tradeIntents.sealPortfolioConflict */ update trade_intents
        set portfolio_proceeds_atomic=0, portfolio_receipt_key=null, updated_at=$4
        where decision_id=$1 and agent_id=$2 and owner_address=$3 and side='sell' and portfolio_slot is not null
          and portfolio_proceeds_atomic is null and portfolio_receipt_key is null returning ${COLUMNS}`,
      [decisionId, agentId, ownerKey(ownerAddress), new Date(this.now())])).rows[0];
      if (sealed !== undefined) {
        await tx.query("release savepoint portfolio_proceeds_credit");
        return { outcome: "conflict", row: rowToIntent(sealed) };
      }
    }
    await tx.query("release savepoint portfolio_proceeds_credit");
    const row = await this.get(ownerAddress, agentId, decisionId, tx);
    if (row === null || row.side !== "sell" || row.portfolioSlot === undefined) return { outcome: "invalid", row: null };
    return { outcome: row.portfolioProceedsAtomic === proceedsAtomic && (row.portfolioReceiptKey ?? null) === receiptKey ? "same" : "settled", row };
    });
  }

  async listProjectedV2(ownerAddress: Address, agentId: string, sql: SqlClient = this.sql): Promise<readonly TradeIntentRecord[]> {
    const rows = await sql.query<IntentRow>(
      `/* tradeIntents.listProjectedV2 */ select ${COLUMNS} from trade_intents
       where owner_address=$1 and agent_id=$2 and state='projected' and settlement_asset='USDT' and portfolio_slot is null
       order by created_at asc, decision_id asc`,
      [ownerKey(ownerAddress), agentId],
    );
    return rows.rows.map(rowToIntent);
  }

  async markSubmitted(ownerAddress: Address, agentId: string, decisionId: string, txHash: Hex | null): Promise<TradeIntentRecord | null> {
    return this.#update("tradeIntents.submitted", "tx_hash=coalesce($4,tx_hash), updated_at=$5", ownerAddress, agentId, decisionId, [txHash === null ? null : hash(txHash), new Date(this.now())]);
  }
  async markProjected(ownerAddress: Address, agentId: string, decisionId: string): Promise<TradeIntentRecord | null> {
    return this.#update("tradeIntents.projected", "state='projected', updated_at=$4", ownerAddress, agentId, decisionId, [new Date(this.now())]);
  }
  async markRolledBack(ownerAddress: Address, agentId: string, decisionId: string, note: string | null): Promise<TradeIntentRecord | null> {
    return this.#update("tradeIntents.rolledBack", "state='rolled-back', note=$4, updated_at=$5", ownerAddress, agentId, decisionId, [note?.slice(0, 300) ?? null, new Date(this.now())]);
  }
  async disposeInertSell(ownerAddress: Address, agentId: string, decisionId: string, evidence: string): Promise<{ readonly changed: boolean }> {
    assertEvidenceSize(evidence);
    const disposed = await this.sql.query<{ readonly decision_id: string }>(
      DISPOSE_INERT_SELL_SQL,
      [decisionId, agentId, ownerKey(ownerAddress), evidence, new Date(this.now())],
    );
    return { changed: disposed.rows.length > 0 };
  }
  async close(): Promise<void> { await this.sql.close(); }

  async #update(tag: string, assignment: string, ownerAddress: Address, agentId: string, decisionId: string, rest: readonly unknown[]): Promise<TradeIntentRecord | null> {
    const row = (await this.sql.query<IntentRow>(
      `/* ${tag} */ update trade_intents set ${assignment}
       where decision_id=$1 and agent_id=$2 and owner_address=$3 and state='pending' returning ${COLUMNS}`,
      [decisionId, agentId, ownerKey(ownerAddress), ...rest],
    )).rows[0];
    return row === undefined ? this.get(ownerAddress, agentId, decisionId) : rowToIntent(row);
  }
}

function rowToIntent(row: IntentRow): TradeIntentRecord {
  if (row.side !== "buy" && row.side !== "sell") throw new Error("Stored trade intent side is invalid.");
  if (row.state !== "pending" && row.state !== "projected" && row.state !== "rolled-back") throw new Error("Stored trade intent state is invalid.");
  const closeReason = row.close_reason;
  if (closeReason !== null && !["owner-request", "stop-loss", "take-profit", "max-hold", "llm", "crash-stop", "session-expiring"].includes(closeReason)) {
    throw new Error("Stored trade intent close reason is invalid.");
  }
  const venue = intentVenue(row.venue);
  const settlementAsset = row.settlement_asset === null || row.settlement_asset === undefined ? null
    : row.settlement_asset === "USDT" ? "USDT" as const : (() => { throw new Error("Stored trade intent settlement asset is invalid."); })();
  return {
    decisionId: row.decision_id,
    idempotencyKey: hash(row.idempotency_key),
    agentId: row.agent_id,
    ownerAddress: ownerKey(getAddress(row.owner_address)),
    side: row.side,
    token: getAddress(row.token),
    route: decodeJsonb(row.route) as TradeRoute,
    amountWei: BigInt(row.amount_wei),
    entryWei: BigInt(row.entry_wei),
    positionId: row.position_id,
    closeReason: closeReason as TradeIntentRecord["closeReason"],
    state: row.state,
    txHash: row.tx_hash === null ? null : hash(row.tx_hash),
    note: row.note,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    venue,
    ...(settlementAsset === null ? {} : { settlementAsset }),
    ...(row.platform_fee_atomic === null || row.platform_fee_atomic === undefined ? {} : { platformFeeAtomic: BigInt(row.platform_fee_atomic) }),
    ...(row.min_out_atomic === null || row.min_out_atomic === undefined ? {} : { minOutAtomic: BigInt(row.min_out_atomic) }),
    ...(row.quoted_out_atomic === null || row.quoted_out_atomic === undefined ? {} : { quotedOutAtomic: BigInt(row.quoted_out_atomic) }),
    ...(row.schedule_slot === null || row.schedule_slot === undefined ? {} : { scheduleSlot: row.schedule_slot }),
    ...(row.portfolio_slot === null || row.portfolio_slot === undefined ? {} : { portfolioSlot: row.portfolio_slot,
      portfolioProceedsAtomic: row.portfolio_proceeds_atomic === null || row.portfolio_proceeds_atomic === undefined ? null : BigInt(row.portfolio_proceeds_atomic),
      portfolioReceiptKey: row.portfolio_receipt_key ?? null }),
    ...(row.disposition_evidence === null || row.disposition_evidence === undefined ? {} : { dispositionEvidence: row.disposition_evidence }),
  };
}

export async function createTradeIntentStore(): Promise<TradeIntentStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const store = await PostgresTradeIntentStore.create(await createPgSqlClient(connectionString));
    console.log("[trade-intent-store] backend=postgres");
    return store;
  }
  console.log("[trade-intent-store] backend=memory (DATABASE_URL not set)");
  return new MemoryTradeIntentStore();
}
