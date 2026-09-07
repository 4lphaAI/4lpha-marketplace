/**
 * The `exitToQuote` settings field (PHASE3.1 Rev2 items 5–7).
 *
 * The name is the point. Settings params are stored VERBATIM as the owner
 * signed them and `parseLpSettingsParams` refuses any key it does not know, so
 * RENAMING a signed key later makes every stored row unparseable — which turns
 * the worker's `loadPositionContext` into a silent per-cycle skip and disarms
 * every agent's automation with a reasonable-looking log line. That is
 * FINDINGS (ae)'s failure mode produced by a rename, and it is why the field is
 * named `exitToQuote` today rather than `exitToNative`.
 *
 * ADDING a key, by contrast, is free: a stored row that omits it parses to the
 * default. These tests pin BOTH halves of that asymmetry.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paramsHash } from "../src/auth/canonical.js";
import {
  defaultLpSettingsParams,
  lpSettingsParamsView,
  parseLpSettingsParams,
} from "../src/http/lpWire.js";
import {
  DEFAULT_LP_SETTINGS,
  validateLpSettings,
  type LpAutomationSettings,
} from "../src/lp/triggers.js";

/** Exactly what a Phase-3 row looks like: every key of the day, no exitToQuote. */
const PHASE3_STORED_PARAMS: Record<string, unknown> = {
  autoRotate: true,
  autoHarvest: true,
  rotateBandBps: 200,
  rotateMinHoldMinutes: 15,
  harvestMinFeesWei: "2000000000000000",
  stopLossPct: 5,
  takeProfitPct: 25,
  maxExitSequencesPerDay: 4,
  minMinutesBetweenExits: 30,
  brainEnabled: false,
  stakingEnabled: false,
  accumulateMode: "compound",
  minAprBps: 0,
};

describe("exitToQuote: the default and the migration (Rev2 items 5/7)", () => {
  it("defaults to TRUE — the corrected behaviour, not the grandfathered one", () => {
    assert.equal(DEFAULT_LP_SETTINGS.exitToQuote, true);
    assert.equal(defaultLpSettingsParams()["exitToQuote"], true);
  });

  it("a stored row LACKING the key parses to true, with no migration code", () => {
    const parsed = parseLpSettingsParams(PHASE3_STORED_PARAMS);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.exitToQuote, true);
      // Nothing else about the row moved.
      assert.equal(parsed.value.stopLossPct, 5);
      assert.equal(parsed.value.autoHarvest, true);
      assert.equal(parsed.value.harvestMinFeesWei, 2_000_000_000_000_000n);
    }
  });

  it("that row's STORED DIGEST still recomputes — the digest hashes the bytes, not the parse", () => {
    // Both the worker and `operatorSagaDeps` recompute
    // `paramsHash("lpSettings", stored.params)` over the STORED BYTES and
    // refuse on a mismatch. Adding a field to the parsed shape must therefore
    // leave an existing row's digest untouched, or every Phase-3 agent would
    // answer "digest does not recompute" and skip every cycle.
    const digestAtRest = paramsHash("lpSettings", PHASE3_STORED_PARAMS);
    assert.equal(paramsHash("lpSettings", PHASE3_STORED_PARAMS), digestAtRest);
    const parsed = parseLpSettingsParams(PHASE3_STORED_PARAMS);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      // The PARSED object now carries a key the stored bytes do not — which is
      // exactly why the digest must never be computed from the parse.
      assert.notEqual(
        paramsHash("lpSettings", lpSettingsParamsView(parsed.value)),
        digestAtRest,
      );
    }
  });

  it("the DEFAULT settings digest CHANGES — rider (a), stated rather than discovered", () => {
    // An agent with NO stored row and a sequence in flight across the deploy
    // answers SETTINGS_DIGEST_MISMATCH once and re-arms on the next cycle.
    // Bounded, because such an agent runs the all-off defaults: autoRotate and
    // autoHarvest false, stopLossPct and takeProfitPct 0, so the only sequence
    // it can have in flight is an owner-driven open or manual-exit.
    const withoutTheKey = { ...defaultLpSettingsParams() };
    delete withoutTheKey["exitToQuote"];
    assert.notEqual(
      paramsHash("lpSettings", defaultLpSettingsParams()),
      paramsHash("lpSettings", withoutTheKey),
    );
    assert.equal(DEFAULT_LP_SETTINGS.autoRotate, false);
    assert.equal(DEFAULT_LP_SETTINGS.autoHarvest, false);
    assert.equal(DEFAULT_LP_SETTINGS.stopLossPct, 0);
    assert.equal(DEFAULT_LP_SETTINGS.takeProfitPct, 0);
  });
});

describe("exitToQuote: the wire surface (Rev2 item 6)", () => {
  it("lpSettingsParamsView carries the field — the A5 merge base must not drop it", () => {
    // `live-lp settings` re-signs the STORED settings merged with this run's
    // flags, and this view is that merge base. A field missing from it is
    // silently dropped on every partial re-run, which is audit A5 reopened for
    // the new flag: an owner tuning `--stop-loss-pct` would unknowingly sign
    // `exitToQuote` back to its default.
    const off: LpAutomationSettings = { ...DEFAULT_LP_SETTINGS, exitToQuote: false };
    const view = lpSettingsParamsView(off);
    assert.equal(view["exitToQuote"], false);
    const round = parseLpSettingsParams(view);
    assert.equal(round.ok, true);
    if (round.ok) assert.equal(round.value.exitToQuote, false);
  });

  it("round-trips both values through view → parse → view", () => {
    for (const value of [true, false]) {
      const settings: LpAutomationSettings = {
        ...DEFAULT_LP_SETTINGS,
        exitToQuote: value,
      };
      const once = lpSettingsParamsView(settings);
      const parsed = parseLpSettingsParams(once);
      assert.equal(parsed.ok, true);
      if (parsed.ok) {
        assert.deepEqual(lpSettingsParamsView(parsed.value), once);
        assert.equal(parsed.value.exitToQuote, value);
      }
    }
  });

  it("is ACCEPTED as a signed key and refused when it is not a boolean", () => {
    const accepted = parseLpSettingsParams({ exitToQuote: false });
    assert.equal(accepted.ok, true);
    if (accepted.ok) assert.equal(accepted.value.exitToQuote, false);

    for (const bad of ["false", 0, 1, null, {}]) {
      const rejected = parseLpSettingsParams({ exitToQuote: bad });
      assert.equal(rejected.ok, false, `exitToQuote=${JSON.stringify(bad)} must refuse`);
      if (!rejected.ok) assert.match(rejected.message, /exitToQuote/);
    }
  });

  it("the OLD spelling is refused as an unknown key — the rename that never happened", () => {
    // If the field had shipped as `exitToNative` and been renamed later, THIS
    // is what every stored row would have become on the day of the rename.
    const rejected = parseLpSettingsParams({ exitToNative: true });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.message, /unexpected field "exitToNative"/);
  });

  it("validateLpSettings — the ONE range validator — enforces the boolean", () => {
    assert.doesNotThrow(() => {
      validateLpSettings({ ...DEFAULT_LP_SETTINGS, exitToQuote: false });
    });
    assert.throws(
      () =>
        validateLpSettings({
          ...DEFAULT_LP_SETTINGS,
          exitToQuote: "yes",
        } as unknown as LpAutomationSettings),
      /exitToQuote must be a boolean/,
    );
  });
});
