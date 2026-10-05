"use client";
import * as React from "react";
import { toDataURL } from "qrcode";

export function PairingQr({ urlForWeb, size = 256 }: { urlForWeb: string; size?: number }) {
  const [image, setImage] = React.useState<string | null>(null);
  React.useEffect(() => { let active = true; void toDataURL(urlForWeb, { errorCorrectionLevel: "M", margin: 2, width: 256 }).then(value => { if (active) setImage(value); });
    return () => { active = false; }; }, [urlForWeb]);
  let safe = false;
  try { const url = new URL(urlForWeb); safe = url.protocol === "https:" && url.hostname === "app.binance.com"; } catch { /* Refuse a malformed link. */ }
  return <div style={{ display: "grid", gap: 8, justifyItems: "center" }}>
    {image !== null ? <img src={image} width={size} height={size} alt="Scan with the Binance App" style={{ display: "block", borderRadius: "var(--radius-sm)", border: "1px solid var(--line-2)" }} />
      : <span aria-hidden="true" style={{ width: size, height: size, borderRadius: "var(--radius-sm)", border: "1px solid var(--line-2)", background: "var(--surface-sunken)" }} />}
    {safe && <a href={urlForWeb} target="_blank" rel="noopener noreferrer" style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", textDecoration: "underline" }}>Open in Binance App</a>}</div>;
}
