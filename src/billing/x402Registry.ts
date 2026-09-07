import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { ExactEIP3009Payload } from "@x402/evm";
import { getAddress, isAddress, keccak256, recoverTypedDataAddress, stringToBytes, type Address, type Hex } from "viem";
import type { X402UsageFacts } from "./types.js";

export const X402_REGISTRY_VERSION = "x402-v1-2026-08-26" as const;
export const CMC_TEMPLATE_ID = "cmc.quote.latest.v1";
export const CMC_ORIGIN = "https://pro-api.coinmarketcap.com";
export const CMC_PATH = "/x402/v3/cryptocurrency/quotes/latest";
export const CMC_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
export const CMC_PAYEE = getAddress("0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA");
export const CMC_AMOUNT_ATOMIC = 10_000n;
export const X402_HEADER_MAX_CHARS = 16 * 1024;

export const CMC_REQUIREMENT_EXTRA = Object.freeze({
  name: "USD Coin",
  version: "2",
  x402PaymentConfigId: "699dbab79f32ffde650104aa",
  assetTransferMethod: "eip3009",
});

export type HeaderEntry = readonly [name: string, value: string];

export function x402AuthorizationSigningBytes(facts: X402UsageFacts): Uint8Array {
  if (
    facts.chainId !== 8453 || facts.usdcAddress.toLowerCase() !== CMC_USDC.toLowerCase() ||
    facts.payee.toLowerCase() !== CMC_PAYEE.toLowerCase() || facts.amountAtomic !== CMC_AMOUNT_ATOMIC ||
    !isAddress(facts.authorizer, { strict: false }) || !/^0x[0-9a-f]{64}$/u.test(facts.authorizationNonce)
  ) throw new Error("Stored x402 authorization facts drifted before signing.");
  return new TextEncoder().encode(JSON.stringify({
    domain: {
      name: CMC_REQUIREMENT_EXTRA.name,
      version: CMC_REQUIREMENT_EXTRA.version,
      chainId: 8453,
      verifyingContract: CMC_USDC,
    },
    primaryType: "TransferWithAuthorization",
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    message: {
      from: getAddress(facts.authorizer),
      to: CMC_PAYEE,
      value: facts.amountAtomic.toString(),
      validAfter: facts.validAfter.toString(),
      validBefore: facts.validBefore.toString(),
      nonce: facts.authorizationNonce,
    },
  }));
}

export function buildBoundPaymentSignatureHeader(
  selected: SelectedCmcChallenge,
  facts: X402UsageFacts,
  signature: string,
): string {
  if (!/^0x[0-9a-fA-F]{130}$/u.test(signature)) throw new Error("The x402 custody signer returned a malformed signature.");
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: selected.paymentRequired.resource,
    accepted: selected.requirement,
    payload: {
      signature,
      authorization: {
        from: getAddress(facts.authorizer),
        to: CMC_PAYEE,
        value: facts.amountAtomic.toString(),
        validAfter: facts.validAfter.toString(),
        validBefore: facts.validBefore.toString(),
        nonce: facts.authorizationNonce as Hex,
      },
    },
  });
}

function isPaymentNamespace(name: string): boolean {
  return name === "payment" || name.startsWith("payment-") || name === "x-payment" || name.startsWith("x-payment-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new Error(`${field} contains an unknown key.`);
  }
}

function decodeStandardBase64Json(value: string): unknown {
  if (value.length < 1 || value.length > X402_HEADER_MAX_CHARS || /[^\x20-\x7e]/.test(value)) {
    throw new Error("x402 header is oversized or non-ASCII.");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("x402 header must be strict standard base64.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("x402 header base64 is not canonical.");
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("x402 header JSON is malformed.");
  }
}

export function readOnlyCanonicalPaymentHeader(
  entries: readonly HeaderEntry[],
  expected: "PAYMENT-REQUIRED" | "PAYMENT-SIGNATURE" | "PAYMENT-RESPONSE",
): string {
  const expectedLower = expected.toLowerCase();
  let found: string | undefined;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (isPaymentNamespace(name) && name !== expectedLower) {
      throw new Error("Legacy, mixed, or unexpected x402 payment header.");
    }
    if (name === expectedLower) {
      if (found !== undefined || rawValue.includes(",")) throw new Error("Duplicate or folded x402 header.");
      found = rawValue;
    }
  }
  if (found === undefined) throw new Error(`${expected} is required.`);
  decodeStandardBase64Json(found);
  return found;
}

function assertExtra(extra: unknown): void {
  if (!isRecord(extra)) throw new Error("CMC x402 extra is required.");
  exactKeys(extra, ["name", "version", "x402PaymentConfigId", "assetTransferMethod"], "CMC extra");
  if (JSON.stringify(extra) !== JSON.stringify(CMC_REQUIREMENT_EXTRA)) {
    throw new Error("CMC x402 extra drifted.");
  }
}

function assertRequirement(requirement: PaymentRequirements): void {
  if (
    requirement.scheme !== "exact" ||
    requirement.network !== "eip155:8453" ||
    requirement.asset.toLowerCase() !== CMC_USDC.toLowerCase() ||
    requirement.payTo.toLowerCase() !== CMC_PAYEE.toLowerCase() ||
    requirement.amount !== CMC_AMOUNT_ATOMIC.toString() ||
    !Number.isInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds < 1 ||
    requirement.maxTimeoutSeconds > 30
  ) {
    throw new Error("CMC x402 requirement is outside the reviewed registry.");
  }
  assertExtra(requirement.extra);
}

function assertRawPaymentRequired(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("PAYMENT-REQUIRED must decode to an object.");
  exactKeys(value, ["x402Version", "error", "resource", "accepts"], "PAYMENT-REQUIRED");
  if (value["x402Version"] !== 2 || "extensions" in value) throw new Error("Only extension-free x402 v2 is accepted.");
  const resource = value["resource"];
  if (!isRecord(resource)) throw new Error("x402 resource is required.");
  exactKeys(resource, ["url", "description", "mimeType", "serviceName", "tags", "iconUrl"], "x402 resource");
  if (resource["url"] !== `${CMC_ORIGIN}${CMC_PATH}`) throw new Error("x402 resource URL drifted.");
  const accepts = value["accepts"];
  if (!Array.isArray(accepts)) throw new Error("x402 accepts must be an array.");
  for (const entry of accepts) {
    if (!isRecord(entry)) throw new Error("x402 requirement must be an object.");
    exactKeys(entry, ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds", "extra"], "x402 requirement");
  }
}

export type SelectedCmcChallenge = Readonly<{
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  challengeDigest: Hex;
}>;

export function selectCmcChallenge(entries: readonly HeaderEntry[]): SelectedCmcChallenge {
  const header = readOnlyCanonicalPaymentHeader(entries, "PAYMENT-REQUIRED");
  const raw = decodeStandardBase64Json(header);
  assertRawPaymentRequired(raw);
  const paymentRequired = decodePaymentRequiredHeader(header);
  if (encodePaymentRequiredHeader(paymentRequired) !== header) throw new Error("PAYMENT-REQUIRED codec round-trip drifted.");
  if (paymentRequired.x402Version !== 2 || paymentRequired.extensions !== undefined) {
    throw new Error("Only extension-free x402 v2 is accepted.");
  }
  const eligible = paymentRequired.accepts.filter((candidate) => {
    try {
      assertRequirement(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (eligible.length !== 1) throw new Error("CMC challenge must contain exactly one eligible option.");
  const requirement = eligible[0];
  if (requirement === undefined) throw new Error("No eligible CMC x402 option.");
  return {
    paymentRequired,
    requirement,
    challengeDigest: keccak256(stringToBytes(header)),
  };
}

function assertRawPaymentPayload(raw: unknown): void {
  if (!isRecord(raw)) throw new Error("PAYMENT-SIGNATURE must decode to an object.");
  exactKeys(raw, ["x402Version", "resource", "accepted", "payload"], "PAYMENT-SIGNATURE");
  if (raw["x402Version"] !== 2 || "extensions" in raw) throw new Error("Payment payload extensions are forbidden.");
  const payload = raw["payload"];
  if (!isRecord(payload)) throw new Error("EIP-3009 payload is required.");
  exactKeys(payload, ["signature", "authorization"], "EIP-3009 payload");
  const authorization = payload["authorization"];
  if (!isRecord(authorization)) throw new Error("EIP-3009 authorization is required.");
  exactKeys(authorization, ["from", "to", "value", "validAfter", "validBefore", "nonce"], "EIP-3009 authorization");
}

export async function validateBoundPaymentSignature(
  header: string,
  selected: SelectedCmcChallenge,
  facts: X402UsageFacts,
): Promise<PaymentPayload> {
  const raw = decodeStandardBase64Json(header);
  assertRawPaymentPayload(raw);
  const payment = decodePaymentSignatureHeader(header);
  if (encodePaymentSignatureHeader(payment) !== header) throw new Error("PAYMENT-SIGNATURE codec round-trip drifted.");
  if (payment.x402Version !== 2 || payment.extensions !== undefined) throw new Error("Payment payload drifted.");
  if (JSON.stringify(payment.accepted) !== JSON.stringify(selected.requirement)) {
    throw new Error("Payment payload did not bind the selected requirement.");
  }
  if (payment.resource?.url !== `${CMC_ORIGIN}${CMC_PATH}`) throw new Error("Payment resource drifted.");
  assertRequirement(payment.accepted);
  const payload = payment.payload as ExactEIP3009Payload;
  const authorization = payload.authorization;
  if (
    authorization.from.toLowerCase() !== facts.authorizer.toLowerCase() ||
    authorization.to.toLowerCase() !== facts.payee.toLowerCase() ||
    authorization.value !== facts.amountAtomic.toString() ||
    authorization.validAfter !== facts.validAfter.toString() ||
    authorization.validBefore !== facts.validBefore.toString() ||
    authorization.nonce.toLowerCase() !== facts.authorizationNonce.toLowerCase() ||
    facts.chainId !== 8453 ||
    facts.usdcAddress.toLowerCase() !== CMC_USDC.toLowerCase() ||
    facts.challengeDigest !== selected.challengeDigest ||
    payload.signature === undefined
  ) {
    throw new Error("Payment payload did not bind stored x402 authorization facts.");
  }
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: CMC_REQUIREMENT_EXTRA.name,
      version: CMC_REQUIREMENT_EXTRA.version,
      chainId: 8453,
      verifyingContract: CMC_USDC,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
    signature: payload.signature,
  });
  if (recovered.toLowerCase() !== facts.authorizer.toLowerCase()) throw new Error("EIP-3009 signature signer drifted.");
  return payment;
}

export type CmcQuoteQuery = Readonly<{ id: string; convert?: string; aux?: string }>;
const AUX_FIELDS = new Set([
  "num_market_pairs", "cmc_rank", "date_added", "tags", "platform", "max_supply",
  "circulating_supply", "total_supply", "is_active", "is_fiat",
]);

export function canonicalCmcQuery(input: CmcQuoteQuery): string {
  const ids = input.id.split(",");
  if (ids.length < 1 || ids.length > 100 || ids.some((id) => !/^(0|[1-9][0-9]*)$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("CMC id must contain 1..100 unique unsigned decimals.");
  }
  const fields = [`id=${ids.join(",")}`];
  if (input.convert !== undefined) {
    if (!/^[A-Z]{2,12}$/.test(input.convert)) throw new Error("CMC convert is invalid.");
    fields.push(`convert=${input.convert}`);
  }
  if (input.aux !== undefined) {
    const aux = input.aux.split(",");
    if (aux.length < 1 || aux.some((field) => !AUX_FIELDS.has(field)) || new Set(aux).size !== aux.length) {
      throw new Error("CMC aux is invalid.");
    }
    fields.push(`aux=${aux.join(",")}`);
  }
  return fields.join("&");
}

export function decodeCanonicalPaymentResponse(entries: readonly HeaderEntry[]): Readonly<{
  transaction: string;
  network: string;
  payer?: string;
}> {
  const header = readOnlyCanonicalPaymentHeader(entries, "PAYMENT-RESPONSE");
  const raw = decodeStandardBase64Json(header);
  if (!isRecord(raw)) throw new Error("PAYMENT-RESPONSE must decode to an object.");
  exactKeys(raw, ["success", "payer", "transaction", "network"], "PAYMENT-RESPONSE");
  const response = decodePaymentResponseHeader(header);
  if (
    response.success !== true || response.network !== "eip155:8453" ||
    typeof response.transaction !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(response.transaction) ||
    response.payer !== undefined && (!isAddress(response.payer, { strict: false }) || response.payer !== response.payer.toLowerCase()) ||
    encodePaymentResponseHeader(response) !== header
  ) {
    throw new Error("Settlement response drifted.");
  }
  return {
    transaction: response.transaction,
    network: response.network,
    ...(response.payer === undefined ? {} : { payer: response.payer }),
  };
}

export function buildX402UsageFacts(input: Readonly<{
  authorizer: Address;
  nonce: Hex;
  validAfter: bigint;
  validBefore: bigint;
  challenge: SelectedCmcChallenge;
}>): X402UsageFacts {
  if (input.nonce.length !== 66 || input.validAfter < 0n || input.validBefore <= input.validAfter) {
    throw new Error("Invalid EIP-3009 authorization window.");
  }
  return {
    kind: "x402",
    registryVersion: X402_REGISTRY_VERSION,
    chainId: 8453,
    usdcAddress: CMC_USDC.toLowerCase(),
    authorizer: input.authorizer.toLowerCase(),
    authorizationNonce: input.nonce.toLowerCase(),
    validAfter: input.validAfter,
    validBefore: input.validBefore,
    payee: CMC_PAYEE.toLowerCase(),
    amountAtomic: CMC_AMOUNT_ATOMIC,
    challengeDigest: input.challenge.challengeDigest,
  };
}
