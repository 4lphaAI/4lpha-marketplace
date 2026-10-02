// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeReadHeader } from "@/lib/exec/owner-action";
import { CMC_PERMIT2, CMC_USDT, keyHashForSession } from "@/lib/altana/cmc-budget";

const mocks = vi.hoisted(() => ({ grant: vi.fn(), execute: vi.fn(), sign: vi.fn() }));
vi.mock("@/lib/altana/client", () => ({ grantAgentSession: mocks.grant, revokeAgentSession: vi.fn(), GrantAgentSessionError: class extends Error {} }));
vi.mock("@/lib/altana/cmc-budget", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/altana/cmc-budget")>(), executeCmcBudgetCalls: mocks.execute }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => ({
  ownerAddress: "0x1111111111111111111111111111111111111111", walletAddress: "0x2222222222222222222222222222222222222222",
  passkey: { walletAddress: "0x2222222222222222222222222222222222222222" }, signEnvelope: mocks.sign,
}) }));
import { SessionRenew } from "./SessionRenew";

const NOW = Math.floor(Date.now() / 1000);
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const KEY = privateKeyToAccount(`0x${"32".repeat(32)}`).publicKey;
const envelope = { signed: { action: "renewSession", agentId: "agent" }, params: { ttlSec: 604800 }, signature: "0xsignature" };
const CALLS_ID = `0x${"44".repeat(32)}`;
const NOTE = "Renewed. Data access (CMC) still needs a rebind: open the CMC x402 tab and press Rebind data access.";
const checkerAbi = parseAbi(["function setSignatureCheckerApproval(bytes32 keyHash,address checker,bool approved)"]);
const call = { to: WALLET, value: "0", data: encodeFunctionData({ abi: checkerAbi, functionName: "setSignatureCheckerApproval", args: [keyHashForSession(KEY), CMC_PERMIT2, true] }) };
const prepared = { operationId: "op", continuationAttemptId: "attempt", state: "prepared", calls: [call], operation: {
  operationId: "op", mode: "rebind", expectedGeneration: 2, incrementWei: "0", sessionPublicKey: KEY,
  sessionExpiry: NOW + 3600, wallet: WALLET, keyHash: keyHashForSession(KEY), oldCheckerKeyHash: null, calls: [call],
} };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); vi.clearAllMocks();
  mocks.sign.mockResolvedValue(envelope);
  mocks.grant.mockResolvedValue({});
  mocks.execute.mockResolvedValue({ status: "CONFIRMED", callsId: CALLS_ID });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

async function renew(cmcRebind: boolean | undefined, data: unknown = prepared, prepareStatus = 200, stall?: string) {
  const sequence: string[] = [];
  const stalledSignals: AbortSignal[] = [];
  let reads = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/session")) { reads += 1; return json({ data: {} }); }
    if (url.endsWith("/session/renew")) return json({ data: { grantDigest: "0xdigest", sessionPublicKey: KEY,
      sessionAddress: WALLET, expiry: NOW + 3600, permissions: { calls: [], spend: [] } } });
    if (url.endsWith("/grant-attempt")) return json({ data: { mayInvoke: true } });
    const cmcRequest = url.endsWith("/trade/cmc-budget") ? "prepare"
      : url.endsWith("/attempt") ? init?.body?.toString().includes("callsId") ? "hint" : "attempt"
        : url.endsWith("/confirm") ? "confirm" : null;
    if (cmcRequest !== null && cmcRequest === stall) {
      if (init?.signal != null) stalledSignals.push(init.signal);
      return new Promise<Response>(() => undefined);
    }
    if (url.endsWith("/trade/cmc-budget")) { expect(reads).toBe(2); sequence.push("prepare"); return json(prepareStatus === 200 ? { data } : { error: { code: "conflict" } }, prepareStatus); }
    if (url.endsWith("/attempt")) { sequence.push(init?.body?.toString().includes("callsId") ? "hint" : "attempt"); return json({ data: {} }); }
    if (url.endsWith("/confirm")) { sequence.push("confirm"); return json({ data: {} }); }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const refresh = vi.fn(async () => { sequence.push("refresh"); return { id: "agent", status: "armed", walletAddress: WALLET, sessionExpiresAt: NOW + 3600 }; });
  await act(async () => root.render(<SessionRenew agentId="agent" walletAddress={WALLET} sessionExpiresAt={NOW - 1} kind="trade" refresh={refresh} {...(cmcRebind === undefined ? {} : { cmcRebind })} />));
  await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); });
  return { fetcher, refresh, sequence, stalledSignals };
}

it("renew CMC: prepares with the signed renew header, validates rebind, executes once and confirms before refresh", async () => {
  const f = await renew(true);
  expect(f.sequence).toEqual(["prepare", "attempt", "hint", "confirm", "refresh"]);
  const request = f.fetcher.mock.calls.find(([url]) => String(url).endsWith("/trade/cmc-budget"))!;
  expect(request[1]?.headers).toEqual({ "content-type": "application/json", "x-renew-action": encodeReadHeader(envelope as never) });
  expect(request[1]?.body).toBe("{}");
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(mocks.execute.mock.calls[0]![0].calls).toEqual([{ ...call, value: 0n }]);
  expect(mocks.sign).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Session renewed until");
  expect(host.textContent).not.toContain(NOTE);
  expect(localStorage.length).toBe(0);
});

it("renew CMC: alreadyBound skips execution", async () => {
  const f = await renew(true, { alreadyBound: true });
  expect(f.sequence).toEqual(["prepare", "refresh"]);
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Session renewed until");
  expect(host.textContent).not.toContain(NOTE);
});

it.each(["refused", "cancelled", "failed", "invalid plan"])("renew CMC: %s leaves renewal done with the manual rebind note", async scenario => {
  if (scenario === "cancelled") mocks.execute.mockRejectedValue(new DOMException("Cancelled", "NotAllowedError"));
  if (scenario === "failed") mocks.execute.mockResolvedValue({ status: "FAILED", callsId: CALLS_ID });
  const invalid = { ...prepared, calls: [{ to: CMC_USDT, value: "0", data: "0x39509351" }] };
  await renew(true, scenario === "invalid plan" ? invalid : prepared, scenario === "refused" ? 409 : 200);
  expect(host.textContent).toContain("Session renewed until");
  expect(host.textContent).toContain(NOTE);
  expect(host.querySelector('[data-session-renew="done"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  if (scenario === "refused" || scenario === "invalid plan") expect(mocks.execute).not.toHaveBeenCalled();
});

it.each([false, undefined])("renew CMC: opt-in %s makes no CMC request", async enabled => {
  const f = await renew(enabled);
  expect(f.sequence).toEqual(["refresh"]);
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("renew CMC: reload does not rerun the continuation", async () => {
  const f = await renew(true);
  await act(async () => root.unmount()); root = createRoot(host);
  await act(async () => root.render(<SessionRenew agentId="agent" walletAddress={WALLET} sessionExpiresAt={NOW + 3600} kind="trade" cmcRebind />));
  expect(f.sequence.filter(step => step === "prepare")).toHaveLength(1);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it.each(["prepare", "attempt", "hint", "confirm"])("renew CMC: deadline aborts a stalled %s and completes renewal", async stall => {
  vi.useFakeTimers();
  const f = await renew(true, prepared, 200, stall);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.stalledSignals).toHaveLength(1);
  expect(f.stalledSignals[0]!.aborted).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(119_999); });
  expect(f.refresh).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain(NOTE);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(f.stalledSignals[0]!.aborted).toBe(true);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain(NOTE);
  expect(host.textContent).toContain("Session renewed until");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  const requestsAtDeadline = f.fetcher.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(f.fetcher.mock.calls).toHaveLength(requestsAtDeadline);
  expect(f.refresh).toHaveBeenCalledTimes(1);
});
