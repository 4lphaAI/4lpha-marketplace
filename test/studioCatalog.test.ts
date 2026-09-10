import assert from "node:assert/strict";
import { it } from "node:test";
import { readStudioCatalog } from "../scripts/studio-catalog.js";

it("Studio operator reader reaches only the data-plane catalog and forwards its observation", async () => {
  const result = { data: [{ id: "1", connected: false, tools: [] }], meta: { staleness: "stale" } };
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://data.example/studio/agents");
    assert.equal(new Headers(init?.headers).get("x-dp-token"), "fixture");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return Response.json(result);
  };
  assert.deepEqual(await readStudioCatalog({ DATA_PLANE_URL: "https://data.example", DATA_PLANE_TOKEN: "fixture" }, fetcher), result);
  assert.equal(calls, 1);
});

it("Studio reader refuses missing configuration without fetch, and sanitizes upstream failures", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("secret upstream text"); };
  await assert.rejects(readStudioCatalog({}, fetcher), /studio_data_plane_not_configured/u);
  assert.equal(calls, 0);
  await assert.rejects(readStudioCatalog({ DATA_PLANE_URL: "https://data.example", DATA_PLANE_TOKEN: "fixture" }, fetcher),
    error => error instanceof Error && error.message === "studio_catalog_unavailable");
});

it("Studio reader refuses oversized and invalid catalog responses", async () => {
  const env = { DATA_PLANE_URL: "https://data.example", DATA_PLANE_TOKEN: "fixture" };
  for (const response of [new Response("x".repeat(4 * 1024 * 1024 + 1)), Response.json({ data: [], meta: { staleness: "made-up" } }), new Response(null, { status: 503 })]) {
    await assert.rejects(readStudioCatalog(env, async () => response), /studio_catalog_unavailable/u);
  }
});

it("Studio reader accepts the bounded aggregate of eight full tool catalogs", async () => {
  const data = Array.from({ length: 8 }, (_, index) => ({ id: String(index), connected: true,
    tools: Array.from({ length: 64 }, (_, tool) => ({ name: `tool_${tool}`, description: "x".repeat(1000) })) }));
  const payload = { data, meta: { staleness: "fresh" } };
  assert.ok(JSON.stringify(payload).length > 262144);
  assert.deepEqual(await readStudioCatalog({ DATA_PLANE_URL: "https://data.example", DATA_PLANE_TOKEN: "fixture" },
    async () => Response.json(payload)), payload);
});
