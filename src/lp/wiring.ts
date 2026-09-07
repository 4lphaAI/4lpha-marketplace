import { createLpFeeEventStore, type LpFeeEventStore } from "../store/lpFeeEvents.js";
/**
 * Production wiring for the LP surface (PHASE3 build item 3).
 *
 * `resolveLpEnabled` (src/ops/config.ts) is the tri-state master switch:
 * OFF by default ⇒ this module is never called and `ServerDeps.lp` stays
 * absent ⇒ every LP route answers the same 404 an unknown path gets. When it
 * is ON, everything here resolves at BOOT and a malformed value THROWS —
 * fails the process, never a request (the `resolvePasskeyConfig` posture) —
 * with ONE deliberate exception: the manipulation RAILS resolve to a RESULT,
 * not a throw, because their spec'd contract is per-request "missing ⇒ hold,
 * never default-open" (`src/lp/rails.ts` module header; `LpServerDeps`
 * documents the same). The WORKER, whose only job the rails gate, refuses to
 * start on them instead — `resolveLpWorkerBootConfig`.
 */
import type { Address } from "viem";
import type { LpServerDeps } from "../server.js";
import type { VenueConfig } from "../ops/venues.js";
import {
  resolveGridEnabled,
  resolveLpEvidenceConfig,
  resolveLpRuntimeConfig,
  type TradeEnv,
} from "../ops/config.js";
import { resolveLpRelayFeePerSubmitWei } from "../ops/policy.js";
import { resolveLpRailConfig, type LpRailConfigResult } from "./rails.js";
import {
  createLpChainReaders,
  resolveLpAddresses,
  type LpAddressConfig,
  type LpReaderNetwork,
  type LpWorkerChainReaders,
} from "./readers.js";
import type { LpSequenceStore } from "../store/lpSequences.js";
import type { LpSettingsStore } from "../store/lpSettings.js";
import type { LpObservationStore } from "../store/lpObservations.js";
import { createLpSequenceStore } from "../store/lpSequences.js";
import { createLpSettingsStore } from "../store/lpSettings.js";
import { createLpObservationStore } from "../store/lpObservations.js";
import { createLpGridCycleStore, type LpGridCycleStore } from "../store/gridCycles.js";
import { createLpEvidenceStore, MemoryEvidenceRequirementRegistry,
  type LpEvidenceStore } from "../store/lpEvidence.js";
import { createLpCoverageStore, type LpCoverageStore } from "../store/lpCoverage.js";
import { createLpEvidenceObserver, resolveLpEvidenceDestinationPins,
  type LpEvidenceObserver } from "./evidenceObserver.js";
import {
  createLandingResolutionFinalizer,
  type LandingResolutionFinalizer,
} from "./landingFinalizer.js";
import {
  LP_STALL_LATCH_ATTEMPTS,
  resolveLpMaxObservationAgeMs,
  resolveLpWorkerIntervalMs,
} from "./worker.js";

/**
 * The TWAP window `poolState` reads when the rails are UNCONFIGURED. Never
 * load-bearing: every money route refuses on the rail failure before its
 * first pool read (`requireRails` runs first), so this value only shapes a
 * read no decision consumes. It exists because the readers object must be
 * constructible either way — `LpServerDeps.readers` is not optional.
 */
const PLACEHOLDER_TWAP_WINDOW_SECONDS = 300;

export type BuildLpServerDepsInput = {
  readonly env: TradeEnv;
  /** The provider's own network facts — chain, id, public RPC. No second config. */
  readonly network: LpReaderNetwork;
  readonly keyStore: Address;
  /** The SAME resolved venue config the trade route runs on (router, WBNB). */
  readonly venues: VenueConfig;
  /**
   * Store overrides for the dev-stack's in-memory wiring. Omitted, the
   * durable factories decide off `DATABASE_URL` exactly like every other
   * store.
   */
  readonly stores?: {
    readonly store: LpSequenceStore;
    readonly settingsStore: LpSettingsStore;
    /**
     * PHASE3.2 Rev2 item 38: the dev-stack passes ONE observation store here so
     * the in-process server and the in-process worker SHARE it. A second
     * per-process instance would make `GET /agents/:id/lp` report an
     * observation state the worker in the same process does not hold — the read
     * side lying, in the phase that exists because nothing reported the truth.
     */
    readonly observations: LpObservationStore;
    /**
     * PHASE3.15: the dev-stack's ONE grid cycle ledger, shared between the
     * in-process server and the in-process worker for the same reason the
     * observation store is — a second instance would make the owner view report
     * a cycle history the worker in the same process does not hold.
     */
    readonly feeEvents?: LpFeeEventStore;
  readonly gridCycles?: LpGridCycleStore;
  };
  /** Extra RPC endpoints, the same list the provider was given. */
  readonly rpcUrls?: readonly string[];
};

export type BuiltLpServerDeps = {
  readonly lp: LpServerDeps;
  /** The same readers object, with the worker's `positionFees` extension. */
  readonly readers: LpWorkerChainReaders;
  /** PHASE3.15: resolved once here, so no caller re-reads the env. */
  readonly gridEnabled: boolean;
  /** The grid cycle ledger, present only when the grid is enabled. */
  readonly feeEvents?: LpFeeEventStore;
  readonly gridCycles?: LpGridCycleStore;
  readonly addresses: LpAddressConfig;
  readonly railsResult: LpRailConfigResult;
  readonly evidence?: {
    readonly store: LpEvidenceStore;
    readonly coverageStore: LpCoverageStore;
    readonly observer: LpEvidenceObserver;
    readonly finalizer?: LandingResolutionFinalizer;
  };
};

/**
 * Assemble `ServerDeps.lp` for a deployment that enabled LP. Throws on any
 * malformed boot value (addresses, runtime knobs, relay-fee override); the
 * rails ride through as their typed result.
 */
export async function buildLpServerDeps(
  input: BuildLpServerDepsInput,
): Promise<BuiltLpServerDeps> {
  const addresses = resolveLpAddresses(input.env, {
    chainId: input.network.chainId,
    keyStore: input.keyStore,
    ...(input.venues.pancakeRouterV3 === undefined
      ? {}
      : { routerV3: input.venues.pancakeRouterV3 }),
    ...(input.venues.wbnb === undefined ? {} : { wbnb: input.venues.wbnb }),
  });
  const runtime = resolveLpRuntimeConfig(input.env);
  const evidenceConfig = resolveLpEvidenceConfig(input.env);
  if (evidenceConfig.enabled && input.network.chainId !== 56) {
    throw new Error("LP landing evidence is registered only for BNB Chain 56.");
  }
  if (evidenceConfig.enabled && (input.env["DATABASE_URL"]?.trim() ?? "") === "") {
    throw new Error("LP landing evidence requires durable PostgreSQL storage.");
  }
  const evidenceDestinationPins = evidenceConfig.enabled
    ? await resolveLpEvidenceDestinationPins(evidenceConfig)
    : [];
  const relayFeePerSubmitWei = resolveLpRelayFeePerSubmitWei(input.env);
  const railsResult = resolveLpRailConfig(input.env);

  // PHASE3.15 (C4). THE grid flag is resolved HERE — this is `buildLpServerDeps`,
  // the ONE site that composes `LpServerDeps`, and it is shared by
  // `src/index-server.ts` and `scripts/dev-stack.ts`, so resolving it at either
  // of those alone would leave the other grid-blind. `resolveGridEnabled` also
  // carries the L3 pair check (grid on while LP off fails the boot).
  const gridEnabled = resolveGridEnabled(input.env);
  // R2.4: `grid-flip` is deliberately UNMAPPED in `landingDispositionFor`,
  // whose table THROWS on an unmapped key. The constraint is therefore not
  // merely written down, it is ENFORCED at boot: the six rows plus the two hand
  // conditions in the 3.9c resolver are DEFERRED to the phase that first
  // enables landing evidence for a grid agent, and until then the two features
  // may not run together. Costs nothing today — the gate is disabled by default
  // and carries its own enablement blocker.
  //
  // PHASE3.16 R2.9 (review L3): the CHECK needs no change — it is flag-level,
  // not per-kind, so it already covered a second grid kind the day `grid-arm`
  // existed. The MESSAGE does, because this throw is the only place a reader
  // learns WHICH kinds are unmapped, and the deferred mapping work has grown by
  // the arm's own row plus its `absentDispositionReleasesReservation`
  // condition.
  //
  // PHASE3.18 L1: the message now names the kinds GENERICALLY. It had been
  // rewritten once per phase to list them, which made the sentence a thing that
  // goes stale the moment a fourth grid kind lands — and `grid-requote` is that
  // fourth kind. The set is `GRID_SEQUENCE_KINDS` in `worker.ts`, which is
  // where a reader should look; the gate itself is and always was flag-level.
  if (gridEnabled && evidenceConfig.enabled) {
    throw new Error(
      "GRID_ENABLED and LP landing evidence cannot both be on: every grid sequence kind is deliberately unmapped in landingDispositionFor, whose table throws on an unmapped key. Mapping them is a separate phase (PHASE3.15 R2.4 / review H5; PHASE3.16 R2.9; PHASE3.18 L1).",
    );
  }

  const readers = createLpChainReaders({
    network: input.network,
    ...(input.rpcUrls === undefined ? {} : { rpcUrls: input.rpcUrls }),
    nfpm: addresses.nfpm,
    factory: addresses.factory,
    quoterV2: addresses.quoterV2,
    twapWindowSeconds: railsResult.ok
      ? railsResult.config.twapWindowSeconds
      : PLACEHOLDER_TWAP_WINDOW_SECONDS,
  });

  const feeEvents = input.stores?.feeEvents ?? await createLpFeeEventStore();
  const store = input.stores?.store ?? (await createLpSequenceStore());
  const settingsStore =
    input.stores?.settingsStore ?? (await createLpSettingsStore());
  const observations =
    input.stores?.observations ?? (await createLpObservationStore());
  // Built only when the grid is on: a deployment that never enabled it does not
  // create the table, and the owner view reports no grid section.
  const gridCycles = gridEnabled
    ? input.stores?.gridCycles ?? (await createLpGridCycleStore())
    : undefined;
  const memoryRequirementRegistry = evidenceConfig.enabled &&
    (input.env["DATABASE_URL"]?.trim() ?? "") === ""
    ? new MemoryEvidenceRequirementRegistry() : undefined;
  const evidenceStore = evidenceConfig.enabled
    ? await createLpEvidenceStore(evidenceConfig, input.env["DATABASE_URL"],
        memoryRequirementRegistry)
    : undefined;
  const coverageStore = evidenceConfig.enabled
    ? await createLpCoverageStore(evidenceConfig, input.env["DATABASE_URL"],
        memoryRequirementRegistry)
    : undefined;
  const evidenceObserver = coverageStore === undefined ? undefined
    : createLpEvidenceObserver({ config: evidenceConfig, store: coverageStore,
        destinationPins: evidenceDestinationPins,
        ...(evidenceStore === undefined ? {} : {
          cleanupRetained: (now: number, limit: number) =>
            evidenceStore.cleanupRetained(now, limit),
        }) });
  const evidenceFinalizer = evidenceConfig.enabled
    ? await createLandingResolutionFinalizer(evidenceConfig, input.env["DATABASE_URL"])
    : undefined;
  evidenceObserver?.start();

  // The cadence the WORKER runs on, resolved from the same env var, because
  // the read side reports `confirmationEligibleAtMs` in terms of it. Malformed
  // values throw here exactly like every other boot value in this file.
  const workerIntervalMs = resolveLpWorkerIntervalMs(input.env);
  const maxObservationAgeMs = resolveLpMaxObservationAgeMs(
    input.env,
    workerIntervalMs,
  );

  return {
    lp: {
      feeEvents,
      store,
      settingsStore,
      observations,
      workerIntervalMs,
      // PHASE3.22 R5.4 / D4(b) — the worker's stall-latch threshold, supplied
      // by the ONE composition site that legitimately knows both halves. The
      // server must not import the worker and `abandonSequence` must not
      // either, so this is where the constant crosses over. It opens tier 2 of
      // the COMMITTED grid-shift abandon and nothing else reads it.
      stallLatchAttempts: LP_STALL_LATCH_ATTEMPTS,
      ...(maxObservationAgeMs === undefined ? {} : { maxObservationAgeMs }),
      railsResult,
      runtime,
      venue: {
        nfpm: addresses.nfpm,
        routerV3: addresses.routerV3,
        wbnb: addresses.wbnb,
      },
      readers,
      relayFeePerSubmitWei,
      gridEnabled,
      ...(gridCycles === undefined ? {} : { gridCycles }),
      ...(evidenceStore === undefined || evidenceObserver === undefined ? {} : {
        landingEvidence: { store: evidenceStore, provider: evidenceObserver,
          resolverLeaseMs: 30_000,
          ...(evidenceFinalizer === undefined ? {} : { finalizer: evidenceFinalizer }) },
      }),
    },
    readers,
    feeEvents,
    addresses,
    railsResult,
    gridEnabled,
    ...(gridCycles === undefined ? {} : { gridCycles }),
    ...(evidenceStore === undefined || coverageStore === undefined || evidenceObserver === undefined
      ? {} : { evidence: { store: evidenceStore, coverageStore, observer: evidenceObserver,
        ...(evidenceFinalizer === undefined ? {} : { finalizer: evidenceFinalizer }) } }),
  };
}

/** R2.9: operator preference for empty rotate plans; persisted live steps win. */
export function resolveLpAtomicRotate(env: TradeEnv): boolean {
  return !["false", "0", "off"].includes(env["LP_ROTATE_ATOMIC"]?.trim().toLowerCase() ?? "");
}
