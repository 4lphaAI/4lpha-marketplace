import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  assertRuntimeVerifierOnlyEnvironment,
  createRuntimeAssertionClaims,
  encodeRuntimeAssertion,
  httpRuntimeProfileAllows,
  resolveRuntimeAuthConfig,
  runtimeRequestHash,
  verifyRuntimeAssertion,
} from "../src/auth/runtimeAuth.js";
import {
  MemoryRuntimeReplayStore,
  PostgresRuntimeReplayStore,
  type RuntimeReplayStore,
} from "../src/store/runtimeReplays.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import {
  AGENT_ID,
  OWNER_ADDRESS,
  call,
  createHarness,
  errorCode,
  freshNonce,
  signOwnerAction,
  signRuntimeRequest,
  tradeBody,
} from "./support/serverHarness.js";
import { parseTradeRequest } from "../src/http/wire.js";

const ISSUER = "runtime-unit";
const KEY_ID = "key-1";
const ENV_SALT = "runtime-unit-environment";
const NOW = 1_900_000_000;

function cryptoFixture() {
  const pair = generateKeyPairSync("ed25519");
  const publicRaw = (
    pair.publicKey.export({ format: "der", type: "spki" }) as Buffer
  ).subarray(-32);
  const config = resolveRuntimeAuthConfig(
    {
      RUNTIME_ASSERTION_ISSUER: ISSUER,
      RUNTIME_ASSERTION_PUBLIC_KEYS_JSON: JSON.stringify({
        [KEY_ID]: publicRaw.toString("base64url"),
      }),
    },
    { chainId: 97, envSalt: ENV_SALT },
  );
  assert.equal(config.kind, "enabled");
  if (config.kind !== "enabled") throw new Error("unreachable");
  return { pair, config };
}

describe("runtime assertion codec and verifier", () => {
  it("keeps the HTTP profile matrix closed", () => {
    assert.equal(httpRuntimeProfileAllows("unbound-v1", "agentRead"), true);
    assert.equal(httpRuntimeProfileAllows("trade-v1", "trade"), true);
    assert.equal(httpRuntimeProfileAllows("trade-v1", "executeRaw"), false);
    assert.equal(httpRuntimeProfileAllows("raw-v1", "executeRaw"), true);
    assert.equal(httpRuntimeProfileAllows("raw-v1", "trade"), false);
    assert.equal(httpRuntimeProfileAllows("lp-v1", "trade"), false);
    assert.equal(httpRuntimeProfileAllows("venus-v1", "executeRaw"), false);
  });

  it("is disabled only when issuer and key map are both absent", () => {
    assert.deepEqual(resolveRuntimeAuthConfig({}, { chainId: 97 }), { kind: "disabled" });
    assert.throws(() =>
      resolveRuntimeAuthConfig(
        { RUNTIME_ASSERTION_ISSUER: ISSUER },
        { chainId: 97, envSalt: ENV_SALT },
      ),
    );
    assert.throws(() => {
      const pair = generateKeyPairSync("ed25519");
      const raw = (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer)
        .subarray(-32).toString("base64url");
      resolveRuntimeAuthConfig(
        {
          RUNTIME_ASSERTION_ISSUER: ISSUER,
          RUNTIME_ASSERTION_PUBLIC_KEYS_JSON: JSON.stringify({ [KEY_ID]: raw }),
        },
        { chainId: 97 },
      );
    });
  });

  it("refuses issuer private-key material in the execution-server environment", () => {
    assert.doesNotThrow(() => assertRuntimeVerifierOnlyEnvironment({}));
    assert.throws(() =>
      assertRuntimeVerifierOnlyEnvironment({ RUNTIME_ASSERTION_PRIVATE_KEY: "secret" }),
    );
  });

  it("verifies one exact Ed25519 request and collapses tampering", () => {
    const { pair, config } = cryptoFixture();
    const requestHash = runtimeRequestHash("trade", AGENT_ID, { amount: 1n });
    const claims = createRuntimeAssertionClaims({
      issuer: ISSUER,
      audience: config.audience,
      keyId: KEY_ID,
      agentId: AGENT_ID,
      owner: OWNER_ADDRESS,
      httpRuntimeProfile: "trade-v1",
      operation: "trade",
      requestHash,
      nonce: freshNonce(),
      issuedAt: NOW,
    });
    const header = encodeRuntimeAssertion(claims, pair.privateKey);
    assert.deepEqual(
      verifyRuntimeAssertion({ header, config, operation: "trade", requestHash, nowSec: NOW }),
      claims,
    );
    assert.throws(() =>
      verifyRuntimeAssertion({
        header,
        config,
        operation: "trade",
        requestHash: runtimeRequestHash("trade", AGENT_ID, { amount: 2n }),
        nowSec: NOW,
      }),
    );
    assert.throws(() =>
      verifyRuntimeAssertion({
        header: `${header}=`,
        config,
        operation: "trade",
        requestHash,
        nowSec: NOW,
      }),
    );
  });

  it("accepts exact expiry, then rejects expiry plus one", () => {
    const { pair, config } = cryptoFixture();
    const requestHash = runtimeRequestHash("agentRead", AGENT_ID, {});
    const claims = createRuntimeAssertionClaims({
      issuer: ISSUER,
      audience: config.audience,
      keyId: KEY_ID,
      agentId: AGENT_ID,
      owner: OWNER_ADDRESS,
      httpRuntimeProfile: "unbound-v1",
      operation: "agentRead",
      requestHash,
      issuedAt: NOW,
      expiry: NOW + 60,
    });
    const header = encodeRuntimeAssertion(claims, pair.privateKey);
    assert.doesNotThrow(() =>
      verifyRuntimeAssertion({
        header, config, operation: "agentRead", requestHash, nowSec: NOW + 60,
      }),
    );
    assert.throws(() =>
      verifyRuntimeAssertion({
        header, config, operation: "agentRead", requestHash, nowSec: NOW + 61,
      }),
    );
  });
});

for (const [name, make] of [
  ["memory", async (): Promise<RuntimeReplayStore> => new MemoryRuntimeReplayStore()],
  ["postgres(fake)", async (): Promise<RuntimeReplayStore> =>
    PostgresRuntimeReplayStore.create(new FakeSqlClient())],
] as const) {
  describe(`runtime replay store — ${name}`, () => {
    it("keeps a nonce consumed at exact expiry and prunes only at expiry plus one", async () => {
      const store = await make();
      const replay = { issuer: ISSUER, keyId: KEY_ID, nonce: "nonce", expiry: 10, nowSec: 10 };
      assert.equal(await store.consume(replay), true);
      assert.equal(await store.consume(replay), false);
      assert.equal(await store.consume({ ...replay, nowSec: 11 }), true);
      await store.close();
    });

    it("allows exactly one concurrent consume", async () => {
      const store = await make();
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          store.consume({ issuer: ISSUER, keyId: KEY_ID, nonce: "race", expiry: 20, nowSec: 10 }),
        ),
      );
      assert.equal(results.filter(Boolean).length, 1);
      await store.close();
    });
  });
}

describe("runtime-authenticated HTTP routes", () => {
  it("accepts matching read/trade assertions and refuses bearer-only", async () => {
    const harness = await createHarness();
    const read = await call(harness, `/agents/${AGENT_ID}`);
    assert.equal(read.status, 200, read.text);
    const trade = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(trade.status, 200, trade.text);
    const bearerOnly = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "bearer-only" }),
      noRuntimeAssertion: true,
    });
    assert.equal(bearerOnly.status, 401);
    assert.equal(errorCode(bearerOnly.body), "runtime_auth_failed");
  });

  it("enforces profile isolation without changing LP/Venus owner routes", async () => {
    const lp = await createHarness({ httpRuntimeProfile: "lp-v1" });
    assert.equal((await call(lp, `/agents/${AGENT_ID}`)).status, 200);
    const trade = await call(lp, `/agents/${AGENT_ID}/trade`, {
      method: "POST", body: tradeBody(),
    });
    assert.equal(trade.status, 401);
    assert.equal(lp.provider.executeCalls.length, 0);

    const raw = await createHarness({ httpRuntimeProfile: "raw-v1" });
    const execute = await call(raw, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "raw-1", calls: [{ to: OWNER_ADDRESS, value: "0" }] },
    });
    assert.equal(execute.status, 200, execute.text);
    const rawTrade = await call(raw, `/agents/${AGENT_ID}/trade`, {
      method: "POST", body: tradeBody(),
    });
    assert.equal(rawTrade.status, 401);
  });

  it("returns disabled 503 before parser/store, with raw 404 first", async () => {
    const harness = await createHarness({
      config: { runtimeAuth: { kind: "disabled" }, executeRawEnabled: true },
    });
    harness.agentStore.getAgentById = async () => {
      throw new Error("row access must not happen");
    };
    const trade = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST", body: "not json", noRuntimeAssertion: true,
    });
    assert.equal(trade.status, 503);
    assert.equal(errorCode(trade.body), "runtime_auth_unavailable");

    const rawOff = await createHarness({
      config: { runtimeAuth: { kind: "disabled" }, executeRawEnabled: false },
    });
    const raw = await call(rawOff, `/agents/${AGENT_ID}/execute`, {
      method: "POST", body: "not json", noRuntimeAssertion: true,
    });
    assert.equal(raw.status, 404);
  });

  it("never falls back to the shared bearer when runtime auth is disabled", async () => {
    const harness = await createHarness({
      config: { runtimeAuth: { kind: "disabled" }, executeRawEnabled: true },
    });
    const read = await call(harness, `/agents/${AGENT_ID}`, {
      noRuntimeAssertion: true,
    });
    const trade = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "disabled-must-not-fallback" }),
      noRuntimeAssertion: true,
    });
    const raw = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: {
        decisionId: "disabled-raw-must-not-fallback",
        calls: [{ to: OWNER_ADDRESS, value: "0" }],
      },
      noRuntimeAssertion: true,
    });
    assert.deepEqual([read.status, trade.status, raw.status], [503, 503, 503]);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("fails malformed assertions before row access", async () => {
    const harness = await createHarness();
    harness.agentStore.getAgentById = async () => {
      throw new Error("row access must not happen");
    };
    const response = await call(harness, `/agents/${AGENT_ID}`, {
      runtimeAssertion: "not-base64url!",
    });
    assert.equal(response.status, 401);
  });

  it("consumes replay before the money seam and fails store outages closed", async () => {
    const throwingReplay: RuntimeReplayStore = {
      consume: async () => { throw new Error("database unavailable"); },
      close: async () => {},
    };
    const harness = await createHarness({ runtimeReplayStore: throwingReplay });
    const response = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST", body: tradeBody(),
    });
    assert.equal(response.status, 503);
    assert.equal(errorCode(response.body), "runtime_auth_unavailable");
    assert.equal(harness.provider.executeCalls.length, 0);
    assert.equal(await harness.journal.getByDecision(AGENT_ID, "d-trade-1"), null);
  });

  it("rejects a consumed assertion but permits a fresh nonce for the same decision", async () => {
    const harness = await createHarness();
    const body = tradeBody({ decisionId: "replay-contract" });
    const parsed = parseTradeRequest(body);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("unreachable");
    const assertion = await signRuntimeRequest(
      harness, AGENT_ID, "trade", parsed.value,
    );
    const first = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST", body, runtimeAssertion: assertion,
    });
    assert.equal(first.status, 200);
    const replay = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST", body, runtimeAssertion: assertion,
    });
    assert.equal(replay.status, 401);
    const fresh = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST", body,
    });
    assert.equal(fresh.status, 200);
    assert.equal(harness.provider.executeCalls.length, 1);
  });
});

describe("one-way owner runtime-profile binding", () => {
  it("binds once, retries same-value idempotently, and rejects raw/unbound", async () => {
    const harness = await createHarness({ httpRuntimeProfile: "unbound-v1" });
    const first = await call(harness, `/agents/${AGENT_ID}/runtime-profile`, {
      method: "POST",
      body: await signOwnerAction("bindRuntimeProfile", { profile: "trade-v1" }),
    });
    assert.equal(first.status, 200, first.text);
    assert.equal((await harness.agentStore.getAgentById(AGENT_ID))?.httpRuntimeProfile, "trade-v1");

    const same = await call(harness, `/agents/${AGENT_ID}/runtime-profile`, {
      method: "POST",
      body: await signOwnerAction("bindRuntimeProfile", { profile: "trade-v1" }),
    });
    assert.equal(same.status, 200, same.text);

    for (const profile of ["raw-v1", "unbound-v1", "unknown-v1"]) {
      const invalidHarness = await createHarness({ httpRuntimeProfile: "unbound-v1" });
      const invalid = await call(invalidHarness, `/agents/${AGENT_ID}/runtime-profile`, {
        method: "POST",
        body: await signOwnerAction("bindRuntimeProfile", { profile }),
      });
      assert.equal(invalid.status, 400, profile);
    }
  });

  it("has exactly one winner for racing different profiles", async () => {
    const harness = await createHarness({ httpRuntimeProfile: "unbound-v1" });
    const [trade, lp] = await Promise.all([
      call(harness, `/agents/${AGENT_ID}/runtime-profile`, {
        method: "POST",
        body: await signOwnerAction("bindRuntimeProfile", { profile: "trade-v1" }),
      }),
      call(harness, `/agents/${AGENT_ID}/runtime-profile`, {
        method: "POST",
        body: await signOwnerAction("bindRuntimeProfile", { profile: "lp-v1" }),
      }),
    ]);
    assert.deepEqual([trade.status, lp.status].sort(), [200, 409]);
    const stored = await harness.agentStore.getAgentById(AGENT_ID);
    assert.ok(stored?.httpRuntimeProfile === "trade-v1" || stored?.httpRuntimeProfile === "lp-v1");
  });

  it("is owner scoped", async () => {
    const harness = await createHarness({ httpRuntimeProfile: "unbound-v1" });
    const wrongOwner = getAddress("0x2222222222222222222222222222222222222222");
    const response = await call(harness, `/agents/${AGENT_ID}/runtime-profile`, {
      method: "POST",
      body: await signOwnerAction(
        "bindRuntimeProfile",
        { profile: "trade-v1" },
        { pk: `0x${"22".repeat(32)}`, agentId: AGENT_ID },
      ),
    });
    assert.notEqual(wrongOwner, OWNER_ADDRESS);
    assert.equal(response.status, 404);
  });
});
