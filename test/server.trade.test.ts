/**
 * `POST /agents/:id/trade`, end to end and entirely offline.
 *
 * The harness supplies memory stores, a fake provider that records exactly what
 * it was asked to submit, a scripted data plane, and a clock the test moves by
 * hand — so the money path is exercised deterministically and no socket is
 * opened.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress, type Address } from "viem";
import {
  NotAllowedError,
  ProviderError,
  SessionExpiredError,
  type FourMemeQuote,
} from "../src/core/types.js";
import {
  AGENT_ID,
  MANAGER,
  OWNER_ADDRESS,
  ROUTER,
  TOKEN,
  TREASURY,
  WBNB,
  call,
  createHarness,
  errorCode,
  honeypotSecurityPayload,
  safeSecurityPayload,
  tradeBody,
  tradeConfig,
  type Harness,
} from "./support/serverHarness.js";
import { createBpsFeePolicy } from "../src/ops/fees.js";

const ONE_BNB = 10n ** 18n;

/**
 * A harness whose scan gate passes. The Four.Meme read is answered by the fake
 * PROVIDER now, not by the data plane, and its default answer is shaped like
 * the live helper's — so nothing has to be seeded for the ordinary case.
 */
async function tradingHarness(
  options: Parameters<typeof createHarness>[0] = {},
): Promise<Harness> {
  const harness = await createHarness({
    ...options,
    httpRuntimeProfile: options.httpRuntimeProfile ?? "trade-v1",
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

describe("POST /agents/:id/trade: pancake buy", () => {
  it("submits one payable swap to the router, recipient = the row wallet", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: ONE_BNB.toString(10) }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(data(res.body)["status"], "CONFIRMED");
    assert.equal(harness.provider.executeCalls.length, 1);

    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    assert.equal(submitted.calls.length, 1);
    const swap = submitted.calls[0];
    assert.ok(swap !== undefined);
    assert.equal(swap.to, ROUTER);
    assert.equal(swap.value, ONE_BNB);
    // The recipient word is the agent's wallet from the persisted row.
    assert.match(
      swap.data ?? "0x",
      new RegExp(OWNER_ADDRESS.slice(2).toLowerCase()),
    );
    assert.equal(submitted.bypassLocalPolicyCheck, false);
  });

  it("records the native spend on the journal row", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: ONE_BNB.toString(10) }),
    });
    const key = meta(res.body)["idempotencyKey"];
    assert.equal(typeof key, "string");
    const row = await harness.journal.get(key as string);
    assert.equal(row?.kind, "trade");
    assert.equal(row?.nativeSpendWei, ONE_BNB);
    assert.equal(row?.state, "COMMITTED");
  });
});

describe("POST /agents/:id/trade: pre-extraction response shapes", () => {
  it("deep-equals a fresh rolled-back body without meta.failureCode", async () => {
    const harness = await createHarness({ config: { trade: tradeConfig({ scanMode: "block" }) } });
    harness.dataPlane.nextSecurity = honeypotSecurityPayload();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, { method: "POST", body: tradeBody() });
    const key = meta(res.body)["idempotencyKey"];
    const decisionId = (tradeBody() as { decisionId: string }).decisionId;
    assert.deepEqual(res.body, { data: { status: "FAILED", failureCode: "NOT_ALLOWED" }, meta: {
      idempotencyKey: key, decisionId, journalState: "ROLLED_BACK", deniedBy: "scan", code: "SCAN_DENIED",
      reasons: ["honeypot"],
    } });
  });

  it("deep-equals executeViaSession-throw UNKNOWN without meta.decisionId", async () => {
    const harness = await tradingHarness();
    harness.provider.nextError = new ProviderError("relay unavailable");
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, { method: "POST", body: tradeBody() });
    const key = meta(res.body)["idempotencyKey"];
    assert.deepEqual(res.body, { data: { status: "PENDING" }, meta: {
      idempotencyKey: key, journalState: "UNKNOWN", failureCode: "PROVIDER_ERROR",
      note: "Submission outcome is unknown and is held for reconciliation.",
    } });
  });

  it("deep-equals a replayed rolled-back body and retains callsId", async () => {
    const harness = await tradingHarness();
    harness.provider.nextReceipt = { status: "FAILED", callsId: `0x${"ab".repeat(32)}`, failureCode: "NOT_ALLOWED" };
    const body = tradeBody();
    await call(harness, `/agents/${AGENT_ID}/trade`, { method: "POST", body });
    const replay = await call(harness, `/agents/${AGENT_ID}/trade`, { method: "POST", body });
    const key = meta(replay.body)["idempotencyKey"];
    assert.deepEqual(replay.body, { data: { status: "FAILED", callsId: `0x${"ab".repeat(32)}` }, meta: {
      idempotencyKey: key, journalState: "ROLLED_BACK", replayed: true,
      decisionId: (body as { decisionId: string }).decisionId,
    } });
  });
});

describe("POST /agents/:id/trade: pancake sell", () => {
  it("submits [approve(0), approve(amount), swap] in ONE execute", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "sell", amountWei: "5000" }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(
      harness.provider.executeCalls.length,
      1,
      "the approvals and the swap must land in one atomic batch",
    );
    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    assert.equal(submitted.calls.length, 3);
    assert.deepEqual(
      submitted.calls.map((c) => c.to),
      [TOKEN, TOKEN, ROUTER],
    );
    // approve(router, 0) then approve(router, 5000).
    assert.match(submitted.calls[0]?.data ?? "", /^0x095ea7b3/);
    assert.match(submitted.calls[0]?.data ?? "", /0{64}$/);
    assert.match(submitted.calls[1]?.data ?? "", /^0x095ea7b3/);
    assert.match(submitted.calls[1]?.data ?? "", /1388$/);
  });

  it("never reads the scan gate for a sell", async () => {
    const harness = await createHarness();
    harness.dataPlane.nextSecurity = null; // would deny a buy
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "sell", amountWei: "5000" }),
    });
    assert.equal(res.status, 200, res.text);
    assert.ok(!harness.dataPlane.requested.some((r) => r.startsWith("security/")));
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("charges no fee on a sell even when one is configured", async () => {
    const harness = await tradingHarness({
      config: {
        trade: tradeConfig({
          feePolicy: createBpsFeePolicy({ treasury: TREASURY, bps: 100 }),
          feeTreasury: TREASURY,
          feeBps: 100,
        }),
      },
    });
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "sell", amountWei: "5000" }),
    });
    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    assert.equal(submitted.calls.length, 3, "no fee call on a sell");
  });
});

describe("POST /agents/:id/trade: the fee", () => {
  const feeTrade = tradeConfig({
    feePolicy: createBpsFeePolicy({ treasury: TREASURY, bps: 100 }),
    feeTreasury: TREASURY,
    feeBps: 100,
  });

  it("appends a treasury transfer and leaves the swap value alone", async () => {
    const harness = await tradingHarness({ config: { trade: feeTrade } });
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(res.status, 200, res.text);

    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    assert.equal(submitted.calls.length, 2);
    const swap = submitted.calls[0];
    const fee = submitted.calls[1];
    assert.equal(swap?.value, ONE_BNB, "the swap still sends amountWei");
    assert.equal(fee?.to, TREASURY);
    assert.equal(fee?.value, ONE_BNB / 100n, "1% on top");
    assert.equal(fee?.data, undefined, "a plain transfer, not a call");

    const key = meta(res.body)["idempotencyKey"] as string;
    const row = await harness.journal.get(key);
    assert.equal(
      row?.nativeSpendWei,
      ONE_BNB + ONE_BNB / 100n,
      "the journal records amountWei + feeWei",
    );
  });

  it("refuses a trade sized exactly to the per-trade cap once a fee applies", async () => {
    const amountWei = ONE_BNB;
    const feeWei = amountWei / 100n;

    // At cap = amount + fee, it passes.
    const ok = await tradingHarness({ config: { trade: feeTrade } });
    await ok.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      perTradeNativeWei: amountWei + feeWei,
    });
    const passed = await call(ok, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: amountWei.toString(10) }),
    });
    assert.equal(data(passed.body)["status"], "CONFIRMED", passed.text);

    // One wei lower and it refuses.
    const tight = await tradingHarness({ config: { trade: feeTrade } });
    await tight.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      perTradeNativeWei: amountWei + feeWei - 1n,
    });
    const denied = await call(tight, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: amountWei.toString(10) }),
    });
    assert.equal(denied.status, 200);
    assert.equal(data(denied.body)["status"], "FAILED");
    assert.equal(meta(denied.body)["code"], "PER_TRADE_CAP");
    assert.equal(tight.provider.executeCalls.length, 0);
  });
});

describe("POST /agents/:id/trade: Four.Meme", () => {
  it("uses the manager FROM THE READ and the venue's own msg.value", async () => {
    const readManager = getAddress("0x00000000000000000000000000000000000ABCDE");
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteOverrides = { tokenManager: readManager };

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme", amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(res.status, 200, res.text);

    // The read is a PROVIDER call, not a data-plane one.
    assert.deepEqual(
      harness.provider.fourMemeReads.map((r) => [r.token, r.side, r.amountWei]),
      [[TOKEN, "buy", ONE_BNB]],
    );

    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    const buy = submitted.calls[0];
    assert.equal(buy?.to, readManager, "not the configured default manager");
    assert.notEqual(buy?.to, MANAGER);
    assert.equal(
      buy?.value,
      ONE_BNB + ONE_BNB / 100n,
      "msg.value is tryBuy.amountMsgValue, fee-inclusive",
    );
    assert.ok(
      (buy?.value ?? 0n) > ONE_BNB,
      "a non-zero venue fee must make msg.value exceed amountWei",
    );
    // `funds` is the SECOND word of buyTokenAMAP(token, funds, minAmount).
    assert.equal(
      (buy?.data ?? "0x").slice(10 + 64, 10 + 128),
      ONE_BNB.toString(16).padStart(64, "0"),
      "the swap's funds arg is tryBuy.amountFunds",
    );

    const key = meta(res.body)["idempotencyKey"] as string;
    assert.equal(
      (await harness.journal.get(key))?.nativeSpendWei,
      ONE_BNB + ONE_BNB / 100n,
      "native_spend_wei is msgValueWei + feeWei (no fee configured here)",
    );
  });

  it("records native_spend_wei = msgValueWei + feeWei when a fee is configured", async () => {
    const feeTrade = tradeConfig({
      feePolicy: createBpsFeePolicy({ treasury: TREASURY, bps: 100 }),
      feeTreasury: TREASURY,
      feeBps: 100,
    });
    const harness = await tradingHarness({ config: { trade: feeTrade } });
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme", amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(res.status, 200, res.text);
    const msgValue = ONE_BNB + ONE_BNB / 100n;
    const feeWei = ONE_BNB / 100n;
    const key = meta(res.body)["idempotencyKey"] as string;
    assert.equal((await harness.journal.get(key))?.nativeSpendWei, msgValue + feeWei);
  });

  it("denies VENUE_UNSUPPORTED when the provider read throws", async () => {
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteError = new Error("rpc exploded");
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme" }),
    });
    assert.equal(res.status, 200);
    assert.equal(data(res.body)["status"], "FAILED");
    assert.equal(data(res.body)["failureCode"], "NOT_ALLOWED");
    assert.equal(meta(res.body)["deniedBy"], "venue");
    assert.equal(meta(res.body)["code"], "VENUE_UNSUPPORTED");
    assert.equal(harness.provider.executeCalls.length, 0);
    assert.doesNotMatch(res.text, /exploded/, "no upstream string may be echoed");
  });

  it("denies V1 tokens", async () => {
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteOverrides = { version: 1 };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme" }),
    });
    assert.equal(meta(res.body)["code"], "VENUE_UNSUPPORTED");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("denies VENUE_GRADUATED once liquidity has moved to Pancake", async () => {
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteOverrides = { liquidityAdded: true };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme" }),
    });
    assert.equal(meta(res.body)["code"], "VENUE_GRADUATED");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("denies VENUE_QUOTE_UNSUPPORTED for a non-native quote token", async () => {
    // Bought by approving and spending an ERC-20, not by sending BNB. There is
    // no path for that here, so it refuses with a code the caller can act on
    // rather than sending native to a manager that wants none.
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteOverrides = {
      quoteToken: getAddress("0x000000000000000000000000000000000000CAFE"),
    };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme" }),
    });
    assert.equal(meta(res.body)["code"], "VENUE_QUOTE_UNSUPPORTED");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses a read-derived manager that is blacklisted", async () => {
    for (const hostile of [
      OWNER_ADDRESS,
      getAddress("0x00000000000000000000000000000000000000ff"),
      getAddress(zeroAddress),
      WBNB,
      TOKEN,
    ] as Address[]) {
      const harness = await tradingHarness();
      harness.provider.fourMemeQuoteOverrides = { tokenManager: hostile };
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ venue: "fourmeme" }),
      });
      assert.equal(meta(res.body)["code"], "VENUE_UNSUPPORTED", `manager=${hostile}`);
      assert.equal(harness.provider.executeCalls.length, 0);
    }
  });

  it("denies when the venue is unconfigured for this chain", async () => {
    const harness = await tradingHarness({
      config: { trade: tradeConfig({ venues: { chainId: 97 } }) },
    });
    for (const venue of ["pancake", "fourmeme"]) {
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ venue, decisionId: `d-${venue}` }),
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(errorCode(res.body), "invalid_request");
    }
    assert.equal(harness.provider.executeCalls.length, 0);
    assert.equal(
      harness.provider.fourMemeReads.length,
      0,
      "the helper-presence gate runs before any read",
    );
  });

  it("is a 400 when the manager is configured but the HELPER is not", async () => {
    // PHASE2.1 R5: the helper is what makes the venue exist. A chain that knows
    // a manager address but has nothing to read routing facts from cannot trade.
    const harness = await tradingHarness({
      config: {
        trade: tradeConfig({
          venues: { chainId: 97, fourMemeTokenManager: MANAGER },
        }),
      },
    });
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme" }),
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(errorCode(res.body), "invalid_request");
    assert.equal(harness.provider.fourMemeReads.length, 0);
  });

  it("sells through the read manager with the approve-reset batch", async () => {
    const readManager = getAddress("0x00000000000000000000000000000000000ABCDE");
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteOverrides = { tokenManager: readManager };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme", side: "sell", amountWei: "7000" }),
    });
    assert.equal(res.status, 200, res.text);
    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    assert.deepEqual(
      submitted.calls.map((c) => c.to),
      [TOKEN, TOKEN, readManager],
    );
    assert.equal(submitted.calls[2]?.value, undefined, "a sell sends no native");
    const key = meta(res.body)["idempotencyKey"] as string;
    assert.equal((await harness.journal.get(key))?.nativeSpendWei, 0n);
  });
});

describe("POST /agents/:id/trade: the Four.Meme msg.value bounds (R1/R2)", () => {
  /** Run one buy with a doctored quote and return the deny code, if any. */
  async function denyCodeFor(
    overrides: Partial<FourMemeQuote>,
    amountWei = ONE_BNB,
  ): Promise<{ code: unknown; submits: number }> {
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteOverrides = overrides;
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme", amountWei: amountWei.toString(10) }),
    });
    return {
      code: meta(res.body)["code"],
      submits: harness.provider.executeCalls.length,
    };
  }

  it("denies VENUE_UNSUPPORTED on the all-zero non-token read", async () => {
    // VERIFIED on mainnet: the helper answers a non-token with all zeros and
    // DOES NOT REVERT, so fail-closed cannot rely on the read throwing.
    for (const overrides of [
      { fundsWei: 0n },
      { msgValueWei: 0n },
      { estimatedOutWei: 0n },
      { fundsWei: 0n, msgValueWei: 0n, estimatedOutWei: 0n },
    ]) {
      const { code, submits } = await denyCodeFor(overrides);
      assert.equal(code, "VENUE_UNSUPPORTED", JSON.stringify(String(code)));
      assert.equal(submits, 0);
    }
  });

  it("denies VENUE_UNSUPPORTED when a side-appropriate money field is absent", async () => {
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteOverrides = {};
    // A sell-shaped answer to a buy: no msgValue, no funds, no estimate.
    harness.provider.readFourMemeQuote = async () => ({
      version: 2,
      tokenManager: MANAGER,
      quoteToken: null,
      liquidityAdded: false,
    });
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme" }),
    });
    assert.equal(meta(res.body)["code"], "VENUE_UNSUPPORTED");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("denies VENUE_MSGVALUE_UNSAFE when funds exceed the declared amount", async () => {
    const { code, submits } = await denyCodeFor({
      fundsWei: ONE_BNB + 1n,
      msgValueWei: ONE_BNB + 1n,
    });
    assert.equal(code, "VENUE_MSGVALUE_UNSAFE");
    assert.equal(submits, 0);
  });

  it("denies VENUE_MSGVALUE_UNSAFE when msg.value underpays the funds", async () => {
    const { code, submits } = await denyCodeFor({
      fundsWei: ONE_BNB,
      msgValueWei: ONE_BNB - 1n,
    });
    assert.equal(code, "VENUE_MSGVALUE_UNSAFE");
    assert.equal(submits, 0);
  });

  it("denies VENUE_MSGVALUE_UNSAFE above the MAX_VENUE_FEE_BPS ceiling", async () => {
    // The default ceiling is 300 bps on top of amountWei.
    const ceiling = (ONE_BNB * 10_300n) / 10_000n;
    const atCeiling = await denyCodeFor({
      fundsWei: ONE_BNB,
      msgValueWei: ceiling,
    });
    assert.equal(atCeiling.code, undefined, "exactly at the ceiling passes");
    assert.equal(atCeiling.submits, 1);

    const overCeiling = await denyCodeFor({
      fundsWei: ONE_BNB,
      msgValueWei: ceiling + 1n,
    });
    assert.equal(overCeiling.code, "VENUE_MSGVALUE_UNSAFE", "one wei over refuses");
    assert.equal(overCeiling.submits, 0);
  });

  it("honours a tightened MAX_VENUE_FEE_BPS", async () => {
    const harness = await tradingHarness({
      config: { trade: tradeConfig({ maxVenueFeeBps: 50 }) },
    });
    // The default quote asks for 100 bps on top, which a 50 bps ceiling refuses.
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme", amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(meta(res.body)["code"], "VENUE_MSGVALUE_UNSAFE");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("accepts a quote that sizes funds BELOW the declared amount", async () => {
    // Legitimate: the curve may not absorb everything offered. What must never
    // happen is the other direction.
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteOverrides = {
      fundsWei: ONE_BNB / 2n,
      msgValueWei: ONE_BNB / 2n + ONE_BNB / 200n,
    };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme", amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(res.status, 200, res.text);
    const buy = harness.provider.executeCalls[0]?.calls[0];
    assert.equal(buy?.value, ONE_BNB / 2n + ONE_BNB / 200n);
    assert.equal(
      (buy?.data ?? "0x").slice(10 + 64, 10 + 128),
      (ONE_BNB / 2n).toString(16).padStart(64, "0"),
    );
  });

  it("never gates on estimatedOutWei beyond the zero check", async () => {
    // Gating on the size of the estimate would be market judgement (R10).
    const harness = await tradingHarness();
    harness.provider.fourMemeQuoteOverrides = { estimatedOutWei: 1n };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "fourmeme", amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.executeCalls.length, 1);
  });
});

describe("POST /agents/:id/trade: the scan gate", () => {
  it("denies SCAN_DENIED and NEVER reaches the provider", async () => {
    const harness = await createHarness({ config: { trade: tradeConfig({ scanMode: "block" }) } });
    harness.dataPlane.nextSecurity = honeypotSecurityPayload();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(res.status, 200);
    assert.equal(data(res.body)["status"], "FAILED");
    assert.equal(meta(res.body)["deniedBy"], "scan");
    assert.equal(meta(res.body)["code"], "SCAN_DENIED");
    assert.deepEqual(meta(res.body)["reasons"], ["honeypot"]);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("trades on by default when the data plane has nothing to say", async () => {
    // The marketplace chose this token; an absent opinion is not evidence of a
    // defect, and coupling the money path to scanner uptime would stop trading
    // for a reason that has nothing to do with the trade.
    const harness = await createHarness();
    harness.dataPlane.nextSecurity = null;
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(data(res.body)["status"], "CONFIRMED", res.text);
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("refuses on a missing verdict when the deployment opts in", async () => {
    const harness = await createHarness({
      // Both halves are needed: `requireVerdict` decides that an absent answer
      // is a finding, and `block` decides that a finding refuses.
      config: { trade: tradeConfig({ scanRequireVerdict: true, scanMode: "block" }) },
    });
    harness.dataPlane.nextSecurity = null;
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.deepEqual(meta(res.body)["reasons"], ["scan_unavailable"]);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("lets the quality flags the live feed actually produces through", async () => {
    // Observed across 52 live Four.Meme tokens: low_liquidity, tax and
    // not_open_source are the whole non-empty vocabulary. Each is a reason to
    // prefer a different token — the marketplace's call, not this layer's.
    const harness = await createHarness();
    harness.dataPlane.nextSecurity = safeSecurityPayload({
      riskLevel: "warn",
      flags: ["low_liquidity", "tax", "not_open_source"],
    });
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(data(res.body)["status"], "CONFIRMED", res.text);
  });
});

describe("POST /agents/:id/trade: the rule engine", () => {
  it("denies MIN_OUT_TOO_LOW for a floor far below the caller's own quote", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ minOutWei: "1", quotedOutWei: ONE_BNB.toString(10) }),
    });
    assert.equal(res.status, 200);
    assert.equal(data(res.body)["status"], "FAILED");
    assert.equal(meta(res.body)["deniedBy"], "rules");
    assert.equal(meta(res.body)["code"], "MIN_OUT_TOO_LOW");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  /*
   * DO NOT FLIP THE UNKNOWN HALF OF THIS TEST (PHASE2.4 R4 item 15).
   *
   * The first trade fails with a generic relay error from the SUBMIT, so its row
   * must stay UNKNOWN and must keep holding its budget. Rolling it back would
   * free headroom for a trade that may have landed — the double-spend direction
   * the positional refusal split is built to keep unreachable.
   */
  it("denies DAILY_CAP counting an UNKNOWN row, and releases a rolled-back one", async () => {
    const harness = await tradingHarness();
    await harness.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      dailyNativeWei: ONE_BNB,
    });

    // An earlier trade whose outcome is ambiguous. It still holds budget.
    harness.provider.nextError = new Error("relay timeout");
    const first = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-1", amountWei: (ONE_BNB / 2n).toString(10) }),
    });
    assert.equal(meta(first.body)["journalState"], "UNKNOWN");
    harness.provider.nextError = null;

    const overCap = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({
        decisionId: "d-2",
        amountWei: (ONE_BNB / 2n + 1n).toString(10),
      }),
    });
    assert.equal(meta(overCap.body)["code"], "DAILY_CAP");
    assert.equal(
      harness.provider.executeCalls.length,
      1,
      "an ambiguous crash window must REDUCE the remaining budget, not free it",
    );

    // The UNKNOWN row is HELD: it is still counted, and nothing auto-resolved it.
    const firstKey = meta(first.body)["idempotencyKey"] as string;
    assert.equal((await harness.journal.get(firstKey))?.state, "UNKNOWN");
  });

  it("releases spend once a row is terminally rolled back", async () => {
    const harness = await tradingHarness();
    await harness.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      dailyNativeWei: ONE_BNB,
    });
    // A FAILED receipt rolls the row back, which frees its budget.
    harness.provider.nextReceipt = {
      status: "FAILED",
      failureCode: "CAP_EXCEEDED",
      callsId: `0x${"c2".repeat(32)}`,
    };
    const failed = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-1", amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(data(failed.body)["status"], "FAILED");

    harness.provider.nextReceipt = {
      status: "CONFIRMED",
      callsId: `0x${"c3".repeat(32)}`,
      transactionHash: `0x${"7b".repeat(32)}`,
    };
    const second = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-2", amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(
      data(second.body)["status"],
      "CONFIRMED",
      "a terminal-failed row must give its budget back",
    );
  });

  it("counts an existing /execute journal spend against the same daily cap", async () => {
    const harness = await tradingHarness();
    await harness.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      dailyNativeWei: ONE_BNB,
    });
    await harness.journal.begin({
      idempotencyKey: "seeded-raw-spend",
      agentId: AGENT_ID,
      ownerAddress: OWNER_ADDRESS,
      kind: "execute",
      decisionId: "d-raw",
      nativeSpendWei: ONE_BNB / 2n,
    });

    const trade = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({
        decisionId: "d-trade",
        amountWei: (ONE_BNB / 2n + 1n).toString(10),
      }),
    });
    assert.equal(meta(trade.body)["code"], "DAILY_CAP");
  });
});

describe("POST /agents/:id/trade: idempotency", () => {
  it("replays the stored outcome for the same decision and params", async () => {
    const harness = await tradingHarness();
    const body = tradeBody();
    const first = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body,
    });
    const second = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body,
    });

    assert.equal(second.status, 200);
    assert.equal(meta(second.body)["replayed"], true);
    assert.equal(data(second.body)["status"], data(first.body)["status"]);
    assert.equal(
      harness.provider.executeCalls.length,
      1,
      "a retry must never submit a second time",
    );
  });

  it("409s the same decision with different params, and submits nothing", async () => {
    const harness = await tradingHarness();
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: "1000" }),
    });
    const conflicting = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: "2000" }),
    });
    assert.equal(conflicting.status, 409);
    assert.equal(errorCode(conflicting.body), "conflict");
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("keeps one decision namespace beneath runtime-profile isolation", async () => {
    const a = await tradingHarness();
    await a.journal.begin({
      idempotencyKey: "seed-execute",
      agentId: AGENT_ID,
      ownerAddress: OWNER_ADDRESS,
      kind: "execute",
      decisionId: "shared",
    });
    const tradeAfterExecute = await call(a, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "shared" }),
    });
    assert.equal(tradeAfterExecute.status, 409, tradeAfterExecute.text);
    assert.equal(a.provider.executeCalls.length, 0);

    const b = await createHarness({ httpRuntimeProfile: "raw-v1" });
    await b.journal.begin({
      idempotencyKey: "seed-trade",
      agentId: AGENT_ID,
      ownerAddress: OWNER_ADDRESS,
      kind: "trade",
      decisionId: "shared",
    });
    const executeAfterTrade = await call(b, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "shared", calls: [{ to: ROUTER, value: "1" }] },
    });
    assert.equal(executeAfterTrade.status, 409, executeAfterTrade.text);
    assert.equal(b.provider.executeCalls.length, 0);
  });

  it("409s a decisionId that a DENIED trade already bound", async () => {
    // Denials are journalled, so a caller cannot burn a decision id on a trade
    // it knows will be refused and then reuse it for one that will not.
    const harness = await createHarness({ config: { trade: tradeConfig({ scanMode: "block" }) } });
    harness.dataPlane.nextSecurity = honeypotSecurityPayload();
    const denied = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-x", amountWei: "1000" }),
    });
    assert.equal(meta(denied.body)["code"], "SCAN_DENIED");

    harness.dataPlane.nextSecurity = safeSecurityPayload();
    const reused = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-x", amountWei: "2000" }),
    });
    assert.equal(reused.status, 409);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("replays a denial for the identical params rather than re-deciding", async () => {
    const harness = await createHarness({ config: { trade: tradeConfig({ scanMode: "block" }) } });
    harness.dataPlane.nextSecurity = honeypotSecurityPayload();
    const body = tradeBody({ decisionId: "d-x" });
    await call(harness, `/agents/${AGENT_ID}/trade`, { method: "POST", body });

    harness.dataPlane.nextSecurity = safeSecurityPayload();
    const again = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body,
    });
    assert.equal(again.status, 200);
    assert.equal(data(again.body)["status"], "FAILED");
    assert.equal(meta(again.body)["replayed"], true);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("409s when a VENUE_* address changes between submit and retry", async () => {
    // The paramsHash binds the resolved configuration, not just the request, so
    // a retry aimed at a different router is a conflict rather than a stale
    // replay of the first trade's outcome.
    const body = tradeBody();
    const first = await tradingHarness();
    await call(first, `/agents/${AGENT_ID}/trade`, { method: "POST", body });
    const priorRow = await first.journal.getByDecision(AGENT_ID, "d-trade-1");
    assert.ok(priorRow !== null);

    const moved = await tradingHarness({
      config: {
        trade: tradeConfig({
          venues: {
            chainId: 97,
            pancakeRouterV2: getAddress("0x0000000000000000000000000000000000009999"),
            wbnb: WBNB,
            fourMemeTokenManager: MANAGER,
          },
        }),
      },
    });
    // Seed the moved harness's journal with the first deployment's row.
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
});

describe("POST /agents/:id/trade: concurrency", () => {
  it("lets exactly one of two concurrent over-cap trades submit", async () => {
    const harness = await tradingHarness();
    await harness.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      dailyNativeWei: ONE_BNB,
    });
    // Two trades of 0.6 BNB: either alone fits, together they do not.
    const amount = ((ONE_BNB * 6n) / 10n).toString(10);
    const [a, b] = await Promise.all([
      call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ decisionId: "d-a", amountWei: amount }),
      }),
      call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ decisionId: "d-b", amountWei: amount }),
      }),
    ]);

    const statuses = [data(a.body)["status"], data(b.body)["status"]].toSorted();
    assert.deepEqual(
      statuses,
      ["CONFIRMED", "FAILED"],
      "the post-begin re-check is what makes the cap a reservation",
    );
    assert.equal(harness.provider.executeCalls.length, 1);
    const denied = data(a.body)["status"] === "FAILED" ? a : b;
    assert.equal(meta(denied.body)["code"], "DAILY_CAP");
  });
});

describe("POST /agents/:id/trade: kill switch", () => {
  it("refuses a paused agent before the provider", async () => {
    const harness = await tradingHarness();
    await harness.killswitch.pauseAgent(AGENT_ID, OWNER_ADDRESS);
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(res.status, 409);
    assert.equal(errorCode(res.body), "paused");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses under a global halt", async () => {
    const harness = await tradingHarness();
    await harness.killswitch.halt("audit");
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(res.status, 409);
    assert.equal(errorCode(res.body), "halted");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  /*
   * DO NOT FLIP THIS TEST (PHASE2.4 R4 item 15). Third of the three regression
   * pins: a generic relay error from the SUBMIT is ambiguous by construction and
   * must stay UNKNOWN. Only `preflightError` — which provably never reached a
   * relay — rolls a row back.
   */
  it("holds an ambiguous submit as UNKNOWN rather than guessing", async () => {
    const harness = await tradingHarness();
    harness.provider.nextError = new Error("socket hang up");
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(res.status, 200);
    assert.equal(data(res.body)["status"], "PENDING");
    assert.equal(meta(res.body)["journalState"], "UNKNOWN");
    const key = meta(res.body)["idempotencyKey"] as string;
    assert.equal((await harness.journal.get(key))?.state, "UNKNOWN");
  });
});

describe("POST /agents/:id/trade: a refusal that never submitted", () => {
  it("rolls back with deniedBy=session and the thrown error's own code", async () => {
    const harness = await tradingHarness();
    harness.provider.preflightError = new NotAllowedError("refused before submit");

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(data(res.body)["status"], "FAILED");
    assert.equal(data(res.body)["failureCode"], "NOT_ALLOWED");
    assert.equal(meta(res.body)["journalState"], "ROLLED_BACK");
    assert.equal(meta(res.body)["deniedBy"], "session");
    assert.equal(meta(res.body)["code"], "NOT_ALLOWED");
    assert.equal(harness.provider.executeCalls.length, 0, "nothing was submitted");

    const key = meta(res.body)["idempotencyKey"] as string;
    assert.equal((await harness.journal.get(key))?.state, "ROLLED_BACK");
  });

  it("keeps SESSION_EXPIRED distinguishable from NOT_ALLOWED", async () => {
    const harness = await tradingHarness();
    harness.provider.preflightError = new SessionExpiredError();

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(meta(res.body)["code"], "SESSION_EXPIRED");
  });

  it("releases the cap headroom a refused trade was holding", async () => {
    // The counterpart to the UNKNOWN pin above: a row that provably never
    // submitted must NOT keep bounding the day's budget.
    const harness = await tradingHarness();
    harness.provider.preflightError = new NotAllowedError("refused before submit");
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: ONE_BNB.toString(10) }),
    });
    assert.equal(await harness.journal.sumNativeSpendSince(AGENT_ID, 0), 0n);
  });
});

describe("POST /agents/:id/trade: throttle", () => {
  it("rejects /execute before it can consume a trade profile's throttle", async () => {
    const harness = await tradingHarness({
      config: { throttle: { minIntervalMs: 0, maxPerWindow: 2, windowMs: 60_000 } },
    });
    const first = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-1" }),
    });
    assert.equal(first.status, 200, first.text);

    const second = await call(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: { decisionId: "d-2", calls: [{ to: ROUTER, value: "1" }] },
    });
    assert.equal(second.status, 401, second.text);
    assert.equal(errorCode(second.body), "runtime_auth_failed");

    // Runtime-profile rejection happens before the shared money throttle, so a
    // disallowed raw call cannot burn a trade agent's availability.
    const third = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-3" }),
    });
    assert.equal(third.status, 200);
  });

  it("charges budget for a scan-denied trade", async () => {
    // Deliberate: the throttle also protects the data plane, which the gate
    // reads. A free denial would be a free way to hammer it.
    const harness = await createHarness({
      config: {
        throttle: { minIntervalMs: 0, maxPerWindow: 1, windowMs: 60_000 },
        trade: tradeConfig({ scanMode: "block" }),
      },
    });
    harness.dataPlane.nextSecurity = honeypotSecurityPayload();
    const denied = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-1" }),
    });
    assert.equal(meta(denied.body)["code"], "SCAN_DENIED");

    const next = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-2" }),
    });
    assert.equal(next.status, 429);
  });
});
