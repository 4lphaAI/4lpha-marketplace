// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ create: vi.fn(), recover: vi.fn(), activate: vi.fn(), records: [] as unknown[] }));
vi.mock("@/lib/altana/client", () => ({ createPasskeyWallet: api.create, recoverWalletFromPasskey: api.recover }));
vi.mock("@/lib/exec/account-switch", () => ({ accountTransition: (run: () => Promise<void>) => run(), activateAccount: api.activate, retainUnsavedAccount: vi.fn(), rememberedAccounts: () => api.records }));
import { AccountSwitcher } from "./AccountSwitcher";
const record = { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}`, credentialId: "YQ", rpId: "localhost", createdAt: 1, label: "First", walletAddress: "0x1111111111111111111111111111111111111111" } as const;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  vi.clearAllMocks(); api.records = [record]; api.activate.mockResolvedValue(undefined);
  process.env.NEXT_PUBLIC_PASSKEY_RP_ID = "localhost";
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<AccountSwitcher active={null} />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`Missing ${text}`);
  await act(async () => button.click());
}
it("selects a saved account without creating or recovering another credential", async () => {
  await click("Switch account"); await click("First");
  expect(api.activate).toHaveBeenCalledWith(record);
  expect(api.create).not.toHaveBeenCalled(); expect(api.recover).not.toHaveBeenCalled();
});
it("passes the account name to creation and retries activation without creating twice", async () => {
  api.create.mockResolvedValue(record); api.activate.mockRejectedValueOnce(new Error("storage blocked"));
  await click("Create account");
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Trading");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(api.create).toHaveBeenCalledWith({ name: "Trading", label: "Trading" });
  expect(container.textContent).toContain("storage blocked");
  await click("Retry activation");
  expect(api.create).toHaveBeenCalledTimes(1); expect(api.activate).toHaveBeenCalledTimes(2);
});
it("cancellation during recovery leaves selection alone and never creates", async () => {
  api.recover.mockRejectedValueOnce(new Error("Cancelled"));
  await click("Switch account"); await click("Use another passkey");
  expect(container.textContent).toContain("Cancelled");
  expect(api.activate).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
});
it("disables account actions while the funds dialog is open", async () => {
  await act(async () => root.render(<AccountSwitcher active={record} disabled />));
  expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
});
