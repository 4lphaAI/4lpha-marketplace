import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, keccak256 } from "viem";
import type { Address, Hex } from "viem";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import {
  assertionSigningBytes,
  paidRequestDigest,
  sessionTicketHash,
  signPaidBytes,
  ticketSigningBytes,
  verifyPaidAssertion,
  verifyPaidTicket,
} from "../src/billing/canonical.js";
import { resolveBillingConfig, BILLING_RELAY_RESERVE_WEI } from "../src/billing/config.js";
import { compileBillingCollector } from "../src/billing/collectorCompiler.js";
import { BILLING_ERROR_TABLE, billingError } from "../src/billing/errors.js";
import { allocateInvoiceUsdMicros, buildQuotedInvoice, calculateBillingDayCapWei, ceilDiv, quoteInvoiceAmounts } from "../src/billing/math.js";
import { assertLiveOgModelMatches, canonicalOgChatBody, getOgChatModel, OG_CHAT_MODELS } from "../src/billing/models.js";
import { ORACLE_MANIFEST, assertOracleQuoteSet, validateOraclePair, type OracleObservation } from "../src/billing/oracles.js";
import { parseOgHistoryPage, matchOgHistory, reconcileOgUsageFromHistory } from "../src/billing/og.js";
import { billingSessionSpec } from "../src/billing/sessionPolicy.js";
import { MemoryBillingStore } from "../src/billing/store.js";
import { PostgresBillingStore } from "../src/billing/postgres.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { MemoryExecutionJournal, PostgresExecutionJournal } from "../src/store/journal.js";
import type { AgentBillingGrant, BillingAccount, OgUsageFacts, PaidServiceAssertionV1, PaidServiceSessionTicketV1, Usage } from "../src/billing/types.js";
import { BILLING_COLLECTOR_ABI, billingCollectorCalldata } from "../src/billing/evidence.js";
import { billingCollectionDecisionId, projectBillingCollectionProof, recoverBillingInvoiceCallsId, submitBillingInvoice } from "../src/billing/collection.js";
import { parsePaidAssertion, parsePaidTicket } from "../src/billing/wire.js";
import { billingAccountId } from "../src/billing/serviceSession.js";
import { runBillingWorkerOnce } from "../src/billing/worker.js";
import { reconcileX402UsageFromBase } from "../src/billing/production.js";
import {
  resolveBillingDestinationPins,
  type PinnedBillingTransport,
} from "../src/billing/transport.js";
import { runCmcQuoteAttempt } from "../src/billing/x402.js";
import {
  buildX402UsageFacts,
  canonicalCmcQuery,
  CMC_AMOUNT_ATOMIC,
  CMC_ORIGIN,
  CMC_PATH,
  CMC_PAYEE,
  CMC_REQUIREMENT_EXTRA,
  CMC_TEMPLATE_ID,
  CMC_USDC,
  decodeCanonicalPaymentResponse,
  readOnlyCanonicalPaymentHeader,
  selectCmcChallenge,
  validateBoundPaymentSignature,
} from "../src/billing/x402Registry.js";

const OWNER: Address = "0x1000000000000000000000000000000000000001";
const WALLET: Address = "0x2000000000000000000000000000000000000002";
const COLLECTOR: Address = "0x3000000000000000000000000000000000000003";
const TREASURY: Address = "0x4000000000000000000000000000000000000004";
const KEYSTORE: Address = "0x5000000000000000000000000000000000000005";
const HASH = `0x${"11".repeat(32)}` as Hex;
const ACCOUNT_ID = billingAccountId(OWNER, WALLET);

function edKeys(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

function signedTicket(keys: ReturnType<typeof edKeys>, now = 1_000): PaidServiceSessionTicketV1 {
  const unsigned: PaidServiceSessionTicketV1 = {
    domain: "4lpha.paid-service-ticket.v1",
    ticketId: "ticket-1",
    accountId: ACCOUNT_ID,
    agentId: "agent-1",
    ownerAddress: OWNER,
    walletAddress: WALLET,
    grantId: "grant-1",
    generation: 1n,
    operations: ["paid.0g.chat"],
    templateIds: ["0g.chat.v1"],
    allowedModelIds: ["0gm-1.0-35b-a3b"],
    maxTokensPerInference: 32,
    maxSessionUsdMicros: 1_000_000n,
    ownerActionParamsHash: HASH,
    issuedAt: now,
    expiresAt: now + 600,
    executionTicketKeyId: "ticket-key-1",
    signature: "A".repeat(86),
  };
  return { ...unsigned, signature: signPaidBytes(keys.privateKey, ticketSigningBytes(unsigned)) };
}

function signedAssertion(keys: ReturnType<typeof edKeys>, ticket: PaidServiceSessionTicketV1, now = 1_000): PaidServiceAssertionV1 {
  const digest = paidRequestDigest({
    method: "POST",
    fixedRoutePath: "/internal/paid/0g/chat",
    canonicalQuery: "",
    businessPayload: canonicalOgChatBody("0gm-1.0-35b-a3b", 8, [{ role: "user", content: "hello" }]).body,
    sessionTicketHash: sessionTicketHash(ticket),
  });
  const unsigned: PaidServiceAssertionV1 = {
    domain: "4lpha.paid-service.v1",
    issuerKeyId: "issuer-1",
    grantId: "grant-1",
    generation: 1n,
    accountId: ACCOUNT_ID,
    agentId: "agent-1",
    ownerAddress: OWNER,
    walletAddress: WALLET,
    operation: "paid.0g.chat",
    templateId: "0g.chat.v1",
    logicalRequestId: "logical-1",
    requestDigest: digest,
    sessionTicketHash: sessionTicketHash(ticket),
    maxTokens: 8,
    nonce: Buffer.alloc(16, 7).toString("base64url"),
    issuedAt: now,
    expiresAt: now + 30,
    signature: "A".repeat(86),
  };
  return { ...unsigned, signature: signPaidBytes(keys.privateKey, assertionSigningBytes(unsigned)) };
}

function signedCmcTicket(keys: ReturnType<typeof edKeys>, now: number): PaidServiceSessionTicketV1 {
  const unsigned: PaidServiceSessionTicketV1 = {
    domain: "4lpha.paid-service-ticket.v1",
    ticketId: "ticket-cmc-1",
    accountId: ACCOUNT_ID,
    agentId: "agent-1",
    ownerAddress: OWNER,
    walletAddress: WALLET,
    grantId: "grant-cmc-1",
    generation: 1n,
    operations: ["paid.cmc.quote"],
    templateIds: [CMC_TEMPLATE_ID],
    maxSessionUsdMicros: 1_000_000n,
    ownerActionParamsHash: HASH,
    issuedAt: now,
    expiresAt: now + 600,
    executionTicketKeyId: "ticket-key-1",
    signature: "A".repeat(86),
  };
  return { ...unsigned, signature: signPaidBytes(keys.privateKey, ticketSigningBytes(unsigned)) };
}

function signedCmcAssertion(
  keys: ReturnType<typeof edKeys>,
  ticket: PaidServiceSessionTicketV1,
  now: number,
): PaidServiceAssertionV1 {
  const query = canonicalCmcQuery({ id: "1" });
  const unsigned: PaidServiceAssertionV1 = {
    domain: "4lpha.paid-service.v1",
    issuerKeyId: "issuer-cmc-1",
    grantId: ticket.grantId,
    generation: ticket.generation,
    accountId: ticket.accountId,
    agentId: ticket.agentId,
    ownerAddress: ticket.ownerAddress,
    walletAddress: ticket.walletAddress,
    operation: "paid.cmc.quote",
    templateId: CMC_TEMPLATE_ID,
    logicalRequestId: "logical-cmc-1",
    requestDigest: paidRequestDigest({
      method: "GET",
      fixedRoutePath: "/internal/paid/cmc/quote",
      canonicalQuery: query,
      businessPayload: JSON.stringify({ id: "1" }),
      sessionTicketHash: sessionTicketHash(ticket),
    }),
    sessionTicketHash: sessionTicketHash(ticket),
    nonce: Buffer.alloc(16, 9).toString("base64url"),
    issuedAt: now,
    expiresAt: now + 30,
    signature: "A".repeat(86),
  };
  return { ...unsigned, signature: signPaidBytes(keys.privateKey, assertionSigningBytes(unsigned)) };
}

test("billing config defaults every paid gate off without reading production fields", () => {
  assert.deepEqual(resolveBillingConfig({}), { mode: "off", x402: "off", og: "off", internalHost: "127.0.0.1" });
  assert.deepEqual(resolveBillingConfig({ BILLING_ENABLED: "report", BILLING_X402_ENABLED: "on" }), {
    mode: "report", x402: "on", og: "off", internalHost: "127.0.0.1",
  });
});

test("billing config rejects malformed and externally bound on modes", () => {
  assert.throws(() => resolveBillingConfig({ BILLING_ENABLED: "true" }));
  assert.throws(() => resolveBillingConfig({ BILLING_ENABLED: "on", BILLING_X402_ENABLED: "on", BILLING_INTERNAL_HOST: "0.0.0.0" }));
});

test("billing error table has the exact 17 closed rows and Phase 5 envelope", () => {
  assert.equal(Object.keys(BILLING_ERROR_TABLE).length, 17);
  assert.deepEqual(billingError("ORACLE_STALE").body, {
    data: null,
    error: { code: "oracle_stale" },
    meta: { retryable: true, resolution: "none" },
  });
});

test("ceil and asset conversion round upward at every boundary", () => {
  assert.equal(ceilDiv(0n, 7n), 0n);
  assert.equal(ceilDiv(7n, 7n), 1n);
  assert.equal(ceilDiv(8n, 7n), 2n);
  const quote = quoteInvoiceAmounts({
    ogNeuron: 1_000_000_000_000_000_000n,
    baseUsdcAtomic: 10_000n,
    ogUsdAnswer: 100_000_000n,
    ogUsdDecimals: 8,
    bnbUsdAnswer: 800_000_000_00n,
    bnbUsdDecimals: 8,
  });
  assert.equal(quote.totalUsdMicros, 1_010_000n);
  assert.equal(quote.invoiceBnbWei % 1_000_000_000_000n, 0n);
  assert.ok(quote.invoiceBnbWei >= quote.rawBnbWei);
  assert.ok(quote.invoiceBnbWei - quote.rawBnbWei < 1_000_000_000_000n);
});

test("billing DAY cap includes exact relay reserve and refuses >0.1 BNB", () => {
  const cap = calculateBillingDayCapWei(100_000n, 80_000_000_000n, 8);
  assert.ok(cap > BILLING_RELAY_RESERVE_WEI);
  assert.throws(() => calculateBillingDayCapWei(100_000_001n, 80_000_000_000n, 8));
});

test("invoice allocation floors then assigns remainder by lexical usage id", () => {
  const allocated = allocateInvoiceUsdMicros(10n, new Map([["b", 1n], ["a", 1n], ["c", 1n]]));
  assert.deepEqual([...allocated.entries()], [["a", 4n], ["b", 3n], ["c", 3n]]);
});

function observation(feed: "0G_USD" | "BNB_USD" | "ARBITRUM_SEQUENCER", now: number): OracleObservation {
  const manifest = ORACLE_MANIFEST[feed];
  return {
    chainId: manifest.chainId,
    proxy: manifest.proxy,
    description: manifest.description,
    decimals: manifest.decimals,
    roundId: 7n,
    answer: feed === "ARBITRUM_SEQUENCER" ? 0n : 100_000_000n,
    startedAt: now - 4_000,
    updatedAt: feed === "0G_USD" ? now - 80_000 : now - 10,
    answeredInRound: 7n,
  };
}

test("oracle pairs require identical RPC facts, feed predicates, and 3600s sequencer grace", () => {
  const now = 100_000;
  const bnb = validateOraclePair("BNB_USD", observation("BNB_USD", now), observation("BNB_USD", now), now);
  const og = validateOraclePair("0G_USD", observation("0G_USD", now), observation("0G_USD", now), now);
  const sequencer = validateOraclePair("ARBITRUM_SEQUENCER", observation("ARBITRUM_SEQUENCER", now), observation("ARBITRUM_SEQUENCER", now), now);
  assert.doesNotThrow(() => assertOracleQuoteSet({ ogNeuron: 1n, bnb, og, sequencer, quoteTimestamp: now }));
  assert.throws(() => validateOraclePair("BNB_USD", observation("BNB_USD", now), { ...observation("BNB_USD", now), answer: 2n }, now));
  assert.throws(() => validateOraclePair("ARBITRUM_SEQUENCER", { ...observation("ARBITRUM_SEQUENCER", now), startedAt: now - 3_599 }, { ...observation("ARBITRUM_SEQUENCER", now), startedAt: now - 3_599 }, now));
});

test("cross-feed skew accepts 90000 and rejects 90001 seconds", () => {
  const bnb = { ...validateOraclePair("BNB_USD", observation("BNB_USD", 100_000), observation("BNB_USD", 100_000), 100_000), updatedAt: 100_000 };
  const sequencer = validateOraclePair("ARBITRUM_SEQUENCER", observation("ARBITRUM_SEQUENCER", 100_000), observation("ARBITRUM_SEQUENCER", 100_000), 100_000);
  const atLimit = { ...observation("0G_USD", 100_000), updatedAt: 10_000 };
  const overLimit = { ...observation("0G_USD", 100_000), updatedAt: 9_999 };
  const og = validateOraclePair("0G_USD", atLimit, atLimit, 100_000);
  assert.doesNotThrow(() => assertOracleQuoteSet({ ogNeuron: 1n, bnb, og, sequencer, quoteTimestamp: 100_000 }));
  assert.throws(() => validateOraclePair("0G_USD", overLimit, overLimit, 100_000));
});

test("exact 25-model manifest and conservative full-context reservation", () => {
  assert.equal(OG_CHAT_MODELS.size, 25);
  const result = canonicalOgChatBody("0gm-1.0-35b-a3b", 32, [{ role: "user", content: "hello" }]);
  assert.equal(result.body, '{"model":"0gm-1.0-35b-a3b","messages":[{"role":"user","content":"hello"}],"max_tokens":32,"stream":true}');
  assert.equal(result.reserveNeuron, getOgChatModel("0gm-1.0-35b-a3b").contextLength * 501_000_000_000n + 32n * 3_010_000_000_000n);
  assert.throws(() => canonicalOgChatBody("image-model", 1, [{ role: "user", content: "x" }]));
  assert.throws(() => canonicalOgChatBody("0gm-1.0-35b-a3b", 1, [{ role: "user", content: "x".repeat(4_001) }]));
});

test("every live 0G catalog field is fail-closed before paid admission", () => {
  const reviewed = getOgChatModel("0gm-1.0-35b-a3b");
  const live = {
    canonicalModelId: reviewed.canonicalModelId,
    serviceType: "chatbot",
    contextLength: reviewed.contextLength,
    maxCompletionTokens: reviewed.maxCompletionTokens,
    inputReserveNeuronPerToken: reviewed.inputReserveNeuronPerToken,
    completionNeuronPerToken: reviewed.completionNeuronPerToken,
    providerAddress: reviewed.providerAddress,
    teeAcknowledged: true,
    explicitlyHealthy: true,
  };
  assert.doesNotThrow(() => assertLiveOgModelMatches(reviewed, live));
  for (const mutant of [
    { ...live, canonicalModelId: "other" },
    { ...live, serviceType: "image" },
    { ...live, contextLength: reviewed.contextLength - 1n },
    { ...live, maxCompletionTokens: reviewed.maxCompletionTokens - 1n },
    { ...live, inputReserveNeuronPerToken: reviewed.inputReserveNeuronPerToken + 1n },
    { ...live, completionNeuronPerToken: reviewed.completionNeuronPerToken + 1n },
    { ...live, providerAddress: OWNER },
    { ...live, teeAcknowledged: false },
    { ...live, explicitlyHealthy: false },
  ]) assert.throws(() => assertLiveOgModelMatches(reviewed, mutant));
});

test("ticket and per-agent assertion signatures are portable Ed25519 artifacts", () => {
  const ticketKeys = edKeys();
  const issuerKeys = edKeys();
  const ticket = signedTicket(ticketKeys);
  const assertion = signedAssertion(issuerKeys, ticket);
  assert.equal(verifyPaidTicket(ticket, "ticket-key-1", ticketKeys.publicKey, 1_001), sessionTicketHash(ticket));
  assert.doesNotThrow(() => verifyPaidAssertion(assertion, issuerKeys.publicKey, 1_001));
  assert.throws(() => verifyPaidTicket({ ...ticket, expiresAt: 2_000 }, "ticket-key-1", ticketKeys.publicKey, 1_001));
  assert.throws(() => verifyPaidAssertion({ ...assertion, templateId: "cmc.quote.latest.v1" }, issuerKeys.publicKey, 1_001));
});

test("paid wire golden vector is byte-stable for the 4lpha-0G bridge", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/phase5-paid-wire-v1.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const ticket = parsePaidTicket(fixture["ticket"]);
  const assertion = parsePaidAssertion(fixture["assertion"]);
  const publicKey = fixture["publicKeySpki"];
  const expectedHash = fixture["ticketHash"];
  assert.equal(typeof publicKey, "string");
  assert.equal(typeof expectedHash, "string");
  assert.equal(verifyPaidTicket(ticket, "execution-vector-1", publicKey as string, 2_000_000_010), expectedHash);
  assert.equal(sessionTicketHash(ticket), expectedHash);
  assert.doesNotThrow(() => verifyPaidAssertion(assertion, publicKey as string, 2_000_000_010));
});

test("request digest is non-circular: auth envelope changes do not change business digest", () => {
  const projection = { method: "GET" as const, fixedRoutePath: "/internal/paid/cmc/quote", canonicalQuery: "id=1", businessPayload: '{"id":"1"}', sessionTicketHash: HASH };
  assert.equal(paidRequestDigest(projection), paidRequestDigest({ ...projection }));
  assert.notEqual(paidRequestDigest(projection), paidRequestDigest({ ...projection, canonicalQuery: "id=2" }));
});

test("billing session has exactly collector selector plus one native DAY cap", () => {
  const spec = billingSessionSpec({ collector: COLLECTOR, treasury: TREASURY, wallet: WALLET, keyStore: KEYSTORE, dayCapWei: 1_000_000n, now: 1_000, expiresAt: 2_000 });
  assert.deepEqual(spec.allowedCalls, [{ to: COLLECTOR, selector: "payInvoice(bytes32,uint64)" }]);
  assert.deepEqual(spec.spendCaps, [{ limit: 1_000_000n, period: "day" }]);
  assert.throws(() => billingSessionSpec({ collector: COLLECTOR, treasury: COLLECTOR, wallet: WALLET, keyStore: KEYSTORE, dayCapWei: 1n, now: 1_000, expiresAt: 2_000 }));
});

test("BillingCollector compiles reproducibly under pinned solc settings", async () => {
  const source = await readFile(new URL("../contracts/BillingCollector.sol", import.meta.url), "utf8");
  const first = await compileBillingCollector(source);
  const second = await compileBillingCollector(source);
  assert.match(first.solcVersion, /^0\.8\.30\+/);
  assert.equal(first.creationBytecodeHash, second.creationBytecodeHash);
  assert.equal(first.runtimeBytecodeHash, second.runtimeBytecodeHash);
  assert.ok(!source.includes("selfdestruct"));
  assert.ok(!source.includes("delegatecall"));
});

function challenge(): { header: string; required: PaymentRequired } {
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: `${CMC_ORIGIN}${CMC_PATH}` },
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      asset: CMC_USDC,
      amount: CMC_AMOUNT_ATOMIC.toString(),
      payTo: CMC_PAYEE,
      maxTimeoutSeconds: 30,
      extra: CMC_REQUIREMENT_EXTRA,
    }],
  };
  return { required, header: encodePaymentRequiredHeader(required) };
}

test("CMC query grammar is closed and deterministic", () => {
  assert.equal(canonicalCmcQuery({ id: "1,2", convert: "USD", aux: "cmc_rank,tags" }), "id=1,2&convert=USD&aux=cmc_rank,tags");
  assert.throws(() => canonicalCmcQuery({ id: "1,1" }));
  assert.throws(() => canonicalCmcQuery({ id: "1", convert: "usd" }));
  assert.throws(() => canonicalCmcQuery({ id: "1", aux: "secret" }));
});

test("CMC challenge accepts exactly one canonical v2 requirement and rejects aliases", () => {
  const fixture = challenge();
  assert.equal(selectCmcChallenge([["PAYMENT-REQUIRED", fixture.header]]).requirement.amount, "10000");
  assert.throws(() => selectCmcChallenge([["X-PAYMENT-REQUIRED", fixture.header]]));
  assert.throws(() => readOnlyCanonicalPaymentHeader([["PAYMENT-REQUIRED", fixture.header], ["PAYMENT-REQUIRED", fixture.header]], "PAYMENT-REQUIRED"));
  const drift = { ...fixture.required, accepts: [{ ...fixture.required.accepts[0]!, payTo: OWNER }] };
  assert.throws(() => selectCmcChallenge([["PAYMENT-REQUIRED", encodePaymentRequiredHeader(drift)]]));
});

test("x402 settlement response and payment-header namespace are closed", () => {
  const canonical = encodePaymentResponseHeader({
    success: true,
    network: "eip155:8453",
    transaction: `0x${"ab".repeat(32)}`,
    payer: WALLET.toLowerCase(),
  });
  assert.equal(decodeCanonicalPaymentResponse([["PAYMENT-RESPONSE", canonical]]).transaction, `0x${"ab".repeat(32)}`);
  const failure = encodePaymentResponseHeader({
    success: false,
    errorReason: "failed",
    network: "eip155:8453",
    transaction: `0x${"ab".repeat(32)}`,
  });
  assert.throws(() => decodeCanonicalPaymentResponse([["PAYMENT-RESPONSE", failure]]));
  const extension = Buffer.from(JSON.stringify({
    success: true,
    network: "eip155:8453",
    transaction: `0x${"ab".repeat(32)}`,
    extensions: {},
  }), "utf8").toString("base64");
  assert.throws(() => decodeCanonicalPaymentResponse([["PAYMENT-RESPONSE", extension]]));
  assert.throws(() => decodeCanonicalPaymentResponse([["PAYMENT-PROOF", "unknown"], ["PAYMENT-RESPONSE", canonical]]));
});

test("x402 payment signature must cryptographically bind stored EIP-3009 facts", async () => {
  const privateKey = `0x${"12".repeat(32)}` as const;
  const account = privateKeyToAccount(privateKey);
  const selected = selectCmcChallenge([["PAYMENT-REQUIRED", challenge().header]]);
  const facts = buildX402UsageFacts({ authorizer: account.address, nonce: `0x${"22".repeat(32)}`, validAfter: 1n, validBefore: 31n, challenge: selected });
  const signature = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: CMC_USDC },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { from: account.address, to: CMC_PAYEE, value: CMC_AMOUNT_ATOMIC, validAfter: 1n, validBefore: 31n, nonce: `0x${"22".repeat(32)}` },
  });
  const payment: PaymentPayload = {
    x402Version: 2,
    resource: selected.paymentRequired.resource,
    accepted: selected.requirement,
    payload: { signature, authorization: { from: account.address, to: CMC_PAYEE, value: "10000", validAfter: "1", validBefore: "31", nonce: `0x${"22".repeat(32)}` } },
  };
  const header = encodePaymentSignatureHeader(payment);
  await assert.doesNotReject(validateBoundPaymentSignature(header, selected, facts));
  await assert.rejects(validateBoundPaymentSignature(header, selected, { ...facts, amountAtomic: 10_001n }));
});

test("CMC adapter filters the unpaid challenge before one signature and one paid replay", async () => {
  const now = 100_000;
  const ticketKeys = edKeys();
  const issuerKeys = edKeys();
  const ticket = signedCmcTicket(ticketKeys, now);
  const assertion = signedCmcAssertion(issuerKeys, ticket, now);
  const payer = privateKeyToAccount(`0x${"12".repeat(32)}`);
  const grant: AgentBillingGrant = {
    grantId: ticket.grantId,
    generation: ticket.generation,
    accountId: ACCOUNT_ID,
    agentId: ticket.agentId,
    ownerAddress: OWNER,
    walletAddress: WALLET,
    issuerKeyId: "issuer-cmc-1",
    issuerPublicKey: issuerKeys.publicKey,
    operations: ["paid.cmc.quote"],
    templateIds: [CMC_TEMPLATE_ID],
    maxAtomic0gPerInference: 0n,
    maxUsdMicrosPerRequest: CMC_AMOUNT_ATOMIC,
    maxRolling24hUsdMicros: 1_000_000n,
    notBefore: now - 1,
    expiresAt: now + 600,
    status: "active",
    ownerConsentHash: HASH,
  };
  const store = new MemoryBillingStore();
  await store.createAccount({ ...account(), grantExpiresAt: now + 600 });
  await store.putGrant(grant);
  await store.putSessionTicket(ticket);

  let fetches = 0;
  let signatures = 0;
  let admissions = 0;
  let preSignChecks = 0;
  const result = await runCmcQuoteAttempt({
    store,
    assertion,
    ticket,
    grant,
    executionTicketKeyId: "ticket-key-1",
    executionTicketPublicKey: ticketKeys.publicKey,
    authorizer: payer.address,
    query: { id: "1" },
    now,
    providerExposureCapAtomic: 100_000n,
    platformPayerExposureCapAtomic: 100_000n,
    preAdmissionCheck: async (usage) => {
      admissions += 1;
      assert.equal(usage.state, "prepared");
    },
    preSignCheck: async (usage) => {
      preSignChecks += 1;
      assert.equal(usage.sourceFacts?.kind, "x402");
      assert.equal(usage.state, "prepared");
    },
    fetch: async (_url, init) => {
      fetches += 1;
      const headers = new Headers(init?.headers);
      if (fetches === 1) {
        assert.equal(headers.has("payment-signature"), false);
        return new Response("payment required", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge().header },
        });
      }
      assert.equal(fetches, 2);
      assert.ok(headers.get("payment-signature"));
      return new Response('{"ok":true}', { status: 200 });
    },
    signer: async ({ selected, facts }) => {
      signatures += 1;
      const signature = await payer.signTypedData({
        domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: CMC_USDC },
        types: { TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" },
          { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ] },
        primaryType: "TransferWithAuthorization",
        message: {
          from: payer.address,
          to: CMC_PAYEE,
          value: facts.amountAtomic,
          validAfter: facts.validAfter,
          validBefore: facts.validBefore,
          nonce: facts.authorizationNonce as Hex,
        },
      });
      return encodePaymentSignatureHeader({
        x402Version: 2,
        resource: selected.paymentRequired.resource,
        accepted: selected.requirement,
        payload: {
          signature,
          authorization: {
            from: payer.address,
            to: CMC_PAYEE,
            value: facts.amountAtomic.toString(),
            validAfter: facts.validAfter.toString(),
            validBefore: facts.validBefore.toString(),
            nonce: facts.authorizationNonce as Hex,
          },
        },
      });
    },
    reconcileSettlement: async ({ usage }) => {
      assert.equal(usage.state, "transmitting");
      return { kind: "actual", evidenceKind: "base_finalized", evidenceDigest: HASH };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.usage.state, "actual");
  assert.equal(result.usage.actualAtomic, CMC_AMOUNT_ATOMIC);
  assert.equal(new TextDecoder().decode(result.body), '{"ok":true}');
  assert.deepEqual({ fetches, signatures, admissions, preSignChecks }, {
    fetches: 2, signatures: 1, admissions: 1, preSignChecks: 1,
  });
});

test("CMC non-402 response releases the reservation without reaching the signer", async () => {
  const now = 100_000;
  const ticketKeys = edKeys();
  const issuerKeys = edKeys();
  const ticket = signedCmcTicket(ticketKeys, now);
  const assertion = signedCmcAssertion(issuerKeys, ticket, now);
  const payer = privateKeyToAccount(`0x${"12".repeat(32)}`);
  const grant: AgentBillingGrant = {
    grantId: ticket.grantId, generation: 1n, accountId: ACCOUNT_ID, agentId: "agent-1",
    ownerAddress: OWNER, walletAddress: WALLET, issuerKeyId: "issuer-cmc-1",
    issuerPublicKey: issuerKeys.publicKey, operations: ["paid.cmc.quote"],
    templateIds: [CMC_TEMPLATE_ID], maxAtomic0gPerInference: 0n,
    maxUsdMicrosPerRequest: CMC_AMOUNT_ATOMIC, maxRolling24hUsdMicros: 1_000_000n,
    notBefore: now - 1, expiresAt: now + 600, status: "active", ownerConsentHash: HASH,
  };
  const store = new MemoryBillingStore();
  await store.createAccount({ ...account(), grantExpiresAt: now + 600 });
  await store.putGrant(grant);
  await store.putSessionTicket(ticket);
  let signed = false;
  const result = await runCmcQuoteAttempt({
    store, assertion, ticket, grant, executionTicketKeyId: "ticket-key-1",
    executionTicketPublicKey: ticketKeys.publicKey, authorizer: payer.address,
    query: { id: "1" }, now, providerExposureCapAtomic: 100_000n,
    platformPayerExposureCapAtomic: 100_000n,
    preAdmissionCheck: async () => undefined,
    preSignCheck: async () => undefined,
    fetch: async () => new Response("upstream unavailable", { status: 503 }),
    signer: async () => { signed = true; throw new Error("must not sign"); },
    reconcileSettlement: async () => { throw new Error("must not reconcile"); },
  });
  assert.equal(result.status, 503);
  assert.equal(result.usage.state, "released");
  assert.equal(signed, false);
});

function account(): BillingAccount {
  return {
    accountId: ACCOUNT_ID, ownerAddress: OWNER, walletAddress: WALLET, status: "active",
    sessionFactsBytes: "facts", encryptedSessionKey: "ciphertext", maxDailyUsdMicros: 2_000_000n,
    maxUnpaidExposureUsdMicros: 2_000_000n, thresholdUsdMicros: 100_000n, grantExpiresAt: 2_000,
    createdAt: 1_000, updatedAt: 1_000,
  };
}

function actualCmcUsage(usageId: string, actualAtomic: bigint, now: number): Usage {
  return {
    usageId,
    assertionNonce: `nonce-${usageId}`,
    sessionTicketHash: HASH,
    accountId: ACCOUNT_ID,
    ownerAddress: OWNER,
    walletAddress: WALLET,
    agentId: "agent-1",
    grantId: "grant-cmc-1",
    generation: 1n,
    operation: "paid.cmc.quote",
    source: "x402",
    provider: "cmc",
    templateId: CMC_TEMPLATE_ID,
    logicalRequestId: `logical-${usageId}`,
    requestDigest: HASH,
    payerIdentity: "payer",
    state: "actual",
    version: 2n,
    asset: "USDC_BASE",
    reservedAtomic: actualAtomic,
    reservedUsdMicros: actualAtomic,
    actualAtomic,
    createdAt: now - 10,
    updatedAt: now - 1,
  };
}

test("Memory BillingStore preserves permanent wallet uniqueness and per-agent issuer isolation", async () => {
  const store = new MemoryBillingStore();
  await store.createAccount(account());
  await assert.rejects(store.createAccount({ ...account(), accountId: "other", ownerAddress: TREASURY }));
  await store.close();
});

test("PostgreSQL/FakeSql BillingStore persists encrypted account state and enforces wallet uniqueness", async () => {
  const sql = new FakeSqlClient();
  const first = await PostgresBillingStore.create(sql, Buffer.alloc(32, 1));
  await first.createAccount(account());
  const restarted = await PostgresBillingStore.create(sql, Buffer.alloc(32, 1));
  assert.equal((await restarted.getAccount(ACCOUNT_ID))?.encryptedSessionKey, "ciphertext");
  await assert.rejects(restarted.createAccount({ ...account(), accountId: "other", ownerAddress: TREASURY }));
  await restarted.close();
});

test("billing worker dry-run is read-only and cannot reach oracle, reconcile, signer, or submit seams", async () => {
  const sql = new FakeSqlClient();
  const writer = await PostgresBillingStore.create(sql, Buffer.alloc(32, 1));
  await writer.createAccount(account());
  const reader = PostgresBillingStore.openReadOnly(sql);
  sql.failNextQuery("billing.state.write");
  let externalCalls = 0;
  const unreachable = async (): Promise<never> => {
    externalCalls += 1;
    throw new Error("external seam reached");
  };
  const result = await runBillingWorkerOnce({
    store: reader,
    now: () => 1_100,
    bscRpcOrigins: ["https://bsc-a.example", "https://bsc-b.example"],
    arbitrumRpcOrigins: ["https://arb-a.example", "https://arb-b.example"],
    readOracleObservation: unreachable,
    reconcileOgUsage: unreachable,
    reconcileX402Usage: unreachable,
    reconcileInvoice: unreachable,
    submitInvoice: unreachable,
  }, true);
  assert.deepEqual(result, [{ accountId: ACCOUNT_ID, action: "none" }]);
  assert.equal(externalCalls, 0);
  await reader.close();
});

test("core billing transport refuses private and shared boot destinations", async () => {
  const config = resolveBillingConfig({
    BILLING_ENABLED: "on",
    BILLING_X402_ENABLED: "on",
    BILLING_0G_ENABLED: "off",
    BILLING_INTERNAL_HOST: "127.0.0.1",
    BILLING_INTERNAL_PORT: "8091",
    DATABASE_URL: "postgres://loopback.invalid/billing",
    EXECUTION_MASTER_KEY: "present",
    BILLING_COLLECTOR_ADDRESS: "0x0000000000000000000000000000000000000011",
    BILLING_COLLECTOR_RUNTIME_CODEHASH: `0x${"12".repeat(32)}`,
    BILLING_TREASURY_ADDRESS: "0x0000000000000000000000000000000000000012",
    BILLING_TICKET_KEY_ID: "ticket",
    BILLING_TICKET_PUBLIC_KEY: "public",
    BILLING_BSC_RPC_A: "https://bsc-a.example",
    BILLING_BSC_RPC_B: "https://bsc-b.example",
    BILLING_BASE_RPC_A: "https://base-a.example",
    BILLING_BASE_RPC_B: "https://base-b.example",
    BILLING_ARBITRUM_RPC_A: "https://arb-a.example",
    BILLING_ARBITRUM_RPC_B: "https://arb-b.example",
    BILLING_PLATFORM_BASE_USDC_CAP_ATOMIC: "10000",
    BILLING_PLATFORM_0G_CAP_NEURON: "1",
    BILLING_X402_PAYER_KEY_ID: "x402",
    BILLING_X402_AUTHORIZER: OWNER,
  });
  assert.equal(config.mode, "on");
  let next = 10;
  const pins = await resolveBillingDestinationPins(config, async () => [
    { address: `8.8.8.${next++}`, family: 4 as const },
  ]);
  assert.equal(pins.length, 7);
  await assert.rejects(resolveBillingDestinationPins(config, async () => [
    { address: "10.0.0.1", family: 4 as const },
  ]), /private|reserved/i);
  await assert.rejects(resolveBillingDestinationPins(config, async () => [
    { address: "8.8.4.4", family: 4 as const },
  ]), /shared/i);
});

test("billing worker persists a rotating account cursor and bounds each pass", async () => {
  const accounts = Array.from({ length: 70 }, (_unused, index) => {
    const accountId = `account-${String(index).padStart(3, "0")}`;
    const row: BillingAccount = {
      ...account(),
      accountId,
      walletAddress: `0x${String(index + 10).padStart(40, "0")}`,
      createdAt: 1_000 + index,
      updatedAt: 1_000 + index,
    };
    return [accountId, row] as const;
  });
  const initial = new MemoryBillingStore({
    accounts,
    walletAccounts: [], grants: [], tickets: [], replays: [], logical: [], usages: [],
    debitIdentities: [], leases: [], invoices: [], nonterminalInvoiceByUsage: [], ledger: [],
    ogReconciliations: [],
  });
  const first = await initial.claimBillingWorkerAccountBatch(64);
  assert.equal(first.length, 64);
  assert.equal(first[0]?.accountId, "account-000");
  assert.equal(first.at(-1)?.accountId, "account-063");
  const restarted = new MemoryBillingStore(initial.dump());
  const second = await restarted.claimBillingWorkerAccountBatch(64);
  assert.equal(second.length, 6);
  assert.equal(second[0]?.accountId, "account-064");
  assert.equal(second.at(-1)?.accountId, "account-069");
  const wrapped = await restarted.claimBillingWorkerAccountBatch(64);
  assert.equal(wrapped.length, 64);
  assert.equal(wrapped[0]?.accountId, "account-000");
});

test("core x402 reconciler releases only two-RPC positive finalized absence", async () => {
  const now = 100_000;
  const facts = {
    kind: "x402" as const,
    registryVersion: "x402-v1-2026-08-26" as const,
    chainId: 8453 as const,
    usdcAddress: CMC_USDC,
    authorizer: OWNER,
    authorizationNonce: `0x${"ab".repeat(32)}`,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now - 30),
    payee: CMC_PAYEE,
    amountAtomic: CMC_AMOUNT_ATOMIC,
    challengeDigest: HASH,
  };
  const actualSeed = actualCmcUsage("usage-x402-absence", CMC_AMOUNT_ATOMIC, now);
  const { actualAtomic, ...unbilledSeed } = actualSeed;
  assert.equal(actualAtomic, CMC_AMOUNT_ATOMIC);
  const unknown: Usage = {
    ...unbilledSeed,
    state: "unknown",
    version: 3n,
    sourceFacts: facts,
    evidenceKind: "cmc_paid_transport_unknown",
    evidenceDigest: HASH,
  };
  const store = new MemoryBillingStore({
    accounts: [], walletAccounts: [], grants: [], tickets: [], replays: [], logical: [],
    usages: [[unknown.usageId, unknown]], debitIdentities: [], leases: [], invoices: [],
    nonterminalInvoiceByUsage: [], ledger: [], ogReconciliations: [],
  });
  const origins = ["https://base-a.example", "https://base-b.example"] as const;
  const transport = {
    async readX402AuthorizationObservation(origin: string) {
      assert.ok(origins.includes(origin as typeof origins[number]));
      return {
        chainId: 8453 as const,
        finalizedBlock: 123n,
        finalizedBlockHash: `0x${"cd".repeat(32)}` as Hex,
        finalizedTimestamp: BigInt(now),
        authorizationUsed: false,
      };
    },
    readReceiptObservation: async () => { throw new Error("absence must not read a receipt"); },
  } as unknown as PinnedBillingTransport;
  const released = await reconcileX402UsageFromBase(origins, store, transport, unknown, now);
  assert.equal(released?.state, "released");
  assert.equal(released?.evidenceKind, "base_x402_authorization_unused");
});

test("billing worker reclaims leases, expires quotes, and reconciles x402 unknowns before new work", async () => {
  const quotedAt = 100_000;
  const now = quotedAt + 61;
  const bnb = validateOraclePair("BNB_USD", observation("BNB_USD", quotedAt), observation("BNB_USD", quotedAt), quotedAt);
  const quoted = buildQuotedInvoice({
    accountId: ACCOUNT_ID,
    usageIds: ["usage-quoted"],
    baseUsdcAtomic: 100_000n,
    ogNeuron: 0n,
    bnbOracle: bnb,
    quoteTimestamp: quotedAt,
    attempt: 1n,
  });
  const claimed: Usage = {
    ...actualCmcUsage("usage-quoted", 100_000n, quotedAt),
    state: "claimed",
    invoiceId: quoted.invoiceId,
  };
  const unknown: Usage = {
    ...actualCmcUsage("usage-unknown", 10_000n, quotedAt),
    state: "unknown",
    evidenceKind: "settlement_pending",
    evidenceDigest: HASH,
  };
  const prepared: Usage = {
    ...actualCmcUsage("usage-prepared", 10_000n, quotedAt),
    state: "prepared",
    version: 0n,
  };
  const pausedAccount: BillingAccount = {
    ...account(),
    status: "paused",
    grantExpiresAt: now + 1_000,
    createdAt: quotedAt - 100,
    updatedAt: quotedAt,
  };
  const store = new MemoryBillingStore({
    accounts: [[ACCOUNT_ID, pausedAccount]], walletAccounts: [[WALLET.toLowerCase(), ACCOUNT_ID]],
    grants: [], tickets: [], replays: [], logical: [],
    usages: [[claimed.usageId, claimed], [unknown.usageId, unknown], [prepared.usageId, prepared]],
    debitIdentities: [], leases: [[ACCOUNT_ID, { usageId: prepared.usageId, token: "lease", expiresAt: quotedAt, contacted: false }]],
    invoices: [[quoted.invoiceId, quoted]], nonterminalInvoiceByUsage: [[claimed.usageId, quoted.invoiceId]],
    ledger: [], ogReconciliations: [],
  });
  let x402Reconciliations = 0;
  const unreachable = async (): Promise<never> => { throw new Error("external seam reached"); };
  await runBillingWorkerOnce({
    store,
    now: () => now,
    bscRpcOrigins: ["https://bsc-a.example", "https://bsc-b.example"],
    arbitrumRpcOrigins: ["https://arb-a.example", "https://arb-b.example"],
    readOracleObservation: unreachable,
    reconcileOgUsage: unreachable,
    reconcileX402Usage: async (usage) => {
      x402Reconciliations += 1;
      return store.reconcileUnknown(usage.usageId, usage.version, {
        evidenceKind: "x402_authorization_unused",
        evidenceDigest: HASH,
        now,
      });
    },
    reconcileInvoice: unreachable,
    submitInvoice: unreachable,
  }, false);
  assert.equal(x402Reconciliations, 1);
  assert.equal((await store.getUsage(prepared.usageId))?.state, "released");
  assert.equal((await store.getInvoice(quoted.invoiceId))?.state, "expired");
  assert.equal((await store.getUsage(claimed.usageId))?.state, "actual");
  assert.equal((await store.getUsage(unknown.usageId))?.state, "released");
});

test("billing worker rejects a fabricated same-origin oracle pair before invoice admission", async () => {
  const now = 100_000;
  const usage = actualCmcUsage("usage-oracle-origin", 100_000n, now);
  const billingAccount = { ...account(), grantExpiresAt: now + 1_000, createdAt: now - 100, updatedAt: now - 100 };
  const store = new MemoryBillingStore({
    accounts: [[ACCOUNT_ID, billingAccount]], walletAccounts: [[WALLET.toLowerCase(), ACCOUNT_ID]],
    grants: [], tickets: [], replays: [], logical: [], usages: [[usage.usageId, usage]],
    debitIdentities: [], leases: [], invoices: [], nonterminalInvoiceByUsage: [], ledger: [], ogReconciliations: [],
  });
  const raw = observation("BNB_USD", now);
  const unreachable = async (): Promise<never> => { throw new Error("oracle rejection must precede this seam"); };
  await assert.rejects(runBillingWorkerOnce({
    store,
    now: () => now,
    bscRpcOrigins: ["https://rpc.example", "https://rpc.example"],
    arbitrumRpcOrigins: ["https://arb-a.example", "https://arb-b.example"],
    readOracleObservation: async () => raw,
    reconcileOgUsage: unreachable,
    reconcileX402Usage: unreachable,
    reconcileInvoice: unreachable,
    submitInvoice: unreachable,
  }, false), /ORACLE_UNAVAILABLE/);
  assert.equal((await store.listInvoices(ACCOUNT_ID)).length, 0);
});

test("Memory BillingStore joins exact logical retries and fences conflicting request digests", async () => {
  const store = new MemoryBillingStore();
  const ticketKeys = edKeys();
  const issuerKeys = edKeys();
  const now = 100_000;
  const ticket = signedTicket(ticketKeys, now);
  const assertion = signedAssertion(issuerKeys, ticket, now);
  const grant: AgentBillingGrant = {
    grantId: "grant-1", generation: 1n, accountId: ACCOUNT_ID, agentId: "agent-1", ownerAddress: OWNER,
    walletAddress: WALLET, issuerKeyId: "issuer-1", issuerPublicKey: issuerKeys.publicKey,
    operations: ["paid.0g.chat"], templateIds: ["0g.chat.v1"], maxAtomic0gPerInference: 10n ** 30n,
    maxUsdMicrosPerRequest: 1_000_000n, maxRolling24hUsdMicros: 2_000_000n, maxTokensPerInference: 32,
    notBefore: now - 100, expiresAt: now + 900, status: "active", ownerConsentHash: HASH,
  };
  await store.createAccount({ ...account(), grantExpiresAt: now + 1_000 });
  await store.putGrant(grant);
  await store.putSessionTicket(ticket);
  const sourceFacts: OgUsageFacts = {
    kind: "0g", manifestVersion: "v", routerPayerAccountId: "payer", routerApiKeyId: "key-old",
    rawModelId: "0gm-1.0-35b-a3b", canonicalModelId: "0gm-1.0-35b-a3b", providerAddress: OWNER,
    reviewedProviderIdentity: null, providerIdentityRule: "match-if-present", reviewedContextLength: 262_144n,
    reviewedMaxCompletionTokens: 32_768n, requestedMaxTokens: 8n, requestBodyBytes: 10n,
    inputReserveNeuronPerToken: 1n, completionReserveNeuronPerToken: 1n, liveModelObservationDigest: HASH,
  };
  const input = {
    assertion, assertionDigest: HASH, ticket, grant, source: "0g" as const, provider: "0g-router" as const,
    asset: "0G_MAINNET" as const, payerIdentity: "payer", reservedAtomic: 100n, reservedUsdMicros: 1n,
    providerExposureCapAtomic: 10_000n, platformPayerExposureCapAtomic: 10_000n,
    sourceFacts, now: now + 1,
    ogOracle: validateOraclePair("0G_USD", observation("0G_USD", now), observation("0G_USD", now), now),
    arbitrumSequencer: validateOraclePair("ARBITRUM_SEQUENCER", observation("ARBITRUM_SEQUENCER", now), observation("ARBITRUM_SEQUENCER", now), now),
  };
  const first = await store.reservePaidUsage(input);
  const retry = await store.reservePaidUsage({ ...input, assertion: { ...assertion, nonce: Buffer.alloc(16, 8).toString("base64url") }, assertionDigest: `${HASH}a` });
  assert.equal(retry.joined, true);
  assert.equal(retry.usage.usageId, first.usage.usageId);
  await assert.rejects(store.reservePaidUsage({ ...input, assertion: { ...assertion, nonce: Buffer.alloc(16, 9).toString("base64url"), requestDigest: `0x${"99".repeat(32)}` }, assertionDigest: `${HASH}b` }), /IDEMPOTENCY_CONFLICT/);
  await store.close();
});

test("0G history accepts exact 0g neuron rows, additive components, and old API-key ID", () => {
  const page = parseOgHistoryPage({ currency: "0g", data: [{
    id: "1", request_id: "req-1", api_key_id: "key-old", model_id: "m", canonical_id: "m",
    provider_address: OWNER, input_tokens: "10", output_tokens: "2", cached_tokens: "1",
    cache_write_tokens: "2", cache_write_1h_tokens: "3", cost: "7", credit_used: "2", deposit_used: "5",
    completed_at: 1_100,
  }] });
  assert.equal(page.rows[0]?.totalCostNeuron, 7n);
  assert.throws(() => parseOgHistoryPage({ currency: "usd", data: [] }));
  assert.throws(() => parseOgHistoryPage({ currency: "0g", data: [{ id: "1.0" }] }));
});

test("matching 0G history trusts authoritative cost but enforces identity and reservation", () => {
  const sourceFacts: OgUsageFacts = {
    kind: "0g", manifestVersion: "v", routerPayerAccountId: "payer", routerApiKeyId: "key-old", rawModelId: "m",
    canonicalModelId: "m", providerAddress: OWNER, reviewedProviderIdentity: null, providerIdentityRule: "match-if-present",
    reviewedContextLength: 100n, reviewedMaxCompletionTokens: 10n, requestedMaxTokens: 10n, requestBodyBytes: 10n,
    inputReserveNeuronPerToken: 1n, completionReserveNeuronPerToken: 1n, liveModelObservationDigest: HASH,
  };
  const usage = {
    usageId: "u", assertionNonce: "n", sessionTicketHash: HASH, accountId: "a", ownerAddress: OWNER,
    walletAddress: WALLET, agentId: "agent", grantId: "g", generation: 1n, operation: "paid.0g.chat" as const,
    source: "0g" as const, provider: "0g-router" as const, templateId: "0g.chat.v1", logicalRequestId: "l",
    requestDigest: HASH, externalRequestId: "req", payerIdentity: "payer", state: "unknown" as const, version: 1n,
    asset: "0G_MAINNET" as const, reservedAtomic: 100n, reservedUsdMicros: 1n, sourceFacts,
    createdAt: 1, updatedAt: 1,
  };
  const row = {
    historyId: 1n, routerRequestId: "req", apiKeyId: "key-old", modelId: "m", canonicalId: "m",
    providerAddress: OWNER, inputTokens: 10n, outputTokens: 2n, cachedTokens: 1n, cacheWriteTokens: 2n,
    cacheWrite1hTokens: 3n, totalCostNeuron: 7n, creditUsedNeuron: 2n, depositUsedNeuron: 5n, completedAt: 2,
  };
  assert.equal(matchOgHistory(usage, [row])?.totalCostNeuron, 7n);
  assert.throws(() => matchOgHistory(usage, [{ ...row, apiKeyId: "new-key" }]));
  assert.throws(() => matchOgHistory(usage, [{ ...row, totalCostNeuron: 101n, creditUsedNeuron: 96n }]));
});

test("0G reconciler resumes beyond 1,000 history rows and charges exact authoritative cost", async () => {
  const store = new MemoryBillingStore();
  const ticketKeys = edKeys();
  const issuerKeys = edKeys();
  const now = 100_000;
  const ticket = signedTicket(ticketKeys, now);
  const assertion = signedAssertion(issuerKeys, ticket, now);
  const grant: AgentBillingGrant = {
    grantId: "grant-1", generation: 1n, accountId: ACCOUNT_ID, agentId: "agent-1", ownerAddress: OWNER,
    walletAddress: WALLET, issuerKeyId: "issuer-1", issuerPublicKey: issuerKeys.publicKey,
    operations: ["paid.0g.chat"], templateIds: ["0g.chat.v1"], maxAtomic0gPerInference: 1_000n,
    maxUsdMicrosPerRequest: 1_000_000n, maxRolling24hUsdMicros: 2_000_000n, maxTokensPerInference: 32,
    notBefore: now - 100, expiresAt: now + 900, status: "active", ownerConsentHash: HASH,
  };
  const sourceFacts: OgUsageFacts = {
    kind: "0g", manifestVersion: "v", routerPayerAccountId: "payer", routerApiKeyId: "key-old",
    rawModelId: "m", canonicalModelId: "m", providerAddress: OWNER, reviewedProviderIdentity: null,
    providerIdentityRule: "match-if-present", reviewedContextLength: 100n, reviewedMaxCompletionTokens: 10n,
    requestedMaxTokens: 8n, requestBodyBytes: 10n, inputReserveNeuronPerToken: 1n,
    completionReserveNeuronPerToken: 1n, liveModelObservationDigest: HASH,
  };
  await store.createAccount({ ...account(), grantExpiresAt: now + 1_000 });
  await store.putGrant(grant);
  await store.putSessionTicket(ticket);
  const prepared = await store.reservePaidUsage({
    assertion, assertionDigest: HASH, ticket, grant, source: "0g", provider: "0g-router",
    asset: "0G_MAINNET", payerIdentity: "payer", reservedAtomic: 100n, reservedUsdMicros: 1n,
    providerExposureCapAtomic: 10_000n, platformPayerExposureCapAtomic: 10_000n,
    sourceFacts, now: now + 1,
    ogOracle: validateOraclePair("0G_USD", observation("0G_USD", now), observation("0G_USD", now), now),
    arbitrumSequencer: validateOraclePair("ARBITRUM_SEQUENCER", observation("ARBITRUM_SEQUENCER", now), observation("ARBITRUM_SEQUENCER", now), now),
  });
  const transmitting = await store.markUpstreamContact(prepared.usage.usageId, prepared.leaseToken, prepared.usage.version, now + 2);
  const bound = await store.bindExternalRequestId(transmitting.usageId, prepared.leaseToken, transmitting.version, "req-1", now + 3);
  await store.markUnknown(bound.usageId, prepared.leaseToken, "history_pending", HASH, now + 4);

  const urls: string[] = [];
  let page = 0;
  const fetch = async (raw: string | URL | Request, init?: RequestInit): Promise<Response> => {
    urls.push(String(raw));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer management-secret");
    page += 1;
    const data = page <= 10
      ? Array.from({ length: 100 }, (_value, index) => ({
          id: String((page - 1) * 100 + index + 1), request_id: `other-${page}-${index}`,
          api_key_id: "key-old", model_id: "m", canonical_id: "m", provider_address: OWNER,
          input_tokens: "1", output_tokens: "1", cached_tokens: "0", cache_write_tokens: "0",
          cache_write_1h_tokens: "0", cost: "1", credit_used: "0", deposit_used: "1", completed_at: now + 5,
        }))
      : [{
          id: "1001", request_id: "req-1", api_key_id: "key-old", model_id: "m", canonical_id: "m",
          provider_address: OWNER, input_tokens: "10", output_tokens: "2", cached_tokens: "1",
          cache_write_tokens: "2", cache_write_1h_tokens: "3", cost: "7", credit_used: "2",
          deposit_used: "5", completed_at: now + 5,
        }];
    return new Response(JSON.stringify({ currency: "0g", data, ...(page <= 10 ? { next_cursor: `page-${page}` } : {}) }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const firstRun = await reconcileOgUsageFromHistory({
    store, fetch, credential: { bearerToken: "management-secret" }, usageId: bound.usageId, now: now + 10,
  });
  assert.equal(firstRun, null);
  assert.equal((await store.getOgReconciliation(bound.usageId))?.seenHistoryIds.length, 1_000);
  const reconciled = await reconcileOgUsageFromHistory({
    store, fetch, credential: { bearerToken: "management-secret" }, usageId: bound.usageId, now: now + 50,
  });
  assert.equal(reconciled?.state, "actual");
  assert.equal(reconciled?.actualAtomic, 7n);
  assert.equal(urls.length, 11);
  const first = new URL(urls[0]!);
  const resumed = new URL(urls[10]!);
  assert.equal(first.searchParams.get("limit"), "100");
  assert.equal(first.searchParams.get("include_total"), "false");
  assert.equal(first.searchParams.get("api_key_id"), "key-old");
  assert.equal(first.searchParams.get("source"), "api_key");
  assert.equal(first.searchParams.has("model_id"), false);
  assert.equal(resumed.searchParams.get("cursor"), "page-10");
});

test("0G reconciliation cursor refuses an unbounded continuing scan generation", async () => {
  const store = new MemoryBillingStore();
  const seenHistoryIds = Array.from({ length: 10_000 }, (_value, index) => String(index + 1));
  await assert.rejects(store.putOgReconciliation({
    usageId: "usage-cap",
    version: 0n,
    nextCursor: "page-100",
    seenHistoryIds,
    scanGeneration: 0n,
    attemptCount: 1n,
    nextRunAt: 1,
    updatedAt: 1,
  }, null));
  await assert.rejects(store.putOgReconciliation({
    usageId: "usage-cap",
    version: 0n,
    seenHistoryIds,
    scanGeneration: 0n,
    attemptCount: 1n,
    nextRunAt: 1,
    updatedAt: 1,
  }, null));
  const terminal = await store.putOgReconciliation({
    usageId: "usage-cap",
    version: 0n,
    seenHistoryIds: [],
    scanGeneration: 1n,
    attemptCount: 1n,
    nextRunAt: 1,
    updatedAt: 1,
  }, null);
  assert.equal(terminal.seenHistoryIds.length, 0);
});

test("quoted invoice identity binds oracle evidence and expires at exactly +60", () => {
  const now = 100_000;
  const bnb = validateOraclePair("BNB_USD", observation("BNB_USD", now), observation("BNB_USD", now), now);
  const invoice = buildQuotedInvoice({ accountId: "a", usageIds: ["u"], baseUsdcAtomic: 100_000n, ogNeuron: 0n, bnbOracle: bnb, quoteTimestamp: now, attempt: 1n });
  assert.equal(invoice.quoteExpiresAt, now + 60);
  assert.equal(invoice.state, "quoted");
});

test("invoice claim recomputes canonical totals and oracle predicates from actual members", async () => {
  const now = 100_000;
  const usage = actualCmcUsage("usage-claim-1", 100_000n, now);
  const billingAccount = { ...account(), grantExpiresAt: now + 1_000, createdAt: now - 100, updatedAt: now - 100 };
  const store = new MemoryBillingStore({
    accounts: [[ACCOUNT_ID, billingAccount]], walletAccounts: [[WALLET.toLowerCase(), ACCOUNT_ID]],
    grants: [], tickets: [], replays: [], logical: [], usages: [[usage.usageId, usage]],
    debitIdentities: [], leases: [], invoices: [], nonterminalInvoiceByUsage: [], ledger: [], ogReconciliations: [],
  });
  const bnb = validateOraclePair("BNB_USD", observation("BNB_USD", now), observation("BNB_USD", now), now);
  const forgedTotal = buildQuotedInvoice({
    accountId: ACCOUNT_ID, usageIds: [usage.usageId], baseUsdcAtomic: 200_000n,
    ogNeuron: 0n, bnbOracle: bnb, quoteTimestamp: now, attempt: 1n,
  });
  await assert.rejects(store.claimInvoice(forgedTotal), /actual members/);
  const malformedOracle = buildQuotedInvoice({
    accountId: ACCOUNT_ID, usageIds: [usage.usageId], baseUsdcAtomic: 100_000n,
    ogNeuron: 0n, bnbOracle: { ...bnb, proxy: OWNER }, quoteTimestamp: now, attempt: 1n,
  });
  await assert.rejects(store.claimInvoice(malformedOracle), /ORACLE_UNAVAILABLE/);
  const canonical = buildQuotedInvoice({
    accountId: ACCOUNT_ID, usageIds: [usage.usageId], baseUsdcAtomic: 100_000n,
    ogNeuron: 0n, bnbOracle: bnb, quoteTimestamp: now, attempt: 1n,
  });
  assert.equal((await store.claimInvoice(canonical)).invoiceId, canonical.invoiceId);
});

test("account close owns one all-usage flush claim until expiry safely releases it", async () => {
  const now = 100_000;
  const firstUsage = actualCmcUsage("usage-close-a", 60_000n, now);
  const secondUsage = actualCmcUsage("usage-close-b", 40_000n, now);
  const billingAccount = { ...account(), grantExpiresAt: now + 1_000, createdAt: now - 100, updatedAt: now - 100 };
  const store = new MemoryBillingStore({
    accounts: [[ACCOUNT_ID, billingAccount]], walletAccounts: [[WALLET.toLowerCase(), ACCOUNT_ID]],
    grants: [], tickets: [], replays: [], logical: [],
    usages: [[firstUsage.usageId, firstUsage], [secondUsage.usageId, secondUsage]],
    debitIdentities: [], leases: [], invoices: [], nonterminalInvoiceByUsage: [], ledger: [], ogReconciliations: [],
  });
  await store.beginAccountClose(ACCOUNT_ID, "close-1", now);
  const bnb = validateOraclePair("BNB_USD", observation("BNB_USD", now), observation("BNB_USD", now), now);
  const usageIds = [firstUsage.usageId, secondUsage.usageId].sort();
  const first = buildQuotedInvoice({
    accountId: ACCOUNT_ID, usageIds, baseUsdcAtomic: 100_000n, ogNeuron: 0n,
    bnbOracle: bnb, quoteTimestamp: now, attempt: 1n,
  });
  const second = buildQuotedInvoice({
    accountId: ACCOUNT_ID, usageIds, baseUsdcAtomic: 100_000n, ogNeuron: 0n,
    bnbOracle: bnb, quoteTimestamp: now, attempt: 2n,
  });
  await store.claimInvoice(first);
  assert.equal((await store.getAccount(ACCOUNT_ID))?.closeFlushInvoiceId, first.invoiceId);
  await assert.rejects(store.claimInvoice(second));
  await store.expireQuotedInvoice(first.invoiceId, first.version, first.quoteExpiresAt + 1);
  assert.equal((await store.getAccount(ACCOUNT_ID))?.closeFlushInvoiceId, undefined);
  assert.equal((await store.claimInvoice(second)).invoiceId, second.invoiceId);
});

test("collection store-only callsId survives a journal bind fault and restart repairs the journal", async () => {
  const now = 100_000;
  const usage = actualCmcUsage("usage-calls-id", 100_000n, now);
  const billingAccount = { ...account(), grantExpiresAt: now + 1_000, createdAt: now - 100, updatedAt: now - 100 };
  const backing = new MemoryBillingStore({
    accounts: [[ACCOUNT_ID, billingAccount]], walletAccounts: [[WALLET.toLowerCase(), ACCOUNT_ID]],
    grants: [], tickets: [], replays: [], logical: [], usages: [[usage.usageId, usage]],
    debitIdentities: [], leases: [], invoices: [], nonterminalInvoiceByUsage: [], ledger: [], ogReconciliations: [],
  });
  const bnb = validateOraclePair("BNB_USD", observation("BNB_USD", now), observation("BNB_USD", now), now);
  const quoted = await backing.claimInvoice(buildQuotedInvoice({
    accountId: ACCOUNT_ID, usageIds: [usage.usageId], baseUsdcAtomic: 100_000n,
    ogNeuron: 0n, bnbOracle: bnb, quoteTimestamp: now, attempt: 1n,
  }));
  const journalBacking = new MemoryExecutionJournal(() => now * 1_000);
  const journal = new Proxy(journalBacking, {
    get(target, property) {
      if (property === "bindBillingCollectCallsId") return async () => { throw new Error("simulated journal bind outage"); };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof journalBacking;
  const callsId = `0x${"77".repeat(32)}` as Hex;
  const preparedDigest = `0x${"88".repeat(32)}` as Hex;
  const result = await submitBillingInvoice({
    store: backing,
    journal,
    relay: {
      prepare: async (request) => ({
        handle: {},
        digest: preparedDigest,
        chainId: 56,
        wallet: request.wallet,
        collector: request.collector,
        calldata: request.calldata,
        value: request.value,
        sessionGeneration: request.sessionGeneration,
        relayQuoteExpiresAt: now + 50,
        relayIntentExpiresAt: now + 40,
      }),
      signAndSend: async () => ({ callsId }),
    },
    meter: async () => ({ balanceWei: 10n ** 18n, remainingDayCapWei: 10n ** 18n }),
    invoice: quoted,
    wallet: WALLET,
    collector: COLLECTOR,
    ownerAddress: OWNER,
    sessionGeneration: 1n,
    now: () => now + 1,
  });
  assert.equal(result.state, "unknown");
  assert.equal(result.preparedChainId, 56);
  assert.equal(result.preparedWallet, WALLET.toLowerCase());
  assert.equal(result.preparedCollector, COLLECTOR.toLowerCase());
  assert.equal(result.preparedValueWei, quoted.bnbWei);
  assert.equal(result.preparedSessionGeneration, 1n);
  assert.equal(result.callsId, callsId);
  const decisionId = billingCollectionDecisionId(ACCOUNT_ID, quoted.invoiceId, quoted.attempt);
  assert.equal((await journalBacking.get(decisionId))?.externalRef.callsId, undefined);
  const recovered = await recoverBillingInvoiceCallsId({
    store: backing,
    journal: journalBacking,
    account: billingAccount,
    invoice: result,
    now: now + 2,
  });
  assert.equal(recovered.callsId, callsId);
  assert.equal((await journalBacking.get(decisionId))?.externalRef.callsId, callsId);
});

test("canonical collection proof invoices exact members and advances the account-principal journal", async () => {
  const now = 100_000;
  const bnb = validateOraclePair("BNB_USD", observation("BNB_USD", now), observation("BNB_USD", now), now);
  const quoted = buildQuotedInvoice({
    accountId: ACCOUNT_ID, usageIds: ["usage-1"], baseUsdcAtomic: 100_000n,
    ogNeuron: 0n, bnbOracle: bnb, quoteTimestamp: now, attempt: 1n,
  });
  const decisionId = billingCollectionDecisionId(quoted.accountId, quoted.invoiceId, quoted.attempt);
  const callsId = `0x${"22".repeat(32)}` as Hex;
  const transactionHash = `0x${"33".repeat(32)}` as Hex;
  const blockHash = `0x${"44".repeat(32)}` as Hex;
  const preparedDigest = `0x${"55".repeat(32)}` as Hex;
  const invoice = {
    ...quoted, state: "submitting" as const, version: 1n, journalDecisionId: decisionId,
    preparedIntentDigest: preparedDigest, relayQuoteExpiresAt: now + 50,
    relayIntentExpiresAt: now + 40, callsId,
  };
  const usage: Usage = {
    usageId: "usage-1", assertionNonce: "nonce", sessionTicketHash: HASH,
    accountId: ACCOUNT_ID, ownerAddress: OWNER, walletAddress: WALLET,
    agentId: "agent-1", grantId: "grant-1", generation: 1n, operation: "paid.cmc.quote",
    source: "x402", provider: "cmc", templateId: "cmc.quote.latest.v1", logicalRequestId: "logical",
    requestDigest: HASH, payerIdentity: "payer", state: "claimed", version: 2n,
    asset: "USDC_BASE", reservedAtomic: 100_000n, reservedUsdMicros: 100_000n,
    actualAtomic: 100_000n, invoiceId: invoice.invoiceId, createdAt: now - 10, updatedAt: now,
  };
  const store = new MemoryBillingStore({
    accounts: [], walletAccounts: [], grants: [], tickets: [], replays: [], logical: [],
    usages: [[usage.usageId, usage]], debitIdentities: [], leases: [],
    invoices: [[invoice.invoiceId, invoice]], nonterminalInvoiceByUsage: [[usage.usageId, invoice.invoiceId]],
    ledger: [], ogReconciliations: [],
  });
  const journal = new MemoryExecutionJournal(() => (now + 1) * 1_000);
  const binding = {
    billingPrincipal: { kind: "billing_account" as const, id: invoice.accountId },
    billingInvoice: {
      invoiceId: invoice.invoiceId, preparedDigest, wallet: WALLET.toLowerCase(),
      collector: COLLECTOR.toLowerCase(), valueWei: invoice.bnbWei.toString(),
      quoteExpiresAt: invoice.quoteExpiresAt, sessionGeneration: "1",
    },
  };
  await journal.begin({
    idempotencyKey: decisionId, agentId: invoice.accountId, ownerAddress: OWNER,
    kind: "billingCollect", principal: binding.billingPrincipal, decisionId,
    externalRef: binding, nativeSpendWei: invoice.bnbWei,
  });
  await journal.markInProgress(decisionId, { ...binding, callsId });

  const runtimeCode = "0x60006000" as Hex;
  const receipt = {
    transactionHash, blockNumber: 190n, blockHash, status: 1 as const,
    logs: [{
      address: COLLECTOR,
      topics: encodeEventTopics({
        abi: BILLING_COLLECTOR_ABI, eventName: "InvoicePaid",
        args: { invoiceId: invoice.invoiceId as Hex, payer: WALLET },
      }).filter((topic): topic is Hex => typeof topic === "string"),
      data: encodeAbiParameters([{ type: "uint256" }], [invoice.bnbWei]),
    }],
  };
  const rpc = {
    chainId: 56n, finalizedBlock: 200n, finalizedBlockHash: `0x${"66".repeat(32)}` as Hex,
    receiptBlockTimestamp: now + 40, receipt,
    transaction: {
      hash: transactionHash, from: WALLET, to: COLLECTOR,
      input: billingCollectorCalldata(invoice.invoiceId as Hex, invoice.quoteExpiresAt), value: invoice.bnbWei,
    },
    runtimeCode,
  };
  const projected = await projectBillingCollectionProof({
    store, journal, invoiceId: invoice.invoiceId as Hex, wallet: WALLET, collector: COLLECTOR,
    reviewedRuntimeBytecodeHash: keccak256(runtimeCode), callsId, rpcA: rpc, rpcB: structuredClone(rpc),
    now: now + 50,
  });
  assert.equal(projected.state, "paid");
  assert.equal((await store.listLedger(invoice.accountId))[0]?.usdMicros, invoice.usdMicros);
  assert.equal((await store.listLedger(invoice.accountId))[0]?.paidAt, now + 40);
  assert.equal((await journal.get(decisionId))?.state, "COMMITTED");
  await assert.doesNotReject(projectBillingCollectionProof({
    store, journal, invoiceId: invoice.invoiceId as Hex, wallet: WALLET, collector: COLLECTOR,
    reviewedRuntimeBytecodeHash: keccak256(runtimeCode), callsId, rpcA: rpc, rpcB: structuredClone(rpc),
    now: now + 51,
  }));
});

test("billing collection journal rows require and retain the exact account principal", async () => {
  const journal = new MemoryExecutionJournal(() => 1_000_000);
  await assert.rejects(journal.begin({
    idempotencyKey: "missing-principal",
    agentId: ACCOUNT_ID,
    ownerAddress: OWNER,
    kind: "billingCollect",
    decisionId: "billing:1",
  }));
  const entry = await journal.begin({
    idempotencyKey: "billing-row",
    agentId: ACCOUNT_ID,
    ownerAddress: OWNER,
    kind: "billingCollect",
    principal: { kind: "billing_account", id: ACCOUNT_ID },
    decisionId: "billing:1",
    externalRef: {
      billingPrincipal: { kind: "billing_account", id: ACCOUNT_ID },
      billingInvoice: {
        invoiceId: HASH,
        preparedDigest: HASH,
        wallet: WALLET,
        collector: COLLECTOR,
        valueWei: "1000",
        quoteExpiresAt: 1_100,
        sessionGeneration: "1",
      },
    },
    nativeSpendWei: 1_000n,
  });
  assert.deepEqual(entry.principal, { kind: "billing_account", id: ACCOUNT_ID });
  assert.deepEqual(entry.externalRef.billingPrincipal, entry.principal);
  await assert.rejects(journal.markInProgress("billing-row", {
    billingInvoice: { ...entry.externalRef.billingInvoice!, valueWei: "1001" },
  }), /immutable/);
});

test("billing collection journal callsId CAS has Memory/PostgreSQL replay and conflict parity", async () => {
  const callsId = `0x${"ab".repeat(32)}` as Hex;
  const otherCallsId = `0x${"cd".repeat(32)}` as Hex;
  const witnessDigest = `0x${"ef".repeat(32)}` as Hex;
  for (const journal of [
    new MemoryExecutionJournal(() => 1_000_000),
    await PostgresExecutionJournal.create(new FakeSqlClient(), () => 1_000_000),
  ]) {
    const decisionId = `billing:${"12".repeat(32)}`;
    await journal.begin({
      idempotencyKey: decisionId,
      agentId: ACCOUNT_ID,
      ownerAddress: OWNER,
      kind: "billingCollect",
      principal: { kind: "billing_account", id: ACCOUNT_ID },
      decisionId,
      externalRef: {
        billingPrincipal: { kind: "billing_account", id: ACCOUNT_ID },
        billingInvoice: {
          invoiceId: HASH,
          preparedDigest: witnessDigest,
          wallet: WALLET.toLowerCase(),
          collector: COLLECTOR.toLowerCase(),
          valueWei: "1",
          quoteExpiresAt: 2_000,
          sessionGeneration: "1",
        },
      },
      nativeSpendWei: 1n,
    });
    const bound = await journal.bindBillingCollectCallsId({
      principal: { kind: "billing_account", id: ACCOUNT_ID },
      decisionId,
      expectedCallsIdVersion: 0,
      witnessDigest,
      callsId,
    });
    assert.equal(bound.billingCallsIdVersion, 1);
    assert.equal(bound.externalRef.callsId, callsId);
    assert.equal((await journal.bindBillingCollectCallsId({
      principal: { kind: "billing_account", id: ACCOUNT_ID },
      decisionId,
      expectedCallsIdVersion: 0,
      witnessDigest,
      callsId,
    })).externalRef.callsId, callsId);
    await assert.rejects(journal.bindBillingCollectCallsId({
      principal: { kind: "billing_account", id: ACCOUNT_ID },
      decisionId,
      expectedCallsIdVersion: 1,
      witnessDigest,
      callsId: otherCallsId,
    }));
    assert.equal((await journal.get(decisionId))?.externalRef.callsId, callsId);
    await journal.close();
  }
});

test("billing collection proof resolution has Memory/PostgreSQL parity and terminal conflict fencing", async () => {
  const callsId = `0x${"22".repeat(32)}` as Hex;
  const transactionHash = `0x${"33".repeat(32)}` as Hex;
  for (const journal of [
    new MemoryExecutionJournal(() => 1_000_000),
    await PostgresExecutionJournal.create(new FakeSqlClient(), () => 1_000_000),
  ]) {
    const externalRef = {
      billingPrincipal: { kind: "billing_account" as const, id: ACCOUNT_ID },
      billingInvoice: {
        invoiceId: HASH,
        preparedDigest: HASH,
        wallet: WALLET,
        collector: COLLECTOR,
        valueWei: "1000",
        quoteExpiresAt: 1_100,
        sessionGeneration: "1",
      },
    };
    await journal.begin({
      idempotencyKey: "billing-resolution",
      agentId: ACCOUNT_ID,
      ownerAddress: OWNER,
      kind: "billingCollect",
      principal: externalRef.billingPrincipal,
      decisionId: "billing:resolution",
      externalRef,
      nativeSpendWei: 1_000n,
    });
    await journal.markInProgress("billing-resolution", { ...externalRef, callsId });
    const resolved = await journal.resolveBillingCollection("billing-resolution", {
      outcome: "paid",
      callsId,
      transactionHash,
    });
    assert.equal(resolved.state, "COMMITTED");
    assert.equal(resolved.externalRef.txHash, transactionHash);
    assert.equal((await journal.resolveBillingCollection("billing-resolution", {
      outcome: "paid",
      callsId,
      transactionHash,
    })).state, "COMMITTED");
    await assert.rejects(journal.resolveBillingCollection("billing-resolution", {
      outcome: "paid",
      callsId,
      transactionHash: `0x${"44".repeat(32)}`,
    }), /conflicts/);
    await journal.close();
  }
});
