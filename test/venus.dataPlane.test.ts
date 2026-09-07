/**
 * PHASE4 — the DataPlaneClient Venus methods (R2.13, `PHASE4-AUDIT.md` A5's
 * client third; the egress obligation of `dataPlane.ts:12-18` extended to the
 * first WRITE paths this client has ever had).
 *
 * Writing this file found a real defect: `venusRewards` invented
 * `venus/core/rewards/:owner`, a path the data plane does not serve — its real
 * route is `venus/core/accounts/:owner/rewards` (verified live 2026-08-22).
 * The permanent 404 mapped to `untracked`, the failure mode that LOOKS like an
 * untracked owner. Hence the discipline here: every method's EXACT path and
 * verb is pinned, not merely its happy-path parsing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpDataPlaneClient, type FetchLike } from "../src/clients/dataPlane.js";

const OWNER = "0x561B561EF37874C8E61534BE9BAE52EB6261DDC4"; // mixed case on purpose
const OWNER_LOWER = OWNER.toLowerCase();
const BASE = "https://data-plane.example";

type Sent = { url: string; method: string; headers: Record<string, string> };

function client(options: {
  readonly status?: number;
  readonly body?: unknown;
  readonly sent?: Sent[];
  readonly token?: string;
}): HttpDataPlaneClient {
  const fetchLike: FetchLike = async (input, init) => {
    options.sent?.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const body = options.body === undefined ? { data: { ok: true } } : options.body;
    return new Response(JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new HttpDataPlaneClient({
    baseUrl: BASE,
    fetch: fetchLike,
    ...(options.token === undefined ? {} : { token: options.token }),
  });
}

describe("venus data-plane client: the exact egress path per method", () => {
  it("venusAccount hits venus/core/accounts/:owner, lowercased, GET", async () => {
    const sent: Sent[] = [];
    await client({ sent }).venusAccount(OWNER);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.method, "GET");
    assert.equal(sent[0]?.url, `${BASE}/venus/core/accounts/${OWNER_LOWER}`);
  });

  it("venusRewards hits the NESTED route the data plane actually serves", async () => {
    // The route is accounts/:owner/rewards. The first draft invented
    // rewards/:owner, which 404s forever and reads as `untracked`.
    const sent: Sent[] = [];
    await client({ sent }).venusRewards(OWNER);
    assert.equal(sent[0]?.url, `${BASE}/venus/core/accounts/${OWNER_LOWER}/rewards`);
  });

  it("venusMarkets hits venus/core/markets", async () => {
    const sent: Sent[] = [];
    await client({ sent }).venusMarkets();
    assert.equal(sent[0]?.url, `${BASE}/venus/core/markets`);
  });

  it("venusTrackOwner is a PUT and venusUntrackOwner a DELETE, on the internal route, reference = agentId", async () => {
    const sent: Sent[] = [];
    const c = client({ sent, body: { data: { tracked: true } } });
    await c.venusTrackOwner(OWNER, "venus-guard-live-1");
    await c.venusUntrackOwner(OWNER, "venus-guard-live-1");
    assert.equal(sent[0]?.method, "PUT");
    assert.equal(
      sent[0]?.url,
      `${BASE}/internal/venus/core/tracked-owners/${OWNER_LOWER}/venus-guard-live-1`,
    );
    assert.equal(sent[1]?.method, "DELETE");
    assert.equal(sent[1]?.url, sent[0]?.url);
  });

  it("every venus request stays on the configured ORIGIN and carries x-dp-token when set", async () => {
    const sent: Sent[] = [];
    const c = client({ sent, token: "dp-secret" });
    await c.venusAccount(OWNER);
    await c.venusTrackOwner(OWNER, "a");
    for (const request of sent) {
      assert.ok(request.url.startsWith(`${BASE}/`), `escaped origin: ${request.url}`);
      assert.equal(request.headers["x-dp-token"], "dp-secret");
    }
  });

  it("a path-traversal agentId cannot escape the origin — it is ENCODED, not interpreted", async () => {
    const sent: Sent[] = [];
    await client({ sent, body: { data: {} } }).venusTrackOwner(
      OWNER,
      "../../../health",
    );
    assert.ok(sent[0]?.url.startsWith(`${BASE}/internal/venus/core/tracked-owners/`));
    assert.ok(!sent[0]?.url.endsWith("/health"));
  });

  it("a malformed owner address is refused BEFORE any request leaves", async () => {
    const sent: Sent[] = [];
    await assert.rejects(client({ sent }).venusAccount("not-an-address"));
    assert.equal(sent.length, 0);
  });
});

describe("venus data-plane client: the read result union (R2.13)", () => {
  it("200 with a real envelope is kind ok, meta included — freshness lives in meta", async () => {
    const result = await client({
      body: { data: { schemaVersion: 2, owner: OWNER_LOWER }, meta: { staleness: "fresh" } },
    }).venusAccount(OWNER);
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal((result.envelope.meta as { staleness?: string })?.staleness, "fresh");
  });

  it("202 is pending — a typed non-answer, never a snapshot", async () => {
    const result = await client({ status: 202, body: { data: { status: "pending" } } })
      .venusAccount(OWNER);
    assert.equal(result.kind, "pending");
  });

  it("a 200 whose BODY says pending is STILL pending — the placeholder branch", async () => {
    // The data plane answers 202 for a fresh registration, but a race can hand
    // back a 200 placeholder. Missing this branch is how a stale-or-absent
    // record becomes a wake signal.
    const result = await client({
      status: 200,
      body: { data: { owner: OWNER_LOWER, status: "pending" } },
    }).venusAccount(OWNER);
    assert.equal(result.kind, "pending");
  });

  it("404 is untracked", async () => {
    const result = await client({ status: 404, body: { error: { code: "not_found" } } })
      .venusAccount(OWNER);
    assert.equal(result.kind, "untracked");
  });

  it("409 capacity_exceeded is the TYPED capacity answer, not an opaque status error", async () => {
    // VENUS_CORE_CAPACITY is 1,000 subjects; a marketplace hitting the ceiling
    // must not look like an outage (R2.13/S13d).
    const result = await client({
      status: 409,
      body: { error: { code: "capacity_exceeded" } },
    }).venusAccount(OWNER);
    assert.equal(result.kind, "capacity");
  });

  it("an unexpected 5xx THROWS — transport is never silently a non-answer", async () => {
    await assert.rejects(
      client({ status: 503, body: { error: { code: "down" } } }).venusAccount(OWNER),
    );
  });
});

describe("venus data-plane client: the tracking result union", () => {
  it("PUT answers ok for both 200 and 201 — created and already-tracked are both success", async () => {
    for (const status of [200, 201]) {
      const result = await client({ status, body: { data: { tracked: true } } })
        .venusTrackOwner(OWNER, "a");
      assert.equal(result.kind, "ok");
    }
  });

  it("PUT 202 is pending — registered, snapshot not yet computed", async () => {
    const result = await client({ status: 202, body: { data: { tracked: true } } })
      .venusTrackOwner(OWNER, "a");
    assert.equal(result.kind, "pending");
  });

  it("DELETE 404 is SUCCESS — the reference is already gone, and reconcile is idempotent", async () => {
    const result = await client({ status: 404, body: { error: { code: "not_found" } } })
      .venusUntrackOwner(OWNER, "a");
    assert.equal(result.kind, "ok");
  });

  it("PUT 404 is NOT success — an untracked answer to a registration is a real refusal", async () => {
    const result = await client({ status: 404, body: { error: { code: "not_found" } } })
      .venusTrackOwner(OWNER, "a");
    assert.equal(result.kind, "untracked");
  });

  it("PUT 409 capacity is typed", async () => {
    const result = await client({
      status: 409,
      body: { error: { code: "capacity_exceeded" } },
    }).venusTrackOwner(OWNER, "a");
    assert.equal(result.kind, "capacity");
  });
});
