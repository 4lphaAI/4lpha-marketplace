import { PASSKEY_STORAGE_KEY, loadStoredPasskey, type StoredPasskey } from "./passkey";
import { forgetReadExpiry, readSessionStorage } from "./read-session-window";
import { migrateHirePointers } from "./account-hire-storage";

const PREFIX = "4lpha:account:v1:";
const LOCK = "4lpha:account-transition:v1";
let unsavedAccount = false;
export function retainUnsavedAccount(): void { unsavedAccount = true; }

export function publicAccount(value: unknown): StoredPasskey | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.x !== "string" || !/^0x[\da-f]{64}$/iu.test(r.x)
    || typeof r.y !== "string" || !/^0x[\da-f]{64}$/iu.test(r.y)
    || typeof r.credentialId !== "string" || !/^[\w-]{1,2048}$/u.test(r.credentialId)
    || typeof r.rpId !== "string" || !/^[a-z\d.-]{1,253}$/iu.test(r.rpId)
    || typeof r.createdAt !== "number" || !Number.isSafeInteger(r.createdAt) || r.createdAt < 0
    || (r.label !== undefined && (typeof r.label !== "string" || r.label.length > 64 || /[\x00-\x1f\x7f]/u.test(r.label)))
    || (r.walletAddress !== undefined && (typeof r.walletAddress !== "string" || !/^0x[\da-f]{40}$/iu.test(r.walletAddress)))) return null;
  return { x: r.x as StoredPasskey["x"], y: r.y as StoredPasskey["y"], credentialId: r.credentialId,
    rpId: r.rpId, createdAt: r.createdAt,
    ...(r.label !== undefined ? { label: r.label as string } : {}),
    ...(r.walletAddress !== undefined ? { walletAddress: r.walletAddress as StoredPasskey["walletAddress"] } : {}) };
}

function key(record: StoredPasskey): string { return PREFIX + record.rpId + ":" + record.credentialId; }
function same(a: StoredPasskey, b: StoredPasskey): boolean {
  return a.credentialId === b.credentialId && a.rpId === b.rpId && a.x === b.x && a.y === b.y
    && a.walletAddress?.toLowerCase() === b.walletAddress?.toLowerCase();
}
function checkedWrite(storage: Storage, k: string, value: string): void {
  storage.setItem(k, value);
  if (storage.getItem(k) !== value) throw new Error("Browser storage could not save this account. Keep this page open and retry.");
}
export function rememberAccount(record: StoredPasskey, storage = localStorage): void {
  const clean = publicAccount(record);
  if (!clean) throw new Error("Invalid account metadata.");
  const old = storage.getItem(key(clean));
  if (old !== null) {
    const parsed = publicAccount(JSON.parse(old));
    if (!parsed || !same(parsed, clean)) throw new Error("Saved account identity conflicts with this passkey.");
    return;
  }
  checkedWrite(storage, key(clean), JSON.stringify(clean));
}
export function rememberedAccounts(storage = localStorage): StoredPasskey[] {
  const rows: StoredPasskey[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    try {
      const row = publicAccount(JSON.parse(storage.getItem(k) ?? "null"));
      if (row && key(row) === k) rows.push(row);
    } catch { /* malformed local hint is never a selectable account */ }
  }
  const active = loadStoredPasskey();
  if (active && publicAccount(active) && !rows.some((r) => same(r, active))) rows.unshift(active);
  return rows;
}

/** Lock covers the OS ceremony as well as commit; duplicate clicks never queue a new account. */
export async function accountTransition<T>(run: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("Account switching needs a browser with Web Locks enabled.");
  return navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("Another tab is changing accounts. Finish there first.");
    const storage = localStorage;
    checkedWrite(storage, PREFIX + "storage-check", "ok");
    storage.removeItem(PREFIX + "storage-check");
    const active = loadStoredPasskey();
    if (active) rememberAccount(active, storage);
    migrateHirePointers(storage);
    return run();
  });
}

export async function activateAccount(record: StoredPasskey): Promise<void> {
  rememberAccount(record);
  unsavedAccount = false;
  const response = await fetch("/api/account/session", { method: "DELETE" });
  if (!response.ok) throw new Error("Could not clear the previous read session. Your current account is unchanged. Retry activation.");
  const saved = publicAccount(JSON.parse(localStorage.getItem(key(record)) ?? "null"));
  if (!saved || !same(saved, record)) throw new Error("Saved account changed. Select it again.");
  forgetReadExpiry(readSessionStorage());
  // A unique selection marker makes A→B→A invalidate an A operation already waiting for a signature.
  checkedWrite(localStorage, PASSKEY_STORAGE_KEY, JSON.stringify({ ...saved, selection: crypto.randomUUID() }));
  window.location.replace("/account");
}

export function subscribeAccountNavigation(navigate = () => window.location.replace("/account")): () => void {
  const onStorage = (event: StorageEvent) => {
    if (!unsavedAccount && (event.key === PASSKEY_STORAGE_KEY || event.key === null)) navigate();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
