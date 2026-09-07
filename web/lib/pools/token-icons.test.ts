import { describe, expect, it } from "vitest";
import { tokenIconUrl } from "./token-icons";

describe("token icon lookup", () => {
  const address = "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436";
  it("resolves missing bStocks by address, while preserving listed logos", () => {
    expect(tokenIconUrl(new Map(), address)).toBe(`https://tokens.pancakeswap.finance/images/${address.toLowerCase()}.png`);
    expect(tokenIconUrl(new Map([[address.toLowerCase(), "https://example.org/icon.png"]]), address)).toBe("https://example.org/icon.png");
  });
  it("rejects non-address paths and non-HTTPS list entries", () => {
    expect(tokenIconUrl(new Map(), "../../secret")).toBeNull();
    expect(tokenIconUrl(new Map([[address.toLowerCase(), "javascript:alert(1)"]]), address)).toContain("https://tokens.pancakeswap.finance/images/");
  });
});
