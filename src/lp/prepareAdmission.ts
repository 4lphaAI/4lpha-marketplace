/** Read-only admission seam for the LP prepare diagnostic. */
import type { Address } from "viem";
import type { AgentRecord } from "../store/agents.js";
import type { WalletCall } from "../core/types.js";
import { grantsTokenSell } from "../ops/policy.js";
import { checkManipulationRails, type LpRailConfig, type LpRailEvidence } from "./rails.js";

export type LpPrepareAdmissionDeps = {
  readonly wbnb: Address;
  readonly forbiddenTokenAddresses: ReadonlySet<string>;
  readonly rails: LpRailConfig;
  readonly canSessionSellToken: (agent: AgentRecord, token: Address) => Promise<boolean>;
  readonly getPool: (token0: Address, token1: Address, fee: number) => Promise<Address | null>;
  readonly poolState: (pool: Address) => Promise<{ readonly currentTick: number; readonly tickSpacing: number;
    readonly evidence: LpRailEvidence }>;
  /** Exact derived calls, checked before Porto prepare; this callback has no submit capability. */
  readonly preflightExecute: (calls: readonly WalletCall[]) => Promise<void>;
};

export function lpPrepareForbiddenTokenAddresses(input: { readonly wallet: Address; readonly keyStore: Address;
  readonly wbnb: Address; readonly routerV2?: Address; readonly routerV3: Address; readonly nfpm: Address;
  readonly fourMeme?: Address; readonly flap?: Address; readonly treasury?: Address }): ReadonlySet<string> {
  return new Set([input.wallet, input.keyStore, input.wbnb, input.routerV3, input.nfpm,
    ...(input.routerV2 === undefined ? [] : [input.routerV2]), ...(input.fourMeme === undefined ? [] : [input.fourMeme]),
    ...(input.flap === undefined ? [] : [input.flap]), ...(input.treasury === undefined ? [] : [input.treasury]),
    "0x0000000000000000000000000000000000000000"].map((value) => value.toLowerCase()));
}

export async function admitLpPrepare(input: LpPrepareAdmissionDeps & {
  readonly agent: AgentRecord; readonly token0: Address; readonly token1: Address; readonly fee: number;
  readonly calls: readonly WalletCall[];
}): Promise<{ readonly pool: Address; readonly state: Awaited<ReturnType<LpPrepareAdmissionDeps["poolState"]>> }> {
  const admitted = await admitLpPreparePool(input);
  await input.preflightExecute(input.calls);
  return admitted;
}

export async function admitLpPreparePool(input: Omit<LpPrepareAdmissionDeps, "preflightExecute"> & {
  readonly agent: AgentRecord; readonly token0: Address; readonly token1: Address; readonly fee: number;
}): Promise<{ readonly pool: Address; readonly state: Awaited<ReturnType<LpPrepareAdmissionDeps["poolState"]>> }> {
  const t0 = input.token0.toLowerCase(); const t1 = input.token1.toLowerCase(); const wbnb = input.wbnb.toLowerCase();
  if (t0 === t1 || (t0 !== wbnb && t1 !== wbnb)) throw new Error("The pool must contain distinct WBNB and token legs.");
  const token = t0 === wbnb ? input.token1 : input.token0;
  if (input.forbiddenTokenAddresses.has(token.toLowerCase())) throw new Error("The pool token is forbidden.");
  // Existing union semantics: persisted grant first, then authoritative chain fallback.
  if (!(grantsTokenSell(input.agent.sessionFacts?.spec ?? { allowedCalls: [], spendCaps: [], expiresAt: 0 }, token) ||
      await input.canSessionSellToken(input.agent, token))) throw new Error("The session cannot sell the pool token.");
  if (!(grantsTokenSell(input.agent.sessionFacts?.spec ?? { allowedCalls: [], spendCaps: [], expiresAt: 0 }, input.wbnb) ||
      await input.canSessionSellToken(input.agent, input.wbnb))) throw new Error("The session cannot sell WBNB.");
  const pool = await input.getPool(input.token0, input.token1, input.fee);
  if (pool === null) throw new Error("No pool exists for the requested legs and fee.");
  const state = await input.poolState(pool);
  if (checkManipulationRails(state.evidence, input.rails) !== undefined ||
      state.evidence.observationCardinality < input.rails.minObservationCardinality ||
      state.evidence.poolLiquidity < input.rails.minPoolLiquidity) throw new Error("Pool rails refused the diagnostic.");
  return { pool, state };
}
