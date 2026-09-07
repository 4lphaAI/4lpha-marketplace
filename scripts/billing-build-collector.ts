import { readFile } from "node:fs/promises";
import {
  billingCollectorBuildManifest,
  canonicalBillingCollectorBuildManifest,
  compileBillingCollector,
} from "../src/billing/collectorCompiler.js";

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node --import tsx scripts/billing-build-collector.ts");
  }
  const source = await readFile(new URL("../contracts/BillingCollector.sol", import.meta.url), "utf8");
  const artifact = await compileBillingCollector(source);
  process.stdout.write(`${canonicalBillingCollectorBuildManifest(billingCollectorBuildManifest(artifact))}\n`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "BillingCollector build failed.");
  process.exitCode = 1;
});
