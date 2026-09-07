import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const ROLES = ["api", "lp-worker", "venus-worker", "billing-worker-once"] as const;
const MODES = ["absent", "off", "report", "on"] as const;
const KINDS = ["none", "ra", "ecs"] as const;
const RAW_NAMES = [
  "BILLING_PRODUCTION_MANIFEST_BASE64",
  "BILLING_AWS_RA_CERTIFICATE_PEM",
  "BILLING_AWS_RA_PRIVATE_KEY_PEM",
] as const;
const FIXED_NAMES = [
  "BILLING_PRODUCTION_MANIFEST_PATH",
  "BILLING_PRODUCTION_BUNDLE_PATH",
  "BILLING_AWS_RA_CERTIFICATE_PATH",
  "BILLING_AWS_RA_PRIVATE_KEY_PATH",
  "BILLING_RAILWAY_CLEAN_EXEC",
] as const;

type Role = typeof ROLES[number];
type Mode = typeof MODES[number];
type Kind = typeof KINDS[number];

function pem(label: "CERTIFICATE" | "PRIVATE KEY", bytes: Buffer): string {
  const encoded = bytes.toString("base64");
  const lines = encoded.match(/.{1,64}/gu);
  if (lines === null) throw new Error("PEM fixture must be nonempty.");
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

const CERTIFICATE = pem("CERTIFICATE", Buffer.from("certificate"));
const PRIVATE_KEY = pem("PRIVATE KEY", Buffer.from("private-key"));

function manifest(kind: Exclude<Kind, "none">, collectorPadding = "", providerRa = false): string {
  const credential = kind === "ra"
    ? { kind: "roles-anywhere-x509-v1", trustAnchorArn: "a", profileArn: "b", certificateSha256: "c", certificateSubjectCn: "d", certificateIssuerCn: "e", helperVersion: "1.8.4", helperBytes: "12094568", helperSha256: "f" }
    : { kind: "ecs-task-role-v1" };
  return JSON.stringify({
    schema: "4lpha.billing-production-manifest.v2",
    buildCommit: "x",
    sourceSha256: "x",
    lockSha256: "x",
    bundleSha256: "x",
    aws: { region: "x", accountId: "x", runtimeRoleArn: "x", credential, ticketKeyId: "x", ticketKeyArn: "x", x402KeyArn: "x", ogInference: {}, ogManagement: {} },
    collector: collectorPadding === "" ? {} : { padding: collectorPadding },
    networks: {}, oracles: {}, caps: {}, postgres: {},
    providers: providerRa ? { credential: { kind: "roles-anywhere-x509-v1", trustAnchorArn: "x" } } : {},
  });
}

function manifestModulo(modulo: 0 | 1 | 2): string {
  for (let length = 0; length < 3; length++) {
    const value = manifest("ra", "x".repeat(length));
    if (Buffer.byteLength(value) % 3 === modulo) return value;
  }
  throw new Error("Unable to construct manifest modulo fixture.");
}

function environment(mode: Mode, kind: Kind): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  if (mode !== "absent") result["BILLING_ENABLED"] = mode;
  if (kind !== "none") {
    result[RAW_NAMES[0]] = Buffer.from(manifest(kind)).toString("base64");
    result[RAW_NAMES[1]] = CERTIFICATE;
    result[RAW_NAMES[2]] = PRIVATE_KEY;
  }
  return result;
}

function shouldStart(role: Role, mode: Mode, kind: Kind): boolean {
  if (kind === "ra") return mode === "on" && (role === "api" || role === "billing-worker-once");
  if (kind === "ecs" || mode === "on") return false;
  return role !== "billing-worker-once";
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("The real launcher harness requires Linux.");
  const temporary = await mkdtemp(join(tmpdir(), "4lpha-launcher-linux-"));
  const runRoot = join(temporary, "run");
  const launcher = join(temporary, "launcher");
  const child = join(temporary, "child");
  const duplicateEnv = join(temporary, "duplicate-env");
  const output = join(temporary, "child-output");
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("Linux UID/GID unavailable.");
  const define = (name: string, value: string | number): string =>
    typeof value === "number" ? `-D${name}=${value}` : `-D${name}=${JSON.stringify(value)}`;
  const compileLauncher = async (
    path: string,
    extra: readonly string[] = [],
    nodePath = child,
    appUid = uid,
    appGid = gid,
  ): Promise<void> => {
    await run("gcc", ["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror",
      define("RUN_ROOT", runRoot), define("NODE_PATH", nodePath), define("APP_UID", appUid), define("APP_GID", appGid),
      ...extra, "-o", path, resolve(ROOT, "deploy/railway-launcher.c")]);
    await chmod(path, 0o555);
  };
  try {
    await compileLauncher(launcher);
    await run("gcc", ["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", "-o", child,
      resolve(ROOT, "deploy/railway-launcher-harness-child.c")]);
    await run("gcc", ["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", "-o", duplicateEnv,
      resolve(ROOT, "deploy/railway-launcher-duplicate-env.c")]);
    await chmod(child, 0o555);
    await chmod(duplicateEnv, 0o555);

    const reset = async (): Promise<void> => {
      await rm(runRoot, { recursive: true, force: true });
      await mkdir(runRoot, { mode: 0o700 });
      await chmod(runRoot, 0o700);
      await rm(output, { force: true });
    };
    const executeWith = async (binary: string, role: Role, env: NodeJS.ProcessEnv): Promise<string> => {
      await run(binary, [role], { env: { HARNESS_OUTPUT: output, ...env }, windowsHide: true });
      return readFile(output, "utf8");
    };
    const execute = async (role: Role, env: NodeJS.ProcessEnv): Promise<string> =>
      executeWith(launcher, role, env);
    const refuse = async (role: Role, env: NodeJS.ProcessEnv, emptyRoot = true): Promise<void> => {
      await assert.rejects(execute(role, env));
      assert.deepEqual(await readFile(output).catch(() => undefined), undefined);
      if (emptyRoot) assert.deepEqual(await readdir(runRoot), []);
    };

    // Complete Railway role x mode x credential-kind routing matrix.
    for (const role of ROLES) {
      for (const mode of MODES) {
        for (const kind of KINDS) {
          await reset();
          const env = environment(mode, kind);
          if (shouldStart(role, mode, kind)) {
            const result = await execute(role, env);
            assert.match(result, kind === "ra" ? /clean=1/u : /clean=absent/u);
            if (role === "billing-worker-once") assert.match(result, /argv2=--once/u);
          } else {
            await refuse(role, env);
          }
        }
      }
    }

    // Every one-of-three and two-of-three raw-variable subset refuses for every
    // role; the complete matrix above covers zero and exactly three.
    const completeRaw = environment("on", "ra");
    for (const role of ROLES) {
      for (let mask = 1; mask < 7; mask++) {
        const partial: NodeJS.ProcessEnv = {
          BILLING_ENABLED: role === "lp-worker" || role === "venus-worker" ? "off" : "on",
        };
        for (let index = 0; index < RAW_NAMES.length; index++) {
          const name = RAW_NAMES[index]!;
          if ((mask & (1 << index)) !== 0) partial[name] = completeRaw[name];
        }
        await reset();
        await refuse(role, partial);
      }
    }

    // A single caller-supplied fixed/path/clean-exec variable always refuses.
    for (const name of FIXED_NAMES) {
      await reset();
      await refuse("api", { BILLING_ENABLED: "off", [name]: "caller-value" });
    }

    // Canonical manifest base64 accepts all three decoded-length modulo classes.
    for (const modulo of [0, 1, 2] as const) {
      await reset();
      const text = manifestModulo(modulo);
      assert.equal(Buffer.byteLength(text) % 3, modulo);
      await execute("api", {
        BILLING_ENABLED: "on",
        BILLING_PRODUCTION_MANIFEST_BASE64: Buffer.from(text).toString("base64"),
        BILLING_AWS_RA_CERTIFICATE_PEM: CERTIFICATE,
        BILLING_AWS_RA_PRIVATE_KEY_PEM: PRIVATE_KEY,
      });
    }

    const goodManifest = manifest("ra");
    const jsonMutants = [
      "",
      "{",
      `${goodManifest}\n`,
      goodManifest.replace("4lpha.billing-production-manifest.v2", "4lpha.billing-production-manifest.v1"),
      goodManifest.replace('"aws":', '"aws":{},"aws":'),
      goodManifest.replace('"credential":', '"credential":{},"credential":'),
      goodManifest.replace('"region":"x",', ""),
      manifest("ecs", "", true),
    ];
    for (const mutant of jsonMutants) {
      await reset();
      await refuse("api", {
        BILLING_ENABLED: "on",
        BILLING_PRODUCTION_MANIFEST_BASE64: Buffer.from(mutant).toString("base64"),
        BILLING_AWS_RA_CERTIFICATE_PEM: CERTIFICATE,
        BILLING_AWS_RA_PRIVATE_KEY_PEM: PRIVATE_KEY,
      });
    }
    for (const encoded of ["A===", "AA=A", "AB==", "AAF="]) {
      await reset();
      await refuse("api", {
        BILLING_ENABLED: "on",
        BILLING_PRODUCTION_MANIFEST_BASE64: encoded,
        BILLING_AWS_RA_CERTIFICATE_PEM: CERTIFICATE,
        BILLING_AWS_RA_PRIVATE_KEY_PEM: PRIVATE_KEY,
      });
    }

    // Canonical single-object PEM accepts padding modulo 0/1/2 and rejects
    // malformed bodies before either secret path can be created.
    for (const byteLength of [48, 49, 50]) {
      await reset();
      await execute("api", {
        BILLING_ENABLED: "on",
        BILLING_PRODUCTION_MANIFEST_BASE64: Buffer.from(goodManifest).toString("base64"),
        BILLING_AWS_RA_CERTIFICATE_PEM: pem("CERTIFICATE", Buffer.alloc(byteLength, 0x41)),
        BILLING_AWS_RA_PRIVATE_KEY_PEM: pem("PRIVATE KEY", Buffer.alloc(byteLength, 0x42)),
      });
    }
    const badBodies = [
      "",
      "Q?==",
      "QR==",
      "QUJ=",
      "Q=Q=",
      "QQ===",
      "A".repeat(68),
      `${"A".repeat(63)}=\nAAAA`,
    ];
    for (const name of [RAW_NAMES[1], RAW_NAMES[2]] as const) {
      const label = name === RAW_NAMES[1] ? "CERTIFICATE" : "PRIVATE KEY";
      for (const body of badBodies) {
        await reset();
        await refuse("api", {
          ...environment("on", "ra"),
          [name]: `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`,
        });
      }
      for (const malformed of [
        `-----BEGIN ${label}-----\r\nQQ==\r\n-----END ${label}-----\r\n`,
        `-----BEGIN ${label}-----\nQQ==-----END ${label}-----\n`,
        `-----BEGIN ${label}-----\nQQ==\n-----END ${label}-----\n-----BEGIN ${label}-----\nQQ==\n-----END ${label}-----\n`,
      ]) {
        await reset();
        await refuse("api", { ...environment("on", "ra"), [name]: malformed });
      }
    }

    // Every raw/fixed/mode duplicate is refused before materialization.
    for (const name of ["BILLING_ENABLED", ...RAW_NAMES, ...FIXED_NAMES]) {
      await reset();
      await assert.rejects(run(duplicateEnv, [launcher, "api", name, "x"], {
        env: { HARNESS_OUTPUT: output }, windowsHide: true,
      }));
      assert.deepEqual(await readdir(runRoot), []);
      assert.deepEqual(await readFile(output).catch(() => undefined), undefined);
    }

    // Root mode, symlink/no-follow and pre-existing-object boundaries.
    await reset();
    await chmod(runRoot, 0o755);
    await assert.rejects(execute("api", environment("on", "ra")));
    assert.deepEqual(await readdir(runRoot), []);

    await rm(runRoot, { recursive: true, force: true });
    const symlinkTarget = join(temporary, "run-target");
    await mkdir(symlinkTarget, { mode: 0o700 });
    await symlink(symlinkTarget, runRoot, "dir");
    await assert.rejects(execute("api", environment("on", "ra")));
    assert.deepEqual(await readdir(symlinkTarget), []);

    await reset();
    const manifestTarget = join(temporary, "manifest-target");
    await writeFile(manifestTarget, "untouched");
    await symlink(manifestTarget, join(runRoot, "manifest.json"), "file");
    await assert.rejects(execute("api", environment("on", "ra")));
    assert.equal(await readFile(manifestTarget, "utf8"), "untouched");
    assert.equal((await lstat(join(runRoot, "manifest.json"))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(runRoot), ["manifest.json"]);

    await reset();
    await mkdir(join(runRoot, "roles-anywhere"), { mode: 0o700 });
    await assert.rejects(execute("api", environment("on", "ra")));
    assert.deepEqual(await readdir(join(runRoot, "roles-anywhere")), []);

    // Force the second and third writes to fail and prove every earlier file and
    // launcher-owned directory is removed while the pre-existing blocker stays.
    for (const [macro, blocker] of [
      ["CERTIFICATE_PATH", "blocked-certificate"],
      ["PRIVATE_KEY_PATH", "blocked-private-key"],
    ] as const) {
      await reset();
      const blockedPath = join(runRoot, blocker);
      await writeFile(blockedPath, "untouched");
      const variant = join(temporary, `launcher-${blocker}`);
      await compileLauncher(variant, [define(macro, blockedPath)]);
      await assert.rejects(executeWith(variant, "api", environment("on", "ra")));
      assert.equal(await readFile(blockedPath, "utf8"), "untouched");
      assert.deepEqual(await readdir(runRoot), [blocker]);
    }

    // The production identity check is executable: either an unexpected UID or
    // GID refuses before the run root is inspected or written.
    const wrongUidLauncher = join(temporary, "launcher-wrong-uid");
    await compileLauncher(wrongUidLauncher, [], child, uid === 0 ? 1 : uid + 1, gid);
    await reset();
    await assert.rejects(executeWith(wrongUidLauncher, "api", { BILLING_ENABLED: "off" }));
    assert.deepEqual(await readdir(runRoot), []);
    const wrongGidLauncher = join(temporary, "launcher-wrong-gid");
    await compileLauncher(wrongGidLauncher, [], child, uid, gid === 0 ? 1 : gid + 1);
    await reset();
    await assert.rejects(executeWith(wrongGidLauncher, "api", { BILLING_ENABLED: "off" }));
    assert.deepEqual(await readdir(runRoot), []);

    // Execute a real Node child and inspect the kernel's /proc environment, not
    // only libc's environ view in the compiled C child.
    await reset();
    const marker = Buffer.from(goodManifest).toString("base64");
    const nodeChild = join(temporary, "proc-child.mjs");
    await writeFile(nodeChild, [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const bytes = await readFile("/proc/self/environ");',
      'const text = bytes.toString("utf8");',
      `if (text.includes(${JSON.stringify(marker)}) ||`,
      `    ${JSON.stringify(RAW_NAMES)}.some((name) => text.includes(name + "="))) process.exit(98);`,
      'if (!text.includes("BILLING_RAILWAY_CLEAN_EXEC=1\\0")) process.exit(99);',
      'await writeFile(process.env.HARNESS_OUTPUT, "proc=clean");',
    ].join("\n"));
    const nodeLauncher = join(temporary, "launcher-node");
    await compileLauncher(nodeLauncher, [
      define("API_PATH", nodeChild),
      define("LP_PATH", nodeChild),
      define("VENUS_PATH", nodeChild),
      define("BILLING_PATH", nodeChild),
    ], process.execPath);
    assert.equal(await executeWith(nodeLauncher, "api", {
      ...environment("on", "ra"),
      DUPLICATE_RAW_VALUE: marker,
    }), "proc=clean");

    process.stdout.write("railway launcher Linux harness: PASS\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Railway launcher Linux harness failed.");
  process.exitCode = 1;
});
