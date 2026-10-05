/** AGENTIC-RFQ-STOCKS R2.4, R3.3, R5.1: the decoder, enrich and prompt of the recorded-underlying feature records. */
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, type Address } from "viem";
import { MAX_UNDERLYING_FEATURES, UNDERLYING_NOTE, UNDERLYING_SERIES, decodeFeature, decodeUnderlyingFeature, enrichUnderlyingFeatures, featurePrompt, selectUnderlyingTokens, type FeatureEvidence,
  type FeatureInterval } from "../src/trade/features.js";
import { scoreToken } from "../src/trade/score.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { HttpTradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import { STEP, allBuckets, evaluationClose, underlyingDataPlane, underlyingRecord, REQUIRED_BARS, FULL_METRICS } from "./support/agenticRfqFeatures.js";
import { featureFixture } from "./support/tradeFeatures.js";

const TOKEN = getAddress("0x75fd4cf6f8392e41e70391d60c90c0d5211603a1");
const AT = Date.UTC(2026, 9, 2, 15, 45, 0);
const SESSION_START = Date.UTC(2026, 9, 2, 13, 30, 0);
const decode = (record: unknown, interval: FeatureInterval = "15m", now = AT, token: Address = TOKEN) => decodeUnderlyingFeature(record, token, interval, now);
const base = (patch: Record<string, unknown> = {}, interval: FeatureInterval = "15m") => underlyingRecord({ token: TOKEN, interval, at: AT, sessionStart: SESSION_START, patch });

test("a valid record decodes to underlying evidence: the token as series identity, USDT as the unpublished quote, every published metric available", () => {
  const evidence = decode(base())!;
  assert.ok(evidence);
  assert.equal(evidence.scope, "underlying");
  assert.deepEqual(evidence.pool, { pool: TOKEN.toLowerCase(), tokenAddress: TOKEN.toLowerCase(), currency: "usd" });
  assert.equal(evidence.quoteAddress, USDT_56.toLowerCase());
  assert.equal(evidence.interval, "15m");
  assert.equal(evidence.metrics.emaSpreadPct.available, true);
  assert.equal(evidence.additiveMetrics!.rsi14!.available, true);
  assert.equal(evidence.additiveMetrics!.orbBreakPct!.available, true);
  assert.equal(evidence.indicatorRevision, 2);
  assert.equal(evidence.sessionState, "rth");
});

test("every wrong identity or lineage field refuses the record", () => {
  const patched = (path: string, value: unknown): Record<string, unknown> => {
    const record = base() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const keys = path.split(".");
    let node = record;
    for (const key of keys.slice(0, -1)) node = node[key] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (value === undefined) delete node[keys.at(-1)!]; else node[keys.at(-1)!] = value;
    return record;
  };
  const refused: [string, unknown][] = [["version", "pool-features-v2"], ["staleness", "stale"], ["identity.chainId", 97], ["identity.tokenAddress", "0x0000000000000000000000000000000000000001"],
    ["identity.interval", "1h"], ["identity.priceCurrency", "token"], ["identity.priceBasis", undefined], ["identity.priceBasis", "usd_per_token"], ["identity.source", "sintral"], ["identity.source", "onchainos"],
    ["lineage.scope", "exact_pool"], ["lineage.scope", "token"], ["coverage.realBars", 29], ["coverage.realBars", 30.5], ["coverage.realBars", undefined], ["coverage.realBars", 121],
    ["snapshotId", "xyz"], ["seriesId", undefined], ["coverage.latestClose", 1], ["calculatedAt", 0], ["identity.observedAt", AT + 1]];
  for (const [path, value] of refused) assert.equal(decode(patched(path, value)), null, `${path}=${String(value)}`);
  assert.ok(decode(patched("coverage.realBars", 30)), "30 real bars is the floor");
  assert.equal(decode(base(), "15m", AT + 2_000_000), null, "a record past its expiry is stale");
  assert.equal(decode(base(), "1h"), null, "an interval the record is not for");
  assert.equal(decode(null), null);
  assert.equal(decode([]), null);
});

test("a record claiming volume metrics is decoded unavailable: rvol20 and the VWAP distance are never read", () => {
  const evidence = decode(base({ metrics: { ...((base() as { metrics: object }).metrics), rvol20: { value: 2, unit: "ratio", requiredBars: 21, usableBars: 21, available: true, reason: null },
    vwapDistancePct: { value: 1, unit: "percent", requiredBars: 1, usableBars: 1, available: true, reason: null } } }))!;
  assert.deepEqual(evidence.metrics.rvol20, { value: null, unit: "ratio", available: false });
  assert.equal(evidence.additiveMetrics!.vwapDistancePct!.available, false);
  assert.equal(evidence.metrics.roc10Pct.available, true, "the price metrics are untouched");
});

test("R3.3 decoder re-enforcement: each metric needs ceil(0.6 x r) changed buckets in its own window, whatever the record says (mutation: floor, or no check)", () => {
  const thresholds: [string, number, number][] = [["roc10Pct", 11, 7], ["momentum10", 11, 7], ["bbPosition20", 20, 12], ["ema12", 24, 15], ["rsi14", 29, 18], ["atr14", 29, 18], ["atrPct", 29, 18],
    ["stochRsi14", 42, 26], ["ema26", 52, 32], ["emaSpreadPct", 52, 32], ["macd", 52, 32], ["signal9", 69, 42], ["histogram", 69, 42]];
  const close = evaluationClose("15m", AT), buckets = allBuckets("15m", AT);
  for (const [name, required, needed] of thresholds) {
    assert.equal(REQUIRED_BARS[name], required, name);
    const window = buckets.filter((t) => t >= close - required * STEP["15m"]);
    assert.equal(window.length, required, name);
    const outside = buckets.filter((t) => t < close - required * STEP["15m"]);
    for (const k of [needed - 1, needed]) {
      const evidence = decode(underlyingRecord({ token: TOKEN, interval: "15m", at: AT, sessionStart: SESSION_START, changed: [...outside, ...window.slice(0, k)] }))!;
      const metric = name in evidence.metrics ? evidence.metrics[name as keyof typeof evidence.metrics] : evidence.additiveMetrics![name as "rsi14"]!;
      assert.equal(metric.available, k === needed, `${name} with ${k} of ${required} changed`);
    }
  }
});

test("R3.3: a series whose last 29 buckets are flat does not publish rsi14 even with 91 changed buckets before them; r <= 1 metrics are exempt", () => {
  const close = evaluationClose("15m", AT);
  const flatTail = allBuckets("15m", AT).filter((t) => t < close - 29 * STEP["15m"]);
  assert.equal(flatTail.length, 91);
  const evidence = decode(underlyingRecord({ token: TOKEN, interval: "15m", at: AT, sessionStart: SESSION_START, changed: flatTail }))!;
  assert.equal(evidence.additiveMetrics!.rsi14!.available, false);
  assert.equal(evidence.metrics.atrPct.available, false);
  assert.equal(evidence.additiveMetrics!.gapPct!.available, true, "gapPct reads one bucket");
});

test("R3.3: a record with no changedBuckets list makes every gated metric unavailable", () => {
  const record = base() as { coverage: Record<string, unknown> };
  delete record.coverage["changedBuckets"];
  const evidence = decode(record)!;
  assert.equal(evidence.metrics.emaSpreadPct.available, false);
  assert.equal(evidence.additiveMetrics!.rsi14!.available, false);
  assert.equal(evidence.additiveMetrics!.gapPct!.available, true);
  const malformed = base() as { coverage: Record<string, unknown> };
  malformed.coverage["changedBuckets"] = ["x", 1];
  assert.equal(decode(malformed)!.metrics.emaSpreadPct.available, false);
});

test("R3.3 ORB: both opening-range buckets must have changed; outside RTH the metric stays unavailable", () => {
  const all = allBuckets("15m", AT);
  const without = (bucket: number) => all.filter((t) => t !== bucket);
  assert.equal(decode(underlyingRecord({ token: TOKEN, interval: "15m", at: AT, sessionStart: SESSION_START }))!.additiveMetrics!.orbBreakPct!.available, true);
  assert.equal(decode(underlyingRecord({ token: TOKEN, interval: "15m", at: AT, sessionStart: SESSION_START, changed: without(SESSION_START) }))!.additiveMetrics!.orbBreakPct!.available, false);
  assert.equal(decode(underlyingRecord({ token: TOKEN, interval: "15m", at: AT, sessionStart: SESSION_START, changed: without(SESSION_START + STEP["15m"]) }))!.additiveMetrics!.orbBreakPct!.available, false);
  assert.equal(decode(underlyingRecord({ token: TOKEN, interval: "15m", at: AT, sessionStart: null }))!.additiveMetrics!.orbBreakPct!.available, false);
  const closed = underlyingRecord({ token: TOKEN, interval: "15m", at: AT, sessionStart: SESSION_START, patch: { session: { state: "overnight", sessionStart: SESSION_START } } });
  assert.equal(decode(closed)!.additiveMetrics!.orbBreakPct!.available, false);
});

test("the metric rules are decodeFeature's own: the same vectors give the same values and the same refusals", () => {
  const poolPool = { pool: "0x0000000000000000000000000000000000000001" as Address, tokenAddress: TOKEN.toLowerCase() as Address, currency: "usd" as const };
  const vectors: Record<string, unknown>[] = [{}, { atr14: -1 }, { ema12: 0 }, { ema26: -2 }, { rsi14: 101 }, { atrPct: 0 }, { roc10Pct: 3 }];
  for (const vector of vectors) {
    const available = { ...FULL_METRICS, ...vector } as Record<string, number>;
    const underlying = decode(underlyingRecord({ token: TOKEN, interval: "15m", at: AT, sessionStart: SESSION_START, available }))!;
    const pool = featureFixture("15m", TOKEN, AT, poolPool.pool) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const poolMetrics: Record<string, unknown> = {};
    for (const name of ["ema12", "ema26", "emaSpreadPct", "roc10Pct", "atr14", "atrPct"]) {
      poolMetrics[name] = (underlyingRecord({ token: TOKEN, interval: "15m", at: AT, available })["metrics"] as Record<string, unknown>)[name];
    }
    const decoded: FeatureEvidence | null = decodeFeature({ ...pool, metrics: { ...pool["metrics"], ...poolMetrics } }, poolPool, "15m", AT);
    assert.ok(decoded);
    for (const name of ["ema12", "ema26", "emaSpreadPct", "roc10Pct", "atr14", "atrPct"] as const) assert.deepEqual(underlying.metrics[name], decoded.metrics[name], `${name} ${JSON.stringify(vector)}`);
  }
});

test("selectUnderlyingTokens: an index of 65 tokens answers nothing, 64 is read; only wanted tokens, lowercased, sorted, once", () => {
  const tokens = Array.from({ length: 65 }, (_, index) => getAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`));
  const index = (rows: readonly Address[]) => ({ tokens: rows.map((tokenAddress) => ({ tokenAddress, usEquity: true })), intervals: ["15m", "1h"], maxTokens: 64 });
  assert.equal(MAX_UNDERLYING_FEATURES, 64);
  assert.deepEqual(selectUnderlyingTokens(index(tokens), tokens), []);
  assert.equal(selectUnderlyingTokens(index(tokens.slice(0, 64)), tokens).length, 64);
  assert.deepEqual(selectUnderlyingTokens(index([tokens[3]!, tokens[1]!, tokens[1]!]), [tokens[1]!, tokens[2]!, tokens[3]!]), [tokens[1]!.toLowerCase(), tokens[3]!.toLowerCase()]);
  assert.deepEqual(selectUnderlyingTokens({ pools: [] }, tokens), []);
  assert.deepEqual(selectUnderlyingTokens(null, tokens), []);
});

test("enrich: one index read, batches of 10 per interval, both intervals decoded, an unavailable row leaves only that token without evidence", async () => {
  const tokens = Array.from({ length: 26 }, (_, index) => getAddress(`0x${(index + 0x100).toString(16).padStart(40, "0")}`));
  const log = { index: 0, batches: [] as Address[][] };
  const dataPlane = underlyingDataPlane({ tokens, at: () => AT, log, record: (token, interval) => token === tokens[5] ? null : underlyingRecord({ token, interval, at: AT, sessionStart: SESSION_START }) });
  const result = await enrichUnderlyingFeatures(dataPlane, tokens, AT);
  assert.equal(log.index, 1);
  assert.deepEqual(log.batches.map((batch) => batch.length).sort((a, b) => b - a), [10, 10, 10, 10, 6, 6], "26 tokens = 3 batches x 2 intervals");
  assert.equal(result.size, 25);
  assert.equal(result.get(tokens[5]!.toLowerCase()), undefined);
  assert.equal(result.get(tokens[0]!.toLowerCase())?.["15m"]?.scope, "underlying");
  assert.equal(result.get(tokens[0]!.toLowerCase())?.["1h"]?.interval, "1h");
  assert.deepEqual(await enrichUnderlyingFeatures({}, tokens, AT), new Map(), "no reads wired: no evidence");
  assert.deepEqual(await enrichUnderlyingFeatures(dataPlane, [], AT), new Map());
});

test("enrich: outages only remove evidence; an aborted signal rejects", async () => {
  const tokens = [TOKEN];
  const failing = { async underlyingFeatureIndex() { throw new Error("down"); }, async underlyingFeaturesBatch() { return {}; } };
  assert.equal((await enrichUnderlyingFeatures(failing, tokens, AT)).size, 0);
  const batchDown = { ...underlyingDataPlane({ tokens, at: () => AT }), async underlyingFeaturesBatch() { throw new Error("down"); } };
  assert.equal((await enrichUnderlyingFeatures(batchDown, tokens, AT)).size, 0);
  const hanging = { async underlyingFeatureIndex() { return new Promise<never>(() => undefined); }, async underlyingFeaturesBatch() { return {}; } };
  const controller = new AbortController();
  const pending = enrichUnderlyingFeatures(hanging, tokens, AT, controller.signal);
  controller.abort(new Error("cycle aborted"));
  await assert.rejects(pending);
});

test("the HTTP reads call the two underlying routes with 1..10 tokens", async () => {
  const urls: string[] = [];
  const reads = new HttpTradeDataPlaneReads({ baseUrl: "https://data-plane.test/", token: "t",
    fetch: async (input) => { urls.push(String(input)); return new Response(JSON.stringify({ data: { ok: true }, meta: {} }), { status: 200, headers: { "content-type": "application/json" } }); } });
  await reads.underlyingFeatureIndex();
  await reads.underlyingFeaturesBatch([TOKEN, getAddress("0x0000000000000000000000000000000000000002")], "1h");
  assert.deepEqual(urls, ["https://data-plane.test/trading/underlying-features/v1/tokens", `https://data-plane.test/trading/underlying-features/v1?tokens=${encodeURIComponent(`${TOKEN.toLowerCase()},0x0000000000000000000000000000000000000002`)}&interval=1h`]);
  await assert.rejects(() => reads.underlyingFeaturesBatch([], "15m"));
  await assert.rejects(() => reads.underlyingFeaturesBatch(Array.from({ length: 11 }, () => TOKEN), "15m"));
});

test("the prompt carries the series label and the note, no pool and no quote key; pool evidence keeps its own bytes", () => {
  const evidence = { "15m": decode(base())!, "1h": decode(base({}, "1h"), "1h")! };
  const text = featurePrompt(evidence, AT, { v2: true });
  const parsed = JSON.parse(text) as { scope: string; series: string; note: string; intervals: Record<string, unknown>[] };
  assert.equal(parsed.scope, "underlying");
  assert.equal(parsed.series, UNDERLYING_SERIES);
  assert.equal(parsed.note, UNDERLYING_NOTE);
  assert.match(parsed.note, /sampled every 60 s, no volume/u);
  assert.equal(parsed.intervals.length, 2);
  for (const row of parsed.intervals) {
    assert.deepEqual(Object.keys(row), ["interval", "base", "currency", "observedAt", "evaluationClose", "snapshotId", "metrics", "indicatorRevision", "additiveMetrics"]);
    assert.equal(row["base"], TOKEN.toLowerCase());
  }
  assert.ok(!/"pool"|"quote"|exact_pool/u.test(text));
  assert.equal(JSON.parse(featurePrompt({ "15m": decode(base())! }, AT)).intervals[0].additiveMetrics, undefined, "v2 additive metrics only with the v2 option");
});

test("R2.5 score vectors without volume: the 7.5 h metric set is 58 / 136 and scoreable, without the regime 46 / 136 and insufficient, one hour only 24 / 136", () => {
  const set15 = { rsi14: 40, atr14: 1, atrPct: 1.5, roc10Pct: 1, bbPosition20: 0.5, gapPct: 0.5, orbBreakPct: 0.3 };
  const f = decode(underlyingRecord({ token: TOKEN, interval: "15m", at: AT, sessionStart: SESSION_START, available: set15 }))!;
  const withRegime = scoreToken(f, undefined, "neutral", "rth");
  assert.equal(Math.round(withRegime.activeWeightShare * 136), 58);
  assert.equal(withRegime.insufficientEvidence, false);
  const without = scoreToken(f, undefined, "unavailable", "rth");
  assert.equal(Math.round(without.activeWeightShare * 136), 46);
  assert.equal(without.insufficientEvidence, true);
  const hour = decode(underlyingRecord({ token: TOKEN, interval: "1h", at: AT, available: { roc10Pct: 1, gapPct: 0.5 } }), "1h")!;
  const hourOnly = scoreToken(undefined, hour, "neutral", "rth");
  assert.equal(Math.round(hourOnly.activeWeightShare * 136), 24);
  assert.equal(hourOnly.insufficientEvidence, true);
});
