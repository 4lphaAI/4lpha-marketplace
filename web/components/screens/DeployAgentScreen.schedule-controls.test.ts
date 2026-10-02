import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source-text assertions, matching the style of `.trading-controls.test.ts`:
// the file is `@ts-nocheck` ported design JSX with no exported internals, so
// its schedule-mode controls are pinned at the text level rather than rendered.
const deploySource = readFileSync(new URL("./DeployAgentScreen.tsx", import.meta.url), "utf8");

describe("Schedule buy control presentation", () => {
  it("never allows Weekly to be selected", () => {
    expect(deploySource).toContain('disabled={o === "Weekly"} aria-disabled={o === "Weekly"} title={o === "Weekly" ? "Needs a session longer than 7 days." : undefined} onClick={() => o !== "Weekly" && set("schedFreq", o)}');
  });

  it("blocks deploy with the exact copy for every schedule validation rule", () => {
    expect(deploySource).toContain('return "Amount per buy must be at least 5 USDT.";');
    expect(deploySource).toContain('return "Total budget must be at least the amount per buy.";');
    expect(deploySource).toContain('return "Total budget must cover at least one buy plus the platform fee.";');
    expect(deploySource).toContain('return "Select a quoted bStock.";');
    expect(deploySource).toContain('return "The schedule end date must be in the future.";');
    expect(deploySource).toContain('return "First buy must fall inside the 7-day session.";');
  });

  it("shows the session-buys hint and the derived N-buys hint under Total budget", () => {
    expect(deploySource).toContain("Your 7-day session covers up to {estimate.buysThisSession} buys; {estimate.plannedBuys} are planned. Renew the session after it expires to continue.");
    expect(deploySource).toContain("buys at the amount per buy above.");
  });

  it("renders the bStock picker in the Agent grid row with symbol-only options and the chosen token's logo inside the control", () => {
    expect(deploySource).toContain('<button id="fl-sel-tokenized-stock" type="button" className="fl-select"');
    expect(deploySource).toContain('<div role="listbox" aria-label="Tokenized stock"');
    expect(deploySource).toContain("<TokenIcon src={icons[token.address.toLowerCase()] ?? null} symbol={token.symbol} size={20} />");
    expect(deploySource).toContain('<span className="fl-select__chev"><Icon name="chevron-down" size={15} /></span>');
    expect(deploySource).not.toContain("bstockSelect\").split");
    expect(deploySource).not.toContain('f.type === "bstockSelect").map');
  });

  it("keeps the two advanced-settings RPC checkboxes out of the signed tradeSettings tuple", () => {
    const tradeSettingsStart = deploySource.indexOf("const tradeSettings = id ===");
    const tradeSettingsBlock = deploySource.slice(tradeSettingsStart, deploySource.indexOf("} satisfies TradeSettings) : null;", tradeSettingsStart));
    expect(tradeSettingsBlock).not.toContain("quicknode");
    expect(tradeSettingsBlock).not.toContain("customRpc");
    expect(tradeSettingsBlock).toContain("values.gas");
  });

  it("moves the two long schedule explanations into the info-glyph tooltip instead of visible paragraphs", () => {
    expect(deploySource).toContain('tooltip={first === "Now" ? "The first cycle runs as soon as the agent is deployed, then repeats on the frequency above." : "The first cycle runs at the date and time you pick, then repeats on the frequency above."}');
    expect(deploySource).toContain('tooltip="A breach postpones that cycle instead of cancelling it: the buy is skipped for the period and the schedule resumes at the next cycle once the premium is back inside the limit — the same behaviour as a buy price range. The platform never buys above +1.5% regardless."');
    // Slippage keeps its own visible hint; only the two long explanations moved.
    expect(deploySource).toContain('<FieldLabel label="Slippage tolerance" hint="Between 0.5% and 5%.">');
    // The glyph itself: FieldLabel renders `tooltip` as the same info-glyph span the generic per-field renderer uses.
    expect(deploySource).toContain("function FieldLabel({ label, hint, tooltip, children })");
    expect(deploySource).toContain('aria-label={tooltip} title={tooltip} tabIndex={0}');
  });
});
