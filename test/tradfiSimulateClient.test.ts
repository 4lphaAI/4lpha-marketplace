import assert from "node:assert/strict";
import { it } from "node:test";
import { HttpTradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import { WALLET, NV } from "./support/dcaFixtures.js";
const INPUT = { from: WALLET, to: WALLET, data: "0x12" as const, signal: new AbortController().signal };
const WIRE = { version: "binance-simulate-v1", status: "SUCCESS", failReason: null, balanceChanges: [{ token: NV.stock, owner: WALLET, change: "-10" }], otherChangeCount: 1 };
it("C1 wire validation, bound POST and every closed failure-map row", async () => {
  const cases: [number, unknown, string | null][] = [
    [200, { data: WIRE, meta: { upstreamMs: 10 } }, null],
    [200, { data: { ...WIRE, version: "other" } }, "malformed"], [200, { data: { ...WIRE, status: "other" } }, "malformed"],
    [200, { data: { ...WIRE, failReason: "x" } }, "malformed"], [200, { data: { ...WIRE, balanceChanges: Array(65).fill({}) } }, "malformed"],
    [200, { data: { ...WIRE, otherChangeCount: 65 } }, "malformed"], [200, { data: WIRE, meta: { upstreamMs: 60001 } }, "malformed"],
    [400, { error: { code: "simulate_invalid_request" } }, "shape"], [401, {}, "auth"],
    [503, { error: { code: "auth_not_configured" } }, "auth"],
    ...[["credentials_unavailable", "credentials"], ["rate_budget_exhausted", "rate-limited"], ["upstream_rate_limited", "rate-limited"],
      ["upstream_timeout", "timeout"], ["auth_rejected", "auth"], ["disabled", "unavailable"]].map(([reason, expected]) => [503, { error: { code: "simulate_unavailable", reason } }, expected!] as [number, unknown, string]),
    [502, { error: { code: "simulate_invalid_response" } }, "malformed"], [502, { error: { code: "simulate_upstream_error" } }, "upstream-error"], [500, {}, "unavailable"],
  ];
  for (const [status, body, reason] of cases) {
    const client = new HttpTradeDataPlaneReads({ baseUrl: "https://offline.invalid/base", token: "offline-token", fetch: async (url, init) => {
      assert.equal(String(url), "https://offline.invalid/base/internal/binance/pre-transaction/simulate");
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("x-dp-token"), "offline-token");
      assert.deepEqual(Object.keys(JSON.parse(String(init?.body)) as object), ["from", "to", "data"]);
      return new Response(JSON.stringify(body), { status });
    } });
    if (reason === null) { const answer = await client.binanceSimulate(INPUT); assert.equal(answer.balanceChanges[0]?.change, -10n); assert.equal(answer.upstreamMs, 10); }
    else await assert.rejects(client.binanceSimulate(INPUT), { message: `simulate:${reason}` });
  }
  for (const status of [200, 500, 401]) {
    const client = new HttpTradeDataPlaneReads({ baseUrl: "https://offline.invalid", fetch: async () => new Response("not json", { status }) });
    await assert.rejects(client.binanceSimulate(INPUT), { message: `simulate:${status === 200 ? "malformed" : status === 401 ? "auth" : "unavailable"}` });
  }
  const client = new HttpTradeDataPlaneReads({ baseUrl: "https://offline.invalid", fetch: async () => { throw new Error("private"); } });
  await assert.rejects(client.binanceSimulate(INPUT), { message: "simulate:unavailable" });
});
it("C1 raw failure reasons reach the classifier unchanged up to 2048 characters", async () => {
  for (const raw of [" execution reverted", "execution  reverted", "x".repeat(2048)]) {
    const client = new HttpTradeDataPlaneReads({ baseUrl: "https://offline.invalid", fetch: async () => new Response(JSON.stringify({ data: { ...WIRE, status: "FAILED", failReason: raw } })) });
    assert.equal((await client.binanceSimulate(INPUT)).failReason, raw);
  }
});
