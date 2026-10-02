/**
 * Durable state for Auto DCA (AUTO-DCA-SPEC §11.1, R2.7, R2.19): rounds, their
 * resting orders, and one row per relay submission.
 *
 * ─── WHAT THIS STORE IS THE AUTHORITY ON ───────────────────────────────────
 *
 *   - the ROUND: its phase, its ledger (C, H, proceeds, carry), its stop-loss
 *     baseline and counter, its retry streak;
 *   - the ORDERS: every level and TP range the round placed or will place, its
 *     ticks, its token id, what it minted and what its exit collected, and the
 *     durable fill counter;
 *   - the ACTIONS: the persisted plan (I4) written BEFORE any submit, and the
 *     one in-flight slot per agent (I3).
 *
 * It is NOT the authority on whether a submission landed: that is the journal
 * (kind `dcaRange`) and the receipt.
 *
 * ─── THE FENCE (R2.7) ──────────────────────────────────────────────────────
 *
 * `withDcaFence` takes `pg_advisory_xact_lock(DCA_LOCK_CLASSID, hashtext(agentId))`
 * in the TWO-ARGUMENT form (the quant fence) and then the agent's
 * `trade_settings` row `for update`. The advisory lock buys DCA-vs-DCA
 * exclusion; the row lock is what serialises with the settings route and
 * `requestDrain`, which take the one-argument lock in a different space
 * (REVIEW2 §2.3). It does NOT refuse while draining: Remove's exits must run
 * then. Every method takes an optional `sql` so a fence runs them ON ITS OWN
 * TRANSACTION.
 *
 * ─── WHY EVERY STATEMENT IS STATIC ─────────────────────────────────────────
 *
 * The quant store's rule (`quantJobs.ts`): each statement is one static,
 * tagged string with explicitly cast parameters; no predicate is built at
 * runtime. Writes of a whole row replace every column, so no statement needs a
 * dynamic column list.
 */
import { getAddress, type Address, type Hex } from "viem";
import { canonicalEncode } from "../auth/canonical.js";
import type { DcaBatchKind, DcaBatchPlan, DcaRole } from "../trade/dca.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { RECONCILE_MIN_ROW_AGE_MS } from "./journal.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

/**
 * Advisory-lock class id for the per-agent DCA fence ("DCAR").
 *
 * THE CLASS-ID REGISTRY (REVIEW2 N25). The two-argument
 * `pg_advisory_xact_lock(int, int)` space is shared by every user of it:
 *   - `LENDING_LOCK_CLASSID = 0x4c454e44` ("LEND", `src/store/lendingGuards.ts`);
 *   - `QUANT_LOCK_CLASSID  = 0x5155414e` ("QUAN", `src/store/quantJobs.ts`, restated in `src/quant/config.ts`);
 *   - `lpSequences.ts` puts `hashtext(ownerKey)` in the class slot
 *     (`pg_advisory_xact_lock(hashtext($1), hashtext($2))`), so any fixed id
 *     can in principle alias an owner hash — a 1-in-2^32 spurious wait, never
 *     a correctness bug;
 *   - `DCA_LOCK_CLASSID   = 0x44434152` ("DCAR", here).
 * A new fixed id takes a new four-letter ASCII mnemonic and a line here.
 */
export const DCA_LOCK_CLASSID = 0x4443_4152; // "DCAR"

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

export type DcaRoundPhase = "starting" | "active" | "closing" | "settled" | "stopped";
export type DcaOrderState = "pending" | "skipped" | "minting" | "live" | "exiting" | "exited";
export type DcaActionState = "intended" | "submitted" | "committed" | "rolled-back" | "unknown" | "finished";
export type DcaClosedBy = "plane" | "owner" | "elsewhere";

export type DcaRoundRow = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly roundNo: number;
  readonly phase: DcaRoundPhase;
  readonly rowVersion: number;
  /** P0 = the start swap's input ÷ output (R2.3); null until the start finishes. */
  readonly p0UsdtWei: bigint | null;
  readonly p0StockWei: bigint | null;
  readonly costUsdtWei: bigint;
  readonly stockAcquiredWei: bigint;
  readonly usdtCollectedWei: bigint;
  readonly saleProceedsWei: bigint;
  readonly carriedStockWei: bigint;
  readonly carriedCostWei: bigint;
  readonly slBaselineWei: bigint;
  /** §7.2's two-reading hysteresis, the fill counter's shape. */
  readonly slCount: number;
  readonly slLastBlock: bigint | null;
  readonly slLastAtMs: number | null;
  readonly closeCause: string | null;
  readonly realizedPnlWei: bigint | null;
  readonly unreliable: boolean;
  readonly revertStreak: number;
  readonly backoffUntilMs: number | null;
  readonly openedAtMs: number;
  readonly settledAtMs: number | null;
  readonly stoppedAtMs: number | null;
  readonly updatedAtMs: number;
  /** AUTO-DCA R4.3 (I17): the round's stock left unsold at a `removed` settle, `H − sold`. `null` for every other close cause and for a round settled before R4. */
  readonly unsoldStockWei: bigint | null;
  /** Its cost basis at average cost (R2.6): `C − ⌊C · sold / H⌋`. */
  readonly unsoldCostWei: bigint | null;
  /** Its value at the settling reading's mid: `⌊unsoldStockWei · mid⌋`. */
  readonly unsoldValueWei: bigint | null;
};

export type DcaRoundInsert = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly roundNo: number;
  readonly phase: "starting" | "active";
  readonly p0UsdtWei: bigint | null;
  readonly p0StockWei: bigint | null;
  readonly costUsdtWei: bigint;
  readonly stockAcquiredWei: bigint;
  readonly carriedStockWei: bigint;
  readonly carriedCostWei: bigint;
  readonly slBaselineWei: bigint;
  readonly nowMs: number;
};

export type DcaOrderRow = {
  readonly agentId: string;
  readonly roundNo: number;
  readonly orderKey: string;
  readonly role: DcaRole;
  readonly levelNo: number | null;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly tokenId: bigint | null;
  readonly state: DcaOrderState;
  readonly liquidity: bigint;
  readonly mintedUsdtWei: bigint;
  readonly mintedStockWei: bigint;
  readonly collectedUsdtWei: bigint;
  readonly collectedStockWei: bigint;
  readonly crossCount: number;
  readonly crossLastBlock: bigint | null;
  readonly crossLastAtMs: number | null;
  readonly createdByAction: string | null;
  readonly exitedByAction: string | null;
  readonly lastSeenLiveBlock: bigint | null;
  readonly closedBy: DcaClosedBy | null;
  readonly updatedAtMs: number;
};

export type DcaActionRow = {
  /** `dca:<agentId>:<roundNo>:<seq>`, fresh per attempt (R2.19); the journal key. */
  readonly actionKey: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly roundNo: number;
  readonly kind: DcaBatchKind;
  readonly plan: DcaBatchPlan;
  readonly state: DcaActionState;
  readonly txHash: Hex | null;
  readonly callsHash: Hex | null;
  readonly note: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type DcaClaimInput = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly roundNo: number;
  /** The round's `rowVersion` as this cycle read it. */
  readonly expectedRowVersion: number;
  readonly plan: DcaBatchPlan;
  readonly nowMs: number;
};

export type DcaClaimResult =
  | { readonly kind: "claimed"; readonly action: DcaActionRow; readonly roundRowVersion: number }
  | { readonly kind: "dca_round_changed" };

export type DcaFinishInput = {
  readonly ownerAddress: Address;
  readonly actionKey: string;
  /** The plan the finish was derived for; it must equal the persisted one (I4). */
  readonly plan: DcaBatchPlan;
  /** Whole-row round writes, each a CAS on its `rowVersion`, applied first. */
  readonly roundWrites: readonly DcaRoundRow[];
  /** A next round opened by the same batch (close + start), applied after. */
  readonly roundInserts: readonly DcaRoundInsert[];
  readonly orders: readonly DcaOrderRow[];
  readonly nowMs: number;
};

export interface DcaRoundStore {
  withDcaFence<T>(ownerAddress: Address, agentId: string, work: (sql: SqlClient | undefined) => Promise<T>): Promise<T>;
  getOpenRound(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<DcaRoundRow | null>;
  listRounds(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<readonly DcaRoundRow[]>;
  /** `null` when the agent already has an open round, or the number is taken. */
  insertRound(input: DcaRoundInsert, sql?: SqlClient): Promise<DcaRoundRow | null>;
  /** Whole-row CAS on `row.rowVersion`; the stored row comes back one version on, or `null`. */
  writeRound(row: DcaRoundRow, sql?: SqlClient): Promise<DcaRoundRow | null>;
  listOrders(agentId: string, roundNo: number, sql?: SqlClient): Promise<readonly DcaOrderRow[]>;
  /** Whole-row upsert by `(agentId, orderKey)`. */
  putOrder(row: DcaOrderRow, sql?: SqlClient): Promise<void>;
  /**
   * R2.7 step 2, the ONE conditional write: the `intended` action is inserted
   * only when the agent has no action `intended`/`submitted` AND the round is
   * at its expected version, and the round moves one version on in the same
   * statement. Zero rows answer `dca_round_changed` — never a unique-violation
   * that would abort the fence's transaction.
   */
  claimAction(input: DcaClaimInput, sql?: SqlClient): Promise<DcaClaimResult>;
  getAction(ownerAddress: Address, actionKey: string, sql?: SqlClient): Promise<DcaActionRow | null>;
  listActions(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<readonly DcaActionRow[]>;
  /**
   * CAS from one of `from`. Moving to `rolled-back` frees the slot and undoes
   * the action's order marks (§5.7): its `minting` levels return to `pending`,
   * its `minting` TPs are deleted, its `exiting` orders return to `live`.
   */
  setActionState(input: {
    readonly ownerAddress: Address;
    readonly actionKey: string;
    readonly from: readonly DcaActionState[];
    readonly to: DcaActionState;
    readonly txHash?: Hex | null;
    readonly callsHash?: Hex | null;
    readonly note?: string | null;
    readonly nowMs: number;
  }, sql?: SqlClient): Promise<DcaActionRow | null>;
  /**
   * §5.5's one store transaction, with the persisted plan as the authority
   * (I4): a finish handed a different plan THROWS before any write.
   */
  finishAction(input: DcaFinishInput, sql?: SqlClient): Promise<DcaActionRow>;
  /**
   * R2.7's safety net: an `intended` action at least
   * `RECONCILE_MIN_ROW_AGE_MS` old is released to `rolled-back`. The caller
   * has proved it has no journal row; this answers only for the age.
   */
  releaseOrphan(input: { readonly ownerAddress: Address; readonly actionKey: string; readonly nowMs: number }, sql?: SqlClient): Promise<boolean>;
}

const IN_FLIGHT: ReadonlySet<DcaActionState> = new Set<DcaActionState>(["intended", "submitted"]);
const FINISHABLE: readonly DcaActionState[] = ["submitted", "committed", "unknown"];

function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

function actionKeyFor(agentId: string, roundNo: number, seq: number): string {
  return `dca:${agentId}:${roundNo}:${seq}`;
}

function samePlan(left: DcaBatchPlan, right: DcaBatchPlan): boolean {
  return canonicalEncode(left) === canonicalEncode(right);
}

function roundFromInsert(input: DcaRoundInsert): DcaRoundRow {
  return {
    agentId: input.agentId, ownerAddress: ownerKey(input.ownerAddress), roundNo: input.roundNo, phase: input.phase,
    rowVersion: 1, p0UsdtWei: input.p0UsdtWei, p0StockWei: input.p0StockWei,
    costUsdtWei: input.costUsdtWei, stockAcquiredWei: input.stockAcquiredWei, usdtCollectedWei: 0n, saleProceedsWei: 0n,
    carriedStockWei: input.carriedStockWei, carriedCostWei: input.carriedCostWei, slBaselineWei: input.slBaselineWei,
    slCount: 0, slLastBlock: null, slLastAtMs: null, closeCause: null, realizedPnlWei: null, unreliable: false,
    revertStreak: 0, backoffUntilMs: null, openedAtMs: input.nowMs, settledAtMs: null, stoppedAtMs: null,
    updatedAtMs: input.nowMs, unsoldStockWei: null, unsoldCostWei: null, unsoldValueWei: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Memory backend                                                             */
/* -------------------------------------------------------------------------- */

export class MemoryDcaRoundStore implements DcaRoundStore {
  readonly #rounds = new Map<string, DcaRoundRow>();
  readonly #orders = new Map<string, DcaOrderRow>();
  readonly #actions = new Map<string, DcaActionRow>();
  readonly #locks = new Map<string, Promise<void>>();

  async withDcaFence<T>(_ownerAddress: Address, agentId: string, work: (sql: SqlClient | undefined) => Promise<T>): Promise<T> {
    // The memory twin of the advisory lock: it proves the order, not a rollback.
    const previous = this.#locks.get(agentId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#locks.set(agentId, previous.then(() => gate));
    await previous;
    try {
      return await work(undefined);
    } finally {
      release();
    }
  }

  #roundKey(agentId: string, roundNo: number): string {
    return `${agentId}|${roundNo}`;
  }

  #orderKey(agentId: string, orderKey: string): string {
    return `${agentId}|${orderKey}`;
  }

  #owned(row: { readonly ownerAddress: Address }, ownerAddress: Address): boolean {
    return row.ownerAddress === ownerKey(ownerAddress);
  }

  async getOpenRound(ownerAddress: Address, agentId: string): Promise<DcaRoundRow | null> {
    const open = [...this.#rounds.values()].find((row) =>
      row.agentId === agentId && this.#owned(row, ownerAddress) && row.phase !== "settled");
    return open === undefined ? null : structuredClone(open);
  }

  async listRounds(ownerAddress: Address, agentId: string): Promise<readonly DcaRoundRow[]> {
    return [...this.#rounds.values()]
      .filter((row) => row.agentId === agentId && this.#owned(row, ownerAddress))
      .sort((a, b) => a.roundNo - b.roundNo)
      .map((row) => structuredClone(row));
  }

  #canInsert(input: DcaRoundInsert): boolean {
    if (this.#rounds.has(this.#roundKey(input.agentId, input.roundNo))) return false;
    return ![...this.#rounds.values()].some((row) => row.agentId === input.agentId && row.phase !== "settled");
  }

  async insertRound(input: DcaRoundInsert): Promise<DcaRoundRow | null> {
    if (!this.#canInsert(input)) return null;
    const row = roundFromInsert(input);
    this.#rounds.set(this.#roundKey(row.agentId, row.roundNo), row);
    return structuredClone(row);
  }

  #canWrite(row: DcaRoundRow): boolean {
    const current = this.#rounds.get(this.#roundKey(row.agentId, row.roundNo));
    if (current === undefined || current.ownerAddress !== ownerKey(row.ownerAddress) || current.rowVersion !== row.rowVersion) return false;
    return row.phase === "settled"
      || ![...this.#rounds.values()].some((other) => other.agentId === row.agentId && other.roundNo !== row.roundNo && other.phase !== "settled");
  }

  #write(row: DcaRoundRow): DcaRoundRow {
    const next = { ...row, ownerAddress: ownerKey(row.ownerAddress), rowVersion: row.rowVersion + 1 };
    this.#rounds.set(this.#roundKey(row.agentId, row.roundNo), next);
    return next;
  }

  async writeRound(row: DcaRoundRow): Promise<DcaRoundRow | null> {
    return this.#canWrite(row) ? structuredClone(this.#write(row)) : null;
  }

  async listOrders(agentId: string, roundNo: number): Promise<readonly DcaOrderRow[]> {
    return [...this.#orders.values()]
      .filter((row) => row.agentId === agentId && row.roundNo === roundNo)
      .sort((a, b) => a.orderKey.localeCompare(b.orderKey))
      .map((row) => structuredClone(row));
  }

  #canPut(row: DcaOrderRow): boolean {
    return row.tokenId === null || ![...this.#orders.values()].some((other) =>
      other.tokenId === row.tokenId && !(other.agentId === row.agentId && other.orderKey === row.orderKey));
  }

  async putOrder(row: DcaOrderRow): Promise<void> {
    if (!this.#canPut(row)) throw new Error("dca_orders: token id already belongs to another order.");
    this.#orders.set(this.#orderKey(row.agentId, row.orderKey), structuredClone(row));
  }

  async claimAction(input: DcaClaimInput): Promise<DcaClaimResult> {
    const round = this.#rounds.get(this.#roundKey(input.agentId, input.roundNo));
    const inFlight = [...this.#actions.values()].some((row) => row.agentId === input.agentId && IN_FLIGHT.has(row.state));
    if (inFlight || round === undefined || round.ownerAddress !== ownerKey(input.ownerAddress)
      || round.rowVersion !== input.expectedRowVersion) return { kind: "dca_round_changed" };
    const seq = [...this.#actions.values()].filter((row) => row.agentId === input.agentId && row.roundNo === input.roundNo).length + 1;
    const action: DcaActionRow = {
      actionKey: actionKeyFor(input.agentId, input.roundNo, seq), agentId: input.agentId,
      ownerAddress: ownerKey(input.ownerAddress), roundNo: input.roundNo, kind: input.plan.kind,
      plan: structuredClone(input.plan), state: "intended", txHash: null, callsHash: null, note: null,
      createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
    };
    this.#actions.set(action.actionKey, action);
    this.#rounds.set(this.#roundKey(round.agentId, round.roundNo), { ...round, rowVersion: round.rowVersion + 1, updatedAtMs: input.nowMs });
    return { kind: "claimed", action: structuredClone(action), roundRowVersion: round.rowVersion + 1 };
  }

  async getAction(ownerAddress: Address, actionKey: string): Promise<DcaActionRow | null> {
    const row = this.#actions.get(actionKey);
    return row === undefined || !this.#owned(row, ownerAddress) ? null : structuredClone(row);
  }

  async listActions(ownerAddress: Address, agentId: string): Promise<readonly DcaActionRow[]> {
    return [...this.#actions.values()]
      .filter((row) => row.agentId === agentId && this.#owned(row, ownerAddress))
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.actionKey.localeCompare(b.actionKey))
      .map((row) => structuredClone(row));
  }

  #releaseOrders(agentId: string, actionKey: string, nowMs: number): void {
    for (const [key, row] of [...this.#orders.entries()]) {
      if (row.agentId !== agentId) continue;
      if (row.state === "minting" && row.createdByAction === actionKey) {
        if (row.role === "tp") this.#orders.delete(key);
        else this.#orders.set(key, { ...row, state: "pending", tokenId: null, liquidity: 0n, createdByAction: null, updatedAtMs: nowMs });
      } else if (row.state === "exiting" && row.exitedByAction === actionKey) {
        this.#orders.set(key, { ...row, state: "live", exitedByAction: null, updatedAtMs: nowMs });
      }
    }
  }

  async setActionState(input: Parameters<DcaRoundStore["setActionState"]>[0]): Promise<DcaActionRow | null> {
    const row = this.#actions.get(input.actionKey);
    if (row === undefined || !this.#owned(row, input.ownerAddress) || !input.from.includes(row.state)) return null;
    if (IN_FLIGHT.has(input.to) && !IN_FLIGHT.has(row.state)
      && [...this.#actions.values()].some((other) => other.agentId === row.agentId && IN_FLIGHT.has(other.state))) {
      // The memory twin of `dca_actions_one_in_flight`.
      throw new Error("dca_actions: the agent already has an action in flight.");
    }
    const next: DcaActionRow = {
      ...row, state: input.to,
      txHash: input.txHash === undefined ? row.txHash : input.txHash,
      callsHash: input.callsHash === undefined ? row.callsHash : input.callsHash,
      note: input.note === undefined ? row.note : input.note,
      updatedAtMs: input.nowMs,
    };
    this.#actions.set(row.actionKey, next);
    if (input.to === "rolled-back") this.#releaseOrders(row.agentId, row.actionKey, input.nowMs);
    return structuredClone(next);
  }

  async finishAction(input: DcaFinishInput): Promise<DcaActionRow> {
    const row = this.#actions.get(input.actionKey);
    if (row === undefined || !this.#owned(row, input.ownerAddress)) throw new Error("dca_actions: the action does not exist.");
    if (!FINISHABLE.includes(row.state)) throw new Error(`dca_actions: an action in state ${row.state} cannot finish.`);
    if (!samePlan(row.plan, input.plan)) {
      throw new Error("dca_actions: the finish was derived for a different plan; the persisted plan wins (I4).");
    }
    // Validate every write before the first mutation: there is no rollback here.
    const settled = new Set(input.roundWrites.filter((round) => round.phase === "settled").map((round) => round.roundNo));
    for (const round of input.roundWrites) {
      const current = this.#rounds.get(this.#roundKey(round.agentId, round.roundNo));
      if (current === undefined || current.ownerAddress !== ownerKey(round.ownerAddress) || current.rowVersion !== round.rowVersion) {
        throw new Error("dca_rounds: the round changed under the finish.");
      }
    }
    for (const insert of input.roundInserts) {
      if (this.#rounds.has(this.#roundKey(insert.agentId, insert.roundNo))
        || [...this.#rounds.values()].some((other) => other.agentId === insert.agentId && other.phase !== "settled" && !settled.has(other.roundNo))) {
        throw new Error("dca_rounds: the next round cannot open while another is open.");
      }
    }
    for (const order of input.orders) {
      if (!this.#canPut(order)) throw new Error("dca_orders: token id already belongs to another order.");
    }
    for (const round of input.roundWrites) this.#write(round);
    for (const insert of input.roundInserts) {
      const opened = roundFromInsert(insert);
      this.#rounds.set(this.#roundKey(opened.agentId, opened.roundNo), opened);
    }
    for (const order of input.orders) this.#orders.set(this.#orderKey(order.agentId, order.orderKey), structuredClone(order));
    const next: DcaActionRow = { ...row, state: "finished", updatedAtMs: input.nowMs };
    this.#actions.set(row.actionKey, next);
    return structuredClone(next);
  }

  async releaseOrphan(input: { readonly ownerAddress: Address; readonly actionKey: string; readonly nowMs: number }): Promise<boolean> {
    const row = this.#actions.get(input.actionKey);
    if (row === undefined || !this.#owned(row, input.ownerAddress) || row.state !== "intended"
      || input.nowMs - row.createdAtMs < RECONCILE_MIN_ROW_AGE_MS) return false;
    return (await this.setActionState({ ownerAddress: input.ownerAddress, actionKey: row.actionKey, from: ["intended"], to: "rolled-back", nowMs: input.nowMs })) !== null;
  }
}

/* -------------------------------------------------------------------------- */
/* PostgreSQL backend                                                         */
/* -------------------------------------------------------------------------- */

const DCA_ROUNDS_DDL = `
  create table if not exists dca_rounds (
    agent_id text not null,
    owner_address text not null,
    round_no integer not null check (round_no >= 1),
    phase text not null check (phase in ('starting','active','closing','settled','stopped')),
    row_version integer not null default 1,
    p0_usdt_wei numeric null,
    p0_stock_wei numeric null,
    cost_usdt_wei numeric not null default 0,
    stock_acquired_wei numeric not null default 0,
    usdt_collected_wei numeric not null default 0,
    sale_proceeds_wei numeric not null default 0,
    carried_stock_wei numeric not null default 0,
    carried_cost_wei numeric not null default 0,
    sl_baseline_wei numeric not null,
    sl_count integer not null default 0,
    sl_last_block numeric null,
    sl_last_at_ms bigint null,
    close_cause text null,
    realized_pnl_wei numeric null,
    unreliable boolean not null default false,
    revert_streak integer not null default 0,
    backoff_until_ms bigint null,
    opened_at_ms bigint not null,
    settled_at_ms bigint null,
    stopped_at_ms bigint null,
    updated_at_ms bigint not null,
    primary key (agent_id, round_no)
  )
`;

/** §11.1: one open round per agent. */
const DCA_ROUNDS_OPEN_DDL = `
  create unique index if not exists dca_rounds_one_open
    on dca_rounds (agent_id) where phase <> 'settled'
`;

/** AUTO-DCA R4.3: the removed round's ledger, additive and idempotent (`agents.ts:1936-1941` precedent). */
const DCA_ROUNDS_UNSOLD_DDL = `
  alter table dca_rounds add column if not exists unsold_stock_wei numeric null;
  alter table dca_rounds add column if not exists unsold_cost_wei numeric null;
  alter table dca_rounds add column if not exists unsold_value_wei numeric null
`;

const DCA_ORDERS_DDL = `
  create table if not exists dca_orders (
    agent_id text not null,
    round_no integer not null,
    order_key text not null,
    role text not null check (role in ('level','tp')),
    level_no integer null,
    tick_lower integer not null,
    tick_upper integer not null,
    token_id numeric null,
    state text not null check (state in ('pending','skipped','minting','live','exiting','exited')),
    liquidity numeric not null default 0,
    minted_usdt_wei numeric not null default 0,
    minted_stock_wei numeric not null default 0,
    collected_usdt_wei numeric not null default 0,
    collected_stock_wei numeric not null default 0,
    cross_count integer not null default 0,
    cross_last_block numeric null,
    cross_last_at_ms bigint null,
    created_by_action text null,
    exited_by_action text null,
    last_seen_live_block numeric null,
    closed_by text null check (closed_by is null or closed_by in ('plane','owner','elsewhere')),
    updated_at_ms bigint not null,
    primary key (agent_id, order_key)
  )
`;

const DCA_ORDERS_TOKEN_DDL = `
  create unique index if not exists dca_orders_token
    on dca_orders (token_id) where token_id is not null
`;

const DCA_ACTIONS_DDL = `
  create table if not exists dca_actions (
    action_key text primary key,
    agent_id text not null,
    owner_address text not null,
    round_no integer not null,
    kind text not null check (kind in ('start','close-start','close','level-place','fill','stop-loss','remove','tp-place')),
    plan_json jsonb not null,
    state text not null check (state in ('intended','submitted','committed','rolled-back','unknown','finished')),
    tx_hash text null,
    calls_hash text null,
    note text null,
    created_at_ms bigint not null,
    updated_at_ms bigint not null
  )
`;

/** I3 / R2.7: one action `intended` or `submitted` per agent; `unknown` is outside it. */
const DCA_ACTIONS_IN_FLIGHT_DDL = `
  create unique index if not exists dca_actions_one_in_flight
    on dca_actions (agent_id) where state in ('intended','submitted')
`;

const ROUND_COLUMNS = `agent_id, owner_address, round_no, phase, row_version, p0_usdt_wei, p0_stock_wei,
  cost_usdt_wei, stock_acquired_wei, usdt_collected_wei, sale_proceeds_wei, carried_stock_wei, carried_cost_wei,
  sl_baseline_wei, sl_count, sl_last_block, sl_last_at_ms, close_cause, realized_pnl_wei, unreliable,
  revert_streak, backoff_until_ms, opened_at_ms, settled_at_ms, stopped_at_ms, updated_at_ms,
  unsold_stock_wei, unsold_cost_wei, unsold_value_wei`;

const ORDER_COLUMNS = `agent_id, round_no, order_key, role, level_no, tick_lower, tick_upper, token_id, state,
  liquidity, minted_usdt_wei, minted_stock_wei, collected_usdt_wei, collected_stock_wei, cross_count,
  cross_last_block, cross_last_at_ms, created_by_action, exited_by_action, last_seen_live_block, closed_by, updated_at_ms`;

const ACTION_COLUMNS = `action_key, agent_id, owner_address, round_no, kind, plan_json, state, tx_hash, calls_hash,
  note, created_at_ms, updated_at_ms`;

type Row = Record<string, unknown>;

function num(value: unknown): bigint {
  return value === null || value === undefined ? 0n : BigInt(String(value));
}

function numOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(String(value));
}

function int(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function intOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function dec(value: bigint | null): string | null {
  return value === null ? null : value.toString(10);
}

function rowToRound(row: Row): DcaRoundRow {
  return {
    agentId: String(row["agent_id"]), ownerAddress: String(row["owner_address"]) as Address,
    roundNo: int(row["round_no"]), phase: String(row["phase"]) as DcaRoundPhase, rowVersion: int(row["row_version"]),
    p0UsdtWei: numOrNull(row["p0_usdt_wei"]), p0StockWei: numOrNull(row["p0_stock_wei"]),
    costUsdtWei: num(row["cost_usdt_wei"]), stockAcquiredWei: num(row["stock_acquired_wei"]),
    usdtCollectedWei: num(row["usdt_collected_wei"]), saleProceedsWei: num(row["sale_proceeds_wei"]),
    carriedStockWei: num(row["carried_stock_wei"]), carriedCostWei: num(row["carried_cost_wei"]),
    slBaselineWei: num(row["sl_baseline_wei"]), slCount: int(row["sl_count"]),
    slLastBlock: numOrNull(row["sl_last_block"]), slLastAtMs: intOrNull(row["sl_last_at_ms"]),
    closeCause: text(row["close_cause"]), realizedPnlWei: numOrNull(row["realized_pnl_wei"]),
    unreliable: row["unreliable"] === true || row["unreliable"] === "t" || row["unreliable"] === "true",
    revertStreak: int(row["revert_streak"]), backoffUntilMs: intOrNull(row["backoff_until_ms"]),
    openedAtMs: int(row["opened_at_ms"]), settledAtMs: intOrNull(row["settled_at_ms"]),
    stoppedAtMs: intOrNull(row["stopped_at_ms"]), updatedAtMs: int(row["updated_at_ms"]),
    unsoldStockWei: numOrNull(row["unsold_stock_wei"]), unsoldCostWei: numOrNull(row["unsold_cost_wei"]),
    unsoldValueWei: numOrNull(row["unsold_value_wei"]),
  };
}

function rowToOrder(row: Row): DcaOrderRow {
  return {
    agentId: String(row["agent_id"]), roundNo: int(row["round_no"]), orderKey: String(row["order_key"]),
    role: String(row["role"]) as DcaRole, levelNo: intOrNull(row["level_no"]),
    tickLower: int(row["tick_lower"]), tickUpper: int(row["tick_upper"]), tokenId: numOrNull(row["token_id"]),
    state: String(row["state"]) as DcaOrderState, liquidity: num(row["liquidity"]),
    mintedUsdtWei: num(row["minted_usdt_wei"]), mintedStockWei: num(row["minted_stock_wei"]),
    collectedUsdtWei: num(row["collected_usdt_wei"]), collectedStockWei: num(row["collected_stock_wei"]),
    crossCount: int(row["cross_count"]), crossLastBlock: numOrNull(row["cross_last_block"]),
    crossLastAtMs: intOrNull(row["cross_last_at_ms"]), createdByAction: text(row["created_by_action"]),
    exitedByAction: text(row["exited_by_action"]), lastSeenLiveBlock: numOrNull(row["last_seen_live_block"]),
    closedBy: text(row["closed_by"]) as DcaClosedBy | null, updatedAtMs: int(row["updated_at_ms"]),
  };
}

function rowToAction(row: Row): DcaActionRow {
  return {
    actionKey: String(row["action_key"]), agentId: String(row["agent_id"]),
    ownerAddress: String(row["owner_address"]) as Address, roundNo: int(row["round_no"]),
    kind: String(row["kind"]) as DcaBatchKind, plan: decodeJsonb(row["plan_json"]) as DcaBatchPlan,
    state: String(row["state"]) as DcaActionState, txHash: text(row["tx_hash"]) as Hex | null,
    callsHash: text(row["calls_hash"]) as Hex | null, note: text(row["note"]),
    createdAtMs: int(row["created_at_ms"]), updatedAtMs: int(row["updated_at_ms"]),
  };
}

export class PostgresDcaRoundStore implements DcaRoundStore {
  readonly #sql: SqlClient;

  private constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  static async create(sql: SqlClient): Promise<PostgresDcaRoundStore> {
    await sql.query(DCA_ROUNDS_DDL);
    await sql.query(DCA_ROUNDS_UNSOLD_DDL);
    await sql.query(DCA_ROUNDS_OPEN_DDL);
    await sql.query(DCA_ORDERS_DDL);
    await sql.query(DCA_ORDERS_TOKEN_DDL);
    await sql.query(DCA_ACTIONS_DDL);
    await sql.query(DCA_ACTIONS_IN_FLIGHT_DDL);
    return new PostgresDcaRoundStore(sql);
  }

  async withDcaFence<T>(ownerAddress: Address, agentId: string, work: (sql: SqlClient | undefined) => Promise<T>): Promise<T> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* dcaRounds.fence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [DCA_LOCK_CLASSID, agentId]);
      const settings = await tx.query(
        `/* dcaRounds.fenceSettings */ select agent_id from trade_settings
         where agent_id = $1 and owner_address = $2 for update`,
        [agentId, ownerKey(ownerAddress)],
      );
      if (settings.rows.length === 0) throw new Error("Trade settings are unavailable.");
      return work(tx);
    });
  }

  async getOpenRound(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<DcaRoundRow | null> {
    const result = await (sql ?? this.#sql).query<Row>(
      `/* dcaRounds.getOpen */ select ${ROUND_COLUMNS} from dca_rounds
       where agent_id = $1 and owner_address = $2 and phase <> 'settled'`,
      [agentId, ownerKey(ownerAddress)],
    );
    return result.rows[0] === undefined ? null : rowToRound(result.rows[0]);
  }

  async listRounds(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<readonly DcaRoundRow[]> {
    const result = await (sql ?? this.#sql).query<Row>(
      `/* dcaRounds.list */ select ${ROUND_COLUMNS} from dca_rounds
       where agent_id = $1 and owner_address = $2 order by round_no asc`,
      [agentId, ownerKey(ownerAddress)],
    );
    return result.rows.map(rowToRound);
  }

  async insertRound(input: DcaRoundInsert, sql?: SqlClient): Promise<DcaRoundRow | null> {
    const result = await (sql ?? this.#sql).query<Row>(
      `/* dcaRounds.insert */
       insert into dca_rounds (agent_id, owner_address, round_no, phase, row_version, p0_usdt_wei, p0_stock_wei,
         cost_usdt_wei, stock_acquired_wei, carried_stock_wei, carried_cost_wei, sl_baseline_wei,
         opened_at_ms, updated_at_ms)
       values ($1, $2, $3::integer, $4, 1, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric,
         $10::numeric, $11::numeric, $12::bigint, $12::bigint)
       on conflict do nothing
       returning ${ROUND_COLUMNS}`,
      [
        input.agentId, ownerKey(input.ownerAddress), input.roundNo, input.phase, dec(input.p0UsdtWei), dec(input.p0StockWei),
        dec(input.costUsdtWei), dec(input.stockAcquiredWei), dec(input.carriedStockWei), dec(input.carriedCostWei),
        dec(input.slBaselineWei), input.nowMs,
      ],
    );
    return result.rows[0] === undefined ? null : rowToRound(result.rows[0]);
  }

  async writeRound(row: DcaRoundRow, sql?: SqlClient): Promise<DcaRoundRow | null> {
    const result = await (sql ?? this.#sql).query<Row>(
      `/* dcaRounds.write */
       update dca_rounds set phase = $5, row_version = row_version + 1,
         p0_usdt_wei = $6::numeric, p0_stock_wei = $7::numeric, cost_usdt_wei = $8::numeric,
         stock_acquired_wei = $9::numeric, usdt_collected_wei = $10::numeric, sale_proceeds_wei = $11::numeric,
         carried_stock_wei = $12::numeric, carried_cost_wei = $13::numeric, sl_baseline_wei = $14::numeric,
         sl_count = $15::integer, sl_last_block = $16::numeric, sl_last_at_ms = $17::bigint, close_cause = $18,
         realized_pnl_wei = $19::numeric, unreliable = $20::boolean, revert_streak = $21::integer,
         backoff_until_ms = $22::bigint, settled_at_ms = $23::bigint, stopped_at_ms = $24::bigint,
         updated_at_ms = $25::bigint, unsold_stock_wei = $26::numeric, unsold_cost_wei = $27::numeric,
         unsold_value_wei = $28::numeric
       where agent_id = $1 and owner_address = $2 and round_no = $3::integer and row_version = $4::integer
       returning ${ROUND_COLUMNS}`,
      [
        row.agentId, ownerKey(row.ownerAddress), row.roundNo, row.rowVersion, row.phase,
        dec(row.p0UsdtWei), dec(row.p0StockWei), dec(row.costUsdtWei), dec(row.stockAcquiredWei),
        dec(row.usdtCollectedWei), dec(row.saleProceedsWei), dec(row.carriedStockWei), dec(row.carriedCostWei),
        dec(row.slBaselineWei), row.slCount, dec(row.slLastBlock), row.slLastAtMs, row.closeCause,
        dec(row.realizedPnlWei), row.unreliable, row.revertStreak, row.backoffUntilMs, row.settledAtMs,
        row.stoppedAtMs, row.updatedAtMs, dec(row.unsoldStockWei), dec(row.unsoldCostWei), dec(row.unsoldValueWei),
      ],
    );
    return result.rows[0] === undefined ? null : rowToRound(result.rows[0]);
  }

  async listOrders(agentId: string, roundNo: number, sql?: SqlClient): Promise<readonly DcaOrderRow[]> {
    const result = await (sql ?? this.#sql).query<Row>(
      `/* dcaOrders.list */ select ${ORDER_COLUMNS} from dca_orders
       where agent_id = $1 and round_no = $2::integer order by order_key asc`,
      [agentId, roundNo],
    );
    return result.rows.map(rowToOrder);
  }

  async putOrder(row: DcaOrderRow, sql?: SqlClient): Promise<void> {
    await (sql ?? this.#sql).query(
      `/* dcaOrders.put */
       insert into dca_orders (${ORDER_COLUMNS})
       values ($1, $2::integer, $3, $4, $5::integer, $6::integer, $7::integer, $8::numeric, $9, $10::numeric,
         $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15::integer, $16::numeric, $17::bigint,
         $18, $19, $20::numeric, $21, $22::bigint)
       on conflict (agent_id, order_key) do update set
         round_no = excluded.round_no, role = excluded.role, level_no = excluded.level_no,
         tick_lower = excluded.tick_lower, tick_upper = excluded.tick_upper, token_id = excluded.token_id,
         state = excluded.state, liquidity = excluded.liquidity, minted_usdt_wei = excluded.minted_usdt_wei,
         minted_stock_wei = excluded.minted_stock_wei, collected_usdt_wei = excluded.collected_usdt_wei,
         collected_stock_wei = excluded.collected_stock_wei, cross_count = excluded.cross_count,
         cross_last_block = excluded.cross_last_block, cross_last_at_ms = excluded.cross_last_at_ms,
         created_by_action = excluded.created_by_action, exited_by_action = excluded.exited_by_action,
         last_seen_live_block = excluded.last_seen_live_block, closed_by = excluded.closed_by,
         updated_at_ms = excluded.updated_at_ms`,
      [
        row.agentId, row.roundNo, row.orderKey, row.role, row.levelNo, row.tickLower, row.tickUpper,
        dec(row.tokenId), row.state, dec(row.liquidity), dec(row.mintedUsdtWei), dec(row.mintedStockWei),
        dec(row.collectedUsdtWei), dec(row.collectedStockWei), row.crossCount, dec(row.crossLastBlock),
        row.crossLastAtMs, row.createdByAction, row.exitedByAction, dec(row.lastSeenLiveBlock), row.closedBy,
        row.updatedAtMs,
      ],
    );
  }

  async claimAction(input: DcaClaimInput, sql?: SqlClient): Promise<DcaClaimResult> {
    // ONE statement: the insert is conditional on the empty in-flight slot and
    // the round's version; `on conflict do nothing` turns a racing insert into
    // zero rows instead of an aborted transaction; the round bump runs only if
    // the insert did.
    const result = await (sql ?? this.#sql).query<Row>(
      `/* dcaActions.claim */
       with inserted as (
         insert into dca_actions (action_key, agent_id, owner_address, round_no, kind, plan_json, state,
           created_at_ms, updated_at_ms)
         select 'dca:' || $1 || ':' || $3::integer || ':'
             || ((select count(*) from dca_actions prior where prior.agent_id = $1 and prior.round_no = $3::integer) + 1),
           $1, $2, $3::integer, $5, $6::jsonb, 'intended', $7::bigint, $7::bigint
         where not exists (select 1 from dca_actions busy
             where busy.agent_id = $1 and busy.state in ('intended','submitted'))
           and exists (select 1 from dca_rounds r
             where r.agent_id = $1 and r.owner_address = $2 and r.round_no = $3::integer and r.row_version = $4::integer)
         on conflict do nothing
         returning ${ACTION_COLUMNS}
       ), bumped as (
         update dca_rounds set row_version = row_version + 1, updated_at_ms = $7::bigint
         where agent_id = $1 and owner_address = $2 and round_no = $3::integer and row_version = $4::integer
           and exists (select 1 from inserted)
         returning row_version
       )
       select inserted.*, bumped.row_version as round_row_version from inserted cross join bumped`,
      [
        input.agentId, ownerKey(input.ownerAddress), input.roundNo, input.expectedRowVersion,
        input.plan.kind, encodeJsonbParam(input.plan), input.nowMs,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) return { kind: "dca_round_changed" };
    return { kind: "claimed", action: rowToAction(row), roundRowVersion: int(row["round_row_version"]) };
  }

  async getAction(ownerAddress: Address, actionKey: string, sql?: SqlClient): Promise<DcaActionRow | null> {
    const result = await (sql ?? this.#sql).query<Row>(
      `/* dcaActions.get */ select ${ACTION_COLUMNS} from dca_actions where action_key = $1 and owner_address = $2`,
      [actionKey, ownerKey(ownerAddress)],
    );
    return result.rows[0] === undefined ? null : rowToAction(result.rows[0]);
  }

  async listActions(ownerAddress: Address, agentId: string, sql?: SqlClient): Promise<readonly DcaActionRow[]> {
    const result = await (sql ?? this.#sql).query<Row>(
      `/* dcaActions.list */ select ${ACTION_COLUMNS} from dca_actions
       where agent_id = $1 and owner_address = $2 order by created_at_ms asc, action_key asc`,
      [agentId, ownerKey(ownerAddress)],
    );
    return result.rows.map(rowToAction);
  }

  async setActionState(input: Parameters<DcaRoundStore["setActionState"]>[0], sql?: SqlClient): Promise<DcaActionRow | null> {
    const run = async (tx: SqlClient): Promise<DcaActionRow | null> => {
      const result = await tx.query<Row>(
        `/* dcaActions.setState */
         update dca_actions set state = $4,
           tx_hash = case when $5::boolean then $6 else tx_hash end,
           calls_hash = case when $7::boolean then $8 else calls_hash end,
           note = case when $9::boolean then $10 else note end,
           updated_at_ms = $11::bigint
         where action_key = $1 and owner_address = $2 and state = any($3::text[])
         returning ${ACTION_COLUMNS}`,
        [
          input.actionKey, ownerKey(input.ownerAddress), [...input.from], input.to,
          input.txHash !== undefined, input.txHash ?? null, input.callsHash !== undefined, input.callsHash ?? null,
          input.note !== undefined, input.note ?? null, input.nowMs,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const action = rowToAction(row);
      if (input.to === "rolled-back") await this.#releaseOrders(tx, action.agentId, action.actionKey, input.nowMs);
      return action;
    };
    return sql === undefined ? this.#sql.transaction(run) : run(sql);
  }

  async #releaseOrders(tx: SqlClient, agentId: string, actionKey: string, nowMs: number): Promise<void> {
    await tx.query(
      `/* dcaOrders.dropMintingTp */ delete from dca_orders
       where agent_id = $1 and created_by_action = $2 and state = 'minting' and role = 'tp'`,
      [agentId, actionKey],
    );
    await tx.query(
      `/* dcaOrders.releaseMintingLevel */ update dca_orders
       set state = 'pending', token_id = null, liquidity = 0, created_by_action = null, updated_at_ms = $3::bigint
       where agent_id = $1 and created_by_action = $2 and state = 'minting' and role = 'level'`,
      [agentId, actionKey, nowMs],
    );
    await tx.query(
      `/* dcaOrders.releaseExiting */ update dca_orders
       set state = 'live', exited_by_action = null, updated_at_ms = $3::bigint
       where agent_id = $1 and exited_by_action = $2 and state = 'exiting'`,
      [agentId, actionKey, nowMs],
    );
  }

  async finishAction(input: DcaFinishInput, sql?: SqlClient): Promise<DcaActionRow> {
    const run = async (tx: SqlClient): Promise<DcaActionRow> => {
      const current = await tx.query<Row>(
        `/* dcaActions.getForFinish */ select ${ACTION_COLUMNS} from dca_actions
         where action_key = $1 and owner_address = $2 for update`,
        [input.actionKey, ownerKey(input.ownerAddress)],
      );
      const row = current.rows[0];
      if (row === undefined) throw new Error("dca_actions: the action does not exist.");
      const action = rowToAction(row);
      if (!FINISHABLE.includes(action.state)) throw new Error(`dca_actions: an action in state ${action.state} cannot finish.`);
      if (!samePlan(action.plan, input.plan)) {
        throw new Error("dca_actions: the finish was derived for a different plan; the persisted plan wins (I4).");
      }
      for (const round of input.roundWrites) {
        if (await this.writeRound(round, tx) === null) throw new Error("dca_rounds: the round changed under the finish.");
      }
      for (const insert of input.roundInserts) {
        if (await this.insertRound(insert, tx) === null) throw new Error("dca_rounds: the next round cannot open while another is open.");
      }
      for (const order of input.orders) await this.putOrder(order, tx);
      const finished = await tx.query<Row>(
        `/* dcaActions.finish */ update dca_actions set state = 'finished', updated_at_ms = $3::bigint
         where action_key = $1 and owner_address = $2 returning ${ACTION_COLUMNS}`,
        [input.actionKey, ownerKey(input.ownerAddress), input.nowMs],
      );
      return rowToAction(finished.rows[0]!);
    };
    return sql === undefined ? this.#sql.transaction(run) : run(sql);
  }

  async releaseOrphan(input: { readonly ownerAddress: Address; readonly actionKey: string; readonly nowMs: number }, sql?: SqlClient): Promise<boolean> {
    const run = async (tx: SqlClient): Promise<boolean> => {
      const result = await tx.query<Row>(
        `/* dcaActions.releaseOrphan */ update dca_actions set state = 'rolled-back', updated_at_ms = $3::bigint
         where action_key = $1 and owner_address = $2 and state = 'intended' and created_at_ms <= $4::bigint
         returning agent_id`,
        [input.actionKey, ownerKey(input.ownerAddress), input.nowMs, input.nowMs - RECONCILE_MIN_ROW_AGE_MS],
      );
      const row = result.rows[0];
      if (row === undefined) return false;
      await this.#releaseOrders(tx, String(row["agent_id"]), input.actionKey, input.nowMs);
      return true;
    };
    return sql === undefined ? this.#sql.transaction(run) : run(sql);
  }
}

/** Postgres when `DATABASE_URL` is set, memory otherwise (the quant precedent). */
export async function createDcaRoundStore(): Promise<DcaRoundStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const store = await PostgresDcaRoundStore.create(await createPgSqlClient(connectionString));
    console.log("[dca-round-store] backend=postgres");
    return store;
  }
  console.log("[dca-round-store] backend=memory (DATABASE_URL not set)");
  return new MemoryDcaRoundStore();
}
