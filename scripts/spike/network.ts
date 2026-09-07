/**
 * The ONE place `SPIKE_NETWORK` is read.
 *
 * It used to be read in three: the spike script chose the chain, the state
 * module chose the file name, and neither knew what the other decided. Two
 * independent reads of the same env var is one deploy-time typo away from a
 * mainnet run recording its verdicts into the testnet state file — and the
 * verdicts are what tell the next run "step 8 already swept, skip it".
 */
import { BNB, BNB_TESTNET, type NetworkConfig } from "@altananetwork/sdk";
import { readEnvValue } from "./env.js";
import type { SpikeNetworkName } from "./state.js";

export const SPIKE_NETWORK: SpikeNetworkName =
  readEnvValue("SPIKE_NETWORK") === "mainnet" ? "mainnet" : "testnet";

export const IS_MAINNET = SPIKE_NETWORK === "mainnet";

export const NETWORK: NetworkConfig = IS_MAINNET ? BNB : BNB_TESTNET;

/** Native-token label for console output. */
export const UNIT = IS_MAINNET ? "BNB" : "tBNB";

/**
 * RPC endpoints for reads and for the owner-only recovery path, in preference
 * order. `SPIKE_RPC_URL` overrides; the rest are fallbacks the provider
 * rotates through when one is unreachable or reports the wrong chain.
 *
 * Mainnet leads with bsc-dataseed because the SDK's default publicnode
 * endpoint rejected viem write-path calls with "invalid parameters" during the
 * first mainnet run — see FINDINGS.md, mainnet addendum.
 */
export const RPC_URLS: readonly string[] = (() => {
  const override = readEnvValue("SPIKE_RPC_URL");
  const defaults = IS_MAINNET
    ? [
        "https://bsc-dataseed.bnbchain.org",
        "https://bsc-dataseed1.defibit.io",
        NETWORK.publicRpcUrl,
      ]
    : [NETWORK.publicRpcUrl];
  const ordered =
    override === undefined || override.length === 0
      ? defaults
      : [override, ...defaults];
  return [...new Set(ordered)];
})();

/** Exact value `SPIKE_CONFIRM_MAINNET` must carry to unlock a mainnet run. */
export const MAINNET_CONFIRMATION = "i-understand-real-funds";

/**
 * Gate on real funds.
 *
 * The spike sends value, grants a session that costs a registration fee, and
 * sweeps a wallet. On chain 56 every one of those is irreversible and paid for
 * in real BNB, so it takes an explicit acknowledgement rather than an env var
 * someone left exported in a shell from last week.
 */
export function assertMainnetConfirmed(): void {
  if (!IS_MAINNET) return;
  if (readEnvValue("SPIKE_CONFIRM_MAINNET") !== MAINNET_CONFIRMATION) {
    throw new Error(
      `SPIKE_NETWORK=mainnet spends REAL BNB and cannot be undone. Re-run with SPIKE_CONFIRM_MAINNET=${MAINNET_CONFIRMATION} to confirm.`,
    );
  }
}
