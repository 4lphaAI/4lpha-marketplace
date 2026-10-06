"use client";

import * as React from "react";
import { AGENTIC_EARN_COPY, type agenticEarnEstimate } from "@/lib/agentic";

const text: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1.5 var(--font-sans)", color: "var(--text-muted)", margin: 0, textWrap: "pretty" };

/** The Earn opt-in explained in one picture: spare USDT goes out to the better of Venus / Aave v3 while the agent waits, and comes back for a buy or the end. Decorative only. */
function EarnFlow() {
  return <div className="fl-earn-flow" aria-hidden="true">
    <div className="fl-earn-flow__node">
      <img src="/design/protocols/usdt.png" alt="" width={28} height={28} />
      <b>Your wallet</b><small>spare USDT</small>
    </div>
    <div className="fl-earn-flow__lanes">
      <div className="fl-earn-flow__lane"><span className="fl-earn-flow__track"><i className="fl-earn-flow__coin" /></span><small>lent while it waits</small></div>
      <div className="fl-earn-flow__lane fl-earn-flow__lane--back"><span className="fl-earn-flow__track"><i className="fl-earn-flow__coin" /></span><small>back when a buy needs it</small></div>
    </div>
    <div className="fl-earn-flow__node">
      <span className="fl-earn-flow__pair"><img src="/design/protocols/venus.png" alt="" width={28} height={28} /><img src="/design/protocols/aave.png" alt="" width={28} height={28} /></span>
      <b>Venus or Aave v3</b><small>best rate wins</small>
    </div>
  </div>;
}

const KEEPS: Readonly<Record<"ai" | "schedule" | "dca", string>> = { ai: "2 entries", schedule: "the next day of buys + 2", dca: "the base + 3 levels" };
const usdt = (wei: bigint): string => { const cents = (wei + 5n * 10n ** 15n) / 10n ** 16n; return `${cents / 100n}${cents % 100n === 0n ? "" : "." + (cents % 100n).toString().padStart(2, "0")} USDT`; };

/** AGENTIC-EARN-SPEC rule 44 (operator 2026-10-06): the short Deploy disclosure, a picture, one line, three points and what these settings lend. The self-rescue commands live on the agent's Earn tab. */
export function EarnDisclosure({ mode, estimate }: { mode: "ai" | "schedule" | "dca"; estimate: ReturnType<typeof agenticEarnEstimate> }) {
  const fit = estimate.lendWei > 0n
    ? <>With these settings it lends about <b>{usdt(estimate.lendWei)}</b> at the start and keeps <b>{usdt(estimate.keepWei)}</b> ({KEEPS[mode]}) for buying.</>
    : estimate.minCapitalWei !== null
      ? <>With these settings nothing is lent: it keeps {KEEPS[mode]} for buying, so it needs at least <b>{usdt(estimate.minCapitalWei)}</b> of capital.</>
      : <>With these settings nothing is lent: it keeps {KEEPS[mode]}, so the levels after the first three must hold at least 20 USDT.</>;
  return <div data-testid="earn-disclosure" style={{ display: "grid", gap: 10 }}>
    <EarnFlow />
    <p style={{ ...text, fontSize: "var(--text-sm)", color: "var(--ink-1)" }}>{AGENTIC_EARN_COPY.summary}</p>
    <ul style={{ ...text, display: "grid", gap: 2, paddingLeft: 18 }}>{AGENTIC_EARN_COPY.points.map(point => <li key={point}>{point}</li>)}</ul>
    <p data-testid="earn-estimate" style={{ ...text, padding: "8px 10px", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", color: estimate.lendWei > 0n ? "var(--ink-1)" : "var(--warn)" }}>{fit}</p>
  </div>;
}
