/**
 * Phase 3.9c C1: the owned prepare -> durable bind -> sign -> send boundary.
 *
 * This module intentionally does not use Altana's `Client.execute`: that public
 * method is one indivisible operation.  Porto's public RelayActions are the
 * supported seam that lets the execution journal become durable before a
 * signature exists.  The raw session key is accepted only by `submit`, is not
 * retained on the adapter, and is never included in an error.
 */
import {
  createClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  prepareCalls,
  sendPreparedCalls,
  signCalls,
} from "porto/viem/RelayActions";
import * as Key from "porto/viem/Key";
import type { NetworkConfig } from "@altananetwork/sdk";
import type {
  ExecutionReceipt,
  WalletCall,
} from "../core/types.js";
import { validateSessionSpec } from "../core/session.js";
import type { SessionFacts } from "../store/agents.js";
import type { WorkerFence } from "../deployment/workerSingleton.js";
import {
  canonicalProviderPermissionsV1 as canonicalProviderPermissionsWitness,
  encodeLpFinalCallsV1 as encodeLpFinalCallsWitness,
  fingerprintLpFinalCallsV1 as fingerprintLpFinalCallsWitness,
} from "./preparedIntentWitness.js";

export const LP_FINAL_CALLS_SCHEME = "porto-erc7579-calls-v1" as const;
export const PORTO_INTENT_SCHEME = "porto-intent-v1" as const;
export const PORTO_V055_DECODER = "porto-orchestrator-intent-v055" as const;
export const PORTO_V055_ORCHESTRATOR =
  "0xaf140d0416a994aebb3fa6212b16ce6700f09751" as Address;
export const PORTO_V055_VERSION = "0.5.5" as const;

/**
 * The ONE token the relay bills gas in on chain 56, passed explicitly on every
 * staged prepare.
 *
 * `wallet_getCapabilities` reports exactly one entry under `0x38`:
 * `fees.tokens = [{ uid: "bnb", address: 0x00…00, feeToken: true }]`. There is
 * no ERC-20 fee token. Porto's `prepareCalls` defaults an OMITTED `feeToken`
 * to `key.permissions.spend[0].token` — and `validateSessionSpec` sorts spend
 * permissions on the lowercased token address, with the native cap (no token)
 * sorting LAST, so `spend[0]` is the LEXICOGRAPHICALLY LOWEST granted ERC-20 —
 * the pool token or WBNB, never native. The relay then refuses the whole
 * prepare with `fee token not supported: <that ERC-20>`, which surfaces here
 * as a pre-bind refusal and rolls the sequence back before anything is signed.
 *
 * That is not a hypothetical: the 2026-08-21 BTCB open refused exactly this
 * way, with BTCB's address in the relay's message. (The 08-20 ETH open failed
 * EARLIER and for an unrelated, since-fixed reason — the JSONB key-order
 * permissions witness; see the `PHASE3.9C-LIVE-SUBMIT-FIX-*` chain.) Omitting
 * this field makes the fee token a function of the session's token list, so it
 * must stay explicit.
 */
export const PORTO_NATIVE_FEE_TOKEN =
  "0x0000000000000000000000000000000000000000" as Address;

/**
 * Whether a relay-prepared intent's `expiry` is compatible with the session.
 *
 * The BSC relay returns `0` here on every quote: the Porto orchestrator's
 * intent struct carries an `expiry` field, but this deployment does not bind a
 * deadline at the INTENT layer — the quote's own TTL (`quoteConfig.ttl`, 30s)
 * governs how long the prepared object may be sent, and the SESSION KEY's
 * expiry is enforced on chain by the KeyStore. An intent signed by a key whose
 * expiry has passed reverts regardless of what this field says, which is the
 * hard stop this plane relies on everywhere else.
 *
 * The original check demanded exact equality with the session expiry. That was
 * written against an ASSUMED response shape and can never hold against the
 * live relay, so it refused every staged LP submit after the fee token was
 * fixed. `0` is therefore accepted as the relay's "no intent-level deadline"
 * sentinel. A NONZERO value is still constrained, and constrained from BOTH
 * ends: it may tighten the window but never outlive the session, and it must
 * still be in the future.
 *
 * The lower bound is FIXREVIEW7 F6. A nonzero expiry already in the past is
 * not a safety hole — the orchestrator would revert `IntentExpired` — but it
 * is the wrong KIND of failure: the condition is detectable here, BEFORE the
 * durable bind, where it rolls back cleanly and releases the reservation.
 * Admitting it instead spends a signature on an intent that cannot land and
 * turns a clean refusal into a post-bind UNKNOWN.
 */
function acceptableIntentExpiry(
  intentExpiry: bigint,
  sessionExpiry: number,
  nowSec: number,
): boolean {
  if (intentExpiry === 0n) return true;
  return intentExpiry > BigInt(nowSec) && intentExpiry <= BigInt(sessionExpiry);
}

const HASH = /^0x[0-9a-f]{64}$/;
const SEC1 = /^0x04[0-9a-f]{128}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;

export type FinalCallsFingerprintV1 = {
  readonly scheme: typeof LP_FINAL_CALLS_SCHEME;
  readonly executionDataHash: Hex;
};

export type PreparedIntentIdentityV1 = {
  readonly scheme: typeof PORTO_INTENT_SCHEME;
  readonly decoder: typeof PORTO_V055_DECODER;
  readonly chainId: "56";
  readonly eoa: Address;
  readonly orchestrator: Address;
  readonly orchestratorVersion: typeof PORTO_V055_VERSION;
  readonly nonce: string;
  readonly expiry: string;
  readonly executionDataHash: Hex;
  readonly keyHash: Hex;
};

export type PreparedIntentBindRequest = {
  readonly journalIdempotencyKey: string;
  readonly canonicalIdentity: string;
  readonly identityHash: Hex;
  readonly expectedBindingVersion: number;
  /** Object identity is the in-process unforgeable prepared-object handle. */
  readonly preparedHandle: object;
  readonly preparedDigest: Hex;
};

export type PreparedIntentBindingToken = PreparedIntentBindRequest & {
  readonly boundBindingVersion: number;
};

export type PreparedIntentBinder = (
  request: PreparedIntentBindRequest,
) => Promise<PreparedIntentBindingToken>;

export type PortoStagedLpSubmit = {
  readonly journalIdempotencyKey: string;
  readonly expectedBindingVersion: number;
  readonly sessionPrivateKey: Hex;
  readonly walletAddress: Address;
  readonly persistedSession: SessionFacts;
  readonly restoredSessionPublicKey: Hex;
  readonly restoredSessionExpiry: number;
  readonly calls: readonly WalletCall[];
  readonly expectedExecutionDataHash: Hex;
  readonly bind: PreparedIntentBinder;
  readonly signal?: AbortSignal;
};

/**
 * The sole positive proof that a staged LP failure happened before the binder
 * was even invoked.  Its class is deliberately module-private: callers may
 * observe the proof through {@link isProvenPreBindStagedLpError}, but cannot
 * turn a generic provider error into permission to release a reservation.
 */
class ProvenPreBindStagedLpError extends Error {
  readonly #proven = true;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "LP staged submit refused before bind.");
    this.name = "ProvenPreBindStagedLpError";
  }

  get proven(): true {
    return this.#proven;
  }
}

export function isProvenPreBindStagedLpError(error: unknown): boolean {
  return error instanceof ProvenPreBindStagedLpError && error.proven === true;
}

type PortoFunctions = {
  readonly prepare: typeof prepareCalls;
  readonly sign: typeof signCalls;
  readonly send: typeof sendPreparedCalls;
};

export type PortoStagedLpAdapterOptions = {
  readonly network: NetworkConfig;
  /** Authority checked immediately at each prepare/bind/sign/send boundary. */
  readonly workerFence?: WorkerFence;
  readonly transport?: (url: string) => Transport;
  readonly functions?: PortoFunctions;
  /** Per-relay-operation ceiling inherited from the owning wallet provider. */
  readonly submitTimeoutMs?: number;
};

export function encodeLpFinalCallsV1(calls: readonly WalletCall[]): Hex {
  return encodeLpFinalCallsWitness(calls);
}

export function fingerprintLpFinalCallsV1(
  calls: readonly WalletCall[],
): { readonly value: FinalCallsFingerprintV1; readonly canonical: string; readonly hash: Hex } {
  return fingerprintLpFinalCallsWitness(calls);
}

/** Strict parser for the durable v1 final-calls witness. */
export function parseLpFinalCallsFingerprintV1(canonical: string): FinalCallsFingerprintV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    throw new Error("LP final-calls fingerprint is not canonical JSON.");
  }
  if (!isRecord(parsed) || Object.keys(parsed).join("|") !== "scheme|executionDataHash" ||
      parsed["scheme"] !== LP_FINAL_CALLS_SCHEME ||
      typeof parsed["executionDataHash"] !== "string" ||
      !HASH.test(parsed["executionDataHash"])) {
    throw new Error("LP final-calls fingerprint has an unsupported shape.");
  }
  const value: FinalCallsFingerprintV1 = {
    scheme: LP_FINAL_CALLS_SCHEME,
    executionDataHash: parsed["executionDataHash"] as Hex,
  };
  if (JSON.stringify(value) !== canonical) {
    throw new Error("LP final-calls fingerprint is not canonical.");
  }
  return value;
}

export function canonicalPreparedIntentIdentityV1(
  value: PreparedIntentIdentityV1,
): { readonly canonical: string; readonly hash: Hex } {
  assertPreparedIdentity(value);
  const canonical = JSON.stringify({
    scheme: value.scheme,
    decoder: value.decoder,
    chainId: value.chainId,
    eoa: value.eoa.toLowerCase(),
    orchestrator: value.orchestrator.toLowerCase(),
    orchestratorVersion: value.orchestratorVersion,
    nonce: value.nonce,
    expiry: value.expiry,
    executionDataHash: value.executionDataHash.toLowerCase(),
    keyHash: value.keyHash.toLowerCase(),
  });
  if (Buffer.byteLength(canonical, "utf8") > 1_024) {
    throw new Error("Prepared intent identity exceeds 1024 bytes.");
  }
  return { canonical, hash: keccak256(toUtf8Hex(canonical)) };
}

export function parsePreparedIntentIdentityV1(
  canonical: string,
): PreparedIntentIdentityV1 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(canonical);
  } catch {
    throw new Error("Prepared intent identity is not canonical JSON.");
  }
  if (!isRecord(decoded)) throw new Error("Prepared intent identity must be an object.");
  const expectedKeys = [
    "scheme", "decoder", "chainId", "eoa", "orchestrator",
    "orchestratorVersion", "nonce", "expiry", "executionDataHash", "keyHash",
  ];
  if (Object.keys(decoded).join("|") !== expectedKeys.join("|")) {
    throw new Error("Prepared intent identity has unknown, missing, or reordered keys.");
  }
  const value = decoded as PreparedIntentIdentityV1;
  assertPreparedIdentity(value);
  if (canonicalPreparedIntentIdentityV1(value).canonical !== canonical) {
    throw new Error("Prepared intent identity is not canonical.");
  }
  return value;
}

/** Public-Porto implementation.  Construction performs no network I/O. */
export class PortoStagedLpAdapter {
  readonly #network: NetworkConfig;
  readonly #client: Client<Transport, Chain, undefined>;
  readonly #functions: PortoFunctions;
  readonly #submitTimeoutMs: number;
  readonly #workerFence: WorkerFence | undefined;

  constructor(options: PortoStagedLpAdapterOptions) {
    if (options.network.chainId !== 56) {
      throw new Error("Porto staged LP execution is registered only for chain 56.");
    }
    const relayUrl = options.network.relayUrl;
    if (relayUrl === undefined || relayUrl.trim() === "") {
      throw new Error("Porto staged LP execution requires the pinned Altana relay URL.");
    }
    const parsed = new URL(relayUrl);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
        parsed.search !== "" || parsed.hash !== "") {
      throw new Error("The staged LP relay must be a credential-free HTTPS origin.");
    }
    this.#network = options.network;
    const transport = options.transport ?? ((url: string) => http(url));
    this.#client = createClient({
      chain: options.network.chain as Chain,
      transport: transport(parsed.origin),
    });
    this.#functions = options.functions ?? {
      prepare: prepareCalls,
      sign: signCalls,
      send: sendPreparedCalls,
    };
    this.#workerFence = options.workerFence;
    this.#submitTimeoutMs = options.submitTimeoutMs ?? 45_000;
    if (!Number.isSafeInteger(this.#submitTimeoutMs) || this.#submitTimeoutMs <= 0 ||
        this.#submitTimeoutMs > 300_000) {
      throw new Error("Porto staged LP submit timeout is outside 1..300000ms.");
    }
  }

  async submit(input: PortoStagedLpSubmit): Promise<ExecutionReceipt> {
    let bindInvoked = false;
    try {
      if (input.signal?.aborted === true) throw new Error("Request aborted before LP prepare.");
      const facts = input.persistedSession;
      const rederived = validateSessionSpec(facts.spec, { minSessionSeconds: 0 });
      if (canonicalProviderPermissionsV1(rederived) !== canonicalProviderPermissionsV1(facts.permissions)) {
        throw new Error("Persisted and re-derived session permissions differ.");
      }
      if (facts.expiry !== facts.spec.expiresAt || facts.expiry !== input.restoredSessionExpiry) {
        throw new Error("Persisted and restored session expiry differ.");
      }
      const persistedSec1 = canonicalSec1(facts.publicKey, "persisted session public key");
      const restoredSec1 = canonicalSec1(
        input.restoredSessionPublicKey,
        "restored session public key",
      );
      const account = privateKeyToAccount(input.sessionPrivateKey);
      const derivedSec1 = canonicalSec1(account.publicKey, "derived session public key");
      if (persistedSec1 !== derivedSec1 || restoredSec1 !== derivedSec1) {
        throw new Error("Session private key does not match persisted/restored SEC1 identity.");
      }
      const selectedKey = Key.fromSecp256k1({
        privateKey: input.sessionPrivateKey,
        role: "session",
        expiry: facts.expiry,
        permissions: rederived,
      });
      if (
        selectedKey.type !== "secp256k1" ||
        selectedKey.role !== "session" ||
        selectedKey.expiry !== facts.expiry ||
        selectedKey.publicKey.toLowerCase() !== account.address.toLowerCase() ||
        canonicalProviderPermissionsV1(selectedKey.permissions ?? {}) !==
          canonicalProviderPermissionsV1(rederived)
      ) {
        throw new Error("Porto selected key does not reproduce the persisted session descriptor.");
      }
      const keyHash = Key.hash(selectedKey).toLowerCase() as Hex;
      if (!HASH.test(keyHash)) throw new Error("Porto selected key hash is malformed.");
      const fingerprint = fingerprintLpFinalCallsV1(input.calls);
      if (fingerprint.value.executionDataHash !== input.expectedExecutionDataHash.toLowerCase()) {
        throw new Error("Final calls differ from the journaled execution-data fingerprint.");
      }

      this.#workerFence?.assertOpen();
      const prepared = await withTimeout(this.#functions.prepare(this.#client, {
      account: getAddress(input.walletAddress),
      chain: this.#network.chain,
      calls: input.calls.map((call) => ({
        to: getAddress(call.to),
        value: call.value ?? 0n,
        data: call.data ?? "0x",
      })),
      key: selectedKey,
      feeToken: PORTO_NATIVE_FEE_TOKEN,
      }), this.#submitTimeoutMs, "Porto LP prepare timed out before a durable send result.");
      this.#workerFence?.assertOpen();
      const quote = prepared.capabilities.quote;
      if (quote.quotes.length !== 1) throw new Error("Porto prepare did not return one chain quote.");
      const selectedQuote = quote.quotes[0];
      if (selectedQuote === undefined || selectedQuote.chainId !== 56) {
        throw new Error("Porto prepare quote is not for chain 56.");
      }
      const orchestrator = selectedQuote.orchestrator.toLowerCase();
      if (orchestrator !== PORTO_V055_ORCHESTRATOR) {
        throw new Error("Porto prepare selected an unregistered orchestrator.");
      }
      const intent = selectedQuote.intent;
      if (
        intent.eoa.toLowerCase() !== input.walletAddress.toLowerCase() ||
        keccak256(intent.executionData).toLowerCase() !== fingerprint.value.executionDataHash ||
        !acceptableIntentExpiry(intent.expiry, facts.expiry, Math.floor(Date.now() / 1_000))
      ) {
        throw new Error("Porto prepared intent does not match the journal/session identity.");
      }
      if (
        prepared.key?.type !== selectedKey.type ||
        prepared.key.publicKey.toLowerCase() !== selectedKey.publicKey.toLowerCase() ||
        !HASH.test(prepared.digest.toLowerCase()) ||
        prepared.context === undefined || prepared.capabilities === undefined ||
        prepared.typedData === undefined
      ) {
        throw new Error("Porto prepare returned an incomplete or substituted object.");
      }
      // GRID-GAS-RESERVE P1 — a quote the relay ALREADY says cannot execute is
      // refused HERE, in the pre-bind window, and nowhere later. The relay
      // reports `feeTokenDeficit` / `assetDeficits` at prepare time and then
      // refuses the SEND ("quote has asset deficits and is expected to fail");
      // binding first turned that refusal into a post-bind UNKNOWN — the
      // `grid-agent-01-5` wedge of 2026-09-03 (wallet B 0.000098693 BNB against
      // a ~0.00013 BNB metered shift). Thrown before `bindInvoked`, this is a
      // `ProvenPreBindStagedLpError` and the saga rolls the step back. A send
      // that fails WITHOUT a quoted deficit stays UNKNOWN: it may have landed.
      const deficits = portoQuoteDeficits(selectedQuote);
      if (deficits.short) {
        throw new Error(`Porto quote reports deficits before bind: ${deficits.summary}`);
      }

      const identity: PreparedIntentIdentityV1 = {
      scheme: PORTO_INTENT_SCHEME,
      decoder: PORTO_V055_DECODER,
      chainId: "56",
      eoa: intent.eoa.toLowerCase() as Address,
      orchestrator: orchestrator as Address,
      orchestratorVersion: PORTO_V055_VERSION,
      nonce: intent.nonce.toString(10),
      expiry: intent.expiry.toString(10),
      executionDataHash: fingerprint.value.executionDataHash,
      keyHash,
      };
      const canonical = canonicalPreparedIntentIdentityV1(identity);
      const preparedHandle = Object.freeze({});
      const request: PreparedIntentBindRequest = {
      journalIdempotencyKey: input.journalIdempotencyKey,
      canonicalIdentity: canonical.canonical,
      identityHash: canonical.hash,
      expectedBindingVersion: input.expectedBindingVersion,
      preparedHandle,
      preparedDigest: prepared.digest,
      };
      if (isAborted(input.signal)) throw new Error("Request aborted before durable LP bind.");
      // Calling the binder is the ambiguity boundary. It may commit and then
      // lose its reply, so nothing at or after this line may be rolled back.
      this.#workerFence?.assertOpen();
      bindInvoked = true;
      const binding = await input.bind(request);
      this.#workerFence?.assertOpen();
      assertBindingToken(binding, request);
      if (isAborted(input.signal)) throw new Error("Request aborted after durable LP bind.");

      this.#workerFence?.assertOpen();
      const signature = await this.#functions.sign(prepared, { key: selectedKey });
      this.#workerFence?.assertOpen();
      if ((signature.length - 2) / 2 !== 65) {
        throw new Error("Porto produced a non-65-byte inner signature.");
      }
      assertBindingToken(binding, request);
      if (prepared.key?.publicKey.toLowerCase() !== selectedKey.publicKey.toLowerCase()) {
        throw new Error("Prepared key changed after durable bind.");
      }
      this.#workerFence?.assertOpen();
      const result = await withTimeout(this.#functions.send(this.#client, {
      capabilities: prepared.capabilities,
      context: prepared.context,
      key: selectedKey,
      signature,
      }), this.#submitTimeoutMs,
      "Porto LP send timed out; whether the prepared intent was accepted is unknown.");
      this.#workerFence?.assertOpen();
      return { status: "PENDING", callsId: result.id };
    } catch (error) {
      if (!bindInvoked) throw new ProvenPreBindStagedLpError(error);
      throw error;
    }
  }
}

function assertPreparedIdentity(value: PreparedIntentIdentityV1): void {
  if (value.scheme !== PORTO_INTENT_SCHEME || value.decoder !== PORTO_V055_DECODER ||
      value.chainId !== "56" || value.orchestratorVersion !== PORTO_V055_VERSION) {
    throw new Error("Prepared intent identity uses an unsupported scheme or registry entry.");
  }
  if (!isAddress(value.eoa) || value.eoa !== value.eoa.toLowerCase() ||
      value.orchestrator !== PORTO_V055_ORCHESTRATOR) {
    throw new Error("Prepared intent identity contains a non-canonical address.");
  }
  if (!HASH.test(value.executionDataHash) || !HASH.test(value.keyHash)) {
    throw new Error("Prepared intent identity contains a malformed hash.");
  }
  assertUint256(value.nonce, "nonce");
  assertUint256(value.expiry, "expiry");
}

function assertUint256(value: string, field: string): void {
  if (!UINT.test(value) || value.length > 78 || BigInt(value) > UINT256_MAX) {
    throw new Error(`Prepared intent ${field} is not canonical uint256 decimal.`);
  }
}

function canonicalSec1(value: Hex, field: string): string {
  const lowered = value.toLowerCase();
  if (!SEC1.test(lowered)) throw new Error(`${field} is not canonical uncompressed SEC1.`);
  return lowered;
}

/** A bounded semantic encoder for durable session permissions. */
export function canonicalProviderPermissionsV1(value: unknown): string {
  return canonicalProviderPermissionsWitness(value);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function assertBindingToken(
  token: PreparedIntentBindingToken,
  request: PreparedIntentBindRequest,
): void {
  if (
    token.preparedHandle !== request.preparedHandle ||
    token.journalIdempotencyKey !== request.journalIdempotencyKey ||
    token.canonicalIdentity !== request.canonicalIdentity ||
    token.identityHash !== request.identityHash ||
    token.preparedDigest !== request.preparedDigest ||
    token.boundBindingVersion !== request.expectedBindingVersion + 1
  ) {
    throw new Error("Prepared intent binding token does not authorize this prepared object.");
  }
}

function toUtf8Hex(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * GRID-GAS-RESERVE P1 — what the relay's own quote says the wallet is SHORT.
 *
 * Porto's `Quote` carries `feeTokenDeficit` (the native relay fee the account
 * cannot pay) and `assetDeficits` (every asset the simulated batch needs and
 * the account lacks; `address: null` is the native token). Either non-zero
 * means the relay WILL refuse the send, so the adapter refuses first, while a
 * rollback is still provable. Structural input type on purpose: the test and
 * the adapter feed it the same shape without importing Porto's schema.
 */
export function portoQuoteDeficits(quote: {
  readonly feeTokenDeficit?: bigint | undefined;
  readonly assetDeficits?: readonly {
    readonly address: `0x${string}` | null;
    readonly deficit: bigint;
    readonly required?: bigint | undefined;
  }[] | undefined;
}): { readonly short: boolean; readonly feeTokenDeficitWei: bigint; readonly summary: string } {
  const feeTokenDeficitWei = quote.feeTokenDeficit ?? 0n;
  const assets = (quote.assetDeficits ?? []).filter((entry) => entry.deficit > 0n);
  const parts: string[] = [];
  if (feeTokenDeficitWei > 0n) parts.push(`fee token short by ${feeTokenDeficitWei} wei`);
  for (const entry of assets) {
    parts.push(
      `${entry.address === null ? "native" : entry.address.toLowerCase()} short by ${entry.deficit} wei`
      + (entry.required === undefined ? "" : ` of ${entry.required} required`),
    );
  }
  return {
    short: parts.length > 0,
    feeTokenDeficitWei,
    summary: parts.length === 0 ? "none" : `${parts.join("; ")}. Fund the agent wallet with BNB and the motion retries by itself.`,
  };
}
