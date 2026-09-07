import { lstat, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyExpiryFixture } from "../src/billing/operatorCommands.js";
import { canonicalExpiryEvidence } from "../src/billing/productionOps.js";
import { acquireExpiryEvidence, createPortoPrepareOnlyDependency, parseExpiryPrepareFixture, type ExpiryPrepareOnlyDependency } from "../src/billing/productionExpiryProbe.js";

const MAX_FIXTURE_BYTES = 1024 * 1024;

function exactFlags(argv: readonly string[], offline: boolean): Readonly<{ input: string; out: string }> {
  const values: Record<string, string | true> = {};
  const allowed = new Set(["--yes-prepare-only", "--input", "--out", ...(offline ? ["--offline"] : [])]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!allowed.has(flag) || values[flag] !== undefined) throw new Error("invalid-cli-flags");
    if (flag === "--yes-prepare-only" || flag === "--offline") {
      values[flag] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("invalid-cli-flags");
    values[flag] = value;
    index += 1;
  }
  if (values["--yes-prepare-only"] !== true || (offline && values["--offline"] !== true) || typeof values["--input"] !== "string" || typeof values["--out"] !== "string") {
    throw new Error("invalid-cli-flags");
  }
  return { input: values["--input"], out: values["--out"] };
}

async function boundedInput(path: string): Promise<Uint8Array> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 0 || before.size > MAX_FIXTURE_BYTES) {
    throw new Error("Expiry input must be a bounded regular non-symlink file.");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== before.size) throw new Error("Expiry input changed while being read.");
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

export type BillingExpiryProbeDependencies = Readonly<{
  readInput(path: string): Promise<Uint8Array>;
  assertNewOutput(path: string): Promise<void>;
  writeNewOutput(path: string, bytes: Uint8Array): Promise<void>;
  createPrepareOnly(): ExpiryPrepareOnlyDependency;
  writeStderr?(value: string): void;
}>;

const REAL_DEPENDENCIES: BillingExpiryProbeDependencies = {
  readInput: boundedInput,
  assertNewOutput: assertNew,
  writeNewOutput: writeNewPrivate,
  createPrepareOnly: createPortoPrepareOnlyDependency,
};

export async function billingExpiryProbeMain(argv: readonly string[], dependencies: BillingExpiryProbeDependencies = REAL_DEPENDENCIES): Promise<number> {
  try {
    const offline = argv.includes("--offline");
    const flags = exactFlags(argv, offline);
    await dependencies.assertNewOutput(flags.out);
    const bytes = await dependencies.readInput(flags.input);
    let evidence;
    if (offline) evidence = classifyExpiryFixture(bytes);
    else {
      const fixture = parseExpiryPrepareFixture(bytes);
      const prepareOnly = dependencies.createPrepareOnly();
      try { evidence = await acquireExpiryEvidence(fixture, prepareOnly); }
      finally { await prepareOnly.close(); }
    }
    await dependencies.writeNewOutput(flags.out, new TextEncoder().encode(canonicalExpiryEvidence(evidence)));
    process.stdout.write(`${JSON.stringify({ ok: true, out: flags.out })}\n`);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error && error.message === "invalid-cli-flags"
      ? "invalid-cli-flags" : "expiry-probe-refused";
    const output = `${JSON.stringify({ error: message })}\n`;
    if (dependencies.writeStderr === undefined) process.stderr.write(output);
    else dependencies.writeStderr(output);
    return message === "invalid-cli-flags" ? 2 : 1;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = await billingExpiryProbeMain(process.argv.slice(2));
}
