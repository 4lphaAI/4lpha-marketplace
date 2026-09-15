import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SESSION_SOON_MS, SessionExpiryChip, formatRemaining, sessionExpiry } from "./SessionExpiry";

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
