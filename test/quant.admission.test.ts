/**
 * Session parsing, the policy projection and the admission predicate
 * (QUANT-GRID W4, R2.1, R3.2, R5.4, BC15, BC33).
 *
 * The predicate is enforced INDEPENDENTLY of `validateSessionSpec`, and the
 * test that matters most is the one proving why: `validateSessionSpec` ACCEPTS
 * a target-only rule, which permits `transfer` on U, so it cannot substitute
 * for A4.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, toFunctionSelector, type Address, keccak256 } from "viem";

import { validateSessionSpec } from "../src/core/session.js";
import {
  ALTANA_SESSION_VERSION,
  assertQuantSessionAdmissible,
  parseSessionPlaintext,
  permissionsDigest,
  projectGrantedPermissions,
  runChainAdmissionChecks,
  specDigest,
  TOLERATED_ROUTER_SELECTORS,
} from "../src/quant/admission.js";
import { QUANT_STRATEGY_DEFAULTS, QUANT_U_56, QUANT_ROUTER_56, QUANT_WBNB_56 } from "../src/quant/config.js";
import { buildLadder, E18 } from "../src/quant/grid.js";
import type { GrantedPermissions } from "../src/quant/types.js";

const U = 10n ** 18n;
const PARAMS = QUANT_STRATEGY_DEFAULTS;
// Two days before the fixture's expiry: a 30-day term bounds the projection's
// maxSessionSeconds, so a "now" years earlier would fail validateSessionSpec
// for a reason that has nothing to do with what these tests assert.
const NOW = 1_800_000_000 - 2 * 86_400;

const admissible = JSON.parse(
  readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8"),
) as { session: Record<string, unknown> };

const serialized = readFileSync(
  new URL("./fixtures/quant/bnbagent-serialized-session.json", import.meta.url), "utf8",
);

function plaintextOf(session: unknown): string {
  return JSON.stringify(session);
}

const LADDER = (() => {
  const result = buildLadder({ allocationUWei: 30n * U, p0E18: 740n * E18, params: PARAMS });
  if (!result.ok) throw new Error("fixture ladder must build");
  return result.ladder;
})();

function admissionInput(overrides: {
  readonly session?: unknown;
  readonly wallet?: Address;
  readonly sessionExpiresAtMs?: number | null;
} = {}) {
  const parsed = parseSessionPlaintext(
    plaintextOf(overrides.session ?? admissible.session),
  );
  if (!parsed.ok) throw new Error(`fixture must parse: ${parsed.code}`);
  const projection = projectGrantedPermissions(parsed.session.permissions, {
    expiry: parsed.session.expiry,
    nowSeconds: NOW,
    termDays: 30,
    walletAddress: parsed.session.walletAddress,
  });
  return {
    parsed: parsed.session,
    projection,
    input: {
      session: parsed.session,
      spec: projection.ok ? projection.spec : { allowedCalls: [], spendCaps: [], expiresAt: 0 },
      router: QUANT_ROUTER_56,
      u: QUANT_U_56,
      wbnb: QUANT_WBNB_56,
      job: {
        tradingWalletAddress: overrides.wallet ?? parsed.session.walletAddress,
        sessionExpiresAtMs:
          overrides.sessionExpiresAtMs === undefined
            ? parsed.session.expiry * 1_000
            : overrides.sessionExpiresAtMs,
      },
      ladder: {
        levels: LADDER.levels,
        clipUWei: LADDER.clipUWei,
        buyPrice: LADDER.buyPrice,
        sellPrice: LADDER.sellPrice,
        midE18: 740n * E18,
      },
      params: PARAMS,
      nowSeconds: NOW,
    },
  };
}

describe("quant session plaintext", () => {
  it("parses the pinned @bnbagent/sdk serializeSession fixture", () => {
    const parsed = parseSessionPlaintext(serialized);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.session.version, ALTANA_SESSION_VERSION);
    // Bigints arrive as `{"$bigint":"<decimal>"}` — the replacer, pinned.
    assert.equal(parsed.session.permissions.spend[0]?.limit, 10n * U);
  });

  it("REFUSES an unknown session version rather than parsing best-effort", () => {
    const bumped = plaintextOf({ ...JSON.parse(serialized), version: 2 });
    const parsed = parseSessionPlaintext(bumped);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.code, "session-version-unsupported");
  });

  it("refuses a signer type it does not implement", () => {
    const swapped = plaintextOf({
      ...JSON.parse(serialized),
      signer: { type: "passkey", credentialId: "x" },
    });
    const parsed = parseSessionPlaintext(swapped);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.code, "session-signer-unsupported");
  });

  it("refuses an OMITTED calls or spend array — Altana reads both as unbounded", () => {
    for (const permissions of [{ spend: [] }, { calls: [] }, {}]) {
      const parsed = parseSessionPlaintext(
        plaintextOf({ ...JSON.parse(serialized), permissions }),
      );
      assert.equal(parsed.ok, false);
      if (parsed.ok) continue;
      assert.equal(parsed.code, "session-permissions-malformed");
    }
  });
});

describe("quant projection", () => {
  it("keeps human-readable SIGNATURES verbatim (C3)", () => {
    const { projection } = admissionInput();
    assert.equal(projection.ok, true);
    if (!projection.ok) return;
    const swap = projection.spec.allowedCalls.find(
      (rule) => rule.to?.toLowerCase() === QUANT_ROUTER_56.toLowerCase(),
    );
    assert.equal(swap?.selector, "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)");
  });

  it("projects a BARE 4-BYTE selector through the known-signature table", () => {
    const permissions: GrantedPermissions = {
      calls: [
        { to: QUANT_ROUTER_56, signature: toFunctionSelector("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)") },
        { to: QUANT_U_56, signature: toFunctionSelector("approve(address,uint256)") },
        { to: QUANT_WBNB_56, signature: toFunctionSelector("approve(address,uint256)") },
      ],
      spend: [
        { token: QUANT_U_56, limit: 40n * U, period: "day" },
        { token: QUANT_WBNB_56, limit: 2n * 10n ** 17n, period: "day" },
        { limit: 3n * 10n ** 15n, period: "day" },
      ],
    };
    const projection = projectGrantedPermissions(permissions, {
      expiry: NOW + 86_400, nowSeconds: NOW, termDays: 30,
      walletAddress: getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111"),
    });
    assert.equal(projection.ok, true);
  });

  it("REFUSES an unknown 4-byte selector rather than dropping the rule", () => {
    const permissions: GrantedPermissions = {
      calls: [{ to: QUANT_ROUTER_56, signature: "0xdeadbeef" }],
      spend: [{ token: QUANT_U_56, limit: 40n * U, period: "day" }],
    };
    const projection = projectGrantedPermissions(permissions, {
      expiry: NOW + 86_400, nowSeconds: NOW, termDays: 30,
      walletAddress: getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111"),
    });
    assert.equal(projection.ok, false);
    if (projection.ok) return;
    assert.equal(projection.code, "session-projection-invalid:unknown-selector");
  });

  it("REFUSES a bare-selector rule with no target", () => {
    const permissions: GrantedPermissions = {
      calls: [{ signature: "approve(address,uint256)" }],
      spend: [{ token: QUANT_U_56, limit: 40n * U, period: "day" }],
    };
    const projection = projectGrantedPermissions(permissions, {
      expiry: NOW + 86_400, nowSeconds: NOW, termDays: 30,
      walletAddress: getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111"),
    });
    assert.equal(projection.ok, false);
    if (projection.ok) return;
    assert.equal(projection.code, "session-projection-invalid:unbound-selector");
  });

  it("runs validateSessionSpec UNCHANGED — a duplicate cap is refused there", () => {
    const permissions: GrantedPermissions = {
      calls: [
        { to: QUANT_ROUTER_56, signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" },
        { to: QUANT_U_56, signature: "approve(address,uint256)" },
      ],
      spend: [
        { token: QUANT_U_56, limit: 40n * U, period: "day" },
        { token: QUANT_U_56, limit: 50n * U, period: "day" },
      ],
    };
    const projection = projectGrantedPermissions(permissions, {
      expiry: NOW + 86_400, nowSeconds: NOW, termDays: 30,
      walletAddress: getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111"),
    });
    assert.equal(projection.ok, false);
  });

  it("digests are stable under REORDERING and change on any value", () => {
    const { parsed } = admissionInput();
    const reordered: GrantedPermissions = {
      calls: [...parsed.permissions.calls].reverse(),
      spend: [...parsed.permissions.spend].reverse(),
    };
    assert.equal(permissionsDigest(parsed.permissions), permissionsDigest(reordered));
    const widened: GrantedPermissions = {
      calls: parsed.permissions.calls,
      spend: parsed.permissions.spend.map((cap, index) =>
        index === 0 ? { ...cap, limit: cap.limit + 1n } : cap),
    };
    assert.notEqual(permissionsDigest(parsed.permissions), permissionsDigest(widened));
  });

  it("spec digests differ when the projection differs", () => {
    const { projection } = admissionInput();
    assert.equal(projection.ok, true);
    if (!projection.ok) return;
    const other = { ...projection.spec, expiresAt: projection.spec.expiresAt + 1 };
    assert.notEqual(specDigest(projection.spec), specDigest(other));
  });
});

describe("quant admission (A1..A8)", () => {
  it("ADMITS the BC15 fixture", () => {
    const { input } = admissionInput();
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.code);
    if (!verdict.ok) return;
    // Lmin is the SMALLEST WBNB limit across every period row — the minute row
    // here, which a day-only meter read would have missed entirely.
    assert.equal(verdict.wbnbCapMinLimitWei, 2n * 10n ** 17n);
    assert.ok(verdict.residualThresholdWei > 0n);
  });

  it("REFUSES the serialization fixture — it is explicitly NOT an admission one", () => {
    const parsed = parseSessionPlaintext(serialized);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const verdict = assertQuantSessionAdmissible({
      session: parsed.session,
      spec: { allowedCalls: [], spendCaps: [], expiresAt: parsed.session.expiry },
      router: QUANT_ROUTER_56, u: QUANT_U_56, wbnb: QUANT_WBNB_56,
      job: {
        tradingWalletAddress: parsed.session.walletAddress,
        sessionExpiresAtMs: parsed.session.expiry * 1_000,
      },
      ladder: {
        levels: LADDER.levels, clipUWei: LADDER.clipUWei,
        buyPrice: LADDER.buyPrice, sellPrice: LADDER.sellPrice, midE18: 740n * E18,
      },
      params: PARAMS, nowSeconds: NOW,
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    // Its key does not derive from its signer, which A6 catches first.
    assert.equal(verdict.code, "session-key-mismatch");
  });

  it("refuses a MISSING grant, one code per missing piece", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0, "session-missing-grant:swap"],
      [1, "session-missing-grant:approve-u"],
      [2, "session-missing-grant:approve-wbnb"],
    ];
    for (const [index, code] of cases) {
      const session = structuredClone(admissible.session) as {
        permissions: { calls: unknown[] };
      };
      session.permissions.calls.splice(index, 1);
      const { input } = admissionInput({ session });
      const verdict = assertQuantSessionAdmissible(input);
      assert.equal(verdict.ok, false);
      if (verdict.ok) continue;
      assert.equal(verdict.code, code);
    }
  });

  it("refuses a TARGET-ONLY rule, which validateSessionSpec accepts (condition 7)", () => {
    const session = structuredClone(admissible.session) as {
      permissions: { calls: { to: string; signature?: string }[] };
    };
    delete session.permissions.calls[1]?.signature;
    // First: prove validateSessionSpec REALLY does accept it — the premise the
    // independent enforcement rests on.
    const projected = projectGrantedPermissions(
      (parseSessionPlaintext(plaintextOf(session)) as { session: { permissions: GrantedPermissions } })
        .session.permissions,
      {
        expiry: 1_800_000_000, nowSeconds: NOW, termDays: 30,
        walletAddress: getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111"),
      },
    );
    assert.equal(projected.ok, true, "validateSessionSpec accepts a target-only rule");
    if (projected.ok) {
      assert.doesNotThrow(() => validateSessionSpec(projected.spec, {
        nowSeconds: NOW, minSessionSeconds: 0,
      }));
    }
    // A4 does not.
    const { input } = admissionInput({ session });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.ok(verdict.code.startsWith("session-excess-grant:"), verdict.code);
    assert.ok(verdict.code.endsWith(":any"), verdict.code);
  });

  it("refuses ANY target outside {router, U, WBNB}", () => {
    const session = structuredClone(admissible.session) as {
      permissions: { calls: { to: string; signature: string }[] };
    };
    session.permissions.calls.push({
      to: "0x55d398326f99059fF775485246999027B3197955",
      signature: "approve(address,uint256)",
    });
    const { input } = admissionInput({ session });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.ok(verdict.code.startsWith("session-excess-grant:0x55d3"), verdict.code);
  });

  it("refuses `transfer` on U — this is what makes 'cannot transfer' a CHECK", () => {
    const session = structuredClone(admissible.session) as {
      permissions: { calls: { to: string; signature: string }[] };
    };
    session.permissions.calls.push({
      to: "0xcE24439F2D9C6a2289F741120FE202248B666666",
      signature: "transfer(address,uint256)",
    });
    const { input } = admissionInput({ session });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.ok(verdict.code.includes("session-excess-grant"), verdict.code);
  });

  it("tolerates exactly ONE router selector, and the set is one entry", () => {
    assert.equal(TOLERATED_ROUTER_SELECTORS.size, 1);
    const session = structuredClone(admissible.session) as {
      permissions: { calls: { to: string; signature: string }[] };
    };
    session.permissions.calls.push({
      to: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      signature: "swapExactETHForTokens(uint256,address[],address,uint256)",
    });
    const { input } = admissionInput({ session });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
  });

  it("refuses a wallet that is not the JOB's task wallet (A5)", () => {
    const { input } = admissionInput({
      wallet: getAddress("0x1111111111111111111111111111111111111111"),
    });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "session-wallet-mismatch");
  });

  it("refuses a publicKey that does not derive from the signer (A6)", () => {
    const session = structuredClone(admissible.session) as {
      publicKey: string; signer: { privateKey: string };
    };
    session.signer.privateKey = `0x${"55".repeat(32)}`;
    const { input } = admissionInput({ session });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "session-key-mismatch");
  });

  it("refuses an expiry beyond the job's own plus 300 s (A7)", () => {
    const { input } = admissionInput({ sessionExpiresAtMs: (1_800_000_000 - 3_600) * 1_000 });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "session-expiry-mismatch");
  });

  it("requires a NATIVE grant to exist at all (FINDINGS (h), BC33)", () => {
    const session = structuredClone(admissible.session) as {
      permissions: { spend: { token?: string }[] };
    };
    session.permissions.spend = session.permissions.spend.filter(
      (cap) => cap.token !== undefined,
    );
    const { input } = admissionInput({ session });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "session-missing-cap:native");
  });

  it("checks EVERY period row, not just the day one", () => {
    const session = structuredClone(admissible.session) as {
      permissions: { spend: { token?: string; period: string; limit: { $bigint: string } }[] };
    };
    // Shrink the MINUTE row only. A day-only check would pass this.
    for (const cap of session.permissions.spend) {
      if (cap.period === "minute") cap.limit = { $bigint: "1" };
    }
    const { input } = admissionInput({ session });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.ok(verdict.code.includes("wbnb:minute") || verdict.code.includes("chunk"), verdict.code);
  });

  it("refuses a U cap smaller than one clip", () => {
    const session = structuredClone(admissible.session) as {
      permissions: { spend: { token?: string; period: string; limit: { $bigint: string } }[] };
    };
    for (const cap of session.permissions.spend) {
      if (cap.token?.toLowerCase() === QUANT_U_56.toLowerCase()) {
        cap.limit = { $bigint: "1000000000000000000" };
      }
    }
    const { input } = admissionInput({ session });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "session-cap-too-small:u:day");
  });

  it("refuses the reviewer's 0.001 WBNB cap at level 1 (R5.4)", () => {
    const session = structuredClone(admissible.session) as {
      permissions: { spend: { token?: string; limit: { $bigint: string } }[] };
    };
    for (const cap of session.permissions.spend) {
      if (cap.token?.toLowerCase() === QUANT_WBNB_56.toLowerCase()) {
        cap.limit = { $bigint: "1000000000000000" };
      }
    }
    const { input } = admissionInput({ session });
    const verdict = assertQuantSessionAdmissible(input);
    assert.equal(verdict.ok, false, "a 0.001 WBNB cap must be refused BEFORE any buy");
  });
});

describe("quant chain admission (A8)", () => {
  const wallet = getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111");
  const keyHash = `0x${"ab".repeat(32)}` as const;
  const PUBLIC_KEY_FOR_KEYSTORE = `0x04${"cd".repeat(64)}` as const;

  it("asks the KeyStore for keccak256(publicKey), NOT the account key hash (live self-test 2026-09-10)", async () => {
    let asked: string | null = null;
    await runChainAdmissionChecks({
      reads: {
        isValidKey: async (_wallet, keyStoreId) => { asked = keyStoreId; return true; },
        accountKeys: async () => [{ keyHash, isSuperAdmin: false }],
        canExecute: async () => true,
      },
      wallet, keyHash, publicKey: PUBLIC_KEY_FOR_KEYSTORE, probes: [],
    });
    assert.equal(asked, keccak256(PUBLIC_KEY_FOR_KEYSTORE));
    assert.notEqual(asked, keyHash);
  });

  it("passes when the key is registered, not super-admin, and can execute", async () => {
    const verdict = await runChainAdmissionChecks({
      reads: {
        isValidKey: async () => true,
        accountKeys: async () => [{ keyHash, isSuperAdmin: false }],
        canExecute: async () => true,
      },
      wallet, keyHash, publicKey: PUBLIC_KEY_FOR_KEYSTORE, probes: [{ target: QUANT_ROUTER_56, data: "0x38ed1739" }],
    });
    assert.deepEqual(verdict, { ok: true });
  });

  it("refuses a SUPER-ADMIN key — its canExecute verdict is void (FINDINGS (o))", async () => {
    const verdict = await runChainAdmissionChecks({
      reads: {
        isValidKey: async () => true,
        accountKeys: async () => [{ keyHash, isSuperAdmin: true }],
        canExecute: async () => true,
      },
      wallet, keyHash, publicKey: PUBLIC_KEY_FOR_KEYSTORE, probes: [],
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "session-chain-refused:super-admin");
    assert.equal(verdict.unreadable, false);
  });

  it("an UNREADABLE chain is a HOLD, never a refusal", async () => {
    const verdict = await runChainAdmissionChecks({
      reads: {
        isValidKey: async () => { throw new Error("rpc down"); },
        accountKeys: async () => [],
        canExecute: async () => true,
      },
      wallet, keyHash, publicKey: PUBLIC_KEY_FOR_KEYSTORE, probes: [],
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "session-chain-unreadable");
    assert.equal(verdict.unreadable, true);
  });

  it("refuses a key the KeyStore does not know", async () => {
    const verdict = await runChainAdmissionChecks({
      reads: {
        isValidKey: async () => false,
        accountKeys: async () => [{ keyHash, isSuperAdmin: false }],
        canExecute: async () => true,
      },
      wallet, keyHash, publicKey: PUBLIC_KEY_FOR_KEYSTORE, probes: [],
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "session-chain-refused:keystore");
  });

  it("refuses when the account declines the REAL calldata", async () => {
    const verdict = await runChainAdmissionChecks({
      reads: {
        isValidKey: async () => true,
        accountKeys: async () => [{ keyHash, isSuperAdmin: false }],
        canExecute: async () => false,
      },
      wallet, keyHash, publicKey: PUBLIC_KEY_FOR_KEYSTORE, probes: [{ target: QUANT_U_56, data: "0x095ea7b3" }],
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.ok(verdict.code.startsWith("session-chain-refused:0xce24"), verdict.code);
  });
});
