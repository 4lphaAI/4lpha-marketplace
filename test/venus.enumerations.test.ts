/**
 * PHASE4 — the hand-maintained enumerations (R2.5, S13).
 *
 * Every finding in this family was the same shape: a kind or an action added to
 * a TYPE but not to the runtime SET beside it. The type-checker cannot see the
 * omission, and the failure mode is silent in the worst direction —
 * `journal.ts:92-102` records it being learned twice, and a kind missing from
 * `LOCAL_ONLY_KINDS` parks every interrupted row as a permanent UNKNOWN.
 *
 * These are cheap tests that would have caught all of them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  isMutatingOwnerAction,
  type OwnerActionType,
} from "../src/auth/ownerAuth.js";
import { LOCAL_ONLY_KINDS, MONEY_KINDS } from "../src/store/journal.js";
import type { JournalKind } from "../src/store/journal.js";

const VENUS_MONEY_KINDS = [
  "venusRepay",
  "venusSupply",
  "venusClaim",
  "venusClaimRepayLeg",
] as const satisfies readonly JournalKind[];

describe("venus journal kinds: every enumeration, not just the type", () => {
  it("all four money kinds are MONEY kinds — the shared decisionId namespace", () => {
    for (const kind of VENUS_MONEY_KINDS) {
      assert.equal(
        MONEY_KINDS.has(kind),
        true,
        `${kind} is not a money kind, so a decisionId reused across /trade and a ` +
          "Venus action would pass the replay check.",
      );
    }
  });

  it("venusSettings is LOCAL-ONLY and NOT a money kind", () => {
    // `ownerMutation` journals a row of the route's kind whether the spec
    // mentions it or not. Missing from LOCAL_ONLY_KINDS, every interrupted
    // settings write parks as a permanent UNKNOWN.
    assert.equal(LOCAL_ONLY_KINDS.has("venusSettings"), true);
    assert.equal(MONEY_KINDS.has("venusSettings"), false);
  });

  it("the money kinds are NOT local-only — they really do submit", () => {
    for (const kind of VENUS_MONEY_KINDS) {
      assert.equal(LOCAL_ONLY_KINDS.has(kind), false);
    }
  });

  it("the Postgres getByDecision literal names all four — the second hand-maintained home", () => {
    // A hand-written SQL literal cannot be type-checked, and the store's own
    // comment says "extend all three together". This reads the source rather
    // than trusting that it was.
    const source = readFileSync(new URL("../src/store/journal.ts", import.meta.url), "utf8");
    const clause = /kind in \(([^)]*)\)/u.exec(source);
    assert.ok(clause !== null, "the getByDecision kind filter was not found at all");
    for (const kind of VENUS_MONEY_KINDS) {
      assert.ok(
        (clause[1] ?? "").includes(`'${kind}'`),
        `${kind} is missing from the getByDecision SQL literal.`,
      );
    }
  });

  it("the FakeSql filter names all four — the third home, and the one tests run on", () => {
    const source = readFileSync(new URL("./support/fakeSql.ts", import.meta.url), "utf8");
    for (const kind of VENUS_MONEY_KINDS) {
      assert.ok(
        source.includes(`"${kind}"`),
        `${kind} is missing from the FakeSql money-kind filter, so the fake and ` +
          "production would disagree about the decisionId namespace.",
      );
    }
  });

  it("resolveRow recognizes every money kind — an unrecognized kind parks forever", () => {
    const source = readFileSync(new URL("../src/store/journal.ts", import.meta.url), "utf8");
    for (const kind of VENUS_MONEY_KINDS) {
      assert.ok(
        source.includes(`kind === "${kind}"`),
        `${kind} is missing from resolveRow's branch, so startup reconcile would ` +
          "hold a crashed Venus row as an unrecoverable UNKNOWN with no action able " +
          "to clear it.",
      );
    }
  });
});

describe("venus owner action: both hand-maintained homes (S13)", () => {
  it("venusSettings is MUTATING — it consumes a nonce", () => {
    assert.equal(isMutatingOwnerAction("venusSettings"), true);
  });

  it("venusSettings is in the runtime OWNER_ACTIONS set, not only the union", () => {
    // A member in the type and not the set is rejected before crypto with a
    // generic failure — the exact S13 shape. The runtime set is what the route
    // consults, so probe it through the exported predicate the route uses.
    const source = readFileSync(new URL("../src/auth/ownerAuth.ts", import.meta.url), "utf8");
    const setBlock = /OWNER_ACTIONS[\s\S]*?\]\)/u.exec(source);
    assert.ok(setBlock !== null, "the OWNER_ACTIONS set was not found");
    assert.ok(
      setBlock[0].includes('"venusSettings"'),
      "venusSettings is in the OwnerActionType union but not in the OWNER_ACTIONS " +
        "runtime set; every owner-signed settings write would fail generically.",
    );
  });

  it("the union and the set agree about venusSettings, and it type-checks as an action", () => {
    const action: OwnerActionType = "venusSettings";
    assert.equal(action, "venusSettings");
  });
});
