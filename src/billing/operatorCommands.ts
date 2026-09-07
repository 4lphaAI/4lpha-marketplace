import { createHash } from "node:crypto";
import {
  buildExpiryEvidence,
  canonicalExpiryEvidence,
  type BillingExpiryEvidenceV1,
} from "./productionOps.js";
import {
  parseProductionManifest,
  type BillingProductionManifestV2,
} from "./productionManifest.js";
import { validateOfflineBillingPreflight, type OfflineBillingPreflightResult } from "./productionPreflight.js";
import {
  validatePostdeployEvidence,
  type PostdeployRpcObservationV1,
} from "./productionEvidence.js";
import type { Hex } from "viem";

const MAX_LOCAL_INPUT_BYTES = 64 * 1024 * 1024;

export type LocalFileStat = Readonly<{
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
}>;

export type LocalReadDeps = Readonly<{
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<LocalFileStat>;
  platform: NodeJS.Platform;
}>;

function strictFlags(argv: readonly string[], booleans: readonly string[], values: readonly string[]): Readonly<Record<string, string | true>> {
  const allowed = new Set([...booleans, ...values]);
  const result: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (!allowed.has(name) || result[name] !== undefined) throw new Error("invalid-cli-flags");
    if (booleans.includes(name)) {
      result[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("invalid-cli-flags");
    result[name] = value;
    index += 1;
  }
  if ([...booleans, ...values].some((name) => result[name] === undefined)) throw new Error("invalid-cli-flags");
  return result;
}

async function boundedRegularFile(path: string, deps: LocalReadDeps): Promise<Uint8Array> {
  const info = await deps.stat(path);
  if (!info.isFile || info.isSymbolicLink || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_LOCAL_INPUT_BYTES) {
    throw new Error("Local operator input must be a bounded regular non-symlink file.");
  }
  const bytes = await deps.readFile(path);
  if (bytes.byteLength !== info.size) throw new Error("Local operator input changed while being read.");
  return bytes;
}

async function manifestPermissions(path: string, deps: LocalReadDeps): Promise<"verified-owner-only" | "manifest-permissions-unverified"> {
  const info = await deps.stat(path);
  if (deps.platform === "win32") return "manifest-permissions-unverified";
  return (info.mode & 0o777) === 0o600 ? "verified-owner-only" : "manifest-permissions-unverified";
}

export async function runOfflinePreflightCommandDetailed(argv: readonly string[], deps: LocalReadDeps): Promise<Readonly<{
  manifest: BillingProductionManifestV2;
  report: OfflineBillingPreflightResult;
}>> {
  const flags = strictFlags(argv, ["--offline"], ["--manifest", "--bundle", "--source", "--lock"]);
  const manifestPath = flags["--manifest"] as string;
  const [manifestBytes, bundleBytes, sourceBytes, lockBytes, permissions] = await Promise.all([
    boundedRegularFile(manifestPath, deps),
    boundedRegularFile(flags["--bundle"] as string, deps),
    boundedRegularFile(flags["--source"] as string, deps),
    boundedRegularFile(flags["--lock"] as string, deps),
    manifestPermissions(manifestPath, deps),
  ]);
  return validateOfflineBillingPreflight({ manifestBytes, bundleBytes, sourceBytes, lockBytes, manifestPermissions: permissions });
}

export async function runOfflinePreflightCommand(argv: readonly string[], deps: LocalReadDeps): Promise<OfflineBillingPreflightResult> {
  return (await runOfflinePreflightCommandDetailed(argv, deps)).report;
}

function canonicalJson(bytes: Uint8Array, field: string): unknown {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${field} must not contain a BOM.`);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${field} must be UTF-8.`); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new Error(`${field} must be JSON.`); }
  if (JSON.stringify(value) !== text) throw new Error(`${field} must be canonical no-whitespace JSON.`);
  return value;
}

function row(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(rowValue: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(rowValue);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error(`${field} members drifted.`);
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer.`);
  return value as number;
}

export function classifyExpiryFixture(bytes: Uint8Array): BillingExpiryEvidenceV1 {
  const value = row(canonicalJson(bytes, "expiry fixture"), "expiry fixture");
  exact(value, ["schema", "observedAt", "maxExpiresAt", "quoteExpiresAt", "intentExpiresAt", "manifestSha256", "bundleSha256", "probeInputSha256"], "expiry fixture");
  if (value["schema"] !== "4lpha.billing-expiry-classify-input.v1") throw new Error("Expiry fixture schema drifted.");
  const evidence = buildExpiryEvidence({
    observedAt: integer(value["observedAt"], "observedAt"),
    maxExpiresAt: integer(value["maxExpiresAt"], "maxExpiresAt"),
    quoteExpiresAt: value["quoteExpiresAt"],
    intentExpiresAt: value["intentExpiresAt"],
    manifestSha256: String(value["manifestSha256"]),
    bundleSha256: String(value["bundleSha256"]),
    probeInputSha256: String(value["probeInputSha256"]),
  });
  canonicalExpiryEvidence(evidence);
  return evidence;
}

export function validatePostdeployFixture(input: Readonly<{
  manifestBytes: Uint8Array;
  evidenceBytes: Uint8Array;
}>): Readonly<{ schema: "4lpha.billing-postdeploy-offline-result.v1"; ok: true; transactionHash: Hex; runtimeCodehash: Hex }> {
  const manifest = parseProductionManifest(input.manifestBytes);
  const value = row(canonicalJson(input.evidenceBytes, "postdeploy fixture"), "postdeploy fixture");
  exact(value, ["schema", "expectedInitcodeHash", "observations"], "postdeploy fixture");
  if (value["schema"] !== "4lpha.billing-postdeploy-evidence.v1") throw new Error("Postdeploy fixture schema drifted.");
  if (!Array.isArray(value["observations"]) || value["observations"].length !== 2) throw new Error("Postdeploy fixture needs two RPC observations.");
  const observations = value["observations"] as unknown as readonly [PostdeployRpcObservationV1, PostdeployRpcObservationV1];
  const result = validatePostdeployEvidence({ manifest, expectedInitcodeHash: String(value["expectedInitcodeHash"]) as Hex, observations });
  return Object.freeze({ schema: "4lpha.billing-postdeploy-offline-result.v1", ok: true, ...result });
}

export function canonicalOperatorResult(value: OfflineBillingPreflightResult | BillingExpiryEvidenceV1 | ReturnType<typeof validatePostdeployFixture>): string {
  return JSON.stringify(value);
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseManifestOnly(bytes: Uint8Array): BillingProductionManifestV2 {
  return parseProductionManifest(bytes);
}
