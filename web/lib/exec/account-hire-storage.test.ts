// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { accountHireStorage, accountSwitchRequiresContinue, migrateHirePointers } from "./account-hire-storage";
import { ownerAddressFromPasskey, PASSKEY_STORAGE_KEY } from "./passkey";
const a = { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}`, credentialId: "YQ", rpId: "localhost", createdAt: 1 } as const;
const ownerA = ownerAddressFromPasskey(a.x, a.y);
const ownerB = "0x2222222222222222222222222222222222222222";
const pointers = ["4lpha:trade-hire:v2", "4lpha:grid-hire:v1", "4lpha:lp-hire:v1"];
beforeEach(() => localStorage.clear());
it("preserves all A recovery pointers and exposes none to B, including old callback writes", () => {
  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(a));
  for (const key of pointers) localStorage.setItem(key, "signed-A");
  const oldA = accountHireStorage(localStorage, ownerA);
  migrateHirePointers(localStorage);
  const b = accountHireStorage(localStorage, ownerB);
  for (const key of pointers) {
    expect(oldA.getItem(key)).toBe("signed-A"); expect(b.getItem(key)).toBeNull();
    b.setItem(key, "B"); oldA.setItem(key, "late-A");
    expect(b.getItem(key)).toBe("B"); expect(oldA.getItem(key)).toBe("late-A");
    oldA.removeItem(key); expect(b.getItem(key)).toBe("B");
  }
  expect(accountSwitchRequiresContinue(b)).toBe(true);
});
it("never assigns unknown legacy pointers to a newly created account, including its next switch", () => {
  for (const key of pointers) localStorage.setItem(key, "unknown");
  migrateHirePointers(localStorage);
  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(a));
  migrateHirePointers(localStorage);
  for (const key of pointers) {
    expect(accountHireStorage(localStorage, ownerA).getItem(key)).toBeNull();
    expect(localStorage.getItem(key)).toBe("unknown");
  }
});
it("refuses migration conflicts without deleting either recovery record", () => {
  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(a));
  const k = pointers[0]!;
  localStorage.setItem(k, "old");
  localStorage.setItem(`${k}:owner:${ownerA.toLowerCase()}`, "different");
  expect(() => migrateHirePointers(localStorage)).toThrow(/recovery/);
  expect(localStorage.getItem(k)).toBe("old");
});
