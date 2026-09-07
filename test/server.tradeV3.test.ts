/**
 * `POST /agents/:id/trade` for PancakeSwap V3 and caller-supplied routes.
 *
 * Same offline harness as `server.trade.test.ts`. The questions here are the
 * ones PHASE2.2's review said would be got subtly wrong: does the native
 * accounting still add up when a second venue shape exists, does the sell still
 * unwrap to the ROW's wallet, is the resolved V3 router really bound into the
 * trade's identity, and does a session granted before V3 existed fail LOCALLY
 * rather than at the relay.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import { BNB_TESTNET } from "@altananetwork/sdk";
import {
  AGENT_ID,
  HOP,
  HOP_2,
  MANAGER,
  OWNER_ADDRESS,
  ROUTER,
  ROUTER_V3,
  TOKEN,
  TREASURY,
  WBNB,
  call,
  createHarness,
  errorCode,
  safeSecurityPayload,
  tradeBody,
  tradeConfig,
  type Harness,
} from "./support/serverHarness.js";
import { createBpsFeePolicy, type FeeContext } from "../src/ops/fees.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { resolveVenues } from "../src/ops/venues.js";
import { AltanaProvider } from "../src/wallet/altana.js";
import type { SessionRef, WalletCall } from "../src/core/types.js";

const ONE_BNB = 10n ** 18n;

async function tradingHarness(
  options: Parameters<typeof createHarness>[0] = {},
): Promise<Harness> {
  const harness = await createHarness(options);
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  return harness;
}

function meta(body: Record<string, unknown>): Record<string, unknown> {
  const value = body["meta"];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** A V3 trade body. One pool at 2500 bps unless the test says otherwise. */
function v3Body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return tradeBody({
    venue: "pancake_v3",
    route: { fees: [2500] },
    ...overrides,
  });
}

function totalValue(calls: readonly WalletCall[]): bigint {
  return calls.reduce((sum, c) => sum + (c.value ?? 0n), 0n);
}

const FEE_TRADE = tradeConfig({
  feePolicy: createBpsFeePolicy({ treasury: TREASURY, bps: 100 }),
  feeTreasury: TREASURY,
  feeBps: 100,
});

/* -------------------------------------------------------------------------- */
/* The V3 buy                                                                 */
/* -------------------------------------------------------------------------- */

describe("POST /agents/:id/trade: pancake_v3 buy", () => {
  it("submits ONE multicall to the V3 router with value = amountWei", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body({ amountWei: ONE_BNB.toString(10) }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.executeCalls.length, 1);
    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    assert.equal(submitted.calls.length, 1, "the whole V3 buy is one call");
    const swap = submitted.calls[0];
    assert.ok(swap !== undefined);
    assert.equal(swap.to, ROUTER_V3, "the V2 router must not be involved");
    assert.equal(swap.value, ONE_BNB);
    assert.ok(swap.data?.startsWith("0xac9650d8"), "multicall(bytes[])");
    // The recipient word is the agent's wallet, from the persisted row.
    assert.match(swap.data ?? "0x", new RegExp(OWNER_ADDRESS.slice(2).toLowerCase()));
    assert.equal(submitted.bypassLocalPolicyCheck, false);
  });

  it("journals amountWei + feeWei while the swap value stays amountWei", async () => {
    const harness = await tradingHarness({ config: { trade: FEE_TRADE } });
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body({ amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(res.status, 200, res.text);

    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    assert.equal(submitted.calls.length, 2, "swap + the treasury transfer");
    assert.equal(submitted.calls[0]?.value, ONE_BNB, "the fee is ON TOP");
    assert.equal(submitted.calls[1]?.to, TREASURY);
    assert.equal(submitted.calls[1]?.value, ONE_BNB / 100n);

    const row = await harness.journal.get(meta(res.body)["idempotencyKey"] as string);
    assert.equal(row?.nativeSpendWei, ONE_BNB + ONE_BNB / 100n);
  });

  it("routes a buy through the caller's hop", async () => {
    const harness = await tradingHarness();
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body({ route: { hops: [HOP], fees: [500, 10000] } }),
    });
    const data = harness.provider.executeCalls[0]?.calls[0]?.data ?? "";
    // exactInput, and the packed path is WBNB -500- HOP -10000- TOKEN.
    assert.ok(data.includes("c04b8d59"), "two pools must use exactInput");
    assert.ok(
      data.includes(
        `${WBNB.slice(2).toLowerCase()}0001f4${HOP.slice(2).toLowerCase()}002710${TOKEN.slice(2).toLowerCase()}`,
      ),
      "the packed path must be the one the caller described",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The V3 sell                                                                */
/* -------------------------------------------------------------------------- */

describe("POST /agents/:id/trade: pancake_v3 sell", () => {
  it("submits [approve(0), approve(amount), multicall] with no native value", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body({ side: "sell", amountWei: "5000" }),
    });
    assert.equal(res.status, 200, res.text);

    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    assert.equal(submitted.calls.length, 3);
    assert.deepEqual(submitted.calls.map((c) => c.to), [TOKEN, TOKEN, ROUTER_V3]);
    assert.equal(totalValue(submitted.calls), 0n, "a sell sends no native value");

    const row = await harness.journal.get(meta(res.body)["idempotencyKey"] as string);
    assert.equal(row?.nativeSpendWei, 0n);
  });

  it("unwraps to the ROW's wallet, and no request field can change that", async () => {
    const attacker = getAddress("0x00000000000000000000000000000000BadBad02");
    const harness = await tradingHarness();
    const injections: Array<Record<string, unknown>> = [
      { recipient: attacker },
      { to: attacker },
      { walletAddress: attacker },
      { route: { fees: [2500], recipient: attacker } },
      { route: { fees: [2500], unwrapTo: attacker } },
    ];
    for (const [index, extra] of injections.entries()) {
      await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: v3Body({
          decisionId: `d-v3-sell-${index}`,
          side: "sell",
          amountWei: "5000",
          ...extra,
        }),
      });
    }

    assert.ok(harness.provider.executeCalls.length > 0);
    for (const submitted of harness.provider.executeCalls) {
      const multicall = submitted.calls[2]?.data ?? "";
      // unwrapWETH9(amountMinimum, recipient): the recipient is its second word.
      const unwrap = multicall.indexOf("49404b7c");
      assert.ok(unwrap > 0, "the sell MUST unwrap");
      assert.equal(
        multicall.slice(unwrap + 8 + 64, unwrap + 8 + 128),
        OWNER_ADDRESS.slice(2).toLowerCase().padStart(64, "0"),
        "unwrapWETH9's recipient is the row's wallet",
      );
      assert.ok(!multicall.includes(attacker.slice(2).toLowerCase()));
    }
  });

  it("approves only the V3 router, for the exact amount", async () => {
    const harness = await tradingHarness();
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body({ side: "sell", amountWei: "5000" }),
    });
    for (const c of harness.provider.executeCalls[0]?.calls ?? []) {
      if (!c.data?.startsWith("0x095ea7b3")) continue;
      assert.equal(`0x${c.data.slice(34, 74)}`, ROUTER_V3.toLowerCase());
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The value invariant (PHASE2.2 R8)                                          */
/* -------------------------------------------------------------------------- */

describe("the native-value invariant, across every venue and side", () => {
  it("sum(call.value) equals the journalled nativeSpendWei for each combination", async () => {
    // `SwapRouter.pay()` wraps native only when `token == WETH9 && balance >=
    // value`; otherwise it falls through to a `transferFrom` of WBNB. So a buy
    // whose attached value is one wei short silently stops being a native buy
    // and becomes a different trade, journalled as if native had moved. The
    // journalled figure IS the one the rule engine and the daily cap saw.
    const combinations: Array<readonly [string, string, Record<string, unknown>]> = [
      ["pancake", "buy", {}],
      ["pancake", "sell", { amountWei: "5000" }],
      ["pancake_v3", "buy", { route: { fees: [2500] } }],
      ["pancake_v3", "sell", { amountWei: "5000", route: { fees: [2500] } }],
      ["fourmeme", "buy", {}],
      ["fourmeme", "sell", { amountWei: "5000" }],
    ];

    for (const [venue, side, extra] of combinations) {
      const label = `${venue}/${side}`;
      const harness = await tradingHarness({ config: { trade: FEE_TRADE } });
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ venue, side, ...extra }),
      });
      assert.equal(res.status, 200, `${label}: ${res.text}`);
      const submitted = harness.provider.executeCalls[0];
      assert.ok(submitted !== undefined, label);
      const row = await harness.journal.get(meta(res.body)["idempotencyKey"] as string);
      assert.ok(row !== null, label);
      assert.equal(
        totalValue(submitted.calls),
        row.nativeSpendWei,
        `${label}: the batch's native value must equal what the caps counted`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The fee seam (PHASE2.2 R9)                                                 */
/* -------------------------------------------------------------------------- */

describe("the fee policy sees the V3 venue", () => {
  it("is invoked with venue pancake_v3 and the PRE-fee nativeInWei", async () => {
    const seen: FeeContext[] = [];
    const harness = await tradingHarness({
      config: {
        trade: tradeConfig({
          feePolicy: (context) => {
            seen.push(context);
            return null;
          },
        }),
      },
    });
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body({ amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.venue, "pancake_v3");
    assert.equal(seen[0]?.side, "buy");
    assert.equal(
      seen[0]?.nativeInWei,
      ONE_BNB,
      "the fee is never computed on a quantity that already contains a fee",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Identity: the router and the route are bound (PHASE2.2 R7)                 */
/* -------------------------------------------------------------------------- */

describe("paramsHash binds the V3 router and the route", () => {
  it("409s when VENUE_PANCAKE_ROUTER_V3 changes between submit and retry", async () => {
    const body = v3Body();
    const first = await tradingHarness();
    await call(first, `/agents/${AGENT_ID}/trade`, { method: "POST", body });
    const priorRow = await first.journal.getByDecision(AGENT_ID, "d-trade-1");
    assert.ok(priorRow !== null);

    const moved = await tradingHarness({
      config: {
        trade: tradeConfig({
          venues: {
            chainId: 97,
            pancakeRouterV2: ROUTER,
            pancakeRouterV3: getAddress("0x0000000000000000000000000000000000009999"),
            wbnb: WBNB,
            fourMemeTokenManager: MANAGER,
          },
        }),
      },
    });
    await moved.journal.begin({
      idempotencyKey: priorRow.idempotencyKey,
      agentId: priorRow.agentId,
      ownerAddress: priorRow.ownerAddress,
      kind: "trade",
      decisionId: "d-trade-1",
      externalRef: priorRow.externalRef,
      nativeSpendWei: priorRow.nativeSpendWei,
    });

    const retry = await call(moved, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body,
    });
    assert.equal(retry.status, 409, retry.text);
    assert.equal(moved.provider.executeCalls.length, 0);
  });

  it("treats absent, {} and {hops:[]} as ONE trade on V2", async () => {
    // `canonicalEncode` omits `undefined` but encodes `[]` as `[]`, so without
    // normalization these are three hashes for one trade — and the second
    // attempt of a benign retry 409s.
    const harness = await tradingHarness();
    const shapes: Array<Record<string, unknown>> = [
      {},
      { route: {} },
      { route: { hops: [] } },
    ];
    const statuses: number[] = [];
    for (const shape of shapes) {
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ decisionId: "d-same", ...shape }),
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 200], "no spelling may 409 the others");
    assert.equal(
      harness.provider.executeCalls.length,
      1,
      "the retries must replay, never submit again",
    );
  });

  it("409s the same decision down a different route", async () => {
    // Two trades with the same amounts down different routes ARE different
    // trades. Both directions matter: different hops, and different tiers.
    const differentHops = await tradingHarness();
    await call(differentHops, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-r", route: { hops: [HOP] } }),
    });
    const hopChanged = await call(differentHops, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-r", route: { hops: [HOP_2] } }),
    });
    assert.equal(hopChanged.status, 409, hopChanged.text);
    assert.equal(differentHops.provider.executeCalls.length, 1);

    const differentFees = await tradingHarness();
    await call(differentFees, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body({ decisionId: "d-f", route: { hops: [HOP], fees: [500, 2500] } }),
    });
    const feeChanged = await call(differentFees, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body({ decisionId: "d-f", route: { hops: [HOP], fees: [2500, 500] } }),
    });
    assert.equal(feeChanged.status, 409, feeChanged.text);
    assert.equal(differentFees.provider.executeCalls.length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The venue gate (PHASE2.2 R6)                                               */
/* -------------------------------------------------------------------------- */

describe("the pancake_v3 venue gate", () => {
  it("400s when the chain has no V3 router, and reads nothing", async () => {
    const harness = await tradingHarness({
      config: {
        trade: tradeConfig({
          venues: { chainId: 97, pancakeRouterV2: ROUTER, wbnb: WBNB },
        }),
      },
    });
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body(),
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(errorCode(res.body), "invalid_request");
    assert.equal(harness.provider.executeCalls.length, 0);
    assert.deepEqual(harness.dataPlane.requested, []);
  });

  it("400s when the router is configured but WBNB is not", async () => {
    // Every V3 path begins or ends at WBNB and the two are independently
    // optional; without this the route would build a path through `undefined`.
    const harness = await tradingHarness({
      config: {
        trade: tradeConfig({
          venues: { chainId: 97, pancakeRouterV3: ROUTER_V3 },
        }),
      },
    });
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: v3Body(),
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(harness.provider.executeCalls.length, 0);
    assert.deepEqual(harness.dataPlane.requested, []);
  });
});

/* -------------------------------------------------------------------------- */
/* Session timing (PHASE2.2 R11)                                              */
/* -------------------------------------------------------------------------- */

describe("a session granted before V3 existed", () => {
  const provider = new AltanaProvider({ network: BNB_TESTNET });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const venues = resolveVenues({ chainId: 56 });
  const routerV3 = venues.pancakeRouterV3;
  assert.ok(routerV3 !== undefined);

  function sessionRef(input: { readonly withV3: boolean }): SessionRef {
    const spec = tradeSessionSpec({
      venues: input.withV3
        ? venues
        : {
            chainId: 56,
            ...(venues.pancakeRouterV2 === undefined
              ? {}
              : { pancakeRouterV2: venues.pancakeRouterV2 }),
            ...(venues.wbnb === undefined ? {} : { wbnb: venues.wbnb }),
            ...(venues.fourMemeTokenManager === undefined
              ? {}
              : { fourMemeTokenManager: venues.fourMemeTokenManager }),
          },
      // No tokens: this case is about the ROUTER being in the allowlist, and
      // the pre-flight it exercises never reads spend caps anyway.
      tokens: [],
      nativeCaps: [{ limit: 10n ** 18n, period: "day" }],
      expiresAt: nowSeconds + 3_600,
      nowSeconds,
    });
    return {
      walletAddress: getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4"),
      chainId: BNB_TESTNET.chainId,
      publicKey: "0xabc",
      spec,
      // Deliberately not a real handle: reaching submission is the marker for
      // "the pre-flight let it through", and it fails here rather than at a relay.
      handle: {},
    };
  }

  const v3Call = { to: routerV3 as Address, data: `0xac9650d8${"00".repeat(32)}` as const };

  it("is rejected LOCALLY, before the relay sees the V3 call", async () => {
    // A persisted `sessionFacts.spec` is never rewritten, so an agent hired
    // before this phase carries an allowlist without the V3 router. The cost is
    // bounded by MAX_TRADE_SESSION_SECONDS (7 days), not permanent — but until the
    // session turns over, the call must fail free rather than at the relay.
    await assert.rejects(
      provider.executeViaSession({ session: sessionRef({ withV3: false }), calls: [v3Call] }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
  });

  it("passes the pre-flight once the template grants the V3 router", async () => {
    await assert.rejects(
      provider.executeViaSession({ session: sessionRef({ withV3: true }), calls: [v3Call] }),
      /Session handle was not created by this provider/,
    );
  });
});
