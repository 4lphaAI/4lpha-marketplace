/** Fresh native-to-USDT cost conversion for entry route comparison. */
import { createClient, getAddress, http, type Address, type Chain } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import * as Key from "porto/viem/Key";
import { prepareCalls } from "porto/viem/RelayActions";
import type { AgentRecord } from "../store/agents.js";
import type { WalletCall } from "../core/types.js";
import { validateSessionSpec } from "../core/session.js";
import { canonicalProviderPermissionsV1, fingerprintLpFinalCallsV1, PORTO_NATIVE_FEE_TOKEN } from "../lp/preparedIntent.js";
import { WBNB_56 } from "../ops/venues.js";
import { USDT_56 } from "./settlement.js";
import { freshTokenUsdFact, type HttpTradeDataPlaneReads, type TokenBatchRow } from "./dataPlaneReads.js";
import { PORTO_V055_ORCHESTRATOR } from "../lp/preparedIntent.js";
import { keccak256, type Hex } from "viem";

const PRICE_SCALE = 100_000_000n;

function scaledPrice(value: number): bigint | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const text = value.toFixed(8);
  if (!/^\d+(?:\.\d{1,8})?$/u.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole ?? "0") * PRICE_SCALE + BigInt(fraction.padEnd(8, "0"));
}

export type NativeCostFacts = {
  readonly nativePriceUsd: number;
  readonly settlementPriceUsd: number;
  readonly observedAt: number;
};

export function freshNativeCostFacts(rows: readonly TokenBatchRow[], nowMs: number): NativeCostFacts | null {
  const nativeRows = rows.filter((row) => row.address.toLowerCase() === WBNB_56.toLowerCase());
  const settlementRows = rows.filter((row) => row.address.toLowerCase() === USDT_56.toLowerCase());
  if (nativeRows.length !== 1 || settlementRows.length !== 1) return null;
  const native = nativeRows[0];
  const settlement = settlementRows[0];
  const nativePriceUsd = freshTokenUsdFact(native, nowMs);
  const settlementPriceUsd = freshTokenUsdFact(settlement, nowMs);
  if (nativePriceUsd === null || settlementPriceUsd === null || settlementPriceUsd <= 0) return null;
  const observed = [native?.asOf, settlement?.asOf].filter((value): value is number => value !== undefined);
  if (observed.length !== 2) return null;
  return { nativePriceUsd, settlementPriceUsd, observedAt: Math.min(...observed) };
}

export function nativeCostToUsdtAtomic(nativeCostWei: bigint, facts: NativeCostFacts): bigint | null {
  if (nativeCostWei < 0n) return null;
  const nativePrice = scaledPrice(facts.nativePriceUsd);
  const settlementPrice = scaledPrice(facts.settlementPriceUsd);
  if (nativePrice === null || settlementPrice === null || settlementPrice <= 0n) return null;
  return (nativeCostWei * nativePrice + settlementPrice - 1n) / settlementPrice;
}

export type TradfiNativeCostRequest = {
  readonly agent: AgentRecord;
  readonly calls: readonly WalletCall[];
};

export type TradfiNativeCostNetwork = {
  readonly chain: Chain;
  readonly relayUrl?: string;
};

/**
 * Read-only Porto fee quote for TradFi route comparison. It reconstructs the
 * normalized relay key from persisted public session facts; it never decrypts
 * or reads the session private key. The prepare seam is injectable so this
 * identity boundary can be tested without a relay or wallet authority.
 */
export function createTradfiNativeCostOracle(input: {
  readonly dataPlane: Pick<HttpTradeDataPlaneReads, "tokensBatch">;
  readonly network: TradfiNativeCostNetwork;
  readonly prepareCallsFn?: typeof prepareCalls;
}): ((request: TradfiNativeCostRequest) => Promise<bigint | null>) | undefined {
  const nativeCostWei = createTradfiNativeCostWeiOracle(input);
  if (nativeCostWei === undefined) return undefined;
  return async (request) => {
    const nativeWei = await nativeCostWei(request);
    if (nativeWei === null) return null;
    const rows = await input.dataPlane.tokensBatch([WBNB_56, USDT_56]);
    const priceFacts = freshNativeCostFacts(rows, Date.now());
    return priceFacts === null ? null : nativeCostToUsdtAtomic(nativeWei, priceFacts);
  };
}

/**
 * AUTO-DCA REVIEW2 condition 5: the same verified relay quote, in NATIVE wei,
 * BEFORE the data-plane conversion. The native day meter is in wei, so a DCA
 * sweep prices its own reserve check with this and does not depend on the data
 * plane (R2.23 item 2).
 */
export function createTradfiNativeCostWeiOracle(input: {
  readonly network: TradfiNativeCostNetwork;
  readonly prepareCallsFn?: typeof prepareCalls;
}): ((request: TradfiNativeCostRequest) => Promise<bigint | null>) | undefined {
  if (input.network.relayUrl === undefined) return undefined;
  const relayOrigin = new URL(input.network.relayUrl).origin;
  const client = createClient({ chain: input.network.chain, transport: http(relayOrigin) });
  const prepare = input.prepareCallsFn ?? prepareCalls;
  return async (request) => {
    const facts = request.agent.sessionFacts;
    if (facts === null || facts.expiry !== facts.spec.expiresAt || facts.expiry <= 0) return null;
    let permissions: ReturnType<typeof validateSessionSpec>;
    let key: ReturnType<typeof Key.fromSecp256k1>;
    try {
      permissions = validateSessionSpec(facts.spec, { minSessionSeconds: 0 });
      if (canonicalProviderPermissionsV1(permissions) !== canonicalProviderPermissionsV1(facts.permissions)) return null;
      key = Key.fromSecp256k1({ publicKey: facts.publicKey, role: "session", expiry: facts.expiry, permissions });
    } catch {
      return null;
    }
    const walletAddress = getAddress(request.agent.walletAddress);
    let persistedKeyAddress: Address;
    try { persistedKeyAddress = publicKeyToAddress(facts.publicKey); } catch { return null; }
    if (key.type !== "secp256k1" || key.role !== "session" || key.expiry !== facts.expiry
      || key.publicKey.toLowerCase() !== persistedKeyAddress.toLowerCase()) return null;
    let prepared: Awaited<ReturnType<typeof prepareCalls>>;
    try {
      prepared = await prepare(client, {
        account: walletAddress, chain: input.network.chain,
        calls: request.calls.map((call) => ({ to: getAddress(call.to), value: call.value ?? 0n, data: call.data ?? "0x" })),
        key, feeToken: PORTO_NATIVE_FEE_TOKEN,
      });
    } catch {
      return null;
    }
    if (prepared.key?.publicKey.toLowerCase() !== key.publicKey.toLowerCase()) return null;
    const quote = prepared.capabilities.quote.quotes[0];
    if (quote === undefined) return null;
    const executionDataHash = fingerprintLpFinalCallsV1(request.calls).value.executionDataHash;
    return verifiedPortoNativeFee({ quote: {
      chainId: quote.chainId, orchestrator: quote.orchestrator, intent: quote.intent as unknown as Record<string, unknown>,
      nativeFeeEstimate: quote.nativeFeeEstimate as unknown as Record<string, unknown>, txGas: quote.txGas,
      extraPayment: quote.extraPayment, ttl: prepared.capabilities.quote.ttl,
      } satisfies PortoCostQuote, walletAddress, executionDataHash, expectedKeyHash: Key.hash(key),
      nowSec: Math.floor(Date.now() / 1_000), sessionExpiry: facts.expiry });
  };
}

export function assertKnownSettlementToken(token: Address): void {
  if (token.toLowerCase() !== USDT_56.toLowerCase()) throw new Error("TradFi cost conversion requires canonical USDT.");
}

export type PortoCostQuote = {
  readonly chainId: number;
  readonly orchestrator: Address;
  readonly intent: Record<string, unknown>;
  readonly nativeFeeEstimate: Record<string, unknown>;
  readonly txGas: bigint;
  readonly extraPayment: bigint;
  readonly ttl?: number;
};

/** Validate a read-only Porto prepare quote before using its native fee bound. */
export function verifiedPortoNativeFee(input: {
  readonly quote: PortoCostQuote | null;
  readonly walletAddress: Address;
  readonly executionDataHash: Hex;
  /** Optional for legacy quote fixtures; production cost composition always supplies it. */
  readonly expectedKeyHash?: Hex;
  readonly nowSec: number;
  readonly sessionExpiry?: number;
}): bigint | null {
  const quote = input.quote;
  if (quote === null || quote.chainId !== 56 || quote.orchestrator.toLowerCase() !== PORTO_V055_ORCHESTRATOR.toLowerCase()
    || quote.ttl !== undefined && (!Number.isSafeInteger(quote.ttl) || quote.ttl <= input.nowSec || quote.ttl > input.nowSec + 300)) return null;
  const intent = quote.intent;
  if (typeof intent.eoa !== "string" || intent.eoa.toLowerCase() !== input.walletAddress.toLowerCase()
    || typeof intent.executionData !== "string" || keccak256(intent.executionData as Hex).toLowerCase() !== input.executionDataHash.toLowerCase()
    || typeof intent.expiry !== "bigint" || intent.expiry !== 0n && intent.expiry <= BigInt(input.nowSec)
    || input.sessionExpiry !== undefined && intent.expiry !== 0n && intent.expiry > BigInt(input.sessionExpiry)) return null;
  // MEASURED 2026-09-19 (first mainnet contact of the v2 oracle): the relay's
  // prepared intent carries NO `keyHash` field, so demanding one refused every
  // TradFi entry ("No usable buy route" on 24/24 candidates). The key binding
  // is proven the way the mainnet-proven LP path proves it — `prepared.key`
  // equals the reconstructed session key (checked by the oracle before this
  // call). A keyHash the relay DOES return must still match; only its absence
  // is accepted.
  if (input.expectedKeyHash !== undefined && intent.keyHash !== undefined
    && (typeof intent.keyHash !== "string" || intent.keyHash.toLowerCase() !== input.expectedKeyHash.toLowerCase())) return null;
  const paymentToken = typeof intent.paymentToken === "string" ? intent.paymentToken : null;
  if (paymentToken === null || paymentToken.toLowerCase() !== "0x0000000000000000000000000000000000000000") return null;
  const payer = typeof intent.payer === "string" ? intent.payer.toLowerCase() : null;
  if (payer === null || payer !== "0x0000000000000000000000000000000000000000" && payer !== input.walletAddress.toLowerCase()) return null;
  const paymentAmount = typeof intent.totalPaymentAmount === "bigint" ? intent.totalPaymentAmount
    : typeof intent.paymentAmount === "bigint" ? intent.paymentAmount : null;
  const maxFeePerGas = quote.nativeFeeEstimate.maxFeePerGas;
  const txGas = quote.txGas;
  if (paymentAmount === null || paymentAmount <= 0n || typeof maxFeePerGas !== "bigint" || maxFeePerGas <= 0n || txGas <= 0n) return null;
  const paymentMax = typeof intent.totalPaymentMaxAmount === "bigint" ? intent.totalPaymentMaxAmount
    : typeof intent.paymentMaxAmount === "bigint" ? intent.paymentMaxAmount : null;
  if (paymentMax === null || paymentMax < paymentAmount) return null;
  // NativeFeeEstimate is retained as evidence that this quote binds a concrete
  // gas bound; paymentAmount is the actual relay fee and is the value used.
  void maxFeePerGas; void txGas; void quote.extraPayment;
  return paymentAmount;
}
