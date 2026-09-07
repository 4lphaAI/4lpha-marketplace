/**
 * PHASE4 — the Venus composition seam.
 *
 * WHY THIS FILE EXISTS: `PHASE4-AUDIT.md` A1. `createServer` registers the
 * Venus routes only when `deps.venus` is supplied, and the production
 * entrypoint never supplied it — so `VENUS_ENABLED=true` enabled NOTHING. Both
 * owner-signed routes 404'd on every deployment, no settings row could ever be
 * written, the worker's queue was permanently empty, and `provision-venus-agent`
 * ended by directing the operator to a route that could not exist. The server
 * looked healthy the whole time. That is the exact failure shape
 * `config.ts`'s own docstring warns about, shipped in the composition root.
 *
 * The fix is not "call some constructors in `index-server.ts`": the worker
 * already built the same collaborators its own way, and two composition sites
 * that drift are how the read side ends up reporting a cadence the writer does
 * not run on. So the construction lives HERE, once, and both callers use it.
 *
 * Everything in this module is inert unless `resolveVenusEnabled` is true.
 */
import { getAddress, type Address } from "viem";

import { resolveVenusEnabled, resolveVenusRuntimeConfig } from "../ops/config.js";
import {
  createVenusChainReaders,
  resolveVenusRpcUrls,
  type VenusChainReaders,
  type VenusReaderNetwork,
} from "./readers.js";
import { parseVenusSettingsParams } from "../http/venusWire.js";
import type { VenusVenue } from "./types.js";
import {
  createVenusSettingsStore,
  type VenusSettingsStore,
} from "../store/venusSettings.js";
import {
  createVenusObservationStore,
  type VenusObservationStore,
} from "../store/venusObservations.js";
import {
  createVenusActionStore,
  type VenusActionStore,
} from "../store/venusActions.js";

/** Exactly the shape `createServer` takes as `deps.venus`. */
export type BuiltVenusServerDeps = {
  readonly settingsStore: VenusSettingsStore;
  readonly observations: VenusObservationStore;
  readonly actions: VenusActionStore;
  readonly readers: VenusChainReaders;
  readonly venue: VenusVenue;
  readonly intervalMs: number;
  readonly maxObservationAgeMs: number;
  readonly marketIndex: Readonly<Record<string, { readonly underlying: Address | null }>>;
};

export type BuildVenusServerDepsOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly network: VenusReaderNetwork;
  /**
   * Injection seam, for tests ONLY (PHASE4-FIXREVIEW F1).
   *
   * Production passes nothing and gets the real stores and a live chain
   * reader. Without this the function could not run offline at all —
   * `readMarketIndex` is a chain read — so the A1 defect it exists to prevent
   * had no regression test, and the fix review proved that restoring the exact
   * defect left the whole suite green.
   */
  readonly overrides?: {
    readonly settingsStore?: VenusSettingsStore;
    readonly observations?: VenusObservationStore;
    readonly actions?: VenusActionStore;
    readonly readers?: VenusChainReaders;
  };
};

/**
 * The union of every owner's named markets, plus vBNB.
 *
 * Bounding the read set this way is what keeps a cycle inside its interval
 * (R3.10): 52 Core markets x ~8 reads each is not a per-30-second budget, and
 * the guard only ever acts on markets the owner named.
 *
 * A settings row whose params do not parse is SKIPPED rather than failing the
 * boot: one owner's malformed row must not stop every other owner's guard, and
 * the settings route validated the shape when it was written.
 */
export async function venusMarketUniverse(
  settingsStore: VenusSettingsStore,
  venue: VenusVenue,
): Promise<Address[]> {
  const markets = new Set<string>([getAddress(venue.vBnb).toLowerCase()]);
  const rows = await settingsStore.listForWorker();
  for (const row of rows) {
    const parsed = parseVenusSettingsParams(row.params);
    if (!parsed.ok) continue;
    for (const market of [
      ...parsed.value.debtMarkets,
      ...parsed.value.collateralMarkets,
    ]) {
      markets.add(market.toLowerCase());
    }
  }
  return [...markets].map((entry) => getAddress(entry));
}

/**
 * Build every Venus collaborator the HTTP layer needs, or `undefined` when the
 * surface is disabled.
 *
 * `resolveVenusRuntimeConfig` is the boot-failing half: a malformed venue
 * address or an out-of-range interval fails the BOOT, never a request.
 */
export async function buildVenusServerDeps(
  options: BuildVenusServerDepsOptions,
): Promise<BuiltVenusServerDeps | undefined> {
  if (!resolveVenusEnabled(options.env)) return undefined;

  // PHASE4-FIXREVIEW F3. D11's two deployment constraints, enforced HERE and
  // not only in the worker. Without them `VENUS_ENABLED=true` on a box with no
  // `DATABASE_URL` produced a server that ACCEPTS an owner-signed settings
  // write — the owner signs, the route 200s, tracking is PUT to the data plane
  // — into a memory store that evaporates on restart, while the worker on the
  // same box refuses to boot at all. Nothing spends, so it is not fail-open on
  // money; it is a signed write landing in volatile storage, which is an
  // honesty defect on an owner surface. Both refusals fail the BOOT, never a
  // request, and they mirror `scripts/venus-worker.ts:141-169` deliberately:
  // the two processes must agree about which deployments the guard exists on.
  const databaseUrl = options.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") {
    throw new Error(
      "VENUS_ENABLED is true but DATABASE_URL is unset. The Venus settings store IS " +
        "the worker's queue: a memory store here would accept owner-signed settings " +
        "the worker can never read, and would evaporate on restart.",
    );
  }
  if (options.network.chainId !== 56) {
    throw new Error(
      `The Venus guard is chain-56 only; this deployment resolves chain ` +
        `${options.network.chainId}. The selector census (block 117738703) was taken ` +
        "on BNB mainnet and means nothing anywhere else.",
    );
  }

  const runtime = resolveVenusRuntimeConfig(options.env);
  const overrides = options.overrides ?? {};
  const settingsStore = overrides.settingsStore ?? (await createVenusSettingsStore());
  const observations = overrides.observations ?? (await createVenusObservationStore());
  const actions = overrides.actions ?? (await createVenusActionStore());

  const markets = await venusMarketUniverse(settingsStore, runtime.venue);
  const readers =
    overrides.readers
    ?? createVenusChainReaders({
      network: options.network,
      rpcUrls: resolveVenusRpcUrls(options.env, options.network),
      venue: runtime.venue,
      markets,
    });

  // Resolved from the plane's OWN `underlying()` reads, exactly as the
  // `VenusServerDeps.marketIndex` contract promises — so the settings route can
  // tell which underlying a named market needs a ceiling for WITHOUT a chain
  // read inside `ownerMutation`'s journaled act (R2.15/R20).
  const marketIndex = await readers.readMarketIndex(markets);

  return {
    settingsStore,
    observations,
    actions,
    readers,
    venue: runtime.venue,
    // The read side reports `confirmationEligibleAtMs` in terms of the cadence
    // the WORKER runs on, so both sides take it from one resolver. The two
    // disagreeing is what makes an "armed" answer meaningless.
    intervalMs: runtime.intervalMs,
    maxObservationAgeMs: runtime.maxObservationAgeMs,
    marketIndex,
  };
}

/** Close everything `buildVenusServerDeps` opened, in reverse order. */
export async function closeVenusServerDeps(
  built: BuiltVenusServerDeps | undefined,
): Promise<void> {
  if (built === undefined) return;
  await Promise.allSettled([
    built.actions.close(),
    built.observations.close(),
    built.settingsStore.close(),
  ]);
}
