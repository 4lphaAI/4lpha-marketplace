/**
 * Boot-time resolution of the passkey owner-auth configuration.
 *
 * Every rule here exists because a misconfigured passkey deployment is
 * INDISTINGUISHABLE FROM AN ATTACK at request time: a typo'd variable name, a
 * missing manifest entry, or an origin written with a trailing slash produces a
 * server that looks healthy, passes `/health`, serves every secp256k1 owner
 * correctly, and answers every passkey owner with the same generic failure a
 * forgery gets. So the resolver refuses the BOOT and names the variable, and the
 * rules are tested here rather than only by starting a process.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_PASSKEY_ORIGINS,
  resolvePasskeyConfig,
} from "../src/ops/config.js";

const ON = { PASSKEY_ENABLED: "true" } as const;

function resolve(env: Record<string, string | undefined>) {
  return resolvePasskeyConfig(env);
}

describe("resolvePasskeyConfig — the tri-state", () => {
  it("defaults to DISABLED, so a deployment that never heard of passkeys is 1b", () => {
    assert.deepEqual(resolve({}), { enabled: false });
  });

  it("treats an explicit false as disabled", () => {
    assert.deepEqual(resolve({ PASSKEY_ENABLED: "false" }), { enabled: false });
  });

  it("REFUSES a truthy-looking typo instead of silently disabling", () => {
    // The one place this deliberately differs from `EXECUTE_RAW_ENABLED`'s
    // "anything but true is false": there, a typo closes a route an operator
    // notices immediately. Here it would silently break one class of owner.
    for (const raw of ["1", "TRUE", "yes", "on", "True"]) {
      assert.throws(
        () => resolve({ PASSKEY_ENABLED: raw }),
        /PASSKEY_ENABLED must be exactly/,
        `PASSKEY_ENABLED=${JSON.stringify(raw)}`,
      );
    }
    // Whitespace-only is UNSET, like every other variable this resolver reads.
    assert.deepEqual(resolve({ PASSKEY_ENABLED: "   " }), { enabled: false });
  });

  it("resolves a complete configuration", () => {
    const config = resolve({
      ...ON,
      PASSKEY_RP_ID: "4lpha.app",
      PASSKEY_ORIGINS: "https://4lpha.app, https://www.4lpha.app",
    });
    assert.deepEqual(config, {
      enabled: true,
      rpId: "4lpha.app",
      origins: ["https://4lpha.app", "https://www.4lpha.app"],
      uvRequired: true,
    });
  });
});

describe("resolvePasskeyConfig — the RP ID", () => {
  it("is required when enabled", () => {
    assert.throws(
      () => resolve({ ...ON, PASSKEY_ORIGINS: "https://4lpha.app" }),
      /PASSKEY_RP_ID is required/,
    );
  });

  it("must be a bare registrable domain", () => {
    for (const rpId of [
      "https://4lpha.app",
      "4lpha.app:443",
      "4lpha.app/",
      ".4lpha.app",
      "4lpha.app.",
      "4lpha .app",
    ]) {
      assert.throws(
        () =>
          resolve({ ...ON, PASSKEY_RP_ID: rpId, PASSKEY_ORIGINS: "https://4lpha.app" }),
        /bare registrable domain/,
        rpId,
      );
    }
  });

  it("is lowercased, matching what a browser hashes", () => {
    const config = resolve({
      ...ON,
      PASSKEY_RP_ID: "4Lpha.App",
      PASSKEY_ORIGINS: "https://4lpha.app",
    });
    assert.equal(config.enabled && config.rpId, "4lpha.app");
  });

  it("must be a suffix of every origin's host", () => {
    // A combination that can never authenticate anyone must not wait until
    // request time to say so.
    assert.throws(
      () =>
        resolve({
          ...ON,
          PASSKEY_RP_ID: "4lpha.app",
          PASSKEY_ORIGINS: "https://4lpha.app,https://other.example",
        }),
      /PASSKEY_RP_ID "4lpha\.app" is not a suffix of/,
    );
    // A lookalike is not a suffix either: `evil-4lpha.app` does not end in
    // `.4lpha.app`.
    assert.throws(
      () =>
        resolve({
          ...ON,
          PASSKEY_RP_ID: "4lpha.app",
          PASSKEY_ORIGINS: "https://evil-4lpha.app",
        }),
      /is not a suffix of/,
    );
  });

  it("accepts a subdomain origin under the same RP ID", () => {
    const config = resolve({
      ...ON,
      PASSKEY_RP_ID: "4lpha.app",
      PASSKEY_ORIGINS: "https://app.staging.4lpha.app",
    });
    assert.equal(config.enabled, true);
  });
});

describe("resolvePasskeyConfig — the origin allowlist", () => {
  it("is required when enabled", () => {
    assert.throws(
      () => resolve({ ...ON, PASSKEY_RP_ID: "4lpha.app" }),
      /PASSKEY_ORIGINS is required/,
    );
    assert.throws(
      () => resolve({ ...ON, PASSKEY_RP_ID: "4lpha.app", PASSKEY_ORIGINS: " , " }),
      /PASSKEY_ORIGINS is required/,
    );
  });

  it("refuses anything that is not a SERIALIZED origin", () => {
    // The verifier compares `clientDataJSON.origin` exactly, so the operator has
    // to write what the browser writes. A trailing slash is the classic one and
    // would otherwise refuse every request with no explanation anywhere.
    for (const origin of [
      "https://4lpha.app/",
      "https://4lpha.app/app",
      "https://4lpha.app?x=1",
      "https://user:pw@4lpha.app",
      "https://4lpha.app:443",
      "4lpha.app",
    ]) {
      assert.throws(
        () => resolve({ ...ON, PASSKEY_RP_ID: "4lpha.app", PASSKEY_ORIGINS: origin }),
        /is not a serialized origin|is not a valid URL/,
        origin,
      );
    }
  });

  it("refuses a wildcard rather than fail-closed silently", () => {
    for (const origin of ["*", "https://*.4lpha.app"]) {
      assert.throws(
        () => resolve({ ...ON, PASSKEY_RP_ID: "4lpha.app", PASSKEY_ORIGINS: origin }),
        /must not contain a wildcard/,
        origin,
      );
    }
  });

  it(`accepts at most ${MAX_PASSKEY_ORIGINS} entries`, () => {
    const four = [
      "https://4lpha.app",
      "https://www.4lpha.app",
      "https://staging.4lpha.app",
      "https://dev.4lpha.app",
    ];
    assert.equal(
      resolve({
        ...ON,
        PASSKEY_RP_ID: "4lpha.app",
        PASSKEY_ORIGINS: four.join(","),
      }).enabled,
      true,
    );
    assert.throws(
      () =>
        resolve({
          ...ON,
          PASSKEY_RP_ID: "4lpha.app",
          PASSKEY_ORIGINS: [...four, "https://extra.4lpha.app"].join(","),
        }),
      /at most 4 entries/,
    );
  });

  it("requires https, with loopback the only exception and only behind the flag", () => {
    const base = { ...ON, PASSKEY_RP_ID: "localhost" };
    assert.throws(
      () => resolve({ ...base, PASSKEY_ORIGINS: "http://localhost:5173" }),
      /must be https/,
      "loopback needs the explicit flag",
    );
    assert.equal(
      resolve({
        ...base,
        PASSKEY_ORIGINS: "http://localhost:5173",
        PASSKEY_ALLOW_INSECURE_ORIGINS: "true",
      }).enabled,
      true,
    );
    assert.equal(
      resolve({
        ...ON,
        PASSKEY_RP_ID: "127.0.0.1",
        PASSKEY_ORIGINS: "http://127.0.0.1:8080",
        PASSKEY_ALLOW_INSECURE_ORIGINS: "true",
      }).enabled,
      true,
    );
    // An EXPLICIT port is part of the rule: a bare `http://localhost` is not a
    // dev server, it is a default-port origin nobody meant to allow.
    assert.throws(
      () =>
        resolve({
          ...base,
          PASSKEY_ORIGINS: "http://localhost",
          PASSKEY_ALLOW_INSECURE_ORIGINS: "true",
        }),
      /must be https/,
    );
    // The flag does NOT open plaintext to the internet.
    assert.throws(
      () =>
        resolve({
          ...ON,
          PASSKEY_RP_ID: "4lpha.app",
          PASSKEY_ORIGINS: "http://4lpha.app",
          PASSKEY_ALLOW_INSECURE_ORIGINS: "true",
        }),
      /must be https/,
    );
  });
});

describe("resolvePasskeyConfig — user verification", () => {
  const base = {
    ...ON,
    PASSKEY_RP_ID: "4lpha.app",
    PASSKEY_ORIGINS: "https://4lpha.app",
  };

  it("defaults to REQUIRED — this is a custody surface, not a login form", () => {
    const config = resolve(base);
    assert.equal(config.enabled && config.uvRequired, true);
  });

  it("can be switched off explicitly", () => {
    const config = resolve({ ...base, PASSKEY_UV_REQUIRED: "false" });
    assert.equal(config.enabled && config.uvRequired, false);
  });

  it("refuses a typo rather than quietly downgrading custody", () => {
    assert.throws(
      () => resolve({ ...base, PASSKEY_UV_REQUIRED: "no" }),
      /PASSKEY_UV_REQUIRED must be exactly/,
    );
  });
});
