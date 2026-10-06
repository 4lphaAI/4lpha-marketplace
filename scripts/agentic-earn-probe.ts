/** AGENTIC-EARN-SPEC 9.1 and R11.7 (E0 probe, read-only): pair a FRESH Binance Agentic Wallet, print the raw answers of the read-only `defi` commands, the chain reads and the pin check, then sign out.
 *
 *    node --import tsx scripts\agentic-earn-probe.ts --wallet 0x...
 *
 *  Needs AGENTIC_BAW_CLI and DATABASE_URL (read only: one select on agentic_wallets; no DDL and nothing is written). Refuses before pairing when the wallet already has a live hire, because pairing a
 *  live wallet ends its agent. The probe holds ONE directory for the whole run (the pairing's own shape: the signin command is never closed), always runs `auth signout` in a finally, then removes the
 *  directory. Only commands of the runner's allowlist are used; no deposit, no redeem, no transaction. */
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BNB } from "@altananetwork/sdk";
import type { Address } from "viem";
import { createPgSqlClient } from "../src/store/sql.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { BawRunner, type BawResult } from "../src/agentic/baw.js";
import { agenticAddress } from "../src/agentic/domain.js";
import { createAgenticChain, type AgenticChain } from "../src/agentic/resolve.js";
import { EARN_BINANCE_PROTOCOL, EARN_USDT } from "../src/agentic/earnAdapter.js";

export type EarnProbeDeps = {
  runner: BawRunner;
  /** True when the wallet has an agentic_wallets row in hiring, bound or ending. */
  hasLiveHire(wallet: Address): Promise<boolean>;
  chain: Pick<AgenticChain, "earnBalances" | "earnPins">;
  print(value: unknown): void;
  remove(directory: string): Promise<void>;
  /** The raw stdout of the last command, for an answer the runner could not validate. */
  lastRaw?(): string;
  /** `--ids a,b`: investment ids to inspect when the list rows do not name them. */
  ids?: readonly string[];
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)) as unknown;

export async function runEarnProbe(deps: EarnProbeDeps, wallet: Address): Promise<void> {
  const { runner, print } = deps;
  if (await deps.hasLiveHire(wallet)) throw new Error("AGENTIC_PROBE_WALLET_IN_USE");
  const signin = await runner.prepare(["auth", "signin"], null);
  const directory = signin.directory, instanceId = signin.environment["BINANCE_INSTANCE_ID"]!;
  // The signin command is never closed: close() removes the directory. The finally below signs out and removes it once.
  try {
    const answer = await signin.start();
    if (answer.kind !== "ok" || !record(answer.data)) throw new Error("AGENTIC_PROBE_SIGNIN_FAILED");
    const qr = answer.data;
    print({ label: "pair now", urlForWeb: qr["urlForWeb"], expireAt: qr["expireAt"] });
    const expiry = typeof qr["expireAt"] === "string" ? (/^\d+$/.test(qr["expireAt"]) ? Number(qr["expireAt"]) : Date.parse(qr["expireAt"])) : NaN;
    const run = async (label: string, args: readonly string[], show = true): Promise<BawResult> => {
      const result = await (await runner.prepareInDirectory(directory, args, instanceId, args[1] === "verify" && Number.isSafeInteger(expiry) ? expiry + 15_000 : undefined)).start();
      if (show) print({ label, argv: args.join(" "), kind: result.kind, ...(result.kind === "ok" ? { data: result.data } : result.kind === "cli-error" ? { code: result.code, name: result.name } : result.kind === "no-response" ? { code: result.code, raw: deps.lastRaw?.().slice(0, 4_000) } : {}) });
      return result;
    };
    const verified = await run("auth verify", ["auth", "verify", "--qrCodeId", String(qr["qrCodeId"])], false);
    if (verified.kind !== "ok") throw new Error("AGENTIC_PROBE_VERIFY_FAILED");
    const address = await run("wallet address", ["wallet", "address"]);
    const paired = address.kind === "ok" && record(address.data) && Array.isArray(address.data["addresses"])
      ? (address.data["addresses"] as unknown[]).flatMap(a => record(a) && a["binanceChainId"] === "56" && typeof a["address"] === "string" ? [agenticAddress(a["address"])] : [])[0] : undefined;
    if (paired !== wallet) throw new Error("AGENTIC_PROBE_WALLET_MISMATCH");
    await run("wallet settings", ["wallet", "settings"]);
    const list = (extra: readonly string[]) => ["defi", "investment-list", "--investType", "Earn", ...extra, "--contractAddresses", EARN_USDT, "--binanceChainId", "56", "--sortField", "apy", "--sortDirection", "DESC", "--page", "1", "--size", "100"];
    await run("investment-list (all)", list([]));
    const found = new Set<string>(deps.ids ?? []);
    for (const protocol of Object.values(EARN_BINANCE_PROTOCOL)) {
      const listed = await run(`investment-list (${protocol})`, list(["--defiProtocolId", protocol]));
      // The id key of a row is not known before this probe: every string value of an `id`-named key is tried, and the raw rows above show the real one.
      if (listed.kind === "ok" && record(listed.data) && Array.isArray(listed.data["list"])) for (const row of listed.data["list"] as unknown[]) {
        if (record(row)) for (const [key, value] of Object.entries(row)) if (/^(investment)?id$/iu.test(key) && typeof value === "string" && value.length > 0) found.add(value);
      }
    }
    for (const id of found) await run(`investment-info ${id}`, ["defi", "investment-info", "--investmentId", id]);
    await run("position", ["defi", "position", "--binanceChainId", "56"]);
    for (const id of found) {
      const base = ["--investmentId", id, "--tokenAddress", EARN_USDT, "--binanceChainId", "56"];
      await run(`preview deposit 1 ${id}`, ["defi", "preview", "--action", "deposit", ...base, "--amount", "1"]);
      await run(`preview redeem 1 ${id}`, ["defi", "preview", "--action", "redeem", ...base, "--amount", "1"]);
      await run(`preview redeem ratio 1 ${id}`, ["defi", "preview", "--action", "redeem", ...base, "--ratio", "1"]);
    }
    try { print({ label: "chain balances (rule 8)", ...json(await deps.chain.earnBalances!(wallet)) as object }); } catch { print({ label: "chain balances (rule 8)", error: "read-failed" }); }
    try { print({ label: "chain pins (rule 6)", ...json(await deps.chain.earnPins!()) as object }); } catch { print({ label: "chain pins (rule 6)", error: "read-failed" }); }
  } finally {
    try { await (await runner.prepareInDirectory(directory, ["auth", "signout"], instanceId)).start(); } catch { /* the directory is removed next */ }
    await deps.remove(directory);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2), at = argv.indexOf("--wallet"), wallet = argv[at + 1];
  if (at < 0 || wallet === undefined || !/^0x[0-9a-fA-F]{40}$/u.test(wallet)) throw new Error("AGENTIC_PROBE_ARGUMENT");
  const idsAt = argv.indexOf("--ids"), ids = idsAt < 0 ? [] : (argv[idsAt + 1] ?? "").split(",").filter(Boolean);
  const cli = process.env["AGENTIC_BAW_CLI"] ?? "", url = process.env["DATABASE_URL"] ?? "";
  if (cli === "" || url === "") throw new Error("AGENTIC_PROBE_ENV");
  let raw = "";
  const runner = new BawRunner(cli, (file, args, options, callback) => execFile(file, [...args], options, (error, stdout, stderr) => { raw = stdout; callback(error, stdout, stderr); }));
  await runner.checkBoot();
  const sql = await createPgSqlClient(url);
  const chain = createAgenticChain(resolveLpRpcUrls(process.env, { chain: BNB.chain, chainId: 56, publicRpcUrl: BNB.publicRpcUrl }));
  try {
    await runEarnProbe({ runner, chain, ids, lastRaw: () => raw, print: value => {
        console.log(JSON.stringify(value));
        // The pairing link also goes to the console (stderr), so redirecting stdout to a file keeps it visible.
        if (typeof value === "object" && value !== null && (value as { label?: unknown }).label === "pair now") console.error("pair now: " + String((value as { urlForWeb?: unknown }).urlForWeb));
      },
      remove: directory => rm(directory, { recursive: true, force: true }),
      hasLiveHire: async W => (await sql.query("select 1 from agentic_wallets where wallet_address=$1 and state in ('hiring','bound','ending') limit 1", [W])).rows.length > 0 }, agenticAddress(wallet));
  } finally { runner.killChildren(); await sql.close(); }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  console.error(`agentic-earn-probe refused or failed (${/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(message) ? message : "unknown"})`); process.exitCode = 1;
});
