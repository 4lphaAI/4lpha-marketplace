import { keccak256, stringToBytes } from "viem";
import {
  BILLING_QUOTE_LIFETIME_SEC,
  BILLING_RELAY_RESERVE_WEI,
  MAX_BILLING_DAILY_USD_MICROS,
  MAX_BILLING_DAY_CAP_WEI,
} from "./config.js";
import type { Invoice, OracleFeed, OracleSnapshot, Usage } from "./types.js";

export const OG_NEURON_PER_0G = 1_000_000_000_000_000_000n;
export const WEI_PER_BNB = 1_000_000_000_000_000_000n;
export const BNB_INVOICE_QUANTUM_WEI = 1_000_000_000_000n;
export const USD_MICROS = 1_000_000n;

export function ogNeuronToUsdMicros(
  ogNeuron: bigint,
  ogUsdAnswer: bigint,
  ogUsdDecimals: number,
): bigint {
  if (ogNeuron < 0n || ogUsdAnswer <= 0n) throw new Error("0G amount and price are invalid.");
  return ceilDiv(
    ogNeuron * ogUsdAnswer * USD_MICROS,
    OG_NEURON_PER_0G * pow10(ogUsdDecimals),
  );
}

export function parseCanonicalUint(value: string, maxDigits = 78): bigint {
  if (!Number.isInteger(maxDigits) || maxDigits < 1 || !new RegExp(`^(0|[1-9][0-9]{0,${maxDigits - 1}})$`).test(value)) {
    throw new Error("Value must be a canonical unsigned decimal integer.");
  }
  return BigInt(value);
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error("ceilDiv requires n >= 0 and d > 0.");
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

export function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error("Oracle decimals are out of range.");
  }
  return 10n ** BigInt(decimals);
}

export type InvoiceAmounts = Readonly<{
  ogUsdMicros: bigint;
  usdcUsdMicros: bigint;
  totalUsdMicros: bigint;
  rawBnbWei: bigint;
  invoiceBnbWei: bigint;
}>;

export function quoteInvoiceAmounts(input: Readonly<{
  ogNeuron: bigint;
  baseUsdcAtomic: bigint;
  ogUsdAnswer?: bigint;
  ogUsdDecimals?: number;
  bnbUsdAnswer: bigint;
  bnbUsdDecimals: number;
}>): InvoiceAmounts {
  if (input.ogNeuron < 0n || input.baseUsdcAtomic < 0n || input.bnbUsdAnswer <= 0n) {
    throw new Error("Invoice amounts and prices must be nonnegative, with a positive BNB price.");
  }
  let ogUsdMicros = 0n;
  if (input.ogNeuron > 0n) {
    if (input.ogUsdAnswer === undefined || input.ogUsdDecimals === undefined || input.ogUsdAnswer <= 0n) {
      throw new Error("A positive 0G amount requires a positive 0G/USD observation.");
    }
    ogUsdMicros = ogNeuronToUsdMicros(input.ogNeuron, input.ogUsdAnswer, input.ogUsdDecimals);
  }
  const usdcUsdMicros = input.baseUsdcAtomic;
  const totalUsdMicros = ogUsdMicros + usdcUsdMicros;
  const rawBnbWei = ceilDiv(
    totalUsdMicros * WEI_PER_BNB * pow10(input.bnbUsdDecimals),
    input.bnbUsdAnswer * USD_MICROS,
  );
  const invoiceBnbWei = ceilDiv(rawBnbWei, BNB_INVOICE_QUANTUM_WEI) * BNB_INVOICE_QUANTUM_WEI;
  return { ogUsdMicros, usdcUsdMicros, totalUsdMicros, rawBnbWei, invoiceBnbWei };
}

export function calculateBillingDayCapWei(
  maxDailyUsdMicros: bigint,
  bnbUsdAnswer: bigint,
  bnbUsdDecimals: number,
): bigint {
  if (maxDailyUsdMicros < 1n || maxDailyUsdMicros > MAX_BILLING_DAILY_USD_MICROS) {
    throw new Error("maxDailyUsdMicros must be in the reviewed Phase 5 range.");
  }
  if (bnbUsdAnswer <= 0n) throw new Error("BNB/USD answer must be positive.");
  const requestedWei = ceilDiv(
    maxDailyUsdMicros * WEI_PER_BNB * pow10(bnbUsdDecimals),
    bnbUsdAnswer * USD_MICROS,
  );
  const withDriftWei = ceilDiv(requestedWei * 10_500n, 10_000n);
  const cap = withDriftWei + BILLING_RELAY_RESERVE_WEI;
  if (cap <= 0n || cap > MAX_BILLING_DAY_CAP_WEI) {
    throw new Error("Computed billing DAY cap exceeds 0.1 BNB.");
  }
  return cap;
}

export function invoiceIdentity(input: Readonly<{
  accountId: string;
  usageIds: readonly string[];
  baseUsdcAtomic: bigint;
  ogNeuron: bigint;
  usdMicros: bigint;
  rawBnbWei: bigint;
  bnbWei: bigint;
  ogOracle?: OracleSnapshot;
  bnbOracle: OracleSnapshot;
  arbitrumSequencer?: OracleSnapshot;
  quoteTimestamp: number;
  quoteExpiresAt: number;
  attempt: bigint;
}>): `0x${string}` {
  const usageIds = [...input.usageIds].sort();
  const encodeOracle = (snapshot: OracleSnapshot | undefined): unknown =>
    snapshot === undefined ? null : {
      feed: snapshot.feed,
      chainId: snapshot.chainId.toString(),
      proxy: snapshot.proxy.toLowerCase(),
      roundId: snapshot.roundId.toString(),
      answer: snapshot.answer.toString(),
      decimals: snapshot.decimals,
      startedAt: snapshot.startedAt,
      updatedAt: snapshot.updatedAt,
      answeredInRound: snapshot.answeredInRound.toString(),
    };
  return keccak256(stringToBytes(JSON.stringify({
    domain: "4lpha.invoice.v1",
    accountId: input.accountId,
    usageIds,
    baseUsdcAtomic: input.baseUsdcAtomic.toString(),
    ogNeuron: input.ogNeuron.toString(),
    usdMicros: input.usdMicros.toString(),
    rawBnbWei: input.rawBnbWei.toString(),
    bnbWei: input.bnbWei.toString(),
    ogOracle: encodeOracle(input.ogOracle),
    bnbOracle: encodeOracle(input.bnbOracle),
    arbitrumSequencer: encodeOracle(input.arbitrumSequencer),
    quoteTimestamp: input.quoteTimestamp,
    quoteExpiresAt: input.quoteExpiresAt,
    attempt: input.attempt.toString(),
  })));
}

export function buildQuotedInvoice(input: Readonly<{
  accountId: string;
  usageIds: readonly string[];
  baseUsdcAtomic: bigint;
  ogNeuron: bigint;
  ogOracle?: OracleSnapshot;
  bnbOracle: OracleSnapshot;
  arbitrumSequencer?: OracleSnapshot;
  quoteTimestamp: number;
  attempt: bigint;
}>): Invoice {
  if (!Number.isSafeInteger(input.quoteTimestamp) || input.quoteTimestamp < 0) {
    throw new Error("quoteTimestamp must be a nonnegative integer Unix second.");
  }
  const amounts = quoteInvoiceAmounts({
    ogNeuron: input.ogNeuron,
    baseUsdcAtomic: input.baseUsdcAtomic,
    ...(input.ogOracle === undefined ? {} : {
      ogUsdAnswer: input.ogOracle.answer,
      ogUsdDecimals: input.ogOracle.decimals,
    }),
    bnbUsdAnswer: input.bnbOracle.answer,
    bnbUsdDecimals: input.bnbOracle.decimals,
  });
  const quoteExpiresAt = input.quoteTimestamp + BILLING_QUOTE_LIFETIME_SEC;
  const identity = {
    accountId: input.accountId,
    usageIds: [...input.usageIds].sort(),
    baseUsdcAtomic: input.baseUsdcAtomic,
    ogNeuron: input.ogNeuron,
    usdMicros: amounts.totalUsdMicros,
    unroundedBnbWei: amounts.rawBnbWei,
    bnbWei: amounts.invoiceBnbWei,
    ...(input.ogOracle === undefined ? {} : { ogOracle: input.ogOracle }),
    bnbOracle: input.bnbOracle,
    ...(input.arbitrumSequencer === undefined ? {} : { arbitrumSequencer: input.arbitrumSequencer }),
    quoteTimestamp: input.quoteTimestamp,
    quoteExpiresAt,
    attempt: input.attempt,
  };
  const invoiceId = invoiceIdentity({
    ...identity,
    rawBnbWei: identity.unroundedBnbWei,
  });
  return {
    invoiceId,
    ...identity,
    state: "quoted",
    version: 0n,
    createdAt: input.quoteTimestamp,
    updatedAt: input.quoteTimestamp,
  };
}

export function allocateInvoiceUsdMicros(
  invoiceUsdMicros: bigint,
  costs: ReadonlyMap<string, bigint>,
): ReadonlyMap<string, bigint> {
  if (invoiceUsdMicros < 0n || costs.size === 0) throw new Error("Allocation requires nonnegative USD and members.");
  const sorted = [...costs.entries()].sort(([a], [b]) => a.localeCompare(b));
  const total = sorted.reduce((sum, [, cost]) => {
    if (cost < 0n) throw new Error("Allocation cost must be nonnegative.");
    return sum + cost;
  }, 0n);
  if (total <= 0n) throw new Error("Allocation total must be positive.");
  const allocations = new Map<string, bigint>();
  let assigned = 0n;
  for (const [usageId, cost] of sorted) {
    const share = (invoiceUsdMicros * cost) / total;
    allocations.set(usageId, share);
    assigned += share;
  }
  let remainder = invoiceUsdMicros - assigned;
  for (const [usageId] of sorted) {
    if (remainder === 0n) break;
    allocations.set(usageId, (allocations.get(usageId) ?? 0n) + 1n);
    remainder -= 1n;
  }
  return allocations;
}

/**
 * Reproduce the invoice's mixed-asset USD decomposition exactly. USDC atomic
 * units already are USD micros; only the aggregate 0G component needs rational
 * allocation and its deterministic lexical remainder rule.
 */
export function allocateInvoiceMembers(
  invoice: Invoice,
  usages: readonly Usage[],
): ReadonlyMap<string, bigint> {
  const byId = new Map(usages.map((usage) => [usage.usageId, usage] as const));
  const allocations = new Map<string, bigint>();
  const ogCosts = new Map<string, bigint>();
  let baseUsdcAtomic = 0n;
  let ogNeuron = 0n;
  for (const usageId of invoice.usageIds) {
    const usage = byId.get(usageId);
    if (
      usage === undefined ||
      usage.accountId !== invoice.accountId ||
      usage.state !== "claimed" ||
      usage.invoiceId !== invoice.invoiceId ||
      usage.actualAtomic === undefined ||
      usage.actualAtomic <= 0n
    ) {
      throw new Error("Invoice member cost cannot be reconstructed.");
    }
    if (usage.asset === "USDC_BASE") {
      baseUsdcAtomic += usage.actualAtomic;
      allocations.set(usageId, usage.actualAtomic);
    } else {
      ogNeuron += usage.actualAtomic;
      ogCosts.set(usageId, usage.actualAtomic);
    }
  }
  if (baseUsdcAtomic !== invoice.baseUsdcAtomic || ogNeuron !== invoice.ogNeuron) {
    throw new Error("Invoice asset totals drifted from its claimed members.");
  }
  const ogUsdMicros = invoice.usdMicros - baseUsdcAtomic;
  if (ogUsdMicros < 0n || (ogCosts.size === 0) !== (ogUsdMicros === 0n)) {
    throw new Error("Invoice USD components are inconsistent.");
  }
  if (ogCosts.size > 0) {
    for (const [usageId, usdMicros] of allocateInvoiceUsdMicros(ogUsdMicros, ogCosts)) {
      allocations.set(usageId, usdMicros);
    }
  }
  if (allocations.size !== invoice.usageIds.length) {
    throw new Error("Invoice allocation omitted a claimed member.");
  }
  return allocations;
}

export function feedLabel(feed: OracleFeed): string {
  return feed;
}
