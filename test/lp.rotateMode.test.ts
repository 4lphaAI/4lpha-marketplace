/**
 * PHASE3.13 B12 — the `rotateMode` settings key: additive parse, CONDITIONAL
 * view emission, and the default-digest golden vector that the conditional
 * emission exists to protect.
 *
 * The hazard this file is written against is recorded twice in the repo (the
 * PHASE3.6 Rev2 M4/M5 pair, and the 3.13 review's F11): `canonicalEncode` drops
 * ABSENT keys but ENCODES present ones, so emitting `rotateMode: "swapped"`
 * unconditionally would move `DEFAULT_SETTINGS_DIGEST` — which
 * `currentSettingsDigest()` compares against every in-flight sequence of every
 * agent with no stored settings row, refusing them all at upgrade.
 *
 * OFFLINE, pure: parse, view, hash. No store, no chain, no clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paramsHash } from "../src/auth/canonical.js";
import {
  defaultLpSettingsParams,
  lpSettingsParamsView,
  parseLpSettingsParams,
} from "../src/http/lpWire.js";
import { DEFAULT_LP_SETTINGS, validateLpSettings } from "../src/lp/triggers.js";
import { DEFAULT_SETTINGS_DIGEST } from "../src/lp/worker.js";

/**
 * THE GOLDEN VECTOR. A LITERAL, per review F11 — deliberately NOT
 * `paramsHash("lpSettings", defaultLpSettingsParams())`, because a
 * recomputation moves with the very bug it is meant to catch.
 *
 * Measured on the tree that introduced `rotateMode`, and equal to the value
 * every release before it produced, because the key is not emitted at its
 * default. If this constant ever has to change, that change refuses every
 * in-flight sequence of every agent with no stored settings row, and it needs
 * its own spec, review and migration — not an edit here.
 */
const DEFAULT_LP_SETTINGS_DIGEST_GOLDEN =
  "0x7c9676678e0b193abf18c12a8346a2de18c5936e1a5771f63a0e3c280ce08134";

describe("PHASE3.13 B12: the default-settings digest golden vector (F11)", () => {
  it("DEFAULT_SETTINGS_DIGEST equals the literal, and adding rotateMode did not move it", () => {
    assert.equal(DEFAULT_SETTINGS_DIGEST, DEFAULT_LP_SETTINGS_DIGEST_GOLDEN);
    // The same bytes through the route's own path, so a divergence between the
    // worker's constant and the route's computation is also caught.
    assert.equal(
      paramsHash("lpSettings", defaultLpSettingsParams()),
      DEFAULT_LP_SETTINGS_DIGEST_GOLDEN,
    );
  });

  it("the default VIEW carries no rotateMode key at all (M10 dies here)", () => {
    const view = defaultLpSettingsParams();
    assert.equal("rotateMode" in view, false);
    assert.equal(DEFAULT_LP_SETTINGS.rotateMode, "swapped");
  });
});

describe("PHASE3.13 B12: rotateMode parses, round-trips and migrates", () => {
  it("a stored row WITHOUT the key parses to \"swapped\" — the additive migration", () => {
    const legacy = { ...defaultLpSettingsParams() };
    delete legacy["rotateMode"];
    const parsed = parseLpSettingsParams(legacy);
    assert.ok(parsed.ok);
    if (parsed.ok) assert.equal(parsed.value.rotateMode, "swapped");
  });

  it("a swapless row round-trips through the view KEEPING the key", () => {
    const swapless = { ...DEFAULT_LP_SETTINGS, rotateMode: "swapless" as const };
    const view = lpSettingsParamsView(swapless);
    assert.equal(view["rotateMode"], "swapless");
    const round = parseLpSettingsParams(view);
    assert.ok(round.ok);
    if (round.ok) assert.equal(round.value.rotateMode, "swapless");
    // And its digest is NOT the default one — an owner who signed swapless is
    // running under different bytes, which is the whole point of the key.
    assert.notEqual(paramsHash("lpSettings", view), DEFAULT_LP_SETTINGS_DIGEST_GOLDEN);
  });

  it("a swapped row DROPS the key from the view, and re-parses to the same value", () => {
    const view = lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, rotateMode: "swapped" });
    assert.equal("rotateMode" in view, false);
    const round = parseLpSettingsParams(view);
    assert.ok(round.ok);
    if (round.ok) assert.equal(round.value.rotateMode, "swapped");
  });

  it("the view is the MERGE BASE, so a swapless owner's partial re-sign keeps the mode (M4)", () => {
    // `live-lp settings --auto-harvest` re-signs the STORED view with one field
    // changed. Without the emit-when-set half, that would silently un-sign the
    // mode.
    const stored = lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, rotateMode: "swapless" });
    const resigned = { ...stored, autoHarvest: true };
    const parsed = parseLpSettingsParams(resigned);
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.equal(parsed.value.rotateMode, "swapless");
      assert.equal(parsed.value.autoHarvest, true);
    }
  });

  it("refuses any literal but the two, at the WIRE and at the validator", () => {
    for (const bad of ["swap", "SWAPLESS", "", true, false, 0, 1, null, {}, ["swapless"]]) {
      const rejected = parseLpSettingsParams({ rotateMode: bad });
      assert.equal(rejected.ok, false, `rotateMode=${JSON.stringify(bad)} must refuse`);
      if (!rejected.ok) assert.match(rejected.message, /rotateMode/u);
    }
    assert.doesNotThrow(() =>
      validateLpSettings({ ...DEFAULT_LP_SETTINGS, rotateMode: "swapless" }),
    );
    assert.throws(
      () =>
        validateLpSettings({
          ...DEFAULT_LP_SETTINGS,
          rotateMode: "sideways" as unknown as "swapped",
        }),
      /rotateMode must be/u,
    );
  });

  it("accepts both literals explicitly", () => {
    for (const mode of ["swapped", "swapless"] as const) {
      const parsed = parseLpSettingsParams({ rotateMode: mode });
      assert.ok(parsed.ok, mode);
      if (parsed.ok) assert.equal(parsed.value.rotateMode, mode);
    }
  });
});
