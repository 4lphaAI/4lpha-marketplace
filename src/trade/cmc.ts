/** CMC constants, strict challenge parsing and CMC budget projections. */
import { createHash, hkdfSync } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { canonicalEncode } from "../auth/canonical.js";
import { decryptSecret, encryptSecret } from "../store/crypto.js";
import {
  MemoryTradeCmcStore,
  PostgresTradeCmcStore,
  type CmcAttemptRecord,
  type CmcAttemptState,
  type CmcBudgetRecord,
  type CmcBudgetStatus,
  type CmcBudgetStore,
  type CmcContentState,
  type CmcNewsRecord,
  type CmcOwnerOperationMode,
  type CmcOwnerOperationRecord,
  type CmcOwnerOperationState,
} from "../store/tradeCmc.js";
import { DEFAULT_CMC_TOTAL_BUDGET_WEI } from "./sizing.js";
import { MAX_UINT256, USDT_56, isCanonicalAtomic } from "./settlement.js";

export {
  MemoryTradeCmcStore,
  PostgresTradeCmcStore,
  type CmcAttemptRecord,
  type CmcAttemptState,
  type CmcBudgetRecord,
  type CmcBudgetStatus,
  type CmcBudgetStore,
  type CmcContentState,
  type CmcNewsRecord,
  type CmcOwnerOperationMode,
  type CmcOwnerOperationRecord,
  type CmcOwnerOperationState,
};

export const CMC_MCP_ORIGIN = "https://mcp.coinmarketcap.com";
export const CMC_MCP_PATH = "/x402/mcp";
export const CMC_MCP_URL = `${CMC_MCP_ORIGIN}${CMC_MCP_PATH}`;
export const CMC_MCP_RESOURCE = "X402_execute_skill";
export const CMC_PRICE_ATOMIC = 10_000_000_000_000_000n;
/**
 * TRADFI-CMC-EQUITY Rev 2 (R-B): the crypto-wide global-metrics tool stays,
 * called once per day, and feeds only `regimeSizeScale`/`blendRegime`'s
 * crypto leg (Rev 2.1 N3(a)). `get_upcoming_macro_events` is removed; macro
 * risk now comes from `macro_news_aggregator` (`src/trade/cmcUsEquity.ts`).
 */
export const CMC_GLOBAL_TOOL = "get_global_metrics_latest";
export type CmcTarget =
  | {
    readonly kind: "skill";
    readonly ticker: string;
    readonly uniqueName: string;
    readonly parameters?: Readonly<Record<string, unknown>>;
    /**
     * AUDIT HIGH-1: the store key this call's result is filed under, when it
     * differs from `uniqueName` (the "+1 after release" call is the real
     * `macro_news_aggregator` skill, filed under a separate release-tracking
     * key so the once-a-day gate has its own row). Defaults to `uniqueName`.
     */
    readonly storeSkill?: string;
  }
  | { readonly kind: "tool"; readonly name: string };

/** §6.1: `X402_execute_skill` for a skill call, `X402_<name>` for a bare tool call. */
export function expectedCmcResource(target: CmcTarget): string {
  return target.kind === "skill" ? CMC_MCP_RESOURCE : `X402_${target.name}`;
}
export const CMC_PAYEE: Address = getAddress("0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA");
/** The x402 facilitator/settler called by the payment service. */
export const CMC_SPENDER: Address = getAddress("0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633");
/** Address advertised in the challenge as the facilitator signer. */
export const CMC_SIGNER: Address = getAddress("0x34F7a661160780Ce1346e6D7B96D2bE244590899");
export const CMC_CONFIG_ID = "69ef242f50455dcce02f3c2f";
export const CMC_MAX_RESPONSE_BYTES = 256 * 1024;
export const CMC_MAX_SSE_EVENTS = 64;
export const CMC_MAX_CONTEXT_CHARS = 12_000;
export const CMC_MAX_TICKER_CHARS = 3_000;
export const CMC_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
export const CMC_SCHEDULER_INTERVAL_MS = 60 * 1_000;
export const CMC_REQUEST_TIMEOUT_MS = 300_000;
/**
 * TRADFI-LLM-CMC-REQUEST R2.0 (operator ruling 2026-09-25): at most this many
 * LLM-requested paid calls per agent per 16:30-ET trading window (the same
 * anchor as the scheduled CMC budget, `planningWindowStartMs`). Dev-only, not
 * an owner setting, not shown as editable in the UI.
 */
export const CMC_LLM_REQUEST_CAP_PER_WINDOW = 10;
/**
 * §6/G0: `us_equity_upcoming_event_calendar` was measured by the operator
 * probe on 2026-09-25 (NVDA, `scripts/tmp/probe-…-NVDA.json`); its parser
 * (`compactEventCalendar`) is written from that payload, so it is enabled.
 */
export const CMC_EVENT_CALENDAR_ENABLED = true;
/**
 * R3.6/R3.10 M1 (operator confirmed 0.20 USDT, 2026-09-25): LLM-requested
 * calls are refused while the agent's remaining protected data budget
 * (`cmcBudgetView(...).remainingWei`) is below this — two weekday windows of
 * scheduled calls — so requests can never drain the allowance to the point
 * where macro/sector/scanner/planning stop.
 */
export const CMC_LLM_REQUEST_MIN_REMAINING_WEI = 200_000_000_000_000_000n;

export type CmcBudgetView = {
  readonly asset: "USDT";
  readonly decimals: 18;
  readonly generation: number;
  readonly authorizedTotalWei: string;
  readonly settledWei: string;
  readonly reservedWei: string;
  readonly remainingWei: string;
  readonly status: CmcBudgetStatus;
  readonly reason: string | null;
  readonly pendingOperationId: string | null;
  /** CMC-HIRE-SETUP R2.4: the leftover allowance adopted at initial setup, "0" when none or unknown. */
  readonly adoptedWei: string;
};

function remaining(row: CmcBudgetRecord): bigint {
  const value = row.authorizedTotalWei - row.settledWei - row.reservedWei;
  return value < 0n ? 0n : value;
}

export function cmcBudgetView(
  row: CmcBudgetRecord | null,
  optedIn: boolean,
  nextPriceWei = CMC_PRICE_ATOMIC,
  currentSession?: { readonly generation: number; readonly publicKey: Hex },
): CmcBudgetView {
  if (row === null) {
    return {
      asset: "USDT", decimals: 18, generation: 0, authorizedTotalWei: "0", settledWei: "0",
      reservedWei: "0", remainingWei: "0", status: optedIn ? "setup-required" : "disabled",
      reason: optedIn ? "budget_setup_required" : "news_disabled", pendingOperationId: null,
      adoptedWei: "0",
    };
  }
  const available = remaining(row);
  // A budget that was never set up has no checker key yet: that is
  // `setup-required`, not a rebind (seen live 2026-09-20 as a spurious
  // "session_rebind_required" on a fresh hire). A rebind needs a PRIOR key.
  const sessionMismatch = currentSession !== undefined
    && row.checkerSessionPublicKey !== null
    && row.checkerSessionPublicKey.toLowerCase() !== currentSession.publicKey.toLowerCase();
  const status: CmcBudgetStatus = !optedIn || !row.optedIn
    ? "disabled"
    : sessionMismatch
      ? "setup-required"
    : row.pendingOperationId !== null || row.pendingOwnerOperationId !== null
      ? "pending"
      : !row.setupProved
        ? "setup-required"
        : !row.capabilityAvailable || row.reason !== null
          ? "unavailable"
          : available < nextPriceWei ? "exhausted" : "ready";
  return {
    asset: "USDT", decimals: 18, generation: row.generation,
    authorizedTotalWei: row.authorizedTotalWei.toString(10), settledWei: row.settledWei.toString(10),
    reservedWei: row.reservedWei.toString(10), remainingWei: available.toString(10), status,
    reason: status === "disabled" ? "news_disabled" : sessionMismatch ? "session_rebind_required" : status === "exhausted" ? "budget_exhausted" : row.reason,
    pendingOperationId: row.pendingOperationId,
    adoptedWei: (row.adoptedWei ?? 0n).toString(10),
  };
}

export type CmcAuthorizationIdentity = {
  readonly chainId: 56;
  readonly wallet: Address;
  readonly agentId: string;
  readonly budgetGeneration: number;
  readonly nonce: Hex;
};

function cmcSubkey(masterKey: Buffer, identity: CmcAuthorizationIdentity): Buffer {
  const info = Buffer.from(canonicalEncode(identity), "utf8");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.from("4lpha-tradfi-cmc-v1"), info, 32));
}

/** Encrypt only the signed payment payload; identity is authenticated twice. */
export function encryptCmcAuthorization(input: {
  readonly identity: CmcAuthorizationIdentity;
  readonly payload: unknown;
  readonly masterKey: Buffer;
}): string {
  return encryptSecret(JSON.stringify({ version: 1, identity: input.identity, payload: input.payload }), cmcSubkey(input.masterKey, input.identity));
}

export function decryptCmcAuthorization(input: {
  readonly ciphertext: string;
  readonly identity: CmcAuthorizationIdentity;
  readonly masterKey: Buffer;
}): unknown {
  const raw = JSON.parse(decryptSecret(input.ciphertext, cmcSubkey(input.masterKey, input.identity))) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("CMC authorization envelope is malformed.");
  const envelope = raw as Record<string, unknown>;
  if (envelope["version"] !== 1 || canonicalEncode(envelope["identity"]) !== canonicalEncode(input.identity)) {
    throw new Error("CMC authorization identity mismatch.");
  }
  return envelope["payload"];
}

export function hashCmcBody(body: string): Hex {
  return `0x${createHash("sha256").update(body, "utf8").digest("hex")}` as Hex;
}

export type CmcChallenge = {
  readonly amountWei: bigint;
  readonly payTo: Address;
  readonly asset: Address;
  readonly network: "eip155:56";
  readonly spender: Address;
  readonly resource: string;
  readonly configId: string;
  readonly signerAddress: Address;
  readonly maxTimeoutSeconds: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function address(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value);
}
function exactAddress(value: unknown): Address | null {
  if (!address(value)) return null;
  try { return getAddress(value); } catch { return null; }
}
function rootResource(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (record(value) && typeof value["url"] === "string" && value["url"].length > 0) return value["url"];
  return null;
}

/**
 * Parse the exact pinned BSC USDT permit2 challenge. x402 v2 puts resource at
 * the response root; option-local resource fields are not used as a fallback.
 */
export function parseCmcChallenge(value: unknown, expectedResource: string = CMC_MCP_RESOURCE): CmcChallenge | null {
  if (!record(value) || value["x402Version"] !== 2 || rootResource(value["resource"]) !== expectedResource) return null;
  const options = value["accepts"];
  if (!Array.isArray(options)) return null;
  const matches: CmcChallenge[] = [];
  for (const option of options) {
    if (!record(option) || option["scheme"] !== "exact" || option["network"] !== "eip155:56"
      || typeof option["asset"] !== "string" || option["asset"].toLowerCase() !== USDT_56.toLowerCase()
      || option["amount"] !== CMC_PRICE_ATOMIC.toString(10)) continue;
    const payTo = exactAddress(option["payTo"]);
    const extra = record(option["extra"]) ? option["extra"] : null;
    if (payTo === null || extra === null || extra["assetTransferMethod"] !== "permit2-exact"
      || extra["x402PaymentConfigId"] !== CMC_CONFIG_ID || extra["name"] !== "Tether USD"
      || extra["version"] !== "1") continue;
    const spender = exactAddress(extra["spenderAddress"]);
    const signerAddress = exactAddress(extra["signerAddress"]);
    const timeout = option["maxTimeoutSeconds"];
    if (spender === null || signerAddress === null || !Number.isInteger(timeout)
      || (timeout as number) <= 0 || (timeout as number) > 500) continue;
    // An option-level resource is tolerated only when it repeats the pinned root;
    // it can never replace the root resource.
    if (option["resource"] !== undefined && rootResource(option["resource"]) !== expectedResource) continue;
    matches.push({ amountWei: CMC_PRICE_ATOMIC, payTo, asset: USDT_56, network: "eip155:56",
      spender, resource: expectedResource, configId: CMC_CONFIG_ID, signerAddress,
      maxTimeoutSeconds: timeout as number });
  }
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return match.payTo.toLowerCase() === CMC_PAYEE.toLowerCase()
    && match.spender.toLowerCase() === CMC_SPENDER.toLowerCase()
    && match.signerAddress.toLowerCase() === CMC_SIGNER.toLowerCase()
    ? match : null;
}

export function parseCmcBudgetAtomic(value: unknown, options: { readonly allowZero?: boolean } = {}): bigint | null {
  if (!isCanonicalAtomic(value)) return null;
  const parsed = BigInt(value);
  return parsed >= (options.allowZero === true ? 0n : 1n) && parsed <= MAX_UINT256 ? parsed : null;
}

export const DEFAULT_CMC_BUDGET = DEFAULT_CMC_TOTAL_BUDGET_WEI;
