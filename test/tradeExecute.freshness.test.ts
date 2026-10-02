/**
 * TRADFI-EXPIRY-KEEP-REMOVE §4 — the two hardenings in the shared trade core
 * (`executeTradeForAgent`): 4a re-reads the agent right before the key is
 * decrypted; 4b requires the restored session to be the one the journal row
 * records. Both are pre-submit rollbacks. Direct executor calls, memory stores.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { MemoryAgentStore, type AgentRecord, type AgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { executeTradeForAgent, type ExecuteTradeResult } from "../src/trade/execute.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { TradeRequest } from "../src/http/wire.js";
import { FakeWalletProvider, SESSION_KEY, tradeConfig } from "./support/serverHarness.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const KEYSTORE = getAddress("0x5555555555555555555555555555555555555555");
const K1 = `0x04${"77".repeat(64)}` as Hex;
const K2 = `0x04${"78".repeat(64)}` as Hex;
const HASH = `0x${"11".repeat(32)}` as Hex;
const NOW = Date.UTC(2026, 5, 5, 14, 0, 0);
const NOW_SEC = Math.floor(NOW / 1_000);
const E = 10n ** 18n;
const dump = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
const scanGate = { evaluate: async () => ({ verdict: "allow" as const, reasons: [] }) };

type Model = "legacy" | "tradfi-ai";
type Side = "buy" | "sell";

async function build(model: Model, id: string) {
  const agents = new MemoryAgentStore(undefined, () => NOW);
  const venues = { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } as const;
  const v2 = model === "tradfi-ai";
  const spec = tradeSessionSpec({ venues, tokens: [{ token: TOKEN }], nativeCaps: [{ limit: E, period: "day" }], expiresAt: NOW_SEC + 86_400, nowSeconds: NOW_SEC,
    ...(v2 ? { quoteToken: USDT_56, quoteDailyCapWei: 300n * E, quotePerTradeCapWei: 20n * E, platformFeeBps: 0 } : {}) });
  const agent = await agents.createAgent({ id, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", status: "armed",
    caps: { dailyNativeWei: E, perTradeNativeWei: E / 10n },
    sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: K1, expiry: NOW_SEC + 86_400,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0",
        ...(v2 ? { settlementAsset: "USDT" as const, minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), quotePerTradeWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString() } : {}) } } });
  await agents.putAgentSessionKey(OWNER, id, SESSION_KEY);
  const journal = new MemoryExecutionJournal(() => NOW);
  const provider = new FakeWalletProvider();
  return { agents, agent, journal, provider, venues };
}

function request(model: Model, side: Side, decisionId: string): TradeRequest {
  return model === "tradfi-ai"
    ? { decisionId, venue: "pancake", side, token: TOKEN, amountWei: 10n * E, quotedOutWei: 10n * E, minOutWei: 10n * E * 97n / 100n, settlementAsset: "USDT", platformFeeAtomic: 0n }
    : { decisionId, venue: "pancake", side, token: TOKEN, amountWei: 1_000n, quotedOutWei: 1_000n, minOutWei: 990n };
}

async function run(built: Awaited<ReturnType<typeof build>>, agentStore: AgentStore, snapshot: AgentRecord, req: TradeRequest): Promise<ExecuteTradeResult> {
  return executeTradeForAgent({ agent: snapshot, request: req, idempotencyKey: HASH, paramsHash: HASH, scanGate,
    deps: { chainId: 56, keyStore: KEYSTORE, agentStore, journal: built.journal, killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => built.provider },
      trade: tradeConfig({ venues: built.venues }), pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, pancakeV3: null, uniswapV3: null, flapPortal: null, nowMs: () => NOW } });
}

/** A store double: real rows, but `readExecutingSession` is counted and can be replaced. */
function spyStore(store: MemoryAgentStore, over: { readonly absent?: boolean; readonly readError?: Error; readonly executing?: () => ReturnType<AgentStore["readExecutingSession"]> } = {}) {
  const counts = { executingReads: 0 };
  const proxy = new Proxy(store, { get(target, property) {
    if (property === "getAgent" && over.absent === true) return async () => null;
    if (property === "getAgent" && over.readError !== undefined) return async () => { throw over.readError; };
    if (property === "readExecutingSession") return async (...args: Parameters<AgentStore["readExecutingSession"]>) => {
      counts.executingReads += 1;
      return over.executing === undefined ? target.readExecutingSession(...args) : over.executing();
    };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } }) as AgentStore;
  return { proxy, counts };
}

describe("§4a — the fresh-status barrier refuses a stale armed snapshot", () => {
  for (const model of ["tradfi-ai", "legacy"] as const) {
    for (const side of ["buy", "sell"] as const) {
      for (const fresh of ["revoked", "retired", "absent"] as const) {
        it(`${model} ${side}: a stale armed snapshot with a ${fresh} row rolls back, journals ROLLED_BACK and submits nothing`, async () => {
          const built = await build(model, `agent-${model}-${side}-${fresh}`);
          if (fresh !== "absent") await built.agents.updateAgentStatus(OWNER, built.agent.id, fresh);
          const spy = spyStore(built.agents, { absent: fresh === "absent" });
          const req = request(model, side, `decision-${model}-${side}-${fresh}`);
          const result = await run(built, spy.proxy, built.agent, req);
          assert.equal(result.kind, "rolled-back", dump(result));
          if (result.kind === "rolled-back") assert.equal(result.code, "REVOKED");
          assert.equal((await built.journal.getByDecision(built.agent.id, req.decisionId))?.state, "ROLLED_BACK");
          assert.equal(built.provider.executeCalls.length, 0, "nothing is submitted");
          assert.equal(built.provider.restoreCalls.length, 0);
          assert.equal(spy.counts.executingReads, 0, "the key is never decrypted");
        });
      }
    }
  }

  for (const model of ["tradfi-ai", "legacy"] as const) {
    for (const side of ["buy", "sell"] as const) {
      it(`fresh-read-error ${model} ${side}: a rejected agent re-read is a pre-submit rollback — journal ROLLED_BACK, nothing submitted, no raw message`, async () => {
        const built = await build(model, `agent-read-error-${model}-${side}`);
        const spy = spyStore(built.agents, { readError: new Error("temporary agent read failure: password=hunter2") });
        const req = request(model, side, `decision-read-error-${model}-${side}`);
        const result = await run(built, spy.proxy, built.agent, req);
        assert.equal(result.kind, "rolled-back", dump(result));
        assert.equal(dump(result).includes("hunter2"), false, "the transport message never reaches the result");
        const journal = await built.journal.getByDecision(built.agent.id, req.decisionId);
        assert.equal(journal?.state, "ROLLED_BACK", "the reservation is released, not left PENDING");
        assert.equal((journal?.lastError ?? "").includes("hunter2"), false);
        assert.equal(built.provider.executeCalls.length, 0, "nothing is submitted");
        assert.equal(built.provider.restoreCalls.length, 0);
        assert.equal(spy.counts.executingReads, 0, "the key is never decrypted");
      });
    }
  }

  it("pause semantics are unchanged: a fresh paused row does not trip the barrier and a sell still submits", async () => {
    const built = await build("tradfi-ai", "agent-paused-sell");
    await built.agents.updateAgentStatus(OWNER, built.agent.id, "paused");
    const result = await run(built, built.agents, built.agent, request("tradfi-ai", "sell", "decision-paused-sell"));
    assert.equal(result.kind, "committed", dump(result));
    assert.equal(built.provider.executeCalls.length, 1);
  });

  it("an armed row proceeds to submission unchanged, for both models and sides", async () => {
    for (const model of ["tradfi-ai", "legacy"] as const) {
      for (const side of ["buy", "sell"] as const) {
        const built = await build(model, `agent-armed-${model}-${side}`);
        const result = await run(built, built.agents, built.agent, request(model, side, `decision-armed-${model}-${side}`));
        assert.equal(result.kind, "committed", `${model} ${side}: ${dump(result)}`);
        assert.equal(built.provider.executeCalls.length, 1);
      }
    }
  });
});

describe("§4b — the restored session must be the journalled one", () => {
  it("journal-k1-restored-k2-refuses-submit: K1 journalled, K2 restored, so SESSION_CHANGED with no preflight or submission", async () => {
    const built = await build("tradfi-ai", "agent-k1-k2");
    const row = await built.agents.readExecutingSession(OWNER, built.agent.id);
    assert.ok(row);
    const spy = spyStore(built.agents, { executing: async () => ({ ...row, facts: { ...row.facts, publicKey: K2 } }) });
    const req = request("tradfi-ai", "sell", "decision-k1-k2");
    const result = await run(built, spy.proxy, built.agent, req);
    assert.equal(result.kind, "rolled-back", dump(result));
    if (result.kind === "rolled-back") assert.equal(result.code, "SESSION_CHANGED");
    const journal = await built.journal.getByDecision(built.agent.id, req.decisionId);
    assert.equal(journal?.state, "ROLLED_BACK");
    assert.equal(journal?.externalRef.publicKey, K1, "the row records the snapshot's key");
    assert.equal(built.provider.preflightCalls.length, 0, "no preflight");
    assert.equal(built.provider.restoreCalls.length, 0, "the session is never restored");
    assert.equal(built.provider.executeCalls.length, 0);
  });

  it("the same public key with a different generation is also refused (changes ONLY the generation)", async () => {
    const built = await build("tradfi-ai", "agent-generation");
    const row = await built.agents.readExecutingSession(OWNER, built.agent.id);
    assert.ok(row);
    const spy = spyStore(built.agents, { executing: async () => ({ ...row, facts: { ...row.facts, generation: 1 } }) });
    const req = request("tradfi-ai", "sell", "decision-generation");
    const result = await run(built, spy.proxy, built.agent, req);
    assert.equal(result.kind, "rolled-back", dump(result));
    if (result.kind === "rolled-back") assert.equal(result.code, "SESSION_CHANGED");
    assert.equal(built.provider.preflightCalls.length, 0);
    assert.equal(built.provider.executeCalls.length, 0);
  });

  it("an equal key and generation proceed unchanged; key comparison is case-insensitive and an absent generation reads as zero", async () => {
    const built = await build("tradfi-ai", "agent-equal");
    const row = await built.agents.readExecutingSession(OWNER, built.agent.id);
    assert.ok(row);
    const spy = spyStore(built.agents, { executing: async () => ({ ...row, facts: { ...row.facts, publicKey: row.facts.publicKey.toUpperCase().replace("0X", "0x") as Hex, generation: 0 } }) });
    const result = await run(built, spy.proxy, built.agent, request("tradfi-ai", "sell", "decision-equal"));
    assert.equal(result.kind, "committed", dump(result));
    assert.equal(built.provider.preflightCalls.length, 1);
    assert.equal(built.provider.executeCalls.length, 1);
  });

  it("legacy rows are refused on a changed key too (the barrier is the shared trade core, not one model)", async () => {
    const built = await build("legacy", "agent-legacy-k2");
    const row = await built.agents.readExecutingSession(OWNER, built.agent.id);
    assert.ok(row);
    const spy = spyStore(built.agents, { executing: async () => ({ ...row, facts: { ...row.facts, publicKey: K2 } }) });
    const result = await run(built, spy.proxy, built.agent, request("legacy", "buy", "decision-legacy-k2"));
    assert.equal(result.kind, "rolled-back", dump(result));
    assert.equal(built.provider.executeCalls.length, 0);
  });
});
