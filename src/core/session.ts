/**
 * Pure session-policy logic: validation, and translation of a SessionSpec into
 * the permission shape wallet providers consume.
 *
 * Everything here is synchronous and side-effect free so it can be unit tested
 * without a network or an SDK.
 *
 * The output is CANONICAL: the same policy expressed in any order produces a
 * byte-identical permission object. That matters because the granted
 * permissions are part of the on-chain key descriptor — a session rebuilt from
 * persisted facts must hash to what was granted, and "the array happened to be
 * in a different order" is not an acceptable reason for a key mismatch.
 */
import {
  getAddress,
  isAddress,
  parseAbiItem,
  toFunctionSelector,
  toFunctionSignature,
} from "viem";
import type { Address } from "viem";
import {
  InvalidSessionSpecError,
  type CallRule,
  type SessionSpec,
  type SpendCap,
  type SpendPeriod,
} from "./types.js";

/**
 * Longest session the execution plane will grant by default.
 *
 * A session is a standing authorization; long horizons turn a scoped key into
 * an unscoped one in practice. 30 days is the default ceiling, overridable per
 * call for deliberate cases.
 */
export const DEFAULT_MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;

/**
 * Shortest session worth granting.
 *
 * A grant costs gas and a KeyStore registration fee, and the relay needs tens
 * of seconds to see the new key (FINDINGS.md (f)), so anything shorter is a
 * session that expires before it can be used — a paid-for no-op.
 */
export const MIN_SESSION_SECONDS = 60;

/**
 * ERC-20 functions that move value rather than merely reading it, in canonical
 * signature form.
 *
 * ONE list, two derived views below. A grant is checked by NAME (a rule names a
 * signature, and any arity of `transfer` moves value) while a submitted call is
 * checked by SELECTOR (calldata carries four bytes and nothing else). Deriving
 * both from this array is what stops the two from drifting apart.
 */
const VALUE_MOVING_SIGNATURES = [
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "approve(address,uint256)",
  "increaseAllowance(address,uint256)",
] as const;

/** Bare function names, for grant-time validation. */
const VALUE_MOVING_FUNCTIONS: ReadonlySet<string> = new Set(
  VALUE_MOVING_SIGNATURES.map((signature) => signature.slice(0, signature.indexOf("("))),
);

/**
 * Selectors, for execute-time classification (PHASE2.4 R5).
 *
 * When a submitted call's selector moves value, the chain fallback must answer
 * BOTH halves of the session — the allowlist AND a spend limit for the target —
 * because either alone is FINDINGS (u): a token that reads as authorised in
 * `spendInfos` and still cannot be sold.
 */
export const VALUE_MOVING_SELECTORS: ReadonlySet<string> = new Set(
  VALUE_MOVING_SIGNATURES.map((signature) =>
    toFunctionSelector(signature).toLowerCase(),
  ),
);

const VALID_PERIODS: ReadonlySet<string> = new Set<SpendPeriod>([
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
]);

/* -------------------------------------------------------------------------- */
/* Provider-facing permission shape                                           */
/* -------------------------------------------------------------------------- */

/**
 * A permission entry as wallet providers express it. Structurally identical to
 * `@altananetwork/sdk`'s `CallPermission`, kept declared here so `src/core`
 * stays SDK-free.
 */
export type ProviderCallPermission =
  | { readonly signature: string; readonly to: Address }
  | { readonly signature: string }
  | { readonly to: Address };

/** Structurally identical to the SDK's `SpendPermission`. */
export type ProviderSpendPermission = {
  readonly limit: bigint;
  readonly period: SpendPeriod;
  readonly token?: Address;
};

/** Structurally identical to the SDK's `SessionPermissions`. */
export type ProviderPermissions = {
  readonly calls: readonly ProviderCallPermission[];
  readonly spend: readonly ProviderSpendPermission[];
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type ValidateOptions = {
  /** Clock reading in unix SECONDS. Injected so tests are deterministic. */
  readonly nowSeconds?: number;
  /** Override the default maximum session length, in seconds. */
  readonly maxSessionSeconds?: number;
  /** Override the default minimum session length, in seconds. */
  readonly minSessionSeconds?: number;
  /**
   * The wallet the session will be granted on. Supplied by the provider.
   *
   * A rule allowing the session to call the wallet ITSELF is an escalation
   * route, not a trade: the account's admin entry points (`revoke`,
   * `authorize`, `setLabel`, …) are gated on `msg.sender == address(this)`,
   * which a self-call satisfies. Rejected when known.
   */
  readonly walletAddress?: Address;
  /**
   * The network's key registry. Supplied by the provider.
   *
   * A session allowed to call the KeyStore can register keys for the wallet or
   * revoke the owner's — tampering with the very registry that bounds it.
   */
  readonly keyStoreAddress?: Address;
};

/**
 * The two targets a session may never reach, and WHY, in one place.
 *
 * Returns the reason a call to `to` is structurally refused, or `null`.
 *
 * Shared by two callers that must never disagree (PHASE2.4 R1):
 *   - {@link validateSessionSpec}, which refuses such a RULE at grant time;
 *   - the provider's execute pre-flight, which refuses such a CALL at submit
 *     time and — critically — never lets the chain fallback overrule it.
 *
 * The second caller is the reason this is a shared predicate rather than two
 * checks. `canExecute` is the ACCOUNT's allowlist and knows nothing about
 * 4lpha's policy: measured on the live mainnet wallet, one owner self-call
 * (`setCanExecute(keyHash, keyStore, sel, true)` — the same mechanism
 * `owner-add-spend-limit` uses) would make the account answer `true` for a call
 * into the registry that bounds the session. A refusal this service enforces at
 * grant must not become conditional on the counterparty's contract at execute.
 */
export function structuralTargetRefusal(
  to: Address,
  options: Pick<ValidateOptions, "walletAddress" | "keyStoreAddress">,
  label = "The call target",
): string | null {
  // FAIL CLOSED on anything unparseable, and compare on the CHECKSUM-NORMALIZED
  // form rather than on the spelling (PHASE2.4 audit).
  //
  // `isAddress` is checksum-strict for any address that is not all-lowercase,
  // so an all-uppercase-hex `to` — a perfectly valid 20-byte address — read as
  // "not an address" here, and returning `null` for it answered "no structural
  // objection" for the two targets that must never have one. A predicate whose
  // entire job is to refuse two addresses must never answer "allowed" because
  // it could not read the question. The grant-time caller cannot reach this
  // branch (`assertAddress` runs first and throws), so refusing costs it
  // nothing.
  if (!isAddress(to, { strict: false })) {
    return `${label} is not a valid address.`;
  }
  const target = getAddress(to);
  if (
    options.walletAddress !== undefined &&
    target === getAddress(options.walletAddress)
  ) {
    return `${label} is the wallet itself. A self-call reaches the account's owner-only entry points, which would let the session escalate its own authority.`;
  }
  if (
    options.keyStoreAddress !== undefined &&
    target === getAddress(options.keyStoreAddress)
  ) {
    return `${label} is the key registry. A session allowed to call it could register or revoke keys for this wallet.`;
  }
  return null;
}

function assertAddress(value: string, field: string): Address {
  if (!isAddress(value)) {
    throw new InvalidSessionSpecError(`${field} is not a valid address.`);
  }
  return getAddress(value);
}

/**
 * Canonicalize a human-readable function signature and return it with its
 * selector and bare name.
 *
 * Parsing through abitype rather than hashing the raw string is what catches
 * `transfer(address,uint)`: it is a perfectly plausible thing to type, it
 * hashes to `0x6cb927d8`, and the chain will never match it against the
 * `0xa9059cbb` every real ERC-20 uses. Silently granting a permission for a
 * function that does not exist is the worst possible failure here — it looks
 * like a working allowlist entry and permits nothing.
 *
 * The canonical form comes from viem's `toFunctionSignature`, which EXPANDS
 * TUPLE COMPONENTS. abitype reports a tuple parameter's `type` as the literal
 * string "tuple", so rebuilding from `inputs[].type` canonicalized
 * `mint((address,…,uint256))` to `mint(tuple)` — selector `0x4405fca9`, never
 * the deployed `0x88316456` — and the cross-check below refused every
 * tuple-bearing rule (measured, PHASE3-REVIEW R1). `toFunctionSignature` is
 * byte-identical to the old reconstruction for every flat signature, so
 * existing granted specs re-validate to identical permission bytes.
 */
function canonicalizeSignature(
  signature: string,
  field: string,
): { readonly canonical: string; readonly name: string } {
  let item: ReturnType<typeof parseAbiItem>;
  try {
    item = parseAbiItem(`function ${signature}`);
  } catch {
    throw new InvalidSessionSpecError(
      `${field} must be a function signature like "transfer(address,uint256)".`,
    );
  }
  if (item.type !== "function") {
    throw new InvalidSessionSpecError(
      `${field} must be a function signature like "transfer(address,uint256)".`,
    );
  }

  const canonical = toFunctionSignature(item);

  if (toFunctionSelector(canonical) !== toFunctionSelector(signature)) {
    throw new InvalidSessionSpecError(
      `${field} is not canonical: "${signature}" hashes differently from "${canonical}". Use the canonical form, or the on-chain selector will never match.`,
    );
  }

  return { canonical, name: item.name };
}

type ValidatedCall = {
  readonly permission: ProviderCallPermission;
  /** Target when the rule is target-bound. */
  readonly to?: Address;
  /** Bare function name when the rule is selector-bound. */
  readonly functionName?: string;
};

function validateCallRule(
  rule: CallRule,
  index: number,
  spec: SessionSpec,
  options: ValidateOptions,
): ValidatedCall {
  const signature =
    rule.selector === undefined
      ? undefined
      : canonicalizeSignature(rule.selector, `allowedCalls[${index}].selector`);

  if (rule.to === undefined) {
    if (signature === undefined) {
      throw new InvalidSessionSpecError(
        `allowedCalls[${index}] must constrain at least one of "to" or "selector".`,
      );
    }
    if (spec.allowUnrestrictedSelector !== true) {
      throw new InvalidSessionSpecError(
        `allowedCalls[${index}] constrains only "selector", which permits that function on EVERY contract on the chain. Set allowUnrestrictedSelector: true to opt in deliberately.`,
      );
    }
    return {
      permission: { signature: signature.canonical },
      functionName: signature.name,
    };
  }

  const to = assertAddress(rule.to, `allowedCalls[${index}].to`);

  const structural = structuralTargetRefusal(to, options, `allowedCalls[${index}].to`);
  if (structural !== null) throw new InvalidSessionSpecError(structural);

  return {
    permission:
      signature === undefined
        ? { to }
        : { to, signature: signature.canonical },
    to,
    ...(signature === undefined ? {} : { functionName: signature.name }),
  };
}

function validateSpendCap(cap: SpendCap, index: number): ProviderSpendPermission {
  if (!VALID_PERIODS.has(cap.period)) {
    throw new InvalidSessionSpecError(
      `spendCaps[${index}].period is not a supported rolling period.`,
    );
  }
  if (cap.limit <= 0n) {
    throw new InvalidSessionSpecError(
      `spendCaps[${index}].limit must be greater than zero.`,
    );
  }
  if (cap.token === undefined) {
    return { limit: cap.limit, period: cap.period };
  }
  return {
    limit: cap.limit,
    period: cap.period,
    token: assertAddress(cap.token, `spendCaps[${index}].token`),
  };
}

/** Sort key for a call permission. Total order, stable across runs. */
function callSortKey(permission: ProviderCallPermission): string {
  const to = "to" in permission ? permission.to : "";
  const signature = "signature" in permission ? permission.signature : "";
  return `${to.toLowerCase()}|${signature}`;
}

/** Sort key for a spend permission. */
function spendSortKey(permission: ProviderSpendPermission): string {
  return `${permission.token?.toLowerCase() ?? ""}|${permission.period}|${permission.limit}`;
}

function byKey<T>(key: (value: T) => string) {
  return (a: T, b: T): number => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

/**
 * Validate a SessionSpec and translate it into provider permissions.
 *
 * Throws `InvalidSessionSpecError` before any network call is attempted. The
 * rules worth calling out, because each is a safe-default inversion of what
 * the SDK does on its own:
 *
 *   - An empty `allowedCalls` list is REJECTED. Altana reads an omitted
 *     `calls` array as "every target is allowed".
 *   - An empty `spendCaps` list is REJECTED. Altana reads an omitted `spend`
 *     array as "no spending limit".
 *   - A rule with a `selector` and no `to` is REJECTED unless the spec sets
 *     `allowUnrestrictedSelector` — and is REJECTED REGARDLESS of that flag
 *     when the function moves value (PHASE2.3 R2, see
 *     `assertTokenMoversAreCapped`).
 *   - Calls back into the wallet or into the key registry are REJECTED when
 *     the provider tells us those addresses.
 */
export function validateSessionSpec(
  spec: SessionSpec,
  options: ValidateOptions = {},
): ProviderPermissions {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxSessionSeconds =
    options.maxSessionSeconds ?? DEFAULT_MAX_SESSION_SECONDS;
  const minSessionSeconds = options.minSessionSeconds ?? MIN_SESSION_SECONDS;

  if (spec.allowedCalls.length === 0) {
    throw new InvalidSessionSpecError(
      "allowedCalls must not be empty; an empty allowlist would grant unrestricted call access.",
    );
  }
  if (spec.spendCaps.length === 0) {
    throw new InvalidSessionSpecError(
      "spendCaps must not be empty; an empty cap list would grant unlimited spending.",
    );
  }
  if (!Number.isInteger(spec.expiresAt)) {
    throw new InvalidSessionSpecError(
      "expiresAt must be an integer number of unix seconds.",
    );
  }
  if (spec.expiresAt <= nowSeconds) {
    throw new InvalidSessionSpecError("expiresAt must be in the future.");
  }
  if (spec.expiresAt - nowSeconds < minSessionSeconds) {
    throw new InvalidSessionSpecError(
      `expiresAt is less than the minimum session length of ${minSessionSeconds} seconds; the grant would expire before it could be used.`,
    );
  }
  if (spec.expiresAt - nowSeconds > maxSessionSeconds) {
    throw new InvalidSessionSpecError(
      `expiresAt exceeds the maximum session length of ${maxSessionSeconds} seconds.`,
    );
  }

  const validatedCalls = spec.allowedCalls.map((rule, index) =>
    validateCallRule(rule, index, spec, options),
  );
  const spend = spec.spendCaps.map(validateSpendCap);

  const seen = new Set<string>();
  for (const entry of spend) {
    const key = `${entry.token ?? "native"}:${entry.period}`;
    if (seen.has(key)) {
      throw new InvalidSessionSpecError(
        `Duplicate spend cap for ${entry.token ?? "the native token"} over one ${entry.period}.`,
      );
    }
    seen.add(key);
  }

  assertTokenMoversAreCapped(validatedCalls, spend);

  return {
    calls: validatedCalls
      .map((entry) => entry.permission)
      .sort(byKey(callSortKey)),
    spend: [...spend].sort(byKey(spendSortKey)),
  };
}

/**
 * Require a spend cap for every contract the session may call a value-moving
 * ERC-20 function on.
 *
 * Caps are opt-in per token (FINDINGS.md (d)): a token absent from `spendCaps`
 * is UNCAPPED for that token. So "may call `transfer` on USDT" with only a
 * native-BNB cap is an unlimited USDT allowance wearing a policy's clothes.
 *
 * A BARE-SELECTOR value-moving rule is REFUSED UNCONDITIONALLY (PHASE2.3 R2).
 * This used to be skipped — `if (call.to === undefined) continue` — and that
 * skip is precisely FINDINGS (h): the trade template granted a bare-selector
 * `approve`, the guard waved it through, and the resulting session could buy
 * and never sell. "I cannot cap what I cannot enumerate" is an ERROR, not a
 * pass. The flag is deliberately NOT consulted: `validateCallRule` already
 * throws for any bare-selector rule when `allowUnrestrictedSelector` is unset,
 * so the only such rules that reach here are ones where it IS set — which is
 * exactly the shape that caused (h). An "unless the caller opted in" escape
 * would be a no-op that re-admits the original defect.
 *
 * The carve-out matters as much as the rule: a bare-selector rule that is NOT
 * value-moving (`harvest()`, `compound()`) is still permitted under the flag.
 * Only the four functions in `VALUE_MOVING_FUNCTIONS` are refused.
 *
 * LIMITS, stated rather than papered over:
 *   - A rule with a target and NO selector permits every function on that
 *     contract, including `transfer`. We cannot tell an ERC-20 from a router
 *     without a network call, and this module is deliberately offline, so such
 *     rules are not checked. (The trade template relies on this for the fee
 *     treasury, whose transfers are native and metered by the native cap.)
 *   - Matching is by address only. A token that moves value through a
 *     non-standard entry point is not detected.
 */
function assertTokenMoversAreCapped(
  calls: readonly ValidatedCall[],
  spend: readonly ProviderSpendPermission[],
): void {
  const cappedTokens = new Set(
    spend
      .map((entry) => entry.token?.toLowerCase())
      .filter((token): token is string => token !== undefined),
  );

  for (const [index, call] of calls.entries()) {
    if (call.functionName === undefined) continue;
    if (!VALUE_MOVING_FUNCTIONS.has(call.functionName)) continue;
    if (call.to === undefined) {
      throw new InvalidSessionSpecError(
        `allowedCalls[${index}] permits ${call.functionName}() on EVERY contract on the chain, so no spend cap can bound it. A value-moving function must name the token it may be called on.`,
      );
    }
    if (cappedTokens.has(call.to.toLowerCase())) continue;
    throw new InvalidSessionSpecError(
      `allowedCalls[${index}] permits ${call.functionName}() on ${call.to}, but spendCaps has no entry for that token. A token with no cap is uncapped.`,
    );
  }
}

/** True when `spec` is past its expiry. Cheap pre-flight before an execute. */
export function isSessionExpired(
  spec: SessionSpec,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return spec.expiresAt <= nowSeconds;
}
