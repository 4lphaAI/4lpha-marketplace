/**
 * PHASE3.15 — the `grid` settings block: structural parse, CONDITIONAL view
 * emission, the digest tripwire, and every rule `validateLpSettings` owns.
 *
 * TWO POOL ORDERINGS THROUGHOUT. The ordering constraint is
 * ORIENTATION-CONDITIONED (R2.2/OQ1) and the spec's first draft wrote it
 * unconditionally, which inverts it for every pool where WBNB sorts into
 * token0 — the 3.13 F7 finding, reproduced in a validation rule (review H1).
 * Every case below that depends on a side is written twice.
 *
 * OFFLINE, pure: parse, validate, view, hash. No store, no chain, no clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { paramsHash } from "../src/auth/canonical.js";
import {
  defaultLpSettingsParams,
  lpSettingsParamsView,
  parseLpSettingsParams,
} from "../src/http/lpWire.js";
import {
  DEFAULT_LP_SETTINGS,
  validateLpSettings,
  type LpAutomationSettings,
  type LpGridSettings,
} from "../src/lp/triggers.js";
import { DEFAULT_SETTINGS_DIGEST } from "../src/lp/worker.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
/** Sorts BELOW WBNB ⇒ WBNB is token1 ⇒ `wbnbIsToken0 === false` (Case A). */
const TOKEN_LO = getAddress("0x00000000000000000000000000000000000000AA");
/** Sorts ABOVE WBNB ⇒ WBNB is token0 ⇒ `wbnbIsToken0 === true` (Case B). */
const TOKEN_HI = getAddress("0xCC00000000000000000000000000000000000000");

/**
 * Case A — quote is token1. The quote-holding (buy) range is on the side of the
 * price that charges token1, i.e. AT OR BELOW it, so `buy.tickUpper <=
 * sell.tickLower`.
 */
function caseAGrid(overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  return {
    pool: { token0: TOKEN_LO, token1: WBNB, fee: 2_500 },
    wbnbIsToken0: false,
    tickSpacing: 50,
    buyRange: { tickLower: -1_000, tickUpper: -500 },
    sellRange: { tickLower: 500, tickUpper: 1_000 },
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
    ...overrides,
  };
}

/**
 * Case B — quote is token0. The buy range is ABOVE the price, so the constraint
 * INVERTS: `sell.tickUpper <= buy.tickLower`.
 */
function caseBGrid(overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  return {
    pool: { token0: WBNB, token1: TOKEN_HI, fee: 2_500 },
    wbnbIsToken0: true,
    tickSpacing: 50,
    buyRange: { tickLower: 500, tickUpper: 1_000 },
    sellRange: { tickLower: -1_000, tickUpper: -500 },
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
    ...overrides,
  };
}

function withGrid(grid: LpGridSettings | null): LpAutomationSettings {
  return { ...DEFAULT_LP_SETTINGS, grid };
}

/* -------------------------------------------------------------------------- */
/* R2.12 — the digest tripwire                                                */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.12: the grid key is emitted ONLY when set", () => {
  it("the default VIEW carries no grid key at all", () => {
    const view = defaultLpSettingsParams();
    assert.equal("grid" in view, false);
    assert.equal(DEFAULT_LP_SETTINGS.grid, null);
  });

  it("DEFAULT_SETTINGS_DIGEST did not move — the tripwire, restated here", () => {
    // `test/lp.rotateMode.test.ts` holds the LITERAL golden vector and is NOT
    // edited by this phase: a `grid` key emitted at its default IS a failure of
    // that test, by design. This assertion is the same fact from the other end
    // — the route's computation and the worker's constant still agree — so a
    // reader of THIS file learns the rule without having to find that one.
    assert.equal(
      paramsHash("lpSettings", defaultLpSettingsParams()),
      DEFAULT_SETTINGS_DIGEST,
    );
  });

  it("a grid row round-trips through the view KEEPING the key, and hashes differently", () => {
    const grid = caseAGrid();
    const view = lpSettingsParamsView(withGrid(grid));
    assert.notEqual(view["grid"], undefined);
    const round = parseLpSettingsParams(view);
    assert.ok(round.ok);
    if (round.ok) assert.deepEqual(round.value.grid, grid);
    assert.notEqual(paramsHash("lpSettings", view), DEFAULT_SETTINGS_DIGEST);
  });

  it("a stored row WITHOUT the key parses to null — the additive migration", () => {
    const legacy = { ...defaultLpSettingsParams() };
    delete legacy["grid"];
    const parsed = parseLpSettingsParams(legacy);
    assert.ok(parsed.ok);
    if (parsed.ok) assert.equal(parsed.value.grid, null);
  });

  it("an explicit null CLEARS the block — the one-way-rollback procedure", () => {
    const parsed = parseLpSettingsParams({
      ...defaultLpSettingsParams(),
      grid: null,
    });
    assert.ok(parsed.ok);
    if (parsed.ok) assert.equal(parsed.value.grid, null);
    // And clearing it drops the key from the view again, so the digest returns
    // to the default one.
    if (parsed.ok) {
      assert.equal("grid" in lpSettingsParamsView(parsed.value), false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The structural parse (lpWire's half of the M16 split)                      */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15: the grid block's STRUCTURAL parse", () => {
  const base = defaultLpSettingsParams();
  const wire = (grid: unknown): ReturnType<typeof parseLpSettingsParams> =>
    parseLpSettingsParams({ ...base, autoRotate: false, autoHarvest: false, grid });

  it("refuses an unknown key inside the block (the fence posture)", () => {
    const parsed = wire({
      ...lpSettingsParamsView(withGrid(caseAGrid()))["grid"] as Record<string, unknown>,
      surprise: 1,
    });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.message, /unexpected field "surprise"/u);
  });

  it("refuses a non-integer tick, a non-object range and a bad address", () => {
    const good = lpSettingsParamsView(withGrid(caseAGrid()))["grid"] as Record<string, unknown>;
    const badTick = wire({ ...good, buyRange: { tickLower: 1.5, tickUpper: -500 } });
    assert.equal(badTick.ok, false);
    const badRange = wire({ ...good, sellRange: 7 });
    assert.equal(badRange.ok, false);
    const badPool = wire({ ...good, pool: { token0: "nope", token1: WBNB, fee: 2_500 } });
    assert.equal(badPool.ok, false);
  });

  it("refuses a block missing one of the two ranges", () => {
    const good = { ...(lpSettingsParamsView(withGrid(caseAGrid()))["grid"] as Record<string, unknown>) };
    delete good["sellRange"];
    const parsed = wire(good);
    assert.equal(parsed.ok, false);
  });
});

/* -------------------------------------------------------------------------- */
/* validateLpSettings — the ranges and ordering (R2.8)                        */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.2/H1: the ordering constraint is ORIENTATION-CONDITIONED", () => {
  it("Case A (wbnbIsToken0 false): the BUY range must be at or below the sell range", () => {
    assert.doesNotThrow(() => validateLpSettings(withGrid(caseAGrid())));
    // The very rule the spec's first draft wrote unconditionally, INVERTED:
    // under this orientation it is wrong and must be refused.
    assert.throws(
      () =>
        validateLpSettings(
          withGrid(
            caseAGrid({
              buyRange: { tickLower: 500, tickUpper: 1_000 },
              sellRange: { tickLower: -1_000, tickUpper: -500 },
            }),
          ),
        ),
      /overlap or are ordered wrongly/u,
    );
  });

  it("Case B (wbnbIsToken0 true): the constraint INVERTS — buy sits ABOVE sell", () => {
    assert.doesNotThrow(() => validateLpSettings(withGrid(caseBGrid())));
    // And the Case-A ordering is REFUSED here. Without the orientation
    // conjunct this pair would pass, and every flip on roughly half of BSC's
    // WBNB pools would mint the wrong asset into the wrong level.
    assert.throws(
      () =>
        validateLpSettings(
          withGrid(
            caseBGrid({
              buyRange: { tickLower: -1_000, tickUpper: -500 },
              sellRange: { tickLower: 500, tickUpper: 1_000 },
            }),
          ),
        ),
      /overlap or are ordered wrongly/u,
    );
  });

  it("touching ranges are legal in BOTH orderings; overlapping ones are not", () => {
    assert.doesNotThrow(() =>
      validateLpSettings(
        withGrid(
          caseAGrid({
            buyRange: { tickLower: -1_000, tickUpper: -500 },
            sellRange: { tickLower: -500, tickUpper: 0 },
          }),
        ),
      ),
    );
    assert.throws(
      () =>
        validateLpSettings(
          withGrid(
            caseAGrid({
              buyRange: { tickLower: -1_000, tickUpper: -450 },
              sellRange: { tickLower: -500, tickUpper: 0 },
            }),
          ),
        ),
      /overlap or are ordered wrongly/u,
    );
  });
});

describe("PHASE3.15 R2.8: spacing, width and the numeric bounds", () => {
  it("refuses a tick that is not aligned to the SIGNED spacing, in both orderings", () => {
    for (const build of [caseAGrid, caseBGrid]) {
      const grid = build();
      assert.throws(
        () =>
          validateLpSettings(
            withGrid({ ...grid, buyRange: { ...grid.buyRange, tickLower: grid.buyRange.tickLower + 1 } }),
          ),
        /not aligned to the pool's tick spacing/u,
      );
    }
  });

  it("refuses a range narrower than one spacing", () => {
    const grid = caseAGrid({ tickSpacing: 200 });
    assert.throws(
      () => validateLpSettings(withGrid(grid)),
      /not aligned|at least one tick spacing/u,
    );
  });

  it("refuses a malformed tickSpacing rather than deriving one from the fee tier", () => {
    // R2.13: no fee -> spacing constant table is introduced. The signed value is
    // bounded here and CROSS-CHECKED against the pool at the route.
    assert.throws(
      () => validateLpSettings(withGrid(caseAGrid({ tickSpacing: 0 }))),
      /grid\.tickSpacing/u,
    );
  });

  it("bounds maxFlipsPerDay to 1..24 and minNetEdgeBps to 0..10000", () => {
    assert.throws(
      () => validateLpSettings(withGrid(caseAGrid({ maxFlipsPerDay: 0 }))),
      /maxFlipsPerDay must be an integer in 1\.\.24/u,
    );
    assert.throws(
      () => validateLpSettings(withGrid(caseAGrid({ maxFlipsPerDay: 25 }))),
      /maxFlipsPerDay must be an integer in 1\.\.24/u,
    );
    assert.throws(
      () => validateLpSettings(withGrid(caseAGrid({ minNetEdgeBps: -1 }))),
      /minNetEdgeBps/u,
    );
  });

  it("refuses a pool whose legs are not in pool order, or an unknown fee tier", () => {
    assert.throws(
      () =>
        validateLpSettings(
          withGrid(caseAGrid({ pool: { token0: WBNB, token1: TOKEN_LO, fee: 2_500 } })),
        ),
      /pool order/u,
    );
    assert.throws(
      () =>
        validateLpSettings(
          withGrid(caseAGrid({ pool: { token0: TOKEN_LO, token1: WBNB, fee: 3_000 } })),
        ),
      /grid\.pool\.fee/u,
    );
  });
});

describe("PHASE3.15 C3/H8: an unreachable maxFlipsPerDay is REFUSED, not ignored", () => {
  it("refuses when minMinutesBetweenExits makes the flip count unreachable", () => {
    // The spacing gate is agent-wide and unfiltered, so at 120 minutes an agent
    // gets at most 12 sequences a day. Asking for 13 is a setting that quietly
    // means nothing — the (ae) shape.
    const settings = {
      ...withGrid(caseAGrid({ maxFlipsPerDay: 13 })),
      minMinutesBetweenExits: 120,
    };
    assert.throws(
      () => validateLpSettings(settings),
      /unreachable: minMinutesBetweenExits 120 allows at most 12/u,
    );
    // Exactly at the boundary is fine.
    assert.doesNotThrow(() =>
      validateLpSettings({
        ...withGrid(caseAGrid({ maxFlipsPerDay: 12 })),
        minMinutesBetweenExits: 120,
      }),
    );
  });

  it("the refusal lives in the ONE validator, so the worker's parse enforces it too", () => {
    // M4/M16: a route-only check is a rule `worker.ts`'s
    // `parseLpSettingsParams` would honour a stored row against. Proving it
    // through the WIRE path is proving it for the worker.
    const params = lpSettingsParamsView({
      ...withGrid(caseAGrid({ maxFlipsPerDay: 13 })),
      minMinutesBetweenExits: 120,
    });
    const parsed = parseLpSettingsParams(params);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.message, /unreachable/u);
  });
});

describe("PHASE3.15: a grid agent may not also sign standard automation", () => {
  it("refuses grid + autoRotate and grid + autoHarvest, naming why", () => {
    for (const flag of ["autoRotate", "autoHarvest"] as const) {
      assert.throws(
        () => validateLpSettings({ ...withGrid(caseAGrid()), [flag]: true }),
        /runs the ping-pong and nothing else/u,
      );
    }
  });

  it("exitToQuote and the price triggers stay meaningful alongside a grid", () => {
    assert.doesNotThrow(() =>
      validateLpSettings({
        ...withGrid(caseAGrid()),
        exitToQuote: false,
        priceStopLoss: {
          token0: TOKEN_LO,
          token1: WBNB,
          fee: 2_500,
          tick: -2_000,
          when: "at-or-below",
        },
      }),
    );
  });
});
