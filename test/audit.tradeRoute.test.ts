/**
 * Adversarial pass over the caller-supplied `route` (PHASE2.2).
 *
 * `route` is the second thing a caller gets to put addresses into, after
 * `token`, and this server then builds a swap PATH through them. So every
 * question here is a variant of: can a body reach a pool, an address, or a
 * calldata shape that the validator did not think it was authorizing — and does
 * anything at all get submitted before it is refused.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress, type Address } from "viem";
import {
  AGENT_ID,
  HOP,
  KEY_STORE,
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
import { createBpsFeePolicy } from "../src/ops/fees.js";
import { MAX_ROUTE_HOPS } from "../src/ops/route.js";

async function tradingHarness(
  options: Parameters<typeof createHarness>[0] = {},
): Promise<Harness> {
  const harness = await createHarness(options);
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  return harness;
}

const FEE_TRADE = tradeConfig({
  feePolicy: createBpsFeePolicy({ treasury: TREASURY, bps: 100 }),
  feeTreasury: TREASURY,
  feeBps: 100,
});

/** Every refusal in this file must be a 400 that submitted and read nothing. */
async function expectRefused(
  harness: Harness,
  body: Record<string, unknown>,
  label: string,
): Promise<void> {
  const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
    method: "POST",
    body,
  });
  assert.equal(res.status, 400, `${label} → ${res.status} ${res.text}`);
  assert.equal(errorCode(res.body), "invalid_request", label);
  assert.equal(harness.provider.executeCalls.length, 0, label);
  assert.deepEqual(harness.dataPlane.requested, [], `${label}: read before refusing`);
}

describe("AUDIT: route shape", () => {
  it("refuses every non-object route", async () => {
    const harness = await tradingHarness();
    const hostile: unknown[] = [
      [],
      ["0x"],
      "hops",
      42,
      true,
      // The classic array-like: `Array.isArray` says no, so it must not be
      // walked as if it were a list of hops.
      { hops: { 0: HOP, length: 1 } },
      { hops: HOP },
      { hops: "0x" },
      { fees: 2500 },
      { fees: "2500" },
    ];
    for (const [index, route] of hostile.entries()) {
      await expectRefused(
        harness,
        tradeBody({ decisionId: `d-shape-${index}`, route }),
        `route=${JSON.stringify(route)}`,
      );
    }
  });

  it("refuses every fee tier that is not an exact member of the closed set", async () => {
    const harness = await tradingHarness();
    const hostile: unknown[][] = [
      ["2500"],
      [2500.5],
      [2501],
      [0],
      [-2500],
      [null],
      [true],
      [[2500]],
      [{ fee: 2500 }],
      [2500, "500"],
      // A safe-integer that is not a tier, and one that is not safe at all.
      [1_000_000],
      [Number.MAX_SAFE_INTEGER],
    ];
    for (const [index, fees] of hostile.entries()) {
      await expectRefused(
        harness,
        tradeBody({
          decisionId: `d-fee-${index}`,
          venue: "pancake_v3",
          route: { fees },
        }),
        `fees=${JSON.stringify(fees)}`,
      );
    }
  });

  it("bounds hops and fees BEFORE iterating them", async () => {
    const harness = await tradingHarness();
    const extra = Array.from({ length: MAX_ROUTE_HOPS + 1 }, (_, i) =>
      getAddress(`0x${(i + 0xa1).toString(16).padStart(40, "0")}`),
    );
    await expectRefused(
      harness,
      tradeBody({ decisionId: "d-hops", route: { hops: extra } }),
      "more hops than the ceiling",
    );
    await expectRefused(
      harness,
      tradeBody({
        decisionId: "d-fees",
        venue: "pancake_v3",
        route: { hops: [HOP], fees: [100, 500, 2500, 10000] },
      }),
      "more fees than the ceiling",
    );
    // A hostile length that would be work if it were trusted. It is refused on
    // the length alone — no address is parsed, no duplicate scan is run — which
    // is why the check precedes the loop rather than living inside it.
    await expectRefused(
      harness,
      tradeBody({
        decisionId: "d-huge",
        route: { hops: new Array(100).fill(HOP) as unknown[] },
      }),
      "a hundred hops",
    );
  });
});

describe("AUDIT: which venues may carry a route", () => {
  it("refuses a route on fourmeme, INCLUDING an empty one", async () => {
    // PHASE2.2 R3. Accepting and ignoring it is bad twice over: the caller
    // believes it routed somewhere it did not, and `route` folds into
    // `paramsHash`, so the ignored field still changes the trade's identity and
    // 409s an honest retry.
    const harness = await tradingHarness();
    for (const [index, route] of [{}, { hops: [] }, { hops: [HOP] }, { fees: [2500] }].entries()) {
      await expectRefused(
        harness,
        tradeBody({ decisionId: `d-fm-${index}`, venue: "fourmeme", route }),
        `fourmeme + ${JSON.stringify(route)}`,
      );
    }
  });

  it("refuses fee tiers on V2, where they mean nothing", async () => {
    const harness = await tradingHarness();
    await expectRefused(
      harness,
      tradeBody({ route: { fees: [2500] } }),
      "pancake + fees",
    );
    await expectRefused(
      harness,
      tradeBody({ decisionId: "d-v2f", route: { hops: [HOP], fees: [500, 2500] } }),
      "pancake + hops + fees",
    );
  });

  it("requires fees on pancake_v3, with exactly one per pool", async () => {
    // There is no default tier. Picking one is routing, and this service does
    // not route.
    const harness = await tradingHarness();
    await expectRefused(
      harness,
      tradeBody({ decisionId: "d-nf-1", venue: "pancake_v3" }),
      "pancake_v3 with no route at all",
    );
    await expectRefused(
      harness,
      tradeBody({ decisionId: "d-nf-2", venue: "pancake_v3", route: {} }),
      "pancake_v3 with an empty route",
    );
    await expectRefused(
      harness,
      tradeBody({ decisionId: "d-nf-3", venue: "pancake_v3", route: { fees: [] } }),
      "pancake_v3 with no tiers",
    );
    await expectRefused(
      harness,
      tradeBody({
        decisionId: "d-nf-4",
        venue: "pancake_v3",
        route: { hops: [HOP], fees: [2500] },
      }),
      "one tier for two pools",
    );
    await expectRefused(
      harness,
      tradeBody({
        decisionId: "d-nf-5",
        venue: "pancake_v3",
        route: { fees: [500, 2500] },
      }),
      "two tiers for one pool",
    );
  });
});

describe("AUDIT: the hop blacklist", () => {
  it("400s each forbidden hop, and the provider is never called", async () => {
    // Same set `token` runs, for the same reason: a hop is an address this
    // server then builds a swap path through. The agent's own wallet and the
    // KeyStore are the escalation the blacklist exists for; WBNB is already the
    // implicit first leg, so naming it again is a malformed path.
    const forbidden: Array<readonly [string, Address]> = [
      ["the agent wallet", OWNER_ADDRESS],
      ["the KeyStore", KEY_STORE],
      ["the V2 router", ROUTER],
      ["the V3 router", ROUTER_V3],
      ["WBNB", WBNB],
      ["the four.meme manager", MANAGER],
      ["the fee treasury", TREASURY],
      ["the zero address", getAddress(zeroAddress)],
    ];
    for (const [label, hop] of forbidden) {
      const harness = await tradingHarness({ config: { trade: FEE_TRADE } });
      await expectRefused(harness, tradeBody({ route: { hops: [hop] } }), label);
      // And in any casing, on either side, on either routable venue.
      const lower = await tradingHarness({ config: { trade: FEE_TRADE } });
      await expectRefused(
        lower,
        tradeBody({
          venue: "pancake_v3",
          side: "sell",
          amountWei: "5000",
          route: { hops: [hop.toLowerCase()], fees: [500, 2500] },
        }),
        `${label} (lowercased, V3 sell)`,
      );
    }
  });

  it("refuses a hop equal to the traded token, and a repeated hop", async () => {
    const harness = await tradingHarness();
    await expectRefused(
      harness,
      tradeBody({ decisionId: "d-self", route: { hops: [TOKEN] } }),
      "a hop equal to token",
    );
    await expectRefused(
      harness,
      tradeBody({ decisionId: "d-self-l", route: { hops: [TOKEN.toLowerCase()] } }),
      "a hop equal to token, lowercased",
    );
    await expectRefused(
      harness,
      tradeBody({ decisionId: "d-dup", route: { hops: [HOP, HOP] } }),
      "a repeated hop",
    );
    await expectRefused(
      harness,
      tradeBody({ decisionId: "d-dup-l", route: { hops: [HOP, HOP.toLowerCase()] } }),
      "a repeated hop in a different casing",
    );
  });

  it("refuses every non-address hop shape", async () => {
    const harness = await tradingHarness();
    const hostile: unknown[] = [
      "not-an-address",
      "0x",
      "0x1234",
      `${HOP}0000`,
      `${HOP} `,
      null,
      42,
      [HOP],
      { address: HOP },
    ];
    for (const [index, hop] of hostile.entries()) {
      await expectRefused(
        harness,
        tradeBody({ decisionId: `d-hop-${index}`, route: { hops: [hop] } }),
        `hop=${JSON.stringify(hop)}`,
      );
    }
  });

  it("still allows an ordinary hop", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ route: { hops: [HOP] } }),
    });
    assert.equal(res.status, 200, res.text);
    // And the V2 path really carries it: [WBNB, HOP, TOKEN].
    const data = harness.provider.executeCalls[0]?.calls[0]?.data ?? "";
    assert.ok(
      data.endsWith(
        [WBNB, HOP, TOKEN]
          .map((a) => a.slice(2).toLowerCase().padStart(64, "0"))
          .join(""),
      ),
    );
  });
});
