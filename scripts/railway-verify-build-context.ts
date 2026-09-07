import { resolve } from "node:path";
import { verifyRailwayDockerContext } from "../src/deployment/dockerContext.js";

const root = resolve(import.meta.dirname, "..");
await verifyRailwayDockerContext(root).then(
  (files) => process.stdout.write(`${JSON.stringify({ schema: "4lpha.railway-build-context.v1", files })}\n`),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Railway build context verification failed.");
    process.exitCode = 1;
  },
);
