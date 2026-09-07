/**
 * PHASE2.5 F1/F3/F4 — the exit reserve, measured instead of assumed, and then
 * SAID OUT LOUD.
 *
 * THE DEFECT (PHASE2.4-AUDIT A1, shipped unfixed on purpose and said so in three
 * places). `checkNativeCapSizing` reserves native per GRANTABLE TOKEN at
 * PROVISIONING time; the relay reimburses its gas per SUBMISSION out of the same
 * on-chain meter. A busy agent therefore exhausts the on-chain cap before the
 * off-chain one and lands in exactly the trap that check exists to prevent — a
 * sell that needs headroom it no longer has, with a pause unable to save it
 * because the shortfall is on chain.
 *
 * Arithmetic about a future day cannot answer that. The METER can, and these
 * tests are about the one property that makes the fix worth its extra chain
 * read: **the gate follows the account, not the plane's own bookkeeping.**
 *
 * F3 and F4 are about the second half of the same defect. A gate that silently
 * stops taking buys is indistinguishable from a broken agent, and a provisioning
 * check that still claims to be the guarantee sends the next reader to the wrong
 * layer. So: the refusal carries a remedy, the OWNER-SIGNED view reports the
 * exact numbers the gate refused on, and the provisioning message says which of
 * the two is the floor and which is the guarantee.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AGENT_ID,
  CHAIN_ID,
  EXEC_TOKEN,
  FakeDataPlane,
  FakeWalletProvider,
  KEY_STORE,
  NETWORK,
  NOW_SEC,
  OPERATOR_TOKEN,
  TREASURY,
  call,
  createHarness,
  ownerAccount,
  safeSecurityPayload,
  signOwnerAction,
  toReadHeader,
  tradeBody,
  tradeConfig,
  type Harness,
} from "./support/serverHarness.js";
import { createBpsFeePolicy } from "../src/ops/fees.js";
import {
  InfrastructureError,
  type NativeDayMeter,
  type WalletProvider,
} from "../src/core/types.js";
import { createServer } from "../src/server.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryNonceStore } from "../src/store/nonces.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import {
  NATIVE_RESERVE_REMEDY,
  RELAY_FEE_PER_EXIT_WEI,
  checkNativeCapSizing,
  exitReserveWei,
} from "../src/ops/policy.js";
import { GLOBAL_AGENT_SENTINEL } from "../src/auth/ownerAuth.js";


/**
 * A trade REFUSAL is HTTP 200 carrying a FAILED receipt and `meta.code` — the
 * shape an agent runtime already branches on. Asserting on the status line
 * would pass for every outcome.
 */
function refusalCode(body: Record<string, unknown>): string | undefined {
  const meta = (body["meta"] ?? {}) as Record<string, unknown>;
  const code = meta["code"];
  return typeof code === "string" ? code : undefined;
}

function receiptStatus(body: Record<string, unknown>): unknown {
  return ((body["data"] ?? {}) as Record<string, unknown>)["status"];
}

const ONE_BNB = 10n ** 18n;

/**
 * The buy every fixture here submits: 0.002 BNB, the size the live round trips
 * actually used.
 *
 * It used to be ONE BNB against a meter holding 0.0002 — which passed, because
 * the floor did not include the trade's own native. PHASE2.5-AUDIT A1: the
 * fixtures did not merely miss that defect, they asserted it.
 */
const TRADE_WEI = 2n * 10n ** 15n;

async function tradingHarness(): Promise<Harness> {
  const harness = await createHarness();
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  return harness;
}

/**
 * What a submission of ANY size must leave behind: one relay reimbursement per
 * sellable token, plus the one this submission itself owes.
 */
function standingFloor(tokens: number): bigint {
  return exitReserveWei(tokens) + RELAY_FEE_PER_EXIT_WEI;
}

/**
 * What the meter must hold for a buy of `tradeWei` to be authorised.
 *
 * The trade's own native is a TERM (PHASE2.5-AUDIT A1). The gate answers a
 * question about the meter AFTER the submission, and a predicate that omits the
 * size of the trade answers a question about the meter before it.
 */
function floorFor(tokens: number, tradeWei = TRADE_WEI): bigint {
  return tradeWei + standingFloor(tokens);
}

function meterWith(remaining: bigint, grantedTokenCount = 1): NativeDayMeter {
  // `limit` and `currentSpent` come from ONE account read, so the pair can
  // never disagree with itself — which is the point, since the defect is the
  // off-chain sum and the on-chain meter disagreeing.
  const limitWei = 10n * ONE_BNB;
  return {
    kind: "day",
    limitWei,
    currentSpentWei: limitWei - remaining,
    grantedTokenCount,
  };
}

describe("PHASE2.5 F1: a buy must leave enough native to pay for its own exit", () => {
  it("proceeds when the meter has room", async () => {
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(floorFor(1) + 1n);

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.executeCalls.length, 1);
    assert.equal(
      harness.provider.nativeDayMeterCalls.length,
      1,
      "exactly ONE extra chain read, which is the cost this fix owns",
    );
  });

  it("REFUSES one wei below the floor", async () => {
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(floorFor(1) - 1n);

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(receiptStatus(res.body), "FAILED");
    assert.equal(refusalCode(res.body), "NATIVE_RESERVE");
    assert.equal(
      harness.provider.executeCalls.length,
      0,
      "and nothing was submitted, so the refusal costs no gas",
    );
  });

  it("the floor INCLUDES the submitting trade's own relay fee", async () => {
    // PHASE2.5-REVIEW M5. Omitting this term would reintroduce A1's exact
    // mistake — forgetting that the submission being authorised also bills the
    // meter — inside A1's own fix. At exactly `exitReserveWei` the buy must
    // still refuse, because taking it would leave the exit short by its own fee.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(exitReserveWei(1));

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(receiptStatus(res.body), "FAILED", "the reserve alone is not enough");
    assert.equal(refusalCode(res.body), "NATIVE_RESERVE");
  });

  it("scales with the tokens the CHAIN says the session can sell", async () => {
    // Read from the same `spendInfos` call rather than from the grant the plane
    // remembers: PHASE2.4's posture is that the chain is the authority on what a
    // session may do NOW, so an owner's on-chain widening must move this floor.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(floorFor(1) + 1n, 3);

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(
      refusalCode(res.body),
      "NATIVE_RESERVE",
      "room for one exit is not room for three sellable tokens",
    );
  });

  it("a SELL is never gated, at any meter reading", async () => {
    // Refusing the exit IS the trap. This is the assertion that fails if the
    // exposure-increasing conjunct is ever dropped.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(0n);

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "sell", amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(
      harness.provider.nativeDayMeterCalls.length,
      0,
      "and the exit keeps its zero-chain-read property — it must not acquire a new way to fail",
    );
  });

  it("the gate follows the CHAIN, not the plane's own spend bookkeeping", async () => {
    // The whole defect in one fixture: the off-chain journal has recorded
    // nothing at all for this agent, so every off-chain sum says the budget is
    // untouched. The meter says otherwise, because the relay has been
    // reimbursing itself out of it. The chain wins.
    const harness = await tradingHarness();
    const spent = await harness.journal.sumNativeSpendSince(AGENT_ID, 0);
    assert.equal(spent, 0n, "precondition: the plane believes nothing is spent");

    harness.provider.nativeDayMeterResult = meterWith(0n);
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(refusalCode(res.body), "NATIVE_RESERVE");
  });

  it("an UNREADABLE meter refuses the buy — fail closed (REVIEW M4)", async () => {
    // Adding exposure on an unmeasured meter is the trap this exists to
    // prevent. Refusing costs a trade; proceeding costs the exit.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterError = new Error("rpc down");

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(receiptStatus(res.body), "FAILED");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("an unreadable meter does NOT gate a sell", async () => {
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterError = new Error("rpc down");

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ side: "sell", amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(res.status, 200, res.text);
  });

  it("an account with NO daily native limit is not gated", async () => {
    // No DAY row means the account enforces no daily native meter for this key
    // — there is no headroom to run out of, so there is nothing to protect.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = {
      kind: "other-period",
      grantedTokenCount: 1,
    };

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(res.status, 200, res.text);
  });

  it("the floor INCLUDES the buy's OWN native (PHASE2.5-AUDIT A1)", async () => {
    // THE FINDING, as a boundary. `standingFloor` is what a submission of any
    // size must leave behind; a buy of `TRADE_WEI` therefore needs
    // `standingFloor + TRADE_WEI`. One wei under that, the meter would be left
    // below the exit reserve — which is the trap, reached through the fix.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(
      standingFloor(1) + TRADE_WEI - 1n,
    );

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(
      refusalCode(res.body),
      "NATIVE_RESERVE",
      "the meter clears the STANDING floor and still cannot afford this trade",
    );
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("the same meter takes a SMALLER buy — the refusal is about size, not about the agent", async () => {
    // The other half of A1's boundary, and the reason it is not simply a
    // tightening: a meter that cannot afford a 0.002 BNB buy can still afford
    // one wei less than that, and the gate must let it through.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(
      standingFloor(1) + TRADE_WEI - 1n,
    );

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: (TRADE_WEI - 1n).toString(10) }),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(harness.provider.executeCalls.length, 1);
  });

  it("refuses when the trade fits but its RELAY FEE does not (REVIEW Part 4 item 4)", async () => {
    // The case the review named and the tests did not cover: `remaining -
    // nativeIn >= reserve` holds, and `remaining - nativeIn - perSubmit
    // < reserve` does not. Between those two lies exactly one relay
    // reimbursement — the one this submission itself owes.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(
      TRADE_WEI + exitReserveWei(1),
    );

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(refusalCode(res.body), "NATIVE_RESERVE");
  });

  it("counts the 4lpha FEE as native this buy spends", async () => {
    // `nativeInWei = swapNativeWei + feeWei` (`src/server.ts`), and the fee is a
    // real transfer metered against the same on-chain cap. A gate that priced
    // only the swap would authorise a buy whose fee tips the meter under.
    const harness = await createHarness({
      config: {
        trade: tradeConfig({
          feePolicy: createBpsFeePolicy({ treasury: TREASURY, bps: 100 }),
          feeTreasury: TREASURY,
          feeBps: 100,
        }),
      },
    });
    harness.dataPlane.nextSecurity = safeSecurityPayload();
    // Exactly enough for the swap and its reserve, and one wei short once the
    // 1% fee transfer is counted.
    const feeWei = TRADE_WEI / 100n;
    harness.provider.nativeDayMeterResult = meterWith(
      standingFloor(1) + TRADE_WEI + feeWei - 1n,
    );

    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });

    assert.equal(refusalCode(res.body), "NATIVE_RESERVE");
  });

  it("a PAUSED agent is refused before the meter is ever read, and its exit still runs", async () => {
    // The spec's "F1 + kill switch" obligation (PHASE2.5-AUDIT A11): this gate
    // must not become a second way to trap a position. A paused agent's buy is
    // refused upstream at `authorizeExecute`, and its SELL is not gated by
    // either check.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(0n);
    await harness.killswitch.pauseAgent(AGENT_ID, ownerAccount.address);

    const paused = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });
    assert.equal(paused.status, 409, paused.text);
    assert.equal(
      harness.provider.nativeDayMeterCalls.length,
      0,
      "a pause is cheaper than a chain read and must come first",
    );

    await harness.killswitch.unpauseAgent(AGENT_ID, ownerAccount.address);
    const sold = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({
        side: "sell",
        decisionId: "d-trade-exit",
        amountWei: TRADE_WEI.toString(10),
      }),
    });
    assert.equal(sold.status, 200, sold.text);
  });
});

/* -------------------------------------------------------------------------- */
/* A3 — an outage is not a policy refusal                                     */
/* -------------------------------------------------------------------------- */

describe("PHASE2.5 F1: an unreadable meter is classified as TRANSPORT (REVIEW M4)", () => {
  it("does not blame the session for a dead node", async () => {
    // PHASE2.5-AUDIT A3. Before F1 an ordinary buy made ZERO chain reads, so an
    // outage could not reach this route's refusal shape at all; it can now, on
    // every buy. An operator triaging a burst of `deniedBy: session` refusals
    // goes and inspects a session grant that is perfectly fine — which is the
    // diagnosis pass PHASE3.1 already paid for once.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterError = new Error("connect ETIMEDOUT");

    const body = await buy(harness);
    const meta = body["meta"] as Record<string, unknown>;
    assert.equal(meta["deniedBy"], "transport");
    assert.notEqual(
      meta["code"],
      "NATIVE_RESERVE",
      "an outage is not the reserve refusing",
    );
    assert.equal(
      ((body["data"] ?? {}) as Record<string, unknown>)["failureCode"],
      "PROVIDER_ERROR",
      "and the RECEIPT carries the transport class too — a caller that branches " +
        "on the receipt alone must not read a dead endpoint as NOT_ALLOWED",
    );
  });

  it("carries the mapped INFRASTRUCTURE class for a timeout", async () => {
    // `mapProviderError` is the plane's ONE classifier and the provider now runs
    // its read through it. An `InfrastructureError` must survive to the caller
    // rather than being flattened into the generic provider class.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterError = new InfrastructureError(
      "Chain pre-flight read timed out.",
    );

    const body = await buy(harness);
    const meta = body["meta"] as Record<string, unknown>;
    assert.equal(meta["deniedBy"], "transport");
    assert.equal(meta["code"], "INFRASTRUCTURE_ERROR");
    assert.equal(
      ((body["data"] ?? {}) as Record<string, unknown>)["failureCode"],
      "INFRASTRUCTURE_ERROR",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* F4 — the owner can see it                                                  */
/* -------------------------------------------------------------------------- */

/** Read the owner-signed view and hand back its `nativeMeter` block, if any. */
async function ownerMeter(
  harness: Harness,
): Promise<Record<string, unknown> | undefined> {
  const envelope = await signOwnerAction("read", { agentId: AGENT_ID });
  const res = await call(harness, `/agents/${AGENT_ID}/owner-view`, {
    headers: { "x-owner-action": toReadHeader(envelope) },
  });
  assert.equal(res.status, 200, res.text);
  const data = res.body["data"] as Record<string, unknown>;
  return data["nativeMeter"] as Record<string, unknown> | undefined;
}

/** One buy at the standard size, returning the response body. */
async function buy(harness: Harness): Promise<Record<string, unknown>> {
  const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
    method: "POST",
    body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
  });
  return res.body;
}

describe("PHASE2.5 F4: an agent that stopped taking buys says so, to its owner", () => {
  it("reports the SAME numbers the gate refused on", async () => {
    // The A3 obligation, and the reason the arithmetic lives in ONE seam: the
    // gate and the view must not be able to disagree.
    //
    // The fixture is a meter that cannot afford a trade of ANY size — one wei
    // under the standing floor — so both sides answer about the same state:
    // the gate refuses, and the view says buys are stopped and by how much.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(standingFloor(1) - 1n);

    const refused = await buy(harness);
    assert.equal(refusalCode(refused), "NATIVE_RESERVE");

    const meter = await ownerMeter(harness);
    assert.ok(meter, "the owner view must carry the meter it was refused on");
    assert.equal(meter["readable"], true);
    assert.equal(meter["metered"], true);
    assert.equal(meter["buysRefused"], true);
    assert.equal(
      meter["remainingWei"],
      (standingFloor(1) - 1n).toString(10),
      "the remaining headroom, as the gate computed it",
    );
    // The view reports a STANDING floor: it authorises no trade, so its
    // `requiredWei` carries no trade size (PHASE2.5-AUDIT A1).
    assert.equal(meter["requiredWei"], standingFloor(1).toString(10));
    assert.equal(
      meter["shortfallWei"],
      "1",
      "and BY HOW MUCH — audit A9's lesson: a refusal without a figure is not actionable",
    );
    assert.equal(meter["headroomForSubmissionWei"], "0", "no trade of any size fits");
    assert.equal(meter["reserveWei"], exitReserveWei(1).toString(10));
    assert.equal(meter["ownFeeWei"], RELAY_FEE_PER_EXIT_WEI.toString(10));
    assert.equal(meter["overCap"], false);
  });

  it("says buys are FLOWING on the same fixture one wei higher", async () => {
    // The other side of the same boundary. Together these two fail if EITHER
    // the gate or the view is mutated alone, which is what the shared seam buys.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(floorFor(1));

    const taken = await buy(harness);
    assert.equal(refusalCode(taken), undefined, "the buy is not refused here");
    assert.equal(harness.provider.executeCalls.length, 1);

    const meter = await ownerMeter(harness);
    assert.ok(meter);
    assert.equal(meter["buysRefused"], false);
    assert.equal(meter["shortfallWei"], "0");
    assert.equal(
      meter["note"],
      undefined,
      "no remedy is offered when there is nothing to remedy",
    );
  });

  it("an unreadable meter is reported as refusing, and does not take the view down", async () => {
    // The gate fails closed on an unreadable meter, so the honest report is that
    // buys are stopped — and that the fix is the RPC, not the cap. The view
    // itself must still answer: a dashboard that dies with the node is a
    // dashboard nobody can use to diagnose the node.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterError = new Error("rpc down");

    const meter = await ownerMeter(harness);
    assert.ok(meter);
    assert.equal(meter["readable"], false);
    assert.equal(meter["buysRefused"], true);
    assert.match(String(meter["note"]), /could not be read/);
    assert.doesNotMatch(
      String(meter["note"]),
      /rpc down/,
      "and the provider's own error text is not echoed into an account read",
    );
  });

  it("a native grant at another PERIOD reads as ungated, not as healthy-with-numbers", async () => {
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = {
      kind: "other-period",
      grantedTokenCount: 1,
    };

    const meter = await ownerMeter(harness);
    assert.ok(meter);
    assert.equal(meter["metered"], false);
    assert.equal(meter["nativeGranted"], true);
    assert.equal(meter["buysRefused"], false);
    assert.equal(meter["limitWei"], undefined, "there is no limit to report");
  });

  it("NO native grant at all does NOT read as 'nothing is gated' (PHASE2.5-AUDIT A6)", async () => {
    // Both accounts are unmetered today and both are ungated by F1, but only one
    // of them can trade. FINDINGS (h): with no spend row the account finds no
    // limit for the native the buy spends and the batch reverts in the relay's
    // simulation — PENDING, no transaction, no gas, which reads like a slow
    // relay rather than a refusal. Telling this owner "nothing is gated" sends
    // them to look at the wrong layer, or at a cap that is not the problem.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = {
      kind: "no-native-grant",
      grantedTokenCount: 1,
    };

    const meter = await ownerMeter(harness);
    assert.ok(meter);
    assert.equal(meter["metered"], false);
    assert.equal(meter["nativeGranted"], false);
    const note = String(meter["note"]);
    assert.match(note, /NO native spend grant/);
    assert.match(note, /not the same as unlimited/i);
    assert.match(note, /grant/i);
    assert.doesNotMatch(
      note,
      /no trade is gated on it/,
      "the reassuring sentence belongs to the OTHER account",
    );
  });

  it("reports an over-spent cap as over-spent (PHASE2.5-AUDIT A10)", async () => {
    // `setSpendLimit` writes an absolute value, so an owner can lower a cap
    // below what the period has already spent. `remainingWei` goes negative,
    // which is the truth; `overCap` says so, so a UI does not have to infer it
    // from a minus sign in what it renders as a balance.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(-5n);

    const meter = await ownerMeter(harness);
    assert.ok(meter);
    assert.equal(meter["overCap"], true);
    assert.equal(meter["remainingWei"], "-5");
    assert.equal(meter["buysRefused"], true);
    assert.equal(
      meter["headroomForSubmissionWei"],
      "0",
      "and no trade of any size fits — never a negative allowance",
    );
  });

  it("publishes the largest trade that would still pass, and the gate agrees to the wei", async () => {
    // PHASE2.5-AUDIT A1's other half. `remainingWei` was never the spendable
    // number — it includes the exit reserve and the next submission's relay fee
    // — so a UI rendering it as headroom overstates what the gate will take.
    // `headroomForSubmissionWei` is the number that is true, and this test binds
    // it to the gate's behaviour rather than to the formula that produced it.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(standingFloor(1) + TRADE_WEI);

    const meter = await ownerMeter(harness);
    assert.ok(meter);
    assert.equal(meter["headroomForSubmissionWei"], TRADE_WEI.toString(10));

    const atTheLimit = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: TRADE_WEI.toString(10) }),
    });
    assert.equal(atTheLimit.status, 200, atTheLimit.text);
    assert.equal(harness.provider.executeCalls.length, 1, "exactly that size passes");

    const overIt = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({
        decisionId: "d-trade-over",
        amountWei: (TRADE_WEI + 1n).toString(10),
      }),
    });
    assert.equal(
      refusalCode(overIt.body),
      "NATIVE_RESERVE",
      "and one wei more does not",
    );
  });

  it("the RUNTIME view carries no meter at all (REVIEW M3)", async () => {
    // `GET /agents/:id` is reachable with the SHARED exec token. Publishing a
    // per-tenant on-chain figure there would be a new cross-tenant channel — the
    // exact opposite of what the public multi-tenant posture demands.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(floorFor(1) - 1n);

    const res = await call(harness, `/agents/${AGENT_ID}`);
    assert.equal(res.status, 200, res.text);
    const data = res.body["data"] as Record<string, unknown>;
    assert.equal(data["nativeMeter"], undefined);
    assert.equal(
      harness.provider.nativeDayMeterCalls.length,
      0,
      "and it does not even take the read",
    );
  });

  it("the owner LIST route takes no per-agent chain read", async () => {
    // One slow node must not be able to hang a whole dashboard.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(floorFor(1) - 1n);

    const envelope = await signOwnerAction(
      "read",
      { scope: "list" },
      { agentId: GLOBAL_AGENT_SENTINEL },
    );
    const res = await call(harness, "/agents", {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(res.status, 200, res.text);
    const rows = res.body["data"] as Record<string, unknown>[];
    for (const row of rows) assert.equal(row["nativeMeter"], undefined);
    assert.equal(harness.provider.nativeDayMeterCalls.length, 0);
  });

  it("identifies the meter by PUBLIC facts — the owner read decrypts no session key", async () => {
    // `spendInfos` signs nothing, so this read must not reach
    // `getAgentSessionKey`. `test/secretDiscipline.test.ts` pins the source-text
    // half (exactly one reference, inside `withSessionKey`); this pins the
    // behaviour: the params carry a wallet and a PUBLIC key, and no session.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(floorFor(1));

    await ownerMeter(harness);
    assert.equal(harness.provider.nativeDayMeterCalls.length, 1);
    const params = harness.provider.nativeDayMeterCalls[0] as unknown as Record<
      string,
      unknown
    >;
    assert.equal(typeof params["walletAddress"], "string");
    assert.equal(typeof params["publicKey"], "string");
    assert.equal(
      params["session"],
      undefined,
      "a read that needs no signer must not ask for one",
    );
    // PHASE2.5-FIXREVIEW F1: the parameter existed and no caller passed one, so
    // an owner who closed the tab left a chain read running — and a NORMATIVE
    // phase-doc sentence claimed otherwise. Pinned as behaviour, not prose.
    assert.ok(
      params["signal"] instanceof AbortSignal,
      "the client's signal reaches the provider",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The refusal an owner can act on                                            */
/* -------------------------------------------------------------------------- */

describe("PHASE2.5: a NATIVE_RESERVE refusal names its remedy", () => {
  it("names the ON-CHAIN action, which every reader can actually take", async () => {
    // REVIEW erratum 2 made a workable remedy normative; PHASE2.5-AUDIT A2 found
    // the first one was not workable for the population it is shown to. Under
    // the public multi-tenant posture the reader is a TENANT, not the operator:
    // they have no `.env` with an owner key and no shell on this box. The
    // remedy that works for them is the owner self-call itself.
    const harness = await tradingHarness();
    harness.provider.nativeDayMeterResult = meterWith(floorFor(1) - 1n);

    const body = await buy(harness);
    const meta = body["meta"] as Record<string, unknown>;
    const note = String(meta["note"] ?? "");
    assert.match(note, /setSpendLimit/, "the call the owner's wallet makes");
    assert.match(note, /owner-view/, "and where the figures are");
    assert.match(
      note,
      /NOT the path for a self-serve tenant/,
      "the script is named as an operator affordance, and marked as one",
    );
  });

  it("the operator command it prints would actually run (PHASE2.5-AUDIT A2)", () => {
    // The old text omitted the mainnet confirmation flag, so an operator who
    // copied it verbatim on chain 56 got a throw rather than a raised cap. A
    // string-contains assertion could not see that, so this cross-checks the
    // advertised flags against the SCRIPT'S OWN parser and its confirmation
    // literal — either side drifting fails this.
    const script = readFileSync("scripts/owner-add-spend-limit.ts", "utf8");
    const confirmation = /const MAINNET_CONFIRMATION = "([^"]+)"/u.exec(script);
    assert.ok(confirmation, "the script still gates mainnet on a confirmation");
    const required = confirmation[1] ?? "";
    assert.match(NATIVE_RESERVE_REMEDY, new RegExp(`--confirm ${required}`));
    for (const flag of ["session-var", "native-cap", "confirm"]) {
      assert.match(NATIVE_RESERVE_REMEDY, new RegExp(`--${flag}`));
      assert.match(
        script,
        new RegExp(`arg\\("${flag}"`),
        `the script must actually read --${flag}`,
      );
    }
  });

  it("carries NO per-tenant figures on the exec-token route (REVIEW M3)", async () => {
    // The trade route is authorised by the SHARED exec token. The numbers live
    // on the owner-signed view; this note may only say where to look.
    const harness = await tradingHarness();
    const remaining = floorFor(1) - 1n;
    harness.provider.nativeDayMeterResult = meterWith(remaining);

    const body = await buy(harness);
    const note = String((body["meta"] as Record<string, unknown>)["note"] ?? "");
    assert.doesNotMatch(note, new RegExp(remaining.toString(10)));
    // The zero address and the period constant are protocol literals the remedy
    // has to name to be actionable; they say nothing about this tenant. Strip
    // them, then assert nothing that looks like a wei figure survives.
    const withoutLiterals = note.replace(/0x0+/gu, "0xNATIVE");
    assert.doesNotMatch(withoutLiterals, /\d{6,}/u, "no wei figure of any kind");
  });

  it("offers no remedy note on refusals that are not about the meter", async () => {
    const harness = await tradingHarness();
    harness.provider.preflightError = new Error("session says no");

    const body = await buy(harness);
    const meta = body["meta"] as Record<string, unknown>;
    assert.notEqual(meta["code"], "NATIVE_RESERVE");
    assert.equal(meta["note"], undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* A5 — the capability is asserted at boot, not discovered by silence          */
/* -------------------------------------------------------------------------- */

describe("PHASE2.5 F1: a provider with no meter capability fails the BOOT", () => {
  /** The harness's provider, with the optional method removed. */
  function meterlessProvider(): WalletProvider {
    const provider = new FakeWalletProvider();
    // An INSTANCE property shadowing the prototype method: `delete` would not
    // remove an inherited one, and the gate tests `!== undefined`.
    Object.defineProperty(provider, "nativeDayMeter", { value: undefined });
    return provider;
  }

  function serverWith(provider: WalletProvider, trade: boolean): void {
    createServer({
      agentStore: new MemoryAgentStore(null, () => NOW_SEC * 1000),
      journal: new MemoryExecutionJournal(() => NOW_SEC * 1000),
      nonceStore: new MemoryNonceStore(),
      killswitch: new MemoryKillSwitch(() => NOW_SEC * 1000),
      providerRegistry: { get: () => provider },
      dataPlane: new FakeDataPlane(),
      config: {
        chainId: CHAIN_ID,
        network: NETWORK,
        keyStore: KEY_STORE,
        execToken: EXEC_TOKEN,
        operatorToken: OPERATOR_TOKEN,
        ...(trade ? { trade: tradeConfig() } : {}),
      },
    });
  }

  it("refuses to start when a trade runtime is configured", async () => {
    // PHASE2.5-AUDIT A5. The gate reads `provider.nativeDayMeter !== undefined`,
    // so a provider without the method disables the whole phase for every agent
    // — no log, no refusal, an owner view that says "not asked". A money-path
    // guarantee that a missing method can switch off must fail where somebody is
    // watching. The interface docstring claimed this assertion existed for a
    // whole phase before it did.
    assert.throws(
      () => serverWith(meterlessProvider(), true),
      /does not implement nativeDayMeter/,
    );
  });

  it("starts fine when no trade runtime is configured", () => {
    // An LP-only or read-only deployment does not serve the money path this
    // protects, and must not be made to carry a capability it never reaches.
    assert.doesNotThrow(() => serverWith(meterlessProvider(), false));
  });

  it("a server with no trade config cannot execute a trade at all", async () => {
    // PHASE2.5-FIXREVIEW F2. The route is registered unconditionally while the
    // guard keys on `config.trade`, which looks like a hole one config field
    // wide. It is not, and THIS is the implication that argument rests on:
    // venues only ever arrive inside `config.trade`, and every venue branch
    // refuses without its address — so a server without the field serves a
    // route that can never attach native or spend the meter.
    //
    // A test rather than a comment, because the comment is what would rot.
    const harness = await createHarness({ omitTrade: true });
    harness.dataPlane.nextSecurity = safeSecurityPayload();
    harness.provider.nativeDayMeterResult = meterWith(0n);

    // Each body must be VALID for its venue, or the refusal proves nothing
    // about venues (PHASE2.5-FIXREVIEW2 G1: the first version sent `pancake_v3`
    // with no route and got `"route.fees" is required`, so a quarter of this
    // loop was pinning body validation).
    const cases = [
      { venue: "pancake", extra: {} },
      { venue: "pancake_v3", extra: { route: { hops: [], fees: [500] } } },
      { venue: "fourmeme", extra: {} },
      { venue: "flap", extra: {} },
    ] as const;

    const refusals: string[] = [];
    for (const { venue, extra } of cases) {
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({
          venue,
          decisionId: `d-no-venue-${venue}`,
          amountWei: TRADE_WEI.toString(10),
          ...extra,
        }),
      });
      const error = (res.body["error"] ?? {}) as Record<string, unknown>;
      refusals.push(`${venue}:${res.status}:${String(error["message"] ?? "")}`);
    }

    // Asserted AFTER the loop, and on the REASON — the earlier version asserted
    // `status !== 200` inside the loop, which would have passed on a 404, a
    // malformed body or a kill-switch refusal, and whose throw made the
    // `executeCalls` check below unreachable.
    assert.deepEqual(
      refusals,
      cases.map(
        ({ venue }) => `${venue}:400:The ${venue} venue is not configured for this chain.`,
      ),
      "every venue must be refused BECAUSE it has no address on this server",
    );
    assert.equal(
      harness.provider.executeCalls.length,
      0,
      "nothing reached the relay, so no ungated buy was possible",
    );
  });

  it("starts fine with a provider that HAS the capability", () => {
    assert.doesNotThrow(() => serverWith(new FakeWalletProvider(), true));
  });
});

/* -------------------------------------------------------------------------- */
/* F3 — the provisioning check stops overclaiming, without losing disclosure   */
/* -------------------------------------------------------------------------- */

describe("PHASE2.5 F3: which check is the floor and which is the guarantee", () => {
  /** The refusal this check produces for a cap that cannot cover its own budget. */
  const shortfallMessage = (): string => {
    const sized = checkNativeCapSizing({
      onChainDailyCapWei: ONE_BNB,
      offChainDailyCapWei: ONE_BNB,
      grantedTokenCount: 1,
    });
    if (sized.ok || sized.kind !== "shortfall") {
      throw new Error("fixture expected a shortfall");
    }
    return sized.message;
  };

  it("still discloses that the reserve is sized on the WRONG axis", () => {
    // The erratum the review caught: taken literally, "drop the paragraph" would
    // have DELETED the disclosure PHASE2.4's post-audit fix added. It stays.
    const message = shortfallMessage();
    assert.match(message, /GRANTABLE TOKEN, not per SUBMISSION/);
    assert.match(message, /floor, not a guarantee/);
  });

  it("names the live submit-time check as where the guarantee now lives", () => {
    const message = shortfallMessage();
    assert.match(message, /GUARANTEE LIVES AT SUBMIT TIME/);
    assert.match(message, /native day meter/);
  });

  it("keeps the shortfall figure structural, not only in prose", () => {
    // Audit A9: `sanitizeMessage` truncates the prose at 280 characters, long
    // before this figure, which is why it is a field. Appending F3's sentence
    // must not have moved anything an owner needs into that tail.
    const sized = checkNativeCapSizing({
      onChainDailyCapWei: ONE_BNB,
      offChainDailyCapWei: ONE_BNB,
      grantedTokenCount: 1,
    });
    if (sized.ok || sized.kind !== "shortfall") {
      throw new Error("fixture expected a shortfall");
    }
    assert.equal(sized.shortfallWei, exitReserveWei(1) + 1n);
  });
});
