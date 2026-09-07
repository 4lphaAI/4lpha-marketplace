/**
 * Secret-discipline guard for the 1b-core modules.
 *
 * None of these modules should ever touch a session key: authorization is about
 * signatures, nonces and liveness state, not fund-moving secrets. This test
 * asserts that at the source level — the modules do not import or reference the
 * session-key accessor, and do not log — so a future edit that reaches for a key
 * here fails loudly instead of silently widening the secret's blast radius.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const MODULES = [
  "src/auth/canonical.ts",
  "src/auth/ownerAuth.ts",
  "src/auth/executeDecision.ts",
  "src/store/nonces.ts",
  "src/killswitch/killswitch.ts",
  // Phase 2. The trade modules decide WHAT to submit; only the HTTP layer's
  // `withSessionKey` decides what signs it, and none of these may drift into
  // reaching for a key or logging one.
  "src/ops/abis.ts",
  "src/ops/venues.ts",
  "src/ops/pancake.ts",
  "src/ops/fourmeme.ts",
  "src/ops/fees.ts",
  "src/ops/policy.ts",
  "src/ops/config.ts",
  "src/rules/engine.ts",
  "src/rules/scanGate.ts",
] as const;

function read(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

describe("secret discipline (1b-core)", () => {
  for (const module of MODULES) {
    it(`${module} never references the session-key accessor`, () => {
      assert.doesNotMatch(read(module), /getAgentSessionKey/);
    });

    it(`${module} imports no private-key or session-key material`, () => {
      const source = read(module);
      assert.doesNotMatch(source, /privateKey/i);
      assert.doesNotMatch(source, /sessionKey/i);
      assert.doesNotMatch(source, /EXECUTION_MASTER_KEY/);
    });

    it(`${module} only logs a static backend-selection line, never a value`, () => {
      // Factories are allowed backend-selection logs; those are static strings.
      // Assert every console.* is console.log and none INTERPOLATES a value —
      // an interpolated log is where a secret could leak.
      const source = read(module);
      for (const call of source.match(/console\.\w+/g) ?? []) {
        assert.equal(call, "console.log");
      }
      // No template interpolation inside any console.log argument.
      assert.doesNotMatch(source, /console\.log\([^)]*\$\{/);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 1b-api                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The HTTP layer's rules are different, and looser in exactly one place: the
 * execute route MUST reach for a session key, because submitting is the whole
 * point. What is asserted instead is that it does so in ONE place, that the
 * value never reaches a log or a response, and that no other module in the layer
 * touches a key at all.
 */
const API_MODULES = [
  "src/http/wire.ts",
  "src/http/limits.ts",
  "src/clients/dataPlane.ts",
] as const;

/**
 * Strip comments before matching.
 *
 * These modules DOCUMENT the secret rules at length — `wire.ts` explains that no
 * view exposes what `getAgentSessionKey` returns — so a source-text match would
 * fire on the prose that describes the rule rather than on a violation of it.
 * What matters is the code.
 */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

describe("secret discipline (1b-api)", () => {
  for (const module of API_MODULES) {
    it(`${module} never references the session-key accessor`, () => {
      assert.doesNotMatch(code(module), /getAgentSessionKey/);
    });

    it(`${module} references no key material at all`, () => {
      const source = code(module);
      assert.doesNotMatch(source, /privateKey/i);
      assert.doesNotMatch(source, /sessionKey/i);
      assert.doesNotMatch(source, /EXECUTION_MASTER_KEY/);
    });

    it(`${module} does not log`, () => {
      assert.doesNotMatch(code(module), /console\./);
    });
  }

  it("src/server.ts reaches for a session key in exactly one place", () => {
    const source = code("src/server.ts");
    const references = source.match(/getAgentSessionKey/g) ?? [];
    assert.equal(
      references.length,
      1,
      "the session key must be fetched only inside withSessionKey",
    );
    // And that one place is the narrow helper, not a route handler.
    assert.match(
      source,
      /async function withSessionKey[\s\S]{0,600}getAgentSessionKey/,
    );
  });

  it("src/server.ts never interpolates a fetched key into a log line", () => {
    const source = read("src/server.ts");
    // `sessionKey` may appear only as the local const inside withSessionKey.
    for (const line of source.split("\n")) {
      if (!/console\./.test(line)) continue;
      assert.doesNotMatch(line, /sessionKey/i);
      assert.doesNotMatch(line, /execToken|operatorToken/);
    }
  });

  it("src/server.ts hard-codes bypassLocalPolicyCheck to false", () => {
    const source = read("src/server.ts");
    const occurrences = source.match(/bypassLocalPolicyCheck:\s*(\w+)/g) ?? [];
    // One per money route: /execute and /trade. The count is pinned so a THIRD
    // submit path cannot appear without this test noticing, and every
    // occurrence must be the literal `false` — never a variable, never a config
    // lookup, never a request field.
    assert.equal(occurrences.length, 2, "expected exactly the two money routes");
    for (const occurrence of occurrences) {
      assert.equal(occurrence, "bypassLocalPolicyCheck: false");
    }
  });

  it("src/server.ts wires no CORS handling", () => {
    // This service is private-network only. A CORS header, or Hono's cors
    // middleware, would be the first step toward a browser reaching it directly.
    // (The module header DISCUSSES CORS at length, hence matching on the API
    // surface rather than on the word.)
    const source = read("src/server.ts");
    assert.doesNotMatch(source, /access-control-allow/i);
    assert.doesNotMatch(source, /hono\/cors/);
    assert.doesNotMatch(source, /\bcors\s*\(/);
  });

  it("no source file contains a 32-byte private key literal", () => {
    for (const module of [...MODULES, ...API_MODULES, "src/server.ts", "src/index-server.ts"]) {
      const source = read(module);
      assert.doesNotMatch(
        source,
        /["'`]0x[0-9a-fA-F]{64}["'`]/,
        `${module} contains something shaped like a key literal`,
      );
    }
  });
});
