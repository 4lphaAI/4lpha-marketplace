import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SIGMA_ANIMATIONS } from "./sigma-pet";
import {
  AGENTIC_GUIDE, ASSISTANT_COMMANDS, CODE_COMMANDS, COMMANDS, DESK_COMMANDS, GROUPS, LIMITS, LIVE_AGENTS, PRIZES, SIGMA_LINES, VIDEOS, FEATURED_VIDEOS, ipfs,
} from "./judge-data";
import { listedReports, loadDeskReport, parseReport } from "./desk-report";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const files = ["./judge-data.ts", "../components/judge/JudgeGuide.tsx", "../components/judge/SigmaHero.tsx", "../components/judge/run.tsx", "../app/judge/page.tsx"].map(read);
const guideSource = read("../components/judge/JudgeGuide.tsx");

const hrefs = [
  ...GROUPS.flatMap((g) => g.features.flatMap((f) => [...(f.see ?? []), ...f.evidence].map((e) => e.href))),
  ...PRIZES.flatMap((p) => p.links.map((l) => l.href)),
  ...AGENTIC_GUIDE.flatMap((s) => (s.links ?? []).map((l) => l.href)),
  ...PRIZES.flatMap((p) => (p.jobs ?? []).flatMap((j) => [j.fund, j.submit, j.report, ...(j.extra ? [j.extra.href] : [])])),
];
const allCommands = [...COMMANDS, ...DESK_COMMANDS, ...ASSISTANT_COMMANDS, ...CODE_COMMANDS];

describe("judge guide content", () => {
  it("contains no em dash (writing rule)", () => {
    for (const text of files) expect(text.includes("—")).toBe(false);
  });

  it("publishes only full tx hashes", () => {
    const txs = hrefs.filter((h) => h.includes("/tx/"));
    expect(txs.length).toBeGreaterThan(15);
    for (const h of txs) expect(h).toMatch(/^https:\/\/bscscan\.com\/tx\/0x[0-9a-f]{64}$/);
  });

  it("links only to https or in-page anchors, never to the www host", () => {
    for (const h of hrefs) expect(h.startsWith("https://") || h.startsWith("#")).toBe(true);
    const all = [...hrefs, ...allCommands.map((c) => c.cmd)].join("\n");
    expect(all).not.toContain("www.4lpha.tech");
  });

  it("gives every feature at least one piece of evidence", () => {
    for (const g of GROUPS) for (const f of g.features) expect(f.evidence.length).toBeGreaterThan(0);
  });

  it("lists full wallet addresses for the live agents", () => {
    for (const a of LIVE_AGENTS) expect(a.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("says Binance Wallet, never the Binance App", () => {
    const text = [...AGENTIC_GUIDE.flatMap((s) => [s.title, s.body, s.before ?? ""]), ...LIMITS, ...PRIZES.flatMap((p) => p.points),
      ...GROUPS.map((g) => g.sub), ...SIGMA_LINES.map((l) => l.text)].join("\n");
    expect(text).not.toMatch(/Binance App/i);
    expect(AGENTIC_GUIDE.find((s) => s.title.includes("Pair"))?.before).toMatch(/Agentic Wallet in Binance Wallet/);
  });

  it("runs in the browser only same-origin, and exactly the request the curl line shows", () => {
    const runnable = COMMANDS.filter((c) => c.run);
    expect(runnable.length).toBe(COMMANDS.length);
    for (const c of runnable) {
      const run = c.run!;
      expect(run.path.startsWith("/") && !run.path.startsWith("//")).toBe(true);
      expect(c.cmd).toContain(`https://4lpha.tech${run.path}`);
      if (run.body !== undefined) expect(c.cmd).toContain(`-d '${JSON.stringify(run.body)}'`);
    }
    for (const c of [...DESK_COMMANDS, ...ASSISTANT_COMMANDS, ...CODE_COMMANDS]) expect(c.run).toBeUndefined();
  });

  it("points every screenshot at a file in public/", () => {
    const shots = [...LIVE_AGENTS.map((a) => a.shot), ...AGENTIC_GUIDE.flatMap((s) => (s.image ? [s.image.src] : []))];
    expect(shots.length).toBeGreaterThan(5);
    for (const s of shots) expect(existsSync(fileURLToPath(new URL(`../public${s}`, import.meta.url)))).toBe(true);
  });

  it("keeps every MCP curl body valid JSON", () => {
    for (const c of COMMANDS.filter((x) => x.cmd.includes("/mcp"))) {
      const body = c.cmd.match(/-d '(.*)'$/)?.[1];
      expect(body).toBeDefined();
      expect(() => JSON.parse(body ?? "")).not.toThrow();
    }
  });
});

describe("Sigma and prizes", () => {
  it("uses only animation states the sprite sheet has", () => {
    expect(SIGMA_LINES.length).toBeGreaterThan(3);
    for (const l of SIGMA_LINES) expect(SIGMA_ANIMATIONS[l.state]).toBeDefined();
  });

  it("links every desk job to its fund tx, submit tx and IPFS report", () => {
    const jobs = PRIZES.flatMap((p) => p.jobs ?? []);
    expect(jobs.length).toBeGreaterThan(2);
    for (const j of jobs) {
      expect(j.fund).toMatch(/^https:\/\/bscscan\.com\/tx\/0x[0-9a-f]{64}$/);
      expect(j.submit).toMatch(/^https:\/\/bscscan\.com\/tx\/0x[0-9a-f]{64}$/);
      expect(j.cid).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
      expect(j.report).toBe(`https://4lpha.tech/judge/report/${j.cid}`);
      expect(ipfs(j.cid)).toBe(`https://gateway.pinata.cloud/ipfs/${j.cid}`);
    }
    expect(new Set(jobs.map((j) => j.cid)).size).toBe(jobs.length);
  });
  it("parses the desk report Markdown subset and serves only listed CIDs", async () => {
    const blocks = parseReport("# T\n## S\n- a\n- b\n\n| h1 | h2 |\n| --- | --- |\n| x | y |\n---\nplain");
    expect(blocks.map((b) => b.kind)).toEqual(["h1", "h2", "ul", "table", "hr", "p"]);
    expect(blocks[3]).toEqual({ kind: "table", head: ["h1", "h2"], rows: [["x", "y"]] });
    expect(await loadDeskReport("QmNotListed1111111111111111111111111111111111")).toBe("unlisted");
    expect(listedReports().size).toBe(PRIZES.flatMap((p) => p.jobs ?? []).length);
  });
  it("has one distinct video per strategy, each id matching its link", () => {
    expect(VIDEOS.map((v) => v.mode).sort()).toEqual(["AI Trade", "Auto DCA", "Schedule buy", "Smart Portfolio"]);
    const all = [...VIDEOS, ...FEATURED_VIDEOS];
    expect(new Set(all.map((v) => v.id)).size).toBe(all.length);
    for (const v of all) expect(v.url === "https://youtu.be/" + v.id || v.url.startsWith("https://youtu.be/" + v.id + "?")).toBe(true);
  });
});
