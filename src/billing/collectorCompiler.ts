import { keccak256, type Hex } from "viem";

export const BILLING_COLLECTOR_SOLC_VERSION = "0.8.30";
export const BILLING_COLLECTOR_COMPILER_SETTINGS = Object.freeze({
  optimizer: { enabled: true, runs: 200 },
  viaIR: false,
  evmVersion: "paris",
  metadata: { bytecodeHash: "none", appendCBOR: false },
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
});

type SolcOutput = Readonly<{
  errors?: readonly Readonly<{ severity: string; formattedMessage: string }>[];
  contracts?: Readonly<Record<string, Readonly<Record<string, Readonly<{
    abi: unknown;
    evm: Readonly<{
      bytecode: Readonly<{ object: string }>;
      deployedBytecode: Readonly<{ object: string }>;
    }>;
  }>>>>>;
}>;

type SolcModule = Readonly<{
  default: Readonly<{
    version(): string;
    compile(input: string): string;
  }>;
}>;

export type BillingCollectorArtifact = Readonly<{
  solcVersion: string;
  abi: unknown;
  creationBytecode: Hex;
  runtimeBytecode: Hex;
  creationBytecodeHash: Hex;
  runtimeBytecodeHash: Hex;
}>;

/** Reproducible offline compiler seam. This function never deploys. */
export async function compileBillingCollector(source: string): Promise<BillingCollectorArtifact> {
  const specifier = "solc";
  const module = (await import(specifier)) as unknown as SolcModule;
  const solc = module.default;
  const version = solc.version();
  if (!version.startsWith(`${BILLING_COLLECTOR_SOLC_VERSION}+`)) {
    throw new Error(`BillingCollector requires solc ${BILLING_COLLECTOR_SOLC_VERSION}.`);
  }
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "BillingCollector.sol": { content: source } },
    settings: BILLING_COLLECTOR_COMPILER_SETTINGS,
  }))) as SolcOutput;
  const errors = output.errors?.filter((entry) => entry.severity === "error") ?? [];
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  const artifact = output.contracts?.["BillingCollector.sol"]?.["BillingCollector"];
  if (artifact === undefined) throw new Error("BillingCollector artifact is missing.");
  const creationBytecode = `0x${artifact.evm.bytecode.object}` as Hex;
  const runtimeBytecode = `0x${artifact.evm.deployedBytecode.object}` as Hex;
  return {
    solcVersion: version,
    abi: artifact.abi,
    creationBytecode,
    runtimeBytecode,
    creationBytecodeHash: keccak256(creationBytecode),
    runtimeBytecodeHash: keccak256(runtimeBytecode),
  };
}
