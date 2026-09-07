import { lstat, open, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalOperatorResult, runOfflinePreflightCommand, runOfflinePreflightCommandDetailed, type LocalFileStat, type LocalReadDeps } from "../src/billing/operatorCommands.js";
import { acquireReadOnlyPreflight, createPinnedReadOnlyRpcClient, type ReadOnlyRpcClient } from "../src/billing/productionAcquisition.js";
import { PostgresBillingSessionGenerationRepository } from "../src/billing/sessionGenerations.js";
import { createPgSqlClient } from "../src/store/sql.js";

function localStat(path: string): Promise<LocalFileStat> {
  return lstat(path).then((value) => ({
    isFile: value.isFile(),
    isSymbolicLink: value.isSymbolicLink(),
    mode: value.mode,
    size: value.size,
  }));
}

const execFileAsync = promisify(execFile);
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${name} has unknown or missing fields.`);
  }
}

/** Fail closed unless the current Windows identity exclusively shares access with SYSTEM/Administrators. */
export function validateWindowsPrivateAclEvidence(value: unknown): void {
  const root = record(value, "Windows ACL evidence");
  exactKeys(root, ["ownerSid", "currentSid", "areAccessRulesProtected", "access"], "Windows ACL evidence");
  if (typeof root["ownerSid"] !== "string" || typeof root["currentSid"] !== "string" ||
      root["ownerSid"] !== root["currentSid"] || root["areAccessRulesProtected"] !== true ||
      !Array.isArray(root["access"]) || root["access"].length < 1 || root["access"].length > 32) {
    throw new Error("Windows credential-file ACL is not private.");
  }
  const allowed = new Set([root["currentSid"], WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID]);
  let currentAllowed = false;
  for (const raw of root["access"]) {
    const ace = record(raw, "Windows ACL entry");
    exactKeys(ace, ["sid", "type"], "Windows ACL entry");
    if (typeof ace["sid"] !== "string" || (ace["type"] !== "Allow" && ace["type"] !== "Deny")) {
      throw new Error("Windows credential-file ACL is malformed.");
    }
    if (ace["type"] === "Allow") {
      if (!allowed.has(ace["sid"])) throw new Error("Windows credential-file ACL grants another principal access.");
      if (ace["sid"] === root["currentSid"]) currentAllowed = true;
    }
  }
  if (!currentAllowed) throw new Error("Windows credential-file ACL does not grant the current identity access.");
}

async function assertWindowsPrivateAcl(path: string): Promise<void> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$acl=Get-Acl -LiteralPath $args[0]",
    "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$owner=$acl.Owner",
    "try{$owner=(New-Object System.Security.Principal.NTAccount($owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}",
    "$access=@($acl.Access|ForEach-Object{[PSCustomObject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;type=$_.AccessControlType.ToString()}})",
    "[PSCustomObject]@{ownerSid=$owner;currentSid=$current;areAccessRulesProtected=$acl.AreAccessRulesProtected;access=$access}|ConvertTo-Json -Compress -Depth 4",
  ].join(";");
  const { stdout } = await execFileAsync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, path],
    { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 },
  );
  let evidence: unknown;
  try { evidence = JSON.parse(stdout); }
  catch { throw new Error("Windows credential-file ACL could not be verified."); }
  validateWindowsPrivateAclEvidence(evidence);
}

export type BillingEnablePreflightDependencies = Readonly<{
  files: LocalReadDeps;
  now(): number;
  createRpcClient(origins: readonly string[]): Promise<ReadOnlyRpcClient>;
  readExposure(databaseUrlFile: string, input: Readonly<{ migrationVersion: string; x402Authorizer: string }>): Promise<bigint>;
  assertNewOutput(path: string): Promise<void>;
  writeNewOutput(path: string, bytes: Uint8Array): Promise<void>;
}>;

function readOnlyFlags(argv: readonly string[]): Readonly<{ manifest: string; bundle: string; source: string; lock: string; databaseUrlFile: string; out: string }> {
  const values: Record<string, string | true> = {};
  const allowed = new Set(["--read-only", "--yes-read-only", "--manifest", "--bundle", "--source", "--lock", "--database-url-file", "--out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!allowed.has(flag) || values[flag] !== undefined) throw new Error("invalid-cli-flags");
    if (flag === "--read-only" || flag === "--yes-read-only") { values[flag] = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("invalid-cli-flags");
    values[flag] = value;
    index += 1;
  }
  if (values["--read-only"] !== true || values["--yes-read-only"] !== true ||
      typeof values["--manifest"] !== "string" || typeof values["--bundle"] !== "string" ||
      typeof values["--source"] !== "string" || typeof values["--lock"] !== "string" ||
      typeof values["--database-url-file"] !== "string" ||
      typeof values["--out"] !== "string") throw new Error("invalid-cli-flags");
  return { manifest: values["--manifest"], bundle: values["--bundle"], source: values["--source"], lock: values["--lock"],
    databaseUrlFile: values["--database-url-file"], out: values["--out"] };
}

async function newOutput(path: string): Promise<void> {
  try { await lstat(path); throw new Error("Output path already exists."); }
  catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function writeNew(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function readExposureFromPostgres(databaseUrlFile: string, input: Readonly<{
  migrationVersion: string;
  x402Authorizer: string;
}>): Promise<bigint> {
  const info = await localStat(databaseUrlFile);
  if (!info.isFile || info.isSymbolicLink || info.size < 1 || info.size > 8_192 ||
      (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
    throw new Error("Database URL file is not a bounded private regular file.");
  }
  if (process.platform === "win32") await assertWindowsPrivateAcl(databaseUrlFile);
  const bytes = await readFile(databaseUrlFile);
  if (bytes.byteLength !== info.size) throw new Error("Database URL file changed while being read.");
  let databaseUrl: string;
  try { databaseUrl = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Database URL file is not UTF-8."); }
  if (databaseUrl.trim() !== databaseUrl || databaseUrl.length > 8_192 ||
      (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://"))) {
    throw new Error("Database URL file is malformed.");
  }
  const sql = await createPgSqlClient(databaseUrl);
  try {
    const snapshot = await PostgresBillingSessionGenerationRepository.attach(sql).readOnlyEnablementExposure(input);
    return snapshot.liveUsdcExposureAtomic;
  } finally { await sql.close(); }
}

const REAL_DEPENDENCIES: BillingEnablePreflightDependencies = {
  files: { readFile, stat: localStat, platform: process.platform },
  now: () => Math.floor(Date.now() / 1_000),
  createRpcClient: createPinnedReadOnlyRpcClient,
  readExposure: readExposureFromPostgres,
  assertNewOutput: newOutput,
  writeNewOutput: writeNew,
};

export async function billingEnablePreflightMain(argv: readonly string[], dependencies: BillingEnablePreflightDependencies = REAL_DEPENDENCIES): Promise<number> {
  try {
    if (!argv.includes("--read-only")) {
      const report = await runOfflinePreflightCommand(argv, dependencies.files);
      process.stdout.write(`${canonicalOperatorResult(report)}\n`);
      return 0;
    }
    const flags = readOnlyFlags(argv);
    await dependencies.assertNewOutput(flags.out);
    const checked = await runOfflinePreflightCommandDetailed([
      "--offline", "--manifest", flags.manifest, "--bundle", flags.bundle, "--source", flags.source, "--lock", flags.lock,
    ], dependencies.files);
    const exposure = await dependencies.readExposure(flags.databaseUrlFile, {
      migrationVersion: checked.manifest.postgres.migrationVersion,
      x402Authorizer: checked.manifest.providers.x402Authorizer,
    });
    const origins = [...checked.manifest.networks.bsc.origins, ...checked.manifest.networks.base.origins, ...checked.manifest.networks.arbitrum.origins];
    const client = await dependencies.createRpcClient(origins);
    let report;
    try {
      report = await acquireReadOnlyPreflight({ client, manifest: checked.manifest, now: dependencies.now(),
        liveUsdcExposureAtomic: exposure.toString(), manifestSha256: checked.report.manifestSha256,
        bundleSha256: checked.report.bundleSha256 });
    } finally { await client.close(); }
    await dependencies.writeNewOutput(flags.out, new TextEncoder().encode(JSON.stringify(report)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "offline-preflight-refused";
    const publicMessage = argv.includes("--read-only") && message !== "invalid-cli-flags" ? "read-only-preflight-refused" : message;
    process.stderr.write(`${JSON.stringify({ error: publicMessage })}\n`);
    return message === "invalid-cli-flags" ? 2 : 1;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = await billingEnablePreflightMain(process.argv.slice(2));
}
