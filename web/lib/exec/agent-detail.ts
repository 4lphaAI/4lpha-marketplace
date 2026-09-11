import { parseFeeEvidence, feeMetric, type FeeEvidence } from "@/lib/lp/fees";
import { parseErc8004Identity, type Erc8004Identity } from "./erc8004-identity";
import {
  USDT_56,
  WBNB_56,
  formatAtomic,
  midpointWbnbUsdtPrice,
  pairQuoting,
  poolAddressFor,
  rangePrices,
  priceAtTick,
  type MajorSymbol,
  type ReviewedPair,
  nftPositionUrl,
  resolvePair,
  getSqrtRatioAtTick,
  type TokenMetaMap,
} from "./pairs";

type Row = Record<string, unknown>;
const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SIGNED_DECIMAL = /^-?(?:0|[1-9][0-9]*)$/u;
const HASH = /^0x[0-9a-f]{64}$/iu;
const STATUSES = new Set(["provisioning", "armed", "paused", "revoked", "retired"]);

export type DetailMetric = {
  readonly tokenBreakdown?: string;
  readonly rawWei?: string;
  readonly value: string | null;
  readonly reason: string | null;
  readonly note?: string;
  /** Same quantity in each unit, when both are known. The tile picks one. */
  readonly bnb?: string;
  readonly usd?: string;
};

export type DetailPosition = {
  readonly token0?: string;
  readonly token1?: string;
  readonly fee?: number;
  readonly rowVersion?: number;
  readonly lineageId?: string;
  readonly updatedAt?: number;
  readonly feeEvidence?: FeeEvidence;
  readonly positionId: string;
  readonly state: string;
  readonly tokenId: string | null;
  readonly pair: string;
  readonly role: string;
  readonly age: string;
  readonly ageTitle: string;
  readonly value: DetailMetric;
  readonly unrealised: DetailMetric;
  readonly fees: DetailMetric;
  readonly nftUrl: string | null;
  /** The signed rung this row holds, and its two price edges in the quote asset. */
  readonly rung: {
    readonly tickLower: number;
    readonly tickUpper: number;
    readonly priceLow: string;
    readonly priceHigh: string;
    /** The edge the order completes at: the high for an ask, the low for a bid. */
    readonly fillPrice: string;
  } | null;
  /** "ASK BTCB" for a rung selling the base, "BID WBNB" for one bidding the quote. */
  readonly sideLabel: string | null;
};

/**
 * AGENT-GAS-ATTENTION §3.2 — the agent's gas standing as the page reads it.
 *
 * `state` is the plane's own classification and is what the UI branches on;
 * the wei figures are for the remedy sentence. `low` is kept as a convenience
 * for the shipped grid banner and means `blocked || low` — never branch on it
 * where the two need distinguishing.
 *
 * `warnWei: null` marks a block projected from the older shift-only `buffer`,
 * which never carried a warn threshold. `nativeWei: null` means the balance
 * could not be read — a dash with a reason, never a zero.
 */
export type AgentGasView = {
  readonly nativeWei: string | null;
  readonly nextMotionWei: string;
  readonly warnWei: string | null;
  readonly blockWei: string;
  readonly state: "unknown" | "blocked" | "low" | "ok";
  readonly enforcement: "block" | "warn-only";
  readonly low: boolean;
};

/**
 * AGENT-GAS-ATTENTION §5 — which bucket a run-log row belongs to.
 *
 * THREE buckets, not the two the operator first asked for, and the third is the
 * point: `active` is a sequence still in flight. A two-way split would file it
 * under one of the other two, and a stuck sequence would then be either
 * celebrated as a success or lost among genuine failures — which is exactly the
 * row an operator opens the run log to find.
 *
 * The FAILED predicate is the one `LpAgentDetail` already used to decide
 * whether a row was worth a "Details" button, moved here so the filter and the
 * expander cannot drift apart.
 */
export type SequenceOutcome = "succeeded" | "failed" | "in-flight";

export function sequenceOutcome(sequence: {
  readonly state: string;
  readonly outcomeUnavailable?: boolean;
  readonly stallCode?: string | null;
}): SequenceOutcome {
  // `completed` IS THE VERDICT. Review finding 7 asked for the failure evidence
  // to be tested first, and the first deploy (2026-09-11) showed why that was
  // wrong against what the plane actually persists:
  //
  //   - `stallCode` is written when a resume PARKS and is never cleared when
  //     the sequence later completes, so every grid shift that stalled once
  //     and then landed — four of them, each with a confirmed tx — was filed
  //     under Failed, and Succeeded read "No succeeded runs".
  //   - `outcomeUnavailable` means SOME step's journal row could not be read,
  //     which happens on completed rotates too; a telemetry gap on a motion
  //     that landed is not a failed motion.
  //
  // A historical stall or a missing journal row is DETAIL — the LP page's
  // "Details" expander still surfaces both — not a bucket. Only a sequence
  // that is still `active` and carries either signal is genuinely stuck.
  if (sequence.state === "completed") return "succeeded";
  if (sequence.state === "active") {
    return sequence.outcomeUnavailable === true || (sequence.stallCode ?? null) !== null
      ? "failed"
      : "in-flight";
  }
  // `rolled-back`, `held`, `abandoning`, `resolving`, `retiring-pre-bind`.
  return "failed";
}

export type DetailMotion = {
  readonly sequenceId: string;
  readonly classification: "settlement" | "drift" | "unknown";
  readonly label: string;
  readonly collected: string;
  readonly price: DetailMetric;
  readonly time: string;
  readonly timeTitle: string;
  readonly txHash: string | null;
};

export type DetailSequence = {
  readonly sequenceId: string;
  readonly positionId: string;
  readonly kind: string;
  readonly state: string;
  readonly recoveryState: string;
  readonly note: string | null;
  readonly outcomeUnavailable: boolean;
  readonly txHashes: readonly string[];
  /** Each step's journal decision id and state, so a stuck step can be named to the owner-signed resolver. */
  readonly steps: readonly { readonly index: number; readonly kind: string; readonly decisionId: string; readonly state: string | null; readonly txHash?: string | null }[];
  /** The plane's durable stall latch (additive, may be absent on older planes). */
  readonly stallCode?: string | null;
  readonly stallCount?: number;
  readonly updatedAt: number;
  readonly createdAt: number | null;
  /** grid-shift only: why it moved and where it moved to (PHASE3.22 R8 targets). */
  readonly shiftCause: string | null;
  readonly targetBuyRange: { readonly tickLower: number; readonly tickUpper: number } | null;
  readonly targetSellRange: { readonly tickLower: number; readonly tickUpper: number } | null;
};

export type LpDetailView = {
  readonly workerIntervalMs?: number;
  readonly wbnbUsd?: number | null;
  readonly feeMetric?: DetailMetric;
  readonly currentTickFresh?: boolean;
  readonly latestPositionId?: string;
  readonly eligibleCandidates?: number;
  readonly model: "custom" | "sigma" | null;
  readonly pool: {
    readonly quoteIsToken0?: boolean;
    readonly pair: string;
    readonly base: string | null;
    readonly quote: string | null;
    readonly symbol0: string | null;
    readonly symbol1: string | null;
    readonly decimals0: number | null;
    readonly decimals1: number | null;
    readonly token0: string;
    readonly token1: string;
    readonly fee: number;
    readonly poolAddress: string | null;
    readonly wbnbIsToken0: boolean;
    readonly tickSpacing: number | null;
    readonly baseAddress: string | null;
    readonly quoteAddress: string | null;
    readonly quoteUsd: number | null;
  } | null;
  readonly openingRange: {
    readonly source: "explicit" | "server-fenced";
    readonly tickLower: number;
    readonly tickUpper: number;
  } | null;
  readonly liveRange: {
    readonly tickLower: number;
    readonly tickUpper: number;
    readonly asOfMs: number;
  } | null;
  readonly liveRangeReason: string | null;
  readonly currentTick: number | null;
  readonly currentTickAsOfMs: number | null;
  readonly currentTickSource: "live" | "worker" | null;
  readonly currentTickReason: string | null;
  readonly settingsTrusted: boolean;
  readonly settingsReason: string | null;
  readonly settings: null | {
    readonly autoRotate: boolean;
    readonly rotateMode: "swapped" | "swapless";
    readonly rotateMinHoldMinutes: number;
    readonly autoHarvest: boolean;
    readonly harvestMinFeesWei: string;
    readonly takeProfitPct: number | null;
    readonly stopLossPct: number | null;
    readonly brain: null | {
      readonly primaryModel: string;
      readonly fallbackModel: string;
    };
  };
  readonly valuation: DetailMetric;
  readonly recordedPnl: DetailMetric;
  readonly budgetWei: string;
  readonly selectPool: { readonly by: "fee-apr" | "volume"; readonly window: "24h" } | null;
  readonly restart: string | null;
  readonly reason: string | null;
};

export type AgentDetailView = {
  readonly erc8004Identity?: Erc8004Identity;
  readonly id: string;
  readonly status: string;
  readonly httpRuntimeProfile?: string;
  readonly hireSizingName: string | null;
  readonly walletAddress: string;
  readonly sessionPublicKey: string | null;
  readonly provisioning: boolean;
  readonly actionDisabledReason: string | null;
  readonly armMs: number | null;
  readonly hodl?: DetailMetric;
  readonly hodlArmTxHash?: string;
  readonly dailyNativeLimit: DetailMetric;
  readonly recordedCycleDelta: DetailMetric;
  /**
   * GROSS PnL: everything the agent holds, priced in WBNB, minus the budget it
   * was armed with. Gas is deliberately excluded — it is paid from the native
   * meter, not from the position, and including it would make a shift ladder's
   * PnL a gas report. Unlike `recordedCycleDelta` this does not wait for a
   * completed round trip, which is why a grid that has only shifted still
   * shows a number.
   */
  readonly grossPnl: DetailMetric;
  readonly grossPnlPercent: DetailMetric;
  readonly recordedCycles: DetailMetric;
  readonly levels: readonly {
    positionId: string;
    role: string;
    recordedCycles: number;
    roundTrips: number;
    deltaWei: string | null;
    delta: DetailMetric;
  }[];
  readonly cycleHistoryAvailable: boolean;
  readonly cycleNote: string;
  /**
   * AGENT-GAS-ATTENTION §3.2 — the wallet's NATIVE pot against what the agent's
   * NEXT MOTION costs in relay gas, for every profile. `null` when the plane
   * did not report it: no source, no claim.
   *
   * Superseded GRID-GAS-RESERVE W2, which reported this for shift grids ONLY
   * (out of the grid `buffer` block). That narrowness is why the LP agents in
   * the 2026-09-10 report could not warn about gas at all. A `buffer`-sourced
   * block is still accepted, with `warnWei: null` — see {@link gasStatus}.
   */
  readonly gas: AgentGasView | null;
  readonly motions: readonly DetailMotion[];
  readonly sequences: readonly DetailSequence[];
  readonly positions: readonly DetailPosition[];
  readonly lp: LpDetailView | null;
  readonly grid: {
    readonly pool: string | null;
    readonly pair: string;
    readonly base: string | null;
    readonly quote: string | null;
    /** Both legs as resolved: needed to turn a tick into a price without the majors table. */
    readonly symbol0: string | null;
    readonly symbol1: string | null;
    readonly decimals0: number | null;
    readonly decimals1: number | null;
    readonly token0: string;
    readonly token1: string;
    readonly fee: number;
    readonly wbnbIsToken0: boolean;
    /**
     * The plane quotes EVERY grid in WBNB (`buy` = buy the non-WBNB leg with
     * WBNB); the page quotes stable-first. When the DISPLAY base is WBNB
     * (USDT/WBNB) every plane side reads the other way round on this page —
     * see {@link displaySide}. `false` while the pair is unresolved.
     */
    readonly sideInverted: boolean;
    /** Quote-per-base price at the observed tick, and at each signed rung edge. */
    readonly observedPrice: string | null;
    /** USD per ONE unit of the quote asset, when a fresh price supports it. */
    readonly quoteUsd: number | null;
    readonly baseAddress: string | null;
    readonly quoteAddress: string | null;
    readonly buyPrices: { readonly low: string; readonly high: string } | null;
    readonly sellPrices: { readonly low: string; readonly high: string } | null;
    readonly tickSpacing: number;
    /** The signed automation mode: "fixed" unless the grid block names another. */
    readonly mode: string;
    /** The shift/ladder/policy geometry, when the mode has one. */
    readonly gapTicks: number | null;
    readonly widthTicks: number | null;
    /** Shift mode's drift lane; 0 = disabled, so the grid moves only on a fill (PHASE3.25 cross). */
    readonly driftPctOfGap: number | null;
    readonly buyRange: { readonly tickLower: number; readonly tickUpper: number };
    readonly sellRange: { readonly tickLower: number; readonly tickUpper: number };
    readonly observedTick: number | null;
    readonly observationAgeMs: number | null;
    readonly observationStale: boolean;
    /** Where `observedTick` came from: the page's own RPC poll, the worker's record, or nowhere. */
    readonly tickSource: "live" | "worker" | null;
    readonly rangeUnavailableBecause: string | null;
    readonly liveRows: number;
  };
};

export type ChartCandle = {
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
};

export type OhlcvResult = {
  readonly candles: readonly ChartCandle[];
  readonly stale: boolean;
  readonly banner: string | null;
  readonly priceNow: number | null;
  readonly hodl: DetailMetric;
};

function row(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Row
    : null;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function rowArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing.`);
  return value;
}

function requiredAddress(value: unknown, label: string): string {
  const valueString = requiredString(value, label);
  if (!ADDRESS.test(valueString)) throw new Error(`${label} is invalid.`);
  return valueString.toLowerCase();
}

function requiredDecimal(value: unknown, signed = false): string {
  if (typeof value !== "string" || !(signed ? SIGNED_DECIMAL : DECIMAL).test(value)) {
    throw new Error("Atomic amount is invalid.");
  }
  return value;
}

function range(value: unknown, label: string): { tickLower: number; tickUpper: number } {
  const valueRow = row(value);
  if (valueRow === null || !safeInteger(valueRow["tickLower"]) || !safeInteger(valueRow["tickUpper"])
    || valueRow["tickUpper"] <= valueRow["tickLower"]) throw new Error(`${label} is invalid.`);
  return { tickLower: valueRow["tickLower"], tickUpper: valueRow["tickUpper"] };
}

export function relativeTime(atMs: number, nowMs: number): { text: string; title: string } {
  if (!safeInteger(atMs) || !safeInteger(nowMs)) return { text: "—", title: "time unavailable" };
  const age = Math.max(0, nowMs - atMs);
  const minute = 60_000;
  const text = age < minute ? "just now"
    : age < 60 * minute ? `${Math.floor(age / minute)}m ago`
      : age < 24 * 60 * minute ? `${Math.floor(age / (60 * minute))}h ago`
        : `${Math.floor(age / (24 * 60 * minute))}d ago`;
  return { text, title: new Date(atMs).toISOString() };
}

function formatBnb(wei: string): string {
  return `${formatAtomic(wei, 18, 6) ?? "—"} BNB`;
}

function formatSignedAtomic(amount: string): string | null {
  if (!SIGNED_DECIMAL.test(amount)) return null;
  const negative = amount.startsWith("-");
  const magnitude = negative ? amount.slice(1) : amount;
  const formatted = formatAtomic(magnitude, 18, 6);
  return formatted === null ? null : `${negative ? "-" : ""}${formatted}`;
}

export function freshWbnbPriceMicros(payload: unknown, nowMs = Date.now()): bigint | null {
  const body = row(payload);
  const data = row(body?.["data"]);
  const meta = row(body?.["meta"]);
  if (data === null || meta === null || meta["staleness"] !== "fresh"
    || typeof meta["source"] !== "string" || meta["source"].length === 0
    || !safeInteger(meta["asOf"]) || nowMs - meta["asOf"] < 0 || nowMs - meta["asOf"] > 60_000) return null;
  if (typeof data["address"] !== "string" || !ADDRESS.test(data["address"])
    || data["address"].toLowerCase() !== WBNB_56) return null;
  const price = data["priceUsd"];
  if (!finitePositive(price)) return null;
  const micros = Math.round(price * 1_000_000);
  return Number.isSafeInteger(micros) && micros > 0 ? BigInt(micros) : null;
}

export function usdForWei(wei: string, priceMicros: bigint): string {
  const raw = BigInt(wei), magnitude = raw < 0n ? -raw : raw;
  const cents = (magnitude * priceMicros * 100n + 5n * 10n ** 23n) / 10n ** 24n;
  return `${raw < 0n && cents !== 0n ? "-" : ""}$${cents / 100n}.${(cents % 100n).toString(10).padStart(2, "0")}`;
}

function parseOwner(payload: unknown): {
  erc8004Identity?: Erc8004Identity;
  id: string;
  status: string;
  walletAddress: string;
  session: Row | null;
  httpRuntimeProfile: string;
  hireSizingName: string | null;
  armedBudgetWei: string | null;
} {
  const body = row(payload);
  const data = row(body?.["data"]);
  if (data === null) throw new Error("Owner view returned an unexpected response.");
  const id = requiredString(data["id"], "Agent id");
  const status = requiredString(data["status"], "Agent status");
  if (!STATUSES.has(status)) throw new Error("Agent status is invalid.");
  const erc8004Identity = parseErc8004Identity(data["erc8004Identity"]);
  return {
    ...(erc8004Identity === undefined ? {} : { erc8004Identity }),
    id,
    status,
    walletAddress: requiredAddress(data["walletAddress"], "Agent wallet"),
    httpRuntimeProfile: typeof data["httpRuntimeProfile"] === "string" ? data["httpRuntimeProfile"] : "unbound-v1",
    hireSizingName: typeof row(data["hireSizing"])?.["name"] === "string"
      ? row(data["hireSizing"])?.["name"] as string : null,
    armedBudgetWei: typeof row(data["hireSizing"])?.["openNativeBudgetWei"] === "string"
      ? String(row(data["hireSizing"])?.["openNativeBudgetWei"]) : null,
    session: data["session"] === null ? null : row(data["session"]),
  };
}

/** USD per one unit of the quote leg: a dollar for the stables, the fresh snapshot for WBNB. */
function quoteUsdFor(quote: string, tokenSnapshot: unknown, nowMs = Date.now()): number | null {
  if (quote === "USDT" || quote === "USDC") return 1;
  if (quote !== "WBNB") return null;
  const micros = tokenSnapshot === undefined ? null : freshWbnbPriceMicros(tokenSnapshot, nowMs);
  return micros === null ? null : Number(micros) / 1_000_000;
}

/** Order-book order: the ask above the bid, anything unassigned last. */
function rowOrder(role: string): number {
  return role === "sell" ? 0 : role === "buy" ? 1 : 2;
}

function dailyLimit(session: Row | null, nowMs: number, tokenSnapshot: unknown): DetailMetric {
  if (session === null || !Array.isArray(session["spendCaps"])) {
    return { value: null, reason: "— no native session cap on record" };
  }
  const native = session["spendCaps"].map(row).filter((cap): cap is Row => cap !== null && cap["token"] === undefined);
  if (native.length !== 1 || native[0]?.["period"] !== "day") {
    return { value: null, reason: "— no native session cap on record" };
  }
  const limit = requiredDecimal(native[0]["limit"]);
  if (BigInt(limit) === 0n) return { value: null, reason: "— no native session cap on record" };
  const expiry = session["expiresAt"];
  if (!safeInteger(expiry) || expiry < 0) return { value: null, reason: "— no native session cap on record" };
  const expired = Math.floor(nowMs / 1_000) >= expiry;
  const price = tokenSnapshot === undefined ? null : freshWbnbPriceMicros(tokenSnapshot, nowMs);
  const primary = formatBnb(limit);
  const usdOnly = price === null ? null : usdForWei(limit, price);
  const usd = usdOnly === null ? "" : ` · ${usdOnly}`;
  return {
    value: `${primary}${usd}`,
    reason: null,
    note: `period: day · ${expired ? "recorded expired ceiling" : `expires ${new Date(expiry * 1_000).toISOString()}`}. The agent may treat the whole wallet balance of both pool tokens as working capital.`,
    bnb: primary,
    ...(usdOnly === null ? {} : { usd: usdOnly })
  };
}

function matchingValuation(position: Row): Row | null {
  const observation = row(position["observation"]);
  const valuation = row(observation?.["valuation"]);
  if (valuation === null) return null;
  if (!safeInteger(position["rowVersion"]) || valuation["positionRowVersion"] !== position["rowVersion"]
    || valuation["tokenId"] !== position["tokenId"]
    || typeof valuation["quoteToken"] !== "string" || typeof position["quoteToken"] !== "string"
    || valuation["quoteToken"].toLowerCase() !== position["quoteToken"].toLowerCase()) return null;
  return valuation;
}

/**
 * GROSS PnL, in WBNB wei: what the agent holds now, minus what it was armed
 * with.
 *
 * WHY IT EXISTS BESIDE `recordedCycleDelta`: realised PnL only counts a
 * COMPLETED round trip, so a shift ladder that has re-ranged seven times and
 * filled nothing reports a dash forever — which reads as a broken page. This
 * measures the position instead of the trade history.
 *
 * WHAT IT COUNTS: every open rung's exit valuation (already WBNB), plus the
 * WALLET's idle WBNB and idle base, the base priced at the observed tick. In
 * shift mode most of the capital IS idle by design — `deployPctBps` of half
 * the budget per rung — so a figure built from the rungs alone would read
 * roughly -70% and be nonsense.
 *
 * WHAT IT DOES NOT COUNT: gas. It comes out of the native meter, not out of
 * the position, and the operator asked for the gross figure.
 *
 * The base leg is priced in ATOMIC units straight off the pool ratio
 * (sqrtP^2 / 2^192), so no token decimals are needed and nothing rounds
 * through a float. `null` whenever any input is missing — an unvalued rung,
 * an unread buffer, no observed tick — because a partial total is a wrong
 * total.
 */
/**
 * A signed WBNB delta as the owner reads it: DOLLARS when a fresh WBNB price
 * supports the conversion, the WBNB amount when it does not. Two decimals,
 * because a PnL that reads "+$0.0002" tells nobody anything.
 */
function signedUsdOrWbnb(
  deltaWei: bigint,
  quoteUsd: number | null,
  unit: { readonly decimals: number; readonly symbol: string } = { decimals: 18, symbol: "WBNB" },
): string {
  const sign = deltaWei > 0n ? "+" : deltaWei < 0n ? "-" : "";
  const magnitude = deltaWei < 0n ? -deltaWei : deltaWei;
  if (quoteUsd === null) {
    return `${sign}${formatAtomic(magnitude.toString(10), unit.decimals, 6) ?? "—"} ${unit.symbol}`;
  }
  // Cents, computed on the integer wei so the rounding happens once.
  const one = 10n ** BigInt(unit.decimals);
  const cents = (magnitude * BigInt(Math.round(quoteUsd * 100)) + one / 2n) / one;
  return `${sign}$${cents / 100n}.${(cents % 100n).toString(10).padStart(2, "0")}`;
}

/**
 * GRID-PNL-QUOTE (2026-09-11) — an amount of WBNB wei expressed in the OTHER
 * leg's smallest units at a sqrt price. token1-per-token0 = sqrt² / 2^192 on
 * raw units, so no decimal scaling is needed: the result is already in that
 * token's wei.
 */
export function wbnbWeiInOtherLeg(wei: bigint, sqrtPriceX96: bigint, wbnbIsToken0: boolean): bigint {
  const q = 1n << 192n;
  return wbnbIsToken0 ? (wei * sqrtPriceX96 * sqrtPriceX96) / q : (wei * q) / (sqrtPriceX96 * sqrtPriceX96);
}

/**
 * Independent of chart windows: the DISPLAY BASE held from the arm receipt.
 *
 * The benchmark is "hold the display base instead": for mubarak/WBNB that is
 * the non-WBNB leg bought with the whole capital at the arm price and valued
 * back in WBNB now (the default); for a grid whose display base is WBNB
 * (`holdWbnb`, USDT/WBNB — GRID-PNL-QUOTE 2026-09-11) it is the WBNB capital
 * itself, measured in the other leg: c·P_now against c·P_arm. Both are pure
 * ratios of the arm and live sqrt prices, so no amount leaves the receipt.
 */
export function onChainGridHodl(input: {
  readonly benchmark: unknown; readonly capitalWei: string | null;
  readonly pool: string | null; readonly token0: string; readonly token1: string;
  readonly liveTick: LiveTick | null; readonly nowMs: number;
  readonly holdWbnb?: boolean;
}): { readonly metric: DetailMetric; readonly armedAtMs?: number; readonly txHash?: string; readonly armSqrtPriceX96?: bigint } {
  const missing = (reason: string) => ({ metric: { value: null, reason: `— ${reason}` } });
  const evidence = row(input.benchmark);
  if (evidence?.["status"] !== "ready") {
    return missing(evidence?.["status"] === "pending" ? "reading on-chain arm" : "on-chain arm evidence unavailable");
  }
  const sqrtText = evidence["sqrtPriceX96"], capital = evidence["capitalWei"];
  const armedAtMs = evidence["armedAtMs"], txHash = evidence["txHash"];
  if (evidence["method"] !== "arm-transaction-post-swap-v1" || typeof evidence["pool"] !== "string" || evidence["pool"].toLowerCase() !== input.pool?.toLowerCase()
    || typeof evidence["token0"] !== "string" || evidence["token0"].toLowerCase() !== input.token0.toLowerCase()
    || typeof evidence["token1"] !== "string" || evidence["token1"].toLowerCase() !== input.token1.toLowerCase()
    || typeof sqrtText !== "string" || !/^[1-9][0-9]{0,48}$/u.test(sqrtText)
    || typeof capital !== "string" || !/^[1-9][0-9]{0,77}$/u.test(capital) || capital !== input.capitalWei || BigInt(capital) >= (1n << 256n)
    || !safeInteger(armedAtMs) || armedAtMs < 0 || armedAtMs > input.nowMs || typeof txHash !== "string" || !HASH.test(txHash)
    || typeof evidence["blockHash"] !== "string" || !HASH.test(evidence["blockHash"])
    || typeof evidence["blockNumber"] !== "string" || !DECIMAL.test(evidence["blockNumber"])) return missing("invalid on-chain arm evidence");
  const start = BigInt(sqrtText), c = BigInt(capital);
  if (start < 4_295_128_739n || start >= 1461446703485210103287273052203988822378723970342n) return missing("invalid on-chain arm price");
  const tick = input.liveTick;
  if (!tick || tick.poolAddress?.toLowerCase() !== input.pool?.toLowerCase() || input.nowMs - tick.readAtMs < 0
    || input.nowMs - tick.readAtMs > 60_000 || !Number.isSafeInteger(tick.tick) || tick.tick < -887272 || tick.tick >= 887272
    || !DECIMAL.test(tick.blockNumber) || BigInt(tick.blockNumber) < BigInt(evidence["blockNumber"])) return { ...missing("waiting for a fresh pool price"), armSqrtPriceX96: start };
  const wbnb0 = input.token0.toLowerCase() === WBNB_56;
  if (wbnb0 === (input.token1.toLowerCase() === WBNB_56)) return missing("invalid quote token");
  const q = 1n << 192n, s2 = start * start, current = getSqrtRatioAtTick(tick.tick), n2 = current * current;
  const percentOf = (delta: bigint, over: bigint) => {
    const magnitude = delta < 0n ? -delta : delta;
    const hundredths = magnitude * 10_000n / over;
    return `${delta < 0n ? "-" : delta > 0n ? "+" : ""}${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
  };
  if (input.holdWbnb === true) {
    // Other-leg per WBNB is sqrt²/2^192 when WBNB is token0, else 2^192/sqrt²;
    // the capital cancels, so the return is n2/s2 − 1 (or s2/n2 − 1).
    const now = wbnb0 ? n2 : s2, arm = wbnb0 ? s2 : n2;
    return { metric: { value: percentOf(now - arm, arm), reason: null, note: "if you had held WBNB instead · measured in the quote" }, armedAtMs, txHash, armSqrtPriceX96: start };
  }
  const base = wbnb0 ? c * s2 / q : c * q / s2;
  if (base === 0n) return missing("capital is below one token unit");
  const held = wbnb0 ? base * q / n2 : base * n2 / q;
  return { metric: { value: percentOf(held - c, c), reason: null }, armedAtMs, txHash, armSqrtPriceX96: start };
}

function grossHoldingsWei(input: {
  readonly positions: readonly Row[];
  readonly bufferQuoteWei: string | null;
  readonly bufferBaseWei: string | null;
  readonly observedTick: number | null;
  readonly wbnbIsToken0: boolean;
}): { readonly wei: bigint } | { readonly reason: string } {
  if (input.bufferQuoteWei === null || input.bufferBaseWei === null) {
    return { reason: "— wallet balances unavailable" };
  }
  let total = BigInt(input.bufferQuoteWei);
  const baseWei = BigInt(input.bufferBaseWei);
  if (baseWei > 0n) {
    if (input.observedTick === null) return { reason: "— no observed tick to price the idle base" };
    const sqrt = getSqrtRatioAtTick(input.observedTick);
    // WBNB is the quote leg of every grid. token1-per-token0 = sqrt^2 / 2^192.
    total += input.wbnbIsToken0
      ? (baseWei * (1n << 192n)) / (sqrt * sqrt)
      : (baseWei * sqrt * sqrt) / (1n << 192n);
  }
  for (const value of input.positions) {
    const position = row(value);
    if (position === null || position["state"] === "closed") continue;
    const valuation = matchingValuation(position);
    if (valuation === null) return { reason: "— a live rung is not valued yet" };
    total += BigInt(requiredDecimal(valuation["exitValueWei"]));
  }
  return { wei: total };
}

function parseSequence(value: unknown): DetailSequence & { recenterEvidence: string | null; rawSteps: Row[] } {
  const sequence = row(value);
  if (sequence === null || !Array.isArray(sequence["steps"])) throw new Error("LP sequence is invalid.");
  const steps = sequence["steps"].map((value) => {
    const step = row(value);
    if (step === null || typeof step["unreadable"] !== "boolean") throw new Error("LP step is invalid.");
    if (step["txHash"] !== null && (typeof step["txHash"] !== "string" || !HASH.test(step["txHash"]))) throw new Error("LP transaction hash is invalid.");
    return step;
  });
  const recenterEvidence = sequence["recenterEvidence"] === "settlement" || sequence["recenterEvidence"] === "drift"
    ? sequence["recenterEvidence"]
    : null;
  return {
    sequenceId: requiredString(sequence["sequenceId"], "Sequence id"),
    positionId: requiredString(sequence["positionId"], "Sequence position id"),
    kind: requiredString(sequence["kind"], "Sequence kind"),
    state: requiredString(sequence["state"], "Sequence state"),
    recoveryState: requiredString(sequence["recoveryState"], "Recovery state"),
    note: typeof sequence["note"] === "string" ? sequence["note"] : null,
    outcomeUnavailable: steps.some((step) => step["unreadable"] === true),
    txHashes: steps.flatMap((step) => step["state"] === "COMMITTED" && typeof step["txHash"] === "string" ? [step["txHash"]] : []),
    steps: steps.map((step, index) => ({
      index: safeInteger(step["index"]) ? step["index"] : index,
      kind: typeof step["kind"] === "string" ? step["kind"] : "unknown",
      decisionId: typeof step["journalDecisionId"] === "string" ? step["journalDecisionId"] : "",
      state: typeof step["state"] === "string" ? step["state"] : null,
      txHash: typeof step["txHash"] === "string" ? step["txHash"] : null,
    })),
    stallCode: typeof sequence["stallCode"] === "string" ? sequence["stallCode"] : null,
    stallCount: safeInteger(sequence["stallCount"]) ? sequence["stallCount"] : 0,
    updatedAt: safeInteger(sequence["updatedAt"])
      ? sequence["updatedAt"]
      : (() => { throw new Error("Sequence time is invalid."); })(),
    createdAt: safeInteger(sequence["createdAt"]) ? sequence["createdAt"] : null,
    shiftCause: typeof sequence["shiftCause"] === "string" ? sequence["shiftCause"] : null,
    targetBuyRange: tickRange(sequence["targetBuyRange"]),
    targetSellRange: tickRange(sequence["targetSellRange"]),
    recenterEvidence,
    rawSteps: steps,
  };
}

function tickRange(value: unknown): { readonly tickLower: number; readonly tickUpper: number } | null {
  const range = row(value);
  return range !== null && safeInteger(range["tickLower"]) && safeInteger(range["tickUpper"])
    ? { tickLower: range["tickLower"], tickUpper: range["tickUpper"] }
    : null;
}

const NOT_ARMED = "— grid not armed yet";

const LP_NOT_ARMED = "— not armed yet";

type ParsedLpArmMeta = {
  readonly model: "custom" | "sigma";
  readonly range: {
    readonly source: "explicit" | "server-fenced";
    readonly tickLower: number;
    readonly tickUpper: number;
  };
  readonly selectPool: { readonly by: "fee-apr" | "volume"; readonly window: "24h" } | null;
  readonly budgetWei: string;
};

function lpReason(reason: string | null | undefined, fallback: string): string {
  if (reason === null || reason === undefined || reason.trim().length === 0) return `— ${fallback}`;
  return reason.startsWith("—") ? reason : `— ${reason}`;
}

function parseLpArmMeta(value: unknown): ParsedLpArmMeta | null {
  const meta = row(value);
  if (meta === null) return null;
  if (meta["model"] !== "custom" && meta["model"] !== "sigma") return null;
  const range = row(meta["range"]);
  if (range === null) return null;
  if (range["source"] !== "explicit" && range["source"] !== "server-fenced") return null;
  if (!safeInteger(range["tickLower"]) || !safeInteger(range["tickUpper"]) || range["tickUpper"] <= range["tickLower"]) return null;
  if (typeof meta["budgetWei"] !== "string" || !DECIMAL.test(meta["budgetWei"])) return null;
  let selectPool: ParsedLpArmMeta["selectPool"] = null;
  if (meta["selectPool"] !== null) {
    const raw = row(meta["selectPool"]);
    if (raw === null || (raw["by"] !== "fee-apr" && raw["by"] !== "volume") || raw["window"] !== "24h") return null;
    selectPool = { by: raw["by"], window: "24h" };
  }
  return {
    model: meta["model"],
    range: {
      source: range["source"],
      tickLower: range["tickLower"],
      tickUpper: range["tickUpper"],
    },
    selectPool,
    budgetWei: meta["budgetWei"],
  };
}

function notArmedLpView(owner: ReturnType<typeof parseOwner>): LpDetailView {
  return {
    model: null,
    pool: null,
    openingRange: null,
    liveRange: null,
    liveRangeReason: lpReason("no observation with ticks yet", "no observation with ticks yet"),
    currentTick: null,
    currentTickAsOfMs: null,
    currentTickSource: null,
    currentTickReason: lpReason("no observation with a current tick yet", "no observation with a current tick yet"),
    settingsTrusted: true,
    settingsReason: null,
    settings: {
      autoRotate: true,
      rotateMode: "swapped",
      rotateMinHoldMinutes: 0,
      autoHarvest: false,
      harvestMinFeesWei: "0",
      takeProfitPct: null,
      stopLossPct: null,
      brain: null,
    },
    valuation: { value: null, reason: lpReason("no observation with a valuation yet", "no observation with a valuation yet") },
    recordedPnl: { value: null, reason: LP_NOT_ARMED },
    budgetWei: owner.armedBudgetWei ?? "0",
    selectPool: null,
    restart: "Sign lpArm again to open a new position.",
    reason: "not armed yet",
  };
}

function notArmedView(owner: ReturnType<typeof parseOwner>, data: Row, nowMs: number, tokenSnapshot: unknown): AgentDetailView {
  const session = owner.session;
  const provisioning = owner.status === "provisioning";
  const liveRows = (data["positions"] as unknown[]).filter((value) => row(value)?.["state"] !== "closed").length;
  return {
    id: owner.id,
    status: owner.status,
    httpRuntimeProfile: owner.httpRuntimeProfile,
    hireSizingName: owner.hireSizingName,
    ...(owner.erc8004Identity === undefined ? {} : { erc8004Identity: owner.erc8004Identity }),
    walletAddress: owner.walletAddress,
    sessionPublicKey: typeof session?.["publicKey"] === "string" ? session["publicKey"] : null,
    provisioning,
    actionDisabledReason: provisioning ? "This agent is still being hired. Finish the on-chain grant, or cancel the hire." : null,
    armMs: null,
    dailyNativeLimit: dailyLimit(session, nowMs, tokenSnapshot),
    recordedCycleDelta: { value: null, reason: NOT_ARMED, note: "Arm the grid from the Deploy screen; cycles are recorded from the first fill." },
    grossPnl: { value: null, reason: NOT_ARMED },
    grossPnlPercent: { value: null, reason: NOT_ARMED },
    recordedCycles: { value: null, reason: NOT_ARMED },
    levels: [],
    cycleHistoryAvailable: false,
    cycleNote: NOT_ARMED,
    // REVIEW FINDING 4 — this branch serves EVERY non-grid profile, trade and
    // lending included, so a hard-coded null here silently discarded their gas
    // reading and their new banners never rendered.
    gas: parseGasBlock(data["gas"]),
    motions: [],
    sequences: [],
    positions: [],
    lp: null,
    grid: {
      pool: null,
      mode: "fixed",
      gapTicks: null,
      widthTicks: null,
      driftPctOfGap: null,
      pair: "—",
      base: null,
      quote: null,
      symbol0: null,
      symbol1: null,
      decimals0: null,
      decimals1: null,
      token0: "",
      token1: "",
      fee: 0,
      wbnbIsToken0: false,
      sideInverted: false,
      observedPrice: null,
      quoteUsd: null,
      baseAddress: null,
      quoteAddress: null,
      buyPrices: null,
      sellPrices: null,
      tickSpacing: 0,
      buyRange: { tickLower: 0, tickUpper: 0 },
      sellRange: { tickLower: 0, tickUpper: 0 },
      observedTick: null,
      observationAgeMs: null,
      observationStale: true,
      tickSource: null,
      rangeUnavailableBecause: NOT_ARMED,
      liveRows,
    },
  };
}

function mapLpAgentDetail(
  owner: ReturnType<typeof parseOwner>,
  data: Row,
  nowMs: number,
  tokenSnapshot: unknown,
  tokenMeta?: TokenMetaMap,
  liveTick?: LiveTick | null,
): AgentDetailView {
  const session = owner.session;
  const provisioning = owner.status === "provisioning";
  const positionRows = rowArray(data["positions"], "LP positions").map((value) => {
    const position = row(value);
    if (position === null || !safeInteger(position["createdAt"])) throw new Error("LP position is invalid.");
    return {
      position,
      createdAt: position["createdAt"],
      armMeta: position["armMeta"] === null || position["armMeta"] === undefined ? null : parseLpArmMeta(position["armMeta"]),
    };
  });
  const latestArmed = [...positionRows]
    .filter((entry) => entry.armMeta !== null && typeof entry.position["positionId"] === "string")
    .sort((a, b) => b.createdAt - a.createdAt || String(b.position["positionId"]).localeCompare(String(a.position["positionId"])))[0] ?? null;
  const latestObservation = latestArmed === null ? null : row(latestArmed.position["observation"]);
  const lpBlock = row(data["lp"]);
  const model = lpBlock?.["model"] === "custom" || lpBlock?.["model"] === "sigma" ? lpBlock["model"] : null;
  const poolBlock = row(lpBlock?.["pool"]);
  const lpPool = poolBlock === null
    ? null
    : (() => {
        const token0 = requiredAddress(poolBlock["token0"], "LP pool token0");
        const token1 = requiredAddress(poolBlock["token1"], "LP pool token1");
        if (!safeInteger(poolBlock["fee"])) throw new Error("LP pool fee is invalid.");
        if (typeof poolBlock["wbnbIsToken0"] !== "boolean") throw new Error("LP pool orientation is invalid.");
        const pair = resolvePair(56, token0, token1, poolBlock["wbnbIsToken0"], tokenMeta);
        const quoting = pair === null ? null : pairQuoting(pair);
        return {
          pair: pair === null ? `${token0.slice(0, 8)}… / ${token1.slice(0, 8)}…` : `${pair.symbol0} / ${pair.symbol1}`,
          quoteIsToken0: quoting?.invert ?? false,
          base: quoting?.base ?? null,
          quote: quoting?.quote ?? null,
          symbol0: pair?.symbol0 ?? null,
          symbol1: pair?.symbol1 ?? null,
          decimals0: pair?.decimals0 ?? null,
          decimals1: pair?.decimals1 ?? null,
          token0,
          token1,
          fee: poolBlock["fee"],
          poolAddress: poolBlock["poolAddress"] === null || poolBlock["poolAddress"] === undefined
            ? poolAddressFor(token0, token1, poolBlock["fee"])
            : requiredAddress(poolBlock["poolAddress"], "LP pool address"),
          wbnbIsToken0: poolBlock["wbnbIsToken0"],
          tickSpacing: safeInteger(poolBlock["tickSpacing"]) ? poolBlock["tickSpacing"] : poolBlock["tickSpacing"] === null ? null : (() => { throw new Error("LP tick spacing is invalid."); })(),
          baseAddress: pair === null || quoting === null ? null : (quoting.invert ? token1 : token0),
          quoteAddress: pair === null || quoting === null ? null : (quoting.invert ? token0 : token1),
          quoteUsd: pair === null || quoting === null ? null : quoteUsdFor(quoting.quote, tokenSnapshot, nowMs),
        };
      })();
  const openingRangeBlock = row(lpBlock?.["openingRange"]);
  const openingRange = openingRangeBlock === null
    ? null
    : openingRangeBlock["source"] !== "explicit" && openingRangeBlock["source"] !== "server-fenced"
      ? (() => { throw new Error("LP opening range is invalid."); })()
      : !safeInteger(openingRangeBlock["tickLower"]) || !safeInteger(openingRangeBlock["tickUpper"]) || openingRangeBlock["tickUpper"] <= openingRangeBlock["tickLower"]
        ? (() => { throw new Error("LP opening range is invalid."); })()
        : {
            source: openingRangeBlock["source"] as "explicit" | "server-fenced",
            tickLower: openingRangeBlock["tickLower"],
            tickUpper: openingRangeBlock["tickUpper"],
          };
  const liveRangeBlock = row(lpBlock?.["range"]);
  const liveRange = liveRangeBlock === null
    ? null
    : !safeInteger(liveRangeBlock["tickLower"]) || !safeInteger(liveRangeBlock["tickUpper"]) || !safeInteger(liveRangeBlock["asOfMs"]) || liveRangeBlock["tickUpper"] <= liveRangeBlock["tickLower"]
      ? (() => { throw new Error("LP live range is invalid."); })()
      : {
          tickLower: liveRangeBlock["tickLower"],
          tickUpper: liveRangeBlock["tickUpper"],
          asOfMs: liveRangeBlock["asOfMs"],
        };
  const liveFresh = liveTick !== undefined && liveTick !== null && liveTick.poolAddress?.toLowerCase() === lpPool?.poolAddress?.toLowerCase() && nowMs - liveTick.readAtMs >= 0 && nowMs - liveTick.readAtMs <= 60_000
    ? { currentTick: liveTick.tick, asOfMs: liveTick.readAtMs, source: "live" as const }
    : null;
  const workerTick = latestObservation !== null && typeof latestObservation["poolAddress"] === "string" && latestObservation["poolAddress"].toLowerCase() === lpPool?.poolAddress?.toLowerCase() && safeInteger(latestObservation["currentTick"]) && safeInteger(latestObservation["evaluatedAtMs"])
    ? { currentTick: latestObservation["currentTick"], asOfMs: latestObservation["evaluatedAtMs"], source: "worker" as const }
    : null;
  const currentTick = liveFresh ?? workerTick;
  const fallbackLp = notArmedLpView(owner);
  const settingsTrusted = lpBlock?.["settingsTrusted"] === undefined
    ? fallbackLp.settingsTrusted
    : typeof lpBlock["settingsTrusted"] === "boolean"
      ? lpBlock["settingsTrusted"]
      : (() => { throw new Error("LP settings trust flag is invalid."); })();
  const settingsReason = typeof lpBlock?.["settingsReason"] === "string"
    ? lpBlock["settingsReason"]
    : lpBlock?.["settingsReason"] === null || lpBlock?.["settingsReason"] === undefined
      ? null
      : (() => { throw new Error("LP settings reason is invalid."); })();
  const settingsBlock = row(lpBlock?.["settings"]);
  const settings: LpDetailView["settings"] = settingsBlock === null
    ? settingsTrusted
      ? fallbackLp.settings
      : null
    : {
        autoRotate: typeof settingsBlock["autoRotate"] === "boolean" ? settingsBlock["autoRotate"] : (() => { throw new Error("LP auto-rotate flag is invalid."); })(),
        rotateMode: settingsBlock["rotateMode"] === "swapped" || settingsBlock["rotateMode"] === "swapless" ? settingsBlock["rotateMode"] : (() => { throw new Error("LP rotate mode is invalid."); })(),
        rotateMinHoldMinutes: safeInteger(settingsBlock["rotateMinHoldMinutes"]) ? settingsBlock["rotateMinHoldMinutes"] : (() => { throw new Error("LP rotate cooldown is invalid."); })(),
        autoHarvest: typeof settingsBlock["autoHarvest"] === "boolean" ? settingsBlock["autoHarvest"] : (() => { throw new Error("LP auto-harvest flag is invalid."); })(),
        harvestMinFeesWei: requiredDecimal(settingsBlock["harvestMinFeesWei"]),
        takeProfitPct: settingsBlock["takeProfitPct"] === null ? null : safeInteger(settingsBlock["takeProfitPct"]) ? settingsBlock["takeProfitPct"] : (() => { throw new Error("LP take-profit percent is invalid."); })(),
        stopLossPct: settingsBlock["stopLossPct"] === null ? null : safeInteger(settingsBlock["stopLossPct"]) ? settingsBlock["stopLossPct"] : (() => { throw new Error("LP stop-loss percent is invalid."); })(),
        brain: settingsBlock["brain"] === null
          ? null
          : (() => {
              const brain = row(settingsBlock["brain"]);
              if (brain === null || typeof brain["primaryModel"] !== "string" || typeof brain["fallbackModel"] !== "string") {
                throw new Error("LP brain settings are invalid.");
              }
              return { primaryModel: brain["primaryModel"], fallbackModel: brain["fallbackModel"] };
            })(),
      };
  const wbnbMicros = freshWbnbPriceMicros(tokenSnapshot, nowMs);
  const latestValuation = latestArmed === null ? null : matchingValuation(latestArmed.position);
  const valuation: DetailMetric = latestArmed === null
    ? { value: null, reason: lpReason("no observation with a valuation yet", "no observation with a valuation yet") }
    : latestObservation === null || latestObservation["valuation"] === null
      ? { value: null, reason: lpReason("no observation with a valuation yet", "no observation with a valuation yet") }
      : latestValuation === null
        ? { value: null, reason: lpReason("valuation is for a prior position version", "valuation is for a prior position version") }
        : (() => {
            const valuedAt = latestValuation["valuedAtMs"];
            if (!safeInteger(valuedAt)) throw new Error("LP valuation time is invalid.");
            return {
              value: wbnbMicros === null ? `${formatAtomic(requiredDecimal(latestValuation["exitValueWei"]), 18, 6) ?? "—"} WBNB` : usdForWei(requiredDecimal(latestValuation["exitValueWei"]), wbnbMicros),
              rawWei: requiredDecimal(latestValuation["exitValueWei"]),
              reason: null,
              note: `as of ${relativeTime(valuedAt, nowMs).text}${wbnbMicros === null ? " · fresh WBNB price unavailable" : ""}`,
            };
          })();
  const budgetWei = typeof lpBlock?.["budgetWei"] === "string" && DECIMAL.test(lpBlock["budgetWei"])
    ? lpBlock["budgetWei"]
    : latestArmed?.armMeta?.budgetWei ?? owner.armedBudgetWei ?? "0";
  const recordedPnl: DetailMetric = latestValuation === null
    ? { value: null, reason: valuation.reason }
    : !DECIMAL.test(budgetWei)
      ? { value: null, reason: lpReason("the armed budget is not recorded on this agent", "the armed budget is not recorded on this agent") }
      : {
          value: wbnbMicros === null ? `${formatSignedAtomic((BigInt(requiredDecimal(latestValuation["exitValueWei"])) - BigInt(budgetWei)).toString(10)) ?? "—"} WBNB` : usdForWei((BigInt(requiredDecimal(latestValuation["exitValueWei"])) - BigInt(budgetWei)).toString(), wbnbMicros),
          rawWei: (BigInt(requiredDecimal(latestValuation["exitValueWei"])) - BigInt(budgetWei)).toString(),
          note: `current NFT value − armed budget · wallet residue and relay costs excluded${wbnbMicros === null ? " · fresh WBNB price unavailable" : ""}`,
          reason: null,
        };
  const sequences = rowArray(data["sequences"], "LP sequences").map(parseSequence).sort((a, b) => b.updatedAt - a.updatedAt);
  const positions: DetailPosition[] = positionRows.map(({ position, createdAt }) => {
    const token0 = requiredAddress(position["token0"], "Position token0");
    const token1 = requiredAddress(position["token1"], "Position token1");
    const tokenId = position["tokenId"] === null ? null : requiredDecimal(position["tokenId"]);
    const matched = matchingValuation(position);
    let valueMetric: DetailMetric;
    if (row(position["observation"])?.["valuation"] === null || row(position["observation"]) === null) {
      valueMetric = { value: null, reason: lpReason("no observation with a valuation yet", "no observation with a valuation yet") };
    } else if (matched === null) {
      valueMetric = { value: null, reason: lpReason("valuation is for a prior position version", "valuation is for a prior position version") };
    } else {
      const valuedAt = matched["valuedAtMs"];
      if (!safeInteger(valuedAt)) throw new Error("LP valuation time is invalid.");
      valueMetric = {
        value: wbnbMicros === null ? `${formatAtomic(requiredDecimal(matched["exitValueWei"]), 18, 6) ?? "—"} WBNB` : usdForWei(requiredDecimal(matched["exitValueWei"]), wbnbMicros),
        rawWei: requiredDecimal(matched["exitValueWei"]),
        reason: null,
        note: `as of ${relativeTime(valuedAt, nowMs).text}${wbnbMicros === null ? " · fresh WBNB price unavailable" : ""}`,
      };
    }
    const basis = requiredDecimal(position["basisWei"]);
    const unrealised = matched === null
      ? { value: null, reason: valueMetric.reason }
      : { value: `${formatSignedAtomic((BigInt(requiredDecimal(matched["exitValueWei"])) - BigInt(basis)).toString(10)) ?? "—"} WBNB`, reason: null };
    const age = relativeTime(createdAt, nowMs);
    return {
      positionId: requiredString(position["positionId"], "Position id"),
      state: requiredString(position["state"], "Position state"),
      tokenId,
      pair: lpPool !== null && lpPool.token0 === token0 && lpPool.token1 === token1
        ? lpPool.pair
        : `${token0.slice(0, 8)}… / ${token1.slice(0, 8)}…`,
      role: "position",
      age: age.text,
      ageTitle: age.title,
      value: valueMetric,
      unrealised,
      updatedAt: safeInteger(position["updatedAt"]) ? position["updatedAt"] : createdAt,
      lineageId: typeof position["lineageId"] === "string" ? position["lineageId"] : "",
      token0, token1, fee: safeInteger(position["fee"]) ? position["fee"] : undefined,
      rowVersion: safeInteger(position["rowVersion"]) ? position["rowVersion"] : 0,
      feeEvidence: parseFeeEvidence(position),
      fees: feeMetric({ evidence: parseFeeEvidence(position), tokenId, rowVersion: safeInteger(position["rowVersion"]) ? position["rowVersion"] : null,
        imported: position["basisSource"] === "imported", tick: liveFresh?.currentTick ?? null, quoteIsToken0: lpPool?.quoteIsToken0 ?? false,
        quoteMicros: lpPool?.quoteUsd === null || lpPool?.quoteUsd === undefined ? null : BigInt(Math.round(lpPool.quoteUsd * 1_000_000)),
        decimals0:lpPool?.decimals0 ?? null, decimals1:lpPool?.decimals1 ?? null, symbol0:lpPool?.symbol0 ?? "token0", symbol1:lpPool?.symbol1 ?? "token1" }),
      nftUrl: tokenId === null ? null : nftPositionUrl(tokenId),
      rung: null,
      sideLabel: null,
    };
  });
  const selectPoolBlock = row(lpBlock?.["selectPool"]);
  const selectPool: LpDetailView["selectPool"] = selectPoolBlock === null
    ? latestArmed?.armMeta?.selectPool ?? null
    : (selectPoolBlock["by"] !== "fee-apr" && selectPoolBlock["by"] !== "volume") || selectPoolBlock["window"] !== "24h"
      ? (() => { throw new Error("LP selection mode is invalid."); })()
      : { by: selectPoolBlock["by"], window: "24h" };
  const lp: LpDetailView = lpBlock === null
    ? fallbackLp
    : {
        model,
        workerIntervalMs: safeInteger(lpBlock["workerIntervalMs"]) ? lpBlock["workerIntervalMs"] : undefined,
        wbnbUsd: wbnbMicros === null ? null : Number(wbnbMicros) / 1_000_000,
        currentTickFresh: liveFresh !== null && latestValuation !== null && liveRange !== null && typeof latestObservation?.["poolAddress"] === "string" && latestObservation["poolAddress"].toLowerCase() === lpPool?.poolAddress?.toLowerCase(),
        latestPositionId: latestArmed === null ? undefined : String(latestArmed.position["positionId"]),
        eligibleCandidates: Array.isArray(row(lpBlock["selection"])?.["survivors"]) ? (row(lpBlock["selection"])!["survivors"] as unknown[]).length : undefined,
        feeMetric: positions.find(p => p.positionId === latestArmed?.position["positionId"])?.fees ?? { value:null,reason:"fee evidence unavailable" },
        pool: lpPool,
        openingRange,
        liveRange,
        liveRangeReason: liveRange === null
          ? typeof lpBlock["rangeReason"] === "string"
            ? lpReason(lpBlock["rangeReason"], "no observation with ticks yet")
            : lpBlock["reason"] === "not armed yet"
              ? LP_NOT_ARMED
              : lpReason("no observation with ticks yet", "no observation with ticks yet")
          : null,
        currentTick: currentTick?.currentTick ?? null,
        currentTickAsOfMs: currentTick?.asOfMs ?? null,
        currentTickSource: currentTick?.source ?? null,
        currentTickReason: currentTick === null
          ? lpBlock["reason"] === "not armed yet"
            ? LP_NOT_ARMED
            : lpReason("no observation with a current tick yet", "no observation with a current tick yet")
          : currentTick.source === "worker"
            ? nowMs < currentTick.asOfMs ? "worker observation timestamp is in the future"
              : safeInteger(lpBlock["workerIntervalMs"]) && nowMs-currentTick.asOfMs > 2*lpBlock["workerIntervalMs"] ? "worker observation older than configured cadence"
                : "worker cadence not independently verified; last observed tick"
            : null,
        settingsTrusted,
        settingsReason,
        settings,
        valuation,
        recordedPnl,
        budgetWei,
        selectPool,
        restart: typeof lpBlock["restart"] === "string" ? lpBlock["restart"] : lpBlock["restart"] === null ? null : fallbackLp.restart,
        reason: typeof lpBlock["reason"] === "string" ? lpBlock["reason"] : null,
      };
  const liveRows = positionRows.filter(({ position }: { position: Row }) => position["state"] !== "closed").length;
  const pnlPercent: DetailMetric = latestValuation === null || BigInt(budgetWei) <= 0n
    ? { value: null, reason: recordedPnl.reason ?? lpReason("no armed budget to measure against", "no armed budget to measure against") }
    : (() => {
        const delta = BigInt(requiredDecimal(latestValuation["exitValueWei"])) - BigInt(budgetWei);
        const magnitude = delta < 0n ? -delta : delta;
        const hundredths = (magnitude * 10_000n) / BigInt(budgetWei);
        const sign = delta < 0n ? "-" : delta > 0n ? "+" : "";
        return { value: `${sign}${hundredths / 100n}.${(hundredths % 100n).toString(10).padStart(2, "0")}%`, reason: null };
      })();
  return {
    id: owner.id,
    status: owner.status,
    httpRuntimeProfile: owner.httpRuntimeProfile,
    hireSizingName: owner.hireSizingName,
    ...(owner.erc8004Identity === undefined ? {} : { erc8004Identity: owner.erc8004Identity }),
    walletAddress: owner.walletAddress,
    sessionPublicKey: typeof session?.["publicKey"] === "string" ? session["publicKey"] : null,
    provisioning,
    actionDisabledReason: provisioning ? "This agent is still being hired. Finish the on-chain grant, or cancel the hire." : null,
    armMs: latestArmed?.createdAt ?? null,
    dailyNativeLimit: dailyLimit(session, nowMs, tokenSnapshot),
    recordedCycleDelta: { value: null, reason: "— not a grid agent" },
    grossPnl: recordedPnl,
    grossPnlPercent: pnlPercent,
    recordedCycles: { value: null, reason: "— not a grid agent" },
    levels: [],
    cycleHistoryAvailable: false,
    cycleNote: "— not a grid agent",
    // AGENT-GAS-ATTENTION §3.2 — was hard-coded `null` here, which is why an LP
    // agent could not warn about gas no matter what the plane reported.
    gas: parseGasBlock(data["gas"]),
    motions: [],
    sequences,
    positions,
    lp,
    grid: {
      pool: null,
      mode: "fixed",
      gapTicks: null,
      widthTicks: null,
      driftPctOfGap: null,
      pair: "—",
      base: null,
      quote: null,
      symbol0: null,
      symbol1: null,
      decimals0: null,
      decimals1: null,
      token0: "",
      token1: "",
      fee: 0,
      wbnbIsToken0: false,
      sideInverted: false,
      observedPrice: null,
      quoteUsd: null,
      baseAddress: null,
      quoteAddress: null,
      buyPrices: null,
      sellPrices: null,
      tickSpacing: 0,
      buyRange: { tickLower: 0, tickUpper: 0 },
      sellRange: { tickLower: 0, tickUpper: 0 },
      observedTick: null,
      observationAgeMs: null,
      observationStale: true,
      tickSource: null,
      rangeUnavailableBecause: LP_NOT_ARMED,
      liveRows,
    },
  };
}

/** A pool tick read straight from RPC by `/api/pool-state`, with when it was read. */
export type LiveTick = { readonly poolAddress?: string; readonly tick: number; readonly blockNumber: string; readonly readAtMs: number };

export function mapAgentDetail(
  ownerPayload: unknown,
  lpPayload: unknown,
  nowMs: number,
  tokenSnapshot?: unknown,
  /**
   * Symbols and DECIMALS for legs outside the reviewed majors table, from the
   * data plane. Absent means the page dashes prices for such a pair rather
   * than scaling a tick by a guessed 18 — see `resolvePair`.
   */
  tokenMeta?: TokenMetaMap,
  /** The page's own direct-RPC tick, polled apart from the worker; see `liveFresh`. */
  liveTick?: LiveTick | null,
): AgentDetailView {
  if (!safeInteger(nowMs)) throw new Error("Current time is invalid.");
  const owner = parseOwner(ownerPayload);
  const lpBody = row(lpPayload);
  const data = row(lpBody?.["data"]);
  if (data === null || !Array.isArray(data["positions"]) || !Array.isArray(data["sequences"])) {
    throw new Error("LP view returned an unexpected response.");
  }
  if (owner.hireSizingName === "lp-v1") {
    return mapLpAgentDetail(owner, data, nowMs, tokenSnapshot, tokenMeta, liveTick);
  }
  // FINDINGS (bi): a session-armed agent whose grid has not been armed yet has
  // NO grid settings, and `GET /agents/:id/lp` then omits the `grid` block
  // entirely (it is spread in only when settings exist). That is a normal,
  // expected state of every freshly hired agent — not an invalid response —
  // so the page renders status and session facts and dashes the grid tiles.
  if (data["grid"] === undefined || data["grid"] === null) return notArmedView(owner, data, nowMs, tokenSnapshot);
  const grid = row(data["grid"]);
  if (grid === null) throw new Error("LP view returned an unexpected response.");
  const pool = row(grid["pool"]);
  if (pool === null || typeof grid["wbnbIsToken0"] !== "boolean") throw new Error("Grid pool is invalid.");
  const token0 = requiredAddress(pool["token0"], "Pool token0");
  const token1 = requiredAddress(pool["token1"], "Pool token1");
  const reviewed = resolvePair(56, token0, token1, grid["wbnbIsToken0"], tokenMeta);
  const positionsMatchPool = data["positions"].every((value) => {
    const position = row(value);
    if (position === null) throw new Error("LP position is invalid.");
    const positionToken0 = requiredAddress(position["token0"], "Position token0");
    const positionToken1 = requiredAddress(position["token1"], "Position token1");
    return positionToken0 === token0 && positionToken1 === token1;
  });
  const pair = positionsMatchPool ? reviewed : null;
  const pairName = pair === null ? `${token0.slice(0, 8)}… / ${token1.slice(0, 8)}…` : `${pair.symbol0} / ${pair.symbol1}`;
  const gridBuyRange = range(grid["buyRange"], "Buy range");
  const gridSellRange = range(grid["sellRange"], "Sell range");
  const levelsRaw = Array.isArray(grid["levels"]) ? grid["levels"] : [];
  const levels = levelsRaw.map((value) => {
    const level = row(value);
    const pnl = row(level?.["pnl"]);
    if (level === null || pnl === null || !safeInteger(pnl["recordedCycles"]) || !safeInteger(pnl["overRoundTrips"])) throw new Error("Grid level is invalid.");
    const delta = pnl["realisedQuoteWei"] === null ? null : requiredDecimal(pnl["realisedQuoteWei"], true);
    return {
      positionId: requiredString(level["positionId"], "Grid position id"),
      role: typeof level["gridRole"] === "string" ? level["gridRole"] : "unassigned",
      recordedCycles: pnl["recordedCycles"],
      roundTrips: pnl["overRoundTrips"],
      deltaWei: delta,
      observedTick: safeInteger(level["observedTick"]) ? level["observedTick"] : null,
      observationAgeMs: safeInteger(level["observationAgeMs"]) && level["observationAgeMs"] >= 0 ? level["observationAgeMs"] : null,
      rangeUnavailableBecause: typeof row(level["shiftSide"])?.["rangeUnavailableBecause"] === "string"
        ? String(row(level["shiftSide"])?.["rangeUnavailableBecause"])
        : null,
    };
  });
  const oneLiveLineage = levels.length === 1;
  const level = levels[0];
  const delta: DetailMetric = !oneLiveLineage
    ? { value: null, reason: "— no agent-wide total; see level rows" }
    : level?.deltaWei === null
      ? { value: null, reason: "— no comparable round trip yet" }
      : BigInt(level?.deltaWei ?? "0") === 0n && (level?.roundTrips ?? 0) < 1
        ? { value: null, reason: "— no comparable round trip yet" }
        : { value: `${formatSignedAtomic(level?.deltaWei ?? "0") ?? "—"} WBNB`, reason: null };
  const cycles = row(grid["cycles"]);
  if (cycles === null || typeof cycles["available"] !== "boolean" || !safeInteger(cycles["recorded"])
    || !Array.isArray(cycles["rows"])) throw new Error("Grid cycle history is invalid.");
  const cycleNote = requiredString(cycles["note"], "Cycle note");
  const cycleMetric: DetailMetric = !cycles["available"]
    ? { value: null, reason: "— cycle history unavailable" }
    : !oneLiveLineage
      ? { value: null, reason: "— no agent-wide total; see level rows" }
      : { value: `${cycles["recorded"]} recorded · ${level?.roundTrips ?? 0} round trips`, reason: null };
  const sequencesWithEvidence = data["sequences"].map(parseSequence).sort((a, b) => b.updatedAt - a.updatedAt);
  const sequenceById = new Map(sequencesWithEvidence.map((sequence) => [sequence.sequenceId, sequence]));
  const motionRows = cycles["available"] ? cycles["rows"] : [];
  const motions = motionRows.map((value): DetailMotion => {
    const cycle = row(value);
    const from = row(cycle?.["from"]);
    if (cycle === null || from === null || !safeInteger(cycle["completedAtMs"])) throw new Error("Grid cycle row is invalid.");
    const sequenceId = requiredString(cycle["sequenceId"], "Cycle sequence id");
    const sequence = sequenceById.get(sequenceId);
    const direction = cycle["direction"];
    let classification: DetailMotion["classification"] = "unknown";
    if (sequence?.kind === "grid-flip" || (sequence?.kind === "grid-recenter" && sequence.recenterEvidence === "settlement")) classification = "settlement";
    if (sequence?.kind === "grid-recenter" && sequence.recenterEvidence === "drift") classification = "drift";
    // `to-sell` is the PLANE's buy rung completing; the label names the DISPLAY
    // side (`displaySide`), so the run log and the fill feed tell one story.
    const filledSide = displaySide(direction === "to-sell" ? "buy" : "sell", pair === null ? false : gridSideInverted(pair));
    const label = classification === "drift" ? "Rung re-centred (drift)"
      : classification === "unknown" ? "Motion — cause unavailable"
        : filledSide === "buy" ? "Buy rung filled" : "Sell rung filled";
    const freed0 = requiredDecimal(cycle["freed0Wei"]);
    const freed1 = requiredDecimal(cycle["freed1Wei"]);
    const collected = pair === null
      ? "— token decimals unavailable"
      : [
          BigInt(freed0) === 0n ? null : `${formatAtomic(freed0, pair.decimals0)} ${pair.symbol0}`,
          BigInt(freed1) === 0n ? null : `${formatAtomic(freed1, pair.decimals1)} ${pair.symbol1}`,
        ].filter((part): part is string => part !== null).join(" + ") || "0 collected";
    const price = pair === null || !safeInteger(from["tickLower"]) || !safeInteger(from["tickUpper"])
      ? { value: null, reason: "— token decimals unavailable" }
      : { value: `${midpointWbnbUsdtPrice(from["tickLower"], from["tickUpper"], pair).value} USDT/BNB`, reason: null, note: "range midpoint" };
    const time = relativeTime(cycle["completedAtMs"], nowMs);
    const mint = sequence?.rawSteps.find((step) => step["kind"] === "zap-in-mint" && typeof step["txHash"] === "string");
    return { sequenceId, classification, label, collected, price, time: time.text, timeTitle: time.title, txHash: typeof mint?.["txHash"] === "string" ? mint["txHash"] : null };
  }).sort((a, b) => b.timeTitle.localeCompare(a.timeTitle));
  const levelByPosition = new Map(levels.map((entry) => [entry.positionId, entry]));
  const positions: DetailPosition[] = data["positions"].map((value): DetailPosition => {
    const position = row(value);
    if (position === null || !safeInteger(position["createdAt"])) throw new Error("LP position is invalid.");
    const positionId = requiredString(position["positionId"], "Position id");
    const state = requiredString(position["state"], "Position state");
    const tokenId = position["tokenId"] === null ? null : requiredDecimal(position["tokenId"]);
    const valuation = matchingValuation(position);
    let valueMetric: DetailMetric;
    if (row(position["observation"])?.["valuation"] === null || row(position["observation"]) === null) {
      valueMetric = { value: null, reason: "— not valued yet" };
    } else if (valuation === null) {
      valueMetric = { value: null, reason: "— valuation is for a prior position version" };
    } else {
      const exitValue = requiredDecimal(valuation["exitValueWei"]);
      const valuedAt = valuation["valuedAtMs"];
      if (!safeInteger(valuedAt)) throw new Error("Valuation time is invalid.");
      valueMetric = { value: `${formatAtomic(exitValue, 18, 6)} WBNB`, reason: null, note: `as of ${relativeTime(valuedAt, nowMs).text}` };
    }
    const basis = requiredDecimal(position["basisWei"]);
    const unrealised = valuation === null ? { value: null, reason: valueMetric.reason }
      : BigInt(basis) === 0n ? { value: null, reason: "— basis not recorded (minted arm)" }
        : { value: `${formatSignedAtomic((BigInt(requiredDecimal(valuation["exitValueWei"])) - BigInt(basis)).toString(10))} WBNB`, reason: null };
    const created = relativeTime(position["createdAt"], nowMs);
    const role = levelByPosition.get(positionId)?.role ?? "unassigned";
    // A rung's range is the OWNER-SIGNED geometry for its role. Under
    // grid.mode "shift" the live rungs float after the first motion and the
    // plane says so (`rangeUnavailableBecause`); the screen labels it.
    const signed = role === "buy" ? gridBuyRange : role === "sell" ? gridSellRange : null;
    const rung = signed === null || pair === null ? null : (() => {
      const edges = rangePrices(signed.tickLower, signed.tickUpper, pair);
      return {
        tickLower: signed.tickLower,
        tickUpper: signed.tickUpper,
        priceLow: edges.low,
        priceHigh: edges.high,
        // The edge the order completes at is a DISPLAY question: a rung that
        // sells the display base completes at the price-high edge, whichever
        // side the plane calls it.
        fillPrice: displaySide(role === "sell" ? "sell" : "buy", gridSideInverted(pair)) === "sell" ? edges.high : edges.low,
      };
    })();
    const sideLabel = pair === null || (role !== "buy" && role !== "sell")
      ? null
      : gridSideLabel(role, pair);
    return {
      positionId,
      state,
      tokenId,
      pair: pairName,
      role,
      age: created.text,
      ageTitle: created.title,
      value: valueMetric,
      unrealised,
      fees: { value: null, reason: "— fees are counted in unrealised" },
      nftUrl: tokenId === null ? null : nftPositionUrl(tokenId),
      rung,
      sideLabel,
    };
  });
  positions.sort((a, b) => rowOrder(a.role) - rowOrder(b.role));
  const workerObserved = [...levels].filter((entry) => entry.observedTick !== null && entry.observationAgeMs !== null).sort((a, b) => (a.observationAgeMs ?? Infinity) - (b.observationAgeMs ?? Infinity))[0];
  // LIVE TICK (HANDOFF 2026-09-04 owed item a): the page polls the plane's
  // direct-RPC pool state independently of the worker, whose observation only
  // exists after its first finalized cycle — minutes of dashes after an arm.
  // A fresh live read (≤ 60 s) is the CURRENT tick for every price-now use;
  // the worker's observation remains the record of what the agent ACTED on.
  const liveFresh = liveTick !== undefined && liveTick !== null && nowMs - liveTick.readAtMs <= 60_000
    ? { observedTick: liveTick.tick, observationAgeMs: Math.max(0, nowMs - liveTick.readAtMs) }
    : undefined;
  const observed = liveFresh ?? workerObserved;
  const tickSource: "live" | "worker" | null = liveFresh !== undefined ? "live" : workerObserved !== undefined ? "worker" : null;
  // ─── GROSS PnL ────────────────────────────────────────────────────────────
  // The wallet's idle halves come from the plane's own `buffer` block, which
  // it already reads from chain for ladder and SHIFT grids; the rungs come
  // from their valuations. Everything is WBNB wei, so the subtraction is exact.
  // Shift, ladder and policy all carry their gap/width in their own block.
  const geometryBlock = row(grid["shift"]) ?? row(grid["ladder"]) ?? row(grid["policy"]);
  const buffer = row(grid["buffer"]);
  const holdings = grossHoldingsWei({
    positions: data["positions"] as readonly Row[],
    bufferQuoteWei: typeof buffer?.["quoteWei"] === "string" ? String(buffer["quoteWei"]) : null,
    bufferBaseWei: typeof buffer?.["baseWei"] === "string" ? String(buffer["baseWei"]) : null,
    observedTick: observed?.observedTick ?? null,
    wbnbIsToken0: grid["wbnbIsToken0"],
  });
  const armedBudgetWei = owner.armedBudgetWei;
  // GRID-PNL-QUOTE (2026-09-11) — a grid whose DISPLAY base is WBNB
  // (USDT/WBNB) is measured in its quote: the plane's WBNB figures read
  // "holding USDT while BNB rose = losing WBNB", which is true and useless to
  // a reader pricing that grid in USDT. The benchmark and the arm price come
  // from the same on-chain arm receipt the HODL tile already stands on.
  const quoteMeasured = pair !== null && gridSideInverted(pair);
  const hodl = onChainGridHodl({ benchmark: grid["benchmark"], capitalWei: armedBudgetWei,
    pool: typeof grid["poolAddress"] === "string" ? grid["poolAddress"] : poolAddressFor(token0, token1, safeInteger(pool["fee"]) ? pool["fee"] : 0),
    token0, token1, liveTick: liveTick ?? null, nowMs, holdWbnb: quoteMeasured });
  const quoteUnit = pair === null ? null : {
    symbol: pairQuoting(pair).quote,
    decimals: pairQuoting(pair).invert ? pair.decimals0 : pair.decimals1,
  };
  // The gross figures: holdings and budget in the MEASURING unit — WBNB wei by
  // default; the quote's wei when `quoteMeasured`, holdings at the observed
  // tick and the budget at the arm price, or a dash with the reason.
  const measured: { readonly holdings: bigint; readonly budget: bigint; readonly unit: { readonly symbol: string; readonly decimals: number }; readonly usd: number | null } | { readonly reason: string } = "reason" in holdings
    ? { reason: holdings.reason }
    : armedBudgetWei === null
      ? { reason: "— the armed budget is not recorded on this agent" }
      : !quoteMeasured || quoteUnit === null
        // USD per WBNB, from the same fresh snapshot the delegated tile uses.
        // Absent (stale or unread) the figure stays in WBNB rather than
        // inventing a rate. Asked for WBNB directly rather than through the
        // pair: the holdings are already WBNB wei, so the dollar figure must
        // not also wait for the BASE token's decimals to arrive.
        ? { holdings: holdings.wei, budget: BigInt(armedBudgetWei), unit: { symbol: "WBNB", decimals: 18 }, usd: quoteUsdFor("WBNB", tokenSnapshot, nowMs) }
        : hodl.armSqrtPriceX96 === undefined
          ? { reason: `${hodl.metric.reason ?? "— arm price unavailable"} (needed to measure in ${quoteUnit.symbol})` }
          : observed?.observedTick === null || observed === undefined
            ? { reason: `— no observed tick to measure in ${quoteUnit.symbol}` }
            : {
                holdings: wbnbWeiInOtherLeg(holdings.wei, getSqrtRatioAtTick(observed.observedTick), grid["wbnbIsToken0"]),
                budget: wbnbWeiInOtherLeg(BigInt(armedBudgetWei), hodl.armSqrtPriceX96, grid["wbnbIsToken0"]),
                unit: quoteUnit,
                usd: quoteUsdFor(quoteUnit.symbol, tokenSnapshot, nowMs),
              };
  const grossNote = quoteMeasured && quoteUnit !== null ? `gross · measured in ${quoteUnit.symbol}, budget at the arm price` : undefined;
  const grossPnl: DetailMetric = "reason" in measured
    ? { value: null, reason: measured.reason }
    : {
        // A PnL without a sign is ambiguous, and `formatSignedAtomic` only
        // writes the minus. The plus is explicit here.
        value: signedUsdOrWbnb(measured.holdings - measured.budget, measured.usd, measured.unit),
        reason: null,
        ...(grossNote === undefined ? {} : { note: grossNote }),
        bnb: signedUsdOrWbnb(measured.holdings - measured.budget, null, measured.unit),
        ...(measured.usd === null ? {} : { usd: signedUsdOrWbnb(measured.holdings - measured.budget, measured.usd, measured.unit) }),
      };
  const grossPnlPercent: DetailMetric = "reason" in measured || measured.budget <= 0n
    ? { value: null, reason: grossPnl.reason ?? "— no armed budget to measure against" }
    : (() => {
        const delta = measured.holdings - measured.budget;
        const magnitude = delta < 0n ? -delta : delta;
        const hundredths = (magnitude * 10_000n) / measured.budget;
        const sign = delta < 0n ? "-" : delta > 0n ? "+" : "";
        return { value: `${sign}${hundredths / 100n}.${(hundredths % 100n).toString(10).padStart(2, "0")}%`, reason: null, ...(grossNote === undefined ? {} : { note: grossNote }) };
      })();
  const provisioning = owner.status === "provisioning";
  const levelPositionIds = new Set(levels.map((entry) => entry.positionId));
  const liveCreatedAt = data["positions"].flatMap((value) => {
    const position = row(value);
    return position !== null && position["state"] !== "closed"
      && typeof position["positionId"] === "string" && levelPositionIds.has(position["positionId"])
      && safeInteger(position["createdAt"])
      ? [position["createdAt"]]
      : [];
  });
  const sessionPublicKey = typeof owner.session?.["publicKey"] === "string" ? owner.session["publicKey"] : null;
  return {
    id: owner.id,
    status: owner.status,
    httpRuntimeProfile: owner.httpRuntimeProfile,
    hireSizingName: owner.hireSizingName,
    ...(owner.erc8004Identity === undefined ? {} : { erc8004Identity: owner.erc8004Identity }),
    walletAddress: owner.walletAddress,
    sessionPublicKey,
    provisioning,
    actionDisabledReason: provisioning ? "This agent is still being hired. Finish the on-chain grant, or cancel the hire." : null,
    armMs: hodl.armedAtMs ?? (liveCreatedAt.length === 0 ? null : Math.min(...liveCreatedAt)),
    hodl: hodl.metric,
    ...(hodl.txHash === undefined ? {} : { hodlArmTxHash: hodl.txHash }),
    dailyNativeLimit: dailyLimit(owner.session, nowMs, tokenSnapshot),
    recordedCycleDelta: { ...delta, note: cycleNote },
    grossPnl,
    grossPnlPercent,
    recordedCycles: cycleMetric,
    levels: levels.map(({ observedTick: _tick, observationAgeMs: _age, rangeUnavailableBecause: _reason, ...entry }) => ({
      ...entry,
      delta: entry.deltaWei === null || (BigInt(entry.deltaWei) === 0n && entry.roundTrips < 1)
        ? { value: null, reason: "— no comparable round trip yet" }
        : { value: `${formatSignedAtomic(entry.deltaWei) ?? "—"} WBNB`, reason: null },
    })),
    cycleHistoryAvailable: cycles["available"],
    cycleNote,
    // AGENT-GAS-ATTENTION §3.2 — the top-level block first; the shift-only
    // `buffer` projection remains the fallback so a plane that has not yet been
    // redeployed keeps the banner it already had.
    gas: parseGasBlock(data["gas"]) ?? gasStatus(buffer),
    motions,
    sequences: sequencesWithEvidence.map(({ recenterEvidence: _evidence, rawSteps: _steps, ...sequence }) => sequence),
    positions,
    lp: null,
    grid: {
      // The plane can only name the pool once an observation exists; the
      // address is a pure CREATE2 function of the SIGNED pool tuple, so derive
      // it rather than leaving the chart and every price dead for a cycle.
      pool: grid["poolAddress"] === undefined || grid["poolAddress"] === null
        ? poolAddressFor(token0, token1, safeInteger(pool["fee"]) ? pool["fee"] : 0)
        : requiredAddress(grid["poolAddress"], "Grid pool"),
      pair: pairName,
      base: pair === null ? null : pairQuoting(pair).base,
      quote: pair === null ? null : pairQuoting(pair).quote,
      symbol0: pair?.symbol0 ?? null,
      symbol1: pair?.symbol1 ?? null,
      decimals0: pair?.decimals0 ?? null,
      decimals1: pair?.decimals1 ?? null,
      token0,
      token1,
      fee: safeInteger(pool["fee"]) ? pool["fee"] : 0,
      wbnbIsToken0: grid["wbnbIsToken0"],
      sideInverted: pair === null ? false : gridSideInverted(pair),
      observedPrice: pair === null || observed?.observedTick === null || observed === undefined
        ? null
        : priceAtTick(observed.observedTick, pair),
      quoteUsd: pair === null ? null : quoteUsdFor(pairQuoting(pair).quote, tokenSnapshot, nowMs),
      baseAddress: pair === null ? null : (pairQuoting(pair).invert ? token1 : token0),
      quoteAddress: pair === null ? null : (pairQuoting(pair).invert ? token0 : token1),
      buyPrices: pair === null ? null : rangePrices(gridBuyRange.tickLower, gridBuyRange.tickUpper, pair),
      sellPrices: pair === null ? null : rangePrices(gridSellRange.tickLower, gridSellRange.tickUpper, pair),
      tickSpacing: safeInteger(grid["tickSpacing"]) ? grid["tickSpacing"] : (() => { throw new Error("Tick spacing is invalid."); })(),
      mode: typeof grid["mode"] === "string" ? grid["mode"] : "fixed",
      gapTicks: safeInteger(geometryBlock?.["gapTicks"]) ? Number(geometryBlock?.["gapTicks"]) : null,
      driftPctOfGap: safeInteger(geometryBlock?.["driftPctOfGap"]) ? Number(geometryBlock?.["driftPctOfGap"]) : null,
      widthTicks: safeInteger(geometryBlock?.["widthTicks"]) ? Number(geometryBlock?.["widthTicks"]) : null,
      buyRange: gridBuyRange,
      sellRange: gridSellRange,
      observedTick: observed?.observedTick ?? null,
      observationAgeMs: observed?.observationAgeMs ?? null,
      observationStale: observed?.observationAgeMs === null || observed === undefined || observed.observationAgeMs > 120_000,
      tickSource,
      rangeUnavailableBecause: levels.find((entry) => entry.rangeUnavailableBecause !== null)?.rangeUnavailableBecause ?? null,
      liveRows: data["positions"].filter((value) => row(value)?.["state"] !== "closed").length,
    },
  };
}

// MEASURED against the data plane 2026-09-03: it serves 1m/5m/15m/1h for a pool
// and answers 404 for 4h and 1d, so those are deliberately not offered — a
// timeframe button that cannot load is worse than one that is absent.
export const CHART_INTERVALS = ["1m", "5m", "15m", "1h"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

const INTERVAL_MS: Record<ChartInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

export function intervalMs(interval: ChartInterval): number {
  return INTERVAL_MS[interval];
}

export function ohlcvLimit(armMs: number, nowMs: number, interval: ChartInterval = "1m"): number {
  if (!safeInteger(armMs) || !safeInteger(nowMs)) throw new Error("OHLCV time is invalid.");
  // The chart is dated from the arm, at whatever bar width is asked for. A young
  // agent on a coarse timeframe therefore draws few bars — that is a short
  // history, not a broken chart, and padding it would show price the agent
  // never traded through.
  return Math.min(500, Math.ceil(Math.max(0, nowMs - armMs) / INTERVAL_MS[interval]) + 5);
}

export function ohlcvRequestPath(pool: string, armMs: number, nowMs: number, interval: ChartInterval = "1m"): string {
  if (!ADDRESS.test(pool)) throw new Error("Pool address is invalid.");
  return `/api/market-data/ohlcv?kind=pool&address=${pool.toLowerCase()}&interval=${interval}&limit=${ohlcvLimit(armMs, nowMs, interval)}`;
}

// A single token's own USD klines. The pool feed prices only ITS base in USD,
// and the data plane has no `token=base|quote` parameter, so pricing a grid in
// its quote asset is a ratio of two USD series rather than a feed we can ask
// for — and a grid whose display base is WBNB (USDT/WBNB) reads WBNB's own
// series, because the pool feed prices USDT there ({@link reduceTokenKlines}).
export function tokenKlinesPath(token: string, limit: number, interval: ChartInterval): string {
  if (!ADDRESS.test(token)) throw new Error("Token address is invalid.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Kline limit is invalid.");
  return `/api/market-data/ohlcv?kind=token&address=${token.toLowerCase()}&interval=${interval}&limit=${limit}`;
}

/**
 * GRID-DETAIL-ORIENTATION-HOTFIX — the token klines feed as the SAME
 * `OhlcvResult` the pool feed produces, for a grid whose display base is
 * WBNB. Measured 2026-09-11: the pool feed for the USDT/WBNB pools prices
 * USDT (closes ≈ 0.999), so `reduceOhlcv` rightly refuses it; WBNB's own USD
 * series (`kind=token`) IS the USDT-per-WBNB price the page wants. The
 * feed carries no `base`/`quote` identity, so the caller vouches for the
 * address it asked for; freshness and the HODL return follow `reduceOhlcv`.
 */
export function reduceTokenKlines(
  payload: unknown,
  armMs: number,
  nowMs: number,
  expected: { readonly baseSymbol: string | null; readonly interval?: ChartInterval },
): OhlcvResult {
  const bar = INTERVAL_MS[expected.interval ?? "1m"];
  if (!safeInteger(armMs) || !safeInteger(nowMs)) throw new Error("OHLCV time is invalid.");
  const body = row(payload);
  const meta = row(body?.["meta"]);
  if (body === null || meta === null || !Array.isArray(body["data"])) throw new Error("Klines returned an unexpected response.");
  if (typeof meta["source"] !== "string" || meta["source"].length === 0 || !safeInteger(meta["asOf"])) throw new Error("Klines metadata is invalid.");
  if (meta["staleness"] !== "fresh" && meta["staleness"] !== "stale" && meta["staleness"] !== "dead") throw new Error("Klines staleness is missing.");
  const candles: ChartCandle[] = body["data"].map((value) => {
    const candle = row(value);
    if (candle === null || !safeInteger(candle["timestamp"]) || !finitePositive(candle["open"])
      || !finitePositive(candle["high"]) || !finitePositive(candle["low"])
      || !finitePositive(candle["close"])) throw new Error("Kline candle is invalid.");
    const volume = typeof candle["volume"] === "number" && Number.isFinite(candle["volume"]) && candle["volume"] >= 0 ? candle["volume"] : 0;
    return { timestamp: candle["timestamp"], open: candle["open"], high: candle["high"], low: candle["low"], close: candle["close"], volume };
  }).sort((a, b) => a.timestamp - b.timestamp);
  const latest = candles[candles.length - 1];
  const latestAge = latest === undefined ? null : nowMs - latest.timestamp;
  const fresh = meta["staleness"] === "fresh" && latestAge !== null && latestAge >= 0 && latestAge <= bar * 2;
  const start = candles.find((candle) => candle.timestamp >= armMs);
  const startValid = start !== undefined && start.timestamp - armMs >= 0 && start.timestamp - armMs < bar;
  const symbol = expected.baseSymbol ?? "WBNB";
  const hodl = !startValid ? { value: null, reason: "— no candle at arm time" }
    : !fresh || latest === undefined ? { value: null, reason: "— chart data is stale" }
      : { value: `${(((latest.close - start.close) / start.close) * 100).toFixed(2)}%`, reason: null, note: `${symbol} spot return since arm · if you had held ${symbol} instead` };
  return {
    candles,
    stale: !fresh,
    banner: fresh ? null : `chart data is stale (as of ${new Date(meta["asOf"]).toISOString()})`,
    priceNow: fresh && latest !== undefined ? latest.close : null,
    hodl,
  };
}

export function reduceQuoteKlines(payload: unknown): ReadonlyMap<number, ChartCandle> {
  const body = row(payload);
  if (body === null || !Array.isArray(body["data"])) throw new Error("Klines returned an unexpected response.");
  const byTimestamp = new Map<number, ChartCandle>();
  for (const value of body["data"]) {
    const candle = row(value);
    if (candle === null || !safeInteger(candle["timestamp"]) || !finitePositive(candle["open"])
      || !finitePositive(candle["high"]) || !finitePositive(candle["low"])
      || !finitePositive(candle["close"])) continue;
    byTimestamp.set(candle["timestamp"], {
      timestamp: candle["timestamp"],
      open: candle["open"],
      high: candle["high"],
      low: candle["low"],
      close: candle["close"],
      volume: 0,
    });
  }
  return byTimestamp;
}

// Both series are the same asset's price in USD, so the quotient is the base
// priced in the quote — cross-checked live: BTCB 77,740 / WBNB 692 = 112.3,
// which is the pool's own active tick. A bar with no matching quote bar is
// dropped rather than carried at the wrong rate. The wicks are taken as the
// widest ratio the two bars admit, so the candle always bounds the real range
// and can never come back with a high below its own low.
export function priceInQuote(
  candles: readonly ChartCandle[],
  quote: ReadonlyMap<number, ChartCandle>,
): readonly ChartCandle[] {
  const converted: ChartCandle[] = [];
  for (const candle of candles) {
    const rate = quote.get(candle.timestamp);
    if (rate === undefined) continue;
    const open = candle.open / rate.open;
    const close = candle.close / rate.close;
    const high = candle.high / rate.low;
    const low = candle.low / rate.high;
    if (![open, close, high, low].every((value) => Number.isFinite(value) && value > 0)) continue;
    converted.push({
      timestamp: candle.timestamp,
      open,
      close,
      high: Math.max(open, close, high),
      low: Math.min(open, close, low),
      volume: candle.volume,
    });
  }
  return converted;
}

export function reduceOhlcv(
  payload: unknown,
  armMs: number,
  nowMs: number,
  expected?: {
    readonly base: string | null;
    readonly quote: string | null;
    readonly baseSymbol?: string | null;
    /** The bar width this payload was asked for. Both time windows below are one bar. */
    readonly interval?: ChartInterval;
  },
): OhlcvResult {
  const bar = INTERVAL_MS[expected?.interval ?? "1m"];
  if (!safeInteger(armMs) || !safeInteger(nowMs)) throw new Error("OHLCV time is invalid.");
  const body = row(payload);
  const meta = row(body?.["meta"]);
  if (body === null || meta === null || !Array.isArray(body["data"])) throw new Error("OHLCV returned an unexpected response.");
  if (typeof meta["source"] !== "string" || meta["source"].length === 0 || !safeInteger(meta["asOf"])) throw new Error("OHLCV metadata is invalid.");
  if (meta["staleness"] !== "fresh" && meta["staleness"] !== "stale" && meta["staleness"] !== "dead") throw new Error("OHLCV staleness is missing.");
  const base = row(meta["base"]);
  const quote = row(meta["quote"]);
  if (base === null || quote === null || typeof base["address"] !== "string" || typeof quote["address"] !== "string") {
    return { candles: [], stale: true, banner: "chart pair identity unavailable", priceNow: null, hodl: { value: null, reason: "— pair identity unavailable" } };
  }
  const baseAddress = base["address"].toLowerCase();
  const quoteAddress = quote["address"].toLowerCase();
  // The pool this agent actually trades, not one hardcoded pair. When the
  // caller names no pool the legacy WBNB/USDT check stands.
  const wantBase = expected?.base?.toLowerCase() ?? null;
  const wantQuote = expected?.quote?.toLowerCase() ?? null;
  const validPair = wantBase === null || wantQuote === null
    ? (baseAddress === WBNB_56 && quoteAddress === USDT_56) || (baseAddress === USDT_56 && quoteAddress === WBNB_56)
    : (baseAddress === wantBase && quoteAddress === wantQuote) || (baseAddress === wantQuote && quoteAddress === wantBase);
  if (!validPair) return { candles: [], stale: true, banner: "chart pair does not match this pool", priceNow: null, hodl: { value: null, reason: "— pair mismatch" } };
  // MEASURED: the pool OHLCV feed prices `meta.base` in USD (BTCB/WBNB closes
  // near 77,100), so there is no ratio to invert — and a series that prices the
  // OTHER leg is not this grid's price at all, which the banner says rather
  // than drawing a flat stablecoin line.
  const pricesOurBase = wantBase === null || baseAddress === wantBase;
  if (!pricesOurBase) {
    const symbol = typeof base["symbol"] === "string" ? base["symbol"] : "the other leg";
    return { candles: [], stale: true, banner: `chart prices ${symbol}, not ${expected?.baseSymbol ?? "this grid's base"}`, priceNow: null, hodl: { value: null, reason: "— feed prices the other leg" } };
  }
  const invert = false;
  const candles = body["data"].map((value) => {
    const candle = row(value);
    if (candle === null || !safeInteger(candle["timestamp"]) || !finitePositive(candle["open"])
      || !finitePositive(candle["high"]) || !finitePositive(candle["low"])
      || !finitePositive(candle["close"]) || typeof candle["volume"] !== "number"
      || !Number.isFinite(candle["volume"]) || candle["volume"] < 0) throw new Error("OHLCV candle is invalid.");
    return invert
      ? { timestamp: candle["timestamp"], open: 1 / candle["open"], high: 1 / candle["low"], low: 1 / candle["high"], close: 1 / candle["close"], volume: candle["volume"] }
      : { timestamp: candle["timestamp"], open: candle["open"], high: candle["high"], low: candle["low"], close: candle["close"], volume: candle["volume"] };
  }).sort((a, b) => a.timestamp - b.timestamp);
  const latest = candles[candles.length - 1];
  const latestAge = latest === undefined ? null : nowMs - latest.timestamp;
  const fresh = meta["staleness"] === "fresh" && latestAge !== null && latestAge >= 0 && latestAge <= bar * 2;
  const start = candles.find((candle) => candle.timestamp >= armMs);
  const startValid = start !== undefined && start.timestamp - armMs >= 0 && start.timestamp - armMs < bar;
  const hodl = !startValid ? { value: null, reason: "— no candle at arm time" }
    : !fresh || latest === undefined ? { value: null, reason: "— chart data is stale" }
      : { value: `${(((latest.close - start.close) / start.close) * 100).toFixed(2)}%`, reason: null, note: `${expected?.baseSymbol ?? "WBNB"} spot return since arm · if you had held ${expected?.baseSymbol ?? "BNB"} instead` };
  return {
    candles,
    stale: !fresh,
    banner: fresh ? null : `chart data is stale (as of ${new Date(meta["asOf"]).toISOString()})`,
    priceNow: fresh && latest !== undefined ? latest.close : null,
    hodl,
  };
}

/**
 * GRID-GAS-RESERVE W2 — the gas block, read from the plane's shift `buffer`.
 * Both figures must be present and decimal, or the block is `null`: a pot
 * without its requirement (or the reverse) is a number without a meaning.
 */
function gasStatus(buffer: Record<string, unknown> | null): AgentGasView | null {
  const native = buffer?.["nativeWei"];
  const next = buffer?.["nextShiftGasWei"];
  if (typeof native !== "string" || typeof next !== "string" || !/^\d+$/u.test(native) || !/^\d+$/u.test(next)) return null;
  // REVIEW 2 — a zero requirement is not "the next shift is free", it is a
  // figure nobody computed; projecting it made every wallet look healthy.
  if (BigInt(next) <= 0n) return null;
  // The shift `buffer` block predates AGENT-GAS-ATTENTION and carries only the
  // BLOCK threshold. Projected into the newer shape with `warnWei` absent, so a
  // consumer can never mistake "no warn threshold was reported" for "the wallet
  // is above it".
  return {
    nativeWei: native,
    nextMotionWei: next,
    blockWei: next,
    warnWei: null,
    state: BigInt(native) < BigInt(next) ? "blocked" : "ok",
    enforcement: "block",
    low: BigInt(native) < BigInt(next),
  };
}

/**
 * AGENT-GAS-ATTENTION §3.2 — the plane's TOP-LEVEL gas block, reported for
 * every profile rather than only for a shift grid.
 *
 * Every field must parse or the whole block is `null`. A partial gas block is
 * the one shape that could put a number on the page that no read supports —
 * and the page's contract is a dash with a reason, never an invented figure.
 */
function parseGasBlock(value: unknown): AgentGasView | null {
  const block = row(value);
  if (block === null) return null;
  const state = block["state"];
  if (state !== "unknown" && state !== "blocked" && state !== "low" && state !== "ok") return null;
  const enforcement = block["enforcement"];
  if (enforcement !== "block" && enforcement !== "warn-only") return null;
  const decimal = (candidate: unknown): string | null =>
    typeof candidate === "string" && /^\d+$/u.test(candidate) ? candidate : null;
  const nextMotionWei = decimal(block["nextMotionWei"]);
  const warnWei = decimal(block["warnWei"]);
  const blockWei = decimal(block["blockWei"]);
  if (nextMotionWei === null || warnWei === null || blockWei === null) return null;
  // REVIEW FINDING 9 — the thresholds must be POSITIVE and ORDERED, not merely
  // numeric. The first build accepted `nextMotionWei: "0"`, which is a floor
  // nobody could have computed and which reached a division in `GasNotice`.
  // A threshold that is zero, or a stand-down line above the warning line, is
  // not a conservative reading — it is a corrupt one, and the page's contract
  // is a dash with a reason rather than a number it cannot stand behind.
  if (BigInt(nextMotionWei) <= 0n || BigInt(blockWei) <= 0n || BigInt(warnWei) <= 0n) return null;
  if (BigInt(blockWei) > BigInt(nextMotionWei)) return null;
  if (BigInt(warnWei) < BigInt(nextMotionWei)) return null;
  const nativeWei = block["nativeWei"] === null ? null : decimal(block["nativeWei"]);
  // A malformed balance is not a missing one. `decimal` returning null for a
  // present-but-invalid field would otherwise be laundered into the same
  // `nativeWei: null` an honest unread balance produces.
  if (nativeWei === null && block["nativeWei"] !== null) return null;
  // And the two must agree: only an unread balance may be absent, and an
  // unread balance may never be classified.
  if ((nativeWei === null) !== (state === "unknown")) return null;
  // REVIEW 2 — and the STATE must agree with the NUMBERS it arrived with.
  // `{nativeWei: "0", blockWei: "2", state: "ok"}` passed every check above: a
  // wallet with nothing in it, declared healthy. The thresholds are the
  // evidence, so re-derive the classification and refuse a payload that
  // contradicts itself rather than rendering whichever half is convenient.
  if (nativeWei !== null) {
    const balance = BigInt(nativeWei);
    const derived = balance < BigInt(blockWei) ? "blocked" : balance < BigInt(warnWei) ? "low" : "ok";
    if (derived !== state) return null;
  }
  return {
    nativeWei,
    nextMotionWei,
    warnWei,
    blockWei,
    state,
    enforcement,
    low: state === "blocked" || state === "low",
  };
}

/**
 * A rung's LIVE size in WBNB wei: the two legs a full withdrawal would return
 * at the tick just read (`readOnChainPosition.amounts`), with the base leg
 * priced at that tick. WBNB is the quote leg of every grid, so the sum is
 * exact in WBNB. token1-per-token0 = sqrt^2 / 2^192, as `grossHoldingsWei`.
 */
export function liveRungValueWei(input: {
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly tick: number;
  readonly wbnbIsToken0: boolean;
}): bigint {
  const sqrt = getSqrtRatioAtTick(input.tick);
  return input.wbnbIsToken0
    ? input.amount0 + (input.amount1 * (1n << 192n)) / (sqrt * sqrt)
    : input.amount1 + (input.amount0 * sqrt * sqrt) / (1n << 192n);
}


/**
 * GRID-DETAIL-ORIENTATION-HOTFIX — the ONE seam between the plane's sides and
 * the page's.
 *
 * The plane's `buy` rung holds WBNB and buys the other leg; its `sell` rung
 * holds the other leg and sells it for WBNB (`src/lp/gridGeometry.ts`). The
 * page prices a pair stable-first (`pairQuoting`), so on USDT/WBNB the display
 * BASE is WBNB and the plane's `buy` (buy USDT with WBNB) is, to the reader,
 * a SELL of WBNB. `true` exactly when the display base is WBNB.
 */
export function gridSideInverted(pair: ReviewedPair): boolean {
  const displayBase = pairQuoting(pair).invert ? pair.token1 : pair.token0;
  return displayBase.toLowerCase() === WBNB_56;
}

/** A plane side as the page reads it: `buy` = the rung or fill that BUYS the display base. */
export function displaySide(role: "buy" | "sell", inverted: boolean): "buy" | "sell" {
  if (!inverted) return role;
  return role === "buy" ? "sell" : "buy";
}

/**
 * A rung is named by the asset it HOLDS: a display-sell rung holds the base it
 * is waiting to sell ("ASK mubarak", "ASK WBNB"), a display-buy rung holds the
 * quote it will pay ("BID WBNB", "BID USDT").
 */
export function gridSideLabel(role: "buy" | "sell", pair: ReviewedPair): string {
  const quoting = pairQuoting(pair);
  return displaySide(role, gridSideInverted(pair)) === "sell" ? `ASK ${quoting.base}` : `BID ${quoting.quote}`;
}

export type ShiftFill = {
  readonly sequenceId: string;
  readonly side: "buy" | "sell";
  /** The filled rung's completing edge, quote per base. */
  readonly price: string | null;
  readonly atMs: number;
  readonly txHash: string | null;
};

export type TickRange = { readonly tickLower: number; readonly tickUpper: number };

/**
 * The wallet's EMPTIED rungs on this pool, paired newest-first.
 *
 * A shift updates its two rows' tokenIds in place (no closed rows), so the
 * only durable record of a prior pair is the pair of NFTs it emptied — still
 * in the wallet, liquidity 0. Two per motion, minted sell-then-buy, so
 * consecutive tokenIds (descending) form one pair; within a pair the rung
 * with the higher ticks is the SELL rung when WBNB is token1, the BUY rung
 * when WBNB is token0. NFTs an earlier agent left on the same pool sit below
 * this agent's and are simply never reached by the cross count.
 */
export function emptyRungPairs(
  empties: readonly { readonly tokenId: bigint; readonly tickLower: number; readonly tickUpper: number }[],
  wbnbIsToken0: boolean,
): readonly { readonly buy: TickRange; readonly sell: TickRange }[] {
  const sorted = [...empties].sort((a, b) => (a.tokenId > b.tokenId ? -1 : a.tokenId < b.tokenId ? 1 : 0));
  const pairs: { readonly buy: TickRange; readonly sell: TickRange }[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const first = sorted[i]!;
    const second = sorted[i + 1]!;
    const higher = first.tickLower >= second.tickLower ? first : second;
    const lower = higher === first ? second : first;
    const range = (nft: typeof first): TickRange => ({ tickLower: nft.tickLower, tickUpper: nft.tickUpper });
    pairs.push(wbnbIsToken0 ? { buy: range(higher), sell: range(lower) } : { buy: range(lower), sell: range(higher) });
  }
  return pairs;
}

/**
 * A SHIFT grid's fills, from what the plane records plus what the chain says.
 *
 * `grid_cycles` is written by flips and recenters only, so a shift's cross
 * never reached the fill feed. A completed `grid-shift` with `shiftCause
 * "cross"` IS a fill; which side filled follows from where the pair moved:
 * the k-th most recent cross emptied the k-th most recent pair (see
 * `emptyRungPairs`), and the new buy target sits above or below that pair's
 * buy rung in tick space. Price up means the SELL rung was taken, down the
 * BUY rung; the tick/price relation inverts when WBNB is token0. The filled
 * rung completes at its far edge. A cross without a visible prior pair is
 * skipped rather than guessed.
 */
export function shiftFills(input: {
  readonly sequences: readonly DetailSequence[];
  /** Prior pairs, NEWEST FIRST — `emptyRungPairs`. */
  readonly priorPairs: readonly { readonly buy: TickRange; readonly sell: TickRange }[];
  readonly wbnbIsToken0: boolean;
  readonly pair: Parameters<typeof priceAtTick>[1] | null;
}): readonly ShiftFill[] {
  const crosses = input.sequences
    .filter((sequence) => sequence.kind === "grid-shift" && sequence.state === "completed" && sequence.shiftCause === "cross" && sequence.targetBuyRange !== null)
    .sort((a, b) => (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt));
  const fills: ShiftFill[] = [];
  crosses.forEach((sequence, index) => {
    const prior = input.priorPairs[index];
    const target = sequence.targetBuyRange;
    if (prior === undefined || target === null || target.tickLower === prior.buy.tickLower) return;
    const tickUp = target.tickLower > prior.buy.tickLower;
    const priceUp = input.wbnbIsToken0 ? !tickUp : tickUp;
    const side = priceUp ? "sell" : "buy";
    const fillTick = side === "sell"
      ? (input.wbnbIsToken0 ? prior.sell.tickLower : prior.sell.tickUpper)
      : (input.wbnbIsToken0 ? prior.buy.tickUpper : prior.buy.tickLower);
    fills.push({
      sequenceId: sequence.sequenceId,
      side,
      price: input.pair === null ? null : priceAtTick(fillTick, input.pair),
      atMs: sequence.createdAt ?? sequence.updatedAt,
      txHash: sequence.txHashes[0] ?? null,
    });
  });
  return fills;
}


/**
 * Which asset a rung holds, from the chain, not from a recorded role.
 *
 * Outside its range a V3 position is single-sided: above the tick it holds
 * token0, below it token1. INSIDE the range it holds both, and "above/below"
 * says nothing — the 2026-09-04 ask rung read as a bid the moment price
 * entered it. There the larger leg, both priced in WBNB at the tick, decides.
 */
export function rungHoldsWbnb(input: {
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly tick: number;
  readonly wbnbIsToken0: boolean;
}): boolean {
  if (input.tick < input.tickLower) return input.wbnbIsToken0;
  if (input.tick >= input.tickUpper) return !input.wbnbIsToken0;
  const wbnbLeg = input.wbnbIsToken0 ? input.amount0 : input.amount1;
  const baseLeg = input.wbnbIsToken0 ? input.amount1 : input.amount0;
  const baseInWbnb = liveRungValueWei({ amount0: input.wbnbIsToken0 ? 0n : baseLeg, amount1: input.wbnbIsToken0 ? baseLeg : 0n, tick: input.tick, wbnbIsToken0: input.wbnbIsToken0 });
  return wbnbLeg >= baseInWbnb;
}

/** The edge a rung completes at: an ask at the price-high edge, a bid at the price-low edge. */
export function rungFillTick(input: { readonly tickLower: number; readonly tickUpper: number; readonly holdsWbnb: boolean; readonly wbnbIsToken0: boolean }): number {
  const sell = !input.holdsWbnb;
  return sell
    ? (input.wbnbIsToken0 ? input.tickLower : input.tickUpper)
    : (input.wbnbIsToken0 ? input.tickUpper : input.tickLower);
}
