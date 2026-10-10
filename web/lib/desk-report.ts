/**
 * Readable view of the bStock Desk deliverables listed on the judge guide. The deliverable is the BNB Agent
 * Studio manifest JSON pinned on IPFS (`response.content` holds the Markdown report), which a browser shows
 * as one escaped line. Only CIDs listed in the guide's job table are served, so the page can never be used
 * to render arbitrary content under 4lpha.tech, and the fetch only ever targets fixed public gateways.
 */

import { PRIZES } from "@/lib/judge-data";

const GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];
const MAX_BYTES = 256 * 1024;

export interface DeskReport {
  readonly cid: string;
  readonly jobId: string | null;
  readonly markdown: string;
}

/** CIDs of the deliverables the judge guide lists, with their job ids. */
export function listedReports(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const p of PRIZES) for (const j of p.jobs ?? []) out.set(j.cid, j.id);
  return out;
}

async function fetchOne(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), next: { revalidate: 86_400 } });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > MAX_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The report for a listed CID, or null when the CID is not listed or no gateway returned a manifest. */
export async function loadDeskReport(cid: string): Promise<DeskReport | null | "unlisted"> {
  const listed = listedReports();
  const jobId = listed.get(cid);
  if (jobId === undefined) return "unlisted";
  for (const g of GATEWAYS) {
    const doc = await fetchOne(`${g}${cid}`).catch(() => null);
    const r = (doc as { response?: { content?: unknown }; job_id?: unknown } | null);
    if (r && typeof r.response?.content === "string") {
      return { cid, jobId: String(r.job_id ?? jobId), markdown: r.response.content.slice(0, MAX_BYTES) };
    }
  }
  return null;
}

export type Block =
  | { kind: "h1" | "h2" | "p" | "hr"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** The small Markdown subset the desk writes: headings, bullets, pipe tables, rules and paragraphs. */
export function parseReport(md: string): Block[] {
  const lines = md.replace(/\r/g, "").split("\n");
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (line.startsWith("# ")) { out.push({ kind: "h1", text: line.slice(2).trim() }); continue; }
    if (line.startsWith("## ")) { out.push({ kind: "h2", text: line.slice(3).trim() }); continue; }
    if (line.trim() === "---") { out.push({ kind: "hr", text: "" }); continue; }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(lines[i++].slice(2).trim());
      i--;
      out.push({ kind: "ul", items });
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      i--;
      const [head, ...rest] = rows;
      out.push({ kind: "table", head: head ?? [], rows: rest.filter((r) => !r.every((c) => /^-+$/.test(c))) });
      continue;
    }
    out.push({ kind: "p", text: line.trim() });
  }
  return out;
}
