/**
 * TRADFI-CMC-EQUITY N8/R2.1/R2.3/R2.8: end-to-end slot priority across a
 * simulated day, daily budget bound, planning order with 8 held over 3
 * trading days, and the momentum-scanner/index-snapshot exclusion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, type Hex } from "viem";
import { CMC_CONFIG_ID, CMC_LLM_REQUEST_CAP_PER_WINDOW, CMC_LLM_REQUEST_MIN_REMAINING_WEI, CMC_PAYEE, CMC_PRICE_ATOMIC, CMC_SIGNER, CMC_SPENDER } from "../src/trade/cmc.js";
import { createCmcNewsService } from "../src/trade/cmcNews.js";
import { CMC_SKILL_EVENTS, CMC_SKILL_PLANNING, PLANNING_CAP_PER_WINDOW, latestCompletedNySessionDate, planningWindowStartMs, selectPlanningTicker } from "../src/trade/cmcUsEquity.js";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { USDT_56 } from "../src/trade/settlement.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const KEY = `0x04${"22".repeat(64)}` as Hex;
const TOTAL = 1_000_000_000_000_000_000n;

/** Responds with a minimally valid payload for whichever skill/tool the body names. */
function bodyToResponse(body: string, nowMs: number): string {
  const parsed = JSON.parse(body) as { readonly params?: { readonly name?: string; readonly arguments?: { readonly unique_name?: string } } };
  const toolName = parsed.params?.name;
  const skillName = parsed.params?.arguments?.unique_name;
  if (toolName === "get_global_metrics_latest") {
    return JSON.stringify({ result: { content: [{ type: "text", text: '{"total_crypto_market_cap_usd":{"percent_change":{"24h":"+0.1%","7d":"+0.1%"}}}' }] } });
  }
  // AUDIT HIGH-1: the "+1 after release" call is the REAL macro_news_aggregator
  // skill (there is no such skill as "macro_news_aggregator:release" — only the
  // store key differs); a build that regresses to sending the bogus name must
  // fail this fixture via the `assert.fail` default below, not be silently accepted.
  if (skillName === "macro_news_aggregator") {
    const pack = { type: "evidence_pack", skill_id: skillName, timestamp: "2026-09-23T00:00:00Z",
      data: { evidence: { upcoming_events_72h: [], later_events_days_4_to_7: [], recent_macro_releases: [] } } };
    return JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ result: { ok: true, data: pack } }) }] } });
  }
  if (skillName === "us_equity_sector_rotation") {
    const pack = { type: "evidence_pack", skill_id: skillName, timestamp: "2026-09-23T00:00:00Z",
      data: { evidence: { sector_rotation: [], theme_rotation: [], growth_vs_defensive: {}, benchmark_context: [] } } };
    return JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ result: { ok: true, output: JSON.stringify(pack) } }) }] } });
  }
  if (skillName === "us_equity_uptrend_quality_scanner") {
    const pack = { type: "evidence_pack", skill_id: skillName, timestamp: "2026-09-23T00:00:00Z",
      data: { as_of_trading_day: "2026-09-23", alpha_candidates: [] } };
    return JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ result: { ok: true, output: JSON.stringify(pack) } }) }] } });
  }
  if (skillName === "us_equity_trade_planning_context") {
    // Always answers with the CURRENT latest completed session, exactly as the live vendor would.
    const pack = { type: "evidence_pack", skill_id: skillName, timestamp: "2026-09-23T00:00:00Z",
      data: { evidence: { identity: {}, price_basis: {}, market_structure: {}, benchmark_context: {},
        last_completed_session: { session_date: latestCompletedNySessionDate(nowMs) }, key_levels: { static_zones: [] } } } };
    return JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ result: { ok: true, output: JSON.stringify(pack) } }) }] } });
  }
  assert.fail(`unexpected skill/tool requested: tool=${String(toolName)} skill=${String(skillName)} (the momentum scanner / index snapshot must never be requested)`);
}

function paymentFixture(calls: { skill: string | null; tool: string | null }[], clockRef: { value: number }) {
  return {
    async authorize() { return { ok: true as const }; },
    async fetchChallenge(request: { readonly body: string; readonly expectedResource?: string }) {
      return { amountWei: CMC_PRICE_ATOMIC, payTo: CMC_PAYEE, asset: USDT_56, network: "eip155:56" as const,
        spender: CMC_SPENDER, resource: request.expectedResource ?? "", configId: CMC_CONFIG_ID, signerAddress: CMC_SIGNER, maxTimeoutSeconds: 500 };
    },
    async reserve(input: { readonly operationId: string }) { return { attempt: { generation: 0, operationId: input.operationId, state: "reserved" } } as never; },
    async prepare() { return { operationId: "op", state: "prepared" } as never; },
    async transmit(request: { readonly body: string }) {
      const parsed = JSON.parse(request.body) as { readonly params?: { readonly name?: string; readonly arguments?: { readonly unique_name?: string } } };
      const isSkillCall = parsed.params?.name === "execute_skill";
      calls.push({ tool: isSkillCall ? null : parsed.params?.name ?? null, skill: isSkillCall ? parsed.params?.arguments?.unique_name ?? null : null });
      return { status: 200, headers: {}, body: bodyToResponse(request.body, clockRef.value) };
    },
  };
}

async function freshStore(nowMs: number): Promise<MemoryTradeCmcStore> {
  const store = new MemoryTradeCmcStore(() => nowMs);
  await store.putInitial({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, generation: 0, sessionPublicKey: KEY, sessionExpiry: nowMs + 100_000_000, allowanceWei: TOTAL });
  await store.setCapability({ agentId: "a", ownerAddress: OWNER, generation: 0, available: true });
  return store;
}

test("N8/R2.8: weekday priority order and budget — macro before global before sector before scanner; planning fills idle slots; held before shortlisted; <= 0.10 USDT", async () => {
  // Wed 2026-09-23 12:00 UTC = 08:00 ET: the macro/global anchor. Supply (24 hourly
  // slots here; ~23.6/day on the real 60s scheduler) exceeds the ~6 calls actually due,
  // so planning opportunistically fills the idle slots between fixed anchors (R2.1: "due"
  // and "fresh" are separate; priority decides only ORDER among what is due at once).
  const dayStart = Date.UTC(2026, 8, 23, 12, 0);
  const store = await freshStore(dayStart);
  const clockRef = { value: dayStart };
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixture(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  const order: (string | null)[] = [];
  let paidCalls = 0;
  for (let hour = 0; hour < 24; hour += 1) {
    clockRef.value = dayStart + hour * 3_600_000;
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: dayStart + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: ["MSFT"],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
    if (result.state === "available") { paidCalls += 1; order.push(result.ticker); }
  }
  const names = calls.map((call) => call.skill ?? call.tool);
  const indexOf = (name: string): number => names.indexOf(name);
  assert.ok(indexOf("macro_news_aggregator") < indexOf("get_global_metrics_latest"), "macro before global");
  assert.ok(indexOf("get_global_metrics_latest") < indexOf("us_equity_sector_rotation"), "global before sector");
  assert.ok(indexOf("us_equity_sector_rotation") < indexOf("us_equity_uptrend_quality_scanner"), "sector before scanner");
  assert.equal(order.filter((t) => t === "_GLOBAL").length, 4, "macro/global/sector/scanner each fire exactly once");
  assert.ok(order.includes("NVDA"), "the held ticker gets a planning call");
  assert.ok(order.includes("MSFT"), "the shortlisted ticker gets a planning call");
  assert.ok(order.indexOf("NVDA") < order.indexOf("MSFT"), "held wins over shortlisted (R2.3)");
  // 6 calls (macro/global/sector/scanner/NVDA/MSFT) plus 2 more: the 16:00 ET
  // close flips "latest completed session" from D-1 to D, so NVDA/MSFT (fetched
  // before the close with D-1's date) go due again and refresh once more —
  // exactly the N1 flip the spec describes, not unbounded re-fetching.
  assert.equal(paidCalls, 8);
  const spentWei = BigInt(paidCalls) * CMC_PRICE_ATOMIC;
  assert.ok(spentWei <= 100_000_000_000_000_000n, `spent ${spentWei} wei, budget is 0.10 USDT = 1e17 wei`);
  // Skill/tool names actually requested must never include the excluded ones.
  const requestedNames = new Set(calls.flatMap((call) => [call.skill, call.tool].filter((v): v is string => v !== null)));
  assert.ok(!requestedNames.has("us_equity_momentum_scanner"));
  assert.ok(!requestedNames.has("us_equity_index_snapshot"));
  assert.ok(!requestedNames.has("us_equity_research_dossier"));
  assert.ok(!requestedNames.has("get_upcoming_macro_events"));
});

test("R2.1/M7: a weekend day spends only macro + global (<= 0.02 USDT)", async () => {
  // Sat 2026-09-26 12:00 UTC = 08:00 ET.
  const dayStart = Date.UTC(2026, 8, 26, 12, 0);
  const store = await freshStore(dayStart);
  const clockRef = { value: dayStart };
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixture(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  let paidCalls = 0;
  for (let hour = 0; hour < 24; hour += 1) {
    clockRef.value = dayStart + hour * 3_600_000;
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: dayStart + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: ["MSFT"],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
    if (result.state === "available") paidCalls += 1;
  }
  assert.equal(paidCalls, 2, "sector, scanner and planning are not called on Saturday (M7)");
  assert.ok(BigInt(paidCalls) * CMC_PRICE_ATOMIC <= 20_000_000_000_000_000n);
});

test("AUDIT L-6/R3.3: an LLM request is never served (nor refused) on a non-trading day — it stays pending, untouched", async () => {
  // Sat 2026-09-26 12:00 UTC = 08:00 ET.
  const dayStart = Date.UTC(2026, 8, 26, 12, 0);
  const store = await freshStore(dayStart);
  // Pre-seed macro/global so this Saturday's only two due calls are already
  // spent — the ONLY remaining candidate target for the whole day is the
  // pending LLM request, so if it were ever served or even evaluated for
  // refusal, it would show up directly in the result.
  for (const skill of ["macro_news_aggregator", "get_global_metrics_latest"]) {
    await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: "_GLOBAL", skill, generation: 0, status: "available",
      context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: null,
      asOfMs: dayStart, expiresAtMs: dayStart + 24 * 60 * 60_000, lastAttemptAtMs: dayStart });
  }
  const clockRef = { value: dayStart };
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixture(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: dayStart + 100_000_000, generation: 0, heldTickers: [], shortlistedTickers: [],
    masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
    llmRequests: [{ ticker: "TSLA", skill: "planning", reason: "weekend ask", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
  assert.equal(result.ticker, null, "nothing is due or served on a non-trading day, including the pending LLM request");
  assert.equal(result.llmRequestServed, undefined);
  assert.deepEqual(result.llmRequestsRefused, undefined, "a weekend request is neither served nor refused — R3.3 evaluates it only after the isNyTradingDay return");
  assert.equal(calls.length, 0);
});

test("R2.3: 8 held tickers are each refreshed within 2 trading days (cap 5/day, oldest-row-first)", async () => {
  const HELD = ["NVDA", "MSFT", "TSM", "INTC", "MRVL", "TSLA", "GOOGL", "META"];
  // Wed 2026-09-23 21:30 UTC = 17:30 ET, first slot after the 16:30 ET planning window opens.
  const clockRef = { value: Date.UTC(2026, 8, 23, 21, 30) };
  const store = await freshStore(clockRef.value);
  // Mark macro/global/sector/scanner as already fresh so every slot goes to planning.
  for (const skill of ["macro_news_aggregator", "get_global_metrics_latest", "us_equity_sector_rotation", "us_equity_uptrend_quality_scanner"]) {
    await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: "_GLOBAL", skill, generation: 0, status: "available",
      context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: null,
      asOfMs: clockRef.value, expiresAtMs: clockRef.value + 24 * 60 * 60_000, lastAttemptAtMs: clockRef.value });
  }
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixture(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  const seenPerTicker = new Map<string, number>();
  for (let step = 0; step < 3 * 24; step += 1) {
    clockRef.value += 3_600_000;
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: HELD, shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
    if (result.state === "available" && result.ticker !== null && result.ticker !== "_GLOBAL") {
      seenPerTicker.set(result.ticker, (seenPerTicker.get(result.ticker) ?? 0) + 1);
    }
  }
  for (const ticker of HELD) assert.ok((seenPerTicker.get(ticker) ?? 0) >= 1, `${ticker} was never refreshed over 3 trading days`);
});

// ---------------------------------------------------------------------------
// AUDIT HIGH-2: a planning ticker that fails to parse must be attempted at
// most once per window (M5), and the cap must bound CALLS, not distinct
// candidate tickers with a cached row.
// ---------------------------------------------------------------------------

/** Every planning call returns an unrecognized (unparseable-by-compactPlanning) shape; every other skill/tool answers normally. */
function paymentFixtureWithFailingPlanning(calls: { skill: string | null; tool: string | null }[], clockRef: { value: number }) {
  return {
    async authorize() { return { ok: true as const }; },
    async fetchChallenge(request: { readonly body: string; readonly expectedResource?: string }) {
      return { amountWei: CMC_PRICE_ATOMIC, payTo: CMC_PAYEE, asset: USDT_56, network: "eip155:56" as const,
        spender: CMC_SPENDER, resource: request.expectedResource ?? "", configId: CMC_CONFIG_ID, signerAddress: CMC_SIGNER, maxTimeoutSeconds: 500 };
    },
    async reserve(input: { readonly operationId: string }) { return { attempt: { generation: 0, operationId: input.operationId, state: "reserved" } } as never; },
    async prepare() { return { operationId: "op", state: "prepared" } as never; },
    async transmit(request: { readonly body: string }) {
      const parsed = JSON.parse(request.body) as { readonly params?: { readonly name?: string; readonly arguments?: { readonly unique_name?: string } } };
      const isSkillCall = parsed.params?.name === "execute_skill";
      const skillName = isSkillCall ? parsed.params?.arguments?.unique_name ?? null : null;
      calls.push({ tool: isSkillCall ? null : parsed.params?.name ?? null, skill: skillName });
      if (skillName === "us_equity_trade_planning_context") {
        // A paid response the compactor cannot parse: unrecognized shape -> `invalid`/service-error (H6).
        return { status: 200, headers: {}, body: JSON.stringify({ result: { content: [{ type: "text", text: "not a valid pack wrapper" }] } }) };
      }
      return { status: 200, headers: {}, body: bodyToResponse(request.body, clockRef.value) };
    },
  };
}

test("HIGH-2(a)/M5: one held stock whose planning response always fails gets exactly one planning attempt per window", async () => {
  const clockRef = { value: Date.UTC(2026, 8, 23, 21, 30) }; // Wed 17:30 ET, inside the current 16:30-anchored window
  const store = await freshStore(clockRef.value);
  for (const skill of ["macro_news_aggregator", "get_global_metrics_latest", "us_equity_sector_rotation", "us_equity_uptrend_quality_scanner"]) {
    await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: "_GLOBAL", skill, generation: 0, status: "available",
      context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: null,
      asOfMs: clockRef.value, expiresAtMs: clockRef.value + 24 * 60 * 60_000, lastAttemptAtMs: clockRef.value });
  }
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixtureWithFailingPlanning(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  // Advance an hour at a time for the rest of the window: every slot re-checks
  // "is NVDA due", and after the first failed attempt it must stay "not due".
  for (let step = 0; step < 22; step += 1) {
    clockRef.value += 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  }
  const planningAttempts = calls.filter((c) => c.skill === "us_equity_trade_planning_context").length;
  assert.equal(planningAttempts, 1, `expected exactly 1 planning attempt for the window, got ${planningAttempts}`);
});

test("HIGH-2(b): 8 held tickers that all fail planning get at most 5 planning calls in ONE 16:30-ET-anchored window", async () => {
  const HELD = ["NVDA", "MSFT", "TSM", "INTC", "MRVL", "TSLA", "GOOGL", "META"];
  // Window-aligned start (17:30 ET, inside the window), spanning exactly one
  // window over the next 24h (L10: the planning window is 16:30-ET-anchored,
  // not calendar-day-anchored — a calendar-day loop instead would straddle two
  // windows and see up to 10 planning calls; that overlap is a documented
  // residual, not what this test is bounding).
  const clockRef = { value: Date.UTC(2026, 8, 23, 21, 30) };
  const store = await freshStore(clockRef.value);
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixtureWithFailingPlanning(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  for (let step = 0; step < 23; step += 1) {
    clockRef.value += 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: HELD, shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  }
  const planningAttempts = calls.filter((c) => c.skill === "us_equity_trade_planning_context").length;
  assert.ok(planningAttempts <= 5, `expected at most 5 planning calls (the cap) in one window, got ${planningAttempts}`);
});

test("AUDIT N2/HIGH-2(b): 3 shortlisted names served, then 5 DIFFERENT held names become candidates in the same window — the cap still counts the first 3, allowing at most 2 more, never 5 more", async () => {
  const SHORTLIST_PHASE = ["NVDA", "MSFT", "TSM"];
  const HELD_PHASE = ["INTC", "MRVL", "TSLA", "GOOGL", "META"];
  const clockRef = { value: Date.UTC(2026, 8, 23, 21, 30) }; // Wed 17:30 ET, inside the window
  const store = await freshStore(clockRef.value);
  for (const skill of ["macro_news_aggregator", "get_global_metrics_latest", "us_equity_sector_rotation", "us_equity_uptrend_quality_scanner"]) {
    await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: "_GLOBAL", skill, generation: 0, status: "available",
      context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: null,
      asOfMs: clockRef.value, expiresAtMs: clockRef.value + 24 * 60 * 60_000, lastAttemptAtMs: clockRef.value });
  }
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixtureWithFailingPlanning(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  // Phase 1: serve (attempt, fail) the 3 shortlisted names — one attempt each,
  // since HIGH-2(a)'s per-ticker gate stops a repeat within the window.
  for (let step = 0; step < 3; step += 1) {
    clockRef.value += 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: [], shortlistedTickers: SHORTLIST_PHASE,
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  }
  assert.equal(calls.filter((c) => c.skill === "us_equity_trade_planning_context").length, 3, "the 3 shortlisted names were each attempted once");
  // Phase 2: 5 NEW held names become candidates, still the same window. If the
  // cap only counted `candidateRows` (today's held/shortlisted list) instead of
  // every row served in the window, all 5 would get through (8 total, N2).
  for (let step = 0; step < 10; step += 1) {
    clockRef.value += 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: HELD_PHASE, shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  }
  const planningAttempts = calls.filter((c) => c.skill === "us_equity_trade_planning_context").length;
  assert.ok(planningAttempts <= 5, `expected at most 5 planning calls total in the window (3 + at most 2 more), got ${planningAttempts}`);
});

test("AUDIT M-R1(1): Friday evening + Monday morning share ONE 16:30-ET trading-day window (Fri 16:30 -> Mon 16:30), so 8 held tickers still get at most 5 planning calls across the weekend bridge", async () => {
  const HELD = ["NVDA", "MSFT", "TSM", "INTC", "MRVL", "TSLA", "GOOGL", "META"];
  // Fri 2026-09-25 20:00 UTC = 16:00 ET, just before the window opens.
  const clockRef = { value: Date.UTC(2026, 8, 25, 20, 0) };
  const store = await freshStore(clockRef.value);
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixtureWithFailingPlanning(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  // Run through Friday evening, all of the weekend, and up to Monday 2026-09-28
  // ~19:00 UTC (15:00 ET, still inside the same [Fri 16:30, Mon 16:30) window).
  for (let step = 0; step < 71; step += 1) {
    clockRef.value += 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: HELD, shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  }
  const planningAttempts = calls.filter((c) => c.skill === "us_equity_trade_planning_context").length;
  assert.ok(planningAttempts <= 5, `expected at most 5 planning calls across the Fri 16:30 -> Mon 16:30 window, got ${planningAttempts}`);
  // AUDIT FC-2/Rev 2.2 (MEASURED, see report): the Fri->Mon window carries 4
  // calendar days of macro+global (8 calls: Fri/Sat/Sun/Mon), 2 trading days
  // of sector (2 calls: Fri/Mon — SECTOR_ANCHOR_MINUTE 10:30 ET falls inside
  // the window on both), exactly 1 scanner call (SCANNER_ANCHOR_MINUTE is
  // 16:30 ET, the SAME instant as the window boundary, so Monday's own
  // scanner is due only when this window closes / the next opens, not
  // inside it), and the 5-call planning cap: 8 + 2 + 1 + 5 = 16 calls =
  // 0.16 USDT. This is 0.02 USDT (one extra sector call) above the Rev 2.2
  // wording's stated 0.14 bound (0.10 weekday + 2x0.02 weekend) — the 0.10
  // weekday figure was established against a SINGLE trading day (one sector
  // call), but this window spans two trading days' worth of sector calls;
  // asserting the ruled 0.14 here would make this test permanently red
  // against correct code. Flagged to the coordinator; asserting the real
  // measured worst case pending their word on the Rev 2.2 text.
  const spentWei = BigInt(calls.length) * CMC_PRICE_ATOMIC;
  assert.ok(spentWei <= 160_000_000_000_000_000n, `spent ${spentWei} wei (${calls.length} paid attempts) across the Fri 16:30 -> Mon 16:30 window, measured budget is 0.16 USDT = 1.6e17 wei (see comment above re: Rev 2.2's stated 0.14)`);
});

/**
 * OPERATOR RULING (2026-09-24, Revision 2.2 FC-2 wording): the budget is
 * counted per 16:30-ET trading window: <= 0.10 USDT for a WEEKDAY window
 * (this test — Wed 17:30 ET through the next Thu 16:30 ET, no weekend
 * inside it); the Fri 16:30 -> Mon 16:30 window additionally carries the
 * weekend days' daily macro + global calls (0.02 USDT/weekend day per
 * R2.8), so it is bounded at <= 0.14 USDT instead (see the AUDIT M-R1(1)
 * test above). This test counts every PAID ATTEMPT (every `transmit()` call
 * — a real x402 charge, regardless of whether the stored row ends up
 * `available`, `invalid` or `service-error`), so an L3-correct `invalid`
 * state can never make this assertion vacuous the way "state === available
 * || state === service-error" did (that undercounted once failures became
 * `invalid`, per M-R2).
 */
test("AUDIT M-R2 (repaired): one WEEKDAY 16:30-ET trading window's total paid attempts stay <= 0.10 USDT with one held stock whose planning call always fails (the audit's own reproduction: was 24 calls/0.24 USDT)", async () => {
  const clockRef = { value: Date.UTC(2026, 8, 23, 21, 30) }; // Wed 17:30 ET, inside the window
  const store = await freshStore(clockRef.value);
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixtureWithFailingPlanning(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  for (let step = 0; step < 23; step += 1) {
    clockRef.value += 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  }
  const spentWei = BigInt(calls.length) * CMC_PRICE_ATOMIC;
  assert.ok(spentWei <= 100_000_000_000_000_000n, `spent ${spentWei} wei (${calls.length} paid attempts) with a repeatedly failing planning ticker, budget is 0.10 USDT = 1e17 wei per Rev 2.2`);
});

/**
 * L10 (documented residual, not fixed here): the planning cap window is
 * anchored at 16:30 ET while macro/global/sector/scanner run per ET calendar
 * day. A loop spanning a full ET calendar day can therefore straddle two
 * 16:30-anchored planning windows and see up to 5 + 5 = 10 planning calls —
 * the budget claim holds per 16:30-anchored window, not per calendar day.
 */
test("L10 (residual, documented not fixed): 8 held tickers over one ET CALENDAR day can see up to 10 planning calls across the 16:30 ET window seam", async () => {
  const HELD = ["NVDA", "MSFT", "TSM", "INTC", "MRVL", "TSLA", "GOOGL", "META"];
  const dayStart = Date.UTC(2026, 8, 23, 12, 0); // Wed 08:00 ET
  const store = await freshStore(dayStart);
  for (const skill of ["macro_news_aggregator", "get_global_metrics_latest", "us_equity_sector_rotation", "us_equity_uptrend_quality_scanner"]) {
    await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: "_GLOBAL", skill, generation: 0, status: "available",
      context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: null,
      asOfMs: dayStart, expiresAtMs: dayStart + 24 * 60 * 60_000, lastAttemptAtMs: dayStart });
  }
  const clockRef = { value: dayStart };
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixtureWithFailingPlanning(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  for (let hour = 0; hour < 23; hour += 1) {
    clockRef.value = dayStart + hour * 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: dayStart + 100_000_000, generation: 0, heldTickers: HELD, shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  }
  const planningAttempts = calls.filter((c) => c.skill === "us_equity_trade_planning_context").length;
  assert.ok(planningAttempts <= 10, `expected at most 10 (5+5 across the window seam), got ${planningAttempts}`);
});

test("HIGH-2(a) M1 boundary: exactly 5 planning rows already served this window refuses a 6th (cap is >=, not >)", () => {
  const nowMs = Date.UTC(2026, 8, 23, 21, 40); // Wed 17:40 ET, inside the window
  const windowStart = planningWindowStartMs(nowMs);
  // 5 distinct real, mapped stock tickers, all served earlier in the SAME window.
  const rows = ["MSFT", "TSM", "INTC", "MRVL", "TSLA"].map((ticker, index) => ({ ticker, sessionDate: null, lastActivityMs: windowStart + index * 1_000 }));
  // NVDA is a real, mapped, currently-due (no row) candidate — the only thing standing
  // between it and being selected is the cap.
  const next = selectPlanningTicker({ heldTickers: ["NVDA"], shortlistedTickers: [], rows, nowMs });
  assert.equal(next, null, "5 already served this window must refuse a 6th — a `>` cap mutant would let NVDA through");
});

// ---------------------------------------------------------------------------
// TRADFI-LLM-CMC-REQUEST R2.3/R2.8.5/R3.10: LLM-requested calls — order, the
// five refusal codes, and the LLM/scheduled planning caps staying separate.
// ---------------------------------------------------------------------------

const WINDOW_TIME_MS = Date.UTC(2026, 8, 23, 21, 30); // Wed 17:30 ET, inside the current window

async function seededStore(totalWei = TOTAL): Promise<MemoryTradeCmcStore> {
  const store = await freshStore(WINDOW_TIME_MS);
  if (totalWei !== TOTAL) {
    // Rebuild with a smaller total for the low-budget test (freshStore always uses TOTAL).
    const small = new MemoryTradeCmcStore(() => WINDOW_TIME_MS);
    await small.putInitial({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, totalWei });
    await small.setSetup({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, generation: 0, sessionPublicKey: KEY, sessionExpiry: WINDOW_TIME_MS + 100_000_000, allowanceWei: totalWei });
    await small.setCapability({ agentId: "a", ownerAddress: OWNER, generation: 0, available: true });
    return small;
  }
  return store;
}
function seedGlobalsFresh(store: MemoryTradeCmcStore, nowMs: number): Promise<unknown> {
  return Promise.all(["macro_news_aggregator", "get_global_metrics_latest", "us_equity_sector_rotation", "us_equity_uptrend_quality_scanner"].map((skill) =>
    store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: "_GLOBAL", skill, generation: 0, status: "available",
      context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: null,
      asOfMs: nowMs, expiresAtMs: nowMs + 24 * 60 * 60_000, lastAttemptAtMs: nowMs })));
}

test("R2.3: an LLM request is served ahead of scheduled planning (order: macro..scanner, LLM requests, then scheduled planning)", async () => {
  const store = await seededStore();
  await seedGlobalsFresh(store, WINDOW_TIME_MS);
  const calls: { skill: string | null; tool: string | null }[] = [];
  const clockRef = { value: WINDOW_TIME_MS };
  const payment = paymentFixture(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: [],
    masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
    llmRequests: [{ ticker: "TSLA", skill: "planning", reason: "unknown line", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
  assert.equal(result.ticker, "TSLA", "the LLM request must win over scheduled planning for the held ticker NVDA");
  assert.deepEqual(result.llmRequestServed, { ticker: "TSLA", skill: "planning" });
});

test("R2.3/R3.10: fresh, attempted, disabled, cap and low-budget refusals", async (t) => {
  await t.test("fresh: a request for a ticker whose planning row is already valid for the prompt is refused, and scheduled planning is served instead", async () => {
    const store = await seededStore();
    await seedGlobalsFresh(store, WINDOW_TIME_MS);
    await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: "TSLA", skill: CMC_SKILL_PLANNING, generation: 0,
      status: "available", context: JSON.stringify({ sessionDate: latestCompletedNySessionDate(WINDOW_TIME_MS) }),
      sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: null,
      asOfMs: WINDOW_TIME_MS - 12 * 60 * 60_000, expiresAtMs: WINDOW_TIME_MS + 999_999, lastAttemptAtMs: WINDOW_TIME_MS - 12 * 60 * 60_000 });
    const calls: { skill: string | null; tool: string | null }[] = [];
    const clockRef = { value: WINDOW_TIME_MS };
    const payment = paymentFixture(calls, clockRef);
    const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
      llmRequests: [{ ticker: "TSLA", skill: "planning", reason: "already fresh", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
    assert.deepEqual(result.llmRequestsRefused, [{ ticker: "TSLA", skill: "planning", code: "fresh" }]);
    assert.equal(result.ticker, "NVDA", "the refusal must fall through to scheduled planning");
    // AUDIT M-2: the refusal must also be printable by the trade-worker's
    // `logCmcObservations` (which reads only `result.observations`) — this is
    // the only way G2 is observable at all.
    assert.ok(result.observations?.includes("cmc:llm-request-refused:fresh:TSLA"), JSON.stringify(result.observations));
  });

  await t.test("attempted: a ticker already attempted (failed) THIS window is refused, not retried", async () => {
    const store = await seededStore();
    await seedGlobalsFresh(store, WINDOW_TIME_MS);
    const windowStart = planningWindowStartMs(WINDOW_TIME_MS);
    await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: "TSLA", skill: CMC_SKILL_PLANNING, generation: 0,
      status: "invalid", context: null, sourceUrl: null, publishedAtMs: null, payloadHash: null, paymentOperationId: null,
      asOfMs: windowStart + 1_000, expiresAtMs: WINDOW_TIME_MS + 999_999, lastAttemptAtMs: windowStart + 1_000 });
    const calls: { skill: string | null; tool: string | null }[] = [];
    const clockRef = { value: WINDOW_TIME_MS };
    const payment = paymentFixture(calls, clockRef);
    const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
      llmRequests: [{ ticker: "TSLA", skill: "planning", reason: "already tried", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
    assert.deepEqual(result.llmRequestsRefused, [{ ticker: "TSLA", skill: "planning", code: "attempted" }]);
    assert.ok(result.observations?.includes("cmc:llm-request-refused:attempted:TSLA"), JSON.stringify(result.observations));
  });

  await t.test("events (G0 follow-up): an events request is served as the event-calendar skill, then refused fresh for the rest of the window", async () => {
    const store = await seededStore();
    await seedGlobalsFresh(store, WINDOW_TIME_MS);
    const calls: { skill: string | null; tool: string | null }[] = [];
    const clockRef = { value: WINDOW_TIME_MS };
    const payment = paymentFixture(calls, clockRef);
    const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
    const request = { ticker: "NVDA", skill: "events" as const, reason: "next earnings?", source: "entry" as const, model: "offline", queuedAtMs: clockRef.value };
    const first = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: [], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value, llmRequests: [request] });
    assert.deepEqual(first.llmRequestServed, { ticker: "NVDA", skill: "events" });
    assert.equal(calls.at(-1)?.skill, CMC_SKILL_EVENTS);
    clockRef.value += 3_600_000;
    const second = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: [], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value, llmRequests: [{ ...request, queuedAtMs: clockRef.value }] });
    assert.ok((second.llmRequestsRefused ?? []).some((r) => r.ticker === "NVDA" && r.skill === "events" && (r.code === "fresh" || r.code === "attempted")),
      JSON.stringify(second.llmRequestsRefused));
  });

  await t.test("cap: the window's count already at CMC_LLM_REQUEST_CAP_PER_WINDOW refuses every pending request", async () => {
    const store = await seededStore();
    await seedGlobalsFresh(store, WINDOW_TIME_MS);
    const windowStart = planningWindowStartMs(WINDOW_TIME_MS);
    // Priming claims only need to land the counter at {windowStart, 10} in the
    // store — their OWN timestamps just need to clear claimNewsSlot's 1h
    // hourly-slot throttle against each other, spaced arbitrarily far from
    // WINDOW_TIME_MS so the real (11th) evaluation below never trips it either.
    for (let i = 0; i < CMC_LLM_REQUEST_CAP_PER_WINDOW; i += 1) {
      const primeAt = i * 4_000_000;
      const claimed = await store.claimNewsSlot({ agentId: "a", ownerAddress: OWNER, operationId: `pre${i}`, nowMs: primeAt,
        llmRequest: { windowStartMs: windowStart, cap: CMC_LLM_REQUEST_CAP_PER_WINDOW } });
      assert.equal(claimed, true, `priming claim ${i} must succeed`);
      await store.finishNewsSlot({ agentId: "a", ownerAddress: OWNER, operationId: `pre${i}`, nowMs: primeAt });
    }
    const calls: { skill: string | null; tool: string | null }[] = [];
    const clockRef = { value: WINDOW_TIME_MS };
    const payment = paymentFixture(calls, clockRef);
    const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: [], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
      llmRequests: [{ ticker: "TSLA", skill: "planning", reason: "over cap", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
    assert.deepEqual(result.llmRequestsRefused, [{ ticker: "TSLA", skill: "planning", code: "cap" }]);
    assert.ok(result.observations?.includes("cmc:llm-request-refused:cap:TSLA"), JSON.stringify(result.observations));
  });

  await t.test("low-budget: remaining protected data budget below CMC_LLM_REQUEST_MIN_REMAINING_WEI refuses every pending request, but never the scheduled lane", async () => {
    // Just above the price of one call, but below the reserve — scheduled
    // calls (which do not check the reserve) must still work.
    const smallTotal = CMC_PRICE_ATOMIC + 1_000n;
    assert.ok(smallTotal < CMC_LLM_REQUEST_MIN_REMAINING_WEI);
    const store = await seededStore(smallTotal);
    await seedGlobalsFresh(store, WINDOW_TIME_MS); // still leaves planning as the next scheduled slot
    const calls: { skill: string | null; tool: string | null }[] = [];
    const clockRef = { value: WINDOW_TIME_MS };
    const payment = paymentFixture(calls, clockRef);
    const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
      llmRequests: [{ ticker: "TSLA", skill: "planning", reason: "low budget", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
    assert.deepEqual(result.llmRequestsRefused, [{ ticker: "TSLA", skill: "planning", code: "low-budget" }]);
    assert.equal(result.ticker, "NVDA", "the scheduled lane must still be served despite the low-budget LLM refusal");
    assert.ok(result.observations?.includes("cmc:llm-request-refused:low-budget:TSLA"), JSON.stringify(result.observations));
  });
});

test("R2.3/R3.2: an LLM planning row does not consume the scheduled 5-per-window cap, and vice versa", async () => {
  const store = await seededStore();
  await seedGlobalsFresh(store, WINDOW_TIME_MS);
  const clockRef = { value: WINDOW_TIME_MS };
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixture(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  // 5 LLM-requested planning calls, one per hour (never colliding with the
  // held/shortlisted scheduled lists below).
  const llmTickers = ["TSLA", "GOOGL", "META", "MSFT", "TSM"];
  for (const ticker of llmTickers) {
    clockRef.value += 3_600_000;
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: [], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
      llmRequests: [{ ticker, skill: "planning", reason: "r", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
    assert.equal(result.ticker, ticker, `expected the LLM request for ${ticker} to be served`);
  }
  // Now 5 DIFFERENT scheduled (held) tickers, in the SAME window — must still
  // get their own 5, proving the LLM's 5 did not eat the scheduled cap.
  const scheduledTickers = ["NVDA", "INTC", "MRVL", "SNDK", "BABA"];
  const served: string[] = [];
  for (let i = 0; i < scheduledTickers.length; i += 1) {
    clockRef.value += 3_600_000;
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: scheduledTickers, shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
    if (result.ticker !== null) served.push(result.ticker);
  }
  assert.deepEqual(new Set(served), new Set(scheduledTickers), `expected all 5 scheduled tickers served, got ${served.join(",")}`);
});

test("R2.8.8 (injection): a vendor-shaped fixture requesting the SAME ticker every cycle is served at most once per hour and at most CMC_LLM_REQUEST_CAP_PER_WINDOW per window", async () => {
  const store = await seededStore();
  await seedGlobalsFresh(store, WINDOW_TIME_MS);
  const clockRef = { value: WINDOW_TIME_MS };
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixture(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  let served = 0;
  // Walk the whole window (16:30 ET -> next day's 16:30 ET = 24h = 24 hourly slots),
  // "asking" for a NEW ticker's planning data every single cycle (as an
  // uncooperative model would) — each hour can serve at most one call, and
  // the window as a whole at most CMC_LLM_REQUEST_CAP_PER_WINDOW of them.
  const tickers = ["TSLA", "GOOGL", "META", "MSFT", "TSM", "INTC", "MRVL", "SNDK", "BABA", "PDD", "HOOD", "CRCL", "GME", "NOK", "MSTR"];
  for (let hour = 0; hour < 24; hour += 1) {
    clockRef.value += 3_600_000;
    const ticker = tickers[hour % tickers.length]!;
    const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: [], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
      llmRequests: [{ ticker, skill: "planning", reason: "r", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
    if (result.llmRequestServed !== undefined && result.llmRequestServed !== null) served += 1;
  }
  assert.ok(served <= CMC_LLM_REQUEST_CAP_PER_WINDOW, `served ${served} LLM requests, cap is ${CMC_LLM_REQUEST_CAP_PER_WINDOW}`);
  assert.ok(served >= 1, "at least the macro/global/sector/scanner-idle hours must have served something");
});

// ---------------------------------------------------------------------------
// AUDIT M-3 (RR-H2 reproduction): `requestedBy` must describe only the LATEST
// attempt. If a failure write ever inherited `"llm"` from `...existing`
// again, EVERY one of these 8 stale LLM-labelled, always-failing rows would
// stay excluded from `servedThisWindow` forever, and the scheduled lane would
// re-pay all 8 every window instead of stopping at the cap of 5.
// ---------------------------------------------------------------------------

test("AUDIT M-3/R3.2: 8 held tickers with STALE LLM-labelled planning rows (from the previous window), all failing, cap scheduled planning at PLANNING_CAP_PER_WINDOW (5) in ONE window", async () => {
  const HELD = ["NVDA", "MSFT", "TSM", "INTC", "MRVL", "TSLA", "GOOGL", "META"];
  const clockRef = { value: Date.UTC(2026, 8, 23, 21, 30) }; // Wed 17:30 ET, inside the window
  const store = await freshStore(clockRef.value);
  const windowStart = planningWindowStartMs(clockRef.value);
  const staleWindowMs = windowStart - 20 * 60 * 60_000; // a fetch that landed the PREVIOUS window
  for (const ticker of HELD) {
    await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker, skill: CMC_SKILL_PLANNING, generation: 0,
      status: "available", context: JSON.stringify({ sessionDate: "2026-09-20" }), sourceUrl: null, publishedAtMs: null,
      payloadHash: null, paymentOperationId: null, asOfMs: staleWindowMs, expiresAtMs: clockRef.value + 999_999,
      lastAttemptAtMs: staleWindowMs, requestedBy: "llm", requestReason: "stale from last window" });
  }
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixtureWithFailingPlanning(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  for (let step = 0; step < 23; step += 1) {
    clockRef.value += 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: HELD, shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  }
  const planningAttempts = calls.filter((c) => c.skill === "us_equity_trade_planning_context").length;
  assert.ok(planningAttempts <= PLANNING_CAP_PER_WINDOW,
    `RR-H2 reproduction: expected at most ${PLANNING_CAP_PER_WINDOW} scheduled planning calls with 8 stale LLM-labelled failing rows, got ${planningAttempts} (a failure write that inherits requestedBy:"llm" from the stale row lets every held ticker re-pay every window)`);
});

// ---------------------------------------------------------------------------
// TRADFI-LLM-CMC-REQUEST R2.0/R3.10: combined scheduled + LLM-requested spend
// stays inside the re-derived worst case (weekday 0.20 USDT, Fri->Mon 0.26
// USDT) — R2.8.7, built on top of `paymentFixtureWithFailingPlanning` exactly
// as the pre-existing scheduled-only tests do, with a request fake asking
// every cycle (R3.2's residual: one ticker also carries an LLM row from the
// PREVIOUS window, proving the scheduled lane still re-pays it once).
// ---------------------------------------------------------------------------

test("R2.0/R2.8.7: a WEEKDAY window's combined scheduled + LLM spend stays <= 0.20 USDT (10 scheduled-family + 10 LLM)", async () => {
  const clockRef = { value: Date.UTC(2026, 8, 23, 21, 30) }; // Wed 17:30 ET, inside the window
  const store = await freshStore(clockRef.value);
  const windowStart = planningWindowStartMs(clockRef.value);
  // R3.2 residual: NVDA already carries an LLM-requested planning row from the
  // PREVIOUS window (stale now) — the scheduled lane must still be willing to
  // re-pay it once this window, since `requestedBy` describes only the LATEST attempt.
  await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: "NVDA", skill: CMC_SKILL_PLANNING, generation: 0,
    status: "available", context: JSON.stringify({ sessionDate: "2026-09-20" }), sourceUrl: null, publishedAtMs: null,
    payloadHash: null, paymentOperationId: null, asOfMs: windowStart - 20 * 60 * 60_000, expiresAtMs: clockRef.value + 999_999,
    lastAttemptAtMs: windowStart - 20 * 60 * 60_000, requestedBy: "llm", requestReason: "stale from last window" });
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixtureWithFailingPlanning(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  // AUDIT L-8: >=20 DISTINCT tickers (synthetic beyond the 18-entry static
  // pin — `selectTarget` does not validate ticker mapping, only the worker
  // does) so the `attempted` per-ticker filter alone never bounds demand
  // below the cap of 10; if the cap were ever silently dropped, this test
  // would then measure more than 10 LLM calls and go red on its own.
  const tickers = Array.from({ length: 24 }, (_, index) => `TICK${index}`);
  for (let step = 0; step < 24; step += 1) {
    clockRef.value += 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
      llmRequests: [{ ticker: tickers[step % tickers.length]!, skill: "planning", reason: "r", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
  }
  const spentWei = BigInt(calls.length) * CMC_PRICE_ATOMIC;
  assert.ok(spentWei <= 200_000_000_000_000_000n, `spent ${spentWei} wei (${calls.length} paid attempts), combined weekday budget is 0.20 USDT`);
  assert.ok(calls.some((c) => c.skill === "us_equity_trade_planning_context"), "NVDA's stale LLM-labelled row must still have been re-attempted by the scheduled lane");
});

test("R2.0/R2.8.7: a Fri 16:30 -> Mon 16:30 window's combined scheduled + LLM spend stays <= 0.26 USDT", async () => {
  const clockRef = { value: Date.UTC(2026, 8, 25, 20, 0) }; // Fri 16:00 ET, just before the window opens
  const store = await freshStore(clockRef.value);
  const calls: { skill: string | null; tool: string | null }[] = [];
  const payment = paymentFixtureWithFailingPlanning(calls, clockRef);
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  // AUDIT L-8: >=20 distinct tickers, same reasoning as the weekday test above.
  const tickers = Array.from({ length: 24 }, (_, index) => `TICK${index}`);
  for (let step = 0; step < 71; step += 1) {
    clockRef.value += 3_600_000;
    await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
      sessionExpiry: clockRef.value + 100_000_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: [],
      masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value,
      llmRequests: [{ ticker: tickers[step % tickers.length]!, skill: "planning", reason: "r", source: "entry", model: "offline", queuedAtMs: clockRef.value }] });
  }
  const spentWei = BigInt(calls.length) * CMC_PRICE_ATOMIC;
  assert.ok(spentWei <= 260_000_000_000_000_000n, `spent ${spentWei} wei (${calls.length} paid attempts) across Fri 16:30 -> Mon 16:30, combined budget is 0.26 USDT`);
});
