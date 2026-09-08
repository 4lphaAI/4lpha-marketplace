"use client";

/**
 * The lending guard's detail page, ported onto the operator's mock-up.
 *
 * Everything here is sourced or dashed. The health factor is the LIQUIDATION
 * basis the trigger acts on, the reserve is priced from the PROTOCOL oracle the
 * guard decides against, and a stale worker snapshot renders the account half
 * from the BFF's live read LABELLED as such (R2.18) while every guard tile stays
 * dashed with the staleness reason.
 *
 * Three owner actions live here: `lendingSettings` (Edit — wired, hidden by
 * default), `lendingRetire` (Retire reserve — whose HTTP 200 is NOT "retired"),
 * and the passkey-only recovery, which needs no session and no server at all.
 *
 * ── WHAT THE MOCK-UP ASKED FOR AND THIS PAGE REFUSES ────────────────────────
 * The mock's shell carried a `ChartFrame title="Health factor"` over a `series`
 * array. THERE IS NO SUCH SERIES: the observation table keeps ONE row per agent
 * and overwrites it every cycle, so a health-factor chart would be drawn from
 * numbers nobody stored. It is not rendered, and the run log says so in the one
 * live line it does have. The mock's "Triggered by a N% drop in BNB",
 * "Checked your Venus position" and "N USDT of collateral placed under watch"
 * timeline rows are absent for the same reason — no cause, no price history, no
 * per-cycle check history and no collateral-at-hire figure is stored anywhere.
 */
import * as React from "react";
import { Button, Category, Checkbox, Icon, Input, MetricTile, PermissionItem, SegmentedToggle, StatusBadge } from "@/design-system";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { HireRecoveryActions } from "@/components/deploy/HireRecoveryActions";
import { TokenIcon } from "@/components/TokenIcon";
import { freshWbnbPriceMicros, relativeTime, type AgentDetailView, type DetailMetric } from "@/lib/exec/agent-detail";
import { WBNB_56 } from "@/lib/exec/pairs";
import type { UseAgentDetailResult } from "@/lib/exec/use-agent-detail";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import {
  INVALID,
  LENDING_ACTIONS,
  LENDING_LIVE_ACCOUNT_LABEL,
  lendingRetireOutcomeText,
  parseLendingConfig,
  parseLendingQuote,
  parseLendingRetireOutcome,
  type LendingAgentView,
  type LendingConfigView,
  type LendingMarketView,
  type LendingRescueView,
} from "@/lib/exec/lending-types";
import {
  LENDING_NO_LOCK_IN_COPY,
  LENDING_RESCUE_COUNT_HINT,
  buildLendingForm,
  formatAtomicAmount,
  formatHf,
  usdtDecimalsFrom,
} from "@/lib/lending/form";
import {
  LENDING_PARTIAL_COPY,
  lendingAccountSource,
  lendingBases,
  lendingConditionCopy,
  lendingConditionTone,
  lendingCoverageMetric,
  lendingEffectColor,
  lendingEffectCopy,
  lendingHealth,
  lendingRecoveryOffered,
  lendingRemoveGate,
  lendingRepaidMetric,
  lendingReserveMetric,
  lendingTimeline,
  shortAddress,
  unavailable,
  type LendingBasisCell,
  type LendingTimelineEvent,
} from "@/lib/lending/detail";
import {
  LENDING_LEAKED_KEY_SENTENCE,
  LENDING_MAX_SESSION_DAYS,
  LENDING_USDT_CAP_LABEL,
  LENDING_USDT_CAP_NOTE,
  lendingCapExposure,
  lendingGrantAllows,
  lendingGrantDenies,
  parseSessionGrant,
  type SessionGrantView,
} from "@/lib/lending/permissions";
import {
  buildLendingRecoveryBatch,
  planLendingRecovery,
  readLendingReserve,
  type LendingReserveRead,
} from "@/lib/altana/lending-recovery";
import { recoverLendingReserveWithPasskey } from "@/lib/altana/client";

const LENDING_HIRE_STORAGE_KEY = "4lpha:lending-hire:v1";
const E18 = 10n ** 18n;

/* -------------------------------------------------------------------------- */
/* The mock-up's shell, ported                                                */
/* -------------------------------------------------------------------------- */

const mono: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1.35 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.04em" };
const label: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.06em", textTransform: "uppercase" };
const val: React.CSSProperties = { font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-mono)", color: "var(--ink-1)" };
const bodyText: React.CSSProperties = { font: "var(--weight-regular) var(--text-sm)/1.3 var(--font-sans)", color: "var(--text-muted)" };

/** Nothing is invented: every unsourced cell renders a dash and says why. */
function Dash({ reason, align = "start" }: { readonly reason: string; readonly align?: "start" | "end" }) {
  return <span style={{ display: "grid", gap: 4, justifyItems: align }}>
    <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--text-subtle)" }}>—</span>
    <span style={{ ...mono, textAlign: align === "end" ? "right" : "left" }}>{reason}</span>
  </span>;
}

function Panel({ title, right, children, fill, testId }: {
  readonly title?: string;
  readonly right?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly fill?: boolean;
  readonly testId?: string;
}) {
  return <section
    data-testid={testId}
    style={{
      border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)",
      background: "var(--surface-card)", overflow: "hidden",
      display: fill ? "flex" : "block", flexDirection: "column", height: fill ? "100%" : undefined,
    }}>
    {title === undefined ? null : <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line-1)", flexWrap: "wrap" }}>
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{title}</span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>{right}</span>
    </header>}
    {children}
  </section>;
}

function tile(labelText: string, metric: DetailMetric, showNote = false) {
  return <MetricTile
    key={labelText}
    label={labelText}
    title={metric.value === null ? metric.reason?.replace(/^—\s*/u, "") ?? "source unavailable" : metric.note}
    value={metric.value ?? "—"}
    note={metric.value === null ? metric.reason ?? undefined : showNote ? metric.note : undefined} />;
}

function txLink(hash: string | null | undefined) {
  return hash ? <a href={`https://bscscan.com/tx/${hash}`} target="_blank" rel="noreferrer" className="fl-btn fl-btn--ghost fl-btn--sm" style={{ gap: 5, textDecoration: "none" }}>Tx <Icon name="external" size={12} /></a> : null;
}

/**
 * A signed BNB ceiling back in dollars, for the Edit panel's one "$" control
 * when the guard repays BNB and nothing else (W3). `null` price ⇒ "", and the
 * panel renders the ceiling read-only with its reason instead.
 */
function nativeCeilingUsd(nativeWei: bigint | null, priceMicros: bigint | null): string {
  if (nativeWei === null || nativeWei <= 0n || priceMicros === null || priceMicros <= 0n) return "";
  const microUsd = (nativeWei * priceMicros) / 10n ** 18n;
  const whole = microUsd / 1_000_000n;
  const cents = ((microUsd % 1_000_000n) / 10_000n).toString().padStart(2, "0");
  return `${whole}.${cents}`;
}

function countdown(expiresAt: number | null, nowMs: number): string {
  if (expiresAt === null) return "—";
  const seconds = expiresAt - Math.floor(nowMs / 1_000);
  if (seconds <= 0) return "expired";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** `1.62` ⇒ `+62.0%` above the liquidation line. Exact, from the mantissa. */
function distanceToLiquidation(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const bps = ((BigInt(raw) - E18) * 10_000n) / E18;
    const percent = Number(bps) / 100;
    return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
  } catch {
    return null;
  }
}

function hfNumber(mantissa: string | null | undefined): number | null {
  if (mantissa === null || mantissa === undefined) return null;
  try {
    return Number((BigInt(mantissa) * 10_000n) / E18) / 10_000;
  } catch {
    return null;
  }
}

/**
 * The venue config, cached for the outage the recovery exists for (W2).
 *
 * `GET /api/lending/config` is a PERIMETER READ of the execution plane, so in
 * the very case §6.2's "no server, no session, no plane" recovery is for, it is
 * the first thing to go — and without `vUsdt`/`usdt`/`routerV3` the browser
 * cannot build the batch at all. These are venue ADDRESSES on chain 56; they do
 * not move. So one successful read is remembered and reused when the live read
 * fails, LABELLED as remembered.
 *
 * FIXREVIEW F9 — the key carries the ORIGIN it was read from, so one browser
 * pointed at two deployments cannot recover against the wrong venue.
 */
function lendingConfigCacheKey(): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `4lpha:lending-config:v1:${origin}`;
}

function cacheLendingConfig(value: LendingConfigView): void {
  try {
    window.localStorage.setItem(lendingConfigCacheKey(), JSON.stringify(value));
  } catch {
    /* private window, or site data blocked — the live read still works */
  }
}

function cachedLendingConfig(): LendingConfigView | null {
  try {
    const raw = window.localStorage.getItem(lendingConfigCacheKey());
    if (raw === null) return null;
    const parsed = parseLendingConfig(JSON.parse(raw) as unknown);
    return parsed === INVALID ? null : parsed;
  } catch {
    return null;
  }
}

export type LendingAgentDetailProps = {
  readonly identityStatus?: React.ReactNode;
  readonly agentId: string;
  readonly go: (route: string) => void;
  readonly detail: UseAgentDetailResult;
  readonly view: AgentDetailView | null;
  readonly busy: boolean;
  readonly message: string;
  readonly actionsDisabled: boolean;
  /**
   * Show the Edit control. DEFAULT FALSE (operator decision 2026-09-07): the
   * settings panel is wired and `lendingSettings` is accepted by the plane,
   * but the entry point stays hidden until the redesigned panel lands. The
   * tests pass it so the panel's own pricing rules (W3 / AUDIT G-M3) keep
   * their coverage while the button is out of the product.
   */
  readonly showEdit?: boolean;
  readonly removeDisabled: boolean;
  readonly removeTitle?: string;
  readonly removeLabel: string;
  readonly removeCallsId?: string;
  readonly removeTransactionHash?: string;
  readonly signedOut: boolean;
  readonly onTogglePause: () => void;
  readonly onRemove: () => void;
};

type Tab = "Overview" | "Run log" | "Permissions";

export function LendingAgentDetail(props: LendingAgentDetailProps) {
  const { detail, view } = props;
  const owner = useOwnerActions();
  const publicClient = usePublicClient();
  const cat = Category("health");
  const [tab, setTab] = React.useState<Tab>("Overview");
  const [now, setNow] = React.useState(Date.now());
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [leaveRemainder, setLeaveRemainder] = React.useState(false);
  const [poolShort, setPoolShort] = React.useState(false);
  const [config, setConfig] = React.useState<LendingConfigView | null>(null);
  const [configReason, setConfigReason] = React.useState<string | null>(null);
  const [wbnbMicros, setWbnbMicros] = React.useState<bigint | null>(null);
  const [icons, setIcons] = React.useState<Record<string, string | null>>({});
  const [grant, setGrant] = React.useState<SessionGrantView | null>(null);
  const [grantReason, setGrantReason] = React.useState<string | null>(null);

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    // W2: the venue is REMEMBERED on success (see `recover`), but a failed read
    // still dashes every tile — the cache authorises building a recovery batch
    // out of addresses that do not move, never pricing a reserve from a venue
    // this page could not read now.
    const fallback = (reason: string): void => {
      if (controller.signal.aborted) return;
      setConfig(null);
      setConfigReason(reason);
    };
    void fetch("/api/lending/config", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { data?: unknown };
        if (controller.signal.aborted) return;
        if (!response.ok) { fallback("the lending venue could not be read"); return; }
        const parsed = parseLendingConfig(payload.data);
        if (parsed === INVALID) { fallback("the lending venue read could not be mapped"); return; }
        setConfig(parsed);
        setConfigReason(null);
        cacheLendingConfig(parsed);
      })
      .catch(() => fallback("the lending venue could not be read"));
    return () => controller.abort();
  }, []);

  // W3 / AUDIT G-M3: the Edit panel's "$" field must be able to move the BNB
  // leg of a vBNB-pinned guard, and that needs the SAME fresh price the deploy
  // form converts with (`freshWbnbPriceMicros` returns null past 60 s). When it
  // is not fresh, the ceiling is shown read-only with its reason rather than
  // silently re-signed at whatever was there before.
  React.useEffect(() => {
    let alive = true;
    const load = () => {
      void fetch(`/api/market-data/tokens/${WBNB_56}`, { cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<unknown> : null)
        .then((payload) => { if (alive) setWbnbMicros(payload === null ? null : freshWbnbPriceMicros(payload)); })
        .catch(() => { if (alive) setWbnbMicros(null); });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const lending = detail.lending;
  const mapped: LendingAgentView | null = lending === null || lending === INVALID ? null : lending;
  const mapFailed = lending === INVALID;

  /* ---- provisioning: the guard row does not exist yet -------------------- */

  if (view?.provisioning === true) {
    return <div className="fl-shell fl-hired-agent-page">
      <Button variant="ghost" size="sm" onClick={() => props.go("/account")}>My agents</Button>
      <h1 style={{ font: "var(--type-page-title)", margin: "16px 0 8px" }}>{view.id}</h1>
      {props.identityStatus}
      <p role="status">{props.message}</p>
      <HireRecoveryActions
        agentId={props.agentId}
        readHeaders={detail.readHeaders}
        go={props.go}
        storageKey={LENDING_HIRE_STORAGE_KEY}
        deployPath="/deploy/lending" />
    </div>;
  }

  const guard = mapped?.guard ?? null;
  const payload = mapped?.snapshot.payload ?? null;
  const usdtDecimals = usdtDecimalsFrom(mapped?.liveAccount ?? null, config?.vUsdt ?? null);

  const health = mapped === null ? null : lendingHealth(mapped);
  const bases = mapped === null ? null : lendingBases(mapped);
  const account = mapped === null ? null : lendingAccountSource(mapped);
  const reserveMetric = payload === null
    ? unavailable(mapped === null
      ? mapFailed ? "the guard view could not be mapped by this page" : "the guard has not reported yet"
      : mapped.snapshot.reason ?? "the guard has not reported yet")
    : lendingReserveMetric({ payload, config, usdtDecimals });
  const coverageMetric = payload === null || guard === null
    ? unavailable(mapped?.snapshot.reason ?? "the guard has not reported yet")
    : lendingCoverageMetric({ payload, guard, config });
  const rescuesMetric: DetailMetric = payload === null
    ? unavailable(mapped?.snapshot.reason ?? "the guard has not reported yet")
    : {
      value: String(payload.usage.rescues),
      reason: null,
      note: payload.usage.lastRescueAtMs === null
        ? "none in the last 24 h"
        : `last ${relativeTime(payload.usage.lastRescueAtMs, now).text}`,
    };
  const budgetMetric: DetailMetric = guard === null
    ? unavailable("the guard row is not readable")
    : { value: `${formatAtomicAmount(guard.budgetWei, 18, 6)} BNB`, reason: null, note: "signed at hire — the BNB this guard was armed with" };
  const repaidMetric = mapped === null
    ? unavailable(mapFailed ? "the guard view could not be mapped by this page" : "the guard view is not readable")
    : lendingRepaidMetric({ rescues: mapped.rescues, config, usdtDecimals });
  const sessionMetric: DetailMetric = {
    value: mapped === null ? null : countdown(mapped.session.expiresAt, now),
    reason: mapped === null ? "the guard view is not readable" : null,
    note: LENDING_NO_LOCK_IN_COPY,
  };

  const conditions = payload?.conditions ?? [];
  const rescues = mapped?.rescues ?? [];
  const settings = mapped?.settings ?? null;

  /* ---- token icons for the market rows ----------------------------------- */

  // vBNB's `underlying` is NULL — BNB is native and has no ERC-20 row — so its
  // icon is resolved with WBNB's address. A miss is a symbol badge; it never
  // shifts the layout and never blocks a row.
  const iconAddresses = React.useMemo(() => {
    const markets = account?.markets ?? [];
    const wbnb = config?.wbnb ?? null;
    const seen: string[] = [];
    for (const market of markets) {
      const address = (market.underlying ?? wbnb)?.toLowerCase() ?? null;
      if (address !== null && !seen.includes(address)) seen.push(address);
    }
    return seen.slice(0, 8);
  }, [account?.markets, config?.wbnb]);
  const iconKey = iconAddresses.join(",");

  React.useEffect(() => {
    if (iconKey.length === 0) return;
    const controller = new AbortController();
    void fetch(`/api/token-icons?addresses=${iconKey}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ data?: Record<string, string | null> }> : null)
      .then((payloadBody) => {
        if (!controller.signal.aborted && payloadBody !== null) setIcons(payloadBody.data ?? {});
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [iconKey]);

  /* ---- the session grant, read only when the tab asks for it ------------- */

  React.useEffect(() => {
    if (tab !== "Permissions") return;
    const controller = new AbortController();
    void fetch(`/api/agents/${encodeURIComponent(props.agentId)}/session`, {
      cache: "no-store", signal: controller.signal, headers: detail.readHeaders,
    })
      .then(async (response) => {
        const payloadBody = await response.json() as unknown;
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setGrant(null);
          setGrantReason("the session grant could not be read from the execution plane");
          return;
        }
        const parsed = parseSessionGrant(payloadBody);
        if (parsed === INVALID) {
          setGrant(null);
          setGrantReason("no live session grant is recorded for this agent yet");
          return;
        }
        setGrant(parsed);
        setGrantReason(null);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setGrant(null);
        setGrantReason("the session grant could not be read from the execution plane");
      });
    return () => controller.abort();
  }, [tab, props.agentId, detail.readHeaders]);

  /* ---- the BNB leg of the Edit panel (W3) -------------------------------- */

  // A native `maxPerAction` entry IS the vBNB pin: the hire only writes one when
  // vBNB is a pinned debt market, and reading it from the signed settings needs
  // no venue config, so it survives a config read this page could not make.
  const signedNativeCap = settings?.maxPerAction.find((cap) => cap.token === null) ?? null;
  const signedNativeCeilingWei = signedNativeCap === null ? null : BigInt(signedNativeCap.maxWei);
  const bnbPinned = signedNativeCeilingWei !== null;
  /** Fresh price ⇒ the "$" field prices the BNB leg too; else it is read-only. */
  const bnbCeilingEditable = wbnbMicros !== null;
  const usdtCapPinned = settings?.maxPerAction.some((cap) => cap.token !== null) ?? false;
  /**
   * A BNB-ONLY guard with no fresh price has nothing this panel can re-price:
   * the one "$" control maps to the BNB leg alone, and that leg is read-only.
   * Say so on the Save button instead of letting the shared builder refuse with
   * "Max repay per event must be a dollar amount greater than zero", which is
   * true of the empty field but says nothing about why it is empty.
   */
  const editBlockedReason = bnbPinned && !usdtCapPinned && !bnbCeilingEditable
    ? "The BNB price is not fresh, and this guard repays BNB only — nothing here can be re-priced right now. Try again once the price refreshes."
    : null;
  // Read inside the form-init effect WITHOUT being one of its dependencies: the
  // 30 s price refresh must never reset a field the owner is typing into.
  const priceMicros = React.useRef<bigint | null>(null);
  priceMicros.current = wbnbMicros;

  // A pool-short retire is known from EITHER the retire's own outcome (this
  // session) or the condition the worker recorded (a reload).
  const poolCashShort = poolShort
    || conditions.some((entry) => entry.condition === "pool-cash-short");
  const removeGate = guard === null
    ? { allowed: false, reason: "the guard row is not readable" }
    : lendingRemoveGate({ guard, poolShort: poolCashShort, leaveRemainderAccepted: leaveRemainder });

  // W2 / AUDIT G-M2: the recovery door may not be gated on plane-sourced state.
  // §6.2 offers it for "no server, no session, no plane" — and on a COLD load
  // during an outage there IS no guard row, because the guard row comes from the
  // plane. `execution-unavailable` alone therefore opens it, with the wallet
  // address taken from the passkey record the recovery signs with.
  const planeUnreachable = detail.state === "execution-unavailable";
  const recoveryOffered = guard === null
    ? planeUnreachable
    : lendingRecoveryOffered({
      guard,
      sessionExpiresAt: mapped?.session.expiresAt ?? null,
      agentStatus: view?.status ?? null,
      planeUnreachable,
      nowSec: Math.floor(now / 1_000),
    });

  /* ---- owner actions ----------------------------------------------------- */

  const post = async (action: string, params: unknown, suffix: string): Promise<unknown> => {
    const envelope = await owner.signEnvelope(action, props.agentId, params);
    const response = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/lending/${suffix}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
    });
    const payloadBody = await response.json() as { data?: unknown; error?: { code?: string; message?: string } };
    if (!response.ok) {
      throw new Error(payloadBody.error?.message ?? payloadBody.error?.code ?? `HTTP ${response.status}`);
    }
    return payloadBody;
  };

  const retire = async (acceptPartial: boolean) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const body = await post(LENDING_ACTIONS.retire, acceptPartial ? { acceptPartial: true } : {}, "retire");
      const data = (body as { data?: Record<string, unknown> }).data;
      if (data?.["replayed"] === true) {
        // L9: a replay carries no outcome. Re-read the view; claim nothing.
        await detail.refreshLending();
        setNotice("This retire was already submitted. The guard below is re-read from the plane.");
        return;
      }
      const outcome = parseLendingRetireOutcome(body);
      setNotice(lendingRetireOutcomeText(outcome));
      if (outcome !== INVALID) setPoolShort(outcome.poolShort);
      await detail.refreshLending();
    } catch (error) {
      const text = error instanceof Error ? error.message : "The retire could not be submitted.";
      // The plane refuses a pool-short retire unless the owner has DECLARED the
      // choice to leave the remainder supplied. Surface the choice, not a dead
      // end (R3.12).
      if (/pool-cash-short/u.test(text)) setPoolShort(true);
      setNotice(text);
    } finally {
      setBusy(false);
    }
  };

  const [form, setForm] = React.useState<{ trigger: string; target: string; maxRepay: string; count: string; cooldown: string } | null>(null);
  React.useEffect(() => {
    if (!editing || settings === null || config === null) return;
    const usdtCap = settings.maxPerAction.find(
      (cap) => cap.token !== null && cap.token.toLowerCase() === config.usdt.toLowerCase(),
    );
    setForm({
      trigger: formatHf(settings.triggerHf),
      target: formatHf(settings.targetHf),
      // W3: a vBNB-ONLY guard has no USDT cap, and an EMPTY "$" field on a
      // control the owner is being asked to re-sign is worse than useless. The
      // signed BNB ceiling is converted back through the fresh price; with no
      // fresh price the field stays empty and the read-only line below says why.
      maxRepay: usdtCap !== undefined
        ? formatAtomicAmount(usdtCap.maxWei, usdtDecimals, 2)
        : nativeCeilingUsd(signedNativeCeilingWei, priceMicros.current),
      count: String(settings.rescueReserveCount),
      cooldown: String(settings.minSecondsBetweenActions),
    });
  }, [editing, settings, config, usdtDecimals, signedNativeCeilingWei]);

  const saveSettings = async () => {
    if (busy || form === null || config === null || guard === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const nativeCeilingWei = signedNativeCeilingWei;
      // Rebuilt through the SAME builder the hire signs with, so the bounds and
      // the wei conversion cannot drift between the two surfaces.
      const built = buildLendingForm({
        triggerHf: form.trigger,
        targetHf: form.target,
        maxRepayUsd: form.maxRepay,
        rescueReserveCount: Number(form.count),
        cooldownSeconds: Number(form.cooldown),
        // `reserveBps` is applied ONCE at the arm and is not a setting; the
        // guard row's value is passed only so the shared builder's bound check
        // has something legal to look at.
        reserveBps: guard.reserveBps,
        debtMarkets: guard.debtMarkets,
        vUsdt: config.vUsdt,
        vBnb: config.vBnb,
        usdt: config.usdt,
        usdtDecimals,
        // W3: with a FRESH price the "$" field prices the BNB leg exactly as
        // the deploy form does, so the control the owner moves is the control
        // that moves. Without one, the ceiling they already signed is reused
        // verbatim — and the panel says so, read-only, beside the field.
        wbnbPriceMicros: bnbCeilingEditable ? wbnbMicros : null,
        ...(bnbCeilingEditable || nativeCeilingWei === null
          ? {}
          : { existingNativeMaxWei: nativeCeilingWei }),
      });
      if (!built.ok) throw new Error(built.message);
      await post(LENDING_ACTIONS.settings, built.settings, "settings");
      setEditing(false);
      setNotice("Settings replaced. The confirmation counter is invalidated: the next breach needs two fresh observations one worker interval apart.");
      await detail.refreshLending();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const recover = async () => {
    // No `guard === null` gate: during a plane outage there is no guard row, and
    // that is precisely when this path is the owner's only door (W2).
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (owner.passkey === null) throw new Error("Recovery needs your passkey. Sign in with it first.");
      // The live venue, else the one remembered from a successful read. Venue
      // addresses on chain 56 do not move; the plane being down does not change
      // where vUSDT is.
      const venue = config ?? cachedLendingConfig();
      if (venue === null) {
        throw new Error(`${configReason ?? "The lending venue could not be read"}, and no venue was remembered from an earlier visit, so the recovery batch cannot be built here.`);
      }
      if (publicClient === undefined) throw new Error("No chain reader is available in this browser.");
      // The plane names the wallet when it is reachable; otherwise the PASSKEY
      // RECORD does — it is the same wallet, and it is the credential that signs.
      const wallet = view?.walletAddress ?? owner.walletAddress;
      if (wallet === undefined) throw new Error("The agent wallet is not known.");
      const reading: LendingReserveRead = await readLendingReserve(publicClient, {
        wallet: wallet as Address,
        vUsdt: venue.vUsdt as Address,
        usdt: venue.usdt as Address,
        routerV3: venue.routerV3 as Address,
      });
      if (reading.kind !== "read") throw new Error(reading.reason);
      // W5 / AUDIT G-L2: the swap input comes from the PLAN, not from a
      // throwaway batch built with `minOutWei: 1n`.
      const plan = planLendingRecovery(reading);
      if (plan.swapInWei <= 0n) {
        throw new Error("There is nothing to recover: the wallet holds no idle USDT and the Venus pool can redeem nothing right now.");
      }
      // The floor comes off THE PLANE'S OWN RAIL (QuoterV2), never a price.
      const query = new URLSearchParams({
        tokenIn: venue.usdt, tokenOut: venue.wbnb,
        amountInWei: plan.swapInWei.toString(10),
      });
      const quoteResponse = await fetch(`/api/lending/quote?${query}`, { cache: "no-store" });
      const quotePayload = await quoteResponse.json() as { data?: unknown; error?: { message?: string; code?: string } };
      if (!quoteResponse.ok) {
        throw new Error(quotePayload.error?.message ?? quotePayload.error?.code ?? "The recovery swap could not be quoted.");
      }
      const quote = parseLendingQuote(quotePayload.data);
      if (quote === INVALID) throw new Error("The quote could not be mapped; refusing to swap without a floor.");
      const batch = buildLendingRecoveryBatch({
        reading, venue: {
          vUsdt: venue.vUsdt as Address, usdt: venue.usdt as Address,
          routerV3: venue.routerV3 as Address, wbnb: venue.wbnb as Address,
          swapFeeTier: venue.swapFeeTier,
        },
        wallet: wallet as Address,
        minOutWei: BigInt(quote.minOutWei),
        deadlineSec: BigInt(Math.floor(now / 1_000) + 300),
      });
      if (!batch.ok) throw new Error(batch.message);
      const result = await recoverLendingReserveWithPasskey({ record: owner.passkey, calls: batch.calls });
      // `execute` returns FAILED WITHOUT THROWING; a resolved promise is not a
      // success and this branch is what says so.
      setNotice(
        result.status === "CONFIRMED"
          ? `Recovery confirmed. ${batch.plan.poolShort ? `Venus could only redeem part of the supply — ${formatAtomicAmount(batch.plan.remainderUsdtWei, usdtDecimals, 2)} USDT stays supplied and can be recovered the same way later.` : "The reserve is back in the agent wallet as BNB."}`
          : result.status === "FAILED"
            ? `Recovery FAILED (relay call ${result.callsId}). Nothing moved.`
            : `Recovery submitted and still pending (relay call ${result.callsId}). Nothing here can confirm it yet.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The recovery could not be built.");
    } finally {
      setBusy(false);
    }
  };

  /* ---- render ------------------------------------------------------------ */

  const staleBanner = mapped !== null && mapped.snapshot.stale
    ? mapped.liveAccount !== undefined
      ? `The agent has not reported recently — ${mapped.snapshot.reason ?? "no fresh snapshot"}. The account figures below were ${LENDING_LIVE_ACCOUNT_LABEL}; the reserve, rescues and conditions stay dashed.`
      : `The agent has not reported recently — ${mapped.snapshot.reason ?? "no fresh snapshot"}. ${mapped.liveAccountReason === undefined ? "" : `A live read was not available either: ${mapped.liveAccountReason}.`}`
    : null;

  const timeline = mapped === null ? [] : lendingTimeline({ view: mapped, config, usdtDecimals });

  return <div className="fl-shell fl-hired-agent-page">
    <Button variant="ghost" size="sm" onClick={() => props.go("/account")}>My agents</Button>

    <div className="fl-hired-hero" style={{ display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap", margin: "16px 0 24px" }}>
      <div style={{ display: "flex", gap: 16 }}>
        <span className="fl-card__glyph" style={{ width: 44, height: 44, color: cat.color, background: cat.tint }}>
          <Icon name={cat.icon} size={22} />
        </span>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ font: "var(--type-page-title)" }}>{view?.id ?? props.agentId}</h1>
            <StatusBadge pill status={view?.status === "armed" ? "live" : "paused"} label={guard?.status ?? view?.status ?? "state unavailable"} />
          </div>

          {props.message ? <p role="status">{props.message}</p> : null}
          {notice !== null ? <p role="status" style={{ color: "var(--ink-1)", maxWidth: "70ch" }}>{notice}</p> : null}
          {configReason !== null ? <p role="alert" style={{ color: "var(--warn)" }}>— {configReason}</p> : null}
          {props.removeCallsId ? <p>Relay call {shortAddress(props.removeCallsId)} {txLink(props.removeTransactionHash)}</p> : null}
          {props.identityStatus}
        </div>
      </div>

      <div className="fl-hired-actions" style={{ display: "flex", gap: 8, alignItems: "start", flexWrap: "wrap" }}>
        {props.signedOut ? <Button onClick={() => void detail.signIn()}>Sign in to view</Button> : null}
        {/* EDIT IS HIDDEN BY DEFAULT — operator decision 2026-09-07,
            presentation only. The action is sound and stays wired: lending
            settings carry no owner text, so a full replacement cannot erase
            something the browser could not read back (the LP redaction rule
            does not bite here), and `lendingSettings` is a real owner action
            the route accepts. It is hidden until the redesigned panel lands.
            To bring it back, pass `showEdit` from `HiredAgentScreen`; the
            panel, its state and its handler below never changed, and the tests
            still drive them through the same prop. */}
        {props.showEdit === true ? (
          <Button variant="secondary" disabled={props.actionsDisabled || settings === null} title={settings === null ? "Settings are not readable for this guard yet." : undefined} onClick={() => setEditing((value) => !value)}>Edit</Button>
        ) : null}
        <Button variant="secondary" disabled={props.actionsDisabled || !["armed", "paused"].includes(view?.status ?? "")} onClick={props.onTogglePause}>
          {view?.status === "paused" ? "Resume" : "Pause"}
        </Button>
        <Button variant="secondary" disabled={busy || props.actionsDisabled || guard === null || !["armed", "held"].includes(guard.status)}
          title={guard === null ? undefined : !["armed", "held"].includes(guard.status) ? `Retire needs an armed or held guard; it is ${guard.status}.` : undefined}
          onClick={() => { if (window.confirm("Retire the reserve? Everything the Venus pool can pay is redeemed and swapped back to BNB in the agent wallet.")) void retire(false); }}>
          Retire reserve
        </Button>
        {recoveryOffered ? <Button variant="secondary" disabled={busy} onClick={() => { if (window.confirm("Recover the reserve with your passkey? This needs no session and no server.")) void recover(); }}>Recover with passkey</Button> : null}
        <Button variant="danger" disabled={props.removeDisabled || !removeGate.allowed} title={removeGate.reason ?? props.removeTitle} onClick={props.onRemove}>
          {props.removeLabel}
        </Button>
      </div>
    </div>

    {/* THE HOLD IS NOT A BADGE. A held guard is NOT rescuing, and that outranks
        every figure below it — so it is a banner above the tiles, in its own
        words, with the condition copy the plane's taxonomy already carries. */}
    {guard?.hold != null ? <div role="alert" data-testid="lending-hold" style={{
      display: "grid", gap: 6, padding: "14px 16px", marginBottom: 16,
      borderRadius: "var(--radius-sm)", border: "1px solid var(--loss)", background: "var(--surface-sunken)",
    }}>
      <strong style={{ color: "var(--loss)" }}>This guard is on hold and is NOT repaying: {guard.hold}</strong>
      <span style={bodyText}>{lendingConditionCopy(guard.hold)}</span>
    </div> : null}

    {staleBanner !== null ? <p role="alert" data-testid="lending-stale" style={{ marginBottom: 16, color: "var(--warn)" }}>{staleBanner}</p> : null}
    {mapFailed ? <p role="alert" style={{ marginBottom: 16, color: "var(--loss)" }}>
      The execution plane returned a lending view this page could not map. Every figure below is dashed rather than guessed.
    </p> : null}

    {poolCashShort ? <div data-testid="lending-pool-short" style={{ display: "grid", gap: 8, padding: 14, marginBottom: 16, borderRadius: "var(--radius-sm)", border: "1px solid var(--warn)", background: "var(--surface-sunken)" }}>
      <strong>Venus could not redeem the whole supply.</strong>
      <Checkbox checked={leaveRemainder} onChange={(next: boolean) => setLeaveRemainder(next)}>
        leave the remaining supply on Venus (recoverable with my passkey)
      </Checkbox>
      <div style={{ display: "flex", gap: 8 }}>
        <Button size="sm" variant="secondary" disabled={busy || !leaveRemainder} onClick={() => void retire(true)}>
          Retire what the pool can pay now
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retire(false)}>Try the full retire again</Button>
      </div>
    </div> : null}

    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(175px,1fr))", gap: 12, marginBottom: 20 }}>
      {tile("Reserve budget", budgetMetric, true)}
      {tile("Debt repaid to date", repaidMetric, true)}
      {tile("Health factor", health === null
        ? unavailable("the guard view is not readable")
        : { value: health.value, reason: health.reason, note: `liquidation basis · ${health.matchedNote}` }, true)}
      {tile("Repay capacity", reserveMetric, true)}
      {tile("Repays made", rescuesMetric, true)}
    </div>

    {editing && form !== null ? <div style={{ marginBottom: 20 }}><Panel>
      <div style={{ display: "grid", gap: 14, padding: 16 }}>
        <span className="fl-eyebrow">Edit guard settings</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 14 }}>
          <Input label="Act below health factor" mono value={form.trigger} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, trigger: event.target.value })} />
          <Input label="Restore health factor to" mono value={form.target} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, target: event.target.value })} />
          <Input label="Max repay per event" mono prefix="$" value={form.maxRepay} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, maxRepay: event.target.value })} />
          <Input label="Rescues to reserve gas for" mono value={form.count} hint={LENDING_RESCUE_COUNT_HINT} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, count: event.target.value })} />
          <Input label="Cooldown between repays" mono suffix="sec" value={form.cooldown} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, cooldown: event.target.value })} />
        </div>
        {/* W3: what the "$" field does to the BNB leg, stated rather than left
            to be discovered by an owner whose new figure changed one cap. */}
        {bnbPinned ? <div data-testid="lending-bnb-ceiling" style={{ font: "var(--type-body-sm)", color: bnbCeilingEditable ? "var(--text-subtle)" : "var(--warn)" }}>
          {bnbCeilingEditable
            ? "This guard also repays BNB debt: the amount above is converted to a BNB ceiling at the current BNB price when you save."
            : `BNB repay ceiling ${formatAtomicAmount(signedNativeCeilingWei!.toString(10), 18, 6)} BNB — read-only here. The BNB price is not fresh, so it cannot be re-priced; the ceiling you already signed is kept and only the USDT ceiling above changes.`}
        </div> : null}
        <div style={{ display: "flex", gap: 8 }}>
          <Button disabled={busy || editBlockedReason !== null} title={editBlockedReason ?? undefined} onClick={() => void saveSettings()}>Save settings</Button>
          <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </div>
    </Panel></div> : null}

    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
      <SegmentedToggle options={["Overview", "Run log", "Permissions"]} value={tab} onChange={(next: Tab) => setTab(next)} />
      <Button size="sm" variant="ghost" onClick={() => void detail.refreshLending()}>Refresh</Button>
    </div>

    {tab === "Overview" ? <div style={{ display: "grid", gap: 16 }}>
      {conditions.length > 0 ? <div data-testid="lending-conditions" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 12 }}>
        {conditions.map((entry, index) => {
          const tone = lendingConditionTone(entry.condition);
          const accent = tone === "alarm" ? "var(--loss)" : tone === "warn" ? "var(--warn)" : "var(--line-1)";
          return <div key={`${entry.condition}-${index}`} role={tone === "alarm" ? "alert" : "note"}
            style={{ display: "flex", gap: 10, padding: "12px 14px", borderRadius: "var(--radius-md)", border: `1px solid ${accent}`, background: "var(--surface-sunken)" }}>
            <span style={{ color: accent, flex: "0 0 auto", marginTop: 1 }}>
              <Icon name={tone === "info" ? "info" : "warning"} size={16} />
            </span>
            <span style={{ display: "grid", gap: 4 }}>
              <span style={{ font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-sans)", color: "var(--ink-1)" }}>
                {entry.condition}{entry.known ? "" : " (not recognized by this page)"}{entry.market === undefined ? "" : ` · ${shortAddress(entry.market)}`}
              </span>
              <span style={bodyText}>{lendingConditionCopy(entry.condition)}</span>
              {entry.detail.length > 0 ? <span style={{ ...mono, overflowWrap: "anywhere" }}>{entry.detail}</span> : null}
            </span>
          </div>;
        })}
      </div> : null}

      <div className="fl-lending-split" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.9fr) minmax(300px,1fr)", gap: 16, alignItems: "stretch" }}>
        <HealthPanel
          health={health}
          bases={bases}
          triggerHf={hfNumber(settings?.triggerHf)}
          targetHf={hfNumber(settings?.targetHf)}
          readAt={account === null || account.reason !== null
            ? null
            : {
              block: account.live ? mapped?.liveAccount?.blockNumber ?? null : payload?.account.blockNumber ?? null,
              live: account.live,
              at: mapped?.snapshot.presentAt ?? null,
            }}
          readReason={account?.reason ?? (mapped === null ? "the guard view is not readable" : null)}
          now={now} />
        <ReservePanel
          capacity={reserveMetric}
          coverage={coverageMetric}
          legs={payload === null ? null : {
            supplied: formatAtomicAmount(payload.reserve.suppliedUsdtWei, usdtDecimals, 2),
            idle: formatAtomicAmount(payload.reserve.idleUsdtWei, usdtDecimals, 2),
            bnb: formatAtomicAmount(payload.reserve.bnbTierWei, 18, 6),
          }}
          legsReason={payload === null
            ? mapped?.snapshot.reason ?? (mapFailed ? "the guard view could not be mapped by this page" : "the guard has not reported yet")
            : null}
          capWei={guard?.reserveCapWei ?? null}
          usdtDecimals={usdtDecimals}
          walletAddress={view?.walletAddress ?? null}
          session={sessionMetric} />
      </div>

      <PositionPanel
        markets={account?.markets ?? []}
        reason={account?.reason ?? (mapped === null ? "the guard view is not readable" : null)}
        live={account?.live ?? false}
        guardedAccount={guard?.guardedAccount ?? null}
        debtMarkets={guard?.debtMarkets ?? []}
        config={config}
        icons={icons}
        usdtDecimals={usdtDecimals} />

      <RulesStrip
        settings={settings}
        guard={guard}
        workerIntervalMs={mapped?.snapshot.workerIntervalMs ?? config?.workerIntervalMs ?? null}
        usdtDecimals={usdtDecimals} />
    </div> : null}

    {tab === "Run log" ? <div style={{ display: "grid", gap: 16 }}>
      <Panel title="What this guard has done" right={<span style={mono}>DURABLE ROWS ONLY · NO CHECK HISTORY IS STORED</span>}>
        <div data-testid="lending-timeline" style={{ padding: 16, display: "grid", gap: 14, maxHeight: 520, overflowY: "auto" }}>
          {timeline.length === 0
            ? <span style={{ color: "var(--text-subtle)" }}>— the guard view is not readable</span>
            : timeline.map((event) => <TimelineRow key={event.key} event={event} now={now} />)}
        </div>
      </Panel>

      <Panel title="Repay history" right={<span style={mono}>{`${rescues.length} RECORDED · EFFECT RE-READ ON CHAIN`}</span>}>
        <div data-testid="lending-rescue-log" style={{ padding: 16, maxHeight: 520, overflowY: "auto", display: "grid", gap: 12 }}>
          {rescues.length === 0
            ? <span style={{ color: "var(--text-subtle)" }}>— {mapped === null ? "the guard view is not readable" : "no rescue has been recorded for this guard"}</span>
            : rescues.map((rescue) => <RescueRow key={rescue.rescueId} rescue={rescue} now={now} usdtDecimals={usdtDecimals} config={config}
              expanded={expanded === rescue.rescueId} onToggle={() => setExpanded(expanded === rescue.rescueId ? null : rescue.rescueId)} />)}
        </div>
      </Panel>
    </div> : null}

    {tab === "Permissions" ? <PermissionsTab
      grant={grant}
      reason={grantReason}
      usdtDecimals={usdtDecimals}
      now={now} /> : null}
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

function BasisCell({ name, cell }: { readonly name: string; readonly cell: LendingBasisCell | null }) {
  if (cell === null || cell.hf === null) {
    return <span style={{ display: "grid", gap: 7, alignContent: "start", padding: "14px 16px" }}>
      <span style={label}>{name}</span>
      <Dash reason={cell?.reason ?? "the guard view is not readable"} />
    </span>;
  }
  return <span title={cell.matchedNote} style={{ display: "grid", gap: 7, alignContent: "start", padding: "14px 16px" }}>
    <span style={label}>{name}</span>
    <span style={val}>{cell.hf}</span>
    {/* A mismatch stays visible; the normal match detail is available on hover. */}
    {cell.matched === true ? null : <span style={{ ...mono, color: cell.matched === false ? "var(--loss)" : "var(--text-subtle)" }}>
      {cell.matchedNote}
    </span>}
  </span>;
}

function HealthScale({ nowHf, trigger, target }: {
  readonly nowHf: number | null;
  readonly trigger: number;
  readonly target: number;
}) {
  const lo = 1.0;
  const hi = Math.max(2.0, target + 0.5, (nowHf ?? 0) + 0.2);
  const at = (value: number) => ((Math.min(Math.max(value, lo), hi) - lo) / (hi - lo)) * 100;
  const zones = [
    { from: lo, to: trigger, color: "var(--loss)", op: 0.5, k: "risk", cap: `DANGER ${lo.toFixed(2)} – ${trigger.toFixed(2)}`, note: "liquidatable at 1.00" },
    { from: trigger, to: target, color: "var(--warn)", op: 0.5, k: "act", cap: `AGENT REPAYS ${trigger.toFixed(2)} – ${target.toFixed(2)}`, note: "back to target, then stops" },
    { from: target, to: hi, color: "var(--profit)", op: 0.42, k: "safe", cap: `SAFE ${target.toFixed(2)} AND UP`, note: "watching only" },
  ];
  return <div style={{ padding: "22px 20px 16px" }}>
    <div style={{ position: "relative" }}>
      {nowHf === null ? null : <span style={{ position: "absolute", left: `${at(nowHf)}%`, bottom: 6, transform: "translateX(-50%)", display: "grid", gap: 4, justifyItems: "center" }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)", background: "var(--surface-card)", padding: "3px 7px", border: "1px solid var(--line-3)", borderRadius: "var(--radius-sm)", whiteSpace: "nowrap" }}>YOU {nowHf.toFixed(2)}</span>
        <i style={{ width: 2, height: 18, background: "var(--ink-1)" }} />
      </span>}
      <div style={{ display: "flex", height: 14, borderRadius: 3, overflow: "hidden" }}>
        {zones.map((zone) => <i key={zone.k} style={{ width: `${at(zone.to) - at(zone.from)}%`, background: zone.color, opacity: zone.op }} />)}
      </div>
      <span data-testid="lending-target-marker" style={{ position: "absolute", left: `${at(target)}%`, top: 0, transform: "translateX(-50%)", display: "grid", gap: 4, justifyItems: "center" }}>
        <i style={{ height: 22, borderLeft: "2px dashed var(--profit)" }} />
        <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--profit)", background: "var(--surface-card)", padding: "3px 7px", border: "1px solid var(--line-3)", borderRadius: "var(--radius-sm)", whiteSpace: "nowrap" }}>TARGET {target.toFixed(2)}</span>
      </span>
      <span data-testid="lending-trigger-marker" style={{ position: "absolute", left: `${at(trigger)}%`, top: 0, transform: "translateX(-50%)", display: "grid", gap: 4, justifyItems: "center" }}>
        <i style={{ height: 44, borderLeft: "2px dashed var(--warn)" }} />
        <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--warn)", background: "var(--surface-card)", padding: "3px 7px", border: "1px solid var(--line-3)", borderRadius: "var(--radius-sm)", whiteSpace: "nowrap" }}>TRIGGER {trigger.toFixed(2)}</span>
      </span>
    </div>
    {/* Only the bar scales with the thresholds; labels need readable width even for a 0.01 HF gap. */}
    <div data-testid="lending-zone-legend" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 12, marginTop: 60 }}>
      {zones.map((zone) => <span key={zone.k} style={{ minWidth: 0, display: "grid", gap: 5, alignContent: "start", paddingLeft: 8, borderLeft: "1px solid var(--line-2)" }}>
        <span style={{ font: "var(--weight-medium) var(--text-xs)/1.35 var(--font-mono)", color: zone.color, letterSpacing: "0.03em" }}>{zone.cap}</span>
        <span style={{ ...mono, letterSpacing: 0 }}>{zone.note}</span>
      </span>)}
    </div>
    <p style={{ font: "var(--weight-regular) var(--text-md)/1.6 var(--font-sans)", color: "var(--text-muted)", margin: "16px 0 0", textWrap: "pretty" }}>
      Health factor is your collateral, discounted by each asset&apos;s liquidation threshold, divided by what you owe.
      At <b style={{ color: "var(--ink-1)" }}>1.00</b> Venus can liquidate you. This guard repays your debt when the factor sits
      below <b style={{ color: "var(--ink-1)" }}>{trigger.toFixed(2)}</b> for two finalized reads one worker interval apart, and stops
      once it is back at <b style={{ color: "var(--ink-1)" }}>{target.toFixed(2)}</b>. An account already liquidatable races bots and usually loses.
    </p>
  </div>;
}

function HealthPanel({ health, bases, triggerHf, targetHf, readAt, readReason, now }: {
  readonly health: { readonly value: string | null; readonly reason: string | null; readonly matched: boolean | null; readonly live: boolean } | null;
  readonly bases: { readonly liquidation: LendingBasisCell; readonly borrowingPower: LendingBasisCell } | null;
  readonly triggerHf: number | null;
  readonly targetHf: number | null;
  readonly readAt: { readonly block: string | null; readonly live: boolean; readonly at: number | null } | null;
  readonly readReason: string | null;
  readonly now: number;
}) {
  const nowHf = health?.value === null || health === null ? null : Number(health.value);
  const distance = distanceToLiquidation(bases?.liquidation.raw ?? null);
  return <Panel fill title="Health factor" testId="lending-health-panel" right={<>
    <span style={{ font: "var(--weight-medium) var(--text-3xl)/1 var(--font-mono)", color: health?.value === null || health === null ? "var(--text-subtle)" : "var(--profit)" }}>
      {health?.value ?? "—"}
    </span>
    {health?.value === null || health === null ? null
      : <StatusBadge pill status={triggerHf !== null && nowHf !== null && nowHf < triggerHf ? "warning" : "live"}
        label={triggerHf === null ? "no signed trigger to compare" : nowHf !== null && nowHf < triggerHf ? "Below your trigger" : "Above your trigger"} />}
  </>}>
    {/* NO CHART. The observation table keeps one row per agent and overwrites
        it, so there is no health-factor time series to draw — the mock's
        `ChartFrame` is deliberately absent rather than filled with a shape. */}
    {triggerHf === null || targetHf === null
      ? <div style={{ padding: "22px 20px 16px" }}>
        <Dash reason="the signed trigger and target are not readable, so the scale they define cannot be drawn" />
      </div>
      : <HealthScale nowHf={nowHf} trigger={triggerHf} target={targetHf} />}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", borderTop: "1px solid var(--line-1)", background: "var(--surface-sunken)", marginTop: "auto" }}>
      <BasisCell name="Liquidation basis" cell={bases?.liquidation ?? null} />
      <BasisCell name="Borrowing-power basis" cell={bases?.borrowingPower ?? null} />
      <span style={{ display: "grid", gap: 7, alignContent: "start", padding: "14px 16px" }}>
        <span style={label}>Distance to liquidation</span>
        {distance === null ? <Dash reason="no health factor to measure from" /> : <span style={val}>{distance}</span>}
      </span>
      <span style={{ display: "grid", gap: 7, alignContent: "start", padding: "14px 16px" }}>
        <span style={label}>Read at</span>
        {/* Live-read provenance is shown in the banner and position header. */}
        {readAt === null || readAt.block === null
          ? <Dash reason={readReason ?? "no read is recorded"} />
          : <>
            <span title={readAt.live ? LENDING_LIVE_ACCOUNT_LABEL : undefined} style={val}>block {readAt.block}</span>
            {readAt.live ? null : <span style={mono}>{readAt.at === null ? "no time recorded" : relativeTime(readAt.at, now).text}</span>}
          </>}
      </span>
    </div>
  </Panel>;
}

/* -------------------------------------------------------------------------- */
/* Reserve                                                                    */
/* -------------------------------------------------------------------------- */

function ReservePanel({ capacity, coverage, legs, legsReason, capWei, usdtDecimals, walletAddress, session }: {
  readonly capacity: DetailMetric;
  readonly coverage: DetailMetric;
  readonly legs: { readonly supplied: string; readonly idle: string; readonly bnb: string } | null;
  readonly legsReason: string | null;
  readonly capWei: string | null;
  readonly usdtDecimals: number;
  readonly walletAddress: string | null;
  readonly session: DetailMetric;
}) {
  const coveragePercent = coverage.value === null ? null : Number.parseFloat(coverage.value);
  const rows: readonly (readonly [string, string, string])[] = legs === null ? [] : [
    ["Supplied on Venus", `${legs.supplied} USDT`, "vUSDT · earns while it waits"],
    ["Idle in the agent wallet", `${legs.idle} USDT`, "swap surplus, still reserve"],
    ["BNB tier", `${legs.bnb} BNB`, "relay gas, and BNB repays"],
  ];
  return <Panel fill title="Rescue reserve" testId="lending-reserve-panel" right={<>
    <span style={mono}>{walletAddress === null ? "AGENT WALLET" : `${shortAddress(walletAddress)} · YOURS`}</span>
    <span style={mono}>SESSION {session.value ?? "—"}</span>
  </>}>
    <div style={{ padding: 16, display: "grid", gap: 14, alignContent: "start", height: "100%" }}>
      <div style={{ display: "grid", gap: 6 }}>
        <span style={label}>Repay capacity</span>
        {capacity.value === null
          ? <Dash reason={capacity.reason ?? "no source"} />
          : <>
            <span style={{ font: "var(--weight-medium) var(--text-3xl)/1 var(--font-mono)", color: "var(--ink-1)" }}>{capacity.value}</span>
            <span style={{ ...mono, letterSpacing: 0 }}>{capacity.note}</span>
          </>}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <span style={label}>Coverage of the pinned debt</span>
        {coverage.value === null
          ? <Dash reason={coverage.reason ?? "no source"} />
          : <>
            <span style={val}>{coverage.value}</span>
            <div style={{ height: 6, borderRadius: 3, background: "var(--raised-3)", overflow: "hidden" }}>
              <i style={{ display: "block", height: "100%", width: `${Math.min(100, Math.max(0, coveragePercent ?? 0))}%`, background: "var(--cat-health)" }} />
            </div>
            <span style={{ ...mono, letterSpacing: 0 }}>{coverage.note}</span>
          </>}
      </div>
      <div style={{ display: "grid", gap: 11, paddingTop: 12, borderTop: "1px solid var(--line-1)" }}>
        {legs === null
          ? <Dash reason={legsReason ?? "the reserve legs are not readable"} />
          : rows.map(([name, value, note]) => <span key={name} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 3 }}>
            <span style={bodyText}>{name}</span><span style={val}>{value}</span>
            <span style={{ ...mono, gridColumn: "1 / -1" }}>{note}</span>
          </span>)}
        {/* FIX 7: `reserveCapWei` is charged by EVERY USDT approve the session
            makes — the arm's supply, a repay, the retire's swap — so calling it
            a "daily repay limit" named the wrong thing entirely. */}
        <span style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 3, paddingTop: 11, borderTop: "1px solid var(--line-1)" }}>
          <span style={bodyText}>{LENDING_USDT_CAP_LABEL}</span>
          <span style={val}>{capWei === null ? "—" : `${formatAtomicAmount(capWei, usdtDecimals, 2)} USDT`}</span>
          {capWei === null ? <span style={{ ...mono, gridColumn: "1 / -1" }}>the guard row is not readable</span> : null}
        </span>
      </div>
    </div>
  </Panel>;
}

/* -------------------------------------------------------------------------- */
/* The guarded account's position                                             */
/* -------------------------------------------------------------------------- */

const POSITION_COLS = "minmax(150px,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.6fr) minmax(0,0.7fr) 150px";

function percentFromMantissa(mantissa: string): string {
  try {
    const bps = (BigInt(mantissa) * 10_000n) / E18;
    return `${(Number(bps) / 100).toFixed(0)}%`;
  } catch {
    return "—";
  }
}

function PositionPanel({ markets, reason, live, guardedAccount, debtMarkets, config, icons, usdtDecimals }: {
  readonly markets: readonly LendingMarketView[];
  readonly reason: string | null;
  readonly live: boolean;
  readonly guardedAccount: string | null;
  readonly debtMarkets: readonly string[];
  readonly config: LendingConfigView | null;
  readonly icons: Record<string, string | null>;
  readonly usdtDecimals: number;
}) {
  const pinned = new Set(debtMarkets.map((entry) => entry.toLowerCase()));
  const repayable = config === null ? null : new Set([config.vUsdt.toLowerCase(), config.vBnb.toLowerCase()]);
  return <Panel title="Guarded account position" testId="lending-position" right={<>
    <span style={mono}>{guardedAccount === null ? "account unavailable" : shortAddress(guardedAccount)}</span>
    {guardedAccount === null ? null : <a href={`https://bscscan.com/address/${guardedAccount}`} target="_blank" rel="noreferrer"
      className="fl-btn fl-btn--ghost fl-btn--sm" style={{ gap: 5, textDecoration: "none" }}>BscScan <Icon name="external" size={12} /></a>}
    {live ? <span style={mono}>{LENDING_LIVE_ACCOUNT_LABEL.toUpperCase()}</span> : null}
  </>}>
    {markets.length === 0
      ? <div style={{ padding: 16 }}><Dash reason={reason ?? "this account is in no Venus market"} /></div>
      : <>
        <div className="fl-row__head" style={{ gridTemplateColumns: POSITION_COLS }}>
          <span>Market</span><span>You supplied</span><span>You owe</span><span>Collateral</span><span>Liq. threshold</span>
          <span style={{ justifySelf: "end" }}>Guard can repay</span>
        </div>
        {markets.map((market) => {
          // vBNB carries `underlying: null` — BNB is native — so its badge is
          // resolved with WBNB's address instead. A missing icon degrades to a
          // symbol badge and never shifts the row.
          const iconAddress = (market.underlying ?? config?.wbnb ?? null)?.toLowerCase() ?? null;
          const src = iconAddress === null ? null : icons[iconAddress] ?? null;
          const symbol = market.symbol.replace(/^v/u, "");
          const decimals = market.underlyingDecimals;
          const isPinned = pinned.has(market.vToken.toLowerCase());
          const supported = repayable === null ? null : repayable.has(market.vToken.toLowerCase());
          return <div key={market.vToken} className="fl-row" style={{ gridTemplateColumns: POSITION_COLS, cursor: "default", alignItems: "center" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <TokenIcon src={src} symbol={symbol} size={24} />
              <span style={{ display: "grid", gap: 4, minWidth: 0 }}>
                <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{symbol}</span>
                <span style={mono}>{market.symbol}</span>
              </span>
            </span>
            <span style={val}>{formatAtomicAmount(market.supplyUnderlyingWei, decimals, decimals === 18 ? 4 : 2)}</span>
            <span style={val}>{formatAtomicAmount(market.borrowWei, decimals, decimals === 18 ? 4 : 2)}</span>
            <span style={mono}>{market.isCollateral ? "YES" : "NO"}</span>
            <span style={mono}>{percentFromMantissa(market.liquidationThreshold)}</span>
            <span style={{ justifySelf: "end" }}>
              <StatusBadge pill status={isPinned ? "live" : "warning"}
                label={isPinned ? "Pinned" : supported === false ? "Not in v1" : "Not pinned"} />
            </span>
          </div>;
        })}
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", padding: "12px 16px", borderTop: "1px solid var(--line-1)", background: "var(--surface-sunken)", ...mono }}>
          <span>{`${pinned.size} PINNED MARKET${pinned.size === 1 ? "" : "S"}`}</span>
          <span>DEBT IN AN UNPINNED MARKET IS OUTSIDE THIS GUARD BUT STILL COUNTS AGAINST YOUR HEALTH FACTOR</span>
          <span>{`USDT DECIMALS ${usdtDecimals}`}</span>
        </div>
      </>}
  </Panel>;
}

/* -------------------------------------------------------------------------- */
/* Guard rules                                                                */
/* -------------------------------------------------------------------------- */

function RulesStrip({ settings, guard, workerIntervalMs, usdtDecimals }: {
  readonly settings: LendingAgentView["settings"];
  readonly guard: LendingAgentView["guard"] | null;
  readonly workerIntervalMs: number | null;
  readonly usdtDecimals: number;
}) {
  const caps = settings === null ? [] : settings.maxPerAction.map((cap) => cap.token === null
    ? `${formatAtomicAmount(cap.maxWei, 18, 6)} BNB`
    : `${formatAtomicAmount(cap.maxWei, usdtDecimals, 2)} USDT`);
  const rules: readonly (readonly [string, string | null, string])[] = [
    ["Max per repay", caps.length === 0 ? null : caps.join(" · "), "the settings are not readable"],
    ["Cooldown", settings === null ? null : `${settings.minSecondsBetweenActions} s`, "the settings are not readable"],
    ["Gas reserved for", settings === null ? null : `${settings.rescueReserveCount} repays`, "the settings are not readable"],
    ["Checks every", workerIntervalMs === null ? null : `${Math.round(workerIntervalMs / 1_000)} s`, "this deployment does not publish the worker cadence"],
    ["Reserve split", guard === null ? null : `${guard.reserveBps / 100}% BNB`, "the guard row is not readable"],
  ];
  return <Panel title="Guard rules" testId="lending-rules">
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
      {rules.map(([name, value, reason]) => <span key={name} title={name === "Gas reserved for" ? LENDING_RESCUE_COUNT_HINT : undefined} style={{ display: "grid", gap: 7, padding: "14px 16px", borderRight: "1px solid var(--line-1)" }}>
        <span style={label}>{name}</span>
        {value === null ? <Dash reason={reason} /> : <span style={val}>{value}</span>}
      </span>)}
    </div>
  </Panel>;
}

/* -------------------------------------------------------------------------- */
/* Run log                                                                    */
/* -------------------------------------------------------------------------- */

function TimelineRow({ event, now }: { readonly event: LendingTimelineEvent; readonly now: number }) {
  const color = event.tone === "profit" ? "var(--profit)" : event.tone === "warn" ? "var(--warn)" : event.tone === "loss" ? "var(--loss)" : "var(--text-subtle)";
  return <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, alignItems: "start" }}>
    <i style={{ width: 8, height: 8, borderRadius: 999, background: color, marginTop: 6 }} />
    <span style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-sans)", color: "var(--ink-1)" }}>{event.title}</span>
      <span style={{ ...bodyText, overflowWrap: "anywhere" }}>{event.detail}</span>
    </span>
    <span style={{ display: "grid", gap: 4, justifyItems: "end" }}>
      {event.atMs === null
        ? <Dash reason={event.timeReason ?? "no time recorded"} align="end" />
        : <span style={mono}>{relativeTime(event.atMs, now).text}</span>}
      {txLink(event.txHash)}
    </span>
  </div>;
}

function RescueRow({ rescue, now, usdtDecimals, config, expanded, onToggle }: {
  readonly rescue: LendingRescueView;
  readonly now: number;
  readonly usdtDecimals: number;
  readonly config: LendingConfigView | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const native = config !== null && rescue.market.toLowerCase() === config.vBnb.toLowerCase();
  const amount = native
    ? `${formatAtomicAmount(rescue.amountWei, 18, 6)} BNB`
    : `${formatAtomicAmount(rescue.amountWei, usdtDecimals, 2)} USDT`;
  // An ambiguous or ineffective rescue is where an owner needs the raw row, so
  // Details is offered for exactly those.
  const debuggable = rescue.effect !== "changed" || rescue.partial
    || rescue.conditions.some((entry) => entry === "arm-unknown" || entry === "unknown-held" || entry === "borrow-moved");
  return <div data-testid={`lending-rescue-${rescue.rescueId}`} style={{ padding: "12px 0", borderBottom: "1px solid var(--line-1)", display: "grid", gap: 6 }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <strong>{amount}</strong>
      <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>{shortAddress(rescue.market)}</span>
      <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
        HF {formatHf(rescue.hfBefore)} → {formatHf(rescue.hfAfter)}
        {rescue.achievedHf === null ? "" : ` (target ${formatHf(rescue.achievedHf)})`}
      </span>
      <small>· {relativeTime(rescue.createdAtMs, now).text}</small>
      {/* FIX 1: `effect` and `partial` are DIFFERENT FACTS. The dot is coloured
          from `effect` alone — changed / no-effect / unverified — and `partial`
          is its own chip, because a repay can be both changed and partial. */}
      <span data-testid={`lending-rescue-effect-${rescue.rescueId}`} style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
        <i style={{ width: 7, height: 7, borderRadius: 999, flex: "0 0 auto", background: lendingEffectColor(rescue.effect) }} />
        {rescue.effect}
      </span>
      {rescue.partial ? <span data-testid={`lending-rescue-partial-${rescue.rescueId}`} style={{ font: "var(--type-mono-xs)", color: "var(--warn)", border: "1px solid var(--warn)", borderRadius: 999, padding: "1px 7px" }}>partial</span> : null}
      {txLink(rescue.txHash)}
      {debuggable ? <Button size="sm" variant="ghost" data-testid={`lending-rescue-details-${rescue.rescueId}`} onClick={onToggle}>{expanded ? "Hide details" : "Details"}</Button> : null}
    </div>
    {/* The two facts SAID, not left to a colour: what the effect means, and
        separately what partial means. */}
    <span style={bodyText}>{lendingEffectCopy(rescue.effect)}</span>
    {rescue.partial ? <span style={{ ...bodyText, color: "var(--warn)" }}>{LENDING_PARTIAL_COPY}</span> : null}
    {rescue.conditions.length > 0
      ? <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>{rescue.conditions.join(" · ")}</span>
      : null}
    {expanded ? <pre style={{ margin: "8px 0 0", padding: 10, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", font: "var(--weight-regular) var(--text-xs)/1.5 var(--font-mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {[
        `rescue    ${rescue.rescueId}`,
        `market    ${rescue.market}`,
        `amount    ${rescue.amountWei} wei`,
        `effect    ${rescue.effect}${rescue.partial ? "  partial" : ""}`,
        `hf        ${rescue.hfBefore ?? "—"} -> ${rescue.hfAfter ?? "—"}  achieved ${rescue.achievedHf ?? "—"}`,
        `tx        ${rescue.txHash ?? "none — no confirmed transaction is recorded for this row"}`,
        `at        ${new Date(rescue.createdAtMs).toISOString()}`,
        rescue.conditions.length === 0 ? "conditions none" : `conditions ${rescue.conditions.join(", ")}`,
      ].join("\n")}
    </pre> : null}
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Permissions — the REAL grant, and the honest sentence                      */
/* -------------------------------------------------------------------------- */

function PermissionsTab({ grant, reason, usdtDecimals, now }: {
  readonly grant: SessionGrantView | null;
  readonly reason: string | null;
  readonly usdtDecimals: number;
  readonly now: number;
}) {
  if (grant === null) {
    return <Panel title="What this agent may do" testId="lending-permissions">
      <div style={{ padding: 16 }}><Dash reason={reason ?? "reading the session grant…"} /></div>
    </Panel>;
  }
  const allows = lendingGrantAllows(grant);
  const denies = lendingGrantDenies();
  return <div data-testid="lending-permissions" style={{ display: "grid", gap: 16 }}>
    <Panel title="What this agent may do" right={<span style={mono}>READ FROM THE ON-CHAIN SESSION GRANT</span>}>
      <div style={{ display: "grid", gap: 10, padding: 16 }}>
        {allows.map((line, index) => <PermissionItem key={`allow-${index}`} kind="allow" note={line.note}>{line.text}</PermissionItem>)}
        {denies.map((line, index) => <PermissionItem key={`deny-${index}`} kind="deny" note={line.note}>{line.text}</PermissionItem>)}
      </div>
    </Panel>

    <Panel title="Caps — what actually bounds a leaked key" testId="lending-permission-caps">
      <div style={{ display: "grid", gap: 12, padding: 16 }}>
        {/* THE HONEST SENTENCE. A `CallRule` cannot constrain an argument, so
            the call list does NOT stop a leaked key from naming a recipient —
            the caps do. Never print "cannot send funds to any wallet but
            yours"; it is false on this contract. */}
        <p data-testid="lending-leaked-key" style={{ ...bodyText, color: "var(--ink-1)", maxWidth: "80ch", margin: 0 }}>
          {LENDING_LEAKED_KEY_SENTENCE}
        </p>
        {grant.spendCaps.length === 0
          ? <Dash reason="this grant carries no spend cap, which the lending template refuses to build" />
          : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            {grant.spendCaps.map((cap, index) => {
              const exposure = lendingCapExposure(cap, usdtDecimals);
              return <span key={`${cap.token ?? "native"}-${index}`} style={{ display: "grid", gap: 6, padding: "12px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line-1)", background: "var(--surface-sunken)" }}>
                <span style={label}>{exposure.label}</span>
                <span style={val}>{exposure.perDay}</span>
                {/* The x7 is only true for a DAILY cap; anything else says so
                    rather than multiplying a window it did not measure. And
                    `period` is the plane's own word — "day", "hour", … — not a
                    number of seconds. It used to render as "… s". */}
                <span style={mono}>{exposure.overSession === null
                  ? `rolling ${exposure.period} — the session total is not derived from a non-daily cap`
                  : `over the session's ${LENDING_MAX_SESSION_DAYS} days: up to ${exposure.overSession}`}</span>
              </span>;
            })}
          </div>}
        <span style={{ ...mono, letterSpacing: 0 }}>{LENDING_USDT_CAP_NOTE}</span>
      </div>
    </Panel>

    <Panel title="The session key" testId="lending-permission-session">
      <div style={{ display: "grid", gap: 10, padding: 16 }}>
        <span style={{ display: "grid", gap: 4 }}>
          <span style={label}>Expires</span>
          {grant.expiresAt === null
            ? <Dash reason="the grant carries no expiry" />
            : <>
              <span style={val}>{countdown(grant.expiresAt, now)}</span>
              <span style={mono}>{new Date(grant.expiresAt * 1_000).toISOString()} · the ceiling is {LENDING_MAX_SESSION_DAYS} days and cannot be raised</span>
            </>}
        </span>
        <span style={{ display: "grid", gap: 4 }}>
          <span style={label}>Key</span>
          {grant.publicKey === null
            ? <Dash reason="the grant carries no public key" />
            : <span style={{ ...mono, overflowWrap: "anywhere" }}>{grant.publicKey}</span>}
        </span>
        <span style={bodyText}>{LENDING_NO_LOCK_IN_COPY}</span>
      </div>
    </Panel>
  </div>;
}
