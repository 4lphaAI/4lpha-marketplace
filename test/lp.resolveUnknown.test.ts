/**
 * Unit-level cover for PHASE3.3's supporting pieces: the owner-action
 * taxonomy (Rev2 item 6), the decision-id parser the route resolves a sequence
 * through, the boot config (Rev2 item 14) and the protection-status ordering
 * (Rev2 item 18).
 *
 * The route-level matrix lives in `test/audit.resolveUnknown.test.ts`; these
 * are the rules that must hold whether or not a route ever calls them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { isMutatingOwnerAction } from "../src/auth/ownerAuth.js";
import { lpSequenceIdOfStepDecision, lpStepDecisionId } from "../src/store/lpSequences.js";
import {
  DEFAULT_RESOLVE_DISCRIMINATING_MULTIPLE_BPS,
  DEFAULT_RESOLVE_MIN_AGE_SEC,
  resolveLpRuntimeConfig,
} from "../src/ops/config.js";
import {
  LP_ARMED_REASON,
  LP_BASIS_ZERO_HOLD_REASON,
  LP_NO_PROTECT_CONFIGURED_REASON,
  LP_STUCK_PROTECT_REASON,
  DEFAULT_LP_SETTINGS,
  lpBlockingSequenceCanProgress,
  lpProtectionStatus,
} from "../src/lp/triggers.js";
import { parseLpResolveParams } from "../src/http/lpWire.js";
import { resumedResolution } from "../src/lp/resolveUnknown.js";
import type { JournalEntry } from "../src/store/journal.js";

/* -------------------------------------------------------------------------- */
/* The owner action (Rev2 item 6)                                             */
/* -------------------------------------------------------------------------- */

describe("resolveUnknown owner action: taxonomy", () => {
  it("is MUTATING, so the nonce is consumed and a captured signature is single-use", () => {
    // `isMutatingOwnerAction` answers by EXCLUSION (`action !== "read"`), which
    // is why adding the member needed no change here — and why pinning it does.
    assert.equal(isMutatingOwnerAction("resolveUnknown"), true);
  });
});

/* -------------------------------------------------------------------------- */
/* The params (Rev2 items 1/8)                                                */
/* -------------------------------------------------------------------------- */

describe("parseLpResolveParams", () => {
  it("accepts a decision id and an observed block as a decimal string", () => {
    const parsed = parseLpResolveParams({
      decisionId: "lp:seq-1:2",
      observedBlock: "116391700",
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok ? parsed.value : null, {
      decisionId: "lp:seq-1:2",
      observedBlock: 116_391_700n,
    });
  });

  it("REFUSES a txHash — there is no landed direction in v1 (Rev2 item 1)", () => {
    const parsed = parseLpResolveParams({
      decisionId: "lp:seq-1:2",
      observedBlock: "1",
      txHash: `0x${"aa".repeat(32)}`,
    });
    assert.equal(parsed.ok, false);
  });

  it("refuses a missing or malformed observedBlock", () => {
    assert.equal(parseLpResolveParams({ decisionId: "lp:s:0" }).ok, false);
    assert.equal(
      parseLpResolveParams({ decisionId: "lp:s:0", observedBlock: -1 }).ok,
      false,
    );
  });

  it("refuses an empty decision id", () => {
    assert.equal(parseLpResolveParams({ decisionId: "", observedBlock: "1" }).ok, false);
  });
});

/* -------------------------------------------------------------------------- */
/* The decision-id parser                                                     */
/* -------------------------------------------------------------------------- */

describe("lpSequenceIdOfStepDecision", () => {
  it("round-trips lpStepDecisionId", () => {
    const id = lpStepDecisionId("b03a05a4-f19a-4a84-abf8-358401dbd613", 2);
    assert.equal(
      lpSequenceIdOfStepDecision(id),
      "b03a05a4-f19a-4a84-abf8-358401dbd613",
    );
  });

  it("answers null for anything that is not an LP step decision id", () => {
    // A trade/execute decision id shares the namespace and must NOT resolve to
    // a sequence — that is what keeps `no_verifier_for_kind` honest.
    assert.equal(lpSequenceIdOfStepDecision("d-trade-1"), null);
    assert.equal(lpSequenceIdOfStepDecision("lp:seq"), null);
    assert.equal(lpSequenceIdOfStepDecision("lp::0"), null);
    assert.equal(lpSequenceIdOfStepDecision("lp:seq:x"), null);
    assert.equal(lpSequenceIdOfStepDecision("lp:seq:0:1"), null);
    assert.equal(lpSequenceIdOfStepDecision("xp:seq:0"), null);
  });
});

/* -------------------------------------------------------------------------- */
/* Boot config (Rev2 item 14)                                                 */
/* -------------------------------------------------------------------------- */

describe("resolveLpRuntimeConfig: RESOLVE_MIN_AGE_SEC", () => {
  it("defaults to 1800 seconds with the discriminating multiple at 1.2x", () => {
    const config = resolveLpRuntimeConfig({});
    assert.equal(config.resolveMinAgeSec, DEFAULT_RESOLVE_MIN_AGE_SEC);
    assert.equal(config.resolveMinAgeSec, 1_800);
    assert.equal(
      config.resolveDiscriminatingMultipleBps,
      DEFAULT_RESOLVE_DISCRIMINATING_MULTIPLE_BPS,
    );
  });

  it("accepts a value inside [900, 86400]", () => {
    assert.equal(resolveLpRuntimeConfig({ RESOLVE_MIN_AGE_SEC: "900" }).resolveMinAgeSec, 900);
    assert.equal(
      resolveLpRuntimeConfig({ RESOLVE_MIN_AGE_SEC: "86400" }).resolveMinAgeSec,
      86_400,
    );
  });

  it("FAILS THE BOOT below the floor, above the ceiling, or on a typo — never a request", () => {
    assert.throws(() => resolveLpRuntimeConfig({ RESOLVE_MIN_AGE_SEC: "899" }), /between 900/u);
    assert.throws(() => resolveLpRuntimeConfig({ RESOLVE_MIN_AGE_SEC: "86401" }), /and 86400/u);
    assert.throws(() => resolveLpRuntimeConfig({ RESOLVE_MIN_AGE_SEC: "half an hour" }));
  });

  it("refuses a discriminating multiple below 1.00x — a leg cannot be closer than exact", () => {
    assert.throws(
      () => resolveLpRuntimeConfig({ RESOLVE_DISCRIMINATING_MULTIPLE_BPS: "9999" }),
      /between 10000/u,
    );
    assert.equal(
      resolveLpRuntimeConfig({ RESOLVE_DISCRIMINATING_MULTIPLE_BPS: "10000" })
        .resolveDiscriminatingMultipleBps,
      10_000,
    );
  });

  it("PHASE3.24 R3.6: conversion compatibility is default-empty and boot-strict", () => {
    assert.equal(resolveLpRuntimeConfig({}).conversionCompatibleTokens.size, 0);
    assert.equal(
      resolveLpRuntimeConfig({ LP_CONVERSION_COMPATIBLE_TOKENS_JSON: "[]" })
        .conversionCompatibleTokens.size,
      0,
    );
    const address = "0x1111111111111111111111111111111111111111";
    const configured = resolveLpRuntimeConfig({
      LP_CONVERSION_COMPATIBLE_TOKENS_JSON: JSON.stringify([address]),
    });
    assert.deepEqual([...configured.conversionCompatibleTokens], [getAddress(address)]);

    for (const raw of [
      "not json",
      "{}",
      "[1]",
      '["nope"]',
      '["0x0000000000000000000000000000000000000000"]',
      JSON.stringify([address, address.toUpperCase().replace("0X", "0x")]),
    ]) {
      assert.throws(() => resolveLpRuntimeConfig({
        LP_CONVERSION_COMPATIBLE_TOKENS_JSON: raw,
      }));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Re-entry detection (PHASE3.3-AUDIT A1)                                     */
/* -------------------------------------------------------------------------- */

describe("resumedResolution", () => {
  function row(overrides: Partial<JournalEntry>): JournalEntry {
    return {
      idempotencyKey: "k1",
      agentId: "agent-1",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      kind: "lp",
      decisionId: "lp:seq-1:2",
      state: "UNKNOWN",
      externalRef: {},
      nativeSpendWei: 0n,
      begunAtBlock: null,
      finalCallsFingerprint: null,
      finalCallsFingerprintHash: null,
      preparedIntentIdentity: null,
      preparedIntentIdentityHash: null,
      preparedBindingVersion: 0,
      billingCallsIdVersion: 0,
      landingResolutionId: null,
      landingResolutionKeyHash: null,
      landingResolutionOutcome: null,
      landingResolutionEvidenceHash: null,
      landingResolutionTerminalAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    };
  }
  const resolution = {
    action: "resolveUnknown",
    at: 1,
    ownerAddress: "0x0000000000000000000000000000000000000001",
    observedBlock: "1",
    serverBlock: null,
    checks: [],
    legs: [],
    logAbsence: { checked: false, detail: "n/a" },
    disposition: "abandoned",
  } as const;

  it("is TRUE only for a ROLLED_BACK row that carries this action's own evidence", () => {
    assert.equal(
      resumedResolution(row({ state: "ROLLED_BACK", externalRef: { resolution } })),
      true,
    );
  });

  it("PHASE3.9a: is TRUE for a COMMITTED row carrying it too — an interrupted ADVANCE", () => {
    // The predicate recognised only ROLLED_BACK, which was right while
    // abandonment was the only disposition. With `advance` writing COMMITTED,
    // the same rule would call an interrupted advance un-resumed and make the
    // action un-re-runnable — verbatim the defect PHASE3.8-AUDIT A1 found one
    // phase earlier, on this same property.
    assert.equal(
      resumedResolution(row({ state: "COMMITTED", externalRef: { resolution } })),
      true,
    );
  });

  it("is FALSE for an UNKNOWN row, and for terminal rows with no evidence of THIS action", () => {
    assert.equal(resumedResolution(row({})), false);
    assert.equal(resumedResolution(row({ state: "ROLLED_BACK" })), false);
    // The discriminator is the `resolution` key, which only this action writes:
    // an ordinary COMMITTED row — one a receipt committed — must never look
    // like a resumed advance.
    assert.equal(resumedResolution(row({ state: "COMMITTED" })), false);
    assert.equal(
      resumedResolution(row({ state: "COMMITTED", externalRef: { txHash: "0xabc" } })),
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Protection status (Rev2 item 18)                                           */
/* -------------------------------------------------------------------------- */

describe("lpProtectionStatus: blockedBySequence", () => {
  const base = {
    settings: { ...DEFAULT_LP_SETTINGS, stopLossPct: 5 },
    settingsReadable: true,
    digestVerified: true,
    basisWei: 3_000_000_000_000_000n,
    hasTokenId: true,
    observation: null,
    nowMs: 1_000,
    intervalMs: 60_000,
  } as const;

  it("reports armed: false naming the blocking kind", () => {
    const status = lpProtectionStatus({
      ...base,
      blockingSequence: { sequenceId: "seq-1", kind: "harvest" },
    });
    assert.equal(status.armed, false);
    assert.match(status.reason, /non-terminal harvest sequence/u);
    assert.deepEqual(status.blockedBySequence, {
      sequenceId: "seq-1",
      kind: "harvest",
    });
  });

  it("does not disarm on a PROTECT sequence — that IS the protect running", () => {
    const status = lpProtectionStatus({
      ...base,
      blockingSequence: { sequenceId: "seq-1", kind: "protect" },
    });
    assert.equal(status.armed, true);
    assert.equal(status.reason, LP_ARMED_REASON);
    assert.equal(status.blockedBySequence, null);
  });

  it("is absent by default, so the worker's call sites are unchanged", () => {
    const status = lpProtectionStatus(base);
    assert.equal(status.armed, true);
    assert.equal(status.blockedBySequence, null);
  });

  /* --- PHASE3.3-AUDIT A3 ------------------------------------------------- */

  it("DOES disarm on a protect that cannot advance — its current step row is UNKNOWN", () => {
    const status = lpProtectionStatus({
      ...base,
      blockingSequence: {
        sequenceId: "seq-1",
        kind: "protect",
        state: "active",
        currentStepUnknown: true,
      },
    });
    assert.equal(status.armed, false);
    assert.equal(status.reason, LP_STUCK_PROTECT_REASON);
    assert.equal(status.blockedBySequence?.kind, "protect");
  });

  it("does NOT disarm on a held protect whose rows are settled — held → active is the resume", () => {
    // The discriminator is the STEP ROW, not the state. A held sequence with
    // settled rows advances on the next cycle (PHASE3.1's optional-step retry
    // budget spends exactly that), so disarming on `held` would be a fresh lie
    // in the other direction.
    const status = lpProtectionStatus({
      ...base,
      blockingSequence: {
        sequenceId: "seq-1",
        kind: "protect",
        state: "held",
        currentStepUnknown: false,
      },
    });
    assert.equal(status.armed, true);
    assert.equal(status.blockedBySequence, null);
  });

  it("keeps the kind rule for every other kind, stuck or not", () => {
    for (const currentStepUnknown of [true, false]) {
      const status = lpProtectionStatus({
        ...base,
        blockingSequence: {
          sequenceId: "seq-1",
          kind: "harvest",
          state: "held",
          currentStepUnknown,
        },
      });
      assert.equal(status.armed, false);
      assert.match(status.reason, /non-terminal harvest sequence/u);
    }
  });

  it("lpBlockingSequenceCanProgress is the one definition of the rule", () => {
    assert.equal(
      lpBlockingSequenceCanProgress({ sequenceId: "s", kind: "protect" }),
      true,
    );
    assert.equal(
      lpBlockingSequenceCanProgress({
        sequenceId: "s",
        kind: "protect",
        currentStepUnknown: false,
      }),
      true,
    );
    assert.equal(
      lpBlockingSequenceCanProgress({
        sequenceId: "s",
        kind: "protect",
        currentStepUnknown: true,
      }),
      false,
    );
  });

  it("comes LAST: a zero basis or an unconfigured stop is reported ahead of it", () => {
    const zeroBasis = lpProtectionStatus({
      ...base,
      basisWei: 0n,
      blockingSequence: { sequenceId: "seq-1", kind: "harvest" },
    });
    assert.equal(zeroBasis.armed, false);
    assert.equal(zeroBasis.reason, LP_BASIS_ZERO_HOLD_REASON);

    const noStop = lpProtectionStatus({
      ...base,
      settings: { ...DEFAULT_LP_SETTINGS, stopLossPct: 0, takeProfitPct: 0 },
      blockingSequence: { sequenceId: "seq-1", kind: "rotate" },
    });
    assert.equal(noStop.armed, false);
    assert.equal(noStop.reason, LP_NO_PROTECT_CONFIGURED_REASON);
  });
});
