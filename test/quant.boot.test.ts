import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import { assertQuantBoot, gridTradableSetRefusal } from "../scripts/quantWorkerDeps.js";
import type { QuantRuntimeConfig } from "../src/quant/config.js";
import { QUANT_ROUTER_56, QUANT_U_56, QUANT_U_WBNB_PAIR_56, QUANT_WBNB_56 } from "../src/quant/config.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import {
  normalizeExpandedQuantConfig, QUANT_EXPANDED_CONFIG_PROFILES,
  type QuantExpandedConfigProfile, type QuantExpandedConfigProjection,
} from "../src/quant/rebalanceConfig.js";
import { parseConfigBlock, type QuantConfigBlock, type QuantTransport } from "../src/quant/termix.js";
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

/**
 * R14.6 (BC-S225..S234): the platform config grew to seven tradable tokens on
 * 2026-09-30 and the one-token predicate stopped the Grid worker. Grid trades
 * one pair, so it needs only WBNB present once, `direct`, 18 decimals.
 */
type LiveWire = {
  quant: {
    chainId: number;
    token: { address: string; decimals: number };
    tradableTokens: { address: string; decimals: number; priceRoute: string }[];
    venueAllowlist: { address: string }[];
  };
};

const WBNB_FACTS = "Boot refused: the tradable set does not preserve Grid's WBNB direct facts.";
const DUPLICATE_TOKEN = "Boot refused: the tradable set has a duplicate token.";
const CAKE: Address = getAddress("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82");
const isWbnb = (row: { readonly address: string }): boolean => row.address.toLowerCase() === QUANT_WBNB_56.toLowerCase();

/** The captured 2026-09-30 response, edited on the wire shape so either parser sees the same change. */
function expandedBlock(edit: (wire: LiveWire) => void = () => undefined): QuantConfigBlock {
  const wire = JSON.parse(readFileSync(
    new URL("./fixtures/quant/termix-config-2026-09-30.json", import.meta.url), "utf8",
  )) as LiveWire;
  edit(wire);
  const parsed = parseConfigBlock(wire);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.code}`);
  return parsed.data;
}

function wbnbRow(wire: LiveWire): LiveWire["quant"]["tradableTokens"][number] {
  const row = wire.quant.tradableTokens.find(isWbnb);
  if (row === undefined) throw new Error("fixture has no WBNB row");
  return row;
}

const withoutWbnb = (wire: LiveWire): void => {
  wire.quant.tradableTokens = wire.quant.tradableTokens.filter((row) => !isWbnb(row));
};

describe("R14.6 gridTradableSetRefusal (BC-S225..S227)", () => {
  const live = expandedBlock().tradableTokens;
  const wbnb = live[0]!;
  const cake = live[1]!;

  it("BC-S225: the live seven-token list has no refusal", () => {
    assert.equal(live.length, 7);
    assert.ok(isWbnb(wbnb));
    assert.equal(gridTradableSetRefusal(live, QUANT_WBNB_56), null);
  });

  it("BC-S226: every way the set can lose Grid's WBNB facts is refused, a duplicate first", () => {
    const others = live.filter((row) => !isWbnb(row));
    const cases: readonly (readonly [string, QuantConfigBlock["tradableTokens"], string])[] = [
      ["WBNB missing", others, WBNB_FACTS],
      ["WBNB via_wbnb", [{ ...wbnb, priceRoute: "via_wbnb" }, ...others], WBNB_FACTS],
      ["WBNB 8 decimals", [{ ...wbnb, decimals: 8 }, ...others], WBNB_FACTS],
      ["WBNB listed twice", [wbnb, wbnb, ...others], DUPLICATE_TOKEN],
      [
        "WBNB twice in different letter case",
        [wbnb, { ...wbnb, address: wbnb.address.toLowerCase() as Address }, ...others],
        DUPLICATE_TOKEN,
      ],
      ["a non-WBNB token listed twice", [...live, cake], DUPLICATE_TOKEN],
    ];
    for (const [label, tokens, expected] of cases) {
      assert.equal(gridTradableSetRefusal(tokens, QUANT_WBNB_56), expected, label);
    }
  });

  it("BC-S227: rows other than WBNB are not inspected", () => {
    assert.equal(gridTradableSetRefusal([
      wbnb,
      { address: cake.address, decimals: 8, priceRoute: "mystery" },
      { address: getAddress("0x00000000000000000000000000000000000000aa"), decimals: 0, priceRoute: "" },
    ], QUANT_WBNB_56), null);
  });
});

describe("R14.6 assertQuantBoot on the expanded config (BC-S228..S231)", () => {
  it("BC-S228: the live fixture boots", async () => {
    await assertQuantBoot(bootInput(expandedBlock()));
  });

  it("BC-S229: chain, U, U decimals, router, pair and an empty tradable set keep their refusals", async () => {
    const cases: readonly (readonly [string, (wire: LiveWire) => void, string])[] = [
      ["chain", (wire) => { wire.quant.chainId = 97; }, "Boot refused: the venue block reports a chain other than 56."],
      [
        "U address",
        (wire) => { wire.quant.token.address = OLD_U; },
        "Boot refused: the venue block's U address is not the pinned constant.",
      ],
      [
        "U decimals",
        (wire) => { wire.quant.token.decimals = 6; },
        "Boot refused: the settlement token does not have 18 decimals.",
      ],
      [
        "router",
        (wire) => {
          wire.quant.venueAllowlist = wire.quant.venueAllowlist.filter(
            (row) => row.address.toLowerCase() !== QUANT_ROUTER_56.toLowerCase(),
          );
        },
        "Boot refused: the pinned Pancake V2 router is not in the venue allowlist.",
      ],
      // Master routes an empty set through the expanded-config gate's refusal.
      ["empty tradable set", (wire) => { wire.quant.tradableTokens = []; }, "Boot refused: platform-config-invalid."],
    ];
    for (const [label, edit, message] of cases) {
      await assert.rejects(assertQuantBoot(bootInput(expandedBlock(edit))), { message }, label);
    }
    const wrongPair = {
      async chainId() { return 56; },
      async getPair() { return OLD_U; },
    } as unknown as QuantChainReader;
    await assert.rejects(
      assertQuantBoot({ ...bootInput(expandedBlock()), reader: wrongPair }),
      { message: "Boot refused: the V2 factory's U/WBNB pair does not equal the pinned pair address." },
    );
  });

  it("BC-S230: the single-token legacy config resolves and keeps its three refusals", async () => {
    await assertQuantBoot(bootInput(liveBlock()));
    const notWbnb = "Boot refused: the tradable token is not WBNB with a direct route.";
    await assert.rejects(
      assertQuantBoot(bootInput(liveBlock({ tradableTokens: [{ address: CAKE, decimals: 18, priceRoute: "direct" }] }))),
      { message: notWbnb },
    );
    await assert.rejects(
      assertQuantBoot(bootInput(liveBlock({
        tradableTokens: [{ address: QUANT_WBNB_56, decimals: 18, priceRoute: "via_wbnb" }],
      }))),
      { message: notWbnb },
    );
    await assert.rejects(
      assertQuantBoot(bootInput(liveBlock({
        tradableTokens: [{ address: QUANT_WBNB_56, decimals: 6, priceRoute: "direct" }],
      }))),
      { message: "Boot refused: the tradable token does not have 18 decimals." },
    );
  });

  it("BC-S231: boot refuses the live fixture once WBNB's facts break or a token is duplicated", async () => {
    const cases: readonly (readonly [string, (wire: LiveWire) => void, string])[] = [
      ["WBNB removed", withoutWbnb, WBNB_FACTS],
      ["WBNB via_wbnb", (wire) => { wbnbRow(wire).priceRoute = "via_wbnb"; }, WBNB_FACTS],
      ["WBNB 8 decimals", (wire) => { wbnbRow(wire).decimals = 8; }, WBNB_FACTS],
      [
        "a non-WBNB token duplicated",
        (wire) => { wire.quant.tradableTokens.push({ address: CAKE, decimals: 18, priceRoute: "via_wbnb" }); },
        // Master's expanded-config normalization refuses duplicate tokens before
        // the Grid fallback runs (spec 3b); the duplicate message is boot-reachable
        // on the deployed tree only, and covered as a helper case here (BC-S226).
        "Boot refused: platform-config-invalid.",
      ],
    ];
    for (const [label, edit, message] of cases) {
      await assert.rejects(assertQuantBoot(bootInput(expandedBlock(edit))), { message }, label);
    }
  });
});

describe("R14.6 reviewed-profile seam (BC-S232, master only)", () => {
  function projectionOf(block: QuantConfigBlock): QuantExpandedConfigProjection {
    const normalized = normalizeExpandedQuantConfig(block);
    if (!normalized.ok) throw new Error(normalized.code);
    return normalized.projection;
  }
  function profileFor(projection: QuantExpandedConfigProjection): QuantExpandedConfigProfile {
    return {
      id: "r146-test",
      capturedEvidenceRef: "test/fixtures/quant/termix-config-2026-09-30.json",
      capturedEvidenceDigest: `0x${"ab".repeat(32)}`,
      expected: projection,
      expectedVenueRowCount: projection.venueRows.length,
      expectedUniqueVenueTargetCount: new Set(projection.venueRows.map((row) => row.address)).size,
    };
  }

  it("BC-S232: an empty registry boots the live fixture through the Grid fallback; the default registry boots it too", async () => {
    // Listing prep B1 put the reviewed TermiX capture into the default registry, so the empty-registry
    // fallback is now exercised by injecting `profiles: []`; the default registry matches the live fixture.
    await assertQuantBoot({ ...bootInput(expandedBlock()), profiles: [] });
    assert.ok(QUANT_EXPANDED_CONFIG_PROFILES.length > 0);
    await assertQuantBoot(bootInput(expandedBlock()));
  });

  it("BC-S232: an injected matching profile takes the profile path, not the fallback", async () => {
    const live = expandedBlock();
    await assertQuantBoot({ ...bootInput(live), profiles: [profileFor(projectionOf(live))] });
    // The profile path keeps its own WBNB diagnostic; the fallback's differs.
    const viaWbnb = expandedBlock((wire) => { wbnbRow(wire).priceRoute = "via_wbnb"; });
    await assert.rejects(
      assertQuantBoot({ ...bootInput(viaWbnb), profiles: [profileFor(projectionOf(viaWbnb))] }),
      { message: "Boot refused: expanded profile does not preserve Grid's WBNB direct facts." },
    );
    await assert.rejects(assertQuantBoot(bootInput(viaWbnb)), { message: WBNB_FACTS });
  });

  it("BC-S232: a non-matching profile falls back, and a config lacking WBNB gets the WBNB refusal", async () => {
    const other = expandedBlock((wire) => { wire.quant.tradableTokens.pop(); });
    const profiles = [profileFor(projectionOf(other))];
    await assertQuantBoot({ ...bootInput(expandedBlock()), profiles });
    const noWbnb = expandedBlock(withoutWbnb);
    await assert.rejects(assertQuantBoot({ ...bootInput(noWbnb), profiles }), { message: WBNB_FACTS });
    await assert.rejects(assertQuantBoot(bootInput(noWbnb)), { message: WBNB_FACTS });
  });
});

describe("R14.6 config-check (BC-S233, source scan: the script runs main() on import)", () => {
  const source = readFileSync("scripts/live-quant.ts", "utf8");

  it("BC-S233: the grid facts line is the boot function's own verdict, printed for expanded sets only", () => {
    assert.ok(source.includes('import { gridTradableSetRefusal } from "./quantWorkerDeps.js";'));
    assert.ok(source.includes(
      '`grid facts       ${gridTradableSetRefusal(block.data.tradableTokens, context.config.wbnb) ?? "ok"}`',
    ));
    assert.ok(source.includes("...(block.data.tradableTokens.length > 1"));
  });

  it("BC-S233: the venueAllowlist line falls back to the raw venue-row addresses", () => {
    assert.ok(source.includes("block.data.venueAllowlist.length > 0"));
    assert.ok(source.includes("(block.data.venueRows ?? []).map((row) => row.address)"));
  });
});
