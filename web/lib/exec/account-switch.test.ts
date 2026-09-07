// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountTransition, activateAccount, publicAccount, rememberAccount, rememberedAccounts, subscribeAccountNavigation, retainUnsavedAccount } from "./account-switch";
import { activePasskeyGuard, PASSKEY_STORAGE_KEY, type StoredPasskey } from "./passkey";

const a: StoredPasskey = { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}`, credentialId: "YQ", rpId: "localhost", createdAt: 1, label: "First", walletAddress: "0x1111111111111111111111111111111111111111" };
const b: StoredPasskey = { ...a, credentialId: "Yg", x: `0x${"33".repeat(32)}`, walletAddress: "0x2222222222222222222222222222222222222222" };
function locks() {
  let held = false;
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held) return run(null);
    held = true;
    try { return await run({}); } finally { held = false; }
  } } });
}
beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(a)); locks(); });

describe("account directory and activation", () => {
  it("preserves legacy selection and multiple wallets with only public fields", async () => {
    await accountTransition(async () => rememberAccount({ ...b, secret: "discard" } as StoredPasskey));
    expect(rememberedAccounts()).toEqual([a, b]);
    expect(JSON.stringify(Object.values(localStorage))).not.toContain("discard");
    expect(localStorage.getItem(PASSKEY_STORAGE_KEY)).toBe(JSON.stringify(a));
  });
  it("rejects corrupt metadata and conflicting same credential bindings", () => {
    rememberAccount(a);
    expect(() => rememberAccount({ ...a, walletAddress: b.walletAddress })).toThrow(/conflicts/);
    expect(publicAccount({ ...a, label: 4 })).toBeNull();
    expect(publicAccount({ ...a, label: "x".repeat(65) })).toBeNull();
    expect(publicAccount({ ...a, createdAt: Infinity })).toBeNull();
    expect(publicAccount({ ...a, credentialId: "not valid!" })).toBeNull();
    localStorage.setItem("4lpha:account:v1:broken", "not-json");
    expect(rememberedAccounts()).toEqual([a]);
  });
  it("refuses concurrent transitions without queueing another ceremony", async () => {
    let finish!: () => void;
    const pending = accountTransition(() => new Promise<void>((resolve) => { finish = resolve; }));
    const other = vi.fn(async () => undefined);
    await expect(accountTransition(other)).rejects.toThrow(/Another tab/);
    expect(other).not.toHaveBeenCalled(); finish(); await pending;
  });
  it("refuses missing locks and failed persistence before ceremony", async () => {
    const run = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    await expect(accountTransition(run)).rejects.toThrow(/Web Locks/);
    locks();
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("storage blocked"); } });
    await expect(accountTransition(run)).rejects.toThrow(/storage blocked/);
    expect(run).not.toHaveBeenCalled();
  });
  it("retains both records and old active identity when cookie clearing fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(accountTransition(() => activateAccount(b))).rejects.toThrow(/read session/);
    expect(rememberedAccounts()).toEqual([a, b]);
    expect(localStorage.getItem(PASSKEY_STORAGE_KEY)).toBe(JSON.stringify(a));
  });
  it("revalidates a changed record after cookie clearing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      localStorage.setItem("4lpha:account:v1:localhost:Yg", JSON.stringify({ ...b, x: a.x }));
      return new Response(null, { status: 200 });
    }));
    await expect(accountTransition(() => activateAccount(b))).rejects.toThrow(/Saved account changed/);
    expect(localStorage.getItem(PASSKEY_STORAGE_KEY)).toBe(JSON.stringify(a));
  });
  it("invalidates a captured signer on switching away and back", () => {
    const check = activePasskeyGuard(a); check();
    localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify({ ...a, selection: "new" }));
    expect(check).toThrow(/Account changed/);
    expect(activePasskeyGuard(b)).toThrow(/Account changed/);
  });
  it("reloads on active selection, removal and storage clear, not directory updates", () => {
    const navigate = vi.fn(); const stop = subscribeAccountNavigation(navigate);
    for (const key of [PASSKEY_STORAGE_KEY, null, "4lpha:account:v1:localhost:Yg"]) window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(navigate).toHaveBeenCalledTimes(2); stop();
    window.dispatchEvent(new StorageEvent("storage", { key: PASSKEY_STORAGE_KEY }));
    expect(navigate).toHaveBeenCalledTimes(2);
  });
  it("keeps pending unsaved metadata alive across another-tab selection until it is persisted", async () => {
    const navigate = vi.fn(); const stop = subscribeAccountNavigation(navigate);
    retainUnsavedAccount();
    window.dispatchEvent(new StorageEvent("storage", { key: PASSKEY_STORAGE_KEY }));
    expect(navigate).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(activateAccount(b)).rejects.toThrow(); // directory persisted even though activation failed
    expect(rememberedAccounts()).toContainEqual(b);
    window.dispatchEvent(new StorageEvent("storage", { key: PASSKEY_STORAGE_KEY }));
    expect(navigate).toHaveBeenCalledOnce(); stop();
  });
});
