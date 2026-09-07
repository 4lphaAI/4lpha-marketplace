import { lstat, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bytesToHex, keccak256 } from "viem";
import { canonicalOperatorResult, validatePostdeployFixture } from "../src/billing/operatorCommands.js";
import { acquirePostdeployPair, createPinnedReadOnlyRpcClient, type ReadOnlyRpcClient } from "../src/billing/productionAcquisition.js";
import { parseProductionManifest } from "../src/billing/productionManifest.js";
import { validatePostdeployEvidence } from "../src/billing/productionEvidence.js";

const MAX_FIXTURE_BYTES = 64 * 1024 * 1024;

function offlineFlags(argv: readonly string[]): Readonly<{ manifest: string; evidence: string; out: string }> {
  const values: Record<string, string | true> = {};
  const allowed = new Set(["--offline", "--yes-read-only", "--manifest", "--evidence", "--out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!allowed.has(flag) || values[flag] !== undefined) throw new Error("invalid-cli-flags");
    if (flag === "--offline" || flag === "--yes-read-only") {
      values[flag] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("invalid-cli-flags");
    values[flag] = value;
    index += 1;
  }
  if (
    values["--offline"] !== true || values["--yes-read-only"] !== true ||
    typeof values["--manifest"] !== "string" || typeof values["--evidence"] !== "string" ||
    typeof values["--out"] !== "string"
  ) throw new Error("invalid-cli-flags");
  return { manifest: values["--manifest"], evidence: values["--evidence"], out: values["--out"] };
}

function readOnlyFlags(argv: readonly string[]): Readonly<{ manifest: string; initcode: string; out: string }> {
  const values: Record<string, string | true> = {};
  const allowed = new Set(["--yes-read-only", "--manifest", "--initcode", "--out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!allowed.has(flag) || values[flag] !== undefined) throw new Error("invalid-cli-flags");
    if (flag === "--yes-read-only") { values[flag] = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("invalid-cli-flags");
    values[flag] = value;
    index += 1;
  }
  if (values["--yes-read-only"] !== true || typeof values["--manifest"] !== "string" ||
      typeof values["--initcode"] !== "string" || typeof values["--out"] !== "string") throw new Error("invalid-cli-flags");
  return { manifest: values["--manifest"], initcode: values["--initcode"], out: values["--out"] };
}

async function boundedInput(path: string): Promise<Uint8Array> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 0 || before.size > MAX_FIXTURE_BYTES) {
    throw new Error("Postdeploy input must be a bounded regular non-symlink file.");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== before.size) throw new Error("Postdeploy input changed while being read.");
  return bytes;
}

async function writeNewPrivate(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertNew(path: string): Promise<void> {
  try { await lstat(path); throw new Error("Output path already exists."); }
  catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export type BillingPostdeployDependencies = Readonly<{
  now(): number;
  createRpcClient(origins: readonly string[]): Promise<ReadOnlyRpcClient>;
  readInput(path: string): Promise<Uint8Array>;
  assertNewOutput(path: string): Promise<void>;
  writeNewOutput(path: string, bytes: Uint8Array): Promise<void>;
}>;

const REAL_DEPENDENCIES: BillingPostdeployDependencies = {
  now: () => Math.floor(Date.now() / 1_000),
  createRpcClient: createPinnedReadOnlyRpcClient,
  readInput: boundedInput,
  assertNewOutput: assertNew,
  writeNewOutput: writeNewPrivate,
};

export async function billingPostdeployVerifyMain(argv: readonly string[], dependencies: BillingPostdeployDependencies = REAL_DEPENDENCIES): Promise<number> {
  try {
    if (argv.includes("--offline")) {
      const flags = offlineFlags(argv);
      await dependencies.assertNewOutput(flags.out);
      const [manifestBytes, evidenceBytes] = await Promise.all([dependencies.readInput(flags.manifest), dependencies.readInput(flags.evidence)]);
      const result = validatePostdeployFixture({ manifestBytes, evidenceBytes });
      await dependencies.writeNewOutput(flags.out, new TextEncoder().encode(canonicalOperatorResult(result)));
      process.stdout.write(`${JSON.stringify({ ok: true, out: flags.out })}\n`);
      return 0;
    }
    const flags = readOnlyFlags(argv);
    await dependencies.assertNewOutput(flags.out);
    const [manifestBytes, initcodeBytes] = await Promise.all([dependencies.readInput(flags.manifest), dependencies.readInput(flags.initcode)]);
    const manifest = parseProductionManifest(manifestBytes);
    const expectedInitcodeHash = keccak256(bytesToHex(initcodeBytes));
    const client = await dependencies.createRpcClient(manifest.networks.bsc.origins);
    let observations;
    try { observations = await acquirePostdeployPair({ client, manifest, expectedInitcodeHash, now: dependencies.now() }); }
    finally { await client.close(); }
    const result = validatePostdeployEvidence({ manifest, expectedInitcodeHash, observations });
    const output = Object.freeze({ schema: "4lpha.billing-postdeploy-read-only-result.v1", expectedInitcodeHash, observations, result });
    await dependencies.writeNewOutput(flags.out, new TextEncoder().encode(JSON.stringify(output)));
    process.stdout.write(`${JSON.stringify({ ok: true, out: flags.out })}\n`);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "postdeploy-validation-refused";
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    return message === "invalid-cli-flags" ? 2 : 1;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = await billingPostdeployVerifyMain(process.argv.slice(2));
}
