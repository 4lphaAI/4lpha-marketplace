import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, type Hex } from "viem";
import {
  CMC_CONFIG_ID, CMC_GLOBAL_TOOL, CMC_PAYEE, CMC_PRICE_ATOMIC, CMC_SIGNER, CMC_SPENDER, expectedCmcResource,
} from "../src/trade/cmc.js";
import { CMC_SKILL_MACRO, CMC_SKILL_MACRO_RELEASE, CMC_SKILL_PLANNING, CMC_SKILL_SCANNER, CMC_SKILL_SECTOR, macroEventRiskUsEquity, readCompactMacro } from "../src/trade/cmcUsEquity.js";
import { createCmcNewsService, GLOBAL_TICKER } from "../src/trade/cmcNews.js";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { USDT_56 } from "../src/trade/settlement.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const KEY = `0x04${"22".repeat(64)}` as Hex;
// Wed 2026-09-23 21:00 UTC = 17:00 ET (EDT): after every daily/trading-day anchor (macro 08:00, sector 10:30, scanner 16:30 ET).
const NOW_MS = Date.UTC(2026, 8, 23, 21, 0);
const TOTAL = 1_000_000_000_000_000_000n;

/** Seeds macro/global/sector/scanner as already fresh, so `selectTarget` falls through straight to planning selection. */
async function readyStore(): Promise<MemoryTradeCmcStore> {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, generation: 0,
    sessionPublicKey: KEY, sessionExpiry: NOW_MS + 100_000, allowanceWei: TOTAL });
  await store.setCapability({ agentId: "a", ownerAddress: OWNER, generation: 0, available: true });
  for (const skill of [CMC_SKILL_MACRO, CMC_GLOBAL_TOOL, CMC_SKILL_SECTOR, CMC_SKILL_SCANNER]) {
    await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: GLOBAL_TICKER, skill, generation: 0,
      status: "available", context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null,
      paymentOperationId: null, asOfMs: NOW_MS, expiresAtMs: NOW_MS + 24 * 60 * 60_000, lastAttemptAtMs: NOW_MS });
  }
  return store;
}

function paymentFixture(seenBodies: string[], seenResources: string[], responseBody: string) {
  let lastResource = "";
  return {
    async authorize() { return { ok: true as const }; },
    async fetchChallenge(request: { readonly body: string; readonly expectedResource?: string }) {
      seenBodies.push(request.body);
      lastResource = request.expectedResource ?? "";
      seenResources.push(lastResource);
      return { amountWei: CMC_PRICE_ATOMIC, payTo: CMC_PAYEE, asset: USDT_56, network: "eip155:56" as const,
        spender: CMC_SPENDER, resource: lastResource, configId: CMC_CONFIG_ID, signerAddress: CMC_SIGNER, maxTimeoutSeconds: 500 };
    },
    async reserve(input: { readonly operationId: string; readonly amountWei: bigint }) {
      return { attempt: { generation: 0, operationId: input.operationId, state: "reserved" } } as never;
    },
    async prepare() { return { operationId: "op", state: "prepared" } as never; },
    async transmit() { return { status: 200, headers: {}, body: responseBody }; },
  };
}

test("expectedCmcResource: X402_execute_skill for a skill target, X402_<name> for a tool target", () => {
  assert.equal(expectedCmcResource({ kind: "skill", ticker: "MSFT", uniqueName: CMC_SKILL_PLANNING }), "X402_execute_skill");
  assert.equal(expectedCmcResource({ kind: "tool", name: CMC_GLOBAL_TOOL }), "X402_get_global_metrics_latest");
});

test("a tool target's body is a bare tools/call with no skill wrapper", async () => {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, generation: 0, sessionPublicKey: KEY, sessionExpiry: NOW_MS + 100_000, allowanceWei: TOTAL });
  await store.setCapability({ agentId: "a", ownerAddress: OWNER, generation: 0, available: true });
  // Only macro is already fresh, so the global tool (next in the N8 priority) is due.
  await store.putNews({ agentId: "a", ownerAddress: OWNER, ticker: GLOBAL_TICKER, skill: CMC_SKILL_MACRO, generation: 0,
    status: "available", context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null,
    paymentOperationId: null, asOfMs: NOW_MS, expiresAtMs: NOW_MS + 24 * 60 * 60_000, lastAttemptAtMs: NOW_MS });
  const seenBodies: string[] = [];
  const seenResources: string[] = [];
  const payment = paymentFixture(seenBodies, seenResources, JSON.stringify({ result: { content: [{ type: "text", text: "global metrics text" }] } }));
  const service = createCmcNewsService({ store, payment: payment as never, now: () => NOW_MS });
  const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: NOW_MS + 100_000, generation: 0, heldTickers: [], shortlistedTickers: ["MSFT"], masterKey: Buffer.alloc(32, 7) });
  assert.equal(result.ticker, GLOBAL_TICKER);
  assert.equal(result.state, "available");
  const body = JSON.parse(seenBodies[0]!) as { readonly method: string; readonly params: { readonly name: string; readonly arguments: unknown } };
  assert.equal(body.method, "tools/call");
  assert.equal(body.params.name, CMC_GLOBAL_TOOL);
  assert.deepEqual(body.params.arguments, {});
  assert.equal(seenResources[0], `X402_${CMC_GLOBAL_TOOL}`);
});

test("a resource mismatch never pays (challenge_mismatch, no row write)", async () => {
  const store = await readyStore();
  const seenBodies: string[] = [];
  const seenResources: string[] = [];
  const payment = {
    async authorize() { return { ok: true as const }; },
    async fetchChallenge(request: { readonly body: string; readonly expectedResource?: string }) {
      seenBodies.push(request.body); seenResources.push(request.expectedResource ?? "");
      // Wrong resource on purpose: the challenge's resource never matches what was requested.
      return { amountWei: CMC_PRICE_ATOMIC, payTo: CMC_PAYEE, asset: USDT_56, network: "eip155:56" as const,
        spender: CMC_SPENDER, resource: "X402_something_else", configId: CMC_CONFIG_ID, signerAddress: CMC_SIGNER, maxTimeoutSeconds: 500 };
    },
    async reserve() { throw new Error("must not reserve on a challenge mismatch"); },
    async prepare() { throw new Error("must not prepare on a challenge mismatch"); },
    async transmit() { throw new Error("must not transmit on a challenge mismatch"); },
  };
  const service = createCmcNewsService({ store, payment: payment as never, now: () => NOW_MS });
  const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: NOW_MS + 100_000, generation: 0, heldTickers: ["MSFT"], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7) });
  assert.equal(result.state, "service-error");
  assert.equal(result.reason, "challenge_mismatch");
});

test("N8: with everything else fresh, held planning wins over shortlisted", async () => {
  const store = await readyStore();
  const payment = paymentFixture([], [], JSON.stringify({ result: { content: [{ type: "text", text: "unused" }] } }));
  const service = createCmcNewsService({ store, payment: payment as never, now: () => NOW_MS });
  const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: NOW_MS + 100_000, generation: 0, heldTickers: ["NVDA"], shortlistedTickers: ["MSFT"], masterKey: Buffer.alloc(32, 7) });
  assert.equal(result.ticker, "NVDA");
});

test("ETF tickers (SPY, QQQ) never get a planning call", async () => {
  const store = await readyStore();
  const payment = paymentFixture([], [], JSON.stringify({ result: { content: [{ type: "text", text: "unused" }] } }));
  const service = createCmcNewsService({ store, payment: payment as never, now: () => NOW_MS });
  const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: NOW_MS + 100_000, generation: 0, heldTickers: [], shortlistedTickers: ["SPY", "QQQ"], masterKey: Buffer.alloc(32, 7) });
  assert.equal(result.ticker, null);
  assert.equal(result.reason, "context_fresh");
});

test("M5: a failed macro attempt records lastAttemptAtMs and is not retried within the same ET day, and getFresh returns null for it", async () => {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, generation: 0, sessionPublicKey: KEY, sessionExpiry: NOW_MS + 100_000, allowanceWei: TOTAL });
  await store.setCapability({ agentId: "a", ownerAddress: OWNER, generation: 0, available: true });
  let attempts = 0;
  const failingPayment = {
    async authorize() { return { ok: true as const }; },
    async fetchChallenge(): Promise<never> { attempts += 1; throw new Error("network down"); },
    async reserve(): Promise<never> { throw new Error("must not reserve"); },
    async prepare(): Promise<never> { throw new Error("must not prepare"); },
    async transmit(): Promise<never> { throw new Error("must not transmit"); },
  };
  const service = createCmcNewsService({ store, payment: failingPayment as never, now: () => NOW_MS });

  const first = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: NOW_MS + 100_000, generation: 0, heldTickers: [], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7), nowMs: NOW_MS });
  assert.equal(first.ticker, GLOBAL_TICKER);
  assert.equal(first.state, "service-error");
  assert.equal(attempts, 1);

  const stored = await store.getNews("a", OWNER, GLOBAL_TICKER, CMC_SKILL_MACRO);
  assert.ok(stored);
  assert.equal(stored!.status, "service-error");
  assert.equal(stored!.lastAttemptAtMs, NOW_MS);

  assert.equal(await service.getFresh({ agentId: "a", ownerAddress: OWNER, ticker: GLOBAL_TICKER, skill: CMC_SKILL_MACRO, nowMs: NOW_MS }), null);

  // One slot-cooldown later, still the same ET day: macro is not due again (M5), so the next tool (global metrics) is attempted instead.
  const t1 = NOW_MS + 3_600_000;
  const second = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: NOW_MS + 100_000, generation: 0, heldTickers: [], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7), nowMs: t1 });
  assert.equal(second.ticker, GLOBAL_TICKER);
  assert.equal(attempts, 2);
  const secondStored = await store.getNews("a", OWNER, GLOBAL_TICKER, CMC_GLOBAL_TOOL);
  assert.ok(secondStored);
  assert.equal(secondStored!.status, "service-error");
});

test("M5: a failure never overwrites a still-available row's content", async () => {
  const store = await readyStore();
  // Force macro's due window open again by predating its lastAttemptAtMs to before today's anchor,
  // so the next refresh re-attempts macro and we can prove the stored content survives the failure.
  const existing = await store.getNews("a", OWNER, GLOBAL_TICKER, CMC_SKILL_MACRO);
  assert.ok(existing);
  await store.putNews({ ...existing!, context: "{\"upcoming\":[],\"later\":[],\"recent\":[]}", lastAttemptAtMs: NOW_MS - 25 * 60 * 60_000, asOfMs: NOW_MS - 25 * 60 * 60_000 });
  const failingPayment = {
    async authorize() { return { ok: true as const }; },
    async fetchChallenge(): Promise<never> { throw new Error("network down"); },
    async reserve(): Promise<never> { throw new Error("must not reserve"); },
    async prepare(): Promise<never> { throw new Error("must not prepare"); },
    async transmit(): Promise<never> { throw new Error("must not transmit"); },
  };
  const service = createCmcNewsService({ store, payment: failingPayment as never, now: () => NOW_MS });
  const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: NOW_MS + 100_000, generation: 0, heldTickers: [], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7), nowMs: NOW_MS });
  assert.equal(result.ticker, GLOBAL_TICKER);
  assert.equal(result.state, "service-error");
  const stored = await store.getNews("a", OWNER, GLOBAL_TICKER, CMC_SKILL_MACRO);
  assert.equal(stored?.status, "available", "the prior available row survives the failed attempt");
  assert.equal(stored?.context, "{\"upcoming\":[],\"later\":[],\"recent\":[]}");
  assert.equal(stored?.lastAttemptAtMs, NOW_MS);
});

test("N9/L6: an unmapped held ticker is reported as cmc:unmapped:<ticker> in the refresh result's observations, even when nothing ends up due", async () => {
  const store = await readyStore();
  const payment = paymentFixture([], [], JSON.stringify({ result: { content: [{ type: "text", text: "unused" }] } }));
  const service = createCmcNewsService({ store, payment: payment as never, now: () => NOW_MS });
  const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: NOW_MS + 100_000, generation: 0, heldTickers: ["ZZZZ"], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7) });
  assert.equal(result.ticker, null);
  assert.equal(result.reason, "context_fresh");
  assert.deepEqual(result.observations, ["cmc:unmapped:ZZZZ"]);
});

// ---------------------------------------------------------------------------
// AUDIT M-R2/N3/N4/N5/N7: end-to-end "+1 after release" through the real
// service. The fake rejects any unique_name outside the four real skills
// (catches N3, the exact original bug: sending "macro_news_aggregator:release"
// as the API skill name).
// ---------------------------------------------------------------------------

function macroReleaseFixture(seenSkillNames: string[], responseFor: (skillName: string) => string) {
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
      const skillName = isSkillCall ? parsed.params?.arguments?.unique_name ?? null : parsed.params?.name ?? null;
      const allowed = ["macro_news_aggregator", "get_global_metrics_latest", "us_equity_sector_rotation",
        "us_equity_uptrend_quality_scanner", "us_equity_trade_planning_context"];
      if (skillName === null || !allowed.includes(skillName)) {
        assert.fail(`unrecognized skill/tool name requested: ${JSON.stringify(parsed.params)} (N3: must never be "macro_news_aggregator:release")`);
      }
      const body = responseFor(skillName);
      seenSkillNames.push(skillName);
      return { status: 200, headers: {}, body };
    },
  };
}

function macroWrapper(events: { readonly upcoming?: readonly unknown[]; readonly later?: readonly unknown[]; readonly recent?: readonly unknown[] }): string {
  const pack = { type: "evidence_pack", skill_id: "macro_news_aggregator", timestamp: "2026-09-23T00:00:00Z",
    data: { evidence: { upcoming_events_72h: events.upcoming ?? [], later_events_days_4_to_7: events.later ?? [], recent_macro_releases: events.recent ?? [] } } };
  return JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ result: { ok: true, data: pack } }) }] } });
}

test("AUDIT N3/N4/N7: the +1 release call sends the REAL skill name, files under the separate store key, and leaves the daily row untouched", async () => {
  const dayStart = Date.UTC(2026, 8, 23, 12, 0); // Wed 08:00 ET
  const store = new MemoryTradeCmcStore(() => clockRef.value);
  const clockRef = { value: dayStart };
  await store.putInitial({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, generation: 0, sessionPublicKey: KEY, sessionExpiry: dayStart + 1_000_000_000, allowanceWei: TOTAL });
  await store.setCapability({ agentId: "a", ownerAddress: OWNER, generation: 0, available: true });
  // CPI releases at 08:30 ET, 30 min AFTER the 08:00 ET daily fetch — so the
  // daily row's own asOf (08:00) predates the release, and the +1 is due.
  const CPI_RELEASED = { event: "Core Inflation Rate", event_at: "2026-09-23T12:30:00Z", importance: "major", event_status: "released",
    metrics: [{ metric: "Core Inflation Rate YoY (Aug)", actual: 3.3, estimate: 3.4, previous: 3.3, unit: "%" }] };
  const seenSkillNames: string[] = [];
  const payment = macroReleaseFixture(seenSkillNames, (skillName) => {
    if (skillName === "macro_news_aggregator") {
      // Both the daily and release calls answer through this same skill; the
      // release response is distinguished by having the event in `recent`.
      return seenSkillNames.filter((s) => s === "macro_news_aggregator").length === 0
        ? macroWrapper({ upcoming: [{ ...CPI_RELEASED, event_status: "scheduled", metrics: [{ metric: "Core Inflation Rate YoY (Aug)", estimate: 3.4, previous: 3.3, unit: "%" }] }] })
        : macroWrapper({ recent: [CPI_RELEASED] });
    }
    return JSON.stringify({ result: { content: [{ type: "text", text: '{"total_crypto_market_cap_usd":{"percent_change":{"24h":"+0.1%","7d":"+0.1%"}}}' }] } });
  });
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  // 08:00 ET: the daily macro call.
  const daily = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: dayStart + 1_000_000_000, generation: 0, heldTickers: [], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  assert.equal(daily.state, "available");
  const dailyRow = await store.getNews("a", OWNER, GLOBAL_TICKER, CMC_SKILL_MACRO);
  const dailyAsOf = dailyRow!.asOfMs;
  // 09:00 ET: the +1 (global metrics isn't due yet in this narrow scenario? it
  // is, but priority still tries macro's release branch first since the daily
  // macro row is already available).
  clockRef.value = dayStart + 3_600_000;
  const plusOne = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: dayStart + 1_000_000_000, generation: 0, heldTickers: [], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  assert.equal(plusOne.ticker, GLOBAL_TICKER);
  assert.equal(plusOne.state, "available", plusOne.reason ?? "no reason");
  // N3: the wire body sent for the +1 call must name the REAL skill.
  assert.equal(seenSkillNames[1], "macro_news_aggregator", "the +1 call must send the real macro_news_aggregator skill name");
  // N4: the release content must be filed under the SEPARATE store key, and
  // must NOT have overwritten the daily row.
  const releaseRow = await store.getNews("a", OWNER, GLOBAL_TICKER, CMC_SKILL_MACRO_RELEASE);
  assert.ok(releaseRow, "the release content must be stored under macro_news_aggregator:release");
  assert.ok(releaseRow!.context!.includes("Core Inflation Rate"));
  const dailyRowAfter = await store.getNews("a", OWNER, GLOBAL_TICKER, CMC_SKILL_MACRO);
  assert.equal(dailyRowAfter!.asOfMs, dailyAsOf, "the daily row must be untouched by the +1 write");
  assert.ok(!dailyRowAfter!.context!.includes('"actual":3.3'), "the daily row must not have picked up the release's actual value");

  // N7: the worker must read the NEWER (release) row when computing the macro
  // line/eventRisk, not just the daily row.
  const macro = readCompactMacro(releaseRow!.context!)!;
  assert.equal(macroEventRiskUsEquity(macro, clockRef.value), "high", "the release row alone must drive eventRisk high");
});

test("AUDIT N5: no +1 fires for an event whose release time is BEFORE the daily row's own asOf", async () => {
  const dayStart = Date.UTC(2026, 8, 23, 12, 0); // Wed 08:00 ET
  const store = new MemoryTradeCmcStore(() => clockRef.value);
  const clockRef = { value: dayStart };
  await store.putInitial({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, generation: 0, sessionPublicKey: KEY, sessionExpiry: dayStart + 1_000_000_000, allowanceWei: TOTAL });
  await store.setCapability({ agentId: "a", ownerAddress: OWNER, generation: 0, available: true });
  // The release happened at 07:00 ET, BEFORE the 08:00 ET daily fetch: already
  // "old news" to the daily row, so it must never trigger a +1.
  const OLD_RELEASE = { event: "Core Inflation Rate", event_at: "2026-09-23T11:00:00Z", importance: "major", event_status: "released",
    metrics: [{ metric: "Core Inflation Rate YoY (Aug)", actual: 3.3, estimate: 3.4, previous: 3.3, unit: "%" }] };
  const seenSkillNames: string[] = [];
  const payment = macroReleaseFixture(seenSkillNames, (skillName) => skillName === "macro_news_aggregator"
    ? macroWrapper({ recent: [OLD_RELEASE] })
    : JSON.stringify({ result: { content: [{ type: "text", text: '{"total_crypto_market_cap_usd":{"percent_change":{"24h":"+0.1%","7d":"+0.1%"}}}' }] } }));
  const service = createCmcNewsService({ store, payment: payment as never, now: () => clockRef.value });
  await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: dayStart + 1_000_000_000, generation: 0, heldTickers: [], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  clockRef.value = dayStart + 3_600_000; // 09:00 ET
  const second = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: dayStart + 1_000_000_000, generation: 0, heldTickers: [], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7), nowMs: clockRef.value });
  // The next due thing is the global tool, never a second macro_news_aggregator call.
  assert.equal(seenSkillNames.filter((s) => s === "macro_news_aggregator").length, 1, "no +1 for a release that predates the daily row's asOf");
  assert.equal(second.state, "available");
  void second;
});

test("operator log 2026-09-24: a paid call whose response does not parse carries its skill and the first 300 chars of the response", async () => {
  const store = new MemoryTradeCmcStore(() => NOW_MS);
  await store.putInitial({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, totalWei: TOTAL });
  await store.setSetup({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, generation: 0, sessionPublicKey: KEY, sessionExpiry: NOW_MS + 100_000, allowanceWei: TOTAL });
  await store.setCapability({ agentId: "a", ownerAddress: OWNER, generation: 0, available: true });
  const body = JSON.stringify({ result: { ok: false, error: "skill timed out", padding: "x".repeat(500) } });
  const service = createCmcNewsService({ store, payment: paymentFixture([], [], body) as never, now: () => NOW_MS });
  const result = await service.refresh({ agentId: "a", ownerAddress: OWNER, wallet: WALLET, sessionPublicKey: KEY,
    sessionExpiry: NOW_MS + 100_000, generation: 0, heldTickers: [], shortlistedTickers: [], masterKey: Buffer.alloc(32, 7), nowMs: NOW_MS });
  assert.notEqual(result.state, "available");
  assert.equal(result.skill, CMC_SKILL_MACRO);
  assert.equal(result.responseExcerpt, `no evidence key; ${body.slice(0, 280)}`);
});
