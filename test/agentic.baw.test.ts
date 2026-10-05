import assert from "node:assert/strict";
import { ChildProcess, execFile, type ExecFileException } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { BawRunner, bawConnectionSignal, bawOutputValid, bawSwapResponse, type BawResult, type BawSpawn } from "../src/agentic/baw.js";

const SESSION = { v: 1, instanceId: "11".repeat(32), sessionJson: '{"clientId":"offline-fixture","sessionId":"offline-fixture"}' } as const;
const ROOT = join(process.cwd(), "scripts", "tmp");

describe("Agentic runner", () => {
  it("passes only the exact minimal environment and deletes a materialization after completion", async context => {
    await mkdir(ROOT, { recursive: true });
    context.mock.method(os, "tmpdir", () => ROOT);
    syncBuiltinESMExports();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    const previous = process.env["EXECUTION_MASTER_KEY"];
    process.env["EXECUTION_MASTER_KEY"] = "offline-do-not-pass";
    context.after(() => { if (previous === undefined) delete process.env["EXECUTION_MASTER_KEY"]; else process.env["EXECUTION_MASTER_KEY"] = previous; });
    const spawn: BawSpawn = (file, args, options, callback) => {
      assert.equal(file, process.execPath);
      assert.equal(args[0], "--require");
      assert.match(args[1]!, /childGuard\.cjs$/);
      assert.equal(args.at(-1), "--json");
      assert.equal(options.shell, false);
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.timeout, 10_000);
      assert.equal(options.maxBuffer, 1_048_576);
      assert.deepEqual(Object.keys(options.env!).sort(), ["PATH", ...(process.platform === "win32" ? ["SystemRoot"] : []),
        "HOME", "USERPROFILE", "BINANCE_BAW_DIR", "BINANCE_INSTANCE_ID", "TZ", "LANG", "LC_ALL",
        "FOURLPHA_BAW_LIMIT_MS", "FOURLPHA_PARENT_PID", "FOURLPHA_START_DEADLINE_MS"].sort());
      const child = new ChildProcess();
      queueMicrotask(() => { child.emit("spawn"); callback(null, '{"success":true,"data":{"status":"CONNECTED"}}', "discarded"); child.emit("close", 0); });
      return child;
    };
    const runner = new BawRunner(join(ROOT, "fixture.cjs"), spawn);
    const command = await runner.prepare(["wallet", "status"], SESSION);
    assert.equal(await readFile(join(command.directory, "baw", "session.json"), "utf8"), SESSION.sessionJson);
    if (process.platform !== "win32") {
      assert.equal((await stat(command.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(command.directory, "baw", "session.json"))).mode & 0o777, 0o600);
    }
    assert.equal(bawConnectionSignal(await command.start()), "connected");
    await command.close();
    await assert.rejects(stat(command.directory));
  });

  it("refuses every forbidden command before spawning and refuses a missing sessionId", async context => {
    await mkdir(ROOT, { recursive: true });
    context.mock.method(os, "tmpdir", () => ROOT);
    syncBuiltinESMExports();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    let calls = 0;
    const runner = new BawRunner(join(ROOT, "fixture.cjs"), () => { calls += 1; throw new Error("Unexpected spawn."); });
    for (const args of [["wallet", "send"], ["contract-call"], ["sign-message"], ["defi", "stake"],
      ["limit-order", "buy"], ["limit-order", "sell"], ["limit-order", "cancel"], ["limit-order", "other"]]) {
      await assert.rejects(runner.prepare(args, SESSION), /AGENTIC_COMMAND_REFUSED/);
    }
    await assert.rejects(runner.prepare(["wallet", "status"], { ...SESSION, sessionJson: '{}' }), /AGENTIC_SESSION_MATERIALIZE/);
    const permitted = await runner.prepare(["limit-order", "list"], SESSION);
    await permitted.close();
    assert.equal(calls, 0);
  });

  it("distinguishes local no-start proof from post-spawn failures and never trusts a timeout's JSON", async context => {
    await mkdir(ROOT, { recursive: true });
    context.mock.method(os, "tmpdir", () => ROOT);
    syncBuiltinESMExports();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    for (const scenario of [
      { spawned: false, stdout: "", error: { code: "ENOENT" }, kind: "not-started" },
      { spawned: true, stdout: '{"fourlphaGuard":"refused-start"}', error: { code: 75 }, kind: "not-started" },
      { spawned: true, stdout: '{"fourlphaGuard":"refused-start"}', error: { code: 74 }, kind: "no-response" },
      { spawned: true, stdout: '{"fourlphaGuard":"refused-start"}\n', error: { code: 75 }, kind: "no-response" },
      { spawned: true, stdout: "", error: { code: 1 }, kind: "no-response" },
      { spawned: true, stdout: '{"success":false,"error":{"code":30003001,"name":"ORDER_API_ERROR","data":{"orderId":"1"}}}', error: { code: 1, killed: true }, kind: "no-response" },
    ]) {
      const spawn: BawSpawn = (_file, _args, _options, callback) => {
        const child = new ChildProcess();
        queueMicrotask(() => { if (scenario.spawned) child.emit("spawn");
          callback(Object.assign(new Error("Offline failure."), scenario.error) as ExecFileException, scenario.stdout, "discarded"); child.emit("close", 1); });
        return child;
      };
      const runner = new BawRunner(join(ROOT, "fixture.cjs"), spawn);
      assert.equal((await runner.run(["market-order", "swap"], SESSION)).kind, scenario.kind);
    }
  });

  it("keeps every ambiguous swap response held, including structured network and service errors", () => {
    const error = (code: number, name: string, orderId: string | null): BawResult => ({ kind: "cli-error", code, name, orderId, sessionPresent: true });
    assert.equal(bawSwapResponse(error(30003001, "ORDER_API_ERROR", "123")).response, "rejected");
    assert.equal(bawSwapResponse({ kind: "ok", data: { orderId: 123 }, sessionPresent: true, rwaTokens: null }).response, "accepted");
    for (const result of [error(30003001, "ORDER_API_ERROR", null), error(30003001, "SERVICE_ERROR", "123"),
      ...["NETWORK_ERROR", "REQUEST_TIMEOUT", "SERVICE_UNAVAILABLE", "UNAUTHORIZED", "UNKNOWN_ERROR"].map(name => error(1, name, null)),
      { kind: "no-response", code: "timeout", sessionPresent: true } as const,
      { kind: "no-response", code: "unparseable", sessionPresent: true } as const]) assert.equal(bawSwapResponse(result).response, "no-response");
    assert.equal(bawConnectionSignal(error(10003002, "SESSION_EXPIRED", null)), "U");
    assert.equal(bawConnectionSignal(error(10003001, "UNAUTHORIZED", null)), "unreachable");
    assert.equal(bawConnectionSignal({ kind: "ok", data: { status: "UNCONNECTED" }, sessionPresent: true, rwaTokens: null }), "U");
    assert.equal(bawConnectionSignal({ kind: "ok", data: { status: "UNCONNECTED" }, sessionPresent: false, rwaTokens: null }), "unreachable");
  });

  it("pins the command output contracts and refuses unreadable numeric settings", () => {
    const settings = { tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1_000, quotaUsed: 0,
      x402DailyLimit: 0.5, x402QuotaUsed: 0, inactiveSignOutTime: null, sessionExpireTime: null, signInMaxTime: null };
    for (const [command, data] of [
      ["wallet status", { status: "CONNECTED" }], ["wallet address", { addresses: [{ binanceChainId: "56", chainName: "BSC", address: "fixture" }] }],
      ["wallet balance", [{ symbol: "USDT", address: "fixture", binanceChainId: "56", balance: "1", price: "1", value: "1" }]],
      ["wallet settings", settings], ["market-order quote", { fromCoinSymbol: "USDT", fromCoinAmount: "1", toCoinSymbol: "STOCK", toCoinAmount: "1", slippage: 0.01 }],
      ["market-order swap", { orderId: "123" }], ["market-order list", { total: 0, page: 1, pageSize: 100, list: [] }],
      ["limit-order list", { total: 0, page: 1, pageSize: 100, list: [] }],
      ["auth signin", { qrCodeId: "fixture", expireAt: "1900000000000", urlForWeb: "fixture", pairingCode: "abcdef" }],
      ["auth verify", { status: "SUCCESS" }], ["auth signout", { status: "LOGGED_OUT" }],
      ["x402-payment preview", { paymentId: "fixture", options: [] }],
      ["x402-payment sign", { paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: "offline", signatureExpiresAt: 1_900_000_000 }],
    ] as const) { assert.equal(bawOutputValid(command, data), true, command); assert.equal(bawOutputValid(command, {}), false, command); }
    assert.equal(bawOutputValid("wallet settings", { ...settings, dailyLimit: 1e13 }), false);
    assert.equal(bawOutputValid("wallet settings", { ...settings, dailyLimit: "1000" }), false);
    // The settings object measured live after the first x402 sign (2026-10-03): long float quotas, ISO dates, extra fields ignored.
    assert.equal(bawOutputValid("wallet settings", { tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 50000, quotaUsed: 0, quotaLeft: 50000,
      x402DailyLimit: 20, x402QuotaUsed: 0.00999796218874478, x402QuotaLeft: 19.990002037811255, inactiveSignOutTime: "2026-10-05T20:00:00+00:00",
      sessionExpireTime: "2026-10-10T20:00:00+00:00", signInMaxTime: "2026-10-10T20:00:00+00:00", maxSigninDuration: "7d", inactiveSignoutDuration: "48h", devMode: {} }), true);
    assert.equal(bawOutputValid("market-order swap", { orderId: Number.MAX_SAFE_INTEGER + 1 }), false);
  });

  it("requires exact version and refuses both healthy and broken resolvable keytar", async context => {
    await mkdir(ROOT, { recursive: true });
    context.mock.method(os, "tmpdir", () => ROOT);
    syncBuiltinESMExports();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    const fixture = await mkdtemp(join(ROOT, "agentic-version-"));
    try {
      for (const version of ["1.10.0", "1.10.1", "1.10.0-beta", ""]) {
        const spawn: BawSpawn = (_file, _args, _options, callback) => {
          const child = new ChildProcess();
          queueMicrotask(() => { child.emit("spawn"); callback(null, version, ""); child.emit("close", 0); });
          return child;
        };
        const runner = new BawRunner(join(fixture, "cli.cjs"), spawn);
        if (version === "1.10.0") await runner.checkBoot();
        else await assert.rejects(runner.checkBoot(), /AGENTIC_CLI_VERSION/);
      }
      const keytar = join(fixture, "node_modules", "@github", "keytar");
      await mkdir(keytar, { recursive: true });
      await writeFile(join(keytar, "package.json"), '{"main":"index.cjs"}');
      for (const content of ['module.exports = {};', 'throw new Error("Native addon is broken.");']) {
        await writeFile(join(keytar, "index.cjs"), content);
        await assert.rejects(new BawRunner(join(fixture, "cli.cjs"), () => { throw new Error("Keytar must be checked before spawn."); }).checkBoot(), /AGENTIC_KEYTAR_RESOLVABLE/);
      }
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  it("real child guard refuses late and foreign-parent starts before loading the CLI", async context => {
    await mkdir(ROOT, { recursive: true });
    context.mock.method(os, "tmpdir", () => ROOT);
    syncBuiltinESMExports();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    const fixture = await mkdtemp(join(ROOT, "agentic-guard-"));
    try {
      const cli = join(fixture, "cli.cjs");
      await writeFile(cli, 'process.stdout.write("CLI-LOADED");');
      for (const foreignParent of [false, true]) {
        const runner = new BawRunner(cli);
        const command = await runner.prepare(["--version"], null);
        if (foreignParent) command.environment["FOURLPHA_PARENT_PID"] = String(process.pid + 100_000);
        else command.environment["FOURLPHA_START_DEADLINE_MS"] = String(Date.now() - 1);
        try { assert.equal((await command.start()).kind, "not-started"); } finally { await command.close(); }
      }
      await writeFile(cli, 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => k.startsWith("FOURLPHA_"))));');
      const normal = await new BawRunner(cli).prepare(["--version"], null);
      try { const result = await normal.start(); assert.equal(result.kind === "ok" ? result.data : result.kind, "[]"); }
      finally { await normal.close(); }
      await writeFile(cli, 'setInterval(() => {}, 1000);');
      const bounded = await new BawRunner(cli).prepare(["--version"], null);
      bounded.environment["FOURLPHA_BAW_LIMIT_MS"] = "60";
      try { assert.equal((await bounded.start()).kind, "no-response"); } finally { await bounded.close(); }
      await writeFile(cli, 'process.stdout.write("x".repeat(1048577)); setInterval(() => {}, 1000);');
      let stdoutLength = 0;
      const observing: BawSpawn = (file, args, options, callback) => execFile(file, [...args], options, (error, stdout, stderr) => {
        stdoutLength = stdout.length;
        callback(error, stdout, stderr);
      });
      const overflow = await new BawRunner(cli, observing).prepare(["--version"], null);
      try { assert.equal((await overflow.start()).kind, "no-response"); assert.ok(stdoutLength <= 1_048_576); }
      finally { await overflow.close(); }
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  it("injects parent probes to pin both ppid change and the Windows parent-liveness branch", async () => {
    const guard = await readFile(new URL("../src/agentic/childGuard.cjs", import.meta.url), "utf8");
    for (const platform of ["linux", "win32"]) {
      const intervals: Array<() => void> = [];
      const kills: Array<{ pid: number; signal: string | number | undefined }> = [];
      let alive = true;
      const processProbe = { pid: 2, ppid: 1, platform,
        env: { FOURLPHA_BAW_LIMIT_MS: "1000", FOURLPHA_PARENT_PID: "1", FOURLPHA_START_DEADLINE_MS: "10000" },
        stdout: { write: () => { throw new Error("Unexpected refusal."); } }, exit: () => { throw new Error("Unexpected exit."); },
        kill: (pid: number, signal?: string | number) => {
          if (signal === 0) { if (!alive) throw new Error("Offline parent is gone."); return; }
          kills.push({ pid, signal });
        } };
      const timer = { unref: () => undefined };
      runInNewContext(guard, { process: processProbe, Date: { now: () => 1_000 },
        setTimeout: () => timer, setInterval: (callback: () => void, ms: number) => { assert.equal(ms, 250); intervals.push(callback); return timer; } });
      assert.deepEqual(Object.keys(processProbe.env), []);
      if (platform === "linux") processProbe.ppid = 99;
      else alive = false;
      intervals[0]!();
      assert.deepEqual(kills, [{ pid: 2, signal: "SIGKILL" }]);
    }
  });
});

describe("Agentic runner rejected-output diagnostic", () => {
  async function run(context: import("node:test").TestContext, args: readonly string[], stdout: string): Promise<{ result: BawResult; lines: unknown[][] }> {
    await mkdir(ROOT, { recursive: true });
    context.mock.method(os, "tmpdir", () => ROOT);
    syncBuiltinESMExports();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    const lines: unknown[][] = [];
    context.mock.method(console, "error", (...line: unknown[]) => { lines.push(line); });
    const spawn: BawSpawn = (_file, _args, _options, callback) => {
      const child = new ChildProcess();
      queueMicrotask(() => { child.emit("spawn"); callback(null, stdout, ""); child.emit("close", 0); });
      return child;
    };
    const command = await new BawRunner(join(ROOT, "fixture.cjs"), spawn).prepare(args, SESSION);
    try { return { result: await command.start(), lines }; } finally { await command.close(); }
  }
  const sign = (extra: Record<string, unknown>) => JSON.stringify({ success: true, data: { paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: "secret-header", signatureExpiresAt: 1_900_000_000, ...extra } });

  it("accepts a sign reply with approveTxHash null, undefined or a string and nothing else", async context => {
    for (const extra of [{ approveTxHash: null }, {}, { approveTxHash: "0x" + "ab".repeat(32) }]) assert.equal((await run(context, ["x402-payment", "sign"], sign(extra))).result.kind, "ok");
    for (const approveTxHash of [5, {}, true]) assert.equal((await run(context, ["x402-payment", "sign"], sign({ approveTxHash }))).result.kind, "no-response");
  });

  it("prints types only for a rejected shape and the code and name for an unknown error", async context => {
    const settings = await run(context, ["wallet", "settings"], JSON.stringify({ success: true, data: { tradeAllTokens: "secret-string", abnormalTxnHandling: "AutoReject", dailyLimit: 1e13,
      quotaUsed: null, nested: { deep: { deeper: { deepest: "x" } }, list: [1] } } }));
    assert.equal(settings.result.kind, "no-response");
    assert.equal(settings.lines.length, 1); assert.equal(settings.lines[0]![0], "agentic_cli_output_rejected"); assert.equal(settings.lines[0]![1], "wallet settings");
    const shape = JSON.parse(String(settings.lines[0]![2])) as { success: boolean; topKeys: string[]; data: Record<string, unknown>; error: null };
    assert.equal(shape.success, true); assert.deepEqual(shape.topKeys, ["success", "data"]); assert.equal(shape.error, null);
    assert.deepEqual(shape.data, { tradeAllTokens: "string", abnormalTxnHandling: "string", dailyLimit: "number", quotaUsed: "null",
      nested: { deep: { deeper: "object" }, list: "array" } });
    assert.equal(String(settings.lines[0]![2]).includes("secret-string"), false); assert.equal(String(settings.lines[0]![2]).includes("AutoReject"), false);
    const unknown = await run(context, ["wallet", "settings"], JSON.stringify({ success: false, error: { code: 40001, name: "BRAND_NEW_ERROR", message: "private message", data: { orderId: "private-id" } } }));
    assert.equal(unknown.result.kind, "no-response");
    assert.deepEqual(JSON.parse(String(unknown.lines[0]![2])), { success: false, topKeys: ["success", "error"], data: "undefined", error: { code: 40001, name: "BRAND_NEW_ERROR" } });
    assert.equal(String(unknown.lines[0]![2]).includes("private"), false);
    const raw = await run(context, ["wallet", "settings"], "not json at all with a secret");
    assert.deepEqual(JSON.parse(String(raw.lines[0]![2])), { unparseable: true, length: 29 });
    const known = await run(context, ["wallet", "settings"], JSON.stringify({ success: false, error: { code: 10003002, name: "SESSION_EXPIRED" } }));
    assert.equal(known.result.kind, "cli-error"); assert.equal(known.lines.length, 0);
  });
});
