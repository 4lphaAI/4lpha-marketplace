import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AGENTS } from "@/lib/design-data";
import { AgentDetailScreen } from "./AgentDetailScreen";

describe("marketplace trading explainers", () => {
  const cases = [
    ["vector-trader", "TradFi · Schedule buy · PancakeSwap v3"],
    ["atlas-trader", "TradFi · Auto DCA · PancakeSwap v3"],
    ["smart-portfolio", "TradFi · Smart Portfolio · PancakeSwap v3"],
  ] as const;

  it.each(cases)("renders the imported animation for %s", (id, marker) => {
    const agent = AGENTS.find((candidate) => candidate.id === id);
    expect(agent).toBeDefined();

    const html = renderToStaticMarkup(
      <AgentDetailScreen agent={agent} go={() => undefined} onHire={() => undefined} />,
    );

    expect(html).toContain("How this agent works");
    expect(html).toContain(marker);
    expect(html).toContain("Pause");
  });

  it("uses the tokenized-stocks animation for AI Stocks Trader", () => {
    const agent = AGENTS.find((candidate) => candidate.id === "yield-router");
    expect(agent).toBeDefined();

    const html = renderToStaticMarkup(
      <AgentDetailScreen agent={agent} go={() => undefined} onHire={() => undefined} />,
    );

    expect(html).toContain("It screens tokenized stocks as they appear");
    expect(html).toContain("NVDAB");
    expect(html).toContain("TOKENIZED US STOCKS ONLY");
    expect(html).not.toContain("PEPE / BNB");
    expect(html).not.toContain("MODELS DEGEN / SIGMA");
  });
});
