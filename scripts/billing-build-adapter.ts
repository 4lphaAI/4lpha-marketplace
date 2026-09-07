import { createHash } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { init, parse } from "es-module-lexer";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(ROOT, "src/billing/awsBillingProduction.ts");
const LOCK = resolve(ROOT, "package-lock.json");

function outputPaths(argv: readonly string[]): Readonly<{ bundle: string; source: string }> {
  const fields = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name !== "--out" && name !== "--source-out") || value === undefined ||
        value.trim() === "" || fields.has(name)) {
      throw new Error("Usage: node --import tsx scripts/billing-build-adapter.ts --out <new-file.mjs> --source-out <new-source-index.json>");
    }
    fields.set(name, value);
  }
  if (fields.size !== 2) {
    throw new Error("Usage: node --import tsx scripts/billing-build-adapter.ts --out <new-file.mjs> --source-out <new-source-index.json>");
  }
  const bundle = resolve(fields.get("--out")!);
  const source = resolve(fields.get("--source-out")!);
  if (bundle === source) throw new Error("Adapter bundle and source-index outputs must be different files.");
  return { bundle, source };
}

async function assertSelfContainedBundle(source: string): Promise<void> {
  await init;
  const [imports] = parse(source);
  for (const entry of imports) {
    if (entry.d === -2) continue; // import.meta is metadata, not a module load.
    if (entry.n?.startsWith("node:") !== true) {
      throw new Error(`Billing adapter bundle retained an external or nonliteral runtime import: ${entry.n ?? "dynamic"}.`);
    }
  }
}

async function sourceIndex(inputs: readonly string[]): Promise<Uint8Array> {
  const files: Array<Readonly<{ path: string; sha256: string; bytes: number }>> = [];
  for (const input of [...inputs].sort()) {
    const path = resolve(ROOT, input);
    const bytes = await readFile(path);
    const name = relative(ROOT, path).replaceAll("\\", "/");
    files.push(Object.freeze({
      path: name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    }));
  }
  return Buffer.from(JSON.stringify({
    schema: "4lpha.billing-adapter-source.v1",
    entry: "src/billing/awsBillingProduction.ts",
    files,
  }), "utf8");
}

async function main(): Promise<void> {
  const outputs = outputPaths(process.argv.slice(2));
  const result = await build({
    entryPoints: [ENTRY],
    absWorkingDir: ROOT,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    banner: { js: "import { createRequire as __billingCreateRequire } from 'node:module'; const require = __billingCreateRequire(import.meta.url);" },
    packages: "bundle",
    treeShaking: true,
    minifySyntax: true,
    define: { "process.env.BILLING_ADAPTER_BUILD_TARGET": '"production"' },
    minify: false,
    legalComments: "none",
    sourcemap: false,
    metafile: true,
    write: false,
    outfile: "billing-adapter.mjs",
  });
  if (result.outputFiles.length !== 1 || result.metafile === undefined) {
    throw new Error("Billing adapter build did not produce exactly one ESM artifact.");
  }
  const artifact = result.outputFiles[0];
  if (artifact === undefined) throw new Error("Billing adapter artifact is missing.");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(artifact.contents);
  await assertSelfContainedBundle(source);

  const projectInputs = Object.keys(result.metafile.inputs)
    .filter((input) => !input.replaceAll("\\", "/").includes("node_modules/"));
  const sourceBytes = await sourceIndex(projectInputs);
  const lockBytes = await readFile(LOCK);
  const metadata = JSON.stringify({
    schema: "4lpha.billing-adapter-build.v1",
    sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    lockSha256: createHash("sha256").update(lockBytes).digest("hex"),
    bundleSha256: createHash("sha256").update(artifact.contents).digest("hex"),
    bundleBytes: artifact.contents.byteLength,
  });

  let bundleCreated = false;
  let sourceCreated = false;
  try {
    const sourceHandle = await open(outputs.source, "wx", 0o600);
    sourceCreated = true;
    try { await sourceHandle.writeFile(sourceBytes); }
    finally { await sourceHandle.close(); }
    const bundleHandle = await open(outputs.bundle, "wx", 0o600);
    bundleCreated = true;
    try { await bundleHandle.writeFile(artifact.contents); }
    finally { await bundleHandle.close(); }
  } catch (error) {
    if (bundleCreated) await unlink(outputs.bundle).catch(() => undefined);
    if (sourceCreated) await unlink(outputs.source).catch(() => undefined);
    throw error;
  }
  process.stdout.write(`${metadata}\n`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Billing adapter build failed.");
  process.exitCode = 1;
});
