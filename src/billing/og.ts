import { createHash } from "node:crypto";
import { keccak256, stringToBytes } from "viem";
import type { BillingStore, PreparedUsage } from "./store.js";
import { assertLiveOgModelMatches, canonicalOgChatBody, OG_CHAT_PATH, OG_CHAT_TEMPLATE_ID, OG_MAX_SSE_BUFFER_BYTES, OG_MAX_SSE_EVENTS, OG_MAX_SSE_ITEM_BYTES, OG_MAX_STREAM_BYTES, OG_ROUTER_ORIGIN, OG_STREAM_TIMEOUT_MS, type LiveOgModelFacts, type OgMessage } from "./models.js";
import type { AgentBillingGrant, OgHistoryDebit, OgReconciliationCursor, OgResponseFacts, OgUsageFacts, OracleSnapshot, PaidServiceAssertionV1, PaidServiceSessionTicketV1, Usage } from "./types.js";
import { paidCanonicalJsonV1, paidRequestDigest, verifyPaidAssertion, verifyPaidTicket } from "./canonical.js";
import { MAX_SEEN_OG_HISTORY_IDS } from "./config.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OgInferenceCredential = Readonly<{
  apiKeyId: string;
  bearerToken: string;
  payerAccountId: string;
  providerExposureCapNeuron: bigint;
  platformPayerExposureCapNeuron: bigint;
}>;

export type OgManagementCredential = Readonly<{
  /** Separate account:read credential; it must never be used for inference. */
  bearerToken: string;
}>;

const OG_HISTORY_PATH = "/v1/account/usage/history";
const OG_HISTORY_PAGE_LIMIT = 100;
const OG_HISTORY_MAX_PAGES_PER_RUN = 10;
const OG_HISTORY_TIMEOUT_MS = 15_000;
const OG_HISTORY_MAX_BODY_BYTES = 2 * 1024 * 1024;

export type OgAttemptInput = Readonly<{
  store: BillingStore;
  fetch: FetchLike;
  credential: OgInferenceCredential;
  assertion: PaidServiceAssertionV1;
  ticket: PaidServiceSessionTicketV1;
  grant: AgentBillingGrant;
  executionTicketKeyId: string;
  executionTicketPublicKey: string;
  modelId: string;
  maxTokens: number;
  messages: readonly OgMessage[];
  reservedUsdMicros: bigint;
  ogOracle: OracleSnapshot;
  arbitrumSequencer: OracleSnapshot;
  now: number;
  settlementMode: string;
  liveModelFacts: LiveOgModelFacts;
  liveModelObservationDigest: string;
  preAdmissionCheck(usage: Usage): Promise<void>;
}>;

export type OgStartedAttempt = Readonly<{
  usage: Usage;
  body: ReadableStream<Uint8Array> | null;
  completion: Promise<Usage>;
  joined: boolean;
}>;

function oneHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null || value.trim() === "" || value.includes(",")) throw new Error(`${name} must occur exactly once.`);
  return value;
}

function requestId(value: string): string {
  if (!/^[\x21-\x7e]{1,256}$/.test(value)) throw new Error("Router X-Request-ID is malformed.");
  return value;
}

function evidenceDigest(label: string, detail: string): string {
  return `sha256:${createHash("sha256").update(label).update("\0").update(detail).digest("hex")}`;
}

async function unknownAfterContact(store: BillingStore, prepared: PreparedUsage, usage: Usage, kind: string, detail: string, now: number): Promise<Usage> {
  try {
    return await store.markUnknown(usage.usageId, prepared.leaseToken, kind, evidenceDigest(kind, detail), now);
  } catch {
    const latest = await store.getUsage(usage.usageId);
    return latest ?? usage;
  }
}

type SseSummary = Readonly<{ facts?: OgResponseFacts; digest: string }>;

function canonicalUint(value: unknown, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${field} must be a canonical nonnegative decimal integer.`);
  return BigInt(value);
}

function parseEventFacts(eventText: string, routerRequestId: string): OgResponseFacts | undefined {
  const data = eventText.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (data === "" || data === "[DONE]") return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(data) as unknown; } catch { throw new Error("Malformed Router SSE JSON."); }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
  const row = decoded as Record<string, unknown>;
  const usage = typeof row["usage"] === "object" && row["usage"] !== null && !Array.isArray(row["usage"])
    ? row["usage"] as Record<string, unknown> : undefined;
  const trace = typeof row["x_0g_trace"] === "object" && row["x_0g_trace"] !== null && !Array.isArray(row["x_0g_trace"])
    ? row["x_0g_trace"] as Record<string, unknown> : undefined;
  if (usage === undefined && trace === undefined) return undefined;
  const traceRequestId = trace?.["request_id"];
  if (traceRequestId !== undefined && traceRequestId !== routerRequestId) throw new Error("Router trace request ID mismatch.");
  const billing = typeof trace?.["billing"] === "object" && trace["billing"] !== null && !Array.isArray(trace["billing"])
    ? trace["billing"] as Record<string, unknown> : undefined;
  if (billing !== undefined && "currency" in billing) throw new Error("0G settlement-mode trace must omit billing.currency.");
  const provider = trace?.["provider"];
  const tee = trace?.["tee_verified"];
  if (provider !== undefined && typeof provider !== "string") throw new Error("Trace provider is malformed.");
  if (tee !== undefined && typeof tee !== "boolean") throw new Error("Trace TEE flag is malformed.");
  const input = usage?.["prompt_tokens"] ?? usage?.["input_tokens"];
  const output = usage?.["completion_tokens"] ?? usage?.["output_tokens"];
  const inputTokens = canonicalUint(typeof input === "number" && Number.isSafeInteger(input) ? String(input) : input, "input tokens");
  const outputTokens = canonicalUint(typeof output === "number" && Number.isSafeInteger(output) ? String(output) : output, "output tokens");
  const traceCostNeuron = canonicalUint(billing?.["total_cost"], "billing.total_cost");
  return {
    routerRequestId,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(provider === undefined ? {} : { traceProvider: provider }),
    ...(tee === undefined ? {} : { traceTeeVerified: tee }),
    ...(traceCostNeuron === undefined ? {} : { traceCostNeuron }),
    traceDigest: evidenceDigest("0g_trace", eventText),
  };
}

function mergeFacts(current: OgResponseFacts | undefined, next: OgResponseFacts | undefined): OgResponseFacts | undefined {
  if (next === undefined) return current;
  if (current === undefined) return next;
  const merged: OgResponseFacts = {
    routerRequestId: current.routerRequestId,
    ...(current.inputTokens ?? next.inputTokens) === undefined ? {} : { inputTokens: current.inputTokens ?? next.inputTokens as bigint },
    ...(current.outputTokens ?? next.outputTokens) === undefined ? {} : { outputTokens: current.outputTokens ?? next.outputTokens as bigint },
    ...(current.traceProvider ?? next.traceProvider) === undefined ? {} : { traceProvider: current.traceProvider ?? next.traceProvider as string },
    ...(current.traceTeeVerified ?? next.traceTeeVerified) === undefined ? {} : { traceTeeVerified: current.traceTeeVerified ?? next.traceTeeVerified as boolean },
    ...(current.traceCostNeuron ?? next.traceCostNeuron) === undefined ? {} : { traceCostNeuron: current.traceCostNeuron ?? next.traceCostNeuron as bigint },
    ...(current.traceDigest ?? next.traceDigest) === undefined ? {} : { traceDigest: current.traceDigest ?? next.traceDigest as string },
  };
  for (const field of ["inputTokens", "outputTokens", "traceProvider", "traceTeeVerified", "traceCostNeuron"] as const) {
    if (current[field] !== undefined && next[field] !== undefined && current[field] !== next[field]) throw new Error("Router SSE facts conflict.");
  }
  return merged;
}

function boundedSseStream(
  upstream: ReadableStream<Uint8Array>,
  abort: AbortController,
  routerRequestId: string,
  onComplete: (summary: SseSummary) => Promise<void>,
  onFailure: (error: Error) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const digest = createHash("sha256");
  let bytes = 0;
  let events = 0;
  let buffer = "";
  let facts: OgResponseFacts | undefined;
  let done = false;

  async function fail(error: Error, controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (done) return;
    done = true;
    abort.abort();
    try { await onFailure(error); } finally { controller.error(error); }
  }

  function parseReady(): void {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const event = buffer.slice(0, boundary).replace(/\r\n/g, "\n");
      buffer = buffer.slice(boundary + 2);
      if (Buffer.byteLength(event, "utf8") > OG_MAX_SSE_ITEM_BYTES) throw new Error("STREAM_LIMIT");
      events += 1;
      if (events > OG_MAX_SSE_EVENTS) throw new Error("STREAM_LIMIT");
      facts = mergeFacts(facts, parseEventFacts(event, routerRequestId));
    }
    if (Buffer.byteLength(buffer, "utf8") > OG_MAX_SSE_BUFFER_BYTES) throw new Error("STREAM_LIMIT");
    const lines = buffer.split("\n");
    if (lines.some((line) => Buffer.byteLength(line, "utf8") > OG_MAX_SSE_ITEM_BYTES)) throw new Error("STREAM_LIMIT");
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      try {
        const part = await reader.read();
        if (part.done) {
          buffer += decoder.decode();
          parseReady();
          if (buffer.trim() !== "") {
            if (Buffer.byteLength(buffer, "utf8") > OG_MAX_SSE_ITEM_BYTES) throw new Error("STREAM_LIMIT");
            facts = mergeFacts(facts, parseEventFacts(buffer.replace(/\r\n/g, "\n"), routerRequestId));
          }
          await onComplete({ ...(facts === undefined ? {} : { facts }), digest: `sha256:${digest.digest("hex")}` });
          done = true;
          controller.close();
          return;
        }
        bytes += part.value.byteLength;
        if (bytes > OG_MAX_STREAM_BYTES) throw new Error("STREAM_LIMIT");
        digest.update(part.value);
        buffer += decoder.decode(part.value, { stream: true });
        parseReady();
        controller.enqueue(part.value);
      } catch (error) {
        await fail(error instanceof Error ? error : new Error("Router stream failed."), controller);
      }
    },
    async cancel() {
      if (done) return;
      done = true;
      abort.abort();
      await reader.cancel().catch(() => undefined);
      await onFailure(new Error("Downstream canceled the paid Router stream."));
    },
  });
}

export async function startOgChatAttempt(input: OgAttemptInput): Promise<OgStartedAttempt> {
  if (input.settlementMode !== "0g") throw new Error("BILLING_SESSION_INVALID");
  const canonical = canonicalOgChatBody(input.modelId, input.maxTokens, input.messages);
  const ticketHash = verifyPaidTicket(input.ticket, input.executionTicketKeyId, input.executionTicketPublicKey, input.now);
  verifyPaidAssertion(input.assertion, input.grant.issuerPublicKey, input.now);
  if (
    input.assertion.operation !== "paid.0g.chat" || input.assertion.templateId !== OG_CHAT_TEMPLATE_ID ||
    input.assertion.sessionTicketHash !== ticketHash || input.assertion.maxTokens !== input.maxTokens ||
    input.ticket.allowedModelIds?.includes(input.modelId) !== true
  ) throw new Error("runtime_auth_failed");
  const requestDigest = paidRequestDigest({
    method: "POST",
    fixedRoutePath: "/internal/paid/0g/chat",
    canonicalQuery: "",
    businessPayload: canonical.body,
    sessionTicketHash: ticketHash,
  });
  if (input.assertion.requestDigest !== requestDigest) throw new Error("runtime_auth_failed");
  const assertionDigest = keccak256(stringToBytes(paidCanonicalJsonV1(input.assertion)));
  assertLiveOgModelMatches(canonical.model, input.liveModelFacts);
  if (!/^0x[0-9a-f]{64}$/.test(input.liveModelObservationDigest)) throw new Error("MODEL_MANIFEST_DRIFT");
  const sourceFacts: OgUsageFacts = {
    kind: "0g",
    manifestVersion: "0g-chat-v1-2026-08-26",
    routerPayerAccountId: input.credential.payerAccountId,
    routerApiKeyId: input.credential.apiKeyId,
    rawModelId: canonical.model.rawModelId,
    canonicalModelId: canonical.model.canonicalModelId,
    providerAddress: canonical.model.providerAddress.toLowerCase(),
    reviewedProviderIdentity: canonical.model.reviewedProviderIdentity,
    providerIdentityRule: "match-if-present",
    reviewedContextLength: canonical.model.contextLength,
    reviewedMaxCompletionTokens: canonical.model.maxCompletionTokens,
    requestedMaxTokens: BigInt(input.maxTokens),
    requestBodyBytes: canonical.bytes,
    inputReserveNeuronPerToken: canonical.model.inputReserveNeuronPerToken,
    completionReserveNeuronPerToken: canonical.model.completionNeuronPerToken,
    liveModelObservationDigest: input.liveModelObservationDigest,
  };
  const prepared = await input.store.reservePaidUsage({
    assertion: input.assertion,
    assertionDigest,
    ticket: input.ticket,
    grant: input.grant,
    source: "0g",
    provider: "0g-router",
    asset: "0G_MAINNET",
    payerIdentity: input.credential.payerAccountId,
    reservedAtomic: canonical.reserveNeuron,
    reservedUsdMicros: input.reservedUsdMicros,
    providerExposureCapAtomic: input.credential.providerExposureCapNeuron,
    platformPayerExposureCapAtomic: input.credential.platformPayerExposureCapNeuron,
    ogOracle: input.ogOracle,
    arbitrumSequencer: input.arbitrumSequencer,
    sourceFacts,
    now: input.now,
  });
  if (prepared.joined) return { usage: prepared.usage, body: null, completion: Promise.resolve(prepared.usage), joined: true };

  try {
    await input.preAdmissionCheck(prepared.usage);
  } catch (error) {
    await input.store.finalizeProvenNotCharged(
      prepared.usage.usageId,
      prepared.leaseToken,
      "pre_admission_refused",
      evidenceDigest("pre_admission_refused", error instanceof Error ? error.name : "refused"),
      input.now,
    );
    throw error;
  }

  let transmitting = await input.store.markUpstreamContact(prepared.usage.usageId, prepared.leaseToken, prepared.usage.version, input.now);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), OG_STREAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await input.fetch(`${OG_ROUTER_ORIGIN}${OG_CHAT_PATH}`, {
      method: "POST",
      redirect: "error",
      signal: abort.signal,
      headers: {
        authorization: `Bearer ${input.credential.bearerToken}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "accept-encoding": "identity",
        "x-0g-provider-address": canonical.model.providerAddress,
        "x-0g-provider-allow-fallbacks": "false",
      },
      body: canonical.body,
    });
  } catch (error) {
    clearTimeout(timer);
    const unknown = await unknownAfterContact(input.store, prepared, transmitting, "0g_transport_unknown", error instanceof Error ? error.name : "transport", input.now);
    return { usage: unknown, body: null, completion: Promise.resolve(unknown), joined: false };
  }
  if (response.status !== 200 || oneHeader(response.headers, "content-type").split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream" || response.body === null) {
    clearTimeout(timer);
    const unknown = await unknownAfterContact(input.store, prepared, transmitting, "0g_response_unknown", String(response.status), input.now);
    return { usage: unknown, body: null, completion: Promise.resolve(unknown), joined: false };
  }
  let routerRequestId: string;
  try {
    routerRequestId = requestId(oneHeader(response.headers, "x-request-id"));
    transmitting = await input.store.bindExternalRequestId(transmitting.usageId, prepared.leaseToken, transmitting.version, routerRequestId, input.now);
  } catch (error) {
    clearTimeout(timer);
    abort.abort();
    const unknown = await unknownAfterContact(input.store, prepared, transmitting, "0g_identity_unknown", error instanceof Error ? error.message : "identity", input.now);
    return { usage: unknown, body: null, completion: Promise.resolve(unknown), joined: false };
  }

  let resolveCompletion: (usage: Usage) => void = () => undefined;
  const completion = new Promise<Usage>((resolve) => { resolveCompletion = resolve; });
  const body = boundedSseStream(
    response.body,
    abort,
    routerRequestId,
    async (summary) => {
      clearTimeout(timer);
      let latest = await input.store.getUsage(transmitting.usageId) ?? transmitting;
      if (summary.facts !== undefined) {
        latest = await input.store.bindOgResponseFacts(latest.usageId, prepared.leaseToken, latest.version, summary.facts, Math.floor(Date.now() / 1000));
      }
      latest = await input.store.markUnknown(latest.usageId, prepared.leaseToken, "0g_history_pending", summary.digest, Math.floor(Date.now() / 1000));
      resolveCompletion(latest);
    },
    async (error) => {
      clearTimeout(timer);
      const latest = await input.store.getUsage(transmitting.usageId) ?? transmitting;
      const unknown = await unknownAfterContact(input.store, prepared, latest, error.message === "STREAM_LIMIT" ? "stream_limit" : "0g_stream_unknown", error.name, Math.floor(Date.now() / 1000));
      resolveCompletion(unknown);
    },
  );
  return { usage: transmitting, body, completion, joined: false };
}

function parseUintField(row: Record<string, unknown>, field: string): bigint {
  const value = row[field];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`0G history ${field} is malformed.`);
  return BigInt(value);
}

export type OgHistoryPage = Readonly<{ rows: readonly OgHistoryDebit[]; nextCursor?: string }>;

export function parseOgHistoryPage(value: unknown): OgHistoryPage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("0G history response is malformed.");
  const root = value as Record<string, unknown>;
  if (root["currency"] !== "0g") throw new Error("0G history currency must be exactly 0g.");
  const rawRows = root["data"];
  if (!Array.isArray(rawRows) || rawRows.length > 100) throw new Error("0G history page is malformed.");
  const rows = rawRows.map((raw): OgHistoryDebit => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("0G history row is malformed.");
    const row = raw as Record<string, unknown>;
    const string = (field: string): string => {
      const candidate = row[field];
      if (typeof candidate !== "string" || candidate === "") throw new Error(`0G history ${field} is malformed.`);
      return candidate;
    };
    const completed = row["completed_at"];
    const completedAt = typeof completed === "number" && Number.isSafeInteger(completed) ? completed : Number(string("completed_at"));
    if (!Number.isSafeInteger(completedAt) || completedAt < 0) throw new Error("0G history completed_at is malformed.");
    const providerIdentity = row["provider_identity"];
    if (providerIdentity !== undefined && typeof providerIdentity !== "string") throw new Error("0G provider identity is malformed.");
    return {
      historyId: parseUintField(row, "id"),
      routerRequestId: string("request_id"),
      apiKeyId: string("api_key_id"),
      modelId: string("model_id"),
      canonicalId: string("canonical_id"),
      providerAddress: string("provider_address"),
      ...(providerIdentity === undefined ? {} : { providerIdentity }),
      inputTokens: parseUintField(row, "input_tokens"),
      outputTokens: parseUintField(row, "output_tokens"),
      cachedTokens: parseUintField(row, "cached_tokens"),
      cacheWriteTokens: parseUintField(row, "cache_write_tokens"),
      cacheWrite1hTokens: parseUintField(row, "cache_write_1h_tokens"),
      totalCostNeuron: parseUintField(row, "cost"),
      creditUsedNeuron: parseUintField(row, "credit_used"),
      depositUsedNeuron: parseUintField(row, "deposit_used"),
      completedAt,
    };
  });
  const nextCursor = root["next_cursor"];
  if (nextCursor !== undefined && (typeof nextCursor !== "string" || nextCursor.length > 4_096)) throw new Error("0G history cursor is malformed.");
  return { rows, ...(typeof nextCursor === "string" && nextCursor !== "" ? { nextCursor } : {}) };
}

export function matchOgHistory(usage: Usage, rows: readonly OgHistoryDebit[]): OgHistoryDebit | null {
  if (usage.sourceFacts?.kind !== "0g" || usage.externalRequestId === undefined) throw new Error("0G Usage lacks reconciliation identity.");
  const matches = rows.filter((row) => row.routerRequestId === usage.externalRequestId);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("Duplicate 0G history rows are a security incident.");
  const row = matches[0];
  if (row === undefined) return null;
  const facts = usage.sourceFacts;
  const response = usage.ogResponseFacts;
  if (
    row.apiKeyId !== facts.routerApiKeyId || row.modelId !== facts.rawModelId ||
    row.canonicalId !== facts.canonicalModelId || row.providerAddress.toLowerCase() !== facts.providerAddress.toLowerCase() ||
    (row.providerIdentity !== undefined && (facts.reviewedProviderIdentity === null || row.providerIdentity !== facts.reviewedProviderIdentity)) ||
    row.inputTokens > facts.reviewedContextLength || row.outputTokens > facts.requestedMaxTokens ||
    row.cachedTokens + row.cacheWriteTokens + row.cacheWrite1hTokens > row.inputTokens ||
    row.creditUsedNeuron + row.depositUsedNeuron !== row.totalCostNeuron || row.totalCostNeuron > usage.reservedAtomic ||
    (response?.routerRequestId !== undefined && response.routerRequestId !== row.routerRequestId) ||
    (response?.inputTokens !== undefined && response.inputTokens !== row.inputTokens) ||
    (response?.outputTokens !== undefined && response.outputTokens !== row.outputTokens) ||
    (response?.traceProvider !== undefined && response.traceProvider.toLowerCase() !== row.providerAddress.toLowerCase()) ||
    (response?.traceTeeVerified !== undefined && response.traceTeeVerified !== true) ||
    (response?.traceCostNeuron !== undefined && response.traceCostNeuron !== row.totalCostNeuron)
  ) throw new Error("0G history identity or cost drifted.");
  return row;
}

export async function reconcileOgUsage(store: BillingStore, usageId: string, rows: readonly OgHistoryDebit[], now: number): Promise<Usage | null> {
  const usage = await store.getUsage(usageId);
  if (usage === null || usage.state !== "unknown") throw new Error("Only unknown 0G Usage is reconcilable.");
  const match = matchOgHistory(usage, rows);
  if (match === null) return null;
  return store.reconcileUnknown(usageId, usage.version, {
    ...(match.totalCostNeuron === 0n ? {} : { actualAtomic: match.totalCostNeuron }),
    evidenceKind: match.totalCostNeuron === 0n ? "0g_history_zero" : "0g_history_debit",
    evidenceDigest: evidenceDigest("0g_history", `${match.historyId}:${match.routerRequestId}:${match.totalCostNeuron}`),
    now,
  });
}

function utcDate(unixSeconds: number): string {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) throw new Error("0G history date is invalid.");
  return new Date(unixSeconds * 1_000).toISOString().slice(0, 10);
}

export function ogReconcileDelaySeconds(attemptCount: bigint, ageSeconds: number): number {
  if (attemptCount < 1n || !Number.isSafeInteger(ageSeconds) || ageSeconds < 0) {
    throw new Error("0G reconciliation schedule is invalid.");
  }
  if (attemptCount === 1n) return 5;
  if (attemptCount === 2n) return 30;
  if (attemptCount === 3n) return 120;
  if (attemptCount === 4n) return 600;
  return ageSeconds <= 30 * 86_400 ? 3_600 : 86_400;
}

async function readBoundedHistoryJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("0G history response body is missing.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > OG_HISTORY_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("0G history response is oversized.");
    }
    chunks.push(item.value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("0G history response JSON is malformed."); }
}

function historyUrl(usage: Usage, now: number, cursor: string | undefined): string {
  if (usage.sourceFacts?.kind !== "0g" || usage.upstreamContactedAt === undefined) {
    throw new Error("0G Usage lacks its stored history query identity.");
  }
  const query = new URLSearchParams();
  query.set("limit", String(OG_HISTORY_PAGE_LIMIT));
  query.set("include_total", "false");
  query.set("api_key_id", usage.sourceFacts.routerApiKeyId);
  query.set("source", "api_key");
  query.set("start_date", utcDate(Math.max(0, usage.upstreamContactedAt - 86_400)));
  query.set("end_date", utcDate(now));
  if (cursor !== undefined) query.set("cursor", cursor);
  return `${OG_ROUTER_ORIGIN}${OG_HISTORY_PATH}?${query.toString()}`;
}

async function saveOgCursor(
  store: BillingStore,
  current: OgReconciliationCursor,
  update: Omit<OgReconciliationCursor, "usageId" | "version">,
): Promise<OgReconciliationCursor> {
  return store.putOgReconciliation({
    usageId: current.usageId,
    version: current.version + 1n,
    ...update,
  }, current.version);
}

/**
 * Scan authoritative account history without scraping the UI Activity Log.
 * A matching row is projected only after the complete cursor generation has
 * been scanned, so duplicate request IDs on later pages cannot be hidden by an
 * early return. Ten-page runs persist the opaque cursor and resume later.
 */
export async function reconcileOgUsageFromHistory(input: Readonly<{
  store: BillingStore;
  fetch: FetchLike;
  credential: OgManagementCredential;
  usageId: string;
  now: number;
}>): Promise<Usage | null> {
  const usage = await input.store.getUsage(input.usageId);
  if (usage === null || usage.state !== "unknown" || usage.source !== "0g") {
    throw new Error("Only unknown 0G Usage is reconcilable from history.");
  }
  if (usage.externalRequestId === undefined) return null;
  if (input.credential.bearerToken.trim() === "" || /[\r\n]/.test(input.credential.bearerToken)) {
    throw new Error("0G management credential is invalid.");
  }
  const contactedAt = usage.upstreamContactedAt;
  if (contactedAt === undefined || !Number.isSafeInteger(input.now) || input.now < contactedAt) {
    throw new Error("0G reconciliation time is invalid.");
  }

  let state = await input.store.getOgReconciliation(usage.usageId);
  if (state?.haltReason === "HISTORY_SCAN_LIMIT") return null;
  if (state?.candidate !== undefined && state.nextCursor === undefined) {
    return reconcileOgUsage(input.store, usage.usageId, [state.candidate], input.now);
  }
  if (state !== null && input.now < state.nextRunAt) return null;
  const attemptCount = (state?.attemptCount ?? 0n) + 1n;
  const nextRunAt = input.now + ogReconcileDelaySeconds(attemptCount, input.now - contactedAt);
  if (state === null) {
    state = await input.store.putOgReconciliation({
      usageId: usage.usageId,
      version: 0n,
      seenHistoryIds: [],
      scanGeneration: 0n,
      attemptCount,
      nextRunAt,
      updatedAt: input.now,
    }, null);
  } else {
    state = await saveOgCursor(input.store, state, {
      ...(state.nextCursor === undefined ? {} : { nextCursor: state.nextCursor }),
      seenHistoryIds: state.seenHistoryIds,
      ...(state.candidate === undefined ? {} : { candidate: state.candidate }),
      scanGeneration: state.scanGeneration,
      attemptCount,
      nextRunAt,
      updatedAt: input.now,
    });
  }

  for (let pageNumber = 0; pageNumber < OG_HISTORY_MAX_PAGES_PER_RUN; pageNumber += 1) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), OG_HISTORY_TIMEOUT_MS);
    let page: ReturnType<typeof parseOgHistoryPage>;
    try {
      const response = await input.fetch(historyUrl(usage, input.now, state.nextCursor), {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${input.credential.bearerToken}` },
        redirect: "error",
        signal: abort.signal,
      });
      if ((response.status === 400 || response.status === 410) && state.nextCursor !== undefined) {
        await saveOgCursor(input.store, state, {
          seenHistoryIds: [],
          scanGeneration: state.scanGeneration + 1n,
          attemptCount: state.attemptCount,
          nextRunAt,
          updatedAt: input.now,
        });
        return null;
      }
      if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new Error("0G history endpoint refused the bounded reconciliation read.");
      }
      // Keep the timeout alive through the bounded body read, not merely until
      // headers arrive. A slow/stalled JSON body is the same unavailable read.
      page = parseOgHistoryPage(await readBoundedHistoryJson(response));
    } finally {
      clearTimeout(timer);
    }
    const seenHistoryIds = new Set(state.seenHistoryIds);
    let candidate = state.candidate;
    for (const row of page.rows) {
      const historyId = row.historyId.toString();
      if (seenHistoryIds.has(historyId)) throw new Error("Duplicate 0G history ID is a security incident.");
      seenHistoryIds.add(historyId);
      if (row.routerRequestId === usage.externalRequestId) {
        matchOgHistory(usage, [row]);
        if (candidate !== undefined) {
          throw new Error("Duplicate 0G history rows are a security incident.");
        }
        candidate = row;
      }
    }
    const continuing = page.nextCursor !== undefined;
    if (continuing && seenHistoryIds.size >= MAX_SEEN_OG_HISTORY_IDS) {
      state = await saveOgCursor(input.store, state, {
        ...(state.nextCursor === undefined ? {} : { nextCursor: state.nextCursor }),
        seenHistoryIds: state.seenHistoryIds,
        ...(state.candidate === undefined ? {} : { candidate: state.candidate }),
        haltReason: "HISTORY_SCAN_LIMIT",
        scanGeneration: state.scanGeneration,
        attemptCount: state.attemptCount,
        nextRunAt: state.nextRunAt,
        updatedAt: input.now,
      });
      return null;
    }
    state = await saveOgCursor(input.store, state, {
      ...(continuing ? { nextCursor: page.nextCursor } : {}),
      // The opaque cursor can cross process runs. Retaining the current scan
      // generation's complete ID set is what detects a provider that repeats
      // or rewinds unrelated rows across that boundary. End-of-pages resets
      // the set together with the generation so delayed indexing can be
      // rescanned from the head without treating old rows as duplicates.
      seenHistoryIds: continuing ? [...seenHistoryIds] : [],
      ...(candidate === undefined ? {} : { candidate }),
      scanGeneration: continuing ? state.scanGeneration : state.scanGeneration + 1n,
      attemptCount: state.attemptCount,
      nextRunAt,
      updatedAt: input.now,
    });
    if (!continuing) {
      if (candidate === undefined) return null;
      return reconcileOgUsage(input.store, usage.usageId, [candidate], input.now);
    }
  }
  return null;
}
