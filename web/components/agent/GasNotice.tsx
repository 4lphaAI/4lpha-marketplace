"use client";

/**
 * AGENT-GAS-ATTENTION §3.3 — the gas banner and the attention chip, ONCE.
 *
 * Every agent detail screen renders these, and they are shared rather than
 * copied for a reason the 2026-09-10 report made concrete: the shift grid had
 * a gas banner, the LP page had none, and the Account list had no idea either
 * existed. Three surfaces, one fact, three answers is the defect — a second
 * hand-written sentence would only move it.
 *
 * The wording matches the plane's own `agentGasReason` (remedy first, then the
 * figures, then what happens next), so a worker log line and the page a user is
 * looking at say the same thing about the same wallet.
 */
import { formatEther } from "viem";

import type { AgentGasView } from "@/lib/exec/agent-detail";

/** Wei as BNB, trimmed for reading rather than for exactness. */
function bnb(wei: string): string {
  const value = formatEther(BigInt(wei));
  const [whole, fraction = ""] = value.split(".");
  return fraction === "" ? whole! : `${whole}.${fraction.slice(0, 7).replace(/0+$/u, "") || "0"}`;
}

export type AttentionState = "none" | "paused" | "provisioning" | "gas-blocked" | "gas-low" | "partial-data";

/**
 * The attention an agent's gas reading implies, or `"none"`.
 *
 * `"unknown"` produces NO attention: an unread balance is a gap in the read,
 * not a fact about the agent. A `warn-only` profile (the Venus guard) can only
 * ever reach `gas-low` — it is never stood down, so it must never be shown as
 * blocked. That rule is enforced here as well as in the plane, because this is
 * the surface a user actually reacts to.
 */
export function gasAttention(gas: AgentGasView | null | undefined): AttentionState {
  if (!gas) return "none";
  if (gas.state === "blocked") return gas.enforcement === "warn-only" ? "gas-low" : "gas-blocked";
  if (gas.state === "low") return "gas-low";
  return "none";
}

/** The Account list's attention, which the PLANE derives; see `attentionFor`. */
export function attentionLabel(state: AttentionState): string | null {
  return LABELS[state];
}

const LABELS: Record<AttentionState, string | null> = {
  "none": null,
  "paused": "Paused",
  "provisioning": "Hiring",
  "gas-blocked": "Needs gas",
  "gas-low": "Gas low",
  "partial-data": "Partial data",
};

/** The chip shown beside a status pill, on both the detail page and the list. */
export function AttentionChip({ state, title }: { readonly state: AttentionState; readonly title?: string }) {
  const label = LABELS[state];
  if (label === null) return null;
  const tone = state === "gas-blocked" ? "var(--danger)" : state === "gas-low" ? "var(--warning)" : "var(--text-muted)";
  return (
    <span
      title={title}
      style={{
        font: "var(--type-mono-xs)", color: tone, border: `1px solid ${tone}`,
        borderRadius: "var(--radius-sm)", padding: "1px 6px", whiteSpace: "nowrap",
      }}>
      {label}
    </span>
  );
}

/**
 * The one-line remedy under the agent's title.
 *
 * Renders NOTHING for `ok` and for `unknown`. Silence on `unknown` is
 * deliberate: the page cannot say a wallet is short when it failed to read it,
 * and a "we could not check" banner on every transient RPC blip would train the
 * user to ignore the one that matters.
 */
export function GasNotice({ gas, walletAddress }: {
  readonly gas: AgentGasView | null | undefined;
  readonly walletAddress: string | null | undefined;
}) {
  if (!gas) return null;
  const where = walletAddress ?? "the agent wallet";

  // REVIEW FINDING 10 — an unread balance used to render NOTHING, while the
  // worker was standing the agent down for exactly that reason. A page that
  // shows a healthy-looking agent it could not weigh is worse than one that
  // admits the gap: a dash WITH its reason is the house rule.
  if (gas.state === "unknown" || gas.nativeWei === null) {
    // REVIEW 2 — and the enforcement check is why this is two sentences rather
    // than one. Finding 10's first wording said "the agent holds until it can
    // be read" for EVERY profile, which regressed finding 5: a Venus guard is
    // never held, so telling its owner it was is the same lie in a new place.
    return (
      <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
        {gas.enforcement === "warn-only"
          ? `— gas balance unavailable for ${where}; the guard keeps running regardless.`
          : `— gas balance unavailable for ${where}; the agent holds until it can be read.`}
      </span>
    );
  }

  const state = gasAttention(gas);
  if (state === "none") return null;
  // REVIEW FINDING 5 — a `warn-only` profile keeps working. Its sentence must
  // not borrow the stand-down wording, whatever the plane classified it as.
  if (gas.enforcement === "warn-only") {
    return (
      <span role="alert" style={{ font: "var(--type-mono-xs)", color: "var(--warning)" }}>
        Gas low: {where} holds {bnb(gas.nativeWei)} BNB against the {bnb(gas.nextMotionWei)} BNB a
        rescue costs in relay gas. The guard keeps trying and will submit a reduced repay rather
        than refuse — it is never stood down. Top it up so a full rescue stays affordable.
      </span>
    );
  }
  const blocked = state === "gas-blocked";
  // `nextMotionWei` is validated positive by `parseGasBlock`; the guard is here
  // because a "turns left" sentence is not worth a crash (REVIEW FINDING 9).
  const turns = BigInt(gas.nextMotionWei) > 0n
    ? (BigInt(gas.nativeWei) / BigInt(gas.nextMotionWei)).toString()
    : "—";
  return (
    <span role="alert" style={{ font: "var(--type-mono-xs)", color: blocked ? "var(--danger)" : "var(--warning)" }}>
      {blocked
        ? `Needs gas: deposit BNB to ${where}. The cheapest action costs about ${bnb(gas.blockWei)} BNB in relay gas and the wallet holds ${bnb(gas.nativeWei)} BNB, so the agent is standing by. It resumes by itself once funded — no signature needed.`
        : `Gas low: ${where} holds ${bnb(gas.nativeWei)} BNB, roughly ${turns} more motion(s) of relay gas. Below ${bnb(gas.blockWei)} BNB the agent stands by until it is topped up.`}
    </span>
  );
}
