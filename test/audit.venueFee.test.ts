/**
 * Auditor-written: the VENUE fee must be spent money, not invisible money.
 *
 * Phase 2.1 made a Four.Meme buy send `amountMsgValue` — the venue's own figure,
 * strictly larger than the `amountWei` the caller declared, because the venue
 * charges its trading fee on top. Everything downstream that counts native spend
 * must count THAT number. If any of it counts `amountWei` instead, an agent
 * quietly spends more than its owner's caps allow, and the gap grows with every
 * trade. These tests attack exactly that seam: they set the caps to the boundary
 * and assert the venue fee is on the inside of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  OWNER_ADDRESS,
  call,
  createHarness,
  safeSecurityPayload,
  tradeBody,
  type Harness,
} from "./support/serverHarness.js";

const ONE_BNB = 10n ** 18n;
/** The harness models the live venue at 100 bps, charged on top. */
const VENUE_FEE = ONE_BNB / 100n;

async function tradingHarness(): Promise<Harness> {
  const harness = await createHarness();
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  return harness;
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return tradeBody({
    venue: "fourmeme",
    amountWei: ONE_BNB.toString(10),
    ...overrides,
  });
}

function field(res: { body: Record<string, unknown> }, key: string): unknown {
  const section = res.body[key];
  return typeof section === "object" && section !== null ? section : {};
}

describe("audit: the Four.Meme venue fee counts against the caps", () => {
  it("refuses when amountWei fits the per-trade cap but msg.value does not", async () => {
    // The attack this catches: measuring the cap against what the CALLER said
    // rather than against what the wallet actually pays. Cap == amountWei, so a
    // route that checks amountWei sees a trade exactly on the line and lets it
    // through, while the wallet is really asked for amountWei + the venue fee.
    const harness = await tradingHarness();
    await harness.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      perTradeNativeWei: ONE_BNB,
    });

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: body(),
    });

    assert.equal(res.status, 200, res.text);
    const meta = field(res, "meta") as Record<string, unknown>;
    assert.equal(
      meta["code"],
      "PER_TRADE_CAP",
      "the venue fee must be inside the cap measurement",
    );
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("passes when the cap covers amountWei plus the venue fee, and no further", async () => {
    const ok = await tradingHarness();
    await ok.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      perTradeNativeWei: ONE_BNB + VENUE_FEE,
    });
    const passed = await call(ok, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: body(),
    });
    assert.equal(
      (field(passed, "data") as Record<string, unknown>)["status"],
      "CONFIRMED",
      passed.text,
    );
    // And the value that actually went out is the venue's, not the caller's.
    const submitted = ok.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    assert.equal(submitted.calls[0]?.value, ONE_BNB + VENUE_FEE);

    // One wei tighter and the same trade is refused.
    const tight = await tradingHarness();
    await tight.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      perTradeNativeWei: ONE_BNB + VENUE_FEE - 1n,
    });
    const denied = await call(tight, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: body(),
    });
    assert.equal(
      (field(denied, "meta") as Record<string, unknown>)["code"],
      "PER_TRADE_CAP",
    );
    assert.equal(tight.provider.executeCalls.length, 0);
  });

  it("charges the venue fee against the ROLLING DAILY budget too", async () => {
    // Two trades whose declared amounts fit the daily cap exactly, but whose
    // true cost does not. The second must be refused: a daily cap that counted
    // amountWei would let both through and overspend by two venue fees.
    const harness = await tradingHarness();
    await harness.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      dailyNativeWei: 2n * ONE_BNB,
    });

    const first = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: body({ decisionId: "day-1" }),
    });
    assert.equal(
      (field(first, "data") as Record<string, unknown>)["status"],
      "CONFIRMED",
      first.text,
    );

    const second = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: body({ decisionId: "day-2" }),
    });
    assert.equal(
      (field(second, "meta") as Record<string, unknown>)["code"],
      "DAILY_CAP",
      "the first trade's venue fee must have been charged to the budget",
    );
    assert.equal(harness.provider.executeCalls.length, 1);
  });
});

describe("audit: a Four.Meme sell never sends native value", () => {
  it("submits approve/approve/sell with no value on any call", async () => {
    // A sell has no msg.value guard — it does not need one, but only because
    // no call it builds carries value. If a builder change ever attached the
    // buy's msg.value to a sell, the bound that protects buys would not be
    // there to catch it, so the invariant is pinned here directly.
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: body({ side: "sell", amountWei: "5000", decisionId: "sell-1" }),
    });

    assert.equal(res.status, 200, res.text);
    const submitted = harness.provider.executeCalls[0];
    assert.ok(submitted !== undefined);
    for (const call_ of submitted.calls) {
      assert.equal(call_.value ?? 0n, 0n, "a sell must send no native value");
    }
    const key = (field(res, "meta") as Record<string, unknown>)["idempotencyKey"];
    assert.equal((await harness.journal.get(key as string))?.nativeSpendWei, 0n);
  });
});
