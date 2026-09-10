/**
 * AGENT-GAS-ATTENTION §2.1 / §2.4 — the LP worker's gas gate and its backoff.
 *
 * The claim under test is an ECONOMIC one, so the assertions count CHAIN READS
 * rather than inspecting outcome text: a blocked agent must cost no RPC at all.
 * Text is checked only where it is the owner's remedy.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";

import { DEFAULT_LP_SETTINGS, type LpAutomationSettings } from "../src/lp/triggers.js";
import { MemoryAgentStore, type SessionFacts } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { MemoryLpSequenceStore } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import { paramsHash } from "../src/auth/canonical.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import type { LpWorkerChainReaders } from "../src/lp/readers.js";
import {
  createLpWorkerState,
  lpDispatchSpentNothing,
  lpGasBackoffIntervals,
  runLpWorkerOnce,
  type LpWorkerDeps,
  type LpWorkerPositionOutcome,
} from "../src/lp/worker.js";
import { agentGasFloor } from "../src/ops/gasFloor.js";
import type { SessionSpec } from "../src/core/types.js";
import { FakeWalletProvider } from "./support/serverHarness.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0xCC00000000000000000000000000000000000000");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const ROUTER = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const POOL = getAddress("0x4444444444444444444444444444444444444444");
const SESSION_KEY = `0x${"7d".repeat(32)}` as Hex;
const AGENT_ID = "lp-gas-gate";
const POSITION_ID = "lp-gas-position";
const NOW_SEC = 1_900_000_000;
const INTERVAL_MS = 30_000;
const PER_SUBMIT = 38_800_000_000_000n;

/** A plain (non-grid) LP agent reserves an exit sequence: 3 fee units. */
const FLOOR = agentGasFloor({
  profile: "lp-v1",
  gridMode: null,
  relayFeePerSubmitWei: PER_SUBMIT,
})!;

function sessionFacts(): SessionFacts {
  const spec: SessionSpec = {
    allowedCalls: [{ to: NFPM }, { to: ROUTER }],
    spendCaps: [
      { limit: 10n ** 18n, period: "day" },
      { limit: 2n ** 160n, period: "day", token: TOKEN },
      { limit: 2n ** 160n, period: "day", token: WBNB },
    ],
    expiresAt: NOW_SEC + 3_600,
  };
  return { spec, permissions: { calls: [], spend: [] }, publicKey: `0x04${"ab".repeat(64)}` as Hex, expiry: spec.expiresAt };
}

type Counts = { poolState: number; positions: number; positionFees: number; quote: number; native: number; getPool: number; ownerOf: number };

async function fixture(input: { readonly nativeWei?: bigint | undefined; readonly withNativeReader?: boolean }) {
  let nowMs = NOW_SEC * 1_000;
  let blockNumber = 100n;
  let nativeWei = input.nativeWei;
  const now = (): number => nowMs;
  const counts: Counts = { poolState: 0, positions: 0, positionFees: 0, quote: 0, native: 0, getPool: 0, ownerOf: 0 };
  const logs: LpWorkerPositionOutcome[] = [];

  const agentStore = new MemoryAgentStore(null, now);
  const store = new MemoryLpSequenceStore(now);
  const settingsStore = new MemoryLpSettingsStore(now);
  await agentStore.createAgent({
    id: AGENT_ID, ownerAddress: OWNER, walletAddress: OWNER,
    custodyModel: "self-eoa", sessionFacts: sessionFacts(), status: "armed",
  });
  await agentStore.putAgentSessionKey(OWNER, AGENT_ID, SESSION_KEY);
  await store.createPosition({
    positionId: POSITION_ID, agentId: AGENT_ID, ownerAddress: OWNER,
    token0: WBNB, token1: TOKEN, fee: 2500, tokenId: "777", basisWei: 10n ** 18n,
  });
  const settings: LpAutomationSettings = { ...DEFAULT_LP_SETTINGS, autoRotate: true };
  const params = lpSettingsParamsView(settings);
  await settingsStore.put({ agentId: AGENT_ID, ownerAddress: OWNER, params, digest: paramsHash("lpSettings", params) });

  const sqrtPriceX96 = getSqrtRatioAtTick(600);
  const readers: LpWorkerChainReaders = {
    getPool: async () => { counts.getPool += 1; return POOL; },
    poolState: async () => {
      counts.poolState += 1;
      return {
        pool: POOL, tickSpacing: 50, currentTick: 600,
        evidence: {
          blockNumber, finalizedBlockNumber: blockNumber, observationCardinality: 500,
          poolLiquidity: 10n ** 24n, priceImpactBps: 0n,
          spotSqrtPriceX96: sqrtPriceX96, twapSqrtPriceX96: sqrtPriceX96,
        },
      };
    },
    positions: async () => { counts.positions += 1; return { liquidity: 1_000n, tickLower: -500, tickUpper: 500 }; },
    positionFees: async () => { counts.positionFees += 1; return { amount0Wei: 0n, amount1Wei: 0n }; },
    ownerOf: async () => { counts.ownerOf += 1; return OWNER; },
    quote: async () => { counts.quote += 1; return 10n ** 17n; },
    receipts: {
      collectAmounts: async () => ({ amount0Wei: 0n, amount1Wei: 0n }),
      swapAmounts: async () => ({ tokenIn: WBNB, amountInWei: 0n, tokenOut: TOKEN, amountOutWei: 0n }),
      mintedTokenId: async () => 888n,
    },
    onChainNativeDailyCapWei: async () => 10n ** 18n,
    ...(input.withNativeReader === false ? {} : {
      walletNativeBalance: async (_wallet: Address): Promise<bigint> => {
        counts.native += 1;
        if (nativeWei === undefined) throw new Error("balance unreadable");
        return nativeWei;
      },
    }),
  };

  const deps: LpWorkerDeps = {
    agentStore,
    journal: new MemoryExecutionJournal(now),
    killswitch: new MemoryKillSwitch(now),
    store,
    settingsStore,
    observations: new MemoryLpObservationStore(),
    provider: new FakeWalletProvider(),
    readers,
    rails: { maxPriceImpactBps: 300, maxSpotTwapDeviationBps: 500, minObservationCardinality: 10,
      minPoolLiquidity: 1_000n, twapWindowSeconds: 300, maxSagaSlippageBps: 100 },
    maxTickWidth: 200_000,
    conversionCompatibleTokens: new Set<Address>(),
    relayFeePerSubmitWei: PER_SUBMIT,
    venue: { nfpm: NFPM, routerV3: ROUTER, wbnb: WBNB },
    reconcile: async () => undefined,
    now,
    intervalMs: INTERVAL_MS,
    dryRun: false,
    log: (outcome) => { logs.push(outcome); },
  };

  return {
    deps, counts, logs, store, settingsStore,
    fund(wei: bigint): void { nativeWei = wei; },
    unread(): void { nativeWei = undefined; },
    advance(intervals: number): void { nowMs += intervals * INTERVAL_MS; blockNumber += BigInt(intervals); },
  };
}

describe("LP worker gas gate", () => {
  it("a short wallet costs ZERO chain reads and reports the remedy", async () => {
    const f = await fixture({ nativeWei: FLOOR.blockWei - 1n });
    const state = createLpWorkerState();
    const report = await runLpWorkerOnce(f.deps, state);

    // The whole point: nothing downstream of the gate was read.
    assert.equal(f.counts.poolState, 0, "poolState must not be read for a blocked agent");
    assert.equal(f.counts.positions, 0);
    assert.equal(f.counts.positionFees, 0);
    assert.equal(f.counts.quote, 0);
    // REVIEW FINDING 8 — `getPool` and `ownerOf` live inside
    // `loadPositionContext`, and the first build gated AFTER it while this test
    // claimed "the only chain call of the cycle" without counting either. The
    // gate now runs first, so the claim is MEASURED rather than narrowed to the
    // readers the assertion happened to name.
    assert.equal(f.counts.getPool, 0, "getPool runs inside loadPositionContext and must be skipped");
    assert.equal(f.counts.ownerOf, 0, "ownerOf runs inside loadPositionContext and must be skipped");
    assert.equal(f.counts.native, 1);
    assert.deepEqual(
      { ...f.counts, native: 0 },
      { poolState: 0, positions: 0, positionFees: 0, quote: 0, native: 0, getPool: 0, ownerOf: 0 },
      "the balance read must be the ONLY chain call of the cycle",
    );

    assert.equal(report.outcomes.length, 1);
    const outcome = report.outcomes[0]!;
    assert.equal(outcome.action, "skipped");
    assert.match(outcome.reason, /^Deposit at least /u);
    assert.ok(outcome.reason.includes(OWNER), "the remedy must name the wallet to fund");

    // Nothing durable was written: no sequence, no reservation, no lane charge.
    assert.equal((await f.store.listNonTerminalSequencesForWorker()).length, 0);
  });

  it("a funded wallet is untouched by the gate", async () => {
    const f = await fixture({ nativeWei: FLOOR.warnWei });
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(f.counts.poolState, 1, "a funded agent must still be evaluated");
    assert.equal(f.counts.native, 1);
    assert.notEqual(report.outcomes[0]?.reason, undefined);
    assert.doesNotMatch(report.outcomes[0]!.reason, /Deposit/u);
  });

  it("a wallet at exactly one motion's gas is LOW, not blocked", async () => {
    // The boundary `gridShiftGasGate` has always used: `hold` is `<`, not `<=`.
    const f = await fixture({ nativeWei: FLOOR.blockWei });
    await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(f.counts.poolState, 1, "one motion's gas still buys one motion");
  });

  it("an UNREADABLE balance fails closed (3.19 posture), not open", async () => {
    const f = await fixture({ nativeWei: undefined });
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(f.counts.poolState, 0, "an unread balance must never read as funded");
    assert.equal(report.outcomes[0]?.action, "skipped");
    assert.match(report.outcomes[0]!.reason, /could not be read/u);
  });

  it("a deployment with NO native reader is unaffected — an absent instrument is not a short wallet", async () => {
    // Every pre-existing worker fixture is in this shape. If this test fails,
    // the gate has silently stopped every agent on every such deployment.
    const f = await fixture({ withNativeReader: false });
    await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(f.counts.poolState, 1);
    assert.equal(f.counts.native, 0);
  });

  it("the backoff ladder is 1 / 10 / 60 intervals", () => {
    assert.equal(lpGasBackoffIntervals(1), 1);
    assert.equal(lpGasBackoffIntervals(2), 1);
    assert.equal(lpGasBackoffIntervals(3), 10);
    assert.equal(lpGasBackoffIntervals(5), 10);
    assert.equal(lpGasBackoffIntervals(6), 60);
    assert.equal(lpGasBackoffIntervals(600), 60);
  });

  it("backs off: a deep-ladder cycle reads NOTHING, not even the balance", async () => {
    const f = await fixture({ nativeWei: FLOOR.blockWei - 1n });
    const state = createLpWorkerState();

    // Probes 1-3, each one interval apart: the ladder allows a probe per cycle
    // for the first two, so all three read the balance.
    for (let i = 0; i < 3; i += 1) { await runLpWorkerOnce(f.deps, state); f.advance(1); }
    assert.equal(f.counts.native, 3, "the first probes retry at full cadence");

    // Probe 3 set the ladder to 10 intervals. The next cycle is one interval
    // later, so it must cost NOTHING at all.
    const before = { ...f.counts };
    const report = await runLpWorkerOnce(f.deps, state);
    assert.deepEqual(f.counts, before, "a backed-off cycle must make no chain call whatsoever");
    // And it still explains itself rather than going silent.
    assert.equal(report.outcomes[0]?.action, "skipped");
    assert.match(report.outcomes[0]!.reason, /^Deposit at least /u);

    // Ten intervals on, the probe falls due again.
    f.advance(10);
    await runLpWorkerOnce(f.deps, state);
    assert.equal(f.counts.native, before.native + 1);
  });

  it("recovers by itself when the wallet is funded — no owner signature", async () => {
    const f = await fixture({ nativeWei: FLOOR.blockWei - 1n });
    const state = createLpWorkerState();
    await runLpWorkerOnce(f.deps, state);
    assert.equal(f.counts.poolState, 0);

    f.fund(FLOOR.warnWei * 2n);
    f.advance(1);
    await runLpWorkerOnce(f.deps, state);

    assert.equal(f.counts.poolState, 1, "a funded wallet resumes full evaluation");
    assert.equal(state.gasBackoff.size, 0, "recovery is the absence of a reason to wait");
  });

  it("REVIEW FINDING 1: a wallet that can pay for a PROTECT is still evaluated", async () => {
    // Between blockWei (a protect) and nextMotionWei (a rotate) the agent must
    // still be EVALUATED, because a breached stop-loss it can afford to honour
    // must be seen. The first build skipped the position outright here.
    const f = await fixture({ nativeWei: FLOOR.nextMotionWei - 1n });
    assert.ok(FLOOR.nextMotionWei - 1n >= FLOOR.blockWei, "the band must be non-empty");
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(f.counts.poolState, 1, "the position must still be evaluated");
    assert.notEqual(report.outcomes[0]?.action, "skipped");
  });

  it("REVIEW FINDING 2: an absent reader gives EVERY position on the wallet the same verdict", async () => {
    // The first build early-returned for the first position and cached
    // `undefined`, so the SECOND position on the same wallet read that cache,
    // classified it "unknown" and was blocked. Two positions, one wallet, one
    // cycle, opposite verdicts.
    const f = await fixture({ withNativeReader: false });
    await f.store.createPosition({
      positionId: `${POSITION_ID}-2`, agentId: AGENT_ID, ownerAddress: OWNER,
      token0: WBNB, token1: TOKEN, fee: 2500, tokenId: "778", basisWei: 10n ** 18n,
    });
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(report.outcomes.length, 2);
    for (const outcome of report.outcomes) {
      assert.notEqual(outcome.action, "skipped", `position ${outcome.positionId} was skipped`);
    }
    assert.equal(f.counts.poolState, 2, "both positions must be evaluated");
  });

  it("REVIEW FINDING 2b: an unread balance blocks EVERY position on the wallet alike", () => {
    // The mirror of the case above, and the reason `LpNativeReading` has three
    // members rather than two: a FAILED read is evidence the wallet might be
    // short (fail closed), while an ABSENT reader is evidence of nothing.
    // Whichever it is, both positions must get the SAME answer.
    return (async () => {
      const f = await fixture({ nativeWei: undefined });
      await f.store.createPosition({
        positionId: `${POSITION_ID}-2`, agentId: AGENT_ID, ownerAddress: OWNER,
        token0: WBNB, token1: TOKEN, fee: 2500, tokenId: "778", basisWei: 10n ** 18n,
      });
      const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
      assert.equal(report.outcomes.length, 2);
      for (const outcome of report.outcomes) {
        assert.equal(outcome.action, "skipped", `position ${outcome.positionId} was not skipped`);
      }
      assert.equal(f.counts.poolState, 0);
      assert.equal(f.counts.native, 1, "one failed read serves the whole wallet for the cycle");
    })();
  });

  it("one balance read per WALLET per cycle, not per position", async () => {
    // REVIEW 4: this used a BLOCKED wallet and passed for the wrong reason —
    // the first probe armed the backoff, so the second position was skipped
    // before it could read, and bypassing the cache entirely still produced one
    // read. A FUNDED wallet makes both positions actually reach the cache.
    const f = await fixture({ nativeWei: FLOOR.warnWei * 10n });
    await f.store.createPosition({
      positionId: `${POSITION_ID}-2`, agentId: AGENT_ID, ownerAddress: OWNER,
      token0: WBNB, token1: TOKEN, fee: 2500, tokenId: "778", basisWei: 10n ** 18n,
    });
    const report = await runLpWorkerOnce(f.deps, createLpWorkerState());
    assert.equal(report.outcomes.length, 2, "both positions are reported");
    for (const outcome of report.outcomes) {
      assert.notEqual(outcome.action, "skipped", `position ${outcome.positionId} never reached the cache`);
    }
    assert.equal(f.counts.native, 1, "the cache must collapse the two reads into one");
  });
});

describe("LP worker discretionary gas guard (review 2)", () => {
  /** Drive one cycle and return the outcome for the first position. */
  async function cycle(nativeWei: bigint) {
    const f = await fixture({ nativeWei });
    // Two cycles: the rotate trigger needs two finalized observations.
    const state = createLpWorkerState();
    await runLpWorkerOnce(f.deps, state);
    f.advance(1);
    const report = await runLpWorkerOnce(f.deps, state);
    return { f, report };
  }

  it("REVIEW 2: the discretionary guard actually HOLDS a motion the wallet cannot pay for", async () => {
    // Astra's mutation test: deleting the guard entirely survived the previous
    // suite, because that suite only asserted the position was EVALUATED. This
    // asserts the dispatch itself is refused, which is what the guard is for.
    const { f, report } = await cycle(FLOOR.nextMotionWei - 1n);
    const outcome = report.outcomes.at(-1)!;
    assert.equal(outcome.action, "hold", `got ${outcome.action}: ${outcome.reason}`);
    assert.match(outcome.reason, /Holding this motion/u);
    assert.match(outcome.reason, /Protective exits are unaffected/u);
    // A hold writes nothing durable: no sequence, no reservation, no lane charge.
    assert.equal((await f.store.listNonTerminalSequencesForWorker()).length, 0);
  });

  it("REVIEW 2: the same wallet one wei higher DOES dispatch", async () => {
    // The mirror, so the guard cannot be satisfied by refusing everything.
    const { report } = await cycle(FLOOR.nextMotionWei);
    const outcome = report.outcomes.at(-1)!;
    assert.notEqual(outcome.action, "hold");
    assert.doesNotMatch(outcome.reason, /Holding this motion/u);
  });

  it("REVIEW 2 HIGH: a dispatch INVALIDATES the wallet's cached balance", async () => {
    // Two positions on one wallet. The first dispatches and spends; the second
    // must NOT be authorised off the pre-spend reading. Reproduced by the
    // review with a harvest at exactly its floor: both dispatched, one balance
    // read, and the second motion began below its own requirement.
    const f = await fixture({ nativeWei: FLOOR.nextMotionWei });
    await f.store.createPosition({
      positionId: `${POSITION_ID}-2`, agentId: AGENT_ID, ownerAddress: OWNER,
      token0: WBNB, token1: TOKEN, fee: 2500, tokenId: "778", basisWei: 10n ** 18n,
    });
    const state = createLpWorkerState();
    await runLpWorkerOnce(f.deps, state);
    f.advance(1);
    const before = f.counts.native;
    await runLpWorkerOnce(f.deps, state);
    assert.ok(
      f.counts.native > before + 1,
      `a dispatching cycle must re-read the wallet, not reuse the spent figure `
      + `(reads this cycle: ${f.counts.native - before})`,
    );
  });
});

describe("LP worker outstanding-work hold (review 3)", () => {
  it("REVIEW 4: a wallet with work in flight but PLENTY of gas still dispatches", async () => {
    // Round 3 wrote this rule as a boolean and froze healthy siblings for ever,
    // however much BNB the wallet held. Money is not a boolean: a wallet
    // holding a hundred motions' worth is not "occupied" because one is in
    // flight. This is the control that keeps the reservation honest.
    const f = await fixture({ nativeWei: FLOOR.warnWei * 100n });
    await f.store.createPosition({
      positionId: `${POSITION_ID}-2`, agentId: AGENT_ID, ownerAddress: OWNER,
      token0: WBNB, token1: TOKEN, fee: 2500, tokenId: "778", basisWei: 10n ** 18n,
    });
    await f.store.createSequence({
      agentId: AGENT_ID, ownerAddress: OWNER, positionId: POSITION_ID, kind: "rotate",
    });
    const state = createLpWorkerState();
    await runLpWorkerOnce(f.deps, state);
    f.advance(1);
    const report = await runLpWorkerOnce(f.deps, state);
    const sibling = report.outcomes.find((outcome) => outcome.positionId === `${POSITION_ID}-2`);
    assert.notEqual(sibling?.action, "hold", `held a funded wallet: ${sibling?.reason}`);
    assert.doesNotMatch(sibling?.reason ?? "", /reserved for work already in flight/u);
  });

  it("REVIEW 3 HIGH: a THIN wallet with a sequence in flight starts no new discretionary motion", async () => {
    // Cache invalidation cannot see a PENDING submission: the balance has not
    // moved, so the next read legitimately returns the same figure and a second
    // motion passes its floor on money the first is already committed to.
    // The wallet here covers one motion but NOT one motion plus the reservation.
    const f = await fixture({ nativeWei: FLOOR.nextMotionWei });
    await f.store.createPosition({
      positionId: `${POSITION_ID}-2`, agentId: AGENT_ID, ownerAddress: OWNER,
      token0: WBNB, token1: TOKEN, fee: 2500, tokenId: "778", basisWei: 10n ** 18n,
    });
    // A non-terminal sequence on ONE position; the OTHER shares the wallet.
    await f.store.createSequence({
      agentId: AGENT_ID, ownerAddress: OWNER, positionId: POSITION_ID, kind: "rotate",
    });
    const state = createLpWorkerState();
    await runLpWorkerOnce(f.deps, state);
    f.advance(1);
    const report = await runLpWorkerOnce(f.deps, state);

    // The sequence's own position is claimed by the resume path; the SIBLING is
    // the one this rule exists for.
    const sibling = report.outcomes.find((outcome) => outcome.positionId === `${POSITION_ID}-2`);
    assert.equal(sibling?.action, "hold", `got ${sibling?.action}: ${sibling?.reason}`);
    assert.match(sibling!.reason, /reserved for work already in flight/u);
    // And the text must NOT send the owner chasing a deposit they do not need:
    // the wallet is richly funded here.
    assert.doesNotMatch(sibling!.reason, /Deposit/u);
  });

  it("REVIEW 3: a wallet with nothing in flight is unaffected", async () => {
    const f = await fixture({ nativeWei: FLOOR.warnWei * 100n });
    const state = createLpWorkerState();
    await runLpWorkerOnce(f.deps, state);
    f.advance(1);
    const report = await runLpWorkerOnce(f.deps, state);
    const outcome = report.outcomes.at(-1)!;
    assert.doesNotMatch(outcome.reason, /reserved for work already in flight/u);
  });
});

describe("LP worker protect dispatch under low gas (review 3)", () => {
  it("REVIEW 3: a breached stop-loss DISPATCHES at exactly the protect floor", async () => {
    // The finding-1 rule, exercised at its real call site. Review 3 showed the
    // pure predicate was pinned while the DISPATCH condition was not: forcing
    // that condition true survived the whole suite. This drives an actual
    // protect through a wallet that can afford a protect and nothing else.
    const f = await fixture({ nativeWei: FLOOR.blockWei });
    // A stop-loss the position is already through: basis 1 BNB, exit ~0.1.
    const settings: LpAutomationSettings = {
      ...DEFAULT_LP_SETTINGS, autoRotate: false, stopLossPct: 20,
    };
    const params = lpSettingsParamsView(settings);
    await f.settingsStore.put({
      agentId: AGENT_ID, ownerAddress: OWNER, params, digest: paramsHash("lpSettings", params),
    });

    const state = createLpWorkerState();
    // Protection confirms across TWO finalized evaluations.
    await runLpWorkerOnce(f.deps, state);
    f.advance(1);
    const report = await runLpWorkerOnce(f.deps, state);

    const outcome = report.outcomes.at(-1)!;
    assert.notEqual(outcome.action, "skipped", `stood down: ${outcome.reason}`);
    assert.doesNotMatch(outcome.reason, /Holding this motion/u, "a protect must never meet the discretionary floor");
    assert.equal(outcome.decision, "protect-stop-loss", `got ${String(outcome.decision)}: ${outcome.reason}`);
    assert.equal(outcome.kind, "protect");
  });
});

describe("LP worker obligations, after review 4", () => {
  it("REVIEW 4: a failed agent lookup does NOT abort the sweep", async () => {
    // Round 3 seeded the obligations by awaiting `agentFor` OUTSIDE every error
    // boundary, so one unreadable agent row rejected the whole cycle and no
    // position was evaluated — protective work included. A seed failure is
    // uncertainty: it fails the DISCRETIONARY gate closed and nothing else.
    const f = await fixture({ nativeWei: FLOOR.warnWei * 10n });
    await f.store.createSequence({
      agentId: AGENT_ID, ownerAddress: OWNER, positionId: POSITION_ID, kind: "rotate",
    });
    await f.store.createPosition({
      positionId: `${POSITION_ID}-2`, agentId: AGENT_ID, ownerAddress: OWNER,
      token0: WBNB, token1: TOKEN, fee: 2500, tokenId: "778", basisWei: 10n ** 18n,
    });
    // REVIEW 5 — the first version failed the FIRST lookup, which happens
    // inside the resume path's own error boundary; the seed then succeeded and
    // the test proved nothing (replacing the seed's catch with a throw survived
    // 308 tests). The seed is the only caller that asks for the agent while a
    // sequence is being counted, so it is targeted by CALL ORDER: let the
    // resume path have its lookups, then fail the next one.
    // EVERY lookup fails. Targeting one by call order was unreliable: the
    // resume path may skip its own lookup entirely (a stalled sequence defers
    // before loading context), so the seed was never reached. With all of them
    // failing, each stage exercises its OWN boundary — and the cycle must still
    // RESOLVE, which is the property under test.
    let seen = 0;
    const deps: LpWorkerDeps = {
      ...f.deps,
      agentStore: {
        ...f.deps.agentStore,
        getAgentById: async (id: string) => {
          seen += 1;
          void id;
          throw new Error("agent store unavailable");
        },
      } as LpWorkerDeps["agentStore"],
    };
    // The cycle must RESOLVE, not reject: a seed failure is uncertainty at the
    // discretionary gate, never an aborted sweep.
    const report = await runLpWorkerOnce(deps, createLpWorkerState());
    assert.ok(report.outcomes.length > 0, "the sweep produced no outcome at all");
    assert.ok(seen > 0, "the fixture never reached a lookup at all");
  });

  it("REVIEW 4: two dispatches in ONE cycle cannot both spend the same motion's gas", async () => {
    // The dispatch-time reservation, exercised. Removing it survived the
    // previous suite because nothing put two dispatching positions on one
    // wallet that could afford only one motion plus its reservation.
    const f = await fixture({ nativeWei: FLOOR.nextMotionWei * 2n });
    await f.store.createPosition({
      positionId: `${POSITION_ID}-2`, agentId: AGENT_ID, ownerAddress: OWNER,
      token0: WBNB, token1: TOKEN, fee: 2500, tokenId: "778", basisWei: 10n ** 18n,
    });
    const state = createLpWorkerState();
    await runLpWorkerOnce(f.deps, state);
    f.advance(1);
    const report = await runLpWorkerOnce(f.deps, state);
    const held = report.outcomes.filter((outcome) =>
      /reserved for work already in flight/u.test(outcome.reason));
    assert.equal(held.length, 1, "the SECOND position must be held by the first's reservation");
  });
});

describe("LP worker reservation release (review 5)", () => {
  it("REVIEW 5 HIGH: a QUOTA rollback reserves NOTHING — the live agents' state", async () => {
    // Both live LP agents end every cycle `rolled-back / QUOTA` right now. Round
    // 3's version reserved gas for those refusals for ever, so one agent's
    // exhausted quota silently held its sibling on a shared wallet: a NEW
    // production fault invented by a fix. The wallet here covers exactly ONE
    // motion, so a phantom reservation is the difference between the sibling
    // dispatching and being held.
    // Funded for exactly SEVEN fee units: one real reservation (4) plus one
    // motion (3). A phantom reservation from the quota refusal would need
    // eleven, so it is precisely the difference between the third position
    // being evaluated and being held.
    const f = await fixture({ nativeWei: 7n * PER_SUBMIT });
    for (const suffix of ["-2", "-3"]) {
      await f.store.createPosition({
        positionId: `${POSITION_ID}${suffix}`, agentId: AGENT_ID, ownerAddress: OWNER,
        token0: WBNB, token1: TOKEN, fee: 2500, tokenId: suffix === "-2" ? "778" : "779",
        basisWei: 10n ** 18n,
      });
    }
    // One exit slot: the first dispatch takes it, the rest are refused QUOTA
    // before anything is submitted.
    const settings: LpAutomationSettings = {
      ...DEFAULT_LP_SETTINGS, autoRotate: true, maxExitSequencesPerDay: 1,
    };
    const params = lpSettingsParamsView(settings);
    await f.settingsStore.put({
      agentId: AGENT_ID, ownerAddress: OWNER, params, digest: paramsHash("lpSettings", params),
    });

    const state = createLpWorkerState();
    await runLpWorkerOnce(f.deps, state);
    f.advance(1);
    const report = await runLpWorkerOnce(f.deps, state);

    // The exit lane refuses PRE-SUBMIT, whether the reason is the exhausted
    // daily count or the spacing floor: both arrive as code QUOTA with nothing
    // sent, and both must therefore release the reservation they took.
    const refused = report.outcomes.filter((outcome) => outcome.action === "dispatched");
    const phantom = report.outcomes.filter((outcome) =>
      /reserved for work already in flight/u.test(outcome.reason));
    assert.ok(refused.length > 0, "the fixture must actually dispatch and be refused");
    assert.equal(
      phantom.length, 0,
      `a pre-submit refusal reserved gas it never spent: ${phantom.map((o) => o.reason).join(" | ")}`,
    );
  });

  it("REVIEW 5: the release is an ALLOW-LIST — an ambiguous outcome keeps its reservation", () => {
    // The review's warning, as a test: releasing on every rollback would put
    // the pending-gas defect straight back.
    const base = { sequenceId: "s1", kind: "rotate" as const, reason: "", confirmedSteps: 0 };
    assert.equal(lpDispatchSpentNothing({ ...base, status: "rolled-back", code: "QUOTA" }), true);
    assert.equal(lpDispatchSpentNothing({ ...base, status: "rolled-back", code: "AGENT_PAUSED" }), true);
    // Anything that could have followed a send stays reserved.
    assert.equal(lpDispatchSpentNothing({ ...base, status: "rolled-back", code: "POST_VERIFY_FAILED" }), false);
    assert.equal(lpDispatchSpentNothing({ ...base, status: "rolled-back", code: "STEP_REFUSED" }), false);
    assert.equal(lpDispatchSpentNothing({ ...base, status: "held", code: "HELD_AMBIGUOUS" }), false);
    assert.equal(lpDispatchSpentNothing({ ...base, status: "completed", code: "COMPLETED" }), false);
    // A confirmed step disproves "nothing was submitted", whatever the code.
    assert.equal(
      lpDispatchSpentNothing({ ...base, status: "rolled-back", code: "QUOTA", confirmedSteps: 1 }),
      false,
    );
  });
});
