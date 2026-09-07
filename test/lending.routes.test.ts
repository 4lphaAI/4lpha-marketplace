/**
 * The lending HTTP surface — the authz matrix, the perimeter reads, the
 * receipt, and the R2.1 journal shape
 * (MARKETPLACE-LENDING-AGENT §3.2, §4, §6.1, §8.3; R2.1, R2.10, R2.11, R2.18,
 * R3.3, R3.8, R3.9; R2.24).
 *
 * The two properties that carry this phase's registration half — the
 * PHASE4-AUDIT A1 class — are asserted first: WITHOUT `deps.lending` every
 * path is the same 404 an unknown path gets, and WITH it every route answers.
 * "Enabled" and "reachable" must be the same word.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";

import {
  CHAIN_ID,
  NETWORK,
  NOW_SEC,
  OTHER_OWNER_PK,
  call,
  createHarness,
  errorCode,
  ownerAccount,
  signOwnerAction,
  toReadHeader,
  type Harness,
} from "./support/serverHarness.js";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import { lendingSessionSpec } from "../src/ops/policy.js";
import { lendingSettingsDigest } from "../src/http/lendingWire.js";
import { calculateVenusRisk, E18 } from "../src/venus/risk.js";
import { MemoryVenusObservationStore } from "../src/store/venusObservations.js";
import { MemoryVenusSettingsStore } from "../src/store/venusSettings.js";
import { MemoryLendingGuardStore } from "../src/store/lendingGuards.js";
import { parseLendingPreviewSecret } from "../src/lending/preview.js";
import type { LendingChainReaders } from "../src/lending/readers.js";
import type { LendingServerDeps } from "../src/server.js";
import type { VenusAccountReading, VenusMarketReading } from "../src/venus/types.js";
import type { LendingReserveReading } from "../src/lending/types.js";

const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
const ROUTER = getAddress("0x1b81d678ffb9c0263b24a97847620c99d213eb14");
const WBNB = getAddress("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
const QUOTER = getAddress("0xb048bbc1ee6b733fffcfb9e9cef7375518e25997");
const FACTORY = getAddress("0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865");
const POOL = getAddress("0x172fcd41e0913e95784454622d1c3724f546f849");
const TREASURY = getAddress("0x00000000000000000000000000000000000000fe");
const KEY_STORE = getAddress("0x00000000000000000000000000000000000000ff");
const GUARDED = getAddress("0x00000000000000000000000000000000000000a9");
const AGENT = "lending-route-agent";
const PREVIEW_SECRET = "ab".repeat(32);

function pct(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * E18 + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

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

function reading(markets: readonly VenusMarketReading[]): VenusAccountReading {
  const pair = calculateVenusRisk(
    markets.map((entry) => ({
      collateralMember: entry.collateralMember,
      vTokenBalance: entry.vTokenBalance,
      collateralFactor: entry.effectiveCf,
      liquidationThreshold: entry.effectiveLt,
      collateralPrice: entry.boundedCollateralPrice,
      debtPrice: entry.boundedDebtPrice,
      spotPrice: entry.spotPrice,
      exchangeRate: entry.exchangeRateStored,
      borrowBalance: entry.borrowStored,
    })),
    0n,
  );
  return {
    blockNumber: 120_000_000n, blockHash: `0x${"d6".repeat(32)}` as Hex,
    owner: GUARDED, protocolPaused: false, userPoolId: 0n, lastPoolId: 15n, vaiDebt: 0n,
    accountLiquidity: [0n, pair.liquidationRisk.liquidity, pair.liquidationRisk.shortfall],
    borrowingPower: [0n, pair.borrowingPower.liquidity, pair.borrowingPower.shortfall],
    markets, snapshotErrorMarket: null,
  };
}

function reserveReading(overrides: Partial<LendingReserveReading> = {}): LendingReserveReading {
  return {
    blockNumber: 120_000_000n,
    wallet: getAddress("0x00000000000000000000000000000000000000b1"),
    usdtBalance: 100n * E18, vUsdtBalance: 240n * E18,
    exchangeRateStored: E18, exchangeRateCurrent: E18,
    cash: 10_000_000n * E18, nativeBalance: 10n ** 18n,
    usdtAllowanceToVUsdt: 0n, usdtAllowanceToRouter: 0n,
    poolSqrtPriceX96: null, poolWbnbIsToken0: false,
    ...overrides,
  };
}

type DepsOptions = {
  readonly markets?: readonly VenusMarketReading[];
  readonly reserve?: Partial<LendingReserveReading>;
  readonly previewSecret?: string | null;
  readonly throwOnChainReads?: boolean;
};

function lendingDeps(options: DepsOptions = {}): LendingServerDeps {
  const markets = options.markets ?? [market(), usdtDebt(700n * E18)];
  const readers: LendingChainReaders = {
    async readAccount() {
      if (options.throwOnChainReads === true) throw new Error("no chain reads allowed here");
      return reading(markets);
    },
    async readReserve() {
      if (options.throwOnChainReads === true) throw new Error("no chain reads allowed here");
      return reserveReading(options.reserve ?? {});
    },
    async readTokenDayMeter() {
      if (options.throwOnChainReads === true) throw new Error("no chain reads allowed here");
      return { kind: "day", limitWei: 10n ** 24n, currentSpentWei: 0n, remainingWei: 10n ** 24n };
    },
    async quote(input) {
      if (options.throwOnChainReads === true) throw new Error("no chain reads allowed here");
      return input.tokenIn.toLowerCase() === WBNB.toLowerCase()
        ? input.amountInWei * 600n
        : input.amountInWei / 600n;
    },
    async readSwapPool() { return { pool: POOL, liquidity: 10n ** 24n, token0: USDT }; },
    async readS1Facts() {
      if (options.throwOnChainReads === true) throw new Error("no chain reads allowed here");
      return {
        blockNumber: 120_000_000n, liquidityErrorCode: 0n,
        borrows: [{ vToken: V_USDT, borrowWei: 700n * E18 }],
      };
    },
  };
  const secret = options.previewSecret === undefined ? PREVIEW_SECRET : options.previewSecret;
  return {
    guards: new MemoryLendingGuardStore(() => NOW_SEC * 1000),
    settingsStore: new MemoryVenusSettingsStore(() => NOW_SEC * 1000),
    observations: new MemoryVenusObservationStore(),
    readers,
    venue: {
      vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB, routerV3: ROUTER, wbnb: WBNB,
      quoterV2: QUOTER, factoryV3: FACTORY, swapPool: POOL, swapFeeTier: 100,
      treasury: TREASURY,
    },
    intervalMs: 30_000,
    maxObservationAgeMs: 90_000,
    maxSagaSlippageBps: 100,
    previewSecret: secret === null ? null : parseLendingPreviewSecret(secret),
  };
}

const SETTINGS = {
  triggerHf: pct("1.2").toString(),
  targetHf: pct("1.5").toString(),
  maxPerAction: [{ token: USDT, maxWei: (100n * E18).toString() }],
  minSecondsBetweenActions: 300,
  rescueReserveCount: 6,
};

/** An armed lending agent under the harness's default owner. */
async function seedLendingAgent(
  harness: Harness,
  lending: LendingServerDeps,
  guardStatus: "provisioning-guard" | "armed" = "armed",
): Promise<void> {
  const expiry = NOW_SEC + 7 * 24 * 60 * 60;
  const wallet = getAddress("0x00000000000000000000000000000000000000b1");
  await harness.agentStore.createAgent({
    id: AGENT, ownerAddress: ownerAccount.address, walletAddress: wallet,
    custodyModel: "passkey",
    caps: { dailyNativeWei: 10n ** 21n },
    sessionFacts: {
      spec: lendingSessionSpec({
        vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB, routerV3: ROUTER, treasury: TREASURY,
        walletAddress: wallet, keyStoreAddress: KEY_STORE,
        nativeCaps: [{ limit: 10n ** 21n, period: "day" }],
        usdtDailyCapWei: 10n ** 24n, expiresAt: expiry, nowSeconds: NOW_SEC,
      }),
      permissions: { calls: [], spend: [] },
      publicKey: `0x04${"ab".repeat(64)}` as Hex,
      expiry,
      hireSizing: { name: "lending-v1", version: 1, openNativeBudgetWei: "500000000000000000" },
    },
  });
  await harness.agentStore.putAgentSessionKey(
    ownerAccount.address, AGENT, `0x${"7d".repeat(32)}` as Hex,
  );
  await lending.guards.putInitialIfAbsentOrSame({
    agentId: AGENT, ownerAddress: ownerAccount.address, guardedAccount: GUARDED,
    reserveToken: USDT, debtMarkets: [V_USDT],
    reserveCapWei: 10n ** 24n, reserveBps: 2_000,
  });
  await lending.settingsStore.put({
    agentId: AGENT, ownerAddress: ownerAccount.address,
    params: SETTINGS, digest: lendingSettingsDigest(SETTINGS),
  });
  if (guardStatus === "armed") {
    const row = (await lending.guards.get(ownerAccount.address, AGENT))!;
    const armed = await lending.guards.armCas({
      ownerAddress: ownerAccount.address, agentId: AGENT,
      expectedRowVersion: row.rowVersion, budgetWei: 5n * 10n ** 17n, reserveBps: 2_000,
      supplyNativeWei: 4n * 10n ** 17n, reserveNativeWei: 10n ** 17n,
      mintUsdtWei: 240n * E18, preArmVUsdtWei: 0n, preArmExchangeRate: E18,
      armJournalKey: `${AGENT}:lending:${AGENT}:arm:1`,
    });
    await lending.guards.finishArm({
      ownerAddress: ownerAccount.address, agentId: AGENT,
      expectedRowVersion: armed.kind === "ok" ? armed.record.rowVersion : 0,
      outcome: "armed", armBlock: 119_000_000n, armTxHash: `0x${"ab".repeat(32)}`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

describe("registration — enabled and reachable are the same word", () => {
  it("WITHOUT deps.lending, every lending path is 404", async () => {
    const harness = await createHarness();
    for (const probe of [
      { path: "/lending/config", options: {} },
      { path: "/lending/quote?tokenIn=" + USDT + "&tokenOut=" + WBNB + "&amountInWei=1", options: {} },
      { path: "/lending/guardable?account=" + GUARDED, options: {} },
      { path: `/agents/${AGENT}/lending/arm`, options: { method: "POST" as const, body: {} } },
      { path: `/agents/${AGENT}/lending/settings`, options: { method: "POST" as const, body: {} } },
      { path: `/agents/${AGENT}/lending/retire`, options: { method: "POST" as const, body: {} } },
      { path: `/agents/${AGENT}/lending/view`, options: {} },
    ]) {
      const response = await call(harness, probe.path, probe.options);
      assert.equal(response.status, 404, `${probe.path} must answer the unknown-path 404`);
    }
  });

  it("WITH it, the perimeter reads answer", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    const config = await call(harness, "/lending/config");
    assert.equal(config.status, 200);
    const data = config.body["data"] as Record<string, unknown>;
    assert.equal(data["vUsdt"], V_USDT);
    assert.equal(data["usdt"], USDT);
    assert.equal(data["swapFeeTier"], 100);
    assert.equal(data["maxSagaSlippageBps"], 100);
  });
});

/* -------------------------------------------------------------------------- */
/* The perimeter reads                                                        */
/* -------------------------------------------------------------------------- */

describe("GET /lending/quote — the SAME rail the plane uses", () => {
  it("answers a padded floor for the pinned pair", async () => {
    const harness = await createHarness({ lending: lendingDeps() });
    const response = await call(
      harness,
      `/lending/quote?tokenIn=${USDT}&tokenOut=${WBNB}&amountInWei=${600n * E18}`,
    );
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["quotedOutWei"], E18.toString(10));
    assert.equal(BigInt(String(data["minOutWei"])) < E18, true, "the floor is BELOW the quote");
  });

  it("refuses any pair but the pinned one — it is not a general quoting proxy", async () => {
    const harness = await createHarness({ lending: lendingDeps() });
    const response = await call(
      harness, `/lending/quote?tokenIn=${V_USDT}&tokenOut=${WBNB}&amountInWei=1`,
    );
    assert.equal(response.status, 400);
  });

  it("refuses a malformed amount before any read", async () => {
    const harness = await createHarness({ lending: lendingDeps() });
    const response = await call(
      harness, `/lending/quote?tokenIn=${USDT}&tokenOut=${WBNB}&amountInWei=0`,
    );
    assert.equal(response.status, 400);
  });
});

describe("GET /lending/guardable — two modes, metered, and a receipt that binds", () => {
  it("DISPLAY mode answers the position and NO receipt", async () => {
    const harness = await createHarness({ lending: lendingDeps() });
    const response = await call(harness, `/lending/guardable?account=${GUARDED}`);
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["guardable"], true);
    assert.equal(data["previewReceipt"], undefined, "display mode issues no receipt");
    assert.equal(data["sizing"], undefined);
    const debts = data["debts"] as { vToken: Address; supported: boolean }[];
    assert.equal(debts.length, 1);
    assert.equal(debts[0]?.supported, true);
  });

  it("RECEIPT mode requires ALL FOUR sizing inputs together", async () => {
    const harness = await createHarness({ lending: lendingDeps() });
    const partial = await call(
      harness, `/lending/guardable?account=${GUARDED}&budgetWei=${5n * 10n ** 17n}`,
    );
    assert.equal(partial.status, 400);
    assert.match(
      String((partial.body["error"] as Record<string, unknown>)["message"] ?? ""),
      /together/u,
    );
  });

  it("RECEIPT mode issues a receipt with the floors it derived", async () => {
    const harness = await createHarness({ lending: lendingDeps() });
    const response = await call(
      harness,
      `/lending/guardable?account=${GUARDED}&budgetWei=${5n * 10n ** 17n}`
      + `&reserveBps=2000&maxPerActionUsdtWei=${100n * E18}&rescueReserveCount=6`,
    );
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.ok(typeof data["previewReceipt"] === "string");
    const sizing = data["sizing"] as Record<string, unknown>;
    assert.ok(BigInt(String(sizing["reserveCapFloorWei"])) > 0n);
    assert.ok(BigInt(String(sizing["minimumCapDayWei"])) > 0n);
  });

  it("FAIL-CLOSED with no secret: the preview answers, but issues NO receipt", async () => {
    const harness = await createHarness({ lending: lendingDeps({ previewSecret: null }) });
    const response = await call(
      harness,
      `/lending/guardable?account=${GUARDED}&budgetWei=${5n * 10n ** 17n}`
      + `&reserveBps=2000&maxPerActionUsdtWei=${100n * E18}&rescueReserveCount=6`,
    );
    assert.equal(response.status, 200, "the guarded-account stage keeps working");
    assert.equal(
      (response.body["data"] as Record<string, unknown>)["previewReceipt"],
      undefined,
      "and S1 will refuse preview-receipt-unavailable",
    );
  });

  it("refuses an account with NO debt, and names why", async () => {
    const harness = await createHarness({ lending: lendingDeps({ markets: [market()] }) });
    const response = await call(harness, `/lending/guardable?account=${GUARDED}`);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["guardable"], false);
    assert.equal(data["refusal"], "no-debt");
  });

  it("NAMES the market when a zero oracle price makes the account unpriceable", async () => {
    const harness = await createHarness({
      lending: lendingDeps({
        markets: [
          market({ spotPrice: 0n, boundedCollateralPrice: 0n, boundedDebtPrice: 0n }),
          usdtDebt(700n * E18),
        ],
      }),
    });
    const response = await call(harness, `/lending/guardable?account=${GUARDED}`);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["refusal"], "oracle-invalid");
    assert.equal(data["refusalMarket"], V_BNB);
    assert.match(String(data["note"] ?? ""), /paused until it can/u);
  });

  it("is METERED — the eleventh call for one account is refused", async () => {
    const harness = await createHarness({ lending: lendingDeps() });
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push((await call(harness, `/lending/guardable?account=${GUARDED}`)).status);
    }
    assert.ok(statuses.includes(429), "an RPC amplifier behind the perimeter must be bounded");
  });

  it("refuses a malformed account before any read", async () => {
    const harness = await createHarness({ lending: lendingDeps() });
    assert.equal((await call(harness, "/lending/guardable?account=nope")).status, 400);
  });
});

/* -------------------------------------------------------------------------- */
/* The owner mutations                                                        */
/* -------------------------------------------------------------------------- */

describe("the owner-action authz matrix", () => {
  const routes = ["arm", "settings", "retire"] as const;
  const actions = { arm: "lendingArm", settings: "lendingSettings", retire: "lendingRetire" } as const;

  for (const route of routes) {
    it(`${route}: no exec token ⇒ 401 before anything else`, async () => {
      const lending = lendingDeps();
      const harness = await createHarness({ lending });
      await seedLendingAgent(harness, lending);
      const response = await call(harness, `/agents/${AGENT}/lending/${route}`, {
        method: "POST", body: {}, noExecToken: true,
      });
      assert.equal(response.status, 401);
    });

    it(`${route}: an unsigned body ⇒ owner_auth_failed`, async () => {
      const lending = lendingDeps();
      const harness = await createHarness({ lending });
      await seedLendingAgent(harness, lending);
      const response = await call(harness, `/agents/${AGENT}/lending/${route}`, {
        method: "POST", body: { params: {} },
      });
      assert.equal(response.status, 401);
      assert.equal(errorCode(response.body), "owner_auth_failed");
    });

    it(`${route}: ANOTHER owner's signature is a 404, never a 403`, async () => {
      const lending = lendingDeps();
      const harness = await createHarness({ lending });
      await seedLendingAgent(harness, lending);
      const envelope = await signOwnerAction(
        actions[route],
        route === "arm"
          ? { settings: SETTINGS, budgetWei: (10n ** 17n).toString(), reserveBps: 2_000 }
          : route === "settings" ? SETTINGS : {},
        { pk: OTHER_OWNER_PK, agentId: AGENT },
      );
      const response = await call(harness, `/agents/${AGENT}/lending/${route}`, {
        method: "POST", body: envelope,
      });
      assert.equal(response.status, 404, "a wrong owner is indistinguishable from a missing agent");
    });

    it(`${route}: a REPLAYED nonce is refused`, async () => {
      const lending = lendingDeps();
      const harness = await createHarness({ lending });
      await seedLendingAgent(harness, lending);
      const params = route === "arm"
        ? { settings: SETTINGS, budgetWei: (10n ** 17n).toString(), reserveBps: 2_000 }
        : route === "settings" ? SETTINGS : {};
      const envelope = await signOwnerAction(actions[route], params, { agentId: AGENT });
      await call(harness, `/agents/${AGENT}/lending/${route}`, { method: "POST", body: envelope });
      // A DIFFERENT signature carrying the same nonce hashes to a different
      // idempotency key, so it reaches `consume` and is refused there.
      const replay = await signOwnerAction(actions[route], params, {
        agentId: AGENT, nonce: envelope.signed.nonce as `0x${string}`, expiry: NOW_SEC + 121,
      });
      const response = await call(harness, `/agents/${AGENT}/lending/${route}`, {
        method: "POST", body: replay,
      });
      assert.equal(response.status, 401);
    });
  }
});

describe("POST /agents/:id/lending/settings", () => {
  it("replaces the settings and returns the new digest", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const next = { ...SETTINGS, targetHf: pct("1.6").toString() };
    const response = await call(harness, `/agents/${AGENT}/lending/settings`, {
      method: "POST",
      body: await signOwnerAction("lendingSettings", next, { agentId: AGENT }),
    });
    assert.equal(response.status, 200);
    const data = response.body["data"] as Record<string, unknown>;
    assert.equal(data["settingsDigest"], lendingSettingsDigest(next));
    const stored = await lending.settingsStore.get(ownerAccount.address, AGENT);
    assert.equal(stored?.digest, lendingSettingsDigest(next));
  });

  it("409s while a lending money row is UNRESOLVED", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const key = `${AGENT}:lending:${AGENT}:0:1`;
    await harness.journal.begin({
      idempotencyKey: key, agentId: AGENT, ownerAddress: ownerAccount.address,
      kind: "lending", decisionId: `lending:${AGENT}:0:1`,
    });
    await harness.journal.markUnknown(key, "ambiguous");
    const response = await call(harness, `/agents/${AGENT}/lending/settings`, {
      method: "POST",
      body: await signOwnerAction("lendingSettings", SETTINGS, { agentId: AGENT }),
    });
    assert.equal(response.status, 409);
  });

  it("refuses settings whose USDT ceiling exceeds the GRANTED cap, with a remedy", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const tooBig = {
      ...SETTINGS,
      maxPerAction: [{ token: USDT, maxWei: (10n ** 30n).toString() }],
    };
    const response = await call(harness, `/agents/${AGENT}/lending/settings`, {
      method: "POST",
      body: await signOwnerAction("lendingSettings", tooBig, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
    const message = String((response.body["error"] as Record<string, unknown>)["message"] ?? "");
    assert.match(message, /Lower Max repay per event/u, "never a dead end after funding");
  });

  it("refuses a ceiling for a market this guard is not pinned to", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const wrong = {
      ...SETTINGS,
      maxPerAction: [
        { token: USDT, maxWei: (100n * E18).toString() },
        { token: null, maxWei: (10n ** 17n).toString() },
      ],
    };
    const response = await call(harness, `/agents/${AGENT}/lending/settings`, {
      method: "POST",
      body: await signOwnerAction("lendingSettings", wrong, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
  });

  it("refuses a minSecondsBetweenActions below the 300 s floor", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const fast = { ...SETTINGS, minSecondsBetweenActions: 60 };
    const response = await call(harness, `/agents/${AGENT}/lending/settings`, {
      method: "POST",
      body: await signOwnerAction("lendingSettings", fast, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
  });
});

describe("POST /agents/:id/lending/arm", () => {
  it("refuses a second arm on an already-armed guard", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: (10n ** 17n).toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"] ?? ""),
      /second arm is a second swap/u,
    );
  });

  it("refuses a budget above the one the hire was sized and funded for", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: (10n ** 19n).toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"] ?? ""),
      /exceeds the budget this hire was sized/u,
    );
  });

  it("refuses a reserveBps outside 1000..5000 at the parser", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: (10n ** 17n).toString(), reserveBps: 9_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
  });

  it("refuses a guarded account with no debt in any pinned market", async () => {
    const lending = lendingDeps({ markets: [market()] });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: (5n * 10n ** 17n).toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"] ?? ""),
      /no debt in any pinned market/u,
    );
  });

  it("R2.1 — an UNKNOWN arm answers `held` with an UNKNOWN `lending` row beside a COMMITTED `lendingArm`", async () => {
    const lending = lendingDeps({
      reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n },
    });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    harness.provider.nextReceipt = { status: "PENDING", callsId: `0x${"cd".repeat(32)}` };
    const envelope = await signOwnerAction("lendingArm", {
      settings: SETTINGS, budgetWei: (5n * 10n ** 17n).toString(), reserveBps: 2_000,
    }, { agentId: AGENT });
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST", body: envelope,
    });
    assert.equal(response.status, 200);
    const arm = (response.body["data"] as Record<string, unknown>)["arm"] as Record<string, unknown>;
    assert.equal(arm["status"], "held", "§4.1's `held` outcome is REACHABLE");

    const unknownRows = await harness.journal.listUnknownForAgent(AGENT);
    assert.equal(unknownRows.length, 1, "the MONEY row is the UNKNOWN one");
    assert.equal(unknownRows[0]?.kind, "lending");

    // `ownerMutation` echoes the key it journaled the OWNER-ACTION row under —
    // the server's own derivation, which is the one that matters here.
    const ownerKey = String(
      (response.body["data"] as Record<string, unknown>)["idempotencyKey"],
    );
    const ownerRow = await harness.journal.get(ownerKey);
    assert.equal(ownerRow?.kind, "lendingArm");
    assert.equal(
      ownerRow?.state, "COMMITTED",
      "the LOCAL-ONLY owner-action row commits; only the money row is ambiguous",
    );
    const guard = await lending.guards.get(ownerAccount.address, AGENT);
    assert.equal(guard?.status, "held");
    assert.equal(guard?.hold, "arm-unknown");
  });
});

describe("POST /agents/:id/lending/retire", () => {
  it("refuses a POOL-SHORT retire without an explicit acceptPartial", async () => {
    const lending = lendingDeps({
      reserve: { usdtBalance: 1n * E18, vUsdtBalance: 240n * E18, cash: 5n * E18 },
    });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const response = await call(harness, `/agents/${AGENT}/lending/retire`, {
      method: "POST",
      body: await signOwnerAction("lendingRetire", {}, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
    const message = String((response.body["error"] as Record<string, unknown>)["message"] ?? "");
    assert.match(message, /pool-cash-short/u);
    assert.match(message, /recoverable with your passkey/u);
  });

  it("SUBMITS the bounded partial when the owner accepts it (R3.12)", async () => {
    const lending = lendingDeps({
      reserve: { usdtBalance: 1n * E18, vUsdtBalance: 240n * E18, cash: 5n * E18 },
    });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const response = await call(harness, `/agents/${AGENT}/lending/retire`, {
      method: "POST",
      body: await signOwnerAction("lendingRetire", { acceptPartial: true }, { agentId: AGENT }),
    });
    assert.equal(response.status, 200);
    const retire = (response.body["data"] as Record<string, unknown>)["retire"] as Record<string, unknown>;
    assert.equal(retire["poolShort"], true);
    assert.ok(BigInt(String(retire["remainderUsdtWei"])) > 0n, "the remainder is DISCLOSED");
    assert.equal(harness.provider.executeCalls.length, 1);
    const guard = await lending.guards.get(ownerAccount.address, AGENT);
    assert.equal(guard?.status, "retiring", "HTTP 200 is NOT `retired`");
  });

  it("refuses when there is nothing to retire", async () => {
    const lending = lendingDeps({
      reserve: { usdtBalance: 0n, vUsdtBalance: 0n, cash: 0n },
    });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const response = await call(harness, `/agents/${AGENT}/lending/retire`, {
      method: "POST",
      body: await signOwnerAction("lendingRetire", {}, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
  });

  it("refuses while the guard is still `provisioning-guard`", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const response = await call(harness, `/agents/${AGENT}/lending/retire`, {
      method: "POST",
      body: await signOwnerAction("lendingRetire", {}, { agentId: AGENT }),
    });
    assert.equal(response.status, 409);
  });
});

/* -------------------------------------------------------------------------- */
/* The owner view                                                             */
/* -------------------------------------------------------------------------- */

describe("GET /agents/:id/lending/view", () => {
  async function readable(options: DepsOptions = {}) {
    const lending = lendingDeps(options);
    const harness = await createHarness({
      lending,
      config: {
        accountReadSession: {
          key: parseAccountReadSessionSecret("cd".repeat(32))!,
          chainId: CHAIN_ID,
          environment: resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK }),
        },
      },
    });
    await seedLendingAgent(harness, lending);
    return { harness, lending };
  }

  it("makes ZERO chain reads — a throwing reader stub still answers", async () => {
    const { harness } = await readable({ throwOnChainReads: true });
    const response = await call(harness, `/agents/${AGENT}/lending/view`, {
      headers: { "x-owner-action": toReadHeader(
        await signOwnerAction("read", {}, { agentId: AGENT }),
      ) },
    });
    assert.equal(response.status, 200, "the view serves the worker's snapshot, never the chain");
  });

  it("reports a MISSING snapshot as stale WITH ITS REASON — never a guess", async () => {
    const { harness } = await readable();
    const response = await call(harness, `/agents/${AGENT}/lending/view`, {
      headers: { "x-owner-action": toReadHeader(
        await signOwnerAction("read", {}, { agentId: AGENT }),
      ) },
    });
    const snapshot = (response.body["data"] as Record<string, unknown>)["snapshot"] as Record<string, unknown>;
    assert.equal(snapshot["stale"], true);
    assert.equal(snapshot["payload"], null);
    assert.match(String(snapshot["reason"]), /has not reported/u);
    assert.equal(snapshot["staleAfterMs"], 60_000, "2 x the worker interval");
  });

  it("serves a FRESH snapshot's payload", async () => {
    const { harness, lending } = await readable();
    await lending.guards.putSnapshot({
      agentId: AGENT, ownerAddress: ownerAccount.address,
      blockNumber: 120_000_000n, observedAtMs: NOW_SEC * 1000, snapshot: { version: 1, ok: true },
    });
    const response = await call(harness, `/agents/${AGENT}/lending/view`, {
      headers: { "x-owner-action": toReadHeader(
        await signOwnerAction("read", {}, { agentId: AGENT }),
      ) },
    });
    const snapshot = (response.body["data"] as Record<string, unknown>)["snapshot"] as Record<string, unknown>;
    assert.equal(snapshot["stale"], false);
    assert.deepEqual(snapshot["payload"], { version: 1, ok: true });
  });

  it("accepts the account-read BEARER and refuses both credentials at once", async () => {
    const { harness } = await readable();
    const issued = await call(harness, "/owner-read-session", {
      method: "POST",
      body: await signOwnerAction("createAccountReadSession", {}, { agentId: "*" }),
    });
    const token = (issued.body["data"] as { token: string }).token;
    const bearer = await call(harness, `/agents/${AGENT}/lending/view`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(bearer.status, 200, "the sixth GET on the allowlist");

    const both = await call(harness, `/agents/${AGENT}/lending/view`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-owner-action": toReadHeader(await signOwnerAction("read", {}, { agentId: AGENT })),
      },
    });
    assert.equal(both.status, 401, "header XOR bearer");
  });

  it("answers 404 for another owner's agent", async () => {
    const { harness } = await readable();
    const response = await call(harness, `/agents/${AGENT}/lending/view`, {
      headers: { "x-owner-action": toReadHeader(
        await signOwnerAction("read", {}, { agentId: AGENT, pk: OTHER_OWNER_PK }),
      ) },
    });
    assert.equal(response.status, 404);
  });

  it("never echoes a session key", async () => {
    const { harness } = await readable();
    const response = await call(harness, `/agents/${AGENT}/lending/view`, {
      headers: { "x-owner-action": toReadHeader(
        await signOwnerAction("read", {}, { agentId: AGENT }),
      ) },
    });
    assert.ok(!response.text.includes("7d".repeat(32)));
  });
});

/* -------------------------------------------------------------------------- */
/* The audit's fix pass (§F) — the owner routes                               */
/* -------------------------------------------------------------------------- */

describe("AUDIT B-H1 — `retiring` is not a dead end", () => {
  it("a retire REFUSED BEFORE THE SUBMIT restores the status it interrupted", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    // A preflight refusal: nothing reached a relay, so nothing was spent.
    harness.provider.preflightError = new Error("NOT_ALLOWED");
    const response = await call(harness, `/agents/${AGENT}/lending/retire`, {
      method: "POST",
      body: await signOwnerAction("lendingRetire", {}, { agentId: AGENT }),
    });
    assert.equal(response.status, 200, "the outcome block is what says what happened");
    const retire = (response.body["data"] as Record<string, unknown>)["retire"] as Record<string, unknown>;
    assert.equal(retire["status"], "rolled-back");
    assert.equal(harness.provider.executeCalls.length, 0, "nothing was submitted");

    const guard = await lending.guards.get(ownerAccount.address, AGENT);
    assert.equal(
      guard?.status, "armed",
      "a retire that spent NOTHING must not park the guard in a status no surface accepted",
    );
    assert.equal(guard?.lastActionAtMs, null, "and it gives its cooldown claim back");
  });

  it("the retire gate ACCEPTS `retiring`, so a pool-short partial can be retried", async () => {
    const lending = lendingDeps({
      reserve: { usdtBalance: 1n * E18, vUsdtBalance: 240n * E18, cash: 5n * E18 },
    });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const partial = await call(harness, `/agents/${AGENT}/lending/retire`, {
      method: "POST",
      body: await signOwnerAction("lendingRetire", { acceptPartial: true }, { agentId: AGENT }),
    });
    assert.equal(partial.status, 200);
    assert.equal((await lending.guards.get(ownerAccount.address, AGENT))?.status, "retiring");

    // "Retire again when the pool refills" is the refusal's own remedy, and it
    // used to be refused by the gate: `retiring` was a destination with no door.
    const again = await call(harness, `/agents/${AGENT}/lending/retire`, {
      method: "POST",
      body: await signOwnerAction("lendingRetire", { acceptPartial: true }, { agentId: AGENT }),
    });
    // The gate ACCEPTS `retiring` — the only thing that can still refuse the
    // retry is the owner's own `minSecondsBetweenActions` floor, which the
    // retire now claims under (AUDIT B-M1). That is a wait with a remedy, not a
    // status nothing accepts, and the refusal says which one it is.
    const message = String(
      (again.body["error"] as Record<string, unknown> | undefined)?.["message"] ?? "",
    );
    assert.ok(
      again.status === 200 || /cooldown/u.test(message),
      `a retiring guard must have an owner door; got ${again.status} ${message}`,
    );
    assert.doesNotMatch(
      message, /needs an armed/u,
      "the gate must not refuse `retiring` on the status itself",
    );
  });
});

describe("AUDIT B-M1 — the retire takes the R3.7 claim", () => {
  it("stamps the cooldown, so a worker rescue cannot follow it inside the floor", async () => {
    const lending = lendingDeps();
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending);
    const before = await lending.guards.get(ownerAccount.address, AGENT);
    assert.equal(before?.lastActionAtMs, null);

    const response = await call(harness, `/agents/${AGENT}/lending/retire`, {
      method: "POST",
      body: await signOwnerAction("lendingRetire", {}, { agentId: AGENT }),
    });
    assert.equal(response.status, 200);
    const after = (await lending.guards.get(ownerAccount.address, AGENT))!;
    assert.notEqual(after.lastActionAtMs, null, "the retire CLAIMED");
    assert.equal(after.actionSeq, 1);

    // The worker's own claim, at the same instant, is now refused by the floor
    // the owner signed — which is the mutual exclusion the fence alone could
    // not provide, because the fence ends before either submission does.
    const claim = await lending.guards.claimAction({
      ownerAddress: ownerAccount.address, agentId: AGENT,
      nowMs: after.lastActionAtMs ?? 0, minSecondsBetweenActions: 300,
    });
    assert.equal(claim.kind, "cooldown");
  });
});

describe("AUDIT B-H2 — the arm's decision id cannot be reused", () => {
  it("records `armBlock` on a confirmed arm, so owner recovery is detectable", async () => {
    const lending = lendingDeps({
      reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n },
    });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: (5n * 10n ** 17n).toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 200);
    const guard = await lending.guards.get(ownerAccount.address, AGENT);
    assert.notEqual(
      guard?.armBlock, null,
      "AUDIT C-M2: a null armBlock makes §6.2's recovery observation unreachable",
    );
  });

  it("keys the journal row on the row version the CAS consumed, not the pre-fence read", async () => {
    const lending = lendingDeps({
      reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n },
    });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const pre = (await lending.guards.get(ownerAccount.address, AGENT))!;
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: (5n * 10n ** 17n).toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 200);
    const guard = (await lending.guards.get(ownerAccount.address, AGENT))!;
    // The key is derived INSIDE the fence from the version the CAS asserted,
    // which is unique per admission by construction.
    assert.equal(guard.armJournalKey, `${AGENT}:lending:${AGENT}:arm:${pre.rowVersion}`);
    const row = await harness.journal.get(guard.armJournalKey ?? "");
    assert.equal(row?.kind, "lending");
  });
});

describe("AUDIT B-M2 — a refused arm does not move the stored settings digest", () => {
  it("writes `lending_settings` INSIDE the fence, after the idle gate", async () => {
    const lending = lendingDeps({
      reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n },
    });
    const harness = await createHarness({ lending });
    // ARMED already: the arm's idle gate refuses, and the settings must not move.
    await seedLendingAgent(harness, lending);
    const before = await lending.settingsStore.get(ownerAccount.address, AGENT);
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: { ...SETTINGS, targetHf: (16n * 10n ** 17n).toString() },
        budgetWei: (5n * 10n ** 17n).toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
    const after = await lending.settingsStore.get(ownerAccount.address, AGENT);
    assert.equal(after?.digest, before?.digest, "a refused arm changed nothing");
  });
});

/* -------------------------------------------------------------------------- */
/* AUDIT P19 / G-M1 — the arm must carry the settings the owner signed         */
/* -------------------------------------------------------------------------- */

describe("AUDIT P19 — the arm is a continuation of the S1 signature", () => {
  const HIRE_BUDGET_WEI = 5n * 10n ** 17n;

  it("arms with the settings signed at hire", async () => {
    const lending = lendingDeps({ reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n } });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: HIRE_BUDGET_WEI.toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 200);
    const guard = await lending.guards.get(ownerAccount.address, AGENT);
    assert.equal(guard?.status, "armed");
  });

  it("refuses DEFAULT settings after a reload — a different digest is a different admission", async () => {
    const lending = lendingDeps({ reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n } });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const before = await lending.settingsStore.get(ownerAccount.address, AGENT);
    // The form rebuilt from defaults: a valid settings object the owner never
    // signed for THIS hire.
    const reloaded = { ...SETTINGS, triggerHf: pct("1.05").toString(), targetHf: pct("1.3").toString() };
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: reloaded, budgetWei: HIRE_BUDGET_WEI.toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 400);
    assert.equal(errorCode(response.body), "invalid_request");
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"] ?? ""),
      /^settings-digest-mismatch/u,
    );
    assert.match(
      String((response.body["error"] as Record<string, unknown>)["message"] ?? ""),
      /sign lendingSettings first, or arm with the settings you signed at hire/u,
    );
    assert.equal(harness.provider.executeCalls.length, 0, "NOTHING was submitted");
    const after = await lending.settingsStore.get(ownerAccount.address, AGENT);
    assert.equal(after?.digest, before?.digest, "the stored digest did not move");
    const guard = await lending.guards.get(ownerAccount.address, AGENT);
    assert.equal(guard?.status, "provisioning-guard");
    assert.equal(guard?.budgetWei, 0n);
  });

  it("arms with the NEW settings after an owner-signed lendingSettings update", async () => {
    const lending = lendingDeps({ reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n } });
    const harness = await createHarness({ lending });
    // ARMED first: `lendingSettings` is only reachable on an armed or held
    // guard, so the post-convergence update path is arm -> settings -> close.
    await seedLendingAgent(harness, lending);
    const next = { ...SETTINGS, targetHf: pct("1.7").toString() };
    const updated = await call(harness, `/agents/${AGENT}/lending/settings`, {
      method: "POST",
      body: await signOwnerAction("lendingSettings", next, { agentId: AGENT }),
    });
    assert.equal(updated.status, 200);
    const armed = (await lending.guards.get(ownerAccount.address, AGENT))!;
    await lending.guards.close({
      ownerAddress: ownerAccount.address, agentId: AGENT,
      expectedRowVersion: armed.rowVersion, closeReason: "recovered-by-owner",
    });

    // The settings signed at HIRE are no longer admissible: the CURRENT digest
    // is the authority, not a union that grows with every update.
    const stale = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: HIRE_BUDGET_WEI.toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(stale.status, 400);
    assert.match(
      String((stale.body["error"] as Record<string, unknown>)["message"] ?? ""),
      /^settings-digest-mismatch/u,
    );

    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: next, budgetWei: HIRE_BUDGET_WEI.toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 200);
    const guard = await lending.guards.get(ownerAccount.address, AGENT);
    assert.equal(guard?.status, "armed");
  });

  it("refuses a budget BELOW the hire budget and a reserveBps the hire was not sized for", async () => {
    for (const probe of [
      {
        params: { settings: SETTINGS, budgetWei: (10n ** 17n).toString(), reserveBps: 2_000 },
        pattern: /^hire-budget-mismatch/u,
      },
      {
        params: { settings: SETTINGS, budgetWei: HIRE_BUDGET_WEI.toString(), reserveBps: 3_000 },
        pattern: /^reserve-bps-mismatch/u,
      },
    ]) {
      const lending = lendingDeps({ reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n } });
      const harness = await createHarness({ lending });
      await seedLendingAgent(harness, lending, "provisioning-guard");
      const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
        method: "POST",
        body: await signOwnerAction("lendingArm", probe.params, { agentId: AGENT }),
      });
      assert.equal(response.status, 400);
      assert.equal(errorCode(response.body), "invalid_request");
      assert.match(
        String((response.body["error"] as Record<string, unknown>)["message"] ?? ""),
        probe.pattern,
      );
      assert.equal(harness.provider.executeCalls.length, 0, "NOTHING was submitted");
      const guard = await lending.guards.get(ownerAccount.address, AGENT);
      assert.equal(guard?.status, "provisioning-guard");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* FIXREVIEW F2 — settings are reachable BEFORE the first arm                  */
/* -------------------------------------------------------------------------- */

describe("FIXREVIEW F2 — `lendingSettings` before the guard has ever armed", () => {
  const HIRE_BUDGET_WEI = 5n * 10n ** 17n;

  /**
   * P19's refusal tells the owner to "sign lendingSettings first". That route
   * refused anything but `armed | held`, and a guard that has never armed is
   * `provisioning-guard` — so the remedy named a door that answered 409, the
   * admissible-digest set was frozen at the hire's, and an owner who could not
   * reproduce the S1 bytes byte-for-byte could not arm at all.
   */
  it("D1 at hire, D2 signed while `provisioning-guard`, then the arm takes D2 and refuses D1", async () => {
    const lending = lendingDeps({ reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n } });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const d1 = lendingSettingsDigest(SETTINGS);
    assert.equal(
      (await lending.settingsStore.get(ownerAccount.address, AGENT))?.digest, d1,
      "the hire's settings are what convergence materialized",
    );

    // The owner changes their mind before arming. This is the whole finding.
    const next = { ...SETTINGS, targetHf: pct("1.7").toString() };
    const d2 = lendingSettingsDigest(next);
    const updated = await call(harness, `/agents/${AGENT}/lending/settings`, {
      method: "POST",
      body: await signOwnerAction("lendingSettings", next, { agentId: AGENT }),
    });
    assert.equal(updated.status, 200, "the remedy P19 names must be reachable here");
    assert.equal(
      (await lending.guards.get(ownerAccount.address, AGENT))?.status,
      "provisioning-guard",
      "a settings write has NO money effect and moves no status",
    );
    assert.equal(harness.provider.executeCalls.length, 0);

    const armed = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: next, budgetWei: HIRE_BUDGET_WEI.toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(armed.status, 200);
    assert.equal((await lending.guards.get(ownerAccount.address, AGENT))?.status, "armed");
    assert.notEqual(d1, d2);

    // And the superseded hire digest is no longer admissible: the CURRENT
    // stored digest is the authority, not a union that grows with every update.
    const row = (await lending.guards.get(ownerAccount.address, AGENT))!;
    await lending.guards.close({
      ownerAddress: ownerAccount.address, agentId: AGENT,
      expectedRowVersion: row.rowVersion, closeReason: "recovered-by-owner",
    });
    const stale = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: HIRE_BUDGET_WEI.toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(stale.status, 400);
    assert.match(
      String((stale.body["error"] as Record<string, unknown>)["message"] ?? ""),
      /^settings-digest-mismatch/u,
    );
  });

  it("is reachable on a CLOSED guard too — the re-arm path", async () => {
    const lending = lendingDeps({ reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n } });
    const harness = await createHarness({ lending });
    await seedLendingAgent(harness, lending, "provisioning-guard");
    const row = (await lending.guards.get(ownerAccount.address, AGENT))!;
    await lending.guards.close({
      ownerAddress: ownerAccount.address, agentId: AGENT,
      expectedRowVersion: row.rowVersion, closeReason: "arm-never-submitted",
    });
    const response = await call(harness, `/agents/${AGENT}/lending/settings`, {
      method: "POST",
      body: await signOwnerAction("lendingSettings", {
        ...SETTINGS, targetHf: pct("1.6").toString(),
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 200);
  });

  it("still refuses `arming` and `retiring` — a submission is in flight against the digest", async () => {
    for (const probe of ["arming", "retiring"] as const) {
      const lending = lendingDeps({ reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n } });
      const harness = await createHarness({ lending });
      await seedLendingAgent(harness, lending, probe === "arming" ? "provisioning-guard" : "armed");
      if (probe === "arming") {
        const row = (await lending.guards.get(ownerAccount.address, AGENT))!;
        await lending.guards.armCas({
          ownerAddress: ownerAccount.address, agentId: AGENT,
          expectedRowVersion: row.rowVersion, budgetWei: HIRE_BUDGET_WEI, reserveBps: 2_000,
          supplyNativeWei: 4n * 10n ** 17n, reserveNativeWei: 10n ** 17n,
          mintUsdtWei: 240n * E18, preArmVUsdtWei: 0n, preArmExchangeRate: E18,
          armJournalKey: `${AGENT}:lending:${AGENT}:arm:1`,
        });
      } else {
        const row = (await lending.guards.get(ownerAccount.address, AGENT))!;
        await lending.guards.beginRetire({
          ownerAddress: ownerAccount.address, agentId: AGENT,
          expectedRowVersion: row.rowVersion,
        });
      }
      const response = await call(harness, `/agents/${AGENT}/lending/settings`, {
        method: "POST",
        body: await signOwnerAction("lendingSettings", {
          ...SETTINGS, targetHf: pct("1.6").toString(),
        }, { agentId: AGENT }),
      });
      assert.equal(response.status, 409, `${probe} must stay refused`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* FIXREVIEW — the two mutations the fix review's arm tests did not kill       */
/* -------------------------------------------------------------------------- */

describe("FIXREVIEW pin — two arms whose PRE-FENCE row version collides", () => {
  const HIRE_BUDGET_WEI = 5n * 10n ** 17n;

  /**
   * Wrap the guard store so that ONE competing admission lands between this
   * request's pre-fence read and its fence body. That is the B-H2 race made
   * deterministic: the route read `rowVersion: 1` outside the fence and the
   * fence finds something else, which is the only condition under which the
   * decision id's keying can be observed at all.
   */
  function racing(
    lending: LendingServerDeps,
    competitor: () => Promise<void>,
  ): LendingServerDeps {
    const base = lending.guards;
    let raced = false;
    const guards = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "withLendingFence") {
          return async (
            owner: Address,
            agentId: string,
            work: (fence: unknown) => Promise<unknown>,
          ) => {
            if (!raced) {
              raced = true;
              await competitor();
            }
            return target.withLendingFence(owner, agentId, work as never);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ...lending, guards };
  }

  it("the SECOND arm refuses BEFORE any execute call when the first is still `arming`", async () => {
    const base = lendingDeps({ reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n } });
    const harness = await createHarness({
      lending: racing(base, async () => {
        // The competitor admits and stays `arming` — its submission is in
        // flight. Our request's pre-fence read said `provisioning-guard`.
        const row = (await base.guards.get(ownerAccount.address, AGENT))!;
        await base.guards.armCas({
          ownerAddress: ownerAccount.address, agentId: AGENT,
          expectedRowVersion: row.rowVersion, budgetWei: HIRE_BUDGET_WEI, reserveBps: 2_000,
          supplyNativeWei: 4n * 10n ** 17n, reserveNativeWei: 10n ** 17n,
          mintUsdtWei: 240n * E18, preArmVUsdtWei: 0n, preArmExchangeRate: E18,
          armJournalKey: `${AGENT}:lending:${AGENT}:arm:1`,
        });
      }),
    });
    await seedLendingAgent(harness, base, "provisioning-guard");
    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: HIRE_BUDGET_WEI.toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 409);
    assert.equal(
      harness.provider.executeCalls.length, 0,
      "the fence's own status gate refuses ABOVE the submit, so nothing is spent",
    );
    assert.equal((await base.guards.get(ownerAccount.address, AGENT))?.status, "arming");
  });

  it("keys the journal row on the FENCE's row version, so a rolled-back sibling is not reused", async () => {
    // Mutation M3b — `fresh.rowVersion` -> the pre-fence `guard.rowVersion` —
    // SURVIVED the fix review's whole route suite. Here the two numbers DIFFER:
    // a competing arm admitted at version 1, rolled back, and left the row
    // `closed` at version 3 with a ROLLED_BACK journal row at `…:arm:1`.
    // Keyed on the pre-fence read, this arm reuses that row and
    // `submitLendingBatch` refuses above the submit — the guard closes as
    // "NOTHING WAS SPENT" while a re-arm is free to mint a second budget.
    const base = lendingDeps({ reserve: { nativeBalance: 10n ** 18n, vUsdtBalance: 0n } });
    let harnessRef: Harness | null = null;
    const harness = await createHarness({
      lending: racing(base, async () => {
        const row = (await base.guards.get(ownerAccount.address, AGENT))!;
        const admitted = await base.guards.armCas({
          ownerAddress: ownerAccount.address, agentId: AGENT,
          expectedRowVersion: row.rowVersion, budgetWei: HIRE_BUDGET_WEI, reserveBps: 2_000,
          supplyNativeWei: 4n * 10n ** 17n, reserveNativeWei: 10n ** 17n,
          mintUsdtWei: 240n * E18, preArmVUsdtWei: 0n, preArmExchangeRate: E18,
          armJournalKey: `${AGENT}:lending:${AGENT}:arm:1`,
        });
        const key = `${AGENT}:lending:${AGENT}:arm:1`;
        await harnessRef!.journal.begin({
          idempotencyKey: key, agentId: AGENT, ownerAddress: ownerAccount.address,
          kind: "lending", decisionId: `lending:${AGENT}:arm:1`,
        });
        await harnessRef!.journal.markRolledBack(key, "relay FAILED");
        await base.guards.finishArm({
          ownerAddress: ownerAccount.address, agentId: AGENT,
          expectedRowVersion: admitted.kind === "ok" ? admitted.record.rowVersion : 0,
          outcome: "closed", closeReason: "arm-rolled-back",
        });
      }),
    });
    harnessRef = harness;
    await seedLendingAgent(harness, base, "provisioning-guard");
    const pre = (await base.guards.get(ownerAccount.address, AGENT))!;

    const response = await call(harness, `/agents/${AGENT}/lending/arm`, {
      method: "POST",
      body: await signOwnerAction("lendingArm", {
        settings: SETTINGS, budgetWei: HIRE_BUDGET_WEI.toString(), reserveBps: 2_000,
      }, { agentId: AGENT }),
    });
    assert.equal(response.status, 200);
    const guard = (await base.guards.get(ownerAccount.address, AGENT))!;
    assert.notEqual(
      guard.armJournalKey, `${AGENT}:lending:${AGENT}:arm:${pre.rowVersion}`,
      "the pre-fence version belongs to the admission that rolled back",
    );
    assert.equal(guard.armJournalKey, `${AGENT}:lending:${AGENT}:arm:3`);
    assert.equal(
      harness.provider.executeCalls.length, 1,
      "a reused key is refused ABOVE the submit, so a collision shows up as zero calls",
    );
    assert.equal(guard.status, "armed");
  });
});
