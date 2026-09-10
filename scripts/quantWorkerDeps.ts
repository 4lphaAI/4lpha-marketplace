/**
 * ONE composition of `QuantWorkerDeps`, shared by the daemon and by
 * `live-quant worker` (R2.13 / BC35: the daemon and the CLI coordinate through
 * the same locks and fences, so they must also drive the same dependencies —
 * two compositions is how a CLI ends up running a slightly different worker).
 */
import { BNB } from "@altananetwork/sdk";
import { createPublicClient, fallback, getAddress, http } from "viem";
import { bsc } from "viem/chains";
import type { ExecutionJournal } from "../src/store/journal.js";
import type { QuantJobStore } from "../src/store/quantJobs.js";
import type { QuantRuntimeConfig } from "../src/quant/config.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { QuantTransport } from "../src/quant/termix.js";
import type { QuantWorkerDeps } from "../src/quant/worker.js";
import type { AltanaProvider } from "../src/wallet/altana.js";
import { QUANT_ENVELOPE_ALGORITHM, publicKeyEquals, type QuantKeypair } from "../src/quant/envelope.js";
import { assertReconcileGuardCoversSubmitWindow } from "../src/store/journal.js";
import type { WalletProvider } from "../src/core/types.js";
import { ACCOUNT_ABI, KEYSTORE_ABI } from "../src/wallet/abis.js";

export type QuantWorkerComposition = {
  readonly config: QuantRuntimeConfig;
  readonly store: QuantJobStore;
  readonly journal: ExecutionJournal;
  readonly transport: QuantTransport;
  readonly reader: QuantChainReader;
  readonly provider: AltanaProvider;
};

export async function buildWorkerDeps(
  input: QuantWorkerComposition,
  signal?: AbortSignal,
): Promise<QuantWorkerDeps> {
  const { config } = input;
  const publicClient = createPublicClient({
    chain: bsc,
    transport: fallback(config.rpcUrls.map((url) => http(url))),
  });
  return {
    store: input.store,
    journal: input.journal,
    provider: input.provider,
    reader: input.reader,
    transport: input.transport,
    keypair: quantKeypairFromSeed(config.envelopeKey),
    params: config.params,
    strategyId: config.strategyId,
    agentId: config.agentId,
    paramsDigest: config.paramsDigest,
    venue: {
      router: config.router, u: config.u, wbnb: config.wbnb, pair: config.pair,
    },
    chainAdmission: {
      async isValidKey(wallet, keyHash) {
        return publicClient.readContract({
          address: getAddress(BNB.keyStore), abi: KEYSTORE_ABI,
          functionName: "isValidKey", args: [wallet, keyHash],
        });
      },
      async accountKeys(wallet) {
        const [keys, hashes] = await publicClient.readContract({
          address: wallet, abi: ACCOUNT_ABI, functionName: "getKeys",
        });
        return hashes.map((keyHash, index) => ({
          keyHash,
          isSuperAdmin: keys[index]?.isSuperAdmin === true,
        }));
      },
      async canExecute(wallet, keyHash, target, data) {
        return publicClient.readContract({
          address: wallet, abi: ACCOUNT_ABI, functionName: "canExecute",
          args: [keyHash, target, data],
        });
      },
    },
    intervalMs: config.intervalMs,
    nowMs: Date.now,
    log: console.log,
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * The boot assertions the daemon AND the CLI run before a cycle (QUANT-SELFTEST
 * R5): the registry block is checked never adapted to (§2.1), the pair is
 * derived from the factory and cross-checked (§4.3), and the registered key
 * must be the one this seed derives — a worker under the wrong seed opens
 * nothing and looks idle.
 */
export async function assertQuantBoot(input: {
  readonly transport: QuantTransport;
  readonly reader: QuantChainReader;
  readonly config: QuantRuntimeConfig;
  readonly keypair: QuantKeypair;
  readonly provider: WalletProvider;
}): Promise<void> {
  const { transport, reader, config, keypair, provider } = input;
  const chainId = await reader.chainId();
  if (chainId !== 56) throw new Error("Boot refused: the quant RPC must report chain 56.");
  assertReconcileGuardCoversSubmitWindow(provider);
  if (provider.restoreGrantedSession === undefined || provider.readSpendInfos === undefined) {
    throw new Error(
      "Boot refused: this provider cannot restore an externally granted session or read "
      + "its spend meters. Both are capability facts, knowable here rather than at the first action.",
    );
  }
  const block = await transport.config();
  if (!block.ok) throw new Error("quant boot could not read the venue config.");
  if (block.data.chainId !== 56) throw new Error("Boot refused: the venue block reports a chain other than 56.");
  if (getAddress(block.data.u) !== getAddress(config.u)) {
    throw new Error("Boot refused: the venue block's U address is not the pinned constant.");
  }
  if (block.data.tradableTokens.length !== 1) {
    throw new Error("Boot refused: the tradable set is not exactly one token.");
  }
  const token = block.data.tradableTokens[0];
  if (token === undefined
    || getAddress(token.address) !== getAddress(config.wbnb)
    || token.priceRoute !== "direct") {
    throw new Error("Boot refused: the tradable token is not WBNB with a direct route.");
  }
  const venues = block.data.venueAllowlist.map((address) => getAddress(address).toLowerCase());
  if (!venues.includes(getAddress(config.router).toLowerCase())) {
    throw new Error("Boot refused: the pinned Pancake V2 router is not in the venue allowlist.");
  }
  const derivedPair = await reader.getPair(config.factory, config.u, config.wbnb);
  if (getAddress(derivedPair) !== getAddress(config.pair)) {
    throw new Error("Boot refused: the V2 factory's U/WBNB pair does not equal the pinned pair address.");
  }
  const registered = await transport.agentKey(config.agentId);
  if (!registered.ok) throw new Error("quant boot could not read the registered agent key.");
  if (registered.data.encryptionPublicKey === null) {
    throw new Error(
      "Boot refused: no encryption key is registered for this agent. "
      + "Run `npm run live-quant -- register-key --agent <id>` (or the self-test grant) first.",
    );
  }
  if (!publicKeyEquals(Buffer.from(registered.data.encryptionPublicKey, "base64"), keypair.publicKey)) {
    throw new Error(
      "Boot refused: the registered key is not the one this seed derives. "
      + "A worker under the wrong seed opens nothing and looks idle.",
    );
  }
  if (registered.data.algorithm !== null && registered.data.algorithm !== QUANT_ENVELOPE_ALGORITHM) {
    throw new Error("Boot refused: the registered envelope algorithm is not the one we implement.");
  }
}
