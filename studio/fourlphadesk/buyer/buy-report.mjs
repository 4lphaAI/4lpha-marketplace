#!/usr/bin/env node
// Buy one 4lpha bStock Desk report end to end, or look at the free preview.
//
//   node buy-report.mjs NVDA 500 --preview     free: price and where-to-buy sections, no wallet needed
//   node buy-report.mjs NVDA 500               paid: 0.10 USD through an ERC-8183 job on BSC mainnet
//
// The paid run must start inside a BNB Agent Studio project folder (app/agent) whose wallet holds about
// 0.10 U and a little BNB: the `bag` CLI signs and pays, this script never sees a key. Steps:
//   1. A2A negotiate: the desk signs a price (the request names the payment asset, which `bag` requires);
//   2. `bag erc8183 buy --provider <desk wallet> --quote-json quote.json`: create, register, budget, fund;
//   3. A2A notify_funded: the desk verifies the funded job and starts the work;
//   4. poll `bag erc8183 status` until SUBMITTED, then print the report from IPFS.
// Studio's default mainnet RPC does not serve receipts, so STUDIO_BSC_RPC defaults to a BNB Chain dataseed.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const DESK = (process.env.DESK_URL ?? "https://desk.4lpha.tech").replace(/\/+$/, "") + "/";
const PROVIDER = process.env.DESK_PROVIDER ?? "0x592EF127feFd45eAA56fE0D715dAAF72F998A652";
const U = "0xcE24439F2D9C6a2289F741120FE202248B666666";
const GATEWAY = "https://gateway.pinata.cloud/ipfs/";

const args = process.argv.slice(2);
const preview = args.includes("--preview");
const [tickerArg, usdtArg] = args.filter((a) => !a.startsWith("--"));
if (!tickerArg || !/^[A-Za-z]{1,8}$/.test(tickerArg)) {
  console.error("usage: node buy-report.mjs <TICKER> [USDT] [--preview]   e.g. node buy-report.mjs NVDA 500");
  process.exit(2);
}
const ticker = tickerArg.toUpperCase();
const usdt = usdtArg === undefined ? undefined : Number(usdtArg);
if (usdt !== undefined && !(usdt >= 1 && usdt <= 1_000_000)) {
  console.error("USDT must be a number from 1 to 1000000");
  process.exit(2);
}

async function a2a(data) {
  const body = {
    jsonrpc: "2.0",
    id: `cli-${Date.now()}`,
    method: "message/send",
    params: { message: { kind: "message", messageId: `cli-${Date.now()}`, role: "user", parts: [{ kind: "data", data }] } },
  };
  const res = await fetch(DESK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const json = await res.json();
  if (json.error) throw new Error(`desk answered an error: ${JSON.stringify(json.error).slice(0, 300)}`);
  return json.result?.parts?.find((p) => p.kind === "data")?.data ?? {};
}

function bag(argv) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, STUDIO_BSC_RPC: process.env.STUDIO_BSC_RPC ?? "https://bsc-dataseed1.bnbchain.org" };
    const child = spawn("bag", argv, { env, shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`bag ${argv[0]} ${argv[1]} exited with ${code}\n${out}`))));
  });
}

const field = (out, name) => out.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (preview) {
    const p = await a2a({ skill: "preview", ticker, ...(usdt === undefined ? {} : { usdt }) });
    if (p.status !== "ok") {
      console.error(`preview: ${p.status}: ${p.error ?? JSON.stringify(p)}`);
      return 1;
    }
    console.log(p.markdown);
    console.log(`\nFull report: node buy-report.mjs ${ticker}${usdt === undefined ? "" : ` ${usdt}`}   (0.10 USD, ERC-8183 job)`);
    return 0;
  }
  
  const task = JSON.stringify(usdt === undefined ? { type: "stock_report", ticker } : { type: "stock_report", ticker, usdt });
  console.log(`1/4 asking the desk for a signed quote: ${task}`);
  const quote = await a2a({
    skill: "negotiate",
    task_description: task,
    terms: { deliverables: "Markdown desk report pinned to IPFS", quality_standards: "numbers computed by code, data times included", currency: U },
  });
  if (!quote.negotiation_hash || !quote.provider_sig) throw new Error(`no signed quote: ${JSON.stringify(quote).slice(0, 300)}`);
  const quoteFile = join(process.cwd(), "quote.json");
  writeFileSync(quoteFile, JSON.stringify(quote, null, 2));
  const price = Number(BigInt(quote.response?.terms?.price ?? 0)) / 1e18;
  console.log(`    quote: ${price} U, signed by the desk wallet, expires ${new Date(quote.response.quote_expires_at * 1000).toLocaleTimeString()}`);
  
  console.log("2/4 opening and funding the ERC-8183 job with bag (your wallet signs)");
  const bought = await bag(["erc8183", "buy", "--network", "bsc-mainnet", "--provider", PROVIDER, "--quote-json", quoteFile, "--budget-usd", "0.10", "--deadline-min", "60"]);
  const jobId = field(bought, "job_id");
  if (jobId === null) throw new Error(`bag did not print a job_id:\n${bought}`);
  for (const k of ["create_tx", "register_tx", "set_budget_tx", "fund_tx"]) console.log(`    ${k}: ${field(bought, k)}`);
  console.log(`    job_id: ${jobId}`);
  
  console.log("3/4 telling the desk the job is funded");
  const ack = await a2a({ skill: "notify_funded", job_id: Number(jobId) });
  console.log(`    desk: ${ack.status ?? JSON.stringify(ack)}`);
  if (ack.status !== "accepted") return 1;
  
  console.log("4/4 waiting for the desk to deliver on chain (usually under a minute)");
  for (let i = 0; i < 40; i++) {
    await sleep(10_000);
    const st = await bag(["erc8183", "status", jobId, "--network", "bsc-mainnet"]).catch(() => "");
    if (field(st, "status") === "SUBMITTED") {
      const url = field(st, "deliverable_url");
      const cid = url?.replace(/^ipfs:\/\//, "");
      console.log(`    delivered: ${url}\n    open: ${GATEWAY}${cid}\n`);
      const doc = await (await fetch(`${GATEWAY}${cid}`, { signal: AbortSignal.timeout(60_000) })).json().catch(() => null);
      if (doc?.response?.content) console.log(doc.response.content);
      return 0;
    }
  }
  console.log(`    not delivered yet; check later with: bag erc8183 status ${jobId} --network bsc-mainnet`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
