/**
 * The LP routes' wire boundary: untrusted owner-action params in, safe JSON
 * views out. Same two rules as `src/http/wire.ts`, restated because they are
 * what make the routes safe rather than merely convenient:
 *
 *   1. NOTHING is read off params by spreading. Every field is pulled out by
 *      name and type-checked; UNKNOWN FIELDS ARE REFUSED (the fence posture) —
 *      the params are hash-bound to the owner's signature, so an extra key is
 *      not junk, it is a signed instruction this build does not understand.
 *   2. NOTHING is written into a response by spreading a stored record; views
 *      are built field by field and bigints cross as decimal strings.
 *
 * Interpretation happens AFTER verification, per the envelope contract: the
 * verifier recomputed `paramsHash` over the verbatim JSON, and only then do
 * these parsers turn decimal strings into bigints.
 */
import { getAddress, isAddress, type Address } from "viem";
import {
  DEFAULT_LP_SETTINGS,
  priceTriggerFires,
  validateLpSettings,
  type LpBrainSettings,
  type LpAutomationSettings,
  type LpGridLadder,
  type LpGridShift,
  type LpGridMode,
  type LpGridPolicy,
  type LpGridRange,
  type LpGridRequote,
  type LpGridSettings,
  type LpPriceTrigger,
  type LpProtectionStatus,
  type LpTriggerObservation,
} from "../lp/triggers.js";
import {
  encodedJsonStringBytes,
  MAX_INSTRUCTIONS_ENCODED_BYTES,
  MAX_SKILL_MARKDOWN_ENCODED_BYTES,
} from "../trade/settings.js";
import { isTradeLlmModelId } from "../trade/llm.js";
import type {
  LpPositionRecord,
  LpQuotaUsage,
  LpSequenceRecord,
} from "../store/lpSequences.js";
import type { JournalEntry } from "../store/journal.js";
import { V3_FEE_TIERS, type V3FeeTier } from "../ops/route.js";

/** Parse outcome, mirroring `src/http/wire.ts`. */
export type LpParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function fail<T>(message: string): LpParseResult<T> {
  return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWei(value: unknown, field: string): LpParseResult<bigint> {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      return fail(`"${field}" must be a non-negative safe integer or a decimal string.`);
    }
    return { ok: true, value: BigInt(value) };
  }
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) {
    return fail(`"${field}" must be a decimal string of up to 78 digits.`);
  }
  return { ok: true, value: BigInt(value) };
}

function readAddress(value: unknown, field: string): LpParseResult<Address> {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    return fail(`"${field}" must be a 20-byte hex address.`);
  }
  return { ok: true, value: getAddress(value) };
}

function readInt(value: unknown, field: string): LpParseResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail(`"${field}" must be an integer.`);
  }
  return { ok: true, value };
}

function readBool(value: unknown, field: string): LpParseResult<boolean> {
  if (typeof value !== "boolean") return fail(`"${field}" must be a boolean.`);
  return { ok: true, value };
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return `${where} carries an unexpected field "${key}".`;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* lpSettings params                                                          */
/* -------------------------------------------------------------------------- */

const SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "autoRotate",
  "autoHarvest",
  "rotateBandBps",
  "rotateMinHoldMinutes",
  "harvestMinFeesWei",
  "stopLossPct",
  "takeProfitPct",
  "maxExitSequencesPerDay",
  "minMinutesBetweenExits",
  "brainEnabled",
  "brain",
  "stakingEnabled",
  "accumulateMode",
  "minAprBps",
  // PHASE3.1 Rev2 items 5/6. A key added here is ADDITIVE — a stored row that
  // lacks it still parses (`rejectUnknownKeys` only refuses keys that are
  // PRESENT), which is exactly why the name must be right the first time.
  "exitToQuote",
  /**
   * PHASE3.6, and the direction that is NOT symmetric (Rev2 M3).
   *
   * Adding a key here is additive FORWARD and ONE-WAY BACKWARD. A build without
   * these keys fails `parseLpSettingsParams` on the WHOLE row, and
   * `loadPositionContext` then returns `kind: "skip"` — no rotate, no harvest,
   * NO STOP-LOSS, every cycle, for ever, surfaced only as an "unreadable
   * settings" reason.
   *
   * THE ROLLBACK PROCEDURE, therefore: clear the price triggers with an
   * owner-signed `live-lp settings --clear-price-triggers` FIRST, then roll
   * back. `live-lp` has that flag for exactly this reason.
   */
  "priceStopLoss",
  "priceTakeProfit",
  /**
   * PHASE3.13. Additive in the same one-way sense as the two above: a stored
   * row that omits it parses to `"swapped"`, but a build that does not KNOW the
   * key fails `parseLpSettingsParams` on the WHOLE row of any owner who signed
   * it. Rollback procedure: re-sign `live-lp settings --rotate-mode swapped`
   * FIRST (which drops the key from the view, because it is only emitted when
   * non-default), then roll back.
   */
  "rotateMode",
  /**
   * PHASE3.15 — the two-range grid ping-pong. Additive in the SAME one-way
   * sense as `priceStopLoss`, `priceTakeProfit` and `rotateMode`: a stored row
   * that omits it parses to `null` (no grid), but a build that does not KNOW
   * the key fails `parseLpSettingsParams` on the WHOLE row of any owner who
   * signed it — and `loadPositionContext` then returns `kind: "skip"`, so no
   * rotate, no harvest, NO STOP-LOSS, every cycle, surfaced only as an
   * "unreadable settings" reason.
   *
   * THE ROLLBACK PROCEDURE, therefore: re-sign settings with the grid block
   * CLEARED first (`live-grid settings --clear-grid`, which drops the key from
   * the view because it is only emitted when set), then roll back.
   */
  "grid",
]);

/**
 * The DEFAULT settings in WIRE form — what an agent that never signed
 * `lpSettings` is treated as running under. One function, so the default
 * digest (`paramsHash("lpSettings", defaultLpSettingsParams())`) is the same
 * bytes everywhere it is computed.
 */
export function defaultLpSettingsParams(): Record<string, unknown> {
  return lpSettingsParamsView(DEFAULT_LP_SETTINGS);
}

/** A settings object in wire form (bigint as decimal string), field by field. */
export function lpSettingsParamsView(
  settings: LpAutomationSettings,
): Record<string, unknown> {
  return {
    autoRotate: settings.autoRotate,
    autoHarvest: settings.autoHarvest,
    rotateBandBps: settings.rotateBandBps,
    rotateMinHoldMinutes: settings.rotateMinHoldMinutes,
    harvestMinFeesWei: settings.harvestMinFeesWei.toString(10),
    stopLossPct: settings.stopLossPct,
    takeProfitPct: settings.takeProfitPct,
    maxExitSequencesPerDay: settings.maxExitSequencesPerDay,
    minMinutesBetweenExits: settings.minMinutesBetweenExits,
    brainEnabled: settings.brainEnabled,
    ...(settings.brain === undefined ? {} : { brain: brainSettingsParamsView(settings.brain) }),
    stakingEnabled: settings.stakingEnabled,
    accumulateMode: settings.accumulateMode,
    minAprBps: settings.minAprBps,
    // LOAD-BEARING (PHASE3.1 Rev2 item 6): this view is the merge base
    // `live-lp settings` re-signs from after audit A5. A field missing here is
    // silently dropped on every partial re-run — A5 reopened for the new flag.
    exitToQuote: settings.exitToQuote,
    // PHASE3.6 Rev2 M4/M5. PRESENT ONLY WHEN SET, and the asymmetry is
    // load-bearing: `canonicalEncode` drops ABSENT keys but ENCODES present
    // ones, so emitting `priceStopLoss: null` here would move
    // `DEFAULT_SETTINGS_DIGEST` — which `currentSettingsDigest()` compares
    // against every in-flight sequence of every agent with no stored settings
    // row, refusing them all at upgrade. Emitting them when SET is M4: without
    // it, `live-lp settings --auto-harvest` would silently un-sign the stop.
    ...(settings.priceStopLoss === null
      ? {}
      : { priceStopLoss: priceTriggerParamsView(settings.priceStopLoss) }),
    ...(settings.priceTakeProfit === null
      ? {}
      : { priceTakeProfit: priceTriggerParamsView(settings.priceTakeProfit) }),
    // PHASE3.13, and the SAME M4/M5 asymmetry as the two price triggers above,
    // for the same reason: emitting `rotateMode: "swapped"` unconditionally
    // would move `DEFAULT_SETTINGS_DIGEST`, which `currentSettingsDigest()`
    // compares against every in-flight sequence of every agent with NO stored
    // settings row — refusing them all at upgrade. Emitting it when SET is the
    // M4 half: without it, `live-lp settings --auto-harvest` would silently
    // un-sign a swapless owner's mode, because this view is the merge base a
    // partial re-sign starts from.
    //
    // Dropping it when default costs nothing at the parse end: a row without
    // the key re-parses to `"swapped"`, which is the same value.
    ...(settings.rotateMode === DEFAULT_LP_SETTINGS.rotateMode
      ? {}
      : { rotateMode: settings.rotateMode }),
    // PHASE3.15, and the SAME M4/M5 asymmetry a third time (R2.12): emitting
    // `grid: null` unconditionally would move `DEFAULT_SETTINGS_DIGEST`, which
    // `currentSettingsDigest()` compares against every in-flight sequence of
    // every agent with NO stored settings row — refusing them all at upgrade.
    // `test/lp.rotateMode.test.ts`'s digest literal is the tripwire: a `grid`
    // key emitted at its default IS a failure of that test, by design.
    //
    // Emitting it when SET is the M4 half: this view is the merge base a
    // partial re-sign starts from, so a field missing here is silently dropped
    // on every `live-grid settings --something-else`.
    ...(settings.grid === null ? {} : { grid: gridSettingsParamsView(settings.grid) }),
  };
}

/**
 * HTTP-safe settings projection. The canonical serializer above remains the
 * digest/worker representation and deliberately retains the owner's text.
 */
export function lpSettingsResponseView(
  settings: LpAutomationSettings,
): Record<string, unknown> {
  const view = lpSettingsParamsView(settings);
  if (settings.brain === undefined) return view;
  return {
    ...view,
    brain: {
      primaryModel: settings.brain.primaryModel,
      fallbackModel: settings.brain.fallbackModel,
      instructionsBytes: settings.brain.instructions === null
        ? 0
        : encodedJsonStringBytes(settings.brain.instructions),
      skillMarkdownBytes: settings.brain.skillMarkdown === null
        ? 0
        : encodedJsonStringBytes(settings.brain.skillMarkdown),
    },
  };
}

function brainSettingsParamsView(
  brain: LpBrainSettings,
): Record<string, unknown> {
  return {
    primaryModel: brain.primaryModel,
    fallbackModel: brain.fallbackModel,
    instructions: brain.instructions,
    skillMarkdown: brain.skillMarkdown,
  };
}

/** The grid block in wire form, field by field. `null` clears it. */
function gridSettingsParamsView(grid: LpGridSettings): Record<string, unknown> {
  return {
    pool: {
      token0: grid.pool.token0,
      token1: grid.pool.token1,
      fee: grid.pool.fee,
    },
    wbnbIsToken0: grid.wbnbIsToken0,
    tickSpacing: grid.tickSpacing,
    buyRange: { tickLower: grid.buyRange.tickLower, tickUpper: grid.buyRange.tickUpper },
    sellRange: { tickLower: grid.sellRange.tickLower, tickUpper: grid.sellRange.tickUpper },
    // PHASE3.17 R2.2, and the SAME M4/M5 present-only-when-set asymmetry the
    // three keys above it use: `canonicalEncode` drops ABSENT keys but ENCODES
    // present ones, so emitting these at their absent value would change the
    // recomputed digest of every 3.15/3.16-signed grid row — which
    // `currentSettingsDigest()` compares against every in-flight sequence, and
    // which would therefore refuse them all at upgrade. Emitting them when SET
    // is the M4 half: this view is the merge base a partial re-sign starts from,
    // so a field missing here is silently dropped on every
    // `live-grid settings --something-else` and a dual grid would quietly become
    // a single one.
    ...(grid.buyRange2 === undefined
      ? {}
      : { buyRange2: { tickLower: grid.buyRange2.tickLower, tickUpper: grid.buyRange2.tickUpper } }),
    ...(grid.sellRange2 === undefined
      ? {}
      : { sellRange2: { tickLower: grid.sellRange2.tickLower, tickUpper: grid.sellRange2.tickUpper } }),
    maxFlipsPerDay: grid.maxFlipsPerDay,
    minNetEdgeBps: grid.minNetEdgeBps,
    // PHASE3.18 R2.1/R2.2 — the mode, the policy and the requote block, all
    // PRESENT-ONLY-WHEN-SET for the FOURTH time and for the same reason:
    // `canonicalEncode` drops ABSENT keys but ENCODES present ones, so emitting
    // `mode: "fixed"` at its default would move the recomputed digest of every
    // 3.15-3.17-signed grid row and refuse every in-flight sequence at upgrade.
    // Emitting them when SET is the M4 half — this view is the merge base a
    // partial `live-grid settings --something-else` re-signs from, so a field
    // missing here silently un-signs a policy owner's whole ladder mode.
    //
    // ONE-WAY ROLLBACK, the same sense as `buyRange2`: a stored row that omits
    // these parses to a fixed grid, but a build that does not KNOW them fails
    // `parseLpSettingsParams` on the WHOLE row of any owner who signed them —
    // and `loadPositionContext` then returns `kind: "skip"`, so no flip, no
    // requote, NO STOP-LOSS, every cycle. Roll back by re-signing with
    // `grid.mode: "fixed"` (which drops all three keys) FIRST.
    ...(grid.mode === undefined || grid.mode === "fixed" ? {} : { mode: grid.mode }),
    ...(grid.policy === undefined
      ? {}
      : { policy: { gapTicks: grid.policy.gapTicks, widthTicks: grid.policy.widthTicks } }),
    ...(grid.requote === undefined
      ? {}
      : {
          requote: {
            driftPctOfGap: grid.requote.driftPctOfGap,
            maxRequotesPerDay: grid.requote.maxRequotesPerDay,
          },
        }),
    // PHASE3.19 C18 — PRESENT-ONLY-WHEN-SET for the FIFTH time, and the reason
    // has not changed: `canonicalEncode` drops ABSENT keys but ENCODES present
    // ones, so emitting a `ladder` key on a non-ladder grid would move the
    // recomputed digest of every 3.15-3.18-signed grid row and refuse every
    // in-flight sequence at upgrade. `DEFAULT_SETTINGS_DIGEST` does not move,
    // and `test/lp.rotateMode.test.ts`'s literal is the tripwire that says so.
    //
    // Emitting it when SET is the M4 half: this view is the merge base a partial
    // `live-grid settings --something-else` re-signs from, so a field missing
    // here silently un-signs a ladder owner's whole mode.
    ...(grid.ladder === undefined
      ? {}
      : {
          ladder: {
            gapTicks: grid.ladder.gapTicks,
            widthTicks: grid.ladder.widthTicks,
            deployPctBps: grid.ladder.deployPctBps,
            driftPctOfGap: grid.ladder.driftPctOfGap,
            // ─── PHASE3.20 R3.2 / C4 — THE ONE CANONICAL-PARAMS SEAM ────────
            //
            // This is where `paramsHash("lpSettings", …)` actually reads the
            // ladder block, and the first review's migration ruling named four
            // OTHER call sites — a sizing argument, a response body, an import
            // route and an `LpExitQuota` — none of which is reached by
            // `paramsHash` at all. A build that followed it verbatim would have
            // edited four innocent seams and shipped the digest break here.
            //
            // ALL THREE MOTION KEYS ARE PRESENT-ONLY-WHEN-SET, and
            // `maxMovesPerDay` becoming conditional is the half that is easy to
            // miss (N9): under "exactly one form accepted" a new-form signature
            // has no `maxMovesPerDay`, so emitting it unconditionally would
            // either encode `undefined` or force a synthesised legacy value, and
            // the recomputed digest would not match what the owner signed. The
            // rule is EMIT EXACTLY THE FORM THE OWNER SIGNED, KEY FOR KEY —
            // which is also what keeps every LADDER-SIGNED row's recomputed
            // digest byte-identical at upgrade, and `currentSettingsDigest()`
            // compares that against every in-flight sequence.
            //
            // NOTE that `DEFAULT_SETTINGS_DIGEST` is NOT the pin for any of
            // this: `DEFAULT_LP_SETTINGS.grid` is `null`, so nothing emitted
            // inside this block can move it. The pin is a stored-settings
            // ROUND-TRIP over a legacy-form and a new-form object.
            ...(grid.ladder.maxMovesPerDay === undefined
              ? {}
              : { maxMovesPerDay: grid.ladder.maxMovesPerDay }),
            ...(grid.ladder.settlementsPerDay === undefined
              ? {}
              : { settlementsPerDay: grid.ladder.settlementsPerDay }),
            ...(grid.ladder.driftMovesPerDay === undefined
              ? {}
              : { driftMovesPerDay: grid.ladder.driftMovesPerDay }),
            ...(grid.ladder.maxStrandedMinutes === undefined
              ? {}
              : { maxStrandedMinutes: grid.ladder.maxStrandedMinutes }),
            hedge: {
              enabled: grid.ladder.hedge.enabled,
              minMarkoutBps: grid.ladder.hedge.minMarkoutBps,
              maxHedgePctBps: grid.ladder.hedge.maxHedgePctBps,
            },
          },
        }),
    // PHASE3.22 R1 / R5.8 — PRESENT-ONLY-WHEN-SET for the SIXTH time, and the
    // reason still has not changed: `canonicalEncode` drops ABSENT keys but
    // ENCODES present ones, so emitting a `shift` key on a non-shift grid would
    // move the recomputed digest of every 3.15-3.20-signed grid row and refuse
    // every in-flight sequence at upgrade. `DEFAULT_SETTINGS_DIGEST` does not
    // move — `DEFAULT_LP_SETTINGS.grid` is `null`, so nothing emitted inside
    // this block can reach it; the pin is the stored-settings ROUND-TRIP.
    //
    // PHASE3.25 R2.6/R5.1 — emit the two new wei fields only when signed. This
    // preserves every legacy digest and reproduces explicit zero distinctly
    // from absence; bigint is projected to its canonical decimal wire form.
    ...(grid.shift === undefined
      ? {}
      : {
          shift: {
            gapTicks: grid.shift.gapTicks,
            widthTicks: grid.shift.widthTicks,
            deployPctBps: grid.shift.deployPctBps,
            driftPctOfGap: grid.shift.driftPctOfGap,
            shiftsPerDay: grid.shift.shiftsPerDay,
            ...(grid.shift.driftGasBudgetWei === undefined
              ? {}
              : { driftGasBudgetWei: grid.shift.driftGasBudgetWei.toString(10) }),
            ...(grid.shift.driftPerMotionWei === undefined
              ? {}
              : { driftPerMotionWei: grid.shift.driftPerMotionWei.toString(10) }),
          },
        }),
  };
}

const GRID_KEYS: ReadonlySet<string> = new Set([
  "pool",
  "wbnbIsToken0",
  "tickSpacing",
  "buyRange",
  "sellRange",
  /**
   * PHASE3.17 — level 2's pair. Additive in the SAME one-way sense as `grid`
   * itself: a stored row that omits them parses to a single-level grid, but a
   * build that does not KNOW them fails `parseLpSettingsParams` on the WHOLE row
   * of any owner who signed them — and `loadPositionContext` then returns
   * `kind: "skip"`, so no flip, NO STOP-LOSS, every cycle, surfaced only as an
   * "unreadable settings" reason.
   *
   * THE ROLLBACK PROCEDURE, therefore: re-sign the grid block with the second
   * pair CLEARED first (which drops both keys from the view, because they are
   * only emitted when set), then roll back.
   *
   * BOTH-OR-NEITHER is NOT enforced here (review2 N14): both operands are
   * settings fields, so the rule belongs in `validateLpSettings` on the M16
   * split's own criterion, and the worker's own parse is then never weaker than
   * the route's.
   */
  "buyRange2",
  "sellRange2",
  "maxFlipsPerDay",
  "minNetEdgeBps",
  /**
   * PHASE3.18 — the mode split. Additive in the same ONE-WAY sense as
   * `buyRange2`: rolling back to a build that does not know these keys makes
   * `parseLpSettingsParams` fail on the WHOLE row, which disarms the agent
   * silently. Re-sign with `grid.mode: "fixed"` (dropping all three) first.
   */
  "mode",
  "policy",
  "requote",
  /**
   * PHASE3.19 — the LADDER block. Additive in the same ONE-WAY sense as `mode`
   * and `policy`: a stored row that omits it parses to a non-ladder grid, but a
   * build that does not KNOW the key fails `parseLpSettingsParams` on the WHOLE
   * row of any owner who signed it — and `loadPositionContext` then returns
   * `kind: "skip"`, so no motion, NO STOP-LOSS, every cycle. Roll back by
   * re-signing with `grid.mode: "fixed"` (which drops it) FIRST.
   */
  "ladder",
  /**
   * PHASE3.22 R1 — the SHIFT block. Additive in the same ONE-WAY sense as
   * `ladder`: a stored row that omits it parses to a non-shift grid, but a
   * build that does not KNOW the key fails `parseLpSettingsParams` on the WHOLE
   * row of any owner who signed it — and `loadPositionContext` then returns
   * `kind: "skip"`, so no motion, NO STOP-LOSS, every cycle. Roll back by
   * re-signing with `grid.mode: "fixed"` (which drops it) FIRST.
   */
  "shift",
]);

const GRID_POLICY_KEYS: ReadonlySet<string> = new Set(["gapTicks", "widthTicks"]);

/**
 * PHASE3.22 R1 — the shift block's five keys. No legacy form and no optional
 * member, so unlike `GRID_LADDER_KEYS` every one of them is required by the
 * parse below rather than merely allowed.
 */
const GRID_SHIFT_KEYS: ReadonlySet<string> = new Set([
  "gapTicks",
  "widthTicks",
  "deployPctBps",
  "driftPctOfGap",
  "shiftsPerDay",
  "driftGasBudgetWei",
  "driftPerMotionWei",
]);

const GRID_LADDER_KEYS: ReadonlySet<string> = new Set([
  "gapTicks",
  "widthTicks",
  "deployPctBps",
  "driftPctOfGap",
  /**
   * PHASE3.20 D1 — LEGAL-DEPRECATED. It stays in the allowlist because every
   * live 3.19 signature carries it, and the worker re-parses those settings
   * every cycle: removing the key would fail `parseLpSettingsParams` on the
   * WHOLE row and `loadPositionContext` would return `kind: "skip"` — no motion,
   * NO STOP-LOSS, every cycle.
   */
  "maxMovesPerDay",
  /**
   * PHASE3.20 D1/D2 — the two motion counts and the stranding bound. They MUST
   * be here or every new-form signature is rejected as an unknown key; the
   * BOTH-OR-NEITHER rule is NOT enforced here, because both operands are
   * settings fields and the M16 split therefore puts it in `validateLpSettings`,
   * where the worker's own parse is never weaker than the route's.
   *
   * ONE-WAY, like every additive key in this file: a stored row that omits them
   * parses to a legacy ladder, but a build that does not KNOW them fails on the
   * whole row of any owner who signed them. Roll back by re-signing the legacy
   * form FIRST.
   */
  "settlementsPerDay",
  "driftMovesPerDay",
  "maxStrandedMinutes",
  "hedge",
]);

const GRID_LADDER_HEDGE_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "minMarkoutBps",
  "maxHedgePctBps",
]);

const GRID_REQUOTE_KEYS: ReadonlySet<string> = new Set([
  "driftPctOfGap",
  "maxRequotesPerDay",
]);

/**
 * The STRUCTURAL parse of the grid block (R2.8's split, on the
 * {@link readPriceTrigger} pattern): shape, unknown keys, integer ticks, the
 * two range objects. RANGES AND ORDERING live in `validateLpSettings` — the ONE
 * range validator both wire paths call — so the worker's parse is never weaker
 * than the route's, and the CHAIN/CONFIG checks live at the route.
 *
 * `null` is a legal value and means OFF: it is how a grid is cleared, and
 * without it the one-way-rollback procedure above would be unexecutable.
 */
function readGridSettings(
  value: unknown,
  field: string,
): LpParseResult<LpGridSettings | null> {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return fail(`"${field}" must be a JSON object or null.`);
  const unknownKey = rejectUnknownKeys(value, GRID_KEYS, `"${field}"`);
  if (unknownKey !== null) return fail(unknownKey);

  const pool = value["pool"];
  if (!isRecord(pool)) return fail(`"${field}.pool" must be a JSON object.`);
  const unknownPoolKey = rejectUnknownKeys(pool, POOL_KEYS, `"${field}.pool"`);
  if (unknownPoolKey !== null) return fail(unknownPoolKey);
  const token0 = readAddress(pool["token0"], `${field}.pool.token0`);
  if (!token0.ok) return fail(token0.message);
  const token1 = readAddress(pool["token1"], `${field}.pool.token1`);
  if (!token1.ok) return fail(token1.message);
  const fee = readInt(pool["fee"], `${field}.pool.fee`);
  if (!fee.ok) return fail(fee.message);

  const wbnbIsToken0 = readBool(value["wbnbIsToken0"], `${field}.wbnbIsToken0`);
  if (!wbnbIsToken0.ok) return fail(wbnbIsToken0.message);
  const tickSpacing = readInt(value["tickSpacing"], `${field}.tickSpacing`);
  if (!tickSpacing.ok) return fail(tickSpacing.message);

  const ranges: { buyRange?: LpGridRange; sellRange?: LpGridRange } = {};
  for (const name of ["buyRange", "sellRange"] as const) {
    const raw = value[name];
    if (!isRecord(raw)) return fail(`"${field}.${name}" must be a JSON object.`);
    const unknownRangeKey = rejectUnknownKeys(raw, RANGE_KEYS, `"${field}.${name}"`);
    if (unknownRangeKey !== null) return fail(unknownRangeKey);
    const tickLower = readInt(raw["tickLower"], `${field}.${name}.tickLower`);
    if (!tickLower.ok) return fail(tickLower.message);
    const tickUpper = readInt(raw["tickUpper"], `${field}.${name}.tickUpper`);
    if (!tickUpper.ok) return fail(tickUpper.message);
    ranges[name] = { tickLower: tickLower.value, tickUpper: tickUpper.value };
  }
  const buyRange = ranges.buyRange;
  const sellRange = ranges.sellRange;
  if (buyRange === undefined || sellRange === undefined) {
    return fail(`"${field}" must carry both buyRange and sellRange.`);
  }

  // PHASE3.17 R2.2 — level 2's pair, each read INDEPENDENTLY and each optional.
  // The both-or-neither rule is `validateLpSettings`'s (review2 N14), so this
  // parse expresses only SHAPE and a half-signed pair reaches the validator to
  // be refused there — which is what keeps the worker's own parse from being
  // weaker than the route's.
  const pairTwo: { buyRange2?: LpGridRange; sellRange2?: LpGridRange } = {};
  for (const name of ["buyRange2", "sellRange2"] as const) {
    const raw = value[name];
    if (raw === undefined) continue;
    if (!isRecord(raw)) return fail(`"${field}.${name}" must be a JSON object when present.`);
    const unknownRangeKey = rejectUnknownKeys(raw, RANGE_KEYS, `"${field}.${name}"`);
    if (unknownRangeKey !== null) return fail(unknownRangeKey);
    const tickLower = readInt(raw["tickLower"], `${field}.${name}.tickLower`);
    if (!tickLower.ok) return fail(tickLower.message);
    const tickUpper = readInt(raw["tickUpper"], `${field}.${name}.tickUpper`);
    if (!tickUpper.ok) return fail(tickUpper.message);
    pairTwo[name] = { tickLower: tickLower.value, tickUpper: tickUpper.value };
  }

  const maxFlipsPerDay = readInt(value["maxFlipsPerDay"], `${field}.maxFlipsPerDay`);
  if (!maxFlipsPerDay.ok) return fail(maxFlipsPerDay.message);
  const minNetEdgeBps = readInt(value["minNetEdgeBps"], `${field}.minNetEdgeBps`);
  if (!minNetEdgeBps.ok) return fail(minNetEdgeBps.message);

  // PHASE3.18 — STRUCTURE ONLY, on the `buyRange2` pattern: shape, unknown
  // keys, integer fields. Every RULE about them (the mode/block coupling, the
  // bounds, the joint reachability rule, the R2.1 coherence check) lives in
  // `validateLpSettings`, because both operands of each are settings fields —
  // the M16 split — so the worker's own parse is never weaker than the route's.
  const rawMode = value["mode"];
  let mode: LpGridMode | undefined;
  if (rawMode !== undefined) {
    if (
      rawMode !== "fixed"
      && rawMode !== "policy"
      && rawMode !== "ladder"
      && rawMode !== "shift"
    ) {
      return fail(
        `"${field}.mode" must be "fixed", "policy", "ladder" or "shift" when present.`,
      );
    }
    mode = rawMode;
  }
  const rawPolicy = value["policy"];
  let policy: LpGridPolicy | undefined;
  if (rawPolicy !== undefined) {
    if (!isRecord(rawPolicy)) {
      return fail(`"${field}.policy" must be a JSON object when present.`);
    }
    const unknownPolicyKey = rejectUnknownKeys(
      rawPolicy,
      GRID_POLICY_KEYS,
      `"${field}.policy"`,
    );
    if (unknownPolicyKey !== null) return fail(unknownPolicyKey);
    const gapTicks = readInt(rawPolicy["gapTicks"], `${field}.policy.gapTicks`);
    if (!gapTicks.ok) return fail(gapTicks.message);
    const widthTicks = readInt(rawPolicy["widthTicks"], `${field}.policy.widthTicks`);
    if (!widthTicks.ok) return fail(widthTicks.message);
    policy = { gapTicks: gapTicks.value, widthTicks: widthTicks.value };
  }
  const rawRequote = value["requote"];
  let requote: LpGridRequote | undefined;
  if (rawRequote !== undefined) {
    if (!isRecord(rawRequote)) {
      return fail(`"${field}.requote" must be a JSON object when present.`);
    }
    const unknownRequoteKey = rejectUnknownKeys(
      rawRequote,
      GRID_REQUOTE_KEYS,
      `"${field}.requote"`,
    );
    if (unknownRequoteKey !== null) return fail(unknownRequoteKey);
    const driftPctOfGap = readInt(
      rawRequote["driftPctOfGap"],
      `${field}.requote.driftPctOfGap`,
    );
    if (!driftPctOfGap.ok) return fail(driftPctOfGap.message);
    const maxRequotesPerDay = readInt(
      rawRequote["maxRequotesPerDay"],
      `${field}.requote.maxRequotesPerDay`,
    );
    if (!maxRequotesPerDay.ok) return fail(maxRequotesPerDay.message);
    requote = {
      driftPctOfGap: driftPctOfGap.value,
      maxRequotesPerDay: maxRequotesPerDay.value,
    };
  }
  // PHASE3.19 — STRUCTURE ONLY, on the `policy`/`requote` pattern: shape,
  // unknown keys, integer/boolean fields. Every RULE about them (the mode
  // coupling, the bounds, the three-way reachability rule, the coherence check,
  // the stopLossPct refusal) lives in `validateLpSettings`, because both
  // operands of each are settings fields — the M16 split — so the worker's own
  // parse is never weaker than the route's.
  const rawLadder = value["ladder"];
  let ladder: LpGridLadder | undefined;
  if (rawLadder !== undefined) {
    if (!isRecord(rawLadder)) {
      return fail(`"${field}.ladder" must be a JSON object when present.`);
    }
    const unknownLadderKey = rejectUnknownKeys(
      rawLadder,
      GRID_LADDER_KEYS,
      `"${field}.ladder"`,
    );
    if (unknownLadderKey !== null) return fail(unknownLadderKey);
    const ladderGap = readInt(rawLadder["gapTicks"], `${field}.ladder.gapTicks`);
    if (!ladderGap.ok) return fail(ladderGap.message);
    const ladderWidth = readInt(rawLadder["widthTicks"], `${field}.ladder.widthTicks`);
    if (!ladderWidth.ok) return fail(ladderWidth.message);
    const deployPctBps = readInt(
      rawLadder["deployPctBps"],
      `${field}.ladder.deployPctBps`,
    );
    if (!deployPctBps.ok) return fail(deployPctBps.message);
    const ladderDrift = readInt(
      rawLadder["driftPctOfGap"],
      `${field}.ladder.driftPctOfGap`,
    );
    if (!ladderDrift.ok) return fail(ladderDrift.message);
    // PHASE3.20 D1 — STRUCTURE ONLY, and each of the four is optional HERE.
    // "Exactly one form", the 1..24 / 0..24 bounds and the stranding bound's
    // computed floor are all rules whose operands are settings fields, so they
    // live in `validateLpSettings` (the M16 split). A key that is present must
    // still be an integer, which is what this layer is for.
    const maxMovesPerDay =
      rawLadder["maxMovesPerDay"] === undefined
        ? null
        : readInt(rawLadder["maxMovesPerDay"], `${field}.ladder.maxMovesPerDay`);
    if (maxMovesPerDay !== null && !maxMovesPerDay.ok) return fail(maxMovesPerDay.message);
    const settlementsPerDay =
      rawLadder["settlementsPerDay"] === undefined
        ? null
        : readInt(rawLadder["settlementsPerDay"], `${field}.ladder.settlementsPerDay`);
    if (settlementsPerDay !== null && !settlementsPerDay.ok) {
      return fail(settlementsPerDay.message);
    }
    const driftMovesPerDay =
      rawLadder["driftMovesPerDay"] === undefined
        ? null
        : readInt(rawLadder["driftMovesPerDay"], `${field}.ladder.driftMovesPerDay`);
    if (driftMovesPerDay !== null && !driftMovesPerDay.ok) {
      return fail(driftMovesPerDay.message);
    }
    const maxStrandedMinutes =
      rawLadder["maxStrandedMinutes"] === undefined
        ? null
        : readInt(rawLadder["maxStrandedMinutes"], `${field}.ladder.maxStrandedMinutes`);
    if (maxStrandedMinutes !== null && !maxStrandedMinutes.ok) {
      return fail(maxStrandedMinutes.message);
    }
    const rawHedge = rawLadder["hedge"];
    if (!isRecord(rawHedge)) {
      return fail(`"${field}.ladder.hedge" must be a JSON object.`);
    }
    const unknownHedgeKey = rejectUnknownKeys(
      rawHedge,
      GRID_LADDER_HEDGE_KEYS,
      `"${field}.ladder.hedge"`,
    );
    if (unknownHedgeKey !== null) return fail(unknownHedgeKey);
    const hedgeEnabled = readBool(rawHedge["enabled"], `${field}.ladder.hedge.enabled`);
    if (!hedgeEnabled.ok) return fail(hedgeEnabled.message);
    const minMarkoutBps = readInt(
      rawHedge["minMarkoutBps"],
      `${field}.ladder.hedge.minMarkoutBps`,
    );
    if (!minMarkoutBps.ok) return fail(minMarkoutBps.message);
    const maxHedgePctBps = readInt(
      rawHedge["maxHedgePctBps"],
      `${field}.ladder.hedge.maxHedgePctBps`,
    );
    if (!maxHedgePctBps.ok) return fail(maxHedgePctBps.message);
    ladder = {
      gapTicks: ladderGap.value,
      widthTicks: ladderWidth.value,
      deployPctBps: deployPctBps.value,
      driftPctOfGap: ladderDrift.value,
      // Present-only-when-set on the way IN as well as on the way out, so a
      // round trip through this parse and `gridSettingsParamsView` is
      // key-for-key identical to what the owner signed.
      ...(maxMovesPerDay === null ? {} : { maxMovesPerDay: maxMovesPerDay.value }),
      ...(settlementsPerDay === null
        ? {}
        : { settlementsPerDay: settlementsPerDay.value }),
      ...(driftMovesPerDay === null
        ? {}
        : { driftMovesPerDay: driftMovesPerDay.value }),
      ...(maxStrandedMinutes === null
        ? {}
        : { maxStrandedMinutes: maxStrandedMinutes.value }),
      hedge: {
        enabled: hedgeEnabled.value,
        minMarkoutBps: minMarkoutBps.value,
        maxHedgePctBps: maxHedgePctBps.value,
      },
    };
  }

  // PHASE3.22 R1 — the SHIFT block, STRUCTURE ONLY, on the ladder's own
  // pattern: shape, unknown keys, integer fields. Every RULE (the mode/block
  // coupling, the bounds, the spacing multiples, the reachability conjunct, the
  // coherence check) lives in `validateLpSettings`, because both operands of
  // each are settings fields — the M16 split — so the worker's own parse is
  // never weaker than the route's.
  //
  // PHASE3.25 R2.6/R5.1 — the original five keys stay required. The signed
  // budget/price pair is optional for legacy rows and present-only-when-set in
  // both directions; validation enforces both-or-neither.
  const rawShift = value["shift"];
  let shift: LpGridShift | undefined;
  if (rawShift !== undefined) {
    if (!isRecord(rawShift)) {
      return fail(`"${field}.shift" must be a JSON object when present.`);
    }
    const unknownShiftKey = rejectUnknownKeys(
      rawShift,
      GRID_SHIFT_KEYS,
      `"${field}.shift"`,
    );
    if (unknownShiftKey !== null) return fail(unknownShiftKey);
    const shiftGap = readInt(rawShift["gapTicks"], `${field}.shift.gapTicks`);
    if (!shiftGap.ok) return fail(shiftGap.message);
    const shiftWidth = readInt(rawShift["widthTicks"], `${field}.shift.widthTicks`);
    if (!shiftWidth.ok) return fail(shiftWidth.message);
    const shiftDeploy = readInt(
      rawShift["deployPctBps"],
      `${field}.shift.deployPctBps`,
    );
    if (!shiftDeploy.ok) return fail(shiftDeploy.message);
    const shiftDrift = readInt(
      rawShift["driftPctOfGap"],
      `${field}.shift.driftPctOfGap`,
    );
    if (!shiftDrift.ok) return fail(shiftDrift.message);
    const shiftsPerDay = readInt(
      rawShift["shiftsPerDay"],
      `${field}.shift.shiftsPerDay`,
    );
    if (!shiftsPerDay.ok) return fail(shiftsPerDay.message);
    const driftGasBudgetWei = rawShift["driftGasBudgetWei"] === undefined
      ? null
      : readWei(rawShift["driftGasBudgetWei"], `${field}.shift.driftGasBudgetWei`);
    if (driftGasBudgetWei !== null && !driftGasBudgetWei.ok) {
      return fail(driftGasBudgetWei.message);
    }
    const driftPerMotionWei = rawShift["driftPerMotionWei"] === undefined
      ? null
      : readWei(rawShift["driftPerMotionWei"], `${field}.shift.driftPerMotionWei`);
    if (driftPerMotionWei !== null && !driftPerMotionWei.ok) {
      return fail(driftPerMotionWei.message);
    }
    shift = {
      gapTicks: shiftGap.value,
      widthTicks: shiftWidth.value,
      deployPctBps: shiftDeploy.value,
      driftPctOfGap: shiftDrift.value,
      shiftsPerDay: shiftsPerDay.value,
      ...(driftGasBudgetWei === null ? {} : { driftGasBudgetWei: driftGasBudgetWei.value }),
      ...(driftPerMotionWei === null ? {} : { driftPerMotionWei: driftPerMotionWei.value }),
    };
  }

  return {
    ok: true,
    value: {
      pool: { token0: token0.value, token1: token1.value, fee: fee.value },
      wbnbIsToken0: wbnbIsToken0.value,
      tickSpacing: tickSpacing.value,
      buyRange,
      sellRange,
      ...(pairTwo.buyRange2 === undefined ? {} : { buyRange2: pairTwo.buyRange2 }),
      ...(pairTwo.sellRange2 === undefined ? {} : { sellRange2: pairTwo.sellRange2 }),
      maxFlipsPerDay: maxFlipsPerDay.value,
      minNetEdgeBps: minNetEdgeBps.value,
      ...(mode === undefined ? {} : { mode }),
      ...(policy === undefined ? {} : { policy }),
      ...(requote === undefined ? {} : { requote }),
      ...(ladder === undefined ? {} : { ladder }),
      ...(shift === undefined ? {} : { shift }),
    },
  };
}

/** A trigger in wire form, field by field. `null` clears it. */
function priceTriggerParamsView(
  trigger: LpPriceTrigger,
): Record<string, unknown> {
  return {
    token0: trigger.token0,
    token1: trigger.token1,
    fee: trigger.fee,
    tick: trigger.tick,
    when: trigger.when,
  };
}

const PRICE_TRIGGER_KEYS: ReadonlySet<string> = new Set([
  "token0",
  "token1",
  "fee",
  "tick",
  "when",
]);

/**
 * The STRUCTURAL parse of a price trigger (Rev2 M16) — shape and unknown keys,
 * on the `POOL_KEYS` / `RANGE_KEYS` pattern. RANGES live in
 * `validateLpSettings`, the one range validator both wire paths call.
 *
 * `null` is a legal value and means OFF: it is how a trigger is cleared, and
 * without it M3's rollback procedure would be unexecutable.
 */
function readPriceTrigger(
  value: unknown,
  field: string,
): LpParseResult<LpPriceTrigger | null> {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) {
    return fail(`"${field}" must be a JSON object or null.`);
  }
  const unknownKey = rejectUnknownKeys(value, PRICE_TRIGGER_KEYS, `"${field}"`);
  if (unknownKey !== null) return fail(unknownKey);
  const token0 = readAddress(value["token0"], `${field}.token0`);
  if (!token0.ok) return fail(token0.message);
  const token1 = readAddress(value["token1"], `${field}.token1`);
  if (!token1.ok) return fail(token1.message);
  const fee = readInt(value["fee"], `${field}.fee`);
  if (!fee.ok) return fail(fee.message);
  const tick = readInt(value["tick"], `${field}.tick`);
  if (!tick.ok) return fail(tick.message);
  const when = value["when"];
  if (when !== "at-or-below" && when !== "at-or-above") {
    return fail(`"${field}.when" must be "at-or-below" or "at-or-above".`);
  }
  return {
    ok: true,
    value: {
      token0: token0.value,
      token1: token1.value,
      fee: fee.value,
      tick: tick.value,
      when,
    },
  };
}

const BRAIN_KEYS: ReadonlySet<string> = new Set([
  "primaryModel",
  "fallbackModel",
  "instructions",
  "skillMarkdown",
]);

function readBoundedText(
  value: unknown,
  field: string,
  maxBytes: number,
): LpParseResult<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return fail(`"${field}" must be a string or null.`);
  const bytes = encodedJsonStringBytes(value);
  if (bytes > maxBytes) {
    return fail(`"${field}" must encode to at most ${maxBytes} bytes; received ${bytes}.`);
  }
  return { ok: true, value };
}

function readBrainSettings(
  value: unknown,
): LpParseResult<LpBrainSettings> {
  if (!isRecord(value)) return fail('"brain" must be a JSON object.');
  const unknown = rejectUnknownKeys(value, BRAIN_KEYS, '"brain"');
  if (unknown !== null) return fail(unknown);
  for (const key of BRAIN_KEYS) {
    if (!Object.hasOwn(value, key)) {
      return fail(`"brain" is missing key "${key}"; unset values must be null.`);
    }
  }
  const primaryModel = value["primaryModel"];
  if (!isTradeLlmModelId(primaryModel)) return fail('"brain.primaryModel" is not an offered model.');
  const fallbackModel = value["fallbackModel"];
  if (!isTradeLlmModelId(fallbackModel)) return fail('"brain.fallbackModel" is not an offered model.');
  if (primaryModel === fallbackModel) {
    return fail('"brain.fallbackModel" must differ from "brain.primaryModel".');
  }
  const instructions = readBoundedText(
    value["instructions"],
    "brain.instructions",
    MAX_INSTRUCTIONS_ENCODED_BYTES,
  );
  if (!instructions.ok) return instructions;
  const skillMarkdown = readBoundedText(
    value["skillMarkdown"],
    "brain.skillMarkdown",
    MAX_SKILL_MARKDOWN_ENCODED_BYTES,
  );
  if (!skillMarkdown.ok) return skillMarkdown;
  return {
    ok: true,
    value: {
      primaryModel,
      fallbackModel,
      instructions: instructions.value,
      skillMarkdown: skillMarkdown.value,
    },
  };
}

/**
 * Interpret `lpSettings` params AFTER signature verification. Absent fields
 * take the spec's defaults; present fields are strictly typed; the assembled
 * object then runs `validateLpSettings` — the ONE range validator — so the
 * spec table (`stakingEnabled` must be false, `accumulateMode` must be
 * "compound", every numeric range) is enforced here without a second copy.
 */
export function parseLpSettingsParams(
  params: unknown,
): LpParseResult<LpAutomationSettings> {
  if (!isRecord(params)) return fail("Settings params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(params, SETTINGS_KEYS, "Settings params");
  if (unknownKey !== null) return fail(unknownKey);

  const out: {
    -readonly [K in keyof LpAutomationSettings]: LpAutomationSettings[K];
  } = { ...DEFAULT_LP_SETTINGS };

  const readOptBool = (
    field:
      | "autoRotate"
      | "autoHarvest"
      | "brainEnabled"
      | "stakingEnabled"
      | "exitToQuote",
  ): string | null => {
    if (params[field] === undefined) return null;
    const parsed = readBool(params[field], field);
    if (!parsed.ok) return parsed.message;
    out[field] = parsed.value;
    return null;
  };
  const readOptInt = (
    field:
      | "rotateBandBps"
      | "rotateMinHoldMinutes"
      | "stopLossPct"
      | "takeProfitPct"
      | "maxExitSequencesPerDay"
      | "minMinutesBetweenExits"
      | "minAprBps",
  ): string | null => {
    if (params[field] === undefined) return null;
    const parsed = readInt(params[field], field);
    if (!parsed.ok) return parsed.message;
    out[field] = parsed.value;
    return null;
  };

  // `exitToQuote` rides the SAME optional-boolean path as the rest: a row that
  // omits it keeps `DEFAULT_LP_SETTINGS.exitToQuote` (true) — Rev2 item 7's
  // migration, which needs no migration code.
  for (const field of [
    "autoRotate",
    "autoHarvest",
    "brainEnabled",
    "stakingEnabled",
    "exitToQuote",
  ] as const) {
    const problem = readOptBool(field);
    if (problem !== null) return fail(problem);
  }
  for (const field of [
    "rotateBandBps",
    "rotateMinHoldMinutes",
    "stopLossPct",
    "takeProfitPct",
    "maxExitSequencesPerDay",
    "minMinutesBetweenExits",
    "minAprBps",
  ] as const) {
    const problem = readOptInt(field);
    if (problem !== null) return fail(problem);
  }
  for (const field of ["priceStopLoss", "priceTakeProfit"] as const) {
    if (params[field] === undefined) continue;
    const parsed = readPriceTrigger(params[field], field);
    if (!parsed.ok) return fail(parsed.message);
    out[field] = parsed.value;
  }
  if (params["harvestMinFeesWei"] !== undefined) {
    const parsed = readWei(params["harvestMinFeesWei"], "harvestMinFeesWei");
    if (!parsed.ok) return fail(parsed.message);
    out.harvestMinFeesWei = parsed.value;
  }
  if (params["accumulateMode"] !== undefined) {
    const mode = params["accumulateMode"];
    if (mode !== "compound" && mode !== "accumulate") {
      return fail('"accumulateMode" must be "compound" or "accumulate".');
    }
    out.accumulateMode = mode;
  }
  if (params["brain"] !== undefined) {
    const parsedBrain = readBrainSettings(params["brain"]);
    if (!parsedBrain.ok) return fail(parsedBrain.message);
    out.brain = parsedBrain.value;
  }
  // PHASE3.13: its OWN two-literal arm, not the optional-boolean loop above —
  // `rotateMode` is a string literal union, and bolting it onto that loop would
  // accept `true`/`false` for a strategy setting.
  if (params["rotateMode"] !== undefined) {
    const mode = params["rotateMode"];
    if (mode !== "swapped" && mode !== "swapless") {
      return fail('"rotateMode" must be "swapped" or "swapless".');
    }
    out.rotateMode = mode;
  }
  // PHASE3.15: its OWN arm, for the same reason `rotateMode` has one — the
  // block is a nested object, not a scalar, and the structural parse is what
  // keeps `validateLpSettings` free to reason about a well-typed value.
  if (params["grid"] !== undefined) {
    const parsedGrid = readGridSettings(params["grid"], "grid");
    if (!parsedGrid.ok) return fail(parsedGrid.message);
    out.grid = parsedGrid.value;
  }

  try {
    validateLpSettings(out);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Settings are invalid.");
  }
  return { ok: true, value: out };
}

/* -------------------------------------------------------------------------- */
/* lpOpen params                                                              */
/* -------------------------------------------------------------------------- */

const OPEN_KEYS: ReadonlySet<string> = new Set([
  "pool",
  "selectPool",
  "range",
  "budgetWei",
]);
const POOL_KEYS: ReadonlySet<string> = new Set(["token0", "token1", "fee"]);
const RANGE_KEYS: ReadonlySet<string> = new Set(["tickLower", "tickUpper"]);

export type LpOpenExplicitPool = {
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: V3FeeTier;
};

export type LpOpenRange =
  | { readonly kind: "explicit"; readonly tickLower: number; readonly tickUpper: number }
  | { readonly kind: "server-fenced" };

export type LpOpenRequest = {
  /** Exactly one of `pool` / `selectPool` is present (Rev2 item 37). */
  readonly pool?: LpOpenExplicitPool;
  readonly selectPool?: "best-apr";
  /** The owner signed the range OR the explicit delegation (Rev2 item 27). */
  readonly range: LpOpenRange;
  readonly budgetWei: bigint;
};

const SELECT_POOL_KEYS: ReadonlySet<string> = new Set(["by", "window"]);

export type LpArmSelectPool = {
  readonly by: "fee-apr" | "volume";
  readonly window: "24h";
};

export type LpArmRequest = {
  readonly settings: LpAutomationSettings;
  readonly settingsParams: Record<string, unknown>;
  readonly budgetWei: bigint;
  readonly pool?: LpOpenExplicitPool;
  readonly selectPool?: LpArmSelectPool;
  readonly range: LpOpenRange;
};

/**
 * Interpret `lpOpen` params. The two consent rules are enforced here, at the
 * boundary, because both are rules about WHAT THE OWNER SIGNED:
 *
 *   - an open that names neither a pool nor `selectPool: "best-apr"` — or
 *     both — is refused (item 37: the delegation is explicit, never implied);
 *   - an open that carries neither an explicit range nor the literal
 *     `range: "server-fenced"` marker is refused (item 27: a brain choice
 *     inserted after the signature would be unbound by `paramsHash`).
 */
export function parseLpOpenParams(params: unknown): LpParseResult<LpOpenRequest> {
  if (!isRecord(params)) return fail("Open params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(params, OPEN_KEYS, "Open params");
  if (unknownKey !== null) return fail(unknownKey);

  const hasPool = params["pool"] !== undefined;
  const hasSelect = params["selectPool"] !== undefined;
  if (hasPool === hasSelect) {
    return fail(
      hasPool
        ? 'Exactly one of "pool" and "selectPool" may be named.'
        : 'The open must name a pool or sign the explicit "selectPool": "best-apr" delegation; neither is refused.',
    );
  }
  if (hasSelect && params["selectPool"] !== "best-apr") {
    return fail('"selectPool" must be the literal "best-apr".');
  }

  let pool: LpOpenExplicitPool | undefined;
  if (hasPool) {
    const raw = params["pool"];
    if (!isRecord(raw)) return fail('"pool" must be a JSON object.');
    const unknownPoolKey = rejectUnknownKeys(raw, POOL_KEYS, '"pool"');
    if (unknownPoolKey !== null) return fail(unknownPoolKey);
    const token0 = readAddress(raw["token0"], "pool.token0");
    if (!token0.ok) return fail(token0.message);
    const token1 = readAddress(raw["token1"], "pool.token1");
    if (!token1.ok) return fail(token1.message);
    if (token0.value.toLowerCase() === token1.value.toLowerCase()) {
      return fail('"pool" legs must be two distinct tokens.');
    }
    if (token0.value.toLowerCase() > token1.value.toLowerCase()) {
      return fail('"pool" legs must be in pool order (token0 < token1).');
    }
    const fee = raw["fee"];
    const tier =
      typeof fee === "number" && Number.isInteger(fee)
        ? V3_FEE_TIERS.find((candidate) => candidate === fee)
        : undefined;
    if (tier === undefined) {
      return fail(`"pool.fee" must be one of: ${V3_FEE_TIERS.join(", ")}.`);
    }
    pool = { token0: token0.value, token1: token1.value, fee: tier };
  }

  const rawRange = params["range"];
  let range: LpOpenRange;
  if (rawRange === "server-fenced") {
    range = { kind: "server-fenced" };
  } else if (isRecord(rawRange)) {
    const unknownRangeKey = rejectUnknownKeys(rawRange, RANGE_KEYS, '"range"');
    if (unknownRangeKey !== null) return fail(unknownRangeKey);
    const tickLower = readInt(rawRange["tickLower"], "range.tickLower");
    if (!tickLower.ok) return fail(tickLower.message);
    const tickUpper = readInt(rawRange["tickUpper"], "range.tickUpper");
    if (!tickUpper.ok) return fail(tickUpper.message);
    if (tickLower.value >= tickUpper.value) {
      return fail('"range.tickLower" must be strictly below "range.tickUpper".');
    }
    range = { kind: "explicit", tickLower: tickLower.value, tickUpper: tickUpper.value };
  } else {
    return fail(
      'The open must sign an explicit "range" or the literal "server-fenced" marker; a range chosen after the signature would be unbound.',
    );
  }

  const budget = readWei(params["budgetWei"], "budgetWei");
  if (!budget.ok) return fail(budget.message);
  if (budget.value <= 0n) return fail('"budgetWei" must be greater than zero.');

  return {
    ok: true,
    value: {
      ...(pool === undefined ? {} : { pool }),
      ...(hasSelect ? { selectPool: "best-apr" as const } : {}),
      range,
      budgetWei: budget.value,
    },
  };
}

const LP_ARM_KEYS: ReadonlySet<string> = new Set([
  "settings",
  "budgetWei",
  "pool",
  "selectPool",
  "range",
]);

export function parseLpArmParams(params: unknown): LpParseResult<LpArmRequest> {
  if (!isRecord(params)) return fail("LP arm params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(params, LP_ARM_KEYS, "LP arm params");
  if (unknownKey !== null) return fail(unknownKey);
  const hasPool = params["pool"] !== undefined;
  const hasSelect = params["selectPool"] !== undefined;
  if (hasPool === hasSelect) {
    return fail(
      hasPool
        ? 'Exactly one of "pool" and "selectPool" may be named.'
        : 'The arm must name a pool or sign an explicit "selectPool" object; neither is refused.',
    );
  }
  const settingsParams = params["settings"];
  if (!isRecord(settingsParams)) {
    return fail('"settings" must be the complete lpSettings params object.');
  }
  const settings = parseLpSettingsParams(settingsParams);
  if (!settings.ok) return fail(settings.message);

  const open = parseLpOpenParams({
    pool: params["pool"],
    ...(hasSelect ? { selectPool: "best-apr" } : {}),
    range: params["range"],
    budgetWei: params["budgetWei"],
  });
  if (!open.ok) return fail(open.message);
  const request = open.value;
  if (request.budgetWei <= 0n) {
    return fail('"budgetWei" must be greater than zero.');
  }
  if (settings.value.grid !== null) {
    return fail("lpArm carries no grid block; use gridArm.");
  }
  let selectPool: LpArmSelectPool | undefined;
  if (params["selectPool"] !== undefined) {
    if (!isRecord(params["selectPool"])) {
      return fail('"selectPool" must be a JSON object.');
    }
    const unknownSelect = rejectUnknownKeys(params["selectPool"], SELECT_POOL_KEYS, '"selectPool"');
    if (unknownSelect !== null) return fail(unknownSelect);
    const by = params["selectPool"]["by"];
    if (by !== "fee-apr" && by !== "volume") {
      return fail('"selectPool.by" must be "fee-apr" or "volume".');
    }
    if (params["selectPool"]["window"] !== "24h") {
      return fail('"selectPool.window" must be "24h"; sub-daily rankings are not served yet.');
    }
    selectPool = { by, window: "24h" };
  }
  return {
    ok: true,
    value: {
      settings: settings.value,
      settingsParams,
      budgetWei: request.budgetWei,
      ...(request.pool === undefined ? {} : { pool: request.pool }),
      ...(selectPool === undefined ? {} : { selectPool }),
      range: request.range,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* lpExit params                                                              */
/* -------------------------------------------------------------------------- */

/**
 * PHASE3.24 C2 takes the additive seam PHASE3.1 left deliberately: a missing
 * `inlineConvert` remains valid and normalizes false, while a new client can
 * sign true for this manual-exit sequence. This does not override the stored
 * `exitToQuote` setting; both must permit conversion.
 */
const EXIT_KEYS: ReadonlySet<string> = new Set(["positionId", "inlineConvert"]);

/** Longest position id accepted anywhere (UUIDs are 36). */
export const MAX_POSITION_ID_CHARS = 128;

/**
 * Interpret `lpExit` params. The position id is INSIDE the signed params so
 * `paramsHash` binds it — the route additionally checks it against the path
 * segment, the same binding discipline `requireBinding` applies to agentId.
 */
export function parseLpExitParams(
  params: unknown,
): LpParseResult<{ readonly positionId: string; readonly inlineConvert: boolean }> {
  if (!isRecord(params)) return fail("Exit params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(params, EXIT_KEYS, "Exit params");
  if (unknownKey !== null) return fail(unknownKey);
  const positionId = params["positionId"];
  if (
    typeof positionId !== "string" ||
    positionId.length === 0 ||
    positionId.length > MAX_POSITION_ID_CHARS
  ) {
    return fail('"positionId" must be a non-empty string.');
  }
  const inlineConvert = params["inlineConvert"];
  if (inlineConvert !== undefined && typeof inlineConvert !== "boolean") {
    return fail('"inlineConvert" must be a boolean when supplied.');
  }
  // PHASE3.24 C2: omitted and explicit false have the same signed meaning.
  return { ok: true, value: { positionId, inlineConvert: inlineConvert === true } };
}

/* -------------------------------------------------------------------------- */
/* resolveUnknown params (PHASE3.3 Rev2 items 6/8)                            */
/* -------------------------------------------------------------------------- */

/**
 * NO `txHash`. The `landed` direction is CUT from v1 (Rev2 item 1): the three
 * predicates a caller-supplied receipt could be bound by — expected effect, on
 * the expected tokenId, from the expected wallet — are satisfied by every
 * legitimate harvest this agent will ever run on the position, and through the
 * resume's `after` replay a caller-chosen `txHash` becomes a caller-chosen
 * AMOUNT. Adding the key later is additive; adding it now would be a forgery
 * surface with money in it.
 */
const RESOLVE_KEYS: ReadonlySet<string> = new Set(["decisionId", "observedBlock"]);
const RESOLVE_LANDING_V1_KEYS: ReadonlySet<string> = new Set([
  "decisionId", "evidenceVersion",
]);
const RETIRE_PRE_BIND_V1_KEYS: ReadonlySet<string> = new Set(["decisionId"]);

export const LP_LANDING_EVIDENCE_VERSION = "lp-landing-evidence-v1" as const;

/** Longest decision id accepted. `lp:<uuid>:<n>` is 42. */
export const MAX_DECISION_ID_CHARS = 128;

/** PHASE3.8 F4a: the abandon takes one field and nothing else. */
const ABANDON_KEYS: ReadonlySet<string> = new Set(["sequenceId"]);

export function parseLpAbandonParams(
  params: unknown,
): LpParseResult<{ readonly sequenceId: string }> {
  if (!isRecord(params)) return fail("Abandon params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(params, ABANDON_KEYS, "Abandon params");
  if (unknownKey !== null) return fail(unknownKey);
  const sequenceId = params["sequenceId"];
  if (
    typeof sequenceId !== "string" ||
    sequenceId.length === 0 ||
    sequenceId.length > MAX_DECISION_ID_CHARS
  ) {
    return fail('"sequenceId" must be a non-empty string.');
  }
  return { ok: true, value: { sequenceId } };
}

/**
 * Interpret `resolveUnknown` params. The decision id is INSIDE the signed
 * params so `paramsHash` binds it; the route additionally checks it against the
 * path segment, the same binding discipline `parseLpExitParams`' caller applies
 * to `positionId` and `requireBinding` applies to `agentId`.
 *
 * `observedBlock` is the CALLER's claim about where they looked. It is recorded
 * as evidence and NEVER trusted: the server reads at its own block and stores
 * both, so an audit can see whether the two agreed.
 */
export function parseLpResolveParams(
  params: unknown,
): LpParseResult<{ readonly decisionId: string; readonly observedBlock: bigint }> {
  if (!isRecord(params)) return fail("Resolve params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(params, RESOLVE_KEYS, "Resolve params");
  if (unknownKey !== null) return fail(unknownKey);
  const decisionId = params["decisionId"];
  if (
    typeof decisionId !== "string" ||
    decisionId.length === 0 ||
    decisionId.length > MAX_DECISION_ID_CHARS
  ) {
    return fail('"decisionId" must be a non-empty string.');
  }
  const observedBlock = readWei(params["observedBlock"], "observedBlock");
  if (!observedBlock.ok) return observedBlock;
  return { ok: true, value: { decisionId, observedBlock: observedBlock.value } };
}

export function parseLpResolveLandingV1Params(
  params: unknown,
): LpParseResult<{
  readonly decisionId: string;
  readonly evidenceVersion: typeof LP_LANDING_EVIDENCE_VERSION;
}> {
  if (!isRecord(params)) return fail("Resolve-landing params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(
    params, RESOLVE_LANDING_V1_KEYS, "Resolve-landing params",
  );
  if (unknownKey !== null) return fail(unknownKey);
  const decisionId = params["decisionId"];
  if (typeof decisionId !== "string" || decisionId.length === 0 ||
      decisionId.length > MAX_DECISION_ID_CHARS) {
    return fail('"decisionId" must be a non-empty string.');
  }
  if (params["evidenceVersion"] !== LP_LANDING_EVIDENCE_VERSION) {
    return fail(`"evidenceVersion" must be "${LP_LANDING_EVIDENCE_VERSION}".`);
  }
  return { ok: true, value: { decisionId, evidenceVersion: LP_LANDING_EVIDENCE_VERSION } };
}

/** Strict signed payload for the local proved-pre-bind retirement route. */
export function parseLpRetirePreBindV1Params(
  params: unknown,
): LpParseResult<{ readonly decisionId: string }> {
  if (!isRecord(params)) return fail("Retire-pre-bind params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(params, RETIRE_PRE_BIND_V1_KEYS, "Retire-pre-bind params");
  if (unknownKey !== null) return fail(unknownKey);
  const decisionId = params["decisionId"];
  if (typeof decisionId !== "string" || decisionId.length === 0 ||
      decisionId.length > MAX_DECISION_ID_CHARS) {
    return fail('"decisionId" must be a non-empty string.');
  }
  return { ok: true, value: { decisionId } };
}

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

/** What the owner is shown about a position. Field by field, no spreading. */
export function lpPositionView(record: LpPositionRecord): Record<string, unknown> {
  return {
    positionId: record.positionId,
    agentId: record.agentId,
    token0: record.token0,
    token1: record.token1,
    fee: record.fee,
    tokenId: record.tokenId,
    lineageId: record.lineageId,
    basisWei: record.basisWei.toString(10),
    basisSource: record.basisSource,
    quoteToken: record.quoteToken,
    state: record.state,
    armMeta: record.armMeta,
    rowVersion: record.rowVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * The worker's stored observation at the JSON boundary. Marketplace detail C2
 * needs the row-version/token identity beside the mark so an old observation
 * can never be presented as the value of a replacement NFT.
 */
export function lpObservationView(
  observation: LpTriggerObservation | null,
): Record<string, unknown> | null {
  if (observation === null) return null;
  return {
    ...(observation.fees === undefined ? {} : { fees: { ...observation.fees, collectible0Wei: observation.fees.collectible0Wei.toString(), collectible1Wei: observation.fees.collectible1Wei.toString(), blockNumber: observation.fees.blockNumber.toString() } }),
    blockNumber: observation.blockNumber.toString(10),
    evaluatedAtMs: observation.evaluatedAtMs,
    poolAddress: observation.poolAddress,
    currentTick: observation.currentTick ?? null,
    ...(observation.tickLower === undefined ? {} : { tickLower: observation.tickLower }),
    ...(observation.tickUpper === undefined ? {} : { tickUpper: observation.tickUpper }),
    valuation:
      observation.valuation === undefined
        ? null
        : {
            method: observation.valuation.method,
            exitValueWei: observation.valuation.exitValueWei.toString(10),
            quoteToken: observation.valuation.quoteToken,
            tokenId: observation.valuation.tokenId,
            positionRowVersion: observation.valuation.positionRowVersion,
            valuedAtMs: observation.valuation.valuedAtMs,
            blockNumber: observation.valuation.blockNumber.toString(10),
          },
  };
}
/* -------------------------------------------------------------------------- */
/* lpImport params (PHASE3.4 Rev2 M2)                                         */
/* -------------------------------------------------------------------------- */

const IMPORT_KEYS: ReadonlySet<string> = new Set(["tokenId", "basisWei"]);

/**
 * A uint256 in CANONICAL decimal. 78 digits is uint256's decimal width.
 *
 * The canonical form is not fussiness — it is what makes
 * `lp_positions_one_live_token_idx` mean anything. `token_id` is a `text`
 * column, every landed writer is canonical by construction
 * (`mintedTokenId.toString(10)`), and the import's tokenId is the first one that
 * is CALLER-SUPPLIED. `BigInt("07")` parses, `ownerOf(7n)` passes, and `"07"`
 * does not collide with `"7"` in a text index: two live rows, one NFT, two
 * sagas — the exact state the index exists to make unreachable, reached through
 * a leading zero.
 */
const CANONICAL_UINT256_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;

export function isCanonicalUint256Decimal(value: string): boolean {
  return CANONICAL_UINT256_DECIMAL.test(value);
}

export type LpImportRequest = {
  /** Canonical decimal, exactly as it will be stored. */
  readonly tokenId: string;
  /** The owner's DECLARED basis in quote wei. Zero is legal and means no TP/SL. */
  readonly basisWei: bigint;
};

/**
 * Interpret `lpImport` params.
 *
 * `tokenId` stays a STRING all the way to the store — parsed to a bigint only
 * for chain reads — so the value the index compares is the value the owner
 * signed, with no round trip through a numeric type to normalise away the
 * difference the index can see.
 *
 * NO legs, NO fee tier, NO ticks: all of those are read from chain
 * (`positions(tokenId)`), which is the difference between an import and a
 * forgery. The worker derives a position's pool purely from the stored row, so a
 * row whose legs did not match its NFT would be valued and rotated against the
 * wrong pool with nothing to detect it. Because the caller supplies no legs,
 * that state is unreachable by construction rather than by validation.
 */
export function parseLpImportParams(
  params: unknown,
): LpParseResult<LpImportRequest> {
  if (!isRecord(params)) return fail("Import params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(params, IMPORT_KEYS, "Import params");
  if (unknownKey !== null) return fail(unknownKey);
  const tokenId = params["tokenId"];
  if (typeof tokenId !== "string" || !isCanonicalUint256Decimal(tokenId)) {
    return fail(
      '"tokenId" must be a uint256 in canonical decimal (no leading zeros, no sign, no hex).',
    );
  }
  // `readWei` already refuses non-digits and over-length values; the bound is
  // restated here only so the two halves of the pair cannot drift apart.
  const basis = readWei(params["basisWei"], "basisWei");
  if (!basis.ok) return fail(basis.message);
  return { ok: true, value: { tokenId, basisWei: basis.value } };
}

/* -------------------------------------------------------------------------- */
/* gridArm params (PHASE3.16 R2.2)                                            */
/* -------------------------------------------------------------------------- */

/**
 * PHASE3.17 R2.2 (ruling Q6) — `levels` rides HERE, on the ENVELOPE, and NOT in
 * `lpSettings`.
 *
 * `budgetWei` is the precedent and it settles the question: it is signed by the
 * very same `gridArm` signature, it sizes the very same mints, and it lives on
 * this envelope. `levels` is the same kind of thing — a ONE-SHOT ACTION
 * parameter, read by exactly one route, and stale the instant one level closes.
 * A field in `lpSettings` would instead be standing automation state the worker
 * recomputes the digest of every cycle.
 *
 * Because it never enters the persisted settings digest:
 *   - `DEFAULT_SETTINGS_DIGEST` cannot move and no proof is owed;
 *   - a 3.16-signed grid row recomputes byte-identically;
 *   - nothing goes stale when one level closes, because nothing is stored.
 *
 * It is still SIGNED — `paramsHash("gridArm", params)` covers the whole
 * envelope — which is what it has to be, since it changes what the budget buys.
 * The PAIR-2 RANGES do live in settings, and correctly: those ARE standing
 * automation state, resolved by the worker every cycle to find each level's
 * role and flip target.
 */
const GRID_ARM_KEYS: ReadonlySet<string> = new Set(["settings", "budgetWei", "levels"]);

export type LpGridArmRequest = {
  /** The COMPLETE settings object, exactly as `/lp/settings` would take it. */
  readonly settings: LpAutomationSettings;
  /**
   * The verbatim `settings` sub-object the owner signed, kept UNPARSED.
   *
   * The stored settings row's `params` and `digest` must be these bytes and
   * `paramsHash("lpSettings", these bytes)` — see the docstring below. Handing
   * the route a re-serialized view instead would produce a digest over bytes
   * the owner did not sign, which is the one thing the worker's every-cycle
   * recompute exists to catch.
   */
  readonly settingsParams: Record<string, unknown>;
  /** Native wei the arm's mint attaches. Strictly positive. */
  readonly budgetWei: bigint;
  /**
   * PHASE3.17 R2.2 — how many levels this arm places. `1` (the default when
   * absent) is 3.16's single-sided arm, byte-identical; `2` is the dual arm.
   * Anything else is refused. An integer rather than a role-named boolean
   * because a future N>2 ladder reuses the same field, and because a role-named
   * flag re-imports the role-vs-pool-order confusion 3.15's own review caught.
   */
  readonly levels: 1 | 2;
};

/**
 * Interpret `gridArm` params: `{ settings: <complete lpSettings params>,
 * budgetWei: "<decimal wei>" }`.
 *
 * WHY THE COMPLETE SETTINGS AND NOT A BARE GRID BLOCK (PHASE3.16 B2, option A).
 * Three independent obstructions killed the grid-block-only envelope:
 *
 *  1. a settings digest is `paramsHash("lpSettings", <the exact signed params>)`
 *     and the WORKER RECOMPUTES IT EVERY CYCLE, skipping the position on a
 *     mismatch because "automation under it would run settings nobody provably
 *     signed". A row whose params the server synthesised from a grid block plus
 *     defaults would pass that recompute while being exactly what the recompute
 *     exists to prevent;
 *  2. `validateLpSettings`'s grid rules are CROSS-FIELD over non-grid settings
 *     — `maxFlipsPerDay` against `minMinutesBetweenExits`, and the grid block
 *     against `autoRotate`/`autoHarvest`. A grid block alone cannot be
 *     validated without inventing the missing fields, and inventing them means
 *     the owner did not sign the settings the validator judged;
 *  3. the client already builds the full object for `/lp/settings`, because it
 *     has to, for reason (2).
 *
 * So the route persists `params.settings` VERBATIM under
 * `digest = paramsHash("lpSettings", params.settings)`. The stored digest is a
 * hash over bytes the owner DID sign, under a different action label — which
 * keeps the worker's recompute invariant byte-for-byte AND keeps the single
 * signature the phase promises.
 *
 * `budgetWei` is refused at zero HERE rather than only at the plan builder: a
 * zero budget is the worker resume's SENTINEL, and a caller must never be able
 * to hand the driver the shape that means "never re-drive".
 */
export function parseLpGridArmParams(
  params: unknown,
): LpParseResult<LpGridArmRequest> {
  if (!isRecord(params)) return fail("Grid arm params must be a JSON object.");
  const unknownKey = rejectUnknownKeys(params, GRID_ARM_KEYS, "Grid arm params");
  if (unknownKey !== null) return fail(unknownKey);
  const settingsParams = params["settings"];
  if (!isRecord(settingsParams)) {
    return fail('"settings" must be the complete lpSettings params object.');
  }
  const settings = parseLpSettingsParams(settingsParams);
  if (!settings.ok) return fail(settings.message);
  const budget = readWei(params["budgetWei"], "budgetWei");
  if (!budget.ok) return fail(budget.message);
  if (budget.value <= 0n) {
    return fail(
      '"budgetWei" must be positive: an arm with no budget mints nothing, and zero is the worker resume\'s never-re-drive sentinel.',
    );
  }
  // PHASE3.17 R2.2. Absent ⇒ 1, so every 3.16 envelope parses unchanged.
  const rawLevels = params["levels"];
  if (rawLevels !== undefined && rawLevels !== 1 && rawLevels !== 2) {
    return fail('"levels" must be 1 or 2 when present; v1 places one or two grid levels.');
  }
  const levels: 1 | 2 = rawLevels === 2 ? 2 : 1;
  return {
    ok: true,
    value: {
      settings: settings.value,
      settingsParams,
      budgetWei: budget.value,
      levels,
    },
  };
}

/**
 * What the owner is shown about a position's PROTECTION (PHASE3.2 Decision 4 /
 * Rev2 items 26–28).
 *
 * The whole failure mode of FINDINGS (ae) is a dashboard that shows "SL: 5%"
 * while the confirmation counter can never reach two. This view is what makes
 * that impossible to miss — including the two checks that silently skip a
 * position on EVERY worker cycle today (an unreadable settings row, a digest
 * that does not recompute) and which nothing an owner could query reported.
 *
 * Field by field, from the ONE `lpProtectionStatus` definition; no second
 * computation of "armed" exists anywhere.
 */
/**
 * What the owner is told about a PRICE trigger on one position (PHASE3.6 Rev2
 * M1). Setting one on the wrong side of the market is the failure this whole
 * phase exists to prevent, so the distance is reported, not merely the value.
 *
 * The tick is AS OF the observation, never "now" — the route makes no chain
 * read, and `observationAgeMs` on the same view is what makes that honest. No
 * observation, or one written before this phase, reports `null` distance.
 */
export function lpPriceTriggerView(input: {
  readonly label: "stopLoss" | "takeProfit";
  readonly trigger: LpPriceTrigger;
  readonly observedTick: number | null;
}): Record<string, unknown> {
  const { trigger, observedTick } = input;
  const breached =
    observedTick === null ? null : priceTriggerFires(trigger, observedTick);
  return {
    label: input.label,
    token0: trigger.token0,
    token1: trigger.token1,
    fee: trigger.fee,
    tick: trigger.tick,
    when: trigger.when,
    observedTick,
    breachedAtObservation: breached,
    // Signed, not absolute: the sign says which way the market must move.
    ticksAway: observedTick === null ? null : trigger.tick - observedTick,
    note:
      "The tick is as of this position's last observation, not as of now — read it with observationAgeMs. A protect still needs two consecutive finalized confirmations and the manipulation rails.",
  };
}

export function lpProtectionView(
  status: LpProtectionStatus,
): Record<string, unknown> {
  return {
    armed: status.armed,
    reason: status.reason,
    settingsReadable: status.settingsReadable,
    digestVerified: status.digestVerified,
    stopLossPct: status.stopLossPct,
    takeProfitPct: status.takeProfitPct,
    observationHeldAtMs: status.observationHeldAtMs,
    observationAgeMs: status.observationAgeMs,
    observationStale: status.observationStale,
    protectConsecutive: status.protectConsecutive,
    confirmationEligibleAtMs: status.confirmationEligibleAtMs,
    maxObservationAgeMs: status.maxObservationAgeMs,
    /**
     * PHASE3.3 Rev2 item 18. Non-null names the sequence an owner has to
     * resolve before this position's stop-loss can fire — the counterpart the
     * resolution action would otherwise have no surface pointing at it.
     */
    blockedBySequence:
      status.blockedBySequence === null
        ? null
        : {
            sequenceId: status.blockedBySequence.sequenceId,
            kind: status.blockedBySequence.kind,
          },
    /**
     * PHASE3.4 Rev2 M6. Nonzero means a finalized `ownerOf` read says the NFT
     * is not the agent's wallet's any more, and the position is not protected
     * whatever the settings say. Two consecutive confirmations also close the
     * row, so the count is the owner's warning that it is about to.
     */
    ownershipMismatchCount: status.ownershipMismatchCount,
    ownershipLostReason: status.ownershipLostReason,
    /**
     * PHASE3.6: the matched price triggers, with how far they are from firing.
     * AUDIT A3 — this used to emit the RAW records, so `lpPriceTriggerView` was
     * dead code and decision 5's breached/distance report never reached the
     * wire at all.
     */
    priceTriggers: (status.priceTriggers ?? []).map((entry) =>
      lpPriceTriggerView(entry),
    ),
  };
}

/**
 * What the owner is told about their own automation budget (PHASE3.5
 * decision 4).
 *
 * It exists because nothing reported this. An owner can SIGN
 * `maxExitSequencesPerDay`, and when the daemon refused a harvest every minute
 * for hours on mainnet (FINDINGS (ao) gap 1) the only place that fact lived was
 * one log line on the operator's terminal — the (ae) family, where the system
 * knows and the dashboard does not.
 *
 * `liveCount` is what the LIMIT sees. `nextEligibleAtMs` is computed from the
 * latest reservation over ALL in-window rows, RELEASED INCLUDED, because that is
 * the rule the spacing gate actually enforces (PHASE3.5 Rev2 M3) — a surface
 * that reported a different rule than the refusal would be a new lie in the
 * family this block exists to close.
 */
export function lpQuotaView(input: {
  readonly usage: LpQuotaUsage;
  readonly maxExitSequencesPerDay: number;
  readonly minMinutesBetweenExits: number;
  /**
   * False when the worker would SKIP this agent's positions outright — an
   * unreadable settings row, or a digest that does not recompute (audit A3).
   * The counts stay real; what stops being real is the implication that a
   * budget is being consumed.
   */
  readonly automationRunning?: boolean;
}): Record<string, unknown> {
  const { usage } = input;
  return {
    limit: input.maxExitSequencesPerDay,
    used: usage.liveCount,
    remaining: Math.max(0, input.maxExitSequencesPerDay - usage.liveCount),
    releasedInWindow: usage.releasedCount,
    exhausted: usage.liveCount >= input.maxExitSequencesPerDay,
    oldestSlotFreesAtMs: usage.oldestLiveExpiresAtMs,
    minMinutesBetweenExits: input.minMinutesBetweenExits,
    nextEligibleAtMs:
      usage.latestReservedAtMs === null
        ? null
        : usage.latestReservedAtMs + input.minMinutesBetweenExits * 60_000,
    // AUDIT A3: when the stored settings cannot be trusted the limits shown are
    // the DEFAULTS, and the note says so — otherwise an owner debugs a quota
    // while the actual fault is a settings row the worker refuses to run under.
    automationRunning: input.automationRunning ?? true,
    note:
      input.automationRunning === false
        ? "The worker is SKIPPING this agent's positions because its stored settings do not parse or their digest does not recompute, so nothing is consuming this budget. The limits shown are the defaults, not the stored row. Fix the settings row first; each position's armed reason names it."
        : "Only rotate and harvest are refused by this limit; protect, manual exit and open are exempt and always run. Since PHASE3.7 F2 the exempt kinds no longer OCCUPY the limit either, so used + releasedInWindow do not add up to every reservation in the window — exempt ones are in neither count. A slot is released when its sequence ended having provably made no submission. The spacing gate is unfiltered and still counts BOTH released slots and exempt ones, so a stop-loss or an open can still push the next rotate out by minMinutesBetweenExits.",
  };
}

/**
 * What the journal knows about ONE recorded step, reduced to the facts a reader
 * of the sequence view needs. Derived by {@link lpStepOutcome} from a row the
 * CALLER fetched — this module reads no store and no journal
 * (PHASE3.1-FIXREVIEW2 **G4**).
 *
 * `state` is the journal row's state, or `null` when there is NO ROW under the
 * step's key. That is not an error: `appendStep` runs strictly before
 * `beginWithSpend`, so a missing row means the process died in between, and the
 * saga's own join treats it as provably-never-submitted.
 *
 * `submitted` is a TRI-STATE — see {@link lpStepOutcome} for why it cannot be a
 * boolean.
 *
 * `unreadable` distinguishes "the journal says there is nothing" from "we could
 * not ask". Without it a read failure would render byte-identically to a step
 * that never began, and the caller must not answer a 500 on an owner's
 * dashboard just because one row would not read.
 */
export type LpSequenceStepOutcome = {
  readonly state: string | null;
  /** `true` reached a relay, `false` provably did not, `null` unknown. */
  readonly submitted: boolean | null;
  /** A confirmed receipt hash only; a relay callsId is never a transaction. */
  readonly txHash: string | null;
  readonly unreadable: boolean;
};

/**
 * The reading a step gets when its row could not be READ — exported so the
 * route and these tests cannot drift on it. `submitted: null`, not `false`: a
 * read that failed is not evidence about what the step did.
 */
export const LP_STEP_OUTCOME_UNREADABLE: LpSequenceStepOutcome = {
  state: null,
  submitted: null,
  txHash: null,
  unreadable: true,
};

/**
 * THE derivation of one step's outcome from its journal row. One definition,
 * used by `GET /agents/:id/lp` and by nothing else, for the same reason
 * {@link lpProtectionView} takes a computed `LpProtectionStatus`: a second copy
 * of this rule in the route is a rule no test can pin.
 *
 * **`submitted` IS NOT `callsHash` (PHASE3.1-FIXREVIEW3 H5).** G4's first
 * implementation read `externalRef.callsHash`, and that field is written by
 * `beginWithSpend` — BEFORE the daily-cap re-check, before the late kill-switch
 * re-check, before `restoreSession`, before `preflightExecute` and before any
 * submit. Measured on the shipped route: an exit whose optional step exhausted
 * its transport-retry budget at the PREFLIGHT site rendered six
 * `state: "ROLLED_BACK", submitted: true` steps against ONE real submission —
 * the field G4 added to stop a never-submitted conversion reading as a swap
 * asserting five swaps that never happened.
 *
 * CORRECTION (PHASE3.1-FIXREVIEW4 I2): the sentence that justification used to
 * lean on — "a ROLLED_BACK row never reached a relay" — is FALSE, and the pair
 * (`ROLLED_BACK` + `submitted: true`) is a state the journal genuinely can mean.
 * A relay-FAILED submission is rolled back AND carries a `callsId`, and this
 * function correctly reads it as submitted. What `ROLLED_BACK` actually
 * guarantees is that the step MOVED NO MONEY — either it never submitted, or it
 * submitted and failed. The derivation below was right for the right reason
 * (`callsId`/`txHash` prove a relay answered); the sentence was wrong, and a
 * future author reading the old one would have had a licence to break this
 * field again.
 *
 * The discriminator is `callsId ?? txHash`, which is what
 * `src/lp/resolveUnknown.ts` and `journal.reconcile` already use for exactly
 * this question: `callsId` is written only once the RELAY HAS ANSWERED
 * (`markInProgress` after `executeViaSession` returns) and `txHash` only once a
 * receipt confirmed. Neither can exist without a submission.
 *
 * **Why the third state.** A row whose submit met the relay's 45 s silence is
 * `UNKNOWN` with no `callsId`: whether it reached a relay is the thing nobody
 * knows — that is what `UNKNOWN` MEANS — so answering `false` would assert a
 * fact in the same way `true` did. It answers `null` and lets the reader see
 * `state: "UNKNOWN"` beside it, which is the argument `unreadable` already
 * makes for a failed read. (The one UNKNOWN shape that IS provably unsubmitted
 * — G7's `beginWithSpend`→`markRolledBack` window on a bookkeeping row, which
 * `reconcile` parks as `UNKNOWN` — is not distinguished here: this view answers
 * from the row, and Phase 3.3's `resolveUnknown` is the surface that settles it
 * with evidence.)
 */
export function lpStepOutcome(row: JournalEntry | null): LpSequenceStepOutcome {
  if (row === null) {
    // No row under a RECORDED step's key: the `appendStep`→`beginWithSpend`
    // crash window. Provably unsubmitted, and the saga's join says so too.
    return { state: null, submitted: false, txHash: null, unreadable: false };
  }
  const reachedRelay =
    row.externalRef.callsId !== undefined || row.externalRef.txHash !== undefined;
  return {
    state: row.state,
    submitted: reachedRelay ? true : row.state === "UNKNOWN" ? null : false,
    txHash: row.externalRef.txHash ?? null,
    unreadable: false,
  };
}

/**
 * What the owner is shown about a sequence. The journal is still the AUTHORITY
 * on outcomes — `outcomes` is a map the caller fetched FROM it, keyed by
 * `journalIdempotencyKey`, and nothing here recomputes or infers a state.
 *
 * WHY THE STEPS CARRY STATE AT ALL (PHASE3.1-FIXREVIEW2 **G4**). This view used
 * to render `{index, kind, journalDecisionId}` and deliberately nothing else,
 * on the reasoning that outcomes live in the journal. That was defensible while
 * one plan position produced one step entry. PHASE3.1-FIXREVIEW F2 made the
 * optional step's transport retries COUNTABLE by persisting one
 * provably-unsubmitted row per attempt, so a single never-submitted conversion
 * now renders as
 * `[zap-out, sweep-token, sweep-token, sweep-token, sweep-token, sweep-token]`
 * — five bookkeeping rows and a skip, indistinguishable from five swaps that
 * happened. That is the FINDINGS (ae)/(al) failure — a surface that looks like
 * the system working — running in the other direction, and FINDINGS (an) is the
 * measured evidence that it bites: an operator read a SUCCESSFUL resolution as
 * "nothing happened" because the response buried the state change.
 *
 * So each entry now says what the journal says about it, and in particular
 * whether it SUBMITTED anything. A reader counts the entries of a kind to see
 * how many attempts were made, and reads `submitted` to see how many of them
 * reached a relay. Nothing is filtered out — a hidden attempt is the same
 * dishonesty in the other direction — and no state is invented: every value
 * here is either a journal row's own state, or an explicit `null`/`unreadable`
 * saying the journal had nothing to give.
 *
 * PHASE3.1-FIXREVIEW3 **H5**: `submitted` was originally read off `callsHash`,
 * which is written before every pre-submit refusal, so the field asserted five
 * submissions that never happened. It is {@link lpStepOutcome}'s tri-state now,
 * and the derivation lives in ONE place so the route cannot hold a different
 * rule from the tests.
 */
export function lpSequenceView(
  record: LpSequenceRecord,
  outcomes: ReadonlyMap<string, LpSequenceStepOutcome>,
): Record<string, unknown> {
  return {
    sequenceId: record.sequenceId,
    positionId: record.positionId,
    kind: record.kind,
    state: record.state,
    recoveryState: record.recoveryState,
    // Additive (2026-09-06): the durable stall latch, so the owner UI can show
    // WHY a sequence is parked without the worker log.
    stallCode: record.stallCode ?? null,
    stallCount: record.stallCount ?? 0,
    recenterEvidence: record.kind === "grid-recenter" ? record.recenterEvidence : null,
    // Additive, read-only projection of what the shift row already persists
    // (PHASE3.22 R8 targets, PHASE3.25 cause), so the page can list a cross
    // as a fill: `grid_cycles` is written by flips and recenters only, and a
    // shift's freed amounts are build state the finish must not read (A1).
    ...(record.kind === "grid-shift"
      ? {
          shiftCause: record.shiftCause,
          targetBuyRange: record.targetTickLower === null || record.targetTickUpper === null
            ? null
            : { tickLower: record.targetTickLower, tickUpper: record.targetTickUpper },
          targetSellRange: record.targetSellTickLower === null || record.targetSellTickUpper === null
            ? null
            : { tickLower: record.targetSellTickLower, tickUpper: record.targetSellTickUpper },
        }
      : {}),
    /**
     * PHASE3.1 Rev2 item 15. Why a COMPLETED sequence may still owe the owner
     * a sentence: an exit whose swap leg was skipped (the flag off, dust, a
     * price-impact refusal) is genuinely finished and genuinely left an ERC-20
     * in the wallet. Without this the owner reads `completed`, holds the
     * token, and has no in-product explanation.
     */
    note: record.note,
    ...(record.kind === "manual-exit"
      ? {
          // PHASE3.24 C2/C3: owner view exposes the persisted authority and
          // the confirmed material remainder, including an exact zero.
          inlineConvert: record.inlineConvert,
          inlineResidueBaseWei: record.inlineResidueBaseWei?.toString(10) ?? null,
        }
      : {}),
    steps: record.steps.map((step) => {
      const outcome =
        outcomes.get(step.journalIdempotencyKey) ?? LP_STEP_OUTCOME_UNREADABLE;
      return {
        index: step.index,
        kind: step.kind,
        journalDecisionId: step.journalDecisionId,
        state: outcome.state,
        submitted: outcome.submitted,
        txHash: outcome.txHash,
        unreadable: outcome.unreadable,
      };
    }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
