/**
 * Adversarial tests for PHASE3.4 — importing a position the owner already
 * holds (`GET /agents/:id/lp/importable/:tokenId`, `POST /agents/:id/lp/import`).
 *
 * Auditor style: every test is an attack or a boundary, and the assertion is
 * what the attacker GETS. The matrix, and where each item comes from:
 *
 *   - the spec's own refusal list: not the wallet's NFT / staked in a farm /
 *     burned or nonexistent / zero liquidity / no WBNB leg / rails / the
 *     session cannot sell a leg / a nonzero per-token operator;
 *   - Rev2 M2: a leading-zero or over-length tokenId. NOT the path↔params
 *     comparison M2 also asks for — the shipped mutation route is
 *     `POST /agents/:id/lp/import` with no tokenId path segment, so there is
 *     one source for the value and nothing to compare it against (audit A4);
 *   - Rev2 M4: an import refused while ANY non-terminal sequence exists — the
 *     mint-confirm → row-update window that would otherwise make a SAGA the
 *     loser of the new unique index;
 *   - Rev2 M5: the duplicate, in both voices, and the same answer whether it
 *     comes from the pre-check or from the index itself;
 *   - Rev2 M9: a QuoterV2 revert refuses rather than passes, and the worst-case
 *     conversion is DISCLOSED rather than refused;
 *   - Rev2 M11: the breach refusal uses the trigger's own arithmetic;
 *   - Rev2 M12: `sessionFacts === null` refuses with its own diagnosis, and the
 *     sizing regression — an agent holding only `owner-budget` rows sizes
 *     exactly as it did before this phase;
 *   - Rev2 M14: an import is permitted under pause, which is a decision;
 *   - decision 5: `basisWei: 0` is accepted and reported IN WORDS;
 *   - the authz matrix every owner route gets.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import {
  NOW_SEC,
  OTHER_OWNER_PK,
  ROUTER_V3,
  SESSION_KEY,
  TOKEN,
  WBNB,
  call,
  createHarness,
  errorCode,
  freshNonce,
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
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpRuntimeConfig } from "../src/ops/config.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";
import { paramsHash } from "../src/auth/canonical.js";
import { DEFAULT_LP_SETTINGS, LP_NOT_OWNED_REASON } from "../src/lp/triggers.js";

const LP_AGENT_ID = "agent-lp-import";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const STAKER = getAddress("0x556B9306565093C855AEA9AE92A594704c2Cd59e");
const STRANGER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN_UNSELLABLE = getAddress("0x5E55555555555555555555555555555555555555");
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
  // M10: the shipped chain-56 default, so this suite exercises what deploys.
  knownStakers: [STAKER],
  conversionCompatibleTokens: new Set(),
  resolveMinAgeSec: 1_800,
  resolveDiscriminatingMultipleBps: 12_000,
};

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

function healthyState(): LpPoolStateReading {
  return {
    pool: POOL,
    tickSpacing: 50,
    currentTick: 0,
    evidence: {
      blockNumber: 100n,
      finalizedBlockNumber: 100n,
      observationCardinality: 500,
      poolLiquidity: 10n ** 24n,
      priceImpactBps: 0n,
      spotSqrtPriceX96: 2n ** 96n, // price 1
      twapSqrtPriceX96: 2n ** 96n,
    },
  };
}

/**
 * WBNB is token1 in this pool (TOKEN sorts below it in the shared fixture), so
 * the position's principal at price 1 splits evenly across the two legs.
 */
const LIVE_SNAPSHOT: LpPositionSnapshot = {
  liquidity: 10n ** 15n,
  tickLower: -1_000,
  tickUpper: 1_000,
  operator: zeroAddress,
  token0: TOKEN,
  token1: WBNB,
  fee: 2_500,
};

type Fixture = {
  readonly harness: Harness;
  readonly lpStore: MemoryLpSequenceStore;
  readonly settingsStore: MemoryLpSettingsStore;
  readonly chain: {
    snapshot: LpPositionSnapshot | "burned";
    owner: Address | "burned";
    ownerOfThrows: boolean;
    quoteThrows: boolean;
    liveCapWei: bigint;
    poolExists: boolean;
    cardinality: number;
  };
};

async function fixture(
  options: { readonly noSession?: boolean } = {},
): Promise<Fixture> {
  const lpStore = new MemoryLpSequenceStore();
  const settingsStore = new MemoryLpSettingsStore();
  const observations = new MemoryLpObservationStore();

  const chain: Fixture["chain"] = {
    snapshot: LIVE_SNAPSHOT,
    owner: ownerAccount.address,
    ownerOfThrows: false,
    quoteThrows: false,
    liveCapWei: 10n ** 18n,
    poolExists: true,
    cardinality: 500,
  };

  const lp: LpServerDeps = {
    store: lpStore,
    settingsStore,
    observations,
    workerIntervalMs: 60_000,
    railsResult: { ok: true, config: RAILS },
    runtime: RUNTIME,
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    readers: {
      getPool: async () => (chain.poolExists ? POOL : null),
      poolState: async () => {
        const state = healthyState();
        return {
          ...state,
          evidence: { ...state.evidence, observationCardinality: chain.cardinality },
        };
      },
      positions: async () => chain.snapshot,
      positionFees: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
      ownerOf: async () => {
        if (chain.ownerOfThrows) throw new Error("rpc down");
        return chain.owner;
      },
      // 1:1 against spot, so the probe reads the POOL FEE as its only impact —
      // which the exit's own reading deducts, so it lands at 0 bps.
      quote: async (params) => {
        if (chain.quoteThrows) throw new Error("quoter reverted");
        return params.amountInWei;
      },
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

  const harness = await createHarness({ lp });
  await harness.agentStore.createAgent({
    id: LP_AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    ...(options.noSession === true
      ? {}
      : { sessionFacts: lpSessionFacts(NOW_SEC + 3_600) }),
    status: "armed",
  });
  await harness.agentStore.putAgentSessionKey(
    ownerAccount.address,
    LP_AGENT_ID,
    SESSION_KEY,
  );
  return { harness, lpStore, settingsStore, chain };
}

async function importCall(
  f: Fixture,
  params: Record<string, unknown>,
  options: { readonly pk?: Hex; readonly path?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope = await signOwnerAction("lpImport", params, {
    agentId: LP_AGENT_ID,
    ...(options.pk === undefined ? {} : { pk: options.pk }),
  });
  return call(f.harness, options.path ?? `/agents/${LP_AGENT_ID}/lp/import`, {
    method: "POST",
    body: envelope,
  });
}

async function previewCall(
  f: Fixture,
  tokenId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope = await signOwnerAction("read", {}, { agentId: LP_AGENT_ID });
  return call(f.harness, `/agents/${LP_AGENT_ID}/lp/importable/${tokenId}`, {
    headers: { "x-owner-action": toReadHeader(envelope) },
  });
}

/** The refusal message, from either route shape. */
function reason(body: Record<string, unknown>): string {
  const data = body["data"] as { reason?: string } | undefined;
  if (data?.reason !== undefined) return data.reason;
  const error = body["error"] as { message?: string } | undefined;
  return error?.message ?? "";
}

/* -------------------------------------------------------------------------- */
/* The happy path, and what it must SAY                                       */
/* -------------------------------------------------------------------------- */

describe("lp import: the accepted path", () => {
  it("records ONE row with basisSource 'imported', the chain's legs, and no sequence or reservation", async () => {
    const f = await fixture();
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: (10n ** 15n).toString(10),
    });
    assert.equal(status, 200, JSON.stringify(body));

    const positions = await f.lpStore.listPositions(
      ownerAccount.address,
      LP_AGENT_ID,
    );
    assert.equal(positions.length, 1);
    const position = positions[0];
    assert.equal(position?.tokenId, TOKEN_ID);
    // Decision 4: the DECLARATION is recorded as one. Writing "owner-budget"
    // here would claim a budget nothing ever metered.
    assert.equal(position?.basisSource, "imported");
    assert.equal(position?.state, "open");
    assert.equal(position?.quoteToken, WBNB);
    // Decision 3: the legs come from the CHAIN, and the caller supplied none.
    assert.equal(position?.token0, TOKEN);
    assert.equal(position?.token1, WBNB);
    assert.equal(position?.fee, 2_500);
    assert.equal(position?.ownershipMismatchCount, 0);

    // Decision 12: not a saga. Nothing to resolve if it half-happened.
    const sequences = await f.lpStore.listSequences(
      ownerAccount.address,
      LP_AGENT_ID,
    );
    assert.equal(sequences.length, 0);
  });

  it("mints a FRESH lineage (decision 14) and does not carry any other row's", async () => {
    const f = await fixture();
    await importCall(f, { tokenId: TOKEN_ID, basisWei: "1000" });
    const [position] = await f.lpStore.listPositions(
      ownerAccount.address,
      LP_AGENT_ID,
    );
    assert.ok(position !== undefined);
    assert.notEqual(position.lineageId, position.positionId);
    assert.match(position.lineageId, /^[0-9a-f-]{36}$/u);
  });

  it("basisWei 0 is ACCEPTED and the receipt says in words that no stop-loss will ever fire", async () => {
    // Decision 5. The evaluator already handles a zero basis correctly; what
    // was missing is anyone SAYING so. A receipt that merely omitted the fact
    // would leave an owner believing they had protection.
    const f = await fixture();
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "0",
    });
    assert.equal(status, 200, JSON.stringify(body));
    const data = body["data"] as { basis: { note: string; basisWei: string } };
    assert.equal(data.basis.basisWei, "0");
    assert.match(data.basis.note, /NO stop-loss or take-profit will ever fire/iu);
  });

  it("the receipt does not claim protection is live: it names the two-evaluation rule", async () => {
    // Decision 13, as the review corrected it: `armed` reads true as soon as
    // settings/basis/tokenId are in place, but a protect CANNOT FIRE before two
    // finalized evaluations. Conflating the two is how FINDINGS (ae) read to an
    // owner, and an import receipt is the newest place to make that claim.
    const f = await fixture();
    const { body } = await importCall(f, { tokenId: TOKEN_ID, basisWei: "1000" });
    const data = body["data"] as { protection: { note: string } };
    assert.match(data.protection.note, /two finalized evaluations/iu);
  });

  it("says plainly that nothing moved", async () => {
    const f = await fixture();
    const { body } = await importCall(f, { tokenId: TOKEN_ID, basisWei: "1000" });
    const data = body["data"] as { note: string };
    assert.match(data.note, /Nothing moved/iu);
  });
});

/* -------------------------------------------------------------------------- */
/* Ownership — the three refusals, kept distinct                              */
/* -------------------------------------------------------------------------- */

describe("lp import: ownership", () => {
  it("a STAKED position is named as staked, not as 'not yours' (M10)", async () => {
    // The measured reason this matters: MasterChefV3 holds tens of thousands of
    // NFPM positions, so this is plausibly the most common non-wallet answer an
    // owner's `ownerOf` read gives. "Not this wallet's position" would be true
    // and unactionable.
    const f = await fixture();
    f.chain.owner = STAKER;
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /staked in a farm/iu);
    assert.match(reason(body), /Unstake it/iu);
  });

  it("an NFT held by a stranger is refused without naming the farm remedy", async () => {
    const f = await fixture();
    f.chain.owner = STRANGER;
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /not held by the agent's wallet/iu);
    assert.doesNotMatch(reason(body), /unstake/iu);
  });

  it("a burned or nonexistent token is refused as such", async () => {
    const f = await fixture();
    f.chain.snapshot = "burned";
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /does not exist or has been burned/iu);
  });

  it("an RPC failure on ownerOf is an ERROR, never an admission", async () => {
    // The `readers.positions` posture: an outage must not resolve to a verdict.
    // Here that means the import does not succeed; it must not quietly admit a
    // position whose ownership was never established.
    const f = await fixture();
    f.chain.ownerOfThrows = true;
    const { status } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.notEqual(status, 200);
    const positions = await f.lpStore.listPositions(
      ownerAccount.address,
      LP_AGENT_ID,
    );
    assert.equal(positions.length, 0);
  });

  it("a nonzero per-token operator is refused by name (M13)", async () => {
    const f = await fixture();
    f.chain.snapshot = { ...LIVE_SNAPSHOT, operator: STRANGER };
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /outstanding approval/iu);
    assert.match(reason(body), new RegExp(STRANGER, "iu"));
  });

  it("zero liquidity is refused, which is what keeps every rotated-away NFT out", async () => {
    // Errata 1: nothing in this codebase burns an NFT, so every rotated-away
    // and exited tokenId is still a live, EMPTIED ERC-721 in the wallet. This
    // rail is the only thing keeping them off the import surface.
    const f = await fixture();
    f.chain.snapshot = { ...LIVE_SNAPSHOT, liquidity: 0n };
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /no liquidity/iu);
  });
});

/* -------------------------------------------------------------------------- */
/* The wire (M2)                                                              */
/* -------------------------------------------------------------------------- */

describe("lp import: canonical decimal (M2)", () => {
  for (const bad of ["07", "0x10", "-1", "1e3", " 7", "1".repeat(79)]) {
    it(`refuses tokenId ${JSON.stringify(bad)}`, async () => {
      // A leading zero is the sharp one: `BigInt("07")` parses and
      // `ownerOf(7n)` passes, but "07" does not collide with "7" in a TEXT
      // index — two live rows, one NFT, two sagas.
      const f = await fixture();
      const { status, body } = await importCall(f, {
        tokenId: bad,
        basisWei: "1000",
      });
      assert.equal(status, 400);
      assert.equal(errorCode(body), "invalid_request");
    });
  }

  it("the preview refuses the same shapes", async () => {
    const f = await fixture();
    const { status } = await previewCall(f, "07");
    assert.equal(status, 400);
  });

  it("refuses a basisWei that is not a decimal string", async () => {
    const f = await fixture();
    const { status } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "0x10",
    });
    assert.equal(status, 400);
  });

  it("refuses an unknown params key", async () => {
    const f = await fixture();
    const { status } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
      token0: TOKEN,
    });
    assert.equal(status, 400);
  });
});

/* -------------------------------------------------------------------------- */
/* M4 — quiescence                                                            */
/* -------------------------------------------------------------------------- */

describe("lp import: refused while a sequence is in flight (M4)", () => {
  it("names the blocking sequence", async () => {
    // The window the draft never considered: between a rotate's mint confirming
    // and its `after` hook writing the tokenId, the new NFT is owned, funded and
    // recorded NOWHERE — so it passes every check, and the import makes the
    // SAGA's own `updatePositionTokenId` the loser of the unique index.
    const f = await fixture();
    const other = await f.lpStore.createPosition({
      positionId: "pos-busy",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      tokenId: "999",
      basisWei: 10n ** 15n,
    });
    const sequence = await f.lpStore.createSequence({
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: other.positionId,
      kind: "rotate",
    });
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /non-terminal rotate sequence/iu);
    assert.match(reason(body), new RegExp(sequence.sequenceId, "iu"));
  });

  it("allows the import once that sequence is terminal", async () => {
    const f = await fixture();
    const other = await f.lpStore.createPosition({
      positionId: "pos-busy",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      tokenId: "999",
      basisWei: 10n ** 15n,
    });
    const sequence = await f.lpStore.createSequence({
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: other.positionId,
      kind: "rotate",
    });
    await f.lpStore.setSequenceState(
      ownerAccount.address,
      LP_AGENT_ID,
      sequence.sequenceId,
      "completed",
    );
    const { status } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 200);
  });
});

/* -------------------------------------------------------------------------- */
/* M5 — the duplicate, in both voices                                         */
/* -------------------------------------------------------------------------- */

describe("lp import: one non-closed row per NFT (M5)", () => {
  it("a second import of the same tokenId by the same agent says the goal is already met", async () => {
    const f = await fixture();
    const first = await importCall(f, { tokenId: TOKEN_ID, basisWei: "1000" });
    assert.equal(first.status, 200);
    const second = await importCall(f, { tokenId: TOKEN_ID, basisWei: "1000" });
    assert.equal(second.status, 400);
    assert.match(reason(second.body), /already manages/iu);
    assert.match(reason(second.body), new RegExp(TOKEN_ID, "u"));
  });

  it("a tokenId held by ANOTHER tenant answers generically and names nothing", async () => {
    // The scoped lookup answers `null` across tenants by construction, so the
    // two voices cannot leak into one another.
    const f = await fixture();
    await f.lpStore.createPosition({
      positionId: "pos-other-tenant",
      agentId: "someone-else",
      ownerAddress: getAddress("0x2222222222222222222222222222222222222222"),
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      tokenId: TOKEN_ID,
      basisWei: 10n ** 15n,
    });
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /already under management/iu);
    assert.doesNotMatch(reason(body), /pos-other-tenant/iu);
    assert.doesNotMatch(reason(body), /someone-else/iu);
  });

  it("a re-import AFTER the row was closed succeeds, with a fresh lineage and basis", async () => {
    // `state <> 'closed'` in the index predicate is what makes this legal: the
    // old row is history, its basis already reset by the close, and the new row
    // is a new declaration.
    const f = await fixture();
    await importCall(f, { tokenId: TOKEN_ID, basisWei: "1000" });
    const [before] = await f.lpStore.listPositions(
      ownerAccount.address,
      LP_AGENT_ID,
    );
    assert.ok(before !== undefined);
    await f.lpStore.setPositionState(
      ownerAccount.address,
      LP_AGENT_ID,
      before.positionId,
      "closed",
    );
    const { status } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "2000",
    });
    assert.equal(status, 200);
    const rows = await f.lpStore.listPositions(ownerAccount.address, LP_AGENT_ID);
    const live = rows.filter((row) => row.state !== "closed");
    assert.equal(live.length, 1);
    assert.notEqual(live[0]?.lineageId, before.lineageId);
    assert.equal(live[0]?.basisWei, 2_000n);
  });

  it("the STORE refuses the second live row even when the route is bypassed", async () => {
    // The pre-check is the UX; the index is the guarantee. Both backends
    // enforce it, and this is the memory twin.
    const f = await fixture();
    await f.lpStore.createPosition({
      positionId: "pos-a",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      tokenId: TOKEN_ID,
      basisWei: 1n,
    });
    await assert.rejects(
      f.lpStore.createPosition({
        positionId: "pos-b",
        agentId: LP_AGENT_ID,
        ownerAddress: ownerAccount.address,
        token0: TOKEN,
        token1: WBNB,
        fee: 2_500,
        tokenId: TOKEN_ID,
        basisWei: 1n,
      }),
      /already claimed by a live position row/u,
    );
  });

  it("and refuses a saga's updatePositionTokenId onto a claimed NFT", async () => {
    // M5's real collision site — the one the draft's own argument missed.
    const f = await fixture();
    await f.lpStore.createPosition({
      positionId: "pos-a",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      tokenId: TOKEN_ID,
      basisWei: 1n,
    });
    await f.lpStore.createPosition({
      positionId: "pos-b",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      basisWei: 1n,
    });
    await assert.rejects(
      f.lpStore.updatePositionTokenId(
        ownerAccount.address,
        LP_AGENT_ID,
        "pos-b",
        TOKEN_ID,
      ),
      /already claimed by a live position row/u,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The pool gate, the probe, and the disclosure                               */
/* -------------------------------------------------------------------------- */

describe("lp import: admission", () => {
  it("refuses a pool the session cannot sell a leg of (the open ⇒ exitable rule)", async () => {
    const f = await fixture();
    f.chain.snapshot = { ...LIVE_SNAPSHOT, token0: TOKEN_UNSELLABLE };
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /cannot sell/iu);
  });

  it("refuses a pool with no WBNB leg", async () => {
    const f = await fixture();
    f.chain.snapshot = {
      ...LIVE_SNAPSHOT,
      token0: TOKEN,
      token1: TOKEN_UNSELLABLE,
    };
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /no WBNB leg/iu);
  });

  it("refuses a pool below the observation-cardinality rail", async () => {
    const f = await fixture();
    f.chain.cardinality = 1;
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /cardinality/iu);
  });

  it("a QuoterV2 revert REFUSES rather than passing (M9)", async () => {
    // "A valuation that cannot price the token leg has proved nothing." The
    // failure direction is the whole point: a probe that cannot run is not a
    // probe that passed.
    const f = await fixture();
    f.chain.quoteThrows = true;
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /could not be quoted/iu);
  });

  it("the preview DISCLOSES the worst-case conversion without refusing on it (M9)", async () => {
    // The probe sizes today's mix; a stop-loss fires at the worst one. Parity
    // with `/lp/open` (which also prices only its own leg) is why this is a
    // disclosure and not a rail.
    const f = await fixture();
    const { status, body } = await previewCall(f, TOKEN_ID);
    assert.equal(status, 200, JSON.stringify(body));
    const data = body["data"] as {
      importable: boolean;
      assessment: {
        exitProbe: { amountInWei: string };
        worstCaseConversion: { amountInWei: string; note: string };
      };
    };
    assert.equal(data.importable, true);
    // WBNB is token1 here, so the token leg maxes at the UPPER edge — and it
    // is strictly larger than the current two-sided mix.
    assert.ok(
      BigInt(data.assessment.worstCaseConversion.amountInWei)
        > BigInt(data.assessment.exitProbe.amountInWei),
      "the worst-case conversion must exceed today's token leg",
    );
    assert.match(data.assessment.worstCaseConversion.note, /stop-loss fires at the worst mix/iu);
  });

  it("the preview reports a refusal as data, not as an error", async () => {
    const f = await fixture();
    f.chain.owner = STRANGER;
    const { status, body } = await previewCall(f, TOKEN_ID);
    assert.equal(status, 200);
    const data = body["data"] as { importable: boolean; reason: string };
    assert.equal(data.importable, false);
    assert.match(data.reason, /not held by the agent's wallet/iu);
  });
});

/* -------------------------------------------------------------------------- */
/* M11 / M12 / M14                                                            */
/* -------------------------------------------------------------------------- */

describe("lp import: the breach refusal (M11)", () => {
  it("refuses an import already in stop-loss breach, naming both numbers", async () => {
    const f = await fixture();
    // Settings first: a 10% stop-loss.
    const settings = await signOwnerAction(
      "lpSettings",
      { stopLossPct: 10 },
      { agentId: LP_AGENT_ID },
    );
    const applied = await call(f.harness, `/agents/${LP_AGENT_ID}/lp/settings`, {
      method: "POST",
      body: settings,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));

    // The position is worth ~1e15 wei; a basis of 1e18 is 1000x above it.
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: (10n ** 18n).toString(10),
    });
    assert.equal(status, 400);
    assert.match(reason(body), /stop-loss breach/iu);
    // The remedies, both signable.
    assert.match(reason(body), /basisWei 0/iu);
  });

  it("accepts the same import with basisWei 0 — the remedy the refusal names", async () => {
    const f = await fixture();
    const settings = await signOwnerAction(
      "lpSettings",
      { stopLossPct: 10 },
      { agentId: LP_AGENT_ID },
    );
    await call(f.harness, `/agents/${LP_AGENT_ID}/lp/settings`, {
      method: "POST",
      body: settings,
    });
    const { status } = await importCall(f, { tokenId: TOKEN_ID, basisWei: "0" });
    assert.equal(status, 200);
  });

  it("does not run the breach check when no threshold is configured", async () => {
    // Default settings carry no stop-loss and no take-profit, so an absurd
    // basis is admissible: there is no threshold for it to breach.
    const f = await fixture();
    const { status } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: (10n ** 18n).toString(10),
    });
    assert.equal(status, 200);
  });
});

describe("lp import: sizing and session (M12)", () => {
  it("refuses a session-less agent with its OWN diagnosis, not 'cannot sell'", async () => {
    const f = await fixture({ noSession: true });
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /no granted session/iu);
    assert.doesNotMatch(reason(body), /cannot sell/iu);
  });

  it("refuses when the on-chain cap cannot cover this position's exit gas, naming the shortfall", async () => {
    const f = await fixture();
    f.chain.liveCapWei = 1n;
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /short by \d+ wei/u);
    // And it says what an import actually costs, which is nothing.
    assert.match(reason(body), /Importing spends\s+nothing on chain/iu);
  });

  it("an IMPORTED basis does not enter the /lp/settings budget term, and an owner-budget one still does", async () => {
    // The regression that makes "changes the meaning of an existing term" safe.
    // A declared basis describes no outflow, and `/lp/settings` is also the OFF
    // switch — so counting it could lock an owner out of disarming automation.
    const f = await fixture();
    const huge = 10n ** 17n;
    await f.lpStore.createPosition({
      positionId: "pos-imported",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      tokenId: "5555",
      basisWei: huge,
      basisSource: "imported",
    });
    const settingsA = await signOwnerAction(
      "lpSettings",
      { stopLossPct: 5 },
      { agentId: LP_AGENT_ID },
    );
    const withImported = await call(
      f.harness,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      { method: "POST", body: settingsA },
    );
    assert.equal(
      withImported.status,
      200,
      `an imported basis must not consume the budget term: ${JSON.stringify(withImported.body)}`,
    );

    // The SAME number as an owner-budget row does consume it — proof the term
    // still works, and that the filter is what changed and not the arithmetic.
    await f.lpStore.createPosition({
      positionId: "pos-opened",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      tokenId: "6666",
      basisWei: 10n ** 18n,
    });
    const settingsB = await signOwnerAction(
      "lpSettings",
      { stopLossPct: 6 },
      { agentId: LP_AGENT_ID },
    );
    const withOpened = await call(
      f.harness,
      `/agents/${LP_AGENT_ID}/lp/settings`,
      { method: "POST", body: settingsB },
    );
    assert.equal(withOpened.status, 400);
    assert.match(reason(withOpened.body), /short by/u);
  });
});

describe("lp import: pause posture (M14)", () => {
  it("is PERMITTED under pause, and that is a decision", async () => {
    // `ownerMutation` consults no killswitch; the kill switch gates EXECUTION.
    // An import spends nothing, and what the owner gets is a position whose
    // exposure-REDUCING automation alone runs until unpause.
    const f = await fixture();
    const pause = await signOwnerAction("pause", {}, { agentId: LP_AGENT_ID });
    const paused = await call(f.harness, `/agents/${LP_AGENT_ID}/pause`, {
      method: "POST",
      body: pause,
    });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const { status } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 200);
  });
});

/* -------------------------------------------------------------------------- */
/* Authz                                                                      */
/* -------------------------------------------------------------------------- */

describe("lp import: authz", () => {
  it("refuses with no service credential", async () => {
    const f = await fixture();
    const envelope = await signOwnerAction(
      "lpImport",
      { tokenId: TOKEN_ID, basisWei: "1000" },
      { agentId: LP_AGENT_ID },
    );
    const { status } = await call(f.harness, `/agents/${LP_AGENT_ID}/lp/import`, {
      method: "POST",
      body: envelope,
      noExecToken: true,
    });
    assert.equal(status, 401);
  });

  it("answers 404 for a different owner — indistinguishable from a missing agent", async () => {
    const f = await fixture();
    const { status } = await importCall(
      f,
      { tokenId: TOKEN_ID, basisWei: "1000" },
      { pk: OTHER_OWNER_PK },
    );
    assert.equal(status, 404);
  });

  it("refuses a replayed nonce", async () => {
    const f = await fixture();
    const nonce = freshNonce();
    const params = { tokenId: TOKEN_ID, basisWei: "1000" };
    const first = await call(f.harness, `/agents/${LP_AGENT_ID}/lp/import`, {
      method: "POST",
      body: await signOwnerAction("lpImport", params, {
        agentId: LP_AGENT_ID,
        nonce,
      }),
    });
    assert.equal(first.status, 200);
    // A DIFFERENT tokenId under the same nonce: not the idempotent-retry path.
    const second = await call(f.harness, `/agents/${LP_AGENT_ID}/lp/import`, {
      method: "POST",
      body: await signOwnerAction(
        "lpImport",
        { tokenId: "7777", basisWei: "1000" },
        { agentId: LP_AGENT_ID, nonce },
      ),
    });
    assert.notEqual(second.status, 200);
  });

  it("refuses a tampered paramsHash", async () => {
    const f = await fixture();
    const envelope = await signOwnerAction(
      "lpImport",
      { tokenId: TOKEN_ID, basisWei: "1000" },
      {
        agentId: LP_AGENT_ID,
        paramsHash: paramsHash("lpImport", { tokenId: "1", basisWei: "1" }),
      },
    );
    const { status } = await call(f.harness, `/agents/${LP_AGENT_ID}/lp/import`, {
      method: "POST",
      body: envelope,
    });
    assert.notEqual(status, 200);
  });

  it("an envelope bound to another agent is refused", async () => {
    const f = await fixture();
    const envelope = await signOwnerAction(
      "lpImport",
      { tokenId: TOKEN_ID, basisWei: "1000" },
      { agentId: "some-other-agent" },
    );
    const { status } = await call(f.harness, `/agents/${LP_AGENT_ID}/lp/import`, {
      method: "POST",
      body: envelope,
    });
    assert.notEqual(status, 200);
  });

  it("the preview refuses without an owner envelope", async () => {
    const f = await fixture();
    const { status } = await call(
      f.harness,
      `/agents/${LP_AGENT_ID}/lp/importable/${TOKEN_ID}`,
    );
    assert.equal(status, 401);
  });

  it("a `read` signature cannot be replayed as an import", async () => {
    // `paramsHash` binds the action name, so a read envelope recomputes to a
    // different hash under `lpImport`.
    const f = await fixture();
    const envelope = await signOwnerAction("read", {}, { agentId: LP_AGENT_ID });
    const { status } = await call(f.harness, `/agents/${LP_AGENT_ID}/lp/import`, {
      method: "POST",
      body: envelope,
    });
    assert.notEqual(status, 200);
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.4 audit A6/A9 — the fail-closed operator read, and the owner-facing  */
/* half of M6                                                                 */
/* -------------------------------------------------------------------------- */

describe("lp import: an unreadable approval state REFUSES (audit A6)", () => {
  it("an undefined operator is refused exactly as an undefined leg is", async () => {
    // The widened snapshot fields are optional so hand-built test doubles still
    // typecheck, and the first build read that optionality as "absent is fine"
    // — so the ONE admission check for outstanding approvals vanished for any
    // wiring that omitted the field, with no refusal and no failing test.
    const f = await fixture();
    const { operator: _dropped, ...withoutOperator } = LIVE_SNAPSHOT;
    f.chain.snapshot = withoutOperator;
    const { status, body } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: "1000",
    });
    assert.equal(status, 400);
    assert.match(reason(body), /approval state could not be read/iu);
  });
});

describe("lp import: the owner-facing half of M6 (audit A9)", () => {
  it("GET /agents/:id/lp reports armed:false with the not-owned reason from the ROW", async () => {
    // The worker's cycle output and this route share `lpProtectionStatus` but
    // not its wiring, and this route is the one an owner actually reads. It
    // makes zero chain reads — the fact reaches it because the worker WROTE it.
    const f = await fixture();
    const imported = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: (10n ** 15n).toString(10),
    });
    assert.equal(imported.status, 200);
    const settings = await signOwnerAction(
      "lpSettings",
      { stopLossPct: 10 },
      { agentId: LP_AGENT_ID },
    );
    await call(f.harness, `/agents/${LP_AGENT_ID}/lp/settings`, {
      method: "POST",
      body: settings,
    });

    const [position] = await f.lpStore.listPositions(
      ownerAccount.address,
      LP_AGENT_ID,
    );
    assert.ok(position !== undefined);
    await f.lpStore.setOwnershipMismatch(
      ownerAccount.address,
      LP_AGENT_ID,
      position.positionId,
      {
        count: 1,
        reason: "NFPM tokenId 4242 is held by 0xdead, not the agent wallet",
        firstSeenAtMs: 1_700_000_000_000,
      },
    );

    const envelope = await signOwnerAction("read", {}, { agentId: LP_AGENT_ID });
    const { status, body } = await call(f.harness, `/agents/${LP_AGENT_ID}/lp`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(status, 200, JSON.stringify(body));
    const data = body["data"] as {
      positions: {
        protection: {
          armed: boolean;
          reason: string;
          ownershipMismatchCount: number;
          ownershipLostReason: string | null;
        };
      }[];
    };
    const protection = data.positions[0]?.protection;
    assert.equal(protection?.armed, false);
    assert.equal(protection?.reason, LP_NOT_OWNED_REASON);
    assert.equal(protection?.ownershipMismatchCount, 1);
    assert.match(protection?.ownershipLostReason ?? "", /0xdead/iu);
  });
});

describe("lp import: an imported row is an ordinary managed position (audit A9)", () => {
  it("the worker picks it up and evaluates it exactly as an opened one", async () => {
    // The spec's own acceptance sentence, offline. An imported row differs from
    // an opened one only in `basisSource` and lineage, and the worker is
    // agnostic to both — this pins that it stays true.
    const f = await fixture();
    const { status } = await importCall(f, {
      tokenId: TOKEN_ID,
      basisWei: (10n ** 15n).toString(10),
    });
    assert.equal(status, 200);

    const queue = await f.lpStore.listOpenPositionsForWorker();
    assert.equal(queue.length, 1);
    assert.equal(queue[0]?.tokenId, TOKEN_ID);
    assert.equal(queue[0]?.basisSource, "imported");
    // And it can be exited through the product: the route resolves the row and
    // its pool, which is everything the exit needs from the store.
    const [position] = await f.lpStore.listPositions(
      ownerAccount.address,
      LP_AGENT_ID,
    );
    assert.ok(position !== undefined);
    const exit = await signOwnerAction(
      "lpExit",
      { positionId: position.positionId },
      { agentId: LP_AGENT_ID },
    );
    const { status: exitStatus, body: exitBody } = await call(
      f.harness,
      `/agents/${LP_AGENT_ID}/lp/${position.positionId}/exit`,
      { method: "POST", body: exit },
    );
    // The saga itself has no scripted provider here; what this pins is that the
    // route ACCEPTS the imported row rather than refusing it as unknown.
    assert.notEqual(exitStatus, 404, JSON.stringify(exitBody));
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.5 — the quota block on GET /agents/:id/lp                           */
/* -------------------------------------------------------------------------- */

describe("lp read: the quota block (PHASE3.5 decision 4)", () => {
  async function readLp(f: Fixture): Promise<Record<string, unknown>> {
    const envelope = await signOwnerAction("read", {}, { agentId: LP_AGENT_ID });
    const { status, body } = await call(f.harness, `/agents/${LP_AGENT_ID}/lp`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(status, 200, JSON.stringify(body));
    return (body["data"] as Record<string, unknown>)["quota"] as Record<
      string,
      unknown
    >;
  }

  it("reports the limit, the live count and the spacing gate", async () => {
    // Nothing reported this before. On mainnet the daemon refused a harvest
    // every minute for hours and the only place that fact lived was one log
    // line on the operator's terminal — FINDINGS (ao) gap 1.
    const f = await fixture();
    const settings = await signOwnerAction(
      "lpSettings",
      { maxExitSequencesPerDay: 2, minMinutesBetweenExits: 5 },
      { agentId: LP_AGENT_ID },
    );
    const applied = await call(f.harness, `/agents/${LP_AGENT_ID}/lp/settings`, {
      method: "POST",
      body: settings,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));

    const empty = await readLp(f);
    assert.equal(empty["limit"], 2);
    assert.equal(empty["used"], 0);
    assert.equal(empty["remaining"], 2);
    assert.equal(empty["exhausted"], false);
    assert.equal(empty["nextEligibleAtMs"], null);
    assert.equal(empty["automationRunning"], true);

    // Two reservations exhaust it, and the block says so.
    const position = await f.lpStore.createPosition({
      positionId: "pos-quota",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      tokenId: "8888",
      basisWei: 10n ** 15n,
    });
    for (const kind of ["rotate", "harvest"] as const) {
      const sequence = await f.lpStore.createSequence({
        agentId: LP_AGENT_ID,
        ownerAddress: ownerAccount.address,
        positionId: position.positionId,
        kind,
      });
      await f.lpStore.reserveSequence(
        ownerAccount.address,
        LP_AGENT_ID,
        sequence.sequenceId,
        { maxExitSequencesPerDay: 99, minMinutesBetweenExits: 0 },
      );
      await f.lpStore.setSequenceState(
        ownerAccount.address,
        LP_AGENT_ID,
        sequence.sequenceId,
        "completed",
      );
    }

    const full = await readLp(f);
    assert.equal(full["used"], 2);
    assert.equal(full["remaining"], 0);
    assert.equal(full["exhausted"], true);
    assert.notEqual(full["nextEligibleAtMs"], null);
    // The note must not let an owner read "exhausted" as "my stop-loss is off".
    assert.match(String(full["note"]), /protect, manual exit and open are exempt/iu);
  });

  it("a RELEASED slot leaves the count but still anchors the spacing gate", async () => {
    const f = await fixture();
    const position = await f.lpStore.createPosition({
      positionId: "pos-rel",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      tokenId: "9999",
      basisWei: 10n ** 15n,
    });
    const sequence = await f.lpStore.createSequence({
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: position.positionId,
      kind: "rotate",
    });
    await f.lpStore.reserveSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequence.sequenceId,
      { maxExitSequencesPerDay: 99, minMinutesBetweenExits: 0 },
    );
    await f.lpStore.releaseReservation(
      ownerAccount.address,
      LP_AGENT_ID,
      sequence.sequenceId,
    );

    const quota = await readLp(f);
    assert.equal(quota["used"], 0, "released rows leave the COUNT");
    assert.equal(quota["releasedInWindow"], 1);
    assert.notEqual(
      quota["nextEligibleAtMs"],
      null,
      "…and still anchor the SPACING gate, which is the M3 split",
    );
  });

  it("says automation is NOT running when the settings digest does not verify (audit A3)", async () => {
    // The worker SKIPS a position whose digest does not recompute — it does
    // not fall back to defaults. A quota block computed from that row would
    // describe a budget nothing is consuming.
    const f = await fixture();
    await f.settingsStore.put({
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      // A VALID params object (99 would fail validateLpSettings and test the
      // unreadable path instead) paired with a digest that does not recompute:
      // the row parses, so only the digest gate can decide.
      params: { maxExitSequencesPerDay: 8, minMinutesBetweenExits: 30 },
      digest: `0x${"cd".repeat(32)}`,
    });

    const quota = await readLp(f);
    assert.equal(quota["automationRunning"], false);
    assert.equal(
      quota["limit"],
      DEFAULT_LP_SETTINGS.maxExitSequencesPerDay,
      "the limits shown are the DEFAULTS, never the unverified row's 99",
    );
    assert.match(String(quota["note"]), /SKIPPING/u);
    assert.match(String(quota["note"]), /digest/iu);
  });
});
