/** Capability-restricted public-RPC mirror of the session preflight. */
import type { NetworkConfig } from "@altananetwork/sdk";
import { createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, padHex, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { SessionSpec, WalletCall } from "../core/types.js";
import { isSessionExpired, structuralTargetRefusal, VALUE_MOVING_SELECTORS } from "../core/session.js";
import { ACCOUNT_ABI, ERC20_ABI } from "./abis.js";

const MAX_CALLS = 20;
type Session = { readonly walletAddress: Address; readonly publicKey: Hex; readonly spec: SessionSpec };
type Spend = { readonly token: Address; readonly limit: bigint };

export async function preflightSessionCallsReadOnly(input: { readonly network: NetworkConfig;
  readonly rpcUrl: string; readonly session: Session; readonly calls: readonly WalletCall[] }): Promise<void> {
  if (input.calls.length === 0 || input.calls.length > MAX_CALLS || isSessionExpired(input.session.spec)) {
    throw new Error("Session preflight refused.");
  }
  for (const call of input.calls) if (structuralTargetRefusal(call.to, {
    walletAddress: input.session.walletAddress, keyStoreAddress: input.network.keyStore,
  }) !== null) throw new Error("Session preflight refused.");
  const refused = input.calls.filter((call) => !snapshotAllows(input.session.spec, call));
  if (refused.length === 0) return;
  const client = createPublicClient({ chain: input.network.chain, transport: http(input.rpcUrl, { timeout: 45_000 }) });
  const wallet = getAddress(input.session.walletAddress);
  const keyHash = accountKeyHash(publicKeyToAddress(input.session.publicKey));
  const [keysResult, infosResult, verdicts] = await Promise.all([
    client.readContract({ address: wallet, abi: ACCOUNT_ABI, functionName: "getKeys" }),
    client.readContract({ address: wallet, abi: ACCOUNT_ABI, functionName: "spendInfos", args: [keyHash] }),
    Promise.all(refused.map((call) => client.readContract({ address: wallet, abi: ACCOUNT_ABI,
      functionName: "canExecute", args: [keyHash, call.to, call.data ?? "0x"] }))),
  ]);
  const [keys, hashes] = keysResult;
  const index = hashes.findIndex((hash) => hash.toLowerCase() === keyHash.toLowerCase());
  if (index < 0 || keys[index]?.isSuperAdmin !== false || verdicts.some((allowed) => !allowed)) {
    throw new Error("Session preflight refused.");
  }
  const infos = infosResult as readonly Spend[];
  for (const call of refused) {
    const selector = call.data === undefined || call.data.length < 10 ? undefined : call.data.slice(0, 10).toLowerCase();
    if (selector !== undefined && VALUE_MOVING_SELECTORS.has(selector) && !hasSpend(infos, call.to)) {
      throw new Error("Session preflight refused.");
    }
  }
}

/** Same authoritative sell-leg fallback used by LP admission: approve + cap. */
export async function canSessionSellTokenReadOnly(input: { readonly network: NetworkConfig;
  readonly rpcUrl: string; readonly walletAddress: Address; readonly publicKey: Hex; readonly token: Address }): Promise<boolean> {
  const client = createPublicClient({ chain: input.network.chain, transport: http(input.rpcUrl, { timeout: 45_000 }) });
  const keyHash = accountKeyHash(publicKeyToAddress(input.publicKey));
  const approve = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [input.walletAddress, 1n] });
  const [infos, allowed] = await Promise.all([
    client.readContract({ address: input.walletAddress, abi: ACCOUNT_ABI, functionName: "spendInfos", args: [keyHash] }),
    client.readContract({ address: input.walletAddress, abi: ACCOUNT_ABI, functionName: "canExecute", args: [keyHash, input.token, approve] }),
  ]);
  return allowed && hasSpend(infos as readonly Spend[], input.token);
}

function snapshotAllows(spec: SessionSpec, call: WalletCall): boolean {
  const selector = call.data === undefined || call.data.length < 10 ? undefined : call.data.slice(0, 10).toLowerCase();
  return spec.allowedCalls.some((rule) => (rule.to === undefined || rule.to.toLowerCase() === call.to.toLowerCase()) &&
    (rule.selector === undefined || rule.selector.toLowerCase() === selector));
}
function hasSpend(infos: readonly Spend[], token: Address): boolean {
  return infos.some((info) => info.limit > 0n && info.token.toLowerCase() === token.toLowerCase());
}
function accountKeyHash(address: Address): Hex {
  const publicKeyHash = keccak256(padHex(getAddress(address), { size: 32 }));
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, publicKeyHash]));
}
