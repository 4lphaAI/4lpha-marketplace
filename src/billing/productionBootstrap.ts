import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { EnabledBillingConfig } from "./config.js";
import { hasForbiddenBillingAwsEnvironment } from "./awsBillingEnvironment.js";
import {
  parseProductionManifest,
  type BillingProductionManifestV2,
} from "./productionManifest.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export type BillingProductionBootstrapV1 = Readonly<{
  manifest: BillingProductionManifestV2;
  manifestSha256: string;
  bundleUrl: string;
}>;

export type BillingProductionManifestBootstrapV1 = Readonly<{
  manifest: BillingProductionManifestV2;
  manifestSha256: string;
}>;

function assertClosedBootEnvironment(env: NodeJS.ProcessEnv): void {
  if (required(env, "EXECUTION_NETWORK") !== "mainnet") {
    throw new Error("Billing production boot requires EXECUTION_NETWORK=mainnet.");
  }
  if (hasForbiddenBillingAwsEnvironment(env)) {
    throw new Error("Billing production boot rejects alternate AWS credential sources.");
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (value === "") throw new Error(`${name} is required for billing production boot.`);
  return value;
}

function sameAddress(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function assertManifestMatchesConfig(
  manifest: BillingProductionManifestV2,
  config: EnabledBillingConfig,
): void {
  if (!sameAddress(config.collector, manifest.collector.address) ||
      !sameAddress(config.treasury, manifest.collector.treasury) ||
      config.collectorRuntimeBytecodeHash.toLowerCase() !== manifest.collector.runtimeCodehash ||
      config.executionTicketKeyId !== manifest.aws.ticketKeyId ||
      config.x402 !== (manifest.providers.x402Enabled ? "on" : "off") ||
      config.og !== (manifest.providers.ogEnabled ? "on" : "off") ||
      config.platformBaseUsdcCapAtomic !== BigInt(manifest.caps.platformUsdcAtomic) ||
      config.platformOgCapNeuron !== BigInt(manifest.caps.platformOgNeuron) ||
      JSON.stringify(config.bscRpcOrigins) !== JSON.stringify(manifest.networks.bsc.origins) ||
      JSON.stringify(config.baseRpcOrigins) !== JSON.stringify(manifest.networks.base.origins) ||
      JSON.stringify(config.arbitrumRpcOrigins) !== JSON.stringify(manifest.networks.arbitrum.origins) ||
      manifest.providers.x402Enabled && !sameAddress(config.x402Authorizer, manifest.providers.x402Authorizer) ||
      manifest.providers.ogEnabled && config.ogRouterPayerAccountId !== manifest.providers.ogPayerAccountId) {
    throw new Error("Billing environment and production manifest disagree.");
  }
}

async function boundedRegularFile(path: string, maximum: number, field: string): Promise<Readonly<{
  bytes: Uint8Array;
  mode: number;
}>> {
  if (!isAbsolute(path)) throw new Error(`${field} must be an absolute path.`);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) {
    throw new Error(`${field} must be a bounded regular non-symlink file.`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || bytes.byteLength !== before.size) {
    throw new Error(`${field} changed while being read.`);
  }
  return { bytes, mode: before.mode };
}

/** Pure byte-level half used after local permission and file-shape checks. */
export function validateBillingProductionBootstrapBytes(input: Readonly<{
  config: EnabledBillingConfig;
  env: NodeJS.ProcessEnv;
  manifestBytes: Uint8Array;
  bundleBytes: Uint8Array;
  bundleUrl: string;
}>): BillingProductionBootstrapV1 {
  assertClosedBootEnvironment(input.env);
  const manifest = parseProductionManifest(input.manifestBytes);
  assertManifestMatchesConfig(manifest, input.config);
  if (createHash("sha256").update(input.bundleBytes).digest("hex") !== manifest.bundleSha256) {
    throw new Error("Billing production bundle SHA-256 does not match the manifest.");
  }
  return Object.freeze({
    manifest,
    manifestSha256: createHash("sha256").update(input.manifestBytes).digest("hex"),
    bundleUrl: input.bundleUrl,
  });
}

/** Compatibility helper for offline callers that need both local artifacts. */
export async function loadBillingProductionBootstrap(
  config: EnabledBillingConfig,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<BillingProductionBootstrapV1> {
  const local = await loadBillingProductionManifest(config, env, platform);
  return {
    ...local,
    bundleUrl: await loadBillingProductionBundle(local.manifest, env),
  };
}

/** Step 1 of ON boot: config and manifest only; no database, DNS or bundle import. */
export async function loadBillingProductionManifest(
  config: EnabledBillingConfig,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<BillingProductionManifestBootstrapV1> {
  assertClosedBootEnvironment(env);
  const manifestPath = required(env, "BILLING_PRODUCTION_MANIFEST_PATH");
  const manifestFile = await boundedRegularFile(manifestPath, MAX_MANIFEST_BYTES, "Billing production manifest");
  if (platform === "win32" || (manifestFile.mode & 0o777) !== 0o600) {
    throw new Error("manifest-permissions-unverified");
  }
  const manifest = parseProductionManifest(manifestFile.bytes);
  assertManifestMatchesConfig(manifest, config);
  return Object.freeze({
    manifest,
    manifestSha256: createHash("sha256").update(manifestFile.bytes).digest("hex"),
  });
}

/** Step 4 of ON boot: verify the reviewed artifact only after DB and DNS gates. */
export async function loadBillingProductionBundle(
  manifest: BillingProductionManifestV2,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const bundlePath = required(env, "BILLING_PRODUCTION_BUNDLE_PATH");
  const bundleFile = await boundedRegularFile(bundlePath, MAX_BUNDLE_BYTES, "Billing production bundle");
  if (createHash("sha256").update(bundleFile.bytes).digest("hex") !== manifest.bundleSha256) {
    throw new Error("Billing production bundle SHA-256 does not match the manifest.");
  }
  return pathToFileURL(bundlePath).href;
}
