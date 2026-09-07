export const RAILWAY_RAW_BILLING_VARIABLES = Object.freeze([
  "BILLING_PRODUCTION_MANIFEST_BASE64",
  "BILLING_AWS_RA_CERTIFICATE_PEM",
  "BILLING_AWS_RA_PRIVATE_KEY_PEM",
] as const);

export const RAILWAY_PATH_BILLING_VARIABLES = Object.freeze([
  "BILLING_PRODUCTION_MANIFEST_PATH",
  "BILLING_PRODUCTION_BUNDLE_PATH",
  "BILLING_AWS_RA_CERTIFICATE_PATH",
  "BILLING_AWS_RA_PRIVATE_KEY_PATH",
  "BILLING_RAILWAY_CLEAN_EXEC",
] as const);

export type RailwayRole = "api" | "lp-worker" | "venus-worker" | "billing-worker-once";

const PROC_ENVIRON_MAX_BYTES = 1_048_576;
const FIXED_PATHS = Object.freeze({
  BILLING_PRODUCTION_MANIFEST_PATH: "/run/4lpha/manifest.json",
  BILLING_PRODUCTION_BUNDLE_PATH: "/app/artifacts/billing-adapter.mjs",
  BILLING_AWS_RA_CERTIFICATE_PATH: "/run/4lpha/roles-anywhere/certificate.pem",
  BILLING_AWS_RA_PRIVATE_KEY_PATH: "/run/4lpha/roles-anywhere/private-key.pem",
  BILLING_RAILWAY_CLEAN_EXEC: "1",
});

function billingMode(env: NodeJS.ProcessEnv): "off" | "report" | "on" {
  const value = env["BILLING_ENABLED"]?.trim() ?? "";
  if (value === "" || value === "off") return "off";
  if (value === "report" || value === "on") return value;
  throw new Error("Railway billing mode is invalid.");
}

function assertApplicationEnvironment(role: RailwayRole, env: NodeJS.ProcessEnv): void {
  for (const name of RAILWAY_RAW_BILLING_VARIABLES) {
    if (env[name] !== undefined) throw new Error("Railway clean-exec invariant failed.");
  }
  const mode = billingMode(env);
  const billingOnRole = mode === "on" && (role === "api" || role === "billing-worker-once");
  if (role === "billing-worker-once" && !billingOnRole) {
    throw new Error("Railway billing worker requires billing ON.");
  }
  if ((role === "lp-worker" || role === "venus-worker") && mode === "on") {
    throw new Error("Railway non-billing worker refuses billing ON.");
  }
  for (const name of RAILWAY_PATH_BILLING_VARIABLES) {
    const expected = FIXED_PATHS[name];
    if (billingOnRole ? env[name] !== expected : env[name] !== undefined) {
      throw new Error("Railway clean-exec invariant failed.");
    }
  }
}

async function readProcEnviron(): Promise<Buffer> {
  const { open } = await import("node:fs/promises");
  const handle = await open("/proc/self/environ", "r");
  try {
    const buffer = Buffer.alloc(PROC_ENVIRON_MAX_BYTES + 1);
    const result = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (result.bytesRead > PROC_ENVIRON_MAX_BYTES) {
      throw new Error("Railway process environment exceeds its inspection bound.");
    }
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export function assertRawBillingMarkersAbsent(
  environ: Uint8Array,
  forbiddenValues: readonly string[] = [],
): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(environ);
  const entries = text === "" ? [] : text.split("\0").filter((entry) => entry !== "");
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const name = separator < 0 ? entry : entry.slice(0, separator);
    if (RAILWAY_RAW_BILLING_VARIABLES.includes(name as typeof RAILWAY_RAW_BILLING_VARIABLES[number])) {
      throw new Error("Railway clean-exec invariant failed.");
    }
    if (forbiddenValues.some((marker) => marker !== "" && entry.includes(marker))) {
      throw new Error("Railway clean-exec marker erasure failed.");
    }
  }
}

/** Must complete before a role bundle imports any money-capable module. */
export async function assertRailwayCleanExec(role: RailwayRole): Promise<void> {
  assertApplicationEnvironment(role, process.env);
  if (process.platform !== "linux") {
    throw new Error("Railway role bundles require Linux /proc environment verification.");
  }
  assertRawBillingMarkersAbsent(await readProcEnviron());
}
