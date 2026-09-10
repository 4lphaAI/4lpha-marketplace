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
import { RELAY_FEE_PER_EXIT_WEI } from "../src/ops/relayFee.js";

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
  it("ships the cleared defaults — band 700, not the body's 300", () => {
    const params = resolveQuantStrategyParams({});
    assert.deepEqual(params, QUANT_STRATEGY_DEFAULTS);
    assert.equal(params.bandBps, 700);
    assert.equal(params.minClipUWei, 10n * 10n ** 18n);
    assert.equal(params.maxImpactBps, 50);
    assert.equal(params.entryTolBps, 50);
    assert.equal(params.exitTolBps, 50);
    assert.equal(params.strategyVersion, QUANT_STRATEGY_VERSION);
    assert.equal(params.relayFeePerSubmitWei, RELAY_FEE_PER_EXIT_WEI);
  });

  it("FEE_EST is 3x the relay constant, and there is no other fee number", () => {
    assert.equal(feeEstWei(QUANT_STRATEGY_DEFAULTS), 3n * RELAY_FEE_PER_EXIT_WEI);
  });

  it("bounds every override and refuses out-of-range values", () => {
    assert.throws(() => resolveQuantStrategyParams({ QUANT_BAND_BPS: "100" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_BAND_BPS: "2001" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_MAX_LEVELS: "6" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_MIN_CLIP_U_WEI: "1" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_COOLDOWN_SEC: "59" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_MAX_IMPACT_BPS: "301" }));
    assert.throws(() => resolveQuantStrategyParams({ QUANT_BAND_BPS: "seven hundred" }));
  });

  it("refuses a band that cannot cover its own fixed costs", () => {
    // 2 legs (50) + entry (50) + exit (50) + edge (50) = 200 bps of floor.
    assert.throws(
      () => resolveQuantStrategyParams({ QUANT_BAND_BPS: "200" }),
      /fixed cost floor/u,
    );
    assert.doesNotThrow(() => resolveQuantStrategyParams({ QUANT_BAND_BPS: "201" }));
  });

  it("digests every economic parameter — a change moves the hash", () => {
    const base = quantParamsDigest(resolveQuantStrategyParams({}));
    assert.notEqual(base, quantParamsDigest(resolveQuantStrategyParams({ QUANT_BAND_BPS: "800" })));
    assert.notEqual(base, quantParamsDigest(resolveQuantStrategyParams({ QUANT_MAX_LEVELS: "4" })));
    assert.notEqual(
      base, quantParamsDigest(resolveQuantStrategyParams({ QUANT_MIN_NET_EDGE_BPS: "60" })),
    );
    assert.equal(base, quantParamsDigest(resolveQuantStrategyParams({})));
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

  it("REFUSES a band change that keeps the old digest", () => {
    assert.throws(
      () => resolveQuantRuntimeConfig(baseEnv({ QUANT_BAND_BPS: "800" }), {
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
