// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: () => ({}), useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }) }));
vi.mock("./passkey", async (load) => ({ ...await load<typeof import("./passkey")>(), signOwnerActionWithPasskey: mock.sign }));
import { useOwnerActions } from "./use-owner-actions";
import { PASSKEY_STORAGE_KEY } from "./passkey";
const a = { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}`, credentialId: "YQ", rpId: "localhost", createdAt: 1 };
it("rejects an old mounted owner and an old signature completed after switching", async () => {
  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(a));
  let owner!: ReturnType<typeof useOwnerActions>;
  function View() { owner = useOwnerActions(); return null; }
  const container = document.createElement("div"); const root = createRoot(container);
  await act(async () => root.render(<View />));
  let resolve!: (value: unknown) => void;
  mock.sign.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const pending = owner.signEnvelope("pause", "agent", {});
  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify({ ...a, credentialId: "Yg" }));
  resolve({ signed: {} });
  await expect(pending).rejects.toThrow(/Account changed/);
  await expect(owner.signEnvelope("pause", "agent", {})).rejects.toThrow(/Account changed/);
  expect(mock.sign).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount()); localStorage.clear();
});
