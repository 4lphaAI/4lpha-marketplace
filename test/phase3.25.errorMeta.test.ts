/**
 * PHASE3.25 R10.1 — the error metadata channel is projected from one bigint.
 * Offline: a tiny Hono app exercises the real response builder directly.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { getAddress } from "viem";
import { fail, shiftNativeSizingTerm, type ErrorMeta } from "../src/server.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { DEFAULT_LP_SETTINGS, type LpAutomationSettings } from "../src/lp/triggers.js";

async function responseFor(meta: ErrorMeta): Promise<Response> {
  const app = new Hono();
  app.get("/", (c) => fail(c, 400, "invalid_request", "bounded message", meta));
  return app.request("/");
}

describe("PHASE3.25 R10.1: projected bigint error metadata", () => {
  it("projects shortfallWei and cannot copy a caller variable's sibling", async () => {
    const wider = { shortfallWei: 123n, attackerText: "must not escape" };
    const response = await responseFor(wider);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { code: "invalid_request", message: "bounded message" },
      meta: { shortfallWei: "123" },
    });
  });

  it("fails closed on a negative or over-120-digit value", async () => {
    for (const shortfallWei of [-1n, 10n ** 120n]) {
      const response = await responseFor({ shortfallWei });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: { code: "internal_error" } });
    }
  });

  it("has no metadata producer outside the sizing-shortfall wrapper", async () => {
    const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
    const calls = [...source.matchAll(/fail\([\s\S]*?\)/gu)]
      .map((match) => match[0])
      .filter((call) => /shortfallWei/u.test(call));
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /error instanceof LpSizingShortfallError/u);
  });
});

describe("PHASE3.25 R7.1: T12 is measured with the real sanitizer", () => {
  const prefixes = {
    settings: "LP settings refused: the on-chain daily native cap is too low. Remedies: lower grid.shift.shiftsPerDay or grid.shift.driftGasBudgetWei, or raise the cap with owner-add-spend-limit. The EXIT path is unaffected: positions can still be closed. Shortfall (wei): ",
    arm: "Grid arm refused: the on-chain daily native cap is too low once this arm's budget and the shift lane's gas are reserved. Remedies: lower grid.shift.shiftsPerDay or grid.shift.driftGasBudgetWei, lower the budget, or raise the cap with owner-add-spend-limit. Shortfall (wei): ",
    imported: "LP import refused: the on-chain daily native cap is too low once this position's protect gas and the shift lane's gas are reserved. Remedies: lower grid.shift.shiftsPerDay or grid.shift.driftGasBudgetWei, or raise the cap. Shortfall (wei): ",
  } as const;

  it("pins unsanitized and sanitized output at 20 digits", () => {
    const digits = "9".repeat(20);
    const vectors = [
      [prefixes.settings, 278, prefixes.settings + digits],
      [prefixes.arm, 294, prefixes.arm + "9".repeat(5) + "…"],
      [prefixes.imported, 260, prefixes.imported + digits],
    ] as const;
    for (const [prefix, rawLength, expected] of vectors) {
      const raw = prefix + digits;
      assert.equal(raw.length, rawLength);
      assert.equal(sanitizeMessage(raw), expected);
    }
  });

  it("pins unsanitized and sanitized output at the 78-digit wire maximum", () => {
    const digits = "9".repeat(78);
    const vectors = [
      [prefixes.settings, 336, prefixes.settings + "9".repeat(21) + "…"],
      [prefixes.arm, 352, prefixes.arm + "9".repeat(5) + "…"],
      [prefixes.imported, 318, prefixes.imported + "9".repeat(39) + "…"],
    ] as const;
    for (const [prefix, rawLength, expected] of vectors) {
      const raw = prefix + digits;
      const sanitized = sanitizeMessage(raw);
      assert.equal(raw.length, rawLength);
      assert.equal(sanitized.length, 280);
      assert.equal(sanitized, expected);
      assert.match(sanitized, /Remedies:/u);
    }
  });
});

describe("PHASE3.25 R6.1: one shift sizing term serves all route seams", () => {
  function settings(
    minMinutesBetweenExits: number,
    shiftsPerDay: number,
    driftMotions: number,
  ): LpAutomationSettings {
    return {
      ...DEFAULT_LP_SETTINGS,
      autoRotate: false,
      autoHarvest: false,
      minMinutesBetweenExits,
      grid: {
        pool: {
          token0: getAddress("0x2222222222222222222222222222222222222222"),
          token1: getAddress("0x5555555555555555555555555555555555555555"),
          fee: 2_500,
        },
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
          shiftsPerDay,
          driftGasBudgetWei: BigInt(driftMotions),
          driftPerMotionWei: 1n,
        },
      },
    };
  }

  it("pins ceil capacity, signed settlement clamp, and total clamp", () => {
    assert.deepEqual(shiftNativeSizingTerm(settings(7, 204, 2)), {
      shiftMotionsPerDay: 206,
    });
    assert.deepEqual(shiftNativeSizingTerm(settings(5, 288, 288)), {
      shiftMotionsPerDay: 288,
    });
    assert.deepEqual(shiftNativeSizingTerm(settings(720, 1, 1)), {
      shiftMotionsPerDay: 2,
    });
  });
});
