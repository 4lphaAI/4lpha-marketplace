import React from "react";
import { RESOURCES } from "@/lib/design-resources";

/**
 * "AI models by 0G" — the credit for the inference the LLM brain runs on,
 * sitting under the tile's "LLM model: …" line.
 *
 * It is a row of its own under the note. The execution-model tile shares a
 * grid row with tiles that carry no credit, so this makes it the tallest and
 * grows the whole row by ~25px (trade) / ~23px (LP) — accepted deliberately
 * over squeezing it into the tile's bottom padding band, which read as
 * cramped. The label is sans, not the tile's mono, so the credit stays 95px
 * wide and fits the narrowest tile (LP, 168px) on one line.
 */
export function ZeroGCredit() {
  return <span className="fl-0g-credit">
    <span className="fl-0g-credit__label">AI models by</span>
    <img src={RESOURCES.zeroG} alt="0G" />
  </span>;
}
