import { describe, expect, it } from "vitest";
import { pairQuoting, priceAtTick, resolvePair, USDT_56, WBNB_56 } from "./pairs";

/**
 * The gap this closes, from a live hire: the deploy screen arms a grid on ANY
 * PancakeSwap V3 pool with a WBNB leg, while the detail page resolved pairs
 * from a six-address majors table — so a four.meme pool rendered with no name,
 * no prices and no sizes even though the data plane knew the token perfectly
 * well.
 */
describe("resolvePair beyond the majors", () => {
  const MUBARAK = "0x5c85d6c6825ab4032337f11ee92a72df936b46f6";

  it("resolves a non-major leg from data-plane metadata", () => {
    const pair = resolvePair(56, MUBARAK, WBNB_56, false, {
      [MUBARAK]: { symbol: "mubarak", decimals: 18 },
    });
    expect(pair?.symbol0).toBe("mubarak");
    expect(pair?.decimals0).toBe(18);
    expect(pair?.symbol1).toBe("WBNB");
  });

  it("refuses the pair when decimals are missing — a guessed scale is a wrong price", () => {
    expect(resolvePair(56, MUBARAK, WBNB_56, false, {
      [MUBARAK]: { symbol: "mubarak", decimals: Number.NaN },
    })).toBeNull();
    expect(resolvePair(56, MUBARAK, WBNB_56, false, {})).toBeNull();
    expect(resolvePair(56, MUBARAK, WBNB_56, false)).toBeNull();
  });

  it("honours non-18 decimals in the price it derives", () => {
    const six = resolvePair(56, MUBARAK, WBNB_56, false, { [MUBARAK]: { symbol: "SIX", decimals: 6 } });
    const eighteen = resolvePair(56, MUBARAK, WBNB_56, false, { [MUBARAK]: { symbol: "TEEN", decimals: 18 } });
    expect(six).not.toBeNull();
    expect(eighteen).not.toBeNull();
    expect(priceAtTick(0, six as NonNullable<typeof six>)).not.toBe(priceAtTick(0, eighteen as NonNullable<typeof eighteen>));
  });

  it("ranks the numeraire by ADDRESS, so a token naming itself USDT cannot invert the price", () => {
    const liar = resolvePair(56, MUBARAK, WBNB_56, false, { [MUBARAK]: { symbol: "USDT", decimals: 18 } });
    expect(liar).not.toBeNull();
    const quoting = pairQuoting(liar as NonNullable<typeof liar>);
    expect(quoting.quote).toBe("WBNB");
    expect(quoting.base).toBe("USDT");
    expect(quoting.invert).toBe(false);
  });

  it("still needs a WBNB leg and an honest orientation claim", () => {
    const meta = { [MUBARAK]: { symbol: "mubarak", decimals: 18 } };
    expect(resolvePair(56, MUBARAK, USDT_56, false, meta)).toBeNull();
    expect(resolvePair(56, MUBARAK, WBNB_56, true, meta)).toBeNull();
  });

  it("keeps an attacker-controlled symbol short and printable", () => {
    const noisy = resolvePair(56, MUBARAK, WBNB_56, false, {
      [MUBARAK]: { symbol: `  ab${String.fromCharCode(7)}cd${"x".repeat(40)}  `, decimals: 18 },
    });
    expect(noisy?.symbol0).toBe("abcdxxxxxxxx");
    expect(resolvePair(56, MUBARAK, WBNB_56, false, { [MUBARAK]: { symbol: "   ", decimals: 18 } })).toBeNull();
  });
});
