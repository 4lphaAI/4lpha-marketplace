import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const EXACT_SCRIPTS = Object.freeze([
  "scripts/railway-build-role-bundles.ts",
  "scripts/railway-build-app-inventory.ts",
  "scripts/billing-build-adapter.ts",
  "scripts/lp-worker.ts",
  "scripts/venus-worker.ts",
  "scripts/billing-worker.ts",
  // Marketplace services built from `Dockerfile.services` (deploy/railway/):
  // the trading daemon and the ERC-8004 identity worker + its CLI (migrate).
  "scripts/trade-worker.ts",
  "scripts/erc8004-worker.ts",
  "scripts/erc8004-identity.ts",
]);

const EXPECTED_DOCKERIGNORE = Object.freeze([
  "**",
  "!package.json",
  "!package-lock.json",
  "!src",
  "!src/**",
  "!scripts",
  ...EXACT_SCRIPTS.map((path) => `!${path}`),
  "!deploy",
  "!deploy/railway-launcher.c",
]);

function slash(path: string): string {
  return path.split(sep).join("/");
}

async function walk(root: string, path: string, output: string[]): Promise<void> {
  for (const child of await readdir(path, { withFileTypes: true })) {
    const absolute = join(path, child.name);
    const name = slash(relative(root, absolute));
    output.push(name);
    if (child.isDirectory()) await walk(root, absolute, output);
    else if (!child.isFile()) throw new Error("Docker build context contains a non-file entry.");
  }
}

export async function verifyRailwayDockerContext(rootInput: string): Promise<readonly string[]> {
  const root = resolve(rootInput);
  const ignoreLines = (await readFile(join(root, ".dockerignore"), "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line !== "");
  if (ignoreLines.length !== EXPECTED_DOCKERIGNORE.length ||
      EXPECTED_DOCKERIGNORE.some((line, index) => ignoreLines[index] !== line)) {
    throw new Error("Railway .dockerignore differs from its closed allowlist.");
  }
  const included = ["package.json", "package-lock.json", "src", "scripts", "deploy"];
  for (const path of ["package.json", "package-lock.json", ...EXACT_SCRIPTS, "deploy/railway-launcher.c"]) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error(`Docker COPY source is missing: ${path}`);
  }
  const sourceFiles: string[] = [];
  await walk(root, join(root, "src"), sourceFiles);
  included.push(...sourceFiles, ...EXACT_SCRIPTS, "deploy/railway-launcher.c");

  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const copyLines = dockerfile.split(/\r?\n/u)
    .filter((line) => line.startsWith("COPY ") && !line.startsWith("COPY --from="));
  for (const line of copyLines) {
    const fields = line.slice(5).trim().split(/\s+/u);
    for (const source of fields.slice(0, -1)) {
      const normalized = source.replace(/\/$/u, "");
      if (!included.includes(normalized)) throw new Error(`Docker COPY source is excluded: ${source}`);
    }
  }
  const forbidden = included.filter((path) =>
    /(^|\/)(?:\.env[^/]*|test|docs?|state|\.git|\.agents|memory)(?:\/|$)/iu.test(path));
  if (forbidden.length > 0) throw new Error("Forbidden file entered Railway Docker context.");
  return Object.freeze([...new Set(included)].sort());
}
