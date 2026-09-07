import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyRailwayDockerContext } from "../src/deployment/dockerContext.js";

const run = promisify(execFile);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== "--out" || argv[1]?.trim() === "") {
    throw new Error("Usage: railway-build-context-tar --out <new-context.tar>");
  }
  const root = resolve(import.meta.dirname, "..");
  const out = resolve(argv[1]!);
  if (await lstat(out).then(() => true, () => false)) throw new Error("Build-context tar output already exists.");
  const included = await verifyRailwayDockerContext(root);
  const files = ["Dockerfile", ".dockerignore"];
  for (const path of included) {
    if ((await lstat(join(root, path))).isFile()) files.push(path);
  }
  const sorted = [...new Set(files)].sort();
  const temporary = await mkdtemp(join(tmpdir(), "4lpha-context-tar-"));
  const list = join(temporary, "files.txt");
  try {
    await writeFile(list, `${sorted.join("\n")}\n`, "utf8");
    await run("tar", ["-cf", out, "-C", root, "-T", list], { windowsHide: true });
    const observed = (await run("tar", ["-tf", out], { windowsHide: true })).stdout
      .split(/\r?\n/u).filter(Boolean).map((path) => path.replace(/^\.\//u, "")).sort();
    assertSame(observed, sorted);
  } catch (error) {
    await rm(out, { force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ schema: "4lpha.railway-build-context-tar.v1", files: sorted })}\n`);
}

function assertSame(observed: readonly string[], expected: readonly string[]): void {
  if (observed.length !== expected.length || expected.some((path, index) => observed[index] !== path)) {
    throw new Error("Constructed Docker context tar differs from the closed allowlist.");
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Railway context tar build failed.");
  process.exitCode = 1;
});
