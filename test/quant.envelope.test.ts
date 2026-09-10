/**
 * The TermiX envelope, against GOLDEN VECTORS produced by their own skill
 * (QUANT-GRID W2/W3, R2.14, M6).
 *
 * The vectors are what make this reimplementation trustworthy: they were
 * produced OFFLINE by `sealForSelfTest` + `deriveKeypair` from the skill
 * package v1.7.0 with a throwaway seed, so nothing here can pass by agreeing
 * with itself. A mismatch is a BUILD failure, not a runtime surprise — which is
 * the whole point of not executing their script inside our worker.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  deriveKeypair,
  open,
  publicKeyEquals,
  seal,
  QUANT_ENVELOPE_ALGORITHM,
  QuantEnvelopeError,
  type QuantEnvelope,
} from "../src/quant/envelope.js";

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/quant/termix-envelope-golden.json", import.meta.url), "utf8"),
) as {
  walletKeyThrowaway: string;
  publicKeyBase64: string;
  envelope: QuantEnvelope;
  plaintext: string;
};

describe("quant envelope — golden vectors", () => {
  it("derives the SAME public key the skill's deriveKeypair produced", () => {
    const keypair = deriveKeypair(golden.walletKeyThrowaway);
    assert.equal(keypair.publicKey.toString("base64"), golden.publicKeyBase64);
  });

  it("derives from the 0x-hex STRING's bytes, not from the 32 bytes it spells", () => {
    // The skill passes WALLET_KEY straight into HKDF as the string it read from
    // the environment. Deriving from the DECODED bytes produces a different,
    // silently-wrong key that would register fine and open nothing — and the
    // golden vector is the only instrument that can catch that.
    const keypair = deriveKeypair(golden.walletKeyThrowaway);
    const decodedIkm = Buffer.from(golden.walletKeyThrowaway.slice(2), "hex");
    assert.notEqual(keypair.publicKey.toString("hex"), decodedIkm.toString("hex"));
  });

  it("opens the skill's own sealed envelope to the exact plaintext", () => {
    const keypair = deriveKeypair(golden.walletKeyThrowaway);
    assert.equal(open(golden.envelope, keypair), golden.plaintext);
  });

  it("pins the ALGORITHM string the skill sends", () => {
    assert.equal(QUANT_ENVELOPE_ALGORITHM, "x25519-hkdf-chacha20poly1305");
    assert.equal(golden.envelope.algorithm, QUANT_ENVELOPE_ALGORITHM);
  });

  it("refuses an envelope declaring a different algorithm", () => {
    const keypair = deriveKeypair(golden.walletKeyThrowaway);
    assert.throws(
      () => open({ ...golden.envelope, algorithm: "aes-256-gcm" }, keypair),
      (error: unknown) =>
        error instanceof QuantEnvelopeError && error.code === "envelope-algorithm-unsupported",
    );
  });

  it("refuses a TAMPERED ciphertext", () => {
    const keypair = deriveKeypair(golden.walletKeyThrowaway);
    const raw = Buffer.from(golden.envelope.ciphertext, "base64");
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    assert.throws(
      () => open({ ...golden.envelope, ciphertext: raw.toString("base64") }, keypair),
      (error: unknown) =>
        error instanceof QuantEnvelopeError && error.code === "envelope-invalid",
    );
  });

  it("refuses the WRONG recipient", () => {
    const other = deriveKeypair(`0x${"22".repeat(32)}`);
    assert.throws(
      () => open(golden.envelope, other),
      (error: unknown) =>
        error instanceof QuantEnvelopeError && error.code === "envelope-invalid",
    );
  });

  it("refuses a malformed base64 field rather than decoding a short buffer", () => {
    const keypair = deriveKeypair(golden.walletKeyThrowaway);
    // Node's base64 decoder DROPS what it does not recognise, so a corrupted
    // field decodes to a shorter buffer instead of failing. Re-encoding and
    // comparing is what turns that into a refusal.
    assert.throws(
      () => open({ ...golden.envelope, nonce: "not base64!!" }, keypair),
      (error: unknown) =>
        error instanceof QuantEnvelopeError && error.code === "envelope-malformed",
    );
  });

  it("refuses a seed that is not 0x + 64 hex", () => {
    for (const bad of ["", "0x", "1111", `0x${"11".repeat(31)}`, `${"11".repeat(32)}`]) {
      assert.throws(
        () => deriveKeypair(bad),
        (error: unknown) => error instanceof QuantEnvelopeError && error.code === "seed-invalid",
      );
    }
  });
});

describe("quant envelope — our seal", () => {
  it("round-trips through our own open", () => {
    const keypair = deriveKeypair(`0x${"44".repeat(32)}`);
    const plaintext = JSON.stringify({ hello: "world", n: 1 });
    const envelope = seal(plaintext, keypair.publicKey);
    assert.equal(envelope.algorithm, QUANT_ENVELOPE_ALGORITHM);
    assert.equal(open(envelope, keypair), plaintext);
  });

  it("produces a DIFFERENT ephemeral key each time", () => {
    const keypair = deriveKeypair(`0x${"44".repeat(32)}`);
    const a = seal("x", keypair.publicKey);
    const b = seal("x", keypair.publicKey);
    assert.notEqual(a.ephemeralPublicKey, b.ephemeralPublicKey);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  it("refuses a recipient key that is not 32 raw bytes", () => {
    assert.throws(
      () => seal("x", Buffer.alloc(31)),
      (error: unknown) =>
        error instanceof QuantEnvelopeError && error.code === "recipient-invalid",
    );
  });

  it("compares public keys in constant time and by value", () => {
    const keypair = deriveKeypair(`0x${"44".repeat(32)}`);
    assert.equal(publicKeyEquals(keypair.publicKey, Buffer.from(keypair.publicKey)), true);
    assert.equal(publicKeyEquals(keypair.publicKey, Buffer.alloc(32)), false);
    assert.equal(publicKeyEquals(keypair.publicKey, Buffer.alloc(31)), false);
  });
});
