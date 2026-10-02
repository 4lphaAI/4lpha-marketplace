// Existing offline fixture, extracted for independent final-audit assertions.
import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { validateSessionSpec } from "../../src/core/session.js";
import { MemoryAgentStore } from "../../src/store/agents.js";
import { MemoryExecutionJournal } from "../../src/store/journal.js";
import { MemoryKillSwitch } from "../../src/killswitch/killswitch.js";
import { tradeSessionSpec } from "../../src/ops/policy.js";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../../src/ops/venues.js";
import { USDT_56 } from "../../src/trade/settlement.js";
import { executeTradeForAgent, type ExecuteTradeDeps } from "../../src/trade/execute.js";
import type { TradfiPreflightDeps } from "../../src/trade/simulate.js";
import type { WalletCall } from "../../src/core/types.js";
import type { TradeRequest } from "../../src/http/wire.js";
import { FakeWalletProvider, SESSION_KEY, tradeConfig } from "./serverHarness.js";
import { TREASURY } from "./dcaFixtures.js";
const OWNER = getAddress("0x1111111111111111111111111111111111111111"), WALLET = getAddress("0x2222222222222222222222222222222222222222"), TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const KEYSTORE = getAddress("0x5555555555555555555555555555555555555555"), ID = `0x${"11".repeat(32)}` as Hex;
export const NOW = 1_900_000_000_000, E = 10n ** 18n;
const VENUES = { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } as const;
export function decodeSimulatedCalls(data: Hex) {
  const decoded = decodeFunctionData({ abi: parseAbi(["function execute(bytes32,bytes)"]), data });
  const [rows] = decodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], decoded.args[1]);
  return { executionData: decoded.args[1], calls: rows.map(row => ({ to: row.target.toLowerCase(), value: row.value, data: row.data })) };
}
export const normalized = (calls: readonly WalletCall[]) => calls.map(call => ({ to: call.to.toLowerCase(), value: call.value ?? 0n, data: call.data ?? "0x" }));
export async function fixture(v2 = true) {
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
