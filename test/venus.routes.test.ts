/**
 * PHASE4 — the HTTP surface (`PHASE4-AUDIT.md` A5's routes third,
 * `PHASE4-FIXREVIEW.md` B1/F1's registration half).
 *
 * The fix review's residual B1, verbatim: "nothing drives `createServer` with
 * `deps.venus` present or asserts the 404 with it absent". This file is that
 * test. The two properties that carry the A1 class:
 *
 *   1. WITHOUT `deps.venus`, both routes are 404 — the production default.
 *   2. WITH it, the settings route enforces every validation the spec names
 *      and the owner view answers — so "enabled" and "reachable" are the same
 *      word, which is exactly what the shipped A1 defect made false.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";

import {
  EXEC_TOKEN,
  CHAIN_ID,
  NETWORK,
  NOW_SEC,
  OTHER_OWNER_PK,
  call,
  createHarness,
  errorCode,
  ownerAccount,
  signOwnerAction,
  toReadHeader,
  type Harness,
} from "./support/serverHarness.js";
import { venusSessionSpec } from "../src/ops/policy.js";
import { paramsHash } from "../src/auth/canonical.js";
import { MemoryVenusSettingsStore } from "../src/store/venusSettings.js";
import { MemoryVenusObservationStore } from "../src/store/venusObservations.js";
import { MemoryVenusActionStore } from "../src/store/venusActions.js";
import type { VenusChainReaders } from "../src/venus/readers.js";
import type { VenusServerDeps } from "../src/server.js";
import { E18 } from "../src/venus/risk.js";
import type { VenusAccountReading, VenusMarketReading } from "../src/venus/types.js";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";

const COMPTROLLER = getAddress("0xfd36e2c2a6789db23113685031d7f16329158384");
const PRIME = getAddress("0x059eaba8676b03e4e8f009efb7f587c28450f50f");
const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const V_ETH = getAddress("0xf508fcd89b8bd15579dc79a6827cb4686a3592c8");
const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
const TREASURY = getAddress("0x00000000000000000000000000000000000000fe");
const VENUS_AGENT = "venus-route-agent-1";

function pct(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * E18 + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

describe("account-read bearer boundary on configured Venus routes", () => {
  it("changes neither the signed owner view nor the mutation authorization", async () => {
    const harness = await createHarness({
      venus: venusDeps(),
      config: {
        accountReadSession: {
          key: parseAccountReadSessionSecret("cd".repeat(32))!,
          chainId: CHAIN_ID,
          environment: resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK }),
        },
      },
    });
    await seedVenusAgent(harness);
    const issued = await call(harness, "/owner-read-session", {
      method: "POST",
      body: await signOwnerAction("createAccountReadSession", {}, { agentId: "*" }),
    });
    const token = (issued.body["data"] as { token: string }).token;
    for (const probe of [
      { path: `/agents/${VENUS_AGENT}/venus/owner-view`, options: {} },
      { path: `/agents/${VENUS_AGENT}/venus/settings`, options: { method: "POST" as const, body: {} } },
    ]) {
      const control = await call(harness, probe.path, probe.options);
      const bearer = await call(harness, probe.path, { ...probe.options, headers: { authorization: `Bearer ${token}` } });
      assert.equal(bearer.status, control.status);
      assert.equal(bearer.text, control.text);
    }
    assert.equal(harness.provider.executeCalls.length, 0);
  });
});

function market(overrides: Partial<VenusMarketReading> = {}): VenusMarketReading {
  return {
    vToken: V_BNB,
    vTokenSymbol: "vBNB",
    vTokenDecimals: 8,
    underlying: null,
    underlyingDecimals: 18,
    native: true,
    listed: true,
    borrowAllowed: true,
    collateralMember: true,
    vTokenBalance: 8n * E18,
    borrowStored: 0n,
    exchangeRateStored: 220_000_000_000_000_000n,
    borrowCurrent: 0n,
    exchangeRateCurrent: 220_000_000_000_000_000n,
    effectiveCf: pct("0.8"),
    effectiveLt: pct("0.8"),
    spotPrice: pct("600"),
    boundedCollateralPrice: pct("600"),
    boundedDebtPrice: pct("600"),
    mintPaused: false,
    repayPaused: false,
    supplyHeadroom: 10n ** 24n,
    walletBalance: 10n ** 18n,
    allowance: 0n,
    ...overrides,
  } as VenusMarketReading;
}

function reading(): VenusAccountReading {
  const w = pct("844.8");
  const d = pct("700");
  return {
    blockNumber: 117_741_526n,
    blockHash: `0x${"d6".repeat(32)}` as Hex,
    owner: ownerAccount.address,
    protocolPaused: false,
    userPoolId: 0n,
    lastPoolId: 15n,
    vaiDebt: 0n,
    accountLiquidity: [0n, w - d, 0n],
    borrowingPower: [0n, w - d, 0n],
    markets: [
      market(),
      market({
        vToken: V_USDT,
        vTokenSymbol: "vUSDT",
        underlying: USDT,
        native: false,
        collateralMember: false,
        vTokenBalance: 0n,
        borrowStored: 700n * E18,
        borrowCurrent: 700n * E18,
        exchangeRateStored: E18,
        exchangeRateCurrent: E18,
        spotPrice: pct("1"),
        boundedCollateralPrice: pct("1"),
        boundedDebtPrice: pct("1"),
        walletBalance: 500n * E18,
      }),
    ],
    snapshotErrorMarket: null,
  };
}

function fakeReaders(): VenusChainReaders {
  return {
    readAccount: async () => reading(),
  } as unknown as VenusChainReaders;
}

function venusDeps(): VenusServerDeps {
  return {
    settingsStore: new MemoryVenusSettingsStore(),
    observations: new MemoryVenusObservationStore(),
    actions: new MemoryVenusActionStore(() => NOW_SEC * 1000),
    readers: fakeReaders(),
    venue: {
      comptroller: COMPTROLLER,
      prime: PRIME,
      vBnb: V_BNB,
      treasury: TREASURY,
    } as VenusServerDeps["venue"],
    intervalMs: 30_000,
    maxObservationAgeMs: 90_000,
    marketIndex: {
      [V_BNB.toLowerCase()]: { underlying: null },
      [V_USDT.toLowerCase()]: { underlying: USDT },
    },
  };
}

/** A venus-shaped agent under the harness's default owner. */
async function seedVenusAgent(harness: Harness): Promise<void> {
  const spec = venusSessionSpec({
    comptroller: COMPTROLLER,
    prime: PRIME,
    vBnb: V_BNB,
    vTokens: [V_USDT],
    tokens: [{ token: USDT, vToken: V_USDT, dailyCapWei: 20n * E18 }],
    treasury: TREASURY,
    nativeCaps: [{ limit: 10n ** 16n, period: "day" }],
    expiresAt: NOW_SEC + 6 * 24 * 3600,
    nowSeconds: NOW_SEC,
  });
  await harness.agentStore.createAgent({
    id: VENUS_AGENT,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: {
      spec,
      permissions: { calls: [], spend: [] },
      publicKey: `0x04${"ab".repeat(64)}` as Hex,
      expiry: NOW_SEC + 6 * 24 * 3600,
    } as never,
  });
}

function settingsParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    triggerHf: pct("1.3").toString(),
    targetHf: pct("1.8").toString(),
    debtMarkets: [V_USDT],
    // REVISION 4: vBNB in collateralMarkets is a 400 (`native-collateral-
    // trapped`) — pinned by its own test below; the shared fixture names an
    // ERC-20 market instead.
    collateralMarkets: [V_USDT],
    maxPerAction: [
      { token: USDT, maxWei: (5n * E18).toString() },
      { token: null, maxWei: (10n ** 15n).toString() },
    ],
    maxClaimsPerDay: 4,
    minSecondsBetweenActions: 300,
    minClaimValueWei: "0",
    claimEnabled: false,
    claimRepayEnabled: false,
    rescueReserveCount: 4,
    ...overrides,
  };
}

async function postSettings(
  harness: Harness,
  params: unknown,
  options: { readonly agentId?: string; readonly pk?: Hex } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope = await signOwnerAction("venusSettings", params, {
    agentId: options.agentId ?? VENUS_AGENT,
    ...(options.pk === undefined ? {} : { pk: options.pk }),
  });
  return call(harness, `/agents/${options.agentId ?? VENUS_AGENT}/venus/settings`, {
    method: "POST",
    body: envelope,
  });
}

describe("venus routes: absent deps mean 404 — the A1 class, pinned at the HTTP layer", () => {
  it("both routes 404 when createServer is not handed deps.venus", async () => {
    const harness = await createHarness();
    await seedVenusAgent(harness);
    const post = await postSettings(harness, settingsParams());
    assert.equal(post.status, 404);
    const envelope = await signOwnerAction("read", {}, { agentId: VENUS_AGENT });
    const view = await call(harness, `/agents/${VENUS_AGENT}/venus/owner-view`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(view.status, 404);
  });
});

describe("venus routes: the settings write", () => {
  it("accepts a valid owner-signed write, returns the digest, and issues the tracking PUT post-commit", async () => {
    const venus = venusDeps();
    const harness = await createHarness({ venus });
    await seedVenusAgent(harness);
    const response = await postSettings(harness, settingsParams());
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.match(String(data["digest"]), /^0x[0-9a-f]{64}$/u);
    // R3.9: the tracking PUT is issued AFTER the journaled act commits, through
    // the harness's fake data plane, and its outcome rides the meta.
    const meta = response.body["meta"] as Record<string, unknown>;
    assert.equal(meta["tracking"], "ok");
    assert.ok(
      harness.dataPlane.requested.some((entry: string) =>
        entry.startsWith("PUT internal/venus/core/tracked-owners/"),
      ),
      "the settings route did not issue the tracking PUT",
    );
    // And the row is READABLE back through the store the worker reads.
    const row = await venus.settingsStore.get(ownerAccount.address, VENUS_AGENT);
    assert.notEqual(row, null);
  });

  it("REVISION 4 — vBNB in collateralMarkets is refused with the trap condition and the vWBNB remedy", async () => {
    const harness = await createHarness({ venus: venusDeps() });
    await seedVenusAgent(harness);
    const response = await postSettings(
      harness,
      settingsParams({ collateralMarkets: [V_BNB] }),
    );
    assert.equal(response.status, 400);
    const body = JSON.stringify(response.body);
    assert.match(body, /native-collateral-trapped/u);
    assert.match(body, /0x6bCa74586218db34cDB402295796b79663d816e9/u);
    // And vBNB in debtMarkets ALONE stays accepted — native repay is safe (V8).
    const debtOnly = await postSettings(
      harness,
      settingsParams({ debtMarkets: [V_USDT, V_BNB] }),
    );
    assert.equal(debtOnly.status, 200, JSON.stringify(debtOnly.body).slice(0, 200));
  });

  it("refuses a market the session grant does not name — the EARLY WARNING, with its honest text", async () => {
    const harness = await createHarness({ venus: venusDeps() });
    await seedVenusAgent(harness);
    const response = await postSettings(
      harness,
      settingsParams({ debtMarkets: [V_ETH] }),
    );
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(response.body), /EARLY WARNING/u);
  });

  it("refuses a named market with NO maxPerAction ceiling — a missing ceiling is never unlimited (R2.1)", async () => {
    const harness = await createHarness({ venus: venusDeps() });
    await seedVenusAgent(harness);
    const response = await postSettings(
      harness,
      settingsParams({ maxPerAction: [{ token: null, maxWei: (10n ** 15n).toString() }] }),
    );
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(response.body), /ceiling/u);
  });

  it("refuses targetHf <= triggerHf and malformed params at the parser", async () => {
    const harness = await createHarness({ venus: venusDeps() });
    await seedVenusAgent(harness);
    for (const bad of [
      settingsParams({ targetHf: pct("1.2").toString() }), // target below trigger
      settingsParams({ triggerHf: pct("0.9").toString() }), // trigger below 1.0
      { nonsense: true },
    ]) {
      const response = await postSettings(harness, bad);
      assert.equal(response.status, 400, JSON.stringify(response.body).slice(0, 200));
    }
  });

  it("refuses another owner's signature over this agent — tenancy comes from the row", async () => {
    const harness = await createHarness({ venus: venusDeps() });
    await seedVenusAgent(harness);
    const response = await postSettings(harness, settingsParams(), {
      pk: OTHER_OWNER_PK,
    });
    // The row's owner is authoritative; a valid signature from the WRONG owner
    // is an authorization failure, never a write.
    assert.ok(response.status === 401 || response.status === 403 || response.status === 404);
  });

  it("refuses without the exec token — no Venus surface is reachable without the service credential", async () => {
    const harness = await createHarness({ venus: venusDeps() });
    await seedVenusAgent(harness);
    const envelope = await signOwnerAction("venusSettings", settingsParams(), {
      agentId: VENUS_AGENT,
    });
    const response = await call(harness, `/agents/${VENUS_AGENT}/venus/settings`, {
      method: "POST",
      body: envelope,
      noExecToken: true,
    });
    assert.equal(response.status, 401);
  });

  it("a data-plane tracking FAILURE does not fail the settings write (R3.9: post-commit, best-effort)", async () => {
    const venus = venusDeps();
    const harness = await createHarness({ venus });
    await seedVenusAgent(harness);
    harness.dataPlane.venusTrackingError = new Error("data plane down");
    const response = await postSettings(harness, settingsParams());
    // The write COMMITTED; only the tracking outcome differs.
    assert.equal(response.status, 200);
    const row = await venus.settingsStore.get(ownerAccount.address, VENUS_AGENT);
    assert.notEqual(row, null);
  });
});

describe("venus routes: the owner view", () => {
  it("M4 killer — a STALE pre-R4 settings row alone fires the trap condition, at ZERO vBNB balance", async () => {
    // The build verification's surviving mutation M4: drop the
    // `|| staleNativeSettings` half of the view condition and the suite stayed
    // green. This is that half, isolated: the row is seeded DIRECTLY in the
    // store (exactly how a pre-R4 row exists — the post-R4 route refuses this
    // shape), the digest verifies, and the reading's native market holds ZERO
    // vTokens, so ONLY the stale-settings half can fire.
    const venus = venusDeps();
    // Zero out the native balance in the reading this harness serves.
    const zeroed = reading();
    const zeroNative = {
      ...zeroed,
      markets: zeroed.markets.map((m) => (m.native ? { ...m, vTokenBalance: 0n } : m)),
    };
    (venus as { readers: unknown }).readers = {
      readAccount: async () => zeroNative,
    } as never;
    const harness = await createHarness({ venus });
    await seedVenusAgent(harness);
    const staleParams = settingsParams({ collateralMarkets: [V_BNB] });
    await venus.settingsStore.put({
      agentId: VENUS_AGENT,
      ownerAddress: ownerAccount.address,
      params: staleParams,
      digest: paramsHash("venusSettings", staleParams),
    });
    const envelope = await signOwnerAction("read", {}, { agentId: VENUS_AGENT });
    const view = await call(harness, `/agents/${VENUS_AGENT}/venus/owner-view`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(view.status, 200);
    const conditions = (view.body["data"] as Record<string, unknown>)["conditions"] as {
      condition: string;
      detail: string;
    }[];
    const trap = conditions.find((entry) => entry.condition === "native-collateral-trapped");
    assert.notEqual(trap, undefined, JSON.stringify(conditions));
    assert.match(trap?.detail ?? "", /stored settings still name vBNB/u);
    // And the BALANCE half did not contribute — the detail must not claim a holding.
    assert.ok(!/This account holds/u.test(trap?.detail ?? ""));
  });

  it("answers the signed read with the honest surface, and refuses an unsigned one", async () => {
    const harness = await createHarness({ venus: venusDeps() });
    await seedVenusAgent(harness);
    await postSettings(harness, settingsParams());

    const unsigned = await call(harness, `/agents/${VENUS_AGENT}/venus/owner-view`);
    assert.ok(unsigned.status === 400 || unsigned.status === 401);

    const envelope = await signOwnerAction("read", {}, { agentId: VENUS_AGENT });
    const view = await call(harness, `/agents/${VENUS_AGENT}/venus/owner-view`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(view.status, 200);
    const data = view.body["data"] as Record<string, unknown>;
    assert.equal(data["settingsDigestVerified"], true);
    const budgets = data["budgets"] as Record<string, unknown>;
    // The R3.3/A4 sentence, pinned where the UI reads it: these fields are
    // STATEMENTS ABOUT BEHAVIOUR, and venus.worker.test.ts proves the
    // behaviour, so together the sentence stays true.
    assert.equal(budgets["rescuesGatedByAgentCaps"], false);
    assert.equal(budgets["claimsGatedByAgentCaps"], true);
    const chain = data["chain"] as Record<string, unknown>;
    const liquidation = chain["liquidation"] as Record<string, unknown>;
    assert.equal(liquidation["matchesProtocol"], true);
  });

  it("another owner's signed read gets no view — cross-tenant answer is absence", async () => {
    const harness = await createHarness({ venus: venusDeps() });
    await seedVenusAgent(harness);
    const envelope = await signOwnerAction("read", {}, {
      agentId: VENUS_AGENT,
      pk: OTHER_OWNER_PK,
    });
    const view = await call(harness, `/agents/${VENUS_AGENT}/venus/owner-view`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.ok(view.status === 401 || view.status === 403 || view.status === 404);
  });

  it("the exec token alone reaches NOTHING — the network-posture invariant, per route", async () => {
    // A leaked x-exec-token must not read an owner's Venus position or write
    // settings. Both routes demand the owner signature ON TOP of the service
    // credential; this is the zero-exec-token-routes claim, tested rather than
    // asserted.
    const harness = await createHarness({ venus: venusDeps() });
    await seedVenusAgent(harness);
    const bareView = await call(harness, `/agents/${VENUS_AGENT}/venus/owner-view`, {
      execToken: EXEC_TOKEN,
    });
    assert.notEqual(bareView.status, 200);
    const barePost = await call(harness, `/agents/${VENUS_AGENT}/venus/settings`, {
      method: "POST",
      body: settingsParams(),
      execToken: EXEC_TOKEN,
    });
    assert.notEqual(barePost.status, 200);
  });

  it("an unknown agent id under a valid signature is 404, not a probe oracle", async () => {
    const harness = await createHarness({ venus: venusDeps() });
    const envelope = await signOwnerAction("read", {}, { agentId: "no-such-agent" });
    const view = await call(harness, `/agents/no-such-agent/venus/owner-view`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(view.status, 404);
    assert.notEqual(errorCode(view.body), undefined);
  });
});
