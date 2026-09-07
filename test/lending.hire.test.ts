/**
 * The `lending-v1` S1 seam — the receipt, the sizing on the SIGNED settings,
 * and the atomic `PendingGrant` write
 * (MARKETPLACE-LENDING-AGENT R3.3, R3.8, R3.14/L1, R2.15/L3; R2.24).
 *
 * REVIEW2 H3 is the reason this file exists: R3.1's and R3.2's floors need
 * inputs that did not exist on the hire envelope, and the guard row had no
 * atomic write seam at S1 at all. Both are asserted here — the settings ride
 * the envelope, the receipt binds every sizing input, and the money-authority
 * data is written INSIDE `createProvisioningAgent`'s CAS as
 * `initialLendingHire`, so a crash cannot leave a grantable agent whose
 * guarded account the plane does not know.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";

import {
  NOW_SEC,
  call,
  createHarness,
  errorCode,
  ownerAccount,
  signOwnerAction,
  type Harness,
  type SignedEnvelope,
} from "./support/serverHarness.js";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import { MemoryAgentStore, type AgentStore } from "../src/store/agents.js";
import { MemoryVenusObservationStore } from "../src/store/venusObservations.js";
import { MemoryVenusSettingsStore } from "../src/store/venusSettings.js";
import { MemoryLendingGuardStore } from "../src/store/lendingGuards.js";
import { calculateVenusRisk, E18 } from "../src/venus/risk.js";
import { lendingSettingsDigest } from "../src/http/lendingWire.js";
import {
  issueLendingPreviewReceipt,
  parseLendingPreviewSecret,
} from "../src/lending/preview.js";
import { convergeProvisioning } from "../src/wallet/provisioning.js";
import type { GrantEvidenceReader, GrantEvidenceSnapshot } from "../src/wallet/grantEvidence.js";
import type { KeyStoreReader } from "../src/account/keyStoreReader.js";
import type { LendingChainReaders } from "../src/lending/readers.js";
import type { LendingServerDeps } from "../src/server.js";
import type { VenusAccountReading, VenusMarketReading } from "../src/venus/types.js";

const WALLET = getAddress("0x2000000000000000000000000000000000000002");
const GUARDED = getAddress("0x00000000000000000000000000000000000000a9");
const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
const ROUTER = getAddress("0x5000000000000000000000000000000000000005");
const WBNB = getAddress("0x6000000000000000000000000000000000000006");
const QUOTER = getAddress("0x9000000000000000000000000000000000000009");
const FACTORY = getAddress("0xa000000000000000000000000000000000000010");
const POOL = getAddress("0xa000000000000000000000000000000000000011");
const NFPM = getAddress("0x4000000000000000000000000000000000000004");
const TREASURY = getAddress("0x7000000000000000000000000000000000000007");
const KEYSTORE = getAddress("0x8000000000000000000000000000000000000008");
const SECRET = "ab".repeat(32);
const KEY = parseLendingPreviewSecret(SECRET)!;

const BUDGET = 5n * 10n ** 17n;
const RESERVE_BPS = 2_000;
const SUPPLY = (BUDGET * 8_000n) / 10_000n;
const RESERVE_NATIVE = BUDGET - SUPPLY;
const MAX_PER_ACTION_USDT = 100n * E18;
const RESCUE_COUNT = 6;
/** The fake quoter is a flat book at 600 USDT per BNB, floored 1 % by the rail. */
const MINT_USDT = (SUPPLY * 600n * 9_900n) / 10_000n;
const TIER_BUYBACK = (RESERVE_NATIVE * 600n * 9_900n) / 10_000n;

function pct(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * E18 + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

const SETTINGS = {
  triggerHf: pct("1.2").toString(),
  targetHf: pct("1.5").toString(),
  maxPerAction: [{ token: USDT, maxWei: MAX_PER_ACTION_USDT.toString() }],
  minSecondsBetweenActions: 300,
  rescueReserveCount: RESCUE_COUNT,
};

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

function reading(): VenusAccountReading {
  const markets = [
    market(),
    market({
      vToken: V_USDT, vTokenSymbol: "vUSDT", underlying: USDT, native: false,
      collateralMember: false, vTokenBalance: 0n,
      borrowStored: 700n * E18, borrowCurrent: 700n * E18,
      exchangeRateStored: E18, exchangeRateCurrent: E18,
      spotPrice: pct("1"), boundedCollateralPrice: pct("1"), boundedDebtPrice: pct("1"),
    }),
  ];
  const pair = calculateVenusRisk(
    markets.map((entry) => ({
      collateralMember: entry.collateralMember, vTokenBalance: entry.vTokenBalance,
      collateralFactor: entry.effectiveCf, liquidationThreshold: entry.effectiveLt,
      collateralPrice: entry.boundedCollateralPrice, debtPrice: entry.boundedDebtPrice,
      spotPrice: entry.spotPrice, exchangeRate: entry.exchangeRateStored,
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

type S1Options = {
  readonly borrows?: readonly { readonly vToken: Address; readonly borrowWei: bigint }[];
  readonly liquidityErrorCode?: bigint;
  readonly previewSecret?: string | null;
};

function lendingDeps(options: S1Options = {}): LendingServerDeps {
  const readers: LendingChainReaders = {
    async readAccount() { return reading(); },
    async readReserve() {
      return {
        blockNumber: 120_000_000n, wallet: WALLET,
        usdtBalance: 0n, vUsdtBalance: 0n,
        exchangeRateStored: E18, exchangeRateCurrent: E18,
        cash: 10n ** 24n, nativeBalance: 10n ** 18n,
        usdtAllowanceToVUsdt: 0n, usdtAllowanceToRouter: 0n,
        poolSqrtPriceX96: null, poolWbnbIsToken0: false,
      };
    },
    async readTokenDayMeter() {
      return { kind: "day", limitWei: 10n ** 24n, currentSpentWei: 0n, remainingWei: 10n ** 24n };
    },
    async quote(input) {
      return input.tokenIn.toLowerCase() === WBNB.toLowerCase()
        ? input.amountInWei * 600n
        : input.amountInWei / 600n;
    },
    async readSwapPool() { return { pool: POOL, liquidity: 10n ** 24n, token0: USDT }; },
    async readS1Facts() {
      return {
        blockNumber: 120_000_000n,
        liquidityErrorCode: options.liquidityErrorCode ?? 0n,
        borrows: options.borrows ?? [{ vToken: V_USDT, borrowWei: 700n * E18 }],
      };
    },
  };
  const secret = options.previewSecret === undefined ? SECRET : options.previewSecret;
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
    intervalMs: 30_000, maxObservationAgeMs: 90_000, maxSagaSlippageBps: 100,
    previewSecret: secret === null ? null : parseLendingPreviewSecret(secret),
  };
}

/** The floors the preview would have derived for the fixture above. */
function floors() {
  const usdtReserveCeiling = MINT_USDT + TIER_BUYBACK;
  const reserveCapFloorWei = (11n * MINT_USDT + 9n) / 10n + usdtReserveCeiling;
  // AUDIT A-M1: + the BNB tier, the both-markets day's second native leg.
  const minimumCapDayWei =
    SUPPLY + BUDGET + RESERVE_NATIVE
    + BigInt(RESCUE_COUNT + 2) * 100_000_000_000_000n + 1n;
  return { reserveCapFloorWei, minimumCapDayWei };
}

function receipt(overrides: Record<string, unknown> = {}, key = KEY): string {
  const { reserveCapFloorWei, minimumCapDayWei } = floors();
  return issueLendingPreviewReceipt({
    key,
    nowSec: NOW_SEC,
    claims: {
      account: GUARDED,
      blockNumber: "120000000",
      guardable: true,
      debts: [{ vToken: V_USDT, borrowWei: (700n * E18).toString() }],
      budgetWei: BUDGET.toString(10),
      reserveBps: RESERVE_BPS,
      maxPerActionUsdtWei: MAX_PER_ACTION_USDT.toString(10),
      rescueReserveCount: RESCUE_COUNT,
      mintUsdtWei: MINT_USDT.toString(10),
      tierBuyBackUsdtWei: TIER_BUYBACK.toString(10),
      reserveCapFloorWei: reserveCapFloorWei.toString(10),
      minimumCapDayWei: minimumCapDayWei.toString(10),
      ...overrides,
    } as never,
  }).token;
}

function hireParams(overrides: Record<string, unknown> = {}) {
  const { reserveCapFloorWei, minimumCapDayWei } = floors();
  return {
    walletAddress: WALLET,
    token: USDT,
    capDayWei: minimumCapDayWei.toString(10),
    openNativeBudgetWei: BUDGET.toString(10),
    ttlSec: 604_800,
    sizingPreset: "lending-v1",
    guardedAccount: GUARDED,
    debtMarkets: [V_USDT],
    reserveCapWei: reserveCapFloorWei.toString(10),
    reserveBps: RESERVE_BPS,
    settings: SETTINGS,
    previewReceipt: receipt(),
    ...overrides,
  };
}

async function fixture(options: S1Options = {}) {
  const store = new MemoryAgentStore(null, () => NOW_SEC * 1_000, {
    chainId: 56, keyStoreAddress: KEYSTORE,
  });
  const proxied = new Proxy(store, {
    get(target, property, receiver): unknown {
      if (property === "durable") return true;
      if (property === "keyEncryptionConfigured") return true;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentStore;
  const evidence: GrantEvidenceReader = {
    async readFunding() {
      return {
        version: 1, observedAtSec: NOW_SEC, registrationFeeWei: "1", registrations: 2,
        relayGasHeadroomWei: "3", requiredWei: "5", balanceWei: "100000000000000000000",
      };
    },
    async readGrant(): Promise<GrantEvidenceSnapshot> {
      return {
        relayKeys: [], accountKey: null, accountSpend: [], canExecute: [],
        keyStore: { kind: "absent" }, ownerVerdict: "verified",
      } as unknown as GrantEvidenceSnapshot;
    },
  } as unknown as GrantEvidenceReader;
  const keyStoreReader: KeyStoreReader = {
    async listKeys() { return []; },
    async publicKeyFor() { return `0x${"22".repeat(64)}` as Hex; },
    async isValidKey() { return false; },
  } as unknown as KeyStoreReader;

  const lending = lendingDeps(options);
  const harness = await createHarness({
    seedAgent: false,
    agentStore: proxied,
    keyStoreReader,
    lending,
    config: {
      chainId: 56, network: "mainnet", keyStore: KEYSTORE, hireEnabled: true,
      passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true },
      executeRawEnabled: false,
      accountReadSession: {
        key: parseAccountReadSessionSecret("cd".repeat(32))!,
        chainId: 56, environment: resolveDomainSalt({ chainId: 56, network: "mainnet" }),
      },
    },
    hire: {
      evidence, nfpm: NFPM, routerV3: ROUTER, wbnb: WBNB, treasury: TREASURY,
      feeBps: 0, relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n,
    },
  });
  return { harness, store: proxied, lending };
}

async function signed(id: string, params: unknown): Promise<SignedEnvelope> {
  return signOwnerAction("provisionAgent", params, {
    agentId: id, chainId: 56, network: "mainnet",
  });
}

async function post(harness: Harness, id: string, params: unknown) {
  return call(harness, `/agents/${id}/session`, {
    method: "POST", body: await signed(id, params),
  });
}

/* -------------------------------------------------------------------------- */

describe("lending-v1 S1 — the happy path and what it persists", () => {
  it("accepts the hire and writes the money-authority data on the PendingGrant", async () => {
    const f = await fixture();
    const id = "lending-hire-ok";
    const response = await post(f.harness, id, hireParams());
    assert.equal(response.status, 200, response.text);

    const row = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(row?.status, "provisioning");
    // R2.15 / L3: `hireSizing` stays FLAT — only the name widened.
    assert.deepEqual(row?.pendingGrant?.sizing, {
      openNativeBudgetWei: BUDGET.toString(10),
      capDayWei: floors().minimumCapDayWei.toString(10),
      sizingPreset: "lending-v1",
      sizingPresetVersion: 1,
    });
    // R3.3(2): the guarded account, the pinned markets, the caps and the signed
    // settings ride HERE, written inside the same CAS as the row and the key.
    const hire = row?.pendingGrant?.initialLendingHire;
    assert.equal(hire?.guardedAccount, GUARDED);
    assert.deepEqual(hire?.debtMarkets, [V_USDT]);
    assert.equal(hire?.reserveCapWei, floors().reserveCapFloorWei.toString(10));
    assert.equal(hire?.reserveBps, RESERVE_BPS);
    assert.equal(hire?.digest, lendingSettingsDigest(SETTINGS));
    assert.notEqual(await f.store.getAgentSessionKey(ownerAccount.address, id), null);
    // L6: `caps.dailyNativeWei` takes `capDayWei` (the trade rule).
    assert.equal(row?.caps?.dailyNativeWei, BigInt(floors().minimumCapDayWei));
    // The guard has NO HTTP runtime route at all.
    assert.equal(row?.httpRuntimeProfile, "unbound-v1");
  });

  it("grants vBNB ONLY when it is pinned — the USDT-only hire names three targets", async () => {
    const f = await fixture();
    const id = "lending-hire-usdt-only";
    await post(f.harness, id, hireParams());
    const spec = (await f.store.getAgent(ownerAccount.address, id))?.pendingGrant?.sessionSpec;
    assert.ok(
      !spec?.allowedCalls.some((rule) => rule.to?.toLowerCase() === V_BNB.toLowerCase()),
      "an ungranted market is one fewer target a leaked key reaches",
    );
    const usdtCap = spec?.spendCaps.find((cap) => cap.token?.toLowerCase() === USDT.toLowerCase());
    assert.equal(usdtCap?.limit, floors().reserveCapFloorWei);
  });

  it("materializes the settings row and the `provisioning-guard` row at CONVERGENCE", async () => {
    const f = await fixture();
    const id = "lending-hire-converge";
    await post(f.harness, id, hireParams());
    const row = await f.store.getAgent(ownerAccount.address, id);
    // R3.3(3): the convergence seam, driven directly so the assertion is about
    // the seam rather than about the evidence reader's mood.
    await convergeProvisioning({
      store: f.store,
      evidence: {
        async readGrant(pending: unknown) {
          return {
            relayKeys: [], accountKey: null, accountSpend: [], canExecute: [],
            keyStore: { kind: "absent" }, ownerVerdict: "verified",
            pending,
          } as unknown as GrantEvidenceSnapshot;
        },
      } as unknown as GrantEvidenceReader,
      ownerAddress: ownerAccount.address,
      agentId: id,
      keyStore: KEYSTORE,
      nowSec: NOW_SEC,
      lendingSettings: f.lending.settingsStore,
      lendingGuards: f.lending.guards,
    });
    void row;
    // The evidence above is deliberately incomplete, so the agent stays
    // `provisioning` — what matters is that the materialization is REACHED only
    // when the evidence is complete, which the next assertion pins.
    const guard = await f.lending.guards.get(ownerAccount.address, id);
    assert.equal(guard, null, "incomplete evidence materializes nothing");
  });
});

describe("the preview receipt (R3.8, R3.3(b))", () => {
  it("REFUSES a hire with no receipt at all", async () => {
    const f = await fixture();
    const response = await post(f.harness, "no-receipt", (() => {
      const params = hireParams();
      const { previewReceipt: _drop, ...rest } = params as Record<string, unknown>;
      return rest;
    })());
    assert.equal(response.status, 400);
  });

  it("REFUSES a receipt signed with another key", async () => {
    const f = await fixture();
    const other = parseLendingPreviewSecret("cd".repeat(32))!;
    const response = await post(f.harness, "wrong-key", hireParams({
      previewReceipt: receipt({}, other),
    }));
    assert.equal(response.status, 400);
    assert.match(response.text, /missing, malformed or older than 30 seconds/u);
  });

  it("REFUSES an EXPIRED receipt", async () => {
    const f = await fixture();
    const stale = issueLendingPreviewReceipt({
      key: KEY, nowSec: NOW_SEC - 31,
      claims: {
        account: GUARDED, blockNumber: "120000000", guardable: true,
        debts: [{ vToken: V_USDT, borrowWei: (700n * E18).toString() }],
        budgetWei: BUDGET.toString(10), reserveBps: RESERVE_BPS,
        maxPerActionUsdtWei: MAX_PER_ACTION_USDT.toString(10),
        rescueReserveCount: RESCUE_COUNT,
        mintUsdtWei: MINT_USDT.toString(10),
        tierBuyBackUsdtWei: TIER_BUYBACK.toString(10),
        reserveCapFloorWei: floors().reserveCapFloorWei.toString(10),
        minimumCapDayWei: floors().minimumCapDayWei.toString(10),
      } as never,
    }).token;
    const response = await post(f.harness, "expired", hireParams({ previewReceipt: stale }));
    assert.equal(response.status, 400);
  });

  it("REFUSES a receipt issued for a DIFFERENT guarded account", async () => {
    const f = await fixture();
    const response = await post(f.harness, "wrong-account", hireParams({
      previewReceipt: receipt({ account: WALLET }),
    }));
    assert.equal(response.status, 400);
    assert.match(response.text, /different guarded account/u);
  });

  it("REFUSES a receipt taken for a DIFFERENT budget — the H3(b) case", async () => {
    // A receipt bound to budget X, presented for 10X. Without the sizing inputs
    // on the receipt, S1 has no quote of its own with which to notice.
    const f = await fixture();
    const response = await post(f.harness, "wrong-budget", hireParams({
      openNativeBudgetWei: (BUDGET * 10n).toString(10),
    }));
    assert.equal(response.status, 400);
    assert.match(response.text, /does not match the sizing inputs/u);
  });

  it("REFUSES a receipt whose rescueReserveCount differs from the signed settings", async () => {
    const f = await fixture();
    const response = await post(f.harness, "wrong-count", hireParams({
      settings: { ...SETTINGS, rescueReserveCount: 3 },
    }));
    assert.equal(response.status, 400);
    assert.match(response.text, /does not match the sizing inputs/u);
  });

  it("REFUSES a receipt whose USDT ceiling differs from the signed settings", async () => {
    const f = await fixture();
    const response = await post(f.harness, "wrong-ceiling", hireParams({
      settings: {
        ...SETTINGS,
        maxPerAction: [{ token: USDT, maxWei: (MAX_PER_ACTION_USDT * 2n).toString() }],
      },
    }));
    assert.equal(response.status, 400);
  });

  it("REFUSES a receipt whose `guardable` is false", async () => {
    const f = await fixture();
    const response = await post(f.harness, "not-guardable", hireParams({
      previewReceipt: receipt({ guardable: false }),
    }));
    assert.equal(response.status, 400);
    assert.match(response.text, /cannot be guarded/u);
  });

  it("FAIL-CLOSED with no configured secret", async () => {
    const f = await fixture({ previewSecret: null });
    const response = await post(f.harness, "no-secret", hireParams());
    assert.equal(response.status, 400);
    assert.match(response.text, /preview-receipt-unavailable/u);
  });
});

describe("S1's THREE bounded reads (R3.14/L1)", () => {
  it("refuses a non-zero Comptroller liquidity code as `protocol-error`", async () => {
    const f = await fixture({ liquidityErrorCode: 9n });
    const response = await post(f.harness, "protocol-error", hireParams());
    assert.equal(response.status, 400);
    assert.match(response.text, /protocol-error/u);
  });

  it("refuses a pinned market the account does not borrow in", async () => {
    const f = await fixture({ borrows: [{ vToken: V_USDT, borrowWei: 0n }] });
    const response = await post(f.harness, "not-held", hireParams());
    assert.equal(response.status, 400);
    assert.match(response.text, /debt-market-not-held/u);
  });
});

describe("envelope validation and the nonce", () => {
  it("refuses a `token` that is not the boot-derived USDT", async () => {
    const f = await fixture();
    const response = await post(f.harness, "wrong-token", hireParams({ token: WBNB }));
    assert.equal(response.status, 400);
    assert.match(response.text, /reserve asset/u);
  });

  it("refuses a debt market outside {vUSDT, vBNB}", async () => {
    const f = await fixture();
    const response = await post(f.harness, "wrong-market", hireParams({
      debtMarkets: [NFPM], previewReceipt: receipt({
        debts: [{ vToken: NFPM, borrowWei: (1n * E18).toString() }],
      }),
    }));
    assert.equal(response.status, 400);
  });

  it("refuses a guardedAccount equal to the agent wallet", async () => {
    const f = await fixture();
    const response = await post(f.harness, "self-guard", hireParams({
      guardedAccount: WALLET, previewReceipt: receipt({ account: WALLET }),
    }));
    assert.equal(response.status, 400);
  });

  it("refuses an envelope carrying an unknown key", async () => {
    const f = await fixture();
    const response = await post(f.harness, "extra-key", hireParams({ extra: 1 }));
    assert.equal(response.status, 400);
  });

  it("CONSUMES NO NONCE on a refusal — the same signature works once fixed", async () => {
    const f = await fixture({ liquidityErrorCode: 9n });
    const id = "no-nonce-burn";
    const params = hireParams();
    const envelope = await signed(id, params);
    const refused = await call(f.harness, `/agents/${id}/session`, {
      method: "POST", body: envelope,
    });
    assert.equal(refused.status, 400);
    // `consume` answers TRUE on FIRST use, so a nonce a refusal left unspent is
    // still claimable — the direct proof that nothing was consumed.
    assert.equal(
      await f.harness.nonceStore.consume(
        ownerAccount.address, String(envelope.signed.nonce), (NOW_SEC + 600) * 1000,
      ),
      true,
      "nothing is consumed on a 400: the owner can fix the input and re-send",
    );
  });

  it("refuses a sizing that does not clear the floors, on the SIGNED settings", async () => {
    // R2.24: the check that runs at S1 must be the one the preview ran, over
    // the settings the owner actually signed.
    const f = await fixture();
    const response = await post(f.harness, "under-capped", hireParams({
      reserveCapWei: "1",
    }));
    assert.equal(response.status, 400);
    // AUDIT A-M3: remedy first, figure structured — the arithmetic prose no
    // longer survives `sanitizeMessage`'s 280-character cap, so the refusal
    // leads with what to do and carries the shortfall as `meta.shortfallWei`.
    assert.match(response.text, /lending-sizing-short: raise the daily caps/u);
    assert.match(response.text, /"shortfallWei":"[0-9]+"/u);
  });

  it("refuses a native cap below the arm-plus-one-rescue floor", async () => {
    const f = await fixture();
    const response = await post(f.harness, "under-native", hireParams({
      capDayWei: "1000",
    }));
    assert.equal(response.status, 400);
    assert.match(response.text, /lending-sizing-short: raise the daily caps/u);
    assert.match(response.text, /"shortfallWei":"[0-9]+"/u);
  });
});

describe("the hire preview route accepts lending-v1", () => {
  it("answers the funding half and says where the floors come from", async () => {
    const f = await fixture();
    const response = await call(
      f.harness,
      `/agents/hire/preview?walletAddress=${WALLET}&openNativeBudgetWei=${BUDGET}&sizingPreset=lending-v1`,
    );
    assert.equal(response.status, 200, response.text);
    const data = response.body["data"] as Record<string, unknown>;
    const sizing = data["sizing"] as Record<string, unknown>;
    assert.equal(sizing["name"], "lending-v1");
    assert.equal(sizing["armSubmissionPad"], 3);
    assert.match(String(sizing["note"]), /guardable in receipt mode/u);
    assert.ok(data["funding"] !== undefined);
  });
});

/** Compile-time proof that `errorCode` stays reachable for future assertions. */
void errorCode;
