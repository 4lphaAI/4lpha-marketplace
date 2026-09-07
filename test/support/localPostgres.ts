import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

/** An owned, disposable loopback cluster. Never consumes DATABASE_URL or credentials. */
export async function localPostgres() {
  const bin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/17/bin" : "/usr/lib/postgresql/17/bin";
  const executable = (name: string) => join(bin, name + (process.platform === "win32" ? ".exe" : ""));
  if (!existsSync(executable("initdb"))) return null;
  const root = mkdtempSync(join(tmpdir(), "identity-minter-pg-")); const data = join(root, "data");
  const run = (name: string, args: string[]) => {
    const result = spawnSync(executable(name), args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  };
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local port");
  const port = address.port; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    run("initdb", ["-D", data, "-U", "identity_test", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
    // Direct child startup also works in Windows environments where pg_ctl's
    // restricted-token launcher cannot create another restricted token.
    const log = openSync(join(root, "postgres.log"), "a");
    try { child = spawn(executable("postgres"), ["-D", data, "-h", "127.0.0.1", "-p", String(port), "-c", "fsync=off"],
      { windowsHide: true, stdio: ["ignore", log, log] }); } finally { closeSync(log); }
    let startError: Error | undefined; child.on("error", (error) => { startError = error; });
    const url = `postgres://identity_test@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`Local postgres exited: ${child.exitCode}`);
      const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 500 });
      try { await probe.connect(); break; } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally { await probe.end(); }
    }
    return { url, async close() {
      run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]); rmSync(root, { recursive: true, force: true });
    } };
  } catch (error) {
    if (child && child.exitCode === null) {
      child.kill(); await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    }
    rmSync(root, { recursive: true, force: true }); throw error;
  }
}
