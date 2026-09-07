import { keccak256, stringToBytes, type Hex } from "viem";
import type { AgentRecord } from "../store/agents.js";
import type { BillingOwnerServerDeps } from "../server.js";
import { assertCollectability, type CollectionMeterReader, type CollectionRelay } from "./collection.js";
import type { EnabledBillingConfig } from "./config.js";
import type { BillingCustodyAndRelayPrimitives } from "./custody.js";
import { proveBaseX402Debit, type RpcReceiptObservation } from "./evidence.js";
import type { BillingInternalGatewayDeps } from "./http.js";
import { ogNeuronToUsdMicros } from "./math.js";
import { getOgChatModel, OG_ROUTER_ORIGIN, type LiveOgModelFacts } from "./models.js";
import type { OgManagementCredential } from "./og.js";
import { validateOraclePair } from "./oracles.js";
import type { BillingStore } from "./store.js";
import type { PinnedBillingTransport } from "./transport.js";
import type { BillingAccount, Usage, X402UsageFacts } from "./types.js";
import type { X402SettlementResult } from "./x402.js";
import {
  buildBoundPaymentSignatureHeader,
  decodeCanonicalPaymentResponse,
  x402AuthorizationSigningBytes,
} from "./x402Registry.js";

const MAX_CONTROL_BODY_BYTES = 2 * 1024 * 1024;

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} is malformed.`);
  return value as Record<string, unknown>;
}

function decimal(value: unknown, field: string): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/u.test(text)) throw new Error(`${field} is malformed.`);
  return BigInt(text);
}

async function boundedJson(response: Response, field: string): Promise<unknown> {
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new Error(`${field} endpoint refused the closed request.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_CONTROL_BODY_BYTES) throw new Error(`${field} response exceeds its byte bound.`);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error(`${field} response is malformed.`); }
}

async function ogControlJson(
  transport: PinnedBillingTransport,
  path: string,
  bearerToken: string,
): Promise<unknown> {
  return boundedJson(await transport.fetch(`${OG_ROUTER_ORIGIN}${path}`, {
    method: "GET",
    redirect: "error",
    headers: {
      authorization: `Bearer ${bearerToken}`,
      accept: "application/json",
      "accept-encoding": "identity",
    },
  }), `0G ${path}`);
}

function dataRows(value: unknown, field: string): readonly Record<string, unknown>[] {
  const root = record(value, field);
  const rows = root["data"];
  if (!Array.isArray(rows) || rows.length > 4_096) throw new Error(`${field} data is malformed.`);
  return rows.map((row) => record(row, `${field} row`));
}

function liveModelFacts(
  modelId: string,
  models: unknown,
  providers: unknown,
): LiveOgModelFacts {
  const reviewed = getOgChatModel(modelId);
  const modelMatches = dataRows(models, "0G models").filter((row) => row["id"] === modelId);
  if (modelMatches.length !== 1) throw new Error("MODEL_MANIFEST_DRIFT");
  const model = modelMatches[0]!;
  const providerMatches = dataRows(providers, "0G providers").filter((row) =>
    typeof row["address"] === "string" && row["address"].toLowerCase() === reviewed.providerAddress.toLowerCase() &&
    (row["model_id"] === undefined || row["model_id"] === modelId));
  if (providerMatches.length !== 1) throw new Error("MODEL_MANIFEST_DRIFT");
  const provider = providerMatches[0]!;
  const health = provider["healthy"];
  if (health !== undefined && typeof health !== "boolean") throw new Error("MODEL_MANIFEST_DRIFT");
  return {
    canonicalModelId: String(model["id"]),
    serviceType: String(model["service_type"]),
    contextLength: decimal(model["context_length"], "0G model context length"),
    maxCompletionTokens: decimal(model["max_completion_tokens"], "0G model max completion tokens"),
    inputReserveNeuronPerToken: decimal(model["input_price"], "0G model input price"),
    completionNeuronPerToken: decimal(model["output_price"], "0G model output price"),
    providerAddress: reviewed.providerAddress,
    teeAcknowledged: provider["tee"] === true || provider["tee_acknowledged"] === true,
    ...(health === undefined ? {} : { explicitlyHealthy: health }),
  };
}

function evidenceDigest(label: string, value: unknown): Hex {
  return keccak256(stringToBytes(JSON.stringify({ label, value }, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item)));
}

async function oraclePair(
  transport: PinnedBillingTransport,
  origins: readonly [string, string],
  feed: "0G_USD" | "BNB_USD" | "ARBITRUM_SEQUENCER",
  now: number,
) {
  const [a, b] = await Promise.all([
    transport.readOracleObservation(origins[0], feed),
    transport.readOracleObservation(origins[1], feed),
  ]);
  return validateOraclePair(feed, a, b, now);
}

async function proveX402Response(
  config: EnabledBillingConfig,
  transport: PinnedBillingTransport,
  usage: Usage,
  responseHeaders: readonly (readonly [string, string])[],
): Promise<X402SettlementResult> {
  if (usage.sourceFacts?.kind !== "x402") throw new Error("x402 Usage lost its authorization facts.");
  const settlement = decodeCanonicalPaymentResponse(responseHeaders);
  const transactionHash = settlement.transaction.toLowerCase() as Hex;
  const [a, b] = await Promise.all([
    transport.readReceiptObservation(config.baseRpcOrigins[0], { chain: "base", kind: "x402_proof", transactionHash }),
    transport.readReceiptObservation(config.baseRpcOrigins[1], { chain: "base", kind: "x402_proof", transactionHash }),
  ]);
  if (a === null || b === null) return {
    kind: "unknown",
    evidenceKind: "base_x402_pending",
    evidenceDigest: evidenceDigest("base_x402_pending", transactionHash),
  };
  const proof = proveBaseX402Debit(usage.sourceFacts, a, b);
  return {
    kind: "actual",
    evidenceKind: "base_x402_finalized",
    evidenceDigest: evidenceDigest("base_x402_finalized", proof),
  };
}

function canonicalRelayPrepareBytes(input: Parameters<CollectionRelay["prepare"]>[0]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    domain: "4lpha.billing-collection-prepare.v1",
    chainId: 56,
    wallet: input.wallet.toLowerCase(),
    collector: input.collector.toLowerCase(),
    calldata: input.calldata.toLowerCase(),
    value: input.value.toString(),
    sessionGeneration: input.sessionGeneration.toString(),
    maxExpiresAt: input.maxExpiresAt,
  }));
}

export type CoreBillingClients = Readonly<{
  preAdmissionCheck: BillingInternalGatewayDeps["preAdmissionCheck"];
  og?: NonNullable<BillingInternalGatewayDeps["og"]>;
  cmc?: NonNullable<BillingInternalGatewayDeps["cmc"]>;
  ogManagement?: OgManagementCredential;
  collection: Readonly<{
    relay: CollectionRelay;
    meter(account: BillingAccount): CollectionMeterReader;
    sessionGeneration(account: BillingAccount): Promise<bigint>;
    readProof(origin: string, callsId: Hex): Promise<RpcReceiptObservation | null>;
  }>;
  owner: Pick<BillingOwnerServerDeps,
    "signExecutionTicket" | "onChainSessionExpiresAt" | "actualUsdMicros">;
}>;

export async function createCoreBillingClients(input: Readonly<{
  config: EnabledBillingConfig;
  store: BillingStore;
  primitives: BillingCustodyAndRelayPrimitives;
  transport: PinnedBillingTransport;
}>): Promise<CoreBillingClients> {
  const { config, store, primitives, transport } = input;
  const inference = config.og === "on"
    ? await primitives.loadOgCredential(config.ogInferenceKeyId!)
    : undefined;
  const management = config.og === "on"
    ? await primitives.loadOgCredential(config.ogManagementKeyId!)
    : undefined;
  if (
    inference !== undefined &&
    (inference.payerAccountId !== config.ogRouterPayerAccountId ||
      management?.payerAccountId !== config.ogRouterPayerAccountId ||
      inference.apiKeyId === management.apiKeyId ||
      inference.bearerToken === management.bearerToken)
  ) throw new Error("0G inference/management credential identity drifted.");

  const preAdmissionCheck = async (usage: Usage): Promise<void> => {
    const account = await store.getAccount(usage.accountId);
    if (account === null || account.status !== "active") throw new Error("PAYMENT_DUE");
    const meter = await primitives.readBillingMeter(account.accountId);
    assertCollectability(meter.balanceWei, meter.remainingDayCapWei, 0n);
  };

  const collectionRelay: CollectionRelay = {
    prepare: (request) => primitives.relayPrepare(canonicalRelayPrepareBytes(request)),
    signAndSend: (prepared, token) => primitives.relaySend(prepared, token),
  };

  const owner: CoreBillingClients["owner"] = {
    signExecutionTicket: (bytes) => primitives.signExecutionTicket(config.executionTicketKeyId, bytes),
    async onChainSessionExpiresAt(agent: AgentRecord) {
      const account = await store.getAccountByWallet(agent.walletAddress);
      if (account === null || account.ownerAddress.toLowerCase() !== agent.ownerAddress.toLowerCase()) {
        throw new Error("Billing account is not bound to the owner agent.");
      }
      return (await primitives.readBillingSession(account.accountId)).expiresAt;
    },
    async actualUsdMicros(usages: readonly Usage[]) {
      const now = Math.floor(Date.now() / 1_000);
      const hasOg = usages.some((usage) => usage.asset === "0G_MAINNET" && usage.actualAtomic !== undefined);
      const og = hasOg ? await oraclePair(transport, config.arbitrumRpcOrigins, "0G_USD", now) : undefined;
      if (hasOg) await oraclePair(transport, config.arbitrumRpcOrigins, "ARBITRUM_SEQUENCER", now);
      return usages.reduce((sum, usage) => {
        if (usage.actualAtomic === undefined) return sum;
        if (usage.asset === "USDC_BASE") return sum + usage.actualAtomic;
        if (og === undefined) throw new Error("ORACLE_UNAVAILABLE");
        return sum + ogNeuronToUsdMicros(usage.actualAtomic, og.answer, og.decimals);
      }, 0n);
    },
  };

  return {
    preAdmissionCheck,
    ...(inference === undefined || management === undefined ? {} : {
      og: {
        fetch: transport.fetch.bind(transport),
        credential: {
          apiKeyId: inference.apiKeyId,
          bearerToken: inference.bearerToken,
          payerAccountId: inference.payerAccountId,
          providerExposureCapNeuron: config.platformOgCapNeuron,
          platformPayerExposureCapNeuron: config.platformOgCapNeuron,
        },
        async settlementMode() {
          const root = record(await ogControlJson(transport, "/v1/account/balance", inference.bearerToken), "0G balance");
          const data = root["data"] === undefined ? root : record(root["data"], "0G balance data");
          if (data["settlement_mode"] !== "0g") throw new Error("0G settlement mode drifted.");
          return "0g";
        },
        async liveModelFacts(modelId: string) {
          const [models, providers] = await Promise.all([
            ogControlJson(transport, "/v1/models", inference.bearerToken),
            ogControlJson(transport, "/v1/providers", inference.bearerToken),
          ]);
          return liveModelFacts(modelId, models, providers);
        },
        async valuation(reserveNeuron: bigint) {
          const now = Math.floor(Date.now() / 1_000);
          const [ogOracle, arbitrumSequencer] = await Promise.all([
            oraclePair(transport, config.arbitrumRpcOrigins, "0G_USD", now),
            oraclePair(transport, config.arbitrumRpcOrigins, "ARBITRUM_SEQUENCER", now),
          ]);
          return {
            reservedUsdMicros: ogNeuronToUsdMicros(reserveNeuron, ogOracle.answer, ogOracle.decimals),
            ogOracle,
            arbitrumSequencer,
          };
        },
      },
      ogManagement: { bearerToken: management.bearerToken },
    }),
    ...(config.x402 !== "on" ? {} : {
      cmc: {
        fetch: transport.fetch.bind(transport),
        authorizer: config.x402Authorizer!,
        providerExposureCapAtomic: config.platformBaseUsdcCapAtomic,
        platformPayerExposureCapAtomic: config.platformBaseUsdcCapAtomic,
        preSignCheck: preAdmissionCheck,
        async signer({ selected, facts }) {
          const signature = await primitives.signX402(config.x402PayerKeyId!, x402AuthorizationSigningBytes(facts));
          return buildBoundPaymentSignatureHeader(selected, facts, signature);
        },
        reconcileSettlement: ({ usage, responseHeaders }) =>
          proveX402Response(config, transport, usage, responseHeaders),
      },
    }),
    collection: {
      relay: collectionRelay,
      meter: (account) => () => primitives.readBillingMeter(account.accountId),
      async sessionGeneration(account) {
        const session = await primitives.readBillingSession(account.accountId);
        if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Math.floor(Date.now() / 1_000)) {
          throw new Error("BILLING_SESSION_INVALID");
        }
        return session.generation;
      },
      async readProof(origin, callsId) {
        const status = await primitives.relayStatus(callsId);
        if (status.state === "PENDING") return null;
        if (status.transactionHash === undefined) throw new Error("Terminal relay status omitted its transaction hash.");
        return transport.readReceiptObservation(origin, {
          chain: "bsc",
          kind: "collection_proof",
          transactionHash: status.transactionHash,
          collector: config.collector,
        });
      },
    },
    owner,
  };
}

export function x402Facts(usage: Usage): X402UsageFacts {
  if (usage.sourceFacts?.kind !== "x402") throw new Error("Usage is not x402.");
  return usage.sourceFacts;
}
