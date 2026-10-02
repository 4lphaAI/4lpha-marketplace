/** Fixed model doctrine; owner prose is advisory and cannot replace these rules (R7). */
import type { TradeExecutionModel } from "./settings.js";

export const BLUE_CHIP_DOCTRINE =
  "Use conservative momentum timing: prefer liquid continuation or a clean reclaim, avoid chasing an extended move, and wait when volume no longer confirms price.";

export const TRADFI_DOCTRINE =
  "Trade tokenized US equities against their reference price: prefer liquid names whose on-chain price sits at or below the underlying, enter on orderly continuation or a clean reclaim, and never chase a premium.";

export const MID_CAP_DOCTRINE =
  "Use conservative momentum timing: require sustained volume and orderly price follow-through, prefer a pullback or reclaim to an overheated entry, and reject weakening tape.";

export const DEGEN_DOCTRINE =
  "For low-market-cap tokens, favor a genuine revival with expanding short-term volume; avoid dead or collapsing charts and reject duplicate-symbol ambiguity even when a feed score is high.";

export const SIGMA_DOCTRINE =
  "Across the eligible universe, favor low-cap revival and durable volume expansion when present; avoid dead-chart entries, fading follow-through, and duplicate-symbol ambiguity.";

export const TRADE_DOCTRINE: Readonly<Record<TradeExecutionModel, string>> = {
  tradfi: TRADFI_DOCTRINE,
  "blue-chip": BLUE_CHIP_DOCTRINE,
  "mid-cap": MID_CAP_DOCTRINE,
  degen: DEGEN_DOCTRINE,
  sigma: SIGMA_DOCTRINE,
};
