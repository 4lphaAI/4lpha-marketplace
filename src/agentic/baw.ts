import { execFile, type ChildProcess, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { AgenticSession } from "./domain.js";
import { agenticDecimal } from "./domain.js";

export type BawResult =
  | { kind: "ok"; data: unknown; sessionPresent: boolean; rwaTokens: unknown }
  | { kind: "cli-error"; code: number; name: string; orderId: string | null; sessionPresent: boolean }
  | { kind: "no-response"; code: "timeout" | "unparseable" | "no-response"; sessionPresent: boolean }
  | { kind: "not-started"; sessionPresent: boolean };
export type BawSpawn = (file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => ChildProcess;
export type PreparedBaw = {
  directory: string; environment: NodeJS.ProcessEnv;
  start(): Promise<BawResult>; close(): Promise<void>; cancel(): void;
};

const GUARD = fileURLToPath(new URL("../../src/agentic/childGuard.cjs", import.meta.url));
const ERROR_NAMES = new Set(["SESSION_EXPIRED", "NOT_LOGGED_IN", "UNAUTHORIZED", "REQUEST_TIMEOUT", "SERVICE_UNAVAILABLE",
  "NETWORK_ERROR", "UNKNOWN_ERROR", "SERVICE_ERROR", "ORDER_API_ERROR", "APP_CONFIRMATION_REQUIRED",
  "INSUFFICIENT_BALANCE", "INSUFFICIENT_GAS", "INVALID_TOKEN", "INVALID_PARAMETER", "DNS_ERROR", "TLS_ERROR"]);
const TIMEOUTS: Readonly<Record<string, number>> = {
  "--version": 10_000, "auth signin": 20_000, "auth verify": 330_000, "auth signout": 10_000,
  "wallet status": 10_000, "wallet settings": 10_000, "wallet address": 10_000, "wallet balance": 10_000,
  "market-order quote": 10_000, "market-order list": 10_000, "limit-order list": 10_000,
  "market-order swap": 20_000, "x402-payment preview": 30_000, "x402-payment sign": 60_000,
  // AGENTIC-EARN-SPEC 3.13: the six defi commands of Agentic Earn (timeouts unmeasured, morning patch P6); every other defi subcommand stays refused.
  "defi investment-list": 15_000, "defi investment-info": 15_000, "defi position": 15_000, "defi preview": 30_000, "defi deposit": 60_000, "defi redeem": 60_000,
};
/** The DeFi domain names (server codes 351761 to 351768) and the three client-side validation names; accepted as a `cli-error` only for a `defi ` command. */
const DEFI_ERROR_NAMES = new Set(["INVESTMENT_NOT_FOUND", "INVESTMENT_NOT_INVESTABLE", "DEFI_TX_SIMULATION_FAILED", "DEFI_SECURITY_RISK_BLOCKED", "COMPLIANCE_FAILED",
  "INVESTMENT_NO_POSITION", "POSITION_QUERY_FAILED", "INVALID_PARAMS", "INVALID_AMOUNT", "INVALID_ADDRESS"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function bawOrderId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === "string" && /^[0-9A-Za-z-]{1,64}$/.test(value) ? value : null;
}

export function bawOutputValid(command: string, value: unknown): boolean {
  // Every shape rule of the six defi commands lives in earnAdapter.ts, so a format change is a one-file patch.
  if (command.startsWith("defi ")) return record(value);
  if (command === "wallet balance") return Array.isArray(value) && value.every(r => record(r)
    && ["symbol", "address", "binanceChainId", "balance", "price", "value"].every(k => typeof r[k] === "string"));
  if (!record(value)) return false;
  if (command === "wallet status") return ["CONNECTED", "UNCONNECTED", "CREATING"].includes(String(value["status"]));
  if (command === "wallet address") return Array.isArray(value["addresses"]) && value["addresses"].every(r => record(r)
    && ["binanceChainId", "chainName", "address"].every(k => typeof r[k] === "string"));
  if (command === "wallet settings") return typeof value["tradeAllTokens"] === "boolean" && typeof value["abnormalTxnHandling"] === "string"
    && ["dailyLimit", "quotaUsed", "x402DailyLimit", "x402QuotaUsed"].every(k => typeof value[k] === "number" && agenticDecimal(value[k]) !== null)
    && ["inactiveSignOutTime", "sessionExpireTime", "signInMaxTime"].every(k => value[k] === null || typeof value[k] === "string");
  if (command === "market-order quote") return ["fromCoinSymbol", "fromCoinAmount", "toCoinSymbol", "toCoinAmount"].every(k => typeof value[k] === "string")
    && Object.hasOwn(value, "slippage");
  if (command === "market-order swap") return bawOrderId(value["orderId"]) !== null;
  if (command === "market-order list" || command === "limit-order list") return ["total", "page", "pageSize"].every(k => Number.isSafeInteger(value[k]) && Number(value[k]) >= 0)
    && Array.isArray(value["list"]) && value["list"].every(r => record(r) && bawOrderId(r["orderId"]) !== null
      && (r["txHash"] === null || typeof r["txHash"] === "string") && (r["bookTime"] === null || typeof r["bookTime"] === "string"));
  if (command === "auth signin") return typeof value["qrCodeId"] === "string" && typeof value["expireAt"] === "string"
    && typeof value["urlForWeb"] === "string" && typeof value["pairingCode"] === "string" && /^[0-9a-f]{6}$/i.test(value["pairingCode"]);
  if (command === "auth verify") return value["status"] === "SUCCESS";
  if (command === "auth signout") return value["status"] === "LOGGED_OUT";
  if (command === "x402-payment preview") return typeof value["paymentId"] === "string" && Array.isArray(value["options"]);
  if (command === "x402-payment sign") return typeof value["paymentHeaderName"] === "string" && typeof value["paymentHeaderValue"] === "string"
    && Object.hasOwn(value, "signatureExpiresAt") && (value["approveTxHash"] === undefined || value["approveTxHash"] === null || typeof value["approveTxHash"] === "string");
  return false;
}

export function bawConnectionSignal(result: BawResult): "U" | "connected" | "unreachable" {
  if (result.kind === "cli-error" && result.code === 10003002 && result.name === "SESSION_EXPIRED") return "U";
  if (result.kind === "ok" && record(result.data)) {
    if (result.data["status"] === "UNCONNECTED" && result.sessionPresent) return "U";
    if (result.data["status"] === "CONNECTED") return "connected";
  }
  return "unreachable";
}

/** Keys mapped to typeof, recursive to a fixed depth; no value is ever copied. */
function typeShape(value: unknown, depth: number): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (!record(value)) return typeof value;
  return depth <= 0 ? "object" : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeShape(item, depth - 1)]));
}
/** Diagnostic for a reply that parsed as JSON but was classified no-response: structure and the error code and name only, never a string value. */
function rejectedShape(parsed: unknown): Record<string, unknown> {
  if (!record(parsed)) return { success: typeof parsed, topKeys: [], data: typeShape(parsed, 3), error: null };
  const failure = record(parsed["error"]) ? parsed["error"] : null;
  return { success: typeof parsed["success"] === "boolean" ? parsed["success"] : typeShape(parsed["success"], 0), topKeys: Object.keys(parsed), data: typeShape(parsed["data"], 3),
    error: failure === null ? null : { code: Number.isSafeInteger(failure["code"]) ? failure["code"] : null,
      name: typeof failure["name"] === "string" && /^[A-Z0-9_]{1,64}$/u.test(failure["name"]) ? failure["name"] : "invalid" } };
}

export function bawSwapResponse(result: BawResult): { response: "accepted" | "rejected" | "no-response"; orderId: string | null; note: string } {
  if (result.kind === "ok" && record(result.data) && bawOrderId(result.data["orderId"]) !== null) {
    return { response: "accepted", orderId: bawOrderId(result.data["orderId"]), note: "accepted" };
  }
  if (result.kind === "cli-error" && result.code === 30003001 && result.name === "ORDER_API_ERROR" && result.orderId !== null) {
    return { response: "rejected", orderId: result.orderId, note: "cli-error:30003001:ORDER_API_ERROR" };
  }
  return { response: "no-response", orderId: null, note: result.kind === "cli-error"
    ? `cli-error:${result.code}:${result.name}` : result.kind === "no-response" ? result.code : result.kind };
}

export class BawRunner {
  readonly #cli: string;
  readonly #spawn: BawSpawn;
  readonly #children = new Set<ChildProcess>();

  constructor(cli: string, spawn: BawSpawn = (file, args, options, callback) => execFile(file, [...args], options, callback)) {
    this.#cli = cli;
    this.#spawn = spawn;
  }

  killChildren(): void {
    for (const child of this.#children) child.kill("SIGKILL");
  }

  async checkBoot(): Promise<void> {
    try {
      createRequire(this.#cli).resolve("@github/keytar");
      throw new Error("AGENTIC_KEYTAR_RESOLVABLE");
    } catch (error) {
      if (!record(error) || error["code"] !== "MODULE_NOT_FOUND") throw new Error("AGENTIC_KEYTAR_RESOLVABLE");
    }
    const command = await this.prepare(["--version"], null);
    try {
      const result = await command.start();
      if (result.kind !== "ok" || result.data !== "1.10.0") throw new Error("AGENTIC_CLI_VERSION");
    } finally { await command.close(); }
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith("4lpha-baw-")) continue;
      const path = join(tmpdir(), name);
      const info = await stat(path);
      if (info.isDirectory() && Date.now() - info.mtimeMs > 600_000) await rm(path, { recursive: true, force: true });
    }
  }

  async prepare(args: readonly string[], session: AgenticSession | null, verifyDeadlineMs?: number): Promise<PreparedBaw> {
    const directory = await mkdtemp(join(tmpdir(), "4lpha-baw-"));
    try {
      await chmod(directory, 0o700);
      await mkdir(join(directory, "baw"), { mode: 0o700 });
      if (session !== null) await writeFile(join(directory, "baw", "session.json"), session.sessionJson, { mode: 0o600 });
      return await this.prepareInDirectory(directory, args, session?.instanceId ?? randomBytes(32).toString("hex"), verifyDeadlineMs);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  async prepareInDirectory(directory: string, args: readonly string[], instanceId: string, verifyDeadlineMs?: number): Promise<PreparedBaw> {
    const command = args[0] === "--version" ? "--version" : args.slice(0, 2).join(" ");
    const configured = TIMEOUTS[command];
    if (configured === undefined || args.some(a => a === "--help" || a === "--version" && command !== "--version")) throw new Error("AGENTIC_COMMAND_REFUSED");
    const timeout = command === "auth verify" ? Math.min(330_000, Math.max(1, (verifyDeadlineMs ?? Date.now() + 330_000) - Date.now())) : configured;
    let sessionPresent = false;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, "baw", "session.json"), "utf8"));
      sessionPresent = record(parsed) && typeof parsed["sessionId"] === "string" && parsed["sessionId"].length > 0;
    } catch { /* Empty pairing materialization has no credential yet. */ }
    if (command !== "--version" && command !== "auth signin" && command !== "auth verify" && !sessionPresent) throw new Error("AGENTIC_SESSION_MATERIALIZE");
    const environment: NodeJS.ProcessEnv = {
      PATH: process.platform === "win32" ? process.env["PATH"] ?? "" : "/usr/local/bin:/usr/bin:/bin",
      ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "" } : {}),
      HOME: directory, USERPROFILE: directory, BINANCE_BAW_DIR: join(directory, "baw"), BINANCE_INSTANCE_ID: instanceId,
      TZ: "UTC", LANG: "C", LC_ALL: "C", FOURLPHA_BAW_LIMIT_MS: String(timeout + 5_000),
      FOURLPHA_PARENT_PID: String(process.pid), FOURLPHA_START_DEADLINE_MS: "0",
    };
    let started = false;
    let running: ChildProcess | null = null;
    return { directory, environment,
      start: () => {
        if (started) throw new Error("AGENTIC_COMMAND_ALREADY_STARTED");
        started = true;
        const startedAt = process.hrtime.bigint();
        if (environment["FOURLPHA_START_DEADLINE_MS"] === "0") environment["FOURLPHA_START_DEADLINE_MS"] = String(Date.now() + 7_000);
        return new Promise<BawResult>(resolve => {
          let spawned = false;
          const child = this.#spawn(process.execPath, ["--require", GUARD, this.#cli, ...args, ...(command === "--version" ? [] : ["--json"])],
            { env: environment, shell: false, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 1_048_576 },
            (error, stdout) => {
              void (async () => {
                let rwaTokens: unknown = null;
                try { rwaTokens = JSON.parse(await readFile(join(directory, ".baw", "rwa-tokens.json"), "utf8")) as unknown; }
                catch { /* A read that needs a multiplier refuses when the cache is absent. */ }
                if (!spawned && error !== null || stdout === '{"fourlphaGuard":"refused-start"}' && error?.code === 75) {
                  resolve({ kind: "not-started", sessionPresent }); return;
                }
                if (!spawned || error?.killed || error?.signal !== undefined && error.signal !== null) {
                  resolve({ kind: "no-response", code: error?.killed ? "timeout" : "no-response", sessionPresent }); return;
                }
                if (command === "--version") {
                  resolve(error === null ? { kind: "ok", data: stdout.trim(), sessionPresent, rwaTokens }
                    : { kind: "no-response", code: "unparseable", sessionPresent }); return;
                }
                let parsed: unknown;
                try { parsed = JSON.parse(stdout) as unknown; } catch {
                  console.error("agentic_cli_output_rejected", command, JSON.stringify({ unparseable: true, length: stdout.length }));
                  resolve({ kind: "no-response", code: error?.killed ? "timeout" : "unparseable", sessionPresent }); return;
                }
                if (record(parsed) && parsed["success"] === true && error === null && bawOutputValid(command, parsed["data"])) {
                  resolve({ kind: "ok", data: parsed["data"], sessionPresent, rwaTokens }); return;
                }
                const failure = record(parsed) && record(parsed["error"]) ? parsed["error"] : null;
                if (parsed !== null && record(parsed) && parsed["success"] === false && failure !== null
                  && Number.isSafeInteger(failure["code"]) && typeof failure["name"] === "string" && (ERROR_NAMES.has(failure["name"]) || command.startsWith("defi ") && DEFI_ERROR_NAMES.has(failure["name"]))) {
                  resolve({ kind: "cli-error", code: Number(failure["code"]), name: failure["name"],
                    orderId: record(failure["data"]) ? bawOrderId(failure["data"]["orderId"]) : null, sessionPresent }); return;
                }
                console.error("agentic_cli_output_rejected", command, JSON.stringify(rejectedShape(parsed)));
                resolve({ kind: "no-response", code: "unparseable", sessionPresent });
              })().catch(() => resolve({ kind: "no-response", code: "unparseable", sessionPresent }));
            });
          this.#children.add(child);
          running = child;
          child.once("spawn", () => { spawned = true; });
          child.once("close", () => { this.#children.delete(child); running = null; });
          child.stderr?.removeAllListeners("data");
          child.stderr?.resume();
        }).then(result => {
          console.info("agentic-command", command, Math.floor(Number(process.hrtime.bigint() - startedAt) / 1_000_000), result.kind,
            ...(result.kind === "cli-error" ? [result.code, result.name] : []));
          return result;
        });
      },
      close: () => rm(directory, { recursive: true, force: true }),
      cancel: () => { running?.kill("SIGKILL"); },
    };
  }

  async run(args: readonly string[], session: AgenticSession): Promise<BawResult> {
    const command = await this.prepare(args, session);
    try { return await command.start(); } finally { await command.close(); }
  }
}
