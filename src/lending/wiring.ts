/**
 * The lending composition seam — the ONE site that builds the guard's
 * collaborators, for BOTH the server and the worker
 * (MARKETPLACE-LENDING-AGENT §8.5, R2.19, R3.8).
 *
 * WHY THIS FILE EXISTS is `PHASE4-AUDIT.md` A1, and this phase inherits the
 * lesson rather than rediscovering it: `createServer` registers the lending
 * routes only when `deps.lending` is supplied, so a production entrypoint that
 * forgot to supply it would make `LENDING_ENABLED=true` enable NOTHING — every
 * owner route 404, no guard row ever written, the worker's queue permanently
 * empty, and the server looking healthy the whole time. Two composition sites
 * that drift are how a read side ends up reporting a cadence the writer does
 * not run on, so the construction lives HERE, once.
 *
 * Everything in this module is inert unless {@link resolveLendingEnabled} is
 * true — and that resolver is the one place `LP_ENABLED` and `HIRE_ENABLED` are
 * required, so a partial enablement fails the BOOT rather than a request.
 */
import { getAddress, type Address } from "viem";

import {
  resolveLendingEnabled,
  resolveLendingRpcUrls,
  resolveLendingRuntimeConfig,
} from "../ops/config.js";
import { parseLendingPreviewSecret } from "./preview.js";
import {
  createLendingChainReaders,
  type LendingChainReaders,
  type LendingVenue,
} from "./readers.js";
import {
  MemoryLendingGuardStore,
  createLendingGuardStore,
  type LendingGuardStore,
} from "../store/lendingGuards.js";
import {
  MemoryVenusSettingsStore,
  createVenusSettingsStore,
  type VenusSettingsStore,
} from "../store/venusSettings.js";
import {
  MemoryVenusObservationStore,
  createVenusObservationStore,
  type VenusObservationStore,
} from "../store/venusObservations.js";
import { createVenusChainReaders, type VenusReaderNetwork } from "../venus/readers.js";
import type { VenusVenue } from "../venus/types.js";
import type { VenusRoutingCensus } from "../ops/policy.js";
import { VENUS_CORE_COMPTROLLER_56 } from "../ops/config.js";

/** Exactly the shape `createServer` takes as `deps.lending`. */
export type BuiltLendingServerDeps = {
  readonly guards: LendingGuardStore;
  readonly settingsStore: VenusSettingsStore;
  readonly observations: VenusObservationStore;
  readonly readers: LendingChainReaders;
  readonly venue: LendingVenue;
  readonly venusVenue: VenusVenue;
  readonly intervalMs: number;
  readonly maxObservationAgeMs: number;
  readonly agentConcurrency: number;
  /**
   * The preview-receipt key. ABSENT is a supported state and it is
   * FAIL-CLOSED: `/lending/guardable` returns no receipt and S1 refuses
   * `preview-receipt-unavailable` (R3.8).
   */
  readonly previewSecret: Uint8Array | null;
  /** `rails.maxSagaSlippageBps` — the ONE slippage rail every leg floors on. */
  readonly maxSagaSlippageBps: number;
  /**
   * The R3.12 Venus routing census, read ONCE at boot (AUDIT A-M2).
   *
   * `lendingSessionSpec` asserts the census only when it is SUPPLIED, and S1
   * supplied nothing — so BUILD §4's overpay caveat, which rests on the
   * measured selector routing, was resting on a check that never ran on this
   * path. Reading it at boot is the cheapest place that still gates every
   * grant: the census is a property of the DEPLOYMENT, not of the hire, and a
   * process that booted against moved routing must not mint sessions at all.
   *
   * `undefined` only in the offline/test compositions that inject readers.
   */
  readonly routing?: VenusRoutingCensus;
};

export type BuildLendingServerDepsOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly network: VenusReaderNetwork;
  /** From the LP venue: the router, WBNB and the QuoterV2 (R2.19). */
  readonly lpVenue: {
    readonly routerV3: Address;
    readonly wbnb: Address;
    readonly quoterV2: Address;
    readonly factoryV3: Address;
    readonly maxSagaSlippageBps: number;
  };
  /**
   * OFFLINE REHEARSAL ONLY — `scripts/dev-stack.ts` and nothing else (§8.5).
   *
   * It skips the `DATABASE_URL` requirement and forces MEMORY stores, so an
   * operator can drive the worker's decision layer against a live chain with
   * no database. It is a NAMED carve-out rather than a weakened check for the
   * reason the check exists: a durable deployment that merely FORGOT
   * `DATABASE_URL` must still refuse, and it does, because the production
   * composition site never passes this.
   *
   * What it cannot rehearse is stated where it is used: memory stores die with
   * the process, so a dev-stack run can demonstrate the read side, the
   * staleness overlay and the dry-run gate — but it can NEVER prove the
   * restart property the durable counter exists for. The hire route itself
   * still needs Postgres.
   */
  readonly rehearsal?: true;
  /**
   * Injection seam, for tests ONLY (the PHASE4-FIXREVIEW F1 precedent).
   *
   * Production passes nothing and gets the real stores and a live chain
   * reader. Without this the function could not run offline at all — resolving
   * USDT is a chain read and validating the pool is another — so the A1 defect
   * it exists to prevent would have no regression test, which is exactly how
   * Phase 4 shipped it.
   */
  readonly overrides?: {
    readonly guards?: LendingGuardStore;
    readonly settingsStore?: VenusSettingsStore;
    readonly observations?: VenusObservationStore;
    readonly readers?: LendingChainReaders;
    /** Skips the `underlying()` read. Tests only. */
    readonly usdt?: Address;
    /** Skips the pool liveness proof. Tests only. */
    readonly swapPool?: Address;
  };
};

/** `vUSDT.underlying()` — the ONE place USDT's address comes from (R2.22). */
const VTOKEN_UNDERLYING_ABI = [
  {
    type: "function", name: "underlying", stateMutability: "view",
    inputs: [], outputs: [{ type: "address" }],
  },
] as const;

export async function buildLendingServerDeps(
  options: BuildLendingServerDepsOptions,
): Promise<BuiltLendingServerDeps | undefined> {
  if (!resolveLendingEnabled(options.env)) return undefined;

  // The same two deployment constraints the Venus wiring enforces, and for the
  // same reason: without them `LENDING_ENABLED=true` on a box with no
  // `DATABASE_URL` produces a server that ACCEPTS an owner-signed arm into a
  // memory store that evaporates on restart, while the worker on the same box
  // refuses to boot at all. Both refusals fail the BOOT, never a request.
  const databaseUrl = options.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "" && options.rehearsal !== true) {
    throw new Error(
      "LENDING_ENABLED is true but DATABASE_URL is unset. The lending guard row IS the "
      + "worker's queue and the arm's idle gate: a memory store here would accept an "
      + "owner-signed arm the worker can never see, and would evaporate on restart.",
    );
  }
  if (options.network.chainId !== 56) {
    throw new Error(
      `The lending guard is chain-56 only; this deployment resolves chain `
      + `${options.network.chainId}. The selector census was taken on BNB mainnet and `
      + "means nothing anywhere else.",
    );
  }

  const runtime = resolveLendingRuntimeConfig(options.env);
  const overrides = options.overrides ?? {};
  const previewSecret = parseLendingPreviewSecret(
    options.env["LENDING_PREVIEW_SECRET"],
  );

  const guards =
    overrides.guards
    ?? (options.rehearsal === true
      ? new MemoryLendingGuardStore()
      : await createLendingGuardStore());
  const settingsStore =
    overrides.settingsStore
    ?? (options.rehearsal === true
      ? new MemoryVenusSettingsStore()
      : await createVenusSettingsStore("lending"));
  const observations =
    overrides.observations
    ?? (options.rehearsal === true
      ? new MemoryVenusObservationStore()
      : await createVenusObservationStore("lending"));

  const venusVenue: VenusVenue = {
    comptroller: VENUS_CORE_COMPTROLLER_56,
    vBnb: runtime.venue.vBnb,
    // Prime plays no role in this phase — the guard claims nothing — but the
    // Venus reader constructor requires it, so it is pinned to the Comptroller's
    // own address ONLY when the operator did not configure one, and never
    // granted anything: `lendingSessionSpec` has no Prime rule at all.
    prime: resolvePrime(options.env),
    treasury: runtime.venue.treasury,
  };

  // USDT is DERIVED, never configured (R2.22): a mis-typed `LENDING_USDT_ADDRESS`
  // would put the approve rule, the cap and every swap leg on a token that is
  // not the vToken's underlying, and the mint would revert after the swap had
  // already spent the budget.
  const usdt = overrides.usdt ?? (await readUnderlying(options, runtime.venue.vUsdt));

  const venue: LendingVenue = {
    vUsdt: runtime.venue.vUsdt,
    usdt,
    vBnb: runtime.venue.vBnb,
    routerV3: getAddress(options.lpVenue.routerV3),
    wbnb: getAddress(options.lpVenue.wbnb),
    quoterV2: getAddress(options.lpVenue.quoterV2),
    factoryV3: getAddress(options.lpVenue.factoryV3),
    // Replaced below by the boot-proved pool when there is no override.
    swapPool: overrides.swapPool ?? getAddress(options.lpVenue.routerV3),
    swapFeeTier: runtime.venue.swapFeeTier,
    treasury: runtime.venue.treasury,
  };

  let readers =
    overrides.readers
    ?? createLendingChainReaders({
      network: options.network,
      rpcUrls: resolveLendingRpcUrls(options.env, options.network.publicRpcUrl),
      venue,
      venusVenue,
    });

  let resolvedVenue = venue;
  if (overrides.swapPool === undefined && overrides.readers === undefined) {
    // R2.19: PROVE the pinned tier's pool exists AND carries liquidity. A tier
    // whose pool is empty makes every swap leg unfillable, and discovering that
    // at the arm costs the owner a signature and a funded wallet.
    const pool = await readers.readSwapPool();
    if (pool.liquidity <= 0n) {
      throw new Error(
        `The WBNB/USDT pool at fee tier ${runtime.venue.swapFeeTier} (${pool.pool}) reports zero `
        + "liquidity. Every lending swap leg — the arm, the pool-cash fallback, the BNB rescue "
        + "and the retire — routes through it; refusing the boot rather than the arm.",
      );
    }
    resolvedVenue = { ...venue, swapPool: pool.pool };
    readers = createLendingChainReaders({
      network: options.network,
      rpcUrls: resolveLendingRpcUrls(options.env, options.network.publicRpcUrl),
      venue: resolvedVenue,
      venusVenue,
    });
  }

  // AUDIT A-M2 — THE ROUTING CENSUS, READ AT BOOT AND GATED ON.
  //
  // `lendingSessionSpec` asserts `assertVenusRoutingUnchanged` only when a
  // census is supplied, and the marketplace S1 supplied none: the census was
  // dead code on this path, while BUILD §4's ERC-20 overpay caveat cites it as
  // live. It is read here, once, and the boot FAILS when the routing has moved
  // — the same posture as the pool-liquidity proof above, and for the same
  // reason: a deployment that cannot prove what its granted selectors mean
  // must refuse to mint sessions rather than mint them blind.
  let routing: VenusRoutingCensus | undefined;
  if (overrides.readers === undefined) {
    const venusReaders = createVenusChainReaders({
      network: options.network,
      rpcUrls: resolveLendingRpcUrls(options.env, options.network.publicRpcUrl),
      venue: venusVenue,
      markets: [resolvedVenue.vUsdt, resolvedVenue.vBnb],
    });
    routing = await venusReaders.readRoutingCensus([
      resolvedVenue.vUsdt,
      resolvedVenue.vBnb,
    ]);
  }

  return {
    guards,
    settingsStore,
    observations,
    readers,
    ...(routing === undefined ? {} : { routing }),
    venue: resolvedVenue,
    venusVenue,
    intervalMs: runtime.intervalMs,
    maxObservationAgeMs: runtime.maxObservationAgeMs,
    agentConcurrency: runtime.agentConcurrency,
    previewSecret,
    maxSagaSlippageBps: options.lpVenue.maxSagaSlippageBps,
  };
}

function resolvePrime(env: NodeJS.ProcessEnv): Address {
  const raw = (env["VENUS_PRIME_ADDRESS"] ?? "").trim();
  if (raw === "") {
    // Prime is never granted and never called by this phase. The Venus reader
    // constructor takes it, so an unset value resolves to the Comptroller —
    // which makes any accidental Prime read a loud failure rather than a call
    // into an address an operator typed by mistake.
    return VENUS_CORE_COMPTROLLER_56;
  }
  return getAddress(raw);
}

async function readUnderlying(
  options: BuildLendingServerDepsOptions,
  vUsdt: Address,
): Promise<Address> {
  const { createPublicClient, http } = await import("viem");
  const rpcUrls = resolveLendingRpcUrls(options.env, options.network.publicRpcUrl);
  let lastError: unknown;
  for (const rpcUrl of rpcUrls) {
    try {
      const client = createPublicClient({
        chain: options.network.chain,
        transport: http(rpcUrl),
      });
      const chainId = await client.getChainId();
      if (chainId !== options.network.chainId) continue;
      const underlying = await client.readContract({
        address: getAddress(vUsdt),
        abi: VTOKEN_UNDERLYING_ABI,
        functionName: "underlying",
      });
      return getAddress(underlying);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `LENDING_VUSDT_ADDRESS ${vUsdt} could not be resolved to an underlying token `
    + `(${lastError instanceof Error ? lastError.message : "no endpoint answered"}). `
    + "USDT is derived from the vToken rather than configured, so a boot that cannot "
    + "read it must not proceed with a guessed address.",
  );
}

/** Close everything {@link buildLendingServerDeps} opened, in reverse order. */
export async function closeLendingServerDeps(
  built: BuiltLendingServerDeps | undefined,
): Promise<void> {
  if (built === undefined) return;
  await Promise.allSettled([
    built.observations.close(),
    built.settingsStore.close(),
    built.guards.close_(),
  ]);
}
