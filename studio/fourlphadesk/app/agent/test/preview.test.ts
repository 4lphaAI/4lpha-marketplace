/** The free preview skill: validated input, two MCP reads, cache, build limit, no payment path at all. */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearPreviewState, PREVIEW_BUILDS_PER_MIN, PREVIEW_TTL_MS, previewStock } from "../src/desk/preview.js";
import { err, fakeClient, liveResponder, NOW } from "./helpers.js";

describe("previewStock", () => {
  beforeEach(() => clearPreviewState());

  it("returns the price and where-to-buy sections plus the negotiate envelope for the full report", async () => {
    const client = fakeClient(liveResponder());
    const r = await previewStock({ skill: "preview", ticker: "nvda", usdt: 500 }, { client, now: () => NOW });
    assert.equal(r.status, "ok");
    if (r.status !== "ok") return;
    assert.equal(r.ticker, "NVDA");
    assert.match(r.markdown, /^# 4lpha bStock Desk: free preview, NVDA/);
    assert.match(r.markdown, /not investment advice/i);
    assert.deepEqual(client.calls.map((c) => c.name), ["stock_compare", "bstock_analysis"]);
    const neg = r.full_report.negotiate as Record<string, unknown>;
    assert.equal(neg.skill, "negotiate");
    assert.deepEqual(JSON.parse(neg.task_description as string), { type: "stock_report", ticker: "NVDA", usdt: 500 });
  });

  it("refuses a bad ticker or size before any MCP call", async () => {
    const client = fakeClient(liveResponder());
    for (const data of [{}, { ticker: "" }, { ticker: "NVDA1" }, { ticker: "TOOLONGXX" }, { ticker: 5 }, { ticker: "NVDA", usdt: 0 }, { ticker: "NVDA", usdt: "500" }]) {
      assert.equal((await previewStock(data, { client, now: () => NOW })).status, "invalid", JSON.stringify(data));
    }
    assert.equal(client.calls.length, 0);
  });

  it("serves a repeat from the cache inside the TTL and rebuilds after it", async () => {
    const client = fakeClient(liveResponder());
    let t = NOW;
    await previewStock({ ticker: "NVDA" }, { client, now: () => t });
    await previewStock({ ticker: "NVDA" }, { client, now: () => t });
    assert.equal(client.calls.length, 2);
    t += PREVIEW_TTL_MS + 61_000;
    await previewStock({ ticker: "NVDA" }, { client, now: () => t });
    assert.equal(client.calls.length, 4);
  });

  it("builds at most PREVIEW_BUILDS_PER_MIN fresh previews a minute, then asks to retry without an MCP call", async () => {
    const client = fakeClient(liveResponder());
    let t = NOW;
    const tickers = ["NVDA", "TSLA", "SPY", "QQQ"];
    for (let i = 0; i < PREVIEW_BUILDS_PER_MIN; i++) assert.equal((await previewStock({ ticker: tickers[i] }, { client, now: () => t })).status, "ok");
    const callsBefore = client.calls.length;
    assert.equal((await previewStock({ ticker: tickers[PREVIEW_BUILDS_PER_MIN] }, { client, now: () => t })).status, "retry");
    assert.equal(client.calls.length, callsBefore);
    t += 60_001;
    assert.equal((await previewStock({ ticker: tickers[PREVIEW_BUILDS_PER_MIN] }, { client, now: () => t })).status, "ok");
  });

  it("still answers when the MCP is down, with the sections marked unavailable", async () => {
    const client = fakeClient(() => err("http_503"));
    const r = await previewStock({ ticker: "NVDA" }, { client, now: () => NOW });
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.match(r.markdown, /unavailable/i);
  });
});
