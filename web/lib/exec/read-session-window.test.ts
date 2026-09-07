// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_READ_EXPIRY_KEY, forgetReadExpiry, rememberReadExpiry, storedReadExpiryMs, subscribeReadExpiry } from "./read-session-window";

describe("shared read-session window", () => {
  afterEach(() => localStorage.clear());

  it("remembers only expiry so Account, detail and hire can reuse the same cookie", () => {
    rememberReadExpiry(localStorage, 90_000);
    expect(storedReadExpiryMs(localStorage, 1_000)).toBe(90_000);
    expect(localStorage.getItem(ACCOUNT_READ_EXPIRY_KEY)).toBe("90000");
    expect(localStorage.length).toBe(1);
    expect(storedReadExpiryMs(localStorage, 90_000)).toBeNull();
  });

  it("notifies mounted readers on same-tab sign-in, another tab, and forgetting", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReadExpiry(listener);
    rememberReadExpiry(localStorage, 90_000);
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key: ACCOUNT_READ_EXPIRY_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
    forgetReadExpiry(localStorage);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(storedReadExpiryMs(localStorage, 1_000)).toBeNull();
    unsubscribe();
    rememberReadExpiry(localStorage, 90_000);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("refuses malformed expiry metadata and tolerates unavailable storage", () => {
    for (const raw of ["bad", "Infinity", "90000.5", "-1"]) {
      localStorage.setItem(ACCOUNT_READ_EXPIRY_KEY, raw);
      expect(storedReadExpiryMs(localStorage, 1_000)).toBeNull();
    }
    expect(storedReadExpiryMs(undefined, 1_000)).toBeNull();
    expect(() => rememberReadExpiry(undefined, 90_000)).not.toThrow();
  });
});
