/** Explicit local research file only: no environment, wallet, provider or model calls. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareTradeEvidence } from "../src/trade/comparison.js";
const inputPath = process.argv[2];
if (!inputPath || process.argv.length !== 3) throw new Error("Usage: node --import tsx scripts/compare-trade-evidence.ts <local-research.json>");
const raw = await readFile(resolve(inputPath), "utf8");
if (Buffer.byteLength(raw) > 1_048_576) throw new Error("Research input exceeds 1 MiB.");
console.log(JSON.stringify(compareTradeEvidence(JSON.parse(raw)), null, 2));
