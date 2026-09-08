"use client";

/**
 * Live-mainnet wiring for the grid deploy screen (spec:
 * `MD here/MARKETPLACE-GRID-DEPLOY-SPEC.md`).
 *
 * Three pieces, consumed by `DeployAgentScreen`:
 *  - `LivePoolSection` — real WBNB pools from the data plane (via /api/pools)
 *    with PancakeSwap token icons and TVL/vol/fee facts;
 *  - `GridDeployActions` — the deploy button row: agent picker (owner-signed
 *    read), range preview derived from the live tick, wallet signature over
 *    the exact `gridArm` params, submit through the BFF, result/refusal
 *    rendered VERBATIM (plane refusal text is product text).
 *
 * v1 boundary: arm-only (agent must be provisioned via `live-lp provision`),
 * fixed grid, levels=1. Demo mode is a stub — no fake success.
 */
import * as React from "react";
import { useAccount } from "wagmi";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import {
  FEE_TO_TICK_SPACING,
  GRID_PRESETS,
  deriveGridFromPreset,
  parseBnbToWei,
  type GridPresetId,
} from "@/lib/grid/geometry";
import { buildFixedGridSettings, buildShiftGridSettings } from "@/lib/grid/settings";
import { WBNB_56 } from "@/lib/exec/pairs";
import { PairIcons as SharedPairIcons } from "@/components/TokenIcon";
import { DEMO_GRID_OMISSIONS } from "@/lib/demo/omissions";

/* ── data ─────────────────────────────────────────────────────────────── */

export type LivePool = {
  pool: string;
  token0: string;
  token1: string;
  token0Symbol: string | null;
  token1Symbol: string | null;
  fee: number | null;
  tick: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  token0Icon: string | null;
  token1Icon: string | null;
  wbnbIsToken0: boolean;
  staleness: string | null;
};

/** UI preset ids (design export) → geometry preset ids (backend table). */
export const UI_PRESET_TO_GEOMETRY: Record<string, GridPresetId> = {
  tight: "tight",
  balanced: "standard",
  wide: "wide",
  volatile: "very-wide",
};

function fmtUsd(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function feeLabel(fee: number | null): string {
  return fee === null ? "V3" : `V3 | ${(fee / 10000).toFixed(2).replace(/0$/u, "")}%`;
}

function shortAddr(address: string): string {
  return `${address.slice(0, 7)}...${address.slice(-4)}`;
}

export function useLivePools(): {
  pools: LivePool[] | null;
  error: string | null;
  reload: () => void;
} {
  const [pools, setPools] = React.useState<LivePool[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/pools")
      .then(async (response) => {
        const payload = (await response.json()) as { data?: LivePool[]; error?: { code: string } };
        if (cancelled) return;
        if (!response.ok || !payload.data) {
          setError(payload.error?.code ?? "pools_unavailable");
          return;
        }
        setPools(payload.data);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("pools_unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { pools, error, reload: () => setTick((t) => t + 1) };
}

/* ── token icons ──────────────────────────────────────────────────────── */

function PairIcons({ pool }: { pool: LivePool }) {
  return <SharedPairIcons token0={{ src: pool.token0Icon, symbol: pool.token0Symbol }} token1={{ src: pool.token1Icon, symbol: pool.token1Symbol }} />;
}

/* ── pool picker ──────────────────────────────────────────────────────── */

function LivePoolRow({ pool, selected, onClick }: {
  pool: LivePool;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 12,
        width: "100%", padding: "10px 14px",
        background: selected ? "var(--cat-grid-tint)" : "transparent",
        border: "none", borderRadius: "var(--radius-sm)",
      }}
    >
      <PairIcons pool={pool} />
      <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>
          {pool.token0Symbol ?? "?"} / {pool.token1Symbol ?? "?"}
        </span>
        <span style={{ font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-subtle)" }}>
          {shortAddr(pool.pool)} · {feeLabel(pool.fee)}
        </span>
      </span>
      <span style={{ marginLeft: "auto", display: "grid", gap: 3, textAlign: "right", flex: "0 0 auto" }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }}>
          {fmtUsd(pool.tvlUsd)} TVL
        </span>
        <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>
          {fmtUsd(pool.volume24hUsd)} 24H VOL
        </span>
      </span>
    </button>
  );
}

export function LivePoolSection({ value, onChange }: {
  value: LivePool | null;
  onChange: (pool: LivePool) => void;
}) {
  const { pools, error, reload } = useLivePools();
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const isAddr = /^0x[a-fA-F0-9]{40}$/u.test(q.trim());
  const [customError, setCustomError] = React.useState<string | null>(null);
  // A pasted address may be a POOL or a TOKEN. The BFF resolves a token to its
  // WBNB V3 pools; when it finds more than one fee tier the owner picks.
  const [candidates, setCandidates] = React.useState<LivePool[] | null>(null);
  const [loadingCustom, setLoadingCustom] = React.useState(false);

  const list = (pools ?? []).filter((pool) => {
    const pair = `${pool.token0Symbol ?? ""}${pool.token1Symbol ?? ""}`.toLowerCase();
    return pair.includes(q.toLowerCase().replace(/\s|-|\//gu, ""));
  });

  const pick = (pool: LivePool) => {
    onChange(pool);
    setOpen(false);
    setQ("");
    setCustomError(null);
    setCandidates(null);
  };

  const customErrorText = (code: string): string =>
    code === "no_wbnb_v3_pool"
      ? "That token trades, but not against WBNB on PancakeSwap V3. Grid v1 needs a WBNB leg."
      : code === "invalid_address"
        ? "That is not a BNB Chain address."
        : code === "pool_unavailable"
          ? "No PancakeSwap V3 pool for that address — paste the pool, or the token it trades as."
          : code;

  // A complete address resolves ITSELF — a pasted contract is already the
  // whole instruction, so making the owner click a second time to confirm it
  // buys nothing. Short debounce so a slow paste is one request, not forty.
  const address = isAddr ? q.trim().toLowerCase() : null;
  const pickRef = React.useRef(pick);
  pickRef.current = pick;

  React.useEffect(() => {
    setCustomError(null);
    setCandidates(null);
    if (address === null) {
      setLoadingCustom(false);
      return;
    }
    let cancelled = false;
    setLoadingCustom(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/pools?address=${address}`);
          const payload = (await response.json()) as {
            data?: LivePool;
            meta?: { resolvedFrom?: string; candidates?: LivePool[] };
            error?: { code: string };
          };
          if (cancelled) return;
          if (!response.ok || !payload.data) {
            setCustomError(customErrorText(payload.error?.code ?? "pool_unavailable"));
            return;
          }
          const hasWbnbLeg = payload.data.token0.toLowerCase() === WBNB_56
            || payload.data.token1.toLowerCase() === WBNB_56;
          if (!hasWbnbLeg) {
            setCustomError("Grid v1 needs a WBNB leg; that pool has none.");
            return;
          }
          // One pool: take it. Several fee tiers for the same token: let the
          // owner choose which the grid runs on rather than guess on TVL.
          const found = payload.meta?.candidates ?? [];
          if (payload.meta?.resolvedFrom === "token" && found.length > 1) {
            setCandidates(found);
            return;
          }
          pickRef.current(payload.data);
        } catch {
          if (!cancelled) setCustomError(customErrorText("pool_unavailable"));
        } finally {
          if (!cancelled) setLoadingCustom(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <span className="fl-eyebrow">Pool</span>
      <div style={{ display: "grid", gap: 10, position: "relative" }}>
        <input
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQ(event.target.value); setOpen(true); }}
          placeholder="Search pair (e.g. WBNB-USDT) or paste pool/token contract"
          style={{
            width: "100%", padding: "12px 14px", borderRadius: "var(--radius-sm)",
            background: "var(--surface-sunken)",
            border: `1px solid ${open ? "var(--cat-grid)" : "var(--line-1)"}`,
            color: "var(--ink-1)", font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-sans)", outline: "none",
          }}
        />
        {open ? (
          <div style={{ background: "var(--surface-card)", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", padding: 8, display: "grid", gap: 2, maxHeight: 268, overflowY: "auto" }}>
            <span className="fl-eyebrow" style={{ padding: "4px 8px 6px" }}>
              {isAddr ? "Pool or token contract" : "Live WBNB pools · PancakeSwap V3"}
            </span>
            {isAddr ? (
              <>
                {loadingCustom ? (
                  <span style={{ padding: "10px 14px", font: "var(--weight-regular) var(--text-sm)/1.3 var(--font-sans)", color: "var(--text-subtle)" }}>
                    Resolving pool…
                  </span>
                ) : null}
                {candidates !== null ? (
                  <>
                    <span className="fl-eyebrow" style={{ padding: "4px 8px 6px" }}>
                      WBNB V3 pools for that token
                    </span>
                    {candidates.map((pool) => (
                      <LivePoolRow key={pool.pool} pool={pool} selected={value?.pool === pool.pool} onClick={() => pick(pool)} />
                    ))}
                  </>
                ) : null}
              </>
            ) : pools === null && error === null ? (
              <span style={{ padding: "10px 14px", font: "var(--weight-regular) var(--text-sm)/1.3 var(--font-sans)", color: "var(--text-subtle)" }}>Loading pools…</span>
            ) : error !== null ? (
              <span style={{ padding: "10px 14px", font: "var(--weight-regular) var(--text-sm)/1.3 var(--font-sans)", color: "var(--loss)" }}>
                Pool data unavailable ({error}). <button type="button" onClick={reload} style={{ cursor: "pointer", background: "none", border: "none", color: "var(--cat-grid)", textDecoration: "underline" }}>Retry</button>
              </span>
            ) : list.length > 0 ? (
              list.map((pool) => (
                <LivePoolRow key={pool.pool} pool={pool} selected={value?.pool === pool.pool} onClick={() => pick(pool)} />
              ))
            ) : (
              <span style={{ padding: "10px 14px", font: "var(--weight-regular) var(--text-sm)/1.3 var(--font-sans)", color: "var(--text-subtle)" }}>
                No pool matches. Paste a pool contract address instead.
              </span>
            )}
            {customError !== null ? (
              <span style={{ padding: "6px 14px 8px", font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-sans)", color: "var(--loss)" }}>{customError}</span>
            ) : null}
          </div>
        ) : null}
        {value !== null ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--cat-grid)" }}>
            <PairIcons pool={value} />
            <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
              <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>
                {value.token0Symbol ?? "?"} / {value.token1Symbol ?? "?"}
              </span>
              <span style={{ font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-subtle)" }}>
                {shortAddr(value.pool)} · {feeLabel(value.fee)}
              </span>
            </span>
            <span style={{ marginLeft: "auto", font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--cat-grid)", letterSpacing: "0.06em" }}>SELECTED</span>
          </div>
        ) : (
          <div style={{ padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px dashed var(--line-1)", font: "var(--weight-regular) var(--text-sm)/1.3 var(--font-sans)", color: "var(--text-subtle)" }}>
            No pool selected yet.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── agent picker + deploy flow ───────────────────────────────────────── */

type AgentRow = {
  id: string;
  status?: string;
  httpRuntimeProfile?: string;
  session?: { expiresAt?: number; publicKey?: string } | null;
};

/**
 * Why an agent cannot be armed, from the LIST data alone — `null` means
 * nothing in the list forbids it.
 *
 * Deliberately NOT exhaustive: whether the agent already holds a live position
 * (the arm's idle gate) needs a second owner-signed read per agent, so that
 * one is left to the plane's own refusal, which this screen renders verbatim.
 * Better to under-claim here than to show a green "ready" the arm contradicts.
 */
function armBlockReason(agent: AgentRow, nowSec: number): string | null {
  if (agent.httpRuntimeProfile !== "lp-v1") {
    return `profile ${agent.httpRuntimeProfile ?? "unknown"} — not an LP/grid session`;
  }
  if (!agent.session) return "no session granted";
  if (typeof agent.session.expiresAt === "number" && agent.session.expiresAt <= nowSec) {
    return `session expired ${new Date(agent.session.expiresAt * 1000).toISOString().slice(0, 16).replace("T", " ")}Z`;
  }
  if (agent.status === "paused") return "agent is paused";
  if (agent.status !== "armed") return `status ${agent.status ?? "unknown"}`;
  return null;
}

type DeployState =
  | { step: "idle" }
  | { step: "working"; note: string }
  | { step: "done"; result: Record<string, unknown> }
  | { step: "failed"; message: string };


/**
 * THE GRID ARM, as one function.
 *
 * Lifted out of `GridDeployActions` so the hire flow can run it as the last
 * step of a single "Deploy" press: two copies of a signing path would drift,
 * and this one carries the tick read, the geometry derivation, the settings
 * builder and the exact envelope the plane admits.
 *
 * Throws with the plane's own refusal text — that text is product copy.
 */
/**
 * DEMO MODE — create a simulated grid on the SAME geometry live mode would sign.
 *
 * It reads the tick from the same execution-plane reader `armGridAgent` reads,
 * runs the same `deriveGridFromPreset`, and posts the gap/width to the demo
 * plane, which re-derives the rungs from its own fresh read. So a demo and a
 * live deploy of the same preset produce the same ladder — which is the only
 * way a demo is worth showing.
 *
 * NO WALLET, NO SIGNATURE, NO AGENT. A demo carries no session and no funds,
 * so none of the live path's preconditions apply to it.
 */
export async function createDemoGridAgent(input: {
  readonly pool: LivePool;
  readonly uiPresetId: string;
  readonly capitalBnb: string;
  readonly onNote?: (note: string) => void;
}): Promise<{ readonly id: string }> {
  const { pool } = input;
  if (pool.fee === null) throw new Error("That pool has no known fee tier.");
  if (parseBnbToWei(input.capitalBnb) <= 0n) throw new Error("Total capital must be positive.");

  input.onNote?.("Reading the pool's current tick from chain…");
  const stateResponse = await fetch(`/api/pool-state?address=${pool.pool.toLowerCase()}`);
  const statePayload = (await stateResponse.json()) as {
    data?: { currentTick: number; tickSpacing: number };
    error?: { code: string; message?: string };
  };
  if (!stateResponse.ok || statePayload.data === undefined) {
    throw new Error(
      statePayload.error?.message
        ?? `The pool's tick could not be read (${statePayload.error?.code ?? stateResponse.status}).`,
    );
  }
  const derived = deriveGridFromPreset({
    presetId: UI_PRESET_TO_GEOMETRY[input.uiPresetId] ?? "standard",
    spreadFactor: 1,
    currentTick: statePayload.data.currentTick,
    tickSpacing: statePayload.data.tickSpacing,
    wbnbIsToken0: pool.wbnbIsToken0,
  });

  input.onNote?.(
    `Starting a demo grid at tick ${statePayload.data.currentTick}: `
    + `gap ${derived.gapTicks} / width ${derived.widthTicks} ticks. No wallet, no funds.`,
  );
  const response = await fetch("/api/demo/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "grid",
      token0: pool.token0,
      token1: pool.token1,
      fee: pool.fee,
      budgetBnb: input.capitalBnb,
      gapTicks: derived.gapTicks,
      widthTicks: derived.widthTicks,
      baseSymbol: (pool.wbnbIsToken0 ? pool.token1Symbol : pool.token0Symbol) ?? "TOKEN",
    }),
  });
  const payload = (await response.json()) as {
    data?: { agent: { id: string } };
    error?: { code: string; message?: string };
  };
  if (!response.ok || payload.data === undefined) {
    throw new Error(
      payload.error?.message ?? payload.error?.code ?? `HTTP ${response.status}`,
    );
  }
  return { id: payload.data.agent.id };
}

export async function armGridAgent(input: {
  readonly agentId: string;
  readonly pool: LivePool;
  readonly uiPresetId: string;
  readonly capitalBnb: string;
  readonly stopLossPct: number;
  readonly takeProfitPct: number;
  readonly signEnvelope: (action: string, agentId: string, params: Record<string, unknown>) => Promise<unknown>;
  readonly hireProfile?: "grid-v1" | "grid-shift-v1";
  readonly relayFeePerSubmitWei?: string;
  readonly onNote?: (note: string) => void;
}): Promise<Record<string, unknown>> {
  const { agentId, pool, capitalBnb } = input;
  const geometryPreset = UI_PRESET_TO_GEOMETRY[input.uiPresetId] ?? "standard";
  const budgetWei = parseBnbToWei(capitalBnb);
  if (budgetWei <= 0n) throw new Error("Total capital must be positive.");

  // The tick comes from the EXECUTION PLANE's own reader, not the data plane:
  // it is the reader `admitGridSettings` cross-checks the signed geometry
  // against, and the data plane's lane rows carry no tick at all.
  input.onNote?.("Reading the pool's current tick from chain…");
  const stateResponse = await fetch(`/api/pool-state?address=${pool.pool.toLowerCase()}`);
  const statePayload = (await stateResponse.json()) as {
    data?: { currentTick: number; tickSpacing: number; blockNumber: string };
    error?: { code: string; message?: string };
  };
  if (!stateResponse.ok || statePayload.data === undefined) {
    throw new Error(
      statePayload.error?.message
        ?? `The pool's tick could not be read (${statePayload.error?.code ?? stateResponse.status}).`,
    );
  }
  const { currentTick, tickSpacing, blockNumber } = statePayload.data;
  if (pool.fee === null) throw new Error("That pool has no known fee tier.");
  const expectedSpacing = FEE_TO_TICK_SPACING[pool.fee];
  if (expectedSpacing !== undefined && expectedSpacing !== tickSpacing) {
    // Chain wins; the map is only a sanity check, and a disagreement means the
    // discovery row and the chain describe different pools.
    throw new Error(
      `The pool reports tick spacing ${tickSpacing}, but fee tier ${pool.fee} implies ${expectedSpacing}. Refusing to derive a grid from a contradiction.`,
    );
  }

  const derived = deriveGridFromPreset({
    presetId: geometryPreset,
    spreadFactor: 1,
    currentTick,
    tickSpacing,
    wbnbIsToken0: pool.wbnbIsToken0,
  });
  const shift = input.hireProfile === "grid-shift-v1";
  const base = {
    pool: { token0: pool.token0, token1: pool.token1, fee: pool.fee },
    wbnbIsToken0: pool.wbnbIsToken0,
    tickSpacing,
    buyRange: derived.buyRange,
    sellRange: derived.sellRange,
    stopLossPct: input.stopLossPct,
    takeProfitPct: input.takeProfitPct,
  };
  const settings = shift
    // Cross-only (drift disabled), so the relay fee is passed when it happens
    // to be known and is not required to arm.
    ? buildShiftGridSettings({
        ...base,
        gapTicks: derived.gapTicks,
        widthTicks: derived.widthTicks,
        ...(input.relayFeePerSubmitWei === undefined ? {} : { relayFeePerSubmitWei: input.relayFeePerSubmitWei }),
      })
    : buildFixedGridSettings(base);

  input.onNote?.(
    `Grid derived at tick ${currentTick} (block ${blockNumber}): buy [${derived.buyRange.tickLower}, ${derived.buyRange.tickUpper}), `
    + `sell [${derived.sellRange.tickLower}, ${derived.sellRange.tickUpper}), gap ${derived.gapTicks} / width ${derived.widthTicks} ticks`
    + `${derived.gapClamped || derived.widthClamped ? " (quantized up to the pool's tick spacing)" : ""}. `
    + "Confirm the signature in your wallet…",
  );
  const envelope = await input.signEnvelope("gridArm", agentId, {
    settings,
    budgetWei: budgetWei.toString(10),
    // The shift grid is ONE atomic submission that mints BOTH rungs
    // (PHASE3.22): the plane refuses levels: 1 for grid.mode "shift".
    ...(shift ? { levels: 2 } : {}),
  });

  input.onNote?.("Submitting to the execution plane (the relay mints on-chain; this can take a minute)…");
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/grid/arm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const payload = (await response.json()) as { data?: Record<string, unknown>; error?: { code: string; message?: string } };
  if (!response.ok || payload.data === undefined) {
    throw new Error(
      payload.error?.message
        ? `${payload.error.code}: ${payload.error.message}`
        : payload.error?.code ?? `HTTP ${response.status}`,
    );
  }
  return payload.data;
}

export function GridDeployActions(props: {
  mode: "Demo" | "Live";
  uiPresetId: string;
  pool: LivePool | null;
  capitalBnb: string;
  takeProfitPct: number;
  stopLossPct: number;
  fixedAgentId?: string;
  onDeployed?: (agentId: string) => void;
  /** In-app router. Present in the app shell; absent in isolated renders. */
  go?: (route: string) => void;
  /** The hire profile the session was granted under; decides the grid mode signed at arm. */
  hireProfile?: "grid-v1" | "grid-shift-v1";
  /** Relay fee per submission (wei, decimal) from the hire preview — required for the shift drift lane. */
  relayFeePerSubmitWei?: string;
}) {
  const { mode, uiPresetId, pool, capitalBnb, takeProfitPct, stopLossPct, fixedAgentId, onDeployed, hireProfile, relayFeePerSubmitWei } = props;
  const { isConnected } = useAccount();
  const { signEnvelope, signReadHeader } = useOwnerActions();
  const [agents, setAgents] = React.useState<AgentRow[] | null>(null);
  const [agentId, setAgentId] = React.useState<string>(fixedAgentId ?? "");
  const [state, setState] = React.useState<DeployState>({ step: "idle" });
  const [demoNote, setDemoNote] = React.useState(false);

  const loadAgents = async () => {
    setState({ step: "working", note: "One wallet signature lists your agents (read-only, free)…" });
    try {
      const header = await signReadHeader("*");
      const response = await fetch("/api/agents", { headers: { "x-owner-action": header } });
      const payload = (await response.json()) as { data?: { agents?: AgentRow[] } | AgentRow[]; error?: { code: string; message?: string } };
      if (!response.ok) {
        setState({ step: "failed", message: payload.error?.message ?? payload.error?.code ?? `HTTP ${response.status}` });
        return;
      }
      const rows = Array.isArray(payload.data) ? payload.data : payload.data?.agents ?? [];
      setAgents(rows);
      if (rows.length === 1 && rows[0]) setAgentId(rows[0].id);
      setState({ step: "idle" });
    } catch (error) {
      setState({ step: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const deploy = async () => {
    if (mode === "Demo") {
      setDemoNote(false);
      try {
        if (pool === null) throw new Error("Select a pool first.");
        const demo = await createDemoGridAgent({
          pool,
          uiPresetId,
          capitalBnb,
          onNote: (note) => setState({ step: "working", note }),
        });
        setState({
          step: "done",
          result: {
            demo: {
              id: demo.id,
              note:
                "Simulated. It follows the live price and records fills, but places no order and holds no funds.",
            },
          },
        });
      } catch (error) {
        setState({ step: "failed", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    setDemoNote(false);
    try {
      if (!isConnected) throw new Error("Connect a wallet first (top right).");
      if (pool === null) throw new Error("Select a pool first.");
      if (agentId === "") throw new Error("Load and pick a provisioned agent first.");
      const result = await armGridAgent({
        agentId,
        pool,
        uiPresetId,
        capitalBnb,
        stopLossPct,
        takeProfitPct,
        signEnvelope,
        ...(hireProfile === undefined ? {} : { hireProfile }),
        ...(relayFeePerSubmitWei === undefined ? {} : { relayFeePerSubmitWei }),
        onNote: (note) => setState({ step: "working", note }),
      });
      setState({ step: "done", result });
      onDeployed?.(agentId);
    } catch (error) {
      setState({ step: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const arm = state.step === "done" ? (state.result["arm"] as Record<string, unknown> | undefined) : undefined;
  const demo = state.step === "done" ? (state.result["demo"] as Record<string, unknown> | undefined) : undefined;

  return (
    <div style={{ display: "grid", gap: 14, marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
      {mode === "Live" && fixedAgentId === undefined ? (
        <div style={{ display: "grid", gap: 8 }}>
          <span className="fl-eyebrow">Agent (provisioned session)</span>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {agents === null ? (
              <button type="button" onClick={loadAgents} disabled={!isConnected || state.step === "working"}
                style={{ cursor: isConnected ? "pointer" : "not-allowed", padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--cat-grid)", color: "var(--cat-grid)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" }}>
                {isConnected ? "Load my agents (sign a read)" : "Connect a wallet to load agents"}
              </button>
            ) : agents.length === 0 ? (
              <span style={{ font: "var(--weight-regular) var(--text-sm)/1.4 var(--font-sans)", color: "var(--text-subtle)" }}>
                No agents under this wallet. Provisioning (the on-chain session grant) is CLI-side in v1: <code>npm run live-lp -- provision</code>.
              </span>
            ) : (
              <select value={agentId} onChange={(event) => setAgentId(event.target.value)}
                style={{ padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", color: "var(--ink-1)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", maxWidth: "100%" }}>
                <option value="">Pick an agent…</option>
                {agents.map((agent) => {
                  const blocked = armBlockReason(agent, Math.floor(Date.now() / 1000));
                  return (
                    <option key={agent.id} value={agent.id} disabled={blocked !== null}>
                      {agent.id}{blocked === null ? " · ready" : ` — ${blocked}`}
                    </option>
                  );
                })}
              </select>
            )}
            {agents !== null && agents.length > 0
              && agents.every((agent) => armBlockReason(agent, Math.floor(Date.now() / 1000)) !== null) ? (
              <span style={{ font: "var(--weight-regular) var(--text-xs)/1.5 var(--font-sans)", color: "var(--text-subtle)", maxWidth: "62ch" }}>
                None of your agents can be armed right now. A grid arm needs an
                <code> lp-v1 </code> agent that is armed with a session that has not expired —
                re-grant with <code>npm run live-lp -- provision</code>. An agent that already
                holds a live position is refused by the plane itself; exit it first.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="fl-deploy-actions" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={deploy} disabled={state.step === "working"}
          style={{ cursor: state.step === "working" ? "wait" : "pointer", padding: "14px 22px", borderRadius: "var(--radius-sm)", background: "var(--cat-grid)", border: "none", color: "#08110c", font: "var(--weight-medium) var(--text-md)/1 var(--font-sans)" }}>
          {state.step === "working" ? "Working…" : mode === "Live" ? "Deploy Grid Agent (live)" : "Deploy Grid Agent"}
        </button>
        <span style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)", marginLeft: "auto" }}>
          {mode === "Demo"
            ? "Demo mode runs the same logic with no funds at risk."
            : "Live mode arms the on-chain session. Your wallet signs; the server never holds your key."}
        </span>
      </div>

      {demoNote ? (
        <div style={{ padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", font: "var(--weight-regular) var(--text-sm)/1.5 var(--font-sans)", color: "var(--text-subtle)" }}>
          Demo mode is not enabled on this deployment. Switch to Live to deploy against mainnet.
        </div>
      ) : null}

      {state.step === "working" ? (
        <div style={{ padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--cat-grid-tint)", border: "1px solid var(--cat-grid)", font: "var(--weight-regular) var(--text-sm)/1.5 var(--font-mono)", color: "var(--ink-1)", whiteSpace: "pre-wrap" }}>
          {state.note}
        </div>
      ) : null}
      {state.step === "failed" ? (
        <div style={{ padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--loss)", font: "var(--weight-regular) var(--text-sm)/1.5 var(--font-mono)", color: "var(--loss)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {state.message}
        </div>
      ) : null}
      {state.step === "done" && demo !== undefined ? (
        <div style={{ padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px dashed var(--cat-grid)", display: "grid", gap: 6, font: "var(--weight-regular) var(--text-sm)/1.5 var(--font-mono)", color: "var(--ink-1)", overflowWrap: "anywhere" }}>
          {/* A demo NEVER borrows live chrome: dashed border, the word Demo in
              the title, and no tx hash / NFT id, because it has none. */}
          <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--cat-grid)" }}>
            Demo grid started
          </span>
          {typeof demo["note"] === "string" ? <span style={{ color: "var(--text-subtle)" }}>{demo["note"]}</span> : null}
          {/* The OMISSIONS, on the success surface itself (fix-review finding 16).
              The detail screen carries them too, but this is the surface that
              appears FIRST, and it must not be a bare success. */}
          {DEMO_GRID_OMISSIONS.map((omission) => (
            <span key={omission} style={{ color: "var(--text-subtle)" }}>· does not account for {omission}</span>
          ))}
          {/* Straight to the demo, because an id on a screen is not something to
              watch. `go` is absent only where this component is rendered outside
              the app shell, and then the list below is the way in. */}
          {typeof demo["id"] === "string" && props.go !== undefined ? (
            <button
              type="button"
              onClick={() => props.go?.(`/demo/${String(demo["id"])}`)}
              style={{ justifySelf: "start", marginTop: 4, cursor: "pointer", padding: "10px 16px", borderRadius: "var(--radius-sm)", background: "transparent", border: "1px solid var(--cat-grid)", color: "var(--cat-grid)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" }}
            >
              Watch this demo →
            </button>
          ) : null}
        </div>
      ) : null}

      {state.step === "done" && demo === undefined ? (
        <div style={{ padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--cat-grid-tint)", border: "1px solid var(--cat-grid)", display: "grid", gap: 6, font: "var(--weight-regular) var(--text-sm)/1.5 var(--font-mono)", color: "var(--ink-1)", overflowWrap: "anywhere" }}>
          <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--cat-grid)" }}>
            Grid armed{typeof arm?.["status"] === "string" ? ` · ${arm["status"]}` : ""}
          </span>
          {typeof arm?.["tokenId"] === "string" || typeof arm?.["tokenId"] === "number" ? <span>Position NFT #{String(arm["tokenId"])}</span> : null}
          {typeof arm?.["sequenceId"] === "string" ? <span>Sequence {arm["sequenceId"]}</span> : null}
          {typeof arm?.["reason"] === "string" ? <span>{arm["reason"]}</span> : null}
          {typeof arm?.["note"] === "string" ? <span>{arm["note"]}</span> : null}
          {typeof state.result["settingsDigest"] === "string" ? <span style={{ color: "var(--text-subtle)" }}>digest {state.result["settingsDigest"]}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
