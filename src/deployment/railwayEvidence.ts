import { readFile } from "node:fs/promises";

export type RailwayServiceEvidence = Readonly<{
  name: string;
  role: "api" | "lp-worker" | "venus-worker" | "billing-worker-once";
  replicas: number;
  restart: "always" | "never";
  healthcheck: "/health" | null;
  overlapSeconds: number;
  drainSeconds: number;
  publicDomains: number;
  privateNetwork: boolean;
  databasePrivateReference: true;
  run4lphaVolumeMounted: false;
  cron: "absent" | "paused";
}>;

export type RailwayDeploymentEvidence = Readonly<{
  schema: "4lpha.railway-deployment-evidence.v1";
  capturedAt: string;
  imageDigest: string;
  services: readonly RailwayServiceEvidence[];
  continuousMonitor: Readonly<{ configured: boolean; target: string }>;
  billingPreflightEvidenceSha256: string | null;
}>;

const EXPECTED = Object.freeze([
  Object.freeze({ name: "execution-api", role: "api", restart: "always", healthcheck: "/health", cron: "absent" }),
  Object.freeze({ name: "lp-worker", role: "lp-worker", restart: "always", healthcheck: null, cron: "absent" }),
  Object.freeze({ name: "venus-worker", role: "venus-worker", restart: "always", healthcheck: null, cron: "absent" }),
  Object.freeze({ name: "billing-worker", role: "billing-worker-once", restart: "never", healthcheck: null, cron: "paused" }),
] as const);

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Railway deployment evidence is malformed.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key, index) => actual[index] !== key)) {
    throw new Error("Railway deployment evidence member order or census refused.");
  }
}

export function validateRailwayDeploymentEvidence(value: unknown): RailwayDeploymentEvidence {
  const root = record(value);
  assertKeys(root, [
    "schema",
    "capturedAt",
    "imageDigest",
    "services",
    "continuousMonitor",
    "billingPreflightEvidenceSha256",
  ]);
  if (root["schema"] !== "4lpha.railway-deployment-evidence.v1" ||
      typeof root["capturedAt"] !== "string" || Number.isNaN(Date.parse(root["capturedAt"])) ||
      new Date(root["capturedAt"]).toISOString() !== root["capturedAt"] ||
      typeof root["imageDigest"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(root["imageDigest"]) ||
      !Array.isArray(root["services"]) || root["services"].length !== EXPECTED.length) {
    throw new Error("Railway deployment evidence identity refused.");
  }
  const services = root["services"].map((candidate, index): RailwayServiceEvidence => {
    const service = record(candidate);
    assertKeys(service, [
      "name",
      "role",
      "replicas",
      "restart",
      "healthcheck",
      "overlapSeconds",
      "drainSeconds",
      "publicDomains",
      "privateNetwork",
      "databasePrivateReference",
      "run4lphaVolumeMounted",
      "cron",
    ]);
    const expected = EXPECTED[index];
    if (expected === undefined || service["name"] !== expected.name || service["role"] !== expected.role ||
        service["replicas"] !== 1 || service["restart"] !== expected.restart ||
        service["healthcheck"] !== expected.healthcheck || service["overlapSeconds"] !== 0 ||
        service["drainSeconds"] !== 30 || service["publicDomains"] !== 0 ||
        service["privateNetwork"] !== true || service["databasePrivateReference"] !== true ||
        service["run4lphaVolumeMounted"] !== false ||
        service["cron"] !== expected.cron) {
      throw new Error("Railway service settings evidence refused.");
    }
    return service as RailwayServiceEvidence;
  });
  const monitor = record(root["continuousMonitor"]);
  assertKeys(monitor, ["configured", "target"]);
  if (monitor["configured"] !== true || typeof monitor["target"] !== "string" || monitor["target"] === "") {
    throw new Error("External continuous liveness monitor evidence is required.");
  }
  const preflight = root["billingPreflightEvidenceSha256"];
  if (preflight !== null && (typeof preflight !== "string" || !/^[0-9a-f]{64}$/u.test(preflight))) {
    throw new Error("Billing preflight evidence digest is malformed.");
  }
  return Object.freeze({
    schema: "4lpha.railway-deployment-evidence.v1",
    capturedAt: root["capturedAt"],
    imageDigest: root["imageDigest"],
    services: Object.freeze(services),
    continuousMonitor: Object.freeze({ configured: true, target: monitor["target"] }),
    billingPreflightEvidenceSha256: preflight,
  }) as RailwayDeploymentEvidence;
}

export async function readRailwayDeploymentEvidence(path: string): Promise<RailwayDeploymentEvidence> {
  return validateRailwayDeploymentEvidence(JSON.parse(await readFile(path, "utf8")) as unknown);
}
