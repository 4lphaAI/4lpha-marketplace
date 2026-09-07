import { readFile } from "node:fs/promises";
import { compileBillingCollector } from "../src/billing/collectorCompiler.js";
import {
  billingCollectorDeploymentIntent,
  canonicalBillingCollectorDeploymentArtifacts,
  createBillingCollectorDeploymentArtifacts,
} from "../src/billing/collectorDeployment.js";

function argumentsOf(argv: readonly string[]): Readonly<{
  treasury: string;
  deployer: string;
  nonce: string;
}> {
  const fields = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined ||
        (name !== "--treasury" && name !== "--deployer" && name !== "--nonce") ||
        fields.has(name)) {
      throw new Error("Usage: node --import tsx scripts/billing-deployment-intent.ts --treasury <address> --deployer <address> --nonce <decimal>");
    }
    fields.set(name, value);
  }
  const treasury = fields.get("--treasury");
  const deployer = fields.get("--deployer");
  const nonce = fields.get("--nonce");
  if (fields.size !== 3 || treasury === undefined || deployer === undefined || nonce === undefined) {
    throw new Error("Usage: node --import tsx scripts/billing-deployment-intent.ts --treasury <address> --deployer <address> --nonce <decimal>");
  }
  return { treasury, deployer, nonce };
}

async function main(): Promise<void> {
  const input = argumentsOf(process.argv.slice(2));
  const intent = billingCollectorDeploymentIntent({ chainId: 56, ...input });
  const source = await readFile(new URL("../contracts/BillingCollector.sol", import.meta.url), "utf8");
  const artifact = await compileBillingCollector(source);
  const deployment = createBillingCollectorDeploymentArtifacts(artifact, intent);
  process.stdout.write(`${canonicalBillingCollectorDeploymentArtifacts(deployment)}\n`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "BillingCollector deployment-intent build failed.");
  process.exitCode = 1;
});
