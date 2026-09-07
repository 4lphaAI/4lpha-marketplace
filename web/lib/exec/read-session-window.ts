/** Expiry metadata only. The read credential stays in the HttpOnly session cookie. */
export const ACCOUNT_READ_EXPIRY_KEY = "4lpha:account-read-expiry:v1";
const CHANGED = "4lpha:account-read-changed";
type ReadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readSessionStorage(): ReadStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function storedReadExpiryMs(storage: ReadStorage | undefined, nowMs = Date.now()): number | null {
  try {
    const raw = storage?.getItem(ACCOUNT_READ_EXPIRY_KEY);
    if (raw === null || raw === undefined) return null;
    const expiryMs = Number(raw);
    return Number.isSafeInteger(expiryMs) && expiryMs > nowMs ? expiryMs : null;
  } catch { return null; }
}

export function rememberReadExpiry(storage: ReadStorage | undefined, expiryMs: number): void {
  if (!Number.isSafeInteger(expiryMs)) return;
  try { storage?.setItem(ACCOUNT_READ_EXPIRY_KEY, String(expiryMs)); } catch { /* private window */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

export function forgetReadExpiry(storage: ReadStorage | undefined): void {
  try { storage?.removeItem(ACCOUNT_READ_EXPIRY_KEY); } catch { /* private window */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

/** A sign-in from Account, hire or another tab resumes readers without signing. */
export function subscribeReadExpiry(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACCOUNT_READ_EXPIRY_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", onStorage);
  };
}
