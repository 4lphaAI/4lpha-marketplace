/** Read-only Porto prepare quote validation for Quant rebalancing. */
import { keccak256, type Address, type Hex } from "viem";
import { QUANT_ORCHESTRATOR_56 } from "./receipt.js";
import { canonicalProviderPermissionsV1 } from "../lp/preparedIntentWitness.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type QuantPortoFeeQuote = Readonly<{
  chainId: number;
  orchestrator: Address;
  intent: Readonly<Record<string, unknown>>;
  nativeFeeEstimate: Readonly<Record<string, unknown>>;
  txGas: bigint;
  extraPayment: bigint;
  ttl: number;
}>;

export type QuantVerifiedFeeQuote = Readonly<{
  paymentWei: bigint;
  paymentMaxWei: bigint;
  expiresAtSec: number;
  executionDataHash: Hex;
  quotedAtMs: number;
  receivedAtMs: number;
}>;

export function verifyQuantPreparedPublicKey(input: {
  readonly preparedKey: unknown;
  readonly publicKey: Hex;
  readonly expiry: number;
  readonly permissions: unknown;
}): boolean {
  if (typeof input.preparedKey !== "object" || input.preparedKey === null || Array.isArray(input.preparedKey)) return false;
  const key = input.preparedKey as Record<string, unknown>;
  if (key["role"] !== "session" || key["expiry"] !== input.expiry || typeof key["publicKey"] !== "string"
    || key["publicKey"].toLowerCase() !== input.publicKey.toLowerCase()) return false;
  try {
    return canonicalProviderPermissionsV1(key["permissions"]) === canonicalProviderPermissionsV1(input.permissions);
  } catch { return false; }
}

/** Validate identity, exact calls and all native-payment bounds before ranking. */
export function verifyQuantPortoFeeQuote(input: {
  readonly quote: QuantPortoFeeQuote | null;
  readonly wallet: Address;
  readonly expectedKeyHash: Hex;
  readonly executionDataHash: Hex;
  readonly nowSec: number;
  readonly sessionExpirySec: number;
  readonly quotedAtMs: number;
  readonly receivedAtMs: number;
}): QuantVerifiedFeeQuote | null {
  const quote = input.quote;
  if (quote === null || quote.chainId !== 56 || quote.orchestrator.toLowerCase() !== QUANT_ORCHESTRATOR_56.toLowerCase()
    || !Number.isSafeInteger(quote.ttl) || quote.ttl <= input.nowSec || quote.ttl > input.nowSec + 300
    || !Number.isSafeInteger(input.quotedAtMs) || !Number.isSafeInteger(input.receivedAtMs)
    || input.receivedAtMs < input.quotedAtMs || input.receivedAtMs - input.quotedAtMs > 30_000
    || quote.txGas <= 0n || quote.extraPayment !== 0n) return null;
  const intent = quote.intent;
  const emptyVector = (value: unknown): boolean => value === undefined || Array.isArray(value) && value.length === 0;
  const noFunder = (value: unknown): boolean => value === undefined
    || typeof value === "string" && value.toLowerCase() === ZERO_ADDRESS;
  const emptySignature = (value: unknown): boolean => value === undefined
    || typeof value === "string" && value.toLowerCase() === "0x";
  if (!emptyVector(intent["encodedPreCalls"]) || !emptyVector(intent["encodedFundTransfers"])
    || !noFunder(intent["funder"]) || !emptySignature(intent["funderSignature"])) return null;
  if (typeof intent["eoa"] !== "string" || intent["eoa"].toLowerCase() !== input.wallet.toLowerCase()
    || typeof intent["executionData"] !== "string"
    || !/^0x[0-9a-fA-F]*$/u.test(intent["executionData"])
    || keccak256(intent["executionData"] as Hex).toLowerCase() !== input.executionDataHash.toLowerCase()) return null;
  const intentExpiry = intent["expiry"];
  if (typeof intentExpiry !== "bigint" || intentExpiry < 0n
    || intentExpiry !== 0n && intentExpiry <= BigInt(input.nowSec)
    || intentExpiry !== 0n && intentExpiry > BigInt(input.sessionExpirySec)) return null;
  const keyHash = intent["keyHash"];
  if (keyHash !== undefined && (typeof keyHash !== "string" || keyHash.toLowerCase() !== input.expectedKeyHash.toLowerCase())) return null;
  if (typeof intent["paymentToken"] !== "string" || intent["paymentToken"].toLowerCase() !== ZERO_ADDRESS) return null;
  const payer = intent["payer"];
  if (typeof payer !== "string" || payer.toLowerCase() !== ZERO_ADDRESS && payer.toLowerCase() !== input.wallet.toLowerCase()) return null;
  const paymentWei = typeof intent["totalPaymentAmount"] === "bigint" ? intent["totalPaymentAmount"]
    : typeof intent["paymentAmount"] === "bigint" ? intent["paymentAmount"] : null;
  const paymentMaxWei = typeof intent["totalPaymentMaxAmount"] === "bigint" ? intent["totalPaymentMaxAmount"]
    : typeof intent["paymentMaxAmount"] === "bigint" ? intent["paymentMaxAmount"] : null;
  const maxFeePerGas = quote.nativeFeeEstimate["maxFeePerGas"];
  if (paymentWei === null || paymentMaxWei === null || paymentWei <= 0n || paymentMaxWei < paymentWei
    || typeof maxFeePerGas !== "bigint" || maxFeePerGas <= 0n) return null;
  return { paymentWei, paymentMaxWei, expiresAtSec: quote.ttl, executionDataHash: input.executionDataHash,
    quotedAtMs: input.quotedAtMs, receivedAtMs: input.receivedAtMs };
}
