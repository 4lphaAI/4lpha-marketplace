# URI decoder compatibility bridge

WalletConnect's query-string 7.1.3 uses a synchronous CommonJS decoder. The
security fix for GHSA-vcc3-ghjq-m6fr is upstream decode-uri-component 0.5.0,
which is ESM. This package only adapts the export shape; it contains no forked
decoder or alternate decoding algorithm.

The differently named npm alias avoids recursively overriding the fixed
dependency. Both import and require paths call that exact upstream version.
The require bridge needs Node22.12 or newer (production uses node:22).
Use the pinned npm10 installer (`npx npm@10.9.4 ci --legacy-peer-deps`) as
production does. npm11 with legacy peer resolution can omit the existing
Solana peer subtree needed by the Coinbase connector; do not regenerate away
those baseline lockfile records. No Solana SDK versions were upgraded here.
Remove this bridge when the upstream WalletConnect/query-string dependency
chain supports the fixed decoder directly. Tests exercise actual CommonJS
query-string consumers and WalletConnect URI parsing, including malformed input.
