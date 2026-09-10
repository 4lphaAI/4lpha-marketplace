# Quant fixtures (QUANT-GRID-AGENT-SPEC W2) — captured 2026-09-10, no secrets

- `termix-envelope-golden.json` — produced by the TermiX skill package v1.7.0's own
  `sealForSelfTest` (`scripts/aacp-quant.mjs`) against a public key derived from the
  THROWAWAY seed `0x11…11` with the skill's `deriveKeypair` algorithm
  (HKDF-SHA256, info `termix-quant-x25519-v1`, PKCS8/SPKI X25519 prefixes recorded in
  the file). `roundTrip: true` was verified with an independent open. `src/quant/envelope.ts`
  must derive the same public key from that seed and open this envelope to this plaintext.
  Algorithm string as the skill sends it: `x25519-hkdf-chacha20poly1305`.
- `bnbagent-serialized-session.json` — `@bnbagent/sdk` 0.5.6 `serializeSession()` output for a
  throwaway session (`ALTANA_SESSION_VERSION = 1`; bigints encoded as `{"$bigint":"<decimal>"}`;
  the signer's `_privateKey` is emitted as `privateKey`). The private key inside is `0x22…22`,
  a fixture, not a key.
- `admissible-session.json` — the BC14/BC15/BC33 VALID admission fixture, checked in before
  W4. The serialization fixture above is explicitly NOT one (its `publicKey` does not derive
  from its `privateKey`, it grants only the router swap, and it has one U day cap and no
  native row). This one has: key ↔ publicKey matching (throwaway `0x33…33`), both target-bound
  approvals, TWO WBNB cap rows (day AND minute — the period a day-only meter read would miss),
  one U row, a native row, and a future expiry. Every value is public; nothing here is a secret.
