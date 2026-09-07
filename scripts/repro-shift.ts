/** Offline reproduction of the grid-shift build for grid-agent-01-5. Reads only. */
import pg from "pg";
import fs from "node:fs";
import { sagaDecreaseFloors, sagaSingleSidedMintFloors } from "../src/lp/rails.js";
import { gridShiftFunding, gridShiftSideFloors, gridShiftEconomics, gridTargetSide, gridSideChargesQuote } from "../src/lp/gridTriggers.js";
import { getLiquidityForAmounts } from "../src/lp/tickMath.js";

const RPC = "https://bsc-dataseed.bnbchain.org";
const NFPM = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364";
const WALLET = "0x27146E20c2fb2521c7DD73e97bE030C3147c9da6";
const TOKEN0 = "0x5C85D6C6825aB4032337F11Ee92a72DF936b46F6";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

async function rpc(method: string, params: unknown[]): Promise<string> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json() as { result?: string; error?: { message: string } };
  if (j.result === undefined) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
const call = (to: string, data: string) => rpc("eth_call", [{ to, data }, "latest"]);
const word = (hex: string, i: number) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const u = (hex: string, i: number) => BigInt("0x" + word(hex, i));
const i24 = (hex: string, i: number) => { const v = u(hex, i); return v >= (1n << 255n) ? Number(v - (1n << 256n)) : Number(v); };
const pad = (a: string) => a.toLowerCase().replace("0x", "").padStart(64, "0");

const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const db = new pg.Client({ connectionString: env["DATABASE_URL"] });
await db.connect();
const settings = (await db.query("select params from lp_settings where agent_id='grid-agent-01-5'")).rows[0].params;
const seq = (await db.query("select * from lp_sequences where sequence_id like '014ae4ab%'")).rows[0];
const obs = (await db.query("select observation from lp_observations where agent_id='grid-agent-01-5' order by evaluated_at_ms desc limit 1")).rows[0].observation;
await db.end();
const grid = (typeof settings === "string" ? JSON.parse(settings) : settings).grid;
const pool: string = (typeof obs === "string" ? JSON.parse(obs) : obs).poolAddress;

// ── live chain state ──────────────────────────────────────────────────────
const slot0 = await call(pool, "0x3850c7bd");
const sqrtP = u(slot0, 0);
const tick = i24(slot0, 1);
const idleQuote = BigInt(await call(WBNB, "0x70a08231" + pad(WALLET)));
const idleBase = BigInt(await call(TOKEN0, "0x70a08231" + pad(WALLET)));

const rungs = [
  { role: "sell" as const, tokenId: 7319719n },
  { role: "buy" as const, tokenId: 7319720n },
];
console.log(`pool ${pool}  tick ${tick}  sqrtP ${sqrtP}`);
console.log(`idle WBNB ${idleQuote}  idle base ${idleBase}`);

let freedQuote = 0n, freedBase = 0n;
for (const r of rungs) {
  const p = await call(NFPM, "0x99fbab88" + r.tokenId.toString(16).padStart(64, "0"));
  const tickLower = i24(p, 5), tickUpper = i24(p, 6), liquidity = u(p, 7);
  const f = sagaDecreaseFloors({ sqrtPriceX96: sqrtP, tickLower, tickUpper, liquidity, maxSagaSlippageBps: 100 });
  freedBase += f.amount0Min; freedQuote += f.amount1Min;
  console.log(`${r.role} #${r.tokenId} [${tickLower},${tickUpper}) L=${liquidity} -> frees base ${f.amount0Min} quote ${f.amount1Min}`);
}

const econ = gridShiftEconomics({ grid, shift: grid.shift, budgetWei: 62700000000000000n, relayFeePerSubmitWei: 100000000000000n });
console.log("econ:", JSON.stringify(econ, (_k, v) => typeof v === "bigint" ? v.toString() : v));
const sideFloors = gridShiftSideFloors({ minRungWei: econ.minRungWei ?? null, spotSqrtPriceX96: sqrtP, wbnbIsToken0: false });
console.log("floors quote", sideFloors.quoteFloorWei.toString(), "base", sideFloors.baseFloorWei.toString());

const funding = gridShiftFunding({
  deployPctBps: grid.shift.deployPctBps,
  idleQuoteWei: idleQuote, idleBaseWei: idleBase,
  freedQuoteWei: freedQuote, freedBaseWei: freedBase,
  quoteFloorWei: sideFloors.quoteFloorWei, baseFloorWei: sideFloors.baseFloorWei,
  targetRoles: ["sell", "buy"],
});
console.log("funding:", JSON.stringify(funding, (_k, v) => typeof v === "bigint" ? v.toString() : v, 1));

const targets = {
  buy: { tickLower: seq.target_tick_lower, tickUpper: seq.target_tick_upper },
  sell: { tickLower: seq.target_sell_tick_lower, tickUpper: seq.target_sell_tick_upper },
};
for (const role of ["sell", "buy"] as const) {
  const side = role === "sell" ? funding.sell : funding.buy;
  const target = targets[role];
  const targetSide = gridTargetSide(tick, target);
  const chargesQuote = targetSide === undefined ? undefined : gridSideChargesQuote(targetSide, false);
  console.log(`\n${role} target [${target.tickLower},${target.tickUpper}) fundable=${side.fundable} plannedMint=${side.plannedMintWei} side=${targetSide} chargesQuote=${chargesQuote} (must be ${role === "buy"})`);
  if (!side.fundable || targetSide === undefined || chargesQuote !== (role === "buy")) { console.log("  -> REFUSED at the mint gate"); continue; }
  const amount0 = chargesQuote === false ? side.plannedMintWei : 0n;
  const amount1 = chargesQuote === false ? 0n : side.plannedMintWei;
  const liq = getLiquidityForAmounts(sqrtP, target.tickLower, target.tickUpper, amount0, amount1);
  const mf = sagaSingleSidedMintFloors({ sqrtPriceX96: sqrtP, tickLower: target.tickLower, tickUpper: target.tickUpper, liquidity: liq, maxSagaSlippageBps: 100, side: targetSide });
  console.log(`  amount0Desired ${amount0} amount1Desired ${amount1} L=${liq} min0 ${mf.amount0Min} min1 ${mf.amount1Min}`);
  console.log(`  WALLET AFTER EXITS: base ${idleBase + freedBase}  quote ${idleQuote + freedQuote}`);
}
