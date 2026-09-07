/**
 * PHASE3.15 — the owner-signed surfaces: the grid block's CHAIN-and-CONFIG
 * admission at `POST /lp/settings`, the grid arm of `POST /lp/import`, and the
 * `grid` section of `GET /agents/:id/lp`.
 *
 * THE PHASE ADDS NO ROUTE FAMILY, and that is the design. There is no grid
 * open: `/lp/open` refuses any range that does not contain the tick and refuses
 * a single-sided deposit, both deliberately and both pre-money, and a grid
 * level is single-sided and out of range BY CONSTRUCTION. So the owner mints
 * their first level by hand on PancakeSwap and IMPORTS it — which deletes a
 * whole saga runner, deletes the phase's only native-attaching surface, and
 * makes the restart path after an abandon fall out for free (the inventory is
 * already the asset the next level wants).
 *
 * Offline: the shared server harness over memory stores and a fake chain.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import {
  NOW_SEC,
  ROUTER_V3,
  SESSION_KEY,
  TOKEN,
  WBNB,
  call,
  createHarness,
  ownerAccount,
  signOwnerAction,
  toReadHeader,
  type Harness,
} from "./support/serverHarness.js";
import type { SessionFacts } from "../src/store/agents.js";
import type { SessionSpec } from "../src/core/types.js";
import type { LpPoolStateReading, LpServerDeps } from "../src/server.js";
import { MemoryLpSequenceStore } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import {
  MemoryLpGridCycleStore,
  type LpGridCycleStore,
} from "../src/store/gridCycles.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpRuntimeConfig } from "../src/ops/config.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import { DEFAULT_LP_SETTINGS, type LpGridSettings } from "../src/lp/triggers.js";

const AGENT_ID = "agent-grid-routes";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const TOKEN_ID = "4242";

const RAILS: LpRailConfig = {
  maxPriceImpactBps: 300,
  maxSpotTwapDeviationBps: 500,
  minObservationCardinality: 10,
  minPoolLiquidity: 1_000n,
  twapWindowSeconds: 300,
  maxSagaSlippageBps: 100,
};

const RUNTIME: LpRuntimeConfig = {
  rankingMaxAgeSec: 300,
  maxTickWidth: 200_000,
  defaultOpenWidthTicks: 1_000,
  maxRankedCandidates: 10,
  knownStakers: [],
  conversionCompatibleTokens: new Set(),
  resolveMinAgeSec: 1_800,
  resolveDiscriminatingMultipleBps: 12_000,
};

/**
 * THE SHARED FIXTURE'S POOL IS CASE B, and that is worth stating rather than
 * discovering: `WBNB` is `0x2222…` and `TOKEN` is `0x5555…`, so WBNB sorts into
 * TOKEN0 and `wbnbIsToken0 === true`. Under that orientation the quote-holding
 * BUY level sits ABOVE the sell level (`sellRange.tickUpper <=
 * buyRange.tickLower`) — the inverse of the constraint the spec's first draft
 * wrote unconditionally, and the half of BSC's pools a role-named side rule
 * gets wrong.
 */
const BUY = { tickLower: 500, tickUpper: 1_000 };
const SELL = { tickLower: -1_000, tickUpper: -500 };

function grid(overrides: Partial<LpGridSettings> = {}): LpGridSettings {
  return {
    pool: { token0: WBNB, token1: TOKEN, fee: 2_500 },
    wbnbIsToken0: true,
    tickSpacing: 50,
    buyRange: BUY,
    sellRange: SELL,
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
    ...overrides,
  };
}

function lpSessionSpec(expiresAt: number): SessionSpec {
  return {
    allowedCalls: [
      { to: ROUTER_V3 },
      { to: TOKEN, selector: "approve(address,uint256)" },
      { to: WBNB, selector: "approve(address,uint256)" },
    ],
    spendCaps: [
      { limit: 10n ** 18n, period: "day" },
      { limit: 2n ** 160n, period: "day", token: TOKEN },
      { limit: 2n ** 160n, period: "day", token: WBNB },
    ],
    expiresAt,
  };
}

function lpSessionFacts(expiresAt: number): SessionFacts {
  return {
    spec: lpSessionSpec(expiresAt),
    permissions: { calls: [], spend: [] },
    publicKey: `0x04${"ab".repeat(64)}` as Hex,
    expiry: expiresAt,
  };
}

/**
 * The live level: a hand-minted single-sided BUY range order, strictly out of
 * range on the quote side. At tick 0 the range [500, 1000) is "above" the
 * price, and a range above the tick charges TOKEN0 — which under this
 * orientation is WBNB, the quote. That is what "the level holds quote" means in
 * pool order.
 */
function buySnapshot(
  overrides: Partial<LpPositionSnapshot> = {},
): LpPositionSnapshot {
  return {
    // Sized so the R2.10 net-edge admission CLEARS at this spread: the gas
    // floor is 2 x LP_RELAY_FEE_PER_SUBMIT_WEI over the level value, so a tiny
    // level is refused on economics before any geometry is reached.
    liquidity: 10n ** 18n,
    ...BUY,
    operator: zeroAddress,
    token0: WBNB,
    token1: TOKEN,
    fee: 2_500,
    ...overrides,
  };
}

type Fixture = {
  readonly harness: Harness;
  readonly lpStore: MemoryLpSequenceStore;
  readonly settingsStore: MemoryLpSettingsStore;
  readonly observations: MemoryLpObservationStore;
  readonly cycles: MemoryLpGridCycleStore;
  readonly chain: {
    snapshot: LpPositionSnapshot | "burned";
    tick: number;
    owner: Address | "burned";
    liveCapWei: bigint;
  };
};

async function fixture(
  options: {
    readonly gridEnabled?: boolean;
    readonly settingsGrid?: LpGridSettings | null;
    readonly cycleStore?: "configured" | "absent" | "throwing";
    readonly accountReadSession?: boolean;
    /** LP-DEPLOY liquidity chart: the optional profile reader, or a throwing one. */
    readonly tickLiquidity?: "absent" | "throwing" | "scripted";
    /** HOTFIX 2026-09-05: make the rails' TWAP read revert (young pool). */
    readonly poolStateThrows?: boolean;
  } = {},
): Promise<Fixture> {
  const lpStore = new MemoryLpSequenceStore();
  const settingsStore = new MemoryLpSettingsStore();
  const observations = new MemoryLpObservationStore();
  const cycles = new MemoryLpGridCycleStore();
  const chain: Fixture["chain"] = {
    snapshot: buySnapshot(),
    tick: 0,
    owner: ownerAccount.address,
    liveCapWei: 10n ** 18n,
  };

  const state = (): LpPoolStateReading => ({
    pool: POOL,
    tickSpacing: 50,
    currentTick: chain.tick,
    evidence: {
      blockNumber: 100n,
      finalizedBlockNumber: 100n,
      observationCardinality: 500,
      poolLiquidity: 10n ** 24n,
      priceImpactBps: 0n,
      spotSqrtPriceX96: 2n ** 96n,
      twapSqrtPriceX96: 2n ** 96n,
    },
  });

  const throwingCycles: LpGridCycleStore = {
    record: async () => undefined,
    list: async () => {
      throw new Error("private database detail");
    },
    close: async () => undefined,
  };
  const cycleStore = options.cycleStore ?? "configured";
  const lp: LpServerDeps = {
    store: lpStore,
    settingsStore,
    observations,
    workerIntervalMs: 60_000,
    railsResult: { ok: true, config: RAILS },
    runtime: RUNTIME,
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    ...(cycleStore === "absent"
      ? {}
      : { gridCycles: cycleStore === "throwing" ? throwingCycles : cycles }),
    ...(options.gridEnabled === undefined ? {} : { gridEnabled: options.gridEnabled }),
    readers: {
      getPool: async () => POOL,
      poolState: async () => {
        if (options.poolStateThrows === true) throw new Error("execution reverted: OLD");
        return state();
      },
      ...(options.tickLiquidity === undefined || options.tickLiquidity === "absent"
        ? {}
        : {
            tickLiquidity: async (pool: Address, input: { readonly windowBins: number }) => {
              if (options.tickLiquidity === "throwing") throw new Error("rpc down: private detail");
              const spacing = 50;
              const bins = [];
              for (let bin = -input.windowBins; bin <= input.windowBins; bin += 1) {
                bins.push({ tickLower: bin * spacing, liquidity: BigInt(1_000 + Math.abs(bin)) });
              }
              return {
                pool,
                blockNumber: 12_345n,
                currentTick: 7,
                tickSpacing: spacing,
                activeLiquidity: 1_000n,
                bins,
                truncated: false,
              };
            },
          }),
      positions: async () => chain.snapshot,
      positionFees: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
      ownerOf: async () => chain.owner,
      quote: async (params) => params.amountInWei,
      receipts: {
        collectAmounts: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
        swapAmounts: async () => {
          throw new Error("unused");
        },
        mintedTokenId: async () => 777n,
      },
      onChainNativeDailyCapWei: async () => chain.liveCapWei,
    },
  };

  const harness = await createHarness({
    lp,
    ...(options.accountReadSession !== true
      ? {}
      : {
          config: {
            accountReadSession: {
              key: parseAccountReadSessionSecret("cd".repeat(32))!,
              chainId: 97,
              environment: resolveDomainSalt({ chainId: 97, network: "testnet" }),
            },
          },
        }),
  });
  await harness.agentStore.createAgent({
    id: AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: lpSessionFacts(NOW_SEC + 3_600),
    status: "armed",
  });
  await harness.agentStore.putAgentSessionKey(
    ownerAccount.address,
    AGENT_ID,
    SESSION_KEY,
  );
  if (options.settingsGrid !== undefined) {
    const params = lpSettingsParamsView({
      ...DEFAULT_LP_SETTINGS,
      grid: options.settingsGrid,
    });
    await settingsStore.put({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      params,
      digest: paramsHash("lpSettings", params),
    });
  }
  return { harness, lpStore, settingsStore, observations, cycles, chain };
}

async function settingsCall(
  f: Fixture,
  gridBlock: LpGridSettings | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, grid: gridBlock });
  const envelope = await signOwnerAction("lpSettings", params, { agentId: AGENT_ID });
  return call(f.harness, `/agents/${AGENT_ID}/lp/settings`, {
    method: "POST",
    body: envelope,
  });
}

async function importCall(
  f: Fixture,
  params: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope = await signOwnerAction("lpImport", params, { agentId: AGENT_ID });
  return call(f.harness, `/agents/${AGENT_ID}/lp/import`, {
    method: "POST",
    body: envelope,
  });
}

async function viewCall(f: Fixture): Promise<Record<string, unknown>> {
  const envelope = await signOwnerAction("read", {}, { agentId: AGENT_ID });
  const response = await call(f.harness, `/agents/${AGENT_ID}/lp`, {
    headers: { "x-owner-action": toReadHeader(envelope) },
  });
  return (response.body["data"] ?? {}) as Record<string, unknown>;
}

function reason(body: Record<string, unknown>): string {
  const error = body["error"] as { message?: string } | undefined;
  return error?.message ?? "";
}

/* -------------------------------------------------------------------------- */
/* The settings route                                                         */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15: POST /lp/settings — the grid block's chain-and-config admission", () => {
  it("REFUSES a grid block while GRID_ENABLED is off, so nobody signs dead settings", async () => {
    const f = await fixture({ gridEnabled: false });
    const response = await settingsCall(f, grid());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /has not enabled the grid agent/u);
    // And nothing was stored: the refusal is BEFORE the write.
    assert.equal(await f.settingsStore.get(ownerAccount.address, AGENT_ID), null);
  });

  it("arms a first grid and reports the pool evidence and the entry instruction", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await settingsCall(f, grid());
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    const evidence = data["grid"] as Record<string, unknown>;
    assert.equal(evidence["armed"], "first");
    assert.equal(evidence["wbnbIsToken0"], true);
    assert.equal(evidence["tickSpacing"], 50);
    // PHASE3.16 M3: the ENTRY PATH is now the arm, and this note is one of the
    // five texts that named the workflow the arm replaces. Hand-minting and
    // importing is still legal and is still described — second, as the door it
    // now is rather than as the only one.
    assert.match(String(evidence["note"]), /Sign gridArm/u);
    assert.match(String(evidence["note"]), /mint a single-sided range order by hand/iu);
    assert.match(String(evidence["note"]), /basisWei 0/u);
  });

  it("C1: a SIGNED orientation that disagrees with the pool is REFUSED, naming both", async () => {
    const f = await fixture({ gridEnabled: true });
    // The pool has WBNB as TOKEN0; claiming token1 would invert every side rule
    // the grid makes — the 3.13 F7 shape, signed rather than derived. The
    // ordering constraint follows the CLAIM, so the block is internally
    // consistent and ONLY the cross-check against the pool can catch it.
    const response = await settingsCall(
      f,
      grid({ wbnbIsToken0: false, buyRange: SELL, sellRange: BUY }),
    );
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /grid\.wbnbIsToken0 \(false\) does not match this pool/u);
    assert.match(reason(response.body), /WBNB is token0 here/u);
  });

  it("C1: a SIGNED tickSpacing that disagrees with the pool is REFUSED", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await settingsCall(
      f,
      // Every signed tick is a multiple of 10 too, so `validateLpSettings`
      // passes and ONLY the route's cross-check against the pool can catch it.
      grid({ tickSpacing: 10 }),
    );
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /does not match the pool's own \(50\)/u);
    assert.match(reason(response.body), /would revert at the mint/u);
  });

  it("the LP_MAX_TICK_WIDTH ceiling is CONFIG, so it is enforced at the route", async () => {
    const f = await fixture({ gridEnabled: true });
    const response = await settingsCall(
      f,
      grid({ buyRange: { tickLower: 500, tickUpper: 400_000 } }),
    );
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /over this deployment's LP_MAX_TICK_WIDTH/u);
  });

  it("M3: the IDLE GATE applies at FIRST ARMING only", async () => {
    const f = await fixture({ gridEnabled: true });
    await f.lpStore.createPosition({
      positionId: "legacy",
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2_500,
      tokenId: "999",
      basisWei: 10n ** 18n,
    });
    const response = await settingsCall(f, grid());
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /that predate the grid/u);
    assert.match(reason(response.body), /which position is the grid level/u);
  });

  it("C2: a re-sign under a LIVE level must keep one range equal to it", async () => {
    // Already a grid agent, with the live level at the signed BUY range.
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    await f.lpStore.createPosition({
      positionId: "grid-level",
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2_500,
      tokenId: TOKEN_ID,
      basisWei: 0n,
      basisSource: "imported",
    });

    // Moving BOTH ranges leaves the live level matching neither, so the flip's
    // target would be undefined. Refused, naming the remedy.
    const moved = await settingsCall(
      f,
      grid({
        buyRange: { tickLower: 1_500, tickUpper: 2_000 },
        sellRange: { tickLower: -2_000, tickUpper: -1_500 },
      }),
    );
    assert.equal(moved.status, 400);
    // PHASE3.17 R3.1 AMENDMENT: C2 now iterates EVERY live level and matches
    // each against the UP-TO-FOUR signed ranges, so the sentence names every
    // range rather than pair 1's two. The REFUSAL and its remedy are the same.
    assert.match(reason(moved.body), /equals none of the NEW signed ranges/u);
    assert.match(reason(moved.body), /Keep one range equal to each live level/u);

    // Moving only the OTHER range is accepted, and the net-edge admission is
    // RE-RUN at the live level's current value.
    const ok = await settingsCall(
      f,
      grid({ sellRange: { tickLower: -2_000, tickUpper: -1_500 } }),
    );
    assert.equal(ok.status, 200);
    const evidence = (ok.body["data"] as Record<string, unknown>)["grid"] as Record<
      string,
      unknown
    >;
    assert.equal(evidence["armed"], "re-signed");
    const netEdge = evidence["netEdge"] as Record<string, unknown>;
    assert.equal(netEdge["ok"], true);
    assert.match(String(netEdge["note"]), /RELAY GAS ONLY/u);
  });

  it("C2: a re-sign that narrows the spread below the gas floor is REFUSED", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    await f.lpStore.createPosition({
      positionId: "grid-level",
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2_500,
      tokenId: TOKEN_ID,
      basisWei: 0n,
      basisSource: "imported",
    });
    // Keep the live BUY range, and demand an absurd owner minimum: the
    // admission that only ever ran at import is re-run here, which is the whole
    // of C2's second half.
    const response = await settingsCall(f, grid({ minNetEdgeBps: 10_000 }));
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /Grid re-sign refused/u);
    assert.match(reason(response.body), /does not cover one flip's relay gas/u);
    // A PINNED RESIDUAL: `sanitizeMessage` caps a route error at 280
    // characters, so the refusal's HONEST-SCOPE tail is clipped here. The
    // numbers and the remedy lead precisely because of that ceiling; the full
    // sentence survives on the surfaces that are not capped.
    assert.ok(reason(response.body).length <= 280);
  });

  it("clearing the block needs no chain read and is always allowed", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    const response = await settingsCall(f, null);
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal("grid" in data, false, "no grid evidence when there is no grid");
    const settings = data["settings"] as Record<string, unknown>;
    assert.equal("grid" in settings, false, "and the key leaves the stored view");
  });
});

/* -------------------------------------------------------------------------- */
/* The import route                                                           */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.1: POST /lp/import — the grid's ONLY entry path", () => {
  async function gridFixture(): Promise<Fixture> {
    return fixture({ gridEnabled: true, settingsGrid: grid() });
  }

  it("admits a hand-minted single-sided level and names the flip's target", async () => {
    const f = await gridFixture();
    const response = await importCall(f, { tokenId: TOKEN_ID, basisWei: "0" });
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    const evidence = data["grid"] as Record<string, unknown>;
    assert.equal(evidence["role"], "buy");
    // Case B: the buy level holds token0 = WBNB, which a range strictly ABOVE
    // the tick charges — so the side is "above".
    assert.equal(evidence["side"], "above");
    assert.deepEqual(evidence["targetRange"], SELL);
    assert.match(String(evidence["note"]), /Admitted as the buy level/u);
    assert.match(String(evidence["note"]), /two finalized evaluations/u);
    const netEdge = evidence["netEdge"] as Record<string, unknown>;
    assert.equal(netEdge["ok"], true);
    // C5: the exit probe needed NO grid-specific skip. `probeLpExitImpact`
    // short-circuits a zero `amountInWei`, so a pure-WBNB level admits through
    // the route's existing probe.
    const assessment = data["assessment"] as Record<string, unknown>;
    const probe = assessment["exitProbe"] as Record<string, unknown>;
    assert.equal(probe["withinRail"], true);
  });

  it("REFUSES a level whose ticks equal neither signed range, naming both", async () => {
    const f = await gridFixture();
    f.chain.snapshot = buySnapshot({ tickLower: -900, tickUpper: -400 });
    const response = await importCall(f, { tokenId: TOKEN_ID, basisWei: "0" });
    assert.equal(response.status, 400);
    // PHASE3.17 R2.5 AMENDMENT: the import refusal names every signed range —
    // a dual grid has four, so "neither" and "the two" were both false. The
    // VERBATIM rule and the reason for it are unchanged.
    assert.match(reason(response.body), /equals none of this grid's signed ranges/u);
    assert.match(reason(response.body), /must be one of the signed ranges VERBATIM/u);
  });

  it("REFUSES a level in a different pool from the signed grid", async () => {
    const f = await gridFixture();
    f.chain.snapshot = buySnapshot({ fee: 500 });
    const response = await importCall(f, { tokenId: TOKEN_ID, basisWei: "0" });
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /different pool from the signed grid/u);
    assert.match(reason(response.body), /fee 500 vs/u);
  });

  it("M8 conjunct 1 — REFUSES while the tick is INSIDE the level", async () => {
    const f = await gridFixture();
    f.chain.tick = 750; // inside the signed BUY range [500, 1000)
    const response = await importCall(f, { tokenId: TOKEN_ID, basisWei: "0" });
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /is INSIDE this level/u);
    assert.match(reason(response.body), /admitted single-sided and strictly out of range/u);
  });

  it("M8 conjunct 3 — REFUSES when the price has gapped THROUGH the level", async () => {
    const f = await gridFixture();
    // ABOVE the buy level: the range now charges token1 = the base token, and
    // a level holding WBNB (token0) has nothing on that side.
    f.chain.tick = 2_000;
    const response = await importCall(f, { tokenId: TOKEN_ID, basisWei: "0" });
    assert.equal(response.status, 400);
    assert.match(
      reason(response.body),
      /holds nothing|not cleanly single-sided/u,
      "either conjunct is a correct refusal; both name the gap",
    );
  });

  it("REFUSES a nonzero basis — value-basis TP/SL is structurally disabled", async () => {
    const f = await gridFixture();
    const response = await importCall(f, { tokenId: TOKEN_ID, basisWei: "1000" });
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /must be imported with basisWei 0/u);
    assert.match(reason(response.body), /Price triggers/u);
  });

  it("REFUSES while GRID_ENABLED is off, even for a signed grid block", async () => {
    const f = await fixture({ gridEnabled: false, settingsGrid: grid() });
    const response = await importCall(f, { tokenId: TOKEN_ID, basisWei: "0" });
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /GRID_ENABLED is off/u);
  });

  it("R2.10: the net-edge admission runs HERE, sized on the level's own exit value", async () => {
    const f = await fixture({
      gridEnabled: true,
      settingsGrid: grid({ minNetEdgeBps: 10_000 }),
    });
    const response = await importCall(f, { tokenId: TOKEN_ID, basisWei: "0" });
    assert.equal(response.status, 400);
    assert.match(reason(response.body), /Grid import refused/u);
    // The numbers and the remedy LEAD, because `sanitizeMessage` caps a route
    // error at 280 characters and the honest-scope tail is what falls past it.
    // That ordering is the same discipline PHASE3.13 F12-b applied to the
    // swapless builders, and the cap itself is that phase's standing residual.
    assert.match(reason(response.body), /Gross edge \d+ bps between the range midpoints/u);
    assert.match(reason(response.body), /plus your own 10000 bps minimum/u);
    assert.ok(reason(response.body).length <= 280);
  });

  it("a NON-grid agent's import is completely unaffected", async () => {
    const f = await fixture({ gridEnabled: true });
    f.chain.snapshot = buySnapshot({ tickLower: -1_000, tickUpper: 1_000 });
    const response = await importCall(f, { tokenId: TOKEN_ID, basisWei: "1000" });
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal("grid" in data, false, "no grid section without a grid block");
  });
});

/* -------------------------------------------------------------------------- */
/* The owner view                                                             */
/* -------------------------------------------------------------------------- */

describe("PHASE3.15 R2.11/L6: the grid section of GET /agents/:id/lp", () => {
  it("is ABSENT for a non-grid agent", async () => {
    const f = await fixture({ gridEnabled: true });
    const data = await viewCall(f);
    assert.equal("grid" in data, false);
  });

  it("reports the signed ranges, the latency formula and the restart path", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    const data = await viewCall(f);
    const section = data["grid"] as Record<string, unknown>;
    assert.deepEqual(section["buyRange"], BUY);
    assert.deepEqual(section["sellRange"], SELL);
    assert.equal(section["maxFlipsPerDay"], 12);
    // No live level yet ⇒ the restart/first-level instruction is present.
    assert.equal(section["level"], null);
    // PHASE3.16 M3: the arm leads (it is what an owner should do next), the
    // hand-mint door still follows because it is still true.
    assert.match(String(section["restart"]), /Sign gridArm/u);
    assert.match(String(section["restart"]), /mint a single-sided range order by hand/iu);
    assert.match(String(section["restart"]), /no conversion is needed/u);
    // R2.7's latency formula, in terms an owner can read.
    const latency = section["latency"] as Record<string, unknown>;
    assert.equal(latency["confirmationMs"], 2 * 60_000);
    assert.equal(latency["minMinutesBetweenExits"], DEFAULT_LP_SETTINGS.minMinutesBetweenExits);
    assert.match(String(latency["note"]), /not maxFlipsPerDay/u);
  });

  it("reports the live level from the OBSERVATION, stamped with its age, and makes no chain read", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    const position = await f.lpStore.createPosition({
      positionId: "grid-level",
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2_500,
      tokenId: TOKEN_ID,
      basisWei: 0n,
      basisSource: "imported",
    });
    await f.observations.put({
      ownerAddress: ownerAccount.address,
      agentId: AGENT_ID,
      positionId: "grid-level",
      observation: {
        blockNumber: 100n,
        currentTick: -1_200,
        evaluatedAtMs: NOW_SEC * 1000 - 30_000,
        poolAddress: POOL,
        protectConsecutive: 0,
        rotationBreach: false,
        rotationConsecutive: 0,
        gridCrossConsecutive: 1,
        gridCrossSide: "above",
        tokenId: TOKEN_ID,
        valuation: {
          method: "sellable-exit-v1",
          exitValueWei: (2n ** 53n) + 7n,
          quoteToken: WBNB,
          tokenId: TOKEN_ID,
          positionRowVersion: position.rowVersion,
          blockNumber: 101n,
          valuedAtMs: NOW_SEC * 1000 - 31_000,
        },
      },
    });
    const data = await viewCall(f);
    const section = data["grid"] as Record<string, unknown>;
    assert.equal(section["poolAddress"], POOL);
    const level = section["level"] as Record<string, unknown>;
    assert.equal(level["tokenId"], TOKEN_ID);
    // AS OF THE LAST OBSERVATION, never "now" — this route makes no chain call.
    assert.equal(level["observedTick"], -1_200);
    assert.equal(level["crossConsecutive"], 1);
    assert.equal(level["crossSide"], "above");
    assert.equal(level["observationAgeMs"], 30_000);
    assert.equal("restart" in section, false, "there IS a live level");
    const positions = data["positions"] as readonly Record<string, unknown>[];
    assert.equal(positions[0]?.["rowVersion"], position.rowVersion);
    const observation = positions[0]?.["observation"] as Record<string, unknown>;
    assert.equal(observation["blockNumber"], "100");
    const valuation = observation["valuation"] as Record<string, unknown>;
    assert.equal(valuation["exitValueWei"], ((2n ** 53n) + 7n).toString(10));
    assert.equal(valuation["positionRowVersion"], position.rowVersion);
  });

  it("reports cycles as a LOWER BOUND and PnL over recorded round trips only", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    const common = {
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: "grid-level",
      fromTickLower: BUY.tickLower,
      fromTickUpper: BUY.tickUpper,
      toTickLower: SELL.tickLower,
      toTickUpper: SELL.tickUpper,
      freedAmount0Wei: 10n ** 15n,
      freedAmount1Wei: 0n,
      residueWei: 0n,
      residueBps: 0n,
      fromTokenId: "1",
      toTokenId: "2",
    };
    // Two returns to the BUY level: one completed round trip, and the quote leg
    // (token1 under Case A) grew by 1e13.
    await f.cycles.record({
      ...common,
      sequenceId: "s1",
      direction: "to-buy",
      mintedAmount0Wei: 10n ** 15n,
      mintedAmount1Wei: 0n,
      completedAtMs: NOW_SEC * 1000 - 3_000,
    });
    await f.cycles.record({
      ...common,
      sequenceId: "s2",
      direction: "to-buy",
      mintedAmount0Wei: 10n ** 15n + 10n ** 13n,
      mintedAmount1Wei: 0n,
      completedAtMs: NOW_SEC * 1000 - 1_000,
    });
    const data = await viewCall(f);
    const section = data["grid"] as Record<string, unknown>;
    const cycles = section["cycles"] as Record<string, unknown>;
    assert.equal(cycles["recorded"], 2);
    assert.equal(cycles["available"], true);
    assert.equal(cycles["roundTrips"], 1);
    assert.equal(
      cycles["note"],
      "Derived telemetry: a row can be lost if the post-confirm write fails; counts are a lower bound.",
    );
    const rows = cycles["rows"] as readonly Record<string, unknown>[];
    assert.equal(rows[0]?.["positionId"], "grid-level");
    const pnl = section["pnl"] as Record<string, unknown>;
    // A QUOTE-LEG DELTA computed from recorded facts, with no price at all.
    // Under this orientation the quote is token0.
    assert.equal(pnl["realisedQuoteWei"], (10n ** 13n).toString(10));
    assert.equal(pnl["overRoundTrips"], 1);
    assert.match(String(pnl["note"]), /EXCLUDES relay billing/u);
    // The estimates are labelled, and say where their price came from.
    const estimates = section["estimates"] as Record<string, unknown>;
    assert.match(String(estimates["note"]), /ESTIMATE/u);
    assert.match(String(estimates["note"]), /this route makes no chain call/u);
  });

  it("accepts the account bearer on the LP GET without widening LP mutations", async () => {
    const f = await fixture({
      gridEnabled: true,
      settingsGrid: grid(),
      accountReadSession: true,
    });
    const issueEnvelope = await signOwnerAction("createAccountReadSession", {}, { agentId: "*" });
    const issued = await call(f.harness, "/owner-read-session", {
      method: "POST",
      body: issueEnvelope,
    });
    const token = (issued.body["data"] as { token: string }).token;
    const view = await call(f.harness, `/agents/${AGENT_ID}/lp`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(view.status, 200);
    const paths = [
      `/agents/${AGENT_ID}/lp/importable/${TOKEN_ID}`,
      `/agents/${AGENT_ID}/lp/settings`,
      `/agents/${AGENT_ID}/lp/grid/arm`,
      `/agents/${AGENT_ID}/lp/open`,
      `/agents/${AGENT_ID}/lp/import`,
      `/agents/${AGENT_ID}/lp/position-1/exit`,
      `/agents/${AGENT_ID}/lp/sequences/sequence-1/abandon`,
      `/agents/${AGENT_ID}/journal/decision-1/retire-pre-bind/v1`,
      `/agents/${AGENT_ID}/journal/decision-1/resolve-landing/v1`,
      `/agents/${AGENT_ID}/journal/decision-1/resolve`,
    ];
    for (const path of paths) {
      const options = path.includes("/importable/") ? {} : { method: "POST" as const, body: {} };
      const control = await call(f.harness, path, options);
      const withBearer = await call(f.harness, path, { ...options, headers: { authorization: `Bearer ${token}` } });
      assert.equal(withBearer.status, control.status, path);
      assert.equal(withBearer.text, control.text, path);
    }
    const poolPath = `/lp/pools/${POOL}/state`;
    const poolControl = await call(f.harness, poolPath);
    const poolBearer = await call(f.harness, poolPath, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(poolBearer.status, poolControl.status);
    assert.equal(poolBearer.text, poolControl.text);
    assert.equal(f.harness.provider.executeCalls.length, 0);
  });

  it("distinguishes unavailable cycle history from a successful empty list", async () => {
    for (const cycleStore of ["absent", "throwing"] as const) {
      const f = await fixture({ gridEnabled: true, settingsGrid: grid(), cycleStore });
      const data = await viewCall(f);
      const section = data["grid"] as Record<string, unknown>;
      const cycles = section["cycles"] as Record<string, unknown>;
      assert.equal(cycles["available"], false);
      assert.deepEqual(cycles["rows"], []);
      assert.equal(cycles["recorded"], 0);
      assert.equal(JSON.stringify(data).includes("private database detail"), false);
    }
  });

  it("H4: a held flip is reported with the abandon remedy, not as armed protection", async () => {
    const f = await fixture({ gridEnabled: true, settingsGrid: grid() });
    await f.lpStore.createPosition({
      positionId: "grid-level",
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: WBNB,
      token1: TOKEN,
      fee: 2_500,
      tokenId: TOKEN_ID,
      basisWei: 0n,
      basisSource: "imported",
    });
    const sequence = await f.lpStore.createSequence({
      agentId: AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: "grid-level",
      kind: "grid-flip",
    });
    await f.lpStore.setRecoveryState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "pending-mint",
    );
    await f.lpStore.setSequenceState(
      ownerAccount.address,
      AGENT_ID,
      sequence.sequenceId,
      "held",
    );
    const data = await viewCall(f);
    const section = data["grid"] as Record<string, unknown>;
    const blocked = section["blockedBySequence"] as Record<string, unknown>;
    assert.equal(blocked["kind"], "grid-flip");
    assert.equal(blocked["recoveryState"], "pending-mint");
    // The sentence R2.4 requires: while a flip is non-terminal the position is
    // resumed and never evaluated, so NO trigger fires — the price stop-loss
    // included — and the remedy is the owner-signed abandon.
    assert.match(String(blocked["note"]), /NO trigger fires/u);
    assert.match(String(blocked["note"]), /price stop-loss included/u);
    assert.match(String(blocked["note"]), /abandon/u);
    assert.match(String(blocked["note"]), /no owner-signed UNKNOWN resolver by design/u);
    // And the position's own protection block agrees: `armed: false`.
    const positions = data["positions"] as readonly Record<string, unknown>[];
    const protection = positions[0]?.["protection"] as Record<string, unknown>;
    assert.equal(protection["armed"], false);
  });
});

/* -------------------------------------------------------------------------- */
/* LP-DEPLOY liquidity chart — GET /lp/pools/:address/liquidity              */
/* -------------------------------------------------------------------------- */

describe("GET /lp/pools/:address/liquidity — the deploy form's liquidity profile", () => {
  it("serves one finalized-block profile with bigints as decimal strings, exec token only", async () => {
    const f = await fixture({ tickLiquidity: "scripted" });
    const response = await call(f.harness, `/lp/pools/${POOL}/liquidity?window=3`);
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["pool"], POOL);
    assert.equal(data["blockNumber"], "12345");
    assert.equal(data["currentTick"], 7);
    assert.equal(data["tickSpacing"], 50);
    assert.equal(data["activeLiquidity"], "1000");
    assert.equal(data["truncated"], false);
    const bins = data["bins"] as readonly Record<string, unknown>[];
    assert.equal(bins.length, 7);
    assert.deepEqual(bins[0], { tickLower: -150, liquidity: "1003" });
    assert.deepEqual(bins[3], { tickLower: 0, liquidity: "1000" });
    // Display data reaches no money seam.
    assert.equal(f.harness.provider.executeCalls.length, 0);
  });

  it("defaults the window and refuses a malformed one or a non-address", async () => {
    const f = await fixture({ tickLiquidity: "scripted" });
    const defaulted = await call(f.harness, `/lp/pools/${POOL}/liquidity`);
    assert.equal(defaulted.status, 200);
    assert.equal(((defaulted.body["data"] as Record<string, unknown>)["bins"] as unknown[]).length, 121);
    for (const bad of ["0", "1001", "abc", "-4", "1.5"]) {
      const response = await call(f.harness, `/lp/pools/${POOL}/liquidity?window=${bad}`);
      assert.equal(response.status, 400, bad);
    }
    assert.equal((await call(f.harness, "/lp/pools/not-an-address/liquidity")).status, 400);
  });

  it("answers 503 — never an empty chart — when the reader is absent or fails", async () => {
    const absent = await fixture({ tickLiquidity: "absent" });
    const absentResponse = await call(absent.harness, `/lp/pools/${POOL}/liquidity`);
    assert.equal(absentResponse.status, 503);
    const throwing = await fixture({ tickLiquidity: "throwing" });
    const throwingResponse = await call(throwing.harness, `/lp/pools/${POOL}/liquidity`);
    assert.equal(throwingResponse.status, 503);
    assert.equal(throwingResponse.text.includes("private detail"), false);
  });

  it("requires the exec token like every plane route", async () => {
    const f = await fixture({ tickLiquidity: "scripted" });
    const response = await call(f.harness, `/lp/pools/${POOL}/liquidity`, { noExecToken: true });
    assert.equal(response.status, 401);
  });
});

/* -------------------------------------------------------------------------- */
/* HOTFIX 2026-09-05 — GET /lp/pools/:address/state on a pool the rails cannot read */
/* -------------------------------------------------------------------------- */

describe("GET /lp/pools/:address/state — young pools whose TWAP reverts", () => {
  it("falls back to the light slot0/spacing read and says the rails are not ready", async () => {
    const f = await fixture({ poolStateThrows: true, tickLiquidity: "scripted" });
    const response = await call(f.harness, `/lp/pools/${POOL}/state`);
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["pool"], POOL);
    assert.equal(data["currentTick"], 7);
    assert.equal(data["tickSpacing"], 50);
    assert.equal(data["blockNumber"], "12345");
    assert.equal(data["poolLiquidity"], "1000");
    assert.equal(data["observationCardinality"], null);
    assert.equal(data["railsReady"], false);
    assert.match(String(data["railsReason"]), /rails/u);
    assert.equal(f.harness.provider.executeCalls.length, 0);
  });

  it("reports railsReady: true on the normal path", async () => {
    const f = await fixture({ tickLiquidity: "scripted" });
    const response = await call(f.harness, `/lp/pools/${POOL}/state`);
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["railsReady"], true);
    assert.equal(data["railsReason"], null);
    assert.equal(data["observationCardinality"], 500);
  });

  it("keeps the 503 refusal when no light reader exists or it fails too", async () => {
    const absent = await fixture({ poolStateThrows: true, tickLiquidity: "absent" });
    assert.equal((await call(absent.harness, `/lp/pools/${POOL}/state`)).status, 503);
    const throwing = await fixture({ poolStateThrows: true, tickLiquidity: "throwing" });
    const response = await call(throwing.harness, `/lp/pools/${POOL}/state`);
    assert.equal(response.status, 503);
    assert.equal(response.text.includes("OLD"), false);
  });
});
