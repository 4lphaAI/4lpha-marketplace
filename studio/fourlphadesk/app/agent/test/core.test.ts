/**
 * The seller core drives the desk: a funded job's own task reaches the work hook (RunWork opts.job), the
 * report is what gets submitted, and a job that is not understood still delivers the formats note.
 * Signing is replaced by a fake through the core's own test seam; nothing here touches a wallet or a chain.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearBackdropCache } from "../src/desk/handlers.js";
import { buildDeliverable, runSerially } from "../src/desk/index.js";
import { clearHireCache } from "../src/desk/mcp.js";
import { SellerCore, type RunWork, type SigningApi } from "../src/sellerCore.js";
import { rig } from "./helpers.js";

beforeEach(() => {
  clearBackdropCache();
  clearHireCache();
});

function fakeSigning(task: string, terms: Record<string, unknown>, submitted: { id: number; text: string }[]): SigningApi {
  return {
    listPrice: () => 100000000000000000n,
    clampPrice: (x) => x,
    signQuote: async () => ({}),
    verifySignedJob: async () => ({ ok: true, reason: "", permanent: false }),
    jobSpec: async () => ({ task, terms }),
    submitResult: async (id, text) => {
      submitted.push({ id, text });
      return { submitTx: "0xtx", deliverableUrl: "ipfs://cid" };
    },
  };
}

async function deliver(task: string, terms: Record<string, unknown> = {}): Promise<{ id: number; text: string }[]> {
  const submitted: { id: number; text: string }[] = [];
  const r = rig();
  const runWork: RunWork = (prompt, opts) =>
    runSerially(async () => (await buildDeliverable(opts.job ?? { task: prompt, terms: null }, { ...r.deps, jobKey: opts.sessionId })).markdown);
  const core = new SellerCore({
    runWork,
    generator: "test",
    network: "bsc-mainnet",
    signing: fakeSigning(task, terms, submitted),
    pendingJobs: async () => ({ jobs: [] }),
  });
  const ack = await core.notifyFunded({ job_id: 42 });
  assert.equal(ack.status, "accepted");
  await core.drain();
  return submitted;
}

describe("SellerCore with the desk work hook", () => {
  it("submits the stock report for a funded job whose task holds the request", async () => {
    const s = await deliver('{"type":"stock_report","ticker":"NVDA","usdt":500}');
    assert.equal(s.length, 1);
    assert.equal(s[0]?.id, 42);
    assert.ok(s[0]?.text.startsWith("# 4lpha bStock Desk: stock report NVDA"));
    assert.ok(s[0]?.text.includes("not investment advice"));
  });
  it("submits a plan for a dca_plan task", async () => {
    const s = await deliver('{"type":"dca_plan","ticker":"NVDAB","usdt":200}');
    assert.ok(s[0]?.text.includes("## Plan (Auto DCA)"));
    assert.ok(s[0]?.text.trimEnd().includes("https://4lpha.tech/deploy/trading"));
  });
  it("a task that is not a request still delivers the accepted formats", async () => {
    const s = await deliver("hello there");
    assert.equal(s.length, 1);
    assert.ok(s[0]?.text.startsWith("# 4lpha bStock Desk: request not understood"));
  });
  it("reads the request from the terms when the task is only a pointer", async () => {
    const s = await deliver("see terms", { deliverables: '{"type":"stock_report","ticker":"NVDA"}' });
    assert.ok(s[0]?.text.startsWith("# 4lpha bStock Desk: stock report NVDA"));
  });
});
