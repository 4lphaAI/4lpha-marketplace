import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const RAILWAY_APP_PATHS = Object.freeze([
  "package.json",
  "dist/railway/api.mjs",
  "dist/railway/api.payload.mjs",
  "dist/railway/lp-worker.mjs",
  "dist/railway/lp-worker.payload.mjs",
  "dist/railway/venus-worker.mjs",
  "dist/railway/venus-worker.payload.mjs",
  "dist/railway/billing-worker.mjs",
  "dist/railway/billing-worker.payload.mjs",
  "artifacts/billing-adapter.mjs",
  "artifacts/app-inventory.json",
] as const);

export type InventoryRegularFile = Readonly<{
  kind: "file";
  path: string;
  bytes: number;
  sha256: string;
}>;

export type InventoryLink = Readonly<{
  kind: "link";
  path: string;
  target: string;
}>;

export type InventoryEntry = InventoryRegularFile | InventoryLink;

export type DependencyPackage = Readonly<{
  lockfileKey: string;
  name: string;
  version: string;
  integrity: string;
  bins: readonly Readonly<{ name: string; path: string }>[];
}>;

export type RailwayAppInventory = Readonly<{
  schema: "4lpha.railway-app-inventory.v1";
  lockSha256: string;
  application: readonly InventoryRegularFile[];
  packages: readonly DependencyPackage[];
  dependencyFiles: readonly InventoryEntry[];
}>;

type LockPackage = Readonly<{
  name?: unknown;
  version?: unknown;
  integrity?: unknown;
  dev?: unknown;
  optional?: unknown;
  os?: unknown;
  cpu?: unknown;
}>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function asRecord(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Readonly<Record<string, unknown>>;
}

function productionLockPackages(lockBytes: Uint8Array): Readonly<Map<string, LockPackage>> {
  const parsed = asRecord(JSON.parse(Buffer.from(lockBytes).toString("utf8")) as unknown, "Invalid package lock.");
  if (parsed["lockfileVersion"] !== 3) throw new Error("Railway image requires package-lock v3.");
  const packages = asRecord(parsed["packages"], "Package lock has no packages map.");
  const result = new Map<string, LockPackage>();
  for (const [key, value] of Object.entries(packages)) {
    if (!key.startsWith("node_modules/")) continue;
    const entry = asRecord(value, "Invalid package lock entry.") as LockPackage;
    if (entry.dev !== true) result.set(key, entry);
  }
  return result;
}

function packageNameFromLockKey(key: string): string {
  const marker = "node_modules/";
  const start = key.lastIndexOf(marker) + marker.length;
  const suffix = key.slice(start);
  if (suffix.startsWith("@")) {
    const pieces = suffix.split("/");
    if (pieces.length !== 2 || pieces[1] === "") throw new Error("Invalid scoped lockfile package key.");
    return suffix;
  }
  if (suffix === "" || suffix.includes("/")) throw new Error("Invalid lockfile package key.");
  return suffix;
}

function platformListAllows(value: unknown, current: string): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid package platform selector in lockfile.");
  }
  const entries = value as readonly string[];
  if (entries.includes(`!${current}`)) return false;
  const positive = entries.filter((entry) => !entry.startsWith("!"));
  return positive.length === 0 || positive.includes(current);
}

function requiredOnRailwayPlatform(entry: LockPackage): boolean {
  return platformListAllows(entry.os, "linux") && platformListAllows(entry.cpu, "x64");
}

async function discoverInstalledPackageRoots(nodeModules: string): Promise<readonly string[]> {
  const roots: string[] = [];
  async function visit(container: string): Promise<void> {
    const children = await readdir(container, { withFileTypes: true });
    for (const child of children) {
      if (child.name === ".bin") continue;
      const childPath = join(container, child.name);
      if (child.name.startsWith("@")) {
        if (!child.isDirectory()) throw new Error("Invalid scoped package namespace.");
        for (const scoped of await readdir(childPath, { withFileTypes: true })) {
          if (!scoped.isDirectory()) throw new Error("Invalid scoped package root.");
          const packageRoot = join(childPath, scoped.name);
          roots.push(packageRoot);
          const nested = join(packageRoot, "node_modules");
          if ((await lstat(nested).catch(() => undefined))?.isDirectory()) await visit(nested);
        }
        continue;
      }
      if (!child.isDirectory()) throw new Error("Unexpected node_modules top-level entry.");
      roots.push(childPath);
      const nested = join(childPath, "node_modules");
      if ((await lstat(nested).catch(() => undefined))?.isDirectory()) await visit(nested);
    }
  }
  await visit(nodeModules);
  return roots.sort();
}

function packageBins(
  packageRoot: string,
  packageName: string,
  value: unknown,
): readonly Readonly<{ name: string; path: string; absolute: string }>[] {
  const raw = typeof value === "string"
    ? { [packageName.includes("/") ? packageName.slice(packageName.lastIndexOf("/") + 1) : packageName]: value }
    : value === undefined ? {} : asRecord(value, "Invalid package bin declaration.");
  const output: Array<Readonly<{ name: string; path: string; absolute: string }>> = [];
  for (const [name, path] of Object.entries(raw)) {
    if (name === "" || name.includes("/") || typeof path !== "string" || path === "") {
      throw new Error("Invalid package bin declaration.");
    }
    const absolute = resolve(packageRoot, path);
    if (!inside(packageRoot, absolute)) throw new Error("Escaping package bin declaration refused.");
    output.push(Object.freeze({ name, path: slash(path), absolute }));
  }
  return output.sort((left, right) => left.name.localeCompare(right.name));
}

async function assertBinEntries(
  nodeModules: string,
  packageRoots: readonly string[],
  declared: ReadonlyMap<string, readonly string[]>,
): Promise<void> {
  const containers = [nodeModules];
  for (const packageRoot of packageRoots) {
    const nested = join(packageRoot, "node_modules");
    if ((await lstat(nested).catch(() => undefined))?.isDirectory()) containers.push(nested);
  }
  for (const container of [...new Set(containers)].sort()) {
    const bin = join(container, ".bin");
    const binStats = await lstat(bin).catch(() => undefined);
    if (binStats !== undefined) {
      if (!binStats.isDirectory() || binStats.isSymbolicLink()) throw new Error("node_modules/.bin must be a real directory.");
      for (const entry of await readdir(bin, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) throw new Error("Railway Linux image permits only npm .bin symlinks.");
        const allowed = declared.get(entry.name);
        const target = await realpath(join(bin, entry.name));
        if (allowed === undefined || !allowed.includes(target)) {
          throw new Error("npm .bin link does not match an admitted package declaration.");
        }
      }
    }
  }
}

async function inventoryTree(
  root: string,
  admittedPackageRoots: readonly string[],
): Promise<readonly InventoryEntry[]> {
  const output: InventoryEntry[] = [];
  async function visit(path: string): Promise<void> {
    for (const child of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, child.name);
      const name = slash(relative(root, absolute));
      const stats = await lstat(absolute);
      if ((stats.mode & 0o6000) !== 0) throw new Error("Setuid/setgid image entry refused.");
      if (stats.isSymbolicLink()) {
        const literalTarget = await readlink(absolute);
        const target = await realpath(absolute);
        if (!inside(root, target) || !admittedPackageRoots.some((packageRoot) => inside(packageRoot, target))) {
          throw new Error("Dependency link target is not inside an admitted package.");
        }
        output.push(Object.freeze({ kind: "link", path: name, target: slash(literalTarget) }));
      } else if (stats.isDirectory()) {
        await visit(absolute);
      } else if (stats.isFile()) {
        if (process.platform !== "win32" && (stats.mode & 0o111) !== 0 && (stats.mode & 0o022) !== 0) {
          throw new Error("Writable executable image entry refused.");
        }
        const bytes = await readFile(absolute);
        output.push(Object.freeze({ kind: "file", path: name, bytes: bytes.byteLength, sha256: sha256(bytes) }));
      } else {
        throw new Error("Non-file image entry refused.");
      }
    }
  }
  await visit(root);
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

async function applicationFiles(appRoot: string): Promise<readonly InventoryRegularFile[]> {
  const payloadPaths = RAILWAY_APP_PATHS.filter((path) => path !== "artifacts/app-inventory.json");
  const files: InventoryRegularFile[] = [];
  for (const path of payloadPaths) {
    const absolute = resolve(appRoot, path);
    if (!inside(appRoot, absolute)) throw new Error("Application inventory path escaped.");
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Application payload is not a regular file.");
    if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
      throw new Error("Application payload is writable by group or other.");
    }
    const bytes = await readFile(absolute);
    files.push(Object.freeze({ kind: "file", path, bytes: bytes.byteLength, sha256: sha256(bytes) }));
  }
  return files;
}

export async function createRailwayAppInventory(input: Readonly<{
  appRoot: string;
  lockPath: string;
}>): Promise<RailwayAppInventory> {
  const appRoot = resolve(input.appRoot);
  const nodeModules = join(appRoot, "node_modules");
  const nodeModulesStats = await lstat(nodeModules);
  if (!nodeModulesStats.isDirectory() || nodeModulesStats.isSymbolicLink()) {
    throw new Error("Application node_modules must be a real directory.");
  }
  const lockBytes = await readFile(input.lockPath);
  const lockPackages = productionLockPackages(lockBytes);
  const installedRoots = await discoverInstalledPackageRoots(nodeModules);
  const installedKeys = new Set(installedRoots.map((path) => slash(relative(appRoot, path))));
  const packages: DependencyPackage[] = [];
  const declaredBins = new Map<string, string[]>();
  for (const key of [...installedKeys].sort()) {
    const locked = lockPackages.get(key);
    if (locked === undefined) throw new Error(`Installed package is absent from production lock closure: ${key}`);
    const packageJson = asRecord(
      JSON.parse(await readFile(join(appRoot, key, "package.json"), "utf8")) as unknown,
      "Invalid installed package manifest.",
    );
    const expectedName = typeof locked.name === "string" ? locked.name : packageNameFromLockKey(key);
    if (typeof locked.version !== "string" || typeof locked.integrity !== "string" ||
        packageJson["name"] !== expectedName || packageJson["version"] !== locked.version) {
      throw new Error(`Installed package does not match package lock: ${key}`);
    }
    const bins = packageBins(join(appRoot, key), expectedName, packageJson["bin"]);
    for (const bin of bins) {
      const targets = declaredBins.get(bin.name) ?? [];
      targets.push(bin.absolute);
      declaredBins.set(bin.name, targets);
    }
    packages.push(Object.freeze({
      lockfileKey: key,
      name: packageJson["name"],
      version: locked.version,
      integrity: locked.integrity,
      bins: Object.freeze(bins.map(({ name, path }) => Object.freeze({ name, path }))),
    }));
  }
  for (const [key, locked] of lockPackages) {
    if (requiredOnRailwayPlatform(locked) && !installedKeys.has(key)) {
      throw new Error(`Required production package is missing: ${key}`);
    }
  }
  await assertBinEntries(nodeModules, installedRoots, declaredBins);
  return Object.freeze({
    schema: "4lpha.railway-app-inventory.v1",
    lockSha256: sha256(lockBytes),
    application: await applicationFiles(appRoot),
    packages,
    dependencyFiles: await inventoryTree(nodeModules, installedRoots),
  });
}

export function canonicalRailwayAppInventory(inventory: RailwayAppInventory): string {
  return `${JSON.stringify(inventory)}\n`;
}

export async function assertRailwayAppNamespace(appRootInput: string): Promise<void> {
  const appRoot = resolve(appRootInput);
  const expected = new Set<string>(RAILWAY_APP_PATHS);
  const observed = new Set<string>();
  async function visit(path: string): Promise<void> {
    for (const child of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, child.name);
      const rel = slash(relative(appRoot, absolute));
      if (rel === "node_modules") continue;
      if (child.isDirectory()) {
        await visit(absolute);
      } else {
        observed.add(rel);
      }
    }
  }
  await visit(appRoot);
  if (observed.size !== expected.size || [...expected].some((path) => !observed.has(path))) {
    throw new Error("Final application namespace differs from the closed Railway allowlist.");
  }
  for (const top of await readdir(appRoot)) {
    if (!["package.json", "node_modules", "dist", "artifacts"].includes(top)) {
      throw new Error("Unexpected top-level application image entry.");
    }
  }
}

export async function verifyRailwayAppInventory(input: Readonly<{
  appRoot: string;
  lockPath: string;
  inventoryBytes: Uint8Array;
}>): Promise<RailwayAppInventory> {
  if (input.inventoryBytes.byteLength === 0 || input.inventoryBytes[input.inventoryBytes.byteLength - 1] !== 0x0a) {
    throw new Error("Railway app inventory is not canonical newline-terminated JSON.");
  }
  const expected = await createRailwayAppInventory(input);
  const expectedBytes = Buffer.from(canonicalRailwayAppInventory(expected), "utf8");
  if (!Buffer.from(input.inventoryBytes).equals(expectedBytes)) {
    throw new Error("Railway app inventory differs from the final filesystem.");
  }
  await assertRailwayAppNamespace(input.appRoot);
  return expected;
}
