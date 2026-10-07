/**
 * Inert-text filter for every user- or chain-chosen string the public MCP returns (token symbols, agent names).
 *
 * The text ends up in an LLM's context, so this is an ALLOWLIST: Unicode letters, numbers and symbols
 * (so a ticker like a butterfly emoji or a CJK name survives), combining marks except variation selectors,
 * a plain space, and `. _ - $ #`. Everything else is dropped: controls, newlines, tabs, zero-width and bidi
 * characters, the Unicode tag block (U+E0000..E007F, invisible ASCII smuggling), variation selectors,
 * interlinear annotation (U+FFF9..FFFB), brackets, quotes, backtick, `<` and `>`.
 * Truncation counts code points, so an astral character is never cut in half.
 */
const KEEP_CLASS = /^[\p{L}\p{N}\p{S}]$/u;
const MARK = /^\p{M}$/u;
const EXTRA_KEEP = new Set([" ", ".", "_", "-", "$", "#"]);
const DROP_SYMBOLS = new Set(["`", "<", ">"]);

function isVariationSelector(c: number): boolean {
  return (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef) || (c >= 0x180b && c <= 0x180d) || c === 0x180f;
}

function keep(ch: string): boolean {
  if (EXTRA_KEEP.has(ch)) return true;
  if (DROP_SYMBOLS.has(ch)) return false;
  const c = ch.codePointAt(0) ?? 0;
  if (MARK.test(ch)) return !isVariationSelector(c);
  return KEEP_CLASS.test(ch);
}

export function sanitizeText(value: unknown, maxCodePoints: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const kept = [...value].filter(keep).join("").replace(/ {2,}/gu, " ").trim();
  const clean = [...kept].slice(0, maxCodePoints).join("").trim();
  return clean === "" ? fallback : clean;
}

/** M5: a meme or stock symbol, 16 code points. */
export const sanitizeSymbol = (value: unknown): string => sanitizeText(value, 16, "unnamed");
/** An agent name chosen by whoever hired it: 48 code points. */
export const sanitizeAgentName = (value: unknown): string => sanitizeText(value, 48, "unnamed agent");
