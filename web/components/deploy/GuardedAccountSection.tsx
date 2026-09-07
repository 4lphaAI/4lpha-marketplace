"use client";

/**
 * R2.20 — the guarded-account stage, and the FIRST thing the lending deploy
 * screen shows.
 *
 * This exists because of §0.5: there is NO proof of ownership of the guarded
 * account, and there cannot be. Repaying someone's debt on Venus is a gift.
 * The whole safeguard against a mistyped address is that the owner SEES the
 * position before signing anything — the address in full and in monospace, the
 * live health factor on the liquidation basis with its protocol match flag, and
 * the debts this guard can and cannot repay. Then they tick a box.
 *
 * `guardable === false` disables Deploy with the plane's own refusal, BEFORE any
 * passkey prompt: a hire that S1 will refuse must never cost a signature.
 */
import * as React from "react";
import { Button, Checkbox, Icon, StatusBadge } from "@/design-system";
import { useAccount } from "wagmi";
import {
  INVALID,
  parseLendingGuardable,
  type LendingGuardableView,
} from "@/lib/exec/lending-types";
import {
  LENDING_GIFT_COPY,
  LENDING_IRREVERSIBLE_TICK,
  LENDING_UNPRICEABLE_MARKET_COPY,
  LENDING_WORKING_RANGE_COPY,
  formatAtomicAmount,
  formatHf,
  unsupportedDebtSymbols,
} from "@/lib/lending/form";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

export type GuardedAccountState = {
  /** What the owner will actually guard. Empty until an address is resolved. */
  readonly account: string;
  /** True once the owner pressed "guard a different address" (R2.20(c)). */
  readonly editing: boolean;
  /** The R2.20(b) tick. Deploy stays disabled until it is true. */
  readonly confirmed: boolean;
  readonly view: LendingGuardableView | null;
  /** Why there is no view. Rendered verbatim — never a blank tile. */
  readonly reason: string | null;
  readonly loading: boolean;
};

export function emptyGuardedAccount(): GuardedAccountState {
  return { account: "", editing: false, confirmed: false, view: null, reason: null, loading: false };
}

/** The one place a hire may read "this account can be guarded". */
export function guardedAccountReady(state: GuardedAccountState | null | undefined): boolean {
  return state !== null && state !== undefined
    && ADDRESS.test(state.account)
    && state.view !== null
    && state.view.guardable
    && state.confirmed;
}

/** The refusal to show on the Deploy button, or `null` when there is none. */
export function guardedAccountBlocker(state: GuardedAccountState | null | undefined): string | null {
  if (state === null || state === undefined || !ADDRESS.test(state.account)) {
    return "Enter the address whose Venus position this guard should watch.";
  }
  if (state.loading) return "Reading the guarded account's Venus position…";
  if (state.view === null) return state.reason ?? "The guarded account could not be read.";
  if (!state.view.guardable) return refusalText(state.view);
  if (!state.confirmed) return `Tick “${LENDING_IRREVERSIBLE_TICK}” to continue.`;
  return null;
}

function refusalText(view: LendingGuardableView): string {
  const market = view.refusalMarket === undefined ? "" : ` (${short(view.refusalMarket)})`;
  switch (view.refusal) {
    case "no-debt":
      return "This account owes nothing on Venus, so there is nothing for a guard to repay.";
    case "no-supported-debt":
      return "This account's debts are in markets v1 cannot repay (the guard covers USDT and BNB).";
    case "protocol-mismatch":
      return `The plane's risk reconstruction disagrees with Venus's own numbers${market}; the hire is refused rather than armed against figures it cannot trust.`;
    case "emode-unverified":
      return "This account is in an E-Mode configuration the guard has not verified; the hire is refused.";
    case "oracle-invalid":
      return `${LENDING_UNPRICEABLE_MARKET_COPY}${market}`;
    case "protocol-error":
      return "Venus's Comptroller returned an error for this account; the hire is refused.";
    case "account-too-complex":
      return view.note ?? "This account is in more markets than this guard can price.";
    case "snapshot-error":
      return "The guarded account's position could not be reconstructed.";
    default:
      return "This account cannot be guarded right now.";
  }
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

const mono: React.CSSProperties = {
  font: "var(--weight-medium) var(--text-sm)/1.4 var(--font-mono)",
  color: "var(--ink-1)",
  overflowWrap: "anywhere",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface-sunken)",
  border: "1px solid var(--line-1)",
  color: "var(--ink-1)",
  font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-mono)",
  outline: "none",
};

/**
 * Read the guarded account through the BFF, in DISPLAY mode.
 *
 * Display mode takes no sizing inputs and returns no receipt: the receipt is a
 * separate, later read taken ≤30 s before S1 (R3.3(5)), so a form the owner is
 * still editing never issues one.
 */
async function readGuardable(account: string, signal: AbortSignal): Promise<
  { readonly view: LendingGuardableView } | { readonly reason: string }
> {
  let response: Response;
  try {
    response = await fetch(`/api/lending/guardable?account=${account}`, { cache: "no-store", signal });
  } catch {
    return { reason: "The guarded account could not be read (network)." };
  }
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    return { reason: "The guarded account read returned an unreadable response." };
  }
  if (response.status === 404) {
    return { reason: "The lending guard is not enabled on this execution plane." };
  }
  if (response.status === 429) {
    return { reason: "Too many reads of this account just now. Wait a moment and try again." };
  }
  if (!response.ok) {
    const error = (payload as { error?: { message?: string; code?: string } } | null)?.error;
    return { reason: error?.message ?? error?.code ?? `The guarded account could not be read (HTTP ${response.status}).` };
  }
  const view = parseLendingGuardable((payload as { data?: unknown } | null)?.data);
  if (view === INVALID) {
    return { reason: "The guarded account read returned a shape this page cannot map." };
  }
  return { view };
}

export function GuardedAccountSection({ value, onChange }: {
  readonly value: GuardedAccountState | null | undefined;
  readonly onChange: (next: GuardedAccountState) => void;
}) {
  const state = value ?? emptyGuardedAccount();
  const { address: connected } = useAccount();
  const [draft, setDraft] = React.useState(state.account);
  const seededFor = React.useRef<string | null>(null);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  // The read resolves asynchronously and the owner may tick the box while it is
  // in flight. Merging into a RENDER-CAPTURED state would silently untick it, so
  // every async merge reads the latest state through this ref.
  const stateRef = React.useRef(state);
  stateRef.current = state;

  // (c) With MetaMask connected the connected account is the DEFAULT, and
  // editing needs an explicit toggle. Seeded once per connected address, so a
  // typed address is never overwritten by a re-render.
  React.useEffect(() => {
    if (state.editing || connected === undefined) return;
    if (seededFor.current === connected) return;
    seededFor.current = connected;
    setDraft(connected);
    onChangeRef.current({ ...emptyGuardedAccount(), account: connected });
  }, [connected, state.editing]);

  const account = state.account;
  React.useEffect(() => {
    if (!ADDRESS.test(account)) return;
    const controller = new AbortController();
    onChangeRef.current({ ...stateRef.current, loading: true, reason: null });
    void readGuardable(account, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const latest = stateRef.current;
      onChangeRef.current(
        "view" in result
          ? { ...latest, account, loading: false, view: result.view, reason: null }
          : { ...latest, account, loading: false, view: null, reason: result.reason },
      );
    });
    return () => controller.abort();
    // Only the resolved address drives the read; the tick and the toggle do not.
  }, [account]);

  const view = state.view;
  const liquidation = view?.bases.liquidation ?? null;
  const unsupported = unsupportedDebtSymbols(view);
  const commit = () => {
    const trimmed = draft.trim();
    onChangeRef.current({
      ...emptyGuardedAccount(),
      editing: state.editing,
      account: ADDRESS.test(trimmed) ? trimmed : "",
      reason: trimmed === "" || ADDRESS.test(trimmed) ? null : "That is not a 20-byte hex address.",
    });
  };

  return <div style={{ display: "grid", gap: 14 }}>
    <span className="fl-eyebrow">Guarded account</span>
    <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)", marginTop: -6, maxWidth: "70ch" }}>
      {LENDING_GIFT_COPY}
    </p>

    {connected !== undefined && !state.editing ? (
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
        <Icon name="wallet" size={14} />
        <span data-testid="lending-guarded-address" style={mono}>{state.account || connected}</span>
        <Button size="sm" variant="ghost" onClick={() => onChangeRef.current({ ...emptyGuardedAccount(), editing: true })}>
          Guard a different address
        </Button>
      </div>
    ) : (
      <div style={{ display: "grid", gap: 8 }}>
        <input
          aria-label="Guarded account address"
          value={draft}
          spellCheck={false}
          placeholder="0x… the address whose Venus position this guard watches"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
          style={inputStyle} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Button size="sm" variant="secondary" onClick={commit}>Read this account</Button>
          {connected !== undefined
            ? <Button size="sm" variant="ghost" onClick={() => { setDraft(connected); onChangeRef.current({ ...emptyGuardedAccount(), account: connected }); }}>
                Use my connected wallet
              </Button>
            : null}
        </div>
      </div>
    )}

    {state.account !== "" ? <div data-testid="lending-guarded-address-full" style={{ ...mono, letterSpacing: "0.02em" }}>{state.account}</div> : null}

    {state.loading ? <p role="status" style={{ color: "var(--text-subtle)", margin: 0 }}>Reading this account's Venus position…</p> : null}
    {state.reason !== null ? <p role="alert" style={{ color: "var(--loss)", margin: 0 }}>{state.reason}</p> : null}

    {view !== null ? <div style={{ display: "grid", gap: 12, padding: 14, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <StatusBadge pill status={view.guardable ? "live" : "warning"} label={view.guardable ? "Guardable" : "Not guardable"} />
        <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
          Health factor {formatHf(liquidation?.hf ?? null)} · liquidation basis · block {view.blockNumber}
        </span>
        <span style={{ font: "var(--type-mono-xs)", color: liquidation?.matched === true ? "var(--profit)" : "var(--warn)" }}>
          {liquidation?.matched === true
            ? "matches Venus's own account-liquidity call"
            : "— the plane's reconstruction does NOT match Venus's own call"}
        </span>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        {view.debts.length === 0
          ? <span style={{ color: "var(--text-subtle)" }}>— this account owes nothing on Venus</span>
          : view.debts.map((debt) => (
            <div key={debt.vToken} style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", font: "var(--type-mono-xs)" }}>
              <span style={{ color: "var(--ink-1)" }}>{debt.symbol}</span>
              <span style={{ color: "var(--text-subtle)" }}>
                {formatAtomicAmount(debt.borrowWei, decimalsFor(view, debt.vToken), 4)} owed
              </span>
              <span style={{ color: debt.supported ? "var(--profit)" : "var(--warn)" }}>
                {debt.supported ? "this guard can repay it" : "v1 cannot repay this market"}
              </span>
            </div>
          ))}
      </div>

      {unsupported.length > 0 ? (
        <p role="note" style={{ margin: 0, color: "var(--warn)", font: "var(--type-body-sm)" }}>
          Debt in {unsupported.join(", ")} is outside this guard: it will be watched but never repaid.
        </p>
      ) : null}

      {view.note !== undefined ? <p role="note" style={{ margin: 0, color: "var(--warn)" }}>{view.note}</p> : null}
      {!view.guardable ? <p role="alert" style={{ margin: 0, color: "var(--loss)" }}>{refusalText(view)}</p> : null}

      <p style={{ margin: 0, color: "var(--text-subtle)", font: "var(--type-body-sm)" }}>{LENDING_WORKING_RANGE_COPY}</p>
    </div> : null}

    <Checkbox
      checked={state.confirmed}
      onChange={(next: boolean) => onChangeRef.current({ ...state, confirmed: next })}>
      {LENDING_IRREVERSIBLE_TICK}
    </Checkbox>
  </div>;
}

function decimalsFor(view: LendingGuardableView, vToken: string): number {
  const market = view.markets.find((entry) => entry.vToken.toLowerCase() === vToken.toLowerCase());
  return market === undefined ? 18 : market.underlyingDecimals;
}
