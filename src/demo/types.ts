/**
 * DEMO MODE — the shared vocabulary.
 *
 * ─── WHAT A DEMO AGENT IS ──────────────────────────────────────────────────
 *
 * A simulated grid or trading agent. It reads the SAME live on-chain price the
 * live agents read and runs the SAME pure decision layer, but it has no
 * session, no wallet, no passkey, no grant, no journal row, and no path to a
 * transaction. It exists so a visitor can watch an agent work before funding
 * anything.
 *
 * ─── THE IMPORT BOUNDARY, WHICH IS THE WHOLE SAFETY ARGUMENT ───────────────
 *
 * CORRECTED 2026-09-07 after the independent review (finding 1). The first
 * version of this paragraph said `src/demo/**` "may NOT import `src/ops/**`",
 * and that was FALSE one level down: the shared grid predicates
 * (`lp/gridTriggers.ts`, `lp/triggers.ts`) take two constants from
 * `ops/policy.ts` and `V3_FEE_TIERS` from `ops/route.ts`. The test that was
 * supposed to enforce the ban only walked DIRECT imports, so it agreed with the
 * prose instead of with the code.
 *
 * Sharing those modules is the right call — the alternative is a second copy of
 * the grid geometry, which is the two-authorities-on-one-geometry defect this
 * lineage keeps being caught by (PHASE3.13 F7, 3.15 H1). So the boundary is
 * stated as what it actually has to be:
 *
 *   **Nothing reachable from `src/demo/**` at runtime can ACT.** The whole
 *   transitive closure is 18 modules of arithmetic, validation, parsing and
 *   read-only clients. It contains no module that signs, submits, holds or
 *   decrypts a key, or writes live agent / journal / sequence state:
 *   `wallet/**`, `auth/**`, `killswitch/**`, `lp/sagas.ts`, `lp/open.ts`,
 *   `trade/execute.ts`, `store/journal.ts`, `store/agents.ts`,
 *   `store/lpSequences.ts` and `server.ts` are all absent from it.
 *
 * `test/demo.plane.test.ts` computes that closure — following runtime,
 * side-effect and dynamic imports, and ignoring the erased type-only forms —
 * asserts the forbidden set is absent, and PINS the allowed set, so a future
 * edit cannot widen the reach and leave this paragraph stale the way the first
 * one was.
 *
 * The property that matters for the change itself is unaffected: there is no
 * `demo` flag on any owner action, any signed field, any session spec or any
 * live worker. A demo agent is a different row in a different table driven by a
 * different loop. If a future edit wants one of the forbidden modules, the
 * change has outgrown this plan and belongs in the full spec -> review ->
 * build -> audit chain instead.
 *
 * See `MD here/DEMO-MODE-PLAN.md` §2.
 */
import type { Address } from "viem";

/** The two agent kinds demo mode covers. LP is deliberately out of scope. */
export type DemoAgentKind = "grid" | "trade";

/**
 * A demo agent's owner is an ANONYMOUS COOKIE ID, never an address and never a
 * passkey (operator decision 2026-09-06, plan §8-1). It is branded so it can
 * never be passed where an owner `Address` is expected — the two are different
 * kinds of identity and the compiler should say so.
 */
export type DemoOwnerId = string & { readonly __demoOwner: unique symbol };

/** Narrow an untrusted string to a demo owner id, or refuse. */
export const DEMO_OWNER_ID_PATTERN = /^[0-9a-f]{32}$/u;

export function asDemoOwnerId(raw: string): DemoOwnerId | null {
  return DEMO_OWNER_ID_PATTERN.test(raw) ? (raw as DemoOwnerId) : null;
}

/**
 * Every figure a demo agent reports is SIMULATED, and this is the machine-
 * readable form of that statement. It rides on every projection so a UI cannot
 * render a demo number without also having its disclosure in hand (plan §7).
 */
export type DemoDisclosure = {
  readonly simulated: true;
  /** What the model does NOT account for, in the owner's words. */
  readonly omits: readonly string[];
};

/** A demo agent never has one of these, and the type says so out loud. */
export type DemoLiveOnlyFacts = {
  readonly txHash: null;
  readonly tokenId: null;
  readonly erc8004AgentId: null;
  readonly callsId: null;
};

export const DEMO_LIVE_ONLY_FACTS: DemoLiveOnlyFacts = {
  txHash: null,
  tokenId: null,
  erc8004AgentId: null,
  callsId: null,
};

/**
 * The quote/base naming for a grid demo, resolved once from pool order.
 *
 * `wbnbIsToken0` is the SIGNED field on `LpGridSettings` and the only thing
 * that decides this — never "up"/"down", which inverts for half of BSC's pools
 * (PHASE3.13 F7 / 3.15 H1, the drift class this repo keeps being caught by).
 */
export type DemoPoolNaming = {
  readonly wbnbIsToken0: boolean;
  readonly quoteDecimals: number;
  readonly baseDecimals: number;
  readonly quoteSymbol: string;
  readonly baseSymbol: string;
};

/** Where a demo agent's price came from, so a view can say so or show a dash. */
export type DemoPriceSource =
  | { readonly kind: "pool-state"; readonly pool: Address; readonly blockNumber: string }
  | { readonly kind: "data-plane"; readonly token: Address }
  | { readonly kind: "unavailable"; readonly reason: string };
