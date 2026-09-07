import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sanitizeMessage } from "../src/core/errors.js";
import { parseHireParams } from "../src/http/wire.js";
import { resolveHireEnabled, resolveHireGrantGasHeadroomWei } from "../src/ops/config.js";
import { LOCAL_ONLY_KINDS, MONEY_KINDS } from "../src/store/journal.js";

describe("hire config and enumerations", () => {
  it("is strict-off, requires passkeys in config, and pins encryption at production boot", () => {
    assert.equal(resolveHireEnabled({}), false);
    assert.equal(resolveHireEnabled({ HIRE_ENABLED: "false" }), false);
    assert.throws(() => resolveHireEnabled({ HIRE_ENABLED: "TRUE" }), /exactly "true" or "false"/u);
    assert.throws(() => resolveHireEnabled({ HIRE_ENABLED: "true" }), /PASSKEY_ENABLED/u);
    assert.equal(resolveHireEnabled({ HIRE_ENABLED: "true", PASSKEY_ENABLED: "true" }), true);
    const entrypoint = readFileSync(new URL("../src/index-server.ts", import.meta.url), "utf8");
    assert.match(entrypoint, /!agentStore\.keyEncryptionConfigured/u);
    assert.match(entrypoint, /EXECUTION_MASTER_KEY/u);
  });

  it("derives the default grant headroom and validates an override", () => {
    assert.equal(resolveHireGrantGasHeadroomWei({}, 10n), 30n);
    assert.equal(resolveHireGrantGasHeadroomWei({ HIRE_GRANT_GAS_HEADROOM_WEI: "42" }, 10n), 42n);
    assert.throws(() => resolveHireGrantGasHeadroomWei({ HIRE_GRANT_GAS_HEADROOM_WEI: "-1" }, 10n));
  });

  it("keeps hire journals local-only and out of the money namespace", () => {
    for (const kind of ["agentProvision", "agentProvisionCancel"] as const) {
      assert.equal(LOCAL_ONLY_KINDS.has(kind), true);
      assert.equal(MONEY_KINDS.has(kind), false);
    }
    const source = readFileSync(new URL("../src/auth/ownerAuth.ts", import.meta.url), "utf8");
    const actions = /const OWNER_ACTIONS[\s\S]*?\]\);/u.exec(source)?.[0] ?? "";
    const fields = /export const OWNER_ACTION_TYPES[\s\S]*?as const;/u.exec(source)?.[0] ?? "";
    assert.match(actions, /"provisionAgent"/u);
    assert.match(actions, /"cancelProvisioning"/u);
    assert.doesNotMatch(fields, /provisionAgent|cancelProvisioning/u);
  });
});

describe("strict hire wire and byte contracts", () => {
  const good = {
    walletAddress: "0x1111111111111111111111111111111111111111",
    token: "0x2222222222222222222222222222222222222222",
    capDayWei: "100",
    openNativeBudgetWei: "50",
    ttlSec: 3600,
    sizingPreset: "grid-v1",
  };
  it("accepts exactly the closed shape and rejects extras, loose decimals, ttl and presets", () => {
    assert.equal(parseHireParams(good).ok, true);
    for (const bad of [
      { ...good, extra: true },
      { ...good, capDayWei: "1e3" },
      { ...good, openNativeBudgetWei: 50 },
      { ...good, ttlSec: 3599 },
      { ...good, sizingPreset: "grid-v2" },
    ]) assert.equal(parseHireParams(bad).ok, false);
  });

  it("pins every reviewed hire refusal/remedy through the real sanitizer", () => {
    for (const text of [
      "This agent is still being hired. Finish the on-chain grant, or cancel the hire.",
      "the session key is live on chain; let the hire converge, then revoke it",
      "revoke the session on chain and hire again",
    ]) assert.equal(sanitizeMessage(text), text);
  });
});

describe("real Postgres text pins the hire CAS and idempotent migrations", () => {
  const source = readFileSync(new URL("../src/store/agents.ts", import.meta.url), "utf8");
  it("pins status, row version and grant digest in the real arm statement", () => {
    const statement = /\/\* agents\.armProvisioning \*\/[\s\S]*?returning id`/u.exec(source)?.[0] ?? "";
    assert.match(statement, /status = 'provisioning'/u);
    assert.match(statement, /row_version = \$3/u);
    assert.match(statement, /pending_grant->>'grantDigest' = \$4/u);
    assert.match(statement, /not \(pending_grant \? 'cancelRequestedAtSec'\)/u);
  });

  it("uses one real cancel statement with the complete CAS predicate", () => {
    const statement = /\/\* agents\.cancelProvisioning \*\/[\s\S]*?returning id, status = 'retired' as retired`/u.exec(source)?.[0] ?? "";
    assert.match(statement, /status = 'provisioning'/u);
    assert.match(statement, /row_version = \$3/u);
    assert.match(statement, /pending_grant->>'grantDigest' = \$4/u);
    assert.match(statement, /session_key_ciphertext = case/u);
  });

  it("uses add-column-if-not-exists for both new columns", () => {
    assert.match(source, /add column if not exists pending_grant jsonb/u);
    assert.match(source, /add column if not exists row_version integer not null default 1/u);
  });
});
