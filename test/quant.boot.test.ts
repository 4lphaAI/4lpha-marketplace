import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import { assertQuantBoot } from "../scripts/quantWorkerDeps.js";
import type { QuantRuntimeConfig } from "../src/quant/config.js";
import { QUANT_ROUTER_56, QUANT_U_56, QUANT_U_WBNB_PAIR_56, QUANT_WBNB_56 } from "../src/quant/config.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { QuantConfigBlock, QuantTransport } from "../src/quant/termix.js";
import type { WalletProvider } from "../src/core/types.js";

/**
 * The boot cross-checks of `assertQuantBoot` (spec §2.1 / §4.3, R8.1), pinned
 * offline after the 2026-09-16 production refusal (FINDINGS bn-6): the venue
 * block is checked, never adapted to, and — since the USDC re-pin review — a
 * settlement or tradable token with other than 18 decimals is refused too.
 */
const SEED = "0x" + "11".repeat(32);
const OLD_U: Address = getAddress("0xcE24439F2D9C6a2289F741120FE202248B666666");
const FACTORY: Address = getAddress("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73");

function liveBlock(overrides: Partial<QuantConfigBlock> = {}): QuantConfigBlock {
  return {
    chainId: 56,
    u: QUANT_U_56,
    uDecimals: 18,
    tradableTokens: [{ address: QUANT_WBNB_56, decimals: 18, priceRoute: "direct" }],
    venueAllowlist: [QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56],
    ...overrides,
  };
}

function bootInput(block: QuantConfigBlock) {
  const keypair = quantKeypairFromSeed(SEED);
  const transport = {
    async config() { return { ok: true as const, data: block }; },
    async agentKey() {
      return {
        ok: true as const,
        data: { encryptionPublicKey: keypair.publicKey.toString("base64"), algorithm: "x25519-hkdf-chacha20poly1305" },
      };
    },
  } as unknown as QuantTransport;
  const reader = {
    async chainId() { return 56; },
    async getPair() { return QUANT_U_WBNB_PAIR_56; },
  } as unknown as QuantChainReader;
  const provider = {
    submitTimeoutMs: 30_000,
    restoreGrantedSession() { throw new Error("not reached"); },
    async readSpendInfos() { return []; },
  } as unknown as WalletProvider;
  const config = {
    u: QUANT_U_56, wbnb: QUANT_WBNB_56, router: QUANT_ROUTER_56,
    factory: FACTORY, pair: QUANT_U_WBNB_PAIR_56, agentId: "agent-under-test",
  } as unknown as QuantRuntimeConfig;
  return { transport, reader, config, keypair, provider };
}

describe("quant boot cross-checks (bn-6 / USDC re-pin review)", () => {
  it("accepts the pinned USDC venue block with 18-decimal tokens", async () => {
    await assertQuantBoot(bootInput(liveBlock()));
  });

  it("refuses a venue block whose settlement token is the retired U address", async () => {
    await assert.rejects(
      assertQuantBoot(bootInput(liveBlock({ u: OLD_U }))),
      /U address is not the pinned constant/u,
    );
  });

  it("refuses a settlement token that does not have 18 decimals", async () => {
    await assert.rejects(
      assertQuantBoot(bootInput(liveBlock({ uDecimals: 6 }))),
      /settlement token does not have 18 decimals/u,
    );
  });

  it("refuses a tradable token that does not have 18 decimals", async () => {
    await assert.rejects(
      assertQuantBoot(bootInput(liveBlock({
        tradableTokens: [{ address: QUANT_WBNB_56, decimals: 6, priceRoute: "direct" }],
      }))),
      /tradable token does not have 18 decimals/u,
    );
  });

  it("refuses a venue allowlist without the pinned router", async () => {
    await assert.rejects(
      assertQuantBoot(bootInput(liveBlock({ venueAllowlist: [QUANT_U_56, QUANT_WBNB_56] }))),
      /router is not in the venue allowlist/u,
    );
  });
});
