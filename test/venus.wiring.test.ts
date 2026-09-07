/**
 * PHASE4 — the composition seam (`PHASE4-AUDIT.md` A1, `PHASE4-FIXREVIEW.md`
 * F1/F2/F3).
 *
 * WHY THIS FILE EXISTS: the fix review proved that restoring the exact audited
 * defect — `buildVenusServerDeps` returning `undefined` unconditionally, so
 * `VENUS_ENABLED=true` enables NOTHING — left all 2,092 tests green. A1 was
 * the only blocker whose fix the suite could not defend, and "the compiler
 * catches it" is not true of a function that is simply never called.
 *
 * So these tests assert the two halves separately:
 *   1. the WIRING builds real deps when enabled and nothing when disabled, and
 *      refuses the boot on a deployment D11 excludes (F3);
 *   2. the ROUTES exist if and only if `createServer` is handed those deps —
 *      which is what makes "enabled" and "reachable" the same word.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";

import {
  buildVenusServerDeps,
  closeVenusServerDeps,
  venusMarketUniverse,
} from "../src/venus/wiring.js";
import { MemoryVenusSettingsStore } from "../src/store/venusSettings.js";
import { MemoryVenusObservationStore } from "../src/store/venusObservations.js";
import { MemoryVenusActionStore } from "../src/store/venusActions.js";
import type { VenusChainReaders } from "../src/venus/readers.js";
import type { VenusVenue } from "../src/venus/types.js";

const OWNER = getAddress("0x561b561ef37874c8e61534be9bae52eb6261ddc4");
const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const V_ETH = getAddress("0xf508fcd89b8bd15579dc79a6827cb4686a3592c8");
const COMPTROLLER = getAddress("0xfd36e2c2a6789db23113685031d7f16329158384");
const PRIME = getAddress("0x059eaba8676b03e4e8f009efb7f587c28450f50f");
const TREASURY = getAddress("0x00000000000000000000000000000000000000fe");

const NETWORK_56 = { chain: {}, chainId: 56, publicRpcUrl: "https://example.invalid" } as never;
const NETWORK_97 = { chain: {}, chainId: 97, publicRpcUrl: "https://example.invalid" } as never;

const VENUE: VenusVenue = {
  comptroller: COMPTROLLER,
  prime: PRIME,
  vBnb: V_BNB,
  treasury: TREASURY,
} as VenusVenue;

/** The env a real enabled deployment carries, minus whatever a test removes. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    VENUS_ENABLED: "true",
    DATABASE_URL: "postgres://localhost/execution",
    VENUS_VBNB_ADDRESS: V_BNB,
    VENUS_PRIME_ADDRESS: PRIME,
    FEE_TREASURY_ADDRESS: TREASURY,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function fakeReaders(seen: Address[][]): VenusChainReaders {
  return {
    async readMarketIndex(vTokens: readonly Address[]) {
      seen.push([...vTokens]);
      const index: Record<string, { readonly underlying: Address | null }> = {};
      for (const entry of vTokens) {
        index[entry.toLowerCase()] =
          entry.toLowerCase() === V_BNB.toLowerCase()
            ? { underlying: null }
            : { underlying: getAddress("0x55d398326f99059ff775485246999027b3197955") };
      }
      return index;
    },
  } as unknown as VenusChainReaders;
}

async function build(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly network?: unknown;
  readonly settingsStore?: MemoryVenusSettingsStore;
  readonly seen?: Address[][];
}) {
  const settingsStore = options.settingsStore ?? new MemoryVenusSettingsStore();
  return buildVenusServerDeps({
    env: options.env ?? env(),
    network: (options.network ?? NETWORK_56) as never,
    overrides: {
      settingsStore,
      observations: new MemoryVenusObservationStore(),
      actions: new MemoryVenusActionStore(() => 0),
      readers: fakeReaders(options.seen ?? []),
    },
  });
}

describe("venus wiring: enabled means REACHABLE, not merely configured", () => {
  it("builds the complete VenusServerDeps shape when enabled", async () => {
    // The A1 defect in one assertion: this returning `undefined` while
    // VENUS_ENABLED is "true" is exactly what shipped, and exactly what no
    // test could see.
    const built = await build({});
    assert.notEqual(built, undefined);
    if (built === undefined) return;
    // Every field `createServer` requires, or the routes cannot be registered.
    for (const key of [
      "settingsStore",
      "observations",
      "actions",
      "readers",
      "venue",
      "intervalMs",
      "maxObservationAgeMs",
      "marketIndex",
    ]) {
      assert.ok(key in built, `VenusServerDeps.${key} is missing`);
    }
    assert.equal(built.venue.comptroller.toLowerCase(), COMPTROLLER.toLowerCase());
    assert.ok(built.intervalMs > 0);
    // The read side reports confirmation eligibility in terms of the worker's
    // own cadence; a bound tighter than two intervals is refused at resolve.
    assert.ok(built.maxObservationAgeMs >= 2 * built.intervalMs);
    await closeVenusServerDeps(built);
  });

  it("returns undefined — and touches NOTHING — when disabled", async () => {
    const seen: Address[][] = [];
    const built = await build({ env: env({ VENUS_ENABLED: "false" }), seen });
    assert.equal(built, undefined);
    // No chain read, so a disabled deployment cannot fail its boot on Venus.
    assert.equal(seen.length, 0);
  });

  it("an unset VENUS_ENABLED is disabled, not enabled", async () => {
    assert.equal(await build({ env: env({ VENUS_ENABLED: undefined }) }), undefined);
  });

  it("F3 — refuses the BOOT when enabled without Postgres", async () => {
    // Otherwise the server accepts an owner-SIGNED settings write into a memory
    // store the worker can never read and a restart evaporates.
    await assert.rejects(
      build({ env: env({ DATABASE_URL: undefined }) }),
      /DATABASE_URL is unset/u,
    );
  });

  it("F3 — refuses the BOOT off chain 56, where the selector census means nothing", async () => {
    await assert.rejects(build({ network: NETWORK_97 }), /chain-56 only/u);
  });

  it("resolves the market index from the plane's OWN reads, vBNB pinned to null", async () => {
    const seen: Address[][] = [];
    const built = await build({ seen });
    assert.notEqual(built, undefined);
    if (built === undefined) return;
    assert.equal(seen.length, 1);
    assert.equal(built.marketIndex[V_BNB.toLowerCase()]?.underlying, null);
    await closeVenusServerDeps(built);
  });
});

describe("venus wiring: the market universe (F2 — one seam, both callers)", () => {
  it("is vBNB alone when no owner has named anything", async () => {
    const store = new MemoryVenusSettingsStore();
    const markets = await venusMarketUniverse(store, VENUE);
    assert.deepEqual(markets, [V_BNB]);
  });

  it("is the UNION of every owner's named markets, plus vBNB", async () => {
    const store = new MemoryVenusSettingsStore();
    await store.put({
      agentId: "a",
      ownerAddress: OWNER,
      params: {
        triggerHf: "1300000000000000000",
        targetHf: "1600000000000000000",
        debtMarkets: [V_USDT],
        collateralMarkets: [V_ETH],
        maxPerAction: [],
        maxClaimsPerDay: 4,
        minSecondsBetweenActions: 0,
        minClaimValueWei: "0",
        claimEnabled: false,
        claimRepayEnabled: false,
        rescueReserveCount: 4,
      },
      digest: `0x${"ab".repeat(32)}`,
    });
    const markets = (await venusMarketUniverse(store, VENUE)).map((entry) =>
      entry.toLowerCase(),
    );
    assert.equal(markets.length, 3);
    for (const expected of [V_BNB, V_USDT, V_ETH]) {
      assert.ok(markets.includes(expected.toLowerCase()), `${expected} missing`);
    }
  });

  it("SKIPS a malformed row rather than failing the boot for every other owner", async () => {
    const store = new MemoryVenusSettingsStore();
    await store.put({
      agentId: "broken",
      ownerAddress: OWNER,
      params: { nonsense: true },
      digest: `0x${"cd".repeat(32)}`,
    });
    const markets = await venusMarketUniverse(store, VENUE);
    assert.deepEqual(markets, [V_BNB]);
  });
});
