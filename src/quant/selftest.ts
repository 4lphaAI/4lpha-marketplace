/**
 * Gate-1 self-test tooling (QUANT-GRID R2.10 / R3.7 / BC36).
 *
 * The mainnet proof runs the PRODUCTION parsers, admission, execution and
 * settlement against real prices, with TermiX replaced by a transport that
 * reads a local fixture file. Three pieces live here, and nothing else:
 *
 *   1. `quantSelfTestSessionSpec` — the session the operator's wallet grants
 *      to a throwaway agent key, in the WIZARD'S SHAPE: the router swap
 *      selector, `approve` on U and on WBNB as target-bound token grants with
 *      day caps, one native day cap, a short expiry. It is validated by the same
 *      `validateSessionSpec` every other spec is.
 *   2. `serializeGrantedSession` — the plaintext in `@bnbagent/sdk`'s
 *      `serializeSession()` shape (`version: 1`, bigints as `{"$bigint":…}`),
 *      pinned by `test/fixtures/quant/bnbagent-serialized-session.json`. It is
 *      produced IN MEMORY, sealed to our own public key, and only the
 *      CIPHERTEXT reaches disk — exactly what production discovery persists.
 *   3. `FileQuantTransport` — answers the six `QuantTransport` methods from
 *      that fixture file, with the SAME record types the HTTPS parsers produce,
 *      so the worker cannot tell it from TermiX (BC36). It is selected by
 *      `QUANT_SELF_TEST_FILE` and REFUSED whenever `QUANT_API_KEY` is set
 *      (`src/quant/config.ts`): the self-test and production never share a
 *      process.
 *
 * NO forced observation exists here (R3.7): the buy and the sell wait for the
 * real price. This module holds no key material: the private key of the
 * granted session passes through `serializeGrantedSession` as an argument and
 * is never stored on any object this module keeps.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";
import type { SessionSpec } from "../core/types.js";
import { validateSessionSpec } from "../core/session.js";
import { APPROVE_SIGNATURE, SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE } from "../ops/pancakeTokens.js";
import {
  parseInboxItem,
  parseQuantJob,
  type QuantAgentKeyBlock,
  type QuantConfigBlock,
  type QuantReportAck,
  type QuantReportPayload,
  type QuantTransport,
  type QuantTransportResult,
} from "./termix.js";
import type { QuantIndexerTrade, QuantInboxItem, QuantJobRecord } from "./types.js";

/** The strategy id every self-test job carries; the production worker refuses it. */
export const QUANT_SELF_TEST_STRATEGY_ID = "self-test";

/* -------------------------------------------------------------------------- */
/* 1. The session the operator grants                                         */
/* -------------------------------------------------------------------------- */

export type QuantSelfTestSpecInput = {
  readonly router: Address;
  readonly u: Address;
  readonly wbnb: Address;
  /** Per-day U the session may spend — at least one clip. */
  readonly uDayCapWei: bigint;
  /** Per-day WBNB the session may spend — at least twice the worst-case base. */
  readonly wbnbDayCapWei: bigint;
  /** Per-day native the relay may bill — at least six relay fees. */
  readonly nativeDayCapWei: bigint;
  /** Unix seconds. */
  readonly expiresAt: number;
  readonly nowSeconds?: number;
  readonly walletAddress?: Address;
  readonly keyStoreAddress?: Address;
};

/**
 * Exactly the three call rules and three caps the admission predicate
 * requires (R2.1 A2–A4), and nothing else — a self-test session with an extra
 * grant would prove admission accepts something the wizard never sends.
 */
export function quantSelfTestSessionSpec(input: QuantSelfTestSpecInput): SessionSpec {
  const spec: SessionSpec = {
    allowedCalls: [
      { to: getAddress(input.router), selector: SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE },
      { to: getAddress(input.u), selector: APPROVE_SIGNATURE },
      { to: getAddress(input.wbnb), selector: APPROVE_SIGNATURE },
    ],
    spendCaps: [
      { token: getAddress(input.u), limit: input.uDayCapWei, period: "day" },
      { token: getAddress(input.wbnb), limit: input.wbnbDayCapWei, period: "day" },
      { limit: input.nativeDayCapWei, period: "day" },
    ],
    expiresAt: input.expiresAt,
  };
  validateSessionSpec(spec, {
    ...(input.nowSeconds === undefined ? {} : { nowSeconds: input.nowSeconds }),
    ...(input.walletAddress === undefined ? {} : { walletAddress: input.walletAddress }),
    ...(input.keyStoreAddress === undefined ? {} : { keyStoreAddress: input.keyStoreAddress }),
  });
  return spec;
}

/* -------------------------------------------------------------------------- */
/* 2. The plaintext, in the SDK's serialized shape                            */
/* -------------------------------------------------------------------------- */

export type GrantedPermissionsWire = {
  readonly calls: readonly { readonly to?: Address; readonly signature?: string }[];
  readonly spend: readonly {
    readonly token?: Address;
    readonly limit: bigint;
    readonly period: string;
  }[];
};

/**
 * `@bnbagent/sdk` `serializeSession()`, reproduced: `version` 1, the wallet,
 * the SEC1 public key, the expiry in seconds, the permissions VERBATIM, and
 * the signer as `{type:"privateKey", privateKey}`. Bigints are encoded as
 * `{"$bigint":"<decimal>"}` — the replacer the checked-in fixture pins.
 */
export function serializeGrantedSession(input: {
  readonly walletAddress: Address;
  readonly publicKey: Hex;
  readonly expiry: number;
  readonly permissions: GrantedPermissionsWire;
  readonly privateKey: Hex;
}): string {
  const replacer = (_key: string, value: unknown): unknown =>
    typeof value === "bigint" ? { $bigint: value.toString(10) } : value;
  return JSON.stringify({
    version: 1,
    walletAddress: getAddress(input.walletAddress),
    publicKey: input.publicKey,
    expiry: input.expiry,
    permissions: input.permissions,
    signer: { type: "privateKey", privateKey: input.privateKey },
  }, replacer);
}

/* -------------------------------------------------------------------------- */
/* 3. The fixture file and its transport                                      */
/* -------------------------------------------------------------------------- */

export type QuantSelfTestFile = {
  readonly version: 1;
  readonly config: QuantConfigBlock;
  readonly agentKey: QuantAgentKeyBlock;
  readonly inbox: readonly QuantInboxItem[];
  /** Wire shape: bigints as decimal strings. */
  readonly jobs: readonly {
    readonly id: string;
    readonly status: string;
    readonly strategyId: string;
    readonly tradingWalletAddress: Address;
    readonly allocationUWei: string;
    readonly dailyCapUWei: string;
    readonly termDays: number;
    readonly startedAtMs: number | null;
    readonly endsAtMs: number | null;
    readonly sessionExpiresAtMs: number | null;
    readonly revokedAtMs: number | null;
  }[];
  readonly reports: readonly { readonly quantJobId: string; readonly payload: QuantReportPayload }[];
};

export function readSelfTestFile(path: string): QuantSelfTestFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("The self-test file is not an object.");
  }
  const file = parsed as QuantSelfTestFile;
  if (file.version !== 1 || !Array.isArray(file.jobs) || !Array.isArray(file.inbox)) {
    throw new Error("The self-test file is not a version-1 fixture.");
  }
  return file;
}

/** Atomic: write a sibling temp file, then rename over the target (R4). */
export function writeSelfTestFile(path: string, file: QuantSelfTestFile): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Claim the fixture path EXCLUSIVELY before any gas is spent (R4). `wx` fails
 * if the file exists, so two invocations cannot both pass an existence check,
 * grant two sessions and overwrite one session's only ciphertext copy. The
 * placeholder is a valid empty fixture; `releaseSelfTestClaim` removes it when
 * the grant fails.
 */
export function claimSelfTestFile(path: string, placeholder: QuantSelfTestFile): void {
  writeFileSync(path, `${JSON.stringify(placeholder, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

export function releaseSelfTestClaim(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}

function refused<T>(): QuantTransportResult<T> {
  return { ok: false, code: "transport-refused" };
}

/**
 * The self-test transport. Re-reads the file on EVERY call, so a job edited by
 * hand (a revocation, a new expiry) is seen on the next cycle exactly as a
 * changed TermiX record would be. Writes only through `registerKey` and
 * `report`, the two methods production also writes through.
 */
export class FileQuantTransport implements QuantTransport {
  readonly #path: string;
  readonly #defaults: QuantSelfTestFile;

  /**
   * `venue` is the pinned registry block the transport answers with BEFORE the
   * grant has written the file (so `config-check`, `keypair` and a dry-run
   * cycle work first); once the file exists it is the only source.
   */
  constructor(path: string, venue: { readonly u: Address; readonly wbnb: Address; readonly router: Address }) {
    if (path.trim() === "") throw new Error("The self-test transport needs a file path.");
    this.#path = path;
    this.#defaults = {
      version: 1,
      config: {
        chainId: 56, u: getAddress(venue.u), uDecimals: 18,
        tradableTokens: [{ address: getAddress(venue.wbnb), decimals: 18, priceRoute: "direct" }],
        venueAllowlist: [getAddress(venue.router), getAddress(venue.u), getAddress(venue.wbnb)],
      },
      agentKey: { encryptionPublicKey: null, algorithm: null },
      inbox: [], jobs: [], reports: [],
    };
  }

  #load(): QuantSelfTestFile {
    return existsSync(this.#path) ? readSelfTestFile(this.#path) : this.#defaults;
  }

  async config(): Promise<QuantTransportResult<QuantConfigBlock>> {
    return { ok: true, data: this.#load().config };
  }

  async agentKey(): Promise<QuantTransportResult<QuantAgentKeyBlock>> {
    return { ok: true, data: this.#load().agentKey };
  }

  async registerKey(input: {
    readonly agentId: string;
    readonly encryptionPublicKey: string;
    readonly algorithm: string;
  }): Promise<QuantTransportResult<QuantAgentKeyBlock>> {
    const file = this.#load();
    const agentKey = {
      encryptionPublicKey: input.encryptionPublicKey,
      algorithm: input.algorithm,
    };
    writeSelfTestFile(this.#path, { ...file, agentKey });
    return { ok: true, data: agentKey };
  }

  async inbox(): Promise<QuantTransportResult<{
    readonly items: readonly QuantInboxItem[];
    readonly nextCursor: string | null;
  }>> {
    // The PRODUCTION parser (R5 / BC36): a malformed item in the file is
    // refused exactly as a malformed TermiX item would be.
    // ONE bad item must not blind the whole inbox — the HTTPS transport's
    // semantics, byte for byte (R2.13 / QUANT-SELFTEST R5).
    const items: QuantInboxItem[] = [];
    for (const raw of this.#load().inbox) {
      const parsed = parseInboxItem(raw);
      if (parsed.ok) items.push(parsed.data);
    }
    return { ok: true, data: { items, nextCursor: null } };
  }

  async job(quantJobId: string): Promise<QuantTransportResult<QuantJobRecord>> {
    const file = this.#load();
    const row = file.jobs.find((job) => job.id === quantJobId);
    if (row === undefined) return refused<QuantJobRecord>();
    // The file stores wei as decimal strings; TermiX's wire carries decimal U.
    // Convert to the wire's shape and run the PRODUCTION parser on it.
    const toU = (wei: string): string => {
      const padded = wei.padStart(19, "0");
      const whole = padded.slice(0, -18);
      const frac = padded.slice(-18).replace(/0+$/u, "");
      return frac === "" ? whole : `${whole}.${frac}`;
    };
    const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
    return parseQuantJob({
      id: row.id,
      status: row.status,
      strategyId: row.strategyId,
      tradingWalletAddress: row.tradingWalletAddress,
      allocationU: toU(row.allocationUWei),
      dailyCapU: toU(row.dailyCapUWei),
      termDays: row.termDays,
      startedAt: iso(row.startedAtMs),
      endsAt: iso(row.endsAtMs),
      sessionExpiresAt: iso(row.sessionExpiresAtMs),
      revokedAt: iso(row.revokedAtMs),
    }, file.config.uDecimals);
  }

  async trades(): Promise<QuantTransportResult<readonly QuantIndexerTrade[]>> {
    // No indexer exists for the self-test; an empty list is the honest answer
    // and the worker never reads it into a decision (R2.4 / M1).
    return { ok: true, data: [] };
  }

  async report(
    quantJobId: string, payload: QuantReportPayload,
  ): Promise<QuantTransportResult<QuantReportAck>> {
    const file = this.#load();
    writeSelfTestFile(this.#path, {
      ...file,
      reports: [...file.reports, { quantJobId, payload }],
    });
    return { ok: true, data: { status: "accepted", notesApplied: payload.trades.length } };
  }
}
