/**
 * The tri-state flag, the parameter bounds, the digest gate and the egress
 * allowlist (QUANT-GRID §7.1, R2.11, R2.13, R3.6, R3.14, BC35).
 *
 * The demo-mode lesson is the shape here: `resolveQuantRuntimeConfig` is called
 * ONLY when the flag is on, so a stray value cannot stop an unrelated service
 * booting — and `resolveQuantEnabled` on its own parses nothing else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  feeEstWei,
  admittedQuantParams,
  parseQuantBandTiers,
  quantEgressOrigins,
  quantParamsDigest,
  QUANT_API_ORIGINS_ALLOWED,
  QUANT_STRATEGY_DEFAULTS,
  QUANT_STRATEGY_VERSION,
  resolveQuantEnabled,
  resolveQuantRuntimeConfig,
  resolveQuantStrategyParams,
  type QuantEnv,
} from "../src/quant/config.js";

const RELAY = "https://relay.altana.network";

function baseEnv(overrides: QuantEnv = {}): QuantEnv {
  const params = resolveQuantStrategyParams({});
  return {
    QUANT_ENABLED: "true",
    EXECUTION_NETWORK: "mainnet",
    DATABASE_URL: "postgres://localhost/x",
    QUANT_ENVELOPE_KEY: `0x${"11".repeat(32)}`,
    QUANT_API_KEY: "bearer-token",
    QUANT_AGENT_ID: "agent-1",
    QUANT_STRATEGY_ID: "strategy-1",
    QUANT_PARAMS_DIGEST: quantParamsDigest(params),
    ...overrides,
  };
}

describe("QUANT_ENABLED — the tri-state", () => {
  it("defaults OFF when absent or empty", () => {
    assert.equal(resolveQuantEnabled({}), false);
    assert.equal(resolveQuantEnabled({ QUANT_ENABLED: "" }), false);
    assert.equal(resolveQuantEnabled({ QUANT_ENABLED: "   " }), false);
  });

  it("is ON only for the exact string `true`", () => {
    assert.equal(resolveQuantEnabled({ QUANT_ENABLED: "true" }), true);
    assert.equal(resolveQuantEnabled({ QUANT_ENABLED: "false" }), false);
  });

  it("FAILS THE BOOT on a typo rather than silently disabling", () => {
    for (const raw of ["1", "yes", "TRUE", "on", "True"]) {
      assert.throws(() => resolveQuantEnabled({ QUANT_ENABLED: raw }), /exactly "true" or "false"/u);
    }
  });
});

describe("strategy parameters", () => {
  it("ships the R14 process defaults without a process-level band", () => {
    const params = resolveQuantStrategyParams({});
    assert.deepEqual(params, QUANT_STRATEGY_DEFAULTS);
    assert.equal(params.bandTiers, "10:700");
    assert.equal(params.minClipUWei, 5n * 10n ** 18n);
    assert.equal(params.maxImpactBps, 50);
    assert.equal(params.entryTolBps, 40);
    assert.equal(params.exitTolBps, 10);
    assert.equal(params.minNetEdgeBps, 25);
    assert.equal(params.strategyVersion, QUANT_STRATEGY_VERSION);
    assert.equal(params.relayFeePerSubmitWei, 30_000_000_000_000n);
    assert.equal(params.relayGasUnits, 300_000n);
    assert.equal(params.relayFeePadBps, 15_000n);
  });

  it("uses the live estimator and its floor at 0.05 gwei", () => {
    assert.equal(feeEstWei(QUANT_STRATEGY_DEFAULTS, 50_000_000n), 30_000_000_000_000n);
    assert.equal(feeEstWei(QUANT_STRATEGY_DEFAULTS, 100_000_000n), 45_000_000_000_000n);
  });

  it("bounds every override and refuses out-of-range values", () => {
    assert.throws(() => resolveQuantStrategyParams({ QUANT_BAND_TIERS_BPS: "10:149" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_BAND_TIERS_BPS: "10:2001" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_MAX_LEVELS: "6" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_MIN_CLIP_U_WEI: "1" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_COOLDOWN_SEC: "59" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_MAX_IMPACT_BPS: "301" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_BAND_TIERS_BPS: "ten:700" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_RELAY_FEE_PER_SUBMIT_WEI: "9999999999999" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_RELAY_FEE_PER_SUBMIT_WEI: "10000000000000001" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_RELAY_GAS_UNITS: "199999" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_RELAY_FEE_PAD_BPS: "30001" }));
  });

  it("refuses a band that cannot cover its own fixed costs", () => {
    // 2 legs (50) + entry (70) + exit (10) + edge (25) = 155 bps.
    assert.throws(
      () => resolveQuantStrategyParams({
        QUANT_ENTRY_TOL_BPS: "70", QUANT_BAND_TIERS_BPS: "10:155",
      }),
      /fixed cost floor/u,
    );
    assert.doesNotThrow(() => resolveQuantStrategyParams({
      QUANT_ENTRY_TOL_BPS: "70", QUANT_BAND_TIERS_BPS: "10:156",
    }));
  });

  it("digests every economic parameter — a change moves the hash", () => {
    const base = quantParamsDigest(resolveQuantStrategyParams({}));
    assert.notEqual(base, quantParamsDigest(resolveQuantStrategyParams({ QUANT_BAND_TIERS_BPS: "10:800" })));
    assert.notEqual(base, quantParamsDigest(resolveQuantStrategyParams({ QUANT_MAX_LEVELS: "4" })));
    assert.notEqual(
      base, quantParamsDigest(resolveQuantStrategyParams({ QUANT_MIN_NET_EDGE_BPS: "60" })),
    );
    assert.equal(base, quantParamsDigest(resolveQuantStrategyParams({})));
  });

  it("refuses reordered or duplicate tiers and canonicalizes accepted spelling", () => {
    assert.throws(
      () => resolveQuantStrategyParams({ QUANT_BAND_TIERS_BPS: "30:200,10:250" }),
      /strictly ascending/u,
    );
    assert.throws(() => parseQuantBandTiers("10:250,10:200"), /strictly ascending/u);
    const params = resolveQuantStrategyParams({
      QUANT_BAND_TIERS_BPS: " 010 : 0700 ",
    });
    assert.equal(params.bandTiers, "10:700");
    assert.deepEqual(
      parseQuantBandTiers("999999:250,1000000:200"),
      [
        { minAllocationUWei: 999999n * 10n ** 18n, bandBps: 250 },
        { minAllocationUWei: 1000000n * 10n ** 18n, bandBps: 200 },
      ],
    );
  });

  it("selects allocation tiers and refuses below the first threshold", () => {
    const params = resolveQuantStrategyParams({
      QUANT_BAND_TIERS_BPS: "10:250,30:200",
      QUANT_SEED_MODE: "symmetric",
    });
    assert.deepEqual(admittedQuantParams(params, 9n * 10n ** 18n), {
      ok: false, code: "below-minimum",
    });
    const at29 = admittedQuantParams(params, 29n * 10n ** 18n);
    const at30 = admittedQuantParams(params, 30n * 10n ** 18n);
    assert.ok("bandBps" in at29 && "bandBps" in at30);
    if (!("bandBps" in at29) || !("bandBps" in at30)) return;
    assert.equal(at29.bandBps, 250);
    assert.equal(at30.bandBps, 200);
    assert.deepEqual(admittedQuantParams(params, 2n * 5n * 10n ** 18n - 1n), {
      ok: false, code: "below-minimum",
    });
    assert.notEqual(
      quantParamsDigest(resolveQuantStrategyParams({
        QUANT_BAND_TIERS_BPS: "10:250,40:200", QUANT_SEED_MODE: "symmetric",
      })),
      quantParamsDigest(params),
      "the full tier table is digest-bound even when allocation selects the same band",
    );
  });
});

describe("resolveQuantRuntimeConfig", () => {
  it("resolves a complete environment", () => {
    const config = resolveQuantRuntimeConfig(baseEnv(), { publicRpcUrl: "https://rpc.example" });
    assert.equal(config.chainId, 56);
    assert.equal(config.gasModel, "wallet");
    assert.equal(config.intervalMs, 60_000);
    assert.equal(config.apiBaseUrl, "https://platform-backend.prod.termix.live");
  });

  it("requires mainnet — there is no testnet path (operator ruling)", () => {
    assert.throws(
      () => resolveQuantRuntimeConfig(baseEnv({ EXECUTION_NETWORK: "testnet" }), {
        publicRpcUrl: "https://rpc.example",
      }),
      /mainnet/u,
    );
  });

  it("requires DATABASE_URL — the store IS the worker's queue", () => {
    const env = { ...baseEnv() };
    delete (env as Record<string, unknown>)["DATABASE_URL"];
    assert.throws(
      () => resolveQuantRuntimeConfig(env, { publicRpcUrl: "https://rpc.example" }),
      /DATABASE_URL/u,
    );
  });

  it("NEVER echoes the seed in its refusal", () => {
    const seed = `0x${"ab".repeat(20)}`;
    try {
      resolveQuantRuntimeConfig(baseEnv({ QUANT_ENVELOPE_KEY: seed }), {
        publicRpcUrl: "https://rpc.example",
      });
      assert.fail("a malformed seed must fail the boot");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      assert.equal(message.includes(seed), false, "a boot error must not carry a seed");
      assert.match(message, /64 hex characters/u);
    }
  });

  it("REFUSES a params-digest mismatch — economics cannot drift from the listing", () => {
    assert.throws(
      () => resolveQuantRuntimeConfig(
        baseEnv({ QUANT_PARAMS_DIGEST: `0x${"00".repeat(32)}` }),
        { publicRpcUrl: "https://rpc.example" },
      ),
      /params-digest-mismatch/u,
    );
  });

  it("REFUSES a tier-table change that keeps the old digest", () => {
    assert.throws(
      () => resolveQuantRuntimeConfig(baseEnv({ QUANT_BAND_TIERS_BPS: "10:800" }), {
        publicRpcUrl: "https://rpc.example",
      }),
      /params-digest-mismatch/u,
    );
  });

  it("refuses `sponsored` gas — TermiX confirmed the client funds it (R3.14)", () => {
    assert.throws(
      () => resolveQuantRuntimeConfig(baseEnv({ QUANT_GAS_MODEL: "sponsored" }), {
        publicRpcUrl: "https://rpc.example",
      }),
      /must be "wallet"/u,
    );
  });

  it("bounds the interval and refuses nonsense", () => {
    assert.equal(
      resolveQuantRuntimeConfig(baseEnv({ QUANT_WORKER_INTERVAL_MS: "120000" }), {
        publicRpcUrl: "https://rpc.example",
      }).intervalMs,
      120_000,
    );
    assert.throws(() => resolveQuantRuntimeConfig(baseEnv({ QUANT_WORKER_INTERVAL_MS: "1000" }), {
      publicRpcUrl: "https://rpc.example",
    }));
  });
});

describe("egress (R2.11 / BC35)", () => {
  it("pins ONE API origin, widened by spec revision only", () => {
    assert.equal(QUANT_API_ORIGINS_ALLOWED.size, 1);
    assert.equal(
      QUANT_API_ORIGINS_ALLOWED.has("https://platform-backend.prod.termix.live"), true,
    );
  });

  it("refuses a base URL outside the allowlist, and any non-https scheme", () => {
    for (const url of [
      "https://evil.example", "http://platform-backend.prod.termix.live",
      "https://platform-backend.prod.termix.live/api",
    ]) {
      assert.throws(() => resolveQuantRuntimeConfig(baseEnv({ QUANT_API_BASE_URL: url }), {
        publicRpcUrl: "https://rpc.example",
      }));
    }
  });

  it("refuses a non-https RPC", () => {
    assert.throws(
      () => resolveQuantRuntimeConfig(baseEnv({ QUANT_RPC_URL: "http://rpc.example" }), {
        publicRpcUrl: "https://rpc.example",
      }),
      /https/u,
    );
  });

  it("enumerates exactly THREE origins, from the CONFIGURED values", () => {
    const config = resolveQuantRuntimeConfig(
      baseEnv({ QUANT_RPC_URL: "https://my-node.example/path" }),
      { publicRpcUrl: "https://rpc.example" },
    );
    assert.deepEqual(quantEgressOrigins(config, RELAY), [
      "https://my-node.example",
      "https://platform-backend.prod.termix.live",
      "https://relay.altana.network",
      "https://rpc.example",
    ].sort());
  });
});
