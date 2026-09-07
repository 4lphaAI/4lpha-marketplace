import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  RAILWAY_BASE_MANIFEST_DIGEST,
  RAILWAY_NODE_VERSION,
  RAILWAY_PLATFORM,
} from "./railwayConstants.js";

export type OciFilesystemMetadata = Readonly<{
  kind: "file" | "directory" | "link";
  path: string;
  mode: number;
  uid: number;
  gid: number;
  linkTarget?: string;
}>;

export type MaterializedRailwayOci = Readonly<{
  rootfs: string;
  imageDigest: string;
  configDigest: string;
  layerDigests: readonly string[];
  layerDescriptors: readonly OciDescriptorEvidence[];
  diffIds: readonly string[];
  nodeVersion: string;
  platform: string;
  metadata: ReadonlyMap<string, OciFilesystemMetadata>;
  cleanup(): Promise<void>;
}>;

export type OciDescriptorEvidence = Readonly<{
  mediaType: string;
  digest: string;
  size: number;
}>;

export type VerifiedRailwayBaseProvenance = Readonly<{
  manifestDigest: string;
  configDigest: string;
  layerDescriptors: readonly OciDescriptorEvidence[];
  diffIds: readonly string[];
}>;

type Descriptor = OciDescriptorEvidence;
type OciGraph = Readonly<{
  layout: string;
  imageDigest: string;
  configDigest: string;
  config: Readonly<Record<string, unknown>>;
  layers: readonly Descriptor[];
  diffIds: readonly string[];
}>;

const MANIFEST_MEDIA = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const CONFIG_MEDIA = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);
const LAYER_MEDIA = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.docker.image.rootfs.diff.tar",
  "application/vnd.docker.image.rootfs.diff.tar.gzip",
]);
const MAX_BASE_PROVENANCE_BLOB_BYTES = 4 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Readonly<Record<string, unknown>>;
}

function descriptor(value: unknown, accepted: ReadonlySet<string>): Descriptor {
  const item = record(value, "OCI descriptor is malformed.");
  if (typeof item["mediaType"] !== "string" || !accepted.has(item["mediaType"]) ||
      typeof item["digest"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(item["digest"]) ||
      typeof item["size"] !== "number" || !Number.isSafeInteger(item["size"]) || item["size"] < 0) {
    throw new Error("OCI descriptor identity refused.");
  }
  return Object.freeze({ mediaType: item["mediaType"], digest: item["digest"], size: item["size"] });
}

async function blob(layout: string, selected: Descriptor): Promise<Buffer> {
  const bytes = await readFile(join(layout, "blobs", "sha256", selected.digest.slice(7)));
  if (bytes.byteLength !== selected.size || `sha256:${sha256(bytes)}` !== selected.digest) {
    throw new Error("OCI blob digest or size refused.");
  }
  return bytes;
}

function tarText(bytes: Buffer, start: number, length: number): string {
  const end = bytes.indexOf(0, start);
  const bounded = end < 0 || end > start + length ? start + length : end;
  return bytes.subarray(start, bounded).toString("utf8");
}

function tarNumber(bytes: Buffer, start: number, length: number): number {
  const raw = tarText(bytes, start, length).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/u.test(raw)) throw new Error("OCI tar numeric field refused.");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("OCI tar numeric field overflow.");
  return value;
}

function tarPath(raw: string): string {
  if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/")) throw new Error("OCI tar path refused.");
  const withoutDot = raw.replace(/^\.\//u, "").replace(/\/$/u, "");
  const normalized = posix.normalize(withoutDot);
  if (normalized === "" || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("OCI tar path escaped.");
  }
  return normalized;
}

function parsePax(bytes: Buffer): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.byteLength) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw new Error("OCI PAX length refused.");
    const lengthRaw = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthRaw)) throw new Error("OCI PAX length refused.");
    const length = Number(lengthRaw);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.byteLength || bytes[end - 1] !== 0x0a) {
      throw new Error("OCI PAX record refused.");
    }
    const body = bytes.subarray(space + 1, end - 1).toString("utf8");
    const equals = body.indexOf("=");
    if (equals <= 0) throw new Error("OCI PAX member refused.");
    const key = body.slice(0, equals);
    if (fields[key] !== undefined) throw new Error("Duplicate OCI PAX member refused.");
    if (key.includes("security.capability")) throw new Error("Linux file capability refused.");
    fields[key] = body.slice(equals + 1);
    offset = end;
  }
  return fields;
}

function safeTarget(rootfs: string, path: string): string {
  const absolute = resolve(rootfs, path.split("/").join(sep));
  const rel = relative(rootfs, absolute);
  if (rel.startsWith("..") || rel.startsWith(sep)) throw new Error("OCI rootfs path escaped.");
  return absolute;
}

async function ensureParents(rootfs: string, path: string): Promise<void> {
  const pieces = path.split("/").slice(0, -1);
  let current = rootfs;
  for (const piece of pieces) {
    current = join(current, piece);
    const stats = await lstat(current).catch(() => undefined);
    if (stats === undefined) await mkdir(current, { mode: 0o755 });
    else if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("OCI layer parent is not a real directory.");
  }
}

async function removePath(rootfs: string, path: string, metadata: Map<string, OciFilesystemMetadata>): Promise<void> {
  await rm(safeTarget(rootfs, path), { recursive: true, force: true });
  const prefix = `/${path}`;
  for (const key of [...metadata.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}/`)) metadata.delete(key);
  }
}

function assertLinkTarget(path: string, target: string): void {
  if (target.includes("\\") || target.includes("\0")) throw new Error("OCI link target refused.");
  if (!target.startsWith("/")) {
    const joined = posix.normalize(posix.join(posix.dirname(path), target));
    if (joined === ".." || joined.startsWith("../")) throw new Error("OCI link target escaped.");
  }
}

async function applyLayer(
  rootfs: string,
  bytes: Buffer,
  metadata: Map<string, OciFilesystemMetadata>,
): Promise<void> {
  let offset = 0;
  let pax: Readonly<Record<string, string>> = {};
  let longPath: string | undefined;
  let longLink: string | undefined;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const expectedChecksum = tarNumber(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (checksum !== expectedChecksum) throw new Error("OCI tar checksum refused.");
    const size = tarNumber(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) throw new Error("Truncated OCI layer refused.");
    const data = bytes.subarray(dataStart, dataEnd);
    const type = String.fromCharCode(header[156] ?? 0);
    const headerName = [tarText(header, 345, 155), tarText(header, 0, 100)].filter(Boolean).join("/");
    if (type === "x" || type === "g") {
      const parsed = parsePax(data);
      if (type === "x") pax = parsed;
    } else if (type === "L") {
      longPath = tarText(data, 0, data.byteLength);
    } else if (type === "K") {
      longLink = tarText(data, 0, data.byteLength);
    } else {
      const path = tarPath(pax["path"] ?? longPath ?? headerName);
      const linkTarget = pax["linkpath"] ?? longLink ?? tarText(header, 157, 100);
      const mode = tarNumber(header, 100, 8) & 0o7777;
      const uid = tarNumber(header, 108, 8);
      const gid = tarNumber(header, 116, 8);
      const name = posix.basename(path);
      const parent = posix.dirname(path);
      if (name === ".wh..wh..opq") {
        const prefix = parent === "." ? "" : `${parent}/`;
        for (const key of [...metadata.keys()]) {
          if (key.startsWith(`/${prefix}`) && key !== `/${parent}`) await removePath(rootfs, key.slice(1), metadata);
        }
      } else if (name.startsWith(".wh.")) {
        const targetName = name.slice(4);
        if (targetName === "") throw new Error("Invalid OCI whiteout refused.");
        await removePath(rootfs, posix.join(parent, targetName), metadata);
      } else {
        await ensureParents(rootfs, path);
        const absolute = safeTarget(rootfs, path);
        if (type === "5") {
          const existing = await lstat(absolute).catch(() => undefined);
          if (existing !== undefined && (!existing.isDirectory() || existing.isSymbolicLink())) await removePath(rootfs, path, metadata);
          await mkdir(absolute, { recursive: false, mode }).catch((error: unknown) => {
            const code = record(error, "OCI directory creation failed.")["code"];
            if (code !== "EEXIST") throw error;
          });
          await chmod(absolute, mode);
          metadata.set(`/${path}`, Object.freeze({ kind: "directory", path: `/${path}`, mode, uid, gid }));
        } else if (type === "0" || type === "\0") {
          await removePath(rootfs, path, metadata);
          await ensureParents(rootfs, path);
          const handle = await open(absolute, "wx", mode);
          try { await handle.writeFile(data); } finally { await handle.close(); }
          await chmod(absolute, mode);
          metadata.set(`/${path}`, Object.freeze({ kind: "file", path: `/${path}`, mode, uid, gid }));
        } else if (type === "2") {
          assertLinkTarget(path, linkTarget);
          await removePath(rootfs, path, metadata);
          await ensureParents(rootfs, path);
          let filesystemTarget = linkTarget;
          let filesystemType: "dir" | "file" | "junction" | undefined;
          if (process.platform === "win32") {
            const logicalTarget = linkTarget.startsWith("/")
              ? tarPath(linkTarget.slice(1))
              : tarPath(posix.join(posix.dirname(path), linkTarget));
            const targetPath = safeTarget(rootfs, logicalTarget);
            const targetStats = await lstat(targetPath).catch(() => undefined);
            filesystemType = targetStats?.isDirectory() ? "junction" : "file";
            if (filesystemType === "junction") filesystemTarget = targetPath;
          }
          await symlink(filesystemTarget, absolute, filesystemType);
          metadata.set(`/${path}`, Object.freeze({ kind: "link", path: `/${path}`, mode, uid, gid, linkTarget }));
        } else if (type === "1") {
          const targetPath = tarPath(linkTarget);
          const target = safeTarget(rootfs, targetPath);
          if (!(await lstat(target)).isFile()) throw new Error("OCI hardlink target refused.");
          await removePath(rootfs, path, metadata);
          await ensureParents(rootfs, path);
          await link(target, absolute).catch(async () => copyFile(target, absolute));
          await chmod(absolute, mode);
          metadata.set(`/${path}`, Object.freeze({ kind: "file", path: `/${path}`, mode, uid, gid }));
        } else {
          throw new Error("Unsupported OCI tar entry type refused.");
        }
      }
      pax = {};
      longPath = undefined;
      longLink = undefined;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

async function readOciGraph(layoutInput: string): Promise<OciGraph> {
  const layout = resolve(layoutInput);
  const layoutVersion = record(JSON.parse(await readFile(join(layout, "oci-layout"), "utf8")) as unknown, "OCI layout marker malformed.");
  if (layoutVersion["imageLayoutVersion"] !== "1.0.0" || Object.keys(layoutVersion).length !== 1) {
    throw new Error("OCI layout version refused.");
  }
  const index = record(JSON.parse(await readFile(join(layout, "index.json"), "utf8")) as unknown, "OCI index malformed.");
  if (index["schemaVersion"] !== 2 || !Array.isArray(index["manifests"]) || index["manifests"].length !== 1) {
    throw new Error("OCI index must select exactly one image manifest.");
  }
  const manifestDescriptor = descriptor(index["manifests"][0], MANIFEST_MEDIA);
  const manifestBytes = await blob(layout, manifestDescriptor);
  const imageDigest = `sha256:${sha256(manifestBytes)}`;
  if (imageDigest !== manifestDescriptor.digest) throw new Error("OCI image digest refused.");
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")) as unknown, "OCI manifest malformed.");
  if (manifest["schemaVersion"] !== 2 || !Array.isArray(manifest["layers"]) || manifest["layers"].length === 0) {
    throw new Error("OCI manifest layer census refused.");
  }
  const configDescriptor = descriptor(manifest["config"], CONFIG_MEDIA);
  const layers = manifest["layers"].map((value) => descriptor(value, LAYER_MEDIA));
  const configBytes = await blob(layout, configDescriptor);
  const config = record(JSON.parse(configBytes.toString("utf8")) as unknown, "OCI config malformed.");
  const rootfsConfig = record(config["rootfs"], "OCI rootfs config missing.");
  const diffIds = rootfsConfig["diff_ids"];
  if (rootfsConfig["type"] !== "layers" || !Array.isArray(diffIds) || diffIds.length !== layers.length ||
      diffIds.some((value) => typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))) {
    throw new Error("OCI rootfs diff-ID census refused.");
  }
  return Object.freeze({
    layout,
    imageDigest,
    configDigest: configDescriptor.digest,
    config,
    layers: Object.freeze(layers),
    diffIds: Object.freeze(diffIds as string[]),
  });
}

async function verifiedLayerBytes(graph: OciGraph, index: number): Promise<Buffer> {
  const layer = graph.layers[index];
  if (layer === undefined) throw new Error("OCI layer index refused.");
  const compressed = await blob(graph.layout, layer);
  const uncompressed = layer.mediaType.endsWith("+gzip") || layer.mediaType.endsWith(".gzip")
    ? gunzipSync(compressed)
    : compressed;
  if (graph.diffIds[index] !== `sha256:${sha256(uncompressed)}`) {
    throw new Error("OCI layer diff ID refused.");
  }
  return uncompressed;
}

export async function verifyRailwayBaseProvenance(directoryInput: string): Promise<VerifiedRailwayBaseProvenance> {
  const directory = resolve(directoryInput);
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error("Railway base provenance directory refused.");
  }
  const members = (await readdir(directory)).sort();
  if (JSON.stringify(members) !== JSON.stringify(["config.json", "manifest.json"])) {
    throw new Error("Railway base provenance census refused.");
  }
  const manifestPath = join(directory, "manifest.json");
  const configPath = join(directory, "config.json");
  const [manifestStats, configStats] = await Promise.all([lstat(manifestPath), lstat(configPath)]);
  for (const stats of [manifestStats, configStats]) {
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 ||
        stats.size > MAX_BASE_PROVENANCE_BLOB_BYTES) {
      throw new Error("Railway base provenance blob refused.");
    }
  }
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.byteLength !== manifestStats.size ||
      `sha256:${sha256(manifestBytes)}` !== RAILWAY_BASE_MANIFEST_DIGEST) {
    throw new Error("Pinned Railway base manifest refused.");
  }
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")) as unknown,
    "Railway base manifest malformed.");
  if (manifest["schemaVersion"] !== 2 || typeof manifest["mediaType"] !== "string" ||
      !MANIFEST_MEDIA.has(manifest["mediaType"]) || !Array.isArray(manifest["layers"]) ||
      manifest["layers"].length === 0) {
    throw new Error("Railway base manifest layer census refused.");
  }
  const configDescriptor = descriptor(manifest["config"], CONFIG_MEDIA);
  const layers = manifest["layers"].map((value) => descriptor(value, LAYER_MEDIA));
  const configBytes = await readFile(configPath);
  if (configBytes.byteLength !== configStats.size || configBytes.byteLength !== configDescriptor.size ||
      `sha256:${sha256(configBytes)}` !== configDescriptor.digest) {
    throw new Error("Railway base config descriptor binding refused.");
  }
  const config = record(JSON.parse(configBytes.toString("utf8")) as unknown,
    "Railway base config malformed.");
  const rootfs = record(config["rootfs"], "Railway base rootfs config missing.");
  const diffIds = rootfs["diff_ids"];
  if (config["os"] !== "linux" || config["architecture"] !== "amd64" ||
      rootfs["type"] !== "layers" || !Array.isArray(diffIds) || diffIds.length !== layers.length ||
      diffIds.some((value) => typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))) {
    throw new Error("Railway base config identity refused.");
  }
  return Object.freeze({
    manifestDigest: RAILWAY_BASE_MANIFEST_DIGEST,
    configDigest: configDescriptor.digest,
    layerDescriptors: Object.freeze(layers.map((layer) => Object.freeze({ ...layer }))),
    diffIds: Object.freeze(diffIds as string[]),
  });
}

export function assertRailwayBasePrefix(
  base: VerifiedRailwayBaseProvenance,
  candidate: Pick<MaterializedRailwayOci, "layerDescriptors" | "diffIds">,
): void {
  if (candidate.layerDescriptors.length <= base.layerDescriptors.length ||
      candidate.diffIds.length !== candidate.layerDescriptors.length ||
      base.diffIds.length !== base.layerDescriptors.length) {
    throw new Error("Railway candidate base-layer prefix census refused.");
  }
  for (let index = 0; index < base.layerDescriptors.length; index++) {
    const expected = base.layerDescriptors[index]!;
    const actual = candidate.layerDescriptors[index]!;
    if (actual.mediaType !== expected.mediaType || actual.digest !== expected.digest || actual.size !== expected.size ||
        candidate.diffIds[index] !== base.diffIds[index]) {
      throw new Error("Railway candidate base-layer prefix refused.");
    }
  }
}

export async function materializeRailwayOciLayout(layoutInput: string): Promise<MaterializedRailwayOci> {
  const graph = await readOciGraph(layoutInput);
  const runtime = record(graph.config["config"], "OCI runtime config missing.");
  const env = runtime["Env"];
  if (graph.config["os"] !== "linux" || graph.config["architecture"] !== "amd64" || !Array.isArray(env) ||
      !env.includes(`NODE_VERSION=${RAILWAY_NODE_VERSION}`) || !env.includes("NODE_ENV=production") ||
      runtime["WorkingDir"] !== "/app" || runtime["User"] !== "10001:10001" ||
      JSON.stringify(runtime["Entrypoint"]) !== JSON.stringify(["/usr/local/bin/railway-launcher"]) ||
      JSON.stringify(runtime["Cmd"]) !== JSON.stringify(["api"])) {
    throw new Error("OCI measured runtime identity refused.");
  }
  const rootfs = await mkdtemp(join(tmpdir(), "4lpha-railway-oci-"));
  const metadata = new Map<string, OciFilesystemMetadata>();
  try {
    for (let indexValue = 0; indexValue < graph.layers.length; indexValue++) {
      const uncompressed = await verifiedLayerBytes(graph, indexValue);
      await applyLayer(rootfs, uncompressed, metadata);
    }
  } catch (error) {
    await rm(rootfs, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    rootfs,
    imageDigest: graph.imageDigest,
    configDigest: graph.configDigest,
    layerDigests: Object.freeze(graph.layers.map((layer) => layer.digest)),
    layerDescriptors: Object.freeze(graph.layers.map((layer) => Object.freeze({ ...layer }))),
    diffIds: Object.freeze([...graph.diffIds]),
    nodeVersion: RAILWAY_NODE_VERSION,
    platform: RAILWAY_PLATFORM,
    metadata,
    cleanup: () => rm(rootfs, { recursive: true, force: true }),
  });
}
