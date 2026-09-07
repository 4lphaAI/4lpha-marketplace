/**
 * Boot-time configuration: the fee seam, the session template, the venue
 * overrides, and the numeric ceilings.
 *
 * Everything here is about a value being refused BEFORE the process serves, so
 * the tests are mostly "this throws, with a message naming the variable".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress, type Address } from "viem";
import {
  MAX_MAX_SLIPPAGE_BPS,
  MAX_MAX_VENUE_FEE_BPS,
  resolveExecuteRawEnabled,
  resolveTradeConfig,
} from "../src/ops/config.js";
import {
  MAX_FEE_BPS,
  createBpsFeePolicy,
  createNoFeePolicy,
  feeValueOf,
} from "../src/ops/fees.js";
import {
  APPROVE_SELECTOR,
  DEFAULT_TOKEN_CAP_LIMIT,
  DEFAULT_TOKEN_CAP_PERIOD,
  MAX_TRADE_SESSION_SECONDS,
  RELAY_FEE_PER_EXIT_WEI,
  checkNativeCapSizing,
  exitReserveWei,
  maxOffChainDailyCapWei,
  grantsTokenSell,
  grantsTreasury,
  tradeSessionSpec,
  type TokenGrant,
} from "../src/ops/policy.js";
import { validateSessionSpec } from "../src/core/session.js";
import {
  FLAP_PORTAL_56,
  FOUR_MEME_HELPER_56,
  FOUR_MEME_TOKEN_MANAGER_56,
  PANCAKE_V2_ROUTER_56,
  PANCAKE_V3_ROUTER_56,
  WBNB_56,
  pancakeV3Venue,
  pancakeVenue,
  resolveVenues,
} from "../src/ops/venues.js";
import type { SessionSpec, SpendCap } from "../src/core/types.js";

const KEY_STORE = getAddress("0x00000000000000000000000000000000000000ff");
const TREASURY = getAddress("0x7e41F09dF5cb1Ec9323bC101D3a9e65bE4e510AD");
const TOKEN = getAddress("0x00000000000000000000000000000000000000AA");
const NOW = 1_900_000_000;
const CAPS: readonly SpendCap[] = [{ limit: 10n ** 18n, period: "day" }];

/* -------------------------------------------------------------------------- */
/* Venues                                                                     */
/* -------------------------------------------------------------------------- */

describe("resolveVenues", () => {
  it("ships the verified mainnet defaults", () => {
    const venues = resolveVenues({ chainId: 56 });
    assert.equal(venues.pancakeRouterV2, PANCAKE_V2_ROUTER_56);
    assert.equal(venues.pancakeRouterV3, PANCAKE_V3_ROUTER_56);
    assert.equal(venues.wbnb, WBNB_56);
    assert.equal(venues.fourMemeTokenManager, FOUR_MEME_TOKEN_MANAGER_56);
    assert.equal(venues.fourMemeHelper, FOUR_MEME_HELPER_56);
  });

  it("ships chain 97 EMPTY rather than guessing", () => {
    // The circulating testnet router is unverified and Four.Meme has no testnet
    // deployment. An unconfigured venue is a 400; a guessed one submits.
    const venues = resolveVenues({ chainId: 97 });
    assert.equal(venues.pancakeRouterV2, undefined);
    assert.equal(venues.wbnb, undefined);
    assert.equal(venues.fourMemeTokenManager, undefined);
    assert.equal(venues.fourMemeHelper, undefined, "no helper ⇒ no fourmeme venue");
    assert.equal(venues.pancakeRouterV3, undefined);
    assert.equal(pancakeVenue(venues), null);
    assert.equal(pancakeV3Venue(venues), null);
  });

  it("resolves the V3 venue only when BOTH the router and WBNB are present", () => {
    // PHASE2.2 R6. Every V3 path begins or ends at WBNB and the two addresses
    // are independently optional, so a router configured without WBNB must NOT
    // pass the venue gate and then build a path through `undefined`.
    const both = resolveVenues({ chainId: 56 });
    assert.deepEqual(pancakeV3Venue(both), {
      router: PANCAKE_V3_ROUTER_56,
      wbnb: WBNB_56,
    });
    assert.equal(
      pancakeV3Venue({ chainId: 56, pancakeRouterV3: PANCAKE_V3_ROUTER_56 }),
      null,
      "a router with no WBNB is not a usable V3 venue",
    );
    assert.equal(pancakeV3Venue({ chainId: 56, wbnb: WBNB_56 }), null);
  });

  it("applies overrides and normalizes casing", () => {
    const venues = resolveVenues({
      chainId: 56,
      overrides: { pancakeRouterV2: TOKEN.toLowerCase() },
    });
    assert.equal(venues.pancakeRouterV2, TOKEN);
    assert.equal(venues.wbnb, WBNB_56, "an unset override keeps the default");
  });

  it("refuses a malformed, zero, or KeyStore override", () => {
    for (const [value, expected] of [
      ["not-an-address", /valid checksummed address/],
      ["0x00000000000000000000000000000000000000", /valid checksummed address/],
      // A corrupted mixed-case checksum: exactly the typo class worth catching.
      ["0x10ed43C718714eb63d5aA57B78B54704E256024E", /valid checksummed address/],
      [zeroAddress, /zero address/],
    ] as const) {
      assert.throws(
        () =>
          resolveVenues({
            chainId: 56,
            overrides: { pancakeRouterV2: value },
            keyStore: KEY_STORE,
          }),
        expected,
      );
    }
    assert.throws(
      () =>
        resolveVenues({
          chainId: 56,
          overrides: { wbnb: KEY_STORE },
          keyStore: KEY_STORE,
        }),
      /key registry/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Fees                                                                       */
/* -------------------------------------------------------------------------- */

const FEE_CONTEXT = {
  agentId: "a",
  venue: "pancake",
  side: "buy",
  token: TOKEN,
  nativeInWei: 10n ** 18n,
} as const;

describe("fee policies", () => {
  it("no-fee returns null for everything", () => {
    assert.equal(createNoFeePolicy()(FEE_CONTEXT), null);
    assert.equal(feeValueOf(null), 0n);
  });

  it("bps fee charges on top of the PRE-fee input", () => {
    const policy = createBpsFeePolicy({ treasury: TREASURY, bps: 100 });
    const call = policy(FEE_CONTEXT);
    assert.deepEqual(call, { to: TREASURY, value: 10n ** 16n });
    assert.equal(feeValueOf(call), 10n ** 16n);
  });

  it("charges nothing on a sell", () => {
    const policy = createBpsFeePolicy({ treasury: TREASURY, bps: 100 });
    assert.equal(policy({ ...FEE_CONTEXT, side: "sell", nativeInWei: 0n }), null);
  });

  it("emits no call when the fee floors to zero", () => {
    // A zero-value transfer would burn gas to move nothing and would still have
    // to clear the on-chain allowlist.
    const policy = createBpsFeePolicy({ treasury: TREASURY, bps: 1 });
    assert.equal(policy({ ...FEE_CONTEXT, nativeInWei: 9_999n }), null);
  });

  it("refuses a rate above the 5% ceiling, or a non-integer one", () => {
    for (const bps of [0, -1, MAX_FEE_BPS + 1, 1_000, 10_000, 1.5]) {
      assert.throws(() => createBpsFeePolicy({ treasury: TREASURY, bps }), /FEE_BPS/);
    }
    assert.doesNotThrow(() =>
      createBpsFeePolicy({ treasury: TREASURY, bps: MAX_FEE_BPS }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Session template                                                           */
/* -------------------------------------------------------------------------- */

describe("tradeSessionSpec", () => {
  const venues = resolveVenues({ chainId: 56 });
  const TOKEN_B = getAddress("0x00000000000000000000000000000000000000bB");

  it("grants each configured venue, and NO bare-selector approve", () => {
    const spec = tradeSessionSpec({
      venues,
      tokens: [],
      nativeCaps: CAPS,
      expiresAt: NOW + 3_600,
      nowSeconds: NOW,
    });
    // PHASE2.3: the bare-selector `approve` is gone, and with it the opt-in
    // flag that existed only to permit it. `approve` is now per token.
    assert.equal(spec.allowUnrestrictedSelector, undefined);
    assert.equal(
      spec.allowedCalls.filter((rule) => rule.to === undefined).length,
      0,
      "no rule may omit `to`",
    );
    const targets = spec.allowedCalls
      .map((rule) => rule.to)
      .filter((to): to is Address => to !== undefined);
    // PHASE2.2 R11: the V3 router joins the template, so this snapshot moved.
    // It moved because `agentOwnerView` renders `allowedCalls` verbatim.
    // PHASE2.4: and the flap Portal joins it, for the same reason and with the
    // same timing caveat — a session granted before the line existed cannot
    // call the Portal, because a persisted spec is never rewritten.
    assert.deepEqual(targets.toSorted(), [
      FLAP_PORTAL_56,
      FOUR_MEME_TOKEN_MANAGER_56,
      PANCAKE_V2_ROUTER_56,
      PANCAKE_V3_ROUTER_56,
    ].toSorted());
  });

  it("emits an approve rule AND a spend cap for every token", () => {
    // The whole point of PHASE2.3. FINDINGS (h): the allowlist alone lets an
    // agent buy; only the matching per-token cap lets it sell.
    const spec = tradeSessionSpec({
      venues,
      tokens: [{ token: TOKEN }, { token: TOKEN_B }],
      nativeCaps: CAPS,
      expiresAt: NOW + 3_600,
      nowSeconds: NOW,
    });
    for (const token of [TOKEN, TOKEN_B]) {
      assert.equal(
        spec.allowedCalls.filter(
          (rule) => rule.to === token && rule.selector === APPROVE_SELECTOR,
        ).length,
        1,
        `${token} needs exactly one target-bound approve rule`,
      );
      assert.equal(
        spec.spendCaps.filter((cap) => cap.token === token).length,
        1,
        `${token} needs exactly one spend cap`,
      );
    }
    // Native cap plus one per token, and nothing else.
    assert.equal(spec.spendCaps.length, CAPS.length + 2);
    // And it VALIDATES — including `assertTokenMoversAreCapped`, which is the
    // guard that would have refused the old template had it seen the rules.
    assert.doesNotThrow(() => validateSessionSpec(spec, { nowSeconds: NOW }));
  });

  it("defaults a token cap to the 2^160 gate on a rolling day", () => {
    const spec = tradeSessionSpec({
      venues,
      tokens: [{ token: TOKEN }],
      nativeCaps: CAPS,
      expiresAt: NOW + 3_600,
      nowSeconds: NOW,
    });
    assert.deepEqual(
      spec.spendCaps.find((cap) => cap.token === TOKEN),
      { token: TOKEN, limit: DEFAULT_TOKEN_CAP_LIMIT, period: DEFAULT_TOKEN_CAP_PERIOD },
    );
    assert.equal(DEFAULT_TOKEN_CAP_LIMIT, 2n ** 160n);
    assert.equal(DEFAULT_TOKEN_CAP_PERIOD, "day");
  });

  it("honours a caller-supplied token limit and period", () => {
    // R4 permits a finite cap; it just must not be the default, and the caller
    // owns the sizing (summed per-period approvals, not the position).
    const spec = tradeSessionSpec({
      venues,
      tokens: [{ token: TOKEN, limit: 500n, period: "hour" }],
      nativeCaps: CAPS,
      expiresAt: NOW + 3_600,
      nowSeconds: NOW,
    });
    assert.deepEqual(
      spec.spendCaps.find((cap) => cap.token === TOKEN),
      { token: TOKEN, limit: 500n, period: "hour" },
    );
  });

  it("dedups the token list by lowercased address", () => {
    // R6. `validateSessionSpec` dedups caps by `token:period` only and nothing
    // dedups the call array, so a duplicate would change the byte-exact
    // permissions the grant is hashed over and `restoreSession` must reproduce.
    const spec = tradeSessionSpec({
      venues,
      tokens: [
        { token: TOKEN },
        { token: TOKEN.toLowerCase() as Address, limit: 7n, period: "hour" },
        { token: TOKEN },
      ],
      nativeCaps: CAPS,
      expiresAt: NOW + 3_600,
      nowSeconds: NOW,
    });
    assert.equal(spec.allowedCalls.filter((rule) => rule.selector !== undefined).length, 1);
    assert.equal(spec.spendCaps.filter((cap) => cap.token !== undefined).length, 1);
    // FIRST wins, so the dedup is a stable function of the input order.
    assert.equal(spec.spendCaps.find((cap) => cap.token !== undefined)?.limit, DEFAULT_TOKEN_CAP_LIMIT);
  });

  it("accepts an EMPTY token list — a buy-nothing agent, not a trap", () => {
    // R6: the boot-time treasury probe needs this, and R1 makes the degenerate
    // state coherent (every buy refused) rather than silently un-sellable.
    const spec = tradeSessionSpec({
      venues,
      tokens: [],
      nativeCaps: CAPS,
      expiresAt: NOW + 3_600,
      nowSeconds: NOW,
    });
    assert.equal(spec.spendCaps.filter((cap) => cap.token !== undefined).length, 0);
  });

  it("keeps native caps a LIST, so a day cap and a per-trade cap coexist", () => {
    // R6: provisioning builds a `day` cap plus an optional `--cap-trade`
    // `minute` cap. A singular `nativeCap` field could not express the pair.
    const spec = tradeSessionSpec({
      venues,
      tokens: [],
      nativeCaps: [
        { limit: 10n ** 18n, period: "day" },
        { limit: 10n ** 17n, period: "minute" },
      ],
      expiresAt: NOW + 3_600,
      nowSeconds: NOW,
    });
    assert.equal(spec.spendCaps.length, 2);
  });

  it("refuses a TOKEN cap smuggled in through nativeCaps", () => {
    // It would arrive without the approve rule that makes it usable, and sit
    // outside the dedup.
    assert.throws(
      () =>
        tradeSessionSpec({
          venues,
          tokens: [],
          nativeCaps: [{ limit: 1n, period: "day", token: TOKEN }],
          expiresAt: NOW + 3_600,
          nowSeconds: NOW,
        }),
      /names a token/,
    );
  });

  it("grants the treasury when a fee is configured, with no cap of its own", () => {
    const spec = tradeSessionSpec({
      venues,
      treasury: TREASURY,
      tokens: [],
      nativeCaps: CAPS,
      expiresAt: NOW + 3_600,
      nowSeconds: NOW,
    });
    assert.ok(grantsTreasury(spec, TREASURY));
    assert.ok(grantsTreasury(spec, TREASURY.toLowerCase() as Address));
    assert.ok(!grantsTreasury(spec, TOKEN));
    // R10: a target-only rule, so `assertTokenMoversAreCapped` skips it, and
    // the fee is NATIVE — already metered by the native cap. A treasury token
    // cap would be meaningless, and narrowing the rule to a selector-bound
    // `transfer` would trip the guard and then demand one.
    assert.deepEqual(
      spec.allowedCalls.find((rule) => rule.to === TREASURY),
      { to: TREASURY },
    );
    assert.equal(spec.spendCaps.some((cap) => cap.token === TREASURY), false);
  });

  it("clamps the expiry to 7 days", () => {
    // PHASE2.3 R5. Up from 24h now that the unrestricted approve is gone — but
    // 7, not 30: Altana caps are rolling with NO lifetime ceiling (FINDINGS d),
    // so the ceiling is what bounds cumulative NATIVE exposure, and per-token
    // caps do nothing for that axis.
    assert.equal(MAX_TRADE_SESSION_SECONDS, 7 * 24 * 60 * 60);
    const spec = tradeSessionSpec({
      venues,
      tokens: [],
      nativeCaps: CAPS,
      expiresAt: NOW + 30 * 24 * 3_600,
      nowSeconds: NOW,
    });
    assert.equal(spec.expiresAt, NOW + MAX_TRADE_SESSION_SECONDS);
  });

  it("CLAMPS rather than rejects, so an over-long request still hires", () => {
    // The clamp semantics are deliberately KEPT (R5): switching to a reject
    // would break "a caller asking for a week gets the ceiling".
    for (const requested of [8 * 24 * 3_600, 31 * 24 * 3_600, 365 * 24 * 3_600]) {
      const spec = tradeSessionSpec({
        venues,
        tokens: [],
        nativeCaps: CAPS,
        expiresAt: NOW + requested,
        nowSeconds: NOW,
      });
      assert.equal(spec.expiresAt, NOW + MAX_TRADE_SESSION_SECONDS);
    }
  });

  it("leaves a shorter requested expiry alone, including exactly 7 days", () => {
    for (const requested of [3_600, MAX_TRADE_SESSION_SECONDS]) {
      const spec = tradeSessionSpec({
        venues,
        tokens: [],
        nativeCaps: CAPS,
        expiresAt: NOW + requested,
        nowSeconds: NOW,
      });
      assert.equal(spec.expiresAt, NOW + requested);
    }
  });

  it("refuses an empty native cap list and a past expiry", () => {
    assert.throws(
      () =>
        tradeSessionSpec({
          venues,
          tokens: [],
          nativeCaps: [],
          expiresAt: NOW + 3_600,
          nowSeconds: NOW,
        }),
      /spend cap/,
    );
    assert.throws(
      () =>
        tradeSessionSpec({
          venues,
          tokens: [],
          nativeCaps: CAPS,
          expiresAt: NOW - 1,
          nowSeconds: NOW,
        }),
      /expiresAt/,
    );
  });

  it("carries the corrected cap docstring in the module source", async () => {
    // The old pin asserted the module still SAID "approvals are not bounded by
    // the spend caps". Mainnet disproved that (FINDINGS h/j: GuardedExecutor
    // meters `approve` against the token's own cap), so the pin is inverted:
    // the false claim must be GONE, and the two invariants that replaced it
    // must be present. A future edit that quietly drops either fails here.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/ops/policy.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(source, /APPROVALS ARE NOT BOUNDED BY THE SPEND CAPS/);
    assert.match(source, /METERS `approve` against the token's own cap/);
    assert.match(source, /A TOKEN CAP IS A GATE, NOT A BUDGET/);
    assert.match(source, /TRADE BUILDERS MUST APPROVE EXACT AMOUNTS/);
  });
});

/* -------------------------------------------------------------------------- */
/* grantsTokenSell — the predicate the trade route's R1 gate reads        */
/* -------------------------------------------------------------------------- */

describe("grantsTokenSell", () => {
  const venues = resolveVenues({ chainId: 56 });
  const granted = tradeSessionSpec({
    venues,
    tokens: [{ token: TOKEN }],
    nativeCaps: CAPS,
    expiresAt: NOW + 3_600,
    nowSeconds: NOW,
  });

  it("is true for a granted token and false for anything else", () => {
    assert.equal(grantsTokenSell(granted, TOKEN), true);
    assert.equal(grantsTokenSell(granted, TREASURY), false);
    assert.equal(grantsTokenSell(granted, PANCAKE_V2_ROUTER_56), false);
  });

  it("matches regardless of checksum casing", () => {
    assert.equal(grantsTokenSell(granted, TOKEN.toLowerCase() as Address), true);
  });

  it("never lets the NATIVE cap answer for a token", () => {
    // The native cap has no `token`, and reading it as a match would re-create
    // FINDINGS (h) exactly: a session with only a native cap would look able to
    // sell everything.
    const nativeOnly = tradeSessionSpec({
      venues,
      tokens: [],
      nativeCaps: CAPS,
      expiresAt: NOW + 3_600,
      nowSeconds: NOW,
    });
    assert.equal(grantsTokenSell(nativeOnly, TOKEN), false);
  });

  it("is false for a spend limit with no approve rule — the half grant", () => {
    // The trap that stranded a real position: `owner-add-spend-limit` set the
    // meter and not the allowlist entry, so `spendInfos` listed the token while
    // `canExecute(approve)` refused, and the sell never submitted. Only the pair
    // makes a token exitable, so only the pair may answer yes here.
    const halfGranted: SessionSpec = {
      ...granted,
      allowedCalls: granted.allowedCalls.filter(
        (rule) => rule.to?.toLowerCase() !== TOKEN.toLowerCase(),
      ),
    };
    assert.equal(
      halfGranted.spendCaps.some((cap) => cap.token?.toLowerCase() === TOKEN.toLowerCase()),
      true,
      "the cap half must still be present, or the case proves nothing",
    );
    assert.equal(grantsTokenSell(halfGranted, TOKEN), false);
  });

  it("is false for an allowlist entry with no spend limit — the other half", () => {
    const halfGranted: SessionSpec = {
      ...granted,
      spendCaps: granted.spendCaps.filter(
        (cap) => cap.token?.toLowerCase() !== TOKEN.toLowerCase(),
      ),
    };
    assert.equal(grantsTokenSell(halfGranted, TOKEN), false);
  });
});

/* -------------------------------------------------------------------------- */
/* The exit reserve (PHASE2.4 R6)                                             */
/* -------------------------------------------------------------------------- */

describe("checkNativeCapSizing", () => {
  it("holds when the on-chain cap covers budget, fee and one exit", () => {
    const offChainDailyCapWei = 10n ** 16n; // 0.01 BNB
    const result = checkNativeCapSizing({
      onChainDailyCapWei:
        offChainDailyCapWei + offChainDailyCapWei / 100n + RELAY_FEE_PER_EXIT_WEI + 1n,
      offChainDailyCapWei,
      feeBps: 100,
      grantedTokenCount: 1,
    });
    assert.equal(result.ok, true);
  });

  it("REFUSES when the on-chain cap merely equals the requirement", () => {
    // Strictly greater, not greater-or-equal: an agent whose last wei of
    // headroom is exactly the exit reserve has nothing left for the trade.
    const offChainDailyCapWei = 10n ** 16n;
    const result = checkNativeCapSizing({
      onChainDailyCapWei: offChainDailyCapWei + RELAY_FEE_PER_EXIT_WEI,
      offChainDailyCapWei,
      grantedTokenCount: 1,
    });
    assert.equal(result.ok, false);
  });

  it("names all four terms and the shortfall", () => {
    const result = checkNativeCapSizing({
      onChainDailyCapWei: 10n ** 16n,
      offChainDailyCapWei: 10n ** 16n,
      feeBps: 100,
      grantedTokenCount: 2,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    for (const term of ["on-chain cap", "off-chain daily cap", "fee", "exit reserve", "short by"]) {
      assert.match(result.message, new RegExp(term));
    }
  });

  it("scales the reserve with the token count, and never below one exit", () => {
    assert.equal(exitReserveWei(0), RELAY_FEE_PER_EXIT_WEI);
    assert.equal(exitReserveWei(1), RELAY_FEE_PER_EXIT_WEI);
    assert.equal(exitReserveWei(5), 5n * RELAY_FEE_PER_EXIT_WEI);
  });
});

describe("maxOffChainDailyCapWei", () => {
  it("returns the largest budget that satisfies the invariant", () => {
    const onChainDailyCapWei = 10n ** 17n;
    const budget = maxOffChainDailyCapWei({
      onChainDailyCapWei,
      feeBps: 100,
      grantedTokenCount: 3,
    });
    assert.notEqual(budget, null);
    if (budget === null) return;
    assert.equal(
      checkNativeCapSizing({
        onChainDailyCapWei,
        offChainDailyCapWei: budget,
        feeBps: 100,
        grantedTokenCount: 3,
      }).ok,
      true,
    );
    // It errs DOWN, never up: a budget sized as if the fee did not exist must
    // not fit. (The value is the floor of the exact solution, so it can be a
    // wei or two below the true maximum — the safe direction.)
    assert.equal(
      checkNativeCapSizing({
        onChainDailyCapWei,
        offChainDailyCapWei: onChainDailyCapWei - exitReserveWei(3),
        feeBps: 100,
        grantedTokenCount: 3,
      }).ok,
      false,
    );
  });

  it("returns null when the on-chain cap cannot even fund the exits", () => {
    assert.equal(
      maxOffChainDailyCapWei({
        onChainDailyCapWei: RELAY_FEE_PER_EXIT_WEI,
        grantedTokenCount: 1,
      }),
      null,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* resolveTradeConfig                                                         */
/* -------------------------------------------------------------------------- */

const BOOT = { chainId: 56, keyStore: KEY_STORE, nowSeconds: NOW } as const;

describe("resolveExecuteRawEnabled", () => {
  it("defaults to false and only the exact string `true` enables it", () => {
    assert.equal(resolveExecuteRawEnabled({}), false);
    assert.equal(resolveExecuteRawEnabled({ EXECUTE_RAW_ENABLED: "" }), false);
    for (const value of ["1", "yes", "TRUE", "True", "on", "true "]) {
      assert.equal(
        resolveExecuteRawEnabled({ EXECUTE_RAW_ENABLED: value }),
        value.trim() === "true",
        `EXECUTE_RAW_ENABLED=${value}`,
      );
    }
    assert.equal(resolveExecuteRawEnabled({ EXECUTE_RAW_ENABLED: "true" }), true);
  });
});

describe("resolveTradeConfig", () => {
  it("returns the no-fee defaults on an empty environment", () => {
    const config = resolveTradeConfig({}, BOOT);
    assert.equal(config.feeTreasury, undefined);
    assert.equal(config.feeBps, undefined);
    assert.equal(config.feePolicy({ ...FEE_CONTEXT }), null);
    assert.equal(config.scanRequireVerdict, false);
    assert.equal(config.scanTtlSec, 300);
    assert.equal(config.maxSlippageBps, 500);
    assert.equal(config.deadlineSec, 120);
  });

  it("builds a fee policy when both halves are set", () => {
    const config = resolveTradeConfig(
      { FEE_TREASURY_ADDRESS: TREASURY, FEE_BPS: "100" },
      BOOT,
    );
    assert.equal(config.feeTreasury, TREASURY);
    assert.equal(config.feeBps, 100);
    assert.deepEqual(config.feePolicy(FEE_CONTEXT), {
      to: TREASURY,
      value: 10n ** 16n,
    });
  });

  it("refuses half a fee configuration", () => {
    assert.throws(
      () => resolveTradeConfig({ FEE_TREASURY_ADDRESS: TREASURY }, BOOT),
      /must be set together/,
    );
    assert.throws(() => resolveTradeConfig({ FEE_BPS: "100" }, BOOT), /must be set together/);
  });

  it("refuses a fee rate over the ceiling at boot", () => {
    assert.throws(
      () =>
        resolveTradeConfig(
          { FEE_TREASURY_ADDRESS: TREASURY, FEE_BPS: "1000" },
          BOOT,
        ),
      /FEE_BPS/,
    );
  });

  it("REFUSES TO START when the treasury is not in the session template", () => {
    // A fee whose recipient is outside the on-chain allowlist makes every trade
    // revert at the account contract, after the batch has been submitted.
    const templateWithoutTreasury = (input: {
      venues: ReturnType<typeof resolveVenues>;
      tokens: readonly TokenGrant[];
      nativeCaps: readonly SpendCap[];
      expiresAt: number;
      nowSeconds: number;
    }): SessionSpec =>
      tradeSessionSpec({
        venues: input.venues,
        tokens: input.tokens,
        nativeCaps: input.nativeCaps,
        expiresAt: input.expiresAt,
        nowSeconds: input.nowSeconds,
      });

    assert.throws(
      () =>
        resolveTradeConfig(
          { FEE_TREASURY_ADDRESS: TREASURY, FEE_BPS: "100" },
          { ...BOOT, buildTemplate: templateWithoutTreasury },
        ),
      /not granted by the trade session template/,
    );

    // And the real template passes the same check.
    assert.doesNotThrow(() =>
      resolveTradeConfig({ FEE_TREASURY_ADDRESS: TREASURY, FEE_BPS: "100" }, BOOT),
    );
  });

  it("caps SCAN_TTL_SEC at 900", () => {
    assert.equal(resolveTradeConfig({ SCAN_TTL_SEC: "900" }, BOOT).scanTtlSec, 900);
    assert.throws(() => resolveTradeConfig({ SCAN_TTL_SEC: "901" }, BOOT), /SCAN_TTL_SEC/);
  });

  it("caps MAX_SLIPPAGE_BPS at 2000 and refuses zero", () => {
    assert.equal(
      resolveTradeConfig({ MAX_SLIPPAGE_BPS: String(MAX_MAX_SLIPPAGE_BPS) }, BOOT)
        .maxSlippageBps,
      MAX_MAX_SLIPPAGE_BPS,
    );
    for (const value of ["0", "2001", "-5", "abc", "5.5"]) {
      assert.throws(
        () => resolveTradeConfig({ MAX_SLIPPAGE_BPS: value }, BOOT),
        /MAX_SLIPPAGE_BPS/,
      );
    }
  });

  it("bounds TRADE_DEADLINE_SEC", () => {
    assert.throws(() => resolveTradeConfig({ TRADE_DEADLINE_SEC: "0" }, BOOT), /TRADE_DEADLINE_SEC/);
    assert.throws(() => resolveTradeConfig({ TRADE_DEADLINE_SEC: "901" }, BOOT), /TRADE_DEADLINE_SEC/);
  });

  it("reads SCAN_REQUIRE_VERDICT as an explicit opt-in", () => {
    // Anything but the exact string is the permissive default: a typo must not
    // silently switch the money path into refuse-on-outage mode.
    assert.equal(resolveTradeConfig({}, BOOT).scanRequireVerdict, false);
    assert.equal(resolveTradeConfig({ SCAN_REQUIRE_VERDICT: "TRUE" }, BOOT).scanRequireVerdict, false);
    assert.equal(resolveTradeConfig({ SCAN_REQUIRE_VERDICT: "1" }, BOOT).scanRequireVerdict, false);
    assert.equal(resolveTradeConfig({ SCAN_REQUIRE_VERDICT: "true" }, BOOT).scanRequireVerdict, true);
  });

  it("refuses a fee treasury that is the zero address or the KeyStore", () => {
    assert.throws(
      () =>
        resolveTradeConfig(
          { FEE_TREASURY_ADDRESS: zeroAddress, FEE_BPS: "100" },
          BOOT,
        ),
      /zero address/,
    );
    assert.throws(
      () =>
        resolveTradeConfig(
          { FEE_TREASURY_ADDRESS: KEY_STORE, FEE_BPS: "100" },
          BOOT,
        ),
      /key registry/,
    );
  });

  it("passes venue overrides through the same validation", () => {
    assert.throws(
      () => resolveTradeConfig({ VENUE_PANCAKE_ROUTER: "0xdead" }, BOOT),
      /VENUE_PANCAKE_ROUTER/,
    );
    assert.throws(
      () => resolveTradeConfig({ VENUE_FOURMEME_HELPER: "0xdead" }, BOOT),
      /VENUE_FOURMEME_HELPER/,
    );
    const config = resolveTradeConfig({ VENUE_FOURMEME_HELPER: TOKEN }, BOOT);
    assert.equal(config.venues.fourMemeHelper, TOKEN);
  });

  it("validates VENUE_PANCAKE_ROUTER_V3 exactly like the other venue overrides", () => {
    // PHASE2.2. Same three refusals: malformed, zero, the key registry.
    for (const bad of ["0xdead", zeroAddress, KEY_STORE]) {
      assert.throws(
        () => resolveTradeConfig({ VENUE_PANCAKE_ROUTER_V3: bad }, BOOT),
        /VENUE_PANCAKE_ROUTER_V3/,
        `VENUE_PANCAKE_ROUTER_V3=${bad} must abort the boot`,
      );
    }
    assert.equal(
      resolveTradeConfig({ VENUE_PANCAKE_ROUTER_V3: TOKEN }, BOOT).venues
        .pancakeRouterV3,
      TOKEN,
    );
    // Unset on 56 means the verified mainnet deployment, not `undefined`.
    assert.equal(
      resolveTradeConfig({}, BOOT).venues.pancakeRouterV3,
      PANCAKE_V3_ROUTER_56,
    );
    // Chain 97 ships nothing, so `pancake_v3` is a 400 there rather than a guess.
    assert.equal(
      resolveTradeConfig({}, { chainId: 97, keyStore: KEY_STORE, nowSeconds: NOW })
        .venues.pancakeRouterV3,
      undefined,
    );
  });

  it("has no VENUE_FOURMEME_MANAGER override at all", () => {
    // PHASE2.1: the manager comes from the on-chain read, per attempt. An
    // override would look like a way to choose which manager a trade calls, and
    // is not one — so the variable is gone rather than quietly ignored.
    const config = resolveTradeConfig({ VENUE_FOURMEME_MANAGER: TOKEN }, BOOT);
    assert.equal(
      config.venues.fourMemeTokenManager,
      FOUR_MEME_TOKEN_MANAGER_56,
      "a stale VENUE_FOURMEME_MANAGER must not move anything",
    );
  });

  it("defaults MAX_VENUE_FEE_BPS to 300 and validates 1..1000", () => {
    assert.equal(resolveTradeConfig({}, BOOT).maxVenueFeeBps, 300);
    assert.equal(
      resolveTradeConfig({ MAX_VENUE_FEE_BPS: "150" }, BOOT).maxVenueFeeBps,
      150,
    );
    assert.equal(
      resolveTradeConfig({ MAX_VENUE_FEE_BPS: String(MAX_MAX_VENUE_FEE_BPS) }, BOOT)
        .maxVenueFeeBps,
      MAX_MAX_VENUE_FEE_BPS,
    );
    for (const bad of ["0", "-1", String(MAX_MAX_VENUE_FEE_BPS + 1), "1.5", "many"]) {
      assert.throws(
        () => resolveTradeConfig({ MAX_VENUE_FEE_BPS: bad }, BOOT),
        /MAX_VENUE_FEE_BPS/,
        `MAX_VENUE_FEE_BPS=${bad} must abort the boot`,
      );
    }
  });
});
