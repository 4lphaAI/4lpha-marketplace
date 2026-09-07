import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { RAILWAY_BUNDLE_ROLES } from "../src/railway/roles.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function outputDirectory(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--out" || argv[1]?.trim() === "") {
    throw new Error("Usage: railway-build-role-bundles --out <new-directory>");
  }
  return resolve(argv[1]!);
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const output = outputDirectory(process.argv.slice(2));
  await mkdir(output, { recursive: false, mode: 0o755 });
  const artifacts: Array<Readonly<{ path: string; bytes: number; sha256: string }>> = [];
  try {
    for (const role of RAILWAY_BUNDLE_ROLES) {
      const bootstrapSource = [
        `import { assertRailwayCleanExec } from "./src/railway/cleanExec.ts";`,
        `await assertRailwayCleanExec(${JSON.stringify(role.role)});`,
        `await import(${JSON.stringify(`./${role.payload}`)});`,
      ].join("\n");
      const bootstrap = await build({
        absWorkingDir: ROOT,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        packages: "external",
        external: [`./${role.payload}`],
        treeShaking: true,
        minify: false,
        legalComments: "none",
        sourcemap: false,
        write: false,
        outfile: role.output,
        stdin: {
          contents: bootstrapSource,
          loader: "ts",
          resolveDir: ROOT,
          sourcefile: `railway-${role.role}-entry.ts`,
        },
      });
      const payload = await build({
        absWorkingDir: ROOT,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        packages: "external",
        treeShaking: true,
        minify: false,
        legalComments: "none",
        sourcemap: false,
        write: false,
        outfile: role.payload,
        entryPoints: [resolve(ROOT, role.sourceEntry)],
      });
      if (bootstrap.outputFiles.length !== 1 || payload.outputFiles.length !== 1) {
        throw new Error("Railway role build did not emit exactly one bundle.");
      }
      for (const [name, artifact] of [[role.output, bootstrap.outputFiles[0]], [role.payload, payload.outputFiles[0]]] as const) {
        if (artifact === undefined) throw new Error("Railway role artifact is missing.");
        await writeExclusive(resolve(output, name), artifact.contents);
        artifacts.push(Object.freeze({
          path: `dist/railway/${name}`,
          bytes: artifact.contents.byteLength,
          sha256: createHash("sha256").update(artifact.contents).digest("hex"),
        }));
      }
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`${JSON.stringify({
    schema: "4lpha.railway-role-bundles.v1",
    artifacts,
  })}\n`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Railway role build failed.");
  process.exitCode = 1;
});
