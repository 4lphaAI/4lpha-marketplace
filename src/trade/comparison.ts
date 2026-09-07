/** Offline matched comparison. All monetary values share an explicit quote currency. */
import { assessMomentum, decodeFeature, record, type FeaturePool, type TokenFeatures } from "./features.js";
export function compareTradeEvidence(input: unknown): unknown {
  const fail = (): never => { throw new Error("Invalid or unmatched research evidence."); };
  if (!record(input) || input.version !== "trade-comparison-v1" || !Array.isArray(input.candidates)
    || input.candidates.length > 69 || !Number.isSafeInteger(input.decisionAt) || (input.decisionAt as number) <= 0
    || typeof input.currency !== "string" || !/^[A-Z0-9]{2,12}$/.test(input.currency)
    || typeof input.notional !== "number" || !Number.isFinite(input.notional) || input.notional <= 0
    || (input.label !== "FIXTURE" && input.label !== "OBSERVATION")) return fail();
  const decisionAt = input.decisionAt as number, notional = input.notional;
  const arms = { baseline: [] as string[], ruleOnly: [] as string[], ruleLlm: [] as string[] };
  const outcomes = new Map<string, { gross: number; net: number; costs: "actual" | "estimated"; evidence: "quoted" | "verified" } | null>();
  const seen = new Set<string>(); let featureReady = 0;
  for (const raw of input.candidates) {
    if (!record(raw) || typeof raw.token !== "string" || !/^0x[0-9a-f]{40}$/.test(raw.token)
      || seen.has(raw.token) || typeof raw.eligible !== "boolean" || !Number.isSafeInteger(raw.eligibilityObservedAt)
      || (raw.eligibilityObservedAt as number) <= 0 || (raw.eligibilityObservedAt as number) > decisionAt
      || !record(raw.baselineLlm) || !record(raw.enrichedLlm)) return fail();
    seen.add(raw.token);
    for (const decision of [raw.baselineLlm,raw.enrichedLlm]) {
      if (typeof decision.selected !== "boolean" || typeof decision.observationId !== "string"
        || !/^[a-zA-Z0-9_-]{1,80}$/.test(decision.observationId)
        || !Number.isSafeInteger(decision.observedAt) || (decision.observedAt as number) > decisionAt
        || (decision.observedAt as number) <= 0 || (decision.observedAt as number) < (raw.eligibilityObservedAt as number)) return fail();
    }
    if (raw.baselineLlm.observationId === raw.enrichedLlm.observationId) return fail();
    const features: TokenFeatures = {};
    if (raw.features !== undefined) {
      if (!record(raw.features) || !record(raw.pool) || typeof raw.pool.pool !== "string"
        || !/^0x[0-9a-f]{40}$/.test(raw.pool.pool) || raw.pool.tokenAddress !== raw.token
        || (raw.pool.currency !== "usd" && raw.pool.currency !== "token")) return fail();
      const pool = raw.pool as FeaturePool;
      for (const interval of ["15m", "1h"] as const) {
        if (raw.features[interval] === undefined) continue;
        const decoded = decodeFeature(raw.features[interval], pool, interval, decisionAt);
        if (!decoded || decoded.observedAt > (raw.enrichedLlm.observedAt as number)
          || decoded.calculatedAt > (raw.enrichedLlm.observedAt as number)) return fail();
        features[interval] = decoded;
      }
    }
    const rule = assessMomentum(features, decisionAt);
    if (rule.status !== "unavailable") featureReady++;
    if (raw.eligible) {
      if (raw.baselineLlm.selected) arms.baseline.push(raw.token);
      if (rule.status === "pass") arms.ruleOnly.push(raw.token);
      if (rule.status === "pass" && raw.enrichedLlm.selected) arms.ruleLlm.push(raw.token);
    }
    if (raw.outcome === null || raw.outcome === undefined) { outcomes.set(raw.token,null); continue; }
    const outcome = raw.outcome;
    if (!record(outcome) || outcome.notional !== notional || outcome.currency !== input.currency
      || !Number.isSafeInteger(outcome.entryAt) || !Number.isSafeInteger(outcome.exitAt)
      || (outcome.entryAt as number) < decisionAt || (outcome.exitAt as number) < (outcome.entryAt as number)
      || !Number.isSafeInteger(outcome.observedAt) || (outcome.observedAt as number) < (outcome.exitAt as number)
      || (outcome.evidence !== "quoted" && outcome.evidence !== "verified")
      || typeof outcome.proceeds !== "number" || !Number.isFinite(outcome.proceeds) || outcome.proceeds < 0
      || !record(outcome.costs) || (outcome.costs.kind !== "actual" && outcome.costs.kind !== "estimated")) return fail();
    let costs = 0;
    for (const key of ["relay", "platform", "model", "other"] as const) {
      const cost = outcome.costs[key];
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return fail();
      costs += cost;
    }
    if (!Number.isFinite(costs)) return fail();
    if (!Number.isFinite(outcome.proceeds - notional) || !Number.isFinite(outcome.proceeds - notional - costs)) return fail();
    outcomes.set(raw.token, { evidence: outcome.evidence, gross: outcome.proceeds - notional, net: outcome.proceeds - notional - costs, costs: outcome.costs.kind });
  }
  return { label: input.label, empiricalPerformanceClaim: false, evidenceVerification: "supplied-file-not-independent-on-chain-verification", decisionAt, currency: input.currency,
    candidates: seen.size, featureReady, arms: Object.fromEntries(Object.entries(arms).map(([name, selected]) => {
      const rows = selected.map(token => outcomes.get(token));
      const complete = rows.every(row => row !== null && row !== undefined);
      const gross = complete ? rows.reduce((sum,row) => sum + row!.gross,0) : null;
      const net = complete ? rows.reduce((sum,row) => sum + row!.net,0) : null;
      const deployedNotional = selected.length * notional;
      if (!Number.isFinite(deployedNotional) || (gross !== null && !Number.isFinite(gross)) || (net !== null && !Number.isFinite(net))) return fail();
      return [name, { selected, count: selected.length, deployedNotional, gross, net,
        meanNet: net !== null && selected.length > 0 ? net / selected.length : null,
        outcomeBasis: selected.length === 0 ? "no-trades" : complete ? rows.some(row => row!.evidence === "quoted") ? "includes-quotes" : "provided-verified" : "unknown",
        costBasis: selected.length === 0 ? "no-trades" : complete ? rows.some(row => row!.costs === "estimated") ? "includes-estimates" : "actual" : "unknown",
        reason: complete ? null : "missing-outcome-or-attributable-costs" }];
    })) };
}
