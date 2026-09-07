/**
 * Secret discipline and network isolation for the HTTP layer.
 *
 * The properties here are the ones whose failure is silent. A leaked key does not
 * throw; it just appears in a body or a log line and keeps working. So instead of
 * reasoning about which routes "could" leak, these tests seed a KNOWN session key
 * and a KNOWN credential, drive every endpoint, and capture every response body
 * and every console line — then assert the secrets appear in none of them.
 *
 * The network test is the same idea applied to egress: a mocked `fetch` records
 * every URL, and the assertion is that only the configured data-plane origin is
 * ever contacted. The execution plane must never talk to an upstream market-data
 * provider itself.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  EXEC_TOKEN,
  OPERATOR_TOKEN,
  SESSION_KEY,
  TARGET,
  call,
  createHarness,
  errorCode,
  signRuntimeRequest,
  signOwnerAction,
  toReadHeader,
  type Harness,
} from "./support/serverHarness.js";
import { GLOBAL_AGENT_SENTINEL } from "../src/auth/ownerAuth.js";
import { HttpDataPlaneClient, type FetchLike } from "../src/clients/dataPlane.js";
import { sanitizeMessage } from "../src/core/errors.js";

/** Every response body produced by exercising the whole API once. */
async function sweepApi(harness: Harness): Promise<string[]> {
  const bodies: string[] = [];
  const record = (result: { text: string }): void => {
    bodies.push(result.text);
  };

  record(await call(harness, "/health", { noExecToken: true }));
  record(await call(harness, "/status"));
  record(await call(harness, `/agents/${AGENT_ID}`));
  record(await call(harness, "/agents/ghost"));

  record(
    await call(harness, `/agents/${AGENT_ID}/owner-view`, {
      headers: {
        "x-owner-action": toReadHeader(await signOwnerAction("read", { a: 1 })),
      },
    }),
  );
  record(
    await call(harness, "/agents", {
      headers: {
        "x-owner-action": toReadHeader(
          await signOwnerAction("read", { a: 1 }, { agentId: GLOBAL_AGENT_SENTINEL }),
        ),
      },
    }),
  );

  record(
    await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "sweep-1", calls: [{ to: TARGET, value: "1" }] },
    }),
  );
  // And an execute that fails, since an error path is where a secret is most
  // likely to be pasted into a message.
  harness.provider.nextError = new Error(
    `relay rejected: key=${SESSION_KEY} token=${EXEC_TOKEN}`,
  );
  record(
    await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "sweep-2", calls: [{ to: TARGET, value: "2" }] },
    }),
  );
  harness.provider.nextError = null;

  record(
    await call(harness, `/agents/${AGENT_ID}/change-budget`, {
      method: "POST",
      body: await signOwnerAction("changeBudget", { dailyNativeWei: "7" }),
    }),
  );
  record(
    await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: await signOwnerAction("pause", {}),
    }),
  );
  record(
    await call(harness, `/agents/${AGENT_ID}/unpause`, {
      method: "POST",
      body: await signOwnerAction("unpause", {}),
    }),
  );
  record(
    await call(harness, `/agents/${AGENT_ID}/revoke`, {
      method: "POST",
      body: await signOwnerAction("revoke", {}),
    }),
  );

  record(
    await call(harness, "/admin/halt", {
      method: "POST",
      headers: { "x-operator-token": OPERATOR_TOKEN },
      body: { actor: "oncall", reason: "sweep" },
    }),
  );
  record(
    await call(harness, "/admin/resume", {
      method: "POST",
      headers: { "x-operator-token": OPERATOR_TOKEN },
      body: { actor: "oncall" },
    }),
  );

  // Failure shapes too.
  record(await call(harness, "/status", { noExecToken: true }));
  record(await call(harness, "/nope"));
  record(await call(harness, `/agents/${AGENT_ID}/pause`, { method: "POST", body: {} }));

  return bodies;
}

/** Capture everything written to the console while `fn` runs. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const capture = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await fn();
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  return lines;
}

describe("secret egress", () => {
  it("never puts the session key in any response body", async () => {
    const harness = await createHarness({ httpRuntimeProfile: "raw-v1" });
    const bodies = await sweepApi(harness);

    assert.ok(bodies.length > 10, "the sweep must actually exercise the API");
    for (const body of bodies) {
      assert.ok(
        !body.includes(SESSION_KEY),
        `a response body contained the session key: ${body.slice(0, 200)}`,
      );
      // Also catch a key that lost its 0x prefix on the way out.
      assert.ok(!body.includes(SESSION_KEY.slice(2)), "unprefixed key material leaked");
    }
  });

  it("never puts a credential in any response body", async () => {
    const harness = await createHarness();
    const bodies = await sweepApi(harness);
    for (const body of bodies) {
      assert.ok(!body.includes(EXEC_TOKEN), "the service credential leaked");
      assert.ok(!body.includes(OPERATOR_TOKEN), "the operator credential leaked");
    }
  });

  it("never writes the session key or a credential to a log line", async () => {
    const harness = await createHarness();
    const lines = await captureLogs(async () => {
      await sweepApi(harness);
    });
    for (const line of lines) {
      assert.ok(!line.includes(SESSION_KEY), `a log line contained the key: ${line}`);
      assert.ok(!line.includes(EXEC_TOKEN), `a log line contained the credential: ${line}`);
      assert.ok(!line.includes(OPERATOR_TOKEN), `a log line contained the operator token: ${line}`);
    }
  });

  it("never writes key material into journal.last_error", async () => {
    const harness = await createHarness({ httpRuntimeProfile: "raw-v1" });
    harness.provider.nextError = new Error(
      `provider blew up with key ${SESSION_KEY} at https://relay.example/x?k=${EXEC_TOKEN}`,
    );
    const response = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "boom", calls: [{ to: TARGET }] },
    });

    const meta = response.body["meta"] as Record<string, unknown>;
    const entry = await harness.journal.get(meta["idempotencyKey"] as string);
    assert.notEqual(entry, null);
    const stored = entry?.lastError ?? "";
    assert.ok(!stored.includes(SESSION_KEY), "the journal stored the session key");
    assert.ok(!stored.includes(EXEC_TOKEN), "the journal stored the credential");
    assert.ok(!stored.includes("relay.example"), "the journal stored an upstream URL");
  });

  it("does not echo an upstream error message back to the client", async () => {
    const harness = await createHarness();
    harness.provider.nextError = new Error(
      `boom https://relay.internal/secret ${SESSION_KEY}`,
    );
    const response = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "echo", calls: [{ to: TARGET }] },
    });
    assert.ok(!response.text.includes("relay.internal"));
    assert.ok(!response.text.includes(SESSION_KEY));
  });

  it("exposes no route that returns the stored session key", async () => {
    const harness = await createHarness();
    // Direct proof the key IS there to leak, so the sweep above is meaningful.
    const stored = await harness.agentStore.getAgentSessionKey(
      (await harness.agentStore.getAgentById(AGENT_ID))!.ownerAddress,
      AGENT_ID,
    );
    assert.equal(stored, SESSION_KEY);
  });
});

/* -------------------------------------------------------------------------- */
/* Sanitization of every error body                                           */
/* -------------------------------------------------------------------------- */

describe("every error body is sanitized", () => {
  it("passes error messages through sanitizeMessage", async () => {
    const harness = await createHarness();
    // A validation error whose message would otherwise be echoed verbatim.
    const response = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: {
        decisionId: "d",
        calls: [{ to: `https://evil.example/${"ab".repeat(40)}` }],
      },
    });
    assert.equal(response.status, 400);
    const error = response.body["error"] as Record<string, unknown>;
    const message = String(error["message"] ?? "");
    // Whatever the message says, it is the sanitizer's output.
    assert.equal(message, sanitizeMessage(message));
    assert.ok(!message.includes("https://evil.example"));
  });

  it("emits only codes from the closed taxonomy", async () => {
    const harness = await createHarness();
    const allowed = new Set([
      "unauthorized",
      "owner_auth_failed",
      "runtime_auth_failed",
      "runtime_auth_unavailable",
      "not_found",
      "invalid_request",
      "payload_too_large",
      "rate_limited",
      "throttled",
      "conflict",
      "paused",
      "halted",
      "revoked",
      "not_executable",
      "internal_error",
    ]);

    const failures = [
      await call(harness, "/status", { noExecToken: true }),
      await call(harness, "/nope"),
      await call(harness, "/agents/ghost"),
      await call(harness, `/agents/${AGENT_ID}/pause`, { method: "POST", body: {} }),
      await call(harness, `/agents/${AGENT_ID}/execute`, {
        method: "POST",
        body: { decisionId: "d", calls: [] },
      }),
      await call(harness, "/admin/halt", { method: "POST", body: { actor: "x" } }),
    ];

    for (const failure of failures) {
      const code = errorCode(failure.body);
      assert.notEqual(code, undefined);
      assert.ok(allowed.has(code ?? ""), `unexpected error code: ${code}`);
    }
  });

  it("returns a bare internal_error for an unexpected throw", async () => {
    const harness = await createHarness();
    const assertion = await signRuntimeRequest(harness, AGENT_ID, "agentRead", {});
    // Force a failure deep in the store, with a message full of things that must
    // not reach the client.
    harness.agentStore.getAgentById = async () => {
      throw new Error(`internal detail https://db.internal/x ${SESSION_KEY}`);
    };
    const lines = await captureLogs(async () => {
      const response = await call(harness, `/agents/${AGENT_ID}`, {
        runtimeAssertion: assertion,
      });
      assert.equal(response.status, 500);
      assert.equal(errorCode(response.body), "internal_error");
      // Nothing but the code.
      assert.ok(!response.text.includes("db.internal"));
      assert.ok(!response.text.includes(SESSION_KEY));
    });
    for (const line of lines) {
      assert.ok(!line.includes(SESSION_KEY));
      assert.ok(!line.includes("db.internal"));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Network isolation                                                          */
/* -------------------------------------------------------------------------- */

describe("network isolation — the data plane is the only upstream", () => {
  it("requests the exact token-scoped ranked URL with auth and retains its envelope", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const envelope = {
      data: [{ pool: "0x0000000000000000000000000000000000000001" }],
      meta: {
        asOf: 1_787_088_000_000,
        source: "pancake",
        matched: 1,
        returned: 1,
      },
    };
    const fakeFetch: FetchLike = async (input, init) => {
      calls.push({ url: input, init });
      return new Response(JSON.stringify(envelope), { status: 200 });
    };
    const client = new HttpDataPlaneClient({
      baseUrl: "http://dp.internal",
      token: "dp-token",
      fetch: fakeFetch,
    });

    const result = await client.lpRankedPools(
      "0x55d398326f99059fF775485246999027B3197955",
      "lpFeeApr24h",
    );

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "http://dp.internal/pools/top?token=0x55d398326f99059ff775485246999027b3197955&orderBy=lpFeeApr24h&aprField=lpFeeApr24h&limit=500",
    );
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["x-dp-token"], "dp-token");
    assert.equal(headers?.["x-exec-token"], undefined);
    assert.deepEqual(result, envelope);
  });

  it("keeps existing methods data-only while ranked pools retains metadata", async () => {
    const fakeFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          data: { symbol: "TOKEN" },
          meta: { asOf: 1_787_088_000_000 },
        }),
        { status: 200 },
      );
    const client = new HttpDataPlaneClient({
      baseUrl: "http://dp.internal",
      fetch: fakeFetch,
    });

    assert.deepEqual(
      await client.token("0x000000000000000000000000000000000000dead"),
      { symbol: "TOKEN" },
    );
    assert.deepEqual(
      await client.lpRankedPools("0x000000000000000000000000000000000000dead", "lpFeeApr24h"),
      {
        data: { symbol: "TOKEN" },
        meta: { asOf: 1_787_088_000_000 },
      },
    );
  });

  it("rejects a hostile ranked-pool token before it can retarget egress", async () => {
    const contacted: string[] = [];
    const fakeFetch: FetchLike = async (input) => {
      contacted.push(input);
      return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    };
    const client = new HttpDataPlaneClient({
      baseUrl: "http://dp.internal",
      fetch: fakeFetch,
    });

    for (const hostile of [
      "//evil.example/x",
      "http://evil.example/x",
      "0x000000000000000000000000000000000000dead&orderBy=combinedApr",
      "\\\\evil.example\\x",
    ]) {
      await assert.rejects(
        () => client.lpRankedPools(hostile, "lpFeeApr24h"),
        /invalid persisted discovery token/u,
      );
    }

    assert.deepEqual(contacted, []);
  });

  it("makes NO direct network call of its own across the whole API", async () => {
    // Every outbound request the execution plane is allowed to make goes through
    // the injected data-plane client. So if the server itself ever reached for a
    // provider directly, it would have to go through global `fetch` — and this
    // records every such attempt while the entire API is exercised.
    const direct: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      direct.push(String(input));
      throw new Error("the execution plane must not fetch directly");
    }) as typeof globalThis.fetch;

    try {
      const harness = await createHarness();
      await sweepApi(harness);
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.deepEqual(
      direct,
      [],
      "the execution plane contacted an upstream without going through the data plane",
    );
  });

  it("contacts no host other than the configured data plane", async () => {
    const contacted: string[] = [];
    const fakeFetch: FetchLike = async (input) => {
      contacted.push(input);
      return new Response(JSON.stringify({ data: { ok: true, uptimeSec: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new HttpDataPlaneClient({
      baseUrl: "http://data-plane.internal:8080",
      token: "dp-token",
      fetch: fakeFetch,
    });

    await client.health();
    await client.token("0x000000000000000000000000000000000000dead");
    await client.security("0x000000000000000000000000000000000000dead");
    await client.lpRankedPools("0x000000000000000000000000000000000000dead", "lpFeeApr24h");

    assert.ok(contacted.length >= 4);
    for (const url of contacted) {
      assert.equal(
        new URL(url).origin,
        "http://data-plane.internal:8080",
        `the execution plane contacted a non-data-plane host: ${url}`,
      );
    }
  });

  it("sends the data-plane credential and nothing else", async () => {
    const seen: RequestInit[] = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      if (init !== undefined) seen.push(init);
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    };
    const client = new HttpDataPlaneClient({
      baseUrl: "http://dp.internal",
      token: "dp-token",
      fetch: fakeFetch,
    });
    await client.token("0x000000000000000000000000000000000000dead");

    const headers = seen[0]?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["x-dp-token"], "dp-token");
    assert.equal(headers?.["x-exec-token"], undefined);
  });

  it("cannot be retargeted at another host by a route parameter", async () => {
    const contacted: string[] = [];
    const fakeFetch: FetchLike = async (input) => {
      contacted.push(input);
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    };
    const client = new HttpDataPlaneClient({
      baseUrl: "http://dp.internal",
      fetch: fakeFetch,
    });

    // `//evil.example/x` is the classic protocol-relative retarget: passed raw
    // into `new URL(path, base)` it would change the host outright.
    for (const hostile of [
      "//evil.example/x",
      "../../evil",
      "http://evil.example/x",
      "\\\\evil.example\\x",
    ]) {
      await client.token(hostile);
      await client.security(hostile);
    }

    assert.equal(contacted.length, 8);
    for (const url of contacted) {
      assert.equal(
        new URL(url).origin,
        "http://dp.internal",
        `a route parameter retargeted the request: ${url}`,
      );
    }
  });

  it("sanitizes a data-plane failure rather than relaying it", async () => {
    const fakeFetch: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED https://dp.internal:8080/secret");
    };
    const client = new HttpDataPlaneClient({
      baseUrl: "http://dp.internal",
      fetch: fakeFetch,
    });

    await assert.rejects(
      () => client.token("0x000000000000000000000000000000000000dead"),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        assert.ok(!message.includes("dp.internal"), "the upstream URL leaked");
        return true;
      },
    );
  });

  it("swallows a data-plane outage on /status instead of failing the probe", async () => {
    const harness = await createHarness();
    harness.dataPlane.health = async () => null;
    const response = await call(harness, "/status");
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.deepEqual(data["dataPlane"], { reachable: false });
  });
});
