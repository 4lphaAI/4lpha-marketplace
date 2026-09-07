"use client";

/**
 * DEMO MODE — the trading agent's deploy action.
 *
 * A SEPARATE component from `HireTradeDeploy` on purpose. That one is the
 * passkey hire: a wallet, a grant attempt fence, a durable recovery pointer and
 * a session. A demo has none of those, and threading a `mode` boolean through
 * it would put a demo branch inside the flow that grants real authority — the
 * same reason the execution plane keeps `src/demo/**` out of its money path.
 *
 * What this does: one POST, no wallet, no signature, no session.
 */
import * as React from "react";

type State =
  | { readonly step: "idle" }
  | { readonly step: "working" }
  | { readonly step: "done"; readonly id: string }
  | { readonly step: "failed"; readonly message: string };

const primaryBtn: React.CSSProperties = {
  cursor: "pointer",
  padding: "14px 22px",
  borderRadius: "var(--radius-sm)",
  background: "var(--cat-yield)",
  border: "none",
  color: "#08110c",
  font: "var(--weight-medium) var(--text-md)/1 var(--font-sans)",
};

export function DemoTradeDeploy(props: {
  readonly agentName: string;
  readonly executionModel: string;
  readonly capitalBnb: string;
  /** POSITIVE bps. The form carries the stop loss as a negative percentage;
   *  the plane's `decideExit` compares against `-stopLossBps`, so the sign is
   *  removed once, here, and never twice. */
  readonly stopLossBps?: number | null;
  readonly takeProfitBps?: number | null;
  readonly maxHoldSec?: number | null;
  readonly maxOpenPositions?: number;
  readonly blockedReason?: string | null;
}) {
  const [state, setState] = React.useState<State>({ step: "idle" });

  const start = async (): Promise<void> => {
    setState({ step: "working" });
    try {
      const response = await fetch("/api/demo/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "trade",
          name: props.agentName,
          model: props.executionModel,
          capitalBnb: props.capitalBnb,
          ...(props.stopLossBps == null ? {} : { stopLossBps: props.stopLossBps }),
          ...(props.takeProfitBps == null ? {} : { takeProfitBps: props.takeProfitBps }),
          ...(props.maxHoldSec == null ? {} : { maxHoldSec: props.maxHoldSec }),
          ...(props.maxOpenPositions == null ? {} : { maxOpenPositions: props.maxOpenPositions }),
        }),
      });
      const payload = (await response.json()) as {
        data?: { agent: { id: string } };
        error?: { code: string; message?: string };
      };
      if (!response.ok || payload.data === undefined) {
        setState({
          step: "failed",
          message: payload.error?.message ?? payload.error?.code ?? `HTTP ${response.status}`,
        });
        return;
      }
      setState({ step: "done", id: payload.data.agent.id });
    } catch (error) {
      setState({ step: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div style={{ display: "grid", gap: 14, marginTop: 26, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void start()}
          disabled={state.step === "working" || (props.blockedReason ?? null) !== null}
          style={state.step === "working" ? { ...primaryBtn, cursor: "wait", opacity: 0.6 } : primaryBtn}
        >
          {state.step === "working" ? "Starting…" : "Start Demo Trading Agent"}
        </button>
        <span style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)", marginLeft: "auto" }}>
          Demo mode follows live prices and records simulated fills. No wallet, no funds, no orders.
        </span>
        {/* "live prices", NOT "live quotes" (review finding 11): a demo fill is
            priced from the live USD feed, not from a venue's route quote, so a
            token that is priced but unsellable would still show a clean exit
            here. Saying "quotes" would have claimed a check the demo does not
            make. */}
      </div>

      {props.blockedReason ? (
        <div style={{ padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", font: "var(--weight-regular) var(--text-sm)/1.5 var(--font-sans)", color: "var(--text-subtle)" }}>
          {props.blockedReason}
        </div>
      ) : null}

      {state.step === "failed" ? (
        <div style={{ padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--loss)", font: "var(--weight-regular) var(--text-sm)/1.5 var(--font-mono)", color: "var(--loss)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {state.message}
        </div>
      ) : null}

      {state.step === "done" ? (
        // Dashed, and it says Demo. A demo result never borrows live chrome and
        // never shows a tx hash, because it has none.
        <div style={{ padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px dashed var(--cat-yield)", display: "grid", gap: 6, font: "var(--weight-regular) var(--text-sm)/1.5 var(--font-mono)", color: "var(--ink-1)", overflowWrap: "anywhere" }}>
          <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--cat-yield)" }}>
            Demo trading agent started
          </span>
          <span>Demo {state.id}</span>
          <span style={{ color: "var(--text-subtle)" }}>
            Simulated. Fills are priced from the live USD feed — not from a venue route quote —
            so a token that is priced but not sellable would still show a clean exit here. Gas is
            charged as a separate line; slippage, MEV and transfer taxes are not modelled.
          </span>
        </div>
      ) : null}
    </div>
  );
}
