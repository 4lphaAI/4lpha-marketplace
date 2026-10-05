/** Low-level x402 payment path for the optional CMC context request. */
import { randomBytes } from "node:crypto";
import { signX402Payment, type Session, type X402PaymentPayload, type X402Requirement } from "@altananetwork/sdk";
import { bytesToHex, getAddress, type Address, type Hex } from "viem";
import {
  CMC_MCP_URL,
  CMC_MAX_RESPONSE_BYTES,
  CMC_REQUEST_TIMEOUT_MS,
  decryptCmcAuthorization,
  encryptCmcAuthorization,
  hashCmcBody,
  parseCmcChallenge,
  type CmcAuthorizationIdentity,
  type CmcChallenge,
} from "./cmc.js";
import type { CmcBudgetStore, CmcAttemptRecord } from "../store/tradeCmc.js";

export type CmcHttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type CmcTransport = {
  request(input: {
    readonly url: string;
    readonly body: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<CmcHttpResponse>;
};

/** Production transport: exactly the requested URL, no redirect or retry. */
export function createCmcFetchTransport(fetchImpl: typeof fetch = fetch): CmcTransport {
  return {
    async request(input) {
      if (input.body.length > CMC_MAX_RESPONSE_BYTES) throw new Error("CMC request body is too large.");
      const timeoutSignal = AbortSignal.timeout(CMC_REQUEST_TIMEOUT_MS);
      const signal = input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
      const response = await fetchImpl(input.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(input.headers ?? {}) },
        body: input.body,
        redirect: "error",
        signal,
      });
      const body = await readBoundedBody(response, CMC_MAX_RESPONSE_BYTES);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      return { status: response.status, headers, body };
    },
  };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number.isSafeInteger(Number(lengthHeader)) && Number(lengthHeader) > maxBytes) {
    throw new Error("CMC response is too large.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("CMC response is too large.");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error("CMC response is too large.");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, total));
}
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export type CmcSignedAuthorization = {
  readonly header: string;
  readonly payload: X402PaymentPayload;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly validAfter: bigint;
  readonly token: Address;
  readonly payer: Address;
  readonly spender: Address;
  readonly witnessTo: Address;
};

export type CmcPaymentSigner = {
  sign(input: {
    readonly agentId: string;
    readonly challenge: CmcChallenge;
    readonly wallet: Address;
    readonly sessionExpiry: number;
    readonly nonce: bigint;
    readonly nowSec: number;
    readonly onSigned: (authorization: CmcSignedAuthorization) => Promise<void>;
  }): Promise<CmcSignedAuthorization>;
};

export type CmcRuntimeAuthorization = (input: {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly wallet: Address;
  readonly amountWei: bigint;
  readonly generation: number;
  readonly sessionPublicKey: Hex;
  readonly sessionExpiry: number;
  readonly operationId?: string;
}) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;

/**
 * Adapter around the SDK's low-level signer. The convenience fetch helper is
 * intentionally not used: the challenge is selected and pinned before this
 * function is called, and the signed payload is persisted before it returns.
 */
export function createCmcSdkPaymentSigner(input: {
  readonly sessionForAgent: (agentId: string) => Promise<Session>;
}): CmcPaymentSigner {
  return {
    async sign(request) {
      const session = await input.sessionForAgent(request.agentId);
      if (session.walletAddress.toLowerCase() !== request.wallet.toLowerCase()
        || session.expiry !== request.sessionExpiry) throw new Error("CMC session identity changed.");
      const remaining = session.expiry - request.nowSec;
      const timeout = Math.min(request.challenge.maxTimeoutSeconds, remaining);
      if (timeout <= 0) throw new Error("CMC session expires before payment deadline.");
      const extra = {
        name: "Tether USD",
        version: "1",
        assetTransferMethod: "permit2-exact",
        spenderAddress: request.challenge.spender,
        signerAddress: request.challenge.signerAddress,
        x402PaymentConfigId: "69ef242f50455dcce02f3c2f",
      } as X402Requirement["extra"] & { readonly x402PaymentConfigId: string };
      const requirement: X402Requirement = {
        x402Version: 2,
        scheme: "exact",
        network: request.challenge.network,
        asset: request.challenge.asset,
        amount: request.challenge.amountWei.toString(10),
        payTo: request.challenge.payTo,
        maxTimeoutSeconds: timeout,
        resource: request.challenge.resource,
        extra,
      };
      const signed = await signX402Payment(session, requirement, {
        now: request.nowSec,
        permit2Nonce: request.nonce,
        permit2ValidAfter: 0n,
      });
      const authorization = readSignedAuthorization(signed.header, signed.payload, request.challenge, request.wallet, request.nowSec);
      await request.onSigned(authorization);
      return authorization;
    },
  };
}

export function readSignedAuthorization(
  header: string,
  payload: X402PaymentPayload,
  challenge: CmcChallenge,
  wallet: Address,
  nowSec: number,
  /** Agentic only: Binance signs validAfter as the signing time, so accept 0 <= validAfter <= validAfterMaxSec and < deadline. Absent: validAfter must be 0. */
  options?: { readonly validAfterMaxSec?: number },
): CmcSignedAuthorization {
  const inner = record(payload.payload) ? payload.payload : null;
  const permit = inner !== null && record(inner["permit2Authorization"]) ? inner["permit2Authorization"] : null;
  const permitted = permit !== null && record(permit["permitted"]) ? permit["permitted"] : null;
  const witness = permit !== null && record(permit["witness"]) ? permit["witness"] : null;
  if (permit === null || permitted === null || witness === null
    || typeof permit["from"] !== "string" || typeof permit["spender"] !== "string"
    || typeof permit["nonce"] !== "string" || typeof permit["deadline"] !== "string"
    || typeof permitted["token"] !== "string" || typeof permitted["amount"] !== "string"
    || typeof witness["to"] !== "string" || typeof witness["validAfter"] !== "string") {
    throw new Error("CMC signer returned a malformed Permit2 authorization.");
  }
  const payer = getAddress(permit["from"]);
  const token = getAddress(permitted["token"]);
  const spender = getAddress(permit["spender"]);
  const witnessTo = getAddress(witness["to"]);
  const amount = BigInt(permitted["amount"]);
  const nonce = BigInt(permit["nonce"]);
  const deadline = BigInt(permit["deadline"]);
  const validAfter = BigInt(witness["validAfter"]);
  if (payer.toLowerCase() !== wallet.toLowerCase() || token.toLowerCase() !== challenge.asset.toLowerCase()
    || amount !== challenge.amountWei || spender.toLowerCase() !== challenge.spender.toLowerCase()
    || witnessTo.toLowerCase() !== challenge.payTo.toLowerCase()
    || (options?.validAfterMaxSec === undefined ? validAfter !== 0n : validAfter < 0n || validAfter > BigInt(options.validAfterMaxSec) || validAfter >= deadline)
    || deadline <= BigInt(nowSec)) throw new Error("CMC authorization does not match its challenge.");
  return { header, payload, nonce, deadline, validAfter, token, payer, spender, witnessTo };
}

export type CmcPaymentClient = {
  authorize(input: Parameters<CmcRuntimeAuthorization>[0]): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  fetchChallenge(input: { readonly body: string; readonly expectedResource?: string; readonly signal?: AbortSignal }): Promise<CmcChallenge>;
  reserve(input: Parameters<CmcBudgetStore["reserve"]>[0]): ReturnType<CmcBudgetStore["reserve"]>;
  prepare(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly wallet: Address;
    readonly operationId: string;
    readonly body: string;
    readonly attemptId: string;
    readonly requestDigest: Hex;
    readonly challenge: CmcChallenge;
    readonly sessionPublicKey: Hex;
    readonly sessionExpiry: number;
    readonly generation: number;
    readonly masterKey: Buffer;
    readonly nowSec?: number;
    readonly nowMs?: number;
  }): Promise<CmcAttemptRecord | null>;
  transmit(input: {
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly wallet: Address;
    readonly operationId: string;
    readonly body: string;
    readonly generation: number;
    readonly masterKey: Buffer;
    readonly signal?: AbortSignal;
  }): Promise<CmcHttpResponse>;
};

export function createCmcPaymentClient(input: {
  readonly store: CmcBudgetStore;
  readonly signer: CmcPaymentSigner;
  readonly transport: CmcTransport;
  readonly now?: () => number;
  readonly authorize: CmcRuntimeAuthorization;
}): CmcPaymentClient {
  const now = input.now ?? (() => Date.now());
  return {
    authorize: input.authorize,
    async fetchChallenge(request) {
      const response = await input.transport.request({ url: CMC_MCP_URL, body: request.body, ...(request.signal === undefined ? {} : { signal: request.signal }) });
      if (response.status !== 402) throw new Error("CMC challenge was not HTTP 402.");
      const encoded = response.headers["payment-required"] ?? response.headers["PAYMENT-REQUIRED"];
      if (encoded === undefined || encoded.length > CMC_MAX_RESPONSE_BYTES * 2) throw new Error("CMC challenge is missing PAYMENT-REQUIRED.");
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown; } catch { throw new Error("CMC challenge header is not valid JSON."); }
      const challenge = parseCmcChallenge(parsed, request.expectedResource);
      if (challenge === null) throw new Error("CMC challenge did not match the pinned payment contract.");
      return challenge;
    },
    reserve(reservation) { return input.store.reserve(reservation); },
    async prepare(request) {
      const nowMs = request.nowMs ?? now();
      const nowSec = request.nowSec ?? Math.floor(nowMs / 1000);
      const nonce = BigInt(`0x${randomBytes(32).toString("hex")}`);
      const deadline = BigInt(Math.min(nowSec + request.challenge.maxTimeoutSeconds, request.sessionExpiry));
      if (deadline <= BigInt(nowSec)) throw new Error("CMC session expires before payment deadline.");
      const prepared = await input.store.prepare({
        agentId: request.agentId, ownerAddress: request.ownerAddress, wallet: request.wallet, operationId: request.operationId,
        generation: request.generation, sessionPublicKey: request.sessionPublicKey,
        sessionExpiry: request.sessionExpiry, asset: request.challenge.asset,
        amountWei: request.challenge.amountWei, spender: request.challenge.spender,
        payee: request.challenge.payTo, witnessTo: request.challenge.payTo, validAfter: 0n,
        deadline, nonce, requestDigest: request.requestDigest, bodyHash: hashCmcBody(request.body), nowMs,
      });
      if (prepared === null) return null;
      try {
        await input.signer.sign({ agentId: request.agentId, challenge: request.challenge,
          wallet: request.wallet, sessionExpiry: request.sessionExpiry, nonce, nowSec,
          onSigned: async (authorization) => {
            const identity: CmcAuthorizationIdentity = { chainId: 56, wallet: request.wallet,
              agentId: request.agentId, budgetGeneration: request.generation,
              nonce: `0x${authorization.nonce.toString(16).padStart(64, "0")}` as Hex };
            const ciphertext = encryptCmcAuthorization({ identity, masterKey: request.masterKey,
              payload: { header: authorization.header, payload: authorization.payload } });
            const saved = await input.store.saveAuthorization({ agentId: request.agentId,
              ownerAddress: request.ownerAddress, operationId: request.operationId,
              generation: request.generation, encryptedAuthorization: ciphertext, nowMs });
            if (saved === null) throw new Error("CMC authorization was not durably persisted.");
          },
        });
      } catch (error) {
        await input.store.release({ agentId: request.agentId, ownerAddress: request.ownerAddress,
          operationId: request.operationId, generation: request.generation, proof: { kind: "no-disclosure" }, nowMs });
        throw error;
      }
      return input.store.getAttempt(request.agentId, request.ownerAddress, request.operationId);
    },
    async transmit(request) {
      const attempt = await input.store.getAttempt(request.agentId, request.ownerAddress, request.operationId);
      if (attempt === null || attempt.generation !== request.generation || attempt.state !== "prepared"
        || attempt.encryptedAuthorization === null || attempt.nonce === null || attempt.bodyHash === null || attempt.sessionPublicKey === null
        || hashCmcBody(request.body).toLowerCase() !== attempt.bodyHash.toLowerCase()) throw new Error("CMC payment is not prepared for this body.");
      const budget = await input.store.get(request.agentId, request.ownerAddress);
      const nowSec = Math.floor((input.now ?? (() => Date.now()))() / 1000);
      const authorization = await input.authorize({ agentId: request.agentId, ownerAddress: request.ownerAddress,
        wallet: request.wallet, amountWei: attempt.amountWei, generation: request.generation, sessionPublicKey: attempt.sessionPublicKey,
        operationId: request.operationId,
        sessionExpiry: attempt.sessionExpiry ?? 0 });
      if (!authorization.ok) throw new Error(authorization.reason);
      if (budget === null || budget.pendingOperationId !== request.operationId || !budget.optedIn
        || !budget.setupProved || !budget.capabilityAvailable || budget.reason !== null
        || attempt.sessionExpiry === null || attempt.sessionExpiry <= nowSec + Math.ceil(CMC_REQUEST_TIMEOUT_MS / 1000)
        || attempt.deadline === null || attempt.deadline <= BigInt(nowSec)) {
        throw new Error("CMC payment is unavailable before disclosure.");
      }
      const identity: CmcAuthorizationIdentity = { chainId: 56, wallet: request.wallet,
        agentId: request.agentId, budgetGeneration: request.generation,
        nonce: `0x${attempt.nonce.toString(16).padStart(64, "0")}` as Hex };
      const raw = decryptCmcAuthorization({ ciphertext: attempt.encryptedAuthorization, identity, masterKey: request.masterKey });
      if (!record(raw) || typeof raw["header"] !== "string") throw new Error("CMC authorization envelope is malformed.");
      const transmitting = await input.store.transition({ agentId: request.agentId,
        ownerAddress: request.ownerAddress, operationId: request.operationId, generation: request.generation,
        from: "prepared", to: "transmitting", disclosurePossible: true });
      if (transmitting === null) throw new Error("CMC payment disclosure CAS failed.");
      try {
        const response = await input.transport.request({ url: CMC_MCP_URL, body: request.body,
          headers: { "x-payment": raw["header"], "payment-signature": raw["header"] }, ...(request.signal === undefined ? {} : { signal: request.signal }) });
        const hint = parseSettlementResponseHint(response.headers);
        if (hint !== null) await input.store.setSettlementHint({ agentId: request.agentId, ownerAddress: request.ownerAddress,
          operationId: request.operationId, generation: request.generation, txHashHint: hint });
        return response;
      } catch (error) {
        await input.store.markUnknown({ agentId: request.agentId, ownerAddress: request.ownerAddress,
          operationId: request.operationId, generation: request.generation });
        throw error;
      }
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettlementResponseHint(headers: Readonly<Record<string, string>>): Hex | null {
  const encoded = headers["payment-response"] ?? headers["x-payment-response"];
  if (encoded === undefined || encoded.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    if (!record(value) || value["success"] === false) return null;
    const network = value["network"];
    if (network !== undefined && network !== "eip155:56") return null;
    const tx = value["transaction"] ?? value["transactionHash"];
    return typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/u.test(tx) ? tx as Hex : null;
  } catch { return null; }
}

export type CmcPaymentWiring = {
  readonly signer: CmcPaymentSigner;
  readonly transport: CmcTransport;
};

/** Concrete production wiring factory; callers supply only session restoration. */
export function createCmcProductionPaymentWiring(input: {
  readonly sessionForAgent: (agentId: string) => Promise<Session>;
  readonly fetchImpl?: typeof fetch;
}): CmcPaymentWiring {
  return { signer: createCmcSdkPaymentSigner({ sessionForAgent: input.sessionForAgent }), transport: createCmcFetchTransport(input.fetchImpl) };
}

export function newCmcNonce(): bigint {
  return BigInt(bytesToHex(randomBytes(32)));
}
