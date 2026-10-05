/** Deterministic entry score + veto for the tradfi v2 lane (TRADFI-AI-TRADE-V3 §2). Pure, no I/O. */
import type { FeatureEvidence } from "./features.js";
import type { ScoreComponentId, SessionState } from "./session.js";
import { SESSION_EVIDENCE_WEIGHTS, SESSION_PROFILES, SESSION_WEIGHTS } from "./session.js";

/** Measured 100-145 bps round trip from FINDINGS (bp); not an env flag. */
export const TRADFI_COST_BAND_BPS = 150;

export type Regime = "risk_on" | "risk_off" | "neutral" | "unavailable";

/** §1 blend rule: equity wins when available; crypto alone can only move neutral -> risk_off; both unavailable -> unavailable. */
export function blendRegime(equity: Regime, crypto: Regime): Regime {
  if (equity !== "unavailable") return equity;
  if (crypto === "unavailable") return "unavailable";
  if (crypto === "risk_off") return "risk_off";
  return "neutral";
}

export type ComponentResult = { readonly score: number | null; readonly reason: string };
export type ScoreResult = {
  readonly score: number;
  readonly activeWeightShare: number;
  readonly strong: boolean;
  readonly buy: boolean;
  readonly veto: string | null;
  readonly reasons: readonly string[];
  readonly insufficientEvidence: boolean;
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function metricValue(evidence: FeatureEvidence | undefined, name: string): number | null {
  if (!evidence) return null;
  const base = (evidence.metrics as unknown as Record<string, { value: number | null; available: boolean }>)[name];
  if (base && base.available && typeof base.value === "number") return base.value;
  const additive = evidence.additiveMetrics as unknown as Record<string, { value: number | null; available: boolean }> | undefined;
  const item = additive?.[name];
  return item && item.available && typeof item.value === "number" ? item.value : null;
}

function componentEma(f: FeatureEvidence | undefined, s: FeatureEvidence | undefined): ComponentResult {
  const fSpread = metricValue(f, "emaSpreadPct");
  const sSpread = metricValue(s, "emaSpreadPct");
  if (fSpread === null || sSpread === null) return { score: null, reason: "ema:unavailable" };
  const score = clamp(20 * fSpread + 10 * sSpread, -80, 80);
  return { score, reason: `ema=${score.toFixed(1)}` };
}

function componentMacd(f: FeatureEvidence | undefined): ComponentResult {
  const histogram = metricValue(f, "histogram");
  const macd = metricValue(f, "macd");
  const signal9 = metricValue(f, "signal9");
  const ema26 = metricValue(f, "ema26");
  if (histogram === null || macd === null || signal9 === null || ema26 === null || ema26 === 0) return { score: null, reason: "macd:unavailable" };
  const h = (histogram / ema26) * 1e4;
  const score = clamp(h * 4, -65, 65) + (macd > signal9 ? 15 : -15);
  return { score, reason: `macd=${score.toFixed(1)}` };
}

function componentRsi(f: FeatureEvidence | undefined): ComponentResult {
  const rsi = metricValue(f, "rsi14");
  if (rsi === null) return { score: null, reason: "rsi:unavailable" };
  const score = rsi < 30 ? 50 : rsi < 45 ? 20 : rsi < 60 ? 0 : rsi < 70 ? -20 : -50;
  return { score, reason: `rsi=${score}` };
}

function componentMomentum(f: FeatureEvidence | undefined): ComponentResult {
  const momentum10 = metricValue(f, "momentum10");
  const ema26 = metricValue(f, "ema26");
  if (momentum10 === null || ema26 === null || ema26 === 0) return { score: null, reason: "momentum:unavailable" };
  const m = (momentum10 / ema26) * 100;
  const score = clamp(m * 12, -80, 80);
  return { score, reason: `momentum=${score.toFixed(1)}` };
}

function componentRoc1h(s: FeatureEvidence | undefined): ComponentResult {
  const roc10Pct = metricValue(s, "roc10Pct");
  if (roc10Pct === null) return { score: null, reason: "roc1h:unavailable" };
  const score = clamp(roc10Pct * 10, -80, 80);
  return { score, reason: `roc1h=${score.toFixed(1)}` };
}

function componentVolume(f: FeatureEvidence | undefined): ComponentResult {
  const rvol = metricValue(f, "rvol20");
  if (rvol === null) return { score: null, reason: "volume:unavailable" };
  const score = rvol < 0.6 ? -30 : rvol < 1 ? -10 : rvol < 1.5 ? 20 : rvol < 3 ? 45 : 25;
  return { score, reason: `volume=${score}` };
}

function atrGuardFired(f: FeatureEvidence | undefined): boolean | null {
  const roc10Pct = metricValue(f, "roc10Pct");
  const atrPct = metricValue(f, "atrPct");
  if (roc10Pct === null || atrPct === null) return null;
  return roc10Pct / 3 > atrPct;
}

function componentAtrGuard(f: FeatureEvidence | undefined): ComponentResult {
  const fired = atrGuardFired(f);
  if (fired === null) return { score: null, reason: "atrGuard:unavailable" };
  return { score: fired ? -60 : 0, reason: fired ? "atrGuard=extended" : "atrGuard=0" };
}

function componentBollinger(f: FeatureEvidence | undefined): ComponentResult {
  const pos = metricValue(f, "bbPosition20");
  if (pos === null) return { score: null, reason: "bollinger:unavailable" };
  const score = pos < 0 ? 45 : pos < 0.2 ? 25 : pos < 0.8 ? 0 : pos < 1 ? -25 : -45;
  return { score, reason: `bollinger=${score}` };
}

function componentStochRsi(f: FeatureEvidence | undefined): ComponentResult {
  const value = metricValue(f, "stochRsi14");
  if (value === null) return { score: null, reason: "stochRsi:unavailable" };
  const score = value < 0.2 ? 35 : value < 0.8 ? 0 : -35;
  return { score, reason: `stochRsi=${score}` };
}

function componentVwap(f: FeatureEvidence | undefined, session: SessionState): ComponentResult {
  if (session === "overnight") return { score: 0, reason: "vwap=inactive-overnight" };
  const dist = metricValue(f, "vwapDistancePct");
  if (dist === null) return { score: null, reason: "vwap:unavailable" };
  const score = clamp(dist * 25, -40, 40);
  return { score, reason: `vwap=${score.toFixed(1)}` };
}

function componentGap(f: FeatureEvidence | undefined, s: FeatureEvidence | undefined, session: SessionState): ComponentResult {
  const gap = metricValue(s, "gapPct") ?? metricValue(f, "gapPct");
  if (gap === null) return { score: null, reason: "gap:unavailable" };
  if (session === "rth") {
    const score = clamp(gap * 8, -40, 40);
    return { score, reason: `gap=${score.toFixed(1)}` };
  }
  if (Math.abs(gap) < 2.5) return { score: 0, reason: "gap=below-2.5" };
  const score = clamp(-gap * 12, -50, 50);
  return { score, reason: `gap=${score.toFixed(1)}` };
}

function componentOrb(f: FeatureEvidence | undefined, session: SessionState): ComponentResult {
  if (session !== "rth") return { score: null, reason: "orb:inactive-outside-rth" };
  const brk = metricValue(f, "orbBreakPct");
  if (brk === null) return { score: null, reason: "orb:unavailable" };
  const score = brk > 0 ? 45 : brk < 0 ? -45 : 0;
  return { score, reason: `orb=${score}` };
}

function componentRegime(regime: Regime): ComponentResult {
  if (regime === "unavailable") return { score: null, reason: "regime:unavailable" };
  const score = regime === "risk_on" ? 35 : regime === "risk_off" ? -45 : 0;
  return { score, reason: `regime=${score}` };
}

function components(f: FeatureEvidence | undefined, s: FeatureEvidence | undefined, regime: Regime, session: SessionState): Record<ScoreComponentId, ComponentResult> {
  return {
    ema: componentEma(f, s),
    macd: componentMacd(f),
    rsi: componentRsi(f),
    momentum: componentMomentum(f),
    roc1h: componentRoc1h(s),
    volume: componentVolume(f),
    atrGuard: componentAtrGuard(f),
    bollinger: componentBollinger(f),
    stochRsi: componentStochRsi(f),
    vwap: componentVwap(f, session),
    gap: componentGap(f, s, session),
    orb: componentOrb(f, session),
    regime: componentRegime(regime),
  };
}

/** §2.3 falling-knife / regime / extended vetoes. Falling-knife and regime are spared for `strong`. */
function vetoFor(f: FeatureEvidence | undefined, regime: Regime, strong: boolean): string | null {
  const emaSpread = metricValue(f, "emaSpreadPct");
  const momentum10 = metricValue(f, "momentum10");
  const ema26 = metricValue(f, "ema26");
  const rsi14 = metricValue(f, "rsi14");
  const macd = metricValue(f, "macd");
  const signal9 = metricValue(f, "signal9");
  const roc10Pct = metricValue(f, "roc10Pct");

  const atrFired = atrGuardFired(f);
  if (atrFired === true && roc10Pct !== null && roc10Pct > 0) return "extended-over-3atr";

  if (!strong) {
    if (emaSpread !== null && momentum10 !== null && ema26 !== null && ema26 !== 0) {
      const momentumPct = (momentum10 / ema26) * 100;
      const rescued = rsi14 !== null && rsi14 < 30 && macd !== null && signal9 !== null && macd > signal9;
      if (emaSpread < -1.5 && momentumPct < -3 && !rescued) return "falling-knife";
    }
    if (regime === "risk_off") return "regime-risk-off";
  }
  return null;
}

/** Score one candidate (§2.1-2.3). */
export function scoreToken(f: FeatureEvidence | undefined, s: FeatureEvidence | undefined, regime: Regime, session: SessionState): ScoreResult {
  const weights = SESSION_WEIGHTS[session];
  const evidenceWeights = SESSION_EVIDENCE_WEIGHTS[session];
  const profile = SESSION_PROFILES[session];
  const comps = components(f, s, regime, session);
  let weightedSum = 0;
  let activeWeight = 0;
  let evidenceActive = 0;
  let evidenceTotal = 0;
  const contributions: { readonly id: ScoreComponentId; readonly weighted: number; readonly reason: string }[] = [];
  for (const id of Object.keys(weights) as ScoreComponentId[]) {
    const w = weights[id];
    evidenceTotal += evidenceWeights[id];
    const result = comps[id];
    if (result.score !== null) {
      weightedSum += w * result.score;
      activeWeight += w;
      evidenceActive += evidenceWeights[id];
      contributions.push({ id, weighted: Math.abs(w * result.score), reason: result.reason });
    }
  }
  const activeWeightShare = evidenceTotal > 0 ? evidenceActive / evidenceTotal : 0;
  const insufficientEvidence = activeWeightShare < 0.35;
  const score = activeWeight > 0 ? Math.round((weightedSum / activeWeight) * 10) / 10 : 0;
  const strong = !insufficientEvidence && score >= profile.strong;
  const veto = insufficientEvidence ? null : vetoFor(f, regime, strong);
  const buy = !insufficientEvidence && veto === null && score >= profile.buy;
  const reasons = contributions.sort((a, b) => b.weighted - a.weighted).slice(0, 3).map((c) => c.reason);
  return { score, activeWeightShare, strong, buy, veto, reasons, insufficientEvidence };
}

/** §3.2: the exit-LLM trigger context, before/after an ask. `trigger` is the id that fired the ask (or "none" for the first evaluation). */
export type ExitTriggerContext = {
  readonly pnlBps: number;
  readonly peakPnlBps: number | null;
  readonly macdHistSign: -1 | 0 | 1 | null;
  readonly emaSpreadSign: -1 | 0 | 1 | null;
  readonly regime: Regime;
  readonly session: SessionState;
  readonly trigger?: string;
};

const COST_BAND_BREACH_BPS = TRADFI_COST_BAND_BPS + 150;
const PEAK_GIVEBACK_FLOOR_BPS = 300;
const PEAK_GIVEBACK_DROP_BPS = 200;
/** A slow bleed re-asked on every new low (one position, 38 asks); after a giveback ask, re-ask only on a further drop this large. */
export const PEAK_GIVEBACK_REASK_BPS = 150;

function sign(value: number): -1 | 0 | 1 { return value > 0 ? 1 : value < 0 ? -1 : 0; }

/**
 * Operator ruling 2026-09-23: a single stock swinging 3 % is noise. The first
 * 24 h of v3 showed every loss exited at the −300 bps first ask (SKHYB −3.00,
 * CRCLB −3.14, MSTRB −3.18, METAB −2.86 %): a de-facto 3 % stop nobody chose.
 * The loss side now first asks at −800 bps (the operator's chosen stop distance); the
 * gain side keeps the cost band so profits are still reviewed early.
 */
export const TRADFI_LOSS_REVIEW_BPS = 800;

function costBandBreach(prior: ExitTriggerContext | null, current: ExitTriggerContext): boolean {
  const threshold = current.pnlBps < 0 ? TRADFI_LOSS_REVIEW_BPS : COST_BAND_BREACH_BPS;
  if (Math.abs(current.pnlBps) < threshold) return false;
  if (prior === null) return true;
  const priorSign = sign(prior.pnlBps);
  const currentSign = sign(current.pnlBps);
  if (currentSign !== priorSign) return true;
  return Math.abs(current.pnlBps - prior.pnlBps) >= 300;
}

function peakGiveback(prior: ExitTriggerContext | null, current: ExitTriggerContext): boolean {
  if (current.peakPnlBps === null || current.peakPnlBps < PEAK_GIVEBACK_FLOOR_BPS) return false;
  if (current.pnlBps > current.peakPnlBps - PEAK_GIVEBACK_DROP_BPS) return false;
  if (prior !== null && prior.trigger === "peak-giveback" && current.pnlBps > prior.pnlBps - PEAK_GIVEBACK_REASK_BPS) return false;
  return true;
}

/**
 * §3.2 trigger table, first match wins. `prior === null` means "never asked":
 * pnlBps reads 0 and the signs/regime/session read the current evidence, so
 * only cost-band-breach or peak-giveback can fire on a position's first ask.
 */
export function evaluateExitTrigger(prior: ExitTriggerContext | null, current: ExitTriggerContext): string | null {
  const effectivePrior: ExitTriggerContext = prior ?? {
    pnlBps: 0, peakPnlBps: null, macdHistSign: current.macdHistSign, emaSpreadSign: current.emaSpreadSign,
    regime: current.regime, session: current.session,
  };
  if (costBandBreach(prior, current)) return "cost-band-breach";
  if (current.macdHistSign !== null && effectivePrior.macdHistSign !== null && current.macdHistSign !== effectivePrior.macdHistSign) return "macd-flip-1h";
  if (current.emaSpreadSign !== null && effectivePrior.emaSpreadSign !== null && current.emaSpreadSign !== effectivePrior.emaSpreadSign) return "ema-cross-1h";
  if (current.regime !== effectivePrior.regime && current.regime !== "unavailable") return "regime-change";
  if (current.session !== effectivePrior.session) return "session-boundary";
  if (peakGiveback(prior, current)) return "peak-giveback";
  return null;
}

/**
 * Operator ruling 2026-09-23 (implicit −8 %): an LLM exit on a position that is
 * down by less than {@link TRADFI_LOSS_REVIEW_BPS} is honoured only when the 1h
 * trend has broken (EMA12 below EMA26 AND a negative MACD histogram) or the
 * regime is risk_off. Gains and deeper losses are never blocked. This is a
 * brake on the model, not a stop: nothing here ever SELLS.
 */
export function tradfiExitAllowed(input: {
  readonly pnlBps: number;
  readonly emaSpreadSign: -1 | 0 | 1 | null;
  readonly macdHistSign: -1 | 0 | 1 | null;
  readonly regime: Regime;
}): { readonly allowed: boolean; readonly reason: string } {
  if (input.pnlBps >= 0) return { allowed: true, reason: "in-profit" };
  if (input.pnlBps <= -TRADFI_LOSS_REVIEW_BPS) return { allowed: true, reason: "beyond-loss-review" };
  if (input.regime === "risk_off") return { allowed: true, reason: "regime-risk-off" };
  if (input.emaSpreadSign === -1 && input.macdHistSign === -1) return { allowed: true, reason: "1h-trend-broken" };
  return { allowed: false, reason: `loss ${input.pnlBps} bps inside -${TRADFI_LOSS_REVIEW_BPS} with the 1h trend intact` };
}
