/**
 * Adversarial tests for PHASE3.3's owner-signed resolution route
 * (`PHASE3.3-REVIEW.md` Revision 2 items 6–13, 18, and the item-19 list).
 * Auditor style: every test is an attack or a boundary, and the assertion is
 * what the attacker GETS.
 *
 * The fixture is FINDINGS (al)'s real row, to scale:
 *
 *   lp:<seq>:0  collect-fees     COMMITTED  tx 0xb9…  (freed both legs)
 *   lp:<seq>:1  sweep-token      COMMITTED  tx 0x36…  (CAKE in, WBNB out)
 *   lp:<seq>:2  zap-in-increase  UNKNOWN    no callsId, native_spend 0
 *
 * so the derived legs come out at WBNB 13 443 686 488, which the wallet holds
 * exactly (DISCRIMINATING), and CAKE 2 871 845 548 223 against a wallet balance
 * ~424 000× larger — the FINDINGS (ak) pile, which proves nothing.
 *
 * A5 ERRATUM (PHASE3.3-AUDIT). This fixture is a SCALE MODEL of the live row,
 * not a reproduction of it. The audit re-read both receipts from chain and the
 * numbers differ: the sweep went **WBNB in / CAKE out**, not CAKE in / WBNB out,
 * the collect freed 20 243 148 752 WBNB (not 6 538 010 149), the derived need was
 * 13 337 472 413 WBNB and 5 162 285 606 491 CAKE, and the wallet's
 * 13 443 686 488 was 1.0079× the WBNB need rather than 1.00× (the surplus is
 * pre-existing WBNB). The fixture's own arithmetic is self-consistent and
 * exercises both sign conventions of `deriveStuckStepInputs`, and its assertions
 * are pinned to ITS constants, so it is deliberately left as it stands; the
 * chain-true figures live in `PHASE3.3-SPEC.md` and the audit's own table, which
 * is what the live run must be executed from.
 *
 * Matrix covered here:
 *   - item 8: the route does not exist on a deployment with no LP wired;
 *   - item 9: unknown / foreign / unverifiable decisionId are BYTE-IDENTICAL
 *     404s, while every post-ownership guard is distinguishable;
 *   - the full owner-action authz matrix (no envelope, wrong owner, replayed
 *     nonce, tampered params, route binding, path/param mismatch);
 *   - item 10 (a)–(g), each refusing distinctly;
 *   - item 12's per-kind table, including the row PHASE3.1 changed;
 *   - item 11's ordering and "no step is ever retried";
 *   - item 13: a non-zero-native row is refused;
 *   - item 18: `blockedBySequence`, including PHASE3.3-AUDIT A3's correction
 *     (a protect that cannot advance disarms too);
 *   - PHASE3.3-AUDIT A1: the resolution killed between each pair of its three
 *     writes, and re-driven to completion (`r9`);
 *   - PHASE3.3-AUDIT A7/A9: what a REFUSAL archives, and guard order (`r10`);
 *   - PHASE3.3-AUDIT A2, DEFERRED: the landed-`zap-out` refusal names the
 *     permanent ghost it leaves behind (`r11`);
 *   - THE ACCEPTANCE TEST: a position with a blocking held sequence becomes
 *     protectable and exitable after the resolution.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import {
  AGENT_ID,
  NOW_SEC,
  OTHER_AGENT_ID,
  OTHER_OWNER_PK,
  ROUTER_V3,
  SESSION_KEY,
  TOKEN,
  WBNB,
  call,
  createHarness,
  errorCode,
  freshNonce,
  otherOwnerAccount,
  ownerAccount,
  signOwnerAction,
  toReadHeader,
  type Harness,
  type SignedEnvelope,
} from "./support/serverHarness.js";
import { ownerActionIdempotencyKey } from "../src/auth/executeDecision.js";
import type { SessionFacts } from "../src/store/agents.js";
import type { SessionSpec } from "../src/core/types.js";
import type { LpPoolStateReading, LpServerDeps } from "../src/server.js";
import {
  MemoryLpSequenceStore,
  isTerminalLpSequence,
  lpStepDecisionId,
  type LpSequenceKind,
  type LpStepKind,
} from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { LP_STUCK_PROTECT_REASON } from "../src/lp/triggers.js";
import type { LpRailConfig } from "../src/lp/rails.js";
import type { LpRuntimeConfig } from "../src/ops/config.js";
import type { LpPositionSnapshot } from "../src/lp/sagas.js";

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

const LP_AGENT_ID = "agent-lp";
const NFPM = getAddress("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA");
const POOL_A = getAddress("0xCCCCcCCcccCCCccccCcCcCCCcCcCCCcCCcCcccC1");
const POSITION_ID = "pos-al";
const TOKEN_ID = "7148383";

/** The two confirmed receipts of the real sequence. */
const TX_COLLECT = `0x${"b9".repeat(32)}` as Hex;
const TX_SWEEP = `0x${"36".repeat(32)}` as Hex;

/** Measured on chain 2026-08-17 (review "What the evidence actually says"). */
const SWEEP_TOKEN_IN_WEI = 2_871_845_548_223n;
const SWEEP_WBNB_OUT_WEI = 6_905_676_339n;
const COLLECT_WBNB_WEI = 6_538_010_149n;
const COLLECT_TOKEN_WEI = 5_743_691_096_446n;
/** So the stuck increase needed exactly these. */
const NEEDED_WBNB_WEI = COLLECT_WBNB_WEI + SWEEP_WBNB_OUT_WEI; // 13_443_686_488
const NEEDED_TOKEN_WEI = COLLECT_TOKEN_WEI - SWEEP_TOKEN_IN_WEI; // 2_871_845_548_223
/** The FINDINGS (ak) pile: ~424 000x the CAKE the step needs. */
const AK_PILE_WEI = 1_218_129_206_164_720_874n;

const MIN_AGE_SEC = 1_800;

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
  resolveMinAgeSec: MIN_AGE_SEC,
  resolveDiscriminatingMultipleBps: 12_000,
};

function lpSessionSpec(expiresAt: number): SessionSpec {
  return {
    allowedCalls: [
      { to: ROUTER_V3 },
      { to: NFPM },
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

function healthyState(pool: Address): LpPoolStateReading {
  return {
    pool,
    tickSpacing: 50,
    currentTick: 0,
    evidence: {
      blockNumber: 100n,
      finalizedBlockNumber: 100n,
      observationCardinality: 500,
      poolLiquidity: 10n ** 24n,
      priceImpactBps: 0n,
      spotSqrtPriceX96: 2n ** 96n,
      twapSqrtPriceX96: 2n ** 96n,
    },
  };
}

/**
 * PHASE3.3-AUDIT A1's kill points. The resolution is three writes across two
 * stores with no transaction between them; these counters make a chosen write
 * fail once, so a test can kill the action between each pair and then drive it
 * to completion again.
 */
type StoreFaults = {
  failSetSequenceState: number;
  failSetPositionState: number;
};

type ResolveFixture = {
  readonly harness: Harness;
  /** The REAL store, for seeding and assertions — faults do not apply here. */
  readonly lpStore: MemoryLpSequenceStore;
  /** The faults the SERVER's view of the store will honour. */
  readonly faults: StoreFaults;
  readonly settingsStore: MemoryLpSettingsStore;
  readonly chain: {
    positionsImpl: (tokenId: bigint) => Promise<LpPositionSnapshot | "burned">;
    collect: Map<string, { amount0Wei: bigint; amount1Wei: bigint }>;
    swaps: Map<
      string,
      { tokenIn: Address; amountInWei: bigint; tokenOut: Address; amountOutWei: bigint }
    >;
    blockNumber: bigint | null;
  };
};

async function resolveFixture(): Promise<ResolveFixture> {
  const lpStore = new MemoryLpSequenceStore();
  const settingsStore = new MemoryLpSettingsStore();
  const observations = new MemoryLpObservationStore();

  // A1: the store the SERVER sees. Everything is delegated to the real one
  // (bound to it, because the memory store keeps `#private` state), except a
  // write the test has armed to fail. `Reflect.get(target, prop, target)` keeps
  // the receiver on the real instance so the private brand check passes.
  const faults: StoreFaults = { failSetSequenceState: 0, failSetPositionState: 0 };
  const faultyStore = new Proxy(lpStore, {
    get(target, prop) {
      if (prop === "setSequenceState" && faults.failSetSequenceState > 0) {
        return async (): Promise<never> => {
          faults.failSetSequenceState -= 1;
          throw new Error("lp_sequences write failed (injected)");
        };
      }
      if (prop === "setPositionState" && faults.failSetPositionState > 0) {
        return async (): Promise<never> => {
          faults.failSetPositionState -= 1;
          throw new Error("lp_positions write failed (injected)");
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const chain: ResolveFixture["chain"] = {
    positionsImpl: async (tokenId) =>
      tokenId === BigInt(TOKEN_ID)
        ? { liquidity: 1_228_293_839_000_832_699n, tickLower: -500, tickUpper: 500 }
        : "burned",
    collect: new Map([
      [TX_COLLECT, { amount0Wei: COLLECT_WBNB_WEI, amount1Wei: COLLECT_TOKEN_WEI }],
    ]),
    swaps: new Map([
      [
        TX_SWEEP,
        {
          tokenIn: TOKEN,
          amountInWei: SWEEP_TOKEN_IN_WEI,
          tokenOut: WBNB,
          amountOutWei: SWEEP_WBNB_OUT_WEI,
        },
      ],
    ]),
    blockNumber: 116_391_700n,
  };

  const lp: LpServerDeps = {
    store: faultyStore,
    settingsStore,
    observations,
    workerIntervalMs: 60_000,
    railsResult: { ok: true, config: RAILS },
    runtime: RUNTIME,
    venue: { nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB },
    readers: {
      getPool: async (token0, token1, fee) =>
        token0.toLowerCase() === WBNB.toLowerCase() &&
        token1.toLowerCase() === TOKEN.toLowerCase() &&
        fee === 2500
          ? POOL_A
          : null,
      poolState: async () => healthyState(POOL_A),
      positions: (tokenId) => chain.positionsImpl(tokenId),
      positionFees: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
      ownerOf: async () => ownerAccount.address,
      quote: async (params) => params.amountInWei,
      receipts: {
        collectAmounts: async (txHash) =>
          // A default for any receipt the test did not pin — the exit saga in
          // the acceptance test reads its own fresh tx.
          chain.collect.get(txHash) ?? { amount0Wei: 1_000n, amount1Wei: 1_000n },
        swapAmounts: async (txHash) => {
          const swap = chain.swaps.get(txHash);
          if (swap === undefined) throw new Error(`no swap receipt for ${txHash}`);
          return swap;
        },
        mintedTokenId: async () => BigInt(TOKEN_ID),
      },
      onChainNativeDailyCapWei: async () => 10n ** 18n,
      blockNumber: async () => {
        if (chain.blockNumber === null) throw new Error("block read refused");
        return chain.blockNumber;
      },
    },
  };

  const harness = await createHarness({ lp });
  await harness.agentStore.createAgent({
    id: LP_AGENT_ID,
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    custodyModel: "self-eoa",
    sessionFacts: lpSessionFacts(NOW_SEC + 3_600),
    status: "armed",
  });
  await harness.agentStore.putAgentSessionKey(
    ownerAccount.address,
    LP_AGENT_ID,
    SESSION_KEY,
  );

  // The wallet, as measured: the WBNB leg at 1.00x and the CAKE pile at ~424 000x.
  harness.provider.tokenBalances.set(WBNB.toLowerCase(), NEEDED_WBNB_WEI);
  harness.provider.tokenBalances.set(TOKEN.toLowerCase(), AK_PILE_WEI);

  return { harness, lpStore, faults, settingsStore, chain };
}

type SeedOptions = {
  readonly kind?: LpSequenceKind;
  readonly steps?: readonly LpStepKind[];
  /** Confirmed tx hash per step index; `undefined` records a SKIP. */
  readonly txHashes?: readonly (Hex | undefined)[];
  readonly nativeSpendWei?: bigint;
  readonly callsId?: Hex;
  readonly positionState?: "open" | "closing";
  readonly stuckState?: "UNKNOWN" | "COMMITTED";
  readonly held?: boolean;
  /** Leave the clock where it is, so the row is still inside the age floor. */
  readonly leaveYoung?: boolean;
};

/**
 * Seed FINDINGS (al)'s shape: a position, a non-terminal sequence, confirmed
 * prior steps and one UNKNOWN step with no callsId.
 */
async function seedStuck(
  fixture: ResolveFixture,
  options: SeedOptions = {},
): Promise<{ sequenceId: string; decisionId: string; stuckKey: string }> {
  const kind = options.kind ?? "harvest";
  const steps = options.steps ?? ["collect-fees", "sweep-token", "zap-in-increase"];
  const txHashes = options.txHashes ?? [TX_COLLECT, TX_SWEEP];
  const owner = ownerAccount.address;

  await fixture.lpStore.createPosition({
    positionId: POSITION_ID,
    agentId: LP_AGENT_ID,
    ownerAddress: owner,
    token0: WBNB,
    token1: TOKEN,
    fee: 2500,
    tokenId: TOKEN_ID,
    basisWei: 3_000_000_000_000_000n,
  });
  if (options.positionState === "closing") {
    await fixture.lpStore.setPositionState(owner, LP_AGENT_ID, POSITION_ID, "closing");
  }

  const sequence = await fixture.lpStore.createSequence({
    agentId: LP_AGENT_ID,
    ownerAddress: owner,
    positionId: POSITION_ID,
    kind,
  });
  const sequenceId = sequence.sequenceId;

  let stuckKey = "";
  for (const [index, stepKind] of steps.entries()) {
    const key = `jk:${sequenceId}:${index}`;
    await fixture.lpStore.appendStep(owner, LP_AGENT_ID, sequenceId, {
      kind: stepKind,
      journalIdempotencyKey: key,
    });
    const last = index === steps.length - 1;
    await fixture.harness.journal.begin({
      idempotencyKey: key,
      agentId: LP_AGENT_ID,
      ownerAddress: owner,
      kind: "lp",
      decisionId: lpStepDecisionId(sequenceId, index),
      ...(last && options.callsId !== undefined
        ? { externalRef: { callsId: options.callsId } }
        : {}),
      nativeSpendWei: last ? (options.nativeSpendWei ?? 0n) : 0n,
    });
    if (!last) {
      const txHash = txHashes[index];
      await fixture.harness.journal.markCommitted(
        key,
        txHash === undefined ? {} : { txHash },
      );
      continue;
    }
    stuckKey = key;
    if (options.stuckState === "COMMITTED") {
      await fixture.harness.journal.markCommitted(key);
    } else {
      await fixture.harness.journal.markUnknown(
        key,
        "The relay did not answer within 45000ms. Whether it accepted the submission is UNKNOWN.",
      );
    }
  }

  if (options.held !== false && kind === "harvest") {
    await fixture.lpStore.setRecoveryState(
      owner,
      LP_AGENT_ID,
      sequenceId,
      "wbnb-stranded",
    );
    await fixture.lpStore.setSequenceState(owner, LP_AGENT_ID, sequenceId, "held");
  }

  // Past `RESOLVE_MIN_AGE_SEC` by default; `leaveYoung` keeps the row inside
  // the floor so the age guard itself can be attacked.
  if (options.leaveYoung !== true) {
    fixture.harness.advance((MIN_AGE_SEC + 60) * 1000);
  }

  return { sequenceId, decisionId: lpStepDecisionId(sequenceId, steps.length - 1), stuckKey };
}

function resolvePath(decisionId: string, agentId = LP_AGENT_ID): string {
  return `/agents/${agentId}/journal/${decisionId}/resolve`;
}

/**
 * Sign against the harness's CURRENT clock.
 *
 * `seedStuck` moves the clock past `RESOLVE_MIN_AGE_SEC` — 30 minutes, six
 * times the 300 s owner-action window — so a signature stamped at `NOW_SEC`
 * would be stale before it was sent. That is the freshness guard working; this
 * helper is the honest client that re-stamps rather than a widening of it.
 */
async function signNow(
  fixture: ResolveFixture,
  action: Parameters<typeof signOwnerAction>[0],
  params: unknown,
  options: Parameters<typeof signOwnerAction>[2] = {},
): Promise<SignedEnvelope> {
  const issuedAt = fixture.harness.nowSec();
  return signOwnerAction(action, params, {
    agentId: LP_AGENT_ID,
    issuedAt,
    expiry: issuedAt + 120,
    ...options,
  });
}

async function postResolve(
  fixture: ResolveFixture,
  decisionId: string,
  options: {
    readonly params?: Record<string, unknown>;
    readonly path?: string;
    readonly sign?: Parameters<typeof signOwnerAction>[2];
  } = {},
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const params = options.params ?? { decisionId, observedBlock: "116391700" };
  const envelope = await signNow(fixture, "resolveUnknown", params, options.sign);
  return call(fixture.harness, options.path ?? resolvePath(decisionId), {
    method: "POST",
    body: envelope,
  });
}

function dataOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body["data"] ?? {}) as Record<string, unknown>;
}

function resolutionOf(body: Record<string, unknown>): Record<string, unknown> {
  return (dataOf(body)["resolution"] ?? {}) as Record<string, unknown>;
}

function messageOf(body: Record<string, unknown>): string {
  const error = body["error"];
  if (typeof error !== "object" || error === null) return "";
  return String((error as Record<string, unknown>)["message"] ?? "");
}

/* -------------------------------------------------------------------------- */
/* r1 — deployment shape (Rev2 item 8)                                        */
/* -------------------------------------------------------------------------- */

describe("r1 — the route does not exist until the LP deps are wired", () => {
  it("answers the unknown-path 404 on a server with no lp deps", async () => {
    const harness = await createHarness();
    const envelope = await signOwnerAction(
      "resolveUnknown",
      { decisionId: "lp:seq-1:2", observedBlock: "1" },
      { agentId: AGENT_ID },
    );
    const response = await call(
      harness,
      `/agents/${AGENT_ID}/journal/lp:seq-1:2/resolve`,
      { method: "POST", body: envelope },
    );
    assert.equal(response.status, 404);
    assert.equal(errorCode(response.body), "not_found");
  });
});

/* -------------------------------------------------------------------------- */
/* r2 — authz matrix                                                          */
/* -------------------------------------------------------------------------- */

describe("r2 — authz matrix (the operator token is deliberately NOT sufficient)", () => {
  it("refuses without the service credential, before anything else", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const response = await call(fixture.harness, resolvePath(decisionId), {
      method: "POST",
      body: {},
      noExecToken: true,
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "unauthorized");
  });

  it("refuses with no owner envelope — an operator token cannot resolve anything", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const response = await call(fixture.harness, resolvePath(decisionId), {
      method: "POST",
      body: { decisionId, observedBlock: "1" },
      headers: { "x-operator-token": "operator-token-value" },
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
    assert.equal((await fixture.harness.journal.get("x"))?.state, undefined);
  });

  it("answers the WRONG owner with the same 404 a missing agent gets, and touches nothing", async () => {
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture);
    const response = await postResolve(fixture, decisionId, {
      sign: { pk: OTHER_OWNER_PK },
    });
    assert.equal(response.status, 404);
    assert.equal(errorCode(response.body), "not_found");
    assert.equal((await fixture.harness.journal.get(stuckKey))?.state, "UNKNOWN");
  });

  it("refuses a replayed nonce on a SECOND, different signed action", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const nonce = freshNonce();
    const first = await postResolve(fixture, decisionId, { sign: { nonce } });
    assert.equal(first.status, 200);

    const second = await postResolve(fixture, decisionId, {
      params: { decisionId, observedBlock: "116391701" },
      sign: { nonce },
    });
    assert.equal(second.status, 401);
    assert.equal(errorCode(second.body), "owner_auth_failed");
  });

  it("answers a byte-identical retry from the journal without touching the nonce", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const envelope = await signNow(fixture, "resolveUnknown", {
      decisionId,
      observedBlock: "116391700",
    });
    const first = await call(fixture.harness, resolvePath(decisionId), {
      method: "POST",
      body: envelope,
    });
    assert.equal(first.status, 200);
    const retry = await call(fixture.harness, resolvePath(decisionId), {
      method: "POST",
      body: envelope,
    });
    assert.equal(retry.status, 200);
    assert.equal(dataOf(retry.body)["replayed"], true);
  });

  it("refuses params tampered after signing — the digest binds the bytes", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const envelope: SignedEnvelope = await signNow(fixture, "resolveUnknown", {
      decisionId,
      observedBlock: "116391700",
    });
    const tampered = { ...envelope, params: { decisionId, observedBlock: "1" } };
    const response = await call(fixture.harness, resolvePath(decisionId), {
      method: "POST",
      body: tampered,
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("refuses an lpExit envelope posted to the resolve route (binding)", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const envelope = await signNow(fixture, "lpExit", { positionId: POSITION_ID });
    const response = await call(fixture.harness, resolvePath(decisionId), {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("refuses the fleet sentinel — resolveUnknown is not a global action (Rev2 item 6)", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const response = await postResolve(fixture, decisionId, {
      path: resolvePath(decisionId, "*"),
      sign: { agentId: "*" },
    });
    assert.equal(response.status, 401);
    assert.equal(errorCode(response.body), "owner_auth_failed");
  });

  it("refuses a signed decisionId that does not match the path (400)", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const response = await postResolve(fixture, decisionId, {
      params: { decisionId: "lp:other:2", observedBlock: "1" },
    });
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /does not match the path/u);
  });

  it("refuses params carrying an unexpected field — including a txHash (no landed direction in v1)", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const response = await postResolve(fixture, decisionId, {
      params: { decisionId, observedBlock: "1", txHash: `0x${"aa".repeat(32)}` },
    });
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /unexpected field "txHash"/u);
  });
});

/* -------------------------------------------------------------------------- */
/* r3 — item 9: the three not-founds are byte-identical                       */
/* -------------------------------------------------------------------------- */

describe("r3 — unknown, foreign and unverifiable decisionIds are byte-identical 404s", () => {
  it("produces the same body for a decisionId that does not exist, one owned by another agent, and one whose kind has no verifier", async () => {
    const fixture = await resolveFixture();
    await seedStuck(fixture);

    // (1) never existed.
    const unknown = await postResolve(fixture, "lp:no-such-sequence:0");

    // (2) belongs to ANOTHER agent under another owner.
    await fixture.harness.journal.begin({
      idempotencyKey: "foreign-key",
      agentId: OTHER_AGENT_ID,
      ownerAddress: otherOwnerAccount.address,
      kind: "lp",
      decisionId: "lp:foreign-seq:0",
    });
    await fixture.harness.journal.markUnknown("foreign-key", "held");
    const foreign = await postResolve(fixture, "lp:foreign-seq:0");

    // (3) exists, is ours, is UNKNOWN — but is a `trade` row this build has no
    // verifier for. It shares the decision-id namespace, so it is FOUND and
    // must still answer identically rather than leaking that it exists.
    await fixture.harness.journal.begin({
      idempotencyKey: "trade-key",
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      kind: "trade",
      decisionId: "d-trade-stuck",
    });
    await fixture.harness.journal.markUnknown("trade-key", "held");
    const unverifiable = await postResolve(fixture, "d-trade-stuck");

    assert.equal(unknown.status, 404);
    assert.equal(foreign.status, 404);
    assert.equal(unverifiable.status, 404);
    assert.equal(unknown.text, foreign.text);
    assert.equal(unknown.text, unverifiable.text);
    // And the trade row was NOT touched.
    assert.equal((await fixture.harness.journal.get("trade-key"))?.state, "UNKNOWN");
  });
});

/* -------------------------------------------------------------------------- */
/* r4 — item 10: the check set, each refusing distinctly                      */
/* -------------------------------------------------------------------------- */

describe("r4 — the verifier's checks, in order, each refusing distinctly (item 10)", () => {
  /* ────────────────────────────────────────────────────────────────────────
   * DECLARED INVERSION OF AN AUDITOR-WRITTEN TEST — PHASE3.14 (R-A′ / F1).
   *
   * This case previously asserted that a row WITH a `callsId` is REFUSED
   * `has_calls_id`, "naming reconcile". It is inverted here deliberately, and
   * the BUILD doc declares it so the phase auditor is pointed straight at it.
   *
   * WHY THE OLD ASSERTION WAS UNSOUND. `PHASE3.3-AUDIT` A9 moved the state gate
   * IN FRONT of that branch (`PHASE3.3-AUDIT.md:544-556`,
   * `PHASE3.3-FIXREVIEW.md:341-347`), so `has_calls_id` could only ever fire on
   * an UNKNOWN row — and an UNKNOWN row is precisely the row `reconcile` has
   * DISOWNED: its query is `state in ('PENDING','IN_PROGRESS')`. The message
   * therefore told the owner to wait for a pass that would never look at the
   * row, and to "restart the server, not sign anything". Mainnet 2026-08-25
   * proved the cost: the relay answered `{"status":300,"receipts":[]}` stably
   * for 30+ minutes, `toCallsStatusReceipt` mapped it to PENDING, reconcile
   * wrote UNKNOWN, and this refusal was the last of FOUR closed doors on a
   * position with its liquidity intact.
   *
   * The guard's "correct half" that the PHASE3.14 spec wanted preserved does
   * not exist to preserve: narrowing it by state IS deleting it. What survives
   * and is still pinned is A9's own ordering — the case immediately below.
   * ──────────────────────────────────────────────────────────────────────── */
  it("(a) PHASE3.14: a row WITH a callsId is ACCEPTED — reconcile has disowned it", async () => {
    const fixture = await resolveFixture();
    const { decisionId, sequenceId, stuckKey } = await seedStuck(fixture, {
      callsId: `0x${"c1".repeat(32)}`,
    });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200);
    // It took the SAME direct-evidence path a callsId-less row takes.
    assert.equal((await fixture.harness.journal.get(stuckKey))?.state, "ROLLED_BACK");
    const sequence = await fixture.lpStore.getSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequenceId,
    );
    assert.equal(sequence?.state, "rolled-back");
    assert.equal(isTerminalLpSequence(sequence!.state, sequence!.recoveryState), true);
    // The row shape is recorded as what it is, not refused for being it.
    const resolution = response.body["data"] as Record<string, unknown>;
    const inner = resolution["resolution"] as Record<string, unknown>;
    const checks = inner["checks"] as readonly { name: string; result: string }[];
    const shape = checks.find((check) => check.name === "row-shape");
    assert.match(shape?.result ?? "", /carrying a callsId reconcile has already disowned/u);
    // F6: the abandon of a row that REACHED the relay discloses that the
    // submission may still land, and what that would mean for this step kind.
    assert.match(String(inner["note"]), /MAY STILL LAND/u);
    assert.match(String(inner["note"]), /liquidity would grow/u);
  });

  it("(a) a row that is not UNKNOWN is refused", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, { stuckState: "COMMITTED" });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /not_unknown/u);
  });

  it("(b) a row younger than RESOLVE_MIN_AGE_SEC is refused, and says the guard is a heuristic", async () => {
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture, { leaveYoung: true });
    // Comfortably inside the 30-minute floor, and well past our own 45 s client
    // timeout — the point being that OUR timeout is not the quantity that
    // matters.
    fixture.harness.advance(10 * 60 * 1000);

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /too_young/u);
    assert.match(messageOf(response.body), /heuristic, not a proof/u);
    assert.equal((await fixture.harness.journal.get(stuckKey))?.state, "UNKNOWN");
  });

  it("(c) a row with non-zero nativeSpendWei is refused, and the daily-cap sum is untouched (item 13)", async () => {
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture, {
      nativeSpendWei: 10n ** 15n,
    });
    const before = await fixture.harness.journal.sumNativeSpendSince(LP_AGENT_ID, 0);
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /native_spend/u);
    assert.equal(
      await fixture.harness.journal.sumNativeSpendSince(LP_AGENT_ID, 0),
      before,
    );
    assert.equal((await fixture.harness.journal.get(stuckKey))?.state, "UNKNOWN");
  });

  it("(e) a MISSING leg is refused — the wallet no longer holds what the step would have spent", async () => {
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture);
    // The increase landed: the WBNB is gone.
    fixture.harness.provider.tokenBalances.set(WBNB.toLowerCase(), 0n);
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /inputs_missing/u);
    assert.equal((await fixture.harness.journal.get(stuckKey))?.state, "UNKNOWN");
  });

  it("(f) an ALL-SURPLUS step is refused as unresolvable — the (ak) pile proves nothing", async () => {
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture);
    // Both legs now sit in a fungible surplus, which is exactly the state one
    // rotate on the agent's other position would produce.
    fixture.harness.provider.tokenBalances.set(
      WBNB.toLowerCase(),
      NEEDED_WBNB_WEI * 1_000n,
    );
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /unresolvable/u);
    assert.match(messageOf(response.body), /fungible surplus/u);
    assert.equal((await fixture.harness.journal.get(stuckKey))?.state, "UNKNOWN");
  });

  it("(g) records the log-absence probe as UNAVAILABLE with a reason — never silently skipped", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200);
    const logAbsence = resolutionOf(response.body)["logAbsence"] as Record<string, unknown>;
    assert.equal(logAbsence["checked"], false);
    assert.match(String(logAbsence["detail"]), /capability-probed/u);
  });

  it("a stuck collect-fees is unresolvable: it spends the position's own fees, not the wallet", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, { steps: ["collect-fees"] });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /unresolvable/u);
  });

  it("a stuck harvest sweep is unresolvable: its amount came from a market read nobody can replay", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, {
      steps: ["collect-fees", "sweep-token"],
      txHashes: [TX_COLLECT],
    });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /unresolvable/u);
    assert.match(messageOf(response.body), /market read/u);
  });
});

/* -------------------------------------------------------------------------- */
/* r5 — item 12: the per-kind disposition table                               */
/* -------------------------------------------------------------------------- */

describe("r5 — the per-kind disposition table (item 12)", () => {
  it("harvest: abandons the sequence and leaves the position OPEN and untouched", async () => {
    const fixture = await resolveFixture();
    const { decisionId, sequenceId, stuckKey } = await seedStuck(fixture);

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200);
    const resolution = resolutionOf(response.body);
    assert.equal(resolution["action"], "abandon");
    assert.equal(resolution["positionRestoredToOpen"], false);
    assert.equal(resolution["journalState"], "ROLLED_BACK");

    const sequence = await fixture.lpStore.getSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequenceId,
    );
    assert.equal(sequence?.state, "rolled-back");
    // `recoveryState` is NOT cleared — it is evidence, and `setRecoveryState`
    // refuses on a terminal sequence anyway.
    assert.equal(sequence?.recoveryState, "wbnb-stranded");
    assert.equal(isTerminalLpSequence(sequence!.state, sequence!.recoveryState), true);

    const position = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "open");
    assert.equal(position?.basisWei, 3_000_000_000_000_000n);

    // No step was retried: nothing was submitted, ever.
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
    assert.equal(fixture.harness.provider.preflightCalls.length, 0);

    // `last_error` survives (item 17).
    const row = await fixture.harness.journal.get(stuckKey);
    assert.match(row?.lastError ?? "", /did not answer within 45000ms/u);
    assert.equal(row?.externalRef.resolution?.action, "resolveUnknown");
  });

  it("rotate is REFUSED distinctly, naming out-of-band custody recovery", async () => {
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture, {
      kind: "rotate",
      steps: ["zap-out", "sweep-token", "zap-in-mint"],
      held: false,
    });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /sequence_kind_unsupported/u);
    assert.match(messageOf(response.body), /custody recovery/u);
    assert.equal((await fixture.harness.journal.get(stuckKey))?.state, "UNKNOWN");
  });

  it("open is REFUSED distinctly, with the same backstop named", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, {
      kind: "open",
      steps: ["zap-in-mint"],
      held: false,
    });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /sequence_kind_unsupported/u);
    assert.match(messageOf(response.body), /custody recovery/u);
  });

  it("manual-exit stuck at step 0: abandons AND restores the position closing -> open", async () => {
    const fixture = await resolveFixture();
    const { decisionId, sequenceId } = await seedStuck(fixture, {
      kind: "manual-exit",
      steps: ["zap-out"],
      positionState: "closing",
      held: false,
    });

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200);
    assert.equal(resolutionOf(response.body)["positionRestoredToOpen"], true);

    const sequence = await fixture.lpStore.getSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequenceId,
    );
    assert.equal(sequence?.state, "rolled-back");

    // The whole point: back in the worker's queue, `open` and not `closing`.
    const queue = await fixture.lpStore.listOpenPositionsForWorker();
    const row = queue.find((entry) => entry.positionId === POSITION_ID);
    assert.notEqual(row, undefined);
    assert.equal(row?.state, "open");
    assert.equal(row?.basisWei, 3_000_000_000_000_000n);
  });

  it("manual-exit stuck at step 0 whose zap-out DID land is ADVANCED (PHASE3.9a)", async () => {
    // This row of the table INVERTED in 3.9a. It used to pin a refusal on the
    // strongest evidence the deployment can obtain; PHASE3.3-AUDIT A2 said that
    // was wrong and the edge to fix it did not exist yet. It does now.
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, {
      kind: "manual-exit",
      steps: ["zap-out"],
      positionState: "closing",
      held: false,
    });
    fixture.chain.positionsImpl = async () => ({
      liquidity: 0n,
      tickLower: -500,
      tickUpper: 500,
    });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = await fixture.harness.journal.getByDecision(LP_AGENT_ID, decisionId);
    assert.equal(row?.state, "COMMITTED");
  });

  /**
   * THE ROW PHASE3.1 CHANGED. Item 12 says an abandoned exit restores
   * `closing -> open`; 3.1 moved the close into step 0's `after`, so an exit
   * stuck at step 1 finds the position ALREADY `closed`, where that transition
   * would THROW and where restoring it would produce a zero-basis zombie.
   */
  it("manual-exit stuck at step 1 leaves the CLOSED position alone (PHASE3.1 erratum to item 12)", async () => {
    const fixture = await resolveFixture();
    const { decisionId, sequenceId } = await seedStuck(fixture, {
      kind: "manual-exit",
      steps: ["zap-out", "sweep-token"],
      txHashes: [TX_COLLECT],
      held: false,
    });
    // 3.1: step 0's confirm closed the position and zeroed the basis.
    await fixture.lpStore.setPositionState(
      ownerAccount.address,
      LP_AGENT_ID,
      POSITION_ID,
      "closed",
    );
    // The exit swap's input is the confirmed collect's non-quote leg alone.
    fixture.harness.provider.tokenBalances.set(TOKEN.toLowerCase(), COLLECT_TOKEN_WEI);

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200);
    assert.equal(resolutionOf(response.body)["positionRestoredToOpen"], false);
    assert.match(String(resolutionOf(response.body)["summary"]), /left closed/u);

    const sequence = await fixture.lpStore.getSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequenceId,
    );
    assert.equal(sequence?.state, "rolled-back");
    const position = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "closed");
  });
});

/* -------------------------------------------------------------------------- */
/* r6 — the evidence record (item 17)                                         */
/* -------------------------------------------------------------------------- */

describe("r6 — the evidence is stored, not just acted on (item 17)", () => {
  it("records the caller's block, the server's block, every check, the legs and the signing owner", async () => {
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture);

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200);

    const row = await fixture.harness.journal.get(stuckKey);
    const stored = row?.externalRef.resolution;
    assert.notEqual(stored, undefined);
    assert.equal(stored?.observedBlock, "116391700");
    assert.equal(stored?.serverBlock, "116391700");
    // The persisted OWNER SCOPE KEY, which is the lowercased address — the
    // same identifier every owner-scoped query is keyed on.
    assert.equal(stored?.ownerAddress, ownerAccount.address.toLowerCase());
    assert.ok((stored?.checks.length ?? 0) >= 4);
    // Per-leg: needed, held, and whether it DISCRIMINATES.
    const wbnbLeg = stored?.legs.find(
      (leg) => leg.token.toLowerCase() === WBNB.toLowerCase(),
    );
    const tokenLeg = stored?.legs.find(
      (leg) => leg.token.toLowerCase() === TOKEN.toLowerCase(),
    );
    assert.equal(wbnbLeg?.neededWei, NEEDED_WBNB_WEI.toString(10));
    assert.equal(wbnbLeg?.walletWei, NEEDED_WBNB_WEI.toString(10));
    assert.equal(wbnbLeg?.discriminating, true);
    assert.equal(tokenLeg?.neededWei, NEEDED_TOKEN_WEI.toString(10));
    assert.equal(tokenLeg?.discriminating, false);
    // The receipt says plainly that this is an inference.
    assert.equal(resolutionOf(response.body)["inference"], true);
  });

  it("records serverBlock as unavailable rather than lying when the read fails", async () => {
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture);
    fixture.chain.blockNumber = null;

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200);
    const stored = (await fixture.harness.journal.get(stuckKey))?.externalRef.resolution;
    assert.equal(stored?.serverBlock, null);
    assert.ok(
      stored?.checks.some(
        (check) => check.name === "server-block" && check.result === "unavailable",
      ),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* r7 — item 18: protection status stops lying                                */
/* -------------------------------------------------------------------------- */

describe("r7 — computeLpProtectionStatus reports the blocking sequence (item 18)", () => {
  async function armStopLoss(fixture: ResolveFixture): Promise<void> {
    const envelope = await signNow(fixture, "lpSettings", { stopLossPct: 5 });
    const response = await call(fixture.harness, `/agents/${LP_AGENT_ID}/lp/settings`, {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 200);
  }

  async function readProtection(
    fixture: ResolveFixture,
  ): Promise<Record<string, unknown>> {
    const header = toReadHeader(await signNow(fixture, "read", {}));
    const response = await call(fixture.harness, `/agents/${LP_AGENT_ID}/lp`, {
      headers: { "x-owner-action": header },
    });
    assert.equal(response.status, 200);
    const positions = dataOf(response.body)["positions"] as Record<string, unknown>[];
    const position = positions.find((entry) => entry["positionId"] === POSITION_ID);
    return (position?.["protection"] ?? {}) as Record<string, unknown>;
  }

  it("reports armed: false with a blockedBySequence reason for exactly the trapped position", async () => {
    const fixture = await resolveFixture();
    await seedStuck(fixture);
    await armStopLoss(fixture);

    const protection = await readProtection(fixture);
    assert.equal(protection["armed"], false);
    assert.match(String(protection["reason"]), /non-terminal harvest sequence/u);
    assert.match(String(protection["reason"]), /SEQUENCE_CONFLICT/u);
    const blocked = protection["blockedBySequence"] as Record<string, unknown> | null;
    assert.equal(blocked?.["kind"], "harvest");
  });

  it("reports armed: true once the resolution has made the sequence terminal", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture);
    await armStopLoss(fixture);
    assert.equal((await readProtection(fixture))["armed"], false);

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200);

    const protection = await readProtection(fixture);
    assert.equal(protection["armed"], true);
    assert.equal(protection["blockedBySequence"], null);
  });

  /**
   * FIXTURE CORRECTED by PHASE3.3-AUDIT A3, assertions untouched.
   *
   * This test's CLAIM — a non-terminal protect does not disarm, because the
   * next cycle resuming it IS the protect firing — is true only of a protect the
   * driver can ADVANCE. As first written it seeded a protect whose only step row
   * was `UNKNOWN`, which `deriveLpSequenceProgress` can only HOLD, for ever,
   * with no `callsId` for `reconcile` to work from: so it asserted `armed: true`
   * about a stop-loss that could never fire, pinning the defect rather than the
   * intent. The step row is now `COMMITTED` — a protect mid-flight, which is
   * what the claim was always about. The stuck case is the test below.
   */
  it("a non-terminal PROTECT sequence does not disarm anything — that IS the protect firing", async () => {
    const fixture = await resolveFixture();
    await seedStuck(fixture, {
      kind: "protect",
      steps: ["zap-out"],
      stuckState: "COMMITTED",
      held: false,
    });
    await armStopLoss(fixture);

    const protection = await readProtection(fixture);
    assert.equal(protection["blockedBySequence"], null);
    assert.equal(protection["armed"], true);
  });

  /**
   * PHASE3.3-AUDIT A3. The kind-only exemption reported `armed: true` here —
   * the same lie R17 exists to remove, in the one family of cases this phase is
   * about, asserted by a passing test.
   */
  it("a PROTECT sequence stuck on an UNKNOWN step row DOES disarm, with a reason that names itself", async () => {
    const fixture = await resolveFixture();
    await seedStuck(fixture, {
      kind: "protect",
      steps: ["zap-out"],
      held: false,
    });
    await armStopLoss(fixture);

    const protection = await readProtection(fixture);
    assert.equal(protection["armed"], false);
    assert.equal(protection["reason"], LP_STUCK_PROTECT_REASON);
    // It names the protect itself, NOT a kind conflict: the remedy is the
    // resolution route, not waiting for another sequence to finish.
    assert.match(String(protection["reason"]), /own protect sequence/u);
    assert.match(String(protection["reason"]), /journal/u);
    const blocked = protection["blockedBySequence"] as Record<string, unknown> | null;
    assert.equal(blocked?.["kind"], "protect");
  });

  it("stops disarming once that stuck protect has itself been resolved", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, {
      kind: "protect",
      steps: ["zap-out"],
      positionState: "closing",
      held: false,
    });
    await armStopLoss(fixture);
    assert.equal((await readProtection(fixture))["armed"], false);

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200);
    assert.equal(resolutionOf(response.body)["positionRestoredToOpen"], true);

    const protection = await readProtection(fixture);
    assert.equal(protection["armed"], true);
    assert.equal(protection["blockedBySequence"], null);
  });
});

/* -------------------------------------------------------------------------- */
/* r9 — PHASE3.3-AUDIT A1: killed between each pair of writes, then re-driven  */
/* -------------------------------------------------------------------------- */

describe("r9 — A1: a partially-applied resolution is re-runnable to completion", () => {
  it("killed between the journal write and the sequence write, it completes on the SECOND signature", async () => {
    const fixture = await resolveFixture();
    const { decisionId, sequenceId, stuckKey } = await seedStuck(fixture);

    /* --- attempt 1: write (1) lands, write (2) dies ----------------------- */

    fixture.faults.failSetSequenceState = 1;
    const first = await postResolve(fixture, decisionId);
    assert.equal(first.status, 500);

    // The trap, exactly as the audit describes it: the row is spent…
    const spent = await fixture.harness.journal.get(stuckKey);
    assert.equal(spent?.state, "ROLLED_BACK");
    assert.notEqual(spent?.externalRef.resolution, undefined);
    // …and the sequence is STILL non-terminal, so the position is still stuck.
    const midway = await fixture.lpStore.getSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequenceId,
    );
    assert.equal(isTerminalLpSequence(midway!.state, midway!.recoveryState), false);

    /* --- attempt 2: the same signed action, again ------------------------- */

    const second = await postResolve(fixture, decisionId);
    assert.equal(second.status, 200);
    const resolution = resolutionOf(second.body);
    assert.equal(resolution["reEntry"], true);
    assert.equal(resolution["journalState"], "ROLLED_BACK");

    const after = await fixture.lpStore.getSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequenceId,
    );
    assert.equal(after?.state, "rolled-back");
    assert.equal(isTerminalLpSequence(after!.state, after!.recoveryState), true);
    assert.equal(
      await fixture.lpStore.getNonTerminalSequence(
        ownerAccount.address,
        LP_AGENT_ID,
        POSITION_ID,
      ),
      null,
    );
    // Still no retry, and the FIRST attempt's evidence is what stands: one
    // decision, recorded once.
    assert.equal(fixture.harness.provider.executeCalls.length, 0);
    const row = await fixture.harness.journal.get(stuckKey);
    assert.equal(row?.externalRef.resolution?.at, spent?.externalRef.resolution?.at);
    assert.match(row?.lastError ?? "", /did not answer within 45000ms/u);
  });

  it("killed between the sequence write and the position write, the re-entry frees the position", async () => {
    const fixture = await resolveFixture();
    const { decisionId, sequenceId } = await seedStuck(fixture, {
      kind: "manual-exit",
      steps: ["zap-out"],
      positionState: "closing",
      held: false,
    });

    fixture.faults.failSetPositionState = 1;
    const first = await postResolve(fixture, decisionId);
    assert.equal(first.status, 500);

    // The `closing` ghost the spec forbids by name: terminal sequence, position
    // out of the worker's queue, nothing left to explain why.
    const sequence = await fixture.lpStore.getSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequenceId,
    );
    assert.equal(sequence?.state, "rolled-back");
    const ghost = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      POSITION_ID,
    );
    assert.equal(ghost?.state, "closing");
    assert.equal(
      (await fixture.lpStore.listOpenPositionsForWorker()).find(
        (entry) => entry.positionId === POSITION_ID,
      ),
      undefined,
    );

    // The sequence is terminal now, so the pre-A1 build would have refused this
    // re-attempt twice over: `not_unknown` on the row and `sequence_terminal`
    // on the sequence.
    const second = await postResolve(fixture, decisionId);
    assert.equal(second.status, 200);
    assert.equal(resolutionOf(second.body)["reEntry"], true);
    assert.equal(resolutionOf(second.body)["positionRestoredToOpen"], true);

    const queued = (await fixture.lpStore.listOpenPositionsForWorker()).find(
      (entry) => entry.positionId === POSITION_ID,
    );
    assert.equal(queued?.state, "open");
    assert.equal(queued?.basisWei, 3_000_000_000_000_000n);
  });

  it("a re-entry is refused for a sequence kind v1 does not disposition", async () => {
    // Belt and braces on the re-entry gate: it skips the EVIDENCE checks and
    // nothing else, so the per-kind table still governs.
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture, {
      kind: "rotate",
      steps: ["zap-out", "sweep-token", "zap-in-mint"],
      held: false,
    });
    await fixture.harness.journal.resolveUnknown(stuckKey, {
      action: "resolveUnknown",
      at: 1,
      ownerAddress: ownerAccount.address.toLowerCase(),
      observedBlock: "1",
      serverBlock: null,
      checks: [],
      legs: [],
      logAbsence: { checked: false, detail: "n/a" },
      disposition: "hand-written, as a leak would be",
    });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /sequence_kind_unsupported/u);
  });

  it("a re-entry is refused once a NEWER sequence holds the position", async () => {
    // The only way a second non-terminal sequence can exist is if this
    // resolution's sequence write already landed — so the only outstanding write
    // is the position restore, and that position's state now belongs to the
    // newer saga. Re-entering would yank it out from under a live exit.
    const fixture = await resolveFixture();
    const { decisionId, sequenceId } = await seedStuck(fixture, {
      kind: "manual-exit",
      steps: ["zap-out"],
      positionState: "closing",
      held: false,
    });

    fixture.faults.failSetPositionState = 1;
    assert.equal((await postResolve(fixture, decisionId)).status, 500);

    // A later saga picks the position up (legal now: the old sequence is
    // terminal) and takes it `closing` for its own exit.
    const newer = await fixture.lpStore.createSequence({
      agentId: LP_AGENT_ID,
      ownerAddress: ownerAccount.address,
      positionId: POSITION_ID,
      kind: "protect",
    });
    assert.notEqual(newer.sequenceId, sequenceId);

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /re_entry_superseded/u);
    // And it left the newer sequence's position state alone.
    const position = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "closing");
  });

  it("an ordinary ROLLED_BACK row — one with no resolution evidence — is NOT a re-entry", async () => {
    // The two conditions together are the gate. A row that provably never
    // reached a relay is rolled back with no evidence, and re-dispositioning it
    // would be inventing a resolution that never happened.
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture, {
      stuckState: "COMMITTED",
    });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /not_unknown/u);
    assert.equal(
      (await fixture.harness.journal.get(stuckKey))?.externalRef.resolution,
      undefined,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* r10 — A7 / A9: what a REFUSAL archives, and which guard fires first        */
/* -------------------------------------------------------------------------- */

describe("r10 — a refusal is auditable too (A7), and names the right guard (A9)", () => {
  it("archives the whole check list on the action's OWN row, not just a 300-char message", async () => {
    const fixture = await resolveFixture();
    const { decisionId, stuckKey } = await seedStuck(fixture);
    // Both legs in a surplus: the (f) refusal, which is the one an operator is
    // most likely to have to argue about.
    fixture.harness.provider.tokenBalances.set(
      WBNB.toLowerCase(),
      NEEDED_WBNB_WEI * 1_000n,
    );

    const envelope = await signNow(fixture, "resolveUnknown", {
      decisionId,
      observedBlock: "116391700",
    });
    const response = await call(fixture.harness, resolvePath(decisionId), {
      method: "POST",
      body: envelope,
    });
    assert.equal(response.status, 400);

    // The UNKNOWN row is untouched — refusing is the point.
    assert.equal((await fixture.harness.journal.get(stuckKey))?.state, "UNKNOWN");

    // The action's own row carries the findings. Its key is derived from the
    // signed struct exactly as `ownerMutation` derives it.
    const signed = envelope.signed;
    const actionRow = await fixture.harness.journal.get(
      ownerActionIdempotencyKey({
        owner: String(signed["owner"]) as Address,
        agentId: String(signed["agentId"]),
        action: "resolveUnknown",
        paramsHash: String(signed["paramsHash"]) as Hex,
        nonce: String(signed["nonce"]) as Hex,
        issuedAt: BigInt(String(signed["issuedAt"])),
        expiry: BigInt(String(signed["expiry"])),
      }),
    );
    assert.equal(actionRow?.kind, "resolveUnknown");
    assert.equal(actionRow?.state, "ROLLED_BACK");
    const stored = actionRow?.externalRef.resolution;
    assert.notEqual(stored, undefined);
    assert.match(String(stored?.disposition), /^refused:unresolvable$/u);
    assert.equal(stored?.serverBlock, "116391700");
    assert.equal(stored?.ownerAddress, ownerAccount.address.toLowerCase());
    // Every check the verifier ran, including the refusal itself.
    assert.ok((stored?.checks.length ?? 0) >= 4);
    assert.ok(stored?.checks.some((check) => check.name === "refused:unresolvable"));
    // And the per-leg numbers the refusal turned on.
    assert.equal(stored?.legs.length, 2);
    // The `publicKey` seeded at `begin` survived the merge.
    assert.notEqual(actionRow?.externalRef.publicKey, undefined);
  });

  it("A9: a COMMITTED row that also carries a callsId is told it is not UNKNOWN, not to restart a server", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, {
      stuckState: "COMMITTED",
      callsId: `0x${"c1".repeat(32)}`,
    });
    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 400);
    assert.match(messageOf(response.body), /not_unknown/u);
    assert.doesNotMatch(messageOf(response.body), /reconcile/u);
  });
});

/* -------------------------------------------------------------------------- */
/* r11 — A2, DEFERRED: the refusal must name the ghost                        */
/* -------------------------------------------------------------------------- */

describe("r11 — a landed zap-out is ADVANCED, not refused (PHASE3.9a closes A2)", () => {
  // This test was the inverse of itself one phase ago. It pinned that positive
  // on-chain proof of a landed withdrawal produced a PERMANENT refusal, and
  // asserted the cost: the position stuck at `closing`, out of the worker's
  // queue, under a non-terminal sequence, counting in openPositionsCount for
  // ever. PHASE3.3-AUDIT A2 said that was wrong and the code comment named the
  // missing piece — the `UNKNOWN → COMMITTED` edge — which 3.9a reserves.
  //
  // What is pinned now is the opposite outcome from the SAME evidence.

  it("records the step COMMITTED and CLOSES the position", async () => {
    const fixture = await resolveFixture();
    const { decisionId, sequenceId } = await seedStuck(fixture, {
      kind: "manual-exit",
      steps: ["zap-out"],
      positionState: "closing",
      held: false,
    });
    fixture.chain.positionsImpl = async () => "burned";

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200, JSON.stringify(response.body));

    // The row tells the TRUTH: the step happened. Recording it ROLLED_BACK
    // would also have released a spend the chain made, since ROLLED_BACK is the
    // one state outside SPEND_COUNTING_STATES.
    const row = await fixture.harness.journal.getByDecision(LP_AGENT_ID, decisionId);
    assert.equal(row?.state, "COMMITTED");
    assert.notEqual(row?.externalRef.resolution, undefined, "and it carries its evidence");

    // The ghost is gone: terminal sequence, closed position.
    const sequence = await fixture.lpStore.getSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequenceId,
    );
    assert.equal(isTerminalLpSequence(sequence!.state, sequence!.recoveryState), true);
    const position = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "closed");
  });

  it("zero liquidity is the same proof as a burned token", async () => {
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, {
      kind: "manual-exit",
      steps: ["zap-out"],
      positionState: "closing",
      held: false,
    });
    fixture.chain.positionsImpl = async () => ({
      liquidity: 0n,
      tickLower: -500,
      tickUpper: 500,
    });

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = await fixture.harness.journal.getByDecision(LP_AGENT_ID, decisionId);
    assert.equal(row?.state, "COMMITTED");
  });

  it("a STILL-FUNDED position is abandoned, not advanced — the evidence points the other way", async () => {
    // The discriminating half that must not move: liquidity still there means
    // the withdrawal did NOT land, and that is an abandon with the position
    // restored to open.
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, {
      kind: "manual-exit",
      steps: ["zap-out"],
      positionState: "closing",
      held: false,
    });
    fixture.chain.positionsImpl = async () => ({
      liquidity: 1_228_293_839_000_832_699n,
      tickLower: -500,
      tickUpper: 500,
    });

    const response = await postResolve(fixture, decisionId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = await fixture.harness.journal.getByDecision(LP_AGENT_ID, decisionId);
    assert.equal(row?.state, "ROLLED_BACK", "abandoned, because the liquidity is still there");
    const position = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "open", "and restored so the worker can exit it again");
  });

  it("REVIEW M5: an interrupted ADVANCE is re-runnable", async () => {
    // `resumedResolution` recognised only ROLLED_BACK. With advance writing
    // COMMITTED, the same predicate would have called an interrupted advance
    // un-resumed and the action would be un-re-runnable — verbatim the defect
    // PHASE3.8-AUDIT A1 found one phase earlier on this same property.
    const fixture = await resolveFixture();
    const { decisionId } = await seedStuck(fixture, {
      kind: "manual-exit",
      steps: ["zap-out"],
      positionState: "closing",
      held: false,
    });
    fixture.chain.positionsImpl = async () => "burned";

    assert.equal((await postResolve(fixture, decisionId)).status, 200);
    // Re-sign the same action: the row is already COMMITTED, and re-entry must
    // re-apply the remaining writes rather than refuse.
    const second = await postResolve(fixture, decisionId);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const position = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "closed");
  });
});

/* -------------------------------------------------------------------------- */
/* r8 — THE ACCEPTANCE TEST                                                   */
/* -------------------------------------------------------------------------- */

describe("r8 — acceptance: a position with a blocking held sequence becomes protectable and exitable", () => {
  it("is refused SEQUENCE_CONFLICT before the resolution and exits after it", async () => {
    const fixture = await resolveFixture();
    const { decisionId, sequenceId } = await seedStuck(fixture);

    /* --- before: the owner's own exit is refused by (al)'s trap ---------- */

    const blockedExit = await call(
      fixture.harness,
      `/agents/${LP_AGENT_ID}/lp/${POSITION_ID}/exit`,
      {
        method: "POST",
        body: await signNow(fixture, "lpExit", { positionId: POSITION_ID }),
      },
    );
    assert.equal(blockedExit.status, 200);
    const blocked = dataOf(blockedExit.body)["exit"] as Record<string, unknown>;
    assert.equal(blocked["code"], "SEQUENCE_CONFLICT");
    assert.equal(fixture.harness.provider.executeCalls.length, 0);

    /* --- the resolution -------------------------------------------------- */

    const resolved = await postResolve(fixture, decisionId);
    assert.equal(resolved.status, 200);

    const sequence = await fixture.lpStore.getSequence(
      ownerAccount.address,
      LP_AGENT_ID,
      sequenceId,
    );
    assert.equal(isTerminalLpSequence(sequence!.state, sequence!.recoveryState), true);
    assert.equal(
      await fixture.lpStore.getNonTerminalSequence(
        ownerAccount.address,
        LP_AGENT_ID,
        POSITION_ID,
      ),
      null,
    );

    // Protectable: back in the worker's trigger queue as `open`.
    const queue = await fixture.lpStore.listOpenPositionsForWorker();
    assert.equal(
      queue.find((entry) => entry.positionId === POSITION_ID)?.state,
      "open",
    );

    /* --- after: the exit runs -------------------------------------------- */

    // The zap-out empties the position on its second read, exactly as a real
    // one does: build sees the liquidity, post-verify sees zero.
    let reads = 0;
    fixture.chain.positionsImpl = async () => {
      reads += 1;
      return reads === 1
        ? { liquidity: 1_228_293_839_000_832_699n, tickLower: -500, tickUpper: 500 }
        : { liquidity: 0n, tickLower: -500, tickUpper: 500 };
    };

    const exit = await call(
      fixture.harness,
      `/agents/${LP_AGENT_ID}/lp/${POSITION_ID}/exit`,
      {
        method: "POST",
        body: await signNow(fixture, "lpExit", { positionId: POSITION_ID }),
      },
    );
    assert.equal(exit.status, 200);
    const exitData = dataOf(exit.body)["exit"] as Record<string, unknown>;
    assert.notEqual(exitData["code"], "SEQUENCE_CONFLICT");
    assert.equal(exitData["code"], "COMPLETED");
    assert.equal(exitData["status"], "completed");
    // The exit — and ONLY the exit — submitted. The abandoned step was never
    // retried by anything (item 11).
    assert.equal(fixture.harness.provider.executeCalls.length, 1);

    const position = await fixture.lpStore.getPosition(
      ownerAccount.address,
      LP_AGENT_ID,
      POSITION_ID,
    );
    assert.equal(position?.state, "closed");
  });
});
