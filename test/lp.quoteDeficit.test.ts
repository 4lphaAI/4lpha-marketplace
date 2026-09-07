/**
 * GRID-GAS-RESERVE P1 — a Porto quote that already reports a deficit is refused
 * BEFORE the durable bind, so the saga rolls the step back instead of parking
 * an UNKNOWN it can never resolve.
 *
 * The incident this pins: `grid-agent-01-5`, 2026-09-03 17:26 UTC. Wallet B held
 * 0.000098693 BNB; the relay quoted, the adapter bound and signed, and the SEND
 * was refused with "quote has asset deficits and is expected to fail" — a
 * post-bind throw, hence `markUnknown` + `held/shift-ambiguous` for 246 cycles.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { custom, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BNB } from "@altananetwork/sdk";
import { prepareCalls, sendPreparedCalls, signCalls } from "porto/viem/RelayActions";
import * as PortoKey from "porto/viem/Key";
import {
  PORTO_V055_ORCHESTRATOR,
  PortoStagedLpAdapter,
  encodeLpFinalCallsV1,
  fingerprintLpFinalCallsV1,
  isProvenPreBindStagedLpError,
  portoQuoteDeficits,
} from "../src/lp/preparedIntent.js";
import { validateSessionSpec } from "../src/core/session.js";

const H1 = `0x${"a1".repeat(32)}` as Hex;

describe("GRID-GAS-RESERVE P1: portoQuoteDeficits, the pure reading of the relay's own verdict", () => {
  it("is not short when the fee token deficit is zero and no asset is listed", () => {
    assert.deepEqual(portoQuoteDeficits({ feeTokenDeficit: 0n }), {
      short: false, feeTokenDeficitWei: 0n, summary: "none",
    });
    assert.equal(portoQuoteDeficits({ feeTokenDeficit: 0n, assetDeficits: [] }).short, false);
    // A listed asset whose deficit is ZERO is a report, not a shortfall.
    assert.equal(portoQuoteDeficits({ feeTokenDeficit: 0n,
      assetDeficits: [{ address: null, deficit: 0n, required: 5n }] }).short, false);
  });

  it("names the fee token shortfall and every asset deficit, native as 'native'", () => {
    const read = portoQuoteDeficits({
      feeTokenDeficit: 34_506_851_279_976n,
      assetDeficits: [
        { address: null, deficit: 34_506_851_279_976n, required: 133_200_000_000_000n },
        { address: "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", deficit: 7n },
      ],
    });
    assert.equal(read.short, true);
    assert.equal(read.feeTokenDeficitWei, 34_506_851_279_976n);
    assert.match(read.summary, /fee token short by 34506851279976 wei/u);
    assert.match(read.summary, /native short by 34506851279976 wei of 133200000000000 required/u);
    assert.match(read.summary, /0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c short by 7 wei/u);
    assert.match(read.summary, /Fund the agent wallet with BNB/u, "the remedy rides on the message");
  });
});

describe("GRID-GAS-RESERVE P1: the staged adapter refuses a deficit quote BEFORE bind", () => {
  const sessionPrivateKey = `0x${"00".repeat(31)}01` as Hex;
  const sessionAccount = privateKeyToAccount(sessionPrivateKey);
  const wallet = `0x${"34".repeat(20)}` as Address;
  const target = `0x${"56".repeat(20)}` as Address;
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  const spec = { allowedCalls: [{ to: target }],
    spendCaps: [{ limit: 1n, period: "hour" as const }], expiresAt: expiry };
  const permissions = validateSessionSpec(spec, { minSessionSeconds: 0 });
  const calls = [{ to: target, value: 0n, data: "0x" as Hex }] as const;
  const fingerprint = fingerprintLpFinalCallsV1(calls);
  const selected = PortoKey.fromSecp256k1({ privateKey: sessionPrivateKey,
    role: "session", expiry, permissions });

  function harness(quoteExtras: Record<string, unknown>) {
    const order: string[] = [];
    const prepared = {
      capabilities: { quote: { quotes: [{ chainId: 56,
        orchestrator: PORTO_V055_ORCHESTRATOR,
        intent: { eoa: wallet, executionData: encodeLpFinalCallsV1(calls), nonce: 30n,
          expiry: 0n },
        ...quoteExtras }] } },
      context: {}, digest: H1, key: selected, typedData: {},
    } as unknown as Awaited<ReturnType<typeof prepareCalls>>;
    const functions = {
      prepare: (async () => { order.push("prepare"); return prepared; }) as typeof prepareCalls,
      sign: (async () => { order.push("sign"); return `0x${"11".repeat(65)}` as Hex; }) as typeof signCalls,
      send: (async () => { order.push("send"); return { id: "0x01" as Hex }; }) as typeof sendPreparedCalls,
    };
    const adapter = new PortoStagedLpAdapter({ network: BNB,
      transport: () => custom({ request: async () => { throw new Error("unexpected RPC"); } }),
      functions, submitTimeoutMs: 1_000 });
    const base = { journalIdempotencyKey: "lp-bind", expectedBindingVersion: 0,
      sessionPrivateKey, walletAddress: wallet,
      persistedSession: { spec, permissions, publicKey: sessionAccount.publicKey, expiry },
      restoredSessionPublicKey: sessionAccount.publicKey, restoredSessionExpiry: expiry,
      calls,
      expectedExecutionDataHash: fingerprint.value.executionDataHash,
      bind: async (request: Parameters<NonNullable<Parameters<PortoStagedLpAdapter["submit"]>[0]["bind"]>>[0]) => {
        order.push("bind");
        return { ...request, boundBindingVersion: request.expectedBindingVersion + 1 };
      } } as const;
    return { adapter, base, order };
  }

  it("a clean quote still goes prepare -> bind -> sign -> send", async () => {
    const { adapter, base, order } = harness({ feeTokenDeficit: 0n });
    assert.deepEqual(await adapter.submit(base), { status: "PENDING", callsId: "0x01" });
    assert.deepEqual(order, ["prepare", "bind", "sign", "send"]);
  });

  it("a fee-token deficit is a PROVEN pre-bind refusal: bind, sign and send never run", async () => {
    const { adapter, base, order } = harness({ feeTokenDeficit: 34_506_851_279_976n });
    let failure: unknown;
    try { await adapter.submit(base); } catch (error) { failure = error; }
    assert.equal(isProvenPreBindStagedLpError(failure), true, "must be rollback-able");
    assert.match((failure as Error).message, /deficits before bind: fee token short by 34506851279976 wei/u);
    assert.deepEqual(order, ["prepare"], "nothing after prepare");
  });

  it("an asset deficit alone refuses the same way", async () => {
    const { adapter, base, order } = harness({ feeTokenDeficit: 0n,
      assetDeficits: [{ address: null, deficit: 1n, required: 2n }] });
    let failure: unknown;
    try { await adapter.submit(base); } catch (error) { failure = error; }
    assert.equal(isProvenPreBindStagedLpError(failure), true);
    assert.match((failure as Error).message, /native short by 1 wei of 2 required/u);
    assert.deepEqual(order, ["prepare"]);
  });
});
