import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  padHex,
  toEventSelector,
  type Hex,
} from "viem";
import type { EnabledBillingConfig } from "./config.js";
import type { BaseAbsenceObservation, RpcReceiptObservation } from "./evidence.js";
import { OG_ROUTER_ORIGIN } from "./models.js";
import {
  bindTransportOracleObservation,
  ORACLE_MANIFEST,
  type OracleObservation,
} from "./oracles.js";
import { CMC_ORIGIN, CMC_PATH } from "./x402Registry.js";
import type { X402UsageFacts } from "./types.js";

declare const bootPinnedOrigin: unique symbol;
export type BootPinnedOrigin = string & { readonly [bootPinnedOrigin]: true };

export type ClosedRpcRequest =
  | Readonly<{ chain: "bsc"; kind: "bnb_oracle" }>
  | Readonly<{ chain: "bsc"; kind: "collection_proof"; transactionHash: Hex; collector: string }>
  | Readonly<{ chain: "base"; kind: "x402_proof"; transactionHash: Hex }>
  | Readonly<{
      chain: "base";
      kind: "x402_authorization";
      usdcAddress: string;
      authorizer: string;
      authorizationNonce: string;
    }>
  | Readonly<{ chain: "arbitrum"; kind: "og_oracle" | "sequencer" }>;

export type BillingDestinationPin = Readonly<{
  origin: BootPinnedOrigin;
  hostname: string;
  address: string;
  family: 4 | 6;
  answerSet: readonly string[];
}>;

type LookupAll = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
) => Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;

export interface PinnedBillingTransport {
  origin(value: string): BootPinnedOrigin;
  readRpc(origin: BootPinnedOrigin, request: ClosedRpcRequest): Promise<unknown>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readOracleObservation(
    origin: string,
    feed: "0G_USD" | "BNB_USD" | "ARBITRUM_SEQUENCER",
  ): Promise<OracleObservation>;
  readReceiptObservation(origin: string, request: Extract<ClosedRpcRequest,
    { kind: "collection_proof" | "x402_proof" }>): Promise<RpcReceiptObservation | null>;
  readX402AuthorizationObservation(
    origin: string,
    facts: X402UsageFacts,
  ): Promise<X402AuthorizationObservation>;
  close(): Promise<void>;
}

const CHAINLINK_ABI = [
  {
    type: "function", name: "description", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function", name: "decimals", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

const USDC_AUTHORIZATION_STATE_ABI = [{
  type: "function",
  name: "authorizationState",
  stateMutability: "view",
  inputs: [
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ],
  outputs: [{ name: "", type: "bool" }],
}] as const;

const AUTHORIZATION_USED_TOPIC = toEventSelector("AuthorizationUsed(address,bytes32)");

export type X402AuthorizationObservation = BaseAbsenceObservation & Readonly<{
  candidateTransactionHash?: Hex;
}>;

const MAX_RPC_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_COUNT = 48;

function blockList(entries: readonly (readonly [string, number])[], family: "ipv4" | "ipv6"): BlockList {
  const result = new BlockList();
  for (const [network, prefix] of entries) result.addSubnet(network, prefix, family);
  return result;
}

// Fail closed against the IANA non-global/special-purpose space. The IPv6
// positive allowlist matters: new local-use allocations outside 2000::/3 must
// not silently become paid egress destinations just because they are valid IPs.
const NON_GLOBAL_IPV4 = blockList([
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const, "ipv4");
const GLOBAL_IPV6 = blockList([["2000::", 3]] as const, "ipv6");
const SPECIAL_IPV6 = blockList([
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const, "ipv6");

function isPublicUnicast(answer: { readonly address: string; readonly family: 4 | 6 }): boolean {
  if (answer.family === 4) {
    return isIP(answer.address) === 4 && !NON_GLOBAL_IPV4.check(answer.address, "ipv4");
  }
  return isIP(answer.address) === 6 && GLOBAL_IPV6.check(answer.address, "ipv6") &&
    !SPECIAL_IPV6.check(answer.address, "ipv6");
}

function answerKey(answer: { readonly address: string; readonly family: 4 | 6 }): string {
  return `${answer.family}:${answer.address.toLowerCase()}`;
}

function allConfiguredOrigins(config: EnabledBillingConfig): readonly string[] {
  return [
    ...config.bscRpcOrigins,
    ...config.baseRpcOrigins,
    ...config.arbitrumRpcOrigins,
    ...(config.og === "on" ? [OG_ROUTER_ORIGIN] : []),
    ...(config.x402 === "on" ? [CMC_ORIGIN] : []),
  ];
}

export async function resolveBillingDestinationPins(
  config: EnabledBillingConfig,
  lookupAll: LookupAll = dnsLookup as LookupAll,
): Promise<readonly BillingDestinationPin[]> {
  const pins: BillingDestinationPin[] = [];
  const destinations = new Set<string>();
  for (const origin of allConfiguredOrigins(config)) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || isIP(parsed.hostname) !== 0) {
      throw new Error("Billing transport accepts only reviewed default-port HTTPS DNS origins.");
    }
    const answers = await lookupAll(parsed.hostname, { all: true, verbatim: true });
    if (answers.length === 0 || answers.some((answer) => !isPublicUnicast(answer))) {
      throw new Error("Billing origin DNS resolved to a private or reserved destination.");
    }
    const answerSet = [...new Set(answers.map(answerKey))].sort();
    if (answerSet.some((answer) => destinations.has(answer))) {
      throw new Error("Independent billing origins resolved to a shared destination.");
    }
    for (const answer of answerSet) destinations.add(answer);
    const selected = [...answers].sort((left, right) => left.family - right.family || left.address.localeCompare(right.address))[0];
    if (selected === undefined) throw new Error("Billing origin DNS returned no usable destination.");
    pins.push({
      origin: parsed.origin as BootPinnedOrigin,
      hostname: parsed.hostname,
      address: selected.address,
      family: selected.family,
      answerSet,
    });
  }
  return pins;
}

function rpcRequestBody(request: ClosedRpcRequest): string {
  if (request.kind === "bnb_oracle" || request.kind === "og_oracle" || request.kind === "sequencer") {
    const feed = request.kind === "bnb_oracle" ? "BNB_USD" : request.kind === "og_oracle" ? "0G_USD" : "ARBITRUM_SEQUENCER";
    const manifest = ORACLE_MANIFEST[feed];
    const calls = ["description", "decimals", "latestRoundData"] as const;
    return JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      ...calls.map((functionName, index) => ({
        jsonrpc: "2.0",
        id: index + 2,
        method: "eth_call",
        params: [{
          to: manifest.proxy,
          data: encodeFunctionData({ abi: CHAINLINK_ABI, functionName }),
        }, "latest"],
      })),
    ]);
  }
  if (request.kind === "collection_proof") {
    return JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: [request.transactionHash] },
      { jsonrpc: "2.0", id: 3, method: "eth_getTransactionByHash", params: [request.transactionHash] },
      { jsonrpc: "2.0", id: 4, method: "eth_getBlockByNumber", params: ["finalized", false] },
    ]);
  }
  if (request.kind === "x402_authorization") {
    if (
      !isAddress(request.usdcAddress, { strict: false }) ||
      !isAddress(request.authorizer, { strict: false }) ||
      !/^0x[0-9a-f]{64}$/u.test(request.authorizationNonce)
    ) throw new Error("x402 authorization identity is malformed.");
    return JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["finalized", false] },
    ]);
  }
  if (request.kind !== "x402_proof") throw new Error("Billing RPC request kind is unsupported.");
  return JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: [request.transactionHash] },
    { jsonrpc: "2.0", id: 3, method: "eth_getTransactionByHash", params: [request.transactionHash] },
    { jsonrpc: "2.0", id: 4, method: "eth_getBlockByNumber", params: ["finalized", false] },
  ]);
}

function responseHeaders(input: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}

function exactHeaderNames(headers: Headers, allowed: ReadonlySet<string>): void {
  let count = 0;
  for (const [name] of headers) {
    count += 1;
    if (!allowed.has(name.toLowerCase())) throw new Error("Billing transport refused an unreviewed request header.");
  }
  if (count > MAX_HEADER_COUNT) throw new Error("Billing transport request has too many headers.");
}

function validatePaidRequest(url: URL, init: RequestInit | undefined): void {
  if (init?.redirect !== undefined && init.redirect !== "error") throw new Error("Billing transport refuses redirects.");
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  if (url.origin === CMC_ORIGIN) {
    if (url.pathname !== CMC_PATH || method !== "GET" || init?.body !== undefined) throw new Error("Billing transport refused an unreviewed CMC request.");
    exactHeaderNames(headers, new Set(["accept", "accept-encoding", "payment-signature"]));
    return;
  }
  if (url.origin !== OG_ROUTER_ORIGIN) throw new Error("Billing transport refused an unreviewed paid origin.");
  const chat = url.pathname === "/v1/chat/completions";
  const history = url.pathname === "/v1/account/usage/history";
  const discovery = url.pathname === "/v1/models" || url.pathname === "/v1/providers" || url.pathname === "/v1/account/balance";
  if (!(chat && method === "POST" && typeof init?.body === "string") &&
      !(history && method === "GET" && init?.body === undefined) &&
      !(discovery && method === "GET" && init?.body === undefined)) {
    throw new Error("Billing transport refused an unreviewed 0G request.");
  }
  exactHeaderNames(headers, new Set(chat
    ? ["authorization", "content-type", "accept", "accept-encoding", "x-0g-provider-address", "x-0g-provider-allow-fallbacks"]
    : ["authorization", "accept", "accept-encoding"]));
}

function uint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/u.test(value)) throw new Error(`Malformed ${field}.`);
  return BigInt(value);
}

function rpcResults(value: unknown, expected: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== expected) throw new Error("Billing RPC batch shape drifted.");
  const byId = new Map<number, unknown>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Billing RPC response is malformed.");
    const row = raw as Record<string, unknown>;
    if (row["jsonrpc"] !== "2.0" || !Number.isInteger(row["id"]) || "error" in row || !("result" in row)) {
      throw new Error("Billing RPC response is malformed.");
    }
    const id = row["id"] as number;
    if (byId.has(id)) throw new Error("Billing RPC response ID repeated.");
    byId.set(id, row["result"]);
  }
  return Array.from({ length: expected }, (_value, index) => {
    const result = byId.get(index + 1);
    if (result === undefined) throw new Error("Billing RPC response ID is missing.");
    return result;
  });
}

function safeSecond(value: bigint, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Malformed ${field}.`);
  return parsed;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Malformed ${field}.`);
  return value as Record<string, unknown>;
}

function hash(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new Error(`Malformed ${field}.`);
  return value.toLowerCase() as Hex;
}

function bytes(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) throw new Error(`Malformed ${field}.`);
  return value.toLowerCase() as Hex;
}

function address(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`Malformed ${field}.`);
  return getAddress(value).toLowerCase() as `0x${string}`;
}

function parseReceiptObservation(
  request: Extract<ClosedRpcRequest, { kind: "collection_proof" | "x402_proof" }>,
  first: unknown,
  blockResult: unknown,
  runtimeCodeResult?: unknown,
): RpcReceiptObservation | null {
  const results = rpcResults(first, 4);
  const chainId = uint(results[0], "chain ID");
  const expectedChain = request.kind === "collection_proof" ? 56n : 8_453n;
  if (chainId !== expectedChain) throw new Error("Billing RPC chain substitution was refused.");
  if (results[1] === null || results[2] === null) return null;
  const rawReceipt = record(results[1], "transaction receipt");
  const rawTransaction = record(results[2], "transaction");
  const finalized = record(results[3], "finalized block");
  const receiptBlock = record(blockResult, "receipt block");
  const receiptHash = hash(rawReceipt["transactionHash"], "receipt transaction hash");
  if (receiptHash !== request.transactionHash.toLowerCase()) throw new Error("Billing receipt transaction hash drifted.");
  const logsRaw = rawReceipt["logs"];
  if (!Array.isArray(logsRaw) || logsRaw.length > 4_096) throw new Error("Malformed billing receipt logs.");
  const logs = logsRaw.map((raw) => {
    const row = record(raw, "receipt log");
    const topics = row["topics"];
    if (!Array.isArray(topics) || topics.length > 4) throw new Error("Malformed receipt log topics.");
    return {
      address: address(row["address"], "receipt log address"),
      topics: topics.map((topic, index) => hash(topic, `receipt topic ${index}`)),
      data: bytes(row["data"], "receipt log data"),
    };
  });
  const status = uint(rawReceipt["status"], "receipt status");
  if (status !== 0n && status !== 1n) throw new Error("Malformed receipt status.");
  const toRaw = rawTransaction["to"];
  const transaction = {
    hash: hash(rawTransaction["hash"], "transaction hash"),
    from: address(rawTransaction["from"], "transaction from"),
    to: toRaw === null ? null : address(toRaw, "transaction to"),
    input: bytes(rawTransaction["input"], "transaction input"),
    value: uint(rawTransaction["value"], "transaction value"),
  };
  const receiptBlockNumber = uint(rawReceipt["blockNumber"], "receipt block number");
  const receiptBlockHash = hash(rawReceipt["blockHash"], "receipt block hash");
  const lookedUpBlockNumber = uint(receiptBlock["number"], "looked-up receipt block number");
  const lookedUpBlockHash = hash(receiptBlock["hash"], "looked-up receipt block hash");
  if (receiptBlockNumber !== lookedUpBlockNumber || receiptBlockHash !== lookedUpBlockHash) {
    throw new Error("Billing receipt block lookup drifted.");
  }
  const observation: RpcReceiptObservation = {
    chainId,
    finalizedBlock: uint(finalized["number"], "finalized block number"),
    finalizedBlockHash: hash(finalized["hash"], "finalized block hash"),
    receiptBlockTimestamp: safeSecond(uint(receiptBlock["timestamp"], "receipt block timestamp"), "receipt block timestamp"),
    receipt: {
      transactionHash: receiptHash,
      blockNumber: receiptBlockNumber,
      blockHash: receiptBlockHash,
      status: Number(status) as 0 | 1,
      logs,
    },
    transaction,
    ...(request.kind === "collection_proof"
      ? { runtimeCode: bytes(runtimeCodeResult, "collector runtime code at receipt block") }
      : {}),
  };
  return observation;
}

class CorePinnedBillingTransport implements PinnedBillingTransport {
  readonly #pins: ReadonlyMap<string, BillingDestinationPin>;
  readonly #lookupAll: LookupAll;

  constructor(pins: readonly BillingDestinationPin[], lookupAll: LookupAll) {
    this.#pins = new Map(pins.map((pin) => [pin.origin, pin]));
    this.#lookupAll = lookupAll;
  }

  origin(value: string): BootPinnedOrigin {
    const pin = this.#pins.get(value);
    if (pin === undefined) throw new Error("Billing transport refused an unconfigured origin.");
    return pin.origin;
  }

  async #assertNoDnsDrift(pin: BillingDestinationPin): Promise<void> {
    const current = await this.#lookupAll(pin.hostname, { all: true, verbatim: true });
    if (current.length === 0 || current.some((answer) => !isPublicUnicast(answer)) ||
        JSON.stringify([...new Set(current.map(answerKey))].sort()) !== JSON.stringify(pin.answerSet)) {
      throw new Error("Billing origin DNS drifted after boot.");
    }
  }

  async #request(url: URL, init: RequestInit, maxBytes?: number): Promise<Response> {
    const pin = this.#pins.get(url.origin);
    if (pin === undefined) throw new Error("Billing transport refused an unpinned origin.");
    await this.#assertNoDnsDrift(pin);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => { if (!settled) { settled = true; reject(error); } };
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      if (typeof init.body === "string") headers["content-length"] = String(Buffer.byteLength(init.body, "utf8"));
      headers["host"] = pin.hostname;
      const request = httpsRequest({
        protocol: "https:", hostname: pin.hostname, port: 443,
        path: `${url.pathname}${url.search}`, method: init.method ?? "GET",
        servername: pin.hostname, headers,
        lookup: (_hostname, _options, callback) => callback(null, pin.address, pin.family),
      }, (response) => {
        if (maxBytes === undefined) {
          settled = true;
          resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            status: response.statusCode ?? 502,
            headers: responseHeaders(response.headers),
          }));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) response.destroy(new Error("Billing RPC response exceeds its byte bound."));
          else chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 502,
            headers: responseHeaders(response.headers),
          }));
        });
      });
      request.on("error", fail);
      request.setTimeout(15_000, () => request.destroy(new Error("Billing transport request timed out.")));
      const abort = (): void => { request.destroy(new Error("Billing transport request aborted.")); };
      if (init.signal?.aborted === true) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      request.end(typeof init.body === "string" ? init.body : undefined);
    });
  }

  async readRpc(origin: BootPinnedOrigin, request: ClosedRpcRequest): Promise<unknown> {
    const configured = this.origin(origin);
    const body = rpcRequestBody(request);
    const response = await this.#request(new URL(configured), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" },
      body,
    }, MAX_RPC_BYTES);
    if (response.status !== 200 || response.headers.get("content-encoding")?.toLowerCase() === "gzip") {
      throw new Error("Billing RPC refused the closed request.");
    }
    const text = await response.text();
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error("Billing RPC returned malformed JSON."); }
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (input instanceof Request) throw new Error("Billing transport accepts core-owned URL requests only.");
    const url = new URL(typeof input === "string" ? input : input.href);
    validatePaidRequest(url, init);
    return this.#request(url, { ...init, method: init?.method ?? "GET", redirect: "error" });
  }

  async readOracleObservation(
    origin: string,
    feed: "0G_USD" | "BNB_USD" | "ARBITRUM_SEQUENCER",
  ): Promise<OracleObservation> {
    const pinned = this.origin(origin);
    const request: ClosedRpcRequest = feed === "BNB_USD"
      ? { chain: "bsc", kind: "bnb_oracle" }
      : feed === "0G_USD"
        ? { chain: "arbitrum", kind: "og_oracle" }
        : { chain: "arbitrum", kind: "sequencer" };
    const [chainId, descriptionRaw, decimalsRaw, roundRaw] = rpcResults(await this.readRpc(pinned, request), 4);
    const description = decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "description", data: descriptionRaw as Hex });
    const decimals = decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "decimals", data: decimalsRaw as Hex });
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = decodeFunctionResult({
      abi: CHAINLINK_ABI,
      functionName: "latestRoundData",
      data: roundRaw as Hex,
    });
    return bindTransportOracleObservation(origin, feed, {
      chainId: uint(chainId, "chain ID"),
      proxy: ORACLE_MANIFEST[feed].proxy,
      description,
      decimals,
      roundId,
      answer,
      startedAt: safeSecond(startedAt, "oracle startedAt"),
      updatedAt: safeSecond(updatedAt, "oracle updatedAt"),
      answeredInRound,
    });
  }

  async readReceiptObservation(
    origin: string,
    request: Extract<ClosedRpcRequest, { kind: "collection_proof" | "x402_proof" }>,
  ): Promise<RpcReceiptObservation | null> {
    const pinned = this.origin(origin);
    const first = await this.readRpc(pinned, request);
    const results = rpcResults(first, 4);
    if (results[1] === null) return null;
    const receipt = record(results[1], "transaction receipt");
    const blockNumber = receipt["blockNumber"];
    if (typeof blockNumber !== "string" || !/^0x[0-9a-fA-F]+$/u.test(blockNumber)) {
      throw new Error("Malformed receipt block number.");
    }
    const receiptBlockLookup = request.kind === "collection_proof"
      ? [
          { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [blockNumber, false] },
          {
            jsonrpc: "2.0", id: 2, method: "eth_getCode",
            params: [getAddress(request.collector), blockNumber],
          },
        ]
      : { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [blockNumber, false] };
    const response = await this.#request(new URL(pinned), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" },
      body: JSON.stringify(receiptBlockLookup),
    }, MAX_RPC_BYTES);
    if (response.status !== 200) throw new Error("Billing RPC refused the receipt block lookup.");
    const rawDecoded = JSON.parse(await response.text()) as unknown;
    if (request.kind === "collection_proof") {
      const [blockResult, runtimeCodeResult] = rpcResults(rawDecoded, 2);
      return parseReceiptObservation(request, first, blockResult, runtimeCodeResult);
    }
    const decoded = record(rawDecoded, "receipt block response");
    if (decoded["jsonrpc"] !== "2.0" || decoded["id"] !== 1 || "error" in decoded) {
      throw new Error("Malformed receipt block response.");
    }
    return parseReceiptObservation(request, first, decoded["result"]);
  }

  async readX402AuthorizationObservation(
    origin: string,
    facts: X402UsageFacts,
  ): Promise<X402AuthorizationObservation> {
    const pinned = this.origin(origin);
    const request: ClosedRpcRequest = {
      chain: "base",
      kind: "x402_authorization",
      usdcAddress: facts.usdcAddress,
      authorizer: facts.authorizer,
      authorizationNonce: facts.authorizationNonce,
    };
    const [chainRaw, finalizedRaw] = rpcResults(
      await this.readRpc(pinned, request),
      2,
    );
    const chainId = uint(chainRaw, "Base chain ID");
    if (chainId !== 8_453n) throw new Error("x402 authorization RPC substituted the Base chain.");
    const finalized = record(finalizedRaw, "Base finalized block");
    const finalizedBlock = uint(finalized["number"], "Base finalized block number");
    const finalizedBlockTag = `0x${finalizedBlock.toString(16)}`;
    const usdcAddress = getAddress(facts.usdcAddress);
    const authorizer = getAddress(facts.authorizer);
    const response = await this.#request(new URL(pinned), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{
            to: usdcAddress,
            data: encodeFunctionData({
              abi: USDC_AUTHORIZATION_STATE_ABI,
              functionName: "authorizationState",
              args: [authorizer, facts.authorizationNonce as Hex],
            }),
          }, finalizedBlockTag],
        },
        {
          jsonrpc: "2.0", id: 2, method: "eth_getLogs",
          params: [{
            address: usdcAddress,
            fromBlock: "earliest",
            toBlock: finalizedBlockTag,
            topics: [
              AUTHORIZATION_USED_TOPIC,
              padHex(authorizer, { size: 32 }),
              facts.authorizationNonce,
            ],
          }],
        },
      ]),
    }, MAX_RPC_BYTES);
    if (response.status !== 200) throw new Error("Billing RPC refused the block-pinned x402 authorization lookup.");
    const [authorizationRaw, logsRaw] = rpcResults(JSON.parse(await response.text()) as unknown, 2);
    const authorizationUsed = decodeFunctionResult({
      abi: USDC_AUTHORIZATION_STATE_ABI,
      functionName: "authorizationState",
      data: bytes(authorizationRaw, "USDC authorizationState result"),
    });
    if (!Array.isArray(logsRaw) || logsRaw.length > 1) {
      throw new Error("x402 authorization identity returned an ambiguous event set.");
    }
    let candidateTransactionHash: Hex | undefined;
    if (logsRaw.length === 1) {
      const log = record(logsRaw[0], "AuthorizationUsed log");
      const topics = log["topics"];
      if (
        address(log["address"], "AuthorizationUsed log address") !== facts.usdcAddress.toLowerCase() ||
        !Array.isArray(topics) || topics.length !== 3 ||
        hash(topics[0], "AuthorizationUsed topic") !== AUTHORIZATION_USED_TOPIC ||
        bytes(topics[1], "AuthorizationUsed authorizer topic") !== padHex(getAddress(facts.authorizer), { size: 32 }).toLowerCase() ||
        hash(topics[2], "AuthorizationUsed nonce topic") !== facts.authorizationNonce.toLowerCase()
      ) throw new Error("x402 authorization event identity drifted.");
      candidateTransactionHash = hash(log["transactionHash"], "AuthorizationUsed transaction hash");
    }
    if (authorizationUsed !== (candidateTransactionHash !== undefined)) {
      throw new Error("USDC authorizationState disagrees with its canonical event identity.");
    }
    return {
      chainId: 8453,
      finalizedBlock,
      finalizedBlockHash: hash(finalized["hash"], "Base finalized block hash"),
      finalizedTimestamp: uint(finalized["timestamp"], "Base finalized block timestamp"),
      authorizationUsed,
      ...(candidateTransactionHash === undefined ? {} : { candidateTransactionHash }),
    };
  }

  async close(): Promise<void> { /* Each request owns and closes its socket. */ }
}

export async function createPinnedBillingTransport(
  config: EnabledBillingConfig,
  lookupAll: LookupAll = dnsLookup as LookupAll,
): Promise<PinnedBillingTransport> {
  return new CorePinnedBillingTransport(await resolveBillingDestinationPins(config, lookupAll), lookupAll);
}
