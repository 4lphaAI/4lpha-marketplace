/**
 * TRADFI-EXPIRY-KEEP-REMOVE §2.3 — renewal admission and swap recognise a
 * DISPOSED inert ambiguous sell from durable facts only, for TradFi AI agents
 * only, and only when every binding holds. Memory and PostgreSQL agent stores
 * (an owned disposable cluster, never DATABASE_URL); the four store call sites
 * (`createPendingRenewalCas` and `swapSessionCas`, each in both stores) all take
 * the same closure, and the background sweep takes the index-server's shape of it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToBytes, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { FinalizedSessionRevocationVerdict } from "../src/account/keyStoreReader.js";
import { MemoryAgentStore, PostgresAgentStore, type AgentRecord, type AgentStore, type PendingRenewal, type SessionFacts } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryTradeIntentStore, type TradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { createPgSqlClient } from "../src/store/sql.js";
import { encodeInertEvidence, type InertEvidence } from "../src/trade/inertSubmission.js";
import { DEFAULT_TRADE_SETTINGS, isTradfiAiSettings, parseTradeSettings, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import type { GrantEvidenceReader, GrantEvidenceSnapshot } from "../src/wallet/grantEvidence.js";
import { assessRenewalQuiescence, convergeRenewal, type RenewalQuiescenceDeps } from "../src/wallet/provisioning.js";
import { createProvisioningWorker } from "../src/wallet/provisioningWorker.js";
import { localPostgres } from "./support/localPostgres.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const KEYSTORE = getAddress("0x6666666666666666666666666666666666666666");
const K1 = `0x04${"77".repeat(64)}` as Hex;
const K1_KEY = `0x${"11".repeat(32)}` as Hex;
const K2_KEY = `0x${"22".repeat(32)}` as Hex;
const OTHER_K = `0x04${"78".repeat(64)}` as Hex;
const HASH = `0x${"66".repeat(32)}` as Hex;
const JOURNAL_KEY = `0x${"a1".repeat(32)}` as Hex;
const OTHER_JOURNAL_KEY = `0x${"a2".repeat(32)}` as Hex;
const NOW_MS = 1_900_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1_000);
const E = 10n ** 18n;
const AGENT_ID = "renew-ai";

const aiSettings = (over: Partial<TradeSettings> = {}): TradeSettings => ({ ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
  minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString(), cmcNewsEnabled: false, maxOpenPositions: 1,
  takeProfitBps: null, stopLossBps: null, maxHoldSec: null, crashProtection: false, ...over });

function evidence(over: Partial<InertEvidence> = {}): string {
  return encodeInertEvidence({ v: 1, kind: "inert-ambiguous-sell", key: K1, verdict: "invalid", block: "101", blockHash: HASH,
    blockTimeSec: NOW_SEC, expirySec: NOW_SEC - 1, journalKey: JOURNAL_KEY, ...over });
}

function facts(over: { readonly publicKey?: Hex; readonly expiry?: number; readonly generation?: number } = {}): SessionFacts {
  return { spec: { allowedCalls: [{ to: WALLET }], spendCaps: [{ limit: 1_000n, period: "day" }], expiresAt: over.expiry ?? NOW_SEC - 1 },
    permissions: { calls: [], spend: [] }, publicKey: over.publicKey ?? K1, expiry: over.expiry ?? NOW_SEC - 1,
    ...(over.generation === undefined ? {} : { generation: over.generation }),
    hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT" } };
}

/** Persisted state of the 2026-09-21 incident, scoped to one agent id. */
async function seedRows(input: { readonly agentId: string; readonly intents: MemoryTradeIntentStore; readonly journal: MemoryExecutionJournal;
  readonly journalKind?: "trade" | "execute"; readonly journalKey?: Hex; readonly publicKey?: Hex; readonly withHash?: boolean }) {
  await input.intents.create({ decisionId: "ambiguous-sell", idempotencyKey: input.journalKey ?? JOURNAL_KEY, agentId: input.agentId, ownerAddress: OWNER, side: "sell",
    token: TOKEN, route: { hops: [], fees: [] }, amountWei: 9n, entryWei: 5n * E, positionId: "position", closeReason: "llm", settlementAsset: "USDT" });
  await input.journal.begin({ idempotencyKey: input.journalKey ?? JOURNAL_KEY, agentId: input.agentId, ownerAddress: OWNER, kind: input.journalKind ?? "trade",
    decisionId: "ambiguous-sell", externalRef: { paramsHash: HASH, publicKey: input.publicKey ?? K1, sessionGeneration: 0 } });
  await input.journal.markUnknown(input.journalKey ?? JOURNAL_KEY, "provider error -32602: please assign a tracer");
}

function agentRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return { id: AGENT_ID, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", sessionFacts: facts(), sessionRevocation: null, caps: null,
    status: "armed", httpRuntimeProfile: "unbound-v1", erc8004AgentId: null, pendingGrant: null, pendingRenewal: null, rowVersion: 1, createdAt: 1, updatedAt: 1,
    ...over } as AgentRecord;
}

describe("assessRenewalQuiescence — the §2.3 conjunction (each clause isolated)", () => {
  async function fixture(over: { readonly settings?: TradeSettings | null; readonly dispose?: string | null; readonly markRolledBack?: boolean;
    readonly journalKind?: "trade" | "execute"; readonly withDispositionAsProjected?: boolean } = {}) {
    const intents = new MemoryTradeIntentStore(() => NOW_MS);
    const journal = new MemoryExecutionJournal(() => NOW_MS);
    const agents = new MemoryAgentStore(undefined, () => NOW_MS);
    const settingsStore = new MemoryTradeSettingsStore(agents, () => NOW_MS);
    await seedRows({ agentId: AGENT_ID, intents, journal, ...(over.journalKind === undefined ? {} : { journalKind: over.journalKind }) });
    if (over.settings !== null) {
      const settings = over.settings ?? aiSettings();
      await settingsStore.put({ agentId: AGENT_ID, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
    }
    if (over.markRolledBack === true) await intents.markRolledBack(OWNER, AGENT_ID, "ambiguous-sell", "Trade journal rolled back before projection.");
    else if (over.dispose !== null) await intents.disposeInertSell(OWNER, AGENT_ID, "ambiguous-sell", over.dispose ?? evidence());
    return { intents, journal, settingsStore, deps: { tradeIntents: intents, tradeSettings: settingsStore, journal } satisfies RenewalQuiescenceDeps };
  }

  it("passes the disposed incident row for a TradFi AI agent", async () => {
    const f = await fixture();
    assert.deepEqual(await assessRenewalQuiescence(agentRecord(), f.deps), { quiescent: true });
  });

  const legacyFixture: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "sigma" };
  const scheduleFixture = (): TradeSettings => aiSettings({ minEntryWei: (20n * E).toString(), tradeMode: "schedule", scheduleToken: TOKEN.toLowerCase(), scheduleIntervalSec: 3_600,
    scheduleFirstAtSec: null, scheduleEndKind: "budget", scheduleEndAtSec: null, scheduleEndRuns: null, scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150 });

  it("the non-AI fixtures below are VALID settings rows of another model (so the refusal is the discriminator, not a parse failure)", () => {
    for (const value of [legacyFixture, scheduleFixture()]) {
      const parsed = parseTradeSettings(value);
      assert.equal(parsed.ok && !isTradfiAiSettings(parsed.value.effective), true);
    }
    assert.equal(parseTradeSettings(aiSettings()).ok, true);
  });

  const refusals: readonly (readonly [string, Parameters<typeof fixture>[0]])[] = [
    ["a non-AI model (legacy settings) with valid evidence", { settings: legacyFixture }],
    ["a schedule agent with valid evidence", { settings: scheduleFixture() }],
    ["missing settings", { settings: null }],
    ["unparseable settings", { settings: { not: "settings" } as unknown as TradeSettings }],
    ["an ordinary rollback without evidence", { dispose: null, markRolledBack: true }],
    ["no disposal at all (the pending intent)", { dispose: null }],
    ["evidence with the wrong version", { dispose: JSON.stringify({ v: 2 }) }],
    ["evidence with the wrong kind", { dispose: evidence({ kind: "other" as never }) }],
    ["evidence bound to another key", { dispose: evidence({ key: OTHER_K }) }],
    ["evidence bound to another journal row", { dispose: evidence({ journalKey: OTHER_JOURNAL_KEY }) }],
    ["another journal kind", { journalKind: "execute" }],
  ];
  for (const [name, options] of refusals) {
    it(`refuses ${name}`, async () => {
      const f = await fixture(options);
      const result = await assessRenewalQuiescence(agentRecord(), f.deps);
      assert.equal(result.quiescent, false);
      assert.match(result.reason ?? "", /journal UNKNOWN|finishing a trade intent/u);
    });
  }

  it("refuses when the intent lookup or the settings read is not wired (the exemption is off by default)", async () => {
    const f = await fixture();
    assert.equal((await assessRenewalQuiescence(agentRecord(), { tradeIntents: { listUnsettled: f.intents.listUnsettled.bind(f.intents) }, tradeSettings: f.settingsStore, journal: f.journal })).quiescent, false);
    assert.equal((await assessRenewalQuiescence(agentRecord(), { tradeIntents: f.intents, journal: f.journal })).quiescent, false);
  });

  it("refuses a journal row WITH a hash and a PENDING or IN_PROGRESS row even when the intent looks disposed", async () => {
    for (const state of ["PENDING", "IN_PROGRESS"] as const) {
      const f = await fixture();
      const key = `0x${state === "PENDING" ? "b1" : "b2"}${"00".repeat(31)}` as Hex;
      await f.journal.begin({ idempotencyKey: key, agentId: AGENT_ID, ownerAddress: OWNER, kind: "trade", decisionId: `other-${state}`, externalRef: { publicKey: K1 } });
      if (state === "IN_PROGRESS") await f.journal.markInProgress(key, { callsId: `0x${"b3".repeat(32)}` as Hex });
      const result = await assessRenewalQuiescence(agentRecord(), f.deps);
      assert.equal(result.quiescent, false);
      assert.match(result.reason ?? "", new RegExp(`journal ${state}`, "u"));
    }
    const f = await fixture();
    const hashed = { ...f.deps, journal: { listNonTerminal: async () => [], listUnknownForAgent: async () => (await f.journal.listUnknownForAgent(AGENT_ID))
      .map((row) => ({ ...row, externalRef: { ...row.externalRef, txHash: `0x${"cc".repeat(32)}` as Hex } })) } };
    assert.equal((await assessRenewalQuiescence(agentRecord(), hashed)).quiescent, false);
  });

  it("exemption-non-rolled-back-with-valid-evidence-refuses: a projected intent with valid evidence and bindings", async () => {
    const f = await fixture({ dispose: null });
    // Forge the state a dispose CAS can never produce: a projected row that carries valid, bound evidence.
    const projected = { ...(await f.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))!, state: "projected" as const, dispositionEvidence: evidence() };
    const forged: TradeIntentStore["get"] = async () => projected;
    const result = await assessRenewalQuiescence(agentRecord(), { ...f.deps, tradeIntents: { listUnsettled: async () => [], get: forged } });
    assert.equal(result.quiescent, false);
  });

  it("a second UNKNOWN row that is NOT disposed still refuses even when the first is exempt", async () => {
    const f = await fixture();
    const other = `0x${"a9".repeat(32)}` as Hex;
    await f.journal.begin({ idempotencyKey: other, agentId: AGENT_ID, ownerAddress: OWNER, kind: "trade", decisionId: "another-ambiguous", externalRef: { publicKey: K1, sessionGeneration: 0 } });
    await f.journal.markUnknown(other, "transport");
    const result = await assessRenewalQuiescence(agentRecord(), f.deps);
    assert.equal(result.quiescent, false);
    assert.match(result.reason ?? "", new RegExp(other, "u"));
  });
});

// ---------------------------------------------------------- store lifecycle

function pendingRenewal(previous: SessionFacts): PendingRenewal {
  const next = privateKeyToAccount(K2_KEY);
  const expiresAt = NOW_SEC + 3_600;
  return { version: 1, recoveredOwner: OWNER, walletAddress: WALLET, sessionAddress: next.address, sessionPublicKey: next.publicKey,
    accountKeyHash: keccak256(stringToBytes(next.address)), keyStoreKeyId: keccak256(next.publicKey), sessionSpec: { ...previous.spec, expiresAt },
    permissions: previous.permissions, grantDigest: `0x${"44".repeat(32)}` as Hex, expiresAt,
    sizing: { openNativeBudgetWei: "0", capDayWei: "1000", sizingPreset: "trade-v1", sizingPresetVersion: 1 },
    funding: { version: 1, observedAtSec: NOW_SEC, registrationFeeWei: "1", registrations: 1, relayGasHeadroomWei: "1", requiredWei: "2", balanceWei: "10" },
    createdAtSec: NOW_SEC - 1, keyStoreVerdictAtS1: "verified", renewActionId: `0x${"55".repeat(32)}` as Hex,
    previous: { publicKey: previous.publicKey, keyStoreKeyId: keccak256(previous.publicKey), accountKeyHash: keccak256(stringToBytes(privateKeyToAccount(K1_KEY).address)), expiry: previous.expiry },
    phase: "granting" };
}

function exactEvidence(pending: PendingRenewal): GrantEvidenceSnapshot {
  return {
    relayKeys: [{ hash: pending.accountKeyHash, expiry: pending.expiresAt, role: "session", permissions: {
      calls: [...pending.permissions.calls.map((call) => ({ ...("to" in call ? { to: call.to } : {}), ...("signature" in call ? { signature: toFunctionSelector(call.signature) } : {}) })),
        { to: "0xaf140d0416a994aebb3fa6212b16ce6700f09751", signature: "0x32323232" }], spend: pending.permissions.spend } }],
    accountKey: { expiry: pending.expiresAt, isSuperAdmin: false }, accountSpend: pending.permissions.spend,
    canExecute: [...pending.permissions.calls.map(() => true), true],
    keyStore: { kind: "registered", publicKey: pending.sessionPublicKey }, ownerVerdict: "verified",
  };
}

async function agentStores(): Promise<{ readonly stores: readonly AgentStore[]; readonly close: () => Promise<void> }> {
  const memory = new MemoryAgentStore(Buffer.alloc(32, 7), () => NOW_MS);
  const local = await localPostgres();
  if (local === null) return { stores: [memory], close: () => memory.close() };
  const postgres = await PostgresAgentStore.create(await createPgSqlClient(local.url), Buffer.alloc(32, 7), () => NOW_MS);
  return { stores: [memory, postgres], close: async () => { await memory.close(); await postgres.close(); await local.close(); } };
}

describe("disposal → restart → admission → swap → second check (memory and PostgreSQL agent stores)", () => {
  it("a disposed inert sell stops blocking admission AND the swap, survives a rebuilt closure, and still passes under the new key", async () => {
    const fixture = await agentStores();
    try {
      for (const store of fixture.stores) {
        const label = store.durable ? "postgres" : "memory";
        const id = `${AGENT_ID}-${label}`;
        const wallet = store.durable ? getAddress("0x2222222222222222222222222222222222222299") : WALLET;
        const previous = facts();
        await store.createAgent({ id, ownerAddress: OWNER, walletAddress: wallet, custodyModel: "passkey", sessionFacts: previous, status: "armed" });
        await store.putAgentSessionKey(OWNER, id, K1_KEY);
        const agent = (await store.getAgent(OWNER, id))!;
        const intents = new MemoryTradeIntentStore(() => NOW_MS);
        const journal = new MemoryExecutionJournal(() => NOW_MS);
        const positions = new MemoryTradePositionStore(() => NOW_MS);
        const settingsStore = new MemoryTradeSettingsStore(store, () => NOW_MS);
        const settings = aiSettings();
        await settingsStore.put({ agentId: id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
        await seedRows({ agentId: id, intents, journal });
        const closure = () => async (latest: AgentRecord) => assessRenewalQuiescence(latest, { tradeIntents: intents, tradeSettings: settingsStore, journal });
        const check = (assess: (agent: AgentRecord) => ReturnType<ReturnType<typeof closure>>) => async () => {
          const latest = await store.getAgent(OWNER, id);
          return latest === null ? { quiescent: false, reason: "agent disappeared" } : assess(latest);
        };

        // 1. The pending sell blocks admission (store call site 1 of 2 for this store).
        const blocked = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: id, expectedRowVersion: agent.rowVersion, nowSec: NOW_SEC,
          pendingRenewal: pendingRenewal(previous), sessionKey: K2_KEY, checkQuiescent: check(closure()) });
        assert.equal(blocked.kind, "conflict", `${label}: a pending hashless sell blocks admission`);

        // 2. The worker's reconcile disposes it once the key is provably dead.
        const inert = { chainId: 56, keyStore: KEYSTORE, read: async (): Promise<FinalizedSessionRevocationVerdict> => ({ kind: "invalid",
          observation: { blockNumber: "101", blockHash: HASH, blockTimeSec: NOW_SEC },
          evidence: { version: 1, chainId: 56, keyStoreAddress: KEYSTORE, walletAddress: wallet, keyId: keccak256(K1), sessionPublicKey: K1, verdict: "invalid",
            blockNumber: "101", blockHash: HASH, observedAtMs: NOW_MS } }) };
        const workerDeps = { agentStore: store, settingsStore, positions, intents, journal, readiness: { ready: false, allowlistAvailable: true, bstocksAddresses: new Set<string>() },
          inertSubmission: inert, now: () => NOW_MS } as unknown as TradeWorkerDeps;
        await runTradeWorkerOnce(workerDeps);
        assert.equal((await intents.get(OWNER, id, "ambiguous-sell"))?.state, "rolled-back", label);
        assert.equal((await journal.get(JOURNAL_KEY))?.state, "UNKNOWN", `${label}: the journal row is untouched`);

        // 3. "Restart": every closure is rebuilt from the persisted rows. Admission now passes.
        const restarted = check(closure());
        const current = await store.getAgent(OWNER, id);
        const created = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: id, expectedRowVersion: current!.rowVersion, nowSec: NOW_SEC,
          pendingRenewal: pendingRenewal(previous), sessionKey: K2_KEY, checkQuiescent: restarted });
        assert.equal(created.kind, "updated", `${label}: admission passes`);

        // 4. The swap completes (store call site 2 of 2), then the second check passes under the NEW key.
        const renewal = pendingRenewal(previous);
        const swapped = await store.swapSessionCas({ ownerAddress: OWNER, agentId: id, expectedRowVersion: created.kind === "updated" ? created.agent.rowVersion : 0,
          expectedGrantDigest: renewal.grantDigest, checkQuiescent: check(closure()), nowSec: NOW_SEC,
          sessionFacts: { ...previous, spec: renewal.sessionSpec, publicKey: renewal.sessionPublicKey, expiry: renewal.expiresAt, generation: 1, grantedAtSec: NOW_SEC } });
        assert.equal(swapped.kind, "updated", `${label}: the swap completes`);
        const renewed = await store.getAgent(OWNER, id);
        assert.equal(renewed?.sessionFacts?.publicKey, renewal.sessionPublicKey);
        assert.equal(renewed?.sessionFacts?.generation, 1);
        assert.deepEqual(await assessRenewalQuiescence(renewed!, { tradeIntents: intents, tradeSettings: settingsStore, journal }), { quiescent: true },
          `${label}: the evidence is bound to the submitting key, not to the agent's current expiry`);
      }
    } finally { await fixture.close(); }
  });

  it("without the exemption the same rows block the swap (control)", async () => {
    const store = new MemoryAgentStore(Buffer.alloc(32, 7), () => NOW_MS);
    const previous = facts();
    await store.createAgent({ id: AGENT_ID, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", sessionFacts: previous, status: "armed" });
    await store.putAgentSessionKey(OWNER, AGENT_ID, K1_KEY);
    const agent = (await store.getAgent(OWNER, AGENT_ID))!;
    const intents = new MemoryTradeIntentStore(() => NOW_MS);
    const journal = new MemoryExecutionJournal(() => NOW_MS);
    await seedRows({ agentId: AGENT_ID, intents, journal });
    await intents.disposeInertSell(OWNER, AGENT_ID, "ambiguous-sell", evidence());
    const blocked = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: AGENT_ID, expectedRowVersion: agent.rowVersion, nowSec: NOW_SEC,
      pendingRenewal: pendingRenewal(previous), sessionKey: K2_KEY,
      checkQuiescent: async () => assessRenewalQuiescence((await store.getAgent(OWNER, AGENT_ID))!, { tradeIntents: intents, journal }) });
    assert.equal(blocked.kind, "conflict");
    await store.close();
  });
});

describe("background convergence: the provisioning worker with the index-server's closure shape", () => {
  it("converges a pending renewal past a disposed inert sell (and holds while it is only pending)", async () => {
    const store = new MemoryAgentStore(Buffer.alloc(32, 7), () => NOW_MS);
    const previous = facts();
    await store.createAgent({ id: AGENT_ID, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", sessionFacts: previous, status: "armed" });
    await store.putAgentSessionKey(OWNER, AGENT_ID, K1_KEY);
    const agent = (await store.getAgent(OWNER, AGENT_ID))!;
    const intents = new MemoryTradeIntentStore(() => NOW_MS);
    const journal = new MemoryExecutionJournal(() => NOW_MS);
    const settingsStore = new MemoryTradeSettingsStore(store, () => NOW_MS);
    const settings = aiSettings();
    await settingsStore.put({ agentId: AGENT_ID, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
    await seedRows({ agentId: AGENT_ID, intents, journal });
    const renewal = pendingRenewal(previous);
    const created = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: AGENT_ID, expectedRowVersion: agent.rowVersion, nowSec: NOW_SEC,
      pendingRenewal: renewal, sessionKey: K2_KEY });
    assert.equal(created.kind, "updated");
    const evidenceReader: GrantEvidenceReader = { readFunding: async () => renewal.funding, readGrant: async (grant) => exactEvidence(grant as unknown as PendingRenewal) };
    const worker = createProvisioningWorker({ store, evidence: evidenceReader, keyStore: KEYSTORE, nowSec: () => NOW_SEC,
      // Exactly the shape src/index-server.ts passes: tradeIntents + tradeSettings + journal.
      renewalQuiescence: async (latest) => assessRenewalQuiescence(latest, { tradeIntents: intents, tradeSettings: settingsStore, journal }) });
    await worker.sweep();
    assert.equal((await store.getAgent(OWNER, AGENT_ID))?.sessionFacts?.generation ?? 0, 0, "a pending sell holds the swap in the background too");
    await intents.disposeInertSell(OWNER, AGENT_ID, "ambiguous-sell", evidence());
    await worker.sweep();
    const renewed = await store.getAgent(OWNER, AGENT_ID);
    assert.equal(renewed?.sessionFacts?.generation, 1, "the background sweep completes the renewal");
    assert.equal(renewed?.sessionFacts?.publicKey, renewal.sessionPublicKey);
    await store.close();
  });

  it("convergeRenewal is what the sweep runs: the same closure passes through it directly", async () => {
    const store = new MemoryAgentStore(Buffer.alloc(32, 7), () => NOW_MS);
    const previous = facts();
    await store.createAgent({ id: AGENT_ID, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", sessionFacts: previous, status: "armed" });
    await store.putAgentSessionKey(OWNER, AGENT_ID, K1_KEY);
    const agent = (await store.getAgent(OWNER, AGENT_ID))!;
    const intents = new MemoryTradeIntentStore(() => NOW_MS);
    const journal = new MemoryExecutionJournal(() => NOW_MS);
    const settingsStore = new MemoryTradeSettingsStore(store, () => NOW_MS);
    const settings = aiSettings();
    await settingsStore.put({ agentId: AGENT_ID, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
    await seedRows({ agentId: AGENT_ID, intents, journal });
    await intents.disposeInertSell(OWNER, AGENT_ID, "ambiguous-sell", evidence());
    const renewal = pendingRenewal(previous);
    await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: AGENT_ID, expectedRowVersion: agent.rowVersion, nowSec: NOW_SEC, pendingRenewal: renewal, sessionKey: K2_KEY });
    const converged = await convergeRenewal({ store, ownerAddress: OWNER, agentId: AGENT_ID, keyStore: KEYSTORE, nowSec: NOW_SEC,
      evidence: { readFunding: async () => renewal.funding, readGrant: async (grant) => exactEvidence(grant as unknown as PendingRenewal) },
      checkQuiescent: async () => assessRenewalQuiescence((await store.getAgent(OWNER, AGENT_ID))!, { tradeIntents: intents, tradeSettings: settingsStore, journal }) });
    assert.equal(converged.phase, "done");
    await store.close();
  });
});

describe("both production closures carry the settings read (source pins)", () => {
  it("src/server.ts and src/index-server.ts pass tradeSettings into assessRenewalQuiescence", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const index = readFileSync(new URL("../src/index-server.ts", import.meta.url), "utf8");
    assert.match(server, /const renewalQuiescence = async \(agent: AgentRecord\) => assessRenewalQuiescence\(agent, \{\s*\.\.\.\(deps\.tradeAgent === undefined \? \{\} : \{ tradeIntents: deps\.tradeAgent\.intents, tradeSettings: deps\.tradeAgent\.settingsStore \}\)/u);
    assert.match(index, /renewalQuiescence: async \(agent\) => assessRenewalQuiescence\(agent, \{\s*\.\.\.\(tradeIntents === undefined \? \{\} : \{ tradeIntents \}\),\s*\.\.\.\(tradeSettingsStore === undefined \? \{\} : \{ tradeSettings: tradeSettingsStore \}\)/u);
  });
});
