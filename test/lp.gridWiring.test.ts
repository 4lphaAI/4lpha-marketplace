/**
 * PHASE3.15 — the flag, the boot throws, and the native-cap sizing term.
 *
 * `GRID_ENABLED` is the `resolveLpEnabled` tri-state byte for byte, with ONE
 * addition: the L3 pair check. Grid deps are built INSIDE the LP composition,
 * so `GRID_ENABLED="true"` with `LP_ENABLED` off would produce a healthy-looking
 * server that skips every grid agent — the PHASE4-AUDIT A1 / F8 shape with a
 * position attached. The check lives in the RESOLVER rather than at one
 * composition site, so every caller inherits it without four copies.
 *
 * Offline: pure config resolution and pure arithmetic. No boot, no chain.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolveGridEnabled, resolveLpEnabled } from "../src/ops/config.js";
import {
  DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI,
  MAX_SUBMISSIONS_PER_GRID_FLIP,
  MAX_SUBMISSIONS_PER_SEQUENCE,
  PROTECT_SUBMISSIONS_PER_POSITION,
  checkLpNativeCapSizing,
} from "../src/ops/policy.js";

describe("PHASE3.15: resolveGridEnabled is the tri-state, plus the L3 pair", () => {
  it("defaults OFF and honours exactly 'true'/'false'", () => {
    assert.equal(resolveGridEnabled({}), false);
    assert.equal(resolveGridEnabled({ GRID_ENABLED: "" }), false);
    assert.equal(resolveGridEnabled({ GRID_ENABLED: "false" }), false);
    assert.equal(
      resolveGridEnabled({ GRID_ENABLED: "true", LP_ENABLED: "true" }),
      true,
    );
  });

  it("a TYPO fails the boot, exactly as LP_ENABLED's does", () => {
    for (const typo of ["TRUE", "1", "yes", "on"]) {
      assert.throws(
        () => resolveGridEnabled({ GRID_ENABLED: typo, LP_ENABLED: "true" }),
        /GRID_ENABLED must be exactly "true" or "false"/u,
      );
    }
  });

  it("L3: grid ON while LP is OFF is refused, naming why", () => {
    assert.throws(
      () => resolveGridEnabled({ GRID_ENABLED: "true" }),
      /the grid rides the LP plane/u,
    );
    assert.throws(
      () => resolveGridEnabled({ GRID_ENABLED: "true", LP_ENABLED: "false" }),
      /GRID_ENABLED is "true" while LP_ENABLED is not/u,
    );
    // The inconsistent pair is the only combination that throws; grid OFF with
    // LP off or on is ordinary.
    assert.equal(resolveGridEnabled({ GRID_ENABLED: "false" }), false);
    assert.equal(resolveLpEnabled({}), false);
  });

  it("C4: the landing-evidence incompatibility is ENFORCED at boot, not merely written", () => {
    // R2.4: `grid-flip` is deliberately UNMAPPED in `landingDispositionFor`,
    // whose table THROWS on an unmapped key. Mapping it is six rows plus two
    // hand conditions in the file the 3.9c chain took eight fix-audits to
    // clear, and it is DEFERRED. Until then the two features may not run
    // together — and the constraint is a throw in the ONE site that composes
    // `LpServerDeps`, so no caller can miss it.
    const source = readFileSync(
      new URL("../src/lp/wiring.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /const gridEnabled = resolveGridEnabled\(input\.env\)/u);
    assert.match(
      source,
      /if \(gridEnabled && evidenceConfig\.enabled\) \{[\s\S]*?throw new Error\(/u,
      "the incompatibility must be a boot throw",
    );
    assert.match(source, /landingDispositionFor, whose table throws/u);
  });

  it("C4: dev-stack and the LP worker daemon both reach the flag", () => {
    // The build accounts for every composition site: `src/lp/wiring.ts` (the
    // one that composes `LpServerDeps`, shared by the server and the dev
    // stack), `src/index-server.ts` (which calls the resolver so the L3 pair
    // throws even when LP is off), and the two worker deps blocks. A flag that
    // reached the routes but not the daemon would skip every grid agent on a
    // deployment that had enabled the grid.
    const devStack = readFileSync(
      new URL("../scripts/dev-stack.ts", import.meta.url),
      "utf8",
    );
    assert.match(devStack, /gridEnabled: workerBoot\.gridEnabled/u);
    const worker = readFileSync(
      new URL("../scripts/lp-worker.ts", import.meta.url),
      "utf8",
    );
    assert.match(worker, /gridEnabled: boot\.gridEnabled/u);
    const indexServer = readFileSync(
      new URL("../src/index-server.ts", import.meta.url),
      "utf8",
    );
    assert.match(indexServer, /resolveGridEnabled\(process\.env\);/u);
  });
});

describe("PHASE3.15 R2.7/H6: the grid term in the native-cap sizing invariant", () => {
  const relay = DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI;
  const base = {
    openNativeBudgetWei: 0n,
    maxExitSequencesPerDay: 4,
    openPositionsCount: 1,
    lpRelayFeePerSubmitWei: relay,
  };

  /** The exact reserve the invariant requires, with and without the grid. */
  function requiredWei(gridFlips?: number): bigint {
    const exit = BigInt(base.maxExitSequencesPerDay) * BigInt(MAX_SUBMISSIONS_PER_SEQUENCE) * relay;
    const protect = 1n * BigInt(PROTECT_SUBMISSIONS_PER_POSITION) * relay;
    const grid =
      gridFlips === undefined
        ? 0n
        : BigInt(gridFlips) * BigInt(MAX_SUBMISSIONS_PER_GRID_FLIP) * relay;
    return exit + protect + grid;
  }

  it("is INERT for a non-grid agent — the term is absent, not zero-valued", () => {
    const exact = requiredWei();
    assert.equal(checkLpNativeCapSizing({ ...base, onChainDailyCapWei: exact }).ok, false);
    assert.equal(
      checkLpNativeCapSizing({ ...base, onChainDailyCapWei: exact + 1n }).ok,
      true,
    );
  });

  it("a grid agent reserves N_grid x 3 submissions MORE", () => {
    const withGrid = requiredWei(12);
    // The cap that was exactly sufficient without a grid is now short.
    assert.equal(
      checkLpNativeCapSizing({
        ...base,
        maxGridFlipsPerDay: 12,
        onChainDailyCapWei: requiredWei() + 1n,
      }).ok,
      false,
    );
    assert.equal(
      checkLpNativeCapSizing({
        ...base,
        maxGridFlipsPerDay: 12,
        onChainDailyCapWei: withGrid + 1n,
      }).ok,
      true,
    );
  });

  it("the shortfall NAMES the grid term, so an owner can see which quota costs them", () => {
    const result = checkLpNativeCapSizing({
      ...base,
      maxGridFlipsPerDay: 12,
      onChainDailyCapWei: requiredWei() + 1n,
    });
    assert.equal(result.ok, false);
    if (!result.ok && result.kind === "shortfall") {
      assert.match(result.message, /grid headroom N_grid 12 × 3 submissions/u);
      // The two submission counts are stated SIDE BY SIDE rather than
      // reconciled: the net-edge admission prices a flip's REAL two
      // submissions, this reserve pads a third for a resubmission after a hold.
      assert.match(result.message, /the sweep always skips/u);
      assert.equal(
        result.shortfallWei,
        requiredWei(12) - (requiredWei() + 1n) + 1n,
      );
    }
  });

  it("a malformed grid count is REFUSED rather than sized on", () => {
    for (const bad of [0, 25, 1.5]) {
      const result = checkLpNativeCapSizing({
        ...base,
        maxGridFlipsPerDay: bad,
        onChainDailyCapWei: 10n ** 24n,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.kind, "malformed");
    }
  });

  it("the padding is DELIBERATE and named: 3 reserved against 2 really submitted", () => {
    assert.equal(MAX_SUBMISSIONS_PER_GRID_FLIP, 3);
    // The docstring is the only place the two numbers are reconciled, so it is
    // pinned. Comment prefixes and line wrapping are normalised away first, and
    // only the constant's own block is read — a whole-file match would dump
    // 90 kB into a failure report.
    const source = readFileSync(
      new URL("../src/ops/policy.ts", import.meta.url),
      "utf8",
    );
    const at = source.indexOf("MAX_SUBMISSIONS_PER_GRID_FLIP");
    assert.notEqual(at, -1);
    const block = source
      .slice(Math.max(0, at - 2_000), at + 200)
      .replace(/\s*\*\s*/g, " ")
      .replace(/\s+/g, " ");
    assert.ok(block.includes("the sweep always skips"), "the real count is two");
    assert.ok(
      block.includes("PADDING for a resubmission after a G2 hold"),
      "and the third is named as padding, not as a submission",
    );
  });

  it("C7: EVERY production call site threads the term", () => {
    // A term added to `policy.ts` and threaded at one site only is a reserve
    // that exists for a grid armed one way and not the other.
    //
    // PHASE3.16 (review H1) made it THREE: the grid arm sizes too, and its
    // "call site N of 2" comments were corrected in the same change rather
    // than left to become a lie. The count is asserted against the comments'
    // own denominator so the two can never drift.
    const server = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );
    const occurrences = server.split("maxGridFlipsPerDay: ").length - 1;
    assert.equal(occurrences, 3, "the settings route, the import route and the arm");
    assert.match(server, /call site 1 of 3/u);
    assert.match(server, /call site 2 of 3/u);
    assert.match(server, /call site 3 of 3/u);
  });
});
