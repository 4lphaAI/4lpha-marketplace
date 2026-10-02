/**
 * TradFi aggregator guard — gates G1 (compile repro), G2 (deploy), G3 (BscScan input).
 *
 * Default is a DRY RUN: compiles `contracts/TradFiSwapGuard.sol` with the pinned manifest,
 * proves the runtime reproduces the reviewed template (the same check the plane runs on the
 * deployed bytecode), predicts the codehash, and writes the BscScan standard-JSON input.
 * Nothing is signed and no RPC is contacted.
 *
 * Deploy (spends BNB, operator only):
 *   GUARD_DEPLOYER_PRIVATE_KEY=0x… node --import tsx scripts/deploy-tradfi-guard.ts --send --confirm <deployerAddress>
 * The key is read from the process environment only — never from an .env file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeAbiParameters, getAddress, http, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import {
  assertTradfiGuardRuntimeExact, TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56,
  TRADFI_GUARD_RUNTIME_IMMUTABLE_REFERENCES, TRADFI_SWAP_GUARD_ABI,
} from "../src/trade/guard.js";
import { USDT_56 } from "../src/trade/settlement.js";

const RPCS = ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com"] as const;
const OUT_DIR = new URL("./tmp/tradfi-guard-deploy/", import.meta.url);
const ROUTER_REFS = new Set([297, 1913]);
const USDT_REFS = new Set([173, 471]);

const args = process.argv.slice(2);
const send = args.includes("--send");
const confirm = args[args.indexOf("--confirm") + 1];

const source = readFileSync(new URL("../contracts/TradFiSwapGuard.sol", import.meta.url), "utf8");
const input = {
  language: "Solidity",
  sources: { "TradFiSwapGuard.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: false, evmVersion: "paris",
    metadata: { bytecodeHash: "none", appendCBOR: false },
    outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
const solc = (await import("solc")).default as unknown as { compile(input: string): string; version(): string };
const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: { severity: string; formattedMessage: string }[];
  contracts: Record<string, Record<string, { evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
};
const errors = (output.errors ?? []).filter((row) => row.severity === "error");
if (errors.length) throw new Error(errors.map((row) => row.formattedMessage).join("\n"));
const artifact = output.contracts["TradFiSwapGuard.sol"]?.["TradFiSwapGuard"];
if (!artifact) throw new Error("TradFiSwapGuard artifact missing.");

// G1: rebuild the runtime the constructor will produce and run the plane's own exact check on it.
const word = (address: Address) => address.slice(2).toLowerCase().padStart(64, "0");
let runtime = artifact.evm.deployedBytecode.object;
for (const ref of TRADFI_GUARD_RUNTIME_IMMUTABLE_REFERENCES) {
  const value = ROUTER_REFS.has(ref.start) ? TRADFI_BINANCE_FLASH_ROUTER_56
    : USDT_REFS.has(ref.start) ? USDT_56 : TRADFI_BINANCE_FLASH_SPENDER_56;
  runtime = runtime.slice(0, ref.start * 2) + word(value) + runtime.slice((ref.start + ref.length) * 2);
}
const expectedRuntime = `0x${runtime}` as Hex;
assertTradfiGuardRuntimeExact({ deployedRuntime: expectedRuntime, router: TRADFI_BINANCE_FLASH_ROUTER_56,
  spender: TRADFI_BINANCE_FLASH_SPENDER_56, canonicalUSDT: USDT_56 });
const predictedCodehash = keccak256(expectedRuntime);
const constructorArgs = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }],
  [TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56, USDT_56]);
const creation = `0x${artifact.evm.bytecode.object}${constructorArgs.slice(2)}` as Hex;

// G3 input: BscScan "Solidity (Standard-Json-Input)", compiler v0.8.30+commit.73712a01.
mkdirSync(OUT_DIR, { recursive: true });
const verifyInput = { ...input, settings: { ...input.settings, outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } } } };
writeFileSync(new URL("standard-input.json", OUT_DIR), JSON.stringify(verifyInput, null, 2));
writeFileSync(new URL("constructor-args.txt", OUT_DIR), `${constructorArgs.slice(2)}\n`);

console.log(`[G1] solc ${solc.version()}`);
console.log(`[G1] runtime ${(expectedRuntime.length - 2) / 2} bytes — reviewed template + immutables: OK`);
console.log(`[G1] predicted codehash ${predictedCodehash}`);
console.log(`[G1] constructor (router, spender, USDT) = (${TRADFI_BINANCE_FLASH_ROUTER_56}, ${TRADFI_BINANCE_FLASH_SPENDER_56}, ${USDT_56})`);
console.log(`[G3] BscScan input written to scripts/tmp/tradfi-guard-deploy/ (standard-input.json, constructor-args.txt)`);

if (!send) {
  console.log("Dry run only. Nothing was signed or sent.");
  process.exit(0);
}

// G2: deploy. Operator-only; spends BNB.
const key = process.env["GUARD_DEPLOYER_PRIVATE_KEY"];
if (!key || !/^0x[0-9a-fA-F]{64}$/u.test(key)) throw new Error("Set GUARD_DEPLOYER_PRIVATE_KEY in the shell (0x + 64 hex).");
const account = privateKeyToAccount(key as Hex);
if (!confirm || getAddress(confirm) !== account.address) throw new Error(`Pass --confirm ${account.address} to deploy from that address.`);
const client = createPublicClient({ chain: bsc, transport: http(RPCS[0]) });
const wallet = createWalletClient({ chain: bsc, account, transport: http(RPCS[0]) });
if (await client.getChainId() !== 56) throw new Error("RPC is not BSC mainnet.");
const [balance, gas, gasPrice] = await Promise.all([
  client.getBalance({ address: account.address }), client.estimateGas({ account: account.address, data: creation }), client.getGasPrice(),
]);
console.log(`[G2] deployer ${account.address} balance ${balance} wei; estimate ${gas} gas × ${gasPrice} wei = ${gas * gasPrice} wei`);
if (balance < (gas * gasPrice * 12n) / 10n) throw new Error("Deployer balance is below 1.2 × the estimated cost.");
const hash = await wallet.sendTransaction({ data: creation, gas: (gas * 12n) / 10n });
console.log(`[G2] tx ${hash}`);
const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 3 });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment failed: ${receipt.status}`);
const guard = getAddress(receipt.contractAddress);
for (const rpc of RPCS) {
  const reader = createPublicClient({ chain: bsc, transport: http(rpc) });
  const deployed = await reader.getBytecode({ address: guard });
  if (!deployed) throw new Error(`${rpc}: no code at ${guard}`);
  assertTradfiGuardRuntimeExact({ deployedRuntime: deployed, router: TRADFI_BINANCE_FLASH_ROUTER_56,
    spender: TRADFI_BINANCE_FLASH_SPENDER_56, canonicalUSDT: USDT_56 });
  if (keccak256(deployed) !== predictedCodehash) throw new Error(`${rpc}: codehash differs from the prediction.`);
}
const [router, spender, canonicalUSDT] = await Promise.all((["router", "spender", "canonicalUSDT"] as const)
  .map((functionName) => client.readContract({ address: guard, abi: TRADFI_SWAP_GUARD_ABI, functionName }) as Promise<Address>));
if (getAddress(router) !== TRADFI_BINANCE_FLASH_ROUTER_56 || getAddress(spender) !== TRADFI_BINANCE_FLASH_SPENDER_56 || getAddress(canonicalUSDT) !== USDT_56) {
  throw new Error("Guard getters do not match the constructor arguments.");
}
console.log(`[G2] guard ${guard} block ${receipt.blockNumber} gasUsed ${receipt.gasUsed} effectiveGasPrice ${receipt.effectiveGasPrice}`);
console.log(`[G2] runtime verified on ${RPCS.length} RPCs; codehash ${predictedCodehash}`);
console.log(`[G4] TRADFI_BINANCE_GUARD_ADDRESS=${guard}`);
console.log(`[G4] TRADFI_BINANCE_GUARD_RUNTIME_CODEHASH=${predictedCodehash}`);
