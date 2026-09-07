"use client";

/**
 * DEMO MODE — the LIST of a visitor's demos.
 *
 * ─── WHY THIS IS A LIST AND NOT A STACK OF CARDS ───────────────────────────
 *
 * It was a stack of cards: five metrics, a ladder, a level line and the whole
 * omissions list, repeated for every demo. The operator's verdict was that it
 * "looks cluttered" — and it did: three demos put the same twenty lines of
 * small print on the page three times and pushed the footer somewhere below
 * the horizon. Repetition is not extra honesty; past the first copy it is just
 * noise a reader learns to scroll past, which is worse than one copy they read.
 *
 * So this is one row per demo — name, kind, status, and how long ago it moved —
 * and everything else lives on the detail screen the row opens.
 *
 * ─── IT STILL NEVER BORROWS LIVE CHROME ────────────────────────────────────
 *
 * Dashed border, a DEMO badge on every row. No transaction hash, no NFT id and
 * no registry id anywhere, because a demo has none and the plane sends all four
 * as explicit nulls precisely so a screen cannot invent them.
 *
 * Polls every 15 s, and only while the tab is VISIBLE: a forgotten background
 * tab should not keep a service busy for a viewer who is not looking.
 */
import * as React from "react";

import {
  DemoError,
  listDemoAgents,
  type DemoAgentView,
} from "@/lib/demo/client";
import { Dash, ageText, eyebrow, subtle } from "./parts";

const POLL_MS = 15_000;

function Row(props: { readonly agent: DemoAgentView; readonly go: (route: string) => void }) {
  const { agent } = props;
  const accent = agent.kind === "grid" ? "var(--cat-grid)" : "var(--cat-yield)";
  return (
    <button
      type="button"
      onClick={() => props.go(`/demo/${agent.id}`)}
      style={{
        cursor: "pointer", textAlign: "left", width: "100%",
        display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap",
        padding: "12px 14px", borderRadius: "var(--radius-sm)",
        background: "var(--surface-sunken)", border: `1px dashed ${accent}`,
      }}
    >
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>
        {agent.name}
      </span>
      <span style={{ ...eyebrow, color: accent }}>
        Demo · {agent.kind === "grid" ? "grid" : "trading"}
      </span>
      <span style={subtle}>{agent.status}</span>
      {agent.holdReason === null ? null : <span style={subtle}>· not advancing</span>}
      <span style={{ ...subtle, marginLeft: "auto" }}>
        {agent.lastTickAtMs === null ? "waiting for its first cycle" : `moved ${ageText(agent.lastTickAtMs)}`}
      </span>
      <span style={{ ...subtle, color: accent }}>Open →</span>
    </button>
  );
}

export function DemoAgentPanel(props: {
  readonly go: (route: string) => void;
  readonly heading?: string;
}) {
  const [agents, setAgents] = React.useState<readonly DemoAgentView[] | null>(null);
  const [unavailable, setUnavailable] = React.useState<string | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const payload = await listDemoAgents();
      setAgents(payload.agents);
      setUnavailable(null);
    } catch (caught) {
      setAgents([]);
      setUnavailable(
        caught instanceof DemoError && caught.code === "demo_disabled"
          ? "Demo mode is not enabled on this deployment."
          : "Your demos could not be loaded right now.",
      );
    }
  }, []);

  React.useEffect(() => {
    void load();
    const tick = (): void => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void load();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  if (agents !== null && agents.length === 0 && unavailable === null) return null;

  return (
    <section style={{ display: "grid", gap: 8, marginTop: 26 }}>
      <span style={eyebrow}>{props.heading ?? "Your demo agents"}</span>
      {unavailable !== null ? (
        <Dash reason={unavailable} />
      ) : agents === null ? (
        <span style={subtle}>Loading…</span>
      ) : (
        agents.map((agent) => <Row key={agent.id} agent={agent} go={props.go} />)
      )}
    </section>
  );
}
