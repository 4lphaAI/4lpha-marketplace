/**
 * TradFi Binance aggregator activation (spec Revision 3) — offline coverage
 * for the pieces that are cleanly unit-testable: C1 (fee-null parsing), C2
 * (`acceptFlashQuote`'s four refusal codes and its pass case), C3 (the guard
 * deadline clamp and the pre-submit re-check), C9 (the guard-verification
 * retry cache), R2.4 (the slippage clamp), R3.2 (the deferred-premium option
 * is Schedule-only) and the R2.9 6000ms boundary.
 *
 * Worker-level wiring (C4/C6/C7/C8) and the server-level D3 pin-mode seam and
 * C5 renewal fix are covered by the touched suites (`tradeSchedule.worker.test.ts`,
 * `audit.tradfiCoreFixes.test.ts`, `audit.tradfiCoreIndependent.test.ts`,
 * `tradfiV3Worker.test.ts`) and by the full offline suite staying green; see
 * the build report for what a dedicated test would still need to add.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { validateSessionSpec } from "../src/core/session.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { executeTradeForAgent } from "../src/trade/execute.js";
import type { TradeRequest } from "../src/http/wire.js";
import { acceptFlashQuote, runTradeWorkerOnce, type FlashRequestFacts, type TradeExecutorInput, type TradeExecutorResult, type TradeWorkerDeps } from "../src/trade/worker.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import {
  cachedGuardVerification,
  classifyTradfiFlashError,
  createTradfiCapabilityProbeCache,
  flashRequest,
  TRADFI_BINANCE_FLASH_ROUTER_56,
  TRADFI_BINANCE_FLASH_SPENDER_56,
  TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC,
  TRADFI_GUARD_MIN_REMAINING_MS,
  TRADFI_SWAP_GUARD_ABI,
  type TradfiCapabilityProbeResult,
} from "../src/trade/guard.js";
import { HttpTradeDataPlaneReads, type TradfiFlashQuote } from "../src/trade/dataPlaneReads.js";
import { rwaEntryVerdict, type RwaFact } from "../src/trade/rwa.js";
import { FakeWalletProvider, tradeConfig, SESSION_KEY } from "./support/serverHarness.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const GUARD = getAddress("0x4444444444444444444444444444444444444444");
const OTHER_GUARD = getAddress("0x4444444444444444444444444444444444444455");
const KEY = `0x04${"77".repeat(64)}` as Hex;
const H = `0x${"99".repeat(32)}` as Hex;
const E = 10n ** 18n;

/* -------------------------------------------------------------------------- */
/* C1 — fee-null quotes parse                                                 */
/* -------------------------------------------------------------------------- */

function flashQuoteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: USDT_56, tokenOut: TOKEN,
    amountInAtomic: "1000", quotedOutAtomic: "1000", minOutAtomic: "970",
    router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
    calldata: "0xad43f73d", value: "0", observedAt: Date.now(), expiresAt: Date.now() + 15_000,
    estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56,
    ...overrides,
  };
}

async function quoteFor(body: Record<string, unknown>): Promise<TradfiFlashQuote> {
  const client = new HttpTradeDataPlaneReads({
    baseUrl: "https://data.example/",
    fetch: async () => Response.json({ data: body }),
  });
  return client.binanceQuoteAndSwap({ tokenIn: USDT_56, tokenOut: TOKEN, amountAtomic: "1000", slippageBps: 100 });
}

test("C1: a fee-null/fee-token-null pair parses", async () => {
  const quote = await quoteFor(flashQuoteBody({ feeAmountAtomic: null, feeToken: null }));
  assert.equal(quote.feeAmountAtomic, null);
  assert.equal(quote.feeToken, null);
});

test("C1: exactly one side of the fee pair being null is malformed", async () => {
  await assert.rejects(quoteFor(flashQuoteBody({ feeAmountAtomic: "0", feeToken: null })), /malformed/u);
  await assert.rejects(quoteFor(flashQuoteBody({ feeAmountAtomic: null, feeToken: USDT_56 })), /malformed/u);
});

test("C1: a fee token outside {tokenIn, tokenOut} is malformed", async () => {
  await assert.rejects(quoteFor(flashQuoteBody({ feeAmountAtomic: "1", feeToken: WBNB_56 })), /neither side/u);
});

/* -------------------------------------------------------------------------- */
/* C2 — acceptFlashQuote                                                      */
/* -------------------------------------------------------------------------- */

function sessionFacts(overrides: { readonly guard?: `0x${string}`; readonly noRule?: boolean } = {}) {
  const guard = overrides.guard ?? GUARD;
  const spec = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 },
    tokens: [{ token: TOKEN }], nativeCaps: [{ limit: E, period: "day" }], quoteToken: USDT_56,
    quoteDailyCapWei: 100n * E, quotePerTradeCapWei: 20n * E,
    ...(overrides.noRule === true ? {} : { aggregatorGuard: guard }),
    nowSeconds: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 86_400 });
  return { spec, permissions: validateSessionSpec(spec), publicKey: KEY, expiry: spec.expiresAt };
}

const REQUEST: FlashRequestFacts = { tokenIn: USDT_56, tokenOut: TOKEN, amountAtomic: "1000" };

test("C2: not-granted when no configured guard is passed", () => {
  const facts = sessionFacts();
  const flash = flashQuoteBody() as unknown as TradfiFlashQuote;
  const result = acceptFlashQuote({ request: REQUEST, flash, facts, configuredGuard: undefined, nowMs: Date.now() });
  assert.deepEqual(result, { ok: false, code: "not-granted" });
});

test("C2: not-granted when the session has no matching rule", () => {
  const facts = sessionFacts({ noRule: true });
  const flash = flashQuoteBody() as unknown as TradfiFlashQuote;
  const result = acceptFlashQuote({ request: REQUEST, flash, facts, configuredGuard: GUARD, nowMs: Date.now() });
  assert.deepEqual(result, { ok: false, code: "not-granted" });
});

test("C2: not-granted when the quote's taker is not the worker's own configured guard (F7 taker tautology)", () => {
  const facts = sessionFacts({ guard: OTHER_GUARD });
  const flash = flashQuoteBody({ taker: OTHER_GUARD }) as unknown as TradfiFlashQuote;
  // The session grants OTHER_GUARD, and the quote's taker IS OTHER_GUARD — but
  // the worker's own config still says GUARD. Comparing only the taker against
  // the session (the pre-fix bug) would have accepted this.
  const result = acceptFlashQuote({ request: REQUEST, flash, facts, configuredGuard: GUARD, nowMs: Date.now() });
  assert.deepEqual(result, { ok: false, code: "not-granted" });
});

test("C2: request-mismatch when the quote's pair or amount differs from what was asked", () => {
  const facts = sessionFacts();
  const flash = flashQuoteBody({ amountInAtomic: "999" }) as unknown as TradfiFlashQuote;
  const result = acceptFlashQuote({ request: REQUEST, flash, facts, configuredGuard: GUARD, nowMs: Date.now() });
  assert.deepEqual(result, { ok: false, code: "request-mismatch" });
});

test("C2: identity when router/spender/chain are not the reviewed Flash deployment", () => {
  const facts = sessionFacts();
  const flash = flashQuoteBody({ router: WBNB_56 }) as unknown as TradfiFlashQuote;
  const result = acceptFlashQuote({ request: REQUEST, flash, facts, configuredGuard: GUARD, nowMs: Date.now() });
  assert.deepEqual(result, { ok: false, code: "identity" });
});

test("C2: expired when less than TRADFI_GUARD_MIN_REMAINING_MS remains", () => {
  const facts = sessionFacts();
  const now = Date.now();
  const flash = flashQuoteBody({ expiresAt: now + 3_000 }) as unknown as TradfiFlashQuote;
  const result = acceptFlashQuote({ request: REQUEST, flash, facts, configuredGuard: GUARD, nowMs: now });
  assert.deepEqual(result, { ok: false, code: "expired" });
});

test("C2: the pass case returns a guard quote built from the Flash fields", () => {
  const facts = sessionFacts();
  const now = Date.now();
  const flash = flashQuoteBody({ observedAt: now, expiresAt: now + 15_000 }) as unknown as TradfiFlashQuote;
  const result = acceptFlashQuote({ request: REQUEST, flash, facts, configuredGuard: GUARD, nowMs: now });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.guardQuote.guard, GUARD);
    assert.equal(result.guardQuote.deadline, BigInt(Math.floor((now + 15_000) / 1_000)));
  }
});

test("R2.9 boundary: 5999ms refuses, 6000ms passes", () => {
  const facts = sessionFacts();
  const now = Date.now();
  const short = flashQuoteBody({ expiresAt: now + Number(TRADFI_GUARD_MIN_REMAINING_MS) - 1 }) as unknown as TradfiFlashQuote;
  assert.equal(acceptFlashQuote({ request: REQUEST, flash: short, facts, configuredGuard: GUARD, nowMs: now }).ok, false);
  const exact = flashQuoteBody({ expiresAt: now + Number(TRADFI_GUARD_MIN_REMAINING_MS) }) as unknown as TradfiFlashQuote;
  assert.equal(acceptFlashQuote({ request: REQUEST, flash: exact, facts, configuredGuard: GUARD, nowMs: now }).ok, true);
});

/* -------------------------------------------------------------------------- */
/* R2.4 — flashRequest clamps slippage everywhere                             */
/* -------------------------------------------------------------------------- */

test("R2.4: flashRequest clamps slippageBps to 300 and passes everything else through", () => {
  const clamped = flashRequest({ tokenIn: USDT_56, tokenOut: TOKEN, amountAtomic: "1", slippageBps: 500 });
  assert.equal(clamped.slippageBps, 300);
  const untouched = flashRequest({ tokenIn: USDT_56, tokenOut: TOKEN, amountAtomic: "1", slippageBps: 100 });
  assert.equal(untouched.slippageBps, 100);
});

/* -------------------------------------------------------------------------- */
/* C9 — guard verification retry cache                                       */
/* -------------------------------------------------------------------------- */

test("C9: a false verdict is retried after 60s; a true verdict is never re-read", async () => {
  let calls = 0;
  let clock = 0;
  let answer = false;
  const cached = cachedGuardVerification(async () => { calls += 1; return answer; }, { now: () => clock });
  assert.equal(await cached(), false);
  assert.equal(calls, 1);
  clock += 59_999;
  assert.equal(await cached(), false);
  assert.equal(calls, 1, "a false verdict must not be re-read before 60s");
  clock += 1;
  answer = true;
  assert.equal(await cached(), true);
  assert.equal(calls, 2, "60s must trigger exactly one retry");
  clock += 10_000_000;
  assert.equal(await cached(), true);
  assert.equal(calls, 2, "a true verdict is cached for the process lifetime");
});

/* -------------------------------------------------------------------------- */
/* G5/R2.4/R2.8 — the tri-state capability probe cache                        */
/* -------------------------------------------------------------------------- */

test("G5/R2.4: capable is cached for 10 min, incapable for 2 min, unknown is never cached", async () => {
  let clock = 0;
  let calls = 0;
  let answer: TradfiCapabilityProbeResult = "capable";
  const cache = createTradfiCapabilityProbeCache({ now: () => clock });
  const probe = () => cache.probe("k", async () => { calls += 1; return answer; });

  assert.equal(await probe(), "capable");
  assert.equal(calls, 1);
  clock += 10 * 60_000 - 1;
  assert.equal(await probe(), "capable");
  assert.equal(calls, 1, "capable must not be re-probed inside 10 minutes");
  clock += 2;
  answer = "incapable";
  assert.equal(await probe(), "incapable");
  assert.equal(calls, 2, "10 minutes must trigger exactly one re-probe");
  clock += 2 * 60_000 - 1;
  assert.equal(await probe(), "incapable");
  assert.equal(calls, 2, "incapable must not be re-probed inside 2 minutes");
  clock += 2;
  answer = "unknown";
  assert.equal(await probe(), "unknown");
  assert.equal(calls, 3, "2 minutes must trigger exactly one re-probe");
  answer = "capable";
  assert.equal(await probe(), "capable");
  assert.equal(calls, 4, "unknown must never be cached — the very next call re-probes");
});

test("R2.8 (M3): in-flight calls for the same key are deduped; a thrown probe is not cached", async () => {
  const cache = createTradfiCapabilityProbeCache();
  let calls = 0;
  let resolve!: (value: TradfiCapabilityProbeResult) => void;
  const pending = new Promise<TradfiCapabilityProbeResult>((r) => { resolve = r; });
  const first = cache.probe("k", async () => { calls += 1; return pending; });
  const second = cache.probe("k", async () => { calls += 1; return pending; });
  resolve("capable");
  assert.deepEqual(await Promise.all([first, second]), ["capable", "capable"]);
  assert.equal(calls, 1, "a second call for the same key while the first is in flight must not re-run the probe");

  await assert.rejects(cache.probe("throws", async () => { throw new Error("transient"); }), /transient/u);
  let after = 0;
  assert.equal(await cache.probe("throws", async () => { after += 1; return "capable"; }), "capable");
  assert.equal(after, 1, "a thrown probe must not be cached — the next call for that key runs again");
});

test("AUDIT MEDIUM-2 (M17): classifyTradfiFlashError maps incapable vs unknown", () => {
  assert.equal(classifyTradfiFlashError(new Error("binance_no_route")), "incapable");
  assert.equal(classifyTradfiFlashError(new Error("binance_no_route:no maker quoted")), "incapable");
  assert.equal(classifyTradfiFlashError(new Error("binance_invalid_response")), "incapable");
  assert.equal(classifyTradfiFlashError(new Error("binance_unavailable:rate_budget_exhausted")), "unknown");
  assert.equal(classifyTradfiFlashError(new Error("Data plane is unreachable: AbortError.")), "unknown");
  assert.equal(classifyTradfiFlashError(new Error("")), "unknown");
  assert.equal(classifyTradfiFlashError("not an Error"), "unknown");
  assert.equal(classifyTradfiFlashError(undefined), "unknown");
});

/* -------------------------------------------------------------------------- */
/* R3.2 — the deferred premium is Schedule-only                              */
/* -------------------------------------------------------------------------- */

function productionShapedFact(overrides: Partial<RwaFact> = {}): RwaFact {
  return { platform: "bstock", underlyingTicker: "PLTR", tokenPriceUsd: null, referencePriceUsd: 25,
    premiumBps: null, openState: true, marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh",
    tokenToShareRatio: 1, onchainPriceUsd: null, venues: [], ...overrides };
}

test("R3.2: Schedule (allowVenueMissing + deferUnknownPremium) allows a pool-less, premium-null fact as deferred", () => {
  const verdict = rwaEntryVerdict(productionShapedFact(), Date.now(), { allowVenueMissing: true, deferUnknownPremium: true });
  assert.deepEqual(verdict, { kind: "allow", note: "premium:deferred" });
});

test("R3.2: the deferred allow still requires a positive reference price and ratio", () => {
  const verdict = rwaEntryVerdict(productionShapedFact({ referencePriceUsd: null }), Date.now(),
    { allowVenueMissing: true, deferUnknownPremium: true });
  assert.deepEqual(verdict, { kind: "refuse", reason: "premium-unknown" });
});

test("R3.2: AI entry (allowVenueMissing only, no deferUnknownPremium) still refuses premium-unknown", () => {
  const verdict = rwaEntryVerdict(productionShapedFact(), Date.now(), { allowVenueMissing: true });
  assert.deepEqual(verdict, { kind: "refuse", reason: "premium-unknown" });
});

/* -------------------------------------------------------------------------- */
/* C3 — the guard deadline clamp and the pre-submit re-check (execute.ts)     */
/* -------------------------------------------------------------------------- */

async function guardExecuteFixture() {
  const now = Date.now();
  const agents = new MemoryAgentStore();
  const spec = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 },
    tokens: [{ token: TOKEN }], nativeCaps: [{ limit: E, period: "day" }], quoteToken: USDT_56,
    quoteDailyCapWei: 100n * E, quotePerTradeCapWei: 20n * E, aggregatorGuard: GUARD,
    nowSeconds: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 86_400 });
  const agent = await agents.createAgent({ id: "guard-execute", ownerAddress: OWNER, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed", caps: { dailyNativeWei: E },
    sessionFacts: { spec, permissions: validateSessionSpec(spec), publicKey: KEY, expiry: spec.expiresAt,
      grantedAtSec: Math.floor(now / 1000) - 86_400, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0",
        settlementAsset: "USDT", minEntryWei: (5n * E).toString(), capitalQuoteWei: (100n * E).toString(),
        entryWei: (20n * E).toString(), quotePerTradeWei: (20n * E).toString() } } });
  await agents.putAgentSessionKey(OWNER, agent.id, SESSION_KEY);
  return { now, agents, agent, provider: new FakeWalletProvider(), journal: new MemoryExecutionJournal(() => now) };
}

function guardRequest(deadlineSec: bigint): Parameters<typeof executeTradeForAgent>[0]["request"] {
  return { decisionId: "guard-buy", venue: "pancake_v3", side: "buy", token: TOKEN,
    amountWei: 5n * E, quotedOutWei: 5n * E, minOutWei: (5n * E * 97n) / 100n,
    settlementAsset: "USDT", platformFeeAtomic: 0n,
    guardQuote: { guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
      calldata: "0xad43f73d", deadline: deadlineSec } };
}

test("C3: a deadline 30s ahead is clamped to now+14 in the submitted calldata", async () => {
  const h = await guardExecuteFixture();
  const nowSec = BigInt(Math.floor(h.now / 1_000));
  const result = await executeTradeForAgent({ agent: h.agent, request: guardRequest(nowSec + 30n),
    idempotencyKey: H, paramsHash: H, scanGate: { evaluate: async () => ({ verdict: "allow", reasons: [] }) },
    deps: { chainId: 56, keyStore: GUARD, agentStore: h.agents, journal: h.journal,
      killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => h.provider },
      trade: tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } }),
      pancake: null, pancakeV3: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, uniswapV3: null,
      flapPortal: null, nowMs: () => h.now } });
  assert.equal(result.kind, "committed", result.kind === "denied" || result.kind === "rolled-back" ? result.code : result.kind);
  assert.equal(h.provider.executeCalls.length, 1);
  const guardCall = h.provider.executeCalls[0]!.calls.at(-1)!;
  const decoded = decodeFunctionData({ abi: TRADFI_SWAP_GUARD_ABI, data: guardCall.data! });
  assert.equal(decoded.functionName, "swap");
  const deadline = decoded.args[4] as bigint;
  assert.equal(deadline, nowSec + TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC - 1n, "the clamp must only ever LOWER the deadline");
});

test("C3: a guard request with under 6s left denies GUARD_QUOTE_EXPIRED before executeViaSession", async () => {
  const h = await guardExecuteFixture();
  const nowSec = BigInt(Math.floor(h.now / 1_000));
  const result = await executeTradeForAgent({ agent: h.agent, request: guardRequest(nowSec + 2n),
    idempotencyKey: H, paramsHash: H, scanGate: { evaluate: async () => ({ verdict: "allow", reasons: [] }) },
    deps: { chainId: 56, keyStore: GUARD, agentStore: h.agents, journal: h.journal,
      killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => h.provider },
      trade: tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } }),
      pancake: null, pancakeV3: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, uniswapV3: null,
      flapPortal: null, nowMs: () => h.now } });
  assert.equal(result.kind, "rolled-back", result.kind);
  assert.equal((result as { code: string }).code, "GUARD_QUOTE_EXPIRED");
  assert.equal(h.provider.executeCalls.length, 0, "executeViaSession must never be called");
  // L2/R2.5: the journal row this same call created (beginWithSpend, before the
  // deny) must actually reach ROLLED_BACK, and the quote spend it reserved
  // must be released — not just left PENDING/held forever.
  const row = await h.journal.getByDecision(h.agent.id, "guard-buy");
  assert.equal(row?.state, "ROLLED_BACK");
  assert.equal(await h.journal.sumPendingQuoteSpendSince(h.agent.id, 0), 0n, "a rolled-back row must not hold its quote spend pending");
});

// R2.9/R3.7's source-wiring scan moved to test/audit.tradfiAggregatorWiring.test.ts
// (L5): it belongs in the auditor-protected `audit.*` class, not a file a
// builder may edit freely.

/* -------------------------------------------------------------------------- */
/* M1/L1 — exit-LLM cost-based ranking, per-position isolation, and dedupe    */
/* -------------------------------------------------------------------------- */

const TOKEN2 = getAddress("0x3333333333333333333333333333333333333366");

function exitFlashQuote(input: { readonly tokenIn: `0x${string}`; readonly tokenOut: `0x${string}`; readonly amountAtomic: string;
  readonly quotedOutAtomic: bigint; readonly nowMs: number }): TradfiFlashQuote {
  return { version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: input.tokenIn, tokenOut: input.tokenOut,
    amountInAtomic: input.amountAtomic, quotedOutAtomic: input.quotedOutAtomic.toString(10),
    minOutAtomic: (input.quotedOutAtomic * 97n / 100n).toString(10), router: TRADFI_BINANCE_FLASH_ROUTER_56,
    spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", value: "0", observedAt: input.nowMs,
    expiresAt: input.nowMs + 15_000, estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56 };
}

/** A minimal two-position exit-cycle fixture, shared by the three tests below. */
async function exitCycleFixture(input: {
  readonly tokens: readonly `0x${string}`[];
  readonly binanceQuoteAndSwap: (request: { readonly tokenIn: `0x${string}`; readonly tokenOut: `0x${string}`; readonly amountAtomic: string; readonly slippageBps: number }) => Promise<TradfiFlashQuote>;
  readonly quoteBestDirect: bigint | null;
  /** Blank thresholds reach the exit-LLM re-quote (M1/L1a); concrete ones never call the LLM at all (L1b). */
  readonly blankThresholds: boolean;
  /**
   * Defaults to: any call touching GUARD costs 3*E, everything else costs 0.
   * Pass a function for a null-returning cost oracle (Re-verification #1); pass
   * `null` itself (AUDIT LOW-2) to omit `deps.tradfiNativeCostUsdtAtomic`
   * entirely — the two are different worker code paths (`=== undefined` vs a
   * call that resolves to `null`), even though both currently converge on the
   * same `aggregatorCost === null` branch.
   */
  readonly tradfiNativeCostUsdtAtomic?: ((input: { readonly calls: readonly { readonly to: `0x${string}` }[] }) => Promise<bigint | null>) | null;
  /** R2.2 (M4): override the executor's outcome per request — default is always a confirmed commit. */
  readonly executeOutcome?: (input: TradeExecutorInput) => Promise<TradeExecutorResult>;
  /** AUDIT HIGH-1: re-triggers the exit-LLM on every cycle (a regime flip) — otherwise an unchanged pnl never re-fires `evaluateExitTrigger` past cycle 1. */
  readonly usEquityRegime?: () => Promise<{ readonly regime: "risk_on" | "risk_off" | "neutral" | "unavailable"; readonly reasons: readonly string[]; readonly asOf: number | null }>;
}) {
  const now = Date.now();
  const agents = new MemoryAgentStore();
  const positions = new MemoryTradePositionStore(() => now);
  const intents = new MemoryTradeIntentStore(() => now);
  const settingsStore = new MemoryTradeSettingsStore(agents, () => now);
  const journal = new MemoryExecutionJournal(() => now);
  const spec = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 },
    tokens: input.tokens.map((token) => ({ token })), nativeCaps: [{ limit: E, period: "day" }], quoteToken: USDT_56,
    quoteDailyCapWei: 100n * E, quotePerTradeCapWei: 20n * E, aggregatorGuard: GUARD,
    nowSeconds: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 86_400 });
  const agent = await agents.createAgent({ id: "exit-cycle", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey",
    status: "armed", sessionFacts: { spec, permissions: validateSessionSpec(spec), publicKey: KEY, expiry: spec.expiresAt,
      grantedAtSec: Math.floor(now / 1000) - 86_400, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0",
        settlementAsset: "USDT", minEntryWei: (5n * E).toString(), capitalQuoteWei: (100n * E).toString() } } });
  for (const [index, token] of input.tokens.entries()) {
    await positions.open({ positionId: `pos-${index}`, agentId: agent.id, ownerAddress: OWNER, token, route: { hops: [], fees: [] },
      entryWei: 5n * E, tokenAmount: E / 20n, fillStatus: "verified", openedAt: now - 60_000, settlementAsset: "USDT",
      requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|${index}|${H}` });
  }
  const settings: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
    minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString(),
    cmcNewsEnabled: false, crashProtection: false,
    ...(input.blankThresholds ? { takeProfitBps: null, stopLossBps: null, maxHoldSec: null }
      : { takeProfitBps: 9_000, stopLossBps: 9_000, maxHoldSec: 604_800 }) };
  await settingsStore.put({ agentId: agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  let executed: TradeRequest[] = [];
  const direct = input.quoteBestDirect;
  const routeReader = direct === null
    ? { quoteV2: async () => { throw new Error("no public AMM"); }, quoteV3Single: async () => { throw new Error("no public AMM"); },
        quoteV3Path: async () => { throw new Error("no public AMM"); }, quoteUniV3Single: async () => { throw new Error("no public AMM"); },
        quoteUniV3Path: async () => { throw new Error("no public AMM"); } }
    : { quoteV2: async () => direct, quoteV3Single: async () => direct, quoteV3Path: async () => direct,
        quoteUniV3Single: async () => direct, quoteUniV3Path: async () => direct };
  const deps: TradeWorkerDeps = { agentStore: agents, settingsStore, positions, intents, journal, aggregatorGuard: GUARD,
    dataPlane: { universe: async () => [], tokensBatch: async () => [], eligibilityBatch: async () => [], security: async () => ({}),
      binanceQuoteAndSwap: input.binanceQuoteAndSwap,
      ...(input.usEquityRegime === undefined ? {} : { usEquityRegime: input.usEquityRegime }) },
    provider: { getTokenBalance: async ({ token }) => token.toLowerCase() === USDT_56.toLowerCase() ? 60n * E : E / 20n,
      readSpendInfos: async () => [{ token: USDT_56, period: "day", periodCode: 2, limitWei: 60n * E, currentSpentWei: 0n }] },
    llmFor: () => ({ complete: async () => ({ model: "fixture", content: JSON.stringify({
      decisions: input.tokens.map((_token, index) => ({ index, exit: true, reason: "sell" })) }) }) }),
    executor: { execute: async (request) => { executed.push(request.request);
      if (input.executeOutcome !== undefined) return input.executeOutcome(request);
      return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: H },
        fill: { side: "sell", exitWei: null, fillStatus: "unverified" }, meta: {} }; } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(input.tokens.map((t) => t.toLowerCase())) },
    rpcUrls: [], routeReader, platformFeeBps: 0,
    // AUDIT LOW-2: `null` omits the deps field (a genuinely undefined cost
    // oracle); anything else (including no override at all) falls back to the
    // default GUARD-aware cost function.
    ...(input.tradfiNativeCostUsdtAtomic === null ? {} : { tradfiNativeCostUsdtAtomic: input.tradfiNativeCostUsdtAtomic
      ?? (async ({ calls }) => calls.some((call) => call.to.toLowerCase() === GUARD.toLowerCase()) ? 3n * E : 0n) }),
    forbiddenAddresses: () => new Set(),
    executionIdentity: (_a, request) => ({ idempotencyKey: keccak256Stub(request.decisionId), paramsHash: H }),
    recoverFill: async () => ({ side: "sell", exitWei: null, fillStatus: "unverified" }), now: () => now };
  // R2.2 (M4): `rerun` reuses the same durable stores/session (a fresh cycle
  // against the same position), the only way to observe a per-position marker
  // that is written by one cycle and consumed by the next.
  const runCycle = async () => {
    executed = [];
    const report = await runTradeWorkerOnce(deps);
    const events = report.outcomes.flatMap((outcome) => (outcome as unknown as { events?: readonly { readonly stage: string; readonly code: string; readonly reason?: string; readonly token?: string }[] }).events ?? []);
    return { executed, events };
  };
  const first = await runCycle();
  return { ...first, now, rerun: runCycle };
}

/** `TradeRequest` carries bigints, which `JSON.stringify` cannot serialize. */
function describeExecuted(executed: readonly TradeRequest[]): string {
  return JSON.stringify(executed.map((request) => ({ token: request.token, hasGuardQuote: request.guardQuote !== undefined })));
}

// A local, dependency-free stand-in: the identity function's own return value
// is never inspected by these tests (only `executor.execute`'s calls are), so
// any deterministic 32-byte hex satisfies `Hex`.
function keccak256Stub(seed: string): Hex {
  const hex = Buffer.from(seed).toString("hex").padEnd(64, "0").slice(0, 64);
  return `0x${hex}` as Hex;
}

test("R2.7 (guard-preference G1): the exit-LLM re-quote selects Binance; guardQuote is present", async () => {
  // entryWei is 5*E (exitCycleFixture); a 6*E direct quote is +20% pnl, well
  // past the trigger's cost-band threshold, so the LLM is actually asked
  // (a 0-pnl quote never triggers evaluateExitTrigger's first-look check).
  //
  // R2.7 (authorized inversion of the pre-guard-preference assertion): P-a
  // replaced the net-price ranking this test used to prove with "Binance
  // wins whenever usable". Binance's minOut (97% of 7*E) clears the R2.1
  // direct-floor rail against direct's own minOut (a fraction of 6*E), and
  // its cost-oracle call is non-null (3*E, the GUARD-touching branch of the
  // mock) — so it is usable, and G1 says usable wins even though a net-cost
  // comparison (the removed ranking) would have picked direct here:
  // net(direct)=6*E would have beaten net(binance)=7*E-3*E=4*E.
  const { executed } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 6n * E, blankThresholds: true,
    binanceQuoteAndSwap: async (request) => exitFlashQuote({ ...request, quotedOutAtomic: 7n * E, nowMs: Date.now() }),
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0]?.token, TOKEN);
  assert.notEqual(executed[0]?.guardQuote, undefined, "Binance must be selected whenever usable — no net-price ranking against direct");
});

test("M1/C6: a null cost on either leg refuses the aggregator (cost-unavailable) and never falls through to a bare minOut compare", async () => {
  // A fresh direct quote is always available here (6*E), so the position's
  // legitimate direct exit still proceeds — refusing the AGGREGATOR leg on an
  // unpriced cost must not block an otherwise-normal direct sell. What this
  // proves is narrower and load-bearing: with both costs null, Binance is
  // NEVER selected (no `guardQuote`) and the refusal is recorded — the
  // pre-M1 code had no null check at all and would rank on bare `minOut`
  // instead (R1: exactly what the main loop still does), and Binance's
  // 7*E quote has the higher minOut, so it would win.
  const { executed, events } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 6n * E, blankThresholds: true,
    binanceQuoteAndSwap: async (request) => exitFlashQuote({ ...request, quotedOutAtomic: 7n * E, nowMs: Date.now() }),
    tradfiNativeCostUsdtAtomic: async () => null, // both legs null: the direct leg is null here too, not just the aggregator leg.
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0]?.token, TOKEN);
  assert.equal(executed[0]?.guardQuote, undefined, "Binance must never be selected when its cost cannot be priced");
  assert.ok(events.some((event) => event.stage === "route" && event.code === "binance-refused" && event.reason === "cost-unavailable"),
    `expected a cost-unavailable refusal; events=${JSON.stringify(events)}`);
});

test("M1/C6: the exit-LLM re-quote picks Binance when its net cost genuinely wins", async () => {
  // The mirror of the first M1 test, and the case that actually distinguishes
  // "null costs" (R-M1a) from correct behaviour: here the CORRECT answer is
  // Binance, so forcing both costs to null (which correctly refuses the
  // aggregator and falls back to direct) changes the OUTCOME, not just the
  // reasoning — closing the blind spot the direct-wins tests above cannot
  // close on their own (there, null-refusal and correct real-cost computation
  // coincidentally land on the same "direct" answer).
  const { executed } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 6n * E, blankThresholds: true,
    binanceQuoteAndSwap: async (request) => exitFlashQuote({ ...request, quotedOutAtomic: 7n * E, nowMs: Date.now() }),
    // direct is the EXPENSIVE route here (5*E net cost), Binance is free:
    // net(direct)=6*E-5*E=1*E, net(binance)=7*E-0=7*E.
    tradfiNativeCostUsdtAtomic: async ({ calls }) => calls.some((call) => call.to.toLowerCase() === GUARD.toLowerCase()) ? 0n : 5n * E,
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0]?.token, TOKEN);
  assert.notEqual(executed[0]?.guardQuote, undefined, "Binance must win here — its net proceeds are strictly higher");
});

for (const failing of [TOKEN, TOKEN2] as const) {
  test(`L1(a)/C6: a Flash failure on ${failing === TOKEN ? "TOKEN" : "TOKEN2"}'s exit-llm re-quote does not stop the other position's exit`, async () => {
    const other = failing === TOKEN ? TOKEN2 : TOKEN;
    const calls = new Map<string, number>();
    const { executed } = await exitCycleFixture({
      tokens: [TOKEN, TOKEN2], quoteBestDirect: null, blankThresholds: true, // routeReader throws — every quote goes through the Flash fallback.
      binanceQuoteAndSwap: async (request) => {
        const key = request.tokenIn.toLowerCase() === USDT_56.toLowerCase() ? request.tokenOut.toLowerCase() : request.tokenIn.toLowerCase();
        const count = (calls.get(key) ?? 0) + 1;
        calls.set(key, count);
        // Each position's FIRST Flash call is the main sell loop's own fallback
        // (must succeed so the position reaches decideExit/the LLM at all); the
        // SECOND is the exit-LLM's own fallback re-quote, where `failing` fails.
        // Parameterized over BOTH tokens: the worker processes `triggered` in
        // an order (TOKEN2 first) that a TOKEN-only failure never exercises —
        // failing TOKEN2 is the case that actually walks off the end of the
        // per-position loop if the fallback's catch is ever made to rethrow.
        if (key === failing.toLowerCase() && count >= 2) throw new Error(`binance_unavailable:down for ${failing}'s second call`);
        return exitFlashQuote({ ...request, quotedOutAtomic: 6n * E, nowMs: Date.now() });
      },
    });
    assert.ok(executed.some((request) => request.token.toLowerCase() === other.toLowerCase()),
      `the other position (${other}) must still execute; executed=${JSON.stringify(executed.map((r) => r.token))}`);
  });
}

test("L1(b)/C7: the main sell loop makes at most one Flash call per position", async () => {
  let flashCalls = 0;
  await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: null, blankThresholds: false, // direct always throws — forces the sell loop's own fallback (site 1).
    binanceQuoteAndSwap: async (request) => { flashCalls += 1; return exitFlashQuote({ ...request, quotedOutAtomic: 6n * E, nowMs: Date.now() }); },
  });
  // Without the C7 dedupe (`guardQuote === undefined &&` before the comparison
  // site), the fallback's successful quote would be followed by a second,
  // redundant comparison-site call for the same position in the same cycle.
  assert.equal(flashCalls, 1, "the comparison site must be skipped once the fallback already set a guard quote");
});

/* -------------------------------------------------------------------------- */
/* Guard-preference (G1, R2.1, R2.2, R2.6) — MD here/TRADFI-GUARD-PREFERENCE   */
/* -------------------------------------------------------------------------- */

test("G1 (main loop): Binance is selected even though direct's net cost would be far better", async () => {
  const { events } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 6n * E, blankThresholds: false,
    binanceQuoteAndSwap: async (request) => exitFlashQuote({ ...request, quotedOutAtomic: 7n * E, nowMs: Date.now() }),
  });
  assert.ok(events.some((event) => event.stage === "route" && event.code === "binance-guard" && event.token === TOKEN),
    `expected the main loop to select Binance; events=${JSON.stringify(events)}`);
  assert.equal(events.some((event) => event.reason === "ranked-out"), false, "ranked-out must never appear again");
});

test("R2.1 (H1a, main loop): a Flash quote below the fresh direct minOut is refused as direct-floor", async () => {
  const { events } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 6n * E, blankThresholds: false,
    binanceQuoteAndSwap: async (request) => exitFlashQuote({ ...request, quotedOutAtomic: 1n * E, nowMs: Date.now() }),
  });
  assert.ok(events.some((event) => event.stage === "route" && event.code === "binance-refused"
    && event.reason === "direct-floor" && event.token === TOKEN),
    `expected a direct-floor refusal; events=${JSON.stringify(events)}`);
  assert.equal(events.some((event) => event.code === "binance-guard"), false, "Binance must not win below the direct floor");
});

test("R2.1 (H1a): the direct-floor rail applies independently at the main loop and the exit-LLM re-quote", async () => {
  let calls = 0;
  const { events } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 6n * E, blankThresholds: true,
    binanceQuoteAndSwap: async (request) => {
      calls += 1;
      // 1st call is the main-loop comparison (well above the ~5.82*E direct
      // floor, so Binance wins there); the 2nd+ calls are the exit-LLM's OWN
      // fresh re-quote, deliberately far below its OWN fresh direct floor —
      // proving the rail is not just inherited from the main loop's pick.
      return exitFlashQuote({ ...request, quotedOutAtomic: calls === 1 ? 7n * E : 1n * E, nowMs: Date.now() });
    },
  });
  assert.ok(events.some((event) => event.stage === "route" && event.code === "binance-guard" && event.token === TOKEN),
    `expected the main loop to select Binance first; events=${JSON.stringify(events)}`);
  assert.ok(events.some((event) => event.stage === "route" && event.code === "binance-refused"
    && event.reason === "direct-floor" && event.token === TOKEN),
    `expected the exit-LLM re-quote to refuse Binance on its OWN direct-floor check; events=${JSON.stringify(events)}`);
});

test("R2.6 (M1): the main loop falls back to direct when the native cost oracle is undefined", async () => {
  const { events } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 6n * E, blankThresholds: false,
    binanceQuoteAndSwap: async (request) => exitFlashQuote({ ...request, quotedOutAtomic: 7n * E, nowMs: Date.now() }),
    // AUDIT LOW-2: `null` (not a function returning null) actually leaves
    // `deps.tradfiNativeCostUsdtAtomic` undefined, matching the test's title.
    tradfiNativeCostUsdtAtomic: null,
  });
  assert.equal(events.some((event) => event.code === "binance-guard"), false, "Binance must not win with no cost oracle");
  assert.ok(events.some((event) => event.stage === "route" && event.code === "binance-refused" && event.reason === "cost-unavailable"),
    `expected a cost-unavailable refusal; events=${JSON.stringify(events)}`);
});

test("R2.2 (M4): a guard sell rollback triggers a one-shot direct escape, then Binance is preferred again", async () => {
  // `directSellEscape` is keyed by the bare position id (spec-named, per-worker
  // Set) — every single-token fixture in this file opens "pos-0", so ONLY the
  // first guard attempt here rolls back. Cycle 3's guard attempt must SUCCEED
  // (and close the position) or it would re-arm the escape and leak "pos-0"
  // into whichever single-token test in this file runs next.
  let guardAttempts = 0;
  const committed = { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: H },
    fill: { side: "sell" as const, exitWei: null, fillStatus: "unverified" as const }, meta: {} };
  const { executed: firstExecuted, rerun } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 15n * E, blankThresholds: false,
    binanceQuoteAndSwap: async (request) => exitFlashQuote({ ...request, quotedOutAtomic: 16n * E, nowMs: Date.now() }),
    executeOutcome: async (input) => {
      if (input.request.guardQuote === undefined) return committed;
      guardAttempts += 1;
      return guardAttempts === 1 ? { kind: "rolled-back", code: "GUARD_QUOTE_EXPIRED", meta: {} } : committed;
    },
  });
  assert.equal(firstExecuted.length, 1);
  assert.notEqual(firstExecuted[0]?.guardQuote, undefined, "cycle 1 must attempt the sell via the guard");

  const second = await rerun();
  assert.equal(second.executed.length, 1);
  assert.equal(second.executed[0]?.guardQuote, undefined, "cycle 2 must use direct — the one-shot escape");
  assert.ok(second.events.some((event) => event.stage === "route" && event.code === "binance-refused" && event.reason === "escape-after-guard-failure"),
    `expected the escape refusal on cycle 2; events=${JSON.stringify(second.events)}`);

  const third = await rerun();
  assert.equal(third.executed.length, 1);
  assert.notEqual(third.executed[0]?.guardQuote, undefined, "cycle 3 must prefer Binance again — the escape is one-shot");
});

test("R2.2 (M4): a confirmed FAILED guard sell also triggers the escape", async () => {
  // Same leak avoidance as above: the second (direct) sell must succeed and
  // close the position, so this test leaves no escape entry behind either.
  const { executed: firstExecuted, rerun } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 15n * E, blankThresholds: false,
    binanceQuoteAndSwap: async (request) => exitFlashQuote({ ...request, quotedOutAtomic: 16n * E, nowMs: Date.now() }),
    executeOutcome: async (input) => input.request.guardQuote === undefined
      ? { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: H }, fill: { side: "sell", exitWei: null, fillStatus: "unverified" }, meta: {} }
      : { kind: "committed", receipt: { status: "FAILED", failureCode: "PROVIDER_ERROR" }, fill: null, meta: {} },
  });
  assert.notEqual(firstExecuted[0]?.guardQuote, undefined);
  const second = await rerun();
  assert.equal(second.executed[0]?.guardQuote, undefined, "a confirmed FAILED guard sell escapes to direct too");
});

test("AUDIT HIGH-1/R2.2: the escape also reaches an exit-LLM-driven (blank-threshold) sell — the AI-trade default", async () => {
  // Blank thresholds ("no time limit — the model decides") mean the sell is
  // decided ONLY at the exit-LLM re-quote, never the main loop's own
  // decideExit. A regime flip on every call guarantees `evaluateExitTrigger`
  // re-fires each cycle regardless of which quote (direct or Binance) happened
  // to feed the prior cycle's persisted pnl.
  let regimeCalls = 0;
  const committed = { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: H },
    fill: { side: "sell" as const, exitWei: null, fillStatus: "unverified" as const }, meta: {} };
  let guardAttempts = 0;
  const { executed: firstExecuted, rerun } = await exitCycleFixture({
    tokens: [TOKEN], quoteBestDirect: 6n * E, blankThresholds: true,
    binanceQuoteAndSwap: async (request) => exitFlashQuote({ ...request, quotedOutAtomic: 7n * E, nowMs: Date.now() }),
    usEquityRegime: async () => { regimeCalls += 1;
      return { regime: regimeCalls % 2 === 0 ? "risk_off" : "risk_on", reasons: [], asOf: Date.now() }; },
    executeOutcome: async (input) => {
      if (input.request.guardQuote === undefined) return { kind: "rolled-back", code: "NOT_ALLOWED", meta: {} };
      guardAttempts += 1;
      return guardAttempts === 1 ? { kind: "rolled-back", code: "GUARD_QUOTE_EXPIRED", meta: {} } : committed;
    },
  });
  assert.equal(firstExecuted.length, 1, `cycle 1 must sell once; executed=${describeExecuted(firstExecuted)}`);
  assert.notEqual(firstExecuted[0]?.guardQuote, undefined, "cycle 1's exit-LLM sell must attempt the guard");

  const second = await rerun();
  assert.equal(second.executed.length, 1, `cycle 2 must sell once; executed=${describeExecuted(second.executed)}`);
  assert.equal(second.executed[0]?.guardQuote, undefined,
    "cycle 2's exit-LLM sell must go direct — the escape reaches the exit-LLM site, not just the main loop's comparison");
  assert.ok(second.events.some((event) => event.stage === "route" && event.code === "binance-refused" && event.reason === "escape-after-guard-failure"),
    `expected an escape refusal on cycle 2; events=${JSON.stringify(second.events)}`);

  const third = await rerun();
  assert.equal(third.executed.length, 1, `cycle 3 must sell once; executed=${describeExecuted(third.executed)}`);
  assert.notEqual(third.executed[0]?.guardQuote, undefined, "cycle 3 must prefer Binance again — the escape is one-shot");
});
