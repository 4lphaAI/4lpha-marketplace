/**
 * Independent Phase 1.6 implementation audit.
 *
 * These tests attack the new boundary from outside its implementation. They
 * are auditor-owned: fixes must change production code or non-auditor fixtures,
 * never weaken these assertions.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  createRuntimeAssertionClaims,
  encodeRuntimeAssertion,
  resolveRuntimeAuthConfig,
  runtimeRequestHash,
  verifyRuntimeAssertion,
} from "../src/auth/runtimeAuth.js";
import { parseTradeRequest } from "../src/http/wire.js";
import { PostgresAgentStore } from "../src/store/agents.js";
import { PostgresRuntimeReplayStore } from "../src/store/runtimeReplays.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import {
  AGENT_ID,
  HOP,
  HOP_2,
  NOW_SEC,
  OWNER_ADDRESS,
  OTHER_AGENT_ID,
  TARGET,
  call,
  createHarness,
  errorCode,
  freshNonce,
  sessionFacts,
  signRuntimeRequest,
  tradeBody,
} from "./support/serverHarness.js";
import {
  PASSKEY_CONFIG,
  createTestPasskey,
  signPasskeyOwnerAction,
} from "./support/passkey.js";

describe("AUDIT Phase 1.6: the shared bearer grants no autonomous route", () => {
  it("refuses bearer-only read, trade, and enabled raw execute before money", async () => {
    const tradeHarness = await createHarness();
    const read = await call(tradeHarness, `/agents/${AGENT_ID}`, {
      noRuntimeAssertion: true,
    });
    const trade = await call(tradeHarness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
      noRuntimeAssertion: true,
    });
    assert.deepEqual(
      [read.status, trade.status],
      [401, 401],
    );
    assert.equal(errorCode(read.body), "runtime_auth_failed");
    assert.equal(errorCode(trade.body), "runtime_auth_failed");
    assert.equal(tradeHarness.provider.executeCalls.length, 0);

    const rawHarness = await createHarness({ httpRuntimeProfile: "raw-v1" });
    const raw = await call(rawHarness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "audit-bearer-raw", calls: [{ to: TARGET, value: "1" }] },
      noRuntimeAssertion: true,
    });
    assert.equal(raw.status, 401);
    assert.equal(errorCode(raw.body), "runtime_auth_failed");
    assert.equal(rawHarness.provider.executeCalls.length, 0);
  });

  it("does not consume a nonce on row binding failure", async () => {
    const harness = await createHarness();
    const nonce = freshNonce();
    const wrongOwner = getAddress("0x3333333333333333333333333333333333333333");
    const rejected = await call(harness, `/agents/${AGENT_ID}`, {
      runtimeAssertion: await signRuntimeRequest(
        harness,
        AGENT_ID,
        "agentRead",
        {},
        { nonce, owner: wrongOwner },
      ),
    });
    assert.equal(rejected.status, 401);
    assert.equal(errorCode(rejected.body), "runtime_auth_failed");

    const accepted = await call(harness, `/agents/${AGENT_ID}`, {
      runtimeAssertion: await signRuntimeRequest(
        harness,
        AGENT_ID,
        "agentRead",
        {},
        { nonce },
      ),
    });
    assert.equal(accepted.status, 200, accepted.text);
  });

  it("cannot move an assertion across agents, including a same-owner row", async () => {
    const harness = await createHarness();
    const sameOwnerAgent = "same-owner-agent";
    await harness.agentStore.createAgent({
      id: sameOwnerAgent,
      ownerAddress: OWNER_ADDRESS,
      walletAddress: OWNER_ADDRESS,
      custodyModel: "self-eoa",
      sessionFacts: sessionFacts(NOW_SEC + 3_600),
      status: "armed",
      httpRuntimeProfile: "trade-v1",
    });

    const forA = await signRuntimeRequest(harness, AGENT_ID, "agentRead", {});
    for (const target of [sameOwnerAgent, OTHER_AGENT_ID]) {
      const response = await call(harness, `/agents/${target}`, {
        runtimeAssertion: forA,
      });
      assert.equal(response.status, 401, target);
      assert.equal(errorCode(response.body), "runtime_auth_failed");
    }
  });

  it("checks agent, profile, and operation claims independently", async () => {
    const harness = await createHarness();
    const other = await harness.agentStore.getAgentById(OTHER_AGENT_ID);
    assert.notEqual(other, null);

    const readHash = runtimeRequestHash("agentRead", OTHER_AGENT_ID, {});
    const mismatchedAgent = createRuntimeAssertionClaims({
      issuer: harness.runtimeIssuer,
      audience: harness.runtimeAudience,
      keyId: harness.runtimeKeyId,
      agentId: AGENT_ID,
      owner: other!.ownerAddress,
      httpRuntimeProfile: other!.httpRuntimeProfile,
      operation: "agentRead",
      requestHash: readHash,
      issuedAt: harness.nowSec(),
    });
    const wrongAgent = await call(harness, `/agents/${OTHER_AGENT_ID}`, {
      runtimeAssertion: encodeRuntimeAssertion(
        mismatchedAgent,
        harness.runtimePrivateKey,
      ),
    });
    assert.equal(wrongAgent.status, 401);

    const mismatchedProfile = createRuntimeAssertionClaims({
      issuer: harness.runtimeIssuer,
      audience: harness.runtimeAudience,
      keyId: harness.runtimeKeyId,
      agentId: OTHER_AGENT_ID,
      owner: other!.ownerAddress,
      httpRuntimeProfile: "lp-v1",
      operation: "agentRead",
      requestHash: readHash,
      issuedAt: harness.nowSec(),
    });
    const wrongProfile = await call(harness, `/agents/${OTHER_AGENT_ID}`, {
      runtimeAssertion: encodeRuntimeAssertion(
        mismatchedProfile,
        harness.runtimePrivateKey,
      ),
    });
    assert.equal(wrongProfile.status, 401);

    const tradeWire = tradeBody({ decisionId: "audit-operation-claim" });
    const tradeParsed = parseTradeRequest(tradeWire);
    assert.equal(tradeParsed.ok, true);
    if (!tradeParsed.ok) throw new Error("unreachable");
    const mismatchedOperation = createRuntimeAssertionClaims({
      issuer: harness.runtimeIssuer,
      audience: harness.runtimeAudience,
      keyId: harness.runtimeKeyId,
      agentId: AGENT_ID,
      owner: OWNER_ADDRESS,
      httpRuntimeProfile: "trade-v1",
      operation: "agentRead",
      requestHash: runtimeRequestHash("trade", AGENT_ID, tradeParsed.value),
      issuedAt: harness.nowSec(),
    });
    const wrongOperation = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeWire,
      runtimeAssertion: encodeRuntimeAssertion(
        mismatchedOperation,
        harness.runtimePrivateKey,
      ),
    });
    assert.equal(wrongOperation.status, 401);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("collapses malformed, forged, key, environment, and time failures", async () => {
    const harness = await createHarness();
    const forged = generateKeyPairSync("ed25519");
    const nonce = freshNonce();
    const valid = await signRuntimeRequest(
      harness,
      AGENT_ID,
      "agentRead",
      {},
      { nonce },
    );
    const candidates = [
      "not-base64url!",
      "A".repeat(4_097),
      `${valid}=`,
      await signRuntimeRequest(harness, AGENT_ID, "agentRead", {}, {
        nonce,
        privateKey: forged.privateKey,
      }),
      await signRuntimeRequest(harness, AGENT_ID, "agentRead", {}, {
        nonce,
        keyId: "removed-key",
      }),
      await signRuntimeRequest(harness, AGENT_ID, "agentRead", {}, {
        nonce,
        issuer: "wrong-issuer",
      }),
      await signRuntimeRequest(harness, AGENT_ID, "agentRead", {}, {
        nonce,
        audience: "wrong-audience",
      }),
      await signRuntimeRequest(harness, AGENT_ID, "agentRead", {}, {
        nonce,
        issuedAt: harness.nowSec() + 6,
      }),
      await signRuntimeRequest(harness, AGENT_ID, "agentRead", {}, {
        nonce,
        issuedAt: harness.nowSec() - 60,
        expiry: harness.nowSec() - 1,
      }),
      await signRuntimeRequest(harness, AGENT_ID, "agentRead", {}, {
        nonce,
        expiry: harness.nowSec() + 61,
      }),
    ];
    let genericBody: string | undefined;
    for (const runtimeAssertion of candidates) {
      const response = await call(harness, `/agents/${AGENT_ID}`, {
        runtimeAssertion,
      });
      assert.equal(response.status, 401);
      assert.equal(errorCode(response.body), "runtime_auth_failed");
      genericBody ??= response.text;
      assert.equal(response.text, genericBody);
    }

    const accepted = await call(harness, `/agents/${AGENT_ID}`, {
      runtimeAssertion: valid,
    });
    assert.equal(
      accepted.status,
      200,
      "no failed crypto/time/environment check may consume the nonce",
    );
  });
});

describe("AUDIT Phase 1.6: every parsed money field is request-bound", () => {
  it("rejects changes to every scalar trade field before journal/provider", async () => {
    const harness = await createHarness();
    const original = tradeBody({ decisionId: "audit-bound-scalars" });
    const parsed = parseTradeRequest(original);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("unreachable");
    const assertion = await signRuntimeRequest(
      harness,
      AGENT_ID,
      "trade",
      parsed.value,
    );
    const changes: readonly Record<string, unknown>[] = [
      { decisionId: "audit-bound-scalars-2" },
      { venue: "fourmeme" },
      { side: "sell" },
      { token: TARGET },
      { amountWei: "2" },
      { minOutWei: "989" },
      { quotedOutWei: "1001" },
    ];
    for (const change of changes) {
      const response = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: { ...original, ...change },
        runtimeAssertion: assertion,
      });
      assert.equal(response.status, 401, JSON.stringify(change));
      assert.equal(errorCode(response.body), "runtime_auth_failed");
    }
    assert.equal(harness.provider.executeCalls.length, 0);
    assert.equal(
      await harness.journal.getByDecision(AGENT_ID, "audit-bound-scalars"),
      null,
    );
  });

  it("binds V3 hops and every fee tier", async () => {
    const harness = await createHarness();
    const original = tradeBody({
      decisionId: "audit-bound-route",
      venue: "pancake_v3",
      route: { hops: [HOP], fees: [100, 500] },
    });
    const parsed = parseTradeRequest(original);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("unreachable");
    const assertion = await signRuntimeRequest(
      harness,
      AGENT_ID,
      "trade",
      parsed.value,
    );
    for (const route of [
      { hops: [HOP_2], fees: [100, 500] },
      { hops: [HOP], fees: [100, 2500] },
    ]) {
      const response = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: { ...original, route },
        runtimeAssertion: assertion,
      });
      assert.equal(response.status, 401, JSON.stringify(route));
    }
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("keeps bypassLocalPolicyCheck unreachable on an authorized raw profile", async () => {
    const harness = await createHarness({ httpRuntimeProfile: "raw-v1" });
    const response = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: {
        decisionId: "audit-bypass-nonvacuous",
        calls: [{ to: TARGET, value: "1" }],
        bypassLocalPolicyCheck: true,
      },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(harness.provider.executeCalls.length, 1);
    assert.equal(harness.provider.executeCalls[0]?.bypassLocalPolicyCheck, false);
  });
});

describe("AUDIT Phase 1.6: durable replay failure atomicity", () => {
  it("rolls prune back when insert fails and survives a fresh store instance", async () => {
    const sql = new FakeSqlClient();
    const first = await PostgresRuntimeReplayStore.create(sql);
    const replay = {
      issuer: "audit-runtime",
      keyId: "audit-key",
      nonce: "audit-nonce",
      expiry: 10,
      nowSec: 10,
    };
    assert.equal(await first.consume(replay), true);

    sql.failNextQuery("runtimeReplays.consume");
    await assert.rejects(
      first.consume({ ...replay, nonce: "insert-fails", expiry: 20, nowSec: 11 }),
    );

    const restarted = await PostgresRuntimeReplayStore.create(sql);
    assert.equal(
      await restarted.consume(replay),
      false,
      "the expiry-10 row pruned inside the failed transaction must have rolled back",
    );
    await restarted.close();
  });

  it("gives exactly one winner to racing PostgreSQL profile binds", async () => {
    const sql = new FakeSqlClient();
    const store = await PostgresAgentStore.create(sql, null, () => NOW_SEC * 1_000);
    await store.createAgent({
      id: "audit-pg-bind",
      ownerAddress: OWNER_ADDRESS,
      walletAddress: OWNER_ADDRESS,
      custodyModel: "self-eoa",
    });
    const results = await Promise.all([
      store.bindHttpRuntimeProfile(OWNER_ADDRESS, "audit-pg-bind", "trade-v1"),
      store.bindHttpRuntimeProfile(OWNER_ADDRESS, "audit-pg-bind", "lp-v1"),
    ]);
    assert.deepEqual(
      results.map((result) => result.kind).sort(),
      ["conflict", "updated"],
    );
    await store.close();
  });
});

describe("AUDIT Phase 1.6: passkey and key-isolation seams", () => {
  it("lets a real passkey owner bind and render the one-way HTTP profile", async () => {
    const harness = await createHarness({ config: { passkey: PASSKEY_CONFIG } });
    const passkey = await createTestPasskey();
    const agentId = "audit-passkey-runtime-profile";
    await harness.agentStore.createAgent({
      id: agentId,
      ownerAddress: passkey.ownerAddress,
      walletAddress: OWNER_ADDRESS,
      custodyModel: "passkey",
      sessionFacts: sessionFacts(NOW_SEC + 3_600),
      status: "armed",
    });
    const params = { profile: "trade-v1" };
    const signed = await signPasskeyOwnerAction(
      passkey,
      "bindRuntimeProfile",
      params,
      { agentId },
    );
    const response = await call(harness, `/agents/${agentId}/runtime-profile`, {
      method: "POST",
      body: { signed: signed.signed, signature: signed.signature, params },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(
      (await harness.agentStore.getAgentById(agentId))?.httpRuntimeProfile,
      "trade-v1",
    );
  });

  it("accepts either configured rotation key and rejects an unconfigured key", () => {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const raw = (key: typeof first.publicKey): string =>
      (key.export({ format: "der", type: "spki" }) as Buffer)
        .subarray(-32)
        .toString("base64url");
    const config = resolveRuntimeAuthConfig(
      {
        RUNTIME_ASSERTION_ISSUER: "audit-rotation",
        RUNTIME_ASSERTION_PUBLIC_KEYS_JSON: JSON.stringify({
          first: raw(first.publicKey),
          second: raw(second.publicKey),
        }),
      },
      { chainId: 97, envSalt: "audit-rotation-salt" },
    );
    assert.equal(config.kind, "enabled");
    if (config.kind !== "enabled") throw new Error("unreachable");
    for (const [keyId, privateKey] of [
      ["first", first.privateKey],
      ["second", second.privateKey],
    ] as const) {
      const claims = createRuntimeAssertionClaims({
        issuer: config.issuer,
        audience: config.audience,
        keyId,
        agentId: AGENT_ID,
        owner: OWNER_ADDRESS,
        httpRuntimeProfile: "trade-v1",
        operation: "agentRead",
        requestHash: runtimeRequestHash("agentRead", AGENT_ID, {}),
        issuedAt: NOW_SEC,
      });
      const header = encodeRuntimeAssertion(claims, privateKey);
      assert.doesNotThrow(() =>
        verifyRuntimeAssertion({
          header,
          config,
          operation: "agentRead",
          requestHash: claims.requestHash,
          nowSec: NOW_SEC,
        }),
      );
    }

    const removedClaims = createRuntimeAssertionClaims({
      issuer: config.issuer,
      audience: config.audience,
      keyId: "removed",
      agentId: AGENT_ID,
      owner: OWNER_ADDRESS,
      httpRuntimeProfile: "trade-v1",
      operation: "agentRead",
      requestHash: runtimeRequestHash("agentRead", AGENT_ID, {}),
      issuedAt: NOW_SEC,
    });
    assert.throws(() =>
      verifyRuntimeAssertion({
        header: encodeRuntimeAssertion(removedClaims, first.privateKey),
        config,
        operation: "agentRead",
        requestHash: removedClaims.requestHash,
        nowSec: NOW_SEC,
      }),
    );
  });

  it("requires the verifier-only environment guard in every execution-server entry", () => {
    const production = readFileSync("src/index-server.ts", "utf8");
    const devStack = readFileSync("scripts/dev-stack.ts", "utf8");
    assert.match(production, /assertRuntimeVerifierOnlyEnvironment\(process\.env\)/);
    assert.match(
      devStack,
      /assertRuntimeVerifierOnlyEnvironment\(process\.env\)/,
      "dev-stack serves the execution plane and must not retain the global issuer private key",
    );
  });

  it("pins every ordinary creation seam to its reviewed HTTP profile", () => {
    const expected = [
      ["scripts/provision-agent.ts", "trade-v1"],
      ["scripts/dev-stack.ts", "trade-v1"],
      ["scripts/register-passkey-agent.ts", "trade-v1"],
      ["scripts/live-lp.ts", "lp-v1"],
      ["scripts/provision-venus-agent.ts", "venus-v1"],
    ] as const;
    for (const [path, profile] of expected) {
      const source = readFileSync(path, "utf8");
      assert.match(
        source,
        new RegExp(`createAgent\\(\\{[\\s\\S]{0,300}httpRuntimeProfile: "${profile}"`),
        path,
      );
    }
  });
});
