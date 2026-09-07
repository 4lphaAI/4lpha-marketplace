import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalRailwayAppInventory,
  createRailwayAppInventory,
} from "../src/deployment/imageInventory.js";

function options(argv: readonly string[]): Readonly<{ appRoot: string; lockPath: string; out: string }> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !["--app-root", "--lock", "--out"].includes(name) || values.has(name)) {
      throw new Error("Usage: railway-build-app-inventory --app-root <dir> --lock <package-lock.json> --out <new-file>");
    }
    values.set(name, value);
  }
  if (values.size !== 3) throw new Error("Railway inventory builder requires exactly three options.");
  return {
    appRoot: resolve(values.get("--app-root")!),
    lockPath: resolve(values.get("--lock")!),
    out: resolve(values.get("--out")!),
  };
}

async function main(): Promise<void> {
  const selected = options(process.argv.slice(2));
  const inventory = await createRailwayAppInventory(selected);
  const handle = await open(selected.out, "wx", 0o644);
  try {
    await handle.writeFile(canonicalRailwayAppInventory(inventory), "utf8");
  } finally {
    await handle.close();
  }
  process.stdout.write(`${JSON.stringify({ schema: inventory.schema, packages: inventory.packages.length, files: inventory.dependencyFiles.length })}\n`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Railway inventory build failed.");
  process.exitCode = 1;
});
