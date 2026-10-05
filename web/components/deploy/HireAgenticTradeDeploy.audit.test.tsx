// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agenticRequest, AgenticRequestError, agenticDeployedWallets } from "@/lib/agentic";
import { AgenticDeployModal } from "./HireAgenticTradeDeploy";
import { MyAgentsScreen } from "@/components/screens/MyAgentsScreen";
import type { TradeSettings } from "@/lib/trade";
import { decodeFunctionData, parseAbi } from "viem";
import { USDT_56 } from "@/lib/exec/pairs";

vi.hoisted(() => { process.env.NEXT_PUBLIC_AGENTIC_WALLET_ENABLED = "true"; });
const extension = vi.hoisted(() => ({ account: { address: undefined as string | undefined, chainId: undefined as number | undefined, isConnected: false }, send: vi.fn() }));
vi.mock("@/components/agentic/PairingQr", () => ({ PairingQr: () => <div>QR</div> }));
vi.mock("wagmi", () => ({ useAccount: () => extension.account, usePublicClient: () => undefined,
  useBalance: () => ({ data: { value: 100n * 10n ** 18n } }), useGasPrice: () => ({ data: 1n }),
  useSendTransaction: () => ({ sendTransaction: extension.send, isPending: false, reset: vi.fn() }) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => ({ ownerKind: "passkey", passkey: null, signEnvelope: vi.fn(), signReadHeader: vi.fn() }) }));
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => <div>Accounts</div> }));
const NOW = 1_900_000_000_000, W = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const settings: TradeSettings = { name: "Agentic", executionModel: "tradfi", entryWei: "5000000000000000000", capitalQuoteWei: "10000000000000000000", maxOpenPositions: 2,
  minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
  slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b" };
const facts = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1000,
  quotaUsed: 0, x402DailyLimit: 1, x402QuotaUsed: 0, signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: "100000000000000000000", bnbWei: "1000000000000000000" };
const fixes = [{ code: "daily-limit", state: "FAIL" as const, fix: "Raise Daily limit to 100 USDT." },
  { code: "bnb", state: "FAIL" as const, fix: "Fund 0.0016 BNB." }];
let root: Root | undefined, node: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
  extension.account = { address: undefined, chainId: undefined, isConnected: false }; extension.send.mockClear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; node.remove(); localStorage.clear();
  vi.useRealTimers(); vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
function button(text: string): HTMLButtonElement {
  const found = [...node.querySelectorAll("button")].find(value => value.textContent === text);
  expect(found, text).toBeDefined(); return found!;
}
/** Steps 1-3 of the deploy pop-up: Agentic custody, term end, then the pairing starts. */
async function pair() {
  await act(async () => root!.render(<AgenticDeployModal settings={settings} go={() => undefined} onClose={() => undefined} onAltana={() => undefined} />));
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")[1]!.click());
  await act(async () => button("Next").click());
  await act(async () => button("Keep holdings at term end").click());
  await act(async () => button("Next").click());
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
}
/** Finalize the pairing (step 3), then pass the funding step (4) to reach the Binance checks (5). */
async function finalize() { await act(async () => button("Finalize pairing").click()); }
async function toChecks() { await finalize(); await act(async () => button("Next").click()); }
function server(hireFails: boolean, pairFacts = facts) {
  let terminal: "failed" | "expired" | null = null, starts = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/agentic/pairings") { starts += 1; return Response.json({ data: { pairingId: `private-pairing-${starts}`, urlForWeb: "https://binance.test/qr", expireAtMs: NOW + 300_000 } }); }
    if (url === "/api/agentic/hire") {
      expect(JSON.parse(String(init?.body)).pairingId).toBe("private-pairing-1");
      return hireFails ? Response.json({ data: null, error: { code: "gate-failed" }, meta: { gate: fixes, reason: "sizing" } }, { status: 409 })
        : Response.json({ data: { walletAddress: "0x" + W.slice(2).toUpperCase(), hireEndMs: NOW + 604_800_000, agentId: "private-agent" } });
    }
    return Response.json({ data: { state: terminal ?? "paired", walletAddress: W, codeAttemptsLeft: 5, facts: pairFacts,
      continuationDeadlineMs: NOW + 1_800_000, failure: terminal === null ? null : "pairing-ended" } });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, end: (value: "failed" | "expired") => { terminal = value; }, starts: () => starts };
}

it("the real client preserves typed authoritative gate failure rows", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: null, error: { code: "gate-failed" }, meta: { gate: fixes } }, { status: 409 })));
  try { await agenticRequest("hire", {}); expect.fail("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(AgenticRequestError); expect((error as AgenticRequestError).gate).toEqual(fixes); }
});
it("a successful code check confirms the match, locks code entry and makes Finalize the next step", async () => {
  const api = server(false); await pair();
  const input = node.querySelector<HTMLInputElement>('input[autocomplete="off"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "abcdef");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("Check code").disabled).toBe(false);
  await act(async () => button("Check code").click());
  expect(node.querySelector('[role="status"]')?.textContent).toBe("Code matched. Finalize pairing to continue.");
  expect(input.disabled).toBe(true); expect(button("Check code").disabled).toBe(true);
  expect(button("Finalize pairing").disabled).toBe(false);
  await act(async () => button("Check code").click());
  expect(api.fetch.mock.calls.filter(([url]) => url.endsWith("/code"))).toHaveLength(1);
  await act(async () => button("Finalize pairing").click());
  expect(api.fetch.mock.calls.some(([url]) => url.endsWith("/finalize"))).toBe(true);
});
it("pairing instructions put App Confirm before the displayed code", async () => {
  server(false); await pair();
  expect(node.textContent).toContain("Scan the QR with the Binance App and tap Confirm, then type the 6-character code the App shows.");
});
for (const [code, message] of [["pairing_code_attempts", "Code attempts exhausted. Start a new pairing."],
  ["pairing_code_expired", "Code expired. Start a new pairing."], ["pairing_not_ready", "Pairing is not ready."]]) {
  it(`the web client gives ${code} a human message`, async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: null, error: { code } }, { status: 409 })));
    await expect(agenticRequest("pairings/private/code", { code: "abcdef" })).rejects.toThrow(message);
    const error = new AgenticRequestError(code!); expect(error.message).not.toBe(code);
  });
}
for (const terminal of ["failed", "expired"] as const) it(`renders every server fix and starts a fresh pairing after ${terminal}`, async () => {
  const api = server(true); await pair(); await toChecks();
  await act(async () => button("Deploy Agentic AI Trade").click());
  const rows = node.querySelector('[aria-label="Deployment gate fixes"]')!;
  expect(rows.querySelectorAll("li")).toHaveLength(2);
  for (const row of fixes) expect(rows.textContent).toContain(row.fix);
  expect(localStorage.length).toBe(0);
  api.end(terminal); await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(node.textContent).not.toContain("Deploy Agentic AI Trade");
  expect(node.textContent).toContain("Hire refused: capital does not cover the position sizes.");
  for (const row of fixes) expect(node.querySelector('[aria-label="Deployment gate fixes"]')?.textContent).toContain(row.fix);
  await act(async () => button("Start a new pairing").click());
  expect(node.textContent).not.toContain("pairing-ended");
  await act(async () => button("Pair in the Binance App").click()); expect(api.starts()).toBe(2);
  expect(api.fetch.mock.calls.filter(([url]) => url === "/api/agentic/pairings")).toHaveLength(2);
});

it("Refresh checks reuses finalize and shows the read time and minute limit", async () => {
  const api = server(false); await pair(); await toChecks();
  expect(node.textContent).toContain(new Date(NOW).toISOString()); expect(node.textContent).toContain("checks can refresh once a minute");
  expect(api.fetch.mock.calls.filter(([url]) => url.endsWith("/finalize"))).toHaveLength(1);
  await act(async () => button("Refresh checks").click());
  expect(api.fetch.mock.calls.filter(([url]) => url.endsWith("/finalize"))).toHaveLength(2);
});

for (const asset of ["USDT", "BNB"] as const) it(`funds only the verified wallet with the exact ${asset} deficit through the existing modal`, async () => {
  extension.account = { address: "0x9999999999999999999999999999999999999999", chainId: 56, isConnected: true };
  server(false, { ...facts, usdtWei: "11999200000000000000", bnbWei: "1599999999999999" }); await pair(); await finalize();
  const copy = vi.fn(async () => undefined); vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  await act(async () => button("Copy").click()); expect(copy).toHaveBeenCalledWith(W);
  const addressPanel = node.querySelector('[aria-label="Verified Agentic Wallet"]')!;
  expect(addressPanel.querySelector("input")).toBeNull(); expect(addressPanel.textContent).toContain(W);
  expect(node.textContent).toContain("Balance: 11.9992 USDT · need 12 USDT");
  expect(node.textContent).toContain("Balance: 0.001599999999999999 BNB · need 0.0016 BNB");
  expect(button("Next").disabled).toBe(true);
  await act(async () => button(`Send ${asset} from extension wallet`).click());
  const dialogs = node.querySelectorAll('[role="dialog"]'); expect(dialogs).toHaveLength(2);
  const modal = dialogs[1]!;
  expect(modal.querySelector("select")).toBeNull(); expect(modal.querySelector<HTMLInputElement>("input")?.readOnly).toBe(true);
  await act(async () => button(`Deposit ${asset}`).click());
  expect(extension.send).toHaveBeenCalledTimes(1);
  const sent = extension.send.mock.calls[0]![0] as { to: string; value: bigint; data?: `0x${string}` };
  if (asset === "BNB") expect(sent).toEqual({ to: W, value: 1n });
  else {
    expect(sent.to).toBe(USDT_56); expect(sent.value).toBe(0n);
    expect(decodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), data: sent.data! }).args)
      .toEqual([expect.stringMatching(new RegExp("^" + W + "$", "i")), 800_000_000_000_000n]);
  }
});

it("extension funding refuses a connected wallet outside BSC", async () => {
  extension.account = { address: "0x9999999999999999999999999999999999999999", chainId: 1, isConnected: true };
  server(false, { ...facts, usdtWei: "0" }); await pair(); await finalize(); await act(async () => button("Send USDT from extension wallet").click());
  expect(node.textContent).toContain("Connect an extension wallet on BSC to send."); expect(extension.send).not.toHaveBeenCalled();
});

it("successful hire retains only deduplicated normalized wallets and My agents offers lookup shortcuts", async () => {
  localStorage.setItem("4lpha:agentic-wallets:v1", JSON.stringify([W, W.toUpperCase().replace("0X", "0x"), "private-pairing", { secret: "private" }]));
  server(false); await pair(); await toChecks(); await act(async () => button("Deploy Agentic AI Trade").click());
  expect(localStorage.length).toBe(1); expect(localStorage.getItem("4lpha:agentic-wallets:v1")).toBe(JSON.stringify([W]));
  expect(agenticDeployedWallets()).toEqual([W]); expect(node.textContent).toContain("Started");
  const go = vi.fn(); await act(async () => root!.render(<MyAgentsScreen go={go} />));
  const lookup = node.querySelector('[aria-label="Observe an Agentic Wallet"]')!;
  expect(lookup.querySelector("input")).not.toBeNull();
  const shortcut = lookup.querySelector<HTMLButtonElement>(`button[title="${W}"]`)!; expect(shortcut.textContent).toContain("0xabcd…abcd");
  await act(async () => shortcut.click()); expect(go).toHaveBeenCalledWith("/agentic/" + W);
});
