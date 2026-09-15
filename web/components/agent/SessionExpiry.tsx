"use client";

/**
 * The session-expiry chip, ONCE, beside the status pill.
 *
 * Every hire is an on-chain session with a hard expiry (seven days at most —
 * `MAX_TRADE_SESSION_SECONDS`), and after it nothing the plane does can move
 * the wallet: not the worker's exits, not the Sell button, which rides the same
 * session key. Until 2026-09-15 no page said when that was. Two trading agents
 * sat on their sixth day showing "Live" with four open positions, and the only
 * place the date existed was the daily cap's tooltip sentence.
 *
 * The pill is the run state and stays the plane's; this chip is the CLOCK. It
 * is pure arithmetic over `sessionExpiresAt` so the list and the detail pages
 * cannot disagree about the same session, and it renders nothing when the
 * plane recorded no session — silence, not a guess.
 */

export type SessionExpiryState = "none" | "ok" | "soon" | "expired";

export type SessionExpiryView = {
  readonly state: SessionExpiryState;
  /** Chip text; empty for `none`. */
  readonly label: string;
  /** Tooltip: the exact instant, ISO, so the short label is never the only record. */
  readonly title: string;
};

/** Under this much authority left the chip turns to its warning tone. */
export const SESSION_SOON_MS = 24 * 60 * 60 * 1_000;

/** `5d 3h`, `6h 12m`, `9m` — the biggest two units that are non-zero, never seconds. */
export function formatRemaining(ms: number): string {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const left = Math.max(0, ms);
  if (left >= day) {
    const days = Math.floor(left / day);
    const hours = Math.floor((left % day) / hour);
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  }
  if (left >= hour) {
    const hours = Math.floor(left / hour);
    const minutes = Math.floor((left % hour) / minute);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  return `${Math.max(1, Math.floor(left / minute))}m`;
}

/**
 * The chip's state for a session expiring at `expiresAtSec` (unix seconds), as
 * of `nowMs`. `null` or a malformed expiry is `none`: an unread fact is not a
 * fact, and a chip that guessed "expired" would send an owner to re-hire an
 * agent whose session is fine.
 */
export function sessionExpiry(expiresAtSec: number | null | undefined, nowMs: number): SessionExpiryView {
  if (expiresAtSec === null || expiresAtSec === undefined || !Number.isSafeInteger(expiresAtSec) || expiresAtSec < 0 || !Number.isSafeInteger(nowMs)) {
    return { state: "none", label: "", title: "" };
  }
  const expiresAtMs = expiresAtSec * 1_000;
  const title = `Session authority ends ${new Date(expiresAtMs).toISOString()}`;
  const left = expiresAtMs - nowMs;
  if (left <= 0) return { state: "expired", label: "Session expired", title: `${title}. The agent can no longer trade or exit; withdraw with the passkey or hire again.` };
  if (left < SESSION_SOON_MS) return { state: "soon", label: `Expires in ${formatRemaining(left)}`, title: `${title}. Exits stop working after this; close positions before then.` };
  return { state: "ok", label: `Session · ${formatRemaining(left)}`, title };
}

const TONES: Record<Exclude<SessionExpiryState, "none">, string> = {
  ok: "var(--text-muted)",
  soon: "var(--warn)",
  expired: "var(--danger)",
};

/** The chip beside a status pill; the same visual as `AttentionChip`, on purpose. */
export function SessionExpiryChip({ expiresAt, nowMs }: { readonly expiresAt: number | null | undefined; readonly nowMs: number }) {
  const view = sessionExpiry(expiresAt, nowMs);
  if (view.state === "none") return null;
  const tone = TONES[view.state];
  return (
    <span
      title={view.title}
      data-session-expiry={view.state}
      style={{
        font: "var(--type-mono-xs)", color: tone, border: `1px solid ${tone}`,
        borderRadius: "var(--radius-sm)", padding: "1px 6px", whiteSpace: "nowrap",
      }}>
      {view.label}
    </span>
  );
}
