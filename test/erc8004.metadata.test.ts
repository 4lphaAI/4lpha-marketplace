import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { metadataUri, metadataUriFor, metadataUriV2, metadataUriV3 } from "../src/identity/metadata.js";
import {
  INVALID_IDENTITY, REGISTRY, decodeIdentity, identityOwnerView, isObject,
  newIdentity, validIdentity, type Erc8004IdentitySummary, type IdentityCategory,
} from "../src/identity/types.js";

const REF = "00000000-0000-4000-8000-000000000001";
/**
 * v1 and v2 services are FROZEN; v3 adds the callable MCP face.
 *
 * `validateLedger` re-derives every stored job's URIs from these builders and
 * compares them byte for byte on every ledger read, so editing an existing
 * version retroactively invalidates every job minted from it and takes the
 * identity machine down — which is exactly what happened on 2026-09-06. New
 * services belong in a NEW version.
 */
const LEGACY_SERVICES = [
  { endpoint: "https://4lpha.tech", name: "web" },
  { endpoint: "https://x.com/4lpha_agent", name: "X" },
];
const V3_SERVICES = [{ endpoint: "https://4lpha.tech/mcp", name: "MCP" }, ...LEGACY_SERVICES];
const HASH1 = `0x${"1".repeat(64)}` as Hex;
const HASH2 = `0x${"2".repeat(64)}` as Hex;
const MAX_ID = ((1n << 256n) - 1n).toString();

function record(uri: string): Record<string, unknown> {
  assert.ok(uri.startsWith("data:application/json;base64,"));
  const value: unknown = JSON.parse(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").toString("utf8"));
  assert.ok(isObject(value));
  return value;
}

function registered(): Erc8004IdentitySummary {
  return { version: 1, publicRef: REF, revision: 3, category: "grid", status: "registered",
    agentId: MAX_ID, registrationTxHash: HASH1, uriUpdateTxHash: HASH2, errorCode: null };
}

describe("ERC-8004 public identity metadata", () => {
  it("uses the per-owner category display form and corrected English descriptions", () => {
    const expected: Readonly<Record<string, [string, string]>> = {
      grid: ["Grid Agent 1 by 4LPHA", "Automated grid market making that buys low and sells high as market prices move using PancakeSwap V3 on BNB Chain."],
      trading: ["Trading Agent 1 by 4LPHA", "Screens eligible markets, sizes entries, and automatically manages buys and exits using Four.Meme, Flap.sh, and PancakeSwap V3 on BNB Chain."],
      lp: ["LP Agent 1 by 4LPHA", "Routes liquidity to the best APR or fee opportunities with auto-rebalancing, compounding, and risk exits using PancakeSwap V3 on BNB Chain."],
    };
    for (const category of ["grid", "trading", "lp"] as const) {
      const value = record(metadataUriV2(category, 1, REF));
      assert.deepEqual([value.name, value.description], expected[category]);
      assert.equal(value.image, "https://4lpha.tech/4lpha_logo_180.png");
      assert.deepEqual(value.services, LEGACY_SERVICES);
    }
  });
  for (const category of ["grid", "trading", "lp"] as const) {
    it(`${category}: publishes only the fixed public projection and required project links`, () => {
      const uri = metadataUri(category, REF);
      const value = record(uri);
      assert.deepEqual(Object.keys(value), ["description", "image", "name", "registrations", "services", "socials", "type", "website", "x402Support", "x4lpha"]);
      assert.equal(value.website, "https://4lpha.tech");
      assert.equal(value.image, "https://4lpha.tech/4lpha_logo_180.png");
      assert.deepEqual(value.socials, { x: "https://x.com/4lpha_agent" });
      assert.deepEqual(value.services, LEGACY_SERVICES);
      assert.deepEqual(value.x4lpha, { category, identityCustody: "platform-minter", instanceRef: REF });
      assert.deepEqual(value.registrations, []);
      assert.equal(value.x402Support, false);
      assert.equal(value.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
      assert.equal(uri, metadataUri(category, REF));
      assert.ok(Buffer.byteLength(uri) <= 16 * 1024);
      // Any newly added field needs an explicit public-data decision. This
      // assertion catches accidental promotion of the full private agent row.
      assert.doesNotMatch(JSON.stringify(value), /ownerAddress|walletAddress|sessionKey|privateKey|prompt|capDayWei|x-exec-token/);
    });
  }

  for (const id of ["0", "9007199254740993", MAX_ID]) {
    it(`binds the actual uint256 id ${id} without numeric coercion or other metadata changes`, () => {
      const before = record(metadataUri("lp", REF));
      const after = record(metadataUri("lp", REF, id));
      assert.deepEqual(after.registrations, [{ agentId: id, agentRegistry: `eip155:56:${REGISTRY}` }]);
      assert.deepEqual({ ...after, registrations: [] }, before);
    });
  }

  /**
   * The regression that took the identity worker down for ~4 hours on
   * 2026-09-06: `SERVICES` gained an MCP entry, `validateLedger` re-derived
   * these two live jobs' `finalUri`, the bytes no longer matched what was
   * stored (and minted), and every ledger read failed `intent_mismatch`.
   *
   * These are the ACTUAL rows from production, so a future edit to the v1/v2
   * builders fails here instead of in a crash loop.
   */
  it("re-derives the exact finalUri of both live production identities", () => {
    const live = [
      { category: "grid" as const, ref: "d8678ba0-effd-4fa3-ac60-0131e5de9b1d", agentId: "337153",
        finalUri: "data:application/json;base64,eyJkZXNjcmlwdGlvbiI6IkF1dG9tYXRlZCBncmlkIG1hcmtldCBtYWtpbmcgdGhhdCBidXlzIGxvdyBhbmQgc2VsbHMgaGlnaCBhcyBtYXJrZXQgcHJpY2VzIG1vdmUgdXNpbmcgUGFuY2FrZVN3YXAgVjMgb24gQk5CIENoYWluLiIsImltYWdlIjoiaHR0cHM6Ly80bHBoYS50ZWNoLzRscGhhX2xvZ29fMTgwLnBuZyIsIm5hbWUiOiJHcmlkIEFnZW50IDEgYnkgNExQSEEiLCJyZWdpc3RyYXRpb25zIjpbeyJhZ2VudElkIjoiMzM3MTUzIiwiYWdlbnRSZWdpc3RyeSI6ImVpcDE1NTo1NjoweDgwMDRBMTY5RkI0YTMzMjUxMzZFQjI5ZkEwY2VCNkQyZTUzOWE0MzIifV0sInNlcnZpY2VzIjpbeyJlbmRwb2ludCI6Imh0dHBzOi8vNGxwaGEudGVjaCIsIm5hbWUiOiJ3ZWIifSx7ImVuZHBvaW50IjoiaHR0cHM6Ly94LmNvbS80bHBoYV9hZ2VudCIsIm5hbWUiOiJYIn1dLCJzb2NpYWxzIjp7IngiOiJodHRwczovL3guY29tLzRscGhhX2FnZW50In0sInR5cGUiOiJodHRwczovL2VpcHMuZXRoZXJldW0ub3JnL0VJUFMvZWlwLTgwMDQjcmVnaXN0cmF0aW9uLXYxIiwid2Vic2l0ZSI6Imh0dHBzOi8vNGxwaGEudGVjaCIsIng0MDJTdXBwb3J0IjpmYWxzZSwieDRscGhhIjp7ImNhdGVnb3J5IjoiZ3JpZCIsImRpc3BsYXlOdW1iZXIiOjEsImlkZW50aXR5Q3VzdG9keSI6InBsYXRmb3JtLW1pbnRlciIsImluc3RhbmNlUmVmIjoiZDg2NzhiYTAtZWZmZC00ZmEzLWFjNjAtMDEzMWU1ZGU5YjFkIn19" },
      { category: "lp" as const, ref: "7407f3d1-4de2-4712-8a50-80ae1a08de1c", agentId: "337272",
        finalUri: "data:application/json;base64,eyJkZXNjcmlwdGlvbiI6IlJvdXRlcyBsaXF1aWRpdHkgdG8gdGhlIGJlc3QgQVBSIG9yIGZlZSBvcHBvcnR1bml0aWVzIHdpdGggYXV0by1yZWJhbGFuY2luZywgY29tcG91bmRpbmcsIGFuZCByaXNrIGV4aXRzIHVzaW5nIFBhbmNha2VTd2FwIFYzIG9uIEJOQiBDaGFpbi4iLCJpbWFnZSI6Imh0dHBzOi8vNGxwaGEudGVjaC80bHBoYV9sb2dvXzE4MC5wbmciLCJuYW1lIjoiTFAgQWdlbnQgMSBieSA0TFBIQSIsInJlZ2lzdHJhdGlvbnMiOlt7ImFnZW50SWQiOiIzMzcyNzIiLCJhZ2VudFJlZ2lzdHJ5IjoiZWlwMTU1OjU2OjB4ODAwNEExNjlGQjRhMzMyNTEzNkVCMjlmQTBjZUI2RDJlNTM5YTQzMiJ9XSwic2VydmljZXMiOlt7ImVuZHBvaW50IjoiaHR0cHM6Ly80bHBoYS50ZWNoIiwibmFtZSI6IndlYiJ9LHsiZW5kcG9pbnQiOiJodHRwczovL3guY29tLzRscGhhX2FnZW50IiwibmFtZSI6IlgifV0sInNvY2lhbHMiOnsieCI6Imh0dHBzOi8veC5jb20vNGxwaGFfYWdlbnQifSwidHlwZSI6Imh0dHBzOi8vZWlwcy5ldGhlcmV1bS5vcmcvRUlQUy9laXAtODAwNCNyZWdpc3RyYXRpb24tdjEiLCJ3ZWJzaXRlIjoiaHR0cHM6Ly80bHBoYS50ZWNoIiwieDQwMlN1cHBvcnQiOmZhbHNlLCJ4NGxwaGEiOnsiY2F0ZWdvcnkiOiJscCIsImRpc3BsYXlOdW1iZXIiOjEsImlkZW50aXR5Q3VzdG9keSI6InBsYXRmb3JtLW1pbnRlciIsImluc3RhbmNlUmVmIjoiNzQwN2YzZDEtNGRlMi00NzEyLThhNTAtODBhZTFhMDhkZTFjIn19" },
    ];
    for (const row of live) {
      assert.equal(metadataUriV2(row.category, 1, row.ref, row.agentId), row.finalUri);
      assert.equal(metadataUriFor(2, row.category, 1, row.ref, row.agentId), row.finalUri);
      // v3 must NOT reproduce them: it is a different published document.
      assert.notEqual(metadataUriV3(row.category, 1, row.ref, row.agentId), row.finalUri);
    }
  });

  it("v3 adds the callable MCP face and changes nothing else", () => {
    for (const category of ["grid", "trading", "lp"] as const) {
      const two = record(metadataUriV2(category, 1, REF, "1"));
      const three = record(metadataUriV3(category, 1, REF, "1"));
      assert.deepEqual(three.services, V3_SERVICES);
      assert.deepEqual({ ...three, services: null }, { ...two, services: null });
      assert.equal(metadataUriFor(3, category, 1, REF, "1"), metadataUriV3(category, 1, REF, "1"));
    }
  });

  it("the resolver dispatches every version and refuses a numbered version with no display number", () => {
    assert.equal(metadataUriFor(undefined, "lp", undefined, REF), metadataUri("lp", REF));
    assert.equal(metadataUriFor(1, "lp", 1, REF), metadataUri("lp", REF));
    assert.equal(metadataUriFor(2, "lp", 1, REF), metadataUriV2("lp", 1, REF));
    assert.equal(metadataUriFor(3, "lp", 1, REF), metadataUriV3("lp", 1, REF));
    for (const version of [2, 3] as const) {
      assert.throws(() => metadataUriFor(version, "lp", undefined, REF), /invalid_identity/);
    }
  });

  it("rejects invalid ids, refs and categories rather than publishing caller text", () => {
    for (const id of ["01", "-1", "1e3", (1n << 256n).toString(), "9".repeat(5000), "<script>"]) {
      assert.throws(() => metadataUri("grid", REF, id), /invalid_identity/);
    }
    for (const ref of ["private-owner-name", "https://attacker.invalid", "00000000-0000-1000-8000-000000000001"]) {
      assert.throws(() => metadataUri("grid", ref), /invalid_identity/);
    }
    assert.throws(() => metadataUri("private strategy text" as IdentityCategory, REF), /invalid_identity/);
  });
});

describe("ERC-8004 malformed state remains separate from absence", () => {
  it("distinguishes SQL NULL from a stored JSON null or malformed object", () => {
    assert.equal(decodeIdentity(null, true), null);
    assert.equal(decodeIdentity(undefined, true), null);
    for (const value of [null, "null", "{bad-json", [], 42, { status: "registered", agentId: "1" }]) {
      assert.deepEqual(decodeIdentity(value, false), INVALID_IDENTITY);
    }
    assert.equal(identityOwnerView(null), undefined);
    assert.deepEqual(identityOwnerView(INVALID_IDENTITY), { status: "blocked", errorCode: "invalid_identity" });
  });

  it("only treats a complete verified summary as registered", () => {
    assert.ok(validIdentity(decodeIdentity(registered(), false)));
    for (const change of [
      { agentId: null }, { agentId: Number.MAX_SAFE_INTEGER + 1 },
      { registrationTxHash: null }, { uriUpdateTxHash: null },
      { uriUpdateTxHash: "javascript:alert(1)" }, { errorCode: "verification_failed" },
      { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: 0 },
      { status: "registered-by-client" }, { unexpectedPrivatePrompt: "must never be echoed" },
    ]) {
      const decoded = decodeIdentity({ ...registered(), ...change }, false);
      assert.deepEqual(decoded, INVALID_IDENTITY);
      assert.deepEqual(identityOwnerView(decoded), { status: "blocked", errorCode: "invalid_identity" });
    }
  });

  it("accepts partial mint evidence without upgrading it to a registered identity", () => {
    const updating: Erc8004IdentitySummary = { ...registered(), status: "updating", uriUpdateTxHash: null };
    assert.deepEqual(identityOwnerView(decodeIdentity(updating, false)), updating);
    const blocked: Erc8004IdentitySummary = { ...updating, status: "blocked", errorCode: "rpc_unavailable" };
    assert.deepEqual(identityOwnerView(decodeIdentity(blocked, false)), blocked);
  });

  it("generates a fresh opaque ref for a new instance without any caller metadata", () => {
    const first = newIdentity("grid");
    const second = newIdentity("grid");
    assert.notEqual(first.publicRef, second.publicRef);
    assert.ok(validIdentity(decodeIdentity(first, false)));
    assert.equal(first.status, "pending");
    assert.equal(first.agentId, null);
    assert.equal(first.registrationTxHash, null);
    assert.equal(first.uriUpdateTxHash, null);
  });
});
