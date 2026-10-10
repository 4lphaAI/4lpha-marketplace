import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";

import { loadDeskReport, parseReport, type Block } from "@/lib/desk-report";
import { DESK_URL, PRIZES } from "@/lib/judge-data";

/**
 * Readable view of one bStock Desk deliverable from the judge guide. Only the CIDs listed in the guide are
 * served (anything else is a 404). Text is rendered as React text, never as HTML.
 */
export const metadata: Metadata = {
  title: "4lpha bStock Desk · Report",
  robots: { index: false, follow: false },
};

export const revalidate = 86400;

const CSS = `
.fl-dr{max-width:960px;margin:0 auto;padding:32px 24px 96px;color:var(--ink-1);font:var(--type-body)}
.fl-dr a{color:var(--brand);text-decoration:none}.fl-dr a:hover{text-decoration:underline}
.fl-dr-meta{display:flex;flex-wrap:wrap;gap:8px 18px;padding:14px 16px;margin:0 0 28px;border:1px solid var(--line-1);border-radius:var(--radius-sm);background:var(--surface-sunken);color:var(--text-subtle);font:var(--type-label)}
.fl-dr h1{font:var(--weight-semibold) var(--text-2xl)/1.25 var(--font-sans);margin:0 0 6px}
.fl-dr h2{font:var(--weight-semibold) var(--text-lg)/1.3 var(--font-sans);margin:30px 0 10px;color:var(--ink-1)}
.fl-dr p{margin:6px 0;color:var(--ink-2);line-height:1.6}
.fl-dr ul{margin:6px 0;padding-left:20px;color:var(--ink-2);line-height:1.6}
.fl-dr code{font:var(--weight-medium) 13px/1.4 var(--font-mono);color:var(--brand)}
.fl-dr hr{border:0;border-top:1px solid var(--line-1);margin:28px 0}
.fl-dr-tw{overflow-x:auto;border:1px solid var(--line-1);border-radius:var(--radius-sm);background:var(--surface-sunken);margin:10px 0}
.fl-dr table{width:100%;border-collapse:collapse}
.fl-dr th{text-align:left;font:var(--type-label);color:var(--text-subtle);padding:9px 12px;border-bottom:1px solid var(--line-1);white-space:nowrap}
.fl-dr td{padding:9px 12px;border-bottom:1px solid var(--line-1);color:var(--ink-2);white-space:nowrap}
.fl-dr tr:last-child td{border-bottom:0}
@media (max-width:640px){.fl-dr{padding:24px 16px 64px}}
`;

/** Inline `code` spans; everything else stays plain text. */
function Inline({ text }: { text: string }) {
  const parts = text.split("`");
  return <>{parts.map((p, i) => (i % 2 === 1 ? <code key={i}>{p}</code> : <React.Fragment key={i}>{p}</React.Fragment>))}</>;
}

function Render({ b }: { b: Block }) {
  if (b.kind === "h1") return <h1><Inline text={b.text} /></h1>;
  if (b.kind === "h2") return <h2><Inline text={b.text} /></h2>;
  if (b.kind === "hr") return <hr />;
  if (b.kind === "ul") return <ul>{b.items.map((t, i) => <li key={i}><Inline text={t} /></li>)}</ul>;
  if (b.kind === "table") {
    return (
      <div className="fl-dr-tw">
        <table>
          <thead><tr>{b.head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  return <p><Inline text={b.text} /></p>;
}

export default async function Page({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const report = await loadDeskReport(cid);
  if (report === "unlisted") notFound();
  const job = PRIZES.flatMap((p) => p.jobs ?? []).find((j) => j.cid === cid);
  const raw = `https://gateway.pinata.cloud/ipfs/${cid}`;
  return (
    <main className="fl-dr">
      <style>{CSS}</style>
      <div className="fl-dr-meta">
        <span>4lpha bStock Desk · ERC-8183 job #{job?.id ?? report?.jobId ?? "?"}</span>
        <a href={raw} target="_blank" rel="noreferrer">Raw deliverable on IPFS</a>
        {job && <a href={job.submit} target="_blank" rel="noreferrer">Submit tx</a>}
        {job && <a href={job.fund} target="_blank" rel="noreferrer">Fund tx</a>}
        <a href={`${DESK_URL}/.well-known/agent-card.json`} target="_blank" rel="noreferrer">Agent card</a>
        <a href="/judge#prizes">Back to the judge guide</a>
      </div>
      {report === null ? (
        <p>The IPFS gateways did not return this report right now. Open the <a href={raw}>raw deliverable</a> instead.</p>
      ) : (
        parseReport(report.markdown).map((b, i) => <Render key={i} b={b} />)
      )}
    </main>
  );
}
