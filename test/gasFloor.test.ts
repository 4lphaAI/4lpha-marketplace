/**
 * AGENT-GAS-ATTENTION §6 — the gas floor's table, its boundaries, and the ONE
 * identity the whole design rests on.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AGENT_GAS_BLOCK_MOTIONS,
  AGENT_GAS_MAX_BACKOFF_MS,
  AGENT_GAS_WARN_MOTIONS,
  agentGasFloor,
  agentGasReason,
  classifyAgentGas,
} from "../src/ops/gasFloor.js";
import {
  MAX_SUBMISSIONS_PER_GRID_FLIP,
  MAX_SUBMISSIONS_PER_GRID_RECENTER,
  MAX_SUBMISSIONS_PER_GRID_SHIFT,
  MAX_SUBMISSIONS_PER_SEQUENCE,
  PROTECT_SUBMISSIONS_PER_POSITION,
  RELAY_FEE_PER_EXIT_WEI,
  walletNativeFloorWei,
} from "../src/ops/policy.js";
import { gridShiftGasGate } from "../src/lp/gridTriggers.js";
import { lpGasBackoffDelayMs, lpMotionNeedsDiscretionaryGas } from "../src/lp/worker.js";
import { tradeGasBackoffDelayMs } from "../src/trade/worker.js";

/** The live mainnet value of `LP_RELAY_FEE_PER_SUBMIT_WEI` (0.0000388 BNB). */
const PER_SUBMIT = 38_800_000_000_000n;

test("the LP motion table is the sizing constants, per grid mode", () => {
  const floorFor = (gridMode: "shift" | "ladder" | "fixed" | "policy" | null) =>
    agentGasFloor({ profile: "lp-v1", gridMode, relayFeePerSubmitWei: PER_SUBMIT });

  assert.equal(
    floorFor("shift")?.nextMotionWei,
    BigInt(MAX_SUBMISSIONS_PER_GRID_SHIFT) * PER_SUBMIT,
  );
  assert.equal(
    floorFor("ladder")?.nextMotionWei,
    BigInt(MAX_SUBMISSIONS_PER_GRID_RECENTER) * PER_SUBMIT,
  );
  assert.equal(
    floorFor("fixed")?.nextMotionWei,
    BigInt(MAX_SUBMISSIONS_PER_GRID_FLIP) * PER_SUBMIT,
  );
  assert.equal(
    floorFor("policy")?.nextMotionWei,
    BigInt(MAX_SUBMISSIONS_PER_GRID_FLIP) * PER_SUBMIT,
  );
  // No grid at all: a plain rotate/harvest LP agent reserves an exit sequence.
  assert.equal(floorFor(null)?.nextMotionWei, BigInt(MAX_SUBMISSIONS_PER_SEQUENCE) * PER_SUBMIT);
});

test("trade and Venus floors come from the constants those paths already reserve", () => {
  assert.equal(agentGasFloor({ profile: "trade-v1" })?.nextMotionWei, RELAY_FEE_PER_EXIT_WEI);
  assert.equal(agentGasFloor({ profile: "venus-v1" })?.nextMotionWei, walletNativeFloorWei());
});

test("Venus is warn-only; every other worker profile may block", () => {
  // The rule of `src/lending/sizing.ts:27` as a test: a guard exists to stop a
  // liquidation, so a short wallet may warn about it and must never stand it
  // down. A build that flips this value fails here.
  assert.equal(agentGasFloor({ profile: "venus-v1" })?.enforcement, "warn-only");
  assert.equal(agentGasFloor({ profile: "trade-v1" })?.enforcement, "block");
  assert.equal(
    agentGasFloor({ profile: "lp-v1", gridMode: null, relayFeePerSubmitWei: PER_SUBMIT })
      ?.enforcement,
    "block",
  );
});

test("a profile with no worker, and an unsized LP fee, both answer null", () => {
  assert.equal(agentGasFloor({ profile: "unbound-v1" }), null);
  assert.equal(agentGasFloor({ profile: "raw-v1" }), null);
  // The `gridShiftGasGate` posture: a floor nobody can size is not a floor of
  // zero, and must never be rendered as one.
  assert.equal(agentGasFloor({ profile: "lp-v1", gridMode: "shift" }), null);
  assert.equal(
    agentGasFloor({ profile: "lp-v1", gridMode: "shift", relayFeePerSubmitWei: 0n }),
    null,
  );
});

test("REGRESSION: the grid-shift DISCRETIONARY cost IS the shipped gridShiftGasGate", () => {
  // This identity is what makes AGENT-GAS-ATTENTION a generalisation of the one
  // gate that already shipped rather than a second opinion about the same
  // wallet. If it stops holding, `gasFloor.ts` is wrong and the constant is
  // right. Checked against the gate itself, not against a copied number.
  //
  // It is `nextMotionWei` that carries the identity, NOT `blockWei`: after
  // review finding 1 the stand-down line dropped to the PROTECT cost, because
  // a wallet that can still pay to honour a stop-loss must never be stood down.
  const floor = agentGasFloor({
    profile: "lp-v1",
    gridMode: "shift",
    relayFeePerSubmitWei: PER_SUBMIT,
  });
  assert.ok(floor !== null);
  const gate = gridShiftGasGate({ nativeWei: 0n, relayFeePerSubmitWei: PER_SUBMIT });
  assert.equal(floor.nextMotionWei, gate.requiredWei);

  // And the shift trigger's own gate still decides shifts, unchanged, at the
  // boundary it always used.
  for (const nativeWei of [floor.nextMotionWei - 1n, floor.nextMotionWei, floor.nextMotionWei + 1n]) {
    const gateHolds = gridShiftGasGate({ nativeWei, relayFeePerSubmitWei: PER_SUBMIT }).hold;
    assert.equal(gateHolds, nativeWei < gate.requiredWei!, `disagreement at ${nativeWei} wei`);
  }
});

test("REVIEW FINDING 1: an LP wallet that can still pay for a PROTECT is not stood down", () => {
  // The defect: one threshold at the DISCRETIONARY cost skipped the position
  // before `protect` was ever evaluated, so a wallet holding exactly two fee
  // units — enough to honour a breached stop-loss — sat on the breach.
  for (const gridMode of ["shift", "ladder", "fixed", "policy", null] as const) {
    const floor = agentGasFloor({ profile: "lp-v1", gridMode, relayFeePerSubmitWei: PER_SUBMIT });
    assert.ok(floor !== null, `no floor for ${String(gridMode)}`);
    // The stand-down line is the protect cost, in EVERY mode — which is also
    // what lets the worker apply it before it knows the mode.
    assert.equal(
      floor.minMotionWei,
      BigInt(PROTECT_SUBMISSIONS_PER_POSITION) * PER_SUBMIT,
      `mode ${String(gridMode)}`,
    );
    assert.equal(floor.blockWei, floor.minMotionWei);
    assert.ok(floor.minMotionWei <= floor.nextMotionWei);
    // A wallet holding exactly a protect's worth is LOW, never blocked.
    assert.equal(classifyAgentGas({ nativeWei: floor.minMotionWei, floor }), "low");
    assert.equal(classifyAgentGas({ nativeWei: floor.minMotionWei - 1n, floor }), "blocked");
  }
});

test("a floor whose cheapest motion exceeds its discretionary one is refused, not published", () => {
  // `floorFrom` throws rather than emit `blockWei > warnWei / 3` — a wallet the
  // worker stood down while the page still called it healthy.
  assert.equal(agentGasFloor({ profile: "trade-v1" })?.minMotionWei, RELAY_FEE_PER_EXIT_WEI);
  assert.equal(agentGasFloor({ profile: "venus-v1" })?.minMotionWei, walletNativeFloorWei());
});

test("the thresholds are 3x the discretionary motion and 1x the cheapest", () => {
  const floor = agentGasFloor({ profile: "trade-v1" });
  assert.ok(floor !== null);
  assert.equal(floor.warnWei, AGENT_GAS_WARN_MOTIONS * floor.nextMotionWei);
  assert.equal(floor.blockWei, AGENT_GAS_BLOCK_MOTIONS * floor.minMotionWei);
  assert.equal(AGENT_GAS_WARN_MOTIONS, 3n);
  assert.equal(AGENT_GAS_BLOCK_MOTIONS, 1n);
});

test("classification boundaries: exactly-one-motion is not blocked, exactly-warn is ok", () => {
  const floor = agentGasFloor({ profile: "trade-v1" });
  assert.ok(floor !== null);
  const at = (nativeWei: bigint) => classifyAgentGas({ nativeWei, floor });

  assert.equal(at(0n), "blocked");
  assert.equal(at(floor.blockWei - 1n), "blocked");
  assert.equal(at(floor.blockWei), "low");
  assert.equal(at(floor.warnWei - 1n), "low");
  assert.equal(at(floor.warnWei), "ok");
  assert.equal(at(floor.warnWei * 10n), "ok");
});

test("an unread balance or an unsized floor is `unknown`, never ok and never blocked", () => {
  const floor = agentGasFloor({ profile: "trade-v1" });
  assert.equal(classifyAgentGas({ nativeWei: undefined, floor }), "unknown");
  assert.equal(classifyAgentGas({ nativeWei: 10n ** 18n, floor: null }), "unknown");
});

test("the reason leads with the remedy and survives the 280-char sanitize cap", () => {
  const floor = agentGasFloor({
    profile: "lp-v1",
    gridMode: "shift",
    relayFeePerSubmitWei: PER_SUBMIT,
  });
  // The live wallet and balance from the 2026-09-10 screenshot.
  const walletAddress = "0xdfb9fe4922daf390349d5cfaf94185ea4cc02764";
  const nativeWei = 46_362_613_151_976n;

  const blocked = agentGasReason({ state: "blocked", floor, nativeWei, walletAddress });
  // Remedy FIRST (PHASE3.13 F12-b): `sanitizeMessage` clips at 280 and a
  // remedy-last sentence loses the only actionable half.
  assert.ok(blocked.startsWith("Deposit at least "), blocked);
  assert.ok(blocked.includes(walletAddress), "the remedy must say where to send BNB");
  assert.ok(blocked.length <= 280, `blocked reason is ${blocked.length} chars: ${blocked}`);

  const low = agentGasReason({ state: "low", floor, nativeWei: floor!.warnWei - 1n, walletAddress });
  assert.ok(low.startsWith("Top up "), low);
  assert.ok(low.length <= 280, `low reason is ${low.length} chars: ${low}`);

  const unread = agentGasReason({ state: "unknown", floor, nativeWei: undefined, walletAddress });
  assert.ok(unread.startsWith("Deposit BNB to "), unread);
  assert.ok(unread.length <= 280, `unread reason is ${unread.length} chars: ${unread}`);

  const unsized = agentGasReason({ state: "unknown", floor: null, nativeWei, walletAddress });
  assert.ok(unsized.startsWith("Gas floor unavailable"), unsized);
  assert.ok(unsized.length <= 280, `unsized reason is ${unsized.length} chars: ${unsized}`);
});

test("STRUCTURAL: the lending worker wires no gas gate at all", async () => {
  // `enforcement: "warn-only"` above says a short wallet MAY NOT stop a Venus
  // guard. This pins that the rule is honoured by construction rather than by
  // intention: the lending worker must not reach the gate module at all.
  //
  // A guard exists to stop a liquidation. `src/lending/sizing.ts:27` rule 2 —
  // "A floor-clamped rescue SUBMITS THE REDUCED AMOUNT, never refuses" — is the
  // whole reason Phase 4 shipped, and a gas gate there would quietly reintroduce
  // the refusal it was written to remove. If a future build adds one, this fails
  // and sends the author back to that rule.
  const source = await readFile(new URL("../src/lending/worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /gasFloor|classifyAgentGas|agentGasFloor/u);
});

test("REVIEW FINDING 5: a warn-only profile is never TOLD it has been stood down", () => {
  const floor = agentGasFloor({ profile: "venus-v1" });
  assert.ok(floor !== null);
  const text = agentGasReason({
    state: "blocked", floor, nativeWei: 0n,
    walletAddress: "0x2222222222222222222222222222222222222222",
  });
  // A guard exists to stop a liquidation. Telling its owner it has stood down,
  // when the worker is in fact still submitting reduced repays, is the worst
  // available lie about it.
  assert.doesNotMatch(text, /standing by|stands by/u);
  assert.match(text, /KEEPS TRYING|keeps trying/u);
  assert.ok(text.length <= 280, `${text.length} chars`);
});

test("REVIEW FINDING 6: the backoff is capped in WALL CLOCK, not in intervals", () => {
  // The two daemons size an interval differently (LP 30 s, trade 60 s), so a
  // ladder counted in intervals promised 30 minutes and delivered 60.
  assert.equal(AGENT_GAS_MAX_BACKOFF_MS, 30 * 60 * 1_000);
  assert.equal(lpGasBackoffDelayMs(1, 30_000), 30_000);
  assert.equal(lpGasBackoffDelayMs(6, 30_000), AGENT_GAS_MAX_BACKOFF_MS);
  // The trade daemon's 60 s interval would otherwise reach 60 minutes.
  assert.equal(tradeGasBackoffDelayMs(6, 60_000), AGENT_GAS_MAX_BACKOFF_MS);
  assert.equal(tradeGasBackoffDelayMs(1, 60_000), 60_000);
  // And an absurd interval cannot escape the ceiling either.
  assert.equal(lpGasBackoffDelayMs(6, 10 * 60_000), AGENT_GAS_MAX_BACKOFF_MS);
});

test("REVIEW 2: protect is EXEMPT from the discretionary gas floor; every other saga is not", () => {
  // Review finding 1 as a VALUE. The rule used to be an inline `!==` inside
  // `evaluatePosition`, and review 2 proved that form untestable: a mutation
  // gating protect too survived the entire suite, because no offline fixture
  // drives a protect dispatch. A predicate can be pinned exhaustively.
  assert.equal(lpMotionNeedsDiscretionaryGas("protect"), false);
  for (const kind of ["rotate", "harvest", "grid-flip", "grid-requote", "grid-recenter", "grid-shift"] as const) {
    assert.equal(lpMotionNeedsDiscretionaryGas(kind), true, kind);
  }
});
