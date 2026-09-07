import { resolve } from "node:path";
import { readRailwayDeploymentEvidence } from "../src/deployment/railwayEvidence.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== "--in" || argv[1]?.trim() === "") {
    throw new Error("Usage: railway-verify-evidence --in <captured-evidence.json>");
  }
  const evidence = await readRailwayDeploymentEvidence(resolve(argv[1]!));
  process.stdout.write(`${JSON.stringify({
    schema: evidence.schema,
    imageDigest: evidence.imageDigest,
    capturedAt: evidence.capturedAt,
    services: evidence.services.map(({ name, role }) => ({ name, role })),
  })}\n`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Railway evidence verification failed.");
  process.exitCode = 1;
});
