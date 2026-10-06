"use client";
/* Deploy pop-up for TradFi AI Trade, laid out after the Claude Design export
   (ui_kits/marketplace AgenticDeployModal): 1 wallet custody → 2 term + term end →
   3 QR pairing → 4 fund USDT/BNB → 5 Binance checks + deploy. Every step drives the
   real Agentic routes; the design only sets the layout. */
import * as React from "react";
import { useAccount } from "wagmi";
import { AgenticWalletBadge, Button, Icon } from "@/design-system";
import type { TradeSettings } from "@/lib/trade";
import { AGENTIC_DCA_COPY, AGENTIC_EARN_COPY, AGENTIC_EARN_PRODUCTS, AGENTIC_MEME_COPY, agenticEarnEnabled, agenticEarnEstimate, agenticEarnOffered, agenticMemeEnabled, agenticMemeSettings, agenticDcaBnbSlots, agenticDcaResting, agenticGate, agenticHireSettings, agenticKeepAliveBudgetWei, agenticRequest, agenticScheduleCounts, agenticUiString, AgenticRequestError, rememberAgenticWallet, type AgenticGateRow, type AgenticPairing } from "@/lib/agentic";
import { PairingQr } from "@/components/agentic/PairingQr";
import { FundsModal } from "@/components/FundsModal";
import { LinearProgress } from "./DeployRunModal";
import { EarnDisclosure } from "./EarnDisclosure";

// Binance gold, as the Agentic Wallet badge on the Deploy tiles. The CSS variable this used was never defined, so the selected tile drew no radio dot and no border.
const GOLD = "#F0B90B";
const STEP_TITLES = ["Choose a wallet", "Agentic Wallet term", "Pair in the Binance App", "Fund the Agentic Wallet", "Binance checks"] as const;
const STATE_COLOR: Readonly<Record<string, string>> = { PASS: "var(--profit)", FAIL: "var(--loss)", WARN: "var(--warn)" };
const GATE_LABELS: Readonly<Record<string, string>> = {
  status: "Connected", "trade-all-tokens": "Trade all tokens", "abnormal-handling": "Abnormal transactions: AutoReject",
  "sign-in-time": "Max sign-in duration covers the term", "daily-limit": "Daily limit", "x402-limit": "x402 daily limit",
  usdt: "USDT balance", bnb: "BNB for gas", "quota-today": "Binance quota today", sizing: "Capital covers position sizes",
  "schedule-first-buy": "First buy falls inside the term", "schedule-end-date": "End date is in the future",
};
const BNB_PER_SLOT_WEI = 400_000_000_000_000n;
const PORTFOLIO_INTERVALS: Readonly<Record<number, string>> = { 14400: "4 h", 28800: "8 h", 43200: "12 h", 86400: "day" };
const mono: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-mono)", color: "var(--text-subtle)" };
const body: React.CSSProperties = { font: "var(--weight-regular) var(--text-sm)/1.55 var(--font-sans)", color: "var(--text-muted)", margin: 0, textWrap: "pretty" };
const label: React.CSSProperties = { font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" };
const sunken: React.CSSProperties = { border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)" };
const outlineBtn = (color: string): React.CSSProperties => ({ cursor: "pointer", flex: 1, padding: "12px 16px", borderRadius: "var(--radius-sm)", background: "transparent", border: "1px solid " + color, color, font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" });
const solidBtn = (color: string, disabled: boolean): React.CSSProperties => ({ ...outlineBtn(color), background: color, color: "var(--surface-card)", opacity: disabled ? 0.4 : 1, cursor: disabled ? "not-allowed" : "pointer" });

function Dot({ color, size = 7 }: { color: string; size?: number }) {
  return <i style={{ width: size, height: size, borderRadius: 999, flex: "0 0 auto", background: color }} />;
}

function Radio({ on, color }: { on: boolean; color?: string | undefined }) {
  return <span style={{ width: 14, height: 14, borderRadius: 999, border: "1px solid " + (on ? color ?? "var(--ink-1)" : "var(--line-3)"), display: "grid", placeItems: "center", flex: "0 0 auto" }}>
    {on ? <Dot color={color ?? "var(--ink-1)"} /> : null}</span>;
}

function OptionCard({ on, onClick, title }: { on: boolean; onClick(): void; title: string }) {
  return <button type="button" onClick={onClick} aria-pressed={on}
    style={{ textAlign: "left", cursor: "pointer", display: "flex", gap: 10, alignItems: "center", padding: "12px 14px", borderRadius: "var(--radius-sm)",
      background: on ? "var(--raised-3)" : "var(--surface-sunken)", border: "1px solid " + (on ? "var(--line-3)" : "var(--line-1)") }}>
    <Radio on={on} /><span style={label}>{title}</span>
  </button>;
}

function ChoiceTile({ on, onClick, color, note, children }: { on: boolean; onClick(): void; color?: string; note: string; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={on}
    style={{ textAlign: "left", cursor: "pointer", display: "grid", alignContent: "start", gap: 12, padding: 14, minHeight: 112, borderRadius: "var(--radius-sm)",
      background: on ? "var(--raised-3)" : "var(--surface-sunken)", border: "1px solid " + (on ? color ?? "var(--line-3)" : "var(--line-1)") }}>
    <Radio on={on} color={color} />
    <span style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 26 }}>{children}</span>
    <span style={{ font: "var(--weight-medium) var(--text-xs)/1.45 var(--font-sans)", color: "var(--text-subtle)" }}>{note}</span>
  </button>;
}

function Spinner() {
  return <span className="fl-aw-spin" aria-hidden="true" style={{ width: 13, height: 13, borderRadius: 999, border: "1.5px solid var(--line-2)", borderTopColor: "var(--warn)", display: "inline-block", flex: "0 0 auto", animation: "flAwSpin 0.9s linear infinite" }} />;
}

/** 6-character pairing code: one real input drives six cells. */
function CodeCells({ value, onChange, disabled }: { value: string; onChange(value: string): void; disabled: boolean }) {
  const [focus, setFocus] = React.useState(false);
  const chars = value.replace(/\s/g, "").slice(0, 6).split("");
  const active = Math.min(chars.length, 5);
  return <label style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 6, maxWidth: 264, cursor: disabled ? "default" : "text" }}>
    {Array.from({ length: 6 }, (_, i) => <span key={i} style={{ height: 42, display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)",
      border: "1px solid " + (focus && !disabled && i === active ? "var(--ink-2)" : chars[i] ? "var(--line-3)" : "var(--line-2)"),
      font: "var(--weight-medium) var(--text-lg)/1 var(--font-mono)", color: disabled ? "var(--text-muted)" : "var(--ink-1)", textTransform: "lowercase" }}>{chars[i] ?? ""}</span>)}
    <input aria-label="App code" value={value} maxLength={6} autoComplete="off" spellCheck={false} disabled={disabled}
      onChange={e => onChange(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, border: "none", background: "transparent", color: "transparent", caretColor: "transparent" }} />
  </label>;
}

function FundRow({ asset, have, need, first }: { asset: "USDT" | "BNB"; have: bigint | null; need: bigint; first: boolean }) {
  const ok = have !== null && have >= need;
  return <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "12px 14px", borderTop: first ? "none" : "1px solid var(--line-1)" }}>
    <span style={{ display: "grid", gap: 5 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Dot color={ok ? "var(--profit)" : "var(--loss)"} /><span style={label}>{asset}</span></span>
      <span style={mono}>Balance: <b style={{ color: "var(--ink-1)" }}>{have === null ? "unavailable" : `${agenticUiString(have)} ${asset}`}</b> · need <b style={{ color: "var(--ink-1)" }}>{agenticUiString(need)} {asset}</b></span>
    </span>
    {ok ? <span style={{ display: "flex", alignItems: "center", gap: 6, ...mono, color: "var(--profit)" }}><Icon name="success" size={13} />FUNDED</span>
      : <span style={{ display: "flex", alignItems: "center", gap: 7, ...mono, color: "var(--warn)" }}><Spinner />WAITING</span>}
  </div>;
}

function GateList({ rows, ariaLabel }: { rows: readonly { code: string; state: string; fix: string }[]; ariaLabel: string }) {
  const tone = (state: string) => STATE_COLOR[state] ?? "var(--text-subtle)";
  return <ul aria-label={ariaLabel} style={{ ...sunken, listStyle: "none", margin: 0, padding: 0 }}>
    {rows.map((row, i) => <li key={row.code} style={{ display: "grid", gridTemplateColumns: "56px minmax(0,1fr)", gap: 12, padding: "10px 14px", borderTop: i ? "1px solid var(--line-1)" : "none", alignItems: "start" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--weight-medium) var(--text-xs)/18px var(--font-mono)", color: tone(row.state) }}><Dot color={tone(row.state)} />{row.state}</span>
      <span style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <span style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}><span style={label}>{GATE_LABELS[row.code] ?? row.code}</span><span style={mono}>{row.code}</span></span>
        {row.state === "PASS" ? null : <span style={{ ...body, fontSize: "var(--text-xs)", overflowWrap: "anywhere" }}>{row.fix}</span>}
      </span>
    </li>)}
  </ul>;
}

function AgenticFunding({ wallet, asset, amount, close, onSent }: { wallet: string; asset: "USDT" | "BNB"; amount: bigint; close(): void; onSent(): void }) {
  const { address, chainId } = useAccount();
  if (address === undefined || chainId !== 56) return <div role="alert" style={{ ...sunken, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 12px" }}>
    <span style={{ ...body, color: "var(--ink-1)" }}>Connect an extension wallet on BSC to send.</span>
    <Button variant="ghost" size="sm" onClick={close}>Close funding</Button></div>;
  return <FundsModal open onClose={close} initialTab="deposit" connectedAddress={address}
    wallet={{ address: wallet, custodyModel: "self-eoa", depositable: true, source: "declared", availableUsdMicros: null, deployedUsdMicros: null, deployedReason: "declared" }}
    fixedDepositAsset={asset} {...(asset === "USDT" ? { fixedDepositAtomic: amount } : { fixedDepositWei: amount })}
    onDepositSubmitted={() => { onSent(); close(); }} />;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function AgenticDeployModal({ settings, go, blockedReason, altanaBlockedReason = null, onClose, onAltana, onCustody, label: agentLabel = "Trading Agent", color = "var(--cat-yield)", portfolioSymbols }: {
  settings: TradeSettings; go(route: string): void; blockedReason?: string | null; altanaBlockedReason?: string | null; onClose(): void; onAltana(): void;
  /** Smart Portfolio: the basket's tickers in the signed row order, for the review line. */ portfolioSymbols?: readonly string[] | undefined;
  onCustody?(custody: "altana" | "agentic"): void; label?: string; color?: string;
}) {
  const [step, setStep] = React.useState(0);
  const [custody, setCustody] = React.useState<"altana" | "agentic" | null>(null);
  const [term, setTerm] = React.useState<7 | 30>(7);
  // A Schedule buy never sells: it keeps its holdings at term end, so there is no choice to make.
  const schedule = settings.tradeMode === "schedule";
  // A portfolio holds a basket and keeps it at term end too; it pays a small CMC budget only to keep the Binance session alive.
  const portfolio = settings.tradeMode === "portfolio";
  // Agentic Auto DCA never sells either: its orders are cancelled at term end and the holdings stay.
  const dca = settings.tradeMode === "dca";
  const [action, setAction] = React.useState<"keep" | "sell-all" | null>(schedule || portfolio || dca ? "keep" : null);
  // AGENTIC-MEME-STOCKS-SPEC 9.4: AI Trade with Agentic custody offers a paper meme strategy (flag on); it sells all at term end and has its own sizing inputs.
  const [strategy, setStrategy] = React.useState<"stocks" | "meme">("stocks");
  const meme = agenticMemeEnabled && !schedule && !portfolio && !dca && strategy === "meme";
  const [memeSizing, setMemeSizing] = React.useState({ entryUsdt: 10, maxOpenPositions: 2, capitalUsdt: 20 });
  const memeSizingOk = Number.isInteger(memeSizing.entryUsdt) && memeSizing.entryUsdt >= 10 && memeSizing.entryUsdt <= 50 && Number.isInteger(memeSizing.maxOpenPositions)
    && memeSizing.maxOpenPositions >= 1 && memeSizing.maxOpenPositions <= 3 && Number.isInteger(memeSizing.capitalUsdt) && memeSizing.capitalUsdt >= memeSizing.maxOpenPositions * memeSizing.entryUsdt;
  // AGENTIC-EARN-SPEC 3.15: one unchecked opt-in, offered only with the flag on, a configured product and a lane that may use it.
  const [earn, setEarn] = React.useState(false);
  const earnOffered = agenticEarnOffered({ tradeMode: settings.tradeMode, dcaMaxOrders: settings.dcaMaxOrders ?? null, meme }, agenticEarnEnabled, AGENTIC_EARN_PRODUCTS);
  const earnOn = earnOffered && earn;
  const chooseStrategy = (value: "stocks" | "meme") => { setStrategy(value); setAction(value === "meme" ? "sell-all" : null); };
  const [pairing, setPairing] = React.useState<{ pairingId: string; urlForWeb: string; expireAtMs: number } | null>(null);
  const [state, setState] = React.useState<AgenticPairing | null>(null);
  const [code, setCode] = React.useState("");
  const [codeMatched, setCodeMatched] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [gateFailures, setGateFailures] = React.useState<readonly AgenticGateRow[]>([]);
  const [hireReason, setHireReason] = React.useState<string | null>(null);
  const [funding, setFunding] = React.useState<{ asset: "USDT" | "BNB"; amount: bigint } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [depositSent, setDepositSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [started, setStarted] = React.useState<{ walletAddress: string; hireEndMs: number } | null>(null);
  const [hireRunId, setHireRunId] = React.useState(() => crypto.randomUUID());
  const [now, setNow] = React.useState(Date.now);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(null); setGateFailures([]); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "agentic_unavailable"); if (e instanceof AgenticRequestError) { setGateFailures(e.gate); setHireReason(e.reason); } } finally { setBusy(false); } };
  const terminal = state?.state === "failed" || state?.state === "expired";
  React.useEffect(() => {
    if (pairing === null || started !== null || terminal) return;
    let active = true;
    const timer = setInterval(() => { void agenticRequest<AgenticPairing>(`pairings/${pairing.pairingId}`).then(value => { if (active) { setState(value); setNow(Date.now()); } }).catch(() => { if (active) setError("agentic_unavailable"); }); }, 2_000);
    return () => { active = false; clearInterval(timer); };
  }, [pairing, started, terminal]);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && funding === null) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [funding, onClose]);

  const budgetWei = schedule || meme ? 0n : portfolio || dca ? agenticKeepAliveBudgetWei(term) : BigInt(term === 7 ? 2 : 8) * 10n ** 18n;
  const capitalWei = meme ? BigInt(memeSizing.capitalUsdt) * 10n ** 18n : BigInt(settings.capitalQuoteWei ?? "0");
  const entryWei = meme ? BigInt(memeSizing.entryUsdt) * 10n ** 18n : BigInt(settings.entryWei);
  const maxOpenPositions = meme ? memeSizing.maxOpenPositions : settings.maxOpenPositions;
  const scheduleInput = !schedule ? undefined : { intervalSec: settings.scheduleIntervalSec!, endKind: settings.scheduleEndKind!, endRuns: settings.scheduleEndRuns ?? null,
    endAtSec: settings.scheduleEndAtSec ?? null, firstAtSec: settings.scheduleFirstAtSec ?? null };
  // The whole-term count (not the gate's clipped one), so the funding step never under-asks BNB.
  const buys = scheduleInput === undefined ? null : agenticScheduleCounts({ ...scheduleInput, capitalQuoteWei: capitalWei, entryWei: BigInt(settings.entryWei), ttlSec: term * 86_400, nowMs: now });
  const stockCount = settings.portfolioTokens?.length ?? 0;
  const dcaMaxOrders = settings.dcaMaxOrders ?? 8;
  const gate = state?.facts == null ? null : agenticGate({ facts: state.facts, ...(state.walletAddress === null ? {} : { wallet: state.walletAddress }), capitalQuoteWei: capitalWei,
    entryWei, maxOpenPositions, termSec: term * 86_400, nowMs: now, budgetWei, ...(meme ? { meme: "paper" as const } : {}), ...(earnOn ? { earn: true as const } : {}),
    ...(scheduleInput === undefined ? {} : { quoteDayCapWei: capitalWei, schedule: scheduleInput }), ...(portfolio ? { portfolio: { tokenCount: stockCount } } : {}), ...(dca ? { dca: { maxOrders: dcaMaxOrders } } : {}) });
  const need = { USDT: capitalWei + budgetWei, BNB: BigInt(dca ? agenticDcaBnbSlots(dcaMaxOrders) : portfolio ? 2 * stockCount + 2 : settings.maxOpenPositions + 2 + (buys === null ? 0 : Math.min(buys.plannedBuys, buys.buysThisSession))) * BNB_PER_SLOT_WEI + (earnOn ? 2n * BNB_PER_SLOT_WEI : 0n) } as const;
  const have = (asset: "USDT" | "BNB"): bigint | null => {
    const raw = asset === "USDT" ? state?.facts?.usdtWei : state?.facts?.bnbWei;
    return raw !== undefined && /^\d+$/.test(raw) ? BigInt(raw) : null;
  };
  const deficit = (asset: "USDT" | "BNB"): bigint => { const value = have(asset); return value === null ? 0n : need[asset] - value; };
  // A paper meme hire needs no funding (9.1): no USDT and no BNB.
  const funded = meme || (["USDT", "BNB"] as const).every(asset => { const value = have(asset); return value !== null && value >= need[asset]; });
  const wallet = state?.walletAddress ?? null;
  // On the funding step the balances re-read on their own every 10 s (the plane refreshes the two chain balances at that pace).
  React.useEffect(() => {
    if (step !== 3 || pairing === null || started !== null || terminal || funded) return;
    let active = true;
    const timer = setInterval(() => { void agenticRequest<AgenticPairing>(`pairings/${pairing.pairingId}/finalize`, {}).then(value => { if (active) { setState(value); setNow(Date.now()); } }).catch(() => undefined); }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [step, pairing, started, terminal, funded]);
  const refreshFacts = () => void run(async () => { setState(await agenticRequest(`pairings/${pairing!.pairingId}/finalize`, {})); setNow(Date.now()); });
  const startPairing = (thenStep?: number) => void run(async () => { setPairing(await agenticRequest("pairings", {})); if (thenStep !== undefined) setStep(thenStep); });
  const resetPairing = () => { setPairing(null); setState(null); setCode(""); setCodeMatched(false); setError(null); setGateFailures([]); setHireReason(null); setFunding(null); setCopied(false); setHireRunId(crypto.randomUUID()); setStep(2); };
  const chooseCustody = (value: "altana" | "agentic") => { setCustody(value); onCustody?.(value); };
  const deployBlocked = busy || action === null || !!blockedReason || gate === null || gate.rows.some(r => r.state === "FAIL");

  const next: { text: string; disabled: boolean; run(): void } = started !== null
    ? { text: "Observe your Agentic Wallet", disabled: false, run: () => go("/agentic/" + started.walletAddress) }
    : terminal && step >= 2 ? { text: "Start a new pairing", disabled: busy, run: resetPairing }
    : step === 0 ? { text: "Next", disabled: custody === null || (custody === "altana" && altanaBlockedReason !== null), run: () => (custody === "altana" ? onAltana() : setStep(1)) }
    : step === 1 ? { text: "Next", disabled: busy || action === null || !!blockedReason || meme && !memeSizingOk, run: () => (pairing === null ? startPairing(2) : setStep(2)) }
    : step === 2 ? pairing === null ? { text: "Pair in the Binance App", disabled: busy || action === null || !!blockedReason, run: () => startPairing() }
      : { text: "Finalize pairing", disabled: busy || (state?.state !== "verified" && state?.state !== "paired"),
        run: () => void run(async () => { setState(await agenticRequest(`pairings/${pairing.pairingId}/finalize`, {})); setNow(Date.now()); setStep(3); }) }
    : step === 3 ? { text: "Next", disabled: !funded, run: () => setStep(4) }
    : { text: meme ? "Deploy Agentic Meme stocks (paper)" : schedule ? "Deploy Agentic Schedule buy" : portfolio ? "Deploy Agentic Smart Portfolio" : dca ? "Deploy Agentic Auto DCA" : "Deploy Agentic AI Trade", disabled: deployBlocked, run: () => void run(async () => {
        const deployed = await agenticRequest<{ walletAddress: string; hireEndMs: number }>("hire", { pairingId: pairing!.pairingId, term, termEndAction: action, executionModel: "tradfi", hireRunId,
          settings: meme ? agenticMemeSettings(settings, { entryWei, maxOpenPositions, capitalQuoteWei: capitalWei }) : schedule || portfolio || dca ? settings : agenticHireSettings(settings, term), acceptedDedicatedWallet: true,
          ...(meme ? { strategy: "meme-stocks-paper" } : {}), ...(earnOn ? { earn: true } : {}) });
        // The agent is live: go straight to its read-only detail page (the Started panel stays as the fallback if navigation is slow).
        rememberAgenticWallet(deployed.walletAddress); setStarted(deployed); go("/agentic/" + deployed.walletAddress);
      }) };
  const back = started !== null || step === 0 ? { text: started !== null ? "Close" : "Cancel", run: onClose } : { text: "Back", run: () => setStep(step - 1) };

  return <div onClick={e => { if (e.target === e.currentTarget && funding === null) onClose(); }}
    style={{ position: "fixed", inset: 0, zIndex: 50, display: "grid", placeItems: "center", padding: 16, background: "rgba(6,8,10,0.62)", backdropFilter: "blur(3px)", fontWeight: 500 }}>
    <style>{"@keyframes flAwSpin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.fl-aw-spin{animation:none!important}}"}</style>
    <div role="dialog" aria-modal="true" aria-label={"Deploy " + agentLabel}
      style={{ width: "100%", maxWidth: 520, display: "grid", gap: 16, padding: 20, borderRadius: "var(--radius-md)", background: "var(--surface-card)", border: "1px solid var(--border-card)", boxShadow: "0 24px 60px rgba(0,0,0,0.45)" }}>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <span style={{ font: "var(--weight-semibold) var(--text-md)/1.2 var(--font-sans)", color: "var(--ink-1)" }}>{started !== null ? "Agent deployed" : "Deploy " + agentLabel}</span>
          <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{started !== null ? 5 : step + 1}/5</span>
        </div>
        <LinearProgress base={started !== null ? 1 : (step + 0.5) / 5} span={0} color={color} running={false} failed={false} />
        <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{started !== null ? "Started" : STEP_TITLES[step]}</span>
      </div>

      <div style={{ display: "grid", gap: 14, alignContent: "start", gridAutoRows: "max-content", maxHeight: "min(600px, 68vh)", overflowY: "auto", paddingRight: 2, paddingBottom: 1 }}>
        {started === null && step === 0 ? <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
          <ChoiceTile on={custody === "altana"} onClick={() => chooseCustody("altana")} note="Session key signed with your passkey.">
            <img src="/design/altana.png" alt="" style={{ height: 22, width: "auto", display: "block" }} />
            <span style={{ font: "var(--weight-semibold) var(--text-base)/1 var(--font-sans)", color: "var(--ink-1)", letterSpacing: "-0.01em" }}>Altana</span>
          </ChoiceTile>
          <ChoiceTile on={custody === "agentic"} onClick={() => chooseCustody("agentic")} color={GOLD} note="Pair once in the Binance Web 3 Wallet.">
            <AgenticWalletBadge />
          </ChoiceTile>
        </div> : null}
        {started === null && step === 0 && custody === "altana" && altanaBlockedReason !== null ? <p role="alert" style={{ ...body, color: "var(--loss)" }}>{altanaBlockedReason}</p> : null}

        {started === null && step === 1 ? <>
          <div style={{ display: "grid", gap: 10 }}>
            <span className="fl-field__label">Term</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
              <OptionCard on={term === 7} onClick={() => setTerm(7)} title="7 days" />
              <OptionCard on={term === 30} onClick={() => setTerm(30)} title="30 days" />
            </div>
          </div>
          {agenticMemeEnabled && !schedule && !portfolio && !dca ? <div style={{ display: "grid", gap: 10 }}>
            <span className="fl-field__label">Strategy</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
              <OptionCard on={strategy === "stocks"} onClick={() => chooseStrategy("stocks")} title="Stocks" />
              <OptionCard on={strategy === "meme"} onClick={() => chooseStrategy("meme")} title="Meme stocks (paper)" />
            </div>
          </div> : null}
          {meme ? <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10 }}>
              {([["entryUsdt", "Per trade (USDT)", 10, 50], ["maxOpenPositions", "Max open", 1, 3], ["capitalUsdt", "Capital (USDT)", 10, 150]] as const).map(([key, title, min, max]) =>
                <label key={key} style={{ display: "grid", gap: 6 }}><span className="fl-field__label">{title}</span>
                  <input type="number" aria-label={title} min={min} max={max} step={1} value={memeSizing[key]}
                    onChange={e => setMemeSizing({ ...memeSizing, [key]: Number(e.target.value) })} style={{ ...sunken, padding: "8px 10px", color: "var(--ink-1)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)" }} /></label>)}
            </div>
            <span style={mono}>Models: {settings.primaryModel} · fallback {settings.fallbackModel}</span>
            {memeSizingOk ? null : <p role="alert" style={{ ...body, color: "var(--loss)" }}>Per trade 10 to 50 USDT, max open 1 to 3, capital at least max open x per trade.</p>}
            <p style={body}>{AGENTIC_MEME_COPY.paper}</p>
            <p style={{ ...body, color: "var(--ink-1)" }}>{AGENTIC_MEME_COPY.law1}</p>
          </> : buys !== null ? <p style={{ ...body, color: "var(--ink-1)" }}>Your {term}-day term covers up to {buys.buysThisSession} buys; {buys.plannedBuys} are planned.</p> : <>
            <div style={{ ...sunken, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 12px" }}>
              <Icon name="key" size={14} />
              <span style={{ ...body, color: "var(--ink-1)" }}>{dca ? AGENTIC_DCA_COPY.keepAlive : "CMC Agent Hub x402 is required and locked on."}</span>
              <span style={{ ...mono, marginLeft: "auto" }}>Total budget <b style={{ color: "var(--ink-1)" }}>{portfolio || dca ? agenticUiString(budgetWei) : term === 7 ? "2" : "8"} USDT</b></span>
            </div>
            {dca ? <>
              <p style={body}>{AGENTIC_DCA_COPY.orders(agenticDcaResting(dcaMaxOrders))}</p>
              <p style={body}>{AGENTIC_DCA_COPY.stops}</p>
              <p style={body}>{AGENTIC_DCA_COPY.signOut}</p>
              <p style={body}>{AGENTIC_DCA_COPY.fills}</p>
            </> : portfolio ? <>
              <p style={body}>Used only to keep the Binance session active after 12 hours without a trade. Keep the x402 daily limit at 0.50 USDT or more: below it the agent pauses all trading until you raise it.</p>
              <p style={body}>This agent holds {(settings.portfolioTokens ?? []).map((token, index) => `${portfolioSymbols?.[index] ?? token} ${(settings.portfolioWeightsBps?.[index] ?? 0) / 100} %`).join(", ")} and rebalances when a weight drifts {(settings.portfolioDriftBps ?? 0) / 100} % from target, checked every {PORTFOLIO_INTERVALS[settings.portfolioIntervalSec ?? 86400]}.</p>
            </> : <div style={{ display: "grid", gap: 10 }}>
              <span className="fl-field__label">At term end</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
                <OptionCard on={action === "sell-all"} onClick={() => setAction("sell-all")} title="Sell all to USDT at term end" />
                <OptionCard on={action === "keep"} onClick={() => setAction("keep")} title="Keep holdings at term end" />
              </div>
            </div>}
          </>}
          {earnOffered ? <div style={{ display: "grid", gap: 10 }}>
            <label style={{ ...sunken, display: "flex", gap: 10, alignItems: "center", padding: "10px 12px", cursor: "pointer" }}>
              <input type="checkbox" checked={earn} onChange={e => setEarn(e.target.checked)} aria-label={AGENTIC_EARN_COPY.label} />
              <span style={label}>{AGENTIC_EARN_COPY.label}</span>
            </label>
            {earn ? <EarnDisclosure mode={dca ? "dca" : schedule ? "schedule" : "ai"} estimate={dca
              ? agenticEarnEstimate({ mode: "dca", capitalWei, baseWei: entryWei, orderWei: BigInt(settings.dcaOrderWei ?? "0"), maxOrders: dcaMaxOrders })
              : schedule && buys !== null ? agenticEarnEstimate({ mode: "schedule", capitalWei, entryWei, intervalSec: settings.scheduleIntervalSec!, plannedBuys: buys.plannedBuys, buysThisSession: buys.buysThisSession })
              : agenticEarnEstimate({ mode: "ai", capitalWei, entryWei, maxOpenPositions })} /> : null}
          </div> : null}
        </> : null}

        {started === null && step === 2 && pairing !== null && !terminal ? <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ width: 168, flex: "0 0 auto" }}><PairingQr urlForWeb={pairing.urlForWeb} size={168} /></div>
          <div style={{ display: "grid", gap: 12, flex: "1 1 220px", minWidth: 0 }}>
            <p style={{ ...body, color: "var(--ink-1)" }}>Scan the QR with the Binance App and tap Confirm, then type the 6-character code the App shows.</p>
            <span style={mono}>QR expires {clock(pairing.expireAtMs)} · Attempts left: {state?.codeAttemptsLeft ?? 5}</span>
            <div style={{ display: "grid", gap: 8 }}>
              <span className="fl-field__label">App code</span>
              <CodeCells value={code} onChange={setCode} disabled={codeMatched} />
            </div>
            <div><Button variant="secondary" disabled={busy || codeMatched || !/^[0-9a-f]{6}$/i.test(code.replace(/ /g, ""))}
              onClick={() => void run(async () => { setState(await agenticRequest(`pairings/${pairing.pairingId}/code`, { code })); setCodeMatched(true); })}>Check code</Button></div>
            {codeMatched ? <span role="status" style={{ display: "flex", alignItems: "center", gap: 7, ...body, color: "var(--profit)" }}><Icon name="success" size={14} />Code matched. Finalize pairing to continue.</span> : null}
          </div>
        </div> : null}
        {started === null && step === 2 && pairing === null && !busy ? <p style={body}>Start a pairing to get a QR for the Binance App.</p> : null}

        {started === null && step === 3 && !terminal && wallet !== null ? <>
          <section aria-label="Verified Agentic Wallet" style={{ display: "grid", gap: 8 }}>
            <span style={label}>Agentic Wallet Address</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <code style={{ ...mono, color: "var(--ink-1)", padding: "5px 8px", border: "1px solid var(--line-1)", borderRadius: 4, overflowWrap: "anywhere" }}>{wallet}</code>
              <Button variant="ghost" size="sm" icon={<Icon name="copy" size={13} />}
                onClick={() => void navigator.clipboard.writeText(wallet).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? "Address copied" : "Copy"}</Button>
            </div>
          </section>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["USDT", "BNB"] as const).filter(asset => !meme && deficit(asset) > 0n).map(asset =>
              <Button key={asset} variant="secondary" size="sm" icon={<Icon name="wallet" size={13} />} onClick={() => setFunding({ asset, amount: deficit(asset) })}>Send {asset} from extension wallet</Button>)}
            <Button variant="secondary" size="sm" icon={<Icon name="refresh" size={13} />} disabled={busy} onClick={refreshFacts}>Check Funds</Button>
          </div>
          {meme ? <p role="status" style={{ ...body, color: "var(--ink-1)" }}>{AGENTIC_MEME_COPY.noFunding}</p> : <div style={sunken}>
            <FundRow asset="USDT" have={have("USDT")} need={need.USDT} first />
            <FundRow asset="BNB" have={have("BNB")} need={need.BNB} first={false} />
          </div>}
          {funding !== null ? <AgenticFunding wallet={wallet} asset={funding.asset} amount={funding.amount} close={() => setFunding(null)} onSent={() => setDepositSent(true)} /> : null}
          {depositSent && !funded ? <span role="status" style={{ display: "flex", alignItems: "center", gap: 7, ...body }}><Spinner />Deposit sent. Waiting for it to land in the Agentic Wallet.</span> : null}
          <span style={mono}>Send funds from any wallet, exchange or extension wallet. Checks read {state?.facts ? clock(state.facts.balancesAtMs ?? state.facts.readAtMs) : "time unavailable"}; balances refresh every 10 seconds.</span>
        </> : null}

        {started === null && step === 4 && !terminal && gate !== null ? <>
          <GateList rows={gate.rows} ariaLabel="Binance checks" />
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={mono}>Checks read {state?.facts ? new Date(state.facts.readAtMs).toISOString() : "time unavailable"}; checks can refresh once a minute.</span>
            <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} disabled={busy} onClick={refreshFacts}>Refresh checks</Button>
          </div>
          <p style={{ ...body, fontSize: "var(--text-xs)", color: "var(--text-subtle)" }}>Preview end if you deploy now: <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-1)" }}>{new Date(gate.hireEndMs).toISOString()}</span>. The stored end uses the acceptance time and may differ by a few seconds.</p>
        </> : null}

        {started === null && terminal ? <p role="status" style={{ ...body, color: "var(--ink-1)", display: "flex", gap: 8, alignItems: "center" }}><Icon name="warning" size={14} />This pairing has ended. Start a new pairing to continue.</p> : null}
        {started === null && gateFailures.length > 0 ? <GateList rows={gateFailures} ariaLabel="Deployment gate fixes" /> : null}
        {started === null && terminal && gateFailures.length === 0 && gate !== null ? <GateList rows={gate.rows} ariaLabel="Deployment gate fixes" /> : null}

        {started !== null ? <div style={{ display: "grid", gap: 10 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, ...label, color: "var(--profit)" }}><Icon name="success" size={16} />Started</span>
          <p style={body}>Hire ends <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-1)" }}>{new Date(started.hireEndMs).toISOString()}</span>.</p>
        </div> : null}

        {started === null ? <>
          {hireReason ? <p role="alert" style={{ ...body, color: "var(--loss)" }}>{new AgenticRequestError(hireReason).message}</p> : null}
          {blockedReason ? <p role="alert" style={{ ...body, color: "var(--loss)" }}>{blockedReason}</p> : null}
          {error ? <p role="alert" style={{ ...body, color: "var(--loss)" }}>{error}</p> : null}
          {state?.failure ? <p role="alert" style={{ ...body, color: "var(--loss)" }}>{new AgenticRequestError(state.failure).message}</p> : null}
        </> : null}
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" style={outlineBtn("var(--line-1)")} onClick={back.run}><span style={{ color: "var(--ink-1)" }}>{back.text}</span></button>
        <button type="button" disabled={next.disabled} style={solidBtn(color, next.disabled)} onClick={next.disabled ? undefined : next.run}>{next.text}</button>
      </div>
    </div>
  </div>;
}
