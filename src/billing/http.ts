import { Hono } from "hono";
import { keccak256, stringToBytes, type Address } from "viem";
import { billingError, billingReasonFromError } from "./errors.js";
import { startOgChatAttempt, type FetchLike, type OgInferenceCredential } from "./og.js";
import { assertLiveOgModelMatches, canonicalOgChatBody, type LiveOgModelFacts } from "./models.js";
import type { BillingStore } from "./store.js";
import type { AgentBillingGrant, OracleSnapshot, Usage } from "./types.js";
import { parseInternalCmcBody, parseInternalOgBody } from "./wire.js";
import { runCmcQuoteAttempt, type X402SettlementResult, type X402Signer } from "./x402.js";
import type { HeaderEntry } from "./x402Registry.js";

const MAX_INTERNAL_BODY_BYTES = 32 * 1024;

export type BillingInternalGatewayDeps = Readonly<{
  store: BillingStore;
  now?: () => number;
  executionTicketKeyId: string;
  executionTicketPublicKey: string;
  preAdmissionCheck(usage: Usage): Promise<void>;
  resolveGrant(grantId: string, generation: bigint): Promise<AgentBillingGrant | null>;
  og?: Readonly<{
    fetch: FetchLike;
    credential: OgInferenceCredential;
    settlementMode(): Promise<string>;
    liveModelFacts(modelId: string): Promise<LiveOgModelFacts>;
    valuation(reserveNeuron: bigint): Promise<Readonly<{
      reservedUsdMicros: bigint;
      ogOracle: OracleSnapshot;
      arbitrumSequencer: OracleSnapshot;
    }>>;
  }>;
  cmc?: Readonly<{
    fetch: FetchLike;
    signer: X402Signer;
    authorizer: Address;
    providerExposureCapAtomic: bigint;
    platformPayerExposureCapAtomic: bigint;
    preSignCheck(usage: Usage): Promise<void>;
    reconcileSettlement(input: Readonly<{ usage: Usage; responseStatus: number; responseHeaders: readonly HeaderEntry[] }>): Promise<X402SettlementResult>;
    freshOgValuation?(): Promise<Readonly<{
      ogOracle: OracleSnapshot;
      arbitrumSequencer: OracleSnapshot;
    }>>;
  }>;
}>;

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("runtime_auth_failed");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_INTERNAL_BODY_BYTES) throw new Error("runtime_auth_failed");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error("runtime_auth_failed"); }
}

function usageView(usage: Usage): Readonly<Record<string, string>> {
  return {
    usageId: usage.usageId,
    state: usage.state,
    operation: usage.operation,
    provider: usage.provider,
    reservedAtomic: usage.reservedAtomic.toString(),
    ...(usage.actualAtomic === undefined ? {} : { actualAtomic: usage.actualAtomic.toString() }),
  };
}

function errorResponse(error: unknown): Response {
  const reason = billingReasonFromError(error);
  const rendered = billingError(reason);
  return Response.json(rendered.body, { status: rendered.status });
}

/** Internal-only paid gateway. The caller must bind it to loopback. */
export function createBillingInternalGateway(deps: BillingInternalGatewayDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1_000));

  if (deps.og !== undefined) {
    app.post("/internal/paid/0g/chat", async (c) => {
      try {
        const body = parseInternalOgBody(await readJson(c.req.raw));
        const grant = await deps.resolveGrant(body.assertion.grantId, body.assertion.generation);
        if (grant === null) throw new Error("runtime_auth_failed");
        const canonical = canonicalOgChatBody(body.model, body.maxTokens, body.messages);
        const [settlementMode, liveModelFacts, valuation] = await Promise.all([
          deps.og!.settlementMode(),
          deps.og!.liveModelFacts(body.model),
          deps.og!.valuation(canonical.reserveNeuron),
        ]);
        assertLiveOgModelMatches(canonical.model, liveModelFacts);
        const liveModelObservationDigest = keccak256(stringToBytes(JSON.stringify({
          canonicalModelId: liveModelFacts.canonicalModelId,
          serviceType: liveModelFacts.serviceType,
          contextLength: liveModelFacts.contextLength.toString(),
          maxCompletionTokens: liveModelFacts.maxCompletionTokens.toString(),
          inputReserveNeuronPerToken: liveModelFacts.inputReserveNeuronPerToken.toString(),
          completionNeuronPerToken: liveModelFacts.completionNeuronPerToken.toString(),
          providerAddress: liveModelFacts.providerAddress.toLowerCase(),
          teeAcknowledged: liveModelFacts.teeAcknowledged,
          explicitlyHealthy: liveModelFacts.explicitlyHealthy ?? null,
        })));
        const started = await startOgChatAttempt({
          store: deps.store,
          fetch: deps.og!.fetch,
          credential: deps.og!.credential,
          assertion: body.assertion,
          ticket: body.sessionTicket,
          grant,
          executionTicketKeyId: deps.executionTicketKeyId,
          executionTicketPublicKey: deps.executionTicketPublicKey,
          modelId: body.model,
          maxTokens: body.maxTokens,
          messages: body.messages,
          reservedUsdMicros: valuation.reservedUsdMicros,
          ogOracle: valuation.ogOracle,
          arbitrumSequencer: valuation.arbitrumSequencer,
          now: now(),
          settlementMode,
          liveModelFacts,
          liveModelObservationDigest,
          preAdmissionCheck: deps.preAdmissionCheck,
        });
        if (started.body === null) {
          const status = started.usage.state === "unknown" ? 409 : started.usage.state === "prepared" || started.usage.state === "transmitting" ? 202 : 200;
          return c.json({ data: usageView(started.usage) }, status);
        }
        void started.completion.catch(() => undefined);
        return new Response(started.body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "x-4lpha-usage-id": started.usage.usageId,
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    });
  }

  if (deps.cmc !== undefined) {
    app.post("/internal/paid/cmc/quote", async (c) => {
      try {
        const body = parseInternalCmcBody(await readJson(c.req.raw));
        const grant = await deps.resolveGrant(body.assertion.grantId, body.assertion.generation);
        if (grant === null) throw new Error("runtime_auth_failed");
        const ogValuation = await deps.cmc!.freshOgValuation?.();
        const result = await runCmcQuoteAttempt({
          store: deps.store,
          fetch: deps.cmc!.fetch,
          signer: deps.cmc!.signer,
          reconcileSettlement: deps.cmc!.reconcileSettlement,
          assertion: body.assertion,
          ticket: body.sessionTicket,
          grant,
          executionTicketKeyId: deps.executionTicketKeyId,
          executionTicketPublicKey: deps.executionTicketPublicKey,
          authorizer: deps.cmc!.authorizer,
          query: body.query,
          now: now(),
          preSignCheck: deps.cmc!.preSignCheck,
          preAdmissionCheck: deps.preAdmissionCheck,
          providerExposureCapAtomic: deps.cmc!.providerExposureCapAtomic,
          platformPayerExposureCapAtomic: deps.cmc!.platformPayerExposureCapAtomic,
          ...(ogValuation === undefined ? {} : ogValuation),
        });
        if (result.body !== undefined) {
          return new Response(result.body, {
            status: result.status,
            headers: { "content-type": "application/json", "x-4lpha-usage-id": result.usage.usageId },
          });
        }
        return Response.json({ data: usageView(result.usage) }, { status: result.status });
      } catch (error) {
        return errorResponse(error);
      }
    });
  }

  return app;
}
