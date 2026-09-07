import { randomBytes } from "node:crypto";
import { paidCanonicalJsonV1, paidRequestDigest, sessionTicketHash, verifyPaidAssertion, verifyPaidTicket } from "./canonical.js";
import type { BillingStore } from "./store.js";
import type { AgentBillingGrant, OracleSnapshot, PaidServiceAssertionV1, PaidServiceSessionTicketV1, Usage, X402UsageFacts } from "./types.js";
import { buildX402UsageFacts, canonicalCmcQuery, CMC_AMOUNT_ATOMIC, CMC_ORIGIN, CMC_PATH, CMC_TEMPLATE_ID, selectCmcChallenge, validateBoundPaymentSignature, type CmcQuoteQuery, type HeaderEntry, type SelectedCmcChallenge } from "./x402Registry.js";
import type { Address, Hex } from "viem";
import { keccak256, stringToBytes } from "viem";
import type { FetchLike } from "./og.js";

export type X402Signer = (input: Readonly<{
  selected: SelectedCmcChallenge;
  facts: X402UsageFacts;
}>) => Promise<string>;

export type X402SettlementResult = Readonly<{
  kind: "actual" | "released" | "unknown";
  evidenceKind: string;
  evidenceDigest: string;
}>;

export type CmcAttemptInput = Readonly<{
  store: BillingStore;
  fetch: FetchLike;
  signer: X402Signer;
  reconcileSettlement: (input: Readonly<{
    usage: Usage;
    responseStatus: number;
    responseHeaders: readonly HeaderEntry[];
  }>) => Promise<X402SettlementResult>;
  assertion: PaidServiceAssertionV1;
  ticket: PaidServiceSessionTicketV1;
  grant: AgentBillingGrant;
  executionTicketKeyId: string;
  executionTicketPublicKey: string;
  authorizer: Address;
  query: CmcQuoteQuery;
  now: number;
  preSignCheck: (usage: Usage) => Promise<void>;
  preAdmissionCheck: (usage: Usage) => Promise<void>;
  providerExposureCapAtomic: bigint;
  platformPayerExposureCapAtomic: bigint;
  ogOracle?: OracleSnapshot;
  arbitrumSequencer?: OracleSnapshot;
}>;

export type CmcAttemptResult = Readonly<{
  usage: Usage;
  status: number;
  body?: Uint8Array;
  joined: boolean;
}>;

function entries(headers: Headers): readonly HeaderEntry[] {
  return [...headers.entries()].map(([name, value]) => [name, value] as const);
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") throw new Error("Compressed CMC responses are forbidden.");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("CMC response exceeds 2 MiB.");
    }
    chunks.push(part.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export async function runCmcQuoteAttempt(input: CmcAttemptInput): Promise<CmcAttemptResult> {
  const ticketHash = verifyPaidTicket(input.ticket, input.executionTicketKeyId, input.executionTicketPublicKey, input.now);
  verifyPaidAssertion(input.assertion, input.grant.issuerPublicKey, input.now);
  if (input.assertion.operation !== "paid.cmc.quote" || input.assertion.templateId !== CMC_TEMPLATE_ID || input.assertion.sessionTicketHash !== ticketHash) {
    throw new Error("runtime_auth_failed");
  }
  const query = canonicalCmcQuery(input.query);
  const digest = paidRequestDigest({
    method: "GET",
    fixedRoutePath: "/internal/paid/cmc/quote",
    canonicalQuery: query,
    businessPayload: JSON.stringify({ id: input.query.id, ...(input.query.convert === undefined ? {} : { convert: input.query.convert }), ...(input.query.aux === undefined ? {} : { aux: input.query.aux }) }),
    sessionTicketHash: ticketHash,
  });
  if (input.assertion.requestDigest !== digest) throw new Error("runtime_auth_failed");
  const assertionDigest = keccak256(stringToBytes(paidCanonicalJsonV1(input.assertion)));
  const prepared = await input.store.reservePaidUsage({
    assertion: input.assertion,
    assertionDigest,
    ticket: input.ticket,
    grant: input.grant,
    source: "x402",
    provider: "cmc",
    asset: "USDC_BASE",
    payerIdentity: input.authorizer.toLowerCase(),
    reservedAtomic: CMC_AMOUNT_ATOMIC,
    reservedUsdMicros: CMC_AMOUNT_ATOMIC,
    providerExposureCapAtomic: input.providerExposureCapAtomic,
    platformPayerExposureCapAtomic: input.platformPayerExposureCapAtomic,
    ...(input.ogOracle === undefined ? {} : { ogOracle: input.ogOracle }),
    ...(input.arbitrumSequencer === undefined ? {} : { arbitrumSequencer: input.arbitrumSequencer }),
    now: input.now,
  });
  if (prepared.joined) return { usage: prepared.usage, status: prepared.usage.state === "unknown" ? 409 : prepared.usage.state === "prepared" || prepared.usage.state === "transmitting" ? 202 : 200, joined: true };

  try {
    await input.preAdmissionCheck(prepared.usage);
  } catch (error) {
    await input.store.finalizeProvenNotCharged(
      prepared.usage.usageId,
      prepared.leaseToken,
      "pre_admission_refused",
      keccak256(stringToBytes(error instanceof Error ? error.name : "refused")),
      input.now,
    );
    throw error;
  }

  const url = `${CMC_ORIGIN}${CMC_PATH}?${query}`;
  let unpaid: Response;
  try {
    unpaid = await input.fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", "accept-encoding": "identity" },
    });
  } catch (error) {
    const released = await input.store.finalizeProvenNotCharged(prepared.usage.usageId, prepared.leaseToken, "cmc_unpaid_transport", keccak256(stringToBytes(error instanceof Error ? error.name : "transport")), input.now);
    return { usage: released, status: 502, joined: false };
  }
  if (unpaid.status !== 402) {
    const body = await boundedBody(unpaid);
    const released = await input.store.finalizeProvenNotCharged(prepared.usage.usageId, prepared.leaseToken, "cmc_non_402", keccak256(body), input.now);
    return { usage: released, status: unpaid.status, body, joined: false };
  }

  let selected: SelectedCmcChallenge;
  try { selected = selectCmcChallenge(entries(unpaid.headers)); }
  catch (error) {
    const released = await input.store.finalizeProvenNotCharged(prepared.usage.usageId, prepared.leaseToken, "cmc_challenge_refused", keccak256(stringToBytes(error instanceof Error ? error.message : "challenge")), input.now);
    return { usage: released, status: 502, joined: false };
  }
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const facts = buildX402UsageFacts({
    authorizer: input.authorizer,
    nonce,
    validAfter: BigInt(Math.max(0, input.now - 5)),
    validBefore: BigInt(input.now + selected.requirement.maxTimeoutSeconds),
    challenge: selected,
  });
  let usage = await input.store.bindX402Authorization(prepared.usage.usageId, prepared.leaseToken, prepared.usage.version, facts);
  await input.preSignCheck(usage);
  const paymentHeader = await input.signer({ selected, facts });
  await validateBoundPaymentSignature(paymentHeader, selected, facts);
  usage = await input.store.markUpstreamContact(usage.usageId, prepared.leaseToken, usage.version, input.now);

  let paid: Response;
  try {
    paid = await input.fetch(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "payment-signature": paymentHeader,
      },
    });
  } catch (error) {
    const unknown = await input.store.markUnknown(usage.usageId, prepared.leaseToken, "cmc_paid_transport_unknown", keccak256(stringToBytes(error instanceof Error ? error.name : "transport")), input.now);
    return { usage: unknown, status: 409, joined: false };
  }
  if (paid.status === 402) {
    const unknown = await input.store.markUnknown(usage.usageId, prepared.leaseToken, "cmc_second_402", keccak256(stringToBytes("VENDOR_PAYMENT_REFUSED")), input.now);
    return { usage: unknown, status: 502, joined: false };
  }
  const body = await boundedBody(paid).catch(() => undefined);
  let settlement: X402SettlementResult;
  try { settlement = await input.reconcileSettlement({ usage, responseStatus: paid.status, responseHeaders: entries(paid.headers) }); }
  catch (error) {
    settlement = { kind: "unknown", evidenceKind: "cmc_settlement_unknown", evidenceDigest: keccak256(stringToBytes(error instanceof Error ? error.message : "settlement")) };
  }
  if (settlement.kind === "actual") {
    const actual = await input.store.finalizeActual(usage.usageId, prepared.leaseToken, facts.amountAtomic, settlement.evidenceKind, settlement.evidenceDigest, input.now);
    return { usage: actual, status: paid.status, ...(body === undefined ? {} : { body }), joined: false };
  }
  if (settlement.kind === "released") {
    const released = await input.store.finalizeProvenNotCharged(usage.usageId, prepared.leaseToken, settlement.evidenceKind, settlement.evidenceDigest, input.now);
    return { usage: released, status: paid.status, ...(body === undefined ? {} : { body }), joined: false };
  }
  const unknown = await input.store.markUnknown(usage.usageId, prepared.leaseToken, settlement.evidenceKind, settlement.evidenceDigest, input.now);
  return { usage: unknown, status: 409, joined: false };
}

export function cmcTicketHash(ticket: PaidServiceSessionTicketV1): string {
  return sessionTicketHash(ticket);
}
