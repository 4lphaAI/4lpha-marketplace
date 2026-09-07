"use client";

/**
 * Move BNB in and out of the agent wallet (REVISION R7).
 *
 * TWO DIFFERENT MACHINES behind one modal, and conflating them is the mistake
 * this file exists to prevent:
 *
 *   Deposit  — a PLAIN transfer from the connected wallet (A) to the agent
 *              wallet (B), signed by MetaMask. The execution plane is not
 *              involved and never sees it.
 *   Withdraw — an Altana `execute` from B, signed by the PASSKEY, submitted by
 *              Altana's relay and paid for by B. The execution plane is not on
 *              this path either: it holds no admin key for B.
 *
 * Neither tab may ever target `ownerAddress`. Under passkey custody that is a
 * derived identity with no key on any curve, and value sent there is gone
 * (D4/D6) — `validateDestination` refuses it by name.
 *
 * The SDK is imported lazily inside the confirm handler: it drags porto and a
 * relay client behind it, which a user who only deposits never needs.
 */

import * as React from "react";
import { parseEther } from "viem";
import { useBalance, useGasPrice, usePublicClient, useSendTransaction } from "wagmi";
import { Button, Input, Modal, Select } from "@/design-system";
import type { StoredPasskey } from "@/lib/exec/passkey";
import type { AccountPortfolio } from "@/lib/exec/types";
import { halfOfWei, maxDepositWei } from "@/lib/altana/amounts";
import { formatWeiAsBnb } from "@/lib/grid/geometry";
import {
  formatAtomic,
  formatBnb,
  maxTokenWithdrawAtomic,
  maxWithdrawWei,
  parseTokenAddress,
  tokenWithdrawShortfallWei,
  validateAmount,
  validateDestination,
  validateTokenAmount,
  withdrawReserveBnb,
  withdrawReserveNote,
} from "@/lib/altana/withdraw";
import type { WithdrawableToken } from "@/lib/exec/account-view";
import { WBNB_56 } from "@/lib/exec/pairs";

export type FundsWallet = AccountPortfolio["wallets"][number];

/** The `value` the source picker uses for native BNB; every other value is a token address. */
const NATIVE_SOURCE = "native";

/**
 * The picker's escape hatch.
 *
 * The listed tokens are the ones the PLANE knows: an agent's session names both
 * pool legs in its spend caps, so every token an agent ever traded appears by
 * itself. A token that reached this wallet another way — sent by hand, or one
 * whose metadata read failed — is invisible to that universe and would
 * otherwise be unreachable, since after a revoke the passkey is the only key
 * that can move it. This option asks the chain directly instead.
 */
const MANUAL_SOURCE = "manual";

const ERC20_METADATA_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** WBNB is the one token that arrives as something else — it is unwrapped on the way out. */
function isWbnb(token: WithdrawableToken): boolean {
  return token.address.toLowerCase() === WBNB_56;
}
export type FundsTab = "deposit" | "withdraw";

export function truncateAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Refuses anything `parseEther` would not read back as a positive amount. */
export function parseDepositAmount(raw: string): { readonly wei: bigint } | { readonly error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "Enter an amount in BNB." };
  if (!/^\d{1,12}(\.\d{1,18})?$/u.test(trimmed)) return { error: "Enter an amount in BNB, digits and one decimal point." };
  const wei = parseEther(trimmed);
  return wei <= 0n ? { error: "Enter an amount greater than zero." } : { wei };
}

const BODY = { font: "var(--type-body)", color: "var(--text-muted)", marginBottom: 16 } as const;
const MONO = { font: "var(--type-mono-xs)", color: "var(--ink-1)" } as const;
const NOTE_SM = { marginTop: 12, font: "var(--type-body-sm)", color: "var(--text-muted)" } as const;

/**
 * Half / Max beside an amount field.
 *
 * `max` is ALREADY net of whatever fee that side has to leave behind — the
 * deposit side subtracts the transfer's own gas, the withdraw side subtracts the
 * relay reserve — so this component never does money arithmetic of its own
 * beyond halving. `null` means the balance is unknown, and the buttons say so
 * rather than offering a number nobody measured.
 */
function QuickAmounts(props: { readonly max: bigint | null; readonly reason: string; readonly onPick: (wei: bigint) => void }) {
  const disabled = props.max === null || props.max === 0n;
  return <div style={{ display: "flex", gap: 8 }}>
    <Button variant="ghost" size="sm" disabled={disabled} title={disabled ? props.reason : undefined}
      onClick={disabled ? undefined : () => props.onPick(halfOfWei(props.max!))}>Half</Button>
    <Button variant="ghost" size="sm" disabled={disabled} title={disabled ? props.reason : undefined}
      onClick={disabled ? undefined : () => props.onPick(props.max!)}>Max</Button>
  </div>;
}

/**
 * The amount label row: the field's own label on the left, Half / Max pushed to
 * the right edge above the input. The `Input` label is dropped so the label is
 * not rendered twice — this row IS the label.
 */
function AmountLabelRow(props: { readonly max: bigint | null; readonly reason: string; readonly onPick: (wei: bigint) => void }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 16, marginBottom: 6 }}>
    <span className="fl-field__label" style={{ marginBottom: 0 }}>Amount</span>
    <QuickAmounts max={props.max} reason={props.reason} onPick={props.onPick} />
  </div>;
}

function Tab(props: { readonly active: boolean; readonly disabled?: boolean; readonly title?: string; readonly onClick: () => void; readonly children: React.ReactNode }) {
  return <button type="button" disabled={props.disabled} title={props.title} onClick={props.onClick}
    style={{
      background: "none", border: "none", cursor: props.disabled ? "default" : "pointer", padding: "0 2px 8px",
      font: `var(--weight-${props.active ? "medium" : "regular"}) var(--text-sm)/1 var(--font-sans)`,
      color: props.disabled ? "var(--text-subtle)" : props.active ? "var(--brand)" : "var(--text-muted)",
      borderBottom: props.active ? "2px solid var(--brand)" : "2px solid transparent",
    }}>{props.children}</button>;
}

export function FundsModal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly wallet: FundsWallet;
  readonly connectedAddress: string | undefined;
  /** Liquid NATIVE balance of the agent wallet, in wei. `null` = unreadable. */
  readonly availableWei?: bigint | null;
  /**
   * Every known ERC-20 this wallet holds. WBNB is unwrapped and delivered as
   * native in one batch; anything else is sent as the token itself. Both matter
   * because an LP exit can leave either behind (FINDINGS (ag)), and after the
   * agent is revoked the passkey is the only key that can move them.
   */
  readonly tokens?: readonly WithdrawableToken[];
  /** The passkey that is wallet B's admin key. Absent ⇒ withdraw is unavailable. */
  readonly passkey?: StoredPasskey | null;
  /** The derived owner identity, so the destination check can refuse it by name. */
  readonly ownerAddress?: string;
  /**
   * Whether wallet B already has code on chain. Decides the gas reserve tier;
   * `null` (unread or failed) takes the LARGER first-action reserve. Read once
   * by the account screen so the enable gate and this modal cannot disagree.
   */
  readonly walletRegistered?: boolean | null;
  readonly initialTab?: FundsTab;
  /**
   * A deposit the caller has already computed (the hire flow's required
   * amount): the field is filled and locked, Half/Max are hidden, and — when
   * `autoSubmitDeposit` is set — the connected wallet is asked to sign the
   * transfer the moment the panel opens. The owner's only act is the wallet's
   * own confirmation; there is no amount to get wrong.
   */
  readonly fixedDepositWei?: bigint;
  readonly autoSubmitDeposit?: boolean;
  /** Fires once with the transaction hash after the wallet has sent the deposit. */
  readonly onDepositSubmitted?: (hash: string) => void;
  /**
   * Fires after a withdrawal that did NOT fail, and again when the panel is
   * closed after one. The balances this modal offers are the caller's, so a
   * withdrawal that moved a token out would otherwise keep offering the amount
   * it already sent — the second call covers the read lagging the receipt.
   */
  readonly onWithdrawn?: () => void;
}) {
  const [tab, setTab] = React.useState<FundsTab>(props.initialTab ?? "deposit");
  const withdrawable = props.passkey?.walletAddress !== undefined
    && props.passkey.walletAddress.toLowerCase() === props.wallet.address.toLowerCase();

  if (!props.open) return null;
  const tabs = <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
    <Tab active={tab === "deposit"} onClick={() => setTab("deposit")}>Deposit</Tab>
    <Tab active={tab === "withdraw"} disabled={!withdrawable} onClick={() => setTab("withdraw")}
      title={withdrawable ? undefined : "Withdrawing needs the passkey that holds this wallet."}>Withdraw</Tab>
  </div>;

  return tab === "deposit"
    ? <DepositTab {...props} tabs={tabs} />
    : <WithdrawTab {...props} tabs={tabs} passkey={props.passkey as StoredPasskey} />;
}

/**
 * Read one token's symbol, decimals and balance straight from the chain.
 *
 * Debounced on the typed address and cancelled by generation, so a half-typed
 * address never leaves a stale token selected — the amount field is checked
 * against THIS token's decimals, and a stale one would size an amount wrongly.
 * A token whose `symbol` reverts (the bytes32 ones) still resolves: decimals and
 * balance are what the arithmetic needs, and the address is a truthful label.
 */
function useManualToken(walletAddress: string): {
  readonly address: string;
  readonly setAddress: (next: string) => void;
  readonly token: WithdrawableToken | null;
  readonly error: string | null;
  readonly busy: boolean;
} {
  const publicClient = usePublicClient();
  const [address, setAddress] = React.useState("");
  const [token, setToken] = React.useState<WithdrawableToken | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const generation = React.useRef(0);

  React.useEffect(() => {
    const current = ++generation.current;
    setToken(null);
    setError(null);
    if (address.trim() === "") { setBusy(false); return; }
    const parsed = parseTokenAddress(address);
    if ("error" in parsed) { setError(parsed.error); setBusy(false); return; }
    if (!publicClient) { setError("No chain connection to read this token with."); setBusy(false); return; }
    setBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const read = async <T,>(functionName: "symbol" | "decimals" | "balanceOf", args: readonly unknown[] = []): Promise<T | null> => {
          try {
            return await publicClient.readContract({ address: parsed.value, abi: ERC20_METADATA_ABI, functionName, args } as never) as T;
          } catch { return null; }
        };
        const [decimals, balance, symbol] = await Promise.all([
          read<number>("decimals"),
          read<bigint>("balanceOf", [walletAddress as `0x${string}`]),
          read<string>("symbol"),
        ]);
        if (current !== generation.current) return;
        setBusy(false);
        if (decimals === null || balance === null) {
          setError("That address did not answer as a BEP-20 token on this chain.");
          return;
        }
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
          setError("That token reports a number of decimals this app cannot size an amount against.");
          return;
        }
        if (balance <= 0n) {
          setError("This wallet holds none of that token.");
          return;
        }
        setToken({
          address: parsed.value,
          symbol: typeof symbol === "string" && symbol.length > 0 && symbol.length <= 16 ? symbol : truncateAddress(parsed.value),
          decimals,
          balanceAtomic: balance,
        });
      })();
    }, 350);
    return () => { window.clearTimeout(timer); };
  }, [address, publicClient, walletAddress]);

  return { address, setAddress, token, error, busy };
}

function DepositTab(props: {
  readonly onClose: () => void;
  readonly wallet: FundsWallet;
  readonly connectedAddress: string | undefined;
  readonly tabs: React.ReactNode;
  readonly fixedDepositWei?: bigint;
  readonly autoSubmitDeposit?: boolean;
  readonly onDepositSubmitted?: (hash: string) => void;
}) {
  const { sendTransaction, data: hash, isPending, error, reset } = useSendTransaction();
  const fixed = props.fixedDepositWei;
  const [amount, setAmount] = React.useState(fixed === undefined ? "" : formatWeiAsBnb(fixed));
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const sameAddress = props.connectedAddress !== undefined && props.connectedAddress.toLowerCase() === props.wallet.address.toLowerCase();
  // The deposit is paid OUT OF the same balance it moves, so "Max" is the
  // connected wallet's balance minus this transfer's own gas (plus a margin) —
  // never the balance itself. Either read failing leaves `max` null and the
  // quick amounts disabled with a reason.
  const balance = useBalance({ address: props.connectedAddress as `0x${string}` | undefined });
  const gasPrice = useGasPrice();
  const balanceWei = balance.data?.value;
  const gasPriceWei = gasPrice.data;
  const max = balanceWei === undefined || gasPriceWei === undefined
    ? null
    : maxDepositWei({ balanceWei, gasPriceWei });

  const close = () => { setAmount(""); setInvalid(null); reset(); props.onClose(); };
  const confirm = () => {
    if (fixed !== undefined) {
      sendTransaction({ to: props.wallet.address as `0x${string}`, value: fixed });
      return;
    }
    const parsed = parseDepositAmount(amount);
    if ("error" in parsed) { setInvalid(parsed.error); return; }
    setInvalid(null);
    sendTransaction({ to: props.wallet.address as `0x${string}`, value: parsed.wei });
  };
  // Auto-submit exactly once per open: the wallet prompt IS the confirmation.
  // Never while the connected wallet is the agent wallet, and never twice.
  const autoSubmitted = React.useRef(false);
  React.useEffect(() => {
    if (!props.autoSubmitDeposit || fixed === undefined || autoSubmitted.current) return;
    if (props.connectedAddress === undefined || sameAddress || isPending || hash !== undefined) return;
    autoSubmitted.current = true;
    sendTransaction({ to: props.wallet.address as `0x${string}`, value: fixed });
  }, [props.autoSubmitDeposit, fixed, props.connectedAddress, sameAddress, isPending, hash, sendTransaction, props.wallet.address]);
  const reported = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (hash === undefined || reported.current === hash) return;
    reported.current = hash;
    props.onDepositSubmitted?.(hash);
  }, [hash, props]);

  return <Modal title="Deposit" onClose={close} footer={
    <>
      <Button variant="ghost" onClick={close}>{hash ? "Done" : "Cancel"}</Button>
      <Button variant="primary" onClick={confirm} disabled={isPending || sameAddress}>{isPending ? "Confirm in your wallet…" : "Deposit BNB"}</Button>
    </>
  }>
    {props.tabs}

    <p style={BODY}>
      From connected wallet <span style={MONO}>{props.connectedAddress ? truncateAddress(props.connectedAddress) : "not connected"}</span>
      {" → "}Agent wallet <span style={MONO}>{truncateAddress(props.wallet.address)}</span>.
    </p>

    {fixed === undefined
      ? <AmountLabelRow max={max} reason="The connected wallet balance could not be read."
          onPick={(wei) => { setAmount(formatWeiAsBnb(wei)); setInvalid(null); }} />
      : <p style={BODY}>This is the amount the hire needs: agent capital plus the session registration fee and its gas. It is not editable here.</p>}

    <Input mono suffix="BNB" value={amount} inputMode="decimal" placeholder="0.05" readOnly={fixed !== undefined}
      onChange={(event: { target: { value: string } }) => { if (fixed !== undefined) return; setAmount(event.target.value); setInvalid(null); }}
      error={invalid ?? undefined} />

    {sameAddress && <p style={NOTE_SM}>The connected wallet is the agent wallet. A self-transfer is not a deposit.</p>}
    {hash && <p style={{ ...NOTE_SM, color: "var(--profit)" }}>
      Deposit submitted. Transaction <a href={`https://bscscan.com/tx/${hash}`} target="_blank" rel="noreferrer"
        style={{ font: "var(--type-mono-xs)", color: "var(--brand)" }}>{truncateAddress(hash)}</a> on BscScan.
    </p>}
    {error && !hash && <p style={{ ...NOTE_SM, color: "var(--loss)" }}>The deposit was not sent: {error.message.split("\n")[0]}</p>}
  </Modal>;
}

type WithdrawState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "done"; readonly status: "PENDING" | "CONFIRMED" | "FAILED"; readonly txHash?: string; readonly callsId: string }
  | { readonly kind: "error"; readonly message: string };

function WithdrawTab(props: {
  readonly onClose: () => void;
  readonly wallet: FundsWallet;
  readonly connectedAddress: string | undefined;
  readonly availableWei?: bigint | null;
  readonly tokens?: readonly WithdrawableToken[];
  readonly passkey: StoredPasskey;
  readonly ownerAddress?: string;
  readonly walletRegistered?: boolean | null;
  readonly onWithdrawn?: () => void;
  readonly tabs: React.ReactNode;
}) {
  const available = props.availableWei ?? null;
  // The tier the reserve is charged at, and the SAME one `validateAmount`
  // enforces below — a mismatch would offer a max the check then refuses.
  const tier = { registered: props.walletRegistered ?? null };
  // Which balance pays. Native is a plain transfer minus the reserve; a token
  // is sent in full and the reserve is only required to still be there, because
  // the relay fee comes out of BNB either way. WBNB additionally unwraps, so it
  // arrives as BNB — every other token arrives as itself.
  const tokens = props.tokens ?? [];
  const [source, setSource] = React.useState<string>(NATIVE_SOURCE);
  const manual = useManualToken(props.wallet.address);
  const token = source === MANUAL_SOURCE
    ? manual.token
    : tokens.find((entry) => entry.address.toLowerCase() === source.toLowerCase()) ?? null;
  const unit = token?.symbol ?? "BNB";
  const decimals = token?.decimals ?? 18;
  const max = available === null
    ? null
    : token === null
      ? maxWithdrawWei(available, tier)
      : maxTokenWithdrawAtomic({ balanceAtomic: token.balanceAtomic, nativeWei: available, ...tier });
  // How much BNB is missing before a token can move at all. `null` only when the
  // native balance could not be read; `0n` when nothing is missing.
  const feeShortfall = available === null ? null : tokenWithdrawShortfallWei({ nativeWei: available, ...tier });
  const [amount, setAmount] = React.useState("");
  // Prefilled with the connected wallet A when there is one, because that is
  // the only address the browser can vouch for. Editable, and empty is refused
  // rather than defaulted — a defaulted destination is how funds go somewhere
  // the user never read.
  const [to, setTo] = React.useState(props.connectedAddress ?? "");
  // The prefill FOLLOWS the connected wallet. `useState` seeds once, so without
  // this a wallet switched after mount leaves the previous wallet's address
  // sitting in the destination of a transfer — the one field where a stale
  // value sends money somewhere the user did not choose. Only an untouched
  // prefill is replaced; anything typed is left alone.
  const prefilled = React.useRef(props.connectedAddress ?? "");
  React.useEffect(() => {
    const next = props.connectedAddress ?? "";
    setTo((current) => (current === prefilled.current ? next : current));
    prefilled.current = next;
  }, [props.connectedAddress]);
  const [amountError, setAmountError] = React.useState<string | null>(null);
  const [toError, setToError] = React.useState<string | null>(null);
  const [state, setState] = React.useState<WithdrawState>({ kind: "idle" });
  // Whether anything left the wallet in this panel. Drives the second balance
  // refresh on close, because the portfolio read taken the moment the receipt
  // lands can still be a block behind the transfer it is meant to show.
  const withdrew = React.useRef(false);

  // A settled result freezes the panel so one passkey approval cannot be
  // replayed by a second click. Touching a field is the user starting the NEXT
  // withdrawal — switching token, say — so it clears the result instead of
  // making them close and reopen the panel. A PENDING submission is untouched.
  const restart = () => { setState((current) => (current.kind === "done" || current.kind === "error" ? { kind: "idle" } : current)); };

  // A refreshed balance list drops a token that has just been withdrawn in
  // full. Leaving `source` pointing at it resolves `token` to null, which is
  // indistinguishable from NATIVE here — the panel would silently re-aim at BNB
  // while still showing the token's name. Fall back explicitly, amount included.
  const tokenKey = tokens.map((entry) => entry.address.toLowerCase()).join(",");
  React.useEffect(() => {
    if (source === NATIVE_SOURCE || source === MANUAL_SOURCE) return;
    if (tokenKey.split(",").includes(source.toLowerCase())) return;
    setSource(NATIVE_SOURCE);
    setAmount("");
    setAmountError(null);
  }, [tokenKey, source]);

  const close = () => {
    setState({ kind: "idle" });
    if (withdrew.current) { withdrew.current = false; props.onWithdrawn?.(); }
    props.onClose();
  };

  const confirm = () => {
    if (available === null) { setState({ kind: "error", message: "The wallet balance could not be read, so an amount cannot be checked." }); return; }
    const destination = validateDestination({ to, passkeyOwnerAddress: props.ownerAddress });
    const parsed = token === null
      ? validateAmount({ raw: amount, availableWei: available, ...tier })
      : validateTokenAmount({ raw: amount, balanceAtomic: token.balanceAtomic, decimals: token.decimals, symbol: token.symbol, nativeWei: available, ...tier });
    setToError("error" in destination ? destination.error : null);
    setAmountError("error" in parsed ? parsed.error : null);
    if ("error" in destination || "error" in parsed) return;

    setState({ kind: "pending" });
    void (async () => {
      try {
        const client = await import("@/lib/altana/client");
        const result = token === null
          ? await client.withdrawNative({ record: props.passkey, to: destination.value, valueWei: parsed.value })
          : isWbnb(token)
            ? await client.withdrawWbnbAsNative({ record: props.passkey, to: destination.value, amountWei: parsed.value })
            : await client.withdrawToken({ record: props.passkey, token: token.address as `0x${string}`, to: destination.value, amountAtomic: parsed.value });
        // `execute` reports FAILED without throwing. It is carried into the
        // result state verbatim and rendered as a failure — never as a success.
        setState({ kind: "done", status: result.status, callsId: result.callsId, ...(result.transactionHash ? { txHash: result.transactionHash } : {}) });
        // FAILED moved nothing but the fee, so only the other two ask the
        // caller to re-read the balances this panel is offering.
        if (result.status !== "FAILED") { withdrew.current = true; props.onWithdrawn?.(); }
      } catch (cause) {
        setState({ kind: "error", message: cause instanceof Error ? cause.message.split("\n")[0]! : "The withdrawal could not be submitted." });
      }
    })();
  };

  const settled = state.kind === "done" || state.kind === "error";
  const explorer = state.kind === "done" && state.txHash ? `https://bscscan.com/tx/${state.txHash}` : null;

  return <Modal title="Withdraw" onClose={close} footer={
    <>
      <Button variant="ghost" onClick={close}>{settled ? "Done" : "Cancel"}</Button>
      <Button variant="primary" onClick={confirm} disabled={state.kind === "pending" || settled || max === null || max === 0n}>
        {state.kind === "pending" ? "Approve on your device…" : "Confirm with passkey"}
      </Button>
    </>
  }>
    {props.tabs}

    <p style={BODY}>
      From agent wallet <span style={MONO}>{truncateAddress(props.wallet.address)}</span>. {token === null || isWbnb(token)
        ? "Delivered as native BNB; WBNB is unwrapped in the same batch."
        : `Delivered as ${token.symbol}. The network fee is still paid in BNB.`}
    </p>

    {tokens.length > 0 && <Select label="Withdraw" value={source}
      onChange={(event: { target: { value: string } }) => { setSource(event.target.value); setAmount(""); setAmountError(null); restart(); }}
      options={[
        { value: NATIVE_SOURCE, label: `BNB${available === null ? "" : ` · ${formatBnb(available)}`}` },
        ...tokens.map((entry) => ({
          value: entry.address,
          label: `${entry.symbol} · ${formatAtomic(entry.balanceAtomic, entry.decimals)}${isWbnb(entry) ? " → BNB" : ""}`,
        })),
        { value: MANUAL_SOURCE, label: "Another token, by address…" },
      ]} />}

    {source === MANUAL_SOURCE && <div style={{ marginTop: 12 }}>
      <Input label="Token contract" mono value={manual.address} placeholder="0x…"
        onChange={(event: { target: { value: string } }) => { manual.setAddress(event.target.value); setAmount(""); setAmountError(null); restart(); }}
        error={manual.error ?? undefined}
        hint={manual.error !== null ? undefined : manual.token === null
          ? (manual.busy ? "Reading the token…" : "Paste any BEP-20 address; its symbol, decimals and balance are read from the chain.")
          : `${manual.token.symbol}: this wallet holds ${formatAtomic(manual.token.balanceAtomic, manual.token.decimals, manual.token.decimals)}.`} />
    </div>}

    {/* The max is already net of the tier's reserve, so picking it leaves B
        able to pay for its own next action. */}
    <AmountLabelRow max={max} reason={max === null ? "The wallet balance could not be read." : token === null ? `Keep ${withdrawReserveBnb(tier)} BNB in the wallet for the network fee.` : feeShortfall === null || feeShortfall === 0n ? "Nothing to send." : `Deposit ${formatBnb(feeShortfall, 8)} BNB to cover the network fee.`}
      onPick={(value) => { setAmount(formatAtomic(value, decimals, decimals)); setAmountError(null); restart(); }} />

    <Input mono suffix={unit} value={amount} inputMode="decimal" placeholder="0.05"
      onChange={(event: { target: { value: string } }) => { setAmount(event.target.value); setAmountError(null); restart(); }}
      error={amountError ?? undefined}
      hint={amountError ? undefined : max === null
        ? "The wallet balance could not be read."
        : token === null
          ? `Most you can send: ${formatBnb(max)} BNB — ${withdrawReserveNote(tier)}.`
          : max === 0n
            ? (feeShortfall !== null && feeShortfall > 0n
              ? `The network fee is paid in BNB and this wallet is ${formatBnb(feeShortfall, 8)} BNB short. Deposit that much, then withdraw ${token.symbol}.`
              : `This wallet holds no ${token.symbol}.`)
            : `Most you can send: ${formatAtomic(max, decimals)} ${token.symbol}${isWbnb(token) ? ", unwrapped and delivered as BNB" : ""}. The fee comes out of the wallet's BNB.`} />

    <div style={{ marginTop: 16 }}>
      <Input label="Destination" mono value={to} placeholder="0x…"
        onChange={(event: { target: { value: string } }) => { setTo(event.target.value); setToError(null); restart(); }}
        error={toError ?? undefined}
        hint={toError === null && props.connectedAddress === undefined ? "Enter the address to send to." : undefined} />
    </div>

    {state.kind === "done" && state.status !== "FAILED" && <p style={{ ...NOTE_SM, color: "var(--profit)" }}>
      Withdrawal {state.status === "CONFIRMED" ? "confirmed" : "submitted"}.
      {explorer
        ? <> Transaction <a href={explorer} target="_blank" rel="noreferrer" style={{ font: "var(--type-mono-xs)", color: "var(--brand)" }}>{truncateAddress(state.txHash!)}</a> on BscScan.</>
        : <> No transaction hash yet. Reference <span style={{ font: "var(--type-mono-xs)" }}>{truncateAddress(state.callsId)}</span>.</>}
    </p>}

    {state.kind === "done" && state.status === "FAILED" && <p style={{ ...NOTE_SM, color: "var(--loss)" }}>
      The withdrawal failed on chain. Altana reported status FAILED for <span style={{ font: "var(--type-mono-xs)" }}>{truncateAddress(state.callsId)}</span>. Nothing left the wallet except the fee.
    </p>}

    {state.kind === "error" && <p style={{ ...NOTE_SM, color: "var(--loss)" }}>The withdrawal was not submitted: {state.message}</p>}
  </Modal>;
}
