# Evidence-free minter recovery

This is a separate, one-instance operator recovery command:
`scripts/erc8004-minter-migration.ts`. The ordinary
`scripts/erc8004-identity.ts migrate` command installs the identity schema,
including the global owner/category/number unique index; it does not perform
this recovery. Both entries are included in the `Dockerfile.services` context.
Recovery is never part of automatic service startup.

The required operational order is **disable → schema check → dry-run → apply →
verify → enable**. This document records the procedure; local audit tests do not
authorize production access, deployment, recovery, or minting.

1. Disable the identity worker/daemon and stop all writers using either minter.
   Confirm neither worker holds its minter advisory fence. Keep the worker off
   throughout schema installation, recovery, and after-state verification.
2. In the separately authorized maintenance environment, install the current
   identity schema with `node --import tsx scripts/erc8004-identity.ts migrate`.
   The global `erc8004_owner_category_number` unique index covers all retained
   jobs regardless of minter. Existing numbers and metadata bytes stay unchanged;
   duplicates make installation fail. Do not delete or renumber historical jobs
   to bypass that refusal. New allocation holds sorted owner/category transaction
   locks before its minter nonce lock. Legacy unnumbered jobs remain unnumbered.
3. Supply the database connection and public chain/registry/RPC/new-minter
   configuration through the maintenance environment. Recovery reads only
   `DATABASE_URL`, `ERC8004_CHAIN_ID`, `ERC8004_REGISTRY_ADDRESS`,
   `ERC8004_RPC_URL`, and `ERC8004_MINTER_ADDRESS`. It does not need or read a
   signing key and does not load environment files. Use the source's actual
   persisted public reference in place of `PUBLIC_REF` below.
4. Run the default dry-run:

   ```sh
   node --import tsx scripts/erc8004-minter-migration.ts --source-id trading-agent-01-2 --old-minter 0xD7E004CBda24E079aA3A657Ba7f8E2915192a966 --new-minter 0x273987e9d86D5231b0Be928Aba88129AC479Ca9d --public-ref PUBLIC_REF --category trading
   ```

   Expect `mode:"dry-run"` and `applied:false`. The migration requires the SQL
   adapter's explicit top-level transaction capability; nested or unmarked
   adapters are refused before any query/write. A dry-run executes the same
   constraints and writes as apply, then rolls everything back. Missing,
   malformed, unfinalized, or contradictory transaction history is refused;
   finalized history must have complete outcome, timestamp, block number/hash,
   relational bindings, and matching job/phase/calldata evidence.
5. Review the returned source/ref/category/minters, next nonce, identity revision
   increment, and initial-URI SHA-256. With separate authorization, repeat the
   exact command with `--apply`. Expect `mode:"apply"` and `applied:true`.
   Both commands acquire both minter fences and recheck every precondition.
6. Verify the exact database after-state before enabling: the selected job keeps
   its publicRef, source, owner, category, number, metadata version, creation time,
   and URI bytes; only minter/status/error change to the new minter/pending/null.
   The source identity becomes pending with revision incremented once. Its
   authority fields, row_version, updated_at, and ERC-8004 agent id stay unchanged.
   Only the new minter nonce is initialized/updated to the returned nonce.
   Old-minter nonces, all transaction history, registered jobs, and unrelated
   source rows remain unchanged. A repeated apply must refuse.
7. Before separately authorized enablement, verify the deployed public minter
   address, signing configuration through the approved operator process, latest
   equals pending equals the recovered nonce, exclusive writer control, and
   existing fee/balance limits. Enabling can submit the usual two capped
   register/update transactions. Verify their finalized results, registry owner,
   exact metadata URI, and registered source projection afterward.

Any refusal leaves the worker disabled. Investigate the retained evidence;
do not reset nonce rows, erase history, relax checks, or rerun apply blindly.
