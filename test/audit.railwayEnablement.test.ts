import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createBillingAwsCredentialProviderV2,
  type BillingAwsCredentialDependencies,
} from "../src/billing/awsBillingCredentials.js";
import {
  fenceWorkerDependency,
  type WorkerFence,
} from "../src/deployment/workerSingleton.js";

const ROOT = resolve(import.meta.dirname, "..");
const run = promisify(execFile);

function controllableFence(): Readonly<{ fence: WorkerFence; lose(): void }> {
  const controller = new AbortController();
  let fatal = false;
  return {
    fence: {
      signal: controller.signal,
      isFatal: () => fatal,
      assertOpen(): void {
        if (fatal) throw new Error("Worker singleton authority was lost.");
      },
    },
    lose(): void {
      fatal = true;
      controller.abort(new Error("Worker singleton authority was lost."));
    },
  };
}

test("audit Railway: a shallow dependency proxy cannot leave nested store mutations unfenced", () => {
  const authority = controllableFence();
  let writes = 0;
  const guarded = fenceWorkerDependency(authority.fence, {
    store: {
      write(): void { writes += 1; },
    },
  });
  authority.lose();
  assert.throws(() => guarded.store.write(), /authority was lost/u);
  assert.equal(writes, 0);
});

test("audit Railway: lock loss after method entry cannot cross a later money boundary", async () => {
  const authority = controllableFence();
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolvePause) => { release = resolvePause; });
  let submissions = 0;
  const guarded = fenceWorkerDependency(authority.fence, {
    async runThenSubmit(): Promise<void> {
      await paused;
      submissions += 1;
    },
  });
  const running = guarded.runThenSubmit();
  authority.lose();
  release?.();
  await assert.rejects(running, /authority was lost/u);
  assert.equal(submissions, 0);
});

test("audit Railway: service-specific AWS endpoint overrides refuse before provider construction", async () => {
  const aws = Object.freeze({
    region: "us-east-1",
    accountId: "123456789012",
    runtimeRoleArn: "arn:aws:iam::123456789012:role/4lpha-billing",
    credential: Object.freeze({ kind: "ecs-task-role-v1" as const }),
  });
  const dependencies: BillingAwsCredentialDependencies = {
    nowMs: Date.now,
    async readFile() { throw new Error("unreachable"); },
    async lstat() { throw new Error("unreachable"); },
    async fetchEcsCredential() { throw new Error("unreachable"); },
    async runHelper() { throw new Error("unreachable"); },
  };
  for (const name of [
    "AWS_ENDPOINT_URL_STS",
    "AWS_ENDPOINT_URL_KMS",
    "AWS_ENDPOINT_URL_SECRETS_MANAGER",
  ]) {
    await assert.rejects(createBillingAwsCredentialProviderV2({
      aws,
      environment: {
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1",
        [name]: "https://attacker.invalid",
      },
      dependencies,
    }), /BILLING_AWS_CREDENTIAL_INVALID/u, name);
  }
});

test("audit Railway: image evidence derives identity from an OCI layout and requires marker input", async () => {
  const source = await readFile(resolve(ROOT, "scripts/railway-inspect-image.ts"), "utf8");
  assert.match(source, /--oci-layout/u);
  assert.doesNotMatch(source, /--image-digest/u);
  assert.match(source, /forbiddenMarkers/u);
});

test("audit Railway: Docker context re-includes each ignored parent before descendants", async () => {
  const lines = (await readFile(resolve(ROOT, ".dockerignore"), "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line !== "");
  for (const parent of ["src", "scripts", "deploy"]) {
    assert.ok(lines.includes(`!${parent}`), `missing parent re-include: !${parent}`);
  }
});

test("audit Railway: no external module evaluates before the clean-exec self-check", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-audit-bundles-"));
  const output = join(temporary, "out");
  try {
    await run(process.execPath, [
      "--import",
      "tsx",
      resolve(ROOT, "scripts/railway-build-role-bundles.ts"),
      "--out",
      output,
    ], { cwd: ROOT, windowsHide: true });
    const bundle = await readFile(join(output, "billing-worker.mjs"), "utf8");
    const firstExternalImport = bundle.search(/^import\s/mu);
    const cleanExec = bundle.indexOf('await assertRailwayCleanExec("billing-worker-once")');
    assert.notEqual(cleanExec, -1);
    assert.ok(firstExternalImport === -1 || cleanExec < firstExternalImport,
      "an external module evaluates before the clean-exec assertion");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
