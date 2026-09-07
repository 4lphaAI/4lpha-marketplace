import { loadStoredPasskey, ownerAddressFromPasskey } from "./passkey";
import type { OwnerActionEnvelope } from "./owner-action";

export function assertHireOwner(envelope: OwnerActionEnvelope, owner: string | undefined, wallet: string | undefined): void {
  const params = envelope.params as { readonly walletAddress?: unknown } | null;
  if (!owner || !wallet || typeof envelope.signed?.owner !== "string"
    || envelope.signed.owner.toLowerCase() !== owner.toLowerCase()
    || typeof params?.walletAddress !== "string" || params.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error("Saved hire belongs to another account. Switch to its account to continue.");
  }
}

const POINTERS = ["4lpha:trade-hire:v2", "4lpha:grid-hire:v1", "4lpha:lp-hire:v1"];
const INITIALIZED = "4lpha:account-hire-scoped:v1";
function scoped(k: string, owner: string): string { return `${k}:owner:${owner.toLowerCase()}`; }

/** Called only inside the transition lock, BEFORE replacing the prior owner. */
export function migrateHirePointers(storage: Storage): void {
  const active = loadStoredPasskey();
  if (active && storage.getItem(INITIALIZED) === null) {
    const owner = ownerAddressFromPasskey(active.x, active.y);
    for (const k of POINTERS) {
      const old = storage.getItem(k);
      if (old === null) continue;
      const destination = scoped(k, owner);
      const existing = storage.getItem(destination);
      if (existing !== null && existing !== old) throw new Error("A saved hire needs recovery before switching accounts.");
      storage.setItem(destination, old);
      if (storage.getItem(destination) !== old) throw new Error("Could not preserve the previous account's hire. Retry switching.");
      storage.removeItem(k);
    }
  }
  storage.setItem(INITIALIZED, "1");
  if (storage.getItem(INITIALIZED) !== "1") throw new Error("Could not save account isolation.");
}

/** Capture owner once. Late async callbacks cannot redirect old pointers into a new account. */
export function accountHireStorage(storage: Storage | undefined, owner: string | undefined): Storage {
  if (!storage) return { length: 0, key: () => null, getItem: () => null, setItem: () => { throw new Error("Browser storage unavailable."); }, removeItem: () => undefined, clear: () => undefined };
  const map = (k: string) => POINTERS.includes(k) ? scoped(k, owner ?? "unselected") : k;
  return {
    get length() { return storage.length; }, key: (index) => storage.key(index),
    clear: () => { throw new Error("Account storage cannot be cleared wholesale."); },
    getItem: (k) => {
      const value = storage.getItem(map(k));
      return value === null && owner && POINTERS.includes(k) && storage.getItem(INITIALIZED) === null ? storage.getItem(k) : value;
    },
    setItem: (k, value) => storage.setItem(storage.getItem(INITIALIZED) === null ? k : map(k), value),
    removeItem: (k) => {
      storage.removeItem(map(k));
      if (owner && POINTERS.includes(k) && storage.getItem(INITIALIZED) === null) storage.removeItem(k);
    },
  };
}

/** After switching, recovery is shown for explicit continuation, never auto-submitted. */
export function accountSwitchRequiresContinue(storage: Storage): boolean { return storage.getItem(INITIALIZED) !== null; }
