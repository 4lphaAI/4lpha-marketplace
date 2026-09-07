import { metadataUriFor } from "../../src/identity/metadata.js";
import { MINTER_RECOVERY, type MinterMigrationRequest } from "../../src/identity/minterMigration.js";
import { newIdentity, REGISTRY, type IdentityJob } from "../../src/identity/types.js";

export const OWNER = "0x2222222222222222222222222222222222222222";
export const REF = "12345678-1234-4234-8234-123456789abc";
export const REQUEST: MinterMigrationRequest = { ...MINTER_RECOVERY, publicRef: REF, apply: true };
export const MIGRATION_CONFIG = { chainId: 56, minter: MINTER_RECOVERY.newMinter } as const;
export const ARGS = ["--source-id", REQUEST.sourceId, "--old-minter", REQUEST.oldMinter, "--new-minter", REQUEST.newMinter, "--public-ref", REF, "--category", "trading"];
export function blockedIdentity() {
  return { ...newIdentity("trading"), publicRef: REF, revision: 4, status: "blocked" as const, errorCode: "nonce_conflict" as const };
}
export function blockedJob(): IdentityJob {
  return { publicRef: REF, sourceId: REQUEST.sourceId, owner: OWNER, category: "trading", displayNumber: 7, metadataVersion: 3,
    chainId: 56, registry: REGISTRY, minter: REQUEST.oldMinter, createdAt: 123456,
    initialUri: metadataUriFor(3, "trading", 7, REF), finalUri: null, status: "blocked", error: "nonce_conflict",
    mintedId: null, registrationHash: null, updateHash: null, envelope: null, effectiveCeiling: null,
    updateGasCeiling: null, updatePriceCeiling: null, completedAt: null };
}
