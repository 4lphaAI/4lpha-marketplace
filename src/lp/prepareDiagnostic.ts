/**
 * Bounded, prepare-only observation of the Porto LP boundary.
 *
 * This is intentionally a separate capability from `PortoStagedLpAdapter`:
 * it imports neither sign nor send, accepts neither a binder nor an execution
 * provider, and turns every relay detail into a small printable verdict.  It
 * exists to identify the 3.9c prepare incompatibility without creating a new
 * way to submit a wallet call.
 */
import { createClient, getAddress, http, keccak256, type Address, type Chain,
  type Client, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepareCalls } from "porto/viem/RelayActions";
import * as Key from "porto/viem/Key";
import type { NetworkConfig } from "@altananetwork/sdk";
import type { WalletCall } from "../core/types.js";
import { validateSessionSpec } from "../core/session.js";
import type { SessionFacts } from "../store/agents.js";
import { canonicalProviderPermissionsV1, fingerprintLpFinalCallsV1 } from "./preparedIntentWitness.js";
const HASH = /^0x[0-9a-f]{64}$/;
const SEC1 = /^0x04[0-9a-f]{128}$/;
const PORTO_V055_ORCHESTRATOR = "0xaf140d0416a994aebb3fa6212b16ce6700f09751" as Address;
// Mirrors `PORTO_NATIVE_FEE_TOKEN` in the staged adapter, and is re-declared
// here for the same reason the orchestrator address is: D1 diagnoses the
// staged path by REPRODUCING it, so it must not import the value it is meant
// to check independently. If these two ever disagree the diagnostic stops
// answering for the path that actually submits.
const PORTO_NATIVE_FEE_TOKEN = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Mirrors `acceptableIntentExpiry` in the staged adapter, re-declared for the
 * same reason as the constants above: D1 must reproduce the submit path rather
 * than import it. The BSC relay returns `0` on every quote — no intent-level
 * deadline — and the session key's expiry is enforced on chain by the KeyStore.
 * A nonzero value may tighten the window but never outlive the session, and
 * (FIXREVIEW7 F6) must still be in the future: an already-expired intent is
 * refusable here, and admitting it would only move the failure past the bind.
 * Kept textually identical to the staged adapter's copy.
 */
function acceptableIntentExpiry(
  intentExpiry: bigint,
  sessionExpiry: number,
  nowSec: number,
): boolean {
  if (intentExpiry === 0n) return true;
  return intentExpiry > BigInt(nowSec) && intentExpiry <= BigInt(sessionExpiry);
}

export type LpPrepareDiagnosticStage = "descriptor" | "prepare" | "prepared-response";
export type LpPrepareDiagnosticReason =
  | "session-descriptor-invalid"
  | "final-calls-mismatch"
  | "relay-prepare-rejected"
  | "relay-prepare-timeout"
  | "quote-invalid"
  | "prepared-object-invalid"
  | "admission-refused"
  | "bootstrap-config-invalid"
  | "bootstrap-read-session-failed"
  | "bootstrap-readonly-infrastructure-failed";

export type PrintableLpPrepareDiagnosticOutcome = {
  readonly stage: LpPrepareDiagnosticStage;
  readonly reason: LpPrepareDiagnosticReason;
};

/**
 * The brand prevents a caller from manufacturing a seemingly-successful
 * diagnostic result out of JSON or a structurally identical object.
 */
const outcomeBrand = new WeakSet<object>();

class LpPrepareDiagnosticOutcome {
  readonly stage: LpPrepareDiagnosticStage;
  readonly reason: LpPrepareDiagnosticReason;

  constructor(stage: LpPrepareDiagnosticStage, reason: LpPrepareDiagnosticReason) {
    this.stage = stage;
    this.reason = reason;
    outcomeBrand.add(this);
    Object.freeze(this);
  }
}

export type LpPrepareDiagnosticResult = LpPrepareDiagnosticOutcome;

export function printableLpPrepareDiagnosticOutcome(
  value: unknown,
): PrintableLpPrepareDiagnosticOutcome {
  if (!(value instanceof LpPrepareDiagnosticOutcome) || !outcomeBrand.has(value)) {
    throw new Error("LP prepare diagnostic outcome is not authentic.");
  }
  return { stage: value.stage, reason: value.reason };
}

/** Closed telemetry for a no-submit admission refusal; no cause crosses it. */
export function lpPrepareDiagnosticAdmissionRefusal(): LpPrepareDiagnosticResult {
  return outcome("descriptor", "admission-refused");
}

export function lpPrepareDiagnosticBootstrapOutcome(
  family: "config" | "read-session" | "read-only-infrastructure",
): LpPrepareDiagnosticResult {
  return outcome("descriptor", `bootstrap-${family}-${family === "config" ? "invalid" : "failed"}` as LpPrepareDiagnosticReason);
}

type PrepareOnly = typeof prepareCalls;

export type LpPrepareDiagnosticInput = {
  readonly sessionPrivateKey: Hex;
  readonly walletAddress: Address;
  readonly persistedSession: SessionFacts;
  readonly restoredSessionPublicKey: Hex;
  readonly restoredSessionExpiry: number;
  readonly calls: readonly WalletCall[];
  readonly expectedExecutionDataHash: Hex;
};

export type PortoPrepareDiagnosticOptions = {
  readonly network: NetworkConfig;
  readonly transport?: (url: string) => Transport;
  readonly prepare?: PrepareOnly;
  readonly prepareTimeoutMs?: number;
};

/**
 * There is deliberately no positive result: a returned value names the first
 * bounded compatibility family that refused.  A successfully prepared object
 * is represented by the validated `prepared-object-invalid` absence? No: it
 * returns `null`, so the CLI can state only that prepare completed and still
 * has no signing or sending capability.
 */
export class PortoPrepareDiagnosticAdapter {
  readonly #network: NetworkConfig;
  readonly #client: Client<Transport, Chain, undefined>;
  readonly #prepare: PrepareOnly;
  readonly #prepareTimeoutMs: number;

  constructor(options: PortoPrepareDiagnosticOptions) {
    if (options.network.chainId !== 56) {
      throw new Error("Porto LP prepare diagnostic is registered only for chain 56.");
    }
    const relayUrl = options.network.relayUrl;
    if (relayUrl === undefined || relayUrl.trim() === "") {
      throw new Error("Porto LP prepare diagnostic requires the pinned Altana relay URL.");
    }
    const parsed = new URL(relayUrl);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
        parsed.search !== "" || parsed.hash !== "") {
      throw new Error("The LP diagnostic relay must be a credential-free HTTPS origin.");
    }
    this.#network = options.network;
    // Intentionally reproduces the staged adapter transport profile.  D1 is a
    // diagnosis, not a compatibility repair; changing origin/path or timeout
    // here would erase the family it is meant to identify.
    const transport = options.transport ?? ((url: string) => http(url));
    this.#client = createClient({ chain: options.network.chain as Chain, transport: transport(parsed.origin) });
    this.#prepare = options.prepare ?? prepareCalls;
    this.#prepareTimeoutMs = options.prepareTimeoutMs ?? 45_000;
    if (!Number.isSafeInteger(this.#prepareTimeoutMs) || this.#prepareTimeoutMs <= 0 ||
        this.#prepareTimeoutMs > 300_000) {
      throw new Error("Porto LP prepare diagnostic timeout is outside 1..300000ms.");
    }
  }

  async prepare(input: LpPrepareDiagnosticInput): Promise<LpPrepareDiagnosticResult | null> {
    const descriptor = this.#descriptor(input);
    if (descriptor !== null) return descriptor;

    const facts = input.persistedSession;
    const permissions = validateSessionSpec(facts.spec, { minSessionSeconds: 0 });
    const key = Key.fromSecp256k1({
      privateKey: input.sessionPrivateKey,
      role: "session",
      expiry: facts.expiry,
      permissions,
    });
    let prepared: Awaited<ReturnType<typeof prepareCalls>>;
    try {
      prepared = await withPrepareTimeout(this.#prepare(this.#client, {
        account: getAddress(input.walletAddress),
        chain: this.#network.chain,
        calls: input.calls.map((call) => ({
          to: getAddress(call.to), value: call.value ?? 0n, data: call.data ?? "0x",
        })),
        key,
        feeToken: PORTO_NATIVE_FEE_TOKEN,
      }), this.#prepareTimeoutMs);
    } catch (error) {
      return outcome("prepare", error instanceof PrepareTimeout
        ? "relay-prepare-timeout" : "relay-prepare-rejected");
    }

    try {
      const quotes = prepared.capabilities?.quote?.quotes;
      if (!Array.isArray(quotes) || quotes.length !== 1) return outcome("prepared-response", "quote-invalid");
      const quote = quotes[0];
      if (quote === undefined || quote.chainId !== 56 || typeof quote.orchestrator !== "string" ||
          quote.orchestrator.toLowerCase() !== PORTO_V055_ORCHESTRATOR) {
        return outcome("prepared-response", "quote-invalid");
      }
      const intent = quote.intent;
      if (intent === undefined || typeof intent.eoa !== "string" || typeof intent.executionData !== "string" ||
          typeof intent.expiry !== "bigint" || intent.eoa.toLowerCase() !== input.walletAddress.toLowerCase() ||
          keccak256(intent.executionData as Hex).toLowerCase() !== input.expectedExecutionDataHash.toLowerCase() ||
          !acceptableIntentExpiry(intent.expiry, facts.expiry, Math.floor(Date.now() / 1_000))) {
        return outcome("prepared-response", "quote-invalid");
      }
      if (prepared.key?.type !== key.type || typeof prepared.key.publicKey !== "string" ||
          prepared.key.publicKey.toLowerCase() !== key.publicKey.toLowerCase() || typeof prepared.digest !== "string" ||
          !HASH.test(prepared.digest.toLowerCase()) || prepared.context === undefined ||
          prepared.capabilities === undefined || prepared.typedData === undefined) {
        return outcome("prepared-response", "prepared-object-invalid");
      }
    } catch {
      return outcome("prepared-response", "quote-invalid");
    }
    return null;
  }

  #descriptor(input: LpPrepareDiagnosticInput): LpPrepareDiagnosticResult | null {
    try {
      const facts = input.persistedSession;
      const permissions = validateSessionSpec(facts.spec, { minSessionSeconds: 0 });
      if (canonicalProviderPermissionsV1(permissions) !== canonicalProviderPermissionsV1(facts.permissions) ||
          facts.expiry !== facts.spec.expiresAt || facts.expiry !== input.restoredSessionExpiry) {
        return outcome("descriptor", "session-descriptor-invalid");
      }
      const account = privateKeyToAccount(input.sessionPrivateKey);
      const persisted = canonicalSec1(facts.publicKey);
      const restored = canonicalSec1(input.restoredSessionPublicKey);
      const derived = canonicalSec1(account.publicKey);
      if (persisted !== derived || restored !== derived) {
        return outcome("descriptor", "session-descriptor-invalid");
      }
      const executionDataHash = fingerprintLpFinalCallsV1(input.calls).value.executionDataHash;
      if (executionDataHash.toLowerCase() !== input.expectedExecutionDataHash.toLowerCase()) {
        return outcome("descriptor", "final-calls-mismatch");
      }
    } catch {
      return outcome("descriptor", "session-descriptor-invalid");
    }
    return null;
  }
}

function outcome(stage: LpPrepareDiagnosticStage, reason: LpPrepareDiagnosticReason): LpPrepareDiagnosticResult {
  return new LpPrepareDiagnosticOutcome(stage, reason);
}

function canonicalSec1(value: Hex): string {
  const lowered = value.toLowerCase();
  if (!SEC1.test(lowered)) throw new Error("Session public key is not canonical uncompressed SEC1.");
  return lowered;
}

class PrepareTimeout extends Error {}

async function withPrepareTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PrepareTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
