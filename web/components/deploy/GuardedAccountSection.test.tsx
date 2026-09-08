// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connected: undefined as string | undefined }));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: mocks.connected }) }));

import {
  GuardedAccountSection,
  emptyGuardedAccount,
  guardedAccountBlocker,
  guardedAccountReady,
  type GuardedAccountState,
} from "./GuardedAccountSection";
import type { LendingGuardableView } from "@/lib/exec/lending-types";

const V_USDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const V_USDC = "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const ACCOUNT = "0x3333333333333333333333333333333333333333";
const CONNECTED = "0x4444444444444444444444444444444444444444";

function guardableView(patch: Partial<LendingGuardableView> = {}): LendingGuardableView {
  return {
    account: ACCOUNT,
    blockNumber: "120362697",
    bases: {
      borrowingPower: { hf: "1300000000000000000", matched: true },
      liquidation: { hf: "1180000000000000000", matched: true },
    },
    markets: [{
      vToken: V_USDT, symbol: "vUSDT", underlying: USDT, underlyingDecimals: 18,
      supplyUnderlyingWei: "0", borrowWei: "1000000000000000000000", isCollateral: false,
      collateralFactor: "800000000000000000", liquidationThreshold: "850000000000000000",
      priceMantissa: "1000000000000000000",
    }],
    debts: [{
      vToken: V_USDT, symbol: "vUSDT", borrowWei: "1000000000000000000000",
      debtValueMantissa: "1000000000000000000000", supported: true,
    }],
    guardable: true,
    ...patch,
  };
}

let host: HTMLDivElement;
let root: Root | null;
let state: GuardedAccountState;
let response: Response;

/**
 * The section is CONTROLLED — it reports its state up and renders what it is
 * given — so the harness is a real stateful parent rather than a re-render
 * loop, which is also how `DeployAgentScreen` holds it.
 */
function Harness({ initial }: { readonly initial: GuardedAccountState }) {
  const [value, setValue] = React.useState(initial);
  state = value;
  return <GuardedAccountSection value={value} onChange={setValue} />;
}

async function mount(initial: GuardedAccountState) {
  state = initial;
  await act(async () => { root!.render(<Harness initial={initial} />); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.connected = undefined;
  response = new Response(JSON.stringify({ data: guardableView() }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => response.clone()));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe("the guarded-account stage (R2.20)", () => {
  it("carries the gift copy and the irreversibility tick", async () => {
    await mount(emptyGuardedAccount());
    expect(host.textContent).toContain(
      "Repayments to this address are final: they cannot be undone.",
    );
    expect(host.textContent).toContain("I understand repayments to this address cannot be reversed");
  });

  // (c): with MetaMask connected the connected account is the DEFAULT, and
  // editing needs an explicit toggle.
  it("defaults to the connected wallet and offers an explicit toggle to change it", async () => {
    mocks.connected = CONNECTED;
    await mount(emptyGuardedAccount());
    expect(state.account).toBe(CONNECTED);
    expect(host.textContent).toContain("Guard a different address");
  });

  // (a): the address in FULL, monospace, beside the live position.
  it("shows the address in full with the live health factor, its basis and its match flag", async () => {
    await mount({ ...emptyGuardedAccount(), account: ACCOUNT });
    expect(host.querySelector("[data-testid=\"lending-guarded-address-full\"]")?.textContent).toBe(ACCOUNT);
    expect(host.textContent).toContain("Health factor 1.18");
    expect(host.textContent).toContain("liquidation basis");
    expect(host.textContent).toContain("matches Venus's own account-liquidity call");
    expect(host.textContent).toContain("this guard can repay it");
  });

  it("names a debt v1 cannot repay rather than hiding it", async () => {
    response = new Response(JSON.stringify({
      data: guardableView({
        debts: [
          { vToken: V_USDT, symbol: "vUSDT", borrowWei: "1", debtValueMantissa: "1", supported: true },
          { vToken: V_USDC, symbol: "vUSDC", borrowWei: "2", debtValueMantissa: "2", supported: false, reason: "unsupported-in-v1" },
        ],
      }),
    }), { status: 200, headers: { "content-type": "application/json" } });
    await mount({ ...emptyGuardedAccount(), account: ACCOUNT });
    expect(host.textContent).toContain("v1 cannot repay this market");
    expect(host.textContent).toContain("Debt in vUSDC is outside this guard");
  });

  it("renders the plane's refusal, and names the market when it names one", async () => {
    response = new Response(JSON.stringify({
      data: guardableView({
        guardable: false, refusal: "oracle-invalid", refusalMarket: V_USDC,
        note: "Your account entered a market this guard cannot price; the guard is paused until it can.",
      }),
    }), { status: 200, headers: { "content-type": "application/json" } });
    await mount({ ...emptyGuardedAccount(), account: ACCOUNT });
    expect(host.textContent).toContain("Not guardable");
    expect(host.textContent).toContain("Your account entered a market this guard cannot price");
    expect(host.textContent).toContain("0xecA8…67C8");
  });

  it("says why there is no position rather than showing an empty panel", async () => {
    response = new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
      status: 429, headers: { "content-type": "application/json" },
    });
    await mount({ ...emptyGuardedAccount(), account: ACCOUNT });
    expect(host.textContent).toContain("Too many reads of this account");
    expect(state.view).toBeNull();
  });
});

describe("the gate the Deploy button reads", () => {
  const view = guardableView();
  it("is closed until an address, a readable position, guardability AND the tick", () => {
    expect(guardedAccountReady(null)).toBe(false);
    expect(guardedAccountBlocker(null)).toContain("Enter the address");

    const typed = { ...emptyGuardedAccount(), account: ACCOUNT };
    expect(guardedAccountReady(typed)).toBe(false);

    const loading = { ...typed, loading: true };
    expect(guardedAccountBlocker(loading)).toContain("Reading the guarded account");

    const unreadable = { ...typed, reason: "the plane is unreachable" };
    expect(guardedAccountBlocker(unreadable)).toBe("the plane is unreachable");

    const refused = { ...typed, view: { ...view, guardable: false, refusal: "no-debt" as const } };
    expect(guardedAccountReady(refused)).toBe(false);
    expect(guardedAccountBlocker(refused)).toContain("owes nothing on Venus");

    const unticked = { ...typed, view };
    expect(guardedAccountReady(unticked)).toBe(false);
    expect(guardedAccountBlocker(unticked)).toContain("I understand repayments to this address cannot be reversed");

    const ready = { ...unticked, confirmed: true };
    expect(guardedAccountReady(ready)).toBe(true);
    expect(guardedAccountBlocker(ready)).toBeNull();
  });

  it("refuses an address that is not 20 bytes of hex", () => {
    const typo = { ...emptyGuardedAccount(), account: "0x1234", confirmed: true, view };
    expect(guardedAccountReady(typo)).toBe(false);
    expect(guardedAccountBlocker(typo)).toContain("Enter the address");
  });
});
