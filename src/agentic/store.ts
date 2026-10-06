import { hkdfSync } from "node:crypto";
import type { Address, Hex } from "viem";
import { canonicalEncode } from "../auth/canonical.js";
import { encryptSecret, decryptSecret } from "../store/crypto.js";
import { encodeJsonbParam, decodeJsonb } from "../store/codec.js";
import type { AgentStore } from "../store/agents.js";
import type { ExecutionJournal } from "../store/journal.js";
import type { TradeIntentStore } from "../store/tradeIntents.js";
import type { CmcBudgetStore } from "../store/tradeCmc.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import type { SqlClient } from "../store/sql.js";
import { agenticAddress, type AgenticWallet, type AgenticOrder, type AgenticFence, type AgenticInstance,
  type AgenticGateRun, type AgenticSession, type AgenticDcaRound, type AgenticDcaOrder, type AgenticMemePaper, type AgenticMemeLog } from "./domain.js";

export const AGENTIC_DDL: readonly string[] = [
`create table if not exists agentic_wallets (
  pairing_id text primary key,                 -- UUID v4
  state text not null check (state in ('waiting','verified','paired','cleaning','hiring','bound','ending','ended','failed','expired')),
  wallet_address text, owner_address text,     -- W, both null until verified
  pairing_secret_hash text not null,
  qr jsonb,                                    -- {qrCodeId, urlForWeb, expireAtMs}
  code_hash text not null, code_attempts integer not null default 0, code_matched_at bigint,
  verified_at bigint, continuation_deadline bigint,   -- verified_at + 1 800 000 (§5.4)
  session_ciphertext text,                     -- §3.4
  facts_read jsonb,                            -- last raw status/settings/balances read (non-secret), readAtMs
  hire_op_id text unique, agent_id text unique, hire_params jsonb, hire_stage text,
  accepted_at bigint,                          -- written at stage accepted, before any gate work
  hire_facts jsonb,                            -- immutable once written (§7.2 stage gated)
  hire_end_ms bigint, entry_cutoff_ms bigint, term_end_action text check (term_end_action in ('sell-all','keep')),
  drain_requested_at bigint,
  settings_hold jsonb, entries_stopped jsonb,
  probe jsonb,                                 -- {lastAtMs, firstUAtMs|null, unreachableAtMs|null}
  end_reason text check (end_reason in ('owner-signed-out','term-ended')),
  end_blockers jsonb,                          -- {atMs, settingsHold, paused, halted, heldObligations}, written once in the CAS that leaves bound (§11.1, §11.3)
  end_stage text, logout jsonb,                -- §11.3 stages and attempts
  cleanup_reason text, failure text,
  version integer not null default 1, created_at bigint not null, updated_at bigint not null,
  check (state in ('waiting','failed','expired') or (wallet_address is not null and owner_address = wallet_address)),
  check (session_ciphertext is null or state in ('verified','paired','cleaning','hiring','bound','ending'))
);
create unique index if not exists agentic_wallets_active_wallet on agentic_wallets (wallet_address) where state in ('hiring','bound','ending');
`,
`create table if not exists agentic_orders (
  idempotency_key text primary key,            -- swaps: the journal key; signs: 'x402-sign:' || operation id
  kind text not null check (kind in ('swap','x402-sign')),
  wallet_address text not null, agent_id text not null, decision_id text,
  side text, from_token text, to_token text, amount_atomic text, intended_raw text, from_qty text,
  min_out_atomic text, binance_quote_out_atomic text, slippage_pct text, multiplier_pre text, multiplier_used text,
  list_snapshot jsonb,                         -- {takenAtMs, startTimeMs, ids:[...]}
  operation_id text, wallet_nonce_pre text,    -- signs (evidence only)
  quote_at bigint,                             -- database clock
  dispatch text not null check (dispatch in ('unclaimed','spawned','sealed','not-started')),
  claimed_at bigint, claimant text, fence_token bigint, claim_deadline bigint,   -- claimant = process instance id (§4.6)
  response text check (response in ('accepted','rejected','no-response')), cli_result text,
  returned_order_id text, listed_order_id text, tx_hash text, approve_tx_hash text,
  outcome text not null check (outcome in ('open','committed','rolled-back')),
  hold_reason text, evidence jsonb,
  fill_check text not null default 'none' check (fill_check in ('none','pending','ok','breached')),
  created_at bigint not null, updated_at bigint not null
);
create unique index if not exists agentic_orders_list_id on agentic_orders (wallet_address, listed_order_id) where listed_order_id is not null;
create unique index if not exists agentic_orders_tx on agentic_orders (tx_hash) where tx_hash is not null;
`,
`create table if not exists agentic_instances (
  instance_id text primary key,                -- random UUID generated at process start
  service text not null check (service in ('execution-api','trade-worker','agentic-gate')),
  host text not null, pid integer not null,
  machine_id text,                             -- Linux: /etc/machine-id; Windows: HKLM\SOFTWARE\Microsoft\Cryptography MachineGuid
  os_boot_marker text,                         -- Linux: /proc/sys/kernel/random/boot_id; Windows: Win32_OperatingSystem.LastBootUpTime (UTC ISO)
  railway_deployment_id text, railway_replica_id text,   -- RAILWAY_DEPLOYMENT_ID / RAILWAY_REPLICA_ID when set, else null
  check (railway_deployment_id is not null or (machine_id is not null and os_boot_marker is not null)),
  boot_at bigint not null, heartbeat_at bigint not null,   -- database clock
  retired_at bigint, retired_by text           -- retired_by: closed code ('dispose','exit')
);
`,
`create table if not exists agentic_wallet_fences(wallet_address text primary key, token bigint not null, holder text not null, lease_until bigint not null);`,
`create table if not exists agentic_gate_runs(run_id text primary key, gate text not null, agent_id text not null, wallet text not null, side text not null, max_dispatches integer not null, dispatches integer not null, max_notional_usdt text not null, max_cmc_payments integer not null, cmc_payments integer not null, cmc_operation_ids jsonb not null, deadline_ms bigint not null, created_at bigint not null, closed_at bigint);`,
// AGENTIC-DCA-SPEC 3.3 (Revisions 2, 2.2): appended last so the entries above keep their positions; every statement is idempotent.
`alter table agentic_orders drop constraint if exists agentic_orders_kind_check;
alter table agentic_orders add constraint agentic_orders_kind_check check (kind in ('swap','x402-sign','limit-place','limit-cancel','earn-deposit','earn-redeem'));
alter table agentic_orders add column if not exists binance_answered_at bigint;
alter table agentic_wallets drop constraint if exists agentic_wallets_end_reason_check;
alter table agentic_wallets add constraint agentic_wallets_end_reason_check check (end_reason in ('owner-signed-out','term-ended','stop-loss'));
create table if not exists agentic_dca_rounds (
  agent_id text not null, round_no integer not null, wallet_address text not null,
  phase text not null check (phase in ('starting','active','closing','settled','stopping','stopped','winding-down','ended','interrupted')),
  base_order_key text, p0_usdt_wei numeric, p0_stock_raw numeric,
  cost_usdt_wei numeric not null, stock_raw numeric not null,
  carried_cost_wei numeric not null, carried_stock_raw numeric not null,
  sold_stock_raw numeric not null default 0, proceeds_usdt_wei numeric not null default 0,
  realized_pnl_wei numeric, marked_pnl_wei numeric,
  stop_counter jsonb, tp_filled_at bigint, close_cause text check (close_cause in ('take-profit','stop-loss','term-end','owner-end')),
  fail_streak integer not null default 0, backoff_until_ms bigint, tp_due_at bigint, opened_at bigint not null, settled_at bigint,
  row_version integer not null default 1, created_at bigint not null, updated_at bigint not null,
  primary key (agent_id, round_no));
create table if not exists agentic_dca_orders (
  order_key text primary key,
  agent_id text not null, wallet_address text not null, round_no integer not null,
  role text not null check (role in ('level','tp','probe')), level_no integer, side text not null check (side in ('buy','sell')),
  price_num numeric not null, price_den numeric not null,
  trigger_sent text not null, qty_sent text not null, qty_atomic numeric not null, slippage_pct text not null,
  place_order_key text, cancel_order_key text, strategy_id text, list_status text, unit_qty text, unit_trigger text,
  state text not null check (state in ('planned','placing','resting','triggered','cancelling','filled','cancelled','expired','failed','skipped','below-range','held')),
  closed_by text check (closed_by in ('plane','binance','external')), hold_reason text,
  tx_hash text, fill_usdt_wei numeric, fill_stock_raw numeric, executor text check (executor in ('wallet','other')),
  row_version integer not null default 1, created_at bigint not null, updated_at bigint not null);
create unique index if not exists agentic_dca_orders_strategy on agentic_dca_orders (wallet_address, strategy_id) where strategy_id is not null;
create unique index if not exists agentic_dca_orders_tx on agentic_dca_orders (tx_hash) where tx_hash is not null;
create unique index if not exists agentic_dca_rounds_open on agentic_dca_rounds (agent_id) where phase not in ('settled','stopped','ended','interrupted');
`,
// AGENTIC-MEME-STOCKS-SPEC 8.2: the paper ledger and the decision log of paper meme hires, appended last (the rule above); nothing else reads or writes them.
`create table if not exists agentic_meme_paper (
  position_id text primary key,
  agent_id text not null, wallet_address text not null, token text not null,
  symbol text, quote_token text not null, quote_symbol text,
  venue_entry text not null check (venue_entry in ('flap-bonding','pancake-v2')),
  buy_tax_bps integer not null, sell_tax_bps integer not null, token_version integer not null,
  entry_usdt text not null, gas_buy_usdt text not null, bnb_usdt_e18 text not null,
  tokens text not null, cost_bps integer not null,
  status text not null check (status in ('open','closed')),
  last_mark_usdt text, last_mark_at bigint, peak_pnl_bps integer, mark_skips integer not null default 0,
  mark_count integer not null default 0, close_requested_at bigint,
  close_code text check (close_code in ('stop','trailing','dead-chart','smart-out','flow-flip','time','drain','ended')),
  exit_usdt text, gas_sell_usdt text, pnl_usdt text, closed_at bigint,
  opened_at bigint not null, version integer not null default 1);
create unique index if not exists agentic_meme_paper_open on agentic_meme_paper (agent_id, token) where status = 'open';
create table if not exists agentic_meme_log (
  id text primary key, agent_id text,
  kind text not null check (kind in ('market','cycle','signal','llm','entry','mark','exit')),
  token text, at_ms bigint not null, data jsonb not null);
create index if not exists agentic_meme_log_agent on agentic_meme_log (agent_id, at_ms);
create index if not exists agentic_meme_log_kind on agentic_meme_log (kind, at_ms);
`
];
const CLOCK = "(extract(epoch from clock_timestamp()) * 1000)::bigint";
const WC = {
  pairingId: "pairing_id", state: "state", walletAddress: "wallet_address", ownerAddress: "owner_address",
  pairingSecretHash: "pairing_secret_hash", qr: "qr", codeHash: "code_hash", codeAttempts: "code_attempts",
  codeMatchedAt: "code_matched_at", verifiedAt: "verified_at", continuationDeadline: "continuation_deadline",
  sessionCiphertext: "session_ciphertext", factsRead: "facts_read", hireOpId: "hire_op_id", agentId: "agent_id",
  hireParams: "hire_params", hireStage: "hire_stage", acceptedAt: "accepted_at", hireFacts: "hire_facts",
  hireEndMs: "hire_end_ms", entryCutoffMs: "entry_cutoff_ms", termEndAction: "term_end_action",
  drainRequestedAt: "drain_requested_at", settingsHold: "settings_hold", entriesStopped: "entries_stopped",
  probe: "probe", endReason: "end_reason", endBlockers: "end_blockers", endStage: "end_stage", logout: "logout",
  cleanupReason: "cleanup_reason", failure: "failure", version: "version", createdAt: "created_at", updatedAt: "updated_at",
} satisfies Record<keyof AgenticWallet, string>;
const OC = {
  idempotencyKey: "idempotency_key", kind: "kind", walletAddress: "wallet_address", agentId: "agent_id",
  decisionId: "decision_id", side: "side", fromToken: "from_token", toToken: "to_token", amountAtomic: "amount_atomic",
  intendedRaw: "intended_raw", fromQty: "from_qty", minOutAtomic: "min_out_atomic", binanceQuoteOutAtomic: "binance_quote_out_atomic",
  slippagePct: "slippage_pct", multiplierPre: "multiplier_pre", multiplierUsed: "multiplier_used", listSnapshot: "list_snapshot",
  operationId: "operation_id", walletNoncePre: "wallet_nonce_pre", quoteAt: "quote_at", dispatch: "dispatch", claimedAt: "claimed_at",
  claimant: "claimant", fenceToken: "fence_token", claimDeadline: "claim_deadline", response: "response", cliResult: "cli_result",
  returnedOrderId: "returned_order_id", listedOrderId: "listed_order_id", txHash: "tx_hash", approveTxHash: "approve_tx_hash",
  outcome: "outcome", holdReason: "hold_reason", evidence: "evidence", fillCheck: "fill_check", createdAt: "created_at", updatedAt: "updated_at",
} satisfies Record<keyof AgenticOrder, string>;
const RC = { agentId: "agent_id", roundNo: "round_no", walletAddress: "wallet_address", phase: "phase", baseOrderKey: "base_order_key", p0UsdtWei: "p0_usdt_wei",
  p0StockRaw: "p0_stock_raw", costUsdtWei: "cost_usdt_wei", stockRaw: "stock_raw", carriedCostWei: "carried_cost_wei", carriedStockRaw: "carried_stock_raw",
  soldStockRaw: "sold_stock_raw", proceedsUsdtWei: "proceeds_usdt_wei", realizedPnlWei: "realized_pnl_wei", markedPnlWei: "marked_pnl_wei", stopCounter: "stop_counter",
  tpFilledAt: "tp_filled_at", closeCause: "close_cause", failStreak: "fail_streak", backoffUntilMs: "backoff_until_ms", tpDueAt: "tp_due_at", openedAt: "opened_at",
  settledAt: "settled_at", rowVersion: "row_version", createdAt: "created_at", updatedAt: "updated_at" } satisfies Record<keyof AgenticDcaRound, string>;
const DC = { orderKey: "order_key", agentId: "agent_id", walletAddress: "wallet_address", roundNo: "round_no", role: "role", levelNo: "level_no", side: "side",
  priceNum: "price_num", priceDen: "price_den", triggerSent: "trigger_sent", qtySent: "qty_sent", qtyAtomic: "qty_atomic", slippagePct: "slippage_pct",
  placeOrderKey: "place_order_key", cancelOrderKey: "cancel_order_key", strategyId: "strategy_id", listStatus: "list_status", unitQty: "unit_qty", unitTrigger: "unit_trigger",
  state: "state", closedBy: "closed_by", holdReason: "hold_reason", txHash: "tx_hash", fillUsdtWei: "fill_usdt_wei", fillStockRaw: "fill_stock_raw", executor: "executor",
  rowVersion: "row_version", createdAt: "created_at", updatedAt: "updated_at" } satisfies Record<keyof AgenticDcaOrder, string>;
const FC = { walletAddress: "wallet_address", token: "token", holder: "holder", leaseUntil: "lease_until" } satisfies Record<keyof AgenticFence, string>;
const IC = { instanceId: "instance_id", service: "service", host: "host", pid: "pid", machineId: "machine_id", osBootMarker: "os_boot_marker",
  railwayDeploymentId: "railway_deployment_id", railwayReplicaId: "railway_replica_id", bootAt: "boot_at", heartbeatAt: "heartbeat_at",
  retiredAt: "retired_at", retiredBy: "retired_by" } satisfies Record<keyof AgenticInstance, string>;
const GC = { runId: "run_id", gate: "gate", agentId: "agent_id", wallet: "wallet", side: "side", maxDispatches: "max_dispatches",
  dispatches: "dispatches", maxNotionalUsdt: "max_notional_usdt", maxCmcPayments: "max_cmc_payments", cmcPayments: "cmc_payments",
  cmcOperationIds: "cmc_operation_ids", deadlineMs: "deadline_ms", createdAt: "created_at", closedAt: "closed_at" } satisfies Record<keyof AgenticGateRun, string>;
const MC = { positionId: "position_id", agentId: "agent_id", walletAddress: "wallet_address", token: "token", symbol: "symbol", quoteToken: "quote_token", quoteSymbol: "quote_symbol",
  venueEntry: "venue_entry", buyTaxBps: "buy_tax_bps", sellTaxBps: "sell_tax_bps", tokenVersion: "token_version", entryUsdt: "entry_usdt", gasBuyUsdt: "gas_buy_usdt",
  bnbUsdtE18: "bnb_usdt_e18", tokens: "tokens", costBps: "cost_bps", status: "status", lastMarkUsdt: "last_mark_usdt", lastMarkAt: "last_mark_at", peakPnlBps: "peak_pnl_bps",
  markSkips: "mark_skips", markCount: "mark_count", closeRequestedAt: "close_requested_at", closeCode: "close_code", exitUsdt: "exit_usdt", gasSellUsdt: "gas_sell_usdt",
  pnlUsdt: "pnl_usdt", closedAt: "closed_at", openedAt: "opened_at", version: "version" } satisfies Record<keyof AgenticMemePaper, string>;
const LC = { id: "id", agentId: "agent_id", kind: "kind", token: "token", atMs: "at_ms", data: "data" } satisfies Record<keyof AgenticMemeLog, string>;
const JSON_FIELDS = new Set(["qr", "factsRead", "hireParams", "hireFacts", "settingsHold", "entriesStopped", "probe", "endBlockers", "logout", "listSnapshot", "evidence", "cmcOperationIds", "stopCounter", "data"]);
const NUMBERS = new Set(["codeAttempts", "codeMatchedAt", "verifiedAt", "continuationDeadline", "acceptedAt", "hireEndMs", "entryCutoffMs",
  "drainRequestedAt", "version", "createdAt", "updatedAt", "quoteAt", "claimedAt", "claimDeadline", "leaseUntil", "pid", "bootAt",
  "heartbeatAt", "retiredAt", "maxDispatches", "dispatches", "maxCmcPayments", "cmcPayments", "deadlineMs", "closedAt",
  "roundNo", "levelNo", "rowVersion", "failStreak", "tpFilledAt", "backoffUntilMs", "tpDueAt", "openedAt", "settledAt", "lastMarkAt", "closeRequestedAt", "atMs"]);
type Columns = Readonly<Record<string, string>>;
export type AgenticSources = { agents: AgentStore; journal: ExecutionJournal; intents: TradeIntentStore; cmc: CmcBudgetStore; killswitch: KillSwitch };

function decoded<T>(row: Record<string, unknown>, columns: Columns): T {
  return Object.fromEntries(Object.entries(columns).map(([key, column]) => {
    const value = row[column];
    return [key, value === null ? null : JSON_FIELDS.has(key) ? decodeJsonb(value) : NUMBERS.has(key) ? Number(value) : value];
  })) as T;
}

function parameters(row: object, columns: Columns): { keys: string[]; values: unknown[]; slots: string[] } {
  const entries = Object.entries(row).filter(([key]) => Object.hasOwn(columns, key));
  return { keys: entries.map(([key]) => columns[key]!),
    values: entries.map(([key, value]: [string, unknown]) => JSON_FIELDS.has(key) && value !== null ? encodeJsonbParam(value) : value),
    slots: entries.map(([key], index) => `$${index + 1}${JSON_FIELDS.has(key) ? "::jsonb" : ""}`) };
}

export function encryptAgenticSession(session: AgenticSession, master: Buffer, pairingId: string, W: Address): string {
  const key = Buffer.from(hkdfSync("sha256", master, Buffer.from("4lpha-agentic-session-v1"), Buffer.from(canonicalEncode({ pairingId, W })), 32));
  return encryptSecret(JSON.stringify(session), key);
}

export function decryptAgenticSession(row: AgenticWallet, master: Buffer): AgenticSession {
  try {
    if (row.walletAddress === null || row.sessionCiphertext === null) throw new Error();
    const key = Buffer.from(hkdfSync("sha256", master, Buffer.from("4lpha-agentic-session-v1"),
      Buffer.from(canonicalEncode({ pairingId: row.pairingId, W: row.walletAddress })), 32));
    const value: unknown = JSON.parse(decryptSecret(row.sessionCiphertext, key));
    if (typeof value !== "object" || value === null) throw new Error();
    const p = value as Record<string, unknown>;
    if (p["v"] !== 1 || typeof p["instanceId"] !== "string" || !/^[0-9a-f]{64}$/.test(p["instanceId"])
      || typeof p["sessionJson"] !== "string") throw new Error();
    return { v: 1, instanceId: p["instanceId"], sessionJson: p["sessionJson"] };
  } catch { throw new Error("AGENTIC_SESSION_DECRYPT"); }
}

export class AgenticStore {
  readonly #sql: SqlClient | null;
  readonly #sources: AgenticSources;
  readonly #now: () => number;
  readonly #wallets = new Map<string, AgenticWallet>();
  readonly #orders = new Map<string, AgenticOrder>();
  readonly #fences = new Map<string, AgenticFence>();
  readonly #instances = new Map<string, AgenticInstance>();
  readonly #runs = new Map<string, AgenticGateRun>();
  #turn: Promise<void> = Promise.resolve();

  constructor(sql: SqlClient | null, sources: AgenticSources, now: () => number = Date.now) {
    this.#sql = sql; this.#sources = sources; this.#now = now;
  }
  async initialize(): Promise<void> { if (this.#sql !== null) for (const ddl of AGENTIC_DDL) await this.#sql.query(ddl); }
  async close(): Promise<void> { await this.#sql?.close(); }
  async now(): Promise<number> {
    if (this.#sql === null) return this.#now();
    return Number((await this.#sql.query<{ ms: string }>(`select ${CLOCK} as ms`)).rows[0]!.ms);
  }
  async #locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#turn;
    let release!: () => void;
    this.#turn = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  async #select<T>(table: string, columns: Columns, where = "", params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.#sql!.query<Record<string, unknown>>(`select * from ${table} ${where}`, params);
    return result.rows.map(row => decoded<T>(row, columns));
  }
  async #insert(table: string, columns: Columns, row: object, tx: SqlClient = this.#sql!): Promise<boolean> {
    const p = parameters(row, columns);
    return (await tx.query(`insert into ${table} (${p.keys.join(",")}) values (${p.slots.join(",")}) on conflict do nothing returning *`, p.values)).rows.length === 1;
  }
  async #update<T>(table: string, columns: Columns, patch: object, where: string, values: readonly unknown[], tx: SqlClient = this.#sql!): Promise<T | null> {
    const p = parameters(patch, columns);
    const shifted = where.replace(/\$(\d+)/g, (_match: string, index: string) => `$${Number(index) + p.values.length}`);
    const result = await tx.query<Record<string, unknown>>(`update ${table} set ${p.keys.map((k, i) => k + "=" + p.slots[i]!).join(",")} where ${shifted} returning *`, [...p.values, ...values]);
    return result.rows[0] === undefined ? null : decoded<T>(result.rows[0], columns);
  }
  async wallets(): Promise<AgenticWallet[]> { return this.#sql === null ? structuredClone([...this.#wallets.values()]) : this.#select("agentic_wallets", WC); }
  async getWallet(id: string): Promise<AgenticWallet | null> {
    return this.#sql === null ? structuredClone(this.#wallets.get(id) ?? null) : (await this.#select<AgenticWallet>("agentic_wallets", WC, "where pairing_id=$1", [id]))[0] ?? null;
  }
  async byAgent(id: string): Promise<AgenticWallet | null> {
    return (await this.wallets()).find(row => row.agentId === id) ?? null;
  }
  async createWallet(row: AgenticWallet): Promise<boolean> {
    if (this.#sql !== null) return this.#sql.transaction(async tx => {
      await tx.query("select pg_advisory_xact_lock(hashtext('agentic-pairing-slots'))");
      const count = await tx.query<{ n: string }>("select count(*)::text as n from agentic_wallets where state in ('waiting','verified','paired')");
      return Number(count.rows[0]!.n) < 8 && this.#insert("agentic_wallets", WC, row, tx);
    });
    return this.#locked(async () => {
      if ([...this.#wallets.values()].filter(w => ["waiting", "verified", "paired"].includes(w.state)).length >= 8 || this.#wallets.has(row.pairingId)
        || [...this.#wallets.values()].some(w => row.hireOpId !== null && w.hireOpId === row.hireOpId || row.agentId !== null && w.agentId === row.agentId
          || ["hiring", "bound", "ending"].includes(row.state) && ["hiring", "bound", "ending"].includes(w.state) && w.walletAddress === row.walletAddress)) return false;
      this.#wallets.set(row.pairingId, structuredClone(row)); return true;
    });
  }
  async patchWallet(row: AgenticWallet, patch: Partial<AgenticWallet>): Promise<AgenticWallet | null> {
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: await this.now() };
    const transitions: Record<AgenticWallet["state"], readonly AgenticWallet["state"][]> = {
      waiting: ["verified", "failed", "expired"], verified: ["paired", "cleaning"], paired: ["hiring", "cleaning"],
      hiring: ["bound", "cleaning"], bound: ["ending", "ended"], ending: ["ended"], cleaning: ["failed", "expired"],
      ended: [], failed: [], expired: [],
    };
    if (next.state !== row.state && !transitions[row.state].includes(next.state)) throw new Error("AGENTIC_STATE_TRANSITION");
    for (const key of ["walletAddress", "ownerAddress", "hireOpId", "agentId", "hireParams", "termEndAction", "hireFacts", "hireEndMs", "entryCutoffMs", "acceptedAt"] as const) {
      if (row[key] !== null && canonicalEncode(row[key]) !== canonicalEncode(next[key])) throw new Error("AGENTIC_IMMUTABLE_HIRE");
    }
    if (row.sessionCiphertext !== null && next.sessionCiphertext !== null && row.sessionCiphertext !== next.sessionCiphertext) throw new Error("AGENTIC_IMMUTABLE_SESSION");
    if (["failed", "expired", "ended", "waiting"].includes(next.state) && next.sessionCiphertext !== null) throw new Error("AGENTIC_SESSION_STATE");
    if (!["waiting", "failed", "expired"].includes(next.state) && (next.walletAddress === null || next.ownerAddress !== next.walletAddress)) throw new Error("AGENTIC_WALLET_IDENTITY");
    if (["hiring", "bound", "ending"].includes(next.state) && (await this.wallets()).some(w => w.pairingId !== row.pairingId && w.walletAddress === next.walletAddress && ["hiring", "bound", "ending"].includes(w.state))) return null;
    if (this.#sql !== null) return this.#update("agentic_wallets", WC, { ...patch, version: next.version, updatedAt: next.updatedAt }, "pairing_id=$1 and version=$2", [row.pairingId, row.version]);
    return this.#locked(async () => {
      if (this.#wallets.get(row.pairingId)?.version !== row.version) return null;
      if ([...this.#wallets.values()].some(w => w.pairingId !== row.pairingId && (next.hireOpId !== null && w.hireOpId === next.hireOpId || next.agentId !== null && w.agentId === next.agentId))) return null;
      if (["hiring", "bound", "ending"].includes(next.state) && [...this.#wallets.values()].some(w => w.pairingId !== row.pairingId && w.walletAddress === next.walletAddress && ["hiring", "bound", "ending"].includes(w.state))) return null;
      this.#wallets.set(row.pairingId, structuredClone(next)); return structuredClone(next);
    });
  }
  async acceptHire(row: AgenticWallet, patch: Pick<AgenticWallet, "hireOpId" | "agentId" | "hireParams" | "termEndAction">): Promise<AgenticWallet | null> {
    if (this.#sql !== null) {
      const result = await this.#sql.query<Record<string, unknown>>(`with n as materialized (select ${CLOCK} as ms)
        update agentic_wallets w set state='hiring',hire_op_id=$3,agent_id=$4,hire_params=$5::jsonb,term_end_action=$6,
          hire_stage='accepted',accepted_at=n.ms,updated_at=n.ms,version=version+1 from n
        where pairing_id=$1 and version=$2 and state='paired' and code_matched_at is not null and continuation_deadline>n.ms
          and not exists(select 1 from agentic_wallets x where x.wallet_address=w.wallet_address and x.pairing_id<>w.pairing_id and x.state in ('hiring','bound','ending')) returning w.*`,
      [row.pairingId, row.version, patch.hireOpId, patch.agentId, encodeJsonbParam(patch.hireParams), patch.termEndAction]);
      return result.rows[0] === undefined ? null : decoded(result.rows[0], WC);
    }
    if (row.state !== "paired" || row.codeMatchedAt === null || row.continuationDeadline === null || row.continuationDeadline <= this.#now()) return null;
    return this.patchWallet(row, { ...patch, state: "hiring", hireStage: "accepted", acceptedAt: this.#now() });
  }
  async orders(W?: Address): Promise<AgenticOrder[]> {
    return this.#sql === null ? structuredClone([...this.#orders.values()].filter(o => W === undefined || o.walletAddress === W))
      : this.#select("agentic_orders", OC, W === undefined ? "" : "where wallet_address=$1", W === undefined ? [] : [W]);
  }
  async getOrder(key: string): Promise<AgenticOrder | null> {
    return this.#sql === null ? structuredClone(this.#orders.get(key) ?? null) : (await this.#select<AgenticOrder>("agentic_orders", OC, "where idempotency_key=$1", [key]))[0] ?? null;
  }
  #uniqueOrder(row: AgenticOrder): boolean {
    return ![...this.#orders.values()].some(o => o.idempotencyKey !== row.idempotencyKey &&
      (row.txHash !== null && o.txHash === row.txHash || row.listedOrderId !== null && o.walletAddress === row.walletAddress && o.listedOrderId === row.listedOrderId));
  }
  async createOrder(row: AgenticOrder): Promise<boolean> {
    if (this.#sql !== null) return this.#insert("agentic_orders", OC, row);
    return this.#locked(async () => { if (this.#orders.has(row.idempotencyKey) || !this.#uniqueOrder(row)) return false;
      this.#orders.set(row.idempotencyKey, structuredClone(row)); return true; });
  }
  async beginSwap(row: AgenticOrder, input: Parameters<ExecutionJournal["beginWithSpend"]>[0], sinceMs: number): ReturnType<ExecutionJournal["beginWithSpend"]> {
    if (this.#sql !== null) return this.#sql.transaction(async tx => {
      const result = await this.#sources.journal.beginWithSpend(input, sinceMs, tx);
      if (result.created && !await this.#insert("agentic_orders", OC, row, tx)) throw new Error("AGENTIC_ORDER_INSERT");
      return result;
    });
    return this.#locked(async () => {
      const journal = this.#sources.journal;
      if (journal.snapshotLandingResolutionTransaction === undefined || journal.restoreLandingResolutionTransaction === undefined) throw new Error("AGENTIC_MEMORY_TRANSACTION");
      const snapshot = journal.snapshotLandingResolutionTransaction([row.idempotencyKey]);
      try {
        const result = await journal.beginWithSpend(input, sinceMs);
        if (result.created) {
          if (this.#orders.has(row.idempotencyKey) || !this.#uniqueOrder(row)) throw new Error("AGENTIC_ORDER_INSERT");
          this.#orders.set(row.idempotencyKey, structuredClone(row));
        }
        return result;
      } catch (error) { journal.restoreLandingResolutionTransaction(snapshot); throw error; }
    });
  }
  async patchOrder(row: AgenticOrder, patch: Partial<AgenticOrder>): Promise<AgenticOrder | null> {
    const next = { ...row, ...patch, updatedAt: await this.now() };
    if (this.#sql !== null) return this.#update("agentic_orders", OC, { ...patch, updatedAt: next.updatedAt },
      "idempotency_key=$1 and dispatch=$2 and claimant is not distinct from $3 and outcome=$4 and response is not distinct from $5", [row.idempotencyKey, row.dispatch, row.claimant, row.outcome, row.response]);
    return this.#locked(async () => {
      const current = this.#orders.get(row.idempotencyKey);
      if (current === undefined || current.dispatch !== row.dispatch || current.claimant !== row.claimant || current.outcome !== row.outcome || current.response !== row.response) return null;
      const updated = { ...current, ...patch, updatedAt: next.updatedAt };
      if (!this.#uniqueOrder(updated)) return null;
      this.#orders.set(row.idempotencyKey, structuredClone(updated)); return structuredClone(updated);
    });
  }
  async acquireFence(W: Address, holder: string): Promise<AgenticFence | null> {
    W = agenticAddress(W);
    if (this.#sql !== null) {
      const result = await this.#sql.query<Record<string, unknown>>(`insert into agentic_wallet_fences(wallet_address,token,holder,lease_until)
        values($1,1,$2,${CLOCK}+120000) on conflict(wallet_address) do update set token=agentic_wallet_fences.token+1,holder=$2,lease_until=${CLOCK}+120000
        where agentic_wallet_fences.lease_until<${CLOCK} returning *`, [W, holder]);
      return result.rows[0] === undefined ? null : decoded(result.rows[0], FC);
    }
    return this.#locked(async () => {
      const old = this.#fences.get(W);
      if (old !== undefined && old.leaseUntil >= this.#now()) return null;
      const row = { walletAddress: W, token: String(BigInt(old?.token ?? "0") + 1n), holder, leaseUntil: this.#now() + 120_000 };
      this.#fences.set(W, row); return structuredClone(row);
    });
  }
  async renewFence(f: AgenticFence): Promise<AgenticFence | null> {
    if (this.#sql !== null) {
      const result = await this.#sql.query<Record<string, unknown>>(`update agentic_wallet_fences set lease_until=${CLOCK}+120000 where wallet_address=$1 and holder=$2 and token=$3 and lease_until>=${CLOCK} returning *`, [f.walletAddress, f.holder, f.token]);
      return result.rows[0] === undefined ? null : decoded(result.rows[0], FC);
    }
    return this.#locked(async () => {
      const row = this.#fences.get(f.walletAddress);
      if (row === undefined || row.holder !== f.holder || row.token !== f.token || row.leaseUntil < this.#now()) return null;
      row.leaseUntil = this.#now() + 120_000; return structuredClone(row);
    });
  }
  async releaseFence(f: AgenticFence): Promise<void> {
    if (this.#sql !== null) { await this.#sql.query("update agentic_wallet_fences set lease_until=0 where wallet_address=$1 and holder=$2 and token=$3", [f.walletAddress, f.holder, f.token]); return; }
    await this.#locked(async () => { const row = this.#fences.get(f.walletAddress); if (row?.holder === f.holder && row.token === f.token) row.leaseUntil = 0; });
  }
  async registerInstance(row: AgenticInstance): Promise<void> {
    if (row.railwayDeploymentId === null && (row.machineId === null || row.osBootMarker === null)) throw new Error("AGENTIC_HOST_IDENTITY");
    if (this.#sql !== null) { await this.#insert("agentic_instances", IC, row); return; }
    this.#instances.set(row.instanceId, structuredClone(row));
  }
  async getInstance(id: string): Promise<AgenticInstance | null> {
    return this.#sql === null ? structuredClone(this.#instances.get(id) ?? null) : (await this.#select<AgenticInstance>("agentic_instances", IC, "where instance_id=$1", [id]))[0] ?? null;
  }
  async heartbeat(id: string): Promise<boolean> {
    if (this.#sql !== null) return (await this.#sql.query(`update agentic_instances set heartbeat_at=${CLOCK} where instance_id=$1 and retired_at is null returning instance_id`, [id])).rows.length === 1;
    const row = this.#instances.get(id); if (row === undefined || row.retiredAt !== null) return false;
    row.heartbeatAt = this.#now(); return true;
  }
  async retire(id: string, by: "dispose" | "exit"): Promise<void> {
    if (this.#sql !== null) { await this.#sql.query(`update agentic_instances set retired_at=coalesce(retired_at,${CLOCK}),retired_by=$2 where instance_id=$1 and (retired_at is null or $2='exit')`, [id, by]); return; }
    const row = this.#instances.get(id); if (row !== undefined && (row.retiredAt === null || by === "exit")) { row.retiredAt ??= this.#now(); row.retiredBy = by; }
  }

  async walletObligations(W: Address, exempt: { orderKey?: string; decisionId?: string; operationId?: string } = {}): Promise<boolean> {
    if ((await this.orders(W)).some(o => o.idempotencyKey !== exempt.orderKey && (o.outcome === "open" || o.fillCheck === "pending"))) return true;
    for (const w of (await this.wallets()).filter(w => w.walletAddress === W && w.agentId !== null)) {
      if ((await this.#sources.intents.listUnsettled(W, w.agentId!)).some(i => i.decisionId !== exempt.decisionId)) return true;
      if (this.#sources.cmc.listPendingAttempts === undefined) throw new Error("AGENTIC_CMC_OBLIGATIONS_UNREADABLE");
      if ((await this.#sources.cmc.listPendingAttempts(w.agentId!, W)).some(a => a.operationId !== exempt.operationId)) return true;
    }
    return false;
  }
  async #memoryAllowed(row: AgenticOrder, f: AgenticFence, margin: number, journalRequired: boolean): Promise<boolean> {
    const now = this.#now();
    const instance = this.#instances.get(f.holder);
    const fence = this.#fences.get(f.walletAddress);
    const wallet = [...this.#wallets.values()].find(w => w.agentId === row.agentId);
    const [agent, halted, paused, journal] = await Promise.all([this.#sources.agents.getAgentById(row.agentId), this.#sources.killswitch.isHalted(),
      this.#sources.killswitch.isAgentPaused(row.agentId, row.walletAddress), journalRequired ? this.#sources.journal.get(row.idempotencyKey) : Promise.resolve(null)]);
    const deadline = row.kind === "swap" && row.side === "buy" ? wallet?.entryCutoffMs : wallet?.hireEndMs;
    return instance !== undefined && instance.service !== "execution-api" && instance.retiredAt === null && instance.heartbeatAt >= now - 30_000
      && row.walletAddress === f.walletAddress && wallet?.walletAddress === row.walletAddress
      && fence?.holder === f.holder && fence.token === f.token && fence.leaseUntil >= now + margin
      && wallet?.state === "bound" && wallet.settingsHold === null && deadline !== null && deadline !== undefined && now + 5_000 < deadline
      && (row.kind !== "swap" || row.side !== "buy" || wallet.entriesStopped === null && wallet.drainRequestedAt === null)
      && agent?.status === "armed" && agent.custodyModel === "binance-agentic" && !halted && !paused
      && (!journalRequired || journal?.state === "PENDING");
  }
  async claimOrder(row: AgenticOrder, f: AgenticFence): Promise<AgenticOrder | null> {
    if (this.#sql !== null) {
      const result = await this.#sql.query<Record<string, unknown>>(AGENTIC_CLAIM_SQL, [row.idempotencyKey, f.holder, f.token, row.kind]);
      return result.rows[0] === undefined ? null : decoded(result.rows[0], OC);
    }
    return this.#locked(async () => {
      const current = this.#orders.get(row.idempotencyKey);
      if (current === undefined || current.kind !== row.kind || current.walletAddress !== row.walletAddress || current.agentId !== row.agentId || current.decisionId !== row.decisionId) return null;
      if ([...this.#orders.values()].some(o => o.walletAddress === row.walletAddress && o.idempotencyKey !== row.idempotencyKey && (o.outcome === "open" || o.fillCheck === "pending"))) return null;
      for (const w of [...this.#wallets.values()].filter(w => w.walletAddress === row.walletAddress && w.agentId !== null)) {
        if ((await this.#sources.intents.listUnsettled(row.walletAddress, w.agentId!)).some(i => i.decisionId !== row.decisionId)) return null;
      }
      if (current?.dispatch !== "unclaimed" || current.outcome !== "open" || row.kind === "swap" && (current.quoteAt === null || current.quoteAt < this.#now() - 30_000)
        || !await this.#memoryAllowed(current, f, row.kind === "swap" ? 35_000 : 75_000, row.kind === "swap")) return null;
      const w = [...this.#wallets.values()].find(w => w.agentId === row.agentId)!;
      const next = { ...current, dispatch: "spawned" as const, claimedAt: this.#now(), claimant: f.holder, fenceToken: f.token,
        claimDeadline: row.kind === "swap" && row.side === "buy" ? w.entryCutoffMs : w.hireEndMs, updatedAt: this.#now() };
      this.#orders.set(row.idempotencyKey, next); return structuredClone(next);
    });
  }
  async payCheck(agentId: string, f: AgenticFence, operationId?: string, orderKey?: string): Promise<boolean> {
    void operationId;
    if (this.#sql !== null) return (await this.#sql.query(AGENTIC_PAY_CHECK_SQL, [agentId, f.holder, f.token, orderKey ?? null])).rows.length === 1;
    if ([...this.#orders.values()].some(o => o.walletAddress === f.walletAddress && o.idempotencyKey !== orderKey && (o.outcome === "open" || o.fillCheck === "pending"))) return false;
    for (const w of [...this.#wallets.values()].filter(w => w.walletAddress === f.walletAddress && w.agentId !== null)) {
      if ((await this.#sources.intents.listUnsettled(f.walletAddress, w.agentId!)).length !== 0) return false;
    }
    const w = [...this.#wallets.values()].find(w => w.agentId === agentId);
    if (w === undefined) return false;
    return this.#memoryAllowed({ agentId, walletAddress: f.walletAddress, kind: "x402-sign", side: null, idempotencyKey: orderKey ?? "" } as AgenticOrder, f, 30_000, false);
  }
  async createRun(row: AgenticGateRun): Promise<boolean> {
    if (this.#sql !== null) return this.#insert("agentic_gate_runs", GC, row);
    if (this.#runs.has(row.runId)) return false; this.#runs.set(row.runId, structuredClone(row)); return true;
  }
  async getRun(id: string): Promise<AgenticGateRun | null> {
    return this.#sql === null ? structuredClone(this.#runs.get(id) ?? null) : (await this.#select<AgenticGateRun>("agentic_gate_runs", GC, "where run_id=$1", [id]))[0] ?? null;
  }
  async consumeRun(id: string, kind: "dispatch" | "cmc"): Promise<boolean> {
    const field = kind === "dispatch" ? "dispatches" : "cmc_payments";
    const maximum = kind === "dispatch" ? "max_dispatches" : "max_cmc_payments";
    if (this.#sql !== null) return (await this.#sql.query(`update agentic_gate_runs set ${field}=${field}+1 where run_id=$1 and closed_at is null and ${CLOCK}<deadline_ms and ${field}<${maximum} returning run_id`, [id])).rows.length === 1;
    return this.#locked(async () => { const row = this.#runs.get(id);
      if (row === undefined || row.closedAt !== null || this.#now() >= row.deadlineMs) return false;
      if (kind === "dispatch") { if (row.dispatches >= row.maxDispatches) return false; row.dispatches += 1; }
      else { if (row.cmcPayments >= row.maxCmcPayments) return false; row.cmcPayments += 1; }
      return true; });
  }
  async bindRunOperation(id: string, operationId: string): Promise<void> {
    if (this.#sql !== null) { await this.#sql.query("update agentic_gate_runs set cmc_operation_ids=cmc_operation_ids || to_jsonb($2::text) where run_id=$1 and not (cmc_operation_ids @> to_jsonb($2::text))", [id, operationId]); return; }
    const row = this.#runs.get(id); if (row !== undefined && !row.cmcOperationIds.includes(operationId)) row.cmcOperationIds = [...row.cmcOperationIds, operationId];
  }
  async closeRun(id: string): Promise<void> {
    if (this.#sql !== null) { await this.#sql.query(`update agentic_gate_runs set closed_at=coalesce(closed_at,${CLOCK}) where run_id=$1`, [id]); return; }
    const row = this.#runs.get(id); if (row !== undefined) row.closedAt ??= this.#now();
  }
  async leaveBound(row: AgenticWallet, reason: "owner-signed-out" | "term-ended" | "stop-loss"): Promise<AgenticWallet | null> {
    if (this.#sql !== null) {
      const result = await this.#sql.query<Record<string, unknown>>(`with n as materialized (select ${CLOCK} as ms)
        update agentic_wallets w set state=$3,end_reason=case when $3='ended' then 'owner-signed-out' when $4='stop-loss' then 'stop-loss' else end_reason end,
          session_ciphertext=case when $3='ended' then null else session_ciphertext end,
          end_blockers=jsonb_build_object('atMs',n.ms,'settingsHold',settings_hold is not null,
            'paused',exists(select 1 from agent_pause p where p.agent_id=w.agent_id),
            'halted',exists(select 1 from global_halt where id='global'),
            'heldObligations',(select count(*) from agentic_orders o where o.wallet_address=w.wallet_address and (o.outcome='open' or o.fill_check='pending'))),
          version=version+1,updated_at=n.ms from n where pairing_id=$1 and version=$2 and state='bound' returning w.*`,
      [row.pairingId, row.version, reason === "owner-signed-out" ? "ended" : "ending", reason]);
      return result.rows[0] === undefined ? null : decoded(result.rows[0], WC);
    }
    const [paused, halted] = await Promise.all([this.#sources.killswitch.isAgentPaused(row.agentId!, row.walletAddress!), this.#sources.killswitch.isHalted()]);
    return this.patchWallet(row, { state: reason === "owner-signed-out" ? "ended" : "ending",
      ...(reason === "owner-signed-out" ? { endReason: reason, sessionCiphertext: null } : {}),
      ...(reason === "stop-loss" ? { endReason: "stop-loss" as const } : {}),
      endBlockers: { atMs: this.#now(), settingsHold: row.settingsHold !== null, paused, halted,
        heldObligations: (await this.orders(row.walletAddress!)).filter(o => o.outcome === "open" || o.fillCheck === "pending").length } });
  }
  async completeFill(row: AgenticOrder, evidence: unknown, out: bigint, txHash: Hex | null = row.txHash): Promise<AgenticOrder | null> {
    const breached = row.minOutAtomic !== null && out < BigInt(row.minOutAtomic);
    const at = await this.now();
    const patch: Partial<AgenticOrder> = { outcome: "committed", txHash, evidence, fillCheck: row.side === "buy" && breached ? "breached" : "ok", holdReason: null, updatedAt: at };
    if (this.#sql !== null) return this.#sql.transaction(async tx => {
      const result = await this.#update<AgenticOrder>("agentic_orders", OC, patch,
        "idempotency_key=$1 and dispatch=$2 and claimant is not distinct from $3 and outcome=$4", [row.idempotencyKey, row.dispatch, row.claimant, row.outcome], tx);
      if (result !== null && breached && row.side === "buy") await tx.query("update agentic_wallets set entries_stopped=$2::jsonb,version=version+1,updated_at=$3 where agent_id=$1",
        [row.agentId, encodeJsonbParam({ reason: "fill-below-minimum", out: out.toString(), min: row.minOutAtomic, atMs: at }), at]);
      return result;
    });
    return this.#locked(async () => {
      const current = this.#orders.get(row.idempotencyKey);
      if (current === undefined || current.dispatch !== row.dispatch || current.claimant !== row.claimant || current.outcome !== row.outcome || !this.#uniqueOrder({ ...current, ...patch })) return null;
      const result = { ...current, ...patch };
      this.#orders.set(row.idempotencyKey, result);
      if (breached && row.side === "buy") {
        const w = [...this.#wallets.values()].find(w => w.agentId === row.agentId);
        if (w !== undefined) { w.entriesStopped = { reason: "fill-below-minimum", out: out.toString(), min: row.minOutAtomic!, atMs: at }; w.version += 1; w.updatedAt = at; }
      }
      return structuredClone(result);
    });
  }

  /* ---- Agentic DCA (AGENTIC-DCA-SPEC 3.3): rounds and orders, every write a row_version CAS under the wallet fence ---- */
  readonly #dcaRounds = new Map<string, AgenticDcaRound>();
  readonly #dcaOrders = new Map<string, AgenticDcaOrder>();
  static #duplicate(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505"; }
  #dcaTxTaken(hash: string | null | undefined, exceptKey: string): boolean {
    return hash != null && [...this.#dcaOrders.values()].some(o => o.txHash === hash && o.orderKey !== exceptKey);
  }
  async dcaRounds(agentId: string): Promise<AgenticDcaRound[]> {
    return this.#sql === null ? structuredClone([...this.#dcaRounds.values()].filter(r => r.agentId === agentId).sort((a, b) => a.roundNo - b.roundNo))
      : this.#select<AgenticDcaRound>("agentic_dca_rounds", RC, "where agent_id=$1 order by round_no", [agentId]);
  }
  async dcaOrders(agentId: string, roundNo?: number): Promise<AgenticDcaOrder[]> {
    const rows = this.#sql === null ? structuredClone([...this.#dcaOrders.values()].filter(o => o.agentId === agentId && (roundNo === undefined || o.roundNo === roundNo)))
      : await this.#select<AgenticDcaOrder>("agentic_dca_orders", DC, roundNo === undefined ? "where agent_id=$1" : "where agent_id=$1 and round_no=$2", roundNo === undefined ? [agentId] : [agentId, roundNo]);
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.orderKey.localeCompare(b.orderKey));
  }
  async getDcaOrder(key: string): Promise<AgenticDcaOrder | null> {
    return this.#sql === null ? structuredClone(this.#dcaOrders.get(key) ?? null) : (await this.#select<AgenticDcaOrder>("agentic_dca_orders", DC, "where order_key=$1", [key]))[0] ?? null;
  }
  async insertDcaRound(row: AgenticDcaRound): Promise<boolean> {
    if (this.#sql !== null) return this.#insert("agentic_dca_rounds", RC, row);
    return this.#locked(async () => {
      const open = (r: AgenticDcaRound): boolean => !["settled", "stopped", "ended", "interrupted"].includes(r.phase);
      if (this.#dcaRounds.has(`${row.agentId}:${row.roundNo}`) || open(row) && [...this.#dcaRounds.values()].some(r => r.agentId === row.agentId && open(r))) return false;
      this.#dcaRounds.set(`${row.agentId}:${row.roundNo}`, structuredClone(row)); return true;
    });
  }
  async patchDcaRound(row: AgenticDcaRound, patch: Partial<AgenticDcaRound>): Promise<AgenticDcaRound | null> {
    const at = await this.now(), next = { ...patch, rowVersion: row.rowVersion + 1, updatedAt: at };
    if (this.#sql !== null) {
      try { return await this.#update<AgenticDcaRound>("agentic_dca_rounds", RC, next, "agent_id=$1 and round_no=$2 and row_version=$3", [row.agentId, row.roundNo, row.rowVersion]); }
      catch (error) { if (AgenticStore.#duplicate(error)) return null; throw error; }
    }
    return this.#locked(async () => {
      const current = this.#dcaRounds.get(`${row.agentId}:${row.roundNo}`);
      if (current === undefined || current.rowVersion !== row.rowVersion) return null;
      const updated = { ...current, ...next };
      this.#dcaRounds.set(`${row.agentId}:${row.roundNo}`, structuredClone(updated)); return structuredClone(updated);
    });
  }
  async patchDcaOrder(row: AgenticDcaOrder, patch: Partial<AgenticDcaOrder>): Promise<AgenticDcaOrder | null> {
    const at = await this.now(), next = { ...patch, rowVersion: row.rowVersion + 1, updatedAt: at };
    if (this.#sql !== null) {
      try { return await this.#update<AgenticDcaOrder>("agentic_dca_orders", DC, next, "order_key=$1 and row_version=$2", [row.orderKey, row.rowVersion]); }
      catch (error) { if (AgenticStore.#duplicate(error)) return null; throw error; }
    }
    return this.#locked(async () => {
      const current = this.#dcaOrders.get(row.orderKey);
      if (current === undefined || current.rowVersion !== row.rowVersion) return null;
      const updated = { ...current, ...next };
      if ([...this.#dcaOrders.values()].some(o => o.orderKey !== row.orderKey && updated.strategyId !== null && o.walletAddress === updated.walletAddress && o.strategyId === updated.strategyId)
        || this.#dcaTxTaken(updated.txHash, row.orderKey) && updated.txHash !== current.txHash) return null;
      this.#dcaOrders.set(row.orderKey, structuredClone(updated)); return structuredClone(updated);
    });
  }
  /** A level recorded as `skipped` or `below-range`: no dispatch row, nothing sent. */
  async insertDcaOrder(row: AgenticDcaOrder): Promise<boolean> {
    if (this.#sql !== null) return this.#insert("agentic_dca_orders", DC, row);
    return this.#locked(async () => { if (this.#dcaOrders.has(row.orderKey)) return false; this.#dcaOrders.set(row.orderKey, structuredClone(row)); return true; });
  }
  /** R3.5 booking: the order `filled` with its own swap's flows and the round ledger in ONE transaction; one DCA order per transaction hash (the unique index). */
  async bookDcaFill(input: { order: AgenticDcaOrder; orderPatch: Partial<AgenticDcaOrder>; round: AgenticDcaRound; roundPatch: Partial<AgenticDcaRound>;
    entriesStopped: NonNullable<AgenticWallet["entriesStopped"]> | null }): Promise<AgenticDcaOrder | null> {
    const { order, round } = input, at = await this.now();
    const orderNext = { ...input.orderPatch, rowVersion: order.rowVersion + 1, updatedAt: at }, roundNext = { ...input.roundPatch, rowVersion: round.rowVersion + 1, updatedAt: at };
    const hash = input.orderPatch.txHash ?? null;
    if (this.#sql !== null) {
      try {
        return await this.#sql.transaction(async tx => {
          const booked = await this.#update<AgenticDcaOrder>("agentic_dca_orders", DC, orderNext, "order_key=$1 and row_version=$2", [order.orderKey, order.rowVersion], tx);
          if (booked === null) throw new Error("AGENTIC_DCA_BOOK_CONFLICT");
          if (await this.#update<AgenticDcaRound>("agentic_dca_rounds", RC, roundNext, "agent_id=$1 and round_no=$2 and row_version=$3", [round.agentId, round.roundNo, round.rowVersion], tx) === null) throw new Error("AGENTIC_DCA_BOOK_CONFLICT");
          if (input.entriesStopped !== null) await tx.query("update agentic_wallets set entries_stopped=$2::jsonb,version=version+1,updated_at=$3 where agent_id=$1",
            [order.agentId, encodeJsonbParam(input.entriesStopped), at]);
          return booked;
        });
      } catch (error) { if (AgenticStore.#duplicate(error) || error instanceof Error && ["AGENTIC_DCA_BOOK_CONFLICT"].includes(error.message)) return null; throw error; }
    }
    return this.#locked(async () => {
      const currentOrder = this.#dcaOrders.get(order.orderKey), currentRound = this.#dcaRounds.get(`${round.agentId}:${round.roundNo}`);
      if (currentOrder === undefined || currentRound === undefined || currentOrder.rowVersion !== order.rowVersion || currentRound.rowVersion !== round.rowVersion
        || hash !== null && this.#dcaTxTaken(hash, order.orderKey)) return null;
      const updated = { ...currentOrder, ...orderNext };
      this.#dcaOrders.set(order.orderKey, structuredClone(updated)); this.#dcaRounds.set(`${round.agentId}:${round.roundNo}`, structuredClone({ ...currentRound, ...roundNext }));
      if (input.entriesStopped !== null) {
        const w = [...this.#wallets.values()].find(w => w.agentId === order.agentId);
        if (w !== undefined) { w.entriesStopped = structuredClone(input.entriesStopped); w.version += 1; w.updatedAt = at; }
      }
      return structuredClone(updated);
    });
  }

  /* ---- Agentic meme paper (AGENTIC-MEME-STOCKS-SPEC 8.2): the lane is the only writer, except `meme-close` setting close_requested_at; every update a version CAS ---- */
  readonly #memePaper = new Map<string, AgenticMemePaper>();
  readonly #memeLog = new Map<string, AgenticMemeLog>();
  async paperList(agentId: string): Promise<AgenticMemePaper[]> {
    const rows = this.#sql === null ? structuredClone([...this.#memePaper.values()].filter(r => r.agentId === agentId))
      : await this.#select<AgenticMemePaper>("agentic_meme_paper", MC, "where agent_id=$1", [agentId]);
    return rows.sort((a, b) => a.openedAt - b.openedAt || a.positionId.localeCompare(b.positionId));
  }
  async paperOpen(agentId: string): Promise<AgenticMemePaper[]> { return (await this.paperList(agentId)).filter(r => r.status === "open"); }
  /** False on a duplicate id or a second open row of the same agent and token. */
  async insertPaper(row: AgenticMemePaper): Promise<boolean> {
    if (this.#sql !== null) return this.#insert("agentic_meme_paper", MC, row);
    return this.#locked(async () => {
      if (this.#memePaper.has(row.positionId) || row.status === "open" && [...this.#memePaper.values()].some(r => r.agentId === row.agentId && r.token === row.token && r.status === "open")) return false;
      this.#memePaper.set(row.positionId, structuredClone(row)); return true;
    });
  }
  async patchPaper(row: AgenticMemePaper, patch: Partial<AgenticMemePaper>): Promise<AgenticMemePaper | null> {
    const next = { ...patch, version: row.version + 1 };
    if (this.#sql !== null) return this.#update<AgenticMemePaper>("agentic_meme_paper", MC, next, "position_id=$1 and version=$2", [row.positionId, row.version]);
    return this.#locked(async () => {
      const current = this.#memePaper.get(row.positionId);
      if (current === undefined || current.version !== row.version) return null;
      const updated = { ...current, ...next };
      this.#memePaper.set(row.positionId, structuredClone(updated)); return structuredClone(updated);
    });
  }
  /** A duplicate id is a no-op (false). */
  async insertMemeLog(row: AgenticMemeLog): Promise<boolean> {
    if (this.#sql !== null) return this.#insert("agentic_meme_log", LC, row);
    return this.#locked(async () => { if (this.#memeLog.has(row.id)) return false; this.#memeLog.set(row.id, structuredClone(row)); return true; });
  }
  /** One agent's rows (`agentId` null: every row, the global `market` rows included) with `sinceMs <= at_ms <= untilMs`, oldest first. */
  async memeLog(agentId: string | null, sinceMs: number, untilMs: number): Promise<AgenticMemeLog[]> {
    const rows = this.#sql === null ? structuredClone([...this.#memeLog.values()].filter(r => (agentId === null || r.agentId === agentId) && r.atMs >= sinceMs && r.atMs <= untilMs))
      : await this.#select<AgenticMemeLog>("agentic_meme_log", LC, agentId === null ? "where at_ms>=$1 and at_ms<=$2" : "where agent_id=$3 and at_ms>=$1 and at_ms<=$2",
        agentId === null ? [sinceMs, untilMs] : [sinceMs, untilMs, agentId]);
    return rows.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
  }

  /* ---- Agentic Earn (AGENTIC-EARN-SPEC 3.12, 36): one claim CAS for an earn row, outside the PIN2 slices; the memory twin mirrors EARN_CLAIM_SQL predicate by predicate ---- */
  async claimEarnOrder(row: AgenticOrder, f: AgenticFence): Promise<AgenticOrder | null> {
    if (row.kind !== "earn-deposit" && row.kind !== "earn-redeem") return null;
    if (this.#sql !== null) {
      const result = await this.#sql.query<Record<string, unknown>>(EARN_CLAIM_SQL, [row.idempotencyKey, f.holder, f.token, row.kind]);
      return result.rows[0] === undefined ? null : decoded(result.rows[0], OC);
    }
    return this.#locked(async () => {
      const current = this.#orders.get(row.idempotencyKey), now = this.#now();
      if (current === undefined || current.kind !== row.kind || current.dispatch !== "unclaimed" || current.outcome !== "open" || current.createdAt < now - 60_000) return null;
      const instance = this.#instances.get(f.holder), fence = this.#fences.get(current.walletAddress);
      const wallet = [...this.#wallets.values()].find(w => w.agentId === current.agentId && w.walletAddress === current.walletAddress);
      const deposit = current.kind === "earn-deposit";
      const [agent, halted, paused] = await Promise.all([this.#sources.agents.getAgentById(current.agentId), this.#sources.killswitch.isHalted(),
        this.#sources.killswitch.isAgentPaused(current.agentId, current.walletAddress)]);
      const signInMax = wallet?.hireFacts?.signInMaxTimeMs;
      if (instance === undefined || !["trade-worker", "agentic-gate"].includes(instance.service) || instance.retiredAt !== null || instance.heartbeatAt < now - 30_000
        || fence === undefined || fence.holder !== f.holder || fence.token !== f.token || fence.leaseUntil < now + 75_000
        || wallet === undefined || wallet.hireFacts?.earn === undefined || wallet.sessionCiphertext === null || signInMax === undefined
        || (deposit ? !(wallet.state === "bound" && wallet.settingsHold === null && wallet.entriesStopped === null && wallet.drainRequestedAt === null && wallet.hireEndMs !== null && now + 5_000 < wallet.hireEndMs - 86_400_000)
          : !(["bound", "ending"].includes(wallet.state) && now + 5_000 < signInMax - 1_800_000))
        || agent?.custodyModel !== "binance-agentic" || !(agent.status === "armed" || !deposit && agent.status === "revoked") || halted || paused) return null;
      if ([...this.#orders.values()].some(o => o.walletAddress === current.walletAddress && o.idempotencyKey !== current.idempotencyKey && (o.outcome === "open" || o.fillCheck === "pending"))) return null;
      for (const w of [...this.#wallets.values()].filter(w => w.walletAddress === current.walletAddress && w.agentId !== null)) {
        if ((await this.#sources.intents.listUnsettled(current.walletAddress, w.agentId!)).length !== 0) return null;
      }
      const next = { ...current, dispatch: "spawned" as const, claimedAt: now, claimant: f.holder, fenceToken: f.token, updatedAt: now,
        claimDeadline: deposit ? wallet.hireEndMs! - 86_400_000 : signInMax - 1_800_000 };
      this.#orders.set(row.idempotencyKey, next); return structuredClone(next);
    });
  }
}

/** AGENTIC-EARN-SPEC 3.12: the earn claim. A deposit needs a bound hire with no hold, entries open and more than 24 h before the end; a redeem also runs while `ending`, on a revoked agent and under a hold, up to 30 min before the Binance maximum sign-in time. */
export const EARN_CLAIM_SQL = `with n as materialized (select ${CLOCK} as ms)
update agentic_orders o set dispatch='spawned',claimed_at=n.ms,claimant=$2,fence_token=$3,updated_at=n.ms,
 claim_deadline=(select case when o.kind='earn-deposit' then w.hire_end_ms-86400000
   else (w.hire_facts->>'signInMaxTimeMs')::bigint-1800000 end from agentic_wallets w where w.agent_id=o.agent_id)
from n where o.idempotency_key=$1 and o.kind=$4 and o.kind in ('earn-deposit','earn-redeem')
 and o.dispatch='unclaimed' and o.outcome='open' and o.created_at>=n.ms-60000
 and exists(select 1 from agentic_instances i where i.instance_id=$2 and i.service in ('trade-worker','agentic-gate') and i.retired_at is null and i.heartbeat_at>=n.ms-30000)
 and exists(select 1 from agentic_wallet_fences f where f.wallet_address=o.wallet_address and f.holder=$2 and f.token=$3 and f.lease_until>=n.ms+75000)
 and exists(select 1 from agentic_wallets w where w.agent_id=o.agent_id and w.wallet_address=o.wallet_address
   and w.hire_facts->'earn' is not null and w.session_ciphertext is not null
   and (o.kind='earn-deposit' and w.state='bound' and w.settings_hold is null and w.entries_stopped is null
        and w.drain_requested_at is null and n.ms+5000<w.hire_end_ms-86400000
     or o.kind='earn-redeem' and w.state in ('bound','ending') and n.ms+5000<(w.hire_facts->>'signInMaxTimeMs')::bigint-1800000))
 and exists(select 1 from agents a where a.id=o.agent_id and a.custody_model='binance-agentic'
   and (a.status='armed' or o.kind='earn-redeem' and a.status='revoked'))
 and not exists(select 1 from global_halt where id='global') and not exists(select 1 from agent_pause p where p.agent_id=o.agent_id)
 and not exists(select 1 from agentic_orders x where x.wallet_address=o.wallet_address and x.idempotency_key<>o.idempotency_key and (x.outcome='open' or x.fill_check='pending'))
 and not exists(select 1 from trade_intents i where i.state='pending' and i.agent_id in (select h.agent_id from agentic_wallets h where h.wallet_address=o.wallet_address and h.agent_id is not null)) returning o.*`;

export const AGENTIC_CLAIM_SQL = `with n as materialized (select ${CLOCK} as ms)
update agentic_orders o set dispatch='spawned',claimed_at=n.ms,claimant=$2,fence_token=$3,
 claim_deadline=(select case when o.kind='swap' and o.side='buy' then w.entry_cutoff_ms else w.hire_end_ms end from agentic_wallets w where w.agent_id=o.agent_id),updated_at=n.ms
from n where o.idempotency_key=$1 and o.kind=$4 and o.dispatch='unclaimed' and o.outcome='open'
 and (o.kind='x402-sign' or o.quote_at>=n.ms-30000)
 and exists(select 1 from agentic_instances i where i.instance_id=$2 and i.service in ('trade-worker','agentic-gate') and i.retired_at is null and i.heartbeat_at>=n.ms-30000)
 and exists(select 1 from agentic_wallet_fences f where f.wallet_address=o.wallet_address and f.holder=$2 and f.token=$3 and f.lease_until>=n.ms+case when o.kind='swap' then 35000 else 75000 end)
 and exists(select 1 from agentic_wallets w where w.agent_id=o.agent_id and w.state='bound' and w.settings_hold is null
   and (o.kind='x402-sign' or o.side='sell' or (w.entries_stopped is null and w.drain_requested_at is null))
   and n.ms+5000<case when o.kind='swap' and o.side='buy' then w.entry_cutoff_ms else w.hire_end_ms end)
 and exists(select 1 from agents a where a.id=o.agent_id and a.status='armed' and a.custody_model='binance-agentic')
 and not exists(select 1 from global_halt where id='global') and not exists(select 1 from agent_pause p where p.agent_id=o.agent_id)
 and (o.kind='x402-sign' or exists(select 1 from execution_journal j where j.idempotency_key=o.idempotency_key and j.state='PENDING'))
 and not exists(select 1 from agentic_orders x where x.wallet_address=o.wallet_address and x.idempotency_key<>o.idempotency_key and (x.outcome='open' or x.fill_check='pending'))
 and not exists(select 1 from trade_intents i where i.state='pending' and i.decision_id is distinct from o.decision_id and i.agent_id in (select h.agent_id from agentic_wallets h where h.wallet_address=o.wallet_address and h.agent_id is not null)) returning o.*`;

export const AGENTIC_PAY_CHECK_SQL = `with n as materialized (select ${CLOCK} as ms)
select w.agent_id from agentic_wallets w,n where w.agent_id=$1 and w.state='bound' and w.settings_hold is null and n.ms+5000<w.hire_end_ms
 and exists(select 1 from agentic_instances i where i.instance_id=$2 and i.service in ('trade-worker','agentic-gate') and i.retired_at is null and i.heartbeat_at>=n.ms-30000)
 and exists(select 1 from agentic_wallet_fences f where f.wallet_address=w.wallet_address and f.holder=$2 and f.token=$3 and f.lease_until>=n.ms+30000)
 and exists(select 1 from agents a where a.id=w.agent_id and a.status='armed' and a.custody_model='binance-agentic')
 and not exists(select 1 from global_halt where id='global') and not exists(select 1 from agent_pause p where p.agent_id=w.agent_id)
 and not exists(select 1 from agentic_orders x where x.wallet_address=w.wallet_address and x.idempotency_key is distinct from $4 and (x.outcome='open' or x.fill_check='pending'))
 and not exists(select 1 from trade_intents i where i.state='pending' and i.agent_id in (select h.agent_id from agentic_wallets h where h.wallet_address=w.wallet_address and h.agent_id is not null))`;
