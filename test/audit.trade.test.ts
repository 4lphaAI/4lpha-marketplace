/**
 * Independent audit pass over the trade route: attack it rather than trust it.
 *
 * The route builds calldata from caller input, which is a larger surface than
 * `/execute`'s pass-through. So the questions here are all variants of one:
 * can any field of any request body change WHO gets the tokens, WHO gets the
 * allowance, or WHETHER the checks run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress, type Address } from "viem";
import {
  AGENT_ID,
  EXEC_TOKEN,
  KEY_STORE,
  MANAGER,
  OPERATOR_TOKEN,
  OTHER_OWNER_ADDRESS,
  OWNER_ADDRESS,
  ROUTER,
  SESSION_KEY,
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

describe("AUDIT: trade wire validation", () => {
  it("refuses every non-string venue and side shape", async () => {
    const harness = await tradingHarness();
    const hostile: Array<Record<string, unknown>> = [
      { venue: "PANCAKE" },
      { venue: "Pancake" },
      { venue: " pancake" },
      { venue: "pancake " },
      { venue: ["pancake"] },
      { venue: { toString: "pancake" } },
      { venue: null },
      { venue: 0 },
      { venue: "uniswap" },
      { venue: "pancake\u0000" },
      { side: "BUY" },
      { side: ["buy"] },
      { side: { buy: true } },
      { side: true },
      { side: "buy\n" },
    ];
    for (const [index, override] of hostile.entries()) {
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ decisionId: `d-${index}`, ...override }),
      });
      assert.equal(res.status, 400, `${JSON.stringify(override)} → ${res.status}`);
      assert.equal(errorCode(res.body), "invalid_request");
    }
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses every non-address token shape", async () => {
    const harness = await tradingHarness();
    const hostile: unknown[] = [
      "not-an-address",
      "0x",
      "0x1234",
      [TOKEN],
      { address: TOKEN },
      null,
      42,
      `${TOKEN}0000`,
      `${TOKEN} `,
    ];
    for (const [index, token] of hostile.entries()) {
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ decisionId: `d-t-${index}`, token }),
      });
      assert.equal(res.status, 400, `token=${JSON.stringify(token)}`);
    }
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses non-positive, negative and oversized amounts", async () => {
    const harness = await tradingHarness();
    const hostile: unknown[] = ["0", 0, "-1", -1, "1.5", "1e18", "", null, [], {}, "9".repeat(79)];
    for (const field of ["amountWei", "minOutWei", "quotedOutWei"]) {
      for (const [index, value] of hostile.entries()) {
        const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
          method: "POST",
          body: tradeBody({ decisionId: `d-${field}-${index}`, [field]: value }),
        });
        assert.equal(res.status, 400, `${field}=${JSON.stringify(value)}`);
      }
    }
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("requires a decisionId", async () => {
    const harness = await tradingHarness();
    for (const decisionId of [undefined, "", null, 1, [], {}, "x".repeat(129)]) {
      const body = tradeBody();
      if (decisionId === undefined) delete body["decisionId"];
      else body["decisionId"] = decisionId;
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body,
      });
      assert.equal(res.status, 400, `decisionId=${JSON.stringify(decisionId)}`);
    }
  });
});

describe("AUDIT: the token blacklist", () => {
  it("400s each forbidden token, and the provider is never called", async () => {
    // `token` is the one caller-supplied address this server builds calls
    // AGAINST. `token = <the wallet>` would emit approve() on the account
    // contract itself — the self-call escalation session.ts exists to block,
    // reached from a request body instead of an allowlist.
    const forbidden: Array<readonly [string, Address]> = [
      ["the agent wallet", OWNER_ADDRESS],
      ["the KeyStore", KEY_STORE],
      ["the pancake router", ROUTER],
      ["WBNB", WBNB],
      ["the four.meme manager", MANAGER],
      ["the fee treasury", TREASURY],
      ["the zero address", getAddress(zeroAddress)],
    ];
    for (const [label, token] of forbidden) {
      const harness = await tradingHarness({ config: { trade: FEE_TRADE } });
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ token }),
      });
      assert.equal(res.status, 400, `${label} must be refused, got ${res.status}`);
      assert.equal(errorCode(res.body), "invalid_request");
      assert.equal(harness.provider.executeCalls.length, 0, label);
      assert.equal(
        harness.dataPlane.requested.length,
        0,
        `${label}: the blacklist must run before any outbound read`,
      );
    }
  });

  it("catches a forbidden token in any casing", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ token: ROUTER.toLowerCase() }),
    });
    assert.equal(res.status, 400);
  });

  it("still allows an ordinary token", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody(),
    });
    assert.equal(res.status, 200, res.text);
  });
});

describe("AUDIT: the recipient cannot be influenced", () => {
  it("ignores every recipient-shaped field a body might carry", async () => {
    const attacker = getAddress("0x00000000000000000000000000000000BadBad00");
    const harness = await tradingHarness();
    const injections: Array<Record<string, unknown>> = [
      { recipient: attacker },
      { to: attacker },
      { walletAddress: attacker },
      { wallet: attacker },
      { ownerAddress: attacker },
      { params: { recipient: attacker } },
      { calls: [{ to: attacker, value: "1" }] },
      { path: [attacker] },
      { deadline: 1 },
      { spender: attacker },
      { router: attacker },
      { manager: attacker },
      { treasury: attacker },
    ];

    for (const [index, extra] of injections.entries()) {
      await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ decisionId: `d-inj-${index}`, ...extra }),
      });
    }

    assert.ok(harness.provider.executeCalls.length > 0);
    const attackerWord = attacker.slice(2).toLowerCase();
    for (const submitted of harness.provider.executeCalls) {
      for (const c of submitted.calls) {
        assert.notEqual(
          c.to.toLowerCase(),
          attacker.toLowerCase(),
          "a request field reached a call target",
        );
        assert.doesNotMatch(
          c.data ?? "0x",
          new RegExp(attackerWord),
          "a request field reached the calldata",
        );
      }
      // And the recipient is always the row's wallet.
      const swap = submitted.calls[0];
      assert.match(
        swap?.data ?? "0x",
        new RegExp(OWNER_ADDRESS.slice(2).toLowerCase()),
      );
    }
  });

  it("uses the ROW's wallet, not another tenant's", async () => {
    const harness = await tradingHarness();
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ ownerAddress: OTHER_OWNER_ADDRESS }),
    });
    assert.equal(res.status, 200, res.text);
    const swap = harness.provider.executeCalls[0]?.calls[0];
    assert.doesNotMatch(
      swap?.data ?? "0x",
      new RegExp(OTHER_OWNER_ADDRESS.slice(2).toLowerCase()),
    );
  });
});

describe("AUDIT: the spender cannot be influenced", () => {
  it("approves only the venue, whatever the body claims", async () => {
    const attacker = getAddress("0x00000000000000000000000000000000BadBad01");
    const harness = await tradingHarness();
    for (const [index, extra] of [
      { spender: attacker },
      { router: attacker },
      { manager: attacker },
      { venueOverride: attacker },
    ].entries()) {
      await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ decisionId: `d-sp-${index}`, side: "sell", amountWei: "10", ...extra }),
      });
    }
    assert.ok(harness.provider.executeCalls.length > 0);
    for (const submitted of harness.provider.executeCalls) {
      for (const c of submitted.calls) {
        if (!c.data?.startsWith("0x095ea7b3")) continue;
        const spenderWord = c.data.slice(10, 74);
        assert.equal(
          `0x${spenderWord.slice(24)}`,
          ROUTER.toLowerCase(),
          "the approval spender must be the venue",
        );
      }
    }
  });
});

describe("AUDIT: the local policy check", () => {
  it("cannot be turned off by any body shape", async () => {
    const harness = await tradingHarness();
    const shapes: Array<Record<string, unknown>> = [
      { bypassLocalPolicyCheck: true },
      { bypass_local_policy_check: true },
      { params: { bypassLocalPolicyCheck: true } },
      { session: { bypassLocalPolicyCheck: true } },
      { options: { bypassLocalPolicyCheck: true } },
      { trade: { bypassLocalPolicyCheck: true } },
    ];
    for (const [index, extra] of shapes.entries()) {
      await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ decisionId: `d-bp-${index}`, ...extra }),
      });
    }
    assert.ok(harness.provider.executeCalls.length > 0);
    for (const submitted of harness.provider.executeCalls) {
      assert.equal(submitted.bypassLocalPolicyCheck, false);
    }
  });
});

describe("AUDIT: tenancy and credentials", () => {
  it("refuses a missing or wrong exec token", async () => {
    const harness = await tradingHarness();
    const missing = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      noExecToken: true,
      body: tradeBody(),
    });
    assert.equal(missing.status, 401);
    const wrong = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      execToken: "not-the-token",
      body: tradeBody(),
    });
    assert.equal(wrong.status, 401);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("returns the byte-identical 404 for an unknown agent", async () => {
    const harness = await tradingHarness();
    const unknown = await call(harness, "/agents/no-such-agent/trade", {
      method: "POST",
      body: tradeBody(),
    });
    const missingRoute = await call(harness, "/no-such-route", { method: "POST" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.text, missingRoute.text);
  });
});

describe("AUDIT: secret egress", () => {
  it("leaks neither the session key nor a credential on any trade path", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    console.error = (...args: unknown[]) => void logs.push(args.join(" "));
    console.warn = (...args: unknown[]) => void logs.push(args.join(" "));

    let bodies = "";
    try {
      const harness = await tradingHarness({ config: { trade: FEE_TRADE } });
      harness.dataPlane.securityError = new Error(`upstream said ${SESSION_KEY}`);
      const responses = [
        await call(harness, `/agents/${AGENT_ID}/trade`, {
          method: "POST",
          body: tradeBody({ decisionId: "d-1" }),
        }),
        await call(harness, `/agents/${AGENT_ID}/trade`, {
          method: "POST",
          body: tradeBody({ decisionId: "d-2", side: "sell", amountWei: "10" }),
        }),
        await call(harness, `/agents/${AGENT_ID}/trade`, {
          method: "POST",
          body: tradeBody({ decisionId: "d-3", venue: "fourmeme" }),
        }),
        await call(harness, `/agents/${AGENT_ID}/trade`, {
          method: "POST",
          body: tradeBody({ decisionId: "d-4", token: "nope" }),
        }),
      ];
      bodies = responses.map((r) => r.text).join("\n");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }

    const haystack = `${bodies}\n${logs.join("\n")}`;
    assert.doesNotMatch(haystack, new RegExp(SESSION_KEY.slice(2), "i"));
    assert.ok(!haystack.includes(EXEC_TOKEN));
    assert.ok(!haystack.includes(OPERATOR_TOKEN));
    assert.doesNotMatch(haystack, /upstream said/i);
  });
});

describe("AUDIT: outbound origins", () => {
  it("asks the data plane for security/ and NOTHING else — never fourmeme/", async () => {
    // PHASE2.1 R7. The invariant is precise now: the data-plane CLIENT contacts
    // exactly one host, and third-party market judgement comes only from there.
    // A Four.Meme quote is CHAIN STATE and travels over the provider's
    // chain-id-pinned RPC, the same client `getTokenBalance` uses. So the trade
    // path must reach `security/` and nothing else — in particular there must
    // be no `fourmeme/` request, from either venue, on either side.
    const harness = await tradingHarness();
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-1" }),
    });
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ decisionId: "d-2", venue: "fourmeme" }),
    });
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({
        decisionId: "d-3",
        venue: "fourmeme",
        side: "sell",
        amountWei: "5000",
      }),
    });
    assert.ok(harness.dataPlane.requested.length > 0);
    for (const path of harness.dataPlane.requested) {
      assert.match(
        path,
        /^security\//,
        `the trade path reached an unexpected data-plane route: ${path}`,
      );
    }
    assert.equal(
      harness.dataPlane.requested.filter((p) => p.startsWith("fourmeme")).length,
      0,
      "the data-plane client must never be asked for a Four.Meme quote",
    );
    // And the quote really was read — through the PROVIDER, once per fourmeme
    // trade. An assertion that only proved absence would also pass if the
    // route had silently stopped resolving the venue at all.
    assert.equal(harness.provider.fourMemeReads.length, 2);
  });

  it("never reads the data plane when the wire input is already invalid", async () => {
    const harness = await tradingHarness();
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "uniswap" }),
    });
    await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: "0" }),
    });
    assert.deepEqual(harness.dataPlane.requested, []);
  });
});
