import { getAddress, type Address } from "viem";
import type { DataPlaneClient, DataPlaneEnvelope } from "../clients/dataPlane.js";
import type { CustodyModel, WalletProvider } from "../core/types.js";
import type { AgentRecord, AgentStore, AgentStatus } from "../store/agents.js";
import type { LpSequenceStore, LpPositionRecord } from "../store/lpSequences.js";
import type { LpObservationStore } from "../store/lpObservations.js";
import {
  DeclaredWalletNotOwnedError,
  verifyDeclaredWallet,
  type DeclaredWalletVerdict,
  type KeyStoreReader,
} from "./keyStoreReader.js";
import type { BalanceReader } from "./balanceReader.js";
import type { LpSettingsStore } from "../store/lpSettings.js";
import { parseLpSettingsParams } from "../http/lpWire.js";
import { gridModeOf } from "../lp/triggers.js";
import { agentGasFloor, classifyAgentGas, type AgentGasState } from "../ops/gasFloor.js";

export type CoverageState = "complete" | "partial" | "empty" | "unavailable";
export type CoverageReason = "none" | "capacity" | "dependency" | "stale" | "unpriced" | "unreadable" | "identity-conflict" | "unsupported-profile" | "zero-basis" | "missing-mark" | "held" | "declared" | "shared-wallet";
export type Coverage = { readonly state: CoverageState; readonly reasons: readonly CoverageReason[] };

export type AccountPortfolioView = {
  readonly generatedAt: number;
  readonly asOf: number | null;
  /**
   * The owner IDENTITY this view was built for, and nothing else.
   *
   * Under `custodyModel: "passkey"` it is derived from a P256 credential
   * (`4lpha-p256-owner:v1:`), no secp256k1 key exists for it, and FUNDS SENT
   * TO IT ARE BURNED — see the `AgentWalletRef.ownerAddress` contract at
   * `src/core/types.ts:154-166`. It is NEVER a deposit target. Deposits go to
   * `wallets[].address`.
   */
  readonly ownerAddress: string;
  /**
   * The wallets the owner's agents run on — the ONLY depositable addresses on
   * this view. `depositable` is a literal `true` so a consumer has to name the
   * property it is paying into instead of reaching for any address it finds.
   *
   * `availableUsdMicros` is that wallet's liquid value (native + known
   * ERC-20); `deployedUsdMicros` is the LP mark of positions held by agents
   * running on it. Either is `null` when this view could not price it
   * completely. Owner-wide Venus is NOT attributed here — it is keyed by owner
   * and stays in `venus` / `totals` (REVISION R2).
   *
   * `source` says WHERE the entry came from. `"agents"` means the plane owns
   * rows on it. `"declared"` means the CALLER named it on this request and the
   * plane knows nothing about it beyond the public balances it just read — no
   * agents run there, so `deployedUsdMicros` is `"0"` by ABSENCE rather than by
   * measurement, and `deployedReason` says `"declared"` to keep that visible.
   *
   * `passkeyVerified` is present ONLY on a declared entry, and is the Altana
   * KeyStore's answer to "does this owner control this address"
   * (`src/account/keyStoreReader.ts`). An entry that reaches the wire is never
   * `"no-matching-key"` — that verdict REFUSES the whole request with a 400 —
   * so a 200 carries `"verified"`, `"not-registered"` (the normal state of a
   * funded wallet whose first admin action has not landed) or `"unreadable"`.
   * An `"agents"` entry has no such field: its custody claim is the ROW, which
   * the plane wrote itself.
   */
  readonly wallets: readonly {
    readonly address: string;
    readonly custodyModel: CustodyModel;
    readonly depositable: true;
    readonly source: "agents" | "declared";
    readonly availableUsdMicros: string | null;
    readonly deployedUsdMicros: string | null;
    readonly deployedReason: CoverageReason;
    readonly passkeyVerified?: DeclaredWalletVerdict;
  }[];
  readonly assets: readonly {
    readonly kind: "native" | "erc20";
    readonly walletAddress: string;
    readonly tokenAddress: string | null;
    readonly symbol: string | null;
    readonly decimals: number | null;
    readonly balanceAtomic: string | null;
    readonly priceUsdMicros: string | null;
    readonly pricedAt: number | null;
    readonly valueUsdMicros: string | null;
    readonly status: "priced" | "zero" | "unpriced" | "unreadable";
    readonly method: "wallet-native-v1" | "wallet-known-erc20-v1";
  }[];
  readonly venus: null | { readonly reference: "owner-wide"; readonly method: "owner-wide-venus-stored-net-v1"; readonly observedAt: number; readonly supplyUsdMicros: string; readonly borrowUsdMicros: string; readonly netUsdMicros: string };
  readonly totals: { readonly walletUsdMicros: string | null; readonly deployedUsdMicros: string | null; readonly totalUsdMicros: string | null; readonly grossLpPnlUsdMicros: string | null; readonly grossLpPnlBps: string | null; readonly eligibleLpBasisNativeWei: string | null };
  readonly agents: readonly AccountAgentView[];
  readonly coverage: { readonly universe: "known-assets"; readonly wallet: Coverage; readonly deployed: Coverage; readonly total: Coverage; readonly pnl: Coverage; readonly truncated: { readonly agents: boolean; readonly wallets: boolean; readonly tokens: boolean; readonly walletTokenPairs: boolean; readonly positions: boolean } };
};

type AccountAgentView = {
  readonly id: string;
  readonly status: AgentStatus;
  readonly httpRuntimeProfile: AgentRecord["httpRuntimeProfile"];
  readonly walletAddress: string;
  /**
   * AGENT-GAS-ATTENTION §3.1 — why this agent wants the owner's eye.
   *
   * PRECEDENCE, and it is deliberate: an EXPLICIT owner state (`paused`,
   * `provisioning`) outranks a DERIVED one, because the owner already knows why
   * a paused agent is idle and a "needs gas" chip on it would be noise. Below
   * those, `gas-blocked` outranks `gas-low` (it is the same axis, further
   * along), and both outrank `partial-data` — a wallet that cannot pay is a
   * fact about the agent, while partial data is a fact about this READ.
   */
  readonly attention:
    | "none"
    | "paused"
    | "provisioning"
    | "gas-blocked"
    | "gas-low"
    | "partial-data";
  /**
   * The gas reading behind a `gas-*` attention, or `null` when no floor could
   * be sized or no balance read. NEVER a zero: a dash with a reason is the
   * house rule for an absent source.
   */
  readonly gas: {
    readonly state: AgentGasState;
    readonly nativeWei: string | null;
    readonly nextMotionWei: string;
    readonly warnWei: string;
    readonly blockWei: string;
    readonly enforcement: "block" | "warn-only";
  } | null;
  readonly holdings: { readonly method: "wallet-native-v1" | "wallet-known-erc20-v1" | "sellable-lp-exit-v1" | "owner-wide-venus-stored-net-v1" | "none"; readonly state: CoverageState; readonly reason: CoverageReason; readonly valueUsdMicros: string | null; readonly venusReference: "owner-wide" | null; readonly held: boolean };
  readonly pnl: { readonly method: "gross-lp-mark-plus-residue-to-declared-basis-v2" | "none"; readonly coverage: "full" | "partial" | "unsupported" | "unavailable"; readonly reason: CoverageReason; readonly eligibleBasisNativeWei: string | null; readonly markNativeWei: string | null; readonly pnlNativeWei: string | null; readonly pnlUsdMicros: string | null; readonly pnlBps: string | null; readonly basisSources: readonly ("owner-budget" | "imported")[]; readonly excluded: readonly ("relay-and-gas" | "wallet-residue" | "closed-lineages" | "prior-exits" | "external-cashflows" | "zero-basis-lineages")[] };
};

export type AccountPortfolioDeps = {
  readonly agents: AgentStore;
  readonly provider: WalletProvider;
  readonly dataPlane: DataPlaneClient;
  readonly chainId: number;
  readonly wbnb: Address;
  readonly lp?: {
    readonly store: LpSequenceStore;
    readonly observations: LpObservationStore;
    readonly workerIntervalMs: number;
    /**
     * AGENT-GAS-ATTENTION §3.1 — the owner's LP settings, read ONLY for the
     * grid MODE, because the mode is what sizes an LP agent's next motion
     * (3 fee units for a flip or an exit sequence, 4 for a shift or a ladder).
     *
     * OPTIONAL, and its absence is handled as an UNSIZED floor rather than a
     * guessed one: the agent then reports no gas state at all. Guessing the
     * mode would make this view disagree with the agent page about the same
     * wallet, which is the exact defect AGENT-GAS-ATTENTION §4 exists to fix —
     * it must not be reintroduced in the field that reports health.
     */
    readonly settings?: Pick<LpSettingsStore, "get">;
    /** `LP_RELAY_FEE_PER_SUBMIT_WEI` as the deployment resolved it. */
    readonly relayFeePerSubmitWei?: bigint;
  };
  /**
   * The Altana KeyStore seam that turns a DECLARED wallet from a caller claim
   * into a proved one. Injected, never constructed here — the repo's reader
   * convention (`LpChainReaders`), so no RPC call happens in a route or in
   * this pure-ish builder's own module graph at import time.
   *
   * ABSENT is a supported deployment, and it is handled EXPLICITLY: every
   * declared entry then carries `passkeyVerified: "unreadable"`. Absence never
   * silently produces a verified-looking entry, and never refuses one either.
   */
  readonly keyStoreReader?: KeyStoreReader;
  /**
   * The BATCHED public-chain reader (`src/account/balanceReader.ts`). Present,
   * every native balance in this view is ONE HTTP request and every ERC-20
   * balance is ONE Multicall3 `eth_call`; absent, the reads fall back to
   * `deps.provider` one call at a time, byte-identically to before this seam
   * existed. It is OPTIONAL for exactly that reason: no test needs a fake, and
   * a deployment that does not wire it is slower, never wrong.
   *
   * It is NOT the provider. The provider's client is the money path (LP saga
   * receipts, preflight, execute) and must keep its unbatched, one-endpoint
   * read timing.
   */
  readonly balanceReader?: BalanceReader;
  readonly now?: () => number;
};

/**
 * Per-request inputs that are NOT persisted facts.
 *
 * `declaredWallets` exists because of one live shape: a passkey owner creates
 * their Altana wallet in the BROWSER and funds it BEFORE hiring any agent, so
 * the wallet is real, on chain, holding money — and appears in no row this
 * plane owns. Without this the Account read reports "0 wallets observed" and
 * refuses to name the address the user just deposited into.
 *
 * THE RECORDED DEBT IS CLOSED (2026-09-02). The plane no longer takes the
 * caller's word for it: each declared address is put to the Altana KeyStore
 * (`deps.keyStoreReader`, `verifyDeclaredWallet`) and the verdict rides on the
 * entry as `passkeyVerified`. Only `"no-matching-key"` — registered, to
 * somebody else's key — refuses, because `"not-registered"` is the NORMAL
 * state of a funded wallet whose first admin action has not landed and
 * refusing it would re-break the bug this option exists to fix.
 *
 * What an entry still is NOT: a basis for a write. `"verified"` proves the
 * registry lists a P-256 key deriving this owner's identity, which is exactly
 * enough to show public balances beside the owner's own agents and nothing
 * more. Bounded at two by the route and again here.
 */
export type AccountPortfolioOptions = {
  readonly declaredWallets?: readonly Address[];
};

const MAX_DECLARED_WALLETS = 2;

const REASON_ORDER: readonly CoverageReason[] = ["none", "capacity", "dependency", "stale", "unpriced", "unreadable", "identity-conflict", "unsupported-profile", "zero-basis", "missing-mark", "held", "declared"];

/**
 * The token universe for a DECLARED wallet (see `AccountPortfolioOptions`).
 *
 * An agent wallet derives its universe from the session spend caps of the rows
 * that run on it. A declared wallet has no rows and therefore no caps, so the
 * six canonical BSC assets are PINNED here instead. They are read only when
 * `deps.chainId` is 56 — the list is chain-specific, and a declared wallet on
 * any other chain gets its native balance and nothing else.
 */
const DECLARED_WALLET_TOKENS_BSC: readonly string[] = [
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", // BTCB
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8", // ETH
  "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", // CAKE
];
const EXCLUDED = ["relay-and-gas", "wallet-residue", "closed-lineages", "prior-exits", "external-cashflows", "zero-basis-lineages"] as const;

/**
 * AGENT-GAS-ATTENTION §4 — what `...-v2` excludes once the residue IS counted.
 *
 * `"relay-and-gas"` stays out, and that is the operator's own definition: PnL
 * is GROSS — dust in, gas and grant fees out (ruling 2026-09-10).
 */
const EXCLUDED_WITH_RESIDUE_COUNTED = ["relay-and-gas", "closed-lineages", "prior-exits", "external-cashflows", "zero-basis-lineages"] as const;

/**
 * AGENT-GAS-ATTENTION §4 — the agent's idle wallet legs, in NATIVE wei.
 *
 * ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════
 *
 * Measured 2026-09-10 on `4lpha-lp-agent-01-2`: the agent page read
 * `+$0.56 / +3.96%` and this view read about `-28%`, for the same agent, in the
 * same minute. The page counts wallet dust; `...-v1` listed `"wallet-residue"`
 * in `EXCLUDED`. The dust was 2.818 USDT + 0.002 WBNB — about 29% of the
 * agent's capital — so the two surfaces disagreed about the SIGN.
 *
 * ═══ WHY THE EXCLUSION EXISTED, AND THE RULE THAT REPLACES IT ═════════════
 *
 * Dust sits in a WALLET; a wallet can host several agents; this view attributes
 * per AGENT. That ambiguity is a real reason, not an oversight, so it is
 * answered rather than ignored:
 *
 *   - exactly ONE live agent on the wallet ⇒ the residue is that agent's, and
 *     is counted;
 *   - MORE than one ⇒ `"shared-wallet"`: excluded, coverage `partial`, and the
 *     reason says so. No guess, no split, no silent halving.
 *
 * Only the position's OWN legs count. A stray third token in the wallet is not
 * this agent's dust, and native BNB is gas — `"relay-and-gas"`, still excluded.
 */
function walletResidueNativeWei(input: {
  readonly agent: AgentRecord;
  readonly rows: readonly LpPositionRecord[];
  readonly assets: AccountPortfolioView["assets"];
  readonly liveAgentsOnWallet: number;
  readonly bnbPriceMicros: bigint | null;
  /**
   * Whether this READ was complete enough to attribute residue at all.
   *
   * REVIEW FINDING 3, and it was the sharpest defect in the first build. The
   * residue term summed the asset rows it could SEE and never proved the rows
   * it needed EXISTED. `assets` is truncated at 64 tokens / 128 wallet-token
   * pairs, and `agents` at 32 — so a busy account could silently lose a leg's
   * row, sum a partial residue (or none), and still publish
   * `coverage: "full"`. Reproduced by the review: PnL moved from +1.9 BNB to
   * -0.1 BNB with `"full"` coverage and `"wallet-residue"` REMOVED from the
   * exclusions — the page asserting completeness precisely when it had least.
   *
   * `tokensComplete` covers the leg rows; `agentsComplete` covers the
   * sole-live-agent census, which a truncated agent list cannot prove either.
   */
  readonly tokensComplete: boolean;
  readonly agentsComplete: boolean;
}):
  | { readonly kind: "attributed"; readonly nativeWei: bigint }
  | { readonly kind: "shared-wallet" }
  | { readonly kind: "unpriced" } {
  // The census first: "exactly one live agent on this wallet" is unprovable
  // from a truncated agent list, and guessing it wrong hands one agent another
  // agent's dust.
  if (!input.agentsComplete) return { kind: "shared-wallet" };
  if (input.liveAgentsOnWallet > 1) return { kind: "shared-wallet" };
  if (input.rows.length === 0) return { kind: "attributed", nativeWei: 0n };
  if (input.bnbPriceMicros === null || input.bnbPriceMicros <= 0n) return { kind: "unpriced" };
  if (!input.tokensComplete) return { kind: "unpriced" };

  // FAIL CLOSED on a row whose legs cannot be read. A position always has two
  // legs in the schema, so this cannot happen against a real row — and if it
  // ever does, silently narrowing the leg set would UNDERSTATE the residue,
  // which is the same defect as excluding it and harder to see.
  const legs = new Set<string>();
  for (const row of input.rows) {
    if (typeof row.token0 !== "string" || typeof row.token1 !== "string") return { kind: "unpriced" };
    legs.add(row.token0.toLowerCase());
    legs.add(row.token1.toLowerCase());
  }
  const walletKey = input.agent.walletAddress.toLowerCase();

  let usdMicros = 0n;
  const seen = new Set<string>();
  for (const asset of input.assets) {
    if (asset.kind !== "erc20" || asset.walletAddress.toLowerCase() !== walletKey) continue;
    const token = asset.tokenAddress === null ? null : asset.tokenAddress.toLowerCase();
    if (token === null || !legs.has(token)) continue;
    // A leg this view could not read or price makes the WHOLE residue term
    // unknown. Skipping it would silently understate the agent's holdings,
    // which is the same defect as excluding it — just harder to see.
    if (asset.status === "unreadable" || asset.status === "unpriced") return { kind: "unpriced" };
    if (asset.valueUsdMicros === null) return { kind: "unpriced" };
    seen.add(token);
    usdMicros += BigInt(asset.valueUsdMicros);
  }
  // EVERY leg must have produced a row. An ABSENT row is not a zero balance —
  // it is a leg this read never looked at (the token fell outside the session's
  // spend caps, or the pair list was capped upstream). Summing what is present
  // and calling it complete is REVIEW FINDING 3's exact shape.
  for (const leg of legs) {
    if (!seen.has(leg)) return { kind: "unpriced" };
  }
  // USD → native, through the same BNB price every other figure on this view
  // is marked with. The agent page prices its dust off the POOL ratio instead,
  // so the two can differ by the pool-versus-oracle spread; they cannot differ
  // by the presence of the term, which is what actually flipped the sign.
  return { kind: "attributed", nativeWei: (usdMicros * 10n ** 18n) / input.bnbPriceMicros };
}

/**
 * AGENT-GAS-ATTENTION §3.1 — one agent's gas reading, from inputs this view
 * ALREADY holds.
 *
 * ZERO NEW CHAIN READS: `assets` carries a `kind:"native"` row per wallet
 * (built above), so the balance is already in hand. The only added cost is one
 * bounded settings read per LP agent, and only to learn the grid MODE.
 *
 * `null` whenever the floor cannot be sized — no relay fee, an unsupported
 * profile, an unreadable settings row for an LP agent. A view that cannot size
 * the floor says nothing rather than something convenient.
 */
async function readAgentGas(input: {
  readonly agent: AgentRecord;
  readonly nativeWei: bigint | null;
  readonly deps: AccountPortfolioDeps;
  readonly signal?: AbortSignal;
}): Promise<AccountAgentView["gas"]> {
  const { agent, deps } = input;
  let gridMode: ReturnType<typeof gridModeOf> | null = null;
  if (agent.httpRuntimeProfile === "lp-v1") {
    const settingsStore = deps.lp?.settings;
    if (settingsStore === undefined) return null;
    let record = null;
    try {
      const settingsSignal = dependencySignal(input.signal);
      record = await boundedStoreRead(
        settingsStore.get(agent.ownerAddress, agent.id),
        settingsSignal,
      );
    } catch {
      return null;
    }
    if (record === null) return null;
    const parsed = parseLpSettingsParams(record.params);
    if (!parsed.ok) return null;
    gridMode = parsed.value.grid === null ? null : gridModeOf(parsed.value.grid);
  }
  const floor = agentGasFloor({
    profile: agent.httpRuntimeProfile,
    gridMode,
    ...(deps.lp?.relayFeePerSubmitWei === undefined
      ? {}
      : { relayFeePerSubmitWei: deps.lp.relayFeePerSubmitWei }),
  });
  if (floor === null) return null;
  const nativeWei = input.nativeWei ?? undefined;
  return {
    state: classifyAgentGas({ nativeWei, floor }),
    nativeWei: input.nativeWei === null ? null : input.nativeWei.toString(),
    nextMotionWei: floor.nextMotionWei.toString(),
    warnWei: floor.warnWei.toString(),
    blockWei: floor.blockWei.toString(),
    enforcement: floor.enforcement,
  };
}

/**
 * The `attention` field, with the precedence documented on
 * {@link AccountAgentView.attention}.
 *
 * `"unknown"` gas produces NO attention: an unread balance is a gap in this
 * view, not a fact about the agent, and it is already reported as
 * `gas: { state: "unknown" }` for anyone who wants to say so.
 */
function attentionFor(input: {
  readonly status: AgentStatus;
  readonly gas: AccountAgentView["gas"];
  readonly partialData: boolean;
}): AccountAgentView["attention"] {
  if (input.status === "paused") return "paused";
  if (input.status === "provisioning") return "provisioning";
  // REVIEW FINDING 5 — a `warn-only` profile is NEVER stood down, so it must
  // never be REPORTED as stood down. The first build ignored `enforcement`
  // here, so a short Venus wallet produced `"gas-blocked"` and the Account row
  // told the owner their guard was standing by while the worker was in fact
  // still submitting reduced repays for them. The worst possible lie about a
  // liquidation guard.
  if (input.gas?.state === "blocked") {
    return input.gas.enforcement === "warn-only" ? "gas-low" : "gas-blocked";
  }
  if (input.gas?.state === "low") return "gas-low";
  return input.partialData ? "partial-data" : "none";
}

function coverage(state: CoverageState, reasons: readonly CoverageReason[]): Coverage {
  if (state === "complete" || state === "empty") return { state, reasons: ["none"] };
  const set = new Set<CoverageReason>(reasons);
  set.delete("none");
  return { state, reasons: REASON_ORDER.filter((reason) => set.has(reason)) };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decimal(value: unknown): bigint | null {
  return typeof value === "string" && /^\d{1,120}$/u.test(value) ? BigInt(value) : null;
}

function priceFromEnvelope(envelope: DataPlaneEnvelope<unknown> | null, token: string, now: number): { micros: bigint; asOf: number } | null {
  const data = record(envelope?.data);
  const meta = record(envelope?.meta);
  const price = data?.["priceUsd"];
  if (typeof data?.["address"] !== "string" || data["address"].toLowerCase() !== token.toLowerCase()) return null;
  const asOf = meta?.["asOf"];
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 1e12) return null;
  if (typeof asOf !== "number" || !Number.isFinite(asOf) || asOf > now || now - asOf > 900_000) return null;
  if (meta?.["staleness"] !== "fresh") return null;
  const micros = BigInt(Math.round(price * 1_000_000));
  return micros > 0n ? { micros, asOf } : null;
}

function usdOf(amount: bigint, decimals: number, priceMicros: bigint): bigint {
  return (amount * priceMicros) / (10n ** BigInt(decimals));
}

function signedNativeUsd(amount: bigint, bnbPriceMicros: bigint): bigint {
  return (amount * bnbPriceMicros) / 10n ** 18n;
}

function limitedQueue(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try { return await fn(); } finally { active -= 1; waiting.shift()?.(); }
  };
}

function dependencySignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(5_000);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

async function boundedStoreRead<T>(work: Promise<T>, bounded: AbortSignal): Promise<T> {
  if (bounded.aborted) throw new Error("Account store read timed out.");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Account store read timed out."));
    bounded.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => bounded.removeEventListener("abort", onAbort));
  });
}

function isLive(agent: AgentRecord): boolean { return agent.status === "armed" || agent.status === "paused"; }

function parseVenus(envelope: DataPlaneEnvelope<unknown>, owner: Address, chainId: number, now: number): AccountPortfolioView["venus"] {
  const data = record(envelope.data);
  const meta = record(envelope.meta);
  if (data === null || data["schemaVersion"] !== 2 || data["chainId"] !== chainId || data["pool"] !== "core" || data["status"] !== "available") return null;
  if (typeof data["owner"] !== "string" || data["owner"].toLowerCase() !== owner.toLowerCase()) return null;
  const observedAt = data["observedAt"];
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt > now || now - observedAt > 300_000) return null;
  if (meta?.["staleness"] !== "fresh" || typeof meta["asOf"] !== "number" || Math.abs(meta["asOf"] - observedAt) > 5_000) return null;
  if (!Array.isArray(data["positions"]) || data["positions"].length > 64 || !Array.isArray(data["unavailable"]) || data["unavailable"].length !== 0) return null;
  let supply = 0n; let borrow = 0n;
  const seen = new Set<string>();
  for (const raw of data["positions"]) {
    const position = record(raw); const underlying = record(position?.["underlying"]); const supplied = record(position?.["suppliedUnderlyingStored"]); const debt = record(position?.["borrowStored"]); const prices = record(position?.["prices"]);
    if (position === null || underlying === null || supplied === null || debt === null || prices === null || typeof position["vToken"] !== "string") return null;
    let vToken: string; try { vToken = getAddress(position["vToken"]).toLowerCase(); } catch { return null; }
    if (seen.has(vToken)) return null; seen.add(vToken);
    const decimals = underlying["decimals"];
    if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 36 || supplied["decimals"] !== decimals || debt["decimals"] !== decimals || prices["scaleKind"] !== "venus_underlying_price" || prices["decimals"] !== 36 - (decimals as number)) return null;
    const suppliedValue = decimal(supplied["value"]); const debtValue = decimal(debt["value"]); const spot = decimal(prices["spot"]);
    if (suppliedValue === null || debtValue === null || spot === null || spot <= 0n) return null;
    const scale = 10n ** BigInt((decimals as number) + (prices["decimals"] as number));
    supply += (suppliedValue * spot * 1_000_000n) / scale;
    borrow += (debtValue * spot * 1_000_000n) / scale;
  }
  return { reference: "owner-wide", method: "owner-wide-venus-stored-net-v1", observedAt, supplyUsdMicros: supply.toString(), borrowUsdMicros: borrow.toString(), netUsdMicros: (supply - borrow).toString() };
}

export async function buildAccountPortfolio(owner: Address, deps: AccountPortfolioDeps, options?: AccountPortfolioOptions, signal?: AbortSignal): Promise<AccountPortfolioView> {
  const generatedAt = (deps.now ?? Date.now)();
  const run = limitedQueue(6);
  const bounded = deps.agents.listAgentsBounded;
  const agentStoreSignal = dependencySignal(signal);
  const agentResult = await boundedStoreRead(bounded.call(deps.agents, owner, 32, agentStoreSignal), agentStoreSignal);
  const agents = [...agentResult.rows];
  const truncated = { agents: agentResult.hasMore, wallets: false, tokens: false, walletTokenPairs: false, positions: false };
  const walletAgents = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    const key = agent.walletAddress.toLowerCase();
    const group = walletAgents.get(key) ?? []; group.push(agent); walletAgents.set(key, group);
  }
  let walletEntries = [...walletAgents.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (walletEntries.length > 8) { truncated.wallets = true; walletEntries = walletEntries.slice(0, 8); }
  const conflictingWallets = new Set(walletEntries.filter(([wallet, rows]) => rows.some((row) =>
    row.ownerAddress.toLowerCase() !== owner.toLowerCase()
    || row.walletAddress.toLowerCase() !== wallet
    || row.custodyModel !== rows[0]?.custodyModel,
  )).map(([wallet]) => wallet));
  const agentWalletKeys = new Set(walletEntries.map(([wallet]) => wallet));
  // A DECLARED wallet is one this request named and no row mentions. It is
  // deduplicated against the agent wallets (an address that already has rows is
  // NOT doubled — the agent-derived entry wins, because it carries real
  // knowledge), sorted for determinism, and capped again at two.
  const declaredWallets = [...new Set((options?.declaredWallets ?? []).map((address) => address.toLowerCase()))]
    .filter((address) => !agentWalletKeys.has(address))
    .sort()
    .slice(0, MAX_DECLARED_WALLETS);
  const declaredSet = new Set(declaredWallets);
  // PROVE the declaration before spending a single balance read on it. The
  // verdict is per wallet; exactly one value refuses, and it refuses the whole
  // request rather than quietly dropping the entry — a caller who named an
  // address registered to someone else asked a question this plane will not
  // answer at all.
  const declaredVerdicts = new Map<string, DeclaredWalletVerdict>();
  for (const wallet of declaredWallets) {
    const verdict = await verifyDeclaredWallet({
      owner,
      wallet: getAddress(wallet),
      reader: deps.keyStoreReader,
      signal: dependencySignal(signal),
    });
    if (verdict === "no-matching-key") throw new DeclaredWalletNotOwnedError(wallet);
    declaredVerdicts.set(wallet, verdict);
  }
  const declaredTokens = declaredWallets.length > 0 && deps.chainId === 56 ? DECLARED_WALLET_TOKENS_BSC : [];
  const walletTokens = new Map<string, Set<string>>();
  for (const [wallet, rows] of walletEntries) {
    const set = new Set<string>();
    for (const row of rows) for (const cap of row.sessionFacts?.spec.spendCaps ?? []) if (cap.token !== undefined) set.add(cap.token.toLowerCase());
    walletTokens.set(wallet, set);
  }
  let tokenIds = [...new Set([...[...walletTokens.values()].flatMap((set) => [...set]), ...declaredTokens])].sort();
  if (tokenIds.length > 64) { truncated.tokens = true; tokenIds = tokenIds.slice(0, 64); }
  const allowedTokens = new Set(tokenIds);
  // Declared pairs are listed FIRST so the 128 cap can never silently drop the
  // one wallet a fresh passkey user is looking at (at most 2 x 6 of them).
  let pairs = [
    ...declaredWallets.flatMap((wallet) => declaredTokens.filter((token) => allowedTokens.has(token)).sort().map((token) => ({ wallet, token }))),
    ...walletEntries.flatMap(([wallet]) => [...(walletTokens.get(wallet) ?? [])].filter((token) => allowedTokens.has(token)).sort().map((token) => ({ wallet, token }))),
  ];
  if (pairs.length > 128) { truncated.walletTokenPairs = true; pairs = pairs.slice(0, 128); }

  const priceAddresses = [...new Set([deps.wbnb.toLowerCase(), ...tokenIds])];
  // The wallet/token SETS are fully known by this point, so the four fetch
  // phases below depend on NOTHING each other produces — only on these lists.
  // They used to run as four awaited phases, which cost four serial latencies
  // (measured: 10-15 s per load). They now run as ONE `Promise.all` and the
  // view is ASSEMBLED afterwards, once every raw answer is in hand. That
  // assembly split is what makes the parallelism legal: pricing an asset needs
  // both its balance and its price, and neither phase may read the other's map.
  //
  // Each phase keeps its OWN bounded queue rather than sharing one. A shared
  // queue would let the price calls consume slots the balance reads used to
  // have, changing the per-phase concurrency the account read is specified at.
  const runPrices = run;
  const runMeta = limitedQueue(6);
  const runNative = limitedQueue(6);
  const runToken = limitedQueue(6);
  const nativeWallets = [...walletEntries.map(([wallet]) => wallet), ...declaredWallets].filter((wallet) => !conflictingWallets.has(wallet));
  // A pair with neither a row nor a declaration was never read; filtering it
  // HERE (instead of returning early inside the read) keeps the batched
  // reader's positional alignment honest.
  const activePairs = pairs.filter(({ wallet }) => !conflictingWallets.has(wallet) && (walletAgents.get(wallet)?.[0] !== undefined || declaredSet.has(wallet)));

  const prices = new Map<string, { micros: bigint; asOf: number } | null>();
  const metadata = new Map<string, { decimals: number; symbol: string | null } | null>();
  const nativeBalances = new Map<string, bigint | null>();
  const tokenBalances = new Map<string, bigint | null>();
  const pairKey = (wallet: string, token: string): string => wallet + "|" + token;

  await Promise.all([
    // (1) PRICES — a remote HTTP service, so it keeps the bounded queue.
    Promise.all(priceAddresses.map((address) => runPrices(async () => {
      if (deps.dataPlane.tokenEnvelope === undefined) { prices.set(address, null); return; }
      try { prices.set(address, priceFromEnvelope(await deps.dataPlane.tokenEnvelope(address, dependencySignal(signal)), address, generatedAt)); } catch { prices.set(address, null); }
    }))),
    // (2) TOKEN METADATA.
    (async () => {
      const batched = deps.balanceReader?.tokenMetadata;
      if (batched !== undefined && tokenIds.length > 0) {
        // A throw from the batched seam is an ABSENT answer, never a failed
        // request: every unset entry reads back `null` at assembly.
        try {
          const answers = await batched.call(deps.balanceReader, tokenIds.map((token) => getAddress(token)), dependencySignal(signal));
          tokenIds.forEach((token, index) => {
            const value = answers[index];
            metadata.set(token, value !== undefined && value.decimals !== null && Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 255 ? { decimals: value.decimals, symbol: value.symbol } : null);
          });
        } catch { for (const token of tokenIds) metadata.set(token, null); }
        return;
      }
      await Promise.all(tokenIds.map((token) => runMeta(async () => {
        if (deps.provider.getTokenMetadata === undefined) { metadata.set(token, null); return; }
        try {
          const value = await deps.provider.getTokenMetadata({ token: getAddress(token), signal: dependencySignal(signal) });
          metadata.set(token, Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 255 ? value : null);
        } catch { metadata.set(token, null); }
      })));
    })(),
    // (3) NATIVE BALANCES.
    (async () => {
      if (deps.balanceReader !== undefined) {
        try {
          const answers = await deps.balanceReader.nativeBalances(nativeWallets.map((wallet) => getAddress(wallet)), dependencySignal(signal));
          nativeWallets.forEach((wallet, index) => nativeBalances.set(wallet, answers[index] ?? null));
        } catch { for (const wallet of nativeWallets) nativeBalances.set(wallet, null); }
        return;
      }
      await Promise.all(nativeWallets.map((wallet) => runNative(async () => {
        try { nativeBalances.set(wallet, await deps.provider.getBalance({ address: getAddress(wallet), signal: dependencySignal(signal) })); }
        catch { nativeBalances.set(wallet, null); }
      })));
    })(),
    // (4) ERC-20 BALANCES.
    (async () => {
      if (deps.balanceReader !== undefined) {
        try {
          const answers = await deps.balanceReader.tokenBalances(activePairs.map(({ wallet, token }) => ({ wallet: getAddress(wallet), token: getAddress(token) })), dependencySignal(signal));
          activePairs.forEach(({ wallet, token }, index) => tokenBalances.set(pairKey(wallet, token), answers[index] ?? null));
        } catch { for (const { wallet, token } of activePairs) tokenBalances.set(pairKey(wallet, token), null); }
        return;
      }
      await Promise.all(activePairs.map(({ wallet, token }) => runToken(async () => {
        const row = walletAgents.get(wallet)?.[0];
        try {
          // REVISION R1: the ref carries the ROW's owner, never the session
          // owner. They agree today (`conflictingWallets` refuses the wallet
          // otherwise), but under passkey custody `ownerAddress` is a
          // non-payable identity, and a ref built from the wrong one is a
          // burned-funds shape the moment this ref reaches anything but a read.
          //
          // A DECLARED wallet has no row to take an owner from, so the ref is
          // built from the authenticated session owner and `"passkey"`. That
          // ref is READ-ONLY by construction here and asserts no custody — see
          // `AccountPortfolioOptions`.
          const ref = row === undefined
            ? { address: getAddress(wallet), chainId: deps.chainId, ownerAddress: getAddress(owner), custodyModel: "passkey" as const }
            : { address: getAddress(wallet), chainId: deps.chainId, ownerAddress: getAddress(row.ownerAddress), custodyModel: row.custodyModel };
          tokenBalances.set(pairKey(wallet, token), await deps.provider.getTokenBalance({ wallet: ref, token: getAddress(token), signal: dependencySignal(signal) }));
        } catch { tokenBalances.set(pairKey(wallet, token), null); }
      })));
    })(),
  ]);

  const assets: AccountPortfolioView["assets"][number][] = [];
  for (const wallet of nativeWallets) {
    const price = prices.get(deps.wbnb.toLowerCase()) ?? null;
    const balance = nativeBalances.get(wallet) ?? null;
    if (balance === null) {
      assets.push({ kind: "native", walletAddress: wallet, tokenAddress: null, symbol: "BNB", decimals: 18, balanceAtomic: null, priceUsdMicros: price?.micros.toString() ?? null, pricedAt: price?.asOf ?? null, valueUsdMicros: null, status: "unreadable", method: "wallet-native-v1" });
      continue;
    }
    const value = price === null ? null : usdOf(balance, 18, price.micros);
    assets.push({ kind: "native", walletAddress: wallet, tokenAddress: null, symbol: "BNB", decimals: 18, balanceAtomic: balance.toString(), priceUsdMicros: price?.micros.toString() ?? null, pricedAt: price?.asOf ?? null, valueUsdMicros: value?.toString() ?? null, status: balance === 0n ? "zero" : value === null ? "unpriced" : "priced", method: "wallet-native-v1" });
  }
  for (const { wallet, token } of activePairs) {
    const meta = metadata.get(token) ?? null; const price = prices.get(token) ?? null;
    const balance = tokenBalances.get(pairKey(wallet, token)) ?? null;
    if (balance === null) {
      assets.push({ kind: "erc20", walletAddress: wallet, tokenAddress: token, symbol: meta?.symbol ?? null, decimals: meta?.decimals ?? null, balanceAtomic: null, priceUsdMicros: price?.micros.toString() ?? null, pricedAt: price?.asOf ?? null, valueUsdMicros: null, status: "unreadable", method: "wallet-known-erc20-v1" });
      continue;
    }
    const value = balance === 0n ? 0n : meta === null || price === null ? null : usdOf(balance, meta.decimals, price.micros);
    assets.push({ kind: "erc20", walletAddress: wallet, tokenAddress: token, symbol: meta?.symbol ?? null, decimals: meta?.decimals ?? null, balanceAtomic: balance.toString(), priceUsdMicros: price?.micros.toString() ?? null, pricedAt: price?.asOf ?? null, valueUsdMicros: value?.toString() ?? null, status: balance === 0n ? "zero" : value === null ? "unpriced" : "priced", method: "wallet-known-erc20-v1" });
  }
  assets.sort((a, b) => a.walletAddress.localeCompare(b.walletAddress) || (a.kind === b.kind ? (a.tokenAddress ?? "").localeCompare(b.tokenAddress ?? "") : a.kind === "native" ? -1 : 1));

  const walletCapacity = truncated.agents || truncated.wallets || truncated.tokens || truncated.walletTokenPairs;
  const walletBad = assets.some((asset) => asset.status === "unpriced" || asset.status === "unreadable");
  const walletSum = assets.reduce((sum, asset) => sum + (asset.valueUsdMicros === null ? 0n : BigInt(asset.valueUsdMicros)), 0n);
  const walletCoverage = walletCapacity ? coverage("partial", ["capacity"]) : conflictingWallets.size > 0 ? coverage("partial", ["identity-conflict"]) : walletBad ? coverage("partial", assets.some((a) => a.status === "unreadable") ? ["unreadable"] : ["unpriced"]) : coverage(agents.length === 0 && declaredWallets.length === 0 ? "empty" : "complete", ["none"]);

  const lpAgents = agents.filter((agent) => isLive(agent) && agent.httpRuntimeProfile === "lp-v1");
  let lpPositions: readonly LpPositionRecord[] = [];
  const listOwnerPositionsBounded = deps.lp?.store.listOwnerPositionsBounded;
  let lpUnavailable = lpAgents.length > 0 && listOwnerPositionsBounded === undefined;
  if (lpAgents.length > 0 && listOwnerPositionsBounded !== undefined) {
    try {
      const lpStoreSignal = dependencySignal(signal);
      const result = await boundedStoreRead(listOwnerPositionsBounded.call(deps.lp!.store, owner, lpAgents.map((a) => a.id), ["open", "closing"], 64, lpStoreSignal), lpStoreSignal);
      lpPositions = result.rows; truncated.positions = result.hasMore;
    } catch {
      lpUnavailable = true;
    }
  }

  const positionsByAgent = new Map<string, LpPositionRecord[]>();
  for (const position of lpPositions) { const rows = positionsByAgent.get(position.agentId) ?? []; rows.push(position); positionsByAgent.set(position.agentId, rows); }
  const bnbPrice = prices.get(deps.wbnb.toLowerCase()) ?? null;
  const agentViews: AccountAgentView[] = [];
  // REVISION R4: the same LP marks, attributed to the wallet the agent runs on,
  // so the UI can say "Available" and "Deployed" beside a deposit target
  // instead of only owner-wide. A wallet in `deployedIncomplete` is one whose
  // deployed figure this view refuses to publish.
  const deployedByWallet = new Map<string, bigint>();
  const deployedIncomplete = new Set<string>();
  // AGENT-GAS-ATTENTION §4 — how many LIVE agents share each wallet, which is
  // the whole attribution rule for wallet residue. Counted over LIVE rows only:
  // a paused or revoked agent is not competing for the dust.
  const liveAgentsByWallet = new Map<string, number>();
  for (const agent of agents) {
    if (!isLive(agent)) continue;
    const key = agent.walletAddress.toLowerCase();
    liveAgentsByWallet.set(key, (liveAgentsByWallet.get(key) ?? 0) + 1);
  }
  let deployedNative = 0n; let eligibleBasis = 0n; let aggregatePnl = 0n; let pnlComplete = !truncated.positions; let deployedComplete = !truncated.positions;
  const observationTimes: number[] = assets.filter((a) => a.status === "priced" && a.balanceAtomic !== "0" && a.pricedAt !== null).map((a) => a.pricedAt!);
  for (const agent of agents) {
    const rows = positionsByAgent.get(agent.id) ?? [];
    // AGENT-GAS-ATTENTION §3.1 — computed ONCE per agent, from the native
    // balance this view already read, and shared by every branch below so the
    // three exit paths cannot report different health for the same wallet.
    const gas = await readAgentGas({
      agent,
      nativeWei: nativeBalances.get(agent.walletAddress.toLowerCase()) ?? null,
      deps,
      ...(signal === undefined ? {} : { signal }),
    });
    if (agent.httpRuntimeProfile === "lp-v1" && isLive(agent)) {
      if (lpUnavailable) {
        deployedComplete = false;
        pnlComplete = false;
        deployedIncomplete.add(agent.walletAddress.toLowerCase());
        agentViews.push({ id: agent.id, status: agent.status, httpRuntimeProfile: agent.httpRuntimeProfile, walletAddress: agent.walletAddress, attention: attentionFor({ status: agent.status, gas, partialData: true }), gas, holdings: { method: "sellable-lp-exit-v1", state: "unavailable", reason: "dependency", valueUsdMicros: null, venusReference: null, held: false }, pnl: { method: "gross-lp-mark-plus-residue-to-declared-basis-v2", coverage: "unavailable", reason: "dependency", eligibleBasisNativeWei: null, markNativeWei: null, pnlNativeWei: null, pnlUsdMicros: null, pnlBps: null, basisSources: [], excluded: [...EXCLUDED] } });
        continue;
      }
      let mark = 0n; let basis = 0n; let pnl = 0n; let valid = 0; let missing = 0; let zeroBasis = 0; const sources = new Set<"owner-budget" | "imported">(); let held = false;
      for (const row of rows) {
        let observation = null;
        try {
          const observationSignal = dependencySignal(signal);
          observation = await boundedStoreRead(deps.lp!.observations.get(owner, agent.id, row.positionId, observationSignal), observationSignal);
        } catch { observation = null; }
        const value = observation?.valuation;
        const age = value === undefined ? -1 : generatedAt - value.valuedAtMs;
        const maxAge = Math.min(900_000, Math.max(2 * (deps.lp?.workerIntervalMs ?? 30_000) + 5_000, 60_000));
        if (value === undefined || row.tokenId === null || value.tokenId !== row.tokenId || value.positionRowVersion !== row.rowVersion || value.quoteToken.toLowerCase() !== row.quoteToken.toLowerCase() || age < 0 || age > maxAge) { missing += 1; continue; }
        mark += value.exitValueWei; deployedNative += value.exitValueWei; observationTimes.push(value.valuedAtMs); valid += 1; held ||= row.state === "closing";
        if (row.basisWei > 0n) { basis += row.basisWei; pnl += value.exitValueWei - row.basisWei; if (row.basisSource !== "minted") sources.add(row.basisSource); } else zeroBasis += 1;
      }
      const agentWalletKey = agent.walletAddress.toLowerCase();
      // ═══ AGENT-GAS-ATTENTION §4 — WALLET RESIDUE, AND THE TRAP BESIDE IT ══
      //
      // `deployedByWallet` and `deployedNative` above stay on the POSITION-ONLY
      // mark, and that is not an oversight. Wallet residue is ALREADY counted
      // in `totals.walletUsdMicros` through the `assets` rows; adding it to the
      // deployed aggregate as well would double-count it inside
      // `totals.totalUsdMicros`. Only the PnL mark gains the term.
      const residue = walletResidueNativeWei({
        agent, rows, assets, liveAgentsOnWallet: liveAgentsByWallet.get(agentWalletKey) ?? 0,
        bnbPriceMicros: bnbPrice?.micros ?? null,
        // REVIEW FINDING 3 — the completeness proofs, from the same flags the
        // rest of this view already reports truncation with.
        tokensComplete: !truncated.tokens && !truncated.walletTokenPairs && !truncated.wallets,
        agentsComplete: !truncated.agents,
      });
      deployedByWallet.set(agentWalletKey, (deployedByWallet.get(agentWalletKey) ?? 0n) + mark);
      if (missing > 0) deployedIncomplete.add(agentWalletKey);
      const full = missing === 0 && zeroBasis === 0 && residue.kind === "attributed";
      if (missing > 0) deployedComplete = false;
      if (!full && rows.length > 0) pnlComplete = false;
      // The PnL mark, and the ONLY figure the residue term reaches.
      const pnlMark = mark + (residue.kind === "attributed" ? residue.nativeWei : 0n);
      const pnlWithResidue = pnl + (residue.kind === "attributed" ? residue.nativeWei : 0n);
      if (full && basis > 0n) { eligibleBasis += basis; aggregatePnl += pnlWithResidue; }
      const valueUsd = bnbPrice === null || missing > 0 ? null : signedNativeUsd(mark, bnbPrice.micros);
      const pnlUsd = bnbPrice === null || basis === 0n ? null : signedNativeUsd(pnlWithResidue, bnbPrice.micros);
      const pnlCoverage = rows.length === 0 ? "full" : basis === 0n ? "unavailable" : full ? "full" : "partial";
      const publishPnl = pnlCoverage === "full" && basis > 0n;
      agentViews.push({ id: agent.id, status: agent.status, httpRuntimeProfile: agent.httpRuntimeProfile, walletAddress: agent.walletAddress, attention: attentionFor({ status: agent.status, gas, partialData: missing > 0 || zeroBasis > 0 }), gas, holdings: { method: "sellable-lp-exit-v1", state: rows.length === 0 ? "empty" : missing > 0 ? "partial" : "complete", reason: missing > 0 ? "missing-mark" : held ? "held" : "none", valueUsdMicros: valueUsd?.toString() ?? null, venusReference: null, held }, pnl: { method: "gross-lp-mark-plus-residue-to-declared-basis-v2", coverage: pnlCoverage, reason: missing > 0 ? "missing-mark" : zeroBasis > 0 ? "zero-basis" : residue.kind === "shared-wallet" ? "shared-wallet" : residue.kind === "unpriced" ? "unpriced" : held ? "held" : "none", eligibleBasisNativeWei: publishPnl ? basis.toString() : null, markNativeWei: publishPnl ? pnlMark.toString() : null, pnlNativeWei: publishPnl ? pnlWithResidue.toString() : null, pnlUsdMicros: publishPnl ? pnlUsd?.toString() ?? null : null, pnlBps: publishPnl ? ((pnlWithResidue * 10_000n) / basis).toString() : null, basisSources: publishPnl ? [...sources].sort() : [], excluded: residue.kind === "attributed" ? [...EXCLUDED_WITH_RESIDUE_COUNTED] : [...EXCLUDED] } });
    } else {
      if (isLive(agent)) pnlComplete = false;
      agentViews.push({ id: agent.id, status: agent.status, httpRuntimeProfile: agent.httpRuntimeProfile, walletAddress: agent.walletAddress, attention: attentionFor({ status: agent.status, gas, partialData: false }), gas, holdings: { method: agent.httpRuntimeProfile === "venus-v1" ? "owner-wide-venus-stored-net-v1" : "none", state: agent.status === "provisioning" ? "partial" : "empty", reason: agent.status === "provisioning" ? "dependency" : "none", valueUsdMicros: null, venusReference: agent.httpRuntimeProfile === "venus-v1" ? "owner-wide" : null, held: false }, pnl: { method: "none", coverage: isLive(agent) ? "unsupported" : "unavailable", reason: isLive(agent) ? "unsupported-profile" : "none", eligibleBasisNativeWei: null, markNativeWei: null, pnlNativeWei: null, pnlUsdMicros: null, pnlBps: null, basisSources: [], excluded: [] } });
    }
  }

  if (truncated.positions) {
    for (let index = 0; index < agentViews.length; index += 1) {
      const view = agentViews[index]!;
      if (view.httpRuntimeProfile !== "lp-v1" || !isLive(agents.find((agent) => agent.id === view.id)!)) continue;
      deployedIncomplete.add(view.walletAddress.toLowerCase());
      agentViews[index] = {
        ...view,
        // AGENT-GAS-ATTENTION §3.1 — truncation degrades the POSITION data, not
        // the wallet balance, so a `gas-*` attention must survive it. Losing it
        // here would hide "needs gas" on exactly the busiest accounts.
        attention: attentionFor({
          status: view.status,
          gas: view.gas,
          partialData: true,
        }),
        holdings: { ...view.holdings, state: "partial", reason: "capacity", valueUsdMicros: null },
        pnl: { ...view.pnl, coverage: "partial", reason: "capacity", eligibleBasisNativeWei: null, markNativeWei: null, pnlNativeWei: null, pnlUsdMicros: null, pnlBps: null, basisSources: [] },
      };
    }
  }

  const needsVenus = agents.some((agent) => isLive(agent) && agent.httpRuntimeProfile === "venus-v1");
  let venus: AccountPortfolioView["venus"] = null;
  if (needsVenus) {
    try { const result = await deps.dataPlane.venusAccount(owner, dependencySignal(signal)); if (result.kind === "ok") venus = parseVenus(result.envelope, owner, deps.chainId, generatedAt); } catch { venus = null; }
    if (venus === null) deployedComplete = false; else {
      observationTimes.push(venus.observedAt);
      for (let index = 0; index < agentViews.length; index += 1) {
        const view = agentViews[index]!;
        if (view.httpRuntimeProfile === "venus-v1" && isLive(agents.find((agent) => agent.id === view.id)!)) {
          agentViews[index] = { ...view, holdings: { method: "owner-wide-venus-stored-net-v1", state: "complete", reason: "none", valueUsdMicros: null, venusReference: "owner-wide", held: false } };
        }
      }
    }
  }
  if (bnbPrice === null && deployedNative !== 0n) deployedComplete = false;
  if (bnbPrice !== null && (deployedNative !== 0n || pnlComplete && eligibleBasis > 0n)) observationTimes.push(bnbPrice.asOf);
  const lpDeployedUsd = bnbPrice === null ? 0n : signedNativeUsd(deployedNative, bnbPrice.micros);
  const deployedUsd = lpDeployedUsd + (venus === null ? 0n : BigInt(venus.netUsdMicros));
  const walletValue = walletCoverage.state === "complete" || walletCoverage.state === "empty" ? walletSum : null;
  const capacity = Object.values(truncated).some(Boolean);
  const deployedState = capacity || !deployedComplete ? coverage("partial", capacity ? ["capacity"] : lpUnavailable || needsVenus && venus === null ? ["dependency"] : ["missing-mark"]) : coverage(deployedUsd === 0n ? "empty" : "complete", ["none"]);
  const deployedValue = deployedState.state === "complete" || deployedState.state === "empty" ? deployedUsd : null;
  const totalValue = walletValue === null || deployedValue === null ? null : walletValue + deployedValue;
  const pnlValue = pnlComplete && eligibleBasis > 0n && bnbPrice !== null ? signedNativeUsd(aggregatePnl, bnbPrice.micros) : null;
  const pnlCoverage = capacity ? coverage("partial", ["capacity"]) : pnlValue === null ? coverage(agents.length === 0 ? "empty" : "partial", [agents.some((a) => isLive(a) && a.httpRuntimeProfile !== "lp-v1") ? "unsupported-profile" : "missing-mark"]) : coverage("complete", ["none"]);
  const walletViews = walletEntries.map(([wallet, rows]) => {
    const own = assets.filter((asset) => asset.walletAddress === wallet);
    const unpriceable = walletCapacity || conflictingWallets.has(wallet) || own.some((asset) => asset.status === "unpriced" || asset.status === "unreadable");
    const deployedWei = deployedByWallet.get(wallet) ?? 0n;
    const deployedUnpriceable = capacity || deployedIncomplete.has(wallet) || bnbPrice === null && deployedWei !== 0n;
    return {
      address: wallet,
      custodyModel: rows[0]!.custodyModel,
      depositable: true as const,
      source: "agents" as const,
      availableUsdMicros: unpriceable ? null : own.reduce((sum, asset) => sum + (asset.valueUsdMicros === null ? 0n : BigInt(asset.valueUsdMicros)), 0n).toString(),
      deployedUsdMicros: deployedUnpriceable ? null : (bnbPrice === null ? 0n : signedNativeUsd(deployedWei, bnbPrice.micros)).toString(),
      deployedReason: (!deployedUnpriceable ? "none" : capacity ? "capacity" : lpUnavailable ? "dependency" : bnbPrice === null ? "unpriced" : "missing-mark") as CoverageReason,
    };
  });
  // A declared wallet's deployed figure is `"0"` because NO AGENT RUNS THERE,
  // not because the plane measured zero — `deployedReason: "declared"` is that
  // distinction on the wire.
  const declaredViews = declaredWallets.map((wallet) => {
    const own = assets.filter((asset) => asset.walletAddress === wallet);
    const unpriceable = walletCapacity || own.some((asset) => asset.status === "unpriced" || asset.status === "unreadable");
    return {
      address: wallet,
      custodyModel: "passkey" as const,
      depositable: true as const,
      source: "declared" as const,
      availableUsdMicros: unpriceable ? null : own.reduce((sum, asset) => sum + (asset.valueUsdMicros === null ? 0n : BigInt(asset.valueUsdMicros)), 0n).toString(),
      deployedUsdMicros: "0",
      deployedReason: "declared" as CoverageReason,
      passkeyVerified: declaredVerdicts.get(wallet) ?? "unreadable",
    };
  });
  return { generatedAt, asOf: totalValue === null || observationTimes.length === 0 ? null : Math.min(...observationTimes), ownerAddress: owner.toLowerCase(), wallets: [...walletViews, ...declaredViews], assets, venus, totals: { walletUsdMicros: walletValue?.toString() ?? null, deployedUsdMicros: deployedValue?.toString() ?? null, totalUsdMicros: totalValue?.toString() ?? null, grossLpPnlUsdMicros: capacity ? null : pnlValue?.toString() ?? null, grossLpPnlBps: capacity || pnlValue === null || eligibleBasis === 0n ? null : ((aggregatePnl * 10_000n) / eligibleBasis).toString(), eligibleLpBasisNativeWei: capacity ? null : eligibleBasis > 0n ? eligibleBasis.toString() : null }, agents: agentViews, coverage: { universe: "known-assets", wallet: walletCoverage, deployed: deployedState, total: totalValue === null ? coverage("partial", [...walletCoverage.reasons, ...deployedState.reasons]) : coverage(totalValue === 0n ? "empty" : "complete", ["none"]), pnl: pnlCoverage, truncated } };
}
