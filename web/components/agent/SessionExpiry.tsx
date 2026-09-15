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

import { useEffect, useState } from "react";

export type SessionExpiryState = "none" | "ok" | "soon" | "expired";

/**
 * A minute clock for the chip and the notice: the countdown must move without
 * a refetch, and one minute is the finest unit either prints.
 */
export function useSessionClock(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

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

/**
 * The status pill an ARMED agent with a dead session should wear. The plane's
 * status row does not change on expiry (there is no sweep for it), so every
 * detail page derives "expired" from the same clock instead of saying "Live"
 * about an agent nothing can execute for. `null` = keep the page's own pill.
 */
export function sessionPillOverride(
  view: SessionExpiryView,
  status: string | undefined,
): { readonly status: "danger"; readonly label: "expired" } | null {
  return view.state === "expired" && status === "armed" ? { status: "danger", label: "expired" } : null;
}

export type SessionExpiryKind = "trade" | "lp" | "grid" | "lending";

/**
 * One short line per kind and state. Operator, 2026-09-15, on the first live
 * render: "banner to quá, text quá dài" — so: no box, no counts, the remedy in
 * the fewest words, in the same mono line as the gas notice above it.
 */
const COPY: Record<SessionExpiryKind, {
  readonly expired: string;
  readonly soon: (remaining: string) => string;
  readonly paused: (remaining: string) => string;
}> = {
  trade: {
    expired: "Session expired — the agent can't trade or sell. Withdraw tokens from Account, or hire again.",
    soon: (r) => `Session ends in ${r} — sell open positions before then, or remove the agent.`,
    paused: (r) => `Paused · session ends in ${r} — resume so the agent can sell, or withdraw tokens yourself.`,
  },
  lp: {
    expired: "Session expired — the agent can't rotate or close. Close positions with your passkey below, or hire again.",
    soon: (r) => `Session ends in ${r} — close positions before then, or remove the agent.`,
    paused: (r) => `Paused · session ends in ${r} — resume, or close positions yourself.`,
  },
  grid: {
    expired: "Session expired — the agent can't requote or close. Close orders on chain below, or hire again.",
    soon: (r) => `Session ends in ${r} — close the ladder before then, or remove the agent.`,
    paused: (r) => `Paused · session ends in ${r} — resume, or close the ladder yourself.`,
  },
  lending: {
    expired: "Session expired — the guard can't repay. Withdraw the reserve from Account, or hire again.",
    soon: (r) => `Session ends in ${r} — remove the guard before then and hire it again.`,
    paused: (r) => `Paused · session ends in ${r} — resume, or remove the guard.`,
  },
};

/**
 * The one-line consequence under the title, on every agent kind, ONCE.
 *
 * Renders nothing while the session has more than a day left, nothing without
 * a recorded session, and — for `soon` — nothing when there is no exposure to
 * strand (`open === 0`): a warning with nothing to do is noise. `expired`
 * always shows for an armed or paused agent, because the pill has no room for
 * the remedy. Revoked / retired / provisioning agents are past or before the
 * session and get nothing here. Same visual as `GasNotice`: a mono line, no box.
 */
export function SessionExpiryNotice({ kind, expiresAt, nowMs, status, open }: {
  readonly kind: SessionExpiryKind;
  readonly expiresAt: number | null | undefined;
  readonly nowMs: number;
  readonly status: string | undefined;
  /** Open positions / live orders / an active guard (1) — what the session's death strands. */
  readonly open: number;
}) {
  const view = sessionExpiry(expiresAt, nowMs);
  if (view.state === "none" || view.state === "ok") return null;
  if (status !== "armed" && status !== "paused") return null;
  const copy = COPY[kind];
  const remaining = view.label.replace(/^Expires in /u, "");
  const line = (state: "expired" | "paused-soon" | "soon", text: string, tone: string) =>
    <span role="alert" data-session-notice={state} style={{ font: "var(--type-mono-xs)", color: tone }}>{text}</span>;
  if (view.state === "expired") return line("expired", copy.expired, "var(--danger)");
  if (open <= 0) return null;
  if (status === "paused") return line("paused-soon", copy.paused(remaining), "var(--warn)");
  return line("soon", copy.soon(remaining), "var(--warn)");
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
