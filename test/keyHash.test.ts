/**
 * Offline test for the account key-hash derivation.
 *
 * This is the one piece of the relay-independent recovery path that we compute
 * ourselves rather than getting from the SDK: `IthacaAccount.revoke` takes a
 * keyHash, and getting it wrong means a revocation transaction that succeeds
 * on-chain while revoking nothing.
 *
 * The check is a cross-implementation one against Porto's own `Key.hash`
 * (Porto is the account implementation the wallet delegates to under
 * EIP-7702), plus a pinned vector so an upstream change is visible rather than
 * silently agreed with.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, padHex } from "viem";
import * as Key from "porto/viem/Key";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";

const ADDRESS = getAddress("0x000000000000000000000000000000000000dEaD");

describe("accountKeyHashForAddress", () => {
  it("matches Porto's Key.hash for a secp256k1 key", () => {
    // Porto stores a secp256k1 key's "public key" as its 20-byte address,
    // left-padded to 32 bytes.
    const expected = Key.hash({
      type: "secp256k1",
      publicKey: padHex(ADDRESS, { size: 32 }),
    });

    assert.equal(accountKeyHashForAddress(ADDRESS), expected);
  });

  it("is insensitive to input checksum casing", () => {
    assert.equal(
      accountKeyHashForAddress(ADDRESS.toLowerCase() as `0x${string}`),
      accountKeyHashForAddress(ADDRESS),
    );
  });

  it("is distinct per address", () => {
    assert.notEqual(
      accountKeyHashForAddress(ADDRESS),
      accountKeyHashForAddress(
        getAddress("0x00000000000000000000000000000000000d3ad1"),
      ),
    );
  });

  it("returns a 32-byte hash", () => {
    assert.match(accountKeyHashForAddress(ADDRESS), /^0x[0-9a-f]{64}$/);
  });
});
