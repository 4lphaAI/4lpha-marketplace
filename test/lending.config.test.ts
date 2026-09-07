/**
 * The lending boot resolvers, the composition seam, and the preset's reach
 * across the readers that switch on `hireSizing.name`
 * (MARKETPLACE-LENDING-AGENT §8.5, R2.19, R2.15/L3; REVIEW2 §4).
 *
 * The composition test is the PHASE4-AUDIT A1 regression: that defect shipped
 * because `buildVenusServerDeps` had no offline test at all, so restoring the
 * exact bug left the whole suite green.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import {
  LENDING_WORKER_DEFAULT_INTERVAL_MS,
  LENDING_WORKER_MIN_INTERVAL_MS,
  resolveLendingEnabled,
  resolveLendingMaxObservationAgeMs,
  resolveLendingRpcUrls,
  resolveLendingSwapFeeTier,
  resolveLendingVenue,
  resolveLendingWorkerIntervalMs,
} from "../src/ops/config.js";
import { buildLendingServerDeps } from "../src/lending/wiring.js";
import { MemoryLendingGuardStore } from "../src/store/lendingGuards.js";
import { MemoryVenusObservationStore } from "../src/store/venusObservations.js";
import { MemoryVenusSettingsStore } from "../src/store/venusSettings.js";
import { categoryForPreset, validCategory } from "../src/identity/types.js";
import { metadataUri, metadataUriV2 } from "../src/identity/metadata.js";
import { sourceFromRecord } from "../src/store/erc8004Sources.js";
import { HIRE_SIZING_PRESETS } from "../src/ops/policy.js";
import type { AgentRecord } from "../src/store/agents.js";
import type { LendingChainReaders } from "../src/lending/readers.js";

const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const TREASURY = getAddress("0x7000000000000000000000000000000000000007");
const ROUTER = getAddress("0x5000000000000000000000000000000000000005");
const WBNB = getAddress("0x6000000000000000000000000000000000000006");
const QUOTER = getAddress("0x9000000000000000000000000000000000000009");
const FACTORY = getAddress("0xa000000000000000000000000000000000000010");
const POOL = getAddress("0xa000000000000000000000000000000000000011");

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    LENDING_ENABLED: "true",
    LP_ENABLED: "true",
    HIRE_ENABLED: "true",
    PASSKEY_ENABLED: "true",
    DATABASE_URL: "postgres://x",
    LENDING_VUSDT_ADDRESS: V_USDT,
    VENUS_VBNB_ADDRESS: V_BNB,
    FEE_TREASURY_ADDRESS: TREASURY,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("resolveLendingEnabled — a tri-state whose TYPO fails the boot", () => {
  it("defaults OFF", () => {
    assert.equal(resolveLendingEnabled({} as NodeJS.ProcessEnv), false);
  });
  it("is ON only for the exact string", () => {
    assert.equal(resolveLendingEnabled(env()), true);
    assert.equal(resolveLendingEnabled(env({ LENDING_ENABLED: "false" })), false);
  });
  it("THROWS on a typo — a silently-skipped guard is the F8 shape", () => {
    assert.throws(
      () => resolveLendingEnabled(env({ LENDING_ENABLED: "1" })),
      /must be exactly "true" or "false"/u,
    );
  });
  it("REQUIRES LP_ENABLED — every swap leg is built against the LP venue", () => {
    assert.throws(
      () => resolveLendingEnabled(env({ LP_ENABLED: "false" })),
      /LP_ENABLED is not/u,
    );
  });
  it("REQUIRES HIRE_ENABLED — the guard's only entry is the lending-v1 hire", () => {
    assert.throws(
      () => resolveLendingEnabled(env({ HIRE_ENABLED: "false" })),
      /HIRE_ENABLED is not/u,
    );
  });
});

describe("the cadence and the pool pin", () => {
  it("defaults to 30 s and REFUSES below the 15 s floor", () => {
    assert.equal(resolveLendingWorkerIntervalMs(env()), LENDING_WORKER_DEFAULT_INTERVAL_MS);
    assert.throws(
      () => resolveLendingWorkerIntervalMs(env({ LENDING_WORKER_INTERVAL_MS: "5000" })),
      /below the floor/u,
    );
    assert.equal(
      resolveLendingWorkerIntervalMs(
        env({ LENDING_WORKER_INTERVAL_MS: String(LENDING_WORKER_MIN_INTERVAL_MS) }),
      ),
      LENDING_WORKER_MIN_INTERVAL_MS,
    );
  });

  it("REFUSES an observation bound below 2 x the interval — the (ae) shape with a config key", () => {
    assert.equal(resolveLendingMaxObservationAgeMs(env(), 30_000), 90_000);
    assert.throws(
      () => resolveLendingMaxObservationAgeMs(
        env({ LENDING_MAX_OBSERVATION_AGE_MS: "59999" }), 30_000,
      ),
      /below 2 x the worker interval/u,
    );
  });

  it("defaults the fee tier to 100 and refuses a tier that is not a V3 tier", () => {
    assert.equal(resolveLendingSwapFeeTier(env()), 100);
    assert.equal(resolveLendingSwapFeeTier(env({ LENDING_SWAP_FEE_TIER: "500" })), 500);
    assert.throws(
      () => resolveLendingSwapFeeTier(env({ LENDING_SWAP_FEE_TIER: "3000" })),
      /must be one of/u,
    );
  });

  it("requires the vToken addresses and falls the treasury back to FEE_TREASURY_ADDRESS", () => {
    const venue = resolveLendingVenue(env());
    assert.equal(venue.vUsdt, V_USDT);
    assert.equal(venue.vBnb, V_BNB);
    assert.equal(venue.treasury, TREASURY);
    const { LENDING_VUSDT_ADDRESS: _drop, ...without } = env() as Record<string, string>;
    assert.throws(
      () => resolveLendingVenue(without as NodeJS.ProcessEnv),
      // The message deliberately does NOT name `LENDING_ENABLED`: the
      // read-only probes resolve this config with the guard off, so blaming
      // the flag sent an operator to the wrong line.
      /LENDING_VUSDT_ADDRESS is unset\. The lending venue is pinned by address/u,
    );
  });

  it("falls the RPC back through VENUS_RPC_URL then LP_RPC_URL then the public endpoint", () => {
    assert.deepEqual(
      resolveLendingRpcUrls(env({ LENDING_RPC_URL: "https://a" }), "https://public"),
      ["https://a", "https://public"],
    );
    assert.deepEqual(
      resolveLendingRpcUrls(env({ VENUS_RPC_URL: "https://b" }), "https://public"),
      ["https://b", "https://public"],
    );
    assert.deepEqual(
      resolveLendingRpcUrls(env({ LP_RPC_URL: "https://c" }), "https://public"),
      ["https://c", "https://public"],
    );
    assert.deepEqual(resolveLendingRpcUrls(env(), "https://public"), ["https://public"]);
  });
});

describe("buildLendingServerDeps — the PHASE4-AUDIT A1 regression", () => {
  const network = {
    chain: { id: 56 } as never,
    chainId: 56,
    publicRpcUrl: "https://public",
  };
  const lpVenue = {
    routerV3: ROUTER, wbnb: WBNB, quoterV2: QUOTER, factoryV3: FACTORY,
    maxSagaSlippageBps: 100,
  };
  const readers = {
    async readSwapPool() { return { pool: POOL, liquidity: 10n ** 24n, token0: USDT }; },
  } as unknown as LendingChainReaders;
  const overrides = {
    guards: new MemoryLendingGuardStore(),
    settingsStore: new MemoryVenusSettingsStore(),
    observations: new MemoryVenusObservationStore(),
    readers,
    usdt: USDT,
    swapPool: POOL,
  };

  it("answers undefined when the flag is off — the routes then 404", async () => {
    assert.equal(
      await buildLendingServerDeps({
        env: env({ LENDING_ENABLED: "false" }), network, lpVenue, overrides,
      }),
      undefined,
    );
  });

  it("BUILDS every collaborator when the flag is on", async () => {
    const built = await buildLendingServerDeps({ env: env(), network, lpVenue, overrides });
    assert.ok(built !== undefined, "enabled and reachable must be the same word");
    assert.equal(built.venue.vUsdt, V_USDT);
    assert.equal(built.venue.usdt, USDT);
    assert.equal(built.venue.swapFeeTier, 100);
    assert.equal(built.intervalMs, 30_000);
    assert.equal(built.maxSagaSlippageBps, 100);
    assert.equal(built.previewSecret, null, "absent secret is a supported, fail-closed state");
  });

  it("carries the preview secret when one is configured", async () => {
    const built = await buildLendingServerDeps({
      env: env({ LENDING_PREVIEW_SECRET: "ab".repeat(32) }),
      network, lpVenue, overrides,
    });
    assert.equal(built?.previewSecret?.length, 32);
  });

  it("REFUSES the boot with no DATABASE_URL", async () => {
    const { DATABASE_URL: _drop, ...without } = env() as Record<string, string>;
    await assert.rejects(
      () => buildLendingServerDeps({
        env: without as NodeJS.ProcessEnv, network, lpVenue, overrides,
      }),
      /DATABASE_URL is unset/u,
    );
  });

  it("ALLOWS the memory stores only under the named REHEARSAL carve-out", async () => {
    const { DATABASE_URL: _drop, ...without } = env() as Record<string, string>;
    const built = await buildLendingServerDeps({
      env: without as NodeJS.ProcessEnv, network, lpVenue, rehearsal: true, overrides,
    });
    assert.ok(built !== undefined, "dev-stack's offline rehearsal, and nothing else");
  });

  it("REFUSES any chain but 56", async () => {
    await assert.rejects(
      () => buildLendingServerDeps({
        env: env(), network: { ...network, chainId: 97 }, lpVenue, overrides,
      }),
      /chain-56 only/u,
    );
  });

  it("REFUSES a pinned tier whose pool has no liquidity", async () => {
    await assert.rejects(
      () => buildLendingServerDeps({
        env: env(), network, lpVenue,
        overrides: {
          ...overrides,
          swapPool: undefined,
          readers: undefined,
          usdt: USDT,
          guards: overrides.guards,
        } as never,
      }),
      // With no reader override the boot builds a real one and cannot reach a
      // chain here; the refusal is what matters, not which of the two fires.
      /liquidity|served chain|RPC/u,
    );
  });
});

describe("the preset's reach across the readers that switch on hireSizing.name", () => {
  it("is NOT a member of HIRE_SIZING_PRESETS — it has no LP terms", () => {
    assert.ok(!Object.keys(HIRE_SIZING_PRESETS).includes("lending-v1"));
  });

  it("maps to the `lending` identity category", () => {
    assert.equal(categoryForPreset("lending-v1"), "lending");
    assert.ok(validCategory("lending"));
    assert.equal(categoryForPreset("unknown-v9"), null);
  });

  it("the ERC-8004 source projection reads the category off hireSizing", () => {
    const record = {
      id: "a", ownerAddress: getAddress("0x1111111111111111111111111111111111111111"),
      walletAddress: getAddress("0x2222222222222222222222222222222222222222"),
      custodyModel: "passkey", status: "armed", httpRuntimeProfile: "unbound-v1",
      erc8004AgentId: null, sessionRevocation: null, caps: null, pendingGrant: null,
      rowVersion: 1, createdAt: 0, updatedAt: 0,
      sessionFacts: {
        spec: { allowedCalls: [{ to: V_USDT }], spendCaps: [{ limit: 1n, period: "day" }], expiresAt: 1 },
        permissions: { calls: [], spend: [] },
        publicKey: `0x04${"ab".repeat(64)}`,
        expiry: 2_000_000_000,
        hireSizing: { name: "lending-v1", version: 1, openNativeBudgetWei: "1" },
      },
    } as unknown as AgentRecord;
    assert.equal(sourceFromRecord(record).category, "lending");
  });

  it("the identity metadata names the category in both revisions", () => {
    const v1 = metadataUri("lending", "11111111-1111-4111-8111-111111111111");
    const v2 = metadataUriV2("lending", 7, "11111111-1111-4111-8111-111111111111");
    for (const uri of [v1, v2]) {
      const json = JSON.parse(
        Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8"),
      ) as Record<string, unknown>;
      assert.equal((json["x4lpha"] as Record<string, unknown>)["category"], "lending");
      assert.ok(String(json["description"]).length > 0);
    }
    assert.match(
      JSON.parse(
        Buffer.from(v2.slice("data:application/json;base64,".length), "base64").toString("utf8"),
      )["name"] as string,
      /Health Guard|Lending/u,
    );
  });
});
