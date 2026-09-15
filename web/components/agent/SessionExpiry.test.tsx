import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SESSION_SOON_MS, SessionExpiryChip, SessionExpiryNotice, formatRemaining, sessionExpiry, sessionPillOverride } from "./SessionExpiry";

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1_000);

describe("session expiry: the clock beside the pill (2026-09-15)", () => {
  it("prints the two largest non-zero units and never seconds", () => {
    expect(formatRemaining(5 * 86_400_000 + 3 * 3_600_000 + 59 * 60_000)).toBe("5d 3h");
    expect(formatRemaining(5 * 86_400_000)).toBe("5d");
    expect(formatRemaining(6 * 3_600_000 + 12 * 60_000 + 59_000)).toBe("6h 12m");
    expect(formatRemaining(6 * 3_600_000)).toBe("6h");
    expect(formatRemaining(9 * 60_000 + 30_000)).toBe("9m");
    // Under a minute still reads as a minute: "0m" would say "expired" to a reader.
    expect(formatRemaining(15_000)).toBe("1m");
    expect(formatRemaining(-5)).toBe("1m");
  });

  it("is silent without a recorded session, and refuses to guess on a malformed one", () => {
    expect(sessionExpiry(null, NOW).state).toBe("none");
    expect(sessionExpiry(undefined, NOW).state).toBe("none");
    expect(sessionExpiry(-1, NOW).state).toBe("none");
    expect(sessionExpiry(1.5, NOW).state).toBe("none");
    expect(sessionExpiry(sec(NOW) + 10, Number.NaN).state).toBe("none");
    expect(renderToStaticMarkup(<SessionExpiryChip expiresAt={null} nowMs={NOW} />)).toBe("");
  });

  it("reads ok above a day, soon under it, and expired at the instant — with the ISO time in the title", () => {
    const ok = sessionExpiry(sec(NOW + 5 * 86_400_000 + 3 * 3_600_000), NOW);
    expect(ok).toMatchObject({ state: "ok", label: "Session · 5d 3h" });
    expect(ok.title).toContain("2026-09-20T15:00:00.000Z");

    const boundary = sessionExpiry(sec(NOW + SESSION_SOON_MS), NOW);
    expect(boundary.state).toBe("ok");
    const soon = sessionExpiry(sec(NOW + SESSION_SOON_MS - 1_000), NOW);
    expect(soon.state).toBe("soon");
    expect(soon.label).toBe("Expires in 23h 59m");
    expect(soon.title).toContain("close positions before then");

    const atInstant = sessionExpiry(sec(NOW), NOW);
    expect(atInstant).toMatchObject({ state: "expired", label: "Session expired" });
    expect(atInstant.title).toContain("withdraw with the passkey");
    expect(sessionExpiry(sec(NOW) - 86_400, NOW).state).toBe("expired");
  });

  it("renders the state on the chip so a page can style or find it", () => {
    const html = renderToStaticMarkup(<SessionExpiryChip expiresAt={sec(NOW + 3_600_000)} nowMs={NOW} />);
    expect(html).toContain('data-session-expiry="soon"');
    expect(html).toContain("Expires in 1h");
    expect(html).toContain("var(--warn)");
    expect(renderToStaticMarkup(<SessionExpiryChip expiresAt={sec(NOW) - 1} nowMs={NOW} />)).toContain("var(--danger)");
  });
});

describe("the shared pill override and notice, one wording for four agent kinds", () => {
  const soon = sec(NOW + 6 * 3_600_000);
  const dead = sec(NOW) - 60;

  it("overrides the pill only for an ARMED agent whose session is dead", () => {
    expect(sessionPillOverride(sessionExpiry(dead, NOW), "armed")).toEqual({ status: "danger", label: "expired" });
    expect(sessionPillOverride(sessionExpiry(dead, NOW), "paused")).toBeNull();
    expect(sessionPillOverride(sessionExpiry(dead, NOW), "revoked")).toBeNull();
    expect(sessionPillOverride(sessionExpiry(soon, NOW), "armed")).toBeNull();
    expect(sessionPillOverride(sessionExpiry(null, NOW), "armed")).toBeNull();
  });

  it("is silent with days left, without a session, and for agents outside the session's life", () => {
    for (const kind of ["trade", "lp", "grid", "lending"] as const) {
      expect(renderToStaticMarkup(<SessionExpiryNotice kind={kind} expiresAt={sec(NOW + 3 * 86_400_000)} nowMs={NOW} status="armed" open={4} />)).toBe("");
      expect(renderToStaticMarkup(<SessionExpiryNotice kind={kind} expiresAt={null} nowMs={NOW} status="armed" open={4} />)).toBe("");
      expect(renderToStaticMarkup(<SessionExpiryNotice kind={kind} expiresAt={dead} nowMs={NOW} status="revoked" open={4} />)).toBe("");
      expect(renderToStaticMarkup(<SessionExpiryNotice kind={kind} expiresAt={dead} nowMs={NOW} status="provisioning" open={0} />)).toBe("");
    }
  });

  it("warns under a day only when there is exposure, in the kind's own words, and differently when paused", () => {
    expect(renderToStaticMarkup(<SessionExpiryNotice kind="trade" expiresAt={soon} nowMs={NOW} status="armed" open={0} />)).toBe("");
    const trade = renderToStaticMarkup(<SessionExpiryNotice kind="trade" expiresAt={soon} nowMs={NOW} status="armed" open={4} />);
    expect(trade).toContain('data-session-notice="soon"');
    expect(trade).toContain("Session ends in 6h. Exits stop working after that — sell the open positions before then, or remove the agent now to exit everything to BNB.");
    expect(renderToStaticMarkup(<SessionExpiryNotice kind="lp" expiresAt={soon} nowMs={NOW} status="armed" open={1} />)).toContain("Rotates, harvests and closes stop working after that");
    expect(renderToStaticMarkup(<SessionExpiryNotice kind="grid" expiresAt={soon} nowMs={NOW} status="armed" open={2} />)).toContain("Requotes and closes stop working after that — close the ladder before then");
    expect(renderToStaticMarkup(<SessionExpiryNotice kind="lending" expiresAt={soon} nowMs={NOW} status="armed" open={1} />)).toContain("The guard stops repaying after that");
    const paused = renderToStaticMarkup(<SessionExpiryNotice kind="trade" expiresAt={soon} nowMs={NOW} status="paused" open={2} />);
    expect(paused).toContain('data-session-notice="paused-soon"');
    expect(paused).toContain("Paused — the session ends in 6h. Resume to let the agent sell, or withdraw tokens yourself before then.");
  });

  it("says what died and what the owner can still do once the session is over, with or without exposure", () => {
    expect(renderToStaticMarkup(<SessionExpiryNotice kind="trade" expiresAt={dead} nowMs={NOW} status="armed" open={4} />))
      .toContain("Session expired. The agent can no longer trade or exit its 4 open positions; withdraw tokens from Account → Withdraw, then remove this agent and hire again.");
    expect(renderToStaticMarkup(<SessionExpiryNotice kind="trade" expiresAt={dead} nowMs={NOW} status="paused" open={0} />))
      .toContain("Session expired. The agent can no longer trade or exit; withdraw tokens");
    expect(renderToStaticMarkup(<SessionExpiryNotice kind="lp" expiresAt={dead} nowMs={NOW} status="armed" open={1} />))
      .toContain("can no longer rotate, harvest or close its 1 open position; the positions stay in your wallet — close them with the passkey from this page, or hire again.");
    expect(renderToStaticMarkup(<SessionExpiryNotice kind="grid" expiresAt={dead} nowMs={NOW} status="armed" open={2} />))
      .toContain("can no longer requote or close its 2 live orders; the orders stay in your wallet as positions");
    expect(renderToStaticMarkup(<SessionExpiryNotice kind="lending" expiresAt={dead} nowMs={NOW} status="armed" open={1} />))
      .toContain("can no longer repay on the borrower&#x27;s behalf; the reserve stays in the guard wallet");
  });
});
