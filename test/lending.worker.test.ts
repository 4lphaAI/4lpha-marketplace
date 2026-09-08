/**
 * The lending worker's cycle — the hysteresis, the doors, the holds and the
 * dry-run gate (MARKETPLACE-LENDING-AGENT §5.1, §5.6, R2.13, R2.18, R2.21,
 * R3.4, R3.7, R3.11; R2.24 and REVIEW2 §4's added obligations).
 *
 * The harness is deliberately small: fake readers answering one guarded
 * account, memory stores, a recording provider, and a clock the test moves by
 * hand. The protocol tuples AGREE with the reconstruction BY CONSTRUCTION —
 * they are computed from the same fixture — so a test whose name says
 * "hysteresis" is not silently testing `protocol-mismatch`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";

import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { MemoryVenusSettingsStore } from "../src/store/venusSettings.js";
import { MemoryVenusObservationStore } from "../src/store/venusObservations.js";
import { MemoryLendingGuardStore } from "../src/store/lendingGuards.js";
import { calculateVenusRisk, E18 } from "../src/venus/risk.js";
import {
  lendingSessionSpec,
  walletNativeFloorWei,
  RELAY_FEE_PER_EXIT_WEI,
} from "../src/ops/policy.js";
import { lendingSettingsDigest } from "../src/http/lendingWire.js";
import {
  LendingAccountTooComplexError,
  type LendingChainReaders,
} from "../src/lending/readers.js";
import { runLendingWorkerOnce, type LendingWorkerDeps } from "../src/lending/worker.js";
import type { VenusAccountReading, VenusMarketReading } from "../src/venus/types.js";
import type { LendingReserveReading } from "../src/lending/types.js";
import { ProviderError, type WalletCall, type WalletProvider } from "../src/core/types.js";

const OWNER = getAddress("0x561b561ef37874c8e61534be9bae52eb6261ddc4");
const WALLET = getAddress("0x00000000000000000000000000000000000000b1");
const GUARDED = getAddress("0x00000000000000000000000000000000000000a9");
const AGENT = "lending-guard-1";
const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
const ROUTER = getAddress("0x1b81d678ffb9c0263b24a97847620c99d213eb14");
const WBNB = getAddress("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
const QUOTER = getAddress("0xb048bbc1ee6b733fffcfb9e9cef7375518e25997");
const FACTORY = getAddress("0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865");
const POOL = getAddress("0x172fcd41e0913e95784454622d1c3724f546f849");
const TREASURY = getAddress("0x00000000000000000000000000000000000000fe");

const INTERVAL = 30_000;
const NOW = 10_000_000;

function pct(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * E18 + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

const VENUE = {
  vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB, routerV3: ROUTER, wbnb: WBNB,
  quoterV2: QUOTER, factoryV3: FACTORY, swapPool: POOL, swapFeeTier: 100 as const,
  treasury: TREASURY,
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function market(overrides: Partial<VenusMarketReading> = {}): VenusMarketReading {
  return {
    vToken: V_BNB, vTokenSymbol: "vBNB", vTokenDecimals: 8,
    underlying: null, underlyingDecimals: 18, native: true,
    listed: true, borrowAllowed: true, collateralMember: true,
    vTokenBalance: 8n * E18, borrowStored: 0n,
    exchangeRateStored: 220_000_000_000_000_000n,
    borrowCurrent: 0n, exchangeRateCurrent: 220_000_000_000_000_000n,
    effectiveCf: pct("0.8"), effectiveLt: pct("0.8"),
    spotPrice: pct("600"), boundedCollateralPrice: pct("600"), boundedDebtPrice: pct("600"),
    mintPaused: false, repayPaused: false, supplyHeadroom: 10n ** 24n,
    walletBalance: 0n, allowance: 0n,
    ...overrides,
  } as VenusMarketReading;
}

function usdtDebt(borrow: bigint): VenusMarketReading {
  return market({
    vToken: V_USDT, vTokenSymbol: "vUSDT", underlying: USDT, native: false,
    collateralMember: false, vTokenBalance: 0n,
    borrowStored: borrow, borrowCurrent: borrow,
    exchangeRateStored: E18, exchangeRateCurrent: E18,
    spotPrice: pct("1"), boundedCollateralPrice: pct("1"), boundedDebtPrice: pct("1"),
  });
}

/**
 * The protocol tuples are COMPUTED from the same fixture, so the R2.2 equality
 * gate passes by construction and a test named "hysteresis" cannot silently be
 * testing `protocol-mismatch`.
 */
function account(
  markets: readonly VenusMarketReading[],
  overrides: Partial<VenusAccountReading> = {},
): VenusAccountReading {
  const inputs = markets.map((entry) => ({
    collateralMember: entry.collateralMember,
    vTokenBalance: entry.vTokenBalance,
    collateralFactor: entry.effectiveCf,
    liquidationThreshold: entry.effectiveLt,
    collateralPrice: entry.boundedCollateralPrice,
    debtPrice: entry.boundedDebtPrice,
    spotPrice: entry.spotPrice,
    exchangeRate: entry.exchangeRateStored,
    borrowBalance: entry.borrowStored,
  }));
  const pair = calculateVenusRisk(inputs, 0n);
  return {
    blockNumber: 120_000_000n,
    blockHash: `0x${"d6".repeat(32)}` as Hex,
    owner: GUARDED,
    protocolPaused: false,
    userPoolId: 0n,
    lastPoolId: 15n,
    vaiDebt: 0n,
    accountLiquidity: [0n, pair.liquidationRisk.liquidity, pair.liquidationRisk.shortfall],
    borrowingPower: [0n, pair.borrowingPower.liquidity, pair.borrowingPower.shortfall],
    markets,
    snapshotErrorMarket: null,
    ...overrides,
  };
}

function reserve(overrides: Partial<LendingReserveReading> = {}): LendingReserveReading {
  return {
    blockNumber: 120_000_000n,
    wallet: WALLET,
    usdtBalance: 500n * E18,
    vUsdtBalance: 0n,
    exchangeRateStored: E18,
    exchangeRateCurrent: E18,
    cash: 10_000_000n * E18,
    nativeBalance: 10n ** 17n,
    usdtAllowanceToVUsdt: 0n,
    usdtAllowanceToRouter: 0n,
    poolSqrtPriceX96: null,
    poolWbnbIsToken0: false,
    ...overrides,
  };
}

/**
 * The two fixtures the hysteresis tests turn on, and the difference matters:
 *
 *   BREACHING  — collateral 844.8, debt 750 ⇒ HF 1.126, below the 1.20 trigger
 *                but liquidity >= 0, so `shortfall == 0` and the guard needs
 *                TWO confirmations one interval apart.
 *   LIQUIDATABLE — debt 1 000 ⇒ shortfall > 0, which is the single-confirmation
 *                carve-out: waiting an interval IS the loss.
 *
 * A test that used the liquidatable fixture to prove "needs two confirmations"
 * would prove the opposite of its own name.
 */
const BREACHING = 750n * E18;
const LIQUIDATABLE = 1_000n * E18;

const SETTINGS_PARAMS = {
  triggerHf: pct("1.2").toString(),
  targetHf: pct("1.5").toString(),
  maxPerAction: [{ token: USDT, maxWei: (1_000n * E18).toString() }],
  minSecondsBetweenActions: 300,
  rescueReserveCount: 6,
};

type Submission = { readonly calls: readonly WalletCall[] };

type Options = {
  readonly markets?: readonly VenusMarketReading[];
  readonly reserve?: Partial<LendingReserveReading>;
  readonly accountOverrides?: Partial<VenusAccountReading>;
  readonly dryRun?: boolean;
  readonly paused?: boolean;
  readonly guardStatus?: "armed" | "held" | "arming" | "retiring";
  /** AUDIT C-H1: a refusal ABOVE the submit. */
  readonly preflightThrows?: boolean;
  readonly hold?: "arm-unknown" | "retire-unknown" | "account-too-complex";
  readonly receiptStatus?: "CONFIRMED" | "PENDING" | "FAILED";
  readonly borrowAfter?: bigint;
  readonly tooComplex?: boolean;
  readonly readAccountThrows?: boolean;
  readonly settings?: Record<string, unknown>;
  readonly armJournalKey?: string | null;
  readonly armBlock?: bigint | null;
  readonly guardUpdatedAgeMs?: number;
};

async function harness(options: Options = {}) {
  let nowMs = NOW;
  const now = (): number => nowMs;
  const agentStore = new MemoryAgentStore(null, now);
  const journal = new MemoryExecutionJournal(now);
  const killswitch = new MemoryKillSwitch(now);
  const settingsStore = new MemoryVenusSettingsStore(now);
  const observations = new MemoryVenusObservationStore();
  const guards = new MemoryLendingGuardStore(now);
  const submissions: Submission[] = [];

  const expiry = Math.floor(NOW / 1000) + 3_600;
  await agentStore.createAgent({
    id: AGENT, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey",
    sessionFacts: {
      // The REAL template, so the grant check the worker performs is the one
      // production performs.
      spec: lendingSessionSpec({
        vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB, routerV3: ROUTER,
        treasury: TREASURY, walletAddress: WALLET,
        keyStoreAddress: getAddress("0x00000000000000000000000000000000000000cc"),
        nativeCaps: [{ limit: 10n ** 21n, period: "day" }],
        usdtDailyCapWei: 10n ** 24n,
        expiresAt: expiry, nowSeconds: Math.floor(NOW / 1000),
      }),
      permissions: { calls: [], spend: [] },
      publicKey: `0x04${"ab".repeat(64)}` as Hex,
      expiry,
      hireSizing: { name: "lending-v1", version: 1, openNativeBudgetWei: "500000000000000000" },
    },
  });
  await agentStore.putAgentSessionKey(OWNER, AGENT, `0x${"7d".repeat(32)}` as Hex);
  if (options.paused === true) await killswitch.pauseAgent(AGENT, OWNER);

  const params = options.settings ?? SETTINGS_PARAMS;
  await settingsStore.put({
    agentId: AGENT, ownerAddress: OWNER, params,
    digest: lendingSettingsDigest(params),
  });

  await guards.putInitialIfAbsentOrSame({
    agentId: AGENT, ownerAddress: OWNER, guardedAccount: GUARDED,
    reserveToken: USDT, debtMarkets: [V_USDT],
    reserveCapWei: 10n ** 24n, reserveBps: 2_000,
  });
  const seeded = (await guards.get(OWNER, AGENT))!;
  const armed = await guards.armCas({
    ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: seeded.rowVersion,
    budgetWei: 5n * 10n ** 17n, reserveBps: 2_000,
    supplyNativeWei: 4n * 10n ** 17n, reserveNativeWei: 10n ** 17n,
    mintUsdtWei: 240n * E18, preArmVUsdtWei: 0n, preArmExchangeRate: E18,
    armJournalKey: options.armJournalKey === undefined
      ? `${AGENT}:lending:${AGENT}:arm:1`
      : options.armJournalKey ?? `${AGENT}:lending:${AGENT}:arm:1`,
  });
  const status = options.guardStatus ?? "armed";
  if (status !== "arming") {
    await guards.finishArm(
      status === "held"
        ? {
            ownerAddress: OWNER, agentId: AGENT,
            expectedRowVersion: armed.kind === "ok" ? armed.record.rowVersion : 0,
            outcome: "held", hold: options.hold ?? "arm-unknown",
          }
        : {
            ownerAddress: OWNER, agentId: AGENT,
            expectedRowVersion: armed.kind === "ok" ? armed.record.rowVersion : 0,
            outcome: "armed",
            armBlock: options.armBlock === undefined ? 119_000_000n : options.armBlock,
            armTxHash: `0x${"ab".repeat(32)}`,
          },
    );
  }

  if (status === "retiring") {
    const armedRow = (await guards.get(OWNER, AGENT))!;
    await guards.beginRetire({
      ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: armedRow.rowVersion,
    });
  }

  const markets = options.markets ?? [market(), usdtDebt(BREACHING)];
  const reading = account(markets, options.accountOverrides ?? {});
  const reserveReading = reserve(options.reserve ?? {});
  let readAccountCalls = 0;

  const readers: LendingChainReaders = {
    async readAccount() {
      readAccountCalls += 1;
      if (options.tooComplex === true) {
        throw new LendingAccountTooComplexError(GUARDED, 99);
      }
      if (options.readAccountThrows === true) throw new Error("transport");
      // The debt changes only AFTER a repay lands, which is what makes the
      // effect read a real check rather than a second copy of the decision.
      if (options.borrowAfter !== undefined && submissions.length > 0) {
        return account([market(), usdtDebt(options.borrowAfter)], options.accountOverrides ?? {});
      }
      return reading;
    },
    async readReserve() { return reserveReading; },
    async readTokenDayMeter() {
      return { kind: "day", limitWei: 10n ** 24n, currentSpentWei: 0n, remainingWei: 10n ** 24n };
    },
    async quote(input) {
      // A flat book: 1 BNB = 600 USDT.
      return input.tokenIn.toLowerCase() === WBNB.toLowerCase()
        ? (input.amountInWei * 600n) / 1n
        : input.amountInWei / 600n;
    },
    async readSwapPool() { return { pool: POOL, liquidity: 10n ** 24n, token0: USDT }; },
    async readS1Facts() {
      return { blockNumber: 120_000_000n, liquidityErrorCode: 0n, borrows: [] };
    },
  };

  const provider = {
    restoreSession: () => ({ sessionId: "session-1" }),
    preflightExecute: async () => {
      if (options.preflightThrows === true) {
        throw new ProviderError("NOT_ALLOWED: the grant moved");
      }
      return undefined;
    },
    async executeViaSession(input: { readonly calls: readonly WalletCall[] }) {
      submissions.push({ calls: input.calls });
      const status_ = options.receiptStatus ?? "CONFIRMED";
      return status_ === "CONFIRMED"
        ? { status: "CONFIRMED", transactionHash: `0x${"ab".repeat(32)}`, callsId: `0x${"cd".repeat(32)}` }
        : status_ === "PENDING"
          ? { status: "PENDING", callsId: `0x${"cd".repeat(32)}` }
          : { status: "FAILED", failureCode: "REVERT", callsId: `0x${"cd".repeat(32)}` };
    },
  } as unknown as WalletProvider;

  const deps: LendingWorkerDeps = {
    agentStore, journal, killswitch, provider, guards, settingsStore, observations,
    readers, venue: VENUE, intervalMs: INTERVAL, maxObservationAgeMs: 3 * INTERVAL,
    agentConcurrency: 4, maxSagaSlippageBps: 100,
    now, dryRun: options.dryRun === true,
  };

  return {
    deps, submissions, guards, observations, journal, agentStore, settingsStore,
    advance(ms: number) { nowMs += ms; },
    nowMs: () => nowMs,
  };
}

/* -------------------------------------------------------------------------- */
/* The cycle                                                                  */
/* -------------------------------------------------------------------------- */

describe("the lending worker cycle", () => {
  it("needs TWO confirmations one interval apart — one `--once` run cannot fire", async () => {
    const h = await harness();
    const first = await runLendingWorkerOnce(h.deps);
    assert.equal(first.outcomes[0]?.action, "hold");
    assert.equal(first.outcomes[0]?.condition, "awaiting-confirmation");
    assert.equal(h.submissions.length, 0, "one cycle cannot produce two observations");
    assert.equal(first.outcomes[0]?.observationPersisted, true);
  });

  it("fires on the SECOND confirmation, one interval later (the durable counter)", async () => {
    const h = await harness({ borrowAfter: 200n * E18 });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    const second = await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 1, "two `--once` runs one interval apart DO confirm");
    assert.equal(second.outcomes[0]?.action, "dispatched");
    assert.equal(second.outcomes[0]?.consecutive, 2);
  });

  it("does NOT fire when the two runs are closer than one interval", async () => {
    const h = await harness();
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL - 1);
    const second = await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 0, "two runs against one lagging node manufacture nothing");
    assert.equal(second.outcomes[0]?.condition, "awaiting-confirmation");
  });

  it("a SHORTFALL fires on ONE confirmation — waiting an interval IS the loss", async () => {
    // Collateral 8e18 vBNB @ 0.22 xr @ 0.8 lt @ $600 = 844.8; debt 1 000 USDT.
    const h = await harness({
      markets: [market(), usdtDebt(LIQUIDATABLE)], borrowAfter: 400n * E18,
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 1);
    assert.equal(report.outcomes[0]?.action, "dispatched");
  });

  it("holds with `hf-above-trigger` and submits nothing when the account is healthy", async () => {
    const h = await harness({ markets: [market(), usdtDebt(100n * E18)] });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.condition, "hf-above-trigger");
    assert.equal(h.submissions.length, 0);
  });

  it("PAUSE STOPS THE GUARD (Phase 4 D4, inherited)", async () => {
    const h = await harness({ paused: true, markets: [market(), usdtDebt(LIQUIDATABLE)] });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "hold");
    assert.equal(report.outcomes[0]?.condition, "killswitch");
    assert.equal(h.submissions.length, 0);
  });
});

describe("the DRY-RUN gate writes nothing on EVERY branch", () => {
  const branches: readonly { readonly name: string; readonly options: Options }[] = [
    { name: "hf-above-trigger", options: { markets: [market(), usdtDebt(100n * E18)] } },
    { name: "awaiting-confirmation", options: {} },
    { name: "the submit branch", options: { markets: [market(), usdtDebt(LIQUIDATABLE)] } },
    { name: "account-too-complex", options: { tooComplex: true } },
    {
      name: "guarded-no-debt",
      options: { markets: [market(), usdtDebt(1n)], accountOverrides: {} },
    },
  ];
  for (const branch of branches) {
    it(`${branch.name}: no submission, no observation, no claim, no snapshot`, async () => {
      const h = await harness({ ...branch.options, dryRun: true });
      const before = await h.guards.get(OWNER, AGENT);
      const report = await runLendingWorkerOnce(h.deps);
      assert.equal(h.submissions.length, 0);
      assert.equal(
        await h.observations.get(OWNER, AGENT, "rescue"),
        null,
        "a rehearsal writes NO observation",
      );
      const after = await h.guards.get(OWNER, AGENT);
      assert.deepEqual(
        { seq: after?.actionSeq, last: after?.lastActionAtMs, version: after?.rowVersion },
        { seq: before?.actionSeq, last: before?.lastActionAtMs, version: before?.rowVersion },
        "a dry-run cycle never claims — the claim moves action_seq and the cooldown stamp",
      );
      assert.equal(await h.guards.getSnapshot(OWNER, AGENT), null);
      assert.equal(report.outcomes[0]?.action, "dry-run");
      assert.match(String(report.outcomes[0]?.reason), /Nothing was (written|executed)/u);
    });
  }
});

describe("R3.4 — the `arming` door", () => {
  it("closes an arm that NEVER submitted, and re-arming then works", async () => {
    const h = await harness({ guardStatus: "arming" });
    h.advance(INTERVAL + 1);
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "converged");
    assert.equal(report.outcomes[0]?.condition, "arm-never-submitted");
    const row = await h.guards.get(OWNER, AGENT);
    assert.equal(row?.status, "closed");
    assert.equal(row?.closeReason, "arm-never-submitted");
    assert.match(String(report.outcomes[0]?.reason), /NOTHING WAS SPENT/u);
    // `closed` is an accepted source for the arm CAS, so re-arming works.
    const reArm = await h.guards.armCas({
      ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: row!.rowVersion,
      budgetWei: 1n, reserveBps: 2_000, supplyNativeWei: 1n, reserveNativeWei: 0n,
      mintUsdtWei: 1n, preArmVUsdtWei: 0n, preArmExchangeRate: 1n, armJournalKey: "k2",
    });
    assert.equal(reArm.kind, "ok");
  });

  it("waits one interval before converging, so a live submission is never closed out", async () => {
    const h = await harness({ guardStatus: "arming" });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "skipped");
    assert.equal((await h.guards.get(OWNER, AGENT))?.status, "arming");
  });

  it("converges a COMMITTED arm to `armed` rather than closing it", async () => {
    const h = await harness({ guardStatus: "arming" });
    const key = `${AGENT}:lending:${AGENT}:arm:1`;
    await h.journal.begin({
      idempotencyKey: key, agentId: AGENT, ownerAddress: OWNER,
      kind: "lending", decisionId: `lending:${AGENT}:arm:1`,
    });
    await h.journal.markCommitted(key, { txHash: `0x${"ee".repeat(32)}` });
    h.advance(INTERVAL + 1);
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "converged");
    const row = await h.guards.get(OWNER, AGENT);
    assert.equal(row?.status, "armed", "a COMMITTED arm landed; closing it would be a lie");
    assert.equal(row?.armTxHash, `0x${"ee".repeat(32)}`);
  });

  it("converges an UNKNOWN arm to held/arm-unknown", async () => {
    const h = await harness({ guardStatus: "arming" });
    const key = `${AGENT}:lending:${AGENT}:arm:1`;
    await h.journal.begin({
      idempotencyKey: key, agentId: AGENT, ownerAddress: OWNER,
      kind: "lending", decisionId: `lending:${AGENT}:arm:1`,
    });
    await h.journal.markUnknown(key, "ambiguous");
    h.advance(INTERVAL + 1);
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.condition, "arm-unknown");
    const row = await h.guards.get(OWNER, AGENT);
    assert.equal(row?.status, "held");
    assert.equal(row?.hold, "arm-unknown");
  });

  it("SKIPS an arm whose journal row is still in flight", async () => {
    const h = await harness({ guardStatus: "arming" });
    const key = `${AGENT}:lending:${AGENT}:arm:1`;
    await h.journal.begin({
      idempotencyKey: key, agentId: AGENT, ownerAddress: OWNER,
      kind: "lending", decisionId: `lending:${AGENT}:arm:1`,
    });
    h.advance(INTERVAL + 1);
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "skipped");
    assert.equal((await h.guards.get(OWNER, AGENT))?.status, "arming");
  });
});

describe("§5.6 — the UNKNOWN matrix", () => {
  it("`arm-unknown` still RESCUES: a repay funded by what B holds cannot make A worse off", async () => {
    const h = await harness({
      guardStatus: "held", hold: "arm-unknown",
      markets: [market(), usdtDebt(LIQUIDATABLE)], borrowAfter: 400n * E18,
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 1, "rescues CONTINUE under arm-unknown");
    assert.equal(report.outcomes[0]?.action, "dispatched");
    const rescues = await h.guards.listRescues(OWNER, AGENT, 10);
    assert.ok(
      rescues[0]?.conditions.includes("arm-unknown"),
      "every rescue row carries the hold, so the owner sees it was sized against an ambiguous reserve",
    );
  });

  it("`retire-unknown` does not stop rescues either", async () => {
    const h = await harness({
      guardStatus: "held", hold: "retire-unknown",
      markets: [market(), usdtDebt(LIQUIDATABLE)],
    });
    await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 1);
  });

  it("a PENDING relay answer holds the row as UNKNOWN and reports it", async () => {
    const h = await harness({
      markets: [market(), usdtDebt(LIQUIDATABLE)], receiptStatus: "PENDING",
      borrowAfter: 400n * E18,
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 1);
    assert.equal(report.outcomes[0]?.action, "hold");
    const rescues = await h.guards.listRescues(OWNER, AGENT, 10);
    assert.ok(rescues[0]?.conditions.includes("unknown-held"));
  });

  it("an ANSWERED FAILED is a ROLLBACK, not an UNKNOWN (R2.14)", async () => {
    const h = await harness({
      markets: [market(), usdtDebt(LIQUIDATABLE)], receiptStatus: "FAILED",
    });
    await runLendingWorkerOnce(h.deps);
    const rows = await h.journal.listUnknownForAgent(AGENT);
    assert.equal(rows.length, 0, "the relay batch is atomic; an answered FAILED spent nothing");
  });
});

describe("effect verification is authoritative over the receipt", () => {
  it("`no-effect` KEEPS the action slot and does not reset the counter", async () => {
    // The debt is unchanged after the repay: the Compound failOpaque pattern.
    const h = await harness({
      markets: [market(), usdtDebt(LIQUIDATABLE)], borrowAfter: 1_000n * E18,
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.effect, "no-effect");
    assert.equal(report.outcomes[0]?.action, "hold");
    assert.equal(report.outcomes[0]?.condition, "no-effect");
    const usage = await h.guards.usageSince(OWNER, AGENT, 0);
    assert.equal(usage.rescues, 1, "the row keeps its slot: the submission drew relay gas");
    const rescues = await h.guards.listRescues(OWNER, AGENT, 10);
    assert.equal(rescues[0]?.effect, "no-effect");
  });

  it("a debt that FELL reads as `changed`", async () => {
    const h = await harness({
      markets: [market(), usdtDebt(LIQUIDATABLE)], borrowAfter: 400n * E18,
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.effect, "changed");
    assert.equal(report.outcomes[0]?.action, "dispatched");
  });
});

describe("R3.11 / R2.13 — disarms the owner did not cause", () => {
  it("`account-too-complex` HOLDS the guard and says why, in R2.13's words", async () => {
    const h = await harness({ tooComplex: true });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "hold");
    assert.equal(report.outcomes[0]?.condition, "account-too-complex");
    assert.match(String(report.outcomes[0]?.reason), /paused until it can/u);
    assert.equal((await h.guards.get(OWNER, AGENT))?.hold, "account-too-complex");
    assert.equal(h.submissions.length, 0);
  });

  it("`oracle-invalid` NAMES the offending market", async () => {
    const h = await harness({
      markets: [market({ spotPrice: 0n, boundedCollateralPrice: 0n, boundedDebtPrice: 0n }), usdtDebt(BREACHING)],
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.condition, "oracle-invalid");
    assert.equal(report.outcomes[0]?.market, V_BNB, "the owner must see WHICH market");
    assert.equal(h.submissions.length, 0);
  });

  it("a per-agent transport failure is REPORTED, never swallowed", async () => {
    const h = await harness({ readAccountThrows: true });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "error");
    assert.equal(report.outcomes[0]?.condition, "transport");
  });
});

describe("§6.2 — the owner recovered the reserve with their passkey", () => {
  it("closes the guard by OBSERVATION, never by a message", async () => {
    const h = await harness({
      reserve: { vUsdtBalance: 0n, usdtBalance: 0n },
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "converged");
    assert.equal(report.outcomes[0]?.condition, "recovered-by-owner");
    const row = await h.guards.get(OWNER, AGENT);
    assert.equal(row?.status, "closed");
    assert.equal(row?.closeReason, "recovered-by-owner");
  });

  it("does NOT fire for a guard whose arm never confirmed", async () => {
    const h = await harness({
      reserve: { vUsdtBalance: 0n, usdtBalance: 0n }, armBlock: null,
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.notEqual(report.outcomes[0]?.condition, "recovered-by-owner");
  });
});

describe("R3.7 — the fence and the claim", () => {
  it("worker vs worker on ONE guard produces ONE submission", async () => {
    const h = await harness({ markets: [market(), usdtDebt(LIQUIDATABLE)] });
    await Promise.all([runLendingWorkerOnce(h.deps), runLendingWorkerOnce(h.deps)]);
    assert.equal(h.submissions.length, 1, "the claim CAS is the enforcement, not a comment");
  });

  it("worker vs RETIRE cannot interleave: the retire's claim blocks the cycle's", async () => {
    const h = await harness({ markets: [market(), usdtDebt(LIQUIDATABLE)] });
    // The retire route claims under the SAME fence key before it submits.
    const claimed = await h.guards.withLendingFence(OWNER, AGENT, (fence) =>
      fence.claim({ nowMs: h.nowMs(), minSecondsBetweenActions: 300 }),
    );
    assert.equal(claimed.kind, "claimed");
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 0, "the worker's own claim is refused by the cooldown");
    assert.equal(report.outcomes[0]?.condition, "cooldown");
  });

  it("the cooldown is a real GAP, not a bucket", async () => {
    const h = await harness({ markets: [market(), usdtDebt(LIQUIDATABLE)] });
    await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 1);
    h.advance(299_000);
    const second = await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 1, "299 s is inside a 300 s floor");
    assert.equal(second.outcomes[0]?.condition, "cooldown");
    h.advance(1_001);
    await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 2);
  });

  it("decision ids never repeat: `n` comes from action_seq", async () => {
    const h = await harness({ markets: [market(), usdtDebt(LIQUIDATABLE)] });
    await runLendingWorkerOnce(h.deps);
    h.advance(300_000);
    await runLendingWorkerOnce(h.deps);
    const row = await h.guards.get(OWNER, AGENT);
    assert.equal(row?.actionSeq, 2);
    assert.equal(h.submissions.length, 2);
  });
});

describe("the snapshot is written LAST and its failure is swallowed", () => {
  it("writes a snapshot on a hold cycle", async () => {
    const h = await harness();
    await runLendingWorkerOnce(h.deps);
    const snapshot = await h.guards.getSnapshot(OWNER, AGENT);
    assert.ok(snapshot !== null);
    assert.equal(snapshot.blockNumber, 120_000_000n);
  });

  it("a failing snapshot write never aborts a cycle that submitted money", async () => {
    const h = await harness({
      markets: [market(), usdtDebt(LIQUIDATABLE)], borrowAfter: 400n * E18,
    });
    const broken = {
      ...h.deps,
      guards: new Proxy(h.deps.guards, {
        get(target, property, receiver): unknown {
          if (property === "putSnapshot") {
            return async () => { throw new Error("snapshot store is down"); };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as LendingWorkerDeps;
    const report = await runLendingWorkerOnce(broken);
    assert.equal(h.submissions.length, 1, "the money work is unaffected");
    assert.equal(report.outcomes.find((o) => o.action === "dispatched")?.snapshotPersisted, false);
  });
});

describe("settings integrity", () => {
  it("SKIPS an agent whose stored digest does not recompute", async () => {
    const h = await harness();
    await h.settingsStore.put({
      agentId: AGENT, ownerAddress: OWNER, params: SETTINGS_PARAMS,
      digest: `0x${"00".repeat(32)}`,
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "skipped");
    assert.equal(report.outcomes[0]?.condition, "settings-absent");
    assert.equal(h.submissions.length, 0);
  });

  it("a settings change INVALIDATES the confirmation counter", async () => {
    const h = await harness();
    await runLendingWorkerOnce(h.deps);
    const changed = { ...SETTINGS_PARAMS, targetHf: pct("1.6").toString() };
    await h.settingsStore.put({
      agentId: AGENT, ownerAddress: OWNER, params: changed,
      digest: lendingSettingsDigest(changed),
    });
    h.advance(INTERVAL);
    const second = await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 0);
    assert.equal(second.outcomes[0]?.condition, "awaiting-confirmation");
  });
});

/** Compile-time proof that the guarded account is an `Address` everywhere. */
function _guardedIsAddress(value: Address): Address { return value; }
void _guardedIsAddress(GUARDED);

/* -------------------------------------------------------------------------- */
/* The audit's fix pass (§F)                                                  */
/* -------------------------------------------------------------------------- */

describe("AUDIT C-H1 — a cycle that submits NOTHING gives its claim back", () => {
  it("a preflight refusal consumes no cooldown, charges no action and records no rescue", async () => {
    const h = await harness({ preflightThrows: true, borrowAfter: 200n * E18 });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    const refused = await runLendingWorkerOnce(h.deps);

    assert.equal(h.submissions.length, 0, "the preflight threw ABOVE the submit");
    assert.equal(refused.outcomes[0]?.action, "hold");
    assert.equal(refused.outcomes[0]?.condition, "transport");

    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(
      row.lastActionAtMs, null,
      "the cooldown stamp is RESTORED: a transient refusal must not starve the real rescue",
    );
    assert.ok(row.actionSeq >= 1, "`n` is never rewound — reusing one is a replay");
    assert.equal(
      (await h.guards.listRescues(OWNER, AGENT, 10)).length, 0,
      "a refusal is not a charged rescue",
    );
    assert.equal(
      (await h.guards.usageSince(OWNER, AGENT, 0)).rescues, 0,
      "and it does not consume a slot of the 24 h count the wallet floor narrows on",
    );
  });

  it("a relay-answered FAILED KEEPS its claim — it reached a relay and drew gas", async () => {
    const h = await harness({ receiptStatus: "FAILED", borrowAfter: 200n * E18 });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);

    assert.equal(h.submissions.length, 1);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.notEqual(row.lastActionAtMs, null, "a real submission consumes the cooldown");
    const rescues = await h.guards.listRescues(OWNER, AGENT, 10);
    assert.equal(rescues.length, 1, "it IS a charged rescue: it burned relay gas");
  });
});

describe("AUDIT C-M3 — a FAILED submission is READ BACK", () => {
  it("reports no-effect, and names `borrow-moved` when A's debt fell below `r`", async () => {
    // `borrowAfter` is BELOW the sized `r`, which is R2.6's own condition: A's
    // debt moved down between the sizing block and inclusion.
    const h = await harness({ receiptStatus: "FAILED", borrowAfter: 1n });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);

    const rescue = (await h.guards.listRescues(OWNER, AGENT, 10))[0];
    assert.equal(rescue?.effect, "no-effect", "an atomic FAILED changed nothing — say so");
    assert.ok(
      rescue?.conditions.includes("borrow-moved"),
      "R2.6's condition was unreachable while a FAILED recorded `unverified` with no post-read",
    );
  });

  it("does NOT name `borrow-moved` when the debt is unchanged", async () => {
    const h = await harness({ receiptStatus: "FAILED" });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);
    const rescue = (await h.guards.listRescues(OWNER, AGENT, 10))[0];
    assert.equal(rescue?.conditions.includes("borrow-moved"), false);
  });
});

describe("AUDIT C-M1 — a hold whose condition no longer applies is CLEARED", () => {
  it("`account-too-complex` clears once A reads inside the bound", async () => {
    const h = await harness({ guardStatus: "held", hold: "account-too-complex" });
    assert.equal((await h.guards.get(OWNER, AGENT))?.status, "held");
    // FIXREVIEW F5: TWO qualifying cycles, one interval apart.
    await runLendingWorkerOnce(h.deps);
    assert.equal(
      (await h.guards.get(OWNER, AGENT))?.status, "held",
      "one clean read is one observation; the clear takes two",
    );
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "armed", "the read SUCCEEDED twice; the hold is stale");
    assert.equal(row.hold, null);
  });

  it("`arm-unknown` clears when the reserve PROVES the arm landed (R2.21)", async () => {
    // `preArmVUsdtWei` is 0 in the harness and the reserve holds vUSDT, which is
    // exactly R2.21's evidence rule.
    const h = await harness({
      guardStatus: "held", hold: "arm-unknown",
      reserve: { vUsdtBalance: 1_000n * E18 },
    });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "armed");
    assert.equal(row.hold, null);
  });

  it("`arm-unknown` does NOT clear while the reserve shows nothing landed", async () => {
    const h = await harness({
      guardStatus: "held", hold: "arm-unknown", reserve: { vUsdtBalance: 0n },
    });
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "held");
    assert.equal(row.hold, "arm-unknown");
  });

  it("`retire-unknown` is NEVER cleared by a reserve read", async () => {
    const h = await harness({
      guardStatus: "held", hold: "retire-unknown",
      reserve: { vUsdtBalance: 1_000n * E18 },
    });
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(
      row.hold, "retire-unknown",
      "nothing in a balance says what an ambiguous retire did",
    );
  });

  it("a REHEARSAL clears nothing", async () => {
    const h = await harness({
      guardStatus: "held", hold: "account-too-complex", dryRun: true,
    });
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "held", "a rehearsal writes NOTHING");
    assert.equal(row.hold, "account-too-complex");
  });
});

describe("AUDIT B-H1 — the worker scans `retiring`", () => {
  it("keeps the view alive and NEVER rescues a retiring guard", async () => {
    const h = await harness({
      guardStatus: "retiring",
      markets: [market(), usdtDebt(LIQUIDATABLE)],
      reserve: { vUsdtBalance: 1_000n * E18 },
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(h.submissions.length, 0, "a retiring guard submits nothing");
    assert.equal(report.outcomes[0]?.condition, "pool-cash-short");
    assert.equal(report.outcomes[0]?.snapshotPersisted, true, "the snapshot stays fresh");
    assert.equal((await h.guards.get(OWNER, AGENT))?.status, "retiring");
  });

  it("converges an EMPTY reserve to `retired` — the exit the status lacked", async () => {
    const h = await harness({
      guardStatus: "retiring",
      reserve: { vUsdtBalance: 0n, usdtBalance: 0n },
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "converged");
    assert.equal((await h.guards.get(OWNER, AGENT))?.status, "retired");
  });

  it("a REHEARSAL converges nothing", async () => {
    const h = await harness({
      guardStatus: "retiring", dryRun: true,
      reserve: { vUsdtBalance: 0n, usdtBalance: 0n },
    });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "dry-run");
    assert.equal((await h.guards.get(OWNER, AGENT))?.status, "retiring");
  });
});

describe("AUDIT A-M4 — a SPENT cap is named for its own token", () => {
  it("a spent USDT meter holds with `usdt-cap-exhausted`, not `reserve-low`", async () => {
    const h = await harness({ borrowAfter: 200n * E18 });
    const readers = h.deps.readers as unknown as {
      readTokenDayMeter: () => Promise<unknown>;
    };
    readers.readTokenDayMeter = async () => ({
      kind: "day", limitWei: 10n ** 24n, currentSpentWei: 10n ** 24n, remainingWei: 0n,
    });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.condition, "usdt-cap-exhausted");
    assert.equal(h.submissions.length, 0);
    assert.match(String(report.outcomes[0]?.reason), /USDT cap/u, "the FIGURES survive");
  });
});

describe("AUDIT C-M4 — the arm-unknown tier subtraction has a PIN", () => {
  /**
   * A balance that is comfortable ONLY if the pending arm's own `msg.value` is
   * not subtracted (R2.21). The mutation the audit ran — deleting
   * `armOutstandingNativeWei` at the fence — survived 35 tests because nothing
   * could tell the two tiers apart.
   */
  const TIGHT = {
    nativeBalance:
      walletNativeFloorWei() + 6n * RELAY_FEE_PER_EXIT_WEI
      + 4n * 10n ** 17n + 10n ** 15n,
    // A little idle USDT so §6.2's recovery observation (vUSDT == 0 AND idle
    // below dust) does not fire on this fixture and close the guard instead.
    usdtBalance: 10n ** 18n,
    vUsdtBalance: 0n,
    cash: 0n,
  };

  it("an OUTSTANDING arm shrinks the tier, so the rescue is a reported partial", async () => {
    const h = await harness({
      guardStatus: "held", hold: "arm-unknown",
      reserve: TIGHT, borrowAfter: 700n * E18,
    });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);
    const rescue = (await h.guards.listRescues(OWNER, AGENT, 10))[0];
    assert.ok(rescue !== undefined, "the guard still rescues while the arm is ambiguous");
    assert.equal(rescue.partial, true);
    assert.ok(
      rescue.conditions.includes("reserve-low"),
      "the tier minus the arm's own msg.value cannot fund the whole repay",
    );
    assert.ok(
      rescue.conditions.includes("arm-unknown"),
      "and the rescue row carries the condition it was taken under (R2.21)",
    );
  });

  it("the SAME balance funds the whole repay once the arm is not outstanding", async () => {
    // Identical reserve, no pending arm: the tier is 0.4 BNB larger, which is
    // exactly the arm's `msg.value` — the quantity the mutation deleted.
    const h = await harness({ reserve: TIGHT, borrowAfter: 700n * E18 });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);
    const rescue = (await h.guards.listRescues(OWNER, AGENT, 10))[0];
    assert.ok(rescue !== undefined);
    assert.equal(
      rescue.conditions.includes("reserve-low"), false,
      "without the subtraction the same wallet funds the repay outright",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* FIXREVIEW F1 — every path back to `armed` records `armBlock`               */
/* -------------------------------------------------------------------------- */

describe("FIXREVIEW F1 — a guard armed by the HOLD CLEAR is still recoverable", () => {
  /**
   * The population AUDIT C-M2 was about, on the narrower set P15 created a path
   * into: an `arm-unknown` guard has `armBlock: null` BY CONSTRUCTION (the arm
   * came back UNKNOWN, so `finishArm`'s `armed` branch — the only writer there
   * was — never ran). Clearing that hold on R2.21's evidence used to leave it
   * null forever, and `detectOwnerRecovery` refuses on exactly that.
   */
  it("clears `arm-unknown` to armed WITH a block, and a later empty reserve closes it", async () => {
    const h = await harness({
      guardStatus: "held", hold: "arm-unknown",
      reserve: { vUsdtBalance: 1_000n * E18 },
    });
    assert.equal(
      (await h.guards.get(OWNER, AGENT))?.armBlock, null,
      "an ambiguous arm never recorded one — that is the whole population",
    );

    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);
    const cleared = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(cleared.status, "armed");
    assert.equal(cleared.hold, null);
    assert.equal(
      cleared.armBlock, 120_000_000n,
      "the block of the SAME reading that proved the arm landed",
    );
    assert.equal(
      cleared.armBlockSource, "post-arm-read",
      "FIXREVIEW F7: a read taken after the arm is never labelled as the arm's own block",
    );

    // The owner then recovers the reserve with their passkey. Without the block
    // above, §6.2's observation is unreachable and the row sits armed forever.
    const readers = h.deps.readers as unknown as {
      readReserve: () => Promise<LendingReserveReading>;
    };
    readers.readReserve = async () => reserve({ vUsdtBalance: 0n, usdtBalance: 0n });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.condition, "recovered-by-owner");
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "closed");
    assert.equal(row.closeReason, "recovered-by-owner");
  });

  it("never overwrites an `armBlock` the arm itself recorded", async () => {
    const h = await harness({ guardStatus: "held", hold: "account-too-complex" });
    // `finishArm` cannot write a block on its `held` branch, so seed it the way
    // a guard that armed cleanly and was later held would carry it.
    const held = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(held.armBlock, null);
    await h.guards.setHold({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: held.rowVersion, hold: "account-too-complex",
      armBlock: 118_000_000n,
      armBlockSource: "receipt",
    });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "armed");
    assert.equal(
      row.armBlockSource, "receipt",
      "and the LABEL is one-way with the figure it describes",
    );
    assert.equal(
      row.armBlock, 118_000_000n,
      "the write is one-way: an older, better answer is never replaced",
    );
  });
});

describe("FIXREVIEW F1 — the arming door's COMMITTED branch records a block", () => {
  /**
   * Mutation M8b (`armBlock = readReserve(...)` -> `= null` at the door)
   * SURVIVED the fix review's whole worker suite. This is its pin, and the door
   * is the population most likely to need it: its owner has already seen one
   * ambiguous arm.
   */
  it("a door-converged arm can still be seen to be recovered by its owner", async () => {
    const h = await harness({ guardStatus: "arming" });
    const key = `${AGENT}:lending:${AGENT}:arm:1`;
    await h.journal.begin({
      idempotencyKey: key, agentId: AGENT, ownerAddress: OWNER,
      kind: "lending", decisionId: `lending:${AGENT}:arm:1`,
    });
    await h.journal.markCommitted(key, { txHash: `0x${"ee".repeat(32)}` });
    h.advance(INTERVAL + 1);
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "armed");
    assert.equal(
      row.armBlock, 120_000_000n,
      "AUDIT C-M2: a null block disarms §6.2 for the guard the door just armed",
    );

    const readers = h.deps.readers as unknown as {
      readReserve: () => Promise<LendingReserveReading>;
    };
    readers.readReserve = async () => reserve({ vUsdtBalance: 0n, usdtBalance: 0n });
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.condition, "recovered-by-owner");
  });
});

/* -------------------------------------------------------------------------- */
/* FIXREVIEW F5 — the hold clear takes two confirmations, one interval apart  */
/* -------------------------------------------------------------------------- */

describe("FIXREVIEW F5 — no flap on the hold clear", () => {
  /**
   * `account-too-complex` was SET when `readAccount` threw and CLEARED the
   * moment it did not, with no confirmation count on either edge — unlike every
   * other durable decision in this plane, which takes two finalized
   * observations one interval apart. A guarded account hovering at the market
   * bound therefore wrote a status change EVERY cycle.
   */
  it("an OSCILLATING account never flips the status", async () => {
    const h = await harness({ guardStatus: "held", hold: "account-too-complex" });
    const readers = h.deps.readers as unknown as {
      readAccount: () => Promise<unknown>;
    };
    const clean = readers.readAccount.bind(readers);
    // 25 markets on every other CYCLE, 24 in between: the exact oscillation the
    // finding names. The flag is driven by the loop rather than by a read
    // counter, so one cycle is one side of the oscillation however many reads
    // it happens to take.
    let overBound = false;
    readers.readAccount = async () => {
      if (overBound) throw new LendingAccountTooComplexError(GUARDED, 25);
      return clean();
    };

    for (let run = 0; run < 6; run += 1) {
      overBound = run % 2 === 1;
      await runLendingWorkerOnce(h.deps);
      h.advance(INTERVAL);
      const row = (await h.guards.get(OWNER, AGENT))!;
      assert.equal(
        row.status, "held",
        `cycle ${run + 1}: an account at the bound must not flicker held/armed`,
      );
      assert.equal(row.hold, "account-too-complex");
    }
  });

  it("two clean reads INSIDE one interval are one observation, and clear nothing", async () => {
    const h = await harness({ guardStatus: "held", hold: "account-too-complex" });
    // The PHASE3.2 rule: two `--once` runs back to back cannot manufacture a
    // confirmation, however many of them there are.
    await runLendingWorkerOnce(h.deps);
    await runLendingWorkerOnce(h.deps);
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "held");
    assert.equal(
      row.holdClearConsecutive, 1,
      "the second and third look inside the same interval neither count nor reset",
    );
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);
    assert.equal((await h.guards.get(OWNER, AGENT))?.status, "armed");
  });

  it("a REHEARSAL records no progress", async () => {
    const h = await harness({
      guardStatus: "held", hold: "account-too-complex", dryRun: true,
    });
    await runLendingWorkerOnce(h.deps);
    h.advance(INTERVAL);
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "held");
    assert.equal(row.holdClearConsecutive, 0, "a rehearsal writes NOTHING, counters included");
  });
});

/* -------------------------------------------------------------------------- */
/* FIXREVIEW F7 — `armBlock` says WHICH block it is                          */
/* -------------------------------------------------------------------------- */

describe("FIXREVIEW F7 — the door prefers the arm's OWN block and labels it", () => {
  const COMMITTED_TX = `0x${"ee".repeat(32)}` as const;

  async function doorHarness(): Promise<Awaited<ReturnType<typeof harness>>> {
    const h = await harness({ guardStatus: "arming" });
    const key = `${AGENT}:lending:${AGENT}:arm:1`;
    await h.journal.begin({
      idempotencyKey: key, agentId: AGENT, ownerAddress: OWNER,
      kind: "lending", decisionId: `lending:${AGENT}:arm:1`,
    });
    await h.journal.markCommitted(key, { txHash: COMMITTED_TX });
    h.advance(INTERVAL + 1);
    return h;
  }

  it("records the RECEIPT's block when the transaction can be read back", async () => {
    const h = await doorHarness();
    const readers = h.deps.readers as unknown as {
      readTransactionBlock?: (txHash: string) => Promise<bigint | null>;
    };
    let asked: string | null = null;
    readers.readTransactionBlock = async (txHash) => {
      asked = txHash;
      return 119_999_991n;
    };
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(asked, COMMITTED_TX, "it asks about the arm's OWN transaction");
    assert.equal(
      row.armBlock, 119_999_991n,
      "the block the arm landed in, not the finalized block of a later read",
    );
    assert.equal(row.armBlockSource, "receipt");
  });

  it("falls back to the post-arm read and SAYS SO when the receipt is unreadable", async () => {
    const h = await doorHarness();
    const readers = h.deps.readers as unknown as {
      readTransactionBlock?: (txHash: string) => Promise<bigint | null>;
    };
    readers.readTransactionBlock = async () => null;
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.armBlock, 120_000_000n, "the finalized block of the reserve read");
    assert.equal(
      row.armBlockSource, "post-arm-read",
      "an unreadable receipt must never be reported as the arm's own block",
    );
  });

  it("a reader with NO receipt method still converges, labelled honestly", async () => {
    const h = await doorHarness();
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "armed");
    assert.equal(row.armBlock, 120_000_000n);
    assert.equal(row.armBlockSource, "post-arm-read");
  });
});

/* -------------------------------------------------------------------------- */
/* FIXREVIEW F3 — `held` + `retire-unknown` has an exit                       */
/* -------------------------------------------------------------------------- */

describe("FIXREVIEW F3 — the `retire-unknown` door", () => {
  const RETIRE_KEY = `${AGENT}:lending:${AGENT}:retire:9`;

  for (const sample of [
    { name: "interest dust", supplied: 1n, idle: 0n, rate: E18, stored: E18, retired: true },
    { name: "exact dust boundary", supplied: E18 / 100n, idle: 0n, rate: E18, stored: E18, retired: false },
    { name: "idle included", supplied: 1n, idle: E18 / 100n, rate: E18, stored: E18, retired: false },
    { name: "missing current rate", supplied: 1n, idle: 0n, rate: null, stored: E18, retired: false },
    { name: "zero current rate", supplied: 1n, idle: 0n, rate: 0n, stored: E18, retired: false },
    { name: "conservative stored rate", supplied: E18 / 100n, idle: 0n, rate: 1n, stored: E18, retired: false },
  ]) {
    it(`UNKNOWN recovery residue: ${sample.name}`, async () => {
      const h = await harness({ guardStatus: "held", hold: "retire-unknown", reserve: {
        vUsdtBalance: sample.supplied, usdtBalance: sample.idle,
        exchangeRateCurrent: sample.rate, exchangeRateStored: sample.stored,
      } });
      await chargeRetire(h);
      await seedRetireRow(h);
      await h.journal.markUnknown(RETIRE_KEY, "ambiguous");
      await runLendingWorkerOnce(h.deps);
      assert.equal((await h.guards.get(OWNER, AGENT))?.status, sample.retired ? "retired" : "held");
      assert.equal((await h.journal.get(RETIRE_KEY))?.state, "UNKNOWN");
      assert.equal(h.submissions.length, 0);
    });
  }

  type Rig = Awaited<ReturnType<typeof harness>>;

  async function chargeRetire(h: Rig): Promise<void> {
    await h.guards.chargeAction({
      ownerAddress: OWNER, agentId: AGENT,
      actionId: RETIRE_KEY, kind: "retire", chargedAtMs: NOW,
    });
  }

  async function seedRetireRow(h: Rig): Promise<void> {
    await h.journal.begin({
      idempotencyKey: RETIRE_KEY, agentId: AGENT, ownerAddress: OWNER,
      kind: "lending", decisionId: `lending:${AGENT}:retire:9`,
    });
  }

  it("a demonstrably EMPTY reserve retires the guard — the honest fallback", async () => {
    // The row stays UNKNOWN: nothing in v1 resolves a lending UNKNOWN, which is
    // exactly why the pair was a dead end.
    const h = await harness({
      guardStatus: "held", hold: "retire-unknown",
      reserve: { vUsdtBalance: 0n, usdtBalance: 0n },
    });
    await chargeRetire(h);
    await seedRetireRow(h);
    await h.journal.markUnknown(RETIRE_KEY, "ambiguous");
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "converged");
    assert.equal(report.outcomes[0]?.condition, "retire-unknown");
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "retired", "the exit the pair did not have");
    assert.equal(row.closeReason, "retired");
    assert.equal(h.submissions.length, 0, "the door submits NOTHING");
  });

  it("a ROLLED_BACK retire row arms the guard again — it spent nothing", async () => {
    const h = await harness({
      guardStatus: "held", hold: "retire-unknown",
      reserve: { vUsdtBalance: 1_000n * E18 },
    });
    await chargeRetire(h);
    await seedRetireRow(h);
    await h.journal.markRolledBack(RETIRE_KEY, "relay FAILED");
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "converged");
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "armed");
    assert.equal(row.hold, null);
    assert.notEqual(row.armBlock, null, "F1's rule holds on this path too");
  });

  it("a COMMITTED retire with residue parks at `retiring`, where the B-H1 door finishes it", async () => {
    const h = await harness({
      guardStatus: "held", hold: "retire-unknown",
      reserve: { vUsdtBalance: 1_000n * E18 },
    });
    await chargeRetire(h);
    await seedRetireRow(h);
    await h.journal.markCommitted(RETIRE_KEY, { txHash: `0x${"ee".repeat(32)}` });
    await runLendingWorkerOnce(h.deps);
    assert.equal((await h.guards.get(OWNER, AGENT))?.status, "retiring");
  });

  it("an UNKNOWN retire over a reserve that still holds vUSDT changes NOTHING", async () => {
    const h = await harness({
      guardStatus: "held", hold: "retire-unknown",
      reserve: { vUsdtBalance: 1_000n * E18 },
    });
    await chargeRetire(h);
    await seedRetireRow(h);
    await h.journal.markUnknown(RETIRE_KEY, "ambiguous");
    await runLendingWorkerOnce(h.deps);
    const row = (await h.guards.get(OWNER, AGENT))!;
    assert.equal(row.status, "held", "no evidence, no disposition");
    assert.equal(row.hold, "retire-unknown");
  });

  it("a REHEARSAL resolves nothing", async () => {
    const h = await harness({
      guardStatus: "held", hold: "retire-unknown", dryRun: true,
      reserve: { vUsdtBalance: 0n, usdtBalance: 0n },
    });
    await chargeRetire(h);
    const report = await runLendingWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.action, "dry-run");
    assert.equal((await h.guards.get(OWNER, AGENT))?.status, "held");
  });
});
