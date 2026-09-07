import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { verifyRailwayDockerContext } from "../src/deployment/dockerContext.js";
import { RAILWAY_APP_PATHS } from "../src/deployment/imageInventory.js";
import { assertRailwayBasePrefix } from "../src/deployment/ociLayout.js";
import {
  AWS_SIGNING_HELPER,
  RAILWAY_BASE_MANIFEST_DIGEST,
  RAILWAY_NODE_VERSION,
  RAILWAY_PLATFORM,
} from "../src/deployment/railwayConstants.js";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const GOLDEN = resolve(ROOT, "test/fixtures/railway/synthetic-cli-expected-evidence.json");
const HOOK = resolve(ROOT, "test/support/railwaySyntheticConstantsRegister.mjs");
const SYNTHETIC_BASE_DIGEST = "sha256:b5c57f37ad1c27f879ff8a0430532ded0eb0fe451d69fcf743f902f425d646ae";
const FORGED_FALSE_BASE_LABEL = `sha256:${"ee".repeat(32)}`;
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar";

type TarEntry = Readonly<{
  path: string;
  type?: "0" | "2" | "5";
  bytes?: Buffer;
  target?: string;
  mode?: number;
  uid?: number;
  gid?: number;
}>;
type Variant =
  | "success"
  | "node-modules-symlink"
  | "bin-regular"
  | "dependency"
  | "inventory"
  | "compressed-reorder"
  | "compressed-truncate"
  | "compressed-count"
  | "diff-reorder"
  | "diff-truncate"
  | "diff-count"
  | "candidate-prefix-blob-mutation"
  | "forged-label-bad-ancestry";
type LabelMode = "absent" | "forged";
type Descriptor = Readonly<{ mediaType: string; digest: string; size: number }>;
type Fixture = Readonly<{
  baseProvenance: string;
  candidate: string;
  lockPath: string;
  imageDigest: string;
  configDigest: string;
}>;

function rawSha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digest(bytes: Uint8Array): string {
  return `sha256:${rawSha(bytes)}`;
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    octal(header, 100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : entry.type === "2" ? 0o777 : 0o444));
    octal(header, 108, 8, entry.uid ?? 0);
    octal(header, 116, 8, entry.gid ?? 0);
    const content = entry.bytes ?? Buffer.alloc(0);
    octal(header, 124, 12, content.byteLength);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.type === "2") header.write(entry.target ?? "", 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const value of header) checksum += value;
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, content, Buffer.alloc((512 - (content.byteLength % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function writeBlob(layout: string, bytes: Buffer, mediaType: string): Promise<Descriptor> {
  const selectedDigest = digest(bytes);
  await writeFile(join(layout, "blobs", "sha256", selectedDigest.slice(7)), bytes);
  return Object.freeze({ mediaType, digest: selectedDigest, size: bytes.byteLength });
}

async function writeLayout(
  layout: string,
  blobLayers: readonly Buffer[],
  manifestLayerIndexes: readonly number[],
  diffIds: readonly string[],
  config: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ manifestDigest: string; configDigest: string }>> {
  await mkdir(join(layout, "blobs", "sha256"), { recursive: true });
  const blobs: Descriptor[] = [];
  for (const bytes of blobLayers) blobs.push(await writeBlob(layout, bytes, OCI_LAYER));
  const layers = manifestLayerIndexes.map((index) => blobs[index]!);
  const configBytes = Buffer.from(JSON.stringify({ ...config, rootfs: { type: "layers", diff_ids: diffIds } }));
  const configDescriptor = await writeBlob(layout, configBytes, OCI_CONFIG);
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: configDescriptor,
    layers,
  }));
  const manifestDescriptor = await writeBlob(layout, manifestBytes, OCI_MANIFEST);
  await writeFile(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [manifestDescriptor] }));
  return Object.freeze({ manifestDigest: manifestDescriptor.digest, configDigest: configDescriptor.digest });
}

function baseMaterial(): Readonly<{
  entries: readonly TarEntry[];
  layers: readonly Buffer[];
  descriptors: readonly Descriptor[];
  diffIds: readonly string[];
  configBytes: Buffer;
  manifestBytes: Buffer;
}> {
  const entries = Object.freeze([
    Object.freeze({ path: "base-one.txt", bytes: Buffer.from("synthetic-trusted-base-one\n"), mode: 0o444 }),
    Object.freeze({ path: "base-two.txt", bytes: Buffer.from("synthetic-trusted-base-two\n"), mode: 0o444 }),
  ]);
  const layers = Object.freeze(entries.map((entry) => tar([entry])));
  const descriptors = Object.freeze(layers.map((bytes) => Object.freeze({
    mediaType: OCI_LAYER,
    digest: digest(bytes),
    size: bytes.byteLength,
  })));
  const diffIds = Object.freeze(layers.map(digest));
  const configBytes = Buffer.from(JSON.stringify({
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: diffIds },
  }));
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: { mediaType: OCI_CONFIG, digest: digest(configBytes), size: configBytes.byteLength },
    layers: descriptors,
  }));
  assert.equal(digest(manifestBytes), SYNTHETIC_BASE_DIGEST,
    "the structural fixture must remain bound to the hook's literal base identity");
  return Object.freeze({ entries, layers, descriptors, diffIds, configBytes, manifestBytes });
}

async function fixture(root: string, variant: Variant, labels: LabelMode = "absent"): Promise<Fixture> {
  const base = baseMaterial();
  const baseProvenance = join(root, "base-provenance");
  await mkdir(baseProvenance, { recursive: true });
  await writeFile(join(baseProvenance, "manifest.json"), base.manifestBytes);
  await writeFile(join(baseProvenance, "config.json"), base.configBytes);

  const packageBytes = Buffer.from('{"name":"synthetic-railway-cli","version":"1.0.0"}\n');
  const lockBytes = Buffer.from('{"name":"synthetic-railway-cli","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"synthetic-railway-cli","version":"1.0.0"}}}\n');
  const lockPath = join(root, "package-lock.json");
  await writeFile(lockPath, lockBytes);
  const appBytes = new Map<string, Buffer>();
  appBytes.set("package.json", packageBytes);
  for (const path of RAILWAY_APP_PATHS) {
    if (path === "package.json" || path === "artifacts/app-inventory.json") continue;
    appBytes.set(path, Buffer.from(`// synthetic fixture ${path}\nexport {};\n`));
  }
  const application = RAILWAY_APP_PATHS
    .filter((path) => path !== "artifacts/app-inventory.json")
    .map((path) => {
      const bytes = appBytes.get(path)!;
      return Object.freeze({ kind: "file" as const, path, bytes: bytes.byteLength, sha256: rawSha(bytes) });
    });
  const inventory = {
    schema: "4lpha.railway-app-inventory.v1",
    lockSha256: rawSha(lockBytes),
    application,
    packages: [],
    dependencyFiles: [],
  };
  const inventoryBytes = variant === "inventory"
    ? Buffer.from(`${JSON.stringify({ ...inventory, lockSha256: "0".repeat(64) })}\n`)
    : Buffer.from(`${JSON.stringify(inventory)}\n`);
  appBytes.set("artifacts/app-inventory.json", inventoryBytes);

  const helperBytes = Buffer.from("synthetic-helper-identity\n");
  assert.equal(helperBytes.byteLength, 26);
  assert.equal(rawSha(helperBytes), "733f620a7292ac98a7207538531ad8bd50e078fdbceea24fdbd0f293bae7e045");
  const suffixEntries: TarEntry[] = [
    { path: "app", type: "5", mode: 0o755 },
    { path: "app/dist", type: "5", mode: 0o755 },
    { path: "app/dist/railway", type: "5", mode: 0o755 },
    { path: "app/artifacts", type: "5", mode: 0o755 },
    { path: "run/4lpha", type: "5", mode: 0o700, uid: 10_001, gid: 10_001 },
    { path: "usr/local/bin/railway-launcher", bytes: Buffer.from("synthetic-launcher-identity\n"), mode: 0o555 },
    { path: "usr/local/bin/aws_signing_helper", bytes: helperBytes, mode: 0o555 },
  ];
  if (variant === "node-modules-symlink") {
    suffixEntries.push(
      { path: "app/real-node-modules", type: "5", mode: 0o755 },
      { path: "app/node_modules", type: "2", target: "real-node-modules", mode: 0o555 },
    );
  } else {
    suffixEntries.push({ path: "app/node_modules", type: "5", mode: 0o755 });
  }
  if (variant === "bin-regular") {
    suffixEntries.push(
      { path: "app/node_modules/.bin", type: "5", mode: 0o755 },
      { path: "app/node_modules/.bin/evil", bytes: Buffer.from("evil\n"), mode: 0o555 },
    );
  }
  if (variant === "dependency") {
    suffixEntries.push(
      { path: "app/node_modules/evil", type: "5", mode: 0o755 },
      { path: "app/node_modules/evil/package.json", bytes: Buffer.from('{"name":"evil","version":"1.0.0"}\n'), mode: 0o444 },
    );
  }
  for (const path of RAILWAY_APP_PATHS) {
    suffixEntries.push({ path: `app/${path}`, bytes: appBytes.get(path)!, mode: 0o444 });
  }
  const suffixLayer = tar(suffixEntries);
  const suffixDiff = digest(suffixLayer);
  const blobLayers = [...base.layers, suffixLayer];
  let manifestLayerIndexes: readonly number[] = [0, 1, 2];
  let diffIds: readonly string[] = [...base.diffIds, suffixDiff];
  if (variant === "compressed-reorder") {
    manifestLayerIndexes = [1, 0, 2];
    diffIds = [base.diffIds[1]!, base.diffIds[0]!, suffixDiff];
  } else if (variant === "compressed-truncate") {
    manifestLayerIndexes = [0];
    diffIds = [base.diffIds[0]!];
  } else if (variant === "compressed-count") {
    manifestLayerIndexes = [0, 1];
    diffIds = [...base.diffIds];
  } else if (variant === "diff-reorder") {
    diffIds = [base.diffIds[1]!, base.diffIds[0]!, suffixDiff];
  } else if (variant === "diff-truncate") {
    diffIds = [...base.diffIds];
  } else if (variant === "diff-count") {
    diffIds = [...base.diffIds, suffixDiff, suffixDiff];
  } else if (variant === "forged-label-bad-ancestry") {
    manifestLayerIndexes = [2, 1, 2];
    diffIds = [suffixDiff, base.diffIds[1]!, suffixDiff];
  }
  const runtimeConfig: Record<string, unknown> = {
    Env: ["NODE_VERSION=22.23.2", "NODE_ENV=production"],
    WorkingDir: "/app",
    User: "10001:10001",
    Entrypoint: ["/usr/local/bin/railway-launcher"],
    Cmd: ["api"],
  };
  if (variant === "forged-label-bad-ancestry") {
    runtimeConfig["Labels"] = { "org.4lpha.base-manifest-digest": SYNTHETIC_BASE_DIGEST };
  } else if (labels === "forged") {
    runtimeConfig["Labels"] = { "org.4lpha.base-manifest-digest": FORGED_FALSE_BASE_LABEL };
  }
  const candidate = join(root, "candidate");
  const identity = await writeLayout(candidate, blobLayers, manifestLayerIndexes, diffIds, {
    architecture: "amd64",
    os: "linux",
    config: runtimeConfig,
  });
  if (variant === "candidate-prefix-blob-mutation") {
    await writeFile(join(candidate, "blobs", "sha256", base.descriptors[0]!.digest.slice(7)),
      Buffer.from("mutated-candidate-prefix-layer\n"));
  }
  return Object.freeze({
    baseProvenance,
    candidate,
    lockPath,
    imageDigest: identity.manifestDigest,
    configDigest: identity.configDigest,
  });
}

async function invokeCli(value: Fixture, output: string, marker: string): Promise<Readonly<{
  stdout: string;
  evidence: Buffer;
}>> {
  const result = await run(process.execPath, [
    "--import", "tsx",
    "--import", pathToFileURL(HOOK).href,
    resolve(ROOT, "scripts/railway-inspect-image.ts"),
    "--base-provenance", value.baseProvenance,
    "--oci-layout", value.candidate,
    "--lock", value.lockPath,
    "--marker-env", "SYNTHETIC_RELEASE_MARKER",
    "--out", output,
  ], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, SYNTHETIC_RELEASE_MARKER: marker },
  });
  return Object.freeze({ stdout: result.stdout, evidence: await readFile(output) });
}

async function expectCliRefusal(name: string, variant: Variant, expected: RegExp, marker = "absent-release-marker"): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), `railway-cli-${name}-`));
  try {
    const value = await fixture(join(temporary, "fixture"), variant);
    const output = join(temporary, "refused.json");
    await assert.rejects(invokeCli(value, output, marker), expected);
    assert.equal(await lstat(output).then(() => true, () => false), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function withoutCandidateIdentity(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { imageDigest: _imageDigest, configDigest: _configDigest, ...rest } = value;
  return rest;
}

test("production OCI CLI succeeds deterministically and byte-matches the checked-in v2 evidence", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-production-cli-success-"));
  try {
    const value = await fixture(join(temporary, "fixture"), "success");
    const output = join(temporary, "evidence.json");
    const result = await invokeCli(value, output, "absent-release-marker");
    const golden = await readFile(GOLDEN);
    assert.deepEqual(result.evidence, golden);
    const expected = JSON.parse(golden.toString("utf8")) as Readonly<Record<string, unknown>>;
    assert.deepEqual(JSON.parse(result.stdout) as unknown, {
      schema: "4lpha.railway-oci-evidence.v2",
      imageDigest: expected["imageDigest"],
    });
    assert.equal(golden.at(-1), 0x0a);
    const schemaMutant = Buffer.from(golden.toString("utf8").replace(
      "4lpha.railway-oci-evidence.v2", "4lpha.railway-oci-evidence.v1"));
    const orderMutant = Buffer.from(`${JSON.stringify({ helper: expected["helper"], ...expected })}\n`);
    assert.notDeepEqual(result.evidence, schemaMutant);
    assert.notDeepEqual(result.evidence, orderMutant);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("checked-in v2 evidence refuses schema and exact key-order mutants", async () => {
  const golden = await readFile(GOLDEN);
  const parsed = JSON.parse(golden.toString("utf8")) as Readonly<Record<string, unknown>>;
  const schemaMutant = Buffer.from(golden.toString("utf8").replace(
    "4lpha.railway-oci-evidence.v2", "4lpha.railway-oci-evidence.v1"));
  const orderMutant = Buffer.from(`${JSON.stringify({ helper: parsed["helper"], ...parsed })}\n`);
  assert.notDeepEqual(golden, schemaMutant);
  assert.notDeepEqual(golden, orderMutant);
});

test("actual production CLI input mutants reach their named ancestry and filesystem gates", async (t) => {
  const cases: readonly Readonly<{ name: string; variant: Variant; expected: RegExp; marker?: string }>[] = [
    { name: "compressed descriptor prefix reorder", variant: "compressed-reorder", expected: /candidate base-layer prefix refused/u },
    { name: "compressed descriptor prefix truncate", variant: "compressed-truncate", expected: /base-layer prefix census refused/u },
    { name: "compressed descriptor prefix wrong count", variant: "compressed-count", expected: /base-layer prefix census refused/u },
    { name: "diff-ID prefix reorder", variant: "diff-reorder", expected: /OCI layer diff ID refused/u },
    { name: "diff-ID prefix truncate", variant: "diff-truncate", expected: /OCI rootfs diff-ID census refused/u },
    { name: "diff-ID prefix wrong count", variant: "diff-count", expected: /OCI rootfs diff-ID census refused/u },
    { name: "candidate prefix-layer blob mutation", variant: "candidate-prefix-blob-mutation", expected: /OCI blob digest or size refused/u },
    { name: "release marker", variant: "success", marker: "synthetic fixture dist/railway/api.mjs", expected: /Release marker found/u },
    { name: "node_modules symlink", variant: "node-modules-symlink", expected: /node_modules must be a real directory/u },
    { name: "regular .bin entry", variant: "bin-regular", expected: /permits only npm \.bin symlinks/u },
    { name: "undeclared dependency", variant: "dependency", expected: /absent from production lock closure/u },
    { name: "inventory drift", variant: "inventory", expected: /inventory differs from the final filesystem/u },
    { name: "forged expected label cannot rescue bad ancestry", variant: "forged-label-bad-ancestry", expected: /candidate base-layer prefix refused/u },
  ];
  for (const selected of cases) {
    await t.test(selected.name, () => expectCliRefusal(
      selected.name.replaceAll(" ", "-"), selected.variant, selected.expected, selected.marker));
  }
});

test("direct prefix comparator isolates compressed descriptor reorder, truncate and wrong count", () => {
  const base = baseMaterial();
  const provenance = {
    manifestDigest: SYNTHETIC_BASE_DIGEST,
    configDigest: digest(base.configBytes),
    layerDescriptors: base.descriptors,
    diffIds: base.diffIds,
  };
  const suffix = Object.freeze({ mediaType: OCI_LAYER, digest: `sha256:${"aa".repeat(32)}`, size: 1 });
  const extra = Object.freeze({ mediaType: OCI_LAYER, digest: `sha256:${"cc".repeat(32)}`, size: 2 });
  const validDiffIds = [...base.diffIds, `sha256:${"bb".repeat(32)}`];
  assert.throws(() => assertRailwayBasePrefix(provenance, {
    layerDescriptors: [base.descriptors[1]!, base.descriptors[0]!, suffix],
    diffIds: validDiffIds,
  }), /base-layer prefix refused/u, "compressed descriptor reorder must be independently visible");
  assert.throws(() => assertRailwayBasePrefix(provenance, {
    layerDescriptors: [...base.descriptors],
    diffIds: validDiffIds,
  }), /base-layer prefix census refused/u, "compressed descriptor truncate must be independently visible");
  assert.throws(() => assertRailwayBasePrefix(provenance, {
    layerDescriptors: [...base.descriptors, suffix, extra],
    diffIds: validDiffIds,
  }), /base-layer prefix census refused/u, "compressed descriptor wrong count must be independently visible");
});

test("direct prefix comparator isolates diff-ID reorder, truncate and wrong count", () => {
  const base = baseMaterial();
  const provenance = {
    manifestDigest: SYNTHETIC_BASE_DIGEST,
    configDigest: digest(base.configBytes),
    layerDescriptors: base.descriptors,
    diffIds: base.diffIds,
  };
  const suffix = Object.freeze({ mediaType: OCI_LAYER, digest: `sha256:${"aa".repeat(32)}`, size: 1 });
  assert.throws(() => assertRailwayBasePrefix(provenance, {
    layerDescriptors: [...base.descriptors, suffix],
    diffIds: [base.diffIds[1]!, base.diffIds[0]!, `sha256:${"bb".repeat(32)}`],
  }), /base-layer prefix refused/u, "diff-ID reorder must be independently visible");
  assert.throws(() => assertRailwayBasePrefix(provenance, {
    layerDescriptors: [...base.descriptors, suffix],
    diffIds: [...base.diffIds],
  }), /base-layer prefix census refused/u, "diff-ID truncate must be independently visible");
  assert.throws(() => assertRailwayBasePrefix(provenance, {
    layerDescriptors: [...base.descriptors, suffix],
    diffIds: [...base.diffIds, `sha256:${"bb".repeat(32)}`, `sha256:${"cc".repeat(32)}`],
  }), /base-layer prefix census refused/u, "diff-ID wrong count must be independently visible");
});

test("absent and forged candidate labels have zero authority over accepted evidence", async () => {
  assert.notEqual(FORGED_FALSE_BASE_LABEL, SYNTHETIC_BASE_DIGEST);
  const temporary = await mkdtemp(join(tmpdir(), "railway-cli-labels-"));
  try {
    const absent = await fixture(join(temporary, "absent"), "success", "absent");
    const forged = await fixture(join(temporary, "forged"), "success", "forged");
    const absentResult = await invokeCli(absent, join(temporary, "absent.json"), "absent-release-marker");
    const forgedResult = await invokeCli(forged, join(temporary, "forged.json"), "absent-release-marker");
    const absentEvidence = JSON.parse(absentResult.evidence.toString("utf8")) as Readonly<Record<string, unknown>>;
    const forgedEvidence = JSON.parse(forgedResult.evidence.toString("utf8")) as Readonly<Record<string, unknown>>;
    assert.deepEqual(withoutCandidateIdentity(absentEvidence), withoutCandidateIdentity(forgedEvidence));
    assert.notEqual(absentEvidence["configDigest"], forgedEvidence["configDigest"]);
    assert.notEqual(absentEvidence["imageDigest"], forgedEvidence["imageDigest"]);
    assert.equal(absentEvidence["configDigest"], absent.configDigest);
    assert.equal(absentEvidence["imageDigest"], absent.imageDigest);
    assert.equal(forgedEvidence["configDigest"], forged.configDigest);
    assert.equal(forgedEvidence["imageDigest"], forged.imageDigest);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("synthetic trust hook is literal, test-only, unshipped and unreachable from production", async () => {
  const hookSource = await readFile(HOOK, "utf8");
  assert.match(hookSource, new RegExp(SYNTHETIC_BASE_DIGEST, "u"));
  assert.match(hookSource, /bytes: 26/u);
  assert.match(hookSource, /733f620a7292ac98a7207538531ad8bd50e078fdbceea24fdbd0f293bae7e045/u);
  assert.doesNotMatch(hookSource, /process\.(?:env|argv)|readFile|JSON\.parse/u);

  const productionPaths = [
    "scripts/railway-inspect-image.ts",
    "scripts/railway-build-role-bundles.ts",
    "scripts/railway-build-app-inventory.ts",
    "src/deployment/ociLayout.ts",
    "src/deployment/ociEvidence.ts",
    "src/deployment/imageInventory.ts",
    "src/deployment/dockerContext.ts",
    "Dockerfile",
    ".dockerignore",
    "package.json",
  ];
  const productionSource = (await Promise.all(productionPaths.map((path) => readFile(resolve(ROOT, path), "utf8")))).join("\n");
  assert.doesNotMatch(productionSource, /railwaySyntheticConstantsRegister|RAILWAY_SYNTHETIC_CONSTANTS_JSON|b5c57f37ad1c27f879ff8a0430532ded/u);
  const context = await verifyRailwayDockerContext(ROOT);
  assert.equal(context.some((path) => path.startsWith("test/") || path.includes("railwaySynthetic")), false);
  assert.equal(RAILWAY_APP_PATHS.some((path) => path.startsWith("test/") || path.includes("railwaySynthetic")), false);
  const packageJson = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as Readonly<Record<string, unknown>>;
  const scripts = packageJson["scripts"] as Readonly<Record<string, unknown>>;
  assert.equal(Object.values(scripts).some((value) => typeof value === "string" && /railwaySynthetic|RAILWAY_SYNTHETIC/u.test(value)), false);

  assert.equal(RAILWAY_NODE_VERSION, "22.23.2");
  assert.equal(RAILWAY_PLATFORM, "linux/amd64");
  assert.equal(RAILWAY_BASE_MANIFEST_DIGEST,
    "sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96");
  assert.deepEqual(AWS_SIGNING_HELPER, {
    version: "1.8.4",
    path: "/usr/local/bin/aws_signing_helper",
    url: "https://rolesanywhere.amazonaws.com/releases/1.8.4/X86_64/Linux/Amzn2023/aws_signing_helper",
    bytes: 12_094_568,
    sha256: "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9",
  });
});
