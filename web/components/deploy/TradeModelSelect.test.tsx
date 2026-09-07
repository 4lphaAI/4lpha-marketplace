import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TRADE_LLM_MODELS } from "@/lib/trade";
import { TradeModelSelect } from "./TradeModelSelect";

describe("TradeModelSelect", () => {
  it("shows all four models and disables only the counterpart selection", () => {
    const options = TRADE_LLM_MODELS.map((model) => model.label);
    const html = renderToStaticMarkup(<TradeModelSelect label="Primary model" value={options[0]!}
      options={options} disabledValue={options[1]!} onChange={vi.fn()} />);
    expect((html.match(/<option/gu) ?? []).length).toBe(4);
    expect((html.match(/disabled=""/gu) ?? []).length).toBe(1);
    expect(html).toContain(`value="${options[1]}" disabled=""`);
    expect(html).not.toMatch(/<select[^>]*disabled/gu);
  });
});
