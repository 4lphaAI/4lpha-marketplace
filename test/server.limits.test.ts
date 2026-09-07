/**
 * Body caps, rate limits, and the limiter primitives underneath them.
 *
 * A body cap and a rate limiter are the least glamorous controls in the service
 * and the two most likely to be quietly wrong, because nothing fails when they
 * are missing — right up until something does. The unit tests below pin the
 * arithmetic; the HTTP tests pin that the arithmetic is actually wired in, and
 * that the cheap rejection really does happen BEFORE the expensive work.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  TARGET,
  call,
  createHarness,
  errorCode,
  signOwnerAction,
} from "./support/serverHarness.js";
import { ExecuteThrottle, TokenBucketLimiter } from "../src/http/limits.js";

describe("TokenBucketLimiter", () => {
  it("allows a full burst and then refuses", () => {
    const limiter = new TokenBucketLimiter({
      capacity: 3,
      refillPerSecond: 1,
      now: () => 0,
    });
    assert.deepEqual(
      [1, 2, 3, 4].map(() => limiter.tryConsume("k")),
      [true, true, true, false],
    );
  });

  it("refills at the configured rate", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      capacity: 2,
      refillPerSecond: 1,
      now: () => now,
    });
    limiter.tryConsume("k");
    limiter.tryConsume("k");
    assert.equal(limiter.tryConsume("k"), false);

    now += 1_000;
    assert.equal(limiter.tryConsume("k"), true, "one second buys one token");
    assert.equal(limiter.tryConsume("k"), false);
  });

  it("keeps buckets independent per key", () => {
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 1,
      now: () => 0,
    });
    assert.equal(limiter.tryConsume("a"), true);
    assert.equal(limiter.tryConsume("b"), true);
    assert.equal(limiter.tryConsume("a"), false);
  });

  it("bounds its keyspace so a spray of sources cannot exhaust memory", () => {
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 1,
      maxKeys: 10,
      now: () => 0,
    });
    for (let i = 0; i < 1_000; i += 1) limiter.tryConsume(`source-${i}`);
    assert.ok(limiter.size() <= 10, `keyspace grew to ${limiter.size()}`);
  });

  it("rejects a nonsensical configuration rather than limiting nothing", () => {
    assert.throws(
      () => new TokenBucketLimiter({ capacity: 0, refillPerSecond: 1 }),
      /capacity/,
    );
    assert.throws(
      () => new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0 }),
      /refillPerSecond/,
    );
  });
});

describe("ExecuteThrottle", () => {
  it("enforces the minimum interval", () => {
    let now = 0;
    const throttle = new ExecuteThrottle({
      minIntervalMs: 1_000,
      maxPerWindow: 100,
      windowMs: 60_000,
      now: () => now,
    });
    assert.equal(throttle.tryAcquire("a").allowed, true);
    assert.equal(throttle.tryAcquire("a").allowed, false);
    now += 1_000;
    assert.equal(throttle.tryAcquire("a").allowed, true);
  });

  it("enforces the rolling window and then frees up", () => {
    let now = 0;
    const throttle = new ExecuteThrottle({
      minIntervalMs: 0,
      maxPerWindow: 2,
      windowMs: 10_000,
      now: () => now,
    });
    assert.equal(throttle.tryAcquire("a").allowed, true);
    assert.equal(throttle.tryAcquire("a").allowed, true);
    assert.equal(throttle.tryAcquire("a").allowed, false);

    now += 10_001;
    assert.equal(throttle.tryAcquire("a").allowed, true, "the window aged out");
  });

  it("does not push a throttled caller further away for retrying", () => {
    let now = 0;
    const throttle = new ExecuteThrottle({
      minIntervalMs: 1_000,
      maxPerWindow: 100,
      windowMs: 60_000,
      now: () => now,
    });
    throttle.tryAcquire("a");
    now += 500;
    // A rejected attempt must not be recorded, or a hot-looping client would
    // never be allowed through again.
    assert.equal(throttle.tryAcquire("a").allowed, false);
    now += 500;
    assert.equal(throttle.tryAcquire("a").allowed, true);
  });

  it("reports how long to wait", () => {
    const throttle = new ExecuteThrottle({
      minIntervalMs: 1_000,
      maxPerWindow: 100,
      windowMs: 60_000,
      now: () => 0,
    });
    throttle.tryAcquire("a");
    const verdict = throttle.tryAcquire("a");
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.allowed === false && verdict.reason, "min_interval");
    assert.equal(verdict.allowed === false && verdict.retryAfterMs, 1_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Wired into HTTP                                                            */
/* -------------------------------------------------------------------------- */

describe("body size cap", () => {
  it("413s a body over the cap on execute", async () => {
    const harness = await createHarness({ config: { maxBodyBytes: 256 } });
    const response = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: {
        decisionId: "d",
        calls: [{ to: TARGET, data: `0x${"ab".repeat(400)}` }],
      },
    });
    assert.equal(response.status, 413);
    assert.equal(errorCode(response.body), "payload_too_large");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("413s a body over the cap on an owner mutation, before any ecrecover", async () => {
    const harness = await createHarness({ config: { maxBodyBytes: 128 } });
    const envelope = await signOwnerAction("pause", { padding: "x".repeat(500) });
    const response = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 413);
  });

  it("413s on a declared content-length even when the body is short", async () => {
    const harness = await createHarness({ config: { maxBodyBytes: 64 } });
    const response = await call(harness, `/agents/${AGENT_ID}/pause`, {
      method: "POST",
      headers: { "content-length": "100000" },
      body: { a: 1 },
    });
    assert.equal(response.status, 413);
  });

  it("accepts a body under the cap", async () => {
    const harness = await createHarness({
      httpRuntimeProfile: "raw-v1",
      config: { maxBodyBytes: 4_096 },
    });
    const response = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "d", calls: [{ to: TARGET }] },
    });
    assert.equal(response.status, 200);
  });

  it("400s an empty or non-JSON body", async () => {
    const harness = await createHarness();
    const empty = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: "",
    });
    assert.equal(empty.status, 400);

    const garbage = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: "{not json",
    });
    assert.equal(garbage.status, 400);
  });
});

describe("rate limiting", () => {
  it("limits by source BEFORE the credential is even checked", async () => {
    const harness = await createHarness({
      config: { rateLimit: { capacity: 2, refillPerSecond: 0.0001 } },
    });

    // Deliberately WRONG credentials: the limiter must still bite, which is what
    // makes it useful against an unauthenticated flood.
    const first = await call(harness, "/status", {
      execToken: "wrong",
      headers: { "x-forwarded-for": "10.0.0.9" },
    });
    const second = await call(harness, "/status", {
      execToken: "wrong",
      headers: { "x-forwarded-for": "10.0.0.9" },
    });
    const third = await call(harness, "/status", {
      execToken: "wrong",
      headers: { "x-forwarded-for": "10.0.0.9" },
    });

    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
    assert.equal(third.status, 429);
    assert.equal(errorCode(third.body), "rate_limited");
  });

  it("keeps separate budgets per source address", async () => {
    const harness = await createHarness({
      config: { rateLimit: { capacity: 1, refillPerSecond: 0.0001 } },
    });
    const a = await call(harness, "/status", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    const b = await call(harness, "/status", {
      headers: { "x-forwarded-for": "10.0.0.2" },
    });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    const aAgain = await call(harness, "/status", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    assert.equal(aAgain.status, 429);
  });

  it("never rate-limits the platform healthcheck", async () => {
    const harness = await createHarness({
      config: { rateLimit: { capacity: 1, refillPerSecond: 0.0001 } },
    });
    for (let i = 0; i < 5; i += 1) {
      const response = await call(harness, "/health", { noExecToken: true });
      assert.equal(response.status, 200, "a probe that 429s looks like an outage");
    }
  });
});

describe("unknown routes", () => {
  it("404s with the same shape as everything else", async () => {
    const harness = await createHarness();
    const response = await call(harness, "/nope");
    assert.equal(response.status, 404);
    assert.equal(errorCode(response.body), "not_found");
  });
});
