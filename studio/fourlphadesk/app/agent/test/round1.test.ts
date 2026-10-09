/** Fix round 1 (review REVIEW.md): H1 guard, M0 Binance App settings, M1 deadline, M2 ambiguous payment, M3 runs rule, LOWs. */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearBackdropCache, dcaPlanReport, rebalanceReport, stockReport } from "../src/desk/handlers.js";
import { buildDeliverable, buildDeskRunWork, DEADLINE_SHARE, safeReason } from "../src/desk/index.js";
import { clearHireCache, type McpClient } from "../src/desk/mcp.js";
import { acceptSummary } from "../src/desk/prose.js";
import { editedHire, err, liveResponder, ok, paidOk, rig, type Call, type Responder } from "./helpers.js";

beforeEach(() => {
  clearBackdropCache();
  clearHireCache();
});

const job = (task: string) => ({ task, terms: null });
const DCA = '{"type":"dca_plan","ticker":"NVDAB","usdt":200}';
const SCHED = (usdt: number) => `{"type":"dca_plan","ticker":"NVDA","usdt":${usdt},"mode":"schedule","days":7}`;
const REB = '{"type":"rebalance_plan","capital":150,"weights":{"NVDA":40,"MSFT":30,"SPY":30}}';
const REPORT = '{"type":"stock_report","ticker":"NVDA","usdt":500}';

describe("H1: a funded job always gets a deliverable", () => {
  it("a throw after some data was read delivers 'could not complete' with the sections computed so far", async () => {
    const r = rig({ respond: liveResponder({ bstock_analysis: () => { throw new Error("boom in analysis"); } }) });
    const b = await buildDeliverable(job(DCA), r.deps);
    assert.ok(b.markdown.startsWith("# 4lpha bStock Desk: could not complete"));
    assert.ok(b.markdown.includes("boom in analysis"));
    assert.ok(b.markdown.includes("The problem is on the desk side, not in the request"));
    assert.ok(!b.markdown.includes("request not understood"));
    assert.ok(b.markdown.includes("## Sections computed before the problem"));
    assert.ok(b.markdown.includes("## Where to buy"), "the comparison read before the failure is kept");
    assert.ok(b.markdown.includes("not investment advice"));
    assert.equal(r.buyCalls.length, 0);
  });
  it("a throw before anything was computed says so", async () => {
    const r = rig({ respond: () => { throw new Error("down"); } });
    const b = await buildDeliverable(job(REB), r.deps);
    assert.ok(b.markdown.includes("No section was computed before the problem."));
    assert.ok(b.markdown.startsWith("# 4lpha bStock Desk: could not complete"));
  });
  it("covers all three job types and a throw from the model or the payment code", async () => {
    for (const task of [REPORT, DCA, SCHED(200), REB]) {
      const b = await buildDeliverable(job(task), rig({ respond: () => { throw new TypeError("kaput"); } }).deps);
      assert.ok(b.markdown.includes("TypeError: kaput"), task);
    }
    const payThrows = rig({ buy: async () => { throw new Error("wallet locked"); } });
    const ok1 = await buildDeliverable(job(REPORT), payThrows.deps);
    assert.ok(ok1.markdown.includes("crypto backdrop: unavailable (Error)"), "a payment error is a section, not a failure");
  });
  it("the reason is sanitised: no markup, no newline, bounded", () => {
    const r = safeReason(new Error("bad\n[x](http://evil.example) `code` | " + "y".repeat(500)));
    assert.ok(!/[\n\[\]`|]/.test(r));
    assert.ok(r.length <= 150);
    assert.equal(safeReason("not an error"), "unexpected error");
  });
  it("the real trigger is gone: a non-integer order limit in the hire sentence is ignored, the plan still builds", async () => {
    const hire = editedHire("agentic-dca", "max DCA orders 1 to 8", "max DCA orders 1 to 1.5");
    const r = rig({ respond: liveResponder({ get_hire_link: () => ok(hire) }) });
    const b = await buildDeliverable(job(DCA), r.deps);
    assert.ok(b.markdown.startsWith("# 4lpha bStock Desk: DCA plan"));
    assert.ok(b.markdown.includes("Built-in values used because the sentence could not be read: maxOrders"));
  });
});

describe("M0: the Binance App settings the Deploy check verifies", () => {
  it("DCA: the list from the link, with the daily limit worked out for this plan's capital (10 x 200)", async () => {
    const b = await dcaPlanReport({ type: "dca_plan", ticker: "NVDAB", usdt: 200, mode: "dca", days: 7 }, rig().deps);
    for (const s of [
      "## Before you deploy: Binance App settings",
      "- Connected, with Trade all tokens switched on in the Binance App.",
      "- Abnormal transactions set to AutoReject.",
      "- Max sign-in duration long enough for the term",
      "- Daily limit of at least 10 x the capital. For this plan: at least 2000.00 USDT.",
      "- x402 daily limit of at least 0.50 USDT.",
    ]) assert.ok(b.markdown.includes(s), s);
    assert.ok(b.markdown.indexOf("## Before you deploy") < b.markdown.indexOf("## Run it"));
  });
  it("Schedule: 2 x the budget and no x402 row", async () => {
    const b = await dcaPlanReport({ type: "dca_plan", ticker: "NVDA", usdt: 200, mode: "schedule", days: 7 }, rig().deps);
    assert.ok(b.markdown.includes("- Daily limit of at least 2 x the capital. For this plan: at least 400.00 USDT."));
    const section = b.markdown.slice(b.markdown.indexOf("## Before you deploy"), b.markdown.indexOf("## Run it"));
    assert.ok(!/x402/i.test(section));
  });
  it("Portfolio: 10 x the capital", async () => {
    const b = await rebalanceReport({ type: "rebalance_plan", capital: 150, weights: [{ ticker: "NVDA", weightPct: 40 }, { ticker: "MSFT", weightPct: 30 }, { ticker: "SPY", weightPct: 30 }] }, rig().deps);
    assert.ok(b.markdown.includes("- Daily limit of at least 10 x the capital. For this plan: at least 1500.00 USDT."));
    assert.ok(b.markdown.includes("- x402 daily limit of at least 0.50 USDT."));
  });
  it("a changed multiple on the link is followed", async () => {
    const hire = editedHire("agentic-dca", "Daily limit of at least 10 x the capital", "Daily limit of at least 12 x the capital");
    const b = await dcaPlanReport({ type: "dca_plan", ticker: "NVDAB", usdt: 200, mode: "dca", days: 7 }, rig({ respond: liveResponder({ get_hire_link: () => ok(hire) }) }).deps);
    assert.ok(b.markdown.includes("For this plan: at least 2400.00 USDT."));
  });
  it("when the link cannot be read the built-in list is shown and labelled", async () => {
    const b = await dcaPlanReport({ type: "dca_plan", ticker: "NVDAB", usdt: 200, mode: "dca", days: 7 }, rig({ respond: liveResponder({ get_hire_link: () => err("network") }) }).deps);
    assert.ok(b.markdown.includes("This list is the built-in one"));
    assert.ok(b.markdown.includes("at least 2000.00 USDT"));
  });
  it("the daily limit follows the capital the plan really delegates (137 USDT budget delegates 135)", async () => {
    const b = await dcaPlanReport({ type: "dca_plan", ticker: "NVDAB", usdt: 137, mode: "dca", days: 7 }, rig().deps);
    assert.ok(b.markdown.includes("| Total delegated | 135.00 USDT |"));
    assert.ok(b.markdown.includes("For this plan: at least 1350.00 USDT."));
  });
  it("sections are kept as they are computed, so a failure or the deadline can still deliver them", async () => {
    const progress = { sections: [] as string[] };
    const r = rig();
    await dcaPlanReport({ type: "dca_plan", ticker: "NVDAB", usdt: 200, mode: "dca", days: 7 }, { ...r.deps, progress });
    const text = progress.sections.join("\n");
    assert.ok(text.includes("## Where to buy"));
    assert.ok(text.includes("Venue price: 236.97 USD"));
    assert.ok(text.includes("## Crypto backdrop"));
    const sr = { sections: [] as string[] };
    await stockReport({ type: "stock_report", ticker: "NVDA", usdt: 500 }, { ...rig().deps, progress: sr });
    assert.ok(sr.sections.join("\n").includes("## Technical reading"));
    const rb = { sections: [] as string[] };
    await rebalanceReport({ type: "rebalance_plan", capital: 150, weights: [{ ticker: "NVDA", weightPct: 50 }, { ticker: "MSFT", weightPct: 50 }] }, { ...rig().deps, progress: rb });
    assert.ok(rb.sections.join("\n").includes("- NVDA: allocation 75.00 USDT, quote comparison read."));
  });
  it("an over-budget DCA request still gets the section, sized for the budget", async () => {
    const b = await dcaPlanReport({ type: "dca_plan", ticker: "NVDAB", usdt: 20, mode: "dca", days: 7 }, rig().deps);
    assert.ok(b.markdown.includes("at least 200.00 USDT"));
  });
});

describe("M1: the deadline stops the work", () => {
  it("an aborted signal starts no request, no payment and no model call", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = rig({ llm: async () => "never" });
    const b = await stockReport({ type: "stock_report", ticker: "NVDA", usdt: 500 }, { ...r.deps, signal: ctl.signal });
    assert.equal(r.client.calls.length, 0);
    assert.equal(r.buyCalls.length, 0);
    assert.ok(b.markdown.includes("quote comparison: unavailable (aborted)"));
    assert.ok(b.markdown.includes("The delivery time limit was reached"));
    assert.equal(b.backdrop, "none");
  });
  it("buildDeliverable on an already-aborted signal delivers the 'before work started' note", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = rig();
    const b = await buildDeliverable(job(REPORT), { ...r.deps, signal: ctl.signal });
    assert.ok(b.markdown.includes("the delivery time limit was reached before work started"));
    assert.equal(r.client.calls.length + r.buyCalls.length, 0);
  });

  const slow = (respond: Responder, ms: number): McpClient & { calls: Call[] } => {
    const calls: Call[] = [];
    return { calls, async call(name, args) { calls.push({ name, args }); await new Promise((res) => setTimeout(res, ms)); return respond(name, args); } };
  };
  const wiring = (client: McpClient, deadlineMs: number, buys: string[]) => ({
    client,
    llm: null,
    deadlineMs,
    buy: async (url: string) => { buys.push(url); return paidOk(); },
  });
  const getModel = () => { throw new Error("no model in tests"); };
  const task = { sessionId: "9001", job: { task: REPORT, terms: {} } };

  it("a deadline of zero delivers the note with zero calls and zero payments", async () => {
    const buys: string[] = [];
    const c = slow(liveResponder(), 1);
    const text = await buildDeskRunWork(getModel as never, wiring(c, 0, buys))("p", task);
    assert.ok(text.startsWith("# 4lpha bStock Desk: could not complete"));
    assert.equal(c.calls.length + buys.length, 0);
  });
  it("a deadline that passes during a read: the later reads and the payment never start; the partial report is delivered", async () => {
    const buys: string[] = [];
    const c = slow(liveResponder(), 80);
    const text = await buildDeskRunWork(getModel as never, wiring(c, 40, buys))("p", task);
    assert.deepEqual(c.calls.map((x) => x.name), ["stock_compare"]);
    assert.equal(buys.length, 0);
    assert.ok(text.includes("## Where to buy"), "what was read is delivered");
    assert.ok(text.includes("price and session: unavailable (aborted)"));
    assert.ok(text.includes("crypto backdrop: unavailable (deadline)") || !text.includes("## Crypto backdrop"));
    assert.ok(text.includes("The delivery time limit was reached"));
  });
  it("time spent queued behind another job counts: the second job gives up before it starts", async () => {
    const buys: string[] = [];
    const c = slow(liveResponder(), 90);
    const work = buildDeskRunWork(getModel as never, wiring(c, 60, buys));
    const first = work("p", { sessionId: "1", job: { task: REPORT, terms: {} } });
    const second = work("p", { sessionId: "2", job: { task: REPORT, terms: {} } });
    const [t1, t2] = await Promise.all([first, second]);
    assert.ok(t1.includes("## Where to buy"));
    assert.ok(t2.includes("the delivery time limit was reached before work started"));
    assert.equal(c.calls.length, 1, "the queued job made no call");
  });
  it("the soft deadline is below the core's own delivery timeout", () => {
    assert.ok(DEADLINE_SHARE > 0 && DEADLINE_SHARE < 1);
  });
  it("a parent abort (the core's own) also stops the work", async () => {
    const parent = new AbortController();
    parent.abort();
    const buys: string[] = [];
    const text = await buildDeskRunWork(getModel as never, wiring(slow(liveResponder(), 1), 60_000, buys))("p", { ...task, abortSignal: parent.signal });
    assert.ok(text.includes("before work started"));
  });
});

describe("M2: an ambiguous payment is recorded and never repeated for the same job", () => {
  const ambiguous = (calls: { n: number }) => async () => {
    calls.n += 1;
    return { ok: false, error: "X402RetryExhaustedError", message: "server still 402" };
  };
  it("reports 'outcome not confirmed', and a re-delivery of the same job does not buy again", async () => {
    const calls = { n: 0 };
    const r = rig({ buy: ambiguous(calls), jobKey: "job-amb" });
    const first = await stockReport({ type: "stock_report", ticker: "NVDA", usdt: 500 }, r.deps);
    assert.ok(first.markdown.includes("A payment was sent but its outcome was not confirmed (X402RetryExhaustedError)"));
    assert.ok(first.markdown.includes("not bought again for this job"));
    assert.equal(first.backdrop, "unknown");
    const second = await stockReport({ type: "stock_report", ticker: "NVDA", usdt: 500 }, r.deps);
    assert.equal(calls.n, 1);
    assert.ok(second.markdown.includes("outcome was not confirmed"));
  });
  it("a clean refusal is still retried on the next attempt (nothing was sent)", async () => {
    let n = 0;
    const buy = async () => (++n === 1 ? { ok: false, error: "X402HostNotAllowedError", message: "x" } : paidOk());
    const r = rig({ buy, jobKey: "job-clean" });
    await stockReport({ type: "stock_report", ticker: "NVDA", usdt: 500 }, r.deps);
    const b = await stockReport({ type: "stock_report", ticker: "NVDA", usdt: 500 }, r.deps);
    assert.equal(n, 2);
    assert.equal(b.backdrop, "paid");
  });
});

describe("M3: Schedule budgets the hosted form accepts", () => {
  it("20 USDT over 7 days becomes 4 daily buys of 5 USDT with the runs end rule", async () => {
    const r = rig();
    const b = await buildDeliverable(job(SCHED(20)), r.deps);
    for (const s of [
      "## Plan (Schedule buy)",
      "Recommended: Daily, 4 buys of 5.00 USDT.",
      'the form\'s "after N runs" end rule is used: 4 buys',
      "Finish after 4 runs.",
      "finish after 4 runs.",
    ]) assert.ok(b.markdown.includes(s), s);
    assert.ok(!b.markdown.includes("No plan is made"));
  });
  it("a budget under one buy plus the reserve is still refused", async () => {
    const b = await buildDeliverable(job(SCHED(5)), rig().deps);
    assert.ok(b.markdown.includes("needs at least 5.25 USDT"));
  });
});

describe("LOWs", () => {
  it("L7: the DCA plan says Earn needs 5 or more orders; the rebalance plan names the check interval options", async () => {
    const d = await dcaPlanReport({ type: "dca_plan", ticker: "NVDAB", usdt: 200, mode: "dca", days: 7 }, rig().deps);
    assert.ok(d.markdown.includes("Earn (idle USDT lent to Venus or Aave) is offered only with at least 5 DCA orders; this plan has 3, so it does not apply."));
    const rb = await buildDeliverable(job(REB), rig().deps);
    assert.ok(rb.markdown.includes("Check interval: the form offers 4h, 8h, 12h, Daily (no 1h). Default of this plan: Daily."));
    assert.ok(rb.markdown.includes("check interval Daily."));
  });
  it("L3: the shared 'b402' session id is never a cache key, a real job id is", async () => {
    const buys: string[] = [];
    const wiring = { client: rig().client, llm: null, deadlineMs: 60_000, buy: async (u: string) => { buys.push(u); return paidOk(); } };
    const work = buildDeskRunWork((() => { throw new Error("x"); }) as never, wiring);
    const mk = (id: string) => ({ sessionId: id, job: { task: REPORT, terms: {} } });
    await work("p", mk("b402"));
    await work("p", mk("b402"));
    assert.equal(buys.length, 2);
    await work("p", mk("5150"));
    await work("p", mk("5150"));
    assert.equal(buys.length, 3);
  });
  it("L8: the model's text must keep the sign of a number", () => {
    const facts = ["EMA12/EMA26 spread percent: -0.05", "venue price USD: 236.97"];
    assert.ok(acceptSummary("The spread is -0.05 percent.", facts));
    assert.equal(acceptSummary("The spread is 0.05 percent.", facts), null);
    assert.ok(acceptSummary("It is a 7-day plan at 236.97.", ["term days: 7", "venue price USD: 236.97"]));
    assert.equal(acceptSummary("Between 3-5 days.", ["a: 3", "b: 5"])?.includes("3-5"), true);
  });
});
