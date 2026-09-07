/**
 * Provider-per-chain registry.
 *
 * Phase 1 runs on a single chain (BNB), but the execution plane resolves a
 * provider by chainId rather than reaching for a module-level singleton. That
 * one indirection is the whole seam: adding a second chain later is a new
 * registry entry, not a change at every call site.
 */
import type { NetworkConfig } from "@altananetwork/sdk";
import type { ProviderRegistry, WalletProvider } from "../core/types.js";
import { AltanaProvider, type AltanaProviderOptions } from "./altana.js";

/** One chain's provider configuration. */
export type ProviderRegistryEntry = {
  readonly network: NetworkConfig;
  /** Per-chain provider options (RPC overrides, transport injection, …). */
  readonly options?: Omit<AltanaProviderOptions, "network">;
};

/**
 * Build a registry from one entry per chain.
 *
 * Duplicate chain ids are rejected at construction: a registry that silently
 * kept the last writer would route a chain to a provider the caller did not
 * expect. Each entry becomes an `AltanaProvider`; the registry itself is
 * provider-agnostic and returns them behind `WalletProvider`.
 */
export function createProviderRegistry(
  entries: readonly ProviderRegistryEntry[],
): ProviderRegistry {
  const providers = new Map<number, WalletProvider>();
  for (const entry of entries) {
    const chainId = entry.network.chainId;
    if (providers.has(chainId)) {
      throw new Error(
        `Duplicate provider registry entry for chain ${chainId}.`,
      );
    }
    providers.set(
      chainId,
      new AltanaProvider({ network: entry.network, ...(entry.options ?? {}) }),
    );
  }

  return {
    get(chainId: number): WalletProvider {
      const provider = providers.get(chainId);
      if (provider === undefined) {
        throw new Error(
          `No wallet provider is configured for chain ${chainId}.`,
        );
      }
      return provider;
    },
  };
}
