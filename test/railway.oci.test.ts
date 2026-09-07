import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { inspectRailwayOciLayout } from "../src/deployment/ociEvidence.js";
import {
  assertRailwayBasePrefix,
  materializeRailwayOciLayout,
  verifyRailwayBaseProvenance,
} from "../src/deployment/ociLayout.js";
import { RAILWAY_BASE_MANIFEST_DIGEST } from "../src/deployment/railwayConstants.js";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const BASE_PROVENANCE_FIXTURE = resolve(
  ROOT,
  "test/fixtures/railway/node-22.23.2-bookworm-slim-amd64",
);
const BASE_CONFIG_DIGEST = "sha256:6e6261159fd399ebe5a3d556b7d89da9c85c873f3f270918aad6c8107da8b411";

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tar(entries: readonly Readonly<{ path: string; bytes?: Buffer; type?: "0" | "5" } >[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    octal(header, 100, 8, entry.type === "5" ? 0o755 : 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    const content = entry.bytes ?? Buffer.alloc(0);
    octal(header, 124, 12, content.byteLength);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
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

async function writeBlob(layout: string, bytes: Buffer): Promise<Readonly<{ mediaType: string; digest: string; size: number }>> {
  const selectedDigest = digest(bytes);
  await writeFile(join(layout, "blobs", "sha256", selectedDigest.slice(7)), bytes);
  return { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: selectedDigest, size: bytes.byteLength };
}

async function ociFixture(root: string): Promise<string> {
  const layout = join(root, "oci");
  await mkdir(join(layout, "blobs", "sha256"), { recursive: true });
  const firstBytes = tar([{ path: "base.txt", bytes: Buffer.from("old") }]);
  const secondBytes = tar([
    { path: ".wh.base.txt", bytes: Buffer.alloc(0) },
    { path: "measured.txt", bytes: Buffer.from("artifact-derived") },
  ]);
  const first = await writeBlob(layout, firstBytes);
  const second = await writeBlob(layout, secondBytes);
  const configBytes = Buffer.from(JSON.stringify({
    architecture: "amd64",
    os: "linux",
    config: {
      Env: ["NODE_VERSION=22.23.2", "NODE_ENV=production"],
      WorkingDir: "/app",
      User: "10001:10001",
      Entrypoint: ["/usr/local/bin/railway-launcher"],
      Cmd: ["api"],
      Labels: {
        "org.opencontainers.image.base.name": "attacker.example/forged:latest",
        "org.opencontainers.image.base.digest": `sha256:${"ff".repeat(32)}`,
        "org.4lpha.base-manifest-digest": `sha256:${"ee".repeat(32)}`,
      },
    },
    rootfs: { type: "layers", diff_ids: [digest(firstBytes), digest(secondBytes)] },
  }));
  const configDigest = digest(configBytes);
  await writeFile(join(layout, "blobs", "sha256", configDigest.slice(7)), configBytes);
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: configBytes.byteLength },
    layers: [first, second],
  }));
  const manifestDigest = digest(manifestBytes);
  await writeFile(join(layout, "blobs", "sha256", manifestDigest.slice(7)), manifestBytes);
  await writeFile(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(layout, "index.json"), JSON.stringify({
    schemaVersion: 2,
    manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: manifestDigest, size: manifestBytes.byteLength }],
  }));
  return layout;
}

test("OCI layout derives manifest/config/layer/rootfs identity and applies whiteouts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-oci-fixture-"));
  try {
    const layout = await ociFixture(temporary);
    const artifact = await materializeRailwayOciLayout(layout);
    try {
      assert.match(artifact.imageDigest, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(artifact.platform, "linux/amd64");
      assert.equal(artifact.nodeVersion, "22.23.2");
      assert.equal(await readFile(join(artifact.rootfs, "measured.txt"), "utf8"), "artifact-derived");
      await assert.rejects(readFile(join(artifact.rootfs, "base.txt")));
      assert.equal(artifact.layerDigests.length, 2);
      assert.equal(artifact.layerDescriptors.length, 2);
      assert.equal(artifact.diffIds.length, 2);
      const base = Object.freeze({
        manifestDigest: RAILWAY_BASE_MANIFEST_DIGEST,
        configDigest: `sha256:${"aa".repeat(32)}`,
        layerDescriptors: Object.freeze([artifact.layerDescriptors[0]!]),
        diffIds: Object.freeze([artifact.diffIds[0]!]),
      });
      assert.doesNotThrow(() => assertRailwayBasePrefix(base, artifact));
      for (const candidate of [
        { layerDescriptors: [{ ...artifact.layerDescriptors[0]!, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" }, artifact.layerDescriptors[1]!], diffIds: artifact.diffIds },
        { layerDescriptors: [{ ...artifact.layerDescriptors[0]!, digest: `sha256:${"ff".repeat(32)}` }, artifact.layerDescriptors[1]!], diffIds: artifact.diffIds },
        { layerDescriptors: [{ ...artifact.layerDescriptors[0]!, size: artifact.layerDescriptors[0]!.size + 1 }, artifact.layerDescriptors[1]!], diffIds: artifact.diffIds },
        { layerDescriptors: artifact.layerDescriptors, diffIds: [`sha256:${"dd".repeat(32)}`, artifact.diffIds[1]!] },
      ]) {
        assert.throws(() => assertRailwayBasePrefix(base, candidate), /base-layer prefix refused/u);
      }
    } finally {
      await artifact.cleanup();
    }
    const provenance = join(temporary, "base-provenance");
    await mkdir(provenance);
    await writeFile(join(provenance, "manifest.json"), "{}");
    await writeFile(join(provenance, "config.json"), "{}");
    await assert.rejects(verifyRailwayBaseProvenance(provenance), /Pinned Railway base manifest refused/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("OCI production inspector requires nonempty marker input before artifact access", async () => {
  await assert.rejects(inspectRailwayOciLayout({
    baseProvenance: "unreachable",
    ociLayout: "unreachable",
    lockPath: "unreachable",
    forbiddenMarkers: [],
  }), /nonempty release marker/u);
});

test("official two-blob base provenance derives the pinned five-layer chain", async () => {
  const verified = await verifyRailwayBaseProvenance(BASE_PROVENANCE_FIXTURE);
  assert.equal(verified.manifestDigest, RAILWAY_BASE_MANIFEST_DIGEST);
  assert.equal(verified.configDigest, BASE_CONFIG_DIGEST);
  assert.equal(verified.layerDescriptors.length, 5);
  assert.equal(verified.diffIds.length, 5);
  assert.deepEqual([...new Set(verified.layerDescriptors.map((layer) => layer.mediaType))], [
    "application/vnd.oci.image.layer.v1.tar+gzip",
  ]);
  for (const layer of verified.layerDescriptors) {
    assert.match(layer.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(layer.size > 0);
  }
  for (const diffId of verified.diffIds) assert.match(diffId, /^sha256:[0-9a-f]{64}$/u);
});

test("official base provenance refuses raw-blob mutation and exact-census drift", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-base-provenance-mutants-"));
  const provenance = join(temporary, "provenance");
  const stage = async (): Promise<void> => {
    await rm(provenance, { recursive: true, force: true });
    await mkdir(provenance);
    await copyFile(join(BASE_PROVENANCE_FIXTURE, "manifest.json"), join(provenance, "manifest.json"));
    await copyFile(join(BASE_PROVENANCE_FIXTURE, "config.json"), join(provenance, "config.json"));
  };
  try {
    await stage();
    const manifest = await readFile(join(provenance, "manifest.json"));
    manifest[0] = manifest[0]! ^ 1;
    await writeFile(join(provenance, "manifest.json"), manifest);
    await assert.rejects(verifyRailwayBaseProvenance(provenance), /Pinned Railway base manifest refused/u);

    await stage();
    const config = await readFile(join(provenance, "config.json"));
    config[config.byteLength - 1] = config[config.byteLength - 1]! ^ 1;
    await writeFile(join(provenance, "config.json"), config);
    await assert.rejects(verifyRailwayBaseProvenance(provenance), /config descriptor binding refused/u);

    await stage();
    await writeFile(join(provenance, "extra.json"), "{}");
    await assert.rejects(verifyRailwayBaseProvenance(provenance), /provenance census refused/u);

    await stage();
    await rm(join(provenance, "config.json"));
    await assert.rejects(verifyRailwayBaseProvenance(provenance), /provenance census refused/u);

    await stage();
    await rm(join(provenance, "config.json"));
    await mkdir(join(provenance, "config.json"));
    await assert.rejects(verifyRailwayBaseProvenance(provenance), /provenance blob refused/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("offline ingestion reproduces the official base provenance bytes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-base-provenance-success-"));
  const output = join(temporary, "provenance");
  try {
    const result = await run(process.execPath, [
      "--import", "tsx", resolve(ROOT, "scripts/railway-ingest-base-provenance.ts"),
      "--manifest", join(BASE_PROVENANCE_FIXTURE, "manifest.json"),
      "--config", join(BASE_PROVENANCE_FIXTURE, "config.json"),
      "--out", output,
    ], { cwd: ROOT, windowsHide: true });
    assert.deepEqual(JSON.parse(result.stdout) as unknown, {
      schema: "4lpha.railway-base-provenance.v1",
      manifestDigest: RAILWAY_BASE_MANIFEST_DIGEST,
      configDigest: BASE_CONFIG_DIGEST,
      layerCount: 5,
    });
    assert.deepEqual(
      await readFile(join(output, "manifest.json")),
      await readFile(join(BASE_PROVENANCE_FIXTURE, "manifest.json")),
    );
    assert.deepEqual(
      await readFile(join(output, "config.json")),
      await readFile(join(BASE_PROVENANCE_FIXTURE, "config.json")),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("base provenance ingestion is offline, exact-census and removes invalid output", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-base-provenance-ingest-"));
  const output = join(temporary, "provenance");
  try {
    const manifest = join(temporary, "raw-manifest");
    const config = join(temporary, "raw-config");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" }));
    await writeFile(config, "{}");
    await assert.rejects(run(process.execPath, [
      "--import", "tsx", resolve(ROOT, "scripts/railway-ingest-base-provenance.ts"),
      "--manifest", manifest,
      "--config", config,
      "--out", output,
    ], { cwd: ROOT, windowsHide: true }));
    assert.equal(await lstat(output).then(() => true, () => false), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
