/**
 * What the lending guard's session may do, read from the GRANT — never from a
 * shared block of marketing copy.
 *
 * The mock-up reused a generic permissions panel whose three lines were false
 * for this agent. The real answer is `GET /agents/:id/session`, which for an
 * armed agent returns the owner projection carrying the session's own
 * `allowedCalls` and `spendCaps` (`src/http/wire.ts`). This module parses that
 * projection and turns it into the owner's sentences.
 *
 * THE SENTENCE THAT MUST NEVER BE SOFTENED (audit blocker): a leaked session
 * key CAN move the reserve out of the agent wallet — by approving any spender
 * on USDT or by naming any recipient on the granted router. `CallRule` cannot
 * constrain an argument, so the caps are the bound, not the call list. The
 * page must never print "cannot send funds to any wallet but yours".
 */
import { INVALID, type Invalid } from "@/lib/exec/lending-types";
import { formatAtomicAmount } from "./form";

/** `MAX_VENUS_SESSION_SECONDS` (`src/ops/policy.ts`) — seven days, hard. */
export const LENDING_MAX_SESSION_SECONDS = 7 * 24 * 60 * 60;
export const LENDING_MAX_SESSION_DAYS = 7;

export type SessionCallRule = {
  readonly to: string | null;
  readonly selector: string | null;
};

export type SessionSpendCap = {
  readonly token: string | null;
  /**
   * The cap's rolling window, as the plane sends it.
   *
   * A STRING — `"minute" | "hour" | "day" | "week" | "month" | "year"`
   * (`SpendPeriod`, `src/core/types.ts:29`), forwarded verbatim by the agent
   * read (`src/http/wire.ts:1037`). It was typed `number` here at first and
   * the parser refused anything else, which made the Permissions tab answer
   * "no live session grant" for EVERY real agent while the fixture — written
   * to the code rather than to the contract — kept the tests green. The type
   * is left open to any non-empty string so a period this build has not heard
   * of degrades to its own name instead of voiding the whole grant.
   */
  readonly period: string;
  readonly limit: string;
};

export type SessionGrantView = {
  readonly publicKey: string | null;
  readonly expiresAt: number | null;
  readonly allowedCalls: readonly SessionCallRule[];
  readonly spendCaps: readonly SessionSpendCap[];
};

function isRow(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `GET /agents/:id/session` for an ARMED agent.
 *
 * The route answers `{ data: { status: "armed", agent: { session: {…} } } }`
 * and only that shape carries a grant; a provisioning row carries a PENDING
 * grant instead, which is an intention rather than authority and is deliberately
 * not rendered as one.
 */
export function parseSessionGrant(payload: unknown): SessionGrantView | Invalid {
  const body = isRow(payload);
  const data = isRow(body?.["data"]) ?? body;
  const agent = isRow(data?.["agent"]);
  const session = isRow(agent?.["session"]);
  if (session === null) return INVALID;
  const rawCalls = session["allowedCalls"];
  const rawCaps = session["spendCaps"];
  if (!Array.isArray(rawCalls) || !Array.isArray(rawCaps)) return INVALID;
  const allowedCalls: SessionCallRule[] = [];
  for (const entry of rawCalls) {
    const rule = isRow(entry);
    if (rule === null) return INVALID;
    allowedCalls.push({
      to: typeof rule["to"] === "string" ? rule["to"] : null,
      selector: typeof rule["selector"] === "string" ? rule["selector"] : null,
    });
  }
  const spendCaps: SessionSpendCap[] = [];
  for (const entry of rawCaps) {
    const cap = isRow(entry);
    if (cap === null) return INVALID;
    const limit = cap["limit"];
    const period = cap["period"];
    if (typeof limit !== "string" || typeof period !== "string" || period === "") return INVALID;
    spendCaps.push({
      token: typeof cap["token"] === "string" ? cap["token"] : null,
      period,
      limit,
    });
  }
  return {
    publicKey: typeof session["publicKey"] === "string" ? session["publicKey"] : null,
    expiresAt: typeof session["expiresAt"] === "number" ? session["expiresAt"] : null,
    allowedCalls,
    spendCaps,
  };
}

/** The known Venus/venue selectors, in the owner's words. */
const SELECTOR_COPY: Readonly<Record<string, string>> = {
  "mint(uint256)": "supply USDT into Venus, so the reserve earns while it waits",
  "redeemUnderlying(uint256)": "take that USDT back out of Venus when a repay needs it",
  "repayBorrowBehalf(address,uint256)": "repay USDT debt on behalf of the guarded account",
  "repayBorrowBehalf(address)": "repay BNB debt on behalf of the guarded account",
  "approve(address,uint256)": "approve a spender on USDT — the amount is bounded by the day cap, the SPENDER is not",
};

export type PermissionLine = {
  readonly kind: "allow" | "deny";
  readonly text: string;
  readonly note: string;
};

/**
 * What the session CAN do, built from the grant's own rows.
 *
 * A target-only rule (no selector) is the router and the treasury: EVERY
 * function on that address is reachable, which is why the line says so instead
 * of naming a swap.
 */
export function lendingGrantAllows(grant: SessionGrantView): readonly PermissionLine[] {
  const lines: PermissionLine[] = [];
  for (const rule of grant.allowedCalls) {
    const target = rule.to ?? "any address";
    if (rule.selector === null) {
      lines.push({
        kind: "allow",
        text: `Call any function on ${target}`,
        note: "target-only rule: this is the pinned router (and the fee treasury). A session key that reaches it can name any recipient — the day caps are what bound it.",
      });
      continue;
    }
    const copy = SELECTOR_COPY[rule.selector];
    lines.push({
      kind: "allow",
      text: copy === undefined ? `Call ${rule.selector} on ${target}` : `${copy[0]?.toUpperCase()}${copy.slice(1)}`,
      note: `${rule.selector} on ${target}`,
    });
  }
  return lines;
}

/**
 * What the grant does NOT contain, by name.
 *
 * These are absences the template enforces (`LENDING_REFUSED_SELECTORS`), and
 * they are the ones an owner would otherwise have to take on trust.
 */
export function lendingGrantDenies(): readonly PermissionLine[] {
  return [
    { kind: "deny", text: "Borrow against your account", note: "borrow(uint256) is not in the grant" },
    { kind: "deny", text: "Enter or exit a Venus market for you", note: "enterMarkets(address[]) / exitMarket(address) are not in the grant" },
    { kind: "deny", text: "Mint a native vBNB position", note: "mint() is refused: vBNB pays out through a 2300-gas transfer that reverts against this wallet, so such a position would be unredeemable" },
    { kind: "deny", text: "Touch the wallet's own admin surface or the Altana KeyStore", note: "both addresses are refused structurally by the session template, so the key can never widen itself" },
    { kind: "deny", text: "Move your collateral, or anything the guarded account holds", note: "the grant is on the AGENT wallet; your own account is only ever repaid into" },
  ];
}

/**
 * The honest custody sentence. Load-bearing; do not soften it.
 */
export const LENDING_LEAKED_KEY_SENTENCE =
  "A leaked session key CAN move the reserve out of the agent wallet: it can approve any spender on USDT, and the router rule is target-only, so it can name any recipient. What bounds it is the caps — per rolling day, and over the session's seven-day life, seven times each. Nothing here can send YOUR account's collateral anywhere.";

/**
 * The exposure a cap actually buys: cap x 7 days, stated rather than implied.
 *
 * The x7 holds only for a DAILY cap, which is what every lending template
 * grants (`DEFAULT_TOKEN_CAP_PERIOD`, and the native caps are day caps too).
 * A cap on any other rolling window would make "seven times" wrong by a
 * factor of the window, so `overSession` is `null` there and the caller shows
 * the period instead of a total this build cannot derive.
 */
export function lendingCapExposure(cap: SessionSpendCap, usdtDecimals: number): {
  readonly perDay: string;
  readonly overSession: string | null;
  readonly label: string;
  readonly period: string;
} {
  const native = cap.token === null;
  const decimals = native ? 18 : usdtDecimals;
  const places = native ? 6 : 2;
  const unit = native ? "BNB" : "USDT";
  const daily = cap.period === "day";
  let limit: bigint;
  try { limit = BigInt(cap.limit); } catch { limit = 0n; }
  return {
    label: native
      ? (daily ? "Daily BNB spend cap" : `BNB spend cap per ${cap.period}`)
      : (daily ? "Daily USDT spend cap" : `USDT spend cap per ${cap.period}`),
    period: cap.period,
    perDay: `${formatAtomicAmount(cap.limit, decimals, places)} ${unit}`,
    overSession: daily
      ? `${formatAtomicAmount((limit * BigInt(LENDING_MAX_SESSION_DAYS)).toString(10), decimals, places)} ${unit}`
      : null,
  };
}

/**
 * Fix 7 — what `reserveCapWei` actually meters.
 *
 * It is charged by EVERY USDT approve the session makes: the arm's mint
 * approve, a rescue's approve, the retire's router approve. Calling it a
 * "daily repay limit" told the owner it bounded repays, which is neither what
 * it counts nor what it protects them from.
 */
export const LENDING_USDT_CAP_LABEL = "Daily USDT spend cap";
export const LENDING_USDT_CAP_NOTE =
  "charged by every USDT approve the session makes — the arm's supply, a repay, and the retire's swap — not by repays alone. The spend against today's cap is not reported by this view.";
