/**
 * READ-ONLY enablement probe for Marketplace Hire.
 *
 * It enumerates the public relay and KeyStore evidence the convergence worker
 * depends on. It never signs, submits, grants, revokes, or reads a private key.
 * Run only as the explicit pre-enable live exercise recorded in the phase doc.
 */
import { BNB } from "@altananetwork/sdk";
import * as RelayActions from "porto/viem/RelayActions";
import { createClient, createPublicClient, getAddress, http, zeroAddress, type Hex } from "viem";
import { createKeyStoreReader } from "../src/account/keyStoreReader.js";
import { normalizeGrantPermissions } from "../src/wallet/grantEvidence.js";
import { ACCOUNT_ABI } from "../src/wallet/abis.js";

const rawWallet = process.argv[2];
if (rawWallet === undefined) throw new Error("Usage: tsx scripts/hire-evidence-probe.ts <wallet-address>");
const wallet = getAddress(rawWallet);
if (BNB.relayUrl === undefined) throw new Error("The installed BNB network has no relay URL.");

const relay = createClient({ chain: BNB.chain, transport: http(BNB.relayUrl, { timeout: 60_000 }) });
const rpc = createPublicClient({ chain: BNB.chain, transport: http(BNB.publicRpcUrl) });
if (await rpc.getChainId() !== 56) throw new Error("The configured public RPC did not serve BNB Chain 56.");
const keyStore = createKeyStoreReader({
  network: { chain: BNB.chain, chainId: 56, publicRpcUrl: BNB.publicRpcUrl },
  keyStore: getAddress(BNB.keyStore),
});

const [relayKeys, keyIds, balanceWei] = await Promise.all([
  RelayActions.getKeys(relay, { account: wallet, chainIds: [56] }),
  keyStore.listKeys(wallet),
  rpc.getBalance({ address: wallet }),
]);

const relayKeyEvidence = await Promise.all(relayKeys.map(async (key) => {
  const calls = normalizeGrantPermissions({ kind: "relay", value: key.permissions ?? {} }).calls;
  const callRules = await Promise.all(calls.map(async (callRule) => ({
    ...callRule,
    canExecute: await rpc.readContract({
      address: wallet,
      abi: ACCOUNT_ABI,
      functionName: "canExecute",
      args: [
        key.hash as Hex,
        callRule.to === "*" ? zeroAddress : getAddress(callRule.to),
        callRule.selector === "*" ? "0x" : callRule.selector as Hex,
      ],
    }),
  })));
  return { key, callRules };
}));
const everyCallRuleExecutable = relayKeyEvidence.every(({ callRules }) =>
  callRules.every(({ canExecute }) => canExecute));

console.log(JSON.stringify({
  chainId: 56,
  wallet,
  relayKeys: relayKeyEvidence.map(({ key, callRules }) => ({
    hash: key.hash,
    expiry: key.expiry,
    role: key.role,
    callPermissionCount: key.permissions?.calls?.length ?? 0,
    spendPermissionCount: key.permissions?.spend?.length ?? 0,
    callRules,
  })),
  keyStoreKeyIds: keyIds,
  balanceWei: balanceWei.toString(10),
}, null, 2));

if (!everyCallRuleExecutable) process.exitCode = 1;
