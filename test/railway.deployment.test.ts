import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertRawBillingMarkersAbsent,
  RAILWAY_PATH_BILLING_VARIABLES,
  RAILWAY_RAW_BILLING_VARIABLES,
} from "../src/railway/cleanExec.js";
import { RAILWAY_BUNDLE_ROLES } from "../src/railway/roles.js";
import {
  decideRailwayLaunch,
  type RailwayBillingMode,
  type RailwayCredentialVariant,
} from "../src/railway/launchPolicy.js";
import {
  assertRailwayAppNamespace,
  canonicalRailwayAppInventory,
  createRailwayAppInventory,
  verifyRailwayAppInventory,
} from "../src/deployment/imageInventory.js";
import { validateRailwayDeploymentEvidence } from "../src/deployment/railwayEvidence.js";
import { verifyRailwayDockerContext } from "../src/deployment/dockerContext.js";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");

test("Railway role vectors and clean-exec raw marker refusal are closed", () => {
  assert.deepEqual(RAILWAY_BUNDLE_ROLES.map(({ role, argv }) => ({ role, argv })), [
    { role: "api", argv: ["/usr/local/bin/node", "/app/dist/railway/api.mjs"] },
    { role: "lp-worker", argv: ["/usr/local/bin/node", "/app/dist/railway/lp-worker.mjs"] },
    { role: "venus-worker", argv: ["/usr/local/bin/node", "/app/dist/railway/venus-worker.mjs"] },
    { role: "billing-worker-once", argv: ["/usr/local/bin/node", "/app/dist/railway/billing-worker.mjs", "--once"] },
  ]);
  assertRawBillingMarkersAbsent(Buffer.from("PATH=/usr/bin\0BILLING_ENABLED=off\0"));
  for (const name of RAILWAY_RAW_BILLING_VARIABLES) {
    assert.throws(() => assertRawBillingMarkersAbsent(Buffer.from(`${name}=marker\0`)), /clean-exec/);
  }
  assert.throws(
    () => assertRawBillingMarkersAbsent(Buffer.from("PATH=/usr/bin\0TOKEN=unique-marker\0"), ["unique-marker"]),
    /marker erasure/,
  );
  assert.equal(RAILWAY_PATH_BILLING_VARIABLES.length, 5);
});

test("R3.5 Railway routing matrix is exhaustive and every refusal is pre-write", () => {
  const modes: readonly RailwayBillingMode[] = ["absent", "off", "report", "on"];
  const credentials: readonly RailwayCredentialVariant[] = ["none", "roles-anywhere-x509-v1", "ecs-task-role-v1"];
  for (const { role } of RAILWAY_BUNDLE_ROLES) {
    for (const mode of modes) {
      for (const credential of credentials) {
        const decision = decideRailwayLaunch({
          role,
          mode,
          credential,
          rawVariableCount: credential === "none" ? 0 : 3,
        });
        const disabled = mode !== "on";
        const shouldStart = disabled && credential === "none" && role !== "billing-worker-once";
        const shouldMaterialize = mode === "on" && credential === "roles-anywhere-x509-v1" &&
          (role === "api" || role === "billing-worker-once");
        assert.equal(decision.action, shouldStart ? "start" : shouldMaterialize ? "materialize" : "refuse");
        if (decision.action === "refuse") {
          assert.equal(decision.filesystemWrites, false);
          assert.equal(decision.helperCalls, false);
        }
      }
    }
  }
  assert.equal(decideRailwayLaunch({ role: "api", mode: "on", credential: "roles-anywhere-x509-v1", rawVariableCount: 2 }).action, "refuse");
  assert.equal(decideRailwayLaunch({ role: "api", mode: "on", credential: "roles-anywhere-x509-v1", rawVariableCount: 3, pathVariablePresent: true }).action, "refuse");
});

test("Railway role builder emits four deterministic no-source-map bundles", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-role-bundles-"));
  const first = join(temporary, "first");
  const second = join(temporary, "second");
  const script = resolve(ROOT, "scripts/railway-build-role-bundles.ts");
  try {
    await run(process.execPath, ["--import", "tsx", script, "--out", first], { cwd: ROOT, windowsHide: true });
    await run(process.execPath, ["--import", "tsx", script, "--out", second], { cwd: ROOT, windowsHide: true });
    for (const role of RAILWAY_BUNDLE_ROLES) {
      for (const name of [role.output, role.payload]) {
        const left = await readFile(join(first, name));
        const right = await readFile(join(second, name));
        assert.deepEqual(left, right);
        assert.equal(left.includes(Buffer.from("sourceMappingURL")), false);
      }
      const bootstrap = await readFile(join(first, role.output));
      assert.equal(bootstrap.includes(Buffer.from("Railway clean-exec invariant failed.")), true);
      assert.equal(bootstrap.includes(Buffer.from(role.sourceEntry)), false);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("refused clean-exec bootstrap never evaluates an adversarial payload", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-bootstrap-side-effect-"));
  const output = join(temporary, "out");
  const marker = join(temporary, "payload-evaluated");
  try {
    await run(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts/railway-build-role-bundles.ts"), "--out", output], {
      cwd: ROOT,
      windowsHide: true,
    });
    await writeFile(join(output, "billing-worker.payload.mjs"),
      `await import("node:fs/promises").then(({writeFile})=>writeFile(${JSON.stringify(marker)},"bad"));\n`);
    await assert.rejects(run(process.execPath, [join(output, "billing-worker.mjs")], {
      cwd: ROOT,
      env: { ...process.env, BILLING_ENABLED: "off" },
      windowsHide: true,
    }));
    assert.equal(await access(marker).then(() => true, () => false), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function imageFixture(root: string): Promise<Readonly<{ appRoot: string; lockPath: string }>> {
  const appRoot = join(root, "app");
  const lockPath = join(root, "package-lock.json");
  const paths = [
    "dist/railway/api.mjs",
    "dist/railway/api.payload.mjs",
    "dist/railway/lp-worker.mjs",
    "dist/railway/lp-worker.payload.mjs",
    "dist/railway/venus-worker.mjs",
    "dist/railway/venus-worker.payload.mjs",
    "dist/railway/billing-worker.mjs",
    "dist/railway/billing-worker.payload.mjs",
    "artifacts/billing-adapter.mjs",
  ];
  await mkdir(join(appRoot, "dist", "railway"), { recursive: true });
  await mkdir(join(appRoot, "artifacts"), { recursive: true });
  await mkdir(join(appRoot, "node_modules", "dep"), { recursive: true });
  await writeFile(join(appRoot, "package.json"), "{\"name\":\"fixture\"}\n");
  for (const path of paths) await writeFile(join(appRoot, path), `${path}\n`);
  await writeFile(join(appRoot, "node_modules", "dep", "package.json"), "{\"name\":\"dep\",\"version\":\"1.0.0\"}\n");
  await writeFile(join(appRoot, "node_modules", "dep", "README.md"), "preserved license-era package documentation\n");
  await writeFile(lockPath, JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/dep": { version: "1.0.0", integrity: "sha512-fixture" },
    },
  }));
  for (const path of ["package.json", ...paths, "node_modules/dep/package.json", "node_modules/dep/README.md"]) {
    await chmod(join(appRoot, path), 0o644);
  }
  return { appRoot, lockPath };
}

test("Railway application inventory separates package-owned docs from exact project paths", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-app-inventory-"));
  try {
    const fixture = await imageFixture(temporary);
    const inventory = await createRailwayAppInventory(fixture);
    assert.equal(inventory.packages.length, 1);
    assert.ok(inventory.dependencyFiles.some(({ path }) => path === "dep/README.md"));
    const bytes = Buffer.from(canonicalRailwayAppInventory(inventory));
    await writeFile(join(fixture.appRoot, "artifacts", "app-inventory.json"), bytes);
    await verifyRailwayAppInventory({ ...fixture, inventoryBytes: bytes });
    await rm(join(fixture.appRoot, "artifacts", "app-inventory.json"));
    await run(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts/railway-build-app-inventory.ts"),
      "--app-root", fixture.appRoot, "--lock", fixture.lockPath,
      "--out", join(fixture.appRoot, "artifacts", "app-inventory.json")], { cwd: ROOT, windowsHide: true });
    assert.deepEqual(await readFile(join(fixture.appRoot, "artifacts", "app-inventory.json")), bytes);
    await writeFile(join(fixture.appRoot, "README.md"), "project doc must not ship\n");
    await assert.rejects(assertRailwayAppNamespace(fixture.appRoot), /closed Railway allowlist/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Railway dependency namespace rejects symlinked node_modules and arbitrary .bin files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-dependency-namespace-"));
  try {
    const first = await imageFixture(join(temporary, "first"));
    await mkdir(join(first.appRoot, "node_modules", ".bin"));
    await writeFile(join(first.appRoot, "node_modules", ".bin", "attacker"), "not an npm link\n");
    await assert.rejects(createRailwayAppInventory(first), /only npm \.bin symlinks/u);

    const second = await imageFixture(join(temporary, "second"));
    const realModules = join(temporary, "real-node-modules");
    await mkdir(realModules);
    await rm(join(second.appRoot, "node_modules"), { recursive: true, force: true });
    await symlink(realModules, join(second.appRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(createRailwayAppInventory(second), /must be a real directory/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function validDeploymentEvidence(): Readonly<Record<string, unknown>> {
  return {
    schema: "4lpha.railway-deployment-evidence.v1",
    capturedAt: "2026-08-28T12:00:00.000Z",
    imageDigest: `sha256:${"a".repeat(64)}`,
    services: [
      { name: "execution-api", role: "api", replicas: 1, restart: "always", healthcheck: "/health", overlapSeconds: 0, drainSeconds: 30, publicDomains: 0, privateNetwork: true, databasePrivateReference: true, run4lphaVolumeMounted: false, cron: "absent" },
      { name: "lp-worker", role: "lp-worker", replicas: 1, restart: "always", healthcheck: null, overlapSeconds: 0, drainSeconds: 30, publicDomains: 0, privateNetwork: true, databasePrivateReference: true, run4lphaVolumeMounted: false, cron: "absent" },
      { name: "venus-worker", role: "venus-worker", replicas: 1, restart: "always", healthcheck: null, overlapSeconds: 0, drainSeconds: 30, publicDomains: 0, privateNetwork: true, databasePrivateReference: true, run4lphaVolumeMounted: false, cron: "absent" },
      { name: "billing-worker", role: "billing-worker-once", replicas: 1, restart: "never", healthcheck: null, overlapSeconds: 0, drainSeconds: 30, publicDomains: 0, privateNetwork: true, databasePrivateReference: true, run4lphaVolumeMounted: false, cron: "paused" },
    ],
    continuousMonitor: { configured: true, target: "external-private-probe" },
    billingPreflightEvidenceSha256: null,
  };
}

test("Railway evidence keeps health, public exposure, overlap and billing cron fail closed", () => {
  assert.equal(validateRailwayDeploymentEvidence(validDeploymentEvidence()).services.length, 4);
  for (const mutate of [
    (value: Record<string, unknown>) => ((value["services"] as Array<Record<string, unknown>>)[0]!["publicDomains"] = 1),
    (value: Record<string, unknown>) => ((value["services"] as Array<Record<string, unknown>>)[3]!["cron"] = "active"),
    (value: Record<string, unknown>) => ((value["services"] as Array<Record<string, unknown>>)[1]!["overlapSeconds"] = 1),
    (value: Record<string, unknown>) => (value["continuousMonitor"] = { configured: false, target: "" }),
  ]) {
    const candidate = structuredClone(validDeploymentEvidence()) as Record<string, unknown>;
    mutate(candidate);
    assert.throws(() => validateRailwayDeploymentEvidence(candidate));
  }
});

test("Docker and C launcher pin the Railway security boundary", async () => {
  const [dockerfile, launcher, ignore] = await Promise.all([
    readFile(resolve(ROOT, "Dockerfile"), "utf8"),
    readFile(resolve(ROOT, "deploy/railway-launcher.c"), "utf8"),
    readFile(resolve(ROOT, ".dockerignore"), "utf8"),
  ]);
  assert.match(dockerfile, /USER 10001:10001/u);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/railway-launcher"\]/u);
  assert.equal((dockerfile.match(/sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96/gu) ?? []).length, 4);
  assert.match(launcher, /O_CREAT \| O_EXCL \| O_NOFOLLOW \| O_CLOEXEC/u);
  assert.match(launcher, /execve\(selected\[0\], selected, clean\)/u);
  assert.match(launcher, /strstr\(environ\[index\], raw_values\[name\]\)/u);
  assert.match(launcher, /json_aws\(&cursor\)/u);
  assert.doesNotMatch(launcher, /count_literal/u);
  assert.match(launcher, /"--once"/u);
  assert.match(ignore, /^\*\*$/mu);
  assert.doesNotMatch(ignore, /\.env/u);
  const context = await verifyRailwayDockerContext(ROOT);
  assert.ok(context.includes("src/index-server.ts"));
  assert.ok(context.includes("scripts/billing-worker.ts"));
  assert.equal(context.some((path) => path.startsWith("test/") || path.startsWith(".agents/")), false);
});

test("offline Railway build-context tar contains every COPY source and no forbidden tree", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-context-tar-test-"));
  const archive = join(temporary, "context.tar");
  try {
    const result = await run(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts/railway-build-context-tar.ts"), "--out", archive], {
      cwd: ROOT,
      windowsHide: true,
    });
    const evidence = JSON.parse(result.stdout) as Readonly<{ files: readonly string[] }>;
    assert.ok(evidence.files.includes("src/index-server.ts"));
    assert.ok(evidence.files.includes("deploy/railway-launcher.c"));
    assert.equal(evidence.files.some((path) => /(^|\/)(?:test|\.env|\.git|\.agents)(?:\/|$)/u.test(path)), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reviewed helper provenance is pinned byte-for-byte, not sampled", async () => {
  const bytes = await readFile(resolve(ROOT, "test/fixtures/billing/awsRolesAnywhereHelper184.provenance.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "96620b756cf6f6c28dacb7f5f8d3be3b2e00de021b80b9673d199ae53fe51d4e");
  const value = JSON.parse(bytes.toString("utf8")) as Readonly<Record<string, unknown>>;
  assert.equal(value["schema"], "4lpha.aws-roles-anywhere-helper-provenance.v1");
  const upstream = value["upstream"] as Readonly<Record<string, unknown>>;
  assert.deepEqual([upstream["tag"], upstream["commit"]], ["v1.8.4", "98b276b61378af7d233b077f0fe5d44e85253ece"]);
  const artifact = value["linuxAmd64Artifact"] as Readonly<Record<string, unknown>>;
  assert.deepEqual([artifact["bytes"], artifact["sha256"], artifact["magicHex"]],
    [12094568, "b7568acd6e1517a4e1adaee68d52bfd6284a0e5305677166cd83d43a07c815c9", "7f454c46"]);
  const sources = value["publishedSource"] as readonly Readonly<Record<string, unknown>>[];
  assert.equal(sources.length, 4);
  assert.ok(sources.every((source) => typeof source["path"] === "string" && typeof source["bytes"] === "number" && /^[0-9a-f]{64}$/u.test(String(source["sha256"]))));
  const processFixture = value["credentialProcess"] as Readonly<Record<string, unknown>>;
  assert.equal((processFixture["declaredFlagsInSourceOrder"] as readonly unknown[]).length, 21);
  assert.deepEqual(processFixture["memberOrder"], ["Version", "AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration"]);
  assert.equal(processFixture["terminalBytes"], "none");
  const stdout = processFixture["redactedStdout"] as Readonly<Record<string, unknown>>;
  const decoded = Buffer.from(String(stdout["base64"]), "base64");
  assert.equal(decoded.byteLength, 174);
  assert.equal(stdout["usableCredential"], false);
  assert.equal(decoded.includes(0x0a), false);
});
