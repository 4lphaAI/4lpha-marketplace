/**
 * Golden vectors generated ONCE from the execution plane's own
 * `src/auth/canonical.ts` (node --import tsx, 2026-09-01) and PINNED here as
 * literals. The web port must reproduce them byte for byte — a divergence is a
 * consensus break that surfaces live as a generic 401 from the plane.
 */
import { describe, expect, it } from "vitest";
import { canonicalEncode, paramsHash } from "./owner-action";

const SETTINGS = {
  autoRotate: false,
  autoHarvest: false,
  rotateBandBps: 0,
  rotateMinHoldMinutes: 0,
  harvestMinFeesWei: "2000000000000000",
  stopLossPct: 10,
  takeProfitPct: 6,
  maxExitSequencesPerDay: 4,
  minMinutesBetweenExits: 30,
  brainEnabled: false,
  stakingEnabled: false,
  accumulateMode: "compound",
  minAprBps: 0,
  exitToQuote: true,
  grid: {
    pool: {
      token0: "0xBB4CDb9CBd36B01bD1cBaEBF2De08d9173bc095c",
      token1: "0x55d398326f99059fF775485246999027B3197955",
      fee: 100,
    },
    wbnbIsToken0: true,
    tickSpacing: 1,
    buyRange: { tickLower: -23020, tickUpper: -22990 },
    sellRange: { tickLower: -23080, tickUpper: -23050 },
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
  },
};

describe("canonicalEncode (golden vectors from src/auth/canonical.ts)", () => {
  it("pins the nonce-consumed Account read-session consent", () => {
    expect(paramsHash("createAccountReadSession", {})).toBe(
      "0x2e6d67dd7d9faa24957dd83cd051f06c911a2b6b4547a2cf9b3d7e90d9ac7ccc",
    );
  });
  it("sorts keys, drops undefined, lowercases addresses", () => {
    expect(
      canonicalEncode({
        b: 1,
        a: "x",
        c: null,
        d: undefined,
        addr: "0xBB4CDb9CBd36B01bD1cBaEBF2De08d9173bc095c",
      }),
    ).toBe('{"a":"x","addr":"0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c","b":n1,"c":null}');
  });

  it("tags numbers vs strings, keeps array order, recurses", () => {
    expect(canonicalEncode({ arr: [1, "1", true, { z: 2, y: [3] }], num: 1.5, neg: -0 })).toBe(
      '{"arr":[n1,"1",true,{"y":[n3],"z":n2}],"neg":n0,"num":n1.5}',
    );
  });

  it("encodes the full gridArm params object identically to the plane", () => {
    expect(canonicalEncode({ settings: SETTINGS, budgetWei: "20000000000000000" })).toBe(
      '{"budgetWei":"20000000000000000","settings":{"accumulateMode":"compound","autoHarvest":false,"autoRotate":false,"brainEnabled":false,"exitToQuote":true,"grid":{"buyRange":{"tickLower":n-23020,"tickUpper":n-22990},"maxFlipsPerDay":n12,"minNetEdgeBps":n0,"pool":{"fee":n100,"token0":"0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c","token1":"0x55d398326f99059ff775485246999027b3197955"},"sellRange":{"tickLower":n-23080,"tickUpper":n-23050},"tickSpacing":n1,"wbnbIsToken0":true},"harvestMinFeesWei":"2000000000000000","maxExitSequencesPerDay":n4,"minAprBps":n0,"minMinutesBetweenExits":n30,"rotateBandBps":n0,"rotateMinHoldMinutes":n0,"stakingEnabled":false,"stopLossPct":n10,"takeProfitPct":n6}}',
    );
  });
});

describe("paramsHash (golden vectors)", () => {
  it("gridArm", () => {
    expect(paramsHash("gridArm", { settings: SETTINGS, budgetWei: "20000000000000000" })).toBe(
      "0xd8f1d4887262f70d4a3a29f94d7ceff4f779bb21112958ba1b8b219be29d1134",
    );
  });
  it("lpSettings", () => {
    expect(paramsHash("lpSettings", SETTINGS)).toBe(
      "0xa14408fc5fed2935685f92563189d1e85e57c8121365c4209947a7ac9d5f1733",
    );
  });
  // MARKETPLACE-LENDING-AGENT: computed by the PLANE's own
  // `src/auth/canonical.ts` at build time, so a divergence in this browser port
  // fails here rather than as a generic 401 from a live hire.
  it("lendingArm / lendingSettings / lendingRetire", () => {
    const lendingSettings = {
      triggerHf: "1200000000000000000",
      targetHf: "1500000000000000000",
      maxPerAction: [{ token: "0x55d398326f99059fF775485246999027B3197955", maxWei: "240000000000000000000" }],
      minSecondsBetweenActions: 300,
      rescueReserveCount: 6,
    };
    expect(paramsHash("lendingArm", { settings: lendingSettings, budgetWei: "50000000000000000", reserveBps: 2000 })).toBe(
      "0x19f65adaabaa769239febe9661e8b4c002bd6f83b95a4f68291e13a7f17edc26",
    );
    expect(paramsHash("lendingSettings", lendingSettings)).toBe(
      "0x4f2e1c3462943819f2d2ef796a5259f9bc84598a889699d40411252e4983b8c8",
    );
    expect(paramsHash("lendingRetire", { acceptPartial: true })).toBe(
      "0xba36ebdc16d99fc347e0d2541a16849525cf9210dd22305f877c1f7c1a4dc7b7",
    );
  });
  it("read over empty params", () => {
    expect(paramsHash("read", {})).toBe(
      "0xc66fca071fdcb969e9845c1a46fb3761f2bf2475b38046aba69be46c5a29591c",
    );
  });
});
