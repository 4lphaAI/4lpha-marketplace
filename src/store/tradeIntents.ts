/** Durable pre-submit trade identities and exactly-once position projection. */
import { isDeepStrictEqual } from "node:util";
import { getAddress, isHex, type Address, type Hex } from "viem";
import type { TradeRoute } from "../ops/route.js";
import type { TradeCloseReason } from "./tradePositions.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

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
};

export type CreateTradeIntentInput = Pick<TradeIntentRecord,
  "decisionId" | "idempotencyKey" | "agentId" | "ownerAddress" | "side" | "token" |
  "route" | "amountWei" | "entryWei" | "positionId" | "closeReason">;

export interface TradeIntentStore {
  create(input: CreateTradeIntentInput): Promise<TradeIntentRecord>;
  get(ownerAddress: Address, agentId: string, decisionId: string): Promise<TradeIntentRecord | null>;
  listUnsettled(ownerAddress: Address, agentId: string): Promise<readonly TradeIntentRecord[]>;
  markSubmitted(ownerAddress: Address, agentId: string, decisionId: string, txHash: Hex | null): Promise<TradeIntentRecord | null>;
  markProjected(ownerAddress: Address, agentId: string, decisionId: string): Promise<TradeIntentRecord | null>;
  markRolledBack(ownerAddress: Address, agentId: string, decisionId: string, note: string | null): Promise<TradeIntentRecord | null>;
  close(): Promise<void>;
}

function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

function hash(value: string): Hex {
  if (!isHex(value, { strict: true }) || value.length !== 66) throw new Error("Stored trade hash is invalid.");
  return value as Hex;
}

function sameIntent(left: TradeIntentRecord, right: CreateTradeIntentInput): boolean {
  return left.idempotencyKey === right.idempotencyKey
    && left.agentId === right.agentId
    && left.ownerAddress === ownerKey(right.ownerAddress)
    && left.side === right.side
    && left.token.toLowerCase() === right.token.toLowerCase()
    // JSONB reorders object keys; hop/fee values and array order still bind the intent.
    && isDeepStrictEqual(left.route, right.route)
    && left.amountWei === right.amountWei
    && left.entryWei === right.entryWei
    && left.positionId === right.positionId
    && left.closeReason === right.closeReason;
}

export class MemoryTradeIntentStore implements TradeIntentStore {
  readonly #rows = new Map<string, TradeIntentRecord>();
  constructor(private readonly now: () => number = Date.now) {}

  async create(input: CreateTradeIntentInput): Promise<TradeIntentRecord> {
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
      state: "pending",
      txHash: null,
      note: null,
      createdAt: at,
      updatedAt: at,
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

  async markSubmitted(ownerAddress: Address, agentId: string, decisionId: string, txHash: Hex | null): Promise<TradeIntentRecord | null> {
    return this.#update(ownerAddress, agentId, decisionId, (row) => ({ ...row, txHash: txHash === null ? row.txHash : hash(txHash), updatedAt: this.now() }));
  }

  async markProjected(ownerAddress: Address, agentId: string, decisionId: string): Promise<TradeIntentRecord | null> {
    return this.#update(ownerAddress, agentId, decisionId, (row) => ({ ...row, state: "projected", updatedAt: this.now() }));
  }

  async markRolledBack(ownerAddress: Address, agentId: string, decisionId: string, note: string | null): Promise<TradeIntentRecord | null> {
    return this.#update(ownerAddress, agentId, decisionId, (row) => ({ ...row, state: "rolled-back", note: note?.slice(0, 300) ?? null, updatedAt: this.now() }));
  }

  async close(): Promise<void> { this.#rows.clear(); }

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
  note: string | null; created_at: Date; updated_at: Date;
};

const COLUMNS = "decision_id, idempotency_key, agent_id, owner_address, side, token, route, amount_wei, entry_wei, position_id, close_reason, state, tx_hash, note, created_at, updated_at";
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
  updated_at timestamptz not null
)`;

export class PostgresTradeIntentStore implements TradeIntentStore {
  private constructor(private readonly sql: SqlClient, private readonly now: () => number) {}
  static async create(sql: SqlClient, now: () => number = Date.now): Promise<PostgresTradeIntentStore> {
    await sql.query(DDL);
    await sql.query(`create index if not exists trade_intents_agent_idx on trade_intents (owner_address, agent_id, state, created_at)`);
    return new PostgresTradeIntentStore(sql, now);
  }

  async create(input: CreateTradeIntentInput): Promise<TradeIntentRecord> {
    const at = new Date(this.now());
    const inserted = await this.sql.query<IntentRow>(
      `/* tradeIntents.create */ insert into trade_intents (${COLUMNS})
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::numeric,$9::numeric,$10,$11,'pending',null,null,$12,$12)
       on conflict (decision_id) do nothing returning ${COLUMNS}`,
      [input.decisionId, input.idempotencyKey, input.agentId, ownerKey(input.ownerAddress), input.side,
        getAddress(input.token), encodeJsonbParam(input.route), input.amountWei.toString(10), input.entryWei.toString(10),
        input.positionId, input.closeReason, at],
    );
    const row = inserted.rows[0] ?? (await this.sql.query<IntentRow>(
      `/* tradeIntents.getByDecision */ select ${COLUMNS} from trade_intents where decision_id = $1`, [input.decisionId],
    )).rows[0];
    if (row === undefined) throw new Error("Trade intent could not be stored.");
    const record = rowToIntent(row);
    if (!sameIntent(record, input)) throw new Error("Trade decisionId is already bound to another intent.");
    return record;
  }

  async get(ownerAddress: Address, agentId: string, decisionId: string): Promise<TradeIntentRecord | null> {
    const row = (await this.sql.query<IntentRow>(
      `/* tradeIntents.get */ select ${COLUMNS} from trade_intents where decision_id=$1 and agent_id=$2 and owner_address=$3`,
      [decisionId, agentId, ownerKey(ownerAddress)],
    )).rows[0];
    return row === undefined ? null : rowToIntent(row);
  }

  async listUnsettled(ownerAddress: Address, agentId: string): Promise<readonly TradeIntentRecord[]> {
    const rows = await this.sql.query<IntentRow>(
      `/* tradeIntents.listUnsettled */ select ${COLUMNS} from trade_intents
       where owner_address=$1 and agent_id=$2 and state='pending' order by created_at asc, decision_id asc`,
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
  if (closeReason !== null && !["owner-request", "stop-loss", "take-profit", "max-hold", "llm"].includes(closeReason)) {
    throw new Error("Stored trade intent close reason is invalid.");
  }
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
