import { getAddress, type Address, type Hex } from "viem";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";

export type LpFeeEvent = {
  ownerAddress: Address; agentId: string; positionId: string; lineageId: string;
  sequenceId: string; journalIdempotencyKey: string; stepIndex: number; kind: string;
  tokenId: string; txHash: Hex; blockNumber: bigint; collected0Wei: bigint; collected1Wei: bigint;
  decreased0Wei: bigint; decreased1Wei: bigint; realised0Wei: bigint; realised1Wei: bigint;
  status: "recorded" | "gap"; reason: string | null; recordedAtMs: number;
  /** Complete receipt set, repeated on each row to detect incomplete legacy writes. */
  receiptTokenIds: readonly string[];
};
export type FeeCandidate = { sequenceId: string; journalIdempotencyKey: string; txHash: Hex };
export type FeeCoverage = { status: "complete" | "incomplete" | "unavailable"; missing: number; gaps: number; reason: string };
const ownerKey = (owner: Address) => getAddress(owner).toLowerCase();
const key = (r: Pick<LpFeeEvent, "sequenceId" | "journalIdempotencyKey" | "tokenId" | "positionId">) => JSON.stringify([r.sequenceId, r.journalIdempotencyKey, r.tokenId, r.positionId]);

function feeRow(value: unknown): LpFeeEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid fee ledger row");
  const r = value as LpFeeEvent;
  for (const field of ["ownerAddress","agentId","positionId","lineageId","sequenceId","journalIdempotencyKey","kind","tokenId","txHash"] as const) {
    if (typeof r[field] !== "string" || r[field].length > 2048) throw new Error("Invalid fee ledger identity");
  }
  ownerKey(r.ownerAddress);
  const max = (1n << 256n) - 1n;
  for (const field of ["blockNumber","collected0Wei","collected1Wei","decreased0Wei","decreased1Wei"] as const) {
    if (typeof r[field] !== "bigint" || r[field] < 0n || r[field] > max) throw new Error("Invalid fee ledger amount");
  }
  if (r.realised0Wei !== r.collected0Wei-r.decreased0Wei || r.realised1Wei !== r.collected1Wei-r.decreased1Wei
    || !["recorded","gap"].includes(r.status) || r.reason !== null && typeof r.reason !== "string"
    || !Number.isSafeInteger(r.stepIndex) || r.stepIndex < 0 || !Number.isSafeInteger(r.recordedAtMs) || r.recordedAtMs < 0
    || !Array.isArray(r.receiptTokenIds) || r.receiptTokenIds.length > 64
    || r.receiptTokenIds.some(id => typeof id !== "string" || !/^(0|[1-9]\d{0,77})$/u.test(id))
    || !/^0x[0-9a-f]{64}$/iu.test(r.txHash)) throw new Error("Invalid fee ledger evidence");
  // Explicit projection prevents an unknown persisted property becoming HTTP text.
  return { ownerAddress:r.ownerAddress,agentId:r.agentId,positionId:r.positionId,lineageId:r.lineageId,sequenceId:r.sequenceId,
    journalIdempotencyKey:r.journalIdempotencyKey,stepIndex:r.stepIndex,kind:r.kind,tokenId:r.tokenId,txHash:r.txHash,blockNumber:r.blockNumber,
    collected0Wei:r.collected0Wei,collected1Wei:r.collected1Wei,decreased0Wei:r.decreased0Wei,decreased1Wei:r.decreased1Wei,
    realised0Wei:r.realised0Wei,realised1Wei:r.realised1Wei,status:r.status,reason:r.reason,recordedAtMs:r.recordedAtMs,receiptTokenIds:[...r.receiptTokenIds] };
}

export interface LpFeeEventStore {
  recordReceipt(rows: readonly LpFeeEvent[], signal?: AbortSignal): Promise<void>;
  /** One owner-scoped ledger snapshot; aggregation never uses the display limit. */
  snapshot(owner: Address, agentId: string, signal?: AbortSignal): Promise<LpFeeEvent[]>;
  listFeeEvents(owner: Address, agentId: string, positionId: string, limit: number): Promise<LpFeeEvent[]>;
  sumFeeEvents(owner: Address, agentId: string, positionId: string, options: { throughBlock: bigint }): Promise<ReturnType<typeof sumFeeRows>>;
  close(): Promise<void>;
}

function validateBatch(rows: readonly LpFeeEvent[]): void {
  const first = rows[0];
  if (!first || rows.length > 64 || new Set(rows.map(key)).size !== rows.length) throw new Error("Invalid atomic fee receipt set");
  const expected = [...first.receiptTokenIds].sort().join(",");
  for (const r of rows) {
    feeRow(r);
    if (ownerKey(r.ownerAddress) !== ownerKey(first.ownerAddress) || r.agentId !== first.agentId || r.sequenceId !== first.sequenceId
      || r.journalIdempotencyKey !== first.journalIdempotencyKey || r.txHash !== first.txHash || r.blockNumber !== first.blockNumber
      || [...r.receiptTokenIds].sort().join(",") !== expected || !Number.isSafeInteger(r.stepIndex) || r.stepIndex < 0
      || r.blockNumber < 0n || !/^0x[0-9a-f]{64}$/iu.test(r.txHash)
      || (r.status === "gap" ? r.tokenId !== "-" || !r.reason : !/^(0|[1-9]\d{0,77})$/u.test(r.tokenId))
      || r.realised0Wei !== r.collected0Wei - r.decreased0Wei || r.realised1Wei !== r.collected1Wei - r.decreased1Wei) throw new Error("Invalid fee accounting row");
  }
  if (rows.every(r => r.status === "recorded") && rows.map(r => r.tokenId).sort().join(",") !== expected) throw new Error("Incomplete atomic fee receipt set");
}

export function sumFeeRows(rows: readonly LpFeeEvent[], positionId: string, throughBlock: bigint) {
  const selected = rows.filter(r => r.positionId === positionId && r.blockNumber <= throughBlock);
  return { realised0Wei: selected.reduce((sum, r) => sum + (r.status === "recorded" ? r.realised0Wei : 0n), 0n),
    realised1Wei: selected.reduce((sum, r) => sum + (r.status === "recorded" ? r.realised1Wei : 0n), 0n),
    recordedCount: selected.filter(r => r.status === "recorded").length, gapCount: selected.filter(r => r.status === "gap").length, throughBlock };
}

export function feeCoverage(rows: readonly LpFeeEvent[], candidates: readonly FeeCandidate[], throughBlock: bigint): FeeCoverage {
  let missing = 0, gaps = 0;
  for (const c of candidates) {
    const receipt = rows.filter(r => r.sequenceId === c.sequenceId && r.journalIdempotencyKey === c.journalIdempotencyKey && r.txHash.toLowerCase() === c.txHash.toLowerCase());
    const first = receipt[0];
    // No row means UNKNOWN H, not a future receipt and not an empty history.
    if (!first || receipt.some(r => r.blockNumber !== first.blockNumber)) { missing++; continue; }
    if (first.blockNumber > throughBlock) continue;
    const gapRows = receipt.filter(r => r.status === "gap");
    if (gapRows.length) { gaps += gapRows.length; continue; }
    const expected = [...first.receiptTokenIds].sort().join(",");
    if (!expected || receipt.map(r => r.tokenId).sort().join(",") !== expected || receipt.some(r => [...r.receiptTokenIds].sort().join(",") !== expected)) missing++;
  }
  return { status: missing || gaps ? "incomplete" : "complete", missing, gaps,
    reason: missing || gaps ? "managed submission fee coverage incomplete" : "managed submissions only; owner/raw transactions are outside coverage" };
}

abstract class FeeStoreReads implements LpFeeEventStore {
  abstract recordReceipt(rows: readonly LpFeeEvent[], signal?: AbortSignal): Promise<void>;
  abstract snapshot(owner: Address, agentId: string, signal?: AbortSignal): Promise<LpFeeEvent[]>;
  abstract close(): Promise<void>;
  async listFeeEvents(owner: Address, agent: string, position: string, limit: number) {
    return (await this.snapshot(owner, agent)).filter(r => r.positionId === position).sort((a, b) => b.recordedAtMs - a.recordedAtMs).slice(0, Math.max(0, Math.min(200, limit)));
  }
  async sumFeeEvents(owner: Address, agent: string, position: string, options: { throughBlock: bigint }) {
    return sumFeeRows(await this.snapshot(owner, agent), position, options.throughBlock);
  }
}

export class MemoryLpFeeEventStore extends FeeStoreReads {
  readonly #rows = new Map<string, LpFeeEvent>();
  async recordReceipt(rows: readonly LpFeeEvent[], signal?: AbortSignal) {
    signal?.throwIfAborted(); validateBatch(rows);
    const copies = rows.map(feeRow);
    for (const r of copies) if (!this.#rows.has(key(r))) this.#rows.set(key(r), r);
  }
  async snapshot(owner: Address, agentId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return structuredClone([...this.#rows.values()].filter(r => ownerKey(r.ownerAddress) === ownerKey(owner) && r.agentId === agentId));
  }
  async close() { /* No lifecycle deletion: fee history survives close/revoke. */ }
}

const DDL = `create table if not exists lp_fee_events (
  owner_address text not null, agent_id text not null, position_id text not null, lineage_id text not null,
  sequence_id text not null, journal_idempotency_key text not null, token_id text not null, step_index integer not null,
  kind text not null, tx_hash text not null, block_number numeric(78,0) not null,
  collected0_wei numeric(78,0) not null, collected1_wei numeric(78,0) not null,
  decreased0_wei numeric(78,0) not null, decreased1_wei numeric(78,0) not null,
  realised0_wei numeric(79,0) not null, realised1_wei numeric(79,0) not null,
  status text not null check(status in ('recorded','gap')), reason text, recorded_at_ms bigint not null,
  receipt_token_ids jsonb not null, record jsonb not null,
  unique(sequence_id, journal_idempotency_key, token_id, position_id))`;

export class PostgresLpFeeEventStore extends FeeStoreReads {
  private constructor(private readonly sql: SqlClient) { super(); }
  static async create(sql: SqlClient) {
    await sql.query(DDL);
    await sql.query("create index if not exists lp_fee_events_owner_idx on lp_fee_events(owner_address, agent_id, position_id)");
    return new PostgresLpFeeEventStore(sql);
  }
  async recordReceipt(rows: readonly LpFeeEvent[], signal?: AbortSignal) {
    signal?.throwIfAborted(); validateBatch(rows);
    await this.sql.transaction(async tx => {
      for (const r of rows) {
        signal?.throwIfAborted();
        await tx.query(`/* lpFeeEvents.insert */ insert into lp_fee_events
          (owner_address,agent_id,position_id,lineage_id,sequence_id,journal_idempotency_key,token_id,step_index,kind,tx_hash,block_number,
           collected0_wei,collected1_wei,decreased0_wei,decreased1_wei,realised0_wei,realised1_wei,status,reason,recorded_at_ms,receipt_token_ids,record)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb)
          on conflict(sequence_id,journal_idempotency_key,token_id,position_id) do nothing`,
        [ownerKey(r.ownerAddress),r.agentId,r.positionId,r.lineageId,r.sequenceId,r.journalIdempotencyKey,r.tokenId,r.stepIndex,r.kind,r.txHash,r.blockNumber.toString(),
          r.collected0Wei.toString(),r.collected1Wei.toString(),r.decreased0Wei.toString(),r.decreased1Wei.toString(),r.realised0Wei.toString(),r.realised1Wei.toString(),r.status,r.reason,r.recordedAtMs,
          JSON.stringify(r.receiptTokenIds),encodeJsonbParam(r)], { ...(signal ? { signal } : {}), timeoutMs: 1000 });
      }
      signal?.throwIfAborted();
    });
  }
  async snapshot(owner: Address, agentId: string, signal?: AbortSignal) {
    const result = await this.sql.query<{ record: unknown }>("/* lpFeeEvents.snapshot */ select record from lp_fee_events where owner_address=$1 and agent_id=$2", [ownerKey(owner), agentId], { ...(signal ? { signal } : {}), timeoutMs: 1000 });
    return result.rows.map(r => {
      const parsed = feeRow(decodeJsonb(r.record));
      if (ownerKey(parsed.ownerAddress) !== ownerKey(owner) || parsed.agentId !== agentId) throw new Error("Fee ledger owner mismatch");
      return parsed;
    });
  }
  async close() { await this.sql.close(); }
}

export async function createLpFeeEventStore(): Promise<LpFeeEventStore> {
  const connection = process.env["DATABASE_URL"]?.trim();
  return connection ? PostgresLpFeeEventStore.create(await createPgSqlClient(connection)) : new MemoryLpFeeEventStore();
}
