import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { init, parse } from "es-module-lexer";
import test from "node:test";
import { canonicalProductionManifest } from "../src/billing/productionManifest.js";
import { validateOfflineBillingPreflight } from "../src/billing/productionPreflight.js";
import { GOLDEN_PRODUCTION_MANIFEST_V2 } from "./fixtures/billing/productionManifestV2.js";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(ROOT, "scripts/billing-build-adapter.ts");

async function build(out: string, sourceOut: string): Promise<Readonly<Record<string, unknown>>> {
  const result = await run(process.execPath, ["--import", "tsx", SCRIPT,
    "--out", out, "--source-out", sourceOut], {
    cwd: ROOT,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout.trim()) as Readonly<Record<string, unknown>>;
}

test("production adapter builder emits one deterministic self-contained ESM artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "billing-adapter-bundle-"));
  const firstPath = join(root, "first.mjs");
  const secondPath = join(root, "second.mjs");
  const firstSourcePath = join(root, "first-source.json");
  const secondSourcePath = join(root, "second-source.json");
  try {
    const [firstMeta, secondMeta] = await Promise.all([
      build(firstPath, firstSourcePath), build(secondPath, secondSourcePath),
    ]);
    const [first, second, firstSource, secondSource] = await Promise.all([
      readFile(firstPath), readFile(secondPath), readFile(firstSourcePath), readFile(secondSourcePath),
    ]);
    assert.deepEqual(first, second);
    assert.deepEqual(firstSource, secondSource);
    const digest = createHash("sha256").update(first).digest("hex");
    assert.equal(firstMeta["bundleSha256"], digest);
    assert.equal(secondMeta["bundleSha256"], digest);
    assert.equal(firstMeta["bundleBytes"], first.byteLength);
    assert.equal(firstMeta["sourceSha256"], createHash("sha256").update(firstSource).digest("hex"));

    const lock = await readFile(resolve(ROOT, "package-lock.json"));
    const manifestValue = JSON.parse(GOLDEN_PRODUCTION_MANIFEST_V2) as Record<string, unknown>;
    manifestValue["sourceSha256"] = firstMeta["sourceSha256"];
    manifestValue["lockSha256"] = createHash("sha256").update(lock).digest("hex");
    manifestValue["bundleSha256"] = digest;
    const manifest = Buffer.from(canonicalProductionManifest(manifestValue), "utf8");
    assert.equal(validateOfflineBillingPreflight({
      manifestBytes: manifest,
      bundleBytes: first,
      sourceBytes: firstSource,
      lockBytes: lock,
      manifestPermissions: "verified-owner-only",
    }).report.sourceSha256, firstMeta["sourceSha256"]);

    await init;
    const [imports] = parse(first.toString("utf8"));
    assert.ok(imports.every((entry) => entry.d === -2 || entry.n?.startsWith("node:") === true));
    const loaded = await import(pathToFileURL(firstPath).href) as Readonly<Record<string, unknown>>;
    assert.deepEqual(Object.keys(loaded), ["createBillingCustodyAndRelayPrimitives", "readBillingSessionKmsIdentity"]);
    const artifactSource = first.toString("utf8");
    assert.equal(artifactSource.includes("credentialDependencies"), false);
    assert.equal(artifactSource.includes("input.dependencies"), false);
    assert.equal(artifactSource.includes("BILLING_ADAPTER_BUILD_TARGET"), false);

    await assert.rejects(build(firstPath, join(root, "refused-source.json")), /EEXIST|file already exists/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
