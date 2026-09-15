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

/** The per-kind sentences: what stops, and what the owner can still do. */
const COPY: Record<SessionExpiryKind, {
  readonly stops: (open: number) => string;
  readonly expiredRecovery: string;
  readonly soonAdvice: string;
  readonly pausedAdvice: string;
}> = {
  trade: {
    stops: (open) => `trade or exit${open > 0 ? ` its ${open} open position${open === 1 ? "" : "s"}` : ""}`,
    expiredRecovery: "withdraw tokens from Account → Withdraw, then remove this agent and hire again.",
    soonAdvice: "Exits stop working after that — sell the open positions before then, or remove the agent now to exit everything to BNB.",
    pausedAdvice: "Resume to let the agent sell, or withdraw tokens yourself before then.",
  },
  lp: {
    stops: (open) => `rotate, harvest or close${open > 0 ? ` its ${open} open position${open === 1 ? "" : "s"}` : ""}`,
    expiredRecovery: "the positions stay in your wallet — close them with the passkey from this page, or hire again.",
    soonAdvice: "Rotates, harvests and closes stop working after that — close the positions before then, or remove the agent now.",
    pausedAdvice: "Resume to let the agent act, or close the positions yourself before then.",
  },
  grid: {
    stops: (open) => `requote or close${open > 0 ? ` its ${open} live order${open === 1 ? "" : "s"}` : ""}`,
    expiredRecovery: "the orders stay in your wallet as positions — close them with the passkey from this page, or hire again.",
    soonAdvice: "Requotes and closes stop working after that — close the ladder before then, or remove the agent now.",
    pausedAdvice: "Resume to let the agent act, or close the ladder yourself before then.",
  },
  lending: {
    stops: () => "repay on the borrower's behalf",
    expiredRecovery: "the reserve stays in the guard wallet — withdraw it from Account → Withdraw, then remove this guard and hire again.",
    soonAdvice: "The guard stops repaying after that — remove the guard before then and hire it again.",
    pausedAdvice: "Resume to let the guard act, or remove it before then.",
  },
};

/**
 * The one-line consequence under the title, on every agent kind, ONCE.
 *
 * Renders nothing while the session has more than a day left, nothing without
 * a recorded session, and — for `soon` — nothing when there is no exposure to
 * strand (`open === 0`): a warning with nothing to do is noise. `expired`
 * always shows for an armed or paused agent, because the page's own pill is
 * the only other place the fact could live and the pill has no room for the
 * remedy. Revoked / retired / provisioning agents are past or before the
 * session and get nothing here.
 */
/** Bounded so a page whose hero is a flex row (LP, grid, lending title columns) wraps its actions instead of stretching. */
const NOTICE_STYLE = { maxWidth: "88ch" } as const;

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
  if (view.state === "expired") {
    return <div className="fl-trade-message fl-trade-message--warning" style={NOTICE_STYLE} role="alert" data-session-notice="expired">
      Session expired. The agent can no longer {copy.stops(open)}; {copy.expiredRecovery}
    </div>;
  }
  if (open <= 0) return null;
  if (status === "paused") {
    return <div className="fl-trade-message fl-trade-message--warning" style={NOTICE_STYLE} role="alert" data-session-notice="paused-soon">
      Paused — the session ends in {remaining}. {copy.pausedAdvice}
    </div>;
  }
  return <div className="fl-trade-message fl-trade-message--warning" style={NOTICE_STYLE} role="alert" data-session-notice="soon">
    Session ends in {remaining}. {copy.soonAdvice}
  </div>;
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
