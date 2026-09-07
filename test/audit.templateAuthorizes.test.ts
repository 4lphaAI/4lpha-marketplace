/**
 * Auditor-written: the session template must AUTHORIZE what the builders emit.
 *
 * Two files decide whether a trade can happen at all, and nothing tied them
 * together. `src/ops/policy.ts` builds the on-chain allowlist the owner signs;
 * `src/ops/pancake*.ts` and `src/ops/fourmeme.ts` build the calls that allowlist
 * has to permit. Every route test runs against a FAKE provider, which never
 * evaluates the policy — so a venue added to the builders and forgotten in the
 * template would pass the whole suite and then fail on-chain for every user,
 * with the owner needing a fresh signature to fix it.
 *
 * The mechanism: run the real `AltanaProvider.executeViaSession` pre-flight over
 * a session carrying the real template. A call the allowlist REFUSES throws
 * `NotAllowedError`; a call it PERMITS gets past the allowlist and dies on the
 * stub handle instead. So "rejects with the handle error" is the proof of
 * authorization, and `NotAllowedError` is the failure this file is watching for.
 *
 * ─── THE PRE-FLIGHT IS HALF THE GRANT (PHASE2.3) ────────────────────────────
 *
 * That mechanism has a blind spot, and the blind spot shipped FINDINGS (h): the
 * pre-flight evaluates the ALLOWLIST ONLY. A session carries two independent
 * grants, and the second one — a spend limit per token — is what a sell's
 * `approve` is metered against on chain. Every sell below passed this file and
 * then failed silently on mainnet (`PENDING`, no tx, no gas) because no cap
 * existed for the token.
 *
 * So the second half of this file checks SPEND, by running the real
 * `validateSessionSpec` / `assertTokenMoversAreCapped` over the emitted spec —
 * NOT by calling `executeViaSession`, which cannot see caps at all. The last
 * case proves the blind spot is still there, so nobody mistakes the pre-flight
 * for the whole check again.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import { BNB_TESTNET } from "@altananetwork/sdk";
import { AltanaProvider } from "../src/wallet/altana.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { validateSessionSpec } from "../src/core/session.js";
import {
  buildPancakeBuy,
  buildPancakeSell,
} from "../src/ops/pancake.js";
import {
  buildPancakeV3Buy,
  buildPancakeV3Sell,
} from "../src/ops/pancakeV3.js";
import {
  buildFourMemeBuy,
  buildFourMemeSell,
} from "../src/ops/fourmeme.js";
import { createBpsFeePolicy } from "../src/ops/fees.js";
import type { SessionRef, SessionSpec, WalletCall } from "../src/core/types.js";
import type { VenueConfig } from "../src/ops/venues.js";
import type { TradeRoute } from "../src/ops/route.js";

const ROUTER_V2 = getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E");
const ROUTER_V3 = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const MANAGER = getAddress("0x5c952063c7fc8610FFDB798152D69F0B9550762b");
const TREASURY = getAddress("0x7e41F09dF5cb1Ec9323bC101D3a9e65bE4e510AD");
const TOKEN = getAddress("0x0000000000000000000000000000000000000abc");
const HOP = getAddress("0x55d398326f99059fF775485246999027B3197955");
const WALLET = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");

const NOW = Math.floor(Date.now() / 1000);
const DEADLINE = BigInt(NOW + 120);

const VENUES: VenueConfig = {
  chainId: BNB_TESTNET.chainId,
  pancakeRouterV2: ROUTER_V2,
  pancakeRouterV3: ROUTER_V3,
  wbnb: WBNB,
  fourMemeTokenManager: MANAGER,
};

const provider = new AltanaProvider({ network: BNB_TESTNET });

/** The token universe a hire would name. Both are traded below. */
const GRANTED_TOKENS = [{ token: TOKEN }, { token: HOP }] as const;

/** The REAL template the marketplace would grant. */
function templateSpec(): SessionSpec {
  return tradeSessionSpec({
    venues: VENUES,
    treasury: TREASURY,
    tokens: GRANTED_TOKENS,
    nativeCaps: [{ limit: 10n ** 18n, period: "day" }],
    expiresAt: NOW + 3_600,
    nowSeconds: NOW,
  });
}

/** A session carrying the REAL template the marketplace would grant. */
function templateSession(): SessionRef {
  return {
    walletAddress: WALLET,
    chainId: BNB_TESTNET.chainId,
    publicKey: "0xabc",
    spec: templateSpec(),
    // Deliberately not a real handle: a call that clears the allowlist dies
    // here, which is exactly the signal this file reads.
    handle: {},
  };
}

/**
 * Assert the template PERMITS every call in the batch.
 *
 * `NotAllowedError` here means the on-chain grant would refuse the trade — the
 * failure mode this file exists to catch, and one that costs an owner signature
 * to repair once agents are live.
 */
async function assertAuthorized(
  label: string,
  calls: readonly WalletCall[],
): Promise<void> {
  await assert.rejects(
    provider.executeViaSession({ session: templateSession(), calls }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(
        error.name,
        "NotAllowedError",
        `${label}: the trade session template does NOT authorize these calls — ` +
          `the on-chain grant would refuse this trade`,
      );
      return /Session handle was not created by this provider/.test(error.message);
    },
    label,
  );
}

const fee = createBpsFeePolicy({ treasury: TREASURY, bps: 100 });
const feeCall = fee({
  agentId: "a",
  venue: "pancake",
  side: "buy",
  token: TOKEN,
  nativeInWei: 10n ** 16n,
});

describe("audit: the trade template authorizes every builder's output", () => {
  it("pancake V2 — buy and sell, direct and via a hop", async () => {
    const common = {
      router: ROUTER_V2,
      wbnb: WBNB,
      token: TOKEN,
      minOutWei: 1n,
      recipient: WALLET,
      deadline: DEADLINE,
    };
    for (const hops of [[] as Address[], [HOP]]) {
      await assertAuthorized(
        `v2 buy hops=${hops.length}`,
        buildPancakeBuy({ ...common, amountInWei: 10n ** 16n, hops }),
      );
      await assertAuthorized(
        `v2 sell hops=${hops.length}`,
        buildPancakeSell({ ...common, amountInWei: 500n, hops }),
      );
    }
  });

  it("pancake V3 — buy and sell, one pool and two", async () => {
    const common = {
      router: ROUTER_V3,
      wbnb: WBNB,
      token: TOKEN,
      minOutWei: 1n,
      recipient: WALLET,
      deadline: DEADLINE,
    };
    const routes = [
      { hops: [] as Address[], fees: [2500] },
      { hops: [HOP], fees: [500, 10_000] },
    ] as const satisfies readonly TradeRoute[];
    for (const route of routes) {
      await assertAuthorized(
        `v3 buy pools=${route.fees.length}`,
        buildPancakeV3Buy({ ...common, amountInWei: 10n ** 16n, route }),
      );
      await assertAuthorized(
        `v3 sell pools=${route.fees.length}`,
        buildPancakeV3Sell({ ...common, amountInWei: 500n, route }),
      );
    }
  });

  it("four.meme — buy and sell", async () => {
    await assertAuthorized(
      "fourmeme buy",
      buildFourMemeBuy({
        manager: MANAGER,
        token: TOKEN,
        fundsWei: 10n ** 16n,
        msgValueWei: 10n ** 16n + 10n ** 14n,
        minTokensOut: 1n,
      }),
    );
    await assertAuthorized(
      "fourmeme sell",
      buildFourMemeSell({
        manager: MANAGER,
        token: TOKEN,
        amountWei: 500n,
        minFundsOut: 1n,
      }),
    );
  });

  it("the platform fee transfer is authorized alongside a swap", async () => {
    assert.ok(feeCall !== null, "a 100bps fee on 0.01 BNB must produce a call");
    await assertAuthorized("v3 buy + fee", [
      ...buildPancakeV3Buy({
        router: ROUTER_V3,
        wbnb: WBNB,
        token: TOKEN,
        amountInWei: 10n ** 16n,
        minOutWei: 1n,
        recipient: WALLET,
        deadline: DEADLINE,
        route: { hops: [], fees: [2500] },
      }),
      feeCall,
    ]);
  });

  it("a template granted BEFORE V3 refuses a V3 trade, locally", async () => {
    // This is the teeth of the file. If `assertAuthorized` were passing because
    // the allowlist had stopped being consulted, this case would pass too — and
    // it must not. It is also the R11 scenario in miniature: a session granted
    // before the V3 router entered the template cannot reach it, and the refusal
    // happens HERE, before a relay round trip is spent on it.
    const { pancakeRouterV3: _dropped, ...withoutV3 } = VENUES;
    const stale: SessionRef = {
      walletAddress: WALLET,
      chainId: BNB_TESTNET.chainId,
      publicKey: "0xabc",
      spec: tradeSessionSpec({
        venues: withoutV3,
        treasury: TREASURY,
        tokens: GRANTED_TOKENS,
        nativeCaps: [{ limit: 10n ** 18n, period: "day" }],
        expiresAt: NOW + 3_600,
        nowSeconds: NOW,
      }),
      handle: {},
    };
    await assert.rejects(
      provider.executeViaSession({
        session: stale,
        calls: buildPancakeV3Buy({
          router: ROUTER_V3,
          wbnb: WBNB,
          token: TOKEN,
          amountInWei: 10n ** 16n,
          minOutWei: 1n,
          recipient: WALLET,
          deadline: DEADLINE,
          route: { hops: [], fees: [2500] },
        }),
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
  });

  it("and still refuses a target the template never granted", async () => {
    // The counterweight: if `assertAuthorized` passed because the pre-flight had
    // stopped checking, this would pass too. It must not.
    await assert.rejects(
      provider.executeViaSession({
        session: templateSession(),
        calls: [{ to: getAddress("0x00000000000000000000000000000000deadbeef"), value: 1n }],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The other half of the grant: SPEND (PHASE2.3)                              */
/* -------------------------------------------------------------------------- */

describe("audit: the trade template METERS the sell it authorizes", () => {
  it("grants an approve rule AND a spend cap for every token", () => {
    // The pair is the fix for FINDINGS (h). The allowlist half alone is what
    // the pre-flight above sees, and it is not enough: on chain
    // `GuardedExecutor` counts a sell's `approve` as spending that token and
    // needs a limit for it to decrement.
    const spec = templateSpec();
    for (const { token } of GRANTED_TOKENS) {
      assert.ok(
        spec.allowedCalls.some(
          (rule) => rule.to === token && rule.selector === "approve(address,uint256)",
        ),
        `${token} has no approve rule — the sell's approve would be NOT_ALLOWED`,
      );
      assert.ok(
        spec.spendCaps.some((cap) => cap.token === token),
        `${token} has no spend cap — the sell would return PENDING with no tx`,
      );
    }
  });

  it("validates clean under the real guard, caps included", () => {
    // `validateSessionSpec` runs `assertTokenMoversAreCapped`, the guard that
    // refuses an approve rule whose token has no cap. Running it HERE is what
    // makes this file check spend rather than only the allowlist.
    assert.doesNotThrow(() => validateSessionSpec(templateSpec(), { nowSeconds: NOW }));
  });

  it("REFUSES a hand-built spec that grants approve without the cap", () => {
    // The (h) shape, built by hand because the template can no longer emit it.
    const spec = templateSpec();
    const uncapped: SessionSpec = {
      allowedCalls: spec.allowedCalls,
      spendCaps: spec.spendCaps.filter((cap) => cap.token === undefined),
      expiresAt: spec.expiresAt,
    };
    assert.throws(
      () => validateSessionSpec(uncapped, { nowSeconds: NOW }),
      /no entry for that token/i,
    );
  });

  it("REFUSES the old bare-selector approve outright", () => {
    // What the template used to emit, flag and all. R2 makes it an error rather
    // than a silent skip.
    const spec = templateSpec();
    assert.throws(
      () =>
        validateSessionSpec(
          {
            allowedCalls: [...spec.allowedCalls, { selector: "approve(address,uint256)" }],
            spendCaps: spec.spendCaps,
            expiresAt: spec.expiresAt,
            allowUnrestrictedSelector: true,
          },
          { nowSeconds: NOW },
        ),
      /EVERY contract on the chain, so no spend cap can bound it/,
    );
  });

  it("the PRE-FLIGHT alone would have passed the un-sellable session", async () => {
    // Why this second half exists, pinned. The uncapped spec above is the exact
    // session that shipped and could not sell — and `executeViaSession` waves
    // its sell batch straight through, because the pre-flight evaluates the
    // allowlist and never the caps. Anyone tempted to treat the pre-flight as
    // the whole check should fail this test first.
    const spec = templateSpec();
    const uncapped: SessionSpec = {
      allowedCalls: spec.allowedCalls,
      spendCaps: spec.spendCaps.filter((cap) => cap.token === undefined),
      expiresAt: spec.expiresAt,
    };
    await assert.rejects(
      provider.executeViaSession({
        session: {
          walletAddress: WALLET,
          chainId: BNB_TESTNET.chainId,
          publicKey: "0xabc",
          spec: uncapped,
          handle: {},
        },
        calls: buildPancakeSell({
          router: ROUTER_V2,
          wbnb: WBNB,
          token: TOKEN,
          amountInWei: 500n,
          minOutWei: 1n,
          recipient: WALLET,
          deadline: DEADLINE,
          hops: [],
        }),
      }),
      /Session handle was not created by this provider/,
      "the pre-flight is expected to be blind to spend caps; if this ever starts throwing NotAllowedError, the comment above is stale",
    );
  });

  it("the sell batch approves an EXACT amount, never a max approve", () => {
    // R4's invariant, checked against the calldata the builders emit. A
    // max/unlimited approve is metered at `type(uint256).max` and would exhaust
    // any finite token cap in one call — the trap this phase removes.
    const amount = 123_456_789n;
    for (const calls of [
      buildPancakeSell({
        router: ROUTER_V2,
        wbnb: WBNB,
        token: TOKEN,
        amountInWei: amount,
        minOutWei: 1n,
        recipient: WALLET,
        deadline: DEADLINE,
        hops: [],
      }),
      buildPancakeV3Sell({
        router: ROUTER_V3,
        wbnb: WBNB,
        token: TOKEN,
        amountInWei: amount,
        minOutWei: 1n,
        recipient: WALLET,
        deadline: DEADLINE,
        route: { hops: [], fees: [2500] },
      }),
      buildFourMemeSell({
        manager: MANAGER,
        token: TOKEN,
        amountWei: amount,
        minFundsOut: 1n,
      }),
    ]) {
      const amounts: bigint[] = [];
      for (const { to, data } of calls) {
        if (to !== TOKEN || data === undefined) continue;
        if (!data.startsWith("0x095ea7b3")) continue;
        // 4-byte selector + a 32-byte spender word, then the amount word.
        amounts.push(BigInt(`0x${data.slice(10 + 64)}`));
      }
      // `approve(0)` then `approve(amount)` — the USDT-style reset, FINDINGS (j).
      assert.equal(amounts.length, 2);
      assert.deepEqual(amounts, [0n, amount]);
      assert.ok(
        amounts.every((value) => value !== 2n ** 256n - 1n),
        "a max approve would silently exhaust a finite per-token cap",
      );
    }
  });
});
