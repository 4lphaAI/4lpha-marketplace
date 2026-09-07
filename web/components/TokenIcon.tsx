"use client";

import * as React from "react";

/**
 * One token badge, and the overlapping pair the pool rows use. Lives here
 * rather than inside a screen because the deploy picker and the agent detail
 * page must draw the same badge — a second copy is how two screens drift.
 *
 * `src` is a final image URL resolved SERVER-side (see `lib/pools/token-icons.ts`);
 * the browser never reads a token list itself. A missing or broken image
 * degrades to the symbol's first letter, never to a broken-image glyph.
 */
export function TokenIcon({ src, symbol, size = 26, offset = 0 }: {
  readonly src: string | null;
  readonly symbol: string | null;
  readonly size?: number;
  readonly offset?: number;
}) {
  const [brokenSrc, setBrokenSrc] = React.useState<string | null>(null);
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: 999,
    flex: "0 0 auto",
    border: "1px solid rgba(255,255,255,0.16)",
    marginLeft: offset,
    background: "var(--surface-sunken)",
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
  };
  if (src === null || src === brokenSrc) {
    return (
      <span style={{ ...style, color: "var(--text-subtle)", font: `600 ${Math.floor(size / 2.2)}px/1 var(--font-sans)` }}>
        {(symbol ?? "?").slice(0, 1)}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={symbol ?? ""} style={style} onError={() => setBrokenSrc(src)} />;
}

export function PairIcons({ token0, token1, size = 26 }: {
  readonly token0: { readonly src: string | null; readonly symbol: string | null };
  readonly token1: { readonly src: string | null; readonly symbol: string | null };
  readonly size?: number;
}) {
  return (
    <span style={{ display: "flex", alignItems: "center", flex: "0 0 auto" }}>
      <TokenIcon src={token0.src} symbol={token0.symbol} size={size} />
      <TokenIcon src={token1.src} symbol={token1.symbol} size={size} offset={-Math.round(size / 2.9)} />
    </span>
  );
}
