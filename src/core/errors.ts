/**
 * Sanitization and classification of upstream failures.
 *
 * Three rules drive this module:
 *   1. Nothing from a provider reaches a log sink or a client unfiltered.
 *      Relay errors routinely embed full calldata, RPC URLs, and request
 *      bodies; those are redacted here, once, at the boundary.
 *   2. Classification runs on the SANITIZED text, never on the raw body. A
 *      `wallet_prepareCalls` request body contains the words "expiry", "spend"
 *      and "to" for every call being attempted, so classifying the raw string
 *      makes every failure look like whatever the request happened to mention.
 *   3. Callers branch on `code`, never on message text.
 */
import { toFunctionSelector } from "viem";
import type { Hex } from "viem";
import {
  CapExceededError,
  ExecutionPlaneError,
  InfrastructureError,
  NotAllowedError,
  ProviderError,
  SessionExpiredError,
  type ExecutionErrorCode,
} from "./types.js";

/** Longest sanitized message we emit. Keeps log lines bounded. */
const MAX_MESSAGE_LENGTH = 280;

/**
 * Any 0x-prefixed blob of 64 or more hex characters. This deliberately
 * captures 32-byte words, calldata, and — critically — anything shaped like a
 * private key. Addresses (40 hex chars) survive, because they are safe to
 * print and are useful in diagnostics.
 */
const LONG_HEX = /0x[0-9a-fA-F]{64,}/g;

/** URLs, which in relay errors carry endpoint hostnames and query strings. */
const URLS = /\b(?:https?|wss?):\/\/\S+/gi;

/**
 * Everything viem and the relay append below the headline: the JSON-RPC body,
 * the `Request Arguments` / `Estimate Gas Arguments` blocks (which carry the
 * calldata), the docs link, and the version banner.
 *
 * Dropped wholesale, and not only for secrecy — they are long, and the 280
 * character budget below is spent on whatever survives. Keeping them would
 * push the revert reason past the truncation point, which is how a message
 * ends up saying "Missing or invalid parameters" about an HTTP 503.
 */
const BODY_PREFIX =
  /\b(?:Request body|Response body|URL|Version|Docs|Contract Call|(?:[A-Za-z][A-Za-z ]{0,30})?Arguments):[\s\S]*$/i;

/**
 * The `Details:` line viem appends, which is where the node's actual revert
 * reason lives. It sits AFTER `Request body:` in viem's layout, so stripping
 * from the body marker to end-of-string threw away the only diagnostically
 * useful part of the message. It is lifted out before the strip and re-attached
 * afterwards — first line only, since everything past it is `Version:` noise.
 */
const DETAILS_LINE = /\bDetails:[^\S\r\n]*([^\r\n]*)/i;

/**
 * Strip anything sensitive or unbounded out of an upstream message.
 *
 * Exported for direct use when logging a non-fatal provider warning.
 */
export function sanitizeMessage(input: string): string {
  const details = DETAILS_LINE.exec(input)?.[1]?.trim() ?? "";
  const head = input.replace(BODY_PREFIX, "").replace(DETAILS_LINE, "").trim();
  const joined = details.length === 0 ? head : `${head} Details: ${details}`;

  const collapsed = joined
    .replace(URLS, "[url]")
    .replace(LONG_HEX, "0x[redacted]")
    .replace(/\s+/g, " ")
    .trim();

  if (collapsed.length === 0) return "Wallet provider request failed.";
  if (collapsed.length <= MAX_MESSAGE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

/** Pull a string message out of an unknown thrown value. */
function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unknown provider failure.";
}

/* -------------------------------------------------------------------------- */
/* Revert selectors                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Custom-error selectors we can map with confidence.
 *
 * A 4-byte selector is the only unambiguous signal an EVM revert gives us, so
 * it is checked before any prose matching. Verified against the deployed
 * account implementation — see FINDINGS.md (b).
 */
export const REVERT_SELECTORS = {
  ExceededSpendLimit: toFunctionSelector("ExceededSpendLimit()"),
  KeyDoesNotExist: toFunctionSelector("KeyDoesNotExist()"),
  KeyExpired: toFunctionSelector("KeyExpired()"),
  Unauthorized: toFunctionSelector("Unauthorized()"),
  UnauthorizedCall: toFunctionSelector("UnauthorizedCall()"),
} as const satisfies Record<string, Hex>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Every string an error chain carries: its own message plus the `details`,
 * `shortMessage`, `data`, `metaMessages` and `cause` fields viem hangs off it.
 *
 * Bounded by a visited set so a self-referencing `cause` cannot loop.
 */
export function errorStrings(cause: unknown): readonly string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [cause];

  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === "string") {
      out.push(current);
      continue;
    }
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);

    for (const field of [
      "message",
      "shortMessage",
      "details",
      "reason",
      "data",
      "name",
    ] as const) {
      const value = current[field];
      if (typeof value === "string") out.push(value);
      else if (isRecord(value)) queue.push(value);
    }
    for (const field of ["cause", "error", "metaMessages"] as const) {
      const value = current[field];
      if (Array.isArray(value)) queue.push(...(value as readonly unknown[]));
      else if (value !== undefined) queue.push(value);
    }
  }

  return out;
}

/**
 * True when `cause` mentions `selector` as a standalone 4-byte value.
 *
 * The `0x` anchor and the trailing lookahead keep it from matching the same
 * four bytes buried inside calldata, which would misclassify unrelated
 * failures.
 */
export function mentionsRevertSelector(cause: unknown, selector: Hex): boolean {
  const pattern = new RegExp(`${selector}(?![0-9a-fA-F])`, "i");
  return errorStrings(cause).some((text) => pattern.test(text));
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Failures where an HTTP server ANSWERED, and the answer was the outage: a
 * status line, a rate limit, an upstream gateway complaining about its own
 * upstream.
 */
const STATUS_PATTERNS: readonly RegExp[] = [
  /\b(?:http|https|status|status code|code|error)\s*[:=]?\s*(?:40[13]|429|5\d{2})\b/i,
  /\b(?:40[13]|429|5\d{2})\s+(?:unauthorized|forbidden|too many requests|internal server error|bad gateway|service unavailable|gateway time-?out)\b/i,
  /\b(?:too many requests|rate ?limit(?:ed|ing)?|quota exceeded)\b/i,
  /\b(?:internal (?:rpc )?error|internal server error|bad gateway|service unavailable|gateway time-?out)\b/i,
  /\bapi key\b/i,
];

/**
 * Failures where NO server ever answered — the connection was reset, refused,
 * timed out, or never resolved. Added by PHASE3.1-FIXREVIEW F1.
 *
 * WHY THIS EXISTS, and why it belongs HERE rather than in a caller. Until F1
 * this module recognised {@link STATUS_PATTERNS} and nothing else, so the
 * COMMON blips of an HTTP JSON-RPC client — `socket hang up`, `ECONNRESET`,
 * `ETIMEDOUT`, a DNS `EAI_AGAIN`, undici's bare `fetch failed`, viem's own
 * `TimeoutError` — all fell through to `ProviderError`. That is precisely
 * backwards: a 429 that a server took the trouble to send was classified as an
 * outage, while a connection the server never even accepted was classified as
 * "something upstream went wrong, we do not know what". Callers that treat
 * `PROVIDER_ERROR` as terminal therefore gave the permanent answer to the most
 * transient failure there is (measured: PHASE3.1-FIXREVIEW F1's table).
 *
 * The vocabulary is Node's and undici's, not ours, and the shapes are the ones
 * viem actually produces:
 *
 *   - a viem `HttpRequestError` carries `Status: <n>` in its message ONLY when
 *     the server answered; a connection-level failure reads
 *     `HTTP request failed.` with the cause on the `Details:` line and no
 *     status at all, which is what `fetch failed` matches;
 *   - `TimeoutError`'s short message is `The request took too long to respond.`
 *     with `Details: The request timed out.`
 *
 * CASE-SENSITIVE for the errno codes on purpose: those are literal constants,
 * and matching them case-insensitively would fire on ordinary prose.
 *
 * ORDER MATTERS AND IS UNCHANGED: this is still checked after the revert
 * selectors and the decoded revert NAMES, so a real on-chain refusal —
 * `ExceededSpendLimit`, `KeyExpired`, `UnauthorizedCall` — is classified from
 * its own evidence long before any of these prose patterns is consulted. What
 * moves is only the residue that used to be `PROVIDER_ERROR`.
 *
 * WHAT THE ORDER DOES **NOT** BUY, stated because a normative claim once said
 * it did (PHASE3.1-FIXREVIEW2 **G2**, measured). Two of these patterns —
 * `\bnetwork (?:error|failure)\b` and `\b(?:timed ?out|timeout)\b` — are
 * generic English, not transport vocabulary, so a refusal the classifier knows
 * ONLY AS PROSE loses to them: `session has expired and the request timed out`
 * and `the session key has been revoked; socket hang up` both classify
 * `INFRASTRUCTURE_ERROR`. That residue is DELIBERATE and is not narrowed,
 * because for the one decision this class drives — "retry, or give up?" — a
 * free round trip above the submit is the cheap answer and a permanent skip on
 * a real socket reset is the expensive one (A1, the ship gate, exists because
 * the expensive answer was being given). Narrowing the two patterns to buy the
 * label back would regress that in exchange for a text-accuracy property.
 *
 * What the order DOES buy, and what {@link REVERT_EVIDENCE} extends it to, is
 * that a refusal carrying STRUCTURED evidence of an on-chain revert can never
 * be reclassified as an outage.
 */
const CONNECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENETRESET|EAI_AGAIN|ENOTFOUND|EPROTO)\b/,
  /\bUND_ERR_[A-Z_]+\b/,
  /\bsocket hang ?up\b/i,
  /\b(?:premature close|other side closed)\b/i,
  /\b(?:connection|socket) (?:reset|refused|closed|aborted|disconnected|failure|error)\b/i,
  /\bfetch failed\b/i,
  /\bnetwork (?:error|failure)\b/i,
  /\btook too long to respond\b/i,
  /\b(?:timed ?out|timeout)\b/i,
  // undici's bare `TypeError: terminated`. Anchored, because "terminated" in
  // the middle of a sentence is far more likely to be describing a session
  // than a socket, and the honest answer for that is the unchanged fallback.
  /^terminated\b/i,
];

/**
 * Evidence that a node ANSWERED and the call REVERTED — as opposed to prose
 * that merely reads like a refusal. Added by PHASE3.1-FIXREVIEW2 **G2**.
 *
 * WHY THIS EXISTS. `REVERT_SELECTORS` and the decoded-name checks below cover
 * FIVE names, and only those five, so `execution reverted: Timeout()` — a
 * perfectly ordinary custom error that a router, a quoter or a timelock can
 * genuinely revert with — matched `CONNECTION_PATTERNS`'s generic
 * `\b(?:timed ?out|timeout)\b` and was classified `INFRASTRUCTURE_ERROR`. The
 * consequence was not cosmetic: the LP saga's optional step retries that class
 * (`isTransientFailure`, `src/lp/sagas.ts`), so a deterministic on-chain
 * refusal was HELD and re-attempted up to six times before it took the skip it
 * should have taken on the first, and `AltanaProvider#chainWouldAllow`'s
 * pre-flight substituted the transport class for the allowlist refusal on a
 * read that had plainly reverted.
 *
 * The rule is the one the module header already states in the other direction:
 * classify from evidence, not from vocabulary. A revert marker is evidence that
 * a server answered, so an outage can never produce one, so the transport
 * patterns must not be consulted at all when one is present. The failure then
 * falls to the prose patterns and, failing those, to `ProviderError` — the
 * honest verdict for a revert we cannot name, and a PERMANENT one, which is
 * what a revert is.
 *
 * DELIBERATELY NARROW. Only the phrases viem and the JSON-RPC nodes actually
 * emit around a revert are listed; a bare `reverted` is NOT, because "the relay
 * reverted to its fallback endpoint" is prose about an outage. This list is
 * matched against BOTH the sanitized text and every string on the error chain,
 * the same reach {@link mentionsRevertSelector} already has, because viem hangs
 * the revert on a nested cause as often as on the top message.
 */
const REVERT_EVIDENCE: readonly RegExp[] = [
  /\bexecution reverted\b/i,
  /\breverted with (?:custom error|reason string|the following reason)\b/i,
  /\bContractFunctionRevertedError\b/,
  /\bcontract function\b[\s\S]{0,120}\breverted\b/i,
];

/**
 * Transport-level failures. Checked BEFORE the policy patterns, because an
 * HTTP 401 body reads "unauthorized" and a 500 reads "internal error" — both
 * would otherwise be filed as the user's policy refusing the call, which is a
 * lie that hides an outage behind a "you are not allowed" message.
 *
 * Two disjoint halves, kept separate above because they answer different
 * questions: {@link STATUS_PATTERNS} is "the server said it was broken",
 * {@link CONNECTION_PATTERNS} is "we never reached a server". Both are the
 * same verdict — `INFRASTRUCTURE_ERROR`, "try again" — and any caller that
 * distinguishes them is asking the wrong question.
 */
const INFRASTRUCTURE_PATTERNS: readonly RegExp[] = [
  ...STATUS_PATTERNS,
  ...CONNECTION_PATTERNS,
];

/** Prose fallbacks, used only when no selector matched. */
const CAP_PATTERNS: readonly RegExp[] = [
  /\bexceed(?:s|ed)? (?:the )?spend/i,
  /\bspend ?limit\b/i,
  /\bover the cap\b/i,
];

const EXPIRY_PATTERNS: readonly RegExp[] = [
  /\bexpired\b/i,
  /\bsession (?:has )?ended\b/i,
];

const NOT_ALLOWED_PATTERNS: readonly RegExp[] = [
  /\bunauthorized\b/i,
  /\bnot allowed\b/i,
  /\bnot permitted\b/i,
  /\bunknown key\b/i,
  /\bkey ?not ?found\b/i,
  /\brevoked\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Did a node answer with a revert? See {@link REVERT_EVIDENCE}.
 *
 * Searches the sanitized text first (the cheap case) and then every string the
 * error chain carries, so a revert wrapped in a viem `CallExecutionError` counts
 * even when the top message is generic.
 */
function mentionsRevert(cause: unknown, safe: string): boolean {
  if (matchesAny(safe, REVERT_EVIDENCE)) return true;
  return errorStrings(cause).some((text) => matchesAny(text, REVERT_EVIDENCE));
}

/**
 * Classify an upstream failure into one of our typed errors.
 *
 * Order is deliberate:
 *   1. our own errors pass through untouched;
 *   2. decoded revert selectors — the only unambiguous evidence available;
 *   3. infrastructure patterns, so an outage never masquerades as a policy
 *      rejection — UNLESS the failure carries {@link REVERT_EVIDENCE}, in which
 *      case a server demonstrably answered and step 3 is skipped entirely
 *      (PHASE3.1-FIXREVIEW2 G2);
 *   4. prose patterns over the SANITIZED message;
 *   5. `ProviderError`, rather than a guess.
 *
 * Neither the Altana SDK nor the Porto relay expose structured error codes
 * (FINDINGS.md (f)), so steps 3-4 remain heuristics — revisit on each SDK bump.
 */
export function mapProviderError(cause: unknown): ExecutionPlaneError {
  // Already ours: pass through untouched so codes are not double-mapped.
  if (cause instanceof ExecutionPlaneError) return cause;
  return classifyFrom(cause, sanitizeMessage(messageOf(cause)));
}

/**
 * The classifier both entry points share.
 *
 * `cause` is searched for revert SELECTORS (the only unambiguous evidence);
 * `safe` — an already-sanitized string — is matched against infra and prose
 * patterns. The two callers differ only in what they put in `safe`: the throw
 * path uses the top message (so a request body cannot masquerade as a reason),
 * while the FAILED-result path uses the whole body (there is no request body to
 * confuse it with, and the reason may live in a nested field).
 */
function classifyFrom(cause: unknown, safe: string): ExecutionPlaneError {
  if (mentionsRevertSelector(cause, REVERT_SELECTORS.ExceededSpendLimit)) {
    return new CapExceededError(safe);
  }
  if (mentionsRevertSelector(cause, REVERT_SELECTORS.KeyExpired)) {
    return new SessionExpiredError(safe);
  }
  if (
    mentionsRevertSelector(cause, REVERT_SELECTORS.UnauthorizedCall) ||
    mentionsRevertSelector(cause, REVERT_SELECTORS.Unauthorized) ||
    mentionsRevertSelector(cause, REVERT_SELECTORS.KeyDoesNotExist)
  ) {
    return new NotAllowedError(safe);
  }

  // Revert-error NAMES, when the node decoded them for us.
  if (/\bExceededSpendLimit\b/i.test(safe)) return new CapExceededError(safe);
  if (/\bKeyExpired\b/i.test(safe)) return new SessionExpiredError(safe);
  if (/\b(?:UnauthorizedCall|KeyDoesNotExist)\b/i.test(safe)) {
    return new NotAllowedError(safe);
  }

  // PHASE3.1-FIXREVIEW2 G2. A revert is proof that a server answered, so the
  // transport patterns have nothing to say about it and are not consulted. This
  // can only ever move a verdict OUT of `INFRASTRUCTURE_ERROR`: when no
  // transport pattern would have matched, skipping them changes nothing.
  if (!mentionsRevert(cause, safe) && matchesAny(safe, INFRASTRUCTURE_PATTERNS)) {
    return new InfrastructureError(safe);
  }

  if (matchesAny(safe, CAP_PATTERNS)) return new CapExceededError(safe);
  if (matchesAny(safe, EXPIRY_PATTERNS)) return new SessionExpiredError(safe);
  if (matchesAny(safe, NOT_ALLOWED_PATTERNS)) return new NotAllowedError(safe);

  return new ProviderError(safe);
}

/**
 * Classify a FAILED result into an error code, WITHOUT throwing.
 *
 * The session-execute path reports policy rejections as `status: "FAILED"`
 * rather than by throwing (FINDINGS.md (f)), so those failures never reach
 * `mapProviderError`'s catch path. This points the exact same selector and
 * prose matchers at the returned result body, so a FAILED `ExceededSpendLimit`
 * is classified `CAP_EXCEEDED`, an off-allowlist call `NOT_ALLOWED`, and a relay
 * outage `INFRASTRUCTURE_ERROR` — the same verdicts the throw path would give.
 *
 * Unlike the throw path this gathers EVERY string the result carries before
 * matching, because a FAILED body has no request-body noise to guard against
 * and its reason often sits in a nested field rather than the top message.
 */
export function classifyFailureCode(result: unknown): ExecutionErrorCode {
  if (result instanceof ExecutionPlaneError) return result.code;
  const safe = sanitizeMessage(errorStrings(result).join(" \n "));
  return classifyFrom(result, safe).code;
}
