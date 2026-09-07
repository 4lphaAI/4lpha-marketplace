/**
 * `POST /agents/:id/trade` on the flap.sh venue, entirely offline.
 *
 * The Portal read is answered by the fake PROVIDER, exactly as the Four.Meme
 * read is: it is chain state over a pinned, chain-id-verified client, never a
 * data-plane call. Nothing here opens a socket.
 *
 * What these tests are for, in one line each:
 *   - the calldata SHAPE the route submits, because a bonding curve expresses
 *     direction by which side of the struct is `address(0)` and a buy that
 *     forgot `value == inputAmount` reverts;
 *   - the four refusals, all fail-closed, all before anything is submitted;
 *   - the two numbers that ride out as information rather than as a judgement.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress } from "viem";
import {
  AGENT_ID,
  TOKEN,
  call,
  createHarness,
  errorCode,
  safeSecurityPayload,
  tradeBody,
  tradeConfig,
  type Harness,
} from "./support/serverHarness.js";
import { FLAP_PORTAL_56 } from "../src/ops/venues.js";
import { tradeParamsHash } from "../src/http/wire.js";

/** The Portal the test venue config wires. Distinctive, not the real one. */
const PORTAL = getAddress("0xaaaa0000000000000000000000000000000000aa");

async function flapHarness(
  options: Parameters<typeof createHarness>[0] = {},
): Promise<Harness> {
  const harness = await createHarness({
    ...options,
    config: {
      trade: tradeConfig({
        venues: {
          ...tradeConfig().venues,
          flapPortal: PORTAL,
        },
      }),
      ...options.config,
    },
  });
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  return harness;
}

function meta(body: Record<string, unknown>): Record<string, unknown> {
  const value = body["meta"];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  const value = body["data"];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function flapBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return tradeBody({ venue: "flap", ...overrides });
}

/* -------------------------------------------------------------------------- */
/* Calldata                                                                   */
/* -------------------------------------------------------------------------- */

describe("trade: flap calldata", () => {
  it("submits a buy as ONE call with value === inputAmount", async () => {
    const harness = await flapHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody({ amountWei: "19000000000000" }),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(data(res.body)["status"], "CONFIRMED");

    const submitted = harness.provider.executeCalls[0]?.calls ?? [];
    assert.equal(submitted.length, 1, "a curve buy needs no approve");
    assert.equal(submitted[0]?.to, PORTAL);
    assert.equal(
      submitted[0]?.value,
      19_000_000_000_000n,
      "the Portal reads the size from the struct and the funds from the tx; a mismatch reverts",
    );
  });

  it("submits a sell as approve(0), approve(amount), swap with no value", async () => {
    const harness = await flapHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody({ side: "sell", amountWei: "7000" }),
    });
    assert.equal(res.status, 200, res.text);

    const submitted = harness.provider.executeCalls[0]?.calls ?? [];
    assert.equal(submitted.length, 3);
    assert.equal(submitted[0]?.to, TOKEN);
    assert.equal(submitted[1]?.to, TOKEN);
    assert.equal(submitted[2]?.to, PORTAL);
    // A sell moves no native. Its cost to the native cap is the relay's gas
    // reimbursement alone (PHASE2.4 R6), which is not a call in this batch.
    assert.equal(submitted[2]?.value, undefined);
    // `permitData` is the empty bytes: offset 160, length 0, at the tail.
    assert.ok(submitted[2]?.data?.endsWith(`${"0".repeat(62)}a0${"0".repeat(64)}`));
  });

  it("never emits a route field, and 400s one that is supplied", async () => {
    // flap is not in ROUTABLE_VENUES. That is what makes a `route` a 400 rather
    // than a silently-ignored field that still changes `paramsHash`.
    const harness = await flapHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody({ route: { hops: [], fees: [] } }),
    });
    assert.equal(res.status, 400);
    assert.equal(errorCode(res.body), "invalid_request");
    assert.equal(harness.provider.executeCalls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The four refusals                                                          */
/* -------------------------------------------------------------------------- */

describe("trade: flap refusals", () => {
  it("refuses a DEX-state token with VENUE_GRADUATED", async () => {
    // Not because the Portal rejects it — the pinned v5.14.16 Portal trades it
    // happily — but because it would route through a migrated pool this plane
    // never quoted or chose. Routing is the caller's decision.
    const harness = await flapHarness();
    harness.provider.flapStateOverrides = { status: 4 };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody(),
    });
    assert.equal(res.status, 200);
    assert.equal(data(res.body)["status"], "FAILED");
    assert.equal(meta(res.body)["deniedBy"], "venue");
    assert.equal(meta(res.body)["code"], "VENUE_GRADUATED");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses an ERC-20-quoted curve with VENUE_QUOTE_UNSUPPORTED", async () => {
    const harness = await flapHarness();
    harness.provider.flapStateOverrides = {
      quoteToken: getAddress("0x205812CdBed920aFf76C6580abD681a46D11efc7"),
    };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody(),
    });
    assert.equal(meta(res.body)["code"], "VENUE_QUOTE_UNSUPPORTED");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses a curve whose native buys go through an internal swap", async () => {
    const harness = await flapHarness();
    harness.provider.flapStateOverrides = { nativeToQuoteSwapEnabled: true };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody(),
    });
    assert.equal(meta(res.body)["code"], "VENUE_QUOTE_UNSUPPORTED");
  });

  it("refuses an extension token with VENUE_UNSUPPORTED", async () => {
    // `swapExactInputV3` and its hooks are a named non-goal of this phase.
    const harness = await flapHarness();
    harness.provider.flapStateOverrides = {
      extensionId: `0x${"00".repeat(31)}01`,
    };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody(),
    });
    assert.equal(meta(res.body)["code"], "VENUE_UNSUPPORTED");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses when the Portal read reverts, without echoing its prose", async () => {
    // The Portal REVERTS on a non-flap address rather than answering zeros, so
    // the read is fail-closed by itself and needs no zero-bounding.
    const harness = await flapHarness();
    harness.provider.flapStateError = new Error(
      "execution reverted: 0xde6137d1 secret-endpoint-detail",
    );
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody(),
    });
    assert.equal(meta(res.body)["code"], "VENUE_UNSUPPORTED");
    assert.ok(!res.text.includes("secret-endpoint-detail"));
  });

  it("400s the venue on a chain with no configured Portal", async () => {
    const harness = await createHarness({ config: { trade: tradeConfig() } });
    harness.dataPlane.nextSecurity = safeSecurityPayload();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody(),
    });
    assert.equal(res.status, 400);
    assert.equal(errorCode(res.body), "invalid_request");
    assert.equal(harness.provider.flapReads.length, 0, "never a call to 0x0");
  });

  it("refuses the Portal itself as a `token`", async () => {
    // Otherwise this server would emit `approve(spender, amount)` ON the Portal
    // and build a swap path through it.
    const harness = await flapHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody({ token: PORTAL }),
    });
    assert.equal(res.status, 400);
    assert.equal(errorCode(res.body), "invalid_request");
  });
});

/* -------------------------------------------------------------------------- */
/* Information, identity, idempotency                                         */
/* -------------------------------------------------------------------------- */

describe("trade: flap meta and identity", () => {
  it("rides dexSupplyThresh and circulatingSupply out on the receipt", async () => {
    // Information, never a refusal (the `meta.scanFlags` precedent). How close a
    // curve is to graduating decides how likely a buy is to be refunded and to
    // miss its floor — but that is market judgement.
    const harness = await flapHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody(),
    });
    assert.equal(data(res.body)["status"], "CONFIRMED");
    assert.equal(
      meta(res.body)["dexSupplyThresh"],
      (800_000_000n * 10n ** 18n).toString(10),
    );
    assert.equal(
      meta(res.body)["circulatingSupply"],
      (449_155_977n * 10n ** 18n).toString(10),
    );
  });

  it("does NOT refuse a curve one trade away from graduating", async () => {
    const harness = await flapHarness();
    harness.provider.flapStateOverrides = {
      circulatingSupply: 800_000_000n * 10n ** 18n - 1n,
    };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: flapBody(),
    });
    assert.equal(data(res.body)["status"], "CONFIRMED");
  });

  it("answers the identical trade twice from ONE row", async () => {
    // `hashCalls` covers the flap calls because it hashes whatever the builder
    // produced; `paramsHash` is what binds the decision. Two submits of the same
    // decision must not be two trades.
    const harness = await flapHarness();
    const body = flapBody({ decisionId: "flap-1" });
    const first = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body,
    });
    const second = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body,
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(meta(second.body)["replayed"], true);
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("binds the Portal into paramsHash", () => {
    // Same precedent as `routerV3` (PHASE2.2 R7), and it matters more here: the
    // Portal is also the approval SPENDER on every sell. Without this, a
    // `VENUE_FLAP_PORTAL` repointed between a submit and its retry leaves the
    // hash unchanged, and the retry is answered with the FIRST trade's stored
    // outcome even though it is now aimed at a different contract.
    const base = {
      chainId: 56,
      venue: "flap",
      side: "buy",
      token: TOKEN,
      amountWei: 1_000n,
      minOutWei: 900n,
      quotedOutWei: 1_000n,
    } as const;
    assert.notEqual(
      tradeParamsHash({ ...base, flapPortal: PORTAL }),
      tradeParamsHash({ ...base, flapPortal: FLAP_PORTAL_56 }),
    );
    // And an unconfigured chain must not collide with a configured one.
    assert.notEqual(
      tradeParamsHash({ ...base, flapPortal: PORTAL }),
      tradeParamsHash(base),
    );
  });

  it("pins the mainnet Portal address", () => {
    // The BNB *testnet* Portal has no code at all on chain 56; a copy-paste
    // between the docs' two headings would produce a dead venue.
    assert.equal(FLAP_PORTAL_56, getAddress("0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0"));
    assert.notEqual(FLAP_PORTAL_56, zeroAddress);
  });
});
