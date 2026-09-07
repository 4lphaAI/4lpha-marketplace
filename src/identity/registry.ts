import { createPublicClient, http, parseAbi, encodeFunctionData, decodeEventLog, keccak256, TransactionReceiptNotFoundError, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { fail, type IdentityBinding, type IdentityJob, type IdentityPhase, type UnsignedIntent } from "./types.js";

export const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId,string newURI)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
]);
export function phaseCalldata(job: Pick<IdentityJob, "initialUri" | "finalUri" | "mintedId">, phase: IdentityPhase): Hex {
  if (phase === "register") return encodeFunctionData({ abi: IDENTITY_ABI, functionName: "register", args: [job.initialUri] });
  if (job.mintedId === null || job.finalUri === null) fail("intent_mismatch");
  return encodeFunctionData({ abi: IDENTITY_ABI, functionName: "setAgentURI", args: [BigInt(job.mintedId), job.finalUri] });
}
export type RegistryReceipt = Pick<TransactionReceipt, "transactionHash" | "to" | "from" | "status" | "blockNumber" | "blockHash" | "logs">;
export interface RegistryGateway {
  probe(): Promise<void>;
  nonces(): Promise<{ readonly latest: number; readonly pending: number }>;
  fees(data: Hex): Promise<{ readonly estimate: bigint; readonly gasPrice: bigint; readonly balance: bigint }>;
  simulate(data: Hex): Promise<void>;
  sign(intent: UnsignedIntent): Promise<Hex>;
  broadcast(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<RegistryReceipt | null>;
  finalized(): Promise<bigint>;
  blockHash(block: bigint): Promise<Hex>;
  identity(id: string, block: bigint): Promise<{ readonly owner: Address; readonly uri: string }>;
}
export function registeredId(receipt: RegistryReceipt, binding: IdentityBinding, uri: string): string {
  const events: { readonly id: string; readonly uri: string; readonly owner: Address }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== binding.registry.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: IDENTITY_ABI, data: log.data, topics: log.topics, strict: true });
      if (event.eventName === "Registered") events.push({ id: event.args.agentId.toString(), uri: event.args.agentURI, owner: event.args.owner });
    } catch { /* Other registry events carry no identity evidence. */ }
  }
  if (events.length !== 1 || events[0]!.owner.toLowerCase() !== binding.minter.toLowerCase() || events[0]!.uri !== uri) fail("invalid_receipt");
  return events[0]!.id;
}
/** No client is constructed until the explicit CLI dependency factory calls this. */
export function createRegistryGateway(binding: IdentityBinding & { readonly rpcUrl: string }, key?: Hex): RegistryGateway {
  const client = createPublicClient({ chain: bsc, transport: http(binding.rpcUrl, { retryCount: 0, timeout: 15_000 }) });
  let signer: ReturnType<typeof privateKeyToAccount> | undefined;
  try { signer = key === undefined ? undefined : privateKeyToAccount(key); } catch { fail("invalid_config"); }
  if (signer !== undefined && signer.address.toLowerCase() !== binding.minter.toLowerCase()) fail("invalid_config");
  return {
    async probe() {
      if (await client.getChainId() !== 56) fail("invalid_config");
      const code = await client.getCode({ address: binding.registry, blockTag: "latest" });
      if (code === undefined || code === "0x") fail("invalid_config");
      // Inspect delegated code, while compatibility is decided by the actual call simulation.
      await client.getCode({ address: binding.minter, blockTag: "latest" });
    },
    async nonces() { return { latest: await client.getTransactionCount({ address: binding.minter, blockTag: "latest" }), pending: await client.getTransactionCount({ address: binding.minter, blockTag: "pending" }) }; },
    async fees(data) { return { estimate: await client.estimateGas({ account: binding.minter, to: binding.registry, data, value: 0n }), gasPrice: await client.getGasPrice(), balance: await client.getBalance({ address: binding.minter }) }; },
    async simulate(data) { await client.call({ account: binding.minter, to: binding.registry, data, value: 0n, blockTag: "latest" }); },
    async sign(intent) {
      if (!signer) fail("exclusive_required");
      return signer.signTransaction({ chainId: intent.chainId, type: "legacy", to: intent.to, nonce: intent.nonce, value: 0n, data: intent.data, gas: BigInt(intent.gas), gasPrice: BigInt(intent.gasPrice) });
    },
    async broadcast(raw) { const hash = await client.sendRawTransaction({ serializedTransaction: raw }); if (hash !== keccak256(raw)) fail("intent_mismatch"); return hash; },
    async receipt(hash) { try { return await client.getTransactionReceipt({ hash }); } catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; } },
    async finalized() { return (await client.getBlock({ blockTag: "finalized" })).number; },
    async blockHash(blockNumber) { return (await client.getBlock({ blockNumber })).hash; },
    async identity(id, blockNumber) { return { owner: await client.readContract({ address: binding.registry, abi: IDENTITY_ABI, functionName: "ownerOf", args: [BigInt(id)], blockNumber }), uri: await client.readContract({ address: binding.registry, abi: IDENTITY_ABI, functionName: "tokenURI", args: [BigInt(id)], blockNumber }) }; },
  };
}
