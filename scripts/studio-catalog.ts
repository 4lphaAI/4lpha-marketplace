import { pathToFileURL } from "node:url";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Operator diagnostic; all chain and seller reads stay behind the data plane. */
export async function readStudioCatalog(env: Readonly<Record<string, string | undefined>>, fetcher: typeof fetch = fetch): Promise<unknown> {
  const base = env["DATA_PLANE_URL"];
  const token = env["DATA_PLANE_TOKEN"];
  if (!base || !token) throw new Error("studio_data_plane_not_configured");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !["", "/"].includes(url.pathname)) throw new Error("studio_data_plane_not_configured");
  url.pathname = "/studio/agents";
  try {
    const response = await fetcher(url, { headers: { "x-dp-token": token, accept: "application/json" },
      signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok || !response.body) throw new Error("studio_catalog_unavailable");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        // Eight bounded seller responses are aggregated into one catalog.
        if (size > 4 * 1024 * 1024) throw new Error("studio_catalog_invalid");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(data) || !Array.isArray(data["data"]) || data["data"].length > 8 || !record(data["meta"])
      || !["fresh", "stale", "dead"].includes(String(data["meta"]["staleness"])) || "error" in data) throw new Error("studio_catalog_invalid");
    return data;
  } catch { throw new Error("studio_catalog_unavailable"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await readStudioCatalog(process.env), null, 2)); }
  catch { console.error("Studio catalog unavailable; check data-plane configuration and discovery status."); process.exitCode = 1; }
}
