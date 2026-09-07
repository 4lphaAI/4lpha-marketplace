import { describe, expect, it } from "vitest";
import { erc8004TokenUrl, parseErc8004Identity } from "./erc8004-identity";

const ref = "bc3f7b92-4c65-4acf-aef4-338b084f7a13";
const hash = `0x${"ab".repeat(32)}`;
const maxId = ((1n << 256n) - 1n).toString();
const invalid = { status: "blocked", errorCode: "invalid_identity" };
const pending = { version: 1, publicRef: ref, revision: 1, category: "grid", status: "pending", agentId: null, registrationTxHash: null, uriUpdateTxHash: null, errorCode: null };
const registered = { ...pending, status: "registered", agentId: maxId, registrationTxHash: hash, uriUpdateTxHash: hash };

describe("ERC-8004 owner summary", () => {
  it("keeps legacy absence and the safe invalid marker distinct", () => {
    expect(parseErc8004Identity(undefined)).toBeUndefined();
    expect(parseErc8004Identity(null)).toBeUndefined();
    expect(parseErc8004Identity(invalid)).toEqual(invalid);
  });

  it("keeps zero and the full uint256 ID exact in its fixed registry link", () => {
    for (const agentId of ["0", "9007199254740993", maxId]) {
      const parsed = parseErc8004Identity({ ...registered, agentId });
      expect(parsed).toEqual({ ...registered, agentId });
      expect(erc8004TokenUrl(parsed!)).toBe(`https://8004scan.io/agents/bsc/${agentId}`);
    }
  });

  it("accepts each legal phase without promoting intermediate token evidence", () => {
    for (const value of [pending, { ...pending, status: "registering", registrationTxHash: hash },
      { ...registered, status: "updating", uriUpdateTxHash: null }, { ...registered, status: "updating" },
      { ...registered, status: "blocked", errorCode: "verification_failed" },
      { ...pending, status: "blocked", errorCode: "fee_limit" }]) {
      const parsed = parseErc8004Identity(value);
      expect(parsed).toEqual(value);
      expect(erc8004TokenUrl(parsed!)).toBeNull();
    }
  });

  // MARKETPLACE-LENDING-AGENT §8.4 / R2.23 item 9: `IdentityCategory` gained
  // "lending", so the fixture that used to prove category "lending" was
  // REJECTED is INVERTED here and declared. The rejection case it vacated is
  // kept by an unrelated unknown category ("custody") in the malformed list, so
  // the closed-union check is still exercised.
  it("INVERTED for the lending phase: category \"lending\" is now ACCEPTED (was a rejection fixture)", () => {
    const lending = { ...registered, category: "lending" };
    expect(parseErc8004Identity(lending)).toEqual(lending);
    expect(erc8004TokenUrl(parseErc8004Identity(lending)!)).toBe(`https://8004scan.io/agents/bsc/${maxId}`);
  });

  it("strips malformed records to attention without retaining IDs, refs, URLs or raw errors", () => {
    const values: unknown[] = [false, [], "registered", {}, { agentId: "5" },
      { ...registered, version: 2 }, { ...registered, revision: 0 }, { ...registered, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...registered, publicRef: "customer-wallet" }, { ...registered, publicRef: ref.toUpperCase() },
      { ...registered, category: "custody" }, { ...registered, errorCode: "rpc_unavailable" },
      { ...registered, registrationTxHash: null }, { ...registered, uriUpdateTxHash: null },
      { ...registered, uriUpdateTxHash: "0x1234" }, { ...registered, registrationTxHash: hash.replace("0x", "0X") },
      { ...registered, status: "blocked", errorCode: "private error text" },
      { ...registered, status: "blocked" }, { ...pending, status: "registering" },
      { ...pending, status: "updating" }, { ...pending, registrationTxHash: hash },
      { ...pending, agentId: "1" }, { ...registered, status: "registering" },
      { ...registered, url: "https://malicious.invalid/token" },
      ...[1, "01", "-1", "1e6", "1/../../x", (1n << 256n).toString(), "1".repeat(1000)].map(agentId => ({ ...registered, agentId })),
    ];
    for (const value of values) {
      const parsed = parseErc8004Identity(value);
      expect(parsed).toEqual(invalid);
      expect(erc8004TokenUrl(parsed!)).toBeNull();
    }
  });
});
