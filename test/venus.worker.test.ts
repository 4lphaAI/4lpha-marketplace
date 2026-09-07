/**
 * PHASE4 — the worker cycle, and the four `PHASE4-AUDIT.md` HIGH findings.
 *
 * The audit's A5 is the reason this file exists: three of the four blocking
 * findings lived on a surface with ZERO tests, so the suite was green while the
 * guard could not be armed (A1), wedged permanently on the one real debt market
 * (A2), submitted through a pause (A3), and published a budget gate that did
 * not exist (A4). A green suite that cannot see the worker is not evidence.
 *
 * The harness is deliberately small: fake readers answering one owner, memory
 * stores, a recording provider. Every test below fails on the pre-fix code.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";

import { MemoryAgentStore } from "../src/store/agents.js";
import { DRAFT_KEY, cancelDraft, pendingDraft } from "./support/provisioningDraft.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { MemoryVenusSettingsStore } from "../src/store/venusSettings.js";
import { MemoryVenusObservationStore } from "../src/store/venusObservations.js";
import { MemoryVenusActionStore } from "../src/store/venusActions.js";
import { runVenusWorkerOnce, type VenusWorkerDeps } from "../src/venus/worker.js";
import { venusSessionSpec } from "../src/ops/policy.js";
import { E18 } from "../src/venus/risk.js";
import { paramsHash } from "../src/auth/canonical.js";
import type { VenusChainReaders } from "../src/venus/readers.js";
import type {
  VenusAccountReading,
  VenusMarketReading,
  VenusVenue,
} from "../src/venus/types.js";
import type { WalletCall, WalletProvider } from "../src/core/types.js";

const OWNER = getAddress("0x561b561ef37874c8e61534be9bae52eb6261ddc4");
const WALLET = OWNER;
const AGENT = "venus-guard-1";
const COMPTROLLER = getAddress("0xfd36e2c2a6789db23113685031d7f16329158384");
const PRIME = getAddress("0x059eaba8676b03e4e8f009efb7f587c28450f50f");
const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
const TREASURY = getAddress("0x00000000000000000000000000000000000000fe");

const INTERVAL = 30_000;
const NOW = 10_000_000;

function pct(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * E18 + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

const VENUE: VenusVenue = {
  comptroller: COMPTROLLER,
  prime: PRIME,
  vBnb: V_BNB,
  treasury: TREASURY,
} as VenusVenue;

/**
 * W = 844.8 (8e18 vBNB @ 0.22 xr, 0.8 lt, $600), D = 900 USDT ⇒ HF = 0.9387,
 * under a 1.30 trigger. The protocol tuples AGREE with that reconstruction by
 * construction, so the R2.2 equality gate passes and the cycle reaches sizing.
 */
function marketReading(overrides: Partial<VenusMarketReading> = {}): VenusMarketReading {
  return {
    vToken: V_BNB,
    vTokenSymbol: "vBNB",
    vTokenDecimals: 8,
    underlying: null,
    underlyingDecimals: 18,
    native: true,
    listed: true,
    borrowAllowed: true,
    collateralMember: true,
    vTokenBalance: 8n * E18,
    borrowStored: 0n,
    exchangeRateStored: 220_000_000_000_000_000n,
    borrowCurrent: 0n,
    exchangeRateCurrent: 220_000_000_000_000_000n,
    effectiveCf: pct("0.8"),
    effectiveLt: pct("0.8"),
    spotPrice: pct("600"),
    boundedCollateralPrice: pct("600"),
    boundedDebtPrice: pct("600"),
    mintPaused: false,
    repayPaused: false,
    supplyHeadroom: 10n ** 24n,
    walletBalance: 10n ** 18n,
    allowance: 0n,
    ...overrides,
  } as VenusMarketReading;
}

function usdtReading(overrides: Partial<VenusMarketReading> = {}): VenusMarketReading {
  return marketReading({
    vToken: V_USDT,
    vTokenSymbol: "vUSDT",
    underlying: USDT,
    native: false,
    collateralMember: false,
    vTokenBalance: 0n,
    borrowStored: 900n * E18,
    borrowCurrent: 900n * E18,
    exchangeRateStored: E18,
    exchangeRateCurrent: E18,
    spotPrice: pct("1"),
    boundedCollateralPrice: pct("1"),
    boundedDebtPrice: pct("1"),
    walletBalance: 500n * E18,
    allowance: 0n,
    ...overrides,
  });
}

/**
 * The protocol tuples must AGREE with the reconstruction or the R2.2 equality
 * gate refuses before anything else — correctly, and it is why they are an
 * explicit parameter rather than a constant: a fixture that changes a balance
 * without changing the tuple ends up testing `protocol-mismatch` instead of
 * whatever its name claims. (This one did, until a mutation caught it.)
 */
function accountReading(
  markets: readonly VenusMarketReading[],
  tuple?: readonly [bigint, bigint, bigint],
): VenusAccountReading {
  const w = pct("844.8");
  const d = pct("900");
  const answer = tuple ?? ([0n, 0n, d - w] as const);
  return {
    blockNumber: 117_741_526n,
    blockHash: `0x${"d6".repeat(32)}` as Hex,
    owner: OWNER,
    protocolPaused: false,
    userPoolId: 0n,
    lastPoolId: 15n,
    vaiDebt: 0n,
    accountLiquidity: answer,
    borrowingPower: answer,
    markets,
    snapshotErrorMarket: null,
  };
}

type Submission = { readonly calls: readonly WalletCall[] };

function fakeReaders(reading: VenusAccountReading): VenusChainReaders {
  return {
    readAccount: async () => reading,
    readRoutingCensus: async () => ({ ok: true }) as never,
    // Effect verification (R2.8): report the debt as reduced so a dispatched
    // repay reads as effective rather than as `no-effect`.
    readBorrowCurrent: async () => 0n,
    readVTokenBalance: async () => 8n * E18,
    readTokenBalance: async () => 0n,
    readPrimePaused: async () => false,
    readPrimePending: async () => [],
    simulateXvsClaim: async () => 0n,
    readUnderlyingPrice: async () => pct("600"),
    readMarketIndex: async () => ({
      [V_BNB.toLowerCase()]: { underlying: null },
      [V_USDT.toLowerCase()]: { underlying: USDT },
    }),
  } as unknown as VenusChainReaders;
}

function fakeProvider(submissions: Submission[]): WalletProvider {
  return {
    restoreSession: () => ({ sessionId: "session-1" }),
    // PHASE2.4's seam: a refusal here provably never reached a relay. This fake
    // always passes, so the tests below exercise the SUBMIT path rather than
    // the pre-submit rollback.
    preflightExecute: async () => undefined,
    async executeViaSession(input: { readonly calls: readonly WalletCall[] }) {
      submissions.push({ calls: input.calls });
      return {
        status: "CONFIRMED",
        transactionHash: `0x${"ab".repeat(32)}`,
        callsId: `0x${"cd".repeat(32)}`,
      };
    },
  } as unknown as WalletProvider;
}

const SETTINGS_PARAMS = {
  triggerHf: pct("1.3").toString(),
  targetHf: pct("1.6").toString(),
  debtMarkets: [V_USDT],
  collateralMarkets: [V_BNB],
  maxPerAction: [
    { token: USDT, maxWei: (1_000n * E18).toString() },
    { token: null, maxWei: (10n ** 18n).toString() },
  ],
  maxClaimsPerDay: 4,
  minSecondsBetweenActions: 0,
  minClaimValueWei: "0",
  claimEnabled: true,
  claimRepayEnabled: false,
  rescueReserveCount: 4,
};

type HarnessOptions = {
  readonly markets?: readonly VenusMarketReading[];
  /** The protocol's own (errorCode, liquidity, shortfall), when overridden. */
  readonly tuple?: readonly [bigint, bigint, bigint];
  readonly paused?: boolean;
  readonly caps?: { readonly dailyNativeWei?: bigint };
  readonly dryRun?: boolean;
  readonly previousSpend?: bigint;
};

async function harness(options: HarnessOptions = {}) {
  const agentStore = new MemoryAgentStore();
  const journal = new MemoryExecutionJournal();
  const killswitch = new MemoryKillSwitch();
  const settingsStore = new MemoryVenusSettingsStore();
  const observations = new MemoryVenusObservationStore();
  const actions = new MemoryVenusActionStore(() => NOW);
  const submissions: Submission[] = [];

  await agentStore.createAgent({
    id: AGENT,
    ownerAddress: OWNER,
    walletAddress: WALLET,
    custodyModel: "self-eoa",
    ...(options.caps === undefined ? {} : { caps: options.caps }),
    sessionFacts: {
      // The REAL template, so the grant check the worker performs is the one
      // production performs — a hand-rolled spec here would pass a test that
      // production fails (or the reverse).
      spec: venusSessionSpec({
        comptroller: COMPTROLLER,
        prime: PRIME,
        vBnb: V_BNB,
        vTokens: [V_USDT],
        tokens: [{ token: USDT, vToken: V_USDT, dailyCapWei: 10n ** 24n }],
        treasury: TREASURY,
        nativeCaps: [{ limit: 10n ** 21n, period: "day" }],
        expiresAt: Math.floor(NOW / 1000) + 3_600,
        nowSeconds: Math.floor(NOW / 1000),
      }),
      permissions: { calls: [], spend: [] },
      publicKey: `0x04${"ab".repeat(64)}` as Hex,
      expiry: Math.floor(NOW / 1000) + 3_600,
    },
  });

  await agentStore.putAgentSessionKey(OWNER, AGENT, `0x${"7d".repeat(32)}` as Hex);

  if (options.paused === true) await killswitch.pauseAgent(AGENT, OWNER);

  const digest = paramsHash("venusSettings", SETTINGS_PARAMS);
  await settingsStore.put({
    agentId: AGENT,
    ownerAddress: OWNER,
    params: SETTINGS_PARAMS,
    digest,
  });

  // A banked prior observation, one full interval old, so the hysteresis
  // counter is already at its second confirmation and the cycle can act.
  await observations.put({
    ownerAddress: OWNER,
    agentId: AGENT,
    kind: "rescue",
    observation: {
      blockNumber: 117_741_000n,
      evaluatedAtMs: NOW - INTERVAL,
      healthFactor: pct("0.9387"),
      shortfall: true,
      breach: true,
      consecutive: 1,
      settingsDigest: digest,
      collateral: pct("844.8"),
      debt: pct("900"),
    },
  });

  const markets = options.markets ?? [marketReading(), usdtReading()];
  const deps: VenusWorkerDeps = {
    agentStore,
    journal,
    killswitch,
    provider: fakeProvider(submissions),
    settingsStore,
    observations,
    actions,
    readers: fakeReaders(accountReading(markets, options.tuple)),
    venue: VENUE,
    intervalMs: INTERVAL,
    maxObservationAgeMs: INTERVAL * 3,
    agentConcurrency: 4,
    now: () => NOW,
    dryRun: options.dryRun ?? false,
  };

  return { deps, submissions, journal, actions, observations, killswitch };
}

const selectorOf = (call: WalletCall): string => (call.data ?? "0x").slice(0, 10);

describe("venus worker: A2 — the allowance actually reaches the builder", () => {
  it("a RESIDUAL allowance produces the zero-first approve leg on the rescue path", async () => {
    // The pre-fix worker dropped `allowance` when building sizing markets and
    // read it back through a cast that was always `0n`, so this leg could never
    // be emitted. USDT reverts a non-zero -> non-zero approve, so without it the
    // guard wedges on the one real debt market after exactly the failOpaque
    // no-effect event this phase measured live.
    const { deps, submissions } = await harness({
      markets: [marketReading(), usdtReading({ allowance: 7n })],
    });
    const report = await runVenusWorkerOnce(deps);
    assert.equal(report.outcomes[0]?.action, "dispatched");
    assert.equal(submissions.length, 1);
    const calls = submissions[0]?.calls ?? [];
    // approve(0) -> approve(amount) -> repayBorrow(amount)
    assert.equal(calls.length, 3);
    assert.equal(selectorOf(calls[0] as WalletCall), "0x095ea7b3");
    assert.equal(BigInt(`0x${(calls[0]?.data as string).slice(-64)}`), 0n);
    assert.equal(selectorOf(calls[1] as WalletCall), "0x095ea7b3");
    assert.ok(BigInt(`0x${(calls[1]?.data as string).slice(-64)}`) > 0n);
    assert.equal(selectorOf(calls[2] as WalletCall), "0x0e752702");
  });

  it("no residual means no zero leg — two calls, not three", async () => {
    const { deps, submissions } = await harness();
    await runVenusWorkerOnce(deps);
    assert.equal(submissions[0]?.calls.length, 2);
  });
});

describe("venus worker: A3 — a paused agent submits NOTHING", () => {
  it("R5 refuses rescue for a canceled draft despite a stale enabled settings row", async () => {
    const h = await harness();
    const nowSec = Math.floor(NOW / 1_000);
    const agents = new MemoryAgentStore(null, () => NOW);
    await agents.createProvisioningAgent({ record: { id: AGENT, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey" },
      pendingGrant: pendingDraft(OWNER, WALLET, nowSec), sessionKey: DRAFT_KEY });
    await cancelDraft(agents, OWNER, AGENT, nowSec);
    const report = await runVenusWorkerOnce({ ...h.deps, agentStore: agents });
    assert.equal(h.submissions.length, 0);
    assert.equal(report.outcomes[0]?.condition, "session-expired-or-revoked");
    assert.match(report.outcomes[0]?.reason ?? "", /NO_SESSION/u);
    assert.equal(await h.journal.sumNativeSpendSince(AGENT, 0), 0n);
    assert.equal((await agents.getAgent(OWNER, AGENT))?.sessionFacts, null);
  });
  it("a paused agent holds instead of dispatching a rescue", async () => {
    // Pre-fix this authorized the whole cycle with `reducesExposure: true`, so
    // the pause was skipped entirely and the rescue submitted. D4 is normative:
    // "pausing the agent is the off switch".
    const { deps, submissions } = await harness({ paused: true });
    const report = await runVenusWorkerOnce(deps);
    assert.equal(submissions.length, 0);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "hold");
    assert.equal(outcome?.condition, "killswitch");
    assert.match(outcome?.reason ?? "", /AGENT_PAUSED/u);
  });

  it("unpausing restores the rescue — the pause is a refusal, not a corruption", async () => {
    const { deps, submissions, killswitch } = await harness({ paused: true });
    await runVenusWorkerOnce(deps);
    assert.equal(submissions.length, 0);
    await killswitch.unpauseAgent(AGENT, OWNER);
    const report = await runVenusWorkerOnce(deps);
    assert.equal(report.outcomes[0]?.action, "dispatched");
    assert.equal(submissions.length, 1);
  });
});

describe("venus worker: A4 — claims are gated by agent.caps, rescues are not", () => {
  it("a RESCUE still dispatches with the daily native budget already spent", async () => {
    // R2.9/FINDINGS (ah): a daily cap that can refuse the last repay before
    // liquidation is a liquidation vector wearing a budget's name.
    const { deps, submissions } = await harness({ caps: { dailyNativeWei: 1n } });
    const report = await runVenusWorkerOnce(deps);
    assert.equal(report.outcomes[0]?.action, "dispatched");
    assert.equal(submissions.length, 1);
  });

  it("a CLAIM is refused when the agent's daily native budget admits nothing", async () => {
    // The claim branch is reached only when no rescue is needed, so the account
    // is healthy here: W = 844.8 against 1 wei of debt.
    //
    // NOTE ON THIS FIXTURE, because the first version of it was VACUOUS and a
    // mutation proved it: seeding `dailyNativeWei: 1n` on a fresh harness tests
    // nothing, because the journal has no rows, `spentTodayWei` is 0, and
    // `0 >= 1` is false — deleting the whole gate left the suite green. The
    // budget has to actually admit nothing for the gate to be observable.
    const healthy = [
      marketReading(),
      usdtReading({ borrowStored: 1n, borrowCurrent: 1n }),
    ];
    const { deps, submissions } = await harness({
      markets: healthy,
      // W = 844.8, D = 1 wei => liquidity = W - 1, no shortfall. Stated here so
      // the equality gate passes and the cycle actually reaches the claim.
      tuple: [0n, pct("844.8") - 1n, 0n],
      caps: { dailyNativeWei: 0n },
    });
    const report = await runVenusWorkerOnce(deps);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "hold");
    assert.equal(outcome?.condition, "quota-exhausted");
    // The reason must name the BUDGET, so this cannot pass on some other
    // refusal that happens to share the condition.
    assert.match(outcome?.reason ?? "", /daily native budget/u);
    assert.equal(submissions.length, 0);
  });

  it("the same zero budget does NOT stop a rescue — the asymmetry, in one pair", async () => {
    const { deps, submissions } = await harness({ caps: { dailyNativeWei: 0n } });
    const report = await runVenusWorkerOnce(deps);
    assert.equal(report.outcomes[0]?.action, "dispatched");
    assert.equal(submissions.length, 1);
  });
});

describe("Revision 4 (V7.1): the pre-R4 settings row through a real cycle", () => {
  it("a digest-verified row naming vBNB in collateralMarkets holds with ZERO submissions, and the reason leads with the wrap remedy", async () => {
    // The exact V1 threat: the stored row predates Revision 4 (the route would
    // refuse its shape today, but rows are never migrated and the digest
    // recompute passes), the grant still carries mint() on chain, and the
    // repay route is CLOSED (no USDT in the wallet). Pre-R4 this cycle
    // dispatched the (as-2) native mint.
    const { deps, submissions } = await harness({
      markets: [marketReading(), usdtReading({ walletBalance: 0n })],
    });
    const report = await runVenusWorkerOnce(deps);
    const outcome = report.outcomes[0];
    assert.equal(outcome?.action, "hold");
    assert.equal(submissions.length, 0);
    // V2 closure, proven by this very assertion: the sanitized reason caps at
    // ~300 chars and the skip-list (which carries the condition NAME) falls
    // PAST the cap — the wrap remedy survives ONLY because it leads. Asserting
    // the prefix is asserting the design decision.
    assert.match(outcome?.reason ?? "", /^Wrap BNB to WBNB by hand/u);
    assert.match(outcome?.reason ?? "", /0x6bCa74586218db34cDB402295796b79663d816e9/u);
  });
});

describe("venus worker: the properties the audit verified intact", () => {
  it("dry-run writes NOTHING and submits NOTHING", async () => {
    const { deps, submissions, actions, observations } = await harness({ dryRun: true });
    const report = await runVenusWorkerOnce(deps);
    assert.equal(submissions.length, 0);
    assert.equal(report.outcomes[0]?.action, "dry-run");
    const usage = await actions.usageSince(OWNER, AGENT, 0);
    assert.equal(usage.submissions, 0);
    // The banked observation is untouched by a rehearsal.
    const row = await observations.get(OWNER, AGENT, "rescue");
    assert.equal(row?.evaluatedAtMs, NOW - INTERVAL);
  });

  it("a dispatched rescue is CHARGED — counted, never refused (R3.4)", async () => {
    const { deps, actions } = await harness();
    await runVenusWorkerOnce(deps);
    const usage = await actions.usageSince(OWNER, AGENT, 0);
    assert.equal(usage.rescues, 1);
    assert.equal(usage.submissions, 1);
  });

  it("the observation is written BELOW the dispatch, carrying this cycle's frozen clock", async () => {
    const { deps, observations } = await harness();
    await runVenusWorkerOnce(deps);
    const row = await observations.get(OWNER, AGENT, "rescue");
    assert.equal(row?.evaluatedAtMs, NOW);
  });
});
