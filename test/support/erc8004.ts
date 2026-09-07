import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, keccak256, type Hex } from "viem";
import { REGISTRY, newIdentity, type IdentitySources, type IdentitySource, type IdentityTransaction, type UnsignedIntent } from "../../src/identity/types.js";
import { IDENTITY_ABI, type RegistryGateway, type RegistryReceipt } from "../../src/identity/registry.js";
import { MemoryIdentityFence } from "../../src/identity/fence.js";
import { MemoryIdentityLedger, PostgresIdentityLedger, type IdentityLedger } from "../../src/store/erc8004.js";
import { IdentityService } from "../../src/identity/service.js";
import type { IdentityConfig } from "../../src/identity/config.js";
import type { SqlClient, SqlResult } from "../../src/store/sql.js";

// Public synthetic fixtures; never connected to an RPC or funded signer.
export const DUMMY_SIGNER = privateKeyToAccount(`0x${"11".repeat(32)}`);
export const OWNER = "0x2222222222222222222222222222222222222222" as const;
export const CONFIG: IdentityConfig = { chainId: 56, registry: REGISTRY, minter: DUMMY_SIGNER.address, databaseUrl: "postgres://test@localhost/offline", rpcUrl: "https://rpc.invalid", maxGas: 1000n, maxPrice: 10n, maxInstanceFee: 20_000n, maxDailyFee: 50_000n, exclusive: true };
export class FixtureSources implements IdentitySources {
  rows = new Map<string, IdentitySource>(); projectionFails = false;
  constructor() { this.rows.set("agent", { id: "agent", owner: OWNER, identity: newIdentity("grid"), existingId: null, category: "grid", eligible: true }); }
  async get(id: string) { return structuredClone(this.rows.get(id) ?? null); }
  async enrolled(afterId = "") { return structuredClone([...this.rows.values()].filter((row) => row.id > afterId).sort((a,b) => a.id < b.id ? -1 : 1).slice(0,100)); }
  async enroll(): Promise<IdentitySource> { throw new Error("Unexpected enroll."); }
  async project(source: IdentitySource, next: Parameters<IdentitySources["project"]>[1], fence: Parameters<IdentitySources["project"]>[2]) {
    fence.check(); if (this.projectionFails) return false;
    const old = this.rows.get(source.id); assert.ok(old); assert.deepEqual(old.identity, source.identity);
    this.rows.set(source.id, { ...old, identity: next, existingId: next.status === "registered" ? next.agentId : old.existingId }); return true;
  }
}
export class FixtureGateway implements RegistryGateway {
  latest = 5; pending = 5; estimate = 100n; gasPrice = 2n; balance = 1_000_000n; finalizedBlock = 100n;
  signed: UnsignedIntent[] = []; sent: Hex[] = []; receipts = new Map<Hex, RegistryReceipt>(); id = "0";
  owner = DUMMY_SIGNER.address; uri = ""; failBroadcast = false; failReceipt = false; failIdentity = false; afterSign: (() => Promise<void>) | undefined;
  async probe() {}
  async nonces() { return { latest: this.latest, pending: this.pending }; }
  async fees() { return { estimate: this.estimate, gasPrice: this.gasPrice, balance: this.balance }; }
  async simulate() {}
  async sign(intent: UnsignedIntent) {
    this.signed.push(structuredClone(intent));
    const raw = await DUMMY_SIGNER.signTransaction({ chainId: intent.chainId, type: "legacy", to: intent.to, nonce: intent.nonce, value: 0n, data: intent.data, gas: BigInt(intent.gas), gasPrice: BigInt(intent.gasPrice) });
    await this.afterSign?.(); return raw;
  }
  async broadcast(raw: Hex) { if (this.failBroadcast) throw new Error("provider secret error"); this.sent.push(raw); this.pending = this.latest + 1; return keccak256(raw); }
  async receipt(hash: Hex) { if (this.failReceipt) throw new Error("RPC down"); return this.receipts.get(hash) ?? null; }
  async finalized() { return this.finalizedBlock; }
  async blockHash() { return `0x${"ab".repeat(32)}` as Hex; }
  async identity() { if (this.failIdentity) throw new Error("identity read down"); return { owner: this.owner, uri: this.uri }; }
  async land(tx: IdentityTransaction, uri: string, status: "success" | "reverted" = "success") {
    this.latest = tx.intent.nonce + 1; this.pending = this.latest; this.uri = uri;
    const blockHash = await this.blockHash();
    const log = { address: REGISTRY, data: encodeAbiParameters([{ type: "string" }], [uri]),
      topics: encodeEventTopics({ abi: IDENTITY_ABI, eventName: "Registered", args: { agentId: BigInt(this.id), owner: DUMMY_SIGNER.address } }) as [Hex, ...Hex[]],
      blockHash, blockNumber: 90n, transactionHash: tx.hash, transactionIndex: 0, logIndex: 0, removed: false };
    this.receipts.set(tx.hash, { transactionHash: tx.hash, to: REGISTRY, from: DUMMY_SIGNER.address, blockNumber: 90n, blockHash, status, logs: tx.phase === "register" ? [log] : [] });
  }
}
/** Ledger SQL fake models atomic rollback and all three durable unique constraints. */
export class IdentitySql implements SqlClient {
  jobs = new Map<string, Record<string, unknown>>(); txs = new Map<string, Record<string, unknown>>(); nonce: string | null = null;
  statements: string[] = []; failTag: string | null = null; #tail = Promise.resolve();
  async query<Row>(text: string, params: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push(text); const tag = /\/\*\s*(\w+\.\w+)\s*\*\//.exec(text)?.[1];
    if (tag === this.failTag) { this.failTag = null; throw new Error("injected SQL failure"); }
    let rows: unknown[] = [];
    switch (tag) {
      case "erc8004.jobs": rows = [...this.jobs.values()].filter((job) => String(job.minter).toLowerCase() === params[1]).map((document) => ({ document })); break;
      case "erc8004.transactions": rows = [...this.txs.values()].filter((tx) => (tx.intent as UnsignedIntent).minter.toLowerCase() === params[1]).map((document) => ({ document })); break;
      case "erc8004.numberSchema": rows = [{ installed: true }]; break;
      case "erc8004.numberLock": break;
      case "erc8004.numberJobs": rows = [...this.jobs.values()].filter((job) => (params[0] as string[]).includes(String(job.owner).toLowerCase()))
        .map((document) => ({ public_ref: document.publicRef, source_id: document.sourceId, owner_address: String(document.owner).toLowerCase(), chain: document.chainId, minter: String(document.minter).toLowerCase(), document })); break;
      case "erc8004.nonce": case "erc8004.nonceLock": rows = [{ next_nonce: this.nonce }]; break;
      case "erc8004.nonceEnsure": break;
      case "erc8004.nonceUpdate": this.nonce = String(params[2]); break;
      case "erc8004.jobInsert": {
        const ref = String(params[0]); const document = JSON.parse(String(params[5])) as Record<string, unknown>;
        if (this.jobs.has(ref) || [...this.jobs.values()].some((job) => job.owner === document.owner && job.sourceId === document.sourceId)) throw new Error("duplicate job");
        if ([...this.jobs.values()].some((job) => String(job.owner).toLowerCase() === String(document.owner).toLowerCase() && job.category === document.category && job.displayNumber !== undefined && job.displayNumber === document.displayNumber)) throw new Error("duplicate number");
        this.jobs.set(ref, document); break;
      }
      case "erc8004.jobUpdate": this.jobs.set(String(params[0]), JSON.parse(String(params[1])) as Record<string, unknown>); break;
      case "erc8004.txInsert": {
        const hash = String(params[0]); const document = JSON.parse(String(params[6])) as Record<string, unknown>;
        if (this.txs.has(hash) || [...this.txs.values()].some((tx) => tx.jobRef === document.jobRef && tx.phase === document.phase || (tx.intent as UnsignedIntent).nonce === Number(params[5]))) throw new Error("duplicate transaction");
        this.txs.set(hash, document); break;
      }
      case "erc8004.txUpdate": this.txs.set(String(params[0]), JSON.parse(String(params[1])) as Record<string, unknown>); break;
      default: if (tag !== undefined) throw new Error("Unknown ledger query");
    }
    return { rows: structuredClone(rows) as Row[] };
  }
  async transaction<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> {
    const oldTail = this.#tail; let release!: () => void; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await oldTail;
    const before = structuredClone({ jobs: this.jobs, txs: this.txs, nonce: this.nonce });
    try { return await fn(this); } catch (error) { this.jobs = before.jobs; this.txs = before.txs; this.nonce = before.nonce; throw error; } finally { release(); }
  }
  async close() {}
}
export function fixture(postgres = false, config: IdentityConfig = CONFIG) {
  const sql = new IdentitySql(); const ledger: IdentityLedger = postgres ? new PostgresIdentityLedger(sql, config) : new MemoryIdentityLedger(config);
  const sources = new FixtureSources(); const gateway = new FixtureGateway(); const fence = new MemoryIdentityFence();
  let now = 1_000_000;
  return { sql, ledger, sources, gateway, fence, service: new IdentityService(config, ledger, sources, gateway, fence, () => now),
    setNow(value: number) { now = value; }, restart(nextConfig = config) { return new IdentityService(nextConfig, ledger, sources, gateway, new MemoryIdentityFence(), () => now); } };
}
