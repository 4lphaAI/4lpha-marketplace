import { createHash } from "node:crypto";
import { parseProductionManifest, type BillingProductionManifestV2 } from "./productionManifest.js";

export type ManifestPermissionResult = "verified-owner-only" | "manifest-permissions-unverified";

export type OfflineBillingPreflightResult = Readonly<{
  schema: "4lpha.billing-offline-preflight.v1";
  ok: true;
  manifestSha256: string;
  bundleSha256: string;
  sourceSha256: string;
  lockSha256: string;
  buildCommit: string;
  permissions: "verified-owner-only";
}>;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Pure local preflight. It has no environment, DNS, network, AWS, RPC, or database seam. */
export function validateOfflineBillingPreflight(input: Readonly<{
  manifestBytes: Uint8Array;
  bundleBytes: Uint8Array;
  sourceBytes: Uint8Array;
  lockBytes: Uint8Array;
  manifestPermissions: ManifestPermissionResult;
}>): Readonly<{ manifest: BillingProductionManifestV2; report: OfflineBillingPreflightResult }> {
  const manifest = parseProductionManifest(input.manifestBytes);
  if (input.manifestPermissions !== "verified-owner-only") {
    throw new Error("manifest-permissions-unverified");
  }
  const bundleSha256 = digest(input.bundleBytes);
  const sourceSha256 = digest(input.sourceBytes);
  const lockSha256 = digest(input.lockBytes);
  if (bundleSha256 !== manifest.bundleSha256) throw new Error("Adapter bundle SHA-256 does not match the manifest.");
  if (sourceSha256 !== manifest.sourceSha256) throw new Error("Adapter source SHA-256 does not match the manifest.");
  if (lockSha256 !== manifest.lockSha256) throw new Error("Dependency lock SHA-256 does not match the manifest.");
  return {
    manifest,
    report: Object.freeze({
      schema: "4lpha.billing-offline-preflight.v1",
      ok: true,
      manifestSha256: digest(input.manifestBytes),
      bundleSha256,
      sourceSha256,
      lockSha256,
      buildCommit: manifest.buildCommit,
      permissions: "verified-owner-only",
    }),
  };
}

