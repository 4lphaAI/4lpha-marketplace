/** PHASE3.25 R5.7/R10.2 — pure client plumbing and transcript contracts. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  shiftArmConfirmation,
  shiftBlockFrom,
  shiftSettingsConfirmation,
  type Flags,
} from "../scripts/live-grid.js";
import type { LpGridSettings } from "../src/lp/triggers.js";

const TOKEN0 = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN1 = getAddress("0x5555555555555555555555555555555555555555");

function existingShift(
  pair?: { readonly driftGasBudgetWei: bigint; readonly driftPerMotionWei: bigint },
): LpGridSettings {
  return {
    pool: { token0: TOKEN0, token1: TOKEN1, fee: 2_500 },
    wbnbIsToken0: true,
    tickSpacing: 50,
    buyRange: { tickLower: 550, tickUpper: 1_050 },
    sellRange: { tickLower: -1_000, tickUpper: -500 },
    maxFlipsPerDay: 1,
    minNetEdgeBps: 0,
    mode: "shift",
    shift: {
      gapTicks: 500,
      widthTicks: 500,
      deployPctBps: 3_000,
      driftPctOfGap: 60,
      shiftsPerDay: 8,
      ...(pair ?? {}),
    },
  };
}

function build(flags: Flags, existing = existingShift()) {
  return shiftBlockFrom(flags, {
    existing,
    maxFlipsPerDay: 1,
    minMinutesBetweenExits: 7,
    policy: undefined,
  });
}

describe("PHASE3.25 client signed-pair plumbing", () => {
  it("reproduces stored key presence, including legacy absence and explicit zero", () => {
    assert.deepEqual(build(new Map()).block.shift, existingShift().shift);
    const explicit = existingShift({ driftGasBudgetWei: 0n, driftPerMotionWei: 2n });
    assert.deepEqual(build(new Map(), explicit).block.shift, explicit.shift);
    assert.deepEqual(
      build(new Map([["drift-gas-budget-bnb", "0.000000000000000008"]]), explicit)
        .block.shift,
      { ...explicit.shift, driftGasBudgetWei: 8n },
    );
    assert.deepEqual(
      build(new Map([["drift-per-motion-bnb", "0.000000000000000003"]]), explicit)
        .block.shift,
      { ...explicit.shift, driftPerMotionWei: 3n },
    );
  });

  it("keeps --shifts-day and round-trips both decimal-BNB flags", () => {
    const result = build(new Map([
      ["shifts-day", "24"],
      ["drift-gas-budget-bnb", "0.000000000000000008"],
      ["drift-per-motion-bnb", "0.000000000000000002"],
    ]));
    assert.equal(result.block.shift?.shiftsPerDay, 24);
    assert.equal(result.block.shift?.driftGasBudgetWei, 8n);
    assert.equal(result.block.shift?.driftPerMotionWei, 2n);
  });

  it("requires both flags when widening a legacy block", () => {
    assert.throws(
      () => build(new Map([["drift-gas-budget-bnb", "0.1"]])),
      /pass --drift-gas-budget-bnb and --drift-per-motion-bnb together/u,
    );
  });

  it("pins final T10 on stdout's transcript value", () => {
    const transcript = build(new Map([
      ["drift-gas-budget-bnb", "0.000000000000000008"],
      ["drift-per-motion-bnb", "0.000000000000000002"],
    ])).transcript;
    const exact = "  motion       driftPctOfGap 60, shiftsPerDay 8 (SETTLEMENT only).\n"
      + "               Drift: 0.000000000000000008 BNB at 0.000000000000000002 BNB/motion = 4/day,\n"
      + "               priced AT SIGNING. Physical capacity is S = ceil(1440/minMinutesBetweenExits)\n"
      + "               = 206 motions a day across BOTH lanes; the signed settlement cadence is\n"
      + "               separately bounded by 1 + shiftsPerDay <= R, R = floor(1440/minMinutesBetweenExits)\n"
      + "               = 205.\n";
    assert.ok(transcript.includes(exact));
    assert.equal(exact.length, 459);
    assert.match(transcript, /driftGasBudgetWei 8; driftPerMotionWei 2/u);
  });

  it("pins final T9 and T11 rendered bytes", () => {
    const shift = existingShift({ driftGasBudgetWei: 8n, driftPerMotionWei: 2n }).shift!;
    const settingsText = shiftSettingsConfirmation(shift);
    assert.equal(
      settingsText,
      "Cross settlement is capped at 8/day; drift is capped at 4/day, derived from 0.000000000000000008 BNB (8 wei) priced at 0.000000000000000002 BNB (2 wei) per motion AT SIGNING. The two allowances are separate; both lanes still share agent-wide spacing.",
    );
    assert.equal(settingsText.length, 250);
    const armText = shiftArmConfirmation({
      agentId: "agent-phase325",
      budgetWei: 10n ** 18n,
      swapInWei: 5n * 10n ** 17n,
      buyValueWei: 15n * 10n ** 16n,
      idleQuoteWei: 35n * 10n ** 16n,
      buyRange: { tickLower: 550, tickUpper: 1_050 },
      sellRange: { tickLower: -1_000, tickUpper: -500 },
      shift,
    });
    assert.equal(
      armText,
      "sign gridArm (SHIFT, levels 2) for agent-phase325: persist these settings AND spend 1 BNB in ONE transaction — 0.5 BNB swapped to the base token, 0.15 BNB minted into [550, 1050), the deployed share of the swap minted into [-1000, -500), and 0.35 BNB wrapped to WBNB and left IDLE in your own EOA. Two NFTs, or neither. From then on cross settlement and clean drift may re-anchor two rungs in one batch, while mid-fill drift moves only the clean rung in a seven-call batch, up to 8 settlements and 4 drift motions a day, the latter derived from a 0.000000000000000008 BNB budget priced at signing; both lanes share agent-wide spacing.",
    );
    assert.equal(armText.length, 634);
  });

  it("pins T9/T10/T11 to their required stderr/stdout/stderr producers", async () => {
    const source = await readFile(new URL("../scripts/live-grid.ts", import.meta.url), "utf8");
    assert.match(source, /const shiftConfirmation =[\s\S]{0,250}?shiftSettingsConfirmation\(grid\.shift\)[\s\S]{0,500}?requireYesLive\([\s\S]{0,500}?\+ shiftConfirmation/u);
    assert.match(source, /console\.log\([\s\S]{0,350}?\.transcript/u);
    assert.match(source, /requireYesLive\([\s\S]{0,500}?shiftArmConfirmation\(/u);
  });
});
