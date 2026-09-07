import { constants } from "node:fs";
import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyRailwayBaseProvenance } from "../src/deployment/ociLayout.js";

function fields(argv: readonly string[]): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined ||
        !["--manifest", "--config", "--out"].includes(name) || output[name] !== undefined) {
      throw new Error("Usage: railway-ingest-base-provenance --manifest <raw-file> --config <raw-file> --out <new-directory>");
    }
    output[name] = value;
  }
  if (Object.keys(output).length !== 3) {
    throw new Error("Railway base provenance ingestion requires exactly three options.");
  }
  return output;
}

async function main(): Promise<void> {
  const selected = fields(process.argv.slice(2));
  const manifest = resolve(selected["--manifest"]!);
  const config = resolve(selected["--config"]!);
  const output = resolve(selected["--out"]!);
  if (await lstat(output).then(() => true, () => false)) {
    throw new Error("Railway base provenance output must not already exist.");
  }
  await mkdir(output, { mode: 0o755 });
  try {
    await copyFile(manifest, join(output, "manifest.json"), constants.COPYFILE_EXCL);
    await copyFile(config, join(output, "config.json"), constants.COPYFILE_EXCL);
    const verified = await verifyRailwayBaseProvenance(output);
    process.stdout.write(`${JSON.stringify({
      schema: "4lpha.railway-base-provenance.v1",
      manifestDigest: verified.manifestDigest,
      configDigest: verified.configDigest,
      layerCount: verified.layerDescriptors.length,
    })}\n`);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Railway base provenance ingestion failed.");
  process.exitCode = 1;
});
