import assert from "node:assert/strict";
import { it } from "node:test";
import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { validateSessionSpec } from "../src/core/session.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { MemoryTradeSimulationStore } from "../src/store/tradeSimulations.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { executeTradeForAgent, type ExecuteTradeDeps } from "../src/trade/execute.js";
import { createTradfiEvidenceWriter, GUARD_DEADLINE_REASONS, type TradfiPreflightDeps } from "../src/trade/simulate.js";
import { TRADFI_SWAP_GUARD_ABI, TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { InfrastructureError, type WalletCall } from "../src/core/types.js";
import type { TradeRequest } from "../src/http/wire.js";
import { FakeWalletProvider, SESSION_KEY, tradeConfig } from "./support/serverHarness.js";
import { GUARD, TREASURY } from "./support/dcaFixtures.js";
const OWNER = getAddress("0x1111111111111111111111111111111111111111"), WALLET = getAddress("0x2222222222222222222222222222222222222222"), TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const KEYSTORE = getAddress("0x5555555555555555555555555555555555555555"), ID = `0x${"11".repeat(32)}` as Hex;
const NOW = 1_900_000_000_000, E = 10n ** 18n;
const VENUES = { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } as const;
export function decodeSimulatedCalls(data: Hex) {
  const decoded = decodeFunctionData({ abi: parseAbi(["function execute(bytes32,bytes)"]), data });
  const [rows] = decodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], decoded.args[1]);
  return { executionData: decoded.args[1], calls: rows.map(row => ({ to: row.target.toLowerCase(), value: row.value, data: row.data })) };
}
const normalized = (calls: readonly WalletCall[]) => calls.map(call => ({ to: call.to.toLowerCase(), value: call.value ?? 0n, data: call.data ?? "0x" }));
async function fixture(v2 = true) {
  const agents = new MemoryAgentStore(undefined, () => NOW);
  const spec = tradeSessionSpec({ venues: VENUES, tokens: [{ token: TOKEN }], treasury: TREASURY, nativeCaps: [{ limit: E, period: "day" }],
    expiresAt: NOW / 1000 + 86400, nowSeconds: NOW / 1000, ...(v2 ? { quoteToken: USDT_56, quoteDailyCapWei: 300n * E, quotePerTradeCapWei: 20n * E, platformFeeBps: 100 } : {}) });
  const agent = await agents.createAgent({ id: "preflight", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", status: "armed", caps: { dailyNativeWei: E, perTradeNativeWei: E / 10n },
    sessionFacts: { spec, permissions: validateSessionSpec(spec, { minSessionSeconds: 0, nowSeconds: NOW / 1000 }), publicKey: privateKeyToAccount(SESSION_KEY).publicKey, expiry: spec.expiresAt,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", ...(v2 ? { settlementAsset: "USDT" as const, minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), quotePerTradeWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString() } : {}) } } });
  await agents.putAgentSessionKey(OWNER, agent.id, SESSION_KEY);
  const journal = new MemoryExecutionJournal(() => NOW), provider = new FakeWalletProvider();
  const request: TradeRequest = { decisionId: "decision", venue: "pancake", side: "buy", token: TOKEN, amountWei: v2 ? 10n * E : 1000n,
    quotedOutWei: v2 ? 10n * E : 1000n, minOutWei: v2 ? 97n * E / 10n : 990n,
    ...(v2 ? { settlementAsset: "USDT" as const, platformFeeAtomic: E / 10n } : {}) };
  const deps: ExecuteTradeDeps = { chainId: 56, keyStore: KEYSTORE, agentStore: agents, journal, killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => provider },
    trade: tradeConfig({ venues: VENUES, feeBps: 100, feeTreasury: TREASURY }), pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, pancakeV3: null, uniswapV3: null, flapPortal: null, nowMs: () => NOW };
  const run = (patch: Partial<TradeRequest> = {}, preflight?: TradfiPreflightDeps, key = ID, depsPatch: Partial<ExecuteTradeDeps> = {}) => executeTradeForAgent({ agent, request: { ...request, ...patch }, idempotencyKey: key, paramsHash: key,
    scanGate: { evaluate: async () => ({ verdict: "allow", reasons: [] }) }, deps: { ...deps, ...depsPatch, ...(preflight === undefined ? {} : { preflight }) } });
  return { agent, request, journal, provider, run, deps };
}
it("E1/E8 flag-off and native-quoted paths remain unsimulated", async () => {
  const plain = await fixture(); assert.equal((await plain.run()).kind, "committed");
  const native = await fixture(false); let count = 0;
  await native.run({}, { simulate: async () => { count += 1; throw new Error("unreachable"); }, evidence: { insert: () => { throw new Error("unreachable"); } } }); assert.equal(count, 0);
});
it("E2/E4/R2.10 direct and guard buy/sell compare the whole submitted list and clamped deadline", async () => {
  for (const side of ["buy", "sell"] as const) for (const guard of [false, true]) {
    const f = await fixture(), store = new MemoryTradeSimulationStore(), evidence = createTradfiEvidenceWriter(store, () => {});
    let data: Hex = "0x";
    const patch: Partial<TradeRequest> = { side, ...(side === "sell" ? { platformFeeAtomic: 0n } : {}),
      ...(guard ? { guardQuote: { guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", deadline: BigInt(NOW / 1000) + 60n } } : {}) };
    const answer = await f.run(patch, { evidence, simulate: async tx => {
      assert.equal(f.provider.executeCalls.length, 0); data = tx.data;
      return { status: side === "sell" ? "FAILED" : "SUCCESS", failReason: side === "sell" ? "execution reverted: x" : null,
        balanceChanges: [{ owner: WALLET, token: TOKEN, change: 10n }], otherChangeCount: 0, upstreamMs: 1 };
    } });
    assert.equal(answer.kind, "committed"); await evidence.shutdown();
    const decoded = decodeSimulatedCalls(data); assert.deepEqual(decoded.calls, normalized(f.provider.executeCalls[0]!.calls));
    if (side === "buy") assert.equal(decoded.calls.at(-1)?.to, USDT_56.toLowerCase());
    if (guard) {
      const guardCall = decoded.calls.find(call => call.to === GUARD.toLowerCase())!;
      const swap = decodeFunctionData({ abi: TRADFI_SWAP_GUARD_ABI, data: guardCall.data }); assert.equal(swap.args[4], BigInt(NOW / 1000) + 14n);
    }
    assert.equal(store.simulations.get(ID)?.blocked, false);
  }
});
it("E3 rollback releases quote reservation before any relay call, retry simulates fresh bytes", async () => {
  const f = await fixture(), store = new MemoryTradeSimulationStore(), evidence = createTradfiEvidenceWriter(store, () => {});
  const batches: Hex[] = []; let failed = true;
  const preflight: TradfiPreflightDeps = { evidence, simulate: async tx => { batches.push(tx.data); return { status: failed ? "FAILED" : "SUCCESS", failReason: failed ? "execution reverted: x" : null, balanceChanges: [], otherChangeCount: 0, upstreamMs: 0 }; } };
  const denied = await f.run({}, preflight); assert.equal(denied.kind, "rolled-back");
  if (denied.kind === "rolled-back") { assert.equal(denied.code, "SIMULATION_FAILED"); assert.equal(denied.meta.deniedBy, "venue"); }
  assert.equal((await f.journal.get(ID))?.state, "ROLLED_BACK"); assert.equal(await f.journal.sumPendingQuoteSpendSince(f.agent.id, 0), 0n); assert.equal(f.provider.executeCalls.length, 0);
  failed = false; const key = `0x${"22".repeat(32)}` as Hex;
  assert.equal((await f.run({ decisionId: "retry", minOutWei: 98n * E / 10n }, preflight, key)).kind, "committed");
  assert.notEqual(batches[0], batches[1]); assert.deepEqual(decodeSimulatedCalls(batches[1]!).calls, normalized(f.provider.executeCalls[0]!.calls)); await evidence.shutdown();
});
it("E5/E5b/S8 every unavailable reason, non-revert, null and exact guard deadline proceeds", async () => {
  for (const raw of [null, "insufficient funds for gas", ...GUARD_DEADLINE_REASONS]) {
    const f = await fixture(); const guard = raw !== null && GUARD_DEADLINE_REASONS.includes(raw);
    const result = await f.run(guard ? { guardQuote: { guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", deadline: BigInt(NOW / 1000) + 14n } } : {},
      { evidence: { insert: () => { throw new Error("evidence unavailable"); } }, simulate: async () => ({ status: "FAILED", failReason: raw, balanceChanges: [], otherChangeCount: 0, upstreamMs: 0 }) });
    assert.equal(result.kind, "committed"); assert.equal(f.provider.executeCalls.length, 1);
  }
  for (const reason of ["timeout", "rate-limited", "auth", "credentials", "unavailable", "malformed", "upstream-error", "shape", "window"]) {
    const f = await fixture(); assert.equal((await f.run({}, { evidence: { insert: () => {} }, simulate: async () => { throw new InfrastructureError(`simulate:${reason}`); } })).kind, "committed");
  }
});
it("E7 window skip precedes the unchanged guard recheck with no evidence wait", async () => {
  for (const remaining of [6549, 6001, 5999]) {
    const f = await fixture(); let called = 0; let rowReason: string | null = null;
    const deadline = BigInt(NOW / 1000) + 14n;
    const result = await f.run({ guardQuote: { guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", deadline } }, {
      simulate: async () => { called += 1; throw new Error("unreachable"); }, evidence: { insert: row => { rowReason = row.reason; } },
    }, ID, { nowMs: () => Number(deadline) * 1000 - remaining });
    assert.equal(called, 0); assert.equal(rowReason, "window"); assert.equal(result.kind, remaining < 6000 ? "rolled-back" : "committed");
    if (remaining < 6000 && result.kind === "rolled-back") assert.equal(result.code, "GUARD_QUOTE_EXPIRED");
  }
});
