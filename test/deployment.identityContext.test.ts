import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { verifyRailwayDockerContext } from "../src/deployment/dockerContext.js";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = "scripts/erc8004-minter-migration.ts";
const run = promisify(execFile);

test("deployment context includes the separate recovery CLI and every services-image COPY source", async () => {
  const context = await verifyRailwayDockerContext(ROOT);
  assert.ok(context.includes(CLI));
  assert.ok(context.includes("scripts/erc8004-identity.ts"));
  for (const line of (await readFile(join(ROOT, "Dockerfile.services"), "utf8")).split(/\r?\n/).filter((line) => line.startsWith("COPY "))) {
    for (const source of line.split(/\s+/).slice(1, -1)) assert.ok(context.includes(source.replace(/\/$/, "")), source);
  }
  assert.equal(context.some((path) => /(^|\/)(?:\.env[^/]*|test|\.agents|\.git)(?:\/|$)/.test(path)), false);
});

test("packaged recovery entry imports using only the closed context, without running DB/RPC work", async () => {
  const parent = join(ROOT, "scripts", "tmp"); await mkdir(parent, { recursive: true });
  const staged = await mkdtemp(join(parent, "identity-context-"));
  try {
    const context = await verifyRailwayDockerContext(ROOT);
    for (const path of context) {
      const source = join(ROOT, path); const destination = join(staged, path);
      if ((await stat(source)).isDirectory()) await mkdir(destination, { recursive: true });
      else { await mkdir(dirname(destination), { recursive: true }); await copyFile(source, destination); }
    }
    // Dependencies resolve from this checkout's installed node_modules. Every
    // application-relative import must resolve from the copied context itself.
    const result = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import pg from 'pg'; pg.Pool = class { constructor() { throw new Error('Unexpected database access'); } };
       globalThis.fetch = () => { throw new Error('Unexpected network access'); };
       await import('./${CLI}'); process.stdout.write('packaged-entry-ok');`],
    { cwd: staged, windowsHide: true, timeout: 30_000, env: { SystemRoot: "C:\\Windows" } });
    assert.equal(result.stdout, "packaged-entry-ok"); assert.equal(result.stderr, "");
    for (const path of [".dockerignore", "Dockerfile"]) await copyFile(join(ROOT, path), join(staged, path));
    assert.ok((await verifyRailwayDockerContext(staged)).includes(CLI));
    const ignore = await readFile(join(staged, ".dockerignore"), "utf8");
    await writeFile(join(staged, ".dockerignore"), ignore.split(/\r?\n/).filter((line) => line !== `!${CLI}`).join("\n"));
    await assert.rejects(verifyRailwayDockerContext(staged), /closed allowlist/);
  } finally {
    assert.ok(resolve(staged).startsWith(resolve(parent) + (process.platform === "win32" ? "\\" : "/")));
    await rm(staged, { recursive: true, force: true });
  }
});
