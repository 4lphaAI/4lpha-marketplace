import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalRailwayOciEvidence,
  inspectRailwayOciLayout,
} from "../src/deployment/ociEvidence.js";

function fields(argv: readonly string[]): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined ||
        !["--base-provenance", "--oci-layout", "--lock", "--marker-env", "--out"].includes(name) || output[name] !== undefined) {
      throw new Error("Usage: railway-inspect-image --base-provenance <dir> --oci-layout <dir> --lock <file> --marker-env <NAME[,NAME...]> --out <new-file>");
    }
    output[name] = value;
  }
  if (Object.keys(output).length !== 5) throw new Error("Railway OCI inspector requires exactly five options.");
  return output;
}

async function main(): Promise<void> {
  const selected = fields(process.argv.slice(2));
  const markerNames = selected["--marker-env"]!.split(",");
  if (markerNames.some((name) => !/^[A-Z][A-Z0-9_]{0,63}$/u.test(name)) || new Set(markerNames).size !== markerNames.length) {
    throw new Error("Release marker environment names are malformed or duplicated.");
  }
  const forbiddenMarkers = markerNames.map((name) => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error("Every release marker environment variable must be nonempty.");
    return Buffer.from(value, "utf8");
  });
  const evidence = await inspectRailwayOciLayout({
    baseProvenance: resolve(selected["--base-provenance"]!),
    ociLayout: resolve(selected["--oci-layout"]!),
    lockPath: resolve(selected["--lock"]!),
    forbiddenMarkers,
  });
  const handle = await open(resolve(selected["--out"]!), "wx", 0o600);
  try {
    await handle.writeFile(canonicalRailwayOciEvidence(evidence), "utf8");
  } finally {
    await handle.close();
  }
  process.stdout.write(`${JSON.stringify({ schema: evidence.schema, imageDigest: evidence.imageDigest })}\n`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Railway OCI inspection failed.");
  process.exitCode = 1;
});
