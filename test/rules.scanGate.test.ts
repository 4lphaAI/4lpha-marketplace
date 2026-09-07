/**
 * The scan gate, against the payload the data plane ACTUALLY returns.
 *
 * The sample bodies here are not invented: they are the shape observed from the
 * live data plane on 2026-08-11 (`GET /security/:address` →
 * `{ riskLevel, flags, scannedAt, source }`, two scanners already merged). An
 * earlier version of this gate was written against a guessed GoPlus-style body
 * and therefore denied every buy — so these tests pin the real contract, and the
 * narrow question the gate is allowed to ask.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  FATAL_FLAGS,
  createScanGate,
  evaluateSecurityPayload,
  readScanFlags,
  type ScanGate,
  type ScanMode,
} from "../src/rules/scanGate.js";
import type {
  DataPlaneClient,
  DataPlaneHealth,
  VenusReadResult,
  VenusTrackingResult,
} from "../src/clients/dataPlane.js";

const CHAIN = 56;
const TOKEN = getAddress("0x55d398326f99059fF775485246999027B3197955");
const OTHER = getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E");

/** A real `ok` body: USDT, as the live data plane answered it. */
function okPayload(): unknown {
  return {
    riskLevel: "ok",
    flags: ["mintable"],
    scannedAt: 1_786_456_748_224,
    source: "onchainos+gmgn",
  };
}

function payloadWith(flags: readonly string[], riskLevel = "danger"): unknown {
  return { riskLevel, flags, scannedAt: 1_786_456_748_224, source: "onchainos+gmgn" };
}

class ScriptedDataPlane implements DataPlaneClient {
  next: unknown = okPayload();
  error: Error | null = null;
  calls = 0;

  async health(): Promise<DataPlaneHealth | null> {
    return { ok: true, uptimeSec: 1 };
  }
  async token(): Promise<unknown | null> {
    return null;
  }
  async security(): Promise<unknown | null> {
    this.calls += 1;
    if (this.error !== null) throw this.error;
    return this.next;
  }
  // PHASE3 interface members; the scan gate never touches the LP surface.
  async lpRankedPools(): Promise<unknown | null> {
    return null;
  }
  // PHASE4 interface members; the scan gate never touches the Venus surface.
  async venusAccount(): Promise<VenusReadResult> {
    return { kind: "untracked" };
  }
  async venusRewards(): Promise<VenusReadResult> {
    return { kind: "untracked" };
  }
  async venusMarkets(): Promise<VenusReadResult> {
    return { kind: "untracked" };
  }
  async venusTrackOwner(): Promise<VenusTrackingResult> {
    return { kind: "ok" };
  }
  async venusUntrackOwner(): Promise<VenusTrackingResult> {
    return { kind: "ok" };
  }
}

type Harness = {
  gate: ScanGate;
  dataPlane: ScriptedDataPlane;
  advance(ms: number): void;
};

function harness(
  options: { ttlSec?: number; requireVerdict?: boolean; mode?: ScanMode } = {},
): Harness {
  const dataPlane = new ScriptedDataPlane();
  let now = 1_000_000;
  const gate = createScanGate({
    dataPlane,
    now: () => now,
    ttlSec: options.ttlSec ?? 300,
    requireVerdict: options.requireVerdict ?? false,
    // These cases are about what the gate FINDS, so they run it in the mode
    // that acts on a finding. The default (`report`) has its own section.
    mode: options.mode ?? "block",
  });
  return { gate, dataPlane, advance: (ms) => (now += ms) };
}

const buy = { chainId: CHAIN, token: TOKEN, side: "buy" } as const;

describe("scanGate: the real data-plane payload", () => {
  it("allows a token whose flags carry nothing fatal", async () => {
    // `mintable` is a quality signal, not a sellability defect: the marketplace
    // may care, this layer must not.
    const h = harness();
    h.dataPlane.next = okPayload();
    assert.deepEqual(await h.gate.evaluate(buy), { verdict: "allow", reasons: [] });
  });

  it("allows every quality flag the live feed actually produces", async () => {
    // Observed across 52 live Four.Meme tokens: these are the only non-empty
    // flag sets that appeared. All of them must trade.
    for (const flags of [
      ["low_liquidity"],
      ["tax"],
      ["not_open_source"],
      ["mintable"],
      ["low_liquidity", "tax", "not_renounced", "top10_concentration"],
    ]) {
      const h = harness();
      h.dataPlane.next = payloadWith(flags, "warn");
      const verdict = await h.gate.evaluate(buy);
      assert.equal(verdict.verdict, "allow", flags.join(","));
    }
  });

  it("denies each fatal flag, and reports only that flag", async () => {
    for (const flag of FATAL_FLAGS) {
      const h = harness();
      h.dataPlane.next = payloadWith([flag, "low_liquidity", "mintable"]);
      const verdict = await h.gate.evaluate(buy);
      assert.equal(verdict.verdict, "deny", flag);
      assert.deepEqual(verdict.reasons, [flag]);
    }
  });

  it("denies on a fatal flag even when the overall verdict says ok", async () => {
    // The flags are the finding; `riskLevel` mixes defects with judgements, so a
    // scanner that rates a honeypot `ok` must not be able to wave it through.
    const h = harness();
    h.dataPlane.next = payloadWith(["honeypot"], "ok");
    assert.equal((await h.gate.evaluate(buy)).verdict, "deny");
  });
});

describe("scanGate: no verdict available", () => {
  it("allows by default — an absent opinion is not evidence of a defect", async () => {
    for (const payload of [
      null,
      undefined,
      { riskLevel: "unavailable", flags: [], scannedAt: 1, source: "none" },
      "not json",
      { unrelated: true },
      { riskLevel: "ok" }, // flags missing entirely
    ]) {
      const h = harness();
      h.dataPlane.next = payload;
      assert.equal((await h.gate.evaluate(buy)).verdict, "allow", JSON.stringify(payload));
    }
  });

  it("allows by default when the data plane throws", async () => {
    const h = harness();
    h.dataPlane.error = new Error("upstream exploded at https://secret.internal");
    assert.deepEqual(await h.gate.evaluate(buy), { verdict: "allow", reasons: [] });
  });

  it("denies scan_unavailable for a deployment that opts in", async () => {
    const missing = harness({ requireVerdict: true });
    missing.dataPlane.next = { riskLevel: "unavailable", flags: [] };
    assert.deepEqual(await missing.gate.evaluate(buy), {
      verdict: "deny",
      reasons: ["scan_unavailable"],
    });

    const thrown = harness({ requireVerdict: true });
    thrown.dataPlane.error = new Error("down");
    assert.equal((await thrown.gate.evaluate(buy)).verdict, "deny");
  });

  it("never caches a no-verdict answer", async () => {
    // A five-second blip must not decide the next five minutes, in either mode.
    const h = harness({ requireVerdict: true });
    h.dataPlane.next = { riskLevel: "unavailable", flags: [] };
    await h.gate.evaluate(buy);
    h.dataPlane.next = okPayload();
    assert.equal((await h.gate.evaluate(buy)).verdict, "allow");
    assert.equal(h.dataPlane.calls, 2, "the second call must re-read");
  });
});

describe("scanGate: sells, caching, and containment", () => {
  it("never gates a sell, and never reads for one", async () => {
    const h = harness();
    h.dataPlane.next = payloadWith(["honeypot"]);
    const verdict = await h.gate.evaluate({ ...buy, side: "sell" });
    assert.deepEqual(verdict, { verdict: "allow", reasons: [] });
    assert.equal(h.dataPlane.calls, 0, "blocking an exit does the honeypot's work");
  });

  it("caches a real verdict for the TTL, then re-reads", async () => {
    const h = harness({ ttlSec: 300 });
    await h.gate.evaluate(buy);
    await h.gate.evaluate(buy);
    assert.equal(h.dataPlane.calls, 1);
    h.advance(300_001);
    await h.gate.evaluate(buy);
    assert.equal(h.dataPlane.calls, 2);
  });

  it("keys the cache by chain as well as token", async () => {
    const h = harness();
    await h.gate.evaluate(buy);
    await h.gate.evaluate({ ...buy, chainId: 97 });
    assert.equal(h.dataPlane.calls, 2, "one chain's contract must not answer for another");
    await h.gate.evaluate({ ...buy, token: OTHER });
    assert.equal(h.dataPlane.calls, 3);
  });

  it("never echoes a string from the payload", async () => {
    // Third-party content: forwarding it would be a response- and log-injection
    // hole. Reasons are a closed enum, so a hostile flag name cannot travel.
    const h = harness();
    h.dataPlane.next = payloadWith([
      "honeypot",
      "<script>alert(1)</script>",
      "https://evil.example/leak",
    ]);
    const verdict = await h.gate.evaluate(buy);
    assert.deepEqual(verdict.reasons, ["honeypot"]);
    const dumped = JSON.stringify(verdict);
    assert.equal(dumped.includes("script"), false);
    assert.equal(dumped.includes("evil.example"), false);
  });
});

describe("scanGate: the default mode reports without refusing", () => {
  it("allows a fatal flag through, but still carries it in reasons", async () => {
    // The live case that decided this default: one scanner said `honeypot`,
    // the other said `ok`, and the conservative merge refused a Binance-listed
    // token with real liquidity. The finding is still worth surfacing — it is
    // the REFUSAL that moved to the marketplace, not the information.
    const h = harness({ mode: "report" });
    h.dataPlane.next = payloadWith(["honeypot"]);
    const verdict = await h.gate.evaluate(buy);
    assert.equal(verdict.verdict, "allow");
    assert.deepEqual(verdict.reasons, ["honeypot"]);
  });

  it("is what createScanGate picks when no mode is given", async () => {
    const dataPlane = new ScriptedDataPlane();
    dataPlane.next = payloadWith(["honeypot", "cannot_sell"]);
    const gate = createScanGate({ dataPlane, now: () => 1_000_000 });
    const verdict = await gate.evaluate(buy);
    assert.equal(verdict.verdict, "allow", "the shipped default must not refuse");
    assert.deepEqual(verdict.reasons, ["honeypot", "cannot_sell"]);
  });

  it("mode `off` does not read the data plane at all", async () => {
    const h = harness({ mode: "off" });
    h.dataPlane.next = payloadWith(["honeypot"]);
    const verdict = await h.gate.evaluate(buy);
    assert.deepEqual(verdict, { verdict: "allow", reasons: [] });
    assert.equal(h.dataPlane.calls, 0, "off means no outbound read");
  });
});

describe("scanGate: payload reading", () => {
  it("distinguishes 'scanned, nothing fatal' from 'no scan'", async () => {
    assert.deepEqual(readScanFlags(payloadWith([], "ok")), []);
    assert.equal(readScanFlags({ riskLevel: "unavailable", flags: [] }), null);
    assert.equal(readScanFlags({ flags: ["honeypot"] }), null, "no riskLevel is no scan");
    assert.equal(readScanFlags(null), null);
  });

  it("tolerates a wrapped body without recursing", async () => {
    assert.deepEqual(readScanFlags({ data: payloadWith(["honeypot"]) }), ["honeypot"]);
    // Not found ten levels down: a bounded walk answers 'no scan' instead.
    assert.equal(readScanFlags({ a: { b: { c: payloadWith(["honeypot"]) } } }), null);
  });

  it("ignores non-string entries in the flag list", async () => {
    const verdict = evaluateSecurityPayload(
      { riskLevel: "danger", flags: [null, 42, { honeypot: true }, "honeypot"] },
      false,
    );
    assert.deepEqual(verdict.reasons, ["honeypot"]);
  });
});
