import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  RAILWAY_APP_PATHS,
  verifyRailwayAppInventory,
  type InventoryRegularFile,
} from "./imageInventory.js";
import {
  assertRailwayBasePrefix,
  materializeRailwayOciLayout,
  verifyRailwayBaseProvenance,
  type OciDescriptorEvidence,
  type OciFilesystemMetadata,
} from "./ociLayout.js";
import {
  AWS_SIGNING_HELPER,
  RAILWAY_GID,
  RAILWAY_LAUNCHER_PATH,
  RAILWAY_UID,
} from "./railwayConstants.js";

type BinaryEvidence = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  mode: string;
  uid: number;
  gid: number;
}>;

type RootfsFileEvidence = Readonly<{
  kind: "file";
  path: string;
  bytes: number;
  sha256: string;
  mode: string;
  uid: number;
  gid: number;
}> | Readonly<{
  kind: "link";
  path: string;
  target: string;
  mode: string;
  uid: number;
  gid: number;
}>;

export type RailwayOciEvidence = Readonly<{
  schema: "4lpha.railway-oci-evidence.v2";
  baseManifestDigest: string;
  baseConfigDigest: string;
  baseLayerDescriptors: readonly OciDescriptorEvidence[];
  baseDiffIds: readonly string[];
  candidateBaseLayerCount: number;
  nodeVersion: string;
  platform: string;
  imageDigest: string;
  configDigest: string;
  layerDigests: readonly string[];
  layerDescriptors: readonly OciDescriptorEvidence[];
  diffIds: readonly string[];
  appInventorySha256: string;
  appFiles: readonly InventoryRegularFile[];
  rootfsFiles: readonly RootfsFileEvidence[];
  launcher: BinaryEvidence;
  helper: BinaryEvidence & Readonly<{ version: string }>;
}>;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mode(value: number): string {
  return (value & 0o7777).toString(8).padStart(4, "0");
}

function metadataAt(metadata: ReadonlyMap<string, OciFilesystemMetadata>, path: string): OciFilesystemMetadata {
  const value = metadata.get(path);
  if (value === undefined) throw new Error(`OCI filesystem entry is missing: ${path}`);
  return value;
}

async function binaryEvidence(
  rootfs: string,
  metadata: ReadonlyMap<string, OciFilesystemMetadata>,
  path: string,
): Promise<BinaryEvidence> {
  const entry = metadataAt(metadata, path);
  if (entry.kind !== "file" || entry.uid !== 0 || entry.gid !== 0 || entry.mode !== 0o555) {
    throw new Error(`Immutable Railway executable metadata refused: ${path}`);
  }
  const bytes = await readFile(join(rootfs, path.slice(1)));
  return Object.freeze({
    path,
    bytes: bytes.byteLength,
    sha256: digest(bytes),
    mode: mode(entry.mode),
    uid: entry.uid,
    gid: entry.gid,
  });
}

function assertOciMetadata(metadata: ReadonlyMap<string, OciFilesystemMetadata>): void {
  const run = metadataAt(metadata, "/run/4lpha");
  if (run.kind !== "directory" || run.uid !== RAILWAY_UID || run.gid !== RAILWAY_GID || run.mode !== 0o700) {
    throw new Error("Railway runtime directory metadata refused.");
  }
  for (const entry of metadata.values()) {
    if ((entry.mode & 0o6000) !== 0) throw new Error("Setuid/setgid OCI entry refused.");
    if (entry.kind === "file" && (entry.mode & 0o111) !== 0 && (entry.mode & 0o022) !== 0) {
      throw new Error("Writable OCI executable refused.");
    }
    if (entry.path === "/app" || entry.path.startsWith("/app/")) {
      if (entry.uid !== 0 || entry.gid !== 0 || (entry.mode & 0o022) !== 0) {
        throw new Error("Application OCI ownership or mode refused.");
      }
    }
  }
}

async function assertMarkersAbsent(
  rootfs: string,
  metadata: ReadonlyMap<string, OciFilesystemMetadata>,
  markers: readonly Uint8Array[],
): Promise<void> {
  if (markers.length === 0 || markers.some((marker) => marker.byteLength === 0)) {
    throw new Error("At least one nonempty release marker is required.");
  }
  for (const entry of metadata.values()) {
    if (entry.kind !== "file") continue;
    const bytes = await readFile(join(rootfs, entry.path.slice(1)));
    for (const marker of markers) {
      if (bytes.indexOf(marker) >= 0) throw new Error("Release marker found in OCI filesystem.");
    }
  }
}

async function rootfsCensus(
  rootfs: string,
  metadata: ReadonlyMap<string, OciFilesystemMetadata>,
): Promise<readonly RootfsFileEvidence[]> {
  const files: RootfsFileEvidence[] = [];
  for (const entry of [...metadata.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    if (entry.kind === "directory") continue;
    if (entry.kind === "link") {
      files.push(Object.freeze({
        kind: "link",
        path: entry.path,
        target: entry.linkTarget ?? "",
        mode: mode(entry.mode),
        uid: entry.uid,
        gid: entry.gid,
      }));
    } else {
      const bytes = await readFile(join(rootfs, entry.path.slice(1)));
      files.push(Object.freeze({
        kind: "file",
        path: entry.path,
        bytes: bytes.byteLength,
        sha256: digest(bytes),
        mode: mode(entry.mode),
        uid: entry.uid,
        gid: entry.gid,
      }));
    }
  }
  return files;
}

export async function inspectRailwayOciLayout(input: Readonly<{
  baseProvenance: string;
  ociLayout: string;
  lockPath: string;
  forbiddenMarkers: readonly Uint8Array[];
}>): Promise<RailwayOciEvidence> {
  if (input.forbiddenMarkers.length === 0 || input.forbiddenMarkers.some((marker) => marker.byteLength === 0)) {
    throw new Error("At least one nonempty release marker is required.");
  }
  const base = await verifyRailwayBaseProvenance(input.baseProvenance);
  const artifact = await materializeRailwayOciLayout(input.ociLayout);
  try {
    assertRailwayBasePrefix(base, artifact);
    assertOciMetadata(artifact.metadata);
    await assertMarkersAbsent(artifact.rootfs, artifact.metadata, input.forbiddenMarkers);
    const appRoot = resolve(artifact.rootfs, "app");
    const inventoryBytes = await readFile(join(appRoot, "artifacts", "app-inventory.json"));
    const inventory = await verifyRailwayAppInventory({
      appRoot,
      lockPath: input.lockPath,
      inventoryBytes,
    });
    if (inventory.application.length !== RAILWAY_APP_PATHS.length - 1) {
      throw new Error("Application artifact census refused.");
    }
    const launcher = await binaryEvidence(artifact.rootfs, artifact.metadata, RAILWAY_LAUNCHER_PATH);
    const helperBase = await binaryEvidence(artifact.rootfs, artifact.metadata, AWS_SIGNING_HELPER.path);
    if (helperBase.bytes !== AWS_SIGNING_HELPER.bytes || helperBase.sha256 !== AWS_SIGNING_HELPER.sha256) {
      throw new Error("AWS signing helper identity refused.");
    }
    return Object.freeze({
      schema: "4lpha.railway-oci-evidence.v2",
      baseManifestDigest: base.manifestDigest,
      baseConfigDigest: base.configDigest,
      baseLayerDescriptors: base.layerDescriptors,
      baseDiffIds: base.diffIds,
      candidateBaseLayerCount: base.layerDescriptors.length,
      nodeVersion: artifact.nodeVersion,
      platform: artifact.platform,
      imageDigest: artifact.imageDigest,
      configDigest: artifact.configDigest,
      layerDigests: artifact.layerDigests,
      layerDescriptors: artifact.layerDescriptors,
      diffIds: artifact.diffIds,
      appInventorySha256: digest(inventoryBytes),
      appFiles: inventory.application,
      rootfsFiles: await rootfsCensus(artifact.rootfs, artifact.metadata),
      launcher,
      helper: Object.freeze({ ...helperBase, version: AWS_SIGNING_HELPER.version }),
    });
  } finally {
    await artifact.cleanup();
  }
}

export function canonicalRailwayOciEvidence(evidence: RailwayOciEvidence): string {
  return `${JSON.stringify(evidence)}\n`;
}
