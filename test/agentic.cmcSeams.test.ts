import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { createCmcRuntime, type CmcRuntimeTarget } from "../src/trade/cmcRuntime.js";
import { CMC_PAYEE, CMC_PRICE_ATOMIC, CMC_SPENDER, type CmcChallenge } from "../src/trade/cmc.js";
import { readSignedAuthorization } from "../src/trade/cmcPayment.js";
import { USDT_56 } from "../src/trade/settlement.js";

const NOW = 1_900_000_000_000;
const W = getAddress("0x1111111111111111111111111111111111111111");
const H = `0x${"22".repeat(32)}` as Hex;

describe("Agentic CMC additive seams", () => {
  it("rebinds nonce and deadline together, using the store clock", async () => {
    let time = NOW;
    const store = new MemoryTradeCmcStore(() => time);
    await store.putInitial({ agentId: "agentic-cmc", ownerAddress: W, wallet: W, totalWei: 2n * 10n ** 18n });
    await store.setSetup({ agentId: "agentic-cmc", ownerAddress: W, wallet: W, generation: 0,
      sessionPublicKey: H, sessionExpiry: Math.floor(NOW / 1000) + 604800, allowanceWei: 2n * 10n ** 18n });
    await store.setCapability({ agentId: "agentic-cmc", ownerAddress: W, generation: 0, available: true });
    assert.equal(await store.claimNewsSlot({ agentId: "agentic-cmc", ownerAddress: W, operationId: "op", nowMs: NOW }), true);
    assert.ok(await store.reserve({ agentId: "agentic-cmc", ownerAddress: W, wallet: W, operationId: "op", attemptId: "attempt", amountWei: 10n ** 16n }));
    assert.ok(await store.prepare({ agentId: "agentic-cmc", ownerAddress: W, wallet: W, operationId: "op", generation: 0,
      sessionPublicKey: H, sessionExpiry: Math.floor(NOW / 1000) + 604800, asset: USDT_56, amountWei: 10n ** 16n,
      spender: CMC_SPENDER, payee: CMC_PAYEE, witnessTo: CMC_PAYEE, validAfter: 0n, deadline: BigInt(Math.floor(NOW / 1000) + 500),
      nonce: 1n, requestDigest: H, bodyHash: H }));
    const base = store.snapshot("agentic-cmc");
    const input = { agentId: "agentic-cmc", ownerAddress: W, operationId: "op", budgetGeneration: 0,
      preparedNonce: 1n, signedNonce: 2n, signedDeadline: BigInt(Math.floor(NOW / 1000) + 510), signedValidAfter: 0n, sessionExpiry: Math.floor(NOW / 1000) + 604800, nowMs: 0 };
    const result = await store.rebindAgenticPaymentNonce(input);
    assert.equal(result?.nonce, 2n); assert.equal(result?.deadline, input.signedDeadline); assert.equal(result?.validAfter, 0n);
    // Binance signs validAfter as the signing time: it is stored with the nonce and deadline, and bounded by the deadline and by now + 60 s.
    const now = BigInt(Math.floor(NOW / 1000));
    for (const [validAfter, ok] of [[now, true], [now + 60n, true], [now + 61n, false], [input.signedDeadline, false], [input.signedDeadline + 1n, false], [-1n, false]] as const) {
      const trial = new MemoryTradeCmcStore(() => NOW); trial.restore(structuredClone(base), new Map());
      const rebound = await trial.rebindAgenticPaymentNonce({ ...input, signedValidAfter: validAfter });
      assert.equal(rebound !== null, ok, String(validAfter)); if (ok) assert.equal(rebound?.validAfter, validAfter); else assert.equal((await trial.getAttempt("agentic-cmc", W, "op"))?.validAfter, 0n);
    }
    for (const mutation of ["missing-lease", "expired-lease", "other-operation", "generation", "state", "nonce", "encrypted", "early-deadline", "late-deadline", "session-end"]) {
      const snapshot = { ...structuredClone(base),
        lease: mutation === "missing-lease" ? null : mutation === "other-operation" ? { ...base.lease!, inFlightOperationId: "other" } : base.lease,
        attempts: base.attempts.map(a => mutation === "state" ? { ...a, state: "transmitting" as const }
          : mutation === "encrypted" ? { ...a, encryptedAuthorization: "opaque-fixture" } : a),
      };
      if (mutation === "expired-lease") time = NOW + 86_400_000; else time = NOW;
      const trial = new MemoryTradeCmcStore(() => time);
      trial.restore(snapshot, new Map());
      const before = trial.snapshot("agentic-cmc");
      const changed = { ...input,
        ...(mutation === "generation" ? { budgetGeneration: 1 } : {}),
        ...(mutation === "nonce" ? { preparedNonce: 3n } : {}),
        ...(mutation === "early-deadline" ? { signedDeadline: BigInt(Math.floor(NOW / 1000) + 5) } : {}),
        ...(mutation === "late-deadline" ? { signedDeadline: BigInt(Math.floor(NOW / 1000) + 561) } : {}),
        ...(mutation === "session-end" ? { sessionExpiry: Math.floor(NOW / 1000) + 509 } : {}),
      };
      assert.equal(await trial.rebindAgenticPaymentNonce(changed), null, mutation);
      assert.deepEqual(trial.snapshot("agentic-cmc"), before, mutation);
    }
  });
  it("takeQueued removes the merged target without driving the Altana scheduler", async () => {
    const store = new MemoryTradeCmcStore(() => NOW);
    const target: CmcRuntimeTarget = { agentId: "agentic-cmc", ownerAddress: W, wallet: W, sessionPublicKey: H,
      sessionExpiry: Math.floor(NOW / 1000) + 604800, sessionGeneration: 1, budgetGeneration: 0,
      isTradfiV2: true, cmcNewsEnabled: true, heldTickers: ["NVDA"], shortlistedTickers: [] };
    const runtime = createCmcRuntime({ store, now: () => NOW, worker: { masterKey: Buffer.alloc(32, 7), authorize: async () => ({ ok: true }),
      signer: { sign: async () => { throw new Error("Unexpected sign."); } }, transport: { request: async () => { throw new Error("Unexpected request."); } } } });
    assert.ok(runtime.worker);
    runtime.worker.enqueue(target);
    runtime.worker.enqueue({ ...target, heldTickers: ["AAPL"], shortlistedTickers: ["NVDA"] });
    assert.ok(runtime.worker.takeQueued(target.agentId));
    assert.equal(runtime.worker.takeQueued(target.agentId), null);
    await runtime.close();
  });
});

describe("Agentic signed authorization validAfter", () => {
  const nowSec = Math.floor(NOW / 1000);
  const challenge = { asset: USDT_56, amountWei: CMC_PRICE_ATOMIC, spender: CMC_SPENDER, payTo: CMC_PAYEE } as unknown as CmcChallenge;
  const read = (validAfter: number, options?: { validAfterMaxSec?: number }, deadline = nowSec + 120) => readSignedAuthorization("header", { x402Version: 2, payload: { signature: "0x00", permit2Authorization: {
    from: W, spender: CMC_SPENDER, permitted: { token: USDT_56, amount: CMC_PRICE_ATOMIC.toString() }, nonce: "7", deadline: String(deadline), witness: { to: CMC_PAYEE, validAfter: String(validAfter) } } } } as never,
  challenge, W, nowSec, ...(options === undefined ? [] : [options]));
  it("without options only validAfter 0 passes (Altana unchanged)", () => {
    assert.equal(read(0).validAfter, 0n);
    assert.throws(() => read(nowSec), /does not match its challenge/);
    assert.throws(() => read(1), /does not match its challenge/);
  });
  it("with the Agentic option the signing time passes within 60 s of skew and below the deadline", () => {
    const options = { validAfterMaxSec: nowSec + 60 };
    assert.equal(read(0, options).validAfter, 0n);
    assert.equal(read(nowSec, options).validAfter, BigInt(nowSec));
    assert.equal(read(nowSec + 60, options).validAfter, BigInt(nowSec + 60));
    assert.throws(() => read(nowSec + 61, options), /does not match its challenge/);
    assert.equal(read(nowSec + 4, options, nowSec + 5).validAfter, BigInt(nowSec + 4));
    assert.throws(() => read(nowSec + 5, options, nowSec + 5), /does not match its challenge/);
    assert.throws(() => read(nowSec + 6, options, nowSec + 5), /does not match its challenge/);
  });
});
